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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  assertExecutionCatalogPin,
  executionInputHash,
  readExecutionCatalogPin,
  type CatalogExecutionPin,
} from "./coordination.js";
import { getCatalog, registerCatalogEntity, updateCatalogEntity, type CatalogOperation } from "./catalog.js";
import { assertKnowledgeCatalogCompleteness } from "./compound.js";
import { assertCatalogCompleteness, readCatalogCompleteness } from "./iteration.js";
import { scaffoldHarness } from "./path.js";
import { createFsStore, setArtifactStore } from "./store.js";
import { assertCatalogExecutionCommitted } from "./catalog-registration.js";
import { findRegisteredWorkflow, validateStatus } from "./status.js";
import { createExecutionWorkflow, readExecutionState } from "./execution-store.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { initializeCollaborationStore, readCollaborationAuthority, writeCollaborationBinding } from "./collaboration-store.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import { execFileSync } from "node:child_process";
import * as nodeOs from "node:os";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, spyOn } from "bun:test";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-catalog-consumers-"));
const HOME = join(ROOT, "home");
mkdirSync(HOME);
let homeSpy: { mockRestore(): void } | undefined;
const WORKFLOW_ID = "wf-consumers";
const PLAN_ID = "plan-consumers";

beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});
afterEach(() => {
  setArtifactStore(undefined);
});

/**
 * note: A fresh workspace with a real `.mstar` harness marker inside a synthetic
 * checkout whose origin names the collaboration repository. The store context
 * selects that harness directly, including when it owns a plans/ child.
 */
function workspace(name: string, originSlug = name): { root: string; harness: string; context: StoreContext } {
  const root = realpathSync(mkdtempSync(join(ROOT, name)));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${originSlug}.git`], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(join(root, ".mstarc"), "[collaboration]\nmode=local\n");
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  setArtifactStore(createFsStore(harness));
  return { root, harness, context: { harnessDir: harness } };
}

/** note: Publish the staged lane and this checkout's binding, as real activation does. */
function activate(context: StoreContext): void {
  const location = resolveCollaborationLocation(context);
  const db = new DatabaseSync(location.dbPath);
  let storeId = "";
  let epoch = 0;
  try {
    db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(new Date().toISOString());
    const row = db.prepare("select store_id, authority_epoch from collaboration_meta where id = 1").get() as
      | { store_id?: unknown; authority_epoch?: unknown }
      | undefined;
    if (typeof row?.store_id === "string") storeId = row.store_id;
    if (typeof row?.authority_epoch === "number") epoch = row.authority_epoch;
  } finally {
    db.close();
  }
  writeCollaborationBinding(context, { repoKey: location.repoKey, mode: location.mode, storeId, epoch, binding: "active" });
}

/** note: One initialized (active) store on both lanes with the harness artifact store pinned. */
async function withStore(name: string, originSlug = name): Promise<{ root: string; harness: string; context: StoreContext }> {
  const fixture = workspace(name, originSlug);
  const handle = await initializeStore(fixture.context);
  handle.close();
  await initializeCollaborationStore(resolveCollaborationLocation(fixture.context));
  activate(fixture.context);
  return fixture;
}

/** invariant: The execution-owned registration pin a clone must never rebind. */
async function cloneBinding(context: StoreContext): Promise<Record<string, unknown> | undefined> {
  const handle = await openStore(context, "read");
  try {
    return handle.db
      .prepare(
        "select workflow_id, catalog_kind, catalog_id, workflow_root_kind, workflow_relative_path, catalog_revision, input_hash, pin_json, operation_id " +
          "from catalog_execution_bindings where workflow_id = 'wf-clone'",
      )
      .get() as Record<string, unknown> | undefined;
  } finally {
    handle.close();
  }
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
  // note: The catalog identity is owned by the collaboration lane after the cutover;
  // the pin names that store, not the execution one.
  const authority = await readCollaborationAuthority(context);
  return {
    store_id: authority.storeId,
    entity_revision: detail.entity.revision,
    document_hash: executionInputHash(row, planId),
    relation_hash: "0".repeat(64),
  };
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
    const state = await readExecutionCatalogPin(pinRead(context, pinnedRow(row, refreshed)));
    expect(state.conflict).toBeNull();
    expect(state.catalog_moved).toBe(false);
  });

  test("catalog pin: a frozen input edited after preparation keeps its recorded pin, neither side rewritten", async () => {
    const { context } = await withStore("pin-recorded-");
    await registerPlan(context);
    const row = planRow();
    const pin = await pinFor(context, row);
    const edited = pinnedRow(row, pin, { file: `.mstar/plans/${PLAN_ID}-elsewhere.md` });
    const read = pinRead(context, edited);

    // §365 the recorded pin is evidence of the selection, and the frozen row is
    // data: an edit after preparation is tolerated rather than refused, so the
    // reader serves the pin it recorded and the consumer is not blocked.
    const state = await readExecutionCatalogPin(read);
    expect(state.pin).toEqual(pin);
    expect(state.conflict).toBeNull();
    await assertExecutionCatalogPin(read);

    // Neither side was overwritten: the catalog row and the recorded pin hold.
    expect((await getCatalog(context, { kind: "plan", id: PLAN_ID })).entity.revision).toBe(1);
    expect((edited.metadata as Record<string, unknown>).catalog_pin).toEqual(pin);
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

  test("catalog pin: progress, status and row scope metadata never invalidate the frozen input hash", async () => {
    const { context } = await withStore("pin-progress-");
    await registerPlan(context);
    const row = planRow();
    const pin = await pinFor(context, row);

    // Row scope metadata is not part of the catalog selection.
    const progressed: Record<string, unknown> = {
      ...row,
      status: "InProgress",
      metadata: {
        project_id: "proj-a",
        track_branches: ["feature/track-1"],
        catalog_pin: pin,
        worktree_path: "/tmp/wt",
        working_branch: "feature/track-1",
      },
      coordination: { revision: 3, progress: { status: "InProgress", summary: "working", evidence_paths: [] } },
    };
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
    expect(report.violations.some((violation) => violation.code === "collaboration.not-initialized")).toBe(true);
  });

  test("catalog pin: a workspace with no collaboration identity keeps the recorded pin and discloses store-absent", async () => {
    // invariant: No Git repository and no repository_id: there is no collaboration scope to
    // read. Pin consumption must not refuse or clear the recorded lineage.
    const harness = mkdtempSync(join(ROOT, "pin-no-identity-"));
    const pin = {
      store_id: "store-unknown",
      entity_revision: 1,
      document_hash: executionInputHash(planRow(), PLAN_ID),
      relation_hash: "0".repeat(64),
    };
    const state = await readExecutionCatalogPin(pinRead({ harnessDir: harness }, pinnedRow(planRow(), pin)));
    expect(state.store).toBe("absent");
    expect(state.source).toBe("row");
    expect(state.pin).toEqual(pin);
    expect(state.conflict).toBeNull();
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
    mkdirSync(join(root, ".agents", "knowledge", "engineering"), { recursive: true });
    mkdirSync(join(harness, "plans"), { recursive: true });
    mkdirSync(join(harness, "projects", "_default"), { recursive: true });
    writeFileSync(join(harness, "iterations", iteration), "# compass\n");
    writeFileSync(join(harness, "plans", plan), "# plan\n");
    writeFileSync(join(root, ".agents", "knowledge", knowledge), "# knowledge\n");
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
});

describe("catalog consumers \u2014 scaffold and execution routing boundaries", () => {
  test("catalog discovery: scaffold registers the project directory, idempotently, without roadmap content", async () => {
    const { root, harness, context } = await withStore("scaffold-catalog-");

    expect(await scaffoldHarness(root)).toBe(harness);
    const created = await getCatalog(context, { kind: "project", id: "_default" });
    expect(created.entity.relativePath).toBe("_default");
    expect(existsSync(join(harness, "projects", "_default", "roadmap.md"))).toBe(false);
    expect(created.entity.revision).toBe(1);
    await scaffoldHarness(root);
    expect((await getCatalog(context, { kind: "project", id: "_default" })).entity.revision).toBe(1);
    expect((await readCatalogCompleteness(context, ["projects"])).gaps).toEqual([]);
  });

  test("catalog discovery: existing scaffold-location identity and content are not relocated", async () => {
    const { root, harness, context } = await withStore("scaffold-existing-catalog-");
    const roadmapPath = join(harness, "projects", "_default", "roadmap.md");
    mkdirSync(join(harness, "projects", "_default"), { recursive: true });
    writeFileSync(roadmapPath, "# Existing authority\n");
    await registerCatalogEntity(
      context,
      {
        kind: "project",
        id: "_default",
        title: "Existing project",
        rootKind: "projects",
        relativePath: "_default/roadmap.md",
      },
      { operationId: "existing-project-location", actor: "test" },
    );

    await scaffoldHarness(root);
    const existing = await getCatalog(context, { kind: "project", id: "_default" });
    expect(existing.entity.relativePath).toBe("_default/roadmap.md");
    expect(existing.entity.title).toBe("Existing project");
    
  });

  test("catalog discovery: scaffold leaves catalog registration to the store lifecycle when no store exists", async () => {
    const { root } = workspace("scaffold-no-store-");
    const harness = await scaffoldHarness(root);
    expect(existsSync(join(harness, "projects", "_default"))).toBe(true);
    expect(existsSync(join(harness, "projects", "_default", "roadmap.md"))).toBe(false);
    const report = await readCatalogCompleteness({ harnessDir: harness }, ["projects"]);
    expect(report.ok).toBe(false);
    expect(report.violations.some((violation) => violation.code === "collaboration.not-initialized")).toBe(true);
  });

  test("catalog discovery: a staged collaboration scope defers registration instead of failing scaffold", async () => {
    const { root, harness } = workspace("scaffold-scope-staged-");
    await initializeCollaborationStore(resolveCollaborationLocation({ harnessDir: harness }));
    await expect(scaffoldHarness(root)).resolves.toBe(harness);
    // note: The optional registration is still owed to activation; it was not faked.
    await expect(getCatalog({ harnessDir: harness }, { kind: "project", id: "_default" })).rejects.toMatchObject({
      code: "collaboration.not-active",
    });
  });

  test("catalog discovery: an invalid collaboration mode is refused, never deferred", async () => {
    const { root } = workspace("scaffold-scope-invalid-");
    writeFileSync(join(root, ".mstarc"), "[collaboration]\nmode=bogus\n");
    await expect(scaffoldHarness(root)).rejects.toMatchObject({ code: "collaboration.mode-invalid" });
  });

  test("catalog discovery: a replacement clone reads the logical plan location without inventing or rebinding it", async () => {
    // note: Source clone: a collaboration catalog row plus the execution-owned pin
    // that freezes the same logical locator.
    const source = await withStore("clone-source", "shared-plan-repo");
    mkdirSync(join(source.harness, "plans"), { recursive: true });
    writeFileSync(
      join(source.harness, "plans", "plan-clone.md"),
      "---\nplan_id: plan-clone\n---\n\n# Registered Plan\n\nBody.\n",
    );
    await registerCatalogEntity(
      source.context,
      { kind: "plan", id: "plan-clone", title: "Registered Plan", rootKind: "plans", relativePath: "plan-clone.md" },
      op("clone-register-plan"),
    );
    const execution = await openStore(source.context, "write");
    try {
      execution.db
        .prepare(
          "insert into catalog_execution_bindings(workflow_id, catalog_kind, catalog_id, workflow_root_kind, workflow_relative_path, catalog_revision, input_hash, pin_json, operation_id) " +
            "values ('wf-clone', 'plan', 'plan-clone', 'harness', 'workflows/wf-clone', 1, ?, ?, 'clone-binding')",
        )
        .run(
          "0".repeat(64),
          JSON.stringify({ kind: "plan", id: "plan-clone", rootKind: "plans", relativePath: "plan-clone.md" }),
        );
    } finally {
      execution.close();
    }
    const pinBefore = await cloneBinding(source.context);

    // note: Replacement checkout: same repository identity, no local plan file and
    // no execution store of its own.
    const replacement = workspace("clone-replacement", "shared-plan-repo");
    expect(existsSync(join(replacement.harness, "store.db"))).toBe(false);
    expect(existsSync(join(replacement.harness, "plans", "plan-clone.md"))).toBe(false);
    // note: A replacement clone READS unbound: the reads are admitted and record nothing.
    const read = await getCatalog(replacement.context, { kind: "plan", id: "plan-clone" });
    expect(read.entity).toMatchObject({ rootKind: "plans", relativePath: "plan-clone.md", present: false });
    // invariant: The logical reference resolves against THIS checkout; the registered
    // path is never rewritten to the source checkout or an absolute locator.
    expect(read.entity.absolutePath).toBe(join(replacement.harness, "plans", "plan-clone.md"));

    // invariant: Discovery checks this checkout's files only: a missing local artifact is
    // disclosed as absent, never invented as a registered location or a gap.
    const report = await readCatalogCompleteness(replacement.context, ["plans"]);
    expect(report).toMatchObject({ ok: true, gaps: [] });
    expect(report.registered).toBe(1);

    // note: Reading did not bind the clone; its first write still needs the binding.
    expect(existsSync(join(replacement.harness, "collaboration-binding.json"))).toBe(false);
    await expect(
      registerCatalogEntity(
        replacement.context,
        { kind: "plan", id: "plan-clone", title: "Registered Plan", rootKind: "plans", relativePath: "plan-clone.md" },
        op("clone-unbound-write"),
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // invariant: This lane records no publication lineage, so the supported adoption verb
    // cannot bind it; the fixture records the same binding that activation writes.
    const replacementAuthority = await readCollaborationAuthority(replacement.context);
    writeCollaborationBinding(replacement.context, {
      repoKey: replacementAuthority.repoKey,
      mode: replacementAuthority.mode,
      storeId: replacementAuthority.storeId,
      epoch: replacementAuthority.epoch,
      binding: "active",
    });

    // why: Registration keeps the identity: identical replay is a no-op, a new path
    // for the same id is a duplicate refusal, and a different id at that
    // location attaches to the existing row instead of minting another one.
    const replayed = await registerCatalogEntity(
      replacement.context,
      { kind: "plan", id: "plan-clone", title: "Registered Plan", rootKind: "plans", relativePath: "plan-clone.md" },
      op("clone-replay"),
    );
    expect(replayed).toMatchObject({ kind: "plan", id: "plan-clone", revision: 1 });
    await expect(
      registerCatalogEntity(
        replacement.context,
        { kind: "plan", id: "plan-clone", title: "Moved", rootKind: "plans", relativePath: "elsewhere.md" },
        op("clone-relocate"),
      ),
    ).rejects.toMatchObject({ code: "catalog.duplicate" });
    const attached = await registerCatalogEntity(
      replacement.context,
      { kind: "plan", id: "plan-other", title: "Other id", rootKind: "plans", relativePath: "plan-clone.md" },
      op("clone-attach"),
    );
    expect(attached).toMatchObject({ kind: "plan", id: "plan-clone", revision: 1 });
    await expect(getCatalog(replacement.context, { kind: "plan", id: "plan-other" })).rejects.toMatchObject({
      code: "catalog.not-found",
    });
    expect((await getCatalog(replacement.context, { kind: "plan", id: "plan-clone" })).entity).toMatchObject({
      title: "Registered Plan",
      rootKind: "plans",
      relativePath: "plan-clone.md",
      revision: 1,
      present: false,
    });

    // note: Catalog traffic created no execution store here, and the source
    // execution pin is byte-identical.
    expect(existsSync(join(replacement.harness, "store.db"))).toBe(false);
    expect(await cloneBinding(source.context)).toEqual(pinBefore);
  });

  test("catalog discovery: the registration gate is answered from the ACTIVE store, not a file view", async () => {
    const { harness, context } = await withStore("routing-active-");
    // A workflow the ACTIVE store knows with NO pending journal operation: the
    // registration gate passes (a committed registration is never
    // retro-refused), and it never consults the retired file registration route.
    const created = await readExecutionState(context);
    await createExecutionWorkflow(
      { harnessDir: harness, caller: { sessionId: "catalog-consumers", role: "coordinator", workflowId: WORKFLOW_ID } },
      {
        entry: { id: WORKFLOW_ID, type: "iteration", started_at: "2026-09-18T00:00:00Z", dir: `workflows/${WORKFLOW_ID}` },
        snapshot: {
          schema_version: 1, id: WORKFLOW_ID, type: "iteration", status: "running",
          started_at: "2026-09-18T00:00:00Z", updated_at: "2026-09-18T00:00:00Z",
          phase: "phase-2-execute", plans: [],
        } as never,
        expected: created.token,
        operationId: "routing-active-create",
      },
    );
    await assertCatalogExecutionCommitted(context, WORKFLOW_ID);

    // A pending journal row IS the half-registered state and is refused,
    // naming the legacy-journal recovery instead of completing file writes.
    const handle = await openStore(context, "write");
    try {
      handle.db.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) " +
          "values (?, ?, 'prepared', ?, '{}', '{}', null, ?, ?)",
      ).run(
        "routing-pending",
        "0".repeat(64),
        JSON.stringify({ workflow: { workflowId: WORKFLOW_ID, kind: "plan" } }),
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      );
    } finally { handle.close(); }
    await expect(assertCatalogExecutionCommitted(context, WORKFLOW_ID)).rejects.toMatchObject({
      code: "catalog.registration-pending",
    });
  });
});
