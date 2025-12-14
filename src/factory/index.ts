import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import type {
  WorkflowDefinition,
  StepDefinition,
  OpencodeClient,
  InputTypeName,
} from "../types.js";
import {
  createShellStep,
  createToolStep,
  createAgentStep,
  createSuspendStep,
  createHttpStep,
  createFileStep,
  createIteratorStep,
  createEvalStep,
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
  /** Input schema for the workflow (maps param name to type) */
  inputSchema?: Record<string, InputTypeName>;
  /** List of input names that are marked as secrets */
  secrets?: string[];
  /** Steps to execute when the workflow fails (before finally) */
  onFailureSteps?: StepDefinition[];
  /** Steps to execute after workflow completes (always runs) */
  finallySteps?: StepDefinition[];
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
    switch (type) {
      case "string":
        shape[key] = z.string();
        break;
      case "number":
        shape[key] = z.number();
        break;
      case "boolean":
        shape[key] = z.boolean();
        break;
      case "object":
        // Accept any JSON object
        shape[key] = z.record(z.unknown());
        break;
      case "array":
        // Accept any JSON array
        shape[key] = z.array(z.unknown());
        break;
      default:
        // Default to unknown for unrecognized types (shouldn't happen with schema validation)
        shape[key] = z.unknown();
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
    case "iterator":
      return createIteratorStep(def, client);
    case "eval":
      return createEvalStep(def, client);
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
      secretInputs: z.array(z.string()).optional(),
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
    inputSchema: definition.inputs,
    secrets: definition.secrets,
    onFailureSteps: definition.onFailure,
    finallySteps: definition.finally,
  };
}

/**
 * Workflow registry that holds compiled workflows
 */
export class WorkflowFactory {
  private compiledWorkflows = new Map<string, WorkflowFactoryResult>();
  private definitions = new Map<string, WorkflowDefinition>();

  constructor(private client: OpencodeClient) {}

  /**
   * Get the OpenCode client instance.
   * Used by the runner to execute cleanup steps (onFailure, finally).
   */
  getClient(): OpencodeClient {
    return this.client;
  }

  /**
   * Register a workflow definition for lazy compilation.
   * The workflow will be compiled on first access via get().
   */
  register(definition: WorkflowDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  /**
   * Compile a workflow definition into a Mastra workflow.
   * This is now primarily used for immediate compilation when needed.
   */
  compile(definition: WorkflowDefinition): WorkflowFactoryResult {
    const result = createWorkflowFromDefinition(definition, this.client);
    this.compiledWorkflows.set(definition.id, result);
    return result;
  }

  /**
   * Get a compiled workflow by ID.
   * If the workflow hasn't been compiled yet, it will be compiled on-demand.
   */
  get(id: string): WorkflowFactoryResult | undefined {
    // Check if already compiled
    let compiled = this.compiledWorkflows.get(id);
    
    if (!compiled) {
      // Lazy compile: check if we have a definition
      const definition = this.definitions.get(id);
      if (definition) {
        compiled = this.compile(definition);
      }
    }
    
    return compiled;
  }

  /**
   * Check if a workflow is available (either compiled or has a definition)
   */
  has(id: string): boolean {
    return this.compiledWorkflows.has(id) || this.definitions.has(id);
  }

  /**
   * List all available workflow IDs (both compiled and registered)
   */
  list(): string[] {
    const ids = new Set<string>();
    for (const id of this.compiledWorkflows.keys()) {
      ids.add(id);
    }
    for (const id of this.definitions.keys()) {
      ids.add(id);
    }
    return Array.from(ids);
  }

  /**
   * Clear all compiled workflows and definitions
   */
  clear(): void {
    this.compiledWorkflows.clear();
    this.definitions.clear();
  }

  /**
   * Register multiple workflow definitions for lazy compilation
   */
  registerAll(definitions: WorkflowDefinition[]): void {
    for (const def of definitions) {
      this.register(def);
    }
  }

  /**
   * Compile multiple workflow definitions immediately (legacy method)
   */
  compileAll(definitions: WorkflowDefinition[]): void {
    for (const def of definitions) {
      this.compile(def);
    }
  }
}
