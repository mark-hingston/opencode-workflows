/**
 * OpenCode Workflow Plugin
 *
 * Integrates Mastra workflow engine for deterministic automation.
 * Enables agents to trigger complex multi-step workflows.
 *
 * @module opencode-workflows
 */

import type { Plugin, PluginInput, ToolContext } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type {
  WorkflowPluginConfig,
  WorkflowDefinition,
  OpencodeClient,
  Logger,
  JsonObject,
  JsonValue,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { loadWorkflows, createLogger } from "./loader/index.js";
import { WorkflowFactory } from "./factory/index.js";
import { WorkflowRunner, handleWorkflowCommand, WorkflowStorage } from "./commands/index.js";
import { executeWorkflowTool } from "./tools/index.js";
import { resolve } from "node:path";

/**
 * Plugin state maintained across the session
 */
interface PluginState {
  definitions: Map<string, WorkflowDefinition>;
  factory: WorkflowFactory | null;
  runner: WorkflowRunner | null;
  storage: WorkflowStorage | null;
  log: Logger;
  initialized: boolean;
}

/**
 * Creates an OpenCode client adapter from the plugin context
 * 
 * Maps the plugin's client interface to our internal OpencodeClient interface
 */
function createClientAdapter(client: PluginInput["client"]): OpencodeClient {
  return {
    // Pass through available tools from the Opencode client
    tools: (client as { tools?: OpencodeClient["tools"] }).tools || {},
    llm: {
      chat: async (opts) => {
        // Map the internal adapter call to the actual Opencode SDK
        const llmClient = client as { llm?: { chat: (options: {
          messages: Array<{ role: string; content: string }>;
          model?: string;
          maxTokens?: number;
        }) => Promise<{ content?: string }> } };
        
        if (!llmClient.llm?.chat) {
          throw new Error(
            "LLM chat not available. Ensure the Opencode client provides llm.chat capability."
          );
        }
        
        const response = await llmClient.llm.chat({
          messages: opts.messages,
          model: opts.model,
          maxTokens: opts.maxTokens,
        });
        
        // Ensure we return the expected format
        return { content: response.content || "" };
      },
    },
    app: {
      log: (message, level = "info") => {
        // Map to client.app.log if available, otherwise use console
        const appClient = client as { app?: { log?: (message: string) => void } };
        if (appClient.app?.log) {
          appClient.app.log(`[workflow:${level}] ${message}`);
        } else {
          console.log(`[workflow:${level}] ${message}`);
        }
      },
    },
  };
}

/**
 * Get plugin configuration from environment or defaults
 */
function getConfig(): WorkflowPluginConfig {
  return { ...DEFAULT_CONFIG };
}

/**
 * OpenCode Workflow Plugin
 *
 * Usage: Place this file in .opencode/plugin/ directory
 *
 * @example
 * ```ts
 * // .opencode/plugin/workflow.ts
 * export { WorkflowPlugin } from "opencode-workflows"
 * ```
 */
export const WorkflowPlugin: Plugin = async ({ project, directory, worktree, client, $ }: PluginInput) => {
  const config = getConfig();
  const projectDir = directory || process.cwd();

  // Create logger
  const log = createLogger(config.verbose);

  // Plugin state (will be initialized on first use)
  const state: PluginState = {
    definitions: new Map(),
    factory: null,
    runner: null,
    storage: null,
    log,
    initialized: false,
  };

  /**
   * Initialize the plugin (lazy initialization)
   */
  async function initialize(): Promise<void> {
    if (state.initialized) return;

    log.info("Initializing workflow plugin...");

    // Create client adapter
    const clientAdapter = createClientAdapter(client);

    // Load workflow definitions
    const { workflows, errors } = await loadWorkflows(
      projectDir,
      log,
      config.workflowDirs
    );

    if (errors.length > 0) {
      log.warn(`Encountered ${errors.length} error(s) loading workflows`);
    }

    state.definitions = workflows;

    // Validate tool references in workflows before compilation
    // This provides early warning for missing tools rather than runtime failures
    for (const [id, def] of workflows) {
      for (const step of def.steps) {
        if (step.type === "tool") {
          if (!clientAdapter.tools[step.tool]) {
            log.warn(`Workflow '${id}' references missing tool: '${step.tool}' (step: ${step.id})`);
          }
        }
      }
    }

    // Create factory and compile workflows in parallel
    const factory = new WorkflowFactory(clientAdapter);
    state.factory = factory;
    
    const compilationResults = await Promise.allSettled(
      Array.from(workflows.values()).map(async (def) => {
        try {
          factory.compile(def);
          log.debug(`Compiled workflow: ${def.id}`);
          return { id: def.id, success: true };
        } catch (error) {
          log.error(`Failed to compile workflow ${def.id}: ${error}`);
          return { id: def.id, success: false, error };
        }
      })
    );

    // Log compilation summary
    const failedCount = compilationResults.filter(
      (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.success)
    ).length;
    if (failedCount > 0) {
      log.warn(`${failedCount} workflow(s) failed to compile`);
    }

    // Create storage for persistence
    const dbPath = config.dbPath ?? resolve(projectDir, ".opencode/data/workflows.db");
    state.storage = new WorkflowStorage({ dbPath, verbose: config.verbose }, log);
    await state.storage.init();
    log.debug("Workflow storage initialized");

    // Create runner with storage and timeout config
    state.runner = new WorkflowRunner(state.factory, log, state.storage, {
      timeout: config.timeout,
    });

    // Restore active runs from storage
    await state.runner.init();

    state.initialized = true;
    log.info(`Loaded ${workflows.size} workflow(s)`);
  }

  // Initialize immediately
  await initialize();

  return {
    /**
     * Event handler - receives all OpenCode events
     */
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
        case "server.connected":
          // Re-initialize if needed
          if (!state.initialized) {
            await initialize();
          }
          break;

        case "file.edited":
        case "file.watcher.updated": {
          // Reload workflows when workflow files change
          const path = (event as { path?: string }).path;
          if (
            path?.includes(".opencode/workflows/") &&
            (path.endsWith(".json") || path.endsWith(".ts"))
          ) {
            log.info("Workflow file changed, reloading...");
            
            // Close existing storage to prevent connection leaks
            if (state.storage) {
              await state.storage.close();
              state.storage = null;
            }
            
            state.initialized = false;
            await initialize();
          }
          break;
        }
      }
    },

    // NOTE: OpenCode does not support plugin-defined slash commands.
    // Slash commands must be defined in config or .opencode/command/ markdown files.
    // The workflow tool below provides the same functionality for agent use.

    /**
     * Tool definitions for agent use
     */
    tool: {
      workflow: tool({
        description: `Execute and manage workflow automation. Use this tool to trigger deterministic multi-step processes.

Modes:
- list: List all available workflows
- show: Get details of a specific workflow (requires workflowId)
- run: Execute a workflow (requires workflowId, optional params)
- status: Check the status of a workflow run (requires runId)
- resume: Resume a suspended workflow (requires runId, optional resumeData)
- cancel: Cancel a running workflow (requires runId)
- runs: List recent workflow runs (optional workflowId filter)`,
        args: {
          mode: tool.schema.enum(["list", "show", "run", "status", "resume", "cancel", "runs"]),
          workflowId: tool.schema.string().optional(),
          runId: tool.schema.string().optional(),
          params: tool.schema.record(
            tool.schema.string(),
            tool.schema.union([
              tool.schema.string(),
              tool.schema.number(),
              tool.schema.boolean(),
            ])
          ).optional(),
          resumeData: tool.schema.any().optional(),
        },
        async execute(args, _context: ToolContext) {
          // Ensure initialized
          if (!state.initialized) {
            await initialize();
          }

          // Guard against uninitialized state
          if (!state.runner) {
            return JSON.stringify({ success: false, message: "Workflow runner not initialized" });
          }

          const result = await executeWorkflowTool(
            {
              mode: args.mode,
              workflowId: args.workflowId,
              runId: args.runId,
              params: args.params as Record<string, string | number | boolean> | undefined,
              resumeData: args.resumeData as JsonValue | undefined,
            },
            state.definitions,
            state.runner
          );

          return JSON.stringify(result);
        },
      }),
    },
  };
};

// NOTE: Do NOT export as default - OpenCode's plugin loader calls ALL exports
// as functions, which would cause double initialization.

// IMPORTANT: Only export the plugin function from the main entry point.
// OpenCode's plugin loader iterates over ALL exports and tries to call each
// one as a function. Exporting objects, classes, or Zod schemas here will
// cause runtime errors like "fn3 is not a function".
//
// For utility exports (types, classes, functions), consumers should import
// from the /utils subpath:
//   import { WorkflowFactory, loadWorkflows } from "opencode-workflows/utils"
//
// TypeScript types are safe to export since they're erased at runtime.
export type {
  JsonPrimitive,
  JsonValue,
  JsonObject,
  InputValue,
  WorkflowInputs,
  WorkflowPluginConfig,
  StepType,
  HttpMethod,
  FileAction,
  BaseStepDefinition,
  ShellStepDefinition,
  ToolStepDefinition,
  AgentStepDefinition,
  SuspendStepDefinition,
  HttpStepDefinition,
  FileStepDefinition,
  StepDefinition,
  WorkflowDefinition,
  WorkflowRunStatus,
  ShellStepOutput,
  ToolStepOutput,
  AgentStepOutput,
  SuspendStepOutput,
  HttpStepOutput,
  FileStepOutput,
  StepOutput,
  StepResult,
  WorkflowRun,
  StepExecutionContext,
  OpencodeClient,
  ShellExecutor,
  Logger,
  WorkflowEventPayload,
  WorkflowRegistry,
} from "./types.js";
