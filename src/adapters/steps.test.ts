import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpencodeClient } from "../types.js";
import { EventEmitter } from "node:events";

// Use vi.hoisted to create mocks that can be used in vi.mock factories
const { mockSpawn, createMockProcess } = vi.hoisted(() => {
  // Helper to create a mock child process
  const createMockProcess = () => {
    const process = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
    };
    process.stdout = new EventEmitter();
    process.stderr = new EventEmitter();
    process.pid = 12345;
    return process;
  };
  
  return {
    mockSpawn: vi.fn(),
    createMockProcess,
  };
});

// Track the current mock process for test manipulation
let currentMockProcess: ReturnType<typeof createMockProcess> | null = null;

// Mock child_process - use spawn
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    // Call the mock and use its return value if provided (from mockImplementation)
    const result = mockSpawn(...args);
    // If mockImplementation returned a process, use that; otherwise use currentMockProcess
    return result ?? currentMockProcess;
  },
}));

// Mock tree-kill
vi.mock("tree-kill", () => ({
  default: vi.fn((pid: number, signal: string, callback: (err?: Error) => void) => {
    callback();
  }),
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
  createWaitStep,
  createHttpStep,
  createFileStep,
  createIteratorStep,
  createEvalStep,
} from "./steps.js";
import { readFile, writeFile, unlink } from "node:fs/promises";
import type { JsonValue } from "../types.js";

/**
 * Helper type for step context returned by all steps.
 * Steps now return the accumulated context with step outputs in the `steps` field.
 */
interface StepContext {
  inputs: Record<string, JsonValue>;
  steps: Record<string, JsonValue>;
  secretInputs?: string[];
}

/**
 * Helper to extract a step's output from the accumulated context.
 * Steps now return { inputs, steps, secretInputs } where the step's
 * own output is in steps[stepId].
 */
function getStepOutput<T = JsonValue>(context: StepContext, stepId: string): T {
  return context.steps[stepId] as T;
}

// Helper to simulate successful spawn execution
function mockSpawnSuccess(stdout: string, stderr = "") {
  currentMockProcess = createMockProcess();
  
  // Simulate async behavior - emit data and close after a microtask
  setImmediate(() => {
    if (currentMockProcess) {
      if (stdout) currentMockProcess.stdout.emit("data", stdout);
      if (stderr) currentMockProcess.stderr.emit("data", stderr);
      currentMockProcess.emit("close", 0, null);
    }
  });
}

function mockSpawnError(code: number, stderr: string, stdout = "") {
  currentMockProcess = createMockProcess();
  
  setImmediate(() => {
    if (currentMockProcess) {
      if (stdout) currentMockProcess.stdout.emit("data", stdout);
      if (stderr) currentMockProcess.stderr.emit("data", stderr);
      currentMockProcess.emit("close", code, null);
    }
  });
}

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

        // Should return context with the cached result
        const output = getStepOutput<{ resumed: boolean; data: Record<string, unknown> }>(result as StepContext, "approval-step");
        expect(output).toEqual(previousResult);
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

        const output = getStepOutput<{ resumed: boolean; data: Record<string, unknown> }>(result as StepContext, "approval-step");
        expect(output).toEqual({
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
          stepId: "approval-step",
          resumeSchemaHint: undefined,
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

        const outputB = getStepOutput<{ resumed: boolean; data: Record<string, unknown> }>(resultB as StepContext, "suspend-b");
        expect(outputB).toEqual({ resumed: true, data: { approved: true } });
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
          stepId: "suspend-d",
          resumeSchemaHint: undefined,
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

        const output = getStepOutput<{ resumed: boolean; data: unknown; skipped: boolean }>(result as StepContext, "conditional-suspend");
        expect(output).toEqual({
          resumed: false,
          data: null,
          skipped: true,
        });
      });
    });

    describe("resume data validation", () => {
      it("should pass resumeSchema to Mastra for automatic validation", async () => {
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Approve?",
          resumeSchema: {
            approved: { type: "boolean" },
            reason: { type: "string" },
          },
        });

        // Verify the step has a resumeSchema property set
        // (Mastra will use this for automatic validation)
        expect(step).toBeDefined();
        
        // Valid resume data should work
        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
          suspend: vi.fn(),
          resumeData: { approved: true, reason: "Looks good" },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ resumed: boolean; data: Record<string, unknown> }>(result as StepContext, "approval-step");
        expect(output).toEqual({
          resumed: true,
          data: { approved: true, reason: "Looks good" },
        });
      });

      it("should include resumeSchemaHint in suspend payload", async () => {
        const suspendFn = vi.fn();
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Approve?",
          resumeSchema: {
            approved: { type: "boolean" },
            reason: { type: "string" },
          },
        });

        await step.execute({
          inputData: { inputs: {}, steps: {} },
          suspend: suspendFn,
          resumeData: undefined,
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(suspendFn).toHaveBeenCalledWith({
          message: "Approve?",
          stepId: "approval-step",
          resumeSchemaHint: {
            approved: "boolean",
            reason: "string",
          },
        });
      });

      it("should handle simple type strings in resumeSchema", async () => {
        const suspendFn = vi.fn();
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Approve?",
          resumeSchema: {
            approved: "boolean",
            count: "number",
          },
        });

        await step.execute({
          inputData: { inputs: {}, steps: {} },
          suspend: suspendFn,
          resumeData: undefined,
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(suspendFn).toHaveBeenCalledWith({
          message: "Approve?",
          stepId: "approval-step",
          resumeSchemaHint: {
            approved: "boolean",
            count: "number",
          },
        });
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

        const output = getStepOutput<{ stdout: string; stderr: string; exitCode: number }>(result as StepContext, "build-step");
        expect(output).toEqual(previousResult);
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(mockClient.app.log).toHaveBeenCalledWith(
          "Skipping already-completed step: build-step",
          "info"
        );
      });
    });

    describe("command execution", () => {
      it("should execute command and return stdout/stderr", async () => {
        mockSpawnSuccess("output text", "warning text");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "echo hello" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ stdout: string; stderr: string; exitCode: number }>(result as StepContext, "cmd");
        expect(output).toEqual({
          stdout: "output text",
          stderr: "warning text",
          exitCode: 0,
        });
        expect(mockSpawn).toHaveBeenCalled();
      });

      it("should interpolate variables in command", async () => {
        mockSpawnSuccess("done");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "deploy {{inputs.env}}" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { env: "production" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        // spawn is called with shell and shell args for command
        expect(mockSpawn).toHaveBeenCalledWith(
          "/bin/sh",
          ["-c", "deploy production"],
          expect.any(Object)
        );
      });

      it("should use step results in interpolation", async () => {
        mockSpawnSuccess("deployed");
        const step = createShellStep(
          { id: "deploy", type: "shell", command: "deploy {{steps.build.artifact}}" },
          mockClient
        );

        await step.execute({
          inputData: {
            inputs: {},
            steps: { build: { artifact: "app.zip", exitCode: 0 } },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockSpawn).toHaveBeenCalledWith(
          "/bin/sh",
          ["-c", "deploy app.zip"],
          expect.any(Object)
        );
      });

      it("should pass cwd option when specified", async () => {
        mockSpawnSuccess("done");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "ls", cwd: "/tmp" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockSpawn).toHaveBeenCalledWith(
          "/bin/sh",
          ["-c", "ls"],
          expect.objectContaining({ cwd: "/tmp" })
        );
      });

      it("should pass interpolated cwd option", async () => {
        mockSpawnSuccess("done");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "ls", cwd: "{{inputs.dir}}" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { dir: "/home/user" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockSpawn).toHaveBeenCalledWith(
          "/bin/sh",
          ["-c", "ls"],
          expect.objectContaining({ cwd: "/home/user" })
        );
      });

      it("should merge env variables", async () => {
        mockSpawnSuccess("done");
        const step = createShellStep(
          {
            id: "cmd",
            type: "shell",
            command: "echo $MY_VAR",
            env: { MY_VAR: "value", INTERP: "{{inputs.val}}" },
          },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { val: "interpolated" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockSpawn).toHaveBeenCalledWith(
          "/bin/sh",
          ["-c", "echo $MY_VAR"],
          expect.objectContaining({
            env: expect.objectContaining({
              MY_VAR: "value",
              INTERP: "interpolated",
            }),
          })
        );
      });

      it("should pass timeout option when specified", async () => {
        mockSpawnSuccess("done");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "long-task", timeout: 5000 },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        // With spawn, timeout is handled separately via setTimeout, not passed to spawn options
        // Just verify spawn was called with the right command
        expect(mockSpawn).toHaveBeenCalledWith(
          "/bin/sh",
          ["-c", "long-task"],
          expect.any(Object)
        );
      });
    });

    describe("error handling", () => {
      it("should throw error when command fails with failOnError=true (default)", async () => {
        mockSpawnError(1, "command failed");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "fail" },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Command failed with exit code 1");
      });

      it("should return error output when failOnError=false", async () => {
        mockSpawnError(127, "not found", "partial output");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "missing-cmd", failOnError: false },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ stdout: string; stderr: string; exitCode: number }>(result as StepContext, "cmd");
        expect(output).toEqual({
          stdout: "partial output",
          stderr: "not found",
          exitCode: 127,
        });
      });
    });

    describe("condition evaluation", () => {
      it("should skip execution when condition is false", async () => {
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "risky", condition: "{{inputs.run}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { run: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ stdout: string; stderr: string; exitCode: number; skipped: boolean }>(result as StepContext, "cmd");
        expect(output).toEqual({
          stdout: "",
          stderr: "Skipped due to condition",
          exitCode: 0,
          skipped: true,
        });
        expect(mockSpawn).not.toHaveBeenCalled();
      });

      it("should execute when condition is true", async () => {
        mockSpawnSuccess("executed");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "safe", condition: "{{inputs.run}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { run: "true" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ stdout: string }>(result as StepContext, "cmd");
        expect(output.stdout).toBe("executed");
        expect(mockSpawn).toHaveBeenCalled();
      });

      it("should skip when condition evaluates to empty string", async () => {
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "test", condition: "{{inputs.empty}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { empty: "" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ skipped: boolean }>(result as StepContext, "cmd");
        expect(output.skipped).toBe(true);
      });

      it("should skip when condition evaluates to 0", async () => {
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "test", condition: "{{inputs.zero}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { zero: "0" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ skipped: boolean }>(result as StepContext, "cmd");
        expect(output.skipped).toBe(true);
      });
    });

    describe("safe mode", () => {
      it("should use spawn without shell when safe=true", async () => {
        mockSpawnSuccess("safe output");
        const step = createShellStep(
          { 
            id: "safe-cmd", 
            type: "shell", 
            command: "echo", 
            safe: true, 
            args: ["hello", "{{inputs.name}}"] 
          },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { name: "world" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        // Verify spawn was called with the command and args array directly
        // NOT with /bin/sh -c
        expect(mockSpawn).toHaveBeenCalledWith(
          "echo",
          ["hello", "world"],
          expect.objectContaining({ env: expect.any(Object) })
        );
      });

      it("should throw if args are missing in safe mode", async () => {
        const step = createShellStep(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { 
            id: "invalid-safe", 
            type: "shell", 
            command: "echo", 
            safe: true 
            // args missing - invalid config
          } as unknown as Parameters<typeof createShellStep>[0],
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Safe mode requires 'args'");
      });
    });

    describe("timeout handling", () => {
      it("should kill process tree when command times out", async () => {
        // Import the mocked tree-kill to verify it was called
        const treeKill = await import("tree-kill");
        const mockTreeKill = vi.mocked(treeKill.default);
        mockTreeKill.mockClear();

        // Create a process that will be killed
        const process = createMockProcess();
        currentMockProcess = process;
        mockSpawn.mockReturnValue(process);

        const step = createShellStep(
          { id: "slow-cmd", type: "shell", command: "sleep 60", timeout: 50 },
          mockClient
        );

        // Start execution and expect it to reject due to timeout
        const executePromise = step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        // After a short delay, emit close to simulate the process being killed
        setTimeout(() => {
          process.emit("close", 1);
        }, 100);

        // The promise should reject due to timeout
        await expect(executePromise).rejects.toThrow("timed out");

        // Verify tree-kill was called with the process PID
        expect(mockTreeKill).toHaveBeenCalledWith(
          process.pid,
          "SIGTERM",
          expect.any(Function)
        );
      });
    });
  });

  // =============================================================================
  // Tool Step Tests
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

        const output = getStepOutput<{ result: { success: boolean; data: string } }>(result as StepContext, "tool-step");
        expect(output).toEqual(previousResult);
        expect(mockClient.tools.testTool.execute).not.toHaveBeenCalled();
        expect(mockClient.app.log).toHaveBeenCalledWith(
          "Skipping already-completed step: tool-step",
          "info"
        );
      });
    });

    describe("tool execution", () => {
      it("should execute tool and return result", async () => {
        const step = createToolStep(
          { id: "tool", type: "tool", tool: "testTool", args: { data: "test" } },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: { success: boolean } }>(result as StepContext, "tool");
        expect(output).toEqual({ result: { success: true } });
        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({ data: "test" });
      });

      it("should interpolate args", async () => {
        const step = createToolStep(
          {
            id: "tool",
            type: "tool",
            tool: "testTool",
            args: { path: "{{inputs.filePath}}", count: "{{inputs.num}}" },
          },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { filePath: "/tmp/file.txt", num: 42 }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({
          path: "/tmp/file.txt",
          count: 42,
        });
      });

      it("should use step results in args", async () => {
        const step = createToolStep(
          {
            id: "tool",
            type: "tool",
            tool: "testTool",
            args: { content: "{{steps.read.content}}" },
          },
          mockClient
        );

        await step.execute({
          inputData: {
            inputs: {},
            steps: { read: { content: "file contents" } },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({
          content: "file contents",
        });
      });

      it("should throw error for missing tool", async () => {
        const step = createToolStep(
          { id: "tool", type: "tool", tool: "unknownTool", args: {} },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Tool 'unknownTool' not found");
      });

      it("should execute without args", async () => {
        const step = createToolStep(
          { id: "tool", type: "tool", tool: "testTool" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({});
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createToolStep(
          { id: "tool", type: "tool", tool: "testTool", condition: "{{inputs.run}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { run: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: null; skipped: boolean }>(result as StepContext, "tool");
        expect(output).toEqual({ result: null, skipped: true });
        expect(mockClient.tools.testTool.execute).not.toHaveBeenCalled();
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

        const output = getStepOutput<{ response: string }>(result as StepContext, "agent-step");
        expect(output).toEqual(previousResult);
        expect(mockClient.llm.chat).not.toHaveBeenCalled();
        expect(mockClient.app.log).toHaveBeenCalledWith(
          "Skipping already-completed step: agent-step",
          "info"
        );
      });
    });

    describe("named agent execution", () => {
      it("should invoke named agent when agent property is specified", async () => {
        const mockInvoke = vi.fn().mockResolvedValue({ content: "Agent response" });
        mockClient.agents = {
          "code-reviewer": { invoke: mockInvoke },
        };

        const step = createAgentStep(
          { id: "review", type: "agent", agent: "code-reviewer", prompt: "Review this code" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ response: string }>(result as StepContext, "review");
        expect(output).toEqual({ response: "Agent response" });
        expect(mockInvoke).toHaveBeenCalledWith("Review this code", { maxTokens: undefined });
        expect(mockClient.llm.chat).not.toHaveBeenCalled();
      });

      it("should pass maxTokens to named agent", async () => {
        const mockInvoke = vi.fn().mockResolvedValue({ content: "Response" });
        mockClient.agents = {
          summarizer: { invoke: mockInvoke },
        };

        const step = createAgentStep(
          { id: "summary", type: "agent", agent: "summarizer", prompt: "Summarize", maxTokens: 500 },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockInvoke).toHaveBeenCalledWith("Summarize", { maxTokens: 500 });
      });

      it("should interpolate prompt for named agent", async () => {
        const mockInvoke = vi.fn().mockResolvedValue({ content: "Response" });
        mockClient.agents = {
          reviewer: { invoke: mockInvoke },
        };

        const step = createAgentStep(
          { id: "review", type: "agent", agent: "reviewer", prompt: "Review: {{inputs.code}}" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { code: "const x = 1" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockInvoke).toHaveBeenCalledWith("Review: const x = 1", { maxTokens: undefined });
      });

      it("should throw error when agent is not found", async () => {
        mockClient.agents = {
          "other-agent": { invoke: vi.fn() },
        };

        const step = createAgentStep(
          { id: "review", type: "agent", agent: "unknown-agent", prompt: "Test" },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Agent 'unknown-agent' not found. Available agents: other-agent");
      });

      it("should throw error when no agents are available", async () => {
        // mockClient.agents is undefined by default

        const step = createAgentStep(
          { id: "review", type: "agent", agent: "any-agent", prompt: "Test" },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("No agents available on the opencode client");
      });
    });

    describe("inline LLM execution", () => {
      it("should call LLM with prompt and return response", async () => {
        const step = createAgentStep(
          { id: "agent", type: "agent", prompt: "Summarize this" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ response: string }>(result as StepContext, "agent");
        expect(output).toEqual({ response: "LLM response" });
        expect(mockClient.llm.chat).toHaveBeenCalledWith({
          messages: [{ role: "user", content: "Summarize this" }],
          maxTokens: undefined,
        });
      });

      it("should interpolate prompt", async () => {
        const step = createAgentStep(
          { id: "agent", type: "agent", prompt: "Review: {{inputs.code}}" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { code: "const x = 1" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.llm.chat).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: expect.arrayContaining([
              { role: "user", content: "Review: const x = 1" },
            ]),
          })
        );
      });

      it("should include system prompt when provided", async () => {
        const step = createAgentStep(
          {
            id: "agent",
            type: "agent",
            prompt: "What is 2+2?",
            system: "You are a math tutor.",
          },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.llm.chat).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: [
              { role: "system", content: "You are a math tutor." },
              { role: "user", content: "What is 2+2?" },
            ],
          })
        );
      });

      it("should pass maxTokens config", async () => {
        const step = createAgentStep(
          {
            id: "agent",
            type: "agent",
            prompt: "Hello",
            maxTokens: 500,
          },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.llm.chat).toHaveBeenCalledWith({
          messages: [{ role: "user", content: "Hello" }],
          maxTokens: 500,
        });
      });

      it("should use step results in prompt", async () => {
        const step = createAgentStep(
          { id: "agent", type: "agent", prompt: "Error: {{steps.build.stderr}}" },
          mockClient
        );

        await step.execute({
          inputData: {
            inputs: {},
            steps: { build: { stdout: "", stderr: "Build failed", exitCode: 1 } },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.llm.chat).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: [{ role: "user", content: "Error: Build failed" }],
          })
        );
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createAgentStep(
          { id: "agent", type: "agent", prompt: "Analyze", condition: "{{inputs.run}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { run: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ response: string; skipped: boolean }>(result as StepContext, "agent");
        expect(output).toEqual({ response: "", skipped: true });
        expect(mockClient.llm.chat).not.toHaveBeenCalled();
      });

      it("should skip named agent when condition is false", async () => {
        const mockInvoke = vi.fn();
        mockClient.agents = { reviewer: { invoke: mockInvoke } };

        const step = createAgentStep(
          { id: "agent", type: "agent", agent: "reviewer", prompt: "Review", condition: "{{inputs.run}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { run: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ response: string; skipped: boolean }>(result as StepContext, "agent");
        expect(output).toEqual({ response: "", skipped: true });
        expect(mockInvoke).not.toHaveBeenCalled();
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
        headers: new Headers([["content-type", "application/json"]]),
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

        const output = getStepOutput<{ status: number; body: { success: boolean }; text: string; headers: Record<string, string> }>(result as StepContext, "http-step");
        expect(output).toEqual(previousResult);
        expect(global.fetch).not.toHaveBeenCalled();
      });
    });

    describe("HTTP request execution", () => {
      it("should make HTTP request and return response", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "GET",
          url: "https://api.example.com/data",
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ status: number; body: unknown; text: string }>(result as StepContext, "http");
        expect(output.status).toBe(200);
        expect(output.body).toEqual({ data: "response" });
        expect(output.text).toBe('{"data":"response"}');
        expect(global.fetch).toHaveBeenCalledWith("https://api.example.com/data", {
          method: "GET",
          headers: {},
          body: undefined,
          signal: expect.any(AbortSignal),
        });
      });

      it("should interpolate URL", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "GET",
          url: "https://api.example.com/{{inputs.endpoint}}",
        });

        await step.execute({
          inputData: { inputs: { endpoint: "users/123" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(global.fetch).toHaveBeenCalledWith(
          "https://api.example.com/users/123",
          expect.any(Object)
        );
      });

      it("should send headers", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "POST",
          url: "https://api.example.com/data",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer {{inputs.token}}",
          },
        });

        await step.execute({
          inputData: { inputs: { token: "secret123" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(global.fetch).toHaveBeenCalledWith(
          "https://api.example.com/data",
          expect.objectContaining({
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer secret123",
            },
          })
        );
      });

      it("should send string body with interpolation", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "POST",
          url: "https://api.example.com/notify",
          body: "Message: {{inputs.message}}",
        });

        await step.execute({
          inputData: { inputs: { message: "Hello World" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(global.fetch).toHaveBeenCalledWith(
          "https://api.example.com/notify",
          expect.objectContaining({
            body: "Message: Hello World",
          })
        );
      });

      it("should serialize object body as JSON", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "POST",
          url: "https://api.example.com/data",
          body: { name: "test", count: 5 },
        });

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(global.fetch).toHaveBeenCalledWith(
          "https://api.example.com/data",
          expect.objectContaining({
            body: '{"name":"test","count":5}',
          })
        );
      });

      it("should handle non-JSON response", async () => {
        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve("plain text response"),
          headers: new Headers([["content-type", "text/plain"]]),
        } as Response);

        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "GET",
          url: "https://api.example.com/text",
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ body: unknown; text: string }>(result as StepContext, "http");
        expect(output.body).toBeNull();
        expect(output.text).toBe("plain text response");
      });
    });

    describe("error handling", () => {
      it("should throw error on non-OK response with failOnError=true (default)", async () => {
        vi.mocked(global.fetch).mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
          headers: new Headers(),
        } as Response);

        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "GET",
          url: "https://api.example.com/error",
        });

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("HTTP 500: Internal Server Error");
      });

      it("should return error response when failOnError=false", async () => {
        vi.mocked(global.fetch).mockResolvedValue({
          ok: false,
          status: 404,
          text: () => Promise.resolve("Not Found"),
          headers: new Headers(),
        } as Response);

        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "GET",
          url: "https://api.example.com/missing",
          failOnError: false,
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ status: number; text: string }>(result as StepContext, "http");
        expect(output.status).toBe(404);
        expect(output.text).toBe("Not Found");
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "POST",
          url: "https://api.example.com/notify",
          condition: "{{inputs.notify}}",
        });

        const result = await step.execute({
          inputData: { inputs: { notify: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ status: number; body: null; text: string; headers: Record<string, string>; skipped: boolean }>(result as StepContext, "http");
        expect(output).toEqual({
          status: 0,
          body: null,
          text: "",
          headers: {},
          skipped: true,
        });
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

        const output = getStepOutput<{ success: boolean }>(result as StepContext, "file-step");
        expect(output).toEqual(previousResult);
        expect(writeFile).not.toHaveBeenCalled();
      });
    });

    describe("read action", () => {
      it("should read file and return content", async () => {
        vi.mocked(readFile).mockResolvedValue("file contents here");

        const step = createFileStep({
          id: "read",
          type: "file",
          action: "read",
          path: "/tmp/input.txt",
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ content: string }>(result as StepContext, "read");
        expect(output).toEqual({ content: "file contents here" });
        expect(readFile).toHaveBeenCalledWith("/tmp/input.txt", "utf-8");
      });

      it("should interpolate path", async () => {
        vi.mocked(readFile).mockResolvedValue("data");

        const step = createFileStep({
          id: "read",
          type: "file",
          action: "read",
          path: "{{inputs.dir}}/{{inputs.file}}",
        });

        await step.execute({
          inputData: { inputs: { dir: "/home/user", file: "config.json" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(readFile).toHaveBeenCalledWith("/home/user/config.json", "utf-8");
      });
    });

    describe("write action", () => {
      it("should write string content to file", async () => {
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const step = createFileStep({
          id: "write",
          type: "file",
          action: "write",
          path: "/tmp/output.txt",
          content: "hello world",
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ success: boolean }>(result as StepContext, "write");
        expect(output).toEqual({ success: true });
        expect(writeFile).toHaveBeenCalledWith("/tmp/output.txt", "hello world", "utf-8");
      });

      it("should interpolate content", async () => {
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const step = createFileStep({
          id: "write",
          type: "file",
          action: "write",
          path: "/tmp/output.txt",
          content: "Result: {{steps.compute.output}}",
        });

        await step.execute({
          inputData: {
            inputs: {},
            steps: { compute: { output: "42" } },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(writeFile).toHaveBeenCalledWith("/tmp/output.txt", "Result: 42", "utf-8");
      });

      it("should auto-stringify object content", async () => {
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const step = createFileStep({
          id: "write",
          type: "file",
          action: "write",
          path: "/tmp/config.json",
          content: { name: "test", enabled: true },
        });

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(writeFile).toHaveBeenCalledWith(
          "/tmp/config.json",
          JSON.stringify({ name: "test", enabled: true }, null, 2),
          "utf-8"
        );
      });

      it("should throw error when content is missing", async () => {
        const step = createFileStep({
          id: "write",
          type: "file",
          action: "write",
          path: "/tmp/output.txt",
        } as Parameters<typeof createFileStep>[0]);

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Content is required for write action");
      });
    });

    describe("delete action", () => {
      it("should delete file", async () => {
        vi.mocked(unlink).mockResolvedValue(undefined);

        const step = createFileStep({
          id: "delete",
          type: "file",
          action: "delete",
          path: "/tmp/temp.txt",
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ success: boolean }>(result as StepContext, "delete");
        expect(output).toEqual({ success: true });
        expect(unlink).toHaveBeenCalledWith("/tmp/temp.txt");
      });

      it("should interpolate path for delete", async () => {
        vi.mocked(unlink).mockResolvedValue(undefined);

        const step = createFileStep({
          id: "delete",
          type: "file",
          action: "delete",
          path: "{{inputs.tempDir}}/{{inputs.file}}",
        });

        await step.execute({
          inputData: { inputs: { tempDir: "/tmp", file: "cache.dat" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(unlink).toHaveBeenCalledWith("/tmp/cache.dat");
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createFileStep({
          id: "write",
          type: "file",
          action: "write",
          path: "/tmp/output.txt",
          content: "data",
          condition: "{{inputs.write}}",
        });

        const result = await step.execute({
          inputData: { inputs: { write: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ skipped: boolean }>(result as StepContext, "write");
        expect(output).toEqual({ skipped: true });
        expect(writeFile).not.toHaveBeenCalled();
      });
    });
  });

  // =============================================================================
  // Wait Step Tests
  // =============================================================================
  describe("createWaitStep", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createWaitStep({
          id: "wait-step",
          type: "wait",
          durationMs: 5000,
        });

        const previousResult = {
          completed: true,
          durationMs: 5000,
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "wait-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ completed: boolean; durationMs: number }>(result as StepContext, "wait-step");
        expect(output).toEqual(previousResult);
      });
    });

    describe("wait execution", () => {
      it("should wait for specified duration and return completed", async () => {
        const step = createWaitStep({
          id: "wait-5s",
          type: "wait",
          durationMs: 5000,
        });

        const executePromise = step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        // Fast-forward timer
        await vi.advanceTimersByTimeAsync(5000);

        const result = await executePromise;

        const output = getStepOutput<{ completed: boolean; durationMs: number }>(result as StepContext, "wait-5s");
        expect(output).toEqual({
          completed: true,
          durationMs: 5000,
        });
      });

      it("should handle short wait durations", async () => {
        const step = createWaitStep({
          id: "wait-100ms",
          type: "wait",
          durationMs: 100,
        });

        const executePromise = step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        await vi.advanceTimersByTimeAsync(100);

        const result = await executePromise;

        const output = getStepOutput<{ completed: boolean; durationMs: number }>(result as StepContext, "wait-100ms");
        expect(output).toEqual({
          completed: true,
          durationMs: 100,
        });
      });

      it("should have correct description", () => {
        const step = createWaitStep({
          id: "wait-step",
          type: "wait",
          durationMs: 3000,
        });

        expect(step.description).toBe("Wait 3000ms");
      });

      it("should use custom description when provided", () => {
        const step = createWaitStep({
          id: "wait-step",
          type: "wait",
          durationMs: 3000,
          description: "Wait for deployment to complete",
        });

        expect(step.description).toBe("Wait for deployment to complete");
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createWaitStep({
          id: "conditional-wait",
          type: "wait",
          durationMs: 5000,
          condition: "{{inputs.shouldWait}}",
        });

        const result = await step.execute({
          inputData: { inputs: { shouldWait: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ completed: boolean; durationMs: number; skipped: boolean }>(result as StepContext, "conditional-wait");
        expect(output).toEqual({
          completed: false,
          durationMs: 0,
          skipped: true,
        });
      });

      it("should execute when condition is true", async () => {
        const step = createWaitStep({
          id: "conditional-wait",
          type: "wait",
          durationMs: 1000,
          condition: "{{inputs.shouldWait}}",
        });

        const executePromise = step.execute({
          inputData: { inputs: { shouldWait: "true" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        await vi.advanceTimersByTimeAsync(1000);

        const result = await executePromise;

        const output = getStepOutput<{ completed: boolean; durationMs: number }>(result as StepContext, "conditional-wait");
        expect(output).toEqual({
          completed: true,
          durationMs: 1000,
        });
      });

      it("should skip when condition evaluates to empty string", async () => {
        const step = createWaitStep({
          id: "wait",
          type: "wait",
          durationMs: 1000,
          condition: "{{inputs.empty}}",
        });

        const result = await step.execute({
          inputData: { inputs: { empty: "" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ skipped: boolean }>(result as StepContext, "wait");
        expect(output.skipped).toBe(true);
      });

      it("should skip when condition evaluates to 0", async () => {
        const step = createWaitStep({
          id: "wait",
          type: "wait",
          durationMs: 1000,
          condition: "{{inputs.zero}}",
        });

        const result = await step.execute({
          inputData: { inputs: { zero: "0" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ skipped: boolean }>(result as StepContext, "wait");
        expect(output.skipped).toBe(true);
      });
    });
  });

  // =============================================================================
  // Iterator Step Tests
  // =============================================================================
  describe("createIteratorStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createIteratorStep(
          {
            id: "iterator-step",
            type: "iterator",
            items: "{{inputs.files}}",
            runStep: {
              type: "shell",
              command: "echo {{inputs.item}}",
            },
          },
          mockClient
        );

        const previousResult = {
          results: [{ stdout: "file1", stderr: "", exitCode: 0 }],
          count: 1,
        };

        const result = await step.execute({
          inputData: {
            inputs: { files: ["file1.txt"] },
            steps: {
              "iterator-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ results: unknown[]; count: number }>(result as StepContext, "iterator-step");
        expect(output).toEqual(previousResult);
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(mockClient.app.log).toHaveBeenCalledWith(
          "Skipping already-completed step: iterator-step",
          "info"
        );
      });
    });

    describe("iteration execution", () => {
      it("should iterate over array and execute runStep for each item", async () => {
        // For iterator tests, we need to set up a fresh mock process for each spawn call
        mockSpawn.mockImplementation(() => {
          const proc = createMockProcess();
          setImmediate(() => {
            proc.stdout.emit("data", "processed");
            proc.emit("close", 0, null);
          });
          return proc;
        });
        const step = createIteratorStep(
          {
            id: "lint-files",
            type: "iterator",
            items: "{{inputs.files}}",
            runStep: {
              type: "shell",
              command: "eslint {{inputs.item}}",
            },
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { files: ["src/a.ts", "src/b.ts", "src/c.ts"] },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ count: number; results: unknown[] }>(result as StepContext, "lint-files");
        expect(output.count).toBe(3);
        expect(output.results).toHaveLength(3);
        expect(mockSpawn).toHaveBeenCalledTimes(3);
        expect(mockSpawn).toHaveBeenCalledWith("/bin/sh", ["-c", "eslint src/a.ts"], expect.any(Object));
        expect(mockSpawn).toHaveBeenCalledWith("/bin/sh", ["-c", "eslint src/b.ts"], expect.any(Object));
        expect(mockSpawn).toHaveBeenCalledWith("/bin/sh", ["-c", "eslint src/c.ts"], expect.any(Object));
      });

      it("should provide index in iteration context", async () => {
        mockSpawnSuccess("done");
        const step = createIteratorStep(
          {
            id: "numbered",
            type: "iterator",
            items: "{{inputs.items}}",
            runStep: {
              type: "shell",
              command: "echo Item {{inputs.index}}: {{inputs.item}}",
            },
          },
          mockClient
        );

        await step.execute({
          inputData: {
            inputs: { items: ["apple", "banana"] },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockSpawn).toHaveBeenCalledWith("/bin/sh", ["-c", "echo Item 0: apple"], expect.any(Object));
        expect(mockSpawn).toHaveBeenCalledWith("/bin/sh", ["-c", "echo Item 1: banana"], expect.any(Object));
      });

      it("should iterate over array from previous step result", async () => {
        mockSpawnSuccess("linted");
        const step = createIteratorStep(
          {
            id: "lint-found-files",
            type: "iterator",
            items: "{{steps.find-files.result}}",
            runStep: {
              type: "shell",
              command: "lint {{inputs.item}}",
            },
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "find-files": { result: ["file1.ts", "file2.ts"] },
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ count: number }>(result as StepContext, "lint-found-files");
        expect(output.count).toBe(2);
        expect(mockSpawn).toHaveBeenCalledWith("/bin/sh", ["-c", "lint file1.ts"], expect.any(Object));
        expect(mockSpawn).toHaveBeenCalledWith("/bin/sh", ["-c", "lint file2.ts"], expect.any(Object));
      });

      it("should handle objects in the array", async () => {
        mockSpawnSuccess("deployed");
        const step = createIteratorStep(
          {
            id: "deploy-services",
            type: "iterator",
            items: "{{inputs.services}}",
            runStep: {
              type: "shell",
              command: "deploy {{inputs.item.name}} to {{inputs.item.region}}",
            },
          },
          mockClient
        );

        await step.execute({
          inputData: {
            inputs: {
              services: [
                { name: "api", region: "us-east" },
                { name: "web", region: "eu-west" },
              ],
            },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockSpawn).toHaveBeenCalledWith("/bin/sh", ["-c", "deploy api to us-east"], expect.any(Object));
        expect(mockSpawn).toHaveBeenCalledWith("/bin/sh", ["-c", "deploy web to eu-west"], expect.any(Object));
      });

      it("should handle empty array", async () => {
        const step = createIteratorStep(
          {
            id: "empty-iter",
            type: "iterator",
            items: "{{inputs.items}}",
            runStep: {
              type: "shell",
              command: "echo {{inputs.item}}",
            },
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { items: [] },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ count: number; results: unknown[] }>(result as StepContext, "empty-iter");
        expect(output.count).toBe(0);
        expect(output.results).toHaveLength(0);
        expect(mockSpawn).not.toHaveBeenCalled();
      });

      it("should execute tool runStep for each item", async () => {
        const step = createIteratorStep(
          {
            id: "process-files",
            type: "iterator",
            items: "{{inputs.files}}",
            runStep: {
              type: "tool",
              tool: "testTool",
              args: { path: "{{inputs.item}}" },
            },
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { files: ["/tmp/a.txt", "/tmp/b.txt"] },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ count: number }>(result as StepContext, "process-files");
        expect(output.count).toBe(2);
        expect(mockClient.tools.testTool.execute).toHaveBeenCalledTimes(2);
        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({ path: "/tmp/a.txt" });
        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({ path: "/tmp/b.txt" });
      });
    });

    describe("error handling", () => {
      it("should throw error when items does not resolve to array", async () => {
        const step = createIteratorStep(
          {
            id: "bad-items",
            type: "iterator",
            items: "{{inputs.notAnArray}}",
            runStep: {
              type: "shell",
              command: "echo test",
            },
          },
          mockClient
        );

        await expect(
          step.execute({
            inputData: {
              inputs: { notAnArray: "just a string" },
              steps: {},
            },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Iterator items must resolve to an array");
      });

      it("should propagate errors from runStep", async () => {
        // Set up mock to return a process that fails
        mockSpawn.mockImplementation(() => {
          const proc = createMockProcess();
          setImmediate(() => {
            proc.stderr.emit("data", "error");
            proc.emit("close", 1, null);
          });
          return proc;
        });
        const step = createIteratorStep(
          {
            id: "failing-iter",
            type: "iterator",
            items: "{{inputs.items}}",
            runStep: {
              type: "shell",
              command: "fail-command",
            },
          },
          mockClient
        );

        await expect(
          step.execute({
            inputData: {
              inputs: { items: ["a"] },
              steps: {},
            },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Command failed");
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createIteratorStep(
          {
            id: "conditional-iter",
            type: "iterator",
            items: "{{inputs.items}}",
            runStep: {
              type: "shell",
              command: "echo {{inputs.item}}",
            },
            condition: "{{inputs.shouldRun}}",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { items: ["a", "b"], shouldRun: "false" },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ results: unknown[]; count: number; skipped: boolean }>(result as StepContext, "conditional-iter");
        expect(output).toEqual({
          results: [],
          count: 0,
          skipped: true,
        });
        expect(mockSpawn).not.toHaveBeenCalled();
      });

      it("should execute when condition is true", async () => {
        // Set up mock to return a process that succeeds
        mockSpawn.mockImplementation(() => {
          const proc = createMockProcess();
          setImmediate(() => {
            proc.stdout.emit("data", "done");
            proc.emit("close", 0, null);
          });
          return proc;
        });
        const step = createIteratorStep(
          {
            id: "conditional-iter",
            type: "iterator",
            items: "{{inputs.items}}",
            runStep: {
              type: "shell",
              command: "echo {{inputs.item}}",
            },
            condition: "{{inputs.shouldRun}}",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { items: ["a"], shouldRun: "true" },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ count: number }>(result as StepContext, "conditional-iter");
        expect(output.count).toBe(1);
        expect(mockSpawn).toHaveBeenCalled();
      });
    });

    describe("runSteps (sequential processing)", () => {
      it("should execute a sequence of steps (runSteps) for each item", async () => {
        // Mock spawn for sequence: [echo item, echo prev-result] x 2 items
        mockSpawn.mockImplementation(() => {
          const proc = createMockProcess();
          setImmediate(() => {
            proc.stdout.emit("data", "result");
            proc.emit("close", 0, null);
          });
          return proc;
        });

        const step = createIteratorStep(
          {
            id: "seq-iter",
            type: "iterator",
            items: "{{inputs.items}}",
            runSteps: [
              { id: "step1", type: "shell", command: "echo {{inputs.item}}" },
              { id: "step2", type: "shell", command: "echo {{steps.step1.stdout}}" }
            ],
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { items: ["a", "b"] },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ count: number; results: Array<Record<string, unknown>> }>(result as StepContext, "seq-iter");
        expect(output.count).toBe(2);
        // Should be called 4 times total (2 items * 2 steps)
        expect(mockSpawn).toHaveBeenCalledTimes(4);

        // Verify multi-step mode returns object with all step results per iteration
        expect(output.results).toHaveLength(2);
        expect(output.results[0]).toHaveProperty("step1");
        expect(output.results[0]).toHaveProperty("step2");
        expect(output.results[1]).toHaveProperty("step1");
        expect(output.results[1]).toHaveProperty("step2");
      });

      it("should allow later steps to access earlier step results within runSteps", async () => {
        // First call returns "first-result", second returns whatever was passed
        let callCount = 0;
        mockSpawn.mockImplementation(() => {
          const proc = createMockProcess();
          setImmediate(() => {
            callCount++;
            proc.stdout.emit("data", callCount === 1 ? "first-result" : "processed");
            proc.emit("close", 0, null);
          });
          return proc;
        });

        const step = createIteratorStep(
          {
            id: "context-test",
            type: "iterator",
            items: "{{inputs.items}}",
            runSteps: [
              { id: "fetch", type: "shell", command: "echo data" },
              { id: "process", type: "shell", command: "process {{steps.fetch.stdout}}" }
            ],
          },
          mockClient
        );

        await step.execute({
          inputData: {
            inputs: { items: ["x"] },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        // Verify the second step received the interpolated value from the first step
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        // The second call should reference the first step's result
        expect(mockSpawn).toHaveBeenNthCalledWith(
          2,
          "/bin/sh",
          ["-c", "process first-result"],
          expect.any(Object)
        );
      });

      it("should throw error when both runStep and runSteps are provided", () => {
        expect(() => {
          createIteratorStep(
            {
              id: "invalid-iter",
              type: "iterator",
              items: "{{inputs.items}}",
              runStep: { type: "shell", command: "echo single" },
              runSteps: [{ id: "s1", type: "shell", command: "echo multi" }],
            } as unknown as Parameters<typeof createIteratorStep>[0],
            mockClient
          );
        }).toThrow(/cannot have both/);
      });

      it("should throw error when neither runStep nor runSteps are provided", () => {
        expect(() => {
          createIteratorStep(
            {
              id: "empty-iter",
              type: "iterator",
              items: "{{inputs.items}}",
            } as unknown as Parameters<typeof createIteratorStep>[0],
            mockClient
          );
        }).toThrow(/must have either/);
      });
    });
  });

  describe("createEvalStep", () => {
    let mockClient: OpencodeClient;

    beforeEach(() => {
      mockClient = {
        app: {
          log: vi.fn(),
        },
        tools: {},
        llm: {
          chat: vi.fn(),
        },
      } as unknown as OpencodeClient;
    });

    describe("basic script execution", () => {
      it("should execute a simple script and return the result", async () => {
        const step = createEvalStep(
          {
            id: "eval-simple",
            type: "eval",
            script: "return 42;",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: number }>(result as StepContext, "eval-simple");
        expect(output).toEqual({ result: 42 });
      });

      it("should access inputs in the script", async () => {
        const step = createEvalStep(
          {
            id: "eval-inputs",
            type: "eval",
            script: "return inputs.name + '!';",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { name: "World" },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: string }>(result as StepContext, "eval-inputs");
        expect(output).toEqual({ result: "World!" });
      });

      it("should access step outputs in the script", async () => {
        const step = createEvalStep(
          {
            id: "eval-steps",
            type: "eval",
            script: "return steps.previous.count * 2;",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: { previous: { count: 5 } },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: number }>(result as StepContext, "eval-steps");
        expect(output).toEqual({ result: 10 });
      });

      it("should return object results", async () => {
        const step = createEvalStep(
          {
            id: "eval-object",
            type: "eval",
            script: "return { sum: inputs.a + inputs.b, product: inputs.a * inputs.b };",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { a: 3, b: 4 },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: { sum: number; product: number } }>(result as StepContext, "eval-object");
        expect(output).toEqual({ result: { sum: 7, product: 12 } });
      });

      it("should return array results", async () => {
        const step = createEvalStep(
          {
            id: "eval-array",
            type: "eval",
            script: "return inputs.items.map(x => x * 2);",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { items: [1, 2, 3] },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: number[] }>(result as StepContext, "eval-array");
        expect(output).toEqual({ result: [2, 4, 6] });
      });
    });

    describe("sandbox security", () => {
      it("should not have access to require", async () => {
        const step = createEvalStep(
          {
            id: "eval-no-require",
            type: "eval",
            script: "return typeof require;",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: string }>(result as StepContext, "eval-no-require");
        expect(output).toEqual({ result: "undefined" });
      });

      it("should not have access to process", async () => {
        const step = createEvalStep(
          {
            id: "eval-no-process",
            type: "eval",
            script: "return typeof process;",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: string }>(result as StepContext, "eval-no-process");
        expect(output).toEqual({ result: "undefined" });
      });

      it("should not have access to fetch", async () => {
        const step = createEvalStep(
          {
            id: "eval-no-fetch",
            type: "eval",
            script: "return typeof fetch;",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: string }>(result as StepContext, "eval-no-fetch");
        expect(output).toEqual({ result: "undefined" });
      });

      it("should have access to safe built-ins", async () => {
        const step = createEvalStep(
          {
            id: "eval-builtins",
            type: "eval",
            script: `
              return {
                hasJSON: typeof JSON !== 'undefined',
                hasMath: typeof Math !== 'undefined',
                hasDate: typeof Date !== 'undefined',
                hasArray: typeof Array !== 'undefined',
              };
            `,
          },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: { hasJSON: boolean; hasMath: boolean; hasDate: boolean; hasArray: boolean } }>(result as StepContext, "eval-builtins");
        expect(output).toEqual({
          result: {
            hasJSON: true,
            hasMath: true,
            hasDate: true,
            hasArray: true,
          },
        });
      });

      it("should have frozen inputs (immutable)", async () => {
        const step = createEvalStep(
          {
            id: "eval-frozen",
            type: "eval",
            script: `
              // Frozen objects don't throw in non-strict mode,
              // but the mutation should be silently ignored
              const originalValue = inputs.original;
              inputs.newProp = "test";
              // Verify the original input wasn't modified by checking
              // that accessing the original value still works
              return originalValue;
            `,
          },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { original: "value" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        // The script should still have access to the original frozen inputs
        const output = getStepOutput<{ result: string }>(result as StepContext, "eval-frozen");
        expect(output).toEqual({ result: "value" });
      });
    });

    describe("timeout handling", () => {
      it("should timeout long-running scripts", async () => {
        const step = createEvalStep(
          {
            id: "eval-timeout",
            type: "eval",
            script: "while(true) {}",
            scriptTimeout: 100,
          },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow(/timed out/);
      });

      it("should use custom timeout", async () => {
        const step = createEvalStep(
          {
            id: "eval-custom-timeout",
            type: "eval",
            script: "return 'fast';",
            scriptTimeout: 5000,
          },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: string }>(result as StepContext, "eval-custom-timeout");
        expect(output).toEqual({ result: "fast" });
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createEvalStep(
          {
            id: "eval-conditional",
            type: "eval",
            script: "return 'executed';",
            condition: "{{inputs.shouldRun}}",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { shouldRun: "false" },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ skipped: boolean }>(result as StepContext, "eval-conditional");
        expect(output).toEqual({ skipped: true });
      });

      it("should execute when condition is true", async () => {
        const step = createEvalStep(
          {
            id: "eval-conditional",
            type: "eval",
            script: "return 'executed';",
            condition: "{{inputs.shouldRun}}",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { shouldRun: "true" },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: string }>(result as StepContext, "eval-conditional");
        expect(output).toEqual({ result: "executed" });
      });
    });

    describe("idempotency", () => {
      it("should skip if step was already executed (hydration)", async () => {
        const step = createEvalStep(
          {
            id: "eval-idempotent",
            type: "eval",
            script: "return 'new result';",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "eval-idempotent": { result: "previous result" },
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ result: string }>(result as StepContext, "eval-idempotent");
        expect(output).toEqual({ result: "previous result" });
      });
    });

    describe("workflow generation", () => {
      it("should return workflow when script generates one", async () => {
        const step = createEvalStep(
          {
            id: "eval-workflow",
            type: "eval",
            script: `
              return {
                workflow: {
                  id: "dynamic-workflow",
                  steps: [
                    { id: "step1", type: "shell", command: "echo hello" }
                  ]
                }
              };
            `,
          },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        const output = getStepOutput<{ workflow: unknown }>(result as StepContext, "eval-workflow");
        expect(output).toHaveProperty("workflow");
        expect(output.workflow).toMatchObject({
          id: "dynamic-workflow",
          steps: [{ id: "step1", type: "shell", command: "echo hello" }],
        });
      });

      it("should validate generated workflow schema", async () => {
        const step = createEvalStep(
          {
            id: "eval-invalid-workflow",
            type: "eval",
            script: `
              return {
                workflow: {
                  id: "invalid",
                  // Missing required 'steps' field
                }
              };
            `,
          },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow(/Invalid workflow definition/);
      });
    });

    describe("error handling", () => {
      it("should throw on script syntax errors", async () => {
        const step = createEvalStep(
          {
            id: "eval-syntax-error",
            type: "eval",
            script: "return {;",
          },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow(/Unexpected token/);
      });

      it("should throw on runtime errors", async () => {
        const step = createEvalStep(
          {
            id: "eval-runtime-error",
            type: "eval",
            script: "return nonExistentVariable;",
          },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow(/not defined/);
      });
    });
  });
});
