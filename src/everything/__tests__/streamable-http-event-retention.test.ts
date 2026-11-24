import http from "node:http";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Bounds a fixed streamable HTTP transport must enforce.
 * The current InMemoryEventStore keeps every event for the life of the
 * session, so these tests fail until retention is capped.
 */
const MAX_RETAINED_EVENTS = 32;
const MAX_EVENT_UTF8_BYTES = 64 * 1024;
const PROTOCOL_VERSION = "2025-11-25";

type SseEvent = { id?: string; data: string };

let baseUrl: string;

async function reservePort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to reserve a local port");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function parseSse(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let id: string | undefined;
    const dataLines: string[] = [];
    let sawData = false;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("id:")) {
        id = line.slice(3).trimStart();
      } else if (line.startsWith("data:")) {
        sawData = true;
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (id !== undefined || sawData) {
      events.push({ id, data: dataLines.join("\n") });
    }
  }
  return events;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      await response.arrayBuffer().catch(() => undefined);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(
    `Streamable HTTP server did not accept connections: ${String(lastError)}`
  );
}

async function postMessage(
  sessionId: string | undefined,
  message: unknown
): Promise<{
  status: number;
  sessionId: string | undefined;
  events: SseEvent[];
  body: string;
}> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const body = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
    events: parseSse(body),
    body,
  };
}

async function openSession(): Promise<string> {
  const initialized = await postMessage(undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "event-retention-test", version: "0.0.0" },
    },
  });
  expect(initialized.status, initialized.body).toBe(200);
  expect(initialized.sessionId, initialized.body).toBeTruthy();
  const sessionId = initialized.sessionId as string;

  const acknowledged = await postMessage(sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  expect(acknowledged.status, acknowledged.body).toBe(202);
  return sessionId;
}

async function replay(
  sessionId: string,
  lastEventId: string
): Promise<SseEvent[]> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": PROTOCOL_VERSION,
      "last-event-id": lastEventId,
    },
    signal: controller.signal,
  });
  if (response.status !== 200) {
    const failure = await response.text();
    throw new Error(`replay failed with ${response.status}: ${failure}`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Replay response had no body");
  }
  const decoder = new TextDecoder();
  let buffered = "";
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const next = reader.read();
    const outcome = await Promise.race([
      next.then((chunk) => ({ kind: "chunk" as const, chunk })),
      new Promise<{ kind: "idle" }>((resolve) =>
        setTimeout(() => resolve({ kind: "idle" }), 400)
      ),
    ]);
    if (outcome.kind === "idle") break;
    if (outcome.chunk.done) break;
    buffered += decoder.decode(outcome.chunk.value, { stream: true });
  }
  controller.abort();
  await reader.cancel().catch(() => undefined);
  return parseSse(buffered);
}

function eventMethod(event: SseEvent): string | undefined {
  if (!event.data) return undefined;
  try {
    const parsed = JSON.parse(event.data) as { method?: string };
    return parsed.method;
  } catch {
    return undefined;
  }
}

beforeAll(async () => {
  const port = await reservePort();
  process.env.PORT = String(port);
  await import("../transports/streamableHttp.js");
  baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl);
});

afterAll(async () => {
  const handles =
    (
      process as NodeJS.Process & { _getActiveHandles?: () => unknown[] }
    )._getActiveHandles?.() ?? [];
  await Promise.all(
    handles
      .filter((handle): handle is http.Server => handle instanceof http.Server)
      .map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          })
      )
  );
}, 15_000);

describe("streamable HTTP event retention", () => {
  it("caps events stored for repeated tool calls on one session", async () => {
    const sessionId = await openSession();
    const calls = 40;
    let firstEventId: string | undefined;
    for (let i = 0; i < calls; i++) {
      const response = await postMessage(sessionId, {
        jsonrpc: "2.0",
        id: i + 2,
        method: "tools/call",
        params: { name: "echo", arguments: { message: `event-${i}` } },
      });
      expect(response.status, response.body).toBe(200);
      firstEventId ??= response.events.find((event) => event.id)?.id;
    }
    expect(firstEventId).toBeTruthy();

    const replayed = await replay(sessionId, firstEventId as string);
    expect(
      replayed.length,
      `replay returned ${replayed.length} events after ${calls} echo calls`
    ).toBeLessThanOrEqual(MAX_RETAINED_EVENTS);
  }, 30_000);

  it("caps progress notifications stored for one request stream", async () => {
    const sessionId = await openSession();
    const steps = 40;
    const response = await postMessage(sessionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "trigger-long-running-operation",
        arguments: { duration: 0, steps },
        _meta: { progressToken: "retention-progress" },
      },
    });
    expect(response.status, response.body).toBe(200);
    const firstEventId = response.events.find((event) => event.id)?.id;
    expect(firstEventId).toBeTruthy();

    const replayed = await replay(sessionId, firstEventId as string);
    const progress = replayed.filter(
      (event) => eventMethod(event) === "notifications/progress"
    );
    expect(
      progress.length,
      `replay returned ${progress.length} progress notifications`
    ).toBeLessThanOrEqual(MAX_RETAINED_EVENTS);
  }, 30_000);

  it("caps standalone notifications stored without a related request", async () => {
    const sessionId = await openSession();
    const subscriptions = 40;
    let firstEventId: string | undefined;
    for (let i = 0; i < subscriptions; i++) {
      const response = await postMessage(sessionId, {
        jsonrpc: "2.0",
        id: i + 2,
        method: "resources/subscribe",
        params: { uri: `test://event-retention/${sessionId}/${i}` },
      });
      expect(response.status, response.body).toBe(200);
      firstEventId ??= response.events.find((event) => event.id)?.id;
    }

    const toggled = await postMessage(sessionId, {
      jsonrpc: "2.0",
      id: subscriptions + 2,
      method: "tools/call",
      params: { name: "toggle-subscriber-updates", arguments: {} },
    });
    expect(toggled.status, toggled.body).toBe(200);

    const replayed = await replay(sessionId, firstEventId as string);
    const updates = replayed.filter(
      (event) => eventMethod(event) === "notifications/resources/updated"
    );
    const logs = replayed.filter(
      (event) => eventMethod(event) === "notifications/message"
    );
    expect(
      updates.length,
      `replay returned ${updates.length} resource updates and ${logs.length} logging notifications`
    ).toBeLessThanOrEqual(MAX_RETAINED_EVENTS);
    expect(
      logs.length,
      `replay returned ${updates.length} resource updates and ${logs.length} logging notifications`
    ).toBeLessThanOrEqual(MAX_RETAINED_EVENTS);
  }, 30_000);

  it("caps the bytes retained for a single stored message", async () => {
    const sessionId = await openSession();
    const message = "x".repeat(MAX_EVENT_UTF8_BYTES + 4096);
    const response = await postMessage(sessionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: { message } },
    });
    expect(response.status, response.body).toBe(200);
    const firstEventId = response.events.find((event) => event.id)?.id;
    expect(firstEventId).toBeTruthy();

    const replayed = await replay(sessionId, firstEventId as string);
    const oversized = replayed.filter(
      (event) => Buffer.byteLength(event.data, "utf8") > MAX_EVENT_UTF8_BYTES
    );
    expect(
      oversized.length,
      `replay returned ${oversized.length} events larger than ${MAX_EVENT_UTF8_BYTES} bytes`
    ).toBe(0);
  }, 30_000);
});
