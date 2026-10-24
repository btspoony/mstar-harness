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
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getCatalog, listCatalog, registerCatalogEntity, updateCatalogEntity, type CatalogLinkInput } from "./catalog.js";
import {
  listPendingCatalogRegistrations,
  type CatalogExecutionReceipt,
  type CatalogExecutionRequest,
} from "./catalog-registration.js";
import { readExecutionAuthority } from "./execution-read.js";
import { commitExecutionRegistration, registerShippedCatalogExecution } from "./execution-registration.js";
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
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import { derivePlanRegistration, PREPARE_PHASE, WORKFLOW_SNAPSHOT_FILE, type RegisterIterationWorkflowOptions, type RegisterPlanWorkflowOptions } from "./workflow.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-registration-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

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
        project: "_default",
      },
    },
    delta: {
      entities: [{ kind: "iteration", id: iterationId, title: iterationId, rootKind: "iterations", relativePath: iterationId }],
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

/**
 * Everything a registration may touch, as one comparable value: the three
 * revisions, the execution rows it creates, the catalog rows it publishes and
 * the journal's in-flight count.
 */
async function footprint(context: StoreContext): Promise<Record<string, unknown>> {
  return (
    (await one<Record<string, unknown>>(
      context,
      "select (select revision from execution_meta where id = 1) as root_revision, " +
        "(select revision from store_meta where id = 1) as store_revision, " +
        "(select catalog_revision from store_meta where id = 1) as catalog_revision, " +
        "(select count(*) from execution_workflows) as workflows, " +
        "(select count(*) from execution_registry) as registry, " +
        "(select count(*) from execution_plans) as plans, " +
        "(select count(*) from execution_inputs) as inputs, " +
        "(select count(*) from execution_operations) as operations, " +
        "(select count(*) from catalog_entities) as entities, " +
        "(select count(*) from catalog_links) as links, " +
        "(select count(*) from catalog_execution_bindings) as bindings, " +
        "(select count(*) from catalog_operations where phase in ('prepared','execution-written')) as pending",
    )) ?? {}
  );
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
    expect(sealed?.input_hash).toMatch(/^[0-9a-f]{64}$/);
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

    // (c) exactly the rows one registration creates, and exactly the revision
    // advances it owes: one root revision for the membership change, ONE store
    // revision for the whole multi-domain transaction (§3.1), one catalog
    // revision for the published entity — never a second store advance for the
    // same transaction, and no extra row at all.
    expect(await footprint(fixture.context)).toEqual({
      ...before,
      root_revision: (before.root_revision as number) + 1,
      store_revision: (before.store_revision as number) + 1,
      catalog_revision: (before.catalog_revision as number) + 1,
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
            project: "_default",
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
                project: "_default",
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
            project: "_default",
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
          project: "_default",
        },
      },
      delta: {
        entities: [{ kind: "iteration", id: iterationId, title: iterationId, rootKind: "iterations", relativePath: iterationId }],
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
                project: "_default",
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

    // The workflow rows were written inside the transaction and rolled back with
    // the refused publish: neither half is visible, and no revision advanced.
    expect(await footprint(fixture.context)).toEqual(before);
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
    expect(await footprint(fixture.context)).toEqual(accepted);
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

    expect(await footprint(fixture.context)).toEqual(before);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
    expect((await listCatalog(fixture.context, {})).total).toBe(0);
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
    expect(frozenBefore?.input_hash).toMatch(/^[0-9a-f]{64}$/);

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
            project: "_default",
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
    const reRead = await one<{ catalog_revision: number }>(fixture.context, "select catalog_revision from store_meta where id = 1");

    // Same operation id, current tokens — but a different reviewed producer call
    // and delta. Transport freshness is excluded from the fingerprint, the
    // business intent is not.
    const refusal = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        {
          ...planRequest({ context: fixture.context, operationId: "op-semantic-conflict", title: "Another plan" }),
          expectedCatalogRevision: reRead?.catalog_revision ?? -1,
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
    const reRead = await one<{ catalog_revision: number }>(fixture.context, "select catalog_revision from store_meta where id = 1");
    const fresh = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        { ...request, expectedCatalogRevision: reRead?.catalog_revision ?? -1, expected: current.token },
      ),
    );
    expect(fresh.code).toBe("execution.not-empty");
    expect(await footprint(fixture.context)).toEqual(published);
  });

  test("interrupted registration \u2014 an interruption before the commit leaves nothing and the retry converges on one registration (A05/A28)", async () => {
    const fixture = await activeFixture("interrupted-registration");
    const reviewed = planRequest({ context: fixture.context, operationId: "op-interrupted" });
    const before = await footprint(fixture.context);

    // The observable shape of an interrupted attempt: it stops inside the
    // transaction, which is this route's commit boundary, so it leaves no row,
    // revision, receipt or catalog byte behind.
    const interrupted = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        { ...reviewed, expectedCatalogRevision: 4, expected: fixture.rootToken },
      ),
    );
    expect(interrupted.code).toBe("catalog.revision-conflict");
    expect(await footprint(fixture.context)).toEqual(before);

    // The SAME normal intent completes exactly one registration, and the
    // creation facts are the reviewed call's own — the original timestamp, the
    // document-derived row — not a second attempt's.
    const accepted = await commitExecutionRegistration({ ...fixture.context, caller: fixture.caller }, { ...reviewed, expected: fixture.rootToken });
    const registered = await footprint(fixture.context);
    expect(registered).toMatchObject({
      root_revision: 2,
      store_revision: 1,
      catalog_revision: 1,
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

    // The interruption after the commit converges too: the retry replays the one
    // recorded receipt and adds nothing.
    const current = await readExecutionState(fixture.context);
    const reRead = await one<{ catalog_revision: number }>(fixture.context, "select catalog_revision from store_meta where id = 1");
    expect(
      await commitExecutionRegistration(
        { ...fixture.context, caller: fixture.caller },
        { ...reviewed, expectedCatalogRevision: reRead?.catalog_revision ?? -1, expected: current.token },
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

