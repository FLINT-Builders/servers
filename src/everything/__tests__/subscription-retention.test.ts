import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Spec for resource-subscription storage in the everything server.
 *
 * A client that can reach the HTTP transports supplies the URIs. The server
 * must not keep those URIs after the subscriber is gone, and it must refuse
 * to store more than the limits below. This file fails until that is true.
 *
 * MAX_RESOURCE_SUBSCRIPTIONS is the maximum number of (session, URI) pairs
 * stored in the process at once. Subscribing the same session to the same URI
 * again does not add a pair. When the last subscriber of a URI is removed,
 * the URI itself must be released.
 *
 * MAX_RESOURCE_SUBSCRIPTION_URI_LENGTH is the maximum accepted URI length in
 * UTF-16 code units. A longer URI is rejected, is not stored, and is not
 * copied into the response.
 */
const MAX_RESOURCE_SUBSCRIPTIONS = 32;
const MAX_RESOURCE_SUBSCRIPTION_URI_LENGTH = 2048;

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const repoRoot = resolve(serverRoot, "../..");

const JSON_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: { uri?: string };
}

interface HttpResult {
  status: number;
  text: string;
  messages: RpcMessage[];
  sessionId?: string;
}

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  children.length = 0;
});

beforeAll(async () => {
  await execFileAsync(
    process.execPath,
    [
      resolve(repoRoot, "node_modules/typescript/bin/tsc"),
      "-p",
      serverRoot,
      "--pretty",
      "false",
    ],
    { cwd: repoRoot }
  );
}, 60000);

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function parseSse(text: string): RpcMessage[] {
  const messages: RpcMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      messages.push(JSON.parse(data) as RpcMessage);
    } catch {
      // Priming events and non-JSON SSE fields are ignored.
    }
  }
  return messages;
}

function succeeded(result: HttpResult, id: number): boolean {
  const delivered = result.status === 200 || result.status === 202;
  return (
    delivered &&
    result.messages.some(
      (message) =>
        message.id === id &&
        message.error === undefined &&
        message.result !== undefined
    )
  );
}

function rejectedWithoutToken(result: HttpResult, token: string): boolean {
  if (result.text.includes(token)) return false;
  if (result.status >= 400) return true;
  return (
    result.messages.some((message) => message.error !== undefined) &&
    !succeeded(result, messageId(result.messages))
  );
}

function messageId(messages: RpcMessage[]): number {
  const withId = messages.find((message) => message.id !== undefined);
  return withId?.id ?? -1;
}

function uriOfLength(token: string, length: number): string {
  const prefix = `demo://sub/${token}/`;
  if (prefix.length > length) {
    throw new Error(`token prefix is longer than ${length}`);
  }
  return prefix + "a".repeat(length - prefix.length);
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolvePromise, reject) => {
    probe.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
  return port;
}

interface Inspector {
  send(method: string, params?: unknown): Promise<unknown>;
  on(
    listener: (message: {
      method?: string;
      params?: { chunk?: string; finished?: boolean };
    }) => void
  ): void;
  close(): void;
}

declare const WebSocket: {
  new (url: string): {
    addEventListener(
      type: "open" | "error" | "message",
      listener: (event: { data?: unknown }) => void
    ): void;
    send(data: string): void;
    close(): void;
  };
};

function connectInspector(url: string): Promise<Inspector> {
  const ws = new WebSocket(url);
  return new Promise((resolvePromise, reject) => {
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    const listeners: Array<
      (message: {
        method?: string;
        params?: { chunk?: string; finished?: boolean };
      }) => void
    > = [];
    let nextId = 1;
    ws.addEventListener("error", () => {
      reject(new Error(`inspector connection failed for ${url}`));
    });
    ws.addEventListener("open", () => {
      resolvePromise({
        send(method: string, params?: unknown) {
          const id = nextId++;
          return new Promise((resolveSend, rejectSend) => {
            pending.set(id, { resolve: resolveSend, reject: rejectSend });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(listener) {
          listeners.push(listener);
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw) return;
      const message = JSON.parse(raw) as {
        id?: number;
        error?: { message?: string };
        result?: unknown;
        method?: string;
        params?: { chunk?: string; finished?: boolean };
      };
      if (message.id !== undefined && pending.has(message.id)) {
        const slot = pending.get(message.id);
        pending.delete(message.id);
        if (message.error)
          slot?.reject(new Error(message.error.message ?? "inspector error"));
        else slot?.resolve(message.result);
        return;
      }
      for (const listener of listeners) listener(message);
    });
  });
}

class ProductServer {
  private inspectorUrl = "";
  private output = "";

  private constructor(
    private readonly child: ChildProcess,
    readonly port: number
  ) {
    children.push(child);
  }

  static async start(
    entry: "streamableHttp.js" | "sse.js"
  ): Promise<ProductServer> {
    const port = await freePort();
    const child = spawnServer(entry, port);
    const server = new ProductServer(child, port);
    child.stdout?.on("data", (chunk: Buffer) => {
      server.output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      server.output += text;
      const match = text.match(/ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+/);
      if (match) server.inspectorUrl = match[0];
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`server exited ${child.exitCode}\n${server.output}`);
      }
      if (server.inspectorUrl && (await portAccepts(port))) return server;
      await delay(30);
    }
    throw new Error(`server did not listen\n${server.output}`);
  }

  logTail(): string {
    return this.output.slice(-2000);
  }

  async heapHas(token: string): Promise<boolean> {
    if (!this.inspectorUrl) throw new Error("missing inspector url");
    const inspector = await connectInspector(this.inspectorUrl);
    try {
      await inspector.send("HeapProfiler.enable");
      await inspector.send("HeapProfiler.collectGarbage");
      const chunks: string[] = [];
      let settled = false;
      const finished = new Promise<void>((resolvePromise, reject) => {
        const timer = setTimeout(
          () => reject(new Error("heap snapshot timed out")),
          20000
        );
        inspector.on((message) => {
          if (
            message.method === "HeapProfiler.addHeapSnapshotChunk" &&
            message.params?.chunk
          ) {
            chunks.push(message.params.chunk);
          }
          if (
            message.method === "HeapProfiler.reportHeapSnapshotProgress" &&
            message.params?.finished &&
            !settled
          ) {
            settled = true;
            clearTimeout(timer);
            resolvePromise();
          }
        });
      });
      await inspector.send("HeapProfiler.takeHeapSnapshot", {
        reportProgress: true,
      });
      await finished;
      return chunks.join("").includes(token);
    } finally {
      inspector.close();
    }
  }

  async waitForLog(text: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (this.output.includes(text)) return;
      await delay(20);
    }
    throw new Error(`log never contained ${text}\n${this.logTail()}`);
  }
}

function spawnServer(entry: string, port: number): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--expose-gc",
      "--inspect=127.0.0.1:0",
      resolve(serverRoot, "dist/transports", entry),
    ],
    {
      cwd: serverRoot,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

async function portAccepts(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "GET",
    });
    await response.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/sse`, {
        headers: { accept: "text/event-stream" },
        signal: AbortSignal.timeout(200),
      });
      await response.body?.cancel();
      return response.status !== 0;
    } catch {
      return false;
    }
  }
}

class StreamableClient {
  private nextId = 1;

  private constructor(
    private readonly port: number,
    private sessionId?: string
  ) {}

  static async connect(port: number): Promise<StreamableClient> {
    const client = new StreamableClient(port);
    const init = await client.post("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "subscription-retention", version: "0" },
    });
    if (!init.sessionId) {
      throw new Error(
        `initialize did not return a session\n${init.status} ${init.text.slice(
          0,
          300
        )}`
      );
    }
    client.sessionId = init.sessionId;
    await client.notify("notifications/initialized");
    return client;
  }

  async post(
    method: string,
    params: unknown,
    id = this.nextId++
  ): Promise<HttpResult> {
    const response = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        ...(this.sessionId
          ? {
              "mcp-session-id": this.sessionId,
              "mcp-protocol-version": "2025-03-26",
            }
          : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      messages: parseSse(text),
      sessionId: response.headers.get("mcp-session-id") ?? undefined,
    };
  }

  async notify(method: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        ...(this.sessionId
          ? {
              "mcp-session-id": this.sessionId,
              "mcp-protocol-version": "2025-03-26",
            }
          : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method }),
    });
    await response.arrayBuffer().catch(() => undefined);
  }

  async subscribe(uri: string): Promise<HttpResult> {
    return this.post("resources/subscribe", { uri });
  }

  async unsubscribe(uri: string): Promise<HttpResult> {
    return this.post("resources/unsubscribe", { uri });
  }

  async postBatch(
    messages: Array<{ id: number; method: string; params: unknown }>
  ): Promise<HttpResult> {
    const response = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        "mcp-session-id": this.sessionId ?? "",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify(
        messages.map((message) => ({ jsonrpc: "2.0", ...message }))
      ),
    });
    const text = await response.text();
    return { status: response.status, text, messages: parseSse(text) };
  }

  async close(): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: "DELETE",
      headers: {
        "mcp-session-id": this.sessionId ?? "",
        "mcp-protocol-version": "2025-03-26",
      },
    });
    if (response.status !== 200) {
      const text = await response.text();
      throw new Error(`session close failed ${response.status} ${text}`);
    }
    await response.arrayBuffer().catch(() => undefined);
  }

  async listen(): Promise<{ text: () => string; cancel: () => Promise<void> }> {
    const response = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": this.sessionId ?? "",
        "mcp-protocol-version": "2025-03-26",
      },
    });
    if (response.status !== 200 || !response.body) {
      throw new Error(`GET /mcp failed ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const pump = (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    })();
    pump.catch(() => undefined);
    return {
      text: () => buffered,
      cancel: async () => {
        await reader.cancel().catch(() => undefined);
        await pump.catch(() => undefined);
      },
    };
  }
}

class SseClient {
  private nextId = 1;
  private buffered = "";
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private readonly decoder = new TextDecoder();

  private constructor(
    private readonly port: number,
    private readonly sessionId: string
  ) {}

  static async connect(port: number): Promise<SseClient> {
    const response = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { accept: "text/event-stream" },
    });
    if (!response.body) throw new Error("SSE response had no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let sessionId = "";
    const deadline = Date.now() + 5000;
    while (!sessionId && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      const match = buffered.match(/sessionId=([0-9a-f-]+)/);
      if (match) sessionId = match[1];
    }
    if (!sessionId)
      throw new Error(
        `SSE endpoint missing session id\n${buffered.slice(0, 300)}`
      );
    const client = new SseClient(port, sessionId);
    client.reader = reader;
    client.buffered = buffered;
    client.pump();
    await client.post("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "subscription-retention", version: "0" },
    });
    await client.notify("notifications/initialized");
    return client;
  }

  private pump(): void {
    const reader = this.reader;
    if (!reader) return;
    const run = async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        this.buffered += this.decoder.decode(chunk.value, { stream: true });
      }
    };
    run().catch(() => undefined);
  }

  async post(
    method: string,
    params: unknown,
    id = this.nextId++
  ): Promise<HttpResult> {
    const started = this.buffered.length;
    const response = await fetch(
      `http://127.0.0.1:${this.port}/message?sessionId=${this.sessionId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }
    );
    const postText = await response.text();
    if (response.status >= 400) {
      return {
        status: response.status,
        text: postText,
        messages: parseSse(postText),
      };
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const messages = parseSse(this.buffered.slice(started));
      if (messages.some((message) => message.id === id)) {
        return {
          status: response.status,
          text: this.buffered.slice(started),
          messages,
        };
      }
      await delay(15);
    }
    return {
      status: response.status,
      text: this.buffered.slice(started),
      messages: parseSse(this.buffered.slice(started)),
    };
  }

  async notify(method: string): Promise<void> {
    const response = await fetch(
      `http://127.0.0.1:${this.port}/message?sessionId=${this.sessionId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method }),
      }
    );
    await response.arrayBuffer().catch(() => undefined);
  }

  async subscribe(uri: string): Promise<HttpResult> {
    return this.post("resources/subscribe", { uri });
  }

  text(): string {
    return this.buffered;
  }

  async disconnect(): Promise<void> {
    await this.reader?.cancel().catch(() => undefined);
  }
}

async function fillSubscriptions(
  subscribe: (uri: string) => Promise<HttpResult>,
  count: number,
  prefix: string
): Promise<string[]> {
  const uris: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const uri = `demo://cap/${prefix}/${index}`;
    const result = await subscribe(uri);
    expect(
      succeeded(result, messageId(result.messages)),
      result.text.slice(0, 300)
    ).toBe(true);
    uris.push(uri);
  }
  return uris;
}

describe("resource subscription retention", () => {
  it("drops only the closed streamable HTTP session and still notifies the session that remains", async () => {
    const server = await ProductServer.start("streamableHttp.js");
    const closedToken = `closed${Math.random().toString(36).slice(2)}`;
    const liveToken = `live${Math.random().toString(36).slice(2)}`;
    const closed = await StreamableClient.connect(server.port);
    const live = await StreamableClient.connect(server.port);
    const closedResult = await closed.subscribe(`demo://closed/${closedToken}`);
    const liveResult = await live.subscribe(`demo://live/${liveToken}`);
    expect(succeeded(closedResult, messageId(closedResult.messages))).toBe(
      true
    );
    expect(succeeded(liveResult, messageId(liveResult.messages))).toBe(true);

    const updates = await live.listen();
    await closed.close();
    await server.waitForLog("Transport closed");
    expect(await server.heapHas(closedToken)).toBe(false);

    const call = await live.post("tools/call", {
      name: "toggle-subscriber-updates",
      arguments: {},
    });
    expect(
      succeeded(call, messageId(call.messages)),
      call.text.slice(0, 400)
    ).toBe(true);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !updates.text().includes(liveToken)) {
      await delay(20);
    }
    expect(updates.text().includes(liveToken)).toBe(true);
    expect(updates.text().includes(closedToken)).toBe(false);
    await updates.cancel();
  }, 30000);

  it("caps streamable HTTP subscriptions, rejects oversized URIs, and frees slots when the session ends", async () => {
    const server = await ProductServer.start("streamableHttp.js");
    const client = await StreamableClient.connect(server.port);
    const oversizedToken = `over${Math.random().toString(36).slice(2)}`;
    const oversized = await client.subscribe(
      uriOfLength(oversizedToken, MAX_RESOURCE_SUBSCRIPTION_URI_LENGTH + 1)
    );
    expect(
      rejectedWithoutToken(oversized, oversizedToken),
      oversized.text.slice(0, 400)
    ).toBe(true);

    const boundary = await client.subscribe(
      uriOfLength("boundary", MAX_RESOURCE_SUBSCRIPTION_URI_LENGTH)
    );
    expect(
      succeeded(boundary, messageId(boundary.messages)),
      boundary.text.slice(0, 300)
    ).toBe(true);

    await fillSubscriptions(
      (uri) => client.subscribe(uri),
      MAX_RESOURCE_SUBSCRIPTIONS - 1,
      "stream"
    );
    const extra = await client.subscribe("demo://cap/stream/extra");
    expect(rejectedWithoutToken(extra, "extra"), extra.text.slice(0, 300)).toBe(
      true
    );

    await client.close();
    const again = await StreamableClient.connect(server.port);
    const renewed = await again.subscribe("demo://cap/stream/renewed");
    expect(
      succeeded(renewed, messageId(renewed.messages)),
      renewed.text.slice(0, 300)
    ).toBe(true);
    await again.close();
    expect(await server.heapHas(oversizedToken)).toBe(false);
  }, 30000);

  it("does not consume a subscription slot when the same session repeats a URI", async () => {
    const server = await ProductServer.start("streamableHttp.js");
    const client = await StreamableClient.connect(server.port);
    const repeated = "demo://cap/repeat/same";
    for (let index = 0; index < MAX_RESOURCE_SUBSCRIPTIONS + 8; index += 1) {
      const result = await client.subscribe(repeated);
      expect(
        succeeded(result, messageId(result.messages)),
        result.text.slice(0, 200)
      ).toBe(true);
    }
    await fillSubscriptions(
      (uri) => client.subscribe(uri),
      MAX_RESOURCE_SUBSCRIPTIONS - 1,
      "repeat"
    );
    const extra = await client.subscribe("demo://cap/repeat/extra");
    expect(rejectedWithoutToken(extra, "extra"), extra.text.slice(0, 300)).toBe(
      true
    );
  }, 30000);

  it("frees a streamable HTTP subscription slot on unsubscribe", async () => {
    const server = await ProductServer.start("streamableHttp.js");
    const client = await StreamableClient.connect(server.port);
    const uris = await fillSubscriptions(
      (uri) => client.subscribe(uri),
      MAX_RESOURCE_SUBSCRIPTIONS,
      "unsub"
    );
    const blocked = await client.subscribe("demo://cap/unsub/blocked");
    expect(
      rejectedWithoutToken(blocked, "blocked"),
      blocked.text.slice(0, 300)
    ).toBe(true);
    const removed = await client.unsubscribe(uris[0]);
    expect(
      succeeded(removed, messageId(removed.messages)),
      removed.text.slice(0, 300)
    ).toBe(true);
    const replacement = await client.subscribe("demo://cap/unsub/replacement");
    expect(
      succeeded(replacement, messageId(replacement.messages)),
      replacement.text.slice(0, 300)
    ).toBe(true);
  }, 30000);

  it("caps a batch of subscribe requests on one streamable HTTP call", async () => {
    const server = await ProductServer.start("streamableHttp.js");
    const client = await StreamableClient.connect(server.port);
    const messages = Array.from(
      { length: MAX_RESOURCE_SUBSCRIPTIONS + 8 },
      (_, index) => ({
        id: 100 + index,
        method: "resources/subscribe",
        params: { uri: `demo://batch/${index}` },
      })
    );
    const result = await client.postBatch(messages);
    const successes = result.messages.filter(
      (message) => message.error === undefined && message.result !== undefined
    );
    const failures = result.messages.filter(
      (message) => message.error !== undefined
    );
    expect(successes).toHaveLength(MAX_RESOURCE_SUBSCRIPTIONS);
    expect(failures).toHaveLength(8);
  }, 30000);

  it("caps subscriptions across concurrent streamable HTTP sessions", async () => {
    const server = await ProductServer.start("streamableHttp.js");
    const first = await StreamableClient.connect(server.port);
    const second = await StreamableClient.connect(server.port);
    const attempts = await Promise.all([
      ...Array.from({ length: MAX_RESOURCE_SUBSCRIPTIONS }, (_, index) =>
        first.subscribe(`demo://parallel/a/${index}`)
      ),
      ...Array.from({ length: MAX_RESOURCE_SUBSCRIPTIONS }, (_, index) =>
        second.subscribe(`demo://parallel/b/${index}`)
      ),
    ]);
    const successes = attempts.filter((result) =>
      succeeded(result, messageId(result.messages))
    );
    const failures = attempts.filter(
      (result) => !succeeded(result, messageId(result.messages))
    );
    expect(successes).toHaveLength(MAX_RESOURCE_SUBSCRIPTIONS);
    expect(failures).toHaveLength(MAX_RESOURCE_SUBSCRIPTIONS);
    for (const failure of failures) {
      expect(
        failure.messages.some((message) => message.error !== undefined) ||
          failure.status >= 400
      ).toBe(true);
    }
  }, 30000);

  it("drops only the disconnected SSE session and still notifies the session that remains", async () => {
    const server = await ProductServer.start("sse.js");
    const closedToken = `sseclosed${Math.random().toString(36).slice(2)}`;
    const liveToken = `sselive${Math.random().toString(36).slice(2)}`;
    const closed = await SseClient.connect(server.port);
    const live = await SseClient.connect(server.port);
    const closedResult = await closed.subscribe(`demo://sse/${closedToken}`);
    const liveResult = await live.subscribe(`demo://sse/${liveToken}`);
    expect(
      succeeded(closedResult, messageId(closedResult.messages)),
      closedResult.text.slice(0, 300)
    ).toBe(true);
    expect(
      succeeded(liveResult, messageId(liveResult.messages)),
      liveResult.text.slice(0, 300)
    ).toBe(true);
    const mark = live.text().length;
    await closed.disconnect();
    await server.waitForLog("Client Disconnected");
    expect(await server.heapHas(closedToken)).toBe(false);

    const call = await live.post("tools/call", {
      name: "toggle-subscriber-updates",
      arguments: {},
    });
    expect(
      succeeded(call, messageId(call.messages)),
      call.text.slice(0, 400)
    ).toBe(true);
    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      !live.text().slice(mark).includes(liveToken)
    ) {
      await delay(20);
    }
    expect(live.text().slice(mark).includes(liveToken)).toBe(true);
    expect(live.text().slice(mark).includes(closedToken)).toBe(false);
    await live.disconnect();
  }, 30000);

  it("rejects an oversized URI and the subscription past the cap on SSE", async () => {
    const server = await ProductServer.start("sse.js");
    const client = await SseClient.connect(server.port);
    const oversizedToken = `sseover${Math.random().toString(36).slice(2)}`;
    const oversized = await client.subscribe(
      uriOfLength(oversizedToken, MAX_RESOURCE_SUBSCRIPTION_URI_LENGTH + 1)
    );
    expect(
      rejectedWithoutToken(oversized, oversizedToken),
      oversized.text.slice(0, 400)
    ).toBe(true);
    await fillSubscriptions(
      (uri) => client.subscribe(uri),
      MAX_RESOURCE_SUBSCRIPTIONS,
      "sse"
    );
    const extra = await client.subscribe("demo://cap/sse/extra");
    expect(rejectedWithoutToken(extra, "extra"), extra.text.slice(0, 300)).toBe(
      true
    );
    await client.disconnect();
    await server.waitForLog("Client Disconnected");
    expect(await server.heapHas(oversizedToken)).toBe(false);
  }, 30000);
});
