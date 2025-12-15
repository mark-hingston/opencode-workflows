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
  JsonValue,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { loadWorkflows, createLogger } from "./loader/index.js";
import { WorkflowFactory } from "./factory/index.js";
import { WorkflowRunner, WorkflowStorage } from "./commands/index.js";
import { executeWorkflowTool } from "./tools/index.js";
import { resolve } from "node:path";
import { ProgressReporter } from "./progress.js";
import {
  createTriggerState,
  setupTriggers as setupTriggersFromModule,
  handleFileChange,
  type TriggerState,
} from "./triggers/index.js";

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
  /** Trigger state for cron and file change triggers */
  triggers: TriggerState;
  progress: ProgressReporter | null;
}

/**
 * Type for the OpenCode SDK client
 * The plugin receives the SDK client which has session-based APIs
 */
type SdkClient = PluginInput["client"];

/**
 * Creates an OpenCode client adapter from the plugin context
 * 
 * Maps the plugin's client interface to our internal OpencodeClient interface.
 * 
 * For agent steps, we use the SDK's session.prompt() API with @agent mentions
 * to invoke named agents. This creates a child session for each agent invocation.
 */
function createClientAdapter(client: SdkClient, progress?: ProgressReporter): OpencodeClient {
  // Cache for workflow sessions to avoid creating too many
  let workflowSessionId: string | null = null;
  
  /**
   * Get or create a session for workflow agent invocations
   */
  async function getWorkflowSession(): Promise<string> {
    if (workflowSessionId) {
      // Verify session still exists
      try {
        const result = await client.session.get({ path: { id: workflowSessionId } });
        if (result.data) {
          return workflowSessionId;
        }
      } catch {
        // Session no longer exists, create new one
        workflowSessionId = null;
      }
    }
    
    // Create a new session for workflow operations
    const result = await client.session.create({
      body: { title: `Workflow Session - ${new Date().toISOString()}` },
    });
    
    if (!result.data?.id) {
      throw new Error("Failed to create workflow session");
    }
    
    workflowSessionId = result.data.id;
    return workflowSessionId;
  }
  
  /**
   * Invoke an agent using the SDK's session.prompt() API
   * The agent is specified using @agentName mention syntax
   */
  async function invokeAgent(
    agentName: string,
    prompt: string,
    _options?: { maxTokens?: number }
  ): Promise<{ content: string }> {
    const sessionId = await getWorkflowSession();
    
    // Use @agent mention to invoke the specific agent
    // The prompt is prefixed with @agentName to route to that agent
    const agentPrompt = `@${agentName} ${prompt}`;
    
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: agentPrompt }],
      },
    });
    
    // Extract the response content from the result
    // The result contains the assistant's message parts
    if (!result.data) {
      throw new Error(`Agent '${agentName}' invocation failed: no response data`);
    }
    
    // The response is in result.data.parts array
    const parts = result.data.parts || [];
    const textParts = parts
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { type: string; text?: string }) => p.text || "");
    
    const content = textParts.join("\n");
    
    return { content };
  }
  
  return {
    // Pass through available tools from the Opencode client
    tools: (client as unknown as { tools?: OpencodeClient["tools"] }).tools || {},
    
    // Agents adapter - creates agents object dynamically
    // Each agent invocation uses session.prompt() with @agent mention
    agents: new Proxy({} as NonNullable<OpencodeClient["agents"]>, {
      get(_target, agentName: string) {
        // Return an agent object with invoke method
        return {
          invoke: async (prompt: string, options?: { maxTokens?: number }) => {
            return invokeAgent(agentName, prompt, options);
          },
        };
      },
      has() {
        // All agents are considered available - the SDK will error if agent doesn't exist
        return true;
      },
    }),
    
    llm: {
      chat: async (opts) => {
        // For direct LLM chat (not through a named agent), use session.prompt without @mention
        const sessionId = await getWorkflowSession();
        
        // Build prompt from messages
        const systemMessage = opts.messages.find(m => m.role === "system");
        const userMessages = opts.messages.filter(m => m.role === "user");
        
        // Combine into a single prompt
        let prompt = "";
        if (systemMessage) {
          prompt += `[System Instructions]\n${systemMessage.content}\n\n`;
        }
        prompt += userMessages.map(m => m.content).join("\n");
        
        const result = await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: "text", text: prompt }],
          },
        });
        
        if (!result.data) {
          throw new Error("LLM chat failed: no response data");
        }
        
        const parts = result.data.parts || [];
        const textParts = parts
          .filter((p: { type: string }) => p.type === "text")
          .map((p: { type: string; text?: string }) => p.text || "");
        
        return { content: textParts.join("\n") };
      },
    },
    
    app: {
      log: (message, level = "info") => {
        if (progress) {
          void progress.emit(message, { level: level as "info" | "warn" | "error" });
          return;
        }
        // Use the SDK's app.log API
        client.app.log({
          body: {
            service: "workflow",
            level,
            message,
          },
        }).catch(() => {
          // Fallback to console if SDK log fails
          console.log(`[workflow:${level}] ${message}`);
        });
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
 * Setup a periodic cleanup job to archive/delete old workflow runs
 * Runs once per day at midnight
 */
function setupCleanupJob(storage: WorkflowStorage, log: Logger, maxAgeInDays: number): void {
  const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
  
  async function cleanupOldRuns() {
    try {
      const cutoffDate = new Date(Date.now() - maxAgeInDays * MILLISECONDS_PER_DAY);
      const deletedCount = await storage.deleteRunsOlderThan(cutoffDate);
      
      if (deletedCount > 0) {
        log.info(`Cleanup: Deleted ${deletedCount} workflow run(s) older than ${maxAgeInDays} days`);
      }
    } catch (error) {
      log.error(`Failed to cleanup old runs: ${error}`);
    }
  }
  
  // Run cleanup once per day at midnight
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msUntilMidnight = tomorrow.getTime() - now.getTime();
  
  // Schedule first cleanup at midnight
  setTimeout(() => {
    cleanupOldRuns();
    // Then run every 24 hours
    setInterval(cleanupOldRuns, MILLISECONDS_PER_DAY);
  }, msUntilMidnight);
  
  log.debug(`Scheduled cleanup job to run daily (max age: ${maxAgeInDays} days)`);
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
    triggers: createTriggerState(),
    progress: null,
  };

  /**
   * Initialize the plugin (lazy initialization)
   */
  async function initialize(): Promise<void> {
    if (state.initialized) return;

    log.info("Initializing workflow plugin...");

    // Progress reporter for streaming updates back to the originating session
    state.progress = new ProgressReporter(client, log);

    // Create client adapter
    const clientAdapter = createClientAdapter(client, state.progress);

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

    // Create factory and register workflows for lazy compilation
    const factory = new WorkflowFactory(clientAdapter);
    state.factory = factory;
    
    // Register all workflow definitions (no compilation yet)
    // Workflows will be compiled on-demand when first accessed
    for (const def of workflows.values()) {
      factory.register(def);
    }

    // Validate tool references in workflows (without compilation)
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

    // Create storage for persistence
    const dbPath = config.dbPath ?? resolve(projectDir, ".opencode/data/workflows.db");
    // Pass encryption key from config/env if available
    const encryptionKey = process.env.WORKFLOW_ENCRYPTION_KEY;
    state.storage = new WorkflowStorage({ 
      dbPath, 
      verbose: config.verbose,
      encryptionKey 
    }, log);
    await state.storage.init();

    // Register workflow secrets with storage so they can be encrypted
    for (const [id, def] of workflows) {
      if (def.secrets && def.secrets.length > 0) {
        state.storage.setWorkflowSecrets(id, def.secrets);
      }
    }

    log.debug("Workflow storage initialized");

    // Create runner with storage and timeout config
    state.runner = new WorkflowRunner(state.factory, log, state.storage, {
      timeout: config.timeout,
      maxCompletedRuns: config.maxCompletedRuns,
    }, state.progress || undefined);

    // Restore active runs from storage
    await state.runner.init();

    state.initialized = true;
    log.info(`Loaded ${workflows.size} workflow(s)`);

    // Setup triggers after initialization
    if (state.runner) {
      setupTriggersFromModule(state.triggers, state.definitions, state.runner, log);
    }

    // Setup cleanup job if maxRunAge is configured
    if (config.maxRunAge && state.storage) {
      setupCleanupJob(state.storage, log, config.maxRunAge);
    }
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

        case "session.deleted":
        case "session.error": {
          if (!state.initialized) {
            await initialize();
          }
          const properties = (event as { properties?: Record<string, unknown> }).properties || {};
          const sessionId =
            (properties as { sessionID?: string }).sessionID ||
            (properties as { info?: { id?: string } }).info?.id;

          if (sessionId && state.runner) {
            const reason =
              event.type === "session.error"
                ? "Workflow suspended: chat session errored"
                : "Workflow suspended: chat session closed";
            const suspended = await state.runner.suspendRunsForSession(sessionId, reason);
            if (suspended.length > 0) {
              log.warn(`Suspended ${suspended.length} workflow run(s) after session interruption (${sessionId})`);
            }
          }
          break;
        }

        case "file.edited":
        case "file.watcher.updated": {
          const path = (event as { path?: string }).path;
          
          // Reload workflows when workflow files change
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
          
          // Trigger file change workflows
          if (path && state.initialized && state.runner) {
            handleFileChange(state.triggers, state.definitions, state.runner, log, path);
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
        async execute(args, context: ToolContext) {
          // Ensure initialized
          if (!state.initialized) {
            await initialize();
          }

          // Guard against uninitialized state
          if (!state.runner) {
            return JSON.stringify({ success: false, message: "Workflow runner not initialized" });
          }

          const runContext = context
            ? {
                sessionId: context.sessionID,
                messageId: context.messageID,
                agent: context.agent,
              }
            : undefined;

          const result = await executeWorkflowTool(
            {
              mode: args.mode,
              workflowId: args.workflowId,
              runId: args.runId,
              params: args.params as Record<string, string | number | boolean> | undefined,
              resumeData: args.resumeData as JsonValue | undefined,
            },
            state.definitions,
            state.runner,
            runContext
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
  WaitStepDefinition,
  StepDefinition,
  WorkflowDefinition,
  WorkflowTrigger,
  WorkflowRunStatus,
  ShellStepOutput,
  ToolStepOutput,
  AgentStepOutput,
  SuspendStepOutput,
  HttpStepOutput,
  FileStepOutput,
  WaitStepOutput,
  IteratorStepOutput,
  StepOutput,
  StepResult,
  WorkflowRun,
  StepExecutionContext,
  OpencodeClient,
  ShellExecutor,
  Logger,
  WorkflowEventPayload,
  WorkflowRegistry,
  RunContext,
} from "./types.js";
