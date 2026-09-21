/**
 * store-db.ts — issue-store runtime boundary, connection lifecycle and the
 * checksum-verified migration framework.
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
import { closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
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
  | "store.busy"
  // The file-route guards below refuse through this boundary too: the control
  // harness's ACTIVE execution authority retires the root/snapshot/session file
  // route (primary spec §4.3), and that refusal is a store-authority verdict —
  // not a `coordination.*` scoped-writer refusal and not a payload error.
  | "execution.direct-write-refused"
  | "execution.consumer-not-ready";

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

/**
 * The SAME driver through the runtime's synchronous module loader
 * (`createRequire`) — the only acquisition path a synchronous guard may use
 * (primary spec §4.3: no promise-returning guard). A static `import` cannot
 * stand in here: it is asynchronous by definition and would make every
 * synchronous file writer an unawaited async guard. Acquisition stays lazy — it
 * is reached only by a probe that already found a store on disk, so importing
 * this module still neither loads the driver nor opens a database.
 */
const requireDriver = createRequire(import.meta.url);

function loadSqliteDriverSync(): SqliteModule {
  try {
    const mod = requireDriver("node:sqlite") as Partial<SqliteModule>;
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
async function connect(dbPath: string, mode: "read" | "write"): Promise<StoreDb> {
  const { DatabaseSync } = await loadSqliteDriver();
  return openConnection(dbPath, mode, DatabaseSync);
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
): StoreDb {
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

export type Migration = { version: number; name: string; sql: string };

/** Ordered immutable migrations. Never mutate an applied entry — append only. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "issue-core", sql: MIGRATION_1_SQL },
  { version: 2, name: "catalog-authority", sql: MIGRATION_2_SQL },
  { version: 3, name: "execution-projections", sql: MIGRATION_3_SQL },
  { version: 4, name: "execution-authority", sql: MIGRATION_4_SQL },
];

/** Execution tables created by migration 4 — the executable form of §2.2. */
const EXECUTION_TABLE_NAMES = [
  "execution_meta",
  "execution_workflows",
  "execution_registry",
  "execution_plans",
  "execution_sessions",
  "execution_leases",
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

/**
 * Execution-domain authority state (primary spec §2.1). This is its own
 * namespace: `store_meta.authority_state` covers issue/catalog only, so an
 * active issue/catalog store is NOT an active execution authority.
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
  | { kind: "state"; dbPath: string; state: ExecutionAuthorityState | null }
  | { kind: "unreadable"; dbPath: string; error: unknown };

/** Driver codes a store file that exists but cannot be read reports:
 * SQLITE_CANTOPEN / SQLITE_IOERR. */
function isOpenLevelFailure(error: unknown): boolean {
  const err = error as { errcode?: unknown; message?: string };
  if (err?.errcode === 14 || err?.errcode === 10) return true;
  return /unable to open database file|disk I\/O error/i.test(String(err?.message ?? ""));
}

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
 * The execution authority state of the control harness that owns `context`'s
 * path, `{kind: "state", state: null}` when no store exists there, and
 * `{kind: "unreadable"}` when a store file exists there but cannot be read. It
 * shares the path (`storeDbPath`), runtime (`assertStoreRuntimeSupported`),
 * schema (`readAppliedMigrations` / `validateAppliedMigrations`) and metadata
 * (`readStoreMeta` / `readExecutionMeta`) checks with `openStore`, and opens
 * the SAME `node:sqlite` driver read-only through the synchronous loader.
 *
 * The existence check below is the discrimination the guards act on, taken
 * BEFORE anything else in this function: only a path with no store file can
 * answer `state: null` without having read a store. A store file that EXISTS
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
function probeExecutionAuthority(context: StoreContext): ExecutionAuthorityProbe {
  const dbPath = storeDbPath(context);
  if (!existsSync(dbPath)) {
    dropProbeConnection();
    return { kind: "state", dbPath, state: null };
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
  if (db === null) return { kind: "state", dbPath, state: null };
  try {
    const schemaVersion = validateAppliedMigrations(readAppliedMigrations(db, false));
    readStoreMeta(db);
    return { kind: "state", dbPath, state: readExecutionMeta(db, schemaVersion)?.authorityState ?? null };
  } catch (error) {
    // A failed read leaves the connection's state unknown: never reuse it.
    dropProbeConnection();
    if (isOpenLevelFailure(error) || isBusyError(error)) return { kind: "unreadable", dbPath, error };
    return refuseOpenFailure(error, dbPath);
  }
}

/**
 * Refuse a protected file write while the control harness's execution authority
 * is ACTIVE. Root status, workflow snapshots and session envelopes are no
 * longer a persistence route, so persisting them — even from inside the
 * authorized protected-write context, through an injected `ArtifactStore`, or
 * with a valid byte token — would create a second authority.
 *
 * Synchronous by contract (primary spec §4.3): its callers are synchronous file
 * writers, so the probe above must never become an unawaited async guard, and
 * the authority verdict precedes payload validation at every call site.
 *
 * A store file that EXISTS and cannot be read is a refusal here too (primary
 * spec §5: no protected mutation while the authority cannot be established) —
 * never a fall back to the retired file route. Only a path with no store file
 * at all keeps the legacy route (there is no authority to establish).
 */
export function assertExecutionFileWriteAllowed(context: StoreContext): void {
  const probe = probeExecutionAuthority(context);
  if (probe.kind === "unreadable") refuseOpenFailure(probe.error, probe.dbPath);
  if (probe.state !== "active") return;
  throw new StoreError(
    "execution.direct-write-refused",
    `The execution authority of ${probe.dbPath} is ACTIVE \u2014 root, workflow-snapshot and ` +
      `session-envelope files are retired as a persistence route. Nothing was written: use the execution ` +
      `DB route (the coordination/registration APIs against the active store), not a file writer.`,
  );
}

/**
 * Refuse a legacy root/snapshot authority READ while the control harness's
 * execution authority is ACTIVE. The bytes may still sit on disk (migration
 * keeps its own explicit byte-witness readers), but no domain reader may
 * present them as authoritative success: a consumer that needs execution state
 * reads it through the DB adapter instead.
 *
 * Synchronous by contract (primary spec §4.3): legacy authority readers are
 * synchronous, and they share the write guard's lazy probe.
 *
 * Disposition, in the two cases the probe distinguishes (§2.1/§5):
 *
 * - a store file EXISTS at the probed path and cannot be read (`unreadable`:
 *   SQLITE_CANTOPEN / an I/O error / another writer past the bounded wait) →
 *   REFUSED with the store's own reader refusal (`store.corrupt` / `store.busy`,
 *   the same mapping `openStore(…, "read")` produces). Serving leftover JSON
 *   there would be exactly the forbidden fallback: bytes that cannot be
 *   checked against the authority are not an authority answer.
 * - no store file exists at the probed path (`state: null`, the
 *   never-initialized legacy/staged case) → the read proceeds, i.e. the legacy
 *   read route keeps its pre-guard behaviour. There is no store to read, so
 *   there is no authority verdict to make (§2.1: absence is not an authority
 *   verdict; closing that with the durable installed binding is the explicit 2b
 *   obligation).
 *
 * A store that is observable but broken (corrupt content, drifted/unknown
 * schema, unsupported runtime) throws out of the probe and refuses through
 * this guard as well.
 */
export function assertExecutionFileReadAllowed(context: StoreContext): void {
  const probe = probeExecutionAuthority(context);
  if (probe.kind === "unreadable") refuseOpenFailure(probe.error, probe.dbPath);
  if (probe.state !== "active") return;
  throw new StoreError(
    "execution.consumer-not-ready",
    `The execution authority of ${probe.dbPath} is ACTIVE \u2014 this legacy file reader would serve ` +
      `retired root/snapshot JSON as authority. Nothing was read: consume the execution DB adapter instead.`,
  );
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
      execution: readExecutionMeta(db, schemaVersion),
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
 * claims the path with an exclusive create, applies all migrations and flips
 * the fresh store to an ACTIVE EMPTY state (epoch 1) in one atomic unit. A
 * path this process did not create refuses `store.already-exists` and is not
 * touched; a failed init cleans up only the file this process created.
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
  // The exclusive create is the whole existence check: a competing
  // initializer's store, a pre-existing file and the TOCTOU loser all refuse
  // here, before any connect or pragma can rewrite those bytes — and only the
  // process that won the create can ever unlink the file below.
  await loadSqliteDriver();
  let claim: number;
  try {
    claim = openSync(dbPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw alreadyExists();
    refuseOpenFailure(error, dbPath);
  }
  closeSync(claim);
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
    // Snapshot the opened connection: `close` runs after this function
    // returns, and TS cannot narrow the outer `let` inside a closure.
    const openDb = db;
    return {
      db: openDb,
      storeId: meta.storeId,
      epoch: meta.epoch,
      schemaVersion: MIGRATIONS.length,
      // A freshly initialized store is active for issue/catalog and `legacy`
      // for execution: initialization is not an execution activation.
      execution: readExecutionMeta(openDb, MIGRATIONS.length),
      close(): void {
        openDb.close();
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
    // Only the process that won the exclusive create reaches this cleanup, so
    // these paths are this process's own failed create — never a store a
    // competing initializer won (`store.busy`/`store.corrupt` on a foreign
    // path refuses at the claim above, without unlinking anything).
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
        // best-effort cleanup of our own failed create
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
    // The migration is atomic, so an upgraded store must carry the complete
    // execution schema; a recorded-but-incomplete one is drift, not progress.
    readExecutionMeta(db, schemaVersion);
    return { schemaVersion };
  } catch (error) {
    refuseOpenFailure(error, dbPath);
  } finally {
    db.close();
  }
}
