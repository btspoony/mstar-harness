/**
 * execution-coordination — the DB plan-operation authorization boundary
 * (primary spec §2.3/§3/§4.1).
 *
 * Run with
 * `bun test packages/engine/test/execution-coordination.test.ts --test-name-pattern 'execution-authority-boundary'`.
 *
 * Every fixture lives in its own temporary control root created by
 * `mkdtempSync`; no test reads or writes this checkout's `store.db`. The planted
 * legacy session envelope is there to prove the DB authorization context is
 * identities and revisions only: a session file is neither an authority nor an
 * output of a DB plan operation.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCatalogEntity, updateCatalogEntity } from "../src/catalog.js";
import {
  prepareExecutionPlan,
  progressExecutionPlan,
  withExecutionPlanAuthority,
  type ExecutionPlanCall,
} from "../src/execution-coordination.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  executionToken,
  initializeExecutionAuthority,
  readExecutionPlan,
  readExecutionState,
  serializeExecutionValue,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionPlanView,
  type ExecutionPlanWitness,
  type ExecutionSessionRef,
  type ExecutionToken,
} from "../src/execution-store.js";
import { initializeStore, storeDbPath, type StoreContext, type StoreDb } from "../src/store-db.js";
import type { WorkflowEntry } from "../src/status.js";
import type { WorkflowSnapshot } from "../src/workflow.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-coordination-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const TS = "2026-01-02T03:04:05.000Z";
const WORKFLOW_ID = "wf-1";
const OWN_PLAN = "p-1";
const PEER_PLAN = "p-2";
/** A sibling scope no W2 operation touches: an eligible, unprepared row. */
const SPARE_PLAN = "p-3";
const COORDINATOR_ID = "host-coord";
const PLAN_PM_ID = "host-pm";

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

/** §3 the trusted caller a domain verb authorizes against. */
function trustedCaller(sessionId: string, role: "coordinator" | "plan-pm", planId: string | null): ExecutionCaller {
  return { sessionId, role, workflowId: WORKFLOW_ID, planId };
}

function domainContext(context: StoreContext, who: ExecutionCaller): ExecutionContext {
  return { harnessDir: context.harnessDir, caller: who };
}

/** The store's own path: the store resolves its harness root from the context. */
function storePath(context: StoreContext): string {
  return storeDbPath(context);
}

/** Run one raw fixture read/write directly against the store's own DB file. */
function withRaw<T>(context: StoreContext, body: (db: StoreDb) => T): T {
  const db = new DatabaseSync(storePath(context));
  try {
    return body(db as unknown as StoreDb);
  } finally {
    db.close();
  }
}

function rows(context: StoreContext, sql: string): Array<Record<string, unknown>> {
  return withRaw(context, (db) => db.prepare(sql).all() as Array<Record<string, unknown>>);
}

/**
 * The accepted state a refusal must leave untouched, as one comparable value:
 * the three revisions plus the rows an operation would add.
 */
function footprint(context: StoreContext): Record<string, unknown> {
  const [row] = rows(
    context,
    "select (select revision from execution_meta where id = 1) as root_revision, " +
      "(select revision from store_meta where id = 1) as store_revision, " +
      `(select revision from execution_plans where plan_id = '${OWN_PLAN}') as own_plan_revision, ` +
      `(select revision from execution_plans where plan_id = '${PEER_PLAN}') as peer_plan_revision, ` +
      "(select count(*) as n from execution_operations) as operations, " +
      "(select count(*) as n from execution_leases) as leases",
  );
  return row;
}

/** A catalog plan entity, registered through the real catalog verb. */
async function registerPlan(context: StoreContext, planId: string): Promise<void> {
  await registerCatalogEntity(
    context,
    { kind: "plan", id: planId, title: `${planId} title`, rootKind: "plans", relativePath: `plans/${planId}.md` },
    { operationId: `register-${planId}`, actor: "execution-coordination.test" },
  );
}

/**
 * The prepared state a DB `prepare` will write: there is no DB prepare verb yet,
 * so the fixture records the prepared block and the plan's own worktree/branch
 * metadata directly — the same anchors the legacy route records on a plan row.
 * Neither write moves the row revision, so the token creation minted still binds.
 */
function preparePlanRow(context: StoreContext, planId: string, branch: string): void {
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
    const [stored] = db
      .prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?")
      .all(WORKFLOW_ID, planId) as Array<{ state_json?: unknown }>;
    const state = JSON.parse(String(stored.state_json)) as Record<string, unknown>;
    state.metadata = {
      worktree_path: join(context.harnessDir, "worktrees", planId),
      working_branch: branch,
      track_branches: [branch],
    };
    db.prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?").run(
      JSON.stringify(state),
      WORKFLOW_ID,
      planId,
    );
  });
}

/**
 * A valid legacy session envelope at the exact path the JSON route writes.
 * Nothing in the DB authority reads it: it is planted to prove a session file is
 * neither consulted nor written by a DB plan operation.
 */
function plantEnvelope(context: StoreContext, role: string, sessionId: string): string {
  const dir = join(context.harnessDir, "workflows", WORKFLOW_ID, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${role}-${sessionId}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      { schema_version: 1, role, session_id: sessionId, workflow_id: WORKFLOW_ID, harness_root: context.harnessDir },
      null,
      2,
    )}\n`,
  );
  return file;
}

type Fixture = {
  context: StoreContext;
  epoch: number;
  /** The plan tokens of the accepted state, after both seats bound. */
  planTokens: Record<string, ExecutionToken>;
  /** The plan token creation minted — superseded by the plan bind. */
  stalePlanToken: ExecutionToken;
  coordinator: ExecutionSessionRef;
  planPm: ExecutionSessionRef;
  coordinatorCaller: ExecutionCaller;
  planPmCaller: ExecutionCaller;
};

/**
 * An active store with ONE running workflow (`wf-1`). Plan `p-1` is prepared
 * with its own worktree/branch scope and bound to its plan-pm session, and the
 * workflow carries its bound coordinator session; `p-2` is prepared-unbound, so
 * a sibling scope has a real row to be refused.
 */
async function seededWorkflow(label: string): Promise<Fixture> {
  const context: StoreContext = { harnessDir: mkdtempSync(join(ROOT, `${label}-`)) };
  const store = await initializeStore(context);
  store.close();
  const initialized = await initializeExecutionAuthority(context);
  await registerPlan(context, OWN_PLAN);
  await registerPlan(context, PEER_PLAN);
  const coordinatorCaller = trustedCaller(COORDINATOR_ID, "coordinator", null);
  const created = await createExecutionWorkflow(domainContext(context, coordinatorCaller), {
    entry: { id: WORKFLOW_ID, type: "plan", started_at: TS, dir: `workflows/${WORKFLOW_ID}` } as WorkflowEntry,
    snapshot: {
      schema_version: 1,
      id: WORKFLOW_ID,
      type: "plan",
      status: "running",
      started_at: TS,
      updated_at: TS,
      plans: [OWN_PLAN, PEER_PLAN].map((planId) => ({
        id: planId,
        title: `${planId} title`,
        file: `plans/${planId}.md`,
        status: "Todo",
      })),
      delivery_kind: "development",
      branch: { source: `feature/${WORKFLOW_ID}`, target: "main" },
    } as unknown as WorkflowSnapshot,
    expected: initialized.token,
    operationId: `create-${label}`,
  });
  const [workflow] = created.data.workflows;
  const stalePlanToken = workflow.planTokens[OWN_PLAN];
  preparePlanRow(context, OWN_PLAN, `feature/${OWN_PLAN}`);
  preparePlanRow(context, PEER_PLAN, `feature/${PEER_PLAN}`);
  const coordinator = await bindExecutionSession(domainContext(context, coordinatorCaller), {
    workflowId: WORKFLOW_ID,
    planId: null,
    role: "coordinator",
    expected: workflow.workflowToken,
    operationId: `bind-coordinator-${label}`,
  });
  const planPmCaller = trustedCaller(PLAN_PM_ID, "plan-pm", OWN_PLAN);
  const planPm = await bindExecutionSession(domainContext(context, planPmCaller), {
    workflowId: WORKFLOW_ID,
    planId: OWN_PLAN,
    role: "plan-pm",
    expected: stalePlanToken,
    operationId: `bind-plan-${label}`,
  });
  const state = await readExecutionState(context);
  const [current] = state.data.workflows;
  return {
    context,
    epoch: created.epoch,
    planTokens: current.planTokens,
    stalePlanToken,
    coordinator: coordinator.data,
    planPm: planPm.data,
    coordinatorCaller,
    planPmCaller,
  };
}

/* ------------------------------------------------------------------------ *
 * The authorization boundary
 * ------------------------------------------------------------------------ */

describe("execution-authority-boundary: §2.3/§3 DB plan-operation authorization", () => {
  test("refuses a forged caller or role and a sibling plan without running the operation", async () => {
    const fixture = await seededWorkflow("boundary-scope");
    const { context, planTokens, coordinator, planPm, coordinatorCaller, planPmCaller } = fixture;
    const accepted = await readExecutionState(context);
    const before = footprint(context);

    // Every refused call is given a body that WOULD commit: if the boundary ever
    // let one through, the operation row and the plan revision below would show.
    let ran = 0;
    const attempt = (who: ExecutionCaller, call: ExecutionPlanCall): Promise<unknown> =>
      withExecutionPlanAuthority(domainContext(context, who), call, (witness, tx) => {
        ran += 1;
        tx.db
          .prepare(
            "insert into execution_operations(epoch, operation_id, request_hash, store_id, workflow_id, plan_id, result_json, committed_at) " +
              "values (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(tx.epoch, `leaked-${ran}`, "request-hash", tx.storeId, witness.workflowId, witness.planId, "{}", TS);
        tx.db
          .prepare("update execution_plans set revision = revision + 1 where workflow_id = ? and plan_id = ?")
          .run(witness.workflowId, witness.planId);
        return witness.planId;
      });
    const progress = { kind: "residual-add", entries: [] } as ExecutionPlanCall["operation"];
    const complete = { kind: "complete", handoffId: "handoff-1" } as ExecutionPlanCall["operation"];

    // A coordinator identity presenting a plan-pm session reference.
    await expect(
      attempt(coordinatorCaller, { session: planPm, expected: planTokens[OWN_PLAN], planId: OWN_PLAN, operation: complete }),
    ).rejects.toMatchObject({ code: "coordination.session-role", details: { caller_role: "coordinator", reference_role: "plan-pm" } });
    // A plan session issuing a coordinator-only verb.
    await expect(
      attempt(planPmCaller, { session: planPm, expected: planTokens[OWN_PLAN], planId: OWN_PLAN, operation: complete }),
    ).rejects.toMatchObject({ code: "coordination.session-role", details: { role: "plan-pm", operation: "complete" } });
    // A coordinator session issuing a plan-session verb.
    await expect(
      attempt(coordinatorCaller, { session: coordinator, expected: planTokens[OWN_PLAN], planId: OWN_PLAN, operation: progress }),
    ).rejects.toMatchObject({ code: "coordination.session-role", details: { role: "coordinator", operation: "residual-add" } });
    // A plan session addressing its sibling plan.
    await expect(
      attempt(planPmCaller, { session: planPm, expected: planTokens[PEER_PLAN], planId: PEER_PLAN, operation: progress }),
    ).rejects.toMatchObject({
      code: "coordination.session-mismatch",
      details: { expected: OWN_PLAN, actual: PEER_PLAN },
    });
    // An operation kind the closed union does not carry.
    await expect(
      attempt(planPmCaller, {
        session: planPm,
        expected: planTokens[OWN_PLAN],
        planId: OWN_PLAN,
        operation: { kind: "publish" } as ExecutionPlanCall["operation"],
      }),
    ).rejects.toMatchObject({ code: "coordination.unknown-operation", details: { operation: "publish" } });
    // The legacy delivery-source repair is NOT part of the DB route's §3 union:
    // even the coordinator seat that verb requires cannot reach it here, and the
    // shared file-route set is what still carries it.
    await expect(
      attempt(coordinatorCaller, {
        session: coordinator,
        expected: planTokens[OWN_PLAN],
        planId: OWN_PLAN,
        operation: { kind: "repair-delivery-source", handoffId: "handoff-1" } as ExecutionPlanCall["operation"],
      }),
    ).rejects.toMatchObject({
      code: "coordination.unknown-operation",
      details: { operation: "repair-delivery-source" },
    });

    expect(ran).toBe(0);
    expect(footprint(context)).toEqual(before);
    expect(await readExecutionState(context)).toEqual(accepted);
  });

  test("refuses a revoked, foreign-epoch or foreign-store reference, and reads no session file", async () => {
    const fixture = await seededWorkflow("boundary-reference");
    const { context, epoch, planTokens, planPm, planPmCaller } = fixture;
    const envelope = plantEnvelope(context, "plan-pm", PLAN_PM_ID);
    const envelopeBytes = readFileSync(envelope, "utf8");
    const before = footprint(context);
    let ran = 0;
    const attempt = (session: ExecutionSessionRef): Promise<unknown> =>
      withExecutionPlanAuthority(
        domainContext(context, planPmCaller),
        { session, expected: planTokens[OWN_PLAN], planId: OWN_PLAN, operation: { kind: "residual-add", entries: [] } },
        () => {
          ran += 1;
          return "leaked";
        },
      );

    await expect(attempt({ ...planPm, epoch: epoch - 1 })).rejects.toMatchObject({ code: "store.stale-epoch" });
    await expect(attempt({ ...planPm, storeId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({
      code: "execution.scope-mismatch",
    });
    await expect(attempt({ ...planPm, sessionId: COORDINATOR_ID })).rejects.toMatchObject({
      code: "coordination.session-mismatch",
    });

    // The reference is the binding the store holds: revoking the row ends it,
    // even while a well-formed envelope for the same identity sits on disk.
    withRaw(context, (db) => {
      db.prepare("update execution_sessions set state = 'revoked' where role = 'plan-pm'").run();
    });
    await expect(attempt(planPm)).rejects.toMatchObject({ code: "execution.session-unavailable" });

    expect(ran).toBe(0);
    expect(footprint(context)).toEqual(before);
    expect(readFileSync(envelope, "utf8")).toBe(envelopeBytes);
  });

  test("refuses a nested plan operation on the same store and commits only the outer one", async () => {
    const fixture = await seededWorkflow("boundary-reentrant");
    const { context, planTokens, coordinator, planPm, coordinatorCaller, planPmCaller } = fixture;
    const before = footprint(context);
    let ran = 0;
    let nested: { code?: string } | string | undefined;

    const outcome = await withExecutionPlanAuthority(
      domainContext(context, coordinatorCaller),
      { session: coordinator, expected: planTokens[OWN_PLAN], planId: OWN_PLAN, operation: { kind: "accept", handoffId: "handoff-1" } },
      (witness, tx) => {
        // A domain operation owns exactly ONE transaction: the nested call is
        // refused before it opens a second handle. Its rejection is handled
        // here so the outer operation still commits its own work.
        nested = withExecutionPlanAuthority(
          domainContext(context, planPmCaller),
          { session: planPm, expected: planTokens[OWN_PLAN], planId: OWN_PLAN, operation: { kind: "residual-add", entries: [] } },
          () => {
            ran += 1;
            return "nested";
          },
        ).then(
          () => "leaked",
          (error: unknown) => error as { code?: string },
        );
        tx.db
          .prepare(
            "insert into execution_operations(epoch, operation_id, request_hash, store_id, workflow_id, plan_id, result_json, committed_at) " +
              "values (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(tx.epoch, "accept-handoff-1", "request-hash", tx.storeId, witness.workflowId, witness.planId, "{}", TS);
        return "outer";
      },
    );

    expect(outcome).toBe("outer");
    expect(await nested).toMatchObject({ code: "execution.reentrant" });
    expect(ran).toBe(0);
    // The outer operation committed exactly its own receipt; the refused nested
    // call moved no revision and wrote no row of its own.
    expect(footprint(context)).toEqual({ ...before, operations: (before.operations as number) + 1 });
  });

  test("authorizes the caller's own plan against its exact token and commits the transition with it", async () => {
    const fixture = await seededWorkflow("boundary-authorized");
    const { context, planTokens, stalePlanToken, coordinator, coordinatorCaller, planPm, planPmCaller } = fixture;
    // The token a caller presents is the one the session-authorized read serves.
    const read = await readExecutionPlan(domainContext(context, planPmCaller), planPm, OWN_PLAN);
    expect(read.token).toBe(planTokens[OWN_PLAN]);
    const before = footprint(context);
    let seen: ExecutionPlanWitness | undefined;

    const outcome = await withExecutionPlanAuthority(
      domainContext(context, coordinatorCaller),
      { session: coordinator, expected: read.token, planId: OWN_PLAN, operation: { kind: "accept", handoffId: "handoff-1" } },
      (witness, tx) => {
        seen = witness;
        tx.db
          .prepare(
            "insert into execution_operations(epoch, operation_id, request_hash, store_id, workflow_id, plan_id, result_json, committed_at) " +
              "values (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(tx.epoch, "accept-handoff-1", "request-hash", tx.storeId, witness.workflowId, witness.planId, "{}", TS);
        tx.db
          .prepare("update execution_plans set revision = revision + 1 where workflow_id = ? and plan_id = ?")
          .run(witness.workflowId, witness.planId);
        return "committed";
      },
    );

    expect(outcome).toBe("committed");
    expect(seen).toMatchObject({ workflowId: WORKFLOW_ID, planId: OWN_PLAN, token: read.token, revision: 2 });
    expect(seen?.session).toEqual(coordinator);
    // The witness carries the plan's own scope anchors and its lease, so a
    // transition pins ownership from the authority instead of from a file.
    expect(seen?.view.plan.metadata).toMatchObject({ worktree_path: join(context.harnessDir, "worktrees", OWN_PLAN) });
    expect(seen?.view.executionLease).toMatchObject({ holder_session_id: PLAN_PM_ID, status: "held" });
    expect(seen?.view.coordination?.prepared).toMatchObject({ prepared_by: COORDINATOR_ID });

    // One transaction: the body's receipt and the plan's own advance are visible,
    // and the read serves the advanced revision.
    expect(footprint(context)).toEqual({
      ...before,
      own_plan_revision: (before.own_plan_revision as number) + 1,
      operations: (before.operations as number) + 1,
    });
    expect((await readExecutionPlan(domainContext(context, planPmCaller), planPm, OWN_PLAN)).token).toBe(
      executionToken("plan", read.storeId, read.epoch, [WORKFLOW_ID, OWN_PLAN], 3),
    );

    const accepted = footprint(context);
    // A token the plan bind superseded is a stale CAS, not a re-read.
    await expect(
      withExecutionPlanAuthority(
        domainContext(context, coordinatorCaller),
        { session: coordinator, expected: stalePlanToken, planId: OWN_PLAN, operation: { kind: "accept", handoffId: "handoff-1" } },
        () => "leaked",
      ),
    ).rejects.toMatchObject({ code: "execution.stale-token" });
    expect(footprint(context)).toEqual(accepted);
  });
});

/* ------------------------------------------------------------------------ *
 * W2 — `prepare` and `progress` on the DB authority
 * ------------------------------------------------------------------------ */

/** One plan documents a DB `prepare` seals: the Assignment and its plan file. */
type PlanDocuments = { assignmentPath: string; planPath: string };

/**
 * Write a real reviewed Assignment (the C1 header block `parseAssignmentFile`
 * admits) and the plan markdown it pins, both inside one fixture's control
 * harness. `overrides` lets a case seal a document that names another plan,
 * workflow or harness.
 */
function writePlanDocuments(
  harnessRoot: string,
  planId: string,
  branch: string,
  overrides: Record<string, string> = {},
): PlanDocuments {
  const planDir = join(harnessRoot, "plans");
  const sddDir = join(harnessRoot, "sdd", planId);
  const worktreeDir = join(harnessRoot, "worktrees", planId);
  mkdirSync(planDir, { recursive: true });
  mkdirSync(sddDir, { recursive: true });
  const planPath = join(planDir, `${planId}.md`);
  writeFileSync(planPath, `# ${planId}\n`);
  const headers: Record<string, string> = {
    "Execution scope": "plan",
    "Execute as": "project-manager",
    Delegation: "allowed",
    "Control harness root": harnessRoot,
    "Workflow id": WORKFLOW_ID,
    "Plan id": planId,
    "Plan Path": planPath,
    "Worktree path": worktreeDir,
    "Working branch": branch,
    "SDD dir": sddDir,
    "QA gate": "mandatory",
    "Findings cleanup": "allow-residual",
    "Prepare gate": "go",
    ...overrides,
  };
  const assignmentPath = join(harnessRoot, "assignments", `${planId}.md`);
  mkdirSync(dirname(assignmentPath), { recursive: true });
  writeFileSync(
    assignmentPath,
    `${Object.entries(headers)
      .map(([header, value]) => `**${header}**: ${value}`)
      .join("\n")}\n`,
  );
  return { assignmentPath, planPath };
}

type LiveFixture = {
  context: StoreContext;
  harnessRoot: string;
  storeId: string;
  epoch: number;
  /** The plan tokens of the accepted state — before any W2 operation ran. */
  planTokens: Record<string, ExecutionToken>;
  coordinator: ExecutionSessionRef;
  coordinatorCaller: ExecutionCaller;
  documents: Record<string, PlanDocuments>;
};

/**
 * An active store with ONE running workflow (`wf-1`) whose two plans are
 * UNPREPARED: `p-1` is the plan the W2 operations address, `p-2` is a real
 * sibling scope to refuse. Both carry a reviewed Assignment on disk, so the DB
 * `prepare` runs the real seal rather than a fixture-written one.
 */
async function liveWorkflow(label: string): Promise<LiveFixture> {
  // The workspace root carries the `.mstar` harness the store resolves to, so
  // adding the harness's own `plans/` child never relocates the store — the
  // same shape a real control harness has.
  const workspace = mkdtempSync(join(ROOT, `${label}-`));
  const harnessRoot = join(workspace, ".mstar");
  mkdirSync(harnessRoot, { recursive: true });
  const context: StoreContext = { harnessDir: workspace };
  const store = await initializeStore(context);
  store.close();
  const initialized = await initializeExecutionAuthority(context);
  await registerPlan(context, OWN_PLAN);
  await registerPlan(context, PEER_PLAN);
  await registerPlan(context, SPARE_PLAN);
  const coordinatorCaller = trustedCaller(COORDINATOR_ID, "coordinator", null);
  const created = await createExecutionWorkflow(domainContext(context, coordinatorCaller), {
    entry: { id: WORKFLOW_ID, type: "plan", started_at: TS, dir: `workflows/${WORKFLOW_ID}` } as WorkflowEntry,
    snapshot: {
      schema_version: 1,
      id: WORKFLOW_ID,
      type: "plan",
      status: "running",
      started_at: TS,
      updated_at: TS,
      plans: [OWN_PLAN, PEER_PLAN, SPARE_PLAN].map((planId) => ({
        id: planId,
        title: `${planId} title`,
        file: `plans/${planId}.md`,
        status: "Todo",
      })),
      delivery_kind: "development",
      branch: { source: `feature/${WORKFLOW_ID}`, target: "main" },
    } as unknown as WorkflowSnapshot,
    expected: initialized.token,
    operationId: `create-${label}`,
  });
  const [workflow] = created.data.workflows;
  const coordinator = await bindExecutionSession(domainContext(context, coordinatorCaller), {
    workflowId: WORKFLOW_ID,
    planId: null,
    role: "coordinator",
    expected: workflow.workflowToken,
    operationId: `bind-coordinator-${label}`,
  });
  const documents: Record<string, PlanDocuments> = {
    [OWN_PLAN]: writePlanDocuments(harnessRoot, OWN_PLAN, `feature/${OWN_PLAN}`),
    [PEER_PLAN]: writePlanDocuments(harnessRoot, PEER_PLAN, `feature/${PEER_PLAN}`),
    [SPARE_PLAN]: writePlanDocuments(harnessRoot, SPARE_PLAN, `feature/${SPARE_PLAN}`),
  };
  const state = await readExecutionState(context);
  const [current] = state.data.workflows;
  return {
    context,
    harnessRoot: realpathSync(harnessRoot),
    storeId: created.storeId,
    epoch: created.epoch,
    planTokens: current.planTokens,
    coordinator: coordinator.data,
    coordinatorCaller,
    documents,
  };
}

/** The plan token the session-authorized read serves right now (the CAS). */
async function planTokenOf(fixture: LiveFixture, planId: string): Promise<ExecutionToken> {
  const read = await readExecutionPlan(
    domainContext(fixture.context, fixture.coordinatorCaller),
    fixture.coordinator,
    planId,
  );
  return read.token;
}

/** A coordinator `prepare` for one plan, against the token read right now. */
function prepareCall(
  fixture: LiveFixture,
  planId: string,
  operationId: string,
  expected: ExecutionToken,
  assignmentPath = fixture.documents[planId]!.assignmentPath,
) {
  return prepareExecutionPlan(domainContext(fixture.context, fixture.coordinatorCaller), {
    operationId,
    session: fixture.coordinator,
    expected,
    planId,
    operation: { kind: "prepare", assignmentPath },
  });
}

/**
 * Everything a plan operation may touch, as one comparable value: the three
 * revisions plus the addressed plan's two stored blocks and its sealed frozen
 * input, the operation/session/lease rows and the root revision.
 */
function planFootprint(context: StoreContext, planId: string): Record<string, unknown> {
  const [row] = rows(
    context,
    "select (select revision from execution_meta where id = 1) as root_revision, " +
      "(select revision from store_meta where id = 1) as store_revision, " +
      `(select revision from execution_workflows where workflow_id = '${WORKFLOW_ID}') as workflow_revision, ` +
      `(select revision from execution_plans where plan_id = '${planId}') as plan_revision, ` +
      `(select state_json from execution_plans where plan_id = '${planId}') as plan_state, ` +
      `(select coordination_json from execution_plans where plan_id = '${planId}') as plan_coordination, ` +
      `(select revision from execution_inputs where plan_id = '${planId}') as input_revision, ` +
      `(select input_json from execution_inputs where plan_id = '${planId}') as input_json, ` +
      `(select input_hash from execution_inputs where plan_id = '${planId}') as input_hash, ` +
      `(select catalog_pin_json from execution_inputs where plan_id = '${planId}') as catalog_pin, ` +
      `(select lease_json from execution_leases where plan_id = '${planId}') as own_lease, ` +
      "(select count(*) as n from execution_operations) as operations, " +
      "(select count(*) as n from execution_sessions) as sessions, " +
      "(select count(*) as n from execution_leases) as leases",
  );
  return row!;
}

function parsedJson(value: unknown): Record<string, unknown> {
  return JSON.parse(String(value)) as Record<string, unknown>;
}

/** Bind the plan-pm session of `planId` and return its reference. */
async function bindPlanPm(fixture: LiveFixture, planId: string, label: string): Promise<ExecutionSessionRef> {
  const expected = await planTokenOf(fixture, planId);
  const planPmCaller = trustedCaller(PLAN_PM_ID, "plan-pm", planId);
  const bound = await bindExecutionSession(domainContext(fixture.context, planPmCaller), {
    workflowId: WORKFLOW_ID,
    planId,
    role: "plan-pm",
    expected,
    operationId: `bind-plan-${label}`,
  });
  return bound.data;
}

async function refusalOf(work: () => Promise<unknown>): Promise<{ code?: string; details?: Record<string, unknown> }> {
  try {
    await work();
    throw new Error("expected a refusal");
  } catch (error) {
    return error as { code?: string; details?: Record<string, unknown> };
  }
}

describe("execution-prepare-progress: §3/§4.1 DB prepare and progress", () => {
  test("prepare seals the reviewed Assignment, records the plan anchors and replays exactly", async () => {
    const fixture = await liveWorkflow("prepare-seal");
    const { context, coordinatorCaller, coordinator, documents, planTokens } = fixture;
    const harness = fixture.harnessRoot;
    const own = documents[OWN_PLAN]!;
    const before = planFootprint(context, OWN_PLAN);

    const receipt = await prepareExecutionPlan(domainContext(context, coordinatorCaller), {
      operationId: "prepare-1",
      session: coordinator,
      expected: planTokens[OWN_PLAN],
      planId: OWN_PLAN,
      operation: { kind: "prepare", assignmentPath: own.assignmentPath },
    });

    // §D the seal: the reviewed Assignment and the plan document it pins.
    expect(receipt.replayed).toBe(false);
    expect(receipt.data.coordination?.prepared).toMatchObject({
      assignment_path: join(harness, "assignments", `${OWN_PLAN}.md`),
      assignment_sha256: createHash("sha256").update(readFileSync(own.assignmentPath)).digest("hex"),
      plan_sha256: createHash("sha256").update(readFileSync(own.planPath)).digest("hex"),
      qa_gate: "mandatory",
      findings_cleanup: "allow-residual",
      prepared_by: COORDINATOR_ID,
    });
    // §D the plan's own worktree/branch anchors — the scope the later bind
    // claims its execution lease from — recorded on the row here.
    expect(receipt.data.plan.metadata).toEqual({
      worktree_path: join(harness, "worktrees", OWN_PLAN),
      working_branch: `feature/${OWN_PLAN}`,
    });
    // §7 the eligible authorized prepare is the writer of the frozen catalog
    // selection: the catalog identity read at prepare time, pinned to the
    // sealed input's own hash.
    const after = planFootprint(context, OWN_PLAN);
    const pin = parsedJson(after.catalog_pin);
    expect(pin).toEqual({
      store_id: receipt.storeId,
      entity_revision: 1,
      document_hash: after.input_hash,
      relation_hash: receipt.data.frozenInput?.relation_hash,
    });
    expect(receipt.data.frozenInput).toMatchObject({ store_id: receipt.storeId, entity_revision: 1 });
    // §3.1: the plan revision, the workflow revision (a child changed), the
    // sealed input's own revision and the store revision advance once each; the
    // root revision, the session and the (absent) lease do not move.
    expect(after).toEqual({
      ...before,
      plan_revision: (before.plan_revision as number) + 1,
      workflow_revision: (before.workflow_revision as number) + 1,
      store_revision: (before.store_revision as number) + 1,
      input_revision: (before.input_revision as number) + 1,
      operations: (before.operations as number) + 1,
      catalog_pin: serializeExecutionValue(pin),
      plan_coordination: JSON.stringify({ prepared: parsedJson(after.plan_coordination).prepared }),
      plan_state: JSON.stringify({
        ...parsedJson(before.plan_state),
        metadata: { worktree_path: join(harness, "worktrees", OWN_PLAN), working_branch: `feature/${OWN_PLAN}` },
      }),
    });
    expect(receipt.token).toBe(
      executionToken("plan", receipt.storeId, receipt.epoch, [WORKFLOW_ID, OWN_PLAN], (before.plan_revision as number) + 1),
    );

    // §3.1 an exact retry is a replay, not a second prepare: the recorded
    // receipt comes back and nothing advances.
    const committed = planFootprint(context, OWN_PLAN);
    const replay = await prepareExecutionPlan(domainContext(context, coordinatorCaller), {
      operationId: "prepare-1",
      session: coordinator,
      expected: planTokens[OWN_PLAN],
      planId: OWN_PLAN,
      operation: { kind: "prepare", assignmentPath: own.assignmentPath },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.data).toEqual(receipt.data);
    expect(planFootprint(context, OWN_PLAN)).toEqual(committed);

    // A token the prepare superseded is a stale CAS, not a re-read, and the
    // refused attempt leaves the prepared state exactly as it was.
    const stale = await refusalOf(async () => prepareCall(fixture, OWN_PLAN, "prepare-2", planTokens[OWN_PLAN]!));
    expect(stale).toMatchObject({ code: "execution.stale-token" });
    expect(planFootprint(context, OWN_PLAN)).toEqual(committed);
  });

  test("refuses a second prepare, a foreign Assignment, a held lease and a non-running workflow", async () => {
    const fixture = await liveWorkflow("prepare-refusals");
    const { context, coordinator, coordinatorCaller, documents, planTokens } = fixture;
    await prepareCall(fixture, OWN_PLAN, "prepare-first", planTokens[OWN_PLAN]!);
    const prepared = planFootprint(context, OWN_PLAN);

    // §6/§7 no reprepare permission exists: the rule the file route enforces
    // refuses a second seal even with the current token.
    const again = await refusalOf(async () =>
      prepareCall(fixture, OWN_PLAN, "prepare-again", await planTokenOf(fixture, OWN_PLAN)),
    );
    expect(again.code).toBe("coordination.invalid-transition");
    expect(planFootprint(context, OWN_PLAN)).toEqual(prepared);

    // A frozen Assignment that describes another plan is never sealed onto this
    // row, and is refused before the token is even compared.
    const foreign = await refusalOf(async () =>
      prepareCall(fixture, OWN_PLAN, "prepare-foreign", planTokens[OWN_PLAN]!, documents[PEER_PLAN]!.assignmentPath),
    );
    expect(foreign).toMatchObject({ code: "coordination.scope-mismatch", details: { actual: OWN_PLAN } });
    expect(planFootprint(context, OWN_PLAN)).toEqual(prepared);

    // §D the plan's own worktree/branch anchors are recorded once and never
    // silently rebound: an Assignment pinning another scope refuses, and the
    // row keeps the scope it records.
    const patchSpare = (patch: Record<string, unknown>): void => {
      withRaw(context, (db) => {
        const [row] = db.prepare("select state_json from execution_plans where plan_id = ?").all(SPARE_PLAN) as Array<{
          state_json?: unknown;
        }>;
        const state = JSON.parse(String(row!.state_json)) as Record<string, unknown>;
        db.prepare("update execution_plans set state_json = ? where plan_id = ?").run(
          JSON.stringify({ ...state, ...patch }),
          SPARE_PLAN,
        );
      });
    };
    const anchorRow = (metadata: Record<string, unknown>): void => patchSpare({ metadata });
    const spareWorktree = join(fixture.harnessRoot, "worktrees", SPARE_PLAN);
    anchorRow({ worktree_path: spareWorktree, working_branch: "feature/elsewhere" });
    const anchored = planFootprint(context, SPARE_PLAN);
    const reboundBranch = await refusalOf(async () =>
      prepareCall(fixture, SPARE_PLAN, "prepare-rebound-branch", planTokens[SPARE_PLAN]!),
    );
    expect(reboundBranch).toMatchObject({
      code: "coordination.scope-mismatch",
      details: { expected: "feature/elsewhere", actual: `feature/${SPARE_PLAN}` },
    });
    expect(planFootprint(context, SPARE_PLAN)).toEqual(anchored);
    anchorRow({ worktree_path: join(fixture.harnessRoot, "worktrees", "elsewhere"), working_branch: `feature/${SPARE_PLAN}` });
    const reAnchored = planFootprint(context, SPARE_PLAN);
    const reboundWorktree = await refusalOf(async () =>
      prepareCall(fixture, SPARE_PLAN, "prepare-rebound-worktree", planTokens[SPARE_PLAN]!),
    );
    expect(reboundWorktree).toMatchObject({
      code: "coordination.scope-mismatch",
      details: { expected: join(fixture.harnessRoot, "worktrees", "elsewhere"), actual: spareWorktree },
    });
    expect(planFootprint(context, SPARE_PLAN)).toEqual(reAnchored);

    // §D prepare's phase admission: a row outside Todo/Blocked is not a plan a
    // coordinator may seal, even when nothing else about it is sealed.
    patchSpare({ status: "Done" });
    const done = planFootprint(context, SPARE_PLAN);
    const doneRefusal = await refusalOf(async () =>
      prepareCall(fixture, SPARE_PLAN, "prepare-done", planTokens[SPARE_PLAN]!),
    );
    expect(doneRefusal).toMatchObject({ code: "coordination.invalid-transition", details: { status: "Done" } });
    expect(planFootprint(context, SPARE_PLAN)).toEqual(done);

    // §D a row that already records a lease is never sealed a second owner.
    // §3.1 keeps a released lease as a tombstone, which is the state a prepared
    // row's lease is left in — exactly what prepare must not overwrite.
    const peer = planFootprint(context, PEER_PLAN);
    withRaw(context, (db) => {
      db.prepare(
        "insert into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, ?, ?)",
      ).run(
        WORKFLOW_ID,
        PEER_PLAN,
        fixture.epoch,
        JSON.stringify({
          holder: "session-held",
          claimed_at: TS,
          worktree_path: join(fixture.harnessRoot, "worktrees", PEER_PLAN),
          working_branch: `feature/${PEER_PLAN}`,
          status: "released",
        }),
      );
    });
    const peerWithLease = planFootprint(context, PEER_PLAN);
    const leased = await refusalOf(async () => prepareCall(fixture, PEER_PLAN, "prepare-leased", planTokens[PEER_PLAN]!));
    expect(leased).toMatchObject({ code: "coordination.duplicate-holder", details: { holder: "session-held" } });
    expect(planFootprint(context, PEER_PLAN)).toEqual(peerWithLease);
    withRaw(context, (db) => {
      db.prepare("delete from execution_leases where plan_id = ?").run(PEER_PLAN);
    });
    expect(planFootprint(context, PEER_PLAN)).toEqual(peer);

    // A lifecycle that is no longer running refuses plan transitions: the row,
    // its input and the ledger are untouched.
    const peerBefore = planFootprint(context, PEER_PLAN);
    withRaw(context, (db) => {
      const [row] = db
        .prepare("select state_json from execution_workflows where workflow_id = ?")
        .all(WORKFLOW_ID) as Array<{ state_json?: unknown }>;
      const state = JSON.parse(String(row!.state_json)) as Record<string, unknown>;
      state.status = "paused";
      db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(
        JSON.stringify(state),
        WORKFLOW_ID,
      );
    });
    const pausedToken = await planTokenOf(fixture, PEER_PLAN);
    const paused = await refusalOf(async () => prepareCall(fixture, PEER_PLAN, "prepare-paused", pausedToken));
    expect(paused).toMatchObject({ code: "coordination.invalid-transition" });
    expect(planFootprint(context, PEER_PLAN)).toEqual(peerBefore);
    expect(planFootprint(context, OWN_PLAN)).toEqual(prepared);
  });

  test("progress moves only the plan's own status, summary and branches, and replays without advancing", async () => {
    const fixture = await liveWorkflow("progress-accepted");
    const { context, documents, planTokens } = fixture;
    await prepareCall(fixture, OWN_PLAN, "prepare-1", planTokens[OWN_PLAN]!);
    const planPm = await bindPlanPm(fixture, OWN_PLAN, "accepted");
    const planPmCaller = trustedCaller(PLAN_PM_ID, "plan-pm", OWN_PLAN);
    const boundToken = await planTokenOf(fixture, OWN_PLAN);
    const before = planFootprint(context, OWN_PLAN);

    const progressCall = (operationId: string, expected: ExecutionToken, status: string, branches?: string[]) =>
      progressExecutionPlan(domainContext(context, planPmCaller), {
        operationId,
        session: planPm,
        expected,
        planId: OWN_PLAN,
        operation: {
          kind: "progress",
          progress: {
            status: status as "InProgress",
            summary: `${status} on the DB route`,
            evidence_paths: [],
            ...(branches === undefined ? {} : { track_branches: branches }),
          },
        },
      });

    const receipt = await progressCall("progress-1", boundToken, "InProgress", [`feature/${OWN_PLAN}`]);
    expect(receipt.replayed).toBe(false);
    expect(receipt.data.plan.status).toBe("InProgress");
    expect(receipt.data.plan.metadata).toEqual({
      worktree_path: join(fixture.harnessRoot, "worktrees", OWN_PLAN),
      working_branch: `feature/${OWN_PLAN}`,
      track_branches: [`feature/${OWN_PLAN}`],
    });
    const accepted = planFootprint(context, OWN_PLAN);
    const acceptedProgress = {
      status: "InProgress",
      summary: "InProgress on the DB route",
      evidence_paths: [],
      track_branches: [`feature/${OWN_PLAN}`],
    };
    expect(receipt.data.coordination?.progress).toEqual(acceptedProgress);
    // §3.1 "an accepted progress changes only the permitted fields": the plan's
    // status, the reported branches, the two stored blocks, the plan/workflow/
    // store revisions and the operation row — and NOTHING else. In particular
    // the sealed frozen input is byte-identical.
    expect(accepted).toEqual({
      ...before,
      plan_revision: (before.plan_revision as number) + 1,
      workflow_revision: (before.workflow_revision as number) + 1,
      store_revision: (before.store_revision as number) + 1,
      operations: (before.operations as number) + 1,
      plan_coordination: JSON.stringify({
        prepared: parsedJson(before.plan_coordination).prepared,
        progress: acceptedProgress,
      }),
      plan_state: JSON.stringify({
        ...parsedJson(before.plan_state),
        status: "InProgress",
        metadata: { ...(parsedJson(before.plan_state).metadata as object), track_branches: [`feature/${OWN_PLAN}`] },
      }),
    });
    expect(receipt.token).toBe(
      executionToken("plan", receipt.storeId, receipt.epoch, [WORKFLOW_ID, OWN_PLAN], (before.plan_revision as number) + 1),
    );

    // §3.1 an exact retry returns the recorded receipt and advances nothing.
    const replay = await progressCall("progress-1", boundToken, "InProgress", [`feature/${OWN_PLAN}`]);
    expect(replay.replayed).toBe(true);
    expect(replay.data).toEqual(receipt.data);
    expect(planFootprint(context, OWN_PLAN)).toEqual(accepted);

    // The frozen Assignment is a witness of every progress: an edited one
    // invalidates the row with no revision change, exactly as the file route's
    // locked re-authentication does.
    writeFileSync(documents[OWN_PLAN]!.assignmentPath, `${readFileSync(documents[OWN_PLAN]!.assignmentPath, "utf8")}\nedited\n`);
    const tampered = await refusalOf(async () =>
      progressCall("progress-tampered", await planTokenOf(fixture, OWN_PLAN), "InReview"),
    );
    expect(tampered).toMatchObject({ code: "coordination.assignment-stale" });
    expect(planFootprint(context, OWN_PLAN)).toEqual(accepted);
    writeFileSync(
      documents[OWN_PLAN]!.assignmentPath,
      readFileSync(documents[OWN_PLAN]!.assignmentPath, "utf8").replace(/\nedited\n$/, ""),
    );

    // §D the plan's own progress admission. Each refusal leaves the accepted
    // progress footprint byte-identical.
    const current = await planTokenOf(fixture, OWN_PLAN);
    const otherPlan = await refusalOf(async () =>
      progressExecutionPlan(domainContext(context, planPmCaller), {
        operationId: "progress-foreign",
        session: planPm,
        expected: current,
        planId: PEER_PLAN,
        operation: { kind: "progress", progress: { status: "InProgress", summary: "peer", evidence_paths: [] } },
      }),
    );
    expect(otherPlan.code).toBe("coordination.session-mismatch");
    expect(planFootprint(context, OWN_PLAN)).toEqual(accepted);

    const stale = await refusalOf(async () => progressCall("progress-stale", boundToken, "InReview"));
    expect(stale).toMatchObject({ code: "execution.stale-token" });
    expect(planFootprint(context, OWN_PLAN)).toEqual(accepted);

    const borrowed = await refusalOf(async () =>
      progressCall("progress-borrowed", await planTokenOf(fixture, OWN_PLAN), "InReview", ["main"]),
    );
    expect(borrowed).toMatchObject({ code: "coordination.invalid-input", details: { branch: "main" } });
    expect(planFootprint(context, OWN_PLAN)).toEqual(accepted);

    const outside = await refusalOf(async () =>
      progressExecutionPlan(domainContext(context, planPmCaller), {
        operationId: "progress-outside",
        session: planPm,
        expected: await planTokenOf(fixture, OWN_PLAN),
        planId: OWN_PLAN,
        operation: {
          kind: "progress",
          progress: { status: "InReview", summary: "outside", evidence_paths: [join(fixture.harnessRoot, "store.db")] },
        },
      }),
    );
    expect(outside).toMatchObject({ code: "coordination.path-mismatch" });
    expect(planFootprint(context, OWN_PLAN)).toEqual(accepted);

    // §D progress belongs to an executing row: a row that reached a status
    // outside the progress table refuses it.
    withRaw(context, (db) => {
      const [row] = db.prepare("select state_json from execution_plans where plan_id = ?").all(OWN_PLAN) as Array<{
        state_json?: unknown;
      }>;
      const state = JSON.parse(String(row!.state_json)) as Record<string, unknown>;
      state.status = "Done";
      db.prepare("update execution_plans set state_json = ? where plan_id = ?").run(JSON.stringify(state), OWN_PLAN);
    });
    const unstatused = await refusalOf(async () =>
      progressCall("progress-done", await planTokenOf(fixture, OWN_PLAN), "InProgress"),
    );
    expect(unstatused).toMatchObject({ code: "coordination.invalid-transition" });
    expect(parsedJson(planFootprint(context, OWN_PLAN).plan_state).status).toBe("Done");

    // §3.1 a plan whose lease is not HELD holds no plan-owned write: the DB
    // keeps released lease rows as tombstones, and one is not a lease. The row
    // is put back in an executable status first, so the ONLY refusal this call
    // can produce is the missing held lease.
    withRaw(context, (db) => {
      const [row] = db.prepare("select state_json from execution_plans where plan_id = ?").all(OWN_PLAN) as Array<{
        state_json?: unknown;
      }>;
      const state = JSON.parse(String(row!.state_json)) as Record<string, unknown>;
      state.status = "InProgress";
      db.prepare("update execution_plans set state_json = ? where plan_id = ?").run(JSON.stringify(state), OWN_PLAN);
      const [leaseRow] = db
        .prepare("select lease_json from execution_leases where plan_id = ?")
        .all(OWN_PLAN) as Array<{ lease_json?: unknown }>;
      db.prepare("update execution_leases set lease_json = ? where plan_id = ?").run(
        JSON.stringify({ ...parsedJson(leaseRow!.lease_json), status: "released" }),
        OWN_PLAN,
      );
    });
    const releasedFootprint = planFootprint(context, OWN_PLAN);
    const notHeld = await refusalOf(async () =>
      progressCall("progress-released", await planTokenOf(fixture, OWN_PLAN), "InReview"),
    );
    expect(notHeld).toMatchObject({ code: "coordination.invalid-transition" });
    expect(planFootprint(context, OWN_PLAN)).toEqual(releasedFootprint);
    expect(parsedJson(releasedFootprint.own_lease).status).toBe("released");
  });

  test("a concurrent catalog edit never rebinds the frozen input, and only an eligible prepare selects one", async () => {
    const fixture = await liveWorkflow("frozen-input");
    const { context, coordinatorCaller, documents, planTokens } = fixture;
    await prepareCall(fixture, OWN_PLAN, "prepare-1", planTokens[OWN_PLAN]!);
    const planPm = await bindPlanPm(fixture, OWN_PLAN, "frozen");
    const planPmCaller = trustedCaller(PLAN_PM_ID, "plan-pm", OWN_PLAN);
    const sealedBefore = planFootprint(context, OWN_PLAN);

    // §7 a concurrent catalog edit moves the catalog entity's revision and its
    // descriptive metadata.
    await updateCatalogEntity(
      context,
      { kind: "plan", id: OWN_PLAN },
      { title: `${OWN_PLAN} title v2` },
      1,
      { operationId: "catalog-edit", actor: "execution-coordination.test" },
    );

    const progressed = await progressExecutionPlan(domainContext(context, planPmCaller), {
      operationId: "progress-after-catalog-edit",
      session: planPm,
      expected: await planTokenOf(fixture, OWN_PLAN),
      planId: OWN_PLAN,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "after a catalog edit", evidence_paths: [] } },
    });
    expect(progressed.replayed).toBe(false);
    // Progress copies neither the newer title/path nor new references into the
    // frozen input: the sealed selection and its pin are byte-identical.
    const sealedAfter = planFootprint(context, OWN_PLAN);
    expect(sealedAfter.input_json).toBe(sealedBefore.input_json);
    expect(sealedAfter.input_hash).toBe(sealedBefore.input_hash);
    expect(sealedAfter.catalog_pin).toBe(sealedBefore.catalog_pin);
    expect(sealedAfter.input_revision).toBe(sealedBefore.input_revision);
    expect(sealedAfter.plan_revision).toBe((sealedBefore.plan_revision as number) + 1);
    expect(parsedJson(sealedAfter.plan_state).title).toBe(`${OWN_PLAN} title`);

    // §6 no reprepare: the already-prepared row refuses a second seal, so no
    // later authorized-looking call can rebind the frozen input either.
    const reprepare = await refusalOf(async () =>
      prepareCall(fixture, OWN_PLAN, "prepare-2", await planTokenOf(fixture, OWN_PLAN)),
    );
    expect(reprepare.code).toBe("coordination.invalid-transition");
    expect(planFootprint(context, OWN_PLAN)).toEqual(sealedAfter);

    // The ELIGIBLE authorized prepare is the selection point: the peer plan's
    // own catalog identity moved, so its first prepare pins the revision it
    // observed, not the one creation saw.
    await updateCatalogEntity(
      context,
      { kind: "plan", id: PEER_PLAN },
      { title: `${PEER_PLAN} title v2` },
      1,
      { operationId: "catalog-edit-peer", actor: "execution-coordination.test" },
    );
    const peerReceipt = await prepareCall(fixture, PEER_PLAN, "prepare-peer", planTokens[PEER_PLAN]!);
    expect(peerReceipt.data.frozenInput).toMatchObject({ store_id: fixture.storeId, entity_revision: 2 });
    expect(parsedJson(planFootprint(context, PEER_PLAN).catalog_pin)).toMatchObject({ entity_revision: 2 });
    expect(planFootprint(context, PEER_PLAN).input_hash).toBe(peerReceipt.data.frozenInput?.document_hash);

    // §1 a pin that disagrees with the selection it is pinned to is a conflict
    // that is refused, never repaired: neither side is overwritten, and the
    // eligible row stays unsealed. (`p-3` is the fixture's untouched row, so
    // the refusal comes from the frozen input and not from a row already being
    // prepared.)
    const spare = planFootprint(context, SPARE_PLAN);
    expect(spare.catalog_pin).toBeNull();
    withRaw(context, (db) => {
      db.prepare("update execution_inputs set catalog_pin_json = ? where workflow_id = ? and plan_id = ?").run(
        JSON.stringify({
          store_id: fixture.storeId,
          entity_revision: 1,
          document_hash: "f".repeat(64),
          relation_hash: "f".repeat(64),
        }),
        WORKFLOW_ID,
        SPARE_PLAN,
      );
    });
    const conflicting = planFootprint(context, SPARE_PLAN);
    const conflict = await refusalOf(async () =>
      prepareExecutionPlan(domainContext(context, coordinatorCaller), {
        operationId: "prepare-conflict",
        session: fixture.coordinator,
        expected: planTokens[SPARE_PLAN]!,
        planId: SPARE_PLAN,
        operation: { kind: "prepare", assignmentPath: documents[SPARE_PLAN]!.assignmentPath },
      }),
    );
    expect(conflict).toMatchObject({ code: "catalog.execution-pin-conflict" });
    expect(planFootprint(context, SPARE_PLAN)).toEqual(conflicting);
    expect(conflicting.input_json).toBe(spare.input_json);
    expect(parsedJson(conflicting.plan_coordination)).toEqual({});
  });
});
