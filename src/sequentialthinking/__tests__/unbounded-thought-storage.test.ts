import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SequentialThinkingServer } from '../lib.js';

// Resource bounds the sequential thinking server must enforce. A call that
// would exceed one of them is rejected, and nothing from that call is kept
// for the life of the process. Keeping the newest records and dropping the
// oldest is also acceptable for the count caps, as long as the retained
// count never goes above the cap.
export const MAX_THOUGHT_LENGTH = 100_000;
export const MAX_BRANCH_ID_LENGTH = 256;
export const MAX_RETAINED_THOUGHTS = 128;
export const MAX_RETAINED_BRANCHES = 32;

vi.mock('chalk', () => {
  const chalkMock = {
    yellow: (str: string) => str,
    green: (str: string) => str,
    blue: (str: string) => str,
  };
  return { default: chalkMock };
});

interface ThoughtInput {
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  nextThoughtNeeded: boolean;
  branchFromThought?: number;
  branchId?: string;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

function thoughtInput(thought: string, extra: Partial<ThoughtInput> = {}): ThoughtInput {
  return {
    thought,
    thoughtNumber: 1,
    totalThoughts: 1,
    nextThoughtNeeded: false,
    ...extra,
  };
}

function historyLength(result: { content: Array<{ text: string }> }): number {
  return JSON.parse(result.content[0].text).thoughtHistoryLength as number;
}

function branchIds(result: { content: Array<{ text: string }> }): string[] {
  return JSON.parse(result.content[0].text).branches as string[];
}

function collectGarbage(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error('global.gc is unavailable. Run node with --expose-gc (NODE_OPTIONS=--expose-gc).');
  }
  gc();
  gc();
}

function withHeapSnapshot(assertFn: (snapshot: string) => void): void {
  collectGarbage();
  const file = path.join(tmpdir(), `seq-think-${randomBytes(4).toString('hex')}.heapsnapshot`);
  v8.writeHeapSnapshot(file);
  try {
    assertFn(readFileSync(file, 'utf8'));
  } finally {
    unlinkSync(file);
  }
}

describe('SequentialThinkingServer resource bounds', () => {
  let server: SequentialThinkingServer;

  beforeEach(() => {
    process.env.DISABLE_THOUGHT_LOGGING = 'true';
    server = new SequentialThinkingServer();
  });

  describe('thought length', () => {
    it('accepts a thought at the maximum length', () => {
      const result = server.processThought(thoughtInput('a'.repeat(MAX_THOUGHT_LENGTH)));
      expect(result.isError).toBeUndefined();
      expect(historyLength(result)).toBe(1);
    });

    it('rejects a thought longer than the maximum', () => {
      const result = server.processThought(thoughtInput('a'.repeat(MAX_THOUGHT_LENGTH + 1)));
      expect(result.isError).toBe(true);
    });

    it('does not retain an overlong thought in history', () => {
      const first = server.processThought(thoughtInput('kept'));
      expect(first.isError).toBeUndefined();

      server.processThought(thoughtInput('b'.repeat(MAX_THOUGHT_LENGTH + 1)));

      const after = server.processThought(thoughtInput('after'));
      expect(after.isError).toBeUndefined();
      // The overlong call must not occupy a history slot, whether it was
      // rejected or the server tried to store it before refusing.
      expect(historyLength(after)).toBe(2);
    });

    it('does not retain the body of an overlong thought', () => {
      function submit(): void {
        const thought = ['OVERSIZE', 'BODY'].join('~') + 'A'.repeat(MAX_THOUGHT_LENGTH);
        server.processThought(thoughtInput(thought));
      }
      submit();

      withHeapSnapshot(snapshot => {
        const marker = ['OVERSIZE', 'BODY'].join('~');
        expect(snapshot.includes(marker)).toBe(false);
      });
    });
  });

  describe('branch id length', () => {
    it('accepts a branch id at the maximum length', () => {
      const branchId = 'b'.repeat(MAX_BRANCH_ID_LENGTH);
      const result = server.processThought(thoughtInput('branch', {
        branchFromThought: 1,
        branchId,
      }));
      expect(result.isError).toBeUndefined();
      expect(branchIds(result)).toEqual([branchId]);
    });

    it('rejects an overlong branch id and does not keep it as a branch key', () => {
      const overlong = 'c'.repeat(MAX_BRANCH_ID_LENGTH + 1);
      const rejected = server.processThought(thoughtInput('branch', {
        branchFromThought: 1,
        branchId: overlong,
      }));
      expect(rejected.isError).toBe(true);

      const after = server.processThought(thoughtInput('kept', {
        branchFromThought: 1,
        branchId: 'ok',
      }));
      expect(after.isError).toBeUndefined();
      expect(historyLength(after)).toBe(1);
      expect(branchIds(after)).toEqual(['ok']);
    });

    it('does not retain an overlong branch id on the stored thought', () => {
      function submit(): void {
        const branchId = ['BRANCH', 'KEY'].join('~') + 'd'.repeat(MAX_BRANCH_ID_LENGTH);
        server.processThought(thoughtInput('short', {
          branchFromThought: 1,
          branchId,
        }));
      }
      submit();

      withHeapSnapshot(snapshot => {
        const marker = ['BRANCH', 'KEY'].join('~');
        expect(snapshot.includes(marker)).toBe(false);
      });
    });

    it('does not retain an overlong branch id when it is not used as a branch key', () => {
      // branchFromThought is required before the id is inserted into the
      // branch map, but the whole input, including branchId, is still stored
      // on the history record. The length cap applies either way.
      function submit(): void {
        const branchId = ['BRANCH', 'FIELD'].join('~') + 'e'.repeat(MAX_BRANCH_ID_LENGTH);
        server.processThought(thoughtInput('short', { branchId }));
      }
      submit();

      withHeapSnapshot(snapshot => {
        const marker = ['BRANCH', 'FIELD'].join('~');
        expect(snapshot.includes(marker)).toBe(false);
      });
    });
  });

  describe('retained thought and branch counts', () => {
    it('accepts a full history of retained thoughts', () => {
      for (let i = 1; i <= MAX_RETAINED_THOUGHTS; i++) {
        const result = server.processThought(thoughtInput(`thought-${i}`, {
          thoughtNumber: i,
          totalThoughts: i,
          nextThoughtNeeded: i < MAX_RETAINED_THOUGHTS,
        }));
        expect(result.isError).toBeUndefined();
        expect(historyLength(result)).toBe(i);
      }
    });

    it('does not report a history longer than the cap', () => {
      for (let i = 1; i <= MAX_RETAINED_THOUGHTS; i++) {
        const result = server.processThought(thoughtInput(`thought-${i}`, {
          thoughtNumber: i,
          totalThoughts: i,
        }));
        expect(result.isError).toBeUndefined();
      }

      const extra = server.processThought(thoughtInput('one-more', {
        thoughtNumber: MAX_RETAINED_THOUGHTS + 1,
        totalThoughts: MAX_RETAINED_THOUGHTS + 1,
      }));
      if (!extra.isError) {
        expect(historyLength(extra)).toBeLessThanOrEqual(MAX_RETAINED_THOUGHTS);
      }

      const probe = server.processThought(thoughtInput('probe', {
        thoughtNumber: 1,
        totalThoughts: 1,
      }));
      if (!probe.isError) {
        expect(historyLength(probe)).toBeLessThanOrEqual(MAX_RETAINED_THOUGHTS);
      }
    });

    it('does not retain thought bodies beyond the cap on a single branch', () => {
      const prefix = ['retain', randomBytes(8).toString('hex')].join('-');
      const total = MAX_RETAINED_THOUGHTS + 8;

      function fill(): void {
        for (let i = 0; i < total; i++) {
          const thought = [prefix, String(i), 'END'].join('~') + 'y'.repeat(24);
          server.processThought(thoughtInput(thought, {
            thoughtNumber: i + 1,
            totalThoughts: i + 1,
            nextThoughtNeeded: true,
            branchFromThought: 1,
            branchId: 'only-branch',
          }));
        }
      }
      fill();

      withHeapSnapshot(snapshot => {
        let retained = 0;
        for (let i = 0; i < total; i++) {
          const token = [prefix, String(i), 'END'].join('~');
          if (snapshot.includes(token)) retained++;
        }
        expect(retained).toBeLessThanOrEqual(MAX_RETAINED_THOUGHTS);
      });
    });

    it('accepts the maximum number of branches', () => {
      for (let i = 1; i <= MAX_RETAINED_BRANCHES; i++) {
        const result = server.processThought(thoughtInput(`branch-thought-${i}`, {
          thoughtNumber: i,
          totalThoughts: i,
          branchFromThought: 1,
          branchId: `branch-${i}`,
        }));
        expect(result.isError).toBeUndefined();
        expect(branchIds(result)).toHaveLength(i);
      }
    });

    it('does not retain more branch ids than the cap', () => {
      for (let i = 1; i <= MAX_RETAINED_BRANCHES; i++) {
        const result = server.processThought(thoughtInput(`branch-thought-${i}`, {
          thoughtNumber: i,
          totalThoughts: i,
          branchFromThought: 1,
          branchId: `branch-${i}`,
        }));
        expect(result.isError).toBeUndefined();
      }

      const extraId = `branch-${MAX_RETAINED_BRANCHES + 1}`;
      const extra = server.processThought(thoughtInput('extra-branch', {
        thoughtNumber: MAX_RETAINED_BRANCHES + 1,
        totalThoughts: MAX_RETAINED_BRANCHES + 1,
        branchFromThought: 1,
        branchId: extraId,
      }));
      if (!extra.isError) {
        expect(branchIds(extra).length).toBeLessThanOrEqual(MAX_RETAINED_BRANCHES);
      }

      // A thought on a branch that was already accepted must still be stored,
      // and the rejected id must not appear in the retained set.
      const probe = server.processThought(thoughtInput('existing-branch', {
        thoughtNumber: MAX_RETAINED_BRANCHES + 2,
        totalThoughts: MAX_RETAINED_BRANCHES + 2,
        branchFromThought: 1,
        branchId: 'branch-1',
      }));
      expect(probe.isError).toBeUndefined();
      const ids = branchIds(probe);
      expect(ids.length).toBeLessThanOrEqual(MAX_RETAINED_BRANCHES);
      expect(ids).not.toContain(extraId);
      expect(ids).toContain('branch-1');
    });
  });

  describe('logging border', () => {
    let loggingServer: SequentialThinkingServer;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      delete process.env.DISABLE_THOUGHT_LOGGING;
      loggingServer = new SequentialThinkingServer();
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
      process.env.DISABLE_THOUGHT_LOGGING = 'true';
    });

    function loggedText(): string {
      return errorSpy.mock.calls.map(args => args.map(arg => String(arg)).join(' ')).join('\n');
    }

    it('still accepts a maximum-length thought when logging is enabled', () => {
      const result = loggingServer.processThought(thoughtInput('m'.repeat(MAX_THOUGHT_LENGTH)));
      expect(result.isError).toBeUndefined();
      expect(historyLength(result)).toBe(1);
    });

    it('does not log a border as long as an overlong thought', () => {
      const thought = 'T'.repeat(MAX_THOUGHT_LENGTH + 1);
      const result = loggingServer.processThought(thoughtInput(thought));
      expect(loggedText().length).toBeLessThan(thought.length);
      expect(result.isError).toBe(true);
    });

    it('does not log a border as long as an overlong branch id', () => {
      const branchId = 'B'.repeat(MAX_BRANCH_ID_LENGTH + 1);
      const result = loggingServer.processThought(thoughtInput('short', {
        branchFromThought: 1,
        branchId,
      }));
      expect(loggedText().length).toBeLessThan(branchId.length);
      expect(result.isError).toBe(true);
    });

    it('does not keep an overlong thought that was formatted before refusal', () => {
      function submit(): void {
        const thought = ['LOGGED', 'BODY'].join('~') + 'L'.repeat(MAX_THOUGHT_LENGTH);
        loggingServer.processThought(thoughtInput(thought));
      }
      submit();
      errorSpy.mockClear();

      withHeapSnapshot(snapshot => {
        const marker = ['LOGGED', 'BODY'].join('~');
        expect(snapshot.includes(marker)).toBe(false);
      });
    });
  });
});

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distIndexPath = path.join(packageRoot, 'dist', 'index.js');

describe('sequentialthinking stdio tool resource bounds', () => {
  async function withClient(
    env: Record<string, string> | undefined,
    run: (client: Client, stderrBytes: () => number) => Promise<void>,
  ): Promise<void> {
    expect(existsSync(distIndexPath), `${distIndexPath} is missing; build the package before this test`).toBe(true);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distIndexPath],
      cwd: packageRoot,
      stderr: 'pipe',
      env,
    });
    let stderrByteCount = 0;
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrByteCount += chunk.length;
    });
    const client = new Client({ name: 'unbounded-thought-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      await run(client, () => stderrByteCount);
    } finally {
      await client.close();
    }
  }

  async function callTool(client: Client, extra: Record<string, unknown>): Promise<ToolResult> {
    const result = await client.callTool({
      name: 'sequentialthinking',
      arguments: {
        thought: 't',
        nextThoughtNeeded: false,
        thoughtNumber: 1,
        totalThoughts: 1,
        ...extra,
      },
    });
    return result as ToolResult;
  }

  it('rejects an overlong thought and does not retain it', async () => {
    await withClient(undefined, async client => {
      const first = await callTool(client, { thought: 'kept', thoughtNumber: 1 });
      expect(first.isError).toBeFalsy();

      const rejected = await callTool(client, {
        thought: 'a'.repeat(MAX_THOUGHT_LENGTH + 1),
        thoughtNumber: 2,
      });
      expect(rejected.isError).toBe(true);

      const after = await callTool(client, { thought: 'after', thoughtNumber: 3 });
      expect(after.isError).toBeFalsy();
      expect(historyLength(after as { content: Array<{ text: string }> })).toBe(2);
    });
  }, 30_000);

  it('rejects a one-megabyte thought and does not log a border that long', async () => {
    await withClient(undefined, async (client, stderrBytes) => {
      const thought = 'M'.repeat(1_000_000);
      const before = stderrBytes();
      const rejected = await callTool(client, { thought, thoughtNumber: 1 });
      // The formatted border is written to stderr before the tool response,
      // and the pipe delivers it asynchronously. Stop once it exceeds the
      // thought or the pipe has been quiet for 300ms.
      let loggedBytes = stderrBytes() - before;
      let lastChange = Date.now();
      const started = Date.now();
      while (Date.now() - started < 3_000) {
        if (loggedBytes >= thought.length) break;
        await new Promise(resolve => setTimeout(resolve, 20));
        const next = stderrBytes() - before;
        if (next !== loggedBytes) lastChange = Date.now();
        loggedBytes = next;
        if (Date.now() - lastChange > 300) break;
      }
      expect(loggedBytes).toBeLessThan(thought.length);
      expect(rejected.isError).toBe(true);

      const after = await callTool(client, { thought: 'after', thoughtNumber: 2 });
      expect(after.isError).toBeFalsy();
      expect(historyLength(after as { content: Array<{ text: string }> })).toBe(1);
    });
  }, 30_000);

  it('rejects an overlong branch id and does not list it', async () => {
    await withClient(undefined, async client => {
      const overlong = 'b'.repeat(MAX_BRANCH_ID_LENGTH + 1);
      const rejected = await callTool(client, {
        thought: 'branch',
        thoughtNumber: 1,
        branchFromThought: 1,
        branchId: overlong,
      });
      expect(rejected.isError).toBe(true);

      const after = await callTool(client, {
        thought: 'kept',
        thoughtNumber: 2,
        branchFromThought: 1,
        branchId: 'ok',
      });
      expect(after.isError).toBeFalsy();
      const body = after as { content: Array<{ text: string }> };
      expect(historyLength(body)).toBe(1);
      expect(branchIds(body)).toEqual(['ok']);
    });
  }, 30_000);

  it('rejects an overlong branch id that is not a branch key and does not retain the call', async () => {
    await withClient(undefined, async client => {
      const rejected = await callTool(client, {
        thought: 'plain',
        thoughtNumber: 1,
        branchId: 'c'.repeat(MAX_BRANCH_ID_LENGTH + 1),
      });
      expect(rejected.isError).toBe(true);

      const after = await callTool(client, { thought: 'after', thoughtNumber: 2 });
      expect(after.isError).toBeFalsy();
      expect(historyLength(after as { content: Array<{ text: string }> })).toBe(1);
    });
  }, 30_000);

  it('does not let history grow past the cap when logging is disabled', async () => {
    await withClient({ DISABLE_THOUGHT_LOGGING: 'true' }, async client => {
      for (let i = 1; i <= MAX_RETAINED_THOUGHTS; i++) {
        const result = await callTool(client, {
          thought: `thought-${i}`,
          thoughtNumber: i,
          totalThoughts: i,
          nextThoughtNeeded: true,
        });
        expect(result.isError).toBeFalsy();
        expect(historyLength(result as { content: Array<{ text: string }> })).toBe(i);
      }

      const extra = await callTool(client, {
        thought: 'one-more',
        thoughtNumber: MAX_RETAINED_THOUGHTS + 1,
        totalThoughts: MAX_RETAINED_THOUGHTS + 1,
      });
      if (!extra.isError) {
        expect(historyLength(extra as { content: Array<{ text: string }> })).toBeLessThanOrEqual(MAX_RETAINED_THOUGHTS);
      }

      const probe = await callTool(client, { thought: 'probe', thoughtNumber: 1, totalThoughts: 1 });
      if (!probe.isError) {
        expect(historyLength(probe as { content: Array<{ text: string }> })).toBeLessThanOrEqual(MAX_RETAINED_THOUGHTS);
      }
    });
  }, 30_000);

  it('does not keep more branches than the cap', async () => {
    await withClient({ DISABLE_THOUGHT_LOGGING: 'true' }, async client => {
      for (let i = 1; i <= MAX_RETAINED_BRANCHES; i++) {
        const result = await callTool(client, {
          thought: `branch-thought-${i}`,
          thoughtNumber: i,
          totalThoughts: i,
          branchFromThought: 1,
          branchId: `branch-${i}`,
        });
        expect(result.isError).toBeFalsy();
        expect(branchIds(result as { content: Array<{ text: string }> })).toHaveLength(i);
      }

      const extraId = `branch-${MAX_RETAINED_BRANCHES + 1}`;
      const extra = await callTool(client, {
        thought: 'extra-branch',
        thoughtNumber: MAX_RETAINED_BRANCHES + 1,
        totalThoughts: MAX_RETAINED_BRANCHES + 1,
        branchFromThought: 1,
        branchId: extraId,
      });
      if (!extra.isError) {
        expect(branchIds(extra as { content: Array<{ text: string }> }).length).toBeLessThanOrEqual(MAX_RETAINED_BRANCHES);
      }

      const probe = await callTool(client, {
        thought: 'existing-branch',
        thoughtNumber: MAX_RETAINED_BRANCHES + 2,
        totalThoughts: MAX_RETAINED_BRANCHES + 2,
        branchFromThought: 1,
        branchId: 'branch-1',
      });
      expect(probe.isError).toBeFalsy();
      const ids = branchIds(probe as { content: Array<{ text: string }> });
      expect(ids.length).toBeLessThanOrEqual(MAX_RETAINED_BRANCHES);
      expect(ids).not.toContain(extraId);
      expect(ids).toContain('branch-1');
    });
  }, 30_000);
});
