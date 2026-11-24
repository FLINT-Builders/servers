"""Agent checkout and commit must not run repository hooks.

These tests fail while git_checkout and git_commit execute hook scripts.
They pass once those operations skip repository hooks.

The repository layout is the one an in-tree hooks directory uses: local
core.hooksPath points at a tracked directory, and another branch replaces
the script in that directory. The marker and sentinel files live outside
the repository. A hook that creates or deletes either file is a failure
even when the hook then exits non-zero and the operation raises.
"""

from pathlib import Path

import git

from mcp_server_git.server import git_checkout, git_commit


def _init_repo(path: Path) -> git.Repo:
    repo = git.Repo.init(path)
    with repo.config_writer() as writer:
        writer.set_value("user", "name", "Hook Test")
        writer.set_value("user", "email", "hook-test@example.com")
    readme = path / "README"
    readme.write_text("base\n")
    repo.index.add(["README"])
    repo.index.commit("initial")
    return repo


def _write_hook(
    hooks_dir: Path,
    name: str,
    marker: Path,
    sentinel: Path,
    *,
    token: str,
    reject: bool,
) -> None:
    hooks_dir.mkdir(parents=True, exist_ok=True)
    script = hooks_dir / name
    # The script is the attacker-controlled file. It records that it ran and
    # deletes a file before it exits, including when it rejects the operation.
    script.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' {token} >> '{marker}'\n"
        f"rm -f '{sentinel}'\n"
        f"exit {1 if reject else 0}\n"
    )
    script.chmod(0o755)


def _call(func, *args):
    try:
        return func(*args), None
    except Exception as exc:  # noqa: BLE001 - a hook side effect still fails the test when the call raises
        return None, exc


def _commit_paths(repo: git.Repo, paths: list[str], message: str) -> None:
    repo.index.add(paths)
    # Setup commits must not depend on the product function under test.
    # hooksPath is not configured yet, so the default hook directory is empty.
    repo.index.commit(message)


def _assert_hook_did_not_run(marker: Path, sentinel: Path) -> None:
    recorded = marker.read_text() if marker.exists() else ""
    sentinel_text = sentinel.read_text() if sentinel.exists() else "<deleted>"
    assert not marker.exists(), (
        f"repository hook ran and wrote: {recorded!r}; sentinel is {sentinel_text!r}"
    )
    assert sentinel_text == "keep\n", "repository hook deleted a file"


def test_git_checkout_does_not_execute_hook_from_checked_out_branch(
    tmp_path: Path,
) -> None:
    repo_path = tmp_path / "repo"
    repo = _init_repo(repo_path)
    marker = tmp_path / "checkout-hook-ran"
    sentinel = tmp_path / "checkout-sentinel"
    sentinel.write_text("keep\n")
    source = repo.active_branch.name

    _write_hook(
        repo_path / ".husky",
        "post-checkout",
        marker,
        sentinel,
        token="source-post-checkout",
        reject=False,
    )
    _commit_paths(repo, [".husky/post-checkout"], "source hook")

    repo.git.checkout("-b", "attacker")
    _write_hook(
        repo_path / ".husky",
        "post-checkout",
        marker,
        sentinel,
        token="attacker-post-checkout",
        reject=False,
    )
    _commit_paths(repo, [".husky/post-checkout"], "attacker hook")
    repo.git.checkout(source)

    repo.git.config("core.hooksPath", ".husky")
    configured = repo.git.config("core.hooksPath")
    marker.unlink(missing_ok=True)
    sentinel.write_text("keep\n")

    result, error = _call(git_checkout, repo, "attacker")

    _assert_hook_did_not_run(marker, sentinel)
    assert error is None
    assert result == "Switched to branch 'attacker'"
    assert repo.active_branch.name == "attacker"
    assert repo.git.config("core.hooksPath") == configured
    hooked = (repo_path / ".husky" / "post-checkout").read_text()
    assert "attacker-post-checkout" in hooked
    assert "source-post-checkout" not in hooked


def test_git_checkout_rejecting_hook_has_no_side_effect(tmp_path: Path) -> None:
    repo_path = tmp_path / "repo"
    repo = _init_repo(repo_path)
    marker = tmp_path / "checkout-reject-hook-ran"
    sentinel = tmp_path / "checkout-reject-sentinel"
    sentinel.write_text("keep\n")
    source = repo.active_branch.name

    _write_hook(
        repo_path / ".husky",
        "post-checkout",
        marker,
        sentinel,
        token="source-post-checkout",
        reject=False,
    )
    _commit_paths(repo, [".husky/post-checkout"], "source hook")
    repo.git.checkout("-b", "attacker")
    _write_hook(
        repo_path / ".husky",
        "post-checkout",
        marker,
        sentinel,
        token="attacker-post-checkout",
        reject=True,
    )
    _commit_paths(repo, [".husky/post-checkout"], "attacker rejecting hook")
    repo.git.checkout(source)

    repo.git.config("core.hooksPath", ".husky")
    marker.unlink(missing_ok=True)
    sentinel.write_text("keep\n")

    result, error = _call(git_checkout, repo, "attacker")

    _assert_hook_did_not_run(marker, sentinel)
    assert error is None
    assert result == "Switched to branch 'attacker'"
    assert repo.active_branch.name == "attacker"


def test_git_commit_does_not_execute_configured_hooks(tmp_path: Path) -> None:
    repo_path = tmp_path / "repo"
    repo = _init_repo(repo_path)
    marker = tmp_path / "commit-hook-ran"
    sentinel = tmp_path / "commit-sentinel"
    sentinel.write_text("keep\n")
    hooks = repo_path / ".husky"
    for name in ("pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"):
        _write_hook(hooks, name, marker, sentinel, token=name, reject=False)
    _commit_paths(
        repo,
        [
            ".husky/pre-commit",
            ".husky/prepare-commit-msg",
            ".husky/commit-msg",
            ".husky/post-commit",
        ],
        "add hooks",
    )
    repo.git.config("core.hooksPath", ".husky")
    configured = repo.git.config("core.hooksPath")
    marker.unlink(missing_ok=True)
    sentinel.write_text("keep\n")

    (repo_path / "README").write_text("agent change\n")
    repo.index.add(["README"])
    message = "agent commit"
    result, error = _call(git_commit, repo, message)

    _assert_hook_did_not_run(marker, sentinel)
    assert error is None
    assert result.startswith("Changes committed successfully with hash ")
    assert repo.head.commit.message.strip() == message
    assert repo.git.config("core.hooksPath") == configured


def test_git_commit_rejecting_hook_has_no_side_effect(tmp_path: Path) -> None:
    repo_path = tmp_path / "repo"
    repo = _init_repo(repo_path)
    marker = tmp_path / "commit-reject-hook-ran"
    sentinel = tmp_path / "commit-reject-sentinel"
    sentinel.write_text("keep\n")
    _write_hook(
        repo_path / ".husky",
        "pre-commit",
        marker,
        sentinel,
        token="rejecting-pre-commit",
        reject=True,
    )
    _commit_paths(repo, [".husky/pre-commit"], "add rejecting hook")
    repo.git.config("core.hooksPath", ".husky")
    marker.unlink(missing_ok=True)
    sentinel.write_text("keep\n")
    parent = repo.head.commit.hexsha

    (repo_path / "README").write_text("agent change\n")
    repo.index.add(["README"])
    result, error = _call(git_commit, repo, "agent commit despite hook")

    _assert_hook_did_not_run(marker, sentinel)
    assert error is None
    assert result.startswith("Changes committed successfully with hash ")
    assert repo.head.commit.hexsha != parent
    assert repo.head.commit.message.strip() == "agent commit despite hook"
