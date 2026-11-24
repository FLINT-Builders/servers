/**
 * Spec for private overwrite/edit atomic writes.
 *
 * These tests fail while the filesystem server creates the replacement body
 * in a same-directory temporary file using the process umask (mode 0666),
 * then renames it over the target and ignores errors from the later chmod.
 * They pass once the temporary inode is created mode 0600 (or the original
 * mode when that is stricter) before any body bytes are written, the mode
 * is restored on that inode before rename, and a failed mode change rejects
 * the operation without leaving the new body group- or world-readable.
 */
import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from 'fs';
import fsDefault from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyFileEdits, setAllowedDirectories, validatePath, writeFileContent } from '../lib.js';

const MARKER = 'PRIVATE-FILE-BODY-MARKER';
const ORIGINAL_MODE = 0o600;
const TARGET_NAME = 'private.txt';
// Node 22 writes files in 512 KiB chunks and yields between chunks.
// The body is larger than one chunk so the temporary name stays visible.
const BODY_PADDING = 2 * 1024 * 1024;

interface Sample {
  name: string;
  mode: number;
  containsMarker: boolean;
}

interface ExposureResult {
  error: unknown;
  finalMode: number;
  finalContainsMarker: boolean;
  samples: Sample[];
  nobodyHits: string[];
  nobodyLog: string;
}

function permissionBits(mode: number): number {
  return mode & 0o777;
}

function octal(mode: number): string {
  return permissionBits(mode).toString(8);
}

async function failChmod(): Promise<() => void> {
  const denied = async (): Promise<void> => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };
  const previousDefault = fsDefault.chmod;
  const handle = await fsDefault.open(os.devNull, 'r');
  const prototype = Object.getPrototypeOf(handle) as { chmod(mode: number): Promise<void> };
  await handle.close();
  const previousHandle = prototype.chmod;
  fsDefault.chmod = denied as typeof fsDefault.chmod;
  prototype.chmod = denied;
  return () => {
    fsDefault.chmod = previousDefault;
    prototype.chmod = previousHandle;
  };
}

function writeReaderScript(): string {
  const scriptPath = path.join(os.tmpdir(), `temp-mode-reader-${process.pid}.mjs`);
  writeFileSync(
    scriptPath,
    `
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';

const directory = process.argv[2];
const marker = process.argv[3];
const outPath = process.argv[4];
const readyPath = process.argv[5];
const stopPath = process.argv[6];
const seen = new Set();

writeFileSync(outPath, '');
writeFileSync(readyPath, 'ready\\n');

while (!existsSync(stopPath)) {
  let names = [];
  try {
    names = readdirSync(directory);
  } catch {
    continue;
  }
  for (const name of names) {
    const filePath = directory + '/' + name;
    try {
      const mode = (statSync(filePath).mode & 0o777).toString(8);
      const body = readFileSync(filePath);
      if (body.includes(marker) && !seen.has('hit:' + name)) {
        seen.add('hit:' + name);
        appendFileSync(outPath, 'HIT\\t' + name + '\\t' + mode + '\\t' + body.length + '\\n');
      }
    } catch (error) {
      const code = error && error.code ? error.code : 'UNKNOWN';
      const key = 'err:' + name + ':' + code;
      if (!seen.has(key)) {
        seen.add(key);
        appendFileSync(outPath, 'ERR\\t' + name + '\\t' + code + '\\n');
      }
    }
  }
}
appendFileSync(outPath, 'DONE\\n');
`,
    { mode: 0o644 },
  );
  chmodSync(scriptPath, 0o644);
  return scriptPath;
}

function spawnNobody(args: string[]): ChildProcess {
  return spawn('sudo', ['-n', '-u', 'nobody', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
}

async function readAsNobody(filePath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawnNobody(['cat', '--', filePath]);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => resolve(exitCode));
  });
  return { code, stdout, stderr };
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(filePath)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runExposure(
  operation: (validatedPath: string) => Promise<unknown>,
): Promise<ExposureResult> {
  const directory = await fsDefault.realpath(
    await fsDefault.mkdtemp(path.join(os.tmpdir(), 'fs-temp-mode-')),
  );
  await fsDefault.chmod(directory, 0o755);
  const target = path.join(directory, TARGET_NAME);
  await fsDefault.writeFile(target, 'original-body\n', { mode: ORIGINAL_MODE });
  await fsDefault.chmod(target, ORIGINAL_MODE);
  setAllowedDirectories([directory]);

  const suffix = randomBytes(8).toString('hex');
  const outPath = path.join(os.tmpdir(), `temp-mode-hits-${suffix}.txt`);
  const readyPath = `${outPath}.ready`;
  const stopPath = path.join(directory, '.reader-stop');
  const reader = spawnNobody([
    process.execPath,
    writeReaderScript(),
    directory,
    MARKER,
    outPath,
    readyPath,
    stopPath,
  ]);
  let readerError = '';
  reader.stderr?.on('data', (chunk: Buffer) => {
    readerError += chunk.toString('utf8');
  });

  const samples: Sample[] = [];
  let stopPolling = false;
  const previousUmask = process.umask(0o022);
  try {
    await waitForFile(readyPath);
    const polling = (async () => {
      while (!stopPolling) {
        let names: string[] = [];
        try {
          names = await fsDefault.readdir(directory);
        } catch {
          names = [];
        }
        for (const name of names) {
          if (name === '.reader-stop') continue;
          const filePath = path.join(directory, name);
          try {
            const stats = statSync(filePath);
            if (!stats.isFile()) continue;
            const length = Math.min(stats.size, 64 * 1024);
            const buffer = Buffer.alloc(length);
            const fd = openSync(filePath, 'r');
            let bytesRead = 0;
            try {
              bytesRead = readSync(fd, buffer, 0, length, 0);
            } finally {
              closeSync(fd);
            }
            samples.push({
              name,
              mode: permissionBits(stats.mode),
              containsMarker: buffer.subarray(0, bytesRead).includes(MARKER),
            });
          } catch {
            // The temporary name can disappear between readdir and open.
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    let error: unknown = null;
    try {
      const validated = await validatePath(target);
      await operation(validated);
    } catch (caught) {
      error = caught;
    } finally {
      stopPolling = true;
    }
    await polling;

    writeFileSync(stopPath, 'stop\n', { mode: 0o644 });
    const deadline = Date.now() + 5000;
    let nobodyLog = '';
    while (Date.now() < deadline) {
      if (existsSync(outPath)) {
        nobodyLog = await fsDefault.readFile(outPath, 'utf8');
        if (nobodyLog.includes('DONE')) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!nobodyLog.includes('DONE')) {
      throw new Error(`other-user reader did not finish: ${readerError || nobodyLog}`);
    }

    const finalStats = await fsDefault.stat(target);
    const finalBody = await fsDefault.readFile(target);
    return {
      error,
      finalMode: permissionBits(finalStats.mode),
      finalContainsMarker: finalBody.includes(MARKER),
      samples,
      nobodyHits: nobodyLog.split('\n').filter((line) => line.startsWith('HIT\t')),
      nobodyLog,
    };
  } finally {
    process.umask(previousUmask);
    stopPolling = true;
    if (reader.pid) {
      try {
        process.kill(-reader.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(reader.pid, 'SIGTERM');
        } catch {
          // The reader already exited.
        }
      }
    }
    await fsDefault.rm(directory, { recursive: true, force: true });
    await fsDefault.rm(outPath, { force: true }).catch(() => undefined);
    await fsDefault.rm(readyPath, { force: true }).catch(() => undefined);
    setAllowedDirectories([]);
  }
}

function exposureProblems(result: ExposureResult): string[] {
  const problems: string[] = [];
  if (result.error) {
    problems.push(`operation rejected: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
  }
  const withMarker = result.samples.filter((sample) => sample.containsMarker);
  const temporary = withMarker.filter((sample) => sample.name !== TARGET_NAME);
  if (temporary.length === 0) {
    problems.push('did not observe a same-directory temporary file that already held the new body');
  }
  const exposed = new Set<string>();
  for (const sample of withMarker) {
    if ((sample.mode & 0o077) !== 0) {
      exposed.add(
        `${sample.name} mode ${octal(sample.mode)} was group- or world-accessible while it held the new body`,
      );
    }
  }
  problems.push(...exposed);
  if (result.nobodyHits.length > 0) {
    problems.push(`another local user read the new body: ${result.nobodyHits.join('; ')}`);
  }
  if (!result.nobodyLog.includes('EACCES')) {
    problems.push('other-user reader never confirmed the directory was traversable by attempting a private open');
  }
  if (result.finalMode !== ORIGINAL_MODE) {
    problems.push(`final mode ${octal(result.finalMode)} did not keep the original mode ${octal(ORIGINAL_MODE)}`);
  }
  if (!result.finalContainsMarker) {
    problems.push('validated path did not contain the new body after the operation');
  }
  return problems;
}

describe('private file replacement modes', () => {
  afterEach(() => {
    setAllowedDirectories([]);
  });

  it('write_file overwrite keeps a mode 0600 body unreadable by other local users', async () => {
    const body = `${MARKER}\n${'A'.repeat(BODY_PADDING)}\n`;
    const result = await runExposure((validatedPath) => writeFileContent(validatedPath, body));
    expect(exposureProblems(result)).toEqual([]);
  }, 20000);

  it('edit_file keeps a mode 0600 body unreadable by other local users', async () => {
    const replacement = `${MARKER}\n${'B'.repeat(BODY_PADDING)}`;
    const result = await runExposure((validatedPath) => applyFileEdits(
      validatedPath,
      [{ oldText: 'original-body', newText: replacement }],
      false,
    ));
    expect(exposureProblems(result)).toEqual([]);
  }, 20000);

  it('write_file rejects when restoring the private mode fails and does not leave the new body world-readable', async () => {
    const problems = await permissionRestoreProblems((validatedPath) => (
      writeFileContent(validatedPath, `${MARKER}\nrestored\n`)
    ));
    expect(problems).toEqual([]);
  }, 20000);

  it('edit_file rejects when restoring the private mode fails and does not leave the new body world-readable', async () => {
    const problems = await permissionRestoreProblems((validatedPath) => applyFileEdits(
      validatedPath,
      [{ oldText: 'original-body', newText: `${MARKER}\nrestored` }],
      false,
    ));
    expect(problems).toEqual([]);
  }, 20000);
});

async function permissionRestoreProblems(
  operation: (validatedPath: string) => Promise<unknown>,
): Promise<string[]> {
  const directory = await fsDefault.realpath(
    await fsDefault.mkdtemp(path.join(os.tmpdir(), 'fs-temp-mode-')),
  );
  await fsDefault.chmod(directory, 0o755);
  const target = path.join(directory, TARGET_NAME);
  await fsDefault.writeFile(target, 'original-body\n', { mode: ORIGINAL_MODE });
  await fsDefault.chmod(target, ORIGINAL_MODE);
  setAllowedDirectories([directory]);
  const restore = await failChmod();
  const previousUmask = process.umask(0o022);
  const problems: string[] = [];
  try {
    let error: unknown = null;
    try {
      const validated = await validatePath(target);
      await operation(validated);
    } catch (caught) {
      error = caught;
    }
    if (!error) {
      problems.push('operation succeeded after chmod/fchmod returned EPERM');
    }

    const entries = await fsDefault.readdir(directory);
    for (const name of entries) {
      const filePath = path.join(directory, name);
      const stats = await fsDefault.stat(filePath);
      if (!stats.isFile()) continue;
      const body = await fsDefault.readFile(filePath);
      if (!body.includes(MARKER)) continue;
      if ((permissionBits(stats.mode) & 0o077) !== 0) {
        problems.push(
          `${name} mode ${octal(stats.mode)} still holds the new body and is group- or world-accessible`,
        );
      }
      const otherUser = await readAsNobody(filePath);
      if (otherUser.code === 0 && otherUser.stdout.includes(MARKER)) {
        problems.push(`another local user read ${name} after the failed mode restore`);
      }
    }
  } finally {
    restore();
    process.umask(previousUmask);
    await fsDefault.rm(directory, { recursive: true, force: true });
    setAllowedDirectories([]);
  }
  return problems;
}
