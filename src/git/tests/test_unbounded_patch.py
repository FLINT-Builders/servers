"""Bounds for patch text returned by the git tools.

git_show builds a commit patch with GitPython's create_patch=True, UTF-8-decodes
every hunk, and joins them into one string. git_diff, git_diff_unstaged, and
git_diff_staged return the entire git-diff stdout as one string. None of those
paths caps the patch. These tests are the spec for a fix: an oversized blob
must not be decoded or joined into the value the caller receives, and the
process must not allocate that patch while deciding to refuse it.

The tests fail while that behavior is present. A fix passes them by refusing
(or streaming only a bounded prefix) before the full patch exists in memory.
Binary blobs are not covered: git diff -p reports those in a short notice, so
they do not take this path.
"""

from __future__ import annotations

import tracemalloc
from pathlib import Path

import anyio
import git
import mcp.types as types
import pytest
import unittest.mock as mock

import mcp_server_git.server as server_mod
from mcp_server_git.server import (
    git_diff,
    git_diff_staged,
    git_diff_unstaged,
    git_show,
)

# Returned text, including an error string, must stay within this size.
MAX_RETURNED_BYTES = 64 * 1024
# Peak Python allocations traced during the call. Large enough for opening the
# repo and reading blob sizes, far below a single copy of the oversized payload.
MAX_TRACED_BYTES = 768 * 1024
SINGLE_BLOB_BYTES = 2 * 1024 * 1024
MULTI_FILE_BYTES = 400 * 1024
MULTI_FILE_COUNT = 3


def _init_repo(path: Path) -> git.Repo:
    repo = git.Repo.init(path)
    repo.git.config("user.email", "tester@example.com")
    repo.git.config("user.name", "tester")
    return repo


def _write_text_blob(path: Path, nbytes: int, marker: str) -> None:
    """Write a NUL-free text blob so git diff emits the bytes as a patch."""
    line = "A" * 79 + "\n"
    marker_line = marker + "\n"
    if nbytes <= len(marker_line) + len(line):
        raise ValueError("blob size must leave room for the marker")
    remaining = nbytes - len(marker_line)
    with path.open("w", encoding="utf-8") as handle:
        while remaining >= len(line):
            handle.write(line)
            remaining -= len(line)
        if remaining:
            handle.write("B" * (remaining - 1) + "\n")
        handle.write(marker_line)


def _worktree_files(repo: git.Repo) -> list[tuple[str, int]]:
    root = Path(repo.working_dir)
    files: list[tuple[str, int]] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if ".git" in relative.parts:
            continue
        files.append((relative.as_posix(), path.stat().st_size))
    return sorted(files)


def _assert_patch_not_materialized(text: str, peak: int, markers: list[str]) -> None:
    size = len(text.encode("utf-8"))
    problems: list[str] = []
    if size > MAX_RETURNED_BYTES:
        problems.append(f"caller received {size} bytes")
    present = [marker for marker in markers if marker in text]
    if present:
        problems.append(f"payload markers present: {present}")
    if peak > MAX_TRACED_BYTES:
        problems.append(f"traced peak {peak} bytes while building the result")
    assert not problems, "; ".join(problems)


def _invoke(repo: git.Repo, fn):
    before = _worktree_files(repo)
    tracemalloc.start()
    tracemalloc.clear_traces()
    try:
        try:
            outcome = fn()
        except Exception as exc:
            outcome = exc
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert _worktree_files(repo) == before
    text = str(outcome) if isinstance(outcome, Exception) else outcome
    assert isinstance(text, str)
    return text, peak


def _tool_handler(repository: Path | None):
    holder: dict[str, server_mod.Server] = {}
    original_init = server_mod.Server.__init__

    def capturing_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        holder["server"] = self

    async def _register() -> None:
        with (
            mock.patch.object(server_mod.Server, "__init__", capturing_init),
            mock.patch.object(server_mod.Server, "run", new_callable=mock.AsyncMock),
            mock.patch.object(server_mod, "stdio_server") as mock_stdio,
        ):
            mock_stdio.return_value.__aenter__.return_value = (
                mock.AsyncMock(),
                mock.AsyncMock(),
            )
            mock_stdio.return_value.__aexit__.return_value = None
            await server_mod.serve(repository)

    anyio.run(_register)
    return holder["server"].request_handlers[types.CallToolRequest]


def _call_tool(handler, name: str, arguments: dict) -> tuple[str, int]:
    async def _call() -> tuple[str, int]:
        request = types.CallToolRequest(
            params=types.CallToolRequestParams(name=name, arguments=arguments)
        )
        tracemalloc.start()
        tracemalloc.clear_traces()
        try:
            result = await handler(request)
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        tool_result = result.root
        assert isinstance(tool_result, types.CallToolResult)
        text = "".join(
            block.text for block in tool_result.content if isinstance(block, types.TextContent)
        )
        return text, peak

    return anyio.run(_call)


def test_git_show_root_commit_does_not_materialize_oversized_patch(tmp_path: Path):
    """The empty-tree branch (a commit with no parents) must not return the blob."""
    repo = _init_repo(tmp_path / "repo")
    marker = "MARKER_ROOT_PATCH_7c1e"
    _write_text_blob(Path(repo.working_dir) / "big.txt", SINGLE_BLOB_BYTES, marker)
    repo.index.add(["big.txt"])
    commit = repo.index.commit("add oversized blob")
    assert not commit.parents

    text, peak = _invoke(repo, lambda: git_show(repo, commit.hexsha))
    _assert_patch_not_materialized(text, peak, [marker])


def test_git_show_changed_blob_does_not_materialize_oversized_patch(tmp_path: Path):
    """parent.diff(create_patch=True) must not return a full replacement patch."""
    repo = _init_repo(tmp_path / "repo")
    tracked = Path(repo.working_dir) / "big.txt"
    _write_text_blob(tracked, 1024, "MARKER_SMALL_BASE_aa01")
    repo.index.add(["big.txt"])
    repo.index.commit("small base")

    marker = "MARKER_CHANGED_PATCH_7c1e"
    _write_text_blob(tracked, SINGLE_BLOB_BYTES, marker)
    repo.index.add(["big.txt"])
    commit = repo.index.commit("replace with oversized blob")
    assert commit.parents

    text, peak = _invoke(repo, lambda: git_show(repo, commit.hexsha))
    _assert_patch_not_materialized(text, peak, [marker])


def test_git_show_many_files_do_not_materialize_combined_patch(tmp_path: Path):
    """Several blobs under a per-file ceiling must still not be joined in full."""
    repo = _init_repo(tmp_path / "repo")
    readme = Path(repo.working_dir) / "README.md"
    readme.write_text("base\n", encoding="utf-8")
    repo.index.add(["README.md"])
    repo.index.commit("base")

    markers = [f"MARKER_MULTI_{index}_7c1e" for index in range(MULTI_FILE_COUNT)]
    names: list[str] = []
    for index, marker in enumerate(markers):
        name = f"part_{index}.txt"
        names.append(name)
        _write_text_blob(Path(repo.working_dir) / name, MULTI_FILE_BYTES, marker)
    repo.index.add(names)
    commit = repo.index.commit("add several oversized blobs")

    text, peak = _invoke(repo, lambda: git_show(repo, commit.hexsha))
    _assert_patch_not_materialized(text, peak, markers)


def test_git_show_small_revision_still_returns_its_patch(tmp_path: Path):
    """A later oversized commit must not block show of an earlier small revision."""
    repo = _init_repo(tmp_path / "repo")
    tracked = Path(repo.working_dir) / "note.txt"
    tracked.write_text("small note\n", encoding="utf-8")
    repo.index.add(["note.txt"])
    small = repo.index.commit("small commit")

    _write_text_blob(
        Path(repo.working_dir) / "big.txt",
        SINGLE_BLOB_BYTES,
        "MARKER_OTHER_COMMIT_7c1e",
    )
    repo.index.add(["big.txt"])
    repo.index.commit("oversized commit")

    result = git_show(repo, small.hexsha)
    assert "small note" in result
    assert "MARKER_OTHER_COMMIT_7c1e" not in result
    assert len(result.encode("utf-8")) <= MAX_RETURNED_BYTES


def test_git_diff_does_not_materialize_oversized_patch(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    readme = Path(repo.working_dir) / "README.md"
    readme.write_text("base\n", encoding="utf-8")
    repo.index.add(["README.md"])
    parent = repo.index.commit("base")

    marker = "MARKER_DIFF_TARGET_7c1e"
    _write_text_blob(Path(repo.working_dir) / "big.txt", SINGLE_BLOB_BYTES, marker)
    repo.index.add(["big.txt"])
    repo.index.commit("add oversized blob")

    text, peak = _invoke(repo, lambda: git_diff(repo, parent.hexsha))
    _assert_patch_not_materialized(text, peak, [marker])


def test_git_diff_staged_does_not_materialize_oversized_patch(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    readme = Path(repo.working_dir) / "README.md"
    readme.write_text("base\n", encoding="utf-8")
    repo.index.add(["README.md"])
    repo.index.commit("base")

    marker = "MARKER_STAGED_PATCH_7c1e"
    _write_text_blob(Path(repo.working_dir) / "big.txt", SINGLE_BLOB_BYTES, marker)
    repo.index.add(["big.txt"])

    text, peak = _invoke(repo, lambda: git_diff_staged(repo))
    _assert_patch_not_materialized(text, peak, [marker])


def test_git_diff_unstaged_does_not_materialize_oversized_patch(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    tracked = Path(repo.working_dir) / "big.txt"
    tracked.write_text("seed\n", encoding="utf-8")
    repo.index.add(["big.txt"])
    repo.index.commit("seed")

    marker = "MARKER_UNSTAGED_PATCH_7c1e"
    _write_text_blob(tracked, SINGLE_BLOB_BYTES, marker)

    text, peak = _invoke(repo, lambda: git_diff_unstaged(repo))
    _assert_patch_not_materialized(text, peak, [marker])


def _show_arguments(repo: git.Repo, revision: str) -> dict[str, str]:
    return {"repo_path": str(repo.working_dir), "revision": revision}


def _diff_arguments(repo: git.Repo, revision: str) -> dict[str, str]:
    return {"repo_path": str(repo.working_dir), "target": revision}


@pytest.mark.parametrize(
    ("tool_name", "argument_builder", "restrict_repository"),
    [
        ("git_show", _show_arguments, False),
        ("git_show", _show_arguments, True),
        ("git_diff", _diff_arguments, False),
        ("git_diff", _diff_arguments, True),
    ],
)
def test_tool_handler_does_not_return_oversized_patch(
    tmp_path: Path,
    tool_name: str,
    argument_builder,
    restrict_repository: bool,
):
    """tools/call must pass the revision through and still not return the patch."""
    repo = _init_repo(tmp_path / "repo")
    readme = Path(repo.working_dir) / "README.md"
    readme.write_text("base\n", encoding="utf-8")
    repo.index.add(["README.md"])
    parent = repo.index.commit("base")

    marker = "MARKER_TOOL_PATCH_7c1e"
    _write_text_blob(Path(repo.working_dir) / "big.txt", SINGLE_BLOB_BYTES, marker)
    repo.index.add(["big.txt"])
    head = repo.index.commit("add oversized blob")
    revision = head.hexsha if tool_name == "git_show" else parent.hexsha
    repository = Path(repo.working_dir) if restrict_repository else None

    handler = _tool_handler(repository)
    text, peak = _call_tool(handler, tool_name, argument_builder(repo, revision))
    _assert_patch_not_materialized(text, peak, [marker])


@pytest.mark.parametrize("restrict_repository", [False, True])
def test_staged_tool_does_not_return_oversized_patch(tmp_path: Path, restrict_repository: bool):
    repo = _init_repo(tmp_path / "repo")
    readme = Path(repo.working_dir) / "README.md"
    readme.write_text("base\n", encoding="utf-8")
    repo.index.add(["README.md"])
    repo.index.commit("base")

    marker = "MARKER_TOOL_STAGED_7c1e"
    _write_text_blob(Path(repo.working_dir) / "staged.txt", SINGLE_BLOB_BYTES, marker)
    repo.index.add(["staged.txt"])

    repository = Path(repo.working_dir) if restrict_repository else None
    handler = _tool_handler(repository)
    text, peak = _call_tool(handler, "git_diff_staged", {"repo_path": str(repo.working_dir)})
    _assert_patch_not_materialized(text, peak, [marker])


@pytest.mark.parametrize("restrict_repository", [False, True])
def test_unstaged_tool_does_not_return_oversized_patch(tmp_path: Path, restrict_repository: bool):
    repo = _init_repo(tmp_path / "repo")
    tracked = Path(repo.working_dir) / "tracked.txt"
    tracked.write_text("seed\n", encoding="utf-8")
    repo.index.add(["tracked.txt"])
    repo.index.commit("seed")

    marker = "MARKER_TOOL_UNSTAGED_7c1e"
    _write_text_blob(tracked, SINGLE_BLOB_BYTES, marker)

    repository = Path(repo.working_dir) if restrict_repository else None
    handler = _tool_handler(repository)
    text, peak = _call_tool(handler, "git_diff_unstaged", {"repo_path": str(repo.working_dir)})
    _assert_patch_not_materialized(text, peak, [marker])
