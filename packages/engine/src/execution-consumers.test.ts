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
 *   roots with the byte hashes the handoff record pins, across a fixture
 *   authority switch and with no copy in the store; a missing body, edited
 *   bytes and a symlink escape out of the plan's own areas each refuse — none
 *   of them can become an accepted approval.
 * - `retained evidence at the acceptance consumer …`: the same properties at
 *   the real DB `handoff` / `accept` verbs of a real Git control harness — the
 *   handoff RECORDS the configured bodies with their byte digests, and the
 *   acceptance transition refuses bodies that are missing, escaped or edited.
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
import { assertEvidenceInsidePlanArea, planAreaRoots, type HandoffEvidence } from "./coordination.js";
import { assertHandoffEvidenceUnchanged, readHandoffEvidence } from "./coordination-transitions.js";
import {
  acceptExecutionPlan,
  handoffExecutionPlan,
  prepareExecutionPlan,
  progressExecutionPlan,
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
  type ExecutionToken,
} from "./execution-store.js";
import * as engineIndex from "./index.js";
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
  return { sessionId: `host-${workflowId}`, role: "coordinator", workflowId, planId: null };
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
    } as unknown as WorkflowSnapshot,
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
      { kind: "plan", id: planId, title: `${planId} title`, rootKind: "plans", relativePath: `plans/${planId}.md` },
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

/** A store whose recorded migrations stop before `execution-authority`. */
async function preExecutionStore(label: string): Promise<StoreContext> {
  const context = controlRoot(label);
  const handle = await initializeStore(context);
  handle.close();
  const db = new DatabaseSync(join(context.harnessDir, "store.db"));
  try {
    db.exec("delete from schema_version where version = 4");
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
    // The published surface is this adapter, not a private copy of it.
    expect(engineIndex.readExecutionAuthority).toBe(readExecutionAuthority);
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
    expect(view.session).toBeNull();
    expect(view.executionLease).toBeNull();
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
          plan: { id: CROSS_PLAN, title: "Cross-domain accepted plan", file: `plans/${CROSS_PLAN}.md` },
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
            relativePath: `plans/${CROSS_PLAN}.md`,
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
    const snapshotPath = plantRetiredFileRoute(context);
    // The planted bytes, captured AFTER planting and BEFORE the reads under
    // test, so the comparison below measures the reads, not the fixture. These
    // are the exact file bytes: a marker substring would survive a partial
    // rewrite of the same JSON, which is the failure this scenario exists to
    // catch.
    const rootRegisterPath = join(context.harnessDir, "status.json");
    const plantedSnapshot = readFileSync(snapshotPath);
    const plantedRootRegister = readFileSync(rootRegisterPath);

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

    // …and the leftover bytes are exactly where they were: no read promoted
    // them and no refusal rewrote them. Byte-for-byte against the captured
    // pre-state — a rewrite that keeps the old marker fragment must fail here.
    expect(readFileSync(snapshotPath)).toEqual(plantedSnapshot);
    expect(readFileSync(rootRegisterPath)).toEqual(plantedRootRegister);
  });
});

/* ------------------------------------------------------------------------ *
 * Retained SDD evidence (S9)
 * ------------------------------------------------------------------------ */

const RETAINED_PLAN = "20260920-consumers-retained";
const QC_BODY = "reviewed QC body\n";
const CONSOLIDATED_BODY = "consolidated QC body\n";
const QA_BODY = "QA verdict body\n";

/** The three handoff evidence bodies of one plan, under the CONFIGURED SDD
 * resolution — the same resolution the containment boundary derives its roots
 * from. */
function retainedBodies(harnessDir: string): { qc: string; consolidated: string; qa: string } {
  const sddDir = resolveSddDir(harnessDir, RETAINED_PLAN);
  mkdirSync(sddDir, { recursive: true });
  return { qc: join(sddDir, "qc1.md"), consolidated: join(sddDir, "qc.md"), qa: join(sddDir, "qa.md") };
}

/** Write one evidence body and return its BYTE digest — what a handoff record
 * pins. */
function writeBody(path: string, text: string): string {
  writeFileSync(path, text, "utf8");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The plan session's handoff evidence request: paths and decisions only.
 * `revisions` default to placeholder SHAs the helper-level cases do not use;
 * the handoff consumer's fixture passes the Git revisions it pinned. */
function handoffRequest(
  bodies: { qc: string; consolidated: string; qa: string },
  revisions: { sourceSha: string; baseSha: string } = { sourceSha: "a".repeat(40), baseSha: "b".repeat(40) },
): HandoffEvidence {
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
 * Evidence stays at the configured SDD roots as FILES with byte hashes, across
 * an authority switch: the bodies a plan wrote before its store was activated
 * are still the bytes its handoff record pins afterwards, and the acceptance
 * gates (containment, existence, digest) are the ones that decide whether that
 * evidence can be an accepted approval.
 */
describe("retained evidence \u2014 SDD bodies and byte hashes across the authority switch", () => {
  test("retained evidence bodies stay files whose byte hashes survive fixture activation", async () => {
    // A store that holds an issue/catalog authority and no execution authority
    // yet: the bodies are written and hashed BEFORE the switch.
    const context = await legacyStore("retained-evidence-switch");
    const bodies = retainedBodies(context.harnessDir);
    const digests = {
      qc: writeBody(bodies.qc, QC_BODY),
      consolidated: writeBody(bodies.consolidated, CONSOLIDATED_BODY),
      qa: writeBody(bodies.qa, QA_BODY),
    };

    // The switch: the fixture's execution authority becomes ACTIVE.
    await initializeExecutionAuthority(context);
    expect(await resolveExecutionReadRoute(context)).toBe("execution");

    // The handoff route's own boundary: containment and existence against the
    // plan's own areas, derived from the configured resolution.
    const input = readHandoffEvidence(handoffRequest(bodies));
    expect(() => assertEvidenceInsidePlanArea(planAreaRoots(context.harnessDir, RETAINED_PLAN), input.evidence_paths)).not.toThrow();

    // The record pins BYTE hashes, and they still describe the files.
    expect([input.qc_reports[0]!.sha256, input.qc_consolidated.sha256, input.qa_report.sha256]).toEqual([
      digests.qc,
      digests.consolidated,
      digests.qa,
    ]);
    expect(readFileSync(bodies.qc, "utf8")).toEqual(QC_BODY);
    expect(() => assertHandoffEvidenceUnchanged(input, "handoff")).not.toThrow();

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
    const input = readHandoffEvidence(handoffRequest(bodies));
    const roots = planAreaRoots(context.harnessDir, RETAINED_PLAN);

    rmSync(bodies.qc);

    // Gone is unavailable: the containment boundary refuses the absent body,
    // and the sealed digest pin cannot be satisfied by it either.
    expect(refusalCodeOf(() => assertEvidenceInsidePlanArea(roots, [bodies.qc]))).toBe("coordination.evidence-stale");
    expect(refusalCodeOf(() => assertHandoffEvidenceUnchanged(input, "handoff"))).toBe("coordination.evidence-stale");
    // The request itself refuses a path with nothing behind it, so a missing
    // report never reaches an accepted approval.
    expect(refusalCodeOf(() => readHandoffEvidence(handoffRequest(bodies)))).toBe("coordination.invalid-input");
  });

  test("retained evidence: changed bytes and a symlink escape cannot count as accepted approval", async () => {
    const context = await activeGraph("retained-evidence-mutation");
    const bodies = retainedBodies(context.harnessDir);
    const qcDigest = writeBody(bodies.qc, QC_BODY);
    writeBody(bodies.consolidated, CONSOLIDATED_BODY);
    writeBody(bodies.qa, QA_BODY);
    const input = readHandoffEvidence(handoffRequest(bodies));
    const roots = planAreaRoots(context.harnessDir, RETAINED_PLAN);
    expect(input.qc_reports[0]!.sha256).toEqual(qcDigest);

    // An edited report is a different body: the pinned byte digest refuses it.
    writeBody(bodies.qc, `${QC_BODY}edited\n`);
    expect(refusalCodeOf(() => assertHandoffEvidenceUnchanged(input, "handoff"))).toBe("coordination.evidence-stale");

    // A symlink that resolves outside the plan's own areas is refused by the
    // containment boundary. The escape is real — the bytes read through the
    // link are the outside file's — so containment, not the caller's path
    // spelling, is what stops it.
    const outside = join(context.harnessDir, "outside-body.md");
    const outsideText = "a body outside every plan area\n";
    writeBody(outside, outsideText);
    const escaped = join(resolveSddDir(context.harnessDir, RETAINED_PLAN), "escaped.md");
    symlinkSync(outside, escaped);
    expect(readFileSync(escaped, "utf8")).toEqual(outsideText);
    expect(refusalCodeOf(() => assertEvidenceInsidePlanArea(roots, [escaped]))).toBe("coordination.path-mismatch");
  });
});

/* ------------------------------------------------------------------------ *
 * Retained SDD evidence at the acceptance consumer (S9)
 * ------------------------------------------------------------------------ */

const RETAINED_WORKFLOW = "wf-consumers-retained";

type RetainedSeat = { caller: ExecutionCaller; session: ExecutionSessionRef };

type RetainedHandoffFixture = {
  context: StoreContext;
  harnessRoot: string;
  worktreePath: string;
  sourceSha: string;
  baseSha: string;
  coordinator: RetainedSeat;
  plan: RetainedSeat;
};

/** One git command in a fixture repository; returns its trimmed stdout. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** The reviewed Assignment a DB `prepare` seals: the C1 header block (every
 * header the parser requires) pinned to THIS store's harness, workflow and
 * plan, with the plan's own worktree as the reviewed checkout. */
function writeRetainedAssignment(harnessRoot: string, worktreePath: string): string {
  const planPath = join(harnessRoot, "plans", `${RETAINED_PLAN}.md`);
  const sddDir = join(harnessRoot, "sdd", RETAINED_PLAN);
  mkdirSync(dirname(planPath), { recursive: true });
  mkdirSync(sddDir, { recursive: true });
  writeFileSync(planPath, `# ${RETAINED_PLAN}\n`, "utf8");
  const headers: Record<string, string> = {
    "Execution scope": "plan",
    "Execute as": "project-manager",
    Delegation: "allowed",
    "Control harness root": harnessRoot,
    "Workflow id": RETAINED_WORKFLOW,
    "Plan id": RETAINED_PLAN,
    "Plan Path": planPath,
    "Worktree path": worktreePath,
    "Working branch": `feature/${RETAINED_PLAN}`,
    "SDD dir": sddDir,
    "QA gate": "mandatory",
    "Findings cleanup": "allow-residual",
    "Prepare gate": "go",
  };
  const assignmentPath = join(harnessRoot, "assignments", `${RETAINED_PLAN}.md`);
  mkdirSync(dirname(assignmentPath), { recursive: true });
  writeFileSync(
    assignmentPath,
    `${Object.entries(headers)
      .map(([header, value]) => `**${header}**: ${value}`)
      .join("\n")}\n`,
    "utf8",
  );
  return assignmentPath;
}

/** The three handoff evidence bodies of the retained plan, under the CONFIGURED
 * SDD resolution of the fixture's control harness. */
function retainedHandoffBodies(harnessRoot: string): { qc: string; consolidated: string; qa: string } {
  const sddDir = resolveSddDir(harnessRoot, RETAINED_PLAN);
  mkdirSync(join(sddDir, "review"), { recursive: true });
  return {
    qc: join(sddDir, "review", "qc1.md"),
    consolidated: join(sddDir, "review", "qc.md"),
    qa: join(sddDir, "qa.md"),
  };
}

/** The plan token one seat reads right now (the CAS every call pins). */
async function retainedPlanToken(context: StoreContext, seat: RetainedSeat): Promise<ExecutionToken> {
  const read = await readExecutionPlan(domainContext(context, seat.caller), seat.session, RETAINED_PLAN);
  return read.token;
}

/**
 * A real Git control harness in its own temporary control root: the retained
 * plan is registered, prepared from its reviewed Assignment, bound to its plan
 * session (which claims the execution lease) and reported InReview — the state
 * the DB handoff acceptance transition starts from. Nothing here is a stub: the
 * authority is ACTIVE, the checkout is a real worktree and the evidence lives
 * under the configured SDD dir.
 */
async function retainedHandoffFixture(label: string): Promise<RetainedHandoffFixture> {
  const repoRoot = realpathSync(mkdtempSync(join(ROOT, `${label}-`)));
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["-c", "user.email=mstar@example.com", "-c", "user.name=mstar", "commit", "-q", "--allow-empty", "-m", "init"]);
  const harnessRoot = join(repoRoot, ".mstar");
  mkdirSync(harnessRoot, { recursive: true });
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
      relativePath: `plans/${RETAINED_PLAN}.md`,
    },
    { operationId: `register-${label}`, actor: "execution-consumers.test" },
  );

  // The plan's own checkout: the source_sha a handoff pins is this HEAD.
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
    planId: null,
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
    } as unknown as WorkflowSnapshot,
    expected: initialized.token,
    operationId: `create-${label}`,
  });
  const workflow = created.data.workflows[0]!;
  const bound = await bindExecutionSession(domainContext(context, coordinatorCaller), {
    workflowId: RETAINED_WORKFLOW,
    planId: null,
    role: "coordinator",
    expected: workflow.workflowToken,
    operationId: `bind-coordinator-${label}`,
  });
  // The plan's own token, read at the state the prepare runs against (the bind
  // above moved the workflow revision, not the plan's).
  const planTokenAtPrepare = (await readExecutionState(context)).data.workflows[0]!.planTokens[RETAINED_PLAN]!;
  const coordinator: RetainedSeat = { caller: coordinatorCaller, session: bound.data };
  await prepareExecutionPlan(domainContext(context, coordinatorCaller), {
    operationId: `prepare-${label}`,
    session: coordinator.session,
    expected: planTokenAtPrepare,
    planId: RETAINED_PLAN,
    operation: { kind: "prepare", assignmentPath: writeRetainedAssignment(harnessRoot, worktreePath) },
  });

  // The plan session's bind claims the execution lease of the plan's own scope.
  const planCaller: ExecutionCaller = {
    sessionId: "host-retained-plan",
    role: "plan-pm",
    workflowId: RETAINED_WORKFLOW,
    planId: RETAINED_PLAN,
  };
  const planSession = await bindExecutionSession(domainContext(context, planCaller), {
    workflowId: RETAINED_WORKFLOW,
    planId: RETAINED_PLAN,
    role: "plan-pm",
    expected: await retainedPlanToken(context, coordinator),
    operationId: `bind-plan-${label}`,
  });
  const plan: RetainedSeat = { caller: planCaller, session: planSession.data };
  await progressExecutionPlan(domainContext(context, planCaller), {
    operationId: `progress-${label}`,
    session: plan.session,
    expected: await retainedPlanToken(context, plan),
    planId: RETAINED_PLAN,
    operation: { kind: "progress", progress: { status: "InReview", summary: "reviewed", evidence_paths: [] } },
  });
  return { context, harnessRoot, worktreePath, sourceSha, baseSha, coordinator, plan };
}

/** One plan-session `handoff` of the retained fixture's plan. */
async function retainedHandoff(
  fixture: RetainedHandoffFixture,
  bodies: { qc: string; consolidated: string; qa: string },
  operationId: string,
) {
  return handoffExecutionPlan(domainContext(fixture.context, fixture.plan.caller), {
    operationId,
    session: fixture.plan.session,
    expected: await retainedPlanToken(fixture.context, fixture.plan),
    planId: RETAINED_PLAN,
    operation: {
      kind: "handoff",
      evidence: handoffRequest(bodies, { sourceSha: fixture.sourceSha, baseSha: fixture.baseSha }),
    },
  });
}

/** One coordinator `accept` of the named handoff attempt. */
async function retainedAccept(fixture: RetainedHandoffFixture, handoffId: string, operationId: string) {
  return acceptExecutionPlan(domainContext(fixture.context, fixture.coordinator.caller), {
    operationId,
    session: fixture.coordinator.session,
    expected: await retainedPlanToken(fixture.context, fixture.coordinator),
    planId: RETAINED_PLAN,
    operation: { kind: "accept", handoffId },
  });
}

/**
 * The acceptance transition, not the helpers: these cases drive the real DB
 * `handoff` / `accept` verbs of a real fixture and assert what they RECORD and
 * what they REFUSE.
 */
describe("retained evidence at the acceptance consumer", () => {
  test("retained evidence: the handoff records the configured SDD bodies with their byte digests", async () => {
    const fixture = await retainedHandoffFixture("retained-evidence-consumer-ok");
    try {
      const bodies = retainedHandoffBodies(fixture.harnessRoot);
      const digests = {
        qc: writeBody(bodies.qc, QC_BODY),
        consolidated: writeBody(bodies.consolidated, CONSOLIDATED_BODY),
        qa: writeBody(bodies.qa, QA_BODY),
      };

      const handed = await retainedHandoff(fixture, bodies, "handoff-retained-ok");
      const handoff = handed.data.coordination!.handoff!;
      // The consumer recorded the FILES at the configured SDD paths with the
      // byte hashes it read from them — not a copy, not a digest of anything
      // else.
      expect(handoff.qc.reports.map((ref) => ref.path)).toEqual([bodies.qc]);
      expect([handoff.qc.reports[0]!.sha256, handoff.qc.consolidated.sha256, handoff.qa.report.sha256]).toEqual([
        digests.qc,
        digests.consolidated,
        digests.qa,
      ]);
      expect(handoff.state).toBe("submitted");

      // The acceptance transition verifies exactly those digests, and the
      // bodies are still the files it verified.
      const accepted = await retainedAccept(fixture, handoff.id, "accept-retained-ok");
      expect(accepted.data.coordination!.handoff!.state).toBe("accepted");
      expect(readFileSync(bodies.qc, "utf8")).toEqual(QC_BODY);
      expect(createHash("sha256").update(readFileSync(bodies.consolidated)).digest("hex")).toEqual(digests.consolidated);
    } finally {
      rmSync(fixture.context.harnessDir, { recursive: true, force: true });
    }
  });

  test("retained evidence: missing, escaped and edited bodies cannot be accepted by the consumer", async () => {
    const fixture = await retainedHandoffFixture("retained-evidence-consumer-refusals");
    try {
      const bodies = retainedHandoffBodies(fixture.harnessRoot);
      writeBody(bodies.qc, QC_BODY);
      writeBody(bodies.consolidated, CONSOLIDATED_BODY);
      writeBody(bodies.qa, QA_BODY);

      // (1) A body symlinked OUT of the plan's own areas is refused by the
      // consumer's containment boundary, even though the link resolves to real
      // bytes the digest step would happily read.
      const outside = join(fixture.context.harnessDir, "outside-body.md");
      writeBody(outside, "a body outside every plan area\n");
      const escaped = join(resolveSddDir(fixture.harnessRoot, RETAINED_PLAN), "escaped.md");
      symlinkSync(outside, escaped);
      const escapedRefusal = await refusalOf(() =>
        retainedHandoff(fixture, { ...bodies, qa: escaped }, "handoff-retained-escaped"),
      );
      expect(escapedRefusal.code).toBe("coordination.path-mismatch");
      rmSync(escaped);

      // (2) A missing body never reaches the acceptance work: the request gate
      // refuses the path with nothing behind it.
      rmSync(bodies.qa);
      const missingRefusal = await refusalOf(() => retainedHandoff(fixture, bodies, "handoff-retained-missing"));
      expect(missingRefusal.code).toBe("coordination.invalid-input");
      writeBody(bodies.qa, QA_BODY);

      // (3) The unchanged bodies hand off, and the attempt is recorded.
      const handed = await retainedHandoff(fixture, bodies, "handoff-retained-sealed");
      const handoffId = handed.data.coordination!.handoff!.id;

      // (4) Bytes edited AFTER the seal cannot be accepted: `accept` re-reads
      // the pinned paths and refuses — the attempt stays `submitted`.
      writeBody(bodies.consolidated, `${CONSOLIDATED_BODY}edited\n`);
      const editedRefusal = await refusalOf(() => retainedAccept(fixture, handoffId, "accept-retained-edited"));
      expect(editedRefusal.code).toBe("coordination.evidence-stale");
      const afterEdit = await readExecutionPlan(
        domainContext(fixture.context, fixture.coordinator.caller),
        fixture.coordinator.session,
        RETAINED_PLAN,
      );
      expect(afterEdit.data.coordination!.handoff!.state).toBe("submitted");

      // (5) A body that vanished after the seal is unavailable too — the same
      // refusal, never a phantom approval.
      writeBody(bodies.consolidated, CONSOLIDATED_BODY);
      rmSync(bodies.qc);
      const removedRefusal = await refusalOf(() => retainedAccept(fixture, handoffId, "accept-retained-removed"));
      expect(removedRefusal.code).toBe("coordination.evidence-stale");

      // (6) Restoring the bodies lets the SAME attempt through: the refusals
      // above are the acceptance path's verdict on the evidence, not a stuck
      // record.
      writeBody(bodies.qc, QC_BODY);
      const accepted = await retainedAccept(fixture, handoffId, "accept-retained-restored");
      expect(accepted.data.coordination!.handoff!.state).toBe("accepted");
    } finally {
      rmSync(fixture.context.harnessDir, { recursive: true, force: true });
    }
  });
});
