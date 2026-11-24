import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyFileEdits,
  moveFile,
  readFileContent,
  setAllowedDirectories,
  validatePath,
  writeFileContent,
} from '../lib.js';

const execFileAsync = promisify(execFile);

/**
 * Case-insensitive volume used to exercise the real filesystem lookup.
 * macOS and Windows resolve a different-case spelling to the same directory
 * entry. This host is case-sensitive, so the suite mounts an NTFS volume with
 * lowntfs-3g's ignore_case option, which performs that lookup. On a host whose
 * own temporary directory is already case-insensitive, that directory is used
 * directly.
 */
describe('case-insensitive symlink escape', () => {
  let workDir: string | undefined;
  let mountPoint: string | undefined;
  let imagePath: string | undefined;
  let allowedDir: string;
  let outsideDir: string;
  let symlinkName: string;
  let outsideBefore: Map<string, string | Buffer>;

  beforeAll(async () => {
    const layout = await createCaseInsensitiveLayout();
    workDir = layout.workDir;
    mountPoint = layout.mountPoint;
    imagePath = layout.imagePath;
    allowedDir = layout.allowedDir;
    outsideDir = layout.outsideDir;
    symlinkName = layout.symlinkName;

    const flipped = flipCase(symlinkName);
    const viaFlipped = path.join(allowedDir, flipped);
    const linkStat = await fs.lstat(viaFlipped);
    if (!linkStat.isSymbolicLink()) {
      throw new Error(`Expected ${viaFlipped} to be a symlink`);
    }
    const resolved = await fs.realpath(viaFlipped);
    if (resolved !== await fs.realpath(outsideDir)) {
      throw new Error(`Case-folded symlink ${viaFlipped} resolved to ${resolved}, not ${outsideDir}`);
    }
  }, 120_000);

  beforeEach(async () => {
    setAllowedDirectories([allowedDir]);
    outsideBefore = await snapshotTree(outsideDir);
  });

  afterAll(async () => {
    setAllowedDirectories([]);
    if (mountPoint) {
      await execFileAsync('sudo', ['-n', 'umount', mountPoint]).catch(async () => {
        await execFileAsync('sudo', ['-n', 'umount', '-l', mountPoint as string]).catch(() => undefined);
      });
    }
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects an exact-case symlink that points outside the allowed directory', async () => {
    const planted = path.join(outsideDir, 'exact-case.txt');
    const error = await capture(async () => {
      await writeFileTool(path.join(allowedDir, symlinkName, 'exact-case.txt'), 'should-not-land');
    });

    await expectContained(error, outsideDir, outsideBefore);
    await expect(fs.lstat(planted)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not create a new file through a different-case spelling of an outside symlink', async () => {
    const requested = path.join(allowedDir, flipCase(symlinkName), 'Library', 'LaunchAgents', 'com.evil.plist');
    const error = await capture(async () => {
      await writeFileTool(requested, 'escape-marker-write');
    });

    await expectContained(error, outsideDir, outsideBefore);
  });

  it('does not create a new file when the different-case symlink path is relative', async () => {
    const requested = path.join(flipCase(symlinkName), 'Library', 'LaunchAgents', 'relative-planted.txt');
    const error = await capture(async () => {
      await writeFileTool(requested, 'escape-marker-relative');
    });

    await expectContained(error, outsideDir, outsideBefore);
  });

  it('does not create a directory through a different-case spelling of an outside symlink', async () => {
    const requested = path.join(allowedDir, flipCase(symlinkName), 'Library', 'LaunchAgents', 'planted-dir');
    const error = await capture(async () => {
      await createDirectoryTool(requested);
    });

    await expectContained(error, outsideDir, outsideBefore);
  });

  it('does not move an allowed file through a different-case spelling of an outside symlink', async () => {
    const source = path.join(allowedDir, 'movable.txt');
    await fs.writeFile(source, 'movable-body');
    const requested = path.join(allowedDir, flipCase(symlinkName), 'Library', 'LaunchAgents', 'moved.txt');

    const error = await capture(async () => {
      await moveFileTool(source, requested);
    });

    await expectContained(error, outsideDir, outsideBefore);
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('movable-body');
  });

  it('does not write through an outside symlink when an earlier directory spelling differs only by case', async () => {
    const directoryName = 'nested';
    await fs.mkdir(path.join(allowedDir, directoryName));
    await fs.symlink(path.relative(path.join(allowedDir, directoryName), outsideDir), path.join(allowedDir, directoryName, 'link'));

    const requested = path.join(allowedDir, flipCase(directoryName), 'link', 'via-ancestor.txt');
    const error = await capture(async () => {
      await writeFileTool(requested, 'escape-marker-ancestor');
    });

    await expectContained(error, outsideDir, outsideBefore);
  });

  it('does not create a directory through an outside symlink hidden by an earlier case difference', async () => {
    const directoryName = 'nestedmkdir';
    await fs.mkdir(path.join(allowedDir, directoryName));
    await fs.symlink(path.relative(path.join(allowedDir, directoryName), outsideDir), path.join(allowedDir, directoryName, 'link'));

    const requested = path.join(allowedDir, flipCase(directoryName), 'link', 'via-ancestor-dir');
    const error = await capture(async () => {
      await createDirectoryTool(requested);
    });

    await expectContained(error, outsideDir, outsideBefore);
  });

  it('does not move a file through an outside symlink hidden by an earlier case difference', async () => {
    const directoryName = 'nestedmove';
    await fs.mkdir(path.join(allowedDir, directoryName));
    await fs.symlink(path.relative(path.join(allowedDir, directoryName), outsideDir), path.join(allowedDir, directoryName, 'link'));
    const source = path.join(allowedDir, 'movable-ancestor.txt');
    await fs.writeFile(source, 'movable-ancestor-body');

    const requested = path.join(allowedDir, flipCase(directoryName), 'link', 'via-ancestor-moved.txt');
    const error = await capture(async () => {
      await moveFileTool(source, requested);
    });

    await expectContained(error, outsideDir, outsideBefore);
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('movable-ancestor-body');
  });

  it('does not create a file when edit_file targets a missing path through a different-case symlink', async () => {
    const requested = path.join(allowedDir, flipCase(symlinkName), 'Library', 'LaunchAgents', 'edited-new.txt');
    const error = await capture(async () => {
      const validPath = await validatePath(requested);
      await applyFileEdits(validPath, [{ oldText: 'missing', newText: 'created' }], false);
    });

    await expectContained(error, outsideDir, outsideBefore);
  });

  it('does not overwrite or read an existing outside file through a different-case symlink', async () => {
    const secretPath = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(secretPath, 'original-secret');
    outsideBefore = await snapshotTree(outsideDir);
    const requested = path.join(allowedDir, flipCase(symlinkName), 'secret.txt');

    const readError = await capture(async () => {
      const validPath = await validatePath(requested);
      await readFileContent(validPath);
    });
    const editError = await capture(async () => {
      const validPath = await validatePath(requested);
      await applyFileEdits(validPath, [{ oldText: 'original-secret', newText: 'rewritten-secret' }], false);
    });
    const writeError = await capture(async () => {
      await writeFileTool(requested, 'overwritten-secret');
    });

    await expectContained(readError, outsideDir, outsideBefore);
    await expectContained(editError, outsideDir, outsideBefore);
    await expectContained(writeError, outsideDir, outsideBefore);
    await expect(fs.readFile(secretPath, 'utf8')).resolves.toBe('original-secret');
  });

  it('still creates a directory that does not exist inside the allowed directory', async () => {
    const requested = path.join(allowedDir, 'brand-new', 'nested');
    const error = await capture(async () => {
      await createDirectoryTool(requested);
    });

    expect(error).toBeUndefined();
    const created = await fs.lstat(requested);
    expect(created.isDirectory()).toBe(true);
    expect(describeTree(await snapshotTree(outsideDir))).toEqual(describeTree(outsideBefore));
  });
});

// Same sequence as the write_file handler in src/filesystem/index.ts.
async function writeFileTool(requestedPath: string, content: string): Promise<void> {
  const validPath = await validatePath(requestedPath);
  await writeFileContent(validPath, content);
}

// Same sequence as the create_directory handler in src/filesystem/index.ts.
async function createDirectoryTool(requestedPath: string): Promise<void> {
  const validPath = await validatePath(requestedPath);
  await fs.mkdir(validPath, { recursive: true });
}

// Same sequence as the move_file handler in src/filesystem/index.ts.
async function moveFileTool(source: string, destination: string): Promise<void> {
  const validSourcePath = await validatePath(source);
  const validDestPath = await validatePath(destination);
  await moveFile(validSourcePath, validDestPath);
}

async function capture(operation: () => Promise<void>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function describeTree(tree: Map<string, string | Buffer>): Record<string, string> {
  return Object.fromEntries(
    [...tree.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, typeof value === 'string' ? value : value.toString('utf8')]),
  );
}

async function expectContained(error: unknown, outsideDir: string, before: Map<string, string | Buffer>): Promise<void> {
  const after = describeTree(await snapshotTree(outsideDir));
  expect(after, 'files outside the allowed directory changed').toEqual(describeTree(before));
  expect(error, 'sandboxed operation reported success').toBeInstanceOf(Error);
}

function flipCase(name: string): string {
  const chars = Array.from(name);
  const index = chars.findIndex((char) => char.toLowerCase() !== char.toUpperCase());
  if (index < 0) {
    throw new Error(`No cased letter in ${name}`);
  }
  const char = chars[index];
  chars[index] = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
  return chars.join('');
}

async function snapshotTree(root: string): Promise<Map<string, string | Buffer>> {
  const entries = new Map<string, string>();

  async function walk(current: string, prefix: string): Promise<void> {
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (child.isSymbolicLink()) {
        continue;
      }
      const relative = prefix ? path.join(prefix, child.name) : child.name;
      const full = path.join(current, child.name);
      if (child.isDirectory()) {
        entries.set(`${relative}/`, 'dir');
        await walk(full, relative);
        continue;
      }
      if (child.isFile()) {
        entries.set(relative, await fs.readFile(full));
      }
    }
  }

  await walk(root, '');
  return entries;
}

interface CaseInsensitiveLayout {
  workDir?: string;
  mountPoint?: string;
  imagePath?: string;
  allowedDir: string;
  outsideDir: string;
  symlinkName: string;
}

async function createCaseInsensitiveLayout(): Promise<CaseInsensitiveLayout> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-ci-escape-'));
  if (await directoryIsCaseInsensitive(workDir)) {
    const layout = await seedLayout(workDir);
    return { ...layout, workDir };
  }

  for (const command of ['mkfs.ntfs', 'lowntfs-3g', 'sudo']) {
    await execFileAsync('bash', ['-lc', `command -v ${command}`]).catch(() => {
      throw new Error(
        `Case-insensitive fixture requires ${command}. On Debian/Ubuntu install the ntfs-3g package and allow passwordless sudo.`,
      );
    });
  }

  const imagePath = path.join(workDir, 'volume.img');
  const mountPoint = path.join(workDir, 'mnt');
  await fs.mkdir(mountPoint);
  await execFileAsync('truncate', ['-s', '32M', imagePath]);
  await execFileAsync('mkfs.ntfs', ['-F', '-Q', '-L', 'cifstest', imagePath]);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error('Cannot mount a case-insensitive volume without numeric uid and gid');
  }
  await execFileAsync('sudo', [
    '-n',
    'lowntfs-3g',
    '-o',
    `ignore_case,uid=${uid},gid=${gid},umask=022`,
    imagePath,
    mountPoint,
  ]);

  const layout = await seedLayout(mountPoint);
  if (!await directoryIsCaseInsensitive(mountPoint)) {
    throw new Error(`Mounted volume at ${mountPoint} is not case-insensitive`);
  }
  const probe = path.join(mountPoint, 'writable-probe');
  await fs.writeFile(probe, 'ok');
  await fs.rm(probe);
  return { ...layout, workDir, mountPoint, imagePath };
}

async function seedLayout(root: string): Promise<CaseInsensitiveLayout> {
  const allowedPath = path.join(root, 'allowed');
  const outsidePath = path.join(root, 'outside');
  await fs.mkdir(allowedPath);
  await fs.mkdir(path.join(outsidePath, 'Library', 'LaunchAgents'), { recursive: true });
  const symlinkName = 'up';
  await fs.symlink(path.relative(allowedPath, outsidePath), path.join(allowedPath, symlinkName));
  return {
    allowedDir: await fs.realpath(allowedPath),
    outsideDir: await fs.realpath(outsidePath),
    symlinkName,
  };
}

async function directoryIsCaseInsensitive(directory: string): Promise<boolean> {
  const probe = path.join(directory, `CaseProbe-${process.pid}`);
  await fs.writeFile(probe, 'probe');
  try {
    await fs.access(path.join(directory, `caseprobe-${process.pid}`));
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { force: true });
  }
}
