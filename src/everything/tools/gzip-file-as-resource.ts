import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult, Resource } from "@modelcontextprotocol/sdk/types.js";
import dns from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { gzipSync } from "node:zlib";
import {
  getSessionResourceURI,
  registerSessionResource,
} from "../resources/session.js";

const DEFAULT_DATA_URL =
  "https://raw.githubusercontent.com/modelcontextprotocol/servers/refs/heads/main/README.md";

// Maximum input file size - 10 MB default
const GZIP_MAX_FETCH_SIZE = Number(
  process.env.GZIP_MAX_FETCH_SIZE ?? String(10 * 1024 * 1024)
);

// Maximum fetch time - 30 seconds default.
const GZIP_MAX_FETCH_TIME_MILLIS = Number(
  process.env.GZIP_MAX_FETCH_TIME_MILLIS ?? String(30 * 1000)
);

// Comma-separated list of allowed domains. Unset or empty allows only the host of the default URL.
const GZIP_ALLOWED_DOMAINS = (() => {
  const configured = (process.env.GZIP_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  return configured.length > 0
    ? configured
    : [new URL(DEFAULT_DATA_URL).hostname];
})();

const GZIP_MAX_REDIRECTS = 5;

// Destinations that are never fetched, even when their host name is allowlisted.
const BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["2001::", 23], // IETF protocol assignments, including Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which embeds an IPv4 address
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

// IPv6 destinations must be global unicast. IPv4-mapped addresses are checked against the IPv4 rules above.
const GLOBAL_UNICAST_IPV6 = new BlockList();
GLOBAL_UNICAST_IPV6.addSubnet("2000::", 3, "ipv6");

// Tool input schema
const GZipFileAsResourceSchema = z.object({
  name: z.string().describe("Name of the output file").default("README.md.gz"),
  data: z
    .url()
    .describe("URL or data URI of the file content to compress")
    .default(DEFAULT_DATA_URL),
  outputType: z
    .enum(["resourceLink", "resource"])
    .default("resourceLink")
    .describe(
      "How the resulting gzipped file should be returned. 'resourceLink' returns a link to a resource that can be read later, 'resource' returns a full resource object."
    ),
});

// Tool configuration
const name = "gzip-file-as-resource";
const config = {
  title: "GZip File as Resource Tool",
  description:
    "Compresses a single file using gzip compression. Depending upon the selected output type, returns either the compressed data as a gzipped resource or a resource link, allowing it to be downloaded in a subsequent request during the current session.",
  inputSchema: GZipFileAsResourceSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/**
 * Registers the `gzip-file-as-resource` tool.
 *
 * The registered tool compresses input data using gzip, and makes the resulting file accessible
 * as a resource for the duration of the session.
 *
 * The tool supports two output types:
 * - "resource": Returns the resource directly, including its URI, MIME type, and base64-encoded content.
 * - "resourceLink": Returns a link to access the resource later.
 *
 * If an unrecognized `outputType` is provided, the tool throws an error.
 *
 * @param {McpServer} server - The McpServer instance where the tool will be registered.
 * @throws {Error} Throws an error if an unknown output type is specified.
 */
export const registerGZipFileAsResourceTool = (server: McpServer) => {
  server.registerTool(name, config, async (args): Promise<CallToolResult> => {
    const {
      name,
      data: dataUri,
      outputType,
    } = GZipFileAsResourceSchema.parse(args);

    // Validate data uri
    const url = validateDataURI(dataUri);

    // Fetch the data
    const response = await fetchSafely(url, {
      maxBytes: GZIP_MAX_FETCH_SIZE,
      timeoutMillis: GZIP_MAX_FETCH_TIME_MILLIS,
    });

    // Compress the data using gzip
    const inputBuffer = Buffer.from(response);
    const compressedBuffer = gzipSync(inputBuffer);

    // Create resource
    const uri = getSessionResourceURI(name);
    const blob = compressedBuffer.toString("base64");
    const mimeType = "application/gzip";
    const resource = <Resource>{ uri, name, mimeType };

    // Register resource, get resource link in return
    const resourceLink = registerSessionResource(
      server,
      resource,
      "blob",
      blob
    );

    // Return the resource or a resource link that can be used to access this resource later
    if (outputType === "resource") {
      return {
        content: [
          {
            type: "resource",
            resource: { uri, mimeType, blob },
          },
        ],
      };
    } else if (outputType === "resourceLink") {
      return {
        content: [resourceLink],
      };
    } else {
      throw new Error(`Unknown outputType: ${outputType}`);
    }
  });
};

/**
 * Validates a given data URI to ensure it follows the appropriate protocols and rules.
 *
 * @param {string} dataUri - The data URI to validate. Must be an HTTP, HTTPS, or data protocol URL. HTTP and HTTPS hosts must match the allowed domains list.
 * @return {URL} The validated and parsed URL object.
 * @throws {Error} If the data URI does not use a supported protocol or does not meet allowed domains criteria.
 */
function validateDataURI(dataUri: string): URL {
  // Validate Inputs
  const url = new URL(dataUri);
  try {
    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:" &&
      url.protocol !== "data:"
    ) {
      throw new Error(
        `Unsupported URL protocol for ${dataUri}. Only http, https, and data URLs are supported.`
      );
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      const domain = url.hostname;
      const domainAllowed = GZIP_ALLOWED_DOMAINS.some((allowedDomain) => {
        return domain === allowedDomain || domain.endsWith(`.${allowedDomain}`);
      });
      if (!domainAllowed) {
        throw new Error(`Domain ${domain} is not in the allowed domains list.`);
      }
    }
  } catch (error) {
    throw new Error(
      `Error processing file ${dataUri}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return url;
}

/**
 * Returns the URL's host name without the brackets that surround IPv6 literals.
 */
function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

/**
 * Reports whether an IP address is a public destination that may be fetched.
 */
function isPublicAddress(address: string, family: number): boolean {
  const ip = address.split("%")[0];
  try {
    if (family === 4) {
      return !BLOCKED_ADDRESSES.check(ip, "ipv4");
    }
    if (family === 6) {
      return (
        GLOBAL_UNICAST_IPV6.check(ip, "ipv6") &&
        !BLOCKED_ADDRESSES.check(ip, "ipv6")
      );
    }
  } catch {
    // An address BlockList cannot parse is not fetched.
  }
  return false;
}

/**
 * Resolves the URL's host once and returns the address to connect to.
 *
 * @throws {Error} If the host does not resolve, or any address it resolves to is not public.
 */
async function resolvePublicAddress(
  url: URL
): Promise<{ address: string; family: number }> {
  const hostname = bareHostname(url);
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily !== 0
      ? [{ address: hostname, family: literalFamily }]
      : await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error(`Could not resolve ${hostname}.`);
  }
  for (const { address, family } of addresses) {
    if (!isPublicAddress(address, family)) {
      throw new Error(
        `Refusing to fetch ${url.origin}: ${hostname} resolves to a non-public address.`
      );
    }
  }
  return addresses[0];
}

/**
 * Sends a GET request for the URL to the vetted address, so the connection cannot land anywhere else.
 */
async function requestPinned(
  url: URL,
  signal: AbortSignal
): Promise<IncomingMessage> {
  const { address, family } = await resolvePublicAddress(url);
  const hostname = bareHostname(url);
  const isHttps = url.protocol === "https:";
  const send = isHttps ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(
      {
        host: address,
        family,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { host: url.host },
        servername: isIP(hostname) === 0 ? hostname : undefined,
        agent: false,
        signal,
      },
      (response) => {
        signal.addEventListener(
          "abort",
          () => response.destroy(new Error(String(signal.reason))),
          { once: true }
        );
        resolve(response);
      }
    );
    request.once("error", reject);
    request.end();
  });
}

/**
 * Bails out early when a declared Content-Length is already over the limit.
 *
 * Note: we can't trust the Content-Length header: a malicious or clumsy server could return much more data than advertised,
 * so readLimited still counts the bytes actually read.
 */
function checkContentLength(
  url: URL,
  header: string | null | undefined,
  maxBytes: number
): void {
  if (header == null) {
    return;
  }
  const contentLength = parseInt(header, 10);
  if (contentLength > maxBytes) {
    throw new Error(
      `Content-Length for ${url} exceeds max of ${maxBytes}: ${contentLength}`
    );
  }
}

/**
 * Reads a body into a single buffer, failing once it exceeds maxBytes.
 */
async function readLimited(
  url: URL,
  body: AsyncIterable<Uint8Array>,
  maxBytes: number
): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  for await (const chunk of body) {
    totalSize += chunk.length;
    if (totalSize > maxBytes) {
      throw new Error(`Response from ${url} exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  const buffer = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer.buffer;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches data safely from a given URL while ensuring constraints on destination, maximum byte size and timeout duration.
 *
 * HTTP and HTTPS hosts are resolved once and must resolve only to public addresses; the connection is made to that
 * address. Redirects are followed manually, and every hop passes the same protocol, domain, and address checks.
 *
 * @param {URL} url The validated URL to fetch data from.
 * @param {Object} options An object containing options for the fetch operation.
 * @param {number} options.maxBytes The maximum allowed size (in bytes) of the response. If the response exceeds this size, the operation will be aborted.
 * @param {number} options.timeoutMillis The timeout duration (in milliseconds) for the fetch operation. If the fetch takes longer, it will be aborted.
 * @return {Promise<ArrayBuffer>} A promise that resolves with the response as an ArrayBuffer if successful.
 * @throws {Error} Throws an error if the destination is refused, the response size exceeds the defined limit, the fetch times out, or the response is otherwise invalid.
 */
async function fetchSafely(
  url: URL,
  { maxBytes, timeoutMillis }: { maxBytes: number; timeoutMillis: number }
): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        `Fetching ${url} took more than ${timeoutMillis} ms and was aborted.`
      ),
    timeoutMillis
  );

  try {
    if (url.protocol === "data:") {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.body) {
        throw new Error("No response body");
      }
      checkContentLength(url, response.headers.get("content-length"), maxBytes);
      return await readLimited(url, response.body, maxBytes);
    }

    let current = url;
    for (let redirects = 0; ; redirects++) {
      const response = await requestPinned(current, controller.signal);
      const location = response.headers.location;
      if (REDIRECT_STATUSES.has(response.statusCode ?? 0) && location) {
        response.destroy();
        if (redirects >= GZIP_MAX_REDIRECTS) {
          throw new Error(`Too many redirects while fetching ${url}`);
        }
        const next = validateDataURI(new URL(location, current).href);
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new Error(
            `Redirect from ${current} to a ${next.protocol} URL is not allowed.`
          );
        }
        current = next;
        continue;
      }
      checkContentLength(current, response.headers["content-length"], maxBytes);
      return await readLimited(current, response, maxBytes);
    }
  } finally {
    clearTimeout(timeout);
  }
}
