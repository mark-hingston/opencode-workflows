import { z } from "zod";
import type { WorkflowDefinition, WorkflowRun, InputValue, JsonValue, RunContext } from "../types.js";
import { JsonValueSchema } from "../types.js";
import type { WorkflowRunner } from "../commands/runner.js";
import { generateMermaidGraph } from "../commands/handler.js";

/**
 * Schema for workflow input parameters
 */
const InputValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Schema for the workflow tool
 */
export const WorkflowToolSchema = z.object({
  mode: z
    .enum(["list", "show", "run", "status", "resume", "cancel", "runs", "graph"])
    .describe("The operation to perform"),
  workflowId: z
    .string()
    .optional()
    .describe("Workflow ID (required for show, run, graph)"),
  runId: z
    .string()
    .optional()
    .describe("Run ID (required for status, resume, cancel)"),
  params: z
    .record(InputValueSchema)
    .optional()
    .describe("Input parameters for workflow execution"),
  resumeData: JsonValueSchema
    .optional()
    .describe("Data to pass when resuming a suspended workflow"),
});

export type WorkflowToolInput = z.infer<typeof WorkflowToolSchema>;

/**
 * Result from workflow tool execution
 */
export interface WorkflowToolResult {
  success: boolean;
  message: string;
  workflows?: WorkflowDefinition[];
  workflow?: WorkflowDefinition;
  runs?: WorkflowRun[];
  run?: WorkflowRun;
  runId?: string;
  graph?: string;
}

/**
 * Workflow tool executor
 */
export async function executeWorkflowTool(
  input: WorkflowToolInput,
  definitions: Map<string, WorkflowDefinition>,
  runner: WorkflowRunner,
  context?: RunContext
): Promise<WorkflowToolResult> {
  switch (input.mode) {
    case "list": {
      const workflows = Array.from(definitions.values());
      return {
        success: true,
        message: `Found ${workflows.length} workflow(s)`,
        workflows,
      };
    }

    case "show": {
      if (!input.workflowId) {
        return {
          success: false,
          message: "workflowId is required for 'show' mode",
        };
      }

      const workflow = definitions.get(input.workflowId);
      if (!workflow) {
        return {
          success: false,
          message: `Workflow not found: ${input.workflowId}`,
        };
      }

      return {
        success: true,
        message: `Workflow: ${workflow.id}`,
        workflow,
      };
    }

    case "run": {
      if (!input.workflowId) {
        return {
          success: false,
          message: "workflowId is required for 'run' mode",
        };
      }

      if (!definitions.has(input.workflowId)) {
        return {
          success: false,
          message: `Workflow not found: ${input.workflowId}`,
        };
      }

      try {
        const runId = await runner.run(
          input.workflowId,
          input.params || {},
          context
        );
        return {
          success: true,
          message: `Started workflow ${input.workflowId}`,
          runId,
        };
      } catch (error) {
        return {
          success: false,
          message: `Failed to start workflow: ${error}`,
        };
      }
    }

    case "graph": {
      if (!input.workflowId) {
        return {
          success: false,
          message: "workflowId is required for 'graph' mode",
        };
      }

      const workflow = definitions.get(input.workflowId);
      if (!workflow) {
        return {
          success: false,
          message: `Workflow not found: ${input.workflowId}`,
        };
      }

      const graph = generateMermaidGraph(workflow);
      return {
        success: true,
        message: graph,
        workflow,
        graph,
      };
    }

    case "status": {
      if (!input.runId) {
        return {
          success: false,
          message: "runId is required for 'status' mode",
        };
      }

      const run = runner.getStatus(input.runId);
      if (!run) {
        return {
          success: false,
          message: `Run not found: ${input.runId}`,
        };
      }

      return {
        success: true,
        message: `Run ${run.runId} status: ${run.status}`,
        run,
      };
    }

    case "resume": {
      if (!input.runId) {
        return {
          success: false,
          message: "runId is required for 'resume' mode",
        };
      }

      try {
        await runner.resume(input.runId, input.resumeData, context);
        const run = runner.getStatus(input.runId);
        return {
          success: true,
          message: `Resumed workflow run: ${input.runId}`,
          run,
        };
      } catch (error) {
        return {
          success: false,
          message: `Failed to resume: ${error}`,
        };
      }
    }

    case "cancel": {
      if (!input.runId) {
        return {
          success: false,
          message: "runId is required for 'cancel' mode",
        };
      }

      try {
        await runner.cancel(input.runId);
        return {
          success: true,
          message: `Cancelled workflow run: ${input.runId}`,
        };
      } catch (error) {
        return {
          success: false,
          message: `Failed to cancel: ${error}`,
        };
      }
    }

    case "runs": {
      const runs = runner.listRuns(input.workflowId);
      return {
        success: true,
        message: `Found ${runs.length} run(s)`,
        runs,
      };
    }

    default:
      return {
        success: false,
        message: `Unknown mode: ${input.mode}`,
      };
  }
}

/**
 * Get the tool definition for registration
 */
export function getWorkflowToolDefinition() {
  return {
    name: "workflow",
    description: `Execute and manage workflow automation. Use this tool to trigger deterministic multi-step processes.

Modes:
- list: List all available workflows
- show: Get details of a specific workflow (requires workflowId)
- graph: Generate a Mermaid DAG for a workflow (requires workflowId)
- run: Execute a workflow (requires workflowId, optional params)
- status: Check the status of a workflow run (requires runId)
- resume: Resume a suspended workflow (requires runId, optional resumeData)
- cancel: Cancel a running workflow (requires runId)
- runs: List recent workflow runs (optional workflowId filter)`,
    args: WorkflowToolSchema,
  };
}
