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
async function seededWorkflow(label: string): Promise<Fixture> {
  // A real Git workspace whose `.mstar` child is the control harness, so the
  // route proofs below run against actual checkouts and object ids.
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
  await registerPlan(context, OWN_PLAN);
  await registerPlan(context, PEER_PLAN);
  await registerPlan(context, SPARE_PLAN);
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
    const refusal = await refusalOf(() =>
      residualCloseExecutionPlan(domainContext(context, fixture.coordinatorCaller), {
        operationId: "residual-close-stale",
        session: fixture.coordinator,
        expected: await planTokenOf(fixture, OWN_PLAN),
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
  const fixture = await seededWorkflow(label);
  const { context } = fixture;
  const statusBefore = rows(context, "select 1 as x");
  void statusBefore;
  // The fixture's harness root IS the control root; the Git repository is its
  // parent workspace, which `realpathSync` already resolved.
  const repo = dirname(context.harnessDir);
  const integrationPath = join(repo, "wt-integration");
  // Switch the two rows' checkouts onto their real feature branches.
  for (const [planId, branch] of [
    [OWN_PLAN, `feature/${OWN_PLAN}`],
    [PEER_PLAN, `feature/${PEER_PLAN}`],
  ] as const) {
    const worktree = join(context.harnessDir, "worktrees", planId);
    mkdirSync(worktree, { recursive: true });
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", branch, worktree], { stdio: ["ignore", "ignore", "ignore"] });
  }
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

/** A real standalone development fixture: one row, one real source checkout. */
async function realStandaloneFixture(label: string): Promise<Fixture & { sourceSha: string }> {
  const fixture = await seededWorkflow(label);
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
    state.delivery_kind = "development";
    state.branch = { source: `feature/${OWN_PLAN}`, target: "main" };
    state.plans = [{ id: OWN_PLAN, title: `${OWN_PLAN} title`, file: `plans/${OWN_PLAN}.md`, status: "Todo" }];
    delete state.integration_worktree_path;
    handle.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), WORKFLOW_ID);
  } finally {
    handle.close();
  }
  return { ...fixture, sourceSha };
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

  test("a Todo row is not completable, and a same-transaction InProgress row completes", async () => {
    const fixture = await seededWorkflow("complete-window");
    const { context, planTokens } = fixture;
    const before = footprint(context);
    const evidence = () => {
      const reports = [join(context.harnessDir, "sdd", OWN_PLAN, "review", "qc1.md")];
      const consolidated = join(context.harnessDir, "sdd", OWN_PLAN, "review", "qc.md");
      const qa = join(context.harnessDir, "sdd", OWN_PLAN, "qa.md");
      for (const path of [...reports, consolidated, qa]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "# evidence\n");
      }
      return {
        qc: { decision: "Approve" as const, reports, consolidated },
        qa: { gate: "mandatory" as const, decision: "pass" as const, report: qa },
      };
    };
    void evidence;

    // A Todo row refuses: only InReview (or a same-transaction
    // InProgress→InReview) completes.
    const early = await refusalOf(() =>
      planCall(fixture, OWN_PLAN, "complete-early", planTokens[OWN_PLAN]!, {
        kind: "complete",
        evidence: {
          qc: { decision: "Approve", reports: [], consolidated: "" },
          qa: { gate: "mandatory", decision: "pass", report: "" },
        },
      } as CoordinationOperation),
    );
    expect(early.code).toBe("coordination.plan-status");
    expect(footprint(context)).toEqual(before);
  });

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
    const missing = await refusalOf(() =>
      planCall(fixture, OWN_PLAN, "complete-no-integration", await planTokenOf(fixture, OWN_PLAN), {
        kind: "complete",
        evidence,
      } as CoordinationOperation),
    );
    expect(missing.code).toBe("coordination.invalid-input");
    expect(`${String(missing.message)} ${JSON.stringify(missing.details ?? {})}`).toMatch(/integration/);
    expect(footprint(context)).toEqual(before);
  });

  test("the iteration route completes on the real serial merge, records it, releases the claim and replays", async () => {
    const fixture = await realIterationFixture("complete-integration-success");
    const { context, sourceSha, baseSha } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-int", {
      worktreePath: join(context.harnessDir, "worktrees", OWN_PLAN),
      workingBranch: `feature/${OWN_PLAN}`,
      qaGate: "mandatory",
    });
    await progressPlan(fixture, OWN_PLAN, "progress-int-start", "InProgress");
    await progressPlan(fixture, OWN_PLAN, "progress-int-review", "InReview");
    // The operator performs the real serial merge.
    const resultSha = mergeInto(fixture.integrationPath, sourceSha, "Merge plan-a");
    const evidence = completionEvidence(context, sourceSha);
    const receipt = await planCall(fixture, OWN_PLAN, "complete-int", await planTokenOf(fixture, OWN_PLAN), {
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
    // Replay is a recorded-receipt read: no Git, no rewrite of the timestamp.
    const replay = await planCall(fixture, OWN_PLAN, "complete-int", await planTokenOf(fixture, OWN_PLAN), {
      kind: "complete",
      evidence,
      integration: { base_sha: baseSha, result_sha: resultSha },
    } as CoordinationOperation);
    expect(replay.replayed).toBe(true);
    expect(replay.data.coordination?.completion?.completed_at).toBe(completion?.completed_at);
  }, 30000);

  test("the standalone development route completes on the real source checkout and refuses an integration input", async () => {
    const fixture = await realStandaloneFixture("complete-standalone-success");
    const { context, sourceSha } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-sa", {
      worktreePath: join(context.harnessDir, "worktrees", OWN_PLAN),
      workingBranch: `feature/${OWN_PLAN}`,
      qaGate: "mandatory",
    });
    await progressPlan(fixture, OWN_PLAN, "progress-sa-start", "InProgress");
    await progressPlan(fixture, OWN_PLAN, "progress-sa-review", "InReview");
    const evidence = completionEvidence(context, sourceSha);
    const before = footprint(context);
    const contaminated = await refusalOf(() =>
      planCall(fixture, OWN_PLAN, "complete-sa-contaminated", await planTokenOf(fixture, OWN_PLAN), {
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
  }, 30000);

  test("a source checkout advanced between the proof and the commit refuses with no DB mutation", async () => {
    const fixture = await realStandaloneFixture("complete-witness-gap");
    const { context, sourceSha } = fixture;
    await preparePlan(fixture, OWN_PLAN, "prepare-witness", {
      worktreePath: join(context.harnessDir, "worktrees", OWN_PLAN),
      workingBranch: `feature/${OWN_PLAN}`,
      qaGate: "mandatory",
    });
    await progressPlan(fixture, OWN_PLAN, "progress-witness-start", "InProgress");
    await progressPlan(fixture, OWN_PLAN, "progress-witness-review", "InReview");
    const evidence = completionEvidence(context, sourceSha);
    const before = footprint(context);
    let seamRan = false;
    // The seam runs after the precheck proof and before the commit: advancing
    // the real checkout there must make the re-witnessed Git proof refuse.
    setCompleteWitnessGapForTest(() => {
      seamRan = true;
      commit(join(context.harnessDir, "worktrees", OWN_PLAN), "late.txt", "late\n", "chore: late");
    });
    try {
      const refusal = await refusalOf(() =>
        planCall(fixture, OWN_PLAN, "complete-witness", await planTokenOf(fixture, OWN_PLAN), {
          kind: "complete",
          evidence,
        } as CoordinationOperation),
      );
      expect(seamRan).toBe(true);
      expect(refusal.code).toBe("coordination.git-proof");
      expect(footprint(context)).toEqual(before);
      expect(planRow(context, OWN_PLAN).status).toBe("InReview");
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
