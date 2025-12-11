import { describe, it, expect, vi } from "vitest";
import {
  interpolate,
  interpolateValue,
  getNestedValue,
  hasInterpolation,
  extractVariables,
  validateInterpolation,
  type InterpolationContext,
} from "./interpolation.js";

describe("interpolation", () => {
  describe("getNestedValue", () => {
    it("should get top-level values", () => {
      expect(getNestedValue({ name: "test" }, "name")).toBe("test");
    });

    it("should get nested values", () => {
      const obj = { user: { profile: { name: "John" } } };
      expect(getNestedValue(obj, "user.profile.name")).toBe("John");
    });

    it("should return undefined for missing paths", () => {
      expect(getNestedValue({ a: 1 }, "b")).toBeUndefined();
      expect(getNestedValue({ a: { b: 1 } }, "a.c")).toBeUndefined();
    });

    it("should return undefined for null in path", () => {
      expect(getNestedValue({ a: null }, "a.b")).toBeUndefined();
    });

    it("should return undefined for non-object in path", () => {
      expect(getNestedValue({ a: "string" }, "a.b")).toBeUndefined();
      expect(getNestedValue({ a: 123 }, "a.b")).toBeUndefined();
    });

    it("should return undefined for array in path", () => {
      expect(getNestedValue({ a: [1, 2, 3] }, "a.b")).toBeUndefined();
    });

    it("should handle deeply nested values", () => {
      const obj = { a: { b: { c: { d: { e: "deep" } } } } };
      expect(getNestedValue(obj, "a.b.c.d.e")).toBe("deep");
    });
  });

  describe("interpolate", () => {
    it("should interpolate input variables", () => {
      const ctx: InterpolationContext = {
        inputs: { name: "World" },
        steps: {},
      };
      expect(interpolate("Hello {{inputs.name}}!", ctx)).toBe("Hello World!");
    });

    it("should interpolate step outputs", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: { build: { stdout: "success" } },
      };
      expect(interpolate("Build: {{steps.build.stdout}}", ctx)).toBe("Build: success");
    });

    it("should interpolate environment variables", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
        env: { NODE_ENV: "production" },
      };
      expect(interpolate("Env: {{env.NODE_ENV}}", ctx)).toBe("Env: production");
    });

    it("should fall back to process.env if ctx.env not provided", () => {
      const originalEnv = process.env.TEST_VAR;
      process.env.TEST_VAR = "test-value";

      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
      };
      expect(interpolate("{{env.TEST_VAR}}", ctx)).toBe("test-value");

      // Restore original value
      if (originalEnv === undefined) {
        process.env.TEST_VAR = "";
      } else {
        process.env.TEST_VAR = originalEnv;
      }
    });

    it("should handle multiple interpolations", () => {
      const ctx: InterpolationContext = {
        inputs: { first: "Hello", second: "World" },
        steps: {},
      };
      expect(interpolate("{{inputs.first}} {{inputs.second}}!", ctx)).toBe("Hello World!");
    });

    it("should handle missing values as empty string", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
      };
      expect(interpolate("Value: {{inputs.missing}}", ctx)).toBe("Value: ");
    });

    it("should format numbers correctly", () => {
      const ctx: InterpolationContext = {
        inputs: { count: 42 },
        steps: {},
      };
      expect(interpolate("Count: {{inputs.count}}", ctx)).toBe("Count: 42");
    });

    it("should format booleans correctly", () => {
      const ctx: InterpolationContext = {
        inputs: { enabled: true, disabled: false },
        steps: {},
      };
      expect(interpolate("{{inputs.enabled}} {{inputs.disabled}}", ctx)).toBe("true false");
    });

    it("should JSON stringify objects and arrays", () => {
      const ctx: InterpolationContext = {
        inputs: { data: { key: "value" } },
        steps: {},
      };
      expect(interpolate("{{inputs.data}}", ctx)).toBe('{"key":"value"}');
    });

    it("should handle whitespace in expressions", () => {
      const ctx: InterpolationContext = {
        inputs: { name: "test" },
        steps: {},
      };
      expect(interpolate("{{ inputs.name }}", ctx)).toBe("test");
      expect(interpolate("{{  inputs.name  }}", ctx)).toBe("test");
    });

    it("should leave unknown expressions unchanged and warn", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
      };
      expect(interpolate("{{unknown.path}}", ctx)).toBe("{{unknown.path}}");
      expect(warnSpy).toHaveBeenCalledWith("Unknown interpolation expression: unknown.path");
      warnSpy.mockRestore();
    });

    it("should return string unchanged if no interpolation", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
      };
      expect(interpolate("plain text", ctx)).toBe("plain text");
    });
  });

  describe("interpolateValue", () => {
    it("should preserve number types for exact matches", () => {
      const ctx: InterpolationContext = {
        inputs: { count: 42 },
        steps: {},
      };
      expect(interpolateValue("{{inputs.count}}", ctx)).toBe(42);
      expect(typeof interpolateValue("{{inputs.count}}", ctx)).toBe("number");
    });

    it("should preserve boolean types for exact matches", () => {
      const ctx: InterpolationContext = {
        inputs: { enabled: true, disabled: false },
        steps: {},
      };
      expect(interpolateValue("{{inputs.enabled}}", ctx)).toBe(true);
      expect(interpolateValue("{{inputs.disabled}}", ctx)).toBe(false);
    });

    it("should preserve object types for exact matches", () => {
      const ctx: InterpolationContext = {
        inputs: { data: { key: "value", nested: { a: 1 } } },
        steps: {},
      };
      const result = interpolateValue("{{inputs.data}}", ctx);
      expect(result).toEqual({ key: "value", nested: { a: 1 } });
    });

    it("should preserve array types for exact matches", () => {
      const ctx: InterpolationContext = {
        inputs: { items: [1, 2, 3] },
        steps: {},
      };
      const result = interpolateValue("{{inputs.items}}", ctx);
      expect(result).toEqual([1, 2, 3]);
    });

    it("should return string for mixed content", () => {
      const ctx: InterpolationContext = {
        inputs: { count: 42 },
        steps: {},
      };
      expect(interpolateValue("Count: {{inputs.count}}", ctx)).toBe("Count: 42");
      expect(typeof interpolateValue("Count: {{inputs.count}}", ctx)).toBe("string");
    });

    it("should handle whitespace around exact matches", () => {
      const ctx: InterpolationContext = {
        inputs: { count: 42 },
        steps: {},
      };
      expect(interpolateValue("  {{inputs.count}}  ", ctx)).toBe(42);
    });

    it("should return null for missing values in exact matches", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
      };
      expect(interpolateValue("{{inputs.missing}}", ctx)).toBeNull();
    });

    it("should preserve step result types", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: { api: { status: 200, data: { id: 123 } } },
      };
      expect(interpolateValue("{{steps.api.status}}", ctx)).toBe(200);
      expect(interpolateValue("{{steps.api.data}}", ctx)).toEqual({ id: 123 });
    });

    it("should handle env values", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
        env: { PORT: "3000" },
      };
      // Env values are always strings
      expect(interpolateValue("{{env.PORT}}", ctx)).toBe("3000");
    });

    it("should return null for missing env in exact match", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
        env: {},
      };
      expect(interpolateValue("{{env.MISSING}}", ctx)).toBeNull();
    });
  });

  describe("hasInterpolation", () => {
    it("should return true for strings with interpolation", () => {
      expect(hasInterpolation("{{inputs.name}}")).toBe(true);
      expect(hasInterpolation("Hello {{inputs.name}}!")).toBe(true);
      expect(hasInterpolation("{{a}} and {{b}}")).toBe(true);
    });

    it("should return false for strings without interpolation", () => {
      expect(hasInterpolation("plain text")).toBe(false);
      expect(hasInterpolation("")).toBe(false);
      expect(hasInterpolation("{ not interpolation }")).toBe(false);
    });

    it("should handle edge cases", () => {
      expect(hasInterpolation("{{}}")).toBe(false);
      expect(hasInterpolation("{{}")).toBe(false);
      expect(hasInterpolation("{{a}}")).toBe(true);
    });
  });

  describe("extractVariables", () => {
    it("should extract single variable", () => {
      expect(extractVariables("{{inputs.name}}")).toEqual(["inputs.name"]);
    });

    it("should extract multiple variables", () => {
      const result = extractVariables("{{inputs.a}} and {{steps.b.output}}");
      expect(result).toEqual(["inputs.a", "steps.b.output"]);
    });

    it("should return empty array for no variables", () => {
      expect(extractVariables("plain text")).toEqual([]);
    });

    it("should trim whitespace from expressions", () => {
      expect(extractVariables("{{ inputs.name }}")).toEqual(["inputs.name"]);
    });

    it("should extract env variables", () => {
      expect(extractVariables("{{env.NODE_ENV}}")).toEqual(["env.NODE_ENV"]);
    });
  });

  describe("validateInterpolation", () => {
    it("should validate all variables exist", () => {
      const ctx: InterpolationContext = {
        inputs: { name: "test", count: 5 },
        steps: { build: { stdout: "ok" } },
        env: { NODE_ENV: "test" },
      };

      const result = validateInterpolation(
        "{{inputs.name}} {{inputs.count}} {{steps.build.stdout}} {{env.NODE_ENV}}",
        ctx
      );

      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("should detect missing input variables", () => {
      const ctx: InterpolationContext = {
        inputs: { name: "test" },
        steps: {},
      };

      const result = validateInterpolation("{{inputs.name}} {{inputs.missing}}", ctx);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("inputs.missing");
    });

    it("should detect missing step variables", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: { build: { stdout: "ok" } },
      };

      const result = validateInterpolation("{{steps.build.stdout}} {{steps.test.output}}", ctx);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("steps.test.output");
    });

    it("should detect missing env variables", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
        env: { EXISTS: "yes" },
      };

      const result = validateInterpolation("{{env.EXISTS}} {{env.MISSING}}", ctx);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("env.MISSING");
    });

    it("should detect unknown prefixes as missing", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
      };

      const result = validateInterpolation("{{unknown.var}}", ctx);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("unknown.var");
    });

    it("should return valid for string with no interpolation", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
      };

      const result = validateInterpolation("plain text", ctx);

      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("should validate run context variables", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
        run: {
          id: "run-123",
          workflowId: "deploy-prod",
          startedAt: "2024-01-01T00:00:00.000Z",
        },
      };

      const result = validateInterpolation(
        "{{run.id}} {{run.workflowId}} {{run.startedAt}}",
        ctx
      );

      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("should detect missing run context", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
      };

      const result = validateInterpolation("{{run.id}}", ctx);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("run.id");
    });

    it("should detect invalid run context keys", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
        run: {
          id: "run-123",
          workflowId: "deploy-prod",
          startedAt: "2024-01-01T00:00:00.000Z",
        },
      };

      const result = validateInterpolation("{{run.invalid}}", ctx);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("run.invalid");
    });
  });

  describe("run context interpolation", () => {
    it("should interpolate run.id", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
        run: {
          id: "run-abc-123",
          workflowId: "deploy-prod",
          startedAt: "2024-01-01T00:00:00.000Z",
        },
      };
      expect(interpolate("Run ID: {{run.id}}", ctx)).toBe("Run ID: run-abc-123");
    });

    it("should interpolate run.workflowId", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
        run: {
          id: "run-123",
          workflowId: "deploy-prod",
          startedAt: "2024-01-01T00:00:00.000Z",
        },
      };
      expect(interpolate("Workflow: {{run.workflowId}}", ctx)).toBe("Workflow: deploy-prod");
    });

    it("should interpolate run.startedAt", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
        run: {
          id: "run-123",
          workflowId: "deploy-prod",
          startedAt: "2024-01-01T12:30:00.000Z",
        },
      };
      expect(interpolate("Started: {{run.startedAt}}", ctx)).toBe("Started: 2024-01-01T12:30:00.000Z");
    });

    it("should return empty string for missing run context", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
      };
      expect(interpolate("Run: {{run.id}}", ctx)).toBe("Run: ");
    });

    it("should handle multiple run variables in template", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
        run: {
          id: "run-123",
          workflowId: "deploy-prod",
          startedAt: "2024-01-01T00:00:00.000Z",
        },
      };
      expect(interpolate("{{run.workflowId}}/{{run.id}}", ctx)).toBe("deploy-prod/run-123");
    });

    it("should preserve run value types in interpolateValue", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
        run: {
          id: "run-123",
          workflowId: "deploy-prod",
          startedAt: "2024-01-01T00:00:00.000Z",
        },
      };
      expect(interpolateValue("{{run.id}}", ctx)).toBe("run-123");
      expect(interpolateValue("{{run.workflowId}}", ctx)).toBe("deploy-prod");
    });

    it("should return null for missing run context in interpolateValue", () => {
      const ctx: InterpolationContext = {
        inputs: {},
        steps: {},
      };
      expect(interpolateValue("{{run.id}}", ctx)).toBeNull();
    });

    it("should extract run variables", () => {
      const result = extractVariables("{{run.id}} {{run.workflowId}}");
      expect(result).toEqual(["run.id", "run.workflowId"]);
    });
  });
});
