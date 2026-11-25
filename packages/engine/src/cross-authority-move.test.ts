/**
 * why: The move ledger and the lane's fence. These cases prove the three facts no calling path can
 * be trusted to state: the table itself refuses a relation with both targets null or both set, a
 * move row advances only along the forward set, and the source row freezes its record from
 * `staged` on through triggers stored in the lane rather than through calling code.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  advanceIssueMove,
  assertMoveTransition,
  assertRecordWritable,
  blockingMoveFor,
  discardAcrossAuthorities,
  discardMove,
  frozenMoveRefusal,
  isForwardMoveTransition,
  moveAcrossAuthorities,
  publishMove,
  readIssueMove,
  recordIssueMove,
  setMoveGapForTest,
  stageMove,
  stagedMismatch,
  switchMove,
  verifyMove,
  type IssueMovePhase,
} from "./cross-authority-move.js";
import {
  COLLABORATION_MIGRATIONS,
  applyCollaborationLadder,
  initializeCollaborationStore,
  readCollaborationStage,
  writeCollaborationStage,
} from "./collaboration-store.js";
import { collaborationLocationOfRepoKey, resolveCollaborationLocation, type CollaborationLocation } from "./collaboration-identity.js";
import { ensureCollaborationAuthority } from "./store-activation.js";
import { appendOccurrence, captureIssue, computeIdentityKey, getIssue, linkIssue } from "./issue.js";
import { SCHEMA_VERSION_TABLE_SQL, initializeStore, migrationChecksum, type StoreContext, type StoreDb } from "./store-db.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-cross-authority-move-")));
const HOME = join(ROOT, "home");
let sequence = 0;

let homeSpy: { mockRestore(): void } | undefined;

beforeAll(() => {
  // why: The lane's storage root is the private user tree, so an isolated home is installed at the
  // runtime boundary the admission check calls; no product API gained a home selector.
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});

afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

/** note: A freshly published v4 lane under the real initializer, with one issue row to fence. */
async function freshLane(): Promise<{ db: StoreDb; dbPath: string }> {
  const location = collaborationLocationOfRepoKey(`github.com/acme/move-fixture-${sequence++}`, "local");
  mkdirSync(join(location.dbPath, ".."), { recursive: true, mode: 0o700 });
  await initializeCollaborationStore(location);
  const db = new DatabaseSync(location.dbPath) as unknown as StoreDb;
  db.exec("pragma foreign_keys=on");
  db.exec(`
update collaboration_meta set authority_state = 'active' where id = 1;
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key, issue_ref)
values ('I-000001', 'p-one', 'Moving finding', 'bug', 'high', 'open', 'i', 'a', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'move-key', 'mstar:issue:11111111-1111-4111-8111-111111111111');
`);
  return { db, dbPath: location.dbPath };
}

/** note: One source row in a chosen phase; the ledger's own columns, no digest arithmetic. */
function sourceRow(
  issueRef: string,
  phase: IssueMovePhase,
  operationId = "move-one",
): Parameters<typeof recordIssueMove>[1] {
  return {
    operationId,
    role: "source",
    requestHash: "request-hash",
    issueRef,
    sourceIssueId: "I-000001",
    destinationIssueId: null,
    sourceAuthority: "github.com/acme/move-fixture",
    destinationAuthority: "github.com/acme/elsewhere",
    destinationProject: "p-dest",
    actor: "project-manager",
    reason: "fixture",
    phase,
    payloadJson: "{}",
    payloadDigest: "digest",
    stagedCounts: "{}",
    sourceStoreId: "store-one",
    sourceEpoch: 1,
    removedSyncRows: 0,
  };
}

describe("cross-authority move ledger", () => {
  test("a relation with both targets null or both set is refused by the table", async () => {
    const { db } = await freshLane();
    try {
      db.exec(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, " +
          "updated_at, identity_key, issue_ref) values ('I-000002', 'p-one', 'Second finding', 'risk', 'low', 'open', " +
          "'i', 'a', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'second-key', " +
          "'mstar:issue:22222222-2222-4222-8222-222222222222')",
      );
      // invariant: Exactly one of the two targets is set, so neither "no target" nor "two targets"
      // can be stored; the refusal is the table's CHECK, not a caller's validation.
      expect(() =>
        db.prepare("insert into relations(from_issue, relation) values ('I-000001', 'blocks')").run(),
      ).toThrow(/CHECK/i);
      expect(() =>
        db
          .prepare(
            "insert into relations(from_issue, relation, to_issue, to_ref) values ('I-000002', 'blocks', 'I-000001', 'mstar:issue:11111111-1111-4111-8111-111111111111')",
          )
          .run(),
      ).toThrow(/CHECK/i);
      // note: Each legal shape is accepted, and the cross-authority row is deduplicated by its
      // partial unique index rather than by the primary key (two NULLs never compare equal).
      db.prepare("insert into relations(from_issue, relation, to_issue) values ('I-000001', 'related', 'I-000002')").run();
      db.prepare("insert into relations(from_issue, relation, to_ref) values ('I-000001', 'blocks', 'mstar:issue:33333333-3333-4333-8333-333333333333')").run();
      expect(() =>
        db.prepare("insert into relations(from_issue, relation, to_ref) values ('I-000001', 'blocks', 'mstar:issue:33333333-3333-4333-8333-333333333333')").run(),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  test("a move row moves only forward along its progress path or into discarded before the switch", () => {
    // invariant: The forward set itself: progress is linear, discard is the one early exit, and
    // both later phases are terminal.
    expect(isForwardMoveTransition("staged", "verified")).toBe(true);
    expect(isForwardMoveTransition("verified", "switched")).toBe(true);
    expect(isForwardMoveTransition("switched", "published")).toBe(true);
    expect(isForwardMoveTransition("staged", "discarded")).toBe(true);
    expect(isForwardMoveTransition("verified", "discarded")).toBe(true);
    // note: A switch that never admitted its record is discardable: the destination holds no member of
    // it, and that is the supported recovery for a stranded switched source. See `discardMove`.
    expect(isForwardMoveTransition("switched", "discarded")).toBe(true);
    expect(isForwardMoveTransition("published", "discarded")).toBe(false);
    expect(isForwardMoveTransition("verified", "staged")).toBe(false);
    expect(isForwardMoveTransition("switched", "verified")).toBe(false);
    expect(() => assertMoveTransition("published", "switched")).toThrow(/collaboration\.move-phase-invalid/);
  });

  test("a persisted row rejects an illegal transition and records the legal one once", async () => {
    const { db } = await freshLane();
    try {
      recordIssueMove(db, sourceRow("mstar:issue:11111111-1111-4111-8111-111111111111", "staged"));
      expect(readIssueMove(db, "move-one", "source")?.phase).toBe("staged");

      // invariant: A phase the state machine does not allow never reaches the table.
      expect(() =>
        advanceIssueMove(db, { operationId: "move-one", role: "source", from: "staged", to: "published" }),
      ).toThrow(/collaboration\.move-phase-invalid/);
      expect(readIssueMove(db, "move-one", "source")?.phase).toBe("staged");

      expect(
        advanceIssueMove(db, { operationId: "move-one", role: "source", from: "staged", to: "verified" }).phase,
      ).toBe("verified");
      // note: The compare-and-set is the replay guard: the row is no longer at `staged`.
      expect(() =>
        advanceIssueMove(db, { operationId: "move-one", role: "source", from: "staged", to: "verified" }),
      ).toThrow(/not staged/);
      expect(readIssueMove(db, "move-one", "source")?.phase).toBe("verified");
    } finally {
      db.close();
    }
  });

  test("a corrupt ledger count is refused as corrupt instead of resuming from a guessed zero", async () => {
    // invariant: Critical 1 (review wave 3) — `source_epoch` and `removed_sync_rows` are the ledger's
    // own counts; a coerced zero would resume a move from a base that never existed, so a
    // non-integer or negative value is `store.corrupt`, not 0.
    const { db } = await freshLane();
    try {
      recordIssueMove(db, sourceRow("mstar:issue:11111111-1111-4111-8111-111111111111", "staged"));
      db.exec("pragma ignore_check_constraints = on");
      db.prepare("update issue_moves set source_epoch = -1 where operation_id = 'move-one'").run();
      expect(() => readIssueMove(db, "move-one", "source")).toThrow(/store\.corrupt.*source_epoch/);
      db.prepare("update issue_moves set source_epoch = 1, removed_sync_rows = -1 where operation_id = 'move-one'").run();
      expect(() =>
        advanceIssueMove(db, { operationId: "move-one", role: "source", from: "staged", to: "verified" }),
      ).toThrow(/store\.corrupt.*removed_sync_rows/);
      db.exec("pragma ignore_check_constraints = off");
      db.prepare("update issue_moves set removed_sync_rows = 0 where operation_id = 'move-one'").run();
      // note: The un-corrupted row still advances, proving the refusal names the field, not the row.
      expect(
        advanceIssueMove(db, { operationId: "move-one", role: "source", from: "staged", to: "verified" }).phase,
      ).toBe("verified");
    } finally {
      db.close();
    }
  });

  test("the source row blocks every write to its record from staged on", async () => {
    const { db } = await freshLane();
    try {
      expect(blockingMoveFor(db, "I-000001")).toBeNull();
      assertRecordWritable(db, "I-000001");

      // note: The second record, its relation and its sync row exist BEFORE the fence, so the
      // update paths below are proved on rows the move did not create.
      db.exec(`
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key, issue_ref)
values ('I-000002', 'p-one', 'Second finding', 'risk', 'low', 'open', 'i', 'a', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'fence-key', 'mstar:issue:22222222-2222-4222-8222-222222222222');
insert into relations(from_issue, relation, to_issue) values ('I-000001', 'related', 'I-000002');
insert into issue_sync_state(binding_id, direction, local_id, item_state, revision, updated_at)
values ('linear:p-one', 'push', 'I-000001', 'pending', 1, '2026-11-21T00:00:00.000Z');
`);

      recordIssueMove(db, sourceRow("mstar:issue:11111111-1111-4111-8111-111111111111", "staged"));
      expect(blockingMoveFor(db, "I-000001")).toEqual({ operationId: "move-one", phase: "staged" });

      // invariant: The fence is the TRIGGER, so a raw write that never asks the helper still fails.
      expect(() => db.prepare("update issues set title = 'edited' where id = 'I-000001'").run()).toThrow(
        /issue\.move-in-progress/,
      );
      expect(() => db.prepare("delete from issues where id = 'I-000001'").run()).toThrow(/issue\.move-in-progress/);
      // invariant: A child-table writer is rolled back because every one of them advances the
      // issue's revision in the same transaction, which is the trigger's own subject.
      expect(() => {
        db.exec("begin immediate");
        try {
          db.prepare(
            "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, " +
              "acceptance_key, location, observed_behavior, evidence_json, recorded_at) values ('I-000001', 'occ-1', " +
              "'test', 'suite/one', 'root', 'accept', 'loc', 'obs', '{}', '2026-11-21T00:00:00.000Z')",
          ).run();
          db.prepare("update issues set revision = revision + 1 where id = 'I-000001'").run();
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      }).toThrow(/issue\.move-in-progress/);
      expect((db.prepare("select count(*) as n from occurrences").get() as { n: number }).n).toBe(0);
      // invariant: Both relation writers are fenced, on EITHER end of the edge: a relation that
      // landed mid-flight would hand the destination a neighbourhood the move never counted.
      expect(() =>
        db.prepare("insert into relations(from_issue, relation, to_issue) values ('I-000002', 'blocks', 'I-000001')").run(),
      ).toThrow(/issue\.move-in-progress/);
      expect(() =>
        db.prepare("update relations set relation = 'blocks' where from_issue = 'I-000001'").run(),
      ).toThrow(/issue\.move-in-progress/);
      // invariant: The sync-state writers are fenced too, so a push prepared against the moved
      // record cannot advance while its record is frozen.
      expect(() =>
        db.prepare("insert into issue_sync_state(binding_id, direction, local_id, item_state, revision, updated_at) " +
          "values ('linear:p-one', 'pull', 'I-000001', 'pending', 1, '2026-11-21T00:00:00.000Z')").run(),
      ).toThrow(/issue\.move-in-progress/);
      expect(() =>
        db.prepare("update issue_sync_state set item_state = 'applied' where local_id = 'I-000001'").run(),
      ).toThrow(/issue\.move-in-progress/);
      // note: The caller-side helper names the operation and the phase, which is the recovery.
      expect(() => assertRecordWritable(db, "I-000001")).toThrow(/move-one/);

      // invariant: `switched` is still inside the blocking set, so a move that already switched
      // does not silently release its source; the record thaws at `published`.
      recordIssueMove(db, { ...sourceRow("mstar:issue:22222222-2222-4222-8222-222222222222", "switched", "move-two"), sourceIssueId: "I-000002" });
      expect(blockingMoveFor(db, "I-000002")).toEqual({ operationId: "move-two", phase: "switched" });
      // invariant: The refusal names the phase the row HOLDS as the one a discard starts from.
      // `published` is terminal and admits no discard, so naming it as the recovery phase sent an
      // operator at a transition that can never succeed.
      let switchedRefusal = "";
      try {
        assertRecordWritable(db, "I-000002");
      } catch (error) {
        switchedRefusal = error instanceof Error ? error.message : String(error);
      }
      expect(switchedRefusal).toContain("discard it from switched");
      expect(switchedRefusal).not.toContain("published");
      expect(() => db.prepare("update issues set title = 'edited' where id = 'I-000002'").run()).toThrow(
        /issue\.move-in-progress/,
      );
      advanceIssueMove(db, { operationId: "move-two", role: "source", from: "switched", to: "published" });
      expect(blockingMoveFor(db, "I-000002")).toBeNull();
      db.prepare("update issues set title = 'published edit' where id = 'I-000002'").run();

      // invariant: Leaving the blocking set restores the record: `discarded` frees it and
      // `published` outlives it without holding it.
      advanceIssueMove(db, { operationId: "move-one", role: "source", from: "staged", to: "discarded" });
      expect(blockingMoveFor(db, "I-000001")).toBeNull();
      db.prepare("update issues set title = 'edited' where id = 'I-000001'").run();
      expect((db.prepare("select title from issues where id = 'I-000001'").get() as { title: string }).title).toBe("edited");
    } finally {
      db.close();
    }
  });

  test("a frozen record refuses relation and sync-state deletes until the move leaves the fence", async () => {
    // invariant: Critical 4 (review wave 3, I-001244) — publication deletes the record's children and
    // its settled `issue_sync_state` rows only after the row leaves the blocking set; before that a
    // delete would strip the record a discard must restore, so the v4 lane's own triggers refuse it.
    const { db } = await freshLane();
    try {
      db.prepare(
        "insert into relations(from_issue, relation, to_ref) values ('I-000001', 'blocks', 'mstar:issue:99999999-9999-4999-8999-999999999999')",
      ).run();
      db.prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, " +
          "updated_at, identity_key, issue_ref) values ('I-000003', 'p-one', 'Linked finding', 'bug', 'low', 'open', " +
          "'i', 'a', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'third-key', " +
          "'mstar:issue:33333333-3333-4333-8333-333333333333')",
      ).run();
      db.prepare("insert into relations(from_issue, relation, to_issue) values ('I-000003', 'blocks', 'I-000001')").run();
      db.prepare(
        "insert into issue_sync_state(binding_id, direction, local_id, item_state, revision, updated_at) " +
          "values ('linear:p', 'push', 'I-000001', 'applied', 1, '2026-11-21T00:00:00.000Z')",
      ).run();
      recordIssueMove(db, sourceRow("mstar:issue:11111111-1111-4111-8111-111111111111", "staged"));

      // invariant: Every delete path into the fenced record aborts, on both the outgoing and the
      // incoming side of a relation.
      expect(() =>
        db.prepare("delete from issue_sync_state where local_id = 'I-000001'").run(),
      ).toThrow(/issue\.move-in-progress/);
      expect(() =>
        db.prepare("delete from relations where from_issue = 'I-000001'").run(),
      ).toThrow(/issue\.move-in-progress/);
      expect(() =>
        db.prepare("delete from relations where to_issue = 'I-000001'").run(),
      ).toThrow(/issue\.move-in-progress/);
      expect(db.prepare("select count(*) as n from relations").get()).toEqual({ n: 2 });
      expect(db.prepare("select count(*) as n from issue_sync_state").get()).toEqual({ n: 1 });

      // note: Publication's own child sweep lands only once the row is terminal, which is the order
      // the guard preserves.
      advanceIssueMove(db, { operationId: "move-one", role: "source", from: "staged", to: "verified" });
      advanceIssueMove(db, { operationId: "move-one", role: "source", from: "verified", to: "switched" });
      advanceIssueMove(db, { operationId: "move-one", role: "source", from: "switched", to: "published" });
      db.prepare("delete from issue_sync_state where local_id = 'I-000001'").run();
      db.prepare("delete from relations where to_issue = 'I-000001'").run();
      expect(db.prepare("select count(*) as n from issue_sync_state").get()).toEqual({ n: 0 });
      expect(
        db.prepare("select count(*) as n from relations where to_issue = 'I-000001'").get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("a fenced write names the record's own move while another move is in flight", async () => {
    // invariant: Critical 5 (review wave 3) — the trigger refusal used to name the record only when
    // exactly one move was in flight; the write's addressed record now picks its own blocking move
    // out of several, so the operator resumes the right one.
    const { db } = await freshLane();
    try {
      db.prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, " +
          "updated_at, identity_key, issue_ref) values ('I-000002', 'p-one', 'Second finding', 'risk', 'low', 'open', " +
          "'i', 'a', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'second-key', " +
          "'mstar:issue:22222222-2222-4222-8222-222222222222')",
      ).run();
      recordIssueMove(db, sourceRow("mstar:issue:11111111-1111-4111-8111-111111111111", "staged"));
      recordIssueMove(db, {
        ...sourceRow("mstar:issue:22222222-2222-4222-8222-222222222222", "staged", "move-two"),
        sourceIssueId: "I-000002",
      });

      const trigger = (): unknown => {
        try {
          db.prepare("update issues set title = 'blocked' where id = 'I-000002'").run();
          return null;
        } catch (error) {
          return error;
        }
      };
      const refusal = frozenMoveRefusal(db, trigger(), "I-000002");
      expect(refusal?.message).toContain("issue I-000002 is frozen by move move-two in phase staged");
      expect(refusal?.details?.blocking_moves).toHaveLength(2);

      // note: A trigger abort for a record that carries no move still falls back to the lane list.
      const foreign = frozenMoveRefusal(db, new Error("issue.move-in-progress"));
      expect(foreign?.message).toContain("2 cross-authority moves are in flight");
    } finally {
      db.close();
    }
  });

  test("a lane is v4 and a v3 lane reaches v4 through the ladder", async () => {
    const { db } = await freshLane();
    try {
      expect((db.prepare("select max(version) as v from schema_version").get() as { v: number }).v).toBe(4);
      expect(
        (db.prepare("pragma table_info(issue_moves)").all() as Array<{ name: string }>).map((column) => column.name),
      ).toContain("operation_id");
    } finally {
      db.close();
    }

    // invariant: A v3 lane is a real predecessor: it is written by the earlier migrations alone and
    // the ladder advances it in place, recording only the version it crossed.
    const legacy = collaborationLocationOfRepoKey(`github.com/acme/legacy-v3-${sequence++}`, "local");
    mkdirSync(join(legacy.dbPath, ".."), { recursive: true, mode: 0o700 });
    const raw = new DatabaseSync(legacy.dbPath);
    try {
      raw.exec("pragma foreign_keys=on");
      raw.exec(SCHEMA_VERSION_TABLE_SQL);
      for (const migration of COLLABORATION_MIGRATIONS.filter((entry) => entry.version <= 3)) {
        raw.exec(migration.sql);
        raw.prepare("insert into schema_version values(?, ?, ?, ?)").run(
          migration.version,
          migration.name,
          migrationChecksum(migration),
          "2026-11-21T00:00:00.000Z",
        );
      }
      raw.prepare(
        "insert into collaboration_meta(id, repository_key, mode, store_id, authority_state, authority_epoch, revision, " +
          "catalog_revision, created_at) values (1, ?, 'local', 'legacy-store', 'active', 1, 0, 0, ?)",
      ).run(legacy.repoKey, "2026-11-21T00:00:00.000Z");
    } finally {
      raw.close();
    }
    const upgraded = new DatabaseSync(legacy.dbPath) as unknown as StoreDb;
    try {
      upgraded.exec("begin immediate");
      const receipt = applyCollaborationLadder(upgraded, legacy.dbPath);
      upgraded.exec("commit");
      expect(receipt.fromVersion).toBe(3);
      expect((upgraded.prepare("select max(version) as v from schema_version").get() as { v: number }).v).toBe(4);
      expect(
        upgraded.prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'issue_moves'").get(),
      ).toEqual({ n: 1 });
    } finally {
      upgraded.close();
    }
  });
});

// ---------------------------------------------------------------------------
// note: The phase engine's cases: stage, verify, switch, publish and discard across two local lanes.
// ---------------------------------------------------------------------------

let engineSequence = 0;

/** note: A bound source checkout: git root, its `.mstarc`, an ACTIVE execution store and its source lane. */
async function sourceCheckout(): Promise<{ context: StoreContext; db: StoreDb; repoKey: string }> {
  const root = join(ROOT, `source-${engineSequence++}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=fixture-${String(engineSequence)}\n`);
  const context: StoreContext = { harnessDir: join(root, ".mstar") };
  mkdirSync(context.harnessDir, { recursive: true });
  (await initializeStore(context)).close();
  await ensureCollaborationAuthority(context);
  const location = resolveCollaborationLocation(context);
  const db = new DatabaseSync(location.dbPath) as unknown as StoreDb;
  db.exec("pragma foreign_keys=on");
  return { context, db, repoKey: location.repoKey };
}

/** note: One ACTIVE destination lane of its own `repoKey`, registered to accept one project. */
async function destinationLane(projectId: string): Promise<{ repoKey: string; location: CollaborationLocation }> {
  const repoKey = `github.com/acme/dest-${engineSequence++}`;
  const location = collaborationLocationOfRepoKey(repoKey, "local");
  mkdirSync(join(location.dbPath, ".."), { recursive: true, mode: 0o700 });
  await initializeCollaborationStore(location);
  await writeCollaborationStage(location, ({ db }) => {
    db.prepare("update collaboration_meta set authority_state = 'active' where id = 1").run();
    db.prepare(
      "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) " +
        "values ('project', ?, ?, 'projects', ?, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
    ).run(projectId, projectId, `projects/${projectId}`);
  });
  return { repoKey, location };
}

/** note: The selector ref a remote checkout's own resolution reads through real Git plumbing. */
const SELECTOR_REF = "refs/heads/mstar-collaboration-authority";

/** note: One project a remote selector must select to be valid; ids are immutable Linear uuids. */
const SELECTED_PROJECT = {
  localProjectId: "fixture-project",
  provider: "linear",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  journalIssueId: "44444444-4444-4444-8444-444444444444",
  writerId: "55555555-5555-4555-8555-555555555555",
} as const;

/**
 * note: A checkout that RESOLVES remote: a bare origin publishes one selector generation naming its
 * canonical repoKey, and the checkout's `insteadOf` routes the synthetic https URL to the bare
 * fixture, so `ls-remote` and `fetch` run on the real Git path. It stays UNBOUND on purpose: the
 * refusal under test must come from the move layer, not the lane's bind recovery.
 */
function remoteCheckout(): { context: StoreContext; repoKey: string } {
  const repoKey = `github.com/acme/remote-${engineSequence++}`;
  const canonicalOrigin = `https://${repoKey}.git`;
  const bare = join(ROOT, `remote-origin-${engineSequence}.git`);
  execFileSync("git", ["init", "-q", "--bare", bare], { cwd: ROOT });
  const publisher = join(ROOT, `remote-publisher-${engineSequence}`);
  mkdirSync(publisher, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: publisher });
  execFileSync("git", ["config", "user.name", "Selector Test"], { cwd: publisher });
  execFileSync("git", ["config", "user.email", "selector@example.test"], { cwd: publisher });
  writeFileSync(
    join(publisher, "authority.json"),
    `${JSON.stringify(
      {
        version: 1,
        repoKey,
        generation: 1,
        mode: "remote",
        phase: "active",
        projects: [SELECTED_PROJECT],
        previous: null,
        cutover: null,
      },
      null,
      2,
    )}\n`,
  );
  execFileSync("git", ["add", "authority.json"], { cwd: publisher });
  execFileSync("git", ["commit", "-q", "-m", "publish selector"], { cwd: publisher });
  execFileSync("git", ["push", "-q", "--force", bare, `HEAD:${SELECTOR_REF}`], { cwd: publisher });

  const repo = join(ROOT, `remote-repo-${engineSequence}`);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Remote Discard Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "remote-discard@example.test"], { cwd: repo });
  execFileSync("git", ["config", "--add", "remote.origin.url", canonicalOrigin], { cwd: repo });
  execFileSync("git", ["config", `url.${bare}.insteadOf`, canonicalOrigin], { cwd: repo });
  writeFileSync(join(repo, ".mstarc"), "[collaboration]\nmode=remote\n");
  const harnessDir = join(repo, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  return { context: { harnessDir, checkoutRoot: repo }, repoKey };
}

/** note: A captured record with two occurrences, one transition, one provenance row and a settled mirror row. */
async function seededRecord(context: StoreContext, db: StoreDb, projectId: string, tag = ""): Promise<string> {
  const receipt = await captureIssue(
    context,
    {
      projectId,
      title: "Moving finding",
      kind: "bug",
      severity: "high",
      impact: "impact",
      acceptance: "acceptance",
      sourceIdentity: `review/move${tag}`,
      rootCauseKey: `root-move${tag}`,
      acceptanceKey: `accept-move${tag}`,
      occurrenceKey: `occ-move-1${tag}`,
      sourceKind: "test",
      location: "src/a.ts",
      observedBehavior: "fails",
      evidence: ["repro"],
      discoveredAt: "2026-11-21T00:00:00.000Z",
    },
    { actor: "project-manager", operationId: `capture-${String(engineSequence)}${tag}` },
  );
  await appendOccurrence(
    context,
    receipt.issueId,
    {
      sourceIdentity: `review/move${tag}`,
      rootCauseKey: `root-move${tag}`,
      acceptanceKey: `accept-move${tag}`,
      occurrenceKey: `occ-move-2${tag}`,
      sourceKind: "test",
      location: "src/b.ts",
      observedBehavior: "fails again",
      evidence: [],
      discoveredAt: "2026-11-21T00:00:01.000Z",
    },
    { actor: "project-manager", operationId: `occurrence-${String(engineSequence)}${tag}` },
  );
  db.prepare(
    "insert into issue_sync_state(binding_id, direction, local_id, item_state, revision, updated_at) " +
      "values ('linear:p', 'push', ?, 'applied', 1, '2026-11-21T00:00:00.000Z')",
  ).run(receipt.issueId);
  db.prepare(
    "insert into provenance(issue_id, kind, target, source_hash, origin) values (?, 'plan', 'plan-one', 'hash', 'scoped')",
  ).run(receipt.issueId);
  db.prepare("update issues set revision = revision + 1 where id = ?").run(receipt.issueId);
  return receipt.issueId;
}

/** note: Every column of the record and its children, as one comparable value: the "byte-identical" test. */
function recordImage(db: StoreDb, issueId: string): unknown {
  const one = (sql: string): unknown[] => db.prepare(sql).all(issueId);
  return {
    issue: db.prepare("select * from issues where id = ?").all(issueId),
    occurrences: one("select * from occurrences where issue_id = ? order by id"),
    transitions: one("select * from issue_transitions where issue_id = ? order by id"),
    provenance: one("select * from provenance where issue_id = ? order by id"),
    projectMoves: one("select * from issue_project_moves where issue_id = ? order by id"),
    relations: one("select * from relations where from_issue = ? order by relation"),
    sync: one("select * from issue_sync_state where local_id = ? order by binding_id"),
  };
}

/** note: One text column of one row, narrowed once so a fixture reads it without an unchecked cast. */
function columnOf(db: StoreDb, sql: string, column: string, ...params: unknown[]): string {
  const row = db.prepare(sql).get(...params);
  if (row === null || typeof row !== "object") throw new Error(`${sql} returned no row`);
  const value = (row as Record<string, unknown>)[column];
  if (typeof value !== "string") throw new Error(`${sql} carries no text in ${column}`);
  return value;
}

/** note: The lane's own revision counter, read the way a caller reading `storeRevision` would. */
function laneRevision(db: StoreDb): number {
  const row = db.prepare("select revision from collaboration_meta where id = 1").get();
  if (row === null || typeof row !== "object") throw new Error("collaboration_meta returned no row");
  const value = (row as Record<string, unknown>).revision;
  if (typeof value !== "number") throw new Error("collaboration_meta.revision is unreadable");
  return value;
}

/** note: One record's revision, the value `--expect` carries. */
function laneIssueRevision(db: StoreDb, issueId: string): number {
  const row = db.prepare("select revision from issues where id = ?").get(issueId);
  if (row === null || typeof row !== "object") throw new Error(`${issueId} returned no row`);
  const value = (row as Record<string, unknown>).revision;
  if (typeof value !== "number") throw new Error(`${issueId} carries no revision`);
  return value;
}

/**
 * note: One record's stable reference, read for the fixtures that need to plant a destination record
 * under it. A move carries this value unchanged, so a collision fixture must use it verbatim.
 */
function readIssueMoveReference(db: StoreDb, issueId: string): string {
  return columnOf(db, "select issue_ref from issues where id = ?", "issue_ref", issueId);
}

/**
 * note: One durable provider intent for a record, planted with the binding row its foreign key
 * requires. Only a `remote` lane ever writes these; the fixture builds the row directly so a
 * stage precondition can be proved without a provider round trip.
 */
function seedOutboxIntent(db: StoreDb, issueRef: string, operationId: string, state: "enqueued" | "unconfirmed" | "conflict"): void {
  db.prepare(
    "insert or ignore into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
      "provider_project_id, journal_issue_id, writer_id, verified_at, verification_json) " +
      "values (1, 'p-source', ?, 'linear', 'ws', 'team', 'provider-project', 'journal-issue', null, ?, '{}')",
  ).run("a".repeat(40), "2026-11-21T00:00:00.000Z");
  db.prepare(
    "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, state, created_at, updated_at) " +
      "values (?, 1, 'p-source', 'hash', ?, ?, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
  ).run(
    operationId,
    JSON.stringify({ event: { change: { kind: "issue-replace", issueRef } }, target: "provider-issue" }),
    state,
  );
}

describe("cross-authority move phase engine", () => {
  test("stage carries the same issue_ref and every child row into the destination lane", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      // note: An edge that stays behind must survive the staging as the target's stable reference.
      const other = await captureIssue(
        context,
        {
          projectId: "p-source",
          title: "Stays behind",
          kind: "risk",
          severity: "low",
          impact: "impact",
          acceptance: "acceptance",
          sourceIdentity: "review/stay",
          rootCauseKey: "root-stay",
          acceptanceKey: "accept-stay",
          occurrenceKey: "occ-stay",
          sourceKind: "test",
          location: "src/c.ts",
          observedBehavior: "observed",
          evidence: [],
          discoveredAt: "2026-11-21T00:00:00.000Z",
        },
        { actor: "project-manager", operationId: "capture-stay" },
      );
      await linkIssue(context, issueId, { relation: "blocks", issueId: other.issueId }, {
        actor: "project-manager",
        operationId: "link-for-move",
        expectedRevision: (db.prepare("select revision from issues where id = ?").get(issueId) as { revision: number }).revision,
      });
      const before = recordImage(db, issueId);

      const staged = await stageMove(context, {
        operationId: "move-stage",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "belongs to the other authority",
      });

      expect(staged).toBeUndefined();
      const sourceRowNow = readIssueMove(db, "move-stage", "source");
      const destinationRow = await readCollaborationStage(destination.location, ({ db: lane }) =>
        readIssueMove(lane, "move-stage", "destination"),
      );
      expect(destinationRow).not.toBeNull();
      // invariant: The same stable reference on both sides, and no local id of the source lane in the copy.
      expect(destinationRow!.issueRef).toBe(sourceRowNow!.issueRef);
      expect(destinationRow!.payloadDigest).toBe(sourceRowNow!.payloadDigest);
      expect(destinationRow!.payloadJson).not.toContain(issueId);
      const counts = JSON.parse(sourceRowNow!.stagedCounts) as Record<string, number>;
      expect(counts).toEqual({
        occurrences: 2,
        issueTransitions: 0,
        provenance: 2,
        relations: 1,
        issueProjectMoves: 0,
        relationsLeftBehind: 0,
      });
      // invariant: The source record is frozen from this commit on, and every row it owned is intact.
      expect(recordImage(db, issueId)).toEqual(before);
      expect(() => db.prepare("update issues set title = 'edited' where id = ?").run(issueId)).toThrow(
        /issue\.move-in-progress/,
      );
      expect(stagedMismatch(sourceRowNow!, destinationRow!)).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  test("a count or digest mismatch discards the move and leaves the source record untouched", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const request = {
        operationId: "move-verify-counts",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "mismatch",
      };
      await stageMove(context, request);
      // note: Replace the staged counts: a copy whose rows were replaced, not added or removed.
      await writeCollaborationStage(destination.location, ({ db: lane }) => {
        lane.prepare("update issue_moves set staged_counts = ? where operation_id = 'move-verify-counts'").run(
          JSON.stringify({ occurrences: 9, issueTransitions: 0, provenance: 2, relations: 1, issueProjectMoves: 0, relationsLeftBehind: 0 }),
        );
      });
      const refused = await moveAcrossAuthorities(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("collaboration.operation-partial");
      expect(String(refused?.message)).toContain("counts");
      expect(refused?.details?.phase).toBe("discarded");
      // invariant: A refused verification never switches, so the record is byte-identical and the
      // destination row is gone; the source row is the audit of the attempt.
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-verify-counts", "source")?.phase).toBe("discarded");
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) =>
          readIssueMove(lane, "move-verify-counts", "destination"),
        ),
      ).toBeNull();
      expect(blockingMoveFor(db, issueId)).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  test("a rewritten staged payload fails its own digest even when the counts still agree", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const request = {
        operationId: "move-verify-digest",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "digest",
      };
      await stageMove(context, request);
      const sourceRowNow = readIssueMove(db, "move-verify-digest", "source")!;
      const rewritten = { ...(JSON.parse(sourceRowNow.payloadJson) as Record<string, unknown>), rewritten: true };
      const rewrittenStaged = { ...sourceRowNow, payloadJson: JSON.stringify(rewritten) };
      expect(stagedMismatch(sourceRowNow, rewrittenStaged)).toContain("no longer hashes");
    } finally {
      db.close();
    }
  }, 60_000);


  test("switch commits the source row first, then admits the record into the destination", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const request = {
        operationId: "move-full",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "belongs to the other authority",
      };
      const receipt = await moveAcrossAuthorities(context, request);
      expect(receipt.phase).toBe("published");
      expect(receipt.resumedFrom).toBeNull();
      // invariant: The source record and its children are gone; the move row outlives it as the audit.
      expect(db.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
      expect(db.prepare("select count(*) as n from occurrences where issue_id = ?").get(issueId)).toEqual({ n: 0 });
      expect(readIssueMove(db, "move-full", "source")).toMatchObject({ phase: "published", removedSyncRows: 1 });
      expect(blockingMoveFor(db, issueId)).toBeNull();
      // invariant: The destination holds the SAME reference and every carried row, under its own display id.
      const admitted = await readCollaborationStage(destination.location, ({ db: lane }) => ({
        row: readIssueMove(lane, "move-full", "destination"),
        issue: lane.prepare("select id, project_id, issue_ref from issues").all(),
        occurrences: lane.prepare("select count(*) as n from occurrences").get(),
        provenance: lane.prepare("select count(*) as n from provenance").get(),
        projectMoves: lane.prepare("select count(*) as n from issue_project_moves").get(),
      }));
      expect(admitted.row).toMatchObject({ phase: "switched" });
      expect(admitted.issue).toHaveLength(1);
      const [moved] = admitted.issue as Array<{ id: string; project_id: string; issue_ref: string }>;
      expect(moved).toMatchObject({ id: "I-000001", project_id: "p-dest" });
      expect(moved!.issue_ref).toBe(receipt.issueRef);
      expect(receipt.destinationIssueId).toBe(moved!.id);
      expect(admitted.occurrences).toEqual({ n: 2 });
      expect(admitted.provenance).toEqual({ n: 2 });
      expect(admitted.projectMoves).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("a source write after staged is refused by the trigger, and a switched record is not presented", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const request = {
        operationId: "move-fence",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "fence",
      };
      await stageMove(context, request);
      // invariant: The fence is the TRIGGER: a write that never asks the helper still fails, and the
      // issue-domain entry restates it as the partial outcome naming the move.
      const refused = await appendOccurrence(
        context,
        issueId,
        {
          sourceIdentity: "review/move",
          rootCauseKey: "root-move",
          acceptanceKey: "accept-move",
          occurrenceKey: "occ-during-move",
          sourceKind: "test",
          location: "src/d.ts",
          observedBehavior: "observed",
          evidence: [],
          discoveredAt: "2026-11-21T00:00:02.000Z",
        },
        { actor: "project-manager", operationId: "occurrence-during-move" },
      ).then(() => null, (error: unknown) => error as { code?: string; details?: Record<string, unknown> });
      expect(refused?.code).toBe("collaboration.operation-partial");
      expect(refused?.details?.cause).toBe("issue.move-in-progress");
      expect(JSON.stringify(refused?.details)).toContain("move-fence");
      expect(db.prepare("select count(*) as n from occurrences where issue_id = ?").get(issueId)).toEqual({ n: 2 });

      await moveAcrossAuthorities(context, request, "switched");
      // invariant: After the switch this lane stops presenting the record and refuses its writes.
      await expect(getIssue(context, issueId)).rejects.toMatchObject({ code: "collaboration.operation-partial" });
      expect(() => db.prepare("update issues set title = 'edited' where id = ?").run(issueId)).toThrow(
        /issue\.move-in-progress/,
      );
      const published = await moveAcrossAuthorities(context, request);
      expect(published.phase).toBe("published");
      expect(db.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("publication happens once per operation id and a replay reports the same phase", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const request = {
        operationId: "move-once",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "once",
      };
      const first = await moveAcrossAuthorities(context, request);
      const second = await moveAcrossAuthorities(context, request);
      expect(second).toEqual({ ...first, resumedFrom: "published" });
      // invariant: One publication, so the destination holds exactly one admitted record and one
      // project-move row; a second deletion would have failed the audit row's own evidence.
      const admitted = await readCollaborationStage(destination.location, ({ db: lane }) => ({
        issues: lane.prepare("select count(*) as n from issues").get(),
        moves: lane.prepare("select count(*) as n from issue_project_moves").get(),
      }));
      expect(admitted).toEqual({ issues: { n: 1 }, moves: { n: 1 } });
      expect(db.prepare("select count(*) as n from issue_moves where phase = 'published'").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  }, 60_000);
  test("two moves linked by relations publish through each other's fence", async () => {
    // invariant: Critical 2 (review wave 4) — a publication flips its own source row to `published`
    // inside the same transaction before the record's children go, so the delete and rewrite guards
    // must admit exactly that work even while the OTHER endpoint is still frozen by its own move.
    // Without the exemption two linked records deadlock: each publication deletes or rewrites an
    // edge whose other endpoint is mid-move.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const firstId = await seededRecord(context, db, "p-source");
      const secondId = await seededRecord(context, db, "p-source", "-second");
      // note: One edge in each direction, so each publication both DELETES an outgoing edge into a
      // frozen record and REWRITES an incoming edge held by one.
      await linkIssue(context, firstId, { relation: "blocks", issueId: secondId }, {
        actor: "project-manager",
        operationId: `link-out-${String(engineSequence)}`,
        expectedRevision: laneIssueRevision(db, firstId),
      });
      await linkIssue(context, secondId, { relation: "blocks", issueId: firstId }, {
        actor: "project-manager",
        operationId: `link-back-${String(engineSequence)}`,
        expectedRevision: laneIssueRevision(db, secondId),
      });
      const first = {
        operationId: "move-linked-first",
        actor: "project-manager",
        sourceIssueId: firstId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "linked departure",
      };
      const second = {
        operationId: "move-linked-second",
        actor: "project-manager",
        sourceIssueId: secondId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "linked departure",
      };

      // note: Both moves freeze first, so each publication meets the other's fence exactly.
      await moveAcrossAuthorities(context, first, "switched");
      await moveAcrossAuthorities(context, second, "switched");
      expect(blockingMoveFor(db, firstId)?.phase).toBe("switched");
      expect(blockingMoveFor(db, secondId)?.phase).toBe("switched");

      // invariant: The second move's publish deletes its outgoing edge into the still-frozen first
      // record and rewrites the edge the frozen record holds into it; neither fires the guard.
      expect((await moveAcrossAuthorities(context, second)).phase).toBe("published");
      expect((await moveAcrossAuthorities(context, first)).phase).toBe("published");
      expect(db.prepare("select count(*) as n from issues where id in (?, ?)").get(firstId, secondId)).toEqual({ n: 0 });
      const admitted = await readCollaborationStage(destination.location, ({ db: lane }) => ({
        issues: lane.prepare("select count(*) as n from issues").get(),
        relations: lane.prepare("select relation, to_issue as toIssue, to_ref as toRef from relations order by from_issue, relation").all(),
      }));
      expect(admitted.issues).toEqual({ n: 2 });
      // invariant: The destination holds both records' outgoing edges, localized to the display ids
      // the admission allocated; nothing of the source lane was left stranded.
      expect(admitted.relations.length).toBe(2);
    } finally {
      db.close();
    }
  }, 60_000);


  test("discard leaves the source record byte-identical and deletes the destination row", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const request = {
        operationId: "move-discard",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "abandon",
      };
      await stageMove(context, request);
      expect(blockingMoveFor(db, issueId)).not.toBeNull();
      const discarded = await discardMove(context, request);
      expect(discarded).toMatchObject({ phase: "discarded", issueRef: (before as { issue: Array<{ issue_ref: string }> }).issue[0]!.issue_ref });
      // invariant: "byte-identical" is column by column over the record and every child row.
      expect(recordImage(db, issueId)).toEqual(before);
      expect(blockingMoveFor(db, issueId)).toBeNull();
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) =>
          lane.prepare("select count(*) as n from issue_moves").get(),
        ),
      ).toEqual({ n: 0 });
      // note: The discarded row is the audit of the refused move and it stays.
      expect(readIssueMove(db, "move-discard", "source")?.phase).toBe("discarded");
      db.prepare("update issues set title = 'writable again' where id = ?").run(issueId);
    } finally {
      db.close();
    }
  }, 60_000);

  test("a discard that carries a stale record base refuses before anything is unfrozen", async () => {
    // invariant: `--discard` reads the source record, so it honours the record CAS the verb requires:
    // a discard on a base the caller no longer holds refuses with the local move's own code and leaves
    // the record frozen and the ledger row exactly where it was. The lane revision is deliberately not
    // the discard's base — a move's own phase commits advance it — so the schema and runtime require
    // `--expect-store` only on the routes that can honour it.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const request = {
        operationId: "move-discard-stale",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "abandon",
      };
      await stageMove(context, request);
      const before = recordImage(db, issueId);
      const staleRecord = await discardMove(context, { ...request, expectedRevision: laneIssueRevision(db, issueId) + 1 }).then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
      expect(staleRecord?.code).toBe("issue.revision-conflict");
      expect(staleRecord?.details?.recovery).toEqual(expect.stringContaining("--expect"));
      // invariant: The refusal unfroze nothing: the record is byte-identical and the row still blocks.
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-discard-stale", "source")?.phase).toBe("staged");
      expect(blockingMoveFor(db, issueId)?.phase).toBe("staged");
      // note: The current record base discards, and it needs no lane revision to do it.
      const discarded = await discardMove(context, { ...request, expectedRevision: laneIssueRevision(db, issueId) });
      expect(discarded).toMatchObject({ phase: "discarded", resumedFrom: "staged" });
      expect(blockingMoveFor(db, issueId)).toBeNull();
      expect(recordImage(db, issueId)).toEqual(before);
    } finally {
      db.close();
    }
  }, 60_000);

  test("the live-intent refusal names the outbox step that works in the state it reports", async () => {
    // invariant: The recovery a refusal publishes must be executable in the state it names. Dispatch
    // only advances an `enqueued` row, so an `unconfirmed` operator needs the receipt or a
    // reconciliation, and a `conflict` needs the reviewed resolution.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const issueRef = readIssueMoveReference(db, issueId);
      const request = {
        operationId: "move-intent-state",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "cross",
      };
      const recoveryOf = async (state: "enqueued" | "unconfirmed" | "conflict", operationId: string): Promise<string> => {
        seedOutboxIntent(db, issueRef, operationId, state);
        const refused = await moveAcrossAuthorities(context, request).then(
          () => null,
          (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
        );
        expect(refused?.code).toBe("remote.effect-pending");
        expect(refused?.details).toMatchObject({ operationId, state });
        return String(refused?.details?.recovery ?? "");
      };
      const enqueued = await recoveryOf("enqueued", "intent-enqueued");
      expect(enqueued).toContain("outbox-abandon");
      expect(enqueued).toContain("outbox-dispatch");
      db.prepare("update remote_outbox set state = 'confirmed' where operation_id = ?").run("intent-enqueued");

      const unconfirmed = await recoveryOf("unconfirmed", "intent-unconfirmed");
      expect(unconfirmed).toContain("outbox-receipt");
      expect(unconfirmed).toContain("outbox-reconcile");
      // invariant: The state that already dispatched is never sent back to `outbox-dispatch`.
      expect(unconfirmed).not.toContain("outbox-dispatch");
      db.prepare("update remote_outbox set state = 'confirmed' where operation_id = ?").run("intent-unconfirmed");

      const conflict = await recoveryOf("conflict", "intent-conflict");
      expect(conflict).toContain("outbox-resolve");
      expect(conflict).not.toContain("outbox-dispatch");
      // invariant: Nothing was staged under any of the three live states.
      expect(readIssueMove(db, request.operationId, "source")).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  test("the same command resumes from every persisted phase", async () => {
    // invariant: Each case stops the move at one boundary (a process loss is exactly "the next call
    // did not happen"), then reissues the SAME command and reaches publication.
    for (const stop of ["staged", "verified", "switched"] as const) {
      const { context, db } = await sourceCheckout();
      try {
        const destination = await destinationLane("p-dest");
        const issueId = await seededRecord(context, db, "p-source");
        const request = {
          operationId: `move-resume-${stop}`,
          actor: "project-manager",
          sourceIssueId: issueId,
          destinationAuthority: destination.repoKey,
          destinationProject: "p-dest",
          reason: "resume",
        };
        const interrupted = await moveAcrossAuthorities(context, request, stop);
        expect(interrupted.phase).toBe(stop);
        expect(blockingMoveFor(db, issueId)?.phase).toBe(stop);

        const resumed = await moveAcrossAuthorities(context, request);
        expect(resumed.phase).toBe("published");
        expect(resumed.resumedFrom).toBe(stop);
        expect(db.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
        const admitted = await readCollaborationStage(destination.location, ({ db: lane }) => ({
          row: readIssueMove(lane, request.operationId, "destination"),
          issues: lane.prepare("select count(*) as n from issues").get(),
        }));
        expect(admitted.row).toMatchObject({ phase: "switched", destinationIssueId: "I-000001" });
        expect(admitted.issues).toEqual({ n: 1 });
      } finally {
        db.close();
      }
    }
  }, 120_000);

  test("a direct update on a record with a source row in a blocking phase fails with issue.move-in-progress", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      await stageMove(context, {
        operationId: "move-direct-update",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "direct update",
      });
      // invariant: The database refuses the write itself, so no calling path can write a frozen
      // record by forgetting to ask. `update issues` is the exact statement a product writer issues.
      expect(() => db.prepare("update issues set title = 'rewritten' where id = ?").run(issueId)).toThrow(
        /issue\.move-in-progress/,
      );
      expect((db.prepare("select title from issues where id = ?").get(issueId) as { title: string }).title).toBe(
        "Moving finding",
      );
    } finally {
      db.close();
    }
  }, 60_000);

  test("an unadmitted destination refuses publication instead of deleting the only copy", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const request = {
        operationId: "move-unadmitted",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "unadmitted",
      };
      await stageMove(context, request);
      await verifyMove(context, request);
      await switchMove(context, request);
      // note: The source commits `switched` first; the admission is the step that follows. Dropping the
      // destination copy models a process loss between the two, and the zero-member window it leaves.
      await writeCollaborationStage(destination.location, ({ db: lane }) => {
        lane.prepare("delete from issue_moves where role = 'destination'").run();
      });
      const refused = await publishMove(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("collaboration.operation-partial");
      expect(String(refused?.message)).toContain("only copy of the record");
      expect(refused?.details).toMatchObject({ phase: "switched" });
      // invariant: Nothing was deleted, so the same command still has the source to finish from.
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-unadmitted", "source")?.phase).toBe("switched");
      await expect(getIssue(context, issueId)).rejects.toMatchObject({ code: "collaboration.operation-partial" });

      // note: Reissuing the whole verb re-copies the payload, admits it and publishes it once.
      const resumed = await moveAcrossAuthorities(context, request);
      expect(resumed.phase).toBe("published");
      expect(db.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("the initial store CAS holds only on the run that stages, so the same command resumes", async () => {
    // invariant: Finding 1 — the store revision the caller passed belongs to the FIRST run only. A
    // resume reissues that same argument unchanged, and must not compare a base staging already spent.
    for (const stop of ["staged", "verified", "switched"] as const) {
      const { context, db } = await sourceCheckout();
      try {
        const destination = await destinationLane("p-dest");
        const issueId = await seededRecord(context, db, "p-source");
        const observed = laneRevision(db);
        const request = {
          operationId: `move-base-${stop}`,
          actor: "project-manager",
          sourceIssueId: issueId,
          destinationAuthority: destination.repoKey,
          destinationProject: "p-dest",
          reason: "base",
          expectedStoreRevision: observed,
        };
        expect((await moveAcrossAuthorities(context, request, stop)).phase).toBe(stop);
        // note: Staging advanced the lane revision, so this same argument is now stale by value.
        expect(laneRevision(db)).toBeGreaterThan(observed);
        expect((await moveAcrossAuthorities(context, request)).phase).toBe("published");
      } finally {
        db.close();
      }
    }
  }, 120_000);

  test("a stale base refuses before anything is frozen", async () => {
    // invariant: Finding 5 — the caller's ISSUE revision is a base the freeze must compare, in the same
    // transaction that freezes. It was previously neither passed nor checked, so a command could stage
    // a record that had changed after the operator read it.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const current = laneIssueRevision(db, issueId);
      const request = {
        operationId: "move-base-stale",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "stale",
        expectedStoreRevision: laneRevision(db),
        expectedRevision: current - 1,
      };
      const refused = await moveAcrossAuthorities(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("issue.revision-conflict");
      // invariant: The base refusal is the documented recovery, not a durable decline: a reissue under
      // the same operation id must still be admitted once the caller re-reads the revisions.
      expect(refused?.details?.recovery).toEqual(expect.stringContaining(`mstar issue show --id ${issueId}`));
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-base-stale", "source")).toBeNull();
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) => lane.prepare("select count(*) as n from issue_moves").get()),
      ).toEqual({ n: 0 });
      // invariant: And the corrected command lands under the SAME operation id.
      const corrected = await moveAcrossAuthorities(context, { ...request, expectedRevision: current });
      expect(corrected.phase).toBe("published");
    } finally {
      db.close();
    }
  }, 60_000);

  test("a stale store base refuses before anything is frozen", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const refused = await moveAcrossAuthorities(context, {
        operationId: "move-store-stale",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "stale store",
        expectedStoreRevision: 0,
      }).then(() => null, (error: unknown) => error as { code?: string; details?: Record<string, unknown> });
      expect(refused?.code).toBe("milestone.revision-conflict");
      expect(refused?.details?.recovery).toEqual(expect.stringContaining("--expect-store"));
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-store-stale", "source")).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  test("a record holding a pending provider intent refuses to stage, and stages once it is settled", async () => {
    // invariant: The spec's stage precondition — a live `remote_outbox` intent for this record's
    // reference refuses with `remote.effect-pending`, because the provider may already hold that
    // write. The refusal leaves the record unfrozen and records no move row.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const issueRef = readIssueMoveReference(db, issueId);
      const before = recordImage(db, issueId);
      const request = {
        operationId: "move-intent-pending",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "cross",
      };
      seedOutboxIntent(db, issueRef, "intent-ahead", "enqueued");
      const refused = await moveAcrossAuthorities(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("remote.effect-pending");
      expect(refused?.details).toMatchObject({ issue_ref: issueRef, pending_intents: 1, operationId: "intent-ahead", state: "enqueued" });
      expect(refused?.details?.recovery).toEqual(expect.stringContaining("outbox-receipt"));
      // invariant: Nothing was staged and nothing was frozen: no move row, identical record, writable.
      expect(readIssueMove(db, request.operationId, "source")).toBeNull();
      expect(recordImage(db, issueId)).toEqual(before);
      expect(() => assertRecordWritable(db, issueId)).not.toThrow();
      // note: A settled intent no longer refuses — only the three live states do.
      db.prepare("update remote_outbox set state = 'confirmed' where operation_id = ?").run("intent-ahead");
      const staged = await stageMove(context, request);
      expect(staged).toBeUndefined();
      expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("staged");
    } finally {
      db.close();
    }
  }, 60_000);

  test("a reused operation id cannot carry another record, authority or project", async () => {
    // invariant: Finding 2 — binding is checked before any destination or terminal action, so an
    // operation id reused for a different destination refuses instead of staging and admitting it.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const elsewhere = await destinationLane("p-other");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      await stageMove(context, {
        operationId: "move-bound",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "bound",
      });
      // note: The same id aimed at another authority AND another project.
      const refused = await moveAcrossAuthorities(context, {
        operationId: "move-bound",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: elsewhere.repoKey,
        destinationProject: "p-other",
        reason: "hijack",
      }).then(() => null, (error: unknown) => error as { code?: string; details?: Record<string, unknown> });
      expect(refused?.code).toBe("store.operation-conflict");
      expect(refused?.details?.differing_fields).toEqual(["destinationAuthority", "destinationProject", "reason"]);
      // invariant: Neither lane gained a copy of the payload and the record is untouched.
      expect(recordImage(db, issueId)).toEqual(before);
      expect(await readCollaborationStage(elsewhere.location, ({ db: lane }) => readIssueMove(lane, "move-bound", "destination")))
        .toBeNull();
      expect(readIssueMove(db, "move-bound", "source")?.phase).toBe("staged");
    } finally {
      db.close();
    }
  }, 60_000);

  test("a terminal row read under a different request refuses instead of reporting its result", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const request = {
        operationId: "move-terminal-bound",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "finish",
      };
      await moveAcrossAuthorities(context, request);
      const refused = await moveAcrossAuthorities(context, { ...request, destinationProject: "p-elsewhere" }).then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
      expect(refused?.code).toBe("store.operation-conflict");
    } finally {
      db.close();
    }
  }, 60_000);

  test("a destination collision refuses before the switch when its record is not the frozen copy", async () => {
    // invariant: Finding 3 — publication deletes the source, so an existing destination record under
    // the same reference must BE the frozen copy. Older content must refuse while the source is still
    // the member, never be adopted and then lose the history the move carried.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      // note: A destination record that already holds this record's reference, with different content.
      const carriedRef = readIssueMoveReference(db, issueId);
      await writeCollaborationStage(destination.location, ({ db: lane }) => {
        lane.prepare(
          "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, " +
            "updated_at, identity_key, issue_ref) values ('I-000009', 'p-dest', 'Older copy', 'bug', 'low', 'open', " +
            "'i', 'a', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 'older-key', ?)",
        ).run(carriedRef);
      });
      const refused = await moveAcrossAuthorities(context, {
        operationId: "move-collision",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "collision",
      }).then(() => null, (error: unknown) => error as { code?: string; details?: Record<string, unknown> });
      expect(refused?.code).toBe("collaboration.move-destination-occupied");
      expect(refused?.details?.differing_sections).toContain("title");
      // invariant: The source is still the member and still writable-by-ledger, nothing was switched.
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-collision", "source")?.phase).toBe("verified");
      // note: The occupied destination record keeps its own content.
      expect(await readCollaborationStage(destination.location, ({ db: lane }) =>
        lane.prepare("select title from issues where id = 'I-000009'").get())).toEqual({ title: "Older copy" });
    } finally {
      db.close();
    }
  }, 60_000);

  test("an identical destination copy under the same reference is adopted, not re-inserted", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const request = {
        operationId: "move-adopt",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "adopt",
      };
      await moveAcrossAuthorities(context, request, "switched");
      // note: Drop the destination's own bookkeeping so the admission runs again over a record that
      // is already there, holding exactly what the move carried.
      await writeCollaborationStage(destination.location, ({ db: lane }) => {
        lane.prepare("delete from issue_moves where role = 'destination'").run();
      });
      const resumed = await moveAcrossAuthorities(context, request);
      expect(resumed.phase).toBe("published");
      const admitted = await readCollaborationStage(destination.location, ({ db: lane }) => ({
        issues: lane.prepare("select count(*) as n from issues").get(),
        occurrences: lane.prepare("select count(*) as n from occurrences").get(),
      }));
      expect(admitted).toEqual({ issues: { n: 1 }, occurrences: { n: 2 } });
      expect(db.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("a switched source that never admitted is discardable, and the record comes back", async () => {
    // invariant: Finding 6 — the supported recovery for a switched-but-unadmitted source. Without it
    // the record is presented by neither lane and writable by neither, which is a permanent block.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const request = {
        operationId: "move-stranded",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "stranded",
      };
      await moveAcrossAuthorities(context, request, "switched");
      await writeCollaborationStage(destination.location, ({ db: lane }) => {
        lane.prepare("delete from issue_moves where role = 'destination'").run();
      });
      const discarded = await discardMove(context, request);
      expect(discarded).toMatchObject({ phase: "discarded", resumedFrom: "switched" });
      expect(recordImage(db, issueId)).toEqual(before);
      expect(blockingMoveFor(db, issueId)).toBeNull();
      db.prepare("update issues set title = 'writable again' where id = ?").run(issueId);
      await expect(getIssue(context, issueId)).resolves.toMatchObject({ id: issueId });
    } finally {
      db.close();
    }
  }, 60_000);

  test("discard refuses a move the destination already admitted", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const request = {
        operationId: "move-admitted-discard",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "admitted",
      };
      await moveAcrossAuthorities(context, request, "switched");
      const before = recordImage(db, issueId);
      const refused = await discardMove(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("collaboration.move-phase-invalid");
      expect(refused?.details).toMatchObject({ allowed: ["published"] });
      // invariant: The admitted member stays a member and the source stays exactly as it was.
      expect(recordImage(db, issueId)).toEqual(before);
      expect(await readCollaborationStage(destination.location, ({ db: lane }) =>
        lane.prepare("select count(*) as n from issues").get())).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("a crash between the discard commit and the destination delete is finished by the same command", async () => {
    // invariant: Finding 7 — discard commits the source first, then deletes the destination staging.
    // A process loss between those two commits leaves a terminal row whose cleanup only a replay sees.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const request = {
        operationId: "move-discard-crash",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "crash",
      };
      await stageMove(context, request);
      const recorded = readIssueMove(db, "move-discard-crash", "source")!;
      // note: The state the crash leaves: source `discarded` and the destination staging still present.
      // Discarding deletes the staging, so the row is put back exactly as the interrupted run left it.
      await discardMove(context, request);
      await writeCollaborationStage(destination.location, ({ db: lane }) => {
        recordIssueMove(lane, { ...recorded, role: "destination", phase: "staged" });
      });
      expect(await readCollaborationStage(destination.location, ({ db: lane }) =>
        lane.prepare("select count(*) as n from issue_moves").get())).toEqual({ n: 1 });
      const replayed = await moveAcrossAuthorities(context, request);
      expect(replayed).toMatchObject({ phase: "discarded", resumedFrom: "discarded" });
      // invariant: The replay finished the idempotent destination deletion; the source never changed.
      expect(await readCollaborationStage(destination.location, ({ db: lane }) =>
        lane.prepare("select count(*) as n from issue_moves").get())).toEqual({ n: 0 });
      expect(recordImage(db, issueId)).toEqual(before);
    } finally {
      db.close();
    }
  }, 60_000);

  test("a destination record inserted after the preflight is refused at admission, never adopted", async () => {
    // invariant: Critical 1 — the preflight read is not the admission predicate. A record another
    // destination writer inserts under the same reference between them must be compared with the
    // frozen copy inside the admission transaction, so the source history is never deleted for it.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const carriedRef = readIssueMoveReference(db, issueId);
      const request = {
        operationId: "move-race-occupant",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "race",
      };
      await stageMove(context, request);
      await verifyMove(context, request);
      setMoveGapForTest(async (point) => {
        if (point !== "switch") return;
        await writeCollaborationStage(destination.location, ({ db: lane }) => {
          lane.prepare(
            "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, " +
              "updated_at, identity_key, issue_ref) values ('I-000009', 'p-dest', 'Late occupant', 'bug', 'low', 'open', " +
              "'i', 'a', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 'late-key', ?)",
          ).run(carriedRef);
        });
      });
      const refused = await switchMove(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("collaboration.move-destination-occupied");
      expect(refused?.details?.differing_sections).toContain("title");
      // invariant: The source is still here with every row it carried, and the occupant keeps its own
      // content; nothing was adopted and nothing was deleted for it.
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-race-occupant", "source")?.phase).toBe("switched");
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) => ({
          occupant: lane.prepare("select title from issues where id = 'I-000009'").get(),
          issues: lane.prepare("select count(*) as n from issues").get(),
        })),
      ).toEqual({ occupant: { title: "Late occupant" }, issues: { n: 1 } });
      // invariant: The switched-but-unadmitted record is not stranded: discard restores it.
      expect(await discardMove(context, request)).toMatchObject({ phase: "discarded", resumedFrom: "switched" });
      expect(recordImage(db, issueId)).toEqual(before);
      expect(blockingMoveFor(db, issueId)).toBeNull();
      db.prepare("update issues set title = 'writable again' where id = ?").run(issueId);
    } finally {
      setMoveGapForTest(undefined);
      db.close();
    }
  }, 60_000);

  test("an admission that commits while a discard reads leaves one member, not two", async () => {
    // invariant: Critical 2, order one — the switch admits after the discard's read. The discard's
    // claim re-checks inside the destination transaction and refuses, so the record stays a member
    // and the source is never restored beside it.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const request = {
        operationId: "move-race-admit-wins",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "race",
      };
      await stageMove(context, request);
      await verifyMove(context, request);
      let fired = false;
      setMoveGapForTest(async (point) => {
        if (point !== "discard" || fired) return;
        fired = true;
        await switchMove(context, request);
      });
      const refused = await discardMove(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("collaboration.move-phase-invalid");
      expect(refused?.details).toMatchObject({ allowed: ["published"] });
      expect(readIssueMove(db, "move-race-admit-wins", "source")?.phase).toBe("switched");
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) => ({
          issues: lane.prepare("select count(*) as n from issues").get(),
          row: readIssueMove(lane, "move-race-admit-wins", "destination"),
        })),
      ).toMatchObject({ issues: { n: 1 }, row: { phase: "switched", destinationIssueId: "I-000001" } });
      // invariant: Publishing the admitted move is the only completion, and it leaves one member.
      expect(await publishMove(context, request)).toBeUndefined();
      expect(db.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
      expect(readIssueMove(db, "move-race-admit-wins", "source")?.phase).toBe("published");
    } finally {
      setMoveGapForTest(undefined);
      db.close();
    }
  }, 60_000);

  test("a discard that commits before the admission refuses the switch and restores the record", async () => {
    // invariant: Critical 2, order two — the discard claims and commits between the switch's preflight
    // and its source transition. The claim makes the source transition illegal, so the admission never
    // lands and the record is restored with no destination member.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const request = {
        operationId: "move-race-discard-wins",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "race",
      };
      await stageMove(context, request);
      await verifyMove(context, request);
      let fired = false;
      setMoveGapForTest(async (point) => {
        if (point !== "switch" || fired) return;
        fired = true;
        await discardMove(context, request);
      });
      const refused = await switchMove(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
      expect(refused?.code).toBe("collaboration.move-phase-invalid");
      // invariant: No member was admitted and the record is exactly as it was before the move.
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) => ({
          issues: lane.prepare("select count(*) as n from issues").get(),
          rows: lane.prepare("select count(*) as n from issue_moves").get(),
        })),
      ).toEqual({ issues: { n: 0 }, rows: { n: 0 } });
      expect(recordImage(db, issueId)).toEqual(before);
      expect(blockingMoveFor(db, issueId)).toBeNull();
      expect(db.prepare("update issues set title = 'writable again' where id = ?").run(issueId) as { changes?: number }).toMatchObject({ changes: 1 });
      // invariant: The same command reports the finished discard instead of retrying the switch.
      await expect(getIssue(context, issueId)).resolves.toMatchObject({ id: issueId });
    } finally {
      setMoveGapForTest(undefined);
      db.close();
    }
  }, 60_000);

  test("an identity another writer inserts after the preflight refuses the admission too", async () => {
    // invariant: Critical 1 — the predicate the admission transaction re-runs is the WHOLE one, so a
    // colliding identity key inserted in the same window refuses exactly like a differing image.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const request = {
        operationId: "move-race-identity",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "race",
      };
      await stageMove(context, request);
      await verifyMove(context, request);
      setMoveGapForTest(async (point) => {
        if (point !== "switch") return;
        await writeCollaborationStage(destination.location, ({ db: lane }) => {
          lane.prepare(
            "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, " +
              "updated_at, identity_key, issue_ref) values ('I-000010', 'p-dest', 'Identity rival', 'bug', 'low', 'open', " +
              "'i', 'a', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', ?, " +
              "'mstar:issue:99999999-9999-4999-8999-999999999999')",
          ).run(computeIdentityKey("p-dest", "review/move", "root-move", "accept-move"));
        });
      });
      const refused = await switchMove(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("issue.ambiguous-identity");
      expect(refused?.details?.collidingIssueId).toBe("I-000010");
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-race-identity", "source")?.phase).toBe("switched");
      expect(await discardMove(context, request)).toMatchObject({ phase: "discarded", resumedFrom: "switched" });
      expect(blockingMoveFor(db, issueId)).toBeNull();
    } finally {
      setMoveGapForTest(undefined);
      db.close();
    }
  }, 60_000);

  test("a crash after the discard claim is finished by the same command", async () => {
    // invariant: The claim commits before the source transition. A process loss between them leaves a
    // claimed destination and a still-frozen source; the same command finishes the discard instead of
    // staging or verifying over the decision.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const request = {
        operationId: "move-claim-crash",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "claim crash",
      };
      await stageMove(context, request);
      await verifyMove(context, request);
      // note: The exact state a crash between the claim and the source commit leaves behind.
      await writeCollaborationStage(destination.location, ({ db: lane }) => {
        advanceIssueMove(lane, { operationId: "move-claim-crash", role: "destination", from: "verified", to: "discarded" });
      });
      const replayed = await moveAcrossAuthorities(context, request);
      expect(replayed).toMatchObject({ phase: "discarded", resumedFrom: "verified" });
      expect(recordImage(db, issueId)).toEqual(before);
      expect(blockingMoveFor(db, issueId)).toBeNull();
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) =>
          lane.prepare("select count(*) as n from issue_moves").get(),
        ),
      ).toEqual({ n: 0 });
      db.prepare("update issues set title = 'writable again' where id = ?").run(issueId);
    } finally {
      db.close();
    }
  }, 60_000);

  test("a crash at the freeze cannot leave a staged row whose revision never advanced", async () => {
    // invariant: Critical 3 — the freeze and the lane revision advance are one commit. The injected
    // crash is that transaction's own last statement, so a build that advanced the revision in a
    // later transaction would leave the staged row behind and this read would find it.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
      const observed = laneRevision(db);
      const request = {
        operationId: "move-freeze-atomic",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "atomic",
      };
      db.exec("create trigger injected_revision_crash before update on collaboration_meta begin select raise(abort, 'injected crash'); end");
      const failed = await moveAcrossAuthorities(context, request).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failed).not.toBeNull();
      // invariant: Neither the row nor the revision landed, and the record is untouched.
      expect(readIssueMove(db, "move-freeze-atomic", "source")).toBeNull();
      expect(laneRevision(db)).toBe(observed);
      expect(recordImage(db, issueId)).toEqual(before);
      expect(blockingMoveFor(db, issueId)).toBeNull();
      db.exec("drop trigger injected_revision_crash");
      // invariant: The corrected run stages under the SAME operation id.
      expect((await moveAcrossAuthorities(context, request)).phase).toBe("published");
      expect(db.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("a discard is admitted by role, and only where both ledger halves are open", async () => {
    // invariant: This branch ships no two-checkout exchange, so a discard releases both halves only
    // when this checkout can open both: the SOURCE checkout of a one-checkout move. Every other role
    // and every unreachable peer refuses with the cause and the recovery the operator can actually
    // run, instead of falling through to `discardMove` or claiming a remote boundary.
    const requestFor = (operationId: string, issueId: string, destinationAuthority: string) => ({
      operationId,
      actor: "project-manager",
      sourceIssueId: issueId,
      destinationAuthority,
      destinationProject: "p-dest",
      reason: "abandon",
    });
    const refusalOf = (action: Promise<unknown>) =>
      action.then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string; details?: Record<string, unknown> },
      );

    // note: Source checkout, peer lane present: the one topology a discard releases here.
    {
      const { context, db } = await sourceCheckout();
      try {
        const destination = await destinationLane("p-dest");
        const issueId = await seededRecord(context, db, "p-source");
        const before = recordImage(db, issueId);
        const request = requestFor(`move-discard-router-${String(engineSequence)}`, issueId, destination.repoKey);
        await stageMove(context, request);
        expect(await discardAcrossAuthorities(context, request)).toMatchObject({ phase: "discarded", resumedFrom: "staged" });
        expect(recordImage(db, issueId)).toEqual(before);
        expect(blockingMoveFor(db, issueId)).toBeNull();
        expect(
          await readCollaborationStage(destination.location, ({ db: lane }) =>
            lane.prepare("select count(*) as n from issue_moves").get(),
          ),
        ).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    }

    // note: Source checkout, peer lane absent: the other half lives in a separate home, so the
    // refusal names that cause and the layer that would release it — never an init recovery.
    {
      const { context, db } = await sourceCheckout();
      try {
        const destination = await destinationLane("p-dest");
        const issueId = await seededRecord(context, db, "p-source", "-peer");
        const before = recordImage(db, issueId);
        const request = requestFor(`move-discard-peer-${String(engineSequence)}`, issueId, destination.repoKey);
        await stageMove(context, request);
        rmSync(destination.location.dbPath, { force: true });
        const refused = await refusalOf(discardAcrossAuthorities(context, request));
        expect(refused?.code).toBe("collaboration.mode-unavailable");
        expect(refused?.details).toMatchObject({ operation_id: request.operationId, role: "source" });
        expect(String(refused?.message)).toContain(`no readable lane for ${destination.repoKey}`);
        expect(String(refused?.message)).not.toContain("spans a `local`/`remote` boundary");
        expect(String(refused?.details?.recovery)).toContain("two-checkout exchange");
        // invariant: Neither half moved: the record is still frozen by its staged source row.
        expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("staged");
        expect(recordImage(db, issueId)).toEqual(before);
        expect(blockingMoveFor(db, issueId)?.phase).toBe("staged");
      } finally {
        db.close();
      }
    }

    // note: A damaged peer lane is not an absent one — the probe cannot classify it, and the
    // refusal must report exactly that ("no readable lane", not "no lane exists") so the operator
    // never reads a delete as a never-staged.
    {
      const { context, db } = await sourceCheckout();
      try {
        const destination = await destinationLane("p-dest");
        const issueId = await seededRecord(context, db, "p-source", "-peer-dmg");
        const before = recordImage(db, issueId);
        const request = requestFor(`move-discard-dmg-${String(engineSequence)}`, issueId, destination.repoKey);
        await stageMove(context, request);
        writeFileSync(destination.location.dbPath, "not a sqlite file");
        const refused = await refusalOf(discardAcrossAuthorities(context, request));
        expect(refused?.code).toBe("collaboration.mode-unavailable");
        expect(refused?.details).toMatchObject({ operation_id: request.operationId, role: "source" });
        expect(String(refused?.message)).toContain(`no readable lane for ${destination.repoKey}`);
        expect(String(refused?.message)).toContain("absent or unclassifiable");
        expect(String(refused?.message)).not.toContain("no lane");
        expect(String(refused?.message)).not.toContain("exists");
        expect(String(refused?.details?.recovery)).toContain("two-checkout exchange");
        expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("staged");
        expect(recordImage(db, issueId)).toEqual(before);
      } finally {
        db.close();
      }
    }

    // note: The destination checkout never holds the source half, so its refusal points at the
    // source checkout by name — the one place the discard can run.
    {
      const { context, db } = await sourceCheckout();
      const peer = await sourceCheckout();
      try {
        peer.db
          .prepare(
            "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) " +
              "values ('project', 'p-dest', 'p-dest', 'projects', 'projects/p-dest', '2026-11-21T00:00:00.000Z', " +
              "'2026-11-21T00:00:00.000Z')",
          )
          .run();
        const issueId = await seededRecord(context, db, "p-source", "-dest");
        const request = requestFor(`move-discard-dest-${String(engineSequence)}`, issueId, peer.repoKey);
        await stageMove(context, request);
        const refused = await refusalOf(discardAcrossAuthorities(peer.context, request));
        expect(refused?.code).toBe("collaboration.mode-unavailable");
        expect(refused?.details).toMatchObject({
          operation_id: request.operationId,
          role: "destination",
          source_authority: resolveCollaborationLocation(context).repoKey,
        });
        expect(String(refused?.details?.recovery)).toContain(
          `source checkout of ${resolveCollaborationLocation(context).repoKey}`,
        );
        // invariant: The source row still freezes the record and the destination row is untouched.
        expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("staged");
        expect(
          await readCollaborationStage(resolveCollaborationLocation(peer.context), ({ db: lane }) =>
            readIssueMove(lane, request.operationId, "destination"),
          ),
        ).toMatchObject({ phase: "staged" });
      } finally {
        peer.db.close();
        db.close();
      }
    }

    // note: A destination checkout whose own lane does not open still names no authority to blame,
    // so its recovery falls back to "the move's source checkout".
    {
      const { context, db } = await sourceCheckout();
      const peer = await sourceCheckout();
      try {
        peer.db
          .prepare(
            "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) " +
              "values ('project', 'p-dest', 'p-dest', 'projects', 'projects/p-dest', '2026-11-21T00:00:00.000Z', " +
              "'2026-11-21T00:00:00.000Z')",
          )
          .run();
        const issueId = await seededRecord(context, db, "p-source", "-dest-gone");
        const request = requestFor(`move-discard-dest-gone-${String(engineSequence)}`, issueId, peer.repoKey);
        await stageMove(context, request);
        unlinkSync(resolveCollaborationLocation(peer.context).dbPath);
        const refused = await refusalOf(discardAcrossAuthorities(peer.context, request));
        expect(refused?.code).toBe("collaboration.mode-unavailable");
        expect(refused?.details).toMatchObject({ operation_id: request.operationId, role: "destination" });
        expect(refused?.details?.source_authority).toBeUndefined();
        expect(String(refused?.details?.recovery)).toContain("source checkout");
        expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("staged");
      } finally {
        peer.db.close();
        db.close();
      }
    }
  }, 120_000);

  test("a discard of a never-recorded move names its id and the staging checkout, never 'start the move'", async () => {
    // invariant: The no-such-move refusal is step-shaped: a discard abandons a move, so its recovery
    // is the recorded operation id and the checkout that staged it — "start the move" would publish
    // a record under a fresh id and still leave nothing to discard.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const request = {
        operationId: "move-never-staged",
        actor: "project-manager",
        sourceIssueId: "I-009999",
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "abandon",
      };
      const refused = await discardAcrossAuthorities(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("collaboration.move-phase-invalid");
      expect(refused?.details).toMatchObject({ operation_id: request.operationId });
      const recovery = String(refused?.details?.recovery);
      expect(recovery).toContain("Reissue this --discard from the checkout that ran the move");
      expect(recovery).toContain("--operation-id you used");
      // invariant: Every artifact the recovery names exists in this layer: there is no --stage run,
      // no receipt, no --out flag and no operator-readable move ledger, so none may be named.
      expect(recovery).not.toContain("staging run");
      expect(recovery).not.toContain("receipt");
      expect(recovery).not.toContain("--out");
      expect(recovery).not.toContain("ledger");
      expect(recovery).not.toContain("Start the move");
    } finally {
      db.close();
    }
  }, 60_000);

  test("a remote checkout's discard names the source checkout, never 'remote bind'", async () => {
    // invariant: A remote checkout holds a verified cache, never the ledger lane a discard writes;
    // its refusal must name the source checkout that holds the half, because a reviewed remote bind
    // would still not put the move's ledger half in this checkout.
    const remote = remoteCheckout();
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source", "-remote");
      const request = {
        operationId: `move-discard-remote-${String(engineSequence)}`,
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "abandon",
      };
      await stageMove(context, request);
      const refused = await discardAcrossAuthorities(remote.context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("collaboration.mode-unavailable");
      expect(refused?.details).toMatchObject({ operation_id: request.operationId, role: "source" });
      expect(String(refused?.message)).toContain(`remote cache for ${remote.repoKey}`);
      const recovery = String(refused?.details?.recovery);
      expect(recovery).toContain("source checkout that staged the move");
      expect(recovery).toContain("ledger half");
      expect(recovery).not.toContain("bind");
      // invariant: The remote checkout's lane is untouched and the source row still freezes the record.
      expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("staged");
    } finally {
      db.close();
    }
  }, 120_000);

  test("publication refuses an incoming relation that landed after the freeze", async () => {
    // invariant: The frozen incoming count is the ceiling publication enforces. A writer path that
    // never meets the lane's insert fence must not be able to publish the record with an edge the
    // staged copy never carried: the rewrite is compared against `relationsLeftBehind` recorded at
    // stage, not against a count this same transaction just read.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const late = await seededRecord(context, db, "p-source", "-late");
      const request = {
        operationId: "move-late-edge",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "late edge",
      };
      await moveAcrossAuthorities(context, request, "switched");
      const before = recordImage(db, issueId);
      const counts = JSON.parse(readIssueMove(db, request.operationId, "source")!.stagedCounts) as {
        relationsLeftBehind: number;
      };
      expect(counts.relationsLeftBehind).toBe(0);
      const edge = db.prepare("insert into relations(from_issue, relation, to_issue) values (?, 'blocks', ?)");
      // invariant: The lane's own insert fence refuses the edge while the record is frozen …
      expect(() => edge.run(late, issueId)).toThrow(/issue\.move-in-progress/);
      // note: … and the publication's frozen-count check is the second line: a writer that bypasses
      // the fence (here by dropping it) still cannot publish the edge.
      db.exec("drop trigger relations_move_guard_insert");
      edge.run(late, issueId);
      const refused = await publishMove(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("collaboration.operation-partial");
      expect(String(refused?.message)).toContain("landed while the move was in flight");
      expect(refused?.details).toMatchObject({ expected: 0, rewritten: 1 });
      // invariant: The whole publication rolled back: the record is still the member here and the
      // mid-flight edge still names it.
      expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("switched");
      expect(recordImage(db, issueId)).toEqual(before);
      expect(db.prepare("select count(*) as n from relations where to_issue = ?").get(issueId)).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("a second request under the same operation id refuses instead of staging the first payload", async () => {
    // invariant: Critical 4 (concurrency) — a writer callback that finds a row must bind the COMPLETE
    // request under the lock. Two first uses of one id cannot stage the first payload into the
    // second request's destination.
    const { context, db } = await sourceCheckout();
    try {
      const first = await destinationLane("p-first");
      const second = await destinationLane("p-second");
      const issueId = await seededRecord(context, db, "p-source");
      const original = {
        operationId: "move-two-writers",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: first.repoKey,
        destinationProject: "p-first",
        reason: "first",
      };
      let fired = false;
      setMoveGapForTest(async (point) => {
        if (point !== "stage" || fired) return;
        fired = true;
        await stageMove(context, original);
      });
      const refused = await moveAcrossAuthorities(context, {
        ...original,
        destinationAuthority: second.repoKey,
        destinationProject: "p-second",
        reason: "second",
      }).then(() => null, (error: unknown) => error as { code?: string; details?: Record<string, unknown> });
      expect(refused?.code).toBe("store.operation-conflict");
      expect(refused?.details?.differing_fields).toEqual(["destinationAuthority", "destinationProject", "reason"]);
      // invariant: The second destination never received a copy, and the ledger still records the
      // request that actually staged.
      expect(
        await readCollaborationStage(second.location, ({ db: lane }) =>
          lane.prepare("select count(*) as n from issue_moves").get(),
        ),
      ).toEqual({ n: 0 });
      expect(readIssueMove(db, "move-two-writers", "source")).toMatchObject({
        phase: "staged",
        destinationProject: "p-first",
        reason: "first",
      });
    } finally {
      setMoveGapForTest(undefined);
      db.close();
    }
  }, 60_000);

  test("a changed reason or actor on replay refuses and the membership keeps the staged reason", async () => {
    // invariant: Critical 4 (binding) — `reason` and `actor` are immutable request fields. A replay
    // that changes either refuses instead of rewriting what admission records, and the membership
    // project-move row carries the reason the request was staged with.
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const request = {
        operationId: "move-reason-bound",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "the staged reason",
      };
      await stageMove(context, request);
      const changedReason = await moveAcrossAuthorities(context, { ...request, reason: "another reason" }).then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
      expect(changedReason?.code).toBe("store.operation-conflict");
      expect(changedReason?.details?.differing_fields).toEqual(["reason"]);
      const changedActor = await moveAcrossAuthorities(context, { ...request, actor: "someone-else" }).then(
        () => null,
        (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
      );
      expect(changedActor?.code).toBe("store.operation-conflict");
      expect(changedActor?.details?.differing_fields).toEqual(["actor"]);
      expect(readIssueMove(db, "move-reason-bound", "source")).toMatchObject({
        phase: "staged",
        reason: "the staged reason",
        actor: "project-manager",
      });
      // invariant: The recorded request still completes, and the membership says what it was staged with.
      expect((await moveAcrossAuthorities(context, request)).phase).toBe("published");
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) =>
          lane.prepare("select to_project_id, actor, reason from issue_project_moves").all(),
        ),
      ).toEqual([{ to_project_id: "p-dest", actor: "project-manager", reason: "the staged reason" }]);
    } finally {
      db.close();
    }
  }, 60_000);

  test("trigger and switched-read refusals name a command that runs as written", async () => {
    // invariant: Finding 5 — a recovery the operator cannot run is not a recovery. Both refusals must
    // name the recorded source id, the recorded destination, both required revisions, the recorded
    // actor and reason, and every argument must survive the shell as one argument.
    const { context, db } = await sourceCheckout();
    try {
      const project = "p-dest'quote";
      const destination = await destinationLane(project);
      const issueId = await seededRecord(context, db, "p-source");
      const operationId = "move-rec-o'v\"b\\x";
      const request = {
        operationId,
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: project,
        reason: "a reason with 'quotes' and \"double\" and \\slash",
      };
      const bin = join(ROOT, "fake-bin");
      mkdirSync(bin, { recursive: true });
      const argsFile = join(bin, "args");
      writeFileSync(
        join(bin, "mstar"),
        '#!/bin/sh\n: > "$MSTAR_ARGS"\nfor arg in "$@"; do printf \'%s\\n\' "$arg" >> "$MSTAR_ARGS"; done\n',
      );
      chmodSync(join(bin, "mstar"), 0o755);
      const run = (command: string): string[] => {
        writeFileSync(argsFile, "");
        execFileSync("/bin/sh", ["-c", command], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, MSTAR_ARGS: argsFile },
          stdio: "pipe",
        });
        const raw = readFileSync(argsFile, "utf8");
        return raw === "" ? [] : raw.slice(0, -1).split("\n");
      };
      const expected = (issueRevision: number, storeRevision: number): string[] => [
        "issue",
        "move",
        "--id",
        issueId,
        "--to-authority",
        destination.repoKey,
        "--payload",
        JSON.stringify({ projectId: project, reason: request.reason }),
        "--expect",
        String(issueRevision),
        "--expect-store",
        String(storeRevision),
        "--actor",
        "project-manager",
        "--operation-id",
        operationId,
      ];

      const expectedDiscard = (issueRevision: number): string[] => [
        "issue",
        "move",
        "--id",
        issueId,
        "--to-authority",
        destination.repoKey,
        "--payload",
        JSON.stringify({ projectId: project, reason: request.reason }),
        "--expect",
        String(issueRevision),
        "--actor",
        "project-manager",
        "--operation-id",
        operationId,
        "--discard",
      ];

      await stageMove(context, request);
      const frozen = await appendOccurrence(
        context,
        issueId,
        {
          sourceIdentity: "review/move",
          rootCauseKey: "root-move",
          acceptanceKey: "accept-move",
          occurrenceKey: "occ-recovery",
          sourceKind: "test",
          location: "src/e.ts",
          observedBehavior: "observed",
          evidence: [],
          discoveredAt: "2026-11-21T00:00:03.000Z",
        },
        { actor: "project-manager", operationId: "occurrence-recovery" },
      ).then(() => null, (error: unknown) => error as { details?: Record<string, unknown> });
      const triggerCommand = String(frozen?.details?.recovery);
      const commands = triggerCommand.match(/`([^`]+)`/g)?.map((quoted) => quoted.slice(1, -1)) ?? [];
      expect(commands.length).toBe(2);
      expect(run(commands[0]!)).toEqual(expected(laneIssueRevision(db, issueId), laneRevision(db)));
      // invariant: The discard command must run as written: `--expect-store` is refused under
      // `--discard`, so it is the one flag the abandonment command cannot carry.
      expect(run(commands[1]!)).toEqual(expectedDiscard(laneIssueRevision(db, issueId)));

      await moveAcrossAuthorities(context, request, "switched");
      const read = await getIssue(context, issueId).then(
        () => null,
        (error: unknown) => error as { details?: Record<string, unknown> },
      );
      const readCommand = String(read?.details?.recovery);
      expect(run(readCommand.match(/`([^`]+)`/)?.[1] ?? readCommand)).toEqual(
        expected(laneIssueRevision(db, issueId), laneRevision(db)),
      );
    } finally {
      db.close();
    }
  }, 60_000);
});

describe("cross-authority move package surface", () => {
  test("the package publishes the move routes it documents and keeps the phase engine internal", async () => {
    // invariant: The export block's comment is the contract. A consumer may call the two routes, the
    // discard and the phase engine's terminal steps; the per-lane steps and the ledger primitives are
    // internal to the module, so a later change cannot grow the public surface by accident and no
    // comment has to deny what the block publishes.
    const surface = (await import("./index.js")) as unknown as Record<string, unknown>;
    for (const name of [
      "discardAcrossAuthorities",
      "discardMove",
      "moveAcrossAuthorities",
    ]) {
      expect(typeof surface[name]).toBe("function");
    }
    for (const name of [
      "advanceIssueMove",
      "assertMoveTransition",
      "assertPresented",
      "assertRecordWritable",
      "blockingMoveFor",
      "blockingMoveForRef",
      "frozenMoveRefusal",
      "isForwardMoveTransition",
      "publishMove",
      "readIssueMove",
      "recordIssueMove",
      "stageMove",
      "stagedMismatch",
      "switchMove",
      "switchedMoveFor",
      "verifyMove",
    ]) {
      expect(surface[name]).toBeUndefined();
    }
  });
});
