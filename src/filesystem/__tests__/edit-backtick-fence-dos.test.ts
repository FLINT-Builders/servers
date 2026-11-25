import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { applyFileEdits } from '../lib.js';

/**
 * The edit preview picks a markdown fence by searching the whole diff for a
 * longer backtick run on every extra backtick. A single linear pass over a
 * diff of this size finishes inside the budget; the repeated search does not.
 * These tests stay red until that search is bounded and still refuses to
 * write when it rejects an edit.
 */
const BACKTICK_RUN = 160_000;
const MAX_ELAPSED_MS = 1_000;
const SLOW_TEST_TIMEOUT_MS = 90_000;

async function makeDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-backtick-'));
  return fs.realpath(directory);
}

async function tempFileNames(directory: string): Promise<string[]> {
  const names = await fs.readdir(directory);
  return names.filter((name) => name.endsWith('.tmp'));
}

describe('edit backtick fence', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await makeDir();
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('wraps a diff that already contains backticks in a longer fence', async () => {
    const filePath = path.join(directory, 'note.txt');
    const original = 'before\n`````\n';
    await fs.writeFile(filePath, original);

    const result = await applyFileEdits(filePath, [
      { oldText: 'before', newText: 'after' },
    ], true);

    const fence = '`'.repeat(6);
    const opening = `${fence}diff\n`;
    const closing = `${fence}\n\n`;
    expect(result.startsWith(opening)).toBe(true);
    expect(result.endsWith(closing)).toBe(true);
    const body = result.slice(opening.length, result.length - closing.length);
    expect(body.includes(fence)).toBe(false);
    expect(await fs.readFile(filePath, 'utf8')).toBe(original);
    expect(await tempFileNames(directory)).toEqual([]);
  });

  it('finishes a dry run when the file is one long backtick run', async () => {
    const filePath = path.join(directory, 'ticks.txt');
    const original = '`'.repeat(BACKTICK_RUN);
    await fs.writeFile(filePath, original);

    const started = performance.now();
    try {
      await applyFileEdits(filePath, [
        { oldText: '`', newText: 'x' },
      ], true);
    } catch {
      // Rejecting an oversized diff is acceptable when it happens inside the budget.
    }
    const elapsedMs = performance.now() - started;

    expect(await tempFileNames(directory)).toEqual([]);
    expect(await fs.readFile(filePath, 'utf8')).toBe(original);
    expect(elapsedMs).toBeLessThan(MAX_ELAPSED_MS);
  }, SLOW_TEST_TIMEOUT_MS);

  it('finishes a dry run when the replacement is one long backtick run', async () => {
    const filePath = path.join(directory, 'short.txt');
    const original = 'alpha\nbeta\n';
    await fs.writeFile(filePath, original);

    const started = performance.now();
    try {
      await applyFileEdits(filePath, [
        { oldText: 'beta', newText: '`'.repeat(BACKTICK_RUN) },
      ], true);
    } catch {
      // Rejecting an oversized diff is acceptable when it happens inside the budget.
    }
    const elapsedMs = performance.now() - started;

    expect(await tempFileNames(directory)).toEqual([]);
    expect(await fs.readFile(filePath, 'utf8')).toBe(original);
    expect(elapsedMs).toBeLessThan(MAX_ELAPSED_MS);
  }, SLOW_TEST_TIMEOUT_MS);

  it('finishes a real edit of a long backtick run and leaves no temp file', async () => {
    const filePath = path.join(directory, 'ticks.txt');
    const original = '`'.repeat(BACKTICK_RUN);
    const edited = `x${'`'.repeat(BACKTICK_RUN - 1)}`;
    await fs.writeFile(filePath, original);

    const started = performance.now();
    let rejected = false;
    try {
      await applyFileEdits(filePath, [
        { oldText: '`', newText: 'x' },
      ], false);
    } catch {
      rejected = true;
    }
    const elapsedMs = performance.now() - started;

    expect(await tempFileNames(directory)).toEqual([]);
    expect(await fs.readFile(filePath, 'utf8')).toBe(rejected ? original : edited);
    expect(elapsedMs).toBeLessThan(MAX_ELAPSED_MS);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe('edit_file tool backtick fence', () => {
  let directory: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeEach(async () => {
    directory = await makeDir();
    const serverPath = path.resolve(__dirname, '../dist/index.js');
    transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, directory],
    });
    client = new Client(
      { name: 'backtick-fence-test', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
  });

  afterEach(async () => {
    await client?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('finishes an edit_file dry run of a long backtick run within the budget', async () => {
    const filePath = path.join(directory, 'ticks.txt');
    const original = '`'.repeat(BACKTICK_RUN);
    await fs.writeFile(filePath, original);

    const started = performance.now();
    try {
      await client.callTool({
        name: 'edit_file',
        arguments: {
          path: filePath,
          edits: [{ oldText: '`', newText: 'x' }],
          dryRun: true,
        },
      });
    } catch {
      // A tool error is acceptable when the server rejects the edit inside the budget.
    }
    const elapsedMs = performance.now() - started;

    expect(await tempFileNames(directory)).toEqual([]);
    expect(await fs.readFile(filePath, 'utf8')).toBe(original);
    expect(elapsedMs).toBeLessThan(MAX_ELAPSED_MS);
  }, SLOW_TEST_TIMEOUT_MS);
});
