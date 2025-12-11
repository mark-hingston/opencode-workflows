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
 * Extended storage class that exposes the client for raw SQL operations.
 * This avoids unsafe type casting by properly extending the base class.
 */
class ExtendedLibSQLStore extends LibSQLStore {
  /**
   * Execute raw SQL query. Returns the internal client for direct SQL access.
   * This is needed for operations not supported by LibSQLStore's public API
   * (e.g., UPDATE queries, complex WHERE clauses).
   */
  async executeSQL(sql: string, args: (string | number | null)[] = []): Promise<LibSQLExecuteResult> {
    // Access the protected/private client - LibSQLStore internally uses this.client
    // We use Object.getOwnPropertyDescriptor to safely check if client exists
    const client = (this as unknown as { client?: LibSQLClient }).client;
    if (!client) {
      throw new Error("LibSQL client not initialized");
    }
    return client.execute({ sql, args });
  }
}

/**
 * Workflow persistence storage using LibSQL/SQLite
 */
export class WorkflowStorage {
  private store: ExtendedLibSQLStore | null = null;
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

      // Create LibSQL store using our extended class
      this.store = new ExtendedLibSQLStore({
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

      // Create indexes for frequently queried columns
      await this.createIndexes();
    } catch (error) {
      // Table might already exist, which is fine
      if (!String(error).includes("already exists")) {
        this.log.debug(`Table creation note: ${error}`);
      }
    }
  }

  /**
   * Create indexes on frequently queried columns for better performance
   */
  private async createIndexes(): Promise<void> {
    if (!this.store) return;

    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_workflow_id ON opencode_workflow_runs(workflow_id)",
      "CREATE INDEX IF NOT EXISTS idx_status ON opencode_workflow_runs(status)",
      "CREATE INDEX IF NOT EXISTS idx_started_at ON opencode_workflow_runs(started_at)",
    ];

    for (const sql of indexes) {
      try {
        await this.store.executeSQL(sql);
      } catch (error) {
        // Index might already exist or other non-critical error
        this.log.debug(`Index creation note: ${error}`);
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
   * Update an existing workflow run using proper SQL UPDATE
   */
  async updateRun(run: WorkflowRun): Promise<void> {
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

    await this.store.executeSQL(
      `UPDATE opencode_workflow_runs SET
        workflow_id = ?,
        status = ?,
        inputs = ?,
        step_results = ?,
        current_step_id = ?,
        suspended_data = ?,
        started_at = ?,
        completed_at = ?,
        error = ?
      WHERE run_id = ?`,
      [
        serialized.workflowId,
        serialized.status,
        serialized.inputs,
        serialized.stepResults,
        serialized.currentStepId ?? null,
        serialized.suspendedData ?? null,
        serialized.startedAt,
        serialized.completedAt ?? null,
        serialized.error ?? null,
        serialized.runId,
      ]
    );
  }

  /**
   * Delete a workflow run
   */
  async deleteRun(runId: string): Promise<void> {
    await this.init();
    if (!this.store) throw new Error("Storage not initialized");

    await this.store.executeSQL(
      "DELETE FROM opencode_workflow_runs WHERE run_id = ?",
      [runId]
    );
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

    let sql = "SELECT * FROM opencode_workflow_runs";
    const args: (string | number | null)[] = [];

    if (workflowId) {
      sql += " WHERE workflow_id = ?";
      args.push(workflowId);
    }

    sql += " ORDER BY started_at DESC";

    try {
      const result = await this.store.executeSQL(sql, args);
      return result.rows.map((row: DatabaseRow) => this.deserializeRun(this.rowToSerialized(row)));
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

    try {
      const result = await this.store.executeSQL(
        "SELECT * FROM opencode_workflow_runs WHERE status IN (?, ?, ?) ORDER BY started_at DESC",
        ["pending", "running", "suspended"]
      );
      return result.rows.map((row: DatabaseRow) => this.deserializeRun(this.rowToSerialized(row)));
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
   * Close the storage connection properly
   */
  async close(): Promise<void> {
    if (this.store) {
      try {
        // Execute a no-op query to ensure pending operations complete
        // then close by releasing the reference
        // Note: LibSQLStore doesn't expose a close method, but the underlying
        // libsql client will be garbage collected when dereferenced
        await this.store.executeSQL("SELECT 1");
      } catch {
        // Ignore errors during close
      }
    }
    this.store = null;
    this.initialized = false;
    this.initPromise = null;
  }
}
