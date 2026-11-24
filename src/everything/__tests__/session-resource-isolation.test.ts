/**
 * Session resources must stay attached to the server instance that created them.
 *
 * The streamable HTTP and SSE transports each call createServer() per session
 * inside one process. These tests fail while a second session can remove the
 * first session's registration by reusing its resource name.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getSessionResourceURI,
  registerSessionResource,
} from "../resources/session.js";
import { createServer } from "../server/index.js";

const execFileAsync = promisify(execFile);
const everythingDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tscBin = join(repoRoot, "node_modules", ".bin", "tsc");
const shxBin = join(repoRoot, "node_modules", ".bin", "shx");

type OutputType = "resourceLink" | "resource";
type PayloadType = "text" | "blob";

type GzipSession = {
  sessionId?: string;
  gzip: (
    plaintext: string,
    options?: { name?: string; outputType?: OutputType }
  ) => Promise<{ uri: string }>;
  readGzip: (uri: string) => Promise<string>;
  listedUris: () => Promise<string[]>;
  end: () => Promise<void>;
};

type DirectSession = {
  server: McpServer;
  read: (uri: string) => Promise<string>;
  end: () => Promise<void>;
};

const serverLogs: string[] = [];

function dataUri(plaintext: string): string {
  return `data:text/plain;base64,${Buffer.from(plaintext, "utf8").toString(
    "base64"
  )}`;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a local port"));
        return;
      }
      const { port } = address;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startProductServer(
  transportName: "streamableHttp" | "sse",
  port: number
): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["dist/index.js", transportName], {
    cwd: everythingDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer) => {
    serverLogs.push(chunk.toString());
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  return new Promise((resolve, reject) => {
    let settled = false;
    const logs = () => serverLogs.join("");
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else {
        resolve(child);
      }
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `everything ${transportName} server did not listen\n${logs()}`
        )
      );
    }, 15000);
    const onData = () => {
      if (/listening on port|running on port/.test(logs())) {
        finish();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      finish(
        new Error(
          `everything ${transportName} server exited ${code}\n${logs()}`
        )
      );
    });
  });
}

async function stopProductServer(
  child: ChildProcess | undefined
): Promise<void> {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGINT");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function uriFromToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>
): string {
  if (
    !("content" in result) ||
    !Array.isArray(result.content) ||
    result.content.length === 0
  ) {
    throw new Error(`gzip tool returned no content: ${JSON.stringify(result)}`);
  }
  if ("isError" in result && result.isError) {
    throw new Error(`gzip tool failed: ${JSON.stringify(result)}`);
  }
  const block = result.content[0];
  if (block.type === "resource_link") {
    return block.uri;
  }
  if (block.type === "resource") {
    return block.resource.uri;
  }
  throw new Error(
    `gzip tool returned unexpected content: ${JSON.stringify(block)}`
  );
}

async function callGzip(
  client: Client,
  plaintext: string,
  options?: { name?: string; outputType?: OutputType }
): Promise<{ uri: string }> {
  const outputType = options?.outputType ?? "resourceLink";
  const arguments_: { data: string; outputType: OutputType; name?: string } = {
    data: dataUri(plaintext),
    outputType,
  };
  if (options?.name !== undefined) {
    arguments_.name = options.name;
  }
  const result = await client.callTool({
    name: "gzip-file-as-resource",
    arguments: arguments_,
  });
  return { uri: uriFromToolResult(result) };
}

async function readGzipText(client: Client, uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  const content = result.contents[0];
  if (!content || !("blob" in content) || typeof content.blob !== "string") {
    throw new Error(`resource ${uri} did not return gzip bytes`);
  }
  return gunzipSync(Buffer.from(content.blob, "base64")).toString("utf8");
}

async function resourceUris(client: Client): Promise<string[]> {
  const listed = await client.listResources();
  return listed.resources.map((resource) => resource.uri);
}

async function expectOwnPlaintext(
  read: () => Promise<string>,
  expected: string
): Promise<void> {
  let actual: string;
  try {
    actual = await read();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `session could not read the resource it created (expected ${JSON.stringify(
        expected
      )}): ${message}`
    );
  }
  expect(actual).toBe(expected);
}

async function plaintextIfReadable(
  read: () => Promise<string>
): Promise<string | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

function gzipSession(
  client: Client,
  end: () => Promise<void>,
  sessionId?: string
): GzipSession {
  let ended = false;
  return {
    sessionId,
    gzip: (plaintext, options) => callGzip(client, plaintext, options),
    readGzip: (uri) => readGzipText(client, uri),
    listedUris: () => resourceUris(client),
    end: async () => {
      if (ended) {
        return;
      }
      ended = true;
      await end();
    },
  };
}

async function expectIsolatedGzipSessions(
  open: () => Promise<GzipSession>,
  options?: { name?: string; outputType?: OutputType }
): Promise<void> {
  const outputType = options?.outputType ?? "resourceLink";
  const name =
    options && "name" in options ? options.name : `shared-${randomUUID()}.gz`;
  const first = await open();
  const second = await open();
  let third: GzipSession | undefined;
  try {
    const created = await first.gzip("alpha-body", { name, outputType });
    await expectOwnPlaintext(() => first.readGzip(created.uri), "alpha-body");
    expect(await first.listedUris()).toContain(created.uri);

    const taken = await second.gzip("beta-body", { name, outputType });
    await expectOwnPlaintext(() => second.readGzip(taken.uri), "beta-body");
    await expectOwnPlaintext(() => first.readGzip(created.uri), "alpha-body");
    expect(await first.listedUris()).toContain(created.uri);
    expect(await second.listedUris()).toContain(taken.uri);
    expect(await plaintextIfReadable(() => first.readGzip(taken.uri))).not.toBe(
      "beta-body"
    );

    const replaced = await first.gzip("alpha-replaced", { name, outputType });
    await expectOwnPlaintext(
      () => first.readGzip(replaced.uri),
      "alpha-replaced"
    );
    await expectOwnPlaintext(() => second.readGzip(taken.uri), "beta-body");

    await first.end();
    await expectOwnPlaintext(() => second.readGzip(taken.uri), "beta-body");

    const later = await open();
    third = later;
    const createdAfterClose = await later.gzip("gamma-body", {
      name,
      outputType,
    });
    await expectOwnPlaintext(() => second.readGzip(taken.uri), "beta-body");
    await expectOwnPlaintext(
      () => later.readGzip(createdAfterClose.uri),
      "gamma-body"
    );
    expect(
      await plaintextIfReadable(() => second.readGzip(createdAfterClose.uri))
    ).not.toBe("gamma-body");
  } finally {
    await third?.end();
    await second.end();
    await first.end();
  }
}

async function openDirectSession(): Promise<DirectSession> {
  const { server, cleanup } = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "direct-session", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  let ended = false;
  return {
    server,
    read: async (uri) => {
      const result = await client.readResource({ uri });
      const content = result.contents[0];
      if (!content) {
        throw new Error(`resource ${uri} returned no content`);
      }
      if ("text" in content && typeof content.text === "string") {
        return content.text;
      }
      if ("blob" in content && typeof content.blob === "string") {
        return content.blob;
      }
      throw new Error(`resource ${uri} returned no payload`);
    },
    end: async () => {
      if (ended) {
        return;
      }
      ended = true;
      await client.close();
      cleanup(server.server.transport?.sessionId);
    },
  };
}

function openHttpSession(port: number): Promise<GzipSession> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`)
  );
  const client = new Client({ name: "http-session", version: "1.0.0" });
  return client.connect(transport).then(() =>
    gzipSession(
      client,
      async () => {
        try {
          await transport.terminateSession();
        } finally {
          await client.close();
        }
      },
      transport.sessionId
    )
  );
}

function openSseSession(port: number): Promise<GzipSession> {
  const transport = new SSEClientTransport(
    new URL(`http://127.0.0.1:${port}/sse`)
  );
  const client = new Client({ name: "sse-session", version: "1.0.0" });
  return client.connect(transport).then(() =>
    gzipSession(client, async () => {
      const disconnectsBefore = serverLogs
        .join("")
        .split("Client Disconnected").length;
      await client.close();
      const started = Date.now();
      while (
        serverLogs.join("").split("Client Disconnected").length <=
        disconnectsBefore
      ) {
        if (Date.now() - started > 5000) {
          throw new Error(
            `SSE session did not disconnect\n${serverLogs.join("")}`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })
  );
}

function openMemoryGzipSession(): Promise<GzipSession> {
  const { server, cleanup } = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "memory-session", version: "1.0.0" });
  return server.connect(serverTransport).then(() =>
    client.connect(clientTransport).then(() =>
      gzipSession(client, async () => {
        await client.close();
        cleanup(server.server.transport?.sessionId);
      })
    )
  );
}

async function expectDirectPayloadsStayPut(
  type: PayloadType,
  alphaPayload: string,
  betaPayload: string,
  replacedPayload: string
): Promise<void> {
  const name = `${type}-${randomUUID()}`;
  const uri = getSessionResourceURI(name);
  const resource = {
    uri,
    name,
    mimeType: type === "text" ? "text/plain" : "application/octet-stream",
  };
  const alpha = await openDirectSession();
  const beta = await openDirectSession();
  try {
    registerSessionResource(alpha.server, resource, type, alphaPayload);
    registerSessionResource(beta.server, resource, type, betaPayload);
    expect(await alpha.read(uri)).toBe(alphaPayload);
    expect(await beta.read(uri)).toBe(betaPayload);

    registerSessionResource(alpha.server, resource, type, replacedPayload);
    expect(await alpha.read(uri)).toBe(replacedPayload);
    expect(await beta.read(uri)).toBe(betaPayload);

    await alpha.end();
    expect(await beta.read(uri)).toBe(betaPayload);
  } finally {
    await beta.end();
    await alpha.end();
  }
}

describe("session resource isolation", () => {
  let httpPort = 0;
  let ssePort = 0;
  let httpChild: ChildProcess | undefined;
  let sseChild: ChildProcess | undefined;

  beforeAll(async () => {
    await execFileAsync(tscBin, ["-p", "tsconfig.json"], {
      cwd: everythingDir,
    });
    await execFileAsync(shxBin, ["cp", "-r", "docs", "dist/"], {
      cwd: everythingDir,
    });
    httpPort = await freePort();
    ssePort = await freePort();
    httpChild = await startProductServer("streamableHttp", httpPort);
    sseChild = await startProductServer("sse", ssePort);
  }, 60000);

  afterAll(async () => {
    await stopProductServer(httpChild);
    await stopProductServer(sseChild);
  });

  it("keeps text registrations on the server that created them", async () => {
    await expectDirectPayloadsStayPut(
      "text",
      "alpha-text",
      "beta-text",
      "alpha-text-replaced"
    );
  });

  it("keeps blob registrations on the server that created them", async () => {
    await expectDirectPayloadsStayPut(
      "blob",
      "YWxwaGE=",
      "YmV0YQ==",
      "YWxwaGEy"
    );
  });

  it("keeps gzip resources isolated across in-process servers", async () => {
    await expectIsolatedGzipSessions(openMemoryGzipSession);
  });

  it("keeps gzip resources isolated when the tool returns the resource body", async () => {
    await expectIsolatedGzipSessions(openMemoryGzipSession, {
      outputType: "resource",
    });
  });

  it("keeps distinct gzip names isolated across in-process servers", async () => {
    const first = await openMemoryGzipSession();
    const second = await openMemoryGzipSession();
    try {
      const alpha = await first.gzip("alpha-body", {
        name: `alpha-${randomUUID()}.gz`,
      });
      const beta = await second.gzip("beta-body", {
        name: `beta-${randomUUID()}.gz`,
      });
      await expectOwnPlaintext(() => first.readGzip(alpha.uri), "alpha-body");
      await expectOwnPlaintext(() => second.readGzip(beta.uri), "beta-body");
    } finally {
      await second.end();
      await first.end();
    }
  });

  it("opens two unauthenticated streamable HTTP sessions", async () => {
    const first = await openHttpSession(httpPort);
    const second = await openHttpSession(httpPort);
    try {
      expect(first.sessionId).toEqual(expect.any(String));
      expect(second.sessionId).toEqual(expect.any(String));
      expect(first.sessionId).not.toBe(second.sessionId);
    } finally {
      await second.end();
      await first.end();
    }
  });

  it("keeps gzip resources isolated across streamable HTTP sessions", async () => {
    await expectIsolatedGzipSessions(() => openHttpSession(httpPort));
  });

  it("keeps gzip resource bodies isolated across streamable HTTP sessions", async () => {
    await expectIsolatedGzipSessions(() => openHttpSession(httpPort), {
      outputType: "resource",
    });
  });

  it("keeps the default gzip name isolated across streamable HTTP sessions", async () => {
    await expectIsolatedGzipSessions(() => openHttpSession(httpPort), {
      name: undefined,
    });
  });

  it("keeps gzip resources isolated across SSE sessions", async () => {
    await expectIsolatedGzipSessions(() => openSseSession(ssePort));
  });

  it("keeps gzip resource bodies isolated across SSE sessions", async () => {
    await expectIsolatedGzipSessions(() => openSseSession(ssePort), {
      outputType: "resource",
    });
  });
});
