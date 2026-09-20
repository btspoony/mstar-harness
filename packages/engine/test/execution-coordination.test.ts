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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCatalogEntity } from "../src/catalog.js";
import { withExecutionPlanAuthority, type ExecutionPlanCall } from "../src/execution-coordination.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  executionToken,
  initializeExecutionAuthority,
  readExecutionPlan,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionPlanWitness,
  type ExecutionSessionRef,
  type ExecutionToken,
} from "../src/execution-store.js";
import { initializeStore, type StoreContext, type StoreDb } from "../src/store-db.js";
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

function storePath(context: StoreContext): string {
  return join(context.harnessDir, "store.db");
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
