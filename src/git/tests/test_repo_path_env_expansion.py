"""Allowlist confinement for repository paths that GitPython canonicalizes differently.

``validate_repo_path`` resolves a caller-supplied path with ``pathlib``.
``call_tool`` then opens that same path with ``git.Repo``. GitPython 3.1.54
stringifies the path and runs ``os.path.expanduser`` plus, by default,
``os.path.expandvars`` before opening. ``Path.resolve`` does neither, so a
relative path can sit inside the configured repository according to the
allowlist and still name a different repository after GitPython canonicalizes it.

These tests exercise the registered tools/call handler. They fail while that
disagreement remains, including if the same ``pathlib`` resolve is repeated
between the check and the open. They pass once every successful open stays
inside the configured repository and the other repository is left untouched.

Not covered here: Windows ``%VAR%`` paths (``posixpath.expandvars`` does not
expand them), and ``~username`` paths (those consult the password database).
"""

from __future__ import annotations

import os
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest import mock

import anyio
import git
import pytest
from mcp.server.lowlevel.server import Server
from mcp.types import CallToolRequest, CallToolRequestParams, CallToolResult, ServerResult

from mcp_server_git.server import serve

OUTSIDE_CONTENT = "OUTSIDE_REPO_SECRET_CONTENT\n"
OUTSIDE_COMMIT = "OUTSIDE_REPO_SECRET_COMMIT"
OUTSIDE_BRANCH = "outside-feature"
OUTSIDE_BRANCH_LINE = "OUTSIDE_BRANCH_SECRET\n"
OUTSIDE_UNTRACKED = "outside-only-untracked.txt"
OUTSIDE_UNSTAGED = "OUTSIDE_UNSTAGED_SECRET\n"
OUTSIDE_STAGED = "OUTSIDE_STAGED_SECRET\n"
ALLOWED_UNTRACKED = "allowed-only-untracked.txt"
ENV_ROOT = "MCP_GIT_OUTSIDE_ROOT"

OUTSIDE_MARKERS = (
    "OUTSIDE_REPO_SECRET_CONTENT",
    "OUTSIDE_REPO_SECRET_COMMIT",
    OUTSIDE_BRANCH,
    "OUTSIDE_BRANCH_SECRET",
    OUTSIDE_UNTRACKED,
    "OUTSIDE_UNSTAGED_SECRET",
    "OUTSIDE_STAGED_SECRET",
    "should-not-land",
    "should-not-exist",
)


@dataclass(frozen=True)
class RepoPair:
    """Configured repository and a second repository that must stay unreachable."""

    allowed: Path
    outside_root: Path
    outside: Path


@dataclass(frozen=True)
class ToolCase:
    """One git tool invocation that must not follow a canonicalized path."""

    name: str
    tool: str
    arguments: dict[str, Any]
    prepare: Callable[[git.Repo], None] | None = None


def _write_identity(repo: git.Repo) -> None:
    writer = repo.config_writer()
    writer.set_value("user", "name", "Test User")
    writer.set_value("user", "email", "test@example.com")
    writer.release()


def _init_repo(path: Path, filename: str, content: str, message: str) -> git.Repo:
    repo = git.Repo.init(path)
    _write_identity(repo)
    tracked = path / filename
    tracked.write_text(content)
    repo.index.add([filename])
    repo.index.commit(message)
    return repo


def build_repos(tmp_path: Path) -> RepoPair:
    """Create the configured repo and a sibling repo outside that directory."""
    allowed = tmp_path / "allowed"
    outside_root = tmp_path / "outside-root"
    outside = outside_root / "outside"
    allowed_repo = _init_repo(
        allowed,
        "allowed-marker.txt",
        "allowed-marker-content\n",
        "allowed-marker-commit",
    )
    (allowed / ALLOWED_UNTRACKED).write_text("allowed-only\n")
    allowed_repo.close()

    outside_repo = _init_repo(outside, "secret.txt", OUTSIDE_CONTENT, OUTSIDE_COMMIT)
    original = outside_repo.active_branch.name
    outside_repo.git.checkout("-b", OUTSIDE_BRANCH)
    secret = outside / "secret.txt"
    secret.write_text(OUTSIDE_CONTENT + OUTSIDE_BRANCH_LINE)
    outside_repo.index.add(["secret.txt"])
    outside_repo.index.commit("outside feature commit")
    outside_repo.git.checkout(original)
    (outside / OUTSIDE_UNTRACKED).write_text("outside untracked\n")
    outside_repo.close()
    return RepoPair(allowed=allowed, outside_root=outside_root, outside=outside)


def _tree(repo: git.Repo) -> Path:
    raw = repo.working_tree_dir
    if not isinstance(raw, (str, os.PathLike)):
        raise AssertionError("repository has no working tree")
    return Path(raw)


def _prepare_unstaged(repo: git.Repo) -> None:
    secret = _tree(repo) / "secret.txt"
    secret.write_text(secret.read_text() + OUTSIDE_UNSTAGED)


def _prepare_staged(repo: git.Repo) -> None:
    secret = _tree(repo) / "secret.txt"
    secret.write_text(secret.read_text() + OUTSIDE_STAGED)
    repo.index.add(["secret.txt"])


def _prepare_reset(repo: git.Repo) -> None:
    repo.index.add([OUTSIDE_UNTRACKED])


TOOL_CASES = [
    ToolCase("status", "git_status", {}),
    ToolCase("diff_unstaged", "git_diff_unstaged", {}, _prepare_unstaged),
    ToolCase("diff_staged", "git_diff_staged", {}, _prepare_staged),
    ToolCase("diff", "git_diff", {"target": OUTSIDE_BRANCH}),
    ToolCase("commit", "git_commit", {"message": "should-not-land"}),
    ToolCase("add_file", "git_add", {"files": [OUTSIDE_UNTRACKED]}),
    ToolCase("add_dot", "git_add", {"files": ["."]}),
    ToolCase("reset", "git_reset", {}, _prepare_reset),
    ToolCase("log", "git_log", {}),
    ToolCase("create_branch", "git_create_branch", {"branch_name": "should-not-exist"}),
    ToolCase("checkout", "git_checkout", {"branch_name": OUTSIDE_BRANCH}),
    ToolCase("show", "git_show", {"revision": "HEAD"}),
    ToolCase("branch", "git_branch", {"branch_type": "local"}),
]


def _dollar_path(root_name: str) -> str:
    return f"${root_name}/outside"


def _braced_path(root_name: str) -> str:
    return f"${{{root_name}}}/outside"


PATH_FORMS = [
    pytest.param(_dollar_path, ENV_ROOT, id="dollar"),
    pytest.param(_braced_path, ENV_ROOT, id="braces"),
    pytest.param(_dollar_path, "HOME", id="home"),
]


def snapshot(path: Path) -> dict[str, object]:
    """Read git state from disk so a prior Repo object cannot hide a write."""
    repo = git.Repo(path)
    try:
        root = _tree(repo)
        files: dict[str, bytes] = {}
        for child in sorted(root.rglob("*")):
            if ".git" in child.parts or not child.is_file() or child.is_symlink():
                continue
            files[str(child.relative_to(root))] = child.read_bytes()
        return {
            "head": repo.git.rev_parse("HEAD"),
            "branches": sorted(head.name for head in repo.heads),
            "porcelain": repo.git.status("--porcelain"),
            "staged": repo.git.diff("--cached"),
            "unstaged": repo.git.diff(),
            "files": files,
            "commit_editmsg": (root / ".git" / "COMMIT_EDITMSG").exists(),
        }
    finally:
        repo.close()


def result_text(result: ServerResult) -> tuple[bool, str]:
    root = result.root
    if not isinstance(root, CallToolResult):
        raise AssertionError(f"unexpected tools/call result: {type(root).__name__}")
    parts: list[str] = []
    for block in root.content:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            parts.append(text)
    return root.isError, "\n".join(parts)


@asynccontextmanager
async def _silent_stdio():
    yield (None, None)


async def invoke(allowed: Path, tool: str, arguments: dict[str, Any]) -> tuple[ServerResult, list[Path]]:
    """Run one registered tool call and record every repository git.Repo opens."""
    captured: dict[str, Server] = {}

    class CapturingServer(Server):
        def __init__(self, name: str, *args: Any, **kwargs: Any) -> None:
            super().__init__(name, *args, **kwargs)
            captured["server"] = self

    with (
        mock.patch("mcp_server_git.server.Server", CapturingServer),
        mock.patch("mcp_server_git.server.stdio_server", _silent_stdio),
        mock.patch.object(CapturingServer, "run", new_callable=mock.AsyncMock),
    ):
        await serve(allowed)

    server = captured["server"]
    handler = server.request_handlers[CallToolRequest]
    opened: list[Path] = []
    real_repo = git.Repo

    def tracking(path: Any = None, *args: Any, **kwargs: Any) -> git.Repo:
        repo = real_repo(path, *args, **kwargs)
        opened.append(_tree(repo).resolve())
        return repo

    with mock.patch("mcp_server_git.server.git.Repo", tracking):
        result = await handler(
            CallToolRequest(
                params=CallToolRequestParams(name=tool, arguments=arguments),
            )
        )
    return result, opened


def assert_confined(
    result: ServerResult,
    opened: list[Path],
    allowed: Path,
    outside: Path,
    before: dict[str, object],
) -> None:
    """The acted-on repository is the configured one, and the other is unchanged."""
    allowed_root = allowed.resolve()
    for opened_path in opened:
        try:
            opened_path.relative_to(allowed_root)
        except ValueError:
            pytest.fail(f"git.Repo opened {opened_path}, outside {allowed_root}")
    assert snapshot(outside) == before
    _is_error, text = result_text(result)
    for marker in OUTSIDE_MARKERS:
        assert marker not in text


def _run_case(pair: RepoPair, repo_path: str, case: ToolCase) -> None:
    # The unexpanded relative path resolves inside the configured repository.
    # Repeating that resolve between the check and git.Repo still yields this path.
    literal = Path(repo_path).resolve()
    assert literal.is_relative_to(pair.allowed.resolve())

    if case.prepare is not None:
        repo = git.Repo(pair.outside)
        try:
            case.prepare(repo)
        finally:
            repo.close()
    before = snapshot(pair.outside)
    arguments = {"repo_path": repo_path, **case.arguments}
    result, opened = anyio.run(invoke, pair.allowed, case.tool, arguments)
    assert_confined(result, opened, pair.allowed, pair.outside, before)


@pytest.mark.parametrize(("path_form", "env_name"), PATH_FORMS)
@pytest.mark.parametrize("case", TOOL_CASES, ids=[case.name for case in TOOL_CASES])
def test_repo_path_env_expansion_stays_inside_allowlist(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    path_form: Callable[[str], str],
    env_name: str,
    case: ToolCase,
) -> None:
    pair = build_repos(tmp_path)
    monkeypatch.chdir(pair.allowed)
    monkeypatch.setenv(env_name, str(pair.outside_root))
    _run_case(pair, path_form(env_name), case)


def test_tilde_repo_path_stays_inside_allowlist(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``expand_path`` expands ``~`` even when ``expand_vars`` is false."""
    pair = build_repos(tmp_path)
    monkeypatch.chdir(pair.allowed)
    monkeypatch.setenv("HOME", str(pair.outside_root))
    _run_case(pair, "~/outside", TOOL_CASES[0])


def test_configured_repository_still_opens(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pair = build_repos(tmp_path)
    monkeypatch.chdir(pair.allowed)
    before = snapshot(pair.outside)
    result, opened = anyio.run(
        invoke,
        pair.allowed,
        "git_status",
        {"repo_path": str(pair.allowed)},
    )
    is_error, text = result_text(result)
    assert is_error is False
    assert ALLOWED_UNTRACKED in text
    assert opened == [pair.allowed.resolve()]
    assert snapshot(pair.outside) == before


def test_relative_path_without_expansion_stays_inside_allowlist(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pair = build_repos(tmp_path)
    monkeypatch.chdir(pair.allowed)
    before = snapshot(pair.outside)
    result, opened = anyio.run(invoke, pair.allowed, "git_log", {"repo_path": "."})
    is_error, text = result_text(result)
    assert is_error is False
    assert "allowed-marker-commit" in text
    assert opened == [pair.allowed.resolve()]
    assert snapshot(pair.outside) == before
