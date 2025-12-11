import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleWorkflowCommand, type WorkflowCommandContext } from "./handler.js";
import type { WorkflowDefinition, WorkflowRun, Logger } from "../types.js";
import type { WorkflowFactory } from "../factory/index.js";
import type { WorkflowRunner } from "./runner.js";

describe("handleWorkflowCommand", () => {
  let mockCtx: WorkflowCommandContext;
  let mockRunner: WorkflowRunner;
  let mockFactory: WorkflowFactory;
  let mockLog: Logger;
  let definitions: Map<string, WorkflowDefinition>;

  beforeEach(() => {
    mockLog = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    mockRunner = {
      run: vi.fn().mockResolvedValue("run-123"),
      getStatus: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      listRuns: vi.fn().mockReturnValue([]),
      init: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowRunner;

    mockFactory = {
      compile: vi.fn(),
      get: vi.fn(),
      has: vi.fn(),
      list: vi.fn(),
      clear: vi.fn(),
      compileAll: vi.fn(),
    } as unknown as WorkflowFactory;

    definitions = new Map();

    mockCtx = {
      factory: mockFactory,
      runner: mockRunner,
      definitions,
      log: mockLog,
    };
  });

  describe("list command", () => {
    it("should list available workflows", async () => {
      definitions.set("deploy", {
        id: "deploy",
        description: "Deploy to production",
        steps: [{ id: "s1", type: "shell", command: "echo" }],
      });
      definitions.set("test", {
        id: "test",
        description: "Run tests",
        tags: ["ci", "test"],
        steps: [{ id: "s1", type: "shell", command: "npm test" }],
      });

      const result = await handleWorkflowCommand("list", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("deploy");
      expect(result.message).toContain("Deploy to production");
      expect(result.message).toContain("test");
      expect(result.message).toContain("[ci, test]");
      expect(result.data).toEqual(["deploy", "test"]);
    });

    it("should handle empty workflow list", async () => {
      const result = await handleWorkflowCommand("list", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("No workflows found");
    });

    it("should work with ls alias", async () => {
      const result = await handleWorkflowCommand("ls", mockCtx);
      expect(result.success).toBe(true);
    });
  });

  describe("show command", () => {
    beforeEach(() => {
      definitions.set("deploy", {
        id: "deploy",
        description: "Deploy to production",
        inputs: {
          version: "string",
          dryRun: "boolean",
        },
        steps: [
          { id: "build", type: "shell", command: "npm run build" },
          { id: "test", type: "shell", command: "npm test", after: ["build"], description: "Run unit tests" },
          { id: "deploy", type: "shell", command: "deploy.sh", after: ["test"] },
        ],
      });
    });

    it("should show workflow details", async () => {
      const result = await handleWorkflowCommand("show deploy", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("Workflow: deploy");
      expect(result.message).toContain("Deploy to production");
      expect(result.message).toContain("version");
      expect(result.message).toContain("dryRun");
      expect(result.message).toContain("build");
      expect(result.message).toContain("test");
      expect(result.message).toContain("(after: build)");
    });

    it("should return error for missing workflow id", async () => {
      const result = await handleWorkflowCommand("show", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Usage:");
    });

    it("should return error for unknown workflow", async () => {
      const result = await handleWorkflowCommand("show unknown", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Workflow not found");
    });

    it("should work with info alias", async () => {
      const result = await handleWorkflowCommand("info deploy", mockCtx);
      expect(result.success).toBe(true);
    });
  });

  describe("run command", () => {
    beforeEach(() => {
      definitions.set("deploy", {
        id: "deploy",
        inputs: { version: "string" },
        steps: [{ id: "s1", type: "shell", command: "echo" }],
      });
    });

    it("should run a workflow", async () => {
      const result = await handleWorkflowCommand("run deploy", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("Started workflow");
      expect(result.message).toContain("run-123");
      expect(mockRunner.run).toHaveBeenCalledWith("deploy", {});
    });

    it("should pass parameters to workflow with type inference", async () => {
      const result = await handleWorkflowCommand("run deploy version=1.0.0 dryRun=true", mockCtx);

      expect(result.success).toBe(true);
      expect(mockRunner.run).toHaveBeenCalledWith("deploy", {
        version: "1.0.0",
        dryRun: true, // boolean, not string
      });
    });

    it("should infer number types from parameters", async () => {
      const result = await handleWorkflowCommand("run deploy count=5 ratio=3.14", mockCtx);

      expect(result.success).toBe(true);
      expect(mockRunner.run).toHaveBeenCalledWith("deploy", {
        count: 5, // number, not string
        ratio: 3.14, // number, not string
      });
    });

    it("should infer boolean false from parameters", async () => {
      const result = await handleWorkflowCommand("run deploy enabled=false", mockCtx);

      expect(result.success).toBe(true);
      expect(mockRunner.run).toHaveBeenCalledWith("deploy", {
        enabled: false, // boolean, not string
      });
    });

    it("should handle parameters with equals in value", async () => {
      const result = await handleWorkflowCommand("run deploy url=http://example.com?foo=bar", mockCtx);

      expect(mockRunner.run).toHaveBeenCalledWith("deploy", {
        url: "http://example.com?foo=bar",
      });
    });

    it("should return error for missing workflow id", async () => {
      const result = await handleWorkflowCommand("run", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Usage:");
    });

    it("should return error for unknown workflow", async () => {
      const result = await handleWorkflowCommand("run unknown", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Workflow not found");
    });

    it("should handle runner errors", async () => {
      vi.mocked(mockRunner.run).mockRejectedValue(new Error("Runner failed"));

      const result = await handleWorkflowCommand("run deploy", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to start workflow");
    });
  });

  describe("status command", () => {
    it("should show run status", async () => {
      const mockRun: WorkflowRun = {
        runId: "run-123",
        workflowId: "deploy",
        status: "running",
        startedAt: new Date("2024-01-01T00:00:00Z"),
        currentStepId: "build",
        stepResults: {
          init: { stepId: "init", status: "success", duration: 100, startedAt: new Date() },
        },
        inputs: {},
      };
      vi.mocked(mockRunner.getStatus).mockReturnValue(mockRun);

      const result = await handleWorkflowCommand("status run-123", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("run-123");
      expect(result.message).toContain("running");
      expect(result.message).toContain("build");
      expect(result.data).toBe(mockRun);
    });

    it("should show completed run with error", async () => {
      const mockRun: WorkflowRun = {
        runId: "run-456",
        workflowId: "deploy",
        status: "failed",
        startedAt: new Date("2024-01-01T00:00:00Z"),
        completedAt: new Date("2024-01-01T00:01:00Z"),
        error: "Build failed",
        stepResults: {
          build: { stepId: "build", status: "failed", error: "npm error", duration: 5000, startedAt: new Date() },
        },
        inputs: {},
      };
      vi.mocked(mockRunner.getStatus).mockReturnValue(mockRun);

      const result = await handleWorkflowCommand("status run-456", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("failed");
      expect(result.message).toContain("Build failed");
      expect(result.message).toContain("npm error");
    });

    it("should return error for missing run id", async () => {
      const result = await handleWorkflowCommand("status", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Usage:");
    });

    it("should return error for unknown run", async () => {
      vi.mocked(mockRunner.getStatus).mockReturnValue(undefined);

      const result = await handleWorkflowCommand("status unknown", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Run not found");
    });
  });

  describe("resume command", () => {
    it("should resume a suspended workflow", async () => {
      const result = await handleWorkflowCommand("resume run-123", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("Resumed");
      expect(mockRunner.resume).toHaveBeenCalledWith("run-123", undefined);
    });

    it("should pass JSON resume data", async () => {
      const result = await handleWorkflowCommand('resume run-123 {"approved": true}', mockCtx);

      expect(result.success).toBe(true);
      expect(mockRunner.resume).toHaveBeenCalledWith("run-123", { approved: true });
    });

    it("should pass plain string resume data if not valid JSON", async () => {
      const result = await handleWorkflowCommand("resume run-123 approved", mockCtx);

      expect(result.success).toBe(true);
      expect(mockRunner.resume).toHaveBeenCalledWith("run-123", "approved");
    });

    it("should return error for missing run id", async () => {
      const result = await handleWorkflowCommand("resume", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Usage:");
    });

    it("should handle resume errors", async () => {
      vi.mocked(mockRunner.resume).mockRejectedValue(new Error("Not suspended"));

      const result = await handleWorkflowCommand("resume run-123", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to resume");
    });
  });

  describe("cancel command", () => {
    it("should cancel a running workflow", async () => {
      const result = await handleWorkflowCommand("cancel run-123", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("Cancelled");
      expect(mockRunner.cancel).toHaveBeenCalledWith("run-123");
    });

    it("should return error for missing run id", async () => {
      const result = await handleWorkflowCommand("cancel", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Usage:");
    });

    it("should handle cancel errors", async () => {
      vi.mocked(mockRunner.cancel).mockRejectedValue(new Error("Already completed"));

      const result = await handleWorkflowCommand("cancel run-123", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to cancel");
    });
  });

  describe("runs command", () => {
    it("should list all runs", async () => {
      const mockRuns: WorkflowRun[] = [
        {
          runId: "run-1",
          workflowId: "deploy",
          status: "completed",
          startedAt: new Date("2024-01-01T00:00:00Z"),
          stepResults: {},
          inputs: {},
        },
        {
          runId: "run-2",
          workflowId: "test",
          status: "running",
          startedAt: new Date("2024-01-02T00:00:00Z"),
          stepResults: {},
          inputs: {},
        },
      ];
      vi.mocked(mockRunner.listRuns).mockReturnValue(mockRuns);

      const result = await handleWorkflowCommand("runs", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("run-1");
      expect(result.message).toContain("run-2");
      expect(result.data).toBe(mockRuns);
    });

    it("should filter runs by workflow id", async () => {
      vi.mocked(mockRunner.listRuns).mockReturnValue([]);

      await handleWorkflowCommand("runs deploy", mockCtx);

      expect(mockRunner.listRuns).toHaveBeenCalledWith("deploy");
    });

    it("should handle empty runs list", async () => {
      vi.mocked(mockRunner.listRuns).mockReturnValue([]);

      const result = await handleWorkflowCommand("runs", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("No workflow runs found");
    });

    it("should show workflow-specific message when no runs", async () => {
      vi.mocked(mockRunner.listRuns).mockReturnValue([]);

      const result = await handleWorkflowCommand("runs deploy", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("No runs found for workflow: deploy");
    });
  });

  describe("help command", () => {
    it("should show help text", async () => {
      const result = await handleWorkflowCommand("help", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("/workflow list");
      expect(result.message).toContain("/workflow run");
      expect(result.message).toContain("/workflow status");
      expect(result.message).toContain("/workflow resume");
      expect(result.message).toContain("/workflow cancel");
    });

    it("should show help for empty input", async () => {
      const result = await handleWorkflowCommand("", mockCtx);

      expect(result.success).toBe(true);
      expect(result.message).toContain("Workflow Commands");
    });
  });

  describe("unknown command", () => {
    it("should return error for unknown command", async () => {
      const result = await handleWorkflowCommand("unknown", mockCtx);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Unknown command");
      expect(result.message).toContain("/workflow help");
    });
  });

  describe("case insensitivity", () => {
    it("should handle uppercase commands", async () => {
      const result = await handleWorkflowCommand("LIST", mockCtx);
      expect(result.success).toBe(true);
    });

    it("should handle mixed case commands", async () => {
      const result = await handleWorkflowCommand("Help", mockCtx);
      expect(result.success).toBe(true);
    });
  });
});
