"""Commit author and committer parsing must stay fast.

git_log and git_show print commit.author. GitPython loads that attribute by
reading the raw commit and parsing both the author and committer idents.
An ident that contains "<" and no closing ">" is still a commit object git
will store (git hash-object --literally) and clone without fsck. Parsing it
must finish on a linear scan of the ident, within the budget below.

No other tool in this server reads a commit author or committer. GitPython's
blame and co-author helpers are not called here and are not covered.
"""

import os
import subprocess
import time
from pathlib import Path

import git
import pytest

from mcp_server_git.server import git_log, git_show

# " <" repeated this many times has no closing ">". A linear scan of that
# ident is far below the budget; backtracking over it is not.
UNTERMINATED_ANGLE_REPEATS = 1200
PARSE_BUDGET_SECONDS = 0.5
BENIGN_IDENT = "Ada Lovelace <ada@example.com>"


def _unterminated_ident() -> str:
    return " <" * UNTERMINATED_ANGLE_REPEATS


def _write_commit(repo_path: Path, author: str, committer: str) -> str:
    """Store one commit object whose idents are exactly the given strings."""
    file_path = repo_path / "readme.txt"
    file_path.write_text("hello\n")
    env = os.environ.copy()
    env.update(
        {
            "GIT_AUTHOR_NAME": "Setup",
            "GIT_AUTHOR_EMAIL": "setup@example.com",
            "GIT_COMMITTER_NAME": "Setup",
            "GIT_COMMITTER_EMAIL": "setup@example.com",
        }
    )
    subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "init", "-q", "-b", "main"],
        cwd=repo_path,
        check=True,
        env=env,
    )
    subprocess.run(["git", "add", "readme.txt"], cwd=repo_path, check=True, env=env)
    subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"],
        cwd=repo_path,
        check=True,
        env=env,
    )
    tree = subprocess.check_output(
        ["git", "rev-parse", "HEAD^{tree}"], cwd=repo_path, text=True
    ).strip()
    raw = (
        f"tree {tree}\n"
        f"author {author} 1700000000 +0000\n"
        f"committer {committer} 1700000000 +0000\n"
        "\n"
        "crafted\n"
    ).encode()
    sha = subprocess.check_output(
        ["git", "hash-object", "-t", "commit", "-w", "--literally", "--stdin"],
        cwd=repo_path,
        input=raw,
    ).decode().strip()
    subprocess.run(
        ["git", "update-ref", "refs/heads/main", sha],
        cwd=repo_path,
        check=True,
    )
    return sha


def _read(operation: str, repo: git.Repo, sha: str) -> str:
    if operation == "git_log":
        return "".join(git_log(repo, max_count=1))
    if operation == "git_show":
        return git_show(repo, sha)
    raise AssertionError(operation)


@pytest.mark.parametrize("operation", ["git_log", "git_show"])
@pytest.mark.parametrize("poisoned_field", ["author", "committer"])
def test_unterminated_ident_is_read_within_budget(
    tmp_path: Path, operation: str, poisoned_field: str
) -> None:
    malicious = _unterminated_ident()
    author = malicious if poisoned_field == "author" else BENIGN_IDENT
    committer = malicious if poisoned_field == "committer" else BENIGN_IDENT
    repo_path = tmp_path / "repo"
    repo_path.mkdir()
    sha = _write_commit(repo_path, author, committer)
    repo = git.Repo(repo_path)
    try:
        started = time.perf_counter()
        text = _read(operation, repo, sha)
        elapsed = time.perf_counter() - started
    finally:
        repo.close()

    assert elapsed < PARSE_BUDGET_SECONDS
    assert sha in text
    assert "Author:" in text
    if poisoned_field == "author":
        assert " < <" in text
    else:
        assert "Ada Lovelace" in text


def test_ordinary_ident_is_read_within_budget(tmp_path: Path) -> None:
    repo_path = tmp_path / "repo"
    repo_path.mkdir()
    sha = _write_commit(repo_path, BENIGN_IDENT, BENIGN_IDENT)
    repo = git.Repo(repo_path)
    try:
        started = time.perf_counter()
        log_text = _read("git_log", repo, sha)
        log_elapsed = time.perf_counter() - started
        started = time.perf_counter()
        show_text = _read("git_show", repo, sha)
        show_elapsed = time.perf_counter() - started
    finally:
        repo.close()

    assert log_elapsed < PARSE_BUDGET_SECONDS
    assert show_elapsed < PARSE_BUDGET_SECONDS
    assert sha in log_text
    assert sha in show_text
    assert "Ada Lovelace" in log_text
    assert "Ada Lovelace" in show_text
