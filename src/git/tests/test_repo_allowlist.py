"""Repository allowlist spec for the git MCP server.

These tests exercise the stdio server the documented install starts, and the
tool handler that opens ``repo_path``. They fail while a tool can read or
change a repository that was not authorized.

Two rules:

* With no ``--repository`` allowlist, every tool call is an error and does not
  read or change the repository named by ``repo_path``.
* With an allowlist, the repository that is opened is the path that passed
  the check. A later lookup of the caller-supplied path must not be what the
  tool reads or writes.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator

import anyio
import git
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.shared.memory import create_client_server_memory_streams
from mcp.types import CallToolResult, TextContent

from mcp_server_git.server import serve

FOREIGN_MARKER = "FOREIGN_REPO_MARKER"
ALLOWED_MARKER = "ALLOWED_REPO_MARKER"
Prepare = Callable[[git.Repo, str], None]


@dataclass(frozen=True)
class Operation:
    """One git tool, how to make its effect observable, and whether it writes."""

    name: str
    arguments: dict[str, object]
    prepare: Prepare
    echoes_marker: bool
    mutates: bool


def _prepare_nothing(repo: git.Repo, marker: str) -> None:
    del repo, marker


def _prepare_unstaged(repo: git.Repo, marker: str) -> None:
    path = Path(repo.working_dir) / "marker.txt"
    path.write_text(path.read_text(encoding="utf-8") + f"unstaged {marker}\n", encoding="utf-8")


def _prepare_staged(repo: git.Repo, marker: str) -> None:
    path = Path(repo.working_dir) / "staged.txt"
    path.write_text(f"staged {marker}\n", encoding="utf-8")
    repo.index.add(["staged.txt"])


def _prepare_commit(repo: git.Repo, marker: str) -> None:
    path = Path(repo.working_dir) / "commit_me.txt"
    path.write_text(f"commit {marker}\n", encoding="utf-8")
    repo.index.add(["commit_me.txt"])


def _prepare_add(repo: git.Repo, marker: str) -> None:
    path = Path(repo.working_dir) / "to_add.txt"
    path.write_text(f"add {marker}\n", encoding="utf-8")


OPERATIONS: tuple[Operation, ...] = (
    Operation("git_status", {}, _prepare_nothing, True, False),
    Operation("git_diff_unstaged", {}, _prepare_unstaged, True, False),
    Operation("git_diff_staged", {}, _prepare_staged, True, False),
    Operation("git_diff", {"target": "HEAD~1"}, _prepare_nothing, True, False),
    Operation("git_commit", {"message": "commit-from-tool"}, _prepare_commit, False, True),
    Operation("git_add", {"files": ["to_add.txt"]}, _prepare_add, False, True),
    Operation("git_reset", {}, _prepare_staged, False, True),
    Operation("git_log", {"max_count": 5}, _prepare_nothing, True, False),
    Operation("git_create_branch", {"branch_name": "created-branch"}, _prepare_nothing, False, True),
    Operation("git_checkout", {"branch_name": "feature"}, _prepare_nothing, False, True),
    Operation("git_show", {"revision": "HEAD"}, _prepare_nothing, True, False),
    Operation("git_branch", {"branch_type": "local"}, _prepare_nothing, True, False),
)


def _init_repo(path: Path, marker: str) -> git.Repo:
    path.mkdir(parents=True, exist_ok=True)
    repo = git.Repo.init(path)
    with repo.config_writer() as writer:
        writer.set_value("user", "name", "Test User")
        writer.set_value("user", "email", "test@example.com")
    tracked = path / "marker.txt"
    tracked.write_text(f"{marker}\n", encoding="utf-8")
    repo.index.add(["marker.txt"])
    repo.index.commit(f"initial {marker}")
    tracked.write_text(f"{marker}\nline2 {marker}\n", encoding="utf-8")
    repo.index.add(["marker.txt"])
    repo.index.commit(f"update {marker}")
    repo.git.branch("feature")
    repo.git.branch(f"branch-{marker}")
    (path / f"{marker}_untracked.txt").write_text(f"{marker}\n", encoding="utf-8")
    return repo


def _snapshot(path: Path) -> tuple[str, str, str, str, tuple[tuple[str, bytes], ...]]:
    """Logical repository state. Ignores index stat-cache bytes rewritten by status."""
    repo = git.Repo(path)
    try:
        files: list[tuple[str, bytes]] = []
        for file_path in sorted(path.rglob("*")):
            if ".git" in file_path.parts or not file_path.is_file() or file_path.is_symlink():
                continue
            files.append((str(file_path.relative_to(path)), file_path.read_bytes()))
        return (
            repo.git.rev_parse("HEAD"),
            repo.git.branch(),
            repo.git.ls_files("--stage"),
            repo.git.status("--porcelain"),
            tuple(files),
        )
    finally:
        repo.close()


def _tool_arguments(operation: Operation, repo_path: Path) -> dict[str, object]:
    return {"repo_path": str(repo_path), **operation.arguments}


def _text(result: CallToolResult) -> str:
    chunks: list[str] = []
    for block in result.content:
        if isinstance(block, TextContent):
            chunks.append(block.text)
    return "\n".join(chunks)


@asynccontextmanager
async def _stdio_server(*args: str) -> AsyncIterator[ClientSession]:
    """Start the installed console script the way the CLI entry point does."""
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "mcp_server_git", *args],
        cwd=str(Path.cwd()),
    )
    async with stdio_client(parameters) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            yield session


@asynccontextmanager
async def _inprocess_server(repository: Path | None) -> AsyncIterator[ClientSession]:
    """Run ``serve`` in this process so a path lookup can be retargeted under it."""

    @asynccontextmanager
    async def memory_stdio(
        stdin: object = None,
        stdout: object = None,
    ) -> AsyncIterator[tuple[object, object]]:
        del stdin, stdout
        yield server_streams

    async with create_client_server_memory_streams() as (client_streams, server_streams):
        client_read, client_write = client_streams
        async with anyio.create_task_group() as task_group:
            with pytest.MonkeyPatch.context() as patch:
                patch.setattr("mcp_server_git.server.stdio_server", memory_stdio)
                task_group.start_soon(serve, repository)
                try:
                    async with ClientSession(client_read, client_write) as session:
                        await session.initialize()
                        yield session
                finally:
                    task_group.cancel_scope.cancel()


def _assert_rejected(result: CallToolResult, repo_path: Path, before: object) -> None:
    text = _text(result)
    assert result.isError, text
    assert FOREIGN_MARKER not in text
    assert _snapshot(repo_path) == before


async def _call(session: ClientSession, operation: Operation, repo_path: Path) -> CallToolResult:
    arguments = _tool_arguments(operation, repo_path)
    return await session.call_tool(operation.name, arguments)


@pytest.mark.parametrize("operation", OPERATIONS, ids=lambda operation: operation.name)
def test_missing_allowlist_rejects_every_tool(operation: Operation, tmp_path: Path) -> None:
    """A server started with no repository flag must not open the caller's path."""
    foreign_path = tmp_path / "foreign"
    foreign = _init_repo(foreign_path, FOREIGN_MARKER)
    operation.prepare(foreign, FOREIGN_MARKER)
    foreign.close()
    before = _snapshot(foreign_path)

    async def run() -> None:
        async with _stdio_server() as session:
            result = await _call(session, operation, foreign_path)
        _assert_rejected(result, foreign_path, before)

    anyio.run(run)


def test_missing_allowlist_rejects_sibling_prefix_path(tmp_path: Path) -> None:
    """A directory whose name merely starts with another directory name is still foreign."""
    allowed_path = tmp_path / "repo"
    foreign_path = tmp_path / "repo-foreign"
    _init_repo(allowed_path, ALLOWED_MARKER).close()
    foreign = _init_repo(foreign_path, FOREIGN_MARKER)
    foreign.close()
    before = _snapshot(foreign_path)
    operation = next(item for item in OPERATIONS if item.name == "git_show")

    async def run() -> None:
        async with _stdio_server() as session:
            result = await _call(session, operation, foreign_path)
        _assert_rejected(result, foreign_path, before)

    anyio.run(run)


def test_configured_allowlist_rejects_other_repository(tmp_path: Path) -> None:
    allowed_path = tmp_path / "allowed"
    foreign_path = tmp_path / "foreign"
    _init_repo(allowed_path, ALLOWED_MARKER).close()
    _init_repo(foreign_path, FOREIGN_MARKER).close()
    before = _snapshot(foreign_path)
    operation = next(item for item in OPERATIONS if item.name == "git_show")

    async def run() -> None:
        async with _stdio_server("--repository", str(allowed_path)) as session:
            result = await _call(session, operation, foreign_path)
        _assert_rejected(result, foreign_path, before)

    anyio.run(run)


def test_configured_allowlist_rejects_sibling_prefix(tmp_path: Path) -> None:
    allowed_path = tmp_path / "repo"
    foreign_path = tmp_path / "repo-foreign"
    assert str(foreign_path).startswith(str(allowed_path))
    _init_repo(allowed_path, ALLOWED_MARKER).close()
    _init_repo(foreign_path, FOREIGN_MARKER).close()
    before = _snapshot(foreign_path)
    operation = next(item for item in OPERATIONS if item.name == "git_show")

    async def run() -> None:
        async with _stdio_server("--repository", str(allowed_path)) as session:
            result = await _call(session, operation, foreign_path)
        _assert_rejected(result, foreign_path, before)

    anyio.run(run)


def test_configured_allowlist_serves_its_own_repository(tmp_path: Path) -> None:
    allowed_path = tmp_path / "allowed"
    _init_repo(allowed_path, ALLOWED_MARKER).close()
    operation = next(item for item in OPERATIONS if item.name == "git_show")

    async def run() -> None:
        async with _stdio_server("--repository", str(allowed_path)) as session:
            result = await _call(session, operation, allowed_path)
        text = _text(result)
        assert result.isError is False, text
        assert ALLOWED_MARKER in text
        assert FOREIGN_MARKER not in text

    anyio.run(run)


@pytest.mark.parametrize("operation", OPERATIONS, ids=lambda operation: operation.name)
def test_allowlist_acts_on_the_path_that_was_checked(operation: Operation, tmp_path: Path) -> None:
    """Retarget the caller path after the check's lookup and before the open.

    ``validate_repo_path`` resolves ``repo_path``. ``git.Repo`` resolves that
    same path again (GitPython ``expand_path`` calls ``Path.resolve`` for a
    ``Path``). The tool must use the repository from the first lookup.
    """
    allowed_path = tmp_path / "allowed"
    foreign_path = tmp_path / "foreign"
    allowed = _init_repo(allowed_path, ALLOWED_MARKER)
    foreign = _init_repo(foreign_path, FOREIGN_MARKER)
    operation.prepare(allowed, ALLOWED_MARKER)
    operation.prepare(foreign, FOREIGN_MARKER)
    allowed.close()
    foreign.close()
    allowed_before = _snapshot(allowed_path)
    foreign_before = _snapshot(foreign_path)

    link = tmp_path / "entry"
    link.symlink_to(allowed_path)
    link_key = os.path.abspath(link)
    swapped = {"done": False}
    original_resolve = Path.resolve

    def resolve_then_retarget(self: Path, strict: bool = False) -> Path:
        result = original_resolve(self, strict)
        if not swapped["done"] and os.path.abspath(self) == link_key:
            link.unlink()
            link.symlink_to(foreign_path)
            swapped["done"] = True
        return result

    async def run() -> None:
        async with _inprocess_server(allowed_path) as session:
            with pytest.MonkeyPatch.context() as patch:
                patch.setattr(Path, "resolve", resolve_then_retarget)
                result = await _call(session, operation, link)
        assert swapped["done"], "the check never resolved the caller path"
        text = _text(result)
        assert result.isError is False, text
        if operation.echoes_marker:
            assert ALLOWED_MARKER in text
            assert FOREIGN_MARKER not in text
        assert _snapshot(foreign_path) == foreign_before
        if operation.mutates:
            assert _snapshot(allowed_path) != allowed_before
        else:
            assert _snapshot(allowed_path) == allowed_before

    anyio.run(run)
