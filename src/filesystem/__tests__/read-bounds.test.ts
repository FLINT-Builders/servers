import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import { createWriteStream, readFileSync, watch, type FSWatcher } from 'fs';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Spec for a missing cap on filesystem reads. These assertions fail while the
 * server still loads a whole file (or every listed path) into memory.
 *
 * A later fix must:
 * - Refuse a file body above MAX_FILE_READ_BYTES. Counting bytes with stat and
 *   then calling readFile / createReadStream on that path is not enough: the
 *   bytes actually read have to stay within MAX_FILE_READ_BYTES plus one
 *   64 KiB read-ahead, including when stat.size is 0 (a fifo).
 * - Apply that same cap to read_file, read_text_file (full read, head, and
 *   tail), read_media_file before base64, read_multiple_files, and edit_file.
 * - Refuse read_multiple_files above MAX_MULTIPLE_READ_PATHS before reading
 *   any of those file bodies.
 * - Return a short tool result that matches LIMIT_ERROR and does not contain
 *   the file body. Do not create or replace files before that refusal.
 */
const MAX_FILE_READ_BYTES = 1 * 1024 * 1024;
const MAX_MULTIPLE_READ_PATHS = 10;
const READ_AHEAD_SLACK = 64 * 1024;
const PATH_COUNT_SLACK = 32 * 1024;
const OVERSIZED_BYTES = 2 * 1024 * 1024;
const COUNT_FILE_BYTES = 64 * 1024;
const LIMIT_ERROR = /exceed|too (?:large|big|many)|maximum|size limit|max(?:imum)? (?:file |read |byte |path)|too many paths/i;

type ToolContent = {
  type: string;
  text?: string;
  data?: string;
  resource?: { text?: string; blob?: string };
};

type ToolResult = {
  isError?: boolean;
  content?: ToolContent[];
};

function serverBytesRead(pid: number): number {
  const text = readFileSync(`/proc/${pid}/io`, 'utf8');
  const match = /^rchar:\s+(\d+)/m.exec(text);
  if (!match) {
    throw new Error(`rchar missing from /proc/${pid}/io`);
  }
  return Number(match[1]);
}

function resultText(result: ToolResult): string {
  return (result.content ?? [])
    .map((item) => item.text ?? item.data ?? item.resource?.text ?? item.resource?.blob ?? '')
    .join('\n');
}

function assertBoundedRefusal(result: ToolResult, bytesRead: number, maxBytesRead: number): void {
  const text = resultText(result);
  expect(bytesRead, `server read ${bytesRead} bytes; cap is ${maxBytesRead}`).toBeLessThanOrEqual(maxBytesRead);
  expect(text.length, `response length ${text.length}`).toBeLessThan(8_192);
  expect(text).toMatch(LIMIT_ERROR);
  expect(text).not.toContain('a'.repeat(1000));
  expect(text).not.toContain('b'.repeat(1000));
}

describe('filesystem read size bounds', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let testDir: string;
  let pid: number;

  beforeAll(async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-bounds-'));
    testDir = await fs.realpath(tmpDir);
    const serverPath = path.resolve(__dirname, '../dist/index.js');
    transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, testDir],
    });
    client = new Client({ name: 'read-bounds', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    if (transport.pid === null) {
      throw new Error('filesystem server pid unavailable');
    }
    pid = transport.pid;
  });

  afterAll(async () => {
    await client?.close();
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  async function callTool(name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; bytesRead: number }> {
    const before = serverBytesRead(pid);
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    return { result, bytesRead: serverBytesRead(pid) - before };
  }

  async function writeBytes(name: string, byte: number, length: number): Promise<string> {
    const filePath = path.join(testDir, name);
    await fs.writeFile(filePath, Buffer.alloc(length, byte));
    return filePath;
  }

  it('returns a file that is under the cap', async () => {
    const filePath = await writeBytes('small.txt', 0x61, 5);
    const { result, bytesRead } = await callTool('read_text_file', { path: filePath });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toBe('aaaaa');
    expect(bytesRead).toBeLessThanOrEqual(MAX_FILE_READ_BYTES);
  });

  it('rejects an oversized read_text_file without reading the whole file', async () => {
    const filePath = await writeBytes('text-big.txt', 0x61, OVERSIZED_BYTES);
    const { result, bytesRead } = await callTool('read_text_file', { path: filePath });
    assertBoundedRefusal(result, bytesRead, MAX_FILE_READ_BYTES + READ_AHEAD_SLACK);
  });

  it('rejects an oversized deprecated read_file without reading the whole file', async () => {
    const filePath = await writeBytes('deprecated-big.txt', 0x61, OVERSIZED_BYTES);
    const { result, bytesRead } = await callTool('read_file', { path: filePath });
    assertBoundedRefusal(result, bytesRead, MAX_FILE_READ_BYTES + READ_AHEAD_SLACK);
  });

  it('rejects head on an oversized line without reading the whole file', async () => {
    const filePath = await writeBytes('head-big.txt', 0x61, OVERSIZED_BYTES);
    const { result, bytesRead } = await callTool('read_text_file', { path: filePath, head: 1 });
    assertBoundedRefusal(result, bytesRead, MAX_FILE_READ_BYTES + READ_AHEAD_SLACK);
  });

  it('rejects tail on an oversized line without reading the whole file', async () => {
    const filePath = await writeBytes('tail-big.txt', 0x61, OVERSIZED_BYTES);
    const { result, bytesRead } = await callTool('read_text_file', { path: filePath, tail: 1 });
    assertBoundedRefusal(result, bytesRead, MAX_FILE_READ_BYTES + READ_AHEAD_SLACK);
  });

  it('rejects an oversized read_media_file before base64-encoding the whole file', async () => {
    const filePath = await writeBytes('media-big.bin', 0x61, OVERSIZED_BYTES);
    const { result, bytesRead } = await callTool('read_media_file', { path: filePath });
    assertBoundedRefusal(result, bytesRead, MAX_FILE_READ_BYTES + READ_AHEAD_SLACK);
    const encoded = Buffer.alloc(OVERSIZED_BYTES, 0x61).toString('base64');
    expect(resultText(result).length).toBeLessThan(encoded.length);
  });

  it('rejects an oversized path in read_multiple_files without reading every byte', async () => {
    const first = await writeBytes('multi-a.txt', 0x61, OVERSIZED_BYTES);
    const second = await writeBytes('multi-b.txt', 0x61, OVERSIZED_BYTES);
    const { result, bytesRead } = await callTool('read_multiple_files', { paths: [first, second] });
    assertBoundedRefusal(result, bytesRead, MAX_FILE_READ_BYTES + READ_AHEAD_SLACK);
  });

  it('rejects read_multiple_files above the path cap before reading file bodies', async () => {
    const paths: string[] = [];
    for (let index = 0; index < MAX_MULTIPLE_READ_PATHS + 1; index++) {
      paths.push(await writeBytes(`count-${index}.txt`, 0x63, COUNT_FILE_BYTES));
    }
    const { result, bytesRead } = await callTool('read_multiple_files', { paths });
    assertBoundedRefusal(result, bytesRead, PATH_COUNT_SLACK);
  });

  it('rejects edit_file on an oversized file without reading it all or creating files', async () => {
    const filePath = await writeBytes('edit-big.txt', 0x61, OVERSIZED_BYTES);
    const seen = new Set<string>();
    const watcher: FSWatcher = watch(testDir, (_event, filename) => {
      if (filename) {
        seen.add(filename);
      }
    });
    try {
      const { result, bytesRead } = await callTool('edit_file', {
        path: filePath,
        edits: [{ oldText: 'NOT_IN_FILE', newText: 'x' }],
        dryRun: false,
      });
      assertBoundedRefusal(result, bytesRead, MAX_FILE_READ_BYTES + READ_AHEAD_SLACK);
      expect([...seen].filter((name) => name !== 'edit-big.txt')).toEqual([]);
      expect((await fs.stat(filePath)).size).toBe(OVERSIZED_BYTES);
    } finally {
      watcher.close();
    }
  });

  it('does not trust stat size 0 when read_text_file streams a fifo', async () => {
    const fifo = path.join(testDir, 'text.fifo');
    execFileSync('mkfifo', [fifo]);
    const { result, bytesRead } = await readFifo(fifo, () => callTool('read_text_file', { path: fifo }));
    assertBoundedRefusal(result, bytesRead, MAX_FILE_READ_BYTES + READ_AHEAD_SLACK);
  });

  it('does not trust stat size 0 when read_media_file streams a fifo', async () => {
    const fifo = path.join(testDir, 'media.fifo');
    execFileSync('mkfifo', [fifo]);
    const { result, bytesRead } = await readFifo(fifo, () => callTool('read_media_file', { path: fifo }));
    assertBoundedRefusal(result, bytesRead, MAX_FILE_READ_BYTES + READ_AHEAD_SLACK);
  });

  it('does not trust stat size 0 when read_multiple_files streams a fifo', async () => {
    const fifo = path.join(testDir, 'multi.fifo');
    execFileSync('mkfifo', [fifo]);
    const { result, bytesRead } = await readFifo(fifo, () => callTool('read_multiple_files', { paths: [fifo] }));
    assertBoundedRefusal(result, bytesRead, MAX_FILE_READ_BYTES + READ_AHEAD_SLACK);
  });

  it('does not trust stat size 0 when edit_file reads a fifo', async () => {
    const fifo = path.join(testDir, 'edit.fifo');
    execFileSync('mkfifo', [fifo]);
    const { result, bytesRead } = await readFifo(fifo, () =>
      callTool('edit_file', {
        path: fifo,
        edits: [{ oldText: 'NOT_IN_FILE', newText: 'x' }],
        dryRun: true,
      }),
    );
    assertBoundedRefusal(result, bytesRead, MAX_FILE_READ_BYTES + READ_AHEAD_SLACK);
    const entries = await fs.readdir(testDir);
    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});

function readFifo(
  fifo: string,
  read: () => Promise<{ result: ToolResult; bytesRead: number }>,
): Promise<{ result: ToolResult; bytesRead: number }> {
  const writer = createWriteStream(fifo);
  const payload = Buffer.alloc(OVERSIZED_BYTES, 0x62);
  const opened = new Promise<void>((resolve, reject) => {
    writer.once('open', () => {
      writer.end(payload, () => resolve());
    });
    writer.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') {
        resolve();
        return;
      }
      reject(error);
    });
  });
  const timed = new Promise<{ result: ToolResult; bytesRead: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out reading ${fifo}`)), 10_000);
    read().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
  return timed.finally(() => {
    writer.destroy();
    return opened.catch(() => undefined);
  });
}
