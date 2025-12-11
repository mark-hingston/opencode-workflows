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
  HttpStepDefinition,
  FileStepDefinition,
  OpencodeClient,
  JsonValue,
  JsonObject,
} from "../types.js";
import { interpolate, interpolateValue } from "./interpolation.js";

const execAsync = promisify(exec);

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
 * Zod schema for JSON values (recursive)
 */
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);

/**
 * Input schema for step execution context
 */
const StepInputSchema = z.object({
  inputs: z.record(z.union([z.string(), z.number(), z.boolean()])),
  steps: z.record(JsonValueSchema),
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

      // Interpolate variables in the command
      const command = interpolate(def.command, ctx);
      
      // Security check: Log warnings for potentially dangerous patterns
      const safetyWarnings = checkCommandSafety(command);
      for (const warning of safetyWarnings) {
        client.app.log(`[SECURITY WARNING] ${warning}`, "warn");
      }
      
      // Log command execution to TUI
      client.app.log(`> ${command}`, "info");

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
          body = JSON.stringify(def.body);
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
