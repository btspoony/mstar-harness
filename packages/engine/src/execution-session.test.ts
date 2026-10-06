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
 * One execution role survives: the workflow coordinator. A plan is an explicit
 * operation address, never an identity member, so nothing here binds or reads a
 * plan-scoped session.
 *
 * The consumer-visible contract asserted here:
 * - the wire form is canonical and adds no authority;
 * - a lost session envelope is not a lost binding: the caller's OWN reference
 *   is reconstructed from the durable row, an ordinary operation runs on it,
 *   and the reconstruction writes nothing (A09/A15);
 * - the workflow's single coordinator holder is never taken over by this path:
 *   a foreign caller is refused, its refusal names what is missing, and reads
 *   of every other scope continue (A16).
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
    // A plan-scoped spelling is no longer a reference at all.
    const planScoped = `exec-session-v1:${Buffer.from(JSON.stringify({ ...ref, planId: "p-1" }), "utf8").toString("base64url")}`;
    expect(() => decodeExecutionSessionRef(planScoped)).toThrow();
    expect(() => decodeExecutionSessionRef("exec-session-v1:eyJzdG9yZUlkIjoiYSJ9")).toThrow();
  });

  test("mints a local id once and keeps the workflow-wide role scope", () => {
    const first = createLocalExecutionIdentity({ workflowId: "workflow-1", role: "coordinator" });
    const second = createLocalExecutionIdentity({ workflowId: "workflow-1", role: "coordinator" });
    expect(first.source).toBe("local");
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(executionContextFor({ harnessDir: "/tmp/harness" }, first).caller).toMatchObject({
      sessionId: first.sessionId,
      workflowId: "workflow-1",
      role: "coordinator",
    });
  });

  test("refuses a foreign caller before any store read", async () => {
    const identity = createLocalExecutionIdentity({ workflowId: "workflow-1", role: "coordinator" });
    const context = executionContextFor({ harnessDir: "/tmp/harness" }, identity);
    await expect(
      resumeExecutionSession({ ...context, caller: { ...context.caller, sessionId: "foreign-session" } }, ref),
    ).rejects.toMatchObject({ code: "execution.scope-mismatch" });
    await expect(
      resumeExecutionSession({ ...context, caller: { ...context.caller, workflowId: "workflow-elsewhere" } }, ref),
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
const FOREIGN_COORDINATOR_ID = "host-coord-elsewhere";

type Fixture = {
  context: StoreContext;
  storeId: string;
  epoch: number;
  /** The coordinator receipt the fixture bound; its reference is a projection of the durable row. */
  coordinator: ExecutionReceipt<ExecutionSessionRef>;
  coordinatorCaller: ExecutionCaller;
  /** The exact request an identical retry of that bind must present. */
  coordinatorBind: { expected: ExecutionToken; operationId: string };
};

function caller(sessionId: string): ExecutionCaller {
  return { sessionId, workflowId: WORKFLOW_ID, role: "coordinator" };
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
 * Everything a reconstruction or a refusal must leave untouched: the durable
 * session/operation rows with their own revisions and `bound_at` timestamps,
 * plus the authority revisions (A09/A16). The per-plan lease table no longer
 * exists, so the footprint reads what remains.
 */
function footprint(context: StoreContext): Record<string, unknown> {
  const [row] = rawRows<Record<string, unknown>>(
    context,
    "select (select revision from execution_meta where id = 1) as root_revision, " +
      "(select revision from store_meta where id = 1) as store_revision, " +
      `(select revision from execution_workflows where workflow_id = '${WORKFLOW_ID}') as workflow_revision, ` +
      "(select count(*) from execution_operations) as operations, " +
      "(select group_concat(workflow_id || '/' || role || '/' || session_id || '=' || state || '@' || epoch || '#' || revision || " +
      "'~' || bound_at, '|') from execution_sessions) as sessions",
  );
  return row;
}

/** One real ACTIVE authority with a running lifecycle and its bound coordinator. */
async function sessionFixture(label: string): Promise<Fixture> {
  const harnessDir = realpathSync(mkdtempSync(join(ROOT, `${label}-`)));
  mkdirSync(harnessDir, { recursive: true });
  const context: StoreContext = { harnessDir };
  const store = await initializeStore(context);
  store.close();
  const initialized = await initializeExecutionAuthority(context);
  const coordinatorCaller = caller(COORDINATOR_ID);
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
    ...coordinatorBind,
  });
  return {
    context,
    storeId: created.storeId,
    epoch: created.epoch,
    coordinator,
    coordinatorCaller,
    coordinatorBind,
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
    // An ORDINARY operation runs on the reconstructed reference: the guard
    // accepts it and the reconstructed coordinator reads any plan of its own
    // workflow — plans are addresses, not a scope the identity carries.
    const resumed = await resumeExecutionSession(domainContext(fixture.context, fixture.coordinatorCaller), reconstructed.data);
    expect(resumed.data).toEqual(fixture.coordinator.data);
    expect(resumed.token).toBe(reconstructed.token);
    assertExecutionSessionCurrent(domainContext(fixture.context, fixture.coordinatorCaller), reconstructed.data);
    const plan = await readExecutionPlan(domainContext(fixture.context, fixture.coordinatorCaller), reconstructed.data, PLAN_ID);
    expect(plan.data.plan).toMatchObject({ id: PLAN_ID });
    const other = await readExecutionPlan(domainContext(fixture.context, fixture.coordinatorCaller), reconstructed.data, OTHER_PLAN_ID);
    expect(other.data.plan).toMatchObject({ id: OTHER_PLAN_ID });
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
    // the RECORDED receipt, so the retry creates no second session, identity or
    // timestamp.
    const retried = await bindExecutionSession(domainContext(fixture.context, fixture.coordinatorCaller), {
      workflowId: WORKFLOW_ID,
      ...fixture.coordinatorBind,
    });
    expect(retried.replayed).toBe(true);
    expect(retried.data).toEqual(fixture.coordinator.data);
    expect(retried.token).toBe(fixture.coordinator.token);
    expect(footprint(fixture.context)).toEqual(before);
    expect(rawRows<{ session_id: string }>(fixture.context, "select session_id from execution_sessions")).toHaveLength(1);
  });

  test("withholds only the caller's own binding while the workflow's coordinator holder is live (A16 foreign holder)", async () => {
    const fixture = await sessionFixture("foreign-holder");
    const before = footprint(fixture.context);
    // A foreign coordinator session id names a binding this store does not
    // hold: the reconstruction refuses instead of adopting the live holder.
    const foreign = await refusalOf(() => resumeExecutionSession(domainContext(fixture.context, caller(FOREIGN_COORDINATOR_ID))));
    expect(foreign.code).toBe("coordination.identity-mismatch");
    expect(foreign.details).toMatchObject({ workflow_id: WORKFLOW_ID, role: "coordinator" });
    expect(foreign.recovery).toMatchObject({ outcome: "unresolved", commitState: "none", applied: [] });
    expect(foreign.recovery.unresolved).toHaveLength(1);
    expect(foreign.recovery.unresolved[0]).toMatchObject({ component: "session", path: "session" });
    expect(foreign.recovery.unresolved[0]?.needed).toContain(FOREIGN_COORDINATOR_ID);
    // The holder is left exactly where it was, and keeps working.
    expect(footprint(fixture.context)).toEqual(before);
    const holder = await resumeExecutionSession(domainContext(fixture.context, fixture.coordinatorCaller), fixture.coordinator.data);
    expect(holder.data).toEqual(fixture.coordinator.data);
    expect(holder.data.sessionId).toBe(COORDINATOR_ID);
    // Only the conflicting ownership effect was withheld: reads continue, and
    // every plan row of the workflow stays readable to its own coordinator.
    const other = await readExecutionPlan(domainContext(fixture.context, fixture.coordinatorCaller), holder.data, OTHER_PLAN_ID);
    expect(other.data.plan).toMatchObject({ id: OTHER_PLAN_ID, status: "Todo" });
    const state: ExecutionState = (await readExecutionState(fixture.context)).data;
    expect(state.workflows.map((entry) => entry.state.id)).toEqual([WORKFLOW_ID]);
    // Still nothing was written by any refusal.
    expect(footprint(fixture.context)).toEqual(before);
    // A row this store still records but no longer honors is its precise
    // stored-state verdict — never a takeover by another name.
    withRaw(fixture.context, (db) => {
      db.prepare("update execution_sessions set state = 'revoked' where session_id = ?").run(COORDINATOR_ID);
    });
    await expect(resumeExecutionSession(domainContext(fixture.context, fixture.coordinatorCaller))).rejects.toMatchObject({
      code: "execution.session-unavailable",
    });
  });
});
