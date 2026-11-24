"""Bounds for response bodies downloaded by the fetch server.

These tests are the spec for the unbounded-body bug. They fail while the
bug is present and pass once a fix enforces both of the limits below.
They drive the real httpx path against a local server. Nothing here is mocked.

Contract a fix must meet:

* Each HTTP response the server reads, including robots.txt and any redirect
  hop, is capped at about ``MAX_DECODED_BYTES`` of decoded body. Bytes past
  that cap must not be read. ``READ_AHEAD_SLACK_BYTES`` allows one extra
  socket buffer. Gzip and deflate are decompressed automatically by httpx
  0.27.2 (``GZipDecoder.decode`` / ``DeflateDecoder.decode`` call
  ``zlib.decompressobj.decompress`` with no output limit), and a whole small
  bomb can expand inside a single ``aiter_bytes`` chunk. Stopping the loop
  after that chunk has already been allocated does not satisfy the cap.
  Limit decoded output itself (for example ``decompress(data, max_length)``
  on the raw stream).

* The whole request, including a body that keeps producing bytes, must end
  within ``REQUEST_DEADLINE_SECONDS`` plus ``DEADLINE_GRACE_SECONDS``.
  ``timeout=30`` on ``fetch_url`` and the client's default 5s timeout on the
  robots.txt request are per socket read (httpcore re-arms ``anyio.fail_after``
  on every read). A trickle faster than that interval must still be aborted.
  Apply the same deadline to redirect hops and to robots.txt.

* A normal small response, including a small gzip body, is still returned
  in full. Redirects are still followed, and the redirect response body is
  capped the same way. ``fetch_url`` may return a decoded prefix or raise
  ``McpError`` once the cap is hit. ``check_may_autonomously_fetch_url`` may
  return or raise, as long as it did not read the rest of an oversized body.

``call_tool`` and ``get_prompt`` both download through ``fetch_url``.
``call_tool`` also calls ``check_may_autonomously_fetch_url`` first, then
applies ``max_length`` only after the download returns. The tests call those
two functions directly. ``proxy_url`` only selects the httpx proxy; it uses
the same reads and is not given its own case.
"""

from __future__ import annotations

import asyncio
import gzip
import time
import tracemalloc
import zlib
from typing import Awaitable, Callable

import pytest
from mcp.shared.exceptions import McpError

from mcp_server_fetch.server import (
    check_may_autonomously_fetch_url,
    fetch_url,
)

# Decoded-body ceiling. The tool never returns more than 999_999 characters
# (``Fetch.max_length``), so a handful of mebibytes is enough for the model
# and still bounds memory.
MAX_DECODED_BYTES = 5 * 1024 * 1024
# One extra read buffer past the cap is acceptable. The rest of the body is not.
READ_AHEAD_SLACK_BYTES = 2 * 1024 * 1024
# Large enough that fully materializing it cannot hide under the slack.
OVERSIZED_BODY_BYTES = 32 * 1024 * 1024
# Peak *additional* traced allocations while one response is handled.
# A 5 MiB cap plus a text copy and zlib's limited-output buffer fits.
# Materializing OVERSIZED_BODY_BYTES does not.
MAX_TRACED_GROWTH_BYTES = 20 * 1024 * 1024
# ``fetch_url`` passes timeout=30. That value must bound the whole request.
REQUEST_DEADLINE_SECONDS = 30.0
DEADLINE_GRACE_SECONDS = 8.0
# Must stay under httpx's default 5s read timeout, which the robots.txt
# request uses, and under the 30s per-read timeout on fetch_url.
TRICKLE_INTERVAL_SECONDS = 1.0
TRICKLE_TICKS = 45
CHUNK_BYTES = 64 * 1024
USER_AGENT = "body-limit-test"


def _url(port: int, path: str) -> str:
    return f"http://127.0.0.1:{port}{path}"


def _assert_read_stopped(record: dict[str, object], full_size: int) -> None:
    sent = record["sent"]
    assert isinstance(sent, int)
    assert sent <= MAX_DECODED_BYTES + READ_AHEAD_SLACK_BYTES
    assert sent < full_size
    assert record["completed"] is False


def _assert_prefix(text: str | None, unit: str) -> None:
    if text is None:
        return
    assert 0 < len(text) <= MAX_DECODED_BYTES + READ_AHEAD_SLACK_BYTES
    assert text == unit * len(text)


async def _serve(
    handler: Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]],
) -> tuple[asyncio.Server, int]:
    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, port


async def _close(server: asyncio.Server) -> None:
    server.close()
    await server.wait_closed()


def _request_path(raw: bytes) -> str:
    line = raw.split(b"\r\n", 1)[0]
    parts = line.split()
    if len(parts) < 2:
        return "/"
    return parts[1].decode("ascii")


async def _read_headers(reader: asyncio.StreamReader) -> bytes:
    return await reader.readuntil(b"\r\n\r\n")


def _status_line(status: int, reason: str) -> bytes:
    return f"HTTP/1.1 {status} {reason}\r\n".encode("ascii")


async def _write_body(
    writer: asyncio.StreamWriter,
    body: bytes,
    record: dict[str, object],
) -> None:
    """Write ``body`` in small chunks. Record how many bytes were drained."""
    sent = 0
    try:
        while sent < len(body):
            chunk = body[sent : sent + CHUNK_BYTES]
            writer.write(chunk)
            await asyncio.wait_for(writer.drain(), timeout=5)
            sent += len(chunk)
        record["completed"] = True
    except Exception as exc:
        record["error"] = type(exc).__name__
    finally:
        record["sent"] = sent
        done = record["done"]
        assert isinstance(done, asyncio.Event)
        done.set()
        writer.close()


def _fresh_record() -> dict[str, object]:
    return {"sent": 0, "completed": False, "error": None, "done": asyncio.Event()}


async def _send(
    writer: asyncio.StreamWriter,
    *,
    status: int,
    reason: str,
    headers: list[tuple[str, str]],
    body: bytes,
    record: dict[str, object],
) -> None:
    lines = [_status_line(status, reason)]
    for name, value in headers:
        lines.append(f"{name}: {value}\r\n".encode("ascii"))
    lines.append(f"Content-Length: {len(body)}\r\n".encode("ascii"))
    lines.append(b"Connection: close\r\n\r\n")
    writer.write(b"".join(lines))
    await writer.drain()
    await _write_body(writer, body, record)


async def _growth_of(work: Callable[[], Awaitable[object]]) -> tuple[object, int]:
    tracemalloc.start()
    try:
        baseline = tracemalloc.get_traced_memory()[0]
        tracemalloc.reset_peak()
        try:
            result: object = await work()
        except McpError:
            result = None
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    return result, peak - baseline


def _gzip_bomb(unit: bytes) -> bytes:
    payload = gzip.compress(unit * OVERSIZED_BODY_BYTES, compresslevel=9)
    assert len(payload) * 100 < OVERSIZED_BODY_BYTES
    return payload


def _deflate_bomb(unit: bytes) -> bytes:
    payload = zlib.compress(unit * OVERSIZED_BODY_BYTES)
    assert len(payload) * 100 < OVERSIZED_BODY_BYTES
    return payload


@pytest.mark.asyncio
async def test_small_plain_response_is_returned() -> None:
    """A short page is still returned in full."""
    body = b"hello from the fixture"
    record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _read_headers(reader)
        await _send(
            writer,
            status=200,
            reason="OK",
            headers=[("Content-Type", "text/plain")],
            body=body,
            record=record,
        )

    server, port = await _serve(handler)
    try:
        content, _prefix = await fetch_url(_url(port, "/page"), USER_AGENT, force_raw=True)
    finally:
        await _close(server)
    assert content == body.decode("ascii")
    assert record["completed"] is True
    assert record["sent"] == len(body)


@pytest.mark.asyncio
async def test_small_gzip_response_is_decoded() -> None:
    """A small gzip body is still decompressed and returned."""
    raw = b"hello gzip"
    payload = gzip.compress(raw)
    record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _read_headers(reader)
        await _send(
            writer,
            status=200,
            reason="OK",
            headers=[("Content-Type", "text/plain"), ("Content-Encoding", "gzip")],
            body=payload,
            record=record,
        )

    server, port = await _serve(handler)
    try:
        content, _prefix = await fetch_url(_url(port, "/page"), USER_AGENT, force_raw=True)
    finally:
        await _close(server)
    assert content == raw.decode("ascii")


@pytest.mark.asyncio
async def test_fetch_url_stops_reading_oversized_plain_body() -> None:
    """An oversized plain page must not be read to completion."""
    body = b"A" * OVERSIZED_BODY_BYTES
    record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _read_headers(reader)
        await _send(
            writer,
            status=200,
            reason="OK",
            headers=[("Content-Type", "text/plain")],
            body=body,
            record=record,
        )

    server, port = await _serve(handler)
    try:
        try:
            content, _prefix = await fetch_url(
                _url(port, "/page"), USER_AGENT, force_raw=True
            )
        except McpError:
            content = None
        await asyncio.wait_for(record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    _assert_read_stopped(record, len(body))
    _assert_prefix(content, "A")


@pytest.mark.asyncio
async def test_fetch_url_caps_gzip_decompression() -> None:
    """A gzip bomb of a few dozen kilobytes must not expand to the full body."""
    payload = _gzip_bomb(b"\0")
    record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _read_headers(reader)
        await _send(
            writer,
            status=200,
            reason="OK",
            headers=[("Content-Type", "text/plain"), ("Content-Encoding", "gzip")],
            body=payload,
            record=record,
        )

    server, port = await _serve(handler)
    try:
        result, growth = await _growth_of(
            lambda: fetch_url(_url(port, "/page"), USER_AGENT, force_raw=True)
        )
        await asyncio.wait_for(record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    assert growth <= MAX_TRACED_GROWTH_BYTES
    text = None if result is None else result[0]  # type: ignore[index]
    _assert_prefix(text, "\0")


@pytest.mark.asyncio
async def test_fetch_url_caps_deflate_decompression() -> None:
    """Deflate is decoded on the same path as gzip and needs the same cap."""
    payload = _deflate_bomb(b"B")
    record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _read_headers(reader)
        await _send(
            writer,
            status=200,
            reason="OK",
            headers=[("Content-Type", "text/plain"), ("Content-Encoding", "deflate")],
            body=payload,
            record=record,
        )

    server, port = await _serve(handler)
    try:
        result, growth = await _growth_of(
            lambda: fetch_url(_url(port, "/page"), USER_AGENT, force_raw=True)
        )
        await asyncio.wait_for(record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    assert growth <= MAX_TRACED_GROWTH_BYTES
    text = None if result is None else result[0]  # type: ignore[index]
    _assert_prefix(text, "B")


@pytest.mark.asyncio
async def test_fetch_url_caps_redirect_response_body() -> None:
    """A redirect hop is followed, and its body is not fully buffered.

    httpx 0.27.2 ``AsyncClient._send_handling_redirects`` calls ``aread`` on
    the redirect response before requesting the next URL. Capping only the
    final response leaves that hop unbounded.
    """
    big = b"R" * OVERSIZED_BODY_BYTES
    small = b"OK-SMALL"
    big_record = _fresh_record()
    small_record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        raw = await _read_headers(reader)
        path = _request_path(raw)
        if path == "/big":
            await _send(
                writer,
                status=302,
                reason="Found",
                headers=[
                    ("Location", _url(port, "/small")),
                    ("Content-Type", "text/plain"),
                ],
                body=big,
                record=big_record,
            )
            return
        await _send(
            writer,
            status=200,
            reason="OK",
            headers=[("Content-Type", "text/plain")],
            body=small,
            record=small_record,
        )

    server, port = await _serve(handler)
    try:
        content, _prefix = await fetch_url(_url(port, "/big"), USER_AGENT, force_raw=True)
        await asyncio.wait_for(big_record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    assert content == small.decode("ascii")
    _assert_read_stopped(big_record, len(big))


@pytest.mark.asyncio
async def test_robots_check_stops_reading_oversized_404_body() -> None:
    """A 404 robots.txt is still fully read by ``client.get`` before the status check."""
    body = b"N" * OVERSIZED_BODY_BYTES
    record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _read_headers(reader)
        await _send(
            writer,
            status=404,
            reason="Not Found",
            headers=[("Content-Type", "text/plain")],
            body=body,
            record=record,
        )

    server, port = await _serve(handler)
    try:
        try:
            await check_may_autonomously_fetch_url(_url(port, "/page"), USER_AGENT)
        except McpError:
            pass
        await asyncio.wait_for(record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    _assert_read_stopped(record, len(body))


@pytest.mark.asyncio
async def test_robots_check_stops_reading_oversized_allow_all_body() -> None:
    """An allow-all robots.txt larger than the cap must not be read to the end.

    The allow rule is at the front, so a capped prefix still permits the fetch.
    """
    header = b"User-agent: *\nAllow: /\n"
    line = b"# " + b"x" * 1000 + b"\n"
    repeats = (OVERSIZED_BODY_BYTES - len(header)) // len(line) + 1
    body = header + line * repeats
    record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _read_headers(reader)
        await _send(
            writer,
            status=200,
            reason="OK",
            headers=[("Content-Type", "text/plain")],
            body=body,
            record=record,
        )

    server, port = await _serve(handler)
    try:
        try:
            await check_may_autonomously_fetch_url(_url(port, "/page"), USER_AGENT)
        except McpError:
            pass
        await asyncio.wait_for(record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    _assert_read_stopped(record, len(body))


@pytest.mark.asyncio
async def test_robots_check_caps_gzip_404_body() -> None:
    """robots.txt is decompressed with the same uncapped gzip decoder."""
    payload = _gzip_bomb(b"\0")
    record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _read_headers(reader)
        await _send(
            writer,
            status=404,
            reason="Not Found",
            headers=[("Content-Type", "text/plain"), ("Content-Encoding", "gzip")],
            body=payload,
            record=record,
        )

    server, port = await _serve(handler)
    try:
        _result, growth = await _growth_of(
            lambda: check_may_autonomously_fetch_url(_url(port, "/page"), USER_AGENT)
        )
        await asyncio.wait_for(record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    assert growth <= MAX_TRACED_GROWTH_BYTES


@pytest.mark.asyncio
async def test_robots_check_caps_deflate_404_body() -> None:
    """robots.txt deflate bodies are decoded and must be capped too."""
    payload = _deflate_bomb(b"D")
    record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _read_headers(reader)
        await _send(
            writer,
            status=404,
            reason="Not Found",
            headers=[("Content-Type", "text/plain"), ("Content-Encoding", "deflate")],
            body=payload,
            record=record,
        )

    server, port = await _serve(handler)
    try:
        _result, growth = await _growth_of(
            lambda: check_may_autonomously_fetch_url(_url(port, "/page"), USER_AGENT)
        )
        await asyncio.wait_for(record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    assert growth <= MAX_TRACED_GROWTH_BYTES


@pytest.mark.asyncio
async def test_robots_check_caps_redirect_response_body() -> None:
    """The robots.txt redirect hop is buffered before the next request."""
    big = b"R" * OVERSIZED_BODY_BYTES
    big_record = _fresh_record()
    final_record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        raw = await _read_headers(reader)
        path = _request_path(raw)
        if path == "/robots.txt":
            await _send(
                writer,
                status=302,
                reason="Found",
                headers=[
                    ("Location", _url(port, "/robots-final.txt")),
                    ("Content-Type", "text/plain"),
                ],
                body=big,
                record=big_record,
            )
            return
        await _send(
            writer,
            status=404,
            reason="Not Found",
            headers=[("Content-Type", "text/plain")],
            body=b"missing",
            record=final_record,
        )

    server, port = await _serve(handler)
    try:
        try:
            await check_may_autonomously_fetch_url(_url(port, "/page"), USER_AGENT)
        except McpError:
            pass
        await asyncio.wait_for(big_record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    _assert_read_stopped(big_record, len(big))
    # The final 404 is what makes autonomous fetching allowed. Following the
    # redirect is required; swallowing the 302 as the robots body is not.
    assert final_record["completed"] is True


@pytest.mark.asyncio
async def test_tool_flow_checks_robots_then_caps_the_page() -> None:
    """``call_tool`` checks robots.txt, then downloads the page, then truncates.

    A small 404 robots.txt lets the check pass. The page body is still capped.
    """
    page = b"P" * OVERSIZED_BODY_BYTES
    robots_record = _fresh_record()
    page_record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        raw = await _read_headers(reader)
        path = _request_path(raw)
        if path == "/robots.txt":
            await _send(
                writer,
                status=404,
                reason="Not Found",
                headers=[("Content-Type", "text/plain")],
                body=b"no robots",
                record=robots_record,
            )
            return
        await _send(
            writer,
            status=200,
            reason="OK",
            headers=[("Content-Type", "text/plain")],
            body=page,
            record=page_record,
        )

    server, port = await _serve(handler)
    try:
        await check_may_autonomously_fetch_url(_url(port, "/page"), USER_AGENT)
        try:
            content, _prefix = await fetch_url(
                _url(port, "/page"), USER_AGENT, force_raw=True
            )
        except McpError:
            content = None
        await asyncio.wait_for(page_record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    assert robots_record["completed"] is True
    _assert_read_stopped(page_record, len(page))
    _assert_prefix(content, "P")


async def _trickle(
    writer: asyncio.StreamWriter,
    record: dict[str, object],
    *,
    status: int,
) -> None:
    head = _status_line(status, "OK" if status == 200 else "Not Found")
    head += b"Content-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    writer.write(head)
    await writer.drain()
    chunk = b"T" * 1024
    sent = 0
    try:
        for _tick in range(TRICKLE_TICKS):
            frame = f"{len(chunk):x}\r\n".encode("ascii") + chunk + b"\r\n"
            writer.write(frame)
            await asyncio.wait_for(writer.drain(), timeout=5)
            sent += len(chunk)
            await asyncio.sleep(TRICKLE_INTERVAL_SECONDS)
        writer.write(b"0\r\n\r\n")
        await writer.drain()
        record["completed"] = True
    except Exception as exc:
        record["error"] = type(exc).__name__
    finally:
        record["sent"] = sent
        done = record["done"]
        assert isinstance(done, asyncio.Event)
        done.set()
        writer.close()


def _assert_trickle_aborted(record: dict[str, object], elapsed: float) -> None:
    sent = record["sent"]
    assert isinstance(sent, int)
    assert sent >= 1024
    assert record["completed"] is False
    assert elapsed < REQUEST_DEADLINE_SECONDS + DEADLINE_GRACE_SECONDS


@pytest.mark.asyncio
async def test_fetch_url_aborts_slow_trickle_within_deadline() -> None:
    """A body that arrives every second must not run for the full stream.

    Each gap is shorter than the 30s per-read timeout, so that timeout does
    not fire. The request still has to stop at the overall deadline.
    """
    record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _read_headers(reader)
        await _trickle(writer, record, status=200)

    server, port = await _serve(handler)
    started = time.monotonic()
    try:
        try:
            await fetch_url(_url(port, "/page"), USER_AGENT, force_raw=True)
        except Exception:
            pass
        elapsed = time.monotonic() - started
        await asyncio.wait_for(record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    _assert_trickle_aborted(record, elapsed)


@pytest.mark.asyncio
async def test_robots_check_aborts_slow_trickle_within_deadline() -> None:
    """robots.txt uses the client default timeout, also per read, with no total deadline."""
    record = _fresh_record()

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await _read_headers(reader)
        await _trickle(writer, record, status=200)

    server, port = await _serve(handler)
    started = time.monotonic()
    try:
        try:
            await check_may_autonomously_fetch_url(_url(port, "/page"), USER_AGENT)
        except Exception:
            pass
        elapsed = time.monotonic() - started
        await asyncio.wait_for(record["done"].wait(), timeout=5)  # type: ignore[union-attr]
    finally:
        await _close(server)
    _assert_trickle_aborted(record, elapsed)
