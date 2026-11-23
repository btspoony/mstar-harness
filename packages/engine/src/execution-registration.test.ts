/**
 * execution-registration.test.ts — proof for the ACTIVE registration route
 * (primary spec §7). Run with
 * `bun test packages/engine/src/execution-registration.test.ts --test-name-pattern 'execution-registration|execution-catalog-pin'`.
 *
 * Every case runs the REAL modules against a REAL `node:sqlite` store in a
 * per-test temporary control root: `commitExecutionRegistration` itself, the C3
 * creation writer it composes, the catalog domain verbs, the DB `prepare`
 * transition, the migration preview and the legacy journal's own tables. No
 * mock database and no fixture-written success: the "injected failure" is a REAL
 * catalog domain refusal raised in the middle of the transaction, and the pin
 * cases read the rows the real verbs wrote.
 *
 * Acceptance criteria carried by these cases:
 *
 * - `execution-registration-commits-*`: one transaction publishes the reviewed
 *   catalog delta, the workflow/plan/input/registry rows and the committed
 *   receipt, and writes NO JSON registration file and no `prepared` phase.
 * - `execution-registration-rolls-back-*`: a refusal inside the transaction
 *   commits neither the catalog nor the workflow — no row, no revision, no
 *   binding, no receipt.
 * - `execution-registration-replays-*` / `-refuses-a-stale-*`: an exact retry is
 *   stable and writes nothing; an operation-id collision, a stale root token and
 *   a stale catalog revision each refuse.
 * - `execution-registration-refuses-a-legacy-pending-*`: ACTIVE registration
 *   refuses prepared legacy journal rows; recovery is abort/purge, never adoption.
 * - `execution-registration-blocks-migration-*` / `-refuses-an-imported-pin-*`:
 *   legacy pending journals and incoherent imported pins remain guarded.
 * - Registration-created catalog revision pins remain in authoritative
 *   row/store state alongside the committed operation receipt.
 * - `registration recovery` / `semantic replay` / `interrupted registration`
 *   (E06b): the sparse intent resolves the omitted plan identity/title from the
 *   selected document, an iteration registered without a phase carries the
 *   derived Prepare, a retry that re-read the store replays the recorded receipt
 *   (while a different intent still conflicts), an authority epoch change is
 *   re-resolved instead of replayed stale, and an interruption at either side of
 *   the commit boundary converges on exactly one registration.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getCatalog, listCatalog, registerCatalogEntity, updateCatalogEntity, type CatalogLinkInput } from "./catalog.js";
import {
  abandonRemoteIntent,
  bindRemoteAuthority,
  ingestRemoteObservation,
  prepareRemoteResolution,
  readRemoteIntent,
} from "./collaboration-remote.js";
import { initializeCollaborationStore, writeCollaborationBinding } from "./collaboration-store.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import {
  completeSnapshot,
  conflictFrozenIntent,
  confirmFrozenIntent,
  createRemoteScope,
  positiveCheck,
  REMOTE_IDS,
  submission,
} from "./remote-scope.fixture.js";
import {
  listPendingCatalogRegistrations,
  type CatalogExecutionReceipt,
  type CatalogExecutionRequest,
} from "./catalog-registration.js";
import { readExecutionAuthority } from "./execution-read.js";
import { commitExecutionRegistration, registerShippedCatalogExecution, setRegistrationJournalGapForTest } from "./execution-registration.js";
import {
  bindExecutionSession,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionSessionRef,
  type ExecutionState,
  type ExecutionToken,
} from "./execution-store.js";
import * as engineIndex from "./index.js";
import { initializeStore, openStore, tableNamesOn, type StoreContext } from "./store-db.js";
import { derivePlanRegistration, PREPARE_PHASE, WORKFLOW_SNAPSHOT_FILE, type RegisterIterationWorkflowOptions, type RegisterPlanWorkflowOptions } from "./workflow.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-registration-"));
/**
 * why: Every case ran against one combined store before the cutover; a registration
 * now publishes into the repository's user-level collaboration lane, so the
 * suite pins `homedir` to a temporary home (a real spy on the live module
 * binding) and gives each fixture workspace its own checkout identity.
 */
const HOME = join(ROOT, "home");
let homeSpy: { mockRestore: () => void };
beforeAll(() => {
  mkdirSync(HOME, { recursive: true });
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});
afterAll(() => {
  homeSpy.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * why: The checkout identity and ACTIVE collaboration lane one fixture workspace
 * owns: a real Git checkout with an explicit `repo_id`, so the lane path is
 * deterministic and private, and the staged record flipped to active (this
 * release ships no public activator).
 */
async function collaborationLane(workspace: string): Promise<void> {
  execFileSync("git", ["init", "-q"], { cwd: workspace, stdio: "ignore" });
  // why: One lane per fixture workspace: the repo id is the workspace basename, a
  // safe identifier because every fixture name is a lower-case slug.
  const repoId = workspace.split("/").pop()!.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  writeFileSync(join(workspace, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=${repoId.replace(/^[^a-z0-9]/, "x")}\n`);
  const context: StoreContext = { harnessDir: join(workspace, ".mstar") };
  const location = resolveCollaborationLocation(context);
  await initializeCollaborationStore(location);
  const db = new DatabaseSync(location.dbPath);
  let storeId = "";
  let epoch = 0;
  try {
    db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(
      new Date().toISOString(),
    );
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

const TS = "2026-09-21T00:00:00.000Z";
const ROOT_UPDATED_AT = "2026-09-21";
const WORKFLOW_ID = "wf-registration-1";
const WORKFLOW_ID_ALT = "wf-registration-2";
const WORKFLOW_ID_THIRD = "wf-registration-3";
const PLAN_ID = "20260920-registration-plan";
const SIDE_PLAN_ID = "20260920-registration-side-plan";
const PLAN_TITLE = "Consumer surfaces catalog plan";
const COORDINATOR_ID = "host-registration-coordinator";

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

type Fixture = {
  /** The workspace root the store context resolves its control harness from. */
  workspace: string;
  /** The control harness itself (`.mstar`), where a real workspace keeps it. */
  harnessRoot: string;
  context: StoreContext;
  storeId: string;
  /** The root token the empty-execution initializer minted: this registration's CAS. */
  rootToken: ExecutionToken;
  caller: ExecutionCaller;
};

/**
 * An ACTIVE, empty execution authority. The context selects the workspace's
 * .mstar harness directly, including when its own plans/ child appears.
 */
async function activeFixture(label: string): Promise<Fixture> {
  const workspace = mkdtempSync(join(ROOT, `${label}-`));
  const harnessRoot = join(workspace, ".mstar");
  mkdirSync(harnessRoot, { recursive: true });
  const context: StoreContext = { harnessDir: harnessRoot };
  const store = await initializeStore(context);
  store.close();
  await collaborationLane(workspace);
  const initialized = await readExecutionState(context);
  return {
    workspace,
    harnessRoot: realpathSync(harnessRoot),
    context,
    storeId: initialized.storeId,
    rootToken: initialized.token,
    caller: { sessionId: COORDINATOR_ID, role: "coordinator", workflowId: WORKFLOW_ID },
  };
}


/**
 * The §4 registered plan document a reviewed registration selects: its
 * `plan_id` header is the identity authority the resolver proves, and its first
 * heading is the title authority the declared title must state.
 */
function writePlanDocument(harnessDir: string, planId: string, title: string): void {
  const file = join(harnessDir, "plans", `${planId}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# ${title}\n\n**plan_id:** ${planId}\n`);
}

/**
 * The reviewed delivery compass a registration is proven against: the full
 * mstar-iteration §1.3 field set, declared for THIS iteration. Registration
 * refuses a pointer that names anything else, so every fixture that registers
 * an iteration states one.
 */
function writeReviewedCompass(harnessDir: string, iterationId: string, relativePath = "delivery-compass.md"): string {
  const file = join(harnessDir, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    "---\n" +
      `iteration_id: ${iterationId}\n` +
      "start_date: 2026-09-21\n" +
      "status: active\n" +
      "iteration_base_branch: main\n" +
      "target_branch: main\n" +
      "---\n\n" +
      `# ${iterationId}\n`,
  );
  return relativePath;
}

/**
 * One plan registration request, and the narrowed form the fixture builds: the
 * plan producer call with its own options type, so a case that re-spells the
 * sparse `plan` input does not have to re-prove the union member at every use.
 */
type PlanExecutionRequest = Omit<CatalogExecutionRequest, "workflow"> & {
  workflow: { kind: "plan"; workflowId: string; options: RegisterPlanWorkflowOptions };
};

/** One plan registration request, exactly as a reviewed caller supplies it. */
function planRequest(options: {
  context: StoreContext;
  operationId: string;
  /** Defaults to 0: a fresh store's catalog revision, where every case starts. */
  expectedCatalogRevision?: number;
  workflowId?: string;
  planId?: string;
  title?: string;
  file?: string;
  entities?: CatalogExecutionRequest["delta"]["entities"];
  /** The reviewed relations, registered after every entity of the delta exists. */
  links?: CatalogLinkInput[];
  bindingId?: string;
  /** Omit the producer's `startedAt` so the snapshot's clock is the call's own. */
  omitStartedAt?: boolean;
}): PlanExecutionRequest {
  const workflowId = options.workflowId ?? WORKFLOW_ID;
  const planId = options.planId ?? PLAN_ID;
  const title = options.title ?? PLAN_TITLE;
  // The catalog entity's location is plans-root-relative; the SELECTED document
  // is the harness-relative registered plan pointer the §4 resolver proves. One
  // document, two declared forms — so the fixture writes the document its
  // reviewed request registers.
  const relativePath = options.file ?? `${planId}.md`;
  const bindingId = options.bindingId ?? planId;
  writePlanDocument(options.context.harnessDir, planId, title);
  return {
    operationId: options.operationId,
    actor: "project-manager",
    expectedCatalogRevision: options.expectedCatalogRevision ?? 0,
    workflow: {
      kind: "plan",
      workflowId,
      options: {
        harnessDir: options.context.harnessDir,
        plan: { id: planId, title, file: `plans/${relativePath}` },
        deliveryKind: "development",
        branchWork: `feature/${workflowId}`,
        branchTarget: "main",
        project: "_default",
        ...(options.omitStartedAt === true ? {} : { startedAt: TS }),
      },
    },
    delta: {
      entities: options.entities ?? [{ kind: "plan", id: planId, title, rootKind: "plans", relativePath }],
      ...(options.links === undefined ? {} : { links: options.links }),
      binding: { catalogKind: "plan", catalogId: bindingId },
    },
  };
}

/** One iteration registration request, built exactly as the reviewed producer supplies it. */
type IterationExecutionRequest = Omit<CatalogExecutionRequest, "workflow"> & {
  workflow: { kind: "iteration"; workflowId: string; options: RegisterIterationWorkflowOptions };
};

function iterationRequest(fixture: Fixture, iterationId: string, operationId: string): IterationExecutionRequest {
  const row = { id: `${iterationId}-plan`, title: "Iteration row", file: `plans/${iterationId}-plan.md` };
  writePlanDocument(fixture.context.harnessDir, row.id, row.title);
  return {
    operationId,
    actor: "project-manager",
    expectedCatalogRevision: 0,
    workflow: {
      kind: "iteration",
      workflowId: iterationId,
      options: {
        harnessDir: fixture.context.harnessDir,
        compassRef: "delivery-compass.md",
        branch: { base: "main", integration: `iteration/${iterationId}`, target: "main" },
        rows: [row],
      },
    },
    delta: {
      entities: [
        { kind: "iteration", id: iterationId, title: iterationId, rootKind: "iterations", relativePath: iterationId },
        // C2: the reviewed delta carries the iteration's plan rows as catalog
        // plan entities with one `plan belongs-to iteration` link each — the
        // same derivation the shipped producer composes, so the two seams stay
        // one semantic request.
        { kind: "plan", id: row.id, title: row.title, rootKind: "plans", relativePath: `${row.id}.md` },
      ],
      links: [{ from: { kind: "plan", id: row.id }, relation: "belongs-to", to: { kind: "iteration", id: iterationId } }],
      binding: { catalogKind: "iteration", catalogId: iterationId },
    },
  };
}

/** Register one plan workflow through the verb under test. */
async function registerPlanWorkflow(fixture: Fixture, operationId: string, planId = PLAN_ID, workflowId = WORKFLOW_ID) {
  return await commitExecutionRegistration(
    { ...fixture.context, caller: { ...fixture.caller, workflowId } },
    { ...planRequest({ context: fixture.context, operationId, workflowId, planId }), expected: fixture.rootToken },
  );
}

/* ------------------------------------------------------------------------ *
 * Raw store reads: the accepted state, as one comparable value
 * ------------------------------------------------------------------------ */

async function one<T>(context: StoreContext, sql: string, ...params: Array<string | number | null>): Promise<T | undefined> {
  const handle = await openStore(context, "read");
  try {
    return handle.db.prepare(sql).get(...params) as T | undefined;
  } finally {
    handle.close();
  }
}

/** Write one fixture row the legacy journal would own, on a real handle. */
async function fixtureWrite(context: StoreContext, sql: string, ...params: Array<string | number | null>): Promise<void> {
  const handle = await openStore(context, "write");
  try {
    handle.db.prepare(sql).run(...params);
  } finally {
    handle.close();
  }
}

/** note: Read rows from this fixture's own collaboration lane (the catalog's source). */
function collaborationRows<T>(context: StoreContext, sql: string, ...params: Array<string | number>): T[] {
  const db = new DatabaseSync(resolveCollaborationLocation(context).dbPath);
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** note: The catalog revision a reviewed registration CASes against: the lane's own. */
function catalogRevisionOf(context: StoreContext): number {
  const [row] = collaborationRows<{ catalog_revision: number }>(
    context,
    "select catalog_revision from collaboration_meta where id = 1",
  );
  return row!.catalog_revision;
}

/**
 * Everything a registration may touch, as one comparable value: the three
 * revisions, the execution rows it creates, the catalog rows it publishes and
 * the journal's in-flight count.
 */
async function footprint(context: StoreContext): Promise<Record<string, unknown>> {
  // note: A post-fence source no longer carries the journal table, so its pending count
  // is answered by the lane's own copy below instead of an unnameable subquery.
  const executionHandle = await openStore(context, "read");
  const journalOnExecution = tableNamesOn(executionHandle.db).has("catalog_operations");
  executionHandle.close();
  const execution =
    (await one<Record<string, unknown>>(
      context,
      "select (select revision from execution_meta where id = 1) as root_revision, " +
        "(select revision from store_meta where id = 1) as store_revision, " +
        "(select count(*) from execution_workflows) as workflows, " +
        "(select count(*) from execution_registry) as registry, " +
        "(select count(*) from execution_plans) as plans, " +
        "(select count(*) from execution_inputs) as inputs, " +
        "(select count(*) from execution_operations) as operations, " +
        "(select count(*) from catalog_execution_bindings) as bindings" +
        (journalOnExecution
          ? ", (select count(*) from catalog_operations where phase in ('prepared','execution-written')) as pending"
          : ""),
    )) ?? {};
  // why: The catalog and the collaboration revision live in the repository's own
  // lane; the execution store keeps only the binding and the legacy journal.
  const location = resolveCollaborationLocation(context);
  const db = new DatabaseSync(location.dbPath);
  try {
    return {
      ...execution,
      ...(db
        .prepare(
          "select revision as collaboration_revision, catalog_revision, " +
            "(select count(*) from catalog_entities) as entities, " +
            "(select count(*) from catalog_links) as links, " +
            "(select count(*) from collaboration_operations where key_space = 'composite') as effects, " +
            (journalOnExecution
              ? "0 as lane_pending"
              : "(select count(*) from catalog_operations where phase in ('prepared','execution-written')) as lane_pending") +
            " from collaboration_meta where id = 1",
        )
        .get() as Record<string, unknown>),
    };
  } finally {
    db.close();
  }
}

/** The sealed frozen input of one plan row, exactly as `execution_inputs` holds it. */
async function sealedInput(context: StoreContext, planId: string, workflowId = WORKFLOW_ID) {
  return await one<{ revision: number; input_json: string; input_hash: string; catalog_pin_json: string | null }>(
    context,
    "select revision, input_json, input_hash, catalog_pin_json from execution_inputs where workflow_id = ? and plan_id = ?",
    workflowId,
    planId,
  );
}

/** The committed catalog binding of one workflow, as `catalog_execution_bindings` holds it. */
async function bindingOf(context: StoreContext, workflowId: string) {
  return await one<{ catalog_kind: string; catalog_id: string; catalog_revision: number; input_hash: string }>(
    context,
    "select catalog_kind, catalog_id, catalog_revision, input_hash from catalog_execution_bindings where workflow_id = ?",
    workflowId,
  );
}

/** No JSON registration byte of any kind exists: the DB route owns execution. */
function noJsonRegistrationFiles(workspace: string): boolean {
  return !existsSync(join(workspace, "status.json")) && !existsSync(join(workspace, "workflows"));
}

/** A pending journal row from the retired file-registration protocol. */
async function plantPendingLegacyOperation(context: StoreContext, operationId: string, workflowId: string): Promise<void> {
  await fixtureWrite(
    context,
    "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, " +
      "after_versions_json, result_json, created_at, updated_at) values (?, 'hash', 'execution-written', ?, '{}', '{}', null, ?, ?)",
    operationId,
    JSON.stringify({ version: 1, workflow: { kind: "plan", workflowId } }),
    TS,
    TS,
  );
}


async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate?.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code, message: candidate.message };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

/* ------------------------------------------------------------------------ *
 * The composed registration
 * ------------------------------------------------------------------------ */

describe("execution-registration", () => {
  test("execution-registration-publishes-the-verb-verbatim-on-the-engine-surface", () => {
    // The one published name this task adds, pinned at the type level: a
    // published surface that drifted from the reviewed signature would not
    // compile here.
    const surface: (
      context: ExecutionContext,
      request: CatalogExecutionRequest & { expected: ExecutionToken },
    ) => Promise<CatalogExecutionReceipt> = engineIndex.commitExecutionRegistration;
    expect(surface).toBe(commitExecutionRegistration);
  });

  test("execution-registration-commits-the-catalog-delta-and-the-workflow-in-one-transaction", async () => {
    const fixture = await activeFixture("commits");
    const before = await footprint(fixture.context);
    const receipt = await registerPlanWorkflow(fixture, "op-register-1");

    expect(receipt).toEqual({ operationId: "op-register-1", workflowId: WORKFLOW_ID, catalogRevision: 1, recovered: false });

    // (a) the execution half: registry membership, the header, the plan row, its
    // sealed input and the committed receipt — all rows of this one transaction.
    expect(
      await one<{ revision: number; creator_session_id: string }>(
        fixture.context,
        "select revision, creator_session_id from execution_workflows where workflow_id = ?",
        WORKFLOW_ID,
      ),
    ).toEqual({ revision: 1, creator_session_id: COORDINATOR_ID });
    expect(
      await one<{ entry_json: string }>(fixture.context, "select entry_json from execution_registry where workflow_id = ?", WORKFLOW_ID),
    ).toBeDefined();
    expect(
      await one<{ revision: number; ordinal: number }>(
        fixture.context,
        "select revision, ordinal from execution_plans where workflow_id = ? and plan_id = ?",
        WORKFLOW_ID,
        PLAN_ID,
      ),
    ).toEqual({ revision: 1, ordinal: 0 });
    const sealed = await sealedInput(fixture.context, PLAN_ID);
    expect(sealed?.revision).toBe(1);
    expect(sealed?.catalog_pin_json).toBeNull();
    expect(
      await one<{ n: number }>(fixture.context, "select count(*) as n from execution_operations where operation_id = ?", "op-register-1"),
    ).toEqual({ n: 1 });

    // (b) the catalog half: the reviewed entity, at the reviewed location…
    const entity = (await getCatalog(fixture.context, { kind: "plan", id: PLAN_ID })).entity;
    expect(entity).toMatchObject({ title: PLAN_TITLE, rootKind: "plans", relativePath: `${PLAN_ID}.md`, revision: 1 });
    // …and the workflow's committed association with it.
    expect(await bindingOf(fixture.context, WORKFLOW_ID)).toMatchObject({
      catalog_kind: "plan",
      catalog_id: PLAN_ID,
      catalog_revision: 1,
    });

    // invariant: (c) exactly the rows one registration creates, and exactly the revision
    // advances it owes: one root revision for the membership change, ONE
    // collaboration revision for the whole catalog-effect transaction (§3.1),
    // one catalog revision for the published entity, and one effect receipt —
    // never a second collaboration advance for the same transaction, and no
    // extra row at all.
    expect(await footprint(fixture.context)).toEqual({
      ...before,
      root_revision: (before.root_revision as number) + 1,
      store_revision: (before.store_revision as number) + 1,
      catalog_revision: (before.catalog_revision as number) + 1,
      collaboration_revision: (before.collaboration_revision as number) + 1,
      effects: 1,
      workflows: 1,
      registry: 1,
      plans: 1,
      inputs: 1,
      operations: 1,
      entities: 1,
      bindings: 1,
    });

    // (d) NO JSON registration file. The ACTIVE producer does not create a
    // legacy file-journal phase.
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
    expect(await listPendingCatalogRegistrations(fixture.context)).toEqual([]);
  });

  test("execution-registration-registers-with-an-unset-session-identity-as-a-null-creator", async () => {
    // A transport that supplies no session identity (the omp MCP surface
    // without host injection) registers anyway: creator attribution is unset,
    // the first coordinator bind claims the workflow for its coordinator.
    const fixture = await activeFixture("unset-creator");
    const before = await footprint(fixture.context);
    const receipt = await commitExecutionRegistration(
      { ...fixture.context, caller: { ...fixture.caller, sessionId: "" } },
      { ...planRequest({ context: fixture.context, operationId: "op-register-unset" }), expected: fixture.rootToken },
    );
    expect(receipt).toEqual({ operationId: "op-register-unset", workflowId: WORKFLOW_ID, catalogRevision: 1, recovered: false });
    expect(
      await one<{ creator_session_id: string | null }>(
        fixture.context,
        "select creator_session_id from execution_workflows where workflow_id = ?",
        WORKFLOW_ID,
      ),
    ).toEqual({ creator_session_id: null });
    expect((await footprint(fixture.context)).workflows).toBe((before.workflows as number) + 1);
    // The published catalog half is identical to an attributed registration:
    // the entity exists at its reviewed location and the workflow is bound.
    expect(
      await one<{ n: number }>(fixture.context, "select count(*) as n from execution_operations where operation_id = ?", "op-register-unset"),
    ).toEqual({ n: 1 });
  });

  test("execution-registration-advances-the-shared-store-revision-once-for-the-whole-transaction", async () => {
    const fixture = await activeFixture("store-revision");
    const before = await footprint(fixture.context);
    // ONE accepted multi-domain registration publishing THREE catalog rows: two
    // reviewed entities and the relation between them. §3.1 admits one shared
    // `store_revision` advance per accepted transaction, so the row count of the
    // delta must not move it; the catalog domain's own counter keeps advancing
    // once per published row, and the relation advances the entity it departs
    // from.
    const request = planRequest({
      context: fixture.context,
      operationId: "op-store-revision",
      entities: [
        { kind: "plan", id: PLAN_ID, title: PLAN_TITLE, rootKind: "plans", relativePath: `${PLAN_ID}.md` },
        { kind: "plan", id: SIDE_PLAN_ID, title: "Superseding plan", rootKind: "plans", relativePath: `${SIDE_PLAN_ID}.md` },
      ],
      links: [{ from: { kind: "plan", id: SIDE_PLAN_ID }, relation: "supersedes", to: { kind: "plan", id: PLAN_ID } }],
    });

    const accepted = await commitExecutionRegistration(
      { ...fixture.context, caller: fixture.caller },
      { ...request, expected: fixture.rootToken },
    );
    expect(accepted).toEqual({
      operationId: "op-store-revision",
      workflowId: WORKFLOW_ID,
      catalogRevision: 3,
      recovered: false,
    });

    const published = await footprint(fixture.context);
    expect(published).toEqual({
      ...before,
      root_revision: (before.root_revision as number) + 1,
      store_revision: (before.store_revision as number) + 1,
      catalog_revision: (before.catalog_revision as number) + 3,
      collaboration_revision: (before.collaboration_revision as number) + 1,
      effects: 1,
      workflows: 1,
      registry: 1,
      plans: 1,
      inputs: 1,
      operations: 1,
      entities: 2,
      links: 1,
      bindings: 1,
    });
    // The catalog half is complete: the relation moved its departing entity's own
    // revision, and the binding records the catalog revision that published it.
    expect((await getCatalog(fixture.context, { kind: "plan", id: SIDE_PLAN_ID })).entity.revision).toBe(2);
    expect((await bindingOf(fixture.context, WORKFLOW_ID))?.catalog_revision).toBe(3);

    // The exact retry advances NONE of the three revisions.
    expect(
      await commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        { ...request, expected: fixture.rootToken },
      ),
    ).toEqual(accepted);
    expect(await footprint(fixture.context)).toEqual(published);
  });

  test("execution-registration-replays-a-producer-that-supplies-no-timestamp", async () => {
    const fixture = await activeFixture("clock-retry");
    // A plan producer that omits `startedAt` gets one from the clock on EVERY
    // call, so the derived snapshot differs between the attempt and its retry.
    // The request hash covers the REVIEWED request, never the derived snapshot:
    // an exact retry stays an exact retry, and the clock cannot turn it into an
    // operation-id collision.
    const request: CatalogExecutionRequest = planRequest({
      context: fixture.context,
      operationId: "op-clock",
      omitStartedAt: true,
    });
    const first = await commitExecutionRegistration({ ...fixture.context, caller: fixture.caller }, { ...request, expected: fixture.rootToken });
    const accepted = await footprint(fixture.context);
    expect(await commitExecutionRegistration({ ...fixture.context, caller: fixture.caller }, { ...request, expected: fixture.rootToken })).toEqual(first);
    expect(await footprint(fixture.context)).toEqual(accepted);
  });

  test("execution-registration-registers-an-iteration-lifecycle-with-its-own-binding-family", async () => {
    const fixture = await activeFixture("iteration");
    const iterationId = "iter-20260921-registration";
    // §4: the row's pointer is the registered plan document, spelled the way the
    // ONE registered-plan path contract accepts it — the file producer and the
    // legacy journal always did; the DB route now resolves it through the same
    // seam, so one intent cannot persist two spellings (E07 fold).
    const row = { id: `${iterationId}-plan`, title: "Iteration row", file: `plans/${iterationId}-plan.md` };
    writePlanDocument(fixture.context.harnessDir, row.id, row.title);
    writeReviewedCompass(fixture.context.harnessDir, iterationId);
    const receipt = await commitExecutionRegistration(
      { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } },
      {
        operationId: "op-iteration",
        actor: "project-manager",
        expectedCatalogRevision: 0,
        workflow: {
          kind: "iteration",
          workflowId: iterationId,
          options: {
            harnessDir: fixture.context.harnessDir,
            compassRef: "delivery-compass.md",
            branch: { base: "main", integration: `iteration/${iterationId}`, target: "main" },
            rows: [row],
                      },
        },
        delta: {
          entities: [{ kind: "iteration", id: iterationId, title: iterationId, rootKind: "iterations", relativePath: iterationId }],
          binding: { catalogKind: "iteration", catalogId: iterationId },
        },
        expected: fixture.rootToken,
      },
    );

    const header = await one<{ state_json: string }>(
      fixture.context,
      "select state_json from execution_workflows where workflow_id = ?",
      iterationId,
    );
    expect(JSON.parse(String(header?.state_json))).toMatchObject({
      phase: PREPARE_PHASE,
      compass_ref: "delivery-compass.md",
    });
    expect(receipt).toEqual({ operationId: "op-iteration", workflowId: iterationId, catalogRevision: 1, recovered: false });
    expect((await getCatalog(fixture.context, { kind: "iteration", id: iterationId })).entity).toMatchObject({
      rootKind: "iterations",
      relativePath: iterationId,
    });
    expect(await bindingOf(fixture.context, iterationId)).toMatchObject({
      catalog_kind: "iteration",
      catalog_id: iterationId,
      catalog_revision: 1,
    });
    // The iteration snapshot's own row metadata is the sealed input. The ACTIVE
    // composer canonicalizes the plan pointer before hashing and sealing, while
    // the registration itself never rewrites the catalog plan row.
    const sealed = await sealedInput(fixture.context, row.id, iterationId);
    expect(JSON.parse(String(sealed?.input_json))).toMatchObject({
      plan_id: row.id,
      id: row.id,
      title: row.title,
      file: join(realpathSync(join(fixture.context.harnessDir, "plans")), `${row.id}.md`),
      iteration_refs: ["delivery-compass.md"],
    });
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("a shipped iteration registration with repeated projects writes one belongs-to link per project (C4)", async () => {
    const fixture = await activeFixture("iteration-projects");
    const iterationId = "iter-20260921-projects";
    const row = { id: `${iterationId}-plan`, title: "Iteration row", file: `plans/${iterationId}-plan.md` };
    writePlanDocument(fixture.context.harnessDir, row.id, row.title);
    writeReviewedCompass(fixture.context.harnessDir, iterationId);
    for (const projectId of ["proj-a", "proj-b"]) {
      await registerCatalogEntity(
        fixture.context,
        { kind: "project", id: projectId, title: projectId, rootKind: "projects", relativePath: projectId },
        { actor: "project-manager", operationId: `register-${projectId}` },
      );
    }
    const context: ExecutionContext = { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } };
    await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: {
        kind: "iteration",
        workflowId: iterationId,
        options: {
          harnessDir: fixture.context.harnessDir,
          compassRef: "delivery-compass.md",
          branch: { base: "main", integration: `iteration/${iterationId}`, target: "main" },
          rows: [row],
          projects: ["proj-a", "proj-b"],
        },
      },
      operationId: "op-iteration-projects",
      expected: fixture.rootToken,
    });
    // One link per project, plus the plan row's membership link.
    const links = collaborationRows<{ from_kind: string; from_id: string; to_kind: string; to_id: string }>(
      fixture.context,
      "select from_kind, from_id, to_kind, to_id from catalog_links order by from_kind, from_id, to_id",
    ).map((link) => `${link.from_kind}:${link.from_id}->${link.to_kind}:${link.to_id}`);
    expect(links).toEqual([
      `iteration:${iterationId}->project:proj-a`,
      `iteration:${iterationId}->project:proj-b`,
      `plan:${row.id}->iteration:${iterationId}`,
    ]);
    // The snapshot's single-project record keeps the first value.
    const header = await one<{ state_json: string }>(
      fixture.context,
      "select state_json from execution_workflows where workflow_id = ?",
      iterationId,
    );
    expect(JSON.parse(String(header?.state_json))).toMatchObject({ project: "proj-a" });
  });

  test("execution-registration-publishes-nothing-when-the-named-compass-is-not-this-iterations", async () => {
    const fixture = await activeFixture("iteration-compass-document");
    const iterationId = "iter-20260921-compass-document";
    const row = { id: `${iterationId}-plan`, title: "Iteration row", file: `plans/${iterationId}-plan.md` };
    writePlanDocument(fixture.context.harnessDir, row.id, row.title);
    // One valid compass, authored for a DIFFERENT iteration, plus a pointer that
    // names no document at all: both are the registration-time mistakes this
    // gate exists for, and neither may leave a row behind.
    writeReviewedCompass(fixture.context.harnessDir, "iter-someone-else", `iterations/${iterationId}/delivery-compass.md`);
    const before = await footprint(fixture.context);
    const attempts = [
      ["another iteration's compass", `iterations/${iterationId}/delivery-compass.md`],
      ["a pointer that names no document", `iterations/${iterationId}/missing-compass.md`],
    ] as const;

    for (const [index, [label, compassRef]] of attempts.entries()) {
      const refusal = await refusalOf(() =>
        commitExecutionRegistration(
          { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } },
          {
            operationId: `op-iteration-compass-document-${index}`,
            actor: "project-manager",
            expectedCatalogRevision: 0,
            workflow: {
              kind: "iteration",
              workflowId: iterationId,
              options: {
                harnessDir: fixture.context.harnessDir,
                compassRef,
                branch: { base: "main", integration: `iteration/${iterationId}`, target: "main" },
                rows: [row],
                              },
            },
            delta: {
              entities: [{ kind: "iteration", id: iterationId, title: iterationId, rootKind: "iterations", relativePath: iterationId }],
              binding: { catalogKind: "iteration", catalogId: iterationId },
            },
            expected: fixture.rootToken,
          },
        ),
      );
      expect(`${label} -> ${refusal.code}`).toBe(`${label} -> catalog.registration-invalid`);
    }

    // No workflow row, no plan row, no catalog entity, no binding, no receipt:
    // the refusal rolls the whole ACTIVE transaction back.
    expect(await footprint(fixture.context)).toEqual(before);
    expect(await one(fixture.context, "select workflow_id from execution_workflows where workflow_id = ?", iterationId)).toBeUndefined();
    expect(await one<{ n: number }>(fixture.context, "select count(*) as n from catalog_entities")).toEqual({ n: 0 });
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("execution-registration-replays-a-pre-upgrade-iteration-committed-under-the-prior-delta-shape", async () => {
    const fixture = await activeFixture("iteration-prior-delta-replay");
    const iterationId = "iter-20260921-prior-delta";
    writeReviewedCompass(fixture.context.harnessDir, iterationId);
    const request = iterationRequest(fixture, iterationId, "op-iteration-prior-delta");
    const context: ExecutionContext = { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } };
    // The previous release reviewed a SMALLER delta: the iteration entity and
    // its binding only — plan-row membership entities, their membership links
    // and the project links are published by this version. A receipt recorded
    // under that shape (committed here exactly as the prior producer hashed it)
    // must still replay for an unchanged retry instead of the widened delta
    // turning the retry into `execution.operation-conflict`.
    const priorRequest = {
      ...request,
      delta: {
        entities: [{ kind: "iteration", id: iterationId, title: iterationId, rootKind: "iterations", relativePath: iterationId }],
        binding: { catalogKind: "iteration", catalogId: iterationId },
      },
    } as typeof request;
    const committed = await commitExecutionRegistration(context, { ...priorRequest, expected: fixture.rootToken });
    const accepted = await footprint(fixture.context);

    const shipped = { actor: "project-manager", workflow: request.workflow, operationId: request.operationId };
    expect(await registerShippedCatalogExecution(context, { ...shipped, expected: fixture.rootToken })).toEqual(committed);
    expect(await commitExecutionRegistration(context, { ...priorRequest, expected: fixture.rootToken })).toEqual(committed);
    expect(await footprint(fixture.context)).toEqual(accepted);
  });

  test("execution-registration-replays-a-committed-iteration-whose-compass-was-emptied", async () => {
    const fixture = await activeFixture("iteration-compass-replay");
    const iterationId = "iter-20260921-compass-replay";
    writeReviewedCompass(fixture.context.harnessDir, iterationId);
    const request = iterationRequest(fixture, iterationId, "op-iteration-compass-replay");
    const context: ExecutionContext = { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } };
    const shipped = { actor: "project-manager", workflow: request.workflow, operationId: request.operationId };
    const committed = await registerShippedCatalogExecution(context, { ...shipped, expected: fixture.rootToken });
    const accepted = await footprint(fixture.context);

    // The reviewed compass is emptied AFTER the commit: the recorded operation
    // still replays its receipt from both producers instead of re-proving the
    // document the committed intent already proved.
    writeFileSync(join(fixture.context.harnessDir, "delivery-compass.md"), "");
    expect(await registerShippedCatalogExecution(context, { ...shipped, expected: fixture.rootToken })).toEqual(committed);
    expect(
      await commitExecutionRegistration(context, { ...request, expected: fixture.rootToken }),
    ).toEqual(committed);
    expect(await footprint(fixture.context)).toEqual(accepted);

    // A NEW operation id against the same unusable compass is still refused,
    // and the refusal publishes nothing.
    const refusal = await refusalOf(() =>
      registerShippedCatalogExecution(context, { ...shipped, operationId: "op-iteration-compass-replay-new" }),
    );
    expect(refusal.code).toBe("catalog.registration-invalid");
    expect(await footprint(fixture.context)).toEqual(accepted);
  });

  test("execution-registration-replays-a-committed-iteration-whose-documents-were-deleted", async () => {
    const fixture = await activeFixture("iteration-compass-deleted-replay");
    const iterationId = "iter-20260921-compass-deleted";
    writeReviewedCompass(fixture.context.harnessDir, iterationId);
    const request = iterationRequest(fixture, iterationId, "op-iteration-compass-deleted");
    const context: ExecutionContext = { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } };
    const shipped = { actor: "project-manager", workflow: request.workflow, operationId: request.operationId };
    const committed = await registerShippedCatalogExecution(context, { ...shipped, expected: fixture.rootToken });
    const accepted = await footprint(fixture.context);

    // The reviewed compass is REMOVED after the commit: the recorded operation
    // still replays its receipt from both producers instead of resolving a
    // document the committed intent already proved.
    rmSync(join(fixture.context.harnessDir, "delivery-compass.md"));
    expect(await registerShippedCatalogExecution(context, { ...shipped, expected: fixture.rootToken })).toEqual(committed);
    expect(await commitExecutionRegistration(context, { ...request, expected: fixture.rootToken })).toEqual(committed);
    expect(await footprint(fixture.context)).toEqual(accepted);

    // A NEW operation id against the now-missing compass is still refused, and
    // the refusal publishes nothing.
    const refusal = await refusalOf(() =>
      registerShippedCatalogExecution(context, { ...shipped, operationId: "op-iteration-compass-deleted-new" }),
    );
    expect(refusal.code).toBe("catalog.registration-invalid");
    expect(await footprint(fixture.context)).toEqual(accepted);

    // The rows' plan documents follow the same rule: a committed registration
    // still replays once its plan markdown is gone, while a new operation id
    // naming that missing document is refused without rows.
    const planDeletedId = "iter-20260921-plan-deleted";
    writeReviewedCompass(fixture.context.harnessDir, planDeletedId);
    const planDeletedRequest = iterationRequest(fixture, planDeletedId, "op-iteration-plan-deleted");
    const planDeletedShipped = {
      actor: "project-manager",
      workflow: planDeletedRequest.workflow,
      operationId: planDeletedRequest.operationId,
    };
    const planDeletedContext: ExecutionContext = { ...fixture.context, caller: { ...fixture.caller, workflowId: planDeletedId } };
    const planDeletedCommitted = await registerShippedCatalogExecution(planDeletedContext, planDeletedShipped);
    const bothAccepted = await footprint(fixture.context);
    rmSync(join(fixture.context.harnessDir, "plans", `${planDeletedId}-plan.md`));
    expect(await registerShippedCatalogExecution(planDeletedContext, planDeletedShipped)).toEqual(planDeletedCommitted);
    expect(await footprint(fixture.context)).toEqual(bothAccepted);
    const planRefusal = await refusalOf(() =>
      registerShippedCatalogExecution(planDeletedContext, { ...planDeletedShipped, operationId: "op-iteration-plan-deleted-new" }),
    );
    expect(planRefusal.code).toBe("plan-path.not-a-file");
    expect(await footprint(fixture.context)).toEqual(bothAccepted);
  });

  test("execution-registration-canonicalizes an in-root compass symlink for ACTIVE iteration registration", async () => {
    const fixture = await activeFixture("iteration-compass-alias");
    const iterationId = "iter-20260921-compass-alias";
    const compassRef = `iterations/${iterationId}/delivery-compass.md`;
    const compassPath = join(fixture.context.harnessDir, compassRef);
    writeReviewedCompass(fixture.context.harnessDir, iterationId, compassRef);
    const aliasPath = join(fixture.workspace, "compass-alias.md");
    symlinkSync(compassPath, aliasPath);
    const row = { id: `${iterationId}-plan`, title: "Iteration row", file: `plans/${iterationId}-plan.md` };
    writePlanDocument(fixture.context.harnessDir, row.id, row.title);

    await commitExecutionRegistration(
      { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } },
      {
        operationId: "op-iteration-compass-alias",
        actor: "project-manager",
        expectedCatalogRevision: 0,
        workflow: {
          kind: "iteration",
          workflowId: iterationId,
          options: {
            harnessDir: fixture.context.harnessDir,
            compassRef: aliasPath,
            branch: { base: "main", integration: `iteration/${iterationId}`, target: "main" },
            rows: [row],
                      },
        },
        delta: {
          entities: [{ kind: "iteration", id: iterationId, title: iterationId, rootKind: "iterations", relativePath: iterationId }],
          binding: { catalogKind: "iteration", catalogId: iterationId },
        },
        expected: fixture.rootToken,
      },
    );

    const header = await one<{ state_json: string }>(
      fixture.context,
      "select state_json from execution_workflows where workflow_id = ?",
      iterationId,
    );
    expect(JSON.parse(String(header?.state_json))).toMatchObject({
      phase: PREPARE_PHASE,
      compass_ref: compassRef,
    });
    const sealed = await sealedInput(fixture.context, row.id, iterationId);
    expect(JSON.parse(String(sealed?.input_json))).toMatchObject({
      file: join(realpathSync(join(fixture.context.harnessDir, "plans")), `${row.id}.md`),
      iteration_refs: [compassRef],
    });
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("execution-registration-replays-a-committed-iteration-whose-compass-alias-dangles", async () => {
    const fixture = await activeFixture("iteration-compass-alias-replay");
    const iterationId = "iter-20260921-compass-alias-replay";
    const compassRef = `iterations/${iterationId}/delivery-compass.md`;
    const compassPath = join(fixture.context.harnessDir, compassRef);
    writeReviewedCompass(fixture.context.harnessDir, iterationId, compassRef);
    // The committed pointer names the reviewed compass through an in-harness
    // symlink: normalizing it resolves the target, so the stored form is the
    // canonical relative pointer while the request keeps the caller's spelling.
    const aliasRef = "compass-alias.md";
    symlinkSync(compassPath, join(fixture.context.harnessDir, aliasRef));
    const row = { id: `${iterationId}-plan`, title: "Iteration row", file: `plans/${iterationId}-plan.md` };
    writePlanDocument(fixture.context.harnessDir, row.id, row.title);
    const context: ExecutionContext = { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } };
    const request: IterationExecutionRequest = {
      operationId: "op-iteration-compass-alias-replay",
      actor: "project-manager",
      expectedCatalogRevision: 0,
      workflow: {
        kind: "iteration",
        workflowId: iterationId,
        options: {
          harnessDir: fixture.context.harnessDir,
          compassRef: aliasRef,
          branch: { base: "main", integration: `iteration/${iterationId}`, target: "main" },
          rows: [row],
        },
      },
      // The reviewed delta is the shipped producer's own derivation (C2): plan
      // entities plus the membership links, so the commit and producer seams
      // spell one semantic request.
      delta: {
        entities: [
          { kind: "iteration", id: iterationId, title: iterationId, rootKind: "iterations", relativePath: iterationId },
          { kind: "plan", id: row.id, title: row.title, rootKind: "plans", relativePath: `${row.id}.md` },
        ],
        links: [{ from: { kind: "plan", id: row.id }, relation: "belongs-to", to: { kind: "iteration", id: iterationId } }],
        binding: { catalogKind: "iteration", catalogId: iterationId },
      },
    };
    const shipped = { actor: request.actor, workflow: request.workflow, operationId: request.operationId };

    const committed = await commitExecutionRegistration(context, { ...request, expected: fixture.rootToken });
    const accepted = await footprint(fixture.context);

    // The stored pointer is the canonical target, never the alias.
    const header = await one<{ state_json: string }>(
      fixture.context,
      "select state_json from execution_workflows where workflow_id = ?",
      iterationId,
    );
    expect(JSON.parse(String(header?.state_json))).toMatchObject({ compass_ref: compassRef });
    const sealed = await sealedInput(fixture.context, row.id, iterationId);
    expect(JSON.parse(String(sealed?.input_json))).toMatchObject({ iteration_refs: [compassRef] });

    // The target is deleted, leaving the committed alias DANGLING: the same
    // input no longer canonicalizes to the committed pointer, so the retry's
    // identity is its own spelling, and both producers replay the receipt.
    rmSync(compassPath);
    expect(await commitExecutionRegistration(context, { ...request, expected: fixture.rootToken })).toEqual(committed);
    expect(await registerShippedCatalogExecution(context, { ...shipped, expected: fixture.rootToken })).toEqual(committed);
    expect(await footprint(fixture.context)).toEqual(accepted);

    // A NEW operation id against the dangling alias is still refused, and the
    // refusal publishes nothing.
    const shippedRefusal = await refusalOf(() =>
      registerShippedCatalogExecution(context, { ...shipped, operationId: "op-iteration-compass-alias-replay-new" }),
    );
    expect(shippedRefusal.code).toBe("catalog.registration-invalid");
    const commitRefusal = await refusalOf(() =>
      commitExecutionRegistration(context, {
        ...request,
        operationId: "op-iteration-compass-alias-replay-new",
        expected: fixture.rootToken,
      }),
    );
    expect(commitRefusal.code).toBe("catalog.registration-invalid");
    expect(await footprint(fixture.context)).toEqual(accepted);
  });

  test("execution-registration-replays-an-explicit-operation-after-pointer-normalization", async () => {
    const fixture = await activeFixture("iteration-identity-compat");
    const iterationId = "iter-20260921-identity-compat";
    writeReviewedCompass(fixture.context.harnessDir, iterationId);
    const request = iterationRequest(fixture, iterationId, "op-iteration-identity-compat");
    const context: ExecutionContext = { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } };
    const committed = await commitExecutionRegistration(context, { ...request, expected: fixture.rootToken });
    const accepted = await footprint(fixture.context);

    // The previous release hashed the plan row's CANONICAL absolute pointer, so
    // a retry that re-spells the same document after the upgrade must still
    // return the saved receipt instead of `execution.operation-conflict`.
    const absoluteRows: IterationExecutionRequest = {
      ...request,
      workflow: {
        ...request.workflow,
        options: {
          ...request.workflow.options,
          rows: request.workflow.options.rows.map((row) => ({ ...row, file: join(fixture.context.harnessDir, row.file) })),
        },
      },
    };
    expect(await commitExecutionRegistration(context, { ...absoluteRows, expected: fixture.rootToken })).toEqual(committed);

    // An alias spelling of the SAME compass canonicalizes to the committed
    // fingerprint: the legacy lookup accepts it on both producers, so a receipt
    // recorded under the canonical spelling still replays.
    symlinkSync(join(fixture.context.harnessDir, "delivery-compass.md"), join(fixture.context.harnessDir, "compass-alias.md"));
    const aliased: IterationExecutionRequest = {
      ...request,
      workflow: { ...request.workflow, options: { ...request.workflow.options, compassRef: "compass-alias.md" } },
    };
    expect(await commitExecutionRegistration(context, { ...aliased, expected: fixture.rootToken })).toEqual(committed);
    expect(
      await registerShippedCatalogExecution(context, {
        actor: aliased.actor,
        workflow: aliased.workflow,
        operationId: aliased.operationId,
      }),
    ).toEqual(committed);
    expect(await footprint(fixture.context)).toEqual(accepted);
  });

  test("execution-registration-replays-a-derived-operation-after-pointer-normalization", async () => {
    const fixture = await activeFixture("iteration-derived-compat");
    const iterationId = "iter-20260921-derived-compat";
    writeReviewedCompass(fixture.context.harnessDir, iterationId);
    const request = iterationRequest(fixture, iterationId, "unused-derived-compat");
    const context: ExecutionContext = { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } };
    const first = await registerShippedCatalogExecution(context, { actor: "project-manager", workflow: request.workflow });
    const accepted = await footprint(fixture.context);

    // The derived operation id is the previous release's: it is computed over
    // the canonical plan-row pointers, so re-spelling the same document keeps
    // the id AND the fingerprint it was committed under.
    const absoluteRows = {
      ...request.workflow,
      options: {
        ...request.workflow.options,
        rows: request.workflow.options.rows.map((row) => ({ ...row, file: join(fixture.context.harnessDir, row.file) })),
      },
    };
    const replay = await registerShippedCatalogExecution(context, { actor: "project-manager", workflow: absoluteRows });
    expect(replay.operationId).toBe(first.operationId);
    expect(replay).toEqual(first);
    expect(await footprint(fixture.context)).toEqual(accepted);

    // A derived id through an in-harness compass alias stays stable once the
    // alias dangles: the identity keeps the caller's spelling, so the retry
    // finds its own operation instead of deriving a different one.
    const aliasId = "iter-20260921-derived-alias";
    const compassPath = join(fixture.context.harnessDir, `iterations/${aliasId}/delivery-compass.md`);
    writeReviewedCompass(fixture.context.harnessDir, aliasId, `iterations/${aliasId}/delivery-compass.md`);
    symlinkSync(compassPath, join(fixture.context.harnessDir, "derived-alias.md"));
    const aliasRequest = iterationRequest(fixture, aliasId, "unused-derived-alias");
    const aliasWorkflow = {
      ...aliasRequest.workflow,
      options: { ...aliasRequest.workflow.options, compassRef: "derived-alias.md" },
    };
    const aliasContext: ExecutionContext = { ...fixture.context, caller: { ...fixture.caller, workflowId: aliasId } };
    const aliasFirst = await registerShippedCatalogExecution(aliasContext, { actor: "project-manager", workflow: aliasWorkflow });
    const aliasAccepted = await footprint(fixture.context);
    rmSync(compassPath);
    const aliasReplay = await registerShippedCatalogExecution(aliasContext, { actor: "project-manager", workflow: aliasWorkflow });
    expect(aliasReplay.operationId).toBe(aliasFirst.operationId);
    expect(aliasReplay).toEqual(aliasFirst);
    expect(await footprint(fixture.context)).toEqual(aliasAccepted);
  });

  test("execution-registration-replays-a-derived-operation-recorded-under-the-legacy-id", async () => {
    const fixture = await activeFixture("iteration-derived-legacy-id");
    const iterationId = "iter-20260921-derived-legacy-id";
    const compassRef = `iterations/${iterationId}/delivery-compass.md`;
    writeReviewedCompass(fixture.context.harnessDir, iterationId, compassRef);
    // The non-canonical spelling the previous release recorded: it resolves to
    // the reviewed compass, so the legacy identity form hashes the same intent
    // the canonical spelling does.
    symlinkSync(
      join(fixture.context.harnessDir, compassRef),
      join(fixture.context.harnessDir, "legacy-derived-compass.md"),
    );
    const request = iterationRequest(fixture, iterationId, "unused-derived-legacy-id");
    const context: ExecutionContext = { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } };
    const canonicalWorkflow = {
      ...request.workflow,
      options: { ...request.workflow.options, compassRef },
    };

    // The previous release derived its operation id over the CANONICAL identity,
    // so registering the canonical spelling seeds that exact address together
    // with the exact fingerprint it recorded.
    const committed = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: canonicalWorkflow,
    });
    const accepted = await footprint(fixture.context);

    // The non-canonical spelling now derives a DIFFERENT live id: only the
    // legacy derived id addresses the recorded receipt, which replays instead
    // of the retry being judged a new (already committed) lifecycle.
    const aliasedWorkflow = {
      ...canonicalWorkflow,
      options: { ...canonicalWorkflow.options, compassRef: "legacy-derived-compass.md" },
    };
    expect(await registerShippedCatalogExecution(context, { actor: "project-manager", workflow: aliasedWorkflow })).toEqual(
      committed,
    );
    expect(await footprint(fixture.context)).toEqual(accepted);

    // A genuinely different intent matches neither derived id: the normal
    // creation rules refuse the already-committed workflow identity.
    const refusal = await refusalOf(() =>
      registerShippedCatalogExecution(context, { actor: "project-manager-alt", workflow: aliasedWorkflow }),
    );
    expect(refusal.code).toBe("execution.not-empty");
    expect(await footprint(fixture.context)).toEqual(accepted);
  });

  test("execution-registration-refuses compass paths outside the ACTIVE iteration harness", async () => {
    const fixture = await activeFixture("iteration-compass-boundary");
    const outsideCompass = join(fixture.workspace, "outside-compass.md");
    writeFileSync(outsideCompass, "# External compass\n");
    symlinkSync(outsideCompass, join(fixture.context.harnessDir, "external-compass.md"));
    const row = { id: "iter-boundary-plan", title: "Iteration row", file: "plans/iter-boundary-plan.md" };
    writePlanDocument(fixture.context.harnessDir, row.id, row.title);
    const before = await footprint(fixture.context);
    const attempts = [
      { id: "iter-boundary-absolute", compassRef: outsideCompass, detail: "resolves outside the harness root" },
      { id: "iter-boundary-symlink", compassRef: "external-compass.md", detail: "escapes the harness root" },
    ];

    for (const [index, attempt] of attempts.entries()) {
      const refusal = await refusalOf(() =>
        commitExecutionRegistration(
          { ...fixture.context, caller: { ...fixture.caller, workflowId: attempt.id } },
          {
            operationId: `op-iteration-compass-boundary-${index}`,
            actor: "project-manager",
            expectedCatalogRevision: 0,
            workflow: {
              kind: "iteration",
              workflowId: attempt.id,
              options: {
                harnessDir: fixture.context.harnessDir,
                compassRef: attempt.compassRef,
                branch: { base: "main", integration: `iteration/${attempt.id}`, target: "main" },
                rows: [row],
                              },
            },
            delta: {
              entities: [{ kind: "iteration", id: attempt.id, title: attempt.id, rootKind: "iterations", relativePath: attempt.id }],
              binding: { catalogKind: "iteration", catalogId: attempt.id },
            },
            expected: fixture.rootToken,
          },
        ),
      );
      expect(refusal.code).toBe("catalog.registration-invalid");
      expect(refusal.message).toContain(attempt.detail);
    }

    expect(await footprint(fixture.context)).toEqual(before);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("execution-registration-rolls-back-both-halves-when-the-catalog-publish-refuses", async () => {
    const fixture = await activeFixture("rolls-back");
    // A REAL catalog domain refusal, raised inside the transaction after the
    // first reviewed entity has already been published: this plan id is owned at
    // another location by an earlier writer.
    await registerCatalogEntity(
      fixture.context,
      { kind: "plan", id: PLAN_ID, title: "Registered elsewhere", rootKind: "plans", relativePath: "elsewhere.md" },
      { operationId: "op-seed", actor: "test" },
    );
    const before = await footprint(fixture.context);

    const request = planRequest({
      context: fixture.context,
      operationId: "op-refused",
      expectedCatalogRevision: before.catalog_revision as number,
      entities: [
        { kind: "plan", id: SIDE_PLAN_ID, title: "Side plan", rootKind: "plans", relativePath: `${SIDE_PLAN_ID}.md` },
        { kind: "plan", id: PLAN_ID, title: PLAN_TITLE, rootKind: "plans", relativePath: `${PLAN_ID}.md` },
      ],
      bindingId: PLAN_ID,
    });
    const refusal = await refusalOf(() =>
      commitExecutionRegistration({ ...fixture.context, caller: fixture.caller }, { ...request, expected: fixture.rootToken }),
    );
    expect(refusal.code).toBe("catalog.duplicate");
    expect(refusal.message).toContain("elsewhere.md");

    // invariant: The workflow rows and the first published entity were rolled back with
    // the refused publish: neither half is visible, and no collaboration or
    // catalog revision advanced. The deterministic refusal itself is recorded
    // as the operation's durable decline — that receipt IS the replay answer.
    expect(await footprint(fixture.context)).toEqual({ ...before, effects: (before.effects as number) + 1 });
    expect(
      collaborationRows<{ result_json: string }>(
        fixture.context,
        "select result_json from collaboration_operations where key_space = 'composite'",
      ),
    ).toEqual([{ result_json: expect.stringContaining("catalog.duplicate") }]);
    expect(await bindingOf(fixture.context, WORKFLOW_ID)).toBeUndefined();
    expect((await listCatalog(fixture.context, { kind: "plan" })).total).toBe(1);
    expect((await getCatalog(fixture.context, { kind: "plan", id: PLAN_ID })).entity.relativePath).toBe("elsewhere.md");
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("execution-registration-replays-an-exact-retry-and-refuses-a-reused-operation-id", async () => {
    const fixture = await activeFixture("replays");
    const receipt = await registerPlanWorkflow(fixture, "op-retry");
    const accepted = await footprint(fixture.context);

    // The identical retry returns the RECORDED receipt and writes nothing — the
    // stale root token it necessarily carries is not re-evaluated, because the
    // first attempt already advanced it.
    expect(await registerPlanWorkflow(fixture, "op-retry")).toEqual(receipt);
    expect(await footprint(fixture.context)).toEqual(accepted);

    // The same id with any other payload is an idempotency-key misuse.
    const collision = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        { ...planRequest({ context: fixture.context, operationId: "op-retry", title: "Another plan" }), expected: fixture.rootToken },
      ),
    );
    expect(collision.code).toBe("execution.operation-conflict");
    expect(await footprint(fixture.context)).toEqual(accepted);
  });

  test("execution-registration-refuses-a-stale-root-token-before-writing-anything", async () => {
    const fixture = await activeFixture("stale-root");
    await registerPlanWorkflow(fixture, "op-first");
    const accepted = await footprint(fixture.context);

    // A NEW workflow (so nothing but the CAS can refuse) registering against the
    // root token the first registration consumed.
    const refusal = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: { ...fixture.caller, workflowId: WORKFLOW_ID_ALT } },
        {
          ...planRequest({ context: fixture.context, operationId: "op-stale-root", workflowId: WORKFLOW_ID_ALT, expectedCatalogRevision: 1 }),
          expected: fixture.rootToken,
        },
      ),
    );
    expect(refusal.code).toBe("execution.stale-token");
    expect(await footprint(fixture.context)).toEqual(accepted);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("execution-registration-refuses-a-stale-catalog-revision", async () => {
    const fixture = await activeFixture("stale-catalog");
    await registerPlanWorkflow(fixture, "op-first");
    const accepted = await footprint(fixture.context);
    const rootToken = (await readExecutionState(fixture.context)).token;

    const refusal = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: { ...fixture.caller, workflowId: WORKFLOW_ID_THIRD } },
        {
          ...planRequest({
            context: fixture.context,
            operationId: "op-stale-catalog",
            workflowId: WORKFLOW_ID_THIRD,
            expectedCatalogRevision: 99,
          }),
          expected: rootToken,
        },
      ),
    );
    expect(refusal.code).toBe("catalog.revision-conflict");
    // note: The reviewed expectation did not match the lane, so nothing published and
    // no revision moved; the deterministic refusal is the durable decline.
    expect(await footprint(fixture.context)).toEqual({ ...accepted, effects: (accepted.effects as number) + 1 });
  });

  test("execution-registration-refuses-a-legacy-pending-operation-with-abort-and-purge-recovery", async () => {
    const fixture = await activeFixture("pending-legacy");
    await plantPendingLegacyOperation(fixture.context, "op-legacy-pending", WORKFLOW_ID);
    const before = await footprint(fixture.context);

    const refusal = await refusalOf(() => registerPlanWorkflow(fixture, "op-db-registration"));
    expect(refusal.code).toBe("catalog.registration-pending");
    expect(refusal.message).toContain("op-legacy-pending");
    expect(refusal.message).toContain("mstar catalog reconcile --abort");
    expect(refusal.message).toContain("mstar catalog purge-registration");
    // note: The refusal is reached by the registration entry itself, which holds no
    // root visibility; the journal verdict is all this caller knows. (The dispatch and
    // handle-taking gates, which DO read the registry row, still name it.)
    expect(refusal.message).not.toContain("root-visible");

    expect(await footprint(fixture.context)).toEqual(before);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
    expect((await listCatalog(fixture.context, {})).total).toBe(0);
  });

  test("execution-registration-keeps-the-stale-root-token-conflict-ahead-of-the-combined-journal", async () => {
    const fixture = await activeFixture("pending-combined-stale-root");
    await registerPlanWorkflow(fixture, "op-first");
    // note: A combined source keeps its journal in the execution store, so this row is
    // in the SAME transaction as the root-token CAS — the original ordering.
    await plantPendingLegacyOperation(fixture.context, "op-combined-pending", WORKFLOW_ID_ALT);
    const accepted = await footprint(fixture.context);

    const refusal = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: { ...fixture.caller, workflowId: WORKFLOW_ID_ALT } },
        {
          ...planRequest({ context: fixture.context, operationId: "op-combined-stale", workflowId: WORKFLOW_ID_ALT }),
          expected: fixture.rootToken,
        },
      ),
    );
    // invariant: The stale token is reported, not the pending journal.
    expect(refusal.code).toBe("execution.stale-token");
    expect(await footprint(fixture.context)).toEqual(accepted);
  });

  test("execution-registration-refuses-a-split-owner-journal-inside-the-transaction", async () => {
    const fixture = await activeFixture("pending-split");
    // why: The post-fence shape: the collaboration lane owns the journal, so the
    // execution store no longer carries the table and the verdict is a split read.
    const fenced = new DatabaseSync(join(fixture.harnessRoot, "store.db"));
    try {
      fenced.exec("drop table catalog_operations");
    } finally {
      fenced.close();
    }
    const lane = new DatabaseSync(resolveCollaborationLocation(fixture.context).dbPath);
    try {
      lane.prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, 'hash', 'prepared', ?, '{}', '{}', null, ?, ?)",
      ).run("op-split-pending", JSON.stringify({ workflow: { workflowId: WORKFLOW_ID } }), TS, TS);
    } finally {
      lane.close();
    }
    const before = await footprint(fixture.context);

    const refusal = await refusalOf(() => registerPlanWorkflow(fixture, "op-split-registration"));
    expect(refusal.code).toBe("catalog.registration-pending");
    expect(refusal.message).toContain("op-split-pending");
    expect(await footprint(fixture.context)).toEqual(before);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);

    // invariant: The refusal is DECIDED inside the transaction, after the root-token CAS:
    // a stale token is still reported as the token conflict, never as the journal verdict.
    await registerPlanWorkflow(fixture, "op-split-first", PLAN_ID, WORKFLOW_ID_ALT);
    const stale = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: { ...fixture.caller, workflowId: WORKFLOW_ID } },
        {
          ...planRequest({ context: fixture.context, operationId: "op-split-stale", planId: SIDE_PLAN_ID }),
          expected: fixture.rootToken,
        },
      ),
    );
    expect(stale.code).toBe("execution.stale-token");
  });

  test("execution-registration-refuses-a-split-owner-journal-committed-after-the-owner-read", async () => {
    const fixture = await activeFixture("pending-split-gap");
    const fenced = new DatabaseSync(join(fixture.harnessRoot, "store.db"));
    try {
      fenced.exec("drop table catalog_operations");
    } finally {
      fenced.close();
    }
    const before = await footprint(fixture.context);
    let seamRan = false;
    // invariant: The split lane stays open across the registration transaction, so the verdict
    // is read at its position: a row that appears after the owner verdict and before that lock
    // refuses. A pre-read-only verdict missed exactly this row.
    setRegistrationJournalGapForTest(() => {
      seamRan = true;
      const lane = new DatabaseSync(resolveCollaborationLocation(fixture.context).dbPath);
      try {
        lane.prepare(
          "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) values (?, 'hash', 'execution-written', ?, '{}', '{}', null, ?, ?)",
        ).run("op-split-gap", JSON.stringify({ workflow: { workflowId: WORKFLOW_ID } }), TS, TS);
      } finally {
        lane.close();
      }
    });
    try {
      const refusal = await refusalOf(() => registerPlanWorkflow(fixture, "op-split-gap-registration"));
      expect(seamRan).toBe(true);
      expect(refusal.code).toBe("catalog.registration-pending");
      expect(refusal.message).toContain("op-split-gap");
      // note: The planted row IS the only lane change; remove it so the footprint proves the
      // refusal wrote nothing else.
      const lane = new DatabaseSync(resolveCollaborationLocation(fixture.context).dbPath);
      try {
        lane.prepare("delete from catalog_operations where operation_id = 'op-split-gap'").run();
      } finally {
        lane.close();
      }
      expect(await footprint(fixture.context)).toEqual(before);
      expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
    } finally {
      setRegistrationJournalGapForTest(undefined);
    }
  });

  test("execution-registration-closes-the-split-lane-when-the-witness-stamp-refuses", async () => {
    const fixture = await activeFixture("stamp-refusal-lane");
    const fenced = new DatabaseSync(join(fixture.harnessRoot, "store.db"));
    try {
      fenced.exec("drop table catalog_operations");
    } finally {
      fenced.close();
    }
    const lanePath = resolveCollaborationLocation(fixture.context).dbPath;
    // invariant: The verdict lane is a WRITE admission while the split journal's own lane is a
    // READ one, so a checkout that records no binding opens the journal lane and then refuses at
    // the stamp. The lane opened for the journal must be released by that refusal.
    rmSync(join(fixture.harnessRoot, "collaboration-binding.json"));

    // note: Count the lane connections this call opens and the ones it closes, through the real
    // driver: `busyAware` closes the raw connection, so a `close` spy on the prototype sees it.
    const driver = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (...args: unknown[]) => object };
    const realDatabaseSync = driver.DatabaseSync;
    const laneHandles: object[] = [];
    const closedHandles: object[] = [];
    // note: `node:sqlite` ships no type for the driver prototype this spy must reach; the shape
    // here is the one member the spy replaces.
    const driverPrototype: { close(this: object): void } = DatabaseSync.prototype;
    const realClose = driverPrototype.close;
    const constructorSpy = spyOn(driver, "DatabaseSync").mockImplementation(((...args: unknown[]) => {
      const handle = new realDatabaseSync(...args);
      if (args[0] === lanePath) laneHandles.push(handle);
      return handle;
    }) as never);
    const closeSpy = spyOn(driverPrototype, "close").mockImplementation(function (this: object) {
      closedHandles.push(this);
      return realClose.call(this);
    });
    try {
      const refusal = await refusalOf(() => registerPlanWorkflow(fixture, "op-stamp-refusal"));
      expect(refusal.code).toBe("collaboration.stale-binding");
    } finally {
      constructorSpy.mockRestore();
      closeSpy.mockRestore();
    }
    // why: A stamp refusal happens AFTER the journal lane is opened, so every connection this
    // call took on the lane must be closed; a leaked one keeps the store file's handle alive.
    expect(laneHandles.length).toBeGreaterThan(0);
    for (const handle of laneHandles) expect(closedHandles).toContain(handle);
  });

});

/* ------------------------------------------------------------------------ *
 * Frozen catalog coexistence
 * ------------------------------------------------------------------------ */
describe("execution-registration \u2014 frozen input remains authoritative after catalog edits", () => {
  test("catalog edits do not move the accepted plan input, pin, binding, or replay receipt across a source reopen", async () => {
    const fixture = await activeFixture("frozen-catalog-reopen");
    const receipt = await registerPlanWorkflow(fixture, "op-frozen-source");
    const frozenBefore = await sealedInput(fixture.context, PLAN_ID);
    const bindingBefore = await bindingOf(fixture.context, WORKFLOW_ID);

    await updateCatalogEntity(
      fixture.context,
      { kind: "plan", id: PLAN_ID },
      { title: "Catalog title changed after acceptance" },
      1,
      { operationId: "op-frozen-catalog-edit", actor: "project-manager" },
    );
    expect((await getCatalog(fixture.context, { kind: "plan", id: PLAN_ID })).entity).toMatchObject({
      title: "Catalog title changed after acceptance",
      revision: 2,
    });
    expect(bindingBefore?.catalog_revision).toBe(1);

    expect(await sealedInput(fixture.context, PLAN_ID)).toEqual(frozenBefore);
    expect(await bindingOf(fixture.context, WORKFLOW_ID)).toEqual(bindingBefore);

    const reopened = await openStore(fixture.context, "read");
    reopened.close();
    expect(await sealedInput(fixture.context, PLAN_ID)).toEqual(frozenBefore);
    expect(await bindingOf(fixture.context, WORKFLOW_ID)).toEqual(bindingBefore);
    expect(await registerPlanWorkflow(fixture, "op-frozen-source")).toEqual(receipt);
  });
});



/* ------------------------------------------------------------------------ *
 * Recovery-first registration on the ACTIVE DB (E06b: A02/A04/A05/A26/A28)
 * ------------------------------------------------------------------------ */

describe("execution-registration \u2014 recovery-first registration", () => {
  test("registration recovery \u2014 the sparse intent derives the plan row from the selected document (A02/R1)", async () => {
    const fixture = await activeFixture("sparse-registration");
    const reviewed = planRequest({ context: fixture.context, operationId: "op-sparse" });
    // The sparse form the transport builds from optional inputs: the selected
    // document, no `id`/`title` — and, because a field-by-field builder writes
    // the keys anyway, the same intent with explicit `undefined` values.
    const selection = { file: `plans/${PLAN_ID}.md` };
    const sparse: CatalogExecutionRequest = {
      ...reviewed,
      workflow: {
        kind: "plan",
        workflowId: WORKFLOW_ID,
        options: { ...reviewed.workflow.options, plan: { ...selection, id: undefined, title: undefined } },
      },
    };
    expect(await commitExecutionRegistration({ ...fixture.context, caller: fixture.caller }, { ...sparse, expected: fixture.rootToken })).toMatchObject({
      workflowId: WORKFLOW_ID,
      recovered: false,
    });

    // The row the DB holds IS E06a's published derivation of the selected
    // document — this route composes it, it does not read the caller's fields a
    // second time — and the derivation names the document as the source of every
    // omitted field, which is the provenance the sparse route reports.
    const derived = derivePlanRegistration({ harnessDir: fixture.context.harnessDir, plan: selection });
    const row = await one<{ state_json: string }>(
      fixture.context,
      "select state_json from execution_plans where workflow_id = ? and plan_id = ?",
      WORKFLOW_ID,
      PLAN_ID,
    );
    expect(JSON.parse(String(row?.state_json))).toEqual({ ...derived.plan, status: "Todo" });
    expect(derived.resolvedFrom.map((source) => source.path)).toEqual(["plan.file", "plan.id", "plan.title"]);
    for (const source of derived.resolvedFrom) expect(source.source).toContain(derived.plan.file);

    // Exactly one registration effect, and no file-protocol byte beside it.
    expect(await footprint(fixture.context)).toMatchObject({
      root_revision: 2,
      store_revision: 1,
      catalog_revision: 1,
      workflows: 1,
      registry: 1,
      plans: 1,
      inputs: 1,
      operations: 1,
      entities: 1,
      links: 0,
      bindings: 1,
      pending: 0,
    });
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("registration recovery \u2014 an iteration registered without a phase derives Prepare at creation (A04/R3)", async () => {
    const fixture = await activeFixture("iteration-phase");
    const iterationId = "iter-20260921-phase";
    // §4: an iteration row pointer is the registered plan document, resolved by
    // the ONE registered-plan path contract — the same spelling the file producer
    // and the legacy journal accept (E07 folded the DB route onto that seam).
    const row = { id: `${iterationId}-plan`, title: "Iteration row", file: `plans/${iterationId}-plan.md` };
    writePlanDocument(fixture.context.harnessDir, row.id, row.title);
    writeReviewedCompass(fixture.context.harnessDir, iterationId);
    // No phase is declared anywhere in this request: the producer derives the
    // phase a genuinely unstarted iteration factually sits in.
    await commitExecutionRegistration(
      { ...fixture.context, caller: { ...fixture.caller, workflowId: iterationId } },
      {
        operationId: "op-iteration-phase",
        actor: "project-manager",
        expectedCatalogRevision: 0,
        workflow: {
          kind: "iteration",
          workflowId: iterationId,
          options: {
            harnessDir: fixture.context.harnessDir,
            compassRef: "delivery-compass.md",
            branch: { base: "main", integration: `iteration/${iterationId}`, target: "main" },
            rows: [row],
                      },
        },
        delta: {
          entities: [{ kind: "iteration", id: iterationId, title: iterationId, rootKind: "iterations", relativePath: iterationId }],
          binding: { catalogKind: "iteration", catalogId: iterationId },
        },
        expected: fixture.rootToken,
      },
    );

    // The header the DB stored carries the derived Prepare, and the authority
    // read reports it — so the registered iteration is reachable in Prepare
    // without a phase ever being written by a caller.
    const header = await one<{ state_json: string }>(
      fixture.context,
      "select state_json from execution_workflows where workflow_id = ?",
      iterationId,
    );
    expect(JSON.parse(String(header?.state_json)).phase).toBe(PREPARE_PHASE);
    const state = await readExecutionState(fixture.context);
    expect(state.data.workflows.find((workflow) => workflow.state.id === iterationId)?.state.phase).toBe(PREPARE_PHASE);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("semantic replay \u2014 a retry re-reads the store and replays the recorded receipt (A05/R6)", async () => {
    const fixture = await activeFixture("semantic-replay");
    const request = planRequest({ context: fixture.context, operationId: "op-semantic-replay" });
    const accepted = await commitExecutionRegistration({ ...fixture.context, caller: fixture.caller }, { ...request, expected: fixture.rootToken });
    const published = await footprint(fixture.context);

    // The retry after a lost response: the caller re-read the store, so it
    // presents the CURRENT root token and the catalog revision its own first
    // attempt published. Both are transport freshness, not a new intent, so the
    // retry converges on the recorded receipt instead of becoming a second
    // registration.
    const current = await readExecutionState(fixture.context);
    const reRead = await one<{ catalog_revision: number }>(fixture.context, "select catalog_revision from store_meta where id = 1");
    expect(
      await commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        { ...request, expectedCatalogRevision: reRead?.catalog_revision ?? -1, expected: current.token },
      ),
    ).toEqual(accepted);
    expect(await footprint(fixture.context)).toEqual(published);
    expect((await one<{ n: number }>(fixture.context, "select count(*) as n from execution_operations"))?.n).toBe(1);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("semantic replay \u2014 a re-read token does not launder a different registration intent (A13)", async () => {
    const fixture = await activeFixture("semantic-conflict");
    await registerPlanWorkflow(fixture, "op-semantic-conflict");
    const published = await footprint(fixture.context);
    const current = await readExecutionState(fixture.context);
    const reRead = catalogRevisionOf(fixture.context);

    // Same operation id, current tokens — but a different reviewed producer call
    // and delta. Transport freshness is excluded from the fingerprint, the
    // business intent is not.
    const refusal = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        {
          ...planRequest({ context: fixture.context, operationId: "op-semantic-conflict", title: "Another plan" }),
          expectedCatalogRevision: reRead,
          expected: current.token,
        },
      ),
    );
    expect(refusal.code).toBe("execution.operation-conflict");
    expect(await footprint(fixture.context)).toEqual(published);
  });

  test("semantic replay \u2014 an authority epoch change is re-resolved, never replayed stale (A26)", async () => {
    const fixture = await activeFixture("epoch-change");
    const request = planRequest({ context: fixture.context, operationId: "op-epoch" });
    await commitExecutionRegistration({ ...fixture.context, caller: fixture.caller }, { ...request, expected: fixture.rootToken });
    const published = await footprint(fixture.context);
    const before = await readExecutionState(fixture.context);

    // The authority renumbered itself under the call: the store's own generation
    // fence moved, so the epoch this registration was accepted under no longer
    // exists.
    await fixtureWrite(fixture.context, "update store_meta set authority_epoch = authority_epoch + 1 where id = 1");
    const current = await readExecutionState(fixture.context);
    expect(current.epoch).not.toBe(before.epoch);

    // The token of the superseded generation is refused with the typed
    // re-resolution report: nothing is written and no receipt is replayed from
    // the old epoch.
    let stale: { code?: unknown; details?: { recoveryFacts?: { unresolved?: Array<{ component?: unknown; path?: unknown; code?: unknown }> } } } = {};
    try {
      await commitExecutionRegistration({ ...fixture.context, caller: fixture.caller }, { ...request, expected: fixture.rootToken });
      throw new Error("expected a refusal");
    } catch (error) {
      stale = error as typeof stale;
    }
    expect(stale.code).toBe("store.stale-epoch");
    expect(stale.details?.recoveryFacts?.unresolved?.[0]).toMatchObject({ component: "authority", path: "epoch", code: "store.stale-epoch" });
    expect(await footprint(fixture.context)).toEqual(published);

    // Nor is the old-epoch receipt served under the new generation: the same
    // operation id is simply no longer recorded there, so the retry is the
    // honest create-only refusal — no second row, revision or receipt.
    const reRead = catalogRevisionOf(fixture.context);
    const fresh = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        { ...request, expectedCatalogRevision: reRead, expected: current.token },
      ),
    );
    expect(fresh.code).toBe("execution.not-empty");
    expect(await footprint(fixture.context)).toEqual(published);
  });

  test("interrupted registration \u2014 an interruption before the commit leaves nothing and the retry converges on one registration (A05/A28)", async () => {
    const fixture = await activeFixture("interrupted-registration");
    const reviewed = planRequest({ context: fixture.context, operationId: "op-interrupted" });
    const before = await footprint(fixture.context);

    // invariant: A refused attempt stops at the collaboration boundary and publishes
    // nothing: no execution row, no catalog byte, no collaboration revision
    // advance. The deterministic refusal is recorded as this operation's
    // durable decline — the receipt a same-id retry reads.
    const interrupted = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        { ...reviewed, expectedCatalogRevision: 4, expected: fixture.rootToken },
      ),
    );
    expect(interrupted.code).toBe("catalog.revision-conflict");
    expect(await footprint(fixture.context)).toEqual({ ...before, effects: (before.effects as number) + 1 });
    const declined = await footprint(fixture.context);

    // why: The same id re-raises the recorded decline instead of re-evaluating (or
    // re-publishing) anything.
    expect(
      await refusalOf(() =>
        commitExecutionRegistration(
          { ...fixture.context, caller: fixture.caller },
          { ...reviewed, expectedCatalogRevision: 4, expected: fixture.rootToken },
        ),
      ),
    ).toMatchObject({ code: "catalog.revision-conflict" });
    expect(await footprint(fixture.context)).toEqual(declined);

    // invariant: The SAME normal intent under its own operation id completes exactly one
    // registration, and the creation facts are the reviewed call's own — the
    // original timestamp, the document-derived row — not a second attempt's.
    const accepted = await commitExecutionRegistration(
      { ...fixture.context, caller: fixture.caller },
      { ...planRequest({ context: fixture.context, operationId: "op-interrupted-retry" }), expected: fixture.rootToken },
    );
    const registered = await footprint(fixture.context);
    expect(registered).toMatchObject({
      root_revision: 2,
      store_revision: 1,
      catalog_revision: 1,
      collaboration_revision: 1,
      effects: 2,
      workflows: 1,
      registry: 1,
      plans: 1,
      inputs: 1,
      operations: 1,
      entities: 1,
      bindings: 1,
      pending: 0,
    });
    const header = await one<{ state_json: string }>(fixture.context, "select state_json from execution_workflows where workflow_id = ?", WORKFLOW_ID);
    expect(JSON.parse(String(header?.state_json))).toMatchObject({ id: WORKFLOW_ID, status: "running", started_at: TS });

    // No half-registered phantom: the lifecycle is addressable as exactly one
    // workflow with exactly one plan row.
    const state = await readExecutionState(fixture.context);
    expect(state.data.workflows.map((workflow) => workflow.state.id)).toEqual([WORKFLOW_ID]);
    expect(state.data.workflows[0]!.plans.map((view) => view.plan.id)).toEqual([PLAN_ID]);

    // note: A retry after the commit replays the one recorded receipt and adds
    // nothing, whatever tokens it re-read.
    const current = await readExecutionState(fixture.context);
    expect(
      await commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        { ...planRequest({ context: fixture.context, operationId: "op-interrupted-retry" }), expectedCatalogRevision: catalogRevisionOf(fixture.context), expected: current.token },
      ),
    ).toEqual(accepted);
    expect(await footprint(fixture.context)).toEqual(registered);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });
  test("shipped registration derives the CAS inputs and commits through the ACTIVE transaction", async () => {
    const fixture = await activeFixture("shipped-registration");
    const reviewed = planRequest({ context: fixture.context, operationId: "unused-shipped-operation" });
    const context: ExecutionContext = { ...fixture.context, caller: fixture.caller };
    const receipt = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: reviewed.workflow,
      expected: fixture.rootToken,
      expectedCatalogRevision: 0,
    });

    expect(receipt).toMatchObject({ workflowId: WORKFLOW_ID, catalogRevision: 1, recovered: false });
    expect(receipt.operationId).toMatch(/^op-[a-f0-9]{24}$/);
    expect(await footprint(fixture.context)).toMatchObject({
      workflows: 1,
      registry: 1,
      catalog_revision: 1,
      operations: 1,
      entities: 1,
      bindings: 1,
      pending: 0,
    });
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("shipped registration replays an identical retry that re-presents its ORIGINAL constraints", async () => {
    const fixture = await activeFixture("shipped-registration-replay");
    const reviewed = planRequest({ context: fixture.context, operationId: "unused-shipped-replay" });
    const context: ExecutionContext = { ...fixture.context, caller: fixture.caller };
    // The reviewed constraints the caller held before the lost response: the
    // registration advances both, so a retry carrying them is exactly the case
    // that must replay through the recorded receipt, not be judged stale.
    const constraints = { actor: "project-manager", workflow: reviewed.workflow, expected: fixture.rootToken, expectedCatalogRevision: 0 };
    const accepted = await registerShippedCatalogExecution(context, constraints);
    const registered = await footprint(fixture.context);
    expect(registered).toMatchObject({ root_revision: 2, catalog_revision: 1, operations: 1 });

    // Same operation id (derived), same original constraints: replayed.
    expect(await registerShippedCatalogExecution(context, constraints)).toEqual(accepted);
    expect(await footprint(fixture.context)).toEqual(registered);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("shipped registration refuses a stale constraint on a genuinely new operation and names the recovery", async () => {
    const fixture = await activeFixture("shipped-registration-stale");
    const first = planRequest({ context: fixture.context, operationId: "op-shipped-first" });
    const context: ExecutionContext = { ...fixture.context, caller: fixture.caller };
    await registerShippedCatalogExecution(context, { actor: "project-manager", workflow: first.workflow });

    const second = planRequest({ context: fixture.context, operationId: "op-shipped-second", workflowId: WORKFLOW_ID_ALT });
    const staleRoot = await refusalOf(() =>
      registerShippedCatalogExecution(context, { actor: "project-manager", workflow: second.workflow, expected: fixture.rootToken }),
    );
    expect(staleRoot.code).toBe("execution.stale-token");
    expect(staleRoot.message).toContain("mstar status validate");

    const current = await readExecutionState(fixture.context);
    const staleCatalog = await refusalOf(() =>
      registerShippedCatalogExecution(context, {
        actor: "project-manager",
        workflow: second.workflow,
        expected: current.token,
        expectedCatalogRevision: 0,
      }),
    );
    expect(staleCatalog.code).toBe("catalog.revision-conflict");
    expect(staleCatalog.message).toContain("omit the catalog expectation");
  });
});

/* note: ------------------------------------------------------------------------ *
 * The collaboration composite: witness, conflict and interruption
 * ------------------------------------------------------------------------ */

/**
 * invariant: Leave exactly what an interrupted finalization leaves behind: the
 * collaboration effect committed under its operation id, and none of the
 * execution delta that finalization would have written. This is fixture surgery
 * on a real store, not a mocked frame — the retry then exercises the real
 * reservation, effect replay and finalization.
 */
async function simulateInterruptedFinalization(
  context: StoreContext,
  operationId: string,
  workflowId: string,
): Promise<void> {
  await fixtureWrite(context, "delete from execution_operations where operation_id = ?", operationId);
  await fixtureWrite(context, "delete from catalog_execution_bindings where workflow_id = ?", workflowId);
  await fixtureWrite(context, "delete from execution_inputs where workflow_id = ?", workflowId);
  await fixtureWrite(context, "delete from execution_plans where workflow_id = ?", workflowId);
  await fixtureWrite(context, "delete from execution_registry where workflow_id = ?", workflowId);
  await fixtureWrite(context, "delete from execution_workflows where workflow_id = ?", workflowId);
  await fixtureWrite(
    context,
    "update execution_collaboration_intents set phase = 'prepared', receipt_json = null, updated_at = ? where operation_id = ?",
    TS,
    operationId,
  );
}

describe("collaboration registration replay", () => {
  test("collaboration registration replay \u2014 the witness preflight refuses a lane that is not active, before any reservation", async () => {
    const fixture = await activeFixture("replay-witness");
    const location = resolveCollaborationLocation(fixture.context);
    const before = await footprint(fixture.context);
    // note: A staged lane is not an authority a registration may publish into.
    const db = new DatabaseSync(location.dbPath);
    try {
      db.prepare("update collaboration_meta set authority_state = 'staged', activated_at = null where id = 1").run();
    } finally {
      db.close();
    }
    try {
      const refused = await refusalOf(() => registerPlanWorkflow(fixture, "op-witness-staged"));
      expect(refused.code).toBe("collaboration.not-active");
    } finally {
      const restore = new DatabaseSync(location.dbPath);
      try {
        restore.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(TS);
      } finally {
        restore.close();
      }
    }
    // note: Nothing was admitted: no reservation, no effect, no catalog byte.
    expect(await one<{ n: number }>(fixture.context, "select count(*) as n from execution_collaboration_intents")).toEqual({ n: 0 });
    expect(await footprint(fixture.context)).toEqual(before);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("collaboration registration replay \u2014 changed operands cannot reinterpret the pending payload, and the original resumes from its frozen catalog facts", async () => {
    const fixture = await activeFixture("replay-interrupted");
    const reviewed = planRequest({ context: fixture.context, operationId: "op-replay-interrupted" });
    const accepted = await commitExecutionRegistration(
      { ...fixture.context, caller: fixture.caller },
      { ...reviewed, expected: fixture.rootToken },
    );
    const published = await footprint(fixture.context);

    await simulateInterruptedFinalization(fixture.context, "op-replay-interrupted", WORKFLOW_ID);
    expect(await footprint(fixture.context)).toMatchObject({ workflows: 0, entities: 1, catalog_revision: 1, effects: 1 });

    // note: A DIFFERENT reviewed call under the same operation id is a conflict: the
    // reservation froze the first payload, and nothing touches the lane.
    const interrupted = await readExecutionState(fixture.context);
    const changed = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        { ...reviewed, actor: "project-manager-alt", expected: interrupted.token },
      ),
    );
    expect(changed.code).toBe("execution.operation-conflict");
    expect(await footprint(fixture.context)).toMatchObject({ workflows: 0, entities: 1, catalog_revision: 1, effects: 1 });

    // why: The ORIGINAL intent resumes. The caller supplies a catalog expectation
    // that is WRONG for the moved catalog: the frozen one wins, so the recorded
    // effect replays and no second delta publishes.
    const current = await readExecutionState(fixture.context);
    const resumed = await commitExecutionRegistration(
      { ...fixture.context, caller: fixture.caller },
      { ...reviewed, expectedCatalogRevision: 99, expected: current.token },
    );
    expect(resumed).toEqual(accepted);
    const finalized = await footprint(fixture.context);
    expect(finalized).toMatchObject({
      workflows: 1,
      registry: 1,
      plans: 1,
      inputs: 1,
      operations: 1,
      entities: 1,
      links: published.links,
      catalog_revision: 1,
      collaboration_revision: 1,
      effects: 1,
      pending: 0,
    });
    // note: The binding pins the EXACT catalog revision the effect receipt recorded,
    // not whatever the caller re-presented or the catalog holds now.
    expect(await bindingOf(fixture.context, WORKFLOW_ID)).toMatchObject({ catalog_revision: 1, catalog_id: PLAN_ID });

    // note: And the finalized replay is itself stable.
    const after = await readExecutionState(fixture.context);
    expect(
      await commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        { ...reviewed, expectedCatalogRevision: catalogRevisionOf(fixture.context), expected: after.token },
      ),
    ).toEqual(accepted);
    expect(await footprint(fixture.context)).toEqual(finalized);
  });

  test("collaboration registration replay \u2014 the shipped entry resolves the pending operation before enforcing a new-attempt catalog expectation", async () => {
    const fixture = await activeFixture("replay-shipped-pending");
    const reviewed = planRequest({ context: fixture.context, operationId: "unused-shipped-pending" });
    const context: ExecutionContext = { ...fixture.context, caller: fixture.caller };
    // note: The reviewed constraint the caller held before the lost response.
    const accepted = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: reviewed.workflow,
      expected: fixture.rootToken,
      expectedCatalogRevision: 0,
    });
    await simulateInterruptedFinalization(fixture.context, accepted.operationId, WORKFLOW_ID);
    // invariant: The catalog moved to 1 with no execution receipt, yet the retry with its
    // ORIGINAL reviewed expectation must reach the frozen pending expectation
    // and replay the committed effect instead of refusing a new-attempt CAS.
    const pending = await readExecutionState(fixture.context);
    const resumed = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: reviewed.workflow,
      expected: pending.token,
      expectedCatalogRevision: 0,
    });
    expect(resumed).toEqual(accepted);
    expect(await footprint(fixture.context)).toMatchObject({
      workflows: 1,
      registry: 1,
      plans: 1,
      inputs: 1,
      operations: 1,
      entities: 1,
      catalog_revision: 1,
      collaboration_revision: 1,
      effects: 1,
      pending: 0,
    });
    // note: A genuinely NEW attempt still enforces its own reviewed expectation.
    const fresh = await readExecutionState(fixture.context);
    await expect(
      registerShippedCatalogExecution(context, {
        actor: "project-manager",
        workflow: planRequest({ context: fixture.context, operationId: "unused-shipped-pending-2", workflowId: WORKFLOW_ID_ALT }).workflow,
        expected: fresh.token,
        expectedCatalogRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "catalog.revision-conflict" });
  });
});


/* ------------------------------------------------------------------------ *
 * note: §7 the REMOTE registration route: the shipped wrapper resolves its authority
 * from the checkout's private cache and the composite freezes one outbox intent
 * ------------------------------------------------------------------------ */

/** note: One reviewed plan registration against a REMOTE project journal. */
function remotePlanWorkflow(
  context: StoreContext,
  input: { planId: string; title: string; workflowId: string; project?: string },
): RegisterPlanWorkflowOptions {
  writePlanDocument(context.harnessDir, input.planId, input.title);
  return {
    harnessDir: context.harnessDir,
    plan: { id: input.planId, title: input.title, file: `plans/${input.planId}.md` },
    deliveryKind: "development",
    branchWork: `feature/${input.workflowId}`,
    branchTarget: "main",
    project: input.project ?? REMOTE_IDS.projectId,
    startedAt: TS,
  };
}

/** note: One reviewed ITERATION registration against a REMOTE project journal. */
function remoteIterationWorkflow(
  context: StoreContext,
  input: { iterationId: string; rows: Array<{ planId: string; title: string }> },
): RegisterIterationWorkflowOptions {
  const compassRef = writeReviewedCompass(context.harnessDir, input.iterationId);
  return {
    harnessDir: context.harnessDir,
    compassRef,
    branch: { base: "main", integration: `iteration/${input.iterationId}`, target: "main" },
    rows: input.rows.map((row) => {
      writePlanDocument(context.harnessDir, row.planId, row.title);
      return { id: row.planId, title: row.title, file: `plans/${row.planId}.md` };
    }),
    project: REMOTE_IDS.projectId,
    startedAt: TS,
  };
}

type RemoteFixture = Readonly<{
  scope: ReturnType<typeof createRemoteScope>;
  commit: string;
  context: StoreContext;
  caller: ExecutionCaller;
  token: ExecutionToken;
}>;

/**
 * note: A remote-bound checkout whose cache holds one complete observation: the reviewed
 * bind, the observed project scope, and an ACTIVE (empty) execution authority.
 */
async function remoteFixture(label: string): Promise<RemoteFixture> {
  const scope = createRemoteScope(ROOT, label);
  const commit = scope.publish();
  const context = scope.context();
  await bindRemoteAuthority(context, scope.batch(commit));
  const check = positiveCheck();
  await ingestRemoteObservation(context, submission(commit, check, completeSnapshot(check), 0));
  await initializeStore(context).then((handle) => handle.close());
  const state = await readExecutionState(context);
  return {
    scope,
    commit,
    context,
    caller: { sessionId: COORDINATOR_ID, role: "coordinator", workflowId: WORKFLOW_ID },
    token: state.token,
  };
}

/** note: The cache's outbox rows, newest last, as the composite froze them. */
function outboxRows(context: StoreContext): Array<Record<string, unknown>> {
  const db = new DatabaseSync(resolveCollaborationLocation(context).dbPath);
  try {
    return db
      .prepare("select operation_id, state, request_json from remote_outbox order by created_at, operation_id")
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

/** note: The cache's highest stored observation revision for the fixture project. */
function observedRevision(context: StoreContext): number {
  const db = new DatabaseSync(resolveCollaborationLocation(context).dbPath);
  try {
    const row = db
      .prepare("select revision from remote_observations where project_key = ? order by revision desc limit 1")
      .get(REMOTE_IDS.projectId) as { revision?: unknown } | undefined;
    return typeof row?.revision === "number" ? row.revision : 0;
  } finally {
    db.close();
  }
}

/** note: The execution reservation of one composite operation, as the ledger recorded it. */
async function reservationRow(context: StoreContext, operationId: string) {
  return await one<{ phase?: string; cause_code?: string | null; cause_message?: string | null }>(
    context,
    "select phase, cause_code, cause_message from execution_collaboration_intents where operation_id = ?",
    operationId,
  );
}

/** note: The provider operation id a remote composite froze, from its partial refusal. */
function frozenProviderIntent(error: unknown): string {
  if (error === null || typeof error !== "object" || !("details" in error)) {
    throw new Error("fixture: the refusal carries no details");
  }
  const details = error.details;
  const frozen =
    details !== null && typeof details === "object" && "frozen_components" in details
      ? details.frozen_components
      : undefined;
  if (!Array.isArray(frozen) || typeof frozen[0] !== "string") {
    throw new Error(`fixture: the refusal names no frozen provider intent (${JSON.stringify(frozen)})`);
  }
  return frozen[0];
}

/** note: The refusal's structured details, as the CLI publishes them. */
function detailsOf(error: unknown): Record<string, unknown> {
  if (error === null || typeof error !== "object" || !("details" in error)) return {};
  const details = (error as { details?: unknown }).details;
  return details !== null && typeof details === "object" ? (details as Record<string, unknown>) : {};
}

/** note: The trusted caller of ONE registration: it must name the workflow that request creates. */
function registrationContext(fixture: RemoteFixture, workflowId: string): ExecutionContext {
  return { ...fixture.context, caller: { ...fixture.caller, workflowId } };
}

describe("remotely bound shipped registration", () => {
  test("reaches the registration composite and enqueues its catalog intent", async () => {
    const fixture = await remoteFixture("remote-register-shipped");
    const workflow = remotePlanWorkflow(fixture.context, {
      planId: "20260921-remote-plan",
      title: "Remote plan",
      workflowId: WORKFLOW_ID,
    });
    const context = registrationContext(fixture, WORKFLOW_ID);
    const refused = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "plan", workflowId: WORKFLOW_ID, options: workflow },
      operationId: "op-remote-register",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    // invariant: The provider intent is durable but unconfirmed, so the composite reports its
    // partial state instead of success — never the local-lane refusal that came before it.
    expect(refused).toMatchObject({ code: "collaboration.operation-partial" });
    const rows = outboxRows(fixture.context);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation_id: frozenProviderIntent(refused), state: "enqueued" });
    const frozen = JSON.parse(String(rows[0]!.request_json)) as {
      event: { change: { kind: string; project: { catalogEntities: Array<{ kind: string; id: string }> } } };
    };
    expect(frozen.event.change.kind).toBe("project-replace");
    expect(frozen.event.change.project.catalogEntities).toContainEqual(
      expect.objectContaining({ kind: "plan", id: "20260921-remote-plan" }),
    );
  });

  test("a deterministic preparation refusal declines its reservation so a corrected retry proceeds", async () => {
    const fixture = await remoteFixture("remote-register-decline");
    // note: One earlier registration leaves an enqueued intent ahead of this test's attempts.
    await registerShippedCatalogExecution(registrationContext(fixture, WORKFLOW_ID), {
      actor: "project-manager",
      workflow: {
        kind: "plan",
        workflowId: WORKFLOW_ID,
        options: remotePlanWorkflow(fixture.context, { planId: "20260921-first", title: "First", workflowId: WORKFLOW_ID }),
      },
      operationId: "op-remote-first",
      expected: fixture.token,
    }).catch(() => undefined);

    // why: `plan-1` is already registered in the OBSERVED project, so the frozen delta can never
    // publish: a deterministic refusal of the preparation itself, before any provider intent.
    const conflicting = {
      kind: "plan" as const,
      workflowId: WORKFLOW_ID_ALT,
      options: remotePlanWorkflow(fixture.context, { planId: "plan-1", title: "Plan one", workflowId: WORKFLOW_ID_ALT }),
    };
    await expect(
      registerShippedCatalogExecution(registrationContext(fixture, WORKFLOW_ID_ALT), {
        actor: "project-manager",
        workflow: conflicting,
        operationId: "op-remote-conflict",
        expected: fixture.token,
      }),
    ).rejects.toMatchObject({ code: "catalog.duplicate" });
    // invariant: The reservation is DECLINED, not left prepared: it blocks no corrected retry.
    expect(await reservationRow(fixture.context, "op-remote-conflict")).toMatchObject({
      phase: "declined",
      cause_code: "catalog.duplicate",
    });

    // note: The corrected request proceeds under a NEW operation id and enqueues its own intent.
    const corrected = await registerShippedCatalogExecution(registrationContext(fixture, WORKFLOW_ID_THIRD), {
      actor: "project-manager",
      workflow: {
        kind: "plan",
        workflowId: WORKFLOW_ID_THIRD,
        options: remotePlanWorkflow(fixture.context, {
          planId: "20260921-corrected",
          title: "Corrected",
          workflowId: WORKFLOW_ID_THIRD,
        }),
      },
      operationId: "op-remote-corrected",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    expect(corrected).toMatchObject({ code: "collaboration.operation-partial" });
    expect(outboxRows(fixture.context).map((row) => row.state)).not.toContain("abandoned");
    expect(outboxRows(fixture.context)).toHaveLength(2);
  });

  test("finalizes from a confirmed resolved_by repair instead of waiting on the conflicted intent", async () => {
    const fixture = await remoteFixture("remote-register-repair");
    const context = registrationContext(fixture, WORKFLOW_ID);
    const options = remotePlanWorkflow(fixture.context, {
      planId: "20260921-repaired",
      title: "Repaired",
      workflowId: WORKFLOW_ID,
    });
    const conflicted = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
      operationId: "op-remote-repair",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    const providerIntent = frozenProviderIntent(conflicted);

    // note: The provider recorded a fork instead of the effect; a reviewed resolution replaces it.
    const heads = await conflictFrozenIntent(fixture.context, providerIntent);
    const original = await readRemoteIntent(fixture.context, providerIntent);
    if (original.event === null) throw new Error("fixture: the conflicted intent discloses no frozen event");
    const resolutionId = "00000000-0000-4000-8000-0000000008aa";
    await prepareRemoteResolution(fixture.context, providerIntent, {
      operationId: resolutionId,
      operator: "ops-engineer",
      reason: "merge the fork",
      event: { ...original.event, operationId: resolutionId, parents: heads },
    });
    await confirmFrozenIntent(fixture.context, resolutionId);

    // invariant: The reissue interprets the live chain and commits the execution delta from the
    // REPLACEMENT receipt, so the plan is never left waiting on the conflicted original.
    const accepted = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
      operationId: "op-remote-repair",
      expected: fixture.token,
    });
    expect(accepted).toMatchObject({ operationId: "op-remote-repair", workflowId: WORKFLOW_ID, recovered: false });
    expect(await reservationRow(fixture.context, "op-remote-repair")).toMatchObject({ phase: "confirmed" });
    // invariant: The binding is written from the confirmed replacement's journal: the workflow is
    // bound to the reviewed plan row the provider actually carries, at the pinned revision 0.
    expect(await bindingOf(fixture.context, WORKFLOW_ID)).toMatchObject({
      catalog_kind: "plan",
      catalog_id: "20260921-repaired",
      catalog_revision: 0,
    });
  });

  test("a confirmed repair that settles the fork but omits the reviewed plan writes no execution binding", async () => {
    const fixture = await remoteFixture("remote-register-repair-omits-plan");
    const context = registrationContext(fixture, WORKFLOW_ID);
    const options = remotePlanWorkflow(fixture.context, {
      planId: "20260921-omitted",
      title: "Omitted",
      workflowId: WORKFLOW_ID,
    });
    const pending = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
      operationId: "op-remote-omitted",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    const providerIntent = frozenProviderIntent(pending);

    // note: The provider recorded a fork; the reviewed replacement settles it but publishes a
    // journal WITHOUT the reviewed plan — a legal project-replace that omits the outcome.
    const heads = await conflictFrozenIntent(fixture.context, providerIntent);
    const original = await readRemoteIntent(fixture.context, providerIntent);
    if (original.event === null || original.event.change.kind !== "project-replace") {
      throw new Error("fixture: the conflicted intent discloses no frozen journal");
    }
    const resolutionId = "00000000-0000-4000-8000-0000000008ba";
    const stripped = {
      ...original.event.change.project,
      catalogEntities: (original.event.change.project.catalogEntities as Array<{ kind: string; id: string }>).filter(
        (row) => !(row.kind === "plan" && row.id === "20260921-omitted"),
      ),
    };
    await prepareRemoteResolution(fixture.context, providerIntent, {
      operationId: resolutionId,
      operator: "ops-engineer",
      reason: "settle the fork without the plan",
      event: {
        ...original.event,
        operationId: resolutionId,
        parents: heads,
        change: { kind: "project-replace", project: stripped },
      },
    });
    await confirmFrozenIntent(fixture.context, resolutionId);

    // invariant: The settlement carries no reviewed outcome, so the reservation is declined with
    // the settled disclosure and NO execution workflow or binding is recorded from a guess.
    await expect(
      registerShippedCatalogExecution(context, {
        actor: "project-manager",
        workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
        operationId: "op-remote-omitted",
        expected: fixture.token,
      }),
    ).rejects.toMatchObject({ code: "remote.effect-mismatch" });
    expect(await reservationRow(fixture.context, "op-remote-omitted")).toMatchObject({
      phase: "declined",
      cause_code: "remote.effect-mismatch",
    });
    expect(await bindingOf(fixture.context, WORKFLOW_ID)).toBeUndefined();

    // invariant: The supported correction route works: the settled repair invalidated the cached
    // base, so the operator re-observes at the cache's current revision first; a NEW registration
    // under a new operation id is then admitted and enqueues its own intent.
    const cacheDb = new DatabaseSync(resolveCollaborationLocation(fixture.context).dbPath);
    let revision = 0;
    try {
      const row = cacheDb
        .prepare("select revision from remote_observations where project_key = ? order by revision desc limit 1")
        .get(REMOTE_IDS.projectId) as { revision?: unknown } | undefined;
      revision = typeof row?.revision === "number" ? row.revision : 0;
    } finally {
      cacheDb.close();
    }
    await ingestRemoteObservation(fixture.context, submission(fixture.commit, positiveCheck(), completeSnapshot(positiveCheck()), revision));
    const corrected = await registerShippedCatalogExecution(registrationContext(fixture, WORKFLOW_ID_ALT), {
      actor: "project-manager",
      workflow: {
        kind: "plan",
        workflowId: WORKFLOW_ID_ALT,
        options: remotePlanWorkflow(fixture.context, {
          planId: "20260921-omitted-corrected",
          title: "Corrected",
          workflowId: WORKFLOW_ID_ALT,
        }),
      },
      operationId: "op-remote-omitted-corrected",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    expect(corrected).toMatchObject({ code: "collaboration.operation-partial" });
    expect(outboxRows(fixture.context).some((row) => row.state === "enqueued")).toBe(true);
  }, 30_000);

  test("a confirmed repair that keeps the reviewed ids but changes a field writes no execution binding", async () => {
    const fixture = await remoteFixture("remote-register-repair-changed-field");
    const context = registrationContext(fixture, WORKFLOW_ID);
    const planId = "20260921-changed-field";
    const options = remotePlanWorkflow(fixture.context, {
      planId,
      title: "Reviewed title",
      workflowId: WORKFLOW_ID,
    });
    const pending = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
      operationId: "op-remote-changed-field",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    const providerIntent = frozenProviderIntent(pending);

    // note: The reviewed replacement settles the fork but publishes the same plan ID with another
    // title — a legal project-replace that keeps every ID and changes the reviewed content.
    const heads = await conflictFrozenIntent(fixture.context, providerIntent);
    const original = await readRemoteIntent(fixture.context, providerIntent);
    if (original.event === null || original.event.change.kind !== "project-replace") {
      throw new Error("fixture: the conflicted intent discloses no frozen journal");
    }
    const journal = original.event.change.project;
    const resolutionId = "00000000-0000-4000-8000-0000000008c1";
    const settledJournal = {
      ...journal,
      catalogEntities: (journal.catalogEntities as Array<Record<string, unknown>>).map((row) =>
        row.kind === "plan" && row.id === planId ? { ...row, title: "Settled title" } : row,
      ),
    } as unknown as ReturnType<typeof completeSnapshot>["project"];
    await prepareRemoteResolution(fixture.context, providerIntent, {
      operationId: resolutionId,
      operator: "ops-engineer",
      reason: "settle the fork with another spelling",
      event: {
        ...original.event,
        operationId: resolutionId,
        parents: heads,
        change: { kind: "project-replace", project: settledJournal },
      },
    });
    await confirmFrozenIntent(fixture.context, resolutionId);

    // invariant: ID presence is not the reviewed outcome: the changed portable field is disclosed
    // with the settled operation and record, and no execution workflow or binding is recorded.
    const refused = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
      operationId: "op-remote-changed-field",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "remote.effect-mismatch" });
    expect(detailsOf(refused)).toMatchObject({
      settled_operations: [resolutionId],
      mismatched_entity: { kind: "plan", id: planId },
      // invariant: The settled provider work is durable and the decline names it, so the replay
      // never claims an effect-free operation.
      confirmed_components: [`provider:${resolutionId}`],
    });
    expect(detailsOf(refused).settled_records).toHaveLength(1);
    // invariant: The advertised correction is ONE ordered, runnable route — the CLI forwards the
    // project only when it is given, so the printed form must carry the journal's own --project or
    // a remote catalog write refuses `catalog.invalid-entity`. The structured recovery field names
    // the same route the message does.
    const advertised = String(detailsOf(refused).recovery);
    const correction = `mstar catalog update plan ${planId}`;
    expect(refused instanceof Error ? refused.message : "").toContain(correction);
    expect(advertised).toContain(correction);
    for (const text of [refused instanceof Error ? refused.message : "", advertised]) {
      expect(text).toContain(`--project ${REMOTE_IDS.projectId}`);
      expect(text.indexOf("mstar catalog update")).toBeLessThan(text.indexOf("reissue this SAME registration"));
    }
    expect(await bindingOf(fixture.context, WORKFLOW_ID)).toBeUndefined();
    expect(await reservationRow(fixture.context, "op-remote-changed-field")).toMatchObject({
      phase: "declined",
      cause_code: "remote.effect-mismatch",
    });

    // note: The settled repair invalidated the cached base, so the operator re-observes the
    // settled journal before the correcting catalog write.
    const settledCheck = positiveCheck();
    const settledBase = completeSnapshot(settledCheck);
    await ingestRemoteObservation(
      fixture.context,
      submission(
        fixture.commit,
        settledCheck,
        { ...settledBase, project: { ...settledBase.project, ...settledJournal } },
        observedRevision(fixture.context),
      ),
    );

    // note: The reviewed value is settled through its OWN remote catalog write, addressed at the
    // observed row revision — the correction the refusal advertises.
    const updateId = "00000000-0000-4000-8000-0000000008c4";
    const pendingUpdate = await updateCatalogEntity(
      fixture.context,
      { kind: "plan", id: planId },
      { title: "Reviewed title" },
      1,
      { operationId: updateId, actor: "ops-engineer", projectId: REMOTE_IDS.projectId },
    ).catch((error: unknown) => error);
    expect(pendingUpdate).toMatchObject({ code: "remote.effect-pending" });
    await confirmFrozenIntent(fixture.context, updateId);
    const update = await readRemoteIntent(fixture.context, updateId);
    if (update.event === null || update.event.change.kind !== "project-replace") {
      throw new Error("fixture: the confirmed catalog update discloses no journal");
    }
    expect(update.state).toBe("confirmed");
    const updatedJournal = update.event.change.project as unknown as ReturnType<typeof completeSnapshot>["project"];
    expect(
      updatedJournal.catalogEntities.find((row) => row.kind === "plan" && row.id === planId),
    ).toMatchObject({ title: "Reviewed title", revision: 2 });

    // invariant: Re-observing the settled journal and reissuing the SAME registration for the SAME
    // workflow registers it: the settled row is identical, so it is adopted, not rewritten.
    const correctedCheck = positiveCheck();
    const correctedBase = completeSnapshot(correctedCheck);
    await ingestRemoteObservation(
      fixture.context,
      submission(
        fixture.commit,
        correctedCheck,
        { ...correctedBase, project: { ...correctedBase.project, ...updatedJournal } },
        observedRevision(fixture.context),
      ),
    );
    const reissued = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
      operationId: "op-remote-changed-field-corrected",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    expect(reissued).toMatchObject({ code: "collaboration.operation-partial" });
    const correctedIntent = frozenProviderIntent(reissued);
    const frozenJournal = JSON.parse(
      String(outboxRows(fixture.context).find((row) => row.operation_id === correctedIntent)?.request_json),
    ) as { event: { change: { project: { catalogEntities: Array<Record<string, unknown>> } } } };
    const adopted = frozenJournal.event.change.project.catalogEntities.filter(
      (row) => row.kind === "plan" && row.id === planId,
    );
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ title: "Reviewed title", revision: 2 });

    await confirmFrozenIntent(fixture.context, correctedIntent);
    expect(
      await registerShippedCatalogExecution(context, {
        actor: "project-manager",
        workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
        operationId: "op-remote-changed-field-corrected",
        expected: fixture.token,
      }),
    ).toMatchObject({ operationId: "op-remote-changed-field-corrected", workflowId: WORKFLOW_ID });
    expect(await bindingOf(fixture.context, WORKFLOW_ID)).toMatchObject({
      catalog_kind: "plan",
      catalog_id: planId,
      catalog_revision: 0,
    });
  }, 30_000);

  test("a confirmed repair that preserves every id but drops a required link writes no execution binding", async () => {
    const fixture = await remoteFixture("remote-register-repair-dropped-link");
    const iterationId = "20260921-remote-dropped-link";
    const planId = "20260921-dropped-link-plan";
    const options = remoteIterationWorkflow(fixture.context, {
      iterationId,
      rows: [{ planId, title: "Linked plan" }],
    });
    const context = registrationContext(fixture, iterationId);
    const pending = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "iteration", workflowId: iterationId, options },
      operationId: "op-remote-dropped-link",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    const providerIntent = frozenProviderIntent(pending);

    // note: The reviewed replacement settles the fork and publishes EVERY entity row but omits the
    // reviewed `plan belongs-to iteration` link the shipped iteration emits.
    const heads = await conflictFrozenIntent(fixture.context, providerIntent);
    const original = await readRemoteIntent(fixture.context, providerIntent);
    if (original.event === null || original.event.change.kind !== "project-replace") {
      throw new Error("fixture: the conflicted intent discloses no frozen journal");
    }
    const journal = original.event.change.project;
    const resolutionId = "00000000-0000-4000-8000-0000000008c2";
    await prepareRemoteResolution(fixture.context, providerIntent, {
      operationId: resolutionId,
      operator: "ops-engineer",
      reason: "settle the fork without the membership link",
      event: {
        ...original.event,
        operationId: resolutionId,
        parents: heads,
        change: {
          kind: "project-replace",
          project: {
            ...journal,
            catalogLinks: (journal.catalogLinks as Array<Record<string, unknown>>).filter(
              (link) => !(link.fromKind === "plan" && link.fromId === planId && link.relation === "belongs-to"),
            ),
          },
        },
      },
    });
    await confirmFrozenIntent(fixture.context, resolutionId);

    // invariant: The reviewed relation is part of the business outcome; its absence is disclosed
    // and declined instead of binding the workflow from an incomplete settlement.
    const refused = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "iteration", workflowId: iterationId, options },
      operationId: "op-remote-dropped-link",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "remote.effect-mismatch" });
    expect(detailsOf(refused)).toMatchObject({
      settled_operations: [resolutionId],
      missing_link: {
        from: { kind: "plan", id: planId },
        relation: "belongs-to",
        to: { kind: "iteration", id: iterationId },
      },
    });
    expect(await bindingOf(fixture.context, iterationId)).toBeUndefined();
    expect(await reservationRow(fixture.context, "op-remote-dropped-link")).toMatchObject({
      phase: "declined",
      cause_code: "remote.effect-mismatch",
    });
  }, 30_000);

  test("a journal carrying the reviewed relation at another ordinal is settled as ONE edge", async () => {
    const fixture = await remoteFixture("remote-register-link-ordinal");
    const iterationId = "20260921-remote-link-ordinal";
    const planId = "20260921-link-ordinal-plan";
    const options = remoteIterationWorkflow(fixture.context, {
      iterationId,
      rows: [{ planId, title: "Ordered plan" }],
    });
    const context = registrationContext(fixture, iterationId);
    // note: The observed journal already carries the reviewed membership at ordinal 2 (an earlier
    // settled write), while the reviewed delta asks for ordinal 0.
    const check = positiveCheck();
    const base = completeSnapshot(check);
    await ingestRemoteObservation(
      fixture.context,
      submission(
        fixture.commit,
        check,
        {
          ...base,
          project: {
            ...base.project,
            catalogLinks: [
              { fromKind: "plan", fromId: planId, relation: "belongs-to", toKind: "iteration", toId: iterationId, ordinal: 2 },
            ],
          },
        },
        observedRevision(fixture.context),
      ),
    );
    const pending = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "iteration", workflowId: iterationId, options },
      operationId: "op-remote-link-ordinal",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    const providerIntent = frozenProviderIntent(pending);
    const row = outboxRows(fixture.context).find((entry) => entry.operation_id === providerIntent);
    const frozen = JSON.parse(String(row?.request_json)) as {
      event: { change: { project: { catalogLinks: Array<Record<string, unknown>> } } };
    };
    const edges = frozen.event.change.project.catalogLinks.filter(
      (link) =>
        link.fromKind === "plan" &&
        link.fromId === planId &&
        link.relation === "belongs-to" &&
        link.toKind === "iteration" &&
        link.toId === iterationId,
    );
    // invariant: Link identity is endpoints plus relation, so the settled ordinal-2 row is REPLACED by
    // the reviewed ordinal 0 instead of publishing a second parallel membership edge.
    expect(edges).toEqual([
      { fromKind: "plan", fromId: planId, relation: "belongs-to", toKind: "iteration", toId: iterationId, ordinal: 0 },
    ]);
  }, 30_000);

  test("a journal that already duplicated the reviewed membership settles as ONE edge and finalizes", async () => {
    const fixture = await remoteFixture("remote-register-link-parallel");
    const iterationId = "20260921-remote-link-parallel";
    const planId = "20260921-link-parallel-plan";
    const options = remoteIterationWorkflow(fixture.context, {
      iterationId,
      rows: [{ planId, title: "Twice-linked plan" }],
    });
    const context = registrationContext(fixture, iterationId);
    // note: An earlier settlement left TWO parallel rows for the same relation, at ordinals 0 and 2.
    const check = positiveCheck();
    const base = completeSnapshot(check);
    await ingestRemoteObservation(
      fixture.context,
      submission(
        fixture.commit,
        check,
        {
          ...base,
          project: {
            ...base.project,
            catalogLinks: [
              { fromKind: "plan", fromId: planId, relation: "belongs-to", toKind: "iteration", toId: iterationId, ordinal: 0 },
              { fromKind: "plan", fromId: planId, relation: "belongs-to", toKind: "iteration", toId: iterationId, ordinal: 2 },
            ],
          },
        },
        observedRevision(fixture.context),
      ),
    );
    const pending = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "iteration", workflowId: iterationId, options },
      operationId: "op-remote-link-parallel",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    const providerIntent = frozenProviderIntent(pending);
    const row = outboxRows(fixture.context).find((entry) => entry.operation_id === providerIntent);
    const frozen = JSON.parse(String(row?.request_json)) as {
      event: { change: { project: { catalogLinks: Array<Record<string, unknown>> } } };
    };
    // invariant: BOTH duplicated rows are replaced by the ONE reviewed edge (the reviewed ordinal
    // wins), so the finalization's one-edge-per-relation proof can pass instead of declining forever.
    expect(
      frozen.event.change.project.catalogLinks.filter(
        (link) =>
          link.fromKind === "plan" &&
          link.fromId === planId &&
          link.relation === "belongs-to" &&
          link.toKind === "iteration" &&
          link.toId === iterationId,
      ),
    ).toEqual([
      { fromKind: "plan", fromId: planId, relation: "belongs-to", toKind: "iteration", toId: iterationId, ordinal: 0 },
    ]);
    await confirmFrozenIntent(fixture.context, providerIntent);
    const committed = await readRemoteIntent(fixture.context, providerIntent);
    if (committed.event === null || committed.event.change.kind !== "project-replace") {
      throw new Error("fixture: the confirmed intent discloses no journal");
    }
    expect(
      (committed.event.change.project.catalogLinks as Array<Record<string, unknown>>).filter(
        (link) =>
          link.fromKind === "plan" &&
          link.fromId === planId &&
          link.relation === "belongs-to" &&
          link.toKind === "iteration" &&
          link.toId === iterationId,
      ),
    ).toEqual([
      { fromKind: "plan", fromId: planId, relation: "belongs-to", toKind: "iteration", toId: iterationId, ordinal: 0 },
    ]);
    // invariant: The registration finalizes: exactly one edge per reviewed relation is the proof the
    // execution binding is written from.
    expect(
      await registerShippedCatalogExecution(context, {
        actor: "project-manager",
        workflow: { kind: "iteration", workflowId: iterationId, options },
        operationId: "op-remote-link-parallel",
        expected: fixture.token,
      }),
    ).toMatchObject({ operationId: "op-remote-link-parallel", workflowId: iterationId });
    expect(await bindingOf(fixture.context, iterationId)).toMatchObject({
      catalog_kind: "iteration",
      catalog_id: iterationId,
      catalog_revision: 0,
    });
  }, 30_000);

  test("a same-target correction after a partial settlement adopts the settled rows and publishes the omission", async () => {
    const fixture = await remoteFixture("remote-register-partial-correction");
    const iterationId = "20260921-remote-partial-correction";
    const firstPlan = "20260921-correction-a";
    const secondPlan = "20260921-correction-b";
    const options = remoteIterationWorkflow(fixture.context, {
      iterationId,
      rows: [
        { planId: firstPlan, title: "First row" },
        { planId: secondPlan, title: "Second row" },
      ],
    });
    const context = registrationContext(fixture, iterationId);
    const pending = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "iteration", workflowId: iterationId, options },
      operationId: "op-remote-partial-correction",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    const providerIntent = frozenProviderIntent(pending);

    // note: The reviewed replacement publishes the iteration, its first plan row and the links it
    // carries — and omits the second plan row.
    const heads = await conflictFrozenIntent(fixture.context, providerIntent);
    const original = await readRemoteIntent(fixture.context, providerIntent);
    if (original.event === null || original.event.change.kind !== "project-replace") {
      throw new Error("fixture: the conflicted intent discloses no frozen journal");
    }
    const journal = original.event.change.project as unknown as ReturnType<typeof completeSnapshot>["project"];
    const resolutionId = "00000000-0000-4000-8000-0000000008c3";
    const settledJournal = {
      ...journal,
      catalogEntities: journal.catalogEntities.filter((row) => !(row.kind === "plan" && row.id === secondPlan)),
      catalogLinks: journal.catalogLinks.filter((link) => !(link.fromKind === "plan" && link.fromId === secondPlan)),
    };
    await prepareRemoteResolution(fixture.context, providerIntent, {
      operationId: resolutionId,
      operator: "ops-engineer",
      reason: "settle the fork with the first row only",
      event: {
        ...original.event,
        operationId: resolutionId,
        parents: heads,
        change: { kind: "project-replace", project: settledJournal },
      },
    });
    await confirmFrozenIntent(fixture.context, resolutionId);
    await expect(
      registerShippedCatalogExecution(context, {
        actor: "project-manager",
        workflow: { kind: "iteration", workflowId: iterationId, options },
        operationId: "op-remote-partial-correction",
        expected: fixture.token,
      }),
    ).rejects.toMatchObject({ code: "remote.effect-mismatch" });

    // invariant: The same-outcome correction is the SAME registration under a NEW operation id: the
    // rows the settlement already carries identically are adopted and only the omission is
    // published, so the already-published rows never trip their create-only check.
    const cacheDb = new DatabaseSync(resolveCollaborationLocation(fixture.context).dbPath);
    let revision = 0;
    try {
      const row = cacheDb
        .prepare("select revision from remote_observations where project_key = ? order by revision desc limit 1")
        .get(REMOTE_IDS.projectId) as { revision?: unknown } | undefined;
      revision = typeof row?.revision === "number" ? row.revision : 0;
    } finally {
      cacheDb.close();
    }
    const check = positiveCheck();
    const base = completeSnapshot(check);
    await ingestRemoteObservation(
      fixture.context,
      submission(
        fixture.commit,
        check,
        { ...base, project: { ...base.project, ...settledJournal } },
        revision,
      ),
    );
    const corrected = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "iteration", workflowId: iterationId, options },
      operationId: "op-remote-partial-correction-2",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    expect(corrected).toMatchObject({ code: "collaboration.operation-partial" });
    const enqueued = outboxRows(fixture.context).filter((row) => row.state === "enqueued");
    expect(enqueued).toHaveLength(1);
    const frozen = JSON.parse(String(enqueued[0]!.request_json)) as {
      event: { change: { project: { catalogEntities: Array<Record<string, unknown>>; catalogLinks: Array<Record<string, unknown>> } } };
    };
    const entities = frozen.event.change.project.catalogEntities;
    const links = frozen.event.change.project.catalogLinks;
    expect(entities.filter((row) => row.kind === "plan" && row.id === firstPlan)).toHaveLength(1);
    expect(entities).toContainEqual(expect.objectContaining({ kind: "plan", id: secondPlan, title: "Second row" }));
    expect(links.filter((link) => link.fromId === firstPlan)).toHaveLength(1);
    expect(links).toContainEqual(
      expect.objectContaining({ fromKind: "plan", fromId: secondPlan, relation: "belongs-to", toKind: "iteration" }),
    );
  }, 30_000);

  test("a confirmed settlement with an undisclosed receipt keeps its reservation instead of finalizing", async () => {
    const fixture = await remoteFixture("remote-register-repair-undisclosed");
    const context = registrationContext(fixture, WORKFLOW_ID);
    const options = remotePlanWorkflow(fixture.context, {
      planId: "20260921-undisclosed",
      title: "Undisclosed",
      workflowId: WORKFLOW_ID,
    });
    const pending = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
      operationId: "op-remote-undisclosed",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    const providerIntent = frozenProviderIntent(pending);
    const heads = await conflictFrozenIntent(fixture.context, providerIntent);
    const original = await readRemoteIntent(fixture.context, providerIntent);
    if (original.event === null) throw new Error("fixture: the conflicted intent discloses no frozen event");
    const resolutionId = "00000000-0000-4000-8000-0000000008bb";
    await prepareRemoteResolution(fixture.context, providerIntent, {
      operationId: resolutionId,
      operator: "ops-engineer",
      reason: "merge the fork",
      event: { ...original.event, operationId: resolutionId, parents: heads },
    });
    await confirmFrozenIntent(fixture.context, resolutionId);

    // note: The access check expires, so the repair's receipt is withheld (metadata-only
    // disclosure): state alone is not a receipt, and the composite proves nothing here.
    const db = new DatabaseSync(resolveCollaborationLocation(fixture.context).dbPath);
    try {
      db.prepare("update remote_bindings set verified_at = ?").run(new Date(Date.now() - 61_000).toISOString());
    } finally {
      db.close();
    }
    const refused = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
      operationId: "op-remote-undisclosed",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    // invariant: The composite's own replay gate refuses first (the frozen request is withheld),
    // so the settlement is never read from state alone: the reservation stays prepared, and no
    // execution binding is written until the receipt is readable again.
    expect(refused).toMatchObject({ code: "collaboration.operation-partial" });
    expect((refused as { details?: { cause_code?: string } }).details?.cause_code).toBe("remote.unavailable");
    expect(await reservationRow(fixture.context, "op-remote-undisclosed")).toMatchObject({ phase: "prepared" });
    expect(await bindingOf(fixture.context, WORKFLOW_ID)).toBeUndefined();
  });

  test("a settled abandonment declines its reservation and a new operation id proceeds", async () => {
    const fixture = await remoteFixture("remote-register-abandon");
    const context = registrationContext(fixture, WORKFLOW_ID);
    const options = remotePlanWorkflow(fixture.context, {
      planId: "20260921-abandoned",
      title: "Abandoned",
      workflowId: WORKFLOW_ID,
    });
    const pending = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
      operationId: "op-remote-abandon",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    const providerIntent = frozenProviderIntent(pending);
    await abandonRemoteIntent(fixture.context, { operationId: providerIntent, reason: "superseded by review" });

    // invariant: An abandoned intent can never confirm, so the reservation is released with a
    // named refusal instead of reporting the pending effect forever.
    await expect(
      registerShippedCatalogExecution(context, {
        actor: "project-manager",
        workflow: { kind: "plan", workflowId: WORKFLOW_ID, options },
        operationId: "op-remote-abandon",
        expected: fixture.token,
      }),
    ).rejects.toMatchObject({ code: "remote.effect-abandoned" });
    expect(await reservationRow(fixture.context, "op-remote-abandon")).toMatchObject({
      phase: "declined",
      cause_code: "remote.effect-abandoned",
    });

    // note: The corrected request under a new operation id is admitted and enqueues its intent.
    const retried = await registerShippedCatalogExecution(context, {
      actor: "project-manager",
      workflow: {
        kind: "plan",
        workflowId: WORKFLOW_ID,
        options: remotePlanWorkflow(fixture.context, {
          planId: "20260921-abandoned",
          title: "Abandoned",
          workflowId: WORKFLOW_ID,
        }),
      },
      operationId: "op-remote-abandon-2",
      expected: fixture.token,
    }).catch((error: unknown) => error);
    expect(retried).toMatchObject({ code: "collaboration.operation-partial" });
    expect(outboxRows(fixture.context)).toHaveLength(2);
  });
});
