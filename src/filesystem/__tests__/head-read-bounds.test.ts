import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { headFile } from '../lib.js';

/**
 * Spec for the filesystem head-read DoS.
 *
 * headFile appends every 1KB chunk onto one string and calls lastIndexOf on
 * that string until it sees a newline. On a single long line the scan is
 * quadratic in the number of bytes and the tool returns the entire line.
 *
 * A fix must:
 * - Stop scanning after a fixed budget even when the requested line count
 *   has not been reached, and return only the bytes scanned.
 * - Keep that budget at or below MAX_HEAD_SCAN_BYTES.
 * - Still return the requested lines when they fit in the budget.
 * - Reject non-integer and non-positive head values from read_text_file and
 *   read_file before treating them as a line count.
 *
 * These tests fail while the unbounded scan is still in place.
 */

/** Largest prefix a head scan may read or return. */
const MAX_HEAD_SCAN_BYTES = 1024 * 1024;

/**
 * Single line several times the budget. Large enough that the quadratic
 * scan takes multiple seconds on this runtime, while a budgeted scan of at
 * most MAX_HEAD_SCAN_BYTES finishes well under OVERSIZED_HEAD_DEADLINE_MS.
 */
const OVERSIZED_LINE_BYTES = 4 * 1024 * 1024;
const OVERSIZED_HEAD_DEADLINE_MS = 2000;

/** Smallest prefix a budgeted scan should still return for an oversized line. */
const MIN_BOUNDED_PREFIX_BYTES = 64 * 1024;

async function writeBytes(filePath: string, size: number, pattern: Buffer): Promise<void> {
  const handle = await fs.open(filePath, 'w');
  try {
    let remaining = size;
    while (remaining > 0) {
      const slice = remaining >= pattern.length ? pattern : pattern.subarray(0, remaining);
      await handle.write(slice);
      remaining -= slice.length;
    }
  } finally {
    await handle.close();
  }
}

function expectBoundedPrefix(text: string): void {
  expect(text.length).toBeGreaterThanOrEqual(MIN_BOUNDED_PREFIX_BYTES);
  expect(text.length).toBeLessThanOrEqual(MAX_HEAD_SCAN_BYTES);
  expect(text).toBe('a'.repeat(text.length));
}

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: { content?: unknown };
};

function toolText(result: ToolResult): string {
  return (result.content ?? []).map((block) => block.text ?? '').join('');
}

describe('head reads are bounded', () => {
  let testDir: string;
  let oversizedLine: string;
  let shortLines: string;
  let smallText: string;

  beforeAll(async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-head-'));
    testDir = await fs.realpath(tmpDir);
    oversizedLine = path.join(testDir, 'oversized-line.txt');
    shortLines = path.join(testDir, 'short-lines.txt');
    smallText = path.join(testDir, 'small.txt');

    await writeBytes(oversizedLine, OVERSIZED_LINE_BYTES, Buffer.alloc(64 * 1024, 0x61));

    const line = `${'b'.repeat(19)}\n`;
    const lineBytes = Buffer.from(line);
    const shortLineBytes = lineBytes.length * Math.ceil((MAX_HEAD_SCAN_BYTES + 256 * 1024) / lineBytes.length);
    await writeBytes(shortLines, shortLineBytes, lineBytes);

    await fs.writeFile(smallText, 'one\ntwo\nthree\n');
  }, 30_000);

  afterAll(async () => {
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe('headFile', () => {
    it('returns only the requested lines when they fit in the byte budget', async () => {
      const result = await headFile(smallText, 2);
      expect(result).toBe('one\ntwo');
    });

    it('stops a single line that has no newline within the byte budget', async () => {
      const started = performance.now();
      const result = await headFile(oversizedLine, 1);
      const elapsed = performance.now() - started;

      expectBoundedPrefix(result);
      expect(elapsed).toBeLessThan(OVERSIZED_HEAD_DEADLINE_MS);
    }, 30_000);

    it('stops after the byte budget when head asks for more lines than the file has', async () => {
      const started = performance.now();
      const result = await headFile(shortLines, 1_000_000);
      const elapsed = performance.now() - started;

      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(MAX_HEAD_SCAN_BYTES);
      expect(result.startsWith('b'.repeat(19))).toBe(true);
      expect(elapsed).toBeLessThan(OVERSIZED_HEAD_DEADLINE_MS);
    }, 30_000);
  });

  describe('read_text_file and read_file tools', () => {
    let client: Client;
    let transport: StdioClientTransport;

    beforeAll(async () => {
      const serverPath = path.resolve(__dirname, '../dist/index.js');
      await fs.access(serverPath);
      transport = new StdioClientTransport({
        command: 'node',
        args: [serverPath, testDir],
      });
      client = new Client({ name: 'head-bounds-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
    }, 30_000);

    afterAll(async () => {
      await client?.close();
    });

    async function callRead(tool: 'read_text_file' | 'read_file', head: number, filePath: string): Promise<ToolResult> {
      return await client.callTool({
        name: tool,
        arguments: { path: filePath, head },
      }) as ToolResult;
    }

    for (const tool of ['read_text_file', 'read_file'] as const) {
      it(`${tool} stops a long first line at the byte budget`, async () => {
        const started = performance.now();
        const result = await callRead(tool, 1, oversizedLine);
        const elapsed = performance.now() - started;

        expect(result.isError).not.toBe(true);
        const text = toolText(result);
        expectBoundedPrefix(text);
        expect(result.structuredContent).toEqual({ content: text });
        expect(elapsed).toBeLessThan(OVERSIZED_HEAD_DEADLINE_MS);
      }, 30_000);

      it(`${tool} stops a large head count at the byte budget`, async () => {
        const result = await callRead(tool, 1_000_000, shortLines);
        expect(result.isError).not.toBe(true);
        const text = toolText(result);
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThanOrEqual(MAX_HEAD_SCAN_BYTES);
        expect(text.startsWith('b'.repeat(19))).toBe(true);
      }, 30_000);

      it(`${tool} still returns the requested lines of a small file`, async () => {
        const result = await callRead(tool, 2, smallText);
        expect(result.isError).not.toBe(true);
        expect(toolText(result)).toBe('one\ntwo');
      });

      for (const head of [0, -1, 1.5]) {
        it(`${tool} rejects head=${head} before scanning`, async () => {
          const started = performance.now();
          const result = await callRead(tool, head, oversizedLine);
          const elapsed = performance.now() - started;

          expect(result.isError).toBe(true);
          expect(toolText(result)).not.toContain('a'.repeat(1024));
          expect(elapsed).toBeLessThan(OVERSIZED_HEAD_DEADLINE_MS);
        }, 30_000);
      }
    }
  });
});
