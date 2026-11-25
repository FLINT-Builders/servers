"""Repository allowlist must not follow a gitdir pointer to another repository.

The git server accepts a tool call when the requested path stays inside the
configured repository, then opens that path with GitPython. A directory inside
the allowed tree can contain a ``.git`` gitdir file, or a ``.git`` symlink,
whose target is a different repository. Resolving the directory path again
does not catch that, because the directory itself never leaves the tree.

These tests drive the stdio server the way a client does. They fail while
that open still acts on the other repository, and they pass once every tool
refuses before reading or modifying it.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Any

import anyio
import git
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

OUTSIDE_BLOB = "OUTSIDE_BLOB_MARKER"
OUTSIDE_COMMIT = "OUTSIDE_COMMIT_MARKER"
OUTSIDE_OTHER_BLOB = "OUTSIDE_OTHER_BLOB"
OUTSIDE_STAGED = "OUTSIDE_STAGED_MARKER"

# Every tool funnels through the same open in call_tool. Each one must refuse.
TOOL_ARGUMENTS: dict[str, dict[str, Any]] = {
    "git_status": {},
    "git_diff_unstaged": {},
    "git_diff_staged": {},
    "git_diff": {"target": "HEAD"},
    "git_commit": {"message": "should-not-land"},
    "git_add": {"files": ["."]},
    "git_reset": {},
    "git_log": {},
    "git_create_branch": {"branch_name": "should-not-exist"},
    "git_checkout": {"branch_name": "outside-other"},
    "git_show": {"revision": "HEAD"},
    "git_branch": {"branch_type": "local"},
}

HOOK_NAMES = ("pre-commit", "commit-msg", "post-commit", "post-checkout")


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o755)


def _init_repo(path: Path, filename: str, content: str, message: str) -> git.Repo:
    repo = git.Repo.init(path)
    # Local settings so the developer machine's global gitconfig (fsmonitor,
    # commit signing) cannot rewrite the index or block the commit we stage.
    with repo.config_writer("repository") as config:
        config.set_value("commit", "gpgsign", "false")
        config.set_value("core", "fsmonitor", "false")
        config.set_value("core", "untrackedCache", "false")
    file_path = path / filename
    file_path.write_text(content)
    repo.index.add([filename])
    repo.index.commit(message)
    return repo


def _install_hooks(git_dir: Path, sentinel: Path) -> None:
    hooks = git_dir / "hooks"
    hooks.mkdir(exist_ok=True)
    script = f"#!/bin/sh\nprintf '%s\\n' \"$0\" >> {sh_quote(sentinel)}\nexit 0\n"
    for name in HOOK_NAMES:
        _write_executable(hooks / name, script)


def sh_quote(path: Path) -> str:
    return "'" + str(path).replace("'", "'\\''") + "'"


def _point_gitdir(decoy: Path, outside_git_dir: Path, indirection: str) -> None:
    git_entry = decoy / ".git"
    if indirection == "absolute":
        git_entry.write_text(f"gitdir: {outside_git_dir}\n")
    elif indirection == "relative":
        relative = os.path.relpath(outside_git_dir, decoy)
        git_entry.write_text(f"gitdir: {relative}\n")
    elif indirection == "symlink":
        git_entry.symlink_to(outside_git_dir, target_is_directory=True)
    else:
        raise AssertionError(f"unknown indirection {indirection}")


def _files_under(root: Path) -> tuple[tuple[str, bytes], ...]:
    if not root.exists():
        return ()
    found: list[tuple[str, bytes]] = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if relative == ".git" or relative.startswith(".git/"):
            continue
        if path.is_symlink():
            found.append((relative, b"symlink:" + os.readlink(path).encode()))
        elif path.is_file():
            found.append((relative, path.read_bytes()))
    return tuple(found)


def _git_metadata(repo_path: Path) -> dict[str, object]:
    """State of the repository that was authorized, opened by its own path."""
    repo = git.Repo(repo_path)
    git_dir = Path(repo.git_dir)
    tracked: dict[str, bytes] = {}
    for relative in ("HEAD", "config", "index", "COMMIT_EDITMSG"):
        candidate = git_dir / relative
        if candidate.is_file():
            tracked[relative] = candidate.read_bytes()
    for folder in ("refs", "logs"):
        base = git_dir / folder
        if not base.exists():
            continue
        for path in sorted(base.rglob("*")):
            if path.is_file():
                key = path.relative_to(git_dir).as_posix()
                tracked[key] = path.read_bytes()
    commits = tuple(commit.hexsha for commit in repo.iter_commits())
    return {
        "git_dir": str(git_dir.resolve()),
        "metadata": tracked,
        "commits": commits,
        "worktree": _files_under(repo_path),
    }


async def _call_tool(
    allowed: Path,
    repo_path: Path,
    tool: str,
    arguments: dict[str, Any],
) -> tuple[bool, str, str]:
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "mcp_server_git", "--repository", str(allowed)],
        cwd=str(allowed.parent),
    )
    with tempfile.TemporaryFile(mode="w+") as stderr:
        async with stdio_client(params, errlog=stderr) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.call_tool(
                    tool,
                    {"repo_path": str(repo_path), **arguments},
                )
        stderr.seek(0)
        err_text = stderr.read()
    chunks: list[str] = []
    for block in result.content:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            chunks.append(text)
    return bool(result.isError), "\n".join(chunks), err_text


def _prepare(tmp_path: Path, tool: str, indirection: str) -> dict[str, Path]:
    allowed = tmp_path / "allowed"
    outside = tmp_path / "outside"
    allowed.mkdir()
    outside.mkdir()
    allowed_repo = _init_repo(allowed, "allowed.txt", "allowed-content\n", "allowed commit")
    outside_repo = _init_repo(outside, "secret.txt", OUTSIDE_BLOB + "\n", OUTSIDE_COMMIT)
    default_branch = outside_repo.active_branch.name
    if default_branch != "outside-branch":
        outside_repo.git.branch("-M", "outside-branch")
    outside_repo.git.checkout("-b", "outside-other")
    (outside / "other.txt").write_text(OUTSIDE_OTHER_BLOB + "\n")
    outside_repo.index.add(["other.txt"])
    outside_repo.index.commit("outside other commit")
    outside_repo.git.checkout("outside-branch")

    if tool in {"git_reset", "git_diff_staged"}:
        # Staged only in the other repository, so a diff or reset that follows
        # the gitdir pointer has to read or rewrite that repository's index.
        (outside / "staged.txt").write_text(OUTSIDE_STAGED + "\n")
        outside_repo.index.add(["staged.txt"])

    sentinel = tmp_path / "hook-fired"
    _install_hooks(Path(outside_repo.git_dir), sentinel)

    decoy = allowed / "decoy"
    decoy.mkdir()
    if tool == "git_add":
        (decoy / "plant.txt").write_text("planted-by-caller\n")
    _point_gitdir(decoy, Path(outside_repo.git_dir), indirection)

    # The allowlist sees only this directory. It is inside the configured tree
    # even though its gitdir names the other repository.
    assert decoy.resolve().is_relative_to(allowed.resolve())
    assert Path(outside_repo.git_dir).resolve() != Path(allowed_repo.git_dir).resolve()
    return {
        "allowed": allowed,
        "outside": outside,
        "decoy": decoy,
        "sentinel": sentinel,
    }


@pytest.mark.parametrize("indirection", ["absolute", "relative", "symlink"])
@pytest.mark.parametrize("tool", list(TOOL_ARGUMENTS))
def test_gitdir_indirection_does_not_act_on_another_repository(
    tmp_path: Path,
    tool: str,
    indirection: str,
) -> None:
    """A tool call on a gitdir redirect must not read or change the other repo.

    Refusal has to happen before the git command. A response that reports an
    error only after the other repository's index, refs, work tree, or hooks
    have changed still fails this test. So does a check that only resolves the
    same directory path that was already inside the allowlist.
    """
    paths = _prepare(tmp_path, tool, indirection)
    outside_before = _git_metadata(paths["outside"])
    allowed_before = _git_metadata(paths["allowed"])
    decoy_before = _files_under(paths["decoy"])

    is_error, text, stderr = anyio.run(
        _call_tool,
        paths["allowed"],
        paths["decoy"],
        tool,
        TOOL_ARGUMENTS[tool],
    )

    outside_after = _git_metadata(paths["outside"])
    allowed_after = _git_metadata(paths["allowed"])
    decoy_after = _files_under(paths["decoy"])
    violations: list[str] = []
    if not is_error:
        violations.append(f"{tool} was applied instead of refused: {text[:500]}")
    leaked_markers = (
        OUTSIDE_BLOB,
        OUTSIDE_COMMIT,
        OUTSIDE_OTHER_BLOB,
        OUTSIDE_STAGED,
        "outside-branch",
    )
    for marker in leaked_markers:
        if marker in text:
            violations.append(f"{tool} returned content from the other repository ({marker})")
    if outside_after != outside_before:
        violations.append(f"{tool} changed the other repository")
    if allowed_after != allowed_before:
        violations.append(f"{tool} changed the allowed repository while opening the redirect")
    if decoy_after != decoy_before:
        violations.append(f"{tool} wrote files through the redirect before returning")
    if paths["sentinel"].exists():
        fired = paths["sentinel"].read_text()
        violations.append(f"{tool} ran hooks from the other repository: {fired.strip()}")
    if violations and stderr:
        violations.append(f"server stderr: {stderr[:500]}")
    assert not violations, "\n".join(violations)
