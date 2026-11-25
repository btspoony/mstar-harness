/**
 * why: collaboration store -- independent staged schema, create-only publication and
 * active-only admission for the user-level collaboration database.
 *
 * Every case builds a synthetic checkout and user home under the temp root; the
 * user home is isolated by a `node:os` test spy, so no case reads the real home
 * or the control harness store, and no product API gained a home selector.
 */
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  collaborationLocationOfRepoKey,
  resolveCollaborationLocation,
  type CollaborationLocation,
  type CollaborationMode,
} from "./collaboration-identity.js";
import {
  adoptCollaborationBinding,
  assertControlCheckoutScope,
  assertIssueRef,
  COLLABORATION_MIGRATIONS,
  initializeCollaborationStore,
  initializeRemoteCacheStore,
  localPredecessorRetiredPath,
  openCollaborationStore,
  probeCollaborationAuthority,
  readCollaborationAuthority,
  readCollaborationBinding,
  openRemoteCacheRecovery,
  readRemoteCacheAuthority,
  setLocalPredecessorPublicationGapForTest,
  setRemoteCacheReplacementCommitGapForTest,
  setRemoteCacheReplacementGapForTest,
  setRemoteCacheReplacementLedgerGapForTest,
  setRemoteCacheReplacementPublishGapForTest,
  unroutedMoveHalfRoute,
  upgradeCollaborationStore,
  withCollaborationWrite,
  withRemoteCacheWrite,
  writeCollaborationBinding,
  writeRemoteCacheStage,
  writeRemoteCollaborationBinding,
  type CollaborationStamp,
  type CollaborationStoreHandle,
} from "./collaboration-store.js";

/** note: The lane's current version and full ledger, read from the registry: no test pins the literal. */
const LANE_CURRENT_VERSION = COLLABORATION_MIGRATIONS[COLLABORATION_MIGRATIONS.length - 1]!.version;
const LANE_LEDGER_VERSIONS = COLLABORATION_MIGRATIONS.map(({ version }) => version);
const LANE_LEDGER_ROWS = COLLABORATION_MIGRATIONS.map(({ version, name }) => ({ version, name }));
import {
  abandonRemoteIntent,
  bindRemoteAuthority,
  dispatchRemoteIntent,
  ingestRemoteObservation,
  issueRefForOperation,
  prepareRemoteAdoption,
  prepareRemoteIntent,
  prepareRemoteResolution,
  readPendingIntents,
  readRemoteIntent,
  readRemoteStatus,
  recordRemoteReceipt,
  reconcileRemoteIntent,
  remoteEventHead,
  setRemoteBindTransitionGapForTest,
  setRemoteBindingPublicationGapForTest,
  setRemoteIntentSampleGapForTest,
  setRemoteReplayAdmissionGapForTest,
  setRemoteWriteScopeGapForTest,
  type ForkObservation,
  type RemoteEvent,
  type RemoteIntentState,
  type RemoteReceiptOutcome,
  type RemoteSnapshot,
  type ScopeCheck,
} from "./collaboration-remote.js";
import { openRemoteReadView, remoteMilestones } from "./collaboration-remote-read.js";
import { remoteReceiptDocumentSchema } from "./remote-documents.js";
import { MIGRATIONS, SCHEMA_VERSION_TABLE_SQL, initializeStore, migrationChecksum, openStore, storeDbPath, type StoreContext } from "./store-db.js";
import {
  remoteCompositeEntryOperationId,
  remoteCompositeOperationId,
  reserveCompositeIntent,
  runCollaborationComposite,
  setCompositeDeclineGapForTest,
  type CollaborationEffectReceipt,
  type CompositeIntent,
} from "./collaboration-operations.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  readExecutionPlan,
  readExecutionState,
  withExecutionTransaction,
  type ExecutionCaller,
  type ExecutionSessionRef,
  type ExecutionToken,
  type ExecutionTransaction,
} from "./execution-store.js";
import { deriveResidualEntries, residualAddExecutionPlan, residualCloseExecutionPlan } from "./execution-coordination.js";
import { commitExecutionRegistration } from "./execution-registration.js";
import { importExecutionMinimal } from "./execution-minimal-import.js";
import type { WorkflowEntry } from "./status.js";
import type { ResidualInput } from "./coordination.js";
import type { WorkflowSnapshot } from "./workflow.js";
import { appendOccurrence, assignIssueMilestone, captureIssue, closeIssue, moveIssue } from "./issue.js";
import { discardAcrossAuthorities, moveAcrossByDocument, recordIssueMove, remoteMoveOperationId, setMoveGapForTest } from "./cross-authority-move.js";
import { addMilestone, removeMilestone, updateMilestone } from "./milestone-store.js";
import { replaceRoadmapAuthority } from "./roadmap-store.js";
import { registerCatalogEntity } from "./catalog.js";
import { applyStoreMigration, planStoreMigration } from "./store-migrate.js";
import { ensureCollaborationAuthority, restoreCollaborationBackup, type RepositoryBackupReceipt, type ActivationAttestation } from "./store-activation.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-collab-store-")));
const HOME = join(ROOT, "home");
mkdirSync(HOME);
/** note: The home the single spy resolves; a case may switch it to a fresh tree. */
let resolvedHome = HOME;

let homeSpy: { mockRestore(): void } | undefined;

beforeAll(() => {
  // why: The resolver's fixture seam is its explicit `userHome` option; the store
  // entry points keep the locked signatures without one, so the isolated home
  // is installed at the runtime boundary the resolver calls. One spy serves the
  // whole file: nesting another and restoring it would discard this one.
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => resolvedHome);
});

afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * note: The closed collaboration table inventory (spec Data Model): collaboration
 * metadata, its own schema ledger, issue/governance/catalog/sync domains, and
 * the collaboration receipt namespaces. No `execution_*`, projection, dsh or
 * combined-store table belongs here.
 */
const COLLABORATION_TABLES = [
  "catalog_entities",
  "catalog_links",
  "catalog_operations",
  "collaboration_meta",
  "collaboration_operations",
  "cutover_publications",
  "issue_counter",
  "issue_moves",
  "issue_project_moves",
  "issue_sync_state",
  "issue_transitions",
  "issues",
  "occurrences",
  "project_bindings",
  "project_milestones",
  "project_roadmaps",
  "provenance",
  "relations",
  "remote_bindings",
  "remote_issue_identities",
  "remote_observations",
  "remote_outbox",
  "remote_outbox_receipts",
  "schema_version",
  "sync_cursor",
  "sync_runs",
];

/** note: One standalone receipt insert, for the transaction-boundary cases. */
function receiptInsert(operationId: string): string {
  return (
    "insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at) " +
    `values ('standalone', '${operationId}', 'hash', '{}', '2026-11-21T00:00:00.000Z')`
  );
}

let sequence = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** note: A synthetic checkout whose `.mstarc` selects the local collaboration mode. */
function makeRepo(origin: string): string {
  const dir = join(ROOT, `repo-${sequence++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Collaboration Store Test");
  git(dir, "config", "user.email", "store@example.test");
  git(dir, "config", "remote.origin.url", origin);
  // note: Every origin-backed checkout proves selector absence with a live lookup; route the
  // synthetic origin to this fixture's own repository, which never publishes the selector ref.
  git(dir, "config", `url.${dir}.insteadOf`, origin);
  writeFileSync(join(dir, ".mstarc"), "[collaboration]\nmode=local\n");
  return dir;
}

/** note: Fixture contexts by resolved lane path, so `activate` can record the binding. */
const contextsByDbPath = new Map<string, StoreContext>();

function contextAt(root: string): StoreContext {
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const context = { harnessDir, checkoutRoot: root };
  try {
    const location = resolveCollaborationLocation(context);
    contextsByDbPath.set(location.dbPath, context);
  } catch {
    // invariant: A fixture testing an unresolved scope never reaches activation.
  }
  return context;
}

function locationAt(root: string): CollaborationLocation {
  return resolveCollaborationLocation(contextAt(root));
}

/** note: Publish the staged lane and the owning checkout's binding. */
function activate(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
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
  const context = contextsByDbPath.get(dbPath);
  if (context !== undefined) {
    const location = resolveCollaborationLocation(context);
    writeCollaborationBinding(context, {
      repoKey: location.repoKey,
      mode: location.mode,
      storeId,
      epoch,
      binding: "active",
    });
  }
}

function tableNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  } finally {
    db.close();
  }
}

function metaRecord(dbPath: string): {
  repository_key: string;
  mode: string;
  store_id: string;
  authority_state: string;
  authority_epoch: number;
} {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        "select repository_key, mode, store_id, authority_state, authority_epoch from collaboration_meta where id = 1",
      )
      .get() as {
      repository_key: string;
      mode: string;
      store_id: string;
      authority_state: string;
      authority_epoch: number;
    };
  } finally {
    db.close();
  }
}

/** invariant: The journal mode actually persisted in the file (a plain open never changes it). */
function journalMode(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("pragma journal_mode").get() as { journal_mode: string }).journal_mode;
  } finally {
    db.close();
  }
}

function receipts(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("select operation_id from collaboration_operations order by operation_id").all() as Array<{
      operation_id: string;
    }>).map((row) => row.operation_id);
  } finally {
    db.close();
  }
}

const REAL_FSYNC = nodeFs.fsyncSync;

/** note: Whether this descriptor currently names a directory - the barrier's target. */
function namesDirectory(fd: number): boolean {
  try {
    return fstatSync(fd).isDirectory();
  } catch {
    return false;
  }
}

/** note: Fail every directory barrier this process attempts, with an errno. */
function failDirectoryBarriers(): { restore: () => void } {
  const spy = spyOn(nodeFs, "fsyncSync").mockImplementation(((fd: number) => {
    if (namesDirectory(fd)) throw Object.assign(new Error("simulated directory fsync failure"), { code: "EIO" });
    return REAL_FSYNC(fd);
  }) as never);
  return { restore: () => spy.mockRestore() };
}

/** note: Count the directory barriers that actually run. */
function observeDirectoryBarriers(): { restore: () => void; synced: () => number } {
  let synced = 0;
  const spy = spyOn(nodeFs, "fsyncSync").mockImplementation(((fd: number) => {
    if (namesDirectory(fd)) synced += 1;
    return REAL_FSYNC(fd);
  }) as never);
  return { restore: () => spy.mockRestore(), synced: () => synced };
}

/** note: The directory's file entries that name the same inode. */
function aliasesOf(dir: string, inode: number): string[] {
  return nodeFs.readdirSync(dir).filter((name) => {
    const stats = nodeFs.lstatSync(join(dir, name));
    return stats.isFile() && stats.ino === inode;
  });
}

/** note: Engine-owned staging entries still present beside a published store. */
function stagingLeftovers(dir: string): string[] {
  return nodeFs.readdirSync(dir).filter((name) => name.startsWith(".staging-"));
}

/** note: The stamp a caller holds for one admitted authority. */
function stampOf(authority: {
  repoKey: string;
  mode: CollaborationMode;
  storeId: string;
  epoch: number;
}): CollaborationStamp {
  return { repoKey: authority.repoKey, mode: authority.mode, storeId: authority.storeId, epoch: authority.epoch };
}

describe("collaboration store", () => {
  test("initialization publishes one staged collaboration schema and continues the same stage", async () => {
    const location = locationAt(makeRepo("https://github.com/acme/staged.git"));
    expect(existsSync(location.dbPath)).toBe(false);

    const first = await initializeCollaborationStore(location);
    expect(first).toMatchObject({
      repoKey: "github.com/acme/staged",
      mode: "local",
      state: "staged",
      schemaVersion: LANE_CURRENT_VERSION,
      epoch: 1,
      revision: 0,
      catalogRevision: 0,
    });
    expect(first.storeId).toMatch(/^[0-9a-f-]{36}$/);

    // note: Same stage, same authority: no second ledger row, no cleared metadata.
    const again = await initializeCollaborationStore(location);
    expect(again).toEqual(first);

    const versions = (() => {
      const db = new DatabaseSync(location.dbPath);
      try {
        return db.prepare("select version, name from schema_version order by version").all();
      } finally {
        db.close();
      }
    })();
    expect(versions).toEqual(LANE_LEDGER_ROWS);
    expect(tableNames(location.dbPath).length).toBe(COLLABORATION_TABLES.length);
    expect(receipts(location.dbPath)).toEqual([]);

    // note: A private store file inside a private directory.
    expect(statSync(location.dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(location.dbPath)).mode & 0o777).toBe(0o700);
  });

  test("the staged schema is the closed collaboration inventory with no execution table", async () => {
    const location = locationAt(makeRepo("https://github.com/acme/inventory.git"));
    await initializeCollaborationStore(location);

    const tables = tableNames(location.dbPath);
    expect(tables).toEqual(COLLABORATION_TABLES);
    for (const name of tables) {
      expect(name.startsWith("execution_") || name.startsWith("projection_") || name.startsWith("dsh_")).toBe(false);
    }

    const db = new DatabaseSync(location.dbPath);
    try {
      // note: Collaboration initialization creates no issue, no execution row and no
      // combined-store leftover.
      expect((db.prepare("select count(*) as n from issues").get() as { n: number }).n).toBe(0);
      expect((db.prepare("select count(*) as n from project_bindings").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("read admission requires an active authority and creates no database", async () => {
    const repo = makeRepo("https://github.com/acme/admission.git");
    const context = contextAt(repo);
    const location = locationAt(repo);

    await expect(openCollaborationStore(context, "read")).rejects.toMatchObject({
      code: "collaboration.not-initialized",
    });
    await expect(openCollaborationStore(context, "write")).rejects.toMatchObject({
      code: "collaboration.not-initialized",
    });
    await expect(readCollaborationAuthority(context)).rejects.toMatchObject({
      code: "collaboration.not-initialized",
    });
    expect(existsSync(dirname(location.dbPath))).toBe(false);

    const staged = await initializeCollaborationStore(location);
    await expect(openCollaborationStore(context, "read")).rejects.toMatchObject({ code: "collaboration.not-active" });
    await expect(readCollaborationAuthority(context)).rejects.toMatchObject({ code: "collaboration.not-active" });
    await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({
      code: "collaboration.not-active",
    });
    // invariant: A refused admission neither activates nor rewrites the staged record.
    expect(await initializeCollaborationStore(location)).toEqual(staged);
  });

  test("canonical repository keys isolate their stores", async () => {
    const locations = [
      locationAt(makeRepo("https://github.com/acme/widgets.git")),
      locationAt(makeRepo("https://github.com/fork/widgets.git")),
      locationAt(makeRepo("ssh://git@git.example.com:2222/team/widgets.git")),
    ];
    expect(new Set(locations.map((location) => location.dbPath)).size).toBe(3);
    expect(new Set(locations.map((location) => location.repoKey)).size).toBe(3);

    const authorities = [];
    for (const location of locations) authorities.push(await initializeCollaborationStore(location));
    expect(new Set(authorities.map((authority) => authority.storeId)).size).toBe(3);

    for (let index = 0; index < locations.length; index++) {
      expect(authorities[index].repoKey).toBe(locations[index].repoKey);
      expect(metaRecord(locations[index].dbPath).repository_key).toBe(locations[index].repoKey);
    }

    // invariant: A path whose directory segments carry percent-encoded uppercase must still
    // open for a guarded write: the no-create write URI addresses it literally.
    const upperRoot = makeRepo("https://git.example.com/Team/Repo.git");
    const upperLocation = locationAt(upperRoot);
    const upperStaged = await initializeCollaborationStore(upperLocation);
    expect(upperLocation.dbPath).toContain("%54eam");
    activate(upperLocation.dbPath);
    await withCollaborationWrite(
      contextAt(upperRoot),
      (write) => {
        write.db.prepare(receiptInsert("op-upper")).run();
        return "ok";
      },
      { repoKey: upperStaged.repoKey, mode: upperStaged.mode, storeId: upperStaged.storeId, epoch: upperStaged.epoch },
    );
    expect(receipts(upperLocation.dbPath)).toEqual(["op-upper"]);
  });

  test("corrupt bytes refuse as unreadable and are preserved", async () => {
    const location = locationAt(makeRepo("https://github.com/acme/corrupt.git"));
    mkdirSync(dirname(location.dbPath), { recursive: true, mode: 0o700 });
    writeFileSync(location.dbPath, "not a collaboration database", { mode: 0o600 });
    await expect(initializeCollaborationStore(location)).rejects.toMatchObject({ code: "collaboration.unreadable" });
    expect(readFileSync(location.dbPath, "utf8")).toBe("not a collaboration database");
  });

  test("a newer ledger with a changed inventory reports the upgrade verdict", async () => {
    const root = makeRepo("https://github.com/acme/future.git");
    const context = contextAt(root);
    const location = locationAt(root);
    await initializeCollaborationStore(location);
    const writer = new DatabaseSync(location.dbPath);
    try {
      // note: one row past THIS build's ladder, whichever version that is.
      writer
        .prepare(
          "insert into schema_version(version, name, checksum, applied_at) values (?, 'future', 'x', ?)",
        )
        .run(LANE_CURRENT_VERSION + 1, "2026-11-21T00:00:00.000Z");
      // invariant: A newer layout no longer matches this build's inventory; the verdict is
      // still the upgrade requirement, never "damaged store".
      writer.exec("create table future_extra(id text primary key)");
    } finally {
      writer.close();
    }
    const expected = {
      code: "store.schema-unsupported",
      details: {
        storeSchemaVersion: LANE_CURRENT_VERSION + 1,
        supportedSchemaMax: LANE_CURRENT_VERSION,
        firstUnsupportedMigration: LANE_CURRENT_VERSION + 1,
      },
    };
    await expect(initializeCollaborationStore(location)).rejects.toMatchObject(expected);
    await expect(openCollaborationStore(context, "read")).rejects.toMatchObject(expected);
    await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject(expected);
  });

  test("a symlinked final target refuses without following it", async () => {
    const targetRoot = makeRepo("https://github.com/acme/link-target.git");
    const target = locationAt(targetRoot);
    const authority = await initializeCollaborationStore(target);
    const linked = locationAt(makeRepo("https://github.com/acme/linked.git"));
    mkdirSync(dirname(linked.dbPath), { recursive: true, mode: 0o700 });
    symlinkSync(target.dbPath, linked.dbPath);
    await expect(initializeCollaborationStore(linked)).rejects.toMatchObject({
      code: "collaboration.unreadable",
      message: expect.stringContaining("symbolic link"),
    });
    // note: The link target was neither followed nor modified.
    expect(await initializeCollaborationStore(target)).toEqual(authority);
    expect(metaRecord(target.dbPath).repository_key).toBe("github.com/acme/link-target");
  });

  test("a symlinked storage ancestor refuses without publishing outside the tree", async () => {
    const location = locationAt(makeRepo("https://github.com/acme/linked-ancestor.git"));
    const storeDir = dirname(location.dbPath);
    mkdirSync(dirname(storeDir), { recursive: true, mode: 0o700 });
    const outside = join(ROOT, `outside-${sequence++}`);
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    rmSync(storeDir, { recursive: true, force: true });
    symlinkSync(outside, storeDir);

    await expect(initializeCollaborationStore(location)).rejects.toMatchObject({
      code: "collaboration.unreadable",
      message: expect.stringContaining("symbolic link"),
    });
    // note: The redirected destination stays untouched.
    expect(nodeFs.readdirSync(outside)).toEqual([]);
    expect(existsSync(location.dbPath)).toBe(false);
  });

  test("existing nonprivate storage refuses", async () => {
    const dirRoot = makeRepo("https://github.com/acme/permissive-dir.git");
    const dirContext = contextAt(dirRoot);
    const dirLocation = locationAt(dirRoot);
    await initializeCollaborationStore(dirLocation);
    chmodSync(dirname(dirLocation.dbPath), 0o755);
    try {
      await expect(openCollaborationStore(dirContext, "read")).rejects.toMatchObject({
        code: "collaboration.unreadable",
        message: expect.stringContaining("not private"),
      });
    } finally {
      chmodSync(dirname(dirLocation.dbPath), 0o700);
    }

    const fileRoot = makeRepo("https://github.com/acme/permissive-file.git");
    const fileContext = contextAt(fileRoot);
    const fileLocation = locationAt(fileRoot);
    await initializeCollaborationStore(fileLocation);
    chmodSync(fileLocation.dbPath, 0o644);
    try {
      await expect(readCollaborationAuthority(fileContext)).rejects.toMatchObject({
        code: "collaboration.unreadable",
        message: expect.stringContaining("not private"),
      });
    } finally {
      chmodSync(fileLocation.dbPath, 0o600);
    }
  });

  test("an active store missing a required table refuses as unreadable", async () => {
    const repo = makeRepo("https://github.com/acme/damaged.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    await initializeCollaborationStore(location);
    activate(location.dbPath);
    const db = new DatabaseSync(location.dbPath);
    try {
      db.exec("drop table issues");
    } finally {
      db.close();
    }

    await expect(openCollaborationStore(context, "read")).rejects.toMatchObject({
      code: "collaboration.unreadable",
      message: expect.stringContaining("issues"),
    });
    await expect(readCollaborationAuthority(context)).rejects.toMatchObject({ code: "collaboration.unreadable" });
    await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({
      code: "collaboration.unreadable",
    });
  });

  test("a current table name without its required columns refuses as unreadable", async () => {
    const repo = makeRepo("https://github.com/acme/damaged-columns.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    await initializeCollaborationStore(location);
    activate(location.dbPath);
    const db = new DatabaseSync(location.dbPath);
    try {
      // note: Same table name, current ledger and metadata, but the issue shape lost
      // every required column including `impact`.
      db.exec("alter table issues rename to issues_original");
      db.exec("create table issues(id text primary key)");
      db.exec("drop table issues_original");
    } finally {
      db.close();
    }

    await expect(openCollaborationStore(context, "read")).rejects.toMatchObject({
      code: "collaboration.unreadable",
      message: expect.stringMatching(/issues\(.*impact/),
    });
    await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({
      code: "collaboration.unreadable",
      message: expect.stringMatching(/issues\(.*impact/),
    });
  });

  test("write admission enforces the active stamp and rolls a refused effect back", async () => {
    const repo = makeRepo("https://github.com/acme/cas.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    const staged = await initializeCollaborationStore(location);
    activate(location.dbPath);

    const authority = await readCollaborationAuthority(context);
    expect(authority).toMatchObject({
      state: "active",
      repoKey: staged.repoKey,
      mode: staged.mode,
      storeId: staged.storeId,
      epoch: staged.epoch,
    });
    const stamp: CollaborationStamp = {
      repoKey: authority.repoKey,
      mode: authority.mode,
      storeId: authority.storeId,
      epoch: authority.epoch,
    };

    const handle = await openCollaborationStore(context, "read", stamp);
    expect(handle.authority).toEqual(authority);
    handle.close();

    // invariant: A stale generation is refused before the effect runs.
    let applied = false;
    const stale = { ...stamp, epoch: stamp.epoch + 1 };
    await expect(
      withCollaborationWrite(
        context,
        () => {
          applied = true;
          return "unreachable";
        },
        stale,
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(applied).toBe(false);
    await expect(openCollaborationStore(context, "read", stale)).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });

    const committed = await withCollaborationWrite(
      context,
      (write) => {
        write.db.prepare(receiptInsert("op-committed")).run();
        return write.authority.revision;
      },
      stamp,
    );
    expect(committed).toBe(authority.revision);

    // note: A thrown effect commits nothing: the wrapper owns the transaction.
    await expect(
      withCollaborationWrite(
        context,
        (write) => {
          write.db.prepare(receiptInsert("op-rolled-back")).run();
          throw new Error("domain refusal");
        },
        stamp,
      ),
    ).rejects.toThrow("domain refusal");
    expect(receipts(location.dbPath)).toEqual(["op-committed"]);
  });

  test("a public handle can never mutate outside the guarded transaction", async () => {
    const repo = makeRepo("https://github.com/acme/handle.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    await initializeCollaborationStore(location);
    activate(location.dbPath);

    const authority = await readCollaborationAuthority(context);
    const stamp: CollaborationStamp = {
      repoKey: authority.repoKey,
      mode: authority.mode,
      storeId: authority.storeId,
      epoch: authority.epoch,
    };

    for (const mode of ["read", "write"] as const) {
      const handle = await openCollaborationStore(context, mode, stamp);
      expect(() => handle.db.prepare(receiptInsert(`op-${mode}-prepared`)).run()).toThrow();
      expect(() => handle.db.exec(receiptInsert(`op-${mode}-exec`))).toThrow();
      handle.close();
    }
    expect(receipts(location.dbPath)).toEqual([]);

    // note: A retained handle stays non-mutating when the recorded generation changes.
    const retained = await openCollaborationStore(context, "write", stamp);
    const selection = new DatabaseSync(location.dbPath);
    try {
      selection.prepare("update collaboration_meta set authority_epoch = authority_epoch + 1 where id = 1").run();
    } finally {
      selection.close();
    }
    expect(() => retained.db.exec(receiptInsert("op-after-epoch-change"))).toThrow();
    retained.close();
    expect(receipts(location.dbPath)).toEqual([]);

    // note: The bump is a NEW generation: this checkout is only admitted once it is
    // re-bound to the epoch the lane now records (as an activation/restore does).
    writeCollaborationBinding(context, {
      repoKey: authority.repoKey,
      mode: authority.mode,
      storeId: authority.storeId,
      epoch: authority.epoch + 1,
      binding: "active",
    });

    // note: The guarded transaction's writer is closed when the call returns.
    let escaped: CollaborationStoreHandle | undefined;
    await withCollaborationWrite(
      context,
      (write) => {
        escaped = write;
        return "ok";
      },
      { ...stamp, epoch: stamp.epoch + 1 },
    );
    // why: The guarded facade denies `exec`, so the closed connection is proved
    // through the one prepared statement the facade still forwards.
    expect(() => escaped?.db.prepare("select 1").get()).toThrow();
  });

  test("an asynchronous effect is rejected before commit and leaves no unhandled rejection", async () => {
    const repo = makeRepo("https://github.com/acme/async.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    const staged = await initializeCollaborationStore(location);
    activate(location.dbPath);
    const stamp: CollaborationStamp = {
      repoKey: staged.repoKey,
      mode: staged.mode,
      storeId: staged.storeId,
      epoch: staged.epoch,
    };

    // invariant: No test-side `.catch`: the wrapper itself must observe the abandoned
    // promise, so an unhandled rejection here fails the case.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        withCollaborationWrite(
          context,
          async (write) => {
            write.db.prepare(receiptInsert("op-async")).run();
            await Promise.resolve();
            throw new Error("async effect");
          },
          stamp,
        ),
      ).rejects.toMatchObject({ code: "store.corrupt", message: expect.stringContaining("synchronous") });
      // invariant: Unhandled rejections are reported at the runtime's next task boundary,
      // so drain exactly one; no duration is being guessed here.
      const drained = Promise.withResolvers<void>();
      setImmediate(drained.resolve);
      await drained.promise;
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(receipts(location.dbPath)).toEqual([]);
  });

  test("a callable thenable effect is rejected before commit", async () => {
    const repo = makeRepo("https://github.com/acme/callable-thenable.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    const staged = await initializeCollaborationStore(location);
    activate(location.dbPath);
    const stamp: CollaborationStamp = {
      repoKey: staged.repoKey,
      mode: staged.mode,
      storeId: staged.storeId,
      epoch: staged.epoch,
    };

    await expect(
      withCollaborationWrite(
        context,
        (write) => {
          write.db.prepare(receiptInsert("op-callable-thenable")).run();
          return Object.assign(() => "callable", {
            then: (_resolve: unknown, reject?: (reason: unknown) => void) => {
              reject?.(new Error("callable thenable"));
            },
          });
        },
        stamp,
      ),
    ).rejects.toMatchObject({ code: "store.corrupt", message: expect.stringContaining("synchronous") });
    expect(receipts(location.dbPath)).toEqual([]);
  });

  test("an unconfirmed directory entry refuses on continuation and the same initializer confirms it", async () => {
    const location = locationAt(makeRepo("https://github.com/acme/barrier.git"));
    const failing = failDirectoryBarriers();
    const refusal = await initializeCollaborationStore(location).then(
      () => null,
      (error: unknown) => error,
    );
    failing.restore();

    expect(refusal).toMatchObject({ code: "collaboration.unreadable", details: { published: true } });
    expect(refusal instanceof Error ? refusal.message : "").toMatch(/EIO|simulated directory fsync failure/);
    const published = metaRecord(location.dbPath);
    expect(published.authority_state).toBe("staged");

    // invariant: The failed publication retired its own staging alias: exactly one name
    // for the runtime bytes remains, and no staging scratch is left behind.
    const storeDir = dirname(location.dbPath);
    expect(aliasesOf(storeDir, statSync(location.dbPath).ino)).toEqual(["collaboration.db"]);
    expect(stagingLeftovers(storeDir)).toEqual([]);

    // note: The retry continues the SAME record and really re-runs the barrier.
    const observer = observeDirectoryBarriers();
    let authority;
    try {
      authority = await initializeCollaborationStore(location);
    } finally {
      const synced = observer.synced();
      observer.restore();
      expect(synced).toBeGreaterThan(0);
    }
    expect(authority.storeId).toBe(published.store_id);
    expect(authority.state).toBe("staged");
    expect(aliasesOf(storeDir, statSync(location.dbPath).ino)).toEqual(["collaboration.db"]);
    expect(stagingLeftovers(storeDir)).toEqual([]);
  });

  test("a competing publication continues the published record only after confirming its directory entry", async () => {
    const location = locationAt(makeRepo("https://github.com/acme/competitor.git"));
    const competitor = spyOn(nodeFs, "linkSync").mockImplementation(((from: string, to: string) => {
      // note: A competing initializer published the same complete bytes first.
      copyFileSync(from, to);
      throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
    }) as never);
    try {
      const failing = failDirectoryBarriers();
      const refusal = await initializeCollaborationStore(location).then(
        () => null,
        (error: unknown) => error,
      );
      failing.restore();
      expect(refusal).toMatchObject({ code: "collaboration.unreadable", details: { published: true } });

      // note: The next attempt stages again, meets the competitor again, and only
      // reports success after the continuation confirms the directory entry.
      rmSync(location.dbPath);
      const observer = observeDirectoryBarriers();
      let authority;
      try {
        authority = await initializeCollaborationStore(location);
      } finally {
        const synced = observer.synced();
        observer.restore();
        expect(synced).toBeGreaterThan(0);
      }
      expect(authority.state).toBe("staged");
      expect(authority.repoKey).toBe(location.repoKey);
      expect(metaRecord(location.dbPath).store_id).toBe(authority.storeId);
      const storeDir = dirname(location.dbPath);
      expect(aliasesOf(storeDir, statSync(location.dbPath).ino)).toEqual(["collaboration.db"]);
      expect(stagingLeftovers(storeDir)).toEqual([]);
    } finally {
      competitor.mockRestore();
    }
  });

  test("a refused write leaves the staged or stale database unchanged", async () => {
    const repo = makeRepo("https://github.com/acme/no-mutation.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    await initializeCollaborationStore(location);
    const stagedBytes = readFileSync(location.dbPath);
    expect(journalMode(location.dbPath)).toBe("delete");

    await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({
      code: "collaboration.not-active",
    });
    expect(readFileSync(location.dbPath).equals(stagedBytes)).toBe(true);
    expect(journalMode(location.dbPath)).toBe("delete");
    expect(existsSync(`${location.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${location.dbPath}-shm`)).toBe(false);

    activate(location.dbPath);
    const activeBytes = readFileSync(location.dbPath);
    const authority = await readCollaborationAuthority(context);
    const stale: CollaborationStamp = {
      repoKey: authority.repoKey,
      mode: authority.mode,
      storeId: authority.storeId,
      epoch: authority.epoch + 1,
    };
    await expect(withCollaborationWrite(context, () => "unused", stale)).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
    expect(readFileSync(location.dbPath).equals(activeBytes)).toBe(true);
    expect(journalMode(location.dbPath)).toBe("delete");
    expect(existsSync(`${location.dbPath}-wal`)).toBe(false);
  });

  test("a database moved between admission and the writer open is never recreated", async () => {
    const repo = makeRepo("https://github.com/acme/probe-race.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    await initializeCollaborationStore(location);
    activate(location.dbPath);
    const movedPath = `${location.dbPath}.moved`;

    const realLstat = nodeFs.lstatSync;
    let checks = 0;
    const racer = spyOn(nodeFs, "lstatSync").mockImplementation(((target: string) => {
      if (target === location.dbPath) {
        checks += 1;
        // why: 1: the entry's regular-file check, 2: its private-file check,
        // 3: the read-only probe's guard, 4: the WRITER's guard - so the
        // canonical database is renamed away in the exact window between
        // admission and the writer open.
        if (checks === 4) renameSync(location.dbPath, movedPath);
      }
      return realLstat(target);
    }) as never);
    try {
      await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({
        code: "collaboration.not-initialized",
      });
    } finally {
      racer.mockRestore();
    }
    // note: Nothing was recreated at the authority path; the real store is intact
    // under the name the racing actor moved it to.
    expect(existsSync(location.dbPath)).toBe(false);
    expect(metaRecord(movedPath).authority_state).toBe("active");
  });

  test("a replacement staged file before the writer open is refused untouched", async () => {
    const repo = makeRepo("https://github.com/acme/replacement.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    await initializeCollaborationStore(location);
    activate(location.dbPath);
    const stagedLocation = locationAt(makeRepo("https://github.com/acme/replacement-other.git"));
    await initializeCollaborationStore(stagedLocation);
    const stagedBytes = readFileSync(stagedLocation.dbPath);

    const realLstat = nodeFs.lstatSync;
    let checks = 0;
    const racer = spyOn(nodeFs, "lstatSync").mockImplementation(((target: string) => {
      if (target === location.dbPath) {
        checks += 1;
        // note: 4: the writer's own guard - the admitted file is replaced in place by
        // a staged database after admission passed.
        if (checks === 4) copyFileSync(stagedLocation.dbPath, location.dbPath);
      }
      return realLstat(target);
    }) as never);
    try {
      await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({
        code: "collaboration.stale-binding",
      });
    } finally {
      racer.mockRestore();
    }
    // invariant: The replacement was refused without a journal change or a sidecar.
    expect(readFileSync(location.dbPath).equals(stagedBytes)).toBe(true);
    expect(journalMode(location.dbPath)).toBe("delete");
    expect(existsSync(`${location.dbPath}-wal`)).toBe(false);
  });

  test("a WAL-journal store is refused without opening, repairing or creating a journal", async () => {
    const repo = makeRepo("https://github.com/acme/wal-refusal.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    await initializeCollaborationStore(location);
    activate(location.dbPath);

    // note: A normal DELETE-journal store admits and needs no sidecar.
    const authority = await readCollaborationAuthority(context);
    expect(authority.state).toBe("active");
    expect(existsSync(`${location.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${location.dbPath}-shm`)).toBe(false);

    // invariant: A present WAL sidecar is refused before the database is opened.
    const mainBytes = readFileSync(location.dbPath);
    writeFileSync(`${location.dbPath}-wal`, "wal sidecar presence marker", { mode: 0o600 });
    const sidecarBytes = readFileSync(`${location.dbPath}-wal`);
    await expect(openCollaborationStore(context, "read")).rejects.toMatchObject({
      code: "collaboration.unreadable",
      message: expect.stringContaining("WAL-journal store"),
    });
    await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({
      code: "collaboration.unreadable",
    });
    // note: Nothing was opened, repaired, created or converted.
    expect(readFileSync(location.dbPath).equals(mainBytes)).toBe(true);
    expect(readFileSync(`${location.dbPath}-wal`).equals(sidecarBytes)).toBe(true);
    expect(existsSync(`${location.dbPath}-shm`)).toBe(false);
    rmSync(`${location.dbPath}-wal`, { force: true });

    // invariant: A quiesced WAL file (header WAL, no journal) is refused too, never read
    // immutably and never given a fresh journal.
    const wal = new DatabaseSync(location.dbPath);
    try {
      wal.exec("pragma journal_mode=wal");
    } finally {
      wal.close();
    }
    rmSync(`${location.dbPath}-wal`, { force: true });
    rmSync(`${location.dbPath}-shm`, { force: true });
    await expect(readCollaborationAuthority(context)).rejects.toMatchObject({
      code: "collaboration.unreadable",
      message: expect.stringContaining("header records WAL"),
    });
    expect(existsSync(`${location.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${location.dbPath}-shm`)).toBe(false);
  });

  test("an effect cannot control the wrapper's transaction", async () => {
    const repo = makeRepo("https://github.com/acme/ownership.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    const staged = await initializeCollaborationStore(location);
    activate(location.dbPath);
    const stamp = stampOf(staged);

    const attempts: Array<(write: CollaborationStoreHandle) => unknown> = [
      (write) => write.db.exec("commit"),
      (write) => write.db.exec("/* the wrapper owns it */ rollback"),
      // invariant: A batch whose FIRST statement is ordinary DML still cannot reach its
      // trailing transaction control: `exec` is refused outright.
      (write) => write.db.exec(`${receiptInsert("op-batch")}; commit`),
      (write) => write.db.prepare("end").run(),
      (write) => write.db.exec("savepoint inner"),
      (write) => write.close(),
      // why: SQLite's prepare skips leading empty statements, so a prefixed
      // transaction-control statement is still the statement that would run.
      (write) => write.db.prepare("; commit").run(),
      (write) => write.db.prepare(";; rollback").run(),
      (write) => write.db.prepare("  ; /* lead */ -- then\n ; end").run(),
    ];
    for (const attempt of attempts) {
      await expect(withCollaborationWrite(context, attempt, stamp)).rejects.toMatchObject({
        code: "store.corrupt",
        message: expect.stringContaining("owned"),
      });
    }
    // invariant: No statement of a refused batch ran, and no effect survived.
    expect(receipts(location.dbPath)).toEqual([]);
    // note: The wrapper still owns the transaction and commits a legitimate effect.
    await withCollaborationWrite(
      context,
      (write) => {
        write.db.prepare(receiptInsert("op-owned")).run();
        return "ok";
      },
      stamp,
    );
    expect(receipts(location.dbPath)).toEqual(["op-owned"]);
  });

  test("new directory ancestors are synchronized before success", async () => {
    const freshHome = join(ROOT, `fresh-home-${sequence++}`);
    mkdirSync(freshHome, { recursive: true });
    const previousHome = resolvedHome;
    resolvedHome = freshHome;
    const syncedInodes = new Set<number>();
    try {
      const location = locationAt(makeRepo("https://github.com/acme/ancestors.git"));
      const observer = spyOn(nodeFs, "fsyncSync").mockImplementation(((fd: number) => {
        if (namesDirectory(fd)) syncedInodes.add(fstatSync(fd).ino);
        return REAL_FSYNC(fd);
      }) as never);
      try {
        await initializeCollaborationStore(location);
      } finally {
        observer.mockRestore();
      }
      const anchor = join(freshHome, ".mstar");
      const chain = [
        anchor,
        join(anchor, "repos"),
        join(anchor, "repos", "github.com"),
        join(anchor, "repos", "github.com", "acme"),
        dirname(location.dbPath),
      ];
      for (const dir of chain) expect(syncedInodes.has(statSync(dir).ino)).toBe(true);
    } finally {
      resolvedHome = previousHome;
    }
  });

  test("a failed ancestor barrier is retried on continuation", async () => {
    const freshHome = join(ROOT, `ancestor-retry-${sequence++}`);
    mkdirSync(freshHome, { recursive: true });
    const previousHome = resolvedHome;
    resolvedHome = freshHome;
    try {
      const location = locationAt(makeRepo("https://github.com/acme/ancestor-retry.git"));
      const mstarcDir = join(freshHome, ".mstar");
      // note: Fail only the `.mstar` directory's own barrier: an ancestor, not the
      // store's final directory entry.
      const failing = spyOn(nodeFs, "fsyncSync").mockImplementation(((fd: number) => {
        if (namesDirectory(fd)) {
          let ancestorInode: number | undefined;
          try {
            ancestorInode = statSync(mstarcDir).ino;
          } catch {
            ancestorInode = undefined;
          }
          if (ancestorInode !== undefined && fstatSync(fd).ino === ancestorInode) {
            throw Object.assign(new Error("simulated ancestor fsync failure"), { code: "EIO" });
          }
        }
        return REAL_FSYNC(fd);
      }) as never);
      const refusal = await initializeCollaborationStore(location).then(
        () => null,
        (error: unknown) => error,
      );
      failing.mockRestore();
      expect(refusal).toMatchObject({ code: "collaboration.unreadable", details: { published: true } });
      expect(existsSync(location.dbPath)).toBe(true);

      // why: The retry re-walks the chain, so the ancestor that failed is confirmed
      // again before success is reported.
      const syncedInodes = new Set<number>();
      const observer = spyOn(nodeFs, "fsyncSync").mockImplementation(((fd: number) => {
        if (namesDirectory(fd)) syncedInodes.add(fstatSync(fd).ino);
        return REAL_FSYNC(fd);
      }) as never);
      let authority;
      try {
        authority = await initializeCollaborationStore(location);
      } finally {
        observer.mockRestore();
      }
      expect(authority.repoKey).toBe(location.repoKey);
      const anchor = join(freshHome, ".mstar");
      const chain = [
        anchor,
        join(anchor, "repos"),
        join(anchor, "repos", "github.com"),
        join(anchor, "repos", "github.com", "acme"),
        dirname(location.dbPath),
      ];
      for (const dir of chain) expect(syncedInodes.has(statSync(dir).ino)).toBe(true);
    } finally {
      resolvedHome = previousHome;
    }
  });

  test("open contention keeps the bounded busy refusal", async () => {
    const repo = makeRepo("https://github.com/acme/open-busy.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    await initializeCollaborationStore(location);
    activate(location.dbPath);

    const holder = new DatabaseSync(location.dbPath);
    holder.exec("begin exclusive");
    try {
      await expect(openCollaborationStore(context, "read")).rejects.toMatchObject({ code: "store.busy" });
    } finally {
      try {
        holder.exec("rollback");
      } finally {
        holder.close();
      }
    }
  }, 20_000);

  test("transaction contention keeps the bounded busy refusal", async () => {
    const repo = makeRepo("https://github.com/acme/tx-busy.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    await initializeCollaborationStore(location);
    activate(location.dbPath);

    // note: The store stays in its DELETE journal mode: the holder takes the write
    // reservation, readers proceed, and the guarded writer waits at
    // BEGIN IMMEDIATE for the bounded budget.
    const holder = new DatabaseSync(location.dbPath);
    holder.exec("begin immediate");
    const started = Date.now();
    try {
      await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({ code: "store.busy" });
      // note: The bounded wait ran out at the transaction boundary, not at connect.
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
    } finally {
      try {
        holder.exec("rollback");
      } finally {
        holder.close();
      }
    }
  }, 20_000);

  test("collaboration initialization leaves the execution store and its lazy open unchanged", async () => {
    const repo = makeRepo("https://github.com/acme/legacy.git");
    const context = contextAt(repo);
    await initializeCollaborationStore(locationAt(repo));

    expect(existsSync(join(context.harnessDir, "store.db"))).toBe(false);
    await expect(openStore(context, "read")).rejects.toMatchObject({ code: "store.not-initialized" });

    const handle = await initializeStore(context);
    try {
      expect(handle.schemaVersion).toBe(MIGRATIONS.length);
      const tables = (
        handle.db.prepare("select name from sqlite_master where type = 'table' order by name").all() as Array<{ name: string }>
      ).map((row) => row.name);
      // invariant: The execution store carries its own authority and no collaboration
      // metadata: the two lanes never share a file or a table.
      expect(tables).toEqual(expect.arrayContaining(["execution_meta", "store_meta"]));
      expect(tables).not.toContain("collaboration_meta");
    } finally {
      handle.close();
    }
    // note: The collaboration database stays a separate file with its own schema.
    expect(tableNames(locationAt(repo).dbPath)).toEqual(COLLABORATION_TABLES);
  });
});

describe("collaboration host authority", () => {
  test("an execution-only store never answers for the collaboration lane", async () => {
    const repo = makeRepo("https://github.com/acme/host-execution-only.git");
    const context = contextAt(repo);
    const handle = await initializeStore(context);
    handle.close();
    // invariant: The execution store is ACTIVE, but no collaboration record exists: the
    // probe is `absent`, never a permission and never an execution inference.
    expect(await probeCollaborationAuthority(context)).toMatchObject({
      kind: "absent",
      code: "collaboration.not-initialized",
    });
  });

  test("active, staged and unreadable lanes are named as themselves", async () => {
    const activeRepo = makeRepo("https://github.com/acme/host-active.git");
    // invariant: The fresh-init route: create-only publication plus this checkout's own
    // binding (a raw state flip would legitimately refuse as stale-binding).
    await ensureCollaborationAuthority(contextAt(activeRepo));
    const active = await probeCollaborationAuthority(contextAt(activeRepo));
    expect(active).toMatchObject({
      kind: "active",
      authority: { repoKey: "github.com/acme/host-active", mode: "local", state: "active" },
    });
    // note: The probe is independent of execution: no execution store exists here.
    expect(existsSync(join(contextAt(activeRepo).harnessDir, "store.db"))).toBe(false);

    const stagedRepo = makeRepo("https://github.com/acme/host-staged.git");
    await initializeCollaborationStore(locationAt(stagedRepo));
    expect(await probeCollaborationAuthority(contextAt(stagedRepo))).toMatchObject({
      kind: "staged",
      code: "collaboration.not-active",
    });

    const brokenRepo = makeRepo("https://github.com/acme/host-broken.git");
    mkdirSync(locationAt(brokenRepo).dbPath, { recursive: true });
    expect(await probeCollaborationAuthority(contextAt(brokenRepo))).toMatchObject({
      kind: "unavailable",
      code: "collaboration.unreadable",
    });
  });

  test("a rejected storage component is unavailable, never a missing database", async () => {
    const repo = makeRepo("https://github.com/acme/host-rejected.git");
    const context = contextAt(repo);
    await ensureCollaborationAuthority(context);
    const dbPath = locationAt(repo).dbPath;
    // note: A dangling symlink in the storage chain hides the database from a plain
    // existence test while admission rejects the component itself.
    const component = dirname(dirname(dbPath));
    rmSync(component, { recursive: true, force: true });
    symlinkSync(join(ROOT, "does-not-exist"), component);

    const probe = await probeCollaborationAuthority(context);
    expect(probe).toMatchObject({ kind: "unavailable", code: "collaboration.unreadable" });
    if (probe.kind !== "unavailable") throw new Error("expected unavailable");
    expect(probe.message).toContain("storage component is a symbolic link");
  });

  test("an unresolved identity or refused remote selection is unavailable, never absent", async () => {
    const originless = join(ROOT, `repo-host-originless-${sequence++}`);
    mkdirSync(originless, { recursive: true });
    git(originless, "init", "-q");
    writeFileSync(join(originless, ".mstarc"), "[collaboration]\nmode=local\n");
    expect(await probeCollaborationAuthority(contextAt(originless))).toMatchObject({
      kind: "unavailable",
      code: "collaboration.repo-identity-unresolved",
    });

    // invariant: An unreachable origin never selects the remote authority, and the probe
    // discloses that as unavailable rather than as a missing lane.
    const remote = makeRepo("ssh://git@127.0.0.1:1/acme/host-remote.git");
    writeFileSync(join(remote, ".mstarc"), "[collaboration]\nmode=remote\n");
    expect(await probeCollaborationAuthority(contextAt(remote))).toMatchObject({
      kind: "unavailable",
      code: "remote.selector-unavailable",
    });
  });

  test("a remote checkout binding is validated strictly and never authorizes a local lane", async () => {
    const repo = makeRepo("https://github.com/acme/widgets.git");
    const context = contextAt(repo);
    const bindingFile = join(context.harnessDir, "collaboration-binding.json");
    const remoteBinding = (overrides: Record<string, unknown> = {}): string =>
      JSON.stringify({
        version: 3,
        state: "active",
        repoKey: "github.com/acme/widgets",
        mode: "remote",
        selectorCommit: "a".repeat(40),
        generation: 2,
        storeId: "fixture-remote-store",
        epoch: 1,
        boundAt: "2026-11-22T00:00:00.000Z",
        ...overrides,
      });

    // note: The positive shape parses; every deviation below refuses as stale, not as fresh.
    writeFileSync(bindingFile, remoteBinding());
    expect(readCollaborationBinding(context)).toMatchObject({ version: 3, generation: 2 });
    for (const overrides of [
      { state: "claimed" },
      { generation: 0 },
      { generation: "2" },
      { selectorCommit: "not-an-object-id" },
      { mode: "local" },
      { storeId: undefined },
    ]) {
      writeFileSync(bindingFile, remoteBinding(overrides));
      expect(() => readCollaborationBinding(context)).toThrow("collaboration.stale-binding");
    }

    // invariant: A checkout recorded against a remote selector never drifts onto the local
    // rows: a live-confirmed absence of that recorded selector refuses the resolution before
    // any admission can open them.
    writeFileSync(bindingFile, remoteBinding());
    expect(() => locationAt(repo)).toThrow("collaboration.stale-binding");
    await expect(openCollaborationStore(context, "read")).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
  });
});

// ---------------------------------------------------------------------------
// note: v2 `collaboration-remote-cache`: the explicit upgrade and its backfill
// ---------------------------------------------------------------------------

/** note: A real v1 lane: the immutable v1 migration, its ledger row, and an active record. */
function writeV1Lane(location: CollaborationLocation, seed?: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(location.dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(location.dbPath);
  try {
    db.exec(SCHEMA_VERSION_TABLE_SQL);
    const v1 = COLLABORATION_MIGRATIONS[0]!;
    db.exec(v1.sql);
    db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
      v1.version,
      v1.name,
      migrationChecksum(v1),
      "2026-11-21T00:00:00.000Z",
    );
    db.prepare(
      "insert into collaboration_meta(id, repository_key, mode, store_id, authority_state, authority_epoch, revision, " +
        "catalog_revision, created_at, activated_at) values (1, ?, 'local', 'v1-store', 'active', 1, 2, 0, ?, ?)",
    ).run(location.repoKey, "2026-11-21T00:00:00.000Z", "2026-11-21T00:00:00.000Z");
    seed?.(db);
  } finally {
    db.close();
  }
  chmodSync(location.dbPath, 0o600);
}

/** note: A real v2 lane with no issue rows: the v1 body, the v2 delta and its ledger row. */
function writeV2Lane(location: CollaborationLocation, seed?: (db: DatabaseSync) => void): void {
  writeV1Lane(location);
  const db = new DatabaseSync(location.dbPath);
  try {
    const v2 = COLLABORATION_MIGRATIONS[1]!;
    db.exec(v2.sql);
    db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
      v2.version,
      v2.name,
      migrationChecksum(v2),
      "2026-11-21T00:00:00.000Z",
    );
    seed?.(db);
  } finally {
    db.close();
  }
  chmodSync(location.dbPath, 0o600);
}

/** note: A real v3 lane: the v2 body, the outbox delta and its ledger row. */
function writeV3Lane(location: CollaborationLocation, seed?: (db: DatabaseSync) => void): void {
  writeV2Lane(location);
  const db = new DatabaseSync(location.dbPath);
  try {
    const v3 = COLLABORATION_MIGRATIONS[2]!;
    db.exec(v3.sql);
    db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
      v3.version,
      v3.name,
      migrationChecksum(v3),
      "2026-11-21T00:00:00.000Z",
    );
    seed?.(db);
  } finally {
    db.close();
  }
  chmodSync(location.dbPath, 0o600);
}

/** note: A real v4 lane: the immutable v1-v4 migrations in order, their ledger rows and one issue. */
function writeV4Lane(location: CollaborationLocation, seed?: (db: DatabaseSync) => void): void {
  writeV1Lane(location);
  const db = new DatabaseSync(location.dbPath);
  try {
    for (const migration of COLLABORATION_MIGRATIONS.slice(1, 4)) {
      db.exec(migration.sql);
      db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
        migration.version,
        migration.name,
        migrationChecksum(migration),
        "2026-11-21T00:00:00.000Z",
      );
    }
    db.prepare(
      "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) " +
        "values ('project', 'p-dest', 'Destination', 'projects', 'projects/p-dest', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
    ).run();
    seed?.(db);
  } finally {
    db.close();
  }
  chmodSync(location.dbPath, 0o600);
}

/** note: The v3 lane as a REMOTE cache: `remote` lanes are only ever written by the reviewed bind. */
function writeV3RemoteLane(location: CollaborationLocation): void {
  writeV3Lane(location);
  const db = new DatabaseSync(location.dbPath);
  try {
    db.prepare("update collaboration_meta set mode = 'remote' where id = 1").run();
  } finally {
    db.close();
  }
  chmodSync(location.dbPath, 0o600);
}

/** note: One v4 `issue_moves` half row, exactly as the v4 writers recorded it — no `route` column. */
function seedV4MoveRow(
  db: DatabaseSync,
  row: Readonly<{
    issueRef?: string;
    operationId: string;
    role: "source" | "destination";
    sourceAuthority: string;
    destinationAuthority: string;
    sourceIssueId?: string;
    phase?: string;
  }>,
): void {
  db.prepare(
    "insert into issue_moves(operation_id, role, request_hash, issue_ref, source_issue_id, destination_issue_id, " +
      "source_authority, destination_authority, destination_project, actor, reason, phase, payload_json, payload_digest, " +
      "staged_counts, source_store_id, source_epoch, removed_sync_rows, created_at, updated_at) " +
      "values (?, ?, 'hash', ?, ?, null, ?, ?, 'p-dest', " +
      "'project-manager', 'v4 move', ?, '{}', 'digest', '{}', 'v4-store', 1, 0, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
  ).run(
    row.operationId,
    row.role,
    row.issueRef ?? "mstar:issue:99999999-9999-4999-8999-999999999999",
    row.sourceIssueId ?? null,
    row.sourceAuthority,
    row.destinationAuthority,
    row.phase ?? "staged",
  );
}

/** note: Two issues with one occurrence: the history the upgrade must preserve. */
function seedV1History(db: DatabaseSync): void {
  const insert = db.prepare(
    "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key) " +
      "values (?, 'fixture-project', ?, 'bug', 'high', 'resolved', 'i', 'a', ?, ?, ?)",
  );
  insert.run("I-000001", "First", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "key-one");
  insert.run("I-000002", "Second", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z", "key-two");
  db.prepare(
    "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, " +
      "location, observed_behavior, evidence_json, recorded_at) values ('I-000001', 'occ-1', 'review', 'src', 'rc', 'ac', " +
      "'loc', 'obs', '[]', '2026-11-01T00:00:00.000Z')",
  ).run();
  db.prepare(
    "insert into relations(from_issue, relation, to_issue) values ('I-000001', 'related', 'I-000002')",
  ).run();
}

function issueRefs(dbPath: string): Array<{ id: string; issue_ref: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("select id, issue_ref from issues order by id").all() as Array<{ id: string; issue_ref: string }>;
  } finally {
    db.close();
  }
}

/** note: The lane's retained issue rows, for a refusal that must leave history untouched. */
function issueCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select count(*) as n from issues").get() as { n?: unknown } | undefined;
    return typeof row?.n === "number" ? row.n : 0;
  } finally {
    db.close();
  }
}

/** note: The applied ladder every current lane carries, derived from this build's migrations. */
const LADDER_VERSIONS: readonly number[] = COLLABORATION_MIGRATIONS.map((migration) => migration.version);
const CURRENT_VERSION = COLLABORATION_MIGRATIONS[COLLABORATION_MIGRATIONS.length - 1]!.version;

function ledgerVersions(dbPath: string): number[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("select version from schema_version order by version").all() as Array<{ version: number }>).map(
      (row) => row.version,
    );
  } finally {
    db.close();
  }
}

/** note: The recorded ledger exactly as the lane holds it, for no-mutation assertions. */
function ledgerRows(dbPath: string): Array<{ version: number; name: string; checksum: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("select version, name, checksum from schema_version order by version").all() as Array<{
      version: number;
      name: string;
      checksum: string;
    }>;
  } finally {
    db.close();
  }
}

function hasColumn(dbPath: string, table: string, column: string): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).some(
      (entry) => entry.name === column,
    );
  } finally {
    db.close();
  }
}

describe("collaboration remote schema ladder", () => {
  test("an explicit upgrade preserves v1 history and backfills one stable reference per issue", async () => {
    const repo = makeRepo("https://github.com/v2-upgrade/upgrade.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    writeV1Lane(location, seedV1History);
    activate(location.dbPath);
    expect(ledgerVersions(location.dbPath)).toEqual([1]);
    expect(hasColumn(location.dbPath, "issues", "issue_ref")).toBe(false);

    // invariant: Ordinary reads never migrate an admitted old lane: both name the upgrade.
    await expect(readCollaborationAuthority(context)).rejects.toMatchObject({ code: "collaboration.upgrade-required" });
    await expect(initializeCollaborationStore(location)).rejects.toMatchObject({
      code: "collaboration.upgrade-required",
    });
    await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({
      code: "collaboration.upgrade-required",
    });
    expect(ledgerVersions(location.dbPath)).toEqual([1]);

    const receipt = await upgradeCollaborationStore(context, "ops-engineer");
    expect(receipt).toMatchObject({
      version: 1,
      fromVersion: 1,
      toVersion: LANE_CURRENT_VERSION,
      storeId: "v1-store",
      epoch: 1,
      issuesBackfilled: 2,
    });
    expect(ledgerVersions(location.dbPath)).toEqual(LANE_LEDGER_VERSIONS);

    const refs = issueRefs(location.dbPath);
    expect(refs.map((row) => row.id)).toEqual(["I-000001", "I-000002"]);
    for (const row of refs) assertIssueRef(row.issue_ref);
    expect(new Set(refs.map((row) => row.issue_ref)).size).toBe(2);

    // invariant: History and the lane's recorded revision survive the rebuild verbatim.
    const history = new DatabaseSync(location.dbPath);
    try {
      expect((history.prepare("select count(*) as n from occurrences").get() as { n: number }).n).toBe(1);
      expect((history.prepare("select count(*) as n from relations").get() as { n: number }).n).toBe(1);
      expect((history.prepare("select revision from collaboration_meta where id = 1").get() as { revision: number }).revision).toBe(2);
    } finally {
      history.close();
    }

    // invariant: A committed upgrade replays by revalidating: no second backfill, same refs.
    const replay = await upgradeCollaborationStore(context, "ops-engineer");
    expect(replay).toMatchObject({ fromVersion: LANE_CURRENT_VERSION, toVersion: LANE_CURRENT_VERSION, issuesBackfilled: 0 });
    expect(issueRefs(location.dbPath)).toEqual(refs);
    expect(ledgerVersions(location.dbPath)).toEqual(LANE_LEDGER_VERSIONS);
    expect((await readCollaborationAuthority(context)).schemaVersion).toBe(LANE_CURRENT_VERSION);
  });

  test("a malformed, partial or foreign-scope lane refuses without mutation", async () => {
    // note: A recorded v1 checksum that is not this build's immutable migration.
    const wrongChecksumRepo = makeRepo("https://github.com/v2-upgrade/wrong-checksum.git");
    const wrongChecksum = locationAt(wrongChecksumRepo);
    writeV1Lane(wrongChecksum, (db) => db.prepare("update schema_version set checksum = ? where version = 1").run("f".repeat(64)));
    activate(wrongChecksum.dbPath);
    await expect(upgradeCollaborationStore(contextAt(wrongChecksumRepo), "ops-engineer")).rejects.toMatchObject({
      code: "store.corrupt",
    });
    expect(ledgerVersions(wrongChecksum.dbPath)).toEqual([1]);

    // note: A v2 table without its ledger row is a partial apply: refused, never re-applied.
    const partialRepo = makeRepo("https://github.com/v2-upgrade/partial.git");
    const partial = locationAt(partialRepo);
    writeV1Lane(partial, (db) => db.exec("create table remote_bindings(generation integer)"));
    activate(partial.dbPath);
    await expect(upgradeCollaborationStore(contextAt(partialRepo), "ops-engineer")).rejects.toMatchObject({
      code: "collaboration.unreadable",
    });
    expect(ledgerVersions(partial.dbPath)).toEqual([1]);

    // note: Half of the issues rebuild (the column already added) is the one shape that would
    // otherwise re-mint stable references: it refuses instead.
    const halfRepo = makeRepo("https://github.com/v2-upgrade/half.git");
    const half = locationAt(halfRepo);
    writeV1Lane(half, (db) => db.exec("alter table issues add column issue_ref text"));
    activate(half.dbPath);
    await expect(upgradeCollaborationStore(contextAt(halfRepo), "ops-engineer")).rejects.toMatchObject({
      code: "store.corrupt",
      message: expect.stringContaining("partially applied v2"),
    });
    expect(ledgerVersions(half.dbPath)).toEqual([1]);

    // invariant: The upgrade records the operator it attests.
    const anonymous = makeRepo("https://github.com/v2-upgrade/anonymous.git");
    writeV1Lane(locationAt(anonymous));
    activate(locationAt(anonymous).dbPath);
    await expect(upgradeCollaborationStore(contextAt(anonymous), "  ")).rejects.toMatchObject({
      code: "store.attestation-invalid",
    });
    expect(ledgerVersions(locationAt(anonymous).dbPath)).toEqual([1]);
  });

  test("upgrade replay revalidates the v2 key and CHECK layout", async () => {
    const repo = makeRepo("https://github.com/v2-upgrade/replay-layout.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    writeV1Lane(location, seedV1History);
    activate(location.dbPath);
    await upgradeCollaborationStore(context, "ops-engineer");

    const db = new DatabaseSync(location.dbPath);
    try {
      db.exec("alter table remote_observations add column leaked text");
    } finally {
      db.close();
    }
    await expect(upgradeCollaborationStore(context, "ops-engineer")).rejects.toMatchObject({
      code: "collaboration.unreadable",
    });
    expect(ledgerVersions(location.dbPath)).toEqual(LANE_LEDGER_VERSIONS);
  });

  test("a current lane whose recorded migration name or checksum is unknown refuses admission and replay", async () => {
    const altered = [
      { version: 1, column: "checksum", value: "e".repeat(64) },
      { version: 2, column: "checksum", value: "e".repeat(64) },
      { version: 3, column: "checksum", value: "e".repeat(64) },
      { version: LANE_CURRENT_VERSION, column: "checksum", value: "e".repeat(64) },
      { version: 3, column: "name", value: "foreign-outbox" },
    ] as const;
    for (const [index, change] of altered.entries()) {
      const repo = makeRepo(`https://github.com/v2-upgrade/checksum-${String(index)}.git`);
      const context = contextAt(repo);
      const location = locationAt(repo);
      writeV1Lane(location, seedV1History);
      activate(location.dbPath);
      await upgradeCollaborationStore(context, "ops-engineer");
      const db = new DatabaseSync(location.dbPath);
      try {
        db.prepare(`update schema_version set ${change.column} = ? where version = ?`).run(change.value, change.version);
      } finally {
        db.close();
      }
      const before = ledgerRows(location.dbPath);

      // invariant: Neither admission nor the already-current upgrade replay trusts a
      // ledger row whose bytes are not this build's compiled migration.
      await expect(readCollaborationAuthority(context)).rejects.toMatchObject({ code: "collaboration.unreadable" });
      await expect(upgradeCollaborationStore(context, "ops-engineer")).rejects.toMatchObject({ code: "store.corrupt" });
      expect(ledgerRows(location.dbPath)).toEqual(before);
    }
  });

  test("a stale or unbound checkout never migrates a v1 lane it does not own", async () => {
    // note: A same-repository v1 lane replaced by another generation while this checkout still
    // records the superseded store: repository and mode alone must not admit the mutation.
    const staleRepo = makeRepo("https://github.com/v2-upgrade/stale-generation.git");
    const staleContext = contextAt(staleRepo);
    const stale = locationAt(staleRepo);
    writeV1Lane(stale, seedV1History);
    activate(stale.dbPath);
    writeCollaborationBinding(staleContext, {
      repoKey: stale.repoKey,
      mode: "local",
      storeId: "superseded-store",
      epoch: 3,
    });

    await expect(upgradeCollaborationStore(staleContext, "ops-engineer")).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
    // invariant: No DDL, no backfill and no receipt landed on the lane this checkout does not own.
    expect(ledgerVersions(stale.dbPath)).toEqual([1]);
    expect(hasColumn(stale.dbPath, "issues", "issue_ref")).toBe(false);
    expect(issueCount(stale.dbPath)).toBe(2);

    // note: An unbound checkout (a replacement clone) reads the lane but never upgrades it.
    const unboundRepo = makeRepo("https://github.com/v2-upgrade/unbound-generation.git");
    const unbound = locationAt(unboundRepo);
    writeV1Lane(unbound, seedV1History);
    await expect(upgradeCollaborationStore(contextAt(unboundRepo), "ops-engineer")).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
    expect(ledgerVersions(unbound.dbPath)).toEqual([1]);
    expect(hasColumn(unbound.dbPath, "issues", "issue_ref")).toBe(false);
    expect(issueCount(unbound.dbPath)).toBe(2);

    // invariant: The refusal was ownership, not bytes: the owning checkout still migrates the lane.
    activate(stale.dbPath);
    expect(await upgradeCollaborationStore(staleContext, "ops-engineer")).toMatchObject({
      fromVersion: 1,
      toVersion: LANE_CURRENT_VERSION,
      storeId: "v1-store",
      issuesBackfilled: 2,
    });
    expect(ledgerVersions(stale.dbPath)).toEqual(LANE_LEDGER_VERSIONS);
  });

  test("an unbound checkout adopts an intact v1 lane, then upgrades it", async () => {
    const repo = makeRepo("https://github.com/v2-upgrade/adopt-v1.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    writeV1Lane(location, (db) => {
      seedV1History(db);
      // note: The durable creation receipt of the activation that published this generation,
      // the same evidence a real `store init` records.
      db.prepare(
        "insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at) " +
          "values ('standalone', ?, ?, ?, ?)",
      ).run(
        "creation:v1-store:1",
        "fixture",
        JSON.stringify({
          version: 1,
          producer: "store-init",
          storeId: "v1-store",
          epoch: 1,
          repoKey: location.repoKey,
          mode: location.mode,
          createdAt: "2026-11-21T00:00:00.000Z",
        }),
        "2026-11-21T00:00:00.000Z",
      );
    });

    // invariant: Without a binding, the v1 lane is inspection-only: the ordinary open refuses
    // and the upgrade's ownership gate refuses, so adoption is the supported recovery.
    await expect(openCollaborationStore(context, "read")).rejects.toMatchObject({
      code: "collaboration.upgrade-required",
    });
    await expect(upgradeCollaborationStore(context, "ops-engineer")).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });

    const adopted = await adoptCollaborationBinding(context);
    expect(adopted).toMatchObject({ adopted: true, authority: { storeId: "v1-store", schemaVersion: 1 } });
    expect(readCollaborationBinding(context)).toMatchObject({
      version: 2,
      state: "active",
      storeId: "v1-store",
      epoch: 1,
    });
    // invariant: Adoption proved the v1 bytes without migrating them.
    expect(ledgerVersions(location.dbPath)).toEqual([1]);

    const upgraded = await upgradeCollaborationStore(context, "ops-engineer");
    expect(upgraded).toMatchObject({
      fromVersion: 1,
      toVersion: LANE_CURRENT_VERSION,
      storeId: "v1-store",
      issuesBackfilled: 2,
    });
    expect(ledgerVersions(location.dbPath)).toEqual(LANE_LEDGER_VERSIONS);
    expect(issueCount(location.dbPath)).toBe(2);
  });

  test("a v2 lane gains the exact outbox tables and a partial v3 refuses without mutation", async () => {
    const repo = makeRepo("https://github.com/v3-upgrade/v2-to-v3.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    writeV2Lane(location);
    activate(location.dbPath);
    expect(ledgerVersions(location.dbPath)).toEqual([1, 2]);
    expect(tableNames(location.dbPath)).not.toContain("remote_outbox");
    await expect(readCollaborationAuthority(context)).rejects.toMatchObject({ code: "collaboration.upgrade-required" });

    const receipt = await upgradeCollaborationStore(context, "ops-engineer");
    expect(receipt).toMatchObject({
      fromVersion: 2,
      toVersion: LANE_CURRENT_VERSION,
      storeId: "v1-store",
      issuesBackfilled: 0,
    });
    expect(ledgerVersions(location.dbPath)).toEqual(LANE_LEDGER_VERSIONS);
    expect(tableNames(location.dbPath)).toEqual(COLLABORATION_TABLES);
    // invariant: The upgraded lane admits as current only when the outbox keys, state
    // vocabulary and composite binding key match the declared v3 layout.
    expect((await readCollaborationAuthority(context)).schemaVersion).toBe(LANE_CURRENT_VERSION);

    // note: Half of the v3 delta (one outbox table without its ledger row) is a partial apply.
    const partialRepo = makeRepo("https://github.com/v3-upgrade/partial-v3.git");
    const partial = locationAt(partialRepo);
    writeV2Lane(partial, (partialDb) => partialDb.exec("create table remote_outbox(operation_id text primary key)"));
    activate(partial.dbPath);
    await expect(upgradeCollaborationStore(contextAt(partialRepo), "ops-engineer")).rejects.toMatchObject({
      code: "collaboration.unreadable",
    });
    expect(ledgerVersions(partial.dbPath)).toEqual([1, 2]);
    expect(tableNames(partial.dbPath)).not.toContain("remote_outbox_receipts");
  });

  test("a v3 lane's dated milestone reaches the effort column with its linked issue intact", async () => {
    const repo = makeRepo("https://github.com/v4-upgrade/milestone-effort.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    writeV3Lane(location, (db) => {
      db.exec(
        "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) " +
          "values ('project', 'p-one', 'Project One', 'projects', 'p-one/roadmap.md', " +
          "'2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');" +
        "insert into project_milestones(milestone_id, project_id, project_kind, name, target, status, ordinal, revision, created_at, updated_at) " +
          "values ('m-one', 'p-one', 'project', 'Milestone One', '2026-12-01', 'planned', 0, 1, " +
          "'2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');" +
          "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, " +
          "updated_at, identity_key, issue_ref, milestone_id) values ('I-000001', 'p-one', 'Linked', 'bug', 'high', " +
          "'open', 'i', 'a', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'effort-key', " +
          "'mstar:issue:00000000-0000-4000-8000-000000000eff1', 'm-one');",
      );
    });
    activate(location.dbPath);
    expect(ledgerVersions(location.dbPath)).toEqual(COLLABORATION_MIGRATIONS.slice(0, 3).map(({ version }) => version));
    expect(hasColumn(location.dbPath, "project_milestones", "target")).toBe(true);
    await expect(readCollaborationAuthority(context)).rejects.toMatchObject({ code: "collaboration.upgrade-required" });

    const receipt = await upgradeCollaborationStore(context, "ops-engineer");
    expect(receipt).toMatchObject({ fromVersion: 3, toVersion: LANE_CURRENT_VERSION, issuesBackfilled: 0 });
    expect(ledgerVersions(location.dbPath)).toEqual(LANE_LEDGER_VERSIONS);
    // invariant: The former date reads as unestimated and the issue keeps its link; the column
    // really moved, so the old name is gone from the table.
    const db = new DatabaseSync(location.dbPath);
    try {
      expect(db.prepare("select effort_sessions, status from project_milestones where milestone_id = 'm-one'").get())
        .toEqual({ effort_sessions: null, status: "planned" });
      expect(db.prepare("select milestone_id from issues where id = 'I-000001'").get()).toEqual({ milestone_id: "m-one" });
    } finally {
      db.close();
    }
    expect(hasColumn(location.dbPath, "project_milestones", "effort_sessions")).toBe(true);
    expect(hasColumn(location.dbPath, "project_milestones", "target")).toBe(false);
    expect((await readCollaborationAuthority(context)).schemaVersion).toBe(LANE_CURRENT_VERSION);
  });

  test("a v4 lane reaches the effort column without re-proving or re-running the move DDL", async () => {
    const repo = makeRepo("https://github.com/v4-upgrade/from-v4.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    writeV4Lane(location);
    activate(location.dbPath);
    expect(ledgerVersions(location.dbPath)).toEqual(COLLABORATION_MIGRATIONS.slice(0, 4).map(({ version }) => version));
    await expect(readCollaborationAuthority(context)).rejects.toMatchObject({ code: "collaboration.upgrade-required" });

    const receipt = await upgradeCollaborationStore(context, "ops-engineer");
    expect(receipt).toMatchObject({ fromVersion: 4, toVersion: LANE_CURRENT_VERSION });
    expect(ledgerVersions(location.dbPath)).toEqual(LANE_LEDGER_VERSIONS);
    expect(hasColumn(location.dbPath, "project_milestones", "effort_sessions")).toBe(true);
    expect(hasColumn(location.dbPath, "project_milestones", "target")).toBe(false);
  });

  test("a lane stopped between the effort DDL and its ledger row refuses without mutation", async () => {
    const repo = makeRepo("https://github.com/v4-upgrade/partial-v4.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    // note: The crash window: the v5 DDL committed, its ledger row did not.
    writeV3Lane(location, (db) => {
      const move = COLLABORATION_MIGRATIONS[3]!;
      db.exec(move.sql);
      db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
        move.version,
        move.name,
        migrationChecksum(move),
        "2026-11-21T00:00:00.000Z",
      );
      db.exec(COLLABORATION_MIGRATIONS[4]!.sql);
      db.exec(COLLABORATION_MIGRATIONS[5]!.sql);
    });
    activate(location.dbPath);
    const before = ledgerRows(location.dbPath);

    await expect(upgradeCollaborationStore(context, "ops-engineer")).rejects.toMatchObject({
      code: "collaboration.unreadable",
    });
    // invariant: The refusal is the partial-apply proof, and nothing was repaired: the ledger and
    // the altered table keep exactly the crashed shape.
    expect(ledgerRows(location.dbPath)).toEqual(before);
    expect(hasColumn(location.dbPath, "project_milestones", "effort_sessions")).toBe(true);
    expect(hasColumn(location.dbPath, "project_milestones", "target")).toBe(false);
  });

  test("a v3 outbox whose nullable columns drifted refuses the upgrade and its settlement admission", async () => {
    // note: `execution_key_json` is the ONE outbox column no key-layout check names (it is nullable
    // and no index covers it), so this drift is admitted by the columns check alone. That is exactly
    // the case `COLLABORATION_V3_COLUMNS` exists for: every settlement verb selects this column.
    const drift = (db: DatabaseSync): void => {
      db.exec("alter table remote_outbox drop column execution_key_json");
    };

    // note: A LOCAL v3 lane - the shape `store upgrade` advances - built from the released
    // migration bodies, then drifted on its own outbox columns.
    const repo = makeRepo("https://github.com/v4-upgrade/outbox-drift.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    writeV2Lane(location);
    const drifted = new DatabaseSync(location.dbPath);
    try {
      const v3 = COLLABORATION_MIGRATIONS[2]!;
      drifted.exec(v3.sql);
      drifted.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
        v3.version,
        v3.name,
        migrationChecksum(v3),
        "2026-11-21T00:00:00.000Z",
      );
      drift(drifted);
    } finally {
      drifted.close();
    }
    activate(location.dbPath);
    expect(ledgerVersions(location.dbPath)).toEqual([1, 2, 3]);
    const ledgerBefore = ledgerRows(location.dbPath);
    // invariant: The v4 DDL is applied over a proven v3 shape, so a drifted outbox refuses BEFORE
    // the ladder and records no migration at all.
    await expect(upgradeCollaborationStore(context, "ops-engineer")).rejects.toMatchObject({
      code: "collaboration.unreadable",
    });
    expect(ledgerRows(location.dbPath)).toEqual(ledgerBefore);
    expect(ledgerVersions(location.dbPath)).toEqual([1, 2, 3]);
    expect(tableNames(location.dbPath)).not.toContain("issue_moves");

    // invariant: The settlement admission proves the same columns before it serves the generation,
    // so a drifted cache is a NAMED lane refusal instead of a raw "no such column" out of the
    // first outbox query.
    const cacheFixture = remoteFixture("remote-v3-drifted-outbox");
    const commit = cacheFixture.publish(cacheFixture.payload());
    const generation = Number(cacheFixture.payload().generation);
    const cacheContext = contextAt(cacheFixture.repo);
    const cacheLocation = locationAt(cacheFixture.repo);
    writeV3RemoteLane(cacheLocation);
    const cacheMeta = metaRecord(cacheLocation.dbPath);
    writeRemoteCollaborationBinding(cacheContext, {
      repoKey: cacheFixture.repoKey,
      selectorCommit: commit,
      generation,
      storeId: cacheMeta.store_id,
      epoch: cacheMeta.authority_epoch,
    });
    const cacheDrift = new DatabaseSync(cacheLocation.dbPath);
    try {
      drift(cacheDrift);
    } finally {
      cacheDrift.close();
    }
    const refused = await refusalOf(() =>
      readRemoteIntent(cacheContext, "00000000-0000-4000-8000-0000000007f1"),
    );
    expect(refused.code).toBe("collaboration.unreadable");
    expect(refused.message).toContain("collaboration store");
    expect(refused.message).toContain("remote_outbox");
  });
});

// ---------------------------------------------------------------------------
// note: Remote observation cache: explicit bind, scoped ingest and status
// ---------------------------------------------------------------------------

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

const SECOND_PROJECT = {
  ...SELECTED_PROJECT,
  localProjectId: "fixture-second",
  projectId: "99999999-9999-4999-8999-999999999999",
  journalIssueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} as const;

/**
 * note: One isolated remote fixture: a unique canonical origin (so its lane path is its own),
 * the checkout that resolves it, and the bare origin its selector is published to.
 */
function remoteFixture(name: string): {
  repoKey: string;
  repo: string;
  payload(overrides?: Record<string, unknown>): Record<string, unknown>;
  publish(payload: Record<string, unknown>): string;
} {
  const slug = `${name}-${sequence++}`;
  const origin = `https://github.com/remote-fixture/${slug}.git`;
  const repoKey = `github.com/remote-fixture/${slug}`;
  const bare = join(ROOT, `remote-origin-${slug}.git`);
  git(ROOT, "init", "-q", "--bare", bare);
  const repo = join(ROOT, `remote-repo-${slug}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Remote Store Test");
  git(repo, "config", "user.email", "remote-store@example.test");
  git(repo, "config", "remote.origin.url", origin);
  git(repo, "config", `url.${bare}.insteadOf`, origin);
  writeFileSync(join(repo, ".mstarc"), "[collaboration]\nmode=remote\n");
  const publisher = join(ROOT, `remote-publisher-${slug}`);
  mkdirSync(publisher, { recursive: true });
  git(publisher, "init", "-q");
  git(publisher, "config", "user.name", "Remote Selector Test");
  git(publisher, "config", "user.email", "publisher@example.test");
  return {
    repoKey,
    repo,
    payload(overrides = {}) {
      return {
        version: 1,
        repoKey,
        generation: 3,
        mode: "remote",
        phase: "active",
        projects: [SELECTED_PROJECT],
        previous: null,
        cutover: null,
        ...overrides,
      };
    },
    publish(payload) {
      writeFileSync(join(publisher, "authority.json"), `${JSON.stringify(payload, null, 2)}\n`);
      git(publisher, "add", "authority.json");
      git(publisher, "commit", "-q", "-m", "publish selector");
      git(publisher, "push", "-q", "--force", bare, `HEAD:${SELECTOR_REF}`);
      return git(publisher, "rev-parse", "HEAD");
    },
  };
}

const MSTAR_ISSUE = "66666666-6666-4666-8666-666666666666";
const PROVIDER_ONLY_ISSUE = "77777777-7777-4777-8777-777777777777";
const FORGED_ISSUE_REF = "mstar:issue:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ISSUE_REF = "mstar:issue:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function providerScope(project: typeof SELECTED_PROJECT | typeof SECOND_PROJECT = SELECTED_PROJECT) {
  return {
    provider: "linear" as const,
    workspaceId: project.workspaceId,
    teamId: project.teamId,
    projectId: project.projectId,
  };
}

function positiveCheck(overrides: Partial<ScopeCheck> = {}): ScopeCheck {
  return {
    projectId: SELECTED_PROJECT.localProjectId,
    scope: providerScope(),
    journalIssueId: SELECTED_PROJECT.journalIssueId,
    checkedAt: new Date(Date.now() - 1_000).toISOString(),
    outcome: {
      kind: "verified",
      readerId: "reader-one",
      writerId: SELECTED_PROJECT.writerId,
      capabilities: {
        fullRead: true,
        appendOnly: true,
        exactLookup: true,
        fieldFidelity: true,
        privateAudience: true,
      },
    },
    ...overrides,
  };
}

/** note: A complete fixture scope: project binding, milestones, roadmap, portable catalog and history. */
function completeSnapshot(check: ScopeCheck = positiveCheck()): RemoteSnapshot {
  const at = "2026-11-20T00:00:00.000Z";
  return {
    asOf: new Date(Date.parse(check.checkedAt) - 5_000).toISOString(),
    coverage: { kind: "complete" },
    project: {
      projectId: check.projectId,
      head: ["1".repeat(64)],
      binding: check.scope,
      milestones: [
        {
          milestoneId: "milestone-1",
          name: "First delivery",
          effortSessions: 3,
          status: "active",
          ordinal: 0,
          revision: 1,
          createdAt: at,
          updatedAt: at,
        },
      ],
      roadmap: { contentMarkdown: "# Roadmap\n", revision: 2, updatedAt: at },
      catalogEntities: [
        {
          kind: "project",
          id: "fixture-project",
          title: "Fixture project",
          description: null,
          documentKind: null,
          lifecycle: "active",
          revision: 1,
        },
        {
          kind: "plan",
          id: "plan-1",
          title: "Plan one",
          description: "d",
          documentKind: null,
          lifecycle: "active",
          revision: 1,
        },
        {
          kind: "document",
          id: "spec-1",
          title: "Spec one",
          description: null,
          documentKind: "spec",
          lifecycle: "active",
          revision: 1,
        },
      ],
      catalogLinks: [
        { fromKind: "plan", fromId: "plan-1", relation: "belongs-to", toKind: "project", toId: "fixture-project", ordinal: 0 },
        { fromKind: "plan", fromId: "plan-1", relation: "spec-ref", toKind: "document", toId: "spec-1", ordinal: 0 },
      ],
    },
    issues: [
      {
        identity: { ...check.scope, issueId: MSTAR_ISSUE },
        nativeTitle: "Native title one",
        nativeStatus: "Todo",
        providerUpdatedAt: at,
        mstar: {
          issueRef: FORGED_ISSUE_REF,
          head: ["2".repeat(64)],
          fields: {
            title: "Adopted title",
            kind: "bug",
            severity: "high",
            disposition: "open",
            impact: "Users cannot ingest the project journal.",
            acceptance: "A complete observation is stored and served.",
            owner: "fullstack-dev",
            registeredAt: at,
            closedAt: null,
            closureNote: null,
            createdAt: at,
            updatedAt: at,
            revision: 1,
            milestoneId: null,
          },
          occurrences: [
            {
              eventId: "11111111-1111-4111-8111-111111111111",
              occurrenceKey: "occurrence-one",
              sourceKind: "review",
              sourceIdentity: "review:fixture",
              rootCauseKey: "remote.observation",
              acceptanceKey: "remote.observation.stored",
              location: "packages/engine/src/collaboration-remote.ts",
              observedBehavior: "The store refused a complete scope.",
              evidence: ["review-fixture"],
              discoveredAt: at,
              recordedAt: at,
              imported: false,
            },
          ],
          transitions: [
            {
              eventId: "22222222-2222-4222-8222-222222222222",
              fromDisposition: "open",
              toDisposition: "resolved",
              actor: "project-manager",
              occurredAt: at,
              recordedAt: at,
              reason: "fixed",
              evidence: { references: ["review-fixture"] },
              issueRevision: 2,
              imported: false,
            },
          ],
          relations: [{ relation: "related", target: SECOND_ISSUE_REF }],
          provenance: [
            {
              eventId: "33333333-3333-4333-8333-333333333333",
              kind: "plan",
              target: "20261122-remote-authority",
              sourceHash: "3".repeat(64),
              origin: "scoped",
              legacyProject: null,
              legacyBucket: null,
              legacyEntryId: null,
              legacyRecord: null,
              importedAt: null,
            },
          ],
          projectMoves: [
            {
              eventId: "44444444-4444-4444-8444-444444444444",
              fromProject: "fixture-project",
              toProject: "fixture-project",
              actor: "project-manager",
              reason: "fixture",
              occurredAt: at,
              issueRevision: 1,
            },
          ],
        },
      },
      {
        identity: { ...check.scope, issueId: PROVIDER_ONLY_ISSUE },
        nativeTitle: "Unmarked native issue",
        nativeStatus: "Done",
        providerUpdatedAt: at,
        mstar: null,
      },
    ],
  };
}

function observation(
  check: ScopeCheck = positiveCheck(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    selectorCommit: "",
    generation: 0,
    check,
    expectRevision: 0,
    snapshot: completeSnapshot(check),
    ...overrides,
  };
}

function cacheRows(dbPath: string): {
  bindings: number;
  observations: number;
  identities: Array<{ provider_issue_id: string; issue_ref: string | null }>;
  mode: string;
  localIssues: number;
  localCatalog: number;
  localProjectBindings: number;
} {
  const db = new DatabaseSync(dbPath);
  try {
    const count = (table: string): number => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
    return {
      bindings: count("remote_bindings"),
      observations: count("remote_observations"),
      identities: db
        .prepare("select provider_issue_id, issue_ref from remote_issue_identities order by provider_issue_id")
        .all() as Array<{ provider_issue_id: string; issue_ref: string | null }>,
      mode: (db.prepare("select mode from collaboration_meta where id = 1").get() as { mode: string }).mode,
      localIssues: count("issues"),
      localCatalog: count("catalog_entities"),
      localProjectBindings: count("project_bindings"),
    };
  } finally {
    db.close();
  }
}

/** note: The binding's persisted verification, as status/freshness/ordering read it. */
function bindingEvidence(dbPath: string): { verified_at: string; verification_json: string; writer_id: string | null } {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("select verified_at, verification_json, writer_id from remote_bindings order by project_key limit 1")
      .get();
    if (
      row === null ||
      typeof row !== "object" ||
      !("verified_at" in row) ||
      typeof row.verified_at !== "string" ||
      !("verification_json" in row) ||
      typeof row.verification_json !== "string"
    ) {
      throw new Error("the cache carries no readable binding verification");
    }
    return {
      verified_at: row.verified_at,
      verification_json: row.verification_json,
      writer_id: "writer_id" in row && typeof row.writer_id === "string" ? row.writer_id : null,
    };
  } finally {
    db.close();
  }
}

/** note: A bind replacing a cache must advance the verification that cache already records. */
function checkAfterBinding(dbPath: string, overrides: Partial<ScopeCheck> = {}): ScopeCheck {
  return positiveCheck({
    checkedAt: new Date(Date.parse(bindingEvidence(dbPath).verified_at) + 1).toISOString(),
    ...overrides,
  });
}

/** note: Rebuild one table from its declared DDL after a textual mutation, so admission sees a damaged layout. */
function rebuildTable(
  dbPath: string,
  table: string,
  transform: (sql: string) => string,
  after?: (db: DatabaseSync) => void,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("pragma foreign_keys = off");
    const declared = db.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(table);
    if (declared === null || typeof declared !== "object" || !("sql" in declared) || typeof declared.sql !== "string") {
      throw new Error(`${table} has no declared DDL`);
    }
    db.exec(`drop table ${table}`);
    db.exec(transform(declared.sql));
    after?.(db);
  } finally {
    db.close();
  }
}

describe("remote observation cache", () => {
  test("a fresh bind creates the cache lane and a complete observation never touches local authority", async () => {
    const fixture = remoteFixture("fresh");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);

    // note: Before any bind the status discloses an unbound checkout and creates nothing.
    expect(await readRemoteStatus(context)).toMatchObject({
      available: false,
      code: "collaboration.stale-binding",
      binding: { state: "unbound" },
    });
    expect(existsSync(location.dbPath)).toBe(false);

    const bound = await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: commit,
      generation: 3,
      checks: [positiveCheck()],
    });
    expect(bound).toMatchObject({ version: 1, selectorCommit: commit, generation: 3, replayed: false });
    expect(bound.binding).toMatchObject({
      version: 3,
      state: "active",
      mode: "remote",
      repoKey: fixture.repoKey,
      selectorCommit: commit,
      generation: 3,
    });
    expect(bound.availability).toEqual([
      { projectId: SELECTED_PROJECT.localProjectId, revision: 0, completeness: "unavailable", code: null },
    ]);
    expect(cacheRows(location.dbPath)).toMatchObject({ bindings: 1, observations: 1, mode: "remote" });

    const check = positiveCheck();
    const result = await ingestRemoteObservation(context, {
      ...observation(check),
      selectorCommit: commit,
      generation: 3,
    });
    expect(result).toMatchObject({
      projectId: SELECTED_PROJECT.localProjectId,
      generation: 3,
      revision: 1,
      completeness: "complete",
      code: null,
    });
    expect(result.asOf).toBe(completeSnapshot(check).asOf);

    // invariant: The cache holds the provider evidence and the identity projection; the local
    // domain tables (`issues`, `catalog_*`, `project_bindings`) stay untouched.
    const rows = cacheRows(location.dbPath);
    expect(rows.identities).toEqual([
      { provider_issue_id: MSTAR_ISSUE, issue_ref: FORGED_ISSUE_REF },
      { provider_issue_id: PROVIDER_ONLY_ISSUE, issue_ref: null },
    ]);
    expect(rows.localIssues).toBe(0);
    expect(rows.localCatalog).toBe(0);
    expect(rows.localProjectBindings).toBe(0);

    const status = await readRemoteStatus(context, SELECTED_PROJECT.localProjectId);
    expect(status).toMatchObject({
      available: true,
      binding: { state: "bound", generation: 3, selectorCommit: commit },
      projects: [
        {
          projectId: SELECTED_PROJECT.localProjectId,
          revision: 1,
          completeness: "complete",
          freshness: "fresh",
          outcome: "verified",
        },
      ],
    });

    // invariant: The local domain entries still refuse a remote selection: the cache is never
    // read or written as local authority.
    await expect(openCollaborationStore(context, "read")).rejects.toMatchObject({
      code: "collaboration.mode-unavailable",
    });
    await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({
      code: "collaboration.mode-unavailable",
    });

    // invariant: `store init` requires the populated remote binding and never creates a local
    // authority in its place.
    expect(await ensureCollaborationAuthority(context)).toMatchObject({
      mode: "remote",
      state: "active",
      schemaVersion: LANE_CURRENT_VERSION,
    });

    // invariant: A restored local image never reauthorizes the provider. The receipt and
    // attestation are placeholders: the route refuses before either is read.
    const unreachableReceipt = {} as RepositoryBackupReceipt;
    const unreachableAttestation = {} as ActivationAttestation;
    await expect(
      restoreCollaborationBackup(context, unreachableReceipt, {
        operator: "ops-engineer",
        attestation: unreachableAttestation,
      }),
    ).rejects.toMatchObject({ code: "collaboration.mode-unavailable" });
  });

  test("a same-scope replay is idempotent and a partial or negative observation is never current", async () => {
    const fixture = remoteFixture("replay");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    const batch = { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] };
    await bindRemoteAuthority(context, batch);
    const replay = await bindRemoteAuthority(context, batch);
    expect(replay).toMatchObject({ replayed: true, generation: 3 });
    expect(cacheRows(location.dbPath).bindings).toBe(1);
    const check = positiveCheck();
    await ingestRemoteObservation(context, { ...observation(check), selectorCommit: commit, generation: 3 });

    // invariant: A verified snapshot replaces the whole project (never unions) and advances the
    // revision only at the expected base.
    const second = await ingestRemoteObservation(context, {
      ...observation(check, { expectRevision: 1 }),
      selectorCommit: commit,
      generation: 3,
    });
    expect(second.revision).toBe(2);
    await expect(
      ingestRemoteObservation(context, { ...observation(check, { expectRevision: 1 }), selectorCommit: commit, generation: 3 }),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });

    // note: A known gap is stored as `partial` with its code; the status never calls it fresh.
    const partial = await ingestRemoteObservation(context, {
      ...observation(check, {
        expectRevision: 2,
        snapshot: {
          ...completeSnapshot(check),
          coverage: { kind: "partial", stream: "comments", nextCursor: "cursor-2", code: "remote.comments-truncated" },
        },
      }),
      selectorCommit: commit,
      generation: 3,
    });
    expect(partial).toMatchObject({ revision: 3, completeness: "partial", code: "remote.comments-truncated" });
    expect(await readRemoteStatus(context)).toMatchObject({
      available: false,
      projects: [{ completeness: "partial", freshness: "incomplete", code: "remote.comments-truncated" }],
    });

    // invariant: A negative check invalidates the cache and is reported by its own code AFTER
    // the invalidation committed: no reader can see the old snapshot as current.
    const denied = positiveCheck({
      checkedAt: new Date(Date.now() - 500).toISOString(),
      outcome: { kind: "denied" },
    });
    await expect(
      ingestRemoteObservation(context, {
        ...observation(denied, { expectRevision: 3, snapshot: null }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "remote.denied" });
    expect(await readRemoteStatus(context)).toMatchObject({
      available: false,
      projects: [{ completeness: "unavailable", revision: 4, code: "remote.denied", freshness: "incomplete" }],
    });
    // note: The active projection is cleared with the invalidation, not merely marked stale.
    expect(cacheRows(location.dbPath).identities).toEqual([]);
    const cleared = new DatabaseSync(location.dbPath);
    try {
      expect(
        cleared.prepare("select snapshot_json, as_of from remote_observations").get() as { snapshot_json: unknown; as_of: unknown },
      ).toEqual({ snapshot_json: null, as_of: null });
    } finally {
      cleared.close();
    }
  });

  test("a rebind advances only through the reviewed lineage and never downgrades", async () => {
    const fixture = remoteFixture("rebind");
    const first = fixture.publish(fixture.payload({ generation: 1 }));
    const context = contextAt(fixture.repo);
    await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: first,
      generation: 1,
      checks: [positiveCheck()],
    });

    // note: A successor that does not name the recorded generation is an unfenced predecessor.
    const unfenced = fixture.publish(fixture.payload({ generation: 2, previous: null, cutover: null }));
    await expect(
      bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: unfenced,
        generation: 2,
        checks: [positiveCheck()],
      }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(readCollaborationBinding(context)).toMatchObject({ version: 3, generation: 1 });

    // note: A fenced, pending-free cutover naming the predecessor is admitted.
    const second = fixture.publish(
      fixture.payload({
        generation: 2,
        previous: { selectorCommit: first, generation: 1, mode: "remote" },
        cutover: {
          operator: "ops-engineer",
          reviewedAt: "2026-11-22T00:00:00Z",
          sourceFenced: true,
          pendingOperationIds: [],
          verifiedTargetDigest: "e".repeat(64),
        },
      }),
    );
    const rebound = await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: second,
      generation: 2,
      checks: [positiveCheck()],
    });
    expect(rebound.binding).toMatchObject({ version: 3, generation: 2, selectorCommit: second });

    // invariant: The superseded generation is preserved as history, not deleted or re-keyed.
    const db = new DatabaseSync(locationAt(fixture.repo).dbPath);
    try {
      expect((db.prepare("select count(*) as n from remote_bindings").get() as { n: number }).n).toBe(2);
      expect(
        (db.prepare("select generation from remote_bindings order by generation").all() as Array<{ generation: number }>).map(
          (row) => row.generation,
        ),
      ).toEqual([1, 2]);
    } finally {
      db.close();
    }

    // note: The selector itself refuses a fenced-false transition before any bind sees it.
    const unsafe = fixture.payload({
      generation: 3,
      previous: { selectorCommit: second, generation: 2, mode: "remote" },
      cutover: {
        operator: "ops-engineer",
        reviewedAt: "2026-11-22T00:00:00Z",
        sourceFenced: false,
        pendingOperationIds: [],
        verifiedTargetDigest: "e".repeat(64),
      },
    });
    fixture.publish(unsafe);
    expect(() => locationAt(fixture.repo)).toThrow("collaboration.stale-binding");
  });

  test("wrong scope, a missing project and unverified batches never bind or observe", async () => {
    const fixture = remoteFixture("scope");
    const commit = fixture.publish(
      fixture.payload({ projects: [SELECTED_PROJECT, SECOND_PROJECT] }),
    );
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);

    // note: Every selected project needs its own positive check.
    await expect(
      bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: commit,
        generation: 3,
        checks: [positiveCheck()],
      }),
    ).rejects.toMatchObject({ code: "remote.scope-mismatch" });
    // note: A check for another tenant is not a check for this project.
    await expect(
      bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: commit,
        generation: 3,
        checks: [
          positiveCheck(),
          positiveCheck({
            projectId: SECOND_PROJECT.localProjectId,
            scope: { ...providerScope(), teamId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
            journalIssueId: SECOND_PROJECT.journalIssueId,
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: "remote.scope-mismatch" });
    // note: A negative verification is never a binding.
    await expect(
      bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: commit,
        generation: 3,
        checks: [positiveCheck({ outcome: { kind: "revoked" } })],
      }),
    ).rejects.toMatchObject({ code: "remote.revoked" });
    expect(existsSync(location.dbPath)).toBe(false);

    // note: A batch for another selector generation cannot bind this checkout.
    await expect(
      bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: "d".repeat(40),
        generation: 3,
        checks: [positiveCheck()],
      }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });

    // note: Bind both projects, then observe one with a foreign-scope snapshot and a missing one.
    const bound = await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: commit,
      generation: 3,
      checks: [
        positiveCheck(),
        positiveCheck({ projectId: SECOND_PROJECT.localProjectId, scope: providerScope(SECOND_PROJECT), journalIssueId: SECOND_PROJECT.journalIssueId }),
      ],
    });
    expect(bound.availability).toHaveLength(2);
    const foreignCheck = positiveCheck();
    const complete = completeSnapshot(foreignCheck);
    const foreignSnapshot: RemoteSnapshot = {
      ...complete,
      project: {
        ...complete.project,
        binding: { ...providerScope(), projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      },
    };
    await expect(
      ingestRemoteObservation(context, {
        ...observation(foreignCheck, { snapshot: foreignSnapshot }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "remote.scope-mismatch" });
    // invariant: A verified check with no snapshot is never recorded as current.
    await expect(
      ingestRemoteObservation(context, {
        ...observation(positiveCheck(), { snapshot: null }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "collaboration.observation-incomplete" });
    expect(cacheRows(location.dbPath).observations).toBe(2);

    // invariant: A draining selector is a predecessor to reconcile, never the cache's target.
    const draining = remoteFixture("draining");
    const drainingCommit = draining.publish(
      draining.payload({
        phase: "draining",
        previous: { selectorCommit: "f".repeat(40), generation: 2, mode: "remote" },
        cutover: {
          operator: "ops-engineer",
          reviewedAt: "2026-11-22T00:00:00Z",
          sourceFenced: false,
          pendingOperationIds: ["operation-one"],
          verifiedTargetDigest: "e".repeat(64),
        },
      }),
    );
    await expect(
      bindRemoteAuthority(contextAt(draining.repo), {
        version: 1,
        selectorCommit: drainingCommit,
        generation: 3,
        checks: [positiveCheck()],
      }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
  });

  test("the latest check is the binding's evidence for status and ordering", async () => {
    const fixture = remoteFixture("evidence");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: commit,
      generation: 3,
      checks: [positiveCheck({ checkedAt: new Date(Date.now() - 10_000).toISOString() })],
    });

    const check = positiveCheck({ checkedAt: new Date(Date.now() - 2_000).toISOString() });
    await ingestRemoteObservation(context, { ...observation(check), selectorCommit: commit, generation: 3 });
    const verified = bindingEvidence(location.dbPath);
    expect(verified.verified_at).toBe(check.checkedAt);
    expect(JSON.parse(verified.verification_json)).toMatchObject({
      outcome: { kind: "verified", writerId: SELECTED_PROJECT.writerId },
    });
    expect(verified.writer_id).toBe(SELECTED_PROJECT.writerId);

    // invariant: A revocation tied with the recorded positive check wins the tie: serving stops in
    // the same millisecond and the binding's evidence becomes the negative check.
    const tiedDenial = positiveCheck({ checkedAt: check.checkedAt, outcome: { kind: "denied" } });
    await expect(
      ingestRemoteObservation(context, {
        ...observation(tiedDenial, { expectRevision: 1, snapshot: null }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "remote.denied" });
    expect(bindingEvidence(location.dbPath)).toMatchObject({ verified_at: tiedDenial.checkedAt, writer_id: null });
    expect(await readRemoteStatus(context)).toMatchObject({
      available: false,
      projects: [{ outcome: "denied", verifiedAt: tiedDenial.checkedAt, completeness: "unavailable" }],
    });

    // invariant: The reverse never holds - a positive tied with that denial restores nothing,
    // through observe or a bind replay.
    await expect(
      ingestRemoteObservation(context, {
        ...observation(positiveCheck({ checkedAt: tiedDenial.checkedAt }), { expectRevision: 2 }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
    await expect(
      bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: commit,
        generation: 3,
        checks: [positiveCheck({ checkedAt: tiedDenial.checkedAt })],
      }),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
    expect(await readRemoteStatus(context)).toMatchObject({
      available: false,
      projects: [{ completeness: "unavailable", outcome: "denied" }],
    });

    // note: A revocation replaces the binding's evidence, so no reader sees the old verification.
    const denied = positiveCheck({
      checkedAt: new Date(Date.now() - 1_000).toISOString(),
      outcome: { kind: "revoked" },
    });
    await expect(
      ingestRemoteObservation(context, {
        ...observation(denied, { expectRevision: 1, snapshot: null }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "remote.revoked" });
    const revoked = bindingEvidence(location.dbPath);
    expect(revoked.verified_at).toBe(denied.checkedAt);
    expect(JSON.parse(revoked.verification_json)).toMatchObject({ outcome: { kind: "revoked" } });
    expect(revoked.writer_id).toBeNull();
    expect(await readRemoteStatus(context)).toMatchObject({
      available: false,
      projects: [{ outcome: "revoked", verifiedAt: denied.checkedAt, completeness: "unavailable" }],
    });

    // invariant: An older positive check cannot restore serving, even with its whole snapshot.
    const older = positiveCheck({ checkedAt: new Date(Date.now() - 5_000).toISOString() });
    await expect(
      ingestRemoteObservation(context, {
        ...observation(older, { expectRevision: 2 }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
    // invariant: Neither can a positive check tied with the recorded revocation.
    await expect(
      ingestRemoteObservation(context, {
        ...observation(positiveCheck({ checkedAt: denied.checkedAt }), { expectRevision: 2 }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
    expect(await readRemoteStatus(context)).toMatchObject({
      available: false,
      projects: [{ completeness: "unavailable", outcome: "revoked" }],
    });
  });

  test("a revocation invalidates serving even when its revision is stale", async () => {
    const fixture = remoteFixture("revocation");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const check = positiveCheck();
    await ingestRemoteObservation(context, { ...observation(check), selectorCommit: commit, generation: 3 });
    await ingestRemoteObservation(context, {
      ...observation(check, { expectRevision: 1 }),
      selectorCommit: commit,
      generation: 3,
    });

    // note: The host last read revision 0; its revocation is admitted anyway and clears the snapshot.
    const denied = positiveCheck({ checkedAt: new Date(Date.now() - 500).toISOString(), outcome: { kind: "denied" } });
    await expect(
      ingestRemoteObservation(context, {
        ...observation(denied, { expectRevision: 0, snapshot: null }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "remote.denied" });
    expect(await readRemoteStatus(context)).toMatchObject({
      available: false,
      projects: [{ revision: 3, completeness: "unavailable", code: "remote.denied" }],
    });
    expect(cacheRows(location.dbPath).identities).toEqual([]);
  });

  test("snapshot fields and history are normalized to the contract allowlist", async () => {
    const fixture = remoteFixture("allowlist");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    // note: Every submission carries its own host check. Serving is restored after a refusal
    // only from a strictly newer check, so this fixture advances the instant per submission.
    let clock = Date.now() - 20_000;
    const nextCheck = (): ScopeCheck => {
      clock += 200;
      return positiveCheck({ checkedAt: new Date(clock).toISOString() });
    };
    await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: commit,
      generation: 3,
      checks: [nextCheck()],
    });
    const base = completeSnapshot(nextCheck());
    const subject = base.issues[0]!.mstar!;
    const submit = (snapshot: unknown) =>
      ingestRemoteObservation(context, {
        ...observation(nextCheck(), { snapshot }),
        selectorCommit: commit,
        generation: 3,
      });
    const withSubject = (patch: Record<string, unknown>) => ({
      ...base,
      issues: [{ ...base.issues[0]!, mstar: { ...subject, ...patch } }, base.issues[1]!],
    });
    const withoutKind = { ...subject.fields };
    delete withoutKind.kind;

    // invariant: Unknown members, missing required fields, wrong enums, a non-boolean imported flag,
    // non-allowlisted transition evidence and unstable history never enter the cache.
    for (const snapshot of [
      withSubject({ fields: { ...subject.fields, token: "leak" } }),
      withSubject({ fields: { ...subject.fields, severity: "blocker" } }),
      withSubject({ fields: withoutKind }),
      withSubject({ occurrences: [{ ...subject.occurrences[0]!, rowId: 7 }] }),
      withSubject({ occurrences: [{ ...subject.occurrences[0]!, eventId: "occurrence-one" }] }),
      withSubject({ occurrences: [{ ...subject.occurrences[0]!, imported: "yes" }] }),
      withSubject({ transitions: [{ from: "open", to: "resolved", reason: "fixed" }] }),
      withSubject({ transitions: [{ ...subject.transitions[0]!, imported: 1 }] }),
      withSubject({ transitions: [{ ...subject.transitions[0]!, evidence: { token: "leak" } }] }),
      withSubject({ transitions: [{ ...subject.transitions[0]!, evidence: { references: ["x"], headers: {} } }] }),
      withSubject({ transitions: [{ ...subject.transitions[0]!, evidence: { references: [{}] } }] }),
      withSubject({ relations: [{ relation: "related", target: "I-000001" }] }),
      withSubject({ provenance: [{}] }),
      withSubject({ projectMoves: [{ fromProject: "a", toProject: "b" }] }),
    ]) {
      await expect(submit(snapshot)).rejects.toMatchObject({ code: "remote.input-invalid" });
    }
    expect(await submit(base)).toMatchObject({ revision: 1, completeness: "complete" });

    const storedHistory = (): {
      occurrences: Array<{ imported: boolean }>;
      transitions: Array<{ imported: boolean; evidence: unknown }>;
    } => {
      const db = new DatabaseSync(locationAt(fixture.repo).dbPath);
      try {
        const row = db.prepare("select snapshot_json from remote_observations").get();
        const stored = typeof row === "object" && row !== null && "snapshot_json" in row ? row.snapshot_json : null;
        const parsed = JSON.parse(String(stored)) as {
          issues: Array<{ mstar: { occurrences: Array<{ imported: boolean }>; transitions: Array<{ imported: boolean; evidence: unknown }> } | null }>;
        };
        const mstar = parsed.issues[0]!.mstar!;
        return { occurrences: mstar.occurrences, transitions: mstar.transitions };
      } finally {
        db.close();
      }
    };
    // note: Non-imported history keeps its explicit flag; the flag is never dropped as unknown.
    expect(storedHistory()).toEqual({
      occurrences: [expect.objectContaining({ imported: false })],
      transitions: [expect.objectContaining({ imported: false, evidence: { references: ["review-fixture"] } })],
    });

    // invariant: Imported history keeps its flag on both collections, and its transition
    // evidence is the reviewed legacy row's complete portable projection: every business
    // field survives, including closure evidence, the supersession pointer and the
    // detail-document reference.
    const importedSubject = {
      ...subject,
      occurrences: [{ ...subject.occurrences[0]!, imported: true }],
      transitions: [
        {
          ...subject.transitions[0]!,
          imported: true,
          evidence: {
            id: "R9",
            title: "Imported finding",
            source: "qc1.md F-001",
            lifecycle: "resolved",
            closed_at: "2026-09-02",
            closure_note: null,
            closure_evidence: "PR #42 / commit abc1234",
            superseded_by: "R2",
            detail_doc: "plans/projects/_default/residuals/R9-finding.md",
          },
        },
      ],
    };
    expect(
      await ingestRemoteObservation(context, {
        ...observation(nextCheck(), {
          expectRevision: 1,
          snapshot: { ...base, issues: [{ ...base.issues[0]!, mstar: importedSubject }, base.issues[1]!] },
        }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).toMatchObject({ revision: 2, completeness: "complete" });
    expect(storedHistory()).toEqual({
      occurrences: [expect.objectContaining({ imported: true })],
      transitions: [
        expect.objectContaining({
          imported: true,
          evidence: {
            legacyId: "R9",
            title: "Imported finding",
            source: "qc1.md F-001",
            lifecycle: "resolved",
            closedAt: "2026-09-02",
            closureNote: null,
            closureEvidence: "PR #42 / commit abc1234",
            supersededBy: "R2",
            detailDoc: "plans/projects/_default/residuals/R9-finding.md",
          },
        }),
      ],
    });

    // invariant: An imported field the reviewed representation cannot keep refuses the whole
    // observation by name (`remote.unsafe-fidelity`) instead of being silently dropped.
    for (const evidence of [
      { id: "R9", title: "Imported finding", token: "leak" },
      { id: "R9", title: "Imported finding", detail_doc: "/home/operator/notes.md" },
      { id: "R9", title: "Imported finding", superseded_by: "C:\\operator\\notes.md" },
      { id: "R9", title: "Imported finding", closure_evidence: { token: "leak" } },
      { id: "R9", title: "Imported finding", closure_evidence: "Bearer secret" },
      { id: "R9", title: "Imported finding", detail_doc: "see /Users/alice/private.txt" },
      { id: "R9", title: "Imported finding", superseded_by: "see C:\\operator\\notes.md" },
      { id: "R9", title: "Imported finding", closure_evidence: "api_key=sk-live-12345678" },
      { id: "R9", title: "Imported finding", closure_evidence: "token=example-secret" },
      { id: "R9", title: "Imported finding", detail_doc: "path)/Users/alice/private.txt" },
      { id: "R9", title: "Imported finding", detail_doc: "note /opt/home/alice/x" },
      { id: "R9", title: "Imported finding", detail_doc: "path)/Volumes/Work/alice/private.txt" },
      { id: "R9", title: "Imported finding", closure_evidence: "token:abc" },
      { id: "R9", title: "Imported finding", closure_evidence: "Authorization: xyz" },
      { id: "R9", title: "Imported finding", closure_evidence: "https://alice:password@example.test/" },
      { id: "R9", title: "Imported finding", closure_evidence: "See https://example.test/runs?token=example-secret" },
      { id: "R9", title: "Imported finding", closure_evidence: "See https://example.test/runs?x-api-key=example-secret" },
      { id: "R9", title: "Imported finding", detail_doc: "https://example.test/home/alice/notes.md" },
      { id: "R9", title: "Imported finding", closure_evidence: "https://example.test/?file=/Users/alice/private.txt" },
    ]) {
      await expect(
        submit(withSubject({ transitions: [{ ...subject.transitions[0]!, imported: true, evidence }] })),
      ).rejects.toMatchObject({ code: "remote.unsafe-fidelity" });
    }
    await expect(
      submit(
        withSubject({
          transitions: [
            {
              ...subject.transitions[0]!,
              imported: true,
              evidence: { id: "R9", title: "Imported finding", detail_doc: "/home/operator/notes.md" },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/evidence\.detail_doc/);
    // invariant: Every unsafe field invalidates the addressed cache instead of leaving the
    // previous snapshot current; the named refusal is reported only after that write landed.
    const invalidated = await readRemoteStatus(context);
    const invalidatedRevision = invalidated.projects[0]!.revision;
    expect(invalidated).toMatchObject({
      available: false,
      projects: [{ completeness: "unavailable", code: "remote.unsafe-fidelity" }],
    });
    expect(invalidatedRevision).toBeGreaterThan(2);
    expect(cacheRows(locationAt(fixture.repo).dbPath).identities).toEqual([]);

    // note: Control - ordinary business prose carrying a URL and a relative reference stays
    // portable, so the credential/path rule refuses shapes, not business text.
    expect(
      await ingestRemoteObservation(context, {
        ...observation(nextCheck(), {
          expectRevision: invalidatedRevision,
          snapshot: withSubject({
            transitions: [
              {
                ...subject.transitions[0]!,
                imported: true,
                evidence: {
                  id: "R10",
                  title: "Imported finding",
                  detail_doc: "plans/projects/_default/residuals/R10-finding.md",
                  closure_evidence: "See https://example.test/pull/42 for the fix and PR #42 / commit abc1234",
                },
              },
            ],
          }),
        }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).toMatchObject({ revision: invalidatedRevision + 1, completeness: "complete" });
    expect(storedHistory().transitions[0]!.evidence).toMatchObject({
      closureEvidence: "See https://example.test/pull/42 for the fix and PR #42 / commit abc1234",
    });

    // note: Control - the same shapes without a credential label or an absolute root stay
    // portable: a URL path and a relative reference are accepted.
    expect(
      await ingestRemoteObservation(context, {
        ...observation(nextCheck(), {
          expectRevision: invalidatedRevision + 1,
          snapshot: withSubject({
            transitions: [
              {
                ...subject.transitions[0]!,
                imported: true,
                evidence: {
                  id: "R11",
                  title: "Imported finding",
                  detail_doc: "plans/projects/_default/residuals/R11-finding.md",
                  closure_evidence: "Tracked in https://example.test/runs/7 and notes/summary.md",
                },
              },
            ],
          }),
        }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).toMatchObject({ revision: invalidatedRevision + 2, completeness: "complete" });

    // note: Control - a bare credential word in prose and an ordinary URL stay portable;
    // only an assigned credential, a credential-bearing URL or a home path refuses.
    expect(
      await ingestRemoteObservation(context, {
        ...observation(nextCheck(), {
          expectRevision: invalidatedRevision + 2,
          snapshot: withSubject({
            transitions: [
              {
                ...subject.transitions[0]!,
                imported: true,
                evidence: {
                  id: "R12",
                  title: "Token expiration and refresh window",
                  detail_doc: "plans/projects/_default/residuals/R12-finding.md",
                  closure_evidence: "See https://example.test/runs/7?tab=summary for the follow-up",
                },
              },
            ],
          }),
        }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).toMatchObject({ revision: invalidatedRevision + 3, completeness: "complete" });

    // invariant: A credential label followed by a phrase is business prose, not an
    // assignment, so the historical note survives the boundary unchanged.
    expect(
      await ingestRemoteObservation(context, {
        ...observation(nextCheck(), {
          expectRevision: invalidatedRevision + 3,
          snapshot: withSubject({
            transitions: [
              {
                ...subject.transitions[0]!,
                imported: true,
                evidence: {
                  id: "R13",
                  title: "Imported finding",
                  detail_doc: "plans/projects/_default/residuals/R13-finding.md",
                  closure_evidence: "Token: rotation scheduled",
                },
              },
            ],
          }),
        }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).toMatchObject({ revision: invalidatedRevision + 4, completeness: "complete" });
    expect(storedHistory().transitions[0]!.evidence).toMatchObject({
      closureEvidence: "Token: rotation scheduled",
    });
  }, 20_000);

  /** note: Apply one reviewed legacy register import and return the source lane it wrote. */
  async function migratedSource(name: string, entries: Record<string, unknown>[]): Promise<CollaborationLocation> {
    const repo = makeRepo(`https://example.test/fixture/${name}.git`);
    const context = contextAt(repo);
    const register = join(context.harnessDir, "projects", "_default", "residuals.json");
    mkdirSync(dirname(register), { recursive: true });
    writeFileSync(register, JSON.stringify({ entries: { "plan-import": entries } }));
    await applyStoreMigration(context, await planStoreMigration(context));
    return locationAt(repo);
  }

  /** note: A reviewed legacy register row, in the register's own spelling. */
  const migratedRow = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    title: `Imported finding ${id}`,
    severity: "high",
    source: "qc1.md",
    scope: "plan-scope",
    decision: "accept",
    owner: "pm",
    target: "next-iteration",
    tracking: "issue",
    source_plan: "plan-import",
    registered_at: "2026-09-01",
    lifecycle: "resolved",
    closed_at: "2026-09-02",
    closure_note: "fixed",
    detail_doc: `plans/projects/_default/residuals/${id}-finding.md`,
    closure_evidence: "PR #42 / commit abc1234",
    superseded_by: "R2",
    ...overrides,
  });

  /** note: The one imported transition evidence the migration recorded. */
  function importedEvidence(location: CollaborationLocation): Record<string, unknown> {
    const db = new DatabaseSync(location.dbPath);
    try {
      const row = db.prepare("select evidence_json from issue_transitions where imported = 1").get() as
        | { evidence_json: string }
        | null;
      if (row === null) throw new Error("the imported lane recorded no terminal transition");
      return JSON.parse(row.evidence_json) as Record<string, unknown>;
    } finally {
      db.close();
    }
  }

  test("a real imported terminal transition round-trips as portable evidence", async () => {
    const fixture = remoteFixture("imported-evidence");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);

    // note: A real reviewed register import records the whole legacy row as the imported
    // transition's evidence; every portable business field must survive the boundary.
    const evidence = importedEvidence(await migratedSource("imported-evidence", [migratedRow("R1")]));

    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const check = positiveCheck();
    const base = completeSnapshot(check);
    const subject = base.issues[0]!.mstar!;
    await ingestRemoteObservation(context, {
      ...observation(check, {
        snapshot: {
          ...base,
          issues: [
            {
              ...base.issues[0]!,
              mstar: {
                ...subject,
                occurrences: [{ ...subject.occurrences[0]!, imported: true }],
                transitions: [{ ...subject.transitions[0]!, imported: true, evidence }],
              },
            },
            base.issues[1]!,
          ],
        },
      }),
      selectorCommit: commit,
      generation: 3,
    });

    const db = new DatabaseSync(location.dbPath);
    let stored: unknown;
    try {
      const row = db.prepare("select snapshot_json from remote_observations").get() as { snapshot_json: string | null };
      // note: The cache stores this boundary's own validated snapshot document.
      const snapshot = JSON.parse(String(row.snapshot_json)) as {
        issues: Array<{ mstar: { transitions: Array<{ imported: boolean; evidence: unknown }> } | null }>;
      };
      stored = snapshot.issues[0]!.mstar!.transitions[0]!.evidence;
    } finally {
      db.close();
    }
    // invariant: Every portable business field of the migrated row round-trips; no legacy key
    // spelling or non-portable value reaches the cache.
    expect(stored).toEqual({
      legacyId: "R1",
      title: "Imported finding R1",
      severity: "high",
      source: "qc1.md",
      scope: "plan-scope",
      decision: "accept",
      owner: "pm",
      target: "next-iteration",
      tracking: "issue",
      detailDoc: "plans/projects/_default/residuals/R1-finding.md",
      lifecycle: "resolved",
      closedAt: "2026-09-02",
      closureNote: "fixed",
      closureEvidence: "PR #42 / commit abc1234",
      supersededBy: "R2",
      sourcePlan: "plan-import",
      registeredAt: "2026-09-01",
    });
  });

  test("a real imported transition whose field cannot be represented refuses by name", async () => {
    const fixture = remoteFixture("imported-unsafe");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);

    const evidence = importedEvidence(
      await migratedSource("imported-unsafe", [
        migratedRow("R3", { detail_doc: "/Users/operator/notes.md", closure_evidence: { token: "leak" } }),
      ]),
    );

    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const check = positiveCheck();
    const base = completeSnapshot(check);
    const subject = base.issues[0]!.mstar!;
    const refusal: unknown = await ingestRemoteObservation(context, {
      ...observation(check, {
        snapshot: {
          ...base,
          issues: [
            {
              ...base.issues[0]!,
              mstar: { ...subject, transitions: [{ ...subject.transitions[0]!, imported: true, evidence }] },
            },
            base.issues[1]!,
          ],
        },
      }),
      selectorCommit: commit,
      generation: 3,
    }).catch((error: unknown) => error);

    // invariant: The unsafe field is named, never dropped, and the addressed cache is left
    // unavailable instead of continuing to serve the previous revision.
    expect(refusal).toMatchObject({ code: "remote.unsafe-fidelity" });
    expect(String(refusal)).toContain("evidence.detail_doc");
    expect(await readRemoteStatus(context)).toMatchObject({
      available: false,
      projects: [{ revision: 1, completeness: "unavailable", code: "remote.unsafe-fidelity" }],
    });
  });

  test("a real migrated provenance row enters only as its reviewed portable record", async () => {
    const fixture = remoteFixture("imported-provenance");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    const source = await migratedSource("imported-provenance", [
      migratedRow("R1"),
      migratedRow("R3", { detail_doc: "/Users/operator/notes.md", superseded_by: { token: "leak" } }),
      migratedRow("R4", { closure_evidence: "Bearer secret" }),
      migratedRow("R5", { closure_evidence: "See https://alice:password@example.test/run" }),
      migratedRow("R6", { closure_evidence: "See https://example.test/runs?token=example-secret" }),
      migratedRow("R7", { detail_doc: "https://example.test/home/operator/notes.md" }),
      migratedRow("R8", { closure_evidence: "Token: rotation scheduled" }),
    ]);
    type ProvenanceRow = {
      kind: string;
      target: string;
      source_hash: string;
      origin: string;
      legacy_project: string | null;
      legacy_bucket: string | null;
      legacy_entry_id: string | null;
      legacy_json: string | null;
      imported_at: string | null;
    };
    const rows = ((): ProvenanceRow[] => {
      const db = new DatabaseSync(source.dbPath);
      try {
        return db
          .prepare(
            "select kind, target, source_hash, origin, legacy_project, legacy_bucket, legacy_entry_id, legacy_json, imported_at from provenance order by id",
          )
          .all() as ProvenanceRow[];
      } finally {
        db.close();
      }
    })();
    const pick = (id: string): ProvenanceRow => {
      const row = rows.find((entry) => entry.legacy_entry_id === id);
      if (row === undefined) throw new Error("the migrated lane recorded no provenance");
      return row;
    };
    const portable = pick("R1");
    const unsafe = pick("R3");
    const credential = pick("R4");
    const prose = pick("R8");
    const refused = ["R5", "R6", "R7"].map(pick);
    expect(portable.kind).toBe("migration");

    // note: Every submission carries its own host check. Serving is restored after a refusal
    // only from a strictly newer check, so this fixture advances the instant per submission.
    let clock = Date.now() - 20_000;
    const nextCheck = (): ScopeCheck => {
      clock += 200;
      return positiveCheck({ checkedAt: new Date(clock).toISOString() });
    };
    await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: commit,
      generation: 3,
      checks: [nextCheck()],
    });
    const base = completeSnapshot(nextCheck());
    const subject = base.issues[0]!.mstar!;
    const provenanceEntry = (row: ProvenanceRow): Record<string, unknown> => ({
      eventId: "55555555-5555-4555-8555-555555555555",
      kind: row.kind,
      target: row.target,
      sourceHash: row.source_hash,
      origin: row.origin,
      legacyProject: row.legacy_project,
      legacyBucket: row.legacy_bucket,
      legacyEntryId: row.legacy_entry_id,
      legacyJson: row.legacy_json,
      importedAt: row.imported_at,
    });
    const submitProvenance = (row: ProvenanceRow, expectRevision: number) =>
      ingestRemoteObservation(context, {
        ...observation(nextCheck(), {
          expectRevision,
          snapshot: {
            ...base,
            issues: [
              { ...base.issues[0]!, mstar: { ...subject, provenance: [provenanceEntry(row)] } },
              base.issues[1]!,
            ],
          },
        }),
        selectorCommit: commit,
        generation: 3,
      });

    expect(await submitProvenance(portable, 0)).toMatchObject({ revision: 1, completeness: "complete" });
    const db = new DatabaseSync(location.dbPath);
    let recorded: Record<string, unknown>;
    let raw: string;
    try {
      const row = db.prepare("select snapshot_json from remote_observations").get() as { snapshot_json: string | null };
      raw = String(row.snapshot_json);
      // note: The cache stores this boundary's own validated snapshot document.
      const snapshot = JSON.parse(raw) as {
        issues: Array<{ mstar: { provenance: Array<Record<string, unknown>> } | null }>;
      };
      recorded = snapshot.issues[0]!.mstar!.provenance[0]!;
    } finally {
      db.close();
    }
    // invariant: The real row's portable fields survive; its raw legacy JSON and every path never do.
    expect(recorded).toEqual({
      eventId: "55555555-5555-4555-8555-555555555555",
      kind: "migration",
      target: portable.target,
      sourceHash: portable.source_hash,
      origin: "unscoped",
      legacyProject: "_default",
      legacyBucket: "plan-import",
      legacyEntryId: "R1",
      legacyRecord: {
        legacyId: "R1",
        title: "Imported finding R1",
        severity: "high",
        source: "qc1.md",
        scope: "plan-scope",
        decision: "accept",
        owner: "pm",
        target: "next-iteration",
        tracking: "issue",
        detailDoc: "plans/projects/_default/residuals/R1-finding.md",
        lifecycle: "resolved",
        closedAt: "2026-09-02",
        closureNote: "fixed",
        closureEvidence: "PR #42 / commit abc1234",
        supersededBy: "R2",
        sourcePlan: "plan-import",
        registeredAt: "2026-09-01",
      },
      importedAt: portable.imported_at,
    });
    expect(recorded).not.toHaveProperty("legacyJson");
    expect(raw).not.toContain("legacyJson");
    expect(raw).not.toContain("Users/operator");

    // invariant: A provenance row whose content is not portable refuses by name and invalidates
    // the addressed cache, so the previous complete revision is never served behind the refusal.
    const refusal: unknown = await submitProvenance(unsafe, 1).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "remote.unsafe-fidelity" });
    expect(String(refusal)).toContain("legacyJson.detail_doc");
    const credentialRefusal: unknown = await submitProvenance(credential, 1).catch((error: unknown) => error);
    expect(credentialRefusal).toMatchObject({ code: "remote.unsafe-fidelity" });
    expect(String(credentialRefusal)).toContain("legacyJson.closure_evidence");
    for (const row of refused) {
      const urlShapeRefusal: unknown = await submitProvenance(row, 1).catch((error: unknown) => error);
      expect(urlShapeRefusal).toMatchObject({ code: "remote.unsafe-fidelity" });
      expect(String(urlShapeRefusal)).toContain("legacyJson.");
    }
    const invalidated = await readRemoteStatus(context);
    const invalidatedRevision = invalidated.projects[0]!.revision;
    expect(invalidated).toMatchObject({
      available: false,
      projects: [{ completeness: "unavailable", code: "remote.unsafe-fidelity" }],
    });
    expect(invalidatedRevision).toBeGreaterThan(1);

    // invariant: The same label-plus-phrase note is business prose, so it stays portable and
    // restores serving at the invalidated base.
    expect(await submitProvenance(prose, invalidatedRevision)).toMatchObject({
      revision: invalidatedRevision + 1,
      completeness: "complete",
    });
    expect((await readRemoteStatus(context)).projects[0]!.revision).toBe(invalidatedRevision + 1);
  });

  test("a rebind refuses a replaced cache identity and reinitializes a missing one", async () => {
    const fixture = remoteFixture("identity");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    const batch = { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] };
    const first = await bindRemoteAuthority(context, batch);
    const firstStore = first.binding.version === 3 ? first.binding.storeId : "?";
    const db = new DatabaseSync(location.dbPath);
    try {
      db.prepare("update collaboration_meta set store_id = 'replacement-store' where id = 1").run();
    } finally {
      db.close();
    }
    await expect(bindRemoteAuthority(context, batch)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(readCollaborationBinding(context)).toMatchObject({ version: 3, storeId: firstStore });

    // note: A vanished cache is a missing lane, not a replacement: bind initializes it.
    rmSync(location.dbPath);
    const rebound = await bindRemoteAuthority(context, batch);
    expect(rebound.binding).toMatchObject({ version: 3 });
    expect(rebound.binding.version === 3 ? rebound.binding.storeId : "?").not.toBe(firstStore);
  });

  test("bind admits only a current, ordered positive check", async () => {
    const fixture = remoteFixture("current-check");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    const bind = (check: ScopeCheck) =>
      bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [check] });

    // invariant: A future or expired positive check bootstraps nothing and creates nothing.
    await expect(
      bind(positiveCheck({ checkedAt: new Date(Date.now() + 60_000).toISOString() })),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
    await expect(
      bind(positiveCheck({ checkedAt: new Date(Date.now() - 61_000).toISOString() })),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
    expect(existsSync(location.dbPath)).toBe(false);

    await bind(positiveCheck());
    // invariant: A verification never moves a binding's evidence backwards.
    await expect(
      bind(positiveCheck({ checkedAt: new Date(Date.now() - 5_000).toISOString() })),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });

    // invariant: A tied timestamp only replays byte-identical evidence; a conflicting tie can
    // never replace the recorded check.
    const tiedAt = new Date(Date.now() - 500).toISOString();
    await bind(positiveCheck({ checkedAt: tiedAt }));
    expect(await bind(positiveCheck({ checkedAt: tiedAt }))).toMatchObject({ replayed: true });
    await expect(
      bind(
        positiveCheck({
          checkedAt: tiedAt,
          outcome: {
            kind: "verified",
            readerId: "reader-two",
            writerId: SELECTED_PROJECT.writerId,
            capabilities: {
              fullRead: true,
              appendOnly: true,
              exactLookup: true,
              fieldFidelity: true,
              privateAudience: true,
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
    expect(bindingEvidence(location.dbPath).verified_at).toBe(tiedAt);
  });

  test("a near-future check is refused by bind and observe", async () => {
    const fixture = remoteFixture("near-future");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);

    // invariant: A check dated even slightly ahead of this process is refused - there is no
    // tolerated skew - and no lane is created.
    await expect(
      bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: commit,
        generation: 3,
        checks: [positiveCheck({ checkedAt: new Date(Date.now() + 2_000).toISOString() })],
      }),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
    expect(existsSync(location.dbPath)).toBe(false);

    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    await expect(
      ingestRemoteObservation(context, {
        ...observation(positiveCheck({ checkedAt: new Date(Date.now() + 2_000).toISOString() })),
        selectorCommit: commit,
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
    expect(cacheRows(location.dbPath).observations).toBe(1);
    expect((await readRemoteStatus(context)).projects[0]!.revision).toBe(0);
  });

  test("status never calls an expired check available on completeness alone", async () => {
    const fixture = remoteFixture("expired-status");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const check = positiveCheck();
    await ingestRemoteObservation(context, { ...observation(check), selectorCommit: commit, generation: 3 });
    const db = new DatabaseSync(location.dbPath);
    try {
      db.prepare("update remote_bindings set verified_at = ?").run(new Date(Date.now() - 61_000).toISOString());
    } finally {
      db.close();
    }
    expect(await readRemoteStatus(context)).toMatchObject({
      available: false,
      code: "collaboration.observation-stale",
      projects: [{ completeness: "complete", outcome: "verified", freshness: "expired" }],
    });
  });

  test("a verified empty project journal is admitted with a null head", async () => {
    const fixture = remoteFixture("empty-journal");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const check = positiveCheck();
    const base = completeSnapshot(check);
    const empty: RemoteSnapshot = { ...base, project: { ...base.project, head: null } };
    expect(
      await ingestRemoteObservation(context, { ...observation(check), snapshot: empty, selectorCommit: commit, generation: 3 }),
    ).toMatchObject({ revision: 1, completeness: "complete" });

    const db = new DatabaseSync(location.dbPath);
    try {
      const row = db.prepare("select snapshot_json from remote_observations").get();
      const stored = typeof row === "object" && row !== null && "snapshot_json" in row ? row.snapshot_json : null;
      expect(typeof stored).toBe("string");
      expect(String(stored)).toContain('"head":null');
    } finally {
      db.close();
    }

    // note: A malformed head is still refused.
    await expect(
      ingestRemoteObservation(context, {
        ...observation(check, {
          expectRevision: 1,
          snapshot: { ...base, project: { ...base.project, head: ["not-a-digest"] } },
        }),
        selectorCommit: commit,
        generation: 3,
      }),
    ).rejects.toMatchObject({ code: "remote.input-invalid" });
  });

  test("a v2 lane that lost a column, key or CHECK refuses admission", async () => {
    const cases: Array<{ name: string; mutate: (dbPath: string) => void }> = [
      {
        name: "extra-column",
        mutate: (dbPath) => {
          const db = new DatabaseSync(dbPath);
          try {
            db.exec("alter table remote_bindings add column leaked text");
          } finally {
            db.close();
          }
        },
      },
      {
        name: "lost-unique-index",
        mutate: (dbPath) => {
          const db = new DatabaseSync(dbPath);
          try {
            db.exec("drop index remote_issue_identities_provider");
          } finally {
            db.close();
          }
        },
      },
      {
        name: "lost-reference-uniqueness",
        mutate: (dbPath) =>
          rebuildTable(dbPath, "issues", (sql) => sql.replace("issue_ref text not null unique", "issue_ref text not null")),
      },
      {
        name: "lost-foreign-key",
        mutate: (dbPath) =>
          rebuildTable(
            dbPath,
            "remote_issue_identities",
            (sql) =>
              sql.replace(
                /,\s*foreign key \([^)]*\) references remote_observations\([^)]*\)/,
                "",
              ),
            (db) => {
              db.exec(
                "create unique index remote_issue_identities_ref on remote_issue_identities(generation, issue_ref) where issue_ref is not null",
              );
              db.exec(
                "create unique index remote_issue_identities_provider on remote_issue_identities(generation, provider_issue_id)",
              );
            },
          ),
      },
      {
        name: "lost-completeness-check",
        mutate: (dbPath) =>
          rebuildTable(dbPath, "remote_observations", (sql) =>
            sql.replace("check (completeness in ('complete','partial','unavailable'))", ""),
          ),
      },
    ];
    for (const entry of cases) {
      const fixture = remoteFixture(`malformed-${entry.name}`);
      const commit = fixture.publish(fixture.payload());
      const context = contextAt(fixture.repo);
      const location = locationAt(fixture.repo);
      await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
      entry.mutate(location.dbPath);
      await expect(readRemoteStatus(context)).rejects.toMatchObject({ code: "collaboration.unreadable" });
    }
  }, 30_000);

  test("an ineffective unique index or a split foreign key refuses admission", async () => {
    // note: Same columns, no uniqueness at all: only the declared predicate can tell them apart.
    const ineffective = remoteFixture("malformed-partial-uniqueness");
    const ineffectiveCommit = ineffective.publish(ineffective.payload());
    const ineffectiveContext = contextAt(ineffective.repo);
    const ineffectiveLocation = locationAt(ineffective.repo);
    await bindRemoteAuthority(ineffectiveContext, {
      version: 1,
      selectorCommit: ineffectiveCommit,
      generation: 3,
      checks: [positiveCheck()],
    });
    const ineffectiveDb = new DatabaseSync(ineffectiveLocation.dbPath);
    try {
      ineffectiveDb.exec("drop index remote_issue_identities_provider");
      ineffectiveDb.exec(
        "create unique index remote_issue_identities_provider on remote_issue_identities(generation, provider_issue_id) where 0",
      );
    } finally {
      ineffectiveDb.close();
    }
    await expect(readRemoteStatus(ineffectiveContext)).rejects.toMatchObject({ code: "collaboration.unreadable" });

    // note: Two single-column keys satisfy a flattened comparison but not the required composite.
    const split = remoteFixture("malformed-split-foreign-key");
    const splitCommit = split.publish(split.payload());
    const splitContext = contextAt(split.repo);
    const splitLocation = locationAt(split.repo);
    await bindRemoteAuthority(splitContext, {
      version: 1,
      selectorCommit: splitCommit,
      generation: 3,
      checks: [positiveCheck()],
    });
    rebuildTable(splitLocation.dbPath, "remote_observations", (sql) =>
      sql.replace(
        "foreign key (generation, project_key) references remote_bindings(generation, project_key)",
        "foreign key (generation) references remote_bindings(generation), " +
          "foreign key (project_key) references remote_bindings(project_key)",
      ),
    );
    await expect(readRemoteStatus(splitContext)).rejects.toMatchObject({ code: "collaboration.unreadable" });
  });

  test("a complete snapshot without its own project catalog row still serves milestones", async () => {
    const fixture = remoteFixture("milestone-without-project-row");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const snapshot = completeSnapshot();
    await ingestRemoteObservation(context, {
      ...observation(positiveCheck()),
      selectorCommit: commit,
      generation: 3,
      snapshot: {
        ...snapshot,
        project: {
          ...snapshot.project,
          // invariant: Ingest never requires an admitted snapshot to re-declare its own project row.
          catalogEntities: snapshot.project.catalogEntities.filter(
            (row) => !(row.kind === "project" && row.id === SELECTED_PROJECT.localProjectId),
          ),
        },
        issues: snapshot.issues.map((issue) =>
          issue.mstar === null
            ? issue
            : { ...issue, mstar: { ...issue.mstar, fields: { ...issue.mstar.fields, milestoneId: "milestone-1" } } },
        ),
      },
    });

    const view = await openRemoteReadView(context);
    const read = remoteMilestones(view, SELECTED_PROJECT.localProjectId);
    expect(read.milestones.map((row) => [row.milestoneId, row.totalIssues])).toEqual([["milestone-1", 1]]);
    expect(read.issues.map((row) => [row.id, row.milestoneId])).toEqual([[FORGED_ISSUE_REF, "milestone-1"]]);
    expect(read.unassignedIssues).toBe(0);
    // note: The milestone lookup keeps its own refusal for an id the snapshot does not carry.
    expect(() => remoteMilestones(view, SELECTED_PROJECT.localProjectId, "missing-milestone")).toThrow(
      /\[milestone\.not-found\]/,
    );
  });

  test("a project outside the selected evidence refuses the milestone read as a scope mismatch", async () => {
    const cache = await outboxCache("milestone-scope-mismatch");
    const view = await openRemoteReadView(cache.context);
    expect(() => remoteMilestones(view, SECOND_PROJECT.localProjectId)).toThrow(/\[remote\.scope-mismatch\]/);
  });
});

// ---------------------------------------------------------------------------
// note: The reviewed local/mirror -> remote transition and the commit-time fence
// ---------------------------------------------------------------------------

/** note: A same-repository checkout that starts in local mode and owns a bare origin. */
function transitionFixture(name: string): {
  repo: string;
  repoKey: string;
  origin: string;
  bare: string;
  publish(payload: Record<string, unknown>): string;
} {
  const slug = `${name}-${sequence++}`;
  const origin = `https://github.com/transition-fixture/${slug}.git`;
  const repoKey = `github.com/transition-fixture/${slug}`;
  const bare = join(ROOT, `transition-origin-${slug}.git`);
  git(ROOT, "init", "-q", "--bare", bare);
  const repo = join(ROOT, `transition-repo-${slug}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Transition Store Test");
  git(repo, "config", "user.email", "transition@example.test");
  git(repo, "config", "remote.origin.url", origin);
  git(repo, "config", `url.${bare}.insteadOf`, origin);
  writeFileSync(join(repo, ".mstarc"), "[collaboration]\nmode=local\n");
  const publisher = join(ROOT, `transition-publisher-${slug}`);
  mkdirSync(publisher, { recursive: true });
  git(publisher, "init", "-q");
  git(publisher, "config", "user.name", "Transition Publisher");
  git(publisher, "config", "user.email", "publisher@example.test");
  return {
    repo,
    repoKey,
    origin,
    bare,
    publish(payload) {
      writeFileSync(join(publisher, "authority.json"), `${JSON.stringify(payload, null, 2)}\n`);
      git(publisher, "add", "authority.json");
      git(publisher, "commit", "-q", "-m", "publish selector");
      git(publisher, "push", "-q", "--force", bare, `HEAD:${SELECTOR_REF}`);
      return git(publisher, "rev-parse", "HEAD");
    },
  };
}

/** note: A published local lane carrying one issue, with the checkout's v2 binding recorded. */
async function publishedLocalLane(repo: string): Promise<{ context: StoreContext; location: CollaborationLocation }> {
  const context = contextAt(repo);
  const location = locationAt(repo);
  await initializeCollaborationStore(location);
  activate(location.dbPath);
  const db = new DatabaseSync(location.dbPath);
  try {
    db.prepare(
      "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, " +
        "identity_key, issue_ref) values ('I-000001', 'fixture-project', 'Local history', 'bug', 'high', 'open', 'i', 'a', " +
        "'2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 'key-one', 'mstar:issue:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')",
    ).run();
  } finally {
    db.close();
  }
  return { context, location };
}

/** note: A second checkout of the SAME repository: its own harness, the shared canonical origin. */
function secondCheckout(origin: string, bare: string, mode: CollaborationMode): string {
  const dir = join(ROOT, `second-checkout-${sequence++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Second Checkout");
  git(dir, "config", "user.email", "second@example.test");
  git(dir, "config", "remote.origin.url", origin);
  git(dir, "config", `url.${bare}.insteadOf`, origin);
  writeFileSync(join(dir, ".mstarc"), `[collaboration]\nmode=${mode}\n`);
  return dir;
}

function selectorPayload(repoKey: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    repoKey,
    generation: 1,
    mode: "local",
    phase: "active",
    projects: [],
    previous: null,
    cutover: null,
    ...overrides,
  };
}

const FENCED = {
  operator: "ops-engineer",
  reviewedAt: "2026-11-22T00:00:00Z",
  sourceFenced: true,
  pendingOperationIds: [],
  verifiedTargetDigest: "f".repeat(64),
};

describe("reviewed authority transition", () => {
  test("a reviewed local predecessor is retired into the remote cache with its history preserved", async () => {
    const fixture = transitionFixture("predecessor");
    const { context, location } = await publishedLocalLane(fixture.repo);
    const predecessor = metaRecord(location.dbPath);
    expect(predecessor).toMatchObject({ mode: "local", authority_state: "active" });

    // note: The predecessor generation the successor names, published while this checkout is local.
    const local = fixture.publish(selectorPayload(fixture.repoKey, { generation: 1 }));
    writeFileSync(join(fixture.repo, ".mstarc"), "[collaboration]\nmode=remote\n");

    // invariant: An ACTIVE selector whose cutover is not source-fenced refuses before any byte moves.
    const unfenced = fixture.publish(
      selectorPayload(fixture.repoKey, {
        generation: 2,
        mode: "remote",
        projects: [SELECTED_PROJECT],
        previous: { selectorCommit: local, generation: 1, mode: "local" },
        cutover: { ...FENCED, sourceFenced: false },
      }),
    );
    await expect(
      bindRemoteAuthority(context, { version: 1, selectorCommit: unfenced, generation: 2, checks: [positiveCheck()] }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(existsSync(location.dbPath)).toBe(true);
    expect(metaRecord(location.dbPath)).toMatchObject({ mode: "local", store_id: predecessor.store_id });

    // note: The reviewed, fenced successor names that local generation and retires the lane.
    const successor = fixture.publish(
      selectorPayload(fixture.repoKey, {
        generation: 3,
        mode: "remote",
        projects: [SELECTED_PROJECT],
        previous: { selectorCommit: local, generation: 1, mode: "local" },
        cutover: FENCED,
      }),
    );
    const bound = await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: successor,
      generation: 3,
      checks: [positiveCheck()],
    });
    expect(bound).toMatchObject({
      generation: 3,
      binding: { version: 3, mode: "remote", generation: 3, selectorCommit: successor },
      retiredPredecessor: { mode: "local", storeId: predecessor.store_id, epoch: predecessor.authority_epoch },
    });
    if (bound.retiredPredecessor === null) throw new Error("fixture: the transition reported no retired predecessor");

    // invariant: The canonical path is now the verified cache; the predecessor's rows survive as
    // inaccessible history beside it, under their own local mode.
    expect(metaRecord(location.dbPath)).toMatchObject({ mode: "remote", authority_state: "active" });
    const preserved = new DatabaseSync(bound.retiredPredecessor.path);
    try {
      expect(preserved.prepare("select id, title from issues").all()).toEqual([{ id: "I-000001", title: "Local history" }]);
      expect((preserved.prepare("select mode from collaboration_meta where id = 1").get() as { mode: string }).mode).toBe("local");
    } finally {
      preserved.close();
    }

    // invariant: The retired generation is never served and a stale local write cannot land.
    await expect(openCollaborationStore(context, "read")).rejects.toMatchObject({
      code: "collaboration.mode-unavailable",
    });
    await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({
      code: "collaboration.mode-unavailable",
    });
  });

  test("a local write refuses when the origin publishes a draining selector inside its transaction", async () => {
    const fixture = transitionFixture("draining-writer");
    const { context, location } = await publishedLocalLane(fixture.repo);

    await expect(
      withCollaborationWrite(context, (handle) => {
        handle.db.prepare(receiptInsert("draining-gap")).run();
        // note: The origin starts the reviewed transition while this writer holds the lock.
        fixture.publish(selectorPayload(fixture.repoKey, { generation: 1, phase: "draining" }));
        return "written";
      }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });

    // invariant: The effect rolled back: no receipt landed under the superseded selection.
    const db = new DatabaseSync(location.dbPath);
    try {
      expect(
        (db.prepare("select count(*) as n from collaboration_operations where operation_id = 'draining-gap'").get() as { n: number })
          .n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  test("a remote cache staging transaction refuses when the selector moves before commit", async () => {
    const fixture = remoteFixture("selector-fence");
    const first = fixture.publish(fixture.payload({ generation: 1 }));
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: first, generation: 1, checks: [positiveCheck()] });

    await expect(
      writeRemoteCacheStage(
        location,
        ({ db }) => {
          db.prepare(receiptInsert("selector-gap")).run();
          fixture.publish(
            fixture.payload({
              generation: 2,
              previous: { selectorCommit: first, generation: 1, mode: "remote" },
              cutover: FENCED,
            }),
          );
          return "staged";
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });

    // invariant: The staged cache mutation rolled back with the moved selection.
    const db = new DatabaseSync(location.dbPath);
    try {
      expect(
        (db.prepare("select count(*) as n from collaboration_operations where operation_id = 'selector-gap'").get() as { n: number })
          .n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  test("an unbound same-repository checkout retires the shared local predecessor", async () => {
    const fixture = transitionFixture("unbound-predecessor");
    const { context, location } = await publishedLocalLane(fixture.repo);
    const predecessor = metaRecord(location.dbPath);
    // note: A fresh clone in the same home resolves the same canonical lane but holds no
    // binding for it; the reviewed selector is the only lineage evidence it needs.
    rmSync(join(fixture.repo, ".mstar", "collaboration-binding.json"), { force: true });
    const local = fixture.publish(selectorPayload(fixture.repoKey, { generation: 1 }));
    writeFileSync(join(fixture.repo, ".mstarc"), "[collaboration]\nmode=remote\n");
    const successor = fixture.publish(
      selectorPayload(fixture.repoKey, {
        generation: 2,
        mode: "remote",
        projects: [SELECTED_PROJECT],
        previous: { selectorCommit: local, generation: 1, mode: "local" },
        cutover: FENCED,
      }),
    );

    const bound = await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: successor,
      generation: 2,
      checks: [positiveCheck()],
    });
    expect(bound.retiredPredecessor).toMatchObject({ mode: "local", storeId: predecessor.store_id });
    expect(metaRecord(location.dbPath)).toMatchObject({ mode: "remote" });
  });

  test("a selector that moves before the retirement decision never retires the predecessor", async () => {
    const fixture = transitionFixture("retirement-drift");
    const { context, location } = await publishedLocalLane(fixture.repo);
    const predecessor = metaRecord(location.dbPath);
    const local = fixture.publish(selectorPayload(fixture.repoKey, { generation: 1 }));
    writeFileSync(join(fixture.repo, ".mstarc"), "[collaboration]\nmode=remote\n");
    const successor = fixture.publish(
      selectorPayload(fixture.repoKey, {
        generation: 2,
        mode: "remote",
        projects: [SELECTED_PROJECT],
        previous: { selectorCommit: local, generation: 1, mode: "local" },
        cutover: FENCED,
      }),
    );

    // note: A competing publication lands AFTER the bind's reviewed proof and BEFORE its
    // retirement decision, so the successor the bind checked is no longer the live selection.
    setRemoteBindTransitionGapForTest(() => {
      fixture.publish(
        selectorPayload(fixture.repoKey, {
          generation: 3,
          mode: "remote",
          projects: [SELECTED_PROJECT],
          previous: { selectorCommit: successor, generation: 2, mode: "remote" },
          cutover: FENCED,
        }),
      );
    });
    try {
      await expect(
        bindRemoteAuthority(context, {
          version: 1,
          selectorCommit: successor,
          generation: 2,
          checks: [positiveCheck()],
        }),
      ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    } finally {
      setRemoteBindTransitionGapForTest(undefined);
    }

    // invariant: Drift is observed before the rename, so nothing moved: the canonical path is
    // still the local predecessor, no retired image exists and no v3 binding was published.
    expect(metaRecord(location.dbPath)).toMatchObject({
      mode: "local",
      store_id: predecessor.store_id,
      authority_epoch: predecessor.authority_epoch,
    });
    expect(issueCount(location.dbPath)).toBe(1);
    expect(
      existsSync(localPredecessorRetiredPath(location, { storeId: predecessor.store_id, epoch: predecessor.authority_epoch })),
    ).toBe(false);
    expect(readCollaborationBinding(context)).toMatchObject({ version: 2, mode: "local" });
  });

  test("a late bind publication never replaces a recorded newer generation", async () => {
    const fixture = remoteFixture("publication-fence");
    const first = fixture.publish(fixture.payload({ generation: 1 }));
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    const bound = await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: first,
      generation: 1,
      checks: [positiveCheck()],
    });
    // invariant: The published stamp is the lane the transaction actually wrote.
    const lane = metaRecord(location.dbPath);
    expect(bound.binding).toMatchObject({ version: 3, storeId: lane.store_id, epoch: lane.authority_epoch });

    const second = fixture.publish(
      fixture.payload({
        generation: 2,
        previous: { selectorCommit: first, generation: 1, mode: "remote" },
        cutover: FENCED,
      }),
    );
    await bindRemoteAuthority(context, { version: 1, selectorCommit: second, generation: 2, checks: [positiveCheck()] });
    expect(readCollaborationBinding(context)).toMatchObject({ generation: 2, selectorCommit: second });

    // note: A slower bind that staged the predecessor publishes nothing over the successor.
    expect(() =>
      writeRemoteCollaborationBinding(context, {
        repoKey: location.repoKey,
        selectorCommit: first,
        generation: 1,
        storeId: bound.binding.storeId,
        epoch: bound.binding.epoch,
      }),
    ).toThrow(expect.objectContaining({ code: "collaboration.stale-binding" }));
    expect(readCollaborationBinding(context)).toMatchObject({ generation: 2, selectorCommit: second });
  });

  test("a missing cache never adopts a different selector at the recorded generation", async () => {
    const fixture = remoteFixture("equal-generation");
    const first = fixture.publish(fixture.payload({ generation: 1 }));
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: first, generation: 1, checks: [positiveCheck()] });
    // note: The private cache is disposable bytes; its loss never licenses reusing the number.
    rmSync(location.dbPath, { force: true });
    // note: The same generation republished with a different payload (the marker only makes the
    // commit distinct); the origin's ref now names a commit this checkout never recorded.
    const other = fixture.publish(fixture.payload({ generation: 1, publishedNote: "same generation, different payload" }));
    expect(other).not.toBe(first);

    await expect(
      bindRemoteAuthority(context, { version: 1, selectorCommit: other, generation: 1, checks: [positiveCheck()] }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // invariant: The refused bind created no lane and left the recorded generation alone.
    expect(existsSync(location.dbPath)).toBe(false);
    expect(readCollaborationBinding(context)).toMatchObject({ generation: 1, selectorCommit: first });
  });

  test("a local write refuses a different active selector of the same mode", async () => {
    const fixture = transitionFixture("same-mode-drift");
    const { context, location } = await publishedLocalLane(fixture.repo);
    // note: The initial local selector is ACTIVE; the local admission retains its exact commit.
    const first = fixture.publish(selectorPayload(fixture.repoKey, { generation: 1 }));
    expect(resolveCollaborationLocation(context).selection?.commit).toBe(first);

    await expect(
      withCollaborationWrite(context, (handle) => {
        handle.db.prepare(receiptInsert("same-mode-gap")).run();
        // note: A valid successor of the SAME mode and phase lands while this writer holds the lock.
        fixture.publish(
          selectorPayload(fixture.repoKey, {
            generation: 2,
            previous: { selectorCommit: first, generation: 1, mode: "local" },
            cutover: FENCED,
          }),
        );
        return "written";
      }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(receipts(location.dbPath)).not.toContain("same-mode-gap");

    // invariant: An ACTIVE selector first published after an admission that proved absence is
    // the same drift, not a fresh absence the writer may continue under.
    const absence = transitionFixture("same-mode-absence");
    const fresh = await publishedLocalLane(absence.repo);
    await expect(
      withCollaborationWrite(fresh.context, (handle) => {
        handle.db.prepare(receiptInsert("absence-gap")).run();
        absence.publish(selectorPayload(absence.repoKey, { generation: 1 }));
        return "written";
      }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(receipts(fresh.location.dbPath)).not.toContain("absence-gap");
  });

  test("two checkouts sharing one lane serialize predecessor retirement", async () => {
    const fixture = transitionFixture("shared-retirement");
    const { context, location } = await publishedLocalLane(fixture.repo);
    const predecessor = metaRecord(location.dbPath);
    const local = fixture.publish(selectorPayload(fixture.repoKey, { generation: 1 }));
    writeFileSync(join(fixture.repo, ".mstarc"), "[collaboration]\nmode=remote\n");
    const successor = fixture.publish(
      selectorPayload(fixture.repoKey, {
        generation: 2,
        mode: "remote",
        projects: [SELECTED_PROJECT],
        previous: { selectorCommit: local, generation: 1, mode: "local" },
        cutover: FENCED,
      }),
    );
    // note: A second checkout of the same repository resolves the SAME canonical store path
    // but keeps its own harness root, so a harness-scoped lock would not exclude it.
    const otherContext = contextAt(secondCheckout(fixture.origin, fixture.bare, "remote"));
    let competing: unknown;
    setLocalPredecessorPublicationGapForTest(async () => {
      try {
        await bindRemoteAuthority(otherContext, {
          version: 1,
          selectorCommit: successor,
          generation: 2,
          checks: [positiveCheck()],
        });
      } catch (error) {
        competing = error;
      }
    });
    try {
      const bound = await bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: successor,
        generation: 2,
        checks: [positiveCheck()],
      });
      expect(bound.retiredPredecessor).toMatchObject({ mode: "local", storeId: predecessor.store_id });
    } finally {
      setLocalPredecessorPublicationGapForTest(undefined);
    }

    // invariant: The second checkout was excluded by the SHARED lane lock, and the one archive
    // that exists carries the predecessor's history, not the competing cache.
    expect(competing).toMatchObject({ code: "collaboration.cutover-conflict" });
    const retired = localPredecessorRetiredPath(location, {
      storeId: predecessor.store_id,
      epoch: predecessor.authority_epoch,
    });
    expect(metaRecord(retired)).toMatchObject({ mode: "local", store_id: predecessor.store_id });
    expect(issueCount(retired)).toBe(1);
    expect(metaRecord(location.dbPath)).toMatchObject({ mode: "remote" });
  });

  test("a suspended retirement never replaces a preserved predecessor image", async () => {
    const fixture = transitionFixture("archive-no-replace");
    const { context, location } = await publishedLocalLane(fixture.repo);
    const predecessor = metaRecord(location.dbPath);
    const local = fixture.publish(selectorPayload(fixture.repoKey, { generation: 1 }));
    writeFileSync(join(fixture.repo, ".mstarc"), "[collaboration]\nmode=remote\n");
    const successor = fixture.publish(
      selectorPayload(fixture.repoKey, {
        generation: 2,
        mode: "remote",
        projects: [SELECTED_PROJECT],
        previous: { selectorCommit: local, generation: 1, mode: "local" },
        cutover: FENCED,
      }),
    );
    const retired = localPredecessorRetiredPath(location, {
      storeId: predecessor.store_id,
      epoch: predecessor.authority_epoch,
    });
    // note: A competing checkout completes its retirement AFTER this one's last inode check;
    // only the create-if-absent publication decides which image survives.
    setLocalPredecessorPublicationGapForTest(() => {
      writeFileSync(retired, "competing archive\n", { mode: 0o600 });
    });
    try {
      await expect(
        bindRemoteAuthority(context, {
          version: 1,
          selectorCommit: successor,
          generation: 2,
          checks: [positiveCheck()],
        }),
      ).rejects.toMatchObject({
        code: "collaboration.stale-binding",
        message: expect.stringContaining("never replaced"),
      });
    } finally {
      setLocalPredecessorPublicationGapForTest(undefined);
    }

    // invariant: Neither the archive nor the canonical predecessor was overwritten.
    expect(readFileSync(retired, "utf8")).toBe("competing archive\n");
    expect(metaRecord(location.dbPath)).toMatchObject({ mode: "local", store_id: predecessor.store_id });
    expect(readCollaborationBinding(context)).toMatchObject({ version: 2, mode: "local" });
  });

  test("a competing v3 publisher never replaces an in-progress publication", async () => {
    const fixture = remoteFixture("publication-lock");
    const first = fixture.publish(fixture.payload({ generation: 3 }));
    const context = contextAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: first, generation: 3, checks: [positiveCheck()] });
    const second = fixture.publish(
      fixture.payload({
        generation: 4,
        previous: { selectorCommit: first, generation: 3, mode: "remote" },
        cutover: FENCED,
      }),
    );
    let competing: unknown;
    setRemoteBindingPublicationGapForTest(async () => {
      try {
        await bindRemoteAuthority(context, {
          version: 1,
          selectorCommit: second,
          generation: 4,
          checks: [positiveCheck()],
        });
      } catch (error) {
        competing = error;
      }
    });
    try {
      const bound = await bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: second,
        generation: 4,
        checks: [positiveCheck()],
      });
      expect(bound).toMatchObject({ generation: 4, selectorCommit: second });
    } finally {
      setRemoteBindingPublicationGapForTest(undefined);
    }

    // invariant: The second publisher was excluded, so the first publication stands.
    expect(competing).toMatchObject({ code: "collaboration.cutover-conflict" });
    expect(readCollaborationBinding(context)).toMatchObject({
      version: 3,
      generation: 4,
      selectorCommit: second,
    });
  });

  test("a bind whose selector advanced after its cache commit recovers through that generation", async () => {
    const fixture = remoteFixture("publication-recovery");
    const first = fixture.publish(fixture.payload({ generation: 3 }));
    const context = contextAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: first, generation: 3, checks: [positiveCheck()] });
    const second = fixture.publish(
      fixture.payload({
        generation: 4,
        previous: { selectorCommit: first, generation: 3, mode: "remote" },
        cutover: FENCED,
      }),
    );
    let third = "";
    setRemoteBindingPublicationGapForTest(() => {
      third = fixture.publish(
        fixture.payload({
          generation: 5,
          previous: { selectorCommit: second, generation: 4, mode: "remote" },
          cutover: FENCED,
        }),
      );
    });
    try {
      await expect(
        bindRemoteAuthority(context, { version: 1, selectorCommit: second, generation: 4, checks: [positiveCheck()] }),
      ).rejects.toMatchObject({
        code: "collaboration.stale-binding",
        message: expect.stringContaining("already committed"),
      });
    } finally {
      setRemoteBindingPublicationGapForTest(undefined);
    }

    // invariant: Generation 4's cache rows committed and no checkout binding was published;
    // the checkout still records generation 3 while the committed 4 is the reviewed predecessor.
    expect(readCollaborationBinding(context)).toMatchObject({ version: 3, generation: 3, selectorCommit: first });

    const recovered = await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: third,
      generation: 5,
      checks: [positiveCheck()],
    });
    expect(recovered).toMatchObject({ generation: 5, selectorCommit: third, replayed: false });
    expect(readCollaborationBinding(context)).toMatchObject({
      version: 3,
      generation: 5,
      selectorCommit: third,
    });
  });
});

// ---------------------------------------------------------------------------
// note: v3 outbox intents: durable prepare, identical replay and named refusals
// ---------------------------------------------------------------------------

/** note: The frozen binding of the fixture's selected project at one selector commit. */
function intentBindingFor(commit: string): Record<string, unknown> {
  return {
    generation: 3,
    projectKey: SELECTED_PROJECT.localProjectId,
    selectorCommit: commit,
    provider: "linear",
    workspaceId: SELECTED_PROJECT.workspaceId,
    teamId: SELECTED_PROJECT.teamId,
    projectId: SELECTED_PROJECT.projectId,
    journalIssueId: SELECTED_PROJECT.journalIssueId,
    writerId: SELECTED_PROJECT.writerId,
  };
}

/** note: The complete normalized project document a project event freezes (no head, no binding). */
function completeProjectSubject(): Record<string, unknown> {
  const project = completeSnapshot().project;
  return {
    projectId: project.projectId,
    milestones: project.milestones,
    roadmap: project.roadmap,
    catalogEntities: project.catalogEntities,
    catalogLinks: project.catalogLinks,
  };
}

/** note: The complete normalized issue subject a replacement freezes (no head, no issueRef). */
function completeIssueSubject(): Record<string, unknown> {
  const issue = completeSnapshot().issues[0]!.mstar!;
  return {
    fields: issue.fields,
    occurrences: issue.occurrences,
    transitions: issue.transitions,
    relations: issue.relations,
    provenance: issue.provenance,
    projectMoves: issue.projectMoves,
  };
}

/** note: One journal project-replace intent: the smallest complete frozen request. */
function intentRequest(
  fixture: { repoKey: string },
  commit: string,
  operationId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    binding: intentBindingFor(commit),
    event: {
      version: 1,
      repoKey: fixture.repoKey,
      projectId: SELECTED_PROJECT.localProjectId,
      operationId,
      parents: [],
      change: { kind: "project-replace", project: completeProjectSubject() },
    },
    target: SELECTED_PROJECT.journalIssueId,
    expectedHeads: [],
    ...overrides,
  };
}

/** note: The stored intents, for replay no-mutation and durability assertions. */
function outboxRows(dbPath: string): Array<{
  operation_id: string;
  request_hash: string;
  request_json: string;
  state: string;
  attempt_id: string | null;
  execution_key_json: string | null;
  abandon_reason: string | null;
  resolves: string | null;
  resolved_by: string | null;
}> {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db
        .prepare(
          "select operation_id, request_hash, request_json, state, attempt_id, execution_key_json, abandon_reason, " +
            "resolves, resolved_by from remote_outbox order by operation_id",
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      operation_id: String(row.operation_id),
      request_hash: String(row.request_hash),
      request_json: String(row.request_json),
      state: String(row.state),
      attempt_id: typeof row.attempt_id === "string" ? row.attempt_id : null,
      execution_key_json: typeof row.execution_key_json === "string" ? row.execution_key_json : null,
      abandon_reason: typeof row.abandon_reason === "string" ? row.abandon_reason : null,
      resolves: typeof row.resolves === "string" ? row.resolves : null,
      resolved_by: typeof row.resolved_by === "string" ? row.resolved_by : null,
    }));
  } finally {
    db.close();
  }
}

/** note: The recorded receipt rows exactly as the lane holds them; the append-only evidence behind a state. */
function outboxReceipts(dbPath: string): Array<{
  operation_id: string;
  receipt_hash: string;
  source: string;
  outcome: string;
  evidence_json: string;
  recorded_at: string;
}> {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        "select operation_id, receipt_hash, source, outcome, evidence_json, recorded_at from remote_outbox_receipts " +
          "order by operation_id, receipt_hash",
      )
      .all() as Array<{
      operation_id: string;
      receipt_hash: string;
      source: string;
      outcome: string;
      evidence_json: string;
      recorded_at: string;
    }>;
  } finally {
    db.close();
  }
}

describe("remote outbox intents", () => {
  test("prepare commits one frozen intent, replays identically and refuses a different request or binding", async () => {
    const fixture = remoteFixture("outbox-prepare");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const operationId = "00000000-0000-4000-8000-0000000000a1";
    const request = intentRequest(fixture, commit, operationId, { expectedHeads: ["a".repeat(64)] });

    const first = await prepareRemoteIntent(context, request);
    expect(first).toMatchObject({
      version: 1,
      operationId,
      projectId: SELECTED_PROJECT.localProjectId,
      generation: 3,
      state: "enqueued",
      target: SELECTED_PROJECT.journalIssueId,
      executionKey: null,
      replayed: false,
    });
    expect(first.requestHash).toMatch(/^[0-9a-f]{64}$/);

    // invariant: The intent is committed before it is reported, with the exact frozen
    // request and no send permit (no attempt id).
    const [stored] = outboxRows(location.dbPath);
    expect(stored).toMatchObject({ operation_id: operationId, state: "enqueued", attempt_id: null });
    expect(stored!.request_hash).toBe(first.requestHash);
    expect(JSON.parse(stored!.request_json)).toEqual(request);

    // invariant: A semantically identical prepare returns the stored state and never re-inserts.
    const replay = await prepareRemoteIntent(context, request);
    expect(replay).toMatchObject({ state: "enqueued", replayed: true, requestHash: first.requestHash });
    expect(outboxRows(location.dbPath)).toHaveLength(1);

    const pending = await readPendingIntents(context, SELECTED_PROJECT.localProjectId);
    expect(pending).toMatchObject({ version: 1, projectId: SELECTED_PROJECT.localProjectId, generation: 3 });
    expect(pending.intents).toEqual([
      {
        operationId,
        projectId: SELECTED_PROJECT.localProjectId,
        state: "enqueued",
        requestHash: first.requestHash,
        target: SELECTED_PROJECT.journalIssueId,
        kind: "project-replace",
        createdAt: first.createdAt,
      },
    ]);

    // invariant: The same id under a different frozen request refuses and leaves the intent intact.
    await expect(
      prepareRemoteIntent(
        context,
        intentRequest(fixture, commit, operationId, { expectedHeads: ["b".repeat(64)] }),
      ),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    // invariant: A request that does not address the checked binding refuses before any insert.
    await expect(
      prepareRemoteIntent(
        context,
        intentRequest(fixture, commit, "00000000-0000-4000-8000-0000000000a2", {
          binding: { ...intentBindingFor(commit), writerId: null },
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.scope-mismatch" });
    expect(outboxRows(location.dbPath)).toEqual([stored!]);
  });

  test("an absent, older or incomplete outbox never accepts an intent", async () => {
    // note: No remote lane exists at all: the prepare refuses and creates nothing.
    const absent = remoteFixture("outbox-absent");
    const absentCommit = absent.publish(absent.payload());
    const absentLocation = locationAt(absent.repo);
    await expect(
      prepareRemoteIntent(
        contextAt(absent.repo),
        intentRequest(absent, absentCommit, "00000000-0000-4000-8000-0000000000b1"),
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(existsSync(absentLocation.dbPath)).toBe(false);

    // note: A bound v3 lane whose outbox tables were removed is a damaged current lane.
    const dropped = remoteFixture("outbox-dropped");
    const commit = dropped.publish(dropped.payload());
    const context = contextAt(dropped.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const dbPath = locationAt(dropped.repo).dbPath;
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("pragma foreign_keys = off");
      db.exec("drop table remote_outbox_receipts; drop table remote_outbox");
    } finally {
      db.close();
    }
    const before = tableNames(dbPath);
    await expect(
      prepareRemoteIntent(context, intentRequest(dropped, commit, "00000000-0000-4000-8000-0000000000b2")),
    ).rejects.toMatchObject({ code: "collaboration.unreadable" });
    // invariant: The refusal created no table, lane or intent.
    expect(tableNames(dbPath)).toEqual(before);
  });

  test("a frozen subject is the complete normalized document and refuses unknown or sensitive fields", async () => {
    const fixture = remoteFixture("outbox-subject");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const project = completeProjectSubject();
    const change = (operationId: string, value: Record<string, unknown>, target: string): Record<string, unknown> =>
      intentRequest(fixture, commit, operationId, {
        event: {
          version: 1,
          repoKey: fixture.repoKey,
          projectId: SELECTED_PROJECT.localProjectId,
          operationId,
          parents: value.kind === "issue-replace" ? ["a".repeat(64)] : [],
          change: value,
        },
        target,
      });
    const issueChange = (mstar: unknown): Record<string, unknown> => ({
      kind: "issue-replace",
      issueRef: FORGED_ISSUE_REF,
      mstar,
    });

    const refusals = [
      // note: A partial project document is not the complete normalized subject.
      change("00000000-0000-4000-8000-0000000000c1", { kind: "project-replace", project: { projectId: SELECTED_PROJECT.localProjectId } }, SELECTED_PROJECT.journalIssueId),
      // note: Credential-shaped and unrelated keys never reach the stored request.
      change("00000000-0000-4000-8000-0000000000c2", { kind: "project-replace", project: { ...project, token: "sk-live-1234" } }, SELECTED_PROJECT.journalIssueId),
      change("00000000-0000-4000-8000-0000000000c3", { kind: "project-replace", project: { ...project, headers: { authorization: "Bearer x" } } }, SELECTED_PROJECT.journalIssueId),
      change("00000000-0000-4000-8000-0000000000c4", { kind: "project-replace", project: { ...project, binding: {} } }, SELECTED_PROJECT.journalIssueId),
      // note: An empty or partial issue subject (and its derived head) is never frozen.
      change("00000000-0000-4000-8000-0000000000c5", issueChange({}), MSTAR_ISSUE),
      change("00000000-0000-4000-8000-0000000000c6", issueChange({ ...completeIssueSubject(), head: ["a".repeat(64)] }), MSTAR_ISSUE),
      change(
        "00000000-0000-4000-8000-0000000000c7",
        issueChange({ ...completeIssueSubject(), fields: { ...(completeIssueSubject().fields as Record<string, unknown>), token: "x" } }),
        MSTAR_ISSUE,
      ),
    ];
    for (const request of refusals) {
      await expect(prepareRemoteIntent(context, request)).rejects.toMatchObject({ code: "remote.input-invalid" });
    }
    // invariant: Every refusal happened before persistence.
    expect(outboxRows(location.dbPath)).toEqual([]);
  });

test("a frozen pre-upgrade request that carried a milestone target settles as unestimated", async () => {
    // invariant: A frozen request outlives the contract that froze it. The predecessor froze each
    // milestone with a calendar `target`; a date is not a count of sessions, so the stored row must
    // settle as unestimated instead of refusing every settlement verb as input-invalid. The rewrite
    // is visible: the row reads as normalized-from-legacy, never as a current contract row.
    const fixture = remoteFixture("outbox-frozen-target");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const operationId = "00000000-0000-4000-8000-0000000000f1";
    await prepareRemoteIntent(context, intentRequest(fixture, commit, operationId));
    // invariant: A CURRENT row reads untouched - no normalization is reported for it.
    expect((await readRemoteIntent(context, operationId)).normalizedFromLegacy).toBe(false);
    const db = new DatabaseSync(location.dbPath);
    try {
      const row = db.prepare("select request_json from remote_outbox where operation_id = ?").get(operationId) as {
        request_json: string;
      };
      const body = JSON.parse(row.request_json) as {
        event: { change: { project: { milestones: Array<Record<string, unknown>> } } };
      };
      for (const entry of body.event.change.project.milestones) {
        delete entry.effortSessions;
        entry.target = "2026-12-01";
      }
      db.prepare("update remote_outbox set request_json = ? where operation_id = ?").run(JSON.stringify(body), operationId);
    } finally {
      db.close();
    }

    const shown = await readRemoteIntent(context, operationId);
    if (shown.event?.change.kind !== "project-replace") throw new Error("expected a frozen project replacement");
    const milestones = shown.event.change.project.milestones as Array<{ effortSessions: unknown }>;
    expect(milestones.map((entry) => entry.effortSessions)).toEqual([null]);
    expect(shown.normalizedFromLegacy).toBe(true);
    await expect(abandonRemoteIntent(context, { operationId, reason: "superseded" })).resolves.toMatchObject({
      state: "abandoned",
    });

    // invariant: A row that MIXES the pre-upgrade and current shapes - some milestones carrying
    // `target`, or one carrying both members - is damage no writer produced: it refuses as
    // unreadable instead of being laundered through the legacy rewrite.
    const mixed = "00000000-0000-4000-8000-0000000000f3";
    await prepareRemoteIntent(context, intentRequest(fixture, commit, mixed));
    const mixedDb = new DatabaseSync(location.dbPath);
    try {
      const row = mixedDb.prepare("select request_json from remote_outbox where operation_id = ?").get(mixed) as {
        request_json: string;
      };
      const body = JSON.parse(row.request_json) as {
        event: { change: { project: { milestones: Array<Record<string, unknown>> } } };
      };
      // note: ONE row carrying both the retired `target` and the current `effortSessions`:
      // no writer ever produced that shape, uniform or current.
      body.event.change.project.milestones[0]!.target = "2026-12-01";
      mixedDb.prepare("update remote_outbox set request_json = ? where operation_id = ?").run(JSON.stringify(body), mixed);
    } finally {
      mixedDb.close();
    }
    await expect(readRemoteIntent(context, mixed)).rejects.toMatchObject({ code: "collaboration.unreadable" });

    // invariant: The legacy reading is the STORED path's alone: a new submission carrying the
    // retired member is still refused at the boundary.
    const milestone = (completeProjectSubject().milestones as Array<Record<string, unknown>>)[0]!;
    const fresh = "00000000-0000-4000-8000-0000000000f2";
    await expect(
      prepareRemoteIntent(
        context,
        intentRequest(fixture, commit, fresh, {
          event: {
            version: 1,
            repoKey: fixture.repoKey,
            projectId: SELECTED_PROJECT.localProjectId,
            operationId: fresh,
            parents: [],
            change: {
              kind: "project-replace",
              project: { ...completeProjectSubject(), milestones: [{ ...milestone, target: "2026-12-01" }] },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.input-invalid" });
  });

  test("a shape-valid subject with a guessed semantic key is refused before any outbox row", async () => {
    const fixture = remoteFixture("outbox-semantic-key");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const replacement = (operationId: string, occurrences: readonly Record<string, unknown>[]): Record<string, unknown> =>
      intentRequest(fixture, commit, operationId, {
        event: {
          version: 1,
          repoKey: fixture.repoKey,
          projectId: SELECTED_PROJECT.localProjectId,
          operationId,
          parents: ["a".repeat(64)],
          change: {
            kind: "issue-replace",
            issueRef: FORGED_ISSUE_REF,
            mstar: { ...completeIssueSubject(), occurrences },
          },
        },
        target: MSTAR_ISSUE,
      });
    const occurrence = (completeIssueSubject().occurrences as Record<string, unknown>[])[0]!;

    // invariant: The shape is complete; only the issue domain's dedup rule (issue.ts
    // occurrenceColumns via requireSemanticKey) refuses a guessed root-cause/acceptance key.
    const guessed = [
      { rootCauseKey: "?" },
      { rootCauseKey: "Unknown" },
      { acceptanceKey: " ? " },
      { acceptanceKey: "unknown" },
    ];
    for (const [index, patch] of guessed.entries()) {
      const operationId = `00000000-0000-4000-8000-0000000000e${String(index + 1)}`;
      await expect(
        prepareRemoteIntent(context, replacement(operationId, [{ ...occurrence, ...patch }])),
      ).rejects.toMatchObject({ code: "remote.input-invalid", message: expect.stringContaining("ambiguous") });
      expect(outboxRows(location.dbPath)).toEqual([]);
    }

    // invariant: The same complete subject with domain keys still enqueues normally.
    const accepted = await prepareRemoteIntent(context, replacement("00000000-0000-4000-8000-0000000000ef", [occurrence]));
    expect(accepted).toMatchObject({ state: "enqueued", target: MSTAR_ISSUE });
  });

  test("a replacement must cite its replaced heads before anything is enqueued", async () => {
    const fixture = remoteFixture("outbox-parents");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const replacement = (operationId: string, parents: string[]): Record<string, unknown> =>
      intentRequest(fixture, commit, operationId, {
        event: {
          version: 1,
          repoKey: fixture.repoKey,
          projectId: SELECTED_PROJECT.localProjectId,
          operationId,
          parents,
          change: { kind: "issue-replace", issueRef: FORGED_ISSUE_REF, mstar: completeIssueSubject() },
        },
        target: MSTAR_ISSUE,
      });

    // invariant: `[]` is genesis or adoption only; a replacement without a replaced head refuses.
    await expect(
      prepareRemoteIntent(context, replacement("00000000-0000-4000-8000-0000000000d1", [])),
    ).rejects.toMatchObject({ code: "remote.input-invalid", message: expect.stringContaining("replaced head") });
    expect(outboxRows(location.dbPath)).toEqual([]);

    // invariant: With its replaced head the same shape is a normal enqueued replacement.
    const accepted = await prepareRemoteIntent(
      context,
      replacement("00000000-0000-4000-8000-0000000000d2", ["a".repeat(64)]),
    );
    expect(accepted).toMatchObject({ state: "enqueued", target: MSTAR_ISSUE });
    const pending = await readPendingIntents(context, SELECTED_PROJECT.localProjectId);
    expect(pending.intents).toMatchObject([
      { operationId: "00000000-0000-4000-8000-0000000000d2", kind: "issue-replace", target: MSTAR_ISSUE },
    ]);
  });
});

// ---------------------------------------------------------------------------
// note: v3 outbox lifecycle: one permit, exact receipts, conflicts and recovery
// ---------------------------------------------------------------------------

const OBSERVED_PROJECT_HEAD = "1".repeat(64);
const OBSERVED_ISSUE_HEAD = "2".repeat(64);
const JOURNAL_ANCHOR = SELECTED_PROJECT.journalIssueId;

async function refusalOf(work: () => Promise<unknown>): Promise<{ code: string; message: string; details?: unknown }> {
  try {
    await work();
    throw new Error("expected a refusal");
  } catch (error) {
    return error as { code: string; message: string; details?: unknown };
  }
}

function detailsOf(refusal: { details?: unknown }): Record<string, unknown> {
  if (refusal.details === null || typeof refusal.details !== "object") throw new Error("refusal carries no details");
  return refusal.details as Record<string, unknown>;
}

/** note: The phases of every recorded reservation for one operation id. */
async function intentPhases(context: StoreContext, operationId: string): Promise<string[]> {
  const handle = await openStore(context, "read");
  try {
    const rows = handle.db
      .prepare("select phase from execution_collaboration_intents where operation_id = ? order by created_at")
      .all(operationId);
    return rows.map((row) => {
      if (row === null || typeof row !== "object" || !("phase" in row) || typeof row.phase !== "string") {
        throw new Error("the fixture reservation row carries no phase");
      }
      return row.phase;
    });
  } finally {
    handle.close();
  }
}

/** note: A bound, freshly observed remote cache: the base every dispatch below is proven against. */
async function outboxCache(name: string): Promise<{
  fixture: ReturnType<typeof remoteFixture>;
  commit: string;
  context: StoreContext;
  dbPath: string;
}> {
  const fixture = remoteFixture(name);
  const commit = fixture.publish(fixture.payload());
  const context = contextAt(fixture.repo);
  const dbPath = locationAt(fixture.repo).dbPath;
  await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
  const check = positiveCheck();
  await ingestRemoteObservation(context, observation(check, { selectorCommit: commit, generation: 3 }));
  return { fixture, commit, context, dbPath };
}

/** note: The exact normalized project event one journal intent freezes. */
function journalEvent(
  fixture: { repoKey: string },
  operationId: string,
  parents: readonly string[] = [OBSERVED_PROJECT_HEAD],
): RemoteEvent {
  return {
    version: 1,
    repoKey: fixture.repoKey,
    projectId: SELECTED_PROJECT.localProjectId,
    operationId,
    parents,
    change: { kind: "project-replace", project: completeProjectSubject() },
  };
}

/** note: The exact normalized issue replacement one intent freezes. */
function issueEvent(fixture: { repoKey: string }, operationId: string): RemoteEvent {
  return {
    version: 1,
    repoKey: fixture.repoKey,
    projectId: SELECTED_PROJECT.localProjectId,
    operationId,
    parents: [OBSERVED_ISSUE_HEAD],
    change: { kind: "issue-replace", issueRef: FORGED_ISSUE_REF, mstar: completeIssueSubject() },
  };
}

/** note: One project-journal intent whose frozen base is the observed journal head. */
function journalIntent(
  fixture: { repoKey: string },
  commit: string,
  operationId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    binding: intentBindingFor(commit),
    event: journalEvent(fixture, operationId),
    target: JOURNAL_ANCHOR,
    expectedHeads: [OBSERVED_PROJECT_HEAD],
    ...overrides,
  };
}

/** note: One issue replacement whose frozen base is the observed issue head. */
function issueIntent(
  fixture: { repoKey: string },
  commit: string,
  operationId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    binding: intentBindingFor(commit),
    event: issueEvent(fixture, operationId),
    target: MSTAR_ISSUE,
    expectedHeads: [OBSERVED_ISSUE_HEAD],
    ...overrides,
  };
}

function attemptOf(permit: { kind: string; permit?: { attemptId: string } }): string {
  if (permit.kind !== "permit" || permit.permit === undefined) throw new Error("expected one send permit");
  return permit.permit.attemptId;
}

/** note: The two receipt inputs, exactly as the contract closes them. */
function receiptInput(
  commit: string,
  operationId: string,
  attemptId: string,
  requestHash: string,
  outcome: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    selectorCommit: commit,
    generation: 3,
    projectId: SELECTED_PROJECT.localProjectId,
    operationId,
    attemptId,
    requestHash,
    observedAt: new Date().toISOString(),
    outcome,
    ...overrides,
  };
}

/** note: The exact frozen event, decoded back as the confirmed receipt must carry it. */
function confirmedJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "confirmed",
    identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
    recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
    event: {
      version: 1,
      repoKey: "",
      projectId: SELECTED_PROJECT.localProjectId,
      operationId: "",
      parents: [OBSERVED_PROJECT_HEAD],
      change: { kind: "project-replace", project: completeProjectSubject() },
    },
    ...overrides,
  };
}

/** note: The competing immutable journal records behind one fork, bound to the journal anchor. */
function forkRecords(fixture: { repoKey: string }): Array<Record<string, unknown>> {
  return ["00000000-0000-4000-8000-000000000901", "00000000-0000-4000-8000-000000000902"].map((operationId, index) => ({
    identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
    recordId: index === 0 ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4",
    event: { ...journalEvent(fixture, operationId), parents: ["8".repeat(64)] },
  }));
}

function observationCompleteness(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select completeness from remote_observations order by project_key limit 1").get();
    if (row === null || typeof row !== "object" || !("completeness" in row) || typeof row.completeness !== "string") {
      throw new Error("the fixture observation row carries no completeness");
    }
    return row.completeness;
  } finally {
    db.close();
  }
}

describe("remote outbox lifecycle", () => {
  test("one permit is issued, replayed as state only, and serialized per binding", async () => {
    const cache = await outboxCache("outbox-permit");
    const first = "00000000-0000-4000-8000-000000000101";
    const second = "00000000-0000-4000-8000-000000000102";
    const firstIntent = await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, first));
    await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, second));

    const permit = await dispatchRemoteIntent(cache.context, first);
    expect(permit.kind).toBe("permit");
    const attemptId = attemptOf(permit);
    expect(attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(permit).toMatchObject({
      permit: {
        operationId: first,
        requestHash: firstIntent.requestHash,
        binding: { generation: 3, selectorCommit: cache.commit, journalIssueId: JOURNAL_ANCHOR },
        frozenRequest: { target: JOURNAL_ANCHOR, expectedHeads: [OBSERVED_PROJECT_HEAD] },
      },
    });
    // invariant: The permit is committed BEFORE it is returned: the row already holds it.
    expect(outboxRows(cache.dbPath).find((row) => row.operation_id === first)).toMatchObject({
      state: "unconfirmed",
      attempt_id: attemptId,
    });

    // invariant: A lost permit response never issues a second permit.
    const replay = await dispatchRemoteIntent(cache.context, first);
    expect(replay).toEqual({ kind: "state", operationId: first, state: "unconfirmed", requestHash: firstIntent.requestHash });
    expect(outboxRows(cache.dbPath).find((row) => row.operation_id === first)?.attempt_id).toBe(attemptId);

    // invariant: Sends are serialized per binding: an unresolved attempt ahead refuses the next.
    await expect(dispatchRemoteIntent(cache.context, second)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("unconfirmed"),
    });
    expect(outboxRows(cache.dbPath).find((row) => row.operation_id === second)).toMatchObject({
      state: "enqueued",
      attempt_id: null,
    });
    // note: `outbox-show` discloses the frozen request and the attempt, still never a permit.
    const read = await readRemoteIntent(cache.context, first);
    expect(read).toMatchObject({ state: "unconfirmed", attemptId, requestHash: firstIntent.requestHash, receipts: [] });

    // invariant: An unknown id names nothing instead of guessing a row.
    await expect(readRemoteIntent(cache.context, "00000000-0000-4000-8000-0000000001ff")).rejects.toMatchObject({
      code: "remote.intent-not-found",
    });
  });

  test("the pending listing reports every unsettled state and never a settled row", async () => {
    const cache = await outboxCache("outbox-pending-states");
    // note: One live checkout serializes sends, so a single cache cannot reach an unconfirmed row and
    // a conflict row through the product verbs at the same time. A cache that arrived from another
    // checkout can hold any combination, and this listing is the read that settlement starts from.
    const ids = [
      "00000000-0000-4000-8000-000000000171",
      "00000000-0000-4000-8000-000000000172",
      "00000000-0000-4000-8000-000000000173",
      "00000000-0000-4000-8000-000000000174",
      "00000000-0000-4000-8000-000000000175",
    ] as const;
    for (const operationId of ids) {
      await prepareRemoteIntent(cache.context, issueIntent(cache.fixture, cache.commit, operationId));
    }
    // note: Abandoning is the public settlement that exists before a dispatch; the remaining states
    // are the durable column values a move aside or another checkout can leave behind.
    expect((await abandonRemoteIntent(cache.context, { operationId: ids[4], reason: "fixture retires it" })).state).toBe(
      "abandoned",
    );
    const db = new DatabaseSync(cache.dbPath);
    try {
      db.prepare("update remote_outbox set state = 'unconfirmed', attempt_id = ? where operation_id = ?").run(
        "00000000-0000-4000-8000-00000000017f",
        ids[1],
      );
      db.prepare("update remote_outbox set state = 'conflict' where operation_id = ?").run(ids[2]);
      db.prepare("update remote_outbox set state = 'confirmed' where operation_id = ?").run(ids[3]);
    } finally {
      db.close();
    }

    const listing = await readPendingIntents(cache.context, SELECTED_PROJECT.localProjectId);
    expect(listing).toMatchObject({ version: 1, projectId: SELECTED_PROJECT.localProjectId, generation: 3 });
    // invariant: Every unsettled state is listed in the stable (createdAt, operationId) order, and each
    // entry carries the state the operator settles it from: an id alone does not say what a row needs.
    expect(listing.intents.map((intent) => [intent.operationId, intent.state, intent.kind, intent.target])).toEqual([
      [ids[0], "enqueued", "issue-replace", MSTAR_ISSUE],
      [ids[1], "unconfirmed", "issue-replace", MSTAR_ISSUE],
      [ids[2], "conflict", "issue-replace", MSTAR_ISSUE],
    ]);
    // invariant: A settled row is never listed, and the listing is a read: the settled rows keep their
    // own recorded states, unchanged by being listed.
    const listed = listing.intents.map((intent) => intent.operationId);
    expect(listed).not.toContain(ids[3]);
    expect(listed).not.toContain(ids[4]);
    expect(outboxStateOf(cache.dbPath, ids[3])).toBe("confirmed");
    expect(outboxStateOf(cache.dbPath, ids[4])).toBe("abandoned");
  });

  test("an absent, ambiguous or mismatched observation never confirms an attempt", async () => {
    const cache = await outboxCache("outbox-receipt");
    const operationId = "00000000-0000-4000-8000-000000000201";
    const intent = await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, operationId));
    const permit = await dispatchRemoteIntent(cache.context, operationId);
    const attemptId = attemptOf(permit);

    // invariant: Ambiguity is not evidence: a not-found/ambiguous lookup keeps `unconfirmed`.
    for (const [index, reason] of ["no-response", "not-found", "ambiguous", "provider-unavailable"].entries()) {
      const read = await reconcileRemoteIntent(
        cache.context,
        receiptInput(cache.commit, operationId, attemptId, intent.requestHash, { kind: "unconfirmed", reason },
          { observedAt: new Date(Date.now() + index).toISOString() }),
      );
      expect(read.state).toBe("unconfirmed");
    }
    expect((await readRemoteIntent(cache.context, operationId)).receipts).toHaveLength(4);

    // invariant: Evidence of another attempt or another selector never settles this one.
    await expect(
      recordRemoteReceipt(
        cache.context,
        receiptInput(cache.commit, operationId, "00000000-0000-4000-8000-0000000002ff", intent.requestHash, {
          kind: "unconfirmed",
          reason: "no-response",
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.dispatch-refused" });
    await expect(
      recordRemoteReceipt(
        cache.context,
        receiptInput("f".repeat(40), operationId, attemptId, intent.requestHash, { kind: "unconfirmed", reason: "no-response" }),
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });

    // invariant: A record that differs from the frozen event is a conflict to review, never a confirmation.
    const frozen = journalEvent(cache.fixture, operationId);
    await expect(
      recordRemoteReceipt(
        cache.context,
        receiptInput(cache.commit, operationId, attemptId, intent.requestHash, confirmedJournal({
          event: { ...frozen, parents: [] },
        })),
      ),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    expect(observationCompleteness(cache.dbPath)).toBe("complete");

    // invariant: ONLY the unique exact match confirms, and a confirmed effect invalidates the read base.
    const confirmedInput = receiptInput(cache.commit, operationId, attemptId, intent.requestHash, confirmedJournal({ event: frozen }));
    const confirmed = await recordRemoteReceipt(cache.context, confirmedInput);
    expect(confirmed).toMatchObject({ state: "confirmed", attemptId });
    expect(confirmed.receipts).toHaveLength(5);
    expect(observationCompleteness(cache.dbPath)).toBe("unavailable");
    expect(outboxRows(cache.dbPath)[0]).toMatchObject({ operation_id: operationId, state: "confirmed", attempt_id: attemptId });

    // invariant: The same submission replays its evidence instead of recording a second effect.
    const replay = await recordRemoteReceipt(cache.context, confirmedInput);
    expect(replay.state).toBe("confirmed");
    expect(replay.receipts).toHaveLength(5);
    // invariant: A different receipt of a settled attempt is refused, never re-applied.
    await expect(
      recordRemoteReceipt(
        cache.context,
        receiptInput(cache.commit, operationId, attemptId, intent.requestHash, { kind: "unconfirmed", reason: "ambiguous" }),
      ),
    ).rejects.toMatchObject({ code: "remote.dispatch-refused" });
  });

  test("one receipt refusal aggregates the subject's field and history defects together", async () => {
    const cache = await outboxCache("receipt-subject-aggregate");
    const operationId = "00000000-0000-4000-8000-000000000211";
    const intent = await prepareRemoteIntent(cache.context, issueIntent(cache.fixture, cache.commit, operationId));
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, operationId));
    const subject = completeIssueSubject();
    const fields = { ...(subject.fields as Record<string, unknown>), title: 7, revision: -1 };
    const occurrence = (subject.occurrences as Record<string, unknown>[])[0]!;
    // invariant: TWO malformed history entries — a null row and a row with a bad field — plus the
    // subject's own field defects are all named by ONE refusal: a malformed entry never truncates
    // the diagnostics of its siblings.
    const occurrences = [null, { ...occurrence, eventId: "not-a-uuid" }];
    const event = {
      version: 1,
      repoKey: cache.fixture.repoKey,
      projectId: SELECTED_PROJECT.localProjectId,
      operationId,
      parents: [OBSERVED_ISSUE_HEAD],
      change: { kind: "issue-replace", issueRef: FORGED_ISSUE_REF, mstar: { ...subject, fields, occurrences } },
    };

    // invariant: ONE structural refusal answers every defect INSIDE the known event arm — both bad
    // subject fields and BOTH malformed history rows — instead of stopping at the first one.
    await expect(
      recordRemoteReceipt(
        cache.context,
        receiptInput(cache.commit, operationId, attemptId, intent.requestHash, {
          kind: "confirmed",
          identity: { ...providerScope(), issueId: MSTAR_ISSUE },
          recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeeb",
          event,
        }),
      ),
    ).rejects.toMatchObject({
      code: "remote.input-invalid",
      message: expect.stringMatching(
        /receipt\.outcome\.event\.change\.mstar\.fields\.title[\s\S]*receipt\.outcome\.event\.change\.mstar\.fields\.revision[\s\S]*receipt\.outcome\.event\.change\.mstar\.occurrences\[0\]: must be an object[\s\S]*receipt\.outcome\.event\.change\.mstar\.occurrences\[1\]\.eventId/,
      ),
    });
    // invariant: The structural refusal happened before any outbox access: the attempt stays
    // unconfirmed with no recorded evidence row.
    expect(outboxRows(cache.dbPath)[0]).toMatchObject({ operation_id: operationId, state: "unconfirmed" });
    expect((await readRemoteIntent(cache.context, operationId)).receipts).toHaveLength(0);
  });

  test("one receipt refusal names the journal's sibling defects instead of the first one", async () => {
    const cache = await outboxCache("receipt-journal-aggregate");
    const operationId = "00000000-0000-4000-8000-000000000212";
    const intent = await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, operationId));
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, operationId));
    const project = completeProjectSubject();
    const milestones = project.milestones as Array<Record<string, unknown>>;
    const receiptOf = (change: Record<string, unknown>) =>
      receiptInput(cache.commit, operationId, attemptId, intent.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeec",
        event: {
          version: 1,
          repoKey: cache.fixture.repoKey,
          projectId: SELECTED_PROJECT.localProjectId,
          operationId,
          parents: [],
          change: { kind: "project-replace", project: change },
        },
      });

    // invariant: ONE refusal answers every project-member defect together — a milestone field, the
    // roadmap revision and the catalog-link relation — and the row that FAILED to parse never stands
    // in for an identity, so it cannot fabricate the duplicate its own diagnostic would hide.
    await expect(
      recordRemoteReceipt(
        cache.context,
        receiptOf({
          ...project,
          milestones: [{ ...milestones[0]!, name: 7 }, { ...milestones[0] }],
          roadmap: { contentMarkdown: "# Roadmap\n", revision: 0, updatedAt: "2026-11-20T00:00:00.000Z" },
          catalogLinks: [
            { fromKind: "plan", fromId: "plan-1", relation: "not-a-relation", toKind: "plan", toId: "plan-2", ordinal: 0 },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: "remote.input-invalid",
      message: expect.stringMatching(
        /change\.project\.milestones\[0\]\.name[\s\S]*change\.project\.roadmap\.revision[\s\S]*change\.project\.catalogLinks\[0\]\.relation/,
      ),
    });
    expect(outboxRows(cache.dbPath)[0]).toMatchObject({ operation_id: operationId, state: "unconfirmed" });
    expect((await readRemoteIntent(cache.context, operationId)).receipts).toHaveLength(0);

    // invariant: A repeat between two PARSED rows is still the repeat it is, reported in the same
    // aggregate as its sibling defects.
    await expect(
      recordRemoteReceipt(
        cache.context,
        receiptOf({ ...project, milestones: [{ ...milestones[0]! }, { ...milestones[0]! }] }),
      ),
    ).rejects.toMatchObject({
      code: "remote.input-invalid",
      message: expect.stringContaining("change.project.milestones: must not repeat a milestone id"),
    });
  });

  test("an imported transition with no evidence is refused by the published descriptor and the runtime", async () => {
    const cache = await outboxCache("receipt-imported-empty-evidence");
    const operationId = "00000000-0000-4000-8000-000000000213";
    const intent = await prepareRemoteIntent(cache.context, issueIntent(cache.fixture, cache.commit, operationId));
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, operationId));
    const subject = completeIssueSubject();
    const transition = (subject.transitions as Array<Record<string, unknown>>)[0]!;
    // invariant: an imported transition's evidence IS the reviewed legacy register row, which the
    // runtime requires to carry at least one business field; the empty object proves nothing.
    const transitions = [{ ...transition, imported: true, evidence: {} }];
    const input = receiptInput(cache.commit, operationId, attemptId, intent.requestHash, {
      kind: "confirmed",
      identity: { ...providerScope(), issueId: MSTAR_ISSUE },
      recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeed",
      event: {
        version: 1,
        repoKey: cache.fixture.repoKey,
        projectId: SELECTED_PROJECT.localProjectId,
        operationId,
        parents: [OBSERVED_ISSUE_HEAD],
        change: { kind: "issue-replace", issueRef: FORGED_ISSUE_REF, mstar: { ...subject, transitions } },
      },
    });

    // invariant: the published document and the runtime agree: both refuse the empty imported record.
    const descriptor = remoteReceiptDocumentSchema.safeParse(input);
    expect(descriptor.success).toBe(false);
    expect(JSON.stringify(descriptor.error?.issues)).toContain("evidence");
    await expect(recordRemoteReceipt(cache.context, input)).rejects.toMatchObject({
      code: "remote.input-invalid",
      message: expect.stringContaining("must carry the imported record's business fields"),
    });
  });

  test("a changed provider base, a stale binding and a fork surface instead of a send or an overwrite", async () => {
    const moved = await outboxCache("outbox-base");
    const operationId = "00000000-0000-4000-8000-000000000301";
    await prepareRemoteIntent(moved.context, issueIntent(moved.fixture, moved.commit, operationId));
    // invariant: The intent was frozen against the head that was observed at prepare time.
    const check = positiveCheck();
    await ingestRemoteObservation(
      moved.context,
      observation(check, {
        selectorCommit: moved.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: {
          ...completeSnapshot(check),
          project: { ...completeSnapshot(check).project, head: ["4".repeat(64)] },
          issues: completeSnapshot(check).issues.map((issue) =>
            issue.mstar === null ? issue : { ...issue, mstar: { ...issue.mstar, head: ["5".repeat(64)] } },
          ),
        },
      }),
    );
    await expect(dispatchRemoteIntent(moved.context, operationId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("base moved"),
    });
    expect(outboxRows(moved.dbPath)[0]).toMatchObject({ operation_id: operationId, state: "enqueued", attempt_id: null });

    // note: A fork is durable evidence: the attempt becomes conflicted, never overwritten.
    const forked = await outboxCache("outbox-conflict");
    const conflicted = "00000000-0000-4000-8000-000000000311";
    const intent = await prepareRemoteIntent(forked.context, journalIntent(forked.fixture, forked.commit, conflicted));
    const attemptId = attemptOf(await dispatchRemoteIntent(forked.context, conflicted));
    // invariant: A conflict's heads are the content digests of the records it names.
    const competing = forkRecords(forked.fixture);
    const fork = competing.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    const conflictedRead = await recordRemoteReceipt(
      forked.context,
      receiptInput(forked.commit, conflicted, attemptId, intent.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_PROJECT_HEAD],
        observedHeads: fork,
        observedRecords: competing,
      }),
    );
    expect(conflictedRead.state).toBe("conflict");
    // invariant: An ambiguous effect is never abandoned as absent.
    await expect(abandonRemoteIntent(forked.context, { operationId: conflicted, reason: "assume unsent" })).rejects.toMatchObject({
      code: "remote.dispatch-refused",
    });
    await expect(dispatchRemoteIntent(forked.context, conflicted)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
    });

    // invariant: A resolution cites the COMPLETE recorded fork and keeps the original event intact.
    const resolution = "00000000-0000-4000-8000-000000000312";
    const resolutionEvent = {
      version: 1,
      repoKey: forked.fixture.repoKey,
      projectId: SELECTED_PROJECT.localProjectId,
      operationId: resolution,
      parents: fork,
      change: { kind: "project-replace", project: completeProjectSubject() },
    };
    await expect(
      prepareRemoteResolution(forked.context, conflicted, {
        operationId: resolution,
        operator: "operator-one",
        reason: "merge the fork",
        event: { ...resolutionEvent, parents: [fork[0]!] },
      }),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });

    const prepared = await prepareRemoteResolution(forked.context, conflicted, {
      operationId: resolution,
      operator: "operator-one",
      reason: "merge the fork",
      event: resolutionEvent,
    });
    expect(prepared).toMatchObject({ state: "enqueued", target: JOURNAL_ANCHOR });
    const original = await readRemoteIntent(forked.context, conflicted);
    expect(original).toMatchObject({ state: "conflict", resolvedBy: resolution });
    expect(original.event).toEqual(journalEvent(forked.fixture, conflicted));
    // invariant: An identical replay returns the same resolution and inserts nothing.
    const replayed = await prepareRemoteResolution(forked.context, conflicted, {
      operationId: resolution,
      operator: "operator-one",
      reason: "merge the fork",
      event: resolutionEvent,
    });
    expect(replayed).toMatchObject({ state: "enqueued", replayed: true });
    expect(outboxRows(forked.dbPath)).toHaveLength(2);
    // invariant: A fork observation whose heads are not the recorded fork is never sent.
    await expect(
      dispatchRemoteIntent(forked.context, resolution, forkObservationFor(forked, conflicted, [OBSERVED_PROJECT_HEAD])),
    ).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("exactly the fork heads"),
    });

    // invariant: A complete host observation that began after the conflict dispatches the reviewed
    // resolution; the cached snapshot is not its base proof.
    const dispatched = await dispatchRemoteIntent(forked.context, resolution, forkObservationFor(forked, conflicted, fork));
    expect(dispatched.kind).toBe("permit");
    // invariant: The original conflict stays conflicted; only the resolution advances.
    expect((await readRemoteIntent(forked.context, conflicted)).state).toBe("conflict");
    const confirmed = await recordRemoteReceipt(
      forked.context,
      receiptInput(forked.commit, resolution, attemptOf(dispatched), (await readRemoteIntent(forked.context, resolution)).requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee5",
        event: resolutionEvent,
      }),
    );
    expect(confirmed.state).toBe("confirmed");
  }, 30_000);

  test("an explicit abandonment is the only path for an unsent intent", async () => {
    const cache = await outboxCache("outbox-abandon");
    const operationId = "00000000-0000-4000-8000-000000000401";
    await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, operationId));
    const abandoned = await abandonRemoteIntent(cache.context, { operationId, reason: "superseded by a reviewed request" });
    expect(abandoned).toMatchObject({ state: "abandoned", operationId });
    const read = await readRemoteIntent(cache.context, operationId);
    expect(read).toMatchObject({ state: "abandoned", abandonReason: "superseded by a reviewed request" });
    await expect(dispatchRemoteIntent(cache.context, operationId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("abandoned"),
    });
  });

  test("a composite interrupted after confirmation replays only its execution acknowledgement", async () => {
    const cache = await outboxCache("outbox-composite");
    (await initializeStore(cache.context)).close();
    const state = await readExecutionState(cache.context);
    const key = { executionStoreId: state.storeId, executionEpoch: state.epoch, operationId: "composite-remote-close" };
    const intent: CompositeIntent = {
      key,
      kind: "residual-close",
      requestHash: "composite-remote-close-hash",
      target: { repoKey: cache.fixture.repoKey, mode: "remote", storeId: state.storeId, epoch: state.epoch },
      scope: { workflowId: null, planId: null },
      actor: "project-manager",
      expectedExecution: state.token,
      frozenPayload: JSON.stringify({ issueId: MSTAR_ISSUE }),
    };
    await withExecutionTransaction(cache.context, (tx) => reserveCompositeIntent(tx, intent, { revision: tx.execution.revision }));

    let finalizes = 0;
    let remoteId = "";
    const effects = {
      apply: () => {
        throw new Error("a remote composite never writes the local collaboration lane");
      },
      finalize: () => {
        finalizes += 1;
        return "finalized";
      },
      remote: async (context: StoreContext) => {
        remoteId = remoteCompositeOperationId(key);
        return prepareRemoteIntent(context, issueIntent(cache.fixture, cache.commit, remoteId));
      },
    };

    // invariant: A queued provider write is never business success, and the reservation stays prepared.
    const queued = await refusalOf(() => runCollaborationComposite(cache.context, intent, effects));
    expect(queued.code).toBe("collaboration.operation-partial");
    expect(detailsOf(queued)).toMatchObject({ phase: "prepared", operation_id: "composite-remote-close" });
    expect(finalizes).toBe(0);
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
    expect(outboxRows(cache.dbPath)[0]).toMatchObject({ operation_id: remoteId, state: "enqueued" });
    expect(await intentPhases(cache.context, "composite-remote-close")).toEqual(["prepared"]);

    // note: The provider effect is confirmed against the exact frozen issue event.
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, remoteId));
    const frozen = issueEvent(cache.fixture, remoteId);
    const confirmed = await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, remoteId, attemptId, (await readRemoteIntent(cache.context, remoteId)).requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        event: frozen,
      }),
    );
    expect(confirmed.state).toBe("confirmed");

    // invariant: The replay commits ONLY the execution delta of the confirmed effect.
    const completed = await runCollaborationComposite(cache.context, intent, effects);
    expect(completed).toBe("finalized");
    expect(finalizes).toBe(1);
    expect(await intentPhases(cache.context, "composite-remote-close")).toEqual(["confirmed"]);
    expect(outboxRows(cache.dbPath)).toHaveLength(1);

    // invariant: A further replay serves the recorded result and never repeats either half.
    const replay = await runCollaborationComposite(cache.context, intent, effects);
    expect(replay).toBe("finalized");
    expect(finalizes).toBe(1);
    expect(outboxRows(cache.dbPath)[0]).toMatchObject({ state: "confirmed" });
  });

  test("an ordinary write freezes one provider event and never touches the local lane", async () => {
    const cache = await outboxCache("outbox-writers");
    const actor = "project-manager";
    const capture = {
      projectId: SELECTED_PROJECT.localProjectId,
      title: "A captured finding",
      kind: "bug" as const,
      severity: "high" as const,
      impact: "remote writes are not durable",
      acceptance: "a captured finding is one durable intent",
      sourceIdentity: "qc/review.md",
      rootCauseKey: "missing-guard",
      acceptanceKey: "guard-present",
      occurrenceKey: "run-1",
      sourceKind: "qc",
      location: "packages/engine/src/issue.ts:1",
      observedBehavior: "the write refused",
      evidence: ["stack: TypeError"],
      discoveredAt: "2026-11-20T00:00:00.000Z",
    };

    // invariant: A captured finding is one `issue-create` intent, not a local issue row.
    const created = await refusalOf(() =>
      captureIssue(cache.context, capture, { operationId: "00000000-0000-4000-8000-000000000501", actor }),
    );
    expect(created.code).toBe("remote.effect-pending");
    expect(detailsOf(created)).toMatchObject({ operationId: "00000000-0000-4000-8000-000000000501", state: "enqueued" });
    const createdRow = outboxRows(cache.dbPath).find((row) => row.operation_id === "00000000-0000-4000-8000-000000000501");
    expect(createdRow).toBeDefined();
    const createdRequest = JSON.parse(createdRow!.request_json);
    expect(createdRequest.event.change.kind).toBe("issue-create");
    expect(createdRequest.event.parents).toEqual([]);
    expect(createdRequest.target).toBeNull();
    expect(createdRequest.event.change.mstar.fields.title).toBe("A captured finding");
    expect(cacheRows(cache.dbPath)).toMatchObject({ localIssues: 0, localCatalog: 0 });

    // invariant: Replaying the same verb with the same id returns the frozen intent (a minted
    // reference or a recorded time is never re-derived), and a different write under that id refuses.
    const replay = await refusalOf(() =>
      captureIssue(cache.context, capture, { operationId: "00000000-0000-4000-8000-000000000501", actor }),
    );
    expect(replay.code).toBe("remote.effect-pending");
    expect(detailsOf(replay)).toMatchObject({ operationId: "00000000-0000-4000-8000-000000000501", state: "enqueued" });
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
    expect(outboxRows(cache.dbPath)[0]!.request_hash).toBe(createdRow!.request_hash);
    await expect(
      closeIssue(
        cache.context,
        FORGED_ISSUE_REF,
        "resolved",
        { reason: "fixed", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        { operationId: "00000000-0000-4000-8000-000000000501", actor },
      ),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    expect(outboxRows(cache.dbPath)).toHaveLength(1);

    // invariant: A close appends one transition to the OBSERVED subject, under its observed head.
    const closed = await refusalOf(() =>
      closeIssue(
        cache.context,
        FORGED_ISSUE_REF,
        "resolved",
        { reason: "fixed", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        { operationId: "00000000-0000-4000-8000-000000000502", actor, expectedRevision: 1 },
      ),
    );
    expect(closed.code).toBe("remote.effect-pending");
    const closedRequest = JSON.parse(
      outboxRows(cache.dbPath).find((row) => row.operation_id === "00000000-0000-4000-8000-000000000502")!.request_json,
    );
    expect(closedRequest.event.parents).toEqual([OBSERVED_ISSUE_HEAD]);
    expect(closedRequest.target).toBe(MSTAR_ISSUE);
    const closeChange = closedRequest.event.change;
    expect(closeChange.kind).toBe("issue-replace");
    expect(closeChange.mstar.fields).toMatchObject({ disposition: "resolved", revision: 2, closureNote: "fixed" });
    expect(closeChange.mstar.transitions).toHaveLength(2);
    expect(closeChange.mstar.transitions[1]).toMatchObject({
      fromDisposition: "open",
      toDisposition: "resolved",
      actor,
      issueRevision: 2,
    });

    // invariant: A milestone write is one project-replace against the observed journal head.
    const milestone = await refusalOf(() =>
      addMilestone(
        cache.context,
        { projectId: SELECTED_PROJECT.localProjectId, name: "Second delivery", effortSessions: null, ordinal: 1 },
        { operationId: "00000000-0000-4000-8000-000000000503", expectedStoreRevision: observationRevision(cache.dbPath) },
      ),
    );
    expect(milestone.code).toBe("remote.effect-pending");
    const milestoneRequest = JSON.parse(
      outboxRows(cache.dbPath).find((row) => row.operation_id === "00000000-0000-4000-8000-000000000503")!.request_json,
    );
    expect(milestoneRequest.event.parents).toEqual([OBSERVED_PROJECT_HEAD]);
    expect(milestoneRequest.target).toBe(JOURNAL_ANCHOR);
    expect(milestoneRequest.event.change.project.milestones).toMatchObject([
      { milestoneId: "milestone-1" },
      { name: "Second delivery", status: "planned", ordinal: 1, revision: 1 },
    ]);

    // invariant: An unsupported remote rewrite refuses by name instead of fabricating an event.
    await expect(
      moveIssue(
        cache.context,
        FORGED_ISSUE_REF,
        { projectId: SELECTED_PROJECT.localProjectId, reason: "elsewhere" },
        { operationId: "00000000-0000-4000-8000-000000000504", actor, expectedRevision: 1, expectedStoreRevision: 0 },
      ),
    ).rejects.toMatchObject({ code: "collaboration.mode-unavailable" });
    expect(outboxRows(cache.dbPath)).toHaveLength(3);
    expect(cacheRows(cache.dbPath)).toMatchObject({ localIssues: 0, localCatalog: 0, localProjectBindings: 0 });

    // invariant: The pending summaries expose what the host sends, without a permit.
    const pending = await readPendingIntents(cache.context, SELECTED_PROJECT.localProjectId);
    expect(pending.intents.map((intent) => [intent.kind, intent.target])).toEqual([
      ["issue-create", null],
      ["issue-replace", MSTAR_ISSUE],
      ["project-replace", JOURNAL_ANCHOR],
    ]);
  });
});

// ---------------------------------------------------------------------------
// note: Task 2 review fixes: receipt identity, fork recovery, inspection scope,
// domain checks before freezing, and the confirmed business result.
// ---------------------------------------------------------------------------

/** note: One capture request the fixture accepts, varying only by title when a case needs another. */
function fixtureCapture(title = "A captured finding"): Record<string, unknown> {
  return {
    projectId: SELECTED_PROJECT.localProjectId,
    title,
    kind: "bug",
    severity: "high",
    impact: "remote writes are not durable",
    acceptance: "a captured finding is one durable intent",
    sourceIdentity: "qc/review.md",
    rootCauseKey: "missing-guard",
    acceptanceKey: "guard-present",
    occurrenceKey: "run-1",
    sourceKind: "qc",
    location: "packages/engine/src/issue.ts:1",
    observedBehavior: "the write refused",
    evidence: ["stack: TypeError"],
    discoveredAt: "2026-11-20T00:00:00.000Z",
  };
}

/** note: The frozen request of one recorded operation, as the cache stores it. */
function frozenOperation(dbPath: string, operationId: string): Record<string, unknown> {
  const row = outboxRows(dbPath).find((entry) => entry.operation_id === operationId);
  if (row === undefined) throw new Error(`operation ${operationId} is not recorded`);
  return JSON.parse(row.request_json) as Record<string, unknown>;
}

/** note: Re-observe the fixture's whole project after a confirmed effect invalidated its base. */
async function reobserve(cache: { context: StoreContext; commit: string }, expectRevision: number): Promise<void> {
  await ingestRemoteObservation(
    cache.context,
    observation(positiveCheck(), { selectorCommit: cache.commit, generation: 3, expectRevision }),
  );
}

/** note: An ordinary write's outbox intent is addressed by its own operation id. */
function outboxIdFor(dbPath: string, operationId: string): string {
  const row = outboxRows(dbPath).find((entry) => entry.operation_id === operationId);
  if (row === undefined) throw new Error(`no outbox intent is recorded for operation ${operationId}`);
  return row.operation_id;
}

/** note: The outbox state and evidence of one operation. */
function outboxStateOf(dbPath: string, operationId: string): string {
  const row = outboxRows(dbPath).find((entry) => entry.operation_id === operationId);
  if (row === undefined) throw new Error(`operation ${operationId} is not recorded`);
  return row.state;
}

/** note: Rewrite the binding's own verification facts, as an expired or revoked check would. */
function rewriteVerification(dbPath: string, patch: { verifiedAt?: string; outcome?: Record<string, unknown> }): void {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select verification_json from remote_bindings where generation = 3").get() as {
      verification_json: string;
    };
    const check = JSON.parse(row.verification_json) as Record<string, unknown>;
    if (patch.outcome !== undefined) check.outcome = patch.outcome;
    if (patch.verifiedAt !== undefined) check.checkedAt = patch.verifiedAt;
    db.prepare("update remote_bindings set verification_json = ?, verified_at = ? where generation = 3").run(
      JSON.stringify(check),
      patch.verifiedAt ?? String(check.checkedAt),
    );
  } finally {
    db.close();
  }
}

describe("remote outbox review fixes", () => {
  test("an operation id replays only its identical request, target and execution key", async () => {
    const cache = await outboxCache("outbox-replay-identity");
    const project = SELECTED_PROJECT.localProjectId;
    const duplicateId = "00000000-0000-4000-8000-000000000601";
    const first = await refusalOf(() =>
      addMilestone(cache.context, { projectId: project, name: "First delivery", effortSessions: null, ordinal: 1 }, {
        operationId: duplicateId,
        expectedStoreRevision: observationRevision(cache.dbPath),
      }),
    );
    expect(first.code).toBe("remote.effect-pending");

    // invariant: Another verb under the same operation id never replays the milestone request.
    await expect(
      replaceRoadmapAuthority(
        cache.context,
        { projectId: project, expectedProjectRevision: 1, expectedRoadmapRevision: 2, contentMarkdown: `---\nproject_id: ${project}\ntitle: Synthetic roadmap\nstatus: active\ncreated_at: 2026-09-25\n---\n\n## Direction\n\nReplaced.\n` },
        { operationId: duplicateId },
      ),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    // invariant: A changed payload under the same id never replays the accepted request.
    await expect(
      addMilestone(cache.context, { projectId: project, name: "Another delivery", effortSessions: null, ordinal: 1 }, {
        operationId: duplicateId,
        expectedStoreRevision: observationRevision(cache.dbPath),
      }),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    // invariant: The identical request still replays its durable state.
    const replay = await refusalOf(() =>
      addMilestone(cache.context, { projectId: project, name: "First delivery", effortSessions: null, ordinal: 1 }, {
        operationId: duplicateId,
        expectedStoreRevision: observationRevision(cache.dbPath),
      }),
    );
    expect(replay.code).toBe("remote.effect-pending");
    expect(outboxRows(cache.dbPath)).toHaveLength(1);

    // invariant: A replacement addressed by another provider id never replays this target.
    const closeId = "00000000-0000-4000-8000-000000000602";
    const closed = await refusalOf(() =>
      closeIssue(
        cache.context,
        MSTAR_ISSUE,
        "resolved",
        { reason: "fixed", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        { operationId: closeId, actor: "project-manager", expectedRevision: 1 },
      ),
    );
    expect(closed.code).toBe("remote.effect-pending");
    await expect(
      closeIssue(
        cache.context,
        PROVIDER_ONLY_ISSUE,
        "resolved",
        { reason: "fixed", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        { operationId: closeId, actor: "project-manager", expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    expect(outboxRows(cache.dbPath)).toHaveLength(2);
  });

  test("a create is confirmed by its new record and its replay reports the result", async () => {
    const cache = await outboxCache("outbox-create-confirm");
    const operationId = "00000000-0000-4000-8000-000000000611";
    const capture = fixtureCapture() as never;
    const queued = await refusalOf(() => captureIssue(cache.context, capture, { operationId, actor: "project-manager" }));
    expect(queued.code).toBe("remote.effect-pending");
    const permit = await dispatchRemoteIntent(cache.context, operationId);
    const attemptId = attemptOf(permit);
    const frozen = frozenOperation(cache.dbPath, operationId).event as RemoteEvent;
    const created = "99999999-9999-4999-8999-999999999999";
    const requestHash = outboxRows(cache.dbPath)[0]!.request_hash;

    // invariant: The journal anchor is never the created issue's identity.
    await expect(
      recordRemoteReceipt(
        cache.context,
        receiptInput(cache.commit, operationId, attemptId, requestHash, {
          kind: "confirmed",
          identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
          recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee8",
          event: frozen,
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.scope-mismatch" });

    // invariant: The genesis event lives in the created issue, so a receipt naming another
    // immutable record attests no single record and never confirms the create.
    await expect(
      recordRemoteReceipt(
        cache.context,
        receiptInput(cache.commit, operationId, attemptId, requestHash, {
          kind: "confirmed",
          identity: { ...providerScope(), issueId: created },
          recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee8",
          event: frozen,
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    expect(await readRemoteIntent(cache.context, operationId)).toMatchObject({ state: "unconfirmed", receipts: [] });

    // invariant: The NEW issue identity in the selected scope confirms the exact frozen create.
    const confirmed = await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, operationId, attemptId, requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: created },
        recordId: created,
        event: frozen,
      }),
    );
    expect(confirmed.state).toBe("confirmed");
    expect(confirmed.confirmed?.identity.issueId).toBe(created);

    // invariant: The identical business replay reports its recorded result, not another refusal.
    const replay = await captureIssue(cache.context, capture, { operationId, actor: "project-manager" });
    expect(replay).toMatchObject({ issueId: created, revision: 1, storeRevision: 0, created: true });
    // invariant: A different capture under that id is still a conflict, never the recorded result.
    await expect(
      captureIssue(cache.context, fixtureCapture("Another finding") as never, { operationId, actor: "project-manager" }),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
  });

  test("a reconciliation never proves an attempt unsent and a conflict never becomes confirmed", async () => {
    const cache = await outboxCache("outbox-unsent");
    const operationId = "00000000-0000-4000-8000-000000000621";
    const intent = await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, operationId));
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, operationId));

    // invariant: A lookup cannot prove nothing was sent; the reconciliation document has no such arm
    // at all, so the structural refusal names the receipt that can record it.
    await expect(
      reconcileRemoteIntent(
        cache.context,
        receiptInput(cache.commit, operationId, attemptId, intent.requestHash, { kind: "not-sent", code: "pre-send" }),
      ),
    ).rejects.toMatchObject({
      code: "remote.input-invalid",
      message: expect.stringContaining("outbox-receipt"),
    });
    await expect(abandonRemoteIntent(cache.context, { operationId, reason: "assume unsent" })).rejects.toMatchObject({
      code: "remote.dispatch-refused",
    });
    const unsent = await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, operationId, attemptId, intent.requestHash, { kind: "not-sent", code: "pre-send" }),
    );
    expect(unsent.state).toBe("unconfirmed");
    expect((await abandonRemoteIntent(cache.context, { operationId, reason: "host refused before send" })).state).toBe(
      "abandoned",
    );

    // note: A complete fork is the only conflict evidence that is recorded at all.
    const forked = await outboxCache("outbox-conflict-terminal");
    const conflictedId = "00000000-0000-4000-8000-000000000622";
    const conflicted = await prepareRemoteIntent(forked.context, issueIntent(forked.fixture, forked.commit, conflictedId));
    const forkedAttempt = attemptOf(await dispatchRemoteIntent(forked.context, conflictedId));
    const records = ["00000000-0000-4000-8000-0000000009a1", "00000000-0000-4000-8000-0000000009a2"].map(
      (conflicting, index) => ({
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: index === 0 ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeea",
        event: {
          ...(frozenOperation(forked.dbPath, conflictedId).event as RemoteEvent),
          operationId: conflicting,
          parents: ["8".repeat(64)],
        },
      }),
    );
    const heads = records.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    const conflictInput = (outcome: Record<string, unknown>): Record<string, unknown> =>
      receiptInput(forked.commit, conflictedId, forkedAttempt, conflicted.requestHash, outcome);
    // invariant: Partial, foreign and duplicated evidence is refused instead of stored.
    await expect(
      recordRemoteReceipt(forked.context, conflictInput({ kind: "conflict", expectedHeads: [OBSERVED_ISSUE_HEAD], observedHeads: heads, observedRecords: [] })),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    await expect(
      recordRemoteReceipt(
        forked.context,
        conflictInput({
          kind: "conflict",
          expectedHeads: [OBSERVED_ISSUE_HEAD],
          observedHeads: heads,
          observedRecords: [records[0]!, { ...records[1]!, identity: { ...providerScope(), issueId: JOURNAL_ANCHOR } }],
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.scope-mismatch" });
    await expect(
      recordRemoteReceipt(
        forked.context,
        conflictInput({ kind: "conflict", expectedHeads: [OBSERVED_ISSUE_HEAD], observedHeads: heads, observedRecords: [records[0]!, records[0]!] }),
      ),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    const recorded = await recordRemoteReceipt(
      forked.context,
      conflictInput({ kind: "conflict", expectedHeads: [OBSERVED_ISSUE_HEAD], observedHeads: heads, observedRecords: records }),
    );
    expect(recorded.state).toBe("conflict");
    // invariant: The recorded conflict is terminal: a later exact confirmation never rewrites it.
    await expect(
      recordRemoteReceipt(
        forked.context,
        conflictInput({
          kind: "confirmed",
          identity: { ...providerScope(), issueId: MSTAR_ISSUE },
          recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeeb",
          event: frozenOperation(forked.dbPath, conflictedId).event as RemoteEvent,
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.dispatch-refused" });
    expect(outboxStateOf(forked.dbPath, conflictedId)).toBe("conflict");
  });

  test("expired or denied read access discloses only intent metadata", async () => {
    const cache = await outboxCache("outbox-metadata");
    const operationId = "00000000-0000-4000-8000-000000000631";
    await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, operationId));
    const full = await readRemoteIntent(cache.context, operationId);
    expect(full).toMatchObject({ disclosure: "full", target: JOURNAL_ANCHOR });
    expect(full.event).not.toBeNull();

    // invariant: An expired check withholds the frozen request but never the durable state.
    rewriteVerification(cache.dbPath, { verifiedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const expired = await readRemoteIntent(cache.context, operationId);
    expect(expired).toMatchObject({
      disclosure: "metadata",
      state: "enqueued",
      requestHash: full.requestHash,
      target: null,
      event: null,
      expectedHeads: [],
      receipts: [],
    });
    expect(expired.binding.selectorCommit).toBe(cache.commit);

    // invariant: A denied check discloses the same metadata and refuses a business replay.
    rewriteVerification(cache.dbPath, {
      verifiedAt: new Date().toISOString(),
      outcome: { kind: "denied" },
    });
    expect(await readRemoteIntent(cache.context, operationId)).toMatchObject({ disclosure: "metadata", event: null });
    await expect(
      captureIssue(cache.context, fixtureCapture() as never, { operationId: "00000000-0000-4000-8000-000000000632", actor: "project-manager" }),
    ).rejects.toMatchObject({ code: "remote.unavailable" });
  });

  test("a draining selector serves reads and reconciliation under its previous binding", async () => {
    const cache = await outboxCache("outbox-draining");
    const operationId = "00000000-0000-4000-8000-000000000641";
    const intent = await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, operationId));
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, operationId));

    cache.fixture.publish(
      cache.fixture.payload({
        generation: 4,
        phase: "draining",
        previous: { selectorCommit: cache.commit, generation: 3, mode: "remote" },
        cutover: {
          operator: "operator-one",
          reviewedAt: "2026-11-21T00:00:00.000Z",
          sourceFenced: false,
          pendingOperationIds: [operationId],
          verifiedTargetDigest: "a".repeat(64),
        },
      }),
    );

    // invariant: The pinned previous generation stays inspectable while the selector drains.
    const read = await readRemoteIntent(cache.context, operationId);
    expect(read).toMatchObject({ generation: 3, disclosure: "full", state: "unconfirmed", attemptId });
    expect((await readPendingIntents(cache.context, SELECTED_PROJECT.localProjectId)).generation).toBe(3);
    // invariant: Recovery under the previous binding is admitted; a new prepare and a new
    // receipt (a send settlement, not recovery) are not.
    const reconciled = await reconcileRemoteIntent(
      cache.context,
      receiptInput(cache.commit, operationId, attemptId, intent.requestHash, { kind: "unconfirmed", reason: "no-response" }),
    );
    expect(reconciled.state).toBe("unconfirmed");
    await expect(
      recordRemoteReceipt(
        cache.context,
        receiptInput(cache.commit, operationId, attemptId, intent.requestHash, { kind: "unconfirmed", reason: "ambiguous" }),
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    await expect(
      prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, "00000000-0000-4000-8000-000000000642")),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
  });

  test("a remote close enforces the observed revision and the open transition", async () => {
    const cache = await outboxCache("outbox-close-checks");
    const actor = "project-manager";
    // invariant: A missing or stale reviewed revision never freezes against the current subject.
    await expect(
      closeIssue(
        cache.context,
        MSTAR_ISSUE,
        "resolved",
        { reason: "fixed", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        { operationId: "00000000-0000-4000-8000-000000000651", actor },
      ),
    ).rejects.toMatchObject({ code: "issue.revision-conflict" });
    await expect(
      closeIssue(
        cache.context,
        MSTAR_ISSUE,
        "resolved",
        { reason: "fixed", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        { operationId: "00000000-0000-4000-8000-000000000652", actor, expectedRevision: 7 },
      ),
    ).rejects.toMatchObject({ code: "issue.revision-conflict" });
    // invariant: A referenced canonical issue must be observed, and never the closing issue itself.
    await expect(
      closeIssue(
        cache.context,
        MSTAR_ISSUE,
        "duplicate",
        { reason: "same finding", references: ["review-fixture"], canonicalIssueId: "mstar:issue:cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
        { operationId: "00000000-0000-4000-8000-000000000653", actor, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "issue.not-found" });
    expect(outboxRows(cache.dbPath)).toEqual([]);
  });

  test("milestone gates count the scoped snapshot and enforce referenced milestones", async () => {
    const cache = await outboxCache("outbox-milestone-checks");
    const project = SELECTED_PROJECT.localProjectId;
    // note: The snapshot's issues are scoped to this project, so a milestone's counts must not
    // compare the provider project id with the local project key (they differ here).
    const observed = completeSnapshot();
    const withMilestoneIssue = {
      ...observed,
      issues: observed.issues.map((issue) =>
        issue.mstar === null
          ? issue
          : { ...issue, mstar: { ...issue.mstar, fields: { ...issue.mstar.fields, milestoneId: "milestone-1" } } },
      ),
    };
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), { selectorCommit: cache.commit, generation: 3, expectRevision: 1, snapshot: withMilestoneIssue }),
    );
    await expect(
      updateMilestone(
        cache.context,
        project,
        "milestone-1",
        { status: "delivered" },
        { operationId: "00000000-0000-4000-8000-000000000661", expectedStoreRevision: 0 },
      ),
    ).rejects.toMatchObject({ code: "milestone.open-issues" });
    await expect(
      removeMilestone(cache.context, project, "milestone-1", {
        operationId: "00000000-0000-4000-8000-000000000662",
        expectedStoreRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "milestone.not-empty" });
    // invariant: Assigning an unknown milestone refuses before anything is frozen.
    await expect(
      assignIssueMilestone(
        cache.context,
        MSTAR_ISSUE,
        { projectId: project, milestoneId: "milestone-missing", reason: "assign it" },
        { operationId: "00000000-0000-4000-8000-000000000663", actor: "project-manager", expectedRevision: 1, expectedStoreRevision: 0 },
      ),
    ).rejects.toMatchObject({ code: "milestone.not-found" });
    expect(outboxRows(cache.dbPath)).toEqual([]);
  });

  test("a roadmap write refuses a stale reviewed revision", async () => {
    const cache = await outboxCache("outbox-roadmap-revision");
    const project = SELECTED_PROJECT.localProjectId;
    await expect(
      replaceRoadmapAuthority(
        cache.context,
        { projectId: project, expectedProjectRevision: 9, expectedRoadmapRevision: 2, contentMarkdown: `---\nproject_id: ${project}\ntitle: Synthetic roadmap\nstatus: active\ncreated_at: 2026-09-25\n---\n\n## Direction\n\nNew.\n` },
        { operationId: "00000000-0000-4000-8000-000000000671" },
      ),
    ).rejects.toMatchObject({ code: "roadmap.revision-conflict" });
    await expect(
      replaceRoadmapAuthority(
        cache.context,
        { projectId: project, expectedProjectRevision: 1, expectedRoadmapRevision: 7, contentMarkdown: `---\nproject_id: ${project}\ntitle: Synthetic roadmap\nstatus: active\ncreated_at: 2026-09-25\n---\n\n## Direction\n\nNew.\n` },
        { operationId: "00000000-0000-4000-8000-000000000672" },
      ),
    ).rejects.toMatchObject({ code: "roadmap.revision-conflict" });
    expect(outboxRows(cache.dbPath)).toEqual([]);
    // invariant: The reviewed basis still admits the write, and its confirmation is reported.
    await expect(
      replaceRoadmapAuthority(
        cache.context,
        { projectId: project, expectedProjectRevision: 1, expectedRoadmapRevision: 2, contentMarkdown: `---\nproject_id: ${project}\ntitle: Synthetic roadmap\nstatus: active\ncreated_at: 2026-09-25\n---\n\n## Direction\n\nNew.\n` },
        { operationId: "00000000-0000-4000-8000-000000000673" },
      ),
    ).rejects.toMatchObject({ code: "remote.effect-pending" });
  });

  test("an unrelated conflict keeps blocking after a reviewed resolution", async () => {
    const cache = await outboxCache("outbox-unrelated-conflict");
    const conflictedId = "00000000-0000-4000-8000-000000000681";
    const conflicted = await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, conflictedId));
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, conflictedId));
    const records = ["00000000-0000-4000-8000-0000000009b1", "00000000-0000-4000-8000-0000000009b2"].map(
      (operationId, index) => ({
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: index === 0 ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeec" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeed",
        event: {
          ...journalEvent(cache.fixture, operationId),
          parents: ["8".repeat(64)],
        },
      }),
    );
    const heads = records.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, conflictedId, attemptId, conflicted.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_PROJECT_HEAD],
        observedHeads: heads,
        observedRecords: records,
      }),
    );
    const resolutionId = "00000000-0000-4000-8000-000000000682";
    const resolutionEvent = {
      ...journalEvent(cache.fixture, resolutionId, heads),
    };
    await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "merge the fork",
      event: resolutionEvent,
    });
    // note: A SECOND, unrelated conflict of the same binding still blocks the resolution: only
    // the NAMED fork is exempt. The sibling is forced into the durable conflict state here
    // because serialized sends cannot otherwise reach two conflicts in one binding.
    const otherId = "00000000-0000-4000-8000-000000000683";
    await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, otherId));
    const db = new DatabaseSync(cache.dbPath);
    try {
      db.prepare("update remote_outbox set state = 'conflict' where operation_id = ?").run(otherId);
    } finally {
      db.close();
    }
    // note: The fork observation is complete and newer, so only the unrelated conflict can refuse the repair.
    await expect(
      dispatchRemoteIntent(cache.context, resolutionId, forkObservationFor(cache, conflictedId, heads)),
    ).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      details: expect.objectContaining({ ahead: otherId }),
    });
  });
});

/** note: One execution workflow in the remote fixture's own harness root, bound to one coordinator. */
async function remoteExecutionWorkflow(cache: {
  context: StoreContext;
}): Promise<{
  caller: ExecutionCaller;
  planId: string;
  planToken: ExecutionToken;
  session: ExecutionSessionRef;
  storeId: string;
  epoch: number;
}> {
  (await initializeStore(cache.context)).close();
  const state = await readExecutionState(cache.context);
  const caller: ExecutionCaller = { sessionId: "host-remote-coord", role: "coordinator", workflowId: "wf-remote" };
  const created = await createExecutionWorkflow({ harnessDir: cache.context.harnessDir, caller }, {
    entry: { id: "wf-remote", type: "plan", started_at: "2026-11-20T00:00:00.000Z", dir: "workflows/wf-remote" } as WorkflowEntry,
    snapshot: {
      schema_version: 1,
      id: "wf-remote",
      type: "plan",
      status: "running",
      started_at: "2026-11-20T00:00:00.000Z",
      updated_at: "2026-11-20T00:00:00.000Z",
      plans: [{ id: "p-remote", title: "Remote plan", file: "plans/p-remote.md", status: "Todo" }],
      delivery_kind: "development",
      branch: { source: "feature/wf-remote", target: "main" },
    } as unknown as WorkflowSnapshot,
    expected: state.token,
    operationId: "create-wf-remote",
  });
  const [workflow] = created.data.workflows;
  const bound = await bindExecutionSession({ harnessDir: cache.context.harnessDir, caller }, {
    workflowId: "wf-remote",
    expected: workflow.workflowToken,
    operationId: "bind-wf-remote",
  } as Parameters<typeof bindExecutionSession>[1]);
  const plan = await readExecutionPlan({ harnessDir: cache.context.harnessDir, caller }, bound.data, "p-remote");
  return {
    caller,
    planId: "p-remote",
    planToken: plan.token,
    session: bound.data,
    storeId: created.storeId,
    epoch: created.epoch,
  };
}

/** note: The complete snapshot whose marked issue carries one scoped plan link. */
function linkedSnapshot(planId: string): RemoteSnapshot {
  const snapshot = completeSnapshot();
  return {
    ...snapshot,
    issues: snapshot.issues.map((issue) =>
      issue.mstar === null
        ? issue
        : {
            ...issue,
            mstar: {
              ...issue.mstar,
              provenance: [
                ...issue.mstar.provenance,
                {
                  eventId: "55555555-5555-4555-8555-555555555555",
                  kind: "plan",
                  target: planId,
                  sourceHash: "5".repeat(64),
                  origin: "scoped",
                  legacyProject: null,
                  legacyBucket: null,
                  legacyEntryId: null,
                  legacyRecord: null,
                  importedAt: null,
                },
              ],
            },
          },
    ),
  };
}

/** note: The linked snapshot plus one issue whose subject already carries `issueRef` (a create's duplicate). */
function boundReferenceSnapshot(planId: string, issueRef: string, issueId: string): RemoteSnapshot {
  const snapshot = linkedSnapshot(planId);
  return {
    ...snapshot,
    issues: [
      ...snapshot.issues,
      {
        identity: { ...providerScope(), issueId },
        nativeTitle: "Bound genesis",
        nativeStatus: "Todo",
        providerUpdatedAt: new Date().toISOString(),
        mstar: {
          issueRef,
          head: ["7".repeat(64)],
          fields: { ...(completeIssueSubject().fields as Record<string, unknown>) },
          occurrences: [],
          transitions: [],
          relations: [],
          provenance: [],
          projectMoves: [],
        },
      },
    ],
  };
}

/** note: Point one plan row's project bucket at a selected project, as a prepared plan carries it. */
function setPlanProjectBucket(context: StoreContext, planId: string, projectId: string): void {
  const db = new DatabaseSync(storeDbPath(context));
  try {
    const row = db.prepare("select state_json from execution_plans where plan_id = ?").get(planId) as {
      state_json: string;
    };
    const state = JSON.parse(row.state_json) as { metadata?: Record<string, unknown> };
    state.metadata = { ...(state.metadata ?? {}), project_id: projectId };
    db.prepare("update execution_plans set state_json = ? where plan_id = ?").run(JSON.stringify(state), planId);
  } finally {
    db.close();
  }
}

/** note: A residual entry the remote fixture accepts. */
function residualEntry(occurrenceKey: string): ResidualInput {
  return {
    title: `A residual ${occurrenceKey}`,
    kind: "bug",
    severity: "high",
    impact: "the residual path was refused",
    acceptance: "the remote composite freezes one intent",
    sourceIdentity: `review/${occurrenceKey}.md`,
    rootCauseKey: "remote-composite",
    acceptanceKey: "frozen-intent",
    occurrenceKey,
    sourceKind: "qc",
    location: "packages/engine/src/execution-coordination.ts:1",
    observedBehavior: "the verb refused before reserving",
    evidence: ["stack: StoreError"],
    discoveredAt: "2026-11-20T00:00:00.000Z",
  };
}

/** note: The reservation key the execution store recorded for one composite operation. */
function compositeKeyOf(context: StoreContext, operationId: string): {
  executionStoreId: string;
  executionEpoch: number;
  operationId: string;
} {
  const handle = new DatabaseSync(storeDbPath(context));
  try {
    const row = handle
      .prepare(
        "select execution_store_id, execution_epoch from execution_collaboration_intents where operation_id = ?",
      )
      .get(operationId) as { execution_store_id?: unknown; execution_epoch?: unknown } | undefined;
    if (typeof row?.execution_store_id !== "string" || typeof row?.execution_epoch !== "number") {
      throw new Error(`composite ${operationId} holds no reservation`);
    }
    return { executionStoreId: row.execution_store_id, executionEpoch: row.execution_epoch, operationId };
  } finally {
    handle.close();
  }
}

/** note: The frozen event of one recorded outbox operation. */
function recordedEvent(dbPath: string, operationId: string): RemoteEvent {
  return frozenOperation(dbPath, operationId).event as RemoteEvent;
}

/** note: The frozen project document of one recorded project event. */
function recordedProject(dbPath: string, operationId: string): Record<string, unknown> {
  const change = recordedEvent(dbPath, operationId).change;
  if (change.kind !== "project-replace") throw new Error(`operation ${operationId} is not a project event`);
  return change.project;
}

/** note: Confirm one dispatched intent against the exact frozen effect it carries. */
async function confirmIntent(
  cache: { context: StoreContext; commit: string; dbPath: string },
  operationId: string,
  identityIssueId: string,
): Promise<void> {
  const permit = await dispatchRemoteIntent(cache.context, operationId);
  const attemptId = attemptOf(permit);
  const requestHash = outboxRows(cache.dbPath).find((row) => row.operation_id === operationId)!.request_hash;
  const event = recordedEvent(cache.dbPath, operationId);
  await recordRemoteReceipt(
    cache.context,
    receiptInput(cache.commit, operationId, attemptId, requestHash, {
      kind: "confirmed",
      identity: { ...providerScope(), issueId: identityIssueId },
      // note: A create's genesis event lives in the created issue, so its immutable record IS that
      // issue; every other change appends its own comment record.
      recordId: event.change.kind === "issue-create" ? identityIssueId : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef",
      event,
    }),
  );
}

describe("remote composite flows", () => {
  test("a remote residual-add freezes one genesis event per entry and finalizes after confirmation", async () => {
    const cache = await outboxCache("composite-residual-add");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-remote-add",
      operation: { kind: "residual-add" as const, entries: [residualEntry("remote-1")] },
      expected: workflow.planToken,
      session: workflow.session,
    };

    // invariant: A remote residual-add is admitted through the shared reservation frame.
    const queued = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(queued.code).toBe("collaboration.operation-partial");
    expect(detailsOf(queued)).toMatchObject({ phase: "prepared", operation_id: "residual-remote-add" });
    const outboxId = remoteCompositeEntryOperationId(compositeKeyOf(cache.context, "residual-remote-add"), 0);
    expect(outboxStateOf(cache.dbPath, outboxId)).toBe("enqueued");
    const event = recordedEvent(cache.dbPath, outboxId);
    expect(event.parents).toEqual([]);
    expect(event.change.kind).toBe("issue-create");
    const genesis = event.change as unknown as { mstar: { provenance: unknown } };
    expect(genesis.mstar.provenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "plan", target: workflow.planId, origin: "scoped" })]),
    );
    expect(await intentPhases(cache.context, "residual-remote-add")).toEqual(["prepared"]);

    // invariant: An identical replay before confirmation re-serves the reservation, never a second intent.
    const replay = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(replay.code).toBe("collaboration.operation-partial");
    expect(outboxRows(cache.dbPath)).toHaveLength(1);

    // invariant: The confirmed effect then commits ONLY the execution delta.
    await confirmIntent(cache, outboxId, "77777777-7777-4777-8777-777777777777");
    const completed = await residualAddExecutionPlan(execution, request);
    expect(completed.operationId).toBe("residual-remote-add");
    expect(await intentPhases(cache.context, "residual-remote-add")).toEqual(["confirmed"]);
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
    // invariant: A further replay serves the recorded execution result.
    const served = await residualAddExecutionPlan(execution, request);
    expect(served.replayed).toBe(true);
  });

  test("a remote residual-close checks the plan link and the admitted revision before freezing", async () => {
    const cache = await outboxCache("composite-residual-close");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-remote-close",
      operation: {
        kind: "residual-close" as const,
        issueId: MSTAR_ISSUE,
        disposition: "resolved" as const,
        // note: The linked snapshot carries TWO plan links (the fixture's own plus this
        // plan), so the closure declares the whole acceptance verified.
        evidence: { reason: "fixed", scope: "all", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        expectedIssueRevision: 1,
      },
      expected: workflow.planToken,
      session: workflow.session,
    };

    // invariant: Only a finding linked to THIS plan is closable remotely. The deterministic
    // refusal freezes no provider intent and DECLINES the reservation (I-001221), so the
    // same id never resumes it: a linked close runs under a new operation id below.
    const unlinked = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(unlinked.code).toBe("issue.scope-refused");
    expect(unlinked.message).toContain("not linked to plan");
    expect(outboxRows(cache.dbPath)).toEqual([]);
    expect(await intentPhases(cache.context, "residual-remote-close")).toEqual(["declined"]);

    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: linkedSnapshot(workflow.planId),
      }),
    );
    const linkedRequest = {
      ...request,
      operationId: "residual-remote-close-linked",
    };
    const queued = await refusalOf(() => residualCloseExecutionPlan(execution, linkedRequest));
    expect(queued.code).toBe("collaboration.operation-partial");
    const outboxId = remoteCompositeOperationId(compositeKeyOf(cache.context, "residual-remote-close-linked"));
    expect(outboxStateOf(cache.dbPath, outboxId)).toBe("enqueued");
    expect(recordedEvent(cache.dbPath, outboxId).parents).toEqual([OBSERVED_ISSUE_HEAD]);
    await confirmIntent(cache, outboxId, MSTAR_ISSUE);
    const completed = await residualCloseExecutionPlan(execution, linkedRequest);
    expect(completed.operationId).toBe("residual-remote-close-linked");
    expect(await intentPhases(cache.context, "residual-remote-close-linked")).toEqual(["confirmed"]);

  });

  test("a remote residual-close refuses a stale admitted issue revision", async () => {
    const cache = await outboxCache("composite-residual-close-stale");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: linkedSnapshot(workflow.planId),
      }),
    );
    // invariant: The admitted revision is re-checked against the OBSERVED subject before freezing,
    // and the deterministic refusal declines its reservation instead of blocking a corrected retry.
    const stale = await refusalOf(() =>
      residualCloseExecutionPlan(
        { harnessDir: cache.context.harnessDir, caller: workflow.caller },
        {
          planId: workflow.planId,
          operationId: "residual-remote-close-stale",
          operation: {
            kind: "residual-close",
            issueId: MSTAR_ISSUE,
            disposition: "resolved",
            evidence: { reason: "fixed", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
            expectedIssueRevision: 9,
          },
          expected: workflow.planToken,
          session: workflow.session,
        },
      ),
    );
    expect(stale.code).toBe("issue.revision-conflict");
    expect(stale.message).toContain("revision");
    expect(outboxRows(cache.dbPath)).toEqual([]);
    expect(await intentPhases(cache.context, "residual-remote-close-stale")).toEqual(["declined"]);
  });

  test("a withdrawn repair keeps the reservation for its fork's successor instead of declining", async () => {
    const cache = await outboxCache("composite-conflict-abandoned");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: linkedSnapshot(workflow.planId),
      }),
    );
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-remote-close-abandoned",
      operation: {
        kind: "residual-close" as const,
        issueId: MSTAR_ISSUE,
        disposition: "resolved" as const,
        evidence: { reason: "fixed", scope: "all", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        expectedIssueRevision: 1,
      },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const queued = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(queued.code).toBe("collaboration.operation-partial");
    const outboxId = remoteCompositeOperationId(compositeKeyOf(cache.context, "residual-remote-close-abandoned"));
    const intent = await readRemoteIntent(cache.context, outboxId);
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, outboxId));
    const frozen = recordedEvent(cache.dbPath, outboxId);
    const competing = ["00000000-0000-4000-8000-000000000a01", "00000000-0000-4000-8000-000000000a02"].map(
      (operationId, index) => ({
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: index === 0 ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea1" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea2",
        event: { ...frozen, operationId, parents: ["8".repeat(64)] },
      }),
    );
    const heads = competing.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, outboxId, attemptId, intent.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_ISSUE_HEAD],
        observedHeads: heads,
        observedRecords: competing,
      }),
    );
    // note: The reviewed repair of that fork is withdrawn before it ever confirms.
    const resolutionId = "00000000-0000-4000-8000-000000000a03";
    await prepareRemoteResolution(cache.context, outboxId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "merge the fork",
      event: { ...frozen, operationId: resolutionId, parents: heads },
    });
    await abandonRemoteIntent(cache.context, { operationId: resolutionId, reason: "reviewed repair withdrawn" });
    expect(outboxStateOf(cache.dbPath, outboxId)).toBe("conflict");

    // invariant: A withdrawn REPAIR leaves outstanding work behind, not a settled chain: the fork it
    // withdrew from is still repairable, so the reservation stays prepared and the recovery names the
    // replacement of THAT fork. Declining here would strand a closure that can still land.
    const pending = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(pending.code).toBe("collaboration.operation-partial");
    const recovery = String(detailsOf(pending).recovery);
    expect(recovery).toContain(`outbox-resolve --harness <abs> --operation ${outboxId}`);
    expect(recovery).toContain("was abandoned (reviewed repair withdrawn)");
    expect(pending.message).not.toContain("declined");
    expect(await intentPhases(cache.context, "residual-remote-close-abandoned")).toEqual(["prepared"]);

    // invariant: The named route works end to end: a NEW reviewed replacement of the same fork
    // confirms, and the ORIGINAL operation id finalizes from that successor.
    const successorId = "00000000-0000-4000-8000-000000000a04";
    const successor = await prepareRemoteResolution(cache.context, outboxId, {
      operationId: successorId,
      operator: "operator-two",
      reason: "merge the fork after the withdrawal",
      event: { ...frozen, operationId: successorId, parents: heads },
    });
    expect(successor).toMatchObject({ operationId: successorId, state: "enqueued" });
    const successorAttempt = attemptOf(
      await dispatchRemoteIntent(cache.context, successorId, forkObservationFor(cache, outboxId, heads)),
    );
    const successorHash = outboxRows(cache.dbPath).find((row) => row.operation_id === successorId)!.request_hash;
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, successorId, successorAttempt, successorHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef",
        event: recordedEvent(cache.dbPath, successorId),
      }),
    );
    const completed = await residualCloseExecutionPlan(execution, request);
    expect(completed.operationId).toBe("residual-remote-close-abandoned");
    expect(await intentPhases(cache.context, "residual-remote-close-abandoned")).toEqual(["confirmed"]);
  }, 30_000);

  test("a settled repair that leaves the issue open never acknowledges the plan closure", async () => {
    const cache = await outboxCache("composite-repair-open");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: linkedSnapshot(workflow.planId),
      }),
    );
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-remote-close-reopened",
      operation: {
        kind: "residual-close" as const,
        issueId: MSTAR_ISSUE,
        disposition: "resolved" as const,
        evidence: { reason: "fixed", scope: "all", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        expectedIssueRevision: 1,
      },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const queued = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(queued.code).toBe("collaboration.operation-partial");
    const outboxId = remoteCompositeOperationId(compositeKeyOf(cache.context, "residual-remote-close-reopened"));
    const intent = await readRemoteIntent(cache.context, outboxId);
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, outboxId));
    const frozen = recordedEvent(cache.dbPath, outboxId);
    if (frozen.change.kind !== "issue-replace") throw new Error("fixture: the closure froze no issue replacement");
    const competing = ["00000000-0000-4000-8000-000000000c01", "00000000-0000-4000-8000-000000000c02"].map(
      (operationId, index) => ({
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: index === 0 ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea1" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea2",
        event: { ...frozen, operationId, parents: ["8".repeat(64)] },
      }),
    );
    const heads = competing.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, outboxId, attemptId, intent.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_ISSUE_HEAD],
        observedHeads: heads,
        observedRecords: competing,
      }),
    );
    // invariant: The reviewed replacement KEEPS the original transition and every history row, but
    // its merged subject carries the reopening branch's CURRENT disposition.
    const resolutionId = "00000000-0000-4000-8000-000000000c03";
    const fields = frozen.change.mstar.fields as Record<string, unknown>;
    await prepareRemoteResolution(cache.context, outboxId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "the reopening branch won the merge",
      event: {
        ...frozen,
        operationId: resolutionId,
        parents: heads,
        change: { ...frozen.change, mstar: { ...frozen.change.mstar, fields: { ...fields, disposition: "open" } } },
      },
    });
    const repairAttempt = attemptOf(
      await dispatchRemoteIntent(cache.context, resolutionId, forkObservationFor(cache, outboxId, heads)),
    );
    const repairHash = outboxRows(cache.dbPath).find((row) => row.operation_id === resolutionId)!.request_hash;
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, resolutionId, repairAttempt, repairHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef",
        event: recordedEvent(cache.dbPath, resolutionId),
      }),
    );

    // invariant: The settlement recorded OPEN, so the closure's business outcome never landed: the
    // plan effect is not acknowledged, the settled replacement is named as durable, and the
    // correction route re-freezes against the merged head. (A repair that keeps the requested
    // disposition still finalizes - see the live-repair case above.)
    const declined = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(declined.code).toBe("remote.effect-mismatch");
    expect(declined.message).toContain(resolutionId);
    expect(detailsOf(declined)).toMatchObject({
      phase: "declined",
      operation_id: "residual-remote-close-reopened",
      settled_operations: [resolutionId],
      confirmed_components: [`provider:${resolutionId}`],
      requested_disposition: "resolved",
      confirmed_disposition: "open",
    });
    // invariant: The open settlement leaves the issue closable, so the recovery is RUNNABLE: the
    // operator reads the current revision and retries with it under a new operation id.
    const openRecovery = String(detailsOf(declined).recovery);
    expect(openRecovery).toContain(`outbox-show --harness <abs> --operation ${resolutionId}`);
    expect(openRecovery).toContain(`mstar issue show --id ${FORGED_ISSUE_REF}`);
    expect(openRecovery).toContain("CURRENT revision");
    expect(openRecovery).toContain("NEW operation id");
    expect(openRecovery).not.toContain("mstar issue reopen");
    expect(await intentPhases(cache.context, "residual-remote-close-reopened")).toEqual(["declined"]);
  }, 30_000);

  test("a settled repair that confirms another terminal decision points at the deliberate reopen route", async () => {
    const cache = await outboxCache("composite-repair-terminal");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: linkedSnapshot(workflow.planId),
      }),
    );
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-remote-close-terminal",
      operation: {
        kind: "residual-close" as const,
        issueId: MSTAR_ISSUE,
        disposition: "resolved" as const,
        evidence: { reason: "fixed", scope: "all", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        expectedIssueRevision: 1,
      },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const queued = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(queued.code).toBe("collaboration.operation-partial");
    const outboxId = remoteCompositeOperationId(compositeKeyOf(cache.context, "residual-remote-close-terminal"));
    const intent = await readRemoteIntent(cache.context, outboxId);
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, outboxId));
    const frozen = recordedEvent(cache.dbPath, outboxId);
    if (frozen.change.kind !== "issue-replace") throw new Error("fixture: the closure froze no issue replacement");
    const competing = ["00000000-0000-4000-8000-000000000d01", "00000000-0000-4000-8000-000000000d02"].map(
      (operationId, index) => ({
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: index === 0 ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        event: { ...frozen, operationId, parents: ["9".repeat(64)] },
      }),
    );
    const heads = competing.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, outboxId, attemptId, intent.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_ISSUE_HEAD],
        observedHeads: heads,
        observedRecords: competing,
      }),
    );
    // note: The reviewed replacement keeps both branches' history, and its merged subject closes the
    // issue as DUPLICATE instead of the RESOLVED the closure asked for.
    const resolutionId = "00000000-0000-4000-8000-000000000d03";
    const fields = frozen.change.mstar.fields as Record<string, unknown>;
    await prepareRemoteResolution(cache.context, outboxId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "the duplicate branch won the merge",
      event: {
        ...frozen,
        operationId: resolutionId,
        parents: heads,
        change: { ...frozen.change, mstar: { ...frozen.change.mstar, fields: { ...fields, disposition: "duplicate" } } },
      },
    });
    const repairAttempt = attemptOf(
      await dispatchRemoteIntent(cache.context, resolutionId, forkObservationFor(cache, outboxId, heads)),
    );
    const repairHash = outboxRows(cache.dbPath).find((row) => row.operation_id === resolutionId)!.request_hash;
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, resolutionId, repairAttempt, repairHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
        event: recordedEvent(cache.dbPath, resolutionId),
      }),
    );

    // invariant: The settlement recorded ANOTHER TERMINAL decision. Retrying the closure over it can
    // never succeed (a closure is admitted only from an open issue), so the recovery states that the
    // confirmed decision stands and names the only route that makes a further closure admissible: the
    // deliberate reopen, then a re-observation and a retry with the reopened revision.
    const declined = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(declined.code).toBe("remote.effect-mismatch");
    expect(declined.message).toContain(resolutionId);
    expect(detailsOf(declined)).toMatchObject({
      phase: "declined",
      operation_id: "residual-remote-close-terminal",
      settled_operations: [resolutionId],
      confirmed_components: [`provider:${resolutionId}`],
      requested_disposition: "resolved",
      confirmed_disposition: "duplicate",
    });
    const terminalRecovery = String(detailsOf(declined).recovery);
    expect(terminalRecovery).toContain(`outbox-show --harness <abs> --operation ${resolutionId}`);
    expect(terminalRecovery).toContain(`mstar issue show --id ${FORGED_ISSUE_REF}`);
    expect(terminalRecovery).toContain("stands");
    expect(terminalRecovery).toContain("mstar issue reopen --help");
    expect(terminalRecovery).toContain("mstar schema IssueReopen");
    expect(terminalRecovery).toContain("re-observe the project");
    expect(terminalRecovery).toContain("NEW operation id");
    // invariant: The unreachable advice is gone: a terminal settlement never points at retrying the
    // closure over the merged decision.
    expect(terminalRecovery).not.toContain("CURRENT revision");
    expect(terminalRecovery).not.toContain("publishes the reviewed disposition");
    expect(await intentPhases(cache.context, "residual-remote-close-terminal")).toEqual(["declined"]);
  }, 30_000);

  test("a mixed settlement declines with its confirmed components named and recovers only the missing work", async () => {
    const cache = await outboxCache("composite-mixed-settlement");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-remote-mixed",
      operation: { kind: "residual-add" as const, entries: [residualEntry("mixed-a"), residualEntry("mixed-b")] },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const queued = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(queued.code).toBe("collaboration.operation-partial");
    const key = compositeKeyOf(cache.context, "residual-remote-mixed");
    const idA = remoteCompositeEntryOperationId(key, 0);
    const idB = remoteCompositeEntryOperationId(key, 1);
    // note: The provider confirmed the FIRST entry and the operator withdrew the second, so the
    // batch's settled state is mixed before the composite is reissued under its own id.
    await confirmIntent(cache, idA, "77777777-7777-4777-8777-777777777781");
    await abandonRemoteIntent(cache.context, { operationId: idB, reason: "entry withdrawn by review" });

    // invariant: The settled mixed state is never declined as effect-free: the confirmed
    // component is named in the terminal receipt, and only the incomplete work is recovered.
    const declined = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(declined.code).toBe("remote.effect-abandoned");
    expect(declined.message).toContain(`provider:${idA}`);
    expect(declined.message).toContain("ONLY the incomplete work");
    expect(declined.message).not.toContain("Nothing was applied");
    expect(detailsOf(declined)).toMatchObject({
      phase: "declined",
      operation_id: "residual-remote-mixed",
      confirmed_components: [`provider:${idA}`],
      abandoned_components: [idB],
    });
    // invariant: The durability fact names WHICH work is durable and which acknowledgement never
    // applied; the confirmed provider component is never described as an effect that never landed,
    // and the corrected request contains only the entries that did not settle.
    const mixedRecovery = String(detailsOf(declined).recovery);
    expect(mixedRecovery).not.toContain("effect was never applied");
    expect(mixedRecovery).toContain("the confirmed components named here are durable and are never re-sent");
    expect(mixedRecovery).toContain("its execution acknowledgement was not applied");
    expect(mixedRecovery).toContain("ONLY the entries that did not settle");
    expect(await intentPhases(cache.context, "residual-remote-mixed")).toEqual(["declined"]);

    // invariant: The recovery route works: the confirmed receipt invalidated the cached base (and
    // bumped its revision), so the operator re-observes first, exactly as the retained refusals
    // name; a NEW operation id whose entries name ONLY the missing residual is then admitted and
    // freezes exactly one new intent (the confirmed one is never re-sent).
    await reobserve(cache, 2);
    const recovered = await refusalOf(() =>
      residualAddExecutionPlan(execution, {
        ...request,
        operationId: "residual-remote-mixed-2",
        operation: { kind: "residual-add" as const, entries: [residualEntry("mixed-b")] },
      }),
    );
    expect(recovered.code).toBe("collaboration.operation-partial");
    const enqueued = outboxRows(cache.dbPath).filter((row) => row.state === "enqueued");
    expect(enqueued).toHaveLength(1);
    expect(outboxStateOf(cache.dbPath, idA)).toBe("confirmed");
  }, 30_000);

  test("a live reviewed repair is the recovery instead of a second resolve of its fork", async () => {
    const cache = await outboxCache("composite-conflict-live-repair");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: linkedSnapshot(workflow.planId),
      }),
    );
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-remote-close-live",
      operation: {
        kind: "residual-close" as const,
        issueId: MSTAR_ISSUE,
        disposition: "resolved" as const,
        evidence: { reason: "fixed", scope: "all", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        expectedIssueRevision: 1,
      },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const queued = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(queued.code).toBe("collaboration.operation-partial");
    const outboxId = remoteCompositeOperationId(compositeKeyOf(cache.context, "residual-remote-close-live"));
    const intent = await readRemoteIntent(cache.context, outboxId);
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, outboxId));
    const frozen = recordedEvent(cache.dbPath, outboxId);
    const competing = ["00000000-0000-4000-8000-000000000b01", "00000000-0000-4000-8000-000000000b02"].map(
      (operationId, index) => ({
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: index === 0 ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea1" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea2",
        event: { ...frozen, operationId, parents: ["8".repeat(64)] },
      }),
    );
    const heads = competing.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, outboxId, attemptId, intent.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_ISSUE_HEAD],
        observedHeads: heads,
        observedRecords: competing,
      }),
    );
    // note: The reviewed repair of that fork is ENQUEUED but not yet sent.
    const resolutionId = "00000000-0000-4000-8000-000000000b03";
    await prepareRemoteResolution(cache.context, outboxId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "merge the fork",
      event: { ...frozen, operationId: resolutionId, parents: heads },
    });

    // invariant: The composite acts on the LIVE leaf: it names the repair to dispatch with its fork
    // observation, never a second `outbox-resolve` of the fork the live repair already took over.
    const pending = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(pending.code).toBe("collaboration.operation-partial");
    const recovery = String(detailsOf(pending).recovery);
    expect(recovery).toContain(`outbox-dispatch --harness <abs> --operation ${resolutionId} --input <file|->`);
    expect(recovery).not.toContain(`outbox-resolve --harness <abs> --operation ${outboxId}`);
    expect(await intentPhases(cache.context, "residual-remote-close-live")).toEqual(["prepared"]);

    // invariant: Dispatching the linked repair with its fork observation and recording its
    // confirmation lets the SAME operation id finalize from that repair.
    const repairAttempt = attemptOf(
      await dispatchRemoteIntent(cache.context, resolutionId, forkObservationFor(cache, outboxId, heads)),
    );
    const repairHash = outboxRows(cache.dbPath).find((row) => row.operation_id === resolutionId)!.request_hash;
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, resolutionId, repairAttempt, repairHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef",
        event: recordedEvent(cache.dbPath, resolutionId),
      }),
    );
    const completed = await residualCloseExecutionPlan(execution, request);
    expect(completed.operationId).toBe("residual-remote-close-live");
    expect(await intentPhases(cache.context, "residual-remote-close-live")).toEqual(["confirmed"]);
  }, 30_000);

  test("a mixed batch keeps its reservation when a later confirmed entry has no readable receipt", async () => {
    const cache = await outboxCache("composite-mixed-unreadable");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-remote-mixed-unreadable",
      operation: { kind: "residual-add" as const, entries: [residualEntry("unreadable-a"), residualEntry("unreadable-b")] },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const queued = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(queued.code).toBe("collaboration.operation-partial");
    const key = compositeKeyOf(cache.context, "residual-remote-mixed-unreadable");
    const idA = remoteCompositeEntryOperationId(key, 0);
    const idB = remoteCompositeEntryOperationId(key, 1);
    // note: The FIRST entry is withdrawn and the LATER one confirmed — whose receipt is then lost,
    // so its state alone is not a readable receipt.
    await abandonRemoteIntent(cache.context, { operationId: idA, reason: "entry withdrawn by review" });
    await confirmIntent(cache, idB, "77777777-7777-4777-8777-777777777782");
    const db = new DatabaseSync(cache.dbPath);
    try {
      db.prepare("delete from remote_outbox_receipts where operation_id = ? and outcome = 'confirmed'").run(idB);
    } finally {
      db.close();
    }

    // invariant: EVERY entry is scanned: the earlier abandonment never authorizes an effect-free
    // decline while a later confirmed component's receipt is unreadable.
    const kept = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(kept.code).toBe("collaboration.operation-partial");
    expect(detailsOf(kept)).toMatchObject({ cause_code: "collaboration.unreadable" });
    const recovery = String(detailsOf(kept).recovery);
    expect(recovery).toContain("mstar store collaboration remote observe --harness <abs> --input <file|->");
    expect(recovery).not.toContain("--project");
    expect(await intentPhases(cache.context, "residual-remote-mixed-unreadable")).toEqual(["prepared"]);
  }, 30_000);

  test("an unresolved conflict at a repair leaf names that leaf's own fork", async () => {
    const cache = await outboxCache("composite-conflict-leaf");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: linkedSnapshot(workflow.planId),
      }),
    );
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-remote-close-leaf",
      operation: {
        kind: "residual-close" as const,
        issueId: MSTAR_ISSUE,
        disposition: "resolved" as const,
        evidence: { reason: "fixed", scope: "all", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        expectedIssueRevision: 1,
      },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const queued = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(queued.code).toBe("collaboration.operation-partial");
    const outboxId = remoteCompositeOperationId(compositeKeyOf(cache.context, "residual-remote-close-leaf"));
    const intent = await readRemoteIntent(cache.context, outboxId);
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, outboxId));
    const frozen = recordedEvent(cache.dbPath, outboxId);
    const competing = ["00000000-0000-4000-8000-000000000d01", "00000000-0000-4000-8000-000000000d02"].map(
      (operationId, index) => ({
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: index === 0 ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea1" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea2",
        event: { ...frozen, operationId, parents: ["8".repeat(64)] },
      }),
    );
    const heads = competing.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, outboxId, attemptId, intent.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_ISSUE_HEAD],
        observedHeads: heads,
        observedRecords: competing,
      }),
    );
    // note: The reviewed repair of that fork is sent, and the provider answers with a SECOND fork,
    // so the chain's LAST leaf is itself an unresolved conflict.
    const repairId = "00000000-0000-4000-8000-000000000d03";
    const repair = await prepareRemoteResolution(cache.context, outboxId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: { ...frozen, operationId: repairId, parents: heads },
    });
    const repairAttempt = attemptOf(
      await dispatchRemoteIntent(cache.context, repairId, forkObservationFor(cache, outboxId, heads)),
    );
    const second = ["00000000-0000-4000-8000-000000000d04", "00000000-0000-4000-8000-000000000d05"].map(
      (operationId, index) => ({
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: index === 0 ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea3" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea4",
        event: { ...frozen, operationId, parents: ["9".repeat(64)] },
      }),
    );
    const secondHeads = second.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, repairId, repairAttempt, repair.requestHash, {
        kind: "conflict",
        expectedHeads: heads,
        observedHeads: secondHeads,
        observedRecords: second,
      }),
    );

    // invariant: The LAST leaf is the fork a reviewed successor must address: the original already
    // links to the repair, so a second `outbox-resolve` of the original is refused.
    const pending = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(pending.code).toBe("collaboration.operation-partial");
    const recovery = String(detailsOf(pending).recovery);
    expect(recovery).toContain(`outbox-resolve --harness <abs> --operation ${repairId}`);
    expect(recovery).not.toContain(`outbox-resolve --harness <abs> --operation ${outboxId}`);
    expect(await intentPhases(cache.context, "residual-remote-close-leaf")).toEqual(["prepared"]);

    // invariant: The named route is the working one: a successor of the LEAF fork, dispatched with
    // that leaf's observation and confirmed, settles the whole chain for this reservation.
    const successorId = "00000000-0000-4000-8000-000000000d06";
    const successor = await prepareRemoteResolution(cache.context, repairId, {
      operationId: successorId,
      operator: "operator-two",
      reason: "merge the second fork",
      event: { ...frozen, operationId: successorId, parents: secondHeads },
    });
    const successorAttempt = attemptOf(
      await dispatchRemoteIntent(cache.context, successorId, forkObservationFor(cache, repairId, secondHeads)),
    );
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, successorId, successorAttempt, successor.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea5",
        event: recordedEvent(cache.dbPath, successorId),
      }),
    );
    const completed = await residualCloseExecutionPlan(execution, request);
    expect(completed.operationId).toBe("residual-remote-close-leaf");
    expect(await intentPhases(cache.context, "residual-remote-close-leaf")).toEqual(["confirmed"]);
  }, 30_000);

  test("a partially prepared batch counts only readable confirmations and never claims an unapplied effect", async () => {
    const cache = await outboxCache("composite-preparation-partial");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const operationId = "residual-remote-preparation-partial";
    const request = {
      planId: workflow.planId,
      operationId,
      operation: { kind: "residual-add" as const, entries: [residualEntry("partial-a"), residualEntry("partial-b")] },
      expected: workflow.planToken,
      session: workflow.session,
    };
    // note: Entry A freezes; in the scope gap before entry B's freeze a competing durable intent
    // appears at entry B's own operation id, so the batch stops BEHIND a frozen component.
    let scopes = 0;
    setRemoteWriteScopeGapForTest(async () => {
      scopes += 1;
      if (scopes < 2) return;
      setRemoteWriteScopeGapForTest(undefined);
      const entryB = remoteCompositeEntryOperationId(compositeKeyOf(cache.context, operationId), 1);
      await prepareRemoteIntent(cache.context, {
        binding: intentBindingFor(cache.commit),
        event: {
          version: 1,
          repoKey: cache.fixture.repoKey,
          projectId: SELECTED_PROJECT.localProjectId,
          operationId: entryB,
          parents: [],
          change: { kind: "issue-create", issueRef: issueRefForOperation(entryB), mstar: completeIssueSubject() },
        },
        target: null,
        expectedHeads: [],
        executionKey: { ...compositeKeyOf(cache.context, operationId), operationId: entryB },
        origin: {
          verb: "residual-add",
          request: {
            planId: workflow.planId,
            // note: A DIFFERENT business request than this batch's entry B, so both attempts meet
            // the same durable collision instead of replaying the seeded row.
            input: deriveResidualEntries([residualEntry("partial-b-other")], SELECTED_PROJECT.localProjectId)[0],
          },
        },
      });
    });
    const partial = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(partial.code).toBe("collaboration.operation-partial");
    const entryA = remoteCompositeEntryOperationId(compositeKeyOf(cache.context, operationId), 0);
    // invariant: Entry A is durable provider work, but an unconfirmed one claims no confirmation.
    expect(detailsOf(partial)).toMatchObject({
      phase: "prepared",
      confirmed_components: [],
      frozen_components: [entryA],
    });
    const unconfirmedRecovery = String(detailsOf(partial).recovery);
    expect(unconfirmedRecovery).toContain("durable provider work");
    expect(unconfirmedRecovery).toContain("execution acknowledgement was not applied");
    expect(unconfirmedRecovery).toContain("readable confirmation");
    expect(unconfirmedRecovery).not.toContain("Nothing was applied");
    expect(await intentPhases(cache.context, operationId)).toEqual(["prepared"]);

    // invariant: A confirmed component WITH its readable receipt is named durable work that is
    // never re-sent, never an operation whose effect was not applied.
    await confirmIntent(cache, entryA, "77777777-7777-4777-8777-777777777784");
    const confirmedPartial = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(confirmedPartial.code).toBe("collaboration.operation-partial");
    expect(detailsOf(confirmedPartial)).toMatchObject({
      confirmed_components: [`provider:${entryA}`],
      frozen_components: [entryA],
    });
    const confirmedRecovery = String(detailsOf(confirmedPartial).recovery);
    expect(confirmedRecovery).toContain("never re-sent");
    expect(confirmedRecovery).toContain("execution acknowledgement was not applied");
    expect(confirmedRecovery).not.toContain("Nothing was applied");

    // invariant: A `confirmed` state whose receipt cannot be read proves nothing, so the same
    // refusal stops naming it as a confirmed component.
    const db = new DatabaseSync(cache.dbPath);
    try {
      db.prepare("delete from remote_outbox_receipts where operation_id = ? and outcome = 'confirmed'").run(entryA);
    } finally {
      db.close();
    }
    const unreadable = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(unreadable.code).toBe("collaboration.operation-partial");
    expect(detailsOf(unreadable)).toMatchObject({ confirmed_components: [] });
    expect(String(detailsOf(unreadable).recovery)).toContain("readable confirmation");
  }, 30_000);

  test("a first-entry deterministic refusal declines its reservation so a corrected same-plan retry proceeds", async () => {
    const cache = await outboxCache("composite-entry-zero-decline");
    const workflow = await remoteExecutionWorkflow(cache);
    // why: The plan bucket names a project the checked selector does not select, so entry zero
    // refuses deterministically BEFORE any provider intent is frozen.
    setPlanProjectBucket(cache.context, workflow.planId, "project-not-selected");
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-entry-zero",
      operation: { kind: "residual-add" as const, entries: [residualEntry("zero-a"), residualEntry("zero-b")] },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const refused = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(refused.code).toBe("remote.scope-mismatch");
    expect(outboxRows(cache.dbPath)).toEqual([]);
    expect(await intentPhases(cache.context, "residual-entry-zero")).toEqual(["declined"]);

    // invariant: The corrected request under a new id on the SAME plan proceeds and freezes.
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    const corrected = await refusalOf(() =>
      residualAddExecutionPlan(execution, { ...request, operationId: "residual-entry-zero-corrected" }),
    );
    expect(corrected.code).toBe("collaboration.operation-partial");
    expect(outboxRows(cache.dbPath)).toHaveLength(2);
  });

  test("a same-ID overlap keeps the reservation when the losing attempt meets the winner's frozen intent", async () => {
    const cache = await outboxCache("composite-same-id-overlap");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: linkedSnapshot(workflow.planId),
      }),
    );
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-remote-overlap",
      operation: { kind: "residual-add" as const, entries: [residualEntry("overlap-a")] },
      expected: workflow.planToken,
      session: workflow.session,
    };
    // note: The bounded overlap of two identical same-ID calls: the loser passes replay admission
    // (no outbox row yet), and the WINNER freezes the entry's intent inside the loser's sampled
    // gap. The loser's independently built event carries a different request hash, so its freeze
    // meets `remote.operation-conflict` at entry zero — the one refusal that must NEVER release
    // the shared reservation, because the winner's outbox row is already durable.
    let overlapped = false;
    setRemoteWriteScopeGapForTest(async () => {
      if (overlapped) return;
      overlapped = true;
      setRemoteWriteScopeGapForTest(undefined);
      const entryId = remoteCompositeEntryOperationId(compositeKeyOf(cache.context, "residual-remote-overlap"), 0);
      // note: The winner's event is the SAME create arm, derived reference, execution reservation
      // and business origin with DIFFERENT subject content — exactly what two independent builds
      // of one request produce (fresh event material, same admitted identity).
      await prepareRemoteIntent(cache.context, {
        binding: intentBindingFor(cache.commit),
        event: {
          version: 1,
          repoKey: cache.fixture.repoKey,
          projectId: SELECTED_PROJECT.localProjectId,
          operationId: entryId,
          parents: [],
          change: { kind: "issue-create", issueRef: issueRefForOperation(entryId), mstar: completeIssueSubject() },
        },
        target: null,
        expectedHeads: [],
        executionKey: { ...compositeKeyOf(cache.context, "residual-remote-overlap"), operationId: entryId },
        origin: {
          verb: "residual-add",
          request: {
            planId: workflow.planId,
            input: deriveResidualEntries([residualEntry("overlap-a")], SELECTED_PROJECT.localProjectId)[0],
          },
        },
      });
    });
    const refused = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(overlapped).toBe(true);
    // invariant: A deterministic refusal is only a decline when it PROVES the failure happened
    // before any freeze. `remote.operation-conflict` proves the opposite — the operation id
    // already holds a durable intent — so the reservation stays prepared and resumable.
    expect(refused.code).toBe("collaboration.operation-partial");
    expect(detailsOf(refused)).toMatchObject({ phase: "prepared", operation_id: "residual-remote-overlap" });
    expect(String(detailsOf(refused).recovery)).toContain("SAME");
    const entryId = remoteCompositeEntryOperationId(compositeKeyOf(cache.context, "residual-remote-overlap"), 0);
    expect(await intentPhases(cache.context, "residual-remote-overlap")).toEqual(["prepared"]);
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
    expect(outboxStateOf(cache.dbPath, entryId)).toBe("enqueued");

    // invariant: The reservation is genuinely resumable: settling the winner's intent and
    // reissuing the SAME operation id finalizes from that intent, never a second freeze.
    await confirmIntent(cache, entryId, "77777777-7777-4777-8777-777777777783");
    const completed = await residualAddExecutionPlan(execution, request);
    expect(completed.operationId).toBe("residual-remote-overlap");
    expect(await intentPhases(cache.context, "residual-remote-overlap")).toEqual(["confirmed"]);
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
  }, 30_000);

  test("a sampled refusal before insertion cannot decline a reservation whose intent the winner froze", async () => {
    const cache = await outboxCache("composite-decline-proof");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "decline-proof",
      operation: { kind: "residual-add" as const, entries: [residualEntry("proof-a")] },
      expected: workflow.planToken,
      session: workflow.session,
    };
    // note: The bounded overlap of the OTHER branch: the loser passes replay admission (no outbox
    // row yet), and the winner freezes, dispatches and CONFIRMS the same id inside the loser's
    // replay-admission gap, then a refresh installs the winner's settled outcome. The loser's
    // create path now refuses deterministically (`remote.scope-mismatch`) from a fresh sample,
    // before its own outbox transaction — an error that carries no durable-intent tag, so only
    // a re-read at the freeze/decline boundary can prove the winner's row.
    let overlapped = false;
    setRemoteReplayAdmissionGapForTest(async () => {
      if (overlapped) return;
      overlapped = true;
      setRemoteReplayAdmissionGapForTest(undefined);
      const entryId = remoteCompositeEntryOperationId(compositeKeyOf(cache.context, "decline-proof"), 0);
      const queued = await refusalOf(() => residualAddExecutionPlan(execution, request));
      expect(queued.code).toBe("collaboration.operation-partial");
      await confirmIntent(cache, entryId, "88888888-8888-4888-8888-888888888881");
      const check = positiveCheck();
      const established = linkedSnapshot(workflow.planId);
      const at = new Date().toISOString();
      const snapshot: RemoteSnapshot = {
        ...established,
        issues: [
          ...established.issues,
          {
            identity: { ...providerScope(), issueId: "88888888-8888-4888-8888-888888888882" },
            nativeTitle: "Winner genesis",
            nativeStatus: "Todo",
            providerUpdatedAt: at,
            mstar: {
              issueRef: issueRefForOperation(entryId),
              head: ["7".repeat(64)],
              fields: { ...(completeIssueSubject().fields as Record<string, unknown>) },
              occurrences: [],
              transitions: [],
              relations: [],
              provenance: [],
              projectMoves: [],
            },
          },
        ],
      };
      await ingestRemoteObservation(
        cache.context,
        observation(check, { selectorCommit: cache.commit, generation: 3, expectRevision: 2, snapshot }),
      );
    });
    const refused = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(overlapped).toBe(true);
    expect(refused.code).toBe("collaboration.operation-partial");
    expect(refused.message).toContain("already holds a durable intent");
    expect(detailsOf(refused)).toMatchObject({ phase: "prepared", operation_id: "decline-proof" });
    expect(String(detailsOf(refused).recovery)).toContain("SAME");
    // invariant: The reservation is never declined on a refusal that cannot prove absence at the
    // freeze/decline boundary: the winner's settled intent keeps its reservation prepared.
    expect(await intentPhases(cache.context, "decline-proof")).toEqual(["prepared"]);
    const entryId = remoteCompositeEntryOperationId(compositeKeyOf(cache.context, "decline-proof"), 0);
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
    expect(outboxStateOf(cache.dbPath, entryId)).toBe("confirmed");

    // invariant: The reservation is genuinely resumable: reissuing the SAME operation id replays
    // the winner's confirmed intent and finalizes the execution delta, never a second freeze.
    const completed = await residualAddExecutionPlan(execution, request);
    expect(completed.operationId).toBe("decline-proof");
    expect(await intentPhases(cache.context, "decline-proof")).toEqual(["confirmed"]);
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
  }, 30_000);

  test("a freeze started inside the empty-check-to-decline gap cannot land under the decline", async () => {
    const cache = await outboxCache("composite-decline-lane-gap");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "decline-lane-gap",
      operation: { kind: "residual-add" as const, entries: [residualEntry("gap-a")] },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const key = {
      executionStoreId: workflow.storeId,
      executionEpoch: workflow.epoch,
      operationId: "decline-lane-gap",
    };
    const entryId = remoteCompositeEntryOperationId(key, 0);
    // note: The derived reference is already bound in the observed project, so this attempt refuses
    // deterministically BEFORE any provider intent is frozen.
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: boundReferenceSnapshot(workflow.planId, issueRefForOperation(entryId), "88888888-8888-4888-8888-888888888883"),
      }),
    );
    // note: The bounded overlap of the empty-check-to-decline gap: a same-id freeze is STARTED
    // between the fenced lane's absence check and the durable decline. It cannot run until the lane
    // is released, and must then prove the decline instead of inserting under it.
    let freeze: Promise<unknown> | undefined;
    setCompositeDeclineGapForTest(async () => {
      if (freeze !== undefined) return;
      setCompositeDeclineGapForTest(undefined);
      freeze = prepareRemoteIntent(cache.context, {
        binding: intentBindingFor(cache.commit),
        event: {
          version: 1,
          repoKey: cache.fixture.repoKey,
          projectId: SELECTED_PROJECT.localProjectId,
          operationId: entryId,
          parents: [],
          change: { kind: "issue-create", issueRef: issueRefForOperation(entryId), mstar: completeIssueSubject() },
        },
        target: null,
        expectedHeads: [],
        executionKey: { ...key, operationId: entryId },
        origin: {
          verb: "residual-add",
          request: {
            planId: workflow.planId,
            input: deriveResidualEntries([residualEntry("gap-a")], SELECTED_PROJECT.localProjectId)[0],
          },
        },
      }, undefined, key).then(
        () => "frozen",
        (error: unknown) => error,
      );
      // note: The attempt is awaited INSIDE the gap: the held lane (and its bounded wait) is what
      // stops it, so an unsynchronized decline lets it land before the reservation is released.
      await freeze;
    });
    const refused = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(freeze).toBeDefined();
    const frozen = await freeze!;
    // invariant: The decline won the lane; the freeze that was started in the gap cannot land under
    // it (it is blocked by the lane, or proves the decline once the lane is released). Either way
    // no durable intent exists under the released reservation.
    expect(frozen).not.toBe("frozen");
    expect(refused.code).toBe("remote.scope-mismatch");
    expect(await intentPhases(cache.context, "decline-lane-gap")).toEqual(["declined"]);
    expect(outboxRows(cache.dbPath)).toEqual([]);
  }, 30_000);

  test("a decline that wins refuses a freeze from an already-admitted same-ID attempt", async () => {
    const cache = await outboxCache("composite-frozen-after-decline");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: linkedSnapshot(workflow.planId),
      }),
    );
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "frozen-after-decline",
      operation: { kind: "residual-add" as const, entries: [residualEntry("after-a")] },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const key = {
      executionStoreId: workflow.storeId,
      executionEpoch: workflow.epoch,
      operationId: "frozen-after-decline",
    };
    const entryId = remoteCompositeEntryOperationId(key, 0);
    // note: The bounded overlap: the second attempt is already admitted when it reaches its
    // freeze, and a same-ID sibling declines the reservation inside that gap. The freeze must see
    // the durable decline in the SAME lane instead of enqueuing an intent it can never finalize.
    let overlapped = false;
    setRemoteReplayAdmissionGapForTest(async () => {
      if (overlapped) return;
      overlapped = true;
      setRemoteReplayAdmissionGapForTest(undefined);
      const at = new Date().toISOString();
      const established = linkedSnapshot(workflow.planId);
      const bound: RemoteSnapshot = {
        ...established,
        issues: [
          ...established.issues,
          {
            identity: { ...providerScope(), issueId: "88888888-8888-4888-8888-888888888885" },
            nativeTitle: "Bound genesis",
            nativeStatus: "Todo",
            providerUpdatedAt: at,
            mstar: {
              issueRef: issueRefForOperation(entryId),
              head: ["7".repeat(64)],
              fields: { ...(completeIssueSubject().fields as Record<string, unknown>) },
              occurrences: [],
              transitions: [],
              relations: [],
              provenance: [],
              projectMoves: [],
            },
          },
        ],
      };
      await ingestRemoteObservation(
        cache.context,
        observation(positiveCheck(), { selectorCommit: cache.commit, generation: 3, expectRevision: 2, snapshot: bound }),
      );
      // note: The sibling's create refuses deterministically against the bound reference and
      // declines the SHARED reservation (no provider row exists yet).
      const declined = await refusalOf(() => residualAddExecutionPlan(execution, request));
      expect(declined.code).toBe("remote.scope-mismatch");
      // note: Restoring the unbound base lets this attempt reach its own freeze after the decline.
      await ingestRemoteObservation(
        cache.context,
        observation(positiveCheck(), {
          selectorCommit: cache.commit,
          generation: 3,
          expectRevision: 3,
          snapshot: linkedSnapshot(workflow.planId),
        }),
      );
    });
    const refused = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(overlapped).toBe(true);
    // invariant: The freeze proves the reservation's declined phase inside the freeze lane and
    // refuses; no durable intent is left under the released reservation.
    expect(refused.code).toBe("collaboration.operation-partial");
    expect(detailsOf(refused)).toMatchObject({ phase: "declined", operation_id: "frozen-after-decline" });
    expect(String(detailsOf(refused).recovery)).toContain("SAME --operation id");
    expect(await intentPhases(cache.context, "frozen-after-decline")).toEqual(["declined"]);
    expect(outboxRows(cache.dbPath)).toEqual([]);

    // invariant: A next same-ID attempt replays the recorded decline instead of freezing.
    const replay = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(replay.code).toBe("remote.scope-mismatch");
    expect(await intentPhases(cache.context, "frozen-after-decline")).toEqual(["declined"]);
    expect(outboxRows(cache.dbPath)).toEqual([]);
  }, 30_000);

  test("a frozen intent behind expired read permission keeps its reservation and resumes after re-observation", async () => {
    const cache = await outboxCache("composite-frozen-permission");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: linkedSnapshot(workflow.planId),
      }),
    );
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const request = {
      planId: workflow.planId,
      operationId: "residual-frozen-perm",
      operation: {
        kind: "residual-close" as const,
        issueId: MSTAR_ISSUE,
        disposition: "resolved" as const,
        evidence: { reason: "fixed", scope: "all", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        expectedIssueRevision: 1,
      },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const queued = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(queued.code).toBe("collaboration.operation-partial");
    const outboxId = remoteCompositeOperationId(compositeKeyOf(cache.context, "residual-frozen-perm"));

    // note: The access check expires while the row is frozen: replaying the verb fails through the
    // replay disclosure gate, which is an environment state, never a decision about the request.
    const db = new DatabaseSync(cache.dbPath);
    try {
      db.prepare("update remote_bindings set verified_at = ?").run(new Date(Date.now() - 61_000).toISOString());
    } finally {
      db.close();
    }
    const replay = await refusalOf(() => residualCloseExecutionPlan(execution, request));
    expect(replay.code).toBe("collaboration.operation-partial");
    expect(replay.message).toContain("read access is denied or expired");
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
    expect(await intentPhases(cache.context, "residual-frozen-perm")).toEqual(["prepared"]);

    // invariant: `remote observe` restores the read permission, and the SAME id resumes: the
    // settled intent confirms and only the execution delta is committed.
    await ingestRemoteObservation(
      cache.context,
      observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 2,
        snapshot: linkedSnapshot(workflow.planId),
      }),
    );
    await confirmIntent(cache, outboxId, MSTAR_ISSUE);
    const completed = await residualCloseExecutionPlan(execution, request);
    expect(completed.operationId).toBe("residual-frozen-perm");
    expect(await intentPhases(cache.context, "residual-frozen-perm")).toEqual(["confirmed"]);
  }, 30_000);

  test("a remote registration publishes its catalog delta into the project journal", async () => {
    const cache = await outboxCache("composite-registration");
    (await initializeStore(cache.context)).close();
    const state = await readExecutionState(cache.context);
    const caller: ExecutionCaller = { sessionId: "host-remote-registration", role: "coordinator", workflowId: "wf-reg" };
    const planId = "p-reg";
    const planFile = join(cache.context.harnessDir, "plans", `${planId}.md`);
    mkdirSync(dirname(planFile), { recursive: true });
    writeFileSync(planFile, `# Registered plan\n\n**plan_id:** ${planId}\n`);
    const request = {
      operationId: "registration-remote-1",
      actor: "project-manager",
      expectedCatalogRevision: 0,
      workflow: {
        kind: "plan" as const,
        workflowId: "wf-reg",
        options: {
          harnessDir: cache.context.harnessDir,
          plan: { id: planId, title: "Registered plan", file: `plans/${planId}.md` },
          deliveryKind: "development" as const,
          branchWork: "feature/wf-reg",
          branchTarget: "main",
          project: SELECTED_PROJECT.localProjectId,
          startedAt: "2026-11-20T00:00:00.000Z",
        },
      },
      delta: {
        entities: [{ kind: "plan" as const, id: planId, title: "Registered plan", rootKind: "plans" as const, relativePath: `${planId}.md` }],
        binding: { catalogKind: "plan" as const, catalogId: planId },
      },
      expected: state.token,
    };
    const execution = { harnessDir: cache.context.harnessDir, caller };

    // invariant: The reviewed delta is one project-replace intent, not a local catalog write.
    const queued = await refusalOf(() => commitExecutionRegistration(execution, request));
    expect(queued.code).toBe("collaboration.operation-partial");
    expect(detailsOf(queued)).toMatchObject({ phase: "prepared", operation_id: "registration-remote-1" });
    const outboxId = remoteCompositeOperationId(compositeKeyOf(cache.context, "registration-remote-1"));
    expect(frozenOperation(cache.dbPath, outboxId).target).toBe(JOURNAL_ANCHOR);
    expect(recordedProject(cache.dbPath, outboxId).catalogEntities).toContainEqual(
      expect.objectContaining({ kind: "plan", id: planId, lifecycle: "active", revision: 1 }),
    );
    // note: A second registration of the same document conflicts on the observed duplicate.
    await expect(commitExecutionRegistration(execution, { ...request, operationId: "registration-remote-2", expected: (await readExecutionState(cache.context)).token })).rejects.toMatchObject({
      code: "collaboration.operation-partial",
    });

    await confirmIntent(cache, outboxId, JOURNAL_ANCHOR);
    const receipt = await commitExecutionRegistration(execution, request);
    expect(receipt).toMatchObject({ operationId: "registration-remote-1", workflowId: "wf-reg", recovered: false });
    expect(await intentPhases(cache.context, "registration-remote-1")).toEqual(["confirmed"]);
  });
});

describe("remote execution-import flow", () => {
  test("a remote import finalizes its execution delta with no provider event", async () => {
    const cache = await outboxCache("composite-import");
    (await initializeStore(cache.context)).close();
    const request = { context: cache.context, operator: "operator-one", operationId: "import-remote-1" };
    // invariant: The import moves execution state only; its remote collaboration half is the
    // verified active lane, so it reserves, finalizes and records NO provider intent.
    const result = await importExecutionMinimal(request);
    expect(result.verdict).toBe("upgraded");
    expect(result.imported).toBe(0);
    expect(outboxRows(cache.dbPath)).toEqual([]);
    expect(await intentPhases(cache.context, "import-remote-1")).toEqual(["confirmed"]);
    // invariant: A replay serves the recorded result without a second reservation.
    const replay = await importExecutionMinimal(request);
    expect(replay).toEqual(result);
    expect(await intentPhases(cache.context, "import-remote-1")).toEqual(["confirmed"]);
  });
});

describe("remote confirmed business results", () => {
  test("milestone, roadmap and catalog replays report their recorded results", async () => {
    const cache = await outboxCache("outbox-confirmed-results");
    const project = SELECTED_PROJECT.localProjectId;

    // note: One milestone add, confirmed, then replayed by its own verb.
    const milestoneId = "00000000-0000-4000-8000-000000000a11";
    const milestoneMutation = { operationId: milestoneId, expectedStoreRevision: observationRevision(cache.dbPath) };
    await expect(
      addMilestone(cache.context, { projectId: project, name: "Second delivery", effortSessions: null, ordinal: 1 }, milestoneMutation),
    ).rejects.toMatchObject({ code: "remote.effect-pending" });
    const milestoneIntent = outboxIdFor(cache.dbPath, milestoneId);
    await confirmIntent(cache, milestoneIntent, JOURNAL_ANCHOR);
    const milestone = await addMilestone(
      cache.context,
      { projectId: project, name: "Second delivery", effortSessions: null, ordinal: 1 },
      milestoneMutation,
    );
    expect(milestone).toMatchObject({ projectId: project, storeRevision: 0, changed: true });
    expect(milestone.revision).toBe(1);

    // note: A confirmed effect invalidates the read base, so the next write re-observes first.
    await reobserve(cache, 2);

    // note: One roadmap replacement, confirmed, then replayed by its own verb.
    const roadmapId = "00000000-0000-4000-8000-000000000a12";
    const content = `---\nproject_id: ${project}\ntitle: Synthetic roadmap\nstatus: active\ncreated_at: 2026-09-25\n---\n\n## Direction\n\nReplaced.\n`;
    await expect(
      replaceRoadmapAuthority(
        cache.context,
        { projectId: project, expectedProjectRevision: 1, expectedRoadmapRevision: 2, contentMarkdown: content },
        { operationId: roadmapId },
      ),
    ).rejects.toMatchObject({ code: "remote.effect-pending" });
    await confirmIntent(cache, outboxIdFor(cache.dbPath, roadmapId), JOURNAL_ANCHOR);
    const roadmap = await replaceRoadmapAuthority(
      cache.context,
      { projectId: project, expectedProjectRevision: 1, expectedRoadmapRevision: 2, contentMarkdown: content },
      { operationId: roadmapId },
    );
    expect(roadmap).toMatchObject({ projectId: project, revision: 3, storeRevision: 0 });

    await reobserve(cache, 4);

    // note: One portable catalog registration, confirmed, then replayed by its own verb.
    const catalogId = "00000000-0000-4000-8000-000000000a13";
    const entity = {
      kind: "document" as const,
      id: "spec-2",
      title: "Spec two",
      documentKind: "spec" as const,
      rootKind: "specs" as const,
      relativePath: "specs/spec-2.md",
    };
    await expect(
      registerCatalogEntity(cache.context, entity, { operationId: catalogId, actor: "project-manager", projectId: project }),
    ).rejects.toMatchObject({ code: "remote.effect-pending" });
    await confirmIntent(cache, outboxIdFor(cache.dbPath, catalogId), JOURNAL_ANCHOR);
    const registered = await registerCatalogEntity(cache.context, entity, {
      operationId: catalogId,
      actor: "project-manager",
      projectId: project,
    });
    expect(registered).toEqual({ kind: "document", id: "spec-2", revision: 1, storeRevision: 0 });
    expect(outboxRows(cache.dbPath)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// note: Task 2 re-review: fork recovery ordering and freshness, digest-bound
// conflict evidence, business-verb replay identity, occurrence idempotency,
// multi-entry composites and the recorded milestone result.
// ---------------------------------------------------------------------------

/** note: The observation revision the fixture cache currently holds. */
function observationRevision(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select revision from remote_observations order by project_key limit 1").get() as
      | { revision?: unknown }
      | undefined;
    if (typeof row?.revision !== "number") throw new Error("the fixture observation row carries no revision");
    return row.revision;
  } finally {
    db.close();
  }
}

/** note: The durable time the fixture's conflict evidence was recorded. */
function conflictRecordedAt(dbPath: string, operationId: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        "select recorded_at from remote_outbox_receipts where operation_id = ? and outcome = 'conflict' " +
          "order by recorded_at desc, receipt_hash desc limit 1",
      )
      .get(operationId) as { recorded_at?: unknown } | undefined;
    if (typeof row?.recorded_at !== "string") throw new Error("the fixture conflict evidence carries no recorded time");
    return row.recorded_at;
  } finally {
    db.close();
  }
}

/** note: The immutable records the fixture's conflict evidence bound to each fork digest. */
function recordedConflictRecords(
  dbPath: string,
  operationId: string,
): Array<{ recordId: string; issueRef: string | null; head: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        "select evidence_json from remote_outbox_receipts where operation_id = ? and outcome = 'conflict' " +
          "order by recorded_at desc, receipt_hash desc limit 1",
      )
      .get(operationId) as { evidence_json?: unknown } | undefined;
    if (typeof row?.evidence_json !== "string") throw new Error("the fixture conflict evidence carries no outcome");
    const evidence = JSON.parse(row.evidence_json) as {
      outcome: { observedRecords: Array<{ recordId: string; event: RemoteEvent }> };
    };
    return evidence.outcome.observedRecords.map((record) => ({
      recordId: record.recordId,
      issueRef: record.event.change.kind === "project-replace" ? null : record.event.change.issueRef,
      head: remoteEventHead(record.event),
    }));
  } finally {
    db.close();
  }
}

/** note: The host-attested fork observation a reviewed resolution is dispatched with. */
function forkObservationFor(
  cache: { commit: string; dbPath: string },
  conflictOperationId: string,
  heads: readonly string[],
  overrides: Record<string, unknown> = {},
): ForkObservation {
  const records = recordedConflictRecords(cache.dbPath, conflictOperationId);
  return {
    version: 1,
    selectorCommit: cache.commit,
    generation: 3,
    projectId: SELECTED_PROJECT.localProjectId,
    conflictOperationId,
    // note: Strictly after the conflict evidence, as a traversal started after it would be.
    asOf: new Date(Date.parse(conflictRecordedAt(cache.dbPath, conflictOperationId)) + 1_000).toISOString(),
    coverage: "complete",
    heads: [...heads].sort().map((head, index) => {
      const record = records.find((entry) => entry.head === head);
      return {
        recordId: record?.recordId ?? `bbbbbbbb-cccc-4ddd-8eee-${String(index + 1).padStart(12, "0")}`,
        issueRef: record?.issueRef ?? FORGED_ISSUE_REF,
        head,
      };
    }),
    ...overrides,
  } as ForkObservation;
}

/** note: The competing journal records behind one fork, with the digest each one's head carries. */
function journalFork(fixture: { repoKey: string }): { heads: string[]; records: Array<Record<string, unknown>> } {
  const records = ["00000000-0000-4000-8000-0000000009d1", "00000000-0000-4000-8000-0000000009d2"].map(
    (operationId, index) => ({
      identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
      recordId: index === 0 ? "bbbbbbbb-cccc-4ddd-8eee-fffffffffff1" : "bbbbbbbb-cccc-4ddd-8eee-fffffffffff2",
      event: { ...journalEvent(fixture, operationId), parents: ["8".repeat(64)] },
    }),
  );
  return { records, heads: records.map((record) => remoteEventHead(record.event as RemoteEvent)).sort() };
}

/** note: One conflicted journal intent together with the fork evidence it recorded. */
async function conflictedJournal(
  cache: { fixture: { repoKey: string }; commit: string; context: StoreContext; dbPath: string },
  operationId: string,
): Promise<{ heads: string[]; records: Array<Record<string, unknown>>; requestHash: string }> {
  const intent = await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, operationId));
  const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, operationId));
  const fork = journalFork(cache.fixture);
  await recordRemoteReceipt(
    cache.context,
    receiptInput(cache.commit, operationId, attemptId, intent.requestHash, {
      kind: "conflict",
      expectedHeads: [OBSERVED_PROJECT_HEAD],
      observedHeads: fork.heads,
      observedRecords: fork.records,
    }),
  );
  return { ...fork, requestHash: intent.requestHash };
}

/** note: Re-observe the fixture project with its journal head replaced by the named heads. */
async function observeHead(
  cache: { context: StoreContext; commit: string; dbPath: string },
  head: readonly string[],
  coverage: RemoteSnapshot["coverage"] = { kind: "complete" },
): Promise<void> {
  const snapshot = completeSnapshot();
  await ingestRemoteObservation(cache.context, {
    ...observation(positiveCheck(), {
      selectorCommit: cache.commit,
      generation: 3,
      expectRevision: observationRevision(cache.dbPath),
    }),
    snapshot: { ...snapshot, coverage, project: { ...snapshot.project, head } },
  });
}

describe("remote outbox re-review", () => {
  test("a reviewed resolution dispatches past older intents and stops blocking unrelated sends", async () => {
    const cache = await outboxCache("outbox-resolve-order");
    const conflictedId = "00000000-0000-4000-8000-000000000711";
    const fork = await conflictedJournal(cache, conflictedId);
    // note: The ordinary intent is enqueued BEFORE the repair, which strict FIFO would deadlock.
    const queuedId = "00000000-0000-4000-8000-000000000712";
    await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, queuedId));
    const resolutionId = "00000000-0000-4000-8000-000000000713";
    await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(cache.fixture, resolutionId, fork.heads),
    });
    // invariant: The intent ahead of the repair is stale, which is never a reason to hold the repair;
    // until that repair is confirmed, the recorded conflict keeps blocking ordinary sends.
    await expect(dispatchRemoteIntent(cache.context, queuedId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      details: expect.objectContaining({ ahead: conflictedId, aheadState: "conflict" }),
    });
    expect(
      (await dispatchRemoteIntent(cache.context, resolutionId, forkObservationFor(cache, conflictedId, fork.heads))).kind,
    ).toBe("permit");
    const read = await readRemoteIntent(cache.context, resolutionId);
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, resolutionId, read.attemptId!, read.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: "bbbbbbbb-cccc-4ddd-8eee-fffffffffff3",
        event: recordedEvent(cache.dbPath, resolutionId),
      }),
    );
    // invariant: The original stays conflicted, yet it no longer blocks an unrelated send once the
    // stale intent ahead of the repair is explicitly abandoned.
    expect(await readRemoteIntent(cache.context, conflictedId)).toMatchObject({
      state: "conflict",
      resolvedBy: resolutionId,
    });
    await abandonRemoteIntent(cache.context, { operationId: queuedId, reason: "superseded by the reviewed resolution" });
    // note: The merge writes one new head; the fork's competing heads are no longer current.
    const nextHead = [remoteEventHead(recordedEvent(cache.dbPath, resolutionId))];
    await observeHead(cache, nextHead);
    const nextId = "00000000-0000-4000-8000-000000000714";
    await prepareRemoteIntent(
      cache.context,
      journalIntent(cache.fixture, cache.commit, nextId, {
        event: journalEvent(cache.fixture, nextId, nextHead),
        expectedHeads: nextHead,
      }),
    );
    expect((await dispatchRemoteIntent(cache.context, nextId)).kind).toBe("permit");
  }, 30_000);

  test("a resolution refuses missing, stale, partial, duplicated or mismatched fork evidence", async () => {
    const cache = await outboxCache("outbox-resolve-evidence");
    const conflictedId = "00000000-0000-4000-8000-000000000721";
    const fork = await conflictedJournal(cache, conflictedId);
    const resolutionId = "00000000-0000-4000-8000-000000000722";
    await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(cache.fixture, resolutionId, fork.heads),
    });
    const complete = forkObservationFor(cache, conflictedId, fork.heads);
    // invariant: The recorded fork evidence alone never sends: the host must observe it.
    await expect(dispatchRemoteIntent(cache.context, resolutionId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("no ForkObservation"),
    });
    // invariant: A traversal that began at or before the conflict evidence proves nothing, however
    // exactly its heads match. This is the stale matching snapshot the old cache rule admitted.
    await expect(
      dispatchRemoteIntent(cache.context, resolutionId, {
        ...complete,
        asOf: conflictRecordedAt(cache.dbPath, conflictedId),
      }),
    ).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("at or before the conflict evidence"),
    });
    // invariant: A partial traversal is not fork evidence, even when its heads match.
    await expect(
      dispatchRemoteIntent(cache.context, resolutionId, { ...complete, coverage: "partial" }),
    ).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("complete traversal"),
    });
    // invariant: One immutable record id never stands for two heads.
    await expect(
      dispatchRemoteIntent(cache.context, resolutionId, {
        ...complete,
        heads: [
          { ...complete.heads[0]!, recordId: "bbbbbbbb-cccc-4ddd-8eee-fffffffffff1" },
          { ...complete.heads[1]!, recordId: "bbbbbbbb-cccc-4ddd-8eee-fffffffffff1" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("record id"),
    });
    // invariant: Heads that are not the recorded fork digests never issue a permit.
    await expect(
      dispatchRemoteIntent(cache.context, resolutionId, {
        ...complete,
        heads: [{ ...complete.heads[0]!, head: "9".repeat(64) }],
      }),
    ).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("exactly the fork heads"),
    });
    // invariant: None of those refusals consumed the intent, and complete fresh evidence sends once.
    expect(outboxStateOf(cache.dbPath, resolutionId)).toBe("enqueued");
    expect(await dispatchRemoteIntent(cache.context, resolutionId, complete)).toMatchObject({
      kind: "permit",
      permit: { observation: { generation: 3, revision: observationRevision(cache.dbPath), asOf: complete.asOf } },
    });
  }, 30_000);

  test("an enqueued or unconfirmed resolution never unblocks ordinary sends", async () => {
    const cache = await outboxCache("outbox-resolution-block");
    const conflictedId = "00000000-0000-4000-8000-000000000715";
    const fork = await conflictedJournal(cache, conflictedId);
    const ordinaryId = "00000000-0000-4000-8000-000000000716";
    await prepareRemoteIntent(
      cache.context,
      journalIntent(cache.fixture, cache.commit, ordinaryId, {
        event: journalEvent(cache.fixture, ordinaryId, fork.heads),
        expectedHeads: fork.heads,
      }),
    );
    const resolutionId = "00000000-0000-4000-8000-000000000717";
    await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(cache.fixture, resolutionId, fork.heads),
    });
    // invariant: A merely enqueued resolution leaves its conflict blocking every ordinary send.
    await expect(dispatchRemoteIntent(cache.context, ordinaryId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      details: expect.objectContaining({ ahead: conflictedId, aheadState: "conflict" }),
    });
    // invariant: Only the repair's own dispatch is exempt from that conflict.
    expect(
      (await dispatchRemoteIntent(cache.context, resolutionId, forkObservationFor(cache, conflictedId, fork.heads))).kind,
    ).toBe("permit");
    // invariant: While the repair is in flight, the recorded conflict still blocks ordinary sends.
    await expect(dispatchRemoteIntent(cache.context, ordinaryId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      details: expect.objectContaining({ ahead: conflictedId, aheadState: "conflict" }),
    });
    // invariant: Confirming the repair is what opens the queue; the send still needs a current base.
    const read = await readRemoteIntent(cache.context, resolutionId);
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, resolutionId, read.attemptId!, read.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: "bbbbbbbb-cccc-4ddd-8eee-fffffffffff4",
        event: recordedEvent(cache.dbPath, resolutionId),
      }),
    );
    // invariant: A confirmed repair with a refresh still showing the competing heads is not a
    // merge, so the recorded conflict keeps blocking ordinary sends.
    await observeHead(cache, fork.heads);
    await expect(dispatchRemoteIntent(cache.context, ordinaryId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      details: expect.objectContaining({ ahead: conflictedId, aheadState: "conflict" }),
    });
    // invariant: The merged observation carries one new head, so the queue opens; the intent
    // frozen on the fork's competing heads is stale and never receives a permit.
    const mergedHead = [remoteEventHead(recordedEvent(cache.dbPath, resolutionId))];
    await observeHead(cache, mergedHead);
    await expect(dispatchRemoteIntent(cache.context, ordinaryId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("provider base moved"),
    });
    await abandonRemoteIntent(cache.context, { operationId: ordinaryId, reason: "base merged by the reviewed repair" });
    const mergedId = "00000000-0000-4000-8000-000000000718";
    await prepareRemoteIntent(
      cache.context,
      journalIntent(cache.fixture, cache.commit, mergedId, {
        event: journalEvent(cache.fixture, mergedId, mergedHead),
        expectedHeads: mergedHead,
      }),
    );
    expect((await dispatchRemoteIntent(cache.context, mergedId)).kind).toBe("permit");
  }, 30_000);

  test("an abandoned resolution restores the conflict block", async () => {
    const cache = await outboxCache("outbox-resolution-abandon");
    const conflictedId = "00000000-0000-4000-8000-000000000725";
    const fork = await conflictedJournal(cache, conflictedId);
    await observeHead(cache, fork.heads);
    const ordinaryId = "00000000-0000-4000-8000-000000000726";
    await prepareRemoteIntent(
      cache.context,
      journalIntent(cache.fixture, cache.commit, ordinaryId, {
        event: journalEvent(cache.fixture, ordinaryId, fork.heads),
        expectedHeads: fork.heads,
      }),
    );
    const resolutionId = "00000000-0000-4000-8000-000000000727";
    await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(cache.fixture, resolutionId, fork.heads),
    });
    await abandonRemoteIntent(cache.context, { operationId: resolutionId, reason: "reviewed repair withdrawn" });
    await expect(dispatchRemoteIntent(cache.context, ordinaryId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      details: expect.objectContaining({ ahead: conflictedId, aheadState: "conflict" }),
    });
  }, 30_000);

  test("a fresh traversal names the recorded immutable fork records, not just their digests", async () => {
    const cache = await outboxCache("outbox-fork-records");
    const conflictedId = "00000000-0000-4000-8000-000000000751";
    const intent = await prepareRemoteIntent(cache.context, issueIntent(cache.fixture, cache.commit, conflictedId));
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, conflictedId));
    const frozen = frozenOperation(cache.dbPath, conflictedId).event as RemoteEvent;
    const records = ["00000000-0000-4000-8000-000000000761", "00000000-0000-4000-8000-000000000762"].map(
      (conflicting, index) => ({
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: index === 0 ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea1" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeea2",
        event: { ...frozen, operationId: conflicting, parents: ["8".repeat(64)] },
      }),
    );
    const heads = records.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, conflictedId, attemptId, intent.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_ISSUE_HEAD],
        observedHeads: heads,
        observedRecords: records,
      }),
    );
    const resolutionId = "00000000-0000-4000-8000-000000000752";
    await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "merge the fork",
      event: { ...issueEvent(cache.fixture, resolutionId), parents: heads },
    });
    const complete = forkObservationFor(cache, conflictedId, heads);
    // invariant: Matching digests under other immutable records never prove the recorded fork.
    await expect(
      dispatchRemoteIntent(cache.context, resolutionId, {
        ...complete,
        heads: complete.heads.map((entry, index) => ({
          ...entry,
          recordId: `cccccccc-dddd-4eee-9fff-${String(index + 1).padStart(12, "0")}`,
        })),
      }),
    ).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("immutable record"),
    });
    // invariant: The same record under another portable issue is a fork of another issue.
    await expect(
      dispatchRemoteIntent(cache.context, resolutionId, {
        ...complete,
        heads: complete.heads.map((entry) => ({ ...entry, issueRef: "mstar:issue:cccccccc-cccc-4ccc-8ccc-cccccccccccc" })),
      }),
    ).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("portable issue"),
    });
    // invariant: Neither refusal consumed the one permit; the exact recorded records send once.
    expect(outboxStateOf(cache.dbPath, resolutionId)).toBe("enqueued");
    expect((await dispatchRemoteIntent(cache.context, resolutionId, complete)).kind).toBe("permit");
  }, 30_000);

  test("a complete fork observation that began after the conflict permits and binds the send", async () => {
    const cache = await outboxCache("outbox-resolution-fresh");
    const conflictedId = "00000000-0000-4000-8000-000000000728";
    const fork = await conflictedJournal(cache, conflictedId);
    const resolutionId = "00000000-0000-4000-8000-000000000729";
    await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(cache.fixture, resolutionId, fork.heads),
    });
    const evidence = forkObservationFor(cache, conflictedId, fork.heads);
    // invariant: Matching fork heads at the pre-conflict time are exactly the stale snapshot that
    // must not send; the same heads observed after the conflict are what admit it.
    await expect(
      dispatchRemoteIntent(cache.context, resolutionId, {
        ...evidence,
        asOf: new Date(Date.parse(conflictRecordedAt(cache.dbPath, conflictedId)) - 1_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "remote.dispatch-refused" });
    // invariant: The permit binds the observation's generation, revision and traversal start.
    expect(await dispatchRemoteIntent(cache.context, resolutionId, evidence)).toMatchObject({
      kind: "permit",
      permit: {
        observation: {
          generation: evidence.generation,
          revision: observationRevision(cache.dbPath),
          asOf: evidence.asOf,
        },
      },
    });
  }, 30_000);

  test("a changed concurrency guard never replays", async () => {
    const cache = await outboxCache("outbox-guard-replay");
    const project = SELECTED_PROJECT.localProjectId;
    const milestoneOperation = "00000000-0000-4000-8000-000000000735";
    await expect(
      updateMilestone(cache.context, project, "milestone-1", { name: "First delivery" }, {
        operationId: milestoneOperation,
        expectedStoreRevision: observationRevision(cache.dbPath),
      }),
    ).rejects.toMatchObject({ code: "remote.effect-pending" });
    // invariant: The identical guard replays the frozen intent instead of freezing another.
    await expect(
      updateMilestone(cache.context, project, "milestone-1", { name: "First delivery" }, {
        operationId: milestoneOperation,
        expectedStoreRevision: observationRevision(cache.dbPath),
      }),
    ).rejects.toMatchObject({ code: "remote.effect-pending" });
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
    // invariant: A changed expected store revision is a different request under the same id.
    await expect(
      updateMilestone(cache.context, project, "milestone-1", { name: "First delivery" }, {
        operationId: milestoneOperation,
        expectedStoreRevision: observationRevision(cache.dbPath) + 1,
      }),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });

    const actor = "project-manager";
    const occurrence = {
      sourceIdentity: "review:fixture",
      rootCauseKey: "remote.observation",
      acceptanceKey: "remote.observation.stored",
      occurrenceKey: "occurrence-two",
      sourceKind: "review",
      location: "packages/engine/src/collaboration-remote.ts",
      observedBehavior: "The store refused a complete scope.",
      evidence: ["review-fixture"],
      discoveredAt: "2026-11-20T00:00:00.000Z",
    };
    const occurrenceOperation = "00000000-0000-4000-8000-000000000736";
    await expect(
      appendOccurrence(cache.context, FORGED_ISSUE_REF, occurrence, {
        operationId: occurrenceOperation,
        actor,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "remote.effect-pending" });
    // invariant: A changed expected issue revision is a different request under the same id.
    await expect(
      appendOccurrence(cache.context, FORGED_ISSUE_REF, occurrence, {
        operationId: occurrenceOperation,
        actor,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
  }, 30_000);

  test("a conflict is bound to the digest of each record and a unique record id", async () => {
    const cache = await outboxCache("outbox-conflict-digest");
    const conflictedId = "00000000-0000-4000-8000-000000000731";
    const intent = await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, conflictedId));
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, conflictedId));
    const fork = journalFork(cache.fixture);
    const conflictReceipt = (outcome: Record<string, unknown>): Record<string, unknown> =>
      receiptInput(cache.commit, conflictedId, attemptId, intent.requestHash, { kind: "conflict", ...outcome });
    // invariant: Heads that do not digest the records they name are refused.
    await expect(
      recordRemoteReceipt(
        cache.context,
        conflictReceipt({
          expectedHeads: [OBSERVED_PROJECT_HEAD],
          observedHeads: ["6".repeat(64), "7".repeat(64)],
          observedRecords: fork.records,
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    // invariant: One immutable record never stands for two heads.
    const reused = [fork.records[0]!, { ...fork.records[1]!, recordId: fork.records[0]!.recordId }];
    await expect(
      recordRemoteReceipt(
        cache.context,
        conflictReceipt({
          expectedHeads: [OBSERVED_PROJECT_HEAD],
          observedHeads: reused.map((record) => remoteEventHead(record.event as RemoteEvent)).sort(),
          observedRecords: reused,
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    // invariant: A record of another scope is never accepted as this fork.
    const foreign = [{ ...fork.records[0]!, identity: { ...providerScope(), issueId: MSTAR_ISSUE } }, fork.records[1]!];
    await expect(
      recordRemoteReceipt(
        cache.context,
        conflictReceipt({
          expectedHeads: [OBSERVED_PROJECT_HEAD],
          observedHeads: fork.heads,
          observedRecords: foreign,
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.scope-mismatch" });
    // invariant: A refused record settles nothing.
    expect(await readRemoteIntent(cache.context, conflictedId)).toMatchObject({ state: "unconfirmed", receipts: [] });
  });

  test("an operation id replays only its identical business verb and payload", async () => {
    const cache = await outboxCache("outbox-replay-origin");
    const project = SELECTED_PROJECT.localProjectId;
    const operationId = "00000000-0000-4000-8000-000000000741";
    const mutation = { operationId, expectedStoreRevision: observationRevision(cache.dbPath) };
    await expect(
      updateMilestone(cache.context, project, "milestone-1", { name: "First delivery" }, mutation),
    ).rejects.toMatchObject({ code: "remote.effect-pending" });
    await confirmIntent(cache, outboxIdFor(cache.dbPath, operationId), JOURNAL_ANCHOR);
    // invariant: A no-op update reports the RECORDED result: no change, its own revision.
    expect(await updateMilestone(cache.context, project, "milestone-1", { name: "First delivery" }, mutation)).toEqual({
      projectId: project,
      milestoneId: "milestone-1",
      revision: 1,
      storeRevision: 0,
      changed: false,
    });
    // invariant: Another payload under the same id is a conflict, not a replay.
    await expect(
      updateMilestone(cache.context, project, "milestone-1", { name: "Renamed" }, mutation),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    // invariant: Another VERB under the same id never replays, even though the observed document
    // already satisfies what its old final-document predicate looked for.
    await expect(removeMilestone(cache.context, project, "milestone-1", mutation)).rejects.toMatchObject({
      code: "remote.operation-conflict",
    });
  });

  test("a confirmed removal reports the revision it removed", async () => {
    const cache = await outboxCache("outbox-milestone-removal");
    const project = SELECTED_PROJECT.localProjectId;
    const operationId = "00000000-0000-4000-8000-000000000751";
    const mutation = { operationId, expectedStoreRevision: observationRevision(cache.dbPath) };
    await expect(removeMilestone(cache.context, project, "milestone-1", mutation)).rejects.toMatchObject({
      code: "remote.effect-pending",
    });
    await confirmIntent(cache, outboxIdFor(cache.dbPath, operationId), JOURNAL_ANCHOR);
    expect(await removeMilestone(cache.context, project, "milestone-1", mutation)).toEqual({
      projectId: project,
      milestoneId: "milestone-1",
      revision: 1,
      storeRevision: 0,
      changed: true,
    });
    // invariant: The confirmed document really dropped the row.
    expect(recordedProject(cache.dbPath, outboxIdFor(cache.dbPath, operationId)).milestones).toEqual([]);
  });

  test("a repeated occurrence returns the established result instead of appending history", async () => {
    const cache = await outboxCache("outbox-occurrence-repeat");
    const actor = "project-manager";
    const observedOccurrence = {
      sourceIdentity: "review:fixture",
      rootCauseKey: "remote.observation",
      acceptanceKey: "remote.observation.stored",
      occurrenceKey: "occurrence-one",
      sourceKind: "review",
      location: "packages/engine/src/collaboration-remote.ts",
      observedBehavior: "The store refused a complete scope.",
      evidence: ["review-fixture"],
      discoveredAt: "2026-11-20T00:00:00.000Z",
    };
    // invariant: The observed authority already carries this observation: nothing is frozen, and
    // the established receipt names the occurrence's own frozen identity.
    expect(
      await appendOccurrence(cache.context, FORGED_ISSUE_REF, observedOccurrence, {
        operationId: "00000000-0000-4000-8000-000000000761",
        actor,
        expectedRevision: 1,
      }),
    ).toEqual({
      issueId: MSTAR_ISSUE,
      occurrenceId: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      storeRevision: 0,
      created: false,
    });
    expect(outboxRows(cache.dbPath).map((row) => row.state)).toEqual(["abandoned"]);
    // invariant: The concurrency guard runs before the no-change answer: a stale or missing
    // revision never receives the established success.
    await expect(
      appendOccurrence(cache.context, FORGED_ISSUE_REF, observedOccurrence, {
        operationId: "00000000-0000-4000-8000-000000000764",
        actor,
        expectedRevision: 9,
      }),
    ).rejects.toMatchObject({ code: "issue.revision-conflict" });
    await expect(
      appendOccurrence(cache.context, FORGED_ISSUE_REF, observedOccurrence, {
        operationId: "00000000-0000-4000-8000-000000000765",
        actor,
      }),
    ).rejects.toMatchObject({ code: "issue.revision-conflict" });
    // invariant: The same key with another observation is a conflict, never a second history row.
    await expect(
      appendOccurrence(
        cache.context,
        FORGED_ISSUE_REF,
        { ...observedOccurrence, observedBehavior: "another reading" },
        { operationId: "00000000-0000-4000-8000-000000000762", actor, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "issue.occurrence-conflict" });
    expect(outboxRows(cache.dbPath).map((row) => row.state)).toEqual(["abandoned"]);
    // invariant: A new observation of the same issue still freezes exactly one intent.
    await expect(
      appendOccurrence(
        cache.context,
        FORGED_ISSUE_REF,
        { ...observedOccurrence, occurrenceKey: "occurrence-two" },
        { operationId: "00000000-0000-4000-8000-000000000763", actor, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "remote.effect-pending" });
    expect(outboxRows(cache.dbPath).map((row) => row.state)).toEqual(["abandoned", "enqueued"]);
  });

  test("a recorded no-change claim stays readable over history the replacement contract refuses", async () => {
    const cache = await outboxCache("outbox-occurrence-claim-legacy");
    const actor = "project-manager";
    const observedOccurrence = {
      sourceIdentity: "review:fixture",
      rootCauseKey: "remote.observation",
      acceptanceKey: "remote.observation.stored",
      occurrenceKey: "occurrence-one",
      sourceKind: "review",
      location: "packages/engine/src/collaboration-remote.ts",
      observedBehavior: "The store refused a complete scope.",
      evidence: ["review-fixture"],
      discoveredAt: "2026-11-20T00:00:00.000Z",
    };
    // note: The observed history also carries an imported occurrence whose dedup key was never
    // resolved. It is provider evidence an observation serves, but it is never replacement content:
    // freezing it would persist a dedup the issue domain refuses.
    const check = positiveCheck();
    const base = completeSnapshot(check);
    const native = base.issues[0]!;
    if (native.mstar === null) throw new Error("fixture: the snapshot carries no MStar subject");
    const unresolved = {
      ...native.mstar.occurrences[0]!,
      eventId: "55555555-5555-4555-8555-555555555555",
      occurrenceKey: "occurrence-legacy",
      rootCauseKey: "unknown",
      acceptanceKey: "unknown",
      imported: true,
    };
    await ingestRemoteObservation(
      cache.context,
      observation(check, {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: 1,
        snapshot: {
          ...base,
          issues: [
            { ...native, mstar: { ...native.mstar, occurrences: [unresolved, ...native.mstar.occurrences] } },
            base.issues[1]!,
          ],
        },
      }),
    );
    const operationId = "00000000-0000-4000-8000-000000000781";
    const mutation = { operationId, actor, expectedRevision: 1 };
    const receipt = {
      issueId: MSTAR_ISSUE,
      occurrenceId: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      storeRevision: 0,
      created: false,
    };
    expect(await appendOccurrence(cache.context, FORGED_ISSUE_REF, observedOccurrence, mutation)).toEqual(receipt);
    // invariant: The claim records the replay identity and the receipt, never the observed subject
    // as a provider event: the history it carries is not replacement content.
    const [claimed] = outboxRows(cache.dbPath);
    const claim = JSON.parse(String(claimed?.request_json)) as Record<string, unknown>;
    expect(claim).not.toHaveProperty("event");
    expect(claim).toMatchObject({
      settled: 1,
      kind: "issue-replace",
      issueRef: FORGED_ISSUE_REF,
      target: MSTAR_ISSUE,
      result: { noChange: receipt },
    });
    // invariant: The SAME request under the SAME id replays the recorded receipt, and a different
    // payload under that id still refuses.
    expect(await appendOccurrence(cache.context, FORGED_ISSUE_REF, observedOccurrence, mutation)).toEqual(receipt);
    await expect(
      appendOccurrence(
        cache.context,
        FORGED_ISSUE_REF,
        { ...observedOccurrence, observedBehavior: "another reading" },
        mutation,
      ),
    ).rejects.toMatchObject({ code: "remote.operation-conflict" });
    // invariant: Inspection and the pending list stay readable: the claim is a durable abandoned row
    // with its identity disclosed, never an unreadable frozen request.
    expect(await readRemoteIntent(cache.context, operationId)).toMatchObject({
      state: "abandoned",
      disclosure: "full",
      event: null,
      settled: { kind: "issue-replace", issueRef: FORGED_ISSUE_REF },
      target: MSTAR_ISSUE,
      result: { noChange: receipt },
      receipts: [],
    });
    expect((await readPendingIntents(cache.context, SELECTED_PROJECT.localProjectId)).intents).toEqual([]);
    // invariant: A claim was never dispatched, so no lifecycle verb acts on it: each names the claim
    // instead of reporting the row unreadable.
    await expect(dispatchRemoteIntent(cache.context, operationId)).rejects.toMatchObject({ code: "remote.dispatch-refused" });
    await expect(abandonRemoteIntent(cache.context, { operationId, reason: "retire the claim" })).rejects.toMatchObject({
      code: "remote.dispatch-refused",
    });
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
  });

  test("a multi-entry residual-add reports every durable component and resumes", async () => {
    const cache = await outboxCache("composite-residual-partial");
    const workflow = await remoteExecutionWorkflow(cache);
    setPlanProjectBucket(cache.context, workflow.planId, SELECTED_PROJECT.localProjectId);
    const execution = { harnessDir: cache.context.harnessDir, caller: workflow.caller };
    const operationId = "residual-remote-partial";
    const request = {
      planId: workflow.planId,
      operationId,
      operation: { kind: "residual-add" as const, entries: [residualEntry("first"), residualEntry("second")] },
      expected: workflow.planToken,
      session: workflow.session,
    };
    const key = { executionStoreId: workflow.storeId, executionEpoch: workflow.epoch, operationId };
    const firstEntry = remoteCompositeEntryOperationId(key, 0);
    const secondEntry = remoteCompositeEntryOperationId(key, 1);
    // note: The second entry's provider id is already taken by another request, so preparing it
    // fails AFTER the first entry is durable.
    await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, secondEntry));
    const refused = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(refused.code).toBe("collaboration.operation-partial");
    // invariant: The refusal names the durable entry instead of claiming nothing was frozen.
    expect(detailsOf(refused)).toMatchObject({
      phase: "prepared",
      frozen_components: [firstEntry],
      confirmed_components: [],
      cause_code: "remote.operation-conflict",
    });
    expect(outboxStateOf(cache.dbPath, firstEntry)).toBe("enqueued");
    // invariant: The retry reuses the durable entry instead of minting a second identity.
    const retried = await refusalOf(() => residualAddExecutionPlan(execution, request));
    expect(detailsOf(retried).frozen_components).toEqual([firstEntry]);
    expect(outboxRows(cache.dbPath)).toHaveLength(2);
  });

  test("a multi-entry remote composite names every confirmed effect and issue", async () => {
    const cache = await outboxCache("composite-multi-facts");
    (await initializeStore(cache.context)).close();
    const state = await readExecutionState(cache.context);
    const key = { executionStoreId: state.storeId, executionEpoch: state.epoch, operationId: "composite-multi-facts" };
    const intent: CompositeIntent = {
      key,
      kind: "residual-add",
      requestHash: "composite-multi-facts-hash",
      target: { repoKey: cache.fixture.repoKey, mode: "remote", storeId: state.storeId, epoch: state.epoch },
      scope: { workflowId: null, planId: null },
      actor: "project-manager",
      expectedExecution: state.token,
      frozenPayload: JSON.stringify({ entries: 2 }),
    };
    await withExecutionTransaction(cache.context, (tx) =>
      reserveCompositeIntent(tx, intent, { revision: tx.execution.revision }),
    );
    const first = "00000000-0000-4000-8000-000000000771";
    const second = "00000000-0000-4000-8000-000000000772";
    await prepareRemoteIntent(cache.context, issueIntent(cache.fixture, cache.commit, first));
    await prepareRemoteIntent(cache.context, issueIntent(cache.fixture, cache.commit, second));
    let facts = "";
    const effects = {
      apply: () => {
        throw new Error("a remote composite never writes the local collaboration lane");
      },
      finalize: (_tx: ExecutionTransaction, receipt: CollaborationEffectReceipt) => {
        facts = receipt.facts;
        return "finalized";
      },
      remote: async (context: StoreContext) => [
        await prepareRemoteIntent(context, issueIntent(cache.fixture, cache.commit, first)),
        await prepareRemoteIntent(context, issueIntent(cache.fixture, cache.commit, second)),
      ],
    };
    // invariant: A pending entry is reported with every durable component, never as "none".
    const queued = await refusalOf(() => runCollaborationComposite(cache.context, intent, effects));
    expect(detailsOf(queued)).toMatchObject({ frozen_components: [first, second], confirmed_components: [] });
    // note: Both provider effects confirm, the second after the base moved; then ONE finalization.
    await confirmIntent(cache, first, MSTAR_ISSUE);
    await reobserve(cache, observationRevision(cache.dbPath));
    await confirmIntent(cache, second, MSTAR_ISSUE);
    expect(await runCollaborationComposite(cache.context, intent, effects)).toBe("finalized");
    const parsedFacts: unknown = JSON.parse(facts);
    if (parsedFacts === null || typeof parsedFacts !== "object" || !("remote" in parsedFacts)) {
      throw new Error("the composite receipt carries no remote facts");
    }
    expect(parsedFacts.remote).toEqual([
      expect.objectContaining({ operationId: first, issueId: MSTAR_ISSUE }),
      expect.objectContaining({ operationId: second, issueId: MSTAR_ISSUE }),
    ]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// note: Plan-2 QC fix wave: abandoned-resolution recovery, same-subject merges,
// admitted-lane disclosure, two-clock freshness, adoption replay, composite
// acknowledgement framing, the observed-base guard and lookup availability.
// ---------------------------------------------------------------------------

/** note: A raw event the contract's own validators judge; a fixture, not a typed producer. */
function shapedEvent(
  cache: { fixture: { repoKey: string } },
  operationId: string,
  parents: readonly string[],
  change: Record<string, unknown>,
): RemoteEvent {
  return {
    version: 1,
    repoKey: cache.fixture.repoKey,
    projectId: SELECTED_PROJECT.localProjectId,
    operationId,
    parents,
    change,
  } as unknown as RemoteEvent;
}

describe("remote outbox qc fixes", () => {
  test("an unsafe-fidelity snapshot revokes the writer, so no permit, a reviewed resolution included, survives it", async () => {
    const cache = await outboxCache("outbox-unsafe-revokes");
    const conflictedId = "00000000-0000-4000-8000-000000000811";
    const fork = await conflictedJournal(cache, conflictedId);
    const resolutionId = "00000000-0000-4000-8000-000000000812";
    await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(cache.fixture, resolutionId, fork.heads),
    });
    // note: The reviewed repair is fully dispatchable while the scope is verified.
    expect(await readRemoteIntent(cache.context, resolutionId)).toMatchObject({ disclosure: "full" });

    // note: The host's check verifies, but its snapshot carries a portable field the cache
    // cannot keep, so the decoder refuses the observation by name and invalidates the cache.
    const check = positiveCheck();
    const base = completeSnapshot(check);
    const subject = base.issues[0]!.mstar!;
    const unsafe: unknown = await ingestRemoteObservation(cache.context, {
      ...observation(check, {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: observationRevision(cache.dbPath),
      }),
      snapshot: {
        ...base,
        issues: [
          {
            ...base.issues[0]!,
            mstar: {
              ...subject,
              provenance: [{ ...subject.provenance[0]!, legacyRecord: { title: "x".repeat(600), lifecycle: "active" } }],
            },
          },
          base.issues[1]!,
        ],
      },
    }).catch((error: unknown) => error);
    expect(unsafe).toMatchObject({ code: "remote.unsafe-fidelity" });

    // invariant: The invalidation and the writer revocation are one transaction, so the
    // otherwise valid fork evidence never yields a permit and frozen content is withheld.
    await expect(
      dispatchRemoteIntent(cache.context, resolutionId, forkObservationFor(cache, conflictedId, fork.heads)),
    ).rejects.toMatchObject({ code: "remote.dispatch-refused" });
    expect(await readRemoteIntent(cache.context, resolutionId)).toMatchObject({ disclosure: "metadata", event: null });
  }, 30_000);

  test("a same-instant bind never restores the writer an unsafe-fidelity observation revoked", async () => {
    const fixture = remoteFixture("outbox-unsafe-bind-tie");
    const commit = fixture.publish(fixture.payload());
    const context = contextAt(fixture.repo);
    const dbPath = locationAt(fixture.repo).dbPath;
    // note: One host instant carries both the bind and the observation refused for it.
    const check = positiveCheck({ checkedAt: new Date(Date.now() - 2_000).toISOString() });
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [check] });
    const base = completeSnapshot(check);
    const subject = base.issues[0]!.mstar!;
    const unsafeSnapshot = {
      ...base,
      issues: [
        {
          ...base.issues[0]!,
          mstar: {
            ...subject,
            provenance: [{ ...subject.provenance[0]!, legacyRecord: { title: "x".repeat(600), lifecycle: "active" } }],
          },
        },
        base.issues[1]!,
      ],
    };
    const refused = await ingestRemoteObservation(context, {
      ...observation(check, { selectorCommit: commit, generation: 3, expectRevision: 0 }),
      snapshot: unsafeSnapshot,
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "remote.unsafe-fidelity" });

    // invariant: The decoder refused that snapshot at the instant the bind recorded, so a bind
    // carrying the same positive check may not overwrite the recorded negative outcome.
    await expect(
      bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [check] }),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
    const evidence = bindingEvidence(dbPath);
    expect(evidence.verified_at).toBe(check.checkedAt);
    expect(JSON.parse(evidence.verification_json)).toMatchObject({ outcome: { kind: "unsafe-fidelity" } });
    expect(evidence.writer_id).toBeNull();

    // invariant: The exception belongs to the refusal branch alone: a decodable positive
    // observation resubmitted at the refused instant is stale and re-authorizes nothing.
    await expect(
      ingestRemoteObservation(context, {
        ...observation(check, { selectorCommit: commit, generation: 3, expectRevision: 1 }),
      }),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
    expect(JSON.parse(bindingEvidence(dbPath).verification_json)).toMatchObject({
      outcome: { kind: "unsafe-fidelity" },
    });
    expect(bindingEvidence(dbPath).writer_id).toBeNull();
    expect(await readRemoteStatus(context)).toMatchObject({
      available: false,
      projects: [{ revision: 1, completeness: "unavailable", code: "remote.unsafe-fidelity" }],
    });

    // invariant: The observation itself may replay exactly that refused submission at the same
    // instant, and the replay records the refusal again instead of restoring the binding.
    const replay = await ingestRemoteObservation(context, {
      ...observation(check, { selectorCommit: commit, generation: 3, expectRevision: 1 }),
      snapshot: unsafeSnapshot,
    }).catch((error: unknown) => error);
    expect(replay).toMatchObject({ code: "remote.unsafe-fidelity" });
    const replayed = bindingEvidence(dbPath);
    expect(JSON.parse(replayed.verification_json)).toMatchObject({ outcome: { kind: "unsafe-fidelity" } });
    expect(replayed.writer_id).toBeNull();
  }, 30_000);

  test("an abandoned outbox resolution is replaceable and keeps its audit row", async () => {
    const cache = await outboxCache("outbox-replace-abandoned");
    const conflictedId = "00000000-0000-4000-8000-000000000801";
    const fork = await conflictedJournal(cache, conflictedId);
    const firstId = "00000000-0000-4000-8000-000000000802";
    await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: firstId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(cache.fixture, firstId, fork.heads),
    });
    const withdrawn = await abandonRemoteIntent(cache.context, { operationId: firstId, reason: "reviewed repair withdrawn" });
    expect(withdrawn).toMatchObject({ state: "abandoned", resolves: conflictedId });

    // invariant: The withdrawn repair stays for audit, and a NEW reviewed replacement takes the
    // fork over instead of being refused forever by the dead pointer.
    const secondId = "00000000-0000-4000-8000-000000000803";
    expect(
      await prepareRemoteResolution(cache.context, conflictedId, {
        operationId: secondId,
        operator: "operator-one",
        reason: "merge the fork after review",
        event: journalEvent(cache.fixture, secondId, fork.heads),
      }),
    ).toMatchObject({ operationId: secondId, state: "enqueued" });
    // invariant: The withdrawn repair keeps its durable row, its `resolves` edge and its content.
    expect(await readRemoteIntent(cache.context, firstId)).toMatchObject({
      state: "abandoned",
      resolves: conflictedId,
      disclosure: "full",
      abandonReason: "reviewed repair withdrawn",
    });
    expect(await readRemoteIntent(cache.context, conflictedId)).toMatchObject({ state: "conflict", resolvedBy: secondId });

    // invariant: Ordinary sends stay closed until the replacement itself is confirmed.
    const ordinaryId = "00000000-0000-4000-8000-000000000804";
    await prepareRemoteIntent(
      cache.context,
      journalIntent(cache.fixture, cache.commit, ordinaryId, {
        event: journalEvent(cache.fixture, ordinaryId, fork.heads),
        expectedHeads: fork.heads,
      }),
    );
    await expect(dispatchRemoteIntent(cache.context, ordinaryId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      details: expect.objectContaining({ ahead: conflictedId, aheadState: "conflict" }),
    });
    expect((await dispatchRemoteIntent(cache.context, secondId, forkObservationFor(cache, conflictedId, fork.heads))).kind).toBe(
      "permit",
    );
    const read = await readRemoteIntent(cache.context, secondId);
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, secondId, read.attemptId!, read.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: "bbbbbbbb-cccc-4ddd-8eee-fffffffff8a1",
        event: recordedEvent(cache.dbPath, secondId),
      }),
    );
    // invariant: Confirmation alone reopens nothing: a refresh still carrying the competing heads
    // leaves the walked fork unmerged and the queue closed.
    await observeHead(cache, fork.heads);
    await expect(dispatchRemoteIntent(cache.context, ordinaryId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      details: expect.objectContaining({ ahead: conflictedId, aheadState: "conflict" }),
    });
    // invariant: The merged observation carries one new head; the queue opens and the stale intent
    // frozen on the fork heads is refused by its own base check.
    const mergedHead = [remoteEventHead(recordedEvent(cache.dbPath, secondId))];
    await observeHead(cache, mergedHead);
    await expect(dispatchRemoteIntent(cache.context, ordinaryId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("provider base moved"),
    });
    await abandonRemoteIntent(cache.context, { operationId: ordinaryId, reason: "base merged by the reviewed repair" });
    const mergedId = "00000000-0000-4000-8000-000000000805";
    await prepareRemoteIntent(
      cache.context,
      journalIntent(cache.fixture, cache.commit, mergedId, {
        event: journalEvent(cache.fixture, mergedId, mergedHead),
        expectedHeads: mergedHead,
      }),
    );
    expect((await dispatchRemoteIntent(cache.context, mergedId)).kind).toBe("permit");
  }, 30_000);

  test("a conflicted outbox repair is repaired by a successor in the live chain", async () => {
    const cache = await outboxCache("outbox-repair-chain");
    const conflictedId = "00000000-0000-4000-8000-000000000811";
    const fork = await conflictedJournal(cache, conflictedId);
    const repairId = "00000000-0000-4000-8000-000000000812";
    const repair = await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(cache.fixture, repairId, fork.heads),
    });
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, repairId, forkObservationFor(cache, conflictedId, fork.heads)));
    // note: The repair itself encounters a second fork; its own repair must not be blocked by the
    // ancestor conflict, whose live resolution chain now names both.
    const second = journalFork(cache.fixture);
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, repairId, attemptId, repair.requestHash, {
        kind: "conflict",
        expectedHeads: fork.heads,
        observedHeads: second.heads,
        observedRecords: second.records,
      }),
    );
    const successorId = "00000000-0000-4000-8000-000000000813";
    const successor = await prepareRemoteResolution(cache.context, repairId, {
      operationId: successorId,
      operator: "operator-one",
      reason: "merge the second fork",
      event: journalEvent(cache.fixture, successorId, second.heads),
    });
    // note: An ordinary intent frozen on the second fork's base waits for the whole chain.
    const ordinaryId = "00000000-0000-4000-8000-000000000814";
    await prepareRemoteIntent(
      cache.context,
      journalIntent(cache.fixture, cache.commit, ordinaryId, {
        event: journalEvent(cache.fixture, ordinaryId, second.heads),
        expectedHeads: second.heads,
      }),
    );
    // invariant: Before the terminal repair confirms, the original conflict still closes the queue.
    await expect(dispatchRemoteIntent(cache.context, ordinaryId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      details: expect.objectContaining({ ahead: conflictedId, aheadState: "conflict" }),
    });
    const successorAttempt = attemptOf(
      await dispatchRemoteIntent(cache.context, successorId, forkObservationFor(cache, repairId, second.heads)),
    );
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, successorId, successorAttempt, successor.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: "bbbbbbbb-cccc-4ddd-8eee-fffffffff8b3",
        event: journalEvent(cache.fixture, successorId, second.heads),
      }),
    );
    // invariant: A confirmed terminal repair settles the LIVE `resolved_by` chain, but a refresh
    // still carrying the competing heads is not a merge: the ancestor conflict keeps blocking.
    await observeHead(cache, second.heads);
    await expect(dispatchRemoteIntent(cache.context, ordinaryId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      details: expect.objectContaining({ ahead: conflictedId, aheadState: "conflict" }),
    });
    // invariant: The merged observation carries the terminal repair's one head; the queue opens,
    // and an intent frozen on the fork heads is refused by its own base check.
    const mergedHead = [remoteEventHead(recordedEvent(cache.dbPath, successorId))];
    await observeHead(cache, mergedHead);
    await expect(dispatchRemoteIntent(cache.context, ordinaryId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("provider base moved"),
    });
    await abandonRemoteIntent(cache.context, { operationId: ordinaryId, reason: "base merged by the terminal repair" });
    const mergedId = "00000000-0000-4000-8000-000000000815";
    await prepareRemoteIntent(
      cache.context,
      journalIntent(cache.fixture, cache.commit, mergedId, {
        event: journalEvent(cache.fixture, mergedId, mergedHead),
        expectedHeads: mergedHead,
      }),
    );
    expect((await dispatchRemoteIntent(cache.context, mergedId)).kind).toBe("permit");
  }, 30_000);

  test("the taken-over refusal names the actionable tail of a depth-2 resolution chain", async () => {
    const cache = await outboxCache("outbox-taken-over-tail");
    const conflictedId = "00000000-0000-4000-8000-000000000861";
    const fork = await conflictedJournal(cache, conflictedId);
    const repairId = "00000000-0000-4000-8000-000000000862";
    const repair = await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(cache.fixture, repairId, fork.heads),
    });
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, repairId, forkObservationFor(cache, conflictedId, fork.heads)));
    const second = journalFork(cache.fixture);
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, repairId, attemptId, repair.requestHash, {
        kind: "conflict",
        expectedHeads: fork.heads,
        observedHeads: second.heads,
        observedRecords: second.records,
      }),
    );
    const leafId = "00000000-0000-4000-8000-000000000863";
    await prepareRemoteResolution(cache.context, repairId, {
      operationId: leafId,
      operator: "operator-one",
      reason: "merge the second fork",
      event: journalEvent(cache.fixture, leafId, second.heads),
    });
    const otherId = "00000000-0000-4000-8000-000000000864";
    const attemptResolve = () =>
      refusalOf(() =>
        prepareRemoteResolution(cache.context, conflictedId, {
          operationId: otherId,
          operator: "operator-two",
          reason: "another review of the original fork",
          event: journalEvent(cache.fixture, otherId, fork.heads),
        }),
      );

    // invariant: A -> B(conflict) -> C(enqueued): the refusal names C's concrete id and its
    // dispatch step, never a resolve of B or of A (the parent this command addressed).
    const taken = await attemptResolve();
    expect(taken.code).toBe("remote.operation-conflict");
    expect(taken.message).toContain(`outbox-dispatch --harness <abs> --operation ${leafId} --input`);
    expect(taken.message).not.toContain(`outbox-resolve --harness <abs> --operation ${repairId}`);
    expect(taken.message).not.toContain(`outbox-resolve --harness <abs> --operation ${conflictedId}`);

    // invariant: With the leaf abandoned, its PARENT B is the actionable row: the refusal names
    // B with the resolve step and never names the withdrawn leaf.
    await abandonRemoteIntent(cache.context, { operationId: leafId, reason: "withdrawn review" });
    const afterAbandon = await attemptResolve();
    expect(afterAbandon.message).toContain(`outbox-resolve --harness <abs> --operation ${repairId} --input`);
    expect(afterAbandon.message).not.toContain(`--operation ${leafId}`);

    // invariant: A confirmed leaf settles the whole chain: the conflict rows are settled and the
    // pending listing never shows them.
    const settledId = "00000000-0000-4000-8000-000000000865";
    const settled = await prepareRemoteResolution(cache.context, repairId, {
      operationId: settledId,
      operator: "operator-one",
      reason: "merge the second fork",
      event: journalEvent(cache.fixture, settledId, second.heads),
    });
    const settledAttempt = attemptOf(
      await dispatchRemoteIntent(cache.context, settledId, forkObservationFor(cache, repairId, second.heads)),
    );
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, settledId, settledAttempt, settled.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: "bbbbbbbb-cccc-4ddd-8eee-fffffffff861",
        event: journalEvent(cache.fixture, settledId, second.heads),
      }),
    );
    const pending = await readPendingIntents(cache.context, SELECTED_PROJECT.localProjectId);
    expect(pending.intents.map((entry) => entry.operationId)).not.toContain(conflictedId);
    expect(pending.intents.map((entry) => entry.operationId)).not.toContain(repairId);
  }, 30_000);

  test("a damaged resolution chain falls back to the cache rebuild route", async () => {
    const cache = await outboxCache("outbox-taken-over-damaged");
    const conflictedId = "00000000-0000-4000-8000-000000000871";
    const fork = await conflictedJournal(cache, conflictedId);
    const repairId = "00000000-0000-4000-8000-000000000872";
    await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(cache.fixture, repairId, fork.heads),
    });
    const otherId = "00000000-0000-4000-8000-000000000873";
    const attemptResolve = () =>
      refusalOf(() =>
        prepareRemoteResolution(cache.context, conflictedId, {
          operationId: otherId,
          operator: "operator-two",
          reason: "another review of the original fork",
          event: journalEvent(cache.fixture, otherId, fork.heads),
        }),
      );
    const severLink = (resolvedBy: string): void => {
      const db = new DatabaseSync(cache.dbPath);
      // why: the damaged link is exactly a foreign-key violation, so the probe writes it with the
      // check disabled the way a corrupted cache would have gotten there.
      db.exec("pragma foreign_keys = off");
      try {
        db.prepare("update remote_outbox set resolved_by = ? where operation_id = ?").run(resolvedBy, conflictedId);
      } finally {
        db.close();
      }
    };

    // invariant: A missing link cannot name a row; the rebuild route is the only named recovery.
    severLink("00000000-0000-4000-8000-0000000008ff");
    const missing = await attemptResolve();
    expect(missing.code).toBe("remote.operation-conflict");
    expect(missing.message).toContain("damaged");
    expect(missing.message).toContain("cache rebuild");

    // invariant: A cycle is the same damaged route, never an invented step.
    severLink(conflictedId);
    const cycle = await attemptResolve();
    expect(cycle.message).toContain("damaged");
  }, 30_000);

  test("an outbox resolution must merge the same subject and keep both branches", async () => {
    const cache = await outboxCache("outbox-resolution-subject");
    const conflictedId = "00000000-0000-4000-8000-000000000821";
    const intent = await prepareRemoteIntent(cache.context, issueIntent(cache.fixture, cache.commit, conflictedId));
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, conflictedId));
    const frozen = frozenOperation(cache.dbPath, conflictedId).event as RemoteEvent;
    const records = ["00000000-0000-4000-8000-000000000822", "00000000-0000-4000-8000-000000000823"].map(
      (operationId, index) => ({
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: index === 0 ? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeef01" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeef02",
        event: { ...frozen, operationId, parents: ["8".repeat(64)] },
      }),
    );
    const heads = records.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, conflictedId, attemptId, intent.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_ISSUE_HEAD],
        observedHeads: heads,
        observedRecords: records,
      }),
    );
    const resolution = (operationId: string, change: Record<string, unknown>) => ({
      operationId,
      operator: "operator-one",
      reason: "merge the fork",
      event: shapedEvent(cache, operationId, heads, change),
    });

    // invariant: A create/adopt is another write, never the repair of this issue fork.
    await expect(
      prepareRemoteResolution(
        cache.context,
        conflictedId,
        resolution("00000000-0000-4000-8000-000000000831", {
          kind: "issue-adopt",
          issueRef: FORGED_ISSUE_REF,
          mstar: completeIssueSubject(),
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.input-invalid" });
    // invariant: A replacement never re-keys the portable identity it resolves.
    await expect(
      prepareRemoteResolution(
        cache.context,
        conflictedId,
        resolution("00000000-0000-4000-8000-000000000832", {
          kind: "issue-replace",
          issueRef: SECOND_ISSUE_REF,
          mstar: completeIssueSubject(),
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.input-invalid" });
    // invariant: A merge that drops a branch's rows loses the history an operator reviewed.
    await expect(
      prepareRemoteResolution(
        cache.context,
        conflictedId,
        resolution("00000000-0000-4000-8000-000000000833", {
          kind: "issue-replace",
          issueRef: FORGED_ISSUE_REF,
          mstar: { ...completeIssueSubject(), occurrences: [] },
        }),
      ),
    ).rejects.toMatchObject({ code: "remote.operation-conflict", message: expect.stringContaining("occurrences") });
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
    // invariant: The same subject with every branch's history enqueues one reviewed repair.
    expect(
      await prepareRemoteResolution(
        cache.context,
        conflictedId,
        resolution("00000000-0000-4000-8000-000000000834", {
          kind: "issue-replace",
          issueRef: FORGED_ISSUE_REF,
          mstar: completeIssueSubject(),
        }),
      ),
    ).toMatchObject({ state: "enqueued" });
  }, 30_000);

  test("an outbox abandonment under a denied check discloses metadata only", async () => {
    const cache = await outboxCache("outbox-abandon-redaction");
    const first = "00000000-0000-4000-8000-000000000841";
    await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, first));
    expect(await abandonRemoteIntent(cache.context, { operationId: first, reason: "withdrawn" })).toMatchObject({
      disclosure: "full",
      state: "abandoned",
      target: JOURNAL_ANCHOR,
      event: expect.objectContaining({ operationId: first }),
    });

    const second = "00000000-0000-4000-8000-000000000842";
    await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, second));
    // note: A PUBLIC denial: the ingest clears the binding's writer in place, as a real revocation does.
    await expect(
      ingestRemoteObservation(cache.context, {
        ...observation(positiveCheck({ checkedAt: new Date().toISOString(), outcome: { kind: "denied" } }), {
          selectorCommit: cache.commit,
          generation: 3,
          expectRevision: observationRevision(cache.dbPath),
          snapshot: null,
        }),
      }),
    ).rejects.toMatchObject({ code: "remote.denied" });
    expect(bindingEvidence(cache.dbPath).writer_id).toBeNull();
    // invariant: A denial withholds the payload, never the row: inspection answers metadata instead
    // of refusing, so an operator can still see the state and recover it.
    expect(await readRemoteIntent(cache.context, second)).toMatchObject({
      disclosure: "metadata",
      state: "enqueued",
      event: null,
      target: null,
      result: null,
    });
    // invariant: A recorded denial never withholds the abandonment, but the retained business
    // payload never comes back through the command's response either.
    expect(await abandonRemoteIntent(cache.context, { operationId: second, reason: "withdrawn after denial" })).toMatchObject({
      disclosure: "metadata",
      state: "abandoned",
      target: null,
      event: null,
      result: null,
    });
    // invariant: The repeat refusal redacts the retained reason exactly as the response does.
    const repeat = await refusalOf(() => abandonRemoteIntent(cache.context, { operationId: second, reason: "withdrawn again" }));
    expect(repeat.code).toBe("remote.dispatch-refused");
    expect(repeat.message).toContain("already abandoned");
    expect(repeat.message).not.toContain("withdrawn after denial");
    expect(outboxRows(cache.dbPath).find((row) => row.operation_id === second)?.abandon_reason).toBe(
      "withdrawn after denial",
    );
  }, 30_000);

  test("a successor generation keeps predecessor outbox intents inspection-only", async () => {
    const cache = await outboxCache("outbox-successor-fence");
    const operationId = "00000000-0000-4000-8000-000000000851";
    const intent = await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, operationId));
    const committed = cache.commit;
    const successor = cache.fixture.publish(
      cache.fixture.payload({
        generation: 4,
        previous: { selectorCommit: committed, generation: 3, mode: "remote" },
        cutover: {
          operator: "operator-one",
          reviewedAt: "2026-11-21T00:00:00.000Z",
          sourceFenced: true,
          pendingOperationIds: [],
          verifiedTargetDigest: "a".repeat(64),
        },
      }),
    );
    await bindRemoteAuthority(cache.context, { version: 1, selectorCommit: successor, generation: 4, checks: [positiveCheck()] });

    // invariant: The predecessor's own still-current access check no longer authorizes disclosure:
    // the admitted selector does, and the row belongs to the generation it superseded.
    expect(await readRemoteIntent(cache.context, operationId)).toMatchObject({
      generation: 3,
      disclosure: "metadata",
      event: null,
      target: null,
      receipts: [],
    });
    // invariant: No recovery verb rewrites a predecessor row in the admitted lane.
    await expect(abandonRemoteIntent(cache.context, { operationId, reason: "withdrawn" })).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
    await expect(
      recordRemoteReceipt(
        cache.context,
        receiptInput(committed, operationId, "00000000-0000-4000-8000-0000000008fd", intent.requestHash, {
          kind: "unconfirmed",
          reason: "ambiguous",
        }),
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    await expect(
      prepareRemoteResolution(cache.context, operationId, {
        operationId: "00000000-0000-4000-8000-0000000008fe",
        operator: "operator-one",
        reason: "not this lane",
        event: journalEvent(cache.fixture, "00000000-0000-4000-8000-0000000008fe", ["1".repeat(64)]),
      }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    await expect(
      reconcileRemoteIntent(
        cache.context,
        receiptInput(committed, operationId, "00000000-0000-4000-8000-0000000008ff", intent.requestHash, {
          kind: "unconfirmed",
          reason: "no-response",
        }),
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(outboxStateOf(cache.dbPath, operationId)).toBe("enqueued");
  }, 30_000);

  test("an inspection samples one binding and a successor bound mid-read withholds the payload", async () => {
    const cache = await outboxCache("outbox-show-successor-gap");
    const operationId = "00000000-0000-4000-8000-000000000891";
    await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, operationId));
    const committed = cache.commit;
    // note: The successor becomes live AND bound BETWEEN the inspection's single sample and the
    // cache open, so the open admits a lane the checkout no longer records.
    let sampled = false;
    setRemoteIntentSampleGapForTest(async () => {
      if (sampled) return;
      sampled = true;
      const successor = cache.fixture.publish(
        cache.fixture.payload({
          generation: 4,
          previous: { selectorCommit: committed, generation: 3, mode: "remote" },
          cutover: {
            operator: "operator-one",
            reviewedAt: "2026-11-21T00:00:00.000Z",
            sourceFenced: true,
            pendingOperationIds: [],
            verifiedTargetDigest: "a".repeat(64),
          },
        }),
      );
      await bindRemoteAuthority(cache.context, { version: 1, selectorCommit: successor, generation: 4, checks: [positiveCheck()] });
    });
    try {
      // invariant: Disclosure follows the ONE pair the open admitted. A successor bound between that
      // sample and the open leaves the predecessor row inspectable, never its frozen payload.
      expect(await readRemoteIntent(cache.context, operationId)).toMatchObject({
        generation: 3,
        disclosure: "metadata",
        event: null,
        target: null,
        receipts: [],
      });
    } finally {
      setRemoteIntentSampleGapForTest(undefined);
    }
    expect(sampled).toBe(true);
  }, 30_000);

  test("an inspection withholds the payload when the origin publishes before the bind", async () => {
    const cache = await outboxCache("outbox-show-published-gap");
    const operationId = "00000000-0000-4000-8000-000000000892";
    await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, operationId));
    const committed = cache.commit;
    // note: The successor reaches the origin BETWEEN the inspection's single sample and the cache
    // open, but this checkout has not bound it yet, so only the live ref can tell.
    let sampled = false;
    setRemoteIntentSampleGapForTest(() => {
      if (sampled) return;
      sampled = true;
      cache.fixture.publish(
        cache.fixture.payload({
          generation: 4,
          previous: { selectorCommit: committed, generation: 3, mode: "remote" },
          cutover: {
            operator: "operator-one",
            reviewedAt: "2026-11-21T00:00:00.000Z",
            sourceFenced: true,
            pendingOperationIds: [],
            verifiedTargetDigest: "a".repeat(64),
          },
        }),
      );
    });
    try {
      // invariant: The live selector is re-proved at the disclosure boundary. A published successor
      // the checkout has not bound yet is not the pair the row was authorized under, so the row
      // stays inspectable and its frozen content is withheld.
      expect(await readRemoteIntent(cache.context, operationId)).toMatchObject({
        generation: 3,
        disclosure: "metadata",
        event: null,
        target: null,
        receipts: [],
      });
    } finally {
      setRemoteIntentSampleGapForTest(undefined);
    }
    expect(sampled).toBe(true);
  }, 30_000);

  test("an unresolved outbox fork keeps counts closed across a complete refresh", async () => {
    const cache = await outboxCache("outbox-conflict-counts");
    const conflictedId = "00000000-0000-4000-8000-000000000861";
    const fork = await conflictedJournal(cache, conflictedId);
    // invariant: The durable fork invalidates the snapshot in the receipt transaction, so a
    // required rollup refuses instead of answering from a nominally complete base.
    await expect(
      (async () => remoteMilestones(await openRemoteReadView(cache.context), SELECTED_PROJECT.localProjectId))(),
    ).rejects.toMatchObject({ code: "remote.unavailable" });
    // invariant: Q1: a refresh of the SAME competing heads proves the rows, never that the fork
    // settled; counts stay closed until the live resolution chain confirms a terminal repair.
    await observeHead(cache, fork.heads);
    await expect(
      (async () => remoteMilestones(await openRemoteReadView(cache.context), SELECTED_PROJECT.localProjectId))(),
    ).rejects.toMatchObject({ code: "remote.unavailable", message: expect.stringContaining("remote.effect-conflict") });
    // note: Only a confirmed terminal repair on the merged observation reopens them.
    const resolutionId = "00000000-0000-4000-8000-000000000862";
    const resolution = await prepareRemoteResolution(cache.context, conflictedId, {
      operationId: resolutionId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(cache.fixture, resolutionId, fork.heads),
    });
    const attemptId = attemptOf(
      await dispatchRemoteIntent(cache.context, resolutionId, forkObservationFor(cache, conflictedId, fork.heads)),
    );
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, resolutionId, attemptId, resolution.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: "bbbbbbbb-cccc-4ddd-8eee-fffffffff8c1",
        event: journalEvent(cache.fixture, resolutionId, fork.heads),
      }),
    );
    // invariant: A confirmed repair is not a merge: a refresh that still carries the competing
    // heads proves the rows, never the fork, so counts stay closed.
    await observeHead(cache, fork.heads);
    await expect(
      (async () => remoteMilestones(await openRemoteReadView(cache.context), SELECTED_PROJECT.localProjectId))(),
    ).rejects.toMatchObject({ code: "remote.unavailable", message: expect.stringContaining("remote.effect-conflict") });
    // invariant: One current head that is none of the competing heads is the merge proof; counts reopen.
    await observeHead(cache, [remoteEventHead(recordedEvent(cache.dbPath, resolutionId))]);
    expect(remoteMilestones(await openRemoteReadView(cache.context), SELECTED_PROJECT.localProjectId).milestones).toHaveLength(1);
  }, 30_000);

  test("a stale outbox traversal never freezes a base or issues a permit", async () => {
    const cache = await outboxCache("outbox-stale-traversal");
    const operationId = "00000000-0000-4000-8000-000000000871";
    await prepareRemoteIntent(cache.context, journalIntent(cache.fixture, cache.commit, operationId));
    await ingestRemoteObservation(cache.context, {
      ...observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: observationRevision(cache.dbPath),
      }),
      snapshot: { ...completeSnapshot(), asOf: new Date(Date.now() - 10 * 60_000).toISOString() },
    });

    // invariant: A current access check over a traversal that began outside the window is not a base.
    await expect(dispatchRemoteIntent(cache.context, operationId)).rejects.toMatchObject({
      code: "remote.dispatch-refused",
      message: expect.stringContaining("freshness window"),
    });
    await expect(
      addMilestone(
        cache.context,
        { projectId: SELECTED_PROJECT.localProjectId, name: "Late delivery", effortSessions: null, ordinal: 2 },
        { operationId: "00000000-0000-4000-8000-000000000872", expectedStoreRevision: observationRevision(cache.dbPath) },
      ),
    ).rejects.toMatchObject({ code: "collaboration.observation-stale" });
  }, 30_000);

  test("a confirmed outbox adoption replays after the provider marks the issue", async () => {
    const cache = await outboxCache("outbox-adopt-replay");
    const operationId = "00000000-0000-4000-8000-000000000881";
    const capture = fixtureCapture("Adopted remote finding");
    // note: An adoption derives the project and title from the verified native issue.
    delete capture.projectId;
    delete capture.title;
    const adoption = { version: 1, kind: "new" as const, capture };
    const request = {
      projectId: SELECTED_PROJECT.localProjectId,
      issueId: PROVIDER_ONLY_ISSUE,
      operationId,
      adoption,
    };
    expect(await prepareRemoteAdoption(cache.context, request)).toMatchObject({
      state: "enqueued",
      target: PROVIDER_ONLY_ISSUE,
    });
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, operationId));
    const queued = await readRemoteIntent(cache.context, operationId);
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, operationId, attemptId, queued.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: PROVIDER_ONLY_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeef09",
        event: frozenOperation(cache.dbPath, operationId).event as RemoteEvent,
      }),
    );

    // note: The provider now shows the marker the adoption wrote; the confirmation also
    // invalidated the read base, so a retried verb first meets a refreshed observation.
    const marked = completeSnapshot();
    await ingestRemoteObservation(cache.context, {
      ...observation(positiveCheck(), {
        selectorCommit: cache.commit,
        generation: 3,
        expectRevision: observationRevision(cache.dbPath),
      }),
      snapshot: {
        ...marked,
        issues: marked.issues.map((issue) =>
          issue.identity.issueId === PROVIDER_ONLY_ISSUE
            ? { ...issue, mstar: { ...marked.issues[0]!.mstar!, issueRef: issueRefForOperation(operationId), head: ["a".repeat(64)] } }
            : issue,
        ),
      },
    });

    // invariant: The identical adoption replays its recorded operation instead of addressing the
    // issue its own first freeze marked.
    expect(await prepareRemoteAdoption(cache.context, request)).toMatchObject({
      operationId,
      state: "confirmed",
      replayed: true,
      target: PROVIDER_ONLY_ISSUE,
    });
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
  }, 30_000);

  test("a confirmed remote composite keeps its components when the acknowledgement fails", async () => {
    const cache = await outboxCache("composite-ack-failure");
    (await initializeStore(cache.context)).close();
    const state = await readExecutionState(cache.context);
    const key = { executionStoreId: state.storeId, executionEpoch: state.epoch, operationId: "composite-ack-failure" };
    const intent: CompositeIntent = {
      key,
      kind: "residual-add",
      requestHash: "composite-ack-failure-hash",
      target: { repoKey: cache.fixture.repoKey, mode: "remote", storeId: state.storeId, epoch: state.epoch },
      scope: { workflowId: null, planId: null },
      actor: "project-manager",
      expectedExecution: state.token,
      frozenPayload: JSON.stringify({ entries: 1 }),
    };
    await withExecutionTransaction(cache.context, (tx) =>
      reserveCompositeIntent(tx, intent, { revision: tx.execution.revision }),
    );
    const operationId = "00000000-0000-4000-8000-000000000891";
    await prepareRemoteIntent(cache.context, issueIntent(cache.fixture, cache.commit, operationId));
    await confirmIntent(cache, operationId, MSTAR_ISSUE);

    const effects = {
      apply: () => {
        throw new Error("a remote composite never writes the local collaboration lane");
      },
      finalize: (): string => {
        throw new Error("the execution writer lock was unavailable");
      },
      remote: async (context: StoreContext) =>
        prepareRemoteIntent(context, issueIntent(cache.fixture, cache.commit, operationId)),
    };
    // invariant: The execution failure never hides the durable provider effect or its replay path.
    const refused = await refusalOf(() => runCollaborationComposite(cache.context, intent, effects));
    expect(refused.code).toBe("collaboration.operation-partial");
    expect(detailsOf(refused)).toMatchObject({
      phase: "collaboration-confirmed",
      confirmed_components: [`provider:${operationId}`],
    });
    // invariant: The retry acknowledges only the execution delta; the provider permit is not reissued.
    expect(
      await runCollaborationComposite(cache.context, intent, { ...effects, finalize: (_tx, receipt) => receipt.facts }),
    ).toContain(operationId);
    expect(await intentPhases(cache.context, key.operationId)).toEqual(["confirmed"]);
  }, 30_000);

  test("a remote milestone write refuses a base another observation moved", async () => {
    const cache = await outboxCache("outbox-milestone-base");
    const observed = observationRevision(cache.dbPath);
    await reobserve(cache, observed);
    // invariant: The caller's observed base is proved inside the freeze transaction, so a moved
    // base refuses instead of silently superseding the newer document.
    const stale = await refusalOf(() =>
      addMilestone(
        cache.context,
        { projectId: SELECTED_PROJECT.localProjectId, name: "Stale delivery", effortSessions: null, ordinal: 2 },
        { operationId: "00000000-0000-4000-8000-0000000008a1", expectedStoreRevision: observed },
      ),
    );
    expect(stale.code).toBe("milestone.revision-conflict");
    // invariant: The recovery names the observation revision this write was judged against, the
    // command that reads the current one, and the flag it belongs in - not the local store's listing.
    expect(String(stale.message)).toContain("mstar store collaboration remote status --harness <abs>");
    expect(String(stale.message)).toContain(`--project ${SELECTED_PROJECT.localProjectId}`);
    expect(String(stale.message)).toContain("--expect-store");
    expect(outboxRows(cache.dbPath)).toEqual([]);
    // invariant: The reviewed, current base still freezes exactly one intent.
    await expect(
      addMilestone(
        cache.context,
        { projectId: SELECTED_PROJECT.localProjectId, name: "Fresh delivery", effortSessions: null, ordinal: 2 },
        { operationId: "00000000-0000-4000-8000-0000000008a2", expectedStoreRevision: observationRevision(cache.dbPath) },
      ),
    ).rejects.toMatchObject({ code: "remote.effect-pending" });
    expect(outboxRows(cache.dbPath)).toHaveLength(1);
  }, 30_000);

  test("an unreadable remote candidate never proves an issue absent", async () => {
    const fixture = remoteFixture("outbox-availability");
    const commit = fixture.publish(fixture.payload({ projects: [SELECTED_PROJECT, SECOND_PROJECT] }));
    const context = contextAt(fixture.repo);
    const secondCheck = positiveCheck({
      projectId: SECOND_PROJECT.localProjectId,
      scope: providerScope(SECOND_PROJECT),
      journalIssueId: SECOND_PROJECT.journalIssueId,
    });
    await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: commit,
      generation: 3,
      checks: [positiveCheck(), secondCheck],
    });
    await ingestRemoteObservation(context, observation(positiveCheck(), { selectorCommit: commit, generation: 3 }));
    const addressed = "mstar:issue:dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const close = (operationId: string) =>
      closeIssue(
        context,
        addressed,
        "resolved",
        { reason: "fixed", references: ["review-fixture"], alignmentRef: "qa-gate:accepted" },
        { operationId, actor: "project-manager", expectedRevision: 1 },
      );

    // invariant: The second project holds no observation, so its state is unknown, never empty.
    await expect(close("00000000-0000-4000-8000-0000000008b1")).rejects.toMatchObject({ code: "remote.unavailable" });
    await ingestRemoteObservation(
      context,
      observation(secondCheck, {
        selectorCommit: commit,
        generation: 3,
        snapshot: { ...completeSnapshot(secondCheck), issues: [] },
      }),
    );
    // invariant: With every candidate complete and current, the same lookup is a proven miss.
    await expect(close("00000000-0000-4000-8000-0000000008b2")).rejects.toMatchObject({ code: "issue.not-found" });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// note: A pre-v3 remote cache is derived observation state: the reviewed bind replaces it
// ---------------------------------------------------------------------------

// note: writeV3Lane / writeV3RemoteLane are defined once near the ladder fixtures above.

/**
 * note: Rewrite the live cache back to its v3 generation while keeping its whole outbox ledger and
 * binding rows. This is the shape the replacement floor must handle: a v3 cache whose settled
 * evidence a prepared composite still needs.
 */
function downgradeToV3(location: CollaborationLocation): void {
  const rows = outboxRows(location.dbPath).map((row) => ({ ...row }));
  const receipts = outboxReceipts(location.dbPath).map((row) => ({ ...row }));
  const meta = metaRecord(location.dbPath);
  const db = new DatabaseSync(location.dbPath);
  let binding: Record<string, string | number>;
  try {
    const row = db
      .prepare(
        "select generation, project_key, selector_commit, provider, workspace_id, team_id, provider_project_id, " +
          "journal_issue_id, verified_at, verification_json from remote_bindings order by project_key limit 1",
      )
      .get() as Record<string, string | number> | undefined;
    if (row === undefined) throw new Error("the fixture cache records no binding to preserve");
    binding = row;
  } finally {
    db.close();
  }
  // note: A fresh generation is built, so the previous image and its sidecars go first.
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${location.dbPath}${suffix}`, { force: true });
  writeV3Lane(location);
  const seeded = new DatabaseSync(location.dbPath);
  try {
    // note: The replacement proves the lane is this checkout's own generation, so the downgrade
    // restores the very mode and store identity the checkout bound to.
    seeded
      .prepare(
        "update collaboration_meta set mode = ?, store_id = ?, authority_epoch = ?, authority_state = 'active' where id = 1",
      )
      .run(meta.mode, meta.store_id, meta.authority_epoch);
    seeded
      .prepare(
        "insert into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
          "provider_project_id, journal_issue_id, verified_at, verification_json) values (?, ?, ?, 'linear', ?, ?, ?, ?, ?, ?)",
      )
      .run(
        binding.generation,
        binding.project_key,
        binding.selector_commit,
        binding.workspace_id,
        binding.team_id,
        binding.provider_project_id,
        binding.journal_issue_id,
        binding.verified_at,
        binding.verification_json,
      );
    // note: A fork and its repair cite each other in either row order, so the fixture defers those
    // foreign keys to the end of its own copy transaction, exactly as a real replacement does.
    seeded.exec("begin immediate");
    seeded.exec("pragma defer_foreign_keys = ON");
    const insertIntent = seeded.prepare(
      "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, execution_key_json, " +
        "state, attempt_id, created_at, updated_at, abandon_reason, resolves, resolved_by) " +
        "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insertIntent.run(
        row.operation_id,
        binding.generation,
        binding.project_key,
        row.request_hash,
        row.request_json,
        row.execution_key_json,
        row.state,
        row.attempt_id,
        "2026-11-21T00:00:00.000Z",
        "2026-11-21T00:00:00.000Z",
        row.abandon_reason,
        row.resolves,
        row.resolved_by,
      );
    }
    const insertReceipt = seeded.prepare(
      "insert into remote_outbox_receipts(operation_id, receipt_hash, source, outcome, evidence_json, recorded_at) " +
        "values (?, ?, ?, ?, ?, ?)",
    );
    for (const row of receipts) {
      insertReceipt.run(row.operation_id, row.receipt_hash, row.source, row.outcome, row.evidence_json, row.recorded_at);
    }
    seeded.exec("commit");
  } finally {
    seeded.close();
  }
}

/**
 * note: Rewind the live cache's version ledger to v5, keeping every table row - outbox, receipts,
 * bindings and the move ledger - exactly as the v6 writers left it. The replacement decision reads
 * its generation from this ledger, so this is the pre-v6 shape a bind must replace without losing
 * the switched move rows.
 */
function downgradeToV5(location: CollaborationLocation): void {
  const db = new DatabaseSync(location.dbPath);
  try {
    db.exec("begin immediate");
    db.prepare("delete from schema_version where version = ?").run(6);
    db.exec("commit");
  } finally {
    db.close();
  }
}

/**
 * note: Rewind the live cache's version ledger to v4 AND its move ledger to the v4 shape: the
 * route column is dropped, so the rows are exactly the pre-route halves a v4 writer recorded.
 * The replacement decision reads its generation from this ledger, so this is the pre-v5 shape
 * a bind must carry WITHOUT leaving the successor's column default on the rows.
 */
function downgradeToV4(location: CollaborationLocation): void {
  const db = new DatabaseSync(location.dbPath);
  try {
    db.exec("begin immediate");
    db.prepare("delete from schema_version where version in (?, ?)").run(5, 6);
    db.exec("alter table issue_moves drop column route");
    db.exec("commit");
  } finally {
    db.close();
  }
}

/** note: The route one ledger half recorded, read straight from the lane. */
function routeOfRow(dbPath: string, operationId: string, role: "source" | "destination"): unknown {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("select route from issue_moves where operation_id = ? and role = ?").get(operationId, role)?.route;
  } finally {
    db.close();
  }
}

/**
 * note: Confirm one seeded v3 outbox row in place: a receipt row plus the `confirmed` state, exactly
 * the shape a real send leaves. Used where the lane was rewritten to v3 and its ids must stay.
 */
function confirmSeededIntent(
  dbPath: string,
  operationId: string,
  evidence: Readonly<{
    attemptId: string;
    requestHash: string;
    issueId: string;
    recordId: string;
    event: RemoteEvent;
  }>,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("select generation, project_key from remote_outbox where operation_id = ?")
      .get(operationId) as { generation?: unknown; project_key?: unknown } | undefined;
    if (typeof row?.generation !== "number" || typeof row.project_key !== "string") {
      throw new Error(`the seeded outbox row ${operationId} is missing`);
    }
    const binding = db
      .prepare("select selector_commit from remote_bindings where generation = ? and project_key = ?")
      .get(row.generation, row.project_key) as { selector_commit?: unknown } | undefined;
    if (typeof binding?.selector_commit !== "string") {
      throw new Error(`the seeded lane records no binding for ${operationId}`);
    }
    db.prepare("update remote_outbox set state = 'confirmed', attempt_id = ? where operation_id = ?").run(
      evidence.attemptId,
      operationId,
    );
    db.prepare(
      "insert into remote_outbox_receipts(operation_id, receipt_hash, source, outcome, evidence_json, recorded_at) " +
        "values (?, ?, 'receipt', 'confirmed', ?, ?)",
    ).run(
      operationId,
      "e".repeat(64),
      JSON.stringify({
        attemptId: evidence.attemptId,
        generation: row.generation,
        observedAt: new Date().toISOString(),
        operationId,
        outcome: {
          kind: "confirmed",
          identity: { ...providerScope(), issueId: evidence.issueId },
          recordId: evidence.recordId,
          event: evidence.event,
        },
        projectId: row.project_key,
        requestHash: evidence.requestHash,
        selectorCommit: binding.selector_commit,
        source: "receipt",
      }),
      "2026-11-21T00:00:02.000Z",
    );
  } finally {
    db.close();
  }
}

/** note: A real pre-v3 REMOTE cache: `remote` exists only since v2, so this is the oldest remote shape. */
function writeV2RemoteLane(location: CollaborationLocation): void {
  writeV2Lane(location);
  const db = new DatabaseSync(location.dbPath);
  try {
    db.prepare("update collaboration_meta set mode = 'remote' where id = 1").run();
  } finally {
    db.close();
  }
  chmodSync(location.dbPath, 0o600);
}

describe("remote move fence", () => {
  /** note: One blocking source row in the remote cache, the fence every provider write must meet. */
  async function stagedMoveRow(context: StoreContext, issueRef: string, operationId: string): Promise<void> {
    await withRemoteCacheWrite(context, (handle) => {
      recordIssueMove(handle.db, {
        operationId,
        role: "source",
        route: "remote-unknown",
        requestHash: "request-hash",
        issueRef,
        sourceIssueId: null,
        destinationIssueId: null,
        sourceAuthority: "github.com/remote-fixture/elsewhere",
        destinationAuthority: "github.com/local-fixture/destination",
        destinationProject: "fixture-project",
        actor: "project-manager",
        reason: "fence fixture",
        phase: "staged",
        payloadJson: "{}",
        payloadDigest: "digest",
        stagedCounts: "{}",
        sourceStoreId: "store-one",
        sourceEpoch: 1,
        removedSyncRows: 0,
      });
    });
  }

  test("a provider-id-addressed replacement meets the fence a reference-addressed one meets", async () => {
    const cache = await outboxCache("fence-provider-id");
    const actor = "project-manager";
    await stagedMoveRow(cache.context, FORGED_ISSUE_REF, "fence-provider-id");
    // invariant: The write below addresses the record by its PROVIDER id, so the replay identity carries
    // no reference to compare. The fence resolves the reference from the OBSERVED subject instead, which
    // is the only address both shapes share: a provider-id write cannot slip past it.
    await expect(
      appendOccurrence(
        cache.context,
        MSTAR_ISSUE,
        {
          sourceIdentity: "review:fixture",
          rootCauseKey: "remote.observation",
          acceptanceKey: "remote.observation.stored",
          occurrenceKey: "occurrence-under-fence",
          sourceKind: "review",
          location: "packages/engine/src/collaboration-store.test.ts",
          observedBehavior: "A write addressed the frozen record by provider id.",
          evidence: [],
          discoveredAt: "2026-11-20T00:00:00.000Z",
        },
        { operationId: "00000000-0000-4000-8000-000000000901", actor, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({
      code: "issue.move-in-progress",
      details: expect.objectContaining({ issue_ref: FORGED_ISSUE_REF, operation_id: "fence-provider-id", phase: "staged" }),
    });
    // invariant: Nothing was enqueued: the refusal is the fence, not a frozen intent that failed later.
    expect(outboxRows(cache.dbPath)).toEqual([]);
  }, 30_000);

  test("remote-to-remote is decided by the destination lane's recorded mode, not by a file's presence", async () => {
    // invariant: A destination addressed by `repoKey` resolves the SAME database path in every mode, so
    // "the file exists" says nothing about which mode that lane records. The refusal must read the mode.
    const cache = await outboxCache("fence-destination-mode");
    const localKey = `github.com/remote-fixture/move-destination-${sequence++}`;
    const localLane = collaborationLocationOfRepoKey(localKey, "local");
    mkdirSync(join(localLane.dbPath, ".."), { recursive: true, mode: 0o700 });
    await initializeCollaborationStore(localLane);
    const request = {
      operationId: "00000000-0000-4000-8000-000000000921",
      actor: "project-manager",
      sourceIssueId: FORGED_ISSUE_REF,
      destinationAuthority: localKey,
      destinationProject: "fixture-project",
      reason: "move to a local lane",
    };
    // invariant: An existing LOCAL destination lane is not a remote one, so the first step stages and
    // emits its request document instead of being refused as remote-to-remote.
    const staged = await moveAcrossByDocument(cache.context, request, null);
    expect(staged).toMatchObject({ phase: "staged", side: "source", destinationAuthority: localKey });
    expect(staged.document).toMatchObject({ phase: "request", destinationAuthority: localKey });

    // note: The same destination key now RECORDS remote collaboration, which is the only fact that
    // makes the pair remote-to-remote; the refusal names it.
    const remoteKey = `github.com/remote-fixture/move-remote-destination-${sequence++}`;
    const remoteLane = collaborationLocationOfRepoKey(remoteKey, "remote");
    mkdirSync(join(remoteLane.dbPath, ".."), { recursive: true, mode: 0o700 });
    await initializeRemoteCacheStore(remoteLane);
    const refused = await refusalOf(() =>
      moveAcrossByDocument(cache.context, { ...request, operationId: "00000000-0000-4000-8000-000000000922", destinationAuthority: remoteKey }, null),
    );
    expect(refused.code).toBe("collaboration.mode-unavailable");
    expect(refused.details).toMatchObject({ repoKey: remoteKey });
  }, 30_000);

  test("the fence is read inside the freeze transaction, not before it", async () => {
    const cache = await outboxCache("fence-inside-freeze");
    const actor = "project-manager";
    // note: The move is staged in the seam between the write's observation and its freeze, exactly the
    // window a fence checked outside the transaction cannot see.
    let staged = false;
    setRemoteWriteScopeGapForTest(async () => {
      if (staged) return;
      staged = true;
      setRemoteWriteScopeGapForTest(undefined);
      await stagedMoveRow(cache.context, FORGED_ISSUE_REF, "fence-race");
    });
    await expect(
      appendOccurrence(
        cache.context,
        FORGED_ISSUE_REF,
        {
          sourceIdentity: "review:fixture",
          rootCauseKey: "remote.observation",
          acceptanceKey: "remote.observation.stored",
          occurrenceKey: "occurrence-racing-fence",
          sourceKind: "review",
          location: "packages/engine/src/collaboration-store.test.ts",
          observedBehavior: "A move was staged while this write was admitted.",
          evidence: [],
          discoveredAt: "2026-11-20T00:00:00.000Z",
        },
        { operationId: "00000000-0000-4000-8000-000000000902", actor, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "issue.move-in-progress" });
    expect(outboxRows(cache.dbPath)).toEqual([]);
  }, 30_000);
});

describe("remote move conflict settlement", () => {
  // note: The reviewed-fork fixture for one move tombstone: the tombstone intent is frozen, sent,
  // answered with a competing fork and left `conflict`, then `outbox-resolve` freezes the reviewed
  // repair linked through `resolved_by`.
  async function conflictedTombstone(cache: { commit: string; context: StoreContext; dbPath: string }, operationId: string): Promise<{
    heads: string[];
    tombstoneId: string;
  }> {
    const tombstoneId = remoteMoveOperationId(operationId, "obsolete");
    const intent = await readRemoteIntent(cache.context, tombstoneId);
    const attemptId = attemptOf(await dispatchRemoteIntent(cache.context, tombstoneId));
    const frozen = recordedEvent(cache.dbPath, tombstoneId);
    const competing = [
      {
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01",
        event: { ...frozen, operationId: "00000000-0000-4000-8000-00000000aaaa", parents: ["8".repeat(64)] },
      },
    ];
    const heads = competing.map((record) => remoteEventHead(record.event as RemoteEvent)).sort();
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, tombstoneId, attemptId, intent.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_ISSUE_HEAD],
        observedHeads: heads,
        observedRecords: competing,
      }),
    );
    return { heads, tombstoneId };
  }

  /**
   * note: One exchange whose tombstone fork a reviewed repair settles, so the switch document the
   * source emits is the repaired subject. The repair transform receives the frozen subject and
   * returns the confirmed one, which is how each carry test states exactly one difference.
   */
  async function switchThroughRepair(
    name: string,
    operationId: string,
    repair: (mstar: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<{
    switched: Awaited<ReturnType<typeof moveAcrossByDocument>>;
    destinationContext: StoreContext;
    request: Parameters<typeof moveAcrossByDocument>[1];
    cache: Awaited<ReturnType<typeof outboxCache>>;
  }> {
    const cache = await outboxCache(name);
    const destinationKey = `github.com/remote-fixture/${name}-destination-${sequence++}`;
    const request = {
      operationId,
      actor: "project-manager",
      sourceIssueId: FORGED_ISSUE_REF,
      destinationAuthority: destinationKey,
      destinationProject: "fixture-project",
      reason: "move to a local lane",
    };
    const destinationContext = contextAt(makeRepo(`https://${destinationKey}.git`));
    await initializeCollaborationStore(resolveCollaborationLocation(destinationContext));
    activate(resolveCollaborationLocation(destinationContext).dbPath);
    const staged = await moveAcrossByDocument(cache.context, request, null);
    const destinationStaged = await moveAcrossByDocument(destinationContext, request, staged.document!);
    const stagedDoc = destinationStaged.document!;
    // note: The first switch enqueues the tombstone; the fork below replaces it with a reviewed repair.
    await moveAcrossByDocument(cache.context, request, stagedDoc).then(
      () => null,
      (error: unknown) => error,
    );
    const { heads, tombstoneId } = await conflictedTombstone(cache, operationId);
    const frozen = recordedEvent(cache.dbPath, tombstoneId);
    if (frozen.change.kind !== "issue-replace") throw new Error("the fixture expected the tombstone to freeze an issue-replace");
    const repairId = "00000000-0000-4000-8000-000000000b01";
    const mstar = repair({ ...(frozen.change.mstar as Record<string, unknown>) });
    await prepareRemoteResolution(cache.context, tombstoneId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "settle the fork",
      event: { ...frozen, operationId: repairId, parents: heads, change: { ...frozen.change, mstar } },
    });
    const repairAttempt = attemptOf(
      await dispatchRemoteIntent(cache.context, repairId, forkObservationFor(cache, tombstoneId, heads)),
    );
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, repairId, repairAttempt, (await readRemoteIntent(cache.context, repairId)).requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02",
        event: recordedEvent(cache.dbPath, repairId),
      }),
    );
    return { switched: await moveAcrossByDocument(cache.context, request, stagedDoc), destinationContext, request, cache };
  }

  test("a repair that interleaves its rows still switches: the carried copy is a set-preserving extension", async () => {
    // invariant: Finding 6. A reviewed repair may place its rows before the staged history, because
    // the confirmed event is an extension of the record, not of a list position. The handoff gate
    // proves every staged row SURVIVES — order is not part of that proof.
    const prepended = {
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1",
      occurrenceKey: "occ-prepended",
      sourceKind: "test",
      sourceIdentity: "review:fixture",
      rootCauseKey: "remote.observation",
      acceptanceKey: "remote.observation.stored",
      location: "packages/engine/src/collaboration-store.test.ts",
      observedBehavior: "the repair wrote this row before the staged history",
      evidence: [],
      discoveredAt: "2026-11-22T00:00:00.000Z",
      recordedAt: "2026-11-22T00:00:00.000Z",
      imported: false,
    };
    const { switched, destinationContext, request } = await switchThroughRepair(
      "move-carry-set",
      "00000000-0000-4000-8000-000000000b11",
      (mstar) => ({ ...mstar, occurrences: [prepended, ...(mstar.occurrences as unknown[])] }),
    );
    expect(switched.phase).toBe("switched");
    const carried = JSON.parse(switched.document!.payloadJson) as { occurrences: Array<{ occurrence_key: string }> };
    expect(carried.occurrences.map((row) => row.occurrence_key)).toEqual(["occ-prepended", "occurrence-one"]);
    // invariant: the DESTINATION accepts the interleaved copy and admits both rows — the gate every
    // handoff crosses after a repair, not just the document the source emitted.
    const admitted = await moveAcrossByDocument(destinationContext, request, switched.document!);
    expect(admitted.phase).toBe("switched");
    const admittedDb = new DatabaseSync(resolveCollaborationLocation(destinationContext).dbPath);
    try {
      expect(
        admittedDb.prepare("select occurrence_key from occurrences order by occurrence_key").all(),
      ).toEqual([{ occurrence_key: "occ-prepended" }, { occurrence_key: "occurrence-one" }]);
    } finally {
      admittedDb.close();
    }
  }, 30_000);

  test("a remote bind replacement carries the switched move ledger, and the admission handoff still completes", async () => {
    // invariant: Review wave 3, item 1. `replaceDerivedLane` carried the settled outbox ledger but
    // not `issue_moves`, so a bind that replaced the cache erased the switched source row - the only
    // record the final admission handoff settles against.
    const { switched, destinationContext, request, cache } = await switchThroughRepair(
      "move-carry-replace",
      "00000000-0000-4000-8000-000000000b41",
      (mstar) => mstar,
    );
    expect(switched.phase).toBe("switched");
    const location = locationAt(cache.fixture.repo);
    const moveRows = (dbPath: string) => {
      const db = new DatabaseSync(dbPath);
      try {
        return db.prepare("select * from issue_moves order by operation_id, role").all();
      } finally {
        db.close();
      }
    };
    const before = moveRows(location.dbPath);
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((row) => (row as { phase: string }).phase === "switched")).toBe(true);
    // note: the downgrade rewinds the version ledger only: the replacement reads its decision from
    // that ledger, the meta identity and the settled outbox probe, never from a v6-only DDL.
    downgradeToV5(location);
    const bound = await bindRemoteAuthority(cache.context, {
      version: 1,
      selectorCommit: cache.commit,
      generation: Number(cache.fixture.payload().generation),
      checks: [positiveCheck()],
    });
    expect(bound).toMatchObject({ generation: Number(cache.fixture.payload().generation) });
    expect(ledgerVersions(location.dbPath)).toEqual(LANE_LEDGER_VERSIONS);
    // invariant: every move row came through field by field, not as a count.
    expect(moveRows(location.dbPath)).toEqual(before);
    // invariant: the destination's admission handoff is the step the dropped row used to refuse.
    const admitted = await moveAcrossByDocument(destinationContext, request, switched.document!);
    expect(admitted.phase).toBe("switched");
    const published = await moveAcrossByDocument(cache.context, request, admitted.document!);
    expect(published.phase).toBe("published");
  }, 30_000);

  test("a staged move with no outbox intent survives the replacement field-identically", async () => {
    // invariant: Review finding — a remote source records its staged move BEFORE any outbox intent
    // exists, so a legitimate pre-v6 cache can hold a move row and zero intents. The replacement must
    // invoke the carrier when EITHER collection has rows; the move-only cache is the shape an
    // intents-only guard drops.
    const cache = await outboxCache("move-carry-no-intents");
    const operationId = "00000000-0000-4000-8000-000000000b51";
    const staged = await moveAcrossByDocument(cache.context, {
      operationId,
      actor: "project-manager",
      sourceIssueId: FORGED_ISSUE_REF,
      destinationAuthority: "github.com/remote-fixture/move-carry-no-intents-destination",
      destinationProject: "fixture-project",
      reason: "move to a local lane",
    }, null);
    expect(staged.phase).toBe("staged");
    const location = locationAt(cache.fixture.repo);
    const rows = (dbPath: string) => {
      const db = new DatabaseSync(dbPath);
      try {
        return db.prepare("select * from issue_moves order by operation_id, role").all();
      } finally {
        db.close();
      }
    };
    const before = rows(location.dbPath);
    expect(before).toHaveLength(1);
    expect(outboxRows(location.dbPath)).toHaveLength(0);
    downgradeToV5(location);
    const bound = await bindRemoteAuthority(cache.context, {
      version: 1,
      selectorCommit: cache.commit,
      generation: Number(cache.fixture.payload().generation),
      checks: [positiveCheck()],
    });
    expect(bound).toMatchObject({ generation: Number(cache.fixture.payload().generation) });
    expect(ledgerVersions(location.dbPath)).toEqual(LANE_LEDGER_VERSIONS);
    // invariant: the move row came through field by field, even though not one intent row exists.
    expect(rows(location.dbPath)).toEqual(before);
  }, 30_000);

  test("a v4 remote predecessor's carried source row is labelled remote-unknown, so its discard releases", async () => {
    // invariant: Review finding — a pre-v5 predecessor has no `route` column, so the carried row
    // must be labelled by the generation's own v5 rule from the row's role and the PREDECESSOR's
    // mode, never by the successor's column default. A remote source half labelled the default
    // `local-local` would read as one-checkout-local and the discard would refuse to release it.
    const cache = await outboxCache("move-carry-v4-remote");
    const operationId = "00000000-0000-4000-8000-000000000b61";
    const request = {
      operationId,
      actor: "project-manager",
      sourceIssueId: FORGED_ISSUE_REF,
      destinationAuthority: "github.com/remote-fixture/move-carry-v4-remote-destination",
      destinationProject: "fixture-project",
      reason: "move to a local lane",
    };
    const staged = await moveAcrossByDocument(cache.context, request, null);
    expect(staged.phase).toBe("staged");
    const location = locationAt(cache.fixture.repo);
    downgradeToV4(location);
    expect(ledgerVersions(location.dbPath)).toEqual([1, 2, 3, 4]);

    const bound = await bindRemoteAuthority(cache.context, {
      version: 1,
      selectorCommit: cache.commit,
      generation: Number(cache.fixture.payload().generation),
      checks: [positiveCheck()],
    });
    expect(bound).toMatchObject({ generation: Number(cache.fixture.payload().generation) });
    expect(ledgerVersions(location.dbPath)).toEqual(LANE_LEDGER_VERSIONS);
    // invariant: the carried source row is the exchange half the predecessor's OWN remote mode
    // names — never the one-checkout default the successor's column would have minted.
    expect(routeOfRow(location.dbPath, operationId, "source")).toBe("remote-unknown");

    // invariant: the label is the discard's own admission check: the move releases its half
    // instead of refusing as a one-checkout move it never was.
    const released = await discardAcrossAuthorities(cache.context, request);
    expect(released.phase).toBe("discarded");
    const db = new DatabaseSync(location.dbPath);
    try {
      expect(db.prepare("select phase from issue_moves where operation_id = ?").get(operationId)).toEqual({
        phase: "discarded",
      });
    } finally {
      db.close();
    }
  }, 30_000);

  test("the carry rule labels a local-mode predecessor's source half local-remote", () => {
    // invariant: The carrier reads the PREDECESSOR's own mode rather than assuming 'remote'.
    // The replacement probe admits only a lane whose metadata mode equals the checkout's remote
    // selection, so the local branch never fires in the remote bind flow - it is the rule's
    // correctness property, verified here against the same function the carrier invokes, and it
    // is exactly the derivation the v5 ladder SQL applies to an in-place lane of that mode.
    expect(unroutedMoveHalfRoute("source", "local")).toBe("local-remote");
    expect(unroutedMoveHalfRoute("source", "mirror")).toBe("local-remote");
    expect(unroutedMoveHalfRoute("source", "remote")).toBe("remote-unknown");
    expect(unroutedMoveHalfRoute("destination", "local")).toBe("remote-local");
    expect(unroutedMoveHalfRoute("destination", "remote")).toBe("local-remote");
  });

  test("a predecessor whose ledger already records the route column is carried unchanged", async () => {
    // invariant: A v5-or-later predecessor declares the column, so the carry copies it
    // positionally and NEVER recomputes it — the relabel is the pre-route generation's alone.
    const cache = await outboxCache("move-carry-v5-routed");
    const operationId = "00000000-0000-4000-8000-000000000b62";
    const staged = await moveAcrossByDocument(cache.context, {
      operationId,
      actor: "project-manager",
      sourceIssueId: FORGED_ISSUE_REF,
      destinationAuthority: "github.com/remote-fixture/move-carry-v5-routed-destination",
      destinationProject: "fixture-project",
      reason: "move to a local lane",
    }, null);
    expect(staged.phase).toBe("staged");
    const location = locationAt(cache.fixture.repo);
    expect(routeOfRow(location.dbPath, operationId, "source")).toBe("remote-unknown");
    // note: a one-checkout `local-local` label is the one value the pre-route rule can never
    // derive for a remote-mode source row, so its survival proves no recomputation ran.
    const db = new DatabaseSync(location.dbPath);
    try {
      db.prepare("update issue_moves set route = 'local-local' where operation_id = ?").run(operationId);
    } finally {
      db.close();
    }
    downgradeToV5(location);
    const bound = await bindRemoteAuthority(cache.context, {
      version: 1,
      selectorCommit: cache.commit,
      generation: Number(cache.fixture.payload().generation),
      checks: [positiveCheck()],
    });
    expect(bound).toMatchObject({ generation: Number(cache.fixture.payload().generation) });
    expect(ledgerVersions(location.dbPath)).toEqual(LANE_LEDGER_VERSIONS);
    expect(routeOfRow(location.dbPath, operationId, "source")).toBe("local-local");
  }, 30_000);

  test("a move ledger that changes after the carried snapshot refuses the replacement and survives on the predecessor", async () => {
    // invariant: the re-read comparison must cover the move ledger like the outbox: a row that
    // advanced while the successor was staged aborts the swap instead of silently dropping it.
    const { switched, cache } = await switchThroughRepair(
      "move-carry-replace-guard",
      "00000000-0000-4000-8000-000000000b42",
      (mstar) => mstar,
    );
    expect(switched.phase).toBe("switched");
    const location = locationAt(cache.fixture.repo);
    downgradeToV5(location);
    let mutated = "no";
    setRemoteCacheReplacementLedgerGapForTest(() =>
      new Promise<void>((resolve) => {
        const db = new DatabaseSync(location.dbPath);
        try {
          db.prepare("update issue_moves set updated_at = '2026-11-25T00:00:00.000Z' where role = 'source'").run();
          mutated = "committed";
        } finally {
          db.close();
        }
        resolve();
      }),
    );
    let refused: { code: string };
    try {
      refused = await refusalOf(() =>
        bindRemoteAuthority(cache.context, {
          version: 1,
          selectorCommit: cache.commit,
          generation: Number(cache.fixture.payload().generation),
          checks: [positiveCheck()],
        }),
      );
    } finally {
      setRemoteCacheReplacementLedgerGapForTest(undefined);
    }
    expect(mutated).toBe("committed");
    expect(refused.code).toBe("collaboration.upgrade-required");
    // invariant: the predecessor kept its name, its v5 ledger and every move row.
    expect(ledgerVersions(location.dbPath)).toEqual(COLLABORATION_MIGRATIONS.slice(0, 5).map(({ version }) => version));
    const db = new DatabaseSync(location.dbPath);
    try {
      expect(db.prepare("select phase from issue_moves where role = 'source'").all()).toEqual([{ phase: "switched" }]);
    } finally {
      db.close();
    }
  }, 30_000);

  test("a repair's field edits cross into the admitted subject, and its tombstone write never does", async () => {
    // invariant: Finding 7. The confirmed subject's FIELDS are the record's current truth, so a
    // reviewed edit reaches the destination; the tombstone's own `obsolete`/closed write belongs to
    // the provider record leaving this authority and must not become the member's state.
    const { switched } = await switchThroughRepair("move-carry-fields", "00000000-0000-4000-8000-000000000b21", (mstar) => ({
      ...mstar,
      fields: {
        ...(mstar.fields as Record<string, unknown>),
        title: "Repaired title",
        disposition: "obsolete",
        closedAt: "2026-11-22T00:00:00.000Z",
        closureNote: "left this authority",
      },
    }));
    const carried = JSON.parse(switched.document!.payloadJson) as { issue: Record<string, unknown> };
    expect(carried.issue.title).toBe("Repaired title");
    expect(carried.issue.disposition).toBe("open");
    expect(carried.issue.closed_at).toBeNull();
    expect(carried.issue.closure_note).toBeNull();
  }, 30_000);

  test("an imported legacy record on a repaired row crosses to the destination", async () => {
    // invariant: Finding 8. A confirmed provider subject carries the imported row's PARSED legacy
    // record, not the observed JSON text; reading only `legacyJson` dropped the imported document on
    // every repaired move, stranding a record whose provenance the destination then never held.
    const { switched } = await switchThroughRepair("move-carry-legacy", "00000000-0000-4000-8000-000000000b31", (mstar) => ({
      ...mstar,
      provenance: [
        ...(mstar.provenance as unknown[]),
        {
          eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
          kind: "migration",
          target: "legacy-entry-2",
          sourceHash: "7".repeat(64),
          origin: "scoped",
          legacyProject: "legacy-project",
          legacyBucket: null,
          legacyEntryId: "legacy-entry-2",
          legacyRecord: { legacyId: "legacy-2", title: "Imported finding" },
          importedAt: "2026-11-22T00:00:00.000Z",
        },
      ],
    }));
    const carried = JSON.parse(switched.document!.payloadJson) as { provenance: Array<Record<string, unknown>> };
    const imported = carried.provenance.find((row) => row.legacy_entry_id === "legacy-entry-2");
    expect(JSON.parse(String(imported?.legacy_json))).toMatchObject({ legacyId: "legacy-2" });
  }, 30_000);

  test("a repaired tombstone closes the move and blocks discard, carrying the reviewed history", async () => {
    // invariant: Critical 2 (review wave 3) — a conflict is terminal for its own ROW only. Once a
    // reviewed repair confirms the same tombstone under a different operation id, the move completes
    // its switch through the `resolved_by` chain, and the discard refuses: the provider record is
    // already closing, so abandoning the move would strand it.
    // invariant: Critical 1 (review wave 4) — the subject the switch carries is the CONFIRMED one,
    // not the pre-conflict freeze: the repair's rows reach the destination copy it admits.
    const cache = await outboxCache("move-repair-obsolete");
    const operationId = "00000000-0000-4000-8000-000000000941";
    const destinationKey = `github.com/remote-fixture/move-destination-${sequence++}`;
    const request = {
      operationId,
      actor: "project-manager",
      sourceIssueId: FORGED_ISSUE_REF,
      destinationAuthority: destinationKey,
      destinationProject: "fixture-project",
      reason: "move to a local lane",
    };
    // note: A real local destination checkout bound to the same key, so the exchange halves meet
    // over the documents rather than a faked ledger row.
    const destinationContext = contextAt(makeRepo(`https://${destinationKey}.git`));
    await initializeCollaborationStore(resolveCollaborationLocation(destinationContext));
    activate(resolveCollaborationLocation(destinationContext).dbPath);
    const staged = await moveAcrossByDocument(cache.context, request, null);
    const doc = staged.document;
    expect(doc).not.toBeNull();
    // note: The destination half of the staged exchange: its row and `staged` document are written
    // in ITS lane from the real request document.
    const destinationStaged = await moveAcrossByDocument(destinationContext, request, staged.document!);
    expect(destinationStaged.phase).toBe("verified");
    const stagedDoc = destinationStaged.document;
    expect(stagedDoc?.phase).toBe("staged");

    const enqueued = await moveAcrossByDocument(cache.context, request, stagedDoc!).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(enqueued?.code).toBe("remote.effect-pending");

    const { heads, tombstoneId } = await conflictedTombstone(cache, operationId);
    const frozen = recordedEvent(cache.dbPath, tombstoneId);
    if (frozen.change.kind !== "issue-replace") throw new Error("the fixture expected the tombstone to freeze an issue-replace");
    const repairId = "00000000-0000-4000-8000-000000000942";
    // note: The reviewed resolution carries the record plus the rows the reviewer kept: one extra
    // occurrence and one extra provenance row over the freeze, so the carried copy is provably the
    // repair's subject rather than the request's.
    const repairMstar = {
      ...(frozen.change.mstar as Record<string, unknown>),
      occurrences: [
        ...(frozen.change.mstar.occurrences as unknown[]),
        {
          eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaad1",
          occurrenceKey: "occ-repaired",
          sourceKind: "test",
          sourceIdentity: "review/repair",
          rootCauseKey: "root-repair",
          acceptanceKey: "accept-repair",
          location: "packages/engine/src/collaboration-store.test.ts",
          observedBehavior: "The reviewed repair added this row.",
          evidence: [],
          discoveredAt: "2026-11-22T00:00:00.000Z",
          recordedAt: "2026-11-22T00:00:00.000Z",
          imported: false,
        },
      ],
      provenance: [
        ...(frozen.change.mstar.provenance as unknown[]),
        {
          eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbd1",
          kind: "plan",
          target: "repair-plan",
          sourceHash: "5".repeat(64),
          origin: "scoped",
          legacyProject: null,
          legacyBucket: null,
          legacyEntryId: null,
          legacyRecord: null,
          importedAt: null,
        },
      ],
    };
    await prepareRemoteResolution(cache.context, tombstoneId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "keep the tombstone",
      event: {
        ...frozen,
        operationId: repairId,
        parents: heads,
        change: { ...frozen.change, mstar: repairMstar },
      },
    });
    const repairAttempt = attemptOf(await dispatchRemoteIntent(cache.context, repairId, forkObservationFor(cache, tombstoneId, heads)));
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, repairId, repairAttempt, (await readRemoteIntent(cache.context, repairId)).requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02",
        event: recordedEvent(cache.dbPath, repairId),
      }),
    );

    // invariant: The repaired confirmation IS the tombstone this move needed: the same exchange
    // advances the source row to `switched` and emits the switch document under the repair's id.
    const switched = await moveAcrossByDocument(cache.context, request, stagedDoc!);
    expect(switched.phase).toBe("switched");
    expect(switched.pendingOperationId).toBe(repairId);
    // invariant: The switch document carries the CONFIRMED subject — the repair's added rows are in
    // its payload and counts, so the digest legitimately outgrew the staged freeze.
    const switchDoc = switched.document;
    expect(switchDoc?.phase).toBe("switch");
    expect(switchDoc?.payloadDigest).not.toBe(stagedDoc!.payloadDigest);
    const carriedCopy = JSON.parse(switchDoc!.payloadJson) as {
      occurrences: Array<{ occurrence_key: string }>;
      provenance: Array<Record<string, unknown>>;
      issue: Record<string, unknown>;
    };
    expect(carriedCopy.occurrences.length).toBe(2);
    expect(carriedCopy.occurrences.some((row) => row.occurrence_key === "occ-repaired")).toBe(true);
    expect(carriedCopy.provenance.length).toBe(2);
    expect(carriedCopy.issue.disposition).toBe("open");

    const refused = await discardAcrossAuthorities(cache.context, request).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(refused?.code).toBe("collaboration.move-phase-invalid");

    // invariant: The destination's admission is the end of the chain the finding tested: the copy it
    // admits is the confirmed one, so the repaired rows land in the local lane with the record.
    const admitted = await moveAcrossByDocument(destinationContext, request, switchDoc!);
    expect(admitted.phase).toBe("switched");
    expect(admitted.document?.phase).toBe("admission");
    const destinationDb = new DatabaseSync(resolveCollaborationLocation(destinationContext).dbPath);
    try {
      expect(destinationDb.prepare("select count(*) as n from occurrences where occurrence_key = 'occ-repaired'").get()).toEqual({ n: 1 });
      expect(
        destinationDb
          .prepare("select disposition from issues where issue_ref = ?")
          .get(FORGED_ISSUE_REF),
      ).toEqual({ disposition: "open" });
      expect(
        destinationDb
          .prepare("select count(*) as n from provenance where issue_id = (select id from issues where issue_ref = ?)")
          .get(FORGED_ISSUE_REF),
      ).toEqual({ n: 2 });
    } finally {
      destinationDb.close();
    }
    // invariant: The admission handoff completes the move on the source half too.
    const published = await moveAcrossByDocument(cache.context, request, admitted.document!);
    expect(published.phase).toBe("published");
  }, 30_000);
  test("an enqueued repair names the fork-evidence route, not the original's dispatch", async () => {
    // invariant: Critical 3 (review wave 4) — once `outbox-resolve` enqueued a repair for the
    // conflicted tombstone, the live leaf IS that repair: an ordinary dispatch refuses it because a
    // reviewed resolution must carry the host's fork observation through `--input`. The refusal's
    // recovery must name that route, and the original's abandon+dispatch text must never appear.
    const cache = await outboxCache("move-repair-pending");
    const operationId = "00000000-0000-4000-8000-000000000946";
    const request = {
      operationId,
      actor: "project-manager",
      sourceIssueId: FORGED_ISSUE_REF,
      destinationAuthority: `github.com/remote-fixture/move-destination-${sequence++}`,
      destinationProject: "fixture-project",
      reason: "move to a local lane",
    };
    const staged = await moveAcrossByDocument(cache.context, request, null);
    const enqueued = await moveAcrossByDocument(cache.context, request, { ...staged.document!, phase: "staged" }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(enqueued?.code).toBe("remote.effect-pending");

    const { heads, tombstoneId } = await conflictedTombstone(cache, operationId);
    const frozen = recordedEvent(cache.dbPath, tombstoneId);
    const repairId = "00000000-0000-4000-8000-000000000947";
    await prepareRemoteResolution(cache.context, tombstoneId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "keep the tombstone",
      event: { ...frozen, operationId: repairId, parents: heads },
    });

    // invariant: The repair is enqueued but never dispatched, so the chain's live leaf is the
    // repair itself: the refusal's recovery names the fork-evidence route an enqueued resolution
    // takes, never the original intent's dispatch-without-input route.
    const pending = await moveAcrossByDocument(cache.context, request, { ...staged.document!, phase: "staged" }).then(
      () => null,
      (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
    );
    expect(pending?.code).toBe("remote.effect-pending");
    expect(pending?.details).toMatchObject({ operationId: repairId, state: "enqueued" });
    const recovery = String(pending?.details?.recovery ?? "");
    expect(recovery).toContain(`outbox-dispatch --harness <abs> --operation ${repairId} --input <file|->`);
    expect(recovery).toContain("outbox-receipt");
    expect(recovery).toContain("outbox-resolve");
    expect(recovery).not.toContain("outbox-abandon");
    expect(recovery).not.toContain(`--operation ${tombstoneId}`);
  }, 30_000);


  test("a reviewed repair that keeps the record open lets the discard and never switches", async () => {
    // invariant: Critical 2 (review wave 3) — the chain's terminal repair confirmed a DIFFERENT
    // event that left the record live: the provider record stays authoritative here, so abandoning
    // the move loses nothing and the exchange must not claim a tombstone that never landed.
    const cache = await outboxCache("move-repair-open");
    const operationId = "00000000-0000-4000-8000-000000000943";
    const request = {
      operationId,
      actor: "project-manager",
      sourceIssueId: FORGED_ISSUE_REF,
      destinationAuthority: `github.com/remote-fixture/move-destination-${sequence++}`,
      destinationProject: "fixture-project",
      reason: "move to a local lane",
    };
    const localLane = collaborationLocationOfRepoKey(request.destinationAuthority, "local");
    mkdirSync(join(localLane.dbPath, ".."), { recursive: true, mode: 0o700 });
    await initializeCollaborationStore(localLane);
    const staged = await moveAcrossByDocument(cache.context, request, null);
    const doc = staged.document;
    expect(doc).not.toBeNull();
    await moveAcrossByDocument(cache.context, request, { ...doc!, phase: "staged" }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );

    const { heads, tombstoneId } = await conflictedTombstone(cache, operationId);
    const frozen = recordedEvent(cache.dbPath, tombstoneId);
    // note: The reviewed resolution keeps the record authoritative: same carried history, but the
    // disposition the reviewer confirmed is `open`, not the move's `obsolete`.
    const repairId = "00000000-0000-4000-8000-000000000944";
    if (frozen.change.kind !== "issue-replace") throw new Error("the fixture expected the tombstone to freeze an issue-replace");
    const frozenMstar = frozen.change.mstar;
    const openEvent = {
      ...frozen,
      operationId: repairId,
      parents: heads,
      change: {
        ...frozen.change,
        mstar: { ...frozenMstar, fields: { ...(frozenMstar.fields as Record<string, unknown>), disposition: "open" } },
      },
    };
    await prepareRemoteResolution(cache.context, tombstoneId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "keep the record",
      event: openEvent as RemoteEvent,
    });
    const repairAttempt = attemptOf(await dispatchRemoteIntent(cache.context, repairId, forkObservationFor(cache, tombstoneId, heads)));
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, repairId, repairAttempt, (await readRemoteIntent(cache.context, repairId)).requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee03",
        event: recordedEvent(cache.dbPath, repairId),
      }),
    );

    // invariant: The repaired confirmation did not tombstone the record, so the exchange refuses
    // the switch as the mismatch it is instead of claiming a tombstone that never landed.
    const mismatched = await moveAcrossByDocument(cache.context, request, { ...doc!, phase: "staged" }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(mismatched?.code).toBe("remote.effect-mismatch");

    // invariant: The record never left this authority, so the discard completes instead of
    // stranding it, and a reissued exchange refuses the switch instead of inventing a tombstone.
    const discarded = await discardAcrossAuthorities(cache.context, request);
    expect(discarded.phase).toBe("discarded");
    const switched = await moveAcrossByDocument(cache.context, request, { ...doc!, phase: "staged" }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(switched?.code).toBe("collaboration.move-phase-invalid");
  }, 30_000);

  test("a successor generation carrying the same revision sum inside the stage window refuses as stale", async () => {
    // invariant: Critical 3 (review wave 3) — the sampled revision sum alone cannot name the
    // observation the copy was frozen from: a rollover landing between the read and the freeze can
    // carry the same sum under a successor generation, and only the pinned generation refuses it.
    const cache = await outboxCache("move-same-sum-rollover");
    const operationId = "00000000-0000-4000-8000-000000000945";
    const request = {
      operationId,
      actor: "project-manager",
      sourceIssueId: FORGED_ISSUE_REF,
      destinationAuthority: `github.com/remote-fixture/move-destination-${sequence++}`,
      destinationProject: "fixture-project",
      reason: "move to a local lane",
    };
    const localLane = collaborationLocationOfRepoKey(request.destinationAuthority, "local");
    mkdirSync(join(localLane.dbPath, ".."), { recursive: true, mode: 0o700 });
    await initializeCollaborationStore(localLane);

    const check = positiveCheck();
    let rolled = false;
    setMoveGapForTest(async (point) => {
      if (point !== "stage" || rolled) return;
      rolled = true;
      setMoveGapForTest(undefined);
      // note: The successor lineage is genuine: the publish names the bound generation as its
      // previous, so the rebind admits it and the new generation holds the same observation sum.
      const second = cache.fixture.publish(
        cache.fixture.payload({ generation: 4, previous: { selectorCommit: cache.commit, generation: 3, mode: "remote" }, cutover: FENCED }),
      );
      await bindRemoteAuthority(cache.context, { version: 1, selectorCommit: second, generation: 4, checks: [check] });
      await ingestRemoteObservation(cache.context, observation(check, { selectorCommit: second, generation: 4 }));
    });
    const refused = await moveAcrossByDocument(cache.context, request, null).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(refused?.code).toBe("collaboration.observation-stale");
    // invariant: The refusal staged nothing: the move has no row to resume under this operation id.
    const db = new DatabaseSync(cache.dbPath);
    try {
      expect(db.prepare("select count(*) as n from issue_moves where operation_id = ?").get(operationId)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("pre-v3 remote cache recovery", () => {
  // note: The predecessor ledger is this fixture's own input; the destination ledger is the WHOLE
  // migration registry, so adding an intermediate migration never reddens these cases or hides one.
  const PREDECESSOR_VERSIONS = COLLABORATION_MIGRATIONS.slice(0, 2).map(({ version }) => version);
  const REGISTRY_VERSIONS = COLLABORATION_MIGRATIONS.map(({ version }) => version);

  /** note: The generation the predecessor cache itself records, read from its own meta row. */
  function recordedGeneration(location: CollaborationLocation): { storeId: string; epoch: number } {
    const meta = metaRecord(location.dbPath);
    return { storeId: meta.store_id, epoch: meta.authority_epoch };
  }

  test("the reviewed bind replaces the derived cache and an admitted read names that recovery", async () => {
    const fixture = remoteFixture("remote-prev3-recovery");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    writeV2RemoteLane(location);
    expect(ledgerVersions(location.dbPath)).toEqual(PREDECESSOR_VERSIONS);
    // note: The checkout records the generation this pre-v3 cache belongs to, exactly as an earlier
    // bind of that release left it. Its store identity must survive the replacement.
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });

    // invariant: An ordinary admitted read refuses, and it names the REACHABLE recovery — the
    // reviewed bind, never a local `store upgrade` that produces no remote receipt. The command it
    // names is runnable as printed: absolute harness, a document input, the verified batch, and
    // the published document shape.
    const stale = await refusalOf(() => readRemoteCacheAuthority(context));
    expect(stale.code).toBe("collaboration.upgrade-required");
    expect(stale.message).toContain("mstar store collaboration remote bind --harness <abs> --input <file|->");
    expect(stale.message).toContain("mstar schema --command store.collaboration.remote.bind");

    const bound = await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: commit,
      generation,
      checks: [positiveCheck()],
    });
    // invariant: The replacement kept the recorded store identity, so the checkout binding still
    // names the cache the bind published.
    expect(bound).toMatchObject({ version: 1, generation, binding: { mode: "remote", ...recorded } });
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS);
    expect(metaRecord(location.dbPath)).toMatchObject({
      mode: "remote",
      store_id: recorded.storeId,
      authority_state: "active",
    });
    expect(tableNames(location.dbPath)).toContain("remote_outbox");
    expect((await readRemoteCacheAuthority(context)).schemaVersion).toBe(CURRENT_VERSION);
  }, 30_000);

  test("an interruption at publication leaves the predecessor named and a retry completes", async () => {
    const fixture = remoteFixture("remote-prev3-failed-replacement");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    writeV2RemoteLane(location);
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });
    // note: The successor is fully staged and the predecessor preserved when this fails; the one
    // atomic rename has not run, so the canonical name must still hold the predecessor.
    setRemoteCacheReplacementPublishGapForTest(() => {
      throw new Error("injected publication failure");
    });
    try {
      const refused = await refusalOf(() =>
        bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
      );
      expect(refused.code).toBe("collaboration.unreadable");
    } finally {
      setRemoteCacheReplacementPublishGapForTest(undefined);
    }
    // invariant: The canonical name is never absent after an interrupted publication, and the
    // previous cache and its ledger are exactly as the failed bind found them.
    expect(existsSync(location.dbPath)).toBe(true);
    expect(ledgerVersions(location.dbPath)).toEqual(PREDECESSOR_VERSIONS);
    expect(metaRecord(location.dbPath)).toMatchObject({
      mode: "remote",
      store_id: recorded.storeId,
      authority_epoch: recorded.epoch,
    });
    // invariant: The documented recovery still completes on the same bytes afterwards.
    const bound = await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] });
    expect(bound).toMatchObject({ generation, binding: { mode: "remote", ...recorded } });
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS);
  }, 30_000);

  test("a replacement refuses a cache its checkout did not record", async () => {
    const fixture = remoteFixture("remote-prev3-unrecorded-cache");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    writeV2RemoteLane(location);
    // note: Same store, another epoch: these bytes belong to a generation this checkout never
    // recorded, so they are refused before the canonical name is released.
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, {
      repoKey: fixture.repoKey,
      selectorCommit: commit,
      generation,
      storeId: recorded.storeId,
      epoch: recorded.epoch + 1,
    });
    const refused = await refusalOf(() =>
      bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
    );
    expect(refused.code).toBe("collaboration.stale-binding");
    expect(ledgerVersions(location.dbPath)).toEqual(PREDECESSOR_VERSIONS);
    expect(metaRecord(location.dbPath)).toMatchObject({ store_id: recorded.storeId, authority_epoch: recorded.epoch });
  }, 30_000);

  test("a stale probe never removes a v3 cache or the outbox row a writer froze in it", async () => {
    const fixture = remoteFixture("remote-prev3-stale-probe");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    writeV2RemoteLane(location);
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });
    // note: A competing bind publishes the current cache — and a real writer freezes one of its
    // outbox rows — between this attempt's replacement decision and its critical section. One check
    // serves every attempt, so each later bind is the identical replay a re-bind admits.
    const check = positiveCheck();
    const frozenId = "00000000-0000-4000-8000-0000000009f1";
    let competing = false;
    let competitor: { storeId: string; epoch: number } | undefined;
    setRemoteCacheReplacementGapForTest(async () => {
      if (competing) return;
      competing = true;
      const bound = await bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: commit,
        generation,
        checks: [check],
      });
      competitor = bound.binding;
      await ingestRemoteObservation(context, observation(check, { selectorCommit: commit, generation }));
      await prepareRemoteIntent(context, intentRequest(fixture, commit, frozenId));
    });
    try {
      const bound = await bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: commit,
        generation,
        checks: [check],
      });
      // invariant: The stale attempt found the advanced lane inside its critical section and
      // continued it instead of replacing it.
      expect(bound).toMatchObject({ generation, binding: { mode: "remote", ...recorded } });
    } finally {
      setRemoteCacheReplacementGapForTest(undefined);
    }
    // invariant: The current cache, its identity and the frozen outbox row all survive the stale
    // attempt: a replaced-derived-lane decision never authorizes destroying v3 work.
    expect(competitor).toBeDefined();
    expect(metaRecord(location.dbPath)).toMatchObject({
      store_id: competitor!.storeId,
      authority_epoch: competitor!.epoch,
    });
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS);
    expect(outboxRows(location.dbPath)).toContainEqual(expect.objectContaining({ operation_id: frozenId, state: "enqueued" }));
  }, 30_000);

  test("a pre-current v3 remote cache with no unsettled intent is replaced by the bind", async () => {
    const fixture = remoteFixture("remote-v3-clean-replacement");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    writeV3RemoteLane(location);
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS.slice(0, 3));
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });

    // invariant: The ordinary read refuses and names the reviewed bind — a remote cache is never
    // upgraded in place, even when this build's migration follows its own.
    const stale = await refusalOf(() => readRemoteCacheAuthority(context));
    expect(stale.code).toBe("collaboration.upgrade-required");
    expect(stale.message).toContain("mstar store collaboration remote bind --harness <abs> --input <file|->");

    // invariant: The predecessor is preserved beside the lane as a `.replaced-` hard link in the
    // window before the one atomic rename publishes the successor.
    let preservedDuringPublish = false;
    setRemoteCacheReplacementPublishGapForTest(() => {
      preservedDuringPublish = readdirSync(dirname(location.dbPath)).some((name) => name.startsWith(".replaced-"));
    });
    let bound;
    try {
      bound = await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] });
    } finally {
      setRemoteCacheReplacementPublishGapForTest(undefined);
    }
    expect(preservedDuringPublish).toBe(true);
    // invariant: The replacement kept the recorded store identity and lands at the current schema.
    expect(bound).toMatchObject({ version: 1, generation, binding: { mode: "remote", ...recorded } });
    expect(metaRecord(location.dbPath)).toMatchObject({ mode: "remote", store_id: recorded.storeId, authority_state: "active" });
    expect((await readRemoteCacheAuthority(context)).schemaVersion).toBe(CURRENT_VERSION);
  }, 30_000);

  test("the bind refuses a v3 remote cache holding an unconfirmed intent and leaves it unchanged", async () => {
    const fixture = remoteFixture("remote-v3-pending-replacement");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    const frozenId = "00000000-0000-4000-8000-0000000009f2";
    writeV3Lane(location, (db) => {
      db.exec(
        "insert into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
          "provider_project_id, journal_issue_id, verified_at, verification_json) values (1, 'seed-project', " +
          "'" + commit + "', 'linear', 'seed-workspace', 'seed-team', 'seed-provider-project', 'seed-journal', " +
          "'2026-11-21T00:00:00.000Z', '{}');" +
          "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, state, " +
          "created_at, updated_at) values ('" + frozenId + "', 1, 'seed-project', 'seed-hash', '{}', 'unconfirmed', " +
          "'2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');",
      );
    });
    // note: The seeded bytes become a REMOTE cache the same way writeV3RemoteLane does.
    const modeDb = new DatabaseSync(location.dbPath);
    try {
      modeDb.prepare("update collaboration_meta set mode = 'remote' where id = 1").run();
    } finally {
      modeDb.close();
    }
    chmodSync(location.dbPath, 0o600);
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });

    const refused = await refusalOf(() =>
      bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
    );
    // invariant: The refusal names the intent, its age order and the exact outbox recovery route.
    expect(refused.code).toBe("remote.effect-pending");
    expect(refused.message).toContain(frozenId);
    expect(refused.message).toContain("unconfirmed");
    // note: The recovery must be executable for THIS state: an `unconfirmed` row is invisible to
    // `outbox-pending`, so the first step names `outbox-show` and its settlement verbs.
    expect(refused.message).toContain("outbox-show");
    expect(refused.message).toContain("outbox-reconcile");
    expect(refused.message).toContain("outbox-receipt");
    // invariant: Nothing was replaced: the ledger, the identity and the intent itself are exactly
    // as the refused bind found them, and no `.replaced-` copy was staged.
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS.slice(0, 3));
    expect(metaRecord(location.dbPath)).toMatchObject({ store_id: recorded.storeId, authority_epoch: recorded.epoch });
    expect(outboxRows(location.dbPath)).toContainEqual(expect.objectContaining({ operation_id: frozenId, state: "unconfirmed" }));
    expect(readdirSync(dirname(location.dbPath)).some((name) => name.startsWith(".replaced-"))).toBe(false);
  }, 30_000);

  /** note: Seed one synthetic outbox row into a REMOTE v3 lane: enough for the guard's refusal texts. */
  function seedRemoteV3Intent(
    location: CollaborationLocation,
    operationId: string,
    state: RemoteIntentState,
    createdAt = "2026-11-21T00:00:00.000Z",
  ): void {
    writeV3RemoteLane(location);
    const db = new DatabaseSync(location.dbPath);
    try {
      db.exec(
        "insert into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
          "provider_project_id, journal_issue_id, verified_at, verification_json) values (1, 'seed-project', " +
          "'seed-commit', 'linear', 'seed-workspace', 'seed-team', 'seed-provider-project', 'seed-journal', " +
          "'2026-11-21T00:00:00.000Z', '{}');" +
          "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, state, created_at, updated_at) " +
          "values ('" + operationId + "', 1, 'seed-project', 'seed-hash', '{}', '" + state + "', '" + createdAt + "', '" + createdAt + "');",
      );
    } finally {
      db.close();
    }
  }

  test("an enqueued intent is settled through the public outbox verbs on the refused cache and the bind then succeeds", async () => {
    const fixture = remoteFixture("remote-v3-pending-recovery");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    const frozenId = "00000000-0000-4000-8000-0000000009f3";
    // note: The frozen request is a real one, so the settlement verbs can read and abandon it.
    const request = intentRequest(fixture, commit, frozenId);
    writeV3RemoteLane(location);
    const db = new DatabaseSync(location.dbPath);
    try {
      db.prepare(
        "insert into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
          "provider_project_id, journal_issue_id, verified_at, verification_json) values (?, ?, ?, 'linear', ?, ?, ?, ?, ?, '{}')",
      ).run(
        generation,
        SELECTED_PROJECT.localProjectId,
        commit,
        SELECTED_PROJECT.workspaceId,
        SELECTED_PROJECT.teamId,
        SELECTED_PROJECT.projectId,
        SELECTED_PROJECT.journalIssueId,
        "2026-11-21T00:00:00.000Z",
      );
      db.prepare(
        "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, state, created_at, updated_at) " +
          "values (?, ?, ?, 'seed-hash', ?, 'enqueued', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
      ).run(frozenId, generation, SELECTED_PROJECT.localProjectId, JSON.stringify(request));
    } finally {
      db.close();
    }
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });

    // invariant: The bind refuses with the executable recovery: the oldest operation id and the
    // listing/dispatch route an enqueued row can actually start from.
    const refused = await refusalOf(() =>
      bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
    );
    expect(refused.code).toBe("remote.effect-pending");
    expect(refused.message).toContain(frozenId);
    expect(refused.message).toContain("outbox-pending");
    expect(refused.message).toContain("outbox-dispatch");
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS.slice(0, 3));

    // invariant: The recovery the refusal names RUNS on the below-current cache: the listing sees
    // the row, and the public abandonment settles it.
    const pending = await readPendingIntents(context, SELECTED_PROJECT.localProjectId);
    expect(pending.intents.map((intent) => intent.operationId)).toEqual([frozenId]);
    const abandoned = await abandonRemoteIntent(context, { operationId: frozenId, reason: "settled on the refused cache" });
    expect(abandoned).toMatchObject({ operationId: frozenId, state: "abandoned" });

    // invariant: The recovery admission widened nothing: the ordinary write lane still refuses the
    // below-current cache with its unchanged text, and a domain table is never served.
    const business = await refusalOf(() => withRemoteCacheWrite(context, () => undefined));
    expect(business.code).toBe("collaboration.upgrade-required");
    expect(business.message).toContain("mstar store collaboration remote bind --harness <abs> --input <file|->");
    const recovery = await openRemoteCacheRecovery(context, "read");
    try {
      expect(() => recovery.db.prepare("select count(*) as n from issues").get()).toThrow(/"issues"/);
      expect(recovery.db.prepare("select count(*) as n from remote_outbox").get()).toMatchObject({ n: 1 });
    } finally {
      recovery.close();
    }

    // invariant: With every intent settled, the ordinary bind replaces the cache and keeps the
    // store identity - the exit the guard promises.
    const bound = await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] });
    expect(bound).toMatchObject({ version: 1, generation, binding: { mode: "remote", ...recorded } });
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS);
    expect(metaRecord(location.dbPath)).toMatchObject({ mode: "remote", store_id: recorded.storeId, authority_state: "active" });
    expect((await readRemoteCacheAuthority(context)).schemaVersion).toBe(CURRENT_VERSION);
  }, 30_000);

  test("each unsettled state's refusal names a first step that works for that state", async () => {
    const cases: Array<{ state: RemoteIntentState; step: string }> = [
      { state: "enqueued", step: "outbox-dispatch" },
      { state: "unconfirmed", step: "outbox-reconcile" },
      { state: "conflict", step: "outbox-resolve" },
    ];
    for (const { state, step } of cases) {
      const fixture = remoteFixture("remote-v3-route-" + state);
      const commit = fixture.publish(fixture.payload());
      const generation = Number(fixture.payload().generation);
      const context = contextAt(fixture.repo);
      const location = locationAt(fixture.repo);
      const frozenId = "00000000-0000-4000-8000-0000000009f4";
      seedRemoteV3Intent(location, frozenId, state);
      const recorded = recordedGeneration(location);
      writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });
      const refused = await refusalOf(() =>
        bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
      );
      // invariant: The named first step is the verb that settles THIS state, and it is always
      // introduced by a listing/show command that can find the row.
      expect(refused.code).toBe("remote.effect-pending");
      expect(refused.message).toContain(frozenId);
      expect(refused.message).toContain(step);
      expect(refused.message).toMatch(/outbox-(pending|show)/);
    }
  }, 30_000);

  test("a cache holding intents of several states names EVERY state with its own id and first step", async () => {
    const fixture = remoteFixture("remote-v3-route-mixed");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    writeV3RemoteLane(location);
    const db = new DatabaseSync(location.dbPath);
    try {
      // note: The conflict row is OLDER, so its route is the named first step.
      db.exec(
        "insert into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
          "provider_project_id, journal_issue_id, verified_at, verification_json) values (1, 'seed-project', " +
          "'seed-commit', 'linear', 'seed-workspace', 'seed-team', 'seed-provider-project', 'seed-journal', " +
          "'2026-11-21T00:00:00.000Z', '{}');" +
          "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, state, created_at, updated_at) " +
          "values ('00000000-0000-4000-8000-0000000009e1', 1, 'seed-project', 'seed-hash', '{}', 'conflict', " +
          "'2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'), " +
          "('00000000-0000-4000-8000-0000000009e2', 1, 'seed-project', 'seed-hash', '{}', 'enqueued', " +
          "'2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z');",
      );
    } finally {
      db.close();
    }
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });
    const refused = await refusalOf(() =>
      bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
    );
    expect(refused.code).toBe("remote.effect-pending");
    // invariant: Both states are named, each with its OWN oldest operation id and the first step
    // executable for THAT state - a later row is never invisible behind the oldest one.
    expect(refused.message).toContain("00000000-0000-4000-8000-0000000009e1");
    expect(refused.message).toContain("00000000-0000-4000-8000-0000000009e2");
    expect(refused.message).toContain("state conflict: oldest operation 00000000-0000-4000-8000-0000000009e1");
    expect(refused.message).toContain("state enqueued: oldest operation 00000000-0000-4000-8000-0000000009e2");
    expect(refused.message).toContain("outbox-resolve");
    expect(refused.message).toContain("outbox-pending");
    expect(refused.message).toContain("outbox-dispatch");
  }, 30_000);

  test("a below-current cache this build's declared inventory does not match still refuses, mutating nothing", async () => {
    const fixture = remoteFixture("remote-v3-inventory-mismatch");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    writeV3RemoteLane(location);
    // note: Damage one column the declared inventory requires: the exact-inventory proof of the
    // recovery admission must refuse these bytes, not serve them.
    const db = new DatabaseSync(location.dbPath);
    try {
      db.exec("create table issues_broken as select * from issues");
      db.exec("drop table issues");
      db.exec("alter table issues_broken drop column identity_key");
      db.exec("alter table issues_broken rename to issues");
    } finally {
      db.close();
    }
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });
    // invariant: The recovery open refuses the exact-inventory proof by name...
    const refused = await refusalOf(() => openRemoteCacheRecovery(context, "read"));
    expect(refused.code).toBe("collaboration.unreadable");
    // invariant: ...and that refused open mutates nothing: the ledger, identity and damaged bytes
    // are exactly as found, with no staging beside the lane.
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS.slice(0, 3));
    expect(metaRecord(location.dbPath)).toMatchObject({ store_id: recorded.storeId, authority_epoch: recorded.epoch });
    expect(existsSync(location.dbPath)).toBe(true);
    expect(readdirSync(dirname(location.dbPath)).some((name) => name.startsWith(".replaced-"))).toBe(false);
  }, 30_000);

  /**
   * note: A v3 REMOTE cache seeded with one real conflicted journal intent: a verified binding,
   * a dispatched attempt and fork evidence recorded through the public receipt verb, so the
   * settlement verbs can read, resolve, dispatch and confirm on it exactly as on a live cache.
   */
  function seedConflictedV3Cache(
    name: string,
    conflictId: string,
  ): Promise<{
    repoKey: string;
    commit: string;
    generation: number;
    context: StoreContext;
    location: CollaborationLocation;
    fork: { heads: string[]; records: Array<Record<string, unknown>> };
  }> {
    const fixture = remoteFixture(name);
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    const attempt = "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaa1";
    const requestHash = "c".repeat(64);
    writeV3RemoteLane(location);
    const db = new DatabaseSync(location.dbPath);
    try {
      db.prepare(
        "insert into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
          "provider_project_id, journal_issue_id, writer_id, verified_at, verification_json) values (?, ?, ?, 'linear', " +
          "?, ?, ?, ?, ?, ?, ?)",
      ).run(
        generation,
        SELECTED_PROJECT.localProjectId,
        commit,
        SELECTED_PROJECT.workspaceId,
        SELECTED_PROJECT.teamId,
        SELECTED_PROJECT.projectId,
        SELECTED_PROJECT.journalIssueId,
        SELECTED_PROJECT.writerId,
        new Date().toISOString(),
        JSON.stringify({ outcome: { kind: "verified" }, checkedAt: new Date().toISOString() }),
      );
      db.prepare(
        "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, state, " +
          "attempt_id, created_at, updated_at) values (?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?)",
      ).run(
        conflictId,
        generation,
        SELECTED_PROJECT.localProjectId,
        requestHash,
        JSON.stringify(journalIntent(fixture, commit, conflictId)),
        attempt,
        "2026-11-21T00:00:00.000Z",
        "2026-11-21T00:00:00.000Z",
      );
    } finally {
      db.close();
    }
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });
    const fork = journalFork(fixture);
    // invariant: The conflict state and its recorded fork are exactly what a live conflict carries,
    // because the evidence is recorded through the same public receipt verb an operator uses.
    return recordRemoteReceipt(
      context,
      receiptInput(commit, conflictId, attempt, requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_PROJECT_HEAD],
        observedHeads: fork.heads,
        observedRecords: fork.records,
      }),
    ).then(() => ({ repoKey: fixture.repoKey, commit, generation, context, location, fork }));
  }

  test("a confirmed resolution chain unblocks the bind, which replaces the cache and keeps its identity", async () => {
    const conflictId = "00000000-0000-4000-8000-0000000009f5";
    const repairId = "00000000-0000-4000-8000-0000000009f6";
    const cache = await seedConflictedV3Cache("remote-v3-conflict-chain", conflictId);
    const bind = () =>
      bindRemoteAuthority(cache.context, {
        version: 1,
        selectorCommit: cache.commit,
        generation: cache.generation,
        checks: [checkAfterBinding(cache.location.dbPath)],
      });

    // invariant: The conflict blocks the replacement and names its own route.
    const refused = await refusalOf(bind);
    expect(refused.code).toBe("remote.effect-pending");
    expect(refused.message).toContain(conflictId);
    expect(refused.message).toContain("outbox-resolve");

    // invariant: The reviewed resolution runs on the refused cache; the parent stays conflicted
    // with the repair linked, and the bind is still refused while the repair is enqueued.
    const resolutionEvent = journalEvent({ repoKey: cache.repoKey }, repairId, cache.fork.heads);
    const prepared = await prepareRemoteResolution(cache.context, conflictId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: resolutionEvent,
    });
    expect(prepared).toMatchObject({ operationId: repairId, state: "enqueued" });
    expect((await readRemoteIntent(cache.context, conflictId)).resolvedBy).toBe(repairId);
    const refusedAgain = await refusalOf(bind);
    expect(refusedAgain.code).toBe("remote.effect-pending");

    // invariant: The repair is dispatched and confirmed through the public verbs on the same
    // refused cache; the parent keeps its conflict history untouched.
    const dispatched = await dispatchRemoteIntent(
      cache.context,
      repairId,
      forkObservationFor({ commit: cache.commit, dbPath: cache.location.dbPath }, conflictId, cache.fork.heads),
    );
    expect(dispatched.kind).toBe("permit");
    const repair = await readRemoteIntent(cache.context, repairId);
    const confirmed = await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, repairId, attemptOf(dispatched), repair.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee7",
        event: resolutionEvent,
      }),
    );
    expect(confirmed).toMatchObject({ operationId: repairId, state: "confirmed" });
    expect((await readRemoteIntent(cache.context, conflictId)).state).toBe("conflict");

    // invariant: With the repair chain settled, the SAME bind replaces the cache and keeps the
    // store identity - the exit the settle rule promises.
    const recorded = recordedGeneration(cache.location);
    const bound = await bind();
    expect(bound).toMatchObject({ version: 1, generation: cache.generation, binding: { mode: "remote", ...recorded } });
    expect(ledgerVersions(cache.location.dbPath)).toEqual(REGISTRY_VERSIONS);
    expect((await readRemoteCacheAuthority(cache.context)).schemaVersion).toBe(CURRENT_VERSION);
  }, 30_000);

  test("a conflict whose repair was abandoned still refuses the bind", async () => {
    const conflictId = "00000000-0000-4000-8000-0000000009f7";
    const repairId = "00000000-0000-4000-8000-0000000009f8";
    const cache = await seedConflictedV3Cache("remote-v3-conflict-withdrawn", conflictId);
    const resolutionEvent = journalEvent({ repoKey: cache.repoKey }, repairId, cache.fork.heads);
    await prepareRemoteResolution(cache.context, conflictId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: resolutionEvent,
    });
    // note: The review is withdrawn: the repair is abandoned before dispatch.
    const abandoned = await abandonRemoteIntent(cache.context, { operationId: repairId, reason: "review withdrawn" });
    expect(abandoned).toMatchObject({ operationId: repairId, state: "abandoned" });

    // invariant: An abandoned repair is no settlement: the parent conflict still blocks the bind
    // and names its own route, so no abandoned child can satisfy the settle rule.
    const refused = await refusalOf(() =>
      bindRemoteAuthority(cache.context, {
        version: 1,
        selectorCommit: cache.commit,
        generation: cache.generation,
        checks: [positiveCheck()],
      }),
    );
    expect(refused.code).toBe("remote.effect-pending");
    expect(refused.message).toContain(conflictId);
    expect(refused.message).toContain("outbox-resolve");
    expect(ledgerVersions(cache.location.dbPath)).toEqual(REGISTRY_VERSIONS.slice(0, 3));
  }, 30_000);

  test("the pending listing excludes a conflict its confirmed repair settled and keeps an unsettled one", async () => {
    const conflictId = "00000000-0000-4000-8000-000000000a20";
    const repairId = "00000000-0000-4000-8000-000000000a21";
    const cache = await seedConflictedV3Cache("remote-v3-listing-settled-conflict", conflictId);
    const resolutionEvent = journalEvent({ repoKey: cache.repoKey }, repairId, cache.fork.heads);
    await prepareRemoteResolution(cache.context, conflictId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: resolutionEvent,
    });
    const dispatched = await dispatchRemoteIntent(
      cache.context,
      repairId,
      forkObservationFor({ commit: cache.commit, dbPath: cache.location.dbPath }, conflictId, cache.fork.heads),
    );
    const repair = await readRemoteIntent(cache.context, repairId);
    await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, repairId, attemptOf(dispatched), repair.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9",
        event: resolutionEvent,
      }),
    );
    // invariant: The parent keeps the conflict state it arrived with and only its repair chain
    // settles it, so the listing excludes the row through the settle rule, never a state rewrite.
    expect(await readRemoteIntent(cache.context, conflictId)).toMatchObject({
      state: "conflict",
      resolvedBy: repairId,
    });
    // invariant: The listing and the guard settle by ONE rule: this parent is not awaiting
    // settlement, and reporting it would route the operator to a refusing `outbox-resolve`.
    expect((await readPendingIntents(cache.context, SELECTED_PROJECT.localProjectId)).intents).toEqual([]);
    // note: The guard admits the replacement of the same bytes, which is the agreement the listing
    // above rests on; the listing is asserted first because the bind replaces this cache.
    const bound = await bindRemoteAuthority(cache.context, {
      version: 1,
      selectorCommit: cache.commit,
      generation: cache.generation,
      checks: [checkAfterBinding(cache.location.dbPath)],
    });
    expect(bound).toMatchObject({ version: 1, generation: cache.generation });

    const withdrawnConflict = "00000000-0000-4000-8000-000000000a22";
    const withdrawnRepair = "00000000-0000-4000-8000-000000000a23";
    const withdrawn = await seedConflictedV3Cache("remote-v3-listing-withdrawn-conflict", withdrawnConflict);
    await prepareRemoteResolution(withdrawn.context, withdrawnConflict, {
      operationId: withdrawnRepair,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent({ repoKey: withdrawn.repoKey }, withdrawnRepair, withdrawn.fork.heads),
    });
    await abandonRemoteIntent(withdrawn.context, { operationId: withdrawnRepair, reason: "review withdrawn" });
    // invariant: A withdrawn repair settles nothing, so the parent stays listed: the exclusion is
    // the settle rule, never a blanket "carries a resolvedBy" filter.
    const listed = (await readPendingIntents(withdrawn.context, SELECTED_PROJECT.localProjectId)).intents;
    expect(listed.map((intent) => [intent.operationId, intent.state])).toEqual([[withdrawnConflict, "conflict"]]);
  }, 30_000);

  test("a confirmed repair holds no settle without its recorded confirmed receipt", async () => {
    const conflictId = "00000000-0000-4000-8000-000000000a10";
    const repairId = "00000000-0000-4000-8000-000000000a11";
    const cache = await seedConflictedV3Cache("remote-v3-conflict-unproven-repair", conflictId);
    // note: The carried successor keeps the predecessor's recorded verification, so the bind's check
    // must be dated AFTER it; the default positive check is one second in the past and can predate a
    // seed bind that ran within the same second.
    const bind = () =>
      bindRemoteAuthority(cache.context, {
        version: 1,
        selectorCommit: cache.commit,
        generation: cache.generation,
        checks: [positiveCheck({ checkedAt: new Date().toISOString() })],
      });
    const resolutionEvent = journalEvent({ repoKey: cache.repoKey }, repairId, cache.fork.heads);
    await prepareRemoteResolution(cache.context, conflictId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: resolutionEvent,
    });
    const dispatched = await dispatchRemoteIntent(
      cache.context,
      repairId,
      forkObservationFor({ commit: cache.commit, dbPath: cache.location.dbPath }, conflictId, cache.fork.heads),
    );
    const repair = await readRemoteIntent(cache.context, repairId);
    // note: The state column alone claims a confirmation: the receipt that would prove it was never
    // recorded, which is the damaged-cache shape a bind must not trust.
    const db = new DatabaseSync(cache.location.dbPath);
    try {
      db.prepare("update remote_outbox set state = 'confirmed' where operation_id = ?").run(repairId);
    } finally {
      db.close();
    }
    const refused = await refusalOf(bind);
    expect(refused.code).toBe("remote.effect-pending");
    expect(refused.message).toContain(conflictId);
    expect(refused.message).toContain("holds no recorded confirmed receipt");
    expect(ledgerVersions(cache.location.dbPath)).toEqual(REGISTRY_VERSIONS.slice(0, 3));

    // invariant: The recorded receipt is the exit, so the public receipt verb still records it on a
    // row whose state claims the confirmation - otherwise that cache could never settle.
    const confirmed = await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, repairId, attemptOf(dispatched), repair.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee8",
        event: resolutionEvent,
      }),
    );
    expect(confirmed).toMatchObject({ operationId: repairId, state: "confirmed" });

    const recorded = recordedGeneration(cache.location);
    const bound = await bind();
    expect(bound).toMatchObject({ version: 1, generation: cache.generation, binding: { mode: "remote", ...recorded } });
    expect(ledgerVersions(cache.location.dbPath)).toEqual(REGISTRY_VERSIONS);
  }, 30_000);

  test("a tampered confirmed state never records a confirmation beside a recorded conflict receipt", async () => {
    const conflictId = "00000000-0000-4000-8000-000000000a14";
    const repairId = "00000000-0000-4000-8000-000000000a15";
    const cache = await seedConflictedV3Cache("remote-v3-conflict-laundering", conflictId);
    const bind = () =>
      bindRemoteAuthority(cache.context, {
        version: 1,
        selectorCommit: cache.commit,
        generation: cache.generation,
        checks: [positiveCheck()],
      });
    const resolutionEvent = journalEvent({ repoKey: cache.repoKey }, repairId, cache.fork.heads);
    await prepareRemoteResolution(cache.context, conflictId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: resolutionEvent,
    });
    const dispatched = await dispatchRemoteIntent(
      cache.context,
      repairId,
      forkObservationFor({ commit: cache.commit, dbPath: cache.location.dbPath }, conflictId, cache.fork.heads),
    );
    const repair = await readRemoteIntent(cache.context, repairId);
    const repairFork = journalFork({ repoKey: cache.repoKey });
    // note: The fork evidence is recorded through the public receipt verb while the repair is
    // live; the state column is tampered to confirmed afterwards, which is the damaged-cache
    // shape the reopening must not let a matching confirmation launder into a settled parent.
    const conflicted = await recordRemoteReceipt(
      cache.context,
      receiptInput(cache.commit, repairId, attemptOf(dispatched), repair.requestHash, {
        kind: "conflict",
        expectedHeads: cache.fork.heads,
        observedHeads: repairFork.heads,
        observedRecords: repairFork.records,
      }),
    );
    expect(conflicted).toMatchObject({ operationId: repairId, state: "conflict" });
    const db = new DatabaseSync(cache.location.dbPath);
    try {
      db.prepare("update remote_outbox set state = 'confirmed' where operation_id = ?").run(repairId);
    } finally {
      db.close();
    }
    const refused = await refusalOf(() =>
      recordRemoteReceipt(
        cache.context,
        receiptInput(cache.commit, repairId, attemptOf(dispatched), repair.requestHash, {
          kind: "confirmed",
          identity: { ...providerScope(), issueId: JOURNAL_ANCHOR },
          recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef",
          event: resolutionEvent,
        }),
      ),
    );
    expect(refused.code).toBe("remote.dispatch-refused");
    expect(refused.message).toContain("already holds a recorded conflict receipt");
    // invariant: The row is not state 'conflict', so outbox-resolve would refuse it too: the only
    // live route is the ordinary bootstrap rebuild, naming every bound checkout, not just this one.
    expect(refused.message).not.toContain("outbox-resolve");
    expect(refused.message).toContain("recorded state contradicts its recorded evidence");
    expect(refused.message).toContain("rebuild the derived cache through the ordinary bootstrap");
    expect(refused.message).toContain("stop every checkout of this repository that has the cache bound");
    expect(refused.message).toContain("settle every other unsettled intent that cache holds through the outbox verbs its own state line names");
    expect(refused.message).toContain("keep the cache file as evidence - move it aside under a retained name instead of deleting it");
    expect(refused.message).not.toContain("remove the cache file");
    expect(refused.message).toContain("run `mstar store collaboration remote status`");
    expect(refused.message).toContain("fresh reviewed remote bind");
    expect(refused.message).toContain("the pending intent's record is not preserved by the rebuild itself");
    expect(refused.message).toContain("the retained copy preserves it, and an operator can inspect it later");
    // invariant: The destructive order cannot come back: the route settles the cache's OTHER
    // intents, retains the bytes as evidence, proves the rebind, and only then removes the name.
    const route = [
      "settle every other unsettled intent",
      "keep the cache file as evidence",
      "confirm the checked selector and this checkout's binding satisfy a fresh reviewed bind",
      "remove the name the checkout reads",
      "mstar store collaboration remote status",
    ].map((step) => refused.message.indexOf(step));
    for (const at of route) expect(at).toBeGreaterThan(-1);
    expect([...route].sort((left, right) => left - right)).toEqual(route);
    // invariant: The parent conflict stays unsettled: no laundered confirmation unblocked it.
    const stillRefused = await refusalOf(bind);
    expect(stillRefused.code).toBe("remote.effect-pending");
    expect(stillRefused.message).toContain(conflictId);
  }, 30_000);

  test("a confirmed repair link of another generation never settles the conflict", async () => {
    const conflictId = "00000000-0000-4000-8000-0000000009fa";
    const repairId = "00000000-0000-4000-8000-0000000009fb";
    const cache = await seedConflictedV3Cache("remote-v3-conflict-foreign-generation", conflictId);
    const db = new DatabaseSync(cache.location.dbPath);
    try {
      // note: A structurally valid link: the row exists, is confirmed, points back at the parent
      // through resolves and its foreign keys resolve - only its generation is another one.
      db.prepare(
        "insert into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
          "provider_project_id, journal_issue_id, verified_at, verification_json) values (?, ?, 'seed-commit', " +
          "'linear', 'seed-workspace', 'seed-team', 'seed-provider-project', 'seed-journal', " +
          "'2026-11-21T00:00:00.000Z', '{}')",
      ).run(cache.generation + 1, SELECTED_PROJECT.localProjectId);
      db.prepare(
        "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, state, " +
          "created_at, updated_at, resolves) values (?, ?, ?, 'seed-hash', '{}', 'confirmed', " +
          "'2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', ?)",
      ).run(repairId, cache.generation + 1, SELECTED_PROJECT.localProjectId, conflictId);
      db.prepare("update remote_outbox set resolved_by = ? where operation_id = ?").run(repairId, conflictId);
    } finally {
      db.close();
    }

    // invariant: The parent is not settled by another generation link: the bind still refuses
    // and nothing is replaced. A link this scope cannot honor is named as DAMAGED, and the route
    // for an absent repair (outbox-resolve) is never offered for it: a resolve refuses while that
    // link stands.
    const refused = await refusalOf(() =>
      bindRemoteAuthority(cache.context, {
        version: 1,
        selectorCommit: cache.commit,
        generation: cache.generation,
        checks: [positiveCheck()],
      }),
    );
    expect(refused.code).toBe("remote.effect-pending");
    expect(refused.message).toContain(conflictId);
    expect(refused.message).toContain("Its recorded resolvedBy link is damaged");
    expect(refused.message).not.toContain("outbox-resolve");
    expect(ledgerVersions(cache.location.dbPath)).toEqual(REGISTRY_VERSIONS.slice(0, 3));
  }, 30_000);

  test("a confirmed link without the reverse resolves pointer never settles the conflict", async () => {
    const conflictId = "00000000-0000-4000-8000-0000000009fc";
    const repairId = "00000000-0000-4000-8000-0000000009fd";
    const cache = await seedConflictedV3Cache("remote-v3-conflict-missing-backlink", conflictId);
    const db = new DatabaseSync(cache.location.dbPath);
    try {
      // note: Same generation and project, confirmed, but no reverse pointer at the parent: the
      // id is the only thing that names this conflict, so it is not its repair.
      db.prepare(
        "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, state, " +
          "created_at, updated_at) values (?, ?, ?, 'seed-hash', '{}', 'confirmed', " +
          "'2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
      ).run(repairId, cache.generation, SELECTED_PROJECT.localProjectId);
      db.prepare("update remote_outbox set resolved_by = ? where operation_id = ?").run(repairId, conflictId);
    } finally {
      db.close();
    }

    const refused = await refusalOf(() =>
      bindRemoteAuthority(cache.context, {
        version: 1,
        selectorCommit: cache.commit,
        generation: cache.generation,
        checks: [positiveCheck()],
      }),
    );
    expect(refused.code).toBe("remote.effect-pending");
    expect(refused.message).toContain(conflictId);
    // invariant: A confirmed state whose link this scope cannot honor is damaged, never absent:
    // the resolve route refuses while the link stands, so it is not offered.
    expect(refused.message).toContain("Its recorded resolvedBy link is damaged");
    expect(refused.message).not.toContain("outbox-resolve");
    expect(ledgerVersions(cache.location.dbPath)).toEqual(REGISTRY_VERSIONS.slice(0, 3));
  }, 30_000);

  test("the recovery open refuses a cache carrying a trigger on a recovery table", async () => {
    const fixture = remoteFixture("remote-v3-guard-trigger");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    seedRemoteV3Intent(location, "00000000-0000-4000-8000-0000000009fe", "enqueued");
    const db = new DatabaseSync(location.dbPath);
    try {
      // note: A foreign cache may carry a trigger that writes a domain table from an outbox
      // write; the surface is installed only over bytes that cannot do that.
      db.exec(
        "create trigger outbox_mirror after insert on remote_outbox begin " +
          "update issues set revision = revision; end;",
      );
    } finally {
      db.close();
    }
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });
    const refused = await refusalOf(() => openRemoteCacheRecovery(context, "read"));
    expect(refused.code).toBe("collaboration.upgrade-required");
    expect(refused.message).toContain("outbox_mirror");
    expect(refused.message).toContain("remote_outbox");
  }, 30_000);

  test("a settlement write is guarded by statement text, not by schema objects", async () => {
    const fixture = remoteFixture("remote-v3-guard-trigger-write");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    const frozenId = "00000000-0000-4000-8000-000000000a01";
    // note: A real frozen request, so the public settlement verb is decided by the write lane alone,
    // not by a payload failure.
    const request = intentRequest(fixture, commit, frozenId);
    writeV3RemoteLane(location);
    const db = new DatabaseSync(location.dbPath);
    try {
      db.prepare(
        "insert into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
          "provider_project_id, journal_issue_id, verified_at, verification_json) values (?, ?, ?, 'linear', ?, ?, ?, ?, ?, '{}')",
      ).run(
        generation,
        SELECTED_PROJECT.localProjectId,
        commit,
        SELECTED_PROJECT.workspaceId,
        SELECTED_PROJECT.teamId,
        SELECTED_PROJECT.projectId,
        SELECTED_PROJECT.journalIssueId,
        "2026-11-21T00:00:00.000Z",
      );
      db.prepare(
        "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, state, created_at, updated_at) " +
          "values (?, ?, ?, 'seed-hash', ?, 'enqueued', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
      ).run(frozenId, generation, SELECTED_PROJECT.localProjectId, JSON.stringify(request));
      // note: The trigger fires on the settlement write this case performs (an abandon is an update).
      // The accepted limitation: the write lane is guarded statement by statement plus the version
      // inventory, never schema-object by schema-object, because proving that here would leave a
      // foreign cache like this one with no exit - every settlement refuses while the bind refuses
      // to replace the still-unsettled cache.
      db.exec(
        "create trigger outbox_mirror after update on remote_outbox begin " +
          "update issues set revision = revision; end;",
      );
    } finally {
      db.close();
    }
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });

    // invariant: The settlement write IS admitted on such bytes. A write-side schema proof would
    // make every settlement verb refuse while the bind refuses to replace the unsettled cache, a
    // block with no supported exit; the trigger case is covered through the READ open instead.
    const abandoned = await abandonRemoteIntent(context, { operationId: frozenId, reason: "settle it" });
    expect(abandoned).toMatchObject({ operationId: frozenId, state: "abandoned" });
    expect(outboxRows(location.dbPath)).toContainEqual(
      expect.objectContaining({ operation_id: frozenId, state: "abandoned" }),
    );
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS.slice(0, 3));
  }, 30_000);

  test("the recovery guard allows the scalar replace() function and still refuses replace into", async () => {
    const fixture = remoteFixture("remote-v3-guard-replace");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    seedRemoteV3Intent(location, "00000000-0000-4000-8000-0000000009ff", "enqueued");
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });
    const recovery = await openRemoteCacheRecovery(context, "read");
    try {
      // invariant: A legitimate outbox statement calling replace(...) runs; only a replace
      // statement form is refused.
      expect(recovery.db.prepare("select replace('a-b', '-', '_') as v from remote_outbox").get()).toMatchObject({
        v: "a_b",
      });
      expect(() => recovery.db.exec("replace into remote_outbox(operation_id) values ('x')")).toThrow(
        /replace statement form/,
      );
    } finally {
      recovery.close();
    }
  }, 30_000);

  test("the unsettled refusal names exact executable commands instead of an age order", async () => {
    const fixture = remoteFixture("remote-v3-refusal-commands");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    writeV3RemoteLane(location);
    const db = new DatabaseSync(location.dbPath);
    try {
      db.exec(
        "insert into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
          "provider_project_id, journal_issue_id, verified_at, verification_json) values (1, 'seed-project', " +
          "'seed-commit', 'linear', 'seed-workspace', 'seed-team', 'seed-provider-project', 'seed-journal', " +
          "'2026-11-21T00:00:00.000Z', '{}');" +
          "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, state, " +
          "created_at, updated_at) values " +
          "('00000000-0000-4000-8000-0000000009e1', 1, 'seed-project', 'seed-hash', '{}', 'conflict', " +
          "'2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z'), " +
          "('00000000-0000-4000-8000-0000000009e2', 1, 'seed-project', 'seed-hash', '{}', 'unconfirmed', " +
          "'2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z'), " +
          "('00000000-0000-4000-8000-0000000009e3', 1, 'seed-project', 'seed-hash', '{}', 'enqueued', " +
          "'2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z');",
      );
    } finally {
      db.close();
    }
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });
    const refused = await refusalOf(() =>
      bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
    );
    expect(refused.code).toBe("remote.effect-pending");
    // note: A reconcile is copy-pasteable with its full command prefix.
    expect(refused.message).toContain("mstar store collaboration remote outbox-reconcile --harness <abs> --input <file|->");
    // note: An enqueued reviewed resolution is dispatched WITH its fork observation input.
    expect(refused.message).toContain("outbox-dispatch --harness <abs> --operation <uuid> --input <file|->");
    // note: A resolve only enqueues; dispatch and a confirming receipt follow. This conflict carries
    // no live repair, so no withdraw route is named for a repair here.
    expect(refused.message).toContain("outbox-resolve --harness <abs> --operation <conflicted-uuid> --input <file>");
    expect(refused.message).toContain("only enqueues the repair");
    expect(refused.message).toContain("record its confirming receipt");
    expect(refused.message).toContain("It carries no live repair");
    // invariant: Dispatch blocking is scoped, not age-ordered: the same generation and project, and
    // only a CONFLICT ancestor of a reviewed repair is exempt - an unconfirmed ancestor still blocks.
    expect(refused.message).toContain("dispatch blocking is scoped to the same generation and project");
    expect(refused.message).toContain("CONFLICT ancestor only (an unconfirmed ancestor still blocks)");
    // note: An unsent enqueued row names its shortest honest exit; nothing names an abandon for a
    // conflict row.
    expect(refused.message).toContain("outbox-abandon --harness <abs> --operation <uuid> --reason <text>");
    expect(refused.message).not.toContain("--operation <repair-uuid> --reason <text>");
    // note: No age-order promise: every listed state must be settled, and a blocked dispatch
    // names the intent that blocks it.
    expect(refused.message).not.toContain("oldest operation first");
    expect(refused.message).toContain("Settle every state");
    expect(refused.message).toContain("blocked dispatch names the intent");
  }, 30_000);

  /**
   * note: One v3 remote cache holding a conflicted intent and, in the state given, the repair its
   * own `resolved_by` names: the shape an operator meets after `outbox-resolve`.
   */
  function seedConflictRepair(
    location: CollaborationLocation,
    conflictId: string,
    repairId: string,
    repairState: RemoteIntentState,
    options: Readonly<{ conflictReceipt?: boolean }> = {},
  ): void {
    writeV3RemoteLane(location);
    const db = new DatabaseSync(location.dbPath);
    try {
      db.exec(
        "insert into remote_bindings(generation, project_key, selector_commit, provider, workspace_id, team_id, " +
          "provider_project_id, journal_issue_id, verified_at, verification_json) values (1, 'seed-project', " +
          "'seed-commit', 'linear', 'seed-workspace', 'seed-team', 'seed-provider-project', 'seed-journal', " +
          "'2026-11-21T00:00:00.000Z', '{}');" +
          "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, state, " +
          "created_at, updated_at, resolves) values " +
          "('" + repairId + "', 1, 'seed-project', 'seed-hash', '{}', '" + repairState + "', " +
          "'2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', '" + conflictId + "'), " +
          "('" + conflictId + "', 1, 'seed-project', 'seed-hash', '{}', 'conflict', " +
          "'2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', null);" +
          "update remote_outbox set resolved_by = '" + repairId + "' where operation_id = '" + conflictId + "';",
      );
      if (options.conflictReceipt === true) {
        // note: The recorded conflict receipt beside the tampered confirmed state is the shape the
        // laundering guard refuses a confirmation onto; the hint must not route back to it.
        db.prepare(
          "insert into remote_outbox_receipts(operation_id, receipt_hash, source, outcome, evidence_json, recorded_at) " +
            "values (?, 'seed-receipt-hash', 'receipt', 'conflict', '{}', '2026-11-21T00:00:00.000Z')",
        ).run(repairId);
      }
    } finally {
      db.close();
    }
  }

  test("the conflict refusal routes by the state of the repair its resolvedBy names", async () => {
    const cases: Array<{
      repairState: RemoteIntentState;
      damaged?: boolean;
      conflictReceipt?: boolean;
      exact: string[];
      absentInConflictLine?: string[];
    }> = [
      {
        // note: An enqueued repair may be withdrawn, or dispatched with the fork observation its
        // review requires.
        repairState: "enqueued",
        exact: [
          "its repair is enqueued, so follow the repair its resolvedBy names with `mstar store collaboration remote " +
            "outbox-show --harness <abs> --operation <repair-uuid>`",
          "then either withdraw it with `mstar store collaboration remote outbox-abandon --harness <abs> --operation " +
            "<repair-uuid> --reason <text>` or dispatch it with `mstar store collaboration remote outbox-dispatch " +
            "--harness <abs> --operation <repair-uuid> --input <file|->`",
        ],
      },
      {
        // note: The not-sent proof is the ORIGINAL dispatching host's own receipt, and only that
        // receipt records one: a reconcile accepts no not-sent outcome, so it is never named here.
        repairState: "unconfirmed",
        exact: [
          "its repair is unconfirmed, so follow the repair its resolvedBy names with `mstar store collaboration " +
            "remote outbox-show --harness <abs> --operation <repair-uuid>`",
          "An unconfirmed repair is withdrawable only behind its ORIGINAL dispatching host's own not-sent receipt: " +
            "record it with `mstar store collaboration remote outbox-receipt --harness <abs> --input <file|->` " +
            "(a reconcile records no not-sent outcome)",
          "and only then withdraw it with `mstar store collaboration remote outbox-abandon --harness <abs> " +
            "--operation <repair-uuid> --reason <text>`",
        ],
        absentInConflictLine: ["outbox-reconcile"],
      },
      {
        // note: The repair row is itself a conflict, so outbox-resolve accepts IT; resolving the
        // parent would refuse while this repair is linked, and no abandon applies to a conflict row.
        // The parent settles only once the chain reaches a confirmed repair.
        repairState: "conflict",
        exact: [
          "its repair is itself a conflict row, so prepare the reviewed replacement of THAT repair row with " +
            "`mstar store collaboration remote outbox-resolve --harness <abs> --operation <repair-uuid> --input <file>`",
          "a resolve only enqueues the repair - then dispatch it with `mstar store collaboration remote " +
            "outbox-dispatch --harness <abs> --operation <new-uuid> --input <file|->`",
          "record its confirming receipt with `mstar store collaboration remote outbox-receipt --harness <abs> --input <file|->`",
          "the parent settles once its repair chain reaches a confirmed repair that holds its recorded receipt",
        ],
        absentInConflictLine: ["--operation <repair-uuid> --reason <text>", "outbox-abandon", "--operation <conflicted-uuid>"],
      },
      {
        // invariant: A link this scope cannot honor is named as DAMAGED, never as an absent repair: a
        // resolve refuses while that link stands, so the outbox-resolve route is not offered for it.
        repairState: "enqueued",
        damaged: true,
        exact: [
          "Its recorded resolvedBy link is damaged",
          "rebuild the derived cache through the ordinary bootstrap",
          "stop every checkout of this repository that has the cache bound",
          "settle every other unsettled intent that cache holds through the outbox verbs its own state line names",
          "keep the cache file as evidence - move it aside under a retained name instead of deleting it",
          "confirm the checked selector and this checkout's binding satisfy a fresh reviewed bind",
          "remove the name the checkout reads (or confirm it is gone)",
          "the retained copy preserves it, and an operator can inspect it later",
        ],
        absentInConflictLine: ["outbox-resolve", "outbox-reconcile", "fresh reviewed bind once the checked selector", "stop this checkout", "remove the cache file"],
      },
      {
        // invariant: A confirmed repair holding only a conflict receipt is the laundering shape the
        // guard refuses a receipt onto: the hint names the rebuild route (every bound checkout),
        // never a confirmation receipt or outbox-resolve.
        repairState: "confirmed",
        conflictReceipt: true,
        exact: [
          "its repair is marked confirmed but holds only a recorded conflict receipt",
          "recorded state contradicts its recorded evidence",
          "rebuild the derived cache through the ordinary bootstrap",
          "stop every checkout of this repository that has the cache bound",
          "settle every other unsettled intent that cache holds through the outbox verbs its own state line names",
          "keep the cache file as evidence - move it aside under a retained name instead of deleting it",
          "confirm the checked selector and this checkout's binding satisfy a fresh reviewed bind",
          "run `mstar store collaboration remote status`",
          "fresh reviewed remote bind",
          "the pending intent's record is not preserved by the rebuild itself",
          "the retained copy preserves it, and an operator can inspect it later",
        ],
        absentInConflictLine: ["outbox-resolve", "outbox-receipt", "record that receipt with", "stop this checkout", "remove the cache file"],
      },
    ];
    for (const [index, entry] of cases.entries()) {
      const fixture = remoteFixture("remote-v3-repair-state-" + entry.repairState + (entry.damaged === true ? "-damaged" : ""));
      const commit = fixture.publish(fixture.payload());
      const generation = Number(fixture.payload().generation);
      const context = contextAt(fixture.repo);
      const location = locationAt(fixture.repo);
      const conflictId = "00000000-0000-4000-8000-000000000b0" + String(index);
      const repairId = "00000000-0000-4000-8000-000000000c0" + String(index);
      seedConflictRepair(location, conflictId, repairId, entry.repairState, { conflictReceipt: entry.conflictReceipt === true });
      if (entry.damaged === true) {
        // note: Same generation and project, but no reverse resolves pointer: the link is broken,
        // and the linked row's own live state must never be routed as this conflict's repair.
        const db = new DatabaseSync(location.dbPath);
        try {
          db.prepare("update remote_outbox set resolves = null where operation_id = ?").run(repairId);
        } finally {
          db.close();
        }
      }
      const recorded = recordedGeneration(location);
      writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });
      const refused = await refusalOf(() =>
        bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
      );
      expect(refused.code).toBe("remote.effect-pending");
      expect(refused.message).toContain("state conflict: oldest operation " + conflictId);
      for (const exact of entry.exact) expect(refused.message).toContain(exact);
      const conflictLine = refused.message
        .split("\n")
        .find((line) => line.includes("state conflict: oldest operation " + conflictId));
      expect(conflictLine).toBeDefined();
      for (const absent of entry.absentInConflictLine ?? []) expect(conflictLine).not.toContain(absent);
    }
  }, 90_000);

  test("the recovery surface guard is fail closed over its allowlist", async () => {
    const fixture = remoteFixture("remote-v3-guard-closed");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    seedRemoteV3Intent(location, "00000000-0000-4000-8000-0000000009f9", "enqueued");
    const recorded = recordedGeneration(location);
    writeRemoteCollaborationBinding(context, { repoKey: fixture.repoKey, selectorCommit: commit, generation, ...recorded });
    const recovery = await openRemoteCacheRecovery(context, "read");
    try {
      // invariant: A domain table named in ANY casing is refused, not just the exact spelling.
      expect(() => recovery.db.prepare("select count(*) as n from ISSUES").get()).toThrow(/"issues"/);
      // invariant: A statement naming no surface table - unclassifiable against the allowlist -
      // is refused rather than let through.
      expect(() => recovery.db.prepare("select count(*) as n from sqlite_master").get()).toThrow(/recovery-surface/);
      // invariant: A statement form that could escape the surface is refused even over a surface table.
      expect(() => recovery.db.prepare("pragma table_info(remote_outbox)").get()).toThrow(/pragma/);
      // invariant: A legitimate outbox statement still runs.
      expect(recovery.db.prepare("select count(*) as n from remote_outbox").get()).toMatchObject({ n: 1 });
    } finally {
      recovery.close();
    }
  }, 30_000);

  test("a settled outbox ledger with a prepared composite survives the replacement and finalizes without a second send", async () => {
    // invariant: A confirmed intent is settled, so the bind replaces the cache - but the receipt it
    // carries is exactly what the prepared execution composite reads to finalize. Dropping the
    // ledger would leave the composite with no proof of the provider effect it already caused.
    const fixture = remoteFixture("remote-v3-composite-carry");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] });
    await ingestRemoteObservation(context, observation(positiveCheck(), { selectorCommit: commit, generation }));

    // note: A prepared composite reserves its intent in the execution store, freezes one provider
    // intent under that same reservation, and confirms it - the state a crash before finalization
    // leaves behind.
    (await initializeStore(context)).close();
    const state = await readExecutionState(context);
    const key = { executionStoreId: state.storeId, executionEpoch: state.epoch, operationId: "composite-carry" };
    const intent: CompositeIntent = {
      key,
      kind: "residual-add",
      requestHash: "composite-carry-hash",
      target: { repoKey: fixture.repoKey, mode: "remote", storeId: state.storeId, epoch: state.epoch },
      scope: { workflowId: null, planId: null },
      actor: "project-manager",
      expectedExecution: state.token,
      frozenPayload: JSON.stringify({ entries: 1 }),
    };
    await withExecutionTransaction(context, (tx) => reserveCompositeIntent(tx, intent, { revision: tx.execution.revision }));
    const providerId = remoteCompositeOperationId(key);
    const executionKey = { ...key, operationId: providerId };
    const frozen = await prepareRemoteIntent(context, {
      ...issueIntent(fixture, commit, providerId),
      executionKey,
    });
    const attemptId = attemptOf(await dispatchRemoteIntent(context, providerId));
    await recordRemoteReceipt(context, {
      ...receiptInput(commit, providerId, attemptId, frozen.requestHash, {
        kind: "confirmed",
        identity: { ...providerScope(), issueId: MSTAR_ISSUE },
        recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef",
        event: recordedEvent(location.dbPath, providerId),
      }),
      generation,
    });

    // note: Back to the v3 generation with that confirmed ledger in place, which is the shape a
    // replacement must carry rather than discard.
    downgradeToV3(location);
    expect(ledgerVersions(location.dbPath)).toEqual([1, 2, 3]);
    expect(outboxRows(location.dbPath)).toContainEqual(
      expect.objectContaining({ operation_id: providerId, state: "confirmed", attempt_id: attemptId }),
    );
    const recorded = recordedGeneration(location);

    const bound = await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: commit,
      generation,
      checks: [positiveCheck()],
    });
    expect(bound).toMatchObject({ generation, binding: { mode: "remote", ...recorded } });
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS);

    // invariant: The confirmed row AND its receipt survive the replacement, so the successor still
    // proves the provider effect; losing either leaves the composite unable to finalize safely.
    expect(outboxRows(location.dbPath)).toContainEqual(
      expect.objectContaining({ operation_id: providerId, state: "confirmed", attempt_id: attemptId }),
    );
    expect(outboxReceipts(location.dbPath)).toEqual([
      expect.objectContaining({ operation_id: providerId, outcome: "confirmed" }),
    ]);
    expect(await readRemoteIntent(context, providerId)).toMatchObject({ state: "confirmed", attemptId });

    // invariant: Finalizing after the bind replays the SAME confirmed effect and never issues a
    // second provider event: prepare finds the carried intent instead of freezing a new one.
    const finalized = await runCollaborationComposite(context, intent, {
      apply: () => {
        throw new Error("a remote composite never writes the local collaboration lane");
      },
      finalize: (_tx: ExecutionTransaction, receipt: CollaborationEffectReceipt) => receipt.facts,
      remote: async (scope: StoreContext) =>
        prepareRemoteIntent(scope, { ...issueIntent(fixture, commit, providerId), executionKey }),
    });
    expect(finalized).toContain(providerId);
    expect(await intentPhases(context, key.operationId)).toEqual(["confirmed"]);
    // invariant: Still exactly one intent and one receipt: the effect was READ, never re-sent.
    expect(outboxRows(location.dbPath)).toHaveLength(1);
    expect(outboxReceipts(location.dbPath)).toHaveLength(1);
  }, 30_000);

  test("a repaired conflict clears the replacement gate only once its repair is settled", async () => {
    // invariant: `outbox-resolve` records the repair as a SEPARATE intent linked by `resolved_by`
    // and the original stays `conflict` for as long as it exists, so a raw-state count can never
    // reach zero. Only the repair chain's settlement releases the cache - and not one step earlier.
    const fixture = remoteFixture("remote-v3-repaired-conflict");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] });
    await ingestRemoteObservation(context, observation(positiveCheck(), { selectorCommit: commit, generation }));

    // note: A real conflicted fork: prepared, dispatched, and settled with the competing heads.
    const conflictedId = "00000000-0000-4000-8000-0000000007f1";
    const conflicted = await prepareRemoteIntent(context, journalIntent(fixture, commit, conflictedId));
    const fork = journalFork(fixture);
    await recordRemoteReceipt(context, {
      ...receiptInput(commit, conflictedId, attemptOf(await dispatchRemoteIntent(context, conflictedId)), conflicted.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_PROJECT_HEAD],
        observedHeads: fork.heads,
        observedRecords: fork.records,
      }),
      generation,
    });
    const repairId = "00000000-0000-4000-8000-0000000007f2";
    await prepareRemoteResolution(context, conflictedId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(fixture, repairId, fork.heads),
    });
    const repairHash = outboxRows(location.dbPath).find((row) => row.operation_id === repairId)!.request_hash;

    // note: The v3 generation carries both rows, and the repair is still only enqueued.
    downgradeToV3(location);
    const recorded = recordedGeneration(location);
    expect(outboxRows(location.dbPath).map((row) => [row.operation_id, row.state])).toEqual([
      [conflictedId, "conflict"],
      [repairId, "enqueued"],
    ]);

    // invariant: A live repair is an outstanding send, so the fork it repairs still holds the cache.
    const pending = await refusalOf(() =>
      bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
    );
    expect(pending.code).toBe("remote.effect-pending");
    expect(ledgerVersions(location.dbPath)).toEqual([1, 2, 3]);

    // invariant: Confirming the repair settles the fork; the bind now replaces the cache, and the
    // settled chain is carried so the original row and its repair stay inspectable.
    confirmSeededIntent(location.dbPath, repairId, {
      attemptId: "00000000-0000-4000-8000-0000000007f3",
      requestHash: repairHash,
      issueId: JOURNAL_ANCHOR,
      recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee5",
      event: recordedEvent(location.dbPath, repairId),
    });
    const bound = await bindRemoteAuthority(context, {
      version: 1,
      selectorCommit: commit,
      generation,
      checks: [positiveCheck()],
    });
    expect(bound).toMatchObject({ generation, binding: { mode: "remote", ...recorded } });
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS);
    expect(outboxRows(location.dbPath).map((row) => [row.operation_id, row.state])).toEqual([
      [conflictedId, "conflict"],
      [repairId, "confirmed"],
    ]);
  }, 30_000);

  test("a withdrawn repair leaves its fork unsettled, so the replacement still refuses", async () => {
    // invariant: A repair is a REVIEWED RESOLUTION, not a settlement of its own: only a confirmed
    // repair settles the fork it replaced. Withdrawing the repair (abandoning it) leaves the
    // original conflict exactly as unsettled as before, and another resolution may still follow -
    // so the replacement gate stays closed instead of publishing a v3 cache whose fork never merged.
    const fixture = remoteFixture("remote-v3-withdrawn-repair");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] });
    await ingestRemoteObservation(context, observation(positiveCheck(), { selectorCommit: commit, generation }));

    // note: A real conflicted fork with a reviewed repair prepared over it.
    const conflictedId = "00000000-0000-4000-8000-000000000801";
    const conflicted = await prepareRemoteIntent(context, journalIntent(fixture, commit, conflictedId));
    const fork = journalFork(fixture);
    await recordRemoteReceipt(context, {
      ...receiptInput(commit, conflictedId, attemptOf(await dispatchRemoteIntent(context, conflictedId)), conflicted.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_PROJECT_HEAD],
        observedHeads: fork.heads,
        observedRecords: fork.records,
      }),
      generation,
    });
    const repairId = "00000000-0000-4000-8000-000000000802";
    await prepareRemoteResolution(context, conflictedId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(fixture, repairId, fork.heads),
    });

    // note: Back to the v3 generation, which is the shape the replacement floor covers.
    downgradeToV3(location);
    const recorded = recordedGeneration(location);

    // invariant: The repair is withdrawn through the real outbox verb on those same bytes.
    const withdrawn = await abandonRemoteIntent(context, { operationId: repairId, reason: "reviewed repair withdrawn" });
    expect(withdrawn).toMatchObject({ state: "abandoned" });
    expect(outboxRows(location.dbPath).map((row) => [row.operation_id, row.state])).toEqual([
      [conflictedId, "conflict"],
      [repairId, "abandoned"],
    ]);

    // invariant: No repair ever merged the fork, so the replacement is refused by route and the v3
    // bytes - the only record of the fork and of the withdrawal - stay exactly in place.
    const refused = await refusalOf(() =>
      bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
    );
    expect(refused.code).toBe("remote.effect-pending");
    expect(refused.message).toContain("outbox-resolve");
    expect(detailsOf(refused)).toMatchObject({ unsettledCount: 1 });
    expect(ledgerVersions(location.dbPath)).toEqual([1, 2, 3]);
    expect(metaRecord(location.dbPath)).toMatchObject({ store_id: recorded.storeId, authority_epoch: recorded.epoch });
  }, 30_000);

  test("a settlement write inside the replacement window is refused, never dropped by the rename", async () => {
    // invariant: The final probe, the ledger comparison and the rename are one exclusive writer
    // scope shared with `withRemoteCacheWrite`. A cooperative settlement write that begins inside
    // that window cannot commit behind the comparison, so the successor never omits evidence that
    // reached the predecessor: either the write is refused and the carried ledger is complete, or it
    // committed before the window and the replacement refuses instead. Losing a committed receipt is
    // the failure this asserts against.
    const fixture = remoteFixture("remote-v3-concurrent-settlement");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] });
    await ingestRemoteObservation(context, observation(positiveCheck(), { selectorCommit: commit, generation }));

    // note: A conflicted fork whose repair IS confirmed: settled, so the replacement is admitted,
    // and the conflicted row still accepts appended evidence - exactly the case a receipt landing
    // inside the replacement window could hide.
    const conflictedId = "00000000-0000-4000-8000-000000000811";
    const conflicted = await prepareRemoteIntent(context, journalIntent(fixture, commit, conflictedId));
    const attemptId = attemptOf(await dispatchRemoteIntent(context, conflictedId));
    const fork = journalFork(fixture);
    await recordRemoteReceipt(context, {
      ...receiptInput(commit, conflictedId, attemptId, conflicted.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_PROJECT_HEAD],
        observedHeads: fork.heads,
        observedRecords: fork.records,
      }),
      generation,
    });
    const repairId = "00000000-0000-4000-8000-000000000812";
    await prepareRemoteResolution(context, conflictedId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(fixture, repairId, fork.heads),
    });
    const repairHash = outboxRows(location.dbPath).find((row) => row.operation_id === repairId)!.request_hash;
    downgradeToV3(location);
    const recorded = recordedGeneration(location);
    confirmSeededIntent(location.dbPath, repairId, {
      attemptId: "00000000-0000-4000-8000-000000000813",
      requestHash: repairHash,
      issueId: JOURNAL_ANCHOR,
      recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee7",
      event: recordedEvent(location.dbPath, repairId),
    });
    expect(outboxReceipts(location.dbPath)).toHaveLength(2);

    // note: A real settlement write arrives exactly between the comparison and the rename.
    let settlement = "unknown";
    setRemoteCacheReplacementCommitGapForTest(() => {
      return recordRemoteReceipt(context, {
        ...receiptInput(commit, conflictedId, attemptId, conflicted.requestHash, { kind: "not-sent", code: "pre-send" }, {
          generation,
        }),
      }).then(
        () => {
          settlement = "committed";
        },
        (error: unknown) => {
          settlement =
            error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
              ? error.code
              : "failed";
        },
      );
    });
    let bound: Awaited<ReturnType<typeof bindRemoteAuthority>> | undefined;
    try {
      bound = await bindRemoteAuthority(context, {
        version: 1,
        selectorCommit: commit,
        generation,
        checks: [positiveCheck()],
      });
    } finally {
      setRemoteCacheReplacementCommitGapForTest(undefined);
    }

    // invariant: The window excludes the settlement writer entirely: it is either refused by the
    // held lane (`store.busy`) - and then nothing was lost, because it never committed - or it
    // committed BEFORE the comparison, which then refuses the replacement instead. Neither branch
    // may end with a committed receipt that the successor omits.
    expect(settlement).toBe("store.busy");
    const successorReceipts = outboxReceipts(location.dbPath);
    expect(successorReceipts).toHaveLength(2);
    expect(successorReceipts.some((row) => row.outcome === "not-sent")).toBe(false);
    // invariant: The replacement completed over the complete ledger, keeping the recorded identity.
    expect(bound).toMatchObject({ generation, binding: { mode: "remote", ...recorded } });
    expect(ledgerVersions(location.dbPath)).toEqual(REGISTRY_VERSIONS);
    expect(outboxRows(location.dbPath).map((row) => [row.operation_id, row.state])).toEqual([
      [conflictedId, "conflict"],
      [repairId, "confirmed"],
    ]);
  }, 30_000);

  test("a receipt committed after the carried snapshot but before the guard lock refuses the replacement and survives", async () => {
    // invariant: The settled-ledger snapshot is taken BEFORE the guard takes the write lock, so a
    // receipt that commits in between reaches the predecessor and is carried by no snapshot. Only
    // the guard's re-read comparison keeps it from being dropped: the replacement must refuse and
    // leave the predecessor - with that receipt - named.
    const fixture = remoteFixture("remote-v3-pre-window-receipt");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] });
    await ingestRemoteObservation(context, observation(positiveCheck(), { selectorCommit: commit, generation }));

    // note: A conflicted fork whose repair IS confirmed: settled, so the replacement is admitted,
    // and the conflicted row still accepts appended evidence - the receipt that lands in the gap.
    const conflictedId = "00000000-0000-4000-8000-000000000821";
    const conflicted = await prepareRemoteIntent(context, journalIntent(fixture, commit, conflictedId));
    const attemptId = attemptOf(await dispatchRemoteIntent(context, conflictedId));
    const fork = journalFork(fixture);
    await recordRemoteReceipt(context, {
      ...receiptInput(commit, conflictedId, attemptId, conflicted.requestHash, {
        kind: "conflict",
        expectedHeads: [OBSERVED_PROJECT_HEAD],
        observedHeads: fork.heads,
        observedRecords: fork.records,
      }),
      generation,
    });
    const repairId = "00000000-0000-4000-8000-000000000822";
    await prepareRemoteResolution(context, conflictedId, {
      operationId: repairId,
      operator: "operator-one",
      reason: "merge the fork",
      event: journalEvent(fixture, repairId, fork.heads),
    });
    const repairHash = outboxRows(location.dbPath).find((row) => row.operation_id === repairId)!.request_hash;
    downgradeToV3(location);
    const recorded = recordedGeneration(location);
    confirmSeededIntent(location.dbPath, repairId, {
      attemptId: "00000000-0000-4000-8000-000000000823",
      requestHash: repairHash,
      issueId: JOURNAL_ANCHOR,
      recordId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee8",
      event: recordedEvent(location.dbPath, repairId),
    });
    expect(outboxReceipts(location.dbPath)).toHaveLength(2);

    // note: The real settlement write commits on the predecessor AFTER the carried snapshot was
    // read and BEFORE the guard's write lock, so it can only be caught by the re-read comparison.
    let settlement = "unknown";
    setRemoteCacheReplacementLedgerGapForTest(() =>
      recordRemoteReceipt(context, {
        ...receiptInput(commit, conflictedId, attemptId, conflicted.requestHash, { kind: "not-sent", code: "pre-send" }, {
          generation,
        }),
      }).then(
        () => {
          settlement = "committed";
        },
        (error: unknown) => {
          settlement =
            error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
              ? error.code
              : "failed";
        },
      ),
    );
    let refused: { code: string; message: string; details?: unknown };
    try {
      refused = await refusalOf(() =>
        bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
      );
    } finally {
      setRemoteCacheReplacementLedgerGapForTest(undefined);
    }

    // invariant: The receipt really committed on the predecessor, so the refusal is about the
    // changed carried ledger rather than about a write that never landed.
    expect(settlement).toBe("committed");
    // invariant: The changed ledger refuses the replacement by route.
    expect(refused.code).toBe("collaboration.upgrade-required");
    // invariant: The predecessor is still named, keeps its v3 generation and identity, and still
    // carries the receipt the successor would have dropped.
    expect(ledgerVersions(location.dbPath)).toEqual([1, 2, 3]);
    expect(metaRecord(location.dbPath)).toMatchObject({ store_id: recorded.storeId, authority_epoch: recorded.epoch });
    const survivorReceipts = outboxReceipts(location.dbPath);
    expect(survivorReceipts).toHaveLength(3);
    expect(survivorReceipts.filter((row) => row.outcome === "not-sent")).toHaveLength(1);
  }, 30_000);

  test("the settlement admission refuses a v3 local lane, a pre-v3 remote lane and an ordinary v3 remote read", async () => {
    // invariant: The settlement admission serves exactly one shape - the remote checkout's own v3
    // cache. Every other lane keeps its ordinary refusal, so a regression dropping either the mode
    // or the version condition is caught here instead of widening what the outbox verbs touch.
    const localRepo = makeRepo("https://github.com/v3-local/settlement.git");
    const localContext = contextAt(localRepo);
    const localLane = locationAt(localRepo);
    writeV3Lane(localLane);
    activate(localLane.dbPath);
    // invariant: A LOCAL v3 lane refuses the settlement admission by MODE: the cache scope requires a
    // remote checkout, so a settlement request never reads or migrates its ledger.
    const localRows = outboxRows(localLane.dbPath);
    const localLedger = ledgerRows(localLane.dbPath);
    const localTables = tableNames(localLane.dbPath);
    const local = await refusalOf(() => withRemoteCacheWrite(localContext, () => "unused", { settleOutbox: true }));
    expect(local.code).toBe("collaboration.stale-binding");
    expect(local.message).toContain("not remote");
    expect(outboxRows(localLane.dbPath)).toEqual(localRows);
    expect(ledgerRows(localLane.dbPath)).toEqual(localLedger);
    expect(tableNames(localLane.dbPath)).toEqual(localTables);

    // note: A pre-v3 remote lane has no outbox at all, so the settlement admission never applies.
    const oldFixture = remoteFixture("remote-v2-settlement");
    const oldCommit = oldFixture.publish(oldFixture.payload());
    const oldGeneration = Number(oldFixture.payload().generation);
    const oldContext = contextAt(oldFixture.repo);
    const oldLane = locationAt(oldFixture.repo);
    writeV2RemoteLane(oldLane);
    writeRemoteCollaborationBinding(oldContext, {
      repoKey: oldFixture.repoKey,
      selectorCommit: oldCommit,
      generation: oldGeneration,
      ...recordedGeneration(oldLane),
    });
    const oldLedger = ledgerRows(oldLane.dbPath);
    const oldTables = tableNames(oldLane.dbPath);
    const older = await refusalOf(() => withRemoteCacheWrite(oldContext, () => "unused", { settleOutbox: true }));
    expect(older.code).toBe("collaboration.upgrade-required");
    expect(older.message).toContain("mstar store collaboration remote bind");
    expect(ledgerRows(oldLane.dbPath)).toEqual(oldLedger);
    expect(tableNames(oldLane.dbPath)).toEqual(oldTables);

    // invariant: An ORDINARY read of the same v3 cache stays refused: settlement admits the outbox
    // verbs alone, never every remote read.
    const freshFixture = remoteFixture("remote-v3-ordinary-read");
    const freshCommit = freshFixture.publish(freshFixture.payload());
    const freshGeneration = Number(freshFixture.payload().generation);
    const freshContext = contextAt(freshFixture.repo);
    const freshLane = locationAt(freshFixture.repo);
    writeV3RemoteLane(freshLane);
    writeRemoteCollaborationBinding(freshContext, {
      repoKey: freshFixture.repoKey,
      selectorCommit: freshCommit,
      generation: freshGeneration,
      ...recordedGeneration(freshLane),
    });
    const freshLedger = ledgerRows(freshLane.dbPath);
    const freshTables = tableNames(freshLane.dbPath);
    const ordinary = await refusalOf(() => readRemoteCacheAuthority(freshContext));
    expect(ordinary.code).toBe("collaboration.upgrade-required");
    expect(ordinary.message).toContain("remote bind");
    expect(ledgerRows(freshLane.dbPath)).toEqual(freshLedger);
    expect(tableNames(freshLane.dbPath)).toEqual(freshTables);
    // invariant: The settlement admission is the ONE exception on the same bytes: a request that
    // asks to settle them is admitted, proving the ordinary refusal above is the mode/version
    // boundary rather than an unreadable lane.
    expect(
      await withRemoteCacheWrite(freshContext, () => "admitted", { settleOutbox: true }),
    ).toBe("admitted");
    expect(ledgerRows(freshLane.dbPath)).toEqual(freshLedger);
  }, 30_000);

  test("an expired access check behind an unsettled v3 intent is refreshable on that generation", async () => {
    // invariant: The replacement that upgrades a v3 cache refuses while one intent's provider outcome is
    // unknown, and the settlement verbs re-prove a CURRENT access check. Refusing the observation that
    // refreshes that check left the operator with no order at all: no refresh, so no settlement, so no
    // replacement. The observation writes only tables v3 carries unchanged, so it is admitted there.
    const fixture = remoteFixture("v3-repair-order");
    const commit = fixture.publish(fixture.payload());
    const generation = Number(fixture.payload().generation);
    const context = contextAt(fixture.repo);
    const location = locationAt(fixture.repo);
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] });
    await ingestRemoteObservation(context, { ...observation(positiveCheck()), selectorCommit: commit, generation });
    // note: The state an interrupted settlement leaves behind: the cache is a v3 generation again, its
    // one intent has no known provider outcome, and the check a dispatch must re-prove has expired.
    downgradeToV3(location);
    const db = new DatabaseSync(location.dbPath);
    try {
      db.prepare("update remote_bindings set verified_at = ?").run(new Date(Date.now() - 61_000).toISOString());
      // note: the downgrade rewrites the cache to its v3 generation, so the observation row a refresh
      // advances is re-seeded at the revision that generation left behind.
      db.prepare(
        "insert into remote_observations(generation, project_key, revision, as_of, completeness, code, snapshot_json, received_at) " +
          "values (?, ?, 1, null, 'unavailable', null, null, '2026-11-21T00:00:00.000Z')",
      ).run(generation, SELECTED_PROJECT.localProjectId);
      db.prepare(
        "insert into remote_outbox(operation_id, generation, project_key, request_hash, request_json, execution_key_json, " +
          "state, attempt_id, created_at, updated_at, abandon_reason, resolves, resolved_by) " +
          "values (?, ?, ?, ?, ?, null, 'conflict', null, ?, ?, null, null, null)",
      ).run(
        "repair-conflict",
        generation,
        SELECTED_PROJECT.localProjectId,
        "request-hash",
        "{}",
        "2026-11-21T00:00:00.000Z",
        "2026-11-21T00:00:00.000Z",
      );
    } finally {
      db.close();
    }
    const ledgerBefore = ledgerRows(location.dbPath);

    // invariant: The replacement refuses those bytes, by route, while that intent is unsettled.
    const blocked = await refusalOf(() =>
      bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation, checks: [positiveCheck()] }),
    );
    expect(blocked.code).toBe("remote.effect-pending");
    // invariant: The lane was not replaced by that attempt.
    expect(ledgerRows(location.dbPath)).toEqual(ledgerBefore);

    // invariant: The supported first step now exists: refreshing the check on this generation.
    const refreshed = await ingestRemoteObservation(context, {
      ...observation(positiveCheck(), { expectRevision: 1 }),
      selectorCommit: commit,
      generation,
    });
    expect(refreshed).toMatchObject({ projectId: SELECTED_PROJECT.localProjectId, revision: 2 });
    const bound = new DatabaseSync(location.dbPath);
    try {
      const row = bound.prepare("select verified_at from remote_bindings").get() as { verified_at?: unknown };
      expect(Date.now() - Date.parse(String(row.verified_at))).toBeLessThan(61_000);
    } finally {
      bound.close();
    }
    // invariant: The refresh wrote no schema: the lane is still the v3 generation whose ledger refuses
    // the replacement until its intent is settled.
    expect(ledgerRows(location.dbPath)).toEqual(ledgerBefore);
  }, 30_000);
});

/**
 * invariant: Review wave 5. The exchange decides its topology from the `route` each ledger row
 * recorded at stage — never from a peer-lane probe, which a two-checkout exchange cannot answer —
 * and no discard may leave provider work alive. These are the refusals and releases an operator
 * recovers from, asserted at the engine boundary the CLI delegates to.
 */
describe("cross-authority move route and discard", () => {
  const actor = "project-manager";

  /** note: One activated local lane plus one captured record, the source half a local exchange stages. */
  async function localSourceLane(name: string) {
    const key = `github.com/local-fixture/${name}`;
    const context = contextAt(makeRepo(`https://${key}.git`));
    const location = resolveCollaborationLocation(context);
    await initializeCollaborationStore(location);
    activate(location.dbPath);
    const created = await captureIssue(context, fixtureCapture(`Route source ${name}`) as never, {
      operationId: "00000000-0000-4000-8000-000000000a01",
      actor,
    });
    return { context, dbPath: location.dbPath, issueId: created.issueId };
  }

  test("a local exchange source records its route and releases only its own half", async () => {
    // invariant: Finding 1. The peer's lane is unreachable from this checkout, so the discard reads
    // the staged row's route instead of probing: an exchange source releases its half, and the record
    // it fenced becomes writable again. A probe answers nothing here and the old path delegated to a
    // one-checkout release that refuses.
    const cache = await outboxCache("route-local-source");
    const source = await localSourceLane("route-local-source");
    const operationId = "00000000-0000-4000-8000-000000000a11";
    const request = {
      operationId,
      actor,
      sourceIssueId: source.issueId,
      destinationAuthority: cache.fixture.repoKey,
      destinationProject: "fixture-project",
      reason: "cross to the provider",
    };
    const staged = await moveAcrossByDocument(source.context, request, null);
    expect(staged).toMatchObject({ phase: "staged", side: "source" });
    expect(routeOfRow(source.dbPath, operationId, "source")).toBe("local-remote");

    const released = await discardAcrossAuthorities(source.context, request);
    expect(released.phase).toBe("discarded");
    // invariant: The fence is gone with the row: the record this authority kept is writable again.
    await appendOccurrence(
      source.context,
      source.issueId,
      // note: the same identity triple the capture established, with a fresh observation key.
      { ...fixtureCapture("Route source route-local-source"), occurrenceKey: "run-after-route-discard" } as never,
      { operationId: "00000000-0000-4000-8000-000000000a12", actor, expectedRevision: 2 },
    );
  }, 30_000);

  test("a remote destination refuses a remote-sourced request before staging anything", async () => {
    // invariant: Finding 2. The source's recorded route says it was staged by a remote checkout, and
    // the request document carries it, so the destination refuses remote-to-remote before writing a
    // row or freezing a create. A probe cannot see a separate-home source and lets the move through.
    const source = await outboxCache("route-remote-source");
    // note: The destination's selector is created only AFTER the source staged, which is exactly a
    // two-checkout exchange: the source's own home cannot answer for the peer lane at all.
    const destination = remoteFixture("route-remote-destination");
    const operationId = "00000000-0000-4000-8000-000000000a21";
    const request = {
      operationId,
      actor,
      sourceIssueId: FORGED_ISSUE_REF,
      destinationAuthority: destination.repoKey,
      destinationProject: "fixture-project",
      reason: "remote to remote",
    };
    const staged = await moveAcrossByDocument(source.context, request, null);
    expect(staged.phase).toBe("staged");
    expect(staged.document?.route).toBe("remote-unknown");
    expect(routeOfRow(source.dbPath, operationId, "source")).toBe("remote-unknown");

    const destinationContext = contextAt(destination.repo);
    const commit = destination.publish(destination.payload());
    await bindRemoteAuthority(destinationContext, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    await ingestRemoteObservation(destinationContext, observation(positiveCheck(), { selectorCommit: commit, generation: 3 }));
    const destinationDbPath = locationAt(destination.repo).dbPath;
    const refused = await refusalOf(() => moveAcrossByDocument(destinationContext, request, staged.document!));
    expect(refused.code).toBe("collaboration.mode-unavailable");
    // invariant: Nothing was staged and nothing was enqueued: no provider create can ever land.
    const db = new DatabaseSync(destinationDbPath);
    try {
      expect(db.prepare("select count(*) as n from issue_moves").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    expect(outboxRows(destinationDbPath)).toEqual([]);
  }, 30_000);

  test("a remote destination cannot discard while its provider create may still land", async () => {
    // invariant: Finding 3. The create intent is enqueued and the admission was never recorded, so
    // abandoning the move here would leave a provider record no ledger admits. Only a create that can
    // never land lets this half release — and then it does, without touching the source's half.
    const cache = await outboxCache("route-live-create");
    const source = await localSourceLane("route-live-create");
    const operationId = "00000000-0000-4000-8000-000000000a31";
    const request = {
      operationId,
      actor,
      sourceIssueId: source.issueId,
      destinationAuthority: cache.fixture.repoKey,
      destinationProject: "fixture-project",
      reason: "cross to the provider",
    };
    const staged = await moveAcrossByDocument(source.context, request, null);
    const destinationRequest = { ...request, sourceIssueId: staged.document!.issueRef };
    const destinationStaged = await refusalOf(() => moveAcrossByDocument(cache.context, destinationRequest, staged.document!));
    expect(destinationStaged.code).toBe("remote.effect-pending");
    expect(outboxRows(cache.dbPath).filter((row) => row.state === "enqueued").length).toBe(1);

    const refused = await refusalOf(() => discardAcrossAuthorities(cache.context, destinationRequest));
    expect(refused.code).toBe("collaboration.move-phase-invalid");
    expect(refused.message).toContain("provider create");

    await abandonRemoteIntent(cache.context, {
      operationId: remoteMoveOperationId(operationId, "create"),
      reason: "the exchange was abandoned before the provider create was sent",
    });
    const released = await discardAcrossAuthorities(cache.context, destinationRequest);
    expect(released.phase).toBe("discarded");
  }, 30_000);

  test("an occurrence key another record holds refuses the move before the source can tombstone", async () => {
    // invariant: Finding 5. `occurrences.occurrence_key` is lane-unique, so a colliding row fails the
    // admission INSERT — for an exchange that refusal would land after the source's irreversible
    // tombstone. The destination proves the keys free while it emits `staged`, so the source row stays
    // `staged` and the record is never closed on either authority.
    const cache = await outboxCache("route-collision");
    const destination = await localSourceLane("route-collision");
    const occupant = await captureIssue(
      destination.context,
      {
        ...fixtureCapture("The record already holding the key"),
        sourceIdentity: "other/review",
        rootCauseKey: "other.root",
        acceptanceKey: "other.accept",
        occurrenceKey: "occurrence-one",
      } as never,
      { operationId: "00000000-0000-4000-8000-000000000a41", actor },
    );
    expect(occupant.created).toBe(true);

    const operationId = "00000000-0000-4000-8000-000000000a42";
    const request = {
      operationId,
      actor,
      sourceIssueId: FORGED_ISSUE_REF,
      destinationAuthority: `github.com/local-fixture/route-collision`,
      destinationProject: "fixture-project",
      reason: "collide on the occurrence key",
    };
    const staged = await moveAcrossByDocument(cache.context, request, null);
    const refused = await refusalOf(() =>
      moveAcrossByDocument(destination.context, { ...request, sourceIssueId: staged.document!.issueRef }, staged.document!),
    );
    expect(refused.code).toBe("issue.ambiguous-identity");
    expect(detailsOf(refused)).toMatchObject({ colliding_occurrence_keys: ["occurrence-one"] });
    // invariant: no `staged` memo came back, so the source never froze its tombstone for this move.
    expect(routeOfRow(cache.dbPath, operationId, "source")).toBe("remote-unknown");
    const db = new DatabaseSync(cache.dbPath);
    try {
      expect(db.prepare("select phase from issue_moves where operation_id = ? and role = 'source'").get(operationId)).toEqual({
        phase: "staged",
      });
    } finally {
      db.close();
    }
    expect(outboxRows(cache.dbPath)).toEqual([]);
  }, 30_000);
  test("a v4 one-checkout move backfills its route from the reachable destination half", async () => {
    // invariant: Review wave 6. A v4 source row names the move only by the peer it was staged
    // against, and its destination half lives in a lane this checkout can open — the one fact that
    // distinguishes the one-checkout topology from an exchange. A `local-remote` label would make
    // the discard release only the source half and strand the staged destination row beside an
    // unfenced record.
    const sourceRepo = makeRepo("https://v4-move.invalid/acme/source.git");
    const sourceContext = contextAt(sourceRepo);
    const sourceLocation = locationAt(sourceRepo);
    const destRepo = makeRepo("https://v4-move.invalid/acme/dest.git");
    const destContext = contextAt(destRepo);
    const destLocation = locationAt(destRepo);
    const operationId = "v4-move-one-checkout";
    writeV4Lane(sourceLocation, (db) => {
      db.prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key, issue_ref) " +
          "values ('I-000001', 'fixture-project', 'Moved finding', 'bug', 'high', 'resolved', 'i', 'a', " +
          "'2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'key-one', " +
          "'mstar:issue:99999999-9999-4999-8999-999999999999')",
      ).run();
      seedV4MoveRow(db, {
        operationId,
        role: "source",
        sourceAuthority: sourceLocation.repoKey,
        destinationAuthority: destLocation.repoKey,
        sourceIssueId: "I-000001",
      });
    });
    writeV4Lane(destLocation, (db) => {
      seedV4MoveRow(db, {
        operationId,
        role: "destination",
        sourceAuthority: sourceLocation.repoKey,
        destinationAuthority: destLocation.repoKey,
      });
    });
    activate(sourceLocation.dbPath);
    activate(destLocation.dbPath);
    (await initializeStore(sourceContext)).close();

    const sourceReceipt = await upgradeCollaborationStore(sourceContext, "ops-engineer");
    expect(sourceReceipt.fromVersion).toBe(4);
    expect(routeOfRow(sourceLocation.dbPath, operationId, "source")).toBe("local-local");
    const destReceipt = await upgradeCollaborationStore(destContext, "ops-engineer");
    expect(destReceipt.fromVersion).toBe(4);
    expect(routeOfRow(destLocation.dbPath, operationId, "destination")).toBe("local-local");

    // invariant: The relabelled route is the discard's own admission check: one run releases BOTH
    // halves, and the frozen record is writable again once its source row leaves the blocking set.
    const discarded = await discardAcrossAuthorities(sourceContext, {
      operationId,
      actor: "project-manager",
      sourceIssueId: "I-000001",
      destinationAuthority: destLocation.repoKey,
      destinationProject: "p-dest",
      reason: "v4 move",
    });
    expect(discarded.phase).toBe("discarded");
    const sourceDb = new DatabaseSync(sourceLocation.dbPath);
    try {
      sourceDb.prepare("update issues set updated_at = ? where id = 'I-000001'").run("2026-11-24T00:00:00.000Z");
      expect(
        sourceDb.prepare("select phase from issue_moves where operation_id = ?").get(operationId),
      ).toEqual({ phase: "discarded" });
    } finally {
      sourceDb.close();
    }
    const destDb = new DatabaseSync(destLocation.dbPath);
    try {
      expect(destDb.prepare("select count(*) as n from issue_moves").get()).toEqual({ n: 0 });
    } finally {
      destDb.close();
    }
  });

  test("a v4 exchange half keeps the route its own side names when no reachable peer row exists", async () => {
    // invariant: The same backfill must not relabel an exchange: a v4 source whose destination
    // lane this checkout cannot open is a two-checkout move, so it keeps `local-remote` — the label
    // that makes the discard release only the half this checkout holds.
    const sourceRepo = makeRepo("https://v4-move.invalid/acme/exchange-source.git");
    const sourceContext = contextAt(sourceRepo);
    const sourceLocation = locationAt(sourceRepo);
    const operationId = "v4-move-exchange";
    writeV4Lane(sourceLocation, (db) => {
      seedV4MoveRow(db, {
        operationId,
        role: "source",
        sourceAuthority: sourceLocation.repoKey,
        destinationAuthority: "v4-move.invalid/acme/never-present",
      });
      // note: A v4 ledger may carry any string an older build wrote; a peer key that fails
      // resolution must read as "not present", never abort the ladder.
      seedV4MoveRow(db, {
        operationId: "v4-move-bad-peer",
        role: "source",
        issueRef: "mstar:issue:88888888-8888-4888-8888-888888888888",
        sourceAuthority: sourceLocation.repoKey,
        destinationAuthority: "not-a-canonical-key",
      });
    });
    activate(sourceLocation.dbPath);

    const receipt = await upgradeCollaborationStore(sourceContext, "ops-engineer");
    expect(receipt.fromVersion).toBe(4);
    expect(routeOfRow(sourceLocation.dbPath, operationId, "source")).toBe("local-remote");
    expect(routeOfRow(sourceLocation.dbPath, "v4-move-bad-peer", "source")).toBe("local-remote");
  });

});
