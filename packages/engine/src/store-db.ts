/**
 * store-db.ts — issue-store runtime boundary, connection lifecycle and the
 * checksum-verified migration framework.
 *
 * Authority: issue-store-contract.md §2 (connection/path/upgrades) and §8
 * (accepted runtime decision). User-selected runtime: direct in-process
 * `node:sqlite` on a runtime whose owning manifest declares the Node floor in
 * `engines.node` (the floor is read at runtime; `package.json` owns it) — no
 * child transport, daemon, `bun:sqlite`, driver dependency or older-runtime
 * fallback. Bun carries no floor: it is a development toolchain.
 *
 * SQLite is NEVER acquired at module import: `node:sqlite` is loaded lazily
 * inside the connection functions only, so importing this module (or the
 * engine index, or running `mstar --help`) neither loads the driver nor
 * touches the filesystem.
 *
 * Issue-domain verbs (capture/disposition/relations) are NOT implemented
 * here — they arrive with later tasks on top of this boundary.
 */
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveProcessHarnessDir } from "./coordination.js";
import { readDeclaredNodeFloor, warnUncheckableNodeFloor } from "./core.js";
// Type-only import: erased at runtime, so it cannot create a cycle. The VALUE
// import of the activation validator must be loaded at call time (see
// validatedActivationAttestation below) because store-activation.ts reads
// MIGRATIONS from this module during its own module evaluation.
import type { ActivationAttestation, StoppedSessionAttestation } from "./store-activation.js";
import type { ProvisionProcessFacts } from "./activation-provisioning.js";

/**
 * The existing operator stop evidence, run through the existing activation
 * validator. Loaded at call time because `store-activation.ts` reads
 * `MIGRATIONS` from this module during its own module evaluation — a static
 * import from there would read an uninitialized binding before this module's
 * exported consts are initialised.
 */
async function validatedActivationAttestation(value: unknown): Promise<ActivationAttestation> {
  const { validateActivationAttestation } = await import("./store-activation.js");
  return validateActivationAttestation(value);
}

/** A validated instant: `Date.parse` finite, so offset spellings compare chronologically. */
function parsedInstant(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

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
  | "store.busy"
  | "store.upgrade-attestation-missing"
  | "store.upgrade-state-changed"
  | "store.upgrade-staged-record-missing"
  | "store.upgrade-staged-record-malformed"
  | "store.upgrade-staged-record-inconsistent"
  | "store.upgrade-staged-manifest-missing"
  // The file-route guards below refuse through this boundary too: the control
  // harness's ACTIVE execution authority retires the root/snapshot/session file
  // route (primary spec §4.3), and that refusal is a store-authority verdict —
  // not a `coordination.*` scoped-writer refusal and not a payload error.
  | "execution.direct-write-refused"
  | "execution.consumer-not-ready"
  | "execution.workflow-identity-mismatch"
  | "store.stale-epoch"
  | "store.not-active"
  | "store.publication-failed"
  | "store.publication-barrier-failed"
  | "store.created-handle-failed"
  | "store.upgrade-dsh-source-refused"
  | "store.upgrade-dsh-ack-unmatched"
  | "store.upgrade-dsh-failed";

/** Typed refusal with an actionable, stable code and optional machine facts. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  /**
   * Structured facts for the caller when a prose message cannot carry them
   * losslessly — e.g. the three distinct version facts of a schema refusal. It
   * is optional so the ~50 existing two-argument constructions keep their exact
   * shape; a caller that supplies none gets no `details` key at all.
   */
  readonly details?: Record<string, unknown>;

  constructor(code: StoreErrorCode, message: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = "StoreError";
    this.code = code;
    if (details !== undefined) this.details = details;
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

/** The runtime global is outside this build's ambient type map. One named view
 * keeps the read checked at its use site; this is the module's only cast. */
const RUNTIME_GLOBAL = globalThis as unknown as { Bun?: { version: string } };

/** Read the actual runtime, preferring the Bun global over `process.versions.node` */
export function detectStoreRuntime(): StoreRuntimeInfo {
  const bun = RUNTIME_GLOBAL.Bun;
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
  // Each runtime's refusal names only its own floor and home: the published CLI
  // entrypoint is a Node entry (its shebang), so Bun floors are reachable only
  // from a Bun-hosted plugin host or a development run — never rendered as a
  // CLI user's requirement.
  const kind = info.isBun ? "Bun" : "Node";
  // The floor is a version, so `package.json` owns it: read `engines.node` from
  // the owning manifest at runtime. Bun has no floor — it is a development
  // toolchain, and product code never gates on the Bun version. A manifest that
  // declares no floor leaves the version comparison unenforced; the capability
  // refusal below is unaffected.
  const floor = kind === "Node" ? readDeclaredNodeFloor() : null;
  if (kind === "Node" && floor === null) warnUncheckableNodeFloor();
  const runtimeHome = info.isBun ? "https://bun.sh" : "https://nodejs.org";
  if (info.hasSqlite === false) {
    throw new StoreError(
      "store.runtime-unsupported",
      `The native "node:sqlite" module is not available in this ${kind} ${info.version} runtime. ` +
        `The issue store requires ${kind}${floor === null ? "" : ` >=${floor}`} with native node:sqlite; upgrade the runtime ` +
        `(${runtimeHome}). No fallback runtime or driver is supported.`,
    );
  }
  if (floor !== null && compareVersions(info.version, floor) < 0) {
    throw new StoreError(
      "store.runtime-unsupported",
      `${kind} ${info.version} is below the issue-store floor. The store requires the native ` +
        `"node:sqlite" module on ${kind}${floor === null ? "" : ` >=${floor}`}; found ${kind} ${info.version}. Upgrade the runtime ` +
        `for this entrypoint (${runtimeHome}). No older-runtime fallback exists` +
        `${info.isBun ? "" : ", and Node 18 compatibility is not a supported contract"}.`,
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
    const mod = createRequire(import.meta.url)("node:sqlite") as Partial<SqliteModule>;
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

/**
 * The SAME driver through the runtime's synchronous module loader
 * (`createRequire`) — the only acquisition path a synchronous guard may use
 * (primary spec §4.3: no promise-returning guard). A static `import` cannot
 * stand in here: it is asynchronous by definition and would make every
 * synchronous file writer an unawaited async guard. Acquisition stays lazy: the
 * loader is created inside this function, never at module scope, and the driver
 * is reached only by a probe that already found a store on disk, so importing
 * this module still neither loads the driver nor opens a database. Module-scope
 * acquisition is also what makes a bundled dist evaluate `createRequire` during
 * module initialization, where a non-Node runtime has no `import.meta.url`.
 */
function loadSqliteDriverSync(): SqliteModule {
  try {
    const mod = createRequire(import.meta.url)("node:sqlite") as Partial<SqliteModule>;
    if (typeof mod.DatabaseSync !== "function") throw new Error("DatabaseSync is missing");
    return mod as SqliteModule;
  } catch (error) {
    assertStoreRuntimeSupported({ ...detectStoreRuntime(), hasSqlite: false });
    throw new StoreError(
      "store.runtime-unsupported",
      `Failed to load the native "node:sqlite" module synchronously: ${(error as Error).message}`,
    );
  }
}

/** The caller's selected harness root, not a process-discovery starting address.
 * Process/FILE callers discover through `resolveProcessHarnessDir` first; its
 * explicit override keeps even a missing or empty selected root authoritative. */
export function storeDbPath(context: { harnessDir: string }): string {
  if (!context?.harnessDir) throw new StoreError("store.corrupt", "StoreContext.harnessDir is required");
  const root = resolve(context.harnessDir);
  return join(resolveProcessHarnessDir(root, root) ?? root, "store.db");
}

/** SQLite's `busy_timeout` is a signed 32-bit millisecond count. */
const MAX_BUSY_TIMEOUT_MS = 2147483647;

/** The bounded wait, normalised ONCE at each public entry (contract §2): the
 * pragma only accepts a signed 32-bit integer millisecond count, so a caller's
 * value is floored into that domain and falls back to the published 5000ms
 * constant when even the floor is out of it — the number the pragma uses is
 * then the number every refusal reports. */
function busyTimeoutMs(value = DEFAULT_BUSY_TIMEOUT_MS): number {
  const floored = Math.floor(value);
  return Number.isInteger(floored) && floored > 0 && floored <= MAX_BUSY_TIMEOUT_MS ? floored : DEFAULT_BUSY_TIMEOUT_MS;
}

function refuseOpenFailure(error: unknown, dbPath: string, timeout = DEFAULT_BUSY_TIMEOUT_MS): never {
  if (error instanceof StoreError) throw error;
  if (isBusyError(error)) {
    throw new StoreError(
      "store.busy",
      `Another writer held the store past the bounded wait (${busyTimeoutMs(timeout)}ms). ` +
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
function busyAware(db: StoreDb, path: string, timeout: number): StoreDb {
  const refuseBusy = (error: unknown): never => {
    if (isBusyError(error)) {
      throw new StoreError(
        "store.busy",
        `Another writer held ${path} past the bounded wait (${timeout}ms). ` +
          `The statement was refused \u2014 roll back the current transaction and retry when the ` +
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
async function connect(dbPath: string, mode: "read" | "write", timeout = DEFAULT_BUSY_TIMEOUT_MS): Promise<StoreDb> {
  const { DatabaseSync } = await loadSqliteDriver();
  return openConnection(dbPath, mode, DatabaseSync, timeout);
}

/** SQLite's own file header is 100 bytes: bytes 0–15 are its format magic and
 * offsets 18/19 the file format's write/read version (`2` for WAL). */
const DATABASE_HEADER_BYTES = 100;
const SQLITE_FORMAT_MAGIC = "SQLite format 3\u0000";
const WAL_FILE_FORMAT_VERSION = 2;

/**
 * The store's final path must be a genuinely missing file or a regular file —
 * decided WITHOUT following a link (`lstat`). Only a missing path (ENOENT) is
 * "no store"; every path that EXISTS but is not a regular file — a symlink,
 * dangling or not, a directory, a device — and every path that cannot even be
 * examined is an existing-but-unreadable store and refuses `store.corrupt`
 * here. That is what keeps a link — whose target may sit outside the resolved
 * control root — from being answered as an absent store and reopening the
 * retired file route, and it runs before any existence check, header probe or
 * driver open.
 */
function assertAbsentOrRegularStoreFile(dbPath: string): void {
  let stats: Stats | undefined;
  let examineError: unknown;
  try {
    stats = lstatSync(dbPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return;
    examineError = error;
  }
  if (stats?.isFile()) return;
  const observed =
    stats === undefined
      ? `it could not be examined (${examineError instanceof Error ? examineError.message : String(examineError)})`
      : stats.isSymbolicLink()
        ? "it is a symbolic link"
        : "it is not a regular file";
  throw new StoreError(
    "store.corrupt",
    `The store path ${dbPath} is not a readable regular store file: ${observed}. A store is read and ` +
      `written only at its own canonical path inside the resolved control root; nothing was read or written.`,
  );
}

/**
 * Is this complete SQLite file header the one shape a read-only connection
 * cannot open on its own: a WAL-format database with no journal beside it?
 * Decided from the file's own bytes, non-mutating, without a format
 * interpreter — the magic string, a legal page size, both WAL version bytes, the
 * three payload fractions and the schema/text-encoding values SQLite itself
 * writes, plus the page-aligned size every SQLite database file has. Bytes that
 * merely happen to carry `2` in both version positions are not a database and
 * get no journal. Whether the file is actually a store (its schema, migration
 * checksums and identity) stays the caller's content check: this predicate only
 * settles what the header says.
 */
function isWalFormatDatabase(header: Buffer, bytes: number): boolean {
  if (bytes < DATABASE_HEADER_BYTES) return false;
  if (header.toString("latin1", 0, 16) !== SQLITE_FORMAT_MAGIC) return false;
  const pageSize = header.readUInt16BE(16);
  const legalPageSize = pageSize === 1 ? 65536 : pageSize;
  if (legalPageSize < 512 || legalPageSize > 65536 || (legalPageSize & (legalPageSize - 1)) !== 0) return false;
  if (header[18] !== WAL_FILE_FORMAT_VERSION || header[19] !== WAL_FILE_FORMAT_VERSION) return false;
  if (header[21] !== 64 || header[22] !== 32 || header[23] !== 32) return false;
  // 0 is the legal "no schema recorded yet" value for both fields.
  if (header.readUInt32BE(44) > 4) return false;
  if (header.readUInt32BE(56) > 3) return false;
  return bytes % legalPageSize === 0;
}

/**
 * Put back the `-wal` file a read-only connection needs when SQLite's own clean
 * close has folded the journal into the database file and removed it.
 *
 * SQLite reads a WAL database THROUGH its journal: a read-only connection
 * creates the `-shm` index itself but can never create the `-wal`, so the
 * quiesced shape — every committed frame in the database file, header still
 * recording WAL, no sidecars — refuses the open with SQLITE_CANTOPEN, which
 * surfaces here as `store.corrupt` "unable to open database file". Node's
 * `node:sqlite` creates that empty journal inside its open; Bun 1.4.0 refuses
 * instead, and the shape is not rare: this runtime completes a closed handle's
 * cleanup — checkpoint, then remove the empty sidecars — when the handle is
 * collected, so a read after any writer close can meet it. The same shape is
 * what a store file copied without its sidecars has.
 *
 * The database file IS the whole committed state in that shape — a journal is
 * only absent because SQLite's own clean close removed it, or the store file was
 * copied without it — so the empty journal the read needs is created here: never
 * a fabricated frame, and never over an existing file (`wx`), so a writer that
 * created its journal first is left exactly as it is. Every other shape — a
 * rollback-journal store, a store that already has its journal, bytes that are
 * not a database, an unreadable file — is left untouched and keeps its own
 * refusal, so a refused store never gains a sidecar.
 */
function ensureJournalForRead(dbPath: string): void {
  if (existsSync(`${dbPath}-wal`)) return;
  const header = Buffer.alloc(DATABASE_HEADER_BYTES);
  let bytes: number;
  try {
    const source = openSync(dbPath, "r");
    try {
      bytes = fstatSync(source).size;
      if (readSync(source, header, 0, header.length, 0) < header.length) return;
    } finally {
      closeSync(source);
    }
  } catch {
    // Not a readable store file: the open below reports its own failure, exactly
    // as it did before this shape check existed.
    return;
  }
  if (!isWalFormatDatabase(header, bytes)) return;
  let journal: number;
  try {
    journal = openSync(`${dbPath}-wal`, "wx");
  } catch {
    // `EEXIST` — a writer created the journal first; nothing to add. Any other
    // failure leaves the store to the open below, which reports it.
    return;
  }
  closeSync(journal);
}

/**
 * The one connection body (pragma order, verification, busy mapping) shared by
 * the async opener and the synchronous route probe. `DatabaseSync` is handed in
 * so each caller owns its own lazy acquisition path.
 */
function openConnection(
  dbPath: string,
  mode: "read" | "write",
  DatabaseSync: SqliteModule["DatabaseSync"],
  timeout = DEFAULT_BUSY_TIMEOUT_MS,
): StoreDb {
  // node:sqlite rejects an explicit `undefined` options argument — open
  // writers without a second argument, readers with the read-only option.
  let db: StoreDb;
  try {
    // The final path must be a regular file inside the control root: neither
    // intent follows a symlink out of it. A read-only connection can also never
    // create the `-wal` a quiesced WAL store needs, so that empty journal is put
    // back before the read open (see the helpers).
    assertAbsentOrRegularStoreFile(dbPath);
    if (mode === "read") ensureJournalForRead(dbPath);
    db = mode === "read" ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
  } catch (error) {
    if (mode === "read" && isRawCantOpen(error)) throw error;
    refuseOpenFailure(error, dbPath, timeout);
  }
  const fail = (message: string): never => {
    db.close();
    throw new StoreError("store.corrupt", `${message} (opening ${dbPath})`);
  };
  try {
    db.exec(`pragma busy_timeout=${timeout}`);
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
    if (mode === "read" && isRawCantOpen(error)) throw error;
    refuseOpenFailure(error, dbPath, timeout);
  }
  return busyAware(db, dbPath, timeout);
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

/**
 * Migration 2 — catalog/registration tables (state-projection-contract §2),
 * appended through the runner above; migration 1 is untouched. One typed
 * entity table carries every catalog family, keyed by the composite
 * `(kind, id)`.
 *
 * Boundary (contract §1): these tables hold catalog metadata only. There is
 * no execution status/phase/progress/lease column anywhere here — the root
 * active-workflow register and the snapshots stay the execution authority,
 * and `catalog_execution_bindings` records the historical workflow
 * association plus the frozen plan-input identity, nothing else.
 *
 * `catalog_entities.source_hash` is nullable: a registration may predate the
 * document body (or the body may be missing), and readers disclose a missing
 * location rather than refusing it.
 */
export const MIGRATION_2_SQL = `
create table catalog_entities(
  kind text not null check (kind in ('project','iteration','plan','document')),
  id text not null,
  title text not null,
  description text,
  root_kind text not null check (root_kind in ('repository','harness','plans','iterations','specs','knowledge','projects')),
  relative_path text not null,
  document_kind text check (document_kind in ('spec','knowledge','guide','compass','plan','roadmap','review','other')),
  lifecycle text not null default 'active' check (lifecycle in ('active','archived','superseded')),
  revision integer not null default 1 check (revision > 0),
  registered_at text not null,
  updated_at text not null,
  source_hash text,
  primary key (kind, id),
  check (document_kind is null or kind = 'document')
);
create unique index catalog_entities_location on catalog_entities(kind, root_kind, relative_path);
create index catalog_entities_document_kind on catalog_entities(document_kind) where document_kind is not null;
create table catalog_links(
  from_kind text not null check (from_kind in ('project','iteration','plan','document')),
  from_id text not null,
  relation text not null check (relation in ('belongs-to','documents','spec-ref','knowledge-ref','derived-from','supersedes')),
  to_kind text not null check (to_kind in ('project','iteration','plan','document')),
  to_id text not null,
  ordinal integer,
  primary key (from_kind, from_id, relation, to_kind, to_id),
  foreign key (from_kind, from_id) references catalog_entities(kind, id),
  foreign key (to_kind, to_id) references catalog_entities(kind, id),
  check (from_kind != to_kind or from_id != to_id),
  check (ordinal is null or ordinal >= 0),
  check (
    (relation = 'belongs-to' and from_kind in ('plan','iteration','document') and to_kind = 'project')
    or (relation = 'belongs-to' and from_kind = 'plan' and to_kind = 'iteration')
    or (relation = 'documents' and from_kind in ('iteration','project','plan') and to_kind = 'document')
    or (relation in ('spec-ref','knowledge-ref','derived-from') and from_kind in ('plan','iteration','document') and to_kind = 'document')
    or (relation = 'supersedes' and from_kind = to_kind)
  )
);
create index catalog_links_target on catalog_links(to_kind, to_id);
create table catalog_operations(
  operation_id text primary key,
  request_hash text not null,
  phase text not null check (phase in ('prepared','execution-written','committed','aborted')),
  catalog_delta_json text not null,
  before_versions_json text not null,
  after_versions_json text not null,
  result_json text,
  created_at text not null,
  updated_at text not null
);
create table catalog_execution_bindings(
  workflow_id text not null,
  catalog_kind text not null check (catalog_kind in ('iteration','plan')),
  catalog_id text not null,
  workflow_root_kind text not null check (workflow_root_kind in ('repository','harness','plans','iterations','specs','knowledge','projects')),
  workflow_relative_path text not null,
  catalog_revision integer not null,
  input_hash text not null,
  pin_json text not null,
  operation_id text not null,
  primary key (workflow_id, catalog_kind, catalog_id),
  foreign key (catalog_kind, catalog_id) references catalog_entities(kind, id)
);
`;

/**
 * Migration 3 — disposable execution/roadmap projection tables
 * (state-projection-contract §5), appended through the runner above;
 * migrations 1/2 stay untouched. Copying the whole model:
 * issue/catalog tables are the authority and are never rebuilt, while every
 * `projection_*` table holds ONE published generation selected by
 * `projection_meta.generation` and may be dropped and rebuilt at any time.
 *
 * Column set is the contract's §5 list, nothing else: `projection_plans`
 * stores execution status/progress/phase/done_at plus the catalog pin
 * revision and deliberately NOT the editable title/path (catalog owns
 * identity), and `projection_leases` stores presence/holder/worktree/expiry
 * and never a session label or token payload.
 *
 * `projection_meta.format_version` is the frozen value 1 of the migration
 * that created the table; `PROJECTION_FORMAT_VERSION` in `projection.ts` is
 * the reader/writer's current version. A later bump therefore makes the
 * existing generation invalid on sight (contract §5: a schema/format upgrade
 * rebuilds on the next read instead of reinterpreting old rows as
 * authority) — which is exactly why the value is baked into this immutable
 * SQL rather than read from code.
 *
 * `freshness` starts 'unavailable' with a null generation: a store that has
 * never published a projection must not look like a workspace with zero
 * active work.
 */
export const MIGRATION_3_SQL = `
create table projection_meta(
  id integer primary key check (id = 1),
  generation integer,
  format_version integer not null check (format_version >= 1),
  source_set_hash text,
  built_at text,
  checked_at text not null,
  freshness text not null check (freshness in ('current','stale','unavailable')),
  last_error_json text
);
create table projection_sources(
  generation integer not null,
  source_key text not null,
  kind text not null check (kind in ('root','workflow','compass','roadmap')),
  root_kind text not null check (root_kind in ('repository','harness','plans','iterations','specs','knowledge','projects')),
  relative_path text not null,
  sha256 text,
  state text not null check (state in ('ok','missing','invalid','inaccessible')),
  diagnostic text,
  primary key (generation, source_key)
);
create table projection_workflows(
  generation integer not null,
  id text not null,
  type text not null check (type in ('plan','iteration')),
  status text not null,
  phase text,
  started_at text,
  ended_at text,
  updated_at text,
  branch_base text,
  branch_source text,
  branch_integration text,
  branch_target text,
  active_registration integer not null check (active_registration in (0,1)),
  primary key (generation, id)
);
create table projection_plans(
  generation integer not null,
  workflow_id text not null,
  plan_id text not null,
  status text,
  progress text,
  phase text,
  done_at text,
  catalog_pin_revision integer,
  primary key (generation, workflow_id, plan_id)
);
create table projection_leases(
  generation integer not null,
  workflow_id text not null,
  plan_id text not null,
  kind text not null check (kind in ('execution','integration-merge')),
  holder text,
  worktree_path text,
  expires_at text,
  primary key (generation, workflow_id, plan_id, kind)
);
create table projection_compasses(
  generation integer not null,
  iteration_id text not null,
  summary text,
  milestones_json text not null,
  started_at text,
  ended_at text,
  status text,
  primary key (generation, iteration_id)
);
create table projection_roadmaps(
  generation integer not null,
  project_id text not null,
  direction text,
  goals_json text not null,
  milestones_json text not null,
  primary key (generation, project_id)
);
insert into projection_meta(id, generation, format_version, source_set_hash, built_at, checked_at, freshness, last_error_json)
values (1, null, 1, null, null, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'unavailable', null);
`;

/**
 * Migration 4 — execution authority tables (primary spec §2.2). Appended
 * through the runner above; migrations 1–3 stay byte-identical so every
 * applied store keeps its recorded checksum.
 *
 * These tables ARE the execution domain, never a projection: there is no
 * status/progress/done/holder/expiry copy of a `projection_*` column here, and
 * the issue/catalog authority in `store_meta` is left untouched. The
 * `execution_meta` singleton is created `legacy` and never `active` — a schema
 * upgrade is not an execution activation, and the JSON route stays live until
 * a separate activation commits. `root_updated_at` records the row-creation
 * instant because a schema upgrade imports no root; a migration that imports
 * the root replaces it with the preserved source timestamp.
 *
 * The foreign keys and the partial unique indexes are the structural
 * ownership guarantees: no session/lease/input can reference a workflow or
 * plan that does not exist (no dangling lease), one plan-pm identity cannot
 * silently move between plans (session primary key), and at most one ACTIVE
 * coordinator per workflow / one ACTIVE plan-pm per plan can exist at a time.
 * Migration 9 removes the per-plan-lease and plan-PM half of this; the block
 * stays verbatim as the recorded history of what version 4 created.
 */
export const MIGRATION_4_SQL = `
create table execution_meta(
  id integer primary key check (id = 1),
  protocol_version integer not null check (protocol_version = 1),
  authority_state text not null check (authority_state in ('legacy','staged','active')),
  revision integer not null check (revision > 0),
  root_updated_at text not null,
  manifest_id text,
  activated_at text
);
insert into execution_meta(id, protocol_version, authority_state, revision, root_updated_at)
values (1, 1, 'legacy', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
create table execution_workflows(
  workflow_id text primary key,
  revision integer not null check (revision > 0),
  creator_session_id text,
  state_json text not null,
  created_at text not null,
  updated_at text not null
);
create table execution_registry(
  workflow_id text primary key references execution_workflows(workflow_id),
  entry_json text not null
);
create table execution_plans(
  workflow_id text not null references execution_workflows(workflow_id),
  plan_id text not null,
  revision integer not null check (revision > 0),
  ordinal integer not null check (ordinal >= 0),
  state_json text not null,
  coordination_json text not null,
  primary key (workflow_id, plan_id),
  unique (workflow_id, ordinal)
);
create table execution_sessions(
  workflow_id text not null references execution_workflows(workflow_id),
  role text not null check (role in ('coordinator','plan-pm')),
  session_id text not null,
  plan_id text,
  epoch integer not null check (epoch > 0),
  revision integer not null check (revision > 0),
  state text not null check (state in ('active','suspended','revoked')),
  bound_at text not null,
  primary key (workflow_id, role, session_id),
  foreign key (workflow_id, plan_id) references execution_plans(workflow_id, plan_id),
  check ((role = 'coordinator' and plan_id is null) or (role = 'plan-pm' and plan_id is not null))
);
create unique index execution_sessions_active_coordinator
  on execution_sessions(workflow_id) where role = 'coordinator' and state = 'active';
create unique index execution_sessions_active_plan_pm
  on execution_sessions(workflow_id, plan_id) where role = 'plan-pm' and state = 'active';
create table execution_leases(
  workflow_id text not null,
  plan_id text not null,
  revision integer not null check (revision > 0),
  owner_epoch integer not null check (owner_epoch > 0),
  lease_json text not null,
  primary key (workflow_id, plan_id),
  foreign key (workflow_id, plan_id) references execution_plans(workflow_id, plan_id)
);
create table execution_integration_leases(
  workflow_id text primary key references execution_workflows(workflow_id),
  revision integer not null check (revision > 0),
  owner_epoch integer not null check (owner_epoch > 0),
  lease_json text not null
);
create table execution_inputs(
  workflow_id text not null,
  plan_id text not null,
  revision integer not null check (revision > 0),
  input_json text not null,
  input_hash text not null,
  catalog_pin_json text,
  primary key (workflow_id, plan_id),
  foreign key (workflow_id, plan_id) references execution_plans(workflow_id, plan_id)
);
create table execution_operations(
  epoch integer not null check (epoch > 0),
  operation_id text not null,
  request_hash text not null,
  store_id text not null,
  workflow_id text not null,
  plan_id text,
  result_json text not null,
  committed_at text not null,
  primary key (epoch, operation_id)
);
create table execution_migrations(
  manifest_id text primary key,
  manifest_hash text not null,
  phase text not null check (phase in ('staged','active','retired','aborted')),
  manifest_json text not null,
  activation_receipt_json text,
  retirement_json text,
  created_at text not null,
  updated_at text not null
);
`;

/** Next append-only execution schema change: coverage is optional during staging. */
export const MIGRATION_5_SQL = `
alter table execution_migrations add column coverage_json text;
`;

/**
 * One append-only migration. `normalize`, when present, performs the JSON
 * transformation the version's SQL cannot express (the members it removes or
 * rewrites live inside stored JSON), running in the SAME exclusive transaction
 * as this version's row. Its context carries the operator facts the upgrade was
 * invoked with — the one supported authorization a cutover may act on.
 */
export type MigrationContext = {
  /**
   * The operator's FULL validated activation attestation, when the upgrade
   * supplied one. It is the one supported authorization a cutover may act on:
   * a migration never treats an unattested stopped id as authority. When it
   * is absent and a held retired claim must be settled, the settlement raises
   * `SettlementAttestationNeeded` and the upgrade entry generates the
   * document (I-000297) and retries — a migration never treats an unattested
   * stop id as authority either way.
   */
  attestation?: ActivationAttestation;
  /** The invoking operator, recorded as the generated document's actor. */
  operator?: string;
  /** Test-injected process facts for the generated document's consumer row. */
  processFacts?: ProvisionProcessFacts;
  /**
   * The settling transaction's clock. ONE instant is captured per settling
   * transaction and stamped on the generated document and on every tombstone
   * it releases, so a recorded receipt never mixes ambient time with the
   * caller's clock. Absent: the system clock.
   */
  now?: () => string;
};

/**
 * The one internal signal the settlement raises when a held retired claim
 * must be settled and the operator supplied no attestation: it names the
 * holders, one stop row per holder, and the settling transaction's single
 * instant the generated document attests. It never escapes the upgrade entry,
 * which catches it, provisions the document and retries the (rolled-back,
 * therefore clean) upgrade once.
 */
export class SettlementAttestationNeeded extends Error {
  constructor(
    readonly holders: readonly string[],
    readonly stopped: readonly StoppedSessionAttestation[],
    readonly attestedAt: string,
  ) {
    super("a held retired plan-PM claim needs a generated attestation");
    this.name = "SettlementAttestationNeeded";
  }
}

/**
 * The PUBLIC-boundary form of the internal settlement signal: a direct engine
 * caller (`initializeStore`/`upgradeStore` are exported) never receives the
 * bare, code-less marker — only the upgrade pair consumes it, and only when it
 * explicitly asks (`raiseSettlementSignal`). The refusal names the holders, the
 * competing instants and the supported recovery, exactly like the refusal the
 * settlement site itself emits for a supplied document.
 */
function settlementSignalRefusal(signal: SettlementAttestationNeeded): StoreError {
  const holders = signal.holders.map((holder) => JSON.stringify(holder)).join(", ");
  return Object.assign(
    new StoreError(
      "store.upgrade-attestation-missing",
      `workflow(s) ${holders} hold a retired plan-PM integration claim this cutover must settle, and no operator ` +
        `attestation was supplied; the generated document is built by the upgrade entry (mstar store upgrade), not by ` +
        `this direct engine call. The store was left unchanged.`,
      { holders: [...signal.holders], stopped_sessions: signal.stopped.map((session) => session.sessionId) },
    ),
    {
      recovery:
        "rerun the upgrade through the CLI, which generates the operator document itself: mstar store upgrade --operator <name>; " +
        "to fix the document explicitly instead, pass --attestation <absolute-json> whose attestedAt is at or after the claim instant.",
    },
  );
}

export type Migration = { version: number; name: string; sql: string; normalize?: (db: StoreDb, context: MigrationContext) => void };

/** Migration 6 — durable roadmap content authority; never import disposable projection rows. */
export const MIGRATION_6_SQL = `
create table project_roadmaps(
  project_id text primary key,
  project_kind text not null default 'project' check (project_kind = 'project'),
  content_markdown text not null,
  content_hash text not null,
  revision integer not null check (revision > 0),
  updated_at text not null,
  foreign key (project_kind, project_id) references catalog_entities(kind, id)
);
drop table projection_roadmaps;
`;
/** Migration 7 — project-scoped milestones and nullable issue association. */
export const MIGRATION_7_SQL = `
create table project_milestones(
  milestone_id text primary key not null,
  project_id text not null,
  project_kind text not null default 'project' check (project_kind = 'project'),
  name text not null check (length(trim(name)) > 0),
  target text check (
    target is null or
    (length(target) = 10 and target glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
  ),
  status text not null default 'planned'
    check (status in ('planned','active','delivered','dropped')),
  ordinal integer not null check (typeof(ordinal) = 'integer' and ordinal >= 0),
  revision integer not null default 1 check (revision > 0),
  created_at text not null,
  updated_at text not null,
  foreign key (project_kind, project_id) references catalog_entities(kind, id)
);
create index project_milestones_order
  on project_milestones(project_id, ordinal, milestone_id);
alter table issues add column milestone_id text
  references project_milestones(milestone_id);
create index issues_milestone_disposition
  on issues(project_id, milestone_id, disposition)
  where milestone_id is not null;
create trigger issues_milestone_project_insert
before insert on issues
when new.milestone_id is not null and not exists (
  select 1 from project_milestones m
  where m.milestone_id = new.milestone_id and m.project_id = new.project_id
)
begin
  select raise(abort, 'milestone.project-mismatch');
end;
create trigger issues_milestone_project_update
before update of project_id, milestone_id on issues
when new.milestone_id is not null and not exists (
  select 1 from project_milestones m
  where m.milestone_id = new.milestone_id and m.project_id = new.project_id
)
begin
  select raise(abort, 'milestone.project-mismatch');
end;
create trigger project_milestones_identity_immutable
before update of milestone_id, project_id on project_milestones
when new.milestone_id != old.milestone_id or new.project_id != old.project_id
begin
  select raise(abort, 'milestone.identity-immutable');
end;
`;
/** Migration 8 — historical provenance predates actor-only link writes. */
export const MIGRATION_8_SQL = `
alter table provenance add column origin text not null default 'scoped' check (origin in ('scoped','unscoped'));
`;


/**
 * Migration 9 — coordinator-only execution sessions, and no per-plan lease,
 * with the retained business JSON normalized into the target shape.
 *
 * The removed plan-PM seat left three storage artefacts behind: per-plan
 * session rows, per-plan write leases, and — in every store that reached schema
 * 8 through the old protocol — a sealed `prepared` and a `handoff` inside each
 * plan's `coordination_json` plus `self_amendments` in the workflow header.
 * None of them has a producer any more, and the store's own JSON cannot be
 * transformed by SQL alone, so the migration runner performs one
 * `normalizeExecutionState` pass over `execution_plans` / `execution_workflows`
 * in the SAME exclusive transaction that records this version.
 *
 * The per-plan lease is the ONE place a schema-8 store records a plan's source
 * checkout and branch (the plan row itself never carries it — the old producer
 * deletes `execution_lease` before writing `state_json`). SQL cannot read a
 * value and copy it into JSON, so the capture of `execution_leases` is a
 * TEMPORARY table the normalizer reads after this SQL and the runner drops
 * after the normalizer returns: the lease facts are reconciled into ordinary
 * row metadata BEFORE their table is gone.
 *
 * `execution_sessions` keeps only coordinator rows, so the `plan_id` column and
 * the role check that admitted `plan-pm` go with them — a column's CHECK cannot
 * be dropped in place, hence the table rewrite.
 *
 * Migrations 1–8 stay byte-identical: every applied store keeps its recorded
 * checksum, and the historical DDL that once created these rows remains
 * readable provenance rather than a second live authority.
 */
export const MIGRATION_9_SQL = `
create table execution_session_cutover as
  select workflow_id, plan_id, session_id from execution_sessions where role = 'plan-pm';
create table execution_lease_cutover as
  select workflow_id, plan_id, owner_epoch, lease_json from execution_leases;
create table execution_integration_cutover as
  select workflow_id, lease_json from execution_integration_leases;
delete from execution_sessions where role = 'plan-pm';
create table execution_sessions_coordinator(
  workflow_id text not null references execution_workflows(workflow_id),
  role text not null check (role = 'coordinator'),
  session_id text not null,
  epoch integer not null check (epoch > 0),
  revision integer not null check (revision > 0),
  state text not null check (state in ('active','suspended','revoked')),
  bound_at text not null,
  primary key (workflow_id, role, session_id)
);
insert into execution_sessions_coordinator(workflow_id, role, session_id, epoch, revision, state, bound_at)
  select workflow_id, role, session_id, epoch, revision, state, bound_at from execution_sessions;
drop table execution_sessions;
alter table execution_sessions_coordinator rename to execution_sessions;
create unique index execution_sessions_active_coordinator
  on execution_sessions(workflow_id) where role = 'coordinator' and state = 'active';
drop table execution_leases;
`;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredRecord(text: unknown, what: string): JsonRecord {
  const parsed: unknown = typeof text === "string" ? JSON.parse(text) : undefined;
  if (!isRecord(parsed)) throw new StoreError("store.corrupt", `${what} is not a stored JSON object; the store was left unchanged`);
  return parsed;
}

/**
 * Normalize one legacy row-coordination block: the removed seat's sealed
 * `prepared` becomes the contracted ordinary configuration, its `progress` is
 * carried over, a `completed` attempt becomes a contracted `CompletionRecord`
 * (the row's real QC/QA and integration evidence — never rewritten), and every
 * other protocol member is dropped. The result carries NO revision: that value
 * belongs to the `execution_plans.revision` column alone.
 */
function normalizeLegacyCoordination(legacy: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  const prepared = legacy.prepared;
  if (isRecord(prepared)) {
    const qaGate = prepared.qa_gate;
    const findings = prepared.findings_cleanup;
    if (
      typeof prepared.prepared_by === "string" && prepared.prepared_by !== "" &&
      typeof prepared.prepared_at === "string" && prepared.prepared_at !== "" &&
      (qaGate === "mandatory" || qaGate === "pm-acceptance") &&
      (findings === "zero-residual" || findings === "allow-residual")
    ) {
      out.prepared = { qa_gate: qaGate, findings_cleanup: findings, prepared_by: prepared.prepared_by, prepared_at: prepared.prepared_at };
    }
  }
  if (isRecord(legacy.progress)) out.progress = legacy.progress;
  const handoff = legacy.handoff;
  if (isRecord(handoff) && handoff.state === "completed") {
    const qc = handoff.qc;
    const qa = handoff.qa;
    const integration = handoff.integration;
    const mapped: JsonRecord = {
      source_branch: typeof handoff.source_branch === "string" && handoff.source_branch !== "" ? handoff.source_branch : null,
      source_sha: typeof handoff.source_sha === "string" && handoff.source_sha !== "" ? handoff.source_sha : null,
      worktree_path: typeof handoff.worktree_path === "string" && handoff.worktree_path !== "" ? handoff.worktree_path : null,
      review_base: typeof handoff.review_base === "string" && handoff.review_base !== "" ? handoff.review_base : null,
      review_head: typeof handoff.review_head === "string" && handoff.review_head !== "" ? handoff.review_head : null,
      qc: isRecord(qc) ? qc : { decision: "", reports: [], consolidated: { path: "", sha256: "" } },
      qa: isRecord(qa) ? qa : { gate: "", decision: "", report: { path: "", sha256: "" } },
      completed_by: typeof handoff.accepted_by === "string" && handoff.accepted_by !== "" ? handoff.accepted_by : "",
      completed_at: typeof handoff.completed_at === "string" && handoff.completed_at !== "" ? handoff.completed_at : "",
    };
    if (isRecord(integration)) {
      mapped.integration = {
        target_branch: typeof integration.target_branch === "string" ? integration.target_branch : "",
        worktree_path: typeof integration.worktree_path === "string" ? integration.worktree_path : "",
        base_sha: typeof integration.base_sha === "string" ? integration.base_sha : "",
        result_sha: typeof integration.result_sha === "string" ? integration.result_sha : "",
        verified_at: typeof integration.verified_at === "string" ? integration.verified_at : "",
      };
    }
    out.completion = mapped;
  }
  return out;
}

/**
 * Map the source/cleanup ownership a removed per-plan lease carried onto the
 * ordinary row metadata the target shape uses.
 *
 * The plan's own metadata is the authoritative, ORDINARY and revisable record
 * of its checkout/branch: the target contract keeps scope on
 * `plans[].metadata`, and the coordinator revises it through ordinary `prepare`.
 * The removed lease is the superseded protocol's copy, so it only FILLS a member
 * metadata does not already record. A member the two disagree on is never a hard
 * gate: metadata wins (it is the live config an operator can revise), and the
 * stale lease value is dropped with its table.
 */
function reconcileLeaseScope(metadata: JsonRecord, lease: JsonRecord): JsonRecord | null {
  const worktree = typeof lease.worktree_path === "string" && lease.worktree_path !== ""
    ? lease.worktree_path
    : typeof lease.plan_worktree_path === "string" && lease.plan_worktree_path !== ""
      ? lease.plan_worktree_path
      : undefined;
  const branch = typeof lease.working_branch === "string" && lease.working_branch !== ""
    ? lease.working_branch
    : typeof lease.plan_branch === "string" && lease.plan_branch !== ""
      ? lease.plan_branch
      : undefined;
  if (worktree === undefined && branch === undefined) return null;
  const out: JsonRecord = { ...metadata };
  const recordedWorktree = metadata.worktree_path;
  const recordedBranch = metadata.working_branch;
  if (worktree !== undefined && (typeof recordedWorktree !== "string" || recordedWorktree === "")) {
    out.worktree_path = worktree;
  }
  if (branch !== undefined && (typeof recordedBranch !== "string" || recordedBranch === "")) {
    out.working_branch = branch;
  }
  return out;
}

function readLeaseCutover(db: StoreDb): Map<string, JsonRecord> {
  const table = db
    .prepare("select name from sqlite_master where type = 'table' and name = 'execution_lease_cutover'")
    .get() as { name?: unknown } | undefined;
  const leases = new Map<string, JsonRecord>();
  if (table === undefined) return leases;
  const rows = db
    .prepare("select workflow_id, plan_id, lease_json from execution_lease_cutover")
    .all() as Array<{ workflow_id?: unknown; plan_id?: unknown; lease_json?: unknown }>;
  for (const row of rows) {
    const raw = typeof row.lease_json === "string" ? (JSON.parse(row.lease_json) as unknown) : undefined;
    if (!isRecord(raw)) {
      throw new StoreError(
        "store.corrupt",
        `execution_leases(${String(row.workflow_id)},${String(row.plan_id)}).lease_json is not a stored JSON object; the ` +
          `recorded source/cleanup ownership cannot be reconciled. Nothing was modified.`,
      );
    }
    leases.set(`${String(row.workflow_id)}/${String(row.plan_id)}`, raw);
  }
  return leases;
}

/**
 * Rewrite the retained business JSON of an upgraded store into the target
 * shape. Runs inside the migration runner's own exclusive transaction: either
 * the whole schema + JSON cutover commits, or nothing does. Rows it does not
 * recognize are left exactly as they are — never guessed at, never edited by
 * hand — so a store that needs operator attention refuses through the normal
 * read/validation path instead of being silently mangled.
 */
function normalizeExecutionState(db: StoreDb, context: MigrationContext): void {
  const tables = new Set(
    (db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name?: unknown }>)
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter((name) => name !== ""),
  );
  if (!tables.has("execution_plans") || !tables.has("execution_workflows")) return;
  const leaseCutover = readLeaseCutover(db);

  const plans = db
    .prepare("select workflow_id, plan_id, state_json, coordination_json from execution_plans")
    .all() as Array<{ workflow_id?: unknown; plan_id?: unknown; state_json?: unknown; coordination_json?: unknown }>;
  const updatePlan = db.prepare("update execution_plans set state_json = ?, coordination_json = ? where workflow_id = ? and plan_id = ?");
  for (const row of plans) {
    const workflowId = String(row.workflow_id ?? "");
    const planId = String(row.plan_id ?? "");
    const what = `execution_plans(${workflowId},${planId})`;
    const state = parseStoredRecord(row.state_json, `${what}.state_json`);
    const legacy = parseStoredRecord(row.coordination_json, `${what}.coordination_json`);
    const coordination = normalizeLegacyCoordination(legacy);
    // The removed seat's plan row never carried `execution_lease` (the old
    // producer deleted it before insert), so the authoritative source/cleanup
    // scope is the keyed lease captured from `execution_leases` above.
    const lease = leaseCutover.get(`${workflowId}/${planId}`);
    const metadata = isRecord(state.metadata) ? state.metadata : {};
    const scope = lease === undefined ? null : reconcileLeaseScope(metadata, lease);
    const nextState: JsonRecord = { ...state };
    if (scope !== null) nextState.metadata = scope;
    if (isRecord(coordination.completion) && (!(typeof nextState.status === "string") || nextState.status === "Todo")) {
      nextState.status = "Done";
    }
    delete nextState.coordination;
    delete nextState.execution_lease;
    updatePlan.run(JSON.stringify(nextState), JSON.stringify(coordination), workflowId, planId);
  }

  const workflows = db
    .prepare("select workflow_id, state_json from execution_workflows")
    .all() as Array<{ workflow_id?: unknown; state_json?: unknown }>;
  const updateWorkflow = db.prepare("update execution_workflows set state_json = ? where workflow_id = ?");
  for (const row of workflows) {
    const workflowId = String(row.workflow_id ?? "");
    const state = parseStoredRecord(row.state_json, `execution_workflows(${workflowId}).state_json`);
    // The header keeps its identity and promotes the coordinator recovery
    // history; the removed per-workflow coordination block and the removed
    // self-amendment audit go, exactly as the file import writes it.
    const coordination = isRecord(state.coordination) ? state.coordination : undefined;
    const next: JsonRecord = { ...state };
    delete next.coordination;
    delete next.self_amendments;
    if (coordination !== undefined && coordination.identity_recoveries !== undefined) {
      next.identity_recoveries = coordination.identity_recoveries;
    }
    updateWorkflow.run(JSON.stringify(next), workflowId);
  }
  settleRetiredPlanPmIntegrationClaims(db, context);
}

/**
 * The per-plan integration merges the removed plan-PM seat left held are an
 * UNSUPPORTED orphan once their holder rows retire: they can never be released
 * through the surviving API. This pass settles exactly those claims in the SAME
 * cutover that retires the holder rows.
 *
 * The safe basis is the staged REAL retired plan-PM session's exact
 * (workflow_id, session_id) pair matched against the held claim's own
 * `workflow_id`/`holder` — never a globally unique session-id assumption, and
 * never a claim whose plan does not actually exist in that workflow. The
 * operator's FULL validated attestation must name that holder as stopped at or
 * after the claim, and at or before this cutover.
 *
 * A missing or plan-mismatched legacy lease is a REPORTED historical
 * disposition, not a blocker: the retired seat's authority is what this cutover
 * withdraws, and the surviving ordinary metadata/prepare path remains the
 * revisable record of scope. A foreign workflow, a non-retired session, a
 * current live holder, and a claim newer than the attested stop are all left
 * exactly where they are.
 */
function settleRetiredPlanPmIntegrationClaims(db: StoreDb, context: MigrationContext): void {
  // Retired plan-PM sessions, keyed by (workflow, session) so the same session
  // id recorded under another workflow is never cross-matched.
  const retiredByWorkflowSession = new Map<string, string>();
  for (const row of db
    .prepare("select workflow_id, plan_id, session_id from execution_session_cutover")
    .all() as Array<{ workflow_id?: unknown; plan_id?: unknown; session_id?: unknown }>) {
    if (typeof row.session_id !== "string" || row.session_id === "") continue;
    retiredByWorkflowSession.set(`${String(row.workflow_id ?? "")}/${row.session_id}`, String(row.plan_id ?? ""));
  }
  const attestation = context.attestation;
  const attestedInstant = attestation === undefined ? null : parsedInstant(attestation.attestedAt);
  // ONE instant for this settling transaction: the generated document attests
  // it, every claim's window is measured against it, and the tombstones record
  // it — never a second, ambient reading of the clock.
  const at = (context.now ?? (() => new Date().toISOString()))();
  const cutoverInstant = parsedInstant(at);
  const pendingHolders = new Set<string>();
  // One stop row per HOLDER, however many claims that holder left behind: a
  // duplicate row would attest the same stop twice and read as two holders.
  const pendingStoppedBySessionId = new Map<string, StoppedSessionAttestation>();
  const claims = db
    .prepare("select workflow_id, lease_json from execution_integration_cutover")
    .all() as Array<{ workflow_id?: unknown; lease_json?: unknown }>;
  const update = db.prepare("update execution_integration_leases set revision = revision + 1, lease_json = ? where workflow_id = ?");
  for (const row of claims) {
    const workflowId = String(row.workflow_id ?? "");
    const raw: unknown = typeof row.lease_json === "string" ? (JSON.parse(row.lease_json) as unknown) : undefined;
    if (!isRecord(raw)) {
      throw new StoreError("store.corrupt", `execution_integration_leases(${workflowId}).lease_json is not a stored JSON object; the store was left unchanged`);
    }
    const claim = raw;
    if (claim.status === "released") continue;
    const holder = claim.holder;
    if (typeof holder !== "string" || holder === "") continue;
    const seatPlanId = retiredByWorkflowSession.get(`${workflowId}/${holder}`);
    // Not a retired plan-PM holder's claim in THIS workflow: a coordinator's, a
    // foreign workflow's or a live claim is left exactly where it is.
    if (seatPlanId === undefined) continue;
    // The claim must name a plan that actually exists in this workflow; a claim
    // pointing at a missing business row is registry corruption handled through
    // the supported backup/restore API, not something an attestation can rewrite.
    const planRow = db.prepare("select 1 as present from execution_plans where workflow_id = ? and plan_id = ?").get(workflowId, typeof claim.plan_id === "string" ? claim.plan_id : "");
    if (planRow === undefined) {
      throw new StoreError(
        "store.corrupt",
        `execution_integration_leases(${workflowId}) holds a claim for plan ${JSON.stringify(claim.plan_id)}, which no longer exists in ` +
          `this workflow's registry. Recover the store from its supported backup/restore recovery point: ` +
          `run \`store execution restore-preview --backup <absolute-valid-pre-corruption-backup> --out <absolute-preview-path>\`, ` +
          `then \`store execution restore --preview <absolute-preview-path> --operator <name> --authorization <ref>\` ` +
          `(add \`--harness\` when needed). Nothing was modified.`,
      );
    }
    // Lazy provisioning (I-000297): with no supplied attestation the upgrade
    // entry generates one — this pass only records WHAT it must attest (the
    // retired holder rows this cutover deletes) and rolls back cleanly, so the
    // generated document is built and validated in the async entry and the
    // upgrade retries once. A migration never treats an unattested stop id as
    // authority: nothing is settled on this pass.
    if (attestation === undefined) {
      pendingHolders.add(holder);
      pendingStoppedBySessionId.set(holder, { sessionId: holder, host: "local", state: "stopped" });
      continue;
    }
    const attested = attestation.stoppedSessions.find((session) => session.sessionId === holder);
    const attestedInstant = parsedInstant(attestation.attestedAt);
    const claimedInstant = parsedInstant(claim.claimed_at);
    const settled =
      attestation !== undefined &&
      attested !== undefined &&
      (attested.state === "stopped" || attested.state === "reloaded") &&
      claimedInstant !== null &&
      attestedInstant !== null &&
      cutoverInstant !== null &&
      claimedInstant <= attestedInstant &&
      attestedInstant <= cutoverInstant;
    if (!settled) {
      // The competing instants are named: the stop evidence must sit at or
      // after the claim and at or before this cutover, whose generated
      // document attests the cutover instant itself.
      throw new StoreError(
        "store.upgrade-attestation-missing",
        `workflow ${workflowId} holds an integration claim for the retired plan-PM holder ${holder} (claimed_at ${String(claim.claimed_at ?? "?")}) ` +
          `that this cutover's attestation does not cover: the stop evidence must be dated at or after the claim and at or before this cutover ` +
          `(the generated document attests the cutover instant itself). The store was left at schema 8 unchanged. Recovery: rerun the same ` +
          `\`mstar store upgrade --operator <name>\` with --attestation <absolute-json> whose attestedAt is at or after the claim instant.`,
      );
    }
    const tombstone = {
      ...claim,
      status: "released",
      prior_holder: holder,
      released_by: "store-upgrade",
      released_at: attestation!.attestedAt,
      // The receiving document's OWN authorization reference, copied verbatim:
      // a batch that settles several holders keeps ONE reference, so every
      // holder's tombstone still matches the document it was settled under.
      // Holder identity stays in `prior_holder` above.
      release_reason: attestation!.operator.authorizationRef,
    };
    update.run(JSON.stringify(tombstone), workflowId);
  }
  if (pendingHolders.size > 0) {
    // Deterministic order: the generated reference and the stop rows it is
    // built from never depend on which claim row was read first.
    const holders = [...pendingHolders].sort();
    throw new SettlementAttestationNeeded(holders, holders.map((holder) => pendingStoppedBySessionId.get(holder)!), at);
  }
}
/** Five host-state tables for DSH-owned ledger facts. */
export const MIGRATION_10_SQL = `
create table dsh_ledger_events(
  seq_rowid integer primary key autoincrement,
  workflow_id text not null,
  event_id text,
  event_json text not null,
  recorded_at text not null
);
create index dsh_ledger_events_workflow on dsh_ledger_events(workflow_id, seq_rowid);
create table dsh_accepted_identities(
  workflow_id text not null,
  event_id text not null,
  digest text not null,
  accepted_at text not null,
  primary key(workflow_id, event_id)
);
create table dsh_scan_bounds(
  workflow_id text not null,
  session_id text not null,
  next integer not null,
  stream text,
  primary key(workflow_id, session_id)
);
create table dsh_session_bindings(
  session_id text not null,
  cwd text not null,
  selected_workflow_id text,
  execution_binding text,
  excluded_before_seq integer not null default 0,
  updated_at text not null,
  primary key(session_id, cwd)
);
create table dsh_status_emissions(
  session_id text not null,
  cwd text not null,
  turn integer not null,
  emitted_at text not null,
  payload_json text not null,
  primary key(session_id, cwd)
);
`;


export const MIGRATION_11_SQL = `
alter table dsh_ledger_events add column legacy_source_digest text;
alter table dsh_ledger_events add column legacy_line integer;
create unique index dsh_ledger_events_legacy_line
  on dsh_ledger_events(workflow_id, legacy_source_digest, legacy_line)
  where legacy_source_digest is not null;
`;

/**
 * Migration 12 — the severity vocabulary is `critical|high|medium|low|nit`;
 * the retired `info` value (migration 1's CHECK) is converted, not accepted.
 *
 * SQLite cannot alter a CHECK in place, so `issues` is rebuilt. Unlike
 * migration 9's subject, `issues` IS foreign-key referenced
 * (`occurrences`, `provenance`, `relations` ×2, `issue_transitions`), and this
 * batch runs inside one transaction with `foreign_keys=ON`, which no
 * in-transaction pragma can relax: dropping a referenced parent while child
 * rows exist aborts, and an `alter table … rename` with FK enforcement
 * rewrites the children's REFERENCES clauses instead of retargeting them.
 * The child rows are therefore staged out (their tables, indexes and
 * constraints untouched), the parent is rebuilt, and the rows are restored
 * before COMMIT — so the store is FK-consistent at every statement boundary
 * and `foreign_key_check` holds at commit.
 *
 * The rebuilt table restores migration 1's indexes and migration 7's
 * milestone column, index and triggers; `'info'` rows become `'nit'`.
 */
export const MIGRATION_12_SQL = `
create table occurrences_v12_stage as select * from occurrences;
create table provenance_v12_stage as select * from provenance;
create table relations_v12_stage as select * from relations;
create table issue_transitions_v12_stage as select * from issue_transitions;
delete from occurrences;
delete from provenance;
delete from relations;
delete from issue_transitions;
create table issues_nit(
  id text primary key,
  project_id text not null,
  title text not null,
  kind text not null check (kind in ('bug','risk','improvement','request','decision','review-obligation')),
  severity text not null check (severity in ('critical','high','medium','low','nit')),
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
  identity_key text not null unique,
  milestone_id text references project_milestones(milestone_id)
);
insert into issues_nit(id, project_id, title, kind, severity, disposition, impact, acceptance, owner, registered_at, closed_at, closure_note, created_at, updated_at, revision, provider, external_id, url, identity_key, milestone_id)
  select id, project_id, title, kind, case severity when 'info' then 'nit' else severity end, disposition, impact, acceptance, owner, registered_at, closed_at, closure_note, created_at, updated_at, revision, provider, external_id, url, identity_key, milestone_id
  from issues;
drop table issues;
alter table issues_nit rename to issues;
create unique index issues_external_identity on issues(provider, external_id) where external_id is not null;
create index issues_disposition on issues(project_id, disposition, severity);
create index issues_milestone_disposition
  on issues(project_id, milestone_id, disposition)
  where milestone_id is not null;
create trigger issues_milestone_project_insert
before insert on issues
when new.milestone_id is not null and not exists (
  select 1 from project_milestones m
  where m.milestone_id = new.milestone_id and m.project_id = new.project_id
)
begin
  select raise(abort, 'milestone.project-mismatch');
end;
create trigger issues_milestone_project_update
before update of project_id, milestone_id on issues
when new.milestone_id is not null and not exists (
  select 1 from project_milestones m
  where m.milestone_id = new.milestone_id and m.project_id = new.project_id
)
begin
  select raise(abort, 'milestone.project-mismatch');
end;
insert into occurrences select * from occurrences_v12_stage;
insert into provenance select * from provenance_v12_stage;
insert into relations select * from relations_v12_stage;
insert into issue_transitions select * from issue_transitions_v12_stage;
drop table occurrences_v12_stage;
drop table provenance_v12_stage;
drop table relations_v12_stage;
drop table issue_transitions_v12_stage;
`;

/**
 * Migration 13 — append-only project-move history.
 *
 * A project move changes the issue's project-scoped identity but not its
 * disposition, so `issue_transitions` (whose from/to columns are dispositions)
 * is the wrong ledger: an open→open row would pollute lifecycle history. This
 * table records one row per real move — old/new project, caller actor and
 * reason, and the issue revision the move produced — and is append-only.
 */
export const MIGRATION_13_SQL = `
create table issue_project_moves(
  id integer primary key,
  issue_id text not null references issues(id),
  from_project_id text not null,
  to_project_id text not null,
  actor text not null,
  reason text not null,
  occurred_at text not null,
  recorded_at text not null,
  issue_revision integer not null
);
create index issue_project_moves_issue on issue_project_moves(issue_id, id);
`;

/**
 * Migration 14 — compass plan membership on the projection.
 *
 * The compass frontmatter `plans:` list is the authored membership record, and
 * the iteration reads join it with the catalog links. The projected compass row
 * therefore carries the declared ids; existing rows default to the empty list
 * and the projection format bump rebuilds them from the documents.
 */
export const MIGRATION_14_SQL = `
alter table projection_compasses add column plans_json text not null default '[]';
`;

/**
 * Migration 15 — sync ledger: per-item sync state, resumable run cursors and
 * project-level provider bindings. `binding_id` is derived ("<provider>:<project_id>"),
 * not a sequence, so crash recovery reconstructs it from the binding row alone.
 * The external_id partial index mirrors `issues_external_identity`; cross-provider
 * uniqueness stays only in the `issues` index.
 */
export const MIGRATION_15_SQL = `
create table project_bindings(
  project_id text primary key,
  provider text not null,
  workspace text not null,
  team text not null,
  remote_project text not null,
  revision integer not null,
  updated_at text not null
);
create unique index project_bindings_remote on project_bindings(provider, workspace, remote_project);
create table issue_sync_state(
  binding_id text not null,
  direction text not null,
  local_id text not null references issues(id),
  external_id text,
  item_state text not null check (item_state in ('unbound','pending','applied','failed','skipped')),
  last_remote_updated_at text,
  last_error text,
  revision integer not null,
  updated_at text not null,
  primary key (binding_id, direction, local_id)
);
create unique index issue_sync_state_external on issue_sync_state(binding_id, direction, external_id) where external_id is not null;
create table sync_cursor(
  binding_id text not null,
  direction text not null,
  cursor text not null,
  updated_at text not null,
  primary key (binding_id, direction)
);
`;

/** Ordered immutable migrations. Never mutate an applied entry — append only. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "issue-core", sql: MIGRATION_1_SQL },
  { version: 2, name: "catalog-authority", sql: MIGRATION_2_SQL },
  { version: 3, name: "execution-projections", sql: MIGRATION_3_SQL },
  { version: 4, name: "execution-authority", sql: MIGRATION_4_SQL },
  { version: 5, name: "execution-coverage-column", sql: MIGRATION_5_SQL },
  { version: 6, name: "roadmap-content-authority", sql: MIGRATION_6_SQL },
  { version: 7, name: "project-milestones", sql: MIGRATION_7_SQL },
  { version: 8, name: "issue-provenance-origin", sql: MIGRATION_8_SQL },
  { version: 9, name: "execution-coordinator-only", sql: MIGRATION_9_SQL, normalize: normalizeExecutionState },
  { version: 10, name: "dsh-host-ledgers", sql: MIGRATION_10_SQL },
  { version: 11, name: "dsh-ledger-legacy-provenance", sql: MIGRATION_11_SQL },
  { version: 12, name: "severity-vocabulary-nit", sql: MIGRATION_12_SQL },
  { version: 13, name: "issue-project-moves", sql: MIGRATION_13_SQL },
  { version: 14, name: "compass-plan-membership", sql: MIGRATION_14_SQL },
  { version: 15, name: "sync-ledger", sql: MIGRATION_15_SQL },
];
const DSH_HOST_STATE_MIGRATION = MIGRATIONS.find((migration) => migration.name === "dsh-host-ledgers");

/**
 * Execution tables the migrated schema must carry — the executable form of
 * §2.2 after migration 9. Migration 4 created `execution_leases`; migration 9
 * removed it with the plan-PM seat, so it is deliberately absent here: a store
 * at the current version that still held it would be drift, not a state to
 * reinterpret.
 */
const EXECUTION_TABLE_NAMES = [
  "execution_meta",
  "execution_workflows",
  "execution_registry",
  "execution_plans",
  "execution_sessions",
  "execution_integration_leases",
  "execution_inputs",
  "execution_operations",
  "execution_migrations",
] as const;

/** The migration above, looked up so the schema check cannot desync from it. */
const EXECUTION_MIGRATION = MIGRATIONS.find((migration) => migration.name === "execution-authority");

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
 * Verify the applied set against the compiled migrations: contiguous version
 * ids from 1, nothing unknown or newer. Refuses before any mutation (contract
 * §2: unknown/newer → schema-unsupported, version gap → schema-drift,
 * malformed → corrupt). The recorded `name`/`checksum` columns are provenance
 * and are never compared — "same version id, different SQL" is a build
 * mismatch caught by CI, not a runtime gate.
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
      // The three facts are distinct and all belong in the refusal. The row's
      // own version is the FIRST the build cannot interpret; the store's schema
      // version is the highest row actually applied (a build that supports 1..7
      // reading a store at 9 meets version 8 first, so calling 8 "the store
      // version" understates the store by a whole generation); the build's
      // supported maximum is the highest COMPILED version, not the migration
      // count, which only coincides while the versions stay contiguous from 1.
      let highestApplied = 0;
      for (const candidate of applied) if (candidate.version > highestApplied) highestApplied = candidate.version;
      let supportedMax = 0;
      for (const migration of MIGRATIONS) if (migration.version > supportedMax) supportedMax = migration.version;
      throw new StoreError(
        "store.schema-unsupported",
        `The store's highest applied schema version is ${highestApplied}, this build supports versions 1..${supportedMax}, ` +
          `and the first unsupported migration is ${row.version}. ` +
          `Upgrade the harness to read this store; nothing was modified.`,
        { storeSchemaVersion: highestApplied, supportedSchemaMax: supportedMax, firstUnsupportedMigration: row.version },
      );
    }
    if (row.version !== i + 1) {
      throw new StoreError(
        "store.schema-drift",
        `Applied schema versions are not contiguous from 1 (found version ${row.version} at position ${i + 1}). ` +
          `The store is refused rather than migrated; nothing was modified.`,
      );
    }
    max = row.version;
  }
  return max;
}

/**
 * Apply pending migrations inside ONE exclusive write transaction, record
 * each version row only as it applies, normalize the retained business JSON the
 * newly applied version requires, verify the final set, and roll the whole
 * batch back on any failure — no dirty partial schema (contract §2).
 *
 * The normalization is not SQL: the members the removed protocol wrote live in
 * `execution_plans`/`execution_workflows` JSON, so a version that changes their
 * vocabulary declares it here and the pass runs in the SAME transaction as its
 * version row.
 */
function applyPendingMigrations(
  db: StoreDb,
  options: {
    alreadyInTransaction?: boolean; attestation?: MigrationContext["attestation"]; operator?: string;
    processFacts?: ProvisionProcessFacts; now?: () => string; busyTimeoutMs?: number;
  } = {},
): number {
  const own = !options.alreadyInTransaction;
  if (own) db.exec("begin immediate");
  try {
    // The applied set belongs to the transaction snapshot: another upgrader
    // may have completed while this connection waited for the writer slot.
    const prior = readAppliedMigrations(db, true);
    const priorMax = prior.length === 0 ? 0 : validateAppliedMigrations(prior);
    const pending = MIGRATIONS.filter((m) => m.version > priorMax);
    if (prior.length === 0) db.exec(SCHEMA_VERSION_TABLE_SQL);
    for (const migration of pending) {
      db.exec(migration.sql);
      if (migration.normalize !== undefined) {
        migration.normalize(db, {
          attestation: options.attestation, operator: options.operator, processFacts: options.processFacts, now: options.now,
        });
      }
      // A migration's temporary staging tables are the normalizer's input only:
      // they never survive the batch, so a rolled-back or committed store holds
      // exactly the version's declared schema.
      db.exec("drop table if exists execution_lease_cutover");
      db.exec("drop table if exists execution_session_cutover");
      db.exec("drop table if exists execution_integration_cutover");
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
        `Another writer held the store past the bounded wait (${busyTimeoutMs(options.busyTimeoutMs)}ms); the migration batch ` +
          `was rolled back and nothing was committed. Retry when the competing writer is done.`,
      );
    }
    // The generated-attestation signal (I-000297) is control flow, not a
    // corrupt store: it crosses the rollback wrapper untouched so the upgrade
    // entry can provision and retry the clean, rolled-back batch.
    if (error instanceof SettlementAttestationNeeded) throw error;
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

/** Selected harness directory; process callers resolve discovery before
 * constructing this context. FILE guards separately discover from targets. */
export type StoreContext = { harnessDir: string };

/**
 * Execution-domain authority state (primary spec §2.1). This is its own
 * namespace: `store_meta.authority_state` covers issue/catalog only, so an
 * active issue/catalog store is NOT an active execution authority.
 *
 * The execution authority is coordinator-only: migration 9 removed the
 * plan-PM session rows and the per-plan `execution_leases` table, so nothing
 * here reads or writes a second seat's identity or a per-plan claim.
 */
export type ExecutionAuthorityState = "legacy" | "staged" | "active";

/** The `execution_meta` singleton (id = 1) as read from a migrated store. */
export type ExecutionMeta = {
  protocolVersion: number;
  authorityState: ExecutionAuthorityState;
  revision: number;
  /** Imported root timestamp; the row-creation instant until a root is imported. */
  rootUpdatedAt: string;
  manifestId: string | null;
  activatedAt: string | null;
};

/** Names of the execution tables present in the store (one query, no DDL). */
function presentExecutionTables(db: StoreDb): string[] {
  const placeholders = EXECUTION_TABLE_NAMES.map(() => "?").join(", ");
  const rows = db
    .prepare(`select name from sqlite_master where type = 'table' and name in (${placeholders})`)
    .all(...EXECUTION_TABLE_NAMES) as Array<{ name?: unknown }>;
  return rows.map((row) => row.name).filter((name): name is string => typeof name === "string");
}

/**
 * Read the execution metadata singleton. The recorded migration history
 * decides whether this store HAS an execution schema at all: a store that
 * predates migration 4 has none (null) and opening a store never applies the
 * migration (contract §2). Once the migration is recorded, its whole table set
 * must exist and the singleton must be well formed — a recorded-but-incomplete
 * execution schema is drift to refuse, not a state to reinterpret.
 */
function readExecutionMeta(db: StoreDb, schemaVersion: number): ExecutionMeta | null {
  const expected = EXECUTION_MIGRATION?.version;
  if (expected === undefined || schemaVersion < expected) return null;
  const present = presentExecutionTables(db);
  const missing = EXECUTION_TABLE_NAMES.filter((name) => !present.includes(name));
  if (missing.length > 0) {
    throw new StoreError(
      "store.schema-drift",
      `Migration ${expected} (execution-authority) is recorded but its schema is incomplete: ` +
        `missing ${missing.join(", ")}. The store is refused rather than repaired; nothing was modified.`,
    );
  }
  const row = db
    .prepare(
      "select protocol_version, authority_state, revision, root_updated_at, manifest_id, activated_at " +
        "from execution_meta where id = 1",
    )
    .get() as
    | {
        protocol_version?: unknown;
        authority_state?: unknown;
        revision?: unknown;
        root_updated_at?: unknown;
        manifest_id?: unknown;
        activated_at?: unknown;
      }
    | undefined;
  if (
    !row ||
    typeof row.protocol_version !== "number" ||
    (row.authority_state !== "legacy" && row.authority_state !== "staged" && row.authority_state !== "active") ||
    typeof row.revision !== "number" ||
    typeof row.root_updated_at !== "string" ||
    (row.manifest_id !== null && row.manifest_id !== undefined && typeof row.manifest_id !== "string") ||
    (row.activated_at !== null && row.activated_at !== undefined && typeof row.activated_at !== "string")
  ) {
    throw new StoreError(
      "store.corrupt",
      "execution_meta is missing or malformed; the execution authority state cannot be verified",
    );
  }
  return {
    protocolVersion: row.protocol_version,
    authorityState: row.authority_state,
    revision: row.revision,
    rootUpdatedAt: row.root_updated_at,
    manifestId: (row.manifest_id as string | null | undefined) ?? null,
    activatedAt: (row.activated_at as string | null | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Protected file-route guards (primary spec §4.3)
// ---------------------------------------------------------------------------

/**
 * How an authority probe ended. The two arms ARE the discrimination primary
 * spec §2.1/§5 requires, so neither guard has to guess:
 *
 * - `state` — the path carries no store file to read (`state: null`, the
 *   never-initialized case: no `store.db`, a `store.db` whose applied schema
 *   predates the execution tables, or one that vanished between the existence
 *   check and the open) or it carries one that was read successfully
 *   (`state: "legacy" | "staged" | "active"`). The file route is a live route
 *   for everything except a KNOWN `active` authority.
 * - `unreadable` — a store file EXISTS at `dbPath` and could not be read as a
 *   database: it cannot be opened, an I/O error, or another writer held it
 *   past the bounded wait. This is never the legacy route: a store that exists
 *   and cannot be read is refused, never answered from leftover JSON (§2.1/§5:
 *   missing/busy/corrupt/schema-incompatible stores are refusals).
 *
 * Both arms are deliberately distinct from a CONTENT verdict (`store.corrupt`,
 * `store.schema-*`, `store.runtime-unsupported`), which is thrown out of the
 * probe: a store that is observable and broken can never be mistaken for a
 * legacy one.
 */
type ExecutionAuthorityProbe =
  | { kind: "active"; dbPath: string }
  | { kind: "absent"; dbPath: string }
  | { kind: "not-active"; dbPath: string; state: ExecutionAuthorityState | null }
  | { kind: "unreadable"; dbPath: string; error: unknown };

/** Driver codes a store file that exists but cannot be read reports:
 * SQLITE_CANTOPEN / SQLITE_IOERR. */
function isOpenLevelFailure(error: unknown): boolean {
  const err = error as { errcode?: unknown; message?: string };
  if (err?.errcode === 14 || err?.errcode === 10) return true;
  return /unable to open database file|disk I\/O error/i.test(String(err?.message ?? ""));
}

/**
 * Is this a failure the SAME-PROCESS writer-close window produces, rather than
 * a real store verdict? Bun 1.4.0's `node:sqlite` completes a closed handle's
 * cleanup — checkpoint, then removal of the now-empty `-wal`/`-shm` — when the
 * handle is COLLECTED, so a read-only open (or a read through it) can have its
 * sidecars deleted underneath it and report SQLITE_CANTOPEN for a store that is
 * entirely intact. The window is transient: once the deferred cleanup settles,
 * the same open converges.
 *
 * The discrimination reads the DRIVER's own structured fact on the raw error —
 * the numeric SQLITE error code (`errcode` 14 = SQLITE_CANTOPEN) — and never
 * the mapped refusal shape or the database path: a harness path that merely
 * contains the word "open" must not turn an ordinary content failure into a
 * retry, and a `store.corrupt` `StoreError` is never transient.
 *
 * Only that shape is transient, and only while the database FILE itself still
 * exists: a missing file is the caller's own `store.not-initialized` decision
 * (taken before this open) and a persistent CANTOPEN — a shape that never
 * becomes readable — keeps its existing refusal once the budget is spent. Every
 * non-CANTOPEN failure (BUSY, an I/O error, a content verdict) is never
 * retried, so no genuine refusal is deferred or weakened.
 */
function isRawCantOpen(error: unknown): boolean {
  return error !== null && typeof error === "object" && "errcode" in error && error.errcode === 14;
}

function isTransientReadOpenFailure(error: unknown, dbPath: string): boolean {
  if (error instanceof StoreError) return false;
  if (!isRawCantOpen(error)) return false;
  return existsSync(dbPath);
}

/** Bounded retry budget for a read open that meets a same-process writer's
 * deferred cleanup. Only reached after a transient CANTOPEN, so a healthy
 * store pays nothing for it. This is a deliberate bounded workaround for the
 * Bun 1.4.0 `node:sqlite` collection-timed cleanup defect: it removes once the
 * runtime quiesces a closed handle's sidecars at close. */
const READ_OPEN_ATTEMPTS = 5;
/** Delay before the next read-open attempt. The observed window closes on the
 * runtime's next collection, which the retry's own allocation and this yield
 * reach; the whole budget stays in the low tens of milliseconds. */
const READ_OPEN_BACKOFF_MS = 5;

/** The probe's reused read-only connection: the store file it belongs to. */
type ProbeConnection = { dbPath: string; dev: number; ino: number; db: StoreDb };

let probeConnection: ProbeConnection | null = null;

/** Drop the cached probe connection (it is never reused after a failure). */
function dropProbeConnection(): void {
  const current = probeConnection;
  probeConnection = null;
  if (current === null) return;
  try {
    current.db.close();
  } catch {
    // already closed by the failing call — nothing to release here
  }
}

/**
 * The probe's connection for `dbPath`, opened lazily and reused while it is the
 * SAME store file (device + inode). Reuse is a correctness/robustness
 * requirement here, not an optimisation: `node:sqlite` keeps one file
 * descriptor per connection until the connection object is collected (measured
 * on Bun 1.4.0: 8 open/close cycles → 8 descriptors, all released only by GC),
 * so opening a connection per guard call exhausts the descriptor table of a
 * long-lived process and turns every later store open into a spurious
 * `SQLITE_CANTOPEN`. A changed store identity (a new store, an atomic
 * replacement, a restore) closes and reopens — and the authority itself is
 * re-read through the connection on every probe, so no verdict is ever cached.
 */
function probeConnectionFor(dbPath: string): StoreDb | null {
  let dev: number;
  let ino: number;
  try {
    const stats = statSync(dbPath);
    dev = stats.dev;
    ino = stats.ino;
  } catch {
    // The store vanished between `existsSync` and here: no authority to read.
    dropProbeConnection();
    return null;
  }
  const cached = probeConnection;
  if (cached !== null && cached.dbPath === dbPath && cached.dev === dev && cached.ino === ino) return cached.db;
  dropProbeConnection();
  const db = openConnection(dbPath, "read", loadSqliteDriverSync().DatabaseSync);
  probeConnection = { dbPath, dev, ino, db };
  return db;
}


/**
 * The execution authority state at the caller's selected database path,
 * `{kind: "state", state: null}` when no store exists there, and
 * `{kind: "unreadable"}` when a store file exists there but cannot be read. It
 * shares the runtime (`assertStoreRuntimeSupported`),
 * schema (`readAppliedMigrations` / `validateAppliedMigrations`) and metadata
 * (`readStoreMeta` / `readExecutionMeta`) checks with `openStore`, and opens
 * the SAME `node:sqlite` driver read-only through the synchronous loader.
 *
 * The existence check below is the discrimination the guards act on, taken
 * BEFORE anything else in this function, and it runs on the final path WITHOUT
 * following a link: only a path with no store file can answer `state: null`
 * without having read a store, so a dangling symlink or other non-regular final
 * path refuses `store.corrupt` first and can never reopen the retired file
 * route. A store file that EXISTS
 * and fails to open (SQLITE_CANTOPEN / an I/O error) or that another writer
 * holds past the bounded wait answers `unreadable` — never "no authority", so
 * neither guard can fall back to the retired file route for a store that is
 * there but unreadable. A path whose file vanishes between the existence check
 * and the open is the never-initialized case again (there is nothing to read).
 *
 * A store that exists and is OBSERVABLE but broken throws out of here
 * (`store.corrupt` / `store.schema-*` / `store.runtime-unsupported`), so no
 * caller can mistake a broken store for `legacy`. Per primary spec §2.1 an
 * unbound legacy entry cannot prove historical activation after the whole
 * database is removed, so absence is not an authority verdict either (the
 * durable installed binding that closes this is an explicit 2b obligation).
 */
function probeExecutionAuthority(dbPath: string): ExecutionAuthorityProbe {
  // The same no-link discrimination the open makes: a dangling symlink or other
  // non-regular final path is an existing store that cannot be read, never "no
  // store", so the retired file route cannot answer for it.
  assertAbsentOrRegularStoreFile(dbPath);
  if (!existsSync(dbPath)) {
    dropProbeConnection();
    return { kind: "absent", dbPath };
  }
  assertStoreRuntimeSupported();
  let db: StoreDb | null;
  try {
    db = probeConnectionFor(dbPath);
  } catch (error) {
    dropProbeConnection();
    if (isOpenLevelFailure(error) || isBusyError(error)) return { kind: "unreadable", dbPath, error };
    return refuseOpenFailure(error, dbPath);
  }
  if (db === null) return { kind: "absent", dbPath };
  try {
    const schemaVersion = validateAppliedMigrations(readAppliedMigrations(db, false));
    readStoreMeta(db);
    const state = readExecutionMeta(db, schemaVersion)?.authorityState ?? null;
    return state === "active" ? { kind: "active", dbPath } : { kind: "not-active", dbPath, state };
  } catch (error) {
    // A failed read leaves the connection's state unknown: never reuse it.
    dropProbeConnection();
    if (isOpenLevelFailure(error) || isBusyError(error)) return { kind: "unreadable", dbPath, error };
    return refuseOpenFailure(error, dbPath);
  }
}

/**
 * Execute a synchronous read-only callback against the current execution
 * authority. This is the guard used immediately before file-native commits:
 * it reuses the probe's inode-stable read connection and never opens a second
 * asynchronous driver path.
 */
export function withExecutionReadGuard<T>(
  context: StoreContext,
  body: (db: StoreDb, authority: { storeId: string; epoch: number }) => T,
): T {
  const probe = probeExecutionAuthority(storeDbPath(context));
  if (probe.kind === "absent") {
    throw new StoreError("store.not-initialized", "No execution store exists. Run \"mstar harness scaffold\" then \"mstar store init\"; for legacy state run \"mstar store upgrade\".");
  }
  if (probe.kind === "unreadable") refuseOpenFailure(probe.error, probe.dbPath);
  if (probe.kind !== "active") {
    const recovery = probe.state === "staged"
      ? 'Run "mstar store activate --manifest <migration.json> --operator <name>" to finish the reviewed activation.'
      : 'Run "mstar store upgrade" to import legacy state and activate the authority.';
    throw new StoreError("store.not-active", `The execution authority is ${probe.state ?? "missing"}. ${recovery}`);
  }
  const db = probeConnectionFor(probe.dbPath);
  if (db === null) {
    throw new StoreError("store.not-initialized", "The execution store disappeared before the read-only assertion.");
  }
  const store = db.prepare("select store_id, authority_epoch from store_meta where id = 1").get() as
    | { store_id?: unknown; authority_epoch?: unknown }
    | undefined;
  const execution = db.prepare("select authority_state from execution_meta where id = 1").get() as
    | { authority_state?: unknown }
    | undefined;
  if (
    store === undefined ||
    typeof store.store_id !== "string" ||
    typeof store.authority_epoch !== "number" ||
    execution?.authority_state !== "active"
  ) {
    throw new StoreError("store.corrupt", "The active execution authority metadata is missing or malformed.");
  }
  return body(db, { storeId: store.store_id, epoch: store.authority_epoch });
}
const dshTransactions = new Set<string>();
export type DshSelectedGeneration = { storeId: string; epoch: number };
export type DshWriteTransaction = { db: StoreDb; storeId: string; epoch: number; markChanged(): void };

/** Engine-private synchronous transaction used only by typed host-state verbs. */
export function withDshWriteTransaction<T>(
  context: StoreContext,
  body: (tx: DshWriteTransaction) => T,
  selectedGeneration?: DshSelectedGeneration,
): T {
  const dbPath = storeDbPath(context);
  if (dshTransactions.has(dbPath)) {
    throw new StoreError("store.corrupt", "A nested host-state transaction is not permitted.");
  }
  assertStoreRuntimeSupported();
  assertAbsentOrRegularStoreFile(dbPath);
  if (!existsSync(dbPath)) {
    throw new StoreError(
      "store.not-initialized",
      `No execution store exists at ${dbPath}. Run "mstar harness scaffold" and "mstar store init", or ` +
        `"mstar store upgrade --harness ${JSON.stringify(resolve(context.harnessDir))} --operator <name>" ` +
        "when legacy state must be imported; nothing was written.",
    );
  }
  dshTransactions.add(dbPath);
  let db: StoreDb | undefined;
  try {
    db = openConnection(dbPath, "write", loadSqliteDriverSync().DatabaseSync);
    let schemaVersion = validateAppliedMigrations(readAppliedMigrations(db, false));
    const requiredVersion = DSH_HOST_STATE_MIGRATION?.version;
    if (requiredVersion === undefined || schemaVersion < requiredVersion) {
      throw new StoreError(
        "store.schema-drift",
        `The execution store predates dsh-host-ledgers. Run "mstar store upgrade" before host-state persistence; nothing was written.`,
      );
    }
    const initial = readStoreMeta(db);
    const execution = readExecutionMeta(db, schemaVersion);
    if (!execution || execution.authorityState !== "active") {
      const recovery = execution?.authorityState === "staged"
        ? 'Run "mstar store activate --manifest <migration.json> --operator <name>" to finish the reviewed activation.'
        : `Run "mstar store upgrade --harness ${JSON.stringify(resolve(context.harnessDir))} --operator <name>" to import legacy state and activate the authority.`;
      throw new StoreError("store.not-active", `The execution authority is ${execution?.authorityState ?? "missing"}. ${recovery} Nothing was written.`);
    }
    db.exec("begin immediate");
    try {
      schemaVersion = validateAppliedMigrations(readAppliedMigrations(db, false));
      if (schemaVersion < requiredVersion) {
        throw new StoreError("store.schema-drift", "The execution store predates dsh-host-ledgers; run mstar store upgrade.");
      }
      const current = readStoreMeta(db);
      const currentExecution = readExecutionMeta(db, schemaVersion);
      if (!currentExecution || currentExecution.authorityState !== "active") {
        const recovery = currentExecution?.authorityState === "staged"
          ? 'Run "mstar store activate --manifest <migration.json> --operator <name>" to finish the reviewed activation.'
          : `Run "mstar store upgrade --harness ${JSON.stringify(resolve(context.harnessDir))} --operator <name>" to import legacy state and activate the authority.`;
        throw new StoreError("store.not-active", `The execution authority is ${currentExecution?.authorityState ?? "missing"}. ${recovery} Nothing was written.`);
      }
      if (
        current.storeId !== initial.storeId ||
        current.epoch !== initial.epoch ||
        (selectedGeneration !== undefined &&
          (current.storeId !== selectedGeneration.storeId || current.epoch !== selectedGeneration.epoch))
      ) {
        throw new StoreError("store.stale-epoch", "The selected store identity or epoch changed; resolve the current authority and retry.");
      }
      let changed = false;
      const result = body({ db, storeId: current.storeId, epoch: current.epoch, markChanged: () => { changed = true; } });
      if (typeof (result as { then?: unknown } | null)?.then === "function") {
        throw new StoreError("store.corrupt", "A host-state transaction body must be synchronous.");
      }
      if (changed) db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
      db.exec("commit");
      return result;
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
        // Transaction may already have been closed by the driver.
      }
      throw error;
    }
  } finally {
    try {
      db?.close();
    } finally {
      dshTransactions.delete(dbPath);
    }
  }
}

export type StoreHandle = {
  db: StoreDb;
  storeId: string;
  epoch: number;
  schemaVersion: number;
  /** Execution authority metadata; null while the store predates migration 4. */
  execution: ExecutionMeta | null;
  close(): void;
};

/**
 * Open an existing store for reading or writing. Creates no store: a missing
 * database is a `store.not-initialized` refusal — and "missing" is decided on
 * the final path without following a link, so a dangling symlink or any other
 * non-regular file is an existing-but-unreadable store and refuses
 * `store.corrupt` instead, never answering as an absent store. The final path
 * must also be a regular file at the store's own canonical path — a link target
 * outside the resolved control root is never followed. Readers open with the
 * read-only option plus `query_only=ON`; a WAL store whose journal SQLite's own
 * clean close removed gets that empty `-wal` back beside it before the open
 * (`ensureJournalForRead`), because a read-only connection cannot create the
 * journal it needs to read a WAL database. The schema and store identity are
 * verified on every request; drift/newer/corrupt refuses before mutation.
 *
 * A READ open is retried on a bounded budget when the store file itself still
 * exists and the raw driver error carries SQLITE_CANTOPEN (`errcode` 14), the
 * transient shape a same-process writer-close window produces
 * (`isTransientReadOpenFailure`). Each attempt re-runs the existing journal
 * preparation and the whole content verification, so a settled store converges
 * and nothing else changes: a persistent failure still refuses with the same
 * code and message the single-shot open produced.
 */
export async function openStore(
  context: StoreContext,
  mode: "read" | "write",
  options: { busyTimeoutMs?: number } = {},
): Promise<StoreHandle> {
  assertStoreRuntimeSupported();
  const dbPath = storeDbPath(context);
  // One normalisation for this whole open: the pragma's wait, the refusal text
  // and every wrapped-write refusal below all report THIS number.
  const timeout = busyTimeoutMs(options.busyTimeoutMs);
  // The existence discrimination runs on the final path WITHOUT following a
  // link: a dangling symlink or any other non-regular file is an existing store
  // that cannot be read — `store.corrupt`, never "no store" — so neither this
  // open nor the retired file route can answer from a link target.
  assertAbsentOrRegularStoreFile(dbPath);
  if (!existsSync(dbPath)) {
    throw new StoreError(
      "store.not-initialized",
      `No execution store exists at ${dbPath}, and the pre-activation file route is retired. For a genuinely ` +
        `empty workspace, run "mstar harness scaffold" then "mstar store init" to create and activate the store; ` +
        `for a workspace holding historical file state, run ` +
        `"mstar store upgrade --harness ${JSON.stringify(resolve(context.harnessDir))} --operator <name>" to ` +
        `import it and activate the store. Nothing was created.`,
    );
  }
  const attempts = mode === "read" ? READ_OPEN_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await openStoreOnce(dbPath, mode, timeout);
    } catch (error) {
      if (attempt >= attempts || !isTransientReadOpenFailure(error, dbPath)) {
        refuseOpenFailure(error, dbPath, timeout);
      }
      await sleep(READ_OPEN_BACKOFF_MS);
    }
  }
}

/** One open attempt: connect, then verify the schema and store identity on the
 * same connection. `openConnection` preserves eligible raw read CANTOPEN errors
 * from setup so the caller can retry them; the CONTENT stage rethrows the
 * driver's own error so a read-open CANTOPEN remains distinguishable from a
 * real content verdict. This caller owns retrying the former and mapping either. */
async function openStoreOnce(dbPath: string, mode: "read" | "write", timeout: number): Promise<StoreHandle> {
  let db: StoreDb;
  try {
    db = await connect(dbPath, mode, timeout);
  } catch (error) {
    if (mode === "read" && isRawCantOpen(error)) throw error;
    refuseOpenFailure(error, dbPath, timeout);
  }
  try {
    const schemaVersion = validateAppliedMigrations(readAppliedMigrations(db, false));
    const meta = readStoreMeta(db);
    return {
      db,
      storeId: meta.storeId,
      epoch: meta.epoch,
      schemaVersion,
      execution: readExecutionMeta(db, schemaVersion),
      close(): void {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Remove only the staging files one initialization attempt created for itself.
 * The canonical store path is never in this list: a failed or interrupted
 * create cannot unlink the store another process may already have published or
 * be reading, and a stale staging file is inert scratch that no code reads.
 */
function removeStagingFiles(stagingPath: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      unlinkSync(stagingPath + suffix);
    } catch {
      // best-effort cleanup of this attempt's own staging name
    }
  }
}

/** The operating system's own classification of a failed step, preserved
 * verbatim so the operator diagnoses the filesystem, not a store. */
function publicationCause(error: unknown): string {
  const causeCode =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : String(error);
  return causeCode === "" || message.includes(causeCode) ? message : `${causeCode}: ${message}`;
}

/**
 * The refusal for a creation step that failed BEFORE any store existed at the
 * canonical path: the real cause is preserved, the absence of a published
 * store is stated (a canonical path is never called corrupt here — none was
 * ever created), and the recovery is the same public entry once the filesystem
 * condition is resolved, or a harness on a hard-link-capable filesystem
 * selected through the existing `--harness` argument.
 */
function publicationRefusal(step: string, error: unknown, dbPath: string): StoreError {
  const cause = publicationCause(error);
  return new StoreError(
    "store.publication-failed",
    `The fresh store could not be ${step}: ${cause}. NO store was published at ${dbPath} \u2014 the canonical path ` +
      `holds no store and nothing was written to it. Resolve the filesystem condition named above (permissions, ` +
      `space, hard-link support) and rerun the same command, or select a harness on a filesystem that supports ` +
      `atomic hard links with --harness.`,
    { path: dbPath, cause },
  );
}

/**
 * Make the canonical store's own DIRECTORY ENTRY durable. SQLite fsyncs the
 * bytes it writes, but the create-only hard link that PUBLISHES those bytes is
 * an application-created directory entry that no transaction makes durable:
 * until the containing directory is synchronized, a power loss can leave the
 * control root with no `store.db` at all — and, once the only other name for
 * that inode is gone, with no fallback name either. Atomicity is not
 * durability. The same primitive the repo's other durable writers use
 * (`execution-ledgers.ts` `fsyncDirectory`); nothing here is a new protocol.
 *
 * Where the platform refuses to open or synchronize a directory (Windows does,
 * for one), the operating system's own error is preserved and disclosed as the
 * failed barrier — never swallowed into a durable success claim.
 */
function syncDirectoryEntry(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The PARTIAL outcome of a creation or upgrade whose canonical store IS
 * published and retained, but whose directory entry could not be made durable
 * — or confirmed durable. It never reports a clean success, never calls the
 * store corrupt and never removes it: the real barrier cause is preserved, only
 * the facts this boundary actually established are stated, and the ordinary
 * public `store upgrade` on that same published path is the supported retry for
 * the barrier — `store init` stays create-only.
 */
function publicationBarrierRefusal(error: unknown, dbPath: string, phase: "creation" | "upgrade"): StoreError {
  const cause = publicationCause(error);
  // Creation reaches this boundary only after its own transaction committed the
  // ACTIVE flip, so THAT phase may state it. An existing-store upgrade stops at
  // its schema/verification boundary: the caller's import and activation have
  // NOT run, so this diagnostic reports only what actually happened here and
  // never claims an authority state or completed work it did not establish.
  const state =
    phase === "creation"
      ? `The store at ${dbPath} is complete and ACTIVE and was neither rolled back nor removed; this attempt's own ` +
        `staging name is retained beside it as a fallback reference to those same bytes. `
      : `The canonical store at ${dbPath} is retained and readable with the schema state this call committed or ` +
        `verified, and it was neither rolled back nor removed. This call performed no import or activation, so the ` +
        `store's recorded authority state is unchanged. `;
  return new StoreError(
    "store.publication-barrier-failed",
    state +
      `The synchronization of its containing directory entry failed (${cause}), so that name is not CONFIRMED ` +
      `durable: a power loss before the next successful barrier could lose it. Directory synchronization ` +
      `(open + fsync) is a platform/filesystem capability, and this one refused with the cause above. Retry the ` +
      `ordinary public upgrade on the same published path to re-attempt the barrier once the condition clears: ` +
      `"mstar store upgrade --harness <control root> --operator <name>".`,
    { path: dbPath, published: true, barrier: phase, cause },
  );
}

/**
 * Create-only initialization for a genuinely empty workspace (contract §2).
 *
 * The complete store — every migration, the shared metadata and the ACTIVE
 * epoch-1 authority flip in ONE transaction — is built in a private staging
 * file beside the canonical path and only then PUBLISHED there with a single
 * create-only hard link. The canonical path therefore never names a
 * half-built store: it is either absent, or a complete, committed,
 * self-contained database. That removes the first-creator window an upgrade
 * observer could previously read (`store.corrupt` on a claimed-but-unmigrated
 * file) without a lock, a mutex or any polling — the publish itself is the
 * one atomic step, and it is also the whole existence check: a competing
 * initializer's store, a pre-existing file, a link or a directory all refuse
 * `store.already-exists` there (EEXIST) and are not read or rewritten. Only
 * this attempt's own staging name is ever removed, so a failed create cannot
 * delete the store another process already published.
 *
 * Failure outcomes are named at their actual phase. Before publication,
 * `store.publication-failed` preserves the operating system's own cause and
 * states that NO store exists at the canonical path — which is never called
 * corrupt, because none was created. After the link, a failed DIRECTORY
 * SYNCHRONIZATION reports `store.publication-barrier-failed`: the store is
 * published and complete but its name is not confirmed durable, so the
 * attempt's staging name is RETAINED as the fallback reference to those bytes
 * and the ordinary public upgrade on that same path re-attempts the barrier.
 * After a successful barrier, a failed handle acquisition reports
 * `store.created-handle-failed`: the PARTIAL outcome that it is — the store is
 * created, activated and retained — with the real cause and the supported
 * same-entry continuation.
 */
export async function initializeStore(
  context: StoreContext,
  options: {
    attestation?: unknown; operator?: string; processFacts?: ProvisionProcessFacts; now?: () => string;
    busyTimeoutMs?: number; afterStagingClaim?: () => void;
    /**
     * INTERNAL to the upgrade pair (`upgradeStoreMinimal`): let the settlement
     * marker cross this boundary so that caller can generate the document and
     * retry. Every other caller gets the named refusal instead of the marker.
     */
    raiseSettlementSignal?: boolean;
  } = {},
): Promise<StoreHandle> {
  assertStoreRuntimeSupported();
  // The operator's stop evidence is validated by the existing activation
  // validator before any file is created: a thin or malformed document is never
  // accepted as authority for a cutover.
  const attestation = options.attestation === undefined ? undefined : await validatedActivationAttestation(options.attestation);
  const timeout = busyTimeoutMs(options.busyTimeoutMs);
  const dbPath = storeDbPath(context);
  const alreadyExists = (): StoreError =>
    new StoreError(
      "store.already-exists",
      `An issue store already exists at ${dbPath}. "store init" is create-only and must not reuse ` +
        `store.not-initialized for an existing store; use the upgrade path for schema changes. Nothing was modified.`,
    );
  // The driver is acquired before anything is created, so a runtime that
  // cannot run SQLite refuses without leaving a file behind.
  await loadSqliteDriver();
  // A fast pre-check only — the create-only decision itself is the publish
  // below, where EEXIST is the atomic arbiter even when this observation has
  // already gone stale.
  if (existsSync(dbPath)) throw alreadyExists();
  // Private staging name in the SAME directory (a hard link cannot cross a
  // filesystem boundary), unique per attempt so two initializers never stage
  // into one file. It never matches the store's own name, `*.db` or any of the
  // retired lock names.
  const stagingPath = join(dirname(dbPath), `.${basename(dbPath)}.init-${process.pid}-${randomUUID()}.tmp`);
  let claim: number;
  try {
    claim = openSync(stagingPath, "wx");
  } catch (error) {
    throw publicationRefusal("created in the control root's own directory", error, dbPath);
  }
  closeSync(claim);
  let db: StoreDb | undefined;
  try {
    db = await connect(stagingPath, "write", timeout);
    // Test-owned injection at the staging claim: the hook runs inside this try
    // so a throw leaves the same cleanup path a real post-claim failure takes.
    options.afterStagingClaim?.();
    db.exec("begin immediate");
    try {
      applyPendingMigrations(db, {
        alreadyInTransaction: true, attestation, operator: options.operator, processFacts: options.processFacts,
        now: options.now, busyTimeoutMs: timeout,
      });
      db.prepare("update store_meta set authority_state = 'active', activated_at = ? where id = 1").run(nowRfc3339());
      db.prepare("update execution_meta set authority_state = 'active', activated_at = ? where id = 1").run(nowRfc3339());
      db.exec("commit");
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
        // nothing committed either way
      }
      throw error instanceof SettlementAttestationNeeded && options.raiseSettlementSignal !== true
        ? settlementSignalRefusal(error)
        : error;
    }
    // The staged bytes are verified as this build's own complete store before
    // they can be named.
    readStoreMeta(db);
    readExecutionMeta(db, MIGRATIONS.length);
    // A hard link names one inode, not a journal: a WAL store's committed state
    // lives in its `-wal` beside it, and the staging file is about to be read
    // under a SECOND name. Fold the journal back into the database file and
    // return to rollback-journal mode, so the published name carries every
    // committed frame with no sidecar beside it — the first ordinary writer
    // open converts the published store back to WAL through the usual pragma
    // path, and a read-only open needs no journal at all.
    const folded = db.prepare("pragma journal_mode=delete").get() as { journal_mode?: string } | undefined;
    if (folded?.journal_mode !== "delete") {
      throw new StoreError(
        "store.publication-failed",
        `The staged store could not be folded into one self-contained database file before publication ` +
          `(journal mode is ${String(folded?.journal_mode ?? "unknown")}, not "delete"). NO store was published at ` +
          `${dbPath} \u2014 the canonical path holds no store and nothing was written to it. Rerun the same command; if ` +
          `it recurs, select a harness on a filesystem that supports atomic hard links with --harness.`,
        { path: dbPath, cause: `journal mode ${String(folded?.journal_mode ?? "unknown")} after fold` },
      );
    }
    db.close();
    db = undefined;
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // connection-level failure; the staging name is unlinked below
      }
    }
    removeStagingFiles(stagingPath);
    throw error;
  }
  // Publish: the atomic create-only step. EEXIST is a competing initializer's
  // committed store (or a pre-existing file) — refuse it untouched. Any other
  // failure is a filesystem/publication condition, never store corruption: no
  // canonical store exists to be corrupted.
  try {
    linkSync(stagingPath, dbPath);
  } catch (error) {
    removeStagingFiles(stagingPath);
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw alreadyExists();
    }
    throw publicationRefusal("linked into place at its canonical path", error, dbPath);
  }
  // Publish the canonical DIRECTORY ENTRY before removing the only other name
  // for this inode: if the barrier fails, the staging name is the fallback
  // reference to the same bytes and stays, and the outcome is disclosed as the
  // partial one it is — the store exists and is complete, so it is never removed
  // and never called corrupt.
  try {
    syncDirectoryEntry(dirname(dbPath));
  } catch (error) {
    throw publicationBarrierRefusal(error, dbPath, "creation");
  }
  removeStagingFiles(stagingPath);
  // The store is now committed, complete, ACTIVE and durable at the canonical
  // path. If this attempt cannot acquire its returned handle, that is a PARTIAL
  // outcome and must be disclosed as one: the published image is kept — never
  // unlinked, never reported as if nothing was created — and the caller is
  // pointed at the supported continuation for its entry.
  try {
    return await openStore(context, "write", { busyTimeoutMs: timeout });
  } catch (error) {
    const cause = publicationCause(error);
    const causeCode = error instanceof StoreError ? error.code : "";
    throw new StoreError(
      "store.created-handle-failed",
      `The store was created, activated and published at ${dbPath}, but this attempt could not open its handle ` +
        `afterwards (${cause}). The published store is complete and was NOT modified, rolled back or removed. ` +
        `Rerunning "mstar store init" here refuses create-only. Retry this command once the condition clears, and ` +
        `for an interrupted upgrade continue the import into the published store with ` +
        `"mstar store upgrade --harness <control root> --operator <name>".`,
      { path: dbPath, published: true, cause, causeCode },
    );
  }
}

/**
 * Apply pending migrations to an existing store. The caller is responsible
 * for a SQLite-consistent backup and quiesced writers (contract §2/§7) —
 * this function itself is atomic: the whole pending batch commits or rolls
 * back together. Idempotent when the store is already current.
 *
 * Observer guarantee: creation publishes the canonical path in ONE atomic
 * create-only step (`initializeStore`), so a path that exists here always
 * names a complete, committed store. A store file that exists but records no
 * migration history is therefore genuine corruption — never an in-flight
 * first creation to wait out or reinterpret — and still refuses
 * `store.corrupt` untouched.
 */
export async function upgradeStore(
  context: StoreContext,
  options: {
    attestation?: unknown; operator?: string; processFacts?: ProvisionProcessFacts; now?: () => string;
    /** INTERNAL to the upgrade pair — see `initializeStore`'s identical option. */
    raiseSettlementSignal?: boolean;
  } = {},
): Promise<{ schemaVersion: number }> {
  assertStoreRuntimeSupported();
  const dbPath = storeDbPath(context);
  if (!existsSync(dbPath)) {
    throw new StoreError(
      "store.not-initialized",
      `No issue store exists at ${dbPath}; there is nothing to upgrade. Run "mstar store init" for a ` +
        `genuinely empty workspace. Nothing was created.`,
    );
  }
  // The operator's stop evidence is validated by the existing activation
  // validator before the schema is touched: a thin or malformed document is
  // never accepted as authority for a cutover.
  const attestation = options.attestation === undefined ? undefined : await validatedActivationAttestation(options.attestation);
  let db: StoreDb;
  try {
    db = await connect(dbPath, "write");
  } catch (error) {
    refuseOpenFailure(error, dbPath);
  }
  let schemaVersion: number;
  try {
    schemaVersion = applyPendingMigrations(db, {
      attestation, operator: options.operator, processFacts: options.processFacts, now: options.now,
    });
    readStoreMeta(db);
    // The migration is atomic, so an upgraded store must carry the complete
    // execution schema; a recorded-but-incomplete one is drift, not progress.
    readExecutionMeta(db, schemaVersion);
  } catch (error) {
    // The generated-attestation signal is control flow, not an open failure;
    // the finally block owns the close. A DIRECT caller never sees the marker:
    // only the upgrade pair opts in, and everyone else gets the named refusal.
    if (error instanceof SettlementAttestationNeeded) {
      throw options.raiseSettlementSignal === true ? error : settlementSignalRefusal(error);
    }
    refuseOpenFailure(error, dbPath);
  } finally {
    db.close();
  }
  // The same public entry is also the supported retry for the directory barrier
  // a creation or an earlier upgrade could not complete: the published store
  // already exists at this path, so this attempt re-synchronizes its containing
  // directory entry. It runs on the CLOSED handle and strictly AFTER the content
  // checks above, so an unverifiable store syncs nothing and the barrier's own
  // failure is its own refusal — never `store.corrupt`, never a lost commit.
  try {
    syncDirectoryEntry(dirname(dbPath));
  } catch (error) {
    throw publicationBarrierRefusal(error, dbPath, "upgrade");
  }
  return { schemaVersion };
}
