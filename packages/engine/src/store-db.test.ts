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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveProcessHarnessDir } from "./coordination.js";
import {
  MIGRATIONS,
  MIN_BUN_VERSION,
  MIN_NODE_VERSION,
  StoreError,
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
let nodeVersion = "";
let bundleError = "";

function runtimeVersion(bin: string, args: string[]): string {
  const probe = spawnSync(bin, args, { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : `unavailable (${probe.stderr.trim()})`;
}

beforeAll(() => {
  const built = spawnSync(
    process.execPath,
    ["build", join(import.meta.dir, "store-test-runtime.ts"), "--target", "node", "--outfile", BUNDLE],
    { encoding: "utf8" },
  );
  if (built.status !== 0) bundleError = built.stderr || `bun build exited ${built.status}`;
  nodeVersion = runtimeVersion(NODE_BIN, ["--version"]);
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
  "checksum-drift",
  "newer-schema",
  "fk-enforcement",
  "second-writer-busy",
] as const;

describe("store-db runtime floors (actual versions)", () => {
  test(`Bun runner is >= ${MIN_BUN_VERSION} and Node child is >= ${MIN_NODE_VERSION}`, () => {
    expect(bundleError).toBe("");
    expect(Bun.version).toMatch(/^1\.[4-9]\./);
    expect(nodeVersion).toMatch(/^v24\.(1[89]|[2-9]\d)\./);
  });

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
  { runtime: "node", bin: NODE_BIN, version: () => nodeVersion },
  { runtime: "bun", bin: process.execPath, version: () => Bun.version },
])("store scenarios under $runtime (${version()})", ({ runtime, bin, version }) => {
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
