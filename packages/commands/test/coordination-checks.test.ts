import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandDefinitions } from "../src/index.js";
import type { InvocationContext } from "../src/types.js";
import {
  bindExecutionSession,
  executionContextFor,
  mutateExecutionWorkflow,
  createExecutionWorkflow,
  openStore,
  readExecutionState,
  initializeStore,
  evaluatePostMergeCloseFromExecutionAuthority,
  registerCatalogEntity,
  type CatalogOperation,
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

async function activeWorkflow(cwd: string, workflowId: string, rowDone = false) {
  const harness = path.join(cwd, ".mstar");
  mkdirSync(harness, { recursive: true });
  const storeContext = { harnessDir: harness };
  const store = await initializeStore(storeContext);
  // `initializeStore` activates the execution authority (issue #428); read its
  // root creation token back instead of re-initializing.
  const initialized = { token: (await readExecutionState(storeContext)).token };
  store.close();
  const planId = `plan-${workflowId}`;
  await registerCatalogEntity(storeContext, {
    kind: "plan", id: planId, title: planId, rootKind: "plans", relativePath: `${planId}.md`,
  }, { operationId: `catalog-${workflowId}`, actor: "project-manager" } satisfies CatalogOperation);
  const identity = { source: "local" as const, sessionId: `coordinator-${workflowId}`, role: "coordinator" as const, workflowId };
  const execution = executionContextFor(storeContext, identity);
  const created = await createExecutionWorkflow(execution, {
    entry: { id: workflowId, type: "plan", started_at: "2026-09-01T00:00:00.000Z", dir: `workflows/${workflowId}` },
    snapshot: {
      schema_version: 1, id: workflowId, type: "plan", status: "running", started_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z", phase: "phase-2-execute",
      plans: [{ id: planId, title: planId, file: `${planId}.md`, status: rowDone ? "Done" : "InProgress" }],
      delivery_kind: "development",
      branch: { base: "main", source: "feature/test", target: "main", integration: "integration/test" },
    } as unknown as WorkflowSnapshot,
    expected: initialized.token,
    operationId: `create-${workflowId}`,
  });
  return { harness, storeContext, planId, execution, workflowToken: created.data.workflows[0]!.workflowToken };
}

/** Inject inconsistent terminal histories only for the isolated negative gate fixtures. */
async function completeAndUnregister(
  context: { harnessDir: string },
  workflowId: string,
  planId: string,
  options: { delivery?: boolean; rowDone?: boolean } = {},
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
    const { harness, execution, workflowToken } = await activeWorkflow(cwd, "wf-active-closed", true);
    const bound = await bindExecutionSession(execution, { workflowId: "wf-active-closed", expected: workflowToken, operationId: "bind-closed" });
    await mutateExecutionWorkflow(execution, {
      workflowId: "wf-active-closed", session: bound.data, operationId: "evidence-closed",
      operation: { kind: "delivery", delivery: {
        compound: { outcome: "updated" },
        pr: { repo: "fixture/repo", head: "feature/test", target: "main" },
        merge: { provider: "fixture", evidence: "merged" },
      } },
    });
    await mutateExecutionWorkflow(execution, {
      workflowId: "wf-active-closed", session: bound.data, operationId: "close-history",
      operation: { kind: "lifecycle", status: "completed", reason: "delivery complete" },
    });
    const result = await definition("iteration.gate").execute(
      { workflow: "wf-active-closed", phase: "6", harness } as never,
      context(cwd),
    );
    expect(result).toMatchObject({ status: "ok", data: { gate: { ok: true, violations: [] } } });
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
  test("null workflow state is an invalid snapshot", async () => {
    const cwd = tempRoot();
    const { harness, storeContext } = await activeWorkflow(cwd, "wf-null-state");
    const store = await openStore(storeContext, "write");
    try {
      store.db.prepare("update execution_workflows set state_json = 'null' where workflow_id = ?").run("wf-null-state");
    } finally {
      store.close();
    }
    const result = await definition("iteration.gate").execute(
      { workflow: "wf-null-state", phase: "6", harness } as never,
      context(cwd),
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.details?.gate).toMatchObject({ violations: expect.arrayContaining([
        expect.objectContaining({ code: "PHASE6_INVALID_SNAPSHOT" }),
      ]) });
    }
  });

  test("registry identity mismatch fails root closed and still reports target registration", async () => {
    const cwd = tempRoot();
    const { harness, storeContext } = await activeWorkflow(cwd, "wf-registry-mismatch");
    const store = await openStore(storeContext, "write");
    try {
      store.db.prepare("update execution_registry set entry_json = ? where workflow_id = ?")
        .run(JSON.stringify({ id: "wf-other", type: "plan", started_at: "2026-09-01T00:00:00.000Z", dir: "workflows/wf-other" }), "wf-registry-mismatch");
    } finally {
      store.close();
    }
    const gate = await evaluatePostMergeCloseFromExecutionAuthority(storeContext, "wf-registry-mismatch");
    expect(gate.violations.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "PHASE6_INVALID_ROOT",
      "PHASE6_ROOT_ENTRY_PRESENT",
    ]));
  });

  test("non-active execution authority is refused by the evaluator", async () => {
    const cwd = tempRoot();
    const { storeContext } = await activeWorkflow(cwd, "wf-staged-authority");
    const store = await openStore(storeContext, "write");
    try {
      store.db.prepare("update execution_meta set authority_state = 'staged' where id = 1").run();
    } finally {
      store.close();
    }
    await expect(evaluatePostMergeCloseFromExecutionAuthority(storeContext, "wf-staged-authority"))
      .rejects.toMatchObject({ code: "execution.consumer-not-ready" });
  });

  test("non-six ACTIVE gate rejects workflow and plan row identity mismatches", async () => {
    for (const mismatch of ["workflow", "plan"] as const) {
      const cwd = tempRoot();
      const workflowId = `wf-${mismatch}-identity-mismatch`;
      const { harness, storeContext, planId } = await activeWorkflow(cwd, workflowId);
      const store = await openStore(storeContext, "write");
      try {
        if (mismatch === "workflow") {
          const row = store.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(workflowId) as { state_json: string };
          const state = JSON.parse(row.state_json) as Record<string, unknown>;
          state.id = "wf-wrong-state-id";
          store.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), workflowId);
        } else {
          const row = store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, planId) as { state_json: string };
          const plan = JSON.parse(row.state_json) as Record<string, unknown>;
          plan.id = "plan-wrong-state-id";
          store.db.prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?")
            .run(JSON.stringify(plan), workflowId, planId);
        }
      } finally {
        store.close();
      }
      const compass = path.join(cwd, "compass.md");
      writeFileSync(compass, `---
iteration_id: iter-${mismatch}-identity
start_date: "2026-09-01"
status: active
iteration_base_branch: main
target_branch: main
plans:
  - ${planId}
---
`);
      const result = await definition("iteration.gate").execute(
        { workflow: workflowId, compass, harness } as never,
        context(cwd),
      );
      expect(result).toMatchObject({ status: "refused", code: "coordination.check-refused", details: { underlyingCode: "execution.workflow-identity-mismatch" } });
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

  test("non-six ACTIVE compass gate evaluates Done plans and the compass close exit", async () => {
    const cwd = tempRoot();
    const { harness, storeContext, planId } = await activeWorkflow(cwd, "wf-active-done");
    const store = await openStore(storeContext, "write");
    try {
      const plan = store.db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?")
        .get("wf-active-done", planId) as { state_json: string };
      const planState = JSON.parse(plan.state_json) as Record<string, unknown>;
      planState.status = "Done";
      store.db.prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?")
        .run(JSON.stringify(planState), "wf-active-done", planId);
      store.db.prepare(
        "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) values (?, 1, null, 'null', ?, ?)",
      ).run("wf-unrelated-corrupt", "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
      store.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)")
        .run("wf-unrelated-corrupt", JSON.stringify({
          id: "wf-unrelated-corrupt",
          type: "plan",
          started_at: "2026-09-02T00:00:00.000Z",
          dir: "workflows/wf-unrelated-corrupt",
        }));
    } finally {
      store.close();
    }
    const compass = path.join(cwd, "delivery-compass.md");
    writeFileSync(compass, `---
iteration_id: iter-active-done
start_date: "2026-09-01"
status: completed
iteration_base_branch: integration/test
target_branch: main
plans:
  - ${planId}
end_date: "2026-09-02"
---
`);
    const result = await definition("iteration.gate").execute({
      workflow: "wf-active-done",
      compass,
      harness,
      branch: "integration/test",
      integration: "integration/test",
      target: "main",
    } as never, context(cwd));
    expect(result).toMatchObject({ status: "ok", data: { transition: "phase-4-pr-delivery", entry: { ok: true }, exit: { ok: true } } });
  });

  test("non-six ACTIVE compass gate requires registered plans to be Done", async () => {
    const cwd = tempRoot();
    const { harness } = await activeWorkflow(cwd, "wf-active-not-done");
    const compass = path.join(cwd, "delivery-compass.md");
    writeFileSync(compass, `---
iteration_id: iter-active-not-done
start_date: "2026-09-01"
status: active
iteration_base_branch: integration/test
target_branch: main
plans:
  - plan-wf-active-not-done
---
`);
    const result = await definition("iteration.gate").execute({
      workflow: "wf-active-not-done",
      compass,
      harness,
    } as never, context(cwd));
    expect(result).toMatchObject({
      status: "ok",
      data: { transition: "phase-2-execute", entry: { ok: false } },
    });
  });
describe("coordination checks command family", () => {

  test("migration refusal leaves the source tree untouched", async () => {
    const cwd = tempRoot();
    const before = readdirSync(cwd);
    const result = await definition("migrate").execute({ path: cwd } as never, context(cwd));
    expect(result).toMatchObject({ status: "refused", exitCode: 1 });
    expect(readdirSync(cwd)).toEqual(before);
  });

  test("phase-six gate reports blocking violations for an invalid workflow state", async () => {
    const cwd = tempRoot();
    // The ACTIVE authority is the only source (issue #428): an addressed
    // workflow whose stored state cannot be verified is `PHASE6_INVALID_SNAPSHOT`
    // rather than a verdict about a planted snapshot file.
    const { harness, storeContext } = await activeWorkflow(cwd, "wf-invalid");
    const store = await openStore(storeContext, "write");
    try {
      store.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
        .run(JSON.stringify({ id: "wf-invalid", type: "iteration", status: "InProgress" }), "wf-invalid");
    } finally {
      store.close();
    }

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
  test("integration lease verification reads the lease from the addressed authority entry", async () => {
    const cwd = tempRoot();
    const { harness, storeContext } = await activeWorkflow(cwd, "wf-integration");
    const validLease = {
      holder: "session-a",
      claimed_at: "2026-09-26T12:00:00Z",
      plan_id: "plan-wf-integration",
      source_branch: "feature/plan-a",
      target_branch: "spec/integration",
    };
    // The lease fact lives on the addressed workflow ENTRY of the served graph
    // (`ExecutionState.workflows[0].integrationLease`) — never at the DTO root.
    // Seeding it through the authority's own row is what makes `claimed:true`
    // observable: a DTO-root read reports `claimed:false` for a held lease.
    const store = await openStore(storeContext, "write");
    try {
      store.db.prepare(
        "insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, 1, ?)",
      ).run("wf-integration", JSON.stringify(validLease));
    } finally {
      store.close();
    }

    const valid = await definition("lease.verify-integration").execute(
      { workflow: "wf-integration", harness } as never,
      context(cwd),
    );
    expect(valid).toMatchObject({
      status: "ok",
      data: { workflow: "wf-integration", claimed: true, lease: validLease },
    });

    // An INVALID held lease is validated, not silently reported as unclaimed.
    const broken = await openStore(storeContext, "write");
    try {
      broken.db.prepare("update execution_integration_leases set lease_json = ? where workflow_id = ?")
        .run(JSON.stringify({ holder: "session-a" }), "wf-integration");
    } finally {
      broken.close();
    }
    const invalid = await definition("lease.verify-integration").execute(
      { workflow: "wf-integration", harness } as never,
      context(cwd),
    );
    // A malformed held lease is refused at the authority read boundary (the
    // stored row cannot be verified) — never silently reported as unclaimed.
    expect(invalid).toMatchObject({ status: "refused", exitCode: 1 });
    if (invalid.status !== "refused") throw new Error("expected a refusal");
    expect(String(invalid.message)).toContain("lease.merge-lease.missing-claimed-at");

    // A RELEASED lease tombstone is retained history, not a carried claim.
    const released = await openStore(storeContext, "write");
    try {
      released.db.prepare("update execution_integration_leases set lease_json = ? where workflow_id = ?")
        .run(JSON.stringify({ ...validLease, status: "released" }), "wf-integration");
    } finally {
      released.close();
    }
    const unclaimed = await definition("lease.verify-integration").execute(
      { workflow: "wf-integration", harness } as never,
      context(cwd),
    );
    expect(unclaimed).toMatchObject({ status: "ok", data: { workflow: "wf-integration", claimed: false } });
  });
});
