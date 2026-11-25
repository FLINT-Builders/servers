import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { watch } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { applyFileEdits, writeFileContent } from '../lib.js';

/**
 * Required ceiling for filesystem writes, in UTF-8 bytes.
 *
 * write_file content, every edit_file newText, and the file that an edit
 * would leave on disk must all be at or below this size. A larger body is an
 * error, and the error text includes this decimal value. The refusal happens
 * before any target file or temporary file is created, including when an
 * existing file would be replaced.
 *
 * 1 MiB is large enough for ordinary text edits and small enough that a single
 * tools/call still fits under the stdio transport buffer, so the body reaches
 * the tool handler.
 */
const MAX_FILE_WRITE_BYTES = 1024 * 1024;

/**
 * Operations that do not take a caller-supplied file body are not covered:
 * create_directory, move_file, and the read, list, and search tools.
 * edit_file with dryRun true returns before any write, so it is not part of
 * this disk-write cap.
 */

interface ToolResult {
  isError?: boolean;
  content?: unknown;
}

function ascii(byteLength: number, character = 'a'): string {
  return character.repeat(byteLength);
}

/** U+00E9 is two UTF-8 bytes, so character length and byte length differ. */
function latinE(characters: number): string {
  return '\u00e9'.repeat(characters);
}

function toolText(result: ToolResult | undefined): string {
  if (!result?.isError || !Array.isArray(result.content)) {
    return '';
  }
  return result.content
    .map((item) => {
      if (typeof item === 'object' && item !== null && 'text' in item) {
        return String((item as { text: unknown }).text);
      }
      return '';
    })
    .join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function bodySummary(body: string, original: string): { bytes: number; head: string; same: boolean } {
  return {
    bytes: Buffer.byteLength(body, 'utf8'),
    head: body.slice(0, 8),
    same: body === original,
  };
}

async function observeDirectory<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<{ value?: T; error: unknown; seen: string[] }> {
  const seen = new Set<string>();
  const watcher = watch(dir, (_event, filename) => {
    if (filename !== null) {
      seen.add(filename.toString());
    }
  });
  let value: T | undefined;
  let error: unknown;
  try {
    value = await fn();
  } catch (caught) {
    error = caught;
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  watcher.close();
  return { value, error, seen: [...seen].sort() };
}

async function tempNames(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir);
  return names.filter((name) => name.endsWith('.tmp'));
}

describe('writeFileContent and applyFileEdits size cap', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fs-write-cap-')));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes content of exactly the maximum byte length', async () => {
    const target = path.join(dir, 'at-limit.txt');
    const content = ascii(MAX_FILE_WRITE_BYTES);

    await writeFileContent(target, content);

    const written = await fs.readFile(target);
    expect(written.length).toBe(MAX_FILE_WRITE_BYTES);
    expect(written.subarray(0, 8).toString('utf8')).toBe('aaaaaaaa');
    expect(written.subarray(-8).toString('utf8')).toBe('aaaaaaaa');
  });

  it('writes a small file', async () => {
    const target = path.join(dir, 'small.txt');

    await writeFileContent(target, 'hello');

    expect(await fs.readFile(target, 'utf8')).toBe('hello');
  });

  it('rejects a new file one byte over the maximum before creating it', async () => {
    const target = path.join(dir, 'new.txt');
    const content = ascii(MAX_FILE_WRITE_BYTES + 1);
    const observed = await observeDirectory(dir, () => writeFileContent(target, content));

    expect({
      message: errorMessage(observed.error),
      exists: await fileExists(target),
      temps: await tempNames(dir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      exists: false,
      temps: [],
      seen: [],
    });
  });

  it('rejects an overwrite one byte over the maximum without replacing the file or leaving a temp file', async () => {
    const target = path.join(dir, 'existing.txt');
    const original = 'keep-me';
    await fs.writeFile(target, original);
    const content = ascii(MAX_FILE_WRITE_BYTES + 1);
    const observed = await observeDirectory(dir, () => writeFileContent(target, content));

    expect({
      message: errorMessage(observed.error),
      body: bodySummary(await fs.readFile(target, 'utf8'), original),
      temps: await tempNames(dir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      body: { bytes: Buffer.byteLength(original), head: original.slice(0, 8), same: true },
      temps: [],
      seen: [],
    });
  });

  it('counts UTF-8 bytes, so a shorter string of multibyte characters is still rejected', async () => {
    const target = path.join(dir, 'utf8.txt');
    const content = latinE(MAX_FILE_WRITE_BYTES / 2 + 1);
    expect(content.length).toBeLessThan(MAX_FILE_WRITE_BYTES);
    expect(Buffer.byteLength(content, 'utf8')).toBe(MAX_FILE_WRITE_BYTES + 2);

    const observed = await observeDirectory(dir, () => writeFileContent(target, content));

    expect({
      message: errorMessage(observed.error),
      exists: await fileExists(target),
      temps: await tempNames(dir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      exists: false,
      temps: [],
      seen: [],
    });
  });

  it('accepts a multibyte body whose UTF-8 length is exactly the maximum', async () => {
    const target = path.join(dir, 'utf8-ok.txt');
    const content = latinE(MAX_FILE_WRITE_BYTES / 2);
    expect(Buffer.byteLength(content, 'utf8')).toBe(MAX_FILE_WRITE_BYTES);

    await writeFileContent(target, content);

    expect((await fs.stat(target)).size).toBe(MAX_FILE_WRITE_BYTES);
  });

  it('applies an edit that leaves the file exactly at the maximum', async () => {
    const target = path.join(dir, 'edit-ok.txt');
    const original = ascii(MAX_FILE_WRITE_BYTES);
    await fs.writeFile(target, original);

    await applyFileEdits(target, [{ oldText: 'a', newText: 'b' }], false);

    const body = await fs.readFile(target, 'utf8');
    expect(Buffer.byteLength(body, 'utf8')).toBe(MAX_FILE_WRITE_BYTES);
    expect(body.startsWith('b')).toBe(true);
  });

  it('rejects an edit whose replacement is one byte over the maximum before writing', async () => {
    const target = path.join(dir, 'edit-new.txt');
    const original = 'short';
    await fs.writeFile(target, original);
    const newText = ascii(MAX_FILE_WRITE_BYTES + 1);
    const observed = await observeDirectory(dir, () =>
      applyFileEdits(target, [{ oldText: original, newText }], false),
    );

    expect({
      message: errorMessage(observed.error),
      body: bodySummary(await fs.readFile(target, 'utf8'), original),
      temps: await tempNames(dir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      body: { bytes: Buffer.byteLength(original), head: 'short', same: true },
      temps: [],
      seen: [],
    });
  });

  it('rejects an edit that would grow a maximum-sized file by one byte', async () => {
    const target = path.join(dir, 'edit-grow.txt');
    const original = ascii(MAX_FILE_WRITE_BYTES);
    await fs.writeFile(target, original);
    const observed = await observeDirectory(dir, () =>
      applyFileEdits(target, [{ oldText: 'a', newText: 'bb' }], false),
    );

    expect({
      message: errorMessage(observed.error),
      body: bodySummary(await fs.readFile(target, 'utf8'), original),
      temps: await tempNames(dir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      body: { bytes: MAX_FILE_WRITE_BYTES, head: 'a'.repeat(8), same: true },
      temps: [],
      seen: [],
    });
  });

  it('rejects when each replacement is small but the file after every edit exceeds the maximum', async () => {
    const target = path.join(dir, 'edit-seq.txt');
    const original = ascii(MAX_FILE_WRITE_BYTES);
    await fs.writeFile(target, original);
    const observed = await observeDirectory(dir, () =>
      applyFileEdits(
        target,
        [
          { oldText: 'a', newText: 'b' },
          { oldText: 'b', newText: 'cc' },
        ],
        false,
      ),
    );

    expect({
      message: errorMessage(observed.error),
      body: bodySummary(await fs.readFile(target, 'utf8'), original),
      temps: await tempNames(dir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      body: { bytes: MAX_FILE_WRITE_BYTES, head: 'a'.repeat(8), same: true },
      temps: [],
      seen: [],
    });
  });

  it('rejects a multibyte replacement whose character length is under the cap but whose UTF-8 length is over it', async () => {
    const target = path.join(dir, 'edit-utf8.txt');
    const original = 'x';
    await fs.writeFile(target, original);
    const newText = latinE(MAX_FILE_WRITE_BYTES / 2 + 1);
    expect(newText.length).toBeLessThan(MAX_FILE_WRITE_BYTES);
    expect(Buffer.byteLength(newText, 'utf8')).toBeGreaterThan(MAX_FILE_WRITE_BYTES);

    const observed = await observeDirectory(dir, () =>
      applyFileEdits(target, [{ oldText: original, newText }], false),
    );

    expect({
      message: errorMessage(observed.error),
      body: bodySummary(await fs.readFile(target, 'utf8'), original),
      temps: await tempNames(dir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      body: { bytes: 1, head: 'x', same: true },
      temps: [],
      seen: [],
    });
  });

  it('allows an edit that shrinks an already oversized file to the maximum or below', async () => {
    const target = path.join(dir, 'edit-shrink.txt');
    const original = ascii(MAX_FILE_WRITE_BYTES + 50);
    await fs.writeFile(target, original);

    await applyFileEdits(
      target,
      [{ oldText: ascii(100), newText: ascii(10, 'b') }],
      false,
    );

    const body = await fs.readFile(target, 'utf8');
    expect(Buffer.byteLength(body, 'utf8')).toBe(MAX_FILE_WRITE_BYTES - 40);
    expect(body.startsWith('b'.repeat(10))).toBe(true);
  });
});

describe('write_file and edit_file tools size cap', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let testDir: string;

  beforeAll(async () => {
    testDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fs-write-cap-mcp-')));
    const serverPath = path.resolve(__dirname, '../dist/index.js');
    transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, testDir],
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    client = new Client({ name: 'write-size-cap', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, 20000);

  afterAll(async () => {
    await client?.close();
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('writes a small file through write_file', async () => {
    const target = path.join(testDir, 'tool-small.txt');
    const result = await client.callTool({
      name: 'write_file',
      arguments: { path: target, content: 'hello' },
    }) as ToolResult;

    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('hello');
  }, 20000);

  it('persists write_file content of exactly the maximum byte length', async () => {
    const target = path.join(testDir, 'tool-at-limit.txt');
    const content = ascii(MAX_FILE_WRITE_BYTES);
    const result = await client.callTool({
      name: 'write_file',
      arguments: { path: target, content },
    }) as ToolResult;

    expect(result.isError).not.toBe(true);
    const written = await fs.readFile(target);
    expect(written.length).toBe(MAX_FILE_WRITE_BYTES);
    expect(written.subarray(0, 8).toString('utf8')).toBe('aaaaaaaa');
    expect(written.subarray(-8).toString('utf8')).toBe('aaaaaaaa');
  }, 20000);

  it('rejects write_file one byte over the maximum before creating a new file', async () => {
    const target = path.join(testDir, 'tool-new.txt');
    const content = ascii(MAX_FILE_WRITE_BYTES + 1);
    const observed = await observeDirectory(testDir, () =>
      client.callTool({
        name: 'write_file',
        arguments: { path: target, content },
      }) as Promise<ToolResult>,
    );
    const result = observed.value;

    expect({
      message: toolText(result) || errorMessage(observed.error),
      exists: await fileExists(target),
      temps: await tempNames(testDir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      exists: false,
      temps: [],
      seen: [],
    });
  }, 20000);

  it('rejects write_file one byte over the maximum without replacing an existing file', async () => {
    const target = path.join(testDir, 'tool-existing.txt');
    const original = 'keep-me';
    await fs.writeFile(target, original);
    const content = ascii(MAX_FILE_WRITE_BYTES + 1);
    const observed = await observeDirectory(testDir, () =>
      client.callTool({
        name: 'write_file',
        arguments: { path: target, content },
      }) as Promise<ToolResult>,
    );

    expect({
      message: toolText(observed.value) || errorMessage(observed.error),
      body: bodySummary(await fs.readFile(target, 'utf8'), original),
      temps: await tempNames(testDir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      body: { bytes: Buffer.byteLength(original), head: original.slice(0, 8), same: true },
      temps: [],
      seen: [],
    });
  }, 20000);

  it('rejects write_file when UTF-8 bytes exceed the maximum and the character length does not', async () => {
    const target = path.join(testDir, 'tool-utf8.txt');
    const content = latinE(MAX_FILE_WRITE_BYTES / 2 + 1);
    expect(content.length).toBeLessThan(MAX_FILE_WRITE_BYTES);
    const observed = await observeDirectory(testDir, () =>
      client.callTool({
        name: 'write_file',
        arguments: { path: target, content },
      }) as Promise<ToolResult>,
    );

    expect({
      message: toolText(observed.value) || errorMessage(observed.error),
      exists: await fileExists(target),
      temps: await tempNames(testDir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      exists: false,
      temps: [],
      seen: [],
    });
  }, 20000);

  it('applies edit_file when the resulting file stays at the maximum', async () => {
    const target = path.join(testDir, 'tool-edit-ok.txt');
    const original = ascii(MAX_FILE_WRITE_BYTES);
    await fs.writeFile(target, original);
    const result = await client.callTool({
      name: 'edit_file',
      arguments: {
        path: target,
        edits: [{ oldText: 'a', newText: 'b' }],
        dryRun: false,
      },
    }) as ToolResult;

    expect(result.isError).not.toBe(true);
    const body = await fs.readFile(target, 'utf8');
    expect(Buffer.byteLength(body, 'utf8')).toBe(MAX_FILE_WRITE_BYTES);
    expect(body.startsWith('b')).toBe(true);
  }, 20000);

  it('rejects edit_file when newText is one byte over the maximum and leaves the file untouched', async () => {
    const target = path.join(testDir, 'tool-edit-new.txt');
    const original = 'short';
    await fs.writeFile(target, original);
    const observed = await observeDirectory(testDir, () =>
      client.callTool({
        name: 'edit_file',
        arguments: {
          path: target,
          edits: [{ oldText: original, newText: ascii(MAX_FILE_WRITE_BYTES + 1) }],
          dryRun: false,
        },
      }) as Promise<ToolResult>,
    );

    expect({
      message: toolText(observed.value) || errorMessage(observed.error),
      body: bodySummary(await fs.readFile(target, 'utf8'), original),
      temps: await tempNames(testDir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      body: { bytes: Buffer.byteLength(original), head: 'short', same: true },
      temps: [],
      seen: [],
    });
  }, 20000);

  it('rejects edit_file when small replacements leave a file over the maximum', async () => {
    const target = path.join(testDir, 'tool-edit-grow.txt');
    const original = ascii(MAX_FILE_WRITE_BYTES);
    await fs.writeFile(target, original);
    const observed = await observeDirectory(testDir, () =>
      client.callTool({
        name: 'edit_file',
        arguments: {
          path: target,
          edits: [
            { oldText: 'a', newText: 'b' },
            { oldText: 'b', newText: 'cc' },
          ],
          dryRun: false,
        },
      }) as Promise<ToolResult>,
    );

    expect({
      message: toolText(observed.value) || errorMessage(observed.error),
      body: bodySummary(await fs.readFile(target, 'utf8'), original),
      temps: await tempNames(testDir),
      seen: observed.seen,
    }).toEqual({
      message: expect.stringContaining(String(MAX_FILE_WRITE_BYTES)),
      body: { bytes: MAX_FILE_WRITE_BYTES, head: 'a'.repeat(8), same: true },
      temps: [],
      seen: [],
    });
  }, 20000);

  it('allows edit_file to shrink an oversized file down to the maximum or below', async () => {
    const target = path.join(testDir, 'tool-edit-shrink.txt');
    const original = ascii(MAX_FILE_WRITE_BYTES + 50);
    await fs.writeFile(target, original);
    const result = await client.callTool({
      name: 'edit_file',
      arguments: {
        path: target,
        edits: [{ oldText: ascii(100), newText: ascii(10, 'b') }],
        dryRun: false,
      },
    }) as ToolResult;

    expect(result.isError).not.toBe(true);
    const body = await fs.readFile(target, 'utf8');
    expect(Buffer.byteLength(body, 'utf8')).toBe(MAX_FILE_WRITE_BYTES - 40);
  }, 20000);
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
