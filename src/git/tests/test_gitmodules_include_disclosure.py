"""git_show must not disclose local files named by .gitmodules include directives.

A commit whose patch has a real pre-image path (modify, delete, or rename) makes
GitPython build Diff objects, and those objects load repo.submodules. GitPython
3.1.54 parses the working-tree .gitmodules with include merging left on. An
included file that is not a git config raises MissingSectionHeaderError, and the
MCP tool handler returns that message to the client. These tests fail while that
disclosure happens.
"""

from pathlib import Path

import anyio
import git
import pytest
from mcp.server.lowlevel.server import Server
from mcp.types import CallToolRequest, CallToolRequestParams

from mcp_server_git.server import git_show, serve

import unittest.mock as mock

# Obvious placeholder. This string exists only in a file outside the repository.
OUTSIDE_FILE_MARKER = "PLACEHOLDER_LOCAL_FILE_FIRST_LINE"
UNUSED_INCLUDE_URL = "https://example.invalid/unused.git"


def _write_outside_file(path: Path) -> None:
    path.write_text(OUTSIDE_FILE_MARKER + "\n")


def _gitmodules(include_path: str) -> str:
    return (
        "[include]\n"
        f"\tpath = {include_path}\n"
        f"\turl = {UNUSED_INCLUDE_URL}\n"
    )


def _init_repo(repo_path: Path, include_path: str) -> git.Repo:
    repo = git.Repo.init(repo_path)
    (repo_path / "readme.txt").write_text("hello\n")
    (repo_path / ".gitmodules").write_text(_gitmodules(include_path))
    repo.index.add(["readme.txt", ".gitmodules"])
    repo.index.commit("init")
    return repo


def _show_text(repo: git.Repo, revision: str) -> str:
    try:
        return git_show(repo, revision)
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"


def test_git_show_modified_file_does_not_disclose_included_file(tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    _write_outside_file(outside)
    repo = _init_repo(tmp_path / "repo", str(outside))
    readme = Path(repo.working_dir) / "readme.txt"
    readme.write_text("hello changed\n")
    repo.index.add(["readme.txt"])
    repo.index.commit("modify readme")

    text = _show_text(repo, repo.head.commit.hexsha)

    assert OUTSIDE_FILE_MARKER not in text
    assert "hello changed" in text


def test_git_show_deleted_file_does_not_disclose_included_file(tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    _write_outside_file(outside)
    repo = _init_repo(tmp_path / "repo", str(outside))
    readme = Path(repo.working_dir) / "readme.txt"
    readme.unlink()
    repo.index.remove(["readme.txt"])
    repo.index.commit("delete readme")

    text = _show_text(repo, repo.head.commit.hexsha)

    assert OUTSIDE_FILE_MARKER not in text
    assert "readme.txt" in text


def test_git_show_renamed_file_does_not_disclose_included_file(tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    _write_outside_file(outside)
    repo = _init_repo(tmp_path / "repo", str(outside))
    readme = Path(repo.working_dir) / "readme.txt"
    renamed = Path(repo.working_dir) / "renamed.txt"
    readme.rename(renamed)
    repo.index.remove(["readme.txt"])
    repo.index.add(["renamed.txt"])
    repo.index.commit("rename readme")

    text = _show_text(repo, repo.head.commit.hexsha)

    assert OUTSIDE_FILE_MARKER not in text
    assert "renamed.txt" in text


def test_git_show_relative_include_does_not_disclose_included_file(tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    _write_outside_file(outside)
    repo = _init_repo(tmp_path / "repo", "../outside.txt")
    readme = Path(repo.working_dir) / "readme.txt"
    readme.write_text("hello changed\n")
    repo.index.add(["readme.txt"])
    repo.index.commit("modify readme")

    text = _show_text(repo, repo.head.commit.hexsha)

    assert OUTSIDE_FILE_MARKER not in text
    assert "hello changed" in text


def test_git_show_home_include_does_not_disclose_included_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    outside = home / "outside.txt"
    _write_outside_file(outside)
    monkeypatch.setenv("HOME", str(home))
    repo = _init_repo(tmp_path / "repo", "~/outside.txt")
    readme = Path(repo.working_dir) / "readme.txt"
    readme.write_text("hello changed\n")
    repo.index.add(["readme.txt"])
    repo.index.commit("modify readme")

    text = _show_text(repo, repo.head.commit.hexsha)

    assert OUTSIDE_FILE_MARKER not in text
    assert "hello changed" in text


def test_git_show_tool_result_does_not_disclose_included_file(tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    _write_outside_file(outside)
    repo_path = tmp_path / "repo"
    repo = _init_repo(repo_path, str(outside))
    readme = Path(repo.working_dir) / "readme.txt"
    readme.write_text("hello changed\n")
    repo.index.add(["readme.txt"])
    revision = repo.index.commit("modify readme").hexsha

    async def _call() -> str:
        captured: dict[str, Server] = {}

        async def fake_run(self: Server, *args: object, **kwargs: object) -> None:
            captured["server"] = self

        with (
            mock.patch("mcp_server_git.server.stdio_server") as mock_stdio,
            mock.patch("mcp_server_git.server.Server.run", new=fake_run),
        ):
            mock_stdio.return_value.__aenter__.return_value = (mock.AsyncMock(), mock.AsyncMock())
            mock_stdio.return_value.__aexit__.return_value = None
            await serve(repo_path)

        handler = captured["server"].request_handlers[CallToolRequest]
        response = await handler(
            CallToolRequest(
                params=CallToolRequestParams(
                    name="git_show",
                    arguments={"repo_path": str(repo_path), "revision": revision},
                )
            )
        )
        result = response.root
        assert result.isError is False
        return "\n".join(block.text for block in result.content if getattr(block, "text", None))

    text = anyio.run(_call)

    assert OUTSIDE_FILE_MARKER not in text
    assert "hello changed" in text
