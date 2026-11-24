"""Allowlisted git tools must keep using the repository the check authorized.

The caller path is a symlink inside the configured repository. While the
allowlist check runs, that symlink points at the configured repository. The
symlink is retargeted only when git.Repo is asked to open the original caller
path, after every lookup that happens before that open. Retargeting earlier
would let a second lookup of the same path hide the bug.

Each tool must neither read nor modify the repository outside the allowlist,
and must not run that repository's hooks. Creating or deleting a file there
counts as a modification.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Iterator

import git
import pytest
from mcp.types import CallToolRequest, CallToolRequestParams

import mcp_server_git.server as server_mod

OUTSIDE_BLOB = "OUTSIDE_ONLY_BLOB"
OUTSIDE_STAGED = "OUTSIDE_ONLY_STAGED"
OUTSIDE_COMMIT = "outside-only-commit"
OUTSIDE_BRANCH = "outside-only-branch"
OUTSIDE_FILE = "outside-only.txt"
OUTSIDE_STAGED_FILE = "outside-staged.txt"
MARKERS = (
    OUTSIDE_BLOB,
    OUTSIDE_STAGED,
    OUTSIDE_COMMIT,
    OUTSIDE_BRANCH,
    OUTSIDE_FILE,
    OUTSIDE_STAGED_FILE,
)

# Every tool enters through call_tool, which checks repo_path and then opens
# that same string. The arguments are the tool inputs other than repo_path.
TOOLS: tuple[tuple[str, dict[str, object]], ...] = (
    ("git_status", {}),
    ("git_diff_unstaged", {}),
    ("git_diff_staged", {}),
    ("git_diff", {"target": "HEAD"}),
    ("git_commit", {"message": "confinement check"}),
    ("git_add", {"files": [OUTSIDE_FILE]}),
    ("git_reset", {}),
    ("git_log", {}),
    ("git_create_branch", {"branch_name": "spawned-by-tool"}),
    ("git_checkout", {"branch_name": OUTSIDE_BRANCH}),
    ("git_show", {"revision": "HEAD"}),
    ("git_branch", {"branch_type": "local"}),
)


def _init_repo(path: Path) -> git.Repo:
    repo = git.Repo.init(path)
    repo.git.config("user.email", "git-tests@example.com")
    repo.git.config("user.name", "Git Tests")
    return repo


def _install_hook(repo: git.Repo, name: str, marker: Path) -> None:
    hook = Path(repo.git_dir) / "hooks" / name
    hook.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' {name} >> {marker}\n"
        "exit 0\n"
    )
    hook.chmod(0o755)


def _snapshot(root: Path) -> tuple[tuple[str, bytes | None], ...]:
    items: list[tuple[str, bytes | None]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        items.append((str(current.relative_to(root)) + "/", None))
        for name in dirnames:
            child = current / name
            if child.is_symlink():
                items.append((str(child.relative_to(root)) + "/", os.readlink(child).encode()))
        for name in filenames:
            file_path = current / name
            relative = str(file_path.relative_to(root))
            if file_path.is_symlink():
                items.append((relative, os.readlink(file_path).encode()))
            else:
                items.append((relative, file_path.read_bytes()))
    return tuple(sorted(items))


def _changes(
    before: tuple[tuple[str, bytes | None], ...],
    after: tuple[tuple[str, bytes | None], ...],
) -> list[str]:
    previous = dict(before)
    current = dict(after)
    keys = set(previous) | set(current)
    return sorted(key for key in keys if previous.get(key) != current.get(key))


def _result_text(result: object) -> str:
    root = getattr(result, "root", result)
    content = getattr(root, "content", None)
    if not content:
        return str(result)
    parts: list[str] = []
    for block in content:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            parts.append(text)
    return "\n".join(parts)


def _is_caller_path(path: object, caller_path: Path) -> bool:
    try:
        text = os.fspath(path)  # type: ignore[arg-type]
    except TypeError:
        return False
    if not isinstance(text, str):
        return False
    return os.path.normpath(text) == os.path.normpath(os.fspath(caller_path))


@asynccontextmanager
async def _registered_server(allowed: Path) -> AsyncIterator[object]:
    holder: list[object] = []

    async def stop_after_register(
        self: object,
        read_stream: object,
        write_stream: object,
        initialization_options: object,
        **kwargs: object,
    ) -> None:
        holder.append(self)

    @asynccontextmanager
    async def fake_stdio() -> AsyncIterator[tuple[None, None]]:
        yield None, None

    with (
        pytest.MonkeyPatch.context() as patch,
    ):
        patch.setattr(server_mod.Server, "run", stop_after_register)
        patch.setattr(server_mod, "stdio_server", fake_stdio)
        await server_mod.serve(allowed)
    if not holder:
        raise RuntimeError("git server did not register its tool handler")
    yield holder[0]


@pytest.fixture
def sandbox(tmp_path: Path) -> Iterator[dict[str, Path]]:
    allowed = tmp_path / "allowed"
    outside = tmp_path / "outside"
    marker = tmp_path / "hook-marker"
    allowed.mkdir()
    outside.mkdir()

    allowed_repo = _init_repo(allowed)
    (allowed / "allowed.txt").write_text("allowed baseline\n")
    allowed_repo.index.add(["allowed.txt"])
    allowed_repo.index.commit("allowed-commit")

    outside_repo = _init_repo(outside)
    (outside / OUTSIDE_FILE).write_text("committed baseline\n")
    outside_repo.index.add([OUTSIDE_FILE])
    outside_repo.index.commit(OUTSIDE_COMMIT)
    outside_repo.create_head(OUTSIDE_BRANCH)
    (outside / OUTSIDE_STAGED_FILE).write_text(OUTSIDE_STAGED + "\n")
    outside_repo.index.add([OUTSIDE_STAGED_FILE])
    (outside / OUTSIDE_FILE).write_text("committed baseline\n" + OUTSIDE_BLOB + "\n")
    for hook_name in ("pre-commit", "commit-msg", "post-commit", "post-checkout"):
        _install_hook(outside_repo, hook_name, marker)

    caller_path = allowed / "repo-alias"
    caller_path.symlink_to(allowed, target_is_directory=True)

    yield {
        "allowed": allowed,
        "outside": outside,
        "caller_path": caller_path,
        "marker": marker,
    }


async def _call_tool(
    allowed: Path,
    caller_path: Path,
    outside: Path,
    tool_name: str,
    arguments: dict[str, object],
) -> tuple[str, bool]:
    swapped = False
    real_repo = server_mod.git.Repo

    def repo_opening_caller_path(path: object = None, *args: object, **kwargs: object) -> git.Repo:
        nonlocal swapped
        # Swap only when the original caller path is what will be opened.
        # A resolved directory path is a different string, so opening that
        # path does not observe this retarget.
        if not swapped and _is_caller_path(path, caller_path):
            caller_path.unlink()
            caller_path.symlink_to(outside, target_is_directory=True)
            swapped = True
        return real_repo(path, *args, **kwargs)  # type: ignore[arg-type,no-any-return]

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(server_mod.git, "Repo", repo_opening_caller_path)
        async with _registered_server(allowed) as server:
            request = CallToolRequest(
                params=CallToolRequestParams(
                    name=tool_name,
                    arguments={"repo_path": str(caller_path), **arguments},
                )
            )
            handler = server.request_handlers[CallToolRequest]  # type: ignore[attr-defined]
            result = await handler(request)
    return _result_text(result), swapped


@pytest.mark.parametrize(("tool_name", "arguments"), TOOLS, ids=[name for name, _ in TOOLS])
def test_symlink_swap_after_allowlist_check_cannot_escape(
    sandbox: dict[str, Path],
    tool_name: str,
    arguments: dict[str, object],
) -> None:
    outside = sandbox["outside"]
    before = _snapshot(outside)
    text, swapped = asyncio.run(
        _call_tool(
            sandbox["allowed"],
            sandbox["caller_path"],
            outside,
            tool_name,
            dict(arguments),
        )
    )
    after = _snapshot(outside)
    changed = _changes(before, after)
    echoed = {
        str(value)
        for value in arguments.values()
        if isinstance(value, str)
    }
    for value in arguments.values():
        if isinstance(value, list):
            echoed.update(str(item) for item in value)
    leaked = [marker for marker in MARKERS if marker in text and marker not in echoed]
    details = f"swap_at_open={swapped} leaked={leaked} changed={changed}\n{text}"

    assert not sandbox["marker"].exists(), details
    assert changed == [], details
    assert leaked == [], details
