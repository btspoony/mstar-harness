/**
 * execution-consumers.test.ts — proof for the authoritative READ adapter and
 * the consumer read route (primary spec §5, plan task S2; the cross-domain
 * closure scenario is the separate `execution-cross-domain` group this file
 * carries for S6).
 *
 * Run with
 * `bun test packages/engine/src/execution-consumers.test.ts --test-name-pattern 'execution-authority-read'`
 * (the retained-evidence proof is selected by `-t "retained evidence"`).
 *
 * Every case runs the REAL modules against a REAL `node:sqlite` store in a
 * per-test temporary control root: the real `initializeExecutionAuthority` /
 * `registerCatalogEntity` / `createExecutionWorkflow` producers build the
 * fixture, and the adapter reads what they actually committed. No mocked
 * database and no fixture-written success state.
 *
 * Acceptance criteria carried by these cases:
 *
 * - `-no-selection-` / `-workflow-selection-` / `-plan-selection-`: exact
 *   scoped selection — the registry/root token, the selected workflow token and
 *   the plan token, each verified against the same token the creating producers
 *   minted; an address that is not exactly a registered lifecycle (or not a
 *   plan of the addressed workflow) refuses instead of guessing.
 * - `-serves-the-db-state-`: leftover root/snapshot JSON planted AFTER the
 *   commit changes nothing about the read — the adapter answers with the
 *   committed store, not with the file bytes the retired route held.
 * - `-route-`: the DB adapter answers an ACTIVE authority; `legacy`, a store
 *   whose schema predates the execution tables, and a harness with no store at
 *   all keep the unchanged file route; a store that EXISTS and cannot answer
 *   refuses instead of degrading to files.
 * - `-refuses-an-unusable-store-`: a missing store, a non-active authority, a
 *   corrupt store and a store held past the bounded wait are each an explicit
 *   refusal — never an empty success and never a file fallback.
 * - `execution-cross-domain-reads-*`: on a store whose accepted registration is
 *   already committed, an authority that becomes unavailable refuses EVERY
 *   authoritative read and never serves the retired file route's leftover bytes
 *   or a projection derived from them.
 * - `retained evidence …`: SDD evidence bodies stay FILES under the configured
 *   roots with provenance recorded at direct completion, across an authority
 *   switch and with no copy in the store. Missing bodies and symlink escapes
 *   refuse; content edits do not act as an integrity gate.
 * - `retained evidence at the completion consumer …`: the same properties at
 *   the real DB `complete` operation of a real Git control harness.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCatalogEntity } from "./catalog.js";
import { assertEvidenceInsidePlanArea, planAreaRoots } from "./coordination.js";
import type { CompletionEvidence } from "./coordination-write.js";
import { readCompletionEvidence } from "./coordination-transitions.js";
import {
  completeExecutionPlan,
  prepareExecutionPlan,
  progressExecutionPlan,
  setCompleteWitnessGapForTest,
} from "./execution-coordination.js";
import { readExecutionAuthority } from "./execution-read.js";
import { commitExecutionRegistration } from "./execution-registration.js";
import {
  createExecutionWorkflow,
  bindExecutionSession,
  initializeExecutionAuthority,
  parseExecutionToken,
  readExecutionPlan,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionPlanView,
  type ExecutionSessionRef,
  type ExecutionState,
} from "./execution-store.js";
import { resolveSddDir } from "./path.js";
import { backupStore } from "./store-activation.js";
import { initializeStore, type StoreContext } from "./store-db.js";
import { queryDashboard, readExecutionSource, resolveExecutionReadRoute, withStoreRead } from "./store-read.js";
import { WORKFLOW_SNAPSHOT_FILE, type WorkflowSnapshot } from "./workflow.js";
import type { WorkflowEntry } from "./status.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-consumers-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const TS = "2026-09-21T00:00:00.000Z";
const WORKFLOW_A = "wf-consumers-a";
const WORKFLOW_B = "wf-consumers-b";
const PLAN_A1 = "20260920-consumers-a1";
const PLAN_A2 = "20260920-consumers-a2";
const PLAN_B1 = "20260920-consumers-b1";
/** The cross-domain group's own accepted lifecycle (S6). */
const CROSS_WORKFLOW = "wf-consumers-cross-domain";
const CROSS_PLAN = "20260920-consumers-cross-domain";

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

function controlRoot(label: string): StoreContext {
  return { harnessDir: mkdtempSync(join(ROOT, `${label}-`)) };
}

function domainContext(context: StoreContext, caller: ExecutionCaller): ExecutionContext {
  return { harnessDir: context.harnessDir, caller };
}

function callerOf(workflowId: string): ExecutionCaller {
  return { sessionId: `host-${workflowId}`, role: "coordinator", workflowId };
}

/** One create request: the root entry plus the snapshot its plan rows come from. */
function creationInput(workflowId: string, planIds: string[]): { entry: WorkflowEntry; snapshot: WorkflowSnapshot } {
  return {
    entry: { id: workflowId, type: "plan", started_at: TS, dir: `workflows/${workflowId}` },
    snapshot: {
      schema_version: 1,
      id: workflowId,
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
      delivery_kind: "development",
      branch: { source: `feature/${workflowId}`, target: "main" },
    },
  };
}

/** An ACTIVE authority holding two registered workflows (A: two plans, B: one). */
async function activeGraph(label: string): Promise<StoreContext> {
  const context = controlRoot(label);
  const handle = await initializeStore(context);
  handle.close();
  const initialized = await initializeExecutionAuthority(context);
  for (const planId of [PLAN_A1, PLAN_A2, PLAN_B1]) {
    await registerCatalogEntity(
      context,
      { kind: "plan", id: planId, title: `${planId} title`, rootKind: "plans", relativePath: `${planId}.md` },
      { operationId: `register-${planId}`, actor: "execution-consumers.test" },
    );
  }
  await createExecutionWorkflow(domainContext(context, callerOf(WORKFLOW_A)), {
    ...creationInput(WORKFLOW_A, [PLAN_A1, PLAN_A2]),
    expected: initialized.token,
    operationId: `create-${WORKFLOW_A}`,
  });
  const afterA = await readExecutionState(context);
  await createExecutionWorkflow(domainContext(context, callerOf(WORKFLOW_B)), {
    ...creationInput(WORKFLOW_B, [PLAN_B1]),
    expected: afterA.token,
    operationId: `create-${WORKFLOW_B}`,
  });
  return context;
}

/**
 * A store whose recorded migrations stop before `execution-authority`
 * (migration 4): the execution schema was never applied to it, so its recorded
 * rows must stay a CONTIGUOUS prefix (1..3). Deleting only migration 4 would
 * leave the [1,2,3,5] hole a real corrupted store has, and the C1 contiguity
 * check refuses that shape as `store.schema-drift` — this fixture is about a
 * store that simply predates the execution tables, not about drift.
 */
async function preExecutionStore(label: string): Promise<StoreContext> {
  const context = controlRoot(label);
  const handle = await initializeStore(context);
  handle.close();
  const db = new DatabaseSync(join(context.harnessDir, "store.db"));
  try {
    db.exec("delete from schema_version where version >= 4");
  } finally {
    db.close();
  }
  return context;
}

/** A store that HAS the execution schema, recorded `legacy` (§2.1). */
async function legacyStore(label: string): Promise<StoreContext> {
  const context = controlRoot(label);
  const handle = await initializeStore(context);
  handle.close();
  return context;
}

/** Overwrite the store bytes with a file the driver cannot read as a database. */
function corruptStore(context: StoreContext): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(context.harnessDir, `store.db${suffix}`), { force: true });
  writeFileSync(join(context.harnessDir, "store.db"), "this is not a sqlite database\n");
}

async function refusalOf(action: () => Promise<unknown>): Promise<{ code: string }> {
  try {
    await action();
  } catch (error) {
    return { code: String((error as { code?: unknown })?.code ?? "") };
  }
  throw new Error("expected a refusal");
}

/* ------------------------------------------------------------------------ *
 * execution-authority-read — the adapter (primary spec §5)
 * ------------------------------------------------------------------------ */

describe("execution-authority-read \u2014 one exact read of the committed authority", () => {
  test("no selection returns the registry/root token and the whole state", async () => {
    const context = await activeGraph("authority-read-root");
    const committed = await readExecutionState(context);

    const read = await readExecutionAuthority(context);

    expect(read.storeId).toBe(committed.storeId);
    expect(read.epoch).toBe(committed.epoch);
    // The registry/root token: the same CAS the committed write handed back.
    expect(read.token).toBe(committed.token);
    expect(String(read.token).startsWith("exec-v1:root:")).toBe(true);
    // The whole graph: both registered lifecycles, in registry order.
    expect((read.data as ExecutionState).workflows.map((workflow) => workflow.state.id)).toEqual([
      WORKFLOW_A,
      WORKFLOW_B,
    ]);
    expect((read.data as ExecutionState).root.workflows.map((entry) => entry.id)).toEqual([WORKFLOW_A, WORKFLOW_B]);
  });

  test("a workflow selection returns that workflow's token and scope, never a sibling's", async () => {
    const context = await activeGraph("authority-read-workflow");
    const committed = await readExecutionState(context);
    const workflowB = committed.data.workflows.find((workflow) => workflow.state.id === WORKFLOW_B)!;

    const read = await readExecutionAuthority(context, { workflowId: WORKFLOW_B });
    const state = read.data as ExecutionState;

    // The selected workflow's own token — its kind and key, not the sibling's.
    expect(read.token).toBe(workflowB.workflowToken);
    const parsed = parseExecutionToken(read.token);
    expect(parsed.kind).toBe("workflow");
    expect(parsed.key).toEqual([WORKFLOW_B]);
    expect(read.storeId).toBe(committed.storeId);
    expect(read.epoch).toBe(committed.epoch);
    // Scoped: exactly the addressed lifecycle is materialized, and the token the
    // scope carries is the same one the envelope returns (§5's child CAS).
    expect(state.workflows.map((workflow) => workflow.state.id)).toEqual([WORKFLOW_B]);
    expect(state.workflows[0]!.workflowToken).toBe(read.token);
    expect(state.workflows[0]!.state.branch).toEqual({ source: `feature/${WORKFLOW_B}`, target: "main" });
    expect(Object.keys(state.workflows[0]!.planTokens)).toEqual([PLAN_B1]);
    // The register travels as read — membership is the root's own content and a
    // scoped read never re-synthesizes it.
    expect(state.root.workflows.map((entry) => entry.id)).toEqual([WORKFLOW_A, WORKFLOW_B]);
  });

  test("a plan selection requires its workflow and returns the plan token", async () => {
    const context = await activeGraph("authority-read-plan");
    const committed = await readExecutionState(context);
    const workflowA = committed.data.workflows.find((workflow) => workflow.state.id === WORKFLOW_A)!;

    // A lone plan id is a malformed address, not a wider selection.
    expect(await refusalOf(() => readExecutionAuthority(context, { planId: PLAN_A1 }))).toEqual({
      code: "coordination.invalid-input",
    });

    const read = await readExecutionAuthority(context, { workflowId: WORKFLOW_A, planId: PLAN_A2 });
    const view = read.data as ExecutionPlanView;

    expect(read.token).toBe(workflowA.planTokens[PLAN_A2]!);
    expect(read.storeId).toBe(committed.storeId);
    expect(read.epoch).toBe(committed.epoch);
    expect(view.plan.id).toBe(PLAN_A2);
    expect(view.workflow.id).toBe(WORKFLOW_A);
    expect(view.coordination).toBeNull();
    expect(view.integrationLease).toBeNull();
    expect(view.frozenInput).toBeNull();
    // The sibling plan of the same workflow is a different address, and a plan
    // id from another workflow is not this workflow's plan.
    expect(read.token).not.toBe(workflowA.planTokens[PLAN_A1]!);
    expect(await refusalOf(() => readExecutionAuthority(context, { workflowId: WORKFLOW_B, planId: PLAN_A1 }))).toEqual({
      code: "coordination.plan-not-found",
    });
    expect(
      await refusalOf(() => readExecutionAuthority(context, { workflowId: WORKFLOW_A, planId: "plan-consumers-absent" })),
    ).toEqual({ code: "coordination.plan-not-found" });

    // Exactness: an unregistered workflow refuses too — never a newest/only
    // entry, and never a selection silently widened to the whole state.
    expect(await refusalOf(() => readExecutionAuthority(context, { workflowId: "wf-consumers-absent" }))).toEqual({
      code: "coordination.workflow-not-found",
    });
  });

  test("serves the committed DB state despite stale root/snapshot JSON on disk", async () => {
    const context = await activeGraph("authority-read-stale-json");
    // The baseline the adapter must keep answering: what the producers
    // committed. The bytes planted below belong to the retired file route, not
    // to this authority.
    const before = await readExecutionAuthority(context, { workflowId: WORKFLOW_A });
    const beforeAll = await readExecutionAuthority(context);

    const workflowsDir = join(context.harnessDir, "workflows", WORKFLOW_A);
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(context.harnessDir, "status.json"),
      `${JSON.stringify({ version: 2, updated_at: "2000-01-01", workflows: [] })}\n`,
    );
    writeFileSync(
      join(workflowsDir, WORKFLOW_SNAPSHOT_FILE),
      `${JSON.stringify({
        schema_version: 1,
        id: WORKFLOW_A,
        type: "plan",
        status: "completed",
        started_at: TS,
        updated_at: TS,
        plans: [{ id: "plan-from-the-file", title: "file", file: "plans/file.md", status: "Done" }],
      })}\n`,
    );

    const after = await readExecutionAuthority(context, { workflowId: WORKFLOW_A });
    const afterAll = await readExecutionAuthority(context);

    expect(after).toEqual(before);
    expect(afterAll).toEqual(beforeAll);
    // Concretely: the file's terminal status and its invented plan row reach
    // neither the scoped read nor the registry view.
    expect((after.data as ExecutionState).workflows[0]!.state.status).toBe("running");
    expect((after.data as ExecutionState).workflows[0]!.plans.map((plan) => plan.plan.id)).toEqual([PLAN_A1, PLAN_A2]);
    expect((afterAll.data as ExecutionState).root.workflows).toHaveLength(2);
  });

  test("route stays file-authoritative below activation and refuses a store that cannot answer", async () => {
    const active = await activeGraph("authority-read-route-active");
    const legacy = await legacyStore("authority-read-route-legacy");
    const preExecution = await preExecutionStore("authority-read-route-unmigrated");
    const absent = controlRoot("authority-read-route-absent");

    expect(await resolveExecutionReadRoute(active)).toBe("execution");
    const served = await readExecutionSource(active, { workflowId: WORKFLOW_A, planId: PLAN_A1 });
    if (served.route !== "execution") throw new Error("an ACTIVE authority must answer with the DB route");
    expect(served.read).toEqual(await readExecutionAuthority(active, { workflowId: WORKFLOW_A, planId: PLAN_A1 }));

    // `legacy`, a store whose schema predates the execution tables, and a
    // harness with no store at all keep the unchanged file route...
    expect(await resolveExecutionReadRoute(legacy)).toBe("files");
    expect(await readExecutionSource(legacy, { workflowId: WORKFLOW_A })).toEqual({ route: "files" });
    expect(await resolveExecutionReadRoute(preExecution)).toBe("files");
    expect(await resolveExecutionReadRoute(absent)).toBe("files");
    // ...and the DB adapter itself refuses to serve them as empty state.
    expect(await refusalOf(() => readExecutionAuthority(legacy))).toEqual({ code: "execution.not-active" });
    expect(await refusalOf(() => readExecutionAuthority(preExecution))).toEqual({ code: "execution.not-active" });
    // A malformed address is refused before any route verdict can answer it.
    expect(await refusalOf(() => readExecutionSource(legacy, { planId: PLAN_A1 }))).toEqual({
      code: "coordination.invalid-input",
    });

    // A store that EXISTS and cannot be read is never "files": leftover JSON is
    // not an authority answer (§2.1/§5).
    const corrupt = await activeGraph("authority-read-route-corrupt");
    corruptStore(corrupt);
    expect(await refusalOf(() => resolveExecutionReadRoute(corrupt))).toEqual({ code: "store.corrupt" });
    expect(await refusalOf(() => readExecutionSource(corrupt, { workflowId: WORKFLOW_A }))).toEqual({
      code: "store.corrupt",
    });
  });

  test("refuses an unusable store instead of an empty success", async () => {
    // No store: never served as an empty registry.
    const absent = controlRoot("authority-read-absent");
    expect(await refusalOf(() => readExecutionAuthority(absent))).toEqual({ code: "store.not-initialized" });
    expect(await refusalOf(() => readExecutionAuthority(absent, { workflowId: WORKFLOW_A }))).toEqual({
      code: "store.not-initialized",
    });

    // A store whose recorded schema stops before the execution tables.
    const preExecution = await preExecutionStore("authority-read-unmigrated");
    expect(await refusalOf(() => readExecutionAuthority(preExecution))).toEqual({ code: "execution.not-active" });

    // Corrupt store bytes.
    const corrupt = await activeGraph("authority-read-corrupt");
    corruptStore(corrupt);
    expect(await refusalOf(() => readExecutionAuthority(corrupt))).toEqual({ code: "store.corrupt" });

    // A store another writer holds past the bounded wait: the read waits, then
    // reports the busy refusal. The copy is how this suite obtains bytes no open
    // handle already owns (the landed `VACUUM INTO` backup), so the competing
    // writer really holds the file.
    const holderRoot = controlRoot("authority-read-busy-holder");
    await backupStore(await activeGraph("authority-read-busy"), { out: join(holderRoot.harnessDir, "store.db") });
    const holder = new DatabaseSync(join(holderRoot.harnessDir, "store.db"));
    const sessionRunner = process.env.MSTAR_STORE_TEST_RUNNER;
    const busyTimeout = process.env.MSTAR_STORE_BUSY_TIMEOUT_MS;
    try {
      holder.exec("pragma busy_timeout=0");
      holder.exec("pragma journal_mode=delete");
      holder.exec("begin exclusive");
      holder.prepare("select count(*) as n from store_meta").get();
      process.env.MSTAR_STORE_TEST_RUNNER = "1";
      process.env.MSTAR_STORE_BUSY_TIMEOUT_MS = "50";
      expect(await refusalOf(() => readExecutionAuthority(holderRoot))).toEqual({ code: "store.busy" });
      expect(await refusalOf(() => resolveExecutionReadRoute(holderRoot))).toEqual({ code: "store.busy" });
    } finally {
      try {
        holder.exec("rollback");
      } catch {
        // the exclusive section may already be gone
      }
      holder.close();
      if (sessionRunner === undefined) delete process.env.MSTAR_STORE_TEST_RUNNER;
      else process.env.MSTAR_STORE_TEST_RUNNER = sessionRunner;
      if (busyTimeout === undefined) delete process.env.MSTAR_STORE_BUSY_TIMEOUT_MS;
      else process.env.MSTAR_STORE_BUSY_TIMEOUT_MS = busyTimeout;
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Cross-domain closure (S6)
 * ------------------------------------------------------------------------ */

/**
 * One store whose registration was ACCEPTED through the DB route: an ACTIVE
 * authority holding `CROSS_WORKFLOW`'s lifecycle and its catalog entity,
 * committed by `commitExecutionRegistration` in one transaction.
 */
async function registeredStore(label: string): Promise<StoreContext> {
  const context = controlRoot(label);
  const handle = await initializeStore(context);
  handle.close();
  const initialized = await initializeExecutionAuthority(context);
  // The SELECTED plan document the registration proves (§4/R1): its `plan_id`
  // header is the identity authority the pointer resolves against, and its
  // heading is the title authority the declared title must state. It lives in
  // the plan root this fixture DECLARES (`.mstarc plan_dir`): a `plans/`
  // directory directly under the control root would be read as a harness marker
  // by the harness-root probe and re-point the store.
  const planTitle = "Cross-domain accepted plan";
  const planDir = "plan-docs";
  const planFile = `${planDir}/${CROSS_PLAN}.md`;
  writeFileSync(join(context.harnessDir, ".mstarc"), `[config]\nplan_dir=${planDir}\n`);
  mkdirSync(join(context.harnessDir, planDir), { recursive: true });
  writeFileSync(
    join(context.harnessDir, planDir, `${CROSS_PLAN}.md`),
    `# ${planTitle}\n\n**plan_id:** ${CROSS_PLAN}\n`,
  );
  await commitExecutionRegistration(
    { harnessDir: context.harnessDir, caller: callerOf(CROSS_WORKFLOW) },
    {
      operationId: `register-${CROSS_WORKFLOW}`,
      actor: "execution-consumers.test",
      expectedCatalogRevision: 0,
      workflow: {
        kind: "plan",
        workflowId: CROSS_WORKFLOW,
        options: {
          harnessDir: context.harnessDir,
          plan: { id: CROSS_PLAN, title: planTitle, file: planFile },
          deliveryKind: "development",
          branchSource: `feature/${CROSS_WORKFLOW}`,
          branchTarget: "main",
          project: "_default",
          startedAt: TS,
        },
      },
      delta: {
        entities: [
          {
            kind: "plan",
            id: CROSS_PLAN,
            title: "Cross-domain accepted plan",
            rootKind: "plans",
            relativePath: `${CROSS_PLAN}.md`,
          },
        ],
        binding: { catalogKind: "plan", catalogId: CROSS_PLAN },
      },
      expected: initialized.token,
    },
  );
  return context;
}

/** The retired file route's bytes for the accepted workflow (§2.1 leftovers). */
function plantRetiredFileRoute(context: StoreContext): string {
  const workflowDir = join(context.harnessDir, "workflows", CROSS_WORKFLOW);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(context.harnessDir, "status.json"),
    `${JSON.stringify({ version: 2, updated_at: "2000-01-01", workflows: [] })}\n`,
  );
  const snapshotPath = join(workflowDir, WORKFLOW_SNAPSHOT_FILE);
  writeFileSync(
    snapshotPath,
    `${JSON.stringify({
      schema_version: 1,
      id: CROSS_WORKFLOW,
      type: "plan",
      status: "completed",
      started_at: TS,
      updated_at: TS,
      plans: [{ id: "plan-from-the-file", title: "file", file: "plans/file.md", status: "Done" }],
    })}\n`,
  );
  return snapshotPath;
}

describe("execution-cross-domain \u2014 an unavailable authority refuses every read", () => {
  test("execution-cross-domain-reads-never-answer-from-old-json-or-projections", async () => {
    const context = await registeredStore("cross-domain-unavailable");
    plantRetiredFileRoute(context);
    // The planted bytes, captured AFTER planting and BEFORE the reads under
    // test, so the comparison below measures the reads, not the fixture. These
    // are the exact file bytes: a marker substring would survive a partial
    // rewrite of the same JSON, which is the failure this scenario exists to
    // catch.

    // The ACCEPTED registration is what the authority answers with: its own
    // Todo plan, not the file's Done one, and the DB route is the route.
    const baseline = await readExecutionAuthority(context, { workflowId: CROSS_WORKFLOW, planId: CROSS_PLAN });
    // The address is exact, so the adapter answers the PLAN view; name the
    // narrowed union member once instead of casting at the field read.
    const baselineView = baseline.data as ExecutionPlanView;
    expect(baselineView.plan.status).toBe("Todo");
    expect(await resolveExecutionReadRoute(context)).toBe("execution");

    // The active DB becomes unavailable: the store's bytes can no longer be
    // read as a database. The accepted registration exists only in that store.
    corruptStore(context);

    // EVERY authoritative read refuses, at each address and at each entry
    // point: the adapter, the route probe, the routed source read and the
    // dashboard projection boundary behind which the retired file route hides.
    expect(await refusalOf(() => readExecutionAuthority(context))).toEqual({ code: "store.corrupt" });
    expect(await refusalOf(() => readExecutionAuthority(context, { workflowId: CROSS_WORKFLOW }))).toEqual({
      code: "store.corrupt",
    });
    expect(await refusalOf(() => readExecutionAuthority(context, { workflowId: CROSS_WORKFLOW, planId: CROSS_PLAN }))).toEqual({
      code: "store.corrupt",
    });
    expect(await refusalOf(() => resolveExecutionReadRoute(context))).toEqual({ code: "store.corrupt" });
    expect(await refusalOf(() => readExecutionSource(context, { workflowId: CROSS_WORKFLOW }))).toEqual({
      code: "store.corrupt",
    });
    expect(await refusalOf(() => withStoreRead(context, queryDashboard("workflows")))).toEqual({ code: "store.corrupt" });

  });
});

/* ------------------------------------------------------------------------ *
 * Retained SDD evidence (S9)
 * ------------------------------------------------------------------------ */

const RETAINED_PLAN = "20260920-consumers-retained";
const QC_BODY = "reviewed QC body\n";
const CONSOLIDATED_BODY = "consolidated QC body\n";
const QA_BODY = "QA verdict body\n";

/** The three completion evidence bodies of one plan, under the CONFIGURED SDD
 * resolution — the same resolution the containment boundary derives its roots
 * from. */
function retainedBodies(harnessDir: string): { qc: string; consolidated: string; qa: string } {
  const sddDir = resolveSddDir(harnessDir, RETAINED_PLAN);
  mkdirSync(sddDir, { recursive: true });
  return { qc: join(sddDir, "qc1.md"), consolidated: join(sddDir, "qc.md"), qa: join(sddDir, "qa.md") };
}

/** Write one evidence body. */
function writeBody(path: string, text: string): void {
  writeFileSync(path, text, "utf8");
}

/** Ordinary completion evidence; helper-only checks use synthetic revisions,
 * while the consumer fixture supplies the actual reviewed Git commits. */
function completionRequest(
  bodies: { qc: string; consolidated: string; qa: string },
  revisions: { sourceSha: string; baseSha: string } = { sourceSha: "a".repeat(40), baseSha: "b".repeat(40) },
): CompletionEvidence {
  return {
    source_sha: revisions.sourceSha,
    review_base: revisions.baseSha,
    review_head: revisions.sourceSha,
    qc: { decision: "Approve", reports: [bodies.qc], consolidated: bodies.consolidated },
    qa: { gate: "mandatory", decision: "pass", report: bodies.qa },
  };
}

/** The typed refusal of one synchronous call: its stable code, whatever domain
 * raised it. */
function refusalCodeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) return String(error.code);
    return "";
  }
  throw new Error("expected a refusal");
}

/**
 * Evidence remains in files across an authority switch. Current containment
 * and existence checks decide whether the submitted evidence is usable;
 * recorded digests are provenance, not content seals.
 */
describe("retained evidence path checks across the authority switch", () => {
  test("completion evidence stays in files and path containment remains enforced", async () => {
    // A store that holds an issue/catalog authority and no execution authority
    // yet: the evidence bodies are created before activation.
    const context = await legacyStore("retained-evidence-switch");
    const bodies = retainedBodies(context.harnessDir);
    writeBody(bodies.qc, QC_BODY);
    writeBody(bodies.consolidated, CONSOLIDATED_BODY);
    writeBody(bodies.qa, QA_BODY);

    // The switch: the fixture's execution authority becomes ACTIVE.
    await initializeExecutionAuthority(context);
    expect(await resolveExecutionReadRoute(context)).toBe("execution");

    // The direct completion boundary checks the plan's own configured areas.
    const input = readCompletionEvidence(completionRequest(bodies));
    expect(() => assertEvidenceInsidePlanArea(planAreaRoots(context.harnessDir, RETAINED_PLAN), input.evidence_paths)).not.toThrow();


    // No blanket blob conversion: the bodies are files, and the active store —
    // main file and, when present, its write-ahead log — holds no copy of them.
    const storedBytes = [join(context.harnessDir, "store.db"), join(context.harnessDir, "store.db-wal")]
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path));
    for (const text of [QC_BODY, CONSOLIDATED_BODY, QA_BODY]) {
      expect(storedBytes.some((bytes) => bytes.includes(Buffer.from(text)))).toBe(false);
    }
  });

  test("retained evidence: a missing body is unavailable and cannot be accepted", async () => {
    const context = await activeGraph("retained-evidence-missing");
    const bodies = retainedBodies(context.harnessDir);
    writeBody(bodies.qc, QC_BODY);
    writeBody(bodies.consolidated, CONSOLIDATED_BODY);
    writeBody(bodies.qa, QA_BODY);
    const roots = planAreaRoots(context.harnessDir, RETAINED_PLAN);

    rmSync(bodies.qc);

    // Evidence must exist when it is submitted.
    expect(refusalCodeOf(() => assertEvidenceInsidePlanArea(roots, [bodies.qc]))).toBe("coordination.invalid-input");
    // Validated completion paths still go through the real existence boundary.
    expect(refusalCodeOf(() => assertEvidenceInsidePlanArea(
      roots, readCompletionEvidence(completionRequest(bodies)).evidence_paths,
    ))).toBe("coordination.invalid-input");
  });

  test("retained evidence path containment refuses a symlink escape", async () => {
    const context = await activeGraph("retained-evidence-path-escape");
    const bodies = retainedBodies(context.harnessDir);
    writeBody(bodies.qc, QC_BODY);
    writeBody(bodies.consolidated, CONSOLIDATED_BODY);
    writeBody(bodies.qa, QA_BODY);
    const roots = planAreaRoots(context.harnessDir, RETAINED_PLAN);
    // A symlink that resolves outside the plan's own areas is refused by the
    // containment boundary. The escape is real — the bytes read through the
    // link are the outside file's — so containment, not the caller's path
    // spelling, is what stops it.
    const outside = join(context.harnessDir, "outside-body.md");
    const outsideText = "a body outside every plan area\n";
    writeBody(outside, outsideText);
    const escaped = join(resolveSddDir(context.harnessDir, RETAINED_PLAN), "escaped.md");
    symlinkSync(outside, escaped);
    expect(refusalCodeOf(() => assertEvidenceInsidePlanArea(roots, [escaped]))).toBe("coordination.path-mismatch");
  });
});

/* ------------------------------------------------------------------------ *
 * Retained SDD evidence at the completion consumer (S9)
 * ------------------------------------------------------------------------ */

const RETAINED_WORKFLOW = "wf-consumers-retained";

type RetainedCoordinator = { caller: ExecutionCaller; session: ExecutionSessionRef };

type RetainedCompletionFixture = {
  context: StoreContext;
  harnessRoot: string;
  worktreePath: string;
  sourceSha: string;
  baseSha: string;
  coordinator: RetainedCoordinator;
};

/** One git command in a disposable fixture repository. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function retainedCompletionBodies(harnessRoot: string): { qc: string; consolidated: string; qa: string } {
  const sddDir = resolveSddDir(harnessRoot, RETAINED_PLAN);
  mkdirSync(join(sddDir, "review"), { recursive: true });
  return {
    qc: join(sddDir, "review", "qc1.md"),
    consolidated: join(sddDir, "review", "qc.md"),
    qa: join(sddDir, "qa.md"),
  };
}

async function retainedPlanRead(fixture: RetainedCompletionFixture) {
  return readExecutionPlan(
    domainContext(fixture.context, fixture.coordinator.caller),
    fixture.coordinator.session,
    RETAINED_PLAN,
  );
}

/** A real standalone checkout, configured and started by its sole coordinator. */
async function retainedCompletionFixture(label: string): Promise<RetainedCompletionFixture> {
  const repoRoot = realpathSync(mkdtempSync(join(ROOT, `${label}-`)));
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["-c", "user.email=mstar@example.com", "-c", "user.name=mstar", "commit", "-q", "--allow-empty", "-m", "init"]);
  const harnessRoot = join(repoRoot, ".mstar");
  const planPath = join(harnessRoot, "plans", `${RETAINED_PLAN}.md`);
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `# ${RETAINED_PLAN}\n`);
  const context: StoreContext = { harnessDir: repoRoot };
  const store = await initializeStore(context);
  store.close();
  const initialized = await initializeExecutionAuthority(context);
  await registerCatalogEntity(
    context,
    {
      kind: "plan",
      id: RETAINED_PLAN,
      title: `${RETAINED_PLAN} title`,
      rootKind: "plans",
      relativePath: `${RETAINED_PLAN}.md`,
    },
    { operationId: `register-${label}`, actor: "execution-consumers.test" },
  );

  const worktreePath = join(repoRoot, "wt-retained");
  git(repoRoot, ["worktree", "add", "-q", "-b", `feature/${RETAINED_PLAN}`, worktreePath]);
  writeFileSync(join(worktreePath, "slice.txt"), "reviewed slice\n", "utf8");
  git(worktreePath, ["add", "-A"]);
  git(worktreePath, ["-c", "user.email=mstar@example.com", "-c", "user.name=mstar", "commit", "-q", "-m", "feat: slice"]);
  const sourceSha = git(worktreePath, ["rev-parse", "HEAD"]);
  const baseSha = git(repoRoot, ["rev-parse", "HEAD"]);

  const coordinatorCaller: ExecutionCaller = {
    sessionId: "host-retained-coordinator",
    role: "coordinator",
    workflowId: RETAINED_WORKFLOW,
  };
  const created = await createExecutionWorkflow(domainContext(context, coordinatorCaller), {
    entry: { id: RETAINED_WORKFLOW, type: "plan", started_at: TS, dir: `workflows/${RETAINED_WORKFLOW}` },
    snapshot: {
      schema_version: 1,
      id: RETAINED_WORKFLOW,
      type: "plan",
      status: "running",
      started_at: TS,
      updated_at: TS,
      plans: [{ id: RETAINED_PLAN, title: `${RETAINED_PLAN} title`, file: `plans/${RETAINED_PLAN}.md`, status: "Todo" }],
      delivery_kind: "development",
      branch: { base: "main", source: `feature/${RETAINED_PLAN}`, target: "main" },
    },
    expected: initialized.token,
    operationId: `create-${label}`,
  });
  const bound = await bindExecutionSession(domainContext(context, coordinatorCaller), {
    workflowId: RETAINED_WORKFLOW,
    expected: created.data.workflows[0]!.workflowToken,
    operationId: `bind-coordinator-${label}`,
  });
  const fixture: RetainedCompletionFixture = {
    context, harnessRoot, worktreePath, sourceSha, baseSha,
    coordinator: { caller: coordinatorCaller, session: bound.data },
  };
  await prepareExecutionPlan(domainContext(context, coordinatorCaller), {
    operationId: `prepare-${label}`,
    session: bound.data,
    expected: (await retainedPlanRead(fixture)).token,
    planId: RETAINED_PLAN,
    operation: {
      kind: "prepare",
      config: { worktreePath, workingBranch: `feature/${RETAINED_PLAN}`, qaGate: "mandatory" },
    },
  });
  for (const status of ["InProgress", "InReview"] as const) {
    await progressExecutionPlan(domainContext(context, coordinatorCaller), {
      operationId: `progress-${status}-${label}`,
      session: bound.data,
      expected: (await retainedPlanRead(fixture)).token,
      planId: RETAINED_PLAN,
      operation: { kind: "progress", progress: { status, summary: "reviewed", evidence_paths: [] } },
    });
  }
  return fixture;
}

/** Direct completion, with no plan identity or ownership-transfer ceremony. */
async function retainedComplete(
  fixture: RetainedCompletionFixture,
  bodies: { qc: string; consolidated: string; qa: string },
  operationId: string,
) {
  return completeExecutionPlan(domainContext(fixture.context, fixture.coordinator.caller), {
    operationId,
    session: fixture.coordinator.session,
    expected: (await retainedPlanRead(fixture)).token,
    planId: RETAINED_PLAN,
    operation: {
      kind: "complete",
      evidence: completionRequest(bodies, { sourceSha: fixture.sourceSha, baseSha: fixture.baseSha }),
    },
  });
}

describe("retained evidence at the completion consumer", () => {
  test("retained evidence: complete records current configured SDD bodies and replay keeps frozen provenance after edits", async () => {
    const fixture = await retainedCompletionFixture("retained-evidence-consumer-ok");
    try {
      const bodies = retainedCompletionBodies(fixture.harnessRoot);
      writeBody(bodies.qc, QC_BODY);
      writeBody(bodies.consolidated, `${CONSOLIDATED_BODY}edited before completion\n`);
      writeBody(bodies.qa, QA_BODY);
      const reviewedDigest = createHash("sha256").update(readFileSync(bodies.consolidated)).digest("hex");

      const completed = await retainedComplete(fixture, bodies, "complete-retained-ok");
      const completion = completed.data.coordination?.completion;
      if (completion === undefined) throw new Error("direct completion did not record its evidence");
      expect(completed.data.plan.status).toBe("Done");
      expect(completion).toMatchObject({
        source_branch: `feature/${RETAINED_PLAN}`,
        source_sha: fixture.sourceSha,
        worktree_path: fixture.worktreePath,
        review_base: fixture.baseSha,
        review_head: fixture.sourceSha,
        completed_by: fixture.coordinator.caller.sessionId,
        qc: {
          decision: "Approve",
          consolidated: { path: bodies.consolidated, sha256: reviewedDigest },
        },
        qa: { gate: "mandatory", decision: "pass", report: { path: bodies.qa } },
      });
      expect(completion.qc.reports.map((ref) => ref.path)).toEqual([bodies.qc]);
      expect(completion.integration).toBeUndefined();
      expect(completed.data.plan.metadata).toMatchObject({
        working_branch: `feature/${RETAINED_PLAN}`, worktree_path: fixture.worktreePath,
      });
      const committed = await retainedPlanRead(fixture);
      writeBody(bodies.consolidated, `${CONSOLIDATED_BODY}edited after completion\n`);
      const replay = await retainedComplete(fixture, bodies, "complete-retained-ok");
      expect(replay.data).toEqual(completed.data);
      expect(replay.data.coordination?.completion?.completed_at).toBe(completion.completed_at);
      expect(await retainedPlanRead(fixture)).toEqual(committed);
    } finally {
      rmSync(fixture.context.harnessDir, { recursive: true, force: true });
    }
  });

  test("retained evidence: missing and escaped bodies refuse without row changes; corrected evidence completes", async () => {
    const fixture = await retainedCompletionFixture("retained-evidence-consumer-refusals");
    try {
      const bodies = retainedCompletionBodies(fixture.harnessRoot);
      writeBody(bodies.qc, QC_BODY);
      writeBody(bodies.consolidated, CONSOLIDATED_BODY);
      writeBody(bodies.qa, QA_BODY);
      const before = await retainedPlanRead(fixture);
      const outside = join(fixture.context.harnessDir, "outside-body.md");
      writeBody(outside, "a body outside every plan area\n");
      const escaped = join(resolveSddDir(fixture.harnessRoot, RETAINED_PLAN), "escaped.md");
      symlinkSync(outside, escaped);
      expect(await refusalOf(() => retainedComplete(fixture, { ...bodies, qa: escaped }, "complete-retained-escaped")))
        .toEqual({ code: "coordination.path-mismatch" });
      expect(await retainedPlanRead(fixture)).toEqual(before);
      rmSync(escaped);
      rmSync(bodies.qa);
      expect(await refusalOf(() => retainedComplete(fixture, bodies, "complete-retained-missing")))
        .toEqual({ code: "coordination.invalid-input" });
      expect(await retainedPlanRead(fixture)).toEqual(before);
      writeBody(bodies.qa, QA_BODY);
      const completed = await retainedComplete(fixture, bodies, "complete-retained-missing");
      expect(completed.data.plan.status).toBe("Done");
      expect(completed.data.coordination?.completion?.qa.report.path).toBe(bodies.qa);
    } finally {
      rmSync(fixture.context.harnessDir, { recursive: true, force: true });
    }
  });

  test("retained evidence: an alias moved outside the plan area during the proof gap refuses and can be corrected", async () => {
    const fixture = await retainedCompletionFixture("retained-evidence-gap-alias");
    try {
      const bodies = retainedCompletionBodies(fixture.harnessRoot);
      writeBody(bodies.qc, QC_BODY);
      writeBody(bodies.consolidated, CONSOLIDATED_BODY);
      writeBody(bodies.qa, QA_BODY);
      const outside = join(fixture.context.harnessDir, "outside-gap-body.md");
      writeBody(outside, "outside the declared evidence areas\n");
      const alias = join(resolveSddDir(fixture.harnessRoot, RETAINED_PLAN), "qa-alias.md");
      symlinkSync(bodies.qa, alias);
      const before = await retainedPlanRead(fixture);
      setCompleteWitnessGapForTest(() => {
        rmSync(alias);
        symlinkSync(outside, alias);
      });
      expect(await refusalOf(() => retainedComplete(fixture, { ...bodies, qa: alias }, "complete-retained-gap")))
        .toEqual({ code: "coordination.path-mismatch" });
      expect(await retainedPlanRead(fixture)).toEqual(before);
      setCompleteWitnessGapForTest(undefined);
      rmSync(alias);
      symlinkSync(bodies.qa, alias);
      const completed = await retainedComplete(fixture, { ...bodies, qa: alias }, "complete-retained-gap");
      expect(completed.data.plan.status).toBe("Done");
      expect(completed.data.coordination?.completion?.qa.report.path).toBe(bodies.qa);
      expect(completed.data.coordination?.completion?.qa.report.sha256)
        .toBe(createHash("sha256").update(QA_BODY).digest("hex"));
    } finally {
      setCompleteWitnessGapForTest(undefined);
      rmSync(fixture.context.harnessDir, { recursive: true, force: true });
    }
  });
});
