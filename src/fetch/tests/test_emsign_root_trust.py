"""TLS trust used by the fetch server for caller-supplied HTTPS URLs.

certifi 2024.8.30's CA bundle includes the emSign ECC Root CA - G3 trust
anchor. httpx verifies the server certificate with that bundle and does not
consult CRLs. These tests fail while that anchor is still in the context
``fetch_url`` and ``check_may_autonomously_fetch_url`` build, and pass once
the anchor is no longer trusted and certificate verification stays on.
"""

from __future__ import annotations

import hashlib
import http.server
import ipaddress
import ssl
import threading
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import TracebackType
from typing import Callable
from unittest.mock import patch

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from httpx import AsyncClient
from mcp.shared.exceptions import McpError

from mcp_server_fetch.server import (
    DEFAULT_USER_AGENT_AUTONOMOUS,
    DEFAULT_USER_AGENT_MANUAL,
    check_may_autonomously_fetch_url,
    fetch_url,
)

# Public SHA-256 of the DER encoding of emSign ECC Root CA - G3, as labeled
# in the certifi CA bundle. This is a trust anchor, not a private key.
EMSIGN_ECC_ROOT_G3_SHA256 = bytes.fromhex(
    "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b"
)
ATTACKER_BODY = "attacker-controlled-page-body"


def _context_trusts_emsign_ecc_root_g3(context: ssl.SSLContext) -> bool:
    for der in context.get_ca_certs(binary_form=True):
        if hashlib.sha256(der).digest() == EMSIGN_ECC_ROOT_G3_SHA256:
            return True
    return False


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


def _write_pem(path: Path, data: bytes) -> None:
    path.write_bytes(data)


def _issue_localhost_cert(
    directory: Path, *, include_ca_in_bundle: bool
) -> tuple[Path, Path, Path | None]:
    """Create a leaf for 127.0.0.1. Optionally also write its CA as a bundle."""
    now = datetime.now(timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = _name("local-test-ca")
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_cert_sign=True,
                crl_sign=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(_name("127.0.0.1"))
        .issuer_name(ca_name)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
            ),
            critical=False,
        )
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    cert_path = directory / "leaf.pem"
    key_path = directory / "leaf.key"
    _write_pem(cert_path, leaf_cert.public_bytes(serialization.Encoding.PEM))
    _write_pem(
        key_path,
        leaf_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ),
    )
    bundle_path = None
    if include_ca_in_bundle:
        bundle_path = directory / "ca-bundle.pem"
        _write_pem(bundle_path, ca_cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path, bundle_path


class _BodyHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        body = ATTACKER_BODY.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


def _serve_https(cert_path: Path, key_path: Path) -> tuple[http.server.ThreadingHTTPServer, int]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _BodyHandler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


class _RecordingAsyncClient:
    """Real httpx client that keeps the SSL context used for the request."""

    contexts: list[ssl.SSLContext] = []

    def __init__(self, *args: object, **kwargs: object) -> None:
        self._client = AsyncClient(*args, **kwargs)
        pool = getattr(self._client._transport, "_pool")
        context = getattr(pool, "_ssl_context")
        assert isinstance(context, ssl.SSLContext)
        _RecordingAsyncClient.contexts.append(context)

    async def __aenter__(self) -> _RecordingAsyncClient:
        await self._client.__aenter__()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self._client.__aexit__(exc_type, exc, tb)

    def __getattr__(self, name: str) -> Callable[..., object]:
        return getattr(self._client, name)


def _clear_ca_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    monkeypatch.delenv("REQUESTS_CA_BUNDLE", raising=False)
    monkeypatch.delenv("CURL_CA_BUNDLE", raising=False)


@pytest.fixture
def https_server(tmp_path: Path) -> Iterator[tuple[str, Path | None]]:
    cert_path, key_path, bundle_path = _issue_localhost_cert(
        tmp_path, include_ca_in_bundle=True
    )
    server, port = _serve_https(cert_path, key_path)
    try:
        yield f"https://127.0.0.1:{port}/page", bundle_path
    finally:
        server.shutdown()
        server.server_close()


def _assert_verification_still_on(context: ssl.SSLContext) -> None:
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True


@pytest.mark.asyncio
async def test_default_fetch_paths_do_not_trust_emsign_ecc_root_g3(
    monkeypatch: pytest.MonkeyPatch, https_server: tuple[str, Path | None]
) -> None:
    """Caller-supplied HTTPS must not be verified with emSign ECC Root CA - G3.

    ``call_tool`` calls ``check_may_autonomously_fetch_url`` and then
    ``fetch_url``. ``get_prompt`` calls ``fetch_url`` with the manual user
    agent. Both clients are constructed with default verification. An
    on-path peer that presents a chain to this root is accepted while the
    root remains in that context, and the response body is returned to the
    model. Revocation of an intermediate is not consulted: the context has
    no CRL material loaded.
    """
    url, _bundle = https_server
    _clear_ca_env(monkeypatch)
    _RecordingAsyncClient.contexts = []

    with patch("httpx.AsyncClient", _RecordingAsyncClient):
        with pytest.raises(McpError) as robots_error:
            await check_may_autonomously_fetch_url(url, DEFAULT_USER_AGENT_AUTONOMOUS)
        with pytest.raises(McpError) as page_error:
            await fetch_url(url, DEFAULT_USER_AGENT_AUTONOMOUS, force_raw=True)
        with pytest.raises(McpError) as manual_error:
            await fetch_url(url, DEFAULT_USER_AGENT_MANUAL, force_raw=True)
        with pytest.raises(McpError) as proxy_error:
            await fetch_url(
                url,
                DEFAULT_USER_AGENT_AUTONOMOUS,
                force_raw=True,
                proxy_url="http://127.0.0.1:9",
            )

    for error in (robots_error, page_error, manual_error, proxy_error):
        assert ATTACKER_BODY not in str(error.value)

    assert len(_RecordingAsyncClient.contexts) == 4
    for context in _RecordingAsyncClient.contexts:
        _assert_verification_still_on(context)
        assert not _context_trusts_emsign_ecc_root_g3(context), (
            "The SSL context used for this fetch trusts emSign ECC Root CA - G3. "
            "Certificate verification accepts a chain that ends at that root, "
            "and CRL checks are disabled, so a revoked intermediate under it "
            "still verifies."
        )


@pytest.mark.asyncio
async def test_fetch_url_returns_body_when_presented_chain_is_trusted(
    monkeypatch: pytest.MonkeyPatch, https_server: tuple[str, Path | None]
) -> None:
    """The same fetch path returns the peer body when the chain's CA is trusted.

    This locks the outcome the emSign root produces: ``fetch_url`` does not
    pin certificates or ignore the trust store. Trusting the issuing CA is
    enough for the caller-supplied URL's response to be returned.
    """
    url, bundle = https_server
    assert bundle is not None
    _clear_ca_env(monkeypatch)
    monkeypatch.setenv("SSL_CERT_FILE", str(bundle))

    content, _prefix = await fetch_url(
        url, DEFAULT_USER_AGENT_AUTONOMOUS, force_raw=True
    )
    assert content == ATTACKER_BODY

    # The proxy argument uses a different pool, but the origin context is
    # still the one just proven to accept a trusted chain. A closed proxy
    # must fail before any body is returned.
    with pytest.raises(McpError) as proxy_error:
        await fetch_url(
            url,
            DEFAULT_USER_AGENT_AUTONOMOUS,
            force_raw=True,
            proxy_url="http://127.0.0.1:9",
        )
    assert ATTACKER_BODY not in str(proxy_error.value)
