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

// =============================================================================
// Constants
// =============================================================================

/** Pattern for matching interpolation expressions */
const INTERPOLATION_PATTERN = /\{\{([^}]+)\}\}/g;

/** Keys that could enable prototype pollution attacks */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Prefixes for different expression types */
const EXPR_PREFIX = {
  INPUTS: "inputs.",
  STEPS: "steps.",
  ENV: "env.",
  RUN: "run.",
} as const;

// =============================================================================
// Types
// =============================================================================

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
 * Result from parsing an expression
 */
interface ParsedExpressionResult {
  found: boolean;
  value: JsonValue | undefined;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Check if a key is potentially dangerous for prototype pollution
 */
function isDangerousKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

/**
 * Get a nested value from an object using dot notation.
 * Includes protection against prototype pollution attacks.
 */
export function getNestedValue(obj: JsonValue, path: string): JsonValue | undefined {
  const parts = path.split(".");
  let current: JsonValue | undefined = obj;

  for (const part of parts) {
    // Prototype pollution protection
    if (isDangerousKey(part)) {
      console.warn(`Blocked access to dangerous key: ${part}`);
      return undefined;
    }

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
 * Parse an expression and resolve its value from context.
 * This is the shared logic used by both interpolate() and interpolateValue().
 */
function parseExpression(expression: string, ctx: InterpolationContext): ParsedExpressionResult {
  const trimmed = expression.trim();

  if (trimmed.startsWith(EXPR_PREFIX.INPUTS)) {
    const path = trimmed.slice(EXPR_PREFIX.INPUTS.length);
    return { found: true, value: getNestedValue(ctx.inputs, path) };
  }

  if (trimmed.startsWith(EXPR_PREFIX.STEPS)) {
    const path = trimmed.slice(EXPR_PREFIX.STEPS.length);
    return { found: true, value: getNestedValue(ctx.steps, path) };
  }

  if (trimmed.startsWith(EXPR_PREFIX.ENV)) {
    const key = trimmed.slice(EXPR_PREFIX.ENV.length);
    // Prototype pollution check for env keys
    if (isDangerousKey(key)) {
      console.warn(`Blocked access to dangerous env key: ${key}`);
      return { found: true, value: undefined };
    }
    const value = ctx.env ? ctx.env[key] : process.env[key];
    return { found: true, value };
  }

  if (trimmed.startsWith(EXPR_PREFIX.RUN)) {
    const key = trimmed.slice(EXPR_PREFIX.RUN.length);
    if (ctx.run && key in ctx.run) {
      return { found: true, value: ctx.run[key as keyof RunContext] };
    }
    return { found: true, value: undefined };
  }

  // Unknown expression type
  return { found: false, value: undefined };
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
 * Interpolate {{expression}} placeholders in a string
 */
export function interpolate(template: string, ctx: InterpolationContext): string {
  // Use a new RegExp instance to avoid shared lastIndex issues
  const pattern = new RegExp(INTERPOLATION_PATTERN.source, "g");

  return template.replace(pattern, (match, expression: string) => {
    const result = parseExpression(expression, ctx);
    
    if (!result.found) {
      console.warn(`Unknown interpolation expression: ${expression.trim()}`);
      return match;
    }
    
    return formatValue(result.value);
  });
}

/**
 * Check if a string contains interpolation expressions
 */
export function hasInterpolation(str: string): boolean {
  // Create a new RegExp instance to avoid lastIndex issues with global flag
  const pattern = new RegExp(INTERPOLATION_PATTERN.source);
  return pattern.test(str);
}

/**
 * Extract all variable references from a template.
 * Uses matchAll for cleaner iteration.
 */
export function extractVariables(template: string): string[] {
  // Create a new RegExp to reset lastIndex
  const pattern = new RegExp(INTERPOLATION_PATTERN.source, "g");
  const variables: string[] = [];
  
  for (const match of template.matchAll(pattern)) {
    variables.push(match[1].trim());
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
    const result = parseExpression(variable, ctx);
    
    if (!result.found || result.value === undefined) {
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
    const expression = exactMatch[1];
    const result = parseExpression(expression, ctx);
    
    if (result.found) {
      return result.value !== undefined ? result.value : null;
    }
  }

  // Otherwise, perform string interpolation (returns string)
  return interpolate(template, ctx);
}
