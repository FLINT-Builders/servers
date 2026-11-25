import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { pathToFileURL, fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * Command-line directories are a hard ceiling. A client root is accepted only
 * when it is the same directory or a directory inside that ceiling. Roots that
 * fall outside, including roots/list_changed updates, must be ignored.
 *
 * These tests spawn the built server and speak MCP through the SDK, the same
 * initialization and roots/list_changed path a desktop client uses. They fail
 * while the server replaces the command-line allowlist with the client roots.
 *
 * read_text_file head/tail are the same handler and the same validatePath as
 * read_text_file; they are not separate allowlist checks. This server exposes
 * no resources or prompts.
 */

const SERVER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

const INSIDE_MARKER = 'INSIDE_FILE_MARKER';
const OUTSIDE_MARKER = 'OUTSIDE_FILE_MARKER';
const SIBLING_MARKER = 'PREFIX_SIBLING_MARKER';
const LINK_TARGET_MARKER = 'LINK_TARGET_MARKER';
const SUBDIR_MARKER = 'SUBDIR_FILE_MARKER';

const ROOTS_SETTLED_LOGS = [
  'Updated allowed directories from MCP roots',
  'No valid root directories provided by client',
];

type RootEntry = { uri: string; name?: string };

type ToolContent = {
  type: string;
  text?: string;
  data?: string;
  resource?: { blob?: string; uri?: string };
};

type ToolResult = {
  isError?: boolean;
  content?: ToolContent[];
};

function fileUri(directory: string): string {
  return pathToFileURL(directory).href;
}

function resultText(result: ToolResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (typeof item.text === 'string') {
      parts.push(item.text);
    }
    if (typeof item.data === 'string') {
      parts.push(Buffer.from(item.data, 'base64').toString('utf8'));
    }
    if (typeof item.resource?.blob === 'string') {
      parts.push(Buffer.from(item.resource.blob, 'base64').toString('utf8'));
    }
  }
  return parts.join('\n');
}

async function waitForRootsSettlement(getStderr: () => string, from: number): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const chunk = getStderr().slice(from);
    if (ROOTS_SETTLED_LOGS.some((line) => chunk.includes(line))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for the server to finish applying roots.\n${getStderr()}`);
}

function allowedDirectoriesFrom(result: ToolResult): string[] {
  const text = resultText(result);
  const lines = text.split('\n');
  expect(lines[0]).toBe('Allowed directories:');
  return lines.slice(1).filter((line) => line.length > 0);
}

async function expectWithinCeiling(directories: string[], ceiling: string): Promise<void> {
  expect(directories.length).toBeGreaterThan(0);
  for (const directory of directories) {
    const real = await fs.realpath(directory);
    const inside = real === ceiling || real.startsWith(ceiling + path.sep);
    expect(inside, `${real} is outside the command-line directory ${ceiling}`).toBe(true);
  }
}

async function expectBytes(filePath: string, contents: string): Promise<void> {
  await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(contents);
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
}

class FilesystemSession {
  readonly client: Client;
  private readonly transport: StdioClientTransport;
  private stderr = '';
  rootsListCalls = 0;

  private constructor(client: Client, transport: StdioClientTransport) {
    this.client = client;
    this.transport = transport;
  }

  static async open(commandArgs: string[], roots: () => RootEntry[]): Promise<FilesystemSession> {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER_PATH, ...commandArgs],
      stderr: 'pipe',
    });
    const session = new FilesystemSession(
      new Client(
        { name: 'roots-allowlist-ceiling', version: '1.0.0' },
        { capabilities: { roots: { listChanged: true } } },
      ),
      transport,
    );
    transport.stderr?.on('data', (chunk: Buffer) => {
      session.stderr += chunk.toString();
    });
    session.client.setRequestHandler(ListRootsRequestSchema, async () => {
      session.rootsListCalls += 1;
      return { roots: roots() };
    });
    const stderrBeforeConnect = session.stderr.length;
    await session.client.connect(transport);
    await waitForRootsSettlement(() => session.stderr, stderrBeforeConnect);
    expect(session.rootsListCalls).toBeGreaterThan(0);
    return session;
  }

  async notifyRootsChanged(mutate: () => void): Promise<void> {
    const from = this.stderr.length;
    const callsBefore = this.rootsListCalls;
    mutate();
    await this.client.sendRootsListChanged();
    await waitForRootsSettlement(() => this.stderr, from);
    expect(this.rootsListCalls).toBeGreaterThan(callsBefore);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return await this.client.callTool({ name, arguments: args }) as ToolResult;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

describe('command-line directories are a ceiling on client roots', () => {
  let workspace: string;
  let project: string;
  let sibling: string;
  let outsideFile: string;
  let insideFile: string;
  let subdirFile: string;
  let linkTargetFile: string;
  let linkRoot: string;
  let moveOutsideSource: string;
  let moveInsideSource: string;
  let editOutsideFile: string;

  beforeAll(async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-roots-')));
    workspace = path.join(root, 'workspace');
    project = path.join(workspace, 'project');
    sibling = path.join(workspace, 'project-extra');
    const subdir = path.join(project, 'nested');
    const linkTarget = path.join(workspace, 'link-target');
    linkRoot = path.join(project, 'linked-root');

    await fs.mkdir(subdir, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    await fs.mkdir(linkTarget, { recursive: true });

    outsideFile = path.join(workspace, 'outside.txt');
    insideFile = path.join(project, 'ok.txt');
    subdirFile = path.join(subdir, 'inside.txt');
    linkTargetFile = path.join(linkTarget, 'secret.txt');
    moveOutsideSource = path.join(workspace, 'move-outside.txt');
    moveInsideSource = path.join(project, 'move-inside.txt');
    editOutsideFile = path.join(workspace, 'edit-outside.txt');

    await fs.writeFile(outsideFile, OUTSIDE_MARKER);
    await fs.writeFile(insideFile, INSIDE_MARKER);
    await fs.writeFile(subdirFile, SUBDIR_MARKER);
    await fs.writeFile(path.join(sibling, 'extra.txt'), SIBLING_MARKER);
    await fs.writeFile(linkTargetFile, LINK_TARGET_MARKER);
    await fs.writeFile(moveOutsideSource, 'MOVE_OUTSIDE_SOURCE');
    await fs.writeFile(moveInsideSource, 'MOVE_INSIDE_SOURCE');
    await fs.writeFile(editOutsideFile, OUTSIDE_MARKER);
    await fs.symlink(linkTarget, linkRoot, 'dir');
  }, 20000);

  afterAll(async () => {
    if (workspace) {
      await fs.rm(path.dirname(workspace), { recursive: true, force: true });
    }
  });

  describe('initialization replaces nothing outside the command-line directory', () => {
    let session: FilesystemSession;

    beforeAll(async () => {
      session = await FilesystemSession.open([project], () => [
        { uri: fileUri(workspace), name: 'workspace' },
      ]);
    }, 20000);

    afterAll(async () => {
      await session?.close();
    });

    it('keeps the command-line directory as the allowlist', async () => {
      const listed = await session.call('list_allowed_directories', {});
      expect(listed.isError).not.toBe(true);
      await expectWithinCeiling(allowedDirectoriesFrom(listed), project);
    });

    it('still reads a file inside the command-line directory', async () => {
      const result = await session.call('read_text_file', { path: insideFile });
      expect(result.isError).not.toBe(true);
      expect(resultText(result)).toBe(INSIDE_MARKER);
    });

    it('refuses read_text_file outside the command-line directory', async () => {
      const result = await session.call('read_text_file', { path: outsideFile });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      expect(resultText(result)).not.toContain(OUTSIDE_MARKER);
      await expectBytes(outsideFile, OUTSIDE_MARKER);
    });

    it('refuses the deprecated read_file alias outside the command-line directory', async () => {
      const result = await session.call('read_file', { path: outsideFile });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      expect(resultText(result)).not.toContain(OUTSIDE_MARKER);
    });

    it('refuses read_media_file outside the command-line directory', async () => {
      const result = await session.call('read_media_file', { path: outsideFile });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      expect(resultText(result)).not.toContain(OUTSIDE_MARKER);
    });

    it('returns an access error for the outside path from read_multiple_files', async () => {
      const result = await session.call('read_multiple_files', { paths: [insideFile, outsideFile] });
      const text = resultText(result);
      expect(text).toContain(`${insideFile}:\n${INSIDE_MARKER}`);
      expect(text).toContain(`${outsideFile}: Error -`);
      expect(text).toContain('Access denied');
      expect(text).not.toContain(OUTSIDE_MARKER);
    });

    it('refuses get_file_info outside the command-line directory', async () => {
      const result = await session.call('get_file_info', { path: outsideFile });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      expect(resultText(result)).not.toContain(OUTSIDE_MARKER);
    });

    it('refuses list_directory outside the command-line directory', async () => {
      const result = await session.call('list_directory', { path: workspace });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      expect(resultText(result)).not.toContain('outside.txt');
    });

    it('refuses list_directory_with_sizes outside the command-line directory', async () => {
      const result = await session.call('list_directory_with_sizes', { path: workspace });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      expect(resultText(result)).not.toContain('outside.txt');
    });

    it('refuses directory_tree outside the command-line directory', async () => {
      const result = await session.call('directory_tree', { path: workspace });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      expect(resultText(result)).not.toContain('outside.txt');
    });

    it('refuses search_files outside the command-line directory', async () => {
      const result = await session.call('search_files', { path: workspace, pattern: '**/*' });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      expect(resultText(result)).not.toContain(outsideFile);
    });

    it('does not create a file when write_file targets a path outside the command-line directory', async () => {
      const created = path.join(workspace, 'written-outside.txt');
      const before = (await fs.readdir(workspace)).sort();
      const result = await session.call('write_file', { path: created, content: 'WRITTEN_OUTSIDE' });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      expect((await fs.readdir(workspace)).sort()).toEqual(before);
      await expectMissing(created);
    });

    it('does not modify a file when edit_file targets a path outside the command-line directory', async () => {
      const before = (await fs.readdir(workspace)).sort();
      const preview = await session.call('edit_file', {
        path: editOutsideFile,
        edits: [{ oldText: OUTSIDE_MARKER, newText: 'CHANGED' }],
        dryRun: true,
      });
      expect(preview.isError).toBe(true);
      expect(resultText(preview)).toContain('Access denied');
      expect(resultText(preview)).not.toContain(OUTSIDE_MARKER);
      const applied = await session.call('edit_file', {
        path: editOutsideFile,
        edits: [{ oldText: OUTSIDE_MARKER, newText: 'CHANGED' }],
        dryRun: false,
      });
      expect(applied.isError).toBe(true);
      expect(resultText(applied)).toContain('Access denied');
      expect(resultText(applied)).not.toContain(OUTSIDE_MARKER);
      await expectBytes(editOutsideFile, OUTSIDE_MARKER);
      expect((await fs.readdir(workspace)).sort()).toEqual(before);
    });

    it('does not create a directory outside the command-line directory', async () => {
      const created = path.join(workspace, 'created-outside');
      const before = (await fs.readdir(workspace)).sort();
      const result = await session.call('create_directory', { path: created });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      expect((await fs.readdir(workspace)).sort()).toEqual(before);
      await expectMissing(created);
    });

    it('does not move a file out of the command-line directory', async () => {
      const destination = path.join(workspace, 'moved-from-project.txt');
      const result = await session.call('move_file', { source: moveInsideSource, destination });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      await expectBytes(moveInsideSource, 'MOVE_INSIDE_SOURCE');
      await expectMissing(destination);
    });

    it('does not move a file from outside into the command-line directory', async () => {
      const destination = path.join(project, 'moved-from-workspace.txt');
      const result = await session.call('move_file', { source: moveOutsideSource, destination });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('Access denied');
      await expectBytes(moveOutsideSource, 'MOVE_OUTSIDE_SOURCE');
      await expectMissing(destination);
    });
  });

  describe('roots/list_changed cannot widen the command-line directory', () => {
    let session: FilesystemSession;
    let roots: RootEntry[];

    beforeAll(async () => {
      roots = [{ uri: fileUri(project), name: 'project' }];
      session = await FilesystemSession.open([project], () => roots);
    }, 20000);

    afterAll(async () => {
      await session?.close();
    });

    it('ignores a later workspace root and still refuses read and write outside', async () => {
      const inside = await session.call('read_text_file', { path: insideFile });
      expect(inside.isError).not.toBe(true);
      expect(resultText(inside)).toBe(INSIDE_MARKER);

      const written = path.join(workspace, 'changed-root-write.txt');
      await session.notifyRootsChanged(() => {
        roots = [{ uri: fileUri(workspace), name: 'workspace' }];
      });

      const listed = await session.call('list_allowed_directories', {});
      await expectWithinCeiling(allowedDirectoriesFrom(listed), project);

      const read = await session.call('read_text_file', { path: outsideFile });
      expect(read.isError).toBe(true);
      expect(resultText(read)).toContain('Access denied');
      expect(resultText(read)).not.toContain(OUTSIDE_MARKER);

      const before = (await fs.readdir(workspace)).sort();
      const write = await session.call('write_file', { path: written, content: 'CHANGED_ROOT_WRITE' });
      expect(write.isError).toBe(true);
      expect(resultText(write)).toContain('Access denied');
      expect((await fs.readdir(workspace)).sort()).toEqual(before);
      await expectMissing(written);

      const stillInside = await session.call('read_text_file', { path: insideFile });
      expect(stillInside.isError).not.toBe(true);
      expect(resultText(stillInside)).toBe(INSIDE_MARKER);
    });
  });

  describe('a client root is canonicalized before it is compared to the ceiling', () => {
    it('rejects a root symlink whose target is outside the command-line directory', async () => {
      const session = await FilesystemSession.open([project], () => [
        { uri: fileUri(linkRoot), name: 'linked-root' },
      ]);
      try {
        const listed = await session.call('list_allowed_directories', {});
        await expectWithinCeiling(allowedDirectoriesFrom(listed), project);

        const inside = await session.call('read_text_file', { path: insideFile });
        expect(inside.isError).not.toBe(true);
        expect(resultText(inside)).toBe(INSIDE_MARKER);

        const viaRealPath = await session.call('read_text_file', { path: linkTargetFile });
        expect(viaRealPath.isError).toBe(true);
        expect(resultText(viaRealPath)).toContain('Access denied');
        expect(resultText(viaRealPath)).not.toContain(LINK_TARGET_MARKER);

        const viaLink = await session.call('read_text_file', { path: path.join(linkRoot, 'secret.txt') });
        expect(viaLink.isError).toBe(true);
        expect(resultText(viaLink)).toContain('Access denied');
        expect(resultText(viaLink)).not.toContain(LINK_TARGET_MARKER);
        await expectBytes(linkTargetFile, LINK_TARGET_MARKER);
      } finally {
        await session.close();
      }
    }, 20000);

    it('rejects a sibling directory whose name only shares a prefix with the command-line directory', async () => {
      const siblingFile = path.join(sibling, 'extra.txt');
      const session = await FilesystemSession.open([project], () => [
        { uri: fileUri(sibling), name: 'project-extra' },
      ]);
      try {
        const listed = await session.call('list_allowed_directories', {});
        await expectWithinCeiling(allowedDirectoriesFrom(listed), project);

        const inside = await session.call('read_text_file', { path: insideFile });
        expect(inside.isError).not.toBe(true);
        expect(resultText(inside)).toBe(INSIDE_MARKER);

        const read = await session.call('read_text_file', { path: siblingFile });
        expect(read.isError).toBe(true);
        expect(resultText(read)).toContain('Access denied');
        expect(resultText(read)).not.toContain(SIBLING_MARKER);

        const written = path.join(sibling, 'written.txt');
        const before = (await fs.readdir(sibling)).sort();
        const write = await session.call('write_file', { path: written, content: 'SIBLING_WRITE' });
        expect(write.isError).toBe(true);
        expect(resultText(write)).toContain('Access denied');
        expect((await fs.readdir(sibling)).sort()).toEqual(before);
        await expectMissing(written);
      } finally {
        await session.close();
      }
    }, 20000);

    it('keeps access to a directory the client names inside the command-line directory', async () => {
      const session = await FilesystemSession.open([project], () => [
        { uri: fileUri(path.dirname(subdirFile)), name: 'nested' },
      ]);
      try {
        const result = await session.call('read_text_file', { path: subdirFile });
        expect(result.isError).not.toBe(true);
        expect(resultText(result)).toBe(SUBDIR_MARKER);

        const outside = await session.call('read_text_file', { path: outsideFile });
        expect(outside.isError).toBe(true);
        expect(resultText(outside)).not.toContain(OUTSIDE_MARKER);
      } finally {
        await session.close();
      }
    }, 20000);
  });

  describe('with no command-line directory, client roots still grant access', () => {
    it('reads a file in the root the client returned', async () => {
      const session = await FilesystemSession.open([], () => [
        { uri: fileUri(workspace), name: 'workspace' },
      ]);
      try {
        const result = await session.call('read_text_file', { path: outsideFile });
        expect(result.isError).not.toBe(true);
        expect(resultText(result)).toBe(OUTSIDE_MARKER);
      } finally {
        await session.close();
      }
    }, 20000);
  });
});
