/**
 * Protected-writers CAS and catalog/store registration-gate families.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindPlanSession, mutatePlanCoordination, readCoordinatedArtifact, readPlanCoordination, replaceCoordinatedArtifact, type CatalogExecutionPin } from "../src/coordination.js";
import { updateCatalogEntity } from "../src/catalog.js";
import { withProtectedWrite } from "../src/coordination-write.js";
import { openStore, type StoreContext } from "../src/store-db.js";
import { createFsStore } from "../src/store.js";
import {
  FIXTURE_COORDINATOR_ID,
  PLAN_ID,
  PEER_PLAN_ID,
  PROJECT_ID,
  WORKFLOW_ID,
  afterEachCleanup,
  bindPlan,
  ensureCoordinator,
  errorCodeOf,
  finding,
  linkedOpenIssues,
  makeFixture,
  preparePlan,
  readJson,
  storeBacked,
  writeJson,
  type Fixture,
} from "./support/coordination-fixtures.js";

afterEach(() => afterEachCleanup());
describe("protected-writers", () => {
  const STATUS_REF = { kind: "status", key: "root" } as const;

  test("the root status is replaced under the write lock without a byte-version precondition", async () => {
    const fixture = makeFixture();
    const harnessRoot = realpathSync(fixture.harness);
    const statusPath = join(harnessRoot, "status.json");
    const empty = { version: 2, updated_at: "2026-09-16", workflows: [] };

    // An intervening prose/formatting edit is not a refusal condition.
    writeFileSync(statusPath, `${readFileSync(statusPath, "utf8")}\n`);
    const replaced = await replaceCoordinatedArtifact({
      harnessRoot,
      ref: STATUS_REF,
      payload: empty,
    });
    expect(replaced.payload).toEqual(empty);
    expect((await readCoordinatedArtifact(harnessRoot, STATUS_REF)).payload).toEqual(empty);
  });

  test("a root that registers a coordinated workflow is refused on either side", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    const harnessRoot = realpathSync(fixture.harness);
    const statusPath = join(harnessRoot, "status.json");
    const coordinated = readJson(statusPath);
    if (!Array.isArray(coordinated.workflows)) throw new Error("fixture root has no workflows array");
    const registered = coordinated.workflows;

    // Current side: the root on disk registers a coordinated workflow.
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({
          harnessRoot,
          ref: STATUS_REF,
          payload: coordinated,
        }),
      ),
    ).toBe("coordination.scoped-writer-required");
    expect(readJson(statusPath)).toEqual(coordinated);

    // Proposed side: the current root registers nothing coordinated, the
    // replacement would re-register the coordinated workflow.
    const plain = { version: 2, updated_at: "2026-09-17", workflows: [] };
    writeJson(statusPath, plain);
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({
          harnessRoot,
          ref: STATUS_REF,
          payload: { ...plain, workflows: registered },
        }),
      ),
    ).toBe("coordination.scoped-writer-required");
    expect(readJson(statusPath)).toEqual(plain);
  });

  test("issue authority: a project register replacement is retired and refused outright", async () => {
    const fixture = makeFixture();
    await storeBacked(fixture, [PLAN_ID, PEER_PLAN_ID]);
    const harnessRoot = realpathSync(fixture.harness);

    // A register that predates coordination is migration history: the
    // replacement surface refuses the retired kind before any CAS.
    const legacyRegister = { entries: { [PEER_PLAN_ID]: [] } };
    writeJson(fixture.registerPath, legacyRegister);
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({
          harnessRoot,
          ref: { kind: "residuals", key: PROJECT_ID } as never,
          payload: { entries: {} },
        }),
      ),
    ).toBe("coordination.store");
    // The retired kind is never a write target: the legacy file is untouched.
    expect(readJson(fixture.registerPath)).toEqual(legacyRegister);

    // The residual-add mutation itself never recreates the register: after
    // the DB cutover a coordinated plan still leaves the legacy file alone.
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [finding("r-scoped")] as never },
    });
    expect(readJson(fixture.registerPath)).toEqual(legacyRegister);
    expect((await linkedOpenIssues(fixture, PLAN_ID)).map((issue) => issue.id)).toEqual(["I-000001"]);
  });

  test("uncoordinated kinds refuse explicitly and a plan session cannot replace a snapshot", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await ensureCoordinator(fixture);
    const harnessRoot = realpathSync(fixture.harness);

    // Kinds that keep their own writer are refused, never silently no-oped.
    for (const ref of [{ kind: "review", key: PLAN_ID } as const, { kind: "json", key: join(harnessRoot, "loose.json") } as const]) {
      expect(
        await errorCodeOf(() => replaceCoordinatedArtifact({ harnessRoot, ref, payload: {} })),
      ).toBe("coordination.scoped-writer-required");
    }

    // A coordinated snapshot is replaceable by the coordinator only: a plan
    // session is refused before the payload is even considered.
    const snapshotRef = { kind: "snapshot", key: WORKFLOW_ID } as const;
    const snapshotPath = join(harnessRoot, "workflows", WORKFLOW_ID, "snapshot.json");
    const snapshot = readJson(snapshotPath);
    const planSession = (await bindPlan(fixture, PLAN_ID)).session_file;
    for (const sessionPath of [undefined, planSession]) {
      expect(
        await errorCodeOf(() =>
          replaceCoordinatedArtifact({ harnessRoot, ref: snapshotRef, payload: snapshot, sessionPath }),
        ),
      ).toBe("coordination.session-role");
    }
  });

  test("a json alias through a symlinked parent cannot create a not-yet-existing protected file (PR241-G4)", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordination-alias-parent-"));
    try {
      // The protected ROOT exists (`workflows/`) but the leaf does not, and the
      // alias parent is a symlink onto the canonical root itself. A class
      // decision that falls back to the lexical path lets that alias land
      // outside the protected prefix and create the protected file.
      const canonical = realpathSync(root);
      mkdirSync(join(canonical, "workflows"), { recursive: true });
      symlinkSync(canonical, join(canonical, "alias"), "dir");
      const snapshotPath = join(canonical, "workflows", WORKFLOW_ID, "snapshot.json");
      const snapshotAlias = join(canonical, "alias", "workflows", WORKFLOW_ID, "snapshot.json");
      const statusAlias = join(canonical, "alias", "status.json");
      const store = createFsStore(canonical);

      await expect(store.put({ kind: "json", key: snapshotAlias, payload: { id: WORKFLOW_ID } })).rejects.toMatchObject({
        code: "coordination.direct-write-refused",
      });
      await expect(store.put({ kind: "json", key: statusAlias, payload: { version: 2 } })).rejects.toMatchObject({
        code: "coordination.direct-write-refused",
      });
      // Refuse-before-write: neither protected document nor its directory exists.
      expect(existsSync(snapshotPath)).toBe(false);
      expect(existsSync(join(canonical, "status.json"))).toBe(false);

      // Unprotected aliases still write (the walk must not over-block), and the
      // protected path itself stays writable from the authorized context.
      await store.put({ kind: "json", key: join(canonical, "alias", "notes.json"), payload: { note: "escape hatch" } });
      const notes = await store.get<Record<string, string>>({ kind: "json", key: join(canonical, "alias", "notes.json") });
      expect(notes).toEqual({ note: "escape hatch" });
      await withProtectedWrite(snapshotPath, "put", () => store.put({ kind: "json", key: snapshotAlias, payload: { id: WORKFLOW_ID } }));
      expect(existsSync(snapshotPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
/* ------------------------------------------------------------------------ *
 * Catalog execution pin (state-projection contract §1)
 * ------------------------------------------------------------------------ */

/**
 * The refusal of a call expected to hit the frozen-input pin. The pin conflict
 * is its own documented code (`catalog.execution-pin-conflict`, contract §1),
 * not a coordination-surface error, so this narrows on the stable `code` field
 * exactly as a CLI consumer does.
 */
async function pinConflictOf(run: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await run();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ...(typeof code === "string" ? { code } : {}), message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error("expected the coordination call to fail");
}

/** The plan row as stored on disk (the frozen execution input). */
function storedRow(fixture: Fixture, planId: string): Record<string, unknown> {
  const snapshot = readJson(fixture.snapshotPath) as { plans: Array<Record<string, unknown>> };
  return snapshot.plans.find((row) => row.id === planId || row.plan_id === planId)!;
}

function pinOf(row: Record<string, unknown>): CatalogExecutionPin {
  return (row.metadata as Record<string, unknown>).catalog_pin as CatalogExecutionPin;
}

describe("catalog pin — frozen prepare inputs (state-projection contract §1)", () => {
  test("catalog pin: prepare records the pin, and a later catalog move leaves the prepared execution stable", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture);
    await preparePlan(fixture, PLAN_ID);

    const row = storedRow(fixture, PLAN_ID);
    const pin = pinOf(row);
    const handle = await openStore(context, "read");
    const storeId = handle.storeId;
    handle.close();
    expect(pin.store_id).toBe(storeId);
    expect(pin.entity_revision).toBe(1);

    // The current catalog moves (a renamed title bumps the entity revision).
    await updateCatalogEntity(context, { kind: "plan", id: PLAN_ID }, { title: "Renamed" }, 1, {
      operationId: "upd-title",
      actor: "project-manager",
    });

    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect(view.catalog_pin?.pin).toEqual(pin);
    expect(view.catalog_pin?.catalog_moved).toBe(true);
    expect(view.catalog_pin?.current_revision).toBe(2);
    expect(view.catalog_pin?.conflict).toBeNull();
    // The frozen row itself never follows the catalog.
    const after = storedRow(fixture, PLAN_ID);
    expect(after.file).toBe(row.file);
    expect(pinOf(after)).toEqual(pin);
    // Execution may start on the pinned input.
    const bound = await bindPlan(fixture, PLAN_ID);
    expect(bound.outcome).toBe("claimed");
  });

  test("catalog pin: an authorized prepare records the new catalog revision, while the earlier pin stays frozen", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture, [PLAN_ID, PEER_PLAN_ID]);
    await preparePlan(fixture, PLAN_ID);
    const first = pinOf(storedRow(fixture, PLAN_ID));
    // Both plan entities move on: their revisions (the pin's selection pointer)
    // are now 2.
    await updateCatalogEntity(context, { kind: "plan", id: PLAN_ID }, { title: "Renamed" }, 1, {
      operationId: "upd-title-a",
      actor: "project-manager",
    });
    await updateCatalogEntity(context, { kind: "plan", id: PEER_PLAN_ID }, { title: "Renamed" }, 1, {
      operationId: "upd-title-b",
      actor: "project-manager",
    });

    // The authorized prepare is the pin writer: a later prepare (another plan
    // row of the same workflow) selects the CURRENT catalog revision.
    await preparePlan(fixture, PEER_PLAN_ID);
    const second = pinOf(storedRow(fixture, PEER_PLAN_ID));
    expect(second.entity_revision).toBe(2);
    expect(second.store_id).toBe(first.store_id);
    expect(second.entity_revision).not.toBe(first.entity_revision);

    // The already-prepared row keeps its own pin: a re-prepare of that row is
    // answered from the seal it already holds (already-satisfied, no write),
    // so the move cannot be applied retroactively.
    const snapshotBefore = readJson(fixture.snapshotPath);
    const again = await preparePlan(fixture, PLAN_ID);
    expect(again.outcome).toBe("already-satisfied");
    expect(pinOf(storedRow(fixture, PLAN_ID))).toEqual(first);
    // The already-satisfied re-prepare is answered from the seal: no write.
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect(view.catalog_pin?.pin).toEqual(first);
    expect(view.catalog_pin?.catalog_moved).toBe(true);
    expect(view.catalog_pin?.conflict).toBeNull();
  });

  test("catalog pin: a frozen input edited after preparation keeps its recorded pin and never blocks", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture);
    await preparePlan(fixture, PLAN_ID);
    const pinned = pinOf(storedRow(fixture, PLAN_ID));

    // A generic snapshot metadata update (NOT an authorized prepare) re-points
    // the row's document. The recorded pin is EVIDENCE of the selection the
    // authorized prepare made — not a byte seal — so a documentary/pointer edit
    // after preparation is tolerated: the reader serves the pin it recorded and
    // the execution consumer is not blocked.
    const snapshot = readJson(fixture.snapshotPath) as { plans: Array<Record<string, unknown>> };
    snapshot.plans = snapshot.plans.map((row) =>
      row.id === PLAN_ID || row.plan_id === PLAN_ID ? { ...row, file: `.mstar/plans/elsewhere.md` } : row,
    );
    writeJson(fixture.snapshotPath, snapshot);

    const bound = await bindPlan(fixture, PLAN_ID);
    expect(bound.outcome).toBe("claimed");
    // Neither side is overwritten: the row keeps its edited document and the
    // catalog keeps its own revision.
    const handle = await openStore(context, "read");
    const catalogRevision = handle.db.prepare("select catalog_revision from store_meta where id = 1").get() as {
      catalog_revision: number;
    };
    handle.close();
    expect(catalogRevision.catalog_revision).toBe(1);
    expect(pinned.entity_revision).toBe(1);

    // The view serves the recorded pin with no conflict disclosed.
    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect(view.catalog_pin?.conflict).toBeNull();
    expect(view.catalog_pin?.pin).toEqual(pinned);
  });

  test("catalog pin: progress reporting does not invalidate the pin", async () => {
    const fixture = makeFixture();
    await storeBacked(fixture);
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    const pinned = pinOf(storedRow(fixture, PLAN_ID));

    const view = await readPlanCoordination(fixture.planSession, undefined, fixture.root);
    await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      expectedRevision: view.revision,
      operation: {
        kind: "progress",
        progress: { status: "InProgress", summary: "executing", evidence_paths: [] },
      },
    });

    const after = await readPlanCoordination(fixture.planSession, undefined, fixture.root);
    expect(after.catalog_pin?.conflict).toBeNull();
    expect(after.catalog_pin?.pin).toEqual(pinned);
    expect(pinOf(storedRow(fixture, PLAN_ID))).toEqual(pinned);
  });
});

describe("catalog registration gate — prepare/bind/selection refuse a pending workflow (state-projection contract §3)", () => {
  /**
   * Reconstructs the crash state a dispatch reader must refuse: a journal row
   * for the fixture's root-visible workflow that is NOT committed. The gate
   * only reads the pending row's workflow id, so a minimal delta suffices.
   */
  async function seedPendingRegistration(fixture: Fixture, context: StoreContext, phase: "prepared" | "execution-written"): Promise<void> {
    const handle = await openStore(context, "write");
    const at = new Date().toISOString();
    handle.db
      .prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) " +
          "values ('op-pending-gate', 'gate-fixture', ?, ?, '{}', '{}', null, ?, ?)",
      )
      .run(phase, JSON.stringify({ workflow: { workflowId: WORKFLOW_ID } }), at, at);
    handle.close();
  }

  test("bind refuses a root-visible workflow whose registration is pending (prepared phase)", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture);
    await seedPendingRegistration(fixture, context, "prepared");
    const refusal = await pinConflictOf(() =>
      bindPlanSession({
        coordinator: true,
        workflowId: WORKFLOW_ID,
        harnessDir: fixture.harness,
        cwd: fixture.root,
        sessionId: FIXTURE_COORDINATOR_ID,
      }),
    );
    expect(refusal.code).toBe("catalog.registration-pending");
    // The refusal is not a repair: nothing moved.
    expect(existsSync(join(fixture.harness, "workflows", WORKFLOW_ID, "session-"))).toBe(false);
  });

  test("prepare refuses a root-visible workflow whose registration is pending (execution-written phase)", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture);
    // The coordinator binds BEFORE the pending operation exists — the gate is
    // evaluated per reader call, not amortized into a one-time check.
    await ensureCoordinator(fixture);
    await seedPendingRegistration(fixture, context, "execution-written");
    const refusal = await pinConflictOf(() => preparePlan(fixture, PLAN_ID));
    expect(refusal.code).toBe("catalog.registration-pending");
    // No prepared block was written.
    const view = readJson(fixture.snapshotPath);
    const row = (view.plans as Array<Record<string, unknown>>).find((r) => r.id === PLAN_ID)!;
    expect(row.coordination).toBeUndefined();
  });

  test("the selection view refuses the same pending workflow", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture);
    await ensureCoordinator(fixture);
    await seedPendingRegistration(fixture, context, "execution-written");
    const refusal = await pinConflictOf(() => readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root));
    expect(refusal.code).toBe("catalog.registration-pending");
  });

  test("a root-visible workflow with NO journal row keeps the pass-through", async () => {
    const fixture = makeFixture();
    await storeBacked(fixture);
    // Active store, root-visible workflow, no catalog_operations row at all:
    // prepare and bind succeed unchanged (pre-activation/registered-excluded
    // workspaces are never retro-refused).
    await preparePlan(fixture, PLAN_ID);
    const bound = await bindPlan(fixture, PLAN_ID);
    expect(bound.outcome).toBe("claimed");
  });
});
