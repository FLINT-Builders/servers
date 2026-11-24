import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Heap large enough to parse a sub-4MiB JSON body and serve a normal session,
 * and small enough that validating that body element-by-element aborts the
 * process while the vulnerability is present.
 */
const HEAP_MB = "768";
const FOUR_MIB = 4 * 1024 * 1024;
const ROOTS_ELEMENTS = 1_500_000;
const ELICIT_ELEMENTS = 1_750_000;

const serverEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/index.js"
);

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  children.length = 0;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function startServer(
  transport: "streamableHttp" | "sse"
): Promise<{ child: ChildProcess; port: number }> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, serverEntry, transport],
    {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  children.push(child);
  child.stdout?.resume();
  child.stderr?.resume();

  const probePath = transport === "sse" ? "/sse" : "/mcp";
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isAlive(child)) {
      throw new Error("server exited during startup");
    }
    try {
      await fetch(`http://127.0.0.1:${port}${probePath}`, { method: "GET" });
      return { child, port };
    } catch {
      await delay(50);
    }
  }
  throw new Error("server did not listen");
}

function zeros(count: number): number[] {
  return new Array(count).fill(0);
}

type SseMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  params?: unknown;
};

async function readMessages(
  body: ReadableStream<Uint8Array>,
  until: (message: SseMessage) => boolean,
  timeoutMs: number
): Promise<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const dataLine = part
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      const payload = dataLine.slice("data: ".length);
      if (payload.startsWith("/")) continue;
      let message: SseMessage;
      try {
        message = JSON.parse(payload) as SseMessage;
      } catch {
        continue;
      }
      if (until(message)) return message;
    }
  }
  throw new Error("timed out waiting for a server message");
}

const jsonHeaders = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

async function openStreamableSession(
  port: number,
  capabilities: Record<string, unknown>
): Promise<{ sessionId: string; events: ReadableStream<Uint8Array> }> {
  const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities,
        clientInfo: { name: "validation-bounds", version: "0" },
      },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("missing session id");
  await init.body?.cancel();

  const events = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
  });
  if (!events.ok || !events.body) {
    throw new Error(`GET /mcp failed: ${events.status}`);
  }

  const notified = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      ...jsonHeaders,
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  if (notified.status !== 202) {
    throw new Error(`initialized notification status ${notified.status}`);
  }

  return { sessionId, events: events.body };
}

async function postStreamable(
  port: number,
  sessionId: string,
  message: unknown
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      ...jsonHeaders,
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify(message),
  });
}

async function openSseSession(
  port: number,
  capabilities: Record<string, unknown>
): Promise<{
  sessionId: string;
  events: ReadableStream<Uint8Array>;
  post: (message: unknown) => Promise<Response>;
}> {
  const events = await fetch(`http://127.0.0.1:${port}/sse`);
  if (!events.ok || !events.body) {
    throw new Error(`GET /sse failed: ${events.status}`);
  }
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let sessionId: string | undefined;
  const deadline = Date.now() + 3_000;
  while (!sessionId && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const match = buffer.match(/sessionId=([0-9a-f-]+)/);
    if (match) sessionId = match[1];
  }
  if (!sessionId) throw new Error("SSE session id was not advertised");

  const post = (message: unknown) =>
    fetch(`http://127.0.0.1:${port}/message?sessionId=${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });

  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities,
      clientInfo: { name: "validation-bounds", version: "0" },
    },
  });
  if (init.status !== 202) throw new Error(`SSE init status ${init.status}`);
  const notified = await post({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  if (notified.status !== 202) {
    throw new Error(`SSE initialized status ${notified.status}`);
  }

  const rest = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(buffer));
      }
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      } catch {
        // The server may abort the socket.
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return { sessionId, events: rest, post };
}

async function expectStreamableStillServing(
  child: ChildProcess,
  ping: () => Promise<Response>
): Promise<void> {
  await delay(300);
  expect(
    isAlive(child),
    "server process aborted while validating one HTTP body under 4 MiB"
  ).toBe(true);
  const response = await ping();
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toContain('"id":99');
  expect(isAlive(child)).toBe(true);
}

describe("HTTP array and object validation bounds", () => {
  it("serves a normal roots reply and a later ping under the same heap", async () => {
    const { child, port } = await startServer("streamableHttp");
    const { sessionId, events } = await openStreamableSession(port, {
      roots: { listChanged: true },
    });
    const request = await readMessages(
      events,
      (message) => message.method === "roots/list",
      4_000
    );
    const reply = await postStreamable(port, sessionId, {
      jsonrpc: "2.0",
      id: request.id,
      result: { roots: [{ uri: "file:///tmp" }] },
    });
    expect(reply.status).toBe(202);
    const ping = await postStreamable(port, sessionId, {
      jsonrpc: "2.0",
      id: 99,
      method: "ping",
    });
    expect(ping.status).toBe(200);
    expect(await ping.text()).toContain('"id":99');
    expect(isAlive(child)).toBe(true);
  }, 20_000);

  it("rejects a roots/list result with a huge array without aborting the streamable HTTP server", async () => {
    const { child, port } = await startServer("streamableHttp");
    const { sessionId, events } = await openStreamableSession(port, {
      roots: { listChanged: true },
    });
    const request = await readMessages(
      events,
      (message) => message.method === "roots/list",
      4_000
    );
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { roots: zeros(ROOTS_ELEMENTS) },
    });
    expect(body.length).toBeLessThan(FOUR_MIB);

    try {
      const reply = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          ...jsonHeaders,
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-03-26",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });
      await reply.text().catch(() => undefined);
    } catch {
      // A crash closes the socket before a response is written.
    }

    await expectStreamableStillServing(child, () =>
      postStreamable(port, sessionId, {
        jsonrpc: "2.0",
        id: 99,
        method: "ping",
      })
    );
  }, 20_000);

  it("rejects an elicitation result with a huge array without aborting the streamable HTTP server", async () => {
    const { child, port } = await startServer("streamableHttp");
    const { sessionId } = await openStreamableSession(port, {
      elicitation: { form: {} },
    });
    await delay(400);
    const call = await postStreamable(port, sessionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "trigger-elicitation-request", arguments: {} },
    });
    if (!call.body) throw new Error("tool call returned no body");
    const request = await readMessages(
      call.body,
      (message) => message.method === "elicitation/create",
      4_000
    );
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        action: "accept",
        content: { field: zeros(ELICIT_ELEMENTS) },
      },
    });
    expect(body.length).toBeLessThan(FOUR_MIB);

    try {
      const reply = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          ...jsonHeaders,
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-03-26",
        },
        body,
      });
      await reply.text().catch(() => undefined);
    } catch {
      // A crash closes the socket before a response is written.
    }

    await expectStreamableStillServing(child, () =>
      postStreamable(port, sessionId, {
        jsonrpc: "2.0",
        id: 99,
        method: "ping",
      })
    );
  }, 20_000);

  it("rejects a roots/list result with a huge array without aborting the SSE server", async () => {
    const { child, port } = await startServer("sse");
    const session = await openSseSession(port, {
      roots: { listChanged: true },
    });
    const request = await readMessages(
      session.events,
      (message) => message.method === "roots/list",
      4_000
    );
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { roots: zeros(ROOTS_ELEMENTS) },
    });
    expect(body.length).toBeLessThan(FOUR_MIB);

    try {
      const reply = await fetch(
        `http://127.0.0.1:${port}/message?sessionId=${session.sessionId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }
      );
      await reply.text().catch(() => undefined);
    } catch {
      // A crash closes the socket before a response is written.
    }

    await delay(300);
    expect(
      isAlive(child),
      "server process aborted while validating one HTTP body under 4 MiB"
    ).toBe(true);
    const posted = await session.post({
      jsonrpc: "2.0",
      id: 99,
      method: "ping",
    });
    expect(posted.status).toBe(202);
    const result = await readMessages(
      session.events,
      (message) => message.id === 99,
      4_000
    );
    expect(result.result).toEqual({});
    expect(isAlive(child)).toBe(true);
  }, 20_000);

  it("rejects an elicitation result with a huge array without aborting the SSE server", async () => {
    const { child, port } = await startServer("sse");
    const session = await openSseSession(port, {
      elicitation: { form: {} },
    });
    await delay(400);
    const call = await session.post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "trigger-elicitation-request", arguments: {} },
    });
    expect(call.status).toBe(202);
    const request = await readMessages(
      session.events,
      (message) => message.method === "elicitation/create",
      4_000
    );
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        action: "accept",
        content: { field: zeros(ELICIT_ELEMENTS) },
      },
    });
    expect(body.length).toBeLessThan(FOUR_MIB);

    try {
      const reply = await fetch(
        `http://127.0.0.1:${port}/message?sessionId=${session.sessionId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }
      );
      await reply.text().catch(() => undefined);
    } catch {
      // A crash closes the socket before a response is written.
    }

    await delay(300);
    expect(
      isAlive(child),
      "server process aborted while validating one HTTP body under 4 MiB"
    ).toBe(true);
    const posted = await session.post({
      jsonrpc: "2.0",
      id: 99,
      method: "ping",
    });
    expect(posted.status).toBe(202);
    const result = await readMessages(
      session.events,
      (message) => message.id === 99,
      4_000
    );
    expect(result.result).toEqual({});
    expect(isAlive(child)).toBe(true);
  }, 20_000);
});
