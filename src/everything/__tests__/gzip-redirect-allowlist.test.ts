import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const ALLOWED_HOST = "127.0.0.1";
const ALLOWLISTED_BODY = "allowlisted-final-body";
const DISALLOWED_BODY = "disallowed-redirect-body";

const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

type OutputType = "resource" | "resourceLink";
type GzipHandler = (args: {
  name: string;
  data: string;
  outputType: OutputType;
}) => Promise<CallToolResult>;
type ResourceReader = () => Promise<{
  contents: Array<{ blob?: string }>;
}>;

/**
 * Serves every path on both IPv4 and IPv6 loopback so a redirect to either
 * `localhost` or `[::1]` actually reaches this process. `localhost` resolves
 * to ::1 first on this host.
 */
async function startFixture() {
  const hits = { secret: 0 };
  const paths: string[] = [];
  let port = 0;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    paths.push(path);
    const disallowed = `http://localhost:${port}/secret`;

    if (path === "/secret") {
      hits.secret += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(DISALLOWED_BODY);
      return;
    }
    if (path === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(ALLOWLISTED_BODY);
      return;
    }
    if (path === "/to-ok") {
      res.writeHead(302, { location: "/ok" });
      res.end();
      return;
    }
    if (path === "/to-disallowed") {
      res.writeHead(302, { location: disallowed });
      res.end();
      return;
    }
    if (path === "/protocol-relative") {
      res.writeHead(302, { location: `//localhost:${port}/secret` });
      res.end();
      return;
    }
    if (path === "/to-ipv6") {
      res.writeHead(302, { location: `http://[::1]:${port}/secret` });
      res.end();
      return;
    }
    if (path === "/hop1") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/hop2` });
      res.end();
      return;
    }
    if (path === "/hop2") {
      res.writeHead(302, { location: disallowed });
      res.end();
      return;
    }
    const statusMatch = /^\/status-(\d+)$/.exec(path);
    if (statusMatch) {
      res.writeHead(Number(statusMatch[1]), { location: disallowed });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end("not found");
  };

  const v4 = createServer(handler);
  await listen(v4, 0, "127.0.0.1");
  port = (v4.address() as AddressInfo).port;
  const v6 = createServer(handler);
  await listen(v6, port, "::1");

  return {
    port,
    hits,
    paths,
    close: async () => {
      await Promise.all([closeServer(v4), closeServer(v6)]);
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function loadHandler(): Promise<{
  handler: GzipHandler;
  readers: ResourceReader[];
}> {
  vi.resetModules();
  process.env.GZIP_ALLOWED_DOMAINS = ALLOWED_HOST;
  const { registerGZipFileAsResourceTool } = await import(
    "../tools/gzip-file-as-resource.js"
  );
  let handler: GzipHandler | undefined;
  const readers: ResourceReader[] = [];
  const server = {
    registerTool(_name: string, _config: unknown, cb: GzipHandler) {
      handler = cb;
    },
    registerResource(
      _name: string,
      _uri: string,
      _metadata: unknown,
      read: ResourceReader
    ) {
      readers.push(read);
      return { remove() {} };
    },
  };
  registerGZipFileAsResourceTool(server as unknown as McpServer);
  if (!handler) {
    throw new Error("gzip-file-as-resource was not registered");
  }
  return { handler, readers };
}

function decodeGzip(blob: string): string {
  return gunzipSync(Buffer.from(blob, "base64")).toString("utf8");
}

async function collectedBodies(
  result: CallToolResult | undefined,
  readers: ResourceReader[]
): Promise<string[]> {
  const bodies: string[] = [];
  if (result) {
    for (const item of result.content) {
      if (
        item.type === "resource" &&
        "blob" in item.resource &&
        item.resource.blob
      ) {
        bodies.push(decodeGzip(item.resource.blob));
      }
    }
  }
  for (const read of readers) {
    const readResult = await read();
    for (const content of readResult.contents) {
      if (content.blob) {
        bodies.push(decodeGzip(content.blob));
      }
    }
  }
  return bodies;
}

async function invoke(data: string, outputType: OutputType) {
  const { handler, readers } = await loadHandler();
  let error: unknown;
  let result: CallToolResult | undefined;
  try {
    result = await handler({
      name: `${outputType}.gz`,
      data,
      outputType,
    });
  } catch (err) {
    error = err;
  }
  const bodies = await collectedBodies(result, readers);
  return { error, result, bodies };
}

describe("gzip-file-as-resource redirect allowlist", () => {
  const originalAllowed = process.env.GZIP_ALLOWED_DOMAINS;

  afterEach(() => {
    if (originalAllowed === undefined) {
      delete process.env.GZIP_ALLOWED_DOMAINS;
    } else {
      process.env.GZIP_ALLOWED_DOMAINS = originalAllowed;
    }
  });

  it("returns the body after a redirect that stays on an allowlisted host", async () => {
    const fixture = await startFixture();
    try {
      const { error, bodies } = await invoke(
        `http://127.0.0.1:${fixture.port}/to-ok`,
        "resource"
      );
      expect(error).toBeUndefined();
      expect(bodies).toContain(ALLOWLISTED_BODY);
      expect(fixture.hits.secret).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a direct URL whose host is outside the allowlist without requesting it", async () => {
    const fixture = await startFixture();
    try {
      const { error, bodies } = await invoke(
        `http://localhost:${fixture.port}/secret`,
        "resource"
      );
      expect(fixture.hits.secret).toBe(0);
      expect(bodies).not.toContain(DISALLOWED_BODY);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "not in the allowed domains list"
      );
    } finally {
      await fixture.close();
    }
  });

  it.each(["resource", "resourceLink"] as const)(
    "does not request or return a host outside the allowlist via redirect (%s)",
    async (outputType) => {
      const fixture = await startFixture();
      try {
        const { error, bodies } = await invoke(
          `http://127.0.0.1:${fixture.port}/to-disallowed`,
          outputType
        );
        expect({
          secretHits: fixture.hits.secret,
          paths: fixture.paths,
          bodies,
          rejected: error instanceof Error,
        }).toEqual({
          secretHits: 0,
          paths: ["/to-disallowed"],
          bodies: [],
          rejected: true,
        });
      } finally {
        await fixture.close();
      }
    }
  );

  it.each(REDIRECT_STATUSES)(
    "does not follow a %s redirect to a host outside the allowlist",
    async (status) => {
      const fixture = await startFixture();
      try {
        const { error, bodies } = await invoke(
          `http://127.0.0.1:${fixture.port}/status-${status}`,
          "resource"
        );
        expect(fixture.hits.secret, `paths=${fixture.paths.join(",")}`).toBe(0);
        expect(bodies).not.toContain(DISALLOWED_BODY);
        expect(error).toBeInstanceOf(Error);
      } finally {
        await fixture.close();
      }
    }
  );

  it("does not follow a protocol-relative redirect to a host outside the allowlist", async () => {
    const fixture = await startFixture();
    try {
      const { error, bodies } = await invoke(
        `http://127.0.0.1:${fixture.port}/protocol-relative`,
        "resource"
      );
      expect(fixture.hits.secret, `paths=${fixture.paths.join(",")}`).toBe(0);
      expect(bodies).not.toContain(DISALLOWED_BODY);
      expect(error).toBeInstanceOf(Error);
    } finally {
      await fixture.close();
    }
  });

  it("does not follow a redirect to an IPv6 loopback host outside the allowlist", async () => {
    const fixture = await startFixture();
    try {
      const { error, bodies } = await invoke(
        `http://127.0.0.1:${fixture.port}/to-ipv6`,
        "resource"
      );
      expect(fixture.hits.secret, `paths=${fixture.paths.join(",")}`).toBe(0);
      expect(bodies).not.toContain(DISALLOWED_BODY);
      expect(error).toBeInstanceOf(Error);
    } finally {
      await fixture.close();
    }
  });

  it("does not request a disallowed host on a later hop after an allowlisted hop", async () => {
    const fixture = await startFixture();
    try {
      const { error, bodies } = await invoke(
        `http://127.0.0.1:${fixture.port}/hop1`,
        "resource"
      );
      expect(fixture.paths).toContain("/hop1");
      expect(fixture.paths).toContain("/hop2");
      expect(fixture.hits.secret, `paths=${fixture.paths.join(",")}`).toBe(0);
      expect(bodies).not.toContain(DISALLOWED_BODY);
      expect(error).toBeInstanceOf(Error);
    } finally {
      await fixture.close();
    }
  });
});
