"""Checkout must not request a Git LFS URL configured by the branch being checked out.

The published image runs `git lfs install --system`, which enables the LFS
smudge and process filters for every repository. `git_checkout` then runs
`git checkout` with those filters. A branch can commit `.gitattributes` and
`.lfsconfig` so that checkout downloads file contents from whatever URL the
branch names.

These tests install that same system filter configuration, point `.lfsconfig`
at a local listener, and call `git_checkout`. They fail while checkout
contacts that URL. Other tools were exercised against the same repository and
did not contact it: git_status, git_diff_unstaged, git_diff_staged, git_diff,
git_add, git_commit, git_reset, git_log, git_create_branch, git_show, and
git_branch.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import cast
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import git
import pytest

from mcp_server_git.server import git_checkout

PAYLOAD = b"lfs-object-body"
OID = hashlib.sha256(PAYLOAD).hexdigest()
POINTER = (
    "version https://git-lfs.github.com/spec/v1\n"
    f"oid sha256:{OID}\n"
    f"size {len(PAYLOAD)}\n"
)


class RecordingServer(ThreadingHTTPServer):
    hits: list[tuple[str, str]]
    port: int

    def __init__(self, server_address: tuple[str, int], request_handler: type[BaseHTTPRequestHandler]) -> None:
        super().__init__(server_address, request_handler)
        self.hits = []
        _host, self.port = cast(tuple[str, int], self.server_address)


class RecordingHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        return

    def _record(self, method: str) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        if length:
            self.rfile.read(length)
        server = self.server
        if isinstance(server, RecordingServer):
            server.hits.append((method, self.path))

    def do_POST(self) -> None:
        self._record("POST")
        server = self.server
        port = server.port if isinstance(server, RecordingServer) else 0
        body = (
            '{"transfer":"basic","objects":[{"oid":"%s","size":%d,'
            '"actions":{"download":{"href":"http://127.0.0.1:%d/object"}}}]}\n'
            % (OID, len(PAYLOAD), port)
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.git-lfs+json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        self._record("GET")
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.end_headers()
        self.wfile.write(PAYLOAD)


@contextmanager
def recording_listener() -> Iterator[RecordingServer]:
    server = RecordingServer(("127.0.0.1", 0), RecordingHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def isolate_git_config(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Use a private system and global git config, then enable LFS like the image."""
    home = tmp_path / "home"
    home.mkdir()
    system_config = tmp_path / "system.gitconfig"
    global_config = tmp_path / "global.gitconfig"
    system_config.write_text("")
    global_config.write_text("")

    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / "xdg"))
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", str(system_config))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    monkeypatch.delenv("GIT_LFS_SKIP_SMUDGE", raising=False)
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    for name in list(os.environ):
        if name.startswith("GIT_CONFIG_") and name not in ("GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL"):
            monkeypatch.delenv(name, raising=False)

    if subprocess.call(["git", "lfs", "version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
        pytest.fail("git-lfs is not installed; the git server image installs it")

    subprocess.check_call(
        ["git", "lfs", "install", "--system", "--skip-repo", "--force"],
        stdout=subprocess.DEVNULL,
    )
    installed = system_config.read_text()
    # The image's `git lfs install --system` enables download filters, not --skip.
    assert "smudge = git-lfs smudge -- %f\n" in installed
    assert "process = git-lfs filter-process\n" in installed
    assert "--skip" not in installed
    return system_config


def commit_lfs_branch(repo_path: Path, lfs_url: str) -> tuple[git.Repo, str, str]:
    """Return a repo on its safe branch, plus the LFS branch name and its commit."""
    repo = git.Repo.init(repo_path)
    repo.git.config("user.email", "tester@example.com")
    repo.git.config("user.name", "Tester")
    (repo_path / "README").write_text("safe\n")
    repo.index.add(["README"])
    repo.index.commit("initial")
    safe_branch = repo.active_branch.name

    repo.git.checkout("-b", "attacker")
    (repo_path / ".gitattributes").write_text(
        "payload.bin filter=lfs diff=lfs merge=lfs -text\n"
    )
    (repo_path / ".lfsconfig").write_text(f"[lfs]\n\turl = {lfs_url}\n")
    (repo_path / "payload.bin").write_text(POINTER)
    repo.index.add([".gitattributes", ".lfsconfig", "payload.bin"])
    repo.index.commit("point lfs at a chosen url")
    attacked = repo.head.commit.hexsha
    repo.git.checkout(safe_branch)
    return repo, "attacker", attacked


def assert_checkout_does_not_fetch(repo: git.Repo, revision: str, repo_path: Path, hits: list[tuple[str, str]]) -> None:
    assert hits == [], f"setup requested the LFS URL before checkout: {hits}"
    result = git_checkout(repo, revision)
    assert result == f"Switched to branch '{revision}'"
    assert hits == [], f"git_checkout contacted the LFS URL from the revision: {hits}"
    checked_out = (repo_path / "payload.bin").read_bytes()
    assert checked_out != PAYLOAD
    assert checked_out.decode() == POINTER


def test_image_does_not_enable_git_lfs_filters() -> None:
    dockerfile = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text()
    assert "git lfs install" not in dockerfile


def test_git_checkout_branch_does_not_fetch_configured_lfs_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    isolate_git_config(monkeypatch, tmp_path)
    with recording_listener() as server:
        port = server.server_address[1]
        repo_path = tmp_path / "repo"
        repo, branch, _sha = commit_lfs_branch(repo_path, f"http://127.0.0.1:{port}")
        assert_checkout_does_not_fetch(repo, branch, repo_path, server.hits)


def test_git_checkout_commit_does_not_fetch_configured_lfs_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    isolate_git_config(monkeypatch, tmp_path)
    with recording_listener() as server:
        port = server.server_address[1]
        repo_path = tmp_path / "repo"
        repo, _branch, sha = commit_lfs_branch(repo_path, f"http://127.0.0.1:{port}")
        assert_checkout_does_not_fetch(repo, sha, repo_path, server.hits)
