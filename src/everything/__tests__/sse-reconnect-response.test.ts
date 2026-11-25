import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Spec for the SSE transport's unfinished HTTP responses.
 *
 * These tests fail while GET /sse?sessionId=<live> (and POST /message with no
 * matching transport) return without ending the response. They pass once each
 * of those requests is finished with an error status and the original SSE
 * stream is left open on its own response.
 */

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const RESPONSE_DEADLINE_MS = 2000;
const REPLAY_COUNT = 8;
const ATTACKER_ORIGIN = "https://attacker.example";

type Exchange = {
  completed: boolean;
  statusCode?: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

let child: ChildProcess | undefined;
let port = 0;
let serverLog = "";
const openRequests: http.ClientRequest[] = [];

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("failed to reserve a TCP port"));
        return;
      }
      const reserved = address.port;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(reserved);
      });
    });
  });
}

function decodeProcAddress(hex: string): string {
  if (hex.length === 8) {
    const bytes = hex.match(/../g);
    if (!bytes) {
      return hex;
    }
    return bytes
      .reverse()
      .map((byte) => String(Number.parseInt(byte, 16)))
      .join(".");
  }
  // IPv6 addresses in /proc/net/tcp6 are four little-endian words.
  const words = hex.match(/.{8}/g);
  if (!words) {
    return hex;
  }
  const bytes: string[] = [];
  for (const word of words) {
    const pairs = word.match(/../g);
    if (!pairs) {
      continue;
    }
    bytes.push(...pairs.reverse());
  }
  return bytes.join("");
}

function listeningAddresses(listenPort: number): string[] {
  const addresses: string[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 4) {
        continue;
      }
      const [addressHex, portHex] = columns[1].split(":");
      // 0A is TCP_LISTEN.
      if (Number.parseInt(portHex, 16) !== listenPort || columns[3] !== "0A") {
        continue;
      }
      addresses.push(decodeProcAddress(addressHex));
    }
  }
  return addresses;
}

function exchange(
  options: http.RequestOptions,
  body?: string,
  deadlineMs = RESPONSE_DEADLINE_MS
): Promise<Exchange> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Exchange) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const request = http.request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        finish({
          completed: true,
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("aborted", () => {
        finish({
          completed: false,
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    openRequests.push(request);

    const timer = setTimeout(() => {
      request.destroy();
      finish({ completed: false, headers: {}, body: "" });
    }, deadlineMs);

    request.on("error", () => {
      finish({ completed: false, headers: {}, body: "" });
    });

    if (body !== undefined) {
      request.setHeader("Content-Length", Buffer.byteLength(body));
      request.end(body);
    } else {
      request.end();
    }
  });
}

async function openLiveSession(): Promise<{
  sessionId: string;
  response: http.IncomingMessage;
  request: http.ClientRequest;
  body: () => string;
}> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/sse",
        headers: {
          Origin: ATTACKER_ORIGIN,
          Accept: "text/event-stream",
        },
      },
      (response) => {
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const match = buffer.match(/sessionId=([0-9a-fA-F-]{36})/);
          if (!match) {
            return;
          }
          response.off("data", onData);
          resolve({
            sessionId: match[1],
            response,
            request,
            body: () => buffer,
          });
        };
        response.on("data", onData);
        response.on("error", reject);
      }
    );
    openRequests.push(request);
    request.on("error", reject);
  });
}

describe("SSE transport unfinished responses", () => {
  beforeAll(async () => {
    port = await reservePort();
    child = spawn(process.execPath, ["dist/index.js", "sse"], {
      cwd: packageRoot,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      serverLog += chunk.toString("utf8");
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SSE server did not start. log:\n${serverLog}`));
      }, 10000);
      const watch = () => {
        if (!serverLog.includes("Server is running")) {
          return;
        }
        clearTimeout(timer);
        resolve();
      };
      watch();
      child?.stderr?.on("data", watch);
      child?.on("exit", (code) => {
        if (serverLog.includes("Server is running")) {
          return;
        }
        clearTimeout(timer);
        reject(new Error(`SSE server exited (${code}). log:\n${serverLog}`));
      });
    });
    await ready;
  }, 15000);

  afterAll(() => {
    for (const request of openRequests) {
      request.destroy();
    }
    if (child && !child.killed) {
      child.kill("SIGKILL");
    }
  });

  it("publishes a session id to any origin on an unspecified address", async () => {
    const addresses = listeningAddresses(port);
    expect(addresses.length).toBeGreaterThan(0);
    expect(
      addresses.some(
        (address) =>
          address === "0.0.0.0" ||
          address === "00000000000000000000000000000000"
      )
    ).toBe(true);

    const session = await openLiveSession();
    expect(session.response.statusCode).toBe(200);
    expect(session.response.headers["content-type"]).toContain(
      "text/event-stream"
    );
    expect(session.response.headers["access-control-allow-origin"]).toBe("*");
    expect(session.body()).toContain(`sessionId=${session.sessionId}`);
    session.request.destroy();
  });

  it("finishes repeated GET /sse requests for a live session with an error and keeps the original stream", async () => {
    const session = await openLiveSession();
    let originalEnded = false;
    session.response.on("end", () => {
      originalEnded = true;
    });
    session.response.on("close", () => {
      originalEnded = true;
    });

    const replays = await Promise.all(
      Array.from({ length: REPLAY_COUNT }, () =>
        exchange({
          hostname: "127.0.0.1",
          port,
          method: "GET",
          path: `/sse?sessionId=${encodeURIComponent(session.sessionId)}`,
          headers: { Origin: ATTACKER_ORIGIN },
        })
      )
    );

    expect(originalEnded).toBe(false);
    expect(session.body()).toContain(`event: endpoint`);
    expect(session.body()).toContain(`sessionId=${session.sessionId}`);

    for (const replay of replays) {
      expect(replay.completed).toBe(true);
      expect(replay.statusCode).toBeGreaterThanOrEqual(400);
      expect(replay.statusCode).toBeLessThan(600);
    }

    // The error belongs on the replay response, not the original event stream.
    expect(session.body()).not.toMatch(/HTTP\/1\.1 [45]\d\d/);
    session.request.destroy();
  });

  it("finishes GET /sse for an unknown session id with an error", async () => {
    const unknown = await exchange({
      hostname: "127.0.0.1",
      port,
      method: "GET",
      path: "/sse?sessionId=00000000-0000-4000-8000-000000000000",
      headers: { Origin: ATTACKER_ORIGIN },
    });

    expect(unknown.completed).toBe(true);
    expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
    expect(unknown.statusCode).toBeLessThan(600);
  });

  it("finishes POST /message when no transport is registered", async () => {
    const missing = await exchange(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/message?sessionId=00000000-0000-4000-8000-000000000001",
        headers: {
          Origin: ATTACKER_ORIGIN,
          "Content-Type": "application/json",
        },
      },
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    );
    const omitted = await exchange(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/message",
        headers: {
          Origin: ATTACKER_ORIGIN,
          "Content-Type": "application/json",
        },
      },
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    );

    for (const result of [missing, omitted]) {
      expect(result.completed).toBe(true);
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(result.statusCode).toBeLessThan(600);
    }
  });

  it("still accepts a message on the original session after a rejected replay", async () => {
    const session = await openLiveSession();
    const replay = await exchange({
      hostname: "127.0.0.1",
      port,
      method: "GET",
      path: `/sse?sessionId=${encodeURIComponent(session.sessionId)}`,
      headers: { Origin: ATTACKER_ORIGIN },
    });

    expect(replay.completed).toBe(true);
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    expect(replay.statusCode).toBeLessThan(600);

    const posted = await exchange(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: `/message?sessionId=${encodeURIComponent(session.sessionId)}`,
        headers: {
          Origin: ATTACKER_ORIGIN,
          "Content-Type": "application/json",
        },
      },
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    );

    expect(posted.completed).toBe(true);
    expect(posted.statusCode).toBeGreaterThanOrEqual(200);
    expect(posted.statusCode).toBeLessThan(300);
    expect(session.response.closed).toBe(false);
    session.request.destroy();
  });
});
