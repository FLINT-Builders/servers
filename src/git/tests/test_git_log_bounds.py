"""Bounds for git_log max_count on the tools/call path.

The published GitLog schema advertises max_count as an integer with no
minimum or maximum. These tests call the registered tools/call handler,
which is the path a client uses, and require that path to materialize at
most 100 commits. A request for more than that, a non-positive count, or a
null count must not ask git to walk an unbounded history and must not place
that history in the tool result.

They fail while the handler forwards the caller-supplied count straight
into GitPython.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import git
import pytest
from git.cmd import Git
from mcp import types
from mcp.server.lowlevel.server import Server
from mcp.types import CallToolRequest, CallToolRequestParams, CallToolResult

from mcp_server_git.server import GitTools, serve

# Inclusive ceiling from the intended GitLog bound (ge=1, le=100).
MAX_COMMITS = 100
HISTORY_LENGTH = MAX_COMMITS + 20


def _commit_history(repo_path: Path) -> git.Repo:
    """Create a linear history longer than the commit ceiling.

    Commit i has subject ``subject-{i}`` and a distinct body line
    ``body-{i}-full`` so a response that includes the commit also includes
    the full message, not only the subject.
    """
    repo = git.Repo.init(repo_path)
    with repo.config_writer() as config:
        config.set_value("user", "email", "bounds-test@example.com")
        config.set_value("user", "name", "Bounds Test")
    tracked = repo_path / "tracked.txt"
    for index in range(HISTORY_LENGTH):
        tracked.write_text(f"revision {index}\n")
        repo.index.add(["tracked.txt"])
        repo.index.commit(f"subject-{index}\n\nbody-{index}-full\n")
    return repo


async def _invoke_git_log(
    repo_path: Path, arguments: dict[str, Any]
) -> tuple[CallToolResult, list[list[str]]]:
    """Run serve() far enough to register tools, then issue tools/call.

    stdio and Server.run are not entered; the CallToolRequest handler that
    serve() registered is the same handler Server.run dispatches to.
    """
    holder: dict[str, Server] = {}

    class _CapturingServer(Server):
        def __init__(self, name: str, *args: Any, **kwargs: Any) -> None:
            super().__init__(name, *args, **kwargs)
            holder["server"] = self

        async def run(self, *args: Any, **kwargs: Any) -> None:
            return None

    class _Stdio:
        async def __aenter__(self) -> tuple[None, None]:
            return (None, None)

        async def __aexit__(self, *args: Any) -> None:
            return None

    import mcp_server_git.server as server_module

    original_server = server_module.Server
    original_stdio = server_module.stdio_server
    server_module.Server = _CapturingServer  # type: ignore[misc]
    server_module.stdio_server = lambda: _Stdio()  # type: ignore[assignment]
    try:
        await serve(repo_path)
    finally:
        server_module.Server = original_server
        server_module.stdio_server = original_stdio

    server = holder["server"]
    rev_list_commands: list[list[str]] = []
    real_execute = Git.execute

    def _recording_execute(
        self: Git, command: list[str], *args: Any, **kwargs: Any
    ) -> Any:
        if any(part == "rev-list" for part in command):
            rev_list_commands.append([str(part) for part in command])
        return real_execute(self, command, *args, **kwargs)

    request = CallToolRequest(
        params=CallToolRequestParams(
            name=GitTools.LOG,
            arguments={"repo_path": str(repo_path), **arguments},
        )
    )
    original_execute = Git.execute
    Git.execute = _recording_execute  # type: ignore[method-assign]
    try:
        server_result = await server.request_handlers[types.CallToolRequest](request)
    finally:
        Git.execute = original_execute  # type: ignore[method-assign]

    tool_result = server_result.root
    assert isinstance(tool_result, CallToolResult)
    return tool_result, rev_list_commands


def _result_text(result: CallToolResult) -> str:
    return "\n".join(
        block.text for block in result.content if isinstance(block, types.TextContent)
    )


def _max_counts(command: list[str]) -> list[int]:
    counts: list[int] = []
    for part in command:
        prefix = "--max-count="
        if part.startswith(prefix):
            counts.append(int(part[len(prefix) :]))
    return counts


def _assert_walk_is_bounded(result: CallToolResult, commands: list[list[str]]) -> None:
    """The handler may reject the call or return at most MAX_COMMITS commits.

    Either way, git rev-list must not be started without a max-count in
    1..MAX_COMMITS. Truncating the response after an unlimited walk still
    fails this check.
    """
    text = _result_text(result)
    if result.isError:
        assert "Commit: " not in text
        assert "body-" not in text
    else:
        assert text.count("Commit: ") <= MAX_COMMITS
    for command in commands:
        counts = _max_counts(command)
        assert (
            counts
        ), f"rev-list has no max-count and walks the whole history: {command}"
        assert all(1 <= count <= MAX_COMMITS for count in counts), command


@pytest.fixture
def history(tmp_path: Path) -> Path:
    repo_path = tmp_path / "repo"
    _commit_history(repo_path)
    return repo_path


def test_git_log_tool_omitted_max_count_returns_default(history: Path) -> None:
    import anyio

    async def _run() -> None:
        result, commands = await _invoke_git_log(history, {})
        assert result.isError is False
        text = _result_text(result)
        assert text.count("Commit: ") == 10
        assert "body-119-full" in text
        assert "body-110-full" in text
        assert "body-109-full" not in text
        _assert_walk_is_bounded(result, commands)
        assert _max_counts(commands[0]) == [10]

    anyio.run(_run)


def test_git_log_tool_upper_bound_returns_full_messages(history: Path) -> None:
    """max_count equal to the ceiling is legal and still returns each full message."""
    import anyio

    async def _run() -> None:
        result, commands = await _invoke_git_log(history, {"max_count": MAX_COMMITS})
        assert result.isError is False
        text = _result_text(result)
        assert text.count("Commit: ") == MAX_COMMITS
        newest = HISTORY_LENGTH - 1
        oldest_included = newest - (MAX_COMMITS - 1)
        assert f"subject-{newest}" in text
        assert f"body-{newest}-full" in text
        assert f"body-{oldest_included}-full" in text
        assert f"body-{oldest_included - 1}-full" not in text
        _assert_walk_is_bounded(result, commands)
        assert _max_counts(commands[0]) == [MAX_COMMITS]

    anyio.run(_run)


def test_git_log_tool_huge_max_count_does_not_materialize_history(
    history: Path,
) -> None:
    import anyio

    async def _run() -> None:
        result, commands = await _invoke_git_log(history, {"max_count": 10**9})
        text = _result_text(result)
        assert "body-0-full" not in text
        _assert_walk_is_bounded(result, commands)
        if not result.isError:
            assert text.count("Commit: ") <= MAX_COMMITS

    anyio.run(_run)


def test_git_log_tool_just_over_ceiling_does_not_materialize_extra_commit(
    history: Path,
) -> None:
    import anyio

    async def _run() -> None:
        result, commands = await _invoke_git_log(
            history, {"max_count": MAX_COMMITS + 1}
        )
        text = _result_text(result)
        # Commit 19 is outside the newest 100 of a 120-commit history.
        assert "body-19-full" not in text
        _assert_walk_is_bounded(result, commands)

    anyio.run(_run)


def test_git_log_tool_negative_max_count_does_not_walk_entire_history(
    history: Path,
) -> None:
    import anyio

    async def _run() -> None:
        result, commands = await _invoke_git_log(history, {"max_count": -1})
        text = _result_text(result)
        assert "body-0-full" not in text
        _assert_walk_is_bounded(result, commands)

    anyio.run(_run)


def test_git_log_tool_zero_max_count_is_not_forwarded(history: Path) -> None:
    import anyio

    async def _run() -> None:
        result, commands = await _invoke_git_log(history, {"max_count": 0})
        _assert_walk_is_bounded(result, commands)

    anyio.run(_run)


def test_git_log_tool_null_max_count_does_not_walk_entire_history(
    history: Path,
) -> None:
    import anyio

    async def _run() -> None:
        result, commands = await _invoke_git_log(history, {"max_count": None})
        text = _result_text(result)
        assert "body-0-full" not in text
        _assert_walk_is_bounded(result, commands)

    anyio.run(_run)


def test_git_log_tool_huge_max_count_with_timestamp_filter_stays_bounded(
    history: Path,
) -> None:
    """Date filters use the same git_log walk and must not lift the ceiling."""
    import anyio

    async def _run() -> None:
        result, commands = await _invoke_git_log(
            history,
            {
                "max_count": 10**9,
                "start_timestamp": "2000-01-01",
                "end_timestamp": "2099-01-01",
            },
        )
        text = _result_text(result)
        assert "body-0-full" not in text
        _assert_walk_is_bounded(result, commands)

    anyio.run(_run)
