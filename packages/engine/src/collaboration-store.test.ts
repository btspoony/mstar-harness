/**
 * collaboration store -- independent staged schema, create-only publication and
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
import { resolveCollaborationLocation, type CollaborationLocation } from "./collaboration-identity.js";
import {
  initializeCollaborationStore,
  openCollaborationStore,
  readCollaborationAuthority,
  withCollaborationWrite,
  type CollaborationStamp,
  type CollaborationStoreHandle,
} from "./collaboration-store.js";
import { MIGRATIONS, initializeStore, openStore, type StoreContext } from "./store-db.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-collab-store-")));
const HOME = join(ROOT, "home");
mkdirSync(HOME);
/** The home the single spy resolves; a case may switch it to a fresh tree. */
let resolvedHome = HOME;

let homeSpy: { mockRestore(): void } | undefined;

beforeAll(() => {
  // The resolver's fixture seam is its explicit `userHome` option; the store
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
 * The closed collaboration table inventory (spec Data Model): collaboration
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
  "schema_version",
  "sync_cursor",
  "sync_runs",
];

/** One standalone receipt insert, for the transaction-boundary cases. */
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

/** A synthetic checkout whose `.mstarc` selects the local collaboration mode. */
function makeRepo(origin: string): string {
  const dir = join(ROOT, `repo-${sequence++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Collaboration Store Test");
  git(dir, "config", "user.email", "store@example.test");
  git(dir, "config", "remote.origin.url", origin);
  writeFileSync(join(dir, ".mstarc"), "[collaboration]\nmode=local\n");
  return dir;
}

function contextAt(root: string): StoreContext {
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  return { harnessDir, checkoutRoot: root };
}

function locationAt(root: string): CollaborationLocation {
  return resolveCollaborationLocation(contextAt(root));
}

/** Flip the staged record to active: this plan ships no public activator. */
function activate(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(
      new Date().toISOString(),
    );
  } finally {
    db.close();
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

/** The journal mode actually persisted in the file (a plain open never changes it). */
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

/** Whether this descriptor currently names a directory - the barrier's target. */
function namesDirectory(fd: number): boolean {
  try {
    return fstatSync(fd).isDirectory();
  } catch {
    return false;
  }
}

/** Fail every directory barrier this process attempts, with an errno. */
function failDirectoryBarriers(): { restore: () => void } {
  const spy = spyOn(nodeFs, "fsyncSync").mockImplementation(((fd: number) => {
    if (namesDirectory(fd)) throw Object.assign(new Error("simulated directory fsync failure"), { code: "EIO" });
    return REAL_FSYNC(fd);
  }) as never);
  return { restore: () => spy.mockRestore() };
}

/** Count the directory barriers that actually run. */
function observeDirectoryBarriers(): { restore: () => void; synced: () => number } {
  let synced = 0;
  const spy = spyOn(nodeFs, "fsyncSync").mockImplementation(((fd: number) => {
    if (namesDirectory(fd)) synced += 1;
    return REAL_FSYNC(fd);
  }) as never);
  return { restore: () => spy.mockRestore(), synced: () => synced };
}

/** The directory's file entries that name the same inode. */
function aliasesOf(dir: string, inode: number): string[] {
  return nodeFs.readdirSync(dir).filter((name) => {
    const stats = nodeFs.lstatSync(join(dir, name));
    return stats.isFile() && stats.ino === inode;
  });
}

/** Engine-owned staging entries still present beside a published store. */
function stagingLeftovers(dir: string): string[] {
  return nodeFs.readdirSync(dir).filter((name) => name.startsWith(".staging-"));
}

/** The stamp a caller holds for one admitted authority. */
function stampOf(authority: {
  repoKey: string;
  mode: "local" | "mirror";
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
      schemaVersion: 1,
      epoch: 1,
      revision: 0,
      catalogRevision: 0,
    });
    expect(first.storeId).toMatch(/^[0-9a-f-]{36}$/);

    // Same stage, same authority: no second ledger row, no cleared metadata.
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
    expect(versions).toEqual([{ version: 1, name: "collaboration-core" }]);
    expect(tableNames(location.dbPath).length).toBe(COLLABORATION_TABLES.length);
    expect(receipts(location.dbPath)).toEqual([]);

    // A private store file inside a private directory.
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
      // Collaboration initialization creates no issue, no execution row and no
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
    // A refused admission neither activates nor rewrites the staged record.
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

    // A path whose directory segments carry percent-encoded uppercase must still
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
        .prepare("insert into schema_version(version, name, checksum, applied_at) values (2, 'future', 'x', ?)")
        .run("2026-11-21T00:00:00.000Z");
      // A newer layout no longer matches this build's inventory; the verdict is
      // still the upgrade requirement, never "damaged store".
      writer.exec("create table future_extra(id text primary key)");
    } finally {
      writer.close();
    }
    const expected = {
      code: "store.schema-unsupported",
      details: { storeSchemaVersion: 2, supportedSchemaMax: 1, firstUnsupportedMigration: 2 },
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
    // The link target was neither followed nor modified.
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
    // The redirected destination stays untouched.
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
      // Same table name, current ledger and metadata, but the issue shape lost
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

    // A stale generation is refused before the effect runs.
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

    // A thrown effect commits nothing: the wrapper owns the transaction.
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

    // A retained handle stays non-mutating when the recorded generation changes.
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

    // The guarded transaction's writer is closed when the call returns.
    let escaped: CollaborationStoreHandle | undefined;
    await withCollaborationWrite(
      context,
      (write) => {
        escaped = write;
        return "ok";
      },
      { ...stamp, epoch: stamp.epoch + 1 },
    );
    // The guarded facade denies `exec`, so the closed connection is proved
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

    // No test-side `.catch`: the wrapper itself must observe the abandoned
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
      // Unhandled rejections are reported at the runtime's next task boundary,
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

    // The failed publication retired its own staging alias: exactly one name
    // for the runtime bytes remains, and no staging scratch is left behind.
    const storeDir = dirname(location.dbPath);
    expect(aliasesOf(storeDir, statSync(location.dbPath).ino)).toEqual(["collaboration.db"]);
    expect(stagingLeftovers(storeDir)).toEqual([]);

    // The retry continues the SAME record and really re-runs the barrier.
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
      // A competing initializer published the same complete bytes first.
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

      // The next attempt stages again, meets the competitor again, and only
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
        // 1: the entry's regular-file check, 2: its private-file check,
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
    // Nothing was recreated at the authority path; the real store is intact
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
        // 4: the writer's own guard - the admitted file is replaced in place by
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
    // The replacement was refused without a journal change or a sidecar.
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

    // A normal DELETE-journal store admits and needs no sidecar.
    const authority = await readCollaborationAuthority(context);
    expect(authority.state).toBe("active");
    expect(existsSync(`${location.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${location.dbPath}-shm`)).toBe(false);

    // A present WAL sidecar is refused before the database is opened.
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
    // Nothing was opened, repaired, created or converted.
    expect(readFileSync(location.dbPath).equals(mainBytes)).toBe(true);
    expect(readFileSync(`${location.dbPath}-wal`).equals(sidecarBytes)).toBe(true);
    expect(existsSync(`${location.dbPath}-shm`)).toBe(false);
    rmSync(`${location.dbPath}-wal`, { force: true });

    // A quiesced WAL file (header WAL, no journal) is refused too, never read
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
      // A batch whose FIRST statement is ordinary DML still cannot reach its
      // trailing transaction control: `exec` is refused outright.
      (write) => write.db.exec(`${receiptInsert("op-batch")}; commit`),
      (write) => write.db.prepare("end").run(),
      (write) => write.db.exec("savepoint inner"),
      (write) => write.close(),
      // SQLite's prepare skips leading empty statements, so a prefixed
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
    // No statement of a refused batch ran, and no effect survived.
    expect(receipts(location.dbPath)).toEqual([]);
    // The wrapper still owns the transaction and commits a legitimate effect.
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
      // Fail only the `.mstar` directory's own barrier: an ancestor, not the
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

      // The retry re-walks the chain, so the ancestor that failed is confirmed
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

    // The store stays in its DELETE journal mode: the holder takes the write
    // reservation, readers proceed, and the guarded writer waits at
    // BEGIN IMMEDIATE for the bounded budget.
    const holder = new DatabaseSync(location.dbPath);
    holder.exec("begin immediate");
    const started = Date.now();
    try {
      await expect(withCollaborationWrite(context, () => "unused")).rejects.toMatchObject({ code: "store.busy" });
      // The bounded wait ran out at the transaction boundary, not at connect.
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
      // The execution store carries its own authority and no collaboration
      // metadata: the two lanes never share a file or a table.
      expect(tables).toEqual(expect.arrayContaining(["execution_meta", "store_meta"]));
      expect(tables).not.toContain("collaboration_meta");
    } finally {
      handle.close();
    }
    // The collaboration database stays a separate file with its own schema.
    expect(tableNames(locationAt(repo).dbPath)).toEqual(COLLABORATION_TABLES);
  });
});
