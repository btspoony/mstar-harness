import { afterAll, describe, expect, test } from "bun:test";
import { initializeStore, readExecutionAuthority } from "@mstar-harness/engine";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand } from "../definitions.js";
import type { CommandEnvelope, InvocationContext } from "../types.js";

const WORKFLOW = "wf-anchor";
const SESSION = "anchor-session";

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

/** A caller holding the coordinator session the repair verb requires. */
function sessionContext(): InvocationContext {
  return { ...context(), sessionId: SESSION };
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

/** Bind the registering identity as coordinator so the repair verb is admitted. */
async function bind(harnessDir: string): Promise<void> {
  const authority = await readExecutionAuthority({ harnessDir }, { workflowId: WORKFLOW });
  if (!("workflows" in authority.data)) throw new Error("registration did not produce a workflow view");
  const workflow = authority.data.workflows.find((entry) => entry.state.id === WORKFLOW);
  if (workflow === undefined) throw new Error("registered workflow was absent from the execution view");
  const bound = await executeCommand("plan.bind", {
    execution: true, workflow: WORKFLOW, coordinator: true,
    expect: workflow.workflowToken, operation: "anchor-bind", harness: harnessDir,
  }, sessionContext());
  expect(bound).toMatchObject({ status: "ok" });
}

/** The registered anchors as the authority holds them after a repair. */
async function storedBranch(harnessDir: string): Promise<unknown> {
  const authority = await readExecutionAuthority({ harnessDir }, { workflowId: WORKFLOW });
  if (!("workflows" in authority.data)) throw new Error("repair did not produce a workflow view");
  const workflow = authority.data.workflows.find((entry) => entry.state.id === WORKFLOW);
  if (workflow === undefined) throw new Error("registered workflow was absent from the execution view");
  return workflow.state.branch;
}

function deliverAnchors(harnessDir: string, anchors: { base?: string; work?: string; target?: string }): Promise<CommandEnvelope<unknown>> {
  return executeCommand("workflow.delivery-anchors", {
    workflow: WORKFLOW,
    ...(anchors.base === undefined ? {} : { branchBase: anchors.base }),
    ...(anchors.work === undefined ? {} : { branchWork: anchors.work }),
    ...(anchors.target === undefined ? {} : { branchTarget: anchors.target }),
    reason: "anchor repair under test",
    harness: harnessDir,
  }, sessionContext());
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
    const harnessDir = await harness();
    const envelope = await register(harnessDir, { base: "feature/plan-anchor", work: "feature/plan-anchor", target: "main" });
    expect(envelope).toMatchObject({ status: "ok", code: "workflow.register.ok", exitCode: 0 });
    const warnings = warningsOf(envelope);
    expect(warnings).toHaveLength(1);
    // The advisory names both anchors in the collision and both corrections
    // that can break it, so neither the anchor nor the repair is one-sided.
    expect(warnings[0]).toContain("--branch-base/--branch-work");
    expect(warnings[0]).toContain('"feature/plan-anchor"');
    expect(warnings[0]).toContain("--branch-base");
    expect(warnings[0]).toContain("--branch-work");
    expect(warnings[0]).toContain("mstar workflow delivery-anchors");
    // Registration still stores the suspicious pair it warned about.
    expect(await storedBranch(harnessDir)).toEqual({ base: "feature/plan-anchor", work: "feature/plan-anchor", target: "main" });
  });

  test("the correction the advisory names on `base === work` clears the collision", async () => {
    // `base` holds the real creation anchor here, so moving the work branch is
    // the legitimate repair - the one the advisory must name, because
    // `--branch-base` on this shape re-records an anchor that is already right
    // and returns ok with the collision intact.
    const harnessDir = await harness();
    expect(warningsOf(await register(harnessDir, { base: "main", work: "main", target: "release" }))).toHaveLength(1);
    await bind(harnessDir);
    expect(await deliverAnchors(harnessDir, { work: "feature/plan-anchor" })).toMatchObject({
      status: "ok", code: "workflow.delivery-anchors.ok",
    });
    expect(await storedBranch(harnessDir)).toEqual({ base: "main", work: "feature/plan-anchor", target: "release" });
  });

  test("the correction the advisory names on `work === target` clears the collision", async () => {
    // The mirrored shape: `work` holds the real delivery branch, so the target
    // is what gets re-recorded. Without the second correction the advisory
    // would send the operator to rewrite an anchor that is already right.
    const harnessDir = await harness();
    expect(warningsOf(await register(harnessDir, { base: "main", work: "feature/plan-anchor", target: "feature/plan-anchor" }))).toHaveLength(1);
    await bind(harnessDir);
    expect(await deliverAnchors(harnessDir, { target: "main" })).toMatchObject({
      status: "ok", code: "workflow.delivery-anchors.ok",
    });
    expect(await storedBranch(harnessDir)).toEqual({ base: "main", work: "feature/plan-anchor", target: "main" });
  });

  test("all three anchors recorded as one branch warns twice and still registers", async () => {
    // Such a triple names no delivery at all: the delivery branch is its own
    // target and its own creation base. Each collision keeps its own sentence,
    // and the work === target one comes first.
    const harnessDir = await harness();
    const envelope = await register(harnessDir, { base: "main", work: "main", target: "main" });
    expect(envelope).toMatchObject({ status: "ok", code: "workflow.register.ok", exitCode: 0 });
    const warnings = warningsOf(envelope);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("--branch-work/--branch-target");
    expect(warnings[1]).toContain("--branch-base/--branch-work");
    // Registration still stores the triple it warned about.
    expect(await storedBranch(harnessDir)).toEqual({ base: "main", work: "main", target: "main" });
  });

  test("a coherent anchor triple carries no advisory", async () => {
    // base and target name the protected merge anchor; only work is a feature.
    const envelope = await register(await harness(), { base: "main", work: "feature/plan-anchor", target: "main" });
    expect(envelope).toMatchObject({ status: "ok", code: "workflow.register.ok" });
    expect(warningsOf(envelope)).toEqual([]);
  });
});
