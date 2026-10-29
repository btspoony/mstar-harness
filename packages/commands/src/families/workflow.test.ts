import { describe, expect, test } from "bun:test";
import { executeCommand } from "../definitions.js";
import type { InvocationContext } from "../types.js";

/**
 * Handler-level refusals of the workflow family. The schema layer's own
 * diagnostics are covered by `input-diagnostics.test.ts`; these cases pass
 * admission and prove what the handler does with the admitted value.
 */
function context(): InvocationContext {
  return {
    cwd: process.cwd(),
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      readInput: async () => "",
      spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
      startDashboard: async () => {
        throw new Error("unused in workflow family tests");
      },
      openBrowser: async () => {
        throw new Error("unused in workflow family tests");
      },
    },
  };
}

describe("workflow family refusals", () => {
  test("workflow.register refuses an array-shaped project instead of dropping it", async () => {
    // `project` is repeatable for `iteration.register` and shares one schema,
    // so an MCP caller can reach this handler with an array. A plan workflow
    // records one project id: the value is refused by name, never discarded.
    const envelope = await executeCommand(
      "workflow.register",
      {
        workflow: "wf-plan-project",
        planId: "plan-project",
        planTitle: "Plan project",
        planFile: "plans/plan-project.md",
        deliveryKind: "development",
        project: ["proj-a"],
      },
      context(),
    );
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (envelope.status !== "usage") throw new Error(`expected a usage envelope, got ${envelope.status}`);
    expect(envelope.message).toContain("project takes one value");
    expect(envelope.message).toContain('["proj-a"]');
    // The recovery names the supported single-project form and the iteration
    // surface that does carry many.
    expect(String(envelope.details?.recovery)).toContain("--project <projectId>");
    expect(String(envelope.details?.recovery)).toContain("mstar catalog link");
  });
});
