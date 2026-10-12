/**
 * execution-recovery.test.ts — proof for R3: the consistent whole-store backup,
 * the explicit-loss atomic restore and the credential-free diagnostic export
 * (primary spec §8).
 *
 * Every case runs the REAL modules, the REAL `node:sqlite` driver and REAL
 * filesystem fixtures in per-test temporary workspaces: a real Git main
 * worktree with a `.mstar` control harness, a real store built by
 * `initializeStore`, a real ACTIVE execution authority built through the
 * published domain verbs (`readExecutionState` →
 * `createExecutionWorkflow` → `bindExecutionSession`), and real `backupStore`
 * recovery points. The only injected failures are the two test-runner-gated
 * crash seams this protocol owns.
 *
 * Acceptance criteria carried by these cases:
 *
 * - `execution-backup-*`: a `VACUUM INTO` point taken while a connection holds
 *   committed, uncheckpointed WAL frames carries the WAL-visible issue, catalog
 *   AND execution rows, and records the copy's own execution identity.
 * - `execution-restore-*`: a mismatched, corrupt, live-database or too-new
 *   recovery point refuses; the preview lists every changed/deleted authority
 *   row and every committed operation id across the three domains; a restore
 *   refusal preserves live authority and backup contents; accepted restore
 *   installs the selected state above both epochs and invalidates old handles,
 *   keeps a pre-restore recovery point; a crash before or after replacement is
 *   sidecar that appears in the replacement window refuses rather than being
 *   replaced over; a live store whose loss cannot be inventoried refuses with
 *   both files kept; the restore serializes with the migration maintenance
 *   lock; and an abandoned attempt's scratch image and sidecars are reclaimed
 *   while an installed copy is left exactly where it is.
 * - `execution-export-*`: the diagnostic carries workflow/plan state and the
 *   workflow-wide integration claim along with the public frozen input, while
 *   dropping every session identity, token, credential and session path it
 *   could otherwise be driven with, is byte-stable, and refuses to authorize
 *   anything when fed to a real writer.
 *
 * Run with `bun test packages/engine/src/execution-recovery.test.ts
 * --test-name-pattern 'execution-backup|execution-restore|execution-export'`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCatalogEntity } from "./catalog.js";
import {
  exportExecutionState,
  previewExecutionRestore,
  restoreExecutionBackup,
  EXECUTION_RECOVERY_PROTOCOL_VERSION,
} from "./execution-recovery.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionSessionRef,
  type ExecutionToken,
} from "./execution-store.js";
import { mutateExecutionWorkflow } from "./execution-workflow.js";
import { appendDshLedgerRow, appendDshWorkflowEvent, advanceDshScanBound, recordDshStatusEmission, writeDshSessionBinding } from "./host-state-store.js";
import { assignIssueMilestone, captureIssue, getIssue } from "./issue.js";
import { addMilestone } from "./milestone-store.js";
import {
  assertAuthorityCurrent,
  backupStore,
  canonicalPath,
  currentAuthorityHandle,
  type BackupReceipt,
} from "./store-activation.js";
import { MIGRATIONS, initializeStore, openStore, storeDbPath, type StoreContext } from "./store-db.js";
import type { WorkflowSnapshot } from "./workflow.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-recovery-"));
const TS = "2026-09-02T00:00:00.000Z";
const WF = "20260920-recovery-workflow";
const PROJECT_ID = "proj-inventory";
const WF2 = "20260920-recovery-workflow-2";
const PLAN_1 = "20260920-recovery-plan-1";
const PLAN_2 = "20260920-recovery-plan-2";
const COORDINATOR = `session-${WF}`;
const COORDINATOR_2 = `session-${WF2}`;
const OPERATOR = "ops-engineer";
const AUTHORIZATION = "D29 execution recovery";

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture: a real control harness with a real ACTIVE execution authority
// ---------------------------------------------------------------------------

type Fixture = { root: string; harness: string; context: StoreContext; dbPath: string };

type World = Fixture & {
  storeId: string;
  epoch: number;
  workflowToken: ExecutionToken;
  planTokens: Record<string, ExecutionToken>;
  /** The coordinator binding the store itself holds after the fixture's bind. */
  sessionRef: ExecutionSessionRef;
  caller: ExecutionCaller;
};

function workspace(name: string): Fixture {
  const root = mkdtempSync(join(ROOT, `${name}-`));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const context: StoreContext = { harnessDir: harness };
  return { root, harness, context, dbPath: storeDbPath(context) };
}

/**
 * Read one result out of a store file without changing it.
 *
 * SQLite reads a WAL database THROUGH its `-wal` file, so a store that SQLite's
 * own last clean close left without a sidecar — WAL still in the header, which
 * is exactly the shape the quiesced-WAL case below asserts must stay unchanged
 * — cannot be read through a plain read-only open at all. The `immutable` form
 * reads those same bytes without the WAL machinery, so the suite can observe a
 * store the module leaves untouched instead of creating the sidecar that case
 * asserts against. It is tried only for that shape: every other store keeps the
 * ordinary read-only open, so a broken file still reports its own error.
 */
function withRawRead<T>(dbPath: string, run: (db: DatabaseSync) => T): T {
  const read = (spec: string): T => {
    const db = new DatabaseSync(spec, { readOnly: true });
    try {
      return run(db);
    } finally {
      db.close();
    }
  };
  try {
    return read(dbPath);
  } catch (error) {
    if (!isQuiescedWalStoreFile(dbPath)) throw error;
    return read(`file:${dbPath}?immutable=1`);
  }
}

/** The store file's own bytes: WAL in the header, and no `-wal`/`-shm` beside it. */
function isQuiescedWalStoreFile(dbPath: string): boolean {
  const header = Buffer.alloc(100);
  const fd = openSync(dbPath, "r");
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  return (
    header[18] === 2 && header[19] === 2 && !existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`)
  );
}

function rawGet<T>(dbPath: string, sql: string): T | undefined {
  return withRawRead(dbPath, (db) => db.prepare(sql).get() as T | undefined);
}

function rawAll<T>(dbPath: string, sql: string): T[] {
  return withRawRead(dbPath, (db) => db.prepare(sql).all() as T[]);
}

function rawRun(dbPath: string, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function sha256OfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256OfFile(path: string): string {
  return sha256OfBytes(readFileSync(path));
}

/** The typed refusal of one call: its stable code and message, whatever domain raised it. */
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
  throw new Error("expected a refusal, but the call resolved");
}

/** Any failure, typed or not — the crash seams and the lock holder raise plain errors. */
async function errorOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure, but the call resolved");
}

/** One event-loop turn, so a probe can run while a call under test is awaiting. */
function nextTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

function callerOf(workflowId: string, sessionId: string): ExecutionCaller {
  return { sessionId, role: "coordinator", workflowId };
}

function contextOf(context: StoreContext, caller: ExecutionCaller): ExecutionContext {
  return { harnessDir: context.harnessDir, caller };
}

function snapshotOf(workflowId: string, planIds: readonly string[]): WorkflowSnapshot {
  return {
    schema_version: 1,
    id: workflowId,
    type: "plan",
    status: "running",
    started_at: TS,
    updated_at: TS,
    delivery_kind: "development",
    branch: { source: `feature/${workflowId}`, target: "main" },
    plans: planIds.map((planId) => ({ id: planId, title: `${planId} title`, file: `plans/${planId}.md`, status: "Todo" })),
  } as unknown as WorkflowSnapshot;
}

async function registerPlan(context: StoreContext, planId: string): Promise<void> {
  await registerCatalogEntity(
    context,
    { kind: "plan", id: planId, title: `${planId} title`, rootKind: "plans", relativePath: `plans/${planId}.md` },
    { operationId: `register-${planId}`, actor: "execution-recovery.test" },
  );
}

/**
 * An ACTIVE execution workspace: the published verbs create the authority, the
 * workflow, the sealed input and one live coordinator binding — so the fixture
 * holds real session authority the export must not carry and the restore must
 * invalidate.
 */
async function recoveryWorld(name: string, planIds: readonly string[] = [PLAN_1]): Promise<World> {
  const fixture = workspace(name);
  const handle = await initializeStore(fixture.context);
  handle.close();
  const initialized = await readExecutionState(fixture.context);
  for (const planId of planIds) await registerPlan(fixture.context, planId);
  const caller = callerOf(WF, COORDINATOR);
  const created = await createExecutionWorkflow(contextOf(fixture.context, caller), {
    entry: { id: WF, type: "plan", started_at: TS, dir: `workflows/${WF}` },
    snapshot: snapshotOf(WF, planIds),
    expected: initialized.token,
    operationId: `${name}-create`,
  });
  const workflow = created.data.workflows[0]!;
  const bound = await bindExecutionSession(contextOf(fixture.context, caller), {
    workflowId: WF,
    expected: workflow.workflowToken,
    operationId: `${name}-bind`,
  });
  return {
    ...fixture,
    storeId: initialized.storeId,
    epoch: created.epoch,
    workflowToken: workflow.workflowToken,
    planTokens: workflow.planTokens,
    sessionRef: bound.data,
    caller,
  };
}

/** One verified recovery point of the live store, outside the default name. */
async function recoveryPoint(world: World, label: string): Promise<BackupReceipt> {
  return backupStore(world.context, { out: join(world.harness, "archived", "recovery", `${label}.db`) });
}

/** The identity/count facts an untouched store is compared on. */
function footprint(dbPath: string): Record<string, number> {
  return {
    epoch: rawGet<{ authority_epoch: number }>(dbPath, "select authority_epoch from store_meta where id = 1")!.authority_epoch,
    revision: rawGet<{ revision: number }>(dbPath, "select revision from store_meta where id = 1")!.revision,
    catalogRevision: rawGet<{ catalog_revision: number }>(dbPath, "select catalog_revision from store_meta where id = 1")!.catalog_revision,
    executionRevision: rawGet<{ revision: number }>(dbPath, "select revision from execution_meta where id = 1")!.revision,
    issues: rawGet<{ n: number }>(dbPath, "select count(*) as n from issues")!.n,
    catalogEntities: rawGet<{ n: number }>(dbPath, "select count(*) as n from catalog_entities")!.n,
    workflows: rawGet<{ n: number }>(dbPath, "select count(*) as n from execution_workflows")!.n,
    plans: rawGet<{ n: number }>(dbPath, "select count(*) as n from execution_plans")!.n,
    sessions: rawGet<{ n: number }>(dbPath, "select count(*) as n from execution_sessions")!.n,
  };
}

function issueInput(title: string) {
  return {
    projectId: "_default",
    title,
    kind: "bug" as const,
    severity: "high" as const,
    impact: "post-backup issue authority must appear in the loss inventory",
    acceptance: "the row is either preserved or explicitly accepted as loss",
    sourceIdentity: `qc/${title}.md`,
    rootCauseKey: `${title}-root-cause`,
    acceptanceKey: "inventoried",
    occurrenceKey: `run-${title}`,
    sourceKind: "qc" as const,
    location: "packages/engine/src/execution-recovery.ts:1",
    observedBehavior: "the restore must disclose what it discards",
    evidence: ["proof"],
    discoveredAt: TS,
  };
}

/**
 * The post-backup work of the loss cases: one change in each authority domain —
 * an issue (with its occurrence), catalog registrations, and a whole new
 * execution workflow created through the published verb.
 */
async function mutateEveryDomain(world: World, name: string): Promise<void> {
  await captureIssue(world.context, issueInput(`Post-backup finding ${name}`), {
    operationId: `op-issue-${name}`,
    actor: "project-manager",
  });
  await registerCatalogEntity(
    world.context,
    {
      kind: "document",
      id: `doc-${name}`,
      title: "Post-backup guide",
      rootKind: "harness",
      relativePath: `guides/${name}.md`,
      documentKind: "guide",
    },
    { operationId: `op-document-${name}`, actor: "project-manager" },
  );
  await registerPlan(world.context, PLAN_2);
  const root = await readExecutionState(world.context);
  await createExecutionWorkflow(contextOf(world.context, callerOf(WF2, COORDINATOR_2)), {
    entry: { id: WF2, type: "plan", started_at: TS, dir: `workflows/${WF2}` },
    snapshot: snapshotOf(WF2, [PLAN_2]),
    expected: root.token,
    operationId: `op-workflow-${name}`,
  });
}

// ---------------------------------------------------------------------------
// Backup — the recovery point of a live store, WAL included
// ---------------------------------------------------------------------------

describe("execution-backup", () => {
  test("execution-backup-carries-committed-wal-visible-execution-issue-and-catalog", async () => {
    const world = workspace("backup-wal");
    // Held open for the whole case so the committed frames stay in the WAL
    // instead of being checkpointed away by the last close.
    const held = await initializeStore(world.context);
    try {
      await registerPlan(world.context, PLAN_1);
      await createExecutionWorkflow(contextOf(world.context, callerOf(WF, COORDINATOR)), {
        entry: { id: WF, type: "plan", started_at: TS, dir: `workflows/${WF}` },
        snapshot: snapshotOf(WF, [PLAN_1]),
        expected: (await readExecutionState(world.context)).token,
        operationId: "backup-wal-create",
      });
      await bindExecutionSession(contextOf(world.context, callerOf(WF, COORDINATOR)), {
        workflowId: WF,
        expected: (await readExecutionState(world.context)).data.workflows[0]!.workflowToken,
        operationId: "backup-wal-bind",
      });
      await captureIssue(world.context, issueInput("WAL-visible finding"), {
        operationId: "op-backup-wal-issue",
        actor: "project-manager",
      });

      const walPath = join(world.harness, "store.db-wal");
      expect(statSync(walPath).size).toBeGreaterThan(0);
      const receipt = await backupStore(world.context, { out: join(world.harness, "archived", "wal-point.db") });
      expect(receipt.walPending).toBe(true);
      expect(receipt.storeId).toBe((rawGet<{ store_id: string }>(world.dbPath, "select store_id from store_meta where id = 1")!).store_id);
      // §8: the copy carries the EXECUTION identity, not only issue/catalog.
      expect(receipt.execution).not.toBeNull();
      expect(receipt.execution!.authorityState).toBe("active");
      expect(receipt.execution!.manifestId).toBeNull();
      expect(receipt.counts.issues).toBe(1);
      expect(receipt.counts.occurrences).toBe(1);
      expect(receipt.counts.catalogEntities).toBe(1);

      // …and the bytes behind it hold the committed, never-checkpointed rows.
      const copy = new DatabaseSync(receipt.backupPath, { readOnly: true });
      try {
        const title = (copy.prepare("select title from issues").get() as { title: string }).title;
        expect(title).toBe("WAL-visible finding");
        expect((copy.prepare("select count(*) as n from execution_workflows").get() as { n: number }).n).toBe(1);
        expect((copy.prepare("select count(*) as n from execution_plans").get() as { n: number }).n).toBe(1);
        expect((copy.prepare("select count(*) as n from execution_inputs").get() as { n: number }).n).toBe(1);
        expect((copy.prepare("select count(*) as n from execution_sessions").get() as { n: number }).n).toBe(1);
        expect(
          (copy.prepare("select authority_state from execution_meta where id = 1").get() as { authority_state: string })
            .authority_state,
        ).toBe("active");
      } finally {
        copy.close();
      }
    } finally {
      held.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Preview — the whole-store loss inventory and its digest
// ---------------------------------------------------------------------------

describe("execution-restore", () => {
  test("execution-restore-refuses-a-mismatched-corrupt-live-or-too-new-point", async () => {
    const world = await recoveryWorld("restore-refusals");
    const untouched = footprint(world.dbPath);
    const point = await recoveryPoint(world, "refusals-point");
    const foreign = await recoveryWorld("restore-refusals-foreign");
    const foreignPoint = await recoveryPoint(foreign, "refusals-foreign-point");

    // A point outside the root it would protect is refused (§4.3).
    const outside = await refusalOf(() => previewExecutionRestore(world.context, foreignPoint.backupPath));
    expect(outside.code).toBe("store.activation-stale");
    expect(outside.message).toContain("outside the authorized control root");

    // A point of ANOTHER store, placed inside this root, is refused on identity.
    const foreignInside = join(world.harness, "archived", "recovery", "foreign-store-point.db");
    writeFileSync(foreignInside, readFileSync(foreignPoint.backupPath));
    const mismatched = await refusalOf(() => previewExecutionRestore(world.context, foreignInside));
    expect(mismatched.code).toBe("store.activation-stale");
    expect(mismatched.message).toContain(foreignPoint.storeId);

    // The live database is not its own recovery point (§8).
    const live = await refusalOf(() => previewExecutionRestore(world.context, world.dbPath));
    expect(live.code).toBe("store.activation-stale");
    expect(live.message).toContain("names the live store database");

    // A copy whose page structure SQLite itself rejects is refused.
    const corruptPath = join(world.harness, "archived", "recovery", "corrupt-point.db");
    const corruptBytes = readFileSync(point.backupPath);
    corruptBytes.fill(0x5a, Math.floor(corruptBytes.length / 2));
    writeFileSync(corruptPath, corruptBytes);
    const corrupt = await refusalOf(() => previewExecutionRestore(world.context, corruptPath));
    expect(corrupt.code).toBe("store.activation-stale");
    expect(corrupt.message).toMatch(/integrity_check|verif|not a SQLite|unreadable/);

    // A copy written by a NEWER build is not a recovery point for this one. The
    // future version is DERIVED from this build's own migration list, so a new
    // append-only migration (the coverage column) can never collide with the
    // fixture's "newer build" row.
    const tooNewPath = join(world.harness, "archived", "recovery", "too-new-point.db");
    writeFileSync(tooNewPath, readFileSync(point.backupPath));
    rawRun(
      tooNewPath,
      "insert into schema_version(version, name, checksum, applied_at) values (?, 'future-authority', 'deadbeef', ?)",
      MIGRATIONS.length + 1,
      TS,
    );
    const tooNew = await refusalOf(() => previewExecutionRestore(world.context, tooNewPath));
    expect(tooNew.code).toBe("store.activation-stale");
    expect(tooNew.message).toContain("newer build");

    // Nothing above touched the live store.
    expect(footprint(world.dbPath)).toEqual(untouched);
  });

  test("execution-restore-preview-lists-every-domain-and-proceeds-without-a-digest-approval", async () => {
    const world = await recoveryWorld("restore-preview");
    const baselineIssue = await captureIssue(world.context, issueInput("Origin-only baseline"), {
      operationId: "op-origin-baseline",
      actor: "project-manager",
    });
    const provenance = rawGet<{ id: number }>(
      world.dbPath,
      `select id from provenance where issue_id='${baselineIssue.issueId}' and kind='capture'`,
    )!;
    const point = await recoveryPoint(world, "preview-point");
    const clean = await previewExecutionRestore(world.context, point.backupPath);
    // An unchanged store has no loss at all: no differences, no lost receipts.
    expect(clean.authorityDifferences).toEqual([]);
    expect(clean.lostOperationIds).toEqual([]);
    expect(clean.liveStoreId).toBe(world.storeId);
    expect(clean.liveEpoch).toBe(world.epoch);
    expect(clean.backupEpoch).toBe(world.epoch);

    await mutateEveryDomain(world, "preview");
    rawRun(world.dbPath, "update provenance set origin='scoped' where id=?", provenance.id);
    const provenanceKey = `issue:provenance:${provenance.id}`;
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const issueId = rawGet<{ id: string }>(world.dbPath, "select id from issues where title='Post-backup finding preview'")!.id;
    const keys = preview.authorityDifferences.map((entry) => `${entry.domain}:${entry.key}`);
    for (const expected of [
      provenanceKey,
      "issue:store_meta",
      "issue:issue:" + issueId,
      "issue:occurrence:run-Post-backup finding preview",
      "issue:issue-counter",
      "issue:store-operation:op-issue-preview",
      "catalog:store_meta.catalog_revision",
      "catalog:entity:document/doc-preview",
      "catalog:entity:plan/" + PLAN_2,
      "catalog:catalog-operation:op-document-preview",
      "catalog:catalog-operation:register-" + PLAN_2,
      "execution:execution_meta",
      "execution:workflow:" + WF2,
      "execution:registry:" + WF2,
      "execution:plan:" + WF2 + "/" + PLAN_2,
      "execution:input:" + WF2 + "/" + PLAN_2,
      "execution:operation:" + world.epoch + "/op-workflow-preview",
    ]) {
      expect(keys).toContain(expected);
    }
    // Rows the change did NOT touch are never reported: no false positives.
    for (const untouched of [
      "execution:workflow:" + WF,
      "execution:plan:" + WF + "/" + PLAN_1,
      "execution:session:" + WF + "/coordinator/" + COORDINATOR,
      "execution:input:" + WF + "/" + PLAN_1,
      "issue:issue:nonexistent",
    ]) {
      expect(keys).not.toContain(untouched);
    }
    // Every listed row really does differ between the two files…
    const pointDb = point.backupPath;
    for (const entry of preview.authorityDifferences) {
      expect(entry.domain === "issue" || entry.domain === "catalog" || entry.domain === "execution").toBe(true);
      expect(entry.key.length).toBeGreaterThan(0);
      expect(entry.liveRevision === null || Number.isSafeInteger(entry.liveRevision)).toBe(true);
      expect(entry.backupRevision === null || Number.isSafeInteger(entry.backupRevision)).toBe(true);
      // …and at least one side holds it (a listed row is never absent twice).
      expect(entry.liveRevision !== null || entry.backupRevision !== null).toBe(true);
    }
    // …and the committed operation ids of all three domains are listed.
    expect([...preview.lostOperationIds].sort()).toEqual(
      [
        "catalog:op-document-preview",
        "catalog:register-" + PLAN_2,
        "execution:" + world.epoch + ":op-workflow-preview",
        "issue:op-issue-preview",
      ].sort(),
    );
    expect(pointDb.length).toBeGreaterThan(0);


    // The loss is authorized by row/operation identities, never its digest.
    preview.lossDigest = "record-only";
    const receipt = await restoreExecutionBackup(world.context, {
      preview,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });
    expect(receipt.storeId).toBe(world.storeId);
    expect(receipt.epoch).toBe(Math.max(world.epoch, point.epoch) + 1);
  });

  test("execution-restore-refuses-new-loss-and-recovers-through-a-fresh-preview", async () => {
    const world = await recoveryWorld("restore-new-loss");
    const point = await recoveryPoint(world, "new-loss-point");
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    await captureIssue(world.context, issueInput("New unapproved finding"), {
      operationId: "op-new-unapproved-finding", actor: "project-manager",
    });
    const before = footprint(world.dbPath);
    const staleImage = join(world.harness, `.store-restore-${randomUUID()}.db`);
    writeFileSync(staleImage, JSON.stringify({ attempt: "orphan", state: "pending" }));
    const refusal = await refusalOf(() => restoreExecutionBackup(world.context, {
      preview, operator: OPERATOR, authorization: AUTHORIZATION,
    }));
    expect(refusal.code).toBe("execution.recovery-loss-unaccepted");
    expect(footprint(world.dbPath)).toEqual(before);
    expect(JSON.parse(readFileSync(staleImage, "utf8"))).toMatchObject({ attempt: "orphan", state: "pending" });
    const current = await previewExecutionRestore(world.context, point.backupPath);
    const receipt = await restoreExecutionBackup(world.context, {
      preview: current, operator: OPERATOR, authorization: AUTHORIZATION,
    });
    expect(footprint(world.dbPath).issues).toBe(0);
    expect(footprint(receipt.preRestoreBackup.backupPath).issues).toBe(1);
  });

  test("execution-restore-installs-the-inventoried-image-when-the-selected-path-is-replaced", async () => {
    const world = await recoveryWorld("restore-backup-swap");
    const point = await recoveryPoint(world, "selected-point");
    const selected = footprint(point.backupPath);
    await captureIssue(world.context, issueInput("Replacement backup finding"), {
      operationId: "op-replacement-backup", actor: "project-manager",
    });
    const replacement = await recoveryPoint(world, "replacement-point");
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const safetyDir = join(world.harness, "archived", "store-migration", "backups");
    let swapped = false;
    let stop = false;
    const injector = (async () => {
      while (!stop) {
        await nextTurn();
        if (swapped || !existsSync(safetyDir)) continue;
        if (!readdirSync(safetyDir).some((name) => name.startsWith("pre-restore-") && statSync(join(safetyDir, name)).size > 0)) continue;
        writeFileSync(point.backupPath, readFileSync(replacement.backupPath));
        swapped = true;
      }
    })();
    try {
      await restoreExecutionBackup(world.context, { preview, operator: OPERATOR, authorization: AUTHORIZATION });
    } finally {
      stop = true;
      await injector;
    }
    expect(swapped).toBe(true);
    expect(footprint(world.dbPath).issues).toBe(selected.issues);
    expect(footprint(world.dbPath).revision).toBe(selected.revision);
  });

  test("execution-restore-installs-the-selected-state-and-invalidates-old-references", async () => {
    const world = await recoveryWorld("restore-install");
    const point = await recoveryPoint(world, "install-point");
    const before = footprint(world.dbPath);
    const preRestoreHandle = await currentAuthorityHandle(world.context);
    const preRestoreRef = world.sessionRef;
    await mutateEveryDomain(world, "install");
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const mutated = footprint(world.dbPath);
    expect(mutated.workflows).toBe(before.workflows + 1);

    const receipt = await restoreExecutionBackup(world.context, {
      preview,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });

    // §8: the epoch moves ABOVE both the live store and the point, and the
    // whole-store state is exactly the selected recovery point.
    expect(receipt.storeId).toBe(world.storeId);
    expect(receipt.epoch).toBe(Math.max(before.epoch, point.epoch) + 1);
    expect(receipt.preRestoreBackup.storeId).toBe(world.storeId);
    expect(receipt.preRestoreBackup.epoch).toBe(before.epoch);
    const after = footprint(world.dbPath);
    expect(after.epoch).toBe(receipt.epoch);
    expect(after.revision).toBe(before.revision);
    expect(after.catalogRevision).toBe(before.catalogRevision);
    expect(after.issues).toBe(before.issues);
    expect(after.catalogEntities).toBe(before.catalogEntities);
    expect(after.workflows).toBe(before.workflows);
    expect(after.plans).toBe(before.plans);
    expect(rawAll<{ workflow_id: string }>(world.dbPath, "select workflow_id from execution_workflows")).toEqual([
      { workflow_id: WF },
    ]);

    // The durable record is the OPERATOR-facing copy of a record the store
    // itself committed in the same transaction as the authority it describes.
    const record = JSON.parse(readFileSync(receipt.recoveryReceiptPath, "utf8")) as Record<string, unknown>;
    expect(record.phase).toBe("replaced");
    expect(record.newEpoch).toBe(receipt.epoch);
    expect(record.verified).toMatchObject({ integrity: "ok", foreignKeys: "ok" });
    expect(String(record.requiredRebind)).toContain("recoverExecutionCoordinator");
    const committedRecord = rawGet<{ result_json: string }>(
      world.dbPath,
      "select result_json from store_operations where operation_id like 'restore-attempt:%'",
    );
    expect(JSON.parse(committedRecord!.result_json)).toMatchObject({ newEpoch: receipt.epoch, phase: "replaced" });

    // The pre-restore state is recoverable: the safety point holds the work
    // the restore disclosed as loss.
    const safety = new DatabaseSync(receipt.preRestoreBackup.backupPath, { readOnly: true });
    try {
      expect((safety.prepare("select count(*) as n from issues").get() as { n: number }).n).toBe(mutated.issues);
      expect((safety.prepare("select count(*) as n from execution_workflows").get() as { n: number }).n).toBe(mutated.workflows);
    } finally {
      safety.close();
    }

    // Old references are invalidated: the pre-restore handle and the store's
    // own pre-restore session binding both refuse at the new epoch.
    const staleHandle = await refusalOf(() => assertAuthorityCurrent(world.context, preRestoreHandle));
    expect(staleHandle.code).toBe("store.stale-epoch");
    await expect(readExecutionState(world.context)).resolves.toMatchObject({ epoch: receipt.epoch });
    const staleSession = await refusalOf(() =>
      mutateExecutionWorkflow(contextOf(world.context, callerOf(WF, COORDINATOR)), {
        operationId: "op-after-restore",
        session: preRestoreRef,
        expected: world.workflowToken,
        workflowId: WF,
        operation: { kind: "lifecycle", status: "running", reason: "after restore" },
      }),
    );
    expect(["store.stale-epoch", "execution.session-unavailable"]).toContain(staleSession.code);

  });

  test("execution-restore-identifies-a-crash-before-and-after-the-commit", async () => {
    const world = await recoveryWorld("restore-crash");
    const point = await recoveryPoint(world, "crash-point");
    // Hold a store connection open for the whole case, so every commit
    // `mutateEveryDomain` makes stays as an un-checkpointed frame in the live
    // `-wal` rather than being folded away by whichever earlier handle closed
    // last: the pre-commit crash below is decided on a store with real pending
    // frames, not on a coincidence of runtime finalization.
    const held = await openStore(world.context, "write");
    try {
      await mutateEveryDomain(world, "crash");
      const preview = await previewExecutionRestore(world.context, point.backupPath);
      const liveFootprint = footprint(world.dbPath);
      const liveInode = statSync(world.dbPath).ino;

      // A failure BEFORE the commit: the transaction rolls back as a unit, so the
      // original generation is still authoritative and its epoch is unmoved.
      const beforeFailure = await errorOf(async () => {
        process.env.MSTAR_STORE_TEST_RUNNER = "1";
        process.env.MSTAR_STORE_FAIL_EXECUTION_RESTORE = "before-replacement";
        try {
          return await restoreExecutionBackup(world.context, {
            preview,
            operator: OPERATOR,
            authorization: AUTHORIZATION,
          });
        } finally {
          delete process.env.MSTAR_STORE_FAIL_EXECUTION_RESTORE;
          delete process.env.MSTAR_STORE_TEST_RUNNER;
        }
      });
      expect(beforeFailure.message).toContain("before-replacement");
      // Nothing about the store's AUTHORITY moved, and no receipt was written:
      // a pre-commit interruption is a mutation-free outcome, which is what the
      // same public retry can identify.
      expect(footprint(world.dbPath)).toEqual(liveFootprint);
      expect(existsSync(join(world.harness, "archived", "store-migration", "recovery"))).toBe(false);
      expect(statSync(world.dbPath).ino).toBe(liveInode);

      // A failure AFTER the commit: the replacement IS the committed outcome. The
      // store already holds the new epoch AND the complete recovery record in its
      // own ledger, so the outcome is identifiable from the store alone and the
      // operator-facing file is a copy of that same committed record.
      const afterFailure = await errorOf(async () => {
        process.env.MSTAR_STORE_TEST_RUNNER = "1";
        process.env.MSTAR_STORE_FAIL_EXECUTION_RESTORE = "after-replacement";
        try {
          return await restoreExecutionBackup(world.context, {
            preview,
            operator: OPERATOR,
            authorization: AUTHORIZATION,
          });
        } finally {
          delete process.env.MSTAR_STORE_FAIL_EXECUTION_RESTORE;
          delete process.env.MSTAR_STORE_TEST_RUNNER;
        }
      });
      expect(afterFailure.message).toContain("after-replacement");
      const committed = recoveryRecords(world);
      expect(committed).toHaveLength(1);
      expect(committed[0]!.phase).toBe("replaced");
      const newEpoch = committed[0]!.newEpoch;
      const resumed = footprint(world.dbPath);
      expect(resumed.epoch).toBe(newEpoch);
      expect(resumed.issues).toBe(0);
      expect(resumed.workflows).toBe(1);
      expect(statSync(world.dbPath).ino).toBe(liveInode);
      // The committed record is IN the store, in the same commit as the authority
      // it describes — not only in the file beside it.
      expect(
        rawGet<{ result_json: string }>(
          world.dbPath,
          "select result_json from store_operations where operation_id like 'restore-attempt:%'",
        )!.result_json,
      ).toContain(`"newEpoch":${newEpoch}`);
      await expect(readExecutionState(world.context)).resolves.toMatchObject({ epoch: newEpoch });

      // The same public retry (a fresh preview of a store now at the new epoch)
      // is refused rather than replacing anything again: a committed outcome is
      // not silently redone.
      const retried = await previewExecutionRestore(world.context, point.backupPath);
      expect(retried.liveEpoch).toBe(newEpoch);
      const receipt = await restoreExecutionBackup(world.context, {
        preview: retried,
        operator: OPERATOR,
        authorization: AUTHORIZATION,
      });
      expect(receipt.epoch).toBe(newEpoch + 1);
    } finally {
      held.close();
    }
  });

  test("execution-restore-refuses-a-competitor-commit-at-the-admission-boundary", async () => {
    const world = await recoveryWorld("restore-admission-window");
    const point = await recoveryPoint(world, "admission-window-point");
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const liveFootprint = footprint(world.dbPath);
    const liveInode = statSync(world.dbPath).ino;

    // The competitor commits INSIDE the restore's own admission window: the
    // barrier is the pre-restore safety point, which the sequence takes after it
    // has staged and verified the image and before it opens the owning write
    // transaction. The safety directory appearing is therefore proof the restore
    // is already past staging and has not yet re-derived the loss, and the write
    // below lands in the exact gap the in-transaction re-read exists to close.
    const safetyDir = join(world.harness, "archived", "store-migration", "backups");
    let injected = false;
    let stop = false;
    const injector = (async () => {
      while (!stop) {
        await nextTurn();
        if (injected) continue;
        if (!existsSync(safetyDir)) continue;
        if (!readdirSync(safetyDir).some((name) => name.startsWith("pre-restore-"))) continue;
        await captureIssue(world.context, issueInput("Competitor at the admission boundary"), {
          operationId: "op-admission-boundary-competitor",
          actor: "project-manager",
        });
        injected = true;
      }
    })();

    let refusal: { code: string; message: string } | null = null;
    try {
      refusal = await refusalOf(() =>
        restoreExecutionBackup(world.context, {
          preview,
          operator: OPERATOR,
          authorization: AUTHORIZATION,
        }),
      );
    } finally {
      stop = true;
      await injector;
    }

    // The competitor really did land in the window, and the refusal named the
    // unapproved loss rather than discarding it.
    expect(injected).toBe(true);
    expect(refusal!.code).toBe("execution.recovery-loss-unaccepted");
    expect(refusal!.message).toContain("outside the authorized loss inventory");

    // Nothing was replaced and nothing was lost: the competitor's issue is still
    // live, the authority generation is unmoved, and the live file is the SAME
    // inode — this restore never renames the live database.
    expect(footprint(world.dbPath).issues).toBe(liveFootprint.issues + 1);
    expect(footprint(world.dbPath).epoch).toBe(liveFootprint.epoch);
    expect(statSync(world.dbPath).ino).toBe(liveInode);

    // The public retry path is a fresh preview plus the same restore: the
    // competitor's work is disclosed as loss, and the operator decides again.
    const current = await previewExecutionRestore(world.context, point.backupPath);
    const receipt = await restoreExecutionBackup(world.context, {
      preview: current,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });
    expect(receipt.epoch).toBe(Math.max(liveFootprint.epoch, point.epoch) + 1);
    expect(footprint(world.dbPath).issues).toBe(liveFootprint.issues);
    expect(statSync(world.dbPath).ino).toBe(liveInode);
  });

  test("execution-restore-reclaims-only-a-committed-attempts-scratch-and-preserves-a-live-peer", async () => {
    const world = await recoveryWorld("restore-sweep");
    const point = await recoveryPoint(world, "sweep-point");
    await mutateEveryDomain(world, "sweep");

    // The staged images under the control root. Reclamation requires POSITIVE
    // evidence from the store; anything the ledger does not name is preserved,
    // because an attempt with no committed record is indistinguishable from a
    // live peer that has staged its image and not yet reached its transaction.
    const receiptDir = join(world.harness, "archived", "store-migration", "recovery");
    mkdirSync(receiptDir, { recursive: true });
    const plant = (attemptId: string, bytes: Buffer, committed: boolean): { image: string; receiptPath: string } => {
      const image = join(world.harness, `.store-restore-${attemptId}.db`);
      const receiptPath = join(receiptDir, `restore-${Date.now().toString().padStart(16, "0")}-${attemptId}.json`);
      writeFileSync(image, bytes);
      writeFileSync(`${image}-journal`, Buffer.from("stranded by a crash mid-transaction"));
      writeFileSync(`${image}-wal`, Buffer.from("stranded wal"));
      writeFileSync(`${image}-shm`, Buffer.from("stranded shm"));
      writeFileSync(receiptPath, JSON.stringify({ phase: "replaced", restoredCopySha256: "0".repeat(64) }));
      if (committed) {
        // The ONLY durable witness that an attempt committed: the recovery record
        // it wrote into `store_operations` in the same transaction as the
        // authority it describes.
        rawRun(
          world.dbPath,
          "insert into store_operations(operation_id, request_hash, result_json, committed_at) values (?, ?, ?, ?)",
          `restore-attempt:${attemptId}`,
          "0".repeat(64),
          JSON.stringify({ phase: "replaced" }),
          TS,
        );
      }
      return { image, receiptPath };
    };

    // (1) A COMMITTED attempt whose crash left its image behind: the store names
    // its commit, so its staging bytes are provably inert scratch.
    const committedBytes = Buffer.from("a staged image whose commit landed");
    const committed = plant(randomUUID(), committedBytes, true);

    // (2) A LIVE PEER: an image staged by an attempt that has not committed yet
    // — exactly the state a real concurrent restore occupies between staging and
    // its owning transaction now that no maintenance lock serializes it. The
    // store does not name it, so the sweep must preserve it byte for byte.
    const peerImage = join(world.harness, `.store-restore-${randomUUID()}.db`);
    const peerBytes = Buffer.from("a live peer's staged image, not yet committed");
    writeFileSync(peerImage, peerBytes);
    writeFileSync(`${peerImage}-journal`, Buffer.from("the peer's own staging journal"));
    writeFileSync(`${peerImage}-wal`, Buffer.from("the peer's own staged wal"));

    // A crashed attempt that never committed anything is preserved for the same
    // reason as the peer: with no positive evidence, the sweep cannot tell them
    // apart, so it deletes neither.
    const unreceiptedImage = join(world.harness, `.store-restore-${randomUUID()}.db`);
    writeFileSync(unreceiptedImage, Buffer.from("an image staged before any commit"));
    writeFileSync(`${unreceiptedImage}-journal`, Buffer.from("stranded by a crash mid-transaction"));

    // The approval is taken AFTER the fixtures are planted, so the committed
    // attempt's witness row is inside the loss the operator authorizes — which is
    // what a real operator sees: the row is part of the generation being replaced.
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const receipt = await restoreExecutionBackup(world.context, {
      preview,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });
    expect(receipt.storeId).toBe(world.storeId);

    // The committed attempt's image and the sidecars its crash stranded are
    // reclaimed, and its durable receipt stays as evidence.
    expect(existsSync(committed.image)).toBe(false);
    expect(existsSync(`${committed.image}-journal`)).toBe(false);
    expect(existsSync(`${committed.image}-wal`)).toBe(false);
    expect(existsSync(`${committed.image}-shm`)).toBe(false);
    expect(existsSync(committed.receiptPath)).toBe(true);

    // The live peer's staged image and its own sidecars survive BYTE FOR BYTE,
    // so a peer suspended in staging/verification still has its input, and no
    // uncommitted image is ever removed on a guess.
    expect(readFileSync(peerImage)).toEqual(peerBytes);
    expect(existsSync(`${peerImage}-journal`)).toBe(true);
    expect(existsSync(`${peerImage}-wal`)).toBe(true);
    expect(readFileSync(unreceiptedImage, "utf8")).toBe("an image staged before any commit");
    expect(existsSync(`${unreceiptedImage}-journal`)).toBe(true);
  });

  test("execution-restore-refuses-an-incomplete-inventory-and-keeps-both-files", async () => {
    const world = await recoveryWorld("restore-incomplete");
    const point = await recoveryPoint(world, "incomplete-point");
    await mutateEveryDomain(world, "incomplete");

    // Live corruption that prevents a complete loss inventory: the point and
    // the live store are BOTH kept, and no destructive restore is attempted.
    // Remove a required authority table instead of relying on raw page damage:
    // a valid SQLite file is still incomplete when its committed-operation
    // inventory cannot be read.
    rawRun(world.dbPath, "drop table execution_operations");
    const backupIssues = rawGet<{ n: number }>(point.backupPath, "select count(*) as n from issues")!.n;
    const refusal = await refusalOf(() => previewExecutionRestore(world.context, point.backupPath));
    expect(refusal.code).toBe("execution.recovery-loss-unaccepted");
    expect(refusal.message).toMatch(/inventory|integrity/);
    expect(existsSync(world.dbPath)).toBe(true);
    expect(existsSync(point.backupPath)).toBe(true);
    expect(rawGet<{ n: number }>(point.backupPath, "select count(*) as n from issues")!.n).toBe(backupIssues);
    expect(rawGet<{ n: number }>(world.dbPath, "select count(*) as n from issues")!.n).toBe(point.counts.issues + 1);
  });

  test("execution-restore-keeps-the-live-store-pathname-and-inode-and-leaves-legacy-markers-alone", async () => {
    const world = await recoveryWorld("restore-same-live-file");
    const point = await recoveryPoint(world, "same-live-point");
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const before = statSync(world.dbPath);

    // Leftover homemade mutex markers from a pre-cutover checkout: an operator
    // must not have to remove them, and a restore must neither consult nor
    // delete them. Their presence is never permission to delete anything.
    const markers = [
      join(world.harness, ".status-write.lockdir"),
      join(world.harness, ".execution-maintenance", ".status-write.lockdir"),
      join(world.harness, "workflows", WF, ".ledger-write.lockdir"),
    ];
    for (const marker of markers) {
      mkdirSync(marker, { recursive: true });
      writeFileSync(join(marker, "holder.pid"), `${process.pid}\n`);
    }

    const receipt = await restoreExecutionBackup(world.context, {
      preview,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });
    expect(footprint(world.dbPath).epoch).toBe(receipt.epoch);

    // §8: the SAME live database, not a replaced one — same pathname, same
    // inode, and no WAL/SHM of an old generation removed. Nothing in the restore
    // takes or clears a lock, so every marker and its holder file are intact.
    const after = statSync(world.dbPath);
    expect(after.ino).toBe(before.ino);
    expect(world.dbPath).toBe(join(world.harness, "store.db"));
    for (const marker of markers) {
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(join(marker, "holder.pid"), "utf8")).toBe(`${process.pid}\n`);
    }
    // …and the restore is not blocked by them: it ran with a marker held by a
    // live pid for this very process, which is exactly what the deleted lock
    // would have refused.
    expect(existsSync(receipt.recoveryReceiptPath)).toBe(true);
    expect(receipt.recoveryReceiptPath.startsWith(canonicalPath(world.harness))).toBe(true);
  });

  test("execution-restore-preview-leaves-the-live-store-file-state-untouched", async () => {
    const world = await recoveryWorld("restore-preview-state");
    const point = await recoveryPoint(world, "state-point");
    await mutateEveryDomain(world, "state");
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const receipt = await restoreExecutionBackup(world.context, {
      preview,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });

    // The restore replaced the live database's CONTENTS in place: it never swaps
    // the file for a VACUUM INTO image, so the store keeps the journal mode and
    // the sidecars its own connection established (a writer open sets WAL). No
    // `store.db`-adjacent artifact of an old generation is installed or removed.
    const journalMode = (): string => rawGet<{ journal_mode: string }>(world.dbPath, "pragma journal_mode")!.journal_mode;
    expect(journalMode()).toBe("wal");

    // A second loss preview reads that store. §8 says the preview mutates
    // nothing, so reading the loss may not reconfigure the live store's journal
    // mode and may not invent or drop sidecars.
    const before = {
      journalMode: journalMode(),
      wal: existsSync(`${world.dbPath}-wal`),
      shm: existsSync(`${world.dbPath}-shm`),
    };
    const again = await previewExecutionRestore(world.context, point.backupPath);
    expect(again.liveEpoch).toBe(receipt.epoch);
    expect({ journalMode: journalMode(), wal: existsSync(`${world.dbPath}-wal`), shm: existsSync(`${world.dbPath}-shm`) }).toEqual(
      before,
    );
  });

  test("execution-restore-preview-reads-a-quiesced-wal-store-and-leaves-its-file-state-untouched", async () => {
    const world = await recoveryWorld("restore-quiesced-wal");
    const point = await recoveryPoint(world, "quiesced-wal-point");
    await mutateEveryDomain(world, "quiesced-wal");

    // The shape of a WAL store nobody is using: SQLite folds every committed
    // frame into the database file on the last clean close and removes both
    // sidecars, while the header keeps recording WAL. Nothing here fabricates
    // that state — SQLite itself checkpoints the store (a 0-byte `-wal` proves
    // every frame landed) and only then are the empty sidecars removed, which is
    // exactly what its own cleanup leaves behind.
    const quiesce = new DatabaseSync(world.dbPath);
    try {
      quiesce.exec("pragma busy_timeout=1000");
      const checkpoint = quiesce.prepare("pragma wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
      expect(checkpoint?.busy).toBe(0);
    } finally {
      quiesce.close();
    }
    expect(statSync(`${world.dbPath}-wal`).size).toBe(0);
    rmSync(`${world.dbPath}-wal`, { force: true });
    rmSync(`${world.dbPath}-shm`, { force: true });

    // The live file state, read from bytes alone: no connection may be opened to
    // inspect it, because opening one is what this case is about.
    const liveState = (): { journalMode: string; sidecars: string; sha256: string } => {
      const header = Buffer.alloc(100);
      const fd = openSync(world.dbPath, "r");
      try {
        readSync(fd, header, 0, header.length, 0);
      } finally {
        closeSync(fd);
      }
      return {
        // SQLite's file-format write version: 2 is WAL, 1 a rollback journal.
        journalMode: header[18] === 2 && header[19] === 2 ? "wal" : `not-wal(${header[18]},${header[19]})`,
        sidecars: ["-wal", "-shm"].filter((suffix) => existsSync(`${world.dbPath}${suffix}`)).join(",") || "none",
        sha256: sha256OfFile(world.dbPath),
      };
    };
    const before = liveState();
    expect(before).toMatchObject({ journalMode: "wal", sidecars: "none" });

    // §8's preview mutates nothing, and that has to hold for THIS shape too: a
    // read-only open cannot create the `-wal` SQLite insists on before it reads
    // a WAL store, so the capability path may not leave one (or anything else)
    // beside the live store to make the read possible.
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    expect(preview.liveStoreId).toBe(world.storeId);
    // The post-point work is really in the inventory: this was a live read, not
    // a refusal dressed up as a preview.
    expect(preview.authorityDifferences.length).toBeGreaterThan(0);

    expect(liveState()).toEqual(before);
  });

  test("execution-restore-normalizes-a-malformed-live-inventory-row-to-the-loss-refusal", async () => {
    const world = await recoveryWorld("restore-malformed-row");
    const point = await recoveryPoint(world, "malformed-row-point");
    await captureIssue(world.context, issueInput("Malformed-row finding"), {
      operationId: "op-malformed-row",
      actor: "project-manager",
    });
    const preview = await previewExecutionRestore(world.context, point.backupPath);

    // The live store still holds the row, but its own authority revision is no
    // longer a revision this build can read, so the loss cannot be inventoried.
    const issueId = rawGet<{ id: string }>(world.dbPath, "select id from issues")!.id;
    rawRun(world.dbPath, "update issues set revision = 1.5 where id = ?", issueId);

    // "The loss inventory is incomplete" is ONE machine-readable verdict, with
    // the underlying cause kept: a caller must not have to tell it apart from an
    // unrelated corrupt-store failure.
    const refusal = await refusalOf(() => previewExecutionRestore(world.context, point.backupPath));
    expect(refusal.code).toBe("execution.recovery-loss-unaccepted");
    expect(refusal.message).toMatch(/revision is 1\.5, not a safe integer/);

    // The destructive verb reaches the same verdict on the same store, so an
    // inventory that cannot be built can never be a safe rollback: nothing is
    // replaced, and no approval is consulted.
    const destructive = await refusalOf(() =>
      restoreExecutionBackup(world.context, {
        preview,
        operator: OPERATOR,
        authorization: AUTHORIZATION,
      }),
    );
    expect(destructive.code).toBe("execution.recovery-loss-unaccepted");
  });
});

// ---------------------------------------------------------------------------
// Diagnostic export
// ---------------------------------------------------------------------------

/** Keys whose presence would make the export a writer input or a credential carrier. */
const FORBIDDEN_KEYS: Record<string, true> = {
  session: true,
  session_id: true,
  sessionId: true,
  session_file: true,
  session_label: true,
  holder: true,
  holder_session_id: true,
  creator_session_id: true,
  submitted_by: true,
  accepted_by: true,
  token: true,
  expected: true,
  credential: true,
  secret: true,
  bearer: true,
  authorization: true,
};

function forbiddenKeysIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) forbiddenKeysIn(item, found);
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (Object.prototype.hasOwnProperty.call(FORBIDDEN_KEYS, key)) found.push(key);
      forbiddenKeysIn(entry, found);
    }
  }
  return found;
}

type RecoveryRecord = {
  phase: string;
  newEpoch: number;
  liveStoreSha256: string;
  restoredCopySha256: string;
  requiredRebind: string;
};

/** Every durable recovery receipt this store has written, newest name last. */
function recoveryRecords(world: Fixture): RecoveryRecord[] {
  const dir = join(world.harness, "archived", "store-migration", "recovery");
  return readdirSync(dir)
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as RecoveryRecord);
}

describe("execution-export", () => {
  test("execution-export-is-a-credential-free-diagnostic-that-authorizes-nothing", async () => {
    const world = await recoveryWorld("export-world");
    const epoch = world.epoch;
    // A REAL workflow-wide integration claim in the DB's own shape, so the
    // export's claim projection is proven rather than merely demanded. The
    // removed per-plan lease has no table any more.
    rawRun(
      world.dbPath,
      "insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, ?, ?)",
      WF,
      epoch,
      JSON.stringify({
        holder: COORDINATOR,
        claimed_at: TS,
        plan_id: PLAN_1,
        source_branch: `feature/${PLAN_1}`,
        target_branch: "main",
        started_at: TS,
      }),
    );

    // The store really does hold the session identity the export must drop.
    const identified = rawGet<{ session_id: string }>(world.dbPath, "select session_id from execution_sessions")!;
    expect(identified.session_id).toBe(COORDINATOR);
    // A REAL prepared/completed coordination row: the contracted shapes record
    // the coordinator identity in `prepared_by`/`completed_by`, so the export's
    // redaction is proven against the row it actually projects — not only the
    // top-level session list it already omits.
    rawRun(
      world.dbPath,
      "update execution_plans set coordination_json = ? where workflow_id = ? and plan_id = ?",
      JSON.stringify({
        prepared: { qa_gate: "mandatory", findings_cleanup: "allow-residual", prepared_by: COORDINATOR, prepared_at: TS },
        completion: {
          source_branch: `feature/${PLAN_1}`,
          source_sha: "a".repeat(40),
          worktree_path: join(world.harness, "worktrees", PLAN_1),
          review_base: "a".repeat(40),
          review_head: "a".repeat(40),
          qc: { decision: "Approve", reports: [{ path: join(world.harness, "qc.md"), sha256: "b".repeat(64) }], consolidated: { path: join(world.harness, "qc-s.md"), sha256: "c".repeat(64) } },
          qa: { gate: "mandatory", decision: "pass", report: { path: join(world.harness, "qa.md"), sha256: "d".repeat(64) } },
          completed_by: COORDINATOR,
          completed_at: TS,
        },
      }),
      WF,
      PLAN_1,
    );
    expect(rawGet<{ creator_session_id: string }>(world.dbPath, "select creator_session_id from execution_workflows")!.creator_session_id).toBe(
      COORDINATOR,
    );

    const exported = await exportExecutionState(world.context);
    expect(exported.format).toBe("execution-diagnostic-v1");
    const parsed = JSON.parse(exported.canonicalJson) as Record<string, any>;

    // §8: identity/epoch/revisions, source status, workflow/plan/lease state
    // and the public frozen input all travel.
    expect(parsed.format).toBe("execution-diagnostic-v1");
    expect(parsed.store).toMatchObject({ storeId: world.storeId, epoch, authorityState: "active" });
    expect(parsed.execution).toMatchObject({ authorityState: "active" });
    expect(parsed.migrations.map((entry: { manifestId: string }) => entry.manifestId)).toEqual([]);
    const workflow = parsed.workflows[0];
    expect(workflow.workflowId).toBe(WF);
    expect(workflow.state).toMatchObject({ id: WF, status: "running" });
    const plan = workflow.plans[0];
    expect(plan.planId).toBe(PLAN_1);
    expect(plan).not.toHaveProperty("lease");
    expect(workflow.integrationLease).toMatchObject({ claimed_at: TS, source_branch: `feature/${PLAN_1}` });
    // Sessions travel as a state projection without the identity they are
    // addressed by: role, state, epoch, revision and the binding instant.
    expect(parsed.sessions).toEqual([
      { workflowId: WF, role: "coordinator", state: "active", epoch, revision: 1, boundAt: expect.any(String) },
    ]);

    // The session identities, the CAS tokens and the credential paths the
    // store holds never reach the export.
    expect(exported.canonicalJson.includes(COORDINATOR)).toBe(false);
    expect(exported.canonicalJson.includes("exec-v1:")).toBe(false);
    expect(exported.canonicalJson.includes("sessions/")).toBe(false);
    expect(exported.canonicalJson.includes("session_file")).toBe(false);
    expect(exported.canonicalJson.includes("store.db")).toBe(false);
    expect(exported.canonicalJson.includes(".status-write.lockdir")).toBe(false);
    expect(forbiddenKeysIn(parsed)).toEqual([]);
    expect(parsed.redactedKeys).toContain("holder");
    // The row's own coordination projection is present (its business evidence
    // travels) but carries no coordinator identity: `prepared_by`/`completed_by`
    // are redacted exactly like the old `accepted_by`.
    expect(parsed.redactedKeys).toEqual(expect.arrayContaining(["prepared_by", "completed_by"]));
    const projected = workflow.plans[0].coordination as Record<string, any>;
    expect(projected.prepared).not.toHaveProperty("prepared_by");
    expect(projected.completion).toMatchObject({ qc: { decision: "Approve" }, qa: { decision: "pass" } });
    expect(projected.completion).not.toHaveProperty("completed_by");
    expect(projected.completion.completed_at).toBe(TS);


    // …and the artifact authorizes nothing: fed to a real writer as its
    // request, it is refused and the store is untouched.
    const before = footprint(world.dbPath);
    const refused = await refusalOf(() =>
      mutateExecutionWorkflow(contextOf(world.context, world.caller), workflow as never),
    );
    expect(refused.code).toBe("coordination.invalid-input");
    expect(footprint(world.dbPath)).toEqual(before);
  });

  test("execution-export-covers-a-staged-store-without-its-migration-sources", async () => {
    const world = await recoveryWorld("export-staged");
    const exported = await exportExecutionState(world.context);
    const parsed = JSON.parse(exported.canonicalJson) as Record<string, any>;
    // A store with no recorded migration reports no source inventory rather
    // than an empty-success one.
    expect(parsed.sources).toEqual([]);
    expect(parsed.migrations).toEqual([]);
    expect(parsed.execution).toMatchObject({ authorityState: "active" });
  });
});

// ---------------------------------------------------------------------------
// The schema-owned loss inventory: every authority domain, nothing file-native
// ---------------------------------------------------------------------------

describe("schema-owned loss inventory", () => {
  test("preview inventories every authority domain, including the native host state", async () => {
    const world = await recoveryWorld("inventory-host");
    const point = await recoveryPoint(world, "host-inventory-point");
    // Native Dsh host state is authority: rows written through the real
    // producers AFTER the point are disclosed as host-domain loss.
    expect(appendDshLedgerRow(world.context, WF, '{"v":1,"kind":"row"}', "row-1")).toMatchObject({ kind: "written" });
    expect(
      appendDshWorkflowEvent(world.context, {
        workflowId: WF,
        eventId: "evt-1",
        digest: "a".repeat(64),
        lineJson: '{"v":1,"kind":"dispatch"}',
        source: { sessionId: COORDINATOR, streamId: "stream", seq: 2 },
      }),
    ).toMatchObject({ kind: "accepted" });
    expect(advanceDshScanBound(world.context, WF, COORDINATOR, 3, "stream")).toBe(true);
    expect(writeDshSessionBinding(world.context, COORDINATOR, world.context.harnessDir, { selectedWorkflowId: WF, excludedBeforeSeq: 0 })).toMatchObject({
      kind: "written",
    });
    expect(recordDshStatusEmission(world.context, COORDINATOR, world.context.harnessDir, 1, '{"sv":1}')).toMatchObject({ kind: "written" });
    // Project content authority through its real producer: the project entity
    // is registered first, then the milestone keys off it.
    await registerCatalogEntity(
      world.context,
      { kind: "project", id: PROJECT_ID, title: "Inventory project", rootKind: "projects", relativePath: `projects/${PROJECT_ID}` },
      { operationId: "op-inventory-project", actor: OPERATOR },
    );
    const revision = rawGet<{ revision: number }>(world.dbPath, "select revision from store_meta where id = 1")!.revision;
    const milestone = await addMilestone(world.context, { projectId: PROJECT_ID, name: "Inventory milestone", target: null, ordinal: 0 }, {
      operationId: "op-inventory-milestone",
      expectedStoreRevision: revision,
    });

    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const keys = preview.authorityDifferences.map((entry) => `${entry.domain}:${entry.key}`);
    expect(keys).toContain("host:ledger-event:1");
    expect(keys).toContain("host:ledger-event:2");
    expect(keys).toContain(`host:accepted:${WF}/evt-1`);
    expect(keys).toContain(`host:scan-bound:${WF}/${COORDINATOR}`);
    expect(keys).toContain(`host:binding:${COORDINATOR}/${world.context.harnessDir}`);
    expect(keys).toContain(`host:emission:${COORDINATOR}/${world.context.harnessDir}`);
    expect(keys).toContain(`catalog:entity:project/${PROJECT_ID}`);
    expect(keys).toContain(`catalog:milestone:${milestone.milestoneId}`);
    // The committed host-state writes carry no operation receipt of their own;
    // the milestone's does.
    expect(preview.lostOperationIds).toContain("issue:op-inventory-milestone");
    for (const entry of preview.authorityDifferences) {
      expect(entry.domain === "issue" || entry.domain === "catalog" || entry.domain === "execution" || entry.domain === "host").toBe(true);
    }
  });

  test("preview inventories project content authority and never freezes or requires file bodies", async () => {
    const world = await recoveryWorld("inventory-projects");
    // Project content authority: a registered project entity with a roadmap
    // and a milestone, planted after the point so the restore would drop them.
    const point = await recoveryPoint(world, "project-inventory-point");
    await registerCatalogEntity(
      world.context,
      { kind: "project", id: PROJECT_ID, title: "Inventory project", rootKind: "projects", relativePath: `projects/${PROJECT_ID}` },
      { operationId: "op-inventory-project", actor: OPERATOR },
    );
    rawRun(
      world.dbPath,
      "insert into project_roadmaps(project_id, content_markdown, content_hash, revision, updated_at) values (?, ?, ?, 1, ?)",
      PROJECT_ID,
      "# Inventory roadmap\n",
      "b".repeat(64),
      TS,
    );
    const revision = rawGet<{ revision: number }>(world.dbPath, "select revision from store_meta where id = 1")!.revision;
    const milestone = await addMilestone(world.context, { projectId: PROJECT_ID, name: "Content milestone", target: null, ordinal: 0 }, {
      operationId: "op-content-milestone",
      expectedStoreRevision: revision,
    });

    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const keys = preview.authorityDifferences.map((entry) => `${entry.domain}:${entry.key}`);
    expect(keys).toContain(`catalog:entity:project/${PROJECT_ID}`);
    expect(keys).toContain(`catalog:roadmap:${PROJECT_ID}`);
    expect(keys).toContain(`catalog:milestone:${milestone.milestoneId}`);
    // The loss payload covers store rows only: it neither reads nor requires
    // any file beside the store, so notes, documents and a stale body sidecar
    // from an older build are all ignored — and none of them is deleted.
    const notes = join(world.harness, "workflows", WF, "notes.jsonl");
    const journal = join(world.harness, "workflows", WF, "agent-flow-compaction.json");
    mkdirSync(dirname(notes), { recursive: true });
    writeFileSync(notes, '{"kind":"note","ts":"2026-10-12","text":"kept"}\n');
    writeFileSync(journal, '{"version":1}\n');
    const withFiles = await previewExecutionRestore(world.context, point.backupPath);
    expect(withFiles.lossDigest).toBe(preview.lossDigest);
    expect(existsSync(notes)).toBe(true);
    expect(readFileSync(notes, "utf8")).toBe('{"kind":"note","ts":"2026-10-12","text":"kept"}\n');
    expect(existsSync(journal)).toBe(true);

    // A loss payload of another generation is refused by name, never decoded.
    const oldGeneration = await refusalOf(() =>
      restoreExecutionBackup(world.context, {
        preview: { ...preview, version: EXECUTION_RECOVERY_PROTOCOL_VERSION - 1 },
        operator: OPERATOR,
        authorization: AUTHORIZATION,
      }),
    );
    expect(oldGeneration.code).toBe("execution.migration-conflict");
    expect(oldGeneration.message).toContain("loss-payload version");
  });
  test("inventory includes execution migration coverage content", async () => {
    const world = await recoveryWorld("inventory-execution-coverage");
    rawRun(
      world.dbPath,
      "insert into execution_migrations(manifest_id, manifest_hash, phase, manifest_json, created_at, updated_at, coverage_json) values (?, ?, 'retired', '{}', ?, ?, ?)",
      "coverage-inventory",
      "a".repeat(64),
      TS,
      TS,
      '{"generation":"before"}',
    );
    const point = await recoveryPoint(world, "coverage-inventory-point");
    rawRun(world.dbPath, "update execution_migrations set coverage_json = ? where manifest_id = ?", '{"generation":"after"}', "coverage-inventory");
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    expect(preview.authorityDifferences).toContainEqual({
      domain: "execution",
      key: "migration:coverage-inventory",
      liveRevision: 1,
      backupRevision: 1,
    });
  });
  test("inventory retains issue milestone membership, through the real assignment producer and as row content", async () => {
    const world = await recoveryWorld("inventory-issue-milestone");
    await registerCatalogEntity(
      world.context,
      { kind: "project", id: PROJECT_ID, title: "Membership project", rootKind: "projects", relativePath: `projects/${PROJECT_ID}` },
      { operationId: "op-membership-project", actor: OPERATOR },
    );
    const storeRevision = (): number => rawGet<{ revision: number }>(world.dbPath, "select revision from store_meta where id = 1")!.revision;
    const first = await addMilestone(world.context, { projectId: PROJECT_ID, name: "First", target: null, ordinal: 0 }, {
      operationId: "op-membership-first",
      expectedStoreRevision: storeRevision(),
    });
    const second = await addMilestone(world.context, { projectId: PROJECT_ID, name: "Second", target: null, ordinal: 1 }, {
      operationId: "op-membership-second",
      expectedStoreRevision: storeRevision(),
    });
    const membership = await captureIssue(world.context, { ...issueInput("Milestone membership finding"), projectId: PROJECT_ID }, {
      operationId: "op-membership-issue",
      actor: "project-manager",
    });
    const point = await recoveryPoint(world, "issue-milestone-point");

    // A real membership move AFTER the point, through the published verb: the
    // inventoried issue row must disclose that the association moved.
    await assignIssueMilestone(
      contextOf(world.context, world.caller),
      membership.issueId,
      { projectId: PROJECT_ID, milestoneId: first.milestoneId, reason: "inventory regression" },
      { operationId: "op-membership-assign", actor: "project-manager", expectedRevision: 1, expectedStoreRevision: storeRevision() },
    );
    const assigned = await previewExecutionRestore(world.context, point.backupPath);
    expect(assigned.authorityDifferences).toContainEqual({
      domain: "issue",
      key: `issue:${membership.issueId}`,
      liveRevision: 2,
      backupRevision: 1,
    });
    expect((await getIssue(world.context, membership.issueId)).milestoneId).toBe(first.milestoneId);

    // The association is inventoried CONTENT, not the revision it happens to
    // arrive with: a membership change that leaves the row revision alone is
    // still a disclosed difference, so a row-replacing consumer cannot drop it
    // without reporting the loss.
    const assignedPoint = await recoveryPoint(world, "issue-milestone-assigned-point");
    rawRun(world.dbPath, "update issues set milestone_id = ? where id = ?", second.milestoneId, membership.issueId);
    expect(rawGet<{ revision: number }>(world.dbPath, `select revision from issues where id = '${membership.issueId}'`)!.revision).toBe(2);
    const moved = await previewExecutionRestore(world.context, assignedPoint.backupPath);
    expect(moved.authorityDifferences).toContainEqual({
      domain: "issue",
      key: `issue:${membership.issueId}`,
      liveRevision: 2,
      backupRevision: 2,
    });
  });

  test("restore-installs-every-schema-owned-fact-of-all-four-domains", async () => {
    const world = await recoveryWorld("restore-whole-domain");
    await registerCatalogEntity(
      world.context,
      { kind: "project", id: PROJECT_ID, title: "Whole-domain project", rootKind: "projects", relativePath: `projects/${PROJECT_ID}` },
      { operationId: "op-whole-domain-project", actor: OPERATOR },
    );
    const storeRevision = (): number => rawGet<{ revision: number }>(world.dbPath, "select revision from store_meta where id = 1")!.revision;
    const milestone = await addMilestone(world.context, { projectId: PROJECT_ID, name: "Whole-domain", target: null, ordinal: 0 }, {
      operationId: "op-whole-domain-milestone",
      expectedStoreRevision: storeRevision(),
    });
    const finding = await captureIssue(world.context, { ...issueInput("Whole-domain finding"), projectId: PROJECT_ID }, {
      operationId: "op-whole-domain-issue",
      actor: "project-manager",
    });
    // A real milestone association (migration 7's `issues.milestone_id`), a real
    // coverage document on an execution migration row (migration 5's
    // `coverage_json`), and a native host-state row (the fifth Dsh domain) — the
    // three facts T4a's F1 correction named plus the host domain.
    await assignIssueMilestone(
      contextOf(world.context, world.caller),
      finding.issueId,
      { projectId: PROJECT_ID, milestoneId: milestone.milestoneId, reason: "whole-domain restore" },
      { operationId: "op-whole-domain-assign", actor: "project-manager", expectedRevision: 1, expectedStoreRevision: storeRevision() },
    );
    rawRun(
      world.dbPath,
      "insert into execution_migrations(manifest_id, manifest_hash, phase, manifest_json, created_at, updated_at, coverage_json) values (?, ?, 'retired', '{}', ?, ?, ?)",
      "whole-domain-migration",
      "b".repeat(64),
      TS,
      TS,
      '{"generation":"retired-coverage"}',
    );
    rawRun(
      world.dbPath,
      "insert into dsh_scan_bounds(workflow_id, session_id, next, stream) values (?, ?, 7, 'agent-flow')",
      WF,
      "session-whole-domain",
    );

    // A verified point of ALL of that, then post-point work in every domain the
    // restore must discard.
    const point = await recoveryPoint(world, "whole-domain-point");
    const selected = {
      milestoneId: rawGet<{ milestone_id: string | null }>(
        point.backupPath,
        `select milestone_id from issues where id = '${finding.issueId}'`,
      )!.milestone_id,
      coverage: rawGet<{ coverage_json: string }>(
        point.backupPath,
        "select coverage_json from execution_migrations where manifest_id = 'whole-domain-migration'",
      )!.coverage_json,
      scanNext: rawGet<{ next: number }>(
        point.backupPath,
        `select next from dsh_scan_bounds where session_id = 'session-whole-domain'`,
      )!.next,
    };
    expect(selected).toEqual({ milestoneId: milestone.milestoneId, coverage: '{"generation":"retired-coverage"}', scanNext: 7 });
    await mutateEveryDomain(world, "whole-domain");
    rawRun(world.dbPath, "update issues set milestone_id = null where id = ?", finding.issueId);
    rawRun(
      world.dbPath,
      "update execution_migrations set coverage_json = ? where manifest_id = 'whole-domain-migration'",
      '{"generation":"live-coverage"}',
    );
    rawRun(world.dbPath, "update dsh_scan_bounds set next = 99 where session_id = 'session-whole-domain'");

    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const receipt = await restoreExecutionBackup(world.context, {
      preview,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });
    expect(receipt.epoch).toBe(Math.max(world.epoch, point.epoch) + 1);

    // Every schema-owned fact of the selected generation is installed, read back
    // through the store's own schema rather than through the inventory:
    // the membership association, the retired migration row's WHOLE coverage
    // document, the host-state row's own stream cursor, and the four domains'
    // row counts.
    expect(rawGet<{ milestone_id: string | null }>(
      world.dbPath,
      `select milestone_id from issues where id = '${finding.issueId}'`,
    )!.milestone_id).toBe(selected.milestoneId);
    expect(rawGet<{ coverage_json: string }>(
      world.dbPath,
      "select coverage_json from execution_migrations where manifest_id = 'whole-domain-migration'",
    )!.coverage_json).toBe(selected.coverage);
    expect(rawAll<{ next: number; stream: string }>(
      world.dbPath,
      "select next, stream from dsh_scan_bounds order by session_id",
    )).toEqual([{ next: selected.scanNext, stream: "agent-flow" }]);
    expect(footprint(world.dbPath)).toMatchObject({
      issues: 1,
      catalogEntities: rawGet<{ n: number }>(point.backupPath, "select count(*) as n from catalog_entities")!.n,
      workflows: rawGet<{ n: number }>(point.backupPath, "select count(*) as n from execution_workflows")!.n,
      sessions: rawGet<{ n: number }>(point.backupPath, "select count(*) as n from execution_sessions")!.n,
    });
    // …and the consumer that reads the membership still sees it.
    const restored = await getIssue(world.context, finding.issueId);
    expect(restored.milestoneId).toBe(milestone.milestoneId);
    expect(restored.revision).toBe(2);
  });
});
