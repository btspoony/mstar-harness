/**
 * catalog-consumers.test.ts — proof for the DB catalog consumers (state
 * projection, Task P4).
 *
 * Every case runs against the real catalog/store modules and the real
 * `node:sqlite` driver in a temporary harness root — no mocked database:
 *
 * - `catalog_pin` / `catalog.execution-pin-conflict` (contract §1): a prepared
 *   execution keeps consuming its pinned input while the current catalog moves,
 *   a frozen input edited after preparation refuses instead of silently
 *   following either side, and progress reporting never invalidates the pin.
 * - the DB completeness query that replaced the README index obligations
 *   (contract §4): README absence is not a failure, a discovered store with no
 *   catalog row is a gap, and a missing database is NOT an empty catalog.
 * - scaffold registers the `_default` project through the catalog domain
 *   boundary instead of a Markdown register.
 * - root active routing stays JSON authority: the catalog never decides which
 *   workflow is active.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  EXECUTION_PIN_CONFLICT_CODE,
  assertExecutionCatalogPin,
  executionInputHash,
  readExecutionCatalogPin,
  type CatalogExecutionPin,
} from "./coordination.js";
import { getCatalog, registerCatalogEntity, updateCatalogEntity, type CatalogOperation } from "./catalog.js";
import { assertKnowledgeCatalogCompleteness, assertIndexRows } from "./compound.js";
import { assertCatalogCompleteness, readCatalogCompleteness } from "./iteration.js";
import { scaffoldHarness } from "./path.js";
import { createFsStore, setArtifactStore } from "./store.js";
import { assertCatalogExecutionCommitted, resolveCatalogRegistrationState } from "./catalog-registration.js";
import { findRegisteredWorkflow, validateStatus } from "./status.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-catalog-consumers-"));
const WORKFLOW_ID = "wf-consumers";
const PLAN_ID = "plan-consumers";

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});
afterEach(() => {
  setArtifactStore(undefined);
});

/**
 * A fresh workspace with a real `.mstar` harness marker. The store context is
 * the workspace root, so `resolveHarnessDir` stops at the marker rung and the
 * store/catalog roots stay pinned even once a `plans/` child appears (the same
 * fixture shape the catalog authority tests use).
 */
function workspace(name: string): { root: string; harness: string; context: StoreContext } {
  const root = mkdtempSync(join(ROOT, name));
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  setArtifactStore(createFsStore(harness));
  return { root, harness, context: { harnessDir: root } };
}

/** One initialized (active) store with the harness artifact store pinned. */
async function withStore(name: string): Promise<{ root: string; harness: string; context: StoreContext }> {
  const fixture = workspace(name);
  const handle = await initializeStore(fixture.context);
  handle.close();
  return fixture;
}

/** The pin-read input for one plan row, pinned to this fixture's store context. */
function pinRead(context: StoreContext, row: unknown, planId = PLAN_ID) {
  return { harnessRoot: context.harnessDir, workflowId: WORKFLOW_ID, planId, row };
}

function op(operationId: string): CatalogOperation {
  return { operationId, actor: "project-manager" };
}

/** A plan row in the snapshot shape, with `metadata` overrides. */
function planRow(overrides: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PLAN_ID,
    plan_id: PLAN_ID,
    title: `Plan ${PLAN_ID}`,
    file: `.mstar/plans/${PLAN_ID}.md`,
    status: "Todo",
    metadata: { project_id: "proj-a", ...metadata },
    ...overrides,
  };
}

/** The pin the authorized `prepare` records for a row: the current catalog identity. */
async function pinFor(context: StoreContext, row: unknown, planId = PLAN_ID): Promise<CatalogExecutionPin> {
  const detail = await getCatalog(context, { kind: "plan", id: planId });
  const handle = await openStore(context, "read");
  try {
    return {
      store_id: handle.storeId,
      entity_revision: detail.entity.revision,
      document_hash: executionInputHash(row, planId),
      relation_hash: "0".repeat(64),
    };
  } finally {
    handle.close();
  }
}

/** The exact row shape an execution consumer reads: the pin lives in metadata. */
function pinnedRow(row: Record<string, unknown>, pin: CatalogExecutionPin, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...row,
    ...overrides,
    metadata: { ...(row.metadata as Record<string, unknown>), catalog_pin: pin },
  };
}

async function registerPlan(context: StoreContext): Promise<void> {
  await registerCatalogEntity(
    context,
    {
      kind: "plan",
      id: PLAN_ID,
      title: `Plan ${PLAN_ID}`,
      rootKind: "plans",
      relativePath: `${PLAN_ID}.md`,
    },
    op("reg-plan"),
  );
}

describe("catalog pin \u2014 a prepared execution keeps its frozen input", () => {
  test("catalog pin: a pinned row stays stable while the current catalog moves", async () => {
    const { context } = await withStore("pin-stable-");
    await registerPlan(context);
    const row = planRow();
    const pin = await pinFor(context, row);
    const read = pinRead(context, pinnedRow(row, pin));

    // The current catalog moves: descriptive metadata changes, which bumps the
    // entity revision without re-selecting anything for an in-flight plan.
    await updateCatalogEntity(context, { kind: "plan", id: PLAN_ID }, { title: "Renamed" }, 1, op("upd-title"));

    const state = await readExecutionCatalogPin(read);
    expect(state.source).toBe("row");
    expect(state.pin).toEqual(pin);
    expect(state.conflict).toBeNull();
    expect(state.catalog_moved).toBe(true);
    expect(state.current_revision).toBe(2);
    // A catalog move never blocks the execution consumer.
    await assertExecutionCatalogPin(read);
  });

  test("catalog pin: an explicit authorized re-prepare is what updates the pin", async () => {
    const { context } = await withStore("pin-reprepare-");
    await registerPlan(context);
    const row = planRow();
    const stale = await pinFor(context, row);

    await updateCatalogEntity(context, { kind: "plan", id: PLAN_ID }, { title: "Renamed" }, 1, op("upd-title"));
    // A generic snapshot/metadata update does not rebind the input: the
    // recorded pin still names the revision the execution selected.
    const unchanged = await readExecutionCatalogPin(pinRead(context, pinnedRow(row, stale)));
    expect(unchanged.pin).toEqual(stale);
    expect(unchanged.catalog_moved).toBe(true);

    // The authorized prepare re-reads the catalog and records the new revision.
    const refreshed = await pinFor(context, row);
    expect(refreshed.entity_revision).toBe(2);
    expect(refreshed.store_id).toBe(stale.store_id);
    expect(refreshed.document_hash).toBe(stale.document_hash);
    const state = await readExecutionCatalogPin(pinRead(context, pinnedRow(row, refreshed)));
    expect(state.conflict).toBeNull();
    expect(state.catalog_moved).toBe(false);
  });

  test("catalog pin: a frozen input edited after preparation refuses and leaves both sides untouched", async () => {
    const { context } = await withStore("pin-conflict-");
    await registerPlan(context);
    const row = planRow();
    const pin = await pinFor(context, row);
    const tampered = pinnedRow(row, pin, { file: `.mstar/plans/${PLAN_ID}-elsewhere.md` });
    const read = pinRead(context, tampered);

    const state = await readExecutionCatalogPin(read);
    expect(state.conflict).not.toBeNull();
    expect(state.pin).toEqual(pin);

    let code: string | undefined;
    try {
      await assertExecutionCatalogPin(read);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe(EXECUTION_PIN_CONFLICT_CODE);
    // Neither side was overwritten: the catalog row and the recorded pin hold.
    expect((await getCatalog(context, { kind: "plan", id: PLAN_ID })).entity.revision).toBe(1);
    expect((tampered.metadata as Record<string, unknown>).catalog_pin).toEqual(pin);
  });

  test("catalog pin: a plan pinned to a catalog row that no longer exists is a conflict", async () => {
    const { context } = await withStore("pin-gone-");
    await registerPlan(context);
    const row = planRow();
    const orphan = await pinFor(context, row);
    // The pin names a plan the catalog does not hold (its registration was
    // resolved elsewhere): the reader refuses instead of guessing an input.
    const state = await readExecutionCatalogPin(pinRead(context, pinnedRow({ ...row, id: "plan-unregistered" }, orphan), "plan-unregistered"));
    expect(state.conflict).not.toBeNull();
    expect(state.pin).toEqual(orphan);
  });

  test("catalog pin: progress, status and lease reporting never invalidate the frozen input hash", async () => {
    const { context } = await withStore("pin-progress-");
    await registerPlan(context);
    const row = planRow();
    const pin = await pinFor(context, row);
    const before = executionInputHash(row, PLAN_ID);

    // Execution-authority fields (contract §1) are not part of the selection.
    const progressed: Record<string, unknown> = {
      ...row,
      status: "InProgress",
      execution_lease: { holder: "session-1", worktree_path: "/tmp/wt" },
      metadata: { project_id: "proj-a", track_branches: ["feature/track-1"], catalog_pin: pin },
      coordination: { revision: 3, progress: { status: "InProgress", summary: "working", evidence_paths: [] } },
    };
    expect(executionInputHash(progressed, PLAN_ID)).toBe(before);
    const state = await readExecutionCatalogPin(pinRead(context, progressed));
    expect(state.conflict).toBeNull();
    expect(state.catalog_moved).toBe(false);
  });

  test("catalog pin: a missing database is disclosed as store-absent, never as an empty catalog", async () => {
    const { harness, context } = workspace("pin-no-store-");
    setArtifactStore(undefined);
    const pin = {
      store_id: "store-unknown",
      entity_revision: 1,
      document_hash: executionInputHash(planRow(), PLAN_ID),
      relation_hash: "0".repeat(64),
    };
    expect(harness.endsWith(".mstar")).toBe(true);
    const state = await readExecutionCatalogPin(pinRead(context, pinnedRow(planRow(), pin)));
    expect(state.store).toBe("absent");
    expect(state.source).toBe("row");
    expect(state.pin).toEqual(pin);
    expect(state.conflict).toBeNull();
    // The completeness gate, by contrast, refuses: no store is not "complete".
    const report = await readCatalogCompleteness(context);
    expect(report.ok).toBe(false);
    expect(report.gaps).toEqual([]);
    expect(report.violations.some((violation) => violation.code === "store.not-initialized")).toBe(true);
  });
});

describe("catalog discovery \u2014 the completeness query over store.db", () => {
  /**
   * Stores that exist as files only: an iteration with a compass, a plan and a
   * knowledge document — and no README index anywhere.
   */
  function writeStores(root: string): { iteration: string; plan: string; knowledge: string } {
    const harness = join(root, ".mstar");
    const iteration = "20260101-iteration-one/delivery-compass.md";
    const plan = "plan-one.md";
    const knowledge = "engineering/knowledge-one.md";
    mkdirSync(join(harness, "iterations", "20260101-iteration-one"), { recursive: true });
    mkdirSync(join(harness, "knowledge", "engineering"), { recursive: true });
    mkdirSync(join(harness, "plans"), { recursive: true });
    mkdirSync(join(harness, "projects", "_default"), { recursive: true });
    writeFileSync(join(harness, "iterations", iteration), "# compass\n");
    writeFileSync(join(harness, "plans", plan), "# plan\n");
    writeFileSync(join(harness, "knowledge", knowledge), "# knowledge\n");
    writeFileSync(join(harness, "projects", "_default", "roadmap.md"), "---\nproject_id: _default\n---\n");
    return { iteration, plan, knowledge };
  }

  test("catalog discovery: README absence is not a failure once every store is registered", async () => {
    const { root, harness, context } = await withStore("discovery-complete-");
    const stores = writeStores(root);
    await registerCatalogEntity(context, { kind: "iteration", id: "20260101-iteration-one", title: "Iteration one", rootKind: "iterations", relativePath: stores.iteration }, op("reg-iteration"));
    await registerCatalogEntity(context, { kind: "plan", id: "plan-one", title: "Plan one", rootKind: "plans", relativePath: stores.plan }, op("reg-plan"));
    await registerCatalogEntity(context, { kind: "document", id: "doc-knowledge-one", title: "Knowledge one", rootKind: "knowledge", relativePath: stores.knowledge, documentKind: "knowledge" }, op("reg-doc"));
    await registerCatalogEntity(context, { kind: "project", id: "_default", title: "Default Project", rootKind: "projects", relativePath: "_default/roadmap.md" }, op("reg-project"));

    expect(existsSync(join(harness, "iterations", "README.md"))).toBe(false);
    const report = await readCatalogCompleteness(context);
    expect(report.gaps).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.registered).toBe(4);
    expect(await assertCatalogCompleteness(context)).toEqual({ ok: true, violations: [] });
    expect(await assertKnowledgeCatalogCompleteness(context)).toEqual({ ok: true, violations: [] });
  });

  test("catalog discovery: an unregistered store is a gap, not a README row", async () => {
    const { root, context } = await withStore("discovery-gap-");
    const stores = writeStores(root);
    await registerCatalogEntity(context, { kind: "plan", id: "plan-one", title: "Plan one", rootKind: "plans", relativePath: stores.plan }, op("reg-plan"));

    const report = await readCatalogCompleteness(context);
    expect(report.ok).toBe(false);
    expect(report.gaps.map((gap) => gap.code).sort()).toEqual([
      "catalog.discovery.missing-document",
      "catalog.discovery.missing-iteration",
      "catalog.discovery.missing-project",
    ]);
    expect(report.gaps.map((gap) => `${gap.rootKind}/${gap.relativePath}`)).toContain(`knowledge/${stores.knowledge}`);
    const knowledge = await assertKnowledgeCatalogCompleteness(context);
    expect(knowledge.ok).toBe(false);
    expect(knowledge.violations.map((violation) => violation.code)).toEqual(["catalog.discovery.missing-document"]);
  });

  test("catalog discovery: the retired README index refuses instead of quietly passing", async () => {
    const { root } = await withStore("discovery-retired-");
    const gate = assertIndexRows(join(root, ".mstar", "knowledge"));
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((violation) => violation.code)).toEqual(["compound.index.retired"]);
  });
});

describe("catalog consumers \u2014 scaffold and execution routing boundaries", () => {
  test("catalog discovery: scaffold registers the project through the domain boundary, idempotently", async () => {
    const root = mkdtempSync(join(ROOT, "scaffold-catalog-"));
    const harness = join(root, ".mstar");
    const context: StoreContext = { harnessDir: root };
    mkdirSync(harness, { recursive: true });
    setArtifactStore(createFsStore(harness));
    const handle = await initializeStore(context);
    handle.close();

    expect(await scaffoldHarness(root)).toBe(harness);
    const created = await getCatalog(context, { kind: "project", id: "_default" });
    expect(created.entity.relativePath).toBe("_default/roadmap.md");
    expect(created.entity.revision).toBe(1);
    // Re-running the scaffold attaches to the same row: no duplicate register.
    await scaffoldHarness(root);
    expect((await getCatalog(context, { kind: "project", id: "_default" })).entity.revision).toBe(1);
    expect((await readCatalogCompleteness(context, ["projects"])).gaps).toEqual([]);
  });

  test("catalog discovery: scaffold leaves catalog registration to the store lifecycle when no store exists", async () => {
    const root = mkdtempSync(join(ROOT, "scaffold-no-store-"));
    setArtifactStore(createFsStore(join(root, ".mstar")));
    const harness = await scaffoldHarness(root);
    // The files are scaffolded; the catalog is not this verb's precondition,
    // and its absence is never reported as an empty catalog.
    expect(existsSync(join(harness, "projects", "_default", "roadmap.md"))).toBe(true);
    const report = await readCatalogCompleteness({ harnessDir: root }, ["projects"]);
    expect(report.ok).toBe(false);
    expect(report.violations.some((violation) => violation.code === "store.not-initialized")).toBe(true);
  });

  test("catalog discovery: root active routing is still JSON authority, not a catalog read", async () => {
    const { harness } = await withStore("routing-json-");
    const context: StoreContext = { harnessDir: harness };
    // status.json registers the workflow; the catalog holds NO row for it.
    writeFileSync(
      join(harness, "status.json"),
      `${JSON.stringify(
        {
          version: 2,
          updated_at: "2026-09-18",
          workflows: [
            { id: WORKFLOW_ID, type: "iteration", started_at: "2026-09-18T00:00:00Z", dir: `workflows/${WORKFLOW_ID}` },
          ],
        },
        null,
        2,
      )}\n`,
    );
    expect(findRegisteredWorkflow(harness, WORKFLOW_ID)?.id).toBe(WORKFLOW_ID);
    const state = await resolveCatalogRegistrationState(context, WORKFLOW_ID);
    expect(state.rootVisible).toBe(true);
    expect(state.binding).toBeNull();
    // A root-visible workflow with no journal operation is not retro-refused.
    await assertCatalogExecutionCommitted(context, WORKFLOW_ID);
    // The root document is validated as JSON, and an invalid root is a JSON
    // verdict — routing never falls back to a catalog lookup.
    expect(validateStatus(JSON.parse(readFileSync(join(harness, "status.json"), "utf8"))).ok).toBe(true);
    const invalid = validateStatus({
      version: 2,
      updated_at: "2026-09-18",
      workflows: [{ id: "", type: "iteration", started_at: "", dir: "" }],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.violations.map((violation) => violation.code)).toContain("status.workflow.invalid-id");
  });
});
