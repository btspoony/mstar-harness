import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCatalogEntity } from "./catalog.js";
import { readExecutionAuthority, readExecutionCleanupState } from "./execution-read.js";
import { createExecutionWorkflow, initializeExecutionAuthority, readExecutionState } from "./execution-store.js";
import { initializeStore, type StoreContext, type StoreDb } from "./store-db.js";
import type { WorkflowEntry } from "./status.js";
import type { WorkflowSnapshot } from "./workflow.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-cleanup-read-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const TS = "2026-10-04T00:00:00.000Z";

async function fixture(label: string): Promise<StoreContext> {
  const context: StoreContext = { harnessDir: mkdtempSync(join(ROOT, `${label}-`)) };
  const store = await initializeStore(context);
  store.close();
  const initialized = await initializeExecutionAuthority(context);
  const workflowId = `wf-${label}`;
  const planId = `plan-${label}`;
  await registerCatalogEntity(
    context,
    { kind: "plan", id: planId, title: planId, rootKind: "plans", relativePath: `plans/${planId}.md` },
    { operationId: `catalog-${label}`, actor: "execution-read.test" },
  );
  const entry: WorkflowEntry = { id: workflowId, type: "plan", started_at: TS, dir: `workflows/${workflowId}` };
  const snapshot = {
    schema_version: 1, id: workflowId, type: "plan", status: "running", started_at: TS, updated_at: TS,
    plans: [{ id: planId, title: planId, file: `plans/${planId}.md`, status: "Todo", metadata: { worktree_path: `/tmp/${workflowId}`, working_branch: `feature/${workflowId}` } }],
    delivery_kind: "development", branch: { source: `feature/${workflowId}`, target: "main" },
  } as unknown as WorkflowSnapshot;
  await createExecutionWorkflow(
    { ...context, caller: { sessionId: `creator-${label}`, role: "coordinator", workflowId, planId: null } },
    { entry, snapshot, expected: initialized.token, operationId: `create-${label}` },
  );
  return context;
}

function db(context: StoreContext): StoreDb {
  return new DatabaseSync(join(context.harnessDir, "store.db")) as unknown as StoreDb;
}

describe("execution-cleanup-read", () => {
  test("registered selection returns cleanup-ready selected facts and complete inventory", async () => {
    const context = await fixture("registered");
    const result = await readExecutionCleanupState(context, "wf-registered");
    expect(result.selected.id).toBe("wf-registered");
    expect(result.selected.plans.map((row) => row.id)).toEqual(["plan-registered"]);
    expect(result.selected.plans[0]?.metadata).toEqual({
      worktree_path: "/tmp/wf-registered",
      working_branch: "feature/wf-registered",
    });
    expect(result.selected.plans[0]).not.toHaveProperty("execution_lease");
    expect(result.workflows.map((row) => row.id)).toContain("wf-registered");
  });

  test("terminal retained workflow remains addressable after registry removal", async () => {
    const context = await fixture("retained");
    const store = db(context);
    try {
      store.prepare("update execution_workflows set state_json = json_set(state_json, '$.status', 'stopped', '$.ended_at', ?) where workflow_id = ?")
        .run(TS, "wf-retained");
      store.prepare("delete from execution_registry where workflow_id = ?").run("wf-retained");
    } finally {
      store.close();
    }
    expect((await readExecutionState(context)).data.workflows).toHaveLength(0);
    const result = await readExecutionCleanupState(context, "wf-retained");
    expect(result.selected.status).toBe("stopped");
    expect(result.workflows.map((row) => row.id)).toContain("wf-retained");
  });

  test("unknown address refuses instead of selecting a remaining workflow", async () => {
    const context = await fixture("unknown");
    await expect(readExecutionCleanupState(context, "wf-not-recorded")).rejects.toMatchObject({
      code: "coordination.workflow-not-found",
      message: expect.stringContaining("List registered workflow ids via mstar status validate (data.workflows[].id), then re-run mstar worktree cleanup --workflow <listedId>; if no registered workflow remains, there is nothing to clean."),
    });
  });
  test("missing plan refusal names direct read recovery", async () => {
    const context = await fixture("missing-plan");
    await expect(readExecutionAuthority(context, { workflowId: "wf-missing-plan", planId: "plan-not-recorded" })).rejects.toMatchObject({
      code: "coordination.plan-not-found",
      message: expect.stringContaining("List valid plan ids with mstar plan show --workflow wf-missing-plan"),
    });
  });

  test("unreadable retained protective state refuses instead of omitting a sibling", async () => {
    const context = await fixture("corrupt");
    const store = db(context);
    try {
      store.prepare("update execution_workflows set state_json = '{' where workflow_id = ?").run("wf-corrupt");
    } finally {
      store.close();
    }
    await expect(readExecutionCleanupState(context, "wf-corrupt")).rejects.toMatchObject({ code: "store.corrupt" });
  });

  test("current foreign integration claim remains in the protective inventory", async () => {
    const context = await fixture("held");
    const store = db(context);
    try {
      store.prepare("insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values(?, 1, 1, ?)")
        .run("wf-held", JSON.stringify({
          holder: "foreign-holder", claimed_at: TS, plan_id: "plan-held",
          source_branch: "feature/foreign", target_branch: "main", status: "held",
        }));
    } finally {
      store.close();
    }
    const result = await readExecutionCleanupState(context, "wf-held");
    expect(result.selected.integration_merge_lease).toMatchObject({ holder: "foreign-holder", source_branch: "feature/foreign" });
  });

  test("released integration claim is excluded from the protective inventory", async () => {
    const context = await fixture("released");
    const store = db(context);
    try {
      store.prepare("insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values(?, 2, 1, ?)")
        .run("wf-released", JSON.stringify({
          holder: "former-holder", claimed_at: TS, plan_id: "plan-released",
          source_branch: "feature/former", target_branch: "main", status: "released",
        }));
    } finally {
      store.close();
    }
    const result = await readExecutionCleanupState(context, "wf-released");
    expect(result.selected.integration_merge_lease).toBeUndefined();
  });

  test("invalid retained sibling refuses rather than weakening protection", async () => {
    const context = await fixture("invalid-sibling");
    const store = db(context);
    try {
      store.prepare("update execution_workflows set state_json = json_set(state_json, '$.status', 'impossible') where workflow_id = ?")
        .run("wf-invalid-sibling");
      store.prepare("delete from execution_registry where workflow_id = ?").run("wf-invalid-sibling");
    } finally {
      store.close();
    }
    await expect(readExecutionCleanupState(context, "wf-invalid-sibling")).rejects.toMatchObject({ code: "store.corrupt" });
  });


  test("inventory contains distinct retained workflows in the same read", async () => {
    const context = await fixture("retained-pair");
    const secondWorkflow = "wf-retained-pair-second";
    const secondPlan = "plan-retained-pair-second";
    await registerCatalogEntity(
      context,
      { kind: "plan", id: secondPlan, title: secondPlan, rootKind: "plans", relativePath: `plans/${secondPlan}.md` },
      { operationId: "catalog-retained-pair-second", actor: "execution-read.test" },
    );
    const current = await readExecutionState(context);
    const entry: WorkflowEntry = { id: secondWorkflow, type: "plan", started_at: TS, dir: `workflows/${secondWorkflow}` };
    const snapshot = {
      schema_version: 1, id: secondWorkflow, type: "plan", status: "running", started_at: TS, updated_at: TS,
      plans: [{ id: secondPlan, title: secondPlan, file: `plans/${secondPlan}.md`, status: "Todo" }],
      delivery_kind: "development", branch: { source: `feature/${secondWorkflow}`, target: "main" },
    } as unknown as WorkflowSnapshot;
    await createExecutionWorkflow(
      { ...context, caller: { sessionId: "creator-retained-pair-second", role: "coordinator", workflowId: secondWorkflow, planId: null } },
      { entry, snapshot, expected: current.token, operationId: "create-retained-pair-second" },
    );
    const store = db(context);
    try {
      store.prepare("delete from execution_registry where workflow_id in (?, ?)").run("wf-retained-pair", secondWorkflow);
    } finally {
      store.close();
    }
    const result = await readExecutionCleanupState(context, "wf-retained-pair");
    expect(new Set(result.workflows.map((workflow) => workflow.id))).toEqual(new Set(["wf-retained-pair", secondWorkflow]));
    expect(result.selected.id).toBe("wf-retained-pair");
  });
});
