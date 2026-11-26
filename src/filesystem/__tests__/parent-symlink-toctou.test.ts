import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Spec for the parent-symlink time-of-check/time-of-use escape.
 *
 * create_directory, move_file, write_file, and edit_file all validate a path
 * and then create or rename through that string. mkdir, rename, and writeFile
 * follow a parent directory that is replaced with a symlink after validation.
 * The preload swaps that parent at the start of those calls, which is after
 * every realpath the handler can do beforehand. The outside directory must
 * stay unchanged whether the tool succeeds or throws: a file created there and
 * then rejected is still an escape.
 *
 * Read-only tools are not part of this spec. They do not create or move
 * entries: read_text_file, read_file, read_media_file, read_multiple_files,
 * list_directory, list_directory_with_sizes, directory_tree, search_files,
 * get_file_info, list_allowed_directories.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '../dist/index.js');
const preloadPath = path.resolve(here, 'helpers/parent-symlink-race-preload.cjs');
const sentinelName = 'sentinel.txt';
const sentinelBody = 'sentinel';

interface Sandbox {
  root: string;
  allowedDir: string;
  parentDir: string;
  outsideDir: string;
  markerPath: string;
}

const sandboxes: Sandbox[] = [];

async function makeSandbox(): Promise<Sandbox> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-parent-symlink-')));
  const allowedDir = path.join(root, 'allowed');
  const parentDir = path.join(allowedDir, 'parent');
  const outsideDir = path.join(root, 'outside');
  const markerPath = path.join(root, 'race-marker.txt');
  await fs.mkdir(parentDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(outsideDir, sentinelName), sentinelBody);
  const sandbox = { root, allowedDir, parentDir, outsideDir, markerPath };
  sandboxes.push(sandbox);
  return sandbox;
}

async function cleanupSandbox(sandbox: Sandbox): Promise<void> {
  const parentStat = await fs.lstat(sandbox.parentDir).catch(() => null);
  if (parentStat?.isSymbolicLink()) {
    await fs.unlink(sandbox.parentDir);
  }
  await fs.rm(sandbox.root, { recursive: true, force: true });
}

afterEach(async () => {
  while (sandboxes.length > 0) {
    const sandbox = sandboxes.pop();
    if (sandbox) {
      await cleanupSandbox(sandbox);
    }
  }
});

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (error) {
    return error instanceof Error ? { thrown: error.message } : { thrown: String(error) };
  }
}

async function withServer(sandbox: Sandbox, body: (client: Client) => Promise<void>): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--require', preloadPath, serverPath, sandbox.allowedDir],
    env: {
      PARENT_SYMLINK_RACE_PARENT: sandbox.parentDir,
      PARENT_SYMLINK_RACE_OUTSIDE: sandbox.outsideDir,
      PARENT_SYMLINK_RACE_MARKER: sandbox.markerPath,
    },
    stderr: 'pipe',
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk));
  });
  const client = new Client(
    { name: 'parent-symlink-toctou', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    await body(client);
  } finally {
    await client.close().catch(() => undefined);
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    if (stderr.trim()) {
      console.error(stderr);
    }
  }
}

async function expectOutsideUntouched(sandbox: Sandbox, detail: unknown): Promise<void> {
  const entries = (await fs.readdir(sandbox.outsideDir)).sort();
  const sentinel = await fs.readFile(path.join(sandbox.outsideDir, sentinelName), 'utf8').catch(() => '<missing>');
  const marker = await fs.readFile(sandbox.markerPath, 'utf8').catch(() => '<not swapped>');
  expect({
    outsideEntries: entries,
    sentinel,
    marker,
    detail,
  }).toEqual({
    outsideEntries: [sentinelName],
    sentinel: sentinelBody,
    marker,
    detail,
  });
}

describe('parent symlink swapped after path validation', () => {
  it('create_directory does not create a directory through a replaced parent', async () => {
    const sandbox = await makeSandbox();
    const requested = path.join(sandbox.parentDir, 'created');
    await withServer(sandbox, async (client) => {
      const result = await callTool(client, 'create_directory', { path: requested });
      await expectOutsideUntouched(sandbox, result);
    });
  });

  it('create_directory does not mkdir -p through a replaced parent', async () => {
    const sandbox = await makeSandbox();
    const requested = path.join(sandbox.parentDir, 'nested', 'created');
    await withServer(sandbox, async (client) => {
      const result = await callTool(client, 'create_directory', { path: requested });
      await expectOutsideUntouched(sandbox, result);
    });
  });

  it('move_file does not rename a file through a replaced destination parent', async () => {
    const sandbox = await makeSandbox();
    const sourceDir = path.join(sandbox.allowedDir, 'source');
    const source = path.join(sourceDir, 'payload.txt');
    const destination = path.join(sandbox.parentDir, 'landed.txt');
    await fs.mkdir(sourceDir);
    await fs.writeFile(source, 'move-payload');
    await withServer(sandbox, async (client) => {
      const result = await callTool(client, 'move_file', { source, destination });
      await expectOutsideUntouched(sandbox, result);
    });
  });

  it('move_file does not rename a directory through a replaced destination parent', async () => {
    const sandbox = await makeSandbox();
    const source = path.join(sandbox.allowedDir, 'project');
    const destination = path.join(sandbox.parentDir, 'project');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'payload.txt'), 'dir-move-payload');
    await withServer(sandbox, async (client) => {
      const result = await callTool(client, 'move_file', { source, destination });
      await expectOutsideUntouched(sandbox, result);
    });
  });

  it('write_file does not create a file through a replaced parent', async () => {
    const sandbox = await makeSandbox();
    const requested = path.join(sandbox.parentDir, 'written.txt');
    await withServer(sandbox, async (client) => {
      const result = await callTool(client, 'write_file', { path: requested, content: 'written-payload' });
      await expectOutsideUntouched(sandbox, result);
    });
  });

  it('edit_file does not write edits through a replaced parent', async () => {
    const sandbox = await makeSandbox();
    const requested = path.join(sandbox.parentDir, 'notes.txt');
    await fs.writeFile(requested, 'hello');
    await withServer(sandbox, async (client) => {
      const result = await callTool(client, 'edit_file', {
        path: requested,
        dryRun: false,
        edits: [{ oldText: 'hello', newText: 'hello-edited' }],
      });
      await expectOutsideUntouched(sandbox, result);
    });
  });
});
