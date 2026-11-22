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
  resolveCollaborationLocation,
  type CollaborationLocation,
  type CollaborationMode,
} from "./collaboration-identity.js";
import {
  assertControlCheckoutScope,
  assertIssueRef,
  COLLABORATION_MIGRATIONS,
  initializeCollaborationStore,
  openCollaborationStore,
  probeCollaborationAuthority,
  readCollaborationAuthority,
  readCollaborationBinding,
  upgradeCollaborationStore,
  withCollaborationWrite,
  writeCollaborationBinding,
  type CollaborationStamp,
  type CollaborationStoreHandle,
} from "./collaboration-store.js";
import {
  bindRemoteAuthority,
  ingestRemoteObservation,
  readRemoteStatus,
  type RemoteSnapshot,
  type ScopeCheck,
} from "./collaboration-remote.js";
import { MIGRATIONS, SCHEMA_VERSION_TABLE_SQL, initializeStore, migrationChecksum, openStore, type StoreContext } from "./store-db.js";
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
      schemaVersion: 2,
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
    expect(versions).toEqual([
      { version: 1, name: "collaboration-core" },
      { version: 2, name: "collaboration-remote-cache" },
    ]);
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
      writer
        .prepare("insert into schema_version(version, name, checksum, applied_at) values (3, 'future', 'x', ?)")
        .run("2026-11-21T00:00:00.000Z");
      // invariant: A newer layout no longer matches this build's inventory; the verdict is
      // still the upgrade requirement, never "damaged store".
      writer.exec("create table future_extra(id text primary key)");
    } finally {
      writer.close();
    }
    const expected = {
      code: "store.schema-unsupported",
      details: { storeSchemaVersion: 3, supportedSchemaMax: 2, firstUnsupportedMigration: 3 },
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

describe("collaboration v2 remote cache schema", () => {
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
      toVersion: 2,
      storeId: "v1-store",
      epoch: 1,
      issuesBackfilled: 2,
    });
    expect(ledgerVersions(location.dbPath)).toEqual([1, 2]);

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
    expect(replay).toMatchObject({ fromVersion: 2, toVersion: 2, issuesBackfilled: 0 });
    expect(issueRefs(location.dbPath)).toEqual(refs);
    expect(ledgerVersions(location.dbPath)).toEqual([1, 2]);
    expect((await readCollaborationAuthority(context)).schemaVersion).toBe(2);
  });

  test("a malformed, partial or foreign-scope lane refuses without mutation", async () => {
    // note: A recorded v1 checksum that is not this build's immutable migration.
    const wrongChecksumRepo = makeRepo("https://github.com/v2-upgrade/wrong-checksum.git");
    const wrongChecksum = locationAt(wrongChecksumRepo);
    writeV1Lane(wrongChecksum, (db) => db.prepare("update schema_version set checksum = ? where version = 1").run("f".repeat(64)));
    await expect(upgradeCollaborationStore(contextAt(wrongChecksumRepo), "ops-engineer")).rejects.toMatchObject({
      code: "store.corrupt",
    });
    expect(ledgerVersions(wrongChecksum.dbPath)).toEqual([1]);

    // note: A v2 table without its ledger row is a partial apply: refused, never re-applied.
    const partialRepo = makeRepo("https://github.com/v2-upgrade/partial.git");
    const partial = locationAt(partialRepo);
    writeV1Lane(partial, (db) => db.exec("create table remote_bindings(generation integer)"));
    await expect(upgradeCollaborationStore(contextAt(partialRepo), "ops-engineer")).rejects.toMatchObject({
      code: "collaboration.unreadable",
    });
    expect(ledgerVersions(partial.dbPath)).toEqual([1]);

    // note: Half of the issues rebuild (the column already added) is the one shape that would
    // otherwise re-mint stable references: it refuses instead.
    const halfRepo = makeRepo("https://github.com/v2-upgrade/half.git");
    const half = locationAt(halfRepo);
    writeV1Lane(half, (db) => db.exec("alter table issues add column issue_ref text"));
    await expect(upgradeCollaborationStore(contextAt(halfRepo), "ops-engineer")).rejects.toMatchObject({
      code: "store.corrupt",
      message: expect.stringContaining("partially applied v2"),
    });
    expect(ledgerVersions(half.dbPath)).toEqual([1]);

    // invariant: The upgrade records the operator it attests.
    const anonymous = makeRepo("https://github.com/v2-upgrade/anonymous.git");
    writeV1Lane(locationAt(anonymous));
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
    expect(ledgerVersions(location.dbPath)).toEqual([1, 2]);
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
          target: "2026-12-01",
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
              legacyJson: null,
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
    expect(await ensureCollaborationAuthority(context)).toMatchObject({ mode: "remote", state: "active", schemaVersion: 2 });

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
    await bindRemoteAuthority(context, { version: 1, selectorCommit: commit, generation: 3, checks: [positiveCheck()] });
    const check = positiveCheck();
    const base = completeSnapshot(check);
    const subject = base.issues[0]!.mstar!;
    const submit = (snapshot: unknown) =>
      ingestRemoteObservation(context, {
        ...observation(check, { snapshot }),
        selectorCommit: commit,
        generation: 3,
      });
    const withSubject = (patch: Record<string, unknown>) => ({
      ...base,
      issues: [{ ...base.issues[0]!, mstar: { ...subject, ...patch } }, base.issues[1]!],
    });
    const withoutKind = { ...subject.fields };
    delete withoutKind.kind;

    // invariant: Unknown members, missing required fields, wrong enums and unstable history never
    // enter the cache; only the allowlisted normalized subject is stored.
    for (const snapshot of [
      withSubject({ fields: { ...subject.fields, token: "leak" } }),
      withSubject({ fields: { ...subject.fields, severity: "blocker" } }),
      withSubject({ fields: withoutKind }),
      withSubject({ occurrences: [{ ...subject.occurrences[0]!, rowId: 7 }] }),
      withSubject({ occurrences: [{ ...subject.occurrences[0]!, eventId: "occurrence-one" }] }),
      withSubject({ transitions: [{ from: "open", to: "resolved", reason: "fixed" }] }),
      withSubject({ relations: [{ relation: "related", target: "I-000001" }] }),
      withSubject({ provenance: [{}] }),
      withSubject({ projectMoves: [{ fromProject: "a", toProject: "b" }] }),
    ]) {
      await expect(submit(snapshot)).rejects.toMatchObject({ code: "remote.input-invalid" });
    }
    expect(await submit(base)).toMatchObject({ revision: 1, completeness: "complete" });
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
  });
});
