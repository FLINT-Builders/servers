import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { formatSize } from '../lib.js';

/**
 * list_directory_with_sizes must not reveal stat metadata for a symlink target
 * outside the allowed directories. These tests call the built server.
 *
 * They fail while fs.stat follows those links. A fix that resolves the link,
 * checks the allowlist, then stats the original path again still fails the
 * race case: the harness retargets the link after realpath() returns.
 */

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const hookPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'helpers/symlink-race-hook.cjs');

const DIRECT_SIZE = 737;
const RELATIVE_SIZE = 812;
const CHAIN_SIZE = 819;
const RACE_SIZE = 851;
const DIRENT_FILE_SIZE = 651;

const roots: string[] = [];

interface ToolResult {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}

function resultText(result: ToolResult): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks
    .map((block) => {
      if (block && typeof block === 'object' && 'text' in block) {
        return String((block as { text: unknown }).text);
      }
      return '';
    })
    .join('\n');
}

function metadataLeak(text: string, size: number, mtime: Date): string | null {
  const rendered = formatSize(size);
  if (text.includes(rendered)) {
    return `rendered size ${rendered}`;
  }
  if (new RegExp(`(^|[^0-9])${size}([^0-9]|$)`).test(text)) {
    return `raw size ${size}`;
  }
  const stamps = [mtime.toISOString(), mtime.toUTCString(), mtime.toString(), String(mtime.getTime())];
  for (const stamp of stamps) {
    if (text.includes(stamp)) {
      return `mtime ${stamp}`;
    }
  }
  return null;
}

function expectNoTargetMetadata(text: string, size: number, mtime: Date): void {
  const leak = metadataLeak(text, size, mtime);
  expect(leak, `listing exposed outside metadata (${leak}):\n${text}`).toBeNull();
}

async function makeRoot(): Promise<{ root: string; allowed: string; outside: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fs-symlink-meta-')));
  roots.push(root);
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  return { root, allowed, outside };
}

async function writeOutsideFile(filePath: string, size: number, mtime: Date): Promise<void> {
  await fs.writeFile(filePath, Buffer.alloc(size, 0x61));
  await fs.utimes(filePath, mtime, mtime);
  const stats = await fs.stat(filePath);
  expect(stats.size).toBe(size);
  expect(stats.mtime.getTime()).toBe(mtime.getTime());
}

async function withServer(
  allowed: string,
  env: Record<string, string> | undefined,
  run: (client: Client) => Promise<void>
): Promise<void> {
  const args = env ? ['--require', hookPath, serverPath, allowed] : [serverPath, allowed];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env,
    stderr: 'pipe',
  });
  const stderr: Buffer[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
  });
  const client = new Client({ name: 'symlink-listing-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    await run(client);
  } catch (error) {
    const log = Buffer.concat(stderr).toString('utf8');
    if (log && !(error instanceof Error && error.name === 'AssertionError')) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nserver stderr:\n${log}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    await client.close();
  }
}

async function listWithSizes(client: Client, dir: string): Promise<string[]> {
  const texts: string[] = [];
  for (const sortBy of ['name', 'size'] as const) {
    const result = (await client.callTool({
      name: 'list_directory_with_sizes',
      arguments: { path: dir, sortBy },
    })) as ToolResult;
    expect(result.isError, resultText(result)).not.toBe(true);
    const text = resultText(result);
    const structured = (result.structuredContent as { content?: unknown } | undefined)?.content;
    expect(structured).toBe(text);
    texts.push(text);
  }
  return texts;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('list_directory_with_sizes symlink metadata', () => {
  it('does not disclose the size or mtime of a file outside the allowlist', async () => {
    const { allowed, outside } = await makeRoot();
    const outsideFile = path.join(outside, 'credential-file');
    const mtime = new Date('2001-02-03T04:05:06.000Z');
    await writeOutsideFile(outsideFile, DIRECT_SIZE, mtime);
    const link = path.join(allowed, 'convenient-link');
    await fs.symlink(outsideFile, link);
    const linkStat = await fs.lstat(link);
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(linkStat.size).not.toBe(DIRECT_SIZE);

    await withServer(allowed, undefined, async (client) => {
      for (const name of ['read_text_file', 'read_file', 'get_file_info'] as const) {
        const denied = (await client.callTool({
          name,
          arguments: { path: link },
        })) as ToolResult;
        expect(denied.isError, resultText(denied)).toBe(true);
        expectNoTargetMetadata(resultText(denied), DIRECT_SIZE, mtime);
      }

      const multiple = (await client.callTool({
        name: 'read_multiple_files',
        arguments: { paths: [link] },
      })) as ToolResult;
      expect(multiple.isError).not.toBe(true);
      expect(resultText(multiple)).toContain('Access denied');
      expectNoTargetMetadata(resultText(multiple), DIRECT_SIZE, mtime);

      const before = await fs.readFile(outsideFile);
      const listings = await listWithSizes(client, allowed);
      expect((await fs.readFile(outsideFile)).equals(before)).toBe(true);
      for (const text of listings) {
        expectNoTargetMetadata(text, DIRECT_SIZE, mtime);
        expect(text).not.toContain(outsideFile);
      }
    });
  });

  it('does not disclose metadata through a relative symlink', async () => {
    const { allowed, outside } = await makeRoot();
    const outsideFile = path.join(outside, 'credential-file');
    const mtime = new Date('2001-02-03T04:05:08.000Z');
    await writeOutsideFile(outsideFile, RELATIVE_SIZE, mtime);
    const link = path.join(allowed, 'relative-link');
    const relativeTarget = path.relative(allowed, outsideFile);
    expect(relativeTarget.startsWith(`..${path.sep}`)).toBe(true);
    await fs.symlink(relativeTarget, link);
    expect(await fs.realpath(link)).toBe(outsideFile);

    await withServer(allowed, undefined, async (client) => {
      for (const text of await listWithSizes(client, allowed)) {
        expectNoTargetMetadata(text, RELATIVE_SIZE, mtime);
      }
    });
  });

  it('does not disclose metadata when the first hop of a chain stays inside the allowlist', async () => {
    const { allowed, outside } = await makeRoot();
    const outsideFile = path.join(outside, 'credential-file');
    const mtime = new Date('2001-02-03T04:05:09.000Z');
    await writeOutsideFile(outsideFile, CHAIN_SIZE, mtime);
    const hop = path.join(allowed, 'hop');
    await fs.symlink(outsideFile, hop);
    const link = path.join(allowed, 'chain-link');
    await fs.symlink(hop, link);

    await withServer(allowed, undefined, async (client) => {
      for (const text of await listWithSizes(client, allowed)) {
        expectNoTargetMetadata(text, CHAIN_SIZE, mtime);
      }
    });
  });

  it('does not disclose metadata for a symlink to a directory outside the allowlist', async () => {
    const { allowed, outside } = await makeRoot();
    const mtime = new Date('2001-02-03T04:05:10.000Z');
    const inner = path.join(outside, 'nested-file');
    await writeOutsideFile(inner, DIRENT_FILE_SIZE, mtime);
    await fs.utimes(outside, mtime, mtime);
    const outsideStat = await fs.stat(outside);
    const link = path.join(allowed, 'dir-link');
    await fs.symlink(outside, link);
    const linkStat = await fs.lstat(link);
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(linkStat.size).not.toBe(outsideStat.size);
    expect(formatSize(linkStat.size)).not.toBe(formatSize(outsideStat.size));

    await withServer(allowed, undefined, async (client) => {
      const denied = (await client.callTool({
        name: 'list_directory_with_sizes',
        arguments: { path: link },
      })) as ToolResult;
      expect(denied.isError, resultText(denied)).toBe(true);
      expectNoTargetMetadata(resultText(denied), outsideStat.size, outsideStat.mtime);
      expectNoTargetMetadata(resultText(denied), DIRENT_FILE_SIZE, mtime);

      for (const text of await listWithSizes(client, allowed)) {
        expectNoTargetMetadata(text, outsideStat.size, outsideStat.mtime);
        expectNoTargetMetadata(text, DIRENT_FILE_SIZE, mtime);
        expect(text).not.toContain(outside);
      }
    });
  });

  it('does not disclose metadata when the symlink is retargeted after realpath', async () => {
    const { allowed, outside } = await makeRoot();
    const staticFile = path.join(outside, 'static-target');
    const raceFile = path.join(outside, 'race-target');
    const staticMtime = new Date('2001-02-03T04:05:06.000Z');
    const raceMtime = new Date('2001-02-03T04:05:11.000Z');
    await writeOutsideFile(staticFile, DIRECT_SIZE, staticMtime);
    await writeOutsideFile(raceFile, RACE_SIZE, raceMtime);

    const insideFile = path.join(allowed, 'inside.txt');
    await fs.writeFile(insideFile, Buffer.alloc(11, 0x62));
    const raceLink = path.join(allowed, 'race-link');
    await fs.symlink(insideFile, raceLink);
    const staticLink = path.join(allowed, 'static-link');
    await fs.symlink(staticFile, staticLink);

    await withServer(allowed, {
      SYMLINK_RACE_PATH: raceLink,
      SYMLINK_RACE_TARGET: raceFile,
    }, async (client) => {
      for (const text of await listWithSizes(client, allowed)) {
        expectNoTargetMetadata(text, DIRECT_SIZE, staticMtime);
        expectNoTargetMetadata(text, RACE_SIZE, raceMtime);
        expect(text).not.toContain(staticFile);
        expect(text).not.toContain(raceFile);
      }
    });
  });

  it('retargets the sentinel after realpath and before a following stat', async () => {
    const { allowed, outside } = await makeRoot();
    const raceFile = path.join(outside, 'race-target');
    const mtime = new Date('2001-02-03T04:05:11.000Z');
    await writeOutsideFile(raceFile, RACE_SIZE, mtime);
    const insideFile = path.join(allowed, 'inside.txt');
    await fs.writeFile(insideFile, Buffer.alloc(11, 0x62));
    const raceLink = path.join(allowed, 'race-link');
    await fs.symlink(insideFile, raceLink);

    const script = [
      "import fs from 'fs/promises';",
      'const requested = process.env.SYMLINK_RACE_PATH;',
      'const resolved = await fs.realpath(requested);',
      'const followed = await fs.stat(requested);',
      'console.log(JSON.stringify({ resolved, size: followed.size }));',
    ].join('\n');

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', hookPath, '--input-type=module', '-e', script], {
        env: {
          ...process.env,
          SYMLINK_RACE_PATH: raceLink,
          SYMLINK_RACE_TARGET: raceFile,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`hook probe exited ${code}: ${stderr}`));
        }
      });
    });

    const probed = JSON.parse(output) as { resolved: string; size: number };
    expect(probed.resolved).toBe(insideFile);
    expect(probed.size).toBe(RACE_SIZE);
    expect(await fs.readlink(raceLink)).toBe(raceFile);
  });

  it('does not disclose that metadata from list_directory, directory_tree, or search_files', async () => {
    const { allowed, outside } = await makeRoot();
    const outsideFile = path.join(outside, 'credential-file');
    const mtime = new Date('2001-02-03T04:05:06.000Z');
    await writeOutsideFile(outsideFile, DIRECT_SIZE, mtime);
    const link = path.join(allowed, 'convenient-link');
    await fs.symlink(outsideFile, link);

    await withServer(allowed, undefined, async (client) => {
      const listed = (await client.callTool({
        name: 'list_directory',
        arguments: { path: allowed },
      })) as ToolResult;
      const tree = (await client.callTool({
        name: 'directory_tree',
        arguments: { path: allowed },
      })) as ToolResult;
      const search = (await client.callTool({
        name: 'search_files',
        arguments: { path: allowed, pattern: '**/*' },
      })) as ToolResult;

      for (const result of [listed, tree, search]) {
        expect(result.isError, resultText(result)).not.toBe(true);
        expectNoTargetMetadata(resultText(result), DIRECT_SIZE, mtime);
        expect(resultText(result)).not.toContain(outsideFile);
      }
    });
  });
});
