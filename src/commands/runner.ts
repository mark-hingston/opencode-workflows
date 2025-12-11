import { randomUUID } from "node:crypto";
import type { WorkflowRun, Logger, WorkflowInputs, JsonValue, StepOutput, StepResult } from "../types.js";
import type { WorkflowFactory, WorkflowFactoryResult } from "../factory/index.js";
import type { WorkflowStorage } from "../storage/index.js";

/**
 * Configuration options for WorkflowRunner
 */
export interface WorkflowRunnerConfig {
  /** Global timeout for workflow execution in milliseconds (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Maximum number of completed runs to keep in memory (default: 1000) */
  maxCompletedRuns?: number;
  /** Whether to throw on persistence failures (default: false) */
  throwOnPersistenceError?: boolean;
}

/**
 * Step result shape from Mastra workflow execution
 */
interface MastraStepResult {
  status?: string;
  output?: StepOutput;
}

/**
 * Result shape from Mastra workflow execution
 */
interface MastraWorkflowResult {
  status?: string;
  steps?: Record<string, MastraStepResult>;
}

/**
 * Interface for Mastra Run object
 */
interface MastraRun {
  start: (opts: { inputData: { inputs: WorkflowInputs; steps: Record<string, StepOutput> } }) => Promise<MastraWorkflowResult>;
  resume?: (opts: { stepId: string; data?: JsonValue }) => Promise<MastraWorkflowResult>;
}

/**
 * Interface for workflow with createRunAsync
 */
interface MastraWorkflow {
  createRunAsync: (runId: string) => Promise<MastraRun>;
}

/**
 * Extract step outputs from step results for hydration.
 * This converts our StepResult records to the format Mastra expects for inputData.steps
 */
function extractStepOutputs(stepResults: Record<string, StepResult>): Record<string, StepOutput> {
  const outputs: Record<string, StepOutput> = {};
  
  for (const [stepId, result] of Object.entries(stepResults)) {
    if (result.status === "success" && result.output) {
      outputs[stepId] = result.output;
    }
  }
  
  return outputs;
}

/**
 * Create a timeout promise that rejects after the specified duration
 */
function createTimeoutPromise(timeoutMs: number, workflowId: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Workflow '${workflowId}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Workflow execution runner with optional persistence
 */
export class WorkflowRunner {
  private runs = new Map<string, WorkflowRun>();
  private mastraRuns = new Map<string, MastraRun>();
  private runningPromises = new Map<string, Promise<void>>();
  private timeout: number;
  private maxCompletedRuns: number;
  private throwOnPersistenceError: boolean;

  constructor(
    private factory: WorkflowFactory,
    private log: Logger,
    private storage?: WorkflowStorage,
    config?: WorkflowRunnerConfig
  ) {
    this.timeout = config?.timeout ?? 300000; // Default 5 minutes
    this.maxCompletedRuns = config?.maxCompletedRuns ?? 1000;
    this.throwOnPersistenceError = config?.throwOnPersistenceError ?? false;
  }

  /**
   * Initialize the runner and restore persisted runs
   */
  async init(): Promise<void> {
    if (!this.storage) return;

    try {
      // Load all runs from storage
      const persistedRuns = await this.storage.loadAllRuns();
      for (const run of persistedRuns) {
        this.runs.set(run.runId, run);
      }
      this.log.info(`Restored ${persistedRuns.length} workflow run(s) from storage`);
    } catch (error) {
      this.log.error(`Failed to restore runs from storage: ${error}`);
    }
  }

  /**
   * Persist a run to storage with proper error handling
   */
  private async persistRun(run: WorkflowRun): Promise<void> {
    if (!this.storage) return;

    try {
      await this.storage.saveRun(run);
    } catch (error) {
      this.log.error(`Failed to persist run ${run.runId}: ${error}`);
      if (this.throwOnPersistenceError) {
        throw new Error(`Persistence failed for run ${run.runId}: ${error}`);
      }
    }
  }

  /**
   * Clean up completed/failed/cancelled runs to prevent memory leaks.
   * Keeps the most recent runs up to maxCompletedRuns.
   */
  private cleanupCompletedRuns(): void {
    const terminalStatuses: WorkflowRun["status"][] = ["completed", "failed", "cancelled"];
    const completedRuns: WorkflowRun[] = [];

    for (const run of this.runs.values()) {
      if (terminalStatuses.includes(run.status)) {
        completedRuns.push(run);
      }
    }

    // Sort by completion time (most recent first)
    completedRuns.sort((a, b) => {
      const aTime = a.completedAt?.getTime() ?? a.startedAt.getTime();
      const bTime = b.completedAt?.getTime() ?? b.startedAt.getTime();
      return bTime - aTime;
    });

    // Remove excess runs beyond the limit
    if (completedRuns.length > this.maxCompletedRuns) {
      const runsToRemove = completedRuns.slice(this.maxCompletedRuns);
      for (const run of runsToRemove) {
        this.runs.delete(run.runId);
        this.mastraRuns.delete(run.runId);
        this.log.debug(`Cleaned up old run: ${run.runId}`);
      }
    }
  }

  /**
   * Save step results from Mastra execution to our run record.
   * This is essential for hydration when resuming after restart.
   */
  private saveStepResults(run: WorkflowRun, mastraSteps: Record<string, MastraStepResult>): void {
    for (const [stepId, stepResult] of Object.entries(mastraSteps)) {
      // Only save completed steps (not suspended or pending)
      if (stepResult?.status === "success" || stepResult?.status === "completed") {
        run.stepResults[stepId] = {
          stepId,
          status: "success",
          output: stepResult.output,
          startedAt: new Date(), // We don't have exact timing from Mastra
          completedAt: new Date(),
        };
      } else if (stepResult?.status === "failed") {
        run.stepResults[stepId] = {
          stepId,
          status: "failed",
          error: String(stepResult.output),
          startedAt: new Date(),
          completedAt: new Date(),
        };
      }
    }
  }

  /**
   * Start a new workflow run
   */
  async run(
    workflowId: string,
    inputs: WorkflowInputs = {}
  ): Promise<string> {
    const compiled = this.factory.get(workflowId);
    if (!compiled) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const runId = randomUUID();
    const run: WorkflowRun = {
      runId,
      workflowId,
      status: "pending",
      inputs,
      stepResults: {},
      startedAt: new Date(),
    };

    this.runs.set(runId, run);
    await this.persistRun(run);
    this.log.info(`Starting workflow ${workflowId} with run ID: ${runId}`);

    // Execute in background
    const promise = this.executeWorkflow(runId, compiled, inputs);
    this.runningPromises.set(runId, promise);

    // Clean up promise reference when done
    promise.finally(() => {
      this.runningPromises.delete(runId);
    });

    return runId;
  }

  /**
   * Execute the workflow
   */
  private async executeWorkflow(
    runId: string,
    compiled: WorkflowFactoryResult,
    inputs: WorkflowInputs
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    try {
      run.status = "running";
      await this.persistRun(run);
      this.log.info(`Executing workflow: ${compiled.id}`);

      // Create a run instance
      const workflow = compiled.workflow as MastraWorkflow;
      const mastraRun = await workflow.createRunAsync(runId);
      this.mastraRuns.set(runId, mastraRun);

      // Start the workflow with input data, with timeout
      const startPromise = mastraRun.start({
        inputData: {
          inputs,
          steps: {},
        },
      });

      // Race against timeout
      const result = await Promise.race([
        startPromise,
        createTimeoutPromise(this.timeout, compiled.id),
      ]);

      // Check for suspend
      if (result.status === "suspended") {
        run.status = "suspended";
        run.suspendedData = result as JsonValue;
        // Find the suspended step
        const suspendedStep = Object.entries(result.steps || {}).find(
          ([, stepResult]) => stepResult?.status === "suspended"
        );
        if (suspendedStep) {
          run.currentStepId = suspendedStep[0];
        }
        // Save completed step results for potential hydration after restart
        this.saveStepResults(run, result.steps || {});
        await this.persistRun(run);
        this.log.info(`Workflow ${compiled.id} suspended at step: ${run.currentStepId}`);
        return;
      }

      // Save all step results
      this.saveStepResults(run, result.steps || {});
      
      // Update final status
      run.status = "completed";
      run.completedAt = new Date();
      await this.persistRun(run);
      this.cleanupCompletedRuns();
      this.log.info(`Workflow ${compiled.id} completed successfully`);
    } catch (error) {
      run.status = "failed";
      run.error = String(error);
      run.completedAt = new Date();
      await this.persistRun(run);
      this.cleanupCompletedRuns();
      this.log.error(`Workflow ${compiled.id} failed: ${error}`);
    }
  }

  /**
   * Resume a suspended workflow
   */
  async resume(runId: string, data?: JsonValue): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (run.status !== "suspended") {
      throw new Error(`Run is not suspended: ${runId} (status: ${run.status})`);
    }

    const compiled = this.factory.get(run.workflowId);
    if (!compiled) {
      throw new Error(`Workflow not found: ${run.workflowId}`);
    }

    if (!run.currentStepId) {
      throw new Error(`No suspended step found for run: ${runId}`);
    }

    // Get the Mastra run instance
    let mastraRun = this.mastraRuns.get(runId);
    let needsHydration = false;
    
    if (!mastraRun) {
      // Recreate the run if not in memory (e.g., after restart)
      // 
      // HYDRATION STRATEGY:
      // When recreating a run after process restart, the fresh MastraRun instance
      // won't have knowledge of previously completed steps. We handle this by:
      // 1. Creating a fresh run instance
      // 2. Hydrating it by calling start() with the previous step outputs
      // 3. Then calling resume() to continue from the suspended step
      //
      // This ensures the Mastra engine's internal DAG state is aware of
      // completed steps via the inputData.steps context.
      const workflow = compiled.workflow as MastraWorkflow;
      mastraRun = await workflow.createRunAsync(runId);
      this.mastraRuns.set(runId, mastraRun);
      needsHydration = true;
      this.log.debug(`Recreated Mastra run instance for ${runId}, will hydrate with previous step results`);
    }

    try {
      run.status = "running";
      await this.persistRun(run);
      this.log.info(`Resuming workflow run: ${runId} at step: ${run.currentStepId}`);

      // Resume the workflow
      if (!mastraRun.resume) {
        throw new Error("Resume not supported by this Mastra version");
      }

      // If we recreated the run (after restart), hydrate with previous step outputs
      // This injects the completed step results into the context so the engine
      // knows what was already done and can properly evaluate step dependencies
      if (needsHydration && Object.keys(run.stepResults).length > 0) {
        const previousOutputs = extractStepOutputs(run.stepResults);
        this.log.debug(`Hydrating run with ${Object.keys(previousOutputs).length} previous step outputs`);
        
        // Start the workflow with hydrated step context
        // This primes the engine with knowledge of completed steps
        // Note: Depending on Mastra's implementation, this may or may not
        // re-execute steps. The step conditions should handle idempotency.
        await mastraRun.start({
          inputData: {
            inputs: run.inputs,
            steps: previousOutputs,
          },
        });
      }

      const result = await mastraRun.resume({
        stepId: run.currentStepId,
        data,
      });

      // Save step results from this execution
      this.saveStepResults(run, result.steps || {});

      // Check if suspended again
      if (result.status === "suspended") {
        run.status = "suspended";
        run.suspendedData = result as JsonValue;
        const suspendedStep = Object.entries(result.steps || {}).find(
          ([, stepResult]) => stepResult?.status === "suspended"
        );
        if (suspendedStep) {
          run.currentStepId = suspendedStep[0];
        }
        await this.persistRun(run);
        this.log.info(`Workflow ${run.workflowId} suspended again at: ${run.currentStepId}`);
        return;
      }

      run.status = "completed";
      run.completedAt = new Date();
      await this.persistRun(run);
      this.cleanupCompletedRuns();
      this.log.info(`Workflow ${run.workflowId} completed after resume`);
    } catch (error) {
      run.status = "failed";
      run.error = String(error);
      run.completedAt = new Date();
      await this.persistRun(run);
      this.cleanupCompletedRuns();
      this.log.error(`Workflow ${run.workflowId} failed after resume: ${error}`);
    }
  }

  /**
   * Cancel a running workflow
   */
  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (run.status !== "running" && run.status !== "suspended" && run.status !== "pending") {
      throw new Error(`Run cannot be cancelled: ${runId} (status: ${run.status})`);
    }

    run.status = "cancelled";
    run.completedAt = new Date();
    await this.persistRun(run);
    this.cleanupCompletedRuns();
    this.log.info(`Cancelled workflow run: ${runId}`);

    // Clean up Mastra run
    this.mastraRuns.delete(runId);
  }

  /**
   * Get run status
   */
  getStatus(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * List all runs, optionally filtered by workflow ID
   */
  listRuns(workflowId?: string): WorkflowRun[] {
    const runs = Array.from(this.runs.values());

    if (workflowId) {
      return runs
        .filter((r) => r.workflowId === workflowId)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    }

    return runs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  /**
   * Update run status (for persistence/restore)
   */
  updateRun(runId: string, updates: Partial<WorkflowRun>): void {
    const run = this.runs.get(runId);
    if (run) {
      Object.assign(run, updates);
    }
  }

  /**
   * Add a run (for persistence/restore)
   */
  addRun(run: WorkflowRun): void {
    this.runs.set(run.runId, run);
  }

  /**
   * Get all runs (for persistence)
   */
  getAllRuns(): WorkflowRun[] {
    return Array.from(this.runs.values());
  }

  /**
   * Get suspended runs that can be resumed
   */
  getSuspendedRuns(): WorkflowRun[] {
    return Array.from(this.runs.values())
      .filter((r) => r.status === "suspended")
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }
}
