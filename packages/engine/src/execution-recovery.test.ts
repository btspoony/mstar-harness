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
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { captureIssue } from "./issue.js";
import { withStatusWriteLock } from "./lease.js";
import {
  assertAuthorityCurrent,
  backupStore,
  canonicalPath,
  currentAuthorityHandle,
  readRetainedBodyInventory,
  retainedInventoryPath,
  type BackupReceipt,
} from "./store-activation.js";
import { MIGRATIONS, initializeStore, openStore, storeDbPath, type StoreContext } from "./store-db.js";
import type { WorkflowSnapshot } from "./workflow.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-recovery-"));
const TS = "2026-09-02T00:00:00.000Z";
const WF = "20260920-recovery-workflow";
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
        if (!readdirSync(safetyDir).some((name) => name.startsWith("pre-restore-") && existsSync(retainedInventoryPath(join(safetyDir, name))))) continue;
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

    // The durable receipt is external, on disk, and describes the replacement:
    // read it before any later access re-establishes WAL on the installed file.
    const record = JSON.parse(readFileSync(receipt.recoveryReceiptPath, "utf8")) as Record<string, unknown>;
    expect(record.phase).toBe("replaced");
    expect(record.newEpoch).toBe(receipt.epoch);
    expect(record.verified).toMatchObject({ integrity: "ok", foreignKeys: "ok" });
    expect(String(record.requiredRebind)).toContain("recoverExecutionCoordinator");

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

  test("execution-restore-receipt-identifies-a-crash-around-the-replacement", async () => {
    const world = await recoveryWorld("restore-crash");
    const point = await recoveryPoint(world, "crash-point");
    // Hold a store connection open for the whole case. SQLite folds and deletes
    // a WAL only when the LAST connection closes, so while this one is open
    // every commit `mutateEveryDomain` makes stays as an un-checkpointed frame
    // in the live `-wal` instead of being folded away by whichever earlier
    // handle happened to close last. That makes the precondition this case
    // needs — the store PROVABLY has pending WAL frames when `liveBefore` is
    // taken, so quiescing it must rewrite the database bytes — a fact of the
    // fixture rather than a side effect of when the runtime finalizes its own
    // handles. Without it the live bytes can already be current at `liveBefore`
    // and the byte assertion below would measure cleanup timing, not protocol.
    const held = await openStore(world.context, "write");
    try {
      await mutateEveryDomain(world, "crash");
      const preview = await previewExecutionRestore(world.context, point.backupPath);
      const liveFootprint = footprint(world.dbPath);
      // The frames are really there to be folded: a non-empty WAL sidecar
      // beside the database is what the checkpoint below has to consume, so a
      // fixture that lost its pending frames fails HERE instead of quietly
      // making the byte assertion below vacuous.
      expect(existsSync(`${world.dbPath}-wal`) ? statSync(`${world.dbPath}-wal`).size : 0).toBeGreaterThan(0);

      // A crash AFTER the receipt is written but BEFORE the rename: the original
      // is still authoritative, and the receipt proves the restore never landed.
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
      // The store's STATE is untouched; its bytes are not, because the restore
      // checkpoints the live WAL as part of quiescing it, which is not a loss.
      expect(footprint(world.dbPath)).toEqual(liveFootprint);
      const afterFirst = recoveryRecords(world);
      expect(afterFirst).toHaveLength(1);
      const pending = afterFirst[0]!;
      expect(pending.phase).toBe("replacing");
      // A crash AFTER the rename: the live store IS the prepared copy, and the
      // same receipt says so; verification resumes against the installed store.
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
      const installed = recoveryRecords(world)[1]!;
      expect(installed.phase).toBe("replacing");
      // The installed store IS the selected recovery point's state, at the epoch
      // the receipt names — verification resumes, it does not restart.
      const resumed = footprint(world.dbPath);
      expect(resumed.epoch).toBe(installed.newEpoch);
      expect(resumed.issues).toBe(0);
      expect(resumed.workflows).toBe(1);
      await expect(readExecutionState(world.context)).resolves.toMatchObject({ epoch: installed.newEpoch });
    } finally {
      held.close();
    }
  });

  test("execution-restore-refuses-a-sidecar-that-appears-in-the-replacement-window", async () => {
    const world = await recoveryWorld("restore-sidecar-window");
    const point = await recoveryPoint(world, "sidecar-window-point");
    await mutateEveryDomain(world, "sidecar-window");
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const liveFootprint = footprint(world.dbPath);
    const walPath = `${world.dbPath}-wal`;

    // A writer that commits while the replacement is being decided writes the
    // store's WAL, and those frames are NOT in the database bytes the checkpoint
    // covers — so the replacement may not proceed past them. The window to reach
    // is the one INSIDE the replacement sequence, after the sidecar identities
    // were snapshotted and before the rename: the prepared scratch image's
    // epoch is advanced in that window, and the sequence then awaits its
    // verification, so the injector keys on that epoch and lands a fresh
    // sidecar file in the yield.
    const sidecarBytes = Buffer.alloc(4096, 0x7a);
    const scratchPath = `${walPath}.appearing-writer`;
    const scratchImageExists = (): boolean =>
      readdirSync(world.harness).some((name) =>
        name.startsWith(".store-restore-") && name.endsWith(".db") &&
        rawGet<{ authority_epoch: number }>(join(world.harness, name), "select authority_epoch from store_meta where id = 1")!.authority_epoch > preview.liveEpoch,
      );
    let injected = false;
    let stop = false;
    const injector = (async () => {
      while (!stop) {
        await nextTurn();
        if (injected || !scratchImageExists()) continue;
        // A new file, moved into the WAL's own name: the sidecar a writer
        // creates is a file the checkpoint never saw, not a rewrite of one it
        // did.
        writeFileSync(scratchPath, sidecarBytes);
        renameSync(scratchPath, walPath);
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

    expect(injected).toBe(true);
    expect(refusal!.code).toBe("execution.recovery-loss-unaccepted");
    expect(refusal!.message).toContain("appeared after the checkpoint");

    // The refusal came from the replacement sequence itself — its durable
    // receipt was already written — and it replaced nothing: the receipt still
    // names the ORIGINAL bytes as the live store, and the writer's sidecar is
    // still beside it, untouched.
    const records = recoveryRecords(world);
    expect(records).toHaveLength(1);
    const pending = records[0]!;
    expect(pending.phase).toBe("replacing");

    // …and the store's own authority is exactly the state the pre-restore
    // checkpoint left, at the same epoch. Only the writer's WAL was in the way,
    // so the sidecars are cleared before the store is read here — the checkpoint
    // proved every committed frame already landed in the file.
    rmSync(walPath, { force: true });
    rmSync(`${world.dbPath}-shm`, { force: true });
    expect(footprint(world.dbPath)).toEqual(liveFootprint);
  });

  test("execution-restore-reclaims-an-abandoned-attempts-scratch-and-keeps-an-installed-copy", async () => {
    const world = await recoveryWorld("restore-sweep");
    const point = await recoveryPoint(world, "sweep-point");
    await mutateEveryDomain(world, "sweep");

    // The live store's own bytes as the replacement sequence will read them:
    // the loss preview and the re-inventory run before the sweep are reads (the
    // untouched-preview cases above pin that), and the one step that rewrites
    // these bytes — the quiescing checkpoint — runs after it.
    const preview = await previewExecutionRestore(world.context, point.backupPath);

    // The crash-time states: an in-progress attempt with its staging image,
    // a completed rename with its staging path consumed, and an unreceipted image.
    const receiptDir = join(world.harness, "archived", "store-migration", "recovery");
    mkdirSync(receiptDir, { recursive: true });
    const plant = (
      attemptId: string,
      bytes: Buffer,
      restoredCopySha256: string,
      phase: string,
    ): { image: string; receiptPath: string } => {
      const image = join(world.harness, `.store-restore-${attemptId}.db`);
      const receiptPath = join(receiptDir, `restore-${Date.now().toString().padStart(16, "0")}-${attemptId}.json`);
      writeFileSync(image, bytes);
      writeFileSync(`${image}-journal`, Buffer.from("stranded by a crash mid-transaction"));
      writeFileSync(`${image}-wal`, Buffer.from("stranded wal"));
      writeFileSync(`${image}-shm`, Buffer.from("stranded shm"));
      writeFileSync(receiptPath, JSON.stringify({ phase, restoredCopySha256 }));
      return { image, receiptPath };
    };

    // (1) The crash landed BEFORE replacement: the durable phase remains
    // `replacing` and the attempt-owned staging image still exists.
    const abandonedBytes = Buffer.from("a prepared store image that never landed");
    const abandoned = plant(randomUUID(), abandonedBytes, sha256OfBytes(abandonedBytes), "replacing");

    // (2) The crash landed AFTER rename: the phase is terminal and the
    // attempt-owned staging path has been consumed by the live-store rename.
    const installed = plant(randomUUID(), readFileSync(world.dbPath), "0".repeat(64), "replaced");
    rmSync(installed.image);
    rmSync(`${installed.image}-journal`);
    rmSync(`${installed.image}-wal`);
    rmSync(`${installed.image}-shm`);

    // (3) A terminal attempt receipt with a stale scratch artifact is kept as
    // an archival record; cleanup does not discard completed receipts.
    const finishedBytes = Buffer.from("a copy of a completed replacement");
    const finished = plant(randomUUID(), finishedBytes, sha256OfBytes(finishedBytes), "replaced");

    // (4) An image with no receipt is reclaimed because it cannot belong to a
    // completed replacement; only the active attempt could stage an owned name,
    // and this restore holds that attempt's maintenance lock.
    const unreceiptedBytes = Buffer.from("an image copied before the attempt recorded anything");
    const unreceiptedImage = join(world.harness, `.store-restore-${randomUUID()}.db`);
    writeFileSync(unreceiptedImage, unreceiptedBytes);
    writeFileSync(`${unreceiptedImage}-journal`, Buffer.from("stranded by a crash mid-transaction"));

    const receipt = await restoreExecutionBackup(world.context, {
      preview,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });
    expect(receipt.storeId).toBe(world.storeId);

    // The abandoned attempt's image AND the `-journal`/`-wal`/`-shm` its crash
    // stranded are reclaimed — receipt or no receipt...
    expect(existsSync(abandoned.image)).toBe(false);
    expect(existsSync(`${abandoned.image}-journal`)).toBe(false);
    expect(existsSync(`${abandoned.image}-wal`)).toBe(false);
    expect(existsSync(`${abandoned.image}-shm`)).toBe(false);
    expect(existsSync(unreceiptedImage)).toBe(false);
    expect(existsSync(`${unreceiptedImage}-journal`)).toBe(false);
    // The replacement receipt and completed artifact remain available.
    expect(existsSync(abandoned.receiptPath)).toBe(true);
    expect(existsSync(installed.receiptPath)).toBe(true);
    expect(existsSync(finished.receiptPath)).toBe(true);
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

  test("execution-restore-serializes-with-the-migration-maintenance-lock", async () => {
    const world = await recoveryWorld("restore-lock");
    const point = await recoveryPoint(world, "lock-point");
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const key = join(canonicalPath(world.harness), ".execution-maintenance", "execution-migration");
    mkdirSync(dirname(key), { recursive: true });

    // Holding the migration maintenance lock blocks the restore, so a restore
    // can never interleave with a migration/retire step.
    const blocked = await errorOf(() =>
      withStatusWriteLock(
        key,
        () =>
          restoreExecutionBackup(world.context, {
            preview,
            operator: OPERATOR,
            authorization: AUTHORIZATION,
          }),
        { timeoutMs: 200, pollMs: 5 },
      ),
    );
    expect(blocked.message).toContain(".execution-maintenance");
    expect(footprint(world.dbPath).epoch).toBe(world.epoch);
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

    // The replacement leaves the verified image exactly as the copy verdict read
    // it — VACUUM INTO's rollback journal and no sidecars — until something asks
    // the store for a writer connection.
    const journalMode = (): string => rawGet<{ journal_mode: string }>(world.dbPath, "pragma journal_mode")!.journal_mode;
    expect(journalMode()).toBe("delete");

    // A second loss preview reads that store. §8 says the preview mutates
    // nothing, so reading the loss may not reconfigure the live store's journal,
    const again = await previewExecutionRestore(world.context, point.backupPath);
    expect(again.liveEpoch).toBe(receipt.epoch);
    expect(journalMode()).toBe("delete");
    expect(existsSync(`${world.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${world.dbPath}-shm`)).toBe(false);
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
  /** §7 R4: the retained digests one attempt recorded for crash diagnosis. */
  retainedDigest: string;
  retainedLiveDigest: string;
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
// Phase 2b — the retained accepted bodies in the loss-aware whole-store restore
// (§7 R4)
// ---------------------------------------------------------------------------

/** The retained body dir of the fixture's workflow, and its accepted bodies. */
function bodyDirOf(world: World): string {
  return join(world.harness, "workflows", WF);
}

function noteBytes(id: string, text: string): string {
  return `${JSON.stringify({ version: 1, id, workflowId: WF, sessionId: COORDINATOR, kind: "note", ts: TS, text })}\n`;
}

/** Plant the retained bodies the recovery protocol freezes. */
function plantBodies(world: World): { notes: string; selection: string; launches: string } {
  const dir = bodyDirOf(world);
  mkdirSync(dir, { recursive: true });
  const notes = join(dir, "notes.jsonl");
  const launches = join(dir, "omp-launches.json");
  const selection = join(world.harness, "snapshots", "engine-status.json");
  writeFileSync(notes, `${JSON.stringify({ kind: "note", ts: TS, text: "legacy body" })}\n${noteBytes("note-1", "recorded")}`);
  writeFileSync(join(dir, "agent-flow.jsonl"), `${JSON.stringify({ v: 1, ts: 1, kind: "dispatch", role: "plan-pm" })}\n`);
  writeFileSync(launches, `${JSON.stringify({ version: 1, workflow_id: WF, intents: [] })}\n`);
  mkdirSync(dirname(selection), { recursive: true });
  writeFileSync(selection, `${JSON.stringify({ sv: 1, entries: {}, bindings: {} })}\n`);
  return { notes, selection, launches };
}

/** The accepted-record digests of one body, by §5's own LF rule. */
function recordsOf(path: string): string[] {
  const bytes = readFileSync(path);
  const records: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    records.push(sha256OfBytes(bytes.subarray(start, index)));
    start = index + 1;
  }
  return records;
}

/**
 * The live store's authority generation, read through the engine's own read
 * adapter: the LOGICAL state a refusal must leave untouched. A WAL-mode
 * database's main-file bytes are not that proof — SQLite's own last clean close
 * folds the `-wal` into the file — so a byte comparison would report the store's
 * cleanup as a write.
 */
async function liveAuthority(context: StoreContext): Promise<{ token: string; epoch: number }> {
  const state = await readExecutionState(context);
  return { token: state.token, epoch: state.epoch };
}

describe("Phase 2b - retained accepted bodies and the loss-aware restore", () => {
  test("Phase 2b freezes the retained bodies with the point and preserves append-only accepted history", async () => {
    const world = await recoveryWorld("phase2b-append");
    const bodies = plantBodies(world);
    const preRestoreHandle = await currentAuthorityHandle(world.context);
    const point = await recoveryPoint(world, "retained-point");

    const retained = point.retained!;
    expect(retained.bodies.map((body) => body.path)).toEqual([
      "snapshots/engine-status.json",
      `workflows/${WF}/agent-flow.jsonl`,
      `workflows/${WF}/notes.jsonl`,
      `workflows/${WF}/omp-launches.json`,
    ]);
    const notes = retained.bodies.find((body) => body.path.endsWith("notes.jsonl"))!;
    expect(notes.records).toEqual(recordsOf(bodies.notes));
    expect(notes.partial).toBeNull();
    expect(retained.bodies.find((body) => body.path === "snapshots/engine-status.json")!.selection).toBe(true);
    expect(await readRetainedBodyInventory(point.backupPath)).toEqual(retained);
    // A store that records no populated coverage generation says so on both
    // sides rather than inventing one.
    const clean = await previewExecutionRestore(world.context, point.backupPath);
    expect(clean.retainedDifferences).toEqual([]);

    // A post-point accepted record: §7 preserves it instead of a loss.
    const before = recordsOf(bodies.notes).length;
    writeFileSync(bodies.notes, `${readFileSync(bodies.notes, "utf8")}${noteBytes("note-2", "after the point")}`);
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const difference = preview.retainedDifferences.find((entry) => entry.path.endsWith("notes.jsonl"))!;
    expect(difference).toMatchObject({ kind: "preserved", lostRecords: 0, preservedRecords: 1 });
    expect(preview.authorityDifferences).toEqual([]);
    expect(preview.lostOperationIds).toEqual([]);

    // Nothing the point held is lost, so no loss approval is owed — and the
    // appended record survives the replacement.
    const receipt = await restoreExecutionBackup(world.context, {
      preview,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });
    expect(receipt.epoch).toBe(Math.max(world.epoch, point.epoch) + 1);
    expect(recordsOf(bodies.notes).length).toBe(before + 1);
    expect(readFileSync(bodies.notes, "utf8")).toContain("after the point");
    const stale = await refusalOf(() => assertAuthorityCurrent(world.context, preRestoreHandle));
    expect(stale.code).toBe("store.stale-epoch");
  });

  test("Phase 2b refuses an interrupted append with every artifact retained and an explicit salvage scope", async () => {
    const world = await recoveryWorld("phase2b-interrupted");
    const bodies = plantBodies(world);
    const point = await recoveryPoint(world, "interrupted-point");
    const liveState = await liveAuthority(world.context);
    const pointIssues = rawGet<{ n: number }>(point.backupPath, "select count(*) as n from issues")!.n;
    const clean = readFileSync(bodies.notes);
    // An unterminated record the point never recorded cannot be inventoried;
    // refusal leaves the live authority and all body contents untouched.
    writeFileSync(bodies.notes, `${readFileSync(bodies.notes, "utf8")}{"version":1`);
    const refusal = await refusalOf(() => previewExecutionRestore(world.context, point.backupPath));
    expect(refusal.code).toBe("execution.recovery-loss-unaccepted");
    expect(refusal.message).toContain("salvage scope");
    expect(refusal.message).toContain("notes.jsonl");
    expect(await liveAuthority(world.context)).toEqual(liveState);
    expect(readFileSync(bodies.notes, "utf8")).toContain('{"version":1');
    expect(rawGet<{ n: number }>(point.backupPath, "select count(*) as n from issues")!.n).toBe(pointIssues);

    // An interrupted tail the POINT recorded is carried as a recorded identity
    // instead of being guessed at.
    writeFileSync(bodies.notes, clean);
    const interruptedTail = '{"v":1,"ts":2';
    writeFileSync(
      join(bodyDirOf(world), "agent-flow.jsonl"),
      `${JSON.stringify({ v: 1, ts: 1, kind: "dispatch" })}${interruptedTail}`,
    );
    const second = await recoveryPoint(world, "interrupted-tail-point");
    expect(second.retained!.bodies.find((body) => body.path.endsWith("agent-flow.jsonl"))!.partial).not.toBeNull();
    const carried = await previewExecutionRestore(world.context, second.backupPath);
    expect(carried.retainedDifferences.some((entry) => entry.path.endsWith("agent-flow.jsonl"))).toBe(false);
  });

  test("Phase 2b reconciles a crashed attempt from its durable receipt and proceeds on a moved retained set", async () => {
    const world = await recoveryWorld("phase2b-crash");
    plantBodies(world);
    const point = await recoveryPoint(world, "crash-retained-point");
    const preview = await previewExecutionRestore(world.context, point.backupPath);

    const crash = await errorOf(async () => {
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
    expect(crash.message).toContain("before-replacement");

    // The durable receipt names both sides' bytes and carries both retained
    // digests as records, so a crashed attempt is resumable rather than
    // repeated from memory.
    const pending = recoveryRecords(world).at(-1)!;
    expect(pending.phase).toBe("replacing");

    // A replay whose retained set moved since the crash proceeds: the moved set
    // is recorded as retained differences, not refused on the recorded digests.
    writeFileSync(join(bodyDirOf(world), "agent-flow.jsonl"), `${JSON.stringify({ v: 1, ts: 9, kind: "dispatch", role: "plan-pm" })}\n`);
    const receipt = await restoreExecutionBackup(world.context, {
      preview,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });
    expect(receipt.storeId).toBe(world.storeId);
    expect(receipt.epoch).toBe(Math.max(preview.liveEpoch, point.epoch) + 1);
    const finalized = recoveryRecords(world).at(-1)!;
    expect(finalized.phase).toBe("replaced");
    expect(finalized.newEpoch).toBe(receipt.epoch);
  });

  test("Phase 2b refuses a missing, forged or old-generation retained record and a present compaction journal", async () => {
    const world = await recoveryWorld("phase2b-receipt");
    plantBodies(world);
    const point = await recoveryPoint(world, "receipt-retained-point");
    const sidecar = retainedInventoryPath(point.backupPath);
    const recorded = readFileSync(sidecar);

    rmSync(sidecar, { force: true });
    const missing = await refusalOf(() => previewExecutionRestore(world.context, point.backupPath));
    expect(missing.code).toBe("store.activation-stale");
    expect(missing.message).toContain("records no retained-body inventory");

    writeFileSync(sidecar, '{"version":1,"protocol":"retained-body-inventory-v1","storeId":"other"}\n');
    const forged = await refusalOf(() => previewExecutionRestore(world.context, point.backupPath));
    expect(forged.code).toBe("store.activation-stale");
    writeFileSync(sidecar, recorded);

    // §7 R4: an older loss-payload generation is refused by name, not silently
    // restored without the body loss it cannot describe.
    const preview = await previewExecutionRestore(world.context, point.backupPath);
    const oldGeneration = await refusalOf(() =>
      restoreExecutionBackup(world.context, {
        preview: { ...preview, version: EXECUTION_RECOVERY_PROTOCOL_VERSION - 1 },
        operator: OPERATOR,
        authorization: AUTHORIZATION,
      }),
    );
    expect(oldGeneration.code).toBe("execution.migration-conflict");
    expect(oldGeneration.message).toContain("loss-payload version");

    // §5: a present compaction journal refuses the freeze AND the preview, with
    // the store and every body left exactly where they are.
    writeFileSync(join(bodyDirOf(world), "agent-flow-compaction.json"), `${JSON.stringify({ version: 1, lines: 1 })}\n`);
    const liveState = await liveAuthority(world.context);
    const frozenHere = await refusalOf(() => recoveryPoint(world, "compaction-point"));
    expect(frozenHere.code).toBe("store.activation-stale");
    expect(frozenHere.message).toContain("agent-flow-compaction.json");
    expect(await liveAuthority(world.context)).toEqual(liveState);
    const previewRefusal = await refusalOf(() => previewExecutionRestore(world.context, point.backupPath));
    expect(previewRefusal.code).toBe("store.activation-stale");
    expect(previewRefusal.message).toContain("agent-flow-compaction.json");
    expect(await liveAuthority(world.context)).toEqual(liveState);
  });
});
