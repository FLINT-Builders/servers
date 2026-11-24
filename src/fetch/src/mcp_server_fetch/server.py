import codecs
import zlib
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Annotated, AsyncIterator, Tuple
from urllib.parse import urlparse, urlunparse

import anyio
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

if TYPE_CHECKING:
    from httpx import AsyncClient, Response

DEFAULT_USER_AGENT_AUTONOMOUS = "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)"
DEFAULT_USER_AGENT_MANUAL = "ModelContextProtocol/1.0 (User-Specified; +https://github.com/modelcontextprotocol/servers)"

# Upper bound on the decoded body read from any single response. The tool
# never returns more than 999_999 characters, so this leaves ample room for
# HTML that is simplified to markdown while keeping memory use bounded.
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
# Crawlers such as Google ignore robots.txt content past 500 KiB.
MAX_ROBOTS_TXT_BYTES = 512 * 1024
# httpx timeouts apply to each socket operation, so a server that keeps
# trickling bytes never trips them. This bounds the whole request instead.
REQUEST_DEADLINE_SECONDS = 30
# Only codings that can be decoded with a bounded output size are advertised.
ACCEPT_ENCODING = "gzip, deflate"
MAX_CONTENT_CODINGS = 2
_DECODE_STEP_BYTES = 64 * 1024


class _BoundedZlibDecoder:
    """Decoder for one gzip or deflate content coding that limits output per call."""

    def __init__(self, coding: str) -> None:
        self._is_deflate = coding == "deflate"
        self._first_attempt = True
        self._decompressor = zlib.decompressobj(
            zlib.MAX_WBITS if self._is_deflate else zlib.MAX_WBITS | 16
        )
        self.produced = 0

    @property
    def eof(self) -> bool:
        return self._decompressor.eof

    def decompress(self, data: bytes, max_length: int) -> Tuple[bytes, bytes]:
        """Return up to ``max_length`` decoded bytes and the input not yet consumed."""
        from httpx import DecodingError

        if self._decompressor.eof:
            # Anything after the end of the stream is ignored, as httpx does.
            return b"", b""
        was_first_attempt = self._first_attempt
        self._first_attempt = False
        try:
            output = self._decompressor.decompress(data, max_length)
        except zlib.error as exc:
            # Some servers send raw deflate without the zlib wrapper.
            if not (self._is_deflate and was_first_attempt):
                raise DecodingError(str(exc)) from exc
            self._decompressor = zlib.decompressobj(-zlib.MAX_WBITS)
            try:
                output = self._decompressor.decompress(data, max_length)
            except zlib.error as exc2:
                raise DecodingError(str(exc2)) from exc2
        self.produced += len(output)
        return output, self._decompressor.unconsumed_tail


class _BoundedBody:
    """Accumulates a response body, decoding content codings, up to ``limit`` bytes."""

    def __init__(self, content_codings: list[str], limit: int) -> None:
        from httpx import DecodingError

        codings = [
            coding
            for coding in (value.strip().lower() for value in content_codings)
            if coding in ("gzip", "deflate")
        ]
        if len(codings) > MAX_CONTENT_CODINGS:
            raise DecodingError(f"Too many content codings: {', '.join(codings)}")
        # Codings are listed in the order they were applied.
        self._decoders = [_BoundedZlibDecoder(coding) for coding in reversed(codings)]
        self._limit = limit
        self.data = bytearray()
        self.truncated = False

    def feed(self, chunk: bytes) -> bool:
        """Consume a raw body chunk. Return False once no more input is wanted."""
        if not chunk:
            return True
        if not self._push(0, chunk):
            return False
        return not any(decoder.eof for decoder in self._decoders)

    def _push(self, index: int, data: bytes) -> bool:
        if index == len(self._decoders):
            return self._append(data)
        decoder = self._decoders[index]
        while True:
            output, data = decoder.decompress(data, _DECODE_STEP_BYTES)
            if output and not self._push(index + 1, output):
                return False
            if decoder.produced > self._limit:
                self.truncated = True
                return False
            if not data and len(output) < _DECODE_STEP_BYTES:
                return True

    def _append(self, data: bytes) -> bool:
        room = self._limit - len(self.data)
        if len(data) > room:
            self.data += data[:room]
            self.truncated = True
            return False
        self.data += data
        return True


@asynccontextmanager
async def _open_response(
    client: "AsyncClient", url: str, user_agent: str, timeout: float | None = None
) -> AsyncIterator["Response"]:
    """Send a GET request, following redirects without reading their bodies."""
    from httpx import TooManyRedirects

    headers = {"User-Agent": user_agent, "Accept-Encoding": ACCEPT_ENCODING}
    if timeout is None:
        request = client.build_request("GET", url, headers=headers)
    else:
        request = client.build_request("GET", url, headers=headers, timeout=timeout)
    redirects = 0
    while True:
        response = await client.send(request, stream=True, follow_redirects=False)
        next_request = response.next_request
        if next_request is None:
            break
        await response.aclose()
        redirects += 1
        if redirects > client.max_redirects:
            raise TooManyRedirects("Exceeded maximum allowed redirects.", request=next_request)
        request = next_request
    try:
        yield response
    finally:
        await response.aclose()


async def _read_text(response: "Response", limit: int) -> Tuple[str, bool]:
    """Read at most ``limit`` decoded body bytes. Return the text and whether it was truncated."""
    body = _BoundedBody(response.headers.get_list("content-encoding", split_commas=True), limit)
    async for chunk in response.aiter_raw():
        if not body.feed(chunk):
            break
    decoder = codecs.getincrementaldecoder(response.encoding or "utf-8")(errors="replace")
    # A truncated body may end inside a multi-byte character; drop it.
    return decoder.decode(body.data, final=not body.truncated), body.truncated


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
    from httpx import AsyncClient, HTTPError

    robot_txt_url = get_robots_txt_url(url)

    async with AsyncClient(proxy=proxy_url) as client:
        try:
            with anyio.fail_after(REQUEST_DEADLINE_SECONDS):
                async with _open_response(client, robot_txt_url, user_agent) as response:
                    if response.status_code in (401, 403):
                        raise McpError(ErrorData(
                            code=INTERNAL_ERROR,
                            message=f"When fetching robots.txt ({robot_txt_url}), received status {response.status_code} so assuming that autonomous fetching is not allowed, the user can try manually fetching by using the fetch prompt",
                        ))
                    elif 400 <= response.status_code < 500:
                        return
                    robot_txt, truncated = await _read_text(response, MAX_ROBOTS_TXT_BYTES)
        except (HTTPError, TimeoutError):
            raise McpError(ErrorData(
                code=INTERNAL_ERROR,
                message=f"Failed to fetch robots.txt {robot_txt_url} due to a connection issue",
            ))
    if truncated:
        # Drop the partial last line so a cut-off rule is not misread.
        robot_txt = robot_txt[: robot_txt.rfind("\n") + 1]
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
    from httpx import AsyncClient, HTTPError

    async with AsyncClient(proxy=proxy_url) as client:
        try:
            with anyio.fail_after(REQUEST_DEADLINE_SECONDS):
                async with _open_response(
                    client, url, user_agent, timeout=REQUEST_DEADLINE_SECONDS
                ) as response:
                    if response.status_code >= 400:
                        raise McpError(ErrorData(
                            code=INTERNAL_ERROR,
                            message=f"Failed to fetch {url} - status code {response.status_code}",
                        ))
                    page_raw, truncated = await _read_text(response, MAX_RESPONSE_BYTES)
        except HTTPError as e:
            raise McpError(ErrorData(code=INTERNAL_ERROR, message=f"Failed to fetch {url}: {e!r}"))
        except TimeoutError:
            raise McpError(ErrorData(
                code=INTERNAL_ERROR,
                message=f"Failed to fetch {url}: no complete response within {REQUEST_DEADLINE_SECONDS} seconds",
            ))

    notice = (
        f"The response was larger than {MAX_RESPONSE_BYTES} bytes, so only the first {MAX_RESPONSE_BYTES} bytes were read.\n"
        if truncated
        else ""
    )
    content_type = response.headers.get("content-type", "")
    is_page_html = (
        "<html" in page_raw[:100] or "text/html" in content_type or not content_type
    )

    if is_page_html and not force_raw:
        return extract_content_from_html(page_raw), notice

    return (
        page_raw,
        f"{notice}Content type {content_type} cannot be simplified to markdown, but here is the raw content:\n",
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
