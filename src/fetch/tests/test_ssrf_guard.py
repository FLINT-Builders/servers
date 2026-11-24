"""Spec for refusing server-side requests to non-public addresses.

The fetch tool and the fetch prompt both perform the caller's GET with
``follow_redirects=True`` and no address check. These tests drive those
handlers and a real ``httpx`` client. They fail while a loopback, private,
link-local, or metadata target is contacted, including through a redirect or
a second DNS lookup, and while a proxy variable the operator did not pass is
honored.

A passing run means every protected listener recorded no request and the
protected body was not returned.
"""

from __future__ import annotations

import asyncio
import contextlib
import socket
import subprocess
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

import mcp.types as types
from mcp.server.lowlevel.server import Server

PROTECTED_BODY = "internal-service-body"
PUBLIC_BODY = "public-page-body"

# Addresses outside loopback, RFC1918, and link-local. Python's ipaddress
# module classifies 172.32.0.0/16 as global, so a guard that rejects only
# non-global targets still has to allow these listeners.
GLOBAL_A = "172.32.0.1"
GLOBAL_B = "172.32.0.2"


def _add_address(address: str) -> None:
    result = subprocess.run(
        ["sudo", "-n", "ip", "addr", "add", address, "dev", "lo"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return
    detail = (result.stderr or result.stdout).strip()
    lowered = detail.lower()
    if "file exists" in lowered or "address already assigned" in lowered:
        return
    raise RuntimeError(f"could not add {address} on lo: {detail}")


@pytest.fixture(scope="session", autouse=True)
def _local_test_addresses() -> None:
    """Bind the ranges the guard must reject, plus two global listeners."""
    for address in (
        "10.1.2.3/32",
        "172.16.9.9/32",
        "192.168.50.9/32",
        "169.254.169.254/32",
        f"{GLOBAL_A}/32",
        f"{GLOBAL_B}/32",
        "fd00::9/128",
        "fe80::9/128",
    ):
        _add_address(address)


class RecordingServer:
    def __init__(self, host: str, routes: dict[str, tuple[int, dict[str, str], str]], port: int = 0, ipv6: bool = False) -> None:
        self.host = host
        self.hits: list[str] = []
        handler = self._handler_type()
        server_type = _V6Server if ipv6 else _V4Server
        self.httpd = server_type((host, port), handler)
        self.httpd.hits = self.hits  # type: ignore[attr-defined]
        self.httpd.routes = routes  # type: ignore[attr-defined]
        self.httpd.fallback = None  # type: ignore[attr-defined]
        self.port = self.httpd.server_address[1]
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()

    def url(self, path: str, scheme: str = "http") -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{scheme}://{host}:{self.port}{path}"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def _handler_type(self) -> type:
        outer = self

        class Handler(BaseHandler):
            def do_GET(self) -> None:  # noqa: N802
                outer.hits.append(self.path)
                route = outer.httpd.routes.get(self.path)  # type: ignore[attr-defined]
                if route is None:
                    route = outer.httpd.fallback(self.path) if outer.httpd.fallback else (404, {"Content-Type": "text/plain"}, "")  # type: ignore[attr-defined]
                status, headers, body = route
                payload = body.encode()
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)

        return Handler


class BaseHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return


class _V4Server(ThreadingHTTPServer):
    fallback: Any = None


class _V6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6
    fallback: Any = None


class TcpProbe:
    """Counts accepted TCP connections without speaking HTTP."""

    def __init__(self, host: str, port: int = 0) -> None:
        self.hits: list[Any] = []
        self._stop = threading.Event()
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((host, port))
        self._sock.listen(20)
        self._sock.settimeout(0.2)
        self.port = self._sock.getsockname()[1]
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                conn, addr = self._sock.accept()
            except socket.timeout:
                continue
            self.hits.append(addr)
            conn.close()

    def close(self) -> None:
        self._stop.set()
        self._sock.close()


class ZoneListener:
    """HTTP on an IPv6 link-local address, which needs a zone id to bind."""

    def __init__(self, body: str) -> None:
        self.hits: list[Any] = []
        self._stop = threading.Event()
        self._sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("fe80::9", 0, 0, 1))
        self._sock.listen(20)
        self._sock.settimeout(0.2)
        self.port = self._sock.getsockname()[1]
        self._body = body.encode()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                conn, addr = self._sock.accept()
            except socket.timeout:
                continue
            self.hits.append(addr)
            try:
                conn.settimeout(1)
                data = b""
                while b"\r\n\r\n" not in data and len(data) < 8192:
                    chunk = conn.recv(1024)
                    if not chunk:
                        break
                    data += chunk
                response = (
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: text/plain\r\n"
                    b"Content-Length: " + str(len(self._body)).encode() + b"\r\n"
                    b"Connection: close\r\n\r\n" + self._body
                )
                conn.sendall(response)
            finally:
                conn.close()

    def close(self) -> None:
        self._stop.set()
        self._sock.close()


def _plain(status: int, body: str, **headers: str) -> tuple[int, dict[str, str], str]:
    merged = {"Content-Type": "text/plain"}
    merged.update(headers)
    return status, merged, body


def _protected_routes() -> dict[str, tuple[int, dict[str, str], str]]:
    return {
        "/robots.txt": _plain(404, ""),
        "/secret": _plain(200, PROTECTED_BODY),
        "/latest/meta-data/": _plain(200, PROTECTED_BODY),
    }


@pytest.fixture
def servers() -> Iterator[list[Any]]:
    opened: list[Any] = []
    yield opened
    for server in opened:
        server.close()


def listen(opened: list[Any], host: str, routes: dict[str, tuple[int, dict[str, str], str]] | None = None, port: int = 0, ipv6: bool = False) -> RecordingServer:
    server = RecordingServer(host, routes if routes is not None else _protected_routes(), port=port, ipv6=ipv6)
    opened.append(server)
    return server


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@contextlib.contextmanager
def patched_resolver(mapping: dict[str, list[str]]) -> Iterator[None]:
    """Resolve selected names through ``socket.getaddrinfo``.

    ``httpx`` 0.27.2 reaches DNS via anyio's asyncio backend, which calls
    ``loop.getaddrinfo`` and then ``socket.getaddrinfo``. Each name maps to a
    sequence of addresses; the last address repeats after the sequence ends.
    """
    real = socket.getaddrinfo
    counts: dict[str, int] = {}

    def patched(host: Any, port: Any, *args: Any, **kwargs: Any) -> Any:
        name = host.decode() if isinstance(host, (bytes, bytearray)) else host
        if name in mapping:
            sequence = mapping[name]
            index = counts.get(name, 0)
            counts[name] = index + 1
            chosen = sequence[index] if index < len(sequence) else sequence[-1]
            return real(chosen, port, *args, **kwargs)
        return real(host, port, *args, **kwargs)

    socket.getaddrinfo = patched  # type: ignore[assignment]
    try:
        yield
    finally:
        socket.getaddrinfo = real  # type: ignore[assignment]


class FetchApp:
    def __init__(self, server: Server) -> None:
        self.server = server

    async def tool(self, url: str, *, raw: bool = False) -> str:
        request = types.CallToolRequest(
            params=types.CallToolRequestParams(
                name="fetch",
                arguments={"url": url, "raw": raw},
            )
        )
        result = await self.server.request_handlers[types.CallToolRequest](request)
        content = result.root.content
        return "\n".join(item.text for item in content if hasattr(item, "text"))

    async def prompt(self, url: str) -> str:
        request = types.GetPromptRequest(
            params=types.GetPromptRequestParams(name="fetch", arguments={"url": url})
        )
        result = await self.server.request_handlers[types.GetPromptRequest](request)
        return "\n".join(message.content.text for message in result.root.messages)


@contextlib.asynccontextmanager
async def fetch_app(ignore_robots_txt: bool = False, proxy_url: str | None = None) -> Any:
    import mcp_server_fetch.server as srv

    captured: dict[str, Server] = {}
    original_init = Server.__init__
    original_stdio = srv.stdio_server

    def init(self: Server, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        captured["server"] = self

    ready = asyncio.Event()
    release = asyncio.Event()

    @contextlib.asynccontextmanager
    async def fake_stdio(*args: Any, **kwargs: Any) -> Any:
        ready.set()
        await release.wait()
        yield (None, None)

    Server.__init__ = init  # type: ignore[method-assign]
    srv.stdio_server = fake_stdio  # type: ignore[assignment]
    task = asyncio.create_task(srv.serve(None, ignore_robots_txt, proxy_url))
    try:
        await asyncio.wait_for(ready.wait(), timeout=5)
        yield FetchApp(captured["server"])
    finally:
        release.set()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        Server.__init__ = original_init  # type: ignore[method-assign]
        srv.stdio_server = original_stdio


def _assert_withheld(text: str, *protected: Any) -> None:
    assert PROTECTED_BODY not in text
    for server in protected:
        assert server.hits == [], server.hits


async def _tool(url: str, *, raw: bool = False, ignore_robots_txt: bool = False, proxy_url: str | None = None) -> str:
    async with fetch_app(ignore_robots_txt=ignore_robots_txt, proxy_url=proxy_url) as app:
        return await app.tool(url, raw=raw)


async def _prompt(url: str) -> str:
    async with fetch_app() as app:
        return await app.prompt(url)


@pytest.mark.parametrize(
    ("host", "path"),
    [
        ("127.0.0.1", "/secret"),
        ("127.0.0.2", "/secret"),
        ("localhost", "/secret"),
        ("0.0.0.0", "/secret"),
        ("10.1.2.3", "/secret"),
        ("172.16.9.9", "/secret"),
        ("192.168.50.9", "/secret"),
        ("169.254.169.254", "/latest/meta-data/"),
    ],
)
async def test_tool_does_not_fetch_nonpublic_literal(servers: list[Any], host: str, path: str) -> None:
    """The default tool checks robots.txt and then fetches. Neither request may land."""
    server = listen(servers, "127.0.0.1" if host in {"localhost", "0.0.0.0"} else host)
    text = await _tool(f"http://{host}:{server.port}{path}")
    _assert_withheld(text, server)


async def test_tool_does_not_fetch_ipv6_loopback_or_ula(servers: list[Any]) -> None:
    loopback = listen(servers, "::1", ipv6=True)
    ula = listen(servers, "fd00::9", ipv6=True)
    loop_text = await _tool(loopback.url("/secret"))
    ula_text = await _tool(ula.url("/secret"))
    _assert_withheld(loop_text, loopback)
    _assert_withheld(ula_text, ula)


async def test_tool_does_not_fetch_ipv4_mapped_loopback(servers: list[Any]) -> None:
    server = listen(servers, "127.0.0.1")
    text = await _tool(f"http://[::ffff:127.0.0.1]:{server.port}/secret")
    _assert_withheld(text, server)


@pytest.mark.parametrize(
    "url_host",
    [
        "127.0.0.1",
        "2130706433",
        "0x7f000001",
        "127.1",
        "0.0.0.0",
        "localhost",
    ],
)
async def test_prompt_does_not_fetch_loopback_spellings(servers: list[Any], url_host: str) -> None:
    """The prompt path skips robots.txt and does not run the tool's URL type."""
    server = listen(servers, "127.0.0.1")
    text = await _prompt(f"http://{url_host}:{server.port}/secret")
    _assert_withheld(text, server)


async def test_prompt_does_not_fetch_userinfo_loopback(servers: list[Any]) -> None:
    server = listen(servers, "127.0.0.1")
    text = await _prompt(f"http://user:placeholder@{server.host}:{server.port}/secret")
    _assert_withheld(text, server)


async def test_prompt_does_not_fetch_ipv6_link_local(servers: list[Any]) -> None:
    listener = ZoneListener(PROTECTED_BODY)
    servers.append(listener)
    text = await _prompt(f"http://[fe80::9%lo]:{listener.port}/secret")
    _assert_withheld(text, listener)


async def test_tool_ignoring_robots_still_does_not_fetch_loopback(servers: list[Any]) -> None:
    server = listen(servers, "127.0.0.1")
    text = await _tool(server.url("/secret"), ignore_robots_txt=True)
    _assert_withheld(text, server)


async def test_tool_does_not_follow_redirect_to_loopback(servers: list[Any]) -> None:
    secret = listen(servers, "127.0.0.1")
    public = listen(
        servers,
        GLOBAL_A,
        {
            "/robots.txt": _plain(404, ""),
            "/page": _plain(302, "", Location=secret.url("/secret")),
        },
    )
    text = await _tool(public.url("/page"))
    _assert_withheld(text, secret)
    assert public.hits, "the allowed host should still be contacted"


async def test_tool_does_not_follow_second_redirect_hop(servers: list[Any]) -> None:
    secret = listen(servers, "127.0.0.1")
    middle = listen(
        servers,
        GLOBAL_B,
        {
            "/robots.txt": _plain(404, ""),
            "/hop": _plain(302, "", Location=secret.url("/secret")),
        },
    )
    first = listen(
        servers,
        GLOBAL_A,
        {
            "/robots.txt": _plain(404, ""),
            "/start": _plain(302, "", Location=middle.url("/hop")),
        },
    )
    text = await _tool(first.url("/start"))
    _assert_withheld(text, secret)


async def test_tool_does_not_follow_redirect_to_metadata_or_decimal(servers: list[Any]) -> None:
    metadata = listen(servers, "169.254.169.254")
    loopback = listen(servers, "127.0.0.1")
    to_metadata = listen(
        servers,
        GLOBAL_A,
        {
            "/robots.txt": _plain(404, ""),
            "/meta": _plain(302, "", Location=metadata.url("/latest/meta-data/")),
        },
    )
    to_decimal = listen(
        servers,
        GLOBAL_B,
        {
            "/robots.txt": _plain(404, ""),
            "/decimal": _plain(302, "", Location=f"http://2130706433:{loopback.port}/secret"),
        },
    )
    meta_text = await _tool(to_metadata.url("/meta"))
    decimal_text = await _prompt(to_decimal.url("/decimal"))
    _assert_withheld(meta_text, metadata)
    _assert_withheld(decimal_text, loopback)


async def test_robots_redirect_does_not_reach_loopback(servers: list[Any]) -> None:
    """The robots.txt check follows redirects before the page is fetched."""
    secret = listen(servers, "127.0.0.1")
    public = listen(
        servers,
        GLOBAL_A,
        {
            "/robots.txt": _plain(302, "", Location=secret.url("/secret")),
            "/page": _plain(200, PUBLIC_BODY),
        },
    )
    text = await _tool(public.url("/page"))
    _assert_withheld(text, secret)


async def test_prompt_does_not_follow_redirect_to_loopback(servers: list[Any]) -> None:
    secret = listen(servers, "127.0.0.1")
    public = listen(
        servers,
        GLOBAL_A,
        {"/page": _plain(302, "", Location=secret.url("/secret"))},
    )
    text = await _prompt(public.url("/page"))
    _assert_withheld(text, secret)


async def test_name_that_resolves_to_loopback_is_not_fetched(servers: list[Any]) -> None:
    secret = listen(servers, "127.0.0.1")
    with patched_resolver({"loopback.test": ["127.0.0.1"]}):
        tool_text = await _tool(f"http://loopback.test:{secret.port}/secret")
        prompt_text = await _prompt(f"http://loopback.test:{secret.port}/secret")
    _assert_withheld(tool_text, secret)
    _assert_withheld(prompt_text, secret)


async def test_rebinding_between_robots_lookup_and_fetch_is_not_fetched(servers: list[Any]) -> None:
    """The tool resolves the name for robots.txt, then again for the page.

    The first answer is a global address and the next answer is loopback. The
    loopback listener must stay untouched even if the first answer was allowed.
    """
    port = _free_port()
    secret = listen(servers, "127.0.0.1", port=port)
    public = listen(
        servers,
        GLOBAL_A,
        {
            "/robots.txt": _plain(404, ""),
            "/secret": _plain(200, PUBLIC_BODY),
        },
        port=port,
    )
    assert public.port == secret.port
    with patched_resolver({"rebind.test": [GLOBAL_A, "127.0.0.1"]}):
        text = await _tool(f"http://rebind.test:{port}/secret")
    _assert_withheld(text, secret)


async def test_redirect_to_name_that_resolves_to_loopback_is_not_fetched(servers: list[Any]) -> None:
    secret = listen(servers, "127.0.0.1")
    public = listen(
        servers,
        GLOBAL_A,
        {
            "/robots.txt": _plain(404, ""),
            "/page": _plain(302, "", Location=f"http://loopback.test:{secret.port}/secret"),
        },
    )
    with patched_resolver({"loopback.test": ["127.0.0.1"]}):
        text = await _tool(public.url("/page"))
    _assert_withheld(text, secret)


async def test_https_loopback_is_not_contacted(servers: list[Any]) -> None:
    probe = TcpProbe("127.0.0.1")
    servers.append(probe)
    text = await _tool(f"https://127.0.0.1:{probe.port}/secret", ignore_robots_txt=True)
    assert PROTECTED_BODY not in text
    assert probe.hits == []


@pytest.mark.parametrize("variable", ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"])
async def test_proxy_environment_is_ignored_without_proxy_url(servers: list[Any], variable: str, monkeypatch: pytest.MonkeyPatch) -> None:
    origin = listen(
        servers,
        GLOBAL_A,
        {
            "/robots.txt": _plain(404, ""),
            "/page": _plain(200, PUBLIC_BODY),
        },
    )
    proxy = listen(servers, "127.0.0.1", {"/": _plain(200, "via-proxy")})
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(variable, f"http://127.0.0.1:{proxy.port}")
    text = await _tool(origin.url("/page"), ignore_robots_txt=True)
    assert proxy.hits == []
    assert origin.hits == ["/page"]
    assert PUBLIC_BODY in text
    assert "via-proxy" not in text


async def test_explicit_proxy_url_is_used(servers: list[Any], monkeypatch: pytest.MonkeyPatch) -> None:
    """``--proxy-url`` is the operator's proxy. An inherited HTTP_PROXY is not."""
    origin = listen(servers, GLOBAL_A, {"/page": _plain(200, PUBLIC_BODY)})
    configured = listen(servers, "127.0.0.1", {})
    decoy = listen(servers, "127.0.0.2", {})

    def fallback(path: str) -> tuple[int, dict[str, str], str]:
        configured.hits.append(path)
        return _plain(200, "via-configured-proxy")

    configured.httpd.fallback = fallback  # type: ignore[attr-defined]
    monkeypatch.setenv("HTTP_PROXY", f"http://127.0.0.2:{decoy.port}")
    text = await _tool(
        origin.url("/page"),
        ignore_robots_txt=True,
        proxy_url=f"http://127.0.0.1:{configured.port}",
    )
    assert "via-configured-proxy" in text
    assert configured.hits
    assert decoy.hits == []
    assert origin.hits == []


async def test_global_http_and_redirect_still_return_the_body(servers: list[Any]) -> None:
    direct = listen(
        servers,
        GLOBAL_A,
        {
            "/robots.txt": _plain(404, ""),
            "/page": _plain(200, PUBLIC_BODY),
        },
    )
    landed = listen(servers, GLOBAL_B, {"/landed": _plain(200, PUBLIC_BODY)})
    redirector = listen(
        servers,
        GLOBAL_A,
        {
            "/robots.txt": _plain(404, ""),
            "/go": _plain(302, "", Location=landed.url("/landed")),
        },
    )
    direct_text = await _tool(direct.url("/page"))
    redirected_text = await _tool(redirector.url("/go"))
    prompt_text = await _prompt(direct.url("/page"))
    assert PUBLIC_BODY in direct_text
    assert PUBLIC_BODY in redirected_text
    assert PUBLIC_BODY in prompt_text
    assert "/landed" in landed.hits


async def test_non_http_schemes_are_rejected() -> None:
    file_text = await _prompt("file:///etc/hostname")
    gopher_text = await _prompt("gopher://127.0.0.1:70/")
    assert "UnsupportedProtocol" in file_text
    assert "unsupported protocol" in gopher_text.lower()
