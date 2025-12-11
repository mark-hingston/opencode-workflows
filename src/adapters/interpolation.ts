/**
 * Template interpolation engine for workflow definitions.
 * 
 * Supports {{expression}} syntax where expression can be:
 * - inputs.paramName - Access workflow input parameters
 * - steps.stepId.output - Access output from a previous step
 * - steps.stepId.stdout - Access stdout from a shell step
 * - steps.stepId.response - Access response from an agent step
 * - steps.stepId.result - Access result from a tool step
 * - env.VAR_NAME - Access environment variables
 * - run.id - Access the current run ID
 * - run.workflowId - Access the workflow ID
 * - run.startedAt - Access the run start timestamp
 */

import type { JsonValue } from "../types.js";

/**
 * Run metadata available in interpolation context
 */
export interface RunContext {
  /** Unique run identifier */
  id: string;
  /** Workflow definition ID */
  workflowId: string;
  /** ISO timestamp when run started */
  startedAt: string;
}

export interface InterpolationContext {
  inputs: Record<string, JsonValue>;
  steps: Record<string, JsonValue>;
  env?: NodeJS.ProcessEnv;
  /** Run metadata (optional for backwards compatibility) */
  run?: RunContext;
}

/**
 * Get a nested value from an object using dot notation
 */
export function getNestedValue(obj: JsonValue, path: string): JsonValue | undefined {
  const parts = path.split(".");
  let current: JsonValue | undefined = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

/**
 * Interpolate {{expression}} placeholders in a string
 */
export function interpolate(template: string, ctx: InterpolationContext): string {
  // Match {{expression}} patterns
  const pattern = /\{\{([^}]+)\}\}/g;

  return template.replace(pattern, (match, expression: string) => {
    const trimmed = expression.trim();

    // Parse the expression
    if (trimmed.startsWith("inputs.")) {
      const path = trimmed.slice("inputs.".length);
      const value = getNestedValue(ctx.inputs, path);
      return formatValue(value);
    }

    if (trimmed.startsWith("steps.")) {
      const path = trimmed.slice("steps.".length);
      const value = getNestedValue(ctx.steps, path);
      return formatValue(value);
    }

    if (trimmed.startsWith("env.")) {
      const key = trimmed.slice("env.".length);
      // Use ctx.env if provided, otherwise fall back to process.env
      const value = ctx.env ? ctx.env[key] : process.env[key];
      return formatValue(value);
    }

    if (trimmed.startsWith("run.")) {
      const key = trimmed.slice("run.".length);
      if (ctx.run) {
        const value = ctx.run[key as keyof RunContext];
        return formatValue(value);
      }
      return "";
    }

    // Unknown expression, return as-is
    console.warn(`Unknown interpolation expression: ${trimmed}`);
    return match;
  });
}

/**
 * Format a value for string interpolation
 */
function formatValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

/**
 * Check if a string contains interpolation expressions
 */
export function hasInterpolation(str: string): boolean {
  return /\{\{[^}]+\}\}/.test(str);
}

/**
 * Extract all variable references from a template
 */
export function extractVariables(template: string): string[] {
  const pattern = /\{\{([^}]+)\}\}/g;
  const variables: string[] = [];
  let match: RegExpExecArray | null;

  match = pattern.exec(template);
  while (match !== null) {
    variables.push(match[1].trim());
    match = pattern.exec(template);
  }

  return variables;
}

/**
 * Validate that all referenced variables exist in context
 */
export function validateInterpolation(
  template: string,
  ctx: InterpolationContext
): { valid: boolean; missing: string[] } {
  const variables = extractVariables(template);
  const missing: string[] = [];

  for (const variable of variables) {
    if (variable.startsWith("inputs.")) {
      const path = variable.slice("inputs.".length);
      if (getNestedValue(ctx.inputs, path) === undefined) {
        missing.push(variable);
      }
    } else if (variable.startsWith("steps.")) {
      const path = variable.slice("steps.".length);
      if (getNestedValue(ctx.steps, path) === undefined) {
        missing.push(variable);
      }
    } else if (variable.startsWith("env.")) {
      const key = variable.slice("env.".length);
      const value = ctx.env ? ctx.env[key] : process.env[key];
      if (value === undefined) {
        missing.push(variable);
      }
    } else if (variable.startsWith("run.")) {
      const key = variable.slice("run.".length);
      if (!ctx.run || !(key in ctx.run)) {
        missing.push(variable);
      }
    } else {
      missing.push(variable);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Interpolates a string, but if the result is a clean match for a single variable,
 * returns the variable's original type instead of a string.
 * 
 * This preserves types for cases like:
 * - "{{inputs.count}}" with count=5 returns 5 (number), not "5" (string)
 * - "Hello {{inputs.name}}" returns "Hello John" (string interpolation)
 */
export function interpolateValue(template: string, ctx: InterpolationContext): JsonValue {
  const trimmed = template.trim();
  
  // Check if the template is EXACTLY a single variable reference (e.g. "{{inputs.count}}")
  const exactMatch = /^\{\{([^}]+)\}\}$/.exec(trimmed);
  if (exactMatch) {
    const expression = exactMatch[1].trim();
    
    if (expression.startsWith("inputs.")) {
      const path = expression.slice("inputs.".length);
      const value = getNestedValue(ctx.inputs, path);
      return value !== undefined ? value : null;
    }
    
    if (expression.startsWith("steps.")) {
      const path = expression.slice("steps.".length);
      const value = getNestedValue(ctx.steps, path);
      return value !== undefined ? value : null;
    }
    
    if (expression.startsWith("env.")) {
      const key = expression.slice("env.".length);
      const value = ctx.env ? ctx.env[key] : process.env[key];
      return value !== undefined ? value : null;
    }
    
    if (expression.startsWith("run.")) {
      const key = expression.slice("run.".length);
      if (ctx.run) {
        const value = ctx.run[key as keyof RunContext];
        return value !== undefined ? value : null;
      }
      return null;
    }
  }

  // Otherwise, perform string interpolation (returns string)
  return interpolate(template, ctx);
}
