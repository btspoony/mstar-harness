import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  AUTHORITY_REF,
  COLLABORATION_BINDING_FILE,
  assertSelectionUnchanged,
  resolveCollaborationLocation,
  type CollaborationLocation,
  type CollaborationMode,
  collaborationLocationOfRepoKey,
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
  heldCollaborationTables,
  isBusyError,
  isTransientReadOpenFailure,
  migrationChecksum,
  nowRfc3339,
  publicationCause,
  readAppliedMigrations,
  readCollaborationFence,
  removeStagingFiles,
  storeDbPath,
  syncDirectoryEntry,
  tableNamesOn,
  validateAppliedMigrations,
  walShapedStoreFile,
  type AppliedMigration,
  type Migration,
  type StoreConnectOptions,
  type StoreContext,
  type StoreDb,
} from "./store-db.js";

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
 * note: The portable issue key the v2 lane owns. It is allocated once, never derived from a
 * provider, a local sequence, a Git author or a checkout scope, and every
 * issue-producing path (capture, legacy import, cutover copy, v1 backfill) mints
 * one through `mintIssueRef`.
 */
export const ISSUE_REF_PREFIX = "mstar:issue:";
export const ISSUE_REF_PATTERN = /^mstar:issue:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type IssueRef = string;

export function mintIssueRef(): IssueRef {
  return `${ISSUE_REF_PREFIX}${randomUUID()}`;
}

/**
 * note: A supplied reference must be exactly the contract's spelling. It is a remote-boundary
 * input (an adoption or snapshot document), so a malformed one is input refusal.
 */
export function assertIssueRef(value: unknown): IssueRef {
  if (typeof value !== "string" || !ISSUE_REF_PATTERN.test(value)) {
    throw new StoreError("remote.input-invalid", "an IssueRef is 'mstar:issue:<lowercase uuid>'");
  }
  return value;
}

const COLLABORATION_META_V2_SQL = `
create table collaboration_meta_remote_cache(
  id integer primary key check (id = 1),
  repository_key text not null,
  mode text not null check (mode in ('local','mirror','remote')),
  store_id text not null,
  authority_state text not null check (authority_state in ('staged','active')),
  authority_epoch integer not null check (authority_epoch > 0),
  revision integer not null check (revision >= 0),
  catalog_revision integer not null check (catalog_revision >= 0),
  created_at text not null,
  activated_at text
);
insert into collaboration_meta_remote_cache(id, repository_key, mode, store_id, authority_state, authority_epoch, revision, catalog_revision, created_at, activated_at)
  select id, repository_key, mode, store_id, authority_state, authority_epoch, revision, catalog_revision, created_at, activated_at
  from collaboration_meta;
drop table collaboration_meta;
alter table collaboration_meta_remote_cache rename to collaboration_meta;
create table remote_bindings(
  generation integer not null check (typeof(generation) = 'integer' and generation > 0),
  project_key text not null,
  selector_commit text not null,
  provider text not null check (provider = 'linear'),
  workspace_id text not null,
  team_id text not null,
  provider_project_id text not null,
  journal_issue_id text not null,
  writer_id text,
  verified_at text not null,
  verification_json text not null,
  primary key (generation, project_key),
  unique (generation, provider, workspace_id, provider_project_id)
);
create table remote_observations(
  generation integer not null,
  project_key text not null,
  revision integer not null default 0 check (revision >= 0),
  as_of text,
  completeness text not null check (completeness in ('complete','partial','unavailable')),
  code text,
  snapshot_json text,
  received_at text not null,
  primary key (generation, project_key),
  foreign key (generation, project_key) references remote_bindings(generation, project_key),
  check (
    (completeness = 'unavailable' and snapshot_json is null and as_of is null)
    or (completeness in ('complete','partial') and snapshot_json is not null and as_of is not null)
  )
);
create table remote_issue_identities(
  generation integer not null,
  project_key text not null,
  provider_issue_id text not null,
  issue_ref text,
  primary key (generation, project_key, provider_issue_id),
  foreign key (generation, project_key) references remote_observations(generation, project_key)
);
create unique index remote_issue_identities_ref on remote_issue_identities(generation, issue_ref) where issue_ref is not null;
create unique index remote_issue_identities_provider on remote_issue_identities(generation, provider_issue_id);
`;

const ISSUE_COLUMN_LIST =
  "id, project_id, title, kind, severity, disposition, impact, acceptance, owner, registered_at, closed_at, " +
  "closure_note, created_at, updated_at, revision, provider, external_id, url, identity_key, milestone_id";

const COLLABORATION_ISSUES_V2_STAGE_SQL = `
create table occurrences_remote_cache_stage as select * from occurrences;
create table provenance_remote_cache_stage as select * from provenance;
create table relations_remote_cache_stage as select * from relations;
create table issue_transitions_remote_cache_stage as select * from issue_transitions;
create table issue_project_moves_remote_cache_stage as select * from issue_project_moves;
create table issue_sync_state_remote_cache_stage as select * from issue_sync_state;
delete from occurrences;
delete from provenance;
delete from relations;
delete from issue_transitions;
delete from issue_project_moves;
delete from issue_sync_state;
create table issues_remote_cache(
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
  issue_ref text not null unique,
  milestone_id text references project_milestones(milestone_id)
);
`;

const COLLABORATION_ISSUES_V2_RESTORE_SQL = `
drop table issues;
alter table issues_remote_cache rename to issues;
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
insert into occurrences select * from occurrences_remote_cache_stage;
insert into provenance select * from provenance_remote_cache_stage;
insert into relations select * from relations_remote_cache_stage;
insert into issue_transitions select * from issue_transitions_remote_cache_stage;
insert into issue_project_moves select * from issue_project_moves_remote_cache_stage;
insert into issue_sync_state select * from issue_sync_state_remote_cache_stage;
drop table occurrences_remote_cache_stage;
drop table provenance_remote_cache_stage;
drop table relations_remote_cache_stage;
drop table issue_transitions_remote_cache_stage;
drop table issue_project_moves_remote_cache_stage;
drop table issue_sync_state_remote_cache_stage;
`;

const COLLABORATION_REMOTE_SCHEMA: Migration = {
  version: 2,
  name: "collaboration-remote-cache",
  sql: `${COLLABORATION_META_V2_SQL}\n${COLLABORATION_ISSUES_V2_STAGE_SQL}\n${COLLABORATION_ISSUES_V2_RESTORE_SQL}`,
};

const COLLABORATION_OUTBOX_V3_SQL = `
create table remote_outbox(
  operation_id text not null primary key,
  generation integer not null check (typeof(generation) = 'integer' and generation > 0),
  project_key text not null,
  request_hash text not null,
  request_json text not null,
  execution_key_json text,
  state text not null check (state in ('enqueued','unconfirmed','confirmed','conflict','abandoned')),
  attempt_id text unique,
  created_at text not null,
  updated_at text not null,
  abandon_reason text,
  resolves text references remote_outbox(operation_id),
  resolved_by text references remote_outbox(operation_id),
  foreign key (generation, project_key) references remote_bindings(generation, project_key)
);
create index remote_outbox_pending on remote_outbox(generation, project_key, state, created_at, operation_id);
create table remote_outbox_receipts(
  operation_id text not null,
  receipt_hash text not null,
  source text not null check (source in ('receipt','reconcile')),
  outcome text not null check (outcome in ('confirmed','unconfirmed','conflict','not-sent')),
  evidence_json text not null,
  recorded_at text not null,
  primary key (operation_id, receipt_hash),
  foreign key (operation_id) references remote_outbox(operation_id)
);
`;

const COLLABORATION_OUTBOX_SCHEMA: Migration = {
  version: 3,
  name: "collaboration-remote-outbox",
  sql: COLLABORATION_OUTBOX_V3_SQL,
};

const COLLABORATION_MOVE_V4_SQL = `
create table relations_cross_authority_stage(
  from_issue text not null references issues(id),
  relation text not null check (relation in ('related','blocks','duplicate-of','superseded-by')),
  to_issue text references issues(id),
  to_ref text,
  primary key (from_issue, relation, to_issue),
  check ((to_issue is null) <> (to_ref is null)),
  check (from_issue is not to_issue),
  check (relation != 'related' or to_issue is null or from_issue < to_issue)
);
insert into relations_cross_authority_stage(from_issue, relation, to_issue)
  select from_issue, relation, to_issue from relations;
drop table relations;
alter table relations_cross_authority_stage rename to relations;
create unique index relations_to_ref on relations(from_issue, relation, to_ref) where to_ref is not null;
create table issue_moves(
  operation_id text not null primary key,
  role text not null check (role in ('source','destination')),
  request_hash text not null,
  issue_ref text not null,
  source_issue_id text,
  destination_issue_id text,
  source_authority text not null,
  destination_authority text not null,
  destination_project text not null,
  actor text not null,
  reason text not null,
  phase text not null check (phase in ('staged','verified','switched','published','discarded')),
  payload_json text not null,
  payload_digest text not null,
  staged_counts text not null,
  source_store_id text not null,
  source_epoch integer not null check (typeof(source_epoch) = 'integer' and source_epoch > 0),
  removed_sync_rows integer not null default 0 check (removed_sync_rows >= 0),
  created_at text not null,
  updated_at text not null
);
create index issue_moves_record on issue_moves(role, issue_ref, phase);
create unique index issue_moves_blocking on issue_moves(issue_ref)
  where role = 'source' and phase in ('staged','verified','switched');
create trigger issues_move_guard_update
before update on issues
when exists (
  select 1 from issue_moves m
  where m.role = 'source' and m.phase in ('staged','verified','switched') and m.source_issue_id = old.id
)
begin
  select raise(abort, 'issue.move-in-progress');
end;
create trigger issues_move_guard_delete
before delete on issues
when exists (
  select 1 from issue_moves m
  where m.role = 'source' and m.phase in ('staged','verified','switched') and m.source_issue_id = old.id
)
begin
  select raise(abort, 'issue.move-in-progress');
end;
create trigger relations_move_guard_insert
before insert on relations
when exists (
  select 1 from issue_moves m
  where m.role = 'source' and m.phase in ('staged','verified','switched')
    and m.source_issue_id in (new.from_issue, new.to_issue)
)
begin
  select raise(abort, 'issue.move-in-progress');
end;
create trigger relations_move_guard_update
before update on relations
when exists (
  select 1 from issue_moves m
  where m.role = 'source' and m.phase in ('staged','verified','switched')
    and m.source_issue_id in (old.from_issue, old.to_issue, new.from_issue, new.to_issue)
)
-- note: the publisher's own edge rewrite is the one admitted exception: its row committed
-- 'published' in this same transaction before the rewrite, which the 'published' probe sees.
and not exists (
  select 1 from issue_moves p
  where p.role = 'source' and p.phase = 'published' and p.source_issue_id = old.to_issue
)
begin
  select raise(abort, 'issue.move-in-progress');
end;
create trigger issue_sync_state_move_guard_insert
before insert on issue_sync_state
when exists (
  select 1 from issue_moves m
  where m.role = 'source' and m.phase in ('staged','verified','switched') and m.source_issue_id = new.local_id
)
begin
  select raise(abort, 'issue.move-in-progress');
end;
create trigger issue_sync_state_move_guard_update
before update on issue_sync_state
when exists (
  select 1 from issue_moves m
  where m.role = 'source' and m.phase in ('staged','verified','switched')
    and m.source_issue_id in (old.local_id, new.local_id)
)
begin
  select raise(abort, 'issue.move-in-progress');
end;
create trigger issue_sync_state_move_guard_delete before delete on issue_sync_state
when exists (
  select 1 from issue_moves m
  where m.role = 'source' and m.phase in ('staged','verified','switched')
    and m.source_issue_id = old.local_id
)
begin
  select raise(abort, 'issue.move-in-progress');
end;

-- invariant: A publication delete must not strip a frozen record's links early: the relation rows
-- are the copy the destination admitted, and only the ledger's terminal phase may remove them.
-- The publication's own delete of its OUTGOING edges is the one admitted exception, visible the
-- same way: the row committed 'published' in this same transaction before the children go.
create trigger relations_move_guard_delete before delete on relations
when exists (
  select 1 from issue_moves m
  where m.role = 'source' and m.phase in ('staged','verified','switched')
    and m.source_issue_id in (old.from_issue, old.to_issue)
)
and not exists (
  select 1 from issue_moves p
  where p.role = 'source' and p.phase = 'published' and p.source_issue_id = old.from_issue
)
begin
  select raise(abort, 'issue.move-in-progress');
end;
`;

const COLLABORATION_MOVE_SCHEMA: Migration = {
  version: 4,
  name: "collaboration-cross-authority",
  sql: COLLABORATION_MOVE_V4_SQL,
};

const COLLABORATION_MOVE_ROUTE_SQL = `
alter table issue_moves add column route text not null default 'local-local'
  check (route in ('local-local', 'local-remote', 'remote-local', 'remote-unknown'));
update issue_moves set route = case
  when issue_moves.role = 'source' then
    case when (select mode from collaboration_meta where id = 1) = 'remote' then 'remote-unknown' else 'local-remote' end
  else
    case when (select mode from collaboration_meta where id = 1) = 'remote' then 'local-remote' else 'remote-local' end
end;
`;

const COLLABORATION_MOVE_ROUTE_SCHEMA: Migration = {
  version: 5,
  name: "collaboration-move-route",
  sql: COLLABORATION_MOVE_ROUTE_SQL,
};

const COLLABORATION_MILESTONE_EFFORT_V6_SQL = `
alter table project_milestones add column effort_sessions integer check (
  effort_sessions is null or
  (typeof(effort_sessions) = 'integer' and effort_sessions >= 1)
);
alter table project_milestones drop column target;
`;

const COLLABORATION_MILESTONE_EFFORT_SCHEMA: Migration = {
  version: 6,
  name: "collaboration-milestone-effort",
  sql: COLLABORATION_MILESTONE_EFFORT_V6_SQL,
};

/** see packages/engine/src/collaboration-store.ts - v7 `collaboration-roadmap-removal` - the roadmap domain leaves the lane. `project_roadmaps` is dropped and `catalog_entities` is rebuilt without `'roadmap'` in its `document_kind` CHECK, because SQLite cannot alter a CHECK in place. The rebuild copies every row; a `document_kind = 'roadmap'` row is reclassified to `other` and keeps its id, revision and registration - a catalog row is never deleted to satisfy an enum. `catalog_links` and `project_milestones` reference `catalog_entities`, and `issues` references `project_milestones`, so the rebuild uses the same FK-safe staging the v2 issue rebuild uses: the children are staged out, the parent rebuilt, the children restored, and `defer_foreign_keys` lets the grandchildren be proven at commit against the restored rows. */
/** see packages/engine/src/collaboration-store.ts - The table v7 retires. Every generation before it carried the lane's roadmap body. */
const COLLABORATION_ROADMAP_TABLE = "project_roadmaps";

const COLLABORATION_ROADMAP_REMOVAL_SQL = `
pragma defer_foreign_keys = ON;
drop table project_roadmaps;
create table catalog_links_roadmap_stage as select * from catalog_links;
create table project_milestones_roadmap_stage as select * from project_milestones;
delete from catalog_links;
delete from project_milestones;
create table catalog_entities_roadmap_stage(
  kind text not null check (kind in ('project','iteration','plan','document')),
  id text not null,
  title text not null,
  description text,
  root_kind text not null check (root_kind in ('repository','harness','plans','iterations','specs','knowledge','projects')),
  relative_path text not null,
  document_kind text check (document_kind in ('spec','knowledge','guide','compass','plan','review','other')),
  lifecycle text not null default 'active' check (lifecycle in ('active','archived','superseded')),
  revision integer not null default 1 check (revision > 0),
  registered_at text not null,
  updated_at text not null,
  source_hash text,
  primary key (kind, id),
  check (document_kind is null or kind = 'document')
);
insert into catalog_entities_roadmap_stage(
  kind, id, title, description, root_kind, relative_path, document_kind, lifecycle, revision, registered_at,
  updated_at, source_hash
)
select kind, id, title, description, root_kind, relative_path,
       case when document_kind = 'roadmap' then 'other' else document_kind end,
       lifecycle, revision, registered_at, updated_at, source_hash
from catalog_entities;
drop table catalog_entities;
alter table catalog_entities_roadmap_stage rename to catalog_entities;
create unique index catalog_entities_location on catalog_entities(kind, root_kind, relative_path);
create index catalog_entities_document_kind on catalog_entities(document_kind) where document_kind is not null;
insert into catalog_links select * from catalog_links_roadmap_stage;
insert into project_milestones select * from project_milestones_roadmap_stage;
drop table catalog_links_roadmap_stage;
drop table project_milestones_roadmap_stage;
`;

const COLLABORATION_ROADMAP_REMOVAL_SCHEMA: Migration = {
  version: 7,
  name: "collaboration-roadmap-removal",
  sql: COLLABORATION_ROADMAP_REMOVAL_SQL,
};

/** note: The lane's ordered migrations: v1 is immutable; v2, the v3 outbox, the v4 move ledger, the v5 route, v6 and v7 are appended. */
export const COLLABORATION_MIGRATIONS: readonly Migration[] = [
  COLLABORATION_SCHEMA,
  COLLABORATION_REMOTE_SCHEMA,
  COLLABORATION_OUTBOX_SCHEMA,
  COLLABORATION_MOVE_SCHEMA,
  COLLABORATION_MOVE_ROUTE_SCHEMA,
  COLLABORATION_MILESTONE_EFFORT_SCHEMA,
  COLLABORATION_ROADMAP_REMOVAL_SCHEMA,
];

const COLLABORATION_REMOTE_TABLES: readonly string[] = [
  "remote_bindings",
  "remote_issue_identities",
  "remote_observations",
];

const COLLABORATION_OUTBOX_TABLES: readonly string[] = ["remote_outbox", "remote_outbox_receipts"];

function applyRemoteCacheSchema(db: StoreDb): number {
  db.exec(COLLABORATION_META_V2_SQL);
  db.exec(COLLABORATION_ISSUES_V2_STAGE_SQL);
  const columns = ISSUE_COLUMN_LIST.split(", ");
  const rows = db.prepare(`select ${ISSUE_COLUMN_LIST} from issues`).all() as Array<Record<string, unknown>>;
  const insert = db.prepare(
    `insert into issues_remote_cache(${ISSUE_COLUMN_LIST}, issue_ref) values (${[...columns, "issue_ref"].map(() => "?").join(", ")})`,
  );
  for (const row of rows) insert.run(...columns.map((column) => row[column]), mintIssueRef());
  db.exec(COLLABORATION_ISSUES_V2_RESTORE_SQL);
  return rows.length;
}

const COLLABORATION_TABLES: readonly string[] = [
  "catalog_entities",
  "catalog_links",
  "catalog_operations",
  "collaboration_meta",
  "collaboration_operations",
  "cutover_publications",
  "issue_counter",
  "issue_moves",
  "issue_project_moves",
  "issue_sync_state",
  "issue_transitions",
  "issues",
  "occurrences",
  "project_bindings",
  "project_milestones",
  "provenance",
  "relations",
  "remote_bindings",
  "remote_issue_identities",
  "remote_observations",
  "remote_outbox",
  "remote_outbox_receipts",
  "schema_version",
  "sync_cursor",
  "sync_runs",
];

/**
 * The exact v1 inventory, unchanged: the shape a v1 upgrade proves, a v1 lane
 * holds and a v1 backup image declares.
 */
export const COLLABORATION_V1_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  catalog_entities: [
    "kind", "id", "title", "description", "root_kind", "relative_path", "document_kind", "lifecycle", "revision",
    "registered_at", "updated_at", "source_hash",
  ],
  catalog_links: ["from_kind", "from_id", "relation", "to_kind", "to_id", "ordinal"],
  catalog_operations: [
    "operation_id", "request_hash", "phase", "catalog_delta_json", "before_versions_json", "after_versions_json",
    "result_json", "created_at", "updated_at",
  ],
  collaboration_meta: [
    "id", "repository_key", "mode", "store_id", "authority_state", "authority_epoch", "revision", "catalog_revision",
    "created_at", "activated_at",
  ],
  collaboration_operations: [
    "key_space", "operation_id", "execution_store_id", "execution_epoch", "request_hash", "result_json",
    "collaboration_revision", "catalog_revision", "committed_at",
  ],
  cutover_publications: [
    "manifest_id", "phase", "source_store_id", "source_epoch", "source_schema_version", "source_revision",
    "source_catalog_revision", "manifest_digest", "target_store_id", "target_epoch", "verified_at", "fenced_at",
    "activated_at",
  ],
  issue_counter: ["id", "next_value"],
  issue_project_moves: [
    "id", "issue_id", "from_project_id", "to_project_id", "actor", "reason", "occurred_at", "recorded_at",
    "issue_revision",
  ],
  issue_sync_state: [
    "binding_id", "direction", "local_id", "external_id", "item_state", "last_remote_updated_at", "last_error",
    "last_skip_reason", "revision", "updated_at", "pending_target", "last_request_hash", "last_kind_label",
  ],
  issue_transitions: [
    "id", "issue_id", "from_disposition", "to_disposition", "actor", "occurred_at", "recorded_at", "reason",
    "evidence_json", "imported", "issue_revision",
  ],
  issues: [
    "id", "project_id", "title", "kind", "severity", "disposition", "impact", "acceptance", "owner", "registered_at",
    "closed_at", "closure_note", "created_at", "updated_at", "revision", "provider", "external_id", "url",
    "identity_key", "milestone_id",
  ],
  occurrences: [
    "id", "issue_id", "occurrence_key", "source_kind", "source_identity", "root_cause_key", "acceptance_key",
    "location", "observed_behavior", "evidence_json", "discovered_at", "recorded_at", "imported",
  ],
  project_bindings: ["project_id", "provider", "workspace", "team", "remote_project", "revision", "updated_at"],
  project_milestones: [
    "milestone_id", "project_id", "project_kind", "name", "target", "status", "ordinal", "revision", "created_at",
    "updated_at",
  ],
  project_roadmaps: ["project_id", "project_kind", "content_markdown", "content_hash", "revision", "updated_at"],
  provenance: [
    "id", "issue_id", "kind", "target", "source_hash", "legacy_project", "legacy_bucket", "legacy_entry_id",
    "legacy_json", "imported_at", "origin",
  ],
  relations: ["from_issue", "relation", "to_issue"],
  schema_version: ["version", "name", "checksum", "applied_at"],
  sync_cursor: ["binding_id", "direction", "cursor", "updated_at"],
  sync_runs: ["binding_id", "direction", "run_id", "holder_pid", "holder_host", "started_at", "reason"],
};

/**
 * The columns the cutover COPIES from a combined source store, in the CURRENT
 * source's shape: that source predates `issues.issue_ref`, so the copy mints
 * the reference on the target side instead of reading it. Admission uses the
 * current inventory below.
 */
export const COLLABORATION_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ...COLLABORATION_V1_COLUMNS,
  project_milestones: [
    "milestone_id", "project_id", "project_kind", "name", "effort_sessions", "status", "ordinal", "revision",
    "created_at", "updated_at",
  ],
};

const COLLABORATION_V2_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ...COLLABORATION_V1_COLUMNS,
  issues: [...COLLABORATION_V1_COLUMNS.issues!, "issue_ref"],
  remote_bindings: [
    "generation", "project_key", "selector_commit", "provider", "workspace_id", "team_id", "provider_project_id",
    "journal_issue_id", "writer_id", "verified_at", "verification_json",
  ],
  remote_issue_identities: ["generation", "project_key", "provider_issue_id", "issue_ref"],
  remote_observations: [
    "generation", "project_key", "revision", "as_of", "completeness", "code", "snapshot_json", "received_at",
  ],
};

const COLLABORATION_OUTBOX_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  remote_outbox: [
    "operation_id", "generation", "project_key", "request_hash", "request_json", "execution_key_json", "state",
    "attempt_id", "created_at", "updated_at", "abandon_reason", "resolves", "resolved_by",
  ],
  remote_outbox_receipts: ["operation_id", "receipt_hash", "source", "outcome", "evidence_json", "recorded_at"],
};

const COLLABORATION_MOVE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  relations: ["from_issue", "relation", "to_issue", "to_ref"],
  issue_moves: [
    "operation_id", "role", "request_hash", "issue_ref", "source_issue_id", "destination_issue_id", "source_authority",
    "destination_authority", "destination_project", "actor", "reason", "phase", "payload_json", "payload_digest",
    "staged_counts", "source_store_id", "source_epoch", "removed_sync_rows", "created_at", "updated_at",
  ],
};

const COLLABORATION_ROUTE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  issue_moves: [...COLLABORATION_MOVE_COLUMNS.issue_moves!, "route"],
};

const COLLABORATION_V3_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ...COLLABORATION_V2_COLUMNS,
  ...COLLABORATION_OUTBOX_COLUMNS,
};

const COLLABORATION_V4_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ...COLLABORATION_V3_COLUMNS,
  ...COLLABORATION_MOVE_COLUMNS,
};

const COLLABORATION_V5_ROUTE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ...COLLABORATION_V4_COLUMNS,
  ...COLLABORATION_ROUTE_COLUMNS,
};

/** see packages/engine/src/collaboration-store.ts - The v6 inventory: the v5 generation plus the effort column, and the roadmap table the lane still carried before v7. A lane at v6 proves this shape before the v7 DDL. */
const COLLABORATION_V6_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ...COLLABORATION_V5_ROUTE_COLUMNS,
  project_milestones: [
    "milestone_id", "project_id", "project_kind", "name", "effort_sessions", "status", "ordinal", "revision",
    "created_at", "updated_at",
  ],
  project_roadmaps: ["project_id", "project_kind", "content_markdown", "content_hash", "revision", "updated_at"],
};

/** note: The exact current inventory: the v6 generation without the retired roadmap table. */
export const COLLABORATION_CURRENT_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(COLLABORATION_V6_COLUMNS).filter(([table]) => table !== COLLABORATION_ROADMAP_TABLE),
);

type ForeignKeyLayout = readonly (readonly [column: string, table: string, target: string])[];
type UniqueIndexLayout = Readonly<{ columns: readonly string[]; where: string | null }>;

type KeyLayout = Readonly<{
  table: string;
  notNull: readonly string[];
  primaryKey?: readonly string[];
  foreignKeys: readonly ForeignKeyLayout[];
  uniqueIndexes: readonly UniqueIndexLayout[];
  checks: readonly string[];
}>;

const COLLABORATION_KEY_LAYOUT_V2: readonly KeyLayout[] = [
  {
    table: "collaboration_meta",
    notNull: [],
    foreignKeys: [],
    uniqueIndexes: [],
    checks: ["check (mode in ('local','mirror','remote'))"],
  },
  {
    table: "issues",
    notNull: ["issue_ref"],
    foreignKeys: [[["milestone_id", "project_milestones", "milestone_id"]]],
    uniqueIndexes: [{ columns: ["issue_ref"], where: null }],
    checks: [],
  },
  {
    table: "remote_bindings",
    notNull: [
      "generation", "project_key", "selector_commit", "provider", "workspace_id", "team_id", "provider_project_id",
      "journal_issue_id", "verified_at", "verification_json",
    ],
    primaryKey: ["generation", "project_key"],
    foreignKeys: [],
    uniqueIndexes: [{ columns: ["generation", "provider", "workspace_id", "provider_project_id"], where: null }],
    checks: ["check (typeof(generation) = 'integer' and generation > 0)", "check (provider = 'linear')"],
  },
  {
    table: "remote_observations",
    notNull: ["generation", "project_key", "revision", "completeness", "received_at"],
    primaryKey: ["generation", "project_key"],
    foreignKeys: [
      [
        ["generation", "remote_bindings", "generation"],
        ["project_key", "remote_bindings", "project_key"],
      ],
    ],
    uniqueIndexes: [],
    checks: [
      "check (revision >= 0)",
      "check (completeness in ('complete','partial','unavailable'))",
      "check ( (completeness = 'unavailable' and snapshot_json is null and as_of is null) or " +
        "(completeness in ('complete','partial') and snapshot_json is not null and as_of is not null) )",
    ],
  },
  {
    table: "remote_issue_identities",
    notNull: ["generation", "project_key", "provider_issue_id"],
    primaryKey: ["generation", "project_key", "provider_issue_id"],
    foreignKeys: [
      [
        ["generation", "remote_observations", "generation"],
        ["project_key", "remote_observations", "project_key"],
      ],
    ],
    uniqueIndexes: [
      { columns: ["generation", "issue_ref"], where: "where issue_ref is not null" },
      { columns: ["generation", "provider_issue_id"], where: null },
    ],
    checks: [],
  },
];

const COLLABORATION_KEY_LAYOUT_OUTBOX: readonly KeyLayout[] = [
  {
    table: "remote_outbox",
    notNull: [
      "operation_id", "generation", "project_key", "request_hash", "request_json", "state", "created_at", "updated_at",
    ],
    primaryKey: ["operation_id"],
    foreignKeys: [
      [
        ["generation", "remote_bindings", "generation"],
        ["project_key", "remote_bindings", "project_key"],
      ],
      [["resolved_by", "remote_outbox", "operation_id"]],
      [["resolves", "remote_outbox", "operation_id"]],
    ],
    uniqueIndexes: [{ columns: ["attempt_id"], where: null }],
    checks: [
      "check (typeof(generation) = 'integer' and generation > 0)",
      "check (state in ('enqueued','unconfirmed','confirmed','conflict','abandoned'))",
    ],
  },
  {
    table: "remote_outbox_receipts",
    notNull: ["operation_id", "receipt_hash", "source", "outcome", "evidence_json", "recorded_at"],
    primaryKey: ["operation_id", "receipt_hash"],
    foreignKeys: [[["operation_id", "remote_outbox", "operation_id"]]],
    uniqueIndexes: [],
    checks: [
      "check (source in ('receipt','reconcile'))",
      "check (outcome in ('confirmed','unconfirmed','conflict','not-sent'))",
    ],
  },
];

const COLLABORATION_KEY_LAYOUT: readonly KeyLayout[] = [
  ...COLLABORATION_KEY_LAYOUT_V2,
  ...COLLABORATION_KEY_LAYOUT_OUTBOX,
];

const COLLABORATION_KEY_LAYOUT_MOVE: readonly KeyLayout[] = [
  {
    table: "relations",
    notNull: ["from_issue", "relation"],
    primaryKey: ["from_issue", "relation", "to_issue"],
    foreignKeys: [
      [["from_issue", "issues", "id"]],
      [["to_issue", "issues", "id"]],
    ],
    uniqueIndexes: [
      { columns: ["from_issue", "relation", "to_ref"], where: "where to_ref is not null" },
    ],
    checks: ["check ((to_issue is null) <> (to_ref is null))"],
  },
  {
    table: "issue_moves",
    notNull: [
      "operation_id", "role", "request_hash", "issue_ref", "source_authority", "destination_authority",
      "destination_project", "actor", "reason", "phase", "payload_json", "payload_digest", "staged_counts",
      "source_store_id", "source_epoch", "removed_sync_rows", "created_at", "updated_at",
    ],
    primaryKey: ["operation_id"],
    foreignKeys: [],
    uniqueIndexes: [
      {
        columns: ["issue_ref"],
        where: "where role = 'source' and phase in ('staged','verified','switched')",
      },
    ],
    checks: [
      "check (role in ('source','destination'))",
      "check (phase in ('staged','verified','switched','published','discarded'))",
    ],
  },
];

const COLLABORATION_KEY_LAYOUT_ROUTE: readonly KeyLayout[] = [
  COLLABORATION_KEY_LAYOUT_MOVE[0]!,
  {
    ...COLLABORATION_KEY_LAYOUT_MOVE[1]!,
    notNull: [...COLLABORATION_KEY_LAYOUT_MOVE[1]!.notNull, "route"],
    checks: [
      ...COLLABORATION_KEY_LAYOUT_MOVE[1]!.checks,
      "check (route in ('local-local', 'local-remote', 'remote-local', 'remote-unknown'))",
    ],
  },
];

const COLLABORATION_KEY_LAYOUT_CURRENT: readonly KeyLayout[] = [
  ...COLLABORATION_KEY_LAYOUT,
  ...COLLABORATION_KEY_LAYOUT_ROUTE,
];

const COLLABORATION_MOVE_TABLES: readonly string[] = ["issue_moves"];

/** see packages/engine/src/collaboration-store.ts - The v6 inventory: the current lane plus the roadmap table v7 drops. */
const COLLABORATION_V6_TABLES: readonly string[] = [...COLLABORATION_TABLES, COLLABORATION_ROADMAP_TABLE];

const COLLABORATION_V3_TABLES: readonly string[] = COLLABORATION_V6_TABLES.filter(
  (table) => !COLLABORATION_MOVE_TABLES.includes(table),
);

const COLLABORATION_V2_TABLES: readonly string[] = COLLABORATION_V3_TABLES.filter(
  (table) => !COLLABORATION_OUTBOX_TABLES.includes(table),
);

const COLLABORATION_V1_TABLES: readonly string[] = COLLABORATION_V6_TABLES.filter(
  (table) =>
    !COLLABORATION_REMOTE_TABLES.includes(table) &&
    !COLLABORATION_OUTBOX_TABLES.includes(table) &&
    !COLLABORATION_MOVE_TABLES.includes(table),
);

/**
 * The collaboration tables a combined source still holds, in dependency order
 * (parents before children). The cutover copies exactly these rows into the
 * staged target and the source fence drops exactly these tables in reverse
 * order. The lane-only names (`collaboration_meta`,
 * `collaboration_operations`, `cutover_publications`, `schema_version`) have no
 * combined-store counterpart and are created by the staged initializer.
 */
export const COLLABORATION_CUTOVER_TABLES: readonly string[] = [
  "catalog_entities",
  "catalog_links",
  "project_milestones",
  "issues",
  "occurrences",
  "relations",
  "provenance",
  "issue_transitions",
  "issue_project_moves",
  "issue_sync_state",
  "sync_cursor",
  "sync_runs",
  "project_bindings",
  "catalog_operations",
  "issue_counter",
];

/**
 * invariant: The tables the source fence DROPS, parents-first. It is the copied set plus the
 * retired roadmap table, which still exists in a combined source (immutable execution-store
 * migration 6 creates it) but has no counterpart in the lane any more: its content is not carried
 * forward, so the fence removes it. It lists `project_roadmaps` after `catalog_entities` because the
 * fence drops the list in reverse order - the child must go before the parent it references, or a
 * populated roadmap table rolls the whole fence back.
 */
export const COLLABORATION_SOURCE_DROP_TABLES: readonly string[] = [
  ...COLLABORATION_CUTOVER_TABLES.slice(0, 2),
  COLLABORATION_ROADMAP_TABLE,
  ...COLLABORATION_CUTOVER_TABLES.slice(2),
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
 * The collaboration lane's own verdict for a host authority gate: the ACTIVE
 * record, or the named reason no record can authorize a register write.
 * `staged`, `absent` and `unavailable` are all refusals — none of them is a
 * permission and none of them is inferred from the execution lane.
 */
export type CollaborationAuthorityProbe =
  | Readonly<{ kind: "active"; authority: CollaborationAuthority }>
  | Readonly<{ kind: "staged" | "absent" | "unavailable"; code: string; message: string }>;

/**
 * The scope a collaboration observation covers (contract §Read/Completeness).
 * The plan key is the exact stable plan catalog id; the repository identity is
 * the observation's `authority.repoKey`, never re-derived from a path.
 */
export type CollaborationScope = Readonly<{
  kind: "repository" | "project" | "plan" | "milestone" | "query";
  key: string;
}>;

/**
 * note: One selected project's provider scope and the evidence a remote read
 * disclosed for it. Only a remote observation carries these: a local/mirror
 * lane is one database, not a set of verified provider projects.
 */
export type CollaborationProviderScope = Readonly<{
  projectId: string;
  scope: Readonly<{ provider: "linear"; workspaceId: string; teamId: string; projectId: string }>;
  completeness: "complete" | "partial" | "unavailable";
  asOf: string | null;
  revision: number;
}>;

/**
 * One scoped read of the collaboration authority. `complete` is the only
 * observation a gate may decide on; `partial`/`unavailable` are declared so a
 * consumer can disclose a gap instead of reading it as an empty result.
 * `asOf` is when the local snapshot was established, never a file mtime.
 *
 * A remote observation additionally names its checked selector generation and,
 * per selected project, the provider scope plus that project's own coverage and
 * instant. Its `asOf` is the OLDEST contributing observation, and its
 * `authority` is the private cache identity, never the provider.
 */
export type CollaborationObservation = Readonly<{ scope: CollaborationScope }> &
  (
    | {
        completeness: "complete";
        asOf: string;
        authority: CollaborationStamp;
        revision: number;
        catalogRevision: number;
        source?: "local" | "remote";
        selectorCommit?: string;
        generation?: number;
        providerScopes?: readonly CollaborationProviderScope[];
      }
    | {
        completeness: "partial";
        asOf: string;
        authority: CollaborationStamp;
        revision: number;
        catalogRevision: number;
        code: string;
        source?: "local" | "remote";
        selectorCommit?: string;
        generation?: number;
        providerScopes?: readonly CollaborationProviderScope[];
      }
    | {
        completeness: "unavailable";
        asOf: null;
        authority: null;
        code: string;
        source?: "remote";
        selectorCommit?: string;
        generation?: number;
        providerScopes?: readonly CollaborationProviderScope[];
      }
  );

/** The complete arm of a collaboration observation: the only arm an in-domain read builds. */
export type CompleteCollaborationObservation = Extract<CollaborationObservation, { completeness: "complete" }>;

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

function unreadable(dbPath: string, detail: string, cause?: string): StoreError {
  return new StoreError(
    "collaboration.unreadable",
    `The collaboration store at ${dbPath} is not readable: ${detail}. Nothing was modified; a missing or broken ` +
      `store is created by the fresh initializer, and lost data is recovered from a verified backup pair.`,
    cause === undefined ? undefined : { cause },
  );
}

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

function busyRefusal(dbPath: string): StoreError {
  return new StoreError(
    "store.busy",
    `Another writer held the collaboration store at ${dbPath} past the bounded wait (${busyTimeoutMs()}ms). ` +
      `Retry when the competing writer is done; no write was accepted.`,
  );
}

const PASS_THROUGH_STORE_CODES: Readonly<Record<string, true>> = {
  "store.busy": true,
  "store.schema-unsupported": true,
  "store.runtime-unsupported": true,
};

function asRefusal(dbPath: string, error: unknown): StoreError {
  if (error instanceof StoreError) {
    if (error.code.startsWith("collaboration.") || PASS_THROUGH_STORE_CODES[error.code] === true) return error;
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

function upgradeRequired(location: CollaborationLocation, found: number): StoreError {
  const current = COLLABORATION_MIGRATIONS[COLLABORATION_MIGRATIONS.length - 1]!.version;
  const recovery =
    location.mode === "remote"
      ? `A remote cache is derived observation state and is never upgraded in place: run ` +
        `"mstar store collaboration remote bind --harness <abs> --input <file|->" with a verified batch that ` +
        `proves the current provider scope (its document shape is published by ` +
        `"mstar schema --command store.collaboration.remote.bind"), which replaces a pre-v${String(current)} cache ` +
        `under the checked selector`
      : `run "mstar store upgrade --operator <name>" once for this scope`;
  return new StoreError(
    "collaboration.upgrade-required",
    `The collaboration store at ${location.dbPath} records schema version ${String(found)}, and this build reads ` +
      `version ${String(current)}. Ordinary reads never migrate a lane: ${recovery}, then retry the same verb. ` +
      `Nothing was read or modified.`,
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

function assertRegularTarget(dbPath: string): void {
  try {
    assertAbsentOrRegularStoreFile(dbPath);
  } catch (error) {
    throw asRefusal(dbPath, error);
  }
}

function privateStoreAnchor(): string {
  return join(homedir(), ".mstar", "repos");
}

function assertPrivateStorePath(dbPath: string): void {
  const target = resolve(dbPath);
  const home = resolve(homedir());
  const anchor = privateStoreAnchor();
  if (target !== anchor && !target.startsWith(`${anchor}${sep}`)) {
    throw unreadable(target, `it is not inside the private user storage root ${anchor}`);
  }
  const segments = relative(home, dirname(target)).split(sep).filter((segment) => segment.length > 0);
  let current = home;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw unreadable(current, `a storage component could not be examined (${publicationCause(error)})`);
    }
    const storageComponent = index >= 1;
    if (stats.isSymbolicLink()) throw unreadable(current, "a storage component is a symbolic link");
    if (!stats.isDirectory()) throw unreadable(current, "a storage component is not a directory");
    if (storageComponent && (stats.mode & 0o077) !== 0) {
      throw unreadable(current, `a storage directory is not private (mode ${(stats.mode & 0o777).toString(8)})`);
    }
  }
}

function assertPrivateStoreFile(dbPath: string): void {
  let stats;
  try {
    stats = lstatSync(dbPath);
  } catch (error) {
    throw unreadable(dbPath, `the store file could not be examined (${publicationCause(error)})`);
  }
  if (!stats.isFile()) throw unreadable(dbPath, "the store path is not a regular file");
  if ((stats.mode & 0o077) !== 0) {
    throw unreadable(dbPath, `the store file is not private (mode ${(stats.mode & 0o777).toString(8)})`);
  }
}

function assertAdmittedTarget(dbPath: string): void {
  assertPrivateStorePath(dbPath);
  assertRegularTarget(dbPath);
  if (!existsSync(dbPath)) return;
  assertPrivateStoreFile(dbPath);
  const walSidecar = existsSync(`${dbPath}-wal`);
  if (walSidecar || walShapedStoreFile(dbPath)) {
    throw unreadable(
      dbPath,
      `it is a WAL-journal store (${walSidecar ? "a -wal sidecar is present" : "its header records WAL"}); the ` +
        `collaboration lane admits only a completed DELETE-journal store. Stop every writer and checkpoint or ` +
        `convert the database back to a rollback journal, or recover from a verified backup pair; no journal was ` +
        `repaired or created`,
    );
  }
}

function assertCurrentSchema(db: StoreDb, dbPath: string): void {
  assertInventory(db, dbPath, COLLABORATION_TABLES, COLLABORATION_CURRENT_COLUMNS, true);
  assertKeyLayout(db, dbPath, COLLABORATION_KEY_LAYOUT_CURRENT);
}

function assertRemoteCacheSchema(db: StoreDb, dbPath: string): void {
  assertInventory(db, dbPath, COLLABORATION_V2_TABLES, COLLABORATION_V2_COLUMNS, true);
  assertKeyLayout(db, dbPath, COLLABORATION_KEY_LAYOUT_V2);
}

function assertOutboxSchema(db: StoreDb, dbPath: string): void {
  assertInventory(db, dbPath, COLLABORATION_V3_TABLES, COLLABORATION_V3_COLUMNS, true);
  assertKeyLayout(db, dbPath, COLLABORATION_KEY_LAYOUT);
}

function assertMoveSchema(db: StoreDb, dbPath: string): void {
  assertInventory(db, dbPath, COLLABORATION_V6_TABLES, COLLABORATION_V4_COLUMNS, true);
  assertKeyLayout(db, dbPath, [...COLLABORATION_KEY_LAYOUT, ...COLLABORATION_KEY_LAYOUT_MOVE]);
}

function assertLegacySchema(db: StoreDb, dbPath: string): void {
  assertInventory(db, dbPath, COLLABORATION_V1_TABLES, COLLABORATION_V1_COLUMNS, false);
}

function assertMoveRouteSchema(db: StoreDb, dbPath: string): void {
  assertInventory(db, dbPath, COLLABORATION_V6_TABLES, COLLABORATION_V5_ROUTE_COLUMNS, true);
  assertKeyLayout(db, dbPath, COLLABORATION_KEY_LAYOUT_CURRENT);
}

/** see packages/engine/src/collaboration-store.ts - The exact v6 shape an upgrade from v6 proves before the v7 roadmaps drop: a partial v7 refuses. */
function assertMilestoneEffortSchema(db: StoreDb, dbPath: string): void {
  assertInventory(db, dbPath, COLLABORATION_V6_TABLES, COLLABORATION_V6_COLUMNS, true);
  assertKeyLayout(db, dbPath, COLLABORATION_KEY_LAYOUT_CURRENT);
}

function assertVersionInventory(db: StoreDb, dbPath: string, version: number): void {
  const inventory = collaborationInventoryOf(version);
  if (inventory === COLLABORATION_CURRENT_COLUMNS) assertCurrentSchema(db, dbPath);
  else if (inventory === COLLABORATION_V6_COLUMNS) assertMilestoneEffortSchema(db, dbPath);
  else if (inventory === COLLABORATION_V5_ROUTE_COLUMNS) assertMoveRouteSchema(db, dbPath);
  else if (inventory === COLLABORATION_V4_COLUMNS) assertMoveSchema(db, dbPath);
  else if (inventory === COLLABORATION_V3_COLUMNS) assertOutboxSchema(db, dbPath);
  else if (inventory === COLLABORATION_V2_COLUMNS) assertRemoteCacheSchema(db, dbPath);
  else assertLegacySchema(db, dbPath);
}

function assertInventory(
  db: StoreDb,
  dbPath: string,
  tablesWanted: readonly string[],
  columnsWanted: Readonly<Record<string, readonly string[]>>,
  exactColumns: boolean,
): void {
  const rows = db.prepare("select name from sqlite_master where type = 'table'").all();
  const present = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== "object" || !("name" in row)) continue;
    const name = row.name;
    if (typeof name === "string" && !name.startsWith("sqlite_")) present.add(name);
  }
  const missing = tablesWanted.filter((name) => !present.has(name));
  const unexpected = [...present].filter((name) => !tablesWanted.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw unreadable(
      dbPath,
      `its schema is not the current collaboration inventory (missing: ${missing.join(", ") || "none"}; ` +
        `unexpected: ${unexpected.join(", ") || "none"})`,
    );
  }
  const damaged = columnDrift(db, columnsWanted, exactColumns);
  if (damaged.length > 0) {
    throw unreadable(dbPath, `its schema does not carry the required columns: ${damaged.join("; ")}`);
  }
}

function columnDrift(
  db: StoreDb,
  required: Readonly<Record<string, readonly string[]>>,
  exact: boolean,
): string[] {
  const damaged: string[] = [];
  for (const [table, columnsWanted] of Object.entries(required)) {
    const columns = (db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: unknown }>).map((column) =>
      String(column.name),
    );
    const lost = columnsWanted.filter((column) => !columns.includes(column));
    const added = exact ? columns.filter((column) => !columnsWanted.includes(column)) : [];
    if (lost.length > 0 || added.length > 0) {
      damaged.push(`${table}(missing: ${lost.join(", ") || "none"}; unexpected: ${added.join(", ") || "none"})`);
    }
  }
  return damaged;
}

function foreignKeyGroups(db: StoreDb, table: string): string[] {
  const rows = db.prepare(`pragma foreign_key_list(${table})`).all() as Array<{
    id?: unknown;
    seq?: unknown;
    from?: unknown;
    table?: unknown;
    to?: unknown;
  }>;
  const groups = new Map<number, Array<{ seq: number; entry: string }>>();
  for (const row of rows) {
    if (typeof row.id !== "number" || typeof row.seq !== "number") continue;
    const entry = `${String(row.from)}->${String(row.table)}.${String(row.to)}`;
    const group = groups.get(row.id) ?? [];
    group.push({ seq: row.seq, entry });
    groups.set(row.id, group);
  }
  return [...groups.values()]
    .map((group) => group.sort((left, right) => left.seq - right.seq).map((item) => item.entry).join(","))
    .sort();
}

function indexPredicate(sql: string | null): string | null {
  if (sql === null) return null;
  const match = /\bon\s+\S+\s*\([^)]*\)\s*(.*)$/i.exec(sql.replace(/\s+/g, " ").trim());
  const predicate = match === null ? "" : (match[1] ?? "").trim().toLowerCase();
  return predicate === "" ? null : predicate;
}

function uniqueIndexLayouts(db: StoreDb, table: string): UniqueIndexLayout[] {
  const rows = (db.prepare(`pragma index_list(${table})`).all() as Array<{ name?: unknown; unique?: unknown }>).filter(
    (index) => index.unique === 1 && typeof index.name === "string",
  );
  return rows.map((index) => {
    const name = String(index.name);
    const columns = (db.prepare(`pragma index_info(${name})`).all() as Array<{ name?: unknown }>).map((column) =>
      String(column.name),
    );
    const declared = db.prepare("select sql from sqlite_master where type = 'index' and name = ?").get(name) as
      | { sql?: unknown }
      | undefined;
    return {
      columns,
      where: indexPredicate(declared !== undefined && typeof declared.sql === "string" ? declared.sql : null),
    };
  });
}

function assertKeyLayout(
  db: StoreDb,
  dbPath: string,
  layouts: readonly KeyLayout[] = COLLABORATION_KEY_LAYOUT,
): void {
  const refusal = (table: string, detail: string): never => {
    throw unreadable(dbPath, `its ${table} ${detail}`);
  };
  for (const layout of layouts) {
    const columns = db.prepare(`pragma table_info(${layout.table})`).all() as Array<{
      name?: unknown;
      notnull?: unknown;
      pk?: unknown;
    }>;
    const byName = new Map(columns.map((column) => [String(column.name), column]));
    const nullable = layout.notNull.filter((column) => byName.get(column)?.notnull !== 1);
    if (nullable.length > 0) refusal(layout.table, `accepts null in ${nullable.join(", ")}`);
    if (layout.primaryKey !== undefined) {
      const actual = columns
        .filter((column) => typeof column.pk === "number" && column.pk > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk))
        .map((column) => String(column.name))
        .join(",");
      const wanted = layout.primaryKey.join(",");
      if (actual !== wanted) refusal(layout.table, `primary key is (${actual}) instead of (${wanted})`);
    }
    const foreignKeys = foreignKeyGroups(db, layout.table);
    const wantedKeys = layout.foreignKeys
      .map((group) => group.map(([column, table, target]) => `${column}->${table}.${target}`).join(","))
      .sort();
    if (foreignKeys.join("|") !== wantedKeys.join("|")) {
      refusal(layout.table, `foreign keys are (${foreignKeys.join(" | ") || "none"})`);
    }
    const uniqueIndexes = uniqueIndexLayouts(db, layout.table);
    for (const wanted of layout.uniqueIndexes) {
      const columns = wanted.columns.join(",");
      if (!uniqueIndexes.some((index) => index.columns.join(",") === columns && index.where === wanted.where)) {
        refusal(
          layout.table,
          `lacks a unique index on (${wanted.columns.join(", ")})${wanted.where === null ? "" : ` ${wanted.where}`}`,
        );
      }
    }
    const declared = db
      .prepare("select sql from sqlite_master where type = 'table' and name = ?")
      .get(layout.table) as { sql?: unknown } | undefined;
    const definition =
      declared !== undefined && typeof declared.sql === "string"
        ? declared.sql.replace(/\s+/g, " ").toLowerCase()
        : "";
    for (const check of layout.checks) {
      if (!definition.includes(check)) refusal(layout.table, `lacks the CHECK ${check}`);
    }
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
    (record.mode !== "local" && record.mode !== "mirror" && record.mode !== "remote") ||
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

function validateCollaborationMigrations(applied: AppliedMigration[]): number {
  const version = validateAppliedMigrations(applied, COLLABORATION_MIGRATIONS);
  for (const row of applied) {
    const compiled = COLLABORATION_MIGRATIONS.find((migration) => migration.version === row.version)!;
    if (row.name !== compiled.name || row.checksum !== migrationChecksum(compiled)) {
      throw new StoreError(
        "store.corrupt",
        `The collaboration store records a v${String(row.version)} "${row.name}" migration that is not this build's ` +
          `compiled "${compiled.name}" migration; the lane is refused rather than trusted on unknown bytes. ` +
          `Nothing was modified.`,
        { migration: row.version, recordedChecksum: row.checksum, compiledChecksum: migrationChecksum(compiled) },
      );
    }
  }
  return version;
}

function admit(
  db: StoreDb,
  location: CollaborationLocation,
  expected: CollaborationStamp | undefined,
  requirement: "active" | "any",
  options: RemoteCacheAdmission = {},
): CollaborationAuthority {
  try {
    const schemaVersion = validateCollaborationMigrations(readAppliedMigrations(db, false));
    const current = COLLABORATION_MIGRATIONS[COLLABORATION_MIGRATIONS.length - 1]!.version;
    const settlesOutbox =
      options.settleOutbox === true &&
      location.mode === "remote" &&
      schemaVersion >= COLLABORATION_OUTBOX_SCHEMA.version &&
      schemaVersion < current;
    if (schemaVersion < current && !settlesOutbox) throw upgradeRequired(location, schemaVersion);
    if (settlesOutbox) assertVersionInventory(db, location.dbPath, schemaVersion);
    else assertCurrentSchema(db, location.dbPath);
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

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

const TRANSACTION_CONTROL_KEYWORDS: Readonly<Record<string, true>> = {
  BEGIN: true,
  COMMIT: true,
  END: true,
  ROLLBACK: true,
  SAVEPOINT: true,
  RELEASE: true,
};

function leadingKeyword(sql: string): string {
  let rest = sql;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) {
      const lineEnd = trimmed.indexOf("\n");
      rest = lineEnd === -1 ? "" : trimmed.slice(lineEnd + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const commentEnd = trimmed.indexOf("*/");
      rest = commentEnd === -1 ? "" : trimmed.slice(commentEnd + 2);
      continue;
    }
    if (trimmed.startsWith(";")) {
      rest = trimmed.slice(1);
      continue;
    }
    const word = /^[A-Za-z]+/.exec(trimmed);
    return word === null ? "" : word[0].toUpperCase();
  }
}

function transactionOwnershipRefusal(): StoreError {
  return new StoreError(
    "store.corrupt",
    "The collaboration write transaction is owned by withCollaborationWrite; the effect cannot begin, commit, " +
      "roll back, release or close it, and nothing was written.",
  );
}

function batchRefusal(): StoreError {
  return new StoreError(
    "store.corrupt",
    "The collaboration write transaction is owned by withCollaborationWrite: the effect may not run `exec` " +
      "batches (a later statement could end the transaction). Use `prepare(...)` and run one statement at a " +
      "time; nothing was written.",
  );
}

function guardedWriteDb(db: StoreDb): StoreDb {
  return {
    exec(): never {
      throw batchRefusal();
    },
    prepare(sql: string) {
      if (TRANSACTION_CONTROL_KEYWORDS[leadingKeyword(sql)] === true) throw transactionOwnershipRefusal();
      return db.prepare(sql);
    },
    close(): never {
      throw transactionOwnershipRefusal();
    },
  };
}

async function connectAt(
  dbPath: string,
  mode: "read" | "write",
  timeout: number,
  options: StoreConnectOptions = {},
): Promise<StoreDb> {
  const attempts = mode === "read" ? READ_OPEN_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect(dbPath, mode, timeout, options);
    } catch (error) {
      if (attempt < attempts && isTransientReadOpenFailure(error, dbPath)) {
        await sleep(READ_OPEN_BACKOFF_MS);
        continue;
      }
      throw asRefusal(dbPath, error);
    }
  }
}

async function openAdmission(
  location: CollaborationLocation,
  requirement: "active" | "any",
  expected: CollaborationStamp | undefined,
  timeout: number,
  options: RemoteCacheAdmission = {},
): Promise<CollaborationStoreHandle> {
  const dbPath = location.dbPath;
  assertAdmittedTarget(dbPath);
  if (!existsSync(dbPath)) throw notInitialized(dbPath);
  const db = await connectAt(dbPath, "read", timeout);
  try {
    return handleFor(db, admit(db, location, expected, requirement, options));
  } catch (error) {
    db.close();
    throw error;
  }
}

function confirmPublishedChain(dbPath: string): void {
  const synced: Record<string, true> = {};
  const sync = (target: string): void => {
    if (synced[target] === true) return;
    synced[target] = true;
    try {
      syncDirectoryEntry(target);
    } catch (error) {
      throw barrierRefusal(dbPath, error);
    }
  };
  const home = resolve(homedir());
  sync(home);
  let current = home;
  for (const segment of relative(home, dirname(dbPath)).split(sep).filter((part) => part.length > 0)) {
    current = join(current, segment);
    sync(current);
  }
}

async function continueExisting(location: CollaborationLocation, timeout: number): Promise<CollaborationAuthority> {
  const handle = await openAdmission(location, "any", undefined, timeout);
  const authority = handle.authority;
  handle.close();
  confirmPublishedChain(location.dbPath);
  return authority;
}

type OutboxSettlementLink = Readonly<{ state: string; resolvedBy: string | null }>;

function settlementReached(chain: ReadonlyMap<string, OutboxSettlementLink>, start: string): boolean {
  const visited = new Set<string>();
  let cursor: string | null = start;
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    const link = chain.get(cursor);
    if (link === undefined) return false;
    if (link.state === "confirmed") return true;
    if (link.state !== "conflict") return false;
    cursor = link.resolvedBy;
  }
  return false;
}

function countUnsettledOutboxIntents(db: StoreDb, dbPath: string): number {
  const rows = db.prepare("select operation_id, state, resolved_by from remote_outbox").all() as Array<{
    operation_id?: unknown;
    state?: unknown;
    resolved_by?: unknown;
  }>;
  const chain = new Map<string, OutboxSettlementLink>();
  for (const row of rows) {
    if (typeof row.operation_id !== "string" || typeof row.state !== "string") {
      throw unreadable(dbPath, "its remote_outbox intent ledger cannot be read");
    }
    chain.set(row.operation_id, {
      state: row.state,
      resolvedBy: typeof row.resolved_by === "string" ? row.resolved_by : null,
    });
  }
  let unsettled = 0;
  for (const link of chain.values()) {
    if (link.state === "enqueued" || link.state === "unconfirmed") unsettled += 1;
    else if (link.state === "conflict" && (link.resolvedBy === null || !settlementReached(chain, link.resolvedBy))) {
      unsettled += 1;
    }
  }
  return unsettled;
}

type CarriedRow = ReadonlyArray<string | number | null>;

type CarriedOutboxLedger = Readonly<{
  bindings: readonly CarriedRow[];
  intents: readonly CarriedRow[];
  receipts: readonly CarriedRow[];
  moves: Readonly<{ columns: readonly string[]; rows: readonly CarriedRow[] }>;
  predecessorMode: string | null;
}>;

const CARRIED_BINDING_COLUMNS =
  "generation, project_key, selector_commit, provider, workspace_id, team_id, provider_project_id, " +
  "journal_issue_id, writer_id, verified_at, verification_json";
const CARRIED_INTENT_COLUMNS =
  "operation_id, generation, project_key, request_hash, request_json, execution_key_json, state, attempt_id, " +
  "created_at, updated_at, abandon_reason, resolves, resolved_by";
const CARRIED_RECEIPT_COLUMNS = "operation_id, receipt_hash, source, outcome, evidence_json, recorded_at";

async function readSettledOutboxLedger(dbPath: string, timeout: number): Promise<CarriedOutboxLedger> {
  const db = await connectAt(dbPath, "read", timeout);
  try {
    const tables = tableNamesOn(db);
    const rows = (sql: string): CarriedRow[] =>
      (db.prepare(sql).all() as Array<Record<string, string | number | null>>).map((row) => Object.values(row));
    const moveColumns = tables.has("issue_moves")
      ? (db.prepare("pragma table_info(issue_moves)").all() as Array<{ name?: unknown }>)
          .map((column) => (typeof column?.name === "string" ? column.name : ""))
          .filter((name) => name.length > 0)
      : [];
    const moves =
      moveColumns.length > 0
        ? { columns: moveColumns, rows: rows(`select ${moveColumns.join(", ")} from issue_moves order by operation_id`) }
        : { columns: [], rows: [] as CarriedRow[] };
    const metaMode = tables.has("collaboration_meta")
      ? (db.prepare("select mode from collaboration_meta where id = 1").get() as { mode?: unknown } | undefined)?.mode
      : undefined;
    const predecessorMode = typeof metaMode === "string" ? metaMode : null;
    if (!tables.has("remote_outbox")) return { bindings: [], intents: [], receipts: [], moves, predecessorMode };
    return {
      moves,
      predecessorMode,
      bindings: rows(
        `select ${CARRIED_BINDING_COLUMNS} from remote_bindings b where exists ` +
          `(select 1 from remote_outbox o where o.generation = b.generation and o.project_key = b.project_key) ` +
          `order by generation, project_key`,
      ),
      intents: rows(`select ${CARRIED_INTENT_COLUMNS} from remote_outbox order by operation_id`),
      receipts: tables.has("remote_outbox_receipts")
        ? rows(`select ${CARRIED_RECEIPT_COLUMNS} from remote_outbox_receipts order by operation_id, receipt_hash`)
        : [],
    };
  } finally {
    db.close();
  }
}

/**
 * invariant: The v5 generation's own label for one unrouted ledger half: a lane holds only its
 * own half of a move, so an unrouted row is an exchange half and the LANE'S OWN mode names its
 * side - `role 'source'` is `remote-unknown` on a remote lane and `local-remote` otherwise, and
 * `role 'destination'` is `local-remote` on a remote lane and `remote-local` otherwise. The
 * carry and the ladder never invent a different derivation.
 */
export function unroutedMoveHalfRoute(role: unknown, mode: string | null): string {
  const remote = mode === "remote";
  return role === "source" ? (remote ? "remote-unknown" : "local-remote") : remote ? "local-remote" : "remote-local";
}

function carrySettledOutbox(db: StoreDb, carried: CarriedOutboxLedger): void {
  if (carried.intents.length === 0 && carried.moves.rows.length === 0) return;
  db.exec("pragma defer_foreign_keys = ON");
  const copy = (sql: string, rows: readonly CarriedRow[]): void => {
    const insert = db.prepare(sql);
    for (const row of rows) insert.run(...row);
  };
  copy(
    "insert into remote_bindings(" + CARRIED_BINDING_COLUMNS + ") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    carried.bindings,
  );
  copy(
    "insert into remote_outbox(" + CARRIED_INTENT_COLUMNS + ") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    carried.intents,
  );
  copy(
    "insert into remote_outbox_receipts(" + CARRIED_RECEIPT_COLUMNS + ") values (?, ?, ?, ?, ?, ?)",
    carried.receipts,
  );
  if (carried.moves.columns.length > 0 && carried.moves.rows.length > 0) {
    if (carried.moves.columns.includes("route")) {
      copy(
        `insert into issue_moves(${carried.moves.columns.join(", ")}) values (${carried.moves.columns.map(() => "?").join(", ")})`,
        carried.moves.rows,
      );
    } else {
      const roleIndex = carried.moves.columns.indexOf("role");
      if (roleIndex < 0) {
        throw new StoreError("store.corrupt", "the carried move ledger declares no role column; its rows cannot be labelled");
      }
      const columns = [...carried.moves.columns, "route"];
      const rows = carried.moves.rows.map((row) => {
        return [...row, unroutedMoveHalfRoute(row[roleIndex], carried.predecessorMode)];
      });
      copy(
        `insert into issue_moves(${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
        rows,
      );
    }
  }
}

type ConflictRepairHop =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "damaged" }>
  | Readonly<{
      kind: "repair";
      state: string;
      resolvedBy: string | null;
      launderingRefused: boolean;
    }>;

function conflictRepairHop(
  db: StoreDb,
  conflict: { generation: unknown; project_key: unknown },
  parentId: string,
  cursor: string | null,
  receiptsPresent: boolean,
): ConflictRepairHop {
  if (cursor === null) return { kind: "absent" };
  const linked = db
    .prepare("select generation, project_key, state, resolved_by, resolves from remote_outbox where operation_id = ?")
    .get(cursor) as
    | { generation?: unknown; project_key?: unknown; state?: unknown; resolved_by?: unknown; resolves?: unknown }
    | undefined;
  if (linked === undefined || typeof linked.state !== "string") return { kind: "damaged" };
  if (linked.generation !== conflict.generation || linked.project_key !== conflict.project_key || linked.resolves !== parentId) {
    return { kind: "damaged" };
  }
  const resolvedBy = typeof linked.resolved_by === "string" ? linked.resolved_by : null;
  const launderingRefused =
    receiptsPresent &&
    linked.state === "confirmed" &&
    !hasConfirmedReceipt(db, cursor) &&
    db
      .prepare("select 1 as found from remote_outbox_receipts where operation_id = ? and outcome = 'conflict' limit 1")
      .get(cursor) !== undefined;
  return { kind: "repair", state: linked.state, resolvedBy, launderingRefused };
}

/**
 * note: Recorded confirmation of one operation: the receipt row a `confirmed` state rests on.
 * Only `recordReceiptEvidence` writes that state, and it records this receipt in the same
 * transaction, so a confirmed row without one is a damaged or foreign cache.
 */
export function hasConfirmedReceipt(db: StoreDb, operationId: string): boolean {
  return (
    db
      .prepare("select 1 as found from remote_outbox_receipts where operation_id = ? and outcome = 'confirmed' limit 1")
      .get(operationId) !== undefined
  );
}

/**
 * note: The settle rule reads the receipts table, so bytes without one prove no confirmation:
 * nothing there is settled, and no statement runs against a missing table.
 */
export function hasReceiptLedger(db: StoreDb): boolean {
  return (
    Number(
      (
        db.prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'remote_outbox_receipts'").get() as
          | { n?: unknown }
          | undefined
      )?.n ?? 0,
    ) > 0
  );
}

/**
 * note: The settle rule for one conflict row: it is settled exactly when its `resolved_by`
 * repair chain reaches a `confirmed` repair that HOLDS RECORDED EVIDENCE - a
 * `remote_outbox_receipts` row with outcome `confirmed` for that operation id. The state column
 * is not proof by itself. `abandonRemoteIntent` refuses a conflict row, so the parent itself can
 * never be abandoned, and `prepareRemoteResolution` refuses a second resolution while the linked
 * one is live, so the single `resolved_by` pointer names the only repair that could have
 * confirmed. An abandoned, missing, unproven or non-confirmed link therefore leaves the parent
 * unsettled: a withdrawn review (the linked repair abandoned) blocks the replacement again until
 * a new reviewed resolution is prepared and confirmed.
 */
export function conflictRepairSettled(
  db: StoreDb,
  row: { operation_id: string; generation: unknown; project_key: unknown; state: string; resolved_by: unknown },
  receiptsPresent: boolean,
): boolean {
  if (row.state !== "conflict") return false;
  let parentId = row.operation_id;
  let cursor = typeof row.resolved_by === "string" ? row.resolved_by : null;
  const visited = new Set<string>();
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    const hop = conflictRepairHop(db, row, parentId, cursor, receiptsPresent);
    if (hop.kind !== "repair") return false;
    if (hop.state === "confirmed") return hasConfirmedReceipt(db, cursor);
    if (hop.state !== "conflict") return false;
    parentId = cursor;
    cursor = hop.resolvedBy;
  }
  return false;
}

/**
 * note: The one published route out of a cache whose bytes an in-place settlement cannot honor.
 * A single text because three refusals publish it (the damaged-link branch, the laundering
 * branch and the receipt guard in collaboration-remote.ts), and because the cache can hold OTHER
 * unsettled intents - including a permitted send whose provider outcome is unknown. Stopping a
 * checkout proves nothing about those effects, so nothing may be deleted before they are settled
 * and the bytes recording them are retained: a fresh bind never restores an attempt id, a frozen
 * request or a receipt.
 */
export const REMOTE_CACHE_REBUILD_ROUTE =
  "rebuild the derived cache through the ordinary bootstrap - stop every checkout of this repository that has " +
  "the cache bound (the cache is user-level, not per checkout); settle every other unsettled intent that cache " +
  "holds through the outbox verbs its own state line names, before anything is removed, because stopping a " +
  "checkout proves nothing about a permitted send whose outcome is unknown at the provider, and the file holds " +
  "the only attempt ids, frozen requests and receipts that settling such an intent needs; for anything still " +
  "unsettled or unreadable, keep the cache file as evidence - move it aside under a retained name instead of " +
  "deleting it, since it is the only record of an effect that may already have happened at the provider and a " +
  "fresh bind never restores it; then confirm the checked selector and this checkout's binding satisfy a fresh " +
  "reviewed bind, and if they do not, correct the selector and keep the retained copy until they do, deleting " +
  "nothing; only then remove the name the checkout " +
  "reads (or confirm it is gone), run `mstar store collaboration remote status`, and perform a fresh reviewed " +
  "remote bind - and the pending intent's record is not preserved by the rebuild itself: the retained copy " +
  "preserves it, and an operator can inspect it later.";

async function replaceDerivedLaneBelow(
  location: CollaborationLocation,
  below: number,
  timeout: number,
  expected: RetainedLaneIdentity | undefined,
): Promise<RetainedLaneIdentity | undefined> {
  const dbPath = location.dbPath;
  const db = await connectAt(dbPath, "read", timeout);
  type OutboxRow = {
    operation_id: string;
    generation: unknown;
    project_key: unknown;
    state: string;
    created_at: string;
    resolved_by: unknown;
  };
  type UnsettledRow = OutboxRow & Readonly<{ repair: ConflictRepairHop }>;
  let recorded: { version: number; meta: CollaborationMeta; unsettled: UnsettledRow[] };
  try {
    const outboxPresent = db
      .prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'remote_outbox'")
      .get() as { n?: unknown };
    const receiptsPresent = hasReceiptLedger(db);
    const unsettled: UnsettledRow[] =
      Number(outboxPresent?.n ?? 0) === 0
        ? []
        : (db
            .prepare(
              "select operation_id, generation, project_key, state, created_at, resolved_by " +
                "from remote_outbox where state not in ('confirmed','abandoned') order by created_at, operation_id",
            )
            .all() as OutboxRow[])
            .filter((row) => !(receiptsPresent && conflictRepairSettled(db, row, receiptsPresent)))
            .map((row) => ({
              ...row,
              repair:
                row.state === "conflict"
                  ? conflictRepairHop(db, row, row.operation_id, typeof row.resolved_by === "string" ? row.resolved_by : null, receiptsPresent)
                  : ({ kind: "absent" } as const),
            }));
    recorded = {
      version: validateCollaborationMigrations(readAppliedMigrations(db, false)),
      meta: readMeta(db),
      unsettled,
    };
  } finally {
    db.close();
  }
  if (recorded.version >= below) return undefined;
  if (recorded.meta.repoKey !== location.repoKey || recorded.meta.mode !== location.mode) {
    throw staleBinding(dbPath, recorded.meta, `this checkout's ${location.repoKey} (${location.mode})`);
  }
  if (
    expected !== undefined &&
    (recorded.meta.storeId !== expected.storeId || recorded.meta.epoch !== expected.epoch)
  ) {
    throw staleBinding(
      dbPath,
      recorded.meta,
      `this checkout's recorded cache store ${expected.storeId} epoch ${String(expected.epoch)}`,
    );
  }
  if (recorded.unsettled.length > 0) {
    const cli = (verb: string): string => `mstar store collaboration remote ${verb}`;
    const showCommand = (operation: string): string =>
      "`" + cli("outbox-show") + " --harness <abs> --operation " + operation + "`";
    const shown = (operation: string): string => "read it with " + showCommand(operation);
    const resolved = (): string =>
      "`" + cli("outbox-resolve") + " --harness <abs> --operation <conflicted-uuid> --input <file>`";
    const dispatched = (operation: string): string =>
      "`" + cli("outbox-dispatch") + " --harness <abs> --operation " + operation + " --input <file|->`";
    const withdrawn = (operation: string): string =>
      "`" + cli("outbox-abandon") + " --harness <abs> --operation " + operation + " --reason <text>`";
    const evidenced = (): string =>
      "`" + cli("outbox-receipt") + " --harness <abs> --input <file|->`";
    const reconciled = (): string =>
      "`" + cli("outbox-reconcile") + " --harness <abs> --input <file|->`";
    const rebuild = REMOTE_CACHE_REBUILD_ROUTE;
    const conflictStep = (repair: ConflictRepairHop): string => {
      if (repair.kind === "damaged") {
        return shown("<uuid>") + ". Its recorded resolvedBy link is damaged - the operation it names is missing, " +
          "belongs to another generation or project, or carries no reverse resolves pointer - so a reviewed resolve " +
          "refuses while that link stands and no receipt or fresh reviewed bind can settle it in this scope: " + rebuild;
      }
      if (repair.kind === "absent") {
        return shown("<uuid>") + ". It carries no live repair, so prepare one with " + resolved() +
          " - a resolve only enqueues the repair - then dispatch it with " + dispatched("<new-uuid>") +
          " and record its confirming receipt with " + evidenced();
      }
      const follow = "follow the repair its resolvedBy names with " + showCommand("<repair-uuid>");
      if (repair.state === "confirmed") {
        if (repair.launderingRefused) {
          return shown("<uuid>") + "; its repair is marked confirmed but holds only a recorded conflict receipt, so " +
            "its recorded state contradicts its recorded evidence and this scope cannot settle it in place: " + rebuild;
        }
        return shown("<uuid>") + "; its repair is marked confirmed but holds no recorded confirmed receipt, so that " +
          "effect is not proven and the settle rule does not count it: record that receipt with " + evidenced() +
          " (a reconcile under the original binding records the same evidence)";
      }
      if (repair.state === "enqueued") {
        return shown("<uuid>") + "; its repair is enqueued, so " + follow + ", then either withdraw it with " +
          withdrawn("<repair-uuid>") + " or dispatch it with " + dispatched("<repair-uuid>") +
          " and record its confirming receipt with " + evidenced();
      }
      if (repair.state === "unconfirmed") {
        return shown("<uuid>") + "; its repair is unconfirmed, so " + follow +
          ". An unconfirmed repair is withdrawable only behind its ORIGINAL dispatching host's own not-sent receipt: " +
          "record it with " + evidenced() + " (a reconcile records no not-sent outcome) and only then withdraw it with " +
          withdrawn("<repair-uuid>");
      }
      if (repair.state === "conflict") {
        return shown("<uuid>") + "; its repair is itself a conflict row, so prepare the reviewed replacement of " +
          "THAT repair row with `" + cli("outbox-resolve") + " --harness <abs> --operation <repair-uuid> --input <file>`" +
          " - a resolve only enqueues the repair - then dispatch it with " + dispatched("<new-uuid>") +
          " and record its confirming receipt with " + evidenced() +
          "; the parent settles once its repair chain reaches a confirmed repair that holds its recorded receipt";
      }
      return shown("<uuid>") + ". It carries no live repair, so prepare one with " + resolved() +
        " - a resolve only enqueues the repair - then dispatch it with " + dispatched("<new-uuid>") +
        " and record its confirming receipt with " + evidenced();
    };
    const firstStep = (row: UnsettledRow): string =>
      row.state === "enqueued"
        ? "list it with `" + cli("outbox-pending") + " --harness <abs> --project <local-project-id>`, then dispatch an " +
          "ordinary intent with `" + cli("outbox-dispatch") + " --harness <abs> --operation <uuid>`; a reviewed resolution " +
          "needs its host fork observation through --input, so dispatch it as `" + cli("outbox-dispatch") +
          " --harness <abs> --operation <uuid> --input <file|->`. A dispatch issues only a send permit: record what the " +
          "send observed with `" + cli("outbox-receipt") + " --harness <abs> --input <file|->`, and a row proven unsent " +
          "can instead be abandoned with `" + cli("outbox-abandon") + " --harness <abs> --operation <uuid> --reason <text>`"
        : row.state === "unconfirmed"
          ? "read it with `" + cli("outbox-show") + " --harness <abs> --operation <uuid>`, then record that attempt's " +
            "evidence with `" + cli("outbox-receipt") + " --harness <abs> --input <file|->` or `" + cli("outbox-reconcile") +
            " --harness <abs> --input <file|->`"
          : conflictStep(row.repair);
    const lines: string[] = [];
    const named = new Set<string>();
    for (const row of recorded.unsettled) {
      if (named.has(row.state)) continue;
      named.add(row.state);
      lines.push(`- state ${row.state}: oldest operation ${row.operation_id}; ${firstStep(row)}`);
    }
    const oldest = recorded.unsettled[0]!;
    throw new StoreError(
      "remote.effect-pending",
      `The remote cache at ${dbPath} holds ${String(recorded.unsettled.length)} unsettled outbox intent(s); such an
        intent may already have taken effect at the provider, so the cache is not replaced. Settle every state
        listed below, then rerun the same bind. The lines are in row-age order, which is not a dispatch order:
        dispatch blocking is scoped to the same generation and project, and a reviewed repair is exempt from its own
        CONFLICT ancestor only (an unconfirmed ancestor still blocks), so a newer intent does not always block an
        older dispatch; a blocked dispatch names the intent that blocks it:
        ${lines.join("\n        ")}
        Nothing was replaced.`,
      { oldestOperationId: oldest.operation_id, unsettledCount: recorded.unsettled.length },
    );
  }
  return { storeId: recorded.meta.storeId, epoch: recorded.meta.epoch };
}

let remoteCacheReplacementGapForTest: (() => void | Promise<void>) | undefined;
export function setRemoteCacheReplacementGapForTest(callback: (() => void | Promise<void>) | undefined): void {
  remoteCacheReplacementGapForTest = callback;
}

/** see packages/engine/src/collaboration-store.ts - The v7 crash seam: runs INSIDE the upgrade ladder's single transaction, after the roadmap removal DDL and before its ledger row, so a regression can capture the hot journal of a genuinely interrupted rebuild through the production path instead of hand-rolling a transaction. It is synchronous because the ladder is; throwing from it leaves the ladder's own rollback in charge. */
let collaborationRoadmapRemovalGapForTest: ((db: StoreDb) => void) | undefined;
export function setCollaborationRoadmapRemovalGapForTest(callback: ((db: StoreDb) => void) | undefined): void {
  collaborationRoadmapRemovalGapForTest = callback;
}

let remoteCacheReplacementPublishGapForTest: (() => void | Promise<void>) | undefined;
export function setRemoteCacheReplacementPublishGapForTest(
  callback: (() => void | Promise<void>) | undefined,
): void {
  remoteCacheReplacementPublishGapForTest = callback;
}

let remoteCacheReplacementLedgerGapForTest: (() => void | Promise<void>) | undefined;
export function setRemoteCacheReplacementLedgerGapForTest(
  callback: (() => void | Promise<void>) | undefined,
): void {
  remoteCacheReplacementLedgerGapForTest = callback;
}

let remoteCacheReplacementCommitGapForTest: (() => void | Promise<void>) | undefined;
export function setRemoteCacheReplacementCommitGapForTest(
  callback: (() => void | Promise<void>) | undefined,
): void {
  remoteCacheReplacementCommitGapForTest = callback;
}

function createStoreDirectories(dir: string): void {
  let current = dir;
  for (;;) {
    try {
      const stats = lstatSync(current);
      if (!stats.isDirectory()) throw unreadable(current, "a storage component is not a directory");
      break;
    } catch (error) {
      if (error instanceof StoreError) throw error;
      if ((error as { code?: string }).code !== "ENOENT") {
        throw unreadable(current, `a storage component could not be examined (${publicationCause(error)})`);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw unreadable(dir, `its directory could not be created (${publicationCause(error)})`);
  }
}

function discardStaging(stagingDir: string, stagingPath: string): void {
  removeStagingFiles(stagingPath);
  try {
    rmdirSync(stagingDir);
  } catch {
  }
}

/**
 * Create-only staged initialization for one canonical scope. A missing
 * database is built complete in a private staging directory whose file carries
 * the RESERVED `collaboration.db` basename, published with one create-only hard
 * link; a matching record already on disk (staged or active) is reused without
 * clearing it, and a record for another repository, mode, state, store id or
 * schema refuses.
 *
 * Publication retires its own staging alias on every outcome - success and a
 * failed directory barrier alike - so no engine-created second name for runtime
 * bytes survives. A crash after the link but before the canonical name is
 * durable can therefore lose only this still-empty staged database, which the
 * next initializer recreates; it can never leave writable aliased bytes behind.
 */
export async function initializeCollaborationStore(location: CollaborationLocation): Promise<CollaborationAuthority> {
  assertStoreRuntimeSupported();
  if (location.mode === "remote") remoteLaneRefusal();
  return createOrContinueStore(location);
}

/**
 * note: The remote cache lane's own initializer. `remote bind` owns it: the local domain
 * entries never create or open a remote lane, so no local-authority verb can
 * stand in for the verified cache.
 *
 * A cache below the outbox schema is DERIVED observation state with no outbox work to preserve,
 * so the reviewed bind replaces it in place instead of failing its own documented recovery. The
 * successor is staged and verified first; only then are the previous bytes preserved beside the
 * lane and the canonical name released, so a failed or raced publication never destroys them.
 * The replaced lane's store identity is kept: the checkout binding that named it stays valid, so
 * the bind publishes over the same generation.
 */
export async function initializeRemoteCacheStore(
  location: CollaborationLocation,
  expected?: RetainedLaneIdentity,
): Promise<CollaborationAuthority> {
  assertStoreRuntimeSupported();
  return createOrContinueStore(location, {
    replaceBelowVersion: COLLABORATION_MIGRATIONS[COLLABORATION_MIGRATIONS.length - 1]!.version,
    expectedIdentity: expected,
  });
}

function laneInodeOf(dbPath: string): number | null {
  try {
    return statSync(dbPath).ino;
  } catch {
    return null;
  }
}

type RetainedLaneIdentity = Readonly<{ storeId: string; epoch: number }>;

type StagedStore = Readonly<{ stagingDir: string; stagingPath: string; authority: CollaborationAuthority }>;

async function stageCompleteStore(
  location: CollaborationLocation,
  retained: RetainedLaneIdentity | undefined,
  timeout: number,
  carried: CarriedOutboxLedger = { bindings: [], intents: [], receipts: [], moves: { columns: [], rows: [] }, predecessorMode: null },
): Promise<StagedStore> {
  const dbPath = location.dbPath;
  const dir = dirname(dbPath);
  createStoreDirectories(dir);
  const stagingDir = join(dir, `.staging-${process.pid}-${randomUUID()}`);
  const stagingPath = join(stagingDir, basename(dbPath));
  try {
    mkdirSync(stagingDir, { mode: 0o700 });
  } catch (error) {
    throw unreadable(dbPath, `a private staging directory could not be created (${publicationCause(error)})`);
  }
  let claim: number;
  try {
    claim = openSync(stagingPath, "wx", 0o600);
  } catch (error) {
    discardStaging(stagingDir, stagingPath);
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
      for (const migration of COLLABORATION_MIGRATIONS) {
        if (migration.version === COLLABORATION_REMOTE_SCHEMA.version) {
          applyRemoteCacheSchema(db);
        } else {
          db.exec(migration.sql);
        }
        db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
          migration.version,
          migration.name,
          migrationChecksum(migration),
          at,
        );
      }
      db.prepare(
        "insert into collaboration_meta(id, repository_key, mode, store_id, authority_state, authority_epoch, " +
          "revision, catalog_revision, created_at) values (1, ?, ?, ?, 'staged', ?, 0, 0, ?)",
      ).run(location.repoKey, location.mode, retained?.storeId ?? randomUUID(), retained?.epoch ?? 1, at);
      if (carried.intents.length > 0 || carried.moves.rows.length > 0) carrySettledOutbox(db, carried);
      db.exec("commit");
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
      }
      throw error;
    }
    authority = admit(db, location, undefined, "any");
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
      }
    }
    discardStaging(stagingDir, stagingPath);
    throw asRefusal(dbPath, error);
  }

  return { stagingDir, stagingPath, authority };
}

async function createFreshStore(location: CollaborationLocation, timeout: number): Promise<CollaborationAuthority> {
  const dbPath = location.dbPath;
  const staged = await stageCompleteStore(location, undefined, timeout);
  try {
    linkSync(staged.stagingPath, dbPath);
  } catch (error) {
    discardStaging(staged.stagingDir, staged.stagingPath);
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return continueExisting(location, timeout);
    }
    throw unreadable(dbPath, `the staged store could not be linked into place (${publicationCause(error)})`);
  }
  try {
    confirmPublishedChain(dbPath);
  } finally {
    discardStaging(staged.stagingDir, staged.stagingPath);
  }
  return staged.authority;
}

async function replaceDerivedLane(
  location: CollaborationLocation,
  below: number,
  expected: RetainedLaneIdentity | undefined,
  timeout: number,
): Promise<CollaborationAuthority> {
  const dbPath = location.dbPath;
  const retained = await replaceDerivedLaneBelow(location, below, timeout, expected);
  if (retained === undefined) return continueExisting(location, timeout);
  const carried = await readSettledOutboxLedger(dbPath, timeout);
  await remoteCacheReplacementLedgerGapForTest?.();
  const staged = await stageCompleteStore(location, retained, timeout, carried);
  const preservedPath = join(dirname(dbPath), `.replaced-${process.pid}-${randomUUID()}.db`);
  try {
    linkSync(dbPath, preservedPath);
  } catch (error) {
    discardStaging(staged.stagingDir, staged.stagingPath);
    throw unreadable(dbPath, `its derived cache could not be preserved before replacement (${publicationCause(error)})`);
  }
  try {
    const guard = await connectAt(dbPath, "write", timeout, { noCreate: true, keepJournalMode: true });
    try {
      guard.exec("begin immediate");
      const proven = await replaceDerivedLaneBelow(location, below, timeout, expected);
      if (proven === undefined || proven.storeId !== retained.storeId || proven.epoch !== retained.epoch) {
        discardStaging(staged.stagingDir, staged.stagingPath);
        rmSync(preservedPath, { force: true });
        return continueExisting(location, timeout);
      }
      if (!isDeepStrictEqual(await readSettledOutboxLedger(dbPath, timeout), carried)) {
        discardStaging(staged.stagingDir, staged.stagingPath);
        rmSync(preservedPath, { force: true });
        return continueExisting(location, timeout);
      }
      await remoteCacheReplacementCommitGapForTest?.();
      await remoteCacheReplacementPublishGapForTest?.();
      for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
      renameSync(staged.stagingPath, dbPath);
    } finally {
      try {
        guard.exec("rollback");
      } catch {
      }
      guard.close();
    }
  } catch (error) {
    discardStaging(staged.stagingDir, staged.stagingPath);
    rmSync(preservedPath, { force: true });
    throw asRefusal(
      dbPath,
      error instanceof StoreError
        ? error
        : unreadable(dbPath, `the staged store could not be published over its predecessor (${publicationCause(error)})`),
    );
  }
  try {
    confirmPublishedChain(dbPath);
  } finally {
    discardStaging(staged.stagingDir, staged.stagingPath);
  }
  rmSync(preservedPath, { force: true });
  return staged.authority;
}

async function createOrContinueStore(
  location: CollaborationLocation,
  options: { replaceBelowVersion?: number; expectedIdentity?: RetainedLaneIdentity } = {},
): Promise<CollaborationAuthority> {
  const dbPath = location.dbPath;
  const timeout = busyTimeoutMs();
  assertAdmittedTarget(dbPath);
  if (options.replaceBelowVersion !== undefined && location.mode === "remote") {
    await remoteCacheReplacementGapForTest?.();
    createStoreDirectories(dirname(dbPath));
    const { withCollaborationLockFile } = await import("./collaboration-cutover.js");
    return withCollaborationLockFile(
      join(dirname(dbPath), "collaboration-cache-replace.lock"),
      "remote cache replacement",
      async () =>
        existsSync(dbPath)
          ? replaceDerivedLane(location, options.replaceBelowVersion as number, options.expectedIdentity, timeout)
          : createFreshStore(location, timeout),
    );
  }
  if (existsSync(dbPath)) return continueExisting(location, timeout);
  return createFreshStore(location, timeout);
}

/** note: What one explicit upgrade did: the versions crossed and the references it minted. */
export type CollaborationUpgradeReceipt = Readonly<{
  version: 1;
  fromVersion: number;
  toVersion: number;
  storeId: string;
  epoch: number;
  issuesBackfilled: number;
}>;

/**
 * note: The declared inventory of one supported lane version: every table and column an image of
 * that generation must carry. A restore verifies an older verified image against ITS OWN declared
 * shape before advancing the staged copy through the ladder.
 */
export function collaborationInventoryOf(version: number): Readonly<Record<string, readonly string[]>> {
  if (version <= 1) return COLLABORATION_V1_COLUMNS;
  if (version < COLLABORATION_OUTBOX_SCHEMA.version) return COLLABORATION_V2_COLUMNS;
  if (version < COLLABORATION_MOVE_SCHEMA.version) return COLLABORATION_V3_COLUMNS;
  if (version < COLLABORATION_MOVE_ROUTE_SCHEMA.version) return COLLABORATION_V4_COLUMNS;
  if (version < COLLABORATION_MILESTONE_EFFORT_SCHEMA.version) return COLLABORATION_V5_ROUTE_COLUMNS;
  if (version < COLLABORATION_ROADMAP_REMOVAL_SCHEMA.version) return COLLABORATION_V6_COLUMNS;
  return COLLABORATION_CURRENT_COLUMNS;
}

function backfillMoveRoutes(db: StoreDb): void {
  const meta = db.prepare("select mode from collaboration_meta where id = 1").get() as { mode?: unknown } | undefined;
  const ownMode = meta?.mode;
  if (ownMode !== "local" && ownMode !== "mirror") return;
  const rows = db
    .prepare("select operation_id as operationId, role, source_authority as sourceAuthority, destination_authority as destinationAuthority from issue_moves")
    .all() as Array<{ operationId?: unknown; role?: unknown; sourceAuthority?: unknown; destinationAuthority?: unknown }>;
  if (rows.length === 0) return;
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => StoreDb;
  };
  const peers = new Map<string, { mode: string | null } | null>();
  const peerPathOf = (repoKey: string): string | null => {
    try {
      return collaborationLocationOfRepoKey(repoKey, "local").dbPath;
    } catch {
      return null;
    }
  };
  const peerOf = (repoKey: string): { mode: string | null } | null => {
    const cached = peers.get(repoKey);
    if (cached !== undefined) return cached;
    let peer: { mode: string | null } | null = null;
    const dbPath = peerPathOf(repoKey);
    if (dbPath !== null && existsSync(dbPath)) {
      let lane: StoreDb | undefined;
      try {
        lane = new DatabaseSync(dbPath, { readOnly: true });
        const mode = (lane.prepare("select mode from collaboration_meta where id = 1").get() as { mode?: unknown } | undefined)
          ?.mode;
        peer = { mode: typeof mode === "string" ? mode : null };
      } catch {
        peer = null;
      } finally {
        try {
          lane?.close();
        } catch {
        }
      }
    }
    peers.set(repoKey, peer);
    return peer;
  };
  const relabel = db.prepare("update issue_moves set route = 'local-local' where operation_id = ?");
  for (const row of rows) {
    const peerKey = row.role === "source" ? row.destinationAuthority : row.sourceAuthority;
    const peerRole = row.role === "source" ? "destination" : "source";
    if (typeof row.operationId !== "string" || typeof peerKey !== "string") continue;
    const peer = peerOf(peerKey);
    if (peer === null || peer.mode === "remote") continue;
    const dbPath = peerPathOf(peerKey);
    if (dbPath === null) continue;
    let lane: StoreDb | undefined;
    try {
      lane = new DatabaseSync(dbPath, { readOnly: true });
      const staged = lane
        .prepare("select 1 as found from issue_moves where operation_id = ? and role = ?")
        .get(row.operationId, peerRole) as { found?: number } | undefined;
      if (staged !== undefined) relabel.run(row.operationId);
    } catch {
    } finally {
      try {
        lane?.close();
      } catch {
      }
    }
  }
}

/**
 * invariant: Advance one lane's bytes through this build's supported ladder inside the caller's
 * open transaction: each recorded predecessor is re-validated, the v2 rebuild+backfill and the v3
 * outbox each run under a proof of the shape they start from, and every ledger row is appended
 * only after its layout is verified. An already-current lane is only revalidated.
 */
export function applyCollaborationLadder(
  db: StoreDb,
  dbPath: string,
): Readonly<{ fromVersion: number; issuesBackfilled: number }> {
  const appliedMax = validateCollaborationMigrations(readAppliedMigrations(db, false));
  const current = COLLABORATION_MIGRATIONS[COLLABORATION_MIGRATIONS.length - 1]!.version;
  if (appliedMax === current) {
    assertCurrentSchema(db, dbPath);
    return { fromVersion: current, issuesBackfilled: 0 };
  }
  let issuesBackfilled = 0;
  if (appliedMax < COLLABORATION_REMOTE_SCHEMA.version) {
    assertLegacySchema(db, dbPath);
    const present = db
      .prepare("pragma table_info(issues)")
      .all()
      .map((column) => (column !== null && typeof column === "object" && "name" in column ? column.name : undefined));
    if (present.includes("issue_ref")) {
      throw new StoreError(
        "store.corrupt",
        `The collaboration store at ${dbPath} is a partially applied v2 (its v1 ledger is intact but issues already ` +
          `carries issue_ref); it is refused instead of re-backfilling stable references. Recover the v1 bytes from a ` +
          `verified backup pair; nothing was modified.`,
      );
    }
    issuesBackfilled = applyRemoteCacheSchema(db);
    db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
      COLLABORATION_REMOTE_SCHEMA.version,
      COLLABORATION_REMOTE_SCHEMA.name,
      migrationChecksum(COLLABORATION_REMOTE_SCHEMA),
      nowRfc3339(),
    );
  }
  if (appliedMax < COLLABORATION_OUTBOX_SCHEMA.version) {
    assertRemoteCacheSchema(db, dbPath);
    db.exec(COLLABORATION_OUTBOX_SCHEMA.sql);
    db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
      COLLABORATION_OUTBOX_SCHEMA.version,
      COLLABORATION_OUTBOX_SCHEMA.name,
      migrationChecksum(COLLABORATION_OUTBOX_SCHEMA),
      nowRfc3339(),
    );
  }
  if (appliedMax < COLLABORATION_MOVE_SCHEMA.version) {
    assertOutboxSchema(db, dbPath);
    db.exec(COLLABORATION_MOVE_SCHEMA.sql);
    db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
      COLLABORATION_MOVE_SCHEMA.version,
      COLLABORATION_MOVE_SCHEMA.name,
      migrationChecksum(COLLABORATION_MOVE_SCHEMA),
      nowRfc3339(),
    );
  }
  if (appliedMax < COLLABORATION_MOVE_ROUTE_SCHEMA.version) {
    assertMoveSchema(db, dbPath);
    db.exec(COLLABORATION_MOVE_ROUTE_SCHEMA.sql);
    db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
      COLLABORATION_MOVE_ROUTE_SCHEMA.version,
      COLLABORATION_MOVE_ROUTE_SCHEMA.name,
      migrationChecksum(COLLABORATION_MOVE_ROUTE_SCHEMA),
      nowRfc3339(),
    );
    backfillMoveRoutes(db);
  }
  if (appliedMax < COLLABORATION_MILESTONE_EFFORT_SCHEMA.version) {
    assertMoveRouteSchema(db, dbPath);
    db.exec(COLLABORATION_MILESTONE_EFFORT_SCHEMA.sql);
    db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
      COLLABORATION_MILESTONE_EFFORT_SCHEMA.version,
      COLLABORATION_MILESTONE_EFFORT_SCHEMA.name,
      migrationChecksum(COLLABORATION_MILESTONE_EFFORT_SCHEMA),
      nowRfc3339(),
    );
  }
  // see packages/engine/src/collaboration-store.ts - // invariant: The exact v6 shape is proven before the v7 rebuild: a `catalog_entities` that already lost
  // `roadmap` (or a lane that already dropped `project_roadmaps`) without its ledger row is a partial
  // apply, and is refused instead of being re-copied.
  if (appliedMax < COLLABORATION_ROADMAP_REMOVAL_SCHEMA.version) {
    assertMilestoneEffortSchema(db, dbPath);
    db.exec(COLLABORATION_ROADMAP_REMOVAL_SCHEMA.sql);
    // see packages/engine/src/collaboration-store.ts - // note: The crash seam sits exactly on this step's own boundary: the rebuild is applied and its
    // ledger row is not, inside the ladder's one transaction.
    collaborationRoadmapRemovalGapForTest?.(db);
    db.prepare("insert into schema_version(version, name, checksum, applied_at) values (?, ?, ?, ?)").run(
      COLLABORATION_ROADMAP_REMOVAL_SCHEMA.version,
      COLLABORATION_ROADMAP_REMOVAL_SCHEMA.name,
      migrationChecksum(COLLABORATION_ROADMAP_REMOVAL_SCHEMA),
      nowRfc3339(),
    );
  }
  assertCurrentSchema(db, dbPath);
  return { fromVersion: appliedMax, issuesBackfilled };
}

/**
 * `mstar store upgrade --operator <name>` for the collaboration lane: the ONLY
 * way an admitted older lane advances to the current schema. Ordinary reads
 * never migrate.
 *
 * The whole ladder runs in one `BEGIN IMMEDIATE`: the applied set is re-read
 * inside the transaction, each recorded predecessor checksum must equal this
 * build's own immutable migration body, the lane's current layout must be
 * exactly the declared one (a partial or damaged lane refuses instead of being
 * "repaired"), the next DDL and the per-row `IssueRef` backfill run together,
 * the resulting layout is verified, and only then is the ledger row appended.
 * A crash therefore leaves the predecessor's bytes: replaying the same verb
 * revalidates and commits, while a half-applied schema refuses.
 */
export async function upgradeCollaborationStore(
  context: StoreContext,
  operator: string,
): Promise<CollaborationUpgradeReceipt> {
  assertStoreRuntimeSupported();
  if (typeof operator !== "string" || operator.trim() === "") {
    throw new StoreError(
      "store.attestation-invalid",
      "A collaboration upgrade records the operator who ran it; pass a non-empty --operator <name>. Nothing was modified.",
    );
  }
  const location = resolveCollaborationLocation(context);
  const dbPath = location.dbPath;
  const timeout = busyTimeoutMs();
  assertAdmittedTarget(dbPath);
  if (!existsSync(dbPath)) throw notInitialized(dbPath);
  await assertControlCheckoutScope(context, location);
  const binding = readCollaborationBinding(context);

  const db = await connectAt(dbPath, "write", timeout, { noCreate: true, keepJournalMode: true }).catch(
    (error: unknown) => {
      if (!existsSync(dbPath)) throw notInitialized(dbPath);
      throw error;
    },
  );
  try {
    db.exec("begin immediate");
    try {
      const current = COLLABORATION_MIGRATIONS[COLLABORATION_MIGRATIONS.length - 1]!.version;
      const meta = readMeta(db);
      if (meta.repoKey !== location.repoKey || meta.mode !== location.mode) {
        throw staleBinding(dbPath, meta, `this checkout's ${location.repoKey} (${location.mode})`);
      }
      const owned =
        binding !== null &&
        binding.state === "active" &&
        binding.repoKey === meta.repoKey &&
        binding.mode === meta.mode &&
        binding.storeId === meta.storeId &&
        binding.epoch === meta.epoch;
      if (!owned) {
        throw staleBinding(
          dbPath,
          meta,
          binding === null || binding.state !== "active"
            ? "a finalized binding this checkout does not hold"
            : `${binding.repoKey} (${binding.mode}) store ${binding.storeId} epoch ${String(binding.epoch)}`,
        );
      }
      const receipt = (fromVersion: number, issuesBackfilled: number): CollaborationUpgradeReceipt => ({
        version: 1,
        fromVersion,
        toVersion: current,
        storeId: meta.storeId,
        epoch: meta.epoch,
        issuesBackfilled,
      });
      const ladder = applyCollaborationLadder(db, dbPath);
      if (ladder.fromVersion === current) {
        db.exec("commit");
        return receipt(current, 0);
      }
      db.prepare(
        "insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at) " +
          "values ('standalone', ?, ?, ?, ?)",
      ).run(
        `upgrade:collaboration:${String(current)}:${meta.storeId}:${String(meta.epoch)}`,
        migrationChecksum(COLLABORATION_OUTBOX_SCHEMA),
        JSON.stringify({
          version: 1,
          operator: operator.trim(),
          fromVersion: ladder.fromVersion,
          toVersion: current,
          storeId: meta.storeId,
          epoch: meta.epoch,
          issuesBackfilled: ladder.issuesBackfilled,
        }),
        nowRfc3339(),
      );
      assertSelectionUnchanged(context, location);
      db.exec("commit");
      return receipt(ladder.fromVersion, ladder.issuesBackfilled);
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
      }
      throw error instanceof StoreError ? error : asRefusal(dbPath, error);
    }
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}

/**
 * note: The public upgrade's collaboration half: `store upgrade` advances an EXISTING
 * admitted old lane through the v2 migration before any current-only admission
 * runs. A missing lane is the fresh-bootstrap path (the caller creates it
 * complete) and a remote checkout's cache is created by `remote bind`, so both
 * answer `null` without touching anything.
 */
export async function upgradeExistingCollaborationStore(
  context: StoreContext,
  operator: string,
): Promise<CollaborationUpgradeReceipt | null> {
  const location = resolveCollaborationLocation(context);
  if (location.mode === "remote" || !existsSync(location.dbPath)) return null;
  return upgradeCollaborationStore(context, operator);
}

export async function admitCollaborationImage(
  location: CollaborationLocation,
  imagePath: string,
): Promise<CollaborationAuthority> {
  assertStoreRuntimeSupported();
  assertAdmittedTarget(imagePath);
  const db = await connectAt(imagePath, "read", busyTimeoutMs());
  try {
    return admit(db, { ...location, dbPath: imagePath }, undefined, "any");
  } finally {
    db.close();
  }
}

/**
 * Run the canonical private-path admission for this scope's target BEFORE a
 * caller creates anything: the private, link-free storage namespace and the
 * regular-file target are the same rules every open applies, so a restore never
 * stages bytes through a redirected ancestor (or beside a symlinked target) that
 * the later authority read would refuse.
 */
export function assertCollaborationTargetAdmission(location: CollaborationLocation): void {
  assertStoreRuntimeSupported();
  if (location.mode === "remote") remoteLaneRefusal();
  assertAdmittedTarget(location.dbPath);
}

/**
 * The recorded binding of ONE control checkout to the repository authority it
 * uses: the derived scope (repository key and mode), the authority's own store
 * identity and the epoch this checkout was last bound to. It is the local
 * counterpart of the lane's `collaboration_meta`, persisted beside the harness
 * so a checkout cannot be silently re-routed to another repository by an origin
 * change, and an unfenced legacy owner is refused before any I/O.
 *
 * A `remote` scope records v3 instead: the checked selector commit and
 * generation it is bound to, never provider tuples (those live in the trusted
 * selector). `storeId`/`epoch` stay the private cache identity.
 */
export type CollaborationBinding =
  | Readonly<{
      version: 2;
      state: "claimed" | "active";
      repoKey: string;
      mode: "local" | "mirror";
      storeId: string;
      epoch: number;
      boundAt: string;
    }>
  | Readonly<{
      version: 3;
      state: "active";
      repoKey: string;
      mode: "remote";
      selectorCommit: string;
      generation: number;
      storeId: string;
      epoch: number;
      boundAt: string;
    }>;

function bindingPath(context: StoreContext): string {
  return join(context.harnessDir, COLLABORATION_BINDING_FILE);
}

const SELECTOR_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function malformedBinding(context: StoreContext): never {
  throw new StoreError(
    "collaboration.stale-binding",
    `The collaboration binding at ${bindingPath(context)} is malformed, so this checkout cannot be proven to belong to the ` +
      `authority it would use. Re-record it deliberately with the supported authority verb (store init / store activate) ` +
      `or restore the recorded binding; nothing was read or modified.`,
  );
}

/** The recorded binding, or `null` for a checkout that has never been bound (a replacement clone). */
export function readCollaborationBinding(context: StoreContext): CollaborationBinding | null {
  let text: string;
  try {
    text = readFileSync(bindingPath(context), "utf8");
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    throw new StoreError(
      "collaboration.stale-binding",
      `The collaboration binding at ${bindingPath(context)} exists but cannot be read (${code || "unknown"}); this checkout ` +
        `cannot be proven to belong to the authority it would use, so it is never treated as fresh. Repair the file or ` +
        `re-record the binding with the supported authority verb. Nothing was modified.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StoreError(
      "collaboration.stale-binding",
      `The collaboration binding at ${bindingPath(context)} is not readable JSON; this checkout cannot be proven to belong ` +
        `to the authority it would use, so it is never treated as a fresh clone. Repair the file or re-record the binding ` +
        `with the supported authority verb. Nothing was modified.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) malformedBinding(context);
  const body = parsed as Record<string, unknown>;
  const common =
    typeof body.repoKey === "string" &&
    typeof body.storeId === "string" &&
    typeof body.epoch === "number" &&
    Number.isSafeInteger(body.epoch) &&
    body.epoch > 0;
  const validV2 =
    body.version === 2 &&
    (body.state === "claimed" || body.state === "active") &&
    (body.mode === "local" || body.mode === "mirror") &&
    common;
  const validV3 =
    body.version === 3 &&
    body.state === "active" &&
    body.mode === "remote" &&
    typeof body.selectorCommit === "string" &&
    SELECTOR_COMMIT.test(body.selectorCommit) &&
    typeof body.generation === "number" &&
    Number.isSafeInteger(body.generation) &&
    body.generation > 0 &&
    common;
  if (!validV2 && !validV3) malformedBinding(context);
  return { ...(body as CollaborationBinding), boundAt: typeof body.boundAt === "string" ? body.boundAt : "" };
}

/** Persist this checkout's binding. Atomic replace; the file carries no authority bytes. */
export function writeCollaborationBinding(
  context: StoreContext,
  authority: Pick<CollaborationAuthority, "repoKey" | "mode" | "storeId" | "epoch"> & { binding?: "claimed" | "active" },
): void {
  const mode = localBindingMode(authority.mode);
  const path = bindingPath(context);
  mkdirSync(dirname(path), { recursive: true });
  const body: CollaborationBinding = {
    version: 2,
    state: authority.binding ?? "active",
    repoKey: authority.repoKey,
    mode,
    storeId: authority.storeId,
    epoch: authority.epoch,
    boundAt: nowRfc3339(),
  };
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function bindingClaimPath(context: StoreContext): string {
  return join(context.harnessDir, "collaboration-binding.claim.json");
}

/**
 * An interrupted attempt's claim: the generation it intended to publish. It is
 * kept OUTSIDE the primary binding, so a refused or crashed activation never
 * overwrites the checkout's real binding; only a proven claim is promoted.
 */
export type BindingClaim = Readonly<{
  version: 1;
  repoKey: string;
  mode: CollaborationMode;
  storeId: string;
  epoch: number;
  claimedAt: string;
}>;

/** The recorded attempt claim, or `null`. A malformed claim is evidence of a damaged attempt, never a binding. */
export function readBindingClaim(context: StoreContext): BindingClaim | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(bindingClaimPath(context), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const claim = parsed as Record<string, unknown>;
  if (
    claim.version !== 1 ||
    typeof claim.repoKey !== "string" ||
    (claim.mode !== "local" && claim.mode !== "mirror") ||
    typeof claim.storeId !== "string" ||
    typeof claim.epoch !== "number"
  ) {
    return null;
  }
  return {
    version: 1,
    repoKey: claim.repoKey,
    mode: claim.mode,
    storeId: claim.storeId,
    epoch: claim.epoch,
    claimedAt: typeof claim.claimedAt === "string" ? claim.claimedAt : "",
  };
}

/** Remove this attempt's claim once its generation is finalized. */
export function clearBindingClaim(context: StoreContext): void {
  try {
    rmSync(bindingClaimPath(context), { force: true });
  } catch {
  }
}

/** Write this attempt's claim and return the rollback that removes it. Never touches the primary binding. */
export function beginBindingClaim(
  context: StoreContext,
  authority: Pick<CollaborationAuthority, "repoKey" | "mode" | "storeId" | "epoch">,
): () => void {
  const path = bindingClaimPath(context);
  mkdirSync(dirname(path), { recursive: true });
  const body: BindingClaim = {
    version: 1,
    repoKey: authority.repoKey,
    mode: authority.mode,
    storeId: authority.storeId,
    epoch: authority.epoch,
    claimedAt: nowRfc3339(),
  };
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return () => {
    try {
      rmSync(path, { force: true });
      syncDirectoryEntry(dirname(path));
    } catch {
    }
  };
}

type RecordedLineage = Readonly<{
  kind: "cutover" | "activation" | "restore" | "creation";
  operationId: string;
  storeId: string;
  epoch: number;
}>;

function recordedLineage(db: StoreDb): RecordedLineage[] {
  const lineage: RecordedLineage[] = [];
  const tables = tableNamesOn(db);
  if (tables.has("cutover_publications")) {
    for (const row of db
      .prepare(
        "select manifest_id, target_store_id, target_epoch from cutover_publications where phase = 'active'",
      )
      .all() as Array<Record<string, unknown>>) {
      if (typeof row.manifest_id !== "string" || typeof row.target_store_id !== "string" || typeof row.target_epoch !== "number") continue;
      lineage.push({
        kind: "cutover",
        operationId: `cutover:${row.manifest_id}`,
        storeId: row.target_store_id,
        epoch: row.target_epoch,
      });
    }
  }
  if (tables.has("collaboration_operations")) {
    const rows = db
      .prepare(
        "select operation_id, result_json from collaboration_operations where key_space = 'standalone' and " +
          "(operation_id like 'migration:activated:%' or operation_id like 'restore:%' or operation_id like 'creation:%')",
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (typeof row.operation_id !== "string" || typeof row.result_json !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.result_json);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (row.operation_id.startsWith("restore:")) {
        const authority = record.authority;
        if (authority === null || typeof authority !== "object") continue;
        const restored = authority as Record<string, unknown>;
        if (typeof restored.storeId !== "string" || typeof restored.epoch !== "number") continue;
        lineage.push({ kind: "restore", operationId: row.operation_id, storeId: restored.storeId, epoch: restored.epoch });
        continue;
      }
      if (typeof record.storeId !== "string" || typeof record.epoch !== "number") continue;
      lineage.push({
        kind: row.operation_id.startsWith("creation:") ? "creation" : "activation",
        operationId: row.operation_id,
        storeId: record.storeId,
        epoch: record.epoch,
      });
    }
  }
  return lineage;
}

/** The outcome of the explicit adoption verb: the served authority and the binding it records. */
export type CollaborationAdoption = Readonly<{
  version: 1;
  adopted: boolean;
  authority: CollaborationAuthority;
  binding: CollaborationBinding;
  lineage: RecordedLineage;
}>;

async function readAdoptionSnapshot(location: CollaborationLocation): Promise<{
  authority: CollaborationAuthority;
  lineage: RecordedLineage[];
}> {
  assertStoreRuntimeSupported();
  assertAdmittedTarget(location.dbPath);
  if (!existsSync(location.dbPath)) throw notInitialized(location.dbPath);
  const db = await connectAt(location.dbPath, "read", busyTimeoutMs());
  try {
    const appliedMax = validateCollaborationMigrations(readAppliedMigrations(db, false));
    const current = COLLABORATION_MIGRATIONS[COLLABORATION_MIGRATIONS.length - 1]!.version;
    if (appliedMax < current) {
      if (appliedMax !== COLLABORATION_SCHEMA.version) {
        throw new StoreError(
          "store.schema-drift",
          `The collaboration store at ${location.dbPath} records schema version ${String(appliedMax)}; adoption ` +
            `recognizes the immutable v1 ledger or the current version only. Inspect the lane with mstar path resolve; ` +
            `nothing was written.`,
        );
      }
      assertLegacySchema(db, location.dbPath);
    } else {
      assertCurrentSchema(db, location.dbPath);
    }
    const meta = readMeta(db);
    if (meta.repoKey !== location.repoKey || meta.mode !== location.mode) {
      throw staleBinding(location.dbPath, meta, `this checkout's ${location.repoKey} (${location.mode})`);
    }
    const authority: CollaborationAuthority = { ...meta, schemaVersion: appliedMax };
    return { authority, lineage: authority.state === "active" ? recordedLineage(db) : [] };
  } catch (error) {
    throw asRefusal(location.dbPath, error);
  } finally {
    db.close();
  }
}

/**
 * `store collaboration adopt` — the ONLY supported way a replacement clone (or any
 * other bound-less checkout) acquires an existing ACTIVE authority's binding.
 *
 * It mutates NO collaboration data: it reads the canonical scope, the lane's
 * metadata and the lane's recorded publication lineage (cutover publication or
 * file-era activation phase row), and writes nothing but this checkout's binding.
 * A unique lineage matching the live store AND epoch may bind; a missing,
 * ambiguous or mismatched lineage, a foreign checkout, a staged authority, or an
 * expectation that disagrees with the live store refuses WITHOUT writing or
 * overwriting anything. A recorded claim is never promoted unless it names exactly
 * that proven generation. Repeating the verb against the same binding is
 * idempotent.
 */
export async function adoptCollaborationBinding(
  context: StoreContext,
  options: { expectStoreId?: string } = {},
): Promise<CollaborationAdoption> {
  const location = resolveCollaborationLocation(context);
  if (location.mode === "remote") remoteLaneRefusal();
  await assertControlCheckoutScope(context, location);
  const binding = readCollaborationBinding(context);
  if (binding !== null && binding.repoKey !== location.repoKey) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This checkout is bound to repository ${binding.repoKey} (${binding.mode}), not the resolved ${location.repoKey} ` +
        `(${location.mode}); a retargeted checkout is never re-bound by adoption. Nothing was written.`,
    );
  }

  const snapshot = await readAdoptionSnapshot(location);
  const authority = snapshot.authority;
  if (authority.state !== "active") {
    throw new StoreError(
      "collaboration.not-active",
      `The collaboration authority at ${location.dbPath} is ${authority.state}; adoption binds a checkout to an ACTIVE ` +
        `authority only. Publish it with its recorded activation first. Nothing was written.`,
    );
  }
  if (options.expectStoreId !== undefined && options.expectStoreId !== authority.storeId) {
    throw new StoreError(
      "collaboration.stale-binding",
      `The live authority at ${location.dbPath} is store ${authority.storeId}, not the expected ${options.expectStoreId}; ` +
        `adoption refuses rather than binding the wrong generation. Nothing was written.`,
    );
  }
  const kindPriority = ["restore", "activation", "creation", "cutover"] as const;
  const live = snapshot.lineage
    .filter((entry) => entry.storeId === authority.storeId && entry.epoch === authority.epoch)
    .sort((a, b) => kindPriority.indexOf(a.kind) - kindPriority.indexOf(b.kind));
  const proven = live[0];
  if (proven === undefined) {
    const generations = [...new Set(snapshot.lineage.map((entry) => `${entry.storeId}:${entry.epoch}`))];
    if (generations.length > 1) {
      throw new StoreError(
        "collaboration.stale-binding",
        `The lane at ${location.dbPath} records publications for more than one generation (${generations.join(", ")}) but ` +
          `none of them is the live store ${authority.storeId} epoch ${authority.epoch}, so its provenance is ambiguous and ` +
          `no checkout adopts it. Inspect it with mstar path resolve. Nothing was written.`,
      );
    }
    throw new StoreError(
      "collaboration.stale-binding",
      `The ACTIVE authority at ${location.dbPath} (store ${authority.storeId}, epoch ${authority.epoch}) has no recorded ` +
        `publication lineage naming that exact generation, so no checkout can adopt it. Re-run the activation that published ` +
        `it. Nothing was written.`,
    );
  }
  const claim = readBindingClaim(context);
  if (claim !== null && (claim.storeId !== authority.storeId || claim.epoch !== authority.epoch)) {
    throw new StoreError(
      "collaboration.stale-binding",
      `An interrupted claim in this checkout names store ${claim.storeId} epoch ${claim.epoch}, which is not the proven ` +
        `generation ${authority.storeId} epoch ${authority.epoch}; the claim is never promoted or replaced by adoption. ` +
        `Finish that attempt or remove the claim deliberately. Nothing was written.`,
    );
  }
  if (binding !== null && binding.state === "active") {
    if (binding.storeId !== authority.storeId) {
      throw new StoreError(
        "collaboration.stale-binding",
        `This checkout is already bound to authority store ${binding.storeId}, not the live ${authority.storeId}; adoption ` +
          `never overwrites a binding. Inspect the checkout with mstar path resolve. Nothing was written.`,
      );
    }
    if (claim !== null) clearBindingClaim(context);
    return { version: 1, adopted: false, authority, binding, lineage: proven };
  }
  writeCollaborationBinding(context, {
    repoKey: location.repoKey,
    mode: location.mode,
    storeId: authority.storeId,
    epoch: authority.epoch,
    binding: "active",
  });
  if (claim !== null) clearBindingClaim(context);
  return {
    version: 1,
    adopted: true,
    authority,
    binding: {
      version: 2,
      state: "active",
      repoKey: location.repoKey,
      mode: localBindingMode(location.mode),
      storeId: authority.storeId,
      epoch: authority.epoch,
      boundAt: "",
    },
    lineage: proven,
  };
}

function executionProbeRefusal(dbPath: string, error: unknown): StoreError {
  return new StoreError(
    "collaboration.unreadable",
    `The execution store at ${dbPath} exists but cannot be inspected, so it cannot be proven to hold no legacy ` +
      `collaboration rows: ${error instanceof Error ? error.message : String(error)} Repair that store ` +
      `(mstar store upgrade) or move its authority with the reviewed cutover before using the repository lane. ` +
      `Nothing was read or modified.`,
  );
}

function executionStorePresence(dbPath: string): "absent" | "regular" | "unusable" {
  try {
    return lstatSync(dbPath).isFile() ? "regular" : "unusable";
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return "absent";
    return "unusable";
  }
}

function legacyOwnerRefusal(held: readonly string[], cause?: string): StoreError {
  return new StoreError(
    "collaboration.cutover-required",
    `This checkout still owns a combined store with collaboration rows (${held.join(", ")}), so it is not the ` +
      `authority's owner: move that authority with the reviewed cutover (mstar store collaboration plan, apply, then ` +
      `activate) before using the repository lane.` +
      (cause === undefined ? " Nothing was read or modified." : ` The remaining inspection then failed (${cause}); nothing was modified.`),
  );
}

async function assertNoLegacyCollaborationOwner(context: StoreContext, ownershipProven: boolean): Promise<void> {
  const dbPath = storeDbPath(context);
  const presence = executionStorePresence(dbPath);
  if (presence === "absent") return;
  if (presence === "unusable") {
    if (ownershipProven) return;
    throw executionProbeRefusal(dbPath, "the store path is not a readable regular store file");
  }
  let probe: StoreDb;
  try {
    probe = await connectAt(dbPath, "read", busyTimeoutMs());
  } catch (error) {
    if (executionStorePresence(dbPath) === "absent") return;
    if (error instanceof StoreError && error.code === "store.busy") throw error;
    if (ownershipProven) return;
    throw executionProbeRefusal(dbPath, error);
  }
  const observed: string[] = [];
  try {
    try {
      validateAppliedMigrations(readAppliedMigrations(probe, false));
    } catch (error) {
      if (
        error instanceof StoreError &&
        (error.code === "store.schema-unsupported" || error.code === "store.schema-drift")
      ) {
        throw error;
      }
    }
    if (readCollaborationFence(probe) !== null) return;
    const held = heldCollaborationTables(probe, (table) => observed.push(table));
    if (held.length === 0) return;
    throw legacyOwnerRefusal(held);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    if (observed.length > 0) throw legacyOwnerRefusal(observed, `${error instanceof Error ? error.message : String(error)}`);
    if (ownershipProven) return;
    throw executionProbeRefusal(dbPath, error);
  } finally {
    probe.close();
  }
}

function remoteLaneRefusal(): never {
  throw new StoreError(
    "collaboration.mode-unavailable",
    `This repository selects remote collaboration from the checked selector, where the provider is the authority and ` +
      `this checkout's database is only a verified cache. Local issue, catalog and ledger rows never stand in for it, ` +
      `so this local domain entry refuses; remote reads and observations use the remote boundary ` +
      `("mstar store collaboration remote status|bind|observe"). Nothing was read or created.`,
  );
}

/**
 * note: The canonical lane as a LOCAL/MIRROR predecessor: what a reviewed
 * local/mirror -> remote transition retires. `null` means the path holds no lane
 * (fresh scope, or an already-retired replay) or already a remote cache.
 */
export type LocalPredecessorLane = Readonly<{
  mode: "local" | "mirror";
  storeId: string;
  epoch: number;
  state: "staged" | "active";
  schemaVersion: number;
}>;

/**
 * note: Read the canonical path as a predecessor WITHOUT admitting it as this checkout's
 * lane: a remote selection cannot admit a local/mirror record, and the transition
 * must inspect it before retiring it. A foreign repository key refuses here so no
 * rename ever touches another scope's bytes.
 */
export async function readLocalPredecessorLane(location: CollaborationLocation): Promise<LocalPredecessorLane | null> {
  assertStoreRuntimeSupported();
  assertAdmittedTarget(location.dbPath);
  if (!existsSync(location.dbPath)) return null;
  const db = await connectAt(location.dbPath, "read", busyTimeoutMs());
  try {
    const schemaVersion = validateCollaborationMigrations(readAppliedMigrations(db, false));
    const meta = readMeta(db);
    if (meta.repoKey !== location.repoKey) {
      throw staleBinding(location.dbPath, meta, `this checkout's ${location.repoKey} (${location.mode})`);
    }
    if (meta.mode === "remote") return null;
    return { mode: meta.mode, storeId: meta.storeId, epoch: meta.epoch, state: meta.state, schemaVersion };
  } finally {
    db.close();
  }
}

/**
 * note: The mode one lane path RECORDS, or `null` when the path holds no readable lane. Deliberately
 * narrow: a destination addressed by `repoKey` is only CLASSIFIED here, so a damaged or older lane is
 * that lane's own refusal when some path actually opens it, never a verdict guessed by this reader.
 */
export async function readLaneMode(location: CollaborationLocation): Promise<CollaborationMode | null> {
  assertStoreRuntimeSupported();
  assertAdmittedTarget(location.dbPath);
  if (!existsSync(location.dbPath)) return null;
  const db = await connectAt(location.dbPath, "read", busyTimeoutMs());
  try {
    const row = db.prepare("select mode from collaboration_meta where id = 1").get() as { mode?: unknown } | undefined;
    const mode = row?.mode;
    return mode === "local" || mode === "mirror" || mode === "remote" ? mode : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** note: Where one retired predecessor's bytes are preserved: beside the lane, outside every read path. */
export function localPredecessorRetiredPath(
  location: CollaborationLocation,
  identity: { storeId: string; epoch: number },
): string {
  return join(dirname(location.dbPath), `collaboration.retired-${identity.storeId}-${String(identity.epoch)}.db`);
}

let localPredecessorPublicationGapForTest: (() => void | Promise<void>) | undefined;
export function setLocalPredecessorPublicationGapForTest(
  callback: (() => void | Promise<void>) | undefined,
): void {
  localPredecessorPublicationGapForTest = callback;
}

/**
 * invariant: Retire the matched predecessor under write exclusion. The lane is proved to
 * be exactly this record (repository key, mode, store id, epoch) inside a
 * `BEGIN IMMEDIATE`, then MOVED beside itself without ever replacing an image:
 * a hard link creates the preserved name only if it is still free, and the
 * canonical name is removed after it. Its rows survive as inaccessible history
 * and the canonical name is free for the verified cache.
 *
 * The checked selector is re-proved immediately before the move, inside the
 * caller's transition exclusion: a selector that moved (or was deleted) while
 * this verb waited leaves the canonical predecessor untouched, so the later
 * cache transaction can never be the first step that notices the drift.
 *
 * A replay after a crash between the link and the unlink finds both names on
 * one inode and completes the move; a preserved image of other bytes, or a
 * vanished predecessor with no retired image, refuses so a lost authority is
 * never re-created from nothing and history is never overwritten.
 */
export async function retireLocalPredecessorLane(
  context: StoreContext,
  location: CollaborationLocation,
  predecessor: LocalPredecessorLane,
): Promise<string> {
  assertStoreRuntimeSupported();
  assertAdmittedTarget(location.dbPath);
  const retiredPath = localPredecessorRetiredPath(location, predecessor);
  if (!existsSync(location.dbPath)) {
    if (existsSync(retiredPath)) return retiredPath;
    throw new StoreError(
      "collaboration.stale-binding",
      `The recorded ${predecessor.mode} predecessor lane at ${location.dbPath} is missing and has no retired image, so ` +
        `this checkout cannot prove it supersedes that authority. Restore the lane or resolve the transition again; ` +
        `nothing was changed.`,
    );
  }
  if (existsSync(retiredPath)) {
    const source = statSync(location.dbPath);
    const preserved = statSync(retiredPath);
    if (source.dev === preserved.dev && source.ino === preserved.ino) {
      try {
        unlinkSync(location.dbPath);
        syncDirectoryEntry(dirname(location.dbPath));
      } catch (error) {
        throw barrierRefusal(location.dbPath, error);
      }
      return retiredPath;
    }
    throw new StoreError(
      "collaboration.stale-binding",
      `A preserved ${predecessor.mode} predecessor image already exists at ${retiredPath}; it is never overwritten. ` +
        `Inspect the transition before repeating it; nothing was changed.`,
    );
  }
  const before = statSync(location.dbPath);
  const db = await connectAt(location.dbPath, "write", busyTimeoutMs(), { noCreate: true, keepJournalMode: true });
  try {
    db.exec("begin immediate");
    try {
      validateCollaborationMigrations(readAppliedMigrations(db, false));
      const meta = readMeta(db);
      if (
        meta.repoKey !== location.repoKey ||
        meta.mode !== predecessor.mode ||
        meta.storeId !== predecessor.storeId ||
        meta.epoch !== predecessor.epoch ||
        meta.state !== predecessor.state
      ) {
        throw staleBinding(
          location.dbPath,
          meta,
          `the recorded predecessor ${predecessor.mode} store ${predecessor.storeId} epoch ${String(predecessor.epoch)}`,
        );
      }
      db.exec("commit");
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
      }
      throw error instanceof StoreError ? error : asRefusal(location.dbPath, error);
    }
  } finally {
    try {
      db.close();
    } catch {
    }
  }
  const after = statSync(location.dbPath);
  if (after.ino !== before.ino) {
    throw staleBinding(
      location.dbPath,
      { repoKey: location.repoKey, mode: predecessor.mode, storeId: predecessor.storeId, epoch: predecessor.epoch },
      `the predecessor lane this transition proved`,
    );
  }
  assertSelectionUnchanged(context, location);
  if (statSync(location.dbPath).ino !== after.ino) {
    throw staleBinding(
      location.dbPath,
      { repoKey: location.repoKey, mode: predecessor.mode, storeId: predecessor.storeId, epoch: predecessor.epoch },
      `the predecessor lane this transition proved`,
    );
  }
  await localPredecessorPublicationGapForTest?.();
  try {
    linkSync(location.dbPath, retiredPath);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      throw new StoreError(
        "collaboration.stale-binding",
        `A preserved ${predecessor.mode} predecessor image appeared at ${retiredPath} while this transition was retiring ` +
          `the lane; it is never replaced. Inspect the transition before repeating it; nothing was changed.`,
      );
    }
    throw unreadable(
      location.dbPath,
      `its preserved predecessor image could not be published (${publicationCause(error)})`,
    );
  }
  try {
    unlinkSync(location.dbPath);
    syncDirectoryEntry(dirname(location.dbPath));
  } catch (error) {
    throw barrierRefusal(location.dbPath, error);
  }
  return retiredPath;
}

/**
 * note: Admission options for opening the remote cache. A draining selector keeps
 * serving its PINNED previous binding so recovery reads and reconciliation of intents
 * frozen under it stay possible; preparing or dispatching a new intent is refused by
 * those verbs themselves, never by this gate.
 */
export type RemoteCacheAdmission = Readonly<{
  previousDuringDraining?: boolean;
  settleOutbox?: boolean;
}>;

function drainingPreviousBinding(
  location: CollaborationLocation,
  binding: CollaborationBinding,
  admission: RemoteCacheAdmission,
): boolean {
  if (admission.previousDuringDraining !== true || binding.version !== 3) return false;
  const selection = location.selection;
  const previous = selection?.previous ?? null;
  return (
    selection?.phase === "draining" &&
    previous !== null &&
    previous.mode === "remote" &&
    binding.repoKey === location.repoKey &&
    binding.mode === location.mode &&
    binding.selectorCommit === previous.selectorCommit &&
    binding.generation === previous.generation
  );
}

function remoteCacheScope(
  context: StoreContext,
  resolved?: { location: CollaborationLocation; binding: CollaborationBinding },
  options: RemoteCacheAdmission = {},
): { location: CollaborationLocation; binding: CollaborationBinding } {
  const location = resolved?.location ?? resolveCollaborationLocation(context);
  if (location.mode !== "remote") {
    throw new StoreError(
      "collaboration.stale-binding",
      `This checkout resolves ${location.mode} collaboration, not remote, so it has no remote cache lane to read. ` +
        `Use the local domain verbs for this scope; nothing was modified.`,
    );
  }
  const binding = resolved?.binding ?? readCollaborationBinding(context);
  if (binding === null || binding.state !== "active") {
    throw new StoreError(
      "collaboration.stale-binding",
      `This control checkout resolves remote collaboration from ${AUTHORITY_REF} but holds no finalized remote binding, ` +
        `so it cannot be proven to belong to that selector generation. Record it with the reviewed remote bind ` +
        `("mstar store collaboration remote bind --input <file|->"); nothing was read or created.`,
    );
  }
  if (!drainingPreviousBinding(location, binding, options)) assertBindingMatches(binding, location);
  return { location, binding };
}

/** note: The lane's own identity must equal the checkout binding's: a replaced generation is stale. */
export function assertRemoteCacheIdentity(authority: CollaborationAuthority, binding: CollaborationBinding): void {
  if (binding.version !== 3 || binding.storeId !== authority.storeId || binding.epoch !== authority.epoch) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This checkout is bound to remote cache store ${binding.version === 3 ? binding.storeId : "?"} epoch ` +
        `${binding.version === 3 ? String(binding.epoch) : "?"}, but the lane resolved to store ${authority.storeId} ` +
        `epoch ${String(authority.epoch)}. Re-establish the cache with the reviewed remote bind; nothing was modified.`,
    );
  }
}

function localBindingMode(mode: CollaborationMode): "local" | "mirror" {
  if (mode === "remote") remoteLaneRefusal();
  return mode;
}

function assertBindingMatches(binding: CollaborationBinding, location: CollaborationLocation): void {
  if (binding.repoKey !== location.repoKey || binding.mode !== location.mode) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This control checkout is bound to repository ${binding.repoKey} (${binding.mode}), but now resolves to ` +
        `${location.repoKey} (${location.mode}); an origin or .mstarc retarget never re-points a bound checkout. Re-resolve ` +
        `the scope deliberately (mstar path resolve) and start a new checkout for the other repository. Nothing was modified.`,
    );
  }
  if (binding.version !== 3) return;
  const selection = location.selection;
  if (selection === undefined || binding.selectorCommit !== selection.commit || binding.generation !== selection.generation) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This control checkout is bound to the remote selector commit ${binding.selectorCommit} generation ` +
        `${String(binding.generation)}, but the origin's checked selector is ` +
        `${selection === undefined ? "not part of this resolution" : `${selection.commit} generation ${String(selection.generation)}`}. ` +
        `A moved or replaced selector is adopted only by the reviewed remote bind; inspect it with mstar path resolve. ` +
        `Nothing was modified.`,
    );
  }
}

function assertSelectedLane(context: StoreContext, location: CollaborationLocation): void {
  const binding = readCollaborationBinding(context);
  if (location.mode === "remote") {
    if (binding === null || binding.state !== "active") {
      throw new StoreError(
        "collaboration.stale-binding",
        `This control checkout resolves remote collaboration from ${AUTHORITY_REF} but holds no finalized remote binding, ` +
          `so it cannot be proven to belong to that selector generation. Record it with the reviewed remote bind; nothing ` +
          `was read or created.`,
      );
    }
    assertBindingMatches(binding, location);
    remoteLaneRefusal();
  }
  if (binding !== null && binding.version === 3) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This checkout is recorded as bound to the remote selector commit ${binding.selectorCommit} generation ` +
        `${String(binding.generation)}, but it resolves ${location.mode} collaboration. A remote-bound checkout never falls ` +
        `back to local rows; complete the reviewed remote bind or start a fresh local/mirror checkout. Nothing was read or modified.`,
    );
  }
}

function assertBoundScope(context: StoreContext, location: CollaborationLocation): CollaborationBinding | null {
  const binding = readCollaborationBinding(context);
  if (binding === null || binding.state !== "active") return null;
  assertBindingMatches(binding, location);
  return binding;
}

/** The checkout scope guard: the legacy-owner probe plus the retarget refusal. */
export async function assertControlCheckoutScope(context: StoreContext, location: CollaborationLocation): Promise<void> {
  const binding = assertBoundScope(context, location);
  await assertNoLegacyCollaborationOwner(context, binding !== null);
}

async function checkoutScopeBinding(
  context: StoreContext,
  location: CollaborationLocation,
): Promise<CollaborationBinding | null> {
  const binding = assertBoundScope(context, location);
  await assertNoLegacyCollaborationOwner(context, binding !== null);
  return binding;
}

async function assertControlBinding(
  context: StoreContext,
  location: CollaborationLocation,
  authority: CollaborationAuthority,
  requirement: "read" | "write",
): Promise<void> {
  const binding = await checkoutScopeBinding(context, location);
  if (binding === null) {
    if (requirement === "read") return;
    throw new StoreError(
      "collaboration.stale-binding",
      `This checkout holds no collaboration binding for the ACTIVE authority store ${authority.storeId} at ` +
        `${location.dbPath}, so it cannot be proven to own it. Acquire it with the supported adoption verb: ` +
        `mstar store collaboration adopt --harness ${context.harnessDir} --expect-store ${authority.storeId} ` +
        `(or re-run the activation/restore that published this generation). store init never adopts an active authority, ` +
        `so it is not the recovery. Nothing was modified.`,
    );
  }
  if (
    binding.repoKey !== location.repoKey ||
    binding.mode !== location.mode ||
    binding.storeId !== authority.storeId ||
    binding.epoch !== authority.epoch
  ) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This control checkout was bound to repository ${binding.repoKey} (${binding.mode}) store ${binding.storeId} epoch ` +
        `${String(binding.epoch)}, but the lane at ${location.dbPath} is repository ${authority.repoKey} (${authority.mode}) ` +
        `store ${authority.storeId} epoch ${String(authority.epoch)}. A replaced authority is adopted deliberately by its own ` +
        `activation, restore or "store collaboration adopt", never by drift; inspect it with mstar path resolve. Nothing was modified.`,
    );
  }
}

export async function openCollaborationStore(
  context: StoreContext,
  mode: "read" | "write",
  expected?: CollaborationStamp,
): Promise<CollaborationStoreHandle> {
  assertStoreRuntimeSupported();
  const location = resolveCollaborationLocation(context);
  assertSelectedLane(context, location);
  if (mode === "write" && existsSync(location.dbPath)) {
    try {
      accessSync(location.dbPath, constants.W_OK);
    } catch (error) {
      throw unreadable(location.dbPath, `the store file is not writable (${publicationCause(error)})`);
    }
  }
  const handle = await openAdmission(location, "active", expected, busyTimeoutMs());
  try {
    await assertControlBinding(context, location, handle.authority, mode);
  } catch (error) {
    handle.close();
    throw error;
  }
  return handle;
}

/** The active authority record alone; no handle escapes and nothing is created. */
export async function readCollaborationAuthority(context: StoreContext): Promise<CollaborationAuthority> {
  const handle = await openCollaborationStore(context, "read");
  handle.close();
  return handle.authority;
}

function probeRefusal(error: unknown): { code: string; message: string } {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return {
    code: typeof code === "string" && code !== "" ? code : "collaboration.unreadable",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The collaboration lane's authority probe for host gates: it reads ONLY this
 * lane, so the execution store may be absent, staged, or damaged in its
 * execution metadata without changing the verdict. An execution store an
 * UNBOUND checkout cannot inspect is `unavailable` (it cannot be proven
 * innocent of legacy collaboration rows); a bound checkout leaves that file to
 * the execution domain's own refusal. Classification comes from ONE admission
 * call's typed refusal — `collaboration.not-initialized` is `absent`,
 * `collaboration.not-active` is `staged`, and every other cause (identity,
 * mode, runtime, a rejected storage path, corrupt bytes, a stale binding) is
 * `unavailable` with its original recovery — so a symlinked or non-private
 * storage component is never reported as a missing database.
 */
export async function probeCollaborationAuthority(context: StoreContext): Promise<CollaborationAuthorityProbe> {
  try {
    return { kind: "active", authority: await readCollaborationAuthority(context) };
  } catch (error) {
    const refusal = probeRefusal(error);
    if (refusal.code === "collaboration.not-initialized") return { kind: "absent", ...refusal };
    if (refusal.code === "collaboration.not-active") return { kind: "staged", ...refusal };
    return { kind: "unavailable", ...refusal };
  }
}

/**
 * The complete observation of one domain read: the scope, the authority and the
 * revision counters read INSIDE the caller's own open handle, so the evidence a
 * consumer receives and the rows it read are one snapshot. This is the single
 * source-layer proof builder for direct domain reads and read envelopes.
 */
export function readCollaborationObservation(
  handle: CollaborationStoreHandle,
  scope: CollaborationScope,
): CompleteCollaborationObservation {
  const asOf = new Date().toISOString();
  const row = handle.db.prepare("select revision, catalog_revision from collaboration_meta where id = 1").get() as
    | { revision?: unknown; catalog_revision?: unknown }
    | undefined;
  const revision = row?.revision;
  const catalogRevision = row?.catalog_revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || typeof catalogRevision !== "number" || !Number.isInteger(catalogRevision)) {
    throw new StoreError(
      "collaboration.unreadable",
      "The collaboration authority has no readable revision counters; this read cannot state the snapshot it answered at.",
    );
  }
  const { repoKey, mode, storeId, epoch } = handle.authority;
  return { scope, completeness: "complete", asOf, authority: { repoKey, mode, storeId, epoch }, revision, catalogRevision };
}

/**
 * Read one existing store in EITHER state under its admission checks: the
 * cutover's stage/copy verification and publication inspection need the same
 * private-path, schema and binding proof, but a staged (not yet active) target
 * is exactly what they must inspect. Nothing here is a runtime read of staged
 * business data and the returned connection is read-only.
 */
export async function readCollaborationStage<T>(
  location: CollaborationLocation,
  apply: (scope: { db: StoreDb; authority: CollaborationAuthority }) => T,
): Promise<T> {
  assertStoreRuntimeSupported();
  if (location.mode === "remote") remoteLaneRefusal();
  const handle = await openAdmission(location, "any", undefined, busyTimeoutMs());
  try {
    return apply({ db: handle.db, authority: handle.authority });
  } finally {
    handle.close();
  }
}

/**
 * Run one cutover effect on the canonical target inside a write transaction,
 * admitted in EITHER state so staging and the final publication both use the
 * same `BEGIN IMMEDIATE` + guarded connection the runtime writer has. The caller
 * owns the state decision (it must re-check the staged/active state inside the
 * transaction); this wrapper owns admission, the lock and the commit.
 */
export async function writeCollaborationStage<T>(
  location: CollaborationLocation,
  apply: (scope: { db: StoreDb; authority: CollaborationAuthority }) => T,
  context?: StoreContext,
): Promise<T> {
  assertStoreRuntimeSupported();
  if (location.mode === "remote") remoteLaneRefusal();
  return writeStage(location, apply, context);
}

/**
 * note: The remote lane's own staging transaction: `remote bind` creates or advances the cache
 * under the same `BEGIN IMMEDIATE` + guarded connection, admitted in either state
 * so a fresh staged lane can be published and its binding rows committed once.
 * When the caller passes its context, the checked selection is re-proved on the
 * live ref immediately before commit.
 */
export async function writeRemoteCacheStage<T>(
  location: CollaborationLocation,
  apply: (scope: { db: StoreDb; authority: CollaborationAuthority }) => T,
  context?: StoreContext,
): Promise<T> {
  assertStoreRuntimeSupported();
  return writeStage(location, apply, context);
}

async function writeStage<T>(
  location: CollaborationLocation,
  apply: (scope: { db: StoreDb; authority: CollaborationAuthority }) => T,
  context?: StoreContext,
): Promise<T> {
  const dbPath = location.dbPath;
  const timeout = busyTimeoutMs();
  assertAdmittedTarget(dbPath);
  if (!existsSync(dbPath)) throw notInitialized(dbPath);
  const probe = await connectAt(dbPath, "read", timeout);
  try {
    admit(probe, location, undefined, "any");
  } finally {
    probe.close();
  }
  const db = await connectAt(dbPath, "write", timeout, { noCreate: true, keepJournalMode: true }).catch(
    (error: unknown) => {
      if (!existsSync(dbPath)) throw notInitialized(dbPath);
      throw error;
    },
  );
  try {
    db.exec("begin immediate");
    try {
      const authority = admit(db, location, undefined, "any");
      const result = apply({ db: guardedWriteDb(db), authority });
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new StoreError(
          "store.corrupt",
          "A collaboration cutover effect must be synchronous. The returned thenable was rejected before commit and " +
            "nothing was written.",
        );
      }
      if (context !== undefined) assertSelectionUnchanged(context, location);
      db.exec("commit");
      return result;
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
      }
      throw error;
    }
  } finally {
    try {
      db.close();
    } catch {
    }
  }
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
  return withWriteLane(context, apply, expected, "domain");
}

/**
 * note: Run one effect on the remote cache inside a write transaction. The scope is the
 * checkout's v3 binding against the checked selector, and the lane identity must
 * equal it; the transaction mechanics are the local writer's.
 */
export async function withRemoteCacheWrite<T>(
  context: StoreContext,
  apply: (handle: CollaborationStoreHandle) => T,
  admission: RemoteCacheAdmission = {},
): Promise<T> {
  return withWriteLane(context, apply, undefined, "remote-cache", admission);
}

/**
 * invariant: The remote-cache write lane HELD across an awaited effect. The composite decline and
 * the provider freeze are one pair of decisions over the same outbox: a decline must observe every
 * intent that froze before it, and a freeze must observe a decline that committed before it. Both
 * therefore take this one lane, and the decline commits its durable phase while holding it, so
 * neither ordering can leave a durable intent under a released reservation. Every other effect
 * stays synchronous — the synchronous-effect refusal of `withRemoteCacheWrite` is unchanged.
 */
export async function withRemoteCacheWriteHeld<T>(
  context: StoreContext,
  apply: (handle: CollaborationStoreHandle) => Promise<T>,
  admission: RemoteCacheAdmission = {},
): Promise<T> {
  return withWriteLane(context, apply, undefined, "remote-cache", admission, true);
}

/**
 * note: The outbox settlement lane: the ONLY write lane that admits a below-current remote cache,
 * constructed here alone and restricted to the outbox surface. Ordinary business verbs keep the
 * unchanged `collaboration.upgrade-required` refusal of `withRemoteCacheWrite`.
 */
export async function withRemoteCacheRecoveryWrite<T>(
  context: StoreContext,
  apply: (handle: CollaborationStoreHandle) => T,
  admission: RemoteCacheAdmission = {},
): Promise<T> {
  return withWriteLane(context, apply, undefined, "remote-cache", admission, false, true);
}

async function withWriteLane<T>(
  context: StoreContext,
  apply: (handle: CollaborationStoreHandle) => T | Promise<T>,
  expected: CollaborationStamp | undefined,
  lane: "domain" | "remote-cache",
  admission: RemoteCacheAdmission = {},
  holdAsync = false,
  recovery = false,
): Promise<T> {
  assertStoreRuntimeSupported();
  let location: CollaborationLocation;
  let remoteBinding: CollaborationBinding | undefined;
  if (lane === "remote-cache") {
    const scope = remoteCacheScope(context, undefined, admission);
    location = scope.location;
    remoteBinding = scope.binding;
  } else {
    location = resolveCollaborationLocation(context);
    assertSelectedLane(context, location);
  }
  const dbPath = location.dbPath;
  const timeout = busyTimeoutMs();
  assertAdmittedTarget(dbPath);
  if (!existsSync(dbPath)) throw notInitialized(dbPath);

  const probe = await connectAt(dbPath, "read", timeout);
  try {
    const admitted = admit(probe, location, expected, "active", recovery ? { ...admission, settleOutbox: true } : admission);
    if (lane === "remote-cache") assertRemoteCacheIdentity(admitted, remoteBinding!);
    else await assertControlBinding(context, location, admitted, "write");
  } finally {
    probe.close();
  }

  const openedInode = lane === "remote-cache" ? laneInodeOf(dbPath) : null;
  const db = await connectAt(dbPath, "write", timeout, { noCreate: true, keepJournalMode: true }).catch(
    (error: unknown) => {
      if (!existsSync(dbPath)) throw notInitialized(dbPath);
      throw error;
    },
  );
  try {
    db.exec("begin immediate");
    try {
      const authority = admit(db, location, expected, "active", recovery ? { ...admission, settleOutbox: true } : admission);
      if (lane === "remote-cache") assertRemoteCacheIdentity(authority, remoteBinding!);
      const effect = apply({
        db: guardedWriteDb(recovery ? recoverySurfaceDb(db) : db),
        authority,
        close(): never {
          throw transactionOwnershipRefusal();
        },
      });
      let result: T;
      if (isThenable(effect)) {
        if (!holdAsync) {
          void Promise.resolve(effect).catch(() => undefined);
          throw new StoreError(
            "store.corrupt",
            "A collaboration write effect must be synchronous. The returned thenable was rejected before commit and " +
              "nothing was written.",
          );
        }
        result = (await effect) as T;
      } else {
        result = effect as T;
      }
      assertSelectionUnchanged(context, location);
      if (lane === "remote-cache") assertRemoteCacheIdentity(authority, remoteBinding!);
      if (openedInode !== null && laneInodeOf(dbPath) !== openedInode) {
        throw new StoreError(
          "collaboration.stale-binding",
          `The remote cache at ${dbPath} was replaced by another generation while this write held its transaction, so the ` +
            `bytes it wrote are not the cache this checkout now serves. Re-read the lane and retry; nothing was committed.`,
        );
      }
      db.exec("commit");
      return result;
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
      }
      throw error;
    }
  } finally {
    try {
      db.close();
    } catch {
    }
  }
}

/**
 * note: Open the remote cache lane's active handle. This is the ONLY open that serves a
 * remote checkout: the local domain entries refuse a remote selection outright,
 * so a cache row can never be read or written as local authority.
 */
export async function openRemoteCache(
  context: StoreContext,
  mode: "read" | "write",
  resolved?: { location: CollaborationLocation; binding: CollaborationBinding },
  admission: RemoteCacheAdmission = {},
): Promise<CollaborationStoreHandle> {
  return openRemoteCacheAdmission(context, mode, resolved, admission, false);
}

/**
 * note: The outbox recovery open: the ONLY admission that may serve a below-current cache whose
 * recorded version this build still declares an inventory for, and it is constructed here alone —
 * no caller-passed flag on the ordinary open. The handle it returns is restricted to the outbox
 * surface, so the lane can be settled but is never read or written as a current store.
 */
export async function openRemoteCacheRecovery(
  context: StoreContext,
  mode: "read" | "write",
  resolved?: { location: CollaborationLocation; binding: CollaborationBinding },
  admission: RemoteCacheAdmission = {},
): Promise<CollaborationStoreHandle> {
  return openRemoteCacheAdmission(context, mode, resolved, admission, true);
}

async function openRemoteCacheAdmission(
  context: StoreContext,
  mode: "read" | "write",
  resolved: { location: CollaborationLocation; binding: CollaborationBinding } | undefined,
  admission: RemoteCacheAdmission,
  recovery: boolean,
): Promise<CollaborationStoreHandle> {
  assertStoreRuntimeSupported();
  const { location, binding } = remoteCacheScope(context, resolved, admission);
  if (mode === "write" && existsSync(location.dbPath)) {
    try {
      accessSync(location.dbPath, constants.W_OK);
    } catch (error) {
      throw unreadable(location.dbPath, `the store file is not writable (${publicationCause(error)})`);
    }
  }
  const handle = await openAdmission(
    location,
    "active",
    undefined,
    busyTimeoutMs(),
    recovery ? { ...admission, settleOutbox: true } : admission,
  );
  try {
    assertRemoteCacheIdentity(handle.authority, binding);
  } catch (error) {
    handle.close();
    throw error;
  }
  if (!recovery) return handle;
  try {
    assertRecoverySurfaceIsolated(handle.db);
  } catch (error) {
    handle.close();
    throw error;
  }
  return { db: recoverySurfaceDb(handle.db), authority: handle.authority, close: handle.close };
}

const REMOTE_CACHE_RECOVERY_TABLES: ReadonlySet<string> = new Set([
  ...COLLABORATION_REMOTE_TABLES,
  ...COLLABORATION_OUTBOX_TABLES,
]);

function recoverySurfaceRefusal(reason: string): StoreError {
  return new StoreError(
    "collaboration.upgrade-required",
    `The recovery open of a below-current remote cache serves only the outbox surface; ${reason} is outside this admission. Settle every unsettled outbox intent, rerun the reviewed remote bind to replace the cache, and retry the domain verb against the current cache. Nothing was read or modified.`,
  );
}

const RECOVERY_FORBIDDEN_FORM = /\b(pragma|attach|detach|vacuum|create|drop|alter|temp)\b/;
const RECOVERY_FORBIDDEN_REPLACE = /(?:^|;)\s*replace\s+into\b/;

function recoverySurfaceGuard(sql: string): void {
  const text = sql.toLowerCase();
  for (const table of COLLABORATION_TABLES) {
    if (REMOTE_CACHE_RECOVERY_TABLES.has(table)) continue;
    if (new RegExp(`\\b${table}\\b`).test(text)) throw recoverySurfaceRefusal(`the domain table "${table}"`);
  }
  if (RECOVERY_FORBIDDEN_REPLACE.test(text)) throw recoverySurfaceRefusal("a replace statement form");
  const forbidden = RECOVERY_FORBIDDEN_FORM.exec(text);
  if (forbidden !== null) throw recoverySurfaceRefusal(`a ${forbidden[1]} statement form`);
  if (![...REMOTE_CACHE_RECOVERY_TABLES].some((table) => new RegExp(`\\b${table}\\b`).test(text))) {
    throw recoverySurfaceRefusal("a statement over no recovery-surface table");
  }
}

function assertRecoverySurfaceIsolated(db: StoreDb): void {
  const tables: string[] = [];
  for (const row of db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name?: unknown }>) {
    if (typeof row.name === "string" && !row.name.startsWith("sqlite_")) tables.push(row.name.toLowerCase());
  }
  const outside = tables.filter((table) => !REMOTE_CACHE_RECOVERY_TABLES.has(table));
  const objects = db
    .prepare("select type, name, tbl_name, sql from sqlite_master where type in ('trigger','view')")
    .all() as Array<{ type?: unknown; name?: unknown; tbl_name?: unknown; sql?: unknown }>;
  for (const row of objects) {
    const type = typeof row.type === "string" ? row.type : "";
    const name = typeof row.name === "string" ? row.name : "";
    const table = typeof row.tbl_name === "string" ? row.tbl_name.toLowerCase() : "";
    const body = (typeof row.sql === "string" ? row.sql : "").toLowerCase();
    if (type === "trigger" && REMOTE_CACHE_RECOVERY_TABLES.has(table)) {
      throw recoverySurfaceRefusal(`the trigger "${name}" on the recovery table "${table}"`);
    }
    if (type === "trigger" && ![...REMOTE_CACHE_RECOVERY_TABLES].some((t) => new RegExp(`\\b${t}\\b`).test(body))) {
      continue;
    }
    const reached = outside.find((t) => new RegExp(`\\b${t}\\b`).test(body));
    if (reached !== undefined) throw recoverySurfaceRefusal(`the ${type} "${name}" reaching the table "${reached}"`);
  }
}

function recoverySurfaceDb(db: StoreDb): StoreDb {
  return {
    exec(sql: string): void {
      recoverySurfaceGuard(sql);
      db.exec(sql);
    },
    prepare(sql: string) {
      recoverySurfaceGuard(sql);
      return db.prepare(sql);
    },
    close(): void {
      db.close();
    },
  };
}

/** note: The active remote cache identity alone; nothing is created. */
export async function readRemoteCacheAuthority(context: StoreContext): Promise<CollaborationAuthority> {
  const handle = await openRemoteCache(context, "read");
  handle.close();
  return handle.authority;
}

/**
 * note: Record a checkout's v3 remote binding. Only the reviewed `remote bind` writes it,
 * and only AFTER the cache binding transaction committed: a crash between the
 * two leaves a committed lane whose binding file the same verb completes.
 */
export function writeRemoteCollaborationBinding(
  context: StoreContext,
  binding: Readonly<{
    repoKey: string;
    selectorCommit: string;
    generation: number;
    storeId: string;
    epoch: number;
  }>,
): CollaborationBinding {
  const existing = readCollaborationBinding(context);
  if (
    existing !== null &&
    existing.version === 3 &&
    (existing.repoKey !== binding.repoKey ||
      existing.generation > binding.generation ||
      (existing.generation === binding.generation && existing.selectorCommit !== binding.selectorCommit))
  ) {
    throw new StoreError(
      "collaboration.stale-binding",
      `This checkout already records remote selector commit ${existing.selectorCommit} generation ` +
        `${String(existing.generation)}, so the bind's commit ${binding.selectorCommit} generation ` +
        `${String(binding.generation)} is never published over it. The cache transaction committed; ` +
        `re-run the reviewed bind for the current selector to publish a matching checkout binding.`,
    );
  }
  const path = bindingPath(context);
  mkdirSync(dirname(path), { recursive: true });
  const body: CollaborationBinding = {
    version: 3,
    state: "active",
    repoKey: binding.repoKey,
    mode: "remote",
    selectorCommit: binding.selectorCommit,
    generation: binding.generation,
    storeId: binding.storeId,
    epoch: binding.epoch,
    boundAt: nowRfc3339(),
  };
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return body;
}
