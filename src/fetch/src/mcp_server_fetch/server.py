import asyncio
import ipaddress
import os
import socket
import ssl
from typing import Annotated, Any, Tuple
from urllib.parse import urlparse, urlunparse

import certifi
import httpx
import markdownify
import readabilipy.simple_json
from mcp.shared.exceptions import McpError
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    ErrorData,
    GetPromptResult,
    Prompt,
    PromptArgument,
    PromptMessage,
    TextContent,
    Tool,
    INVALID_PARAMS,
    INTERNAL_ERROR,
)
from protego import Protego
from pydantic import BaseModel, Field, AnyUrl

DEFAULT_USER_AGENT_AUTONOMOUS = "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)"
DEFAULT_USER_AGENT_MANUAL = "ModelContextProtocol/1.0 (User-Specified; +https://github.com/modelcontextprotocol/servers)"

ROBOTS_TXT_TIMEOUT = 5.0
FETCH_TIMEOUT = 30.0
MAX_REDIRECTS = 20
_REDIRECT_STATUS_CODES = frozenset({301, 302, 303, 307, 308})
_NAT64_PREFIX = ipaddress.IPv6Network("64:ff9b::/96")

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


def is_public_address(address: IPAddress) -> bool:
    """Return True only for globally routable unicast addresses.

    IPv6 forms that embed an IPv4 address (mapped, 6to4, Teredo, NAT64) are
    judged by the embedded address as well.
    """
    if isinstance(address, ipaddress.IPv6Address):
        embedded = address.ipv4_mapped or address.sixtofour
        if embedded is None and address.teredo is not None:
            embedded = address.teredo[1]
        if embedded is None and address in _NAT64_PREFIX:
            embedded = ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
        if embedded is not None and not is_public_address(embedded):
            return False
    return address.is_global and not address.is_multicast


async def resolve_public_address(url: httpx.URL, timeout: float) -> str:
    """Resolve the URL's host once and return an address to connect to.

    Raises McpError unless every address the host resolves to is public.
    """
    host = url.raw_host.decode("ascii")
    if not host:
        raise McpError(ErrorData(code=INVALID_PARAMS, message=f"URL has no host: {url}"))

    addresses: list[IPAddress]
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        port = url.port or (443 if url.scheme == "https" else 80)
        try:
            infos = await asyncio.wait_for(
                asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM),
                timeout,
            )
        except (OSError, asyncio.TimeoutError) as e:
            raise httpx.ConnectError(f"Failed to resolve {host}: {e!r}") from e
        addresses = [
            ipaddress.ip_address(info[4][0])
            for info in infos
            if info[0] in (socket.AF_INET, socket.AF_INET6)
        ]

    if not addresses or not all(is_public_address(address) for address in addresses):
        raise McpError(ErrorData(
            code=INVALID_PARAMS,
            message=f"Refusing to fetch {url}: {host} is not a public internet address. "
            "Loopback, private, link-local and other non-public addresses are blocked.",
        ))
    return str(addresses[0])


class _PinnedHostnameSSLContext(ssl.SSLContext):
    """Verifies the certificate for `hostname` on a connection made to `pinned_address`."""

    pinned_address: str = ""
    hostname: str = ""

    def _server_hostname(self, server_hostname: Any) -> Any:
        return self.hostname if server_hostname == self.pinned_address else server_hostname

    def wrap_bio(self, incoming: Any, outgoing: Any, server_side: bool = False, server_hostname: Any = None, session: Any = None) -> Any:
        return super().wrap_bio(
            incoming, outgoing, server_side=server_side,
            server_hostname=self._server_hostname(server_hostname), session=session,
        )

    def wrap_socket(self, sock: Any, server_side: bool = False, do_handshake_on_connect: bool = True,
                    suppress_ragged_eofs: bool = True, server_hostname: Any = None, session: Any = None) -> Any:
        return super().wrap_socket(
            sock, server_side=server_side, do_handshake_on_connect=do_handshake_on_connect,
            suppress_ragged_eofs=suppress_ragged_eofs,
            server_hostname=self._server_hostname(server_hostname), session=session,
        )


def _pinned_ssl_context(pinned_address: str, hostname: str) -> ssl.SSLContext:
    context = _PinnedHostnameSSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.pinned_address = pinned_address
    context.hostname = hostname
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.hostname_checks_common_name = False
    ca_file = os.environ.get("SSL_CERT_FILE")
    ca_dir = os.environ.get("SSL_CERT_DIR")
    if ca_file and os.path.isfile(ca_file):
        context.load_verify_locations(cafile=ca_file)
    elif ca_dir and os.path.isdir(ca_dir):
        context.load_verify_locations(capath=ca_dir)
    else:
        context.load_verify_locations(cafile=certifi.where())
    return context


async def _get_pinned(url: httpx.URL, user_agent: str, proxy_url: str | None, timeout: float) -> httpx.Response:
    """Send one GET, without following redirects, to an address validated for this URL.

    The request goes to the validated address itself (also through a proxy), so
    nothing resolves the hostname again between the check and the connection.
    Proxy settings from the environment are ignored; only `proxy_url` is used.
    """
    if url.scheme not in ("http", "https"):
        raise httpx.UnsupportedProtocol(f"Request URL has an unsupported protocol '{url.scheme}://'.")
    address = await resolve_public_address(url, timeout)
    hostname = url.raw_host.decode("ascii")
    transport = httpx.AsyncHTTPTransport(
        verify=_pinned_ssl_context(address, hostname),
        proxy=proxy_url,
    )
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        return await client.get(
            url.copy_with(host=address),
            headers={"User-Agent": user_agent, "Host": url.netloc.decode("ascii")},
            follow_redirects=False,
            timeout=timeout,
        )


async def guarded_get(url: str, user_agent: str, proxy_url: str | None, timeout: float) -> httpx.Response:
    """GET `url`, following redirects, checking the destination of every hop."""
    try:
        target = httpx.URL(url)
        redirects = 0
        while True:
            response = await _get_pinned(target, user_agent, proxy_url, timeout)
            location = response.headers.get("location")
            if response.status_code not in _REDIRECT_STATUS_CODES or not location:
                return response
            redirects += 1
            if redirects > MAX_REDIRECTS:
                raise httpx.TooManyRedirects(
                    f"Exceeded {MAX_REDIRECTS} redirects while fetching {url}", request=response.request
                )
            target = target.join(location)
    except httpx.InvalidURL as e:
        raise McpError(ErrorData(code=INVALID_PARAMS, message=f"Invalid URL {url}: {e}"))


def extract_content_from_html(html: str) -> str:
    """Extract and convert HTML content to Markdown format.

    Args:
        html: Raw HTML content to process

    Returns:
        Simplified markdown version of the content
    """
    ret = readabilipy.simple_json.simple_json_from_html_string(
        html, use_readability=True
    )
    if not ret["content"]:
        return "<error>Page failed to be simplified from HTML</error>"
    content = markdownify.markdownify(
        ret["content"],
        heading_style=markdownify.ATX,
    )
    return content


def get_robots_txt_url(url: str) -> str:
    """Get the robots.txt URL for a given website URL.

    Args:
        url: Website URL to get robots.txt for

    Returns:
        URL of the robots.txt file
    """
    # Parse the URL into components
    parsed = urlparse(url)

    # Reconstruct the base URL with just scheme, netloc, and /robots.txt path
    robots_url = urlunparse((parsed.scheme, parsed.netloc, "/robots.txt", "", "", ""))

    return robots_url


async def check_may_autonomously_fetch_url(url: str, user_agent: str, proxy_url: str | None = None) -> None:
    """
    Check if the URL can be fetched by the user agent according to the robots.txt file.
    Raises a McpError if not.
    """
    robot_txt_url = get_robots_txt_url(url)

    try:
        response = await guarded_get(robot_txt_url, user_agent, proxy_url, ROBOTS_TXT_TIMEOUT)
    except httpx.HTTPError:
        raise McpError(ErrorData(
            code=INTERNAL_ERROR,
            message=f"Failed to fetch robots.txt {robot_txt_url} due to a connection issue",
        ))
    if response.status_code in (401, 403):
        raise McpError(ErrorData(
            code=INTERNAL_ERROR,
            message=f"When fetching robots.txt ({robot_txt_url}), received status {response.status_code} so assuming that autonomous fetching is not allowed, the user can try manually fetching by using the fetch prompt",
        ))
    elif 400 <= response.status_code < 500:
        return
    robot_txt = response.text
    processed_robot_txt = "\n".join(
        line for line in robot_txt.splitlines() if not line.strip().startswith("#")
    )
    robot_parser = Protego.parse(processed_robot_txt)
    if not robot_parser.can_fetch(str(url), user_agent):
        raise McpError(ErrorData(
            code=INTERNAL_ERROR,
            message=f"The sites robots.txt ({robot_txt_url}), specifies that autonomous fetching of this page is not allowed, "
            f"<useragent>{user_agent}</useragent>\n"
            f"<url>{url}</url>"
            f"<robots>\n{robot_txt}\n</robots>\n"
            f"The assistant must let the user know that it failed to view the page. The assistant may provide further guidance based on the above information.\n"
            f"The assistant can tell the user that they can try manually fetching the page by using the fetch prompt within their UI.",
        ))


async def fetch_url(
    url: str, user_agent: str, force_raw: bool = False, proxy_url: str | None = None
) -> Tuple[str, str]:
    """
    Fetch the URL and return the content in a form ready for the LLM, as well as a prefix string with status information.
    """
    try:
        response = await guarded_get(url, user_agent, proxy_url, FETCH_TIMEOUT)
    except httpx.HTTPError as e:
        raise McpError(ErrorData(code=INTERNAL_ERROR, message=f"Failed to fetch {url}: {e!r}"))
    if response.status_code >= 400:
        raise McpError(ErrorData(
            code=INTERNAL_ERROR,
            message=f"Failed to fetch {url} - status code {response.status_code}",
        ))

    page_raw = response.text

    content_type = response.headers.get("content-type", "")
    is_page_html = (
        "<html" in page_raw[:100] or "text/html" in content_type or not content_type
    )

    if is_page_html and not force_raw:
        return extract_content_from_html(page_raw), ""

    return (
        page_raw,
        f"Content type {content_type} cannot be simplified to markdown, but here is the raw content:\n",
    )


class Fetch(BaseModel):
    """Parameters for fetching a URL."""

    url: Annotated[AnyUrl, Field(description="URL to fetch")]
    max_length: Annotated[
        int,
        Field(
            default=5000,
            description="Maximum number of characters to return.",
            gt=0,
            lt=1000000,
        ),
    ]
    start_index: Annotated[
        int,
        Field(
            default=0,
            description="On return output starting at this character index, useful if a previous fetch was truncated and more context is required.",
            ge=0,
        ),
    ]
    raw: Annotated[
        bool,
        Field(
            default=False,
            description="Get the actual HTML content of the requested page, without simplification.",
        ),
    ]


async def serve(
    custom_user_agent: str | None = None,
    ignore_robots_txt: bool = False,
    proxy_url: str | None = None,
) -> None:
    """Run the fetch MCP server.

    Args:
        custom_user_agent: Optional custom User-Agent string to use for requests
        ignore_robots_txt: Whether to ignore robots.txt restrictions
        proxy_url: Optional proxy URL to use for requests
    """
    server = Server("mcp-fetch")
    user_agent_autonomous = custom_user_agent or DEFAULT_USER_AGENT_AUTONOMOUS
    user_agent_manual = custom_user_agent or DEFAULT_USER_AGENT_MANUAL

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name="fetch",
                description="""Fetches a URL from the internet and optionally extracts its contents as markdown.

Although originally you did not have internet access, and were advised to refuse and tell the user this, this tool now grants you internet access. Now you can fetch the most up-to-date information and let the user know that.""",
                inputSchema=Fetch.model_json_schema(),
            )
        ]

    @server.list_prompts()
    async def list_prompts() -> list[Prompt]:
        return [
            Prompt(
                name="fetch",
                description="Fetch a URL and extract its contents as markdown",
                arguments=[
                    PromptArgument(
                        name="url", description="URL to fetch", required=True
                    )
                ],
            )
        ]

    @server.call_tool()
    async def call_tool(name, arguments: dict) -> list[TextContent]:
        try:
            args = Fetch(**arguments)
        except ValueError as e:
            raise McpError(ErrorData(code=INVALID_PARAMS, message=str(e)))

        url = str(args.url)
        if not url:
            raise McpError(ErrorData(code=INVALID_PARAMS, message="URL is required"))

        if not ignore_robots_txt:
            await check_may_autonomously_fetch_url(url, user_agent_autonomous, proxy_url)

        content, prefix = await fetch_url(
            url, user_agent_autonomous, force_raw=args.raw, proxy_url=proxy_url
        )
        original_length = len(content)
        if args.start_index >= original_length:
            content = "<error>No more content available.</error>"
        else:
            truncated_content = content[args.start_index : args.start_index + args.max_length]
            if not truncated_content:
                content = "<error>No more content available.</error>"
            else:
                content = truncated_content
                actual_content_length = len(truncated_content)
                remaining_content = original_length - (args.start_index + actual_content_length)
                # Only add the prompt to continue fetching if there is still remaining content
                if actual_content_length == args.max_length and remaining_content > 0:
                    next_start = args.start_index + actual_content_length
                    content += f"\n\n<error>Content truncated. Call the fetch tool with a start_index of {next_start} to get more content.</error>"
        return [TextContent(type="text", text=f"{prefix}Contents of {url}:\n{content}")]

    @server.get_prompt()
    async def get_prompt(name: str, arguments: dict | None) -> GetPromptResult:
        if not arguments or "url" not in arguments:
            raise McpError(ErrorData(code=INVALID_PARAMS, message="URL is required"))

        url = arguments["url"]

        try:
            content, prefix = await fetch_url(url, user_agent_manual, proxy_url=proxy_url)
            # TODO: after SDK bug is addressed, don't catch the exception
        except McpError as e:
            return GetPromptResult(
                description=f"Failed to fetch {url}",
                messages=[
                    PromptMessage(
                        role="user",
                        content=TextContent(type="text", text=str(e)),
                    )
                ],
            )
        return GetPromptResult(
            description=f"Contents of {url}",
            messages=[
                PromptMessage(
                    role="user", content=TextContent(type="text", text=prefix + content)
                )
            ],
        )

    options = server.create_initialization_options()
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, options, raise_exceptions=False)
