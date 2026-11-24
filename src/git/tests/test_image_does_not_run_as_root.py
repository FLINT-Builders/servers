"""The git server image must not write the bind-mounted project as root.

The published Docker example bind-mounts a host directory into a container whose
entrypoint is `mcp-server-git`. These tests drive that entrypoint over stdio and
require every file the tools create, and every hook or filter they execute, to
run as a non-root uid.

They fail while the image's entrypoint is still root.
"""

from __future__ import annotations

import json
import os
import select
import shutil
import subprocess
from pathlib import Path

import pytest

IMAGE = "mcp-git-root-test:local"
PROTOCOL = "2024-11-05"


def _docker() -> list[str]:
    if shutil.which("docker"):
        probe = subprocess.run(
            ["docker", "info"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if probe.returncode == 0:
            return ["docker"]
    probe = subprocess.run(
        ["sudo", "-n", "docker", "info"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if probe.returncode == 0:
        return ["sudo", "-n", "docker"]
    pytest.fail("docker is required to run the git server image")


@pytest.fixture(scope="session")
def image() -> str:
    context = Path(__file__).resolve().parents[1]
    build = subprocess.run(
        [*_docker(), "build", "-t", IMAGE, str(context)],
        capture_output=True,
        text=True,
    )
    if build.returncode != 0:
        pytest.fail("docker build failed:\n" + build.stderr[-4000:])
    return IMAGE


@pytest.fixture(scope="session")
def app_uid(image: str) -> int:
    result = subprocess.run(
        [*_docker(), "run", "--rm", "--entrypoint", "id", image, "-u", "app"],
        check=True,
        capture_output=True,
        text=True,
    )
    return int(result.stdout.strip())


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def _init_repo(path: Path) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-b", "main")
    _git(path, "config", "user.email", "test@example.com")
    _git(path, "config", "user.name", "test")
    (path / "README").write_text("base\n")
    _git(path, "add", "README")
    _git(path, "commit", "-m", "init")
    return path


def _chown(path: Path, uid: int) -> None:
    subprocess.run(["sudo", "-n", "chown", "-R", f"{uid}:{uid}", str(path)], check=True)


def _write_hook(repo: Path, name: str, body: str) -> None:
    hook = repo / ".git" / "hooks" / name
    hook.write_text(body)
    hook.chmod(0o755)


def _install_id_recorder(repo: Path, filename: str, textconv: bool) -> Path:
    """Filter/textconv helper on the mount. It records the uid then passes data through."""
    script = repo / filename
    if textconv:
        script.write_text(
            "#!/bin/sh\n"
            f"id -u > '{repo / (filename + '.uid')}'\n"
            'cat "$1"\n'
        )
    else:
        script.write_text(
            "#!/bin/sh\n"
            f"id -u > '{repo / (filename + '.uid')}'\n"
            "cat\n"
        )
    script.chmod(0o755)
    return repo / (filename + ".uid")


def _configure_filters(repo: Path) -> dict[str, Path]:
    smudge_uid = _install_id_recorder(repo, ".probe-smudge", textconv=False)
    clean_uid = _install_id_recorder(repo, ".probe-clean", textconv=False)
    textconv_uid = _install_id_recorder(repo, ".probe-textconv", textconv=True)
    config = (
        "\n[filter \"probe\"]\n"
        f"\tsmudge = {repo / '.probe-smudge'}\n"
        f"\tclean = {repo / '.probe-clean'}\n"
        "\trequired = true\n"
        "[diff \"probe\"]\n"
        f"\ttextconv = {repo / '.probe-textconv'}\n"
    )
    gitconfig = repo / ".git" / "config"
    gitconfig.write_text(gitconfig.read_text() + config)
    (repo / ".gitattributes").write_text("*.txt filter=probe diff=probe\n")
    return {"smudge": smudge_uid, "clean": clean_uid, "textconv": textconv_uid}


class McpGit:
    def __init__(self, image: str, repo: Path):
        self.proc = subprocess.Popen(
            [
                *_docker(),
                "run",
                "--rm",
                "-i",
                "--mount",
                f"type=bind,src={repo},dst={repo}",
                image,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._next_id = 1
        self._initialize()

    def _read_message(self, timeout: float = 60) -> dict:
        assert self.proc.stdout is not None
        ready, _, _ = select.select([self.proc.stdout], [], [], timeout)
        if not ready:
            stderr = b""
            if self.proc.stderr is not None:
                stderr = self.proc.stderr.read()
            raise TimeoutError(stderr.decode(errors="replace"))
        line = self.proc.stdout.readline()
        if not line:
            raise EOFError("git server closed stdout")
        return json.loads(line)

    def _request(self, method: str, params: dict | None = None) -> dict:
        assert self.proc.stdin is not None
        message_id = self._next_id
        self._next_id += 1
        payload = {"jsonrpc": "2.0", "id": message_id, "method": method}
        if params is not None:
            payload["params"] = params
        self.proc.stdin.write((json.dumps(payload) + "\n").encode())
        self.proc.stdin.flush()
        while True:
            message = self._read_message()
            if message.get("id") == message_id:
                return message

    def _notify(self, method: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps({"jsonrpc": "2.0", "method": method}) + "\n").encode())
        self.proc.stdin.flush()

    def _initialize(self) -> None:
        response = self._request(
            "initialize",
            {
                "protocolVersion": PROTOCOL,
                "capabilities": {},
                "clientInfo": {"name": "image-uid-test", "version": "0"},
            },
        )
        assert "result" in response, response
        self._notify("notifications/initialized")

    def call(self, name: str, arguments: dict) -> dict:
        response = self._request("tools/call", {"name": name, "arguments": arguments})
        assert "result" in response, response
        return response["result"]

    def close(self) -> None:
        if self.proc.stdin is not None:
            self.proc.stdin.close()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def _tool_text(result: dict) -> str:
    content = result.get("content") or []
    if not content:
        return ""
    return str(content[0].get("text", ""))


def _assert_no_root_owned(root: Path) -> None:
    owned = []
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames + filenames:
            path = Path(dirpath) / name
            try:
                uid = path.lstat().st_uid
            except FileNotFoundError:
                continue
            if uid == 0:
                owned.append(str(path))
    assert owned == [], f"root-owned paths on the mount: {owned}"


def _read_uid_file(path: Path) -> int:
    assert path.is_file(), f"expected uid record at {path}"
    recorded = path.read_text().strip()
    assert recorded.isdigit(), recorded
    uid = int(recorded)
    assert uid != 0, f"{path} recorded uid 0"
    assert path.stat().st_uid != 0, f"{path} is root-owned"
    return uid


def test_commit_on_user_owned_mount_does_not_write_as_root(image: str, tmp_path: Path) -> None:
    """README-style mount: the host user owns the repo. git_commit must not leave uid 0 files."""
    repo = _init_repo(tmp_path / "repo")
    (repo / "README").write_text("base\ndirty\n")
    _git(repo, "add", "README")
    # The work tree directory is writable by the image account so a dropped-privilege
    # hook can record its uid. .git stays owned by the host user.
    repo.chmod(0o777)
    _write_hook(
        repo,
        "pre-commit",
        "#!/bin/sh\n" f"id -u > '{repo / 'pre-commit-uid.txt'}'\nexit 0\n",
    )

    client = McpGit(image, repo)
    try:
        client.call("git_commit", {"repo_path": str(repo), "message": "from tool"})
    finally:
        client.close()

    # pre-commit runs before GitPython writes .git, so it executes even when the
    # mounted .git directory is not writable by the image account.
    _read_uid_file(repo / "pre-commit-uid.txt")
    _assert_no_root_owned(repo)


def test_checkout_of_root_owned_repo_does_not_write_worktree_as_root(image: str, tmp_path: Path) -> None:
    """When Git accepts the repo (it is owned by uid 0), checkout must not create uid 0 worktree files."""
    repo = _init_repo(tmp_path / "repo")
    _git(repo, "checkout", "-b", "other")
    (repo / "newfile.txt").write_text("created on other\n")
    (repo / "subdir").mkdir()
    (repo / "subdir" / "a.txt").write_text("nested\n")
    _git(repo, "add", "newfile.txt", "subdir/a.txt")
    _git(repo, "commit", "-m", "other")
    _git(repo, "checkout", "main")
    assert not (repo / "newfile.txt").exists()
    _chown(repo, 0)

    client = McpGit(image, repo)
    try:
        client.call("git_checkout", {"repo_path": str(repo), "branch_name": "other"})
    finally:
        client.close()

    for relative in ("newfile.txt", "subdir", "subdir/a.txt"):
        path = repo / relative
        assert not path.exists() or path.stat().st_uid != 0, f"{path} is root-owned"


def test_checkout_filter_and_hook_use_image_user(image: str, app_uid: int, tmp_path: Path) -> None:
    """Repo owned by the image's app account: checkout must succeed and its hook and smudge filter must not be root."""
    repo = _init_repo(tmp_path / "repo")
    probes = _configure_filters(repo)
    (repo / "tracked.txt").write_text("v1\n")
    _git(repo, "add", ".gitattributes", "tracked.txt")
    _git(repo, "commit", "-m", "tracked")
    _git(repo, "checkout", "-b", "other")
    (repo / "tracked.txt").write_text("v2\n")
    (repo / "added.txt").write_text("added\n")
    _git(repo, "add", "tracked.txt", "added.txt")
    _git(repo, "commit", "-m", "other")
    _git(repo, "checkout", "main")
    for stale in probes.values():
        if stale.exists():
            stale.unlink()
    _write_hook(
        repo,
        "post-checkout",
        "#!/bin/sh\n" f"id -u > '{repo / 'post-checkout-uid.txt'}'\n",
    )
    _chown(repo, app_uid)

    client = McpGit(image, repo)
    try:
        result = client.call("git_checkout", {"repo_path": str(repo), "branch_name": "other"})
    finally:
        client.close()

    assert not result.get("isError"), _tool_text(result)
    added = repo / "added.txt"
    assert added.is_file()
    assert added.stat().st_uid == app_uid
    _read_uid_file(repo / "post-checkout-uid.txt")
    _read_uid_file(probes["smudge"])
    _assert_no_root_owned(repo)


def test_add_clean_filter_uses_image_user(image: str, app_uid: int, tmp_path: Path) -> None:
    repo = _init_repo(tmp_path / "repo")
    probes = _configure_filters(repo)
    (repo / "tracked.txt").write_text("v1\n")
    _git(repo, "add", ".gitattributes", "tracked.txt")
    _git(repo, "commit", "-m", "tracked")
    if probes["clean"].exists():
        probes["clean"].unlink()
    (repo / "tracked.txt").write_text("v1\ndirty\n")
    _chown(repo, app_uid)

    client = McpGit(image, repo)
    try:
        result = client.call("git_add", {"repo_path": str(repo), "files": ["tracked.txt"]})
    finally:
        client.close()

    assert not result.get("isError"), _tool_text(result)
    assert _read_uid_file(probes["clean"]) == app_uid
    _assert_no_root_owned(repo)


def test_diff_textconv_uses_image_user(image: str, app_uid: int, tmp_path: Path) -> None:
    repo = _init_repo(tmp_path / "repo")
    probes = _configure_filters(repo)
    (repo / "tracked.txt").write_text("v1\n")
    _git(repo, "add", ".gitattributes", "tracked.txt")
    _git(repo, "commit", "-m", "tracked")
    _git(repo, "checkout", "-b", "other")
    (repo / "tracked.txt").write_text("v2\n")
    _git(repo, "add", "tracked.txt")
    _git(repo, "commit", "-m", "other")
    (repo / "tracked.txt").write_text("unstaged\n")
    if probes["textconv"].exists():
        probes["textconv"].unlink()
    _chown(repo, app_uid)

    client = McpGit(image, repo)
    try:
        unstaged = client.call("git_diff_unstaged", {"repo_path": str(repo)})
        staged = client.call("git_diff_staged", {"repo_path": str(repo)})
        result = client.call("git_diff", {"repo_path": str(repo), "target": "main"})
    finally:
        client.close()

    assert not unstaged.get("isError"), _tool_text(unstaged)
    assert not staged.get("isError"), _tool_text(staged)
    assert not result.get("isError"), _tool_text(result)
    assert _read_uid_file(probes["textconv"]) == app_uid
    _assert_no_root_owned(repo)


def test_commit_on_image_user_repo_succeeds_without_root(image: str, app_uid: int, tmp_path: Path) -> None:
    repo = _init_repo(tmp_path / "repo")
    (repo / "README").write_text("base\ndirty\n")
    _git(repo, "add", "README")
    for name in ("pre-commit", "commit-msg", "post-commit"):
        _write_hook(
            repo,
            name,
            "#!/bin/sh\n" f"id -u > '{repo / (name + '-uid.txt')}'\nexit 0\n",
        )
    _chown(repo, app_uid)

    client = McpGit(image, repo)
    try:
        result = client.call("git_commit", {"repo_path": str(repo), "message": "from tool"})
    finally:
        client.close()

    assert not result.get("isError"), _tool_text(result)
    for name in ("pre-commit", "commit-msg", "post-commit"):
        assert _read_uid_file(repo / f"{name}-uid.txt") == app_uid
    _assert_no_root_owned(repo)
    head = subprocess.run(
        [
            "sudo",
            "-n",
            "git",
            "-C",
            str(repo),
            "-c",
            "safe.directory=*",
            "log",
            "-1",
            "--format=%s",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert head.stdout.strip() == "from tool"


def test_create_branch_uses_image_user(image: str, app_uid: int, tmp_path: Path) -> None:
    repo = _init_repo(tmp_path / "repo")
    _chown(repo, app_uid)

    client = McpGit(image, repo)
    try:
        result = client.call(
            "git_create_branch",
            {"repo_path": str(repo), "branch_name": "feature"},
        )
    finally:
        client.close()

    assert not result.get("isError"), _tool_text(result)
    ref = repo / ".git" / "refs" / "heads" / "feature"
    assert ref.is_file()
    assert ref.stat().st_uid == app_uid
    _assert_no_root_owned(repo)


def test_reset_uses_image_user(image: str, app_uid: int, tmp_path: Path) -> None:
    repo = _init_repo(tmp_path / "repo")
    (repo / "README").write_text("base\ndirty\n")
    _git(repo, "add", "README")
    _chown(repo, app_uid)

    client = McpGit(image, repo)
    try:
        result = client.call("git_reset", {"repo_path": str(repo)})
    finally:
        client.close()

    assert not result.get("isError"), _tool_text(result)
    index = repo / ".git" / "index"
    assert index.is_file()
    assert index.stat().st_uid == app_uid
    _assert_no_root_owned(repo)


def test_root_owned_checkout_does_not_run_smudge_as_root(image: str, tmp_path: Path) -> None:
    """A checkout Git is willing to run must not execute its smudge filter as root."""
    repo = _init_repo(tmp_path / "repo")
    probes = _configure_filters(repo)
    (repo / "tracked.txt").write_text("v1\n")
    _git(repo, "add", ".gitattributes", "tracked.txt")
    _git(repo, "commit", "-m", "tracked")
    _git(repo, "checkout", "-b", "other")
    (repo / "tracked.txt").write_text("v2\n")
    _git(repo, "add", "tracked.txt")
    _git(repo, "commit", "-m", "other")
    _git(repo, "checkout", "main")
    for stale in probes.values():
        if stale.exists():
            stale.unlink()
    _chown(repo, 0)

    client = McpGit(image, repo)
    try:
        client.call("git_checkout", {"repo_path": str(repo), "branch_name": "other"})
    finally:
        client.close()

    smudge = probes["smudge"]
    if smudge.exists():
        _read_uid_file(smudge)
