import { MissingInputsError } from "../types.js";
import type { WorkflowDefinition, WorkflowRun, Logger, JsonValue, InputValue } from "../types.js";
import type { WorkflowFactory } from "../factory/index.js";
import type { WorkflowRunner } from "./runner.js";

/**
 * Workflow command handler for the /workflow slash command
 */
export interface WorkflowCommandContext {
  factory: WorkflowFactory;
  runner: WorkflowRunner;
  definitions: Map<string, WorkflowDefinition>;
  log: Logger;
}

/**
 * Result data types from workflow commands
 */
export type WorkflowCommandData = 
  | WorkflowDefinition 
  | WorkflowDefinition[] 
  | WorkflowRun 
  | WorkflowRun[] 
  | string[]
  | { runId: string; workflowId: string; params: Record<string, InputValue> }
  | { runId: string; resumeData?: JsonValue }
  | { runId: string }
  | null;

export interface WorkflowCommandResult {
  success: boolean;
  message: string;
  data?: WorkflowCommandData;
}

/**
 * Parse command arguments
 */
function parseArgs(args: string): { command: string; rest: string[] } {
  const parts = args.trim().split(/\s+/);
  return {
    command: parts[0] || "help",
    rest: parts.slice(1),
  };
}

/**
 * Helper to parse string values into primitives.
 * Automatically infers boolean and number types from string input.
 * 
 * Examples:
 *   "true" -> true
 *   "false" -> false
 *   "42" -> 42
 *   "3.14" -> 3.14
 *   "hello" -> "hello"
 */
function parsePrimitive(value: string): InputValue {
  // Check for boolean values (case-insensitive)
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  
  // Check if it's a number (and not an empty string)
  const trimmed = value.trim();
  if (trimmed !== "") {
    const num = Number(trimmed);
    if (!Number.isNaN(num)) {
      return num;
    }
  }
  
  return value;
}

/**
 * Format workflow list for display
 */
function formatWorkflowList(definitions: Map<string, WorkflowDefinition>): string {
  if (definitions.size === 0) {
    return "No workflows found. Add workflow definitions to `.opencode/workflows/`";
  }

  const lines = ["## Available Workflows\n"];

  for (const [id, def] of definitions) {
    const desc = def.description ? ` - ${def.description}` : "";
    const tags = def.tags?.length ? ` [${def.tags.join(", ")}]` : "";
    lines.push(`- **${id}**${desc}${tags}`);
  }

  return lines.join("\n");
}

/**
 * Format workflow details for display
 */
function formatWorkflowDetails(def: WorkflowDefinition): string {
  const lines = [`## Workflow: ${def.id}\n`];

  if (def.description) {
    lines.push(`${def.description}\n`);
  }

  if (def.inputs && Object.keys(def.inputs).length > 0) {
    lines.push("### Inputs");
    for (const [name, type] of Object.entries(def.inputs)) {
      lines.push(`- **${name}**: ${typeof type === "string" ? type : "schema"}`);
    }
    lines.push("");
  }

  lines.push("### Steps");
  for (const step of def.steps) {
    const deps = step.after?.length ? ` (after: ${step.after.join(", ")})` : "";
    lines.push(`- **${step.id}** [${step.type}]${deps}`);
    if (step.description) {
      lines.push(`  ${step.description}`);
    }
  }

  return lines.join("\n");
}

/**
 * Generate a Mermaid diagram representing the workflow DAG
 */
function generateMermaidGraph(def: WorkflowDefinition): string {
  const lines = ["graph TD"];

  // Add nodes with appropriate shapes based on step type
  for (const step of def.steps) {
    let nodeShape: string;
    switch (step.type) {
      case "suspend":
        // Stadium shape (rounded) for suspend steps
        nodeShape = `([${step.id} (${step.type})])`;
        break;
      case "agent":
        // Hexagon shape for agent steps
        nodeShape = `{{${step.id} (${step.type})}}`;
        break;
      default:
        // Rectangle for shell, tool, http, file steps
        nodeShape = `["${step.id} (${step.type})"]`;
    }
    lines.push(`  ${step.id}${nodeShape}`);
  }

  // Add edges based on dependencies
  for (const step of def.steps) {
    if (step.after && step.after.length > 0) {
      for (const dep of step.after) {
        lines.push(`  ${dep} --> ${step.id}`);
      }
    }
  }

  return `\`\`\`mermaid\n${lines.join("\n")}\n\`\`\``;
}

/**
 * Format run status for display
 */
function formatRunStatus(run: WorkflowRun): string {
  const lines = [`## Workflow Run: ${run.runId}\n`];
  lines.push(`- **Workflow**: ${run.workflowId}`);
  lines.push(`- **Status**: ${run.status}`);
  lines.push(`- **Started**: ${run.startedAt.toISOString()}`);

  if (run.completedAt) {
    lines.push(`- **Completed**: ${run.completedAt.toISOString()}`);
  }

  if (run.currentStepId) {
    lines.push(`- **Current Step**: ${run.currentStepId}`);
  }

  if (run.error) {
    lines.push(`\n**Error**: ${run.error}`);
  }

  lines.push("\n### Step Results");
  for (const [stepId, result] of Object.entries(run.stepResults)) {
    const duration = result.duration ? ` (${result.duration}ms)` : "";
    lines.push(`- **${stepId}**: ${result.status}${duration}`);
    if (result.error) {
      lines.push(`  Error: ${result.error}`);
    }
    // Display step output (if available and not too large)
    if (result.output) {
      try {
        const outputStr = JSON.stringify(result.output, null, 2);
        // Limit output display to avoid overwhelming the UI
        const maxLength = 500;
        if (outputStr.length > maxLength) {
          lines.push(`  Output: ${outputStr.slice(0, maxLength)}... (truncated)`);
        } else {
          lines.push(`  Output: \`\`\`json\n${outputStr}\n  \`\`\``);
        }
      } catch {
        lines.push(`  Output: ${String(result.output)}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Handle the /workflow command
 */
export async function handleWorkflowCommand(
  input: string,
  ctx: WorkflowCommandContext
): Promise<WorkflowCommandResult> {
  const { command, rest } = parseArgs(input);

  switch (command.toLowerCase()) {
    case "list":
    case "ls":
      return {
        success: true,
        message: formatWorkflowList(ctx.definitions),
        data: Array.from(ctx.definitions.keys()),
      };

    case "show":
    case "info": {
      const workflowId = rest[0];
      if (!workflowId) {
        return {
          success: false,
          message: "Usage: /workflow show <workflow-id>",
        };
      }

      const def = ctx.definitions.get(workflowId);
      if (!def) {
        return {
          success: false,
          message: `Workflow not found: ${workflowId}`,
        };
      }

      return {
        success: true,
        message: formatWorkflowDetails(def),
        data: def,
      };
    }

    case "run": {
      const workflowId = rest[0];
      if (!workflowId) {
        return {
          success: false,
          message: "Usage: /workflow run <workflow-id> [param=value ...]",
        };
      }

      const def = ctx.definitions.get(workflowId);
      if (!def) {
        return {
          success: false,
          message: `Workflow not found: ${workflowId}`,
        };
      }

      // Parse parameters with type inference
      const params: Record<string, InputValue> = {};
      for (const arg of rest.slice(1)) {
        const [key, ...valueParts] = arg.split("=");
        if (key && valueParts.length > 0) {
          const rawValue = valueParts.join("=");
          params[key] = parsePrimitive(rawValue);
        }
      }

      try {
        const runId = await ctx.runner.run(workflowId, params);
        return {
          success: true,
          message: `Started workflow **${workflowId}** with run ID: \`${runId}\``,
          data: { runId, workflowId, params },
        };
      } catch (error) {
        // Handle missing inputs with a helpful message
        if (error instanceof MissingInputsError) {
          const inputList = error.missingInputs
            .map(name => `- **${name}** (${error.inputSchema[name]})`)
            .join("\n");
          return {
            success: false,
            message: `Missing required input(s) for workflow **${workflowId}**:\n\n${inputList}\n\nUsage: \`/workflow run ${workflowId} ${error.missingInputs.map(n => `${n}=<value>`).join(" ")}\``,
          };
        }
        return {
          success: false,
          message: `Failed to start workflow: ${error}`,
        };
      }
    }

    case "status": {
      const runId = rest[0];
      if (!runId) {
        return {
          success: false,
          message: "Usage: /workflow status <run-id>",
        };
      }

      const run = ctx.runner.getStatus(runId);
      if (!run) {
        return {
          success: false,
          message: `Run not found: ${runId}`,
        };
      }

      return {
        success: true,
        message: formatRunStatus(run),
        data: run,
      };
    }

    case "resume": {
      const runId = rest[0];
      if (!runId) {
        return {
          success: false,
          message: "Usage: /workflow resume <run-id> [data]",
        };
      }

      // Parse resume data as JSON if provided
      let resumeData: JsonValue | undefined;
      if (rest.length > 1) {
        try {
          resumeData = JSON.parse(rest.slice(1).join(" ")) as JsonValue;
        } catch {
          // Treat as plain string
          resumeData = rest.slice(1).join(" ");
        }
      }

      try {
        await ctx.runner.resume(runId, resumeData);
        return {
          success: true,
          message: `Resumed workflow run: \`${runId}\``,
          data: { runId, resumeData },
        };
      } catch (error) {
        return {
          success: false,
          message: `Failed to resume workflow: ${error}`,
        };
      }
    }

    case "cancel": {
      const runId = rest[0];
      if (!runId) {
        return {
          success: false,
          message: "Usage: /workflow cancel <run-id>",
        };
      }

      try {
        await ctx.runner.cancel(runId);
        return {
          success: true,
          message: `Cancelled workflow run: \`${runId}\``,
          data: { runId },
        };
      } catch (error) {
        return {
          success: false,
          message: `Failed to cancel workflow: ${error}`,
        };
      }
    }

    case "graph": {
      const workflowId = rest[0];
      if (!workflowId) {
        return {
          success: false,
          message: "Usage: /workflow graph <workflow-id>",
        };
      }

      const def = ctx.definitions.get(workflowId);
      if (!def) {
        return {
          success: false,
          message: `Workflow not found: ${workflowId}`,
        };
      }

      return {
        success: true,
        message: generateMermaidGraph(def),
        data: def,
      };
    }

    case "runs": {
      const workflowId = rest[0];
      const runs = ctx.runner.listRuns(workflowId);

      if (runs.length === 0) {
        return {
          success: true,
          message: workflowId
            ? `No runs found for workflow: ${workflowId}`
            : "No workflow runs found",
        };
      }

      const lines = ["## Recent Workflow Runs\n"];
      for (const run of runs.slice(0, 20)) {
        lines.push(
          `- \`${run.runId}\` **${run.workflowId}** - ${run.status} (${run.startedAt.toISOString()})`
        );
      }

      return {
        success: true,
        message: lines.join("\n"),
        data: runs,
      };
    }

    case "help":
      return {
        success: true,
        message: `## Workflow Commands

- \`/workflow list\` - List available workflows
- \`/workflow show <id>\` - Show workflow details
- \`/workflow graph <id>\` - Show workflow DAG as Mermaid diagram
- \`/workflow run <id> [param=value ...]\` - Run a workflow
- \`/workflow status <runId>\` - Check run status
- \`/workflow resume <runId> [data]\` - Resume a suspended workflow
- \`/workflow cancel <runId>\` - Cancel a running workflow
- \`/workflow runs [workflowId]\` - List recent runs`,
      };

    default:
      return {
        success: false,
        message: `Unknown command: ${command}. Use \`/workflow help\` for available commands.`,
      };
  }
}
