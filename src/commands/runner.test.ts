import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkflowRunner } from "./runner.js";
import type { WorkflowFactory, WorkflowFactoryResult } from "../factory/index.js";
import type { WorkflowStorage } from "../storage/index.js";
import { MissingInputsError } from "../types.js";
import type { WorkflowRun, Logger } from "../types.js";

// Mock UUID generation for deterministic tests
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
}));

describe("WorkflowRunner", () => {
  let runner: WorkflowRunner;
  let mockFactory: WorkflowFactory;
  let mockStorage: WorkflowStorage;
  let mockLogger: Logger;
  let mockMastraRun: {
    start: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };
  let mockWorkflow: {
    createRunAsync: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    mockMastraRun = {
      start: vi.fn().mockResolvedValue({ status: "completed", steps: {} }),
      resume: vi.fn().mockResolvedValue({ status: "completed", steps: {} }),
    };

    mockWorkflow = {
      createRunAsync: vi.fn().mockResolvedValue(mockMastraRun),
    };

    const mockCompiledWorkflow: WorkflowFactoryResult = {
      workflow: mockWorkflow,
      id: "test-workflow",
      description: "Test workflow",
    };

    mockFactory = {
      get: vi.fn().mockReturnValue(mockCompiledWorkflow),
      has: vi.fn().mockReturnValue(true),
      compile: vi.fn(),
      list: vi.fn().mockReturnValue(["test-workflow"]),
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
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowStorage;

    runner = new WorkflowRunner(mockFactory, mockLogger, mockStorage);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("init", () => {
    it("should restore persisted runs from storage", async () => {
      const activeRuns: WorkflowRun[] = [
        {
          runId: "run-2",
          workflowId: "test-workflow",
          status: "suspended",
          inputs: {},
          stepResults: {},
          startedAt: new Date(),
        },
      ];
      
      const allRuns: WorkflowRun[] = [
        {
          runId: "run-1",
          workflowId: "test-workflow",
          status: "completed",
          inputs: {},
          stepResults: {},
          startedAt: new Date(),
        },
        ...activeRuns,
      ];

      (mockStorage.loadActiveRuns as ReturnType<typeof vi.fn>).mockResolvedValue(activeRuns);
      (mockStorage.loadAllRuns as ReturnType<typeof vi.fn>).mockResolvedValue(allRuns);

      await runner.init();
      
      // Wait for background loading to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockStorage.loadActiveRuns).toHaveBeenCalled();
      expect(mockStorage.loadAllRuns).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Restored 1 active workflow run(s) from storage"
      );
    });

    it("should handle init without storage", async () => {
      const runnerNoStorage = new WorkflowRunner(mockFactory, mockLogger);
      await runnerNoStorage.init();

      expect(mockStorage.loadAllRuns).not.toHaveBeenCalled();
      expect(mockStorage.loadActiveRuns).not.toHaveBeenCalled();
    });

    it("should log error when storage restore fails", async () => {
      (mockStorage.loadActiveRuns as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Storage error")
      );

      await runner.init();
      
      // Wait for background loading to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to restore active runs from storage")
      );
    });
  });

  describe("run", () => {
    it("should start a new workflow run", async () => {
      const runId = await runner.run("test-workflow", { key: "value" });

      expect(runId).toBe("test-uuid-1234");
      expect(mockFactory.get).toHaveBeenCalledWith("test-workflow");
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Starting workflow test-workflow"),
        expect.objectContaining({ workflowId: "test-workflow", runId: "test-uuid-1234" })
      );
    });

    it("should throw error for unknown workflow", async () => {
      (mockFactory.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      await expect(runner.run("unknown-workflow")).rejects.toThrow(
        "Workflow not found: unknown-workflow"
      );
    });

    it("should persist run to storage", async () => {
      await runner.run("test-workflow");

      // Should be called at least once for initial save
      expect(mockStorage.saveRun).toHaveBeenCalled();
    });

    it("should work with empty inputs", async () => {
      const runId = await runner.run("test-workflow");

      expect(runId).toBe("test-uuid-1234");
    });

    it("should handle workflow that completes successfully", async () => {
      mockMastraRun.start.mockResolvedValue({
        status: "completed",
        steps: { step1: { status: "completed", output: {} } },
      });

      await runner.run("test-workflow");

      // Wait for background execution
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("completed successfully"),
        expect.objectContaining({ workflowId: "test-workflow", runId: "test-uuid-1234" })
      );
    });

    it("should handle workflow that suspends", async () => {
      mockMastraRun.start.mockResolvedValue({
        status: "suspended",
        steps: { step1: { status: "suspended", output: {} } },
      });

      await runner.run("test-workflow");

      // Wait for background execution
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("suspended at step"),
        expect.objectContaining({ workflowId: "test-workflow", runId: "test-uuid-1234" })
      );
    });

    it("should handle workflow execution failure", async () => {
      mockMastraRun.start.mockRejectedValue(new Error("Execution failed"));

      await runner.run("test-workflow");

      // Wait for background execution
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("failed"),
        expect.objectContaining({ workflowId: "test-workflow", runId: "test-uuid-1234" })
      );
    });

    it("should throw MissingInputsError when required inputs are missing", async () => {
      const workflowWithInputs: WorkflowFactoryResult = {
        workflow: mockWorkflow,
        id: "workflow-with-inputs",
        description: "Test workflow",
        inputSchema: {
          version: "string",
          count: "number",
        },
      };
      (mockFactory.get as ReturnType<typeof vi.fn>).mockReturnValue(workflowWithInputs);

      await expect(runner.run("workflow-with-inputs", {})).rejects.toThrow(
        MissingInputsError
      );
    });

    it("should include all missing inputs in MissingInputsError", async () => {
      const workflowWithInputs: WorkflowFactoryResult = {
        workflow: mockWorkflow,
        id: "workflow-with-inputs",
        description: "Test workflow",
        inputSchema: {
          version: "string",
          count: "number",
          enabled: "boolean",
        },
      };
      (mockFactory.get as ReturnType<typeof vi.fn>).mockReturnValue(workflowWithInputs);

      try {
        await runner.run("workflow-with-inputs", { count: 5 });
        expect.fail("Should have thrown MissingInputsError");
      } catch (error) {
        expect(error).toBeInstanceOf(MissingInputsError);
        const missingError = error as MissingInputsError;
        expect(missingError.workflowId).toBe("workflow-with-inputs");
        expect(missingError.missingInputs).toEqual(["version", "enabled"]);
        expect(missingError.inputSchema).toEqual({
          version: "string",
          count: "number",
          enabled: "boolean",
        });
      }
    });

    it("should not throw when all required inputs are provided", async () => {
      const workflowWithInputs: WorkflowFactoryResult = {
        workflow: mockWorkflow,
        id: "workflow-with-inputs",
        description: "Test workflow",
        inputSchema: {
          version: "string",
          count: "number",
        },
      };
      (mockFactory.get as ReturnType<typeof vi.fn>).mockReturnValue(workflowWithInputs);

      const runId = await runner.run("workflow-with-inputs", { version: "1.0.0", count: 5 });
      expect(runId).toBe("test-uuid-1234");
    });

    it("should not validate inputs if workflow has no input schema", async () => {
      const workflowNoInputs: WorkflowFactoryResult = {
        workflow: mockWorkflow,
        id: "workflow-no-inputs",
        description: "Test workflow",
        inputSchema: undefined,
      };
      (mockFactory.get as ReturnType<typeof vi.fn>).mockReturnValue(workflowNoInputs);

      const runId = await runner.run("workflow-no-inputs", {});
      expect(runId).toBe("test-uuid-1234");
    });

    it("should treat empty string as missing input", async () => {
      const workflowWithInputs: WorkflowFactoryResult = {
        workflow: mockWorkflow,
        id: "workflow-with-inputs",
        description: "Test workflow",
        inputSchema: {
          version: "string",
        },
      };
      (mockFactory.get as ReturnType<typeof vi.fn>).mockReturnValue(workflowWithInputs);

      await expect(runner.run("workflow-with-inputs", { version: "" })).rejects.toThrow(
        MissingInputsError
      );
    });
  });

  describe("resume", () => {
    beforeEach(async () => {
      // Setup a suspended run
      mockMastraRun.start.mockResolvedValue({
        status: "suspended",
        steps: { step1: { status: "suspended" } },
      });

      await runner.run("test-workflow");
      // Wait for suspension
      await new Promise((r) => setTimeout(r, 50));
    });

    it("should resume a suspended workflow", async () => {
      mockMastraRun.resume.mockResolvedValue({
        status: "completed",
        steps: {},
      });

      await runner.resume("test-uuid-1234", { approval: true });

      expect(mockMastraRun.resume).toHaveBeenCalledWith({
        stepId: "step1",
        data: { approval: true },
      });
    });

    it("should throw error for non-existent run", async () => {
      await expect(runner.resume("non-existent")).rejects.toThrow(
        "Run not found: non-existent"
      );
    });

    it("should throw error for non-suspended run", async () => {
      // First run completes
      mockMastraRun.start.mockResolvedValue({ status: "completed", steps: {} });
      const { randomUUID } = await import("node:crypto");
      (randomUUID as ReturnType<typeof vi.fn>).mockReturnValueOnce("completed-run");

      await runner.run("test-workflow");
      await new Promise((r) => setTimeout(r, 50));

      await expect(runner.resume("completed-run")).rejects.toThrow(
        "Run is not suspended"
      );
    });

    it("should handle resume that suspends again", async () => {
      mockMastraRun.resume.mockResolvedValue({
        status: "suspended",
        steps: { step2: { status: "suspended" } },
      });

      await runner.resume("test-uuid-1234");

      // Wait for execution
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("suspended again")
      );
    });

    it("should handle resume failure", async () => {
      mockMastraRun.resume.mockRejectedValue(new Error("Resume failed"));

      await runner.resume("test-uuid-1234");

      // Wait for execution
      await new Promise((r) => setTimeout(r, 50));

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("failed after resume")
      );
    });
  });

  describe("cancel", () => {
    it("should cancel a running workflow", async () => {
      await runner.run("test-workflow");

      await runner.cancel("test-uuid-1234");

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Cancelled workflow run: test-uuid-1234"
      );
    });

    it("should throw error for non-existent run", async () => {
      await expect(runner.cancel("non-existent")).rejects.toThrow(
        "Run not found: non-existent"
      );
    });

    it("should throw error for already completed run", async () => {
      mockMastraRun.start.mockResolvedValue({ status: "completed", steps: {} });

      await runner.run("test-workflow");
      await new Promise((r) => setTimeout(r, 50));

      await expect(runner.cancel("test-uuid-1234")).rejects.toThrow(
        "Run cannot be cancelled"
      );
    });
  });

  describe("getStatus", () => {
    it("should return run status", async () => {
      await runner.run("test-workflow");

      const status = runner.getStatus("test-uuid-1234");

      expect(status).toBeDefined();
      expect(status?.runId).toBe("test-uuid-1234");
      expect(status?.workflowId).toBe("test-workflow");
    });

    it("should return undefined for non-existent run", () => {
      const status = runner.getStatus("non-existent");
      expect(status).toBeUndefined();
    });
  });

  describe("listRuns", () => {
    it("should list all runs", async () => {
      await runner.run("test-workflow");

      const runs = runner.listRuns();

      expect(runs.length).toBe(1);
      expect(runs[0].runId).toBe("test-uuid-1234");
    });

    it("should filter runs by workflowId", async () => {
      await runner.run("test-workflow");

      const runs = runner.listRuns("test-workflow");
      expect(runs.length).toBe(1);

      const otherRuns = runner.listRuns("other-workflow");
      expect(otherRuns.length).toBe(0);
    });

    it("should sort runs by startedAt descending", async () => {
      const { randomUUID } = await import("node:crypto");
      (randomUUID as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce("run-1")
        .mockReturnValueOnce("run-2");

      await runner.run("test-workflow");
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      await runner.run("test-workflow");

      const runs = runner.listRuns();

      // Most recent run should be first (run-2 started later)
      expect(runs.length).toBe(2);
      expect(runs[0].runId).toBe("run-2");
      expect(runs[1].runId).toBe("run-1");
    });
  });

  describe("getSuspendedRuns", () => {
    it("should return only suspended runs", async () => {
      mockMastraRun.start.mockResolvedValue({
        status: "suspended",
        steps: { step1: { status: "suspended" } },
      });

      await runner.run("test-workflow");
      await new Promise((r) => setTimeout(r, 50));

      const suspended = runner.getSuspendedRuns();

      expect(suspended.length).toBe(1);
      expect(suspended[0].status).toBe("suspended");
    });

    it("should return empty array when no suspended runs", async () => {
      mockMastraRun.start.mockResolvedValue({ status: "completed", steps: {} });

      await runner.run("test-workflow");
      await new Promise((r) => setTimeout(r, 50));

      const suspended = runner.getSuspendedRuns();

      expect(suspended.length).toBe(0);
    });
  });

  describe("getAllRuns", () => {
    it("should return all runs as array", async () => {
      await runner.run("test-workflow");

      const all = runner.getAllRuns();

      expect(Array.isArray(all)).toBe(true);
      expect(all.length).toBe(1);
    });
  });

  describe("addRun / updateRun", () => {
    it("should add a run directly", () => {
      const run: WorkflowRun = {
        runId: "external-run",
        workflowId: "test",
        status: "pending",
        inputs: {},
        stepResults: {},
        startedAt: new Date(),
      };

      runner.addRun(run);

      expect(runner.getStatus("external-run")).toBe(run);
    });

    it("should update a run", async () => {
      await runner.run("test-workflow");

      runner.updateRun("test-uuid-1234", { status: "cancelled" });

      const status = runner.getStatus("test-uuid-1234");
      expect(status?.status).toBe("cancelled");
    });

    it("should not throw when updating non-existent run", () => {
      expect(() => {
        runner.updateRun("non-existent", { status: "cancelled" });
      }).not.toThrow();
    });
  });
});

describe("Lifecycle Hooks", () => {
  let runner: WorkflowRunner;
  let mockFactory: WorkflowFactory;
  let mockStorage: WorkflowStorage;
  let mockLogger: Logger;
  let mockMastraRun: {
    start: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };
  let mockWorkflow: {
    createRunAsync: ReturnType<typeof vi.fn>;
  };
  let mockClient: { tools: Record<string, unknown>; app: { log: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    mockMastraRun = {
      start: vi.fn().mockResolvedValue({ status: "completed", steps: {} }),
      resume: vi.fn().mockResolvedValue({ status: "completed", steps: {} }),
    };

    mockWorkflow = {
      createRunAsync: vi.fn().mockResolvedValue(mockMastraRun),
    };

    mockClient = {
      tools: {},
      app: { log: vi.fn() },
    };

    mockFactory = {
      get: vi.fn().mockReturnValue({
        workflow: mockWorkflow,
        id: "test-workflow",
      }),
      has: vi.fn().mockReturnValue(true),
      compile: vi.fn(),
      list: vi.fn().mockReturnValue(["test-workflow"]),
      clear: vi.fn(),
      compileAll: vi.fn(),
      getClient: vi.fn().mockReturnValue(mockClient),
    } as unknown as WorkflowFactory;

    mockStorage = {
      init: vi.fn().mockResolvedValue(undefined),
      saveRun: vi.fn().mockResolvedValue(undefined),
      loadRun: vi.fn().mockResolvedValue(null),
      loadAllRuns: vi.fn().mockResolvedValue([]),
      loadActiveRuns: vi.fn().mockResolvedValue([]),
      updateRun: vi.fn().mockResolvedValue(undefined),
      deleteRun: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowStorage;

    runner = new WorkflowRunner(mockFactory, mockLogger, mockStorage);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should execute onFailure steps when workflow fails", async () => {
    // Mock a workflow that fails
    mockMastraRun.start.mockRejectedValue(new Error("Main task failed"));
    
    // Mock the factory to return a definition with onFailure
    const workflowWithFailure: WorkflowFactoryResult = {
      workflow: mockWorkflow,
      id: "fail-wf",
      onFailureSteps: [
        { id: "cleanup", type: "shell", command: "echo cleaning" }
      ]
    };
    (mockFactory.get as ReturnType<typeof vi.fn>).mockReturnValue(workflowWithFailure);

    await runner.run("fail-wf");
    
    // Wait for async execution
    await new Promise((r) => setTimeout(r, 100));

    const runs = runner.getAllRuns();
    expect(runs.length).toBe(1);
    const run = runs[0];
    
    // Verify main status is failed
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Error: Main task failed");
    
    // Verify onFailure block was attempted to execute
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("Executing onFailure block")
    );
  });

  it("should execute finally steps after success", async () => {
    mockMastraRun.start.mockResolvedValue({ status: "completed", steps: {} });
    
    const workflowWithFinally: WorkflowFactoryResult = {
      workflow: mockWorkflow,
      id: "finally-wf",
      finallySteps: [
        { id: "teardown", type: "shell", command: "echo done" }
      ]
    };
    (mockFactory.get as ReturnType<typeof vi.fn>).mockReturnValue(workflowWithFinally);

    await runner.run("finally-wf");
    await new Promise((r) => setTimeout(r, 100));

    const runs = runner.getAllRuns();
    expect(runs.length).toBe(1);
    const run = runs[0];
    expect(run.status).toBe("completed");
    
    // Verify finally block was attempted to execute
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("Executing finally block")
    );
  });

  it("should execute both onFailure and finally steps when workflow fails", async () => {
    mockMastraRun.start.mockRejectedValue(new Error("Task failed"));
    
    const workflowWithBoth: WorkflowFactoryResult = {
      workflow: mockWorkflow,
      id: "both-hooks-wf",
      onFailureSteps: [
        { id: "error-handler", type: "shell", command: "echo error" }
      ],
      finallySteps: [
        { id: "cleanup", type: "shell", command: "echo cleanup" }
      ]
    };
    (mockFactory.get as ReturnType<typeof vi.fn>).mockReturnValue(workflowWithBoth);

    await runner.run("both-hooks-wf");
    await new Promise((r) => setTimeout(r, 100));

    // Verify both blocks were attempted
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("Executing onFailure block")
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("Executing finally block")
    );
  });

  it("should not execute onFailure steps when workflow succeeds", async () => {
    mockMastraRun.start.mockResolvedValue({ status: "completed", steps: {} });
    
    const workflowWithFailure: WorkflowFactoryResult = {
      workflow: mockWorkflow,
      id: "success-wf",
      onFailureSteps: [
        { id: "cleanup", type: "shell", command: "echo cleaning" }
      ]
    };
    (mockFactory.get as ReturnType<typeof vi.fn>).mockReturnValue(workflowWithFailure);

    await runner.run("success-wf");
    await new Promise((r) => setTimeout(r, 100));

    const runs = runner.getAllRuns();
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("completed");
    
    // Verify onFailure block was NOT executed
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Executing onFailure block")
    );
  });
});

describe("Dynamic Workflow Execution", () => {
  let runner: WorkflowRunner;
  let mockFactory: WorkflowFactory;
  let mockStorage: WorkflowStorage;
  let mockLogger: Logger;
  let mockMastraRun: {
    start: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };
  let mockWorkflow: {
    createRunAsync: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    mockMastraRun = {
      start: vi.fn().mockResolvedValue({ status: "completed", steps: {} }),
      resume: vi.fn().mockResolvedValue({ status: "completed", steps: {} }),
    };

    mockWorkflow = {
      createRunAsync: vi.fn().mockResolvedValue(mockMastraRun),
    };

    mockFactory = {
      get: vi.fn().mockReturnValue({
        workflow: mockWorkflow,
        id: "test-workflow",
      }),
      has: vi.fn().mockReturnValue(true),
      compile: vi.fn(),
      list: vi.fn().mockReturnValue(["test-workflow"]),
      clear: vi.fn(),
      compileAll: vi.fn(),
      getClient: vi.fn().mockReturnValue({ tools: {}, app: { log: vi.fn() } }),
    } as unknown as WorkflowFactory;

    mockStorage = {
      init: vi.fn().mockResolvedValue(undefined),
      saveRun: vi.fn().mockResolvedValue(undefined),
      loadRun: vi.fn().mockResolvedValue(null),
      loadAllRuns: vi.fn().mockResolvedValue([]),
      loadActiveRuns: vi.fn().mockResolvedValue([]),
      updateRun: vi.fn().mockResolvedValue(undefined),
      deleteRun: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowStorage;

    runner = new WorkflowRunner(mockFactory, mockLogger, mockStorage);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should recursively execute a workflow generated by an eval step", async () => {
    const parentWorkflowId = "parent-planner";
    const subWorkflowId = "generated-sub-workflow";

    // Mock the Mastra run for the PARENT workflow - returns a dynamic workflow definition
    const parentRunMock = {
      start: vi.fn().mockResolvedValue({
        status: "completed",
        steps: {
          "plan-step": {
            status: "success",
            output: {
              workflow: {
                id: subWorkflowId,
                steps: [{ id: "child-step", type: "shell", command: "echo child" }]
              }
            }
          }
        }
      }),
    };

    // Mock the Mastra run for the CHILD workflow
    const childRunMock = {
      start: vi.fn().mockResolvedValue({
        status: "completed",
        steps: {
          "child-step": { status: "success", output: { stdout: "child" } }
        }
      }),
    };

    // Track which runs are created
    const createdRuns: string[] = [];
    
    // Mock createRunAsync to return the correct run instance based on call order
    mockWorkflow.createRunAsync.mockImplementation(async (runId: string) => {
      createdRuns.push(runId);
      // First call is parent, subsequent calls are child
      if (createdRuns.length === 1) {
        return parentRunMock;
      }
      return childRunMock;
    });

    // Mock factory.compile to handle the dynamic registration
    const childMockWorkflow = {
      createRunAsync: vi.fn().mockResolvedValue(childRunMock),
    };
    (mockFactory.compile as ReturnType<typeof vi.fn>).mockImplementation((def) => ({
      id: def.id,
      workflow: childMockWorkflow
    }));

    // Mock factory.get to return the parent workflow
    (mockFactory.get as ReturnType<typeof vi.fn>).mockImplementation((id) => {
      if (id === parentWorkflowId) {
        return { id: parentWorkflowId, workflow: mockWorkflow };
      }
      return undefined;
    });

    // Execute the parent workflow
    await runner.run(parentWorkflowId);
    
    // Wait for async recursion to complete
    await new Promise((r) => setTimeout(r, 150));

    // The dynamic workflow ID includes the parent runId to prevent race conditions
    const expectedUniqueId = `${subWorkflowId}-test-uuid-1234`;

    // Verify parent generated the dynamic workflow and it was compiled with unique ID
    expect(mockFactory.compile).toHaveBeenCalledWith(
      expect.objectContaining({ id: expectedUniqueId })
    );

    // Verify child workflow was started
    expect(childMockWorkflow.createRunAsync).toHaveBeenCalled();
    expect(childRunMock.start).toHaveBeenCalled();

    // Verify parent run results contain the link to the child run
    const parentRun = runner.getAllRuns().find(r => r.workflowId === parentWorkflowId);
    expect(parentRun).toBeDefined();
    expect(parentRun?.stepResults["dynamic:plan-step"]).toBeDefined();
    expect(parentRun?.stepResults["dynamic:plan-step"].output).toEqual({
      result: {
        subWorkflowId: expectedUniqueId,
        subRunId: expect.any(String)
      }
    });

    // Verify the log message about executing dynamic sub-workflow
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining(`Executing dynamic sub-workflow: ${expectedUniqueId}`)
    );
  });

  it("should not execute dynamic workflow when step output has no workflow property", async () => {
    // Regular step output without workflow
    mockMastraRun.start.mockResolvedValue({
      status: "completed",
      steps: {
        "regular-step": {
          status: "success",
          output: { result: "some data" }
        }
      }
    });

    await runner.run("test-workflow");
    await new Promise((r) => setTimeout(r, 50));

    // factory.compile should NOT be called since no dynamic workflow
    expect(mockFactory.compile).not.toHaveBeenCalled();
  });

  it("should handle dynamic workflow execution failure gracefully", async () => {
    const subWorkflowId = "failing-sub-workflow";

    // Parent returns a dynamic workflow
    mockMastraRun.start.mockResolvedValue({
      status: "completed",
      steps: {
        "plan-step": {
          status: "success",
          output: {
            workflow: {
              id: subWorkflowId,
              steps: [{ id: "fail-step", type: "shell", command: "exit 1" }]
            }
          }
        }
      }
    });

    // Mock child workflow that fails
    const failingChildRun = {
      start: vi.fn().mockRejectedValue(new Error("Child workflow failed")),
    };
    const childMockWorkflow = {
      createRunAsync: vi.fn().mockResolvedValue(failingChildRun),
    };
    (mockFactory.compile as ReturnType<typeof vi.fn>).mockReturnValue({
      id: subWorkflowId,
      workflow: childMockWorkflow
    });

    await runner.run("test-workflow");
    await new Promise((r) => setTimeout(r, 100));

    // The parent workflow should still complete (failure in recursive call handled)
    const runs = runner.getAllRuns();
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("WorkflowRunner without storage", () => {
  let runner: WorkflowRunner;
  let mockFactory: WorkflowFactory;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const mockWorkflow = {
      createRunAsync: vi.fn().mockResolvedValue({
        start: vi.fn().mockResolvedValue({ status: "completed", steps: {} }),
        resume: vi.fn().mockResolvedValue({ status: "completed", steps: {} }),
      }),
    };

    mockFactory = {
      get: vi.fn().mockReturnValue({
        workflow: mockWorkflow,
        id: "test-workflow",
      }),
      has: vi.fn().mockReturnValue(true),
      compile: vi.fn(),
      list: vi.fn().mockReturnValue(["test-workflow"]),
      clear: vi.fn(),
      compileAll: vi.fn(),
    } as unknown as WorkflowFactory;

    // No storage provided
    runner = new WorkflowRunner(mockFactory, mockLogger);
  });

  it("should work without storage", async () => {
    const runId = await runner.run("test-workflow");
    expect(runId).toBeDefined();
  });

  it("should not attempt to persist without storage", async () => {
    await runner.run("test-workflow");
    // Just verify no errors occur
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("WorkflowRunner hydration after restart", () => {
  let runner: WorkflowRunner;
  let mockFactory: WorkflowFactory;
  let mockStorage: WorkflowStorage;
  let mockLogger: Logger;
  let mockMastraRun: {
    start: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };
  let mockWorkflow: {
    createRunAsync: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    mockMastraRun = {
      start: vi.fn().mockResolvedValue({ status: "completed", steps: {} }),
      resume: vi.fn().mockResolvedValue({ status: "completed", steps: {} }),
    };

    mockWorkflow = {
      createRunAsync: vi.fn().mockResolvedValue(mockMastraRun),
    };

    const mockCompiledWorkflow: WorkflowFactoryResult = {
      workflow: mockWorkflow,
      id: "test-workflow",
      description: "Test workflow",
    };

    mockFactory = {
      get: vi.fn().mockReturnValue(mockCompiledWorkflow),
      has: vi.fn().mockReturnValue(true),
      compile: vi.fn(),
      list: vi.fn().mockReturnValue(["test-workflow"]),
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
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowStorage;

    runner = new WorkflowRunner(mockFactory, mockLogger, mockStorage);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should hydrate run with previous step results when resuming after restart", async () => {
    // Simulate a run that was restored from storage (suspended state with step results)
    const restoredRun: WorkflowRun = {
      runId: "restored-run-123",
      workflowId: "test-workflow",
      status: "suspended",
      inputs: { version: "1.0.0" },
      stepResults: {
        "step-1": {
          stepId: "step-1",
          status: "success",
          output: { stdout: "build output", stderr: "", exitCode: 0 },
          startedAt: new Date(),
          completedAt: new Date(),
        },
        "step-2": {
          stepId: "step-2",
          status: "success",
          output: { response: "LLM analysis result" },
          startedAt: new Date(),
          completedAt: new Date(),
        },
      },
      currentStepId: "step-3",
      startedAt: new Date(),
    };

    // Add the restored run to the runner (simulating what init() does)
    runner.addRun(restoredRun);

    // Now resume - this should trigger hydration since mastraRun is not in memory
    await runner.resume("restored-run-123", { approved: true });

    // Verify workflow was recreated
    expect(mockWorkflow.createRunAsync).toHaveBeenCalledWith("restored-run-123");

    // Verify hydration happened - start() should be called with previous step outputs
    expect(mockMastraRun.start).toHaveBeenCalledWith({
      inputData: {
        inputs: { version: "1.0.0" },
        secretInputs: [],
        steps: {
          "step-1": { stdout: "build output", stderr: "", exitCode: 0 },
          "step-2": { response: "LLM analysis result" },
        },
      },
    });

    // Verify resume was called after hydration
    expect(mockMastraRun.resume).toHaveBeenCalledWith({
      stepId: "step-3",
      data: { approved: true },
    });

    // Verify debug log about hydration
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Hydrating run with 2 previous step outputs")
    );
  });

  it("should not hydrate when no previous step results exist", async () => {
    const restoredRun: WorkflowRun = {
      runId: "fresh-run-123",
      workflowId: "test-workflow",
      status: "suspended",
      inputs: {},
      stepResults: {}, // No previous results
      currentStepId: "step-1",
      startedAt: new Date(),
    };

    runner.addRun(restoredRun);

    await runner.resume("fresh-run-123");

    // start() should NOT be called since there's nothing to hydrate
    expect(mockMastraRun.start).not.toHaveBeenCalled();

    // resume should still be called
    expect(mockMastraRun.resume).toHaveBeenCalledWith({
      stepId: "step-1",
      data: undefined,
    });
  });

  it("should not hydrate when run is still in memory", async () => {
    // Start a fresh run that suspends
    mockMastraRun.start.mockResolvedValue({
      status: "suspended",
      steps: { "step-1": { status: "suspended" } },
    });

    const { randomUUID } = await import("node:crypto");
    (randomUUID as ReturnType<typeof vi.fn>).mockReturnValue("in-memory-run");

    await runner.run("test-workflow");
    await new Promise((r) => setTimeout(r, 50));

    // Reset mock to track resume behavior
    mockMastraRun.start.mockClear();
    mockMastraRun.resume.mockResolvedValue({ status: "completed", steps: {} });

    // Resume the same run (still in memory)
    await runner.resume("in-memory-run");

    // start() should NOT be called since run is still in memory (no hydration needed)
    expect(mockMastraRun.start).not.toHaveBeenCalled();

    // resume should be called
    expect(mockMastraRun.resume).toHaveBeenCalled();
  });

  it("should save step results when workflow suspends", async () => {
    mockMastraRun.start.mockResolvedValue({
      status: "suspended",
      steps: {
        "step-1": { status: "success", output: { stdout: "done" } },
        "step-2": { status: "suspended", output: {} },
      },
    });

    const { randomUUID } = await import("node:crypto");
    (randomUUID as ReturnType<typeof vi.fn>).mockReturnValue("save-results-run");

    await runner.run("test-workflow");
    await new Promise((r) => setTimeout(r, 50));

    const run = runner.getStatus("save-results-run");
    expect(run?.stepResults["step-1"]).toBeDefined();
    expect(run?.stepResults["step-1"].status).toBe("success");
    expect(run?.stepResults["step-1"].output).toEqual({ stdout: "done" });
  });

  it("should save step results when workflow completes", async () => {
    mockMastraRun.start.mockResolvedValue({
      status: "completed",
      steps: {
        "step-1": { status: "success", output: { stdout: "output1" } },
        "step-2": { status: "completed", output: { result: "final" } },
      },
    });

    const { randomUUID } = await import("node:crypto");
    (randomUUID as ReturnType<typeof vi.fn>).mockReturnValue("complete-run");

    await runner.run("test-workflow");
    await new Promise((r) => setTimeout(r, 50));

    const run = runner.getStatus("complete-run");
    expect(run?.stepResults["step-1"]).toBeDefined();
    expect(run?.stepResults["step-2"]).toBeDefined();
  });

  it("should only save successful step results for hydration", async () => {
    mockMastraRun.start.mockResolvedValue({
      status: "suspended",
      steps: {
        "step-1": { status: "success", output: { data: "ok" } },
        "step-2": { status: "failed", output: "error message" },
        "step-3": { status: "pending" },
        "step-4": { status: "suspended" },
      },
    });

    const { randomUUID } = await import("node:crypto");
    (randomUUID as ReturnType<typeof vi.fn>).mockReturnValue("mixed-status-run");

    await runner.run("test-workflow");
    await new Promise((r) => setTimeout(r, 50));

    const run = runner.getStatus("mixed-status-run");
    
    // Only step-1 (success) and step-2 (failed) should be saved
    expect(run?.stepResults["step-1"]).toBeDefined();
    expect(run?.stepResults["step-1"].status).toBe("success");
    expect(run?.stepResults["step-2"]).toBeDefined();
    expect(run?.stepResults["step-2"].status).toBe("failed");
    
    // Pending and suspended steps should not be saved
    expect(run?.stepResults["step-3"]).toBeUndefined();
    expect(run?.stepResults["step-4"]).toBeUndefined();
  });
});
