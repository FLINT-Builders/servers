import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn, type ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Spec for the check-then-open race in filesystem reads.
 *
 * validatePath resolves the requested name and returns that path string.
 * read_text_file, read_file, read_multiple_files, read_media_file, and
 * edit_file then open the same name again. A writer who can replace the
 * directory entry in between makes those opens follow a symlink to a file
 * outside the allowlist.
 *
 * The racer is a different uid that cannot read the outside file. It
 * atomically exchanges the allowlisted name with a symlink for the whole
 * test, including across any number of later realpath or stat calls. A fix
 * that looks the name up again and then opens it by name still loses the
 * race. A fix that opens with O_NOFOLLOW (or openat on the parent) and reads
 * that descriptor does not return the outside bytes.
 *
 * Not covered, because they do not return file bytes:
 * get_file_info and list_directory_with_sizes stat the name after
 * validatePath and can expose the target's metadata. list_directory,
 * directory_tree, and search_files do not read file bodies. write_file and
 * move_file are outside this read race.
 */

const SENTINEL = 'OUTSIDE-ALLOWLIST-SENTINEL';
const PUBLIC_BODY = 'PUBLIC-CONTENT-INSIDE-ALLOWLIST'.padEnd(64, 'P');
const SECRET_BODY = SENTINEL.padEnd(64, 'S');
const ATTEMPTS = 80;

const RACER_SOURCE = `
import ctypes, os, sys
libc = ctypes.CDLL("libc.so.6", use_errno=True)
AT_FDCWD = -100
RENAME_EXCHANGE = 2
name = sys.argv[1].encode()
parked = sys.argv[2].encode()
with open(sys.argv[3], "w", encoding="utf-8") as pid_file:
    pid_file.write(str(os.getpid()))
while True:
    rc = libc.renameat2(AT_FDCWD, name, AT_FDCWD, parked, RENAME_EXCHANGE)
    if rc != 0:
        err = ctypes.get_errno()
        if err == 2:
            continue
        sys.stderr.write("renameat2 failed: %s\\n" % err)
        sys.exit(1)
`;

function payloadHasSentinel(value: unknown): boolean {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (raw.includes(SENTINEL)) {
    return true;
  }
  const blobs = raw.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? [];
  for (const blob of blobs) {
    const decoded = Buffer.from(blob, 'base64').toString('utf8');
    if (decoded.includes(SENTINEL)) {
      return true;
    }
  }
  return false;
}

describe('symlink swap after path check', () => {
  let root: string;
  let allowed: string;
  let outsideFile: string;
  let raceName: string;
  let stableLink: string;
  let racer: ChildProcess;
  let racerPidFile: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    expect(PUBLIC_BODY.length).toBe(SECRET_BODY.length);

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-symlink-swap-'));
    // The parent of a mkdtemp directory is mode 0700. The writer uid must be
    // able to traverse it and replace entries in the allowlist.
    await fs.chmod(root, 0o755);
    allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'outside');
    await fs.mkdir(allowed);
    await fs.mkdir(outside);
    await fs.chmod(allowed, 0o777);
    await fs.chmod(outside, 0o755);

    outsideFile = path.join(outside, 'private-file.txt');
    await fs.writeFile(outsideFile, SECRET_BODY, { mode: 0o400 });
    raceName = path.join(allowed, 'readable.txt');
    await fs.writeFile(raceName, PUBLIC_BODY);
    const parked = path.join(allowed, 'parked-link');
    await runChecked('sudo', ['-n', '-u', 'nobody', 'ln', '-s', outsideFile, parked]);

    stableLink = path.join(allowed, 'stable-link.txt');
    await runChecked('sudo', ['-n', '-u', 'nobody', 'ln', '-s', outsideFile, stableLink]);

    const racerPath = path.join(root, 'racer.py');
    racerPidFile = path.join(allowed, 'racer.pid');
    await fs.writeFile(racerPath, RACER_SOURCE, { mode: 0o644 });
    racer = spawn(
      'sudo',
      ['-n', '-u', 'nobody', 'python3', '-u', racerPath, raceName, parked, racerPidFile],
      { stdio: 'ignore', detached: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(racer.exitCode, 'writer racer exited before the reads started').toBeNull();

    const serverPath = path.resolve(__dirname, '../dist/index.js');
    transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, allowed],
    });
    client = new Client({ name: 'symlink-swap-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    // The racer runs as nobody, so only root can signal it. sudo exits after
    // spawning it, which leaves the python process in its own session.
    if (racerPidFile) {
      const pid = await fs.readFile(racerPidFile, 'utf8').catch(() => '');
      if (pid.trim()) {
        await runCapture('sudo', ['-n', 'kill', '-9', pid.trim()]);
      }
    }
    if (racer && racer.pid) {
      try {
        process.kill(racer.pid, 'SIGKILL');
      } catch {
        // sudo has already exited.
      }
    }
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('the writer uid cannot read the outside file directly', async () => {
    const direct = await runCapture('sudo', ['-n', '-u', 'nobody', 'cat', outsideFile]);
    expect(direct.code).not.toBe(0);
    expect(direct.stderr).toMatch(/Permission denied/);
    expect(direct.stdout).not.toContain(SENTINEL);

    const serverUser = await fs.readFile(outsideFile, 'utf8');
    expect(serverUser).toContain(SENTINEL);
  });

  it('rejects a symlink that is already outside the allowlist at check time', async () => {
    const result = await client.callTool({
      name: 'read_text_file',
      arguments: { path: stableLink },
    });
    expect(payloadHasSentinel(result)).toBe(false);
    expect(JSON.stringify(result)).toMatch(/outside allowed directories/);
  });

  it('read_text_file does not return the outside file when the name is swapped after the check', async () => {
    await expectNoLeak('read_text_file', { path: raceName });
  }, 120_000);

  it('read_text_file head does not return the outside file when the name is swapped after the check', async () => {
    await expectNoLeak('read_text_file', { path: raceName, head: 5 });
  }, 120_000);

  it('read_text_file tail does not return the outside file when the name is swapped after the check', async () => {
    await expectNoLeak('read_text_file', { path: raceName, tail: 5 });
  }, 120_000);

  it('read_file does not return the outside file when the name is swapped after the check', async () => {
    await expectNoLeak('read_file', { path: raceName });
  }, 120_000);

  it('read_multiple_files does not return the outside file when the name is swapped after the check', async () => {
    await expectNoLeak('read_multiple_files', { paths: [raceName] });
  }, 120_000);

  it('read_media_file does not return the outside file when the name is swapped after the check', async () => {
    await expectNoLeak('read_media_file', { path: raceName });
  }, 120_000);

  it('edit_file dry run does not return the outside file when the name is swapped after the check', async () => {
    await expectNoLeak('edit_file', {
      path: raceName,
      edits: [{ oldText: '', newText: 'replaced-marker' }],
      dryRun: true,
    });
  }, 120_000);

  async function expectNoLeak(name: string, args: Record<string, unknown>): Promise<void> {
    expect(racer.exitCode, 'writer racer is not running').toBeNull();
    let leaks = 0;
    let sawSwappedName = false;
    let sample = '';
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      let result: unknown;
      try {
        result = await client.callTool({ name, arguments: args });
      } catch (error) {
        result = error instanceof Error ? error.message : String(error);
      }
      const raw = typeof result === 'string' ? result : JSON.stringify(result);
      if (payloadHasSentinel(result)) {
        leaks++;
        sample = raw;
        break;
      }
      // The name is being exchanged for the whole call. A run that only ever
      // reads the public file never exercised the window between check and open.
      if (raw.includes('outside allowed directories') || raw.includes('ELOOP') || raw.includes('ENOENT')) {
        sawSwappedName = true;
      }
    }
    expect(
      leaks,
      `${name} returned the outside file body. Sample: ${sample.slice(0, 240)}`,
    ).toBe(0);
    expect(
      sawSwappedName,
      `${name} never observed the swapped symlink, so the race was not exercised`,
    ).toBe(true);
  }
});

function runChecked(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr}`));
      }
    });
  });
}

function runCapture(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      resolve({ code, stdout, stderr });
    });
  });
}
