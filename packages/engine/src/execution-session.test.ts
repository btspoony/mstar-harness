/**
 * execution-session — the reference transport AND the reconstruction of the
 * caller's own binding (primary spec §2.3/§3/§4.1; design R8/R9, A09/A15/A16).
 *
 * The transport cases are pure values. The recovery cases run the REAL modules
 * against a REAL `node:sqlite` store in a per-test temporary root: the authority
 * is initialized and the lifecycle is created and bound through the published
 * verbs (`initializeExecutionAuthority` → `createExecutionWorkflow` →
 * `bindExecutionSession`), exactly as the store's own suites do. No case reads
 * or writes this checkout's control store.
 *
 * The consumer-visible contract asserted here:
 * - the wire form is canonical and adds no authority;
 * - a lost session envelope is not a lost binding: the caller's OWN reference
 *   is reconstructed from the durable row, an ordinary operation runs on it,
 *   and the reconstruction writes nothing (A09/A15);
 * - a live foreign holder is never taken over by this path: only the caller's
 *   own binding is withheld, the refusal asks for the ONE stop/transfer
 *   decision, and reads of every other scope continue (A16).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoordinationError } from "./coordination-write.js";
import {
  assertExecutionSessionCurrent,
  createLocalExecutionIdentity,
  decodeExecutionSessionRef,
  encodeExecutionSessionRef,
  executionContextFor,
  resumeExecutionSession,
} from "./execution-session.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  initializeExecutionAuthority,
  readExecutionPlan,
  readExecutionState,
  serializeExecutionValue,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionState,
  type ExecutionToken,
} from "./execution-store.js";
import type { RecoveryDetails } from "./recovery-intent.js";
import { initializeStore, storeDbPath, type StoreContext } from "./store-db.js";

const ref: ExecutionSessionRef = {
  storeId: "store-1",
  epoch: 3,
  workflowId: "workflow-1",
  role: "coordinator",
  sessionId: "native-session",
  planId: null,
};

describe("execution session transport", () => {
  test("accepts equivalent declared identity with reordered keys and formatted JSON", () => {
    const reordered = Object.fromEntries(Object.entries(ref).reverse());
    const wire = `exec-session-v1:${Buffer.from(JSON.stringify(reordered, null, 2), "utf8").toString("base64url")}`;
    expect(decodeExecutionSessionRef(wire)).toEqual(ref);
  });
  test("rejects invalid UTF-8 bytes", () => {
    const invalidUtf8 = Buffer.from([0xff]).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    expect(() => decodeExecutionSessionRef(`exec-session-v1:${invalidUtf8}`)).toThrow();
  });

  test("rejects copied, stale-shaped, and extra-field references", () => {
    const decoded = { ...ref, extra: true };
    const copied = `exec-session-v1:${Buffer.from(serializeExecutionValue(decoded), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "")}`;
    expect(() => decodeExecutionSessionRef(copied)).toThrow();
    expect(() => decodeExecutionSessionRef("exec-session-v1:eyJzdG9yZUlkIjoiYSJ9")).toThrow();
  });

  test("mints a local id once and keeps explicit role scope", () => {
    const first = createLocalExecutionIdentity({ workflowId: "workflow-1", role: "coordinator", planId: null });
    const second = createLocalExecutionIdentity({ workflowId: "workflow-1", role: "coordinator", planId: null });
    expect(first.source).toBe("local");
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(executionContextFor({ harnessDir: "/tmp/harness" }, first).caller).toMatchObject({
      sessionId: first.sessionId,
      workflowId: "workflow-1",
      role: "coordinator",
      planId: null,
    });
  });

  test("refuses foreign caller and role/plan scope before any store read", async () => {
    const identity = createLocalExecutionIdentity({ workflowId: "workflow-1", role: "coordinator", planId: null });
    const context = executionContextFor({ harnessDir: "/tmp/harness" }, identity);
    await expect(
      resumeExecutionSession({ ...context, caller: { ...context.caller, sessionId: "foreign-session" } }, ref),
    ).rejects.toMatchObject({ code: "execution.scope-mismatch" });
    await expect(
      resumeExecutionSession({ ...context, caller: { ...context.caller, role: "plan-pm", planId: "p-1" } }, ref),
    ).rejects.toMatchObject({ code: "execution.scope-mismatch" });
  });
});

/* ------------------------------------------------------------------------ *
 * Reconstruction of the caller's OWN binding (S2/E03)
 * ------------------------------------------------------------------------ */

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-session-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const TS = "2026-01-02T03:04:05.000Z";
const WORKFLOW_ID = "wf-1";
const PLAN_ID = "p-1";
const OTHER_PLAN_ID = "p-2";
const COORDINATOR_ID = "host-coord";
const PLAN_PM_ID = "host-plan";
const FOREIGN_COORDINATOR_ID = "host-coord-elsewhere";
const FOREIGN_PLAN_PM_ID = "host-plan-elsewhere";

type Fixture = {
  context: StoreContext;
  storeId: string;
  epoch: number;
  /** The coordinator receipt the fixture bound; its reference is a projection of the durable row. */
  coordinator: ExecutionReceipt<ExecutionSessionRef>;
  coordinatorCaller: ExecutionCaller;
  /** The exact request an identical retry of that bind must present. */
  coordinatorBind: { expected: ExecutionToken; operationId: string };
  planPm: ExecutionReceipt<ExecutionSessionRef>;
  planPmCaller: ExecutionCaller;
};

function caller(sessionId: string, role: "coordinator" | "plan-pm", planId: string | null): ExecutionCaller {
  return { sessionId, role, workflowId: WORKFLOW_ID, planId };
}

function domainContext(context: StoreContext, who: ExecutionCaller): ExecutionContext {
  return { harnessDir: context.harnessDir, caller: who };
}

/** Run one raw fixture read directly against the store's own DB file. */
function rawRows<T>(context: StoreContext, sql: string): T[] {
  const db = new DatabaseSync(storeDbPath(context));
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

/** Run one raw fixture write directly against the store's own DB file. */
function withRaw(context: StoreContext, body: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(storeDbPath(context));
  try {
    body(db);
  } finally {
    db.close();
  }
}

/**
 * The refusal of a call that must refuse, with the frozen recovery sidecar in a
 * typed view. The engine owns the writer; this suite owns the reader's
 * validation, so the sidecar's presence and `unresolved` list are checked
 * before the boundary cast that types them.
 */
async function refusalOf(
  run: () => Promise<unknown>,
): Promise<{ code: string; details: Record<string, unknown>; recovery: RecoveryDetails }> {
  const failure = await run().catch((error: unknown) => error);
  if (!(failure instanceof CoordinationError)) throw new Error(`expected a typed refusal, got ${String(failure)}`);
  const recovery = failure.details.recovery;
  if (recovery === null || typeof recovery !== "object" || !("unresolved" in recovery) || !Array.isArray(recovery.unresolved)) {
    throw new Error("the refusal carries no recovery sidecar");
  }
  // Boundary read of the engine-owned sidecar: its members were just checked.
  const sidecar = recovery as RecoveryDetails;
  return { code: failure.code, details: failure.details, recovery: sidecar };
}

/**
 * §2.2 the plan row a plan-pm bind claims: a PREPARED coordination block plus
 * the plan's own recorded worktree/branch scope. No W-phase verb produces one
 * yet (that is the Prepare transition's job), so the fixture plants it exactly
 * as the store's own suites do.
 */
function preparePlanRow(context: StoreContext, planId: string): void {
  withRaw(context, (db) => {
    db.prepare("update execution_plans set coordination_json = ? where workflow_id = ? and plan_id = ?").run(
      JSON.stringify({
        prepared: {
          assignment_path: join(context.harnessDir, "assignments", `${planId}.md`),
          assignment_sha256: "a".repeat(64),
          plan_sha256: "b".repeat(64),
          qa_gate: "mandatory",
          findings_cleanup: "allow-residual",
          prepared_by: COORDINATOR_ID,
          prepared_at: TS,
        },
      }),
      WORKFLOW_ID,
      planId,
    );
    const row = db
      .prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?")
      .get(WORKFLOW_ID, planId) as { state_json?: unknown } | undefined;
    const state = JSON.parse(String(row?.state_json)) as Record<string, unknown>;
    state.metadata = {
      worktree_path: join(context.harnessDir, "worktrees", planId),
      working_branch: `feature/${planId}`,
    };
    db.prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?").run(
      JSON.stringify(state),
      WORKFLOW_ID,
      planId,
    );
  });
}

/**
 * Everything a reconstruction or a refusal must leave untouched: the durable
 * session/lease/operation rows with their own revisions and `bound_at`
 * timestamps, plus the three authority revisions (A09/A16).
 */
function footprint(context: StoreContext): Record<string, unknown> {
  const [row] = rawRows<Record<string, unknown>>(
    context,
    "select (select revision from execution_meta where id = 1) as root_revision, " +
      "(select revision from store_meta where id = 1) as store_revision, " +
      `(select revision from execution_workflows where workflow_id = '${WORKFLOW_ID}') as workflow_revision, ` +
      "(select count(*) from execution_operations) as operations, " +
      "(select count(*) from execution_leases) as leases, " +
      "(select group_concat(workflow_id || '/' || role || '/' || session_id || '=' || state || '@' || epoch || '#' || revision || " +
      "'~' || bound_at, '|') from execution_sessions) as sessions",
  );
  return row;
}

/**
 * One real ACTIVE authority with a running lifecycle, a bound coordinator and a
 * bound plan-pm of `p-1` (the plan scope a foreign holder can occupy).
 */
async function sessionFixture(label: string): Promise<Fixture> {
  const harnessDir = realpathSync(mkdtempSync(join(ROOT, `${label}-`)));
  mkdirSync(harnessDir, { recursive: true });
  const context: StoreContext = { harnessDir };
  const store = await initializeStore(context);
  store.close();
  const initialized = await initializeExecutionAuthority(context);
  const coordinatorCaller = caller(COORDINATOR_ID, "coordinator", null);
  const created = await createExecutionWorkflow(domainContext(context, coordinatorCaller), {
    entry: { id: WORKFLOW_ID, type: "plan", started_at: TS, dir: `workflows/${WORKFLOW_ID}` } as never,
    snapshot: {
      schema_version: 1,
      id: WORKFLOW_ID,
      type: "plan",
      status: "running",
      started_at: TS,
      updated_at: TS,
      phase: "phase-1-prepare",
      project: "harness",
      compass_ref: "iterations/iter-20260101-fixture/delivery-compass.md",
      delivery_kind: "development",
      branch: { base: "main", source: `feature/${PLAN_ID}`, target: "main", integration: `integration/${WORKFLOW_ID}` },
      integration_worktree_path: join(harnessDir, "wt-integration"),
      execution_policy: { plan_parallelism: "serial", worktree_mode: "required" },
      plans: [
        { id: PLAN_ID, title: `${PLAN_ID} title`, file: `plans/${PLAN_ID}.md`, status: "Todo" },
        { id: OTHER_PLAN_ID, title: `${OTHER_PLAN_ID} title`, file: `plans/${OTHER_PLAN_ID}.md`, status: "Todo" },
      ],
    } as never,
    expected: initialized.token,
    operationId: `create-${label}`,
  });
  const workflow = created.data.workflows.find((candidate) => candidate.state.id === WORKFLOW_ID);
  if (workflow === undefined) throw new Error("fixture: the created workflow is not registered");
  const coordinatorBind = { expected: workflow.workflowToken, operationId: `bind-coordinator-${label}` };
  const coordinator = await bindExecutionSession(domainContext(context, coordinatorCaller), {
    workflowId: WORKFLOW_ID,
    planId: null,
    role: "coordinator",
    ...coordinatorBind,
  });
  preparePlanRow(context, PLAN_ID);
  const planPmCaller = caller(PLAN_PM_ID, "plan-pm", PLAN_ID);
  const planPm = await bindExecutionSession(domainContext(context, planPmCaller), {
    workflowId: WORKFLOW_ID,
    planId: PLAN_ID,
    role: "plan-pm",
    expected: workflow.planTokens[PLAN_ID],
    operationId: `bind-plan-${label}`,
  });
  return {
    context,
    storeId: created.storeId,
    epoch: created.epoch,
    coordinator,
    coordinatorCaller,
    coordinatorBind,
    planPm,
    planPmCaller,
  };
}

describe("execution session recovery (S2/E03)", () => {
  test("reconstructs the caller's own reference from the durable row (A15 missing projection)", async () => {
    const fixture = await sessionFixture("missing-projection");
    const before = footprint(fixture.context);
    /** The session envelope the host lost: only the store's own row is left. */
    const reconstructed = await resumeExecutionSession(domainContext(fixture.context, fixture.coordinatorCaller));
    expect(reconstructed.data).toEqual(fixture.coordinator.data);
    expect(reconstructed.token).toBe(fixture.coordinator.token);
    expect({ storeId: reconstructed.storeId, epoch: reconstructed.epoch }).toEqual({
      storeId: fixture.storeId,
      epoch: fixture.epoch,
    });
    // An ORDINARY operation runs on the reconstructed reference: the plan-pm
    // scope reconstructs the same way, both pass the commit-time guard, and the
    // reconstructed coordinator reads the plan row.
    const planPm = await resumeExecutionSession(domainContext(fixture.context, fixture.planPmCaller));
    expect(planPm.data).toEqual(fixture.planPm.data);
    expect(planPm.token).toBe(fixture.planPm.token);
    const resumed = await resumeExecutionSession(domainContext(fixture.context, fixture.coordinatorCaller), reconstructed.data);
    expect(resumed.data).toEqual(fixture.coordinator.data);
    expect(resumed.token).toBe(reconstructed.token);
    assertExecutionSessionCurrent(domainContext(fixture.context, fixture.coordinatorCaller), reconstructed.data);
    const plan = await readExecutionPlan(domainContext(fixture.context, fixture.coordinatorCaller), reconstructed.data, PLAN_ID);
    expect(plan.data.plan).toMatchObject({ id: PLAN_ID });
    expect(plan.data.session).toMatchObject({ sessionId: PLAN_PM_ID });
    // Reconstruction is a READ: no claim, identity, timestamp or revision moved.
    expect(footprint(fixture.context)).toEqual(before);
  });

  test("resumes the same identity after a lost response without a new claim or identity (A09)", async () => {
    const fixture = await sessionFixture("lost-response");
    const before = footprint(fixture.context);
    const first = await resumeExecutionSession(domainContext(fixture.context, fixture.coordinatorCaller));
    const second = await resumeExecutionSession(domainContext(fixture.context, fixture.coordinatorCaller));
    expect(second).toEqual(first);
    expect(second.data.sessionId).toBe(fixture.coordinator.data.sessionId);
    // The lost response is retried with its own operation id: the store serves
    // the RECORDED receipt, so the retry creates no second session, identity,
    // claim or timestamp.
    const retried = await bindExecutionSession(domainContext(fixture.context, fixture.coordinatorCaller), {
      workflowId: WORKFLOW_ID,
      planId: null,
      role: "coordinator",
      ...fixture.coordinatorBind,
    });
    expect(retried.replayed).toBe(true);
    expect(retried.data).toEqual(fixture.coordinator.data);
    expect(retried.token).toBe(fixture.coordinator.token);
    expect(footprint(fixture.context)).toEqual(before);
    expect(rawRows<{ session_id: string }>(fixture.context, "select session_id from execution_sessions")).toHaveLength(2);
  });

  test("withholds only the caller's own binding while a foreign holder owns the scope (A16 foreign holder)", async () => {
    const fixture = await sessionFixture("foreign-holder");
    const before = footprint(fixture.context);
    const foreignPlanPm = caller(FOREIGN_PLAN_PM_ID, "plan-pm", PLAN_ID);
    const refusal = await refusalOf(() => resumeExecutionSession(domainContext(fixture.context, foreignPlanPm)));
    expect(refusal.code).toBe("coordination.duplicate-holder");
    expect(refusal.details).toMatchObject({ holder: PLAN_PM_ID, workflow_id: WORKFLOW_ID, role: "plan-pm" });
    // ONE decision, not a token/field collection: the refusal names the live
    // holder, the single fact that would release the scope, and the effect it
    // withheld.
    expect(refusal.recovery).toMatchObject({ outcome: "unresolved", commitState: "none", applied: [] });
    expect(refusal.recovery.unresolved).toHaveLength(1);
    const problem = refusal.recovery.unresolved[0];
    expect(problem).toMatchObject({ component: "session", path: "session", code: "coordination.duplicate-holder" });
    expect(problem.needed).toContain(PLAN_PM_ID);
    expect(problem.withheldEffect).toContain("own session binding");
    // The foreign holder is left exactly where it was, and keeps working.
    expect(footprint(fixture.context)).toEqual(before);
    const holder = await resumeExecutionSession(domainContext(fixture.context, fixture.planPmCaller), fixture.planPm.data);
    expect(holder.data).toEqual(fixture.planPm.data);
    expect(holder.data.sessionId).toBe(PLAN_PM_ID);
    // Only the conflicting ownership effect was withheld: reads continue, and
    // an unrelated scope (another plan row, the whole workflow) stays readable.
    const coordinator = await resumeExecutionSession(domainContext(fixture.context, fixture.coordinatorCaller));
    expect(coordinator.data.sessionId).toBe(COORDINATOR_ID);
    const other = await readExecutionPlan(domainContext(fixture.context, fixture.coordinatorCaller), coordinator.data, OTHER_PLAN_ID);
    expect(other.data.plan).toMatchObject({ id: OTHER_PLAN_ID, status: "Todo" });
    const state: ExecutionState = (await readExecutionState(fixture.context)).data;
    expect(state.workflows.map((entry) => entry.state.id)).toEqual([WORKFLOW_ID]);
    const unbound = await refusalOf(() =>
      resumeExecutionSession(domainContext(fixture.context, caller("host-plan-unbound", "plan-pm", OTHER_PLAN_ID))),
    );
    expect(unbound.code).toBe("coordination.session-not-found");
    expect(unbound.recovery.unresolved[0].needed).toContain("host-plan-unbound");
    const foreignCoordinator = caller(FOREIGN_COORDINATOR_ID, "coordinator", null);
    const coordinatorRefusal = await refusalOf(() => resumeExecutionSession(domainContext(fixture.context, foreignCoordinator)));
    expect(coordinatorRefusal.details).toMatchObject({ holder: COORDINATOR_ID, workflow_id: WORKFLOW_ID, role: "coordinator" });
    // Still nothing was written by any refusal.
    expect(footprint(fixture.context)).toEqual(before);
    // A row this store still records but no longer honors is its precise
    // stored-state verdict — never a takeover by another name.
    withRaw(fixture.context, (db) => {
      db.prepare("update execution_sessions set state = 'revoked' where session_id = ?").run(PLAN_PM_ID);
    });
    await expect(resumeExecutionSession(domainContext(fixture.context, fixture.planPmCaller))).rejects.toMatchObject({
      code: "execution.session-unavailable",
    });
  });
});
