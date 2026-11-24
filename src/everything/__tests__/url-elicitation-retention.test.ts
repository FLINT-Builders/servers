/**
 * Spec for the process-wide error-path elicitation set.
 *
 * These tests fail while caller-supplied URLs are retained without a bound,
 * a length cap, a TTL, or removal when the session ends. They pass once that
 * retention is limited. The retry of a key that is still allowed to be live
 * must keep taking the request path; the existing tool tests cover that.
 *
 * Clock: expiry is measured with Date.now(). An entry must not still be
 * recognized once it is older than MAX_ENTRY_TTL_MS.
 */
import http from "node:http";
import net from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../server/index.js";
import {
  __resetIssuedErrorPathElicitations,
  registerTriggerUrlElicitationTool,
} from "../tools/trigger-url-elicitation.js";

/** Live error-path keys for one session must not grow past this. */
const MAX_RETAINED_KEYS_PER_SESSION = 16;

/** A caller-supplied URL longer than this must not be stored. */
const MAX_URL_LENGTH = 8192;

/**
 * An error-path key older than this must be dropped. This is the same
 * duration as the request-path elicitation timeout in the tool.
 */
const MAX_ENTRY_TTL_MS = 10 * 60 * 1000;

const URL_ELICITATION_REQUIRED = -32042;

type Retention = "retained" | "absent";

type ToolArgs = {
  url: string;
  message: string;
  elicitationId: string;
  errorPath: boolean;
};

type ToolHandler = (
  args: ToolArgs,
  extra: {
    sessionId?: string;
    sendRequest: () => Promise<{ action: string }>;
  }
) => Promise<unknown>;

let streamablePort = 0;
let ssePort = 0;
let probeHandler: ToolHandler;

function distinctUrl(label: string, index: number): string {
  return `https://example.com/${label}/${index}/${"a".repeat(240)}`;
}

function oversizedUrl(): string {
  const prefix = "https://example.com/oversize/";
  return prefix + "b".repeat(MAX_URL_LENGTH - prefix.length + 1);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      await response.body?.cancel();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(
    `server on port ${port} did not accept connections: ${String(lastError)}`
  );
}

function listeningServers(): http.Server[] {
  const getHandles = (
    process as NodeJS.Process & { _getActiveHandles?: () => unknown[] }
  )._getActiveHandles;
  if (!getHandles) {
    return [];
  }
  return getHandles().filter(
    (handle): handle is http.Server => handle instanceof http.Server
  );
}

async function closeServerOnPort(port: number): Promise<void> {
  const matches = listeningServers().filter((server) => {
    const address = server.address();
    return (
      typeof address === "object" && address !== null && address.port === port
    );
  });
  await Promise.all(
    matches.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
}

function installProbe(): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  const mockServer = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
    server: {
      getClientCapabilities: () => ({ elicitation: { url: {} } }),
    },
  } as unknown as McpServer;
  registerTriggerUrlElicitationTool(mockServer);
  const handler = handlers.get("trigger-url-elicitation");
  if (!handler) {
    throw new Error("trigger-url-elicitation did not register for the probe");
  }
  return handler;
}

/**
 * Observes whether the process still recognizes this error-path key.
 * A recognized key takes the request path and is then deleted, matching the
 * tool's one-shot retry. An unrecognized key throws -32042.
 */
async function retentionOf(
  sessionId: string,
  url: string,
  elicitationId: string
): Promise<Retention> {
  const sendRequest = vi.fn(async () => ({ action: "accept" as const }));
  try {
    await probeHandler(
      {
        url,
        message: "open the link",
        elicitationId,
        errorPath: true,
      },
      { sessionId, sendRequest }
    );
    expect(sendRequest).toHaveBeenCalled();
    return "retained";
  } catch (error) {
    const code =
      error instanceof McpError
        ? error.code
        : typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "number"
        ? error.code
        : undefined;
    if (code === URL_ELICITATION_REQUIRED) {
      return "absent";
    }
    throw error;
  }
}

async function connectClient(
  transport: StreamableHTTPClientTransport | SSEClientTransport
): Promise<Client> {
  const client = new Client(
    { name: "url-elicitation-retention", version: "1.0.0" },
    { capabilities: { elicitation: { url: {} } } }
  );
  await client.connect(transport);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const listed = await client.listTools();
    if (listed.tools.some((tool) => tool.name === "trigger-url-elicitation")) {
      return client;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "trigger-url-elicitation was not registered after initialize"
  );
}

type IssuedCall = "issued" | "rejected";

async function callErrorPath(
  client: Client,
  url: string,
  elicitationId: string
): Promise<IssuedCall> {
  try {
    await client.callTool(
      {
        name: "trigger-url-elicitation",
        arguments: {
          url,
          message: "open the link",
          elicitationId,
          errorPath: true,
        },
      },
      undefined,
      { timeout: 3000 }
    );
    return "rejected";
  } catch (error) {
    if (error instanceof McpError && error.code === URL_ELICITATION_REQUIRED) {
      return "issued";
    }
    if (error instanceof McpError) {
      return "rejected";
    }
    throw error;
  }
}

async function retainedCount(
  sessionId: string,
  calls: { url: string; elicitationId: string }[]
): Promise<number> {
  let retained = 0;
  for (const call of calls) {
    if (
      (await retentionOf(sessionId, call.url, call.elicitationId)) ===
      "retained"
    ) {
      retained += 1;
    }
  }
  return retained;
}

describe("URL elicitation error-path retention", () => {
  beforeAll(async () => {
    probeHandler = installProbe();

    streamablePort = await freePort();
    process.env.PORT = String(streamablePort);
    await import("../transports/streamableHttp.js");
    await waitForPort(streamablePort);

    ssePort = await freePort();
    process.env.PORT = String(ssePort);
    await import("../transports/sse.js");
    await waitForPort(ssePort);
  });

  afterAll(async () => {
    await closeServerOnPort(streamablePort);
    await closeServerOnPort(ssePort);
  });

  beforeEach(() => {
    __resetIssuedErrorPathElicitations();
  });

  it("does not retain every distinct error-path URL on streamable HTTP", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${streamablePort}/mcp`)
    );
    const client = await connectClient(transport);
    try {
      const issued: { url: string; elicitationId: string }[] = [];
      for (
        let index = 0;
        index < MAX_RETAINED_KEYS_PER_SESSION + 1;
        index += 1
      ) {
        const url = distinctUrl("url", index);
        const elicitationId = `url-${index}`;
        const outcome = await callErrorPath(client, url, elicitationId);
        if (outcome === "issued") {
          issued.push({ url, elicitationId });
        }
      }

      expect(issued.length).toBeGreaterThan(0);
      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();
      const retained = await retainedCount(sessionId!, issued);
      expect(retained).toBeLessThanOrEqual(MAX_RETAINED_KEYS_PER_SESSION);
    } finally {
      await client.close();
    }
  });

  it("does not retain every distinct elicitation id on streamable HTTP", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${streamablePort}/mcp`)
    );
    const client = await connectClient(transport);
    try {
      const url = distinctUrl("same-url", 0);
      const issued: { url: string; elicitationId: string }[] = [];
      for (
        let index = 0;
        index < MAX_RETAINED_KEYS_PER_SESSION + 1;
        index += 1
      ) {
        const elicitationId = `id-${index}`;
        const outcome = await callErrorPath(client, url, elicitationId);
        if (outcome === "issued") {
          issued.push({ url, elicitationId });
        }
      }

      expect(issued.length).toBeGreaterThan(0);
      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();
      const retained = await retainedCount(sessionId!, issued);
      expect(retained).toBeLessThanOrEqual(MAX_RETAINED_KEYS_PER_SESSION);
    } finally {
      await client.close();
    }
  });

  it("does not retain an oversized caller URL on streamable HTTP", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${streamablePort}/mcp`)
    );
    const client = await connectClient(transport);
    try {
      const url = oversizedUrl();
      expect(url.length).toBeGreaterThan(MAX_URL_LENGTH);
      const elicitationId = "oversized";
      try {
        await client.callTool(
          {
            name: "trigger-url-elicitation",
            arguments: {
              url,
              message: "open the link",
              elicitationId,
              errorPath: true,
            },
          },
          undefined,
          { timeout: 3000 }
        );
      } catch (error) {
        if (!(error instanceof McpError)) {
          throw error;
        }
      }

      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();
      expect(await retentionOf(sessionId!, url, elicitationId)).toBe("absent");
    } finally {
      await client.close();
    }
  });

  it("drops streamable HTTP error-path keys when the session terminates", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${streamablePort}/mcp`)
    );
    const client = await connectClient(transport);
    const url = distinctUrl("close-http", 0);
    const elicitationId = "close-http";
    const sessionId = transport.sessionId;
    expect(sessionId).toBeTruthy();
    expect(await callErrorPath(client, url, elicitationId)).toBe("issued");
    await transport.terminateSession();
    await client.close();

    expect(await retentionOf(sessionId!, url, elicitationId)).toBe("absent");
  });

  it("drops SSE error-path keys when the session closes", async () => {
    let sessionId: string | undefined;
    const trackingFetch: FetchLike = async (url, init) => {
      const href = url instanceof URL ? url.href : url;
      const captured = new URL(href).searchParams.get("sessionId");
      if (captured) {
        sessionId = captured;
      }
      return await fetch(url, init);
    };
    const transport = new SSEClientTransport(
      new URL(`http://127.0.0.1:${ssePort}/sse`),
      {
        fetch: trackingFetch,
      }
    );
    const client = await connectClient(transport);
    const url = distinctUrl("close-sse", 0);
    const elicitationId = "close-sse";
    expect(await callErrorPath(client, url, elicitationId)).toBe("issued");
    expect(sessionId).toBeTruthy();
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await retentionOf(sessionId!, url, elicitationId)).toBe("absent");
  });

  it("drops error-path keys once they are older than the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(start);
      const url = distinctUrl("ttl", 0);
      const elicitationId = "ttl";
      const sessionId = "ttl-session";
      expect(await retentionOf(sessionId, url, elicitationId)).toBe("absent");

      vi.setSystemTime(new Date(start.getTime() + MAX_ENTRY_TTL_MS + 1));
      // A later insert gives an implementation that sweeps on write a chance
      // to drop the expired key before we look it up.
      expect(
        await retentionOf(sessionId, distinctUrl("ttl", 1), "ttl-other")
      ).toBe("absent");
      expect(await retentionOf(sessionId, url, elicitationId)).toBe("absent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops error-path keys for the session passed to cleanup", async () => {
    const sessionId = "cleanup-session";
    const url = distinctUrl("cleanup", 0);
    const elicitationId = "cleanup";
    // First observation records the key: it is not present yet, so the handler
    // stores it and throws -32042.
    expect(await retentionOf(sessionId, url, elicitationId)).toBe("absent");

    const { cleanup } = createServer();
    cleanup(sessionId);
    expect(await retentionOf(sessionId, url, elicitationId)).toBe("absent");
  });

  it("drops every error-path key when cleanup runs without a session id", async () => {
    const sessionId = "stdio-session";
    const url = distinctUrl("stdio", 0);
    const elicitationId = "stdio";
    expect(await retentionOf(sessionId, url, elicitationId)).toBe("absent");

    // transports/stdio.ts calls cleanup() with no session id on SIGINT.
    const { cleanup } = createServer();
    cleanup();
    expect(await retentionOf(sessionId, url, elicitationId)).toBe("absent");
  });
});
