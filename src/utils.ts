/**
 * Utility exports for opencode-workflows
 * 
 * This module provides utility functions, classes, and constants that can be
 * used by consumers who need programmatic access to workflow functionality.
 * 
 * Import from "opencode-workflows/utils" to access these exports.
 * 
 * @example
 * ```ts
 * import { WorkflowFactory, loadWorkflows } from "opencode-workflows/utils"
 * ```
 */

// Configuration
export { DEFAULT_CONFIG } from "./types.js";

// Loader utilities
export { loadWorkflows, createLogger, topologicalSort } from "./loader/index.js";

// Factory
export { WorkflowFactory, createWorkflowFromDefinition } from "./factory/index.js";

// Commands and runner
export { 
  WorkflowRunner, 
  handleWorkflowCommand,
  type WorkflowCommandContext,
  type WorkflowCommandResult,
  type WorkflowRunnerConfig,
} from "./commands/index.js";

// Storage
export { WorkflowStorage, type StorageConfig } from "./storage/index.js";

// Tool utilities
export {
  WorkflowToolSchema,
  executeWorkflowTool,
  getWorkflowToolDefinition,
  type WorkflowToolInput,
  type WorkflowToolResult,
} from "./tools/index.js";

// Re-export all types
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

// Zod schemas for validation (consumers may want to validate workflow definitions)
export {
  JsonValueSchema,
  BaseStepSchema,
  ShellStepSchema,
  ToolStepSchema,
  AgentStepSchema,
  SuspendStepSchema,
  WaitStepSchema,
  HttpStepSchema,
  FileStepSchema,
  IteratorStepSchema,
  StepSchema,
  WorkflowTriggerSchema,
  WorkflowDefinitionSchema,
} from "./types.js";
