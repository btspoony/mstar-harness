/**
 * catalog-registration.test.ts — proof for the execution registration
 * journal. Run with
 * `bun test packages/engine/src/catalog-registration.test.ts`.
 *
 * The suite runs against the real journal, the real execution producers, the
 * real catalog domain verbs, the real migration runner and the real
 * `node:sqlite` driver in per-test temporary workspaces. No mock database and
 * no mock producer exists anywhere in this proof: the injected failures are
 * the REAL artifact-store write boundaries (the same technique the producer
 * suites use) and REAL catalog domain refusals, plus one crash state
 * reconstructed exactly as a crash leaves it (the journal row rewritten to the
 * phase it would have stopped at — the same "pause the operation" technique
 * the producer suites use when they erase the root entry to simulate a lost
 * write).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { closeFileWorkflow } from "./coordination.js";
import { getCatalog, listCatalog, registerCatalogEntity } from "./catalog.js";
import {
  CatalogRegistrationError,
  abortCatalogExecution,
  assertCatalogExecutionCommitted,
  listPendingCatalogRegistrations,
  readCatalogRevisions,
  reconcileCatalogExecution,
  registerCatalogExecution,
  registerShippedCatalogExecution,
  resolveCatalogRegistrationState,
  type CatalogExecutionRequest,

} from "./catalog-registration.js";
import { createFsStore, setArtifactStore, type ArtifactStore } from "./store.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import { validateStatus } from "./status.js";
import { PREPARE_PHASE, WORKFLOW_SNAPSHOT_FILE, deriveLifecyclePhase, readWorkflowSnapshot, validateWorkflowSnapshot } from "./workflow.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-catalog-registration-test-"));

afterEach(() => {
  // The injected stores are per-test; the producers must never keep writing
  // through a previous test's fixture.
  setArtifactStore(undefined);
  process.chdir(ROOT);
});

/**
 * A fresh temp workspace with the real harness marker. `resolveHarnessDir`
 * probes `{dir}/.mstar` BEFORE `{dir}/plans`, so the store + catalog roots
 * stay pinned to the marker even once a `plans/` dir appears in the tree —
 * exactly like a real workspace (.mstar is the harness root).
 */
async function fixture(name: string): Promise<{ workspace: string; harnessDir: string; context: StoreContext }> {
  const workspace = mkdtempSync(join(ROOT, name));
  mkdirSync(join(workspace, ".mstar"), { recursive: true });
  const harnessDir = workspace;
  process.chdir(workspace);
  const context: StoreContext = { harnessDir };
  const handle = await initializeStore(context);
  handle.close();
  setArtifactStore(createFsStore(harnessDir));
  return { workspace, harnessDir, context };
}

/** An artifact store identical to the fixture's, with `put` injected to fail. */
function failingStore(harnessDir: string, kind: "snapshot" | "status", times = 1): ArtifactStore {
  const base = createFsStore(harnessDir);
  let remaining = times;
  return {
    ...base,
    put: async (doc) => {
      if (remaining > 0 && doc.kind === kind) {
        remaining -= 1;
        throw new Error(`injected ${kind} write failure`);
      }
      return base.put(doc);
    },
  };
}

const PLAN_ID = "20260918-registration-fixture";
const PLAN_TITLE = "State projection plan";

/**
 * The registered plan document a fixture registers. Registration proves the
 * selected document (§4/R1) — the pointer, the location and the document's own
 * `plan_id` must agree — so a fixture that registers a plan writes the document
 * it registers, with the heading that is the title authority.
 */
function writePlanDocument(harnessDir: string, planId: string, title: string): void {
  const file = join(harnessDir, "plans", `${planId}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# ${title}\n\n**plan_id:** ${planId}\n`);
}

function planRequest(options: {
  harnessDir: string;
  operationId: string;
  expectedCatalogRevision: number;
  workflowId?: string;
  planId?: string;
  title?: string;
  /** The §4 pointer spelling (harness-relative by default). */
  file?: string;
  /** A different registration identity that leaves the plan metadata intact. */
  project?: string;
}): CatalogExecutionRequest {
  const workflowId = options.workflowId ?? "wf-plan-1";
  const planId = options.planId ?? PLAN_ID;
  const title = options.title ?? PLAN_TITLE;
  const file = options.file ?? `plans/${planId}.md`;
  // The registry of this fixture: the document the reviewed request registers
  // exists, so the registration can prove it (R1). The catalog entity states the
  // same document plans-root-relative, which is the catalog's location form.
  writePlanDocument(options.harnessDir, planId, title);
  return {
    operationId: options.operationId,
    actor: "project-manager",
    expectedCatalogRevision: options.expectedCatalogRevision,
    workflow: {
      kind: "plan",
      workflowId,
      options: {
        harnessDir: options.harnessDir,
        plan: { id: planId, title, file },
        deliveryKind: "development",
        branchSource: "feature/20260918-state-projection",
        branchTarget: "main",
        project: options.project ?? "harness",
        startedAt: "2026-09-18T00:00:00.000Z",
      },
    },
    delta: {
      entities: [{ kind: "plan", id: planId, title, rootKind: "plans", relativePath: basename(file) }],
      binding: { catalogKind: "plan", catalogId: planId },
    },
  };
}

async function catalogPlan(context: StoreContext, id: string) {
  const detail = await getCatalog(context, { kind: "plan", id });
  return detail.entity;
}

describe("catalog execution registration \u2014 the ordered join", () => {
  test("registers the execution and its catalog delta, publishing the catalog only after the execution registration holds", async () => {
    const { harnessDir, context } = await fixture("ordered-");
    const before = await readCatalogRevisions(context);
    expect(before.catalogRevision).toBe(0);

    const receipt = await registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-1", expectedCatalogRevision: 0 }));
    expect(receipt).toEqual({ operationId: "op-1", workflowId: "wf-plan-1", catalogRevision: 1, recovered: false });

    // (a) the execution half: snapshot + root entry, both validating
    const snapshotPath = join(harnessDir, "workflows", "wf-plan-1", WORKFLOW_SNAPSHOT_FILE);
    expect(existsSync(snapshotPath)).toBe(true);
    expect(validateWorkflowSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8"))).ok).toBe(true);
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);

    // (b) the catalog half: the reviewed entity, at the reviewed location
    const entity = await catalogPlan(context, PLAN_ID);
    expect(entity.title).toBe("State projection plan");
    expect(entity.rootKind).toBe("plans");
    expect(entity.relativePath).toBe(`${PLAN_ID}.md`);
    expect((await readCatalogRevisions(context)).catalogRevision).toBe(1);

    // (c) the historical workflow association the binding records
    const state = await resolveCatalogRegistrationState(context, "wf-plan-1");
    expect(state).toEqual({
      workflowId: "wf-plan-1",
      rootVisible: true,
      pending: null,
      binding: { catalogKind: "plan", catalogId: PLAN_ID, catalogRevision: 1 },
    });

    // (d) nothing is left pending, and the dispatch gate passes
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    await assertCatalogExecutionCommitted(context, "wf-plan-1");
  });

  test("refuses a stale catalog expectation before writing anything at all", async () => {
    const { harnessDir, context } = await fixture("stale-");

    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-stale", expectedCatalogRevision: 99 })),
    ).rejects.toMatchObject({ code: "catalog.revision-conflict" });

    expect(existsSync(join(harnessDir, "workflows"))).toBe(false);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
    expect((await listCatalog(context, {})).total).toBe(0);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });

  test("refuses a malformed delta and an escaping input path before any write", async () => {
    const { harnessDir, context } = await fixture("invalid-");
    const escaping = planRequest({ harnessDir, operationId: "op-escape", expectedCatalogRevision: 0 });
    (escaping.delta.entities[0] as { relativePath: string }).relativePath = "../escape.md";
    await expect(registerCatalogExecution(context, escaping)).rejects.toMatchObject({
      code: "catalog.registration-invalid",
    });

    const unbound = planRequest({ harnessDir, operationId: "op-unbound", expectedCatalogRevision: 0 });
    unbound.delta.binding = { catalogKind: "plan", catalogId: "some-other-plan" };
    await expect(registerCatalogExecution(context, unbound)).rejects.toMatchObject({
      code: "catalog.registration-invalid",
    });

    expect(existsSync(join(harnessDir, "workflows"))).toBe(false);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
    expect((await listCatalog(context, {})).total).toBe(0);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });

  test("refuses when no store exists \u2014 a missing database is never an empty catalog", async () => {
    const workspace = mkdtempSync(join(ROOT, "no-store-"));
    mkdirSync(join(workspace, ".mstar"), { recursive: true });
    const context: StoreContext = { harnessDir: workspace };

    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir: workspace, operationId: "op-no-store", expectedCatalogRevision: 0 })),
    ).rejects.toMatchObject({ code: "store.not-initialized" });
    expect(existsSync(join(workspace, "workflows"))).toBe(false);
    expect(existsSync(join(workspace, "status.json"))).toBe(false);
  });
});

describe("catalog execution registration \u2014 failure boundaries", () => {
  test("interrupted registration \u2014 a snapshot-write failure leaves a resumable pending state; reconcile finishes exactly its own writes", async () => {
    const { harnessDir, context } = await fixture("snapshot-failure-");
    setArtifactStore(failingStore(harnessDir, "snapshot"));

    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-snap", expectedCatalogRevision: 0 })),
    ).rejects.toThrow(/injected snapshot write failure/);

    // No half-registration is reported, and no half is published: the catalog
    // is still empty while the execution registration did not happen.
    expect(existsSync(join(harnessDir, "workflows", "wf-plan-1", WORKFLOW_SNAPSHOT_FILE))).toBe(false);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
    expect((await listCatalog(context, {})).total).toBe(0);
    expect((await readCatalogRevisions(context)).catalogRevision).toBe(0);
    const pending = await listPendingCatalogRegistrations(context);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operationId: "op-snap", workflowId: "wf-plan-1", kind: "plan", phase: "prepared", rootVisible: false });

    // A pending workflow is owned by its original operation id; a new id must not adopt it.
    setArtifactStore(createFsStore(harnessDir));
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-snap-2", expectedCatalogRevision: 0 })),
    ).rejects.toMatchObject({ code: "catalog.registration-pending" });
    expect((await listPendingCatalogRegistrations(context)).map(({ operationId }) => operationId)).toEqual(["op-snap"]);
    const resumed = await reconcileCatalogExecution(context, "op-snap");
    expect(resumed).toEqual({ operationId: "op-snap", workflowId: "wf-plan-1", catalogRevision: 1, recovered: true });
    expect(existsSync(join(harnessDir, "workflows", "wf-plan-1", WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
    expect((await catalogPlan(context, PLAN_ID)).title).toBe("State projection plan");
    expect((await readCatalogRevisions(context)).catalogRevision).toBe(1);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    await assertCatalogExecutionCommitted(context, "wf-plan-1");

    // Idempotent replay: the same receipt, no new writes, no new revision.
    expect(await reconcileCatalogExecution(context, "op-snap")).toEqual(resumed);
    expect((await listCatalog(context, {})).total).toBe(1);
    expect((await readCatalogRevisions(context)).catalogRevision).toBe(1);

  });

  test("interrupted registration \u2014 a root-register failure rolls the snapshot back, stays pending, and never publishes catalog metadata", async () => {
    const { harnessDir, context } = await fixture("root-failure-");
    setArtifactStore(failingStore(harnessDir, "status"));

    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-root", expectedCatalogRevision: 0 })),
    ).rejects.toThrow(/injected status write failure/);

    // The producer's rollback removed the snapshot it created: no root entry,
    // no snapshot, no catalog row — and the pending row records the operation.
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
    expect(existsSync(join(harnessDir, "workflows", "wf-plan-1", WORKFLOW_SNAPSHOT_FILE))).toBe(false);
    expect((await listCatalog(context, {})).total).toBe(0);
    const pending = await listPendingCatalogRegistrations(context);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operationId: "op-root", phase: "prepared", rootVisible: false });

    setArtifactStore(createFsStore(harnessDir));
    const receipt = await reconcileCatalogExecution(context, "op-root");
    expect(receipt.recovered).toBe(true);
    expect(receipt.catalogRevision).toBe(1);
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
    expect((await catalogPlan(context, PLAN_ID)).rootKind).toBe("plans");
  });

  test("interrupted registration \u2014 a catalog-write refusal is a clean refusal: root-visible pending refuses dispatch, and reconcile never deletes data", async () => {
    const { harnessDir, context } = await fixture("catalog-failure-");
    // Another writer registered this plan id at a different location after the
    // reviewed delta was prepared: the publish refuses, exactly as a real
    // concurrent writer would make it.
    await registerCatalogEntity(
      context,
      { kind: "plan", id: PLAN_ID, title: "Conflicting registration", rootKind: "plans", relativePath: "elsewhere.md" },
      { operationId: "seed-1", actor: "project-manager" },
    );
    const seeded = await readCatalogRevisions(context);

    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-catalog", expectedCatalogRevision: seeded.catalogRevision })),
    ).rejects.toMatchObject({ code: "catalog.duplicate" });

    // The execution half IS on disk (the registration happened) but the
    // catalog half is not published, and nothing reports success.
    const snapshotPath = join(harnessDir, "workflows", "wf-plan-1", WORKFLOW_SNAPSHOT_FILE);
    expect(existsSync(snapshotPath)).toBe(true);
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
    const pending = await listPendingCatalogRegistrations(context);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operationId: "op-catalog", phase: "execution-written", rootVisible: true });

    // The acceptance criterion verbatim: a root-visible pending operation
    // refuses dispatch instead of letting a half-registered workflow proceed.
    await expect(assertCatalogExecutionCommitted(context, "wf-plan-1")).rejects.toMatchObject({
      code: "catalog.registration-pending",
    });

    // Reconcile re-drives the publish, which is still refused; the conflict is
    // visible, and neither the execution bytes nor the other writer's row move.
    await expect(reconcileCatalogExecution(context, "op-catalog")).rejects.toMatchObject({
      code: "catalog.reconcile-conflict",
    });
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    expect(snapshot.id).toBe("wf-plan-1");
    expect(snapshot.plans).toMatchObject([{ id: PLAN_ID, file: realpathSync(join(harnessDir, "plans", `${PLAN_ID}.md`)) }]);
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
    expect((await catalogPlan(context, PLAN_ID)).title).toBe("Conflicting registration");
    expect((await catalogPlan(context, PLAN_ID)).relativePath).toBe("elsewhere.md");
    expect((await listCatalog(context, {})).total).toBe(1);
    expect(await listPendingCatalogRegistrations(context)).toHaveLength(1);
    await expect(assertCatalogExecutionCommitted(context, "wf-plan-1")).rejects.toMatchObject({
      code: "catalog.registration-pending",
    });
  });

  test("interrupted registration \u2014 a changed orphan refuses at reconcile and is never deleted or adopted", async () => {
    const { harnessDir, context } = await fixture("orphan-");
    setArtifactStore(failingStore(harnessDir, "snapshot"));
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-orphan", expectedCatalogRevision: 0 })),
    ).rejects.toThrow(/injected snapshot write failure/);
    setArtifactStore(createFsStore(harnessDir));

    // A foreign snapshot now occupies the path this operation owns (a crash
    // followed by another writer, or a hand-placed snapshot).
    const dir = join(harnessDir, "workflows", "wf-plan-1");
    const foreign = JSON.stringify(
      {
        schema_version: 1,
        id: "wf-plan-1",
        type: "plan",
        status: "running",
        started_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01",
        plans: [{ id: "foreign-plan", title: "Foreign plan", file: "foreign.md", status: "Todo" }],
        delivery_kind: "verification/report-only",
        completion_policy: "foreign",
      },
      null,
      2,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, WORKFLOW_SNAPSHOT_FILE), foreign);

    await expect(reconcileCatalogExecution(context, "op-orphan")).rejects.toMatchObject({
      code: "catalog.reconcile-conflict",
    });

    const recoveredForeign = JSON.parse(readFileSync(join(dir, WORKFLOW_SNAPSHOT_FILE), "utf8"));
    expect(recoveredForeign.id).toBe("wf-plan-1");
    expect(recoveredForeign.plans).toEqual([{ id: "foreign-plan", title: "Foreign plan", file: "foreign.md", status: "Todo" }]);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
    expect((await listCatalog(context, {})).total).toBe(0);
    expect(await listPendingCatalogRegistrations(context)).toHaveLength(1);
  });

  test("replays a committed operation idempotently and refuses a reused operation id with a different request", async () => {
    const { harnessDir, context } = await fixture("replay-");
    const request = planRequest({ harnessDir, operationId: "op-replay", expectedCatalogRevision: 0 });
    const receipt = await registerCatalogExecution(context, request);

    // Same operation id, same request → the recorded receipt, no new writes.
    expect(await registerCatalogExecution(context, request)).toEqual(receipt);
    expect((await readCatalogRevisions(context)).catalogRevision).toBe(1);

    // Same operation id, different request → conflict, nothing changed. The
    // difference is a different registration identity (another project) with
    // the SAME selected document, so it stays a genuine request conflict.
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-replay", expectedCatalogRevision: 0, project: "another-project" })),
    ).rejects.toMatchObject({ code: "store.operation-conflict" });
    // A fresh operation id meeting the committed registration of this workflow
    // id is NOT a retry — the committed replay is keyed by operation id, and
    // uniqueness per workflow id is what the create-only refusal expresses.
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-replay-2", expectedCatalogRevision: 1 })),
    ).rejects.toMatchObject({ code: "catalog.registration-conflict" });
    expect((await catalogPlan(context, PLAN_ID)).title).toBe("State projection plan");
    expect((await listCatalog(context, {})).total).toBe(1);
    // A DIFFERENT registration of the same workflow id is not a retry either:
    // the same create-only refusal stands and nothing is replaced.
    await expect(
      registerCatalogExecution(
        context,
        planRequest({ harnessDir, operationId: "op-replay-3", expectedCatalogRevision: 1, project: "another-project" }),
      ),
    ).rejects.toMatchObject({ code: "catalog.registration-conflict" });
    expect((await catalogPlan(context, PLAN_ID)).title).toBe("State projection plan");
    expect((await listCatalog(context, {})).total).toBe(1);
  });

  test("a post-registration plan progress does not invalidate the replay (the row status is not registration identity)", async () => {
    const { harnessDir, context } = await fixture("progress-replay-");
    const request = planRequest({ harnessDir, operationId: "op-progress", expectedCatalogRevision: 0 });
    const receipt = await registerCatalogExecution(context, request);

    // Simulates the PERSISTED EFFECT of a normal plan progress (Todo ->
    // InReview) without exercising the progress mutation itself — the point
    // under regression is that the replay is keyed by operation id and request
    // hash, so a retry of the same committed registration after the row evolved
    // replays its receipt, not a false registration-conflict over a state the
    // progress route wrote.
    const snapshotDoc = JSON.parse(readFileSync(join(harnessDir, "workflows", "wf-plan-1", "snapshot.json"), "utf8")) as {
      plans: Array<{ status: string }>;
    };
    snapshotDoc.plans[0]!.status = "InReview";
    writeFileSync(join(harnessDir, "workflows", "wf-plan-1", "snapshot.json"), `${JSON.stringify(snapshotDoc, null, 2)}\n`);

    expect(await registerCatalogExecution(context, request)).toEqual(receipt);
    expect((await listCatalog(context, {})).total).toBe(1);
  });

  test("a committed registration replay refuses until the terminal close unregisters the workflow", async () => {
    const { harnessDir, context } = await fixture("terminal-replay-");
    const request = planRequest({ harnessDir, operationId: "op-terminal-replay", expectedCatalogRevision: 0 });
    const receipt = await registerCatalogExecution(context, request);
    const snapshotPath = join(harnessDir, "workflows", "wf-plan-1", "snapshot.json");
    const snapshotDoc = JSON.parse(readFileSync(snapshotPath, "utf8")) as { status: string; ended_at?: string };
    snapshotDoc.status = "stopped";
    snapshotDoc.ended_at = "2026-10-04";
    writeFileSync(snapshotPath, `${JSON.stringify(snapshotDoc, null, 2)}\n`);

    await expect(registerCatalogExecution(context, request)).rejects.toMatchObject({
      name: "CatalogRegistrationError",
      code: "catalog.registration-terminal-lifecycle",
      message: expect.stringContaining(`mstar status workflow-close --workflow wf-plan-1 --harness '${harnessDir}'`),
    });

    await expect(reconcileCatalogExecution(context, request.operationId)).rejects.toMatchObject({
      name: "CatalogRegistrationError",
      code: "catalog.registration-terminal-lifecycle",
      message: expect.stringContaining(`mstar status workflow-close --workflow wf-plan-1 --harness '${harnessDir}'`),
    });

    // An already-terminal close is the supported unregister-only recovery.
    const close = await closeFileWorkflow({ harnessRoot: harnessDir, workflowId: "wf-plan-1", endedAt: "2026-10-04" });
    expect(close).toMatchObject({ outcome: "already-terminal", unregistered: true });
    expect(await registerCatalogExecution(context, request)).toEqual(receipt);
  });

  test("interrupted registration \u2014 recovers a crash after the catalog publish: the pending marker is finished without republishing", async () => {
    const { harnessDir, context } = await fixture("post-publish-crash-");
    const request = planRequest({ harnessDir, operationId: "op-crash", expectedCatalogRevision: 0 });
    await registerCatalogExecution(context, request);

    // Reconstruct the crash state exactly: the operation published its catalog
    // delta but never recorded the commit marker (the journal row is put back
    // to the phase it stopped at).
    const handle = await openStore(context, "write");
    handle.db
      .prepare("update catalog_operations set phase = 'execution-written', result_json = null where operation_id = ?")
      .run("op-crash");
    handle.close();

    const state = await resolveCatalogRegistrationState(context, "wf-plan-1");
    expect(state.pending).toEqual({ operationId: "op-crash", phase: "execution-written" });
    await expect(assertCatalogExecutionCommitted(context, "wf-plan-1")).rejects.toMatchObject({
      code: "catalog.registration-pending",
    });

    const receipt = await reconcileCatalogExecution(context, "op-crash");
    expect(receipt).toEqual({ operationId: "op-crash", workflowId: "wf-plan-1", catalogRevision: 1, recovered: true });
    // Exactly the writes it owns: no duplicate row, no extra revision.
    expect((await listCatalog(context, {})).total).toBe(1);
    expect((await readCatalogRevisions(context)).catalogRevision).toBe(1);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    await assertCatalogExecutionCommitted(context, "wf-plan-1");
  });
});

// ---------------------------------------------------------------------------
// Interrupted registration restart (R2/A05/A09/A28) and the selected-artifact
// derivation (R1/A02). The scenario the recovery design names: a registration
// that died between its links. The ordinary intent — the SAME registration
// asked for again — must finish only the missing link, keep the original
// creation identity/timestamps, and never recreate, duplicate or adopt
// anything foreign.
// ---------------------------------------------------------------------------

describe("catalog execution registration \u2014 interrupted registration restart", () => {
  test("interrupted registration \u2014 the same operation finishes its own missing root link against the existing bytes", async () => {
    const { harnessDir, context } = await fixture("interrupted-link-");
    const request = planRequest({ harnessDir, operationId: "op-link", expectedCatalogRevision: 0 });
    const receipt = await registerCatalogExecution(context, request);
    const snapshotPath = join(harnessDir, "workflows", "wf-plan-1", WORKFLOW_SNAPSHOT_FILE);
    const snapshotBytes = readFileSync(snapshotPath, "utf8");
    const created = JSON.parse(snapshotBytes) as Record<string, unknown>;

    // Reconstruct the interruption exactly: the operation wrote its snapshot
    // and published its delta, then died before recording how far it got, and
    // the root entry that made the workflow visible is gone (A05: the root
    // link is missing after the interruption).
    const handle = await openStore(context, "write");
    handle.db
      .prepare("update catalog_operations set phase = 'prepared', after_versions_json = '{}', result_json = null where operation_id = ?")
      .run("op-link");
    handle.close();
    writeFileSync(join(harnessDir, "status.json"), JSON.stringify({ version: 2, updated_at: "2026-09-18", workflows: [] }, null, 2));
    expect(await listPendingCatalogRegistrations(context)).toHaveLength(1);

    // The ordinary retry — the same operation id and the same request — finishes
    // the missing link instead of demanding `catalog reconcile`.
    const resumed = await registerCatalogExecution(context, request);
    expect(resumed).toEqual({ ...receipt, recovered: true });
    // The original execution identity and root-creation timestamp survive the recovery.
    const rootDoc = JSON.parse(readFileSync(join(harnessDir, "status.json"), "utf8")) as {
      workflows: Array<Record<string, unknown>>;
    };
    expect(rootDoc.workflows).toEqual([
      { id: "wf-plan-1", type: "plan", started_at: created.started_at, dir: "workflows/wf-plan-1" },
    ]);
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
    // Exactly one catalog row and one revision: the replay published nothing new.
    expect((await listCatalog(context, {})).total).toBe(1);
    expect((await readCatalogRevisions(context)).catalogRevision).toBe(1);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    await assertCatalogExecutionCommitted(context, "wf-plan-1");
  });

  test("interrupted registration \u2014 a pending operation for a DIFFERENT registration is never adopted", async () => {
    const { harnessDir, context } = await fixture("interrupted-foreign-");
    setArtifactStore(failingStore(harnessDir, "snapshot"));
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-first", expectedCatalogRevision: 0 })),
    ).rejects.toThrow(/injected snapshot write failure/);
    setArtifactStore(createFsStore(harnessDir));

    // A different registration of the same workflow id is NOT a retry: it
    // refuses, and the interrupted operation keeps its own reviewed identity.
    await expect(
      registerCatalogExecution(
        context,
        planRequest({ harnessDir, operationId: "op-second", expectedCatalogRevision: 0, project: "another-project" }),
      ),
    ).rejects.toMatchObject({ code: "catalog.registration-pending" });
    expect(existsSync(join(harnessDir, "workflows", "wf-plan-1", WORKFLOW_SNAPSHOT_FILE))).toBe(false);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
    expect((await listCatalog(context, {})).total).toBe(0);
    const pending = await listPendingCatalogRegistrations(context);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operationId: "op-first", phase: "prepared", rootVisible: false });

    // …and its own retry still finishes it: the refusal did not damage the
    // operation, and the second attempt adopted nothing.
    const resumed = await registerCatalogExecution(
      context,
      planRequest({ harnessDir, operationId: "op-first", expectedCatalogRevision: 0 }),
    );
    expect(resumed).toEqual({ operationId: "op-first", workflowId: "wf-plan-1", catalogRevision: 1, recovered: true });
    expect((await catalogPlan(context, PLAN_ID)).title).toBe("State projection plan");
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });

  test("interrupted registration \u2014 a fresh operation with the SAME identity but a different reviewed delta is never adopted", async () => {
    const { harnessDir, context } = await fixture("interrupted-delta-");
    setArtifactStore(failingStore(harnessDir, "snapshot"));
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-delta", expectedCatalogRevision: 0 })),
    ).rejects.toThrow(/injected snapshot write failure/);
    setArtifactStore(createFsStore(harnessDir));

    // The SAME workflow and registration identity (the same selected document,
    // branches, project and delivery kind) reviewed with a DIFFERENT catalog
    // delta: the plan entity is asked for at another catalog location. The
    // reviewed delta is part of the semantic request fingerprint, so this is not
    // a retry of the pending operation — adopting the row would publish ITS
    // delta under this intent.
    const other = planRequest({ harnessDir, operationId: "op-delta-2", expectedCatalogRevision: 0 });
    const otherPlanEntity = other.delta.entities[0];
    if (otherPlanEntity === undefined) throw new Error("the fixture plan request states one catalog entity");
    otherPlanEntity.relativePath = "elsewhere.md";
    await expect(registerCatalogExecution(context, other)).rejects.toMatchObject({
      code: "catalog.registration-pending",
    });

    // Nothing of the refused request landed: no execution bytes, no catalog row,
    // and the pending operation is untouched.
    expect(existsSync(join(harnessDir, "workflows", "wf-plan-1", WORKFLOW_SNAPSHOT_FILE))).toBe(false);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
    expect((await listCatalog(context, {})).total).toBe(0);
    const pending = await listPendingCatalogRegistrations(context);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operationId: "op-delta", phase: "prepared", rootVisible: false });

    // Only the original operation id may finish its pending registration.
    const resumed = await reconcileCatalogExecution(context, "op-delta");
    expect(resumed).toEqual({ operationId: "op-delta", workflowId: "wf-plan-1", catalogRevision: 1, recovered: true });
    expect((await catalogPlan(context, PLAN_ID)).relativePath).toBe(`${PLAN_ID}.md`);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });

  test("registration recovery \u2014 the shipped plan registration derives identity, title and catalog location from the selected document", async () => {
    const { harnessDir, context } = await fixture("derived-plan-");
    // The selected artifact: a real registered plan document (its own
    // `plan_id` header is the identity authority, its first heading the title).
    const planId = "20260918-derived-plan";
    mkdirSync(join(harnessDir, "plans"), { recursive: true });
    writeFileSync(
      join(harnessDir, "plans", `${planId}.md`),
      `# State projection plan\n\n**plan_id:** ${planId}\n\nBody.\n`,
      "utf8",
    );

    // The caller supplies the SELECTED DOCUMENT only: no copied id, no copied
    // title, and no reviewed delta — the shipped route derives them (R1).
    const receipt = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: {
        kind: "plan",
        workflowId: "wf-derived-1",
        options: {
          harnessDir,
          plan: { file: `plans/${planId}.md` },
          deliveryKind: "development",
          branchSource: "feature/20260918-derived-plan",
          branchTarget: "main",
          startedAt: "2026-09-18T00:00:00.000Z",
        },
      },
    });
    expect(receipt).toEqual({ operationId: expect.any(String), workflowId: "wf-derived-1", catalogRevision: 1, recovered: false });

    const snapshot = JSON.parse(
      readFileSync(join(harnessDir, "workflows", "wf-derived-1", WORKFLOW_SNAPSHOT_FILE), "utf8"),
    ) as { plans: Array<Record<string, unknown>> };
    expect(snapshot.plans).toEqual([
      {
        id: planId,
        title: "State projection plan",
        file: realpathSync(join(harnessDir, "plans", `${planId}.md`)),
        status: "Todo",
      },
    ]);
    // The catalog entity states the same document, plans-root-relative.
    const entity = await catalogPlan(context, planId);
    expect(entity.title).toBe("State projection plan");
    expect(entity.relativePath).toBe(`${planId}.md`);
    expect((await resolveCatalogRegistrationState(context, "wf-derived-1")).binding).toEqual({
      catalogKind: "plan",
      catalogId: planId,
      catalogRevision: 1,
    });
    // Derived identity, not an independent one: the second run of the same
    // registration is a successful no-op on the SAME operation identity.
    expect(
      await registerShippedCatalogExecution(context, {
        actor: "project-manager",
        workflow: {
          kind: "plan",
          workflowId: "wf-derived-1",
          options: {
            harnessDir,
            plan: { file: `plans/${planId}.md` },
            deliveryKind: "development",
            branchSource: "feature/20260918-derived-plan",
            branchTarget: "main",
            startedAt: "2026-09-18T00:00:00.000Z",
          },
        },
      }),
    ).toEqual(receipt);
    
    expect((await listCatalog(context, {})).total).toBe(1);
    expect((await readCatalogRevisions(context)).catalogRevision).toBe(1);
  });

  test("registration recovery \u2014 explicit metadata with a canonical absolute pointer still proves the selected document", async () => {
    const { harnessDir, context } = await fixture("explicit-plan-");
    const planId = "20260918-explicit-plan";
    const title = "Explicit registration plan";
    writePlanDocument(harnessDir, planId, title);
    const canonical = realpathSync(join(harnessDir, "plans", `${planId}.md`));

    // The FULLY explicit form (id AND title) naming the SAME registered document
    // in its canonical absolute spelling: the §4 resolver still runs, so the
    // shipped route derives the catalog location from the RESOLVED document —
    // the absolute pointer the caller passed is never used as the entity's
    // `relativePath` (which the delta location gate refuses as an absolute
    // spelling).
    const receipt = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: {
        kind: "plan",
        workflowId: "wf-explicit-1",
        options: {
          harnessDir,
          plan: { id: planId, title, file: canonical },
          deliveryKind: "development",
          branchSource: `feature/${planId}`,
          branchTarget: "main",
          startedAt: "2026-09-18T00:00:00.000Z",
        },
      },
    });
    expect(receipt).toEqual({
      operationId: expect.any(String),
      workflowId: "wf-explicit-1",
      catalogRevision: 1,
      recovered: false,
    });

    const snapshot = JSON.parse(
      readFileSync(join(harnessDir, "workflows", "wf-explicit-1", WORKFLOW_SNAPSHOT_FILE), "utf8"),
    ) as { plans: Array<Record<string, unknown>> };
    expect(snapshot.plans).toEqual([{ id: planId, title, file: canonical, status: "Todo" }]);
    const entity = await catalogPlan(context, planId);
    expect(entity.title).toBe(title);
    expect(entity.relativePath).toBe(`${planId}.md`);
  });

  test("registration recovery \u2014 a fresh operation id against a committed registration is a create-only conflict (A09)", async () => {
    const { harnessDir, context } = await fixture("repeat-noop-");
    const request = planRequest({ harnessDir, operationId: "op-repeat", expectedCatalogRevision: 0 });
    const receipt = await registerCatalogExecution(context, request);

    // The SAME operation id repeats its recorded receipt (the replay above).
    expect(await registerCatalogExecution(context, request)).toEqual(receipt);

    // A FRESH operation id meeting the committed registration of this workflow
    // id is not a retry: uniqueness by workflow id is the semantic constraint,
    // expression by the create-only refusal — nothing is replaced, deleted or
    // re-timestamped.
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-repeat-2", expectedCatalogRevision: 0 })),
    ).rejects.toMatchObject({ code: "catalog.registration-conflict" });
    expect((await listCatalog(context, {})).total).toBe(1);
    expect((await readCatalogRevisions(context)).catalogRevision).toBe(1);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    // The refused attempt recorded no operation of its own.
    const handle = await openStore(context, "read");
    const own = handle.db
      .prepare("select count(*) as n from catalog_operations where operation_id = ?")
      .get("op-repeat-2") as { n: number };
    handle.close();
    expect(own.n).toBe(0);
  });
});

describe("catalog execution registration \u2014 the other two producers", () => {
  test("registration recovery \u2014 registers an iteration (with its relation) through the same journal at its derived initial phase", async () => {
    const { harnessDir, context } = await fixture("iteration-");
    const iterationId = "20260918-registration-iteration";
    // §4: the row pointer is the registered plan file under the configured
    // `{PLAN_DIR}` — the resolver reads and declaration-checks it, and the
    // snapshot persists its canonical absolute path.
    mkdirSync(join(harnessDir, "plans"), { recursive: true });
    const planFile = join(harnessDir, "plans", `${PLAN_ID}.md`);
    writeFileSync(planFile, `# Plan ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n`);
    const canonicalPlanFile = realpathSync(planFile);
    const request: CatalogExecutionRequest = {
      operationId: "op-iteration",
      actor: "project-manager",
      expectedCatalogRevision: 0,
      workflow: {
        kind: "iteration",
        workflowId: iterationId,
        options: {
          harnessDir,
          compassRef: `iterations/${iterationId}/delivery-compass.md`,
          branch: { base: "main", integration: "feature/20260918-registration-iteration", target: "main" },
          rows: [{ id: PLAN_ID, title: "State projection plan", file: `plans/${PLAN_ID}.md` }],
          project: "harness",
          startedAt: "2026-09-18T00:00:00.000Z",
        },
      },
      delta: {
        entities: [
          { kind: "iteration", id: iterationId, title: "Registration iteration", rootKind: "iterations", relativePath: iterationId },
          { kind: "plan", id: PLAN_ID, title: "State projection plan", rootKind: "plans", relativePath: `${PLAN_ID}.md` },
        ],
        links: [
          {
            from: { kind: "plan", id: PLAN_ID },
            relation: "belongs-to",
            to: { kind: "iteration", id: iterationId },
          },
        ],
        binding: { catalogKind: "iteration", catalogId: iterationId },
      },
    };

    const receipt = await registerCatalogExecution(context, request);
    // Two entities + one relation, each a published catalog mutation.
    expect(receipt).toEqual({ operationId: "op-iteration", workflowId: iterationId, catalogRevision: 3, recovered: false });

    const snapshot = JSON.parse(readFileSync(join(harnessDir, "workflows", iterationId, WORKFLOW_SNAPSHOT_FILE), "utf8")) as {
      type: string;
      phase?: string;
      plans: Array<Record<string, unknown>>;
    };
    expect(snapshot.type).toBe("iteration");
    // R3/A04 — the initial phase registration proves for an iteration that was
    // never started: the producer declares `phase-1-prepare` at creation, and the
    // read-time derivation of the SAME unstarted facts agrees with it (a
    // registered-but-unstarted lifecycle is never read as "no declared phase").
    expect(snapshot.phase).toBe(PREPARE_PHASE);
    expect(deriveLifecyclePhase(readWorkflowSnapshot(join(harnessDir, "workflows", iterationId)).snapshot).phase).toBe(
      PREPARE_PHASE,
    );
    // The registered pointer is the canonical absolute plan file, not the
    // `plans/<id>.md` spelling the reviewer passed in.
    expect(snapshot.plans).toEqual([expect.objectContaining({ id: PLAN_ID, file: canonicalPlanFile, status: "Todo" })]);
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
    expect((await resolveCatalogRegistrationState(context, iterationId)).binding).toEqual({
      catalogKind: "iteration",
      catalogId: iterationId,
      catalogRevision: 3,
    });
    const page = await listCatalog(context, {});
    expect(page.items.map((item) => `${item.kind}:${item.id}`).sort()).toEqual([`iteration:${iterationId}`, `plan:${PLAN_ID}`]);
    expect(page.links).toEqual([
      { fromKind: "plan", fromId: PLAN_ID, relation: "belongs-to", toKind: "iteration", toId: iterationId, ordinal: null },
    ]);
    await assertCatalogExecutionCommitted(context, iterationId);
  });

  test("registers an audit promotion through the same journal, with the plan body as the title authority", async () => {
    const { harnessDir, context } = await fixture("audit-");
    const outDir = join(harnessDir, "audit-2026-09-18");
    mkdirSync(outDir, { recursive: true });
    const file = "001-fix-the-duplicate-index.md";
    writeFileSync(
      join(outDir, file),
      "# Fix the duplicate index\n\n## Impact\nEvery lookup scans twice.\n",
    );
    // The audit report README's `## Execution order & status` index is a
    // REPORT artifact, not the registration authority (state-projection
    // contract §2/§4): a hand-edited title there must not rename the promoted
    // row. The former README-index lookup is gone from the promotion path.
    writeFileSync(
      join(outDir, "README.md"),
      "# Audit Report\n\n## Execution order & status\n\n| Plan | Title | Priority | Effort | Depends on | Status |\n|------|-------|----------|--------|------------|--------|\n| 001 | Hand-edited index title | P1 | S | none | TODO |\n",
    );

    const request: CatalogExecutionRequest = {
      operationId: "op-audit",
      actor: "project-manager",
      expectedCatalogRevision: 0,
      workflow: {
        kind: "audit",
        outDir,
        selected: ["001"],
        options: { harnessDir, deliveryKind: "verification/report-only", completionPolicy: "acceptance artifacts under the audit dir" },
      },
      delta: {
        entities: [{ kind: "plan", id: "001-fix-the-duplicate-index", title: "Fix the duplicate index", rootKind: "plans", relativePath: file }],
        binding: { catalogKind: "plan", catalogId: "001-fix-the-duplicate-index" },
      },
    };

    const receipt = await registerCatalogExecution(context, request);
    expect(receipt).toEqual({
      operationId: "op-audit",
      workflowId: "audit-2026-09-18",
      catalogRevision: 1,
      recovered: false,
    });

    const snapshot = JSON.parse(
      readFileSync(join(harnessDir, "workflows", "audit-2026-09-18", WORKFLOW_SNAPSHOT_FILE), "utf8"),
    ) as { plans: Array<Record<string, unknown>>; completion_policy?: string };
    expect(snapshot.completion_policy).toBe("acceptance artifacts under the audit dir");
    expect(snapshot.plans).toEqual([
      { id: "001-fix-the-duplicate-index", title: "Fix the duplicate index", file, status: "Todo" },
    ]);
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
    await assertCatalogExecutionCommitted(context, "audit-2026-09-18");
  });

  test("reconciles audit promotion when reviewed prose changes after preparation", async () => {
    const { harnessDir, context } = await fixture("audit-drift-");
    const outDir = join(harnessDir, "audit-2026-09-17");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "001-original.md"), "# Original title\n");
    setArtifactStore(failingStore(harnessDir, "snapshot"));

    const request: CatalogExecutionRequest = {
      operationId: "op-audit-drift",
      actor: "project-manager",
      expectedCatalogRevision: 0,
      workflow: {
        kind: "audit",
        outDir,
        selected: ["001"],
        options: { harnessDir, deliveryKind: "verification/report-only", completionPolicy: "acceptance artifacts" },
      },
      delta: {
        entities: [{ kind: "plan", id: "001-original", title: "Original title", rootKind: "plans", relativePath: "001-original.md" }],
        binding: { catalogKind: "plan", catalogId: "001-original" },
      },
    };
    await expect(registerCatalogExecution(context, request)).rejects.toThrow(/injected snapshot write failure/);
    setArtifactStore(createFsStore(harnessDir));

    // Body/prose is not registration ownership. Reconcile retains the journaled catalog identity.
    writeFileSync(join(outDir, "001-original.md"), "# Renamed after review\n");

    await expect(reconcileCatalogExecution(context, "op-audit-drift")).resolves.toMatchObject({
      operationId: "op-audit-drift",
      workflowId: "audit-2026-09-17",
    });
    expect(existsSync(join(harnessDir, "workflows", "audit-2026-09-17", WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    const entity = await catalogPlan(context, "001-original");
    expect(entity.id).toBe("001-original");
    expect(entity.title).toBe("Original title");
    expect(entity.relativePath).toBe("001-original.md");
    expect((await resolveCatalogRegistrationState(context, "audit-2026-09-17")).binding).toEqual({
      catalogKind: "plan",
      catalogId: "001-original",
      catalogRevision: 1,
    });
  });
});

describe("catalog execution registration \u2014 refusals are typed and recoverable", () => {
  test("a re-drive failure keeps the pending row: only a fixed environment loses nothing", async () => {
    const { harnessDir, context } = await fixture("retry-");
    // The store refuses the snapshot write for the whole first phase.
    const broken = failingStore(harnessDir, "snapshot", Number.POSITIVE_INFINITY);
    setArtifactStore(broken);
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-retry", expectedCatalogRevision: 0 })),
    ).rejects.toThrow(/injected snapshot write failure/);

    // Reconcile while the write still fails: refuse visibly, keep the row, and
    // keep the catalog empty — never a silent abort of a recoverable operation.
    await expect(reconcileCatalogExecution(context, "op-retry")).rejects.toMatchObject({
      code: "catalog.reconcile-conflict",
    });
    expect((await listPendingCatalogRegistrations(context)).map((entry) => [entry.operationId, entry.phase])).toEqual([
      ["op-retry", "prepared"],
    ]);
    expect((await listCatalog(context, {})).total).toBe(0);

    // The same operation completes once the environment is healthy again.
    setArtifactStore(createFsStore(harnessDir));
    const receipt = await reconcileCatalogExecution(context, "op-retry");
    expect(receipt).toEqual({ operationId: "op-retry", workflowId: "wf-plan-1", catalogRevision: 1, recovered: true });
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });

  test("an explicit abort abandons only an operation that wrote nothing", async () => {
    const { harnessDir, context } = await fixture("abandon-");
    setArtifactStore(failingStore(harnessDir, "snapshot"));
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-abandon", expectedCatalogRevision: 0 })),
    ).rejects.toThrow(/injected snapshot write failure/);
    setArtifactStore(createFsStore(harnessDir));

    expect(await abortCatalogExecution(context, "op-abandon", "operator decision")).toEqual({
      operationId: "op-abandon",
      workflowId: "wf-plan-1",
      phase: "aborted",
    });
    // Idempotent, and the workflow id is free again.
    expect((await abortCatalogExecution(context, "op-abandon")).phase).toBe("aborted");
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    const fresh = await registerCatalogExecution(
      context,
      planRequest({ harnessDir, operationId: "op-abandon-2", expectedCatalogRevision: 0 }),
    );
    expect(fresh.recovered).toBe(false);

    // An operation whose execution registration IS on disk is never abandoned:
    // that would leave exactly the half-registered workflow the journal exists
    // to prevent.
    const handle = await openStore(context, "write");
    handle.db.prepare("update catalog_operations set phase = 'execution-written', result_json = null where operation_id = ?").run("op-abandon-2");
    handle.close();
    await expect(abortCatalogExecution(context, "op-abandon-2")).rejects.toMatchObject({
      code: "catalog.reconcile-conflict",
    });
    expect(await listPendingCatalogRegistrations(context)).toHaveLength(1);

    // A committed registration is never aborted either.
    await reconcileCatalogExecution(context, "op-abandon-2");
    await expect(abortCatalogExecution(context, "op-abandon-2")).rejects.toMatchObject({
      code: "catalog.reconcile-conflict",
    });
  });

  test("reconcile aborts a pending delta that can no longer be published, and the workflow is free to re-register", async () => {
    const { harnessDir, context } = await fixture("abort-");
    setArtifactStore(failingStore(harnessDir, "snapshot"));
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-abort", expectedCatalogRevision: 0 })),
    ).rejects.toThrow(/injected snapshot write failure/);
    setArtifactStore(createFsStore(harnessDir));

    // The catalog moves on while the operation is pending: the delta was
    // reviewed against revision 0 and can never be published as reviewed.
    await registerCatalogEntity(
      context,
      { kind: "project", id: "harness", title: "Harness", rootKind: "projects", relativePath: "harness" },
      { operationId: "seed-project", actor: "project-manager" },
    );

    // Nothing of the operation was written, so reconcile ABORTS the pending
    // delta (contract §3 step 4) rather than publishing a stale review.
    await expect(reconcileCatalogExecution(context, "op-abort")).rejects.toMatchObject({
      code: "catalog.reconcile-conflict",
    });
    expect(existsSync(join(harnessDir, "workflows", "wf-plan-1", WORKFLOW_SNAPSHOT_FILE))).toBe(false);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
    expect((await listCatalog(context, {})).total).toBe(1);

    // The aborted operation is terminal for that id, and the workflow is free
    // again: a fresh operation id against the current revision registers.
    await expect(reconcileCatalogExecution(context, "op-abort")).rejects.toMatchObject({
      code: "catalog.registration-aborted",
    });
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-abort", expectedCatalogRevision: 0 })),
    ).rejects.toMatchObject({ code: "catalog.registration-aborted" });

    const receipt = await registerCatalogExecution(
      context,
      planRequest({ harnessDir, operationId: "op-abort-retry", expectedCatalogRevision: 1 }),
    );
    expect(receipt).toEqual({ operationId: "op-abort-retry", workflowId: "wf-plan-1", catalogRevision: 2, recovered: false });
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
  });

  test("an unknown operation id refuses catalog.not-found", async () => {
    const { context } = await fixture("unknown-op-");
    await expect(reconcileCatalogExecution(context, "op-does-not-exist")).rejects.toMatchObject({
      code: "catalog.not-found",
    });
    expect(new CatalogRegistrationError("catalog.registration-pending", "x").code).toBe("catalog.registration-pending");
  });
});

describe("catalog execution registration \u2014 registered-plan path preflight (\u00a74)", () => {
  const ITERATION_ID = "20260918-path-iteration";

  /** A minimal iteration request whose single row points at `file`. */
  function iterationRequest(harnessDir: string, file: string, operationId: string): CatalogExecutionRequest {
    return {
      operationId,
      actor: "project-manager",
      expectedCatalogRevision: 0,
      workflow: {
        kind: "iteration",
        workflowId: ITERATION_ID,
        options: {
          harnessDir,
          compassRef: `iterations/${ITERATION_ID}/delivery-compass.md`,
          branch: { base: "main", integration: "feature/20260918-path", target: "main" },
          rows: [{ id: PLAN_ID, title: "State projection plan", file }],
          startedAt: "2026-09-18T00:00:00.000Z",
        },
      },
      delta: {
        entities: [
          { kind: "iteration", id: ITERATION_ID, title: "Path iteration", rootKind: "iterations", relativePath: ITERATION_ID },
        ],
        binding: { catalogKind: "iteration", catalogId: ITERATION_ID },
      },
    };
  }

  function planFixture(harnessDir: string): string {
    const file = join(harnessDir, "plans", `${PLAN_ID}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `# Plan ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n`);
    return realpathSync(file);
  }

  test("prerequisite path: the repository-relative .mstar/plans spelling refuses before any journal row", async () => {
    const { harnessDir, context } = await fixture("path-refusal-");
    planFixture(harnessDir);

    await expect(
      registerCatalogExecution(context, iterationRequest(harnessDir, `.mstar/plans/${PLAN_ID}.md`, "op-path-refusal")),
    ).rejects.toMatchObject({ code: "plan-path.invalid-pointer" });

    // No prepared row, no catalog delta, no execution bytes: the refusal
    // precedes the first journal write.
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    expect((await listCatalog(context, {})).total).toBe(0);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
    expect(existsSync(join(harnessDir, "workflows", ITERATION_ID, WORKFLOW_SNAPSHOT_FILE))).toBe(false);
  });

  test("prerequisite path: the normalized request is what is hashed, stored and written", async () => {
    const { harnessDir, context } = await fixture("path-accepted-");
    const canonical = planFixture(harnessDir);

    const receipt = await registerCatalogExecution(
      context,
      iterationRequest(harnessDir, `plans/${PLAN_ID}.md`, "op-path-accepted"),
    );
    expect(receipt).toEqual({ operationId: "op-path-accepted", workflowId: ITERATION_ID, catalogRevision: 1, recovered: false });
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);

    const snapshot = JSON.parse(
      readFileSync(join(harnessDir, "workflows", ITERATION_ID, WORKFLOW_SNAPSHOT_FILE), "utf8"),
    ) as { plans: Array<{ file: string }> };
    expect(snapshot.plans).toEqual([expect.objectContaining({ id: PLAN_ID, file: canonical })]);

    // The same operation replayed with the OTHER accepted spelling of the same
    // target must hash identically and replay — one normalized representation
    // feeds both the catalog identity and the producer.
    const replay = await registerCatalogExecution(
      context,
      iterationRequest(harnessDir, canonical, "op-path-accepted"),
    );
    expect(replay).toEqual(receipt);
  });

  test("prerequisite path: the equivalent accepted spellings share ONE shipped operation identity", async () => {
    const { harnessDir, context } = await fixture("path-shipped-identity-");
    const canonical = planFixture(harnessDir);
    // The shipped transport derives its own operation id (no explicit id): both
    // accepted spellings of the same plan target must land on the same
    // operation, so the second call is the EXISTING operation rather than a
    // second, competing registration of the same workflow.
    const shipped = (file: string) =>
      registerShippedCatalogExecution(context, {
        actor: "cli:iteration-register",
        workflow: iterationRequest(harnessDir, file, "op-derived").workflow,
      });

    const first = await shipped(`plans/${PLAN_ID}.md`);
    expect(first.recovered).toBe(false);

    // A same-spelling retry reuses the committed operation id — even though the
    // catalog expectation has moved since. The canonical spelling must be
    // indistinguishable from it: a different id would have started a second
    // operation for the same workflow instead of replaying the committed one.
    // R6/A09: the repeat returns the current success (no duplicate row, no
    // churn), and a moved freshness token is not a different intent.
    expect(await shipped(`plans/${PLAN_ID}.md`)).toEqual(first);
    expect(await shipped(canonical)).toEqual(first);

    // One operation was ever recorded: the equivalent spelling left no
    // half-registered workflow behind.
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    expect((await listCatalog(context, {})).total).toBe(1);
  });

  test("prerequisite path: a mismatched declared plan_id refuses before any journal row", async () => {
    const { harnessDir, context } = await fixture("path-identity-");
    const file = join(harnessDir, "plans", `${PLAN_ID}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "# Plan\n\n**plan_id:** some-other-plan\n");

    await expect(
      registerCatalogExecution(context, iterationRequest(harnessDir, `plans/${PLAN_ID}.md`, "op-path-identity")),
    ).rejects.toMatchObject({ code: "plan-path.identity-mismatch" });
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
  });
});

/**
 * The recovery segments are bound at the RAISING site: each assertion drives a
 * real producer refusal and reads the text the producer itself throws (never a
 * string the test plants). Deleting or weakening a producer's recovery sentence
 * fails the corresponding assertion.
 */
describe("catalog execution registration \u2014 recovery segments at the raising site", () => {
  test("identity mismatch names the FRESH --workflow re-run", async () => {
    const { harnessDir, context } = await fixture("recovery-identity-");
    const dir = join(harnessDir, "workflows", "wf-plan-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({
      schema_version: 1,
      id: "wf-plan-1",
      type: "plan",
      status: "running",
      started_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01",
      plans: [{ id: "foreign-plan", title: "Foreign plan", file: "foreign.md", status: "Todo" }],
      delivery_kind: "verification/report-only",
      completion_policy: "foreign",
    }, null, 2));

    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-recovery-identity", expectedCatalogRevision: 0 })),
    ).rejects.toMatchObject({
      code: "catalog.registration-conflict",
      message: expect.stringContaining("Re-run `mstar workflow register` or `mstar iteration register` with a FRESH `--workflow` id; reconcile cannot adopt foreign bytes."),
    });
  });

  test("a stale root entry names the FRESH --workflow re-run and the absent repair verb", async () => {
    const { harnessDir, context } = await fixture("recovery-stale-root-");
    writeFileSync(join(harnessDir, "status.json"), JSON.stringify({
      version: 2,
      updated_at: "2026-09-18",
      workflows: [{ id: "wf-plan-1", type: "plan", started_at: "2026-09-18T00:00:00.000Z", dir: "workflows/wf-plan-1" }],
    }, null, 2));

    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-recovery-stale-root", expectedCatalogRevision: 0 })),
    ).rejects.toMatchObject({
      code: "catalog.registration-conflict",
      message: expect.stringContaining("Re-run with a FRESH `--workflow` id; there is no CLI verb to remove or repair the stale root entry."),
    });
  });

  test("a diverged execution registration at publish names the fresh ids and the reconcile route", async () => {
    const { harnessDir, context } = await fixture("recovery-divergence-");
    await registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-recovery-diverge-0", expectedCatalogRevision: 0 }));
    // Recreate the orphan shape: the operation's own writes are on disk while
    // the journal and catalog are empty again.
    const handle = await openStore(context, "write");
    handle.db.prepare("delete from catalog_operations").run();
    handle.db.prepare("delete from catalog_links").run();
    handle.db.prepare("delete from catalog_execution_bindings").run();
    handle.db.prepare("delete from catalog_entities").run();
    handle.db.prepare("update store_meta set catalog_revision = 0 where id = 1").run();
    handle.close();
    writeFileSync(join(harnessDir, "status.json"), JSON.stringify({ version: 2, updated_at: "2026-09-18", workflows: [] }, null, 2));

    // The root write is the last step before publish; mutate the snapshot under
    // it so the verified bytes no longer match the reviewed identity.
    const base = createFsStore(harnessDir);
    const snapshotPath = join(harnessDir, "workflows", "wf-plan-1", WORKFLOW_SNAPSHOT_FILE);
    let mutated = false;
    setArtifactStore({
      ...base,
      put: async (doc) => {
        await base.put(doc);
        if (!mutated && doc.kind === "status") {
          mutated = true;
          const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
          snapshot.project = "another-project";
          writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
        }
      },
    });

    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-recovery-diverge-1", expectedCatalogRevision: 0 })),
    ).rejects.toMatchObject({
      code: "catalog.registration-conflict",
      message: expect.stringContaining("Re-run with a FRESH `--workflow` id and a fresh operation id, or reconcile your own operation with `mstar catalog reconcile --operation-id <own>`."),
    });
  });

  test("the reviewed-expectation refusal names the fresh operation id and the reconcile route", async () => {
    const { harnessDir, context } = await fixture("recovery-revision-");
    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-recovery-revision", expectedCatalogRevision: 99 })),
    ).rejects.toMatchObject({
      code: "catalog.revision-conflict",
      message: expect.stringContaining("nothing was registered. Re-run with a fresh operation id to read the current catalog revision, or reconcile the pending operation with `mstar catalog reconcile --operation-id <op>`."),
    });
  });

  test("a missing snapshot after the producer reports success names verify, re-drive and record steps", async () => {
    const { harnessDir, context } = await fixture("recovery-missing-snapshot-");
    const base = createFsStore(harnessDir);
    setArtifactStore({
      ...base,
      put: async (doc) => {
        await base.put(doc);
        // The producer's own writes land, then the snapshot disappears before
        // the post-write verification reads it back.
        if (doc.kind === "status") rmSync(join(harnessDir, "workflows", "wf-plan-1", WORKFLOW_SNAPSHOT_FILE), { force: true });
      },
    });

    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-recovery-missing-snapshot", expectedCatalogRevision: 0 })),
    ).rejects.toMatchObject({
      code: "catalog.registration-invalid",
      message: expect.stringContaining("Verify via mstar status validate <snapshotPath>; re-drive via mstar catalog reconcile --list and mstar catalog reconcile --operation-id <op>; record via mstar issue add."),
    });
  });

  test("an operation that does not own the binding names the owner discovery and replay", async () => {
    const { harnessDir, context } = await fixture("recovery-binding-owner-");
    await registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-recovery-owner-a", expectedCatalogRevision: 0 }));
    // The binding stays while its committed journal row is gone: the shape the
    // producer comment names (a binding owned by another operation remains).
    const handle = await openStore(context, "write");
    handle.db.prepare("delete from catalog_operations").run();
    handle.close();
    writeFileSync(join(harnessDir, "status.json"), JSON.stringify({ version: 2, updated_at: "2026-09-18", workflows: [] }, null, 2));

    await expect(
      registerCatalogExecution(context, planRequest({ harnessDir, operationId: "op-recovery-owner-b", expectedCatalogRevision: 1 })),
    ).rejects.toMatchObject({
      code: "catalog.reconcile-conflict",
      message: expect.stringContaining("Discover the owning operation via mstar catalog reconcile --list, then replay it idempotently with mstar catalog reconcile --operation-id <owner>."),
    });
  });
});
