/**
 * why: The move ledger and the lane's fence. These cases prove the three facts no calling path can
 * be trusted to state: the table itself refuses a relation with both targets null or both set, a
 * move row advances only along the forward set, and the source row freezes its record from
 * `staged` on through triggers stored in the lane rather than through calling code.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  isForwardMoveTransition,
  readIssueMove,
  recordIssueMove,
  type IssueMovePhase,
} from "./cross-authority-move.js";
import { COLLABORATION_MIGRATIONS, applyCollaborationLadder, initializeCollaborationStore } from "./collaboration-store.js";
import { collaborationLocationOfRepoKey } from "./collaboration-identity.js";
import { SCHEMA_VERSION_TABLE_SQL, migrationChecksum, type StoreDb } from "./store-db.js";

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
    expect(isForwardMoveTransition("switched", "discarded")).toBe(false);
    expect(isForwardMoveTransition("published", "discarded")).toBe(false);
    expect(isForwardMoveTransition("verified", "staged")).toBe(false);
    expect(() => assertMoveTransition("switched", "verified")).toThrow(/collaboration\.move-phase-invalid/);
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
