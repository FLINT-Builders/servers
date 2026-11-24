/**
 * Spec for the simulated-research task leak.
 *
 * The caller-supplied topic is stored in a process-wide map when
 * simulate-research-query creates a task. These tests drive the real server
 * factory, the streamable HTTP transport, and the SSE transport. They fail
 * while that map (or any other server-side copy of the topic) outlives the
 * task. They pass once every abandoned, expired, cancelled, failed, or
 * collected task releases the topic, and once topic length and in-flight
 * tasks are bounded.
 *
 * Bounds the fix must enforce:
 * - topic length: at most MAX_TOPIC_LENGTH characters (8192 is accepted,
 *   8193 is rejected and not retained)
 * - in-flight research tasks per session: at most MAX_INFLIGHT_TASKS (8)
 *
 * Run with a garbage collector the test can invoke:
 *   NODE_OPTIONS=--expose-gc npx vitest run --coverage.enabled=false __tests__/research-task-retention.test.ts
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server/index.js";

const MAX_TOPIC_LENGTH = 8192;
const MAX_INFLIGHT_TASKS = 8;
const PROTOCOL_VERSION = "2025-11-25";
const TOOL_NAME = "simulate-research-query";

const serversToClose: http.Server[] = [];

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await Promise.all(
    serversToClose.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe("simulate-research-query task retention", () => {
  it("releases the topic when session cleanup runs after the task is abandoned", async () => {
    const session = await openInProcessSession();
    const marker = await session.abandonTask(topicOfLength(64));
    await session.close();
    expect(await markerIsRetained(marker)).toBe(true);

    session.cleanup();
    await vi.advanceTimersByTimeAsync(1_600);
    vi.useRealTimers();

    expect(await markerIsRetained(marker)).toBe(false);
  });

  it("releases the topic when the task record expires without tasks/result", async () => {
    const session = await openInProcessSession();
    const marker = await session.abandonTask(topicOfLength(64));
    // Four 1s stages, then the 5 minute TTL armed at completion.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(300_000);
    await session.close();
    vi.useRealTimers();

    expect(await markerIsRetained(marker)).toBe(false);
  });

  it("releases the topic when a cancelled task expires without tasks/result", async () => {
    const session = await openInProcessSession();
    const marker = await session.abandonTask(topicOfLength(64));
    await session.client.experimental.tasks.cancelTask(session.lastTaskId);
    await vi.advanceTimersByTimeAsync(301_000);
    await session.close();
    vi.useRealTimers();

    expect(await markerIsRetained(marker)).toBe(false);
  });

  it("releases the topic after tasks/result once the task record expires", async () => {
    const session = await openInProcessSession();
    const marker = await session.abandonTask(topicOfLength(64));
    await vi.advanceTimersByTimeAsync(5_000);
    let result: unknown = await session.client.experimental.tasks.getTaskResult(
      session.lastTaskId,
      CallToolResultSchema
    );
    // The client received the report. Drop it before measuring the server.
    result = null;
    await vi.advanceTimersByTimeAsync(300_000);
    await session.close();
    vi.useRealTimers();

    expect(await markerIsRetained(marker)).toBe(false);
  });

  it("releases every abandoned topic when the streamable HTTP session ends", async () => {
    const port = await startStreamableHttp();
    const markers: Marker[] = [];
    const sessions: StreamableSession[] = [];

    for (let i = 0; i < 3; i++) {
      const opened = await openStreamableSession(port);
      const marker = rememberMarker();
      const created = await opened.callTool(
        topicWithMarker(marker, MAX_TOPIC_LENGTH)
      );
      expect(created.taskId).toEqual(expect.any(String));
      expect(created.status).toBeLessThan(400);
      markers.push(marker);
      sessions.push(opened);
    }

    expect(await retainedFlags(markers)).toEqual([true, true, true]);

    for (const opened of sessions) {
      const closed = await opened.delete();
      expect(closed).toBeLessThan(400);
    }
    await delay(1_600);

    expect(await retainedFlags(markers)).toEqual([false, false, false]);
  }, 30_000);

  it("releases an abandoned topic when the SSE client disconnects", async () => {
    const port = await startSse();
    const opened = await openSseSession(port);
    const marker = rememberMarker();
    const created = await opened.callTool(topicWithMarker(marker, 128));
    expect(created.taskId).toEqual(expect.any(String));

    expect(await markerIsRetained(marker)).toBe(true);
    opened.disconnect();
    await delay(1_600);

    expect(await markerIsRetained(marker)).toBe(false);
  }, 30_000);

  it("rejects a topic longer than 8192 characters and does not retain it", async () => {
    const port = await startStreamableHttp();
    const opened = await openStreamableSession(port);
    const marker = rememberMarker();
    const created = await opened.callTool(
      topicWithMarker(marker, MAX_TOPIC_LENGTH + 1)
    );

    expect(created.taskId).toBeUndefined();
    await opened.delete();
    await delay(1_600);
    expect(await markerIsRetained(marker)).toBe(false);
  }, 30_000);

  it("rejects a ninth in-flight research task on the same session", async () => {
    const port = await startStreamableHttp();
    const opened = await openStreamableSession(port);
    const markers: Marker[] = [];

    for (let i = 0; i < MAX_INFLIGHT_TASKS; i++) {
      const marker = rememberMarker();
      const created = await opened.callTool(topicWithMarker(marker, 64));
      expect(created.taskId).toEqual(expect.any(String));
      markers.push(marker);
    }

    const overflow = rememberMarker();
    const rejected = await opened.callTool(topicWithMarker(overflow, 64));
    expect(rejected.taskId).toBeUndefined();

    await opened.delete();
    await delay(1_600);
    expect(await retainedFlags([...markers, overflow])).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  }, 30_000);
});

type Marker = { file: string };

function rememberMarker(): Marker {
  const marker = randomUUID();
  const file = path.join(
    os.tmpdir(),
    `research-marker-${process.pid}-${randomUUID()}.txt`
  );
  fs.writeFileSync(file, marker);
  return { file };
}

function topicOfLength(length: number): { text: string; marker: Marker } {
  const marker = rememberMarker();
  return { text: topicWithMarker(marker, length), marker };
}

function topicWithMarker(marker: Marker, length: number): string {
  const id = fs.readFileSync(marker.file, "utf8");
  if (id.length >= length) {
    return id.slice(0, length);
  }
  return id + "A".repeat(length - id.length);
}

function requireGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) {
    throw new Error(
      "This test needs the garbage collector. Run node with --expose-gc."
    );
  }
  return gc;
}

async function collectGarbage(): Promise<void> {
  const gc = requireGc();
  gc();
  await new Promise((resolve) => setImmediate(resolve));
  gc();
}

async function markerIsRetained(marker: Marker): Promise<boolean> {
  const [retained] = await retainedFlags([marker]);
  return retained;
}

async function retainedFlags(markers: Marker[]): Promise<boolean[]> {
  await collectGarbage();
  const snapshotPath = path.join(
    os.tmpdir(),
    `research-heap-${process.pid}-${randomUUID()}.heapsnapshot`
  );
  v8.writeHeapSnapshot(snapshotPath);
  const snapshot = fs.readFileSync(snapshotPath);
  fs.unlinkSync(snapshotPath);
  return markers.map((marker) =>
    snapshot.includes(fs.readFileSync(marker.file))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type InProcessSession = {
  client: Client;
  lastTaskId: string;
  abandonTask: (topic: { text: string; marker: Marker }) => Promise<Marker>;
  cleanup: () => void;
  close: () => Promise<void>;
};

async function openInProcessSession(): Promise<InProcessSession> {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const { server, cleanup } = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "retention-test", version: "0.0.0" },
    { capabilities: {} }
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await new Promise((resolve) => setImmediate(resolve));

  const listed = await client.request(
    { method: "tools/list", params: {} },
    ListToolsResultSchema
  );
  if (!listed.tools.some((tool) => tool.name === TOOL_NAME)) {
    throw new Error(`${TOOL_NAME} was not registered after initialize`);
  }

  let lastTaskId = "";
  return {
    client,
    get lastTaskId() {
      return lastTaskId;
    },
    async abandonTask(topic) {
      const created = await client.request(
        {
          method: "tools/call",
          params: {
            name: TOOL_NAME,
            arguments: { topic: topic.text, ambiguous: false },
            task: {},
          },
        },
        CreateTaskResultSchema,
        { task: {} }
      );
      lastTaskId = created.task.taskId;
      topic.text = "";
      return topic.marker;
    },
    cleanup,
    async close() {
      await client.close();
    },
  };
}

type ToolCallOutcome = { status: number; taskId?: string };

type StreamableSession = {
  callTool: (topic: string) => Promise<ToolCallOutcome>;
  delete: () => Promise<number>;
};

async function startStreamableHttp(): Promise<number> {
  if (streamablePort) return streamablePort;
  const port = await freePort();
  process.env.PORT = String(port);
  await import("../transports/streamableHttp.js");
  streamablePort = port;
  rememberListeningServer(port);
  await waitForPort(port);
  return port;
}

async function startSse(): Promise<number> {
  if (ssePort) return ssePort;
  const port = await freePort();
  process.env.PORT = String(port);
  await import("../transports/sse.js");
  ssePort = port;
  rememberListeningServer(port);
  await waitForPort(port);
  return port;
}

let streamablePort: number | undefined;
let ssePort: number | undefined;

function rememberListeningServer(port: number): void {
  const handles = (
    process as unknown as { _getActiveHandles: () => unknown[] }
  )._getActiveHandles();
  for (const handle of handles) {
    const server = handle as http.Server;
    if (typeof server.address !== "function" || !server.listening) continue;
    const address = server.address();
    if (address && typeof address === "object" && address.port === port) {
      serversToClose.push(server);
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

function waitForPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const socket = http.request({
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/",
      });
      socket.once("response", (res) => {
        res.resume();
        resolve();
      });
      socket.once("error", () => {
        if (Date.now() - started > 5_000) {
          reject(new Error(`server did not listen on ${port}`));
          return;
        }
        setTimeout(attempt, 20);
      });
      socket.end();
    };
    attempt();
  });
}

async function openStreamableSession(port: number): Promise<StreamableSession> {
  const init = await postMcp(port, "/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "retention-test", version: "0.0.0" },
    },
  });
  expect(init.status).toBe(200);
  const sessionId = header(init.headers, "mcp-session-id");
  if (!sessionId) throw new Error("streamable HTTP did not assign a session");

  const initialized = await postMcp(
    port,
    "/mcp",
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId
  );
  expect(initialized.status).toBe(202);

  const listed = await postMcp(
    port,
    "/mcp",
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId
  );
  expect(listed.status).toBe(200);
  const listBody = listed.body;
  if (!listBody.includes(TOOL_NAME)) {
    throw new Error(`${TOOL_NAME} was not registered after initialize`);
  }

  let nextId = 3;
  return {
    async callTool(topic: string) {
      const id = nextId++;
      const response = await postMcp(
        port,
        "/mcp",
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: TOOL_NAME,
            arguments: { topic, ambiguous: false },
            task: {},
          },
        },
        sessionId
      );
      return { status: response.status, taskId: taskIdFrom(response.body, id) };
    },
    async delete() {
      const response = await request({
        host: "127.0.0.1",
        port,
        method: "DELETE",
        path: "/mcp",
        headers: sessionHeaders(sessionId),
      });
      return response.status;
    },
  };
}

type SseSession = {
  callTool: (topic: string) => Promise<ToolCallOutcome>;
  disconnect: () => void;
};

async function openSseSession(port: number): Promise<SseSession> {
  const stream = await openSseStream(port);
  const endpoint = await stream.endpoint();
  let nextId = 1;

  const post = async (message: unknown) => {
    const response = await request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: endpoint,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(message),
    });
    if (response.status !== 202) {
      throw new Error(`SSE post failed with status ${response.status}`);
    }
  };

  await post({
    jsonrpc: "2.0",
    id: nextId,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "retention-test", version: "0.0.0" },
    },
  });
  const initId = nextId++;
  const initialized = await stream.waitForResponse(initId);
  if (!initialized) throw new Error("SSE initialize failed");

  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  await new Promise((resolve) => setImmediate(resolve));

  await post({ jsonrpc: "2.0", id: nextId, method: "tools/list", params: {} });
  const listId = nextId++;
  const listed = await stream.waitForResponse(listId);
  if (!listed || !JSON.stringify(listed).includes(TOOL_NAME)) {
    throw new Error(`${TOOL_NAME} was not registered after initialize`);
  }

  return {
    async callTool(topic: string) {
      const id = nextId++;
      await post({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: TOOL_NAME,
          arguments: { topic, ambiguous: false },
          task: {},
        },
      });
      const message = await stream.waitForResponse(id);
      const taskId =
        message &&
        typeof message === "object" &&
        "result" in message &&
        message.result &&
        typeof message.result === "object" &&
        "task" in message.result &&
        message.result.task &&
        typeof message.result.task === "object" &&
        "taskId" in message.result.task &&
        typeof message.result.task.taskId === "string"
          ? message.result.task.taskId
          : undefined;
      return { status: 202, taskId };
    },
    disconnect() {
      stream.close();
    },
  };
}

function openSseStream(port: number): Promise<SseStream> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/sse",
        headers: { accept: "text/event-stream" },
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`SSE connect failed with status ${res.statusCode}`));
          res.resume();
          return;
        }
        resolve(new SseStream(req, res));
      }
    );
    req.once("error", reject);
    req.end();
  });
}

class SseStream {
  private buffer = "";
  private endpointPath: string | undefined;
  private messages: unknown[] = [];
  private waiters: Array<() => void> = [];

  constructor(
    private readonly req: http.ClientRequest,
    res: http.IncomingMessage
  ) {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
  }

  async endpoint(): Promise<string> {
    const started = Date.now();
    while (!this.endpointPath) {
      if (Date.now() - started > 5_000) {
        throw new Error("SSE endpoint event was not received");
      }
      await this.nextChunk();
    }
    return this.endpointPath;
  }

  async waitForResponse(id: number): Promise<unknown> {
    const started = Date.now();
    for (;;) {
      const found = this.messages.find(
        (message) =>
          message &&
          typeof message === "object" &&
          "id" in message &&
          message.id === id
      );
      if (found) return found;
      if (Date.now() - started > 5_000) {
        throw new Error(`timed out waiting for SSE response ${id}`);
      }
      await this.nextChunk();
    }
  }

  close(): void {
    this.req.destroy();
  }

  private nextChunk(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private drain(): void {
    let split = this.buffer.indexOf("\n\n");
    while (split !== -1) {
      const block = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      this.consume(block);
      split = this.buffer.indexOf("\n\n");
    }
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) waiter();
  }

  private consume(block: string): void {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event === "endpoint") {
      this.endpointPath = data;
      return;
    }
    if (!data) return;
    try {
      this.messages.push(JSON.parse(data));
    } catch {
      // Priming events and non-JSON frames are not task results.
    }
  }
}

type HttpResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

function sessionHeaders(sessionId: string): http.OutgoingHttpHeaders {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": sessionId,
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
}

function header(
  headers: http.IncomingHttpHeaders,
  name: string
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

async function postMcp(
  port: number,
  requestPath: string,
  message: unknown,
  sessionId?: string
): Promise<HttpResult> {
  return request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: requestPath,
    headers: sessionId
      ? sessionHeaders(sessionId)
      : {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
    body: JSON.stringify(message),
  });
}

function request(options: {
  host: string;
  port: number;
  method: string;
  path: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.once("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function taskIdFrom(body: string, id: number): string | undefined {
  for (const message of sseMessages(body)) {
    if (!message || typeof message !== "object" || !("id" in message)) continue;
    if (message.id !== id) continue;
    if (
      !("result" in message) ||
      !message.result ||
      typeof message.result !== "object"
    ) {
      return undefined;
    }
    if (
      !("task" in message.result) ||
      !message.result.task ||
      typeof message.result.task !== "object"
    ) {
      return undefined;
    }
    if (!("taskId" in message.result.task)) return undefined;
    const taskId = message.result.task.taskId;
    return typeof taskId === "string" ? taskId : undefined;
  }
  return undefined;
}

function sseMessages(body: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        // Ignore priming frames.
      }
    }
  }
  return messages;
}
