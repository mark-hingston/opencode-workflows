import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, extname, basename } from "node:path";
import { homedir } from "node:os";
import stripJsonComments from "strip-json-comments";
import {
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  DEFAULT_CONFIG,
  type Logger,
} from "../types.js";

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

      // Only process JSON files for now
      // TypeScript workflow files would require dynamic import
      if (ext === ".json" || ext === ".jsonc") {
        try {
          const workflow = await loadJsonWorkflow(filePath, log);
          if (workflow) {
            workflows.push(workflow);
            log.info(`Loaded workflow: ${workflow.id} from ${entry.name}`);
          }
        } catch (error) {
          log.error(`Failed to load workflow from ${entry.name}: ${error}`);
        }
      } else if (ext === ".ts" || ext === ".js") {
        // TypeScript/JavaScript workflow files would need bundling/transpilation
        // For now, log a warning
        log.warn(
          `TypeScript/JS workflow files not yet supported: ${entry.name}`
        );
      }
    }
  } catch (error) {
    log.error(`Failed to scan directory ${absolutePath}: ${error}`);
  }

  return workflows;
}

/**
 * Loads and validates a JSON workflow definition
 */
async function loadJsonWorkflow(
  filePath: string,
  log: Logger
): Promise<WorkflowDefinition | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    
    // Strip comments before parsing to support JSONC
    const cleanJson = stripJsonComments(content);
    const json = JSON.parse(cleanJson);

    // Validate against schema
    const result = WorkflowDefinitionSchema.safeParse(json);

    if (!result.success) {
      log.error(`Invalid workflow schema in ${filePath}:`);
      for (const issue of result.error.issues) {
        log.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      }
      return null;
    }

    const workflow = result.data;

    // Validate step dependencies
    const stepIds = new Set(workflow.steps.map((s) => s.id));
    for (const step of workflow.steps) {
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
    } else {
      throw error;
    }
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
 * Creates a simple console logger
 */
export function createLogger(verbose = false): Logger {
  return {
    info: (msg) => console.log(`[workflow] ${msg}`),
    warn: (msg) => console.warn(`[workflow] ${msg}`),
    error: (msg) => console.error(`[workflow] ${msg}`),
    debug: (msg) => {
      if (verbose) console.log(`[workflow:debug] ${msg}`);
    },
  };
}
