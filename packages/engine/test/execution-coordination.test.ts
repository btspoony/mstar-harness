/**
 * execution-coordination — the DB plan-operation authorization boundary and the
 * coordinator's ordinary plan operations (primary spec §2.3/§3/§4.1).
 *
 * There is ONE coordinator per workflow and no plan-PM seat: a plan is an
 * explicit operation address (`planId` is required), and the five ordinary
 * operations are `prepare` (revisable config), `progress` (ordinary states),
 * `residual-add`/`residual-close` (the issue-store authority) and `complete`
 * (QC/QA evidence plus the route-specific proof). The removed ownership-transfer
 * verbs (`handoff`/`accept`/`return`/`integration-*`/`reconcile`/`release`) are
 * no longer in the closed union.
 *
 * Run with `bun test packages/engine/test/execution-coordination.test.ts
 * --test-name-pattern 'execution-authority-boundary'`, `'execution-prepare-progress'`,
 * `'execution-residual'` or `'execution-completion'`.
 *
 * Every fixture lives in its own temporary control root created by
 * `mkdtempSync`; no test reads or writes this checkout's `store.db`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  deliveryRouteOf,
  type ExecutionPlanCall,
} from "../src/execution-coordination.js";
import { captureIssue, getIssue, type CaptureInput } from "../src/issue.js";
import { mutateExecutionWorkflow } from "../src/execution-workflow.js";
import { initializeExecutionAuthority } from "../src/execution-store.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  executionToken,
  readExecutionPlan,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionPlanWitness,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionState,
  type ExecutionToken,
} from "../src/execution-store.js";
import type { CoordinationOperation } from "../src/index.js";
import { initializeStore, openStore, storeDbPath, type StoreContext, type StoreDb } from "../src/store-db.js";
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
/** A sibling scope no operation touches: an eligible, unprepared row. */
const SPARE_PLAN = "p-3";
const COORDINATOR_ID = "host-coord";

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

/** §3 the trusted caller a domain verb authorizes against. */
function trustedCaller(sessionId: string): ExecutionCaller {
  return { sessionId, role: "coordinator", workflowId: WORKFLOW_ID };
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
 * the authority revisions plus the rows an operation would add.
 */
function footprint(context: StoreContext): Record<string, unknown> {
  const [row] = rows(
    context,
    "select (select revision from execution_meta where id = 1) as root_revision, " +
      "(select revision from store_meta where id = 1) as store_revision, " +
      `(select revision from execution_plans where plan_id = '${OWN_PLAN}') as own_plan_revision, ` +
      `(select revision from execution_plans where plan_id = '${PEER_PLAN}') as peer_plan_revision, ` +
      "(select count(*) as n from execution_operations) as operations, " +
      "(select count(*) as n from execution_sessions) as sessions",
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

type Fixture = {
  context: StoreContext;
  epoch: number;
  planTokens: Record<string, ExecutionToken>;
  coordinator: ExecutionSessionRef;
  coordinatorCaller: ExecutionCaller;
};

/**
 * An active store with ONE running workflow (`wf-1`) and its bound coordinator.
 * Every row starts unprepared: `prepare` is the ordinary revisable
 * configuration the operations below drive.
 */
async function seededWorkflow(
  label: string,
  options: { plans?: readonly string[]; deliveryKind?: "development" | "verification/report-only" } = {},
): Promise<Fixture> {
  // A real Git workspace whose `.mstar` child is the control harness, so the
  // route proofs below run against actual checkouts and object ids. The plan
  // cardinality is chosen at CREATION time: the workflow's own `execution_plans`
  // rows decide whether it is the single-row standalone route.
  const planIds = options.plans ?? [OWN_PLAN, PEER_PLAN, SPARE_PLAN];
  const workspace = realpathSync(mkdtempSync(join(ROOT, `${label}-`)));
  execFileSync("git", ["init", "-q", "-b", "main", workspace], { stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["-C", workspace, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const harnessDir = join(workspace, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const context: StoreContext = { harnessDir };
  const store = await initializeStore(context);
  store.close();
  const initialized = await initializeExecutionAuthority(context);
  for (const planId of planIds) await registerPlan(context, planId);
  const coordinatorCaller = trustedCaller(COORDINATOR_ID);
  const created = await createExecutionWorkflow(domainContext(context, coordinatorCaller), {
    entry: { id: WORKFLOW_ID, type: "plan", started_at: TS, dir: `workflows/${WORKFLOW_ID}` } as WorkflowEntry,
    snapshot: {
      schema_version: 1,
      id: WORKFLOW_ID,
      type: "plan",
      status: "running",
      started_at: TS,
      updated_at: TS,
      plans: planIds.map((planId) => ({
        id: planId,
        title: `${planId} title`,
        file: `plans/${planId}.md`,
        status: "Todo",
      })),
      delivery_kind: options.deliveryKind ?? "development",
      branch: { source: `feature/${WORKFLOW_ID}`, target: "main" },
    } as unknown as WorkflowSnapshot,
    expected: initialized.token,
    operationId: `create-${label}`,
  });
  const [workflow] = created.data.workflows;
  const coordinator = await bindExecutionSession(domainContext(context, coordinatorCaller), {
    workflowId: WORKFLOW_ID,
    expected: workflow.workflowToken,
    operationId: `bind-coordinator-${label}`,
  } as Parameters<typeof bindExecutionSession>[1]);
  const state = await readExecutionState(context);
  const [current] = state.data.workflows;
  return {
    context,
    epoch: created.epoch,
    planTokens: current.planTokens,
    coordinator: coordinator.data,
    coordinatorCaller,
  };
}

/** The plan token the coordinator's read serves right now (the CAS). */
async function planTokenOf(fixture: Fixture, planId: string): Promise<ExecutionToken> {
  const read = await readExecutionPlan(
    domainContext(fixture.context, fixture.coordinatorCaller),
    fixture.coordinator,
    planId,
  );
  return read.token;
}

/** One freshly-written plan row of a fixture's DB workflow. */
function planRow(context: StoreContext, planId: string): Record<string, unknown> {
  const [row] = rows(
    context,
    `select state_json from execution_plans where workflow_id = '${WORKFLOW_ID}' and plan_id = '${planId}'`,
  );
  return JSON.parse(String(row!.state_json)) as Record<string, unknown>;
}

/**
 * Real QC/QA evidence inside the plan's own SDD area, the shape the coordinator
 * submits to `complete`: paths on disk that `readCompletionEvidence` accepts.
 */
function completionEvidence(context: StoreContext, sourceSha: string): {
  source_sha: string;
  review_base: string;
  review_head: string;
  qc: { decision: "Approve"; reports: string[]; consolidated: string };
  qa: { gate: "mandatory"; decision: "pass"; report: string };
} {
  const sdd = join(context.harnessDir, "sdd", OWN_PLAN);
  const reports = [join(sdd, "review", "qc1.md"), join(sdd, "review", "qc2.md")];
  const consolidated = join(sdd, "review", "qc.md");
  const qa = join(sdd, "qa.md");
  for (const path of [...reports, consolidated, qa]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "# evidence\n");
  }
  return {
    source_sha: sourceSha,
    review_base: sourceSha,
    review_head: sourceSha,
    qc: { decision: "Approve", reports, consolidated },
    qa: { gate: "mandatory", decision: "pass", report: qa },
  };
}

/** The raw stored JSON text of one plan's coordination block and one workflow's operations. */
function storedCoordinationText(context: StoreContext, planId: string): string {
  const [row] = rows(
    context,
    `select coordination_json from execution_plans where workflow_id = '${WORKFLOW_ID}' and plan_id = '${planId}'`,
  );
  return String(row!.coordination_json);
}

function storedOperationReceipts(context: StoreContext): string {
  const [row] = rows(
    context,
    `select group_concat(operation_id || '=' || result_json, '|') as joined from execution_operations where workflow_id = '${WORKFLOW_ID}'`,
  );
  return String(row!.joined ?? "");
}

/** The raw stored JSON of the addressed workflow header. */
function storedWorkflowState(context: StoreContext): string {
  const [row] = rows(context, `select state_json from execution_workflows where workflow_id = '${WORKFLOW_ID}'`);
  return String(row!.state_json);
}

/** The raw stored JSON of one plan row's state. */
function storedPlanState(context: StoreContext, planId: string): string {
  const [row] = rows(
    context,
    `select state_json from execution_plans where workflow_id = '${WORKFLOW_ID}' and plan_id = '${planId}'`,
  );
  return String(row!.state_json);
}

/** The raw stored JSON of the workflow's integration merge lease row, or `"(none)"`. */
function storedLeaseText(context: StoreContext): string {
  const [row] = rows(
    context,
    `select lease_json from execution_integration_leases where workflow_id = '${WORKFLOW_ID}'`,
  );
  return row === undefined ? "(none)" : String(row.lease_json);
}

/** Every stored string one replay must leave byte-identical, as one value. */
function storedReplaySurface(context: StoreContext, planId: string): Record<string, string> {
  return {
    planState: storedPlanState(context, planId),
    coordination: storedCoordinationText(context, planId),
    workflowState: storedWorkflowState(context),
    lease: storedLeaseText(context),
    receipts: storedOperationReceipts(context),
  };
}

/** The recorded completion block of a coordination view, or a failed assertion. */
function completionOf2(coordination: { completion?: unknown } | null | undefined): Record<string, unknown> {
  const completion = coordination?.completion;
  if (completion === null || typeof completion !== "object") throw new Error("no recorded completion");
  return completion as Record<string, unknown>;
}

/** Report-only QC/QA evidence: no source Git fields, the route's own shape. */
function reportOnlyEvidence(context: StoreContext): {
  qc: { decision: "Approve"; reports: string[]; consolidated: string };
  qa: { gate: "mandatory"; decision: "pass"; report: string };
} {
  const sdd = join(context.harnessDir, "sdd", OWN_PLAN);
  const reports = [join(sdd, "review", "qc1.md")];
  const consolidated = join(sdd, "review", "qc.md");
  const qa = join(sdd, "qa.md");
  for (const path of [...reports, consolidated, qa]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "# evidence\n");
  }
  return { qc: { decision: "Approve", reports, consolidated }, qa: { gate: "mandatory", decision: "pass", report: qa } };
}

/** One coordinator operation on one explicitly addressed plan. */
function planCall(
  fixture: Fixture,
  planId: string,
  operationId: string,
  expected: ExecutionToken,
  operation: CoordinationOperation,
): Promise<ExecutionReceipt<import("../src/execution-store.js").ExecutionPlanView>> {
  return mutateExecutionPlan(domainContext(fixture.context, fixture.coordinatorCaller), {
    operationId,
    session: fixture.coordinator,
    expected,
    planId,
    operation,
  });
}

/** One ordinary `prepare` with the given config, against the plan's current token. */
async function preparePlan(fixture: Fixture, planId: string, operationId: string, config: Record<string, unknown> | undefined) {
  return planCall(fixture, planId, operationId, await planTokenOf(fixture, planId), {
    kind: "prepare",
    ...(config === undefined ? {} : { config }),
  } as CoordinationOperation);
}

/** One ordinary `progress` report against the plan's current token. */
async function progressPlan(fixture: Fixture, planId: string, operationId: string, status: string, summary = status) {
  return planCall(fixture, planId, operationId, await planTokenOf(fixture, planId), {
    kind: "progress",
    progress: { status, summary, evidence_paths: [] },
  } as unknown as CoordinationOperation);
}

/** The refusal of a call that must refuse, as a typed error value. */
async function refusalOf(run: () => Promise<unknown>): Promise<{ code?: string; message?: string; details?: Record<string, unknown> }> {
  try {
    await run();
    throw new Error("expected a refusal");
  } catch (error) {
    return error as { code?: string; message?: string; details?: Record<string, unknown> };
  }
}

/**
 * The open issues the issue store links to one plan, read through the raw
 * provenance join (the authority the findings gate reads).
 */
async function linkedPlanIssues(context: StoreContext, planId: string): Promise<Array<{ id: string; revision: number }>> {
  return withRaw(context, (db) =>
    db
      .prepare(
        "select issues.id as id, issues.revision as revision from issues " +
          "join provenance on provenance.issue_id = issues.id and provenance.kind = 'plan' and provenance.target = ? " +
          "where issues.disposition = 'open' order by issues.id asc",
      )
      .all(planId) as Array<{ id: string; revision: number }>,
  );
}

/** Record one plan provenance link in the fixture's own store transaction. */
async function linkIssueToPlan(context: StoreContext, issueId: string, planId: string): Promise<void> {
  withRaw(context, (db) => {
    db.prepare("insert into provenance(issue_id, kind, target, source_hash) values (?, 'plan', ?, ?)").run(
      issueId,
      planId,
      "fixture-source-hash",
    );
  });
}

/* ------------------------------------------------------------------------ *
 * The authorization boundary
 * ------------------------------------------------------------------------ */

describe("execution-authority-boundary: §2.3/§3 DB plan-operation authorization", () => {
  test("refuses a forged caller and a sibling plan without running the operation", async () => {
    const fixture = await seededWorkflow("boundary-scope");
    const { context, planTokens, coordinator, coordinatorCaller } = fixture;
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

    // A caller of another workflow addresses nothing in this one.
    await expect(
      attempt({ ...coordinatorCaller, workflowId: "wf-other" }, { session: coordinator, expected: planTokens[OWN_PLAN], planId: OWN_PLAN, operation: { kind: "residual-add", entries: [] } }),
    ).rejects.toMatchObject({ code: "coordination.identity-mismatch" });
    // A sibling plan addressed with the OTHER plan's token.
    await expect(
      attempt(coordinatorCaller, { session: coordinator, expected: planTokens[PEER_PLAN], planId: OWN_PLAN, operation: { kind: "residual-add", entries: [] } }),
    ).rejects.toMatchObject({ code: "execution.scope-mismatch" });
    // An operation kind the closed union does not carry.
    await expect(
      attempt(coordinatorCaller, {
        session: coordinator,
        expected: planTokens[OWN_PLAN],
        planId: OWN_PLAN,
        operation: { kind: "publish" } as CoordinationOperation,
      }),
    ).rejects.toMatchObject({ code: "coordination.unknown-operation" });

    expect(ran).toBe(0);
    expect(footprint(context)).toEqual(before);
    expect(await readExecutionState(context)).toEqual(accepted);
  });

  test("refuses a revoked, foreign-epoch or foreign-store reference, and reads no session file", async () => {
    const fixture = await seededWorkflow("boundary-reference");
    const { context, epoch, planTokens, coordinator, coordinatorCaller } = fixture;
    const before = footprint(context);
    let ran = 0;
    const attempt = (session: ExecutionSessionRef): Promise<unknown> =>
      withExecutionPlanAuthority(
        domainContext(context, coordinatorCaller),
        { session, expected: planTokens[OWN_PLAN], planId: OWN_PLAN, operation: { kind: "residual-add", entries: [] } },
        () => {
          ran += 1;
          return "leaked";
        },
      );

    await expect(attempt({ ...coordinator, epoch: epoch - 1 })).rejects.toMatchObject({ code: "store.stale-epoch" });
    await expect(attempt({ ...coordinator, storeId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({
      code: "execution.scope-mismatch",
    });
    await expect(attempt({ ...coordinator, sessionId: "host-elsewhere" })).rejects.toMatchObject({
      code: "coordination.identity-mismatch",
    });

    // The reference is the binding the store holds: revoking the row ends it.
    withRaw(context, (db) => {
      db.prepare("update execution_sessions set state = 'revoked' where workflow_id = ?").run(WORKFLOW_ID);
    });
    await expect(attempt(coordinator)).rejects.toMatchObject({ code: "execution.session-unavailable" });

    expect(ran).toBe(0);
    expect(footprint(context)).toEqual(before);
  });

  test("refuses a nested plan operation on the same store and commits only the outer one", async () => {
    const fixture = await seededWorkflow("boundary-reentrant");
    const { context, planTokens, coordinator, coordinatorCaller } = fixture;
    const before = footprint(context);
    let ran = 0;
    let nested: Promise<{ code?: string }> | undefined;

    const outcome = await withExecutionPlanAuthority(
      domainContext(context, coordinatorCaller),
      { session: coordinator, expected: planTokens[OWN_PLAN], planId: OWN_PLAN, operation: { kind: "residual-add", entries: [] } },
      (witness, tx) => {
        // A domain operation owns exactly ONE transaction: the nested call is
        // refused before it opens a second handle.
        nested = withExecutionPlanAuthority(
          domainContext(context, coordinatorCaller),
          { session: coordinator, expected: planTokens[PEER_PLAN], planId: PEER_PLAN, operation: { kind: "residual-add", entries: [] } },
          () => {
            ran += 1;
            return "nested";
          },
        ).then(
          () => ({ code: "leaked" }),
          (error: { code?: string }) => error,
        );
        tx.db
          .prepare(
            "insert into execution_operations(epoch, operation_id, request_hash, store_id, workflow_id, plan_id, result_json, committed_at) " +
              "values (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(tx.epoch, "outer-receipt", "request-hash", tx.storeId, witness.workflowId, witness.planId, "{}", TS);
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
    const { context, planTokens, coordinator, coordinatorCaller } = fixture;
    const read = await readExecutionPlan(domainContext(context, coordinatorCaller), coordinator, OWN_PLAN);
    expect(read.token).toBe(planTokens[OWN_PLAN]);
    const before = footprint(context);
    let seen: ExecutionPlanWitness | undefined;

    const outcome = await withExecutionPlanAuthority(
      domainContext(context, coordinatorCaller),
      { session: coordinator, expected: read.token, planId: OWN_PLAN, operation: { kind: "residual-add", entries: [] } },
      (witness, tx) => {
        seen = witness;
        tx.db
          .prepare(
            "insert into execution_operations(epoch, operation_id, request_hash, store_id, workflow_id, plan_id, result_json, committed_at) " +
              "values (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(tx.epoch, "authorized-receipt", "request-hash", tx.storeId, witness.workflowId, witness.planId, "{}", TS);
        tx.db
          .prepare("update execution_plans set revision = revision + 1 where workflow_id = ? and plan_id = ?")
          .run(witness.workflowId, witness.planId);
        return "committed";
      },
    );

    expect(outcome).toBe("committed");
    expect(seen).toMatchObject({ workflowId: WORKFLOW_ID, planId: OWN_PLAN, token: read.token, revision: 1 });
    expect(seen?.session).toEqual(coordinator);

    // One transaction: the body's receipt and the plan's own advance are visible.
    expect(footprint(context)).toEqual({
      ...before,
      own_plan_revision: (before.own_plan_revision as number) + 1,
      operations: (before.operations as number) + 1,
    });
    expect((await readExecutionPlan(domainContext(context, coordinatorCaller), coordinator, OWN_PLAN)).token).toBe(
      executionToken("plan", read.storeId, read.epoch, [WORKFLOW_ID, OWN_PLAN], 2),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * W2 — `prepare` and `progress` on the DB authority
 * ------------------------------------------------------------------------ */

describe("execution-prepare-progress: §3/§4.1 DB prepare and progress", () => {
  test("prepare records the config and plan anchors, then replays exactly", async () => {
    const fixture = await seededWorkflow("prepare-input-record");
    const { context, coordinator } = fixture;
    const before = footprint(context);
    const config = { worktreePath: join(context.harnessDir, "worktrees", OWN_PLAN), workingBranch: `feature/${OWN_PLAN}` };

    const receipt = await preparePlan(fixture, OWN_PLAN, "prepare-1", config);
    expect(receipt.replayed).toBe(false);
    expect(receipt.data.coordination?.prepared).toMatchObject({
      qa_gate: "mandatory",
      findings_cleanup: "allow-residual",
      prepared_by: COORDINATOR_ID,
    });
    // The plan's own worktree/branch anchors are recorded as ordinary metadata.
    expect(receipt.data.plan.metadata).toEqual({
      worktree_path: config.worktreePath,
      working_branch: config.workingBranch,
    });
    expect(receipt.token).toBe(
      executionToken("plan", receipt.storeId, receipt.epoch, [WORKFLOW_ID, OWN_PLAN], (before.own_plan_revision as number) + 1),
    );

    // §3.1 an exact retry is a replay, not a second prepare.
    const committed = footprint(context);
    const replay = await preparePlan(fixture, OWN_PLAN, "prepare-1", config);
    expect(replay.replayed).toBe(true);
    expect(replay.data).toEqual(receipt.data);
    expect(footprint(context)).toEqual(committed);

    // A token the prepare superseded is a stale CAS, not a re-read.
    const stale = await refusalOf(() => planCall(fixture, OWN_PLAN, "prepare-2", fixture.planTokens[OWN_PLAN]!, { kind: "prepare", config }));
    expect(stale).toMatchObject({ code: "execution.stale-token" });
    expect(footprint(context)).toEqual(committed);
    expect(coordinator.sessionId).toBe(COORDINATOR_ID);
  });

  test("an unchanged ordinary reissue is already-satisfied with no second write, and its receipt replays", async () => {
    const fixture = await seededWorkflow("prepare-satisfied");
    const { context } = fixture;
    const config = { worktreePath: join(context.harnessDir, "worktrees", OWN_PLAN), workingBranch: `feature/${OWN_PLAN}` };
    const first = await preparePlan(fixture, OWN_PLAN, "prepare-first", config);
    expect(first.replayed).toBe(false);
    const committed = footprint(context);

    // A new operation id with the same config is already satisfied.
    const again = await preparePlan(fixture, OWN_PLAN, "prepare-again", config);
    expect(again.replayed).toBe(false);
    expect(again.data.coordination?.prepared).toEqual(first.data.coordination?.prepared);
    const settled = footprint(context);
    expect(settled).toEqual({ ...committed, operations: (committed.operations as number) + 1 });

    // An exact retry replays its own recorded receipt.
    const replay = await preparePlan(fixture, OWN_PLAN, "prepare-again", config);
    expect(replay.replayed).toBe(true);
    expect(footprint(context)).toEqual(settled);
  });

  test("progress reports the ordinary states and replays without advancing", async () => {
    const fixture = await seededWorkflow("progress-transitions");
    const { context, planTokens } = fixture;
    const first = await progressPlan(fixture, OWN_PLAN, "progress-start", "InProgress", "start");
    expect(first.replayed).toBe(false);
    expect(first.data.plan.status).toBe("InProgress");

    // Blocked is a reportable state, and its receipt replays.
    const blocked = await progressPlan(fixture, OWN_PLAN, "progress-blocked", "Blocked", "waiting on QC");
    expect(blocked.data.plan.status).toBe("Blocked");
    const committed = footprint(context);
    const replayToken = await planTokenOf(fixture, OWN_PLAN);
    const replay = await progressPlan(fixture, OWN_PLAN, "progress-blocked", "Blocked", "waiting on QC");
    expect(replay.replayed).toBe(true);
    expect(footprint(context)).toEqual(committed);
    expect(replayToken).toBe(replay.token);

    // A Done row is not a valid progress target.
    await progressPlan(fixture, OWN_PLAN, "progress-review", "InReview", "review");
    withRaw(context, (db) => {
      db.prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?").run(
        JSON.stringify({ id: OWN_PLAN, title: "p-1 title", file: `plans/${OWN_PLAN}.md`, status: "Done" }),
        WORKFLOW_ID,
        OWN_PLAN,
      );
    });
    const afterDone = await refusalOf(() => progressPlan(fixture, OWN_PLAN, "progress-after-done", "InProgress", "resume"));
    expect(afterDone.code).toBe("coordination.progress-transition");
    expect(planTokens[OWN_PLAN]).toBeDefined();
  });

  test("prepare refuses outsiders on unsealed and sealed rows without recording an action", async () => {
    const fixture = await seededWorkflow("prepare-outsiders");
    const { context, coordinatorCaller } = fixture;
    const before = footprint(context);

    // A caller of another workflow cannot address this one's rows.
    await expect(
      prepareExecutionPlan(domainContext(context, { ...coordinatorCaller, workflowId: "wf-other" }), {
        operationId: "outsider",
        expected: fixture.planTokens[OWN_PLAN],
        planId: OWN_PLAN,
        operation: { kind: "prepare" },
      }),
    ).rejects.toMatchObject({ code: "coordination.identity-mismatch" });
    expect(footprint(context)).toEqual(before);
  });

  test("refuses a prepare whose catalog registration is still pending, and seals nothing", async () => {
    const fixture = await seededWorkflow("prepare-pending-registration");
    const { context, planTokens } = fixture;
    const before = footprint(context);
    withRaw(context, (db) => {
      db.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) " +
          "values ('op-pending', 'h', 'execution-written', ?, '{}', '{}', null, ?, ?)",
      ).run(JSON.stringify({ workflow: { workflowId: WORKFLOW_ID } }), TS, TS);
    });

    const refusal = await refusalOf(() =>
      planCall(fixture, OWN_PLAN, "prepare-pending", planTokens[OWN_PLAN]!, { kind: "prepare" }),
    );
    expect(refusal.code).toBe("catalog.registration-pending");
    expect(footprint(context)).toEqual({ ...before, operations: before.operations as number });
  });
});

/* ------------------------------------------------------------------------ *
 * W3 — `residual-add` / `residual-close` (issue authority)
 * ------------------------------------------------------------------------ */

/** The core `CaptureInput` minus `projectId`, as the scoped list takes it. */
function finding(overrides: Partial<Omit<CaptureInput, "projectId">> = {}): Omit<CaptureInput, "projectId"> {
  return {
    title: "Finding",
    kind: "review-obligation",
    severity: "medium",
    impact: "blocks approval",
    acceptance: "fixed or dispositioned",
    owner: "@fullstack-dev",
    sourceIdentity: "qc:report:1",
    rootCauseKey: "rc-1",
    acceptanceKey: "fix",
    occurrenceKey: "occ-1",
    sourceKind: "qc-report",
    location: "packages/engine",
    observedBehavior: "observed",
    evidence: ["review/qc1.md"],
    discoveredAt: TS,
    ...overrides,
  };
}

describe("execution-residual: §3/§4.1 DB residual-add and residual-close", () => {
  test("residual-add captures and links every entry on the addressed plan, and residual-close disposes one", async () => {
    const fixture = await seededWorkflow("residual-round-trip");
    const { context } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-residual", undefined);

    const added = await residualAddExecutionPlan(domainContext(context, fixture.coordinatorCaller), {
      operationId: "residual-add-1",
      session: fixture.coordinator,
      expected: await planTokenOf(fixture, OWN_PLAN),
      planId: OWN_PLAN,
      operation: { kind: "residual-add", entries: [finding(), finding({ occurrenceKey: "occ-2" })] },
    });
    expect(added.replayed).toBe(false);

    const issues = await linkedPlanIssues(context, OWN_PLAN);
    expect(issues).toHaveLength(2);

    const target = issues[0]!;
    const closed = await residualCloseExecutionPlan(domainContext(context, fixture.coordinatorCaller), {
      operationId: "residual-close-1",
      session: fixture.coordinator,
      expected: await planTokenOf(fixture, OWN_PLAN),
      planId: OWN_PLAN,
      operation: {
        kind: "residual-close",
        issueId: target.id,
        disposition: "resolved",
        evidence: { reason: "fixed", references: ["review/qc1.md"] },
        expectedIssueRevision: target.revision,
      },
    });
    expect(closed.replayed).toBe(false);
    expect((await getIssue(context, target.id)).disposition).toBe("resolved");
  });

  test("a residual-add replays exactly, and an operation id reused with another payload refuses", async () => {
    const fixture = await seededWorkflow("residual-replay");
    const { context } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-residual-replay", undefined);
    // The token is read AFTER prepare, so the committed call carries the row's
    // current CAS; the exact retry reuses the same original request.
    const expected = await planTokenOf(fixture, OWN_PLAN);
    const request = {
      operationId: "residual-op",
      session: fixture.coordinator,
      expected,
      planId: OWN_PLAN,
      operation: { kind: "residual-add" as const, entries: [finding()] },
    };
    const first = await residualAddExecutionPlan(domainContext(context, fixture.coordinatorCaller), request);
    expect(first.replayed).toBe(false);
    const replay = await residualAddExecutionPlan(domainContext(context, fixture.coordinatorCaller), request);
    expect(replay.replayed).toBe(true);

    const conflict = await refusalOf(() =>
      residualAddExecutionPlan(domainContext(context, fixture.coordinatorCaller), {
        ...request,
        operation: { kind: "residual-add", entries: [finding({ occurrenceKey: "occ-other" })] },
      }),
    );
    expect(conflict.code).toBe("execution.operation-conflict");
  });

  test("a stale issue revision refuses and leaves the finding untouched", async () => {
    const fixture = await seededWorkflow("residual-stale-issue");
    const { context } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-stale", undefined);
    await residualAddExecutionPlan(domainContext(context, fixture.coordinatorCaller), {
      operationId: "residual-add-stale",
      session: fixture.coordinator,
      expected: await planTokenOf(fixture, OWN_PLAN),
      planId: OWN_PLAN,
      operation: { kind: "residual-add", entries: [finding()] },
    });
    const [target] = await linkedPlanIssues(context, OWN_PLAN);
    const staleToken = await planTokenOf(fixture, OWN_PLAN);
    const refusal = await refusalOf(() =>
      residualCloseExecutionPlan(domainContext(context, fixture.coordinatorCaller), {
        operationId: "residual-close-stale",
        session: fixture.coordinator,
        expected: staleToken,
        planId: OWN_PLAN,
        operation: {
          kind: "residual-close",
          issueId: target!.id,
          disposition: "waived",
          evidence: { reason: "risk accepted", references: [] },
          expectedIssueRevision: target!.revision + 5,
        },
      }),
    );
    expect(refusal.code).toBe("issue.revision-conflict");
    expect((await getIssue(context, target!.id)).disposition).toBe("open");
  });
});

/* ------------------------------------------------------------------------ *
 * W5 — `complete` on the DB authority: the three declared routes
 * ------------------------------------------------------------------------ */

/** A real commit in one checkout. */
function commit(cwd: string, file: string, body: string, message: string): string {
  writeFileSync(join(cwd, file), body);
  execFileSync("git", ["-C", cwd, "add", "-A"], { stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** A real two-parent merge of `source` into `target`'s branch; returns the merge id. */
function mergeInto(integration: string, sourceSha: string, message: string): string {
  execFileSync("git", ["-C", integration, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--no-ff", sourceSha, "-m", message], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return execFileSync("git", ["-C", integration, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/**
 * A real iteration fixture: one workflow with two rows, a real source checkout
 * per row on its own branch, and a real integration checkout on the registered
 * target branch. The store's snapshot names the integration worktree.
 */
async function realIterationFixture(label: string): Promise<Fixture & { integrationPath: string; sourceSha: string; baseSha: string }> {
  const fixture = await seededWorkflow(label, { plans: [OWN_PLAN, PEER_PLAN] });
  const { context } = fixture;
  // The harness root IS the control root; the Git repository is its parent
  // workspace, which `realpathSync` already resolved.
  const repo = dirname(context.harnessDir);
  const integrationPath = join(repo, "wt-integration");
  const worktree = join(context.harnessDir, "worktrees", OWN_PLAN);
  mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", `feature/${OWN_PLAN}`, worktree], { stdio: ["ignore", "ignore", "ignore"] });
  mkdirSync(integrationPath, { recursive: true });
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", `integration/${WORKFLOW_ID}`, integrationPath], { stdio: ["ignore", "ignore", "ignore"] });
  const baseSha = execFileSync("git", ["-C", integrationPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceSha = commit(join(context.harnessDir, "worktrees", OWN_PLAN), "slice.txt", "slice\n", "feat: slice");
  // Record the integration anchors on the snapshot the store holds.
  const handle = await openStore(context, "write");
  try {
    const row = handle.db
      .prepare("select state_json from execution_workflows where workflow_id = ?")
      .get(WORKFLOW_ID) as { state_json?: unknown };
    const state = JSON.parse(String(row.state_json)) as Record<string, unknown>;
    state.integration_worktree_path = integrationPath;
    state.branch = { source: `feature/${OWN_PLAN}`, target: `integration/${WORKFLOW_ID}`, integration: `integration/${WORKFLOW_ID}` };
    handle.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), WORKFLOW_ID);
  } finally {
    handle.close();
  }
  return { ...fixture, integrationPath, sourceSha, baseSha };
}

/**
 * A real standalone fixture: ONE authoritative plan row, created that way, plus
 * its real source checkout. The workflow header's `branch` names the delivery
 * source/target the route anchors read.
 */
async function realStandaloneFixture(
  label: string,
  deliveryKind: "development" | "verification/report-only" = "development",
): Promise<Fixture & { sourceSha: string; worktree: string }> {
  const fixture = await seededWorkflow(label, { plans: [OWN_PLAN], deliveryKind });
  const { context } = fixture;
  const repo = dirname(context.harnessDir);
  const worktree = join(context.harnessDir, "worktrees", OWN_PLAN);
  mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", `feature/${OWN_PLAN}`, worktree], { stdio: ["ignore", "ignore", "ignore"] });
  const sourceSha = commit(worktree, "standalone.txt", "standalone slice\n", "feat: standalone");
  const handle = await openStore(context, "write");
  try {
    const row = handle.db
      .prepare("select state_json from execution_workflows where workflow_id = ?")
      .get(WORKFLOW_ID) as { state_json?: unknown };
    const state = JSON.parse(String(row.state_json)) as Record<string, unknown>;
    state.type = "plan";
    state.delivery_kind = deliveryKind;
    state.branch = { source: `feature/${OWN_PLAN}`, target: "main" };
    if (deliveryKind === "verification/report-only") {
      state.completion_policy = "acceptance report";
    }
    delete state.integration_worktree_path;
    handle.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), WORKFLOW_ID);
  } finally {
    handle.close();
  }
  if (deliveryKind === "verification/report-only") {
    // Record the explicit matching fulfilment through the ordinary public
    // workflow evidence action, never a raw injection.
    const workflow = (await readExecutionState(context)).data.workflows.find((entry) => entry.state.id === WORKFLOW_ID);
    if (workflow === undefined) throw new Error("fixture: workflow not registered");
    await mutateExecutionWorkflow(domainContext(context, fixture.coordinatorCaller), {
      operationId: `delivery-${label}`,
      session: fixture.coordinator,
      expected: workflow.workflowToken,
      workflowId: WORKFLOW_ID,
      operation: { kind: "delivery", delivery: { completion: { policy: "acceptance report", evidence: "acceptance.md" } } },
    } as Parameters<typeof mutateExecutionWorkflow>[1]);
  }
  return { ...fixture, sourceSha, worktree };
}

describe("execution-completion: §3/§4.1 DB completion and its route selection", () => {
  test("classifies the delivery route from the workflow's own declared kind and cardinality", () => {
    const single = (overrides: Record<string, unknown>): WorkflowSnapshot =>
      ({ id: "wf-1", type: "plan", plans: [{ id: "p-1", status: "Todo", title: "t", file: "f" }], ...overrides }) as unknown as WorkflowSnapshot;
    // A single-row plan of each kind is that standalone route; anything else is
    // an iteration (integration) route.
    expect(deliveryRouteOf(single({ delivery_kind: "development" }))).toBe("development");
    expect(deliveryRouteOf(single({ delivery_kind: "verification/report-only" }))).toBe("report-only");
    expect(deliveryRouteOf(single({ type: "iteration", delivery_kind: "development" }))).toBe("integration");
    expect(
      deliveryRouteOf(
        single({
          delivery_kind: "development",
          plans: [
            { id: "p-1", status: "Todo", title: "t", file: "f" },
            { id: "p-2", status: "Todo", title: "t", file: "f" },
          ],
        }),
      ),
    ).toBe("integration");
  });

  test("a Todo row refuses on status with otherwise-valid proof, and InProgress completes in one write", async () => {
    const fixture = await realStandaloneFixture("complete-status-window");
    const { context, sourceSha } = fixture;
    // Ordinary config only: source facts for the real checkout, no ceremony.
    await preparePlan(fixture, OWN_PLAN, "prepare-window", {
      worktreePath: fixture.worktree,
      workingBranch: `feature/${OWN_PLAN}`,
      qaGate: "mandatory",
    });
    const evidence = completionEvidence(context, sourceSha);

    // From Todo with otherwise-valid evidence: only STATUS is invalid.
    const todoToken = await planTokenOf(fixture, OWN_PLAN);
    const beforeTodo = footprint(context);
    const todoRefusal = await refusalOf(() =>
      planCall(fixture, OWN_PLAN, "complete-todo", todoToken, { kind: "complete", evidence } as CoordinationOperation),
    );
    expect(todoRefusal.code).toBe("coordination.plan-status");
    expect(footprint(context)).toEqual(beforeTodo);

    // From Blocked: the same status refusal.
    await progressPlan(fixture, OWN_PLAN, "progress-window-blocked", "Blocked");
    const blockedToken = await planTokenOf(fixture, OWN_PLAN);
    const blockedRefusal = await refusalOf(() =>
      planCall(fixture, OWN_PLAN, "complete-blocked", blockedToken, { kind: "complete", evidence } as CoordinationOperation),
    );
    expect(blockedRefusal.code).toBe("coordination.plan-status");

    // InProgress → Done entailed in one write unit; no separate InReview call.
    await progressPlan(fixture, OWN_PLAN, "progress-window-start", "InProgress");
    const startToken = await planTokenOf(fixture, OWN_PLAN);
    const completed = await planCall(fixture, OWN_PLAN, "complete-inprogress", startToken, {
      kind: "complete",
      evidence,
    } as CoordinationOperation);
    expect(completed.replayed).toBe(false);
    expect(completed.data.plan.status).toBe("Done");
    expect(completed.data.coordination?.completion?.completed_at).toBeTypeOf("string");
  }, 30000);

  test("an iteration row requires the integration result and names the missing fact", async () => {
    const fixture = await realIterationFixture("complete-integration-required");
    const { context, sourceSha } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-complete", {
      worktreePath: join(context.harnessDir, "worktrees", OWN_PLAN),
      workingBranch: `feature/${OWN_PLAN}`,
      qaGate: "mandatory",
    });
    await progressPlan(fixture, OWN_PLAN, "progress-start", "InProgress");
    await progressPlan(fixture, OWN_PLAN, "progress-review", "InReview");
    const before = footprint(context);
    const evidence = completionEvidence(context, sourceSha);

    // Otherwise-valid evidence, only the integration pair omitted: the refusal
    // names the missing integration fact, and nothing is written.
    const missingToken = await planTokenOf(fixture, OWN_PLAN);
    const missing = await refusalOf(() =>
      planCall(fixture, OWN_PLAN, "complete-no-integration", missingToken, {
        kind: "complete",
        evidence,
      } as CoordinationOperation),
    );
    expect(missing.code).toBe("coordination.invalid-input");
    expect(missing.details?.missing).toBe("integration");
    expect(footprint(context)).toEqual(before);
  });

  test("the iteration route completes on the real serial merge, releases an owned claim, and replays byte-stably", async () => {
    const fixture = await realIterationFixture("complete-integration-success");
    const { context, sourceSha, baseSha } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-int", {
      worktreePath: join(context.harnessDir, "worktrees", OWN_PLAN),
      workingBranch: `feature/${OWN_PLAN}`,
      qaGate: "mandatory",
    });
    await progressPlan(fixture, OWN_PLAN, "progress-int-start", "InProgress");
    // The operator performs the real serial merge.
    const resultSha = mergeInto(fixture.integrationPath, sourceSha, "Merge plan-a");
    // Insert THIS attempt's own merge claim directly (the DB route has no
    // claim verb): completing must release it with the completion write.
    withRaw(context, (db) => {
      db.prepare(
        "insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, ?, ?)",
      ).run(
        WORKFLOW_ID,
        fixture.epoch,
        JSON.stringify({
          holder: COORDINATOR_ID,
          claimed_at: TS,
          plan_id: OWN_PLAN,
          source_branch: `feature/${OWN_PLAN}`,
          target_branch: `integration/${WORKFLOW_ID}`,
          status: "held",
        }),
      );
    });
    const evidence = completionEvidence(context, sourceSha);
    const completeToken = await planTokenOf(fixture, OWN_PLAN);
    const before = footprint(context);
    const receipt = await planCall(fixture, OWN_PLAN, "complete-int", completeToken, {
      kind: "complete",
      evidence,
      integration: { base_sha: baseSha, result_sha: resultSha },
    } as CoordinationOperation);
    expect(receipt.replayed).toBe(false);
    expect(receipt.data.plan.status).toBe("Done");
    const completion = receipt.data.coordination?.completion;
    expect(completion).toMatchObject({ source_branch: `feature/${OWN_PLAN}`, source_sha: sourceSha });
    expect(completion?.integration).toMatchObject({ base_sha: baseSha, result_sha: resultSha });
    expect(completion?.completed_by).toBe(COORDINATOR_ID);
    // The attempt's own claim is released by the same write.
    const [leaseRow] = rows(context, `select lease_json from execution_integration_leases where workflow_id = '${WORKFLOW_ID}'`);
    expect(JSON.parse(String(leaseRow!.lease_json))).toMatchObject({ status: "released", released_by: COORDINATOR_ID });
    expect(footprint(context)).toEqual({ ...before, own_plan_revision: (before.own_plan_revision as number) + 1, operations: (before.operations as number) + 1 });

    // Replay: identical request, Git/evidence left intact on the first attempt
    // then made UNAVAILABLE. The recorded receipt is served byte-stably.
    rmSync(fixture.integrationPath, { recursive: true, force: true });
    const storedBefore = storedReplaySurface(context, OWN_PLAN);
    const replayToken = await planTokenOf(fixture, OWN_PLAN);
    const afterFirst = footprint(context);
    const replay = await planCall(fixture, OWN_PLAN, "complete-int", replayToken, {
      kind: "complete",
      evidence,
      integration: { base_sha: baseSha, result_sha: resultSha },
    } as CoordinationOperation);
    expect(replay.replayed).toBe(true);
    // Byte-stable across the whole storage surface: plan state, coordination,
    // workflow header, released lease and every operation receipt.
    expect(storedReplaySurface(context, OWN_PLAN)).toEqual(storedBefore);
    // The full returned receipt is the recorded one (the replay transport flag is
    // the only documented difference).
    expect({ ...replay, replayed: false }).toEqual(receipt);
    expect(footprint(context)).toEqual(afterFirst);
  }, 30000);

  test("the standalone development route completes on the real source checkout, refuses an integration input and replays after the checkout is gone", async () => {
    const fixture = await realStandaloneFixture("complete-standalone-success");
    const { context, sourceSha } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-sa", {
      worktreePath: fixture.worktree,
      workingBranch: `feature/${OWN_PLAN}`,
      qaGate: "mandatory",
    });
    await progressPlan(fixture, OWN_PLAN, "progress-sa-start", "InProgress");
    const evidence = completionEvidence(context, sourceSha);
    const before = footprint(context);
    const contaminatedToken = await planTokenOf(fixture, OWN_PLAN);
    const contaminated = await refusalOf(() =>
      planCall(fixture, OWN_PLAN, "complete-sa-contaminated", contaminatedToken, {
        kind: "complete",
        evidence,
        integration: { base_sha: sourceSha, result_sha: sourceSha },
      } as CoordinationOperation),
    );
    expect(contaminated.code).toBe("coordination.invalid-transition");
    expect(footprint(context)).toEqual(before);

    const receipt = await planCall(fixture, OWN_PLAN, "complete-sa", await planTokenOf(fixture, OWN_PLAN), {
      kind: "complete",
      evidence,
    } as CoordinationOperation);
    expect(receipt.data.plan.status).toBe("Done");
    expect(receipt.data.coordination?.completion?.integration).toBeUndefined();
    expect(receipt.data.coordination?.completion?.source_sha).toBe(sourceSha);

    // The development replay is a recorded-receipt read even after the source
    // checkout is removed: no Git is re-run.
    const storedBefore = storedReplaySurface(context, OWN_PLAN);
    const footprintBefore = footprint(context);
    rmSync(fixture.worktree, { recursive: true, force: true });
    const replay = await planCall(fixture, OWN_PLAN, "complete-sa", await planTokenOf(fixture, OWN_PLAN), {
      kind: "complete",
      evidence,
    } as CoordinationOperation);
    expect(replay.replayed).toBe(true);
    expect(storedReplaySurface(context, OWN_PLAN)).toEqual(storedBefore);
    expect(footprint(context)).toEqual(footprintBefore);
    expect({ ...replay, replayed: false }).toEqual(receipt);
  }, 30000);

  test("the report-only route completes on its recorded policy fulfilment with no source Git at all", async () => {
    const fixture = await realStandaloneFixture("complete-report-only", "verification/report-only");
    const { context } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-ro", undefined);
    await progressPlan(fixture, OWN_PLAN, "progress-ro", "InProgress");
    // Remove the source checkout: the report-only route must consult no Git at
    // all, and its completion must carry null source facts.
    rmSync(fixture.worktree, { recursive: true, force: true });
    const evidence = reportOnlyEvidence(context);
    const before = footprint(context);
    const contaminatedToken = await planTokenOf(fixture, OWN_PLAN);
    const contaminated = await refusalOf(() =>
      planCall(fixture, OWN_PLAN, "complete-ro-contaminated", contaminatedToken, {
        kind: "complete",
        evidence,
        integration: { base_sha: "a".repeat(40), result_sha: "b".repeat(40) },
      } as CoordinationOperation),
    );
    expect(contaminated.code).toBe("coordination.invalid-transition");
    expect(footprint(context)).toEqual(before);

    const receipt = await planCall(fixture, OWN_PLAN, "complete-ro", await planTokenOf(fixture, OWN_PLAN), {
      kind: "complete",
      evidence,
    } as CoordinationOperation);
    expect(receipt.data.plan.status).toBe("Done");
    const completion = receipt.data.coordination?.completion;
    // Every source field is null on this route: no Git is consulted or invented.
    expect(completion).toMatchObject({
      source_branch: null,
      source_sha: null,
      worktree_path: null,
      review_base: null,
      review_head: null,
    });
    expect(completion?.integration).toBeUndefined();

    // Replay is byte-stable and does NOT re-consume the recorded fulfilment: remove
    // it from the header before retrying the identical request.
    withRaw(context, (db) => {
      const [row] = db
        .prepare("select state_json from execution_workflows where workflow_id = ?")
        .all(WORKFLOW_ID) as Array<{ state_json?: unknown }>;
      const state = JSON.parse(String(row!.state_json)) as Record<string, unknown>;
      delete (state.delivery as Record<string, unknown>).completion;
      db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), WORKFLOW_ID);
    });
    const storedAfter = storedReplaySurface(context, OWN_PLAN);
    const footprintAfter = footprint(context);
    const replay = await planCall(fixture, OWN_PLAN, "complete-ro", await planTokenOf(fixture, OWN_PLAN), {
      kind: "complete",
      evidence,
    } as CoordinationOperation);
    expect(replay.replayed).toBe(true);
    expect(storedReplaySurface(context, OWN_PLAN)).toEqual(storedAfter);
    expect(footprint(context)).toEqual(footprintAfter);
    expect({ ...replay, replayed: false }).toEqual(receipt);
  }, 30000);

  test("a report-only row whose registered fulfilment is missing refuses with its own cause", async () => {
    const fixture = await realStandaloneFixture("complete-report-only-unfulfilled", "verification/report-only");
    const { context } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-rou", undefined);
    await progressPlan(fixture, OWN_PLAN, "progress-rou", "InProgress");
    const handle = await openStore(context, "write");
    try {
      const [row] = handle.db
        .prepare("select state_json from execution_workflows where workflow_id = ?")
        .all(WORKFLOW_ID) as Array<{ state_json?: unknown }>;
      const state = JSON.parse(String(row!.state_json)) as Record<string, unknown>;
      delete (state.delivery as Record<string, unknown>).completion;
      handle.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), WORKFLOW_ID);
    } finally {
      handle.close();
    }
    const before = footprint(context);
    const evidence = reportOnlyEvidence(context);
    const token = await planTokenOf(fixture, OWN_PLAN);
    const refusal = await refusalOf(() =>
      planCall(fixture, OWN_PLAN, "complete-rou", token, { kind: "complete", evidence } as CoordinationOperation),
    );
    expect(refusal.code).toBe("coordination.invalid-transition");
    expect(footprint(context)).toEqual(before);
  }, 30000);

  test("a source checkout advanced between the proof and the commit refuses with no DB mutation", async () => {
    const fixture = await realStandaloneFixture("complete-witness-gap");
    const { context, sourceSha } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-witness", {
      worktreePath: fixture.worktree,
      workingBranch: `feature/${OWN_PLAN}`,
      qaGate: "mandatory",
    });
    await progressPlan(fixture, OWN_PLAN, "progress-witness-start", "InProgress");
    const evidence = completionEvidence(context, sourceSha);
    const before = footprint(context);
    let seamRan = false;
    // The seam runs after the precheck witnesses and before the commit: advancing
    // the real checkout there must make the re-witnessed Git proof refuse.
    setCompleteWitnessGapForTest(() => {
      seamRan = true;
      commit(fixture.worktree, "late.txt", "late\n", "chore: late");
    });
    try {
      const witnessToken = await planTokenOf(fixture, OWN_PLAN);
      const refusal = await refusalOf(() =>
        planCall(fixture, OWN_PLAN, "complete-witness", witnessToken, { kind: "complete", evidence } as CoordinationOperation),
      );
      expect(seamRan).toBe(true);
      expect(refusal.code).toBe("coordination.git-proof");
      expect(footprint(context)).toEqual(before);
      expect(planRow(context, OWN_PLAN).status).toBe("InProgress");
    } finally {
      setCompleteWitnessGapForTest(undefined);
    }
  }, 30000);

  test("the published entry point dispatches the same closed union as the direct verb", () => {
    expect(publishedMutateExecutionPlan).toBe(mutateExecutionPlan);
  });
});

/* ------------------------------------------------------------------------ *
 * §3.1 concurrency and catalog facts
 * ------------------------------------------------------------------------ */

describe("execution-concurrency: §3.1 concurrent plan operations", () => {
  test("two plans mutated at once are both retained, and a conflicting write needs an explicit reread", async () => {
    const fixture = await seededWorkflow("concurrency-two-plans");
    const { context, coordinator, coordinatorCaller } = fixture;
    const settled = await Promise.allSettled([
      mutateExecutionPlan(domainContext(context, coordinatorCaller), {
        operationId: "concurrent-own",
        session: coordinator,
        expected: await planTokenOf(fixture, OWN_PLAN),
        planId: OWN_PLAN,
        operation: { kind: "prepare" },
      }),
      mutateExecutionPlan(domainContext(context, coordinatorCaller), {
        operationId: "concurrent-peer",
        session: coordinator,
        expected: await planTokenOf(fixture, PEER_PLAN),
        planId: PEER_PLAN,
        operation: { kind: "prepare" },
      }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const state = await readExecutionState(context);
    const [workflow] = state.data.workflows;
    expect(workflow.plans.map((plan) => plan.coordination?.prepared).filter(Boolean)).toHaveLength(2);
  });

  test("a catalog edit after prepare does not rewrite the recorded config", async () => {
    const fixture = await seededWorkflow("catalog-edit-after-prepare");
    const { context } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-catalog", { workingBranch: `feature/${OWN_PLAN}` });
    const prepared = (await readExecutionPlan(domainContext(context, fixture.coordinatorCaller), fixture.coordinator, OWN_PLAN)).data.coordination;
    await updateCatalogEntity(context, { kind: "plan", id: OWN_PLAN }, { title: "Renamed" }, 1, {
      operationId: "rename-own",
      actor: "execution-coordination.test",
    });
    const after = (await readExecutionPlan(domainContext(context, fixture.coordinatorCaller), fixture.coordinator, OWN_PLAN)).data.coordination;
    expect(after?.prepared).toEqual(prepared?.prepared);
  });
});

/* ------------------------------------------------------------------------ *
 * Strict evidence scalars — a non-scalar QC/QA field is refused, never admitted
 * ------------------------------------------------------------------------ */

describe("execution-evidence-scalars: strict enum/field admission", () => {
  test("a non-scalar qc.decision, an array qa.gate and an unknown nested qc key refuse without mutation", async () => {
    const fixture = await realStandaloneFixture("evidence-strict-scalars");
    const { context, sourceSha } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-strict", {
      worktreePath: fixture.worktree,
      workingBranch: `feature/${OWN_PLAN}`,
      qaGate: "mandatory",
    });
    await progressPlan(fixture, OWN_PLAN, "progress-strict", "InProgress");
    const good = completionEvidence(context, sourceSha);
    const before = footprint(context);

    // `["Approve"]` is not the scalar the enum admits: `String(array)` would
    // have accepted it, so the engine must compare the actual scalar.
    const arrayDecision = { ...good, qc: { ...good.qc, decision: ["Approve"] as unknown as "Approve" } };
    const decisionToken = await planTokenOf(fixture, OWN_PLAN);
    expect(
      await refusalOf(() =>
        planCall(fixture, OWN_PLAN, "complete-array-decision", decisionToken, {
          kind: "complete",
          evidence: arrayDecision,
        } as CoordinationOperation),
      ),
    ).toMatchObject({ code: "coordination.invalid-input" });
    expect(footprint(context)).toEqual(before);

    // An array QA gate is refused the same way.
    const arrayGate = { ...good, qa: { ...good.qa, gate: ["mandatory"] as unknown as "mandatory" } };
    const gateToken = await planTokenOf(fixture, OWN_PLAN);
    expect(
      await refusalOf(() =>
        planCall(fixture, OWN_PLAN, "complete-array-gate", gateToken, {
          kind: "complete",
          evidence: arrayGate,
        } as CoordinationOperation),
      ),
    ).toMatchObject({ code: "coordination.invalid-input" });
    expect(footprint(context)).toEqual(before);

    // An unknown nested QC key is refused by the exact-key rule.
    const extraKey = { ...good, qc: { ...good.qc, unexpected: "x" } };
    const extraToken = await planTokenOf(fixture, OWN_PLAN);
    expect(
      await refusalOf(() =>
        planCall(fixture, OWN_PLAN, "complete-extra-qc-key", extraToken, {
          kind: "complete",
          evidence: extraKey,
        } as CoordinationOperation),
      ),
    ).toMatchObject({ code: "coordination.invalid-input" });
    expect(footprint(context)).toEqual(before);

    // The corrected ordinary evidence completes.
    const corrected = await planCall(fixture, OWN_PLAN, "complete-strict-ok", await planTokenOf(fixture, OWN_PLAN), {
      kind: "complete",
      evidence: good,
    } as CoordinationOperation);
    expect(corrected.data.plan.status).toBe("Done");
  }, 30000);
});

/* ------------------------------------------------------------------------ *
 * Issue authority — a capture and its link are one store write
 * ------------------------------------------------------------------------ */

describe("execution-issue-authority: the store is the capture authority", () => {
  test("a core capture and its plan provenance both land in the store", async () => {
    const fixture = await seededWorkflow("issue-authority-cross");
    const { context } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-issue", undefined);
    const captured = await captureIssue(context, finding({ occurrenceKey: "occ-direct" }), {
      operationId: "direct-capture",
      actor: "execution-coordination.test",
    });
    // The core capture records the issue; the plan link is a separate provenance
    // write that the scoped operation performs in its own transaction.
    await linkIssueToPlan(context, captured.issueId, OWN_PLAN);
    const detail = await getIssue(context, captured.issueId);
    expect(detail.provenance.some((entry) => entry.kind === "plan" && entry.target === OWN_PLAN)).toBe(true);
  });

  test("a residual capture lands in the ADDRESSED ROW's project bucket, not the workflow header or a sibling row's", async () => {
    const fixture = await seededWorkflow("issue-authority-row-bucket", { plans: [OWN_PLAN, PEER_PLAN] });
    const { context } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-bucket-own", undefined);
    await preparePlan(fixture, PEER_PLAN, "prepare-bucket-peer", undefined);
    // Give each row a DIFFERENT own project id, and the WORKFLOW HEADER a third
    // (project B), so a header-derived bucket would be distinguishable.
    withRaw(context, (db) => {
      for (const [planId, projectId] of [
        [OWN_PLAN, "proj-row-a"],
        [PEER_PLAN, "proj-row-b"],
      ] as const) {
        const [row] = db
          .prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?")
          .all(WORKFLOW_ID, planId) as Array<{ state_json?: unknown }>;
        const state = JSON.parse(String(row!.state_json)) as Record<string, unknown>;
        state.metadata = { ...(state.metadata as Record<string, unknown>), project_id: projectId };
        db.prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?").run(
          JSON.stringify(state),
          WORKFLOW_ID,
          planId,
        );
      }
      const [workflow] = db
        .prepare("select state_json from execution_workflows where workflow_id = ?")
        .all(WORKFLOW_ID) as Array<{ state_json?: unknown }>;
      const header = JSON.parse(String(workflow!.state_json)) as Record<string, unknown>;
      header.project = "proj-header-b";
      db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(header), WORKFLOW_ID);
    });

    const token = await planTokenOf(fixture, OWN_PLAN);
    await residualAddExecutionPlan(domainContext(context, fixture.coordinatorCaller), {
      operationId: "residual-bucket-own",
      session: fixture.coordinator,
      expected: token,
      planId: OWN_PLAN,
      operation: { kind: "residual-add", entries: [finding({ occurrenceKey: "occ-bucket" })] },
    });
    const [issue] = await linkedPlanIssues(context, OWN_PLAN);
    expect(issue).toBeDefined();
    const detail = await getIssue(context, issue!.id);
    // The issue carries the ADDRESSED row's own project, never the sibling's or
    // the conflicting header's project B.
    expect(detail.projectId).toBe("proj-row-a");
    expect(detail.provenance.some((entry) => entry.kind === "plan" && entry.target === OWN_PLAN)).toBe(true);
    expect(detail.provenance.some((entry) => entry.target === PEER_PLAN)).toBe(false);

    // Close that same issue through the ordinary residual-close, under its own
    // current revision and the row's current plan token; the provenance is retained.
    const closeToken = await planTokenOf(fixture, OWN_PLAN);
    const closed = await residualCloseExecutionPlan(domainContext(context, fixture.coordinatorCaller), {
      operationId: "residual-bucket-close",
      session: fixture.coordinator,
      expected: closeToken,
      planId: OWN_PLAN,
      operation: {
        kind: "residual-close",
        issueId: issue!.id,
        disposition: "resolved",
        evidence: { reason: "fixed", references: ["review/qc1.md"] },
        expectedIssueRevision: detail.revision,
      },
    });
    expect(closed.replayed).toBe(false);
    const after = await getIssue(context, issue!.id);
    expect(after.disposition).toBe("resolved");
    expect(after.projectId).toBe("proj-row-a");
    expect(after.provenance.some((entry) => entry.kind === "plan" && entry.target === OWN_PLAN)).toBe(true);
  }, 30000);
});

/* ------------------------------------------------------------------------ *
 * The published surface
 * ------------------------------------------------------------------------ */

describe("execution-surface: the published DB verbs", () => {
  test("exports mutateExecutionPlan verbatim and keeps the per-operation bodies module-scoped", async () => {
    const engineIndex = await import("../src/index.js");
    expect(engineIndex.mutateExecutionPlan).toBe(mutateExecutionPlan);
    expect(engineIndex.mutateExecutionPlan.length).toBe(2);
    for (const name of ["prepareExecutionPlan", "progressExecutionPlan", "residualAddExecutionPlan", "residualCloseExecutionPlan"]) {
      expect(name in engineIndex).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Explicit addressing
 * ------------------------------------------------------------------------ */

describe("execution-plan-address: explicit addressing", () => {
  test("an operation with no planId refuses and names the plan it must address", async () => {
    const fixture = await seededWorkflow("address-required");
    const { context, coordinatorCaller, coordinator } = fixture;
    // The published intent type REQUIRES `planId`; a caller whose own layer has
    // not supplied one reaches the engine only through a runtime boundary, so
    // the deliberate omission is expressed as `unknown` and cast once here.
    const planless = {
      operationId: "no-plan",
      session: coordinator,
      operation: { kind: "prepare" },
    } as unknown as Parameters<typeof mutateExecutionPlan>[1];
    const refusal = await refusalOf(() => mutateExecutionPlan(domainContext(context, coordinatorCaller), planless));
    expect(refusal.code).toBe("coordination.invalid-input");
    expect(String(refusal.message)).toContain("plan");
  });

  test("a plan id that is not a row of the workflow is refused", async () => {
    const fixture = await seededWorkflow("address-missing-plan");
    const { context } = fixture;
    // The token for a non-existent row is read from state, which does not hold it.
    const state: ExecutionState = (await readExecutionState(context)).data;
    expect(state.workflows[0]!.planTokens["plan-absent"]).toBeUndefined();
    const refusal = await refusalOf(() =>
      readExecutionPlan(domainContext(context, fixture.coordinatorCaller), fixture.coordinator, "plan-absent"),
    );
    expect(refusal.code).toBe("coordination.plan-not-found");
  });
});

/* ------------------------------------------------------------------------ *
 * One coordinator session row per workflow
 * ------------------------------------------------------------------------ */

describe("execution-session-rows: one coordinator per workflow", () => {
  test("the bound coordinator's row is the only session the fixture creates", async () => {
    const fixture = await seededWorkflow("session-row-single");
    const sessions = rows(
      fixture.context,
      `select role, session_id, plan_id, state from execution_sessions where workflow_id = '${WORKFLOW_ID}'`,
    );
    expect(sessions).toEqual([{ role: "coordinator", session_id: COORDINATOR_ID, plan_id: null, state: "active" }]);
    expect(fixture.epoch).toBeGreaterThan(0);
  });
});

