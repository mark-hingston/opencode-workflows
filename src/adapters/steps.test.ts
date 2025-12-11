import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpencodeClient } from "../types.js";

// Mock child_process before importing steps
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

// Mock @mastra/core/workflows to return our execute function
vi.mock("@mastra/core/workflows", () => ({
  createStep: vi.fn((config) => ({
    id: config.id,
    execute: config.execute,
    description: config.description,
  })),
}));

// Import after mocks
import {
  createShellStep,
  createToolStep,
  createAgentStep,
  createSuspendStep,
  createHttpStep,
  createFileStep,
} from "./steps.js";
import { exec } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";

describe("Step Adapters", () => {
  let mockClient: OpencodeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      tools: {
        testTool: {
          execute: vi.fn().mockResolvedValue({ success: true }),
        },
      },
      llm: {
        chat: vi.fn().mockResolvedValue({ content: "LLM response" }),
      },
      app: {
        log: vi.fn(),
      },
    };
  });

  // =============================================================================
  // Suspend Step Tests
  // =============================================================================
  describe("createSuspendStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists in data.steps", async () => {
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Please approve",
        });

        const previousResult = {
          resumed: true,
          data: { approved: true },
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "approval-step": previousResult,
            },
          },
          suspend: vi.fn(),
          resumeData: undefined,
        } as unknown as Parameters<typeof step.execute>[0]);

        // Should return the cached result without calling suspend
        expect(result).toEqual(previousResult);
      });

      it("should not skip when actively resuming this step (resumeData provided)", async () => {
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Please approve",
        });

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              // Even if a previous result exists...
              "approval-step": { resumed: true, data: { old: "data" } },
            },
          },
          suspend: vi.fn(),
          // ...resumeData takes precedence because we're actively resuming
          resumeData: { approved: true, newData: "fresh" },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({
          resumed: true,
          data: { approved: true, newData: "fresh" },
        });
      });

      it("should suspend when no previous result exists", async () => {
        const suspendFn = vi.fn();
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Please approve deployment",
        });

        await step.execute({
          inputData: {
            inputs: {},
            steps: {}, // No previous results
          },
          suspend: suspendFn,
          resumeData: undefined,
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(suspendFn).toHaveBeenCalledWith({
          message: "Please approve deployment",
        });
      });

      it("should handle multiple suspend steps in sequence (hydration scenario)", async () => {
        // This tests the scenario where we have:
        // Step A -> Suspend B -> Step C -> Suspend D
        // And we're rehydrating at Suspend D

        const suspendB = createSuspendStep({
          id: "suspend-b",
          type: "suspend",
          message: "First approval",
        });

        const suspendD = createSuspendStep({
          id: "suspend-d",
          type: "suspend",
          message: "Second approval",
        });

        const suspendFn = vi.fn();
        const previousSteps = {
          "step-a": { stdout: "done", exitCode: 0 },
          "suspend-b": { resumed: true, data: { approved: true } },
          "step-c": { stdout: "processed", exitCode: 0 },
          // suspend-d is NOT in steps - it's where we're suspended
        };

        // Suspend B should be skipped (already completed)
        const resultB = await suspendB.execute({
          inputData: {
            inputs: {},
            steps: previousSteps,
          },
          suspend: suspendFn,
          resumeData: undefined,
        } as unknown as Parameters<typeof suspendB.execute>[0]);

        expect(resultB).toEqual({ resumed: true, data: { approved: true } });
        expect(suspendFn).not.toHaveBeenCalled();

        // Suspend D should actually suspend (not in previous steps)
        suspendFn.mockClear();
        await suspendD.execute({
          inputData: {
            inputs: {},
            steps: previousSteps,
          },
          suspend: suspendFn,
          resumeData: undefined,
        } as unknown as Parameters<typeof suspendD.execute>[0]);

        expect(suspendFn).toHaveBeenCalledWith({
          message: "Second approval",
        });
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition evaluates to false", async () => {
        const step = createSuspendStep({
          id: "conditional-suspend",
          type: "suspend",
          message: "Approval needed",
          condition: "{{inputs.needsApproval}}",
        });

        const result = await step.execute({
          inputData: {
            inputs: { needsApproval: "false" },
            steps: {},
          },
          suspend: vi.fn(),
          resumeData: undefined,
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({
          resumed: false,
          data: undefined,
          skipped: true,
        });
      });
    });

    describe("resume data validation", () => {
      it("should validate resume data against schema", async () => {
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Approve?",
          resumeSchema: {
            approved: { type: "boolean" },
            reason: { type: "string" },
          },
        });

        // Missing required field should throw
        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
            suspend: vi.fn(),
            resumeData: { approved: true }, // missing 'reason'
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Missing required resume data: reason");
      });

      it("should reject non-object resume data when schema exists", async () => {
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Approve?",
          resumeSchema: {
            approved: { type: "boolean" },
          },
        });

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
            suspend: vi.fn(),
            resumeData: "invalid",
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Resume data must be an object");
      });
    });
  });

  // =============================================================================
  // Shell Step Tests
  // =============================================================================
  describe("createShellStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createShellStep(
          {
            id: "build-step",
            type: "shell",
            command: "npm run build",
          },
          mockClient
        );

        const previousResult = {
          stdout: "Build complete",
          stderr: "",
          exitCode: 0,
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "build-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
        expect(exec).not.toHaveBeenCalled();
        expect(mockClient.app.log).toHaveBeenCalledWith(
          "Skipping already-completed step: build-step",
          "info"
        );
      });
    });
  });

  // =============================================================================
  // Tool Step Tests
  // =============================================================================
  describe("createToolStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createToolStep(
          {
            id: "tool-step",
            type: "tool",
            tool: "testTool",
            args: { input: "test" },
          },
          mockClient
        );

        const previousResult = {
          result: { success: true, data: "cached" },
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "tool-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
        expect(mockClient.tools.testTool.execute).not.toHaveBeenCalled();
        expect(mockClient.app.log).toHaveBeenCalledWith(
          "Skipping already-completed step: tool-step",
          "info"
        );
      });
    });
  });

  // =============================================================================
  // Agent Step Tests
  // =============================================================================
  describe("createAgentStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createAgentStep(
          {
            id: "agent-step",
            type: "agent",
            prompt: "Analyze this",
          },
          mockClient
        );

        const previousResult = {
          response: "Previous LLM response",
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "agent-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
        expect(mockClient.llm.chat).not.toHaveBeenCalled();
        expect(mockClient.app.log).toHaveBeenCalledWith(
          "Skipping already-completed step: agent-step",
          "info"
        );
      });
    });
  });

  // =============================================================================
  // HTTP Step Tests
  // =============================================================================
  describe("createHttpStep", () => {
    beforeEach(() => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"data":"response"}'),
        headers: new Map([["content-type", "application/json"]]),
      });
    });

    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createHttpStep({
          id: "http-step",
          type: "http",
          method: "POST",
          url: "https://api.example.com/webhook",
        });

        const previousResult = {
          status: 200,
          body: { success: true },
          text: '{"success":true}',
          headers: {},
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "http-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
        expect(global.fetch).not.toHaveBeenCalled();
      });
    });
  });

  // =============================================================================
  // File Step Tests
  // =============================================================================
  describe("createFileStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createFileStep({
          id: "file-step",
          type: "file",
          action: "write",
          path: "/tmp/output.txt",
          content: "test content",
        });

        const previousResult = {
          success: true,
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "file-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
        expect(writeFile).not.toHaveBeenCalled();
      });
    });
  });
});
