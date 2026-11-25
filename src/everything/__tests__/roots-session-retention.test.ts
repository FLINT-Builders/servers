import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListRootsRequestSchema,
  Root,
} from "@modelcontextprotocol/sdk/types.js";
import { roots } from "../server/roots.js";

/**
 * Bounds the reference server must enforce before it keeps a client's roots.
 * A session may store a normal workspace list. It must not keep an unbounded
 * list or unbounded URI, and it must drop whatever it stored when that
 * session ends.
 */
const MAX_RETAINED_ROOTS = 32;
const MAX_RETAINED_URI_LENGTH = 1024;

const logLines: string[] = [];
let restoreConsole: (() => void) | undefined;
let streamablePort = 0;
let ssePort = 0;

type ListeningServer = {
  address: string;
  port: number;
  close: () => Promise<void>;
};

function listeningServers(): ListeningServer[] {
  const handles = (
    process as unknown as {
      _getActiveHandles: () => Array<{
        address?: () => { address?: string; port?: number } | string | null;
        close?: (callback?: (error?: Error) => void) => void;
        closeAllConnections?: () => void;
      }>;
    }
  )._getActiveHandles();

  const servers: ListeningServer[] = [];
  for (const handle of handles) {
    if (
      typeof handle.address !== "function" ||
      typeof handle.close !== "function"
    ) {
      continue;
    }
    const info = handle.address();
    if (!info || typeof info === "string" || !info.port || !info.address) {
      continue;
    }
    servers.push({
      address: info.address,
      port: info.port,
      close: () =>
        new Promise<void>((resolve, reject) => {
          handle.closeAllConnections?.();
          handle.close!((error) => (error ? reject(error) : resolve()));
        }),
    });
  }
  return servers;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(
  predicate: () => boolean,
  description: string
): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function modestRoots(marker: string): Root[] {
  return [
    { uri: `file:///workspace/${marker}/a`, name: marker },
    { uri: `file:///workspace/${marker}/b`, name: marker },
  ];
}

function oversizedRoots(marker: string): Root[] {
  const padded = "A".repeat(MAX_RETAINED_URI_LENGTH);
  return Array.from({ length: MAX_RETAINED_ROOTS + 8 }, (_, index) => ({
    uri: `file:///workspace/${marker}/${padded}/${index}`,
    name: marker,
  }));
}

function entriesHolding(marker: string): Array<[string | undefined, Root[]]> {
  return [...roots.entries()].filter(([, list]) =>
    list?.some((root) => root.uri.includes(marker) || root.name === marker)
  );
}

function withinRetentionBounds(list: Root[] | undefined): boolean {
  if (!list) return true;
  if (list.length > MAX_RETAINED_ROOTS) return false;
  return list.every((root) => root.uri.length <= MAX_RETAINED_URI_LENGTH);
}

type OpenSession = {
  client: Client;
  close: () => Promise<void>;
  sessionId: () => string | undefined;
};

function trackHandler(list: () => Root[]): {
  client: Client;
  wasInvoked: () => boolean;
} {
  let invoked = false;
  const client = new Client(
    { name: "roots-retention-test", version: "1.0.0" },
    { capabilities: { roots: { listChanged: true } } }
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    invoked = true;
    return { roots: list() };
  });
  return { client, wasInvoked: () => invoked };
}

async function openStreamable(list: () => Root[]): Promise<OpenSession> {
  const { client, wasInvoked } = trackHandler(list);
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${streamablePort}/mcp`)
  );
  await client.connect(transport);
  await waitFor(
    () => wasInvoked() && transport.sessionId !== undefined,
    "streamable HTTP roots request"
  );
  // The server stores the response after the client handler returns.
  await delay(50);
  return {
    client,
    sessionId: () => transport.sessionId,
    close: async () => {
      await transport.terminateSession();
      await client.close();
    },
  };
}

async function openSse(list: () => Root[]): Promise<OpenSession> {
  const before = logLines.length;
  const { client, wasInvoked } = trackHandler(list);
  const transport = new SSEClientTransport(
    new URL(`http://127.0.0.1:${ssePort}/sse`)
  );
  await client.connect(transport);
  await waitFor(() => wasInvoked(), "SSE roots request");
  await delay(50);
  const connected = logLines
    .slice(before)
    .map((line) => line.match(/Client Connected:\s*([0-9a-fA-F-]+)/))
    .find((match) => match !== undefined);
  const sessionId = connected?.[1];
  return {
    client,
    sessionId: () => sessionId,
    close: async () => {
      await client.close();
    },
  };
}

async function waitForCleanup(
  sessionId: string,
  transport: "streamable" | "sse"
): Promise<void> {
  const pattern =
    transport === "streamable"
      ? `Transport closed for session ${sessionId}`
      : `Client Disconnected:  ${sessionId}`;
  await waitFor(() => logLines.some((line) => line.includes(pattern)), pattern);
}

beforeAll(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map((arg) => String(arg)).join(" "));
    originalLog(...args);
  };
  console.error = (...args: unknown[]) => {
    logLines.push(args.map((arg) => String(arg)).join(" "));
    originalError(...args);
  };
  restoreConsole = () => {
    console.log = originalLog;
    console.error = originalError;
  };

  const beforeStreamable = new Set(
    listeningServers().map((server) => server.port)
  );
  process.env.PORT = "0";
  await import("../transports/streamableHttp.js");
  await waitFor(
    () =>
      listeningServers().some((server) => !beforeStreamable.has(server.port)),
    "streamable HTTP listen"
  );
  const streamable = listeningServers().find(
    (server) => !beforeStreamable.has(server.port)
  );
  if (!streamable) throw new Error("streamable HTTP server did not listen");
  streamablePort = streamable.port;

  const beforeSse = new Set(listeningServers().map((server) => server.port));
  process.env.PORT = "0";
  await import("../transports/sse.js");
  await waitFor(
    () => listeningServers().some((server) => !beforeSse.has(server.port)),
    "SSE listen"
  );
  const sse = listeningServers().find((server) => !beforeSse.has(server.port));
  if (!sse) throw new Error("SSE server did not listen");
  ssePort = sse.port;

  for (const server of [streamable, sse]) {
    expect(["::", "0.0.0.0"]).toContain(server.address);
  }
});

afterAll(async () => {
  const ports = new Set([streamablePort, ssePort]);
  for (const server of listeningServers()) {
    if (!ports.has(server.port)) continue;
    await server.close();
  }
  restoreConsole?.();
});

it("drops streamable HTTP roots for every closed session and keeps a live session", async () => {
  const firstMarker = "streamable-closed-first";
  const secondMarker = "streamable-closed-second";
  const liveMarker = "streamable-still-live";
  const first = await openStreamable(() => modestRoots(firstMarker));
  const second = await openStreamable(() => modestRoots(secondMarker));
  const live = await openStreamable(() => modestRoots(liveMarker));
  const firstId = first.sessionId();
  const secondId = second.sessionId();
  const liveId = live.sessionId();

  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();
  expect(liveId).toBeTruthy();
  expect(new Set([firstId, secondId, liveId]).size).toBe(3);
  expect(
    roots.get(firstId)?.some((root) => root.uri.includes(firstMarker))
  ).toBe(true);
  expect(
    roots.get(secondId)?.some((root) => root.uri.includes(secondMarker))
  ).toBe(true);
  expect(roots.get(liveId)?.some((root) => root.uri.includes(liveMarker))).toBe(
    true
  );

  await first.close();
  await second.close();
  await waitForCleanup(firstId!, "streamable");
  await waitForCleanup(secondId!, "streamable");

  expect(roots.get(firstId)).toBeUndefined();
  expect(roots.get(secondId)).toBeUndefined();
  expect(entriesHolding(firstMarker)).toEqual([]);
  expect(entriesHolding(secondMarker)).toEqual([]);
  expect(roots.get(liveId)?.some((root) => root.uri.includes(liveMarker))).toBe(
    true
  );

  await live.close();
  await waitForCleanup(liveId!, "streamable");
  expect(roots.get(liveId)).toBeUndefined();
  expect(entriesHolding(liveMarker)).toEqual([]);
});

it("drops SSE roots for every closed session and keeps a live session", async () => {
  const firstMarker = "sse-closed-first";
  const secondMarker = "sse-closed-second";
  const liveMarker = "sse-still-live";
  const first = await openSse(() => modestRoots(firstMarker));
  const second = await openSse(() => modestRoots(secondMarker));
  const live = await openSse(() => modestRoots(liveMarker));
  const firstId = first.sessionId();
  const secondId = second.sessionId();
  const liveId = live.sessionId();

  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();
  expect(liveId).toBeTruthy();
  expect(new Set([firstId, secondId, liveId]).size).toBe(3);
  expect(
    roots.get(firstId)?.some((root) => root.uri.includes(firstMarker))
  ).toBe(true);
  expect(
    roots.get(secondId)?.some((root) => root.uri.includes(secondMarker))
  ).toBe(true);
  expect(roots.get(liveId)?.some((root) => root.uri.includes(liveMarker))).toBe(
    true
  );

  await first.close();
  await second.close();
  await waitForCleanup(firstId!, "sse");
  await waitForCleanup(secondId!, "sse");

  expect(roots.get(firstId)).toBeUndefined();
  expect(roots.get(secondId)).toBeUndefined();
  expect(entriesHolding(firstMarker)).toEqual([]);
  expect(entriesHolding(secondMarker)).toEqual([]);
  expect(roots.get(liveId)?.some((root) => root.uri.includes(liveMarker))).toBe(
    true
  );

  await live.close();
  await waitForCleanup(liveId!, "sse");
  expect(roots.get(liveId)).toBeUndefined();
  expect(entriesHolding(liveMarker)).toEqual([]);
});

it("does not retain an oversized streamable HTTP roots list", async () => {
  const marker = "streamable-oversize";
  const session = await openStreamable(() => oversizedRoots(marker));
  const sessionId = session.sessionId();
  expect(sessionId).toBeTruthy();
  expect(withinRetentionBounds(roots.get(sessionId))).toBe(true);
  expect(
    entriesHolding(marker).every(([, list]) => withinRetentionBounds(list))
  ).toBe(true);

  await session.close();
  await waitForCleanup(sessionId!, "streamable");
  expect(roots.get(sessionId)).toBeUndefined();
  expect(entriesHolding(marker)).toEqual([]);
});

it("does not retain an oversized SSE roots list", async () => {
  const marker = "sse-oversize";
  const session = await openSse(() => oversizedRoots(marker));
  const sessionId = session.sessionId();
  expect(sessionId).toBeTruthy();
  expect(withinRetentionBounds(roots.get(sessionId))).toBe(true);
  expect(
    entriesHolding(marker).every(([, list]) => withinRetentionBounds(list))
  ).toBe(true);

  await session.close();
  await waitForCleanup(sessionId!, "sse");
  expect(roots.get(sessionId)).toBeUndefined();
  expect(entriesHolding(marker)).toEqual([]);
});

it("drops streamable HTTP roots replaced by a roots/list_changed notification", async () => {
  let current = modestRoots("streamable-list-changed-initial");
  const session = await openStreamable(() => current);
  const sessionId = session.sessionId();
  expect(
    roots
      .get(sessionId)
      ?.some((root) => root.uri.includes("streamable-list-changed-initial"))
  ).toBe(true);

  current = modestRoots("streamable-list-changed-updated");
  await session.client.sendRootsListChanged();
  await waitFor(
    () =>
      roots
        .get(sessionId)
        ?.some((root) =>
          root.uri.includes("streamable-list-changed-updated")
        ) === true,
    "updated streamable HTTP roots"
  );

  await session.close();
  await waitForCleanup(sessionId!, "streamable");
  expect(roots.get(sessionId)).toBeUndefined();
  expect(entriesHolding("streamable-list-changed-initial")).toEqual([]);
  expect(entriesHolding("streamable-list-changed-updated")).toEqual([]);
});

it("drops SSE roots replaced by a roots/list_changed notification", async () => {
  let current = modestRoots("sse-list-changed-initial");
  const session = await openSse(() => current);
  const sessionId = session.sessionId();
  expect(
    roots
      .get(sessionId)
      ?.some((root) => root.uri.includes("sse-list-changed-initial"))
  ).toBe(true);

  current = modestRoots("sse-list-changed-updated");
  await session.client.sendRootsListChanged();
  await waitFor(
    () =>
      roots
        .get(sessionId)
        ?.some((root) => root.uri.includes("sse-list-changed-updated")) ===
      true,
    "updated SSE roots"
  );

  await session.close();
  await waitForCleanup(sessionId!, "sse");
  expect(roots.get(sessionId)).toBeUndefined();
  expect(entriesHolding("sse-list-changed-initial")).toEqual([]);
  expect(entriesHolding("sse-list-changed-updated")).toEqual([]);
});
