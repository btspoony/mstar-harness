/**
 * collaboration-store.ts -- the independent user-level collaboration store.
 *
 * One current v1 DDL (not a replay of the combined store's nineteen historical
 * migrations), a create-only staged publication and active-only handles. Only
 * the path-independent connection, schema-ledger checksum and publication
 * primitives are shared with `store-db.ts`; no execution table, projection,
 * host-state ledger or execution method exists in this database.
 *
 * The store belongs to one canonical repository (collaboration-identity.ts):
 * its path, repository key and mode were resolved before this module is
 * reached, and a record that disagrees with the trusted selection refuses
 * rather than re-binding. Every mutation goes through `withCollaborationWrite`:
 * no public entry hands out a connection that can write after the selection,
 * state or epoch changes.
 */
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, linkSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  resolveCollaborationLocation,
  type CollaborationLocation,
  type CollaborationMode,
} from "./collaboration-identity.js";
import {
  READ_OPEN_ATTEMPTS,
  READ_OPEN_BACKOFF_MS,
  SCHEMA_VERSION_TABLE_SQL,
  StoreError,
  assertAbsentOrRegularStoreFile,
  assertStoreRuntimeSupported,
  busyTimeoutMs,
  connect,
  isBusyError,
  isTransientReadOpenFailure,
  migrationChecksum,
  nowRfc3339,
  publicationCause,
  readAppliedMigrations,
  removeStagingFiles,
  syncDirectoryEntry,
  validateAppliedMigrations,
  type Migration,
  type StoreContext,
  type StoreDb,
} from "./store-db.js";

/**
 * The one current collaboration schema - the closed inventory of the Data
 * Model contract, at its current shape. Names in `issues`, `catalog_*`,
 * `project_*` and `sync_*` keep their existing domain vocabulary so the
 * domain SQL moved by the cutover does not see a second convention; nothing
 * from the execution lane (store_meta, execution_*, projection_*, dsh_*,
 * catalog_execution_bindings) appears here.
 */
const COLLABORATION_SCHEMA_SQL = `
create table collaboration_meta(
  id integer primary key check (id = 1),
  repository_key text not null,
  mode text not null check (mode in ('local','mirror')),
  store_id text not null,
  authority_state text not null check (authority_state in ('staged','active')),
  authority_epoch integer not null check (authority_epoch > 0),
  revision integer not null check (revision >= 0),
  catalog_revision integer not null check (catalog_revision >= 0),
  created_at text not null,
  activated_at text
);
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
create table project_roadmaps(
  project_id text primary key,
  project_kind text not null default 'project' check (project_kind = 'project'),
  content_markdown text not null,
  content_hash text not null,
  revision integer not null check (revision > 0),
  updated_at text not null,
  foreign key (project_kind, project_id) references catalog_entities(kind, id)
);
create table issues(
  id text primary key,
  project_id text not null,
  title text not null,
  kind text not null check (kind in ('bug','risk','improvement','request','decision','review-obligation')),
  severity text not null check (severity in ('critical','high','medium','low','nit')),
  disposition text not null default 'open' check (disposition in ('open','resolved','waived','duplicate','superseded','obsolete')),
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
create trigger project_milestones_identity_immutable
before update of milestone_id, project_id on project_milestones
when new.milestone_id != old.milestone_id or new.project_id != old.project_id
begin
  select raise(abort, 'milestone.identity-immutable');
end;
create table issue_counter(
  id integer primary key check (id = 1),
  next_value integer not null check (next_value > 0)
);
insert into issue_counter(id, next_value) values (1, 1);
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
  imported_at text,
  origin text not null default 'scoped' check (origin in ('scoped','unscoped'))
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
create table issue_sync_state(
  binding_id text not null,
  direction text not null,
  local_id text not null references issues(id),
  external_id text,
  item_state text not null check (item_state in ('unbound','pending','applied','failed','skipped')),
  last_remote_updated_at text,
  last_error text,
  last_skip_reason text,
  revision integer not null,
  updated_at text not null,
  pending_target text,
  last_request_hash text,
  last_kind_label text,
  primary key (binding_id, direction, local_id)
);
create unique index issue_sync_state_external on issue_sync_state(binding_id, direction, external_id) where external_id is not null;
create index issue_sync_state_last_error on issue_sync_state(binding_id, updated_at desc, revision desc) where last_error is not null;
create table sync_cursor(
  binding_id text not null,
  direction text not null,
  cursor text not null,
  updated_at text not null,
  primary key (binding_id, direction)
);
create table sync_runs(
  binding_id text not null,
  direction text not null,
  run_id text not null,
  holder_pid integer not null,
  holder_host text not null,
  started_at text not null,
  reason text not null,
  primary key (binding_id, direction)
);
create table collaboration_operations(
  key_space text not null check (key_space in ('standalone','composite')),
  operation_id text not null,
  execution_store_id text,
  execution_epoch integer,
  request_hash text not null,
  result_json text not null,
  collaboration_revision integer,
  catalog_revision integer,
  committed_at text not null,
  check (
    (key_space = 'standalone' and execution_store_id is null and execution_epoch is null
      and collaboration_revision is null and catalog_revision is null)
    or (key_space = 'composite' and execution_store_id is not null and execution_epoch is not null
      and collaboration_revision is not null and catalog_revision is not null)
  )
);
create unique index collaboration_operations_standalone
  on collaboration_operations(operation_id) where key_space = 'standalone';
create unique index collaboration_operations_composite
  on collaboration_operations(execution_store_id, execution_epoch, operation_id) where key_space = 'composite';
create table cutover_publications(
  manifest_id text primary key,
  phase text not null check (phase in ('verified','source-fenced','active')),
  source_store_id text not null,
  source_epoch integer not null,
  source_schema_version integer not null,
  source_revision integer not null,
  source_catalog_revision integer not null,
  manifest_digest text not null,
  target_store_id text not null,
  target_epoch integer not null,
  verified_at text not null,
  fenced_at text,
  activated_at text
);
`;

const COLLABORATION_SCHEMA: Migration = { version: 1, name: "collaboration-core", sql: COLLABORATION_SCHEMA_SQL };

/**
 * The closed collaboration table inventory this build requires. A store that
 * is missing one of these - or carries a table outside it - is not the current
 * collaboration schema, and a damaged one must refuse instead of admitting a
 * handle whose domain queries would fail later.
 */
const COLLABORATION_TABLES: readonly string[] = [
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

/** The exact trusted generation a caller may act on. */
export type CollaborationStamp = Readonly<{
  repoKey: string;
  mode: CollaborationMode;
  storeId: string;
  epoch: number;
}>;

export type CollaborationAuthority = CollaborationStamp &
  Readonly<{
    state: "staged" | "active";
    schemaVersion: number;
    revision: number;
    catalogRevision: number;
  }>;

/**
 * One admitted store handle. For every public entry (`openCollaborationStore`
 * in either mode) `db` is a read-only inspection connection: it cannot mutate,
 * so a retained handle never authorizes a write after the selection, state or
 * epoch changes. A writable `db` exists only inside `withCollaborationWrite`'s
 * callback and is closed when that call returns. `close` is idempotent.
 */
export type CollaborationStoreHandle = Readonly<{
  db: StoreDb;
  authority: CollaborationAuthority;
  close(): void;
}>;

type CollaborationMeta = {
  repoKey: string;
  mode: CollaborationMode;
  storeId: string;
  state: "staged" | "active";
  epoch: number;
  revision: number;
  catalogRevision: number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The lane's unreadable refusal, preserving the cause this call established. */
function unreadable(dbPath: string, detail: string, cause?: string): StoreError {
  return new StoreError(
    "collaboration.unreadable",
    `The collaboration store at ${dbPath} is not readable: ${detail}. Nothing was modified; a missing or broken ` +
      `store is created by the fresh initializer, and lost data is recovered from a verified backup pair.`,
    cause === undefined ? undefined : { cause },
  );
}

/** A published store whose directory entry is not confirmed durable. */
function barrierRefusal(dbPath: string, error: unknown): StoreError {
  const cause = publicationCause(error);
  return new StoreError(
    "collaboration.unreadable",
    `The collaboration store at ${dbPath} is published, but its directory entry could not be synchronized ` +
      `(${cause}); the name is not confirmed durable. Rerun the same initializer to retry the barrier; no data ` +
      `was changed.`,
    { path: dbPath, published: true, barrier: "initialization", cause },
  );
}

/** The bounded-contention verdict stays the shared, actionable `store.busy`. */
function busyRefusal(dbPath: string): StoreError {
  return new StoreError(
    "store.busy",
    `Another writer held the collaboration store at ${dbPath} past the bounded wait (${busyTimeoutMs()}ms). ` +
      `Retry when the competing writer is done; no write was accepted.`,
  );
}

/** Preserve a real cause: collaboration codes pass, contention stays busy, the rest is unreadable. */
function asRefusal(dbPath: string, error: unknown): StoreError {
  if (error instanceof StoreError) {
    if (error.code === "store.busy" || error.code.startsWith("collaboration.")) return error;
    return unreadable(dbPath, error.message, error.code);
  }
  if (isBusyError(error)) return busyRefusal(dbPath);
  return unreadable(dbPath, messageOf(error));
}

function notInitialized(dbPath: string): StoreError {
  return new StoreError(
    "collaboration.not-initialized",
    `No collaboration store exists at ${dbPath}. Create this scope with the fresh initializer ` +
      `("mstar store init") or the reviewed collaboration apply/activate sequence; nothing was created.`,
  );
}

function notActive(dbPath: string, state: "staged" | "active"): StoreError {
  return new StoreError(
    "collaboration.not-active",
    `The collaboration store at ${dbPath} is ${state}, not active. Only an active authority admits reads or ` +
      `writes; complete the reviewed collaboration apply/activate sequence for this scope, then retry. ` +
      `Nothing was created or modified.`,
  );
}

function staleBinding(
  dbPath: string,
  recorded: { repoKey: string; mode: string; storeId?: string; epoch?: number },
  expected: string,
): StoreError {
  return new StoreError(
    "collaboration.stale-binding",
    `The collaboration store at ${dbPath} records repository ${recorded.repoKey} mode ${recorded.mode}` +
      `${recorded.storeId === undefined ? "" : ` store ${recorded.storeId} epoch ${String(recorded.epoch)}`}, ` +
      `which does not match ${expected}. Re-resolve this scope with "mstar path resolve"; a store is never ` +
      `re-bound by editing its selection, and an old write is never retried against a new authority.`,
  );
}

/** The final path must be a regular file or absent, decided without following a link. */
function assertRegularTarget(dbPath: string): void {
  try {
    assertAbsentOrRegularStoreFile(dbPath);
  } catch (error) {
    throw asRefusal(dbPath, error);
  }
}

/**
 * The closed table inventory, and nothing outside it. A dropped domain table or
 * a foreign/combined database copied onto this path refuses before admission.
 */
function assertCurrentSchema(db: StoreDb, dbPath: string): void {
  const rows = db.prepare("select name from sqlite_master where type = 'table'").all();
  const present = new Set<string>();
  for (const row of rows) {
    const name = (row as { name?: unknown }).name;
    if (typeof name === "string" && !name.startsWith("sqlite_")) present.add(name);
  }
  const missing = COLLABORATION_TABLES.filter((name) => !present.has(name));
  const unexpected = [...present].filter((name) => !COLLABORATION_TABLES.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw unreadable(
      dbPath,
      `its schema is not the current collaboration inventory (missing: ${missing.join(", ") || "none"}; ` +
        `unexpected: ${unexpected.join(", ") || "none"})`,
    );
  }
}

function readMeta(db: StoreDb): CollaborationMeta {
  const record = db
    .prepare(
      "select repository_key, mode, store_id, authority_state, authority_epoch, revision, catalog_revision " +
        "from collaboration_meta where id = 1",
    )
    .get() as
    | {
        repository_key?: unknown;
        mode?: unknown;
        store_id?: unknown;
        authority_state?: unknown;
        authority_epoch?: unknown;
        revision?: unknown;
        catalog_revision?: unknown;
      }
    | undefined;
  if (
    record === undefined ||
    typeof record.repository_key !== "string" ||
    (record.mode !== "local" && record.mode !== "mirror") ||
    typeof record.store_id !== "string" ||
    (record.authority_state !== "staged" && record.authority_state !== "active") ||
    typeof record.authority_epoch !== "number" ||
    typeof record.revision !== "number" ||
    typeof record.catalog_revision !== "number"
  ) {
    throw new StoreError(
      "collaboration.unreadable",
      "collaboration_meta is missing or malformed; the repository binding cannot be verified. Nothing was modified.",
    );
  }
  return {
    repoKey: record.repository_key,
    mode: record.mode,
    storeId: record.store_id,
    state: record.authority_state,
    epoch: record.authority_epoch,
    revision: record.revision,
    catalogRevision: record.catalog_revision,
  };
}

/**
 * Ledger, current domain schema, metadata, trusted selection, required state and
 * (when given) the exact stamp must all agree before any handle or effect is
 * admitted. Every failure keeps its own distinguishable refusal.
 */
function admit(
  db: StoreDb,
  location: CollaborationLocation,
  expected: CollaborationStamp | undefined,
  requirement: "active" | "any",
): CollaborationAuthority {
  try {
    assertCurrentSchema(db, location.dbPath);
    const schemaVersion = validateAppliedMigrations(readAppliedMigrations(db, false), [COLLABORATION_SCHEMA]);
    const meta = readMeta(db);
    if (meta.repoKey !== location.repoKey || meta.mode !== location.mode) {
      throw staleBinding(location.dbPath, meta, `this checkout's ${location.repoKey} (${location.mode})`);
    }
    const authority: CollaborationAuthority = {
      repoKey: meta.repoKey,
      mode: meta.mode,
      storeId: meta.storeId,
      epoch: meta.epoch,
      state: meta.state,
      schemaVersion,
      revision: meta.revision,
      catalogRevision: meta.catalogRevision,
    };
    if (requirement === "active" && authority.state !== "active") throw notActive(location.dbPath, authority.state);
    const matches =
      expected !== undefined &&
      expected.repoKey === location.repoKey &&
      expected.mode === location.mode &&
      expected.storeId === authority.storeId &&
      expected.epoch === authority.epoch;
    if (expected !== undefined && !matches) {
      throw staleBinding(
        location.dbPath,
        authority,
        `${expected.repoKey} (${expected.mode}) store ${expected.storeId} epoch ${String(expected.epoch)}`,
      );
    }
    return authority;
  } catch (error) {
    throw asRefusal(location.dbPath, error);
  }
}

/** One handle owner: `close` is idempotent so the entry points can share it. */
function handleFor(db: StoreDb, authority: CollaborationAuthority): CollaborationStoreHandle {
  let closed = false;
  return {
    db,
    authority,
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/** Connect with the same bounded transient read-open retry the execution lane uses. */
async function connectAt(dbPath: string, mode: "read" | "write", timeout: number): Promise<StoreDb> {
  const attempts = mode === "read" ? READ_OPEN_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect(dbPath, mode, timeout);
    } catch (error) {
      if (attempt < attempts && isTransientReadOpenFailure(error, dbPath)) {
        await sleep(READ_OPEN_BACKOFF_MS);
        continue;
      }
      throw asRefusal(dbPath, error);
    }
  }
}

/**
 * Admit one existing store on a READ-ONLY connection. `admit` names the only
 * state that may be returned: public handles admit `active`; initialization
 * continues a matching record in either state without clearing it.
 */
async function openAdmission(
  location: CollaborationLocation,
  requirement: "active" | "any",
  expected: CollaborationStamp | undefined,
  timeout: number,
): Promise<CollaborationStoreHandle> {
  const dbPath = location.dbPath;
  assertRegularTarget(dbPath);
  if (!existsSync(dbPath)) throw notInitialized(dbPath);
  const db = await connectAt(dbPath, "read", timeout);
  try {
    return handleFor(db, admit(db, location, expected, requirement));
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Confirm the canonical directory entry before any successful continuation. */
function confirmDirectoryEntry(dbPath: string): void {
  try {
    syncDirectoryEntry(dirname(dbPath));
  } catch (error) {
    throw barrierRefusal(dbPath, error);
  }
}

/**
 * Continue an already published record without clearing it. Reused by the
 * existing-path and competing-publication branches: both re-attempt the
 * directory barrier, so a retry after a failed barrier never reports success
 * for a name that is still not durable.
 */
async function continueExisting(location: CollaborationLocation, timeout: number): Promise<CollaborationAuthority> {
  const handle = await openAdmission(location, "any", undefined, timeout);
  const authority = handle.authority;
  handle.close();
  confirmDirectoryEntry(location.dbPath);
  return authority;
}

/**
 * Create-only staged initialization for one canonical scope. A missing
 * database is built complete in a private staging file and published with one
 * create-only hard link; a matching record already on disk (staged or active)
 * is reused without clearing it, and a record for another repository, mode,
 * state, store id or schema refuses.
 */
export async function initializeCollaborationStore(location: CollaborationLocation): Promise<CollaborationAuthority> {
  assertStoreRuntimeSupported();
  const dbPath = location.dbPath;
  const timeout = busyTimeoutMs();
  assertRegularTarget(dbPath);
  if (existsSync(dbPath)) return continueExisting(location, timeout);

  const dir = dirname(dbPath);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw unreadable(dbPath, `its directory could not be created (${publicationCause(error)})`);
  }
  const stagingPath = join(dir, `.${basename(dbPath)}.init-${process.pid}-${randomUUID()}.tmp`);
  let claim: number;
  try {
    claim = openSync(stagingPath, "wx", 0o600);
  } catch (error) {
    throw unreadable(dbPath, `a private staging file could not be created (${publicationCause(error)})`);
  }
  closeSync(claim);

  let db: StoreDb | undefined;
  let authority: CollaborationAuthority;
  try {
    db = await connect(stagingPath, "write", timeout);
    db.exec("begin immediate");
    try {
      const at = nowRfc3339();
      db.exec(SCHEMA_VERSION_TABLE_SQL);
      db.exec(COLLABORATION_SCHEMA.sql);
      db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
        COLLABORATION_SCHEMA.version,
        COLLABORATION_SCHEMA.name,
        migrationChecksum(COLLABORATION_SCHEMA),
        at,
      );
      db.prepare(
        "insert into collaboration_meta(id, repository_key, mode, store_id, authority_state, authority_epoch, " +
          "revision, catalog_revision, created_at) values (1, ?, ?, ?, 'staged', 1, 0, 0, ?)",
      ).run(location.repoKey, location.mode, randomUUID(), at);
      db.exec("commit");
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
        // nothing committed either way
      }
      throw error;
    }
    // The staged bytes are verified as this build's own complete store before
    // they can be named.
    authority = admit(db, location, undefined, "any");
    // A hard link names one inode, not a journal: fold the staged journal into
    // the database file so the published name is self-contained.
    const folded = db.prepare("pragma journal_mode=delete").get() as { journal_mode?: string } | undefined;
    if (folded?.journal_mode !== "delete") {
      throw unreadable(
        dbPath,
        `the staged store could not be folded into one database file (journal mode ${String(folded?.journal_mode ?? "unknown")})`,
      );
    }
    db.close();
    db = undefined;
  } catch (error) {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
        // connection-level failure; the staging name is unlinked below
      }
    }
    removeStagingFiles(stagingPath);
    throw asRefusal(dbPath, error);
  }

  try {
    linkSync(stagingPath, dbPath);
  } catch (error) {
    removeStagingFiles(stagingPath);
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      // A competing initializer published this scope first: continue that record
      // only after it is verified and its directory entry is confirmed.
      return continueExisting(location, timeout);
    }
    throw unreadable(dbPath, `the staged store could not be linked into place (${publicationCause(error)})`);
  }
  // A failed barrier keeps the staging name (the only other reference to those
  // bytes) and reports the published-but-unconfirmed outcome; the same
  // initializer retries it through the continuation above.
  confirmDirectoryEntry(dbPath);
  removeStagingFiles(stagingPath);
  return authority;
}

/**
 * Open the scope's active collaboration authority. Never creates a database:
 * a missing one is `collaboration.not-initialized`, an inert staged one is
 * `collaboration.not-active`, and an invalid/corrupt/inaccessible one is
 * `collaboration.unreadable`. An expected stamp that no longer matches refuses
 * `collaboration.stale-binding` before the handle is returned.
 *
 * Both modes return the same non-mutating inspection handle: the lane's writer
 * exists only inside `withCollaborationWrite`, so no retained handle can write
 * after the selection, state or epoch changes. `mode: "write"` additionally
 * proves the store file is writable now, so a mutation-intent caller learns a
 * read-only filesystem before attempting the guarded write.
 */
export async function openCollaborationStore(
  context: StoreContext,
  mode: "read" | "write",
  expected?: CollaborationStamp,
): Promise<CollaborationStoreHandle> {
  assertStoreRuntimeSupported();
  const location = resolveCollaborationLocation(context);
  if (mode === "write" && existsSync(location.dbPath)) {
    try {
      accessSync(location.dbPath, constants.W_OK);
    } catch (error) {
      throw unreadable(location.dbPath, `the store file is not writable (${publicationCause(error)})`);
    }
  }
  return openAdmission(location, "active", expected, busyTimeoutMs());
}

/** The active authority record alone; no handle escapes and nothing is created. */
export async function readCollaborationAuthority(context: StoreContext): Promise<CollaborationAuthority> {
  const handle = await openCollaborationStore(context, "read");
  handle.close();
  return handle.authority;
}

/**
 * Run one collaboration effect inside a write transaction. Admission is proved
 * on a read-only probe FIRST, so a refused scope never opens a writer and never
 * changes a staged or foreign database's journal state. The writer then takes
 * `BEGIN IMMEDIATE` and re-verifies the binding, active state and expected stamp
 * under the writer lock, so neither a payload nor an earlier handle authorizes
 * a write. The effect must be synchronous: a returned thenable is rejected
 * before commit, and a thrown effect rolls the whole transaction back.
 */
export async function withCollaborationWrite<T>(
  context: StoreContext,
  apply: (handle: CollaborationStoreHandle) => T,
  expected?: CollaborationStamp,
): Promise<T> {
  assertStoreRuntimeSupported();
  const location = resolveCollaborationLocation(context);
  const dbPath = location.dbPath;
  const timeout = busyTimeoutMs();
  assertRegularTarget(dbPath);
  if (!existsSync(dbPath)) throw notInitialized(dbPath);

  const probe = await connectAt(dbPath, "read", timeout);
  try {
    admit(probe, location, expected, "active");
  } finally {
    probe.close();
  }

  const db = await connectAt(dbPath, "write", timeout);
  let handle: CollaborationStoreHandle | undefined;
  try {
    db.exec("begin immediate");
    try {
      handle = handleFor(db, admit(db, location, expected, "active"));
      const result = apply(handle);
      if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
        throw new StoreError(
          "store.corrupt",
          "A collaboration write effect must be synchronous. The returned thenable was rejected before commit and " +
            "nothing was written.",
        );
      }
      db.exec("commit");
      return result;
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
        // nothing committed either way
      }
      throw error;
    }
  } finally {
    if (handle !== undefined) handle.close();
    else {
      try {
        db.close();
      } catch {
        // connection-level failure; the transaction above already rolled back
      }
    }
  }
}
