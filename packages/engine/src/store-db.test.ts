/**
 * store-db.test.ts - proof for the issue-store runtime boundary.
 * Run with `bun test packages/engine/src/store-db.test.ts`.
 *
 * The scenario suite below is executed against the REAL store-db.ts
 * implementation and the REAL node:sqlite driver - twice: once in-process
 * under the Bun test runner itself and once per scenario as a child process
 * under the declared Node floor and the same Bun binary, using the test-only
 * `store-test-runtime.ts` helper bundled into a temporary directory. No mock
 * database exists anywhere in this proof. The bundle and all temporary
 * databases are removed after the run.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { chmodSync, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyStoreMigration, planStoreMigration } from "./store-migrate.js";
import { historicalStore } from "./store-migration-fixtures.js";
import { upgradeStoreMinimal } from "./execution-minimal-import.js";
import { backupStore } from "./store-activation.js";
import {
  MIGRATION_15_SQL,
  MIGRATION_16_SQL,
  MIGRATIONS,
  migrationChecksum,
  SCHEMA_VERSION_TABLE_SQL,
  StoreError,
  type StoreRuntimeInfo,
  assertStoreRuntimeSupported,
  compareVersions,
  initializeStore,
  openStore,
  SettlementAttestationNeeded,
  upgradeStore,
  type StoreContext,
} from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-db-test-"));
// The scenario bundle runs as a copied module, so it needs the published layout
// around it: a package root whose manifest carries the runtime floor the module
// reads at runtime. Without it the floor is undiscoverable and the below-floor
// scenario would exercise nothing.
const BUNDLE = join(ROOT, "dist", "store-test-runtime.mjs");

/** Node binary used for the Node-floor leg; overridable for local runs. */
const NODE_BIN = process.env.MSTAR_TEST_NODE_BIN ?? "node";
let bundleError = "";

beforeAll(() => {
  mkdirSync(join(ROOT, "dist"), { recursive: true });
  copyFileSync(join(import.meta.dir, "..", "package.json"), join(ROOT, "package.json"));
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
  const run = spawnSync(bin, [BUNDLE, scenario, dir], { encoding: "utf8", timeout: 60_000 });
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

describe("store-db runtime floors (declared manifest floor)", () => {
  test("compareVersions orders synthetic vectors numerically", () => {
    // Synthetic comparator vectors, not repository versions. The comparator is
    // purely numeric per dotted segment (parseInt), so pre-release suffixes
    // would all collapse to 0 - the vectors must differ in numeric segments.
    const same = "0.0.1";
    const low = "0.0.9";
    const high = "0.0.10";
    expect(compareVersions(same, same)).toBe(0);
    expect(compareVersions(low, high)).toBeLessThan(0);
    expect(compareVersions(high, low)).toBeGreaterThan(0);
  });

  test("below-floor and missing-capability refusals are actionable (in-process, real logic)", () => {
    // The Node floor is read from THIS package's manifest at runtime; no test
    // pins the value (package.json is the sole version authority).
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const floor = (manifest.engines?.node ?? "").replace(/^>=\s*/, "").trim();
    const floorMajor = Number.parseInt(floor.split(".")[0]!, 10);
    const below = `${floorMajor - 1}.0.0`;
    const atOrAbove = `${floorMajor + 1}.0.0`;
    const belowError = (() => {
      try {
        assertStoreRuntimeSupported({ isBun: false, version: below });
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(belowError).toBeInstanceOf(StoreError);
    // The refusal names the runtime it refused; the floor value itself is the
    // manifest's, so no version literal is restated here.
    expect(belowError?.message).toContain("Node");
    expect(() => assertStoreRuntimeSupported({ isBun: false, version: below, hasSqlite: false })).toThrow(
      /node:sqlite/,
    );
    expect(() => assertStoreRuntimeSupported({ isBun: false, version: atOrAbove })).not.toThrow();
  });

  test("a Node refusal names only the Node floor and no other runtime", () => {
    // Same manifest read as the sibling test: the floor value is the manifest's,
    // so no version literal is restated here.
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const floor = (manifest.engines?.node ?? "").replace(/^>=\s*/, "").trim();
    if (floor === "") throw new Error("the engine manifest declares no engines.node floor");
    const belowFloor = `${Number.parseInt(floor.split(".")[0]!, 10) - 1}.0.0`;
    const probes: readonly { info: StoreRuntimeInfo; names: RegExp }[] = [
      { info: { isBun: false, version: belowFloor }, names: new RegExp(`Node >=${floor.replaceAll(".", "\\.")}`) },
      { info: { isBun: false, version: floor, hasSqlite: false }, names: /node:sqlite/ },
    ];
    for (const { info, names } of probes) {
      const message = (() => {
        try {
          assertStoreRuntimeSupported(info);
        } catch (error) {
          return (error as Error).message;
        }
        throw new Error(`expected a runtime refusal for ${info.version}`);
      })();
      expect(message).toMatch(names);
      expect(message).not.toMatch(/[Bb]un/);
    }
    // Bun is a development toolchain and carries no version floor: only the
    // native-sqlite capability gates it, so an old Bun is not version-refused.
    expect(() => assertStoreRuntimeSupported({ isBun: true, version: "0.0.0-synthetic" })).not.toThrow();
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
    // SQLite driver wording varies by platform; both messages mean the corrupt
    // file could not be opened as a database.
    bytes[18] = 2;
    bytes[19] = 2;
    writeFileSync(path, bytes);

    await expect(openStore({ harnessDir: dir }, "read")).rejects.toMatchObject({
      code: "store.corrupt",
      message: expect.stringMatching(/unable to open database file|not a database/i),
    });
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

    await expect(openStore({ harnessDir: dir }, "read")).rejects.toMatchObject({ code: "store.corrupt" });
    await expect(openStore({ harnessDir: dir }, "write")).rejects.toMatchObject({ code: "store.corrupt" });
    // Nothing was created for the refused link, and the leftover bytes stayed.
    expect(existsSync(`${join(dir, "store.db")}-wal`)).toBe(false);
    expect(existsSync(join(dir, "status.json"))).toBe(true);
  });
});

describe("store-db L2 fix round", () => {
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
    // Test-owned injection at the staging claim: the hook throws inside the
    // initializer's own try, so the real post-claim cleanup path runs.
    await expect(
      initializeStore(
        { harnessDir: dir },
        {
          afterStagingClaim: () => {
            throw new Error("induced init failure");
          },
        },
      ),
    ).rejects.toThrow(/induced init failure/);
    expect(existsSync(join(dir, "store.db"))).toBe(false);
  });

  test("a competing initializer's store is refused, never opened or removed", async () => {
    const dir = mkdtempSync(join(ROOT, "claim-window-"));
    const path = join(dir, "store.db");
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

  test("pre-existing sqlite without schema_version is refused and its contents are unchanged", async () => {
    const dir = mkdtempSync(join(ROOT, "preexist-noschema-"));
    const path = join(dir, "store.db");
    const foreign = new DatabaseSync(path);
    foreign.exec("create table leftover(id integer primary key, note text)");
    foreign.exec("insert into leftover(note) values ('keep-me')");
    foreign.close();
    await expect(initializeStore({ harnessDir: dir })).rejects.toMatchObject({ code: "store.already-exists" });
    const check = new DatabaseSync(path, { readOnly: true });
    const row = check.prepare("select note from leftover").get() as { note?: string };
    expect(row.note).toBe("keep-me");
    const tables = check
      .prepare("select name from sqlite_master where type='table' and name='schema_version'")
      .all() as Array<{ name: string }>;
    expect(tables).toEqual([]);
    check.close();
  });

  test("empty pre-existing file is refused and left in place", async () => {
    const dir = mkdtempSync(join(ROOT, "preexist-empty-"));
    const path = join(dir, "store.db");
    writeFileSync(path, "");
    await expect(initializeStore({ harnessDir: dir })).rejects.toMatchObject({ code: "store.already-exists" });
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBe(0);
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
    expect(handle.execution?.authorityState).toBe("active");
    expect(meta.authority_epoch).toBe(1);
    handle.close();
  });

  test("the published bounded wait is the default when no option is passed", async () => {
    const dir = mkdtempSync(join(ROOT, "busy-"));
    const handle = await initializeStore({ harnessDir: dir });
    const row = handle.db.prepare("pragma busy_timeout").get() as { timeout?: number; busy_timeout?: number };
    const timeout = row.timeout ?? row.busy_timeout;
    expect(timeout).toBe(5000);
    handle.close();
  });

  test("an out-of-domain bounded wait (non-finite, non-positive or above the signed-32-bit maximum) falls back to the published 5000 ms default", async () => {
    // The normaliser owns exactly one fallback: a floored value outside SQLite's
    // positive signed-32-bit domain becomes the published constant, so every one
    // of these caller mistakes yields the same 5000 ms bound instead of a
    // pragma-visible NaN, zero, negative or overflowed number.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 2147483648]) {
      const dir = mkdtempSync(join(ROOT, "busy-out-of-domain-"));
      const handle = await initializeStore({ harnessDir: dir }, { busyTimeoutMs: value });
      const row = handle.db.prepare("pragma busy_timeout").get() as { timeout?: number; busy_timeout?: number };
      handle.close();
      expect({ value, timeout: row.timeout ?? row.busy_timeout }).toEqual({ value, timeout: 5000 });
    }
  });

  test("a non-integral bounded wait reaches the pragma as the exact integer every refusal reports", async () => {
    const dir = mkdtempSync(join(ROOT, "busy-fraction-"));
    const held = mkdtempSync(join(ROOT, "busy-fraction-holder-"));
    // SQLite's busy_timeout is an integer millisecond count: the effective
    // pragma value for 1.5ms must be the SAME normalised integer the refusal
    // text reports, never the raw 1.5 the pragma would silently truncate.
    const handle = await initializeStore({ harnessDir: dir }, { busyTimeoutMs: 1.5 });
    const row = handle.db.prepare("pragma busy_timeout").get() as { timeout?: number; busy_timeout?: number };
    const effective = row.timeout ?? row.busy_timeout;
    expect(effective).toBe(1);
    // The copy is how this suite obtains store bytes this process has not
    // already mapped, so a competing writer can genuinely hold the file.
    await backupStore({ harnessDir: dir }, { out: join(held, "store.db") });
    handle.close();
    const holder = new DatabaseSync(join(held, "store.db"));
    try {
      holder.exec("pragma busy_timeout=0");
      holder.exec("pragma journal_mode=delete");
      holder.exec("begin exclusive");
      holder.prepare("select count(*) as n from store_meta").get();
      const refusal: unknown = await openStore({ harnessDir: held }, "write", { busyTimeoutMs: 1.5 }).then(
        () => null,
        (error) => error,
      );
      expect(refusal).toMatchObject({ code: "store.busy" });
      const message = refusal instanceof Error ? refusal.message : "";
      expect(message).toContain(`bounded wait (${effective}ms)`);
    } finally {
      try {
        holder.exec("rollback");
      } catch {
        // the exclusive section may already be gone
      }
      holder.close();
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
/* ------------------------------------------------------------------------ *
 * Read-open convergence across a same-process writer's DEFERRED cleanup: Bun
 * 1.4.0's node:sqlite completes a closed handle's checkpoint and sidecar
 * removal on COLLECTION, so a read-only open can have its `-wal`/`-shm`
 * deleted underneath it and report SQLITE_CANTOPEN ("unable to open database
 * file") for a store that is entirely intact. `openStore(…, "read")` re-runs
 * the existing journal preparation on a bounded budget and converges once the
 * cleanup settles; a store that STAYS unreadable keeps the same refusal.
 * ------------------------------------------------------------------------ */

describe("store-db read-open converges across the writer-close window", () => {
  // The window closes on the runtime's next collection, which is exactly why
  // it is invisible to a plain open. Forcing a minor collection between the
  // writer close and the read opens it deterministically enough to make a
  // regression (a single-shot open) fail instead of flaking; without it the
  // read happens to succeed and the case would prove nothing.
  /** A store with one committed issue, so convergence is proven by a real read. */
  const seedStoreWithIssue = async (dir: string): Promise<void> => {
    const writer = await initializeStore({ harnessDir: dir });
    writer.db.prepare(
      "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
        " values ('I-000901', 'p', 'window issue', 'bug', 'high', 'i', 'a', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z', 'read-open-window')",
    ).run();
    writer.close();
  };

  test("a read right after a writer close converges without a reader seal", async () => {
    const dir = mkdtempSync(join(ROOT, "read-open-window-"));
    await seedStoreWithIssue(dir);
    Bun.gc(false);
    const reader = await openStore({ harnessDir: dir }, "read");
    expect(reader.epoch).toBe(1);
    expect(reader.schemaVersion).toBe(MIGRATIONS.length);
    // Convergence is a real readable store, not merely an opened handle.
    expect(reader.db.prepare("select title from issues where id = 'I-000901'").get()).toEqual({ title: "window issue" });
    reader.close();
  });

  test("a loop of close-then-read converges every iteration", async () => {
    for (let iteration = 0; iteration < 20; iteration++) {
      const dir = mkdtempSync(join(ROOT, `read-open-loop-${iteration}-`));
      await seedStoreWithIssue(dir);
      Bun.gc(false);
      const reader = await openStore({ harnessDir: dir }, "read");
      expect(reader.db.prepare("select count(*) as n from issues").get()).toEqual({ n: 1 });
      reader.close();
    }
  });

  test("a store that stays unreadable still refuses store.corrupt with the CANTOPEN detail", async () => {
    // A WAL-format header whose file size is not a whole number of the page
    // size it claims: every read-only open of this file reports SQLITE_CANTOPEN
    // and the shape never becomes readable, so the bounded retry is spent and
    // the SAME refusal stands. This is the honest-classification boundary: the
    // transient-window retry is not a general "try again until it works".
    const dir = mkdtempSync(join(ROOT, "read-open-persistent-"));
    const bytes = Buffer.alloc(100);
    bytes.write("SQLite format 3\u0000", 0, "latin1");
    bytes.writeUInt16BE(4096, 16);
    bytes[18] = 2;
    bytes[19] = 2;
    bytes[21] = 64;
    bytes[22] = 32;
    bytes[23] = 32;
    writeFileSync(join(dir, "store.db"), bytes);
    // The refusal keeps the driver's own unreadability detail, not a generic
    // block: the retry spent its budget on a shape that never converged. The
    // driver classifies the same shape differently per platform (macOS
    // SQLITE_CANTOPEN "unable to open database file"; Linux SQLITE_NOTADB
    // "file is not a database" or SQLITE_CORRUPT "database disk image is
    // malformed"), so the test accepts any verbatim driver unreadability
    // detail. Whether the driver leaves transient -wal/-shm sidecars behind
    // is likewise platform-dependent and is not part of the refusal contract;
    // the asserted boundary is the store.corrupt classification with the
    // verbatim driver detail after the spent retry budget.
    await expect(openStore({ harnessDir: dir }, "read")).rejects.toMatchObject({
      code: "store.corrupt",
      message: expect.stringMatching(/unable to open database file|not a database|disk image is malformed/),
    });
  });
});

describe("migration 7 - project_milestones", () => {
  test("milestone fresh install and retry retain the current schema", async () => {
    const dir = mkdtempSync(join(ROOT, "milestone-fresh-"));
    const handle = await initializeStore({ harnessDir: dir });
    expect(handle.schemaVersion).toBe(MIGRATIONS.length);
    const columns = handle.db.prepare("pragma table_info(issues)").all() as Array<{ name?: string }>;
    expect(columns.some((column) => column.name === "milestone_id")).toBe(true);
    handle.close();
    expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: MIGRATIONS.length });
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
    expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: MIGRATIONS.length });
    const upgraded = await openStore({ harnessDir: dir }, "read");
    expect(upgraded.db.prepare("select id, milestone_id from issues where id='I-000102'").get()).toEqual({
      id: "I-000102",
      milestone_id: null,
    });
    upgraded.close();
  });
  test("concurrent public upgrades serialize pending migration selection", async () => {
    const dir = mkdtempSync(join(ROOT, "milestone-concurrent-upgrade-"));
    const db = new DatabaseSync(join(dir, "store.db"));
    db.exec("pragma foreign_keys=on");
    db.exec("begin");
    db.exec("create table schema_version(version integer primary key, name text not null unique, checksum text not null, applied_at text not null)");
    for (const migration of MIGRATIONS.slice(0, 6)) {
      db.exec(migration.sql);
      db.prepare("insert into schema_version values(?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), "now");
    }
    db.prepare(
      "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', 'p-concurrent', 'Concurrent', 'projects', 'p-concurrent/roadmap.md', 'now', 'now')",
    ).run();
    db.exec("commit");
    db.close();

    let armed = true;
    const originalExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql: string): void {
      if (armed && sql.trim().toLowerCase() === "begin immediate") {
        armed = false;
        // At the real writer-admission call-through, let a separate native
        // process commit the pending batch before this connection proceeds.
        const competitor = spawnSync(NODE_BIN, [BUNDLE, "upgrade-pending", dir], {
          encoding: "utf8",
          timeout: 60_000,
        });
        expect(competitor.status).toBe(0);
        expect(competitor.stdout).toContain(`OK upgrade-pending: public upgrade returned schemaVersion=${MIGRATIONS.length}`);
      }
      return originalExec.call(this, sql);
    };
    try {
      expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: MIGRATIONS.length });
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    expect(armed).toBe(false);
  });
  test("milestone migration refusal covers version gaps and newer versions", async () => {
    for (const [label, mutate, code] of [
      ["gap", "delete from schema_version where version=2", "store.schema-drift"],
      ["newer", `insert into schema_version values(${MIGRATIONS.length + 1}, 'future', 'future', 'now')`, "store.schema-unsupported"],
    ] as const) {
      const dir = mkdtempSync(join(ROOT, `milestone-${label}-`));
      const handle = await initializeStore({ harnessDir: dir });
      handle.db.exec(mutate);
      const versionsBefore = handle.db.prepare("select * from schema_version order by version").all();
      handle.close();
      await expect(upgradeStore({ harnessDir: dir })).rejects.toMatchObject({ code });
      const unchanged = new DatabaseSync(join(dir, "store.db"), { readOnly: true });
      expect(versionsBefore).toEqual(unchanged.prepare("select * from schema_version order by version").all());
      unchanged.close();
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

/* ------------------------------------------------------------------------ *
 * Migration 12 rebuilds `issues` for the `nit` vocabulary. `issues` is the
 * parent of occurrences/provenance/relations/issue_transitions, and the
 * migration batch runs with foreign_keys=ON, so the test drives the whole path
 * through the public upgrade against a schema-11 store carrying children.
 * ------------------------------------------------------------------------ */

describe("migration 12 - severity vocabulary accepts nit and converts info", () => {
  test("an info row becomes nit, every row survives, and dependent tables still resolve", async () => {
    const dir = mkdtempSync(join(ROOT, "severity-nit-upgrade-"));
    const db = new DatabaseSync(join(dir, "store.db"));
    db.exec("pragma foreign_keys=on");
    db.exec("begin");
    db.exec(SCHEMA_VERSION_TABLE_SQL);
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 11)) {
      db.exec(migration.sql);
      db.prepare("insert into schema_version values(?, ?, ?, ?)").run(
        migration.version,
        migration.name,
        migrationChecksum(migration),
        "now",
      );
    }
    db.prepare("update store_meta set authority_state='active' where id=1").run();
    const insertIssue = db.prepare(
      "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
        " values (?, 'p-nit', ?, 'bug', ?, 'impact', 'acceptance', 'now', 'now', ?)",
    );
    for (const [id, severity] of [
      ["I-000201", "critical"],
      ["I-000202", "high"],
      ["I-000203", "medium"],
      ["I-000204", "low"],
      ["I-000205", "info"],
      ["I-000206", "info"],
    ] as const) {
      insertIssue.run(id, `Issue ${id}`, severity, `identity-${id}`);
    }
    db.prepare(
      "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key," +
        " location, observed_behavior, evidence_json, recorded_at) values ('I-000205', 'occ-1', 'test', 'src', 'rc', 'ac', 'loc', 'observed', '[]', 'now')",
    ).run();
    db.prepare(
      "insert into provenance(issue_id, kind, target, source_hash) values ('I-000206', 'legacy', 'target', 'hash')",
    ).run();
    db.prepare("insert into relations(from_issue, relation, to_issue) values ('I-000201', 'blocks', 'I-000205')").run();
    db.prepare(
      "insert into issue_transitions(issue_id, from_disposition, to_disposition, recorded_at, reason, evidence_json, issue_revision)" +
        " values ('I-000205', 'open', 'resolved', 'now', 'done', '[]', 1)",
    ).run();
    db.exec("commit");
    db.close();

    expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: MIGRATIONS.length });

    const upgraded = await openStore({ harnessDir: dir }, "read");
    try {
      expect(upgraded.db.prepare("select count(*) as n from issues").get()).toEqual({ n: 6 });
      expect(upgraded.db.prepare("select count(*) as n from issues where severity='info'").get()).toEqual({ n: 0 });
      expect(upgraded.db.prepare("select count(*) as n from issues where severity='nit'").get()).toEqual({ n: 2 });
      expect(
        upgraded.db.prepare("select severity from issues where id in ('I-000201','I-000202','I-000203','I-000204') order by id").all(),
      ).toEqual([{ severity: "critical" }, { severity: "high" }, { severity: "medium" }, { severity: "low" }]);
      // The converted rows keep their children resolvable after the rebuild.
      expect(
        upgraded.db
          .prepare("select i.severity from occurrences o join issues i on i.id = o.issue_id where o.occurrence_key='occ-1'")
          .get(),
      ).toEqual({ severity: "nit" });
      expect(
        upgraded.db.prepare("select i.severity from provenance p join issues i on i.id = p.issue_id").get(),
      ).toEqual({ severity: "nit" });
      expect(
        upgraded.db
          .prepare("select i.severity from relations r join issues i on i.id = r.from_issue where r.to_issue='I-000205'")
          .get(),
      ).toEqual({ severity: "critical" });
      expect(
        upgraded.db
          .prepare("select i.severity from issue_transitions t join issues i on i.id = t.issue_id")
          .get(),
      ).toEqual({ severity: "nit" });
      expect(upgraded.db.prepare("pragma foreign_key_check").all()).toEqual([]);
      // The rebuilt table carries the migration-1 indexes and the migration-7
      // milestone column; the `nit` CHECK is the live constraint.
      expect(
        (upgraded.db.prepare("pragma table_info(issues)").all() as Array<{ name?: string }>).some((column) => column.name === "milestone_id"),
      ).toBe(true);
      expect(
        upgraded.db.prepare("select name from sqlite_master where type='index' and name in ('issues_external_identity','issues_disposition','issues_milestone_disposition')").all(),
      ).toHaveLength(3);
    } finally {
      upgraded.close();
    }
    const writable = await openStore({ harnessDir: dir }, "write");
    try {
      expect(() =>
        writable.db
          .prepare(
            "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
              " values ('I-000207', 'p-nit', 'Rejected', 'bug', 'info', 'impact', 'acceptance', 'now', 'now', 'identity-I-000207')",
          )
          .run(),
      ).toThrow(/check/i);
    } finally {
      writable.close();
    }
    expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: MIGRATIONS.length });
    rmSync(dir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------------ *
 * The schema-unsupported refusal names the STORE, the BUILD and the MIGRATION
 * as three distinct facts. A build that lags a store written by several newer
 * migrations meets the FIRST migration it cannot interpret, which is neither
 * the store's own highest applied version nor anything this build supports:
 * reporting that first-unknown row as "the store version" understates the store
 * by a whole generation and sends the operator to the wrong upgrade target.
 * ------------------------------------------------------------------------ */

describe("migration 15 - sync ledger", () => {
  test("upgrades a store at the previous version and re-opens idempotently", async () => {
    const dir = mkdtempSync(join(ROOT, "sync-ledger-upgrade-"));
    const db = historicalStore(dir, 14);
    const before = db.prepare("select max(version) as v from schema_version").get() as { v: number };
    expect(before.v).toBe(14);
    db.close();
    expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: MIGRATIONS.length });
    const upgraded = await openStore({ harnessDir: dir }, "read");
    const tables = upgraded.db
      .prepare("select name from sqlite_master where type='table' and name in ('project_bindings','issue_sync_state','sync_cursor') order by name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(["issue_sync_state", "project_bindings", "sync_cursor"]);
    const stateColumns = (
      upgraded.db.prepare("pragma table_info(issue_sync_state)").all() as Array<{ name?: string }>
    ).map((column) => column.name);
    expect(stateColumns).toContain("last_skip_reason");
    upgraded.close();
    // Re-open applies no pending migration and keeps the version.
    expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: MIGRATIONS.length });
  });

  test("ledger DDL holds its keys and uniqueness", async () => {
    const dir = mkdtempSync(join(ROOT, "sync-ledger-keys-"));
    const handle = await initializeStore({ harnessDir: dir });
    const { db } = handle;
    db.prepare(
      "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', 'p-one', 'P', 'projects', 'p-one/roadmap.md', 'now', 'now')",
    ).run();
    const insertIssue = db.prepare(
      "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
        " values (?, 'p-one', 'Issue', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', ?)",
    );
    insertIssue.run("I-000201", "ledger-issue-1");
    insertIssue.run("I-000202", "ledger-issue-2");
    insertIssue.run("I-000203", "ledger-issue-3");
    db.prepare(
      "insert into project_bindings(project_id, provider, workspace, team, remote_project, revision, updated_at) values ('p-one','linear','ws','team','RP',1,'now')",
    ).run();
    // A second store project cannot claim the same remote project.
    expect(() =>
      db.prepare(
        "insert into project_bindings(project_id, provider, workspace, team, remote_project, revision, updated_at) values ('p-two','linear','ws','team','RP',1,'now')",
      ).run(),
    ).toThrow();
    const insertState = db.prepare(
      "insert into issue_sync_state(binding_id, direction, local_id, external_id, item_state, revision, updated_at)" +
        " values ('linear:p-one','import',?, ?, 'pending', 1, 'now')",
    );
    insertState.run("I-000201", "EXT-1");
    // A second row for the same item key is refused by the primary key.
    expect(() => insertState.run("I-000201", "EXT-1")).toThrow();
    // ...but null external_id rows are not subject to the partial index.
    db.prepare(
      "insert into issue_sync_state(binding_id, direction, local_id, external_id, item_state, revision, updated_at)" +
        " values ('linear:p-one','import',?, null, 'pending', 1, 'now')",
    ).run("I-000202");
    db.prepare(
      "insert into issue_sync_state(binding_id, direction, local_id, external_id, item_state, revision, updated_at)" +
        " values ('linear:p-one','import',?, null, 'pending', 1, 'now')",
    ).run("I-000203");
    const cursor = db.prepare(
      "insert into sync_cursor(binding_id, direction, cursor, updated_at) values ('linear:p-one','import','c1','now')" +
        " on conflict(binding_id, direction) do update set cursor=excluded.cursor",
    );
    cursor.run();
    cursor.run();
    expect(db.prepare("select count(*) as n from sync_cursor").get()).toEqual({ n: 1 });
    handle.close();
  });
});

describe("store-db schema-unsupported reports store / build / first-unknown distinctly", () => {
  test("a store written past this build's supported maximum reports all three facts, not the first unknown row as the store version", async () => {
    const dir = mkdtempSync(join(ROOT, "schema-facts-"));
    const handle = await initializeStore({ harnessDir: dir });
    const supportedMax = Math.max(...MIGRATIONS.map((migration) => migration.version));
    // Simulate a store written by a NEWER build: a real applied set for the
    // build's own migrations, plus two migrations this build does not carry.
    const insert = handle.db.prepare("insert into schema_version(version, name, checksum, applied_at) values(?, ?, ?, ?)");
    insert.run(supportedMax + 1, "from-a-newer-build", "f".repeat(64), "2026-09-18T00:00:00.000Z");
    insert.run(supportedMax + 2, "from-an-even-newer-build", "e".repeat(64), "2026-09-18T00:00:00.000Z");
    const highestApplied = supportedMax + 2;
    const firstUnsupported = supportedMax + 1;
    handle.close();

    // The baseline and the post-refusal read both go through the real driver,
    // so the rows keep the driver's own shape and the comparison needs no
    // annotation or suppression.
    const baseline = new DatabaseSync(join(dir, "store.db"), { readOnly: true });
    const versionsBefore = baseline.prepare("select version from schema_version order by version").all();
    baseline.close();

    // The validation guard is unchanged: the read still refuses this store.
    const refusal: unknown = await openStore({ harnessDir: dir }, "read").then(() => null, (error: unknown) => error);
    expect(refusal).toMatchObject({ code: "store.schema-unsupported" });
    const message = refusal !== null && typeof refusal === "object" && "message" in refusal && typeof refusal.message === "string"
      ? refusal.message
      : "";
    expect(message).not.toBe("");
    // The store's OWN highest applied version - which is NOT the first row this
    // build cannot interpret (that is the whole defect this regression pins).
    expect(message).toContain(`highest applied schema version is ${highestApplied}`);
    expect(message).not.toContain(`highest applied schema version is ${firstUnsupported}`);
    // The loaded build's supported maximum, and the first unsupported migration.
    expect(message).toContain(`this build supports versions 1..${supportedMax}`);
    expect(message).toContain(`first unsupported migration is ${firstUnsupported}`);
    // The same three facts travel as MACHINE facts on `details`, so an agent
    // (and `status.validate`, which forwards a store error's details verbatim)
    // reads the values instead of re-parsing prose.
    expect(refusal).toMatchObject({
      details: { storeSchemaVersion: highestApplied, supportedSchemaMax: supportedMax, firstUnsupportedMigration: firstUnsupported },
    });
    // No state write: the guard refuses before any mutation and every row stands.
    const after = new DatabaseSync(join(dir, "store.db"), { readOnly: true });
    expect(after.prepare("select version from schema_version order by version").all()).toEqual(versionsBefore);
    after.close();
  });
});

/* ------------------------------------------------------------------------ *
 * Publish-atomic creation (T5a C1). The old claim-close-then-migrate sequence
 * left a schema-less `store.db` visible at the canonical path for the whole
 * migration window, so a concurrent upgrade read it and reported a false
 * `store.corrupt`. Creation now builds the complete store beside the path and
 * publishes it with one create-only hard link: the canonical name is either
 * absent or a complete committed store, and the publish is the only
 * serialization point - no lock, no mutex, no polling.
 * ------------------------------------------------------------------------ */

describe("store-db creation publishes atomically", () => {
  const refusalCode = (error: unknown): string => {
    if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    return String(error);
  };

  const parseChildOutcome = (
    output: string,
  ): { epoch?: number; schemaVersion?: number; refused?: string; observed?: boolean; verdict?: string } => {
    const value: unknown = JSON.parse(output);
    if (value === null || typeof value !== "object") throw new Error(`unexpected child output: ${output}`);
    const outcome: { epoch?: number; schemaVersion?: number; refused?: string; observed?: boolean; verdict?: string } = {};
    if ("refused" in value && typeof value.refused === "string") outcome.refused = value.refused;
    if ("epoch" in value && typeof value.epoch === "number") outcome.epoch = value.epoch;
    if ("schemaVersion" in value && typeof value.schemaVersion === "number") outcome.schemaVersion = value.schemaVersion;
    if ("observed" in value && typeof value.observed === "boolean") outcome.observed = value.observed;
    if ("verdict" in value && typeof value.verdict === "string") outcome.verdict = value.verdict;
    return outcome;
  };

  test("an upgrade peer during a concurrent first creation never reads a partial store", async () => {
    const dir = mkdtempSync(join(ROOT, "publish-atomic-"));
    const storePath = join(dir, "store.db");
    // The peer runs in its OWN process, so it can look between the creator's
    // synchronous steps - the same interleaving that produced the reported
    // false corruption. It spins on the canonical path's first appearance and
    // immediately runs the real public upgrade against those bytes.
    const observer = join(ROOT, "upgrade-observer.mjs");
    writeFileSync(observer, `
import { existsSync } from "node:fs";
import { upgradeStore } from ${JSON.stringify(join(import.meta.dir, "store-db.ts"))};
const harnessDir = process.argv[2];
const storePath = harnessDir + "/store.db";
// Announce readiness and spin immediately: the peer must already be watching
// the canonical path when the creator starts, so it cannot miss the window
// between a claimed path and its committed schema.
process.stdout.write("ready\\n");
for (let turn = 0; turn < 2000000 && !existsSync(storePath); turn++) {
  const turnDone = Promise.withResolvers();
  setImmediate(turnDone.resolve);
  await turnDone.promise;
}
if (!existsSync(storePath)) {
  process.stdout.write(JSON.stringify({ observed: false }));
} else {
  try {
    await upgradeStore({ harnessDir });
    process.stdout.write(JSON.stringify({ observed: true, verdict: "upgraded" }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ observed: true, verdict: String(error?.code ?? error?.message ?? error) }));
  }
}
`);
    const child = spawn(process.execPath, [observer, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const ready = Promise.withResolvers<void>();
    child.stdout.once("data", () => ready.resolve());
    const closed = Promise.withResolvers<number | null>();
    child.on("close", (code) => closed.resolve(code));

    // The creator starts only once the peer is spinning, so the peer really
    // observes the canonical path's first appearance.
    await ready.promise;
    const creator = initializeStore({ harnessDir: dir }).then((handle) => {
      handle.close();
      return "created";
    });
    expect(await creator).toBe("created");
    expect(existsSync(storePath)).toBe(true);

    const payload = parseChildOutcome((await closed.promise.then(() => stdout)).slice("ready\n".length));
    // The peer must have observed the path: it was spinning from the release
    // line, well before the creator finished.
    expect(payload.observed).toBe(true);
    const peerVerdict = payload.verdict;
    // `upgraded` proves the peer read a COMPLETE store; `store.busy` is the
    // worker's emitted bounded-wait code and the honest allowed disposition.
    // What must never appear is the old false `store.corrupt` verdict for an
    // in-flight creation.
    expect(peerVerdict === "upgraded" || peerVerdict === "store.busy").toBe(true);
    // The published store is complete.
    const reader = await openStore({ harnessDir: dir }, "read");
    try {
      expect(reader.epoch).toBe(1);
      expect(reader.schemaVersion).toBe(MIGRATIONS.length);
    } finally {
      reader.close();
    }
    expect(readdirSync(dir).filter((name) => name.startsWith(".store.db.init-"))).toEqual([]);
  });

  test("barrier-released first initializers publish exactly one complete store", async () => {
    const dir = mkdtempSync(join(ROOT, "concurrent-create-"));
    const worker = join(ROOT, "initialize-worker.mjs");
    writeFileSync(worker, `
import { initializeStore } from ${JSON.stringify(join(import.meta.dir, "store-db.ts"))};
const [harnessDir] = process.argv.slice(2);
// Announce readiness, then block on the parent's release line, so every child
// begins its creation only once all of them are waiting: they truly overlap.
process.stdout.write("ready\\n");
const reader = Bun.stdin.stream().getReader();
await reader.read();
reader.releaseLock();
try {
  const store = await initializeStore({ harnessDir });
  const published = { epoch: store.epoch, schemaVersion: store.schemaVersion, storeId: store.storeId };
  store.close();
  process.stdout.write(JSON.stringify(published));
} catch (error) {
  process.stdout.write(JSON.stringify({ refused: String(error?.code ?? error?.message ?? error) }));
}
`);
    const children = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, [worker, dir], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      const ready = Promise.withResolvers<void>();
      child.stdout.once("data", () => ready.resolve());
      const closed = Promise.withResolvers<number | null>();
      child.on("close", (code) => closed.resolve(code));
      return {
        ready: ready.promise,
        release: () => child.stdin.end("go\n"),
        done: closed.promise.then(() => stdout),
      };
    });
    await Promise.all(children.map((child) => child.ready));
    for (const child of children) child.release();
    const outcomes = (await Promise.all(children.map((child) => child.done)))
      .map((output) => parseChildOutcome(output.slice("ready\n".length)));

    const published = outcomes.filter((outcome) => outcome.refused === undefined);
    const refused = outcomes.filter((outcome) => outcome.refused !== undefined);
    // The create-only publish has exactly one winner; every loser refuses with
    // the truthful create-only code - never a corruption or lock verdict - and
    // the refusal is retried through the same public operation below.
    expect(published).toHaveLength(1);
    expect(refused).toHaveLength(3);
    for (const outcome of refused) expect(outcome.refused).toBe("store.already-exists");

    const winner = published[0]!;
    expect(winner.epoch).toBe(1);
    expect(winner.schemaVersion).toBe(MIGRATIONS.length);

    // The published store is complete and holds real domain state: a real row
    // written through a write-open survives into a fresh read-only open.
    const writer = await openStore({ harnessDir: dir }, "write");
    writer.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000001', 'p', 'race issue', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'race-issue')",
      )
      .run();
    writer.close();
    const reader = await openStore({ harnessDir: dir }, "read");
    try {
      expect(reader.db.prepare("select title from issues where id = 'I-000001'").get()).toEqual({ title: "race issue" });
      expect(reader.db.prepare("select authority_state from store_meta where id = 1").get()).toEqual({ authority_state: "active" });
      expect(reader.db.prepare("select authority_state from execution_meta where id = 1").get()).toEqual({ authority_state: "active" });
    } finally {
      reader.close();
    }
    // The loser's supported retry is the ordinary public upgrade: idempotent.
    expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: MIGRATIONS.length });
    // No staging scratch and no lock artifacts anywhere in the workspace.
    expect(readdirSync(dir).filter((name) => name.startsWith(".store.db.init-"))).toEqual([]);
    expect(existsSync(join(dir, ".status-write.lockdir"))).toBe(false);
    expect(existsSync(join(dir, ".execution-maintenance"))).toBe(false);
  }, 60_000);

  test("an interrupted first create publishes nothing and the path stays initializable", async () => {
    const dir = mkdtempSync(join(ROOT, "interrupted-create-"));
    await expect(
      initializeStore(
        { harnessDir: dir },
        {
          afterStagingClaim: () => {
            throw new Error("induced init failure");
          },
        },
      ),
    ).rejects.toThrow(/induced init failure/);
    // The interrupted create left NO canonical store and none of its own
    // staging scratch behind.
    expect(existsSync(join(dir, "store.db"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    // A hard-killed creator cannot clean its staging scratch up; that leftover
    // is inert: the next attempt never reads, adopts or sweeps it.
    const staleScratch = join(dir, ".store.db.init-999999-crash.tmp");
    writeFileSync(staleScratch, "stale staging bytes from a killed creator");
    const store = await initializeStore({ harnessDir: dir });
    expect(store.epoch).toBe(1);
    store.close();
    expect(existsSync(join(dir, "store.db"))).toBe(true);
    expect(readFileSync(staleScratch, "utf8")).toBe("stale staging bytes from a killed creator");
  });

  test("a pre-existing invalid store file is preserved, never adopted or repaired", async () => {
    const dir = mkdtempSync(join(ROOT, "invalid-bytes-"));
    const storePath = join(dir, "store.db");
    const retained = Buffer.from("SQLite format 3\u0000truncated retained bytes, not a real store");
    writeFileSync(storePath, retained);
    await expect(initializeStore({ harnessDir: dir })).rejects.toMatchObject({ code: "store.already-exists" });
    expect([...readFileSync(storePath)]).toEqual([...retained]);
    // An upgrade peer classifies it as the corruption it is - it never
    // misreads it as a creation in progress to wait out, and no staging
    // scratch appears beside it.
    await expect(upgradeStore({ harnessDir: dir })).rejects.toMatchObject({ code: "store.corrupt" });
    expect([...readFileSync(storePath)]).toEqual([...retained]);
    expect(readdirSync(dir).filter((name) => name.startsWith(".store.db.init-"))).toEqual([]);
  });

  test("a publication failure names the real phase and cause, and the same entry recovers", async () => {
    const dir = mkdtempSync(join(ROOT, "publication-refusal-"));
    // A real operating-system failure at the creation phase: the control root
    // cannot hold the staged file, so no store can be created at all.
    chmodSync(dir, 0o500);
    let refusal: unknown;
    try {
      refusal = await initializeStore({ harnessDir: dir }).then(
        () => null,
        (error) => error,
      );
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(refusal).toMatchObject({ code: "store.publication-failed" });
    const message = refusal instanceof Error ? refusal.message : "";
    // The absent store is never diagnosed as corruption, and the OS cause and
    // the no-publication fact travel with the refusal.
    expect(message).toContain("NO store was published at");
    expect(message).toMatch(/EACCES|permission denied|Read-only/i);
    expect(message).toContain("--harness");
    expect(existsSync(join(dir, "store.db"))).toBe(false);
    // The advertised recovery is the same public entry once the condition is
    // resolved: it succeeds and produces a complete ACTIVE store.
    const store = await initializeStore({ harnessDir: dir });
    expect(store.epoch).toBe(1);
    store.close();
    expect(existsSync(join(dir, "store.db"))).toBe(true);
  });

  test("a post-publication handle failure discloses the created store and its recovery works", async () => {
    const dir = mkdtempSync(join(ROOT, "partial-publication-"));
    const storePath = join(dir, "store.db");
    // A REAL competing writer, not an injected fault: as soon as the canonical
    // name appears, this task takes the store's write lock through the real
    // driver and holds it, so the creator's own final reopen runs the genuine
    // busy path of the native driver. The interleave point is the creator's
    // own awaits (it turns are taken between them), so no clock is involved.
    const competitorDone = Promise.withResolvers<void>();
    const competitor = (async () => {
      for (let turn = 0; turn < 200000 && !existsSync(storePath); turn++) {
        await Promise.resolve();
      }
      if (!existsSync(storePath)) return;
      const rival = new DatabaseSync(storePath);
      try {
        rival.exec("begin immediate");
        await competitorDone.promise;
        rival.exec("rollback");
      } finally {
        rival.close();
      }
    })();
    const refusal: unknown = await initializeStore({ harnessDir: dir }, { busyTimeoutMs: 50 }).then(
      () => null,
      (error) => error,
    );
    competitorDone.resolve();
    await competitor;
    // The partial outcome is disclosed as one: created, activated, published -
    // and this attempt's handle acquisition failed on the real busy path -
    // with the actual cause and the supported continuation.
    expect(refusal).toMatchObject({ code: "store.created-handle-failed" });
    const message = refusal instanceof Error ? refusal.message : "";
    expect(message).toContain("created, activated and published");
    expect(message).toContain("NOT modified, rolled back or removed");
    expect(message).toMatch(/store\.busy|bounded wait/);
    expect(message).toContain("store upgrade --harness");
    // The published image survives intact: a complete ACTIVE store that real
    // domain writes survive into.
    const writer = await openStore({ harnessDir: dir }, "write");
    writer.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000001', 'p', 'partial outcome', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'partial-outcome')",
      )
      .run();
    writer.close();
    const reader = await openStore({ harnessDir: dir }, "read");
    try {
      expect(reader.epoch).toBe(1);
      expect(reader.schemaVersion).toBe(MIGRATIONS.length);
      expect(reader.db.prepare("select title from issues where id = 'I-000001'").get()).toEqual({ title: "partial outcome" });
      expect(reader.db.prepare("select authority_state from store_meta where id = 1").get()).toEqual({ authority_state: "active" });
    } finally {
      reader.close();
    }
    // Exactly as the refusal says: a rerun of the create-only entry refuses,
    // and the idempotent public upgrade succeeds against the published store.
    await expect(initializeStore({ harnessDir: dir })).rejects.toMatchObject({ code: "store.already-exists" });
    expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: MIGRATIONS.length });
  });
});

/* ------------------------------------------------------------------------ *
 * The published pathname's OWN durability. SQLite fsyncs the bytes it writes;
 * the create-only hard link that PUBLISHES them is an application-created
 * directory entry, so the containing directory must be synchronized before the
 * only other name for that inode is unlinked and before success is reported.
 * The simulated failure below is the REAL barrier (a directory-descriptor fsync
 * in this process's own `node:fs`), not a forwarding stub: SQLite's own syncs
 * travel through the native driver, so the store's committed bytes are
 * untouched and only the durability boundary under test fails.
 * ------------------------------------------------------------------------ */

describe("store-db publication makes the canonical directory entry durable", () => {
  const realFsyncSync = nodeFs.fsyncSync;

  /** Whether this descriptor currently names a directory - the barrier's target. */
  const namesDirectory = (fd: number): boolean => {
    try {
      return fstatSync(fd).isDirectory();
    } catch {
      return false;
    }
  };

  /** Fail every real directory barrier this process attempts, with an errno. */
  const failDirectoryBarriers = (): { restore: () => void } => {
    const spy = spyOn(nodeFs, "fsyncSync").mockImplementation(((fd: number) => {
      if (namesDirectory(fd)) throw Object.assign(new Error("simulated directory fsync failure"), { code: "EIO" });
      return realFsyncSync(fd);
    }) as never);
    return { restore: () => spy.mockRestore() };
  };

  const storeIsCompleteAndActive = async (dir: string, schemaVersion: number): Promise<void> => {
    const reader = await openStore({ harnessDir: dir }, "read");
    try {
      expect(reader.epoch).toBe(1);
      expect(reader.schemaVersion).toBe(schemaVersion);
      expect(reader.db.prepare("select authority_state from store_meta where id = 1").get()).toEqual({
        authority_state: "active",
      });
    } finally {
      reader.close();
    }
  };

  test("a failed creation barrier never reports success, retains both names, and the same upgrade retries it", async () => {
    const dir = mkdtempSync(join(ROOT, "barrier-create-"));
    const storePath = join(dir, "store.db");
    const instrument = failDirectoryBarriers();
    let refusal: unknown;
    try {
      refusal = await initializeStore({ harnessDir: dir }).then(
        () => null,
        (error) => error,
      );
    } finally {
      instrument.restore();
    }

    // Disclosed as the PARTIAL outcome it is: the store exists and is complete,
    // only the barrier failed - never a clean success, never corruption, and
    // never a claim that nothing was created.
    expect(refusal).toMatchObject({
      code: "store.publication-barrier-failed",
      details: { path: storePath, published: true, barrier: "creation" },
    });
    const message = refusal instanceof Error ? refusal.message : "";
    // The real operating-system cause travels with the refusal; the recovery
    // sentence is checked by its actionable flag, not by pinned wording.
    expect(message).toMatch(/EIO|simulated directory fsync failure/);
    expect(message).toContain("--harness");

    // The cleanup ORDER is tied to the durability outcome: because the barrier
    // did not make the canonical entry durable, the staging name (the only
    // other reference to the same inode) was NOT unlinked, and both names carry
    // exactly the committed bytes.
    const stagers = readdirSync(dir).filter((name) => name.startsWith(".store.db.init-") && name.endsWith(".tmp"));
    expect(stagers.length).toBe(1);
    expect(statSync(join(dir, stagers[0]!)).ino).toBe(statSync(storePath).ino);
    await storeIsCompleteAndActive(dir, MIGRATIONS.length);
    // A rerun of the create-only entry refuses; the published store is not
    // adopted, repaired or removed.
    await expect(initializeStore({ harnessDir: dir })).rejects.toMatchObject({ code: "store.already-exists" });

    // The advertised retry is the ordinary public upgrade on the SAME published
    // path: it really re-attempts the directory barrier, and the store keeps its
    // committed native data.
    let barrierSynced = false;
    const observer = spyOn(nodeFs, "fsyncSync").mockImplementation(((fd: number) => {
      if (namesDirectory(fd)) barrierSynced = true;
      return realFsyncSync(fd);
    }) as never);
    try {
      expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: MIGRATIONS.length });
    } finally {
      observer.mockRestore();
    }
    expect(barrierSynced).toBe(true);
    const writer = await openStore({ harnessDir: dir }, "write");
    writer.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000001', 'p', 'barrier survivor', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'barrier-survivor')",
      )
      .run();
    writer.close();
    const reader = await openStore({ harnessDir: dir }, "read");
    try {
      expect(reader.db.prepare("select title from issues where id = 'I-000001'").get()).toEqual({ title: "barrier survivor" });
    } finally {
      reader.close();
    }
  }, 60_000);

  test("a failed upgrade barrier names the phase, keeps every committed row, and the same upgrade recovers", async () => {
    const dir = mkdtempSync(join(ROOT, "barrier-upgrade-"));
    const handle = await initializeStore({ harnessDir: dir });
    handle.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000002', 'p', 'pre-barrier row', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'pre-barrier-row')",
      )
      .run();
    handle.close();

    const instrument = failDirectoryBarriers();
    let refusal: unknown;
    try {
      refusal = await upgradeStore({ harnessDir: dir }).then(
        () => null,
        (error) => error,
      );
    } finally {
      instrument.restore();
    }
    expect(refusal).toMatchObject({
      code: "store.publication-barrier-failed",
      details: { path: join(dir, "store.db"), published: true, barrier: "upgrade" },
    });
    const message = refusal instanceof Error ? refusal.message : "";
    expect(message).toMatch(/EIO|simulated directory fsync failure/);

    // The committed store is intact - the row written before the barrier is
    // still there, the schema is current, and the idempotent public upgrade
    // succeeds once the condition clears.
    const reader = await openStore({ harnessDir: dir }, "read");
    try {
      expect(reader.db.prepare("select title from issues where id = 'I-000002'").get()).toEqual({ title: "pre-barrier row" });
    } finally {
      reader.close();
    }
    expect(await upgradeStore({ harnessDir: dir })).toEqual({ schemaVersion: MIGRATIONS.length });
  }, 60_000);

  test("a public upgrade of a STAGED store stops before import, reports no activation, and completes once the barrier clears", async () => {
    // A REAL non-active store with work still pending: the migration apply
    // stages the legacy register rows, so issue/catalog authority is `staged`
    // and the public upgrade still has to import and activate. The barrier runs
    // in `upgradeStore`, BEFORE the wrapper's import, so this is exactly the
    // window the diagnostic must not overstate.
    const dir = mkdtempSync(join(ROOT, "barrier-staged-legacy-"));
    const harnessDir = join(dir, ".mstar");
    const projectsDir = join(harnessDir, "projects", "_default");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "residuals.json"),
      JSON.stringify({
        entries: {
          "plan-legacy": [
            {
              id: "R1",
              title: "Staged legacy residual",
              severity: "high",
              source: "qc1.md",
              scope: "plan-scope",
              decision: "defer",
              owner: "pm",
              target: "next-iteration",
              tracking: "issue",
              source_plan: "plan-legacy",
              registered_at: "2026-09-01",
            },
          ],
        },
      }),
    );
    const context = { harnessDir };
    await applyStoreMigration(context, await planStoreMigration(context));
    const authorityState = async (): Promise<string> => {
      const opened = await openStore(context, "read");
      try {
        const row = opened.db.prepare("select authority_state from store_meta where id = 1").get();
        return row !== null && typeof row === "object" && "authority_state" in row ? String(row.authority_state) : "";
      } finally {
        opened.close();
      }
    };
    expect(await authorityState()).toBe("staged");
    const sourceBytes = readFileSync(join(projectsDir, "residuals.json"));
    const before = await openStore(context, "read");
    let expectedIssues: unknown[];
    try {
      expectedIssues = before.db.prepare("select * from issues order by id").all();
      expect(expectedIssues).toContainEqual(expect.objectContaining({ title: "Staged legacy residual", severity: "high" }));
    } finally {
      before.close();
    }

    const instrument = failDirectoryBarriers();
    let refusal: unknown;
    try {
      refusal = await upgradeStoreMinimal({ context, operator: "fixture-operator", operationId: "staged-barrier-fail" }).then(
        () => null,
        (error) => error,
      );
    } finally {
      instrument.restore();
    }
    expect(refusal).toMatchObject({
      code: "store.publication-barrier-failed",
      details: { path: join(harnessDir, "store.db"), published: true, barrier: "upgrade" },
    });
    const message = refusal instanceof Error ? refusal.message : "";
    expect(message).toMatch(/EIO|simulated directory fsync failure/);
    expect(message).toContain("--harness");
    // F1's product evidence, not prose: this boundary performed no activation,
    // so the real authority stays staged and the staged rows are untouched.
    expect(await authorityState()).toBe("staged");
    const staged = await openStore(context, "read");
    try {
      expect(staged.db.prepare("select * from issues order by id").all()).toEqual(expectedIssues);
    } finally {
      staged.close();
    }
    // The staged legacy source bytes are preserved.
    expect(readFileSync(join(projectsDir, "residuals.json"))).toEqual(sourceBytes);

    // Once the barrier condition clears, the SAME public entry really finishes:
    // the authority activates and the staged rows stay exactly as they were.
    const result = await upgradeStoreMinimal({ context, operator: "fixture-operator", operationId: "staged-barrier-retry" });
    expect(result.authorityState).toBe("active");
    expect(await authorityState()).toBe("active");
    const activated = await openStore(context, "read");
    try {
      expect(activated.db.prepare("select * from issues order by id").all()).toEqual(expectedIssues);
    } finally {
      activated.close();
    }
    expect(readFileSync(join(projectsDir, "residuals.json"))).toEqual(sourceBytes);
  }, 60_000);
});

describe("uncheckable Node floor", () => {
  test("a manifest-less layout names the skipped comparison on stderr", () => {
    // The layout that declares no floor: the built module is copied alone with no
    // manifest anywhere above it. Run it in its own process so the real
    // resolution path decides, and so the runtime is the Node the store targets.
    const dir = mkdtempSync(join(tmpdir(), "mstar-floorless-"));
    try {
      const bundle = join(dir, "store-db.mjs");
      const built = spawnSync(
        process.execPath,
        ["build", join(import.meta.dir, "store-db.ts"), "--target", "node", "--outfile", bundle],
        { encoding: "utf8" },
      );
      expect(built.status).toBe(0);
      const probe = join(dir, "probe.mjs");
      writeFileSync(
        probe,
        `import { assertStoreRuntimeSupported } from ${JSON.stringify(bundle)};\n` +
          `assertStoreRuntimeSupported({ isBun: false, version: "0.0.0-synthetic" });\n` +
          `console.log("no refusal");\n`,
      );
      const ran = spawnSync(NODE_BIN, [probe], { encoding: "utf8" });
      expect(ran.status).toBe(0);
      expect(ran.stdout).toContain("no refusal");
      expect(ran.stderr).toContain("uncheckable");
      expect(ran.stderr).toContain("engines.node");
      expect(ran.stderr).toContain("Recovery:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Retired plan-PM claim settlement: ONE batch authorization reference every
 * tombstone copies literally, and one stop row per holder however many claims
 * that holder left behind.
 * ------------------------------------------------------------------------ */

/** The declared Node floor, read from this package's manifest at runtime. */
const settlementManifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
  engines?: { node?: string };
};
const settlementRuntime = `${Number.parseInt((settlementManifest.engines?.node ?? "").replace(/^>=\s*/, "").trim().split(".")[0]!, 10) + 1}.0.0`;
/** Injected consumer facts: the Bun test runtime is never an admissible consumer. */
const SETTLEMENT_FACTS = {
  entrypoint: "/opt/mstar/coordinator/dist/mstar-harness.js",
  runtimeVersion: settlementRuntime,
  isBun: false,
};

/**
 * A schema-8 store carrying held `execution_integration_leases` claims for
 * retired plan-PM holders - the exact input migration 9's settlement pass
 * consumes. Claims are written in the given order, so a batch reference that
 * follows it is distinguishable from the deterministic sorted one.
 */
function retiredClaimStore(
  name: string,
  claims: ReadonlyArray<{ workflowId: string; holder: string; claimedAt?: string }>,
): { context: StoreContext; workflowIds: string[] } {
  const dir = mkdtempSync(join(ROOT, `retired-claims-${name}-`));
  const db = new DatabaseSync(join(dir, "store.db"));
  try {
    db.exec("pragma foreign_keys=on");
    db.exec("begin");
    db.exec(SCHEMA_VERSION_TABLE_SQL);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 8)) {
      db.exec(migration.sql);
      db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)")
        .run(migration.version, migration.name, migrationChecksum(migration), "2026-10-04T00:00:00Z");
    }
    db.prepare("update store_meta set authority_state = 'active' where id = 1").run();
    db.prepare("update execution_meta set authority_state = 'active' where id = 1").run();
    const insertWorkflow = db.prepare(
      "insert into execution_workflows(workflow_id, revision, state_json, created_at, updated_at) values (?, 1, ?, '2026-10-04', '2026-10-04')",
    );
    const insertPlan = db.prepare(
      "insert into execution_plans(workflow_id, plan_id, revision, ordinal, state_json, coordination_json) values (?, ?, 1, 0, ?, '{}')",
    );
    const insertSession = db.prepare(
      "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) values (?, 'plan-pm', ?, ?, 1, 1, 'suspended', '2026-10-04T00:00:00Z')",
    );
    const insertClaim = db.prepare(
      "insert into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, 1, ?)",
    );
    for (const claim of claims) {
      const planId = `${claim.workflowId}-plan`;
      insertWorkflow.run(claim.workflowId, JSON.stringify({ schema_version: 1, id: claim.workflowId, type: "plan", status: "running", delivery_kind: "development" }));
      insertPlan.run(claim.workflowId, planId, JSON.stringify({ id: planId, title: "Retired claim plan", file: `${planId}.md`, status: "Todo" }));
      insertSession.run(claim.workflowId, claim.holder, planId);
      insertClaim.run(claim.workflowId, JSON.stringify({ holder: claim.holder, plan_id: planId, claimed_at: claim.claimedAt ?? "2026-10-04T00:30:00Z", status: "held" }));
    }
    db.exec("commit");
  } finally {
    db.close();
  }
  return { context: { harnessDir: dir }, workflowIds: claims.map((claim) => claim.workflowId) };
}

/** One settled claim's tombstone JSON, read through a fresh read-only handle. */
async function tombstoneOf(context: StoreContext, workflowId: string): Promise<Record<string, unknown>> {
  const store = await openStore(context, "read");
  try {
    const row = store.db.prepare("select lease_json from execution_integration_leases where workflow_id = ?").get(workflowId) as
      | { lease_json: string }
      | undefined;
    expect(row).toBeDefined();
    return JSON.parse(row!.lease_json) as Record<string, unknown>;
  } finally {
    store.close();
  }
}

describe("retired plan-PM claim settlement", () => {
  test("every tombstone copies the sorted batch authorizationRef and one holder's claims yield one stop row", async () => {
    const { context, workflowIds } = retiredClaimStore("two-holder", [
      // Deliberately unsorted claim order: holder-zeta is written first.
      { workflowId: "wf-settlement-zeta", holder: "holder-zeta" },
      { workflowId: "wf-settlement-two-a", holder: "holder-two" },
      { workflowId: "wf-settlement-two-b", holder: "holder-two" },
    ]);
    // The settlement names one stop row per HOLDER in sorted order: the two
    // claims holder-two left behind are ONE attested holder.
    const signal = await upgradeStore(context, { operator: "operator", raiseSettlementSignal: true }).catch((error: unknown) => error);
    expect(signal).toBeInstanceOf(SettlementAttestationNeeded);
    const marker = signal as SettlementAttestationNeeded;
    expect(marker.holders).toEqual(["holder-two", "holder-zeta"]);
    expect(marker.stopped.map((session) => session.sessionId)).toEqual(["holder-two", "holder-zeta"]);
    // The generated document is built from that signal, so every tombstone
    // copies its ONE batch reference literally while keeping its own holder.
    await upgradeStoreMinimal({ context, operator: "operator", operationId: "op-two-holder-settlement", processFacts: SETTLEMENT_FACTS });
    const batch = "retired-plan-pm-seat:holder-two,holder-zeta";
    const claims = [];
    for (const workflowId of workflowIds) claims.push(await tombstoneOf(context, workflowId));
    expect(claims.map((claim) => claim.release_reason)).toEqual([batch, batch, batch]);
    expect(claims.map((claim) => claim.prior_holder)).toEqual(["holder-zeta", "holder-two", "holder-two"]);
    expect(claims.every((claim) => claim.status === "released" && claim.released_by === "store-upgrade")).toBe(true);
  });

  test("a caller-supplied now is the ONE settlement instant and it is what covers the claim", async () => {
    // The claim sits in the FUTURE of the ambient clock but before the caller's
    // clock, so only the supplied instant can cover it: the settlement window
    // is the transaction's own, never ambient time.
    const settledAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const claimedAt = new Date(Date.parse(settledAt) - 60 * 60 * 1000).toISOString();
    const { context, workflowIds } = retiredClaimStore("clock", [
      { workflowId: "wf-settlement-clock", holder: "holder-clock", claimedAt },
    ]);
    // Ambient time cannot cover the claim the upgrade generated its own
    // document for: the named cause and recovery are unchanged.
    await expect(
      upgradeStoreMinimal({ context, operator: "operator", operationId: "op-clock-ambient", processFacts: SETTLEMENT_FACTS }),
    ).rejects.toMatchObject({ code: "store.upgrade-attestation-missing" });
    // With one supplied clock the generated document attests that instant and
    // the tombstone it settles records the same one.
    await upgradeStoreMinimal({
      context, operator: "operator", operationId: "op-clock-supplied", now: () => settledAt, processFacts: SETTLEMENT_FACTS,
    });
    const claim = await tombstoneOf(context, workflowIds[0]!);
    expect(claim.released_at).toBe(settledAt);
    expect(claim.release_reason).toBe("retired-plan-pm-seat:holder-clock");
  });
});

describe("migration 16 - the open cycle survives the upgrade", () => {
  test("a pending row's planned target moves out of the copied column", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");
    db.exec(MIGRATION_15_SQL);
    // Before the split, an open cycle recorded its TARGET in the copied column
    // because there was only one.
    db.exec(
      "insert into issue_sync_state(binding_id, direction, local_id, external_id, item_state, last_remote_updated_at, last_error, last_skip_reason, revision, updated_at)" +
        " values ('b', 'import', 'I-1', 'EXT-1', 'pending', '2026-11-01T00:00:00Z', null, null, 1, '2026-11-01T00:00:00Z')",
    );
    db.exec(MIGRATION_16_SQL);
    const row = db.query("select item_state, last_remote_updated_at, pending_target from issue_sync_state").get() as {
      item_state: string;
      last_remote_updated_at: string | null;
      pending_target: string | null;
    };
    // Leaving it would make the row claim content it never copied, and the stale
    // guard would skip every page older than a revision nothing holds.
    expect(row).toEqual({
      item_state: "pending",
      last_remote_updated_at: null,
      pending_target: "2026-11-01T00:00:00Z",
    });
    db.close();
  });

  test("a settled row keeps its copied watermark and gains no target", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");
    db.exec(MIGRATION_15_SQL);
    db.exec(
      "insert into issue_sync_state(binding_id, direction, local_id, external_id, item_state, last_remote_updated_at, last_error, last_skip_reason, revision, updated_at)" +
        " values ('b', 'import', 'I-1', 'EXT-1', 'applied', '2026-11-01T00:00:00Z', null, null, 1, '2026-11-01T00:00:00Z')",
    );
    db.exec(MIGRATION_16_SQL);
    const row = db.query("select last_remote_updated_at, pending_target from issue_sync_state").get() as {
      last_remote_updated_at: string | null;
      pending_target: string | null;
    };
    expect(row).toEqual({ last_remote_updated_at: "2026-11-01T00:00:00Z", pending_target: null });
    db.close();
  });
});
