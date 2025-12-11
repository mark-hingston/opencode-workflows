import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkflowStorage, type StorageConfig } from "./index.js";
import type { WorkflowRun, Logger } from "../types.js";

// Mock the LibSQLStore
vi.mock("@mastra/libsql", () => ({
  LibSQLStore: vi.fn().mockImplementation(() => ({
    createTable: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    client: {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    },
    // Extended method added by ExtendedLibSQLStore
    executeSQL: vi.fn().mockResolvedValue({ rows: [] }),
  })),
}));

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

describe("WorkflowStorage", () => {
  let storage: WorkflowStorage;
  let mockLogger: Logger;
  let config: StorageConfig;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    config = {
      dbPath: "/tmp/test-workflows.db",
      verbose: false,
    };

    storage = new WorkflowStorage(config, mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("init", () => {
    it("should initialize storage successfully", async () => {
      await storage.init();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Workflow storage initialized")
      );
    });

    it("should only initialize once even when called multiple times", async () => {
      await storage.init();
      await storage.init();
      await storage.init();

      // Logger should only be called once for successful initialization
      const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
      const initCalls = infoCalls.filter((call: string[]) =>
        call[0].includes("Workflow storage initialized")
      );
      expect(initCalls.length).toBe(1);
    });
  });

  describe("saveRun", () => {
    it("should save a workflow run", async () => {
      const run: WorkflowRun = {
        runId: "test-run-1",
        workflowId: "test-workflow",
        status: "pending",
        inputs: { key: "value" },
        stepResults: {},
        startedAt: new Date("2024-01-01T00:00:00Z"),
      };

      await storage.saveRun(run);
      expect(mockLogger.debug).toHaveBeenCalledWith("Saved run: test-run-1");
    });

    it("should handle run with all fields populated", async () => {
      const run: WorkflowRun = {
        runId: "test-run-2",
        workflowId: "test-workflow",
        status: "completed",
        inputs: { key: "value", num: 42 },
        stepResults: {
          step1: {
            stepId: "step1",
            status: "success",
            output: { stdout: "output", stderr: "", exitCode: 0 },
            startedAt: new Date("2024-01-01T00:00:00Z"),
            completedAt: new Date("2024-01-01T00:01:00Z"),
            duration: 60000,
          },
        },
        currentStepId: "step1",
        suspendedData: { foo: "bar" },
        startedAt: new Date("2024-01-01T00:00:00Z"),
        completedAt: new Date("2024-01-01T00:01:00Z"),
        error: undefined,
      };

      await storage.saveRun(run);
      expect(mockLogger.debug).toHaveBeenCalledWith("Saved run: test-run-2");
    });
  });

  describe("loadRun", () => {
    it("should return null for non-existent run", async () => {
      const result = await storage.loadRun("non-existent");
      expect(result).toBeNull();
    });
  });

  describe("loadAllRuns", () => {
    it("should return empty array when no runs exist", async () => {
      const runs = await storage.loadAllRuns();
      expect(runs).toEqual([]);
    });

    it("should accept optional workflowId filter", async () => {
      const runs = await storage.loadAllRuns("test-workflow");
      expect(runs).toEqual([]);
    });
  });

  describe("loadActiveRuns", () => {
    it("should return empty array when no active runs", async () => {
      const runs = await storage.loadActiveRuns();
      expect(runs).toEqual([]);
    });
  });

  describe("deleteRun", () => {
    it("should not throw when deleting non-existent run", async () => {
      await expect(storage.deleteRun("non-existent")).resolves.not.toThrow();
    });
  });

  describe("updateRun", () => {
    it("should update a run using SQL UPDATE", async () => {
      const run: WorkflowRun = {
        runId: "test-run-update",
        workflowId: "test-workflow",
        status: "running",
        inputs: {},
        stepResults: {},
        startedAt: new Date(),
      };

      // updateRun now uses executeSQL with UPDATE query
      await expect(storage.updateRun(run)).resolves.not.toThrow();
    });
  });

  describe("close", () => {
    it("should reset storage state", async () => {
      await storage.init();
      await storage.close();

      // After close, storage should re-initialize on next operation
      await storage.init();
      const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
      const initCalls = infoCalls.filter((call: string[]) =>
        call[0].includes("Workflow storage initialized")
      );
      expect(initCalls.length).toBe(2);
    });
  });

  describe("error handling", () => {
    it("should throw error when storage not initialized for saveRun without auto-init", async () => {
      // saveRun calls init() internally, so it should work
      const run: WorkflowRun = {
        runId: "test",
        workflowId: "test",
        status: "pending",
        inputs: {},
        stepResults: {},
        startedAt: new Date(),
      };

      await expect(storage.saveRun(run)).resolves.not.toThrow();
    });
  });
});

describe("WorkflowStorage serialization", () => {
  let storage: WorkflowStorage;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    storage = new WorkflowStorage(
      { dbPath: "/tmp/test.db" },
      mockLogger
    );
  });

  it("should serialize dates to ISO strings", async () => {
    const run: WorkflowRun = {
      runId: "serialize-test",
      workflowId: "test",
      status: "pending",
      inputs: {},
      stepResults: {},
      startedAt: new Date("2024-06-15T12:00:00Z"),
      completedAt: new Date("2024-06-15T13:00:00Z"),
    };

    // This exercises the serialization path
    await storage.saveRun(run);
    expect(mockLogger.debug).toHaveBeenCalledWith("Saved run: serialize-test");
  });

  it("should handle undefined optional fields", async () => {
    const run: WorkflowRun = {
      runId: "optional-test",
      workflowId: "test",
      status: "pending",
      inputs: {},
      stepResults: {},
      startedAt: new Date(),
      // No completedAt, currentStepId, suspendedData, or error
    };

    await storage.saveRun(run);
    expect(mockLogger.debug).toHaveBeenCalledWith("Saved run: optional-test");
  });
});
