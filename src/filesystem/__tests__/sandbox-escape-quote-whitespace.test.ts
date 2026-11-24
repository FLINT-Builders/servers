import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  applyFileEdits,
  getAllowedDirectories,
  getFileStats,
  headFile,
  moveFile,
  readFileContent,
  searchFilesWithValidation,
  setAllowedDirectories,
  tailFile,
  validatePath,
  writeFileContent,
} from '../lib.js';

/**
 * Spec for the sandbox check in validatePath.
 *
 * The containment decision must apply to the same path string the filesystem
 * operation uses. A trailing quote or whitespace character that normalizePath
 * strips only for the check must not let a tool create, overwrite, read, list,
 * or move a sibling of an allowed directory.
 *
 * These tests fail while that split is present: the operation completes on the
 * sibling. They pass when the operation is refused and the sibling is untouched.
 * A refusal that still creates, deletes, or rewrites the sibling is a failure.
 * Resolving the path a second time with the same quote/whitespace stripping
 * between the check and the operation is a failure too.
 */

const SECRET = 'OUTSIDE_SECRET_CONTENT';
const INSIDE = 'INSIDE_CONTENT';

const SUFFIXES: ReadonlyArray<{ label: string; suffix: string }> = [
  { label: 'trailing single quote', suffix: "'" },
  { label: 'trailing double quote', suffix: '"' },
  { label: 'trailing space', suffix: ' ' },
  { label: 'trailing tab', suffix: '\t' },
  { label: 'trailing newline', suffix: '\n' },
  { label: 'trailing single quote then space', suffix: "' " },
];

interface CallToolResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string; data?: string; resource?: { blob?: string } }>;
  structuredContent?: unknown;
}

function siblingOf(allowedDir: string, suffix: string): string {
  return allowedDir + suffix;
}

function dotDotSibling(allowedDir: string, suffix: string): string {
  return `${allowedDir}/../${path.basename(allowedDir)}${suffix}`;
}

function assertAccessDenied(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  expect(message).toMatch(/Access denied/);
}

async function namesOf(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).sort();
}

async function readBase64Stream(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => {
      chunks.push(chunk as Buffer);
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('base64'));
    });
    stream.on('error', (err) => reject(err));
  });
}

describe.sequential('quote and whitespace stripping before the sandbox check', () => {
  let parentDir: string;
  let allowedDir: string;

  beforeEach(async () => {
    parentDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-sandbox-escape-')));
    allowedDir = path.join(parentDir, 'project');
    await fs.mkdir(allowedDir);
    setAllowedDirectories([allowedDir]);
  });

  afterEach(async () => {
    setAllowedDirectories([]);
    await fs.rm(parentDir, { recursive: true, force: true });
  });

  describe('paths that stay inside the allowed directory', () => {
    it('writes and reads a normal file', async () => {
      const requested = path.join(allowedDir, 'notes.txt');
      const validPath = await validatePath(requested);
      await writeFileContent(validPath, INSIDE);
      expect(await readFileContent(await validatePath(requested))).toBe(INSIDE);
      expect(path.resolve(validPath).startsWith(allowedDir + path.sep)).toBe(true);
    });

    it('allows a path whose .. segments still resolve inside the allowed directory', async () => {
      const requested = `${allowedDir}/nested/../ok.txt`;
      const validPath = await validatePath(requested);
      await writeFileContent(validPath, INSIDE);
      expect(await fs.readFile(path.join(allowedDir, 'ok.txt'), 'utf8')).toBe(INSIDE);
    });

    it('rejects an ordinary sibling that does not collapse to the allowed directory', async () => {
      await expect(validatePath(`${allowedDir}-other`)).rejects.toThrow(/Access denied/);
      await expect(fs.lstat(`${allowedDir}-other`)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('write_file', () => {
    it.each(SUFFIXES)(
      'does not create a sibling via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        const before = await namesOf(parentDir);
        try {
          const validPath = await validatePath(target);
          await writeFileContent(validPath, SECRET);
          expect.fail(`write_file created ${validPath}`);
        } catch (error) {
          assertAccessDenied(error);
        }
        expect(await namesOf(parentDir)).toEqual(before);
        await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );

    it.each(SUFFIXES)(
      'does not overwrite an existing sibling via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        await fs.writeFile(target, 'ORIGINAL');
        const before = await namesOf(parentDir);
        try {
          const validPath = await validatePath(target);
          await writeFileContent(validPath, SECRET);
          expect.fail(`write_file overwrote ${validPath}`);
        } catch (error) {
          assertAccessDenied(error);
        }
        expect(await namesOf(parentDir)).toEqual(before);
        expect(await fs.readFile(target, 'utf8')).toBe('ORIGINAL');
      },
    );

    it('does not create a sibling addressed with a .. segment and a trailing quote', async () => {
      const requested = dotDotSibling(allowedDir, "'");
      const target = siblingOf(allowedDir, "'");
      const before = await namesOf(parentDir);
      try {
        const validPath = await validatePath(requested);
        await writeFileContent(validPath, SECRET);
        expect.fail(`write_file created ${validPath}`);
      } catch (error) {
        assertAccessDenied(error);
      }
      expect(await namesOf(parentDir)).toEqual(before);
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('create_directory', () => {
    it.each(SUFFIXES)(
      'does not create a sibling directory via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        const before = await namesOf(parentDir);
        try {
          const validPath = await validatePath(target);
          await fs.mkdir(validPath, { recursive: true });
          expect.fail(`create_directory created ${validPath}`);
        } catch (error) {
          assertAccessDenied(error);
        }
        expect(await namesOf(parentDir)).toEqual(before);
        await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
  });

  describe('move_file', () => {
    it.each(SUFFIXES)(
      'does not move a sandboxed file onto a sibling via $label',
      async ({ suffix }) => {
        const source = path.join(allowedDir, 'movable.txt');
        await fs.writeFile(source, INSIDE);
        const target = siblingOf(allowedDir, suffix);
        const before = await namesOf(parentDir);
        try {
          const validSourcePath = await validatePath(source);
          const validDestPath = await validatePath(target);
          await moveFile(validSourcePath, validDestPath);
          expect.fail(`move_file moved onto ${validDestPath}`);
        } catch (error) {
          assertAccessDenied(error);
        }
        expect(await namesOf(parentDir)).toEqual(before);
        expect(await fs.readFile(source, 'utf8')).toBe(INSIDE);
        await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
  });

  describe('edit_file', () => {
    it.each(SUFFIXES)(
      'does not modify an existing sibling via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        await fs.writeFile(target, 'ORIGINAL');
        try {
          const validPath = await validatePath(target);
          await applyFileEdits(validPath, [{ oldText: 'ORIGINAL', newText: SECRET }], false);
          expect.fail(`edit_file modified ${validPath}`);
        } catch (error) {
          assertAccessDenied(error);
        }
        expect(await fs.readFile(target, 'utf8')).toBe('ORIGINAL');
      },
    );

    it('does not reveal a sibling during a dry run', async () => {
      const target = siblingOf(allowedDir, "'");
      await fs.writeFile(target, 'ORIGINAL');
      try {
        const validPath = await validatePath(target);
        const diff = await applyFileEdits(validPath, [{ oldText: 'ORIGINAL', newText: SECRET }], true);
        expect.fail(`edit_file dry run returned ${diff}`);
      } catch (error) {
        assertAccessDenied(error);
      }
      expect(await fs.readFile(target, 'utf8')).toBe('ORIGINAL');
    });
  });

  describe('read_text_file and read_file', () => {
    it.each(SUFFIXES)(
      'does not read an existing sibling via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        await fs.writeFile(target, SECRET);
        try {
          const validPath = await validatePath(target);
          const content = await readFileContent(validPath);
          expect.fail(`read returned ${content}`);
        } catch (error) {
          assertAccessDenied(error);
        }
        expect(await fs.readFile(target, 'utf8')).toBe(SECRET);
      },
    );

    it.each(SUFFIXES)(
      'does not head or tail an existing sibling via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        await fs.writeFile(target, `${SECRET}\nsecond\n`);
        try {
          const validPath = await validatePath(target);
          const head = await headFile(validPath, 1);
          const tail = await tailFile(validPath, 1);
          expect.fail(`head/tail returned ${head} ${tail}`);
        } catch (error) {
          assertAccessDenied(error);
        }
      },
    );
  });

  describe('read_media_file', () => {
    it.each(SUFFIXES)(
      'does not stream an existing sibling via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        await fs.writeFile(target, SECRET);
        try {
          const validPath = await validatePath(target);
          const encoded = await readBase64Stream(validPath);
          expect.fail(`read_media_file returned ${encoded}`);
        } catch (error) {
          assertAccessDenied(error);
        }
        expect(await fs.readFile(target, 'utf8')).toBe(SECRET);
      },
    );
  });

  describe('read_multiple_files', () => {
    it.each(SUFFIXES)(
      'returns an access denial instead of sibling contents via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        await fs.writeFile(target, SECRET);
        let text: string;
        try {
          const validPath = await validatePath(target);
          const content = await readFileContent(validPath);
          text = `${target}:\n${content}\n`;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          text = `${target}: Error - ${errorMessage}`;
        }
        expect(text).not.toContain(SECRET);
        expect(text).toMatch(/Access denied/);
        expect(await fs.readFile(target, 'utf8')).toBe(SECRET);
      },
    );
  });

  describe('list_directory and list_directory_with_sizes', () => {
    it.each(SUFFIXES)(
      'does not list a sibling directory via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, 'secret-child.txt'), SECRET);
        try {
          const validPath = await validatePath(target);
          const entries = await fs.readdir(validPath, { withFileTypes: true });
          const formatted = entries
            .map((entry) => `${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${entry.name}`)
            .join('\n');
          const detailed = await Promise.all(entries.map(async (entry) => {
            const stats = await fs.stat(path.join(validPath, entry.name));
            return `${entry.name} ${stats.size}`;
          }));
          expect.fail(`list returned ${formatted} ${detailed.join(',')}`);
        } catch (error) {
          assertAccessDenied(error);
        }
        expect(await fs.readFile(path.join(target, 'secret-child.txt'), 'utf8')).toBe(SECRET);
      },
    );
  });

  describe('directory_tree', () => {
    it.each(SUFFIXES)(
      'does not walk a sibling directory via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, 'secret-child.txt'), SECRET);
        try {
          const validPath = await validatePath(target);
          const entries = await fs.readdir(validPath, { withFileTypes: true });
          expect.fail(`directory_tree listed ${entries.map((entry) => entry.name).join(',')}`);
        } catch (error) {
          assertAccessDenied(error);
        }
      },
    );
  });

  describe('search_files', () => {
    it.each(SUFFIXES)(
      'does not search a sibling directory via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, 'secret-child.txt'), SECRET);
        try {
          const validPath = await validatePath(target);
          const results = await searchFilesWithValidation(
            validPath,
            '**/*',
            getAllowedDirectories(),
          );
          expect.fail(`search_files returned ${results.join(',')}`);
        } catch (error) {
          assertAccessDenied(error);
        }
      },
    );
  });

  describe('get_file_info', () => {
    it.each(SUFFIXES)(
      'does not stat an existing sibling via $label',
      async ({ suffix }) => {
        const target = siblingOf(allowedDir, suffix);
        await fs.writeFile(target, SECRET);
        try {
          const validPath = await validatePath(target);
          const info = await getFileStats(validPath);
          expect.fail(`get_file_info returned size ${info.size} for ${validPath}`);
        } catch (error) {
          assertAccessDenied(error);
        }
        expect(await fs.readFile(target, 'utf8')).toBe(SECRET);
      },
    );
  });
});

describe.sequential('MCP filesystem tools honor the same sandbox boundary', () => {
  let parentDir: string;
  let allowedDir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    const testsDir = path.dirname(fileURLToPath(import.meta.url));
    const packageDir = path.resolve(testsDir, '..');
    const tsc = path.resolve(testsDir, '../../../node_modules/typescript/bin/tsc');
    execFileSync(process.execPath, [tsc, '-p', path.join(packageDir, 'tsconfig.json')], {
      cwd: packageDir,
      stdio: 'inherit',
    });

    parentDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-sandbox-server-')));
    allowedDir = path.join(parentDir, 'project');
    await fs.mkdir(allowedDir);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packageDir, 'dist', 'index.js'), allowedDir],
      stderr: 'pipe',
    });
    client = new Client(
      { name: 'sandbox-escape-test', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    if (parentDir) {
      await fs.rm(parentDir, { recursive: true, force: true });
    }
  });

  function resultText(result: CallToolResult): string {
    return JSON.stringify(result);
  }

  async function expectToolDenied(
    name: string,
    args: Record<string, unknown>,
    options: { absent?: string[]; unchanged?: Array<{ path: string; text: string }> } = {},
  ): Promise<void> {
    const before = await namesOf(parentDir);
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    expect(result.isError, resultText(result)).toBe(true);
    expect(resultText(result)).toMatch(/Access denied/);
    expect(resultText(result)).not.toContain(SECRET);
    expect(await namesOf(parentDir)).toEqual(before);
    for (const absent of options.absent ?? []) {
      await expect(fs.lstat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    for (const file of options.unchanged ?? []) {
      expect(await fs.readFile(file.path, 'utf8')).toBe(file.text);
    }
  }

  it('write_file does not create the quoted sibling', async () => {
    const target = siblingOf(allowedDir, "'");
    await expectToolDenied('write_file', { path: target, content: SECRET }, { absent: [target] });
  });

  it('write_file does not overwrite the quoted sibling', async () => {
    const target = siblingOf(allowedDir, '"');
    await fs.writeFile(target, 'ORIGINAL');
    try {
      await expectToolDenied('write_file', { path: target, content: SECRET }, {
        unchanged: [{ path: target, text: 'ORIGINAL' }],
      });
    } finally {
      await fs.rm(target, { force: true });
    }
  });

  it('write_file does not create a sibling reached through ..', async () => {
    const requested = dotDotSibling(allowedDir, ' ');
    const target = siblingOf(allowedDir, ' ');
    await expectToolDenied('write_file', { path: requested, content: SECRET }, { absent: [target] });
  });

  it('create_directory does not create the quoted sibling', async () => {
    const target = siblingOf(allowedDir, '\t');
    await expectToolDenied('create_directory', { path: target }, { absent: [target] });
  });

  it('move_file does not move a sandboxed file onto the quoted sibling', async () => {
    const source = path.join(allowedDir, 'movable.txt');
    await fs.writeFile(source, INSIDE);
    const target = siblingOf(allowedDir, '\n');
    await expectToolDenied(
      'move_file',
      { source, destination: target },
      { absent: [target] },
    );
    expect(await fs.readFile(source, 'utf8')).toBe(INSIDE);
  });

  it('edit_file does not modify the quoted sibling', async () => {
    const target = siblingOf(allowedDir, "' ");
    await fs.writeFile(target, 'ORIGINAL');
    try {
      await expectToolDenied(
        'edit_file',
        { path: target, edits: [{ oldText: 'ORIGINAL', newText: SECRET }] },
        { unchanged: [{ path: target, text: 'ORIGINAL' }] },
      );
    } finally {
      await fs.rm(target, { force: true });
    }
  });

  it('read_text_file and read_file do not read the quoted sibling', async () => {
    const target = siblingOf(allowedDir, "'");
    await fs.writeFile(target, SECRET);
    try {
      await expectToolDenied('read_text_file', { path: target }, {
        unchanged: [{ path: target, text: SECRET }],
      });
      await expectToolDenied('read_file', { path: target, head: 1 }, {
        unchanged: [{ path: target, text: SECRET }],
      });
      await expectToolDenied('read_text_file', { path: target, tail: 1 }, {
        unchanged: [{ path: target, text: SECRET }],
      });
    } finally {
      await fs.rm(target, { force: true });
    }
  });

  it('read_media_file does not read the quoted sibling', async () => {
    const target = siblingOf(allowedDir, '"');
    await fs.writeFile(target, SECRET);
    try {
      await expectToolDenied('read_media_file', { path: target }, {
        unchanged: [{ path: target, text: SECRET }],
      });
    } finally {
      await fs.rm(target, { force: true });
    }
  });

  it('read_multiple_files does not return the quoted sibling contents', async () => {
    const target = siblingOf(allowedDir, ' ');
    await fs.writeFile(target, SECRET);
    try {
      const result = await client.callTool({
        name: 'read_multiple_files',
        arguments: { paths: [target] },
      }) as CallToolResult;
      const text = resultText(result);
      expect(text).not.toContain(SECRET);
      expect(text).toMatch(/Access denied/);
      expect(await fs.readFile(target, 'utf8')).toBe(SECRET);
    } finally {
      await fs.rm(target, { force: true });
    }
  });

  it('list_directory does not list the quoted sibling', async () => {
    const target = siblingOf(allowedDir, '\t');
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'secret-child.txt'), SECRET);
    try {
      await expectToolDenied('list_directory', { path: target }, {
        unchanged: [{ path: path.join(target, 'secret-child.txt'), text: SECRET }],
      });
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it('list_directory_with_sizes does not list the quoted sibling', async () => {
    const target = siblingOf(allowedDir, '\n');
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'secret-child.txt'), SECRET);
    try {
      await expectToolDenied('list_directory_with_sizes', { path: target }, {
        unchanged: [{ path: path.join(target, 'secret-child.txt'), text: SECRET }],
      });
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it('directory_tree does not walk the quoted sibling', async () => {
    const target = siblingOf(allowedDir, "' ");
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'secret-child.txt'), SECRET);
    try {
      await expectToolDenied('directory_tree', { path: target }, {
        unchanged: [{ path: path.join(target, 'secret-child.txt'), text: SECRET }],
      });
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it('search_files does not search the quoted sibling', async () => {
    const target = siblingOf(allowedDir, "'");
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'secret-child.txt'), SECRET);
    try {
      await expectToolDenied('search_files', { path: target, pattern: '**/*' }, {
        unchanged: [{ path: path.join(target, 'secret-child.txt'), text: SECRET }],
      });
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it('get_file_info does not stat the quoted sibling', async () => {
    const target = siblingOf(allowedDir, '"');
    await fs.writeFile(target, SECRET);
    try {
      await expectToolDenied('get_file_info', { path: target }, {
        unchanged: [{ path: target, text: SECRET }],
      });
    } finally {
      await fs.rm(target, { force: true });
    }
  });

  it('still writes a file inside the allowed directory', async () => {
    const requested = path.join(allowedDir, 'ok.txt');
    const result = await client.callTool({
      name: 'write_file',
      arguments: { path: requested, content: INSIDE },
    }) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(requested, 'utf8')).toBe(INSIDE);
  });
});
