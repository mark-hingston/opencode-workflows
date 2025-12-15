import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, normalize, isAbsolute } from "node:path";
import type {
  ShellStepDefinition,
  ToolStepDefinition,
  AgentStepDefinition,
  SuspendStepDefinition,
  WaitStepDefinition,
  HttpStepDefinition,
  FileStepDefinition,
  IteratorStepDefinition,
  StepDefinition,
  OpencodeClient,
  JsonValue,
  JsonObject,
} from "../types.js";
import { JsonValueSchema } from "../types.js";
import { interpolate, interpolateValue, interpolateWithSecrets } from "./interpolation.js";

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import treeKill from "tree-kill";

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
 * @param command - Command to execute (passed to shell)
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
  } = {},
  logger?: (msg: string, level: "info" | "warn" | "error") => void
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env || process.env,
    };
    
    // Use shell to interpret command (supports pipes, redirects, etc.)
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/c", command] : ["-c", command];
    
    child = spawn(shell, shellArgs, spawnOptions);
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
    
    child.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      // Stream to logger if provided
      if (logger && chunk.trim()) {
        logger(chunk.trim(), "info");
      }
    });
    
    child.stderr?.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      // Stream stderr as info (or warn?) - usually workflow output is info
      if (logger && chunk.trim()) {
        logger(chunk.trim(), "info");
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
  /;\s*rm\s/i,      // rm after semicolon
  /\|\s*sh\b/i,     // piping to shell
  /\|\s*bash\b/i,   // piping to bash
  /`[^`]+`/,        // backtick command substitution
  /\$\([^)]+\)/,    // $() command substitution
  />\s*\/etc\//i,   // writing to /etc
  />\s*\/bin\//i,   // writing to /bin
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
 */
const StepInputSchema = z.object({
  inputs: z.record(z.union([z.string(), z.number(), z.boolean()])),
  steps: z.record(JsonValueSchema),
  secretInputs: z.array(z.string()).optional(),
});

type StepInput = z.infer<typeof StepInputSchema>;

// =============================================================================
// Shell Step Adapter
// =============================================================================

/**
 * Output schema with optional skipped status
 */
const ShellOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  skipped: z.boolean().optional(),
});

/**
 * Creates a Mastra step that executes a shell command
 */
export function createShellStep(def: ShellStepDefinition, client: OpencodeClient) {
  return createStep({
    id: def.id,
    description: def.description || `Execute: ${def.command}`,
    inputSchema: StepInputSchema,
    outputSchema: ShellOutputSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepInput;
      const secretInputs = data.secretInputs || [];

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-execution of side-effects (e.g., deployments) when resuming after restart
      if (data.steps?.[def.id]) {
        client.app.log(`Skipping already-completed step: ${def.id}`, "info");
        return data.steps[def.id] as z.infer<typeof ShellOutputSchema>;
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
          return {
            stdout: "",
            stderr: "Skipped due to condition",
            exitCode: 0,
            skipped: true,
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

      const options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {};

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

      try {
        const { stdout, stderr } = await executeCommand(
          command, 
          options,
          // Adapter to map simple log calls to client.app.log with explicit level
          (msg, level) => client.app.log(msg, level)
        );
        return {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: 0,
        };
      } catch (error) {
        const execError = error as { stdout?: string; stderr?: string; code?: number };
        
        if (def.failOnError !== false) {
          throw new Error(
            `Command failed: ${execError instanceof Error ? execError.message : String(execError)}`
          );
        }

        return {
          stdout: execError.stdout?.trim() || "",
          stderr: execError.stderr?.trim() || "",
          exitCode: execError.code || 1,
        };
      }
    },
  });
}

// =============================================================================
// Tool Step Adapter
// =============================================================================

/**
 * Creates a Mastra step that invokes an Opencode tool
 */
export function createToolStep(def: ToolStepDefinition, client: OpencodeClient) {
  return createStep({
    id: def.id,
    description: def.description || `Execute tool: ${def.tool}`,
    inputSchema: StepInputSchema,
    outputSchema: z.object({
      result: JsonValueSchema,
      skipped: z.boolean().optional(),
    }),
    execute: async ({ inputData }) => {
      const data = inputData as StepInput;

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-execution of side-effects when resuming after restart
      if (data.steps?.[def.id]) {
        client.app.log(`Skipping already-completed step: ${def.id}`, "info");
        return data.steps[def.id] as { result: JsonValue; skipped?: boolean };
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
          return {
            result: null,
            skipped: true,
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

      return { result };
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
 */
export function createAgentStep(def: AgentStepDefinition, client: OpencodeClient) {
  return createStep({
    id: def.id,
    description: def.description || (def.agent ? `Agent: ${def.agent}` : "LLM prompt"),
    inputSchema: StepInputSchema,
    outputSchema: z.object({
      response: z.string(),
      skipped: z.boolean().optional(),
    }),
    execute: async ({ inputData }) => {
      const data = inputData as StepInput;

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-execution of side-effects when resuming after restart
      if (data.steps?.[def.id]) {
        client.app.log(`Skipping already-completed step: ${def.id}`, "info");
        return data.steps[def.id] as { response: string; skipped?: boolean };
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
          return {
            response: "",
            skipped: true,
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
        
        const agent = client.agents[def.agent];
        if (!agent) {
          const availableAgents = Object.keys(client.agents).join(", ") || "(none)";
          throw new Error(`Agent '${def.agent}' not found. Available agents: ${availableAgents}`);
        }

        client.app.log(`Invoking agent: ${def.agent}`, "info");
        const response = await agent.invoke(prompt, { maxTokens: def.maxTokens });
        return { response: response.content };
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

      return { response: response.content };
    },
  });
}

// =============================================================================
// Suspend Step Adapter
// =============================================================================

/**
 * Creates a Mastra step that suspends execution for human approval
 */
export function createSuspendStep(def: SuspendStepDefinition) {
  return createStep({
    id: def.id,
    description: def.description || "Awaiting human input",
    inputSchema: StepInputSchema,
    outputSchema: z.object({
      resumed: z.boolean(),
      data: JsonValueSchema.optional(),
      skipped: z.boolean().optional(),
    }),
    execute: async ({ inputData, suspend, resumeData }) => {
      // If we have resumeData, we're resuming from a suspended state
      if (resumeData !== undefined) {
        // Validate resume data against schema if provided
        if (def.resumeSchema) {
          const schemaKeys = Object.keys(def.resumeSchema);
          const data = resumeData as JsonObject;
          
          if (typeof data !== 'object' || data === null) {
            throw new Error("Resume data must be an object");
          }

          const missing = schemaKeys.filter(k => !(k in data));
          if (missing.length > 0) {
            throw new Error(`Missing required resume data: ${missing.join(", ")}`);
          }
        }

        return {
          resumed: true,
          data: resumeData,
        };
      }

      const data = inputData as StepInput;

      // IDEMPOTENCY CHECK: Skip if this step was already completed (hydration scenario)
      // This prevents re-suspending on steps that were already resumed in a previous run.
      // Without this, workflows with multiple suspend steps would get stuck on the first one
      // when rehydrating after a server restart.
      if (data.steps?.[def.id]) {
        return data.steps[def.id] as { resumed: boolean; data?: JsonValue; skipped?: boolean };
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
          return {
            resumed: false,
            data: undefined,
            skipped: true,
          };
        }
      }

      const message = def.message
        ? interpolate(def.message, ctx)
        : "Workflow paused. Resume to continue.";

      // Suspend and wait for resume
      await suspend({ message });

      // This won't be reached until resumed
      return {
        resumed: true,
        data: undefined,
      };
    },
  });
}

// =============================================================================
// Wait Step Adapter
// =============================================================================

/**
 * Output schema for Wait step
 */
const WaitOutputSchema = z.object({
  completed: z.boolean(),
  durationMs: z.number(),
  skipped: z.boolean().optional(),
});

/**
 * Creates a Mastra step that waits for a specified duration.
 * Useful for waiting for external systems (e.g., waiting for a deployed URL to become live)
 * without suspending for human input.
 * 
 * This is a platform-independent alternative to `shell: sleep 5`.
 */
export function createWaitStep(def: WaitStepDefinition) {
  return createStep({
    id: def.id,
    description: def.description || `Wait ${def.durationMs}ms`,
    inputSchema: StepInputSchema,
    outputSchema: WaitOutputSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepInput;

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-waiting when resuming after restart
      if (data.steps?.[def.id]) {
        return data.steps[def.id] as z.infer<typeof WaitOutputSchema>;
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
          return {
            completed: false,
            durationMs: 0,
            skipped: true,
          };
        }
      }

      // Wait for the specified duration
      await new Promise(resolve => setTimeout(resolve, def.durationMs));

      return {
        completed: true,
        durationMs: def.durationMs,
      };
    },
  });
}

// =============================================================================
// HTTP Step Adapter
// =============================================================================

/**
 * Output schema for HTTP step
 * Includes both parsed body and raw text for flexibility
 */
const HttpOutputSchema = z.object({
  status: z.number(),
  /** Parsed JSON body, or null if response is not valid JSON */
  body: z.unknown(),
  /** Raw response text (useful when JSON parsing fails or for non-JSON responses) */
  text: z.string(),
  headers: z.record(z.string()),
  skipped: z.boolean().optional(),
});

/**
 * Creates a Mastra step that executes an HTTP request
 */
export function createHttpStep(def: HttpStepDefinition) {
  return createStep({
    id: def.id,
    description: def.description || `${def.method} ${def.url}`,
    inputSchema: StepInputSchema,
    outputSchema: HttpOutputSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepInput;

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-execution of side-effects (e.g., API calls) when resuming after restart
      if (data.steps?.[def.id]) {
        return data.steps[def.id] as z.infer<typeof HttpOutputSchema>;
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
          return {
            status: 0,
            body: null,
            text: "",
            headers: {},
            skipped: true,
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
    },
  });
}

// =============================================================================
// File Step Adapter
// =============================================================================

/**
 * Output schema for File step
 */
const FileOutputSchema = z.object({
  content: z.string().optional(),
  success: z.boolean().optional(),
  skipped: z.boolean().optional(),
});

/**
 * Creates a Mastra step that performs file operations
 */
export function createFileStep(def: FileStepDefinition) {
  return createStep({
    id: def.id,
    description: def.description || `File ${def.action}: ${def.path}`,
    inputSchema: StepInputSchema,
    outputSchema: FileOutputSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepInput;

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      // This prevents re-execution of side-effects (e.g., file writes) when resuming after restart
      if (data.steps?.[def.id]) {
        return data.steps[def.id] as z.infer<typeof FileOutputSchema>;
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
          return {
            skipped: true,
          };
        }
      }

      // Interpolate file path and validate for path traversal
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
          // Handle object content (auto-stringify)
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
    },
  });
}

// =============================================================================
// Iterator Step Adapter
// =============================================================================

/**
 * Output schema for Iterator step
 */
const IteratorOutputSchema = z.object({
  results: z.array(z.unknown()),
  count: z.number(),
  skipped: z.boolean().optional(),
});

/**
 * Execute a single step definition with the given context.
 * This is a simplified executor for inner steps within an iterator.
 */
async function executeInnerStep(
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
      
      const options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {};
      
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
      
      try {
        const { stdout, stderr } = await execAsync(command, options);
        return {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: 0,
        };
      } catch (error) {
        const execError = error as { stdout?: string; stderr?: string; code?: number };
        
        if (def.failOnError !== false) {
          throw new Error(
            `Command failed with exit code ${execError.code}: ${execError.stderr || execError.stdout}`
          );
        }
        
        return {
          stdout: execError.stdout?.trim() || "",
          stderr: execError.stderr?.trim() || "",
          exitCode: execError.code || 1,
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
          const availableAgents = Object.keys(client.agents).join(", ") || "(none)";
          throw new Error(`Agent '${def.agent}' not found. Available agents: ${availableAgents}`);
        }
        
        client.app.log(`Invoking agent: ${def.agent}`, "info");
        const response = await agent.invoke(prompt, { maxTokens: def.maxTokens });
        return { response: response.content };
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
    
    case "suspend":
      throw new Error("Suspend steps are not supported within iterators");
    
    case "iterator":
      throw new Error("Nested iterators are not supported");
    
    default:
      throw new Error(`Unknown step type: ${(def as StepDefinition).type}`);
  }
}

/**
 * Creates a Mastra step that iterates over an array and executes a sub-step for each item.
 * 
 * The iterator provides special context variables for each iteration:
 * - {{item}} - The current item being processed
 * - {{index}} - The zero-based index of the current item
 * - {{item.property}} - Access nested properties of the current item
 */
export function createIteratorStep(def: IteratorStepDefinition, client: OpencodeClient) {
  return createStep({
    id: def.id,
    description: def.description || `Iterate over ${def.items}`,
    inputSchema: StepInputSchema,
    outputSchema: IteratorOutputSchema,
    execute: async ({ inputData }) => {
      const data = inputData as StepInput;
      const secretInputs = data.secretInputs || [];

      // IDEMPOTENCY CHECK: Skip if this step was already executed (hydration scenario)
      if (data.steps?.[def.id]) {
        client.app.log(`Skipping already-completed step: ${def.id}`, "info");
        return data.steps[def.id] as z.infer<typeof IteratorOutputSchema>;
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
          return {
            results: [],
            count: 0,
            skipped: true,
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

      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        
        // Create context with item and index available for interpolation
        // We inject these as special inputs that can be accessed via {{item}} and {{index}}
        const iterationCtx = {
          inputs: {
            ...ctx.inputs,
            item,
            index,
          } as Record<string, JsonValue>,
          steps: ctx.steps,
          env: ctx.env,
        };

        // Create a copy of the runStep definition with a generated id if not provided
        const stepDef: StepDefinition = {
          ...def.runStep,
          id: def.runStep.id || `${def.id}-iteration-${index}`,
        } as StepDefinition;

        client.app.log(`[${index + 1}/${items.length}] Processing item`, "info");

        // Execute the inner step with secretInputs for masking
        const result = await executeInnerStep(stepDef, iterationCtx, client, secretInputs);
        results.push(result);
      }

      return {
        results,
        count: items.length,
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
