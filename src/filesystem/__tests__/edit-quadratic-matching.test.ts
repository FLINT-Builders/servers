import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { applyFileEdits } from '../lib.js';

const execFileAsync = promisify(execFile);

/**
 * Bound for one edit against the fixture below. A linear scan of this input
 * finishes well under the bound. The line-window search does not.
 */
const BUDGET_MS = 2_000;
const FILE_LINES = 48_000;
const OLD_LINES = 24_000;
const LINE = 'alpha';

const SERVER_PATH = path.join(__dirname, '..', 'dist', 'index.js');
const directories: string[] = [];

function repeated(count: number, line: string): string {
  return Array.from({ length: count }, () => line).join('\n');
}

/** Old text agrees with every file line except its own last line, so exact search misses and every window trims the whole block. */
function nearMissOldText(): string {
  return `${repeated(OLD_LINES - 1, LINE)}\nNO_MATCH`;
}

async function makeFile(content: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-quadratic-'));
  directories.push(directory);
  const filePath = path.join(directory, 'target.txt');
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function expectUnchangedAndFast(
  filePath: string,
  edits: { oldText: string; newText: string }[],
  dryRun: boolean,
): Promise<void> {
  const directory = path.dirname(filePath);
  const before = await fs.readFile(filePath, 'utf-8');
  const beforeNames = (await fs.readdir(directory)).sort();
  const started = performance.now();
  await applyFileEdits(filePath, edits, dryRun).catch(() => undefined);
  const elapsed = performance.now() - started;
  expect(elapsed, `edit matching took ${elapsed.toFixed(0)}ms`).toBeLessThan(BUDGET_MS);
  expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
  expect((await fs.readdir(directory)).sort()).toEqual(beforeNames);
}

describe('filesystem edit quadratic matching', () => {
  beforeAll(async () => {
    const tsc = path.join(__dirname, '..', '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
    await execFileAsync(process.execPath, [tsc, '-p', path.join(__dirname, '..', 'tsconfig.json')]);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  });

  it('settles a large non-matching edit without rewriting the file', async () => {
    const content = repeated(FILE_LINES, LINE);
    const oldText = nearMissOldText();
    expect(content.includes(oldText)).toBe(false);
    const filePath = await makeFile(content);
    await expectUnchangedAndFast(filePath, [{ oldText, newText: 'replacement' }], false);
  }, 30_000);

  it('settles the same edit when dryRun is set', async () => {
    const content = repeated(FILE_LINES, LINE);
    const oldText = nearMissOldText();
    expect(content.includes(oldText)).toBe(false);
    const filePath = await makeFile(content);
    await expectUnchangedAndFast(filePath, [{ oldText, newText: 'replacement' }], true);
  }, 30_000);

  it('settles a later edit in the same batch after an exact match', async () => {
    const content = `HEADER\n${repeated(FILE_LINES, LINE)}`;
    const oldText = nearMissOldText();
    expect(content.includes(oldText)).toBe(false);
    const filePath = await makeFile(content);
    await expectUnchangedAndFast(filePath, [
      { oldText: 'HEADER', newText: 'TITLE' },
      { oldText, newText: 'replacement' },
    ], false);
  }, 30_000);

  it('keeps serving later tool calls while edit_file searches', async () => {
    const content = repeated(FILE_LINES, LINE);
    const oldText = nearMissOldText();
    expect(content.includes(oldText)).toBe(false);
    const filePath = await makeFile(content);
    const directory = path.dirname(filePath);
    const before = await fs.readFile(filePath, 'utf-8');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH, directory],
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => undefined);
    const client = new Client({ name: 'edit-quadratic-test', version: '0.0.0' });
    await client.connect(transport);

    const editPromise = client.callTool({
      name: 'edit_file',
      arguments: {
        path: filePath,
        edits: [{ oldText, newText: 'replacement' }],
        dryRun: false,
      },
    }, undefined, { timeout: 5_000 }).then(
      (result) => ({ kind: 'edit' as const, result }),
      (error: unknown) => ({ kind: 'edit-error' as const, error }),
    );

    // validatePath and readFile yield; half a second later the matcher is inside its synchronous scan.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const listStarted = performance.now();
    const listPromise = client.callTool({
      name: 'list_allowed_directories',
      arguments: {},
    }, undefined, { timeout: 5_000 }).then(
      (result) => ({ kind: 'list' as const, result, elapsed: performance.now() - listStarted }),
      (error: unknown) => ({ kind: 'list-error' as const, error, elapsed: performance.now() - listStarted }),
    );
    const winner = await Promise.race([
      listPromise,
      new Promise<{ kind: 'timeout'; elapsed: number }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout', elapsed: performance.now() - listStarted }), BUDGET_MS);
      }),
    ]);

    const pid = transport.pid;
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The child already exited.
      }
    }
    await client.close().catch(() => undefined);
    editPromise.catch(() => undefined);

    expect(winner.kind, `list_allowed_directories did not return (${winner.kind} after ${winner.elapsed.toFixed(0)}ms)`).toBe('list');
    expect(winner.elapsed).toBeLessThan(BUDGET_MS);
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
    expect((await fs.readdir(directory)).sort()).toEqual(['target.txt']);
  }, 20_000);
});
