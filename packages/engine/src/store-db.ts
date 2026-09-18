/**
 * store-db.ts — issue-store runtime boundary, connection lifecycle and the
 * checksum-verified migration framework (plan 20260918-issue-store-core C1).
 *
 * Authority: issue-store-contract.md §2 (connection/path/upgrades) and §8
 * (accepted runtime decision). User-selected runtime: direct in-process
 * `node:sqlite` under Bun >=1.4.0 or Node >=24.18.0 — no child transport,
 * daemon, `bun:sqlite`, driver dependency or older-runtime fallback.
 *
 * SQLite is NEVER acquired at module import: `node:sqlite` is loaded lazily
 * inside the connection functions only, so importing this module (or the
 * engine index, or running `mstar --help`) neither loads the driver nor
 * touches the filesystem.
 *
 * Issue-domain verbs (capture/disposition/relations) are NOT implemented
 * here — they arrive with later tasks on top of this boundary.
 */
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveProcessHarnessDir } from "./coordination.js";

/** Minimum Bun runtime floor (contract §8). */
export const MIN_BUN_VERSION = "1.4.0";
/** Minimum Node runtime floor (contract §8). */
export const MIN_NODE_VERSION = "24.18.0";
/** Default bounded wait for a competing writer before a visible refusal. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Stable refusal codes (contract §5). `store.already-exists` is the
 * create-only initializer's refusal for an existing store — never reuse
 * `store.not-initialized` for a store that is already on disk. */
export type StoreErrorCode =
  | "store.runtime-unsupported"
  | "store.not-initialized"
  | "store.already-exists"
  | "store.schema-unsupported"
  | "store.schema-drift"
  | "store.corrupt"
  | "store.busy";

/** Typed refusal with an actionable, stable code. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "StoreError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Runtime boundary — detect Bun before its emulated Node version (§8)
// ---------------------------------------------------------------------------

export type StoreRuntimeInfo = {
  isBun: boolean;
  version: string;
  /** Optional capability override for tests; real detection happens at the
   * lazy driver load (a missing DatabaseSync refuses there). */
  hasSqlite?: boolean;
};

/** Read the actual runtime, preferring the Bun global over `process.versions.node` */
export function detectStoreRuntime(): StoreRuntimeInfo {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  if (bun) return { isBun: true, version: bun.version };
  return { isBun: false, version: process.versions.node ?? "0.0.0" };
}

/** Numeric dotted-version compare: negative when `a < b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Refuse below-floor or missing-capability runtimes with actionable guidance.
 * Store access calls this before any file is touched, so a refusal writes
 * nothing.
 */
export function assertStoreRuntimeSupported(info: StoreRuntimeInfo = detectStoreRuntime()): void {
  const kind = info.isBun ? "Bun" : "Node";
  const floor = info.isBun ? MIN_BUN_VERSION : MIN_NODE_VERSION;
  if (info.hasSqlite === false) {
    throw new StoreError(
      "store.runtime-unsupported",
      `The native "node:sqlite" module is not available in this ${kind} ${info.version} runtime. ` +
        `The issue store requires ${kind} >=${floor} with native node:sqlite; upgrade the runtime ` +
        `(https://bun.sh or https://nodejs.org). No fallback runtime or driver is supported.`,
    );
  }
  if (compareVersions(info.version, floor) < 0) {
    throw new StoreError(
      "store.runtime-unsupported",
      `${kind} ${info.version} is below the issue-store floor. The store requires the native ` +
        `"node:sqlite" module on Bun >=${MIN_BUN_VERSION} or Node >=${MIN_NODE_VERSION}; found ${kind} ` +
        `${info.version}. Upgrade the runtime for this entrypoint (https://bun.sh or https://nodejs.org). ` +
        `No older-runtime fallback exists and Node 18 compatibility is not a supported contract.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Lazy driver acquisition — node:sqlite only, in-process, no transport
// ---------------------------------------------------------------------------

/** Minimal structural view of the synchronous driver used by the store. */
export interface StoreDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

type SqliteModule = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => StoreDb;
};

/** Load the real driver lazily; a missing capability refuses actionably. */
async function loadSqliteDriver(): Promise<SqliteModule> {
  try {
    const mod = (await import("node:sqlite")) as Partial<SqliteModule>;
    if (typeof mod.DatabaseSync !== "function") throw new Error("DatabaseSync is missing");
    return mod as SqliteModule;
  } catch (error) {
    assertStoreRuntimeSupported({ ...detectStoreRuntime(), hasSqlite: false });
    throw new StoreError(
      "store.runtime-unsupported",
      `Failed to load the native "node:sqlite" module: ${(error as Error).message}`,
    );
  }
}

/** `{resolved process/control harness root}/store.db` via
 * `resolveProcessHarnessDir` (contract §2): linked feature worktrees and
 * `.mstarc` resolvers cannot select a cwd-local database. An isolated
 * non-git directory (test harness root) falls back to the supplied path. */
export function storeDbPath(context: { harnessDir: string }): string {
  if (!context?.harnessDir) throw new StoreError("store.corrupt", "StoreContext.harnessDir is required");
  const start = resolve(context.harnessDir);
  const resolved = resolveProcessHarnessDir(start);
  return join(resolved ?? start, "store.db");
}

/** Bounded wait is fixed at 5000ms in production (contract §2). The
 * `MSTAR_STORE_BUSY_TIMEOUT_MS` override is test-runner-gated: it is
 * honored only when `MSTAR_STORE_TEST_RUNNER` is set, so a shipped
 * CLI/plugin process cannot change the timeout or the refusal text. */
function busyTimeoutMs(): number {
  if (process.env.MSTAR_STORE_TEST_RUNNER === "1") {
    const raw = process.env.MSTAR_STORE_BUSY_TIMEOUT_MS;
    const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_BUSY_TIMEOUT_MS;
}

function refuseOpenFailure(error: unknown, dbPath: string): never {
  if (error instanceof StoreError) throw error;
  if (isBusyError(error)) {
    throw new StoreError(
      "store.busy",
      `Another writer held the store past the bounded wait (${busyTimeoutMs()}ms). ` +
        `Retry when the competing writer is done; no write was accepted.`,
    );
  }
  throw new StoreError(
    "store.corrupt",
    `The store at ${dbPath} is unreadable or not a SQLite database: ${(error as Error).message}`,
  );
}

/** Map a bounded-wait BUSY failure to the stable visible refusal. */
function isBusyError(error: unknown): boolean {
  const err = error as { code?: string; errcode?: string | number; message?: string };
  return (
    err?.errcode === 5 ||
    err?.errcode === "SQLITE_BUSY" ||
    err?.code === "SQLITE_BUSY" ||
    /database is locked|SQLITE_BUSY/.test(String(err?.message ?? ""))
  );
}

/**
 * Wrap the driver handle so a bounded-wait BUSY failure on any write surfaces
 * as the stable `store.busy` refusal instead of a raw driver error (contract
 * §2: BUSY is a visible refusal, never a lost accepted write). Reads pass
 * through untouched.
 */
function busyAware(db: StoreDb, path: string): StoreDb {
  const refuseBusy = (error: unknown): never => {
    if (isBusyError(error)) {
      throw new StoreError(
        "store.busy",
        `Another writer held ${path} past the bounded wait (${busyTimeoutMs()}ms). ` +
          `The statement was refused — roll back the current transaction and retry when the ` +
          `competing writer is done; no write was accepted.`,
      );
    }
    throw error;
  };
  return {
    exec: (sql: string) => {
      try {
        db.exec(sql);
      } catch (error) {
        refuseBusy(error);
      }
    },
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return {
        run: (...params: unknown[]) => {
          try {
            return statement.run(...params);
          } catch (error) {
            refuseBusy(error);
          }
        },
        get: statement.get.bind(statement),
        all: statement.all.bind(statement),
      };
    },
    close: () => db.close(),
  };
}

/**
 * Open a connection with the contract §2 pragma order: busy_timeout first,
 * then WAL (verified), then synchronous=FULL on writers, query_only=ON on
 * readers, and foreign_keys=ON (verified) on both.
 */
async function connect(dbPath: string, mode: "read" | "write"): Promise<StoreDb> {
  const { DatabaseSync } = await loadSqliteDriver();
  // node:sqlite rejects an explicit `undefined` options argument — open
  // writers without a second argument, readers with the read-only option.
  let db: StoreDb;
  try {
    db = mode === "read" ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
  } catch (error) {
    refuseOpenFailure(error, dbPath);
  }
  const fail = (message: string): never => {
    db.close();
    throw new StoreError("store.corrupt", `${message} (opening ${dbPath})`);
  };
  try {
    db.exec(`pragma busy_timeout=${busyTimeoutMs()}`);
    if (mode === "read") {
      db.exec("pragma query_only=ON");
      if ((db.prepare("pragma query_only").get() as { query_only?: number } | undefined)?.query_only !== 1) {
        fail("query_only pragma did not hold");
      }
    } else {
      const wal = db.prepare("pragma journal_mode=wal").get() as { journal_mode?: string } | undefined;
      if (wal?.journal_mode !== "wal") fail("WAL journal mode was not applied");
      db.exec("pragma synchronous=FULL");
      if ((db.prepare("pragma synchronous").get() as { synchronous?: number } | undefined)?.synchronous !== 2) {
        fail("synchronous=FULL was not applied");
      }
    }
    db.exec("pragma foreign_keys=ON");
    if ((db.prepare("pragma foreign_keys").get() as { foreign_keys?: number } | undefined)?.foreign_keys !== 1) {
      fail("foreign_keys enforcement was not applied");
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // already closed by fail()
    }
    refuseOpenFailure(error, dbPath);
  }
  return busyAware(db, dbPath);
}

// ---------------------------------------------------------------------------
// Schema framework — ordered, checksum-verified, immutable migrations
// ---------------------------------------------------------------------------

/** Base table recording applied migrations (contract §2). */
export const SCHEMA_VERSION_TABLE_SQL =
  "create table schema_version(" +
  "version integer primary key," +
  "name text not null unique," +
  "checksum text not null," +
  "applied_at text not null)";

/**
 * Migration 1 — shared metadata and issue tables (contract §2). Catalog
 * tables arrive with migration 2 in a later task; `issues.project_id`
 * intentionally carries no foreign key until that table exists.
 */
export const MIGRATION_1_SQL = `
create table store_meta(
  id integer primary key check (id = 1),
  store_id text not null,
  authority_state text not null check (authority_state in ('staged','active')),
  authority_epoch integer not null,
  revision integer not null,
  catalog_revision integer not null default 0,
  created_at text not null,
  activated_at text
);
create table issue_counter(
  id integer primary key check (id = 1),
  next_value integer not null check (next_value > 0)
);
create table issues(
  id text primary key,
  project_id text not null,
  title text not null,
  kind text not null check (kind in ('bug','risk','improvement','request','decision','review-obligation')),
  severity text not null check (severity in ('critical','high','medium','low','info')),
  disposition text not null default 'open' check (disposition in ('open','resolved','waived','duplicate','superseded')),
  impact text not null,
  acceptance text not null,
  owner text,
  registered_at text,
  closed_at text,
  closure_note text,
  created_at text not null,
  updated_at text not null,
  revision integer not null default 1,
  provider text not null default 'local',
  external_id text,
  url text,
  identity_key text not null unique
);
create unique index issues_external_identity on issues(provider, external_id) where external_id is not null;
create index issues_disposition on issues(project_id, disposition, severity);
create table occurrences(
  id integer primary key,
  issue_id text not null references issues(id),
  occurrence_key text not null unique,
  source_kind text not null,
  source_identity text not null,
  root_cause_key text not null,
  acceptance_key text not null,
  location text not null,
  observed_behavior text not null,
  evidence_json text not null,
  discovered_at text,
  recorded_at text not null,
  imported integer not null default 0 check (imported in (0, 1))
);
create index occurrences_issue_activity on occurrences(issue_id, discovered_at, id);
create table relations(
  from_issue text not null references issues(id),
  relation text not null check (relation in ('related','blocks','duplicate-of','superseded-by')),
  to_issue text not null references issues(id),
  primary key (from_issue, relation, to_issue),
  check (from_issue != to_issue),
  check (relation != 'related' or from_issue < to_issue)
);
create table provenance(
  id integer primary key,
  issue_id text not null references issues(id),
  kind text not null,
  target text not null,
  source_hash text not null,
  legacy_project text,
  legacy_bucket text,
  legacy_entry_id text,
  legacy_json text,
  imported_at text
);
create index provenance_lookup on provenance(kind, target, issue_id);
create table issue_transitions(
  id integer primary key,
  issue_id text not null references issues(id),
  from_disposition text not null,
  to_disposition text not null,
  actor text,
  occurred_at text,
  recorded_at text not null,
  reason text not null,
  evidence_json text not null,
  imported integer not null default 0 check (imported in (0, 1)),
  issue_revision integer not null
);
create table store_operations(
  operation_id text primary key,
  request_hash text not null,
  result_json text not null,
  committed_at text not null
);
create table migration_receipts(
  id integer primary key,
  manifest_hash text not null unique,
  phase text not null check (phase in ('applied','activated','retired')),
  manifest_json text not null,
  mapping_json text not null,
  source_counts_json text not null,
  applied_at text not null,
  activated_at text,
  retired_at text
);
insert into store_meta(id, store_id, authority_state, authority_epoch, revision, catalog_revision, created_at)
values (
  1,
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
  'staged',
  1,
  0,
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
insert into issue_counter(id, next_value) values (1, 1);
`;

export type Migration = { version: number; name: string; sql: string };

/** Ordered immutable migrations. Never mutate an applied entry — append only. */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "issue-core", sql: MIGRATION_1_SQL }];

/** SHA-256 of the compiled migration SQL — what every applied row must match. */
export function migrationChecksum(migration: Migration): string {
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
}

function nowRfc3339(): string {
  return new Date().toISOString();
}

type AppliedMigration = { version: number; name: string; checksum: string };

/** Read applied migration rows. A missing table is only tolerable while
 * creating a fresh store; readers of an existing database treat it as
 * corruption. */
function readAppliedMigrations(db: StoreDb, tolerateMissingTable: boolean): AppliedMigration[] {
  const present = db
    .prepare("select count(*) as n from sqlite_master where type='table' and name='schema_version'")
    .get() as { n?: number } | undefined;
  if (!present?.n) {
    if (tolerateMissingTable) return [];
    throw new StoreError("store.corrupt", "The store database has no schema_version table");
  }
  let rows: unknown;
  try {
    rows = db.prepare("select version, name, checksum from schema_version order by version").all();
  } catch (error) {
    throw new StoreError("store.corrupt", `schema_version is unreadable: ${(error as Error).message}`);
  }
  return (rows as Array<{ version: unknown; name: unknown; checksum: unknown }>).map((row) => {
    if (
      typeof row.version !== "number" ||
      !Number.isInteger(row.version) ||
      typeof row.name !== "string" ||
      typeof row.checksum !== "string"
    ) {
      throw new StoreError("store.corrupt", "schema_version contains a malformed row");
    }
    return { version: row.version, name: row.name, checksum: row.checksum };
  });
}

/**
 * Verify the applied set against the compiled migrations: contiguous from 1,
 * every checksum matching, nothing unknown or newer. Refuses before any
 * mutation (contract §2: unknown/newer → schema-unsupported, gap/checksum
 * drift → schema-drift, malformed → corrupt).
 */
function validateAppliedMigrations(applied: AppliedMigration[]): number {
  if (applied.length === 0) {
    throw new StoreError("store.corrupt", "The store database exists but no migrations are recorded");
  }
  let max = 0;
  for (let i = 0; i < applied.length; i++) {
    const row = applied[i];
    const compiled = MIGRATIONS.find((m) => m.version === row.version);
    if (!compiled) {
      throw new StoreError(
        "store.schema-unsupported",
        `The store was written by schema version ${row.version}, which this build does not know. ` +
          `Known versions: 1..${MIGRATIONS.length}. Upgrade the harness to read this store; nothing was modified.`,
      );
    }
    if (row.version !== i + 1) {
      throw new StoreError(
        "store.schema-drift",
        `Applied schema versions are not contiguous from 1 (found version ${row.version} at position ${i + 1}). ` +
          `The store is refused rather than migrated; nothing was modified.`,
      );
    }
    if (row.name !== compiled.name || row.checksum !== migrationChecksum(compiled)) {
      throw new StoreError(
        "store.schema-drift",
        `Checksum drift for migration ${row.version}: the applied row does not match the compiled migration. ` +
          `The store is refused rather than silently migrated; nothing was modified.`,
      );
    }
    max = row.version;
  }
  return max;
}

/**
 * Apply pending migrations inside ONE exclusive write transaction, record
 * each version row only as it applies, verify the final set, and roll the
 * whole batch back on any failure — no dirty partial schema (contract §2).
 */
function applyPendingMigrations(db: StoreDb, options: { alreadyInTransaction?: boolean } = {}): number {
  const own = !options.alreadyInTransaction;
  const prior = readAppliedMigrations(db, true);
  const priorMax = prior.length === 0 ? 0 : validateAppliedMigrations(prior);
  const pending = MIGRATIONS.filter((m) => m.version > priorMax);
  if (own) db.exec("begin immediate");
  try {
    if (prior.length === 0) db.exec(SCHEMA_VERSION_TABLE_SQL);
    for (const migration of pending) {
      db.exec(migration.sql);
      db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
        migration.version,
        migration.name,
        migrationChecksum(migration),
        nowRfc3339(),
      );
    }
    const finalMax = validateAppliedMigrations(readAppliedMigrations(db, false));
    if (own) db.exec("commit");
    return finalMax;
  } catch (error) {
    if (own) {
      try {
        db.exec("rollback");
      } catch {
        // connection-level failure during rollback — nothing was committed
      }
    }
    if (error instanceof StoreError) throw error;
    if (isBusyError(error)) {
      throw new StoreError(
        "store.busy",
        `Another writer held the store past the bounded wait (${busyTimeoutMs()}ms); the migration batch ` +
          `was rolled back and nothing was committed. Retry when the competing writer is done.`,
      );
    }
    throw new StoreError("store.corrupt", `Migration application failed and rolled back: ${(error as Error).message}`);
  }
}

type StoreMeta = {
  storeId: string;
  authorityState: "staged" | "active";
  epoch: number;
  revision: number;
  catalogRevision: number;
};

/** Read the shared metadata singleton. DB identity is checked on every open. */
function readStoreMeta(db: StoreDb): StoreMeta {
  const row = db
    .prepare(
      "select store_id, authority_state, authority_epoch, revision, catalog_revision from store_meta where id = 1",
    )
    .get() as
    | {
        store_id?: unknown;
        authority_state?: unknown;
        authority_epoch?: unknown;
        revision?: unknown;
        catalog_revision?: unknown;
      }
    | undefined;
  if (
    !row ||
    typeof row.store_id !== "string" ||
    (row.authority_state !== "staged" && row.authority_state !== "active") ||
    typeof row.authority_epoch !== "number" ||
    typeof row.revision !== "number" ||
    typeof row.catalog_revision !== "number"
  ) {
    throw new StoreError("store.corrupt", "store_meta is missing or malformed; the store identity cannot be verified");
  }
  return {
    storeId: row.store_id,
    authorityState: row.authority_state,
    epoch: row.authority_epoch,
    revision: row.revision,
    catalogRevision: row.catalog_revision,
  };
}

// ---------------------------------------------------------------------------
// Public interface (contract §5)
// ---------------------------------------------------------------------------

export type StoreContext = { harnessDir: string };

export type StoreHandle = {
  db: StoreDb;
  storeId: string;
  epoch: number;
  schemaVersion: number;
  close(): void;
};

/**
 * Open an existing store for reading or writing. Creates nothing: a missing
 * database is a `store.not-initialized` refusal. Readers open with the
 * read-only option plus `query_only=ON`. The schema and store identity are
 * verified on every request; drift/newer/corrupt refuses before mutation.
 */
export async function openStore(context: StoreContext, mode: "read" | "write"): Promise<StoreHandle> {
  assertStoreRuntimeSupported();
  const dbPath = storeDbPath(context);
  if (!existsSync(dbPath)) {
    throw new StoreError(
      "store.not-initialized",
      `No issue store exists at ${dbPath}. Run "mstar store init" for a genuinely empty workspace ` +
        `(or the staged migration for an existing workspace). Nothing was created.`,
    );
  }
  let db: StoreDb;
  try {
    db = await connect(dbPath, mode);
  } catch (error) {
    refuseOpenFailure(error, dbPath);
  }
  try {
    const schemaVersion = validateAppliedMigrations(readAppliedMigrations(db, false));
    const meta = readStoreMeta(db);
    return {
      db,
      storeId: meta.storeId,
      epoch: meta.epoch,
      schemaVersion,
      close(): void {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    refuseOpenFailure(error, dbPath);
  }
}

/**
 * Create-only initialization for a genuinely empty workspace (contract §2):
 * applies all migrations and flips the fresh store to an ACTIVE EMPTY state
 * (epoch 1) in one atomic unit. An existing database refuses
 * `store.already-exists` and is not touched; a failed init leaves no file.
 */
export async function initializeStore(context: StoreContext): Promise<StoreHandle> {
  assertStoreRuntimeSupported();
  const dbPath = storeDbPath(context);
  const alreadyExists = (): StoreError =>
    new StoreError(
      "store.already-exists",
      `An issue store already exists at ${dbPath}. "store init" is create-only and must not reuse ` +
        `store.not-initialized for an existing store; use the upgrade path for schema changes. Nothing was modified.`,
    );
  // Refuse before any open so WAL/pragma setup cannot rewrite pre-existing bytes.
  if (existsSync(dbPath)) {
    throw alreadyExists();
  }
  const createdFile = true;
  let db: StoreDb | undefined;
  try {
    db = await connect(dbPath, "write");
    if (process.env.MSTAR_STORE_TEST_RUNNER === "1" && process.env.MSTAR_STORE_FAIL_INIT === "1") {
      throw new Error("induced init failure");
    }
    db.exec("begin immediate");
    try {
      const schemaPresent = db
        .prepare("select count(*) as n from sqlite_master where type='table' and name='schema_version'")
        .get() as { n?: number } | undefined;
      // Concurrent initializers that both created the file still refuse once
      // the winner records schema_version inside this exclusive transaction.
      if (schemaPresent?.n) {
        db.exec("rollback");
        throw alreadyExists();
      }
      applyPendingMigrations(db, { alreadyInTransaction: true });
      db.prepare("update store_meta set authority_state = 'active', activated_at = ? where id = 1").run(nowRfc3339());
      db.exec("commit");
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
        // nothing committed either way
      }
      throw error;
    }
    const meta = readStoreMeta(db);
    return {
      db,
      storeId: meta.storeId,
      epoch: meta.epoch,
      schemaVersion: MIGRATIONS.length,
      close(): void {
        db.close();
      },
    };
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // closed after a connection-level failure
      }
    }
    const skipUnlink = error instanceof StoreError && error.code === "store.already-exists";
    if (createdFile && !skipUnlink) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(dbPath + suffix);
        } catch {
          // best-effort cleanup of our own failed create
        }
      }
    }
    throw error;
  }
}

/**
 * Apply pending migrations to an existing store. The caller is responsible
 * for a SQLite-consistent backup and quiesced writers (contract §2/§7) —
 * this function itself is atomic: the whole pending batch commits or rolls
 * back together. Idempotent when the store is already current.
 */
export async function upgradeStore(context: StoreContext): Promise<{ schemaVersion: number }> {
  assertStoreRuntimeSupported();
  const dbPath = storeDbPath(context);
  if (!existsSync(dbPath)) {
    throw new StoreError(
      "store.not-initialized",
      `No issue store exists at ${dbPath}; there is nothing to upgrade. Run "mstar store init" for a ` +
        `genuinely empty workspace. Nothing was created.`,
    );
  }
  let db: StoreDb;
  try {
    db = await connect(dbPath, "write");
  } catch (error) {
    refuseOpenFailure(error, dbPath);
  }
  try {
    const schemaVersion = applyPendingMigrations(db);
    readStoreMeta(db);
    return { schemaVersion };
  } catch (error) {
    refuseOpenFailure(error, dbPath);
  } finally {
    db.close();
  }
}
