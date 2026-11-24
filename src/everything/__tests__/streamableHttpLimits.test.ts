import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import http, { type IncomingHttpHeaders } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Spec for Streamable HTTP request limits on the everything server.
 *
 * These tests exercise the real `streamableHttp` process. They fail while
 * `@modelcontextprotocol/sdk` 1.30.0 reads an unlimited POST body and then
 * dispatches every JSON-RPC batch message. They pass once that path refuses a
 * body over 4 MiB with 413 and a batch over 100 messages with 400, before a
 * session is created or a tool runs.
 */

const require = createRequire(import.meta.url);
const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_MESSAGES = 100;
const ACCEPT = "application/json, text/event-stream";

const PAYLOAD_TOO_LARGE = {
  jsonrpc: "2.0",
  error: {
    code: -32000,
    message: `Payload Too Large: Request body must not exceed ${MAX_BODY_BYTES} bytes`,
  },
  id: null,
};

const BATCH_TOO_LONG = {
  jsonrpc: "2.0",
  error: {
    code: -32600,
    message: `Invalid Request: Batch must not exceed ${MAX_BATCH_MESSAGES} messages`,
  },
  id: null,
};

interface McpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  bytesWritten: number;
}

let child: ChildProcess | undefined;
let port = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("Could not allocate a port")));
        return;
      }
      const allocated = address.port;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(allocated);
      });
    });
  });
}

function listeningAddresses(listenPort: number): string[] {
  const hexPort = listenPort.toString(16).toUpperCase().padStart(4, "0");
  const addresses: string[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      const local = columns[1];
      const state = columns[3];
      if (!local || state !== "0A") {
        continue;
      }
      const [ip, localPort] = local.split(":");
      if (localPort?.toUpperCase() === hexPort && ip) {
        addresses.push(ip);
      }
    }
  }
  return addresses;
}

function initializeMessage(name: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name, version: "0" },
      },
    })
  );
}

function initializeBodyOfSize(size: number): Buffer {
  const empty = initializeMessage("");
  const single = initializeMessage("a");
  const perCharacter = single.length - empty.length;
  if (perCharacter !== 1) {
    throw new Error(
      `Expected one byte per padding character, got ${perCharacter}`
    );
  }
  const padding = size - empty.length;
  if (padding < 1) {
    throw new Error(`Size ${size} is smaller than the initialize envelope`);
  }
  const body = initializeMessage("a".repeat(padding));
  if (body.length !== size) {
    throw new Error(`Expected ${size} bytes, built ${body.length}`);
  }
  return body;
}

function ping(id: number): { jsonrpc: "2.0"; id: number; method: "ping" } {
  return { jsonrpc: "2.0", id, method: "ping" };
}

function echoCall(id: number, message: string) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call" as const,
    params: { name: "echo", arguments: { message } },
  };
}

function postMcp(
  body: Buffer,
  options?: {
    headers?: Record<string, string>;
    chunked?: boolean;
    declareLength?: number;
    writeBytes?: number;
    timeoutMs?: number;
  }
): Promise<McpResponse> {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const headers: Record<string, string> = {
    accept: ACCEPT,
    "content-type": "application/json",
    ...options?.headers,
  };
  if (options?.chunked) {
    headers["transfer-encoding"] = "chunked";
  }
  if (options?.declareLength !== undefined) {
    headers["content-length"] = String(options.declareLength);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let bytesWritten = 0;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      req.destroy();
      reject(error);
    };
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) {
            return;
          }
          settled = true;
          if (options?.declareLength !== undefined) {
            req.destroy();
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            bytesWritten,
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      fail(
        new Error(
          `no response within ${timeoutMs}ms after writing ${bytesWritten} bytes`
        )
      );
    });
    req.on("error", (error: Error) => {
      fail(error);
    });

    if (options?.declareLength !== undefined) {
      const prefix = body.subarray(0, options.writeBytes ?? 32);
      bytesWritten = prefix.length;
      req.write(prefix);
      return;
    }

    bytesWritten = body.length;
    req.end(body);
  });
}

async function initializeSession(): Promise<string> {
  const response = await postMcp(initializeMessage("limit-tests"));
  expect(response.status).toBe(200);
  const sessionId = response.headers["mcp-session-id"];
  expect(typeof sessionId).toBe("string");
  return sessionId as string;
}

function sessionHeaders(sessionId: string): Record<string, string> {
  return {
    "mcp-session-id": sessionId,
    "mcp-protocol-version": "2025-03-26",
  };
}

describe("streamable HTTP request limits", () => {
  beforeAll(async () => {
    const tsc = path.join(
      path.dirname(require.resolve("typescript/package.json")),
      "lib",
      "tsc.js"
    );
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
      cwd: serverRoot,
      stdio: "inherit",
    });

    port = await freePort();
    child = spawn(process.execPath, ["dist/index.js", "streamableHttp"], {
      cwd: serverRoot,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    const deadline = Date.now() + 10000;
    while (!output.includes(`listening on port ${port}`)) {
      if (child.exitCode !== null) {
        throw new Error(
          `streamable HTTP server exited ${child.exitCode}: ${output}`
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`streamable HTTP server did not listen: ${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, 60000);

  afterAll(() => {
    child?.kill("SIGKILL");
  });

  it("listens on an unspecified address with no credentials required to connect", () => {
    const addresses = listeningAddresses(port);
    const unspecified = addresses.filter(
      (address) => address === "00000000" || /^0+$/.test(address)
    );
    expect(unspecified.length).toBeGreaterThan(0);
  });

  it("accepts an unauthenticated initialize request", async () => {
    const response = await postMcp(initializeMessage("control"));
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(typeof response.headers["mcp-session-id"]).toBe("string");
    expect(response.body).toContain('"protocolVersion":"2025-03-26"');
  });

  it("accepts an initialize body of exactly 4 MiB", async () => {
    const response = await postMcp(initializeBodyOfSize(MAX_BODY_BYTES));
    expect(response.status).toBe(200);
    expect(typeof response.headers["mcp-session-id"]).toBe("string");
    expect(response.body).toContain('"protocolVersion":"2025-03-26"');
  });

  it("refuses an initialize body one byte over 4 MiB before creating a session", async () => {
    const response = await postMcp(initializeBodyOfSize(MAX_BODY_BYTES + 1));
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual(PAYLOAD_TOO_LARGE);
    expect(response.headers["mcp-session-id"]).toBeUndefined();
    expect(response.body).not.toContain('"protocolVersion"');
  });

  it("refuses a declared body over 4 MiB before the body is uploaded", async () => {
    const declared = MAX_BODY_BYTES + 1024;
    const response = await postMcp(Buffer.alloc(declared, 0x61), {
      declareLength: declared,
      writeBytes: 32,
      timeoutMs: 2000,
    });
    expect(response.bytesWritten).toBe(32);
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual(PAYLOAD_TOO_LARGE);
    expect(response.headers["mcp-session-id"]).toBeUndefined();
  });

  it("refuses a chunked body over 4 MiB when Content-Length is absent", async () => {
    const response = await postMcp(Buffer.alloc(MAX_BODY_BYTES + 1, 0x62), {
      chunked: true,
      timeoutMs: 15000,
    });
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual(PAYLOAD_TOO_LARGE);
    expect(response.headers["mcp-session-id"]).toBeUndefined();
  });

  it("accepts a JSON-RPC batch of exactly 100 messages", async () => {
    const sessionId = await initializeSession();
    const batch = Array.from({ length: MAX_BATCH_MESSAGES }, (_, index) =>
      ping(index + 1)
    );
    const response = await postMcp(Buffer.from(JSON.stringify(batch)), {
      headers: sessionHeaders(sessionId),
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).not.toContain("Batch must not exceed");
    expect(response.body.match(/"result":\{\}/g)?.length).toBe(
      MAX_BATCH_MESSAGES
    );
  });

  it("refuses a batch of 101 messages before schema validation", async () => {
    const batch = Array.from({ length: MAX_BATCH_MESSAGES + 1 }, () => ({}));
    const response = await postMcp(Buffer.from(JSON.stringify(batch)));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual(BATCH_TOO_LONG);
    expect(response.headers["mcp-session-id"]).toBeUndefined();
  });

  it("does not run tools in a batch longer than 100 messages", async () => {
    const sessionId = await initializeSession();
    const batch = Array.from({ length: MAX_BATCH_MESSAGES + 1 }, (_, index) =>
      echoCall(index + 1, `batch-${index}`)
    );
    const response = await postMcp(Buffer.from(JSON.stringify(batch)), {
      headers: sessionHeaders(sessionId),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual(BATCH_TOO_LONG);
    expect(response.body).not.toContain("Echo:");
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
  });

  it("does not start a long-running tool when the batch is over the cap", async () => {
    const sessionId = await initializeSession();
    const batch = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "trigger-long-running-operation",
          arguments: { duration: 30, steps: 1 },
        },
      },
      ...Array.from({ length: MAX_BATCH_MESSAGES }, (_, index) =>
        ping(index + 2)
      ),
    ];
    const response = await postMcp(Buffer.from(JSON.stringify(batch)), {
      headers: sessionHeaders(sessionId),
      timeoutMs: 2000,
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual(BATCH_TOO_LONG);
    expect(response.body).not.toContain("Long running operation completed");
  });
});
