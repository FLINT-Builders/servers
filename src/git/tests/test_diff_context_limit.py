"""Diff tools must not honor an unbounded context_lines value.

A caller of git_diff_unstaged, git_diff_staged, or git_diff can supply
context_lines. The server must treat that value as a small non-negative
integer, 0 through 100 inclusive, before it runs git. These tests fail while
a larger value is spliced into --unified= and the expanded diff is returned
as one string.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
from datetime import timedelta
from pathlib import Path
from typing import Any

import anyio
import git
import jsonschema
import pytest
from jsonschema import ValidationError
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.types import CallToolResult, Tool

MAX_CONTEXT_LINES = 100
LINE_COUNT = 4000
CHANGE_INDEX = 2000
# Far enough from the one-line edit that 100 lines of context cannot include them.
FAR_INDEXES = (10, 3990)
FAR_MARK = "FAR_CONTEXT_SENTINEL_TOKEN"
CHANGE_MARK = "CHANGED_MIDDLE_TOKEN"
# Values the published schema and the git invocation must both refuse.
# 2147483647 is the largest context git 2.43 still stores in diff_options.context
# and then applies, bounded only by the file length.
UNBOUNDED_CONTEXT_VALUES = (-1, 101, 100_000, 2_147_483_647)
UNIFIED_ARGUMENT = re.compile(r"(?:--unified=|-U)(-?\d+)")


def _file_text(changed: bool) -> str:
    lines = [f"line {index:05d} padding" for index in range(LINE_COUNT)]
    for index in FAR_INDEXES:
        lines[index] = FAR_MARK
    if changed:
        lines[CHANGE_INDEX] = CHANGE_MARK
    return "\n".join(lines) + "\n"


def _init_repo(tmp_path: Path) -> git.Repo:
    repo_path = tmp_path / "repo"
    repo = git.Repo.init(repo_path)
    file_path = repo_path / "big.txt"
    file_path.write_text(_file_text(changed=False))
    repo.index.add(["big.txt"])
    repo.index.commit("initial commit")
    return repo


def _write_change(repo: git.Repo) -> None:
    file_path = Path(repo.working_dir) / "big.txt"
    file_path.write_text(_file_text(changed=True))


def _git_wrapper(tmp_path: Path, log_path: Path) -> Path:
    real_git = shutil.which("git")
    assert real_git is not None
    bindir = tmp_path / "bin"
    bindir.mkdir()
    wrapper = bindir / "git"
    wrapper.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$GIT_ARGV_LOG"\n'
        f'exec {real_git} "$@"\n'
    )
    wrapper.chmod(0o755)
    log_path.write_text("")
    return bindir


def _result_text(result: CallToolResult) -> str:
    parts: list[str] = []
    for block in result.content:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            parts.append(text)
    return "\n".join(parts)


def _assert_schema_bounds(schema: dict[str, Any], extra: dict[str, Any]) -> None:
    base = {"repo_path": "/tmp/repo", **extra}
    jsonschema.validate({**base, "context_lines": 0}, schema)
    jsonschema.validate({**base, "context_lines": MAX_CONTEXT_LINES}, schema)
    jsonschema.validate(base, schema)
    for value in UNBOUNDED_CONTEXT_VALUES:
        with pytest.raises(ValidationError):
            jsonschema.validate({**base, "context_lines": value}, schema)


def _assert_invocation_bounded(argv_log: str, result_text: str) -> None:
    for raw in UNIFIED_ARGUMENT.findall(argv_log):
        context = int(raw)
        assert 0 <= context <= MAX_CONTEXT_LINES, (
            f"git ran with context {context}; argv={argv_log!r}; "
            f"result_prefix={result_text[:400]!r}"
        )
    assert FAR_MARK not in result_text, (
        "tool result included file lines far outside the context bound; "
        f"argv={argv_log!r}; result_len={len(result_text)}"
    )


async def _with_server(
    repo: git.Repo,
    wrapper_dir: Path,
    log_path: Path,
    callback: Any,
) -> Any:
    env = {
        "PATH": f"{wrapper_dir}{os.pathsep}{os.environ.get('PATH', '')}",
        "GIT_ARGV_LOG": str(log_path),
    }
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "mcp_server_git", "--repository", str(repo.working_dir)],
        env=env,
        cwd=str(repo.working_dir),
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=30)) as session:
            await session.initialize()
            listed = await session.list_tools()
            tools = {tool.name: tool for tool in listed.tools}
            return await callback(session, tools, log_path)


def _run(repo: git.Repo, tmp_path: Path, callback: Any) -> Any:
    log_path = tmp_path / "git-argv.log"
    wrapper_dir = _git_wrapper(tmp_path, log_path)

    async def _invoke() -> Any:
        return await _with_server(repo, wrapper_dir, log_path, callback)

    return anyio.run(_invoke)


async def _call_diff(
    session: ClientSession,
    log_path: Path,
    name: str,
    arguments: dict[str, Any],
) -> tuple[str, str]:
    log_path.write_text("")
    result = await session.call_tool(name, arguments)
    return log_path.read_text(), _result_text(result)


def test_diff_tool_schemas_bound_context_lines(tmp_path: Path) -> None:
    """The schemas advertised by tools/list must reject context outside 0..100."""
    repo = _init_repo(tmp_path)

    async def _check(_session: ClientSession, tools: dict[str, Tool], _log_path: Path) -> dict[str, Tool]:
        return tools

    tools = _run(repo, tmp_path, _check)
    _assert_schema_bounds(tools["git_diff_unstaged"].inputSchema, {})
    _assert_schema_bounds(tools["git_diff_staged"].inputSchema, {})
    _assert_schema_bounds(tools["git_diff"].inputSchema, {"target": "HEAD"})


@pytest.mark.parametrize("context_lines", UNBOUNDED_CONTEXT_VALUES)
def test_git_diff_unstaged_rejects_unbounded_context(tmp_path: Path, context_lines: int) -> None:
    repo = _init_repo(tmp_path)
    _write_change(repo)

    async def _call(session: ClientSession, _tools: dict[str, Tool], log_path: Path) -> tuple[str, str]:
        return await _call_diff(
            session,
            log_path,
            "git_diff_unstaged",
            {"repo_path": str(repo.working_dir), "context_lines": context_lines},
        )

    argv_log, text = _run(repo, tmp_path, _call)
    _assert_invocation_bounded(argv_log, text)


@pytest.mark.parametrize("context_lines", UNBOUNDED_CONTEXT_VALUES)
def test_git_diff_staged_rejects_unbounded_context(tmp_path: Path, context_lines: int) -> None:
    repo = _init_repo(tmp_path)
    _write_change(repo)
    repo.index.add(["big.txt"])

    async def _call(session: ClientSession, _tools: dict[str, Tool], log_path: Path) -> tuple[str, str]:
        return await _call_diff(
            session,
            log_path,
            "git_diff_staged",
            {"repo_path": str(repo.working_dir), "context_lines": context_lines},
        )

    argv_log, text = _run(repo, tmp_path, _call)
    _assert_invocation_bounded(argv_log, text)


@pytest.mark.parametrize("context_lines", UNBOUNDED_CONTEXT_VALUES)
def test_git_diff_rejects_unbounded_context(tmp_path: Path, context_lines: int) -> None:
    repo = _init_repo(tmp_path)
    parent = repo.head.commit.hexsha
    _write_change(repo)
    repo.index.add(["big.txt"])
    repo.index.commit("middle line changed")

    async def _call(session: ClientSession, _tools: dict[str, Tool], log_path: Path) -> tuple[str, str]:
        return await _call_diff(
            session,
            log_path,
            "git_diff",
            {
                "repo_path": str(repo.working_dir),
                "target": parent,
                "context_lines": context_lines,
            },
        )

    argv_log, text = _run(repo, tmp_path, _call)
    _assert_invocation_bounded(argv_log, text)


def test_bounded_context_still_returns_the_one_line_change(tmp_path: Path) -> None:
    """0 and 100 remain valid and must not pull in distant file lines."""
    repo = _init_repo(tmp_path)
    _write_change(repo)

    async def _call(session: ClientSession, _tools: dict[str, Tool], log_path: Path) -> list[tuple[str, str, bool]]:
        observed: list[tuple[str, str, bool]] = []
        for context_lines in (0, MAX_CONTEXT_LINES):
            log_path.write_text("")
            result = await session.call_tool(
                "git_diff_unstaged",
                {"repo_path": str(repo.working_dir), "context_lines": context_lines},
            )
            observed.append((log_path.read_text(), _result_text(result), result.isError))
        return observed

    for argv_log, text, is_error in _run(repo, tmp_path, _call):
        assert is_error is False
        assert CHANGE_MARK in text
        _assert_invocation_bounded(argv_log, text)
