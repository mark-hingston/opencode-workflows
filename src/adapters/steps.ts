import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, normalize, isAbsolute } from "node:path";
import { runInNewContext, type Context } from "node:vm";
import treeKill from "tree-kill";
import type {
  ShellStepDefinition,
  ToolStepDefinition,
  AgentStepDefinition,
  SuspendStepDefinition,
  WaitStepDefinition,
  HttpStepDefinition,
  FileStepDefinition,
  IteratorStepDefinition,
  EvalStepDefinition,
  StepDefinition,
  OpencodeClient,
  JsonValue,
  JsonObject,
  WorkflowDefinition,
} from "../types.js";
import { JsonValueSchema, WorkflowDefinitionSchema } from "../types.js";
import { interpolate, interpolateValue, interpolateWithSecrets } from "./interpolation.js";


// =============================================================================
// Process Management
// =============================================================================

/** Set of currently running child processes for cleanup on cancellation */
const activeProcesses = new Set<ChildProcess>();

/**
 * Kill a process tree gracefully, with fallback to SIGKILL.
 * Ensures all child processes are terminated to prevent zombie processes.
 */
function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    treeKill(pid, "SIGTERM", (err) => {
      if (err) {
        // Fallback to SIGKILL if SIGTERM fails
        treeKill(pid, "SIGKILL", () => resolve());
      } else {
        resolve();
      }
    });
  });
}

/**
 * Execute a shell command using spawn with proper process cleanup.
 * This replaces exec to provide better control over the child process lifecycle.
 * 
 * @param command - Command to execute (passed to shell if safe=false)
 * @param options - Execution options
 * @param logger - Optional logger for streaming output
 * @returns Promise with stdout, stderr, and exitCode
 */
async function executeCommand(
  command: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    safe?: boolean;
    args?: string[];
  } = {},
  logger?: (msg: string, level: "info" | "warn" | "error") => void
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;

    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env || process.env,
    };

    if (options.safe && options.args) {
      // Safe mode: bypass shell, run command directly with args array
      // This prevents shell injection entirely
      child = spawn(command, options.args, spawnOptions);
    } else {
      // Shell mode: use shell to interpret command (supports pipes, redirects, etc.)
      // Platform-specific shell selection
      const isWindows = process.platform === "win32";
      const shell = isWindows ? "cmd.exe" : "/bin/sh";
      const shellArgs = isWindows ? ["/c", command] : ["-c", command];

      child = spawn(shell, shellArgs, spawnOptions);
    }

    activeProcesses.add(child);

    let stdout = "";
    let stderr = "";
    let killed = false;
    let timeoutId: NodeJS.Timeout | undefined;

    // Handle timeout
    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(async () => {
        killed = true;
        if (child.pid) {
          await killProcessTree(child.pid);
        }
        reject(Object.assign(
          new Error(`Command timed out after ${options.timeout}ms`),
          { code: null, stdout, stderr, killed: true }
        ));
      }, options.timeout);
    }

    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;

      // Stream to logger if provided (with line buffering)
      if (logger) {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        // Keep the last part (it might be a partial line)
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            logger(line.trim(), "info");
          }
        }
      }
    });

    child.stderr?.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;

      // Stream stderr as info (with line buffering)
      if (logger) {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split("\n");
        // Keep the last part (it might be a partial line)
        stderrBuffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            logger(line.trim(), "info");
          }
        }
      }
    });

    child.on("error", (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      activeProcesses.delete(child);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (timeoutId) clearTimeout(timeoutId);
      activeProcesses.delete(child);

      // Flush remaining buffers
      if (logger) {
        if (stdoutBuffer.trim()) {
          logger(stdoutBuffer.trim(), "info");
        }
        if (stderrBuffer.trim()) {
          logger(stderrBuffer.trim(), "info");
        }
      }

      if (killed) return; // Already handled by timeout

      if (signal) {
        reject(Object.assign(
          new Error(`Command killed by signal: ${signal}`),
          { code: null, stdout, stderr, signal }
        ));
      } else {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
        });
      }
    });
  });
}

/**
 * Kill all active child processes. Call this during workflow cancellation
 * to prevent zombie processes.
 */
export async function cleanupAllProcesses(): Promise<void> {
  const killPromises = Array.from(activeProcesses).map((child) => {
    if (child.pid) {
      return killProcessTree(child.pid);
    }
    return Promise.resolve();
  });
  await Promise.all(killPromises);
  activeProcesses.clear();
}


// =============================================================================
// Security Utilities
// =============================================================================

/**
 * Dangerous shell characters/patterns that could enable command injection.
 * These are logged as warnings but not blocked to maintain flexibility.
 */
const SHELL_DANGEROUS_PATTERNS = [
  /;\s*rm\s/i,        // rm after semicolon
  /&&\s*rm\s/i,       // rm after &&
  /\|\|\s*rm\s/i,     // rm after ||
  /&\s*rm\s/i,        // rm after background operator
  /\|\s*sh\b/i,       // piping to shell
  /\|\s*bash\b/i,     // piping to bash
  /\|\s*zsh\b/i,      // piping to zsh
  /`[^`]+`/,          // backtick command substitution
  /\$\([^)]+\)/,      // $() command substitution
  /\$\{[^}]+\}/,      // ${} parameter expansion with commands
  />\s*\/etc\//i,     // writing to /etc
  />\s*\/bin\//i,     // writing to /bin
  />\s*\/usr\/bin\//i, // writing to /usr/bin
  /curl.*\|.*sh/i,    // curl piped to shell
  /wget.*\|.*sh/i,    // wget piped to shell
];

/**
 * Check if a command contains potentially dangerous patterns.
 * Returns warnings for logging but does not block execution.
 */
function checkCommandSafety(command: string): string[] {
  const warnings: string[] = [];

  for (const pattern of SHELL_DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      warnings.push(`Command contains potentially dangerous pattern: ${pattern.source}`);
    }
  }

  return warnings;
}

/**
 * Validate and normalize a file path to prevent path traversal attacks.
 * @param path - The path to validate
 * @param allowedBaseDirs - Optional list of allowed base directories
 * @returns The normalized absolute path
 * @throws Error if path traversal is detected
 */
function validateFilePath(path: string, allowedBaseDirs?: string[]): string {
  // Normalize the path to resolve . and ..
  const normalized = normalize(path);

  // Convert to absolute path
  const absolutePath = isAbsolute(normalized) ? normalized : resolve(process.cwd(), normalized);

  // Check for path traversal attempts
  if (path.includes("..")) {
    // After normalization, verify the path doesn't escape allowed directories
    if (allowedBaseDirs && allowedBaseDirs.length > 0) {
      const isWithinAllowed = allowedBaseDirs.some(baseDir => {
        const absoluteBase = isAbsolute(baseDir) ? baseDir : resolve(process.cwd(), baseDir);
        return absolutePath.startsWith(absoluteBase);
      });

      if (!isWithinAllowed) {
        throw new Error(`Path traversal detected: ${path} is outside allowed directories`);
      }
    }
  }

  return absolutePath;
}

/**
 * List of private/internal IP ranges that should be blocked for SSRF protection
 */
const PRIVATE_IP_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,  // Link-local
  /^::1$/,        // IPv6 localhost
  /^fc00:/i,      // IPv6 private
  /^fe80:/i,      // IPv6 link-local
  /^0\.0\.0\.0$/,
];

/**
 * Validate URL to prevent SSRF attacks.
 * @param urlString - The URL to validate
 * @returns The validated URL
 * @throws Error if URL targets internal resources
 */
function validateUrlForSSRF(urlString: string): string {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  // Only allow http and https protocols
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Disallowed protocol: ${url.protocol}. Only http and https are allowed.`);
  }

  const hostname = url.hostname;

  // Check against private IP patterns
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(`SSRF protection: requests to internal addresses (${hostname}) are not allowed`);
    }
  }

  // Block requests to metadata endpoints (cloud provider metadata services)
  if (hostname === "metadata.google.internal" ||
    hostname === "metadata.goog" ||
    url.pathname.startsWith("/latest/meta-data")) {
    throw new Error("SSRF protection: requests to cloud metadata endpoints are not allowed");
  }

  return urlString;
}

/**
 * Input schema for step execution context.
 * Includes optional secretInputs array for masking sensitive values in logs.
 * Supports complex input types (object, array) in addition to primitives.
 * 
 * IMPORTANT: This schema is used for BOTH input and output of steps.
 * When Mastra chains steps with .then(), the output of step N becomes the
 * inputData for step N+1. By using the same schema and accumulating step
 * outputs in the `steps` field, we maintain context through the entire chain.
 */
const StepContextSchema = z.object({
  inputs: z.record(JsonValueSchema),
  steps: z.record(JsonValueSchema),
  secretInputs: z.array(z.string()).optional(),
});

type StepContext = z.infer<typeof StepContextSchema>;

// =============================================================================
// Shell Step Adapter
// =============================================================================

/**
 * Creates a Mastra step that executes a shell command.
 * 
 * IMPORTANT: Returns the full accumulated context (inputs, steps, secretInputs)
 * so that subsequent steps in the chain can access previous step outputs via
 * {{steps.stepId.property}} interpolation.
 */
export function createShellStep(def: ShellStepDefinition, client: OpencodeClient) {
  return createStep({
    id: def.id,
    description: def.description || `Execute: ${def.command}`,
    inputSchema: StepContextSchema,
    outputSchema: StepContextSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepContext;
      const secretInputs = data.secretInputs || [];

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-execution of side-effects (e.g., deployments) when resuming after restart
      if (data.steps?.[def.id]) {
        client.app.log(`Skipping already-completed step: ${def.id}`, "info");
        // Return the context as-is since step already exists
        return data;
      }

      const ctx = {
        inputs: data.inputs || {},
        steps: data.steps || {},
        env: process.env,
      };

      // Check condition before execution
      if (def.condition) {
        const evaluated = interpolate(def.condition, ctx);
        // Skip if condition evaluates to falsy value
        if (evaluated === "false" || evaluated === "0" || evaluated === "") {
          const skipResult = {
            stdout: "",
            stderr: "Skipped due to condition",
            exitCode: 0,
            skipped: true,
          };
          // Return accumulated context with skip result
          return {
            inputs: data.inputs || {},
            steps: { ...ctx.steps, [def.id]: skipResult },
            secretInputs,
          };
        }
      }

      // Interpolate variables in the command with secrets awareness
      const { value: command, masked: maskedCommand } = interpolateWithSecrets(def.command, ctx, secretInputs);

      // Security check: Log warnings for potentially dangerous patterns (using masked command)
      const safetyWarnings = checkCommandSafety(command);
      for (const warning of safetyWarnings) {
        client.app.log(`[SECURITY WARNING] ${warning}`, "warn");
      }

      // Log command execution to TUI (masked version to hide secrets)
      client.app.log(`> ${maskedCommand}`, "info");

      const options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        timeout?: number;
        safe?: boolean;
        args?: string[];
      } = {};

      if (def.cwd) {
        options.cwd = interpolate(def.cwd, ctx);
      }

      if (def.env) {
        options.env = {
          ...process.env,
          ...Object.fromEntries(
            Object.entries(def.env).map(([k, v]) => [k, interpolate(v, ctx)])
          ),
        };
      }

      if (def.timeout) {
        options.timeout = def.timeout;
      }

      // Safe mode: use spawn without shell to prevent injection
      if (def.safe) {
        options.safe = true;
        // In safe mode, args must be provided as an array
        if (!def.args) {
          throw new Error("Safe mode requires 'args' to be specified as an array");
        }
        options.args = def.args.map(arg => interpolate(arg, ctx));
      }

      try {
        const { stdout, stderr, exitCode } = await executeCommand(
          command,
          options,
          // Adapter to map simple log calls to client.app.log with explicit level
          (msg, level) => client.app.log(msg, level)
        );

        // Check for non-zero exit code and throw if failOnError is enabled
        if (exitCode !== 0 && def.failOnError !== false) {
          throw new Error(
            `Command failed with exit code ${exitCode}: ${stderr || stdout}`
          );
        }

        const stepResult = {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: exitCode,
        };

        // Return accumulated context with this step's result added
        return {
          inputs: data.inputs || {},
          steps: { ...ctx.steps, [def.id]: stepResult },
          secretInputs,
        };
      } catch (error) {
        // Re-throw if this is our own error from exit code check above (which is Error)
        if (error instanceof Error && error.message.startsWith("Command failed with exit code")) {
          throw error;
        }

        // Handle spawn/process errors (timeout, killed, etc.)
        const execError = error as { stdout?: string; stderr?: string; code?: number; exitCode?: number };

        if (def.failOnError !== false) {
          throw new Error(
            `Command failed: ${execError instanceof Error ? execError.message : String(execError)}`
          );
        }

        return {
          inputs: data.inputs || {},
          steps: {
            ...ctx.steps, [def.id]: {
              stdout: execError.stdout?.trim() || "",
              stderr: execError.stderr?.trim() || "",
              exitCode: execError.code ?? execError.exitCode ?? 1,
            }
          },
          secretInputs,
        };
      }
    },
  });
}
// =============================================================================
// Tool Step Adapter
// =============================================================================

/**
 * Creates a Mastra step that invokes an Opencode tool.
 * 
 * IMPORTANT: Returns the full accumulated context so subsequent steps can
 * access this step's output via {{steps.stepId.result}} interpolation.
 */
export function createToolStep(def: ToolStepDefinition, client: OpencodeClient) {
  return createStep({
    id: def.id,
    description: def.description || `Execute tool: ${def.tool}`,
    inputSchema: StepContextSchema,
    outputSchema: StepContextSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepContext;
      const secretInputs = data.secretInputs || [];

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-execution of side-effects when resuming after restart
      if (data.steps?.[def.id]) {
        client.app.log(`Skipping already-completed step: ${def.id}`, "info");
        return data;
      }

      const ctx = {
        inputs: data.inputs || {},
        steps: data.steps || {},
        env: process.env,
      };

      // Check condition before execution
      if (def.condition) {
        const evaluated = interpolate(def.condition, ctx);
        if (evaluated === "false" || evaluated === "0" || evaluated === "") {
          const skipResult = { result: null, skipped: true };
          return {
            inputs: data.inputs || {},
            steps: { ...ctx.steps, [def.id]: skipResult },
            secretInputs,
          };
        }
      }

      const tool = client.tools[def.tool];

      if (!tool) {
        const availableTools = Object.keys(client.tools).join(", ") || "(none)";
        throw new Error(`Tool '${def.tool}' not found. Available tools: ${availableTools}`);
      }

      // Interpolate args
      const args = def.args
        ? interpolateObject(def.args, ctx)
        : {};

      client.app.log(`Running tool: ${def.tool}`, "info");
      const result = await tool.execute(args as JsonObject);

      const stepResult = { result };
      return {
        inputs: data.inputs || {},
        steps: { ...ctx.steps, [def.id]: stepResult },
        secretInputs,
      };
    },
  });
}

// =============================================================================
// Agent Step Adapter
// =============================================================================

/**
 * Creates a Mastra step that invokes an agent or prompts an LLM.
 * 
 * Supports two modes:
 * 1. Named agent reference: Uses `def.agent` to invoke a pre-defined opencode agent
 * 2. Inline LLM call: Uses `def.system` for direct LLM chat (legacy/fallback)
 * 
 * IMPORTANT: Returns the full accumulated context so subsequent steps can
 * access this step's output via {{steps.stepId.response}} interpolation.
 */
export function createAgentStep(def: AgentStepDefinition, client: OpencodeClient) {
  return createStep({
    id: def.id,
    description: def.description || (def.agent ? `Agent: ${def.agent}` : "LLM prompt"),
    inputSchema: StepContextSchema,
    outputSchema: StepContextSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepContext;
      const secretInputs = data.secretInputs || [];

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-execution of side-effects when resuming after restart
      if (data.steps?.[def.id]) {
        client.app.log(`Skipping already-completed step: ${def.id}`, "info");
        return data;
      }

      const ctx = {
        inputs: data.inputs || {},
        steps: data.steps || {},
        env: process.env,
      };

      // Check condition before execution
      if (def.condition) {
        const evaluated = interpolate(def.condition, ctx);
        if (evaluated === "false" || evaluated === "0" || evaluated === "") {
          const skipResult = { response: "", skipped: true };
          return {
            inputs: data.inputs || {},
            steps: { ...ctx.steps, [def.id]: skipResult },
            secretInputs,
          };
        }
      }

      // Interpolate prompt
      const prompt = interpolate(def.prompt, ctx);

      // Mode 1: Named agent reference
      if (def.agent) {
        if (!client.agents) {
          throw new Error("No agents available on the opencode client. Ensure agents are configured.");
        }

        // Get the agent from the agents object (may be a Proxy)
        const agent = client.agents[def.agent];
        if (!agent) {
          throw new Error(`Agent '${def.agent}' not found.`);
        }

        client.app.log(`Invoking agent: ${def.agent}`, "info");

        try {
          const response = await agent.invoke(prompt, { maxTokens: def.maxTokens });
          const stepResult = { response: response.content };
          return {
            inputs: data.inputs || {},
            steps: { ...ctx.steps, [def.id]: stepResult },
            secretInputs,
          };
        } catch (error) {
          // Provide better error message for agent invocation failures
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to invoke agent '${def.agent}': ${errorMessage}`);
        }
      }

      // Mode 2: Inline LLM call (legacy/fallback)
      client.app.log(`LLM prompt: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`, "info");

      const messages: Array<{ role: string; content: string }> = [];

      if (def.system) {
        messages.push({
          role: "system",
          content: interpolate(def.system, ctx),
        });
      }

      messages.push({ role: "user", content: prompt });

      const response = await client.llm.chat({
        messages,
        maxTokens: def.maxTokens,
      });

      const stepResult = { response: response.content };
      return {
        inputs: data.inputs || {},
        steps: { ...ctx.steps, [def.id]: stepResult },
        secretInputs,
      };
    },
  });
}

// =============================================================================
// Suspend Step Adapter
// =============================================================================

/**
 * Convert a JSON Schema object to a Zod schema.
 * Supports basic types commonly used in workflow resume data.
 * 
 * @param jsonSchema - JSON Schema object with field names as keys and type definitions as values
 * @returns A Zod object schema for validation
 */
function jsonSchemaToZod(jsonSchema: JsonObject): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, typeDef] of Object.entries(jsonSchema)) {
    // Handle both simple type strings and full JSON Schema objects
    const typeValue = typeof typeDef === 'object' && typeDef !== null && 'type' in typeDef
      ? (typeDef as { type: string }).type
      : typeDef;

    switch (typeValue) {
      case 'string':
        shape[key] = z.string();
        break;
      case 'number':
        shape[key] = z.number();
        break;
      case 'integer':
        shape[key] = z.number().int();
        break;
      case 'boolean':
        shape[key] = z.boolean();
        break;
      case 'array':
        shape[key] = z.array(z.unknown());
        break;
      case 'object':
        shape[key] = z.record(z.unknown());
        break;
      default:
        // For unknown types, accept any value
        shape[key] = z.unknown();
    }
  }

  return z.object(shape);
}

/** Schema for suspend payload - defines what data is passed when suspending */
const SuspendPayloadSchema = z.object({
  /** Message to display to the user when workflow is suspended */
  message: z.string(),
  /** Optional additional context for the suspension */
  stepId: z.string().optional(),
  /** Schema description for expected resume data (for UI hints) */
  resumeSchemaHint: z.record(z.string()).optional(),
});

/**
 * Creates a Mastra step that suspends execution for human approval.
 * 
 * This step uses Mastra's built-in resumeSchema for automatic validation
 * of resume data, and suspendSchema for structured suspend payloads.
 * 
 * IMPORTANT: Returns the full accumulated context so subsequent steps can
 * access this step's output via {{steps.stepId.resumed}} interpolation.
 */
export function createSuspendStep(def: SuspendStepDefinition) {
  // Build the resume schema from the JSON Schema definition if provided
  // Mastra will automatically validate resume data against this schema
  const resumeSchema = def.resumeSchema
    ? jsonSchemaToZod(def.resumeSchema)
    : undefined;

  return createStep({
    id: def.id,
    description: def.description || "Awaiting human input",
    inputSchema: StepContextSchema,
    outputSchema: StepContextSchema,
    // Pass resumeSchema to Mastra for automatic validation
    resumeSchema,
    // Define the structure of suspend payload for type safety
    suspendSchema: SuspendPayloadSchema,
    execute: async ({ inputData, suspend, resumeData }) => {
      const data = inputData as StepContext;
      const secretInputs = data.secretInputs || [];

      // If we have resumeData, we're resuming from a suspended state
      // Note: Mastra automatically validates resumeData against resumeSchema
      // before calling execute, so we don't need manual validation here
      if (resumeData !== undefined) {
        const stepResult = { resumed: true, data: resumeData };
        return {
          inputs: data.inputs || {},
          steps: { ...(data.steps || {}), [def.id]: stepResult },
          secretInputs,
        };
      }

      // IDEMPOTENCY CHECK: Skip if this step was already completed (hydration scenario)
      // This prevents re-suspending on steps that were already resumed in a previous run.
      // Without this, workflows with multiple suspend steps would get stuck on the first one
      // when rehydrating after a server restart.
      if (data.steps?.[def.id]) {
        return data;
      }

      const ctx = {
        inputs: data.inputs || {},
        steps: data.steps || {},
        env: process.env,
      };

      // Check condition before suspending
      if (def.condition) {
        const evaluated = interpolate(def.condition, ctx);
        if (evaluated === "false" || evaluated === "0" || evaluated === "") {
          const skipResult = { resumed: false, data: null, skipped: true };
          return {
            inputs: data.inputs || {},
            steps: { ...ctx.steps, [def.id]: skipResult },
            secretInputs,
          };
        }
      }

      const message = def.message
        ? interpolate(def.message, ctx)
        : "Workflow paused. Resume to continue.";

      // Suspend with structured payload (validated by suspendSchema)
      // Include resume schema hint for potential UI rendering
      await suspend({
        message,
        stepId: def.id,
        resumeSchemaHint: def.resumeSchema
          ? Object.fromEntries(
            Object.entries(def.resumeSchema).map(([k, v]) => [
              k,
              typeof v === 'object' && v !== null && 'type' in v
                ? String((v as { type: string }).type)
                : String(v)
            ])
          )
          : undefined,
      });

      // This won't be reached until resumed - return context with pending result
      const stepResult = { resumed: true, data: null };
      return {
        inputs: data.inputs || {},
        steps: { ...ctx.steps, [def.id]: stepResult },
        secretInputs,
      };
    },
  });
}

// =============================================================================
// Wait Step Adapter
// =============================================================================

/**
 * Creates a Mastra step that waits for a specified duration.
 * Useful for waiting for external systems (e.g., waiting for a deployed URL to become live)
 * without suspending for human input.
 * 
 * This is a platform-independent alternative to `shell: sleep 5`.
 * 
 * IMPORTANT: Returns the full accumulated context so subsequent steps can
 * access this step's output via {{steps.stepId.completed}} interpolation.
 */
export function createWaitStep(def: WaitStepDefinition) {
  return createStep({
    id: def.id,
    description: def.description || `Wait ${def.durationMs}ms`,
    inputSchema: StepContextSchema,
    outputSchema: StepContextSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepContext;
      const secretInputs = data.secretInputs || [];

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-waiting when resuming after restart
      if (data.steps?.[def.id]) {
        return data;
      }

      const ctx = {
        inputs: data.inputs || {},
        steps: data.steps || {},
        env: process.env,
      };

      // Check condition before execution
      if (def.condition) {
        const evaluated = interpolate(def.condition, ctx);
        if (evaluated === "false" || evaluated === "0" || evaluated === "") {
          const skipResult = { completed: false, durationMs: 0, skipped: true };
          return {
            inputs: data.inputs || {},
            steps: { ...ctx.steps, [def.id]: skipResult },
            secretInputs,
          };
        }
      }

      // Wait for the specified duration
      await new Promise(resolve => setTimeout(resolve, def.durationMs));

      const stepResult = { completed: true, durationMs: def.durationMs };
      return {
        inputs: data.inputs || {},
        steps: { ...ctx.steps, [def.id]: stepResult },
        secretInputs,
      };
    },
  });
}

// =============================================================================
// HTTP Step Adapter
// =============================================================================

/**
 * Creates a Mastra step that executes an HTTP request.
 * 
 * IMPORTANT: Returns the full accumulated context so subsequent steps can
 * access this step's output via {{steps.stepId.body}} interpolation.
 */
export function createHttpStep(def: HttpStepDefinition) {
  return createStep({
    id: def.id,
    description: def.description || `${def.method} ${def.url}`,
    inputSchema: StepContextSchema,
    outputSchema: StepContextSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepContext;
      const secretInputs = data.secretInputs || [];

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-execution of side-effects (e.g., API calls) when resuming after restart
      if (data.steps?.[def.id]) {
        return data;
      }

      const ctx = {
        inputs: data.inputs || {},
        steps: data.steps || {},
        env: process.env,
      };

      // Check condition before execution
      if (def.condition) {
        const evaluated = interpolate(def.condition, ctx);
        if (evaluated === "false" || evaluated === "0" || evaluated === "") {
          const skipResult = { status: 0, body: null, text: "", headers: {}, skipped: true };
          return {
            inputs: data.inputs || {},
            steps: { ...ctx.steps, [def.id]: skipResult },
            secretInputs,
          };
        }
      }

      // Interpolate URL and headers
      const rawUrl = interpolate(def.url, ctx);

      // SSRF Protection: Validate URL to prevent requests to internal resources
      const url = validateUrlForSSRF(rawUrl);

      const headers = def.headers
        ? (interpolateObject(def.headers, ctx) as Record<string, string>)
        : {};

      // Prepare request body
      let body: string | undefined;
      if (def.body !== undefined) {
        if (typeof def.body === "string") {
          body = interpolate(def.body, ctx);
        } else {
          // Interpolate object body values before stringifying
          const interpolatedBody = interpolateObject(def.body as JsonObject, ctx);
          body = JSON.stringify(interpolatedBody);
        }
      }

      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutMs = def.timeout ?? 30000; // Default 30 second timeout
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: def.method,
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Try to parse JSON, fallback to null
        const text = await response.text();
        let responseBody: unknown = null;
        try {
          responseBody = JSON.parse(text);
        } catch {
          // Keep body as null if not valid JSON - raw text is available in 'text' field
        }

        if (!response.ok && def.failOnError !== false) {
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        const stepResult = {
          status: response.status,
          body: responseBody as JsonValue,
          text,
          headers: Object.fromEntries(response.headers.entries()),
        };
        return {
          inputs: data.inputs || {},
          steps: { ...ctx.steps, [def.id]: stepResult as JsonValue },
          secretInputs,
        };
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`HTTP request timed out after ${timeoutMs}ms`);
        }
        throw error;
      }
    },
  });
}

// =============================================================================
// File Step Adapter
// =============================================================================

/**
 * Creates a Mastra step that performs file operations.
 * 
 * IMPORTANT: Returns the full accumulated context so subsequent steps can
 * access this step's output via {{steps.stepId.content}} interpolation.
 */
export function createFileStep(def: FileStepDefinition) {
  return createStep({
    id: def.id,
    description: def.description || `File ${def.action}: ${def.path}`,
    inputSchema: StepContextSchema,
    outputSchema: StepContextSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepContext;
      const secretInputs = data.secretInputs || [];

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-execution of side-effects (e.g., file writes) when resuming after restart
      if (data.steps?.[def.id]) {
        return data;
      }

      const ctx = {
        inputs: data.inputs || {},
        steps: data.steps || {},
        env: process.env,
      };

      // Check condition before execution
      if (def.condition) {
        const evaluated = interpolate(def.condition, ctx);
        if (evaluated === "false" || evaluated === "0" || evaluated === "") {
          const skipResult = { skipped: true };
          return {
            inputs: data.inputs || {},
            steps: { ...ctx.steps, [def.id]: skipResult },
            secretInputs,
          };
        }
      }

      // Interpolate file path and validate for path traversal
      const rawPath = interpolate(def.path, ctx);
      const filePath = validateFilePath(rawPath);

      let stepResult: JsonValue;
      switch (def.action) {
        case "read": {
          const content = await readFile(filePath, "utf-8");
          stepResult = { content };
          break;
        }

        case "write": {
          let writeContent: string;
          if (def.content === undefined) {
            throw new Error("Content is required for write action");
          }
          // Handle object content (auto-stringify)
          if (typeof def.content === "object" && def.content !== null) {
            writeContent = JSON.stringify(def.content, null, 2);
          } else {
            writeContent = interpolate(String(def.content), ctx);
          }
          await writeFile(filePath, writeContent, "utf-8");
          stepResult = { success: true };
          break;
        }

        case "delete": {
          await unlink(filePath);
          stepResult = { success: true };
          break;
        }

        default:
          throw new Error(`Unknown file action: ${(def as FileStepDefinition).action}`);
      }

      return {
        inputs: data.inputs || {},
        steps: { ...ctx.steps, [def.id]: stepResult },
        secretInputs,
      };
    },
  });
}

// =============================================================================
// Iterator Step Adapter
// =============================================================================

/**
 * Execute a single step definition with the given context.
 * This is a simplified executor for inner steps within an iterator or cleanup blocks.
 * Exported for use by the runner for onFailure/finally step execution.
 */
export async function executeInnerStep(
  def: StepDefinition,
  ctx: { inputs: Record<string, JsonValue>; steps: Record<string, JsonValue>; env?: NodeJS.ProcessEnv },
  client: OpencodeClient,
  secretInputs: string[] = []
): Promise<JsonValue> {
  // Check condition before execution (per-item evaluation)
  if (def.condition) {
    const evaluated = interpolate(def.condition, ctx);
    if (evaluated === "false" || evaluated === "0" || evaluated === "") {
      return {
        skipped: true,
      };
    }
  }

  switch (def.type) {
    case "shell": {
      const { value: command, masked: maskedCommand } = interpolateWithSecrets(def.command, ctx, secretInputs);

      // Security check: Log warnings for potentially dangerous patterns
      const safetyWarnings = checkCommandSafety(command);
      for (const warning of safetyWarnings) {
        client.app.log(`[SECURITY WARNING] ${warning}`, "warn");
      }

      // Log masked command to protect secrets
      client.app.log(`> ${maskedCommand}`, "info");

      const options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        timeout?: number;
        safe?: boolean;
        args?: string[];
      } = {};

      if (def.cwd) {
        options.cwd = interpolate(def.cwd, ctx);
      }

      if (def.env) {
        options.env = {
          ...process.env,
          ...Object.fromEntries(
            Object.entries(def.env).map(([k, v]) => [k, interpolate(v, ctx)])
          ),
        };
      }

      if (def.timeout) {
        options.timeout = def.timeout;
      }

      // Safe mode: use spawn without shell to prevent injection
      if (def.safe) {
        options.safe = true;
        if (!def.args) {
          throw new Error("Safe mode requires 'args' to be specified as an array");
        }
        options.args = def.args.map(arg => interpolate(arg, ctx));
      }

      try {
        const { stdout, stderr, exitCode } = await executeCommand(
          command,
          options,
          // Adapter to map simple log calls to client.app.log with explicit level
          (msg, level) => client.app.log(msg, level)
        );

        // Check for non-zero exit code and throw if failOnError is enabled
        if (exitCode !== 0 && def.failOnError !== false) {
          throw new Error(
            `Command failed with exit code ${exitCode}: ${stderr || stdout}`
          );
        }

        const stepResult = {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: exitCode,
        };

        // Return accumulated context with this step's result added
        return stepResult;
      } catch (error) {
        // Re-throw if this is our own error from exit code check above (which is Error)
        if (error instanceof Error && error.message.startsWith("Command failed with exit code")) {
          throw error;
        }

        // Handle spawn/process errors (timeout, killed, etc.)
        const execError = error as { stdout?: string; stderr?: string; code?: number; exitCode?: number };

        if (def.failOnError !== false) {
          throw new Error(
            `Command failed: ${execError instanceof Error ? execError.message : String(execError)}`
          );
        }

        return {
          stdout: execError.stdout?.trim() || "",
          stderr: execError.stderr?.trim() || "",
          exitCode: execError.code ?? execError.exitCode ?? 1,
        };
      }
    }

    case "tool": {
      const tool = client.tools[def.tool];

      if (!tool) {
        const availableTools = Object.keys(client.tools).join(", ") || "(none)";
        throw new Error(`Tool '${def.tool}' not found. Available tools: ${availableTools}`);
      }

      const args = def.args
        ? interpolateObject(def.args, ctx)
        : {};

      client.app.log(`Running tool: ${def.tool}`, "info");
      const result = await tool.execute(args as JsonObject);

      return { result };
    }

    case "agent": {
      const prompt = interpolate(def.prompt, ctx);

      if (def.agent) {
        if (!client.agents) {
          throw new Error("No agents available on the opencode client. Ensure agents are configured.");
        }

        const agent = client.agents[def.agent];
        if (!agent) {
          throw new Error(`Agent '${def.agent}' not found.`);
        }

        client.app.log(`Invoking agent: ${def.agent}`, "info");

        try {
          const response = await agent.invoke(prompt, { maxTokens: def.maxTokens });
          return { response: response.content };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to invoke agent '${def.agent}': ${errorMessage}`);
        }
      }

      client.app.log(`LLM prompt: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`, "info");

      const messages: Array<{ role: string; content: string }> = [];

      if (def.system) {
        messages.push({
          role: "system",
          content: interpolate(def.system, ctx),
        });
      }

      messages.push({ role: "user", content: prompt });

      const response = await client.llm.chat({
        messages,
        maxTokens: def.maxTokens,
      });

      return { response: response.content };
    }

    case "http": {
      const rawUrl = interpolate(def.url, ctx);
      const url = validateUrlForSSRF(rawUrl);

      const headers = def.headers
        ? (interpolateObject(def.headers, ctx) as Record<string, string>)
        : {};

      let body: string | undefined;
      if (def.body !== undefined) {
        if (typeof def.body === "string") {
          body = interpolate(def.body, ctx);
        } else {
          body = JSON.stringify(def.body);
        }
      }

      const controller = new AbortController();
      const timeoutMs = def.timeout ?? 30000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: def.method,
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const text = await response.text();
        let responseBody: JsonValue = null;
        try {
          responseBody = JSON.parse(text) as JsonValue;
        } catch {
          // Keep body as null if not valid JSON
        }

        if (!response.ok && def.failOnError !== false) {
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        return {
          status: response.status,
          body: responseBody,
          text,
          headers: Object.fromEntries(response.headers.entries()),
        };
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`HTTP request timed out after ${timeoutMs}ms`);
        }
        throw error;
      }
    }

    case "file": {
      const rawPath = interpolate(def.path, ctx);
      const filePath = validateFilePath(rawPath);

      switch (def.action) {
        case "read": {
          const content = await readFile(filePath, "utf-8");
          return { content };
        }

        case "write": {
          let writeContent: string;
          if (def.content === undefined) {
            throw new Error("Content is required for write action");
          }
          if (typeof def.content === "object" && def.content !== null) {
            writeContent = JSON.stringify(def.content, null, 2);
          } else {
            writeContent = interpolate(String(def.content), ctx);
          }
          await writeFile(filePath, writeContent, "utf-8");
          return { success: true };
        }

        case "delete": {
          await unlink(filePath);
          return { success: true };
        }

        default:
          throw new Error(`Unknown file action: ${(def as FileStepDefinition).action}`);
      }
    }

    case "wait": {
      // Wait for the specified duration
      await new Promise(resolve => setTimeout(resolve, def.durationMs));
      return {
        completed: true,
        durationMs: def.durationMs,
      };
    }

    case "eval": {
      const timeout = def.scriptTimeout ?? DEFAULT_SCRIPT_TIMEOUT;
      client.app.log(`Executing eval script (timeout: ${timeout}ms)`, "info");

      const scriptResult = await executeScript(
        def.script,
        ctx,
        timeout,
        (msg, level) => client.app.log(`[eval] ${msg}`, level)
      );

      if (scriptResult.workflow) {
        // Dynamic workflow generation is not supported within iterators or cleanup blocks
        // The workflow would need to be executed by the runner, which is not available here
        throw new Error(
          "Eval steps that generate dynamic workflows are not supported within iterators or cleanup blocks. " +
          "Use eval steps that return simple values, or move the dynamic workflow generation to a top-level step."
        );
      }

      return scriptResult.result ?? null;
    }

    case "suspend":
      throw new Error("Suspend steps are not supported within iterators");

    case "iterator":
      throw new Error("Nested iterators are not supported");

    default:
      throw new Error(`Unknown step type: ${(def as StepDefinition).type}`);
  }
}

/**
 * Creates a Mastra step that iterates over an array and executes a sub-step (or sequence of steps) for each item.
 * 
 * The iterator provides special context variables for each iteration:
 * - {{inputs.item}} - The current item being processed
 * - {{inputs.index}} - The zero-based index of the current item
 * - {{inputs.item.property}} - Access nested properties of the current item
 * 
 * When using runSteps (sequence mode), each step can access outputs from previous
 * steps in the sequence via {{steps.stepId.property}}.
 * 
 * IMPORTANT: Returns the full accumulated context so subsequent steps can
 * access this step's output via {{steps.stepId.results}} interpolation.
 */
export function createIteratorStep(def: IteratorStepDefinition, client: OpencodeClient) {
  // Validate that exactly one of runStep or runSteps is provided
  const hasRunStep = def.runStep !== undefined;
  const hasRunSteps = def.runSteps !== undefined && def.runSteps.length > 0;

  if (!hasRunStep && !hasRunSteps) {
    throw new Error(`Iterator step '${def.id}' must have either 'runStep' or 'runSteps'`);
  }
  if (hasRunStep && hasRunSteps) {
    throw new Error(`Iterator step '${def.id}' cannot have both 'runStep' and 'runSteps' - use one or the other`);
  }

  return createStep({
    id: def.id,
    description: def.description || `Iterate over ${def.items}`,
    inputSchema: StepContextSchema,
    outputSchema: StepContextSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepContext;
      const secretInputs = data.secretInputs || [];

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      if (data.steps?.[def.id]) {
        client.app.log(`Skipping already-completed step: ${def.id}`, "info");
        return data;
      }

      const ctx = {
        inputs: data.inputs || {},
        steps: data.steps || {},
        env: process.env,
      };

      // Check condition before execution
      if (def.condition) {
        const evaluated = interpolate(def.condition, ctx);
        if (evaluated === "false" || evaluated === "0" || evaluated === "") {
          const skipResult = { results: [], count: 0, skipped: true };
          return {
            inputs: data.inputs || {},
            steps: { ...ctx.steps, [def.id]: skipResult },
            secretInputs,
          };
        }
      }

      // Resolve the items array using interpolateValue to preserve the array type
      const itemsValue = interpolateValue(def.items, ctx);

      if (!Array.isArray(itemsValue)) {
        throw new Error(
          `Iterator items must resolve to an array. Got ${typeof itemsValue}: ${JSON.stringify(itemsValue)}`
        );
      }

      const items = itemsValue as JsonValue[];
      client.app.log(`Iterating over ${items.length} items`, "info");

      const results: JsonValue[] = [];

      // Get the steps to execute (either single runStep or array of runSteps)
      // We've already validated that exactly one of these is defined
      const stepsToRun = def.runSteps ? def.runSteps : (def.runStep ? [def.runStep] : []);

      for (let index = 0; index < items.length; index++) {
        const item = items[index];

        // Create context with item and index available for interpolation
        // We inject these as special inputs that can be accessed via {{inputs.item}} and {{inputs.index}}
        const iterationCtx = {
          inputs: {
            ...ctx.inputs,
            item,
            index,
          } as Record<string, JsonValue>,
          // Start with parent steps context, will accumulate results from sub-steps
          steps: { ...ctx.steps } as Record<string, JsonValue>,
          env: ctx.env,
        };

        client.app.log(`[${index + 1}/${items.length}] Processing item`, "info");

        // Execute each step in the sequence for this item
        const iterationResults: Record<string, JsonValue> = {};

        for (let stepIndex = 0; stepIndex < stepsToRun.length; stepIndex++) {
          const stepTemplate = stepsToRun[stepIndex];

          // Create a copy of the step definition with a generated id if not provided
          const stepDef: StepDefinition = {
            ...stepTemplate,
            id: stepTemplate.id || `${def.id}-iter${index}-step${stepIndex}`,
          } as StepDefinition;

          if (stepsToRun.length > 1) {
            client.app.log(`  Step ${stepIndex + 1}/${stepsToRun.length}: ${stepDef.id}`, "info");
          }

          // Execute the inner step with secretInputs for masking
          const result = await executeInnerStep(stepDef, iterationCtx, client, secretInputs);

          // Store the result so subsequent steps can reference it
          iterationResults[stepDef.id] = result;
          iterationCtx.steps[stepDef.id] = result;
        }

        // For single step mode, push just the result; for multi-step mode, push all results
        if (stepsToRun.length === 1) {
          const singleStepId = stepsToRun[0].id || `${def.id}-iter${index}-step0`;
          results.push(iterationResults[singleStepId]);
        } else {
          results.push(iterationResults);
        }
      }

      const stepResult = { results, count: items.length };
      return {
        inputs: data.inputs || {},
        steps: { ...ctx.steps, [def.id]: stepResult },
        secretInputs,
      };
    },
  });
}

// =============================================================================
// Eval Step Adapter
// =============================================================================

/** Default timeout for script execution (30 seconds) */
const DEFAULT_SCRIPT_TIMEOUT = 30000;

/**
 * Creates a sandboxed context for script execution.
 * The context provides read-only access to inputs, steps, and env.
 */
function createSandboxContext(
  inputs: Record<string, JsonValue>,
  steps: Record<string, JsonValue>,
  env: NodeJS.ProcessEnv,
  logger?: (message: string, level: "info" | "warn" | "error") => void
): Context {
  // Create a frozen copy of env to prevent modification
  const frozenEnv = Object.freeze({ ...env });

  // Helper to format console arguments
  const formatArgs = (...args: unknown[]): string =>
    args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');

  return {
    // Workflow context (read-only via frozen copies)
    // Use structuredClone for better performance than JSON.parse(JSON.stringify())
    inputs: Object.freeze(structuredClone(inputs)),
    steps: Object.freeze(structuredClone(steps)),
    env: frozenEnv,

    // Console mapped to plugin logger (or silent if no logger provided)
    console: {
      log: (...args: unknown[]) => logger?.(formatArgs(...args), "info"),
      warn: (...args: unknown[]) => logger?.(formatArgs(...args), "warn"),
      error: (...args: unknown[]) => logger?.(formatArgs(...args), "error"),
    },
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Promise,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,

    // Blocked dangerous globals
    require: undefined,
    process: undefined,
    global: undefined,
    globalThis: undefined,
    Buffer: undefined,
    __dirname: undefined,
    __filename: undefined,
    module: undefined,
    exports: undefined,
    fetch: undefined, // Use http step instead
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
  };
}

// =============================================================================
// Isolated VM Support (optional, for secure sandboxing)
// =============================================================================

/**
 * Try to load isolated-vm module (optional peer dependency).
 * Returns null if not available.
 */
let isolatedVmModule: typeof import('isolated-vm') | null = null;
let isolatedVmLoadAttempted = false;

async function getIsolatedVm(): Promise<typeof import('isolated-vm') | null> {
  if (isolatedVmLoadAttempted) return isolatedVmModule;
  isolatedVmLoadAttempted = true;

  try {
    isolatedVmModule = await import('isolated-vm');
    return isolatedVmModule;
  } catch {
    // isolated-vm not installed or failed to load (native module)
    return null;
  }
}

/**
 * Execute script using isolated-vm for true V8 isolate sandboxing.
 * This provides memory isolation and prevents sandbox escape attacks.
 */
async function executeScriptIsolated(
  ivm: typeof import('isolated-vm'),
  script: string,
  ctx: { inputs: Record<string, JsonValue>; steps: Record<string, JsonValue>; env?: NodeJS.ProcessEnv },
  timeout: number,
  logger?: (message: string, level: "info" | "warn" | "error") => void
): Promise<{ result?: JsonValue; workflow?: WorkflowDefinition }> {
  // Create a new isolate with memory limit (128MB)
  const isolate = new ivm.Isolate({ memoryLimit: 128 });

  try {
    // Create a new context within the isolate
    const context = await isolate.createContext();
    const jail = context.global;

    // Set up read-only context data by copying as JSON
    await jail.set('__inputs', new ivm.ExternalCopy(ctx.inputs).copyInto());
    await jail.set('__steps', new ivm.ExternalCopy(ctx.steps).copyInto());

    // Create a safe subset of env (no process access)
    const safeEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(ctx.env || {})) {
      if (value !== undefined) {
        safeEnv[key] = value;
      }
    }
    await jail.set('__env', new ivm.ExternalCopy(safeEnv).copyInto());

    // Set up console logging via callbacks
    const logMessages: Array<{ msg: string; level: "info" | "warn" | "error" }> = [];
    await jail.set('__log', new ivm.Callback((msg: string, level: string) => {
      logMessages.push({ msg, level: level as "info" | "warn" | "error" });
    }));

    // Bootstrap script that sets up the sandbox context
    const bootstrapScript = await isolate.compileScript(`
      const inputs = __inputs;
      const steps = __steps;
      const env = __env;
      const console = {
        log: (...args) => __log(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), 'info'),
        warn: (...args) => __log(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), 'warn'),
        error: (...args) => __log(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), 'error'),
      };
      // Make context immutable
      Object.freeze(inputs);
      Object.freeze(steps);
      Object.freeze(env);
    `);
    await bootstrapScript.run(context);

    // Compile and run the user script
    // We wrap the result in JSON.stringify inside the isolate so we can transfer it
    const wrappedScript = `
      (async () => {
        const __userResult = await (async () => {
          ${script}
        })();
        // Serialize to JSON for safe transfer out of isolate
        return JSON.stringify(__userResult);
      })()
    `;
    const userScript = await isolate.compileScript(wrappedScript);

    // Run with timeout - use promise:true to properly await the async IIFE
    const resultJson = await userScript.run(context, {
      timeout,
      promise: true,  // Wait for the Promise returned by async IIFE
    });

    // Flush log messages first
    for (const { msg, level } of logMessages) {
      logger?.(msg, level);
    }

    // Parse the JSON result from the isolate
    let result: JsonValue | undefined;
    if (typeof resultJson === 'string') {
      try {
        result = JSON.parse(resultJson);
      } catch {
        // If JSON parsing fails, it's likely a primitive that was stringified
        result = resultJson;
      }
    } else if (resultJson !== undefined && resultJson !== null) {
      result = resultJson as JsonValue;
    }

    // Check if result is a workflow definition
    if (result && typeof result === 'object' && 'workflow' in result) {
      const workflowResult = result as { workflow: unknown };
      const validation = WorkflowDefinitionSchema.safeParse(workflowResult.workflow);
      if (!validation.success) {
        const errors = validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
        throw new Error(`Invalid workflow definition: ${errors}`);
      }
      return { workflow: validation.data as WorkflowDefinition };
    }

    return { result };
  } finally {
    // Always dispose the isolate to free memory
    isolate.dispose();
  }
}

/**
 * Execute script using Node.js vm module (less secure fallback).
 * WARNING: vm module is NOT a security mechanism and can be escaped.
 */
async function executeScriptVm(
  script: string,
  ctx: { inputs: Record<string, JsonValue>; steps: Record<string, JsonValue>; env?: NodeJS.ProcessEnv },
  timeout: number,
  logger?: (message: string, level: "info" | "warn" | "error") => void
): Promise<{ result?: JsonValue; workflow?: WorkflowDefinition }> {
  const sandbox = createSandboxContext(ctx.inputs, ctx.steps, ctx.env || {}, logger);

  // Wrap the script in an async IIFE to support await and return statements
  const wrappedScript = `
    (async () => {
      ${script}
    })()
  `;

  try {
    const result = await Promise.race([
      runInNewContext(wrappedScript, sandbox, {
        timeout,
        displayErrors: true,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Script execution timed out after ${timeout}ms`)), timeout)
      ),
    ]);

    // Check if result is a workflow definition
    if (result && typeof result === 'object' && 'workflow' in result) {
      const workflowResult = result as { workflow: unknown };
      // Validate the workflow definition
      const validation = WorkflowDefinitionSchema.safeParse(workflowResult.workflow);
      if (!validation.success) {
        const errors = validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
        throw new Error(`Invalid workflow definition: ${errors}`);
      }
      return { workflow: validation.data as WorkflowDefinition };
    }

    return { result: result as JsonValue };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Script execution failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Execute a script in a sandboxed context.
 * Uses isolated-vm when available for true V8 isolation (secure).
 * Falls back to Node.js vm module when isolated-vm is not installed (less secure).
 */
async function executeScript(
  script: string,
  ctx: { inputs: Record<string, JsonValue>; steps: Record<string, JsonValue>; env?: NodeJS.ProcessEnv },
  timeout: number,
  logger?: (message: string, level: "info" | "warn" | "error") => void
): Promise<{ result?: JsonValue; workflow?: WorkflowDefinition }> {
  const ivm = await getIsolatedVm();

  if (ivm) {
    logger?.("[sandbox] Using isolated-vm for secure execution", "info");
    try {
      return await executeScriptIsolated(ivm, script, ctx, timeout, logger);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Script execution failed: ${error.message}`);
      }
      throw error;
    }
  } else {
    logger?.("[sandbox] WARNING: Using vm module (isolated-vm not available). Install isolated-vm for better security.", "warn");
    return executeScriptVm(script, ctx, timeout, logger);
  }
}

/**
 * Creates a Mastra step that executes JavaScript code in a sandboxed environment.
 * 
 * The script can:
 * 1. Return a value directly (stored in `result`)
 * 2. Return `{ workflow: WorkflowDefinition }` to trigger dynamic workflow execution
 * 
 * This enables "Agentic Planning" - the ability for an agent to decide at runtime
 * how to solve a problem by generating and executing a workflow dynamically.
 * 
 * IMPORTANT: Returns the full accumulated context so subsequent steps can
 * access this step's output via {{steps.stepId.result}} interpolation.
 */
export function createEvalStep(def: EvalStepDefinition, client: OpencodeClient) {
  return createStep({
    id: def.id,
    description: def.description || "Dynamic script evaluation",
    inputSchema: StepContextSchema,
    outputSchema: StepContextSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepContext;
      const secretInputs = data.secretInputs || [];

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      if (data.steps?.[def.id]) {
        client.app.log(`Skipping already-completed step: ${def.id}`, "info");
        return data;
      }

      const ctx = {
        inputs: data.inputs || {},
        steps: data.steps || {},
        env: process.env,
      };

      // Check condition before execution
      if (def.condition) {
        const evaluated = interpolate(def.condition, ctx);
        if (evaluated === "false" || evaluated === "0" || evaluated === "") {
          const skipResult = { skipped: true };
          return {
            inputs: data.inputs || {},
            steps: { ...ctx.steps, [def.id]: skipResult },
            secretInputs,
          };
        }
      }

      const timeout = def.scriptTimeout ?? DEFAULT_SCRIPT_TIMEOUT;
      client.app.log(`Executing eval script in sandbox (timeout: ${timeout}ms)`, "info");

      const scriptResult = await executeScript(
        def.script,
        ctx,
        timeout,
        (msg, level) => client.app.log(`[eval] ${msg}`, level)
      );

      if (scriptResult.workflow) {
        client.app.log(`Eval step generated dynamic workflow: ${scriptResult.workflow.id}`, "info");
        // Return the workflow for the runner to execute
        // The runner will handle executing the sub-workflow
        const stepResult = { workflow: scriptResult.workflow as unknown as JsonValue };
        return {
          inputs: data.inputs || {},
          steps: { ...ctx.steps, [def.id]: stepResult },
          secretInputs,
        };
      }

      const stepResult = { result: scriptResult.result ?? null };
      return {
        inputs: data.inputs || {},
        steps: { ...ctx.steps, [def.id]: stepResult },
        secretInputs,
      };
    },
  });
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Recursively interpolates all string values in an object.
 * Uses interpolateValue to preserve types for single-variable references.
 * e.g., "{{inputs.count}}" with count=5 returns number 5, not string "5"
 */
export function interpolateObject(
  obj: JsonObject,
  ctx: { inputs: Record<string, JsonValue>; steps: Record<string, JsonValue>; env?: NodeJS.ProcessEnv }
): JsonObject {
  const result: JsonObject = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      // Use interpolateValue to preserve types for exact variable matches
      result[key] = interpolateValue(value, ctx);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "string"
          ? interpolateValue(item, ctx)
          : typeof item === "object" && item !== null && !Array.isArray(item)
            ? interpolateObject(item as JsonObject, ctx)
            : item
      );
    } else if (typeof value === "object" && value !== null) {
      result[key] = interpolateObject(value as JsonObject, ctx);
    } else {
      result[key] = value;
    }
  }

  return result;
}
