import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, readFileSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Spec for the filesystem image: host bind-mount writes must not run as uid 0.
 *
 * The documented launch bind-mounts a host directory at /projects/workspace and
 * starts this image with /projects as the allowed root. These tests build
 * src/filesystem/Dockerfile and call the mutating tools over stdio. They fail
 * while that process is root, because created files are owned by uid 0 and
 * writes into a root-owned directory succeed.
 *
 * The builder image's npm (10.9.0 on node:22.12-alpine, and 10.9.9 on
 * node:22-alpine) crashes in Arborist #loadPeerSet while resolving this
 * package's current tree (edgesOut of null). The test therefore generates a
 * package-lock.json with npm 11.6.2 and leaves it in the build context only.
 * The Dockerfile itself is unchanged. That lockfile is what lets `npm install`
 * and `npm ci` inside the Dockerfile finish; it does not set a user.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dockerfile = path.join(repoRoot, 'src/filesystem/Dockerfile');
const image = 'mcp/filesystem:nonroot-write-spec';
const containerRoot = '/projects/workspace';

let buildContext = '';

type ToolResult = {
  isError?: boolean;
  content?: { type: string; text?: string }[];
};

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sudo(args: string[]): void {
  execFileSync('sudo', args, { stdio: 'inherit' });
}

function buildImage(): void {
  buildContext = mkdtempSync(path.join(tmpdir(), 'mcp-fs-image-'));
  const packageDir = path.join(buildContext, 'src/filesystem');
  mkdirSync(packageDir, { recursive: true });
  cpSync(path.join(repoRoot, 'src/filesystem'), packageDir, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return base !== 'node_modules' && base !== 'dist' && base !== 'package-lock.json';
    },
  });
  cpSync(path.join(repoRoot, 'tsconfig.json'), path.join(buildContext, 'tsconfig.json'));

  // Produce a lockfile the Dockerfile's npm 10.9.0 can install. See the file comment.
  run('docker', [
    'run', '--rm',
    '-v', `${packageDir}:/app`,
    '-w', '/app',
    'node:22-alpine',
    'sh', '-c',
    'npm install -g npm@11.6.2 && npm install --package-lock-only --ignore-scripts',
  ]);
  sudo(['rm', '-rf', path.join(packageDir, 'node_modules')]);

  run('docker', [
    'build',
    '-t', image,
    '-f', dockerfile,
    buildContext,
  ], { DOCKER_BUILDKIT: '1' });
}

function hostOwner(filePath: string): number {
  return statSync(filePath).uid;
}

function containerPath(...parts: string[]): string {
  return path.posix.join(containerRoot, ...parts);
}

async function withServer(
  prepare: (host: string) => void,
  body: (client: Client, host: string) => Promise<void>,
): Promise<void> {
  const host = mkdtempSync(path.join(tmpdir(), 'mcp-fs-mount-'));
  try {
    prepare(host);
    const transport = new StdioClientTransport({
      command: 'docker',
      args: [
        'run',
        '-i',
        '--rm',
        '--mount', `type=bind,src=${host},dst=${containerRoot}`,
        image,
        '/projects',
      ],
      stderr: 'inherit',
    });
    const client = new Client({ name: 'root-write-spec', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      await body(client, host);
    } finally {
      await client.close();
    }
  } finally {
    sudo(['rm', '-rf', host]);
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return await client.callTool({ name, arguments: args }) as ToolResult;
}

describe('filesystem container bind-mount writes are not root', () => {
  beforeAll(() => {
    buildImage();
  }, 300_000);

  afterAll(() => {
    if (buildContext) {
      sudo(['rm', '-rf', buildContext]);
    }
  });

  it('creates a new file via write_file as a non-root uid', async () => {
    await withServer((host) => {
      mkdirSync(path.join(host, 'open'));
      chmodSync(path.join(host, 'open'), 0o777);
    }, async (client, host) => {
      const result = await callTool(client, 'write_file', {
        path: containerPath('open', 'created.txt'),
        content: 'attacker-created',
      });
      const created = path.join(host, 'open', 'created.txt');
      expect(result.isError).not.toBe(true);
      expect(readFileSync(created, 'utf8')).toBe('attacker-created');
      expect(hostOwner(created)).not.toBe(0);
    });
  }, 60_000);

  it('replaces an existing file via write_file without taking root ownership', async () => {
    await withServer((host) => {
      mkdirSync(path.join(host, 'open'));
      writeFileSync(path.join(host, 'open', 'existing.txt'), 'ORIGINAL');
      chmodSync(path.join(host, 'open'), 0o777);
    }, async (client, host) => {
      const result = await callTool(client, 'write_file', {
        path: containerPath('open', 'existing.txt'),
        content: 'REPLACED',
      });
      const target = path.join(host, 'open', 'existing.txt');
      expect(result.isError).not.toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('REPLACED');
      expect(hostOwner(target)).not.toBe(0);
      expect(readdirSync(path.join(host, 'open')).filter((name) => name.includes('.tmp'))).toEqual([]);
    });
  }, 60_000);

  it('replaces an existing file via edit_file without taking root ownership', async () => {
    await withServer((host) => {
      mkdirSync(path.join(host, 'open'));
      writeFileSync(path.join(host, 'open', 'notes.txt'), 'ORIGINAL');
      chmodSync(path.join(host, 'open'), 0o777);
    }, async (client, host) => {
      const result = await callTool(client, 'edit_file', {
        path: containerPath('open', 'notes.txt'),
        edits: [{ oldText: 'ORIGINAL', newText: 'EDITED' }],
      });
      const target = path.join(host, 'open', 'notes.txt');
      expect(result.isError).not.toBe(true);
      expect(readFileSync(target, 'utf8')).toContain('EDITED');
      expect(hostOwner(target)).not.toBe(0);
      expect(readdirSync(path.join(host, 'open')).filter((name) => name.includes('.tmp'))).toEqual([]);
    });
  }, 60_000);

  it('creates directories via create_directory as a non-root uid', async () => {
    await withServer((host) => {
      mkdirSync(path.join(host, 'open'));
      chmodSync(path.join(host, 'open'), 0o777);
    }, async (client, host) => {
      const result = await callTool(client, 'create_directory', {
        path: containerPath('open', 'made', 'nested'),
      });
      const made = path.join(host, 'open', 'made');
      const nested = path.join(made, 'nested');
      expect(result.isError).not.toBe(true);
      expect(statSync(nested).isDirectory()).toBe(true);
      expect(hostOwner(made)).not.toBe(0);
      expect(hostOwner(nested)).not.toBe(0);
    });
  }, 60_000);

  it('refuses write_file in a directory the host user cannot write, and creates nothing', async () => {
    await withServer((host) => {
      mkdirSync(path.join(host, 'locked'));
      sudo(['chown', 'root:root', path.join(host, 'locked')]);
      sudo(['chmod', '755', path.join(host, 'locked')]);
    }, async (client, host) => {
      const before = readdirSync(path.join(host, 'locked'));
      const result = await callTool(client, 'write_file', {
        path: containerPath('locked', 'pwned.txt'),
        content: 'should-not-land',
      });
      expect(readdirSync(path.join(host, 'locked'))).toEqual(before);
      expect(result.isError).toBe(true);
    });
  }, 60_000);

  it('refuses write_file replacement of a root-owned file in a root-owned directory', async () => {
    await withServer((host) => {
      const locked = path.join(host, 'locked');
      mkdirSync(locked);
      writeFileSync(path.join(locked, 'protected.txt'), 'PROTECTED');
      sudo(['chown', '-R', 'root:root', locked]);
      sudo(['chmod', '755', locked]);
      sudo(['chmod', '644', path.join(locked, 'protected.txt')]);
    }, async (client, host) => {
      const target = path.join(host, 'locked', 'protected.txt');
      const result = await callTool(client, 'write_file', {
        path: containerPath('locked', 'protected.txt'),
        content: 'OVERWRITTEN',
      });
      expect(readFileSync(target, 'utf8')).toBe('PROTECTED');
      expect(readdirSync(path.join(host, 'locked')).filter((name) => name.includes('.tmp'))).toEqual([]);
      expect(result.isError).toBe(true);
    });
  }, 60_000);

  it('refuses edit_file of a root-owned file in a root-owned directory and leaves no temp file', async () => {
    await withServer((host) => {
      const locked = path.join(host, 'locked');
      mkdirSync(locked);
      writeFileSync(path.join(locked, 'protected.txt'), 'PROTECTED');
      sudo(['chown', '-R', 'root:root', locked]);
      sudo(['chmod', '755', locked]);
      sudo(['chmod', '644', path.join(locked, 'protected.txt')]);
    }, async (client, host) => {
      const target = path.join(host, 'locked', 'protected.txt');
      const result = await callTool(client, 'edit_file', {
        path: containerPath('locked', 'protected.txt'),
        edits: [{ oldText: 'PROTECTED', newText: 'TAMPERED' }],
      });
      expect(readFileSync(target, 'utf8')).toBe('PROTECTED');
      expect(readdirSync(path.join(host, 'locked')).filter((name) => name.includes('.tmp'))).toEqual([]);
      expect(result.isError).toBe(true);
    });
  }, 60_000);

  it('refuses create_directory inside a root-owned directory and creates nothing', async () => {
    await withServer((host) => {
      mkdirSync(path.join(host, 'locked'));
      sudo(['chown', 'root:root', path.join(host, 'locked')]);
      sudo(['chmod', '755', path.join(host, 'locked')]);
    }, async (client, host) => {
      const result = await callTool(client, 'create_directory', {
        path: containerPath('locked', 'nested', 'deep'),
      });
      expect(readdirSync(path.join(host, 'locked'))).toEqual([]);
      expect(result.isError).toBe(true);
    });
  }, 60_000);

  it('refuses move_file into a root-owned directory and leaves the source in place', async () => {
    await withServer((host) => {
      mkdirSync(path.join(host, 'open'));
      writeFileSync(path.join(host, 'open', 'to-move.txt'), 'MOVE-ME');
      chmodSync(path.join(host, 'open'), 0o777);
      mkdirSync(path.join(host, 'locked'));
      sudo(['chown', 'root:root', path.join(host, 'locked')]);
      sudo(['chmod', '755', path.join(host, 'locked')]);
    }, async (client, host) => {
      const result = await callTool(client, 'move_file', {
        source: containerPath('open', 'to-move.txt'),
        destination: containerPath('locked', 'to-move.txt'),
      });
      expect(readdirSync(path.join(host, 'locked'))).toEqual([]);
      expect(readFileSync(path.join(host, 'open', 'to-move.txt'), 'utf8')).toBe('MOVE-ME');
      expect(result.isError).toBe(true);
    });
  }, 60_000);
});
