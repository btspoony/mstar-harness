/**
 * store-db.test.ts — proof for the issue-store runtime boundary.
 * Run with `bun test packages/engine/src/store-db.test.ts`.
 *
 * The scenario suite below is executed against the REAL store-db.ts
 * implementation and the REAL node:sqlite driver — twice: once in-process
 * under Bun 1.4.0 (the test runner itself) and once per scenario as a child
 * process under Node >=24.18.0 and Bun 1.4.0, using the test-only
 * `store-test-runtime.ts` helper bundled into a temporary directory. No mock
 * database exists anywhere in this proof. The bundle and all temporary
 * databases are removed after the run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveProcessHarnessDir } from "./coordination.js";
import {
  MIN_BUN_VERSION,
  MIGRATIONS,
  migrationChecksum,
  MIN_NODE_VERSION,
  StoreError,
  assertExecutionFileReadAllowed,
  assertExecutionFileWriteAllowed,
  assertStoreRuntimeSupported,
  compareVersions,
  initializeStore,
  openStore,
  storeDbPath,
  upgradeStore,
} from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-db-test-"));
const BUNDLE = join(ROOT, "store-test-runtime.mjs");

/** Node binary used for the Node-floor leg; overridable for local runs. */
const NODE_BIN = process.env.MSTAR_TEST_NODE_BIN ?? "node";
let bundleError = "";

beforeAll(() => {
  const built = spawnSync(
    process.execPath,
    ["build", join(import.meta.dir, "store-test-runtime.ts"), "--target", "node", "--outfile", BUNDLE],
    { encoding: "utf8" },
  );
  if (built.status !== 0) bundleError = built.stderr || `bun build exited ${built.status}`;
}, 60_000);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Spawn one scenario under a real runtime binary in a fresh temp dir. */
function runScenarioOn(bin: string, scenario: string, dir: string): { status: number; output: string } {
  const run = spawnSync(bin, [BUNDLE, scenario, dir], {
    encoding: "utf8",
    env: { ...process.env, MSTAR_STORE_TEST_RUNNER: "1" },
    timeout: 60_000,
  });
  return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}`.trim() };
}

const SCENARIOS: string[] = [
  "import-lazy",
  "below-floor-refusal",
  "missing-read",
  "initialize-schema",
  "double-init",
  "version-drift",
  "newer-schema",
  "fk-enforcement",
  "second-writer-busy",
] as const;

describe("store-db runtime floors (actual versions)", () => {
  test("compareVersions orders floors numerically", () => {
    expect(compareVersions("24.18.0", "24.18.0")).toBe(0);
    expect(compareVersions("24.17.0", "24.18.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  test("below-floor and missing-capability refusals are actionable (in-process, real logic)", () => {
    expect(() => assertStoreRuntimeSupported({ isBun: false, version: "22.5.0" })).toThrow(StoreError);
    expect(() => assertStoreRuntimeSupported({ isBun: true, version: "1.3.14" })).toThrow(/Bun >=1\.4\.0/);
    expect(() => assertStoreRuntimeSupported({ isBun: false, version: "24.17.9" })).toThrow(/Node >=24\.18\.0/);
    expect(() => assertStoreRuntimeSupported({ isBun: false, version: "24.18.0", hasSqlite: false })).toThrow(
      /node:sqlite/,
    );
    expect(() => assertStoreRuntimeSupported({ isBun: true, version: MIN_BUN_VERSION })).not.toThrow();
    expect(() => assertStoreRuntimeSupported({ isBun: false, version: MIN_NODE_VERSION })).not.toThrow();
  });
});

describe.each([
  { runtime: "node", bin: NODE_BIN },
  { runtime: "bun", bin: process.execPath },
])("store scenarios under $runtime", ({ runtime, bin }) => {
  test.each(SCENARIOS)(`${runtime}: %s`, (scenario) => {
    expect(bundleError).toBe("");
    const dir = mkdtempSync(join(ROOT, `${runtime}-${scenario}-`));
    try {
      const result = runScenarioOn(bin, scenario, dir);
      if (result.status !== 0) {
        throw new Error(`${runtime} ${scenario} failed (exit ${result.status}):\n${result.output}`);
      }
      expect(result.output).toContain(`OK ${scenario}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/* ------------------------------------------------------------------------ *
 * Read-open path: refused store shapes must never gain a journal, and a store
 * reached through a link is not the canonical store
 * ------------------------------------------------------------------------ */

describe("store-db read-open repair", () => {
  test("WAL-shaped bytes that are not a database are refused without a sidecar", async () => {
    const dir = mkdtempSync(join(ROOT, "wal-shaped-bytes-"));
    const path = join(dir, "store.db");
    const bytes = Buffer.alloc(100);
    bytes.write("this is not a sqlite database", 0, "latin1");
    // The two bytes the quiesced-WAL shape is recognized by, on a file that is
    // not a SQLite database at all: the repair must not add a journal for it.
    bytes[18] = 2;
    bytes[19] = 2;
    writeFileSync(path, bytes);

    await expect(openStore({ harnessDir: dir }, "read")).rejects.toMatchObject({ code: "store.corrupt" });
    expect(existsSync(`${path}-wal`)).toBe(false);
  });

  test("a symlinked store path is refused, and the link target is left alone", async () => {
    const targetDir = mkdtempSync(join(ROOT, "symlink-target-"));
    const created = await initializeStore({ harnessDir: targetDir });
    created.close();
    const linkDir = mkdtempSync(join(ROOT, "symlink-store-"));
    const linkPath = join(linkDir, "store.db");
    symlinkSync(join(targetDir, "store.db"), linkPath);
    const targetBefore = readdirSync(targetDir).sort().join(" ");

    // Refusing is what proves no authority was served from the link target, and
    // neither intent leaves a sidecar at the linked path or touches the target.
    await expect(openStore({ harnessDir: linkDir }, "read")).rejects.toMatchObject({ code: "store.corrupt" });
    await expect(openStore({ harnessDir: linkDir }, "write")).rejects.toMatchObject({ code: "store.corrupt" });
    expect(existsSync(`${linkPath}-wal`)).toBe(false);
    expect(readdirSync(targetDir).sort().join(" ")).toBe(targetBefore);
  });

  test("a dangling store.db link is a corrupt store, never an absent one", async () => {
    const dir = mkdtempSync(join(ROOT, "dangling-link-"));
    // The link exists; its target does not. Leftover legacy bytes sit beside it,
    // so answering "no store" here would hand the retired file route back its
    // authority over a path that is not genuinely absent.
    symlinkSync(join(dir, "target-elsewhere.db"), join(dir, "store.db"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({ version: 2, updated_at: "2026-01-02", workflows: [] }),
    );

    const refusalCodeOf = (run: () => void): string => {
      try {
        run();
        return "";
      } catch (error) {
        return error && typeof error === "object" && "code" in error ? String(error.code) : "";
      }
    };
    await expect(openStore({ harnessDir: dir }, "read")).rejects.toMatchObject({ code: "store.corrupt" });
    await expect(openStore({ harnessDir: dir }, "write")).rejects.toMatchObject({ code: "store.corrupt" });
    expect(refusalCodeOf(() => assertExecutionFileWriteAllowed({ harnessDir: dir }))).toBe("store.corrupt");
    expect(refusalCodeOf(() => assertExecutionFileReadAllowed({ harnessDir: dir }))).toBe("store.corrupt");
    // Nothing was created for the refused link, and the leftover bytes stayed.
    expect(existsSync(`${join(dir, "store.db")}-wal`)).toBe(false);
    expect(existsSync(join(dir, "status.json"))).toBe(true);
  });
});

describe("store-db L2 fix round", () => {
  test("storeDbPath uses resolveProcessHarnessDir (control root, not worktree-local)", () => {
    const worktree = process.cwd();
    const resolved = resolveProcessHarnessDir(worktree);
    const path = storeDbPath({ harnessDir: worktree });
    expect(resolved).not.toBeNull();
    expect(path).toBe(join(resolved!, "store.db"));
    expect(path).not.toBe(join(worktree, "store.db"));
  });

  test("corrupt bytes refuse open and upgrade as store.corrupt", async () => {
    const dir = mkdtempSync(join(ROOT, "corrupt-"));
    writeFileSync(join(dir, "store.db"), "this is not a sqlite database");
    await expect(openStore({ harnessDir: dir }, "read")).rejects.toMatchObject({ code: "store.corrupt" });
    await expect(upgradeStore({ harnessDir: dir })).rejects.toMatchObject({ code: "store.corrupt" });
  });

  test("upgrade refuses malformed store_meta on a current-schema DB", async () => {
    const dir = mkdtempSync(join(ROOT, "meta-"));
    const handle = await initializeStore({ harnessDir: dir });
    handle.db.exec("delete from store_meta where id = 1");
    handle.close();
    await expect(upgradeStore({ harnessDir: dir })).rejects.toMatchObject({ code: "store.corrupt" });
  });

  test("failed init leaves no partial store", async () => {
    const dir = mkdtempSync(join(ROOT, "fail-init-"));
    const previous = process.env.MSTAR_STORE_FAIL_INIT;
    const runner = process.env.MSTAR_STORE_TEST_RUNNER;
    process.env.MSTAR_STORE_TEST_RUNNER = "1";
    process.env.MSTAR_STORE_FAIL_INIT = "1";
    try {
      await expect(initializeStore({ harnessDir: dir })).rejects.toThrow(/induced init failure/);
      expect(existsSync(join(dir, "store.db"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.MSTAR_STORE_FAIL_INIT;
      else process.env.MSTAR_STORE_FAIL_INIT = previous;
      if (runner === undefined) delete process.env.MSTAR_STORE_TEST_RUNNER;
      else process.env.MSTAR_STORE_TEST_RUNNER = runner;
    }
  });

  test("a competing initializer's store is refused, never opened or removed", async () => {
    const dir = mkdtempSync(join(ROOT, "claim-window-"));
    const path = join(dir, "store.db");
    const previousRunner = process.env.MSTAR_STORE_TEST_RUNNER;
    const previousBusy = process.env.MSTAR_STORE_BUSY_TIMEOUT_MS;
    process.env.MSTAR_STORE_TEST_RUNNER = "1";
    process.env.MSTAR_STORE_BUSY_TIMEOUT_MS = "1";
    try {
      // The initializer's lazy driver import is the window a competing
      // initializer fills; this synchronous store (holding the write lock the
      // loser would meet as `store.busy`) appears inside it.
      const loser = initializeStore({ harnessDir: dir });
      const winner = new DatabaseSync(path);
      winner.exec("create table winner_keep(note text)");
      winner.exec("insert into winner_keep(note) values ('keep-me')");
      winner.exec("begin immediate");
      await expect(loser).rejects.toMatchObject({ code: "store.already-exists" });
      winner.exec("rollback");
      winner.close();
      expect(existsSync(path)).toBe(true);
      const check = new DatabaseSync(path, { readOnly: true });
      const row = check.prepare("select note from winner_keep").get() as { note?: string };
      expect(row.note).toBe("keep-me");
      check.close();
    } finally {
      if (previousRunner === undefined) delete process.env.MSTAR_STORE_TEST_RUNNER;
      else process.env.MSTAR_STORE_TEST_RUNNER = previousRunner;
      if (previousBusy === undefined) delete process.env.MSTAR_STORE_BUSY_TIMEOUT_MS;
      else process.env.MSTAR_STORE_BUSY_TIMEOUT_MS = previousBusy;
    }
  });

  test("concurrent initializers do not depend on a racy pre-check", async () => {
    const dir = mkdtempSync(join(ROOT, "concurrent-"));
    const results = await Promise.allSettled([
      initializeStore({ harnessDir: dir }),
      initializeStore({ harnessDir: dir }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof StoreError && r.reason.code === "store.already-exists",
    );
    expect(ok.length).toBe(1);
    expect(refused.length).toBe(1);
    if (ok[0]?.status === "fulfilled") ok[0].value.close();
    const reader = await openStore({ harnessDir: dir }, "read");
    expect(reader.epoch).toBe(1);
    reader.close();
  });

  test("pre-existing sqlite without schema_version is refused and bytes are unchanged", async () => {
    const dir = mkdtempSync(join(ROOT, "preexist-noschema-"));
    const path = join(dir, "store.db");
    const foreign = new DatabaseSync(path);
    foreign.exec("create table leftover(id integer primary key, note text)");
    foreign.exec("insert into leftover(note) values ('keep-me')");
    foreign.close();
    const before = readFileSync(path);
    await expect(initializeStore({ harnessDir: dir })).rejects.toMatchObject({ code: "store.already-exists" });
    expect(readFileSync(path).equals(before)).toBe(true);
    const check = new DatabaseSync(path, { readOnly: true });
    const row = check.prepare("select note from leftover").get() as { note?: string };
    expect(row.note).toBe("keep-me");
    const tables = check
      .prepare("select name from sqlite_master where type='table' and name='schema_version'")
      .all() as Array<{ name: string }>;
    expect(tables).toEqual([]);
    check.close();
  });

  test("empty pre-existing file is refused and bytes are unchanged", async () => {
    const dir = mkdtempSync(join(ROOT, "preexist-empty-"));
    const path = join(dir, "store.db");
    writeFileSync(path, "");
    const before = readFileSync(path);
    await expect(initializeStore({ harnessDir: dir })).rejects.toMatchObject({ code: "store.already-exists" });
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("absent path initializes an active epoch-1 store", async () => {
    const dir = mkdtempSync(join(ROOT, "fresh-absent-"));
    expect(existsSync(join(dir, "store.db"))).toBe(false);
    const handle = await initializeStore({ harnessDir: dir });
    expect(handle.epoch).toBe(1);
    expect(handle.schemaVersion).toBe(MIGRATIONS.length);
    const meta = handle.db.prepare("select authority_state, authority_epoch from store_meta where id = 1").get() as {
      authority_state?: string;
      authority_epoch?: number;
    };
    expect(meta.authority_state).toBe("active");
    expect(meta.authority_epoch).toBe(1);
    handle.close();
  });

  test("busy-timeout override is inert without the test-runner marker", async () => {
    const dir = mkdtempSync(join(ROOT, "busy-"));
    const previousBusy = process.env.MSTAR_STORE_BUSY_TIMEOUT_MS;
    const previousRunner = process.env.MSTAR_STORE_TEST_RUNNER;
    delete process.env.MSTAR_STORE_TEST_RUNNER;
    process.env.MSTAR_STORE_BUSY_TIMEOUT_MS = "1";
    try {
      const handle = await initializeStore({ harnessDir: dir });
      const row = handle.db.prepare("pragma busy_timeout").get() as { timeout?: number; busy_timeout?: number };
      const timeout = row.timeout ?? row.busy_timeout;
      expect(timeout).toBe(5000);
      handle.close();
    } finally {
      if (previousBusy === undefined) delete process.env.MSTAR_STORE_BUSY_TIMEOUT_MS;
      else process.env.MSTAR_STORE_BUSY_TIMEOUT_MS = previousBusy;
      if (previousRunner === undefined) delete process.env.MSTAR_STORE_TEST_RUNNER;
      else process.env.MSTAR_STORE_TEST_RUNNER = previousRunner;
    }
  });

  test("migration-1 forbids self-edges, sorts related endpoints, and constrains imported 0/1", async () => {
    const dir = mkdtempSync(join(ROOT, "invariants-"));
    const handle = await initializeStore({ harnessDir: dir });
    handle.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000001', 'p', 't', 'bug', 'high', 'i', 'a', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z', 'k1')",
      )
      .run();
    handle.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000002', 'p', 't', 'bug', 'high', 'i', 'a', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z', 'k2')",
      )
      .run();
    expect(() =>
      handle.db
        .prepare("insert into relations(from_issue, relation, to_issue) values ('I-000001', 'blocks', 'I-000001')")
        .run(),
    ).toThrow();
    expect(() =>
      handle.db
        .prepare("insert into relations(from_issue, relation, to_issue) values ('I-000002', 'related', 'I-000001')")
        .run(),
    ).toThrow();
    handle.db
      .prepare("insert into relations(from_issue, relation, to_issue) values ('I-000001', 'related', 'I-000002')")
      .run();
    expect(() =>
      handle.db
        .prepare(
          "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key," +
            " acceptance_key, location, observed_behavior, evidence_json, recorded_at, imported) values" +
            " ('I-000001', 'ok1', 'test', 's', 'rc', 'ac', 'loc', 'ob', '[]', '2026-09-18T00:00:00.000Z', 2)",
        )
        .run(),
    ).toThrow();
    handle.close();
  });
});
describe("migration 7 \u2014 project_milestones", () => {
  test("milestone fresh install and retry retain schema 7", async () => {
    const dir = mkdtempSync(join(ROOT, "milestone-fresh-"));
    const handle = await initializeStore({ harnessDir: dir });
    expect(handle.schemaVersion).toBe(7);
    const columns = handle.db.prepare("pragma table_info(issues)").all() as Array<{ name?: string }>;
    expect(columns.some((column) => column.name === "milestone_id")).toBe(true);
    handle.close();
    expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: 7 });
  });

  test("milestone DDL scopes seeded rows and leaves existing issue membership null", async () => {
    const dir = mkdtempSync(join(ROOT, "milestone-guards-"));
    const handle = await initializeStore({ harnessDir: dir });
    const insertProject = handle.db.prepare(
      "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', ?, ?, 'projects', ?, 'now', 'now')",
    );
    insertProject.run("p-one", "Project One", "p-one/roadmap.md");
    handle.db.prepare(
      "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
        " values ('I-000101', 'p-one', 'Issue', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'guard-issue')",
    ).run();
    expect(handle.db.prepare("select milestone_id from issues where id='I-000101'").get()).toEqual({ milestone_id: null });
    const insertMilestone = handle.db.prepare("insert into project_milestones(milestone_id, project_id, name, ordinal, created_at, updated_at) values(?, ?, ?, ?, ?, ?)");
    insertMilestone.run("m-one", "p-one", "Milestone", 0, "now", "now");
    handle.db.prepare("update issues set milestone_id='m-one' where id='I-000101'").run();
    expect(() => insertMilestone.run("m-bad", "missing-project", "Bad", 0, "now", "now")).toThrow();
    expect(() => handle.db.prepare("update project_milestones set project_id='other' where milestone_id='m-one'").run())
      .toThrow(/milestone.identity-immutable/);
    expect(() => handle.db.prepare("delete from project_milestones where milestone_id='m-one'").run()).toThrow();
    handle.close();
  });

  test("milestone upgrade applies versions 5 through 7 from schema 4 and preserves issue rows", async () => {
    const dir = mkdtempSync(join(ROOT, "milestone-upgrade-"));
    const db = new DatabaseSync(join(dir, "store.db"));
    db.exec("pragma foreign_keys=on");
    db.exec("begin");
    db.exec("create table schema_version(version integer primary key, name text not null unique, checksum text not null, applied_at text not null)");
    for (const migration of MIGRATIONS.slice(0, 4)) {
      db.exec(migration.sql);
      db.prepare("insert into schema_version values(?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), "now");
    }
    db.prepare(
      "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', 'p-old', 'Old project', 'projects', 'p-old/roadmap.md', 'now', 'now')",
    ).run();
    db.prepare(
      "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
        " values ('I-000102', 'p-old', 'Preexisting issue', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'upgrade-issue')",
    ).run();
    db.exec("commit");
    db.close();
    expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: 7 });
    const upgraded = await openStore({ harnessDir: dir }, "read");
    expect(upgraded.db.prepare("select id, milestone_id from issues where id='I-000102'").get()).toEqual({
      id: "I-000102",
      milestone_id: null,
    });
    upgraded.close();
  });
  test("milestone migration refusal covers version gaps and newer versions", async () => {
    for (const [label, mutate, code] of [
      ["gap", "delete from schema_version where version=2", "store.schema-drift"],
      ["newer", "insert into schema_version values(8, 'future', 'future', 'now')", "store.schema-unsupported"],
    ] as const) {
      const dir = mkdtempSync(join(ROOT, `milestone-${label}-`));
      const handle = await initializeStore({ harnessDir: dir });
      handle.db.exec(mutate);
      handle.close();
      await expect(upgradeStore({ harnessDir: dir })).rejects.toMatchObject({ code });
    }
  });

  test("milestone DDL failure rolls back earlier schema changes and version row", async () => {
    const dir = mkdtempSync(join(ROOT, "milestone-ddl-failure-"));
    const db = new DatabaseSync(join(dir, "store.db"));
    db.exec("pragma foreign_keys=on");
    db.exec("begin");
    db.exec("create table schema_version(version integer primary key, name text not null unique, checksum text not null, applied_at text not null)");
    for (const migration of MIGRATIONS.slice(0, 6)) {
      db.exec(migration.sql);
      db.prepare("insert into schema_version values(?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), "now");
    }
    db.exec("create trigger issues_milestone_project_insert before insert on issues begin select raise(abort, 'collision'); end");
    db.exec("commit");
    db.close();
    await expect(upgradeStore({ harnessDir: dir })).rejects.toBeDefined();
    const check = new DatabaseSync(join(dir, "store.db"));
    expect(check.prepare("select max(version) as version from schema_version").get()).toEqual({ version: 6 });
    expect(check.prepare("select name from sqlite_master where type='table' and name='project_milestones'").all()).toEqual([]);
    expect(check.prepare("pragma table_info(issues)").all().some((column) => "name" in column && column.name === "milestone_id")).toBe(false);
    expect(check.prepare("select name from sqlite_master where type='index' and name in ('project_milestones_order','issues_milestone_disposition')").all()).toEqual([]);
    check.close();
  });

  test("milestone association rejects a project mismatch on insert and update", async () => {
    const dir = mkdtempSync(join(ROOT, "milestone-project-mismatch-"));
    const handle = await initializeStore({ harnessDir: dir });
    const insertProject = handle.db.prepare(
      "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', ?, ?, 'projects', ?, 'now', 'now')",
    );
    insertProject.run("p-a", "Project A", "p-a/roadmap.md");
    insertProject.run("p-b", "Project B", "p-b/roadmap.md");
    handle.db.prepare(
      "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
        " values ('I-000103', 'p-a', 'Issue', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'mismatch-issue')",
    ).run();
    const insertMilestone = handle.db.prepare("insert into project_milestones(milestone_id, project_id, name, ordinal, created_at, updated_at) values(?, ?, ?, ?, ?, ?)");
    insertMilestone.run("m-a", "p-a", "A", 0, "now", "now");
    insertMilestone.run("m-b", "p-b", "B", 0, "now", "now");
    const insertIssue = handle.db.prepare(
      "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key, milestone_id)" +
        " values ('I-000104', 'p-a', 'Mismatch insert', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'mismatch-insert', 'm-b')",
    );
    expect(() => insertIssue.run()).toThrow(/milestone.project-mismatch/);
    expect(() => handle.db.prepare("update issues set milestone_id='m-b' where id='I-000103'").run()).toThrow(/milestone.project-mismatch/);
    handle.close();
  });
});
