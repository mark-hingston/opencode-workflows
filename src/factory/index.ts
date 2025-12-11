import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import type {
  WorkflowDefinition,
  StepDefinition,
  OpencodeClient,
} from "../types.js";
import {
  createShellStep,
  createToolStep,
  createAgentStep,
  createSuspendStep,
  createHttpStep,
  createFileStep,
} from "../adapters/index.js";
import { topologicalSort } from "../loader/index.js";

// Use any for complex Mastra types to avoid generics issues
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Result from workflow factory
 */
export interface WorkflowFactoryResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workflow: unknown;
  id: string;
  description?: string;
}

/**
 * Build a Zod schema from workflow input definitions
 */
function buildInputSchema(
  inputs?: WorkflowDefinition["inputs"]
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  if (!inputs || Object.keys(inputs).length === 0) {
    return z.object({});
  }

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, type] of Object.entries(inputs)) {
    if (type === "string") {
      shape[key] = z.string();
    } else if (type === "number") {
      shape[key] = z.number();
    } else if (type === "boolean") {
      shape[key] = z.boolean();
    } else {
      // Default to string for any unrecognized type
      shape[key] = z.string();
    }
  }

  return z.object(shape);
}

/**
 * Create a Mastra step from a step definition
 */
function createMastraStep(def: StepDefinition, client: OpencodeClient): unknown {
  switch (def.type) {
    case "shell":
      return createShellStep(def, client);
    case "tool":
      return createToolStep(def, client);
    case "agent":
      return createAgentStep(def, client);
    case "suspend":
      return createSuspendStep(def);
    case "http":
      return createHttpStep(def);
    case "file":
      return createFileStep(def);
    default:
      throw new Error(`Unknown step type: ${(def as StepDefinition).type}`);
  }
}

/**
 * Group steps by their level in the DAG (for parallel execution).
 * Uses iterative approach with memoization to avoid stack overflow on deep workflows.
 */
function groupStepsByLevel(steps: StepDefinition[]): StepDefinition[][] {
  const levels: StepDefinition[][] = [];
  const stepLevels = new Map<string, number>();
  const stepMap = new Map<string, StepDefinition>();

  for (const step of steps) {
    stepMap.set(step.id, step);
  }

  /**
   * Calculate level for a step iteratively to avoid stack overflow.
   * Uses a stack-based approach instead of recursion.
   */
  function getLevel(startStepId: string): number {
    // If already computed, return cached value
    if (stepLevels.has(startStepId)) {
      return stepLevels.get(startStepId) ?? 0;
    }

    // Stack of steps to process (step ID, visited flag for post-order processing)
    const stack: Array<{ stepId: string; phase: "pre" | "post" }> = [
      { stepId: startStepId, phase: "pre" },
    ];
    
    // Track steps currently being processed to detect cycles
    const inProgress = new Set<string>();
    
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      
      const { stepId, phase } = current;
      
      // Check if already computed
      if (stepLevels.has(stepId)) {
        continue;
      }
      
      const step = stepMap.get(stepId);
      
      if (phase === "pre") {
        // First visit: push for post-processing and push dependencies
        if (!step?.after || step.after.length === 0) {
          // No dependencies, level is 0
          stepLevels.set(stepId, 0);
          continue;
        }
        
        // Check if all dependencies are computed
        const allDepsComputed = step.after.every((dep) => stepLevels.has(dep));
        
        if (allDepsComputed) {
          // Compute level from dependencies
          const maxDepLevel = Math.max(...step.after.map((dep) => stepLevels.get(dep) ?? 0));
          stepLevels.set(stepId, maxDepLevel + 1);
        } else {
          // Push self for post-processing
          stack.push({ stepId, phase: "post" });
          inProgress.add(stepId);
          
          // Push uncomputed dependencies
          for (const dep of step.after) {
            if (!stepLevels.has(dep) && !inProgress.has(dep)) {
              stack.push({ stepId: dep, phase: "pre" });
            }
          }
        }
      } else {
        // Post-processing: all dependencies should now be computed
        inProgress.delete(stepId);
        
        if (!step?.after || step.after.length === 0) {
          stepLevels.set(stepId, 0);
        } else {
          const maxDepLevel = Math.max(...step.after.map((dep) => stepLevels.get(dep) ?? 0));
          stepLevels.set(stepId, maxDepLevel + 1);
        }
      }
    }
    
    return stepLevels.get(startStepId) ?? 0;
  }

  // Calculate levels for all steps
  for (const step of steps) {
    getLevel(step.id);
  }

  // Group by level
  for (const step of steps) {
    const level = stepLevels.get(step.id) ?? 0;
    while (levels.length <= level) {
      levels.push([]);
    }
    levels[level].push(step);
  }

  return levels;
}

/**
 * Factory function to create a Mastra Workflow from a JSON definition
 */
export function createWorkflowFromDefinition(
  definition: WorkflowDefinition,
  client: OpencodeClient
): WorkflowFactoryResult {
  // Build input schema
  const inputSchema = buildInputSchema(definition.inputs);

  // Topologically sort steps
  const sortedSteps = topologicalSort(definition.steps);

  // Group steps by level for potential parallel execution
  const stepLevels = groupStepsByLevel(sortedSteps);

  // Create the base workflow with schemas
  const workflow = createWorkflow({
    id: definition.id,
    inputSchema: z.object({
      inputs: inputSchema,
      steps: z.record(z.unknown()).default({}),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      outputs: z.record(z.unknown()),
    }),
  });

  // Build the workflow chain - use interface to type the chainable workflow
  interface ChainableWorkflow {
    then: (step: unknown) => ChainableWorkflow;
    parallel: (steps: unknown[]) => ChainableWorkflow;
    commit: () => void;
  }
  let chain: ChainableWorkflow = workflow as ChainableWorkflow;
  
  for (const level of stepLevels) {
    if (level.length === 1) {
      // Single step at this level - chain it
      const step = createMastraStep(level[0], client);
      chain = chain.then(step);
    } else if (level.length > 1) {
      // Multiple steps at this level - run in parallel
      const parallelSteps = level.map((def) => createMastraStep(def, client));
      chain = chain.parallel(parallelSteps);
    }
  }

  // Commit the workflow
  chain.commit();

  return {
    workflow,
    id: definition.id,
    description: definition.description,
  };
}

/**
 * Workflow registry that holds compiled workflows
 */
export class WorkflowFactory {
  private compiledWorkflows = new Map<string, WorkflowFactoryResult>();

  constructor(private client: OpencodeClient) {}

  /**
   * Compile a workflow definition into a Mastra workflow
   */
  compile(definition: WorkflowDefinition): WorkflowFactoryResult {
    const result = createWorkflowFromDefinition(definition, this.client);
    this.compiledWorkflows.set(definition.id, result);
    return result;
  }

  /**
   * Get a compiled workflow by ID
   */
  get(id: string): WorkflowFactoryResult | undefined {
    return this.compiledWorkflows.get(id);
  }

  /**
   * Check if a workflow is compiled
   */
  has(id: string): boolean {
    return this.compiledWorkflows.has(id);
  }

  /**
   * List all compiled workflow IDs
   */
  list(): string[] {
    return Array.from(this.compiledWorkflows.keys());
  }

  /**
   * Clear all compiled workflows
   */
  clear(): void {
    this.compiledWorkflows.clear();
  }

  /**
   * Compile multiple workflow definitions
   */
  compileAll(definitions: WorkflowDefinition[]): void {
    for (const def of definitions) {
      this.compile(def);
    }
  }
}
