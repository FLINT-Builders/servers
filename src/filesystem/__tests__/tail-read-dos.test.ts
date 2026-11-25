import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tailFile } from '../lib.js';

/**
 * Bounds a safe tail implementation must enforce.
 * tailFile currently inserts every 1KB chunk at the front of an array
 * (lib.ts) and both read_file and read_text_file pass the caller-supplied
 * `tail` count through with no maximum (index.ts). These tests fail until
 * that scan is linear and capped.
 *
 * headFile is a separate scan (it does not unshift chunks) and is not covered here.
 */
const MAX_TAIL_LINES = 10_000;
const MAX_TAIL_BYTES = 1024 * 1024;
const READ_SLACK_BYTES = 64 * 1024;

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-tail-')));
  tempDirs.push(dir);
  return dir;
}

/**
 * Count bytes tailFile actually pulls from the filesystem, and how many
 * element moves its prepends perform. A quadratic unshift of one buffer per
 * chunk moves n(n-1)/2 elements; push-then-reverse moves none via unshift.
 */
async function measureTail(
  filePath: string,
  numLines: number,
): Promise<{ text: string; bytesRead: number; prependCalls: number; elementsShifted: number }> {
  let bytesRead = 0;
  let prependCalls = 0;
  let elementsShifted = 0;

  const originalOpen = fs.open;
  const originalReadFile = fs.readFile;

  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await originalOpen.call(fs, file, flags, mode);
    return wrapHandle(handle);
  });
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    const result = await originalReadFile.apply(fs, args);
    bytesRead += typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength;
    return result;
  });

  const originalUnshift = Array.prototype.unshift;
  const originalSplice = Array.prototype.splice;
  Array.prototype.unshift = function (this: unknown[], ...items: unknown[]): number {
    if (items.some(isByteChunk)) {
      prependCalls += 1;
      elementsShifted += this.length * items.length;
    }
    return originalUnshift.apply(this, items);
  };
  Array.prototype.splice = function (
    this: unknown[],
    start: number,
    deleteCount?: number,
    ...items: unknown[]
  ): unknown[] {
    if (items.some(isByteChunk)) {
      const len = this.length;
      const index = start < 0 ? Math.max(len + start, 0) : start;
      if (index <= 0) {
        prependCalls += 1;
        elementsShifted += len * items.length;
      }
    }
    return originalSplice.call(this, start, deleteCount as number, ...items);
  };

  try {
    const text = await tailFile(filePath, numLines);
    return { text, bytesRead, prependCalls, elementsShifted };
  } finally {
    Array.prototype.unshift = originalUnshift;
    Array.prototype.splice = originalSplice;
  }

  function wrapHandle(handle: FileHandle): FileHandle {
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop === 'read') {
          return async (...args: unknown[]) => {
            const result = await (target.read as (...readArgs: unknown[]) => Promise<{ bytesRead: number }>).apply(target, args);
            bytesRead += result.bytesRead ?? 0;
            return result;
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...fnArgs: unknown[]) => unknown).bind(target) : value;
      },
    });
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function isByteChunk(value: unknown): boolean {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function assertBoundedScan(measured: { bytesRead: number; prependCalls: number; elementsShifted: number }, maxBytes: number): void {
  // One move per chunk already stored is quadratic. A linear insert shifts
  // each chunk a constant number of times, so the total stays within a
  // small multiple of the number of prepends (zero when chunks are pushed).
  expect(measured.elementsShifted).toBeLessThanOrEqual(measured.prependCalls * 2);
  expect(measured.bytesRead).toBeGreaterThan(0);
  expect(measured.bytesRead).toBeLessThanOrEqual(maxBytes);
}

describe('tailFile quadratic chunk inserts', () => {
  it('returns the exact last lines of a small file', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'small.txt');
    await fs.writeFile(filePath, 'one\ntwo\nthree\nfour\nfive');

    const { text, bytesRead } = await measureTail(filePath, 2);

    expect(text).toBe('four\nfive');
    expect(bytesRead).toBeGreaterThan(0);
    expect(bytesRead).toBeLessThanOrEqual(MAX_TAIL_BYTES);
  });

  it('does not scan a newline-free file quadratically when tail is 1', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'one-line.bin');
    const marker = 'TAIL_MARKER_END';
    const size = MAX_TAIL_BYTES * 2;
    const body = Buffer.alloc(size - marker.length, 0x61);
    const content = Buffer.concat([body, Buffer.from(marker)]);
    await fs.writeFile(filePath, content);

    const measured = await measureTail(filePath, 1);

    expect(measured.text.endsWith(marker)).toBe(true);
    expect(content.toString('utf8').endsWith(measured.text)).toBe(true);
    assertBoundedScan(measured, MAX_TAIL_BYTES + READ_SLACK_BYTES);
    expect(measured.text.length).toBeLessThanOrEqual(MAX_TAIL_BYTES);
  });

  it('does not honor an unbounded tail line count', async () => {
    const dir = await makeDir();
    const filePath = path.join(dir, 'many-lines.txt');
    const line = '0123456789abcdef0123456789abcd\n';
    const lineCount = MAX_TAIL_LINES * 4;
    await fs.writeFile(filePath, line.repeat(lineCount));

    const measured = await measureTail(filePath, Number.MAX_SAFE_INTEGER);

    expect(measured.text.endsWith(line.trimEnd()) || measured.text.endsWith(line)).toBe(true);
    assertBoundedScan(measured, MAX_TAIL_LINES * line.length + READ_SLACK_BYTES);
    expect(countLines(measured.text)).toBeLessThanOrEqual(MAX_TAIL_LINES);
  });
});

describe('read tool tail arguments', () => {
  let client: Client;
  let transport: StdioClientTransport;

  async function startServer(root: string): Promise<void> {
    const serverPath = path.resolve(__dirname, '../dist/index.js');
    transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, root],
    });
    client = new Client(
      { name: 'tail-read-dos-test', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
  }

  afterEach(async () => {
    await client?.close();
  });

  async function toolText(toolName: string, filePath: string, tail: number): Promise<string> {
    const result = await client.callTool({
      name: toolName,
      arguments: { path: filePath, tail },
    });
    expect(result.isError).not.toBe(true);
    const block = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(block?.type).toBe('text');
    const structured = result.structuredContent as { content: unknown };
    expect(structured.content).toBe(block?.text);
    return block?.text ?? '';
  }

  for (const toolName of ['read_text_file', 'read_file'] as const) {
    it(`${toolName} tails a small file exactly`, async () => {
      const dir = await makeDir();
      const filePath = path.join(dir, 'small.txt');
      await fs.writeFile(filePath, 'one\ntwo\nthree\nfour\nfive');
      await startServer(dir);

      const text = await toolText(toolName, filePath, 2);

      expect(text).toBe('four\nfive');
    });

    it(`${toolName} caps a newline-free tail read`, async () => {
      const dir = await makeDir();
      const filePath = path.join(dir, 'one-line.bin');
      const marker = 'TAIL_MARKER_END';
      const size = MAX_TAIL_BYTES * 2;
      const content = Buffer.concat([
        Buffer.alloc(size - marker.length, 0x61),
        Buffer.from(marker),
      ]);
      await fs.writeFile(filePath, content);
      await startServer(dir);

      const text = await toolText(toolName, filePath, 1);

      expect(text.endsWith(marker)).toBe(true);
      expect(content.toString('utf8').endsWith(text)).toBe(true);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TAIL_BYTES);
    });

    it(`${toolName} caps an enormous tail line count`, async () => {
      const dir = await makeDir();
      const filePath = path.join(dir, 'many-lines.txt');
      const line = '0123456789abcdef0123456789abcd\n';
      const lineCount = MAX_TAIL_LINES * 2;
      await fs.writeFile(filePath, line.repeat(lineCount));
      await startServer(dir);

      const text = await toolText(toolName, filePath, 1_000_000_000_000);

      expect(countLines(text)).toBeLessThanOrEqual(MAX_TAIL_LINES);
      expect(text.endsWith(line.trimEnd()) || text.endsWith(line)).toBe(true);
    });
  }
});
