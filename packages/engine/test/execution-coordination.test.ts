/**
 * execution-coordination — the DB plan-operation authorization boundary
 * (primary spec §2.3/§3/§4.1).
 *
 * Run with
 * `bun test packages/engine/test/execution-coordination.test.ts --test-name-pattern 'execution-authority-boundary'`,
 * `… --test-name-pattern 'execution-prepare-progress'` or
 * `… --test-name-pattern 'execution-residual'`.
 *
 * Every fixture lives in its own temporary control root created by
 * `mkdtempSync`; no test reads or writes this checkout's `store.db`. The planted
 * legacy session envelope is there to prove the DB authorization context is
 * identities and revisions only: a session file is neither an authority nor an
 * output of a DB plan operation. The residual group additionally asserts the
 * ISSUE authority: an operation that captures, links or closes a finding is
 * accepted only if the issue rows and the plan side commit together.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCatalogEntity, updateCatalogEntity } from "../src/catalog.js";
import { mutateExecutionPlan as publishedMutateExecutionPlan } from "../src/index.js";
import {
  mutateExecutionPlan,
  prepareExecutionPlan,
  progressExecutionPlan,
  residualAddExecutionPlan,
  residualCloseExecutionPlan,
  setCompleteWitnessGapForTest,
  withExecutionPlanAuthority,
  type ExecutionPlanCall,
} from "../src/execution-coordination.js";
import { captureIssue, getIssue, listIssues, type CaptureInput } from "../src/issue.js";
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
  type ExecutionMutation,
  type ExecutionPlanView,
  type ExecutionPlanWitness,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionToken,
} from "../src/execution-store.js";
import type { CoordinationOperation } from "../src/index.js";
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

async function refusalOf(
  work: () => Promise<unknown>,
): Promise<{ code?: string; message?: string; details?: Record<string, unknown> }> {
  try {
    await work();
    throw new Error("expected a refusal");
  } catch (error) {
    return error as { code?: string; message?: string; details?: Record<string, unknown> };
  }
}

/**
 * The v2 root document that makes the fixture's workflow ROOT-VISIBLE, which is
 * the precondition of the registration gate. `findRegisteredWorkflow` is a
 * tolerant reader, so the entry an active workflow carries is all it needs.
 */
function registerWorkflowInRoot(harnessRoot: string): void {
  writeFileSync(
    join(harnessRoot, "status.json"),
    `${JSON.stringify({ version: 2, workflows: [{ id: WORKFLOW_ID, type: "plan", status: "running" }] }, null, 2)}\n`,
  );
}

/** Record one catalog-registration operation for the workflow on the journal. */
function plantRegistration(context: StoreContext, operationId: string, phase: string): void {
  withRaw(context, (db) => {
    db.prepare(
      "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) " +
        "values (?, ?, ?, ?, '{}', '{}', null, ?, ?)",
    ).run(
      operationId,
      "c".repeat(64),
      phase,
      JSON.stringify({ workflow: { workflowId: WORKFLOW_ID } }),
      TS,
      TS,
    );
  });
}

function setRegistrationPhase(context: StoreContext, operationId: string, phase: string): void {
  withRaw(context, (db) => {
    db.prepare("update catalog_operations set phase = ? where operation_id = ?").run(phase, operationId);
  });
}

function registrationPhase(context: StoreContext, operationId: string): unknown {
  const [row] = rows(context, `select phase from catalog_operations where operation_id = '${operationId}'`);
  return row?.phase;
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

  test("refuses a prepare whose catalog registration is still pending, and seals nothing", async () => {
    const fixture = await liveWorkflow("prepare-registration-pending");
    const { context, harnessRoot, planTokens } = fixture;
    registerWorkflowInRoot(harnessRoot);

    // §3 step 3 a journal row that is NOT in flight is not a pending
    // registration: a committed operation refuses nothing, so the plan it
    // covers still seals normally.
    plantRegistration(context, "op-registration-committed", "committed");
    const committed = await prepareCall(fixture, SPARE_PLAN, "prepare-committed", planTokens[SPARE_PLAN]!);
    expect(committed.replayed).toBe(false);
    expect(typeof committed.data.coordination?.prepared?.assignment_sha256).toBe("string");

    // A RECORDED-but-uncommitted registration is: the workflow is root-visible
    // while its catalog registration is only `prepared`, which is exactly the
    // workspace the file route refuses after its own row admission.
    plantRegistration(context, "op-registration-pending", "prepared");
    const before = planFootprint(context, OWN_PLAN);
    const refused = await refusalOf(async () =>
      prepareCall(fixture, OWN_PLAN, "prepare-pending", planTokens[OWN_PLAN]!),
    );
    expect(refused.code).toBe("catalog.registration-pending");
    expect(refused.message).toContain("op-registration-pending");
    // The refusal is the pending operation and nothing else: no plan, input,
    // revision, lease or operation row moved, and the journal row is untouched
    // (the operation is still reconcilable, never consumed by the refusal).
    expect(planFootprint(context, OWN_PLAN)).toEqual(before);
    expect(registrationPhase(context, "op-registration-pending")).toBe("prepared");

    // Committing the registration — and nothing else about the fixture —
    // restores the same prepare, which now runs its real seal.
    setRegistrationPhase(context, "op-registration-pending", "committed");
    const sealed = await prepareCall(fixture, OWN_PLAN, "prepare-after-commit", planTokens[OWN_PLAN]!);
    expect(sealed.replayed).toBe(false);
    expect(sealed.data.coordination?.prepared).toMatchObject({
      assignment_path: join(harnessRoot, "assignments", `${OWN_PLAN}.md`),
      qa_gate: "mandatory",
      prepared_by: COORDINATOR_ID,
    });
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

/* ------------------------------------------------------------------------ *
 * §3 `residual-add` / `residual-close` — the issue authority in this commit
 * ------------------------------------------------------------------------ */

/** One trusted identity holds at most one plan-pm session per workflow, so the
 * peer plan's seat is a second identity. */
const PEER_PM_ID = "host-pm-peer";

/** One residual entry: the observation half of a capture, without the project
 * (the addressed plan row supplies it, exactly as the file route does). */
function residualEntry(overrides: Partial<Omit<CaptureInput, "projectId">> = {}): Omit<CaptureInput, "projectId"> {
  return {
    title: "residual finding",
    kind: "bug",
    severity: "high",
    impact: "the residual is unfixed",
    acceptance: "the residual is fixed",
    sourceIdentity: "qc/review.md",
    rootCauseKey: "missing-guard",
    acceptanceKey: "guard-present",
    occurrenceKey: "residual-1",
    sourceKind: "qc",
    location: "packages/engine/src/execution-coordination.ts:1",
    observedBehavior: "the finding is visible",
    evidence: ["stack: TypeError"],
    discoveredAt: TS,
    ...overrides,
  };
}

/**
 * Every row the issue authority holds, as one comparable value: a residual
 * operation and the plan rows it must move commit in ONE transaction, so a
 * refusal has to leave this whole footprint — not only the plan half — where it
 * was.
 */
function issueFootprint(context: StoreContext): Record<string, unknown> {
  const [row] = rows(
    context,
    "select (select revision from store_meta where id = 1) as store_revision, " +
      "(select count(*) as n from issues) as issues, " +
      "(select count(*) as n from occurrences) as occurrences, " +
      "(select count(*) as n from provenance) as provenance, " +
      "(select count(*) as n from issue_transitions) as transitions, " +
      "(select count(*) as n from store_operations) as operations",
  );
  return row!;
}

/** §3.1 the shared store revision on its own: the counter a multi-domain transaction increments once. */
function storeRevisionOf(context: StoreContext): number {
  const [row] = rows(context, "select revision from store_meta where id = 1");
  return Number(row!.revision);
}

/** Bind one plan's plan-pm session — which claims the plan's execution lease. */
async function planSeat(
  fixture: LiveFixture,
  planId: string,
  sessionId: string,
  label: string,
): Promise<{ caller: ExecutionCaller; session: ExecutionSessionRef }> {
  const caller = trustedCaller(sessionId, "plan-pm", planId);
  const bound = await bindExecutionSession(domainContext(fixture.context, caller), {
    workflowId: WORKFLOW_ID,
    planId,
    role: "plan-pm",
    expected: await planTokenOf(fixture, planId),
    operationId: `bind-seat-${label}`,
  });
  return { caller, session: bound.data };
}

/** One residual-add against the addressed plan's token, read right now. */
function residualAddCall(
  fixture: LiveFixture,
  seat: { caller: ExecutionCaller; session: ExecutionSessionRef },
  operationId: string,
  entries: Array<Omit<CaptureInput, "projectId">>,
  expected: ExecutionToken,
) {
  return residualAddExecutionPlan(domainContext(fixture.context, seat.caller), {
    operationId,
    session: seat.session,
    expected,
    planId: OWN_PLAN,
    operation: { kind: "residual-add", entries },
  });
}

describe("execution-residual: §3/§4.1 DB residual-add and residual-close", () => {
  test("residual-add captures and links every entry on the addressed plan, and residual-close disposes one", async () => {
    const fixture = await liveWorkflow("residual-accepted");
    const { context, planTokens } = fixture;
    await prepareCall(fixture, OWN_PLAN, "prepare-1", planTokens[OWN_PLAN]!);
    const seat = await planSeat(fixture, OWN_PLAN, PLAN_PM_ID, "accepted");

    const added = await residualAddCall(
      fixture,
      seat,
      "residual-add-accepted",
      [
        residualEntry({ occurrenceKey: "r-1" }),
        residualEntry({
          occurrenceKey: "r-2",
          title: "second residual",
          rootCauseKey: "second-cause",
          acceptanceKey: "second-acceptance",
        }),
      ],
      await planTokenOf(fixture, OWN_PLAN),
    );
    expect(added.replayed).toBe(false);
    expect(added.data.plan.id).toBe(OWN_PLAN);
    // The receipt's token is the addressed plan's CAS token, read back through
    // the session-authorized read AFTER the operation advanced the plan revision
    // (§3.1: a residual operation is a plan mutation).
    expect(added.token).toBe(await planTokenOf(fixture, OWN_PLAN));

    // Consumer-visible: both findings exist in the plan row's project bucket and
    // are linked to THIS plan by append-only provenance.
    const page = await listIssues(context, { projectId: "_default" });
    expect(page.items.map((item) => item.title).sort()).toEqual(["residual finding", "second residual"]);
    expect(page.items.every((item) => item.disposition === "open")).toBe(true);
    const [first] = page.items;
    const detail = await getIssue(context, first!.id);
    expect(detail.projectId).toBe("_default");
    expect(detail.occurrences).toHaveLength(1);
    expect(detail.provenance.filter((row) => row.kind === "plan").map((row) => row.target)).toEqual([OWN_PLAN]);

    const closed = await residualCloseExecutionPlan(domainContext(context, seat.caller), {
      operationId: "residual-close-accepted",
      session: seat.session,
      expected: await planTokenOf(fixture, OWN_PLAN),
      planId: OWN_PLAN,
      operation: {
        kind: "residual-close",
        issueId: detail.id,
        disposition: "resolved",
        evidence: { reason: "the finding is fixed", references: [OWN_PLAN], alignmentRef: "qa-gate:accepted" },
        expectedIssueRevision: detail.revision,
      },
    });
    expect(closed.replayed).toBe(false);
    const disposed = await getIssue(context, detail.id);
    expect(disposed.disposition).toBe("resolved");
    expect(disposed.transitions).toHaveLength(1);
    expect(disposed.transitions[0]).toMatchObject({
      fromDisposition: "open",
      toDisposition: "resolved",
      actor: "project-manager",
    });
  });

  test("a residual-add replays exactly, and an operation id reused with another payload refuses", async () => {
    const fixture = await liveWorkflow("residual-replay");
    const { context, planTokens } = fixture;
    await prepareCall(fixture, OWN_PLAN, "prepare-1", planTokens[OWN_PLAN]!);
    const seat = await planSeat(fixture, OWN_PLAN, PLAN_PM_ID, "replay");
    const entries = [residualEntry({ occurrenceKey: "r-1" })];
    const token = await planTokenOf(fixture, OWN_PLAN);

    const first = await residualAddCall(fixture, seat, "residual-add-replay", entries, token);
    expect(first.replayed).toBe(false);
    const settled = { plan: planFootprint(context, OWN_PLAN), issues: issueFootprint(context) };

    const again = await residualAddCall(fixture, seat, "residual-add-replay", entries, token);
    expect(again.replayed).toBe(true);
    expect(again.data).toEqual(first.data);
    expect(again.token).toBe(first.token);
    expect(planFootprint(context, OWN_PLAN)).toEqual(settled.plan);
    expect(issueFootprint(context)).toEqual(settled.issues);

    const conflict = await refusalOf(() =>
      residualAddCall(fixture, seat, "residual-add-replay", [residualEntry({ occurrenceKey: "r-other" })], token),
    );
    expect(conflict.code).toBe("execution.operation-conflict");
    expect(planFootprint(context, OWN_PLAN)).toEqual(settled.plan);
    expect(issueFootprint(context)).toEqual(settled.issues);
  });

  test("an accepted residual operation spends the plan token it was given, and the spent token is refused", async () => {
    const fixture = await liveWorkflow("residual-plan-token");
    const { context, planTokens } = fixture;
    await prepareCall(fixture, OWN_PLAN, "prepare-1", planTokens[OWN_PLAN]!);
    const seat = await planSeat(fixture, OWN_PLAN, PLAN_PM_ID, "plan-token");
    const before = planFootprint(context, OWN_PLAN);
    // The CAS the caller holds BEFORE the operation. A residual operation is a
    // plan mutation (§3.1), so this token must not survive it.
    const held = await planTokenOf(fixture, OWN_PLAN);

    const added = await residualAddCall(
      fixture,
      seat,
      "residual-add-plan-token",
      [residualEntry({ occurrenceKey: "r-1" })],
      held,
    );
    expect(added.replayed).toBe(false);
    // The receipt witnesses the plan's NEW revision, and the plan revision
    // advanced exactly once for the accepted operation.
    expect(added.token).not.toBe(held);
    expect(added.token).toBe(await planTokenOf(fixture, OWN_PLAN));
    expect(Number(planFootprint(context, OWN_PLAN).plan_revision)).toBe(Number(before.plan_revision) + 1);

    const [item] = (await listIssues(context, {})).items;
    const detail = await getIssue(context, item!.id);
    expect(detail.disposition).toBe("open");
    const settled = { plan: planFootprint(context, OWN_PLAN), issues: issueFootprint(context) };

    // The spent token is refused by the NEXT operation, which changes neither
    // the plan side nor the issue state the accepted operation left.
    const refused = await refusalOf(() =>
      residualCloseExecutionPlan(domainContext(context, seat.caller), {
        operationId: "residual-close-spent-token",
        session: seat.session,
        expected: held,
        planId: OWN_PLAN,
        operation: {
          kind: "residual-close",
          issueId: detail.id,
          disposition: "resolved",
          evidence: { reason: "the finding is fixed", references: [OWN_PLAN], alignmentRef: "qa-gate:accepted" },
          expectedIssueRevision: detail.revision,
        },
      }),
    );
    expect(refused.code).toBe("execution.stale-token");
    expect(planFootprint(context, OWN_PLAN)).toEqual(settled.plan);
    expect(issueFootprint(context)).toEqual(settled.issues);
    const kept = await getIssue(context, detail.id);
    expect(kept.disposition).toBe("open");
    expect(kept.transitions).toEqual([]);
  });

  test("a multi-entry residual-add and a residual-close each advance the shared store revision once", async () => {
    const fixture = await liveWorkflow("residual-store-revision");
    const { context, planTokens } = fixture;
    await prepareCall(fixture, OWN_PLAN, "prepare-1", planTokens[OWN_PLAN]!);
    const seat = await planSeat(fixture, OWN_PLAN, PLAN_PM_ID, "store-revision");
    const entries = [
      residualEntry({ occurrenceKey: "rev-1" }),
      residualEntry({
        occurrenceKey: "rev-2",
        title: "second residual",
        rootCauseKey: "second-cause",
        acceptanceKey: "second-acceptance",
      }),
    ];

    // Two captures and two links compose into ONE transaction: §3.1 admits one
    // shared-revision increment for it, not one per composed helper.
    const before = storeRevisionOf(context);
    const token = await planTokenOf(fixture, OWN_PLAN);
    const added = await residualAddCall(fixture, seat, "residual-add-store-revision", entries, token);
    expect(added.replayed).toBe(false);
    expect(storeRevisionOf(context)).toBe(before + 1);

    const [item] = (await listIssues(context, {})).items;
    const detail = await getIssue(context, item!.id);
    const beforeClose = storeRevisionOf(context);
    const closed = await residualCloseExecutionPlan(domainContext(context, seat.caller), {
      operationId: "residual-close-store-revision",
      session: seat.session,
      expected: await planTokenOf(fixture, OWN_PLAN),
      planId: OWN_PLAN,
      operation: {
        kind: "residual-close",
        issueId: detail.id,
        disposition: "resolved",
        evidence: { reason: "the finding is fixed", references: [OWN_PLAN], alignmentRef: "qa-gate:accepted" },
        expectedIssueRevision: detail.revision,
      },
    });
    expect(closed.replayed).toBe(false);
    expect(storeRevisionOf(context)).toBe(beforeClose + 1);

    // An exact replay is not a second transaction: it advances neither the plan
    // revision nor the shared store revision.
    const settled = { plan: planFootprint(context, OWN_PLAN), issues: issueFootprint(context) };
    const again = await residualAddCall(fixture, seat, "residual-add-store-revision", entries, token);
    expect(again.replayed).toBe(true);
    expect(storeRevisionOf(context)).toBe(beforeClose + 1);
    expect(planFootprint(context, OWN_PLAN)).toEqual(settled.plan);
    expect(issueFootprint(context)).toEqual(settled.issues);
  });

  test("a stale issue revision refuses and leaves the finding, its history and the plan token untouched", async () => {
    const fixture = await liveWorkflow("residual-stale-revision");
    const { context, planTokens } = fixture;
    await prepareCall(fixture, OWN_PLAN, "prepare-1", planTokens[OWN_PLAN]!);
    const seat = await planSeat(fixture, OWN_PLAN, PLAN_PM_ID, "stale");
    await residualAddCall(fixture, seat, "residual-add-stale", [residualEntry({ occurrenceKey: "r-1" })], await planTokenOf(fixture, OWN_PLAN));
    const [item] = (await listIssues(context, {})).items;
    const detail = await getIssue(context, item!.id);
    // The revision a caller would hold from before the plan link advanced it.
    const stale = detail.revision - 1;
    const before = { plan: planFootprint(context, OWN_PLAN), issues: issueFootprint(context) };
    const token = await planTokenOf(fixture, OWN_PLAN);

    const refused = await refusalOf(() =>
      residualCloseExecutionPlan(domainContext(context, seat.caller), {
        operationId: "residual-close-stale",
        session: seat.session,
        expected: token,
        planId: OWN_PLAN,
        operation: {
          kind: "residual-close",
          issueId: detail.id,
          disposition: "resolved",
          evidence: { reason: "the finding is fixed", references: [OWN_PLAN], alignmentRef: "qa-gate:accepted" },
          expectedIssueRevision: stale,
        },
      }),
    );
    expect(refused.code).toBe("issue.revision-conflict");
    expect(planFootprint(context, OWN_PLAN)).toEqual(before.plan);
    expect(issueFootprint(context)).toEqual(before.issues);
    const kept = await getIssue(context, detail.id);
    expect(kept.disposition).toBe("open");
    expect(kept.revision).toBe(detail.revision);
    expect(kept.transitions).toEqual([]);
  });

  test("a plan session closes only its own findings, so a foreign plan refuses", async () => {
    const fixture = await liveWorkflow("residual-foreign");
    const { context, planTokens } = fixture;
    await prepareCall(fixture, OWN_PLAN, "prepare-1", planTokens[OWN_PLAN]!);
    await prepareCall(fixture, PEER_PLAN, "prepare-peer", planTokens[PEER_PLAN]!);
    const own = await planSeat(fixture, OWN_PLAN, PLAN_PM_ID, "foreign-own");
    await residualAddCall(fixture, own, "residual-add-foreign", [residualEntry({ occurrenceKey: "r-1" })], await planTokenOf(fixture, OWN_PLAN));
    const [item] = (await listIssues(context, {})).items;
    const detail = await getIssue(context, item!.id);
    const peer = await planSeat(fixture, PEER_PLAN, PEER_PM_ID, "foreign-peer");
    const before = { plan: planFootprint(context, PEER_PLAN), issues: issueFootprint(context) };
    const peerToken = await planTokenOf(fixture, PEER_PLAN);

    const refused = await refusalOf(() =>
      residualCloseExecutionPlan(domainContext(context, peer.caller), {
        operationId: "residual-close-foreign",
        session: peer.session,
        expected: peerToken,
        planId: PEER_PLAN,
        operation: {
          kind: "residual-close",
          issueId: detail.id,
          disposition: "resolved",
          evidence: { reason: "not this plan's finding", references: [PEER_PLAN], alignmentRef: "qa-gate:accepted" },
          expectedIssueRevision: detail.revision,
        },
      }),
    );
    expect(refused.code).toBe("issue.scope-refused");
    expect(planFootprint(context, PEER_PLAN)).toEqual(before.plan);
    expect(issueFootprint(context)).toEqual(before.issues);
    const kept = await getIssue(context, detail.id);
    expect(kept.disposition).toBe("open");
    expect(kept.provenance.filter((row) => row.kind === "plan").map((row) => row.target)).toEqual([OWN_PLAN]);
  });

  test("a refusal on a later entry rolls back every earlier entry, its link and its allocation", async () => {
    const fixture = await liveWorkflow("residual-rollback");
    const { context, planTokens } = fixture;
    await prepareCall(fixture, OWN_PLAN, "prepare-1", planTokens[OWN_PLAN]!);
    const seat = await planSeat(fixture, OWN_PLAN, PLAN_PM_ID, "rollback");
    // A finding that already owns the occurrence key the SECOND entry presents
    // under another identity: the collision is only discoverable once the first
    // entry has been captured and linked inside the transaction.
    const seeded = await captureIssue(
      context,
      {
        projectId: "_default",
        ...residualEntry({ occurrenceKey: "taken", rootCauseKey: "seeded-cause", acceptanceKey: "seeded-acceptance" }),
      },
      { operationId: "seed-collision", actor: "project-manager" },
    );
    expect(seeded.issueId).toBe("I-000001");
    const before = { plan: planFootprint(context, OWN_PLAN), issues: issueFootprint(context) };
    const token = await planTokenOf(fixture, OWN_PLAN);

    const refused = await refusalOf(() =>
      residualAddCall(
        fixture,
        seat,
        "residual-add-partial",
        [
          residualEntry({ occurrenceKey: "fresh", rootCauseKey: "fresh-cause", acceptanceKey: "fresh-acceptance" }),
          residualEntry({ occurrenceKey: "taken", rootCauseKey: "other-cause", acceptanceKey: "other-acceptance" }),
        ],
        token,
      ),
    );
    expect(refused.code).toBe("issue.ambiguous-identity");
    // The first entry was captured AND linked before the second refused: none of
    // it survives, and the plan side moved not at all.
    expect(planFootprint(context, OWN_PLAN)).toEqual(before.plan);
    expect(issueFootprint(context)).toEqual(before.issues);

    // The rolled-back entry allocated an identifier that the next accepted
    // capture takes: the issue row, its occurrence, its link, the counter and
    // the store revision all went back with the refusal.
    const after = await captureIssue(
      context,
      {
        projectId: "_default",
        ...residualEntry({ occurrenceKey: "after-rollback", rootCauseKey: "after-cause", acceptanceKey: "after-acceptance" }),
      },
      { operationId: "after-rollback", actor: "project-manager" },
    );
    expect(after.issueId).toBe("I-000002");
    expect(after.created).toBe(true);
  });

  test("a staged issue store refuses a residual operation before it writes", async () => {
    const fixture = await liveWorkflow("residual-staged-store");
    const { context, planTokens } = fixture;
    await prepareCall(fixture, OWN_PLAN, "prepare-1", planTokens[OWN_PLAN]!);
    const seat = await planSeat(fixture, OWN_PLAN, PLAN_PM_ID, "staged");
    withRaw(context, (db) => {
      db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
    });
    const before = planFootprint(context, OWN_PLAN);
    const token = await planTokenOf(fixture, OWN_PLAN);

    const refused = await refusalOf(() =>
      residualAddCall(
        fixture,
        seat,
        "residual-add-staged",
        [residualEntry({ occurrenceKey: "s-1", rootCauseKey: "staged-cause", acceptanceKey: "staged-acceptance" })],
        token,
      ),
    );
    expect(refused.code).toBe("store.not-active");
    expect(planFootprint(context, OWN_PLAN)).toEqual(before);
  });
});

/* ------------------------------------------------------------------------ *
 * W4 — handoff, integration, completion and reconcile on real Git evidence
 * ------------------------------------------------------------------------ */

/** One Git command in a fixture repository (never the caller's checkout). */
function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function headOf(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** §D one plan's review evidence: absolute paths inside its own SDD area. */
type PlanEvidence = { qc: string[]; consolidated: string; qa: string };

function planEvidenceOf(harnessRoot: string, planId: string): PlanEvidence {
  const sdd = join(harnessRoot, "sdd", planId);
  const qc = [join(sdd, "review", "qc1.md"), join(sdd, "review", "qc2.md")];
  for (const path of qc) writeText(path, "# qc report\n");
  const consolidated = join(sdd, "review", "qc.md");
  writeText(consolidated, "# consolidated qc\n");
  const qa = join(sdd, "qa.md");
  writeText(qa, "# qa pass\n");
  return { qc, consolidated, qa };
}

/** §D the evidence object a plan session submits: paths and revisions only. */
function handoffEvidenceOf(fixture: LifecycleFixture): Record<string, unknown> {
  const evidence = fixture.evidence[OWN_PLAN]!;
  return {
    source_sha: fixture.featureSha,
    review_base: fixture.baseSha,
    review_head: fixture.featureSha,
    qc: { decision: "Approve", reports: evidence.qc, consolidated: evidence.consolidated },
    qa: { gate: "mandatory", decision: "pass", report: evidence.qa },
  };
}

/** One seat: the trusted caller identity plus the reference it holds. */
type Seat = { caller: ExecutionCaller; session: ExecutionSessionRef };

/**
 * §A1 the lifecycle route one fixture builds. `development` is a single-plan
 * standalone workflow with delivery anchors only; `integration` carries the
 * integration branch and checkout every iteration attempt is proven against.
 */
type LifecycleRoute = "development" | "integration" | "report-only";

type LifecycleFixture = LiveFixture & {
  route: LifecycleRoute;
  repoRoot: string;
  featurePath: string;
  featureSha: string;
  integrationPath: string;
  baseSha: string;
  evidence: Record<string, PlanEvidence>;
  /** The plan's own seat, holding its execution lease. */
  seat: Seat;
  coordinatorSeat: Seat;
};

/**
 * An active store in a real Git control harness whose plan worktree is a real
 * checkout, prepared through the DB `prepare` verb, bound to its plan session
 * and reported InReview: the state a handoff starts from.
 */
async function lifecycleFixture(label: string, route: LifecycleRoute): Promise<LifecycleFixture> {
  const repoRoot = realpathSync(mkdtempSync(join(ROOT, `${label}-`)));
  runGit(["init", "-q", "-b", "main"], repoRoot);
  runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], repoRoot);
  const harnessRoot = join(repoRoot, ".mstar");
  mkdirSync(harnessRoot, { recursive: true });
  const context: StoreContext = { harnessDir: repoRoot };
  const store = await initializeStore(context);
  store.close();
  const initialized = await initializeExecutionAuthority(context);
  const planIds = route === "integration" ? [OWN_PLAN, PEER_PLAN] : [OWN_PLAN];
  for (const planId of planIds) await registerPlan(context, planId);

  // The plan's own branch and checkout: the source_sha a handoff pins is this
  // checkout's HEAD, and the integration checkout is where the merge is proven.
  const featurePath = join(repoRoot, "wt-plan");
  runGit(["worktree", "add", "-q", "-b", `feature/${OWN_PLAN}`, featurePath], repoRoot);
  writeText(join(featurePath, "slice.txt"), "slice\n");
  runGit(["add", "-A"], featurePath);
  runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat: slice"], featurePath);
  const featureSha = headOf(featurePath);
  const baseSha = headOf(repoRoot);
  const integrationPath = join(repoRoot, "wt-integration");
  const branch: Record<string, string> | undefined =
    route === "report-only" ? undefined : { base: "main", source: `feature/${OWN_PLAN}`, target: "main" };
  if (route === "integration") {
    runGit(["worktree", "add", "-q", "-b", `integration/${OWN_PLAN}`, integrationPath], repoRoot);
    branch!.integration = `integration/${OWN_PLAN}`;
  }

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
      delivery_kind: route === "report-only" ? "verification/report-only" : "development",
      ...(route === "report-only"
        ? { completion_policy: "acceptance report", delivery: { completion: { policy: "acceptance report", evidence: "acceptance.md" } } }
        : { branch, ...(route === "integration" ? { integration_worktree_path: integrationPath } : {}) }),
      plans: planIds.map((planId) => ({
        id: planId,
        title: `${planId} title`,
        file: `plans/${planId}.md`,
        status: "Todo",
      })),
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
    [OWN_PLAN]: writePlanDocuments(harnessRoot, OWN_PLAN, `feature/${OWN_PLAN}`, { "Worktree path": featurePath }),
  };
  if (route === "integration") {
    documents[PEER_PLAN] = writePlanDocuments(harnessRoot, PEER_PLAN, `feature/${PEER_PLAN}`, {
      "Worktree path": join(repoRoot, "wt-peer"),
    });
  }
  const fixture = {
    context,
    harnessRoot,
    storeId: created.storeId,
    epoch: created.epoch,
    planTokens: (await readExecutionState(context)).data.workflows[0]!.planTokens,
    coordinator: coordinator.data,
    coordinatorCaller,
    coordinatorSeat: { caller: coordinatorCaller, session: coordinator.data },
    documents,
    route,
    repoRoot,
    featurePath,
    featureSha,
    integrationPath,
    baseSha,
    evidence: { [OWN_PLAN]: planEvidenceOf(harnessRoot, OWN_PLAN) },
    seat: undefined as unknown as Seat,
  } as LifecycleFixture;
  await prepareExecutionPlan(domainContext(context, coordinatorCaller), {
    operationId: `prepare-${label}`,
    session: fixture.coordinator,
    expected: fixture.planTokens[OWN_PLAN]!,
    planId: OWN_PLAN,
    operation: { kind: "prepare", assignmentPath: documents[OWN_PLAN]!.assignmentPath },
  });
  fixture.seat = (await planSeat(fixture, OWN_PLAN, PLAN_PM_ID, `life-${label}`)) as Seat;
  await lifecycleProgress(fixture, fixture.seat, OWN_PLAN, `progress-${label}`, "InReview", await planTokenOf(fixture, OWN_PLAN));
  return fixture;
}

/** §3 one PUBLISHED `mutateExecutionPlan` call, at the token read right now. */
async function planMutation(
  fixture: LifecycleFixture,
  who: Seat,
  planId: string,
  operationId: string,
  operation: Record<string, unknown>,
  expected?: ExecutionToken,
) {
  return publishedMutateExecutionPlan(domainContext(fixture.context, who.caller), {
    operationId,
    session: who.session,
    expected: expected ?? (await planTokenOf(fixture, planId)),
    planId,
    operation,
  } as never);
}

/** §3 one progress report of an addressed plan. */
function lifecycleProgress(
  fixture: LifecycleFixture,
  who: Seat,
  planId: string,
  operationId: string,
  status: string,
  expected: ExecutionToken,
  summary = "working",
) {
  return progressExecutionPlan(domainContext(fixture.context, who.caller), {
    operationId,
    session: who.session,
    expected,
    planId,
    operation: { kind: "progress", progress: { status, summary, evidence_paths: [] } },
  });
}

/** Handoff then accept: the state complete and integration start from. */
async function acceptedAttempt(fixture: LifecycleFixture, label: string): Promise<string> {
  const handed = await planMutation(fixture, fixture.seat, OWN_PLAN, `handoff-${label}`, {
    kind: "handoff",
    evidence: handoffEvidenceOf(fixture),
  });
  const handoffId = handed.data.coordination!.handoff!.id;
  await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, `accept-${label}`, { kind: "accept", handoffId });
  return handoffId;
}

/** Handoff, accept then integration-start: an attempt whose merge never ran. */
async function startedAttempt(fixture: LifecycleFixture, label: string): Promise<string> {
  const handoffId = await acceptedAttempt(fixture, label);
  await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, `integration-start-${label}`, {
    kind: "integration-start",
    handoffId,
  });
  return handoffId;
}

/** The coordinator merge: a real two-parent merge of the pinned source. */
function mergeIntoIntegration(fixture: LifecycleFixture): string {
  runGit(
    ["-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--no-ff", fixture.featureSha, "-m", "Merge plan"],
    fixture.integrationPath,
  );
  return headOf(fixture.integrationPath);
}

/**
 * Plant one merge-lease row. No W4 verb produces a claim held by ANOTHER
 * session, so the states a crash/recovery leaves behind (a claim naming a
 * stopped holder, or a live holder that is not the caller) are planted here —
 * exactly the way the legacy fixtures plant a foreign `integration_merge_lease`.
 */
function plantMergeLease(context: StoreContext, epoch: number, lease: Record<string, unknown>): void {
  withRaw(context, (db) => {
    db.prepare(
      "insert or replace into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) " +
        "values (?, 1, ?, ?)",
    ).run(WORKFLOW_ID, epoch, JSON.stringify(lease));
  });
}

function mergeLeaseRowOf(context: StoreContext): Record<string, unknown> {
  const [row] = rows(
    context,
    `select lease_json, revision from execution_integration_leases where workflow_id = '${WORKFLOW_ID}'`,
  );
  if (row === undefined) throw new Error("the workflow holds no integration merge lease row");
  return { lease: parsedJson(row.lease_json), revision: row.revision };
}

/** Every catalog row the completion must leave untouched. */
function catalogFootprint(context: StoreContext): Record<string, unknown> {
  const [row] = rows(
    context,
    "select (select count(*) as n from catalog_entities) as entities, " +
      "(select count(*) as n from catalog_links) as links, " +
      "(select count(*) as n from catalog_operations) as operations, " +
      "(select count(*) as n from catalog_execution_bindings) as bindings, " +
      "(select group_concat(id || '@' || revision) as entities_digest from catalog_entities) as digest",
  );
  return row!;
}

/** The accepted state a plan's row and its leases hold, without the frame's own receipts. */
function planStateFootprint(context: StoreContext, planId: string): Record<string, unknown> {
  const footprint = planFootprint(context, planId);
  return {
    plan_state: footprint.plan_state,
    plan_coordination: footprint.plan_coordination,
    plan_revision: footprint.plan_revision,
    own_lease: footprint.own_lease,
    merge_lease: rows(
      context,
      `select lease_json from execution_integration_leases where workflow_id = '${WORKFLOW_ID}'`,
    )[0]?.lease_json ?? null,
  };
}

describe("execution-handoff-integration: §3/§D/§E handoff, accept, return and completion", () => {
  test("handoff seals the reviewed evidence and accept moves the plan's ownership to the coordinator", async () => {
    const fixture = await lifecycleFixture("handoff-accept", "integration");
    const { context } = fixture;
    const evidence = fixture.evidence[OWN_PLAN]!;
    // §3 the published entry point pinned VERBATIM: this binding is the
    // signature the primary spec declares, and the value is the module's own
    // implementation rather than a wrapper.
    const planSurface: (
      context: ExecutionContext,
      request: ExecutionMutation & { planId: string; operation: CoordinationOperation },
    ) => Promise<ExecutionReceipt<ExecutionPlanView>> = publishedMutateExecutionPlan;
    expect(planSurface).toBe(mutateExecutionPlan);
    expect(publishedMutateExecutionPlan.length).toBe(2);

    const sealed = await planMutation(fixture, fixture.seat, OWN_PLAN, "handoff-1", {
      kind: "handoff",
      evidence: handoffEvidenceOf(fixture),
    });
    expect(sealed.replayed).toBe(false);
    const handoff = sealed.data.coordination!.handoff!;
    expect(handoff).toMatchObject({
      state: "submitted",
      attempt: 1,
      submitted_by: PLAN_PM_ID,
      source_branch: `feature/${OWN_PLAN}`,
      source_sha: fixture.featureSha,
      worktree_path: fixture.featurePath,
      review_base: fixture.baseSha,
      review_head: fixture.featureSha,
    });
    expect(handoff.qc.decision).toBe("Approve");
    expect(handoff.qa).toMatchObject({ gate: "mandatory", decision: "pass" });
    // §D the sealed refs are the exact bytes of the reviewed files.
    for (const ref of [...handoff.qc.reports, handoff.qc.consolidated, handoff.qa.report]) {
      expect(ref.sha256).toBe(sha256Of(ref.path));
    }
    expect(handoff.qa.report.sha256).toBe(sha256Of(evidence.qa));
    // Handoff is not release: the plan session keeps its lease and the row stays
    // InReview for the coordinator.
    expect(sealed.data.executionLease).toMatchObject({ holder: PLAN_PM_ID, status: "held" });
    expect(sealed.data.plan.status).toBe("InReview");
    expect(sealed.data.session!.sessionId).toBe(PLAN_PM_ID);

    // A report rewritten after the seal refuses: the digests are re-checked
    // inside the accepting transaction.
    writeText(evidence.qc[0]!, "# rewritten after handoff\n");
    const stale = await refusalOf(() =>
      planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "accept-stale", { kind: "accept", handoffId: handoff.id }),
    );
    expect(stale.code).toBe("coordination.evidence-stale");
    writeText(evidence.qc[0]!, "# qc report\n");

    const accepted = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "accept-1", {
      kind: "accept",
      handoffId: handoff.id,
    });
    expect(accepted.data.coordination!.handoff).toMatchObject({
      id: handoff.id,
      state: "accepted",
      accepted_by: COORDINATOR_ID,
    });
    // Ownership transferred in the same transaction: the plan's execution lease
    // is the coordinator's now, and the row is still InReview.
    expect(accepted.data.executionLease).toMatchObject({
      holder: COORDINATOR_ID,
      holder_role: "coordinator",
      status: "held",
      working_branch: `feature/${OWN_PLAN}`,
    });
    expect(accepted.data.plan.status).toBe("InReview");

    // The plan session no longer owns the row, and the handoff owns its next
    // transition: neither a progress report nor a second handoff is admitted.
    const displaced = await refusalOf(async () =>
      lifecycleProgress(fixture, fixture.seat, OWN_PLAN, "progress-after-accept", "InReview", await planTokenOf(fixture, OWN_PLAN)),
    );
    expect(displaced.code).toBe("coordination.session-mismatch");
    // The lease gate precedes the handoff gate on a plan-owned write, exactly as
    // the file route's row binding does: the plan session no longer holds it.
    const second = await refusalOf(() =>
      planMutation(fixture, fixture.seat, OWN_PLAN, "handoff-again", { kind: "handoff", evidence: handoffEvidenceOf(fixture) }),
    );
    expect(second.code).toBe("coordination.session-mismatch");
  });

  test("return restores the plan session's ownership of its own plan", async () => {
    const fixture = await lifecycleFixture("return-ownership", "integration");
    const first = await acceptedAttempt(fixture, "return-first");

    const returned = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "return-accepted", {
      kind: "return",
      handoffId: first,
      reason: "rework the slice",
    });
    expect(returned.data.coordination!.handoff).toMatchObject({
      id: first,
      state: "returned",
      return_reason: "rework the slice",
    });
    expect(returned.data.plan.status).toBe("InProgress");
    // The lease followed the record back to the session that submitted it.
    expect(returned.data.executionLease).toMatchObject({ holder: PLAN_PM_ID, holder_role: "plan-pm", status: "held" });

    // The plan session owns the row again: it reports status, hands off again
    // and the second attempt is a new one.
    await lifecycleProgress(fixture, fixture.seat, OWN_PLAN, "progress-again", "InReview", await planTokenOf(fixture, OWN_PLAN));
    const second = await planMutation(fixture, fixture.seat, OWN_PLAN, "handoff-second", {
      kind: "handoff",
      evidence: handoffEvidenceOf(fixture),
    });
    expect(second.data.coordination!.handoff!.attempt).toBe(2);
    expect(second.data.coordination!.handoff!.id).not.toBe(first);

    // A return of a SUBMITTED attempt only proves the submitter still holds its
    // own lease: nothing moves, and the row is InProgress again.
    const secondId = second.data.coordination!.handoff!.id;
    const returnedAgain = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "return-submitted", {
      kind: "return",
      handoffId: secondId,
      reason: "still not ready",
    });
    expect(returnedAgain.data.executionLease).toMatchObject({ holder: PLAN_PM_ID, status: "held" });
    expect(returnedAgain.data.coordination!.handoff).toMatchObject({ id: secondId, state: "returned" });

    // A plan session can never return: the coordinator verbs are coordinator-only.
    const wrongSeat = await refusalOf(() =>
      planMutation(fixture, fixture.seat, OWN_PLAN, "return-wrong-seat", {
        kind: "return",
        handoffId: secondId,
        reason: "not mine to return",
      }),
    );
    expect(wrongSeat.code).toBe("coordination.session-role");
  });

  test("the merge lease is exclusive and stale Git evidence blocks completion", async () => {
    const fixture = await lifecycleFixture("merge-lease", "integration");
    const { context } = fixture;
    const handoffId = await acceptedAttempt(fixture, "merge-lease");

    const started = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "integration-start-1", {
      kind: "integration-start",
      handoffId,
    });
    expect(started.data.coordination!.handoff!.state).toBe("integrating");
    expect(started.data.coordination!.handoff!.integration).toMatchObject({
      target_branch: `integration/${OWN_PLAN}`,
      worktree_path: fixture.integrationPath,
      base_sha: fixture.baseSha,
    });
    expect(started.data.coordination!.handoff!.integration!.result_sha).toBeUndefined();
    expect(started.data.integrationLease).toMatchObject({
      holder: COORDINATOR_ID,
      plan_id: OWN_PLAN,
      source_branch: `feature/${OWN_PLAN}`,
      target_branch: `integration/${OWN_PLAN}`,
    });
    expect(mergeLeaseRowOf(context).lease).toMatchObject({ status: "held", holder: COORDINATOR_ID });

    // A started attempt is re-verified, never re-pinned — and the accepted
    // operation still spends exactly ONE plan revision, so the token it returns
    // is the post-advance CAS rather than the one it was called with (§3.1).
    const beforeRetry = planFootprint(context, OWN_PLAN);
    const retryToken = await planTokenOf(fixture, OWN_PLAN);
    const retry = await planMutation(
      fixture,
      fixture.coordinatorSeat,
      OWN_PLAN,
      "integration-start-retry",
      { kind: "integration-start", handoffId },
      retryToken,
    );
    expect(retry.replayed).toBe(false);
    expect(retry.data.coordination).toEqual({
      ...started.data.coordination,
      revision: Number(beforeRetry.plan_revision) + 1,
    });
    expect(retry.data.integrationLease).toEqual(started.data.integrationLease);
    expect(retry.token).not.toBe(retryToken);
    expect(retry.token).toBe(await planTokenOf(fixture, OWN_PLAN));
    const afterRetry = planFootprint(context, OWN_PLAN);
    expect(Number(afterRetry.plan_revision)).toBe(Number(beforeRetry.plan_revision) + 1);
    expect(Number(afterRetry.store_revision)).toBe(Number(beforeRetry.store_revision) + 1);

    // The SAME operation id is the exact replay: its recorded receipt comes
    // back and neither the plan nor the shared store advances again.
    const settledFootprint = planStateFootprint(context, OWN_PLAN);
    const exact = await planMutation(
      fixture,
      fixture.coordinatorSeat,
      OWN_PLAN,
      "integration-start-retry",
      { kind: "integration-start", handoffId },
      retryToken,
    );
    expect(exact.replayed).toBe(true);
    expect(exact.token).toBe(retry.token);
    expect(planFootprint(context, OWN_PLAN)).toEqual(afterRetry);
    expect(planStateFootprint(context, OWN_PLAN)).toEqual(settledFootprint);

    // Nothing is proven by intent.
    const premature = await refusalOf(() =>
      planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "integration-accept-early", {
        kind: "integration-accept",
        handoffId,
      }),
    );
    expect(premature.code).toBe("coordination.integration-unresolved");

    // The coordinator merges what it claims.
    const mergeSha = mergeIntoIntegration(fixture);

    // Exclusivity 1: a LIVE foreign holder refuses a PROVEN merge, however old
    // its claim is — the age of a claim authorizes nothing.
    plantMergeLease(context, fixture.epoch, {
      holder: PLAN_PM_ID,
      claimed_at: "2020-01-01T00:00:00Z",
      plan_id: OWN_PLAN,
      source_branch: `feature/${OWN_PLAN}`,
      target_branch: `integration/${OWN_PLAN}`,
      status: "held",
    });
    const liveHolder = await refusalOf(() =>
      planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "integration-accept-live-holder", {
        kind: "integration-accept",
        handoffId,
      }),
    );
    expect(liveHolder.code).toBe("coordination.session-mismatch");

    // Exclusivity 2: a claim naming ANOTHER attempt is never reused or released
    // — and the refusal is the HOLDER's, in the file route's own admission order
    // (`coordination.ts` `assertMergeLease` checks the holder before the plan and
    // source it names). The claim is untouched by the refused verb.
    const foreignClaim = {
      holder: PLAN_PM_ID,
      claimed_at: TS,
      plan_id: PEER_PLAN,
      source_branch: `feature/${PEER_PLAN}`,
      target_branch: `integration/${PEER_PLAN}`,
      status: "held",
    };
    plantMergeLease(context, fixture.epoch, foreignClaim);
    const foreign = await refusalOf(() =>
      planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "integration-accept-foreign", {
        kind: "integration-accept",
        handoffId,
      }),
    );
    expect(foreign).toMatchObject({
      code: "coordination.session-mismatch",
      details: { holder: PLAN_PM_ID, session_id: COORDINATOR_ID, operation: "integration-accept" },
    });
    expect(mergeLeaseRowOf(context).lease).toEqual(foreignClaim);

    // This attempt's own claim restored, and the merge it really ran.
    plantMergeLease(context, fixture.epoch, {
      holder: COORDINATOR_ID,
      claimed_at: TS,
      plan_id: OWN_PLAN,
      source_branch: `feature/${OWN_PLAN}`,
      target_branch: `integration/${OWN_PLAN}`,
      status: "held",
    });
    const merged = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "integration-accept-1", {
      kind: "integration-accept",
      handoffId,
    });
    expect(merged.data.coordination!.handoff!.state).toBe("merged");
    expect(merged.data.coordination!.handoff!.integration!.result_sha).toBe(mergeSha);
    // Both leases and InReview survive the merge: complete is the release.
    expect(merged.data.plan.status).toBe("InReview");
    expect(merged.data.executionLease).toMatchObject({ holder: COORDINATOR_ID, status: "held" });
    expect(merged.data.integrationLease).toMatchObject({ holder: COORDINATOR_ID, status: "held" });

    // Stale Git evidence blocks completion: the branch no longer reaches the
    // recorded merge, so nothing is proven and nothing is written.
    runGit(["reset", "-q", "--hard", fixture.baseSha], fixture.integrationPath);
    const before = planStateFootprint(context, OWN_PLAN);
    const staleGit = await refusalOf(() =>
      planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "complete-stale-git", { kind: "complete", handoffId }),
    );
    expect(staleGit.code).toBe("coordination.integration-diverged");
    expect(planStateFootprint(context, OWN_PLAN)).toEqual(before);

    // ... and so does a report rewritten after the merge was accepted.
    runGit(["reset", "-q", "--hard", mergeSha], fixture.integrationPath);
    writeText(fixture.evidence[OWN_PLAN]!.qc[1]!, "# rewritten before completion\n");
    const staleEvidence = await refusalOf(() =>
      planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "complete-stale-evidence", { kind: "complete", handoffId }),
    );
    expect(staleEvidence.code).toBe("coordination.evidence-stale");
    expect(planStateFootprint(context, OWN_PLAN)).toEqual(before);
    writeText(fixture.evidence[OWN_PLAN]!.qc[1]!, "# qc report\n");

    // A completed attempt's reconcile is a DOMAIN replay: it never resurrects
    // ownership or rewrites the completed state — and the accepted operation
    // still advances the addressed plan exactly once and returns that CAS.
    const done = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "complete-1", { kind: "complete", handoffId });
    expect(done.data.plan.status).toBe("Done");
    const acceptedState = planStateFootprint(context, OWN_PLAN);
    const acceptedFootprint = planFootprint(context, OWN_PLAN);
    const replayToken = await planTokenOf(fixture, OWN_PLAN);
    const replay = await planMutation(
      fixture,
      fixture.coordinatorSeat,
      OWN_PLAN,
      "reconcile-replay",
      { kind: "reconcile", handoffId },
      replayToken,
    );
    expect(replay.replayed).toBe(false);
    expect(replay.data.plan.status).toBe("Done");
    expect(planStateFootprint(context, OWN_PLAN)).toEqual({
      ...acceptedState,
      plan_revision: Number(acceptedFootprint.plan_revision) + 1,
    });
    const replayFootprint = planFootprint(context, OWN_PLAN);
    expect(Number(replayFootprint.plan_revision)).toBe(Number(acceptedFootprint.plan_revision) + 1);
    expect(Number(replayFootprint.store_revision)).toBe(Number(acceptedFootprint.store_revision) + 1);
    expect(replay.token).toBe(await planTokenOf(fixture, OWN_PLAN));

    // ... and the SAME id replays exactly: nothing advances a second time.
    const exactReplay = await planMutation(
      fixture,
      fixture.coordinatorSeat,
      OWN_PLAN,
      "reconcile-replay",
      { kind: "reconcile", handoffId },
      replayToken,
    );
    expect(exactReplay.replayed).toBe(true);
    expect(exactReplay.token).toBe(replay.token);
    expect(planFootprint(context, OWN_PLAN)).toEqual(replayFootprint);
  });

  test("every lifecycle verb admits the merge lease holder-first, as the file route does", async () => {
    const fixture = await lifecycleFixture("merge-lease-holder-first", "integration");
    const { context } = fixture;
    const handoffId = await acceptedAttempt(fixture, "holder-first");
    // ONE claim, held by a session this workflow holds ACTIVE, naming a
    // DIFFERENT attempt. The file route answers with the holder's own refusal
    // (`coordination.ts` `assertMergeLease` → `coordination.session-mismatch`)
    // before it ever judges the plan and source the claim names, so every DB
    // verb must answer with that same code for this same state.
    const foreignClaim = {
      holder: PLAN_PM_ID,
      claimed_at: TS,
      plan_id: PEER_PLAN,
      source_branch: `feature/${PEER_PLAN}`,
      target_branch: `integration/${PEER_PLAN}`,
      status: "held",
    };
    // Every verb's answer, collected so the ONE code this state has is compared
    // across all four routes rather than asserted route by route.
    const answers: Record<string, unknown> = {};
    const refuseForeign = async (operationId: string, operation: Record<string, unknown>, verb: string) => {
      const refusal = await refusalOf(() => planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, operationId, operation));
      answers[verb] = { code: refusal.code, details: refusal.details };
      // No verb moved, re-pinned or released the claim it was refused.
      expect(mergeLeaseRowOf(context).lease).toEqual(foreignClaim);
    };

    plantMergeLease(context, fixture.epoch, foreignClaim);
    await refuseForeign("holder-first-start", { kind: "integration-start", handoffId }, "integration-start");

    // The attempt really starts under its OWN claim, then merges.
    withRaw(context, (db) =>
      db.prepare("delete from execution_integration_leases where workflow_id = ?").run(WORKFLOW_ID),
    );
    await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "holder-first-start-own", {
      kind: "integration-start",
      handoffId,
    });
    mergeIntoIntegration(fixture);

    // A PROVEN merge, so both remaining verbs reach their lease admission.
    plantMergeLease(context, fixture.epoch, foreignClaim);
    await refuseForeign("holder-first-accept", { kind: "integration-accept", handoffId }, "integration-accept");
    await refuseForeign("holder-first-reconcile", { kind: "reconcile", handoffId }, "reconcile");

    // This attempt's own claim restored: the merge is accepted and recorded.
    plantMergeLease(context, fixture.epoch, {
      holder: COORDINATOR_ID,
      claimed_at: TS,
      plan_id: OWN_PLAN,
      source_branch: `feature/${OWN_PLAN}`,
      target_branch: `integration/${OWN_PLAN}`,
      status: "held",
    });
    await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "holder-first-accept-own", {
      kind: "integration-accept",
      handoffId,
    });

    // The completion the foreign claim would have authorized never happens.
    plantMergeLease(context, fixture.epoch, foreignClaim);
    const beforeComplete = planStateFootprint(context, OWN_PLAN);
    await refuseForeign("holder-first-complete", { kind: "complete", handoffId }, "complete");
    expect(planStateFootprint(context, OWN_PLAN)).toEqual(beforeComplete);

    // ONE state, ONE answer: whichever the claim's plan/source says, the holder
    // decides first on every verb — the file route's observable code.
    const refusal = (verb: string) => ({
      code: "coordination.session-mismatch",
      details: { plan_id: OWN_PLAN, holder: PLAN_PM_ID, session_id: COORDINATOR_ID, operation: verb },
    });
    expect(answers).toEqual({
      "integration-start": refusal("integration-start"),
      "integration-accept": refusal("integration-accept"),
      reconcile: refusal("reconcile"),
      complete: refusal("complete"),
    });

    // The holder matched — a claim THIS session holds for ANOTHER attempt — so
    // the claim's own plan and source decide, and the refusal carries them. One
    // state, one answer per branch; neither branch reuses or releases the claim.
    plantMergeLease(context, fixture.epoch, { ...foreignClaim, holder: COORDINATOR_ID });
    const ownForeign = await refusalOf(() =>
      planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "holder-first-own-foreign", { kind: "complete", handoffId }),
    );
    expect(ownForeign).toMatchObject({
      code: "coordination.invalid-transition",
      details: {
        plan_id: OWN_PLAN,
        holder_plan_id: PEER_PLAN,
        holder_source_branch: `feature/${PEER_PLAN}`,
        source_branch: `feature/${OWN_PLAN}`,
        operation: "complete",
      },
    });
    expect(mergeLeaseRowOf(context).lease).toMatchObject({ holder: COORDINATOR_ID, plan_id: PEER_PLAN });
  }, 30000);

  test("complete commits Done, the completed handoff and both releases in one transaction and deletes no catalog row", async () => {
    const fixture = await lifecycleFixture("complete-delta", "integration");
    const { context } = fixture;
    const handoffId = await startedAttempt(fixture, "complete-delta");
    const mergeSha = mergeIntoIntegration(fixture);
    await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "integration-accept-delta", {
      kind: "integration-accept",
      handoffId,
    });

    const catalogBefore = catalogFootprint(context);
    const rootBefore = planFootprint(context, OWN_PLAN).root_revision;
    const registryBefore = rows(context, "select count(*) as n from execution_registry")[0]!.n;
    const workflowBefore = parsedJson(rows(context, "select state_json from execution_workflows")[0]!.state_json);

    const done = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "complete-delta", {
      kind: "complete",
      handoffId,
    });
    expect(done.data.plan.status).toBe("Done");
    expect(done.data.coordination!.handoff).toMatchObject({ id: handoffId, state: "completed" });
    expect(typeof done.data.coordination!.handoff!.completed_at).toBe("string");
    expect(done.data.coordination!.handoff!.integration!.result_sha).toBe(mergeSha);
    // The two releases are part of the SAME commit: the execution lease is a
    // §3.1 tombstone and the merge lease is unclaimed with its release recorded.
    expect(done.data.executionLease).toMatchObject({ status: "released", released_by: COORDINATOR_ID });
    expect(done.data.integrationLease).toBeNull();
    expect(mergeLeaseRowOf(context).lease).toMatchObject({
      status: "released",
      prior_holder: COORDINATOR_ID,
      released_by: COORDINATOR_ID,
      plan_id: OWN_PLAN,
    });
    // The retained scope metadata is what authorizes cleanup afterwards.
    expect(done.data.plan.metadata).toMatchObject({
      working_branch: `feature/${OWN_PLAN}`,
      worktree_path: fixture.featurePath,
    });

    // Terminal membership changed in that one transaction: a fresh read agrees.
    const fresh = await readExecutionPlan(domainContext(context, fixture.coordinatorCaller), fixture.coordinator, OWN_PLAN);
    expect(fresh.data.plan.status).toBe("Done");
    expect(fresh.data.coordination!.handoff!.state).toBe("completed");
    expect(fresh.data.executionLease).toMatchObject({ status: "released" });

    // No catalog row was deleted or rewritten, the workflow's registration is
    // intact, and the plan's terminal state is NOT the lifecycle's: the
    // workflow-level close is a separate transition (W6).
    expect(catalogFootprint(context)).toEqual(catalogBefore);
    expect(rows(context, "select count(*) as n from execution_registry")[0]!.n).toBe(registryBefore);
    expect(planFootprint(context, OWN_PLAN).root_revision).toBe(rootBefore);
    expect(parsedJson(rows(context, "select state_json from execution_workflows")[0]!.state_json)).toEqual(workflowBefore);

    // The plan session no longer owns anything on the completed row.
    const after = await refusalOf(async () =>
      lifecycleProgress(fixture, fixture.seat, OWN_PLAN, "progress-after-done", "InProgress", await planTokenOf(fixture, OWN_PLAN)),
    );
    expect(after.code).toBe("coordination.invalid-transition");
  });

  test("standalone completion needs no integration record, and an iteration attempt is never completed by it", async () => {
    // An iteration attempt that has not merged is not completable: the standalone
    // route is a different lifecycle, not a fallback for a missing integration.
    const iteration = await lifecycleFixture("complete-route", "integration");
    const unmerged = await acceptedAttempt(iteration, "route");
    const premature = await refusalOf(() =>
      planMutation(iteration, iteration.coordinatorSeat, OWN_PLAN, "complete-unmerged", {
        kind: "complete",
        handoffId: unmerged,
      }),
    );
    expect(premature.code).toBe("coordination.invalid-transition");
    expect(String(premature.message)).toContain("merged");

    // A single-row standalone development workflow completes with no integration
    // record anywhere, and its lifecycle stays running for the workflow close.
    const standalone = await lifecycleFixture("complete-standalone", "development");
    expect(standalone.route).toBe("development");
    const handoffId = await acceptedAttempt(standalone, "standalone");
    const done = await planMutation(standalone, standalone.coordinatorSeat, OWN_PLAN, "complete-standalone", {
      kind: "complete",
      handoffId,
    });
    expect(done.data.plan.status).toBe("Done");
    expect(done.data.coordination!.handoff!.state).toBe("completed");
    expect(done.data.coordination!.handoff!.integration).toBeUndefined();
    expect(done.data.integrationLease).toBeNull();
    expect(rows(standalone.context, "select count(*) as n from execution_integration_leases")[0]!.n).toBe(0);
    expect(done.data.executionLease).toMatchObject({ status: "released" });
    expect(
      parsedJson(rows(standalone.context, "select state_json from execution_workflows")[0]!.state_json).status,
    ).toBe("running");
  });

  test("report-only completion uses matching policy evidence, releases only its own lease, and reconciles completed state", async () => {
    const fixture = await lifecycleFixture("complete-report-only", "report-only");
    const handoffId = await acceptedAttempt(fixture, "report-only");
    const done = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "complete-report-only", {
      kind: "complete",
      handoffId,
    });
    expect(done.data.plan.status).toBe("Done");
    expect(done.data.coordination!.handoff!.state).toBe("completed");
    expect(done.data.coordination!.handoff!.integration).toBeUndefined();
    expect(done.data.executionLease).toMatchObject({ status: "released", released_by: COORDINATOR_ID });
    expect(done.data.integrationLease).toBeNull();
    const completedAt = done.data.coordination!.handoff!.completed_at;
    const state = planStateFootprint(fixture.context, OWN_PLAN);
    const token = await planTokenOf(fixture, OWN_PLAN);
    const replay = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "reconcile-report-only", {
      kind: "reconcile",
      handoffId,
    }, token);
    expect(replay.data.plan.status).toBe("Done");
    expect(replay.data.coordination!.handoff!.completed_at).toBe(completedAt);
    expect(replay.data.executionLease).toMatchObject({ status: "released" });
    expect(planStateFootprint(fixture.context, OWN_PLAN)).toEqual({
      ...state,
      plan_revision: Number(state.plan_revision) + 1,
    });
    const exact = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "reconcile-report-only", {
      kind: "reconcile",
      handoffId,
    }, token);
    expect(exact.replayed).toBe(true);
  });

  test("report-only completion rechecks policy at the transaction boundary and preserves rejected state", async () => {
    const fixture = await lifecycleFixture("complete-report-only-drift", "report-only");
    const handoffId = await acceptedAttempt(fixture, "report-only-drift");
    const before = planStateFootprint(fixture.context, OWN_PLAN);
    setCompleteWitnessGapForTest(() => {
      withRaw(fixture.context, (db) => {
        const row = db.prepare("select state_json from execution_workflows where workflow_id = ?").get(WORKFLOW_ID) as { state_json: string };
        const snapshot = JSON.parse(row.state_json) as Record<string, unknown>;
        snapshot.completion_policy = "changed policy";
        db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(snapshot), WORKFLOW_ID);
      });
    });
    try {
      const refusal = await refusalOf(() => planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "complete-report-only-drift", {
        kind: "complete",
        handoffId,
      }));
      expect(refusal.code).toBe("coordination.invalid-transition");
      expect(planStateFootprint(fixture.context, OWN_PLAN)).toEqual(before);
    } finally {
      setCompleteWitnessGapForTest(undefined);
    }
  });

  test("an integration branch moved between the completion proof and its commit refuses with no DB mutation", async () => {
    // §4.1 the proof attests the ref state it was read from; the commit window
    // re-reads those exact bytes, so a Git move after the proof cannot ride into
    // a committed `Done`. This is the DB twin of the file route's
    // `setCompleteStandaloneMutateGapForTest` regression.
    const iteration = await lifecycleFixture("complete-race-iteration", "integration");
    const handoffId = await startedAttempt(iteration, "race-iteration");
    mergeIntoIntegration(iteration);
    await planMutation(iteration, iteration.coordinatorSeat, OWN_PLAN, "race-iteration-accept", {
      kind: "integration-accept",
      handoffId,
    });
    const before = planStateFootprint(iteration.context, OWN_PLAN);
    const footprint = planFootprint(iteration.context, OWN_PLAN);
    setCompleteWitnessGapForTest(() => {
      runGit(["reset", "-q", "--hard", iteration.baseSha], iteration.integrationPath);
    });
    try {
      const raced = await refusalOf(() =>
        planMutation(iteration, iteration.coordinatorSeat, OWN_PLAN, "complete-race-iteration", {
          kind: "complete",
          handoffId,
        }),
      );
      // The same code the same observation raises when it is seen before the
      // transaction: the recorded result no longer hangs off the moved target.
      expect(raced.code).toBe("coordination.integration-diverged");
      // Nothing of the frame survives: no plan/store/workflow revision, no
      // operation receipt, no domain change, and the row is still InReview.
      expect(planFootprint(iteration.context, OWN_PLAN)).toEqual(footprint);
      expect(planStateFootprint(iteration.context, OWN_PLAN)).toEqual(before);
      expect(
        parsedJson(rows(iteration.context, `select state_json from execution_plans where plan_id = '${OWN_PLAN}'`)[0]!.state_json)
          .status,
      ).toBe("InReview");
    } finally {
      setCompleteWitnessGapForTest(undefined);
    }
  }, 30000);

  test("a delivery branch moved between the standalone completion proof and its commit refuses with no DB mutation", async () => {
    const standalone = await lifecycleFixture("complete-race-standalone", "development");
    const handoffId = await acceptedAttempt(standalone, "race-standalone");
    const before = planStateFootprint(standalone.context, OWN_PLAN);
    const footprint = planFootprint(standalone.context, OWN_PLAN);
    setCompleteWitnessGapForTest(() => {
      runGit(
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "advance"],
        standalone.featurePath,
      );
    });
    try {
      const raced = await refusalOf(() =>
        planMutation(standalone, standalone.coordinatorSeat, OWN_PLAN, "complete-race-standalone", {
          kind: "complete",
          handoffId,
        }),
      );
      expect(raced.code).toBe("coordination.git-proof");
      expect(planFootprint(standalone.context, OWN_PLAN)).toEqual(footprint);
      expect(planStateFootprint(standalone.context, OWN_PLAN)).toEqual(before);
      expect(
        parsedJson(rows(standalone.context, `select state_json from execution_plans where plan_id = '${OWN_PLAN}'`)[0]!.state_json)
          .status,
      ).toBe("InReview");
    } finally {
      setCompleteWitnessGapForTest(undefined);
    }
  }, 30000);

  /**
   * §7/R10 one refused completion: either a deterministic drift inside the
   * preflight→commit window (the sealed Git proof is re-read immediately before
   * the commit) or a topology the capture refuses before the transaction. Both
   * must leave the plan exactly where the acceptance left it — still InReview,
   * no `Done`, no completion receipt, the handoff still accepted and the
   * execution lease still held.
   */
  async function expectCompletionRaceRefused(
    standalone: LifecycleFixture,
    label: string,
    handoffId: string,
    drift?: () => void,
  ): Promise<void> {
    const before = planStateFootprint(standalone.context, OWN_PLAN);
    const footprint = planFootprint(standalone.context, OWN_PLAN);
    if (drift !== undefined) setCompleteWitnessGapForTest(drift);
    try {
      const raced = await refusalOf(() =>
        planMutation(standalone, standalone.coordinatorSeat, OWN_PLAN, `complete-race-${label}`, {
          kind: "complete",
          handoffId,
        }),
      );
      // The delivery source is not an integration attempt, so the moved proof
      // reports the same code the same observation reports before the commit.
      expect(raced.code).toBe("coordination.git-proof");
      // No revision advances, no operation receipt lands, no lease is released
      // and no domain change survives.
      expect(planFootprint(standalone.context, OWN_PLAN)).toEqual(footprint);
      expect(planStateFootprint(standalone.context, OWN_PLAN)).toEqual(before);
      expect(
        parsedJson(rows(standalone.context, `select state_json from execution_plans where plan_id = '${OWN_PLAN}'`)[0]!.state_json)
          .status,
      ).toBe("InReview");
      expect(
        parsedJson(rows(standalone.context, `select coordination_json from execution_plans where plan_id = '${OWN_PLAN}'`)[0]!
          .coordination_json).handoff,
      ).toMatchObject({ id: handoffId, state: "accepted" });
    } finally {
      setCompleteWitnessGapForTest(undefined);
    }
  }

  test("complete refuses a tracked file rewritten between the proof and its commit, with no DB mutation", async () => {
    const standalone = await lifecycleFixture("complete-drift-worktree", "development");
    const handoffId = await acceptedAttempt(standalone, "drift-worktree");
    await expectCompletionRaceRefused(standalone, "drift-worktree", handoffId, () => {
      writeFileSync(join(standalone.featurePath, "slice.txt"), "rewritten after the proof\n");
    });
  }, 30000);

  test("complete refuses an index rewritten between the proof and its commit, with no DB mutation", async () => {
    const standalone = await lifecycleFixture("complete-drift-index", "development");
    const handoffId = await acceptedAttempt(standalone, "drift-index");
    // The index alone moves: the worktree bytes and the tracked path list stay
    // exactly as the proof read them, which is what a refs-only witness missed.
    await expectCompletionRaceRefused(standalone, "drift-index", handoffId, () => {
      runGit(["update-index", "--chmod=+x", "slice.txt"], standalone.featurePath);
    });
  }, 30000);

  test("complete refuses an untracked file created between the proof and its commit, with no DB mutation", async () => {
    const standalone = await lifecycleFixture("complete-drift-untracked", "development");
    const handoffId = await acceptedAttempt(standalone, "drift-untracked");
    await expectCompletionRaceRefused(standalone, "drift-untracked", handoffId, () => {
      writeFileSync(join(standalone.featurePath, "untracked.txt"), "appeared after the proof\n");
    });
  }, 30000);

  test("complete refuses an object store repacked between the proof and its commit, with no DB mutation", async () => {
    const standalone = await lifecycleFixture("complete-drift-objects", "development");
    const handoffId = await acceptedAttempt(standalone, "drift-objects");
    // The pinned objects move from loose to packed: nothing the proof read from
    // the object store is where it read it, so the proof is stale.
    await expectCompletionRaceRefused(standalone, "drift-objects", handoffId, () => {
      runGit(["repack", "-ad"], standalone.featurePath);
    });
  }, 30000);

  test("complete refuses a file created inside a pre-existing empty directory, with no DB mutation", async () => {
    const standalone = await lifecycleFixture("complete-drift-empty-dir", "development");
    const handoffId = await acceptedAttempt(standalone, "drift-empty-dir");
    // An empty directory is invisible to `git status`, so it is a legal clean
    // state and no tracked path leads to it; the proof still has to notice a
    // path appearing inside it, exactly as the clean policy does.
    mkdirSync(join(standalone.featurePath, "empty-dir"), { recursive: true });
    await expectCompletionRaceRefused(standalone, "drift-empty-dir", handoffId, () => {
      writeFileSync(join(standalone.featurePath, "empty-dir", "child.txt"), "appeared after the proof\n");
    });
  }, 30000);

  test("complete refuses an untracked name whose kind changes at the same path, with no DB mutation", async () => {
    const standalone = await lifecycleFixture("complete-drift-kind", "development");
    const handoffId = await acceptedAttempt(standalone, "drift-kind");
    const slot = join(standalone.featurePath, "slot");
    mkdirSync(slot, { recursive: true });
    // The parent entry name stays `slot`: only its KIND moves from directory to
    // file, so a name-only inventory would not notice this dirty worktree.
    await expectCompletionRaceRefused(standalone, "drift-kind", handoffId, () => {
      rmSync(slot, { recursive: true });
      writeFileSync(slot, "now a file at the same name\n");
    });
  }, 30000);

  test("complete refuses a non-regular alternate object store, with no DB mutation", async () => {
    const standalone = await lifecycleFixture("complete-drift-alternates", "development");
    const handoffId = await acceptedAttempt(standalone, "drift-alternates");
    // §7 an alternate topology this proof cannot enumerate is refused at
    // capture rather than witnessed as an unreadable entry.
    const objects = execFileSync("git", ["-C", standalone.featurePath, "rev-parse", "--git-path", "objects"], {
      encoding: "utf8",
    }).trim();
    rmSync(join(objects, "info", "alternates"), { force: true });
    mkdirSync(join(objects, "info", "alternates"), { recursive: true });
    await expectCompletionRaceRefused(standalone, "drift-alternates", handoffId);
  }, 30000);
});

describe("execution-reconcile: §3/§4.2 crash recovery and explicit stopped-owner evidence", () => {
  test("reconcile classifies an abandoned attempt, completes a proven one, and replays read-only", async () => {
    const fixture = await lifecycleFixture("reconcile-classify", "integration");
    const { context } = fixture;
    const handoffId = await startedAttempt(fixture, "classify");

    // Started, nothing merged, base unmoved: the attempt is abandoned, not repaired.
    const retry = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "reconcile-retry", {
      kind: "reconcile",
      handoffId,
    });
    expect(retry.data.coordination!.handoff).toMatchObject({ id: handoffId, state: "accepted" });
    expect(retry.data.coordination!.handoff!.integration).toBeUndefined();
    expect(retry.data.plan.status).toBe("InReview");
    // InReview and the coordinator's execution lease stay: only the abandoned
    // attempt's own claim is released, with its release recorded.
    expect(retry.data.executionLease).toMatchObject({ holder: COORDINATOR_ID, status: "held" });
    expect(retry.data.integrationLease).toBeNull();
    expect(mergeLeaseRowOf(context).lease).toMatchObject({
      status: "released",
      prior_holder: COORDINATOR_ID,
      released_by: COORDINATOR_ID,
      release_reason: "retry-ready",
    });

    // A restarted attempt that does merge reconciles to the completion delta.
    runGit(["reset", "-q", "--hard", fixture.baseSha], fixture.integrationPath);
    const restarted = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "integration-start-again", {
      kind: "integration-start",
      handoffId,
    });
    expect(restarted.data.coordination!.handoff!.state).toBe("integrating");
    const mergeSha = mergeIntoIntegration(fixture);
    const proven = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "reconcile-proven", {
      kind: "reconcile",
      handoffId,
    });
    expect(proven.data.plan.status).toBe("Done");
    expect(proven.data.coordination!.handoff!.integration!.result_sha).toBe(mergeSha);
    expect(proven.data.executionLease).toMatchObject({ status: "released" });
    expect(proven.data.integrationLease).toBeNull();

    // A completed attempt reconciles as a DOMAIN replay: no lease, block or
    // timestamp is rewritten — and the accepted operation still advances the
    // addressed plan exactly once, returning that post-advance CAS.
    const completedState = planStateFootprint(context, OWN_PLAN);
    const completedFootprint = planFootprint(context, OWN_PLAN);
    const replayToken = await planTokenOf(fixture, OWN_PLAN);
    const replay = await planMutation(
      fixture,
      fixture.coordinatorSeat,
      OWN_PLAN,
      "reconcile-replay",
      { kind: "reconcile", handoffId },
      replayToken,
    );
    expect(replay.replayed).toBe(false);
    expect(replay.data.plan.status).toBe("Done");
    const replayedFootprint = planFootprint(context, OWN_PLAN);
    expect(Number(replayedFootprint.plan_revision)).toBe(Number(completedFootprint.plan_revision) + 1);
    expect(Number(replayedFootprint.store_revision)).toBe(Number(completedFootprint.store_revision) + 1);
    expect(replay.token).toBe(await planTokenOf(fixture, OWN_PLAN));
    // The domain state is what the completion left: only the CAS moved.
    const replayExact = await planMutation(
      fixture,
      fixture.coordinatorSeat,
      OWN_PLAN,
      "reconcile-replay",
      { kind: "reconcile", handoffId },
      replayToken,
    );
    expect(replayExact.replayed).toBe(true);
    expect(planFootprint(context, OWN_PLAN)).toEqual(replayedFootprint);
    expect(planStateFootprint(context, OWN_PLAN)).toEqual({
      ...completedState,
      plan_revision: Number(completedFootprint.plan_revision) + 1,
    });

    // A base that moved without a merge of the pinned source is divergence.
    const diverged = await lifecycleFixture("reconcile-diverged", "integration");
    const divergedId = await startedAttempt(diverged, "diverged");
    runGit(
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "unrelated"],
      diverged.integrationPath,
    );
    const divergedRefusal = await refusalOf(() =>
      planMutation(diverged, diverged.coordinatorSeat, OWN_PLAN, "reconcile-diverged", {
        kind: "reconcile",
        handoffId: divergedId,
      }),
    );
    expect(divergedRefusal.code).toBe("coordination.integration-diverged");
  });

  test("an explicit stopped-owner reconcile records the takeover, and an old claim held by a live session refuses", async () => {
    const fixture = await lifecycleFixture("reconcile-stopped", "integration");
    const { context } = fixture;
    const handoffId = await startedAttempt(fixture, "stopped");
    const ownClaim = mergeLeaseRowOf(context).lease;
    // The coordinator really merged this attempt, so the refusal that follows is
    // the merge lease's judgement and not an unproven attempt.
    const mergeSha = mergeIntoIntegration(fixture);

    // §2.3 the state a coordinator recovery leaves behind: the outstanding claim
    // still names the PRIOR holder, whose session this workflow no longer holds
    // active at this epoch. Clock age is not the evidence — the session row is.
    plantMergeLease(context, fixture.epoch, { ...ownClaim, holder: "host-coordinator-previous", claimed_at: "2020-01-01T00:00:00Z" });
    const stoppedClaim = mergeLeaseRowOf(context).lease;

    // No other verb takes over a stopped owner, and the refusal says which one does.
    const refused = await refusalOf(() =>
      planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "integration-accept-stopped", {
        kind: "integration-accept",
        handoffId,
      }),
    );
    expect(refused.code).toBe("coordination.invalid-transition");
    expect(String(refused.message)).toContain("stopped");
    expect(mergeLeaseRowOf(context).lease).toEqual(stoppedClaim);

    // The explicit reconcile succeeds, and the takeover is recorded: prior
    // holder, new holder and the decision. The proven merge completes normally.
    const reconciled = await planMutation(fixture, fixture.coordinatorSeat, OWN_PLAN, "reconcile-stopped", {
      kind: "reconcile",
      handoffId,
    });
    expect(reconciled.data.plan.status).toBe("Done");
    expect(reconciled.data.coordination!.handoff!.integration!.result_sha).toBe(mergeSha);
    expect(reconciled.data.integrationLease).toBeNull();
    const tombstone = mergeLeaseRowOf(context).lease;
    expect(tombstone).toMatchObject({
      status: "released",
      holder: "host-coordinator-previous",
      prior_holder: "host-coordinator-previous",
      released_by: COORDINATOR_ID,
    });
    expect(String(tombstone.release_reason)).toContain("stopped-owner");

    // The same ancient claim held by a LIVE session never moves on age alone.
    const live = await lifecycleFixture("reconcile-live", "integration");
    const liveId = await startedAttempt(live, "live");
    mergeIntoIntegration(live);
    plantMergeLease(live.context, live.epoch, {
      holder: PLAN_PM_ID,
      claimed_at: "2020-01-01T00:00:00Z",
      plan_id: OWN_PLAN,
      source_branch: `feature/${OWN_PLAN}`,
      target_branch: `integration/${OWN_PLAN}`,
      status: "held",
    });
    const liveClaim = mergeLeaseRowOf(live.context).lease;
    const liveRefusal = await refusalOf(() =>
      planMutation(live, live.coordinatorSeat, OWN_PLAN, "reconcile-live", { kind: "reconcile", handoffId: liveId }),
    );
    expect(liveRefusal.code).toBe("coordination.session-mismatch");
    expect(mergeLeaseRowOf(live.context).lease).toEqual(liveClaim);
  });

  test("a crash rolls back an uncommitted mutation while the persisted lease still blocks", async () => {
    const fixture = await lifecycleFixture("crash-rollback", "integration");
    const { context } = fixture;
    const before = planFootprint(context, OWN_PLAN);
    const leaseBefore = parsedJson(before.own_lease as string);

    // A process that DIES with its transaction open: the row edit and the lease
    // deletion are uncommitted when the writer is killed, exactly as a crashed
    // coordinator leaves them. SQLite rolls the whole transaction back, and the
    // lease it had persisted in an earlier committed transaction stays.
    const crashedWriter = join(ROOT, "crash-writer.cjs");
    writeFileSync(
      crashedWriter,
      [
        'const { DatabaseSync } = require("node:sqlite");',
        `const db = new DatabaseSync(${JSON.stringify(storePath(context))});`,
        'db.exec("begin immediate");',
        "db.prepare(" +
          JSON.stringify("update execution_plans set revision = revision + 5, coordination_json = ? where workflow_id = ? and plan_id = ?") +
          `).run(${JSON.stringify(JSON.stringify({ hijacked: true }))}, ${JSON.stringify(WORKFLOW_ID)}, ${JSON.stringify(OWN_PLAN)});`,
        `db.prepare("delete from execution_leases where plan_id = ?").run(${JSON.stringify(OWN_PLAN)});`,
        'process.kill(process.pid, "SIGKILL");',
      ].join("\n"),
    );
    try {
      execFileSync(process.execPath, [crashedWriter], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      // SIGKILL: the process is gone, and that is the point.
    }

    // Nothing of the crash survives, and the persisted lease is still there.
    expect(planFootprint(context, OWN_PLAN)).toEqual(before);
    expect(parsedJson(planFootprint(context, OWN_PLAN).own_lease as string)).toEqual(leaseBefore);

    // The persisted lease still blocks: no second identity takes the plan over.
    const otherCaller = trustedCaller("host-pm-other", "plan-pm", OWN_PLAN);
    const blocked = await refusalOf(async () =>
      bindExecutionSession(domainContext(context, otherCaller), {
        workflowId: WORKFLOW_ID,
        planId: OWN_PLAN,
        role: "plan-pm",
        expected: await planTokenOf(fixture, OWN_PLAN),
        operationId: "bind-after-crash",
      }),
    );
    expect(blocked.code).toBe("coordination.duplicate-holder");

    // ... and the holder it names can still work, because the crash changed none
    // of the accepted state it owns.
    const resumed = await lifecycleProgress(
      fixture,
      fixture.seat,
      OWN_PLAN,
      "progress-after-crash",
      "InReview",
      await planTokenOf(fixture, OWN_PLAN),
    );
    expect(resumed.data.coordination!.progress!.status).toBe("InReview");
  });
});

describe("execution-concurrency: §3.1/§4.1 concurrent accepted plan operations", () => {
  test("two plans mutated at once are both retained, and a conflicting write needs an explicit reread", async () => {
    const fixture = await lifecycleFixture("concurrency", "integration");
    const { context, documents, coordinatorCaller } = fixture;
    await prepareExecutionPlan(domainContext(context, coordinatorCaller), {
      operationId: "prepare-peer",
      session: fixture.coordinator,
      expected: fixture.planTokens[PEER_PLAN]!,
      planId: PEER_PLAN,
      operation: { kind: "prepare", assignmentPath: documents[PEER_PLAN]!.assignmentPath },
    });
    const peer = (await planSeat(fixture, PEER_PLAN, PEER_PM_ID, "concurrency-peer")) as Seat;

    // Two independent plans of ONE workflow, submitted at the same time: both
    // accepted operations are committed and retained, and the shared store
    // revision advances exactly once per accepted operation.
    const storeBefore = storeRevisionOf(context);
    const [own, peerReceipt] = await Promise.all([
      lifecycleProgress(fixture, fixture.seat, OWN_PLAN, "concurrent-own", "InReview", await planTokenOf(fixture, OWN_PLAN), "own summary"),
      lifecycleProgress(fixture, peer, PEER_PLAN, "concurrent-peer", "InReview", await planTokenOf(fixture, PEER_PLAN), "peer summary"),
    ]);
    expect(own.replayed).toBe(false);
    expect(peerReceipt.replayed).toBe(false);
    expect(storeRevisionOf(context)).toBe(storeBefore + 2);
    expect(parsedJson(rows(context, `select coordination_json from execution_plans where plan_id = '${OWN_PLAN}'`)[0]!.coordination_json).progress).toMatchObject({
      summary: "own summary",
    });
    expect(parsedJson(rows(context, `select coordination_json from execution_plans where plan_id = '${PEER_PLAN}'`)[0]!.coordination_json).progress).toMatchObject({
      summary: "peer summary",
    });

    // The same plan and the same token, two different payloads: exactly one is
    // accepted, and the loser gets a visible CAS conflict — never a silent lost
    // update.
    const revisionBefore = planFootprint(context, OWN_PLAN).plan_revision;
    const token = await planTokenOf(fixture, OWN_PLAN);
    const settled = await Promise.allSettled([
      lifecycleProgress(fixture, fixture.seat, OWN_PLAN, "race-first", "InReview", token, "first"),
      lifecycleProgress(fixture, fixture.seat, OWN_PLAN, "race-second", "InReview", token, "second"),
    ]);
    const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
    const rejected = settled.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as { code?: string }).code).toBe("execution.stale-token");
    expect(Number(planFootprint(context, OWN_PLAN).plan_revision)).toBe(Number(revisionBefore) + 1);

    // The conflict is resolved by an explicit reread and retry, and the retried
    // operation is retained on top of the accepted one.
    const retried = await lifecycleProgress(
      fixture,
      fixture.seat,
      OWN_PLAN,
      "race-second-retry",
      "InReview",
      await planTokenOf(fixture, OWN_PLAN),
      "second",
    );
    expect(retried.replayed).toBe(false);
    expect(Number(planFootprint(context, OWN_PLAN).plan_revision)).toBe(Number(revisionBefore) + 2);
    expect(parsedJson(rows(context, `select coordination_json from execution_plans where plan_id = '${OWN_PLAN}'`)[0]!.coordination_json).progress).toMatchObject({
      summary: "second",
    });
  });
});
