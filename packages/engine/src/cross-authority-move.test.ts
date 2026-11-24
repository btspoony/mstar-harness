/**
 * why: The move ledger and the lane's fence. These cases prove the three facts no calling path can
 * be trusted to state: the table itself refuses a relation with both targets null or both set, a
 * move row advances only along the forward set, and the source row freezes its record from
 * `staged` on through triggers stored in the lane rather than through calling code.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  moveAcrossAuthorities,
  publishMove,
  readIssueMove,
  recordIssueMove,
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
import { discardMove } from "./cross-authority-move.js";
import { appendOccurrence, captureIssue, getIssue, linkIssue } from "./issue.js";
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

/** note: A captured record with two occurrences, one transition, one provenance row and a settled mirror row. */
async function seededRecord(context: StoreContext, db: StoreDb, projectId: string): Promise<string> {
  const receipt = await captureIssue(
    context,
    {
      projectId,
      title: "Moving finding",
      kind: "bug",
      severity: "high",
      impact: "impact",
      acceptance: "acceptance",
      sourceIdentity: "review/move",
      rootCauseKey: "root-move",
      acceptanceKey: "accept-move",
      occurrenceKey: "occ-move-1",
      sourceKind: "test",
      location: "src/a.ts",
      observedBehavior: "fails",
      evidence: ["repro"],
      discoveredAt: "2026-11-21T00:00:00.000Z",
    },
    { actor: "project-manager", operationId: `capture-${String(engineSequence)}` },
  );
  await appendOccurrence(
    context,
    receipt.issueId,
    {
      sourceIdentity: "review/move",
      rootCauseKey: "root-move",
      acceptanceKey: "accept-move",
      occurrenceKey: "occ-move-2",
      sourceKind: "test",
      location: "src/b.ts",
      observedBehavior: "fails again",
      evidence: [],
      discoveredAt: "2026-11-21T00:00:01.000Z",
    },
    { actor: "project-manager", operationId: `occurrence-${String(engineSequence)}` },
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
});
