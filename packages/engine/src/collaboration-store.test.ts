/**
 * collaboration store -- independent staged schema, create-only publication and
 * active-only admission for the user-level collaboration database.
 *
 * Every case builds a synthetic checkout and user home under the temp root; no
 * case reads the real user home or the control harness store.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { resolveCollaborationLocation, type CollaborationLocation } from "./collaboration-identity.js";
import {
  initializeCollaborationStore,
  openCollaborationStore,
  readCollaborationAuthority,
  withCollaborationWrite,
  type CollaborationStamp,
} from "./collaboration-store.js";
import { MIGRATIONS, initializeStore, openStore, type StoreContext } from "./store-db.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-collab-store-")));
const HOME = join(ROOT, "home");
mkdirSync(HOME);
/** The direct-engine fixture seam the resolver exposes for the user home. */
const HOME_OPTION = { userHome: HOME };

afterAll(() => {
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
  return resolveCollaborationLocation(contextAt(root), { userHome: HOME });
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

function metaRow(dbPath: string): { repository_key: string; mode: string } {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("select repository_key, mode from collaboration_meta where id = 1").get() as {
      repository_key: string;
      mode: string;
    };
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

    await expect(openCollaborationStore(context, "read", undefined, HOME_OPTION)).rejects.toMatchObject({
      code: "collaboration.not-initialized",
    });
    await expect(openCollaborationStore(context, "write", undefined, HOME_OPTION)).rejects.toMatchObject({
      code: "collaboration.not-initialized",
    });
    await expect(readCollaborationAuthority(context, HOME_OPTION)).rejects.toMatchObject({
      code: "collaboration.not-initialized",
    });
    expect(existsSync(dirname(location.dbPath))).toBe(false);

    const staged = await initializeCollaborationStore(location);
    await expect(openCollaborationStore(context, "read", undefined, HOME_OPTION)).rejects.toMatchObject({ code: "collaboration.not-active" });
    await expect(readCollaborationAuthority(context, HOME_OPTION)).rejects.toMatchObject({ code: "collaboration.not-active" });
    await expect(withCollaborationWrite(context, () => "unused", undefined, HOME_OPTION)).rejects.toMatchObject({
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
      expect(metaRow(locations[index].dbPath).repository_key).toBe(locations[index].repoKey);
    }
  });

  test("corrupt bytes, an unsupported ledger and a symlinked target refuse as unreadable", async () => {
    const corrupt: CollaborationLocation = {
      repoKey: "github.com/acme/corrupt",
      mode: "local",
      dbPath: join(HOME, "corrupt", "collaboration.db"),
    };
    mkdirSync(dirname(corrupt.dbPath), { recursive: true });
    writeFileSync(corrupt.dbPath, "not a collaboration database");
    await expect(initializeCollaborationStore(corrupt)).rejects.toMatchObject({ code: "collaboration.unreadable" });
    expect(readFileSync(corrupt.dbPath, "utf8")).toBe("not a collaboration database");

    const unsupported = locationAt(makeRepo("https://github.com/acme/future.git"));
    await initializeCollaborationStore(unsupported);
    const writer = new DatabaseSync(unsupported.dbPath);
    try {
      writer
        .prepare("insert into schema_version(version, name, checksum, applied_at) values (2, 'future', 'x', ?)")
        .run("2026-11-21T00:00:00.000Z");
    } finally {
      writer.close();
    }
    await expect(initializeCollaborationStore(unsupported)).rejects.toMatchObject({
      code: "collaboration.unreadable",
      message: expect.stringContaining("schema-unsupported"),
    });

    const target = locationAt(makeRepo("https://github.com/acme/link-target.git"));
    const authority = await initializeCollaborationStore(target);
    const linkPath = join(HOME, "linked", "collaboration.db");
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(target.dbPath, linkPath);
    const linked: CollaborationLocation = { repoKey: "github.com/acme/linked", mode: "local", dbPath: linkPath };
    await expect(initializeCollaborationStore(linked)).rejects.toMatchObject({
      code: "collaboration.unreadable",
      message: expect.stringContaining("symbolic link"),
    });
    // The link target was neither followed nor modified.
    expect(await initializeCollaborationStore(target)).toEqual(authority);
    expect(metaRow(target.dbPath).repository_key).toBe("github.com/acme/link-target");
  });

  test("write admission enforces the active stamp and rolls a refused effect back", async () => {
    const repo = makeRepo("https://github.com/acme/cas.git");
    const context = contextAt(repo);
    const location = locationAt(repo);
    const staged = await initializeCollaborationStore(location);
    activate(location.dbPath);

    const authority = await readCollaborationAuthority(context, HOME_OPTION);
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

    const handle = await openCollaborationStore(context, "read", stamp, HOME_OPTION);
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
        HOME_OPTION,
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(applied).toBe(false);
    await expect(openCollaborationStore(context, "read", stale, HOME_OPTION)).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });

    const committed = await withCollaborationWrite(
      context,
      (write) => {
        write.db.exec(
          "insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at) " +
            "values ('standalone', 'op-committed', 'hash', '{}', '2026-11-21T00:00:00.000Z')",
        );
        return write.authority.revision;
      },
      stamp,
      HOME_OPTION,
    );
    expect(committed).toBe(authority.revision);

    // A thrown effect commits nothing: the wrapper owns the transaction.
    await expect(
      withCollaborationWrite(
        context,
        (write) => {
          write.db.exec(
            "insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at) " +
              "values ('standalone', 'op-rolled-back', 'hash', '{}', '2026-11-21T00:00:00.000Z')",
          );
          throw new Error("domain refusal");
        },
        stamp,
        HOME_OPTION,
      ),
    ).rejects.toThrow("domain refusal");
    expect(receipts(location.dbPath)).toEqual(["op-committed"]);
  });

  test("collaboration initialization leaves the execution store and its lazy open unchanged", async () => {
    const repo = makeRepo("https://github.com/acme/legacy.git");
    const context = contextAt(repo);
    await initializeCollaborationStore(locationAt(repo));

    expect(existsSync(join(context.harnessDir, "store.db"))).toBe(false);
    await expect(openStore(context, "read")).rejects.toMatchObject({ code: "store.not-initialized" });

    const handle = await initializeStore(context);
    try {
      expect(handle.schemaVersion).toBe(MIGRATIONS.length);
      const executionTables = (
        handle.db
          .prepare("select name from sqlite_master where type = 'table' and name like 'execution!_%' escape '!' order by name")
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(executionTables.length).toBeGreaterThan(0);
      expect(executionTables).not.toContain("collaboration_meta");
    } finally {
      handle.close();
    }
    // The collaboration database stays a separate file with its own schema.
    expect(tableNames(locationAt(repo).dbPath)).toEqual(COLLABORATION_TABLES);
  });
});
