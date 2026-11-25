import chalk from 'chalk';

export interface ThoughtData {
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  isRevision?: boolean;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
  needsMoreThoughts?: boolean;
  nextThoughtNeeded: boolean;
}

export const MAX_THOUGHT_LENGTH = 100_000;
export const MAX_BRANCH_ID_LENGTH = 256;
// History is a sliding window: the oldest thought is dropped once this many are held.
export const MAX_RETAINED_THOUGHTS = 128;
// New branch ids are refused once this many branches are held; a branch is
// released when all of its thoughts have left the history window.
export const MAX_RETAINED_BRANCHES = 32;
// stderr writes to a pipe are queued in memory when the reader falls behind.
// Thought logs are skipped while this much output is still waiting, so a host
// that drains stderr slowly (or never) cannot make the queue grow without limit.
export const MAX_PENDING_LOG_LENGTH = 4 * MAX_THOUGHT_LENGTH;

export class SequentialThinkingServer {
  private thoughtHistory: ThoughtData[] = [];
  private branches = new Map<string, ThoughtData[]>();
  private disableThoughtLogging: boolean;

  constructor() {
    this.disableThoughtLogging = (process.env.DISABLE_THOUGHT_LOGGING || "").toLowerCase() === "true";
  }

  private formatThought(thoughtData: ThoughtData): string {
    const { thoughtNumber, totalThoughts, thought, isRevision, revisesThought, branchFromThought, branchId } = thoughtData;

    let prefix = '';
    let context = '';

    if (isRevision) {
      prefix = chalk.yellow('🔄 Revision');
      context = ` (revising thought ${revisesThought})`;
    } else if (branchFromThought) {
      prefix = chalk.green('🌿 Branch');
      context = ` (from thought ${branchFromThought}, ID: ${branchId})`;
    } else {
      prefix = chalk.blue('💭 Thought');
      context = '';
    }

    const header = `${prefix} ${thoughtNumber}/${totalThoughts}${context}`;
    const border = '─'.repeat(Math.max(header.length, thought.length) + 4);

    return `
┌${border}┐
│ ${header} │
├${border}┤
│ ${thought.padEnd(border.length - 2)} │
└${border}┘`;
  }

  private evictOldestThought(): void {
    const evicted = this.thoughtHistory.shift();
    if (!evicted?.branchFromThought || evicted.branchId === undefined) {
      return;
    }
    const branch = this.branches.get(evicted.branchId);
    if (!branch) {
      return;
    }
    const index = branch.indexOf(evicted);
    if (index !== -1) {
      branch.splice(index, 1);
    }
    if (branch.length === 0) {
      this.branches.delete(evicted.branchId);
    }
  }

  private failure(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: message,
          status: 'failed'
        }, null, 2)
      }],
      isError: true
    };
  }

  public processThought(input: ThoughtData): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
    try {
      // Enforced here as well as in the Zod schema so that nothing from an
      // oversized call is stored or formatted, whoever the caller is.
      if (typeof input.thought !== 'string' || input.thought.length > MAX_THOUGHT_LENGTH) {
        return this.failure(`thought must be a string of at most ${MAX_THOUGHT_LENGTH} characters`);
      }
      if (input.branchId !== undefined
        && (typeof input.branchId !== 'string' || input.branchId.length > MAX_BRANCH_ID_LENGTH)) {
        return this.failure(`branchId must be a string of at most ${MAX_BRANCH_ID_LENGTH} characters`);
      }

      const isBranchThought = Boolean(input.branchFromThought && input.branchId);
      if (isBranchThought
        && !this.branches.has(input.branchId!)
        && this.branches.size >= MAX_RETAINED_BRANCHES) {
        return this.failure(`at most ${MAX_RETAINED_BRANCHES} branches can be active at once`);
      }

      // Copy only the known fields so extra properties on the caller's object
      // are not retained.
      const record: ThoughtData = {
        thought: input.thought,
        thoughtNumber: input.thoughtNumber,
        // Adjust totalThoughts if thoughtNumber exceeds it
        totalThoughts: Math.max(input.totalThoughts, input.thoughtNumber),
        isRevision: input.isRevision,
        revisesThought: input.revisesThought,
        branchFromThought: input.branchFromThought,
        branchId: input.branchId,
        needsMoreThoughts: input.needsMoreThoughts,
        nextThoughtNeeded: input.nextThoughtNeeded,
      };

      this.thoughtHistory.push(record);

      if (isBranchThought) {
        const branch = this.branches.get(record.branchId!);
        if (branch) {
          branch.push(record);
        } else {
          this.branches.set(record.branchId!, [record]);
        }
      }

      while (this.thoughtHistory.length > MAX_RETAINED_THOUGHTS) {
        this.evictOldestThought();
      }

      if (!this.disableThoughtLogging && (process.stderr.writableLength ?? 0) <= MAX_PENDING_LOG_LENGTH) {
        const formattedThought = this.formatThought(record);
        console.error(formattedThought);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            thoughtNumber: record.thoughtNumber,
            totalThoughts: record.totalThoughts,
            nextThoughtNeeded: record.nextThoughtNeeded,
            branches: Array.from(this.branches.keys()),
            thoughtHistoryLength: this.thoughtHistory.length
          }, null, 2)
        }]
      };
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
  }
}
