import { LibSQLStore } from "@mastra/libsql";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { WorkflowRun, Logger, WorkflowInputs, StepResult, JsonValue } from "../types.js";

/**
 * Storage configuration options
 */
export interface StorageConfig {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Serialized workflow run for storage (all strings for SQLite)
 */
interface SerializedRun {
  runId: string;
  workflowId: string;
  status: string;
  inputs: string; // JSON string
  stepResults: string; // JSON string
  currentStepId?: string;
  suspendedData?: string; // JSON string
  startedAt: string; // ISO date string
  completedAt?: string; // ISO date string
  error?: string;
}

/**
 * Database row shape from SQLite queries
 */
interface DatabaseRow {
  run_id?: string;
  runId?: string;
  workflow_id?: string;
  workflowId?: string;
  status?: string;
  inputs?: string;
  step_results?: string;
  stepResults?: string;
  current_step_id?: string;
  currentStepId?: string;
  suspended_data?: string;
  suspendedData?: string;
  started_at?: string;
  startedAt?: string;
  completed_at?: string;
  completedAt?: string;
  error?: string;
}

/**
 * LibSQL client execute result
 */
interface LibSQLExecuteResult {
  rows: DatabaseRow[];
}

/**
 * LibSQL client interface (internal to LibSQLStore)
 */
interface LibSQLClient {
  execute: (sql: { sql: string; args: (string | number | null)[] }) => Promise<LibSQLExecuteResult>;
}

/**
 * Shape for accessing private client property via unknown cast
 */
interface StoreWithClient {
  client: LibSQLClient;
}

/**
 * Safely access the internal client from LibSQLStore
 */
function getClient(store: LibSQLStore): LibSQLClient | null {
  const storeWithClient = store as unknown as StoreWithClient;
  return storeWithClient.client ?? null;
}

/**
 * Workflow persistence storage using LibSQL/SQLite
 */
export class WorkflowStorage {
  private store: LibSQLStore | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    private config: StorageConfig,
    private log: Logger
  ) {}

  /**
   * Initialize the storage (lazy initialization)
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      // Ensure directory exists
      const dbPath = resolve(this.config.dbPath);
      await mkdir(dirname(dbPath), { recursive: true });

      // Create LibSQL store
      this.store = new LibSQLStore({
        url: `file:${dbPath}`,
      });

      // Create custom table for our workflow runs
      await this.createRunsTable();

      this.initialized = true;
      this.log.info(`Workflow storage initialized at: ${dbPath}`);
    } catch (error) {
      this.log.error(`Failed to initialize storage: ${error}`);
      throw error;
    }
  }

  /**
   * Create the workflow runs table if it doesn't exist
   */
  private async createRunsTable(): Promise<void> {
    if (!this.store) return;

    try {
      await this.store.createTable({
        tableName: "opencode_workflow_runs" as Parameters<typeof this.store.createTable>[0]["tableName"],
        schema: {
          run_id: { type: "text", primaryKey: true },
          workflow_id: { type: "text", nullable: false },
          status: { type: "text", nullable: false },
          inputs: { type: "text", nullable: false },
          step_results: { type: "text", nullable: false },
          current_step_id: { type: "text", nullable: true },
          suspended_data: { type: "text", nullable: true },
          started_at: { type: "text", nullable: false },
          completed_at: { type: "text", nullable: true },
          error: { type: "text", nullable: true },
        },
      });
    } catch (error) {
      // Table might already exist, which is fine
      if (!String(error).includes("already exists")) {
        this.log.debug(`Table creation note: ${error}`);
      }
    }
  }

  /**
   * Save a workflow run to storage
   */
  async saveRun(run: WorkflowRun): Promise<void> {
    await this.init();
    if (!this.store) throw new Error("Storage not initialized");

    const serialized: SerializedRun = {
      runId: run.runId,
      workflowId: run.workflowId,
      status: run.status,
      inputs: JSON.stringify(run.inputs),
      stepResults: JSON.stringify(run.stepResults),
      currentStepId: run.currentStepId,
      suspendedData: run.suspendedData ? JSON.stringify(run.suspendedData) : undefined,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString(),
      error: run.error,
    };

    try {
      await this.store.insert({
        tableName: "opencode_workflow_runs" as Parameters<typeof this.store.insert>[0]["tableName"],
        record: {
          run_id: serialized.runId,
          workflow_id: serialized.workflowId,
          status: serialized.status,
          inputs: serialized.inputs,
          step_results: serialized.stepResults,
          current_step_id: serialized.currentStepId ?? null,
          suspended_data: serialized.suspendedData ?? null,
          started_at: serialized.startedAt,
          completed_at: serialized.completedAt ?? null,
          error: serialized.error ?? null,
        },
      });
      this.log.debug(`Saved run: ${run.runId}`);
    } catch (error) {
      // If insert fails (duplicate), try update
      if (String(error).includes("UNIQUE constraint")) {
        await this.updateRun(run);
      } else {
        throw error;
      }
    }
  }

  /**
   * Update an existing workflow run
   */
  async updateRun(run: WorkflowRun): Promise<void> {
    await this.init();
    if (!this.store) throw new Error("Storage not initialized");

    // LibSQL store doesn't have direct update, so we use raw SQL
    // For now, we'll delete and re-insert
    await this.deleteRun(run.runId);
    await this.saveRun(run);
  }

  /**
   * Delete a workflow run
   */
  async deleteRun(runId: string): Promise<void> {
    await this.init();
    if (!this.store) throw new Error("Storage not initialized");

    const client = getClient(this.store);
    if (client) {
      await client.execute({
        sql: "DELETE FROM opencode_workflow_runs WHERE run_id = ?",
        args: [runId],
      });
    }
  }

  /**
   * Load a workflow run by ID
   */
  async loadRun(runId: string): Promise<WorkflowRun | null> {
    await this.init();
    if (!this.store) throw new Error("Storage not initialized");

    const result = await this.store.load<SerializedRun>({
      tableName: "opencode_workflow_runs" as Parameters<typeof this.store.load>[0]["tableName"],
      keys: { run_id: runId },
    });

    if (!result) return null;

    return this.deserializeRun(result);
  }

  /**
   * Load all workflow runs, optionally filtered by workflow ID
   */
  async loadAllRuns(workflowId?: string): Promise<WorkflowRun[]> {
    await this.init();
    if (!this.store) throw new Error("Storage not initialized");

    const client = getClient(this.store);
    if (!client) return [];

    let sql = "SELECT * FROM opencode_workflow_runs";
    const args: (string | number | null)[] = [];

    if (workflowId) {
      sql += " WHERE workflow_id = ?";
      args.push(workflowId);
    }

    sql += " ORDER BY started_at DESC";

    try {
      const result = await client.execute({ sql, args });
      return result.rows.map((row) => this.deserializeRun(this.rowToSerialized(row)));
    } catch (error) {
      this.log.error(`Failed to load runs: ${error}`);
      return [];
    }
  }

  /**
   * Load runs with active status (pending, running, suspended)
   */
  async loadActiveRuns(): Promise<WorkflowRun[]> {
    await this.init();
    if (!this.store) throw new Error("Storage not initialized");

    const client = getClient(this.store);
    if (!client) return [];

    try {
      const result = await client.execute({
        sql: "SELECT * FROM opencode_workflow_runs WHERE status IN (?, ?, ?) ORDER BY started_at DESC",
        args: ["pending", "running", "suspended"],
      });
      return result.rows.map((row) => this.deserializeRun(this.rowToSerialized(row)));
    } catch (error) {
      this.log.error(`Failed to load active runs: ${error}`);
      return [];
    }
  }

  /**
   * Convert database row to serialized format
   */
  private rowToSerialized(row: DatabaseRow): SerializedRun {
    return {
      runId: String(row.run_id ?? row.runId ?? ""),
      workflowId: String(row.workflow_id ?? row.workflowId ?? ""),
      status: String(row.status ?? ""),
      inputs: String(row.inputs ?? "{}"),
      stepResults: String(row.step_results ?? row.stepResults ?? "{}"),
      currentStepId: row.current_step_id ? String(row.current_step_id) : undefined,
      suspendedData: row.suspended_data ? String(row.suspended_data) : undefined,
      startedAt: String(row.started_at ?? row.startedAt ?? new Date().toISOString()),
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
      error: row.error ? String(row.error) : undefined,
    };
  }

  /**
   * Deserialize a run from storage format
   */
  private deserializeRun(serialized: SerializedRun): WorkflowRun {
    return {
      runId: serialized.runId,
      workflowId: serialized.workflowId,
      status: serialized.status as WorkflowRun["status"],
      inputs: JSON.parse(serialized.inputs || "{}"),
      stepResults: JSON.parse(serialized.stepResults || "{}"),
      currentStepId: serialized.currentStepId,
      suspendedData: serialized.suspendedData ? JSON.parse(serialized.suspendedData) : undefined,
      startedAt: new Date(serialized.startedAt),
      completedAt: serialized.completedAt ? new Date(serialized.completedAt) : undefined,
      error: serialized.error,
    };
  }

  /**
   * Close the storage connection
   */
  async close(): Promise<void> {
    // LibSQLStore doesn't have explicit close method
    this.store = null;
    this.initialized = false;
    this.initPromise = null;
  }
}
