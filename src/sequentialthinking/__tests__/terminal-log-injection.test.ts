/**
 * Spec for the stderr log of sequential thinking.
 *
 * Thought logging is on unless DISABLE_THOUGHT_LOGGING is "true". The thought
 * text and the branch id are written to stderr. Those fields must not contribute
 * C0 controls, DEL, or C1 controls to that stream (ESC, BEL, CR, NUL, 8-bit
 * CSI, and the rest). Line feeds the formatter and console.error add themselves
 * may remain. Printable text from the same fields must still be logged. The
 * raw fields may remain in memory and in the tool result.
 *
 * These tests fail while the log writes the fields unchanged.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Set before lib.ts loads chalk. chalk 5.6.2 reads FORCE_COLOR when its
// module is first evaluated (supports-color createSupportsColor). Level 0
// leaves the static prefix uncolored, so any ESC in the log comes from the
// thought or the branch id.
process.env.FORCE_COLOR = '0';

const ESC = '\u001b';
const BEL = '\u0007';
const CSI_8BIT = '\u009b';

/** Sequences named by the finding: clear/home, window title, clipboard OSC, CR, NUL, DEL, 8-bit CSI. */
const terminalPayload =
  `${ESC}[2J${ESC}[H` +
  `${ESC}]0;owned${BEL}` +
  `${ESC}]52;c;YQ==${BEL}` +
  '\r' +
  '\u0000' +
  '\u007f' +
  `${CSI_8BIT}31m`;

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(packageRoot, 'package.json'));
const tscPath = require.resolve('typescript/bin/tsc');

type ServerModule = typeof import('../lib.js');
type ThinkingServer = InstanceType<ServerModule['SequentialThinkingServer']>;
type ThoughtData = ServerModule['ThoughtData'];

let SequentialThinkingServer: ServerModule['SequentialThinkingServer'];

function nonPrintableCodePoints(text: string): number[] {
  const found: number[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    // U+000A is emitted by the box template and by console.error.
    if (cp === 0x0a) {
      continue;
    }
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      found.push(cp);
    }
  }
  return found;
}

function formatCodePoints(codePoints: number[]): string {
  return codePoints.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`).join(', ');
}

function assertLoggedThoughtIsSafe(logged: string, sentinels: string[]): void {
  if (!logged.includes('┌') && !/Thought|Revision|Branch/.test(logged)) {
    throw new Error('thought logging did not write the formatted thought to stderr');
  }
  for (const sentinel of sentinels) {
    if (!logged.includes(sentinel)) {
      throw new Error(`stderr log dropped printable text ${JSON.stringify(sentinel)}`);
    }
  }
  const bad = nonPrintableCodePoints(logged);
  if (bad.length > 0) {
    throw new Error(`stderr log contains non-printable code points: ${formatCodePoints(bad)}`);
  }
}

function captureConsoleErrorDuring(fn: () => void): string {
  // Vitest replaces console.error and reports it on its own stream, so hook
  // the function processThought actually calls. The tool test below reads the
  // child process stderr, which is the stream a terminal would be attached to.
  const original = console.error;
  let captured = '';
  console.error = (...args: unknown[]) => {
    captured += args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ');
    captured += '\n';
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return captured;
}

describe('processThought stderr sanitization', () => {
  let server: ThinkingServer;

  beforeAll(async () => {
    ({ SequentialThinkingServer } = await import('../lib.js'));
  });

  beforeEach(() => {
    delete process.env.DISABLE_THOUGHT_LOGGING;
    server = new SequentialThinkingServer();
  });

  it('logs a printable thought with no control characters', () => {
    const logged = captureConsoleErrorDuring(() => {
      const result = server.processThought({
        thought: 'PLAIN_SENTINEL',
        thoughtNumber: 1,
        totalThoughts: 1,
        nextThoughtNeeded: false,
      });
      expect(result.isError).toBeUndefined();
    });
    assertLoggedThoughtIsSafe(logged, ['PLAIN_SENTINEL']);
  });

  it('does not write terminal controls from a normal thought to stderr', () => {
    const logged = captureConsoleErrorDuring(() => {
      server.processThought({
        thought: `before ${terminalPayload} AFTER_NORMAL`,
        thoughtNumber: 1,
        totalThoughts: 1,
        nextThoughtNeeded: false,
      });
    });
    assertLoggedThoughtIsSafe(logged, ['before', 'AFTER_NORMAL']);
  });

  it('does not write terminal controls from a revision thought to stderr', () => {
    const logged = captureConsoleErrorDuring(() => {
      server.processThought({
        thought: `before ${terminalPayload} AFTER_REVISION`,
        thoughtNumber: 2,
        totalThoughts: 2,
        nextThoughtNeeded: false,
        isRevision: true,
        revisesThought: 1,
      });
    });
    assertLoggedThoughtIsSafe(logged, ['before', 'AFTER_REVISION']);
  });

  it('does not write terminal controls from a branch thought or branch id to stderr', () => {
    const logged = captureConsoleErrorDuring(() => {
      const result = server.processThought({
        thought: `before ${terminalPayload} AFTER_BRANCH_THOUGHT`,
        thoughtNumber: 2,
        totalThoughts: 2,
        nextThoughtNeeded: false,
        branchFromThought: 1,
        branchId: `id ${terminalPayload} AFTER_BRANCH_ID`,
      });
      const data = JSON.parse(result.content[0].text) as { branches: string[] };
      expect(data.branches.some((id) => id.includes('AFTER_BRANCH_ID'))).toBe(true);
    });
    assertLoggedThoughtIsSafe(logged, ['before', 'AFTER_BRANCH_THOUGHT', 'AFTER_BRANCH_ID']);
  });

  it('still logs when the thought is only terminal controls', () => {
    const logged = captureConsoleErrorDuring(() => {
      server.processThought({
        thought: terminalPayload,
        thoughtNumber: 1,
        totalThoughts: 1,
        nextThoughtNeeded: true,
      });
    });
    assertLoggedThoughtIsSafe(logged, []);
  });

  it('does not log the thought when DISABLE_THOUGHT_LOGGING is true', () => {
    process.env.DISABLE_THOUGHT_LOGGING = 'true';
    const quiet = new SequentialThinkingServer();
    const logged = captureConsoleErrorDuring(() => {
      quiet.processThought({
        thought: `before ${terminalPayload} QUIET_SENTINEL`,
        thoughtNumber: 1,
        totalThoughts: 1,
        nextThoughtNeeded: false,
        branchFromThought: 1,
        branchId: `id ${terminalPayload} QUIET_BRANCH`,
      });
    });
    expect(logged).toBe('');
  });
});

describe('sequentialthinking tool stderr sanitization', () => {
  let client: Client;
  let stderrChunks: Buffer[] = [];

  beforeAll(async () => {
    // Compile next to the package so Node can resolve dependencies and
    // version.ts can see package.json. This is not the published dist/.
    const outDir = path.join(packageRoot, '.terminal-test-build');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir);
    execFileSync(process.execPath, [
      tscPath,
      '-p', path.join(packageRoot, 'tsconfig.json'),
      '--outDir', outDir,
      '--rootDir', packageRoot,
    ], {
      cwd: packageRoot,
      stdio: 'inherit',
    });
    const distIndexPath = path.join(outDir, 'index.js');
    expect(existsSync(distIndexPath)).toBe(true);

    stderrChunks = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distIndexPath],
      cwd: packageRoot,
      stderr: 'pipe',
      env: {
        FORCE_COLOR: '0',
        DISABLE_THOUGHT_LOGGING: 'false',
      },
    });
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    client = new Client({ name: 'terminal-log-injection-test', version: '0.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(path.join(packageRoot, '.terminal-test-build'), { recursive: true, force: true });
  });

  function readStderr(): string {
    return Buffer.concat(stderrChunks).toString('utf8');
  }

  async function waitForLog(sentinel: string): Promise<string> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const logged = readStderr();
      if (logged.includes(sentinel)) {
        return logged;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return readStderr();
  }

  async function call(args: ThoughtData): Promise<void> {
    const result = await client.callTool({
      name: 'sequentialthinking',
      arguments: args,
    });
    expect(result.isError).toBeFalsy();
  }

  it('writes tool arguments to stderr without terminal controls', async () => {
    await call({
      thought: `before ${terminalPayload} TOOL_NORMAL`,
      thoughtNumber: 1,
      totalThoughts: 3,
      nextThoughtNeeded: true,
    });
    await call({
      thought: `before ${terminalPayload} TOOL_REVISION`,
      thoughtNumber: 2,
      totalThoughts: 3,
      nextThoughtNeeded: true,
      isRevision: true,
      revisesThought: 1,
    });
    const branched = await client.callTool({
      name: 'sequentialthinking',
      arguments: {
        thought: `before ${terminalPayload} TOOL_BRANCH_THOUGHT`,
        thoughtNumber: 3,
        totalThoughts: 3,
        nextThoughtNeeded: false,
        branchFromThought: 1,
        branchId: `id ${terminalPayload} TOOL_BRANCH_ID`,
      },
    });
    expect(branched.isError).toBeFalsy();
    const text = JSON.stringify(branched.content);
    expect(text).toContain('TOOL_BRANCH_ID');

    const logged = await waitForLog('TOOL_BRANCH_ID');
    assertLoggedThoughtIsSafe(logged, [
      'before',
      'TOOL_NORMAL',
      'TOOL_REVISION',
      'TOOL_BRANCH_THOUGHT',
      'TOOL_BRANCH_ID',
    ]);
  });
});
