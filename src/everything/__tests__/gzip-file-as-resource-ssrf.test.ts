import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import {
  connect,
  createServer as createNetServer,
  type AddressInfo,
} from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Spec for the gzip-file-as-resource SSRF.
 *
 * These tests fail while the tool will fetch a caller-supplied http(s) URL
 * when GZIP_ALLOWED_DOMAINS is unset, and they also fail if a later check
 * resolves a name, allows it, and then fetches that name again or follows a
 * redirect onto a loopback, private, or link-local address.
 */

const EVERYTHING_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MARKER = `internal-marker-${randomBytes(8).toString("hex")}`;
const REBIND_HOST = "rebind.test";
const PUBLIC_REBIND_IP = "203.0.113.10";
const LOOPBACK_REBIND_IP = "127.0.0.1";

type MarkerServer = {
  host: string;
  port: number;
  hits: string[];
  connections: number;
  close: () => Promise<void>;
};

const servers: {
  v4?: MarkerServer;
  v6?: MarkerServer;
  rfc1918a?: MarkerServer;
  rfc1918b?: MarkerServer;
  rfc1918c?: MarkerServer;
  linkLocal?: MarkerServer;
  ula?: MarkerServer;
  v6LinkLocal?: MarkerServer;
} = {};

let defaultClient: Client | undefined;
let defaultCleanup: (() => void) | undefined;
let certDir: string | undefined;

function addLocalAddress(spec: string): void {
  const args = ["addr", "replace", spec, "dev", "lo"];
  try {
    execFileSync("/usr/sbin/ip", args, { stdio: "pipe" });
  } catch {
    execFileSync("sudo", ["-n", "/usr/sbin/ip", ...args], { stdio: "pipe" });
  }
}

function listen(server: Server, host: string, port = 0): Promise<MarkerServer> {
  const hits: string[] = [];
  const state = { connections: 0 };
  server.on("connection", () => {
    state.connections += 1;
  });
  server.on("request", (req, res) => {
    hits.push(req.url ?? "");
    res.end(MARKER);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo;
      resolve({
        host,
        port: address.port,
        hits,
        get connections() {
          return state.connections;
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function httpUrl(host: string, port: number, pathname = "/marker"): string {
  const formatted = host.includes(":") ? `[${host}]` : host;
  return `http://${formatted}:${port}${pathname}`;
}

function asToolResult(result: unknown): CallToolResult {
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray(result.content)
  ) {
    return result as CallToolResult;
  }
  throw new Error(`unexpected tool result: ${JSON.stringify(result)}`);
}

function decodedBodies(result: CallToolResult): string[] {
  const bodies: string[] = [];
  for (const block of result.content) {
    if (block.type !== "resource") {
      continue;
    }
    const resource = block.resource;
    if (!("blob" in resource) || !resource.blob) {
      continue;
    }
    bodies.push(
      gunzipSync(Buffer.from(resource.blob, "base64")).toString("utf8")
    );
  }
  return bodies;
}

async function assertRefused(
  client: Client,
  data: string,
  watched: MarkerServer,
  outputType: "resource" | "resourceLink" = "resource"
): Promise<void> {
  const hitsBefore = watched.hits.length;
  const connectionsBefore = watched.connections;
  const result = asToolResult(
    await client.callTool({
      name: "gzip-file-as-resource",
      arguments: {
        name: `out-${randomBytes(4).toString("hex")}.gz`,
        data,
        outputType,
      },
    })
  );
  expect(watched.hits.slice(hitsBefore)).toEqual([]);
  expect(watched.connections).toBe(connectionsBefore);
  expect(decodedBodies(result)).not.toContain(MARKER);
  expect(JSON.stringify(result)).not.toContain(MARKER);
  expect(result.isError).toBe(true);

  if (outputType === "resourceLink" && !result.isError) {
    const link = result.content.find((block) => block.type === "resource_link");
    if (link && link.type === "resource_link") {
      const read = await client.readResource({ uri: link.uri });
      expect(JSON.stringify(read)).not.toContain(MARKER);
    }
  }
}

async function openClient(
  allowedDomains: string | undefined
): Promise<{ client: Client; cleanup: () => void }> {
  if (allowedDomains === undefined) {
    delete process.env.GZIP_ALLOWED_DOMAINS;
  } else {
    process.env.GZIP_ALLOWED_DOMAINS = allowedDomains;
  }
  vi.resetModules();
  const { createServer } = await import("../server/index.js");
  const { Client: McpClient } = await import(
    "@modelcontextprotocol/sdk/client/index.js"
  );
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { server, cleanup } = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "gzip-ssrf-spec", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, cleanup };
}

describe("gzip-file-as-resource SSRF", () => {
  beforeAll(async () => {
    addLocalAddress("10.255.255.1/32");
    addLocalAddress("192.168.123.45/32");
    addLocalAddress("172.16.0.9/32");
    addLocalAddress("169.254.169.254/32");
    addLocalAddress("203.0.113.10/32");
    addLocalAddress("fd00::1234/128");
    addLocalAddress("fe80::1234/64");

    servers.v4 = await listen(createHttpServer(), "127.0.0.1");
    servers.v6 = await listen(createHttpServer(), "::1");
    servers.rfc1918a = await listen(createHttpServer(), "10.255.255.1");
    servers.rfc1918b = await listen(createHttpServer(), "192.168.123.45");
    servers.rfc1918c = await listen(createHttpServer(), "172.16.0.9");
    servers.linkLocal = await listen(createHttpServer(), "169.254.169.254");
    servers.ula = await listen(createHttpServer(), "fd00::1234");
    servers.v6LinkLocal = await listen(createHttpServer(), "fe80::1234%lo");

    certDir = mkdtempSync(path.join(tmpdir(), "gzip-ssrf-cert-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        path.join(certDir, "key.pem"),
        "-out",
        path.join(certDir, "cert.pem"),
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "pipe" }
    );

    delete process.env.GZIP_ALLOWED_DOMAINS;
    const opened = await openClient(undefined);
    defaultClient = opened.client;
    defaultCleanup = opened.cleanup;
  }, 30000);

  afterAll(async () => {
    await defaultClient?.close();
    defaultCleanup?.();
  });

  const destinations: Array<{
    title: string;
    url: () => string;
    watched: () => MarkerServer;
  }> = [
    {
      title: "IPv4 loopback",
      url: () => httpUrl("127.0.0.1", servers.v4!.port),
      watched: () => servers.v4!,
    },
    {
      title: "localhost",
      url: () => httpUrl("localhost", servers.v4!.port),
      watched: () => servers.v4!,
    },
    {
      title: "unspecified IPv4 0.0.0.0",
      url: () => httpUrl("0.0.0.0", servers.v4!.port),
      watched: () => servers.v4!,
    },
    {
      title: "short loopback 127.1",
      url: () => `http://127.1:${servers.v4!.port}/marker`,
      watched: () => servers.v4!,
    },
    {
      title: "decimal loopback",
      url: () => `http://2130706433:${servers.v4!.port}/marker`,
      watched: () => servers.v4!,
    },
    {
      title: "hex loopback",
      url: () => `http://0x7f000001:${servers.v4!.port}/marker`,
      watched: () => servers.v4!,
    },
    {
      title: "octal loopback",
      url: () => `http://0177.0.0.1:${servers.v4!.port}/marker`,
      watched: () => servers.v4!,
    },
    {
      title: "IPv6 loopback",
      url: () => httpUrl("::1", servers.v6!.port),
      watched: () => servers.v6!,
    },
    {
      title: "IPv4-mapped loopback",
      url: () => httpUrl("::ffff:127.0.0.1", servers.v4!.port),
      watched: () => servers.v4!,
    },
    {
      title: "RFC1918 10/8",
      url: () => httpUrl("10.255.255.1", servers.rfc1918a!.port),
      watched: () => servers.rfc1918a!,
    },
    {
      title: "RFC1918 192.168/16",
      url: () => httpUrl("192.168.123.45", servers.rfc1918b!.port),
      watched: () => servers.rfc1918b!,
    },
    {
      title: "RFC1918 172.16/12",
      url: () => httpUrl("172.16.0.9", servers.rfc1918c!.port),
      watched: () => servers.rfc1918c!,
    },
    {
      title: "link-local cloud metadata address",
      url: () => httpUrl("169.254.169.254", servers.linkLocal!.port),
      watched: () => servers.linkLocal!,
    },
    {
      title: "IPv4-mapped cloud metadata address",
      url: () => httpUrl("::ffff:169.254.169.254", servers.linkLocal!.port),
      watched: () => servers.linkLocal!,
    },
    {
      title: "IPv6 unique-local",
      url: () => httpUrl("fd00::1234", servers.ula!.port),
      watched: () => servers.ula!,
    },
    {
      title: "IPv6 link-local",
      url: () => httpUrl("fe80::1234", servers.v6LinkLocal!.port),
      watched: () => servers.v6LinkLocal!,
    },
  ];

  it.each(destinations)(
    "refuses $title when GZIP_ALLOWED_DOMAINS is unset",
    async ({ url, watched }) => {
      await assertRefused(defaultClient!, url(), watched());
    }
  );

  it("refuses loopback when GZIP_ALLOWED_DOMAINS is an empty string", async () => {
    const opened = await openClient("");
    try {
      await assertRefused(
        opened.client,
        httpUrl("127.0.0.1", servers.v4!.port),
        servers.v4!
      );
    } finally {
      await opened.client.close();
      opened.cleanup();
      delete process.env.GZIP_ALLOWED_DOMAINS;
    }
  });

  it("returns an inline resourceLink only after the destination is refused", async () => {
    await assertRefused(
      defaultClient!,
      httpUrl("127.0.0.1", servers.v4!.port),
      servers.v4!,
      "resourceLink"
    );
  });

  it("still compresses a data URI", async () => {
    const text = "data-uri-still-works";
    const data = `data:text/plain;base64,${Buffer.from(text).toString(
      "base64"
    )}`;
    const result = asToolResult(
      await defaultClient!.callTool({
        name: "gzip-file-as-resource",
        arguments: {
          name: "data.txt.gz",
          data,
          outputType: "resource",
        },
      })
    );
    expect(result.isError).toBeFalsy();
    expect(decodedBodies(result)).toEqual([text]);
  });

  it("refuses loopback even when that host is explicitly allowlisted", async () => {
    const opened = await openClient("127.0.0.1,localhost");
    try {
      await assertRefused(
        opened.client,
        httpUrl("127.0.0.1", servers.v4!.port),
        servers.v4!
      );
      await assertRefused(
        opened.client,
        httpUrl("localhost", servers.v4!.port),
        servers.v4!
      );
    } finally {
      await opened.client.close();
      opened.cleanup();
      delete process.env.GZIP_ALLOWED_DOMAINS;
    }
  });

  it("does not follow a redirect or a later DNS answer onto loopback", async () => {
    const secretHits: string[] = [];
    const secret = createHttpServer((req, res) => {
      secretHits.push(req.url ?? "");
      res.end(MARKER);
    });
    await new Promise<void>((resolve, reject) => {
      secret.once("error", reject);
      secret.listen(0, LOOPBACK_REBIND_IP, () => resolve());
    });
    const port = (secret.address() as AddressInfo).port;
    const redirector = createHttpServer((req, res) => {
      res.writeHead(302, {
        Location: `http://${LOOPBACK_REBIND_IP}:${port}/hidden`,
      });
      res.end("redirect");
    });
    await new Promise<void>((resolve, reject) => {
      redirector.once("error", reject);
      redirector.listen(port, PUBLIC_REBIND_IP, () => resolve());
    });

    // The first lookup is a public address. Every later lookup is loopback,
    // which is what a check-then-fetch of the same name observes.
    let lookups = 0;
    const originalLookup = dns.lookup;
    const originalPromiseLookup = dns.promises.lookup;
    const nextAddress = (): string => {
      lookups += 1;
      return lookups === 1 ? PUBLIC_REBIND_IP : LOOPBACK_REBIND_IP;
    };
    const patchedLookup = ((
      hostname: string,
      options: unknown,
      callback?: (
        err: NodeJS.ErrnoException | null,
        address: string | Array<{ address: string; family: number }>,
        family?: number
      ) => void
    ) => {
      let opts = options;
      let cb = callback;
      if (typeof opts === "function") {
        cb = opts as typeof cb;
        opts = {};
      }
      if (hostname !== REBIND_HOST) {
        return (originalLookup as (...args: unknown[]) => unknown).call(
          dns,
          hostname,
          opts,
          cb
        );
      }
      const address = nextAddress();
      const all =
        typeof opts === "object" &&
        opts !== null &&
        "all" in opts &&
        Boolean((opts as { all?: boolean }).all);
      if (all) {
        cb?.(null, [{ address, family: 4 }]);
      } else {
        cb?.(null, address, 4);
      }
      return undefined;
    }) as typeof dns.lookup;
    dns.lookup = patchedLookup;
    dns.promises.lookup = (async (hostname: string, options?: unknown) => {
      if (hostname !== REBIND_HOST) {
        return (
          originalPromiseLookup as (
            hostname: string,
            options?: unknown
          ) => Promise<unknown>
        )(hostname, options);
      }
      const address = nextAddress();
      const all =
        typeof options === "object" &&
        options !== null &&
        "all" in options &&
        Boolean((options as { all?: boolean }).all);
      if (all) {
        return [{ address, family: 4 }];
      }
      return { address, family: 4 };
    }) as typeof dns.promises.lookup;

    const opened = await openClient(REBIND_HOST);
    try {
      const result = asToolResult(
        await opened.client.callTool({
          name: "gzip-file-as-resource",
          arguments: {
            name: "rebind.gz",
            data: `http://${REBIND_HOST}:${port}/start`,
            outputType: "resource",
          },
        })
      );
      expect(secretHits).toEqual([]);
      expect(decodedBodies(result)).not.toContain(MARKER);
      expect(JSON.stringify(result)).not.toContain(MARKER);
      expect(result.isError).toBe(true);
    } finally {
      dns.lookup = originalLookup;
      dns.promises.lookup = originalPromiseLookup;
      await opened.client.close();
      opened.cleanup();
      delete process.env.GZIP_ALLOWED_DOMAINS;
      await new Promise<void>((resolve) => secret.close(() => resolve()));
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
    }
  });
});

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.GZIP_ALLOWED_DOMAINS;
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForTcp(port: number, child: ChildProcess): Promise<void> {
  const started = Date.now();
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let lastError = "not tried";
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`server did not listen (${lastError}): ${stderr}`);
}

function listeningIps(port: number): string[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const found: string[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) {
        continue;
      }
      const [ip, listedPort] = parts[1].split(":");
      if (listedPort?.toUpperCase() !== hexPort || parts[3] !== "0A") {
        continue;
      }
      found.push(ip);
    }
  }
  return found;
}

function spawnServer(
  kind: "streamableHttp" | "sse",
  port: number
): ChildProcess {
  return spawn(process.execPath, ["dist/index.js", kind], {
    cwd: EVERYTHING_ROOT,
    env: childEnv({ PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

type RpcResponse = {
  id?: number;
  result?: CallToolResult;
  error?: { message?: string };
};

describe("gzip-file-as-resource reaches the network transports", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], {
      cwd: EVERYTHING_ROOT,
      stdio: "pipe",
    });
  }, 60000);

  it("refuses an unauthenticated streamable HTTP tools/call to loopback", async () => {
    const port = await freePort();
    const child = spawnServer("streamableHttp", port);
    try {
      await waitForTcp(port, child);
      const listeners = listeningIps(port);
      expect(listeners.some((ip) => /^0+$/.test(ip))).toBe(true);

      const init = await postJson(port, "/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "gzip-ssrf-spec", version: "0.0.0" },
        },
      });
      const sessionId = init.sessionId;
      expect(sessionId).toBeTruthy();
      await postJson(
        port,
        "/mcp",
        { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId
      );
      const hitsBefore = servers.v4!.hits.length;
      const response = await postJson(
        port,
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "gzip-file-as-resource",
            arguments: {
              name: "http.gz",
              data: httpUrl("127.0.0.1", servers.v4!.port),
              outputType: "resource",
            },
          },
        },
        sessionId
      );
      const tool = response.messages.find((message) => message.id === 2);
      expect(servers.v4!.hits.slice(hitsBefore)).toEqual([]);
      expect(JSON.stringify(tool)).not.toContain(MARKER);
      expect(tool?.result?.isError).toBe(true);
    } finally {
      await stopChild(child);
    }
  }, 20000);

  it("refuses an unauthenticated SSE tools/call to loopback", async () => {
    const port = await freePort();
    const child = spawnServer("sse", port);
    try {
      await waitForTcp(port, child);
      const sse = await openSse(port);
      try {
        await postJson(port, sse.endpoint, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "gzip-ssrf-spec", version: "0.0.0" },
          },
        });
        await sse.readUntil((message) => message.id === 1);
        await postJson(port, sse.endpoint, {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
        const hitsBefore = servers.v4!.hits.length;
        await postJson(port, sse.endpoint, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "gzip-file-as-resource",
            arguments: {
              name: "sse.gz",
              data: httpUrl("127.0.0.1", servers.v4!.port),
              outputType: "resource",
            },
          },
        });
        const tool = await sse.readUntil((message) => message.id === 2);
        expect(servers.v4!.hits.slice(hitsBefore)).toEqual([]);
        expect(JSON.stringify(tool)).not.toContain(MARKER);
        expect(tool.result?.isError).toBe(true);
      } finally {
        sse.close();
      }
    } finally {
      await stopChild(child);
    }
  }, 20000);

  it("refuses a stdio tools/call to loopback", async () => {
    await callStdioGzip(httpUrl("127.0.0.1", servers.v4!.port), {});
  }, 20000);

  it("refuses https to loopback when the certificate is trusted", async () => {
    const httpsServer = createHttpsServer({
      key: readFileSync(path.join(certDir!, "key.pem")),
      cert: readFileSync(path.join(certDir!, "cert.pem")),
    });
    const secure = await listen(httpsServer, "127.0.0.1");
    try {
      await callStdioGzip(
        `https://127.0.0.1:${secure.port}/marker`,
        {
          NODE_EXTRA_CA_CERTS: path.join(certDir!, "cert.pem"),
        },
        secure
      );
    } finally {
      await secure.close();
    }
  }, 20000);
});

async function callStdioGzip(
  data: string,
  extraEnv: Record<string, string>,
  watched: MarkerServer = servers.v4!
): Promise<void> {
  const child = spawn(process.execPath, ["dist/index.js", "stdio"], {
    cwd: EVERYTHING_ROOT,
    env: childEnv(extraEnv),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  let buffer = "";
  const pending = new Map<number, (message: RpcResponse) => void>();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) {
        continue;
      }
      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)!(message);
        pending.delete(message.id);
      }
    }
  });
  const request = (id: number, message: unknown) =>
    new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`stdio timeout for ${id}: ${stderr}`));
      }, 8000);
      pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    });

  try {
    await request(1, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "gzip-ssrf-spec", version: "0.0.0" },
      },
    });
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })}\n`
    );
    const hitsBefore = watched.hits.length;
    const connectionsBefore = watched.connections;
    const response = await request(2, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "gzip-file-as-resource",
        arguments: {
          name: "stdio.gz",
          data,
          outputType: "resource",
        },
      },
    });
    expect(watched.hits.slice(hitsBefore)).toEqual([]);
    expect(watched.connections).toBe(connectionsBefore);
    expect(JSON.stringify(response)).not.toContain(MARKER);
    expect(response.result?.isError).toBe(true);
  } finally {
    await stopChild(child);
  }
}

async function postJson(
  port: number,
  pathname: string,
  body: unknown,
  sessionId?: string
): Promise<{ sessionId?: string; messages: RpcResponse[]; status: number }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["mcp-protocol-version"] = "2025-03-26";
  }
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const messages: RpcResponse[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (!data) {
      continue;
    }
    messages.push(JSON.parse(data) as RpcResponse);
  }
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
    messages,
  };
}

async function openSse(port: number): Promise<{
  endpoint: string;
  readUntil: (
    predicate: (message: RpcResponse) => boolean
  ) => Promise<RpcResponse>;
  close: () => void;
}> {
  const response = await fetch(`http://127.0.0.1:${port}/sse`);
  if (!response.body) {
    throw new Error("SSE response had no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let endpoint = "";
  const queue: RpcResponse[] = [];
  const waiters: Array<(message: RpcResponse) => void> = [];
  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
        const data = raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("\n");
        if (data.startsWith("/message")) {
          endpoint = data;
          continue;
        }
        if (!data) {
          continue;
        }
        const message = JSON.parse(data) as RpcResponse;
        const waiter = waiters.shift();
        if (waiter) {
          waiter(message);
        } else {
          queue.push(message);
        }
      }
    }
  })();
  void pump;
  const started = Date.now();
  while (!endpoint) {
    if (Date.now() - started > 5000) {
      throw new Error("SSE endpoint was not announced");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return {
    endpoint,
    readUntil: (predicate) =>
      new Promise((resolve, reject) => {
        const existing = queue.findIndex(predicate);
        if (existing !== -1) {
          resolve(queue.splice(existing, 1)[0]);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error("timed out waiting for SSE response"));
        }, 8000);
        const waiter = (message: RpcResponse) => {
          if (!predicate(message)) {
            queue.push(message);
            waiters.push(waiter);
            return;
          }
          clearTimeout(timer);
          resolve(message);
        };
        waiters.push(waiter);
      }),
    close: () => {
      void reader.cancel();
    },
  };
}

afterAll(async () => {
  await Promise.all(Object.values(servers).map((server) => server?.close()));
});
