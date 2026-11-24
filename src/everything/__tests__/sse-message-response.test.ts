import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Spec for the SSE transport's unanswered HTTP responses.
 *
 * These tests fail while POST /message (missing or unknown session) and
 * GET /sse (known session) return without writing a response. They pass
 * once every one of those requests finishes with a 4xx status.
 */

const RESPONSE_DEADLINE_MS = 1000;

type FinishedResponse = {
  finished: true;
  statusCode: number;
  body: string;
};

type HttpResult = FinishedResponse | { finished: false };

function listeningServers(): http.Server[] {
  const handles = (
    process as NodeJS.Process & { _getActiveHandles: () => unknown[] }
  )._getActiveHandles();
  return handles.filter(
    (handle): handle is http.Server => handle instanceof http.Server
  );
}

async function reservePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, () => resolve());
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    probe.close();
    throw new Error("Failed to reserve a TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((err) => (err ? reject(err) : resolve()));
  });
  return address.port;
}

function requestOnce(
  options: http.RequestOptions,
  body: string | undefined,
  deadlineMs: number
): Promise<HttpResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HttpResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        finish({
          finished: true,
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("aborted", () => finish({ finished: false }));
      res.on("error", () => finish({ finished: false }));
    });

    const timer = setTimeout(() => {
      req.destroy();
      finish({ finished: false });
    }, deadlineMs);

    req.on("error", () => finish({ finished: false }));
    if (body === undefined) {
      req.end();
    } else {
      req.end(body);
    }
  });
}

function expectClientError(result: HttpResult, label: string): void {
  expect(result.finished, `${label} left the HTTP response unfinished`).toBe(
    true
  );
  if (!result.finished) {
    return;
  }
  expect(result.statusCode, label).toBeGreaterThanOrEqual(400);
  expect(result.statusCode, label).toBeLessThan(500);
}

async function openSse(port: number): Promise<{
  sessionId: string;
  close: () => void;
}> {
  const req = http.request({
    hostname: "127.0.0.1",
    port,
    path: "/sse",
    method: "GET",
  });

  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("GET /sse produced no response headers"));
    }, RESPONSE_DEADLINE_MS);
    req.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.once("response", (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    req.end();
  });

  const sessionId = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      reject(new Error(`GET /sse did not advertise a session id: ${buffered}`));
    }, RESPONSE_DEADLINE_MS);
    res.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const match = buffered.match(/sessionId=([0-9a-fA-F-]+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    res.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    res.on("end", () => {
      clearTimeout(timer);
      reject(new Error("SSE stream ended before a session id was sent"));
    });
  });

  return {
    sessionId,
    close: () => {
      req.destroy();
      res.destroy();
    },
  };
}

describe("SSE transport unanswered HTTP responses", () => {
  let port = 0;
  let server: http.Server | undefined;
  let previousPort: string | undefined;

  beforeAll(async () => {
    previousPort = process.env.PORT;
    port = await reservePort();
    process.env.PORT = String(port);

    const alreadyListening = new Set(listeningServers());
    await import("../transports/sse.js");
    const started = listeningServers().filter(
      (candidate) => !alreadyListening.has(candidate)
    );
    expect(started).toHaveLength(1);
    server = started[0];
    if (!server.listening) {
      await once(server, "listening");
    }
  }, 15000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
    }
    if (previousPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = previousPort;
    }
  });

  it("listens on an unspecified address", () => {
    const address = server?.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");
    if (address && typeof address !== "string") {
      expect(["::", "0.0.0.0"]).toContain(address.address);
    }
  });

  it("finishes POST /message when the session id is omitted", async () => {
    const result = await requestOnce(
      {
        hostname: "127.0.0.1",
        port,
        path: "/message",
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
      },
      "{}",
      RESPONSE_DEADLINE_MS
    );
    expectClientError(result, "POST /message with no sessionId");
  });

  it("finishes POST /message when the session id is empty", async () => {
    const result = await requestOnce(
      {
        hostname: "127.0.0.1",
        port,
        path: "/message?sessionId=",
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
      },
      "{}",
      RESPONSE_DEADLINE_MS
    );
    expectClientError(result, "POST /message with an empty sessionId");
  });

  it("finishes POST /message when the session id matches no live session", async () => {
    const result = await requestOnce(
      {
        hostname: "127.0.0.1",
        port,
        path: "/message?sessionId=00000000-0000-4000-8000-000000000000",
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
      },
      "{}",
      RESPONSE_DEADLINE_MS
    );
    expectClientError(result, "POST /message with an unknown sessionId");
  });

  it("finishes POST /message when sessionId is repeated", async () => {
    const result = await requestOnce(
      {
        hostname: "127.0.0.1",
        port,
        path: "/message?sessionId=alpha&sessionId=beta",
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
      },
      "{}",
      RESPONSE_DEADLINE_MS
    );
    expectClientError(result, "POST /message with a repeated sessionId");
  });

  it("finishes concurrent POST /message requests for an unknown session", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        requestOnce(
          {
            hostname: "127.0.0.1",
            port,
            path: "/message?sessionId=not-a-live-session",
            method: "POST",
            headers: { connection: "close" },
          },
          "{}",
          RESPONSE_DEADLINE_MS
        )
      )
    );
    for (const result of results) {
      expectClientError(result, "concurrent POST /message");
    }
  });

  it("finishes a second GET /sse for a live session id", async () => {
    const sse = await openSse(port);
    try {
      const result = await requestOnce(
        {
          hostname: "127.0.0.1",
          port,
          path: `/sse?sessionId=${encodeURIComponent(sse.sessionId)}`,
          method: "GET",
          headers: { connection: "close" },
        },
        undefined,
        RESPONSE_DEADLINE_MS
      );
      expectClientError(result, "GET /sse with a live sessionId");
    } finally {
      sse.close();
    }
  });

  it("still answers POST /message for a live session", async () => {
    const sse = await openSse(port);
    try {
      const result = await requestOnce(
        {
          hostname: "127.0.0.1",
          port,
          path: `/message?sessionId=${encodeURIComponent(sse.sessionId)}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            connection: "close",
          },
        },
        "{}",
        RESPONSE_DEADLINE_MS
      );
      expect(result.finished, "live session POST did not finish").toBe(true);
      if (result.finished) {
        expect([202, 400]).toContain(result.statusCode);
      }
    } finally {
      sse.close();
    }
  });

  it("finishes GET /sse when the session id is unknown", async () => {
    const result = await requestOnce(
      {
        hostname: "127.0.0.1",
        port,
        path: "/sse?sessionId=00000000-0000-4000-8000-000000000000",
        method: "GET",
        headers: { connection: "close" },
      },
      undefined,
      RESPONSE_DEADLINE_MS
    );
    expect(result.finished, "GET /sse with an unknown sessionId hung").toBe(
      true
    );
    if (result.finished) {
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(result.statusCode).toBeLessThan(600);
    }
  });
});
