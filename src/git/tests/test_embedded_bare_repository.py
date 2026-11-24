"""Spec for command execution via a bare repository committed inside an allowed repo.

A directory of ordinary files (HEAD, config, objects, refs, info/attributes, hooks)
is a git directory. The server accepts it as repo_path when it sits inside the
configured repository, then git trusts that directory's config and hooks.

These tests fail while that still runs a diff driver or a hook. They pass once
opening that directory no longer executes attacker-controlled commands. Refusal
and a diff that simply omits the driver are both acceptable, as long as the
marker file is never created.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# Isolate the fixture and the server from machine-wide git config so the
# default bare-repository discovery rules are what the test exercises.
_ISOLATED_GIT = {
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_SYSTEM": "/dev/null",
    "GIT_CONFIG_NOSYSTEM": "1",
}


def _git(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, **_ISOLATED_GIT},
    )


def _plant_and_clone(
    tmp_path: Path,
    marker: Path,
    *,
    textconv: bool = False,
    external_diff: bool = False,
    driver_command: bool = False,
    pre_commit_hook: bool = False,
    dirty_index: bool = False,
) -> tuple[Path, Path]:
    """Commit a bare repo under docs/fixture and return the clone plus that path.

    The clone is a fresh checkout, which is how the files arrive for someone
    who cloned or pulled the project. The marker path is embedded in the
    driver or hook so a run of that command creates the marker file.
    """
    origin = tmp_path / "origin"
    embedded = origin / "docs" / "fixture"
    work = tmp_path / "work"
    _git("-c", "init.defaultBranch=main", "init", str(origin))
    _git("-C", str(origin), "config", "user.email", "dev@example.com")
    _git("-C", str(origin), "config", "user.name", "Dev")
    embedded.mkdir(parents=True)
    _git("-c", "init.defaultBranch=main", "init", "--bare", str(embedded))

    work.mkdir()
    (work / "file.txt").write_text("one\n")
    git_dir = f"--git-dir={embedded}"
    work_tree = f"--work-tree={work}"
    _git(git_dir, work_tree, "add", "file.txt")
    _git(
        git_dir,
        work_tree,
        "-c",
        "user.email=dev@example.com",
        "-c",
        "user.name=Dev",
        "commit",
        "-m",
        "first",
    )
    if dirty_index:
        (work / "file.txt").write_text("two\n")
        _git(git_dir, work_tree, "add", "file.txt")

    # Local identity lets git commit inside the embedded repo without a
    # global gitconfig. The command under test is the hook or diff driver.
    _git(git_dir, "config", "user.email", "dev@example.com")
    _git(git_dir, "config", "user.name", "Dev")

    if textconv or driver_command:
        (embedded / "info").mkdir(exist_ok=True)
        (embedded / "info" / "attributes").write_text("* diff=planted\n")
    if textconv:
        _git(git_dir, "config", "diff.planted.textconv", f"echo ran >> {marker}")
    if driver_command:
        _git(git_dir, "config", "diff.planted.command", f"echo ran >> {marker}")
    if external_diff:
        _git(git_dir, "config", "diff.external", f"echo ran >> {marker}")
    if pre_commit_hook:
        hook = embedded / "hooks" / "pre-commit"
        hook.write_text(f"#!/bin/sh\necho ran >> {marker}\n")
        hook.chmod(0o755)

    _git("-C", str(origin), "add", "docs")
    _git("-C", str(origin), "commit", "-m", "add fixture")
    victim = tmp_path / "victim"
    _git("clone", str(origin), str(victim))
    return victim, victim / "docs" / "fixture"


async def _call_tool(
    repository: Path | None,
    tool: str,
    arguments: dict[str, object],
    errlog_path: Path,
) -> object:
    args = ["-m", "mcp_server_git"]
    if repository is not None:
        args.extend(["--repository", str(repository)])
    params = StdioServerParameters(
        command=sys.executable,
        args=args,
        env=_ISOLATED_GIT,
    )
    with errlog_path.open("w") as errlog:
        async with stdio_client(params, errlog=errlog) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                try:
                    return await session.call_tool(tool, arguments)
                except Exception as exc:  # refusal reaches the client as an error
                    return exc


def _assert_marker_absent(marker: Path, outcome: object) -> None:
    if marker.exists():
        pytest.fail(
            "attacker-controlled git command created "
            f"{marker} (contents: {marker.read_text()!r}); tool outcome: {outcome!r}"
        )


def test_staged_diff_of_embedded_bare_repo_does_not_run_textconv(
    tmp_path: Path,
) -> None:
    """git_diff_staged on the embedded bare repo must not run its textconv driver."""
    marker = tmp_path / "textconv-marker"
    victim, embedded = _plant_and_clone(
        tmp_path, marker, textconv=True, dirty_index=True
    )
    outcome = asyncio.run(
        _call_tool(
            victim,
            "git_diff_staged",
            {"repo_path": str(embedded)},
            tmp_path / "server-err.txt",
        )
    )
    _assert_marker_absent(marker, outcome)


def test_staged_diff_of_embedded_bare_repo_does_not_run_external_diff(
    tmp_path: Path,
) -> None:
    """git_diff_staged must not run diff.external from the embedded config."""
    marker = tmp_path / "external-marker"
    victim, embedded = _plant_and_clone(
        tmp_path, marker, external_diff=True, dirty_index=True
    )
    outcome = asyncio.run(
        _call_tool(
            victim,
            "git_diff_staged",
            {"repo_path": str(embedded)},
            tmp_path / "server-err.txt",
        )
    )
    _assert_marker_absent(marker, outcome)


def test_staged_diff_of_embedded_bare_repo_does_not_run_driver_command(
    tmp_path: Path,
) -> None:
    """git_diff_staged must not run a named diff driver's command."""
    marker = tmp_path / "driver-marker"
    victim, embedded = _plant_and_clone(
        tmp_path, marker, driver_command=True, dirty_index=True
    )
    outcome = asyncio.run(
        _call_tool(
            victim,
            "git_diff_staged",
            {"repo_path": str(embedded)},
            tmp_path / "server-err.txt",
        )
    )
    _assert_marker_absent(marker, outcome)


def test_commit_in_embedded_bare_repo_does_not_run_hooks(tmp_path: Path) -> None:
    """git_commit on the embedded bare repo must not run its pre-commit hook."""
    marker = tmp_path / "hook-marker"
    victim, embedded = _plant_and_clone(tmp_path, marker, pre_commit_hook=True)
    outcome = asyncio.run(
        _call_tool(
            victim,
            "git_commit",
            {"repo_path": str(embedded), "message": "untrusted"},
            tmp_path / "server-err.txt",
        )
    )
    _assert_marker_absent(marker, outcome)


def test_unrestricted_server_staged_diff_does_not_run_textconv(tmp_path: Path) -> None:
    """With no --repository, the same embedded path must not run textconv."""
    marker = tmp_path / "unrestricted-marker"
    _victim, embedded = _plant_and_clone(
        tmp_path, marker, textconv=True, dirty_index=True
    )
    outcome = asyncio.run(
        _call_tool(
            None,
            "git_diff_staged",
            {"repo_path": str(embedded)},
            tmp_path / "server-err.txt",
        )
    )
    _assert_marker_absent(marker, outcome)


def test_show_of_embedded_bare_repo_does_not_run_textconv(tmp_path: Path) -> None:
    """git_show diffs commits through plumbing that must not run textconv."""
    marker = tmp_path / "show-marker"
    victim, embedded = _plant_and_clone(
        tmp_path, marker, textconv=True, dirty_index=True
    )
    outcome = asyncio.run(
        _call_tool(
            victim,
            "git_show",
            {"repo_path": str(embedded), "revision": "main"},
            tmp_path / "server-err.txt",
        )
    )
    _assert_marker_absent(marker, outcome)


def test_unstaged_and_branch_diff_of_embedded_bare_repo_do_not_run_textconv(
    tmp_path: Path,
) -> None:
    """Work-tree diffs against the embedded bare repo must not run textconv."""
    marker = tmp_path / "worktree-marker"
    victim, embedded = _plant_and_clone(
        tmp_path, marker, textconv=True, dirty_index=True
    )
    for tool, arguments in (
        ("git_diff_unstaged", {"repo_path": str(embedded)}),
        ("git_diff", {"repo_path": str(embedded), "target": "HEAD"}),
    ):
        marker.unlink(missing_ok=True)
        outcome = asyncio.run(
            _call_tool(victim, tool, arguments, tmp_path / "server-err.txt")
        )
        _assert_marker_absent(marker, outcome)


def test_outer_repository_staged_diff_does_not_use_embedded_driver(
    tmp_path: Path,
) -> None:
    """A staged diff of the configured repository itself must ignore the nested driver."""
    marker = tmp_path / "outer-marker"
    victim, _embedded = _plant_and_clone(
        tmp_path, marker, textconv=True, dirty_index=True
    )
    outcome = asyncio.run(
        _call_tool(
            victim,
            "git_diff_staged",
            {"repo_path": str(victim)},
            tmp_path / "server-err.txt",
        )
    )
    _assert_marker_absent(marker, outcome)
