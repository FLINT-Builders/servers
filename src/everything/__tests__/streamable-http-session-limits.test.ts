/**
 * Spec for the streamable HTTP session-retention bug.
 *
 * These tests exercise the real `streamableHttp` process
 * (`node dist/index.js streamableHttp`): an unauthenticated POST /mcp
 * `initialize` with no `mcp-session-id` header. They fail while every
 * initialize retains a server until DELETE, and they pass once the transport
 * enforces the contract below.
 *
 * Contract for `src/everything/transports/streamableHttp.ts`:
 *
 * - `EVERYTHING_MAX_SESSIONS` (default 8). A POST /mcp initialize that would
 *   exceed the cap returns HTTP 503, does not include `mcp-session-id`, and
 *   does not leave an extra `McpServer` reachable. The cap check must reserve
 *   a slot before the first await, so a burst of concurrent initializes cannot
 *   exceed the cap.
 * - `EVERYTHING_SESSION_IDLE_MS` (default 600000). Every handled `/mcp`
 *   request for a session updates its last-activity time. A sweep whose
 *   interval is at most the idle timeout closes transports that have been
 *   idle longer than the timeout, via `transport.close()`, so the existing
 *   `onclose` handler drops the map entry and runs `cleanup`. Sessions whose
 *   HTTP response already ended, and sessions whose client destroyed the
 *   socket, must be reaped this way. A session must be gone within
 *   4 * EVERYTHING_SESSION_IDLE_MS after its last activity.
 * - `EVERYTHING_CORS_ORIGINS` (unset by default): comma-separated allowlist.
 *   When unset, responses must not send `Access-Control-Allow-Origin: *`.
 *   When set, only listed origins receive that header, echoed as their own
 *   origin.
 * - With no host override, the process listens on 127.0.0.1 only.
 * - On startup the process prints a line:
 *   `session-limits maxSessions=<n> idleMs=<n> host=<host>`
 *   using the resolved values (defaults above, host `127.0.0.1`).
 *
 * SSE (`transports/sse.ts`) is not covered. A client abort there fires
 * `res.on('close')` -> transport `onclose` -> the session map delete, so an
 * abandoned SSE connection does not stay allocated.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { connect as connectTcp } from "node:net";
import { cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterEach } from "vitest";

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_HOST = "127.0.0.1";

const children: ChildProcess[] = [];

type StartedServer = {
  port: number;
  baseUrl: string;
  log: () => string;
  countMcpServers: () => Promise<number>;
  stop: () => Promise<void>;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function childEnvironment(
  port: number,
  overrides: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  delete env.EVERYTHING_MAX_SESSIONS;
  delete env.EVERYTHING_SESSION_IDLE_MS;
  delete env.EVERYTHING_CORS_ORIGINS;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

type CdpMessage = {
  id?: number;
  method?: string;
  params?: { chunk?: string };
  result?: unknown;
  error?: { message?: string };
};

function connectInspector(inspectPort: number): Promise<{
  countMcpServers: () => Promise<number>;
  close: () => void;
}> {
  return (async () => {
    let list: { webSocketDebuggerUrl: string }[] = [];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${inspectPort}/json/list`
        );
        list = (await response.json()) as { webSocketDebuggerUrl: string }[];
        if (list[0]?.webSocketDebuggerUrl) break;
      } catch {
        // Inspector is not up yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const url = list[0]?.webSocketDebuggerUrl;
    if (!url) {
      throw new Error("inspector did not publish a debugger websocket");
    }
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () =>
        reject(new Error("inspector websocket failed"))
      );
    });

    let nextId = 0;
    const pending = new Map<number, (message: CdpMessage) => void>();
    const chunks: string[] = [];
    ws.addEventListener("message", (event: MessageEvent) => {
      const raw =
        typeof event.data === "string" ? event.data : String(event.data);
      const message = JSON.parse(raw) as CdpMessage;
      if (message.id !== undefined && pending.has(message.id)) {
        const resolve = pending.get(message.id);
        pending.delete(message.id);
        resolve?.(message);
      }
      if (
        message.method === "HeapProfiler.addHeapSnapshotChunk" &&
        message.params?.chunk
      ) {
        chunks.push(message.params.chunk);
      }
    });

    function send(
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<CdpMessage> {
      const id = ++nextId;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function countMcpServers(): Promise<number> {
      chunks.length = 0;
      const collected = await send("HeapProfiler.collectGarbage");
      if (collected.error) {
        throw new Error(collected.error.message ?? "collectGarbage failed");
      }
      const taken = await send("HeapProfiler.takeHeapSnapshot", {
        reportProgress: false,
      });
      if (taken.error) {
        throw new Error(taken.error.message ?? "takeHeapSnapshot failed");
      }
      const snapshot = JSON.parse(chunks.join("")) as {
        snapshot: {
          meta: { node_fields: string[]; node_types: [string[]] };
        };
        nodes: number[];
        strings: string[];
      };
      const fields = snapshot.snapshot.meta.node_fields;
      const types = snapshot.snapshot.meta.node_types[0];
      const nameIndex = fields.indexOf("name");
      const typeIndex = fields.indexOf("type");
      const stride = fields.length;
      const target = snapshot.strings.indexOf("McpServer");
      let count = 0;
      for (let i = 0; i < snapshot.nodes.length; i += stride) {
        if (
          snapshot.nodes[i + nameIndex] === target &&
          types[snapshot.nodes[i + typeIndex]] === "object"
        ) {
          count += 1;
        }
      }
      return count;
    }

    return {
      countMcpServers,
      close: () => ws.close(),
    };
  })();
}

async function startServer(
  overrides: Record<string, string | undefined> = {}
): Promise<StartedServer> {
  const port = await freePort();
  const inspectPort = await freePort();
  let combined = "";
  const child = spawn(
    process.execPath,
    [
      `--inspect=127.0.0.1:${inspectPort}`,
      join(SERVER_ROOT, "dist", "index.js"),
      "streamableHttp",
    ],
    {
      cwd: SERVER_ROOT,
      env: childEnvironment(port, overrides),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  children.push(child);
  child.stdout.on("data", (chunk: Buffer) => {
    combined += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    combined += chunk.toString("utf8");
  });

  await waitFor(
    () => combined.includes("listening on port") || child.exitCode !== null,
    8000,
    "server listen"
  );
  if (child.exitCode !== null) {
    throw new Error(`server exited ${child.exitCode}: ${combined}`);
  }

  const inspector = await connectInspector(inspectPort);

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/mcp`,
    log: () => combined,
    countMcpServers: () => inspector.countMcpServers(),
    stop: async () => {
      inspector.close();
      if (child.exitCode !== null) return;
      child.kill("SIGINT");
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve())
      );
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

function initializeMessage(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "session-limit-test", version: "0" },
    },
  });
}

async function initialize(
  baseUrl: string,
  id: number,
  origin?: string
): Promise<{
  status: number;
  sessionId: string | null;
  allowOrigin: string | null;
}> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (origin) headers.origin = origin;
  const response = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: initializeMessage(id),
  });
  await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    allowOrigin: response.headers.get("access-control-allow-origin"),
  };
}

async function listTools(baseUrl: string, sessionId: string): Promise<number> {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  await response.text();
  return response.status;
}

function dropInitialize(port: number, id: number): Promise<string> {
  const body = initializeMessage(id);
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, "127.0.0.1");
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `dropped initialize produced no session id: ${buffer.slice(0, 300)}`
        )
      );
    }, 5000);
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(/mcp-session-id:\s*([0-9a-f-]+)/i);
      if (match?.[1]) {
        clearTimeout(timer);
        socket.destroy();
        resolve(match[1]);
      }
    });
    socket.write(
      `POST /mcp HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Content-Type: application/json\r\n` +
        `Accept: application/json, text/event-stream\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n` +
        body
    );
  });
}

function listenAddresses(port: number): string[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const addresses: string[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const lines = readFileSync(file, "utf8").split("\n").slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const local = parts[1];
      const state = parts[3];
      if (!local || state !== "0A") continue;
      const [ip, portHex] = local.split(":");
      if (portHex?.toUpperCase() !== hexPort || !ip) continue;
      addresses.push(ip);
    }
  }
  return addresses;
}

beforeAll(() => {
  const tsc = join(
    SERVER_ROOT,
    "..",
    "..",
    "node_modules",
    "typescript",
    "bin",
    "tsc"
  );
  execFileSync(
    process.execPath,
    [tsc, "-p", join(SERVER_ROOT, "tsconfig.json")],
    {
      cwd: SERVER_ROOT,
      stdio: "inherit",
    }
  );
  cpSync(join(SERVER_ROOT, "docs"), join(SERVER_ROOT, "dist", "docs"), {
    recursive: true,
  });
}, 60_000);

afterEach(async () => {
  const pending = children.splice(0, children.length);
  await Promise.all(
    pending.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        })
    )
  );
});

describe("streamable HTTP session limits", () => {
  it("caps sessions by default and does not retain the rejected initialize", async () => {
    const server = await startServer();
    try {
      const created: string[] = [];
      for (let i = 0; i < DEFAULT_MAX_SESSIONS; i++) {
        const result = await initialize(server.baseUrl, i + 1);
        expect(result.status).toBe(200);
        expect(result.sessionId).toBeTruthy();
        created.push(result.sessionId as string);
      }
      const rejected = await initialize(
        server.baseUrl,
        DEFAULT_MAX_SESSIONS + 1
      );
      expect(rejected.status).toBe(503);
      expect(rejected.sessionId).toBeNull();
      expect(await server.countMcpServers()).toBe(DEFAULT_MAX_SESSIONS);
      expect(await listTools(server.baseUrl, created[0] as string)).toBe(200);
    } finally {
      await server.stop();
    }
  }, 30_000);

  it("listens on 127.0.0.1 and logs the resolved session limits", async () => {
    const server = await startServer();
    try {
      const addresses = listenAddresses(server.port);
      expect(addresses).toEqual(["0100007F"]);
      expect(server.log()).toContain(
        `session-limits maxSessions=${DEFAULT_MAX_SESSIONS} idleMs=${DEFAULT_IDLE_MS} host=${DEFAULT_HOST}`
      );
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("rejects a concurrent burst once the configured cap is reserved", async () => {
    const maxSessions = 2;
    const server = await startServer({
      EVERYTHING_MAX_SESSIONS: String(maxSessions),
      EVERYTHING_SESSION_IDLE_MS: String(DEFAULT_IDLE_MS),
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          initialize(server.baseUrl, index + 1)
        )
      );
      const accepted = results.filter((result) => result.status === 200);
      const rejected = results.filter((result) => result.status !== 200);
      expect(accepted.length).toBeLessThanOrEqual(maxSessions);
      expect(accepted.length).toBeGreaterThan(0);
      expect(rejected.every((result) => result.status === 503)).toBe(true);
      expect(rejected.every((result) => result.sessionId === null)).toBe(true);
      expect(await server.countMcpServers()).toBeLessThanOrEqual(maxSessions);
      for (const result of accepted) {
        expect(
          await listTools(server.baseUrl, result.sessionId as string)
        ).toBe(200);
      }
    } finally {
      await server.stop();
    }
  }, 30_000);

  it("reaps sessions after the HTTP transaction ends without DELETE", async () => {
    const idleMs = 400;
    const server = await startServer({
      EVERYTHING_MAX_SESSIONS: "8",
      EVERYTHING_SESSION_IDLE_MS: String(idleMs),
    });
    try {
      const completed = await initialize(server.baseUrl, 1);
      expect(completed.status).toBe(200);
      const dropped = await dropInitialize(server.port, 2);
      expect(
        await listTools(server.baseUrl, completed.sessionId as string)
      ).toBe(200);
      expect(await listTools(server.baseUrl, dropped)).toBe(200);
      expect(await server.countMcpServers()).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, idleMs * 4));

      for (const sessionId of [completed.sessionId as string, dropped]) {
        const status = await listTools(server.baseUrl, sessionId);
        expect([400, 404]).toContain(status);
      }
      expect(await server.countMcpServers()).toBe(0);
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("refreshes the idle deadline on a later request", async () => {
    const idleMs = 400;
    const server = await startServer({
      EVERYTHING_MAX_SESSIONS: "4",
      EVERYTHING_SESSION_IDLE_MS: String(idleMs),
    });
    try {
      const created = await initialize(server.baseUrl, 1);
      expect(created.status).toBe(200);
      const sessionId = created.sessionId as string;
      await new Promise((resolve) => setTimeout(resolve, idleMs * 0.6));
      expect(await listTools(server.baseUrl, sessionId)).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, idleMs * 0.6));
      expect(await listTools(server.baseUrl, sessionId)).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, idleMs * 4));
      expect([400, 404]).toContain(await listTools(server.baseUrl, sessionId));
      expect(await server.countMcpServers()).toBe(0);
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("still removes a session when the client sends DELETE", async () => {
    const server = await startServer({
      EVERYTHING_MAX_SESSIONS: "4",
      EVERYTHING_SESSION_IDLE_MS: String(DEFAULT_IDLE_MS),
    });
    try {
      const created = await initialize(server.baseUrl, 1);
      expect(created.status).toBe(200);
      const sessionId = created.sessionId as string;
      const deleted = await fetch(server.baseUrl, {
        method: "DELETE",
        headers: {
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-03-26",
        },
      });
      expect(deleted.status).toBe(200);
      expect([400, 404]).toContain(await listTools(server.baseUrl, sessionId));
      expect(await server.countMcpServers()).toBe(0);
    } finally {
      await server.stop();
    }
  }, 20_000);

  it("does not advertise a wildcard CORS origin, and honors an explicit allowlist", async () => {
    const open = await startServer({
      EVERYTHING_SESSION_IDLE_MS: String(DEFAULT_IDLE_MS),
    });
    try {
      const posted = await initialize(
        open.baseUrl,
        1,
        "https://attacker.example"
      );
      expect(posted.allowOrigin).not.toBe("*");
      const preflight = await fetch(open.baseUrl, {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      expect(preflight.headers.get("access-control-allow-origin")).not.toBe(
        "*"
      );
    } finally {
      await open.stop();
    }

    const listed = await startServer({
      EVERYTHING_SESSION_IDLE_MS: String(DEFAULT_IDLE_MS),
      EVERYTHING_CORS_ORIGINS: "https://inspector.example",
    });
    try {
      const allowed = await initialize(
        listed.baseUrl,
        1,
        "https://inspector.example"
      );
      expect(allowed.status).toBe(200);
      expect(allowed.allowOrigin).toBe("https://inspector.example");
      const attacker = await initialize(
        listed.baseUrl,
        2,
        "https://attacker.example"
      );
      expect(attacker.allowOrigin).not.toBe("*");
      expect(attacker.allowOrigin).not.toBe("https://attacker.example");
      const attackerPreflight = await fetch(listed.baseUrl, {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.example",
          "access-control-request-method": "POST",
        },
      });
      expect(
        attackerPreflight.headers.get("access-control-allow-origin")
      ).not.toBe("*");
      expect(
        attackerPreflight.headers.get("access-control-allow-origin")
      ).not.toBe("https://attacker.example");
    } finally {
      await listed.stop();
    }
  }, 20_000);
});
