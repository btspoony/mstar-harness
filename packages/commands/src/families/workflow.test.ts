import { afterAll, describe, expect, test } from "bun:test";
import { initializeStore } from "@mstar-harness/engine";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand } from "../definitions.js";
import type { CommandEnvelope, InvocationContext } from "../types.js";

/**
 * Handler-level workflow family cases. The schema layer's own diagnostics are
 * covered by `input-diagnostics.test.ts`; these cases pass admission and prove
 * what the handler does with the admitted value.
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

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/**
 * A temp harness holding one ACTIVE store and the plan document the
 * registration resolves its id and title from.
 */
async function harness(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "workflow-family-"));
  roots.push(root);
  const harnessDir = join(root, ".mstar");
  mkdirSync(join(harnessDir, "plans"), { recursive: true });
  writeFileSync(join(harnessDir, "plans", "plan-anchor.md"), "# Anchor plan\n\n**plan_id:** plan-anchor\n");
  (await initializeStore({ harnessDir })).close();
  return harnessDir;
}

async function register(harnessDir: string, branches: { base: string; work: string; target: string }): Promise<CommandEnvelope<unknown>> {
  return executeCommand("workflow.register", {
    workflow: "wf-anchor",
    planId: "plan-anchor",
    planTitle: "Anchor plan",
    planFile: "plans/plan-anchor.md",
    deliveryKind: "development",
    project: "engine",
    branchBase: branches.base,
    branchWork: branches.work,
    branchTarget: branches.target,
    harness: harnessDir,
  }, context());
}

/** The ok envelope's advisory payload; the envelope's data is opaque to this seat. */
function warningsOf(envelope: CommandEnvelope<unknown>): string[] {
  if (envelope.status !== "ok") throw new Error(`expected an ok envelope, got ${envelope.status}: ${envelope.message}`);
  const { data } = envelope;
  if (data === null || typeof data !== "object" || !("warnings" in data)) return [];
  const { warnings } = data as { warnings: unknown };
  if (!Array.isArray(warnings)) throw new Error("envelope data.warnings is not an array");
  return warnings.map((warning) => String(warning));
}

describe("workflow family advisories", () => {
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

  test("a delivery branch created from the delivery branch warns and still registers", async () => {
    // The creation base recorded as the work branch makes the delivery branch
    // the source of its own change, so the anchors cannot describe a delivery
    // PR. The target names a different branch here: only `base === work` trips.
    const envelope = await register(await harness(), { base: "feature/plan-anchor", work: "feature/plan-anchor", target: "main" });
    expect(envelope).toMatchObject({ status: "ok", code: "workflow.register.ok", exitCode: 0 });
    const warnings = warningsOf(envelope);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("--branch-base/--branch-work");
    expect(warnings[0]).toContain('"feature/plan-anchor"');
    expect(warnings[0]).toContain("branch.base === branch.work");
    // The advisory still reads as an operator instruction: it names the repair
    // command and the reason the verb requires.
    expect(warnings[0]).toContain("mstar workflow delivery-anchors");
    expect(warnings[0]).toContain("--branch-base <branch> --reason <text>");
  });

  test("a coherent anchor triple carries no advisory", async () => {
    // base and target name the protected merge anchor; only work is a feature.
    const envelope = await register(await harness(), { base: "main", work: "feature/plan-anchor", target: "main" });
    expect(envelope).toMatchObject({ status: "ok", code: "workflow.register.ok" });
    expect(warningsOf(envelope)).toEqual([]);
  });
});
