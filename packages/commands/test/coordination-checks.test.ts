import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandDefinitions } from "../src/index.js";
import type { InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "coordination-checks-"));
  roots.push(root);
  return root;
}
function context(cwd: string, controlRoot: string | null = null): InvocationContext {
  return {
    cwd, controlRoot, versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { throw new Error("coordination checks must not spawn a process"); },
      async startDashboard() { throw new Error("dashboard is unavailable in this test"); },
      async openBrowser() { throw new Error("browser is unavailable in this test"); },
    },
  };
}
function definition(id: string) {
  const found = getCommandDefinitions().find((item) => item.id === id);
  if (!found) throw new Error(`Missing command definition: ${id}`);
  return found;
}

describe("coordination checks command family", () => {
  test("lease verification refuses a plan id outside the workflow snapshot scope", async () => {
    const cwd = tempRoot();
    const harness = path.join(cwd, ".mstar");
    const workflowDir = path.join(harness, "workflows", "wf-scope");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(path.join(workflowDir, "snapshot.json"), JSON.stringify({ plans: [{ id: "plan-a", status: "Todo" }] }));

    const result = await definition("lease.verify").execute(
      { workflow: "wf-scope", plan: "plan-b", harness } as never,
      context(cwd),
    );
    expect(result).toMatchObject({ status: "refused", code: "lease.verify.plan-not-found", exitCode: 1 });
  });

  test("migration refusal leaves the source tree untouched", async () => {
    const cwd = tempRoot();
    const before = readdirSync(cwd);
    const result = await definition("migrate").execute({ path: cwd } as never, context(cwd));
    expect(result).toMatchObject({ status: "refused", exitCode: 1 });
    expect(readdirSync(cwd)).toEqual(before);
  });

  test("phase-six gate reports blocking violations for an invalid workflow snapshot", async () => {
    const cwd = tempRoot();
    const harness = path.join(cwd, ".mstar");
    const workflowDir = path.join(harness, "workflows", "wf-invalid");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(path.join(workflowDir, "snapshot.json"), JSON.stringify({ type: "iteration", status: "InProgress" }));

    const result = await definition("iteration.gate").execute(
      { workflow: "wf-invalid", phase: "6", harness } as never,
      context(cwd),
    );
    expect(result.status).toBe("refused");
    expect(result.exitCode).toBe(1);
    if (result.status === "refused") expect(result.details?.gate).toMatchObject({ ok: false });
  });

  test("push cadence surfaces CI and review-wave blockers", async () => {
    const result = await definition("iteration.push-cadence").execute(
      { ciRunning: true, reviewWave: true } as never,
      context(tempRoot()),
    );
    expect(result).toMatchObject({ status: "refused", exitCode: 1 });
    if (result.status === "refused") expect(result.details?.violations).toHaveLength(2);
  });
  test("integration lease verification validates claimed snapshot leases", async () => {
    const cwd = tempRoot();
    const harness = path.join(cwd, ".mstar");
    const workflowDir = path.join(harness, "workflows", "wf-integration");
    mkdirSync(workflowDir, { recursive: true });
    const file = path.join(workflowDir, "snapshot.json");
    const validLease = {
      holder: "session-a",
      claimed_at: "2026-09-26T12:00:00Z",
      plan_id: "plan-a",
      source_branch: "feature/plan-a",
      target_branch: "spec/integration",
    };
    writeFileSync(file, JSON.stringify({ integration_merge_lease: validLease }));

    const valid = await definition("lease.verify-integration").execute(
      { workflow: "wf-integration", harness } as never,
      context(cwd),
    );
    expect(valid).toMatchObject({
      status: "ok",
      data: { workflow: "wf-integration", claimed: true, lease: validLease },
    });

    writeFileSync(file, JSON.stringify({ integration_merge_lease: null }));
    const invalid = await definition("lease.verify-integration").execute(
      { workflow: "wf-integration", harness } as never,
      context(cwd),
    );
    expect(invalid).toMatchObject({
      status: "refused",
      code: "lease.merge-lease.invalid",
      exitCode: 1,
    });
  });
});
