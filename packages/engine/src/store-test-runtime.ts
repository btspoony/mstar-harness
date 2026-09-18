/**
 * store-test-runtime.ts — TEST-ONLY runtime-process/bundle helper for the
 * issue-store boundary (plan 20260918-issue-store-core C1 proof).
 *
 * This module is bundled once per test run with `bun build --target node`
 * into a temporary directory and then executed as a child process under the
 * ACTUAL Node >=24.18.0 and Bun >=1.4.0 binaries. Each invocation runs one
 * scenario against the real `store-db.ts` implementation and the real
 * `node:sqlite` driver in a temporary directory — no mock database exists
 * anywhere in the C1 proof. It is never imported by production code and is
 * cleaned up with its bundle and temporary databases after the test run.
 *
 * Usage: node|bun <bundle> <scenario> <root-dir>
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StoreError as StoreErrorClass } from "./store-db.js";

const {
  initializeStore,
  openStore,
  upgradeStore,
  assertStoreRuntimeSupported,
  detectStoreRuntime,
  StoreError,
  MIGRATIONS,
} = await import("./store-db.js");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Every `*.db`, `*.db-wal`, `*.db-shm` file currently under `dir`. */
function dbFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...dbFilesUnder(full));
    else if (/\.db(-wal|-shm)?$/.test(entry)) found.push(full);
  }
  return found;
}

function expectStoreError(code: string, run: () => unknown): StoreErrorClass {
  try {
    run();
  } catch (error) {
    if (error instanceof StoreError && error.code === code) return error as StoreErrorClass;
    throw new Error(`expected StoreError ${code}, got ${String(error)}`);
  }
  throw new Error(`expected StoreError ${code}, but the call succeeded`);
}

async function expectStoreErrorAsync(code: string, run: () => Promise<unknown>): Promise<StoreErrorClass> {
  try {
    await run();
  } catch (error) {
    if (error instanceof StoreError && error.code === code) return error as StoreErrorClass;
    throw new Error(`expected StoreError ${code}, got ${String(error)}`);
  }
  throw new Error(`expected StoreError ${code}, but the call succeeded`);
}

const scenarios: Record<string, (rootDir: string) => Promise<string>> = {
  /** Importing the module acquires no SQLite driver and creates no file. */
  async "import-lazy"(rootDir) {
    const mod = await import("./store-db.js");
    for (const name of ["openStore", "initializeStore", "upgradeStore", "StoreError", "MIGRATIONS"] as const) {
      if (!(name in mod)) throw new Error(`store-db is missing export ${name}`);
    }
    const nodeLoads = (process as { moduleLoadList?: string[] }).moduleLoadList;
    if (nodeLoads && nodeLoads.includes("node:sqlite")) {
      throw new Error("node:sqlite was loaded at module import — lazy acquisition is broken");
    }
    if (dbFilesUnder(rootDir).length > 0) throw new Error("import created a database file");
    return "module imported without acquiring SQLite";
  },

  /** Below-floor and missing-capability runtimes are refused actionably and write nothing. */
  async "below-floor-refusal"(rootDir) {
    const belowNode = expectStoreError("store.runtime-unsupported", () =>
      assertStoreRuntimeSupported({ isBun: false, version: "24.17.0" }),
    );
    if (!/Node >=24\.18\.0/.test(belowNode.message)) throw new Error(`not actionable: ${belowNode.message}`);
    const belowBun = expectStoreError("store.runtime-unsupported", () =>
      assertStoreRuntimeSupported({ isBun: true, version: "1.3.14" }),
    );
    if (!/Bun >=1\.4\.0/.test(belowBun.message)) throw new Error(`not actionable: ${belowBun.message}`);
    expectStoreError("store.runtime-unsupported", () =>
      assertStoreRuntimeSupported({ isBun: false, version: "24.18.0", hasSqlite: false }),
    );
    if (dbFilesUnder(rootDir).length > 0) throw new Error("a refused store access wrote a file");
    // Public-path spoof where the runtime permits it: a real below-floor
    // process must refuse before any file access. Bun keeps process.versions
    // readonly, so the spoof is best-effort — the injected checks above prove
    // the same exported logic either way.
    const versions = process.versions as Record<string, string | undefined>;
    const originalNode = versions.node;
    let spoofed = false;
    try {
      Object.defineProperty(versions, "node", { value: "22.5.0", configurable: true });
      spoofed = detectStoreRuntime().version === "22.5.0";
    } catch {
      spoofed = false;
    }
    if (spoofed) {
      try {
        await expectStoreErrorAsync("store.runtime-unsupported", () => openStore({ harnessDir: rootDir }, "read"));
        if (dbFilesUnder(rootDir).length > 0) throw new Error("spoofed below-floor open wrote a file");
      } finally {
        Object.defineProperty(versions, "node", { value: originalNode, configurable: true });
      }
    }
    return "below-floor and missing-capability refused without writes";
  },

  /** A missing store read refuses and creates nothing. */
  async "missing-read"(rootDir) {
    await expectStoreErrorAsync("store.not-initialized", () => openStore({ harnessDir: rootDir }, "read"));
    await expectStoreErrorAsync("store.not-initialized", () => openStore({ harnessDir: rootDir }, "write"));
    if (dbFilesUnder(rootDir).length > 0) throw new Error("a refused read created the database");
    return "missing store read created nothing";
  },

  /** The full migration list + shared metadata initialize; reads are query-only; upgrade is idempotent. */
  async "initialize-schema"(rootDir) {
    const created = await initializeStore({ harnessDir: rootDir });
    if (created.epoch !== 1) throw new Error(`expected epoch 1, got ${created.epoch}`);
    if (created.schemaVersion !== MIGRATIONS.length) {
      throw new Error(`expected schemaVersion ${MIGRATIONS.length}, got ${created.schemaVersion}`);
    }
    if (!UUID_RE.test(created.storeId)) throw new Error(`store_id is not a UUID: ${created.storeId}`);
    created.close();

    const reader = await openStore({ harnessDir: rootDir }, "read");
    try {
      reader.db.exec("create table must_not_happen(x)");
      throw new Error("read-only connection allowed a write");
    } catch (error) {
      if (!/readonly|read-only/i.test(String((error as Error).message))) throw error;
    }
    if (reader.epoch !== 1 || reader.schemaVersion !== MIGRATIONS.length) throw new Error("reader metadata mismatch");
    reader.close();

    const writer = await openStore({ harnessDir: rootDir }, "write");
    const meta = writer.db.prepare("select authority_state from store_meta where id = 1").get() as {
      authority_state: string;
    };
    if (meta.authority_state !== "active") throw new Error(`init must produce an active empty store, got ${meta.authority_state}`);
    writer.close();

    const upgraded = await upgradeStore({ harnessDir: rootDir });
    if (upgraded.schemaVersion !== MIGRATIONS.length) {
      throw new Error(`idempotent upgrade changed the version: ${upgraded.schemaVersion}`);
    }
    return `init created active empty store (epoch 1, schema ${MIGRATIONS.length}); reads are query-only`;
  },

  /** `initializeStore` is create-only: an existing store refuses and keeps its bytes. */
  async "double-init"(rootDir) {
    const first = await initializeStore({ harnessDir: rootDir });
    first.close();
    const dbPath = join(rootDir, "store.db");
    const before = readFileSync(dbPath);
    await expectStoreErrorAsync("store.already-exists", () => initializeStore({ harnessDir: rootDir }));
    const after = readFileSync(dbPath);
    if (!before.equals(after)) throw new Error("a refused re-init modified the store bytes");
    return "double init refused without touching the store";
  },

  /** Checksum drift refuses (rollback preserved) and never silently migrates. */
  async "checksum-drift"(rootDir) {
    const created = await initializeStore({ harnessDir: rootDir });
    created.db.prepare("update schema_version set checksum = ? where version = 1").run("0".repeat(64));
    created.close();
    await expectStoreErrorAsync("store.schema-drift", () => openStore({ harnessDir: rootDir }, "write"));
    await expectStoreErrorAsync("store.schema-drift", () => openStore({ harnessDir: rootDir }, "read"));
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(rootDir, "store.db"), { readOnly: true });
    const rows = raw.prepare("select version, checksum from schema_version order by version").all() as Array<{
      version: number;
      checksum: string;
    }>;
    raw.close();
    if (rows.length !== MIGRATIONS.length || rows[0].version !== 1 || rows[0].checksum !== "0".repeat(64)) {
      throw new Error("the drift refusal rewrote schema rows");
    }
    return "checksum drift refused with the applied row preserved";
  },

  /** An unknown/newer schema version refuses instead of migrating down. */
  async "newer-schema"(rootDir) {
    const created = await initializeStore({ harnessDir: rootDir });
    created.db
      .prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)")
      .run(MIGRATIONS.length + 1, "future", "f".repeat(64), "2026-09-18T00:00:00.000Z");
    created.close();
    await expectStoreErrorAsync("store.schema-unsupported", () => openStore({ harnessDir: rootDir }, "write"));
    await expectStoreErrorAsync("store.schema-unsupported", () => upgradeStore({ harnessDir: rootDir }));
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(rootDir, "store.db"), { readOnly: true });
    const rows = raw.prepare("select version from schema_version order by version").all() as Array<{ version: number }>;
    raw.close();
    if (rows.length !== MIGRATIONS.length + 1 || rows[MIGRATIONS.length].version !== MIGRATIONS.length + 1) {
      throw new Error("the newer-schema refusal rewrote schema rows");
    }
    return "newer schema refused without mutation";
  },

  /** FK enforcement holds: orphan child rows are refused. */
  async "fk-enforcement"(rootDir) {
    const handle = await initializeStore({ harnessDir: rootDir });
    handle.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000001', 'p', 't', 'bug', 'high', 'i', 'a', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z', 'k1')",
      )
      .run();
    try {
      handle.db
        .prepare(
          "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key," +
            " acceptance_key, location, observed_behavior, evidence_json, recorded_at) values" +
            " ('I-999999', 'ok1', 'test', 's', 'rc', 'ac', 'loc', 'ob', '[]', '2026-09-18T00:00:00.000Z')",
        )
        .run();
      throw new Error("an orphan occurrence insert was accepted — FK enforcement is broken");
    } catch (error) {
      if (error instanceof StoreError) throw error;
      if (!/FOREIGN KEY/i.test(String((error as Error).message))) throw error;
    }
    handle.db
      .prepare(
        "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key," +
          " acceptance_key, location, observed_behavior, evidence_json, recorded_at) values" +
          " (?, 'ok2', 'test', 's', 'rc', 'ac', 'loc', 'ob', '[]', '2026-09-18T00:00:00.000Z')",
      )
      .run("I-000001");
    handle.close();
    return "foreign keys enforced (orphan refused, real parent accepted)";
  },

  /**
   * A second writer gets a bounded busy refusal — never a lost accepted
   * write. The first writer's committed increment and the second writer's
   * post-refusal increment both survive.
   */
  async "second-writer-busy"(rootDir) {
    process.env.MSTAR_STORE_BUSY_TIMEOUT_MS = "200";
    const first = await initializeStore({ harnessDir: rootDir });
    first.db.exec("begin immediate");
    first.db.exec("update store_meta set revision = revision + 1 where id = 1");

    const second = await openStore({ harnessDir: rootDir }, "write");
    await expectStoreErrorAsync("store.busy", async () => {
      second.db.exec("begin immediate");
    });
    // The refusal must have left the second writer with NO open transaction:
    // a rollback now errors instead of discarding anything.
    let rollbackProof = "";
    try {
      second.db.exec("rollback");
      rollbackProof = "rollback succeeded on a writer that never entered a transaction";
    } catch {
      rollbackProof = "no transaction";
    }
    if (rollbackProof !== "no transaction") throw new Error(rollbackProof);

    first.db.exec("commit");
    first.close();

    second.db.exec("begin immediate");
    second.db.exec("update store_meta set revision = revision + 1 where id = 1");
    second.db.exec("commit");
    second.close();

    const check = await openStore({ harnessDir: rootDir }, "read");
    const meta = check.db.prepare("select revision from store_meta where id = 1").get() as { revision: number };
    check.close();
    if (meta.revision !== 2) throw new Error(`expected both accepted writes committed (revision 2), got ${meta.revision}`);
    return "second writer received a bounded busy refusal with no lost accepted write";
  },
};

/** Run one scenario against a temporary root directory. */
export async function runScenario(name: string, rootDir: string): Promise<string> {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`unknown scenario ${name}; known: ${Object.keys(scenarios).join(", ")}`);
  return scenario(rootDir);
}

const argv = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}` || (argv.length === 2 && process.env.MSTAR_STORE_TEST_RUNNER === "1")) {
  if (argv.length !== 2) {
    console.error("usage: store-test-runtime <scenario> <root-dir>");
    process.exit(2);
  }
  try {
    console.log(`OK ${argv[0]}: ${await runScenario(argv[0], argv[1])}`);
  } catch (error) {
    console.error(`FAIL ${argv[0]}: ${(error as Error).stack ?? error}`);
    process.exit(1);
  }
}
