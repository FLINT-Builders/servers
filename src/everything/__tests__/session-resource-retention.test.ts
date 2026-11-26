/**
 * Spec for session-resource payload retention in the everything server.
 *
 * These tests fail while gzip-file-as-resource results stay pinned in the
 * process-wide session resource map after the session that created them ends.
 * They pass once a session's payloads are dropped on cleanup, other sessions
 * keep theirs, and oversized names or payloads are rejected before registration.
 *
 * Run from src/everything:
 *   npm test -- __tests__/session-resource-retention.test.ts
 *
 * `npm test` passes --expose-gc (see vitest.config.ts). The heap checks need it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSessionResourceURI } from '../resources/session.js';
import { createServer } from '../server/index.js';

/** Base64 gzip bytes the process may retain for session resources, all sessions combined. */
const MAX_RETAINED_SESSION_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Resource names longer than this must be rejected before the payload is stored. */
const MAX_SESSION_RESOURCE_NAME_LENGTH = 256;

const NEEDLE_PREFIX_BYTES = 128;
const PROTOCOL_VERSION = '2025-03-26';
const STREAMABLE_PORT = 38431;
const SSE_PORT = 38432;

const scratchDir = mkdtempSync(join(tmpdir(), 'session-resource-retention-'));

type JsonRpc = Record<string, unknown> & {
  id?: number;
  result?: ToolResult;
  error?: { message?: string };
};

type ToolResult = {
  isError?: boolean;
  content?: Array<{
    type?: string;
    uri?: string;
    resource?: { blob?: string };
  }>;
};

type ToolOutcome = {
  ok: boolean;
  uri: string;
  detail: string;
};

function gc(): void {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (!collect) {
    throw new Error(
      'global.gc is missing. Run vitest with Node --expose-gc (vitest.config.ts sets execArgv).'
    );
  }
  collect();
  collect();
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => setImmediate(() => resolve()));
  });
}

function storedPayloadBytes(raw: Buffer): number {
  return gzipSync(raw).toString('base64').length;
}

function writeNeedleFile(raw: Buffer): string {
  const blob = gzipSync(raw).toString('base64');
  const needleFile = join(scratchDir, `needle-${randomUUID()}.txt`);
  writeFileSync(needleFile, blob);
  return needleFile;
}

/**
 * True when the gzip payload for `raw` is still a live string in this process.
 * The file written here is read only after the snapshot, so the search string
 * itself is not mistaken for the server's copy.
 */
async function payloadIsRetained(raw: Buffer): Promise<boolean> {
  const needleFile = writeNeedleFile(raw);
  try {
    await settle();
    gc();
    const snapshotFile = join(scratchDir, `heap-${randomUUID()}.heapsnapshot`);
    const { writeHeapSnapshot } = await import('node:v8');
    writeHeapSnapshot(snapshotFile);
    const needle = readFileSync(needleFile).subarray(0, NEEDLE_PREFIX_BYTES);
    const snapshot = readFileSync(snapshotFile);
    rmSync(snapshotFile, { force: true });
    return snapshot.includes(needle);
  } finally {
    rmSync(needleFile, { force: true });
  }
}

function dataUriFor(raw: Buffer): string {
  return `data:application/octet-stream;base64,${raw.toString('base64')}`;
}

async function connectSession(sessionId: string | undefined): Promise<{
  server: McpServer;
  client: Client;
  cleanup: (sessionId?: string) => void;
}> {
  const { server, cleanup } = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  if (sessionId !== undefined) {
    serverTransport.sessionId = sessionId;
  }
  const client = new Client({ name: 'retention-test', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { server, client, cleanup };
}

async function callGzip(
  client: Client,
  raw: Buffer,
  name: string,
  outputType: 'resourceLink' | 'resource'
): Promise<ToolOutcome> {
  const uri = getSessionResourceURI(name);
  let result: ToolResult;
  try {
    result = (await client.callTool({
      name: 'gzip-file-as-resource',
      arguments: {
        name,
        data: dataUriFor(raw),
        outputType,
      },
    })) as ToolResult;
  } catch (error) {
    return {
      ok: false,
      uri,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.isError) {
    return { ok: false, uri, detail: JSON.stringify(result.content) };
  }
  return { ok: true, uri, detail: '' };
}

async function assertResourceReadable(
  client: Client,
  uri: string,
  raw: Buffer
): Promise<void> {
  const expected = gzipSync(raw).toString('base64');
  const read = await client.readResource({ uri });
  const blob =
    read.contents[0] && 'blob' in read.contents[0] ? read.contents[0].blob : '';
  expect(blob).toBe(expected);
}

describe(
  'session resource payload retention',
  { timeout: 120_000, hookTimeout: 30_000 },
  () => {
    describe('in-process sessions', () => {
      it('drops one session payload on cleanup and keeps the other session', async () => {
        const rawA = randomBytes(32 * 1024);
        const rawB = randomBytes(32 * 1024);
        const sessionA = await connectSession('session-a');
        const sessionB = await connectSession('session-b');

        const storedA = await callGzip(
          sessionA.client,
          rawA,
          `link-${randomUUID()}`,
          'resourceLink'
        );
        const storedB = await callGzip(
          sessionB.client,
          rawB,
          `resource-${randomUUID()}`,
          'resource'
        );
        expect(storedA.ok, storedA.detail).toBe(true);
        expect(storedB.ok, storedB.detail).toBe(true);
        await assertResourceReadable(sessionA.client, storedA.uri, rawA);
        await assertResourceReadable(sessionB.client, storedB.uri, rawB);
        expect(await payloadIsRetained(rawA)).toBe(true);
        expect(await payloadIsRetained(rawB)).toBe(true);

        sessionA.cleanup('session-a');
        await sessionA.client.close();
        await sessionA.server.close();

        expect(await payloadIsRetained(rawA)).toBe(false);
        expect(await payloadIsRetained(rawB)).toBe(true);
        await assertResourceReadable(sessionB.client, storedB.uri, rawB);

        sessionB.cleanup('session-b');
        await sessionB.client.close();
        await sessionB.server.close();
        expect(await payloadIsRetained(rawB)).toBe(false);
      });

      it('drops a sessionless payload when cleanup is called with no session id', async () => {
        const raw = randomBytes(32 * 1024);
        const session = await connectSession(undefined);
        const stored = await callGzip(
          session.client,
          raw,
          `stdio-${randomUUID()}`,
          'resourceLink'
        );
        expect(stored.ok, stored.detail).toBe(true);
        expect(await payloadIsRetained(raw)).toBe(true);

        session.cleanup();
        await session.client.close();
        await session.server.close();

        expect(await payloadIsRetained(raw)).toBe(false);
      });

      it('releases the previous payload when the same name is registered again', async () => {
        const first = randomBytes(16 * 1024);
        const second = randomBytes(16 * 1024);
        const session = await connectSession('replace-session');
        const name = `replace-${randomUUID()}`;

        const storedFirst = await callGzip(
          session.client,
          first,
          name,
          'resourceLink'
        );
        expect(storedFirst.ok, storedFirst.detail).toBe(true);
        expect(await payloadIsRetained(first)).toBe(true);

        const storedSecond = await callGzip(
          session.client,
          second,
          name,
          'resourceLink'
        );
        expect(storedSecond.ok, storedSecond.detail).toBe(true);
        expect(await payloadIsRetained(first)).toBe(false);
        expect(await payloadIsRetained(second)).toBe(true);
        await assertResourceReadable(session.client, storedSecond.uri, second);

        session.cleanup('replace-session');
        await session.client.close();
        await session.server.close();
      });

      it('rejects an oversized resource name before retaining its payload', async () => {
        const raw = randomBytes(8 * 1024);
        const session = await connectSession('name-limit');
        const name = `n${'x'.repeat(MAX_SESSION_RESOURCE_NAME_LENGTH)}`;
        expect(name.length).toBeGreaterThan(MAX_SESSION_RESOURCE_NAME_LENGTH);

        const stored = await callGzip(
          session.client,
          raw,
          name,
          'resourceLink'
        );
        expect(stored.ok).toBe(false);
        expect(await payloadIsRetained(raw)).toBe(false);

        const acceptedName = 'a'.repeat(MAX_SESSION_RESOURCE_NAME_LENGTH);
        const accepted = await callGzip(
          session.client,
          raw,
          acceptedName,
          'resource'
        );
        expect(accepted.ok, accepted.detail).toBe(true);
        expect(await payloadIsRetained(raw)).toBe(true);

        session.cleanup('name-limit');
        await session.client.close();
        await session.server.close();
      });

      it('rejects a payload that would exceed the retained-byte cap without storing it', async () => {
        const session = await connectSession('byte-cap');
        let retained = 0;
        let accepted = 0;
        let rejected = false;

        while (!rejected && accepted < 8) {
          const raw = randomBytes(2 * 1024 * 1024);
          const bytes = storedPayloadBytes(raw);
          const outcome = await callGzip(
            session.client,
            raw,
            `cap-${randomUUID()}`,
            'resourceLink'
          );
          if (retained + bytes > MAX_RETAINED_SESSION_PAYLOAD_BYTES) {
            expect(outcome.ok, outcome.detail).toBe(false);
            expect(await payloadIsRetained(raw)).toBe(false);
            rejected = true;
          } else {
            expect(outcome.ok, outcome.detail).toBe(true);
            expect(await payloadIsRetained(raw)).toBe(true);
            retained += bytes;
            accepted += 1;
          }
        }

        expect(accepted).toBeGreaterThan(0);
        expect(rejected).toBe(true);
        expect(retained).toBeLessThanOrEqual(
          MAX_RETAINED_SESSION_PAYLOAD_BYTES
        );

        session.cleanup('byte-cap');
        await session.client.close();
        await session.server.close();
      });
    });

    describe('network transports', () => {
      beforeAll(async () => {
        process.env.PORT = String(STREAMABLE_PORT);
        await import('../transports/streamableHttp.js');
        process.env.PORT = String(SSE_PORT);
        await import('../transports/sse.js');
        await waitForPort(STREAMABLE_PORT);
        await waitForPort(SSE_PORT);
      });

      afterAll(async () => {
        await closeListeningServers();
        rmSync(scratchDir, { recursive: true, force: true });
      });

      it('streamable HTTP stores each unauthenticated call until that session is deleted', async () => {
        const rawA = randomBytes(32 * 1024);
        const rawAResource = randomBytes(32 * 1024);
        const rawB = randomBytes(32 * 1024);
        const sessionA = await StreamableSession.open(STREAMABLE_PORT);
        const sessionB = await StreamableSession.open(STREAMABLE_PORT);

        const storedA = await sessionA.callGzip(
          rawA,
          `http-link-${randomUUID()}`,
          'resourceLink'
        );
        const storedAResource = await sessionA.callGzip(
          rawAResource,
          `http-resource-${randomUUID()}`,
          'resource'
        );
        const storedB = await sessionB.callGzip(
          rawB,
          `http-b-${randomUUID()}`,
          'resourceLink'
        );
        expect(storedA.ok, storedA.detail).toBe(true);
        expect(storedAResource.ok, storedAResource.detail).toBe(true);
        expect(storedB.ok, storedB.detail).toBe(true);
        expect(await payloadIsRetained(rawA)).toBe(true);
        expect(await payloadIsRetained(rawAResource)).toBe(true);
        expect(await payloadIsRetained(rawB)).toBe(true);

        await sessionA.delete();

        expect(await payloadIsRetained(rawA)).toBe(false);
        expect(await payloadIsRetained(rawAResource)).toBe(false);
        expect(await payloadIsRetained(rawB)).toBe(true);
        await sessionB.assertReadable(storedB.uri, rawB);

        await sessionB.delete();
        expect(await payloadIsRetained(rawB)).toBe(false);
      });

      it('SSE stores each unauthenticated call until that connection closes', async () => {
        const rawA = randomBytes(32 * 1024);
        const rawB = randomBytes(32 * 1024);
        const sessionA = await SseSession.open(SSE_PORT);
        const sessionB = await SseSession.open(SSE_PORT);

        const storedA = await sessionA.callGzip(
          rawA,
          `sse-a-${randomUUID()}`,
          'resourceLink'
        );
        const storedB = await sessionB.callGzip(
          rawB,
          `sse-b-${randomUUID()}`,
          'resource'
        );
        expect(storedA.ok, storedA.detail).toBe(true);
        expect(storedB.ok, storedB.detail).toBe(true);
        expect(await payloadIsRetained(rawA)).toBe(true);
        expect(await payloadIsRetained(rawB)).toBe(true);

        await sessionA.close();

        expect(await payloadIsRetained(rawA)).toBe(false);
        expect(await payloadIsRetained(rawB)).toBe(true);
        await sessionB.assertReadable(storedB.uri, rawB);

        await sessionB.close();
        expect(await payloadIsRetained(rawB)).toBe(false);
      });
    });
  }
);

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'mcp-protocol-version': PROTOCOL_VERSION,
};

class StreamableSession {
  private nextId = 1;

  private constructor(
    private readonly port: number,
    readonly sessionId: string
  ) {}

  static async open(port: number): Promise<StreamableSession> {
    const response = await postMcp(port, undefined, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'retention-test', version: '0.0.0' },
      },
    });
    const sessionId = response.headers.get('mcp-session-id');
    if (!sessionId) {
      throw new Error(
        `initialize did not return a session id: ${response.bodyText.slice(
          0,
          400
        )}`
      );
    }
    const messages = parseSseMessages(response.bodyText);
    const init = messages.find((message) => message.id === 1);
    if (!init?.result) {
      throw new Error(`initialize failed: ${response.bodyText.slice(0, 400)}`);
    }
    const session = new StreamableSession(port, sessionId);
    session.nextId = 2;
    const notified = await postMcp(port, sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    if (notified.status !== 202 && notified.status !== 200) {
      throw new Error(
        `initialized notification failed: ${notified.status} ${notified.bodyText}`
      );
    }
    return session;
  }

  async callGzip(
    raw: Buffer,
    name: string,
    outputType: 'resourceLink' | 'resource'
  ): Promise<ToolOutcome> {
    const uri = getSessionResourceURI(name);
    const id = this.nextId++;
    const response = await postMcp(this.port, this.sessionId, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'gzip-file-as-resource',
        arguments: {
          name,
          data: dataUriFor(raw),
          outputType,
        },
      },
    });
    return outcomeFromResponse(response, id, uri);
  }

  async assertReadable(uri: string, raw: Buffer): Promise<void> {
    const expected = gzipSync(raw).toString('base64');
    const id = this.nextId++;
    const response = await postMcp(this.port, this.sessionId, {
      jsonrpc: '2.0',
      id,
      method: 'resources/read',
      params: { uri },
    });
    const message = parseSseMessages(response.bodyText).find(
      (entry) => entry.id === id
    );
    const contents = (
      message?.result as { contents?: Array<{ blob?: string }> } | undefined
    )?.contents;
    expect(contents?.[0]?.blob).toBe(expected);
  }

  async delete(): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: 'DELETE',
      headers: {
        ...headers,
        'mcp-session-id': this.sessionId,
      },
    });
    if (response.status !== 200) {
      const text = await response.text();
      throw new Error(
        `session delete failed: ${response.status} ${text.slice(0, 300)}`
      );
    }
  }
}

class SseSession {
  private nextId = 1;

  private constructor(
    private readonly port: number,
    readonly sessionId: string,
    private readonly closeStream: () => void,
    private readonly pending: Map<number, (message: JsonRpc) => void>,
    private readonly early: Map<number, JsonRpc>
  ) {}

  static async open(port: number): Promise<SseSession> {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`SSE connect failed: ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sessionId = '';
    const pending = new Map<number, (message: JsonRpc) => void>();
    const early = new Map<number, JsonRpc>();

    const pump = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let splitAt = buffer.indexOf('\n\n');
          while (splitAt >= 0) {
            const block = buffer.slice(0, splitAt);
            buffer = buffer.slice(splitAt + 2);
            deliverSseBlock(block, pending, early, (id) => {
              sessionId = id;
            });
            splitAt = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // The test aborts this stream to close the session.
      }
    })();
    void pump;

    const deadline = Date.now() + 5_000;
    while (!sessionId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!sessionId) {
      controller.abort();
      throw new Error('SSE endpoint event did not include a session id');
    }

    const session = new SseSession(
      port,
      sessionId,
      () => controller.abort(),
      pending,
      early
    );

    const init = await session.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'retention-test', version: '0.0.0' },
    });
    if (!init.result) {
      throw new Error(
        `SSE initialize failed: ${JSON.stringify(init.error ?? init).slice(
          0,
          400
        )}`
      );
    }
    await session.notify('notifications/initialized');
    return session;
  }

  async callGzip(
    raw: Buffer,
    name: string,
    outputType: 'resourceLink' | 'resource'
  ): Promise<ToolOutcome> {
    const uri = getSessionResourceURI(name);
    const message = await this.request('tools/call', {
      name: 'gzip-file-as-resource',
      arguments: {
        name,
        data: dataUriFor(raw),
        outputType,
      },
    });
    if (message.error) {
      return {
        ok: false,
        uri,
        detail: message.error.message ?? 'json-rpc error',
      };
    }
    const result = message.result;
    if (!result || result.isError) {
      return {
        ok: false,
        uri,
        detail: JSON.stringify(result?.content ?? message).slice(0, 400),
      };
    }
    return { ok: true, uri, detail: '' };
  }

  async assertReadable(uri: string, raw: Buffer): Promise<void> {
    const expected = gzipSync(raw).toString('base64');
    const message = await this.request('resources/read', { uri });
    const contents = (
      message.result as { contents?: Array<{ blob?: string }> } | undefined
    )?.contents;
    expect(contents?.[0]?.blob).toBe(expected);
  }

  async close(): Promise<void> {
    this.closeStream();
    await settle();
  }

  private async notify(method: string): Promise<void> {
    const response = await fetch(
      `http://127.0.0.1:${this.port}/message?sessionId=${encodeURIComponent(
        this.sessionId
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method }),
      }
    );
    if (response.status !== 202 && response.status !== 200) {
      throw new Error(
        `SSE notify failed: ${response.status} ${await response.text()}`
      );
    }
  }

  private async request(
    method: string,
    params: Record<string, unknown>
  ): Promise<JsonRpc> {
    const id = this.nextId++;
    const waiter = new Promise<JsonRpc>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}`)),
        15_000
      );
      const finish = (message: JsonRpc) => {
        clearTimeout(timer);
        resolve(message);
      };
      const early = this.early.get(id);
      if (early) {
        this.early.delete(id);
        finish(early);
        return;
      }
      this.pending.set(id, finish);
    });
    const response = await fetch(
      `http://127.0.0.1:${this.port}/message?sessionId=${encodeURIComponent(
        this.sessionId
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }
    );
    if (response.status !== 202 && response.status !== 200) {
      throw new Error(
        `SSE ${method} failed: ${response.status} ${await response.text()}`
      );
    }
    return waiter;
  }
}

function deliverSseBlock(
  block: string,
  pending: Map<number, (message: JsonRpc) => void>,
  early: Map<number, JsonRpc>,
  onSession: (sessionId: string) => void
): void {
  const event = block.match(/^event: (.*)$/m)?.[1]?.trim();
  const data = block.match(/^data: (.*)$/m)?.[1];
  if (!data) return;
  if (event === 'endpoint') {
    const endpoint = new URL(data, 'http://127.0.0.1');
    const sessionId = endpoint.searchParams.get('sessionId');
    if (sessionId) onSession(sessionId);
    return;
  }
  if (event !== 'message') return;
  const message = JSON.parse(data) as JsonRpc;
  if (typeof message.id !== 'number') return;
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    waiter(message);
  } else {
    early.set(message.id, message);
  }
}

async function postMcp(
  port: number,
  sessionId: string | undefined,
  message: Record<string, unknown>
): Promise<{ status: number; bodyText: string; headers: Headers }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      ...headers,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const bodyText = await response.text();
  return { status: response.status, bodyText, headers: response.headers };
}

function parseSseMessages(body: string): JsonRpc[] {
  const messages: JsonRpc[] = [];
  for (const block of body.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n');
    if (!data) continue;
    try {
      messages.push(JSON.parse(data) as JsonRpc);
    } catch {
      // Priming events have empty data and are skipped above.
    }
  }
  return messages;
}

function outcomeFromResponse(
  response: { status: number; bodyText: string },
  id: number,
  uri: string
): ToolOutcome {
  if (response.status !== 200) {
    return {
      ok: false,
      uri,
      detail: `${response.status} ${response.bodyText.slice(0, 300)}`,
    };
  }
  const message = parseSseMessages(response.bodyText).find(
    (entry) => entry.id === id
  );
  if (!message) {
    return {
      ok: false,
      uri,
      detail: `no response for id ${id}: ${response.bodyText.slice(0, 300)}`,
    };
  }
  if (message.error) {
    return {
      ok: false,
      uri,
      detail: message.error.message ?? 'json-rpc error',
    };
  }
  const result = message.result;
  if (!result || result.isError) {
    return {
      ok: false,
      uri,
      detail: JSON.stringify(result?.content ?? message).slice(0, 400),
    };
  }
  return { ok: true, uri, detail: '' };
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError = 'not tried';
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(200),
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`port ${port} did not accept connections: ${lastError}`);
}

async function closeListeningServers(): Promise<void> {
  const handles = (
    process as unknown as { _getActiveHandles: () => unknown[] }
  )._getActiveHandles();
  await Promise.all(
    handles
      .filter((handle): handle is Server => handle instanceof Server)
      .map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          })
      )
  );
}
