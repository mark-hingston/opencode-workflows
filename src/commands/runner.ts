import { randomUUID } from "node:crypto";
import { MissingInputsError } from "../types.js";
import type { 
  WorkflowRun, 
  Logger, 
  WorkflowInputs, 
  JsonValue, 
  StepOutput, 
  StepResult,
  StepDefinition,
  OpencodeClient,
  WorkflowDefinition,
} from "../types.js";
import type { WorkflowFactory, WorkflowFactoryResult } from "../factory/index.js";
import type { WorkflowStorage } from "../storage/index.js";
import { executeInnerStep } from "../adapters/index.js";

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
  start: (opts: { inputData: { inputs: WorkflowInputs; steps: Record<string, StepOutput>; secretInputs?: string[] } }) => Promise<MastraWorkflowResult>;
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
 * Result from createTimeoutPromise including cleanup function
 */
interface TimeoutPromiseResult {
  promise: Promise<never>;
  clear: () => void;
}

/**
 * Create a timeout promise that rejects after the specified duration.
 * Returns both the promise and a cleanup function to prevent memory leaks.
 */
function createTimeoutPromise(timeoutMs: number, workflowId: string): TimeoutPromiseResult {
  let timeoutId: NodeJS.Timeout;
  
  const promise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Workflow '${workflowId}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  
  const clear = () => {
    clearTimeout(timeoutId);
  };
  
  return { promise, clear };
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
   * Execute cleanup steps (onFailure or finally blocks).
   * These are executed outside the main Mastra workflow engine.
   * 
   * @param steps - The cleanup step definitions to execute
   * @param run - The current workflow run (for context)
   * @param compiled - The compiled workflow result
   * @param errorInfo - Optional error information if this is an onFailure block
   */
  private async executeCleanupSteps(
    steps: StepDefinition[],
    run: WorkflowRun,
    compiled: WorkflowFactoryResult,
    errorInfo?: { message: string; stepId?: string }
  ): Promise<void> {
    const client = this.factory.getClient();
    
    // Build context from the run's current state
    const ctx = {
      inputs: {
        ...run.inputs,
        // Add error info if available (for onFailure blocks)
        ...(errorInfo ? {
          error: {
            message: errorInfo.message,
            stepId: errorInfo.stepId,
          }
        } : {}),
      } as Record<string, JsonValue>,
      steps: extractStepOutputs(run.stepResults) as Record<string, JsonValue>,
      env: process.env,
    };

    for (const stepDef of steps) {
      try {
        this.log.info(`Executing cleanup step: ${stepDef.id}`);
        
        const result = await executeInnerStep(
          stepDef,
          ctx,
          client,
          compiled.secrets || []
        );

        // Store the result for subsequent cleanup steps to reference
        ctx.steps[stepDef.id] = result;
        
        // Save to run results with a "cleanup:" prefix to distinguish from main steps
        run.stepResults[`cleanup:${stepDef.id}`] = {
          stepId: `cleanup:${stepDef.id}`,
          status: "success",
          output: result as StepOutput,
          startedAt: new Date(),
          completedAt: new Date(),
        };
        
        this.log.info(`Cleanup step ${stepDef.id} completed`);
      } catch (error) {
        // Log but don't throw - cleanup steps should not mask the original error
        this.log.error(`Cleanup step ${stepDef.id} failed: ${error}`);
        
        run.stepResults[`cleanup:${stepDef.id}`] = {
          stepId: `cleanup:${stepDef.id}`,
          status: "failed",
          error: String(error),
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

    // Validate required inputs
    if (compiled.inputSchema && Object.keys(compiled.inputSchema).length > 0) {
      const missingInputs: string[] = [];
      for (const inputName of Object.keys(compiled.inputSchema)) {
        if (!(inputName in inputs) || inputs[inputName] === undefined || inputs[inputName] === "") {
          missingInputs.push(inputName);
        }
      }
      if (missingInputs.length > 0) {
        throw new MissingInputsError(workflowId, missingInputs, compiled.inputSchema);
      }
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
    this.log.info(`Starting workflow ${workflowId} with run ID: ${runId}`, {
      workflowId,
      runId,
    });

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
   * Execute the workflow with proper cleanup (onFailure/finally) handling
   */
  private async executeWorkflow(
    runId: string,
    compiled: WorkflowFactoryResult,
    inputs: WorkflowInputs
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    let workflowError: Error | undefined;
    let failedStepId: string | undefined;

    try {
      run.status = "running";
      await this.persistRun(run);
      this.log.info(`Executing workflow: ${compiled.id}`, {
        workflowId: compiled.id,
        runId,
      });

      // Create a run instance
      const workflow = compiled.workflow as MastraWorkflow;
      const mastraRun = await workflow.createRunAsync(runId);
      this.mastraRuns.set(runId, mastraRun);

      // Start the workflow with input data, with timeout
      // Include secretInputs so step adapters know which inputs to mask in logs
      const startPromise = mastraRun.start({
        inputData: {
          inputs,
          steps: {},
          secretInputs: compiled.secrets || [],
        },
      });

      // Race against timeout with proper cleanup to prevent memory leaks
      const timeout = createTimeoutPromise(this.timeout, compiled.id);
      let result: MastraWorkflowResult;
      try {
        result = await Promise.race([
          startPromise,
          timeout.promise,
        ]);
      } finally {
        timeout.clear();
      }

      // Check for suspend - no cleanup needed, workflow may resume later
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
        this.log.info(`Workflow ${compiled.id} suspended at step: ${run.currentStepId}`, {
          workflowId: compiled.id,
          runId,
          stepId: run.currentStepId,
        });
        return;
      }

      // Save all step results
      this.saveStepResults(run, result.steps || {});
      
      // Check if any step returned a dynamic workflow to execute
      // This enables "Agentic Planning" where an eval step can generate and execute a workflow
      const dynamicWorkflowStep = Object.entries(result.steps || {}).find(
        ([, stepResult]) => {
          const output = stepResult?.output;
          return output && typeof output === 'object' && 'workflow' in output;
        }
      );

      if (dynamicWorkflowStep) {
        const [stepId, stepResult] = dynamicWorkflowStep;
        const dynamicDef = (stepResult.output as unknown as { workflow: WorkflowDefinition }).workflow;
        
        // Ensure unique ID to prevent race conditions when multiple parent workflows
        // generate dynamic workflows with the same ID simultaneously
        const uniqueId = `${dynamicDef.id}-${runId}`;
        const uniqueDef = { ...dynamicDef, id: uniqueId };
        
        this.log.info(`Executing dynamic sub-workflow: ${uniqueId} (generated by step: ${stepId})`);
        
        // Compile the dynamic workflow with the factory
        const dynamicCompiled = this.factory.compile(uniqueDef);
        
        // Generate a new runId for the sub-workflow (linked via parentRunId in the future)
        const subRunId = randomUUID();
        
        // Execute the sub-workflow with the parent's inputs as a starting point
        // The sub-workflow can define its own inputs which will be validated
        await this.executeWorkflow(subRunId, dynamicCompiled, inputs);
        
        // Store reference to sub-workflow run in the parent
        run.stepResults[`dynamic:${stepId}`] = {
          stepId: `dynamic:${stepId}`,
          status: "success",
          output: { result: { subWorkflowId: uniqueId, subRunId } } as StepOutput,
          startedAt: new Date(),
          completedAt: new Date(),
        };
      }
      
      // Main workflow completed successfully
      run.status = "completed";
      run.completedAt = new Date();
      this.log.info(`Workflow ${compiled.id} completed successfully`, {
        workflowId: compiled.id,
        runId,
        durationMs: run.completedAt.getTime() - run.startedAt.getTime(),
      });

    } catch (error) {
      // Capture the error for onFailure block
      workflowError = error as Error;
      
      // Try to find which step failed
      const failedStep = Object.entries(run.stepResults).find(
        ([, result]) => result.status === "failed"
      );
      failedStepId = failedStep?.[0];
      
      run.status = "failed";
      run.error = String(error);
      run.completedAt = new Date();
      this.log.error(`Workflow ${compiled.id} failed: ${error}`, {
        workflowId: compiled.id,
        runId,
        metadata: { error: String(error), failedStepId: failedStepId ?? null },
      });
    }

    // Execute onFailure steps if workflow failed and onFailure is defined
    if (workflowError && compiled.onFailureSteps && compiled.onFailureSteps.length > 0) {
      this.log.info(`Executing onFailure block (${compiled.onFailureSteps.length} steps)`);
      await this.executeCleanupSteps(
        compiled.onFailureSteps,
        run,
        compiled,
        { message: workflowError.message, stepId: failedStepId }
      );
    }

    // Execute finally steps (always, regardless of success/failure)
    if (compiled.finallySteps && compiled.finallySteps.length > 0) {
      this.log.info(`Executing finally block (${compiled.finallySteps.length} steps)`);
      await this.executeCleanupSteps(
        compiled.finallySteps,
        run,
        compiled,
        workflowError ? { message: workflowError.message, stepId: failedStepId } : undefined
      );
    }

    // Persist final state and cleanup
    await this.persistRun(run);
    this.cleanupCompletedRuns();
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

    let workflowError: Error | undefined;
    let failedStepId: string | undefined;

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
            secretInputs: compiled.secrets || [],
          },
        });
      }

      const result = await mastraRun.resume({
        stepId: run.currentStepId,
        data,
      });

      // Save step results from this execution
      this.saveStepResults(run, result.steps || {});

      // Check if suspended again - no cleanup needed
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
      this.log.info(`Workflow ${run.workflowId} completed after resume`);
    } catch (error) {
      workflowError = error as Error;
      
      // Try to find which step failed
      const failedStep = Object.entries(run.stepResults).find(
        ([, result]) => result.status === "failed"
      );
      failedStepId = failedStep?.[0];
      
      run.status = "failed";
      run.error = String(error);
      run.completedAt = new Date();
      this.log.error(`Workflow ${run.workflowId} failed after resume: ${error}`);
    }

    // Execute onFailure steps if workflow failed and onFailure is defined
    if (workflowError && compiled.onFailureSteps && compiled.onFailureSteps.length > 0) {
      this.log.info(`Executing onFailure block (${compiled.onFailureSteps.length} steps)`);
      await this.executeCleanupSteps(
        compiled.onFailureSteps,
        run,
        compiled,
        { message: workflowError.message, stepId: failedStepId }
      );
    }

    // Execute finally steps (always, regardless of success/failure)
    if (compiled.finallySteps && compiled.finallySteps.length > 0) {
      this.log.info(`Executing finally block (${compiled.finallySteps.length} steps)`);
      await this.executeCleanupSteps(
        compiled.finallySteps,
        run,
        compiled,
        workflowError ? { message: workflowError.message, stepId: failedStepId } : undefined
      );
    }

    // Persist final state and cleanup
    await this.persistRun(run);
    this.cleanupCompletedRuns();
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
