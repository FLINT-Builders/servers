import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import http, { type IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, describe } from 'vitest';

/**
 * Spec for the network transports started by `node dist/index.js sse` and
 * `node dist/index.js streamableHttp`.
 *
 * A caller who is not the operator must not be able to open a session and
 * invoke tools. The cases below are the same-network client, a cross-origin
 * browser page, and a DNS-rebinding name aimed at loopback. They expect tool
 * calls to fail closed: no process environment, no successful tool result,
 * and no server-side fetch of an internal URL.
 *
 * The same POST handlers also serve the tools that these cases do not call
 * individually: get-annotated-message, get-resource-links, get-resource-reference,
 * get-structured-content, get-sum, get-tiny-image, toggle-simulated-logging,
 * toggle-subscriber-updates, trigger-long-running-operation, and the conditional
 * tools registered after initialization (get-roots-list, trigger-elicitation-request,
 * trigger-url-elicitation, trigger-sampling-request, simulate-research-query,
 * trigger-sampling-request-async, trigger-elicitation-request-async).
 */

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

const PROBE_NAME = 'EVERYTHING_TRANSPORT_PROBE';
const PROBE_VALUE = 'probe-not-a-secret';
const ATTACKER_ORIGIN = 'https://attacker.example';
const REBINDING_NAME = 'rebinding.example';
const ECHO_TOKEN = 'exposure-ping';
const SSRF_BODY = 'ssrf-marker';

type AttackMode = 'lan' | 'browser' | 'rebinding';

interface AttackOutcome {
  probeLeaked: boolean;
  echoSucceeded: boolean;
  ssrfFetched: boolean;
  streamAccepted: boolean;
  sessionDeleted: boolean;
}

interface Marker {
  url: string;
  hits: number;
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

class Unreachable extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'Unreachable';
  }
}

const blocked = (): AttackOutcome => ({
  probeLeaked: false,
  echoSucceeded: false,
  ssrfFetched: false,
  streamAccepted: false,
  sessionDeleted: false,
});

function expectAttackBlocked(
  outcome: AttackOutcome,
  includeDelete: boolean
): void {
  expect
    .soft(outcome.probeLeaked, 'process environment was readable')
    .toBe(false);
  expect
    .soft(outcome.echoSucceeded, 'unauthenticated tool call succeeded')
    .toBe(false);
  expect.soft(outcome.ssrfFetched, 'internal URL was fetched').toBe(false);
  expect
    .soft(outcome.streamAccepted, 'attacker accepted an event stream')
    .toBe(false);
  if (includeDelete) {
    expect
      .soft(outcome.sessionDeleted, 'attacker deleted a session')
      .toBe(false);
  }
}

function headerString(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function headerList(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(',') : value ?? '';
  return raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function originAllowed(
  value: string | string[] | undefined,
  origin: string
): boolean {
  const allowed = headerString(value);
  return allowed === '*' || allowed === origin;
}

function listAllows(
  value: string | string[] | undefined,
  needle: string
): boolean {
  const items = headerList(value);
  return items.includes('*') || items.includes(needle.toLowerCase());
}

function browserCanRead(headers: IncomingHttpHeaders, origin: string): boolean {
  return originAllowed(headers['access-control-allow-origin'], origin);
}

function preflightAllows(
  res: HttpResult,
  origin: string,
  method: string,
  requestedHeaders: string[]
): boolean {
  if (res.status >= 400) return false;
  if (!originAllowed(res.headers['access-control-allow-origin'], origin)) {
    return false;
  }
  if (!listAllows(res.headers['access-control-allow-methods'], method)) {
    return false;
  }
  return requestedHeaders.every((header) =>
    listAllows(res.headers['access-control-allow-headers'], header)
  );
}

function bodyLeaksProbe(body: string): boolean {
  return body.includes(PROBE_VALUE);
}

function bodyEchoed(body: string): boolean {
  return body.includes(`Echo: ${ECHO_TOKEN}`);
}

function blobsFrom(body: string): string[] {
  const blobs: string[] = [];
  const pattern = /"blob"\s*:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    blobs.push(match[1]);
  }
  return blobs;
}

function bodyHasMarker(body: string): boolean {
  if (body.includes(SSRF_BODY)) return true;
  for (const blob of blobsFrom(body)) {
    try {
      if (
        gunzipSync(Buffer.from(blob, 'base64'))
          .toString('utf8')
          .includes(SSRF_BODY)
      ) {
        return true;
      }
    } catch {
      // Not a gzip blob. The raw body check above covers an unencoded marker.
    }
  }
  return false;
}

function scrub(text: string): string {
  return text.split(PROBE_VALUE).join('[probe]');
}

function lanAddress(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  throw new Error(
    'No non-loopback IPv4 address is available to act as a same-network client'
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not allocate a port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function httpCall(options: {
  tcpHost: string;
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: options.tcpHost,
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (
        err.code === 'ECONNREFUSED' ||
        err.code === 'EHOSTUNREACH' ||
        err.code === 'ENETUNREACH' ||
        err.code === 'ECONNRESET'
      ) {
        reject(new Unreachable(err.code));
        return;
      }
      reject(err);
    });
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function readHeaders(options: {
  tcpHost: string;
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: options.tcpHost,
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: '',
        });
        req.destroy();
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH') {
        reject(new Unreachable(err.code ?? 'ECONNREFUSED'));
        return;
      }
      reject(err);
    });
    req.end();
  });
}

interface LiveSse {
  status: number;
  headers: IncomingHttpHeaders;
  sessionId: string | null;
  messages: string[];
  close: () => void;
}

function openSse(options: {
  tcpHost: string;
  port: number;
  headers: Record<string, string>;
}): Promise<LiveSse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: options.tcpHost,
        port: options.port,
        method: 'GET',
        path: '/sse',
        headers: options.headers,
      },
      (res) => {
        const live: LiveSse = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          sessionId: null,
          messages: [],
          close: () => req.destroy(),
        };
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let splitAt = buf.indexOf('\n\n');
          while (splitAt >= 0) {
            const block = buf.slice(0, splitAt);
            buf = buf.slice(splitAt + 2);
            const event = block.match(/^event: ?(.*)$/m)?.[1]?.trim();
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).replace(/^ /, ''))
              .join('\n');
            if (event === 'endpoint') {
              const found = data.match(/sessionId=([^&\s]+)/);
              live.sessionId = found ? decodeURIComponent(found[1]) : null;
            } else if (data) {
              live.messages.push(data);
            }
            splitAt = buf.indexOf('\n\n');
          }
        });
        resolve(live);
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error('sse timeout')));
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH') {
        reject(new Unreachable(err.code ?? 'ECONNREFUSED'));
        return;
      }
      reject(err);
    });
    req.end();
  });
}

async function waitFor(
  ready: () => boolean,
  timeoutMs = 3000
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (ready()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function initMessage(): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'exposure-probe', version: '0' },
    },
  };
}

function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown>
): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

function endpoint(
  mode: AttackMode,
  tcpHost: string,
  port: number
): {
  tcpHost: string;
  hostHeader: string;
  origin?: string;
} {
  if (mode === 'rebinding') {
    return {
      tcpHost,
      hostHeader: `${REBINDING_NAME}:${port}`,
      origin: `http://${REBINDING_NAME}:${port}`,
    };
  }
  if (mode === 'browser') {
    return {
      tcpHost,
      hostHeader: `${tcpHost}:${port}`,
      origin: ATTACKER_ORIGIN,
    };
  }
  return { tcpHost, hostHeader: `${tcpHost}:${port}` };
}

function noteVisible(
  outcome: AttackOutcome,
  body: string,
  visible: boolean
): void {
  if (!visible) return;
  if (bodyLeaksProbe(body)) outcome.probeLeaked = true;
  if (bodyEchoed(body)) outcome.echoSucceeded = true;
  if (bodyHasMarker(body)) outcome.ssrfFetched = true;
}

async function runStreamableAttack(options: {
  mode: AttackMode;
  tcpHost: string;
  port: number;
  marker: Marker;
}): Promise<AttackOutcome> {
  const outcome = blocked();
  const target = endpoint(options.mode, options.tcpHost, options.port);
  const browser = options.mode === 'browser';
  const baseHeaders: Record<string, string> = {
    host: target.hostHeader,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  if (target.origin) baseHeaders.origin = target.origin;

  if (browser && target.origin) {
    const preflight = await httpCall({
      tcpHost: target.tcpHost,
      port: options.port,
      method: 'OPTIONS',
      path: '/mcp',
      headers: {
        host: target.hostHeader,
        origin: target.origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers':
          'content-type, mcp-session-id, mcp-protocol-version',
      },
    });
    if (
      !preflightAllows(preflight, target.origin, 'POST', [
        'content-type',
        'mcp-session-id',
        'mcp-protocol-version',
      ])
    ) {
      return outcome;
    }
  }

  const init = await httpCall({
    tcpHost: target.tcpHost,
    port: options.port,
    method: 'POST',
    path: '/mcp',
    headers: baseHeaders,
    body: JSON.stringify(initMessage()),
  });
  const sessionId = headerString(init.headers['mcp-session-id']);
  if (browser && target.origin) {
    const readable = browserCanRead(init.headers, target.origin);
    const sessionInBody = sessionId ? init.body.includes(sessionId) : false;
    const sessionExposed =
      listAllows(
        init.headers['access-control-expose-headers'],
        'mcp-session-id'
      ) || sessionInBody;
    if (!readable || !sessionId || !sessionExposed) return outcome;
  }
  if (!sessionId) return outcome;

  const callHeaders: Record<string, string> = {
    ...baseHeaders,
    'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-03-26',
  };
  await httpCall({
    tcpHost: target.tcpHost,
    port: options.port,
    method: 'POST',
    path: '/mcp',
    headers: callHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });

  const hitsBefore = options.marker.hits;
  const calls = [
    toolCall(2, 'echo', { message: ECHO_TOKEN }),
    toolCall(3, 'get-env', {}),
    toolCall(4, 'gzip-file-as-resource', {
      name: 'x.gz',
      data: options.marker.url,
      outputType: 'resource',
    }),
  ];
  for (const message of calls) {
    const res = await httpCall({
      tcpHost: target.tcpHost,
      port: options.port,
      method: 'POST',
      path: '/mcp',
      headers: callHeaders,
      body: JSON.stringify(message),
    });
    const visible =
      !browser ||
      (target.origin ? browserCanRead(res.headers, target.origin) : false);
    noteVisible(outcome, res.body, visible);
  }
  if (options.marker.hits > hitsBefore) outcome.ssrfFetched = true;

  const getHeaders: Record<string, string> = {
    host: target.hostHeader,
    accept: 'text/event-stream',
    'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-03-26',
  };
  if (target.origin) getHeaders.origin = target.origin;
  let getAllowed = true;
  if (browser && target.origin) {
    const preflight = await httpCall({
      tcpHost: target.tcpHost,
      port: options.port,
      method: 'OPTIONS',
      path: '/mcp',
      headers: {
        host: target.hostHeader,
        origin: target.origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers':
          'mcp-session-id, mcp-protocol-version',
      },
    });
    getAllowed = preflightAllows(preflight, target.origin, 'GET', [
      'mcp-session-id',
      'mcp-protocol-version',
    ]);
  }
  if (getAllowed) {
    const opened = await readHeaders({
      tcpHost: target.tcpHost,
      port: options.port,
      method: 'GET',
      path: '/mcp',
      headers: getHeaders,
    });
    const visible =
      !browser ||
      (target.origin ? browserCanRead(opened.headers, target.origin) : false);
    if (visible && opened.status < 400) outcome.streamAccepted = true;
  }

  let deleteAllowed = true;
  if (browser && target.origin) {
    const preflight = await httpCall({
      tcpHost: target.tcpHost,
      port: options.port,
      method: 'OPTIONS',
      path: '/mcp',
      headers: {
        host: target.hostHeader,
        origin: target.origin,
        'access-control-request-method': 'DELETE',
        'access-control-request-headers':
          'mcp-session-id, mcp-protocol-version',
      },
    });
    deleteAllowed = preflightAllows(preflight, target.origin, 'DELETE', [
      'mcp-session-id',
      'mcp-protocol-version',
    ]);
  }
  if (deleteAllowed) {
    const deleted = await httpCall({
      tcpHost: target.tcpHost,
      port: options.port,
      method: 'DELETE',
      path: '/mcp',
      headers: callHeaders,
    });
    const visible =
      !browser ||
      (target.origin ? browserCanRead(deleted.headers, target.origin) : false);
    if (visible && deleted.status < 400) outcome.sessionDeleted = true;
  }

  return outcome;
}

async function runSseAttack(options: {
  mode: AttackMode;
  tcpHost: string;
  port: number;
  marker: Marker;
}): Promise<AttackOutcome> {
  const outcome = blocked();
  const target = endpoint(options.mode, options.tcpHost, options.port);
  const browser = options.mode === 'browser';
  const getHeaders: Record<string, string> = {
    host: target.hostHeader,
    accept: 'text/event-stream',
  };
  if (target.origin) getHeaders.origin = target.origin;

  const live = await openSse({
    tcpHost: target.tcpHost,
    port: options.port,
    headers: getHeaders,
  });
  try {
    if (
      browser &&
      target.origin &&
      !browserCanRead(live.headers, target.origin)
    ) {
      return outcome;
    }
    if (live.status >= 400) return outcome;
    const sawSession = await waitFor(() => live.sessionId !== null);
    if (!sawSession || !live.sessionId) return outcome;
    if (
      !browser ||
      (target.origin && browserCanRead(live.headers, target.origin))
    ) {
      outcome.streamAccepted = true;
    }

    if (browser && target.origin) {
      const preflight = await httpCall({
        tcpHost: target.tcpHost,
        port: options.port,
        method: 'OPTIONS',
        path: '/message',
        headers: {
          host: target.hostHeader,
          origin: target.origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      if (
        !preflightAllows(preflight, target.origin, 'POST', ['content-type'])
      ) {
        outcome.streamAccepted = false;
        return outcome;
      }
    }

    const postHeaders: Record<string, string> = {
      host: target.hostHeader,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (target.origin) postHeaders.origin = target.origin;
    const post = (message: unknown) =>
      httpCall({
        tcpHost: target.tcpHost,
        port: options.port,
        method: 'POST',
        path: `/message?sessionId=${encodeURIComponent(live.sessionId ?? '')}`,
        headers: postHeaders,
        body: JSON.stringify(message),
      });

    await post(initMessage());
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const hitsBefore = options.marker.hits;
    await post(toolCall(2, 'echo', { message: ECHO_TOKEN }));
    await post(toolCall(3, 'get-env', {}));
    await post(
      toolCall(4, 'gzip-file-as-resource', {
        name: 'x.gz',
        data: options.marker.url,
        outputType: 'resource',
      })
    );
    await waitFor(
      () =>
        live.messages.some(
          (message) => message.includes('"id":4') || message.includes('"id": 4')
        ),
      5000
    );
    const visibleBody = live.messages.join('\n');
    noteVisible(outcome, visibleBody, true);
    if (options.marker.hits > hitsBefore) outcome.ssrfFetched = true;
    return outcome;
  } finally {
    live.close();
  }
}

async function attack(options: {
  transport: 'streamableHttp' | 'sse';
  mode: AttackMode;
  port: number;
  marker: Marker;
  lan: string;
}): Promise<AttackOutcome> {
  const tcpHost = options.mode === 'lan' ? options.lan : '127.0.0.1';
  try {
    if (options.transport === 'streamableHttp') {
      return await runStreamableAttack({
        mode: options.mode,
        tcpHost,
        port: options.port,
        marker: options.marker,
      });
    }
    return await runSseAttack({
      mode: options.mode,
      tcpHost,
      port: options.port,
      marker: options.marker,
    });
  } catch (error) {
    if (error instanceof Unreachable) return blocked();
    throw error;
  }
}

let streamable: ChildProcess | undefined;
let sse: ChildProcess | undefined;
let markerServer: http.Server | undefined;
let marker: Marker;
let streamablePort = 0;
let ssePort = 0;
let lan = '';

function startTransport(
  kind: 'streamableHttp' | 'sse',
  port: number
): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    [PROBE_NAME]: PROBE_VALUE,
  };
  delete env.GZIP_ALLOWED_DOMAINS;
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    delete env[key];
  }
  const child = spawn(process.execPath, ['dist/index.js', kind], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const append = (chunk: Buffer) => {
    log = scrub((log + chunk.toString('utf8')).slice(-4000));
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.once('exit', (code) => {
    if (code && code !== 0) {
      log = scrub(`${log}\nexit ${code}`);
    }
  });
  (child as ChildProcess & { startupLog?: () => string }).startupLog = () =>
    log;
  return child;
}

async function waitForPort(port: number, child: ChildProcess): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (child.exitCode !== null) {
      const log =
        (
          child as ChildProcess & { startupLog?: () => string }
        ).startupLog?.() ?? '';
      throw new Error(scrub(`Transport exited early.\n${log}`));
    }
    try {
      await httpCall({
        tcpHost: '127.0.0.1',
        port,
        method: 'GET',
        path: '/does-not-matter',
        headers: { host: `127.0.0.1:${port}` },
      });
      return;
    } catch (error) {
      if (
        !(error instanceof Unreachable) &&
        !(error instanceof Error && error.message === 'request timeout')
      ) {
        // The process is up once it accepts a TCP connection, even if the
        // request itself is reset while the app is still installing routes.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const log =
    (child as ChildProcess & { startupLog?: () => string }).startupLog?.() ??
    '';
  throw new Error(scrub(`Transport did not accept connections.\n${log}`));
}

beforeAll(async () => {
  const tsc = require.resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
    cwd: PACKAGE_ROOT,
    stdio: 'pipe',
  });
  lan = lanAddress();
  streamablePort = await freePort();
  ssePort = await freePort();
  marker = { url: '', hits: 0 };
  markerServer = http.createServer((_req, res) => {
    marker.hits += 1;
    res.end(SSRF_BODY);
  });
  await new Promise<void>((resolve) => {
    markerServer?.listen(0, '127.0.0.1', () => resolve());
  });
  const address = markerServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Marker server has no port');
  }
  marker.url = `http://127.0.0.1:${address.port}/internal`;
  streamable = startTransport('streamableHttp', streamablePort);
  sse = startTransport('sse', ssePort);
  await waitForPort(streamablePort, streamable);
  await waitForPort(ssePort, sse);
}, 60000);

afterAll(async () => {
  streamable?.kill('SIGKILL');
  sse?.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    if (!markerServer) {
      resolve();
      return;
    }
    markerServer.close(() => resolve());
  });
});

describe('streamable HTTP transport', () => {
  it('blocks a same-network client from the session and from every tested tool', async () => {
    const outcome = await attack({
      transport: 'streamableHttp',
      mode: 'lan',
      port: streamablePort,
      marker,
      lan,
    });
    expectAttackBlocked(outcome, true);
  }, 20000);

  it('blocks a cross-origin browser page from the session and from every tested tool', async () => {
    const outcome = await attack({
      transport: 'streamableHttp',
      mode: 'browser',
      port: streamablePort,
      marker,
      lan,
    });
    expectAttackBlocked(outcome, true);
  }, 20000);

  it('blocks a DNS-rebinding name pointed at loopback from the session and from every tested tool', async () => {
    const outcome = await attack({
      transport: 'streamableHttp',
      mode: 'rebinding',
      port: streamablePort,
      marker,
      lan,
    });
    expectAttackBlocked(outcome, true);
  }, 20000);
});

describe('SSE transport', () => {
  it('blocks a same-network client from the session and from every tested tool', async () => {
    const outcome = await attack({
      transport: 'sse',
      mode: 'lan',
      port: ssePort,
      marker,
      lan,
    });
    expectAttackBlocked(outcome, false);
  }, 20000);

  it('blocks a cross-origin browser page from the session and from every tested tool', async () => {
    const outcome = await attack({
      transport: 'sse',
      mode: 'browser',
      port: ssePort,
      marker,
      lan,
    });
    expectAttackBlocked(outcome, false);
  }, 20000);

  it('blocks a DNS-rebinding name pointed at loopback from the session and from every tested tool', async () => {
    const outcome = await attack({
      transport: 'sse',
      mode: 'rebinding',
      port: ssePort,
      marker,
      lan,
    });
    expectAttackBlocked(outcome, false);
  }, 20000);
});
