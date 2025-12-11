import { z } from "zod";

// =============================================================================
// Primitive Types
// =============================================================================

/** JSON-serializable primitive value */
export type JsonPrimitive = string | number | boolean | null;

/** JSON-serializable value (recursive) */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** JSON-serializable object */
export type JsonObject = { [key: string]: JsonValue };

/** Input parameter value types */
export type InputValue = string | number | boolean;

/** Input parameters record */
export type WorkflowInputs = Record<string, InputValue>;

// =============================================================================
// Plugin Configuration
// =============================================================================

export interface WorkflowPluginConfig {
  /** Directory paths to scan for workflow definitions */
  workflowDirs?: string[];
  /** Path to SQLite/LibSQL database for persistence */
  dbPath?: string;
  /** Global timeout for workflow execution (ms) */
  timeout?: number;
  /** Enable verbose logging */
  verbose?: boolean;
}

export const DEFAULT_CONFIG: Required<WorkflowPluginConfig> = {
  workflowDirs: [".opencode/workflows", "~/.config/opencode/workflows"],
  dbPath: ".opencode/data/workflows.db",
  timeout: 300000, // 5 minutes
  verbose: false,
};

// =============================================================================
// Workflow Definition Types (JSON Schema)
// =============================================================================

/** Step types supported by the workflow engine */
export type StepType = "shell" | "tool" | "agent" | "suspend" | "http" | "file";

/** HTTP methods supported by the HTTP step */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** File actions supported by the file step */
export type FileAction = "read" | "write" | "delete";

/** Base step definition */
export interface BaseStepDefinition {
  id: string;
  type: StepType;
  description?: string;
  /** Step IDs that must complete before this step runs */
  after?: string[];
  /** Condition expression to determine if step should run */
  condition?: string;
  /** Step-specific timeout in ms */
  timeout?: number;
  /** Retry configuration */
  retry?: {
    attempts: number;
    delay?: number;
  };
}

/** Shell command step */
export interface ShellStepDefinition extends BaseStepDefinition {
  type: "shell";
  command: string;
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Whether to fail the workflow if command exits non-zero */
  failOnError?: boolean;
}

/** Opencode tool invocation step */
export interface ToolStepDefinition extends BaseStepDefinition {
  type: "tool";
  tool: string;
  args?: JsonObject;
}

/** LLM agent prompt step */
export interface AgentStepDefinition extends BaseStepDefinition {
  type: "agent";
  prompt: string;
  model?: string;
  /** System prompt override */
  system?: string;
  /** Max tokens for response */
  maxTokens?: number;
}

/** Suspend step for human-in-the-loop */
export interface SuspendStepDefinition extends BaseStepDefinition {
  type: "suspend";
  /** Message to display when suspending */
  message?: string;
  /** Schema for expected resume data (JSON Schema format) */
  resumeSchema?: JsonObject;
}

/** HTTP request step for API calls */
export interface HttpStepDefinition extends BaseStepDefinition {
  type: "http";
  /** HTTP method */
  method: HttpMethod;
  /** URL to request (supports interpolation) */
  url: string;
  /** Request headers (supports interpolation) */
  headers?: Record<string, string>;
  /** Request body (for POST/PUT/PATCH) */
  body?: JsonValue;
  /** Whether to fail the workflow if response is not OK (default: true) */
  failOnError?: boolean;
}

/** File operations step for platform-independent file handling */
export interface FileStepDefinition extends BaseStepDefinition {
  type: "file";
  /** File operation action */
  action: FileAction;
  /** File path (supports interpolation) */
  path: string;
  /** Content to write (for write action, supports interpolation) */
  content?: string | JsonValue;
}

/** Union of all step definition types */
export type StepDefinition =
  | ShellStepDefinition
  | ToolStepDefinition
  | AgentStepDefinition
  | SuspendStepDefinition
  | HttpStepDefinition
  | FileStepDefinition;

/** Complete workflow definition */
export interface WorkflowDefinition {
  id: string;
  name?: string;
  description?: string;
  /** Version of the workflow definition */
  version?: string;
  /** Input parameters schema - maps param name to type name */
  inputs?: Record<string, "string" | "number" | "boolean">;
  /** Ordered list of steps */
  steps: StepDefinition[];
  /** Tags for categorization */
  tags?: string[];
  /** Trigger configuration */
  trigger?: {
    /** Auto-run on specific events */
    event?: string;
    /** Cron schedule */
    schedule?: string;
  };
}

// =============================================================================
// Runtime Types
// =============================================================================

/** Workflow execution status */
export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled";

/** Shell step output */
export interface ShellStepOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  skipped?: boolean;
}

/** Tool step output */
export interface ToolStepOutput {
  result: JsonValue;
  skipped?: boolean;
}

/** Agent step output */
export interface AgentStepOutput {
  response: string;
  skipped?: boolean;
}

/** Suspend step output */
export interface SuspendStepOutput {
  resumed: boolean;
  data?: JsonValue;
  skipped?: boolean;
}

/** HTTP step output */
export interface HttpStepOutput {
  status: number;
  /** Parsed JSON body, or null if response is not valid JSON */
  body: JsonValue;
  /** Raw response text (useful when JSON parsing fails or for non-JSON responses) */
  text: string;
  headers: Record<string, string>;
  skipped?: boolean;
}

/** File step output */
export interface FileStepOutput {
  /** Content read from file (for read action) */
  content?: string;
  /** Success indicator (for write/delete actions) */
  success?: boolean;
  skipped?: boolean;
}

/** Union of all step output types */
export type StepOutput = 
  | ShellStepOutput 
  | ToolStepOutput 
  | AgentStepOutput 
  | SuspendStepOutput
  | HttpStepOutput
  | FileStepOutput;

/** Step execution result */
export interface StepResult {
  stepId: string;
  status: "success" | "failed" | "skipped";
  output?: StepOutput;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  duration?: number;
}

/** Workflow run record */
export interface WorkflowRun {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  inputs: WorkflowInputs;
  stepResults: Record<string, StepResult>;
  currentStepId?: string;
  suspendedData?: JsonValue;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

/** Context passed during step execution */
export interface StepExecutionContext {
  /** Workflow inputs */
  inputs: WorkflowInputs;
  /** Results from previous steps (stepId -> output) */
  steps: Record<string, StepOutput>;
  /** Opencode client reference */
  client: OpencodeClient;
  /** Shell executor */
  shell: ShellExecutor;
  /** Logging utilities */
  log: Logger;
}

// =============================================================================
// External Dependencies (from Opencode)
// =============================================================================

/** Opencode client interface (subset of actual client) */
export interface OpencodeClient {
  tools: Record<string, {
    execute: (args: JsonObject) => Promise<JsonValue>;
  }>;
  llm: {
    chat: (options: {
      model?: string;
      messages: Array<{ role: string; content: string }>;
      maxTokens?: number;
    }) => Promise<{ content: string }>;
  };
  app: {
    log: (message: string, level?: "info" | "warn" | "error") => void;
  };
}

/** Shell command executor */
export type ShellExecutor = (
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  }
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/** Logger interface */
export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
}

// =============================================================================
// Zod Schemas for Validation
// =============================================================================

/** Zod schema for JSON values (recursive) */
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

export const BaseStepSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["shell", "tool", "agent", "suspend", "http", "file"]),
  description: z.string().optional(),
  after: z.array(z.string()).optional(),
  condition: z.string().optional(),
  timeout: z.number().positive().optional(),
  retry: z.object({
    attempts: z.number().int().positive(),
    delay: z.number().positive().optional(),
  }).optional(),
});

export const ShellStepSchema = BaseStepSchema.extend({
  type: z.literal("shell"),
  command: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  failOnError: z.boolean().optional().default(true),
});

export const ToolStepSchema = BaseStepSchema.extend({
  type: z.literal("tool"),
  tool: z.string().min(1),
  args: z.record(JsonValueSchema).optional(),
});

export const AgentStepSchema = BaseStepSchema.extend({
  type: z.literal("agent"),
  prompt: z.string().min(1),
  model: z.string().optional(),
  system: z.string().optional(),
  maxTokens: z.number().positive().optional(),
});

export const SuspendStepSchema = BaseStepSchema.extend({
  type: z.literal("suspend"),
  message: z.string().optional(),
  resumeSchema: z.record(JsonValueSchema).optional(),
});

export const HttpStepSchema = BaseStepSchema.extend({
  type: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: JsonValueSchema.optional(),
  failOnError: z.boolean().optional().default(true),
});

export const FileStepSchema = BaseStepSchema.extend({
  type: z.literal("file"),
  action: z.enum(["read", "write", "delete"]),
  path: z.string().min(1),
  content: z.union([z.string(), JsonValueSchema]).optional(),
});

export const StepSchema = z.discriminatedUnion("type", [
  ShellStepSchema,
  ToolStepSchema,
  AgentStepSchema,
  SuspendStepSchema,
  HttpStepSchema,
  FileStepSchema,
]);

export const WorkflowDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  inputs: z.record(z.enum(["string", "number", "boolean"])).optional(),
  steps: z.array(StepSchema).min(1),
  tags: z.array(z.string()).optional(),
  trigger: z.object({
    event: z.string().optional(),
    schedule: z.string().optional(),
  }).optional(),
});

// =============================================================================
// Plugin Hook Types
// =============================================================================

export interface WorkflowEventPayload {
  workflowId: string;
  runId: string;
  status: WorkflowRunStatus;
  stepId?: string;
  error?: string;
}

export interface WorkflowRegistry {
  workflows: Map<string, WorkflowDefinition>;
  runs: Map<string, WorkflowRun>;
  
  getWorkflow(id: string): WorkflowDefinition | undefined;
  listWorkflows(): WorkflowDefinition[];
  getRun(runId: string): WorkflowRun | undefined;
  listRuns(workflowId?: string): WorkflowRun[];
}
