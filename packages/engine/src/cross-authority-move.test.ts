import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  exchangeLocalToRemote,
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
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});

afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

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

function sourceRow(
  issueRef: string,
  phase: IssueMovePhase,
  operationId = "move-one",
): Parameters<typeof recordIssueMove>[1] {
  return {
    operationId,
    role: "source",
    route: "local-local",
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
    expect(isForwardMoveTransition("staged", "verified")).toBe(true);
    expect(isForwardMoveTransition("verified", "switched")).toBe(true);
    expect(isForwardMoveTransition("switched", "published")).toBe(true);
    expect(isForwardMoveTransition("staged", "discarded")).toBe(true);
    expect(isForwardMoveTransition("verified", "discarded")).toBe(true);
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

      expect(() =>
        advanceIssueMove(db, { operationId: "move-one", role: "source", from: "staged", to: "published" }),
      ).toThrow(/collaboration\.move-phase-invalid/);
      expect(readIssueMove(db, "move-one", "source")?.phase).toBe("staged");

      expect(
        advanceIssueMove(db, { operationId: "move-one", role: "source", from: "staged", to: "verified" }).phase,
      ).toBe("verified");
      expect(() =>
        advanceIssueMove(db, { operationId: "move-one", role: "source", from: "staged", to: "verified" }),
      ).toThrow(/not staged/);
      expect(readIssueMove(db, "move-one", "source")?.phase).toBe("verified");
    } finally {
      db.close();
    }
  });

  test("a corrupt ledger count is refused as corrupt instead of resuming from a guessed zero", async () => {
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

      db.exec(`
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key, issue_ref)
values ('I-000002', 'p-one', 'Second finding', 'risk', 'low', 'open', 'i', 'a', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'fence-key', 'mstar:issue:22222222-2222-4222-8222-222222222222');
insert into relations(from_issue, relation, to_issue) values ('I-000001', 'related', 'I-000002');
insert into issue_sync_state(binding_id, direction, local_id, item_state, revision, updated_at)
values ('linear:p-one', 'push', 'I-000001', 'pending', 1, '2026-11-21T00:00:00.000Z');
`);

      recordIssueMove(db, sourceRow("mstar:issue:11111111-1111-4111-8111-111111111111", "staged"));
      expect(blockingMoveFor(db, "I-000001")).toEqual({ operationId: "move-one", phase: "staged" });

      expect(() => db.prepare("update issues set title = 'edited' where id = 'I-000001'").run()).toThrow(
        /issue\.move-in-progress/,
      );
      expect(() => db.prepare("delete from issues where id = 'I-000001'").run()).toThrow(/issue\.move-in-progress/);
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
      expect(() =>
        db.prepare("insert into relations(from_issue, relation, to_issue) values ('I-000002', 'blocks', 'I-000001')").run(),
      ).toThrow(/issue\.move-in-progress/);
      expect(() =>
        db.prepare("update relations set relation = 'blocks' where from_issue = 'I-000001'").run(),
      ).toThrow(/issue\.move-in-progress/);
      expect(() =>
        db.prepare("insert into issue_sync_state(binding_id, direction, local_id, item_state, revision, updated_at) " +
          "values ('linear:p-one', 'pull', 'I-000001', 'pending', 1, '2026-11-21T00:00:00.000Z')").run(),
      ).toThrow(/issue\.move-in-progress/);
      expect(() =>
        db.prepare("update issue_sync_state set item_state = 'applied' where local_id = 'I-000001'").run(),
      ).toThrow(/issue\.move-in-progress/);
      expect(() => assertRecordWritable(db, "I-000001")).toThrow(/move-one/);

      recordIssueMove(db, { ...sourceRow("mstar:issue:22222222-2222-4222-8222-222222222222", "switched", "move-two"), sourceIssueId: "I-000002" });
      expect(blockingMoveFor(db, "I-000002")).toEqual({ operationId: "move-two", phase: "switched" });
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

      advanceIssueMove(db, { operationId: "move-one", role: "source", from: "staged", to: "discarded" });
      expect(blockingMoveFor(db, "I-000001")).toBeNull();
      db.prepare("update issues set title = 'edited' where id = 'I-000001'").run();
      expect((db.prepare("select title from issues where id = 'I-000001'").get() as { title: string }).title).toBe("edited");
    } finally {
      db.close();
    }
  });

  test("a frozen record refuses relation and sync-state deletes until the move leaves the fence", async () => {
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

      const foreign = frozenMoveRefusal(db, new Error("issue.move-in-progress"));
      expect(foreign?.message).toContain("2 cross-authority moves are in flight");
    } finally {
      db.close();
    }
  });

  test("a lane is at the registry's top generation and a v3 lane reaches it through the ladder, gaining the recorded route", async () => {
    const TOP_GENERATION = COLLABORATION_MIGRATIONS[COLLABORATION_MIGRATIONS.length - 1]!.version;
    const { db } = await freshLane();
    try {
      expect((db.prepare("select max(version) as v from schema_version").get() as { v: number }).v).toBe(TOP_GENERATION);
      expect(
        (db.prepare("pragma table_info(issue_moves)").all() as Array<{ name: string }>).map((column) => column.name),
      ).toEqual(expect.arrayContaining(["operation_id", "route"]));
    } finally {
      db.close();
    }

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
      expect((upgraded.prepare("select max(version) as v from schema_version").get() as { v: number }).v).toBe(
        TOP_GENERATION,
      );
      expect(
        upgraded.prepare("pragma table_info(issue_moves)").all().map((column) => (column as { name: string }).name),
      ).toContain("route");
      expect(
        upgraded.prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'issue_moves'").get(),
      ).toEqual({ n: 1 });
    } finally {
      upgraded.close();
    }
  });
});

let engineSequence = 0;

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

const SELECTOR_REF = "refs/heads/mstar-collaboration-authority";

const SELECTED_PROJECT = {
  localProjectId: "fixture-project",
  provider: "linear",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  journalIssueId: "44444444-4444-4444-8444-444444444444",
  writerId: "55555555-5555-4555-8555-555555555555",
} as const;

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

function columnOf(db: StoreDb, sql: string, column: string, ...params: unknown[]): string {
  const row = db.prepare(sql).get(...params);
  if (row === null || typeof row !== "object") throw new Error(`${sql} returned no row`);
  const value = (row as Record<string, unknown>)[column];
  if (typeof value !== "string") throw new Error(`${sql} carries no text in ${column}`);
  return value;
}

function laneRevision(db: StoreDb): number {
  const row = db.prepare("select revision from collaboration_meta where id = 1").get();
  if (row === null || typeof row !== "object") throw new Error("collaboration_meta returned no row");
  const value = (row as Record<string, unknown>).revision;
  if (typeof value !== "number") throw new Error("collaboration_meta.revision is unreadable");
  return value;
}

function laneIssueRevision(db: StoreDb, issueId: string): number {
  const row = db.prepare("select revision from issues where id = ?").get(issueId);
  if (row === null || typeof row !== "object") throw new Error(`${issueId} returned no row`);
  const value = (row as Record<string, unknown>).revision;
  if (typeof value !== "number") throw new Error(`${issueId} carries no revision`);
  return value;
}

function readIssueMoveReference(db: StoreDb, issueId: string): string {
  return columnOf(db, "select issue_ref from issues where id = ?", "issue_ref", issueId);
}

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
      expect(recordImage(db, issueId)).toEqual(before);
      expect(() => db.prepare("update issues set title = 'edited' where id = ?").run(issueId)).toThrow(
        /issue\.move-in-progress/,
      );
      expect(stagedMismatch(sourceRowNow!, destinationRow!)).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  test("a terminal source row answers its receipt, never a re-emitted request document", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const request = {
        operationId: "move-terminal-document",
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination.repoKey,
        destinationProject: "p-dest",
        reason: "leave this authority",
      };
      const staged = await exchangeLocalToRemote(context, request, null);
      expect(staged.phase).toBe("staged");
      expect(staged.document).not.toBeNull();
      for (const phase of ["published", "discarded"] as const) {
        db.prepare("update issue_moves set phase = ? where operation_id = ? and role = 'source'").run(phase, request.operationId);
        const replay = await exchangeLocalToRemote(context, request, null);
        expect(replay.phase).toBe(phase);
        expect(replay.document).toBeNull();
      }
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
      expect(db.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
      expect(db.prepare("select count(*) as n from occurrences where issue_id = ?").get(issueId)).toEqual({ n: 0 });
      expect(readIssueMove(db, "move-full", "source")).toMatchObject({ phase: "published", removedSyncRows: 1 });
      expect(blockingMoveFor(db, issueId)).toBeNull();
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
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const firstId = await seededRecord(context, db, "p-source");
      const secondId = await seededRecord(context, db, "p-source", "-second");
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

      await moveAcrossAuthorities(context, first, "switched");
      await moveAcrossAuthorities(context, second, "switched");
      expect(blockingMoveFor(db, firstId)?.phase).toBe("switched");
      expect(blockingMoveFor(db, secondId)?.phase).toBe("switched");

      expect((await moveAcrossAuthorities(context, second)).phase).toBe("published");
      expect((await moveAcrossAuthorities(context, first)).phase).toBe("published");
      expect(db.prepare("select count(*) as n from issues where id in (?, ?)").get(firstId, secondId)).toEqual({ n: 0 });
      const admitted = await readCollaborationStage(destination.location, ({ db: lane }) => ({
        issues: lane.prepare("select count(*) as n from issues").get(),
        relations: lane.prepare("select relation, to_issue as toIssue, to_ref as toRef from relations order by from_issue, relation").all(),
      }));
      expect(admitted.issues).toEqual({ n: 2 });
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
      expect(recordImage(db, issueId)).toEqual(before);
      expect(blockingMoveFor(db, issueId)).toBeNull();
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) =>
          lane.prepare("select count(*) as n from issue_moves").get(),
        ),
      ).toEqual({ n: 0 });
      expect(readIssueMove(db, "move-discard", "source")?.phase).toBe("discarded");
      db.prepare("update issues set title = 'writable again' where id = ?").run(issueId);
    } finally {
      db.close();
    }
  }, 60_000);

  test("a discard that carries a stale record base refuses before anything is unfrozen", async () => {
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
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-discard-stale", "source")?.phase).toBe("staged");
      expect(blockingMoveFor(db, issueId)?.phase).toBe("staged");
      const discarded = await discardMove(context, { ...request, expectedRevision: laneIssueRevision(db, issueId) });
      expect(discarded).toMatchObject({ phase: "discarded", resumedFrom: "staged" });
      expect(blockingMoveFor(db, issueId)).toBeNull();
      expect(recordImage(db, issueId)).toEqual(before);
    } finally {
      db.close();
    }
  }, 60_000);

  test("the live-intent refusal names the outbox step that works in the state it reports", async () => {
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
      expect(unconfirmed).not.toContain("outbox-dispatch");
      db.prepare("update remote_outbox set state = 'confirmed' where operation_id = ?").run("intent-unconfirmed");

      const conflict = await recoveryOf("conflict", "intent-conflict");
      expect(conflict).toContain("outbox-resolve");
      expect(conflict).not.toContain("outbox-dispatch");
      expect(readIssueMove(db, request.operationId, "source")).toBeNull();
    } finally {
      db.close();
    }
  }, 60_000);

  test("the same command resumes from every persisted phase", async () => {
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
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-unadmitted", "source")?.phase).toBe("switched");
      await expect(getIssue(context, issueId)).rejects.toMatchObject({ code: "collaboration.operation-partial" });

      const resumed = await moveAcrossAuthorities(context, request);
      expect(resumed.phase).toBe("published");
      expect(db.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("the initial store CAS holds only on the run that stages, so the same command resumes", async () => {
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
        expect(laneRevision(db)).toBeGreaterThan(observed);
        expect((await moveAcrossAuthorities(context, request)).phase).toBe("published");
      } finally {
        db.close();
      }
    }
  }, 120_000);

  test("a stale base refuses before anything is frozen", async () => {
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
      expect(refused?.details?.recovery).toEqual(expect.stringContaining(`mstar issue show --id ${issueId}`));
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-base-stale", "source")).toBeNull();
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) => lane.prepare("select count(*) as n from issue_moves").get()),
      ).toEqual({ n: 0 });
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
      expect(readIssueMove(db, request.operationId, "source")).toBeNull();
      expect(recordImage(db, issueId)).toEqual(before);
      expect(() => assertRecordWritable(db, issueId)).not.toThrow();
      db.prepare("update remote_outbox set state = 'confirmed' where operation_id = ?").run("intent-ahead");
      const staged = await stageMove(context, request);
      expect(staged).toBeUndefined();
      expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("staged");
    } finally {
      db.close();
    }
  }, 60_000);

  test("a reused operation id cannot carry another record, authority or project", async () => {
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
    const { context, db } = await sourceCheckout();
    try {
      const destination = await destinationLane("p-dest");
      const issueId = await seededRecord(context, db, "p-source");
      const before = recordImage(db, issueId);
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
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-collision", "source")?.phase).toBe("verified");
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
      expect(recordImage(db, issueId)).toEqual(before);
      expect(await readCollaborationStage(destination.location, ({ db: lane }) =>
        lane.prepare("select count(*) as n from issues").get())).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("a crash between the discard commit and the destination delete is finished by the same command", async () => {
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
      await discardMove(context, request);
      await writeCollaborationStage(destination.location, ({ db: lane }) => {
        recordIssueMove(lane, { ...recorded, role: "destination", phase: "staged" });
      });
      expect(await readCollaborationStage(destination.location, ({ db: lane }) =>
        lane.prepare("select count(*) as n from issue_moves").get())).toEqual({ n: 1 });
      const replayed = await moveAcrossAuthorities(context, request);
      expect(replayed).toMatchObject({ phase: "discarded", resumedFrom: "discarded" });
      expect(await readCollaborationStage(destination.location, ({ db: lane }) =>
        lane.prepare("select count(*) as n from issue_moves").get())).toEqual({ n: 0 });
      expect(recordImage(db, issueId)).toEqual(before);
    } finally {
      db.close();
    }
  }, 60_000);

  test("a destination record inserted after the preflight is refused at admission, never adopted", async () => {
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
      expect(recordImage(db, issueId)).toEqual(before);
      expect(readIssueMove(db, "move-race-occupant", "source")?.phase).toBe("switched");
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) => ({
          occupant: lane.prepare("select title from issues where id = 'I-000009'").get(),
          issues: lane.prepare("select count(*) as n from issues").get(),
        })),
      ).toEqual({ occupant: { title: "Late occupant" }, issues: { n: 1 } });
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
      expect(await publishMove(context, request)).toBeUndefined();
      expect(db.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
      expect(readIssueMove(db, "move-race-admit-wins", "source")?.phase).toBe("published");
    } finally {
      setMoveGapForTest(undefined);
      db.close();
    }
  }, 60_000);

  test("a discard that commits before the admission refuses the switch and restores the record", async () => {
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
      expect(
        await readCollaborationStage(destination.location, ({ db: lane }) => ({
          issues: lane.prepare("select count(*) as n from issues").get(),
          rows: lane.prepare("select count(*) as n from issue_moves").get(),
        })),
      ).toEqual({ issues: { n: 0 }, rows: { n: 0 } });
      expect(recordImage(db, issueId)).toEqual(before);
      expect(blockingMoveFor(db, issueId)).toBeNull();
      expect(db.prepare("update issues set title = 'writable again' where id = ?").run(issueId) as { changes?: number }).toMatchObject({ changes: 1 });
      await expect(getIssue(context, issueId)).resolves.toMatchObject({ id: issueId });
    } finally {
      setMoveGapForTest(undefined);
      db.close();
    }
  }, 60_000);

  test("an identity another writer inserts after the preflight refuses the admission too", async () => {
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
      expect(readIssueMove(db, "move-freeze-atomic", "source")).toBeNull();
      expect(laneRevision(db)).toBe(observed);
      expect(recordImage(db, issueId)).toEqual(before);
      expect(blockingMoveFor(db, issueId)).toBeNull();
      db.exec("drop trigger injected_revision_crash");
      expect((await moveAcrossAuthorities(context, request)).phase).toBe("published");
      expect(db.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("a discard follows the recorded route, and a move this lane never staged refuses by name", async () => {
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
        expect(refused?.code).toBe("collaboration.not-initialized");
        expect(String(refused?.message)).toContain(destination.repoKey);
        expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("staged");
        expect(recordImage(db, issueId)).toEqual(before);
        expect(blockingMoveFor(db, issueId)?.phase).toBe("staged");
      } finally {
        db.close();
      }
    }

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
        expect(refused).not.toBeNull();
        expect(refused?.code).not.toBe("collaboration.move-phase-invalid");
        expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("staged");
        expect(recordImage(db, issueId)).toEqual(before);
      } finally {
        db.close();
      }
    }

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
        expect(await discardAcrossAuthorities(peer.context, request)).toMatchObject({
          phase: "discarded",
          resumedFrom: "staged",
        });
        expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("staged");
        expect(
          await readCollaborationStage(resolveCollaborationLocation(peer.context), ({ db: lane }) =>
            readIssueMove(lane, request.operationId, "destination"),
          ),
        ).toMatchObject({ phase: "discarded" });
      } finally {
        peer.db.close();
        db.close();
      }
    }

    {
      const { context, db } = await sourceCheckout();
      try {
        const issueId = await seededRecord(context, db, "p-source", "-never");
        const request = requestFor(`move-discard-never-${String(engineSequence)}`, issueId, "absent-authority");
        const refused = await refusalOf(discardAcrossAuthorities(context, request));
        expect(refused?.code).toBe("collaboration.move-phase-invalid");
        expect(refused?.details).toMatchObject({ operation_id: request.operationId });
        expect(String(refused?.message)).toContain("No cross-authority move is recorded");
      } finally {
        db.close();
      }
    }
  }, 120_000);

  test("a discard of a never-recorded move names its id and the staging checkout, never 'start the move'", async () => {
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
      expect(recovery).not.toContain("staging run");
      expect(recovery).not.toContain("--out");
      expect(recovery).not.toContain("ledger");
      expect(recovery).not.toContain("Start the move");
    } finally {
      db.close();
    }
  }, 60_000);

  test("an unbound remote checkout's discard refuses before any ledger question", async () => {
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
      expect(refused?.code).toBe("collaboration.stale-binding");
      expect(String(refused?.message)).toContain("remote bind");
      expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("staged");
    } finally {
      db.close();
    }
  }, 120_000);

  test("publication refuses an incoming relation that landed after the freeze", async () => {
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
      expect(() => edge.run(late, issueId)).toThrow(/issue\.move-in-progress/);
      db.exec("drop trigger relations_move_guard_insert");
      edge.run(late, issueId);
      const refused = await publishMove(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string; details?: Record<string, unknown> },
      );
      expect(refused?.code).toBe("collaboration.operation-partial");
      expect(String(refused?.message)).toContain("landed while the move was in flight");
      expect(refused?.details).toMatchObject({ expected: 0, rewritten: 1 });
      expect(readIssueMove(db, request.operationId, "source")?.phase).toBe("switched");
      expect(recordImage(db, issueId)).toEqual(before);
      expect(db.prepare("select count(*) as n from relations where to_issue = ?").get(issueId)).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  }, 60_000);

  test("a second request under the same operation id refuses instead of staging the first payload", async () => {
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
  test("a switched local-exchange source refuses its own discard just like a remote one", async () => {
    const { context, db } = await sourceCheckout();
    try {
      const issueId = await seededRecord(context, db, "p-source");
      const operationId = "move-local-remote-switch";
      const destination = "github.com/acme/other-checkout";
      const request = {
        operationId,
        actor: "project-manager",
        sourceIssueId: issueId,
        destinationAuthority: destination,
        destinationProject: "p-dest",
        reason: "exchange",
      };
      const staged = await exchangeLocalToRemote(context, request, null);
      expect(staged).toMatchObject({ phase: "staged", side: "source" });
      db.prepare("update issue_moves set phase = 'switched' where operation_id = ?").run(operationId);

      const refused = await discardAcrossAuthorities(context, request).then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string },
      );
      expect(refused?.code).toBe("collaboration.move-phase-invalid");
      expect(refused?.message).toContain("handed its switch document");
      expect(db.prepare("select phase from issue_moves where operation_id = ?").get(operationId)).toEqual({
        phase: "switched",
      });
    } finally {
      db.close();
    }
  });
});


describe("cross-authority move package surface", () => {
  test("the package publishes the move routes it documents and keeps the phase engine internal", async () => {
    const surface = (await import("./index.js")) as unknown as Record<string, unknown>;
    for (const name of [
      "discardAcrossAuthorities",
      "discardMove",
      "moveAcrossAuthorities",
      "moveAcrossByDocument",
      "moveDocumentOf",
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
      "exchangeLocalDestination",
      "exchangeLocalToRemote",
      "exchangeRemoteDestination",
      "exchangeRemoteSource",
      "frozenMoveRefusal",
      "isForwardMoveTransition",
      "publishMove",
      "readIssueMove",
      "recordIssueMove",
      "remoteMoveOperationId",
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
