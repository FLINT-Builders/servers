import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Spec for the directory_tree and search_files walkers.
 *
 * Both tools take a caller-supplied path inside an allowed directory and walk
 * every nested child with no limit. These tests require:
 *
 * - At most 5000 entries below the requested path. The requested path itself
 *   does not count. Entry 5001 fails the call before that entry is returned.
 * - At most 20 nested directories. The requested path is depth 0. A directory
 *   nested 20 levels below it may be listed. A directory nested 21 levels
 *   below it must not be listed, and the call must fail before that listing.
 * - Directories named node_modules, .git, or dist are skipped wherever they
 *   appear below the requested path, including when excludePatterns is omitted,
 *   empty, or set to an unrelated pattern. Skipping means the directory is not
 *   listed: its atime stays stale. realpath and stat do not refresh a stale
 *   directory atime on this filesystem; readdir does. The requested path is
 *   still walked when its own basename is one of those names, and the entry
 *   cap still applies to that walk.
 * - search_files counts entries it visits, not only paths the glob matches, and
 *   a cap failure is reported on the tool result.
 *
 * list_directory and list_directory_with_sizes read a single directory and are
 * not part of this spec.
 */

const MAX_ENTRIES = 5000;
const MAX_DEPTH = 20;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

function entryCap(tool: 'directory_tree' | 'search_files'): string {
  return `${tool} exceeds maximum of ${MAX_ENTRIES} entries`;
}

function depthCap(tool: 'directory_tree' | 'search_files'): string {
  return `${tool} exceeds maximum depth of ${MAX_DEPTH}`;
}

type ToolResult = {
  isError?: boolean;
  content?: Array<{ text?: string }>;
};

function textOf(result: ToolResult): string {
  return (result.content ?? []).map((block) => block.text ?? '').join('\n');
}

async function makeWorkspace(prefix: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(tmp);
}

async function writeFiles(dir: string, count: number, prefix: string): Promise<void> {
  const batchSize = 256;
  for (let start = 0; start < count; start += batchSize) {
    const countInBatch = Math.min(batchSize, count - start);
    await Promise.all(
      Array.from({ length: countInBatch }, (_, offset) => {
        const index = start + offset;
        const name = `${prefix}-${String(index).padStart(5, '0')}.txt`;
        return fs.writeFile(path.join(dir, name), 'x');
      }),
    );
  }
}

async function nestDirectories(root: string, levels: number, leafName: string): Promise<string> {
  let current = root;
  for (let level = 1; level <= levels; level += 1) {
    current = path.join(current, 'd');
    await fs.mkdir(current);
  }
  await fs.writeFile(path.join(current, leafName), 'x');
  return current;
}

async function markUnread(dir: string): Promise<void> {
  const stale = new Date(Date.now() - THREE_DAYS_MS);
  await fs.utimes(dir, stale, stale);
}

async function expectDirectoryWasNotListed(dir: string): Promise<void> {
  const atimeMs = (await fs.stat(dir)).atimeMs;
  expect(Date.now() - atimeMs).toBeGreaterThan(TWO_DAYS_MS);
}

async function createHeavyTree(root: string): Promise<string[]> {
  await fs.writeFile(path.join(root, 'keep.txt'), 'keep');
  await fs.writeFile(path.join(root, 'notes.md'), 'notes');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'ok.txt'), 'ok');

  const heavy = [
    path.join(root, 'node_modules'),
    path.join(root, '.git'),
    path.join(root, 'dist'),
    path.join(root, 'src', 'node_modules'),
  ];
  await fs.mkdir(heavy[0]);
  await fs.writeFile(path.join(heavy[0], 'pkg.js'), 'pkg');
  await fs.mkdir(heavy[1]);
  await fs.writeFile(path.join(heavy[1], 'config'), 'git');
  await fs.mkdir(heavy[2]);
  await fs.writeFile(path.join(heavy[2], 'bundle.js'), 'bundle');
  await fs.mkdir(heavy[3]);
  await fs.writeFile(path.join(heavy[3], 'deep.js'), 'deep');

  for (const dir of heavy) {
    await markUnread(dir);
  }
  return heavy;
}

describe('unbounded recursive filesystem walks', () => {
  const workspaces: string[] = [];
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await Promise.all(workspaces.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function useWorkspace(prefix: string): Promise<{ root: string; client: Client }> {
    const root = await makeWorkspace(prefix);
    workspaces.push(root);
    const serverPath = path.resolve(__dirname, '../dist/index.js');
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, root],
    });
    client = new Client(
      { name: 'unbounded-walk-test', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return { root, client };
  }

  describe('directory_tree', () => {
    it('returns every entry when the flat listing is within 5000', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-tree-ok-');
      await writeFiles(root, MAX_ENTRIES, 'e');

      const result = await server.callTool({
        name: 'directory_tree',
        arguments: { path: root },
      }) as ToolResult;

      expect(result.isError).not.toBe(true);
      const names = (JSON.parse(textOf(result)) as Array<{ name: string }>).map((entry) => entry.name);
      expect(names).toHaveLength(MAX_ENTRIES);
      expect(names).toContain('e-00000.txt');
      expect(names).toContain('e-04999.txt');
    }, 60_000);

    it('fails before returning a flat listing larger than 5000 entries', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-tree-over-');
      await writeFiles(root, MAX_ENTRIES + 1, 'e');

      const result = await server.callTool({
        name: 'directory_tree',
        arguments: { path: root },
      }) as ToolResult;
      const text = textOf(result);

      expect(result.isError).toBe(true);
      expect(text).toContain(entryCap('directory_tree'));
      expect(text).not.toContain('e-05000.txt');
      expect(text).not.toContain('"type": "file"');
      expect(text.length).toBeLessThan(500);
    }, 60_000);

    it('enforces the entry cap when the requested path is node_modules', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-tree-nm-');
      const nodeModules = path.join(root, 'node_modules');
      await fs.mkdir(nodeModules);
      await writeFiles(nodeModules, MAX_ENTRIES + 1, 'e');

      const result = await server.callTool({
        name: 'directory_tree',
        arguments: { path: nodeModules },
      }) as ToolResult;
      const text = textOf(result);

      expect(result.isError).toBe(true);
      expect(text).toContain(entryCap('directory_tree'));
      expect(text).not.toContain('e-05000.txt');
      expect(text.length).toBeLessThan(500);
    }, 60_000);

    it('returns a chain 20 directories deep', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-tree-depth-ok-');
      await nestDirectories(root, MAX_DEPTH, 'leaf.txt');

      const result = await server.callTool({
        name: 'directory_tree',
        arguments: { path: root },
      }) as ToolResult;

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('leaf.txt');
    }, 60_000);

    it('fails before reading a directory nested deeper than 20', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-tree-depth-over-');
      const deepest = await nestDirectories(root, MAX_DEPTH + 1, 'hidden.txt');
      await markUnread(deepest);

      const result = await server.callTool({
        name: 'directory_tree',
        arguments: { path: root },
      }) as ToolResult;
      const text = textOf(result);

      expect(result.isError).toBe(true);
      expect(text).toContain(depthCap('directory_tree'));
      expect(text).not.toContain('hidden.txt');
      expect(text).not.toMatch(/EACCES|permission denied/);
      await expectDirectoryWasNotListed(deepest);
    }, 60_000);

    it('does not open node_modules, .git, or dist by default', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-tree-heavy-');
      const heavy = await createHeavyTree(root);

      const result = await server.callTool({
        name: 'directory_tree',
        arguments: { path: root },
      }) as ToolResult;
      const text = textOf(result);

      expect(result.isError).not.toBe(true);
      const names = JSON.parse(text) as Array<{ name: string; children?: Array<{ name: string }> }>;
      const topLevel = names.map((entry) => entry.name);
      expect(topLevel).toContain('keep.txt');
      expect(topLevel).toContain('src');
      expect(topLevel).not.toContain('node_modules');
      expect(topLevel).not.toContain('.git');
      expect(topLevel).not.toContain('dist');
      const src = names.find((entry) => entry.name === 'src');
      expect(src?.children?.map((child) => child.name)).toEqual(['ok.txt']);
      expect(text).not.toContain('pkg.js');
      expect(text).not.toContain('deep.js');
      for (const dir of heavy) {
        await expectDirectoryWasNotListed(dir);
      }
    }, 60_000);

    it('still skips heavy directories when excludePatterns is set', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-tree-exclude-');
      const heavy = await createHeavyTree(root);

      const result = await server.callTool({
        name: 'directory_tree',
        arguments: { path: root, excludePatterns: ['*.md'] },
      }) as ToolResult;
      const text = textOf(result);

      expect(result.isError).not.toBe(true);
      expect(text).toContain('keep.txt');
      expect(text).not.toContain('notes.md');
      expect(text).not.toContain('node_modules');
      expect(text).not.toContain('.git');
      expect(text).not.toContain('dist');
      expect(text).not.toContain('pkg.js');
      for (const dir of heavy) {
        await expectDirectoryWasNotListed(dir);
      }
    }, 60_000);
  });

  describe('search_files', () => {
    it('returns every match when the walk stays within 5000 entries', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-search-ok-');
      await writeFiles(root, MAX_ENTRIES, 'e');

      const result = await server.callTool({
        name: 'search_files',
        arguments: { path: root, pattern: '*.txt' },
      }) as ToolResult;
      const lines = textOf(result).split('\n').filter((line) => line.length > 0);

      expect(result.isError).not.toBe(true);
      expect(lines).toHaveLength(MAX_ENTRIES);
      expect(lines.some((line) => line.endsWith(`${path.sep}e-00000.txt`))).toBe(true);
      expect(lines.some((line) => line.endsWith(`${path.sep}e-04999.txt`))).toBe(true);
    }, 60_000);

    it('fails before finishing a walk of more than 5000 entries for a narrow glob', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-search-over-');
      await writeFiles(root, MAX_ENTRIES + 1, 'e');

      const result = await server.callTool({
        name: 'search_files',
        arguments: { path: root, pattern: 'only-this-name.txt' },
      }) as ToolResult;
      const text = textOf(result);

      expect(result.isError).toBe(true);
      expect(text).toContain(entryCap('search_files'));
      expect(text).not.toContain('No matches found');
      expect(text).not.toContain('e-00000.txt');
      expect(text.length).toBeLessThan(500);
    }, 60_000);

    it('enforces the entry cap when the requested path is node_modules', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-search-nm-');
      const nodeModules = path.join(root, 'node_modules');
      await fs.mkdir(nodeModules);
      await writeFiles(nodeModules, MAX_ENTRIES + 1, 'e');

      const result = await server.callTool({
        name: 'search_files',
        arguments: { path: nodeModules, pattern: '*.txt' },
      }) as ToolResult;
      const text = textOf(result);

      expect(result.isError).toBe(true);
      expect(text).toContain(entryCap('search_files'));
      expect(text).not.toContain('e-05000.txt');
      expect(text.length).toBeLessThan(500);
    }, 60_000);

    it('returns a file nested 20 directories down', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-search-depth-ok-');
      await nestDirectories(root, MAX_DEPTH, 'leaf.txt');

      const result = await server.callTool({
        name: 'search_files',
        arguments: { path: root, pattern: '**/leaf.txt' },
      }) as ToolResult;
      const text = textOf(result);

      expect(result.isError).not.toBe(true);
      const match = text.split('\n').find((line) => line.endsWith(`${path.sep}leaf.txt`));
      expect(match).toBeDefined();
      expect(path.relative(root, match as string).split(path.sep)).toHaveLength(MAX_DEPTH + 1);
    }, 60_000);

    it('fails before reading a directory nested deeper than 20', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-search-depth-over-');
      await fs.writeFile(path.join(root, 'marker.txt'), 'marker');
      const deepest = await nestDirectories(root, MAX_DEPTH + 1, 'hidden.txt');
      await markUnread(deepest);

      const result = await server.callTool({
        name: 'search_files',
        arguments: { path: root, pattern: 'marker.txt' },
      }) as ToolResult;
      const text = textOf(result);

      expect(result.isError).toBe(true);
      expect(text).toContain(depthCap('search_files'));
      expect(text).not.toContain('marker.txt');
      expect(text).not.toContain('hidden.txt');
      expect(text).not.toMatch(/EACCES|permission denied/);
      await expectDirectoryWasNotListed(deepest);
    }, 60_000);

    it('does not open node_modules, .git, or dist for a single filename', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-search-heavy-');
      const heavy = await createHeavyTree(root);

      const result = await server.callTool({
        name: 'search_files',
        arguments: { path: root, pattern: 'keep.txt' },
      }) as ToolResult;
      const text = textOf(result);

      expect(result.isError).not.toBe(true);
      expect(text.trim()).toBe(path.join(root, 'keep.txt'));
      expect(text).not.toContain('node_modules');
      expect(text).not.toContain(`${path.sep}.git`);
      expect(text).not.toContain(`${path.sep}dist${path.sep}`);
      for (const dir of heavy) {
        await expectDirectoryWasNotListed(dir);
      }
    }, 60_000);

    it('still skips heavy directories when excludePatterns is set', async () => {
      const { root, client: server } = await useWorkspace('mcp-fs-search-exclude-');
      const heavy = await createHeavyTree(root);

      const result = await server.callTool({
        name: 'search_files',
        arguments: { path: root, pattern: '**/*', excludePatterns: ['*.md'] },
      }) as ToolResult;
      const text = textOf(result);

      expect(result.isError).not.toBe(true);
      expect(text).toContain(path.join(root, 'keep.txt'));
      expect(text).toContain(path.join(root, 'src', 'ok.txt'));
      expect(text).not.toContain('notes.md');
      expect(text).not.toContain('node_modules');
      expect(text).not.toContain(`${path.sep}.git`);
      expect(text).not.toContain(`${path.sep}dist${path.sep}`);
      expect(text).not.toContain('pkg.js');
      expect(text).not.toContain('deep.js');
      for (const dir of heavy) {
        await expectDirectoryWasNotListed(dir);
      }
    }, 60_000);
  });
});
