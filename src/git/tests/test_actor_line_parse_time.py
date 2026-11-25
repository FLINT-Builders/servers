"""Bound the time git_log and git_show spend parsing actor lines.

GitPython 3.1.54 parses author, committer, and tagger lines with a regex that
backtracks quadratically when the line is a long run of spaces and the trailing
epoch or timezone is missing or malformed. These tests plant that object in a
repository and call the server tools that read it.

They fail while that parse is still on the tool path, and they pass once those
tools finish (or refuse) without the quadratic parse. A long actor name that
already has a valid epoch and timezone must stay fast.

Not covered, because those tools never read an actor line: git_status,
git_diff_unstaged, git_diff_staged, git_diff, git_commit, git_add, git_reset,
git_create_branch, git_checkout, and git_branch. git_log also does not parse
annotated-tag tagger lines; git_show does, when the revision peels a tag.
Showing a descendant does not parse its parent's actor lines.
"""

from __future__ import annotations

import os
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

import git

from mcp_server_git.server import git_log, git_show

# A 24 KB run of spaces is several seconds on the vulnerable parser and
# milliseconds once that parser is no longer used for these tools.
SPACE_RUN = 24_000
MAX_SECONDS = 1.0

_VALID_AUTHOR = "author Tester <tester@example.com> 1700000000 +0000"
_VALID_COMMITTER = "committer Tester <tester@example.com> 1700000000 +0000"


def _git(repo: Path, *args: str, input_text: str | None = None) -> str:
    env = os.environ.copy()
    env.setdefault("GIT_AUTHOR_NAME", "Tester")
    env.setdefault("GIT_AUTHOR_EMAIL", "tester@example.com")
    env.setdefault("GIT_COMMITTER_NAME", "Tester")
    env.setdefault("GIT_COMMITTER_EMAIL", "tester@example.com")
    completed = subprocess.run(
        ["git", "-C", str(repo), *args],
        input=input_text,
        text=True,
        capture_output=True,
        check=True,
        env=env,
    )
    return completed.stdout.strip()


def _init_repo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    (repo / "file.txt").write_text("hello\n", encoding="utf-8")
    _git(repo, "add", "file.txt")
    tree = _git(repo, "write-tree")
    _git(repo, "symbolic-ref", "HEAD", "refs/heads/main")
    return repo, tree


def _write_object(repo: Path, object_type: str, body: str) -> str:
    # `--literally` stores the object even when its actor line would fail
    # git's own fsck. The bytes are what a fetch with fsck disabled delivers.
    return _git(
        repo,
        "hash-object",
        "-t",
        object_type,
        "-w",
        "--literally",
        "--stdin",
        input_text=body,
    )


def _commit_body(tree: str, author_line: str, committer_line: str, message: str = "msg") -> str:
    return f"tree {tree}\n{author_line}\n{committer_line}\n\n{message}\n"


def _point(repo: Path, ref: str, sha: str) -> None:
    _git(repo, "update-ref", ref, sha)


def _open(repo: Path) -> git.Repo:
    return git.Repo(repo)


def _assert_within_bound(operation: str, fn: Callable[[], object]) -> None:
    started = time.perf_counter()
    try:
        fn()
    except Exception:
        # A fast refusal is within the bound. A refusal that arrives only
        # after the slow parse is not.
        pass
    elapsed = time.perf_counter() - started
    assert elapsed < MAX_SECONDS, f"{operation} took {elapsed:.2f}s (limit {MAX_SECONDS:.1f}s)"


def _spaces(prefix: str) -> str:
    return prefix + (" " * SPACE_RUN)


def test_git_log_spaces_author_missing_date(tmp_path: Path) -> None:
    repo_path, tree = _init_repo(tmp_path)
    sha = _write_object(
        repo_path,
        "commit",
        _commit_body(tree, _spaces("author "), _VALID_COMMITTER),
    )
    _point(repo_path, "refs/heads/main", sha)
    repo = _open(repo_path)

    _assert_within_bound("git_log", lambda: git_log(repo, max_count=10))


def test_git_show_spaces_author_missing_date(tmp_path: Path) -> None:
    repo_path, tree = _init_repo(tmp_path)
    sha = _write_object(
        repo_path,
        "commit",
        _commit_body(tree, _spaces("author "), _VALID_COMMITTER),
    )
    _point(repo_path, "refs/heads/main", sha)
    repo = _open(repo_path)

    _assert_within_bound("git_show", lambda: git_show(repo, sha))


def test_git_log_spaces_committer_missing_date(tmp_path: Path) -> None:
    repo_path, tree = _init_repo(tmp_path)
    sha = _write_object(
        repo_path,
        "commit",
        _commit_body(tree, _VALID_AUTHOR, _spaces("committer ")),
    )
    _point(repo_path, "refs/heads/main", sha)
    repo = _open(repo_path)

    _assert_within_bound("git_log", lambda: git_log(repo, max_count=10))


def test_git_show_spaces_committer_missing_date(tmp_path: Path) -> None:
    repo_path, tree = _init_repo(tmp_path)
    sha = _write_object(
        repo_path,
        "commit",
        _commit_body(tree, _VALID_AUTHOR, _spaces("committer ")),
    )
    _point(repo_path, "refs/heads/main", sha)
    repo = _open(repo_path)

    _assert_within_bound("git_show", lambda: git_show(repo, sha))


def test_git_log_spaces_author_malformed_timezone(tmp_path: Path) -> None:
    repo_path, tree = _init_repo(tmp_path)
    author_line = _spaces("author ") + " <tester@example.com> 1700000000 ZZZZ"
    sha = _write_object(
        repo_path,
        "commit",
        _commit_body(tree, author_line, _VALID_COMMITTER),
    )
    _point(repo_path, "refs/heads/main", sha)
    repo = _open(repo_path)

    _assert_within_bound("git_log", lambda: git_log(repo, max_count=10))


def test_git_show_spaces_author_malformed_timezone(tmp_path: Path) -> None:
    repo_path, tree = _init_repo(tmp_path)
    author_line = _spaces("author ") + " <tester@example.com> 1700000000 ZZZZ"
    sha = _write_object(
        repo_path,
        "commit",
        _commit_body(tree, author_line, _VALID_COMMITTER),
    )
    _point(repo_path, "refs/heads/main", sha)
    repo = _open(repo_path)

    _assert_within_bound("git_show", lambda: git_show(repo, sha))


def test_git_log_malicious_author_on_ancestor(tmp_path: Path) -> None:
    repo_path, tree = _init_repo(tmp_path)
    parent = _write_object(
        repo_path,
        "commit",
        _commit_body(tree, _spaces("author "), _VALID_COMMITTER),
    )
    child = _git(repo_path, "commit-tree", tree, "-p", parent, "-m", "child")
    _point(repo_path, "refs/heads/main", child)
    repo = _open(repo_path)

    _assert_within_bound("git_log", lambda: git_log(repo, max_count=10))


def test_git_show_annotated_tag_spaces_tagger(tmp_path: Path) -> None:
    repo_path, tree = _init_repo(tmp_path)
    commit = _git(repo_path, "commit-tree", tree, "-m", "ok")
    _point(repo_path, "refs/heads/main", commit)
    tag_body = f"object {commit}\ntype commit\ntag vbad\n{_spaces('tagger ')}\n\nannotated\n"
    tag_sha = _write_object(repo_path, "tag", tag_body)
    _point(repo_path, "refs/tags/vbad", tag_sha)
    repo = _open(repo_path)

    _assert_within_bound("git_show", lambda: git_show(repo, "vbad"))


def test_git_log_long_valid_author_stays_fast(tmp_path: Path) -> None:
    repo_path, tree = _init_repo(tmp_path)
    author_line = "author " + ("A" * SPACE_RUN) + " <tester@example.com> 1700000000 +0000"
    sha = _write_object(
        repo_path,
        "commit",
        _commit_body(tree, author_line, _VALID_COMMITTER, message="valid-long-name"),
    )
    _point(repo_path, "refs/heads/main", sha)
    repo = _open(repo_path)

    started = time.perf_counter()
    log = git_log(repo, max_count=10)
    elapsed = time.perf_counter() - started

    assert elapsed < MAX_SECONDS, f"git_log took {elapsed:.2f}s (limit {MAX_SECONDS:.1f}s)"
    assert len(log) == 1
    assert sha in log[0]
    assert "valid-long-name" in log[0]


def test_git_show_long_valid_author_stays_fast(tmp_path: Path) -> None:
    repo_path, tree = _init_repo(tmp_path)
    author_line = "author " + ("A" * SPACE_RUN) + " <tester@example.com> 1700000000 +0000"
    sha = _write_object(
        repo_path,
        "commit",
        _commit_body(tree, author_line, _VALID_COMMITTER, message="valid-long-name"),
    )
    _point(repo_path, "refs/heads/main", sha)
    repo = _open(repo_path)

    started = time.perf_counter()
    shown = git_show(repo, sha)
    elapsed = time.perf_counter() - started

    assert elapsed < MAX_SECONDS, f"git_show took {elapsed:.2f}s (limit {MAX_SECONDS:.1f}s)"
    assert sha in shown
    assert "valid-long-name" in shown


def test_git_log_date_filter_still_parses_listed_commit(tmp_path: Path) -> None:
    """A since/until filter still parses every commit rev-list returns."""
    repo_path, tree = _init_repo(tmp_path)
    sha = _write_object(
        repo_path,
        "commit",
        _commit_body(tree, _spaces("author "), _VALID_COMMITTER),
    )
    _point(repo_path, "refs/heads/main", sha)
    repo = _open(repo_path)

    _assert_within_bound(
        "git_log",
        lambda: git_log(repo, max_count=10, start_timestamp="2000-01-01", end_timestamp="2099-01-01"),
    )
