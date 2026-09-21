/**
 * execution-consumers.test.ts — proof for the authoritative READ adapter and
 * the consumer read route (primary spec §5, plan task S2; the cross-domain
 * closure scenario is the separate `execution-cross-domain` group this file
 * carries for S6).
 *
 * Run with
 * `bun test packages/engine/src/execution-consumers.test.ts --test-name-pattern 'execution-authority-read'`.
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
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCatalogEntity } from "./catalog.js";
import { readExecutionAuthority } from "./execution-read.js";
import { commitExecutionRegistration } from "./execution-registration.js";
import {
  createExecutionWorkflow,
  initializeExecutionAuthority,
  parseExecutionToken,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionPlanView,
  type ExecutionState,
} from "./execution-store.js";
import * as engineIndex from "./index.js";
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

describe("execution-authority-read — one exact read of the committed authority", () => {
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

describe("execution-cross-domain — an unavailable authority refuses every read", () => {
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
