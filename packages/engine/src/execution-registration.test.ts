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
 * - `execution-registration-refuses-a-legacy-pending-*`: active mode never
 *   adopts (or overwrites) pending file work.
 * - `execution-registration-blocks-migration-*` / `-refuses-an-imported-pin-*`:
 *   the legacy pending journal and an incoherent imported pin each block the
 *   migration route.
 * - `execution-catalog-pin-*`: a current catalog edit cannot mutate a prepared
 *   execution input, and an authorized eligible `prepare` selects the new input.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promotedAuditPlanRows } from "./audit.js";
import { getCatalog, listCatalog, registerCatalogEntity, updateCatalogEntity, type CatalogLinkInput } from "./catalog.js";
import {
  listPendingCatalogRegistrations,
  resolveCatalogRegistrationState,
  type CatalogExecutionReceipt,
  type CatalogExecutionRequest,
} from "./catalog-registration.js";
import { executionInputHash } from "./coordination.js";
import { prepareExecutionPlan } from "./execution-coordination.js";
import { previewExecutionMigration } from "./execution-migrate.js";
import { commitExecutionRegistration } from "./execution-registration.js";
import {
  bindExecutionSession,
  initializeExecutionAuthority,
  readExecutionPlan,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionSessionRef,
  type ExecutionToken,
} from "./execution-store.js";
import * as engineIndex from "./index.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "./workflow.js";

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
/** An audit promotion: the workflow id is the outDir basename, the row title the plan doc body. */
const AUDIT_WORKFLOW_ID = "audit-2026-09-21-promotion";
const AUDIT_PLAN_ID = "001-audit-finding";
const AUDIT_PLAN_TITLE = "Retire the legacy registration journal";

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
 * An ACTIVE, empty execution authority. The workspace carries the `.mstar`
 * harness marker so the store stays pinned to it even once the harness's own
 * `plans/` child appears — the same shape a real control harness has.
 */
async function activeFixture(label: string): Promise<Fixture> {
  const workspace = mkdtempSync(join(ROOT, `${label}-`));
  const harnessRoot = join(workspace, ".mstar");
  mkdirSync(harnessRoot, { recursive: true });
  const context: StoreContext = { harnessDir: workspace };
  const store = await initializeStore(context);
  store.close();
  const initialized = await initializeExecutionAuthority(context);
  return {
    workspace,
    harnessRoot: realpathSync(harnessRoot),
    context,
    storeId: initialized.storeId,
    rootToken: initialized.token,
    caller: { sessionId: COORDINATOR_ID, role: "coordinator", workflowId: WORKFLOW_ID, planId: null },
  };
}

/**
 * A workspace whose store is still on the LEGACY execution authority. The
 * control harness IS the `.mstar` dir here — that is where `store.db`, the v2
 * root register and the workflow tree live — exactly as the migration fixture
 * builds it.
 */
async function legacyFixture(label: string): Promise<{ workspace: string; harnessRoot: string; context: StoreContext }> {
  const workspace = mkdtempSync(join(ROOT, `${label}-`));
  const harnessRoot = join(workspace, ".mstar");
  mkdirSync(harnessRoot, { recursive: true });
  const context: StoreContext = { harnessDir: harnessRoot };
  const store = await initializeStore(context);
  store.close();
  return { workspace, harnessRoot, context };
}

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
}): CatalogExecutionRequest {
  const workflowId = options.workflowId ?? WORKFLOW_ID;
  const planId = options.planId ?? PLAN_ID;
  const title = options.title ?? PLAN_TITLE;
  const file = options.file ?? `${planId}.md`;
  const bindingId = options.bindingId ?? planId;
  return {
    operationId: options.operationId,
    actor: "project-manager",
    expectedCatalogRevision: options.expectedCatalogRevision ?? 0,
    workflow: {
      kind: "plan",
      workflowId,
      options: {
        harnessDir: options.context.harnessDir,
        plan: { id: planId, title, file },
        deliveryKind: "development",
        branchSource: `feature/${workflowId}`,
        branchTarget: "main",
        project: "_default",
        ...(options.omitStartedAt === true ? {} : { startedAt: TS }),
      },
    },
    delta: {
      entities: options.entities ?? [{ kind: "plan", id: planId, title, rootKind: "plans", relativePath: file }],
      ...(options.links === undefined ? {} : { links: options.links }),
      binding: { catalogKind: "plan", catalogId: bindingId },
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

/** A pending legacy journal row, exactly as the file route leaves one mid-flight. */
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

/**
 * A real legacy source tree for the migration cases: the v2 root register plus
 * one workflow snapshot whose single plan row records `catalog_pin`. The
 * snapshot is written in the released shape (no coordinator block, so no session
 * envelope is implicated) and validated by the production reader before any case
 * runs against it.
 */
function writeLegacySource(harnessRoot: string, pin: Record<string, unknown>): void {
  const workflowDir = join(harnessRoot, "workflows", WORKFLOW_ID);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(harnessRoot, "status.json"),
    `${JSON.stringify({
      version: 2,
      updated_at: ROOT_UPDATED_AT,
      workflows: [{ id: WORKFLOW_ID, type: "plan", started_at: TS, dir: `workflows/${WORKFLOW_ID}` }],
    })}\n`,
  );
  writeFileSync(
    join(workflowDir, WORKFLOW_SNAPSHOT_FILE),
    `${JSON.stringify({
      schema_version: 1,
      id: WORKFLOW_ID,
      type: "plan",
      status: "running",
      started_at: TS,
      updated_at: ROOT_UPDATED_AT,
      delivery_kind: "development",
      branch: { source: `feature/${WORKFLOW_ID}`, target: "main" },
      plans: [
        {
          id: PLAN_ID,
          title: PLAN_TITLE,
          file: `plans/${PLAN_ID}.md`,
          status: "Todo",
          metadata: { catalog_pin: pin },
        },
      ],
    })}\n`,
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
    expect(engineIndex.commitExecutionRegistration.length).toBe(2);
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

    // (d) NO JSON registration file, and no intermediate journal phase: the DB
    // route neither wrote the file protocol's bytes nor its pending marker.
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
    expect((await resolveCatalogRegistrationState(fixture.context, WORKFLOW_ID)).pending).toBeNull();
    expect(await listPendingCatalogRegistrations(fixture.context)).toEqual([]);
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
    const row = { id: `${iterationId}-plan`, title: "Iteration row", file: `${iterationId}-plan.md` };
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
    // The iteration snapshot's own row metadata is the sealed input, unchanged:
    // the registration publishes catalog rows, it never rewrites the plan row.
    const sealed = await sealedInput(fixture.context, row.id, iterationId);
    expect(JSON.parse(String(sealed?.input_json))).toMatchObject({
      plan_id: row.id,
      id: row.id,
      title: row.title,
      file: row.file,
      iteration_refs: ["delivery-compass.md"],
    });
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });

  test("execution-registration-registers-an-audit-promotion-under-its-derived-workflow-id", async () => {
    const fixture = await activeFixture("audit-promotion");
    // A real audit output directory: the promotion's plan rows and their titles
    // come from these documents, and the workflow id is the directory's basename
    // because the producer options name none.
    const outDir = join(fixture.workspace, "audits", AUDIT_WORKFLOW_ID);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${AUDIT_PLAN_ID}.md`), `# ${AUDIT_PLAN_TITLE}\n\nFindings body.\n`);
    const rows = promotedAuditPlanRows(outDir, [AUDIT_PLAN_ID]).map((row) => ({
      kind: "plan" as const,
      id: String(row.id),
      title: String(row.title),
      rootKind: "plans" as const,
      relativePath: String(row.file),
    }));
    const before = await footprint(fixture.context);

    const request: CatalogExecutionRequest = {
      operationId: "op-audit",
      actor: "project-manager",
      expectedCatalogRevision: 0,
      workflow: {
        kind: "audit",
        outDir,
        selected: [AUDIT_PLAN_ID],
        options: {
          harnessDir: fixture.context.harnessDir,
          deliveryKind: "development",
          branchSource: `feature/${AUDIT_WORKFLOW_ID}`,
          branchTarget: "main",
        },
      },
      delta: {
        entities: rows,
        binding: { catalogKind: "plan", catalogId: rows[0]!.id },
      },
    };

    const receipt = await commitExecutionRegistration(
      { ...fixture.context, caller: { ...fixture.caller, workflowId: AUDIT_WORKFLOW_ID } },
      { ...request, expected: fixture.rootToken },
    );
    expect(receipt).toEqual({
      operationId: "op-audit",
      workflowId: AUDIT_WORKFLOW_ID,
      catalogRevision: 1,
      recovered: false,
    });

    // The execution half: the derived id, the audit-derived promoted snapshot
    // (type plan, the declared delivery kind and branches) and its plan row,
    // whose TITLE is the audit document's own `# ` heading.
    const header = await one<{ state_json: string }>(
      fixture.context,
      "select state_json from execution_workflows where workflow_id = ?",
      AUDIT_WORKFLOW_ID,
    );
    expect(JSON.parse(String(header?.state_json))).toMatchObject({
      id: AUDIT_WORKFLOW_ID,
      type: "plan",
      delivery_kind: "development",
      branch: { source: `feature/${AUDIT_WORKFLOW_ID}`, target: "main" },
    });
    const planRow = await one<{ revision: number; state_json: string }>(
      fixture.context,
      "select revision, state_json from execution_plans where workflow_id = ? and plan_id = ?",
      AUDIT_WORKFLOW_ID,
      AUDIT_PLAN_ID,
    );
    expect(planRow?.revision).toBe(1);
    expect(JSON.parse(String(planRow?.state_json))).toMatchObject({
      id: AUDIT_PLAN_ID,
      title: AUDIT_PLAN_TITLE,
      file: `${AUDIT_PLAN_ID}.md`,
      status: "Todo",
    });

    // The catalog half: the promoted plan entities and this workflow's binding.
    const entity = (await getCatalog(fixture.context, { kind: "plan", id: AUDIT_PLAN_ID })).entity;
    expect(entity).toMatchObject({ title: AUDIT_PLAN_TITLE, rootKind: "plans", relativePath: `${AUDIT_PLAN_ID}.md` });
    expect(await bindingOf(fixture.context, AUDIT_WORKFLOW_ID)).toMatchObject({
      catalog_kind: "plan",
      catalog_id: AUDIT_PLAN_ID,
      catalog_revision: 1,
    });

    // One store revision for the whole audit registration, one catalog revision
    // for its published row — and no JSON registration byte: the active route
    // promoted no snapshot file.
    const accepted = await footprint(fixture.context);
    expect(accepted).toEqual({
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
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);

    // The exact retry is the recorded receipt and writes nothing.
    expect(
      await commitExecutionRegistration(
        { ...fixture.context, caller: { ...fixture.caller, workflowId: AUDIT_WORKFLOW_ID } },
        { ...request, expected: fixture.rootToken },
      ),
    ).toEqual(receipt);
    expect(await footprint(fixture.context)).toEqual(accepted);

    // A second, DIFFERENT registration of the same promoted lifecycle is refused:
    // an audit promotion registers one create-only lifecycle, exactly as the
    // other two kinds do.
    const rootToken = (await readExecutionState(fixture.context)).token;
    const refusal = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: { ...fixture.caller, workflowId: AUDIT_WORKFLOW_ID } },
        { ...request, operationId: "op-audit-again", expectedCatalogRevision: 1, expected: rootToken },
      ),
    );
    expect(refusal.code).toBe("execution.not-empty");
    expect(await footprint(fixture.context)).toEqual(accepted);
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

  test("execution-registration-refuses-a-legacy-pending-operation-instead-of-adopting-it", async () => {
    const fixture = await activeFixture("pending-legacy");
    await plantPendingLegacyOperation(fixture.context, "op-legacy-pending", WORKFLOW_ID);
    const before = await footprint(fixture.context);

    const refusal = await refusalOf(() => registerPlanWorkflow(fixture, "op-db-registration"));
    expect(refusal.code).toBe("catalog.registration-pending");
    expect(refusal.message).toContain("op-legacy-pending");
    // The SAME verdict and the same recovery instruction the file route gives.
    expect(refusal.message).toContain("catalog reconcile");

    // Nothing was adopted, published or written: the pending file operation is
    // left exactly where the file route can settle it.
    expect(await footprint(fixture.context)).toEqual(before);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
    expect((await listCatalog(fixture.context, {})).total).toBe(0);
  });

  test("execution-registration-refuses-a-non-coordinator-caller-and-writes-no-registration-file", async () => {
    const fixture = await activeFixture("caller-scope");
    const before = await footprint(fixture.context);
    const refusal = await refusalOf(() =>
      commitExecutionRegistration(
        { ...fixture.context, caller: { sessionId: "host-plan-pm", role: "plan-pm", workflowId: WORKFLOW_ID, planId: PLAN_ID } },
        { ...planRequest({ context: fixture.context, operationId: "op-plan-pm", expectedCatalogRevision: 0 }), expected: fixture.rootToken },
      ),
    );
    expect(refusal.code).toBe("execution.scope-mismatch");
    expect(await footprint(fixture.context)).toEqual(before);
    expect(noJsonRegistrationFiles(fixture.workspace)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * The migration boundary
 * ------------------------------------------------------------------------ */

describe("execution-registration — migration boundary", () => {
  test("execution-registration-blocks-migration-while-a-legacy-operation-is-pending", async () => {
    const { context } = await legacyFixture("migration-pending");
    await plantPendingLegacyOperation(context, "op-legacy-in-flight", WORKFLOW_ID);
    const before = await footprint(context);

    const refusal = await refusalOf(() =>
      previewExecutionMigration({ context, operationId: "op-preview", operator: "ops-engineer" }),
    );
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("op-legacy-in-flight");
    expect(refusal.message).toContain("pending");

    // The planner saves nothing: the staged footprint and the journal row stand.
    expect(await footprint(context)).toEqual(before);
  });

  test("execution-registration-refuses-an-imported-pin-that-disagrees-with-its-row", async () => {
    const { harnessRoot, context } = await legacyFixture("migration-pin");
    const storeId = (await one<{ store_id: string }>(context, "select store_id from store_meta where id = 1"))!.store_id;

    // §7: a pin freezes the very row it is sealed with, so a same-store pin whose
    // `document_hash` is not that row's frozen-input hash is refused rather than
    // imported as this store's frozen selection.
    writeLegacySource(harnessRoot, {
      store_id: storeId,
      entity_revision: 3,
      document_hash: "2".repeat(64),
      relation_hash: "3".repeat(64),
    });
    const before = await footprint(context);
    const refusal = await refusalOf(() =>
      previewExecutionMigration({ context, operationId: "op-preview-pin", operator: "ops-engineer" }),
    );
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("the pin and its row disagree");
    expect(await footprint(context)).toEqual(before);

    // The SAME source with the row's own hash — the released prepare shape — is
    // the coherent pair: the refusal was the disagreement, not the fixture.
    const row = { id: PLAN_ID, title: PLAN_TITLE, file: `plans/${PLAN_ID}.md`, status: "Todo" };
    writeLegacySource(harnessRoot, {
      store_id: storeId,
      entity_revision: 3,
      document_hash: executionInputHash(row, PLAN_ID),
      relation_hash: "3".repeat(64),
    });
    const manifest = await previewExecutionMigration({ context, operationId: "op-preview-pin-ok", operator: "ops-engineer" });
    expect(manifest.sources.length).toBeGreaterThan(0);
    expect(manifest.pendingCatalogOperations).toEqual([]);
    expect(existsSync(join(harnessRoot, "workflows", WORKFLOW_ID, WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    expect(readFileSync(join(harnessRoot, "status.json"), "utf8").length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Frozen catalog coexistence
 * ------------------------------------------------------------------------ */

describe("execution-catalog-pin", () => {
  test("execution-catalog-pin-current-catalog-edits-leave-the-sealed-execution-input-alone", async () => {
    const fixture = await activeFixture("pin-survives-edits");
    await registerPlanWorkflow(fixture, "op-pin-source");
    const sealed = await sealedInput(fixture.context, PLAN_ID);
    const binding = await bindingOf(fixture.context, WORKFLOW_ID);
    expect(binding?.catalog_revision).toBe(1);

    // A current metadata edit moves the catalog: the entity's own revision and
    // the store's catalog revision advance…
    const edited = await updateCatalogEntity(
      fixture.context,
      { kind: "plan", id: PLAN_ID },
      { title: "Renamed after registration" },
      1,
      { operationId: "op-catalog-edit", actor: "project-manager" },
    );
    expect(edited.revision).toBe(2);

    // …and the sealed execution input is byte-identical: a current catalog edit
    // cannot mutate a stored execution input. Only an authorized `prepare`
    // selects newer catalog input.
    expect(await sealedInput(fixture.context, PLAN_ID)).toEqual(sealed);
    expect((await getCatalog(fixture.context, { kind: "plan", id: PLAN_ID })).entity.title).toBe("Renamed after registration");
    // The committed binding is registration history, not a live pointer.
    expect(await bindingOf(fixture.context, WORKFLOW_ID)).toEqual(binding);
  });

  test("execution-catalog-pin-an-authorized-eligible-prepare-selects-the-new-input", async () => {
    const fixture = await activeFixture("pin-prepare");
    await registerPlanWorkflow(fixture, "op-pin-prepare");
    await updateCatalogEntity(
      fixture.context,
      { kind: "plan", id: PLAN_ID },
      { title: "Renamed before prepare" },
      1,
      { operationId: "op-catalog-edit", actor: "project-manager" },
    );

    // The workflow's coordinator binds on the workflow token the registration
    // produced, and the reviewed Assignment + plan file exist on disk.
    const state = await readExecutionState(fixture.context);
    const [workflow] = state.data.workflows;
    const coordinator: ExecutionSessionRef = (
      await bindExecutionSession({ ...fixture.context, caller: fixture.caller }, {
        workflowId: WORKFLOW_ID,
        planId: null,
        role: "coordinator",
        expected: workflow!.workflowToken,
        operationId: "op-bind-coordinator",
      })
    ).data;
    const { assignmentPath } = writeAssignmentDocuments(fixture.harnessRoot, PLAN_ID, `feature/${PLAN_ID}`);

    const expected = (
      await readExecutionPlan({ ...fixture.context, caller: fixture.caller }, coordinator, PLAN_ID)
    ).token;
    const prepared = await prepareExecutionPlan(
      { ...fixture.context, caller: fixture.caller },
      {
        operationId: "op-prepare-plan",
        session: coordinator,
        expected,
        planId: PLAN_ID,
        operation: { kind: "prepare", assignmentPath },
      },
    );
    expect(prepared.replayed).toBe(false);
    expect(prepared.data.plan.id).toBe(PLAN_ID);
    expect(prepared.data.frozenInput?.entity_revision).toBe(2);

    // The eligible authorized prepare selects the NEW catalog input: the pin's
    // identity half is the entity revision the catalog holds NOW, while its
    // document half stays the frozen input's own hash — a selection, never a
    // rewrite of the sealed input.
    const sealed = await sealedInput(fixture.context, PLAN_ID);
    expect(sealed).toBeDefined();
    const pin = JSON.parse(String(sealed!.catalog_pin_json)) as {
      store_id: string;
      entity_revision: number;
      document_hash: string;
      relation_hash: string;
    };
    expect(pin.store_id).toBe(fixture.storeId);
    expect(pin.entity_revision).toBe(2);
    expect(pin.document_hash).toBe(sealed!.input_hash);
  });
});

/** A real reviewed Assignment plus the plan markdown it pins, inside one harness. */
function writeAssignmentDocuments(harnessRoot: string, planId: string, branch: string): { assignmentPath: string; planPath: string } {
  const planDir = join(harnessRoot, "plans");
  const sddDir = join(harnessRoot, "sdd", planId);
  const worktreeDir = join(harnessRoot, "worktrees", planId);
  mkdirSync(planDir, { recursive: true });
  mkdirSync(sddDir, { recursive: true });
  const planPath = join(planDir, `${planId}.md`);
  writeFileSync(planPath, `# ${planId}\n`);
  const headers: Record<string, string> = {
    "Execution scope": "plan",
    "Execute as": "project-manager",
    Delegation: "allowed",
    "Control harness root": harnessRoot,
    "Workflow id": WORKFLOW_ID,
    "Plan id": planId,
    "Plan Path": planPath,
    "Worktree path": worktreeDir,
    "Working branch": branch,
    "SDD dir": sddDir,
    "QA gate": "mandatory",
    "Findings cleanup": "allow-residual",
    "Prepare gate": "go",
  };
  const assignmentPath = join(harnessRoot, "assignments", `${planId}.md`);
  mkdirSync(dirname(assignmentPath), { recursive: true });
  writeFileSync(
    assignmentPath,
    `${Object.entries(headers)
      .map(([header, value]) => `**${header}**: ${value}`)
      .join("\n")}\n`,
  );
  return { assignmentPath, planPath };
}
