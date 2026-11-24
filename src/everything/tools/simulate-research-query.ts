import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolResult,
  GetTaskResult,
  Task,
  ElicitResult,
  ElicitResultSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CreateTaskResult,
  isTerminal,
} from "@modelcontextprotocol/sdk/experimental/tasks";
import { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";

// Bounds on caller-controlled state held by a single session
const MAX_TOPIC_LENGTH = 8192;
const MAX_INFLIGHT_TASKS = 8;

// Tool input schema
const SimulateResearchQuerySchema = z.object({
  topic: z
    .string()
    .max(MAX_TOPIC_LENGTH)
    .describe("The research topic to investigate"),
  ambiguous: z
    .boolean()
    .default(false)
    .describe(
      "Simulate an ambiguous query that requires clarification (triggers input_required status)"
    ),
});

// Research stages
const STAGES = [
  "Gathering sources",
  "Analyzing content",
  "Synthesizing findings",
  "Generating report",
];

// Duration per stage in milliseconds
const STAGE_DURATION = 1000;

// Internal state for tracking research tasks
interface ResearchState {
  topic: string;
  ambiguous: boolean;
  currentStage: number;
  clarification?: string;
  abortController: AbortController;
}

// In-flight research tasks, scoped to the server (one per session) that created them.
// Entries live only while the background process runs; results are held by the task store.
const researchTasksByServer = new WeakMap<McpServer, Set<ResearchState>>();

/**
 * Stops every in-flight research task created through the given server and releases
 * its state. Called from the server's session cleanup.
 *
 * @param {McpServer} server - The server whose research tasks should be stopped.
 */
export const stopResearchTasks = (server: McpServer) => {
  const tasks = researchTasksByServer.get(server);
  if (!tasks) return;
  for (const state of tasks) {
    state.abortController.abort();
  }
  tasks.clear();
};

/**
 * Resolves after `ms` milliseconds, or immediately once `signal` aborts.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Returns true once the task has reached a terminal status (e.g. cancelled by the client).
 */
async function isTaskFinished(
  taskStore: RequestTaskStore,
  taskId: string
): Promise<boolean> {
  const task: Task | undefined = await taskStore.getTask(taskId);
  return !!task && isTerminal(task.status);
}

/**
 * Runs the background research process.
 * Updates task status as it progresses through stages.
 * If clarification is needed, sends elicitation via sendRequest with relatedTask,
 * which queues the request in the task message queue. The SDK delivers it through
 * the tasks/result stream when the client calls tasks/result (per spec input_required flow).
 * This works on all transports (STDIO, SSE, Streamable HTTP).
 */
async function runResearchProcess(
  taskId: string,
  state: ResearchState,
  taskStore: RequestTaskStore,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendRequest: any
): Promise<void> {
  const { signal } = state.abortController;

  // Process each stage
  for (let i = state.currentStage; i < STAGES.length; i++) {
    state.currentStage = i;

    // Stop if the session ended or the client cancelled the task
    if (signal.aborted || (await isTaskFinished(taskStore, taskId))) return;

    // Update status message for current stage
    await taskStore.updateTaskStatus(taskId, "working", `${STAGES[i]}...`);

    // At synthesis stage (index 2), check if clarification is needed
    if (i === 2 && state.ambiguous && !state.clarification) {
      // Update status to show we're requesting input (spec SHOULD)
      await taskStore.updateTaskStatus(
        taskId,
        "input_required",
        `Found multiple interpretations for "${state.topic}". Requesting clarification...`
      );

      try {
        // relatedTask queues elicitation via task message queue → delivered through tasks/result on all transports
        const elicitResult: ElicitResult = await sendRequest(
          {
            method: "elicitation/create",
            params: {
              message: `The research query "${state.topic}" could have multiple interpretations. Please clarify what you're looking for:`,
              requestedSchema: {
                type: "object",
                properties: {
                  interpretation: {
                    type: "string",
                    title: "Clarification",
                    description:
                      "Which interpretation of the topic do you mean?",
                    oneOf: getInterpretationsForTopic(state.topic),
                  },
                },
                required: ["interpretation"],
              },
            },
          },
          ElicitResultSchema,
          { relatedTask: { taskId }, signal }
        );

        // Process elicitation response
        if (elicitResult.action === "accept" && elicitResult.content) {
          state.clarification =
            (elicitResult.content as { interpretation?: string })
              .interpretation || "User accepted without selection";
        } else if (elicitResult.action === "decline") {
          state.clarification = "User declined - using default interpretation";
        } else {
          state.clarification = "User cancelled - using default interpretation";
        }
      } catch (error) {
        if (signal.aborted) return;
        // Elicitation failed - use default interpretation and continue
        console.warn(
          `Elicitation failed for task ${taskId}:`,
          error instanceof Error ? error.message : String(error)
        );
        state.clarification = "technical (default - elicitation unavailable)";
      }

      // Resume with working status (spec SHOULD)
      await taskStore.updateTaskStatus(
        taskId,
        "working",
        `Continuing with interpretation: "${state.clarification}"...`
      );

      // Continue processing (no return - just keep going through the loop)
    }

    // Simulate work for this stage
    await sleep(STAGE_DURATION, signal);
  }

  if (signal.aborted || (await isTaskFinished(taskStore, taskId))) return;

  // All stages complete - generate result
  await taskStore.storeTaskResult(
    taskId,
    "completed",
    generateResearchReport(state)
  );
}

/**
 * Generates the final research report with educational content about tasks.
 */
function generateResearchReport(state: ResearchState): CallToolResult {
  const topic = state.clarification
    ? `${state.topic} (${state.clarification})`
    : state.topic;

  const report = `# Research Report: ${topic}

## Research Parameters
- **Topic**: ${state.topic}
${state.clarification ? `- **Clarification**: ${state.clarification}` : ""}

## Synthesis
This research query was processed through ${STAGES.length} stages:
${STAGES.map((s, i) => `- Stage ${i + 1}: ${s} ✓`).join("\n")}

---

## About This Demo (SEP-1686: Tasks)

This tool demonstrates MCP's task-based execution pattern for long-running operations:

**Task Lifecycle Demonstrated:**
1. \`tools/call\` with \`task\` parameter → Server returns \`CreateTaskResult\` (not the final result)
2. Client polls \`tasks/get\` → Server returns current status and \`statusMessage\`
3. Status progressed: \`working\` → ${
    state.clarification ? `\`input_required\` → \`working\` → ` : ""
  }\`completed\`
4. Client calls \`tasks/result\` → Server returns this final result

${
  state.clarification
    ? `**Elicitation Flow:**
When the query was ambiguous, the server sent an \`elicitation/create\` request
to the client. The task status changed to \`input_required\` while awaiting user input.
${
  state.clarification.includes("unavailable")
    ? `**Note:** Elicitation failed and a default interpretation was used.`
    : `After receiving clarification ("${state.clarification}"), the task resumed processing and completed.`
}
`
    : ""
}
**Key Concepts:**
- Tasks enable "call now, fetch later" patterns
- \`statusMessage\` provides human-readable progress updates
- Tasks have TTL (time-to-live) for automatic cleanup
- \`pollInterval\` suggests how often to check status
- Elicitation requests use \`relatedTask\` to queue via tasks/result (works on all transports)

*This is a simulated research report from the Everything MCP Server.*
`;

  return {
    content: [
      {
        type: "text",
        text: report,
      },
    ],
  };
}

/**
 * Registers the 'simulate-research-query' tool as a task-based tool.
 *
 * This tool demonstrates the MCP Tasks feature (SEP-1686) with a real-world scenario:
 * a research tool that gathers and synthesizes information from multiple sources.
 * If the query is ambiguous, it pauses to ask for clarification before completing.
 *
 * @param {McpServer} server - The McpServer instance where the tool will be registered.
 */
export const registerSimulateResearchQueryTool = (server: McpServer) => {
  // Check if client supports elicitation (needed for input_required flow)
  const clientCapabilities = server.server.getClientCapabilities() || {};
  const clientSupportsElicitation: boolean =
    clientCapabilities.elicitation !== undefined;

  const inflightTasks =
    researchTasksByServer.get(server) ?? new Set<ResearchState>();
  researchTasksByServer.set(server, inflightTasks);

  server.experimental.tasks.registerToolTask(
    "simulate-research-query",
    {
      title: "Simulate Research Query",
      description:
        "Simulates a deep research operation that gathers, analyzes, and synthesizes information. " +
        "Demonstrates MCP task-based operations with progress through multiple stages. " +
        "If 'ambiguous' is true and client supports elicitation, sends an elicitation request for clarification.",
      inputSchema: SimulateResearchQuerySchema,
      execution: { taskSupport: "required" },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      /**
       * Creates a new research task and starts background processing.
       */
      createTask: async (args, extra): Promise<CreateTaskResult> => {
        const validatedArgs = SimulateResearchQuerySchema.parse(args);

        // The slot must be reserved before the first await so concurrent calls cannot exceed the cap
        if (inflightTasks.size >= MAX_INFLIGHT_TASKS) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Too many research tasks in progress (maximum ${MAX_INFLIGHT_TASKS} per session). Wait for one to finish or cancel it.`
          );
        }
        const state: ResearchState = {
          topic: validatedArgs.topic,
          ambiguous: validatedArgs.ambiguous && clientSupportsElicitation,
          currentStage: 0,
          abortController: new AbortController(),
        };
        inflightTasks.add(state);

        let task;
        try {
          task = await extra.taskStore.createTask({
            ttl: 300000, // 5 minutes
            pollInterval: 1000,
          });
        } catch (error) {
          inflightTasks.delete(state);
          throw error;
        }
        const { taskId } = task;

        // Start background research (don't await - runs asynchronously)
        // Pass sendRequest for elicitation (queued via task message queue, works on all transports)
        runResearchProcess(taskId, state, extra.taskStore, extra.sendRequest)
          .catch(async (error) => {
            if (state.abortController.signal.aborted) return;
            console.error(`Research task ${taskId} failed:`, error);
            await extra.taskStore
              .updateTaskStatus(taskId, "failed", String(error))
              .catch(console.error);
          })
          .finally(() => {
            inflightTasks.delete(state);
          });

        return { task };
      },

      /**
       * Returns the current status of the research task.
       */
      getTask: async (args, extra): Promise<GetTaskResult> => {
        return await extra.taskStore.getTask(extra.taskId);
      },

      /**
       * Returns the task result.
       * Elicitation is now handled directly in the background process.
       */
      getTaskResult: async (args, extra): Promise<CallToolResult> => {
        return (await extra.taskStore.getTaskResult(
          extra.taskId
        )) as CallToolResult;
      },
    }
  );
};

/**
 * Returns contextual interpretation options based on the topic.
 */
function getInterpretationsForTopic(
  topic: string
): Array<{ const: string; title: string }> {
  const lowerTopic = topic.toLowerCase();

  // Example: contextual interpretations for "python"
  if (lowerTopic.includes("python")) {
    return [
      { const: "programming", title: "Python programming language" },
      { const: "snake", title: "Python snake species" },
      { const: "comedy", title: "Monty Python comedy group" },
    ];
  }

  // Default generic interpretations
  return [
    { const: "technical", title: "Technical/scientific perspective" },
    { const: "historical", title: "Historical perspective" },
    { const: "current", title: "Current events/news perspective" },
  ];
}
