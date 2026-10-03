import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandDefinitions } from "../src/index.js";
import type { InvocationContext } from "../src/types.js";
import {
  createExecutionWorkflow,
  openStore,
  initializeExecutionAuthority,
  initializeStore,
  registerCatalogEntity,
  type CatalogOperation,
  type ExecutionCaller,
  type WorkflowSnapshot,
} from "../../engine/src/index.js";


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

async function activeWorkflow(cwd: string, workflowId: string, status: "running" | "completed" = "running") {
  const harness = path.join(cwd, ".mstar");
  mkdirSync(harness, { recursive: true });
  const storeContext = { harnessDir: harness };
  const store = await initializeStore(storeContext);
  store.close();
  const initialized = await initializeExecutionAuthority(storeContext);
  const planId = `plan-${workflowId}`;
  await registerCatalogEntity(storeContext, {
    kind: "plan", id: planId, title: planId, rootKind: "plans", relativePath: `${planId}.md`,
  }, { operationId: `catalog-${workflowId}`, actor: "project-manager" } satisfies CatalogOperation);
  const caller: ExecutionCaller = { sessionId: `coordinator-${workflowId}`, role: "coordinator", workflowId, planId: null };
  await createExecutionWorkflow({ ...storeContext, caller }, {
    entry: { id: workflowId, type: "plan", started_at: "2026-09-01T00:00:00.000Z", dir: `workflows/${workflowId}` },
    snapshot: {
      schema_version: 1, id: workflowId, type: "plan", status, started_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z", phase: "phase-2-execute",
      plans: [{ id: planId, title: planId, file: `${planId}.md`, status: status === "completed" ? "Done" : "InProgress" }],
      delivery_kind: "development",
      branch: { base: "main", source: "feature/test", target: "main", integration: "integration/test" },
    } as unknown as WorkflowSnapshot,
    expected: initialized.token,
    operationId: `create-${workflowId}`,
  });
  return { harness, storeContext, planId };
}

async function completeAndUnregister(
  context: { harnessDir: string },
  workflowId: string,
  planId: string,
  options: { releasedLease?: boolean; delivery?: boolean; rowDone?: boolean } = {},
) {
  const store = await openStore(context, "write");
  try {
    store.db.exec("begin immediate");
    const row = store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(workflowId) as { state_json: string };
    const state = JSON.parse(row.state_json) as Record<string, unknown>;
    state.status = "completed";
    state.ended_at = "2026-09-02T00:00:00.000Z";
    state.updated_at = "2026-09-02T00:00:00.000Z";
    if (options.delivery) {
      state.delivery = {
        compound: { outcome: "updated" },
        pr: { repo: "fixture/repo", head: "feature/test", target: "main" },
        merge: { provider: "fixture", evidence: "merged" },
      };
    }
    store.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), workflowId);
    const plan = store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, planId) as { state_json: string };
    const planState = JSON.parse(plan.state_json) as Record<string, unknown>;
    planState.status = options.rowDone === false ? "InProgress" : "Done";
    store.db.prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?")
      .run(JSON.stringify(planState), workflowId, planId);
    store.db.prepare("delete from execution_registry where workflow_id = ?").run(workflowId);
    if (options.releasedLease) {
      store.db.prepare(
        "insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, 1, ?)",
      ).run(workflowId, planId, JSON.stringify({ status: "released" }));
    }
    store.db.exec("commit");
  } catch (error) {
    try { store.db.exec("rollback"); } catch {}
    throw error;
  } finally {
    store.close();
  }
}


  test("completed unregistered workflow remains addressable in execution history", async () => {
    const cwd = tempRoot();
    const { harness, storeContext, planId } = await activeWorkflow(cwd, "wf-active-closed");
    await completeAndUnregister(storeContext, "wf-active-closed", planId, { delivery: true, rowDone: true });
    const result = await definition("iteration.gate").execute(
      { workflow: "wf-active-closed", phase: "6", harness } as never,
      context(cwd),
    );
    expect(result).toMatchObject({ status: "ok", data: { gate: { ok: true, violations: [] } } });
  });

  test("released lease tombstone does not count as a dangling lease", async () => {
    const cwd = tempRoot();
    const { harness, storeContext, planId } = await activeWorkflow(cwd, "wf-active-released");
    await completeAndUnregister(storeContext, "wf-active-released", planId, { releasedLease: true, delivery: true });
    const result = await definition("iteration.gate").execute(
      { workflow: "wf-active-released", phase: "6", harness } as never,
      context(cwd),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect((result.data as { gate: { violations: Array<{ code: string }> } }).gate.violations)
        .not.toContainEqual(expect.objectContaining({ code: "PHASE6_DANGLING_LEASE" }));
    }
  });


  test("completed plan without delivery evidence is blocked", async () => {
    const cwd = tempRoot();
    const { harness, storeContext, planId } = await activeWorkflow(cwd, "wf-active-no-delivery");
    await completeAndUnregister(storeContext, "wf-active-no-delivery", planId, { rowDone: true });
    const result = await definition("iteration.gate").execute(
      { workflow: "wf-active-no-delivery", phase: "6", harness } as never,
      context(cwd),
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.details?.gate).toMatchObject({ violations: expect.arrayContaining([
        expect.objectContaining({ code: "PHASE6_DELIVERY_EVIDENCE_INCOMPLETE" }),
      ]) });
    }
  });

  test("completed plan with a non-Done owned row is blocked", async () => {
    const cwd = tempRoot();
    const { harness, storeContext, planId } = await activeWorkflow(cwd, "wf-active-row-not-done");
    await completeAndUnregister(storeContext, "wf-active-row-not-done", planId, { delivery: true, rowDone: false });
    const result = await definition("iteration.gate").execute(
      { workflow: "wf-active-row-not-done", phase: "6", harness } as never,
      context(cwd),
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.details?.gate).toMatchObject({ violations: expect.arrayContaining([
        expect.objectContaining({ code: "PHASE6_PLAN_ROW_NOT_DONE" }),
      ]) });
    }
  });
  test("ACTIVE phase-six gate reads workflow and served root state", async () => {
    const cwd = tempRoot();
    const { harness } = await activeWorkflow(cwd, "wf-active-running");
    const result = await definition("iteration.gate").execute(
      { workflow: "wf-active-running", phase: "6", harness } as never,
      context(cwd),
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.details?.gate).toMatchObject({ violations: expect.arrayContaining([
        expect.objectContaining({ code: "PHASE6_NOT_TERMINAL" }),
        expect.objectContaining({ code: "PHASE6_ROOT_ENTRY_PRESENT" }),
      ]) });
    }
  });

  test("non-six compass form still refuses on ACTIVE execution authority", async () => {
    const cwd = tempRoot();
    const { harness } = await activeWorkflow(cwd, "wf-active-phase-five");
    const result = await definition("iteration.gate").execute(
      { workflow: "wf-active-phase-five", compass: "compass.md", harness } as never,
      context(cwd),
    );
    expect(result).toMatchObject({ status: "refused", code: "execution.consumer-not-ready" });
  });
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
  test("derived view selects the requested row, ignores unrelated rows, and stays read-only", async () => {
    const cwd = tempRoot();
    const harness = path.join(cwd, ".mstar");
    const workflowDir = path.join(harness, "workflows", "wf-derived");
    mkdirSync(workflowDir, { recursive: true });
    const file = path.join(workflowDir, "snapshot.json");
    const selectedLease = {
      holder: "session-a",
      claimed_at: "2026-09-26T12:00:00Z",
      worktree_path: path.join(cwd, "feature-a"),
      working_branch: "feature/a",
    };
    writeFileSync(file, JSON.stringify({
      plans: [
        { id: "plan-a", status: "InProgress", execution_lease: selectedLease },
        { id: "plan-b", status: "InProgress", execution_lease: { holder: "" } },
      ],
    }));
    const before = readFileSync(file, "utf8");
    const result = await definition("lease.verify").execute(
      { workflow: "wf-derived", plan: "plan-a", harness } as never,
      context(cwd),
    );
    expect(result).toMatchObject({ status: "ok", data: { workflow: "wf-derived", plan: "plan-a", lease: selectedLease } });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("authority failure does not fall back to a snapshot", async () => {
    const cwd = tempRoot();
    const harness = path.join(cwd, ".mstar");
    const workflowDir = path.join(harness, "workflows", "wf-authority");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(path.join(workflowDir, "snapshot.json"), JSON.stringify({ plans: [{ id: "plan-a", status: "Todo" }] }));
    // An invalid active execution store is authoritative; the readable snapshot
    // must not be used as a fallback.
    writeFileSync(path.join(harness, "store.db"), "not a sqlite database");
    const result = await definition("lease.verify").execute(
      { workflow: "wf-authority", plan: "plan-a", harness } as never,
      context(cwd),
    );
    expect(result.status).not.toBe("ok");
  });
});
