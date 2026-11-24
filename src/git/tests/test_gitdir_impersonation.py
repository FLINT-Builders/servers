"""Tracked files must not run as git hooks when the git server commits.

GitPython 3.1.54, locked in uv.lock, treats a directory that contains ordinary
files named ``gitdir``, ``commondir``, and ``HEAD`` as the git directory before
it considers the real ``.git`` directory. ``git_commit`` then calls
``repo.index.commit()``, and that runs ``hooks/pre-commit``, ``hooks/commit-msg``,
and ``hooks/post-commit`` from the mis-resolved directory.

Real git does not. A clone of a repository that tracks those files keeps its
git directory at ``.git``, and ``git commit`` does not execute the tracked
hooks. The server still does, including when ``--repository`` limits the tool
to that clone and when the impersonating files sit in a subdirectory the path
check allows.

These tests fail while that execution happens. They pass once committing
through the server no longer runs those tracked hooks. A refusal that still
runs a hook, or that runs it and then raises, is a failure.
"""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import git

from mcp_server_git.server import git_commit, validate_repo_path

HOOK_NAMES = ("pre-commit", "commit-msg", "post-commit")


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )


def _clone_with_tracked_hooks(
    tmp_path: Path, place: str
) -> tuple[Path, Path, dict[str, Path]]:
    """Build a repository the way a clone of attacker content arrives on disk.

    ``place`` is "" for files at the work tree root, or a relative directory
    inside the clone. The hooks append their name to marker files outside the
    repository. Setup uses the git binary, which keeps using the real ``.git``.
    """
    source = tmp_path / "source"
    source.mkdir()
    _git(source, "init", "-q", "-b", "master")
    _git(source, "config", "user.email", "attacker@example.com")
    _git(source, "config", "user.name", "Attacker")
    (source / "README.txt").write_text("hello\n")
    _git(source, "add", "README.txt")
    _git(source, "commit", "-q", "-m", "initial")

    base = source / place if place else source
    base.mkdir(parents=True, exist_ok=True)
    (base / "gitdir").write_text(".git\n")
    (base / "commondir").write_text(".git\n")
    (base / "HEAD").write_text("ref: refs/heads/master\n")
    hook_dir = base / "hooks"
    hook_dir.mkdir()
    markers = {name: tmp_path / f"hook-{name}" for name in HOOK_NAMES}
    for name, marker in markers.items():
        hook = hook_dir / name
        hook.write_text(f"#!/bin/sh\nprintf '%s\\n' {name} >> '{marker}'\n")
        hook.chmod(hook.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    _git(source, "add", "-A")
    _git(source, "commit", "-q", "-m", "track gitdir impersonation")
    for marker in markers.values():
        assert not marker.exists()

    cloned = tmp_path / "cloned"
    _git(tmp_path, "clone", "-q", str(source), str(cloned))
    return cloned, cloned / place if place else cloned, markers


def _real_git_dir(path: Path) -> Path:
    completed = subprocess.run(
        ["git", "rev-parse", "--absolute-git-dir"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    )
    return Path(completed.stdout.strip())


def _commit_as_server(repo_path: Path, allowed: Path | None) -> None:
    """Same steps ``call_tool`` takes for ``git_commit``."""
    validate_repo_path(repo_path, allowed)
    repo = git.Repo(repo_path)
    git_commit(repo, "commit from the git server")


def _assert_tracked_hooks_do_not_run(
    repo_path: Path,
    allowed: Path | None,
    markers: dict[str, Path],
) -> None:
    for name in HOOK_NAMES:
        hook = repo_path / "hooks" / name
        assert hook.is_file()
        assert os.access(hook, os.X_OK)
        assert not markers[name].exists()

    # index.commit runs hooks before it writes the commit, and a fixed GitPython
    # rejects the impersonated directory with its own exception type. The result
    # that matters is whether a tracked hook ran, whatever the call raises.
    refusal: BaseException | None = None
    try:
        _commit_as_server(repo_path, allowed)
    except Exception as exc:  # noqa: BLE001
        refusal = exc

    fired = [name for name, marker in markers.items() if marker.exists()]
    assert fired == [], f"tracked hooks ran ({refusal!r})"


def test_git_commit_does_not_execute_tracked_hooks_at_repository_root(
    tmp_path: Path,
) -> None:
    cloned, repo_path, markers = _clone_with_tracked_hooks(tmp_path, "")
    assert _real_git_dir(repo_path) == (cloned / ".git").resolve()
    _assert_tracked_hooks_do_not_run(repo_path, cloned, markers)


def test_git_commit_does_not_execute_tracked_hooks_in_allowed_subdirectory(
    tmp_path: Path,
) -> None:
    cloned, repo_path, markers = _clone_with_tracked_hooks(tmp_path, "nested")
    assert repo_path == cloned / "nested"
    assert _real_git_dir(repo_path) == (cloned / ".git").resolve()
    # The subdirectory is inside the repository the server was given.
    validate_repo_path(repo_path, cloned)
    _assert_tracked_hooks_do_not_run(repo_path, cloned, markers)
