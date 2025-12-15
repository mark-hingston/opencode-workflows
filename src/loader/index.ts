import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, extname, basename } from "node:path";
import { homedir } from "node:os";
import { createJiti } from "jiti";
import stripJsonComments from "strip-json-comments";
import yaml from "js-yaml";
import {
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  DEFAULT_CONFIG,
  type Logger,
  type LoggerOptions,
  type LogContext,
  type StructuredLogEntry,
} from "../types.js";

// Create a jiti instance for loading TypeScript/JavaScript workflow files
// This allows importing .ts files without a build step
const jiti = createJiti(import.meta.url, {
  // Use native ESM resolution
  interopDefault: true,
  // Enable TypeScript support
  extensions: [".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"],
});

/**
 * Expands ~ to home directory in paths
 */
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Checks if a path exists and is a directory
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scans a directory for workflow definition files
 */
async function scanDirectory(
  dir: string,
  log: Logger
): Promise<WorkflowDefinition[]> {
  const workflows: WorkflowDefinition[] = [];
  const expandedPath = expandPath(dir);
  const absolutePath = resolve(expandedPath);

  if (!(await isDirectory(absolutePath))) {
    log.debug(`Workflow directory not found: ${absolutePath}`);
    return workflows;
  }

  log.debug(`Scanning workflow directory: ${absolutePath}`);

  try {
    const entries = await readdir(absolutePath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      const filePath = join(absolutePath, entry.name);

      // Support JSON, JSONC, YAML, and YML
      if ([".json", ".jsonc", ".yaml", ".yml"].includes(ext)) {
        try {
          const workflow = await loadDataWorkflow(filePath, log);
          if (workflow) {
            workflows.push(workflow);
            log.info(`Loaded workflow: ${workflow.id} from ${entry.name}`);
          }
        } catch (error) {
          log.error(`Failed to load workflow from ${entry.name}: ${error}`);
        }
      } else if (ext === ".ts" || ext === ".js" || ext === ".mts" || ext === ".mjs") {
        try {
          const workflow = await loadTsWorkflow(filePath, log);
          if (workflow) {
            workflows.push(workflow);
            log.info(`Loaded TypeScript workflow: ${workflow.id} from ${entry.name}`);
          }
        } catch (error) {
          log.error(`Failed to load TypeScript workflow from ${entry.name}: ${error}`);
        }
      }
    }
  } catch (error) {
    log.error(`Failed to scan directory ${absolutePath}: ${error}`);
  }

  return workflows;
}

/**
 * Loads and validates a workflow definition from JSON, JSONC, or YAML
 */
async function loadDataWorkflow(
  filePath: string,
  log: Logger
): Promise<WorkflowDefinition | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const ext = extname(filePath).toLowerCase();

    let parsed: unknown;

    if (ext === ".yaml" || ext === ".yml") {
      // Parse YAML
      parsed = yaml.load(content);
    } else {
      // Parse JSON/JSONC - strip comments before parsing
      const cleanJson = stripJsonComments(content);
      parsed = JSON.parse(cleanJson);
    }

    // Validate against schema
    const result = WorkflowDefinitionSchema.safeParse(parsed);

    if (!result.success) {
      log.error(`Invalid workflow schema in ${filePath}:`);
      for (const issue of result.error.issues) {
        log.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      }
      return null;
    }

    const workflow = result.data;

    // Validate step dependencies and enforce strict sequential execution
    // unless explicit parallel execution is requested via empty "after" array.
    const stepIds = new Set(workflow.steps.map((s) => s.id));

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];

      // If "after" is not defined at all, imply dependency on the previous step
      // This makes the list sequential by default (top-to-bottom execution)
      if (typeof step.after === "undefined") {
        if (i > 0) {
          // Determine previous step to depend on
          const prevStep = workflow.steps[i - 1];
          step.after = [prevStep.id];
        } else {
          // First step has no dependencies
          step.after = [];
        }
      }

      // Validate explicit dependencies
      if (step.after) {
        for (const dep of step.after) {
          if (!stepIds.has(dep)) {
            log.error(
              `Step "${step.id}" depends on unknown step "${dep}" in ${filePath}`
            );
            return null;
          }
        }
      }
    }

    // Check for circular dependencies
    if (hasCircularDependencies(workflow.steps)) {
      log.error(`Circular dependencies detected in ${filePath}`);
      return null;
    }

    // Use filename as ID if not provided
    if (!workflow.id) {
      workflow.id = basename(filePath, extname(filePath));
    }

    return workflow as WorkflowDefinition;
  } catch (error) {
    if (error instanceof SyntaxError) {
      log.error(`Invalid JSON in ${filePath}: ${error.message}`);
    } else if ((error as { name?: string }).name === "YAMLException") {
      log.error(`Invalid YAML in ${filePath}: ${(error as Error).message}`);
    } else {
      throw error;
    }
    return null;
  }
}

/**
 * Loads and validates a TypeScript or JavaScript workflow definition.
 * 
 * The file can export:
 * - A default export of a WorkflowDefinition object
 * - A default export of a function that returns a WorkflowDefinition (sync or async)
 * 
 * @example
 * // Type-safe TypeScript workflow
 * import type { WorkflowDefinition } from "opencode-workflows";
 * 
 * const workflow: WorkflowDefinition = {
 *   id: "my-workflow",
 *   steps: [{ id: "step1", type: "shell", command: "echo hello" }]
 * };
 * 
 * export default workflow;
 * 
 * @example
 * // Dynamic workflow generation
 * import type { WorkflowDefinition } from "opencode-workflows";
 * 
 * export default async function(): Promise<WorkflowDefinition> {
 *   const config = await loadConfig();
 *   return {
 *     id: "dynamic-workflow",
 *     steps: config.tasks.map(task => ({
 *       id: task.id,
 *       type: "shell",
 *       command: task.command,
 *     })),
 *   };
 * }
 */
async function loadTsWorkflow(
  filePath: string,
  log: Logger
): Promise<WorkflowDefinition | null> {
  try {
    // Use jiti to import the TypeScript/JavaScript file
    const module = await jiti.import(filePath);

    // Get the default export (handles both ESM and CJS)
    const exported = (module as { default?: unknown }).default ?? module;

    let workflow: unknown;

    // If the export is a function, call it to get the workflow definition
    if (typeof exported === "function") {
      log.debug(`Workflow file exports a function, executing it: ${filePath}`);
      workflow = await exported();
    } else {
      workflow = exported;
    }

    // Validate against schema
    const result = WorkflowDefinitionSchema.safeParse(workflow);

    if (!result.success) {
      log.error(`Invalid workflow schema in ${filePath}:`);
      for (const issue of result.error.issues) {
        log.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      }
      return null;
    }

    const validatedWorkflow = result.data;

    // Validate step dependencies
    const stepIds = new Set(validatedWorkflow.steps.map((s) => s.id));
    for (const step of validatedWorkflow.steps) {
      if (step.after) {
        for (const dep of step.after) {
          if (!stepIds.has(dep)) {
            log.error(
              `Step "${step.id}" depends on unknown step "${dep}" in ${filePath}`
            );
            return null;
          }
        }
      }
    }

    // Check for circular dependencies
    if (hasCircularDependencies(validatedWorkflow.steps)) {
      log.error(`Circular dependencies detected in ${filePath}`);
      return null;
    }

    // Use filename as ID if not provided
    if (!validatedWorkflow.id) {
      validatedWorkflow.id = basename(filePath, extname(filePath));
    }

    return validatedWorkflow as WorkflowDefinition;
  } catch (error) {
    log.error(`Failed to load TypeScript workflow ${filePath}: ${error}`);
    return null;
  }
}

/**
 * Detects circular dependencies using DFS
 */
function hasCircularDependencies(
  steps: WorkflowDefinition["steps"]
): boolean {
  const graph = new Map<string, string[]>();

  // Build adjacency list
  for (const step of steps) {
    graph.set(step.id, step.after || []);
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);

    const dependencies = graph.get(nodeId) || [];
    for (const dep of dependencies) {
      if (!visited.has(dep)) {
        if (dfs(dep)) return true;
      } else if (recursionStack.has(dep)) {
        return true; // Cycle detected
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  for (const step of steps) {
    if (!visited.has(step.id)) {
      if (dfs(step.id)) return true;
    }
  }

  return false;
}

/**
 * Topologically sorts steps based on dependencies
 */
export function topologicalSort(
  steps: WorkflowDefinition["steps"]
): WorkflowDefinition["steps"] {
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const stepMap = new Map<string, (typeof steps)[0]>();

  // Initialize
  for (const step of steps) {
    stepMap.set(step.id, step);
    inDegree.set(step.id, 0);
    graph.set(step.id, []);
  }

  // Build graph (reverse edges for topological sort)
  for (const step of steps) {
    if (step.after) {
      for (const dep of step.after) {
        graph.get(dep)?.push(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) || 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  const sorted: (typeof steps)[0][] = [];

  // Start with nodes that have no dependencies
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const step = stepMap.get(current);
    if (!step) continue;
    sorted.push(step);

    for (const neighbor of graph.get(current) || []) {
      const newDegree = (inDegree.get(neighbor) || 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  return sorted;
}

/**
 * Workflow loader result
 */
export interface LoaderResult {
  workflows: Map<string, WorkflowDefinition>;
  errors: string[];
}

/**
 * Loads all workflows from configured directories
 */
export async function loadWorkflows(
  projectDir: string,
  log: Logger,
  configDirs: string[] = DEFAULT_CONFIG.workflowDirs
): Promise<LoaderResult> {
  const workflows = new Map<string, WorkflowDefinition>();
  const errors: string[] = [];

  // Process directories in order (project-local takes precedence)
  const dirsToScan = configDirs.map((dir) =>
    dir.startsWith("~") ? dir : join(projectDir, dir)
  );

  for (const dir of dirsToScan) {
    try {
      const loadedWorkflows = await scanDirectory(dir, log);

      for (const workflow of loadedWorkflows) {
        if (workflows.has(workflow.id)) {
          log.warn(
            `Workflow "${workflow.id}" already loaded, skipping duplicate from ${dir}`
          );
          continue;
        }
        workflows.set(workflow.id, workflow);
      }
    } catch (error) {
      const msg = `Failed to load workflows from ${dir}: ${error}`;
      errors.push(msg);
      log.error(msg);
    }
  }

  log.info(`Loaded ${workflows.size} workflow(s) total`);

  return { workflows, errors };
}

/**
 * Creates a structured logger with support for JSON or text output.
 * 
 * @param options - Logger configuration options
 * @returns A Logger instance
 * 
 * @example
 * // Simple text logger (default)
 * const log = createLogger({ verbose: true });
 * 
 * @example
 * // JSON structured logging for production
 * const log = createLogger({ format: 'json' });
 * 
 * @example
 * // Custom output handler
 * const log = createLogger({
 *   output: (entry) => sendToLogAggregator(entry)
 * });
 */
// LoggerOptions is imported from types.ts

export function createLogger(options: LoggerOptions | boolean = {}): Logger {
  // Handle legacy boolean parameter for backwards compatibility
  const opts: LoggerOptions = typeof options === 'boolean'
    ? { verbose: options }
    : options;

  const { verbose = false, format = "text", output, console: enableConsole = true } = opts;

  /**
   * Emit a log entry using the configured format and output
   */
  const emit = (
    level: StructuredLogEntry["level"],
    message: string,
    context?: LogContext
  ): void => {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };

    // If custom output handler is provided, use it
    if (output) {
      output(entry);
      return;
    }

    // Format and output based on configuration
    if (enableConsole) {
      if (format === "json") {
        // Structured JSON output for log aggregation/parsing
        const logFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        logFn(JSON.stringify(entry));
      } else {
        // Human-readable text format
        const contextParts = [
          entry.workflowId && `workflow=${entry.workflowId}`,
          entry.runId && `run=${entry.runId.slice(0, 8)}`,
          entry.stepId && `step=${entry.stepId}`,
          entry.durationMs !== undefined && `duration=${entry.durationMs}ms`,
        ].filter(Boolean);

        const contextStr = contextParts.length > 0 ? ` [${contextParts.join(" ")}]` : "";
        const prefix = `[workflow] [${level.toUpperCase()}]`;

        const logFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        logFn(`${prefix}${contextStr} ${message}`);
      }
    }
  };

  return {
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
    debug: (msg, ctx) => {
      if (verbose) emit("debug", msg, ctx);
    },
  };
}
