import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowRunner } from "./runner.js";
import type { WorkflowFactory } from "../factory/index.js";
import type { WorkflowStorage } from "../storage/index.js";
import type { Logger, WorkflowRun } from "../types.js";

describe("WorkflowRunner - Pagination and On-Demand Loading", () => {
  let runner: WorkflowRunner;
  let mockFactory: WorkflowFactory;
  let mockStorage: WorkflowStorage;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    mockFactory = {
      get: vi.fn(),
      has: vi.fn().mockReturnValue(true),
      compile: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
      compileAll: vi.fn(),
    } as unknown as WorkflowFactory;

    mockStorage = {
      init: vi.fn().mockResolvedValue(undefined),
      saveRun: vi.fn().mockResolvedValue(undefined),
      loadRun: vi.fn().mockResolvedValue(null),
      loadAllRuns: vi.fn().mockResolvedValue([]),
      loadActiveRuns: vi.fn().mockResolvedValue([]),
      updateRun: vi.fn().mockResolvedValue(undefined),
      deleteRun: vi.fn().mockResolvedValue(undefined),
      deleteRunsOlderThan: vi.fn().mockResolvedValue(0),
      countRuns: vi.fn().mockResolvedValue(0),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowStorage;

    runner = new WorkflowRunner(mockFactory, mockLogger, mockStorage);
  });

  describe("getStatusFromStorage", () => {
    it("should return in-memory run if available", async () => {
      const run: WorkflowRun = {
        runId: "mem-run",
        workflowId: "test-wf",
        status: "completed",
        inputs: {},
        stepResults: {},
        startedAt: new Date(),
      };

      runner.addRun(run);

      const result = await runner.getStatusFromStorage("mem-run");
      expect(result).toBe(run);
      expect(mockStorage.loadRun).not.toHaveBeenCalled();
    });

    it("should load from storage if not in memory", async () => {
      const storageRun: WorkflowRun = {
        runId: "storage-run",
        workflowId: "test-wf",
        status: "completed",
        inputs: {},
        stepResults: {},
        startedAt: new Date(),
      };

      (mockStorage.loadRun as ReturnType<typeof vi.fn>).mockResolvedValue(storageRun);

      const result = await runner.getStatusFromStorage("storage-run");
      expect(result).toEqual(storageRun);
      expect(mockStorage.loadRun).toHaveBeenCalledWith("storage-run");
    });

    it("should return undefined if run not found", async () => {
      (mockStorage.loadRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await runner.getStatusFromStorage("nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("loadMoreRuns", () => {
    it("should load additional runs from storage", async () => {
      const additionalRuns: WorkflowRun[] = [
        {
          runId: "old-run-1",
          workflowId: "test-wf",
          status: "completed",
          inputs: {},
          stepResults: {},
          startedAt: new Date("2024-01-01"),
        },
        {
          runId: "old-run-2",
          workflowId: "test-wf",
          status: "completed",
          inputs: {},
          stepResults: {},
          startedAt: new Date("2024-01-02"),
        },
      ];

      (mockStorage.loadAllRuns as ReturnType<typeof vi.fn>).mockResolvedValue(additionalRuns);

      const result = await runner.loadMoreRuns(100, 50);

      expect(result).toEqual(additionalRuns);
      expect(mockStorage.loadAllRuns).toHaveBeenCalledWith(undefined, 100, 50);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Loaded 2 additional run(s) from storage"
      );
    });

    it("should support workflow ID filter", async () => {
      (mockStorage.loadAllRuns as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await runner.loadMoreRuns(50, 0, "specific-workflow");

      expect(mockStorage.loadAllRuns).toHaveBeenCalledWith("specific-workflow", 50, 0);
    });

    it("should not add duplicate runs", async () => {
      const existingRun: WorkflowRun = {
        runId: "existing",
        workflowId: "test-wf",
        status: "completed",
        inputs: {},
        stepResults: {},
        startedAt: new Date(),
      };

      runner.addRun(existingRun);

      const storageRuns: WorkflowRun[] = [
        existingRun, // Same run already in memory
        {
          runId: "new-run",
          workflowId: "test-wf",
          status: "completed",
          inputs: {},
          stepResults: {},
          startedAt: new Date(),
        },
      ];

      (mockStorage.loadAllRuns as ReturnType<typeof vi.fn>).mockResolvedValue(storageRuns);

      const result = await runner.loadMoreRuns(100, 0);

      expect(result).toEqual(storageRuns);
      // Only the new run should be logged
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Loaded 2 additional run(s) from storage"
      );
    });

    it("should return empty array when storage not available", async () => {
      const runnerNoStorage = new WorkflowRunner(mockFactory, mockLogger);

      const result = await runnerNoStorage.loadMoreRuns(100, 0);

      expect(result).toEqual([]);
    });

    it("should handle storage errors gracefully", async () => {
      (mockStorage.loadAllRuns as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Database error")
      );

      const result = await runner.loadMoreRuns(100, 0);

      expect(result).toEqual([]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load additional runs")
      );
    });
  });

  describe("countStorageRuns", () => {
    it("should return total count from storage", async () => {
      (mockStorage.countRuns as ReturnType<typeof vi.fn>).mockResolvedValue(500);

      const count = await runner.countStorageRuns();

      expect(count).toBe(500);
      expect(mockStorage.countRuns).toHaveBeenCalledWith(undefined);
    });

    it("should support workflow ID filter", async () => {
      (mockStorage.countRuns as ReturnType<typeof vi.fn>).mockResolvedValue(42);

      const count = await runner.countStorageRuns("specific-workflow");

      expect(count).toBe(42);
      expect(mockStorage.countRuns).toHaveBeenCalledWith("specific-workflow");
    });

    it("should return 0 when storage not available", async () => {
      const runnerNoStorage = new WorkflowRunner(mockFactory, mockLogger);

      const count = await runnerNoStorage.countStorageRuns();

      expect(count).toBe(0);
    });

    it("should handle storage errors gracefully", async () => {
      (mockStorage.countRuns as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Database error")
      );

      const count = await runner.countStorageRuns();

      expect(count).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to count runs")
      );
    });
  });
});
