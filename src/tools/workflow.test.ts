import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  executeWorkflowTool,
  getWorkflowToolDefinition,
  WorkflowToolSchema,
  type WorkflowToolInput,
} from "./workflow.js";
import type { WorkflowDefinition, WorkflowRun } from "../types.js";
import type { WorkflowRunner } from "../commands/runner.js";

describe("executeWorkflowTool", () => {
  let mockRunner: WorkflowRunner;
  let definitions: Map<string, WorkflowDefinition>;

  beforeEach(() => {
    mockRunner = {
      run: vi.fn().mockResolvedValue("run-123"),
      getStatus: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      listRuns: vi.fn().mockReturnValue([]),
      init: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowRunner;

    definitions = new Map();
    definitions.set("deploy", {
      id: "deploy",
      description: "Deploy workflow",
      steps: [{ id: "s1", type: "shell", command: "echo deploy" }],
    });
    definitions.set("test", {
      id: "test",
      description: "Test workflow",
      steps: [{ id: "s1", type: "shell", command: "npm test" }],
    });
  });

  describe("list mode", () => {
    it("should list all workflows", async () => {
      const result = await executeWorkflowTool(
        { mode: "list" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("2 workflow(s)");
      expect(result.workflows).toHaveLength(2);
      expect(result.workflows?.[0].id).toBe("deploy");
    });

    it("should handle empty workflows", async () => {
      const result = await executeWorkflowTool(
        { mode: "list" },
        new Map(),
        mockRunner
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("0 workflow(s)");
      expect(result.workflows).toHaveLength(0);
    });
  });

  describe("show mode", () => {
    it("should show workflow details", async () => {
      const result = await executeWorkflowTool(
        { mode: "show", workflowId: "deploy" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(true);
      expect(result.workflow?.id).toBe("deploy");
      expect(result.workflow?.description).toBe("Deploy workflow");
    });

    it("should return error when workflowId is missing", async () => {
      const result = await executeWorkflowTool(
        { mode: "show" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("workflowId is required");
    });

    it("should return error for unknown workflow", async () => {
      const result = await executeWorkflowTool(
        { mode: "show", workflowId: "unknown" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("Workflow not found");
    });
  });

  describe("run mode", () => {
    it("should start a workflow", async () => {
      const result = await executeWorkflowTool(
        { mode: "run", workflowId: "deploy" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(true);
      expect(result.runId).toBe("run-123");
      expect(mockRunner.run).toHaveBeenCalledWith("deploy", {});
    });

    it("should pass parameters to workflow", async () => {
      const result = await executeWorkflowTool(
        { mode: "run", workflowId: "deploy", params: { version: "1.0.0" } },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(true);
      expect(mockRunner.run).toHaveBeenCalledWith("deploy", { version: "1.0.0" });
    });

    it("should return error when workflowId is missing", async () => {
      const result = await executeWorkflowTool(
        { mode: "run" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("workflowId is required");
    });

    it("should return error for unknown workflow", async () => {
      const result = await executeWorkflowTool(
        { mode: "run", workflowId: "unknown" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("Workflow not found");
    });

    it("should handle runner errors", async () => {
      vi.mocked(mockRunner.run).mockRejectedValue(new Error("Execution failed"));

      const result = await executeWorkflowTool(
        { mode: "run", workflowId: "deploy" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to start workflow");
    });
  });

  describe("status mode", () => {
    it("should return run status", async () => {
      const mockRun: WorkflowRun = {
        runId: "run-123",
        workflowId: "deploy",
        status: "running",
        startedAt: new Date(),
        stepResults: {},
        inputs: {},
      };
      vi.mocked(mockRunner.getStatus).mockReturnValue(mockRun);

      const result = await executeWorkflowTool(
        { mode: "status", runId: "run-123" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(true);
      expect(result.run?.runId).toBe("run-123");
      expect(result.message).toContain("running");
    });

    it("should return error when runId is missing", async () => {
      const result = await executeWorkflowTool(
        { mode: "status" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("runId is required");
    });

    it("should return error for unknown run", async () => {
      vi.mocked(mockRunner.getStatus).mockReturnValue(undefined);

      const result = await executeWorkflowTool(
        { mode: "status", runId: "unknown" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("Run not found");
    });
  });

  describe("resume mode", () => {
    it("should resume a suspended workflow", async () => {
      const mockRun: WorkflowRun = {
        runId: "run-123",
        workflowId: "deploy",
        status: "running",
        startedAt: new Date(),
        stepResults: {},
        inputs: {},
      };
      vi.mocked(mockRunner.getStatus).mockReturnValue(mockRun);

      const result = await executeWorkflowTool(
        { mode: "resume", runId: "run-123" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("Resumed");
      expect(mockRunner.resume).toHaveBeenCalledWith("run-123", undefined);
    });

    it("should pass resume data", async () => {
      vi.mocked(mockRunner.getStatus).mockReturnValue({
        runId: "run-123",
        workflowId: "deploy",
        status: "running",
        startedAt: new Date(),
        stepResults: {},
        inputs: {},
      });

      const result = await executeWorkflowTool(
        { mode: "resume", runId: "run-123", resumeData: { approved: true } },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(true);
      expect(mockRunner.resume).toHaveBeenCalledWith("run-123", { approved: true });
    });

    it("should return error when runId is missing", async () => {
      const result = await executeWorkflowTool(
        { mode: "resume" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("runId is required");
    });

    it("should handle resume errors", async () => {
      vi.mocked(mockRunner.resume).mockRejectedValue(new Error("Not suspended"));

      const result = await executeWorkflowTool(
        { mode: "resume", runId: "run-123" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to resume");
    });
  });

  describe("cancel mode", () => {
    it("should cancel a running workflow", async () => {
      const result = await executeWorkflowTool(
        { mode: "cancel", runId: "run-123" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("Cancelled");
      expect(mockRunner.cancel).toHaveBeenCalledWith("run-123");
    });

    it("should return error when runId is missing", async () => {
      const result = await executeWorkflowTool(
        { mode: "cancel" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("runId is required");
    });

    it("should handle cancel errors", async () => {
      vi.mocked(mockRunner.cancel).mockRejectedValue(new Error("Already completed"));

      const result = await executeWorkflowTool(
        { mode: "cancel", runId: "run-123" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to cancel");
    });
  });

  describe("runs mode", () => {
    it("should list all runs", async () => {
      const mockRuns: WorkflowRun[] = [
        {
          runId: "run-1",
          workflowId: "deploy",
          status: "completed",
          startedAt: new Date(),
          stepResults: {},
          inputs: {},
        },
      ];
      vi.mocked(mockRunner.listRuns).mockReturnValue(mockRuns);

      const result = await executeWorkflowTool(
        { mode: "runs" },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(true);
      expect(result.runs).toHaveLength(1);
      expect(mockRunner.listRuns).toHaveBeenCalledWith(undefined);
    });

    it("should filter runs by workflow id", async () => {
      vi.mocked(mockRunner.listRuns).mockReturnValue([]);

      await executeWorkflowTool(
        { mode: "runs", workflowId: "deploy" },
        definitions,
        mockRunner
      );

      expect(mockRunner.listRuns).toHaveBeenCalledWith("deploy");
    });
  });

  describe("unknown mode", () => {
    it("should return error for unknown mode", async () => {
      const result = await executeWorkflowTool(
        { mode: "invalid" as WorkflowToolInput["mode"] },
        definitions,
        mockRunner
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("Unknown mode");
    });
  });
});

describe("WorkflowToolSchema", () => {
  it("should validate valid list input", () => {
    const result = WorkflowToolSchema.safeParse({ mode: "list" });
    expect(result.success).toBe(true);
  });

  it("should validate valid run input with params", () => {
    const result = WorkflowToolSchema.safeParse({
      mode: "run",
      workflowId: "deploy",
      params: { version: "1.0.0", count: 5, enabled: true },
    });
    expect(result.success).toBe(true);
  });

  it("should validate valid resume input with resumeData", () => {
    const result = WorkflowToolSchema.safeParse({
      mode: "resume",
      runId: "run-123",
      resumeData: { approved: true, comment: "LGTM" },
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid mode", () => {
    const result = WorkflowToolSchema.safeParse({ mode: "invalid" });
    expect(result.success).toBe(false);
  });

  it("should allow nested resumeData", () => {
    const result = WorkflowToolSchema.safeParse({
      mode: "resume",
      runId: "run-123",
      resumeData: {
        user: { name: "John", id: 123 },
        items: [1, 2, 3],
        approved: true,
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("getWorkflowToolDefinition", () => {
  it("should return tool definition", () => {
    const def = getWorkflowToolDefinition();

    expect(def.name).toBe("workflow");
    expect(def.description).toContain("Execute and manage workflow automation");
    expect(def.description).toContain("list");
    expect(def.description).toContain("run");
    expect(def.description).toContain("resume");
    expect(def.args).toBe(WorkflowToolSchema);
  });
});
