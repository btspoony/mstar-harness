/**
 * collaboration cutover -- reviewed manifest, verified staged copy, activation
 * claim, durable source fence, guarded publication and replay.
 *
 * Run with `bun test packages/engine/src/collaboration-cutover.test.ts`.
 *
 * Every case builds a synthetic checkout, a combined control store and an
 * isolated user home under the temp root; the home is installed at the one
 * runtime boundary the identity resolver calls (`node:os` `homedir`), so no case
 * reads the real home or the control harness store.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { resolveCollaborationLocation, type CollaborationLocation } from "./collaboration-identity.js";
import {
  applyCollaborationCutover,
  activateCollaborationCutover,
  fenceCollaborationCutoverSource,
  planCollaborationCutover,
} from "./collaboration-cutover.js";
import {
  readCollaborationAuthority,
  readCollaborationStage,
  type CollaborationAuthority,
} from "./collaboration-store.js";
import {
  ACTIVATION_PROTOCOL_VERSION,
  backupStore,
  type ActivationAttestation,
} from "./store-activation.js";
import { readHarnessVersion } from "./core.js";
import { replaceRoadmapAuthority } from "./roadmap-store.js";
import { historicalStore } from "./store-migration-fixtures.js";
import {
  MIGRATIONS,
  initializeStore,
  openStore,
  readAppliedMigrations,
  readCollaborationFence,
  readStoreAuthority,
  validateAppliedMigrations,
  type StoreContext,
} from "./store-db.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-collab-cutover-")));
const HOME = join(ROOT, "home");
mkdirSync(HOME);
let resolvedHome = HOME;

let homeSpy: { mockRestore(): void } | undefined;

beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => resolvedHome);
});

afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

let sequence = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A synthetic checkout selecting the collaboration mode; `origin` is the repository identity. */
function makeRepo(origin: string, mode = "local"): string {
  const dir = join(ROOT, `repo-${sequence++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Cutover Test");
  git(dir, "config", "user.email", "cutover@example.test");
  git(dir, "config", "remote.origin.url", origin);
  writeFileSync(join(dir, ".mstarc"), `[collaboration]\nmode=${mode}\n`);
  return dir;
}

function contextAt(root: string): StoreContext {
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  return { harnessDir, checkoutRoot: root };
}

function locationAt(root: string): CollaborationLocation {
  return resolveCollaborationLocation(contextAt(root));
}

type StoppedHandle = { kind: "process" | "session" | "host" | "consumer"; id: string };

/**
 * A cutover-scope attestation. The block names the exact control root, source
 * generation and stopped handles; a case overrides only the field it attacks.
 */
function cutoverOptions(
  context: StoreContext,
  source: { storeId: string; epoch: number; schemaVersion: number },
  variant: {
    stopped?: readonly string[];
    handles?: readonly StoppedHandle[];
    build?: string;
    repoKey?: string;
    mode?: "local" | "mirror";
    controlRoot?: string;
    sourceStoreId?: string;
    sourceEpoch?: number;
    allHandlesStopped?: boolean | "missing";
    omitCutover?: boolean;
  } = {},
): { operator: string; attestation: ActivationAttestation } {
  const location = resolveCollaborationLocation(context);
  const stopped = variant.stopped ?? ["session-one"];
  const handles: readonly StoppedHandle[] = variant.handles ?? [
    { kind: "session", id: "session-one" },
    { kind: "process", id: "mstar-cli" },
  ];
  const attestation: ActivationAttestation = {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt: "2026-11-21T00:00:00.000Z",
    operator: { actor: "ops-engineer", authorizationRef: "iteration compass / cutover decision" },
    consumers: [
      {
        entryId: "coordinator-omp",
        kind: "coordinator",
        entrypoint: "/opt/mstar/omp/dist/index.js",
        runtime: "node",
        runtimeVersion: process.versions.node,
        version: variant.build ?? readHarnessVersion(),
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions: stopped.map((sessionId) => ({ sessionId, host: "omp", state: "stopped" as const })),
  };
  if (variant.omitCutover !== true) {
    // A raw document so a negative case can carry `false` for the validator.
    const block: Record<string, unknown> = {
      repoKey: variant.repoKey ?? location.repoKey,
      mode: variant.mode ?? location.mode,
      controlRoot: variant.controlRoot ?? resolve(context.harnessDir),
      sourceStoreId: variant.sourceStoreId ?? source.storeId,
      sourceEpoch: variant.sourceEpoch ?? source.epoch,
      schemaVersion: source.schemaVersion,
      stoppedHandles: [...handles],
    };
    if (variant.allHandlesStopped !== "missing") block.allHandlesStopped = variant.allHandlesStopped ?? true;
    attestation.cutover = block as unknown as ActivationAttestation["cutover"];
  }
  return { operator: "ops-engineer", attestation };
}

/** A valid project roadmap body (frontmatter + sections), as the producer requires. */
const ROADMAP_CONTENT =
  "---\nproject_id: p-one\ntitle: Synthetic roadmap\nstatus: active\ncreated_at: 2026-09-25\n---\n\n" +
  "## Direction\n\nCutover fixture.\n\n## Goals\n\n- [ ] Parent goal\n";

/**
 * A real SCHEMA-19 combined source (the pre-cutover schema): collaboration rows,
 * a catalog pin with its cross-domain foreign key, a recorded session and an
 * execution row. The fence must advance it to the current schema inside its own
 * transaction.
 */
function seedSchema19Source(repo: string): { context: StoreContext; storeId: string; pinColumns: string[] } {
  const context = contextAt(repo);
  const db = historicalStore(context.harnessDir, 19);
  try {
    db.exec(`
insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at)
values ('project', 'p-one', 'Project One', 'projects', 'p-one/roadmap.md', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at)
values ('plan', 'plan-one', 'Plan One', 'plans', 'plan-one.md', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into catalog_entities(kind, id, title, root_kind, relative_path, document_kind, registered_at, updated_at)
values ('document', 'doc-one', 'Doc One', 'knowledge', 'notes/one.md', 'knowledge', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into catalog_links(from_kind, from_id, relation, to_kind, to_id)
values ('plan', 'plan-one', 'belongs-to', 'project', 'p-one');
insert into catalog_links(from_kind, from_id, relation, to_kind, to_id)
values ('plan', 'plan-one', 'documents', 'document', 'doc-one');
insert into project_milestones(milestone_id, project_id, name, ordinal, created_at, updated_at)
values ('m-one', 'p-one', 'Milestone One', 0, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into project_roadmaps(project_id, content_markdown, content_hash, revision, updated_at)
values ('p-one', '# Roadmap', 'roadmap-hash', 1, '2026-11-21T00:00:00.000Z');
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key, milestone_id)
values ('I-000001', 'p-one', 'First finding', 'bug', 'high', 'open', 'It broke', 'It stays fixed', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'identity-one', 'm-one');
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)
values ('I-000002', 'p-one', 'Second finding', 'risk', 'medium', 'resolved', 'Risk', 'Mitigated', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'identity-two');
insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, evidence_json, discovered_at, recorded_at)
values ('I-000001', 'occ-one', 'test', 'suite/one', 'root-one', 'accept-one', 'packages/engine', 'observed', '{}', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into issue_transitions(issue_id, from_disposition, to_disposition, actor, occurred_at, recorded_at, reason, evidence_json, issue_revision)
values ('I-000002', 'open', 'resolved', 'tester', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'fixed', '{}', 2);
insert into provenance(issue_id, kind, target, source_hash, origin)
values ('I-000001', 'plan', 'plan-one', 'hash-one', 'scoped');
insert into relations(from_issue, relation, to_issue) values ('I-000001', 'related', 'I-000002');
insert into project_bindings(project_id, provider, workspace, team, remote_project, revision, updated_at)
values ('p-one', 'linear', 'acme', 'ENG', 'acme/eng', 1, '2026-11-21T00:00:00.000Z');
insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, created_at, updated_at)
values ('op-one', 'op-hash', 'committed', '{}', '{}', '{}', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into catalog_execution_bindings(workflow_id, catalog_kind, catalog_id, workflow_root_kind, workflow_relative_path, catalog_revision, input_hash, pin_json, operation_id)
values ('wf-one', 'plan', 'plan-one', 'plans', 'plan-one.md', 1, 'pin-hash', '{}', 'op-one');
insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at)
values ('wf-live', 1, 'session-one', '{}', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at)
values ('wf-live', 'coordinator', 'session-one', 1, 1, 'active', '2026-11-21T00:00:00.000Z');
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('issue-op-legacy', 'legacy-request-hash', '{"issueId":"I-000001","revision":1,"storeRevision":7,"created":true}', '2026-11-21T00:00:00.000Z');
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('restore-attempt:abc', 'restore-hash', '{"recoveryVersion":1,"phase":"replaced","storeId":"restored-store","verified":{"integrity":"ok","foreignKeys":"ok","schemaVersion":19}}', '2026-11-21T00:00:02.000Z');
update issue_counter set next_value = 3 where id = 1;
update store_meta set revision = 7, catalog_revision = 3 where id = 1;
`);
    const storeId = (db.prepare("select store_id from store_meta where id = 1").get() as { store_id: string }).store_id;
    return {
      context,
      storeId,
      pinColumns: [
        "workflow_id",
        "catalog_kind",
        "catalog_id",
        "workflow_root_kind",
        "workflow_relative_path",
        "catalog_revision",
        "input_hash",
        "pin_json",
        "operation_id",
      ],
    };
  } finally {
    db.close();
  }
}

/**
 * One populated combined source: a project, a plan, a document and their link,
 * a milestone, a roadmap, two issues (one open with history, one resolved), a
 * mirror binding and a committed catalog journal entry. The shared counters are
 * advanced to 7/3 so the copied revisions are distinguishable from 0.
 */
async function seedSource(repo: string): Promise<{ context: StoreContext; storeId: string }> {
  const context = contextAt(repo);
  const handle = await initializeStore(context);
  let storeId: string;
  try {
    const db = handle.db;
    db.exec(`
insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at)
values ('project', 'p-one', 'Project One', 'projects', 'p-one/roadmap.md', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at)
values ('plan', 'plan-one', 'Plan One', 'plans', 'plan-one.md', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into catalog_entities(kind, id, title, root_kind, relative_path, document_kind, registered_at, updated_at)
values ('document', 'doc-one', 'Doc One', 'knowledge', 'notes/one.md', 'knowledge', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into catalog_links(from_kind, from_id, relation, to_kind, to_id)
values ('plan', 'plan-one', 'belongs-to', 'project', 'p-one');
insert into catalog_links(from_kind, from_id, relation, to_kind, to_id)
values ('plan', 'plan-one', 'documents', 'document', 'doc-one');
insert into project_milestones(milestone_id, project_id, name, ordinal, created_at, updated_at)
values ('m-one', 'p-one', 'Milestone One', 0, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key, milestone_id)
values ('I-000001', 'p-one', 'First finding', 'bug', 'high', 'open', 'It broke', 'It stays fixed', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'identity-one', 'm-one');
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)
values ('I-000002', 'p-one', 'Second finding', 'risk', 'medium', 'resolved', 'Risk', 'Mitigated', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'identity-two');
insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, evidence_json, discovered_at, recorded_at)
values ('I-000001', 'occ-one', 'test', 'suite/one', 'root-one', 'accept-one', 'packages/engine', 'observed', '{}', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into issue_transitions(issue_id, from_disposition, to_disposition, actor, occurred_at, recorded_at, reason, evidence_json, issue_revision)
values ('I-000002', 'open', 'resolved', 'tester', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'fixed', '{}', 2);
insert into provenance(issue_id, kind, target, source_hash, origin)
values ('I-000001', 'plan', 'plan-one', 'hash-one', 'scoped');
insert into relations(from_issue, relation, to_issue) values ('I-000001', 'related', 'I-000002');
insert into project_bindings(project_id, provider, workspace, team, remote_project, revision, updated_at)
values ('p-one', 'linear', 'acme', 'ENG', 'acme/eng', 1, '2026-11-21T00:00:00.000Z');
insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, created_at, updated_at)
values ('op-one', 'op-hash', 'committed', '{}', '{}', '{}', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into catalog_execution_bindings(workflow_id, catalog_kind, catalog_id, workflow_root_kind, workflow_relative_path, catalog_revision, input_hash, pin_json, operation_id)
values ('wf-one', 'plan', 'plan-one', 'plans', 'plan-one.md', 1, 'pin-hash', '{}', 'op-one');
insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at)
values ('wf-live', 1, 'session-one', '{}', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at)
values ('wf-live', 'coordinator', 'session-one', 1, 1, 'active', '2026-11-21T00:00:00.000Z');
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('issue-op-legacy', 'legacy-request-hash', '{"issueId":"I-000001","revision":1,"storeRevision":7,"created":true}', '2026-11-21T00:00:00.000Z');
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('restore-attempt:customer-request', 'customer-hash', '{"issueId":"I-000002","revision":2,"storeRevision":7,"created":false}', '2026-11-21T00:00:01.000Z');
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('restore-attempt:abc', 'restore-hash', '{"recoveryVersion":1,"phase":"replaced","storeId":"restored-store","verified":{"integrity":"ok","foreignKeys":"ok","schemaVersion":20}}', '2026-11-21T00:00:02.000Z');
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('upgrade-op', 'upgrade-hash', '{"verdict":"upgraded","imported":1,"importedIds":["wf-imported"],"skipped":[],"dispositions":[],"sourceDigest":"source-digest","inputDigest":"input-digest"}', '2026-11-21T00:00:03.000Z');
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('upgrade-op-old', 'upgrade-old-hash', '{"verdict":"upgraded","imported":1,"importedIds":["wf-historical"],"skipped":[],"dispositions":[],"sourceDigest":"historical-digest"}', '2026-11-21T00:00:07.000Z');
update issue_counter set next_value = 3 where id = 1;
`);
    storeId = handle.storeId;
  } finally {
    handle.close();
  }
  // A real roadmap write records the producer's own persisted receipt shape
  // (outcome + nullable provenance), which the classifier must recognize.
  await replaceRoadmapAuthority(
    context,
    { projectId: "p-one", expectedProjectRevision: 1, expectedRoadmapRevision: "absent", contentMarkdown: ROADMAP_CONTENT },
    { operationId: "roadmap-op", actor: "cutover-test" },
  );
  const counters = await openStore(context, "write");
  try {
    counters.db.exec("update store_meta set revision = 7, catalog_revision = 3 where id = 1");
  } finally {
    counters.close();
  }
  return { context, storeId };
}

type StagedRows = Readonly<{
  authority: CollaborationAuthority;
  rows: Record<string, Array<Record<string, unknown>>>;
  foreignKeyViolations: unknown[];
}>;

/** The staged target's rows, read under the same admission checks the cutover uses. */
async function stagedRows(location: CollaborationLocation): Promise<StagedRows> {
  return readCollaborationStage(location, ({ db, authority }) => {
    const rows: Record<string, Array<Record<string, unknown>>> = {};
    for (const table of [
      "catalog_entities",
      "catalog_links",
      "issues",
      "issue_counter",
      "occurrences",
      "issue_transitions",
      "provenance",
      "relations",
      "project_bindings",
      "project_milestones",
      "project_roadmaps",
    ]) {
      rows[table] = db.prepare(`select * from ${table}`).all() as Array<Record<string, unknown>>;
    }
    return { authority, rows, foreignKeyViolations: db.prepare("pragma foreign_key_check").all() };
  });
}

/**
 * Durable cutover state on the canonical target: publication phases, the claim
 * slot, and the preserved legacy receipts. Durability evidence has to be read
 * from the committed rows, not from an in-process return value.
 */
async function cutoverState(location: CollaborationLocation): Promise<{
  authority: CollaborationAuthority;
  publications: Array<Record<string, unknown>>;
  claims: unknown[];
  receipts: Array<Record<string, unknown>>;
}> {
  return readCollaborationStage(location, ({ db, authority }) => ({
    authority,
    publications: db.prepare("select manifest_id, phase from cutover_publications order by manifest_id").all() as Array<
      Record<string, unknown>
    >,
    claims: db
      .prepare(
        "select operation_id from collaboration_operations " +
          "where key_space = 'standalone' and operation_id = 'collaboration-cutover-claim'",
      )
      .all(),
    receipts: db
      .prepare(
        "select key_space, operation_id, request_hash, result_json, committed_at from collaboration_operations " +
          "where key_space = 'standalone' and operation_id <> 'collaboration-cutover-claim' order by operation_id",
      )
      .all() as Array<Record<string, unknown>>,
  }));
}

const LOCK_BASENAME = "collaboration-cutover.lock";

function lockPathOf(context: StoreContext): string {
  return join(context.harnessDir, LOCK_BASENAME);
}

/** Run an operation that must refuse; return its stable code and message. */
async function refusalOf(work: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await work();
    return { message: "no refusal" };
  } catch (error) {
    const typed = error as { code?: string; message?: string };
    return { ...(typed.code === undefined ? {} : { code: typed.code }), message: String(typed.message) };
  }
}

function ids(rows: Array<Record<string, unknown>>, column: string): string[] {
  return rows.map((row) => String(row[column])).sort();
}

describe("collaboration cutover", () => {
  test("stage copies exact keys, history, foreign keys and revisions without activating", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-stage.git");
    const source = await seedSource(repo);
    const location = locationAt(repo);

    const manifest = await planCollaborationCutover(source.context);
    expect(manifest.blockers).toEqual([]);
    expect(manifest.source).toMatchObject({ storeId: source.storeId, epoch: 1, schemaVersion: MIGRATIONS.length, revision: 7, catalogRevision: 3 });
    expect(manifest.counts).toMatchObject({ issues: 2, occurrences: 1, relations: 1, provenance: 1, issue_counter: 1 });

    const receipt = await applyCollaborationCutover(source.context, manifest);
    expect(receipt).toMatchObject({ manifestId: manifest.manifestId, phase: "verified", replayed: false });
    expect(receipt.source).toEqual(manifest.source);
    expect(receipt.target).toMatchObject({ repoKey: "github.com/acme/cutover-stage", mode: "local", epoch: 1 });

    const staged = await stagedRows(location);
    expect(staged.authority).toMatchObject({ state: "staged", revision: 7, catalogRevision: 3 });
    expect(ids(staged.rows.issues!, "id")).toEqual(["I-000001", "I-000002"]);
    expect(staged.rows.issues!.find((row) => row.id === "I-000001")?.milestone_id).toBe("m-one");
    expect(staged.rows.issues!.find((row) => row.id === "I-000002")?.disposition).toBe("resolved");
    expect(staged.rows.issue_counter![0]?.next_value).toBe(3);
    expect(ids(staged.rows.catalog_entities!, "id")).toEqual(["doc-one", "p-one", "plan-one"]);
    expect(staged.rows.catalog_links).toHaveLength(2);
    expect(ids(staged.rows.issue_transitions!, "to_disposition")).toEqual(["resolved"]);
    expect(staged.rows.project_bindings![0]?.remote_project).toBe("acme/eng");
    expect(staged.foreignKeyViolations).toEqual([]);

    // Staged is not live: the runtime reader refuses, and the source still owns the records.
    await expect(readCollaborationAuthority(source.context)).rejects.toMatchObject({ code: "collaboration.not-active" });
    const sourceHandle = await openStore(source.context, "read");
    try {
      const counted = sourceHandle.db.prepare("select count(*) as n from issues").get() as { n?: unknown };
      expect(counted.n).toBe(2);
    } finally {
      sourceHandle.close();
    }
  });

  test("pending catalog and mirror work block the manifest and its apply", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-pending.git");
    const source = await seedSource(repo);
    const seed = await openStore(source.context, "write");
    try {
      seed.db.exec(`
insert into sync_runs(binding_id, direction, run_id, holder_pid, holder_host, started_at, reason)
values ('p-one:linear', 'pull', 'run-9', 42, 'host-a', '2026-11-21T00:00:00.000Z', 'pending');
insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, created_at, updated_at)
values ('op-pending', 'op-hash', 'prepared', '{}', '{}', '{}', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
`);
    } finally {
      seed.close();
    }

    const manifest = await planCollaborationCutover(source.context);
    const subjects = manifest.blockers.map((blocker) => blocker.subject);
    expect(manifest.blockers.every((blocker) => blocker.code === "collaboration.cutover-not-quiescent")).toBe(true);
    expect(subjects.some((subject) => subject.includes("mirror run"))).toBe(true);
    expect(subjects.some((subject) => subject.includes("op-pending"))).toBe(true);

    await expect(applyCollaborationCutover(source.context, manifest)).rejects.toMatchObject({
      code: "collaboration.cutover-not-quiescent",
    });
    expect(existsSync(locationAt(repo).dbPath)).toBe(false);
  });

  test("a repeated identical apply reuses the verified receipt and copies once", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-repeat.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);

    const first = await applyCollaborationCutover(source.context, manifest);
    const second = await applyCollaborationCutover(source.context, manifest);
    expect(second).toEqual({ ...first, replayed: true });
    expect(second.verifiedAt).toBe(first.verifiedAt);

    const staged = await stagedRows(locationAt(repo));
    expect(staged.rows.issues).toHaveLength(2);
  });

  test("a source whose rows drifted without a counter advance cannot reuse its manifest", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-drift.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);

    const drifted = await openStore(source.context, "write");
    try {
      // A legacy writer that inserted a row without advancing the shared counter.
      drifted.db.exec(`
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)
values ('I-000003', 'p-one', 'Late finding', 'bug', 'low', 'open', 'late', 'stays fixed', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'identity-three');
`);
    } finally {
      drifted.close();
    }

    await expect(applyCollaborationCutover(source.context, manifest)).rejects.toMatchObject({
      code: "collaboration.cutover-conflict",
    });
    expect(existsSync(locationAt(repo).dbPath)).toBe(false);
  });

  test("a crash after the claim keeps it resumable and the source unfenced", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-claim.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);

    // An unusable recovery-point destination fails the activation after the
    // durable claim and before any fence, exactly like a process loss there.
    const blocker = join(source.context.harnessDir, "archived");
    writeFileSync(blocker, "not a directory");
    try {
      await expect(
        activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source)),
      ).rejects.toMatchObject({ code: "collaboration.backup-incomplete" });
    } finally {
      rmSync(blocker, { force: true });
    }

    // The source is still unfenced with unchanged evidence, the claim is held
    // (no second claim was taken), and the target is still staged.
    expect(await planCollaborationCutover(source.context)).toEqual(manifest);
    expect((await stagedRows(locationAt(repo))).authority.state).toBe("staged");

    const receipt = await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source));
    expect(receipt.phase).toBe("active");
    expect(receipt.replayed).toBe(false);
  });

  test("a fence that committed before publication is resumed by the same activation", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-fence.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);

    const fenced = await fenceCollaborationCutoverSource(source.context, manifest, cutoverOptions(source.context, manifest.source));
    expect(fenced.phase).toBe("source-fenced");
    expect(fenced.fencedAt).toBeDefined();
    expect(fenced.activatedAt).toBeUndefined();

    // The fence is durable evidence, not absence: the source refuses to be
    // planned again, refuses collaboration rows, and keeps its recorded fence.
    await expect(planCollaborationCutover(source.context)).rejects.toMatchObject({
      code: "collaboration.cutover-conflict",
    });
    const sourceHandle = await openStore(source.context, "read");
    try {
      const fence = readCollaborationFence(sourceHandle.db);
      expect(fence).toMatchObject({ manifestId: manifest.manifestId, sourceStoreId: source.storeId, targetEpoch: 1 });
      expect(fence?.backupPath.endsWith(`collaboration-cutover-${manifest.manifestId}.db`)).toBe(true);
      expect(existsSync(fence!.backupPath)).toBe(true);
      expect(() => sourceHandle.db.prepare("select count(*) as n from issues").get()).toThrow();
      const schema = sourceHandle.db.prepare("select max(version) as v from schema_version").get() as { v?: unknown };
      expect(schema.v).toBe(MIGRATIONS.length);
      // A binary built before the fence validates only its own prefix, so it
      // refuses this file instead of reopening the dropped tables.
      expect(() =>
        validateAppliedMigrations(readAppliedMigrations(sourceHandle.db, false), MIGRATIONS.slice(0, -1)),
      ).toThrow(/schema/);
    } finally {
      sourceHandle.close();
    }
    expect((await stagedRows(locationAt(repo))).authority.state).toBe("staged");

    const receipt = await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source));
    expect(receipt.phase).toBe("active");
    expect(receipt.fencedAt).toBe(fenced.fencedAt);
    expect(receipt.activatedAt).toBeDefined();

    const active = await readCollaborationAuthority(source.context);
    expect(active).toMatchObject({ state: "active", storeId: receipt.target.storeId, revision: 7, catalogRevision: 3 });
  });

  test("an exact activation replay returns the recorded receipt", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-replay.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);
    const options = cutoverOptions(source.context, manifest.source);

    const first = await activateCollaborationCutover(source.context, manifest, options);
    const second = await activateCollaborationCutover(source.context, manifest, options);
    expect(second).toEqual({ ...first, replayed: true });
    expect(second.activatedAt).toBe(first.activatedAt);

    const sourceHandle = await openStore(source.context, "read");
    try {
      expect(readCollaborationFence(sourceHandle.db)?.fencedAt).toBe(first.fencedAt);
    } finally {
      sourceHandle.close();
    }
  });

  test("extraction leaves execution rows, tokens and the source epoch unchanged", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-execution.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);

    const before = await openStore(source.context, "read");
    const authorityBefore = readStoreAuthority(before.db);
    const executionBefore = before.execution;
    const bindingsBefore = before.db.prepare("select * from catalog_execution_bindings").all();
    const metaBefore = before.db.prepare("select * from store_meta").all();
    before.close();

    await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source));

    const after = await openStore(source.context, "read");
    try {
      expect(readStoreAuthority(after.db)).toEqual(authorityBefore);
      expect(after.execution).toEqual(executionBefore);
      expect(after.db.prepare("select * from catalog_execution_bindings").all()).toEqual(bindingsBefore);
      expect(after.db.prepare("select * from store_meta").all()).toEqual(metaBefore);
    } finally {
      after.close();
    }
  });

  test("a competing clone refuses before either source is fenced", async () => {
    const repoA = makeRepo("https://github.com/acme/cutover-competing.git");
    const repoB = makeRepo("https://github.com/acme/cutover-competing.git");
    const sourceA = await seedSource(repoA);
    const sourceB = await seedSource(repoB);
    expect(sourceA.storeId).not.toBe(sourceB.storeId);

    const manifestA = await planCollaborationCutover(sourceA.context);
    const manifestB = await planCollaborationCutover(sourceB.context);
    expect(manifestA.source.storeId).not.toBe(manifestB.source.storeId);

    await applyCollaborationCutover(sourceA.context, manifestA);
    await expect(applyCollaborationCutover(sourceB.context, manifestB)).rejects.toMatchObject({
      code: "collaboration.cutover-conflict",
    });
    // Neither source was fenced: both still plan their own unchanged evidence.
    expect(await planCollaborationCutover(sourceA.context)).toEqual(manifestA);
    expect(await planCollaborationCutover(sourceB.context)).toEqual(manifestB);

    const receipt = await activateCollaborationCutover(sourceA.context, manifestA, cutoverOptions(sourceA.context, manifestA.source));
    expect(receipt.phase).toBe("active");
  });

  test("a foreign target cannot win by force", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-forced.git");
    const foreign = makeRepo("https://github.com/other/cutover-forced.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);

    // Replace the canonical target with another repository's store: the
    // trustworthy selection no longer matches, and nothing may be fenced.
    await initializeStore(contextAt(foreign));
    const foreignManifest = await planCollaborationCutover(contextAt(foreign));
    await applyCollaborationCutover(contextAt(foreign), foreignManifest);
    rmSync(locationAt(repo).dbPath, { force: true });
    writeFileSync(locationAt(repo).dbPath, Buffer.alloc(0));
    rmSync(locationAt(repo).dbPath, { force: true });
    execFileSync("cp", [locationAt(foreign).dbPath, locationAt(repo).dbPath]);

    await expect(
      activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source)),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(await planCollaborationCutover(source.context)).toEqual(manifest);
  });

  test("a stale binding refuses a clone whose configured mode disagrees", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-binding.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);
    await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source));

    const mirror = makeRepo("https://github.com/acme/cutover-binding.git", "mirror");
    await expect(readCollaborationAuthority(contextAt(mirror))).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
    await expect(applyCollaborationCutover(contextAt(mirror), manifest)).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
  });

  test("a replacement clone with no execution DB reads the same authority", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-clone.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);
    const activated = await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source));

    const clone = makeRepo("https://github.com/acme/cutover-clone.git");
    const cloneContext = contextAt(clone);
    expect(existsSync(join(cloneContext.harnessDir, "store.db"))).toBe(false);

    const read = await readCollaborationAuthority(cloneContext);
    expect(read).toMatchObject({
      state: "active",
      storeId: activated.target.storeId,
      epoch: activated.target.epoch,
      revision: 7,
      catalogRevision: 3,
    });
    await expect(openStore(cloneContext, "read")).rejects.toMatchObject({ code: "store.not-initialized" });
  });

  test("a drifted activation claim is released so the source can be re-planned", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-claim-drift.git");
    const source = await seedSource(repo);
    const location = locationAt(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);

    // Claim, then fail before any fence (the recovery-point destination is
    // unusable), exactly like a process loss at that durable boundary.
    const blocker = join(source.context.harnessDir, "archived");
    writeFileSync(blocker, "not a directory");
    try {
      await expect(activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).rejects.toMatchObject({
        code: "collaboration.backup-incomplete",
      });
    } finally {
      rmSync(blocker, { force: true });
    }

    // A legacy write drifts the source without advancing the shared counter.
    const drifted = await openStore(source.context, "write");
    try {
      drifted.db.exec(`
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)
values ('I-000003', 'p-one', 'Late finding', 'bug', 'low', 'open', 'late', 'stays fixed', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'identity-three');
`);
    } finally {
      drifted.close();
    }

    // The exact retry releases its own claim (committed) and refuses; the
    // source stays unfenced and the staged target is untouched.
    await expect(activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).rejects.toMatchObject({
      code: "collaboration.cutover-conflict",
    });
    expect((await cutoverState(location)).claims).toEqual([]);
    expect((await stagedRows(location)).authority.state).toBe("staged");
    expect(await planCollaborationCutover(source.context)).not.toEqual(manifest);

    // Released claim -> the drifted source is reviewable and stageable again.
    const replanned = await planCollaborationCutover(source.context);
    await expect(applyCollaborationCutover(source.context, manifest)).rejects.toMatchObject({
      code: "collaboration.cutover-conflict",
    });
    expect((await applyCollaborationCutover(source.context, replanned)).phase).toBe("verified");
    expect((await activateCollaborationCutover(source.context, replanned, cutoverOptions(source.context, replanned.source))).phase).toBe("active");

    const state = await cutoverState(location);
    expect(state.publications).toEqual([{ manifest_id: replanned.manifestId, phase: "active" }]);
    expect(state.claims).toEqual([]);
  });

  test("the cutover attestation must name this exact root, source and stopped handles", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-attestation.git");
    const source = await seedSource(repo);
    const location = locationAt(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);

    const refusals = [
      cutoverOptions(source.context, manifest.source, { omitCutover: true }),
      cutoverOptions(source.context, manifest.source, { stopped: [], handles: [] }),
      cutoverOptions(source.context, manifest.source, { controlRoot: join(source.context.harnessDir, "elsewhere") }),
      cutoverOptions(source.context, manifest.source, { sourceStoreId: "another-store" }),
      cutoverOptions(source.context, manifest.source, { sourceEpoch: 9 }),
      cutoverOptions(source.context, manifest.source, { repoKey: "github.com/acme/other" }),
      cutoverOptions(source.context, manifest.source, { mode: "mirror" }),
      cutoverOptions(source.context, manifest.source, { build: "0.0.0-foreign" }),
      cutoverOptions(source.context, manifest.source, {
        stopped: ["session-elsewhere"],
        handles: [{ kind: "process", id: "mstar-cli" }],
      }),
      cutoverOptions(source.context, manifest.source, {
        stopped: [],
        handles: [{ kind: "session", id: "session-elsewhere" }],
      }),
      cutoverOptions(source.context, manifest.source, { stopped: [], handles: [{ kind: "process", id: "mstar-cli" }] }),
      cutoverOptions(source.context, manifest.source, { allHandlesStopped: "missing" }),
      cutoverOptions(source.context, manifest.source, { allHandlesStopped: false }),
    ];
    for (const options of refusals) {
      await expect(activateCollaborationCutover(source.context, manifest, options)).rejects.toMatchObject({
        code: "store.attestation-invalid",
      });
    }

    // Nothing was fenced, claimed or published.
    expect(await planCollaborationCutover(source.context)).toEqual(manifest);
    expect((await stagedRows(location)).authority.state).toBe("staged");
    expect((await cutoverState(location)).claims).toEqual([]);

    // A source that records NO sessions is still bound by the operator's own
    // stopped-handle assertion: an empty session table alone is not proof.
    const quiet = makeRepo("https://github.com/acme/cutover-attestation-quiet.git");
    const quietSource = await seedSource(quiet);
    const quietDb = await openStore(quietSource.context, "write");
    try {
      quietDb.db.exec("delete from execution_sessions");
    } finally {
      quietDb.close();
    }
    const quietManifest = await planCollaborationCutover(quietSource.context);
    await applyCollaborationCutover(quietSource.context, quietManifest);
    await expect(
      activateCollaborationCutover(
        quietSource.context,
        quietManifest,
        cutoverOptions(quietSource.context, quietManifest.source, { stopped: [], handles: [] }),
      ),
    ).rejects.toMatchObject({ code: "store.attestation-invalid" });
    const quietReceipt = await activateCollaborationCutover(
      quietSource.context,
      quietManifest,
      cutoverOptions(quietSource.context, quietManifest.source, {
        stopped: [],
        handles: [{ kind: "process", id: "mstar-cli" }],
      }),
    );
    expect(quietReceipt.phase).toBe("active");

    // The source-scoped attestation still activates the first source.
    expect(
      (await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).phase,
    ).toBe("active");
  });

  test("a recovery point that does not preserve the reviewed rows blocks the fence", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-backup-rows.git");
    const source = await seedSource(repo);
    const location = locationAt(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);
    const backupPath = join(
      source.context.harnessDir,
      "archived",
      "store-migration",
      "backups",
      `collaboration-cutover-${manifest.manifestId}.db`,
    );

    // The reviewer's shape: an unannounced legacy write lands, the recovery
    // point is taken of THAT state, and the write is removed again so the
    // counters and rows match the reviewed manifest once more.
    const drifted = await openStore(source.context, "write");
    try {
      drifted.db.exec(`
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)
values ('I-000009', 'p-one', 'Unannounced finding', 'bug', 'low', 'open', 'late', 'stays fixed', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'identity-nine');
`);
    } finally {
      drifted.close();
    }
    mkdirSync(dirname(backupPath), { recursive: true });
    await backupStore(source.context, { out: backupPath });
    const restored = await openStore(source.context, "write");
    try {
      restored.db.exec("delete from issues where id = 'I-000009'");
    } finally {
      restored.close();
    }

    await expect(activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).rejects.toMatchObject({
      code: "collaboration.backup-incomplete",
    });
    // The source is still unfenced and the target still staged.
    expect(await planCollaborationCutover(source.context)).toEqual(manifest);
    expect((await stagedRows(location)).authority.state).toBe("staged");
  });

  test("an active target beside an unfenced source refuses to replay", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-two-authorities.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);
    await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source));

    const fenced = await openStore(source.context, "read");
    const fence = readCollaborationFence(fenced.db);
    fenced.close();
    expect(fence).not.toBeNull();

    // Restore the retained pre-fence image over the live combined store: the
    // reviewed generation and rows return, but the fence and the schema advance
    // are gone. The target is active, so replaying would claim one authority
    // while the source can admit writes again.
    const sourcePath = join(source.context.harnessDir, "store.db");
    rmSync(`${sourcePath}-wal`, { force: true });
    rmSync(`${sourcePath}-shm`, { force: true });
    copyFileSync(fence!.backupPath, sourcePath);

    const restored = await openStore(source.context, "read");
    expect(readCollaborationFence(restored.db)).toBeNull();
    restored.close();
    await expect(activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).rejects.toMatchObject({
      code: "collaboration.cutover-conflict",
    });
    // The stage route must not report the active cutover either: apply never
    // replays beside an unfenced source.
    await expect(applyCollaborationCutover(source.context, manifest)).rejects.toMatchObject({
      code: "collaboration.cutover-conflict",
    });
  });

  test("a replaced target is not published under another target's fence", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-foreign-target.git");
    const source = await seedSource(repo);
    const location = locationAt(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);
    expect((await fenceCollaborationCutoverSource(source.context, manifest, cutoverOptions(source.context, manifest.source))).phase).toBe(
      "source-fenced",
    );

    // Out of band the staged target is replaced by an internally consistent
    // store that is NOT the target named by the persisted source fence.
    const target = new DatabaseSync(location.dbPath);
    try {
      target.exec("update collaboration_meta set store_id = 'foreign-store-id'");
      target.exec("update cutover_publications set target_store_id = 'foreign-store-id'");
    } finally {
      target.close();
    }

    await expect(activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).rejects.toMatchObject({
      code: "collaboration.cutover-conflict",
    });
    const state = await cutoverState(location);
    expect(state.authority.state).toBe("staged");
    expect(state.publications).toEqual([{ manifest_id: manifest.manifestId, phase: "source-fenced" }]);
  });

  test("a stage cannot run while a source writer holds the fence slot", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-stage-barrier.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);

    // A source write transaction is exactly what a fence holds. A competing stage
    // must not slip past it: staging takes the same source writer slot, so the
    // evidence it read can never be older than the fence that follows.
    const holder = new DatabaseSync(join(source.context.harnessDir, "store.db"));
    try {
      holder.exec("begin immediate");
      await expect(applyCollaborationCutover(source.context, manifest)).rejects.toMatchObject({ code: "store.busy" });
    } finally {
      holder.exec("rollback");
      holder.close();
    }
    expect((await applyCollaborationCutover(source.context, manifest)).phase).toBe("verified");
  }, 20000);

  test("a competing restage cannot remove the publication a fence needs", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-restage-fence.git");
    const source = await seedSource(repo);
    const location = locationAt(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);

    // Claim, fail before the fence, then drift: the stale activation must release
    // its claim while a competing restage and activation race it.
    const blocker = join(source.context.harnessDir, "archived");
    writeFileSync(blocker, "not a directory");
    try {
      await expect(
        activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source)),
      ).rejects.toMatchObject({ code: "collaboration.backup-incomplete" });
    } finally {
      rmSync(blocker, { force: true });
    }
    const drifted = await openStore(source.context, "write");
    try {
      drifted.db.exec(`
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)
values ('I-000004', 'p-one', 'Racing finding', 'bug', 'low', 'open', 'race', 'stays fixed', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'identity-four');
`);
    } finally {
      drifted.close();
    }
    const replanned = await planCollaborationCutover(source.context);

    await Promise.allSettled([
      activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source)),
      applyCollaborationCutover(source.context, replanned),
      activateCollaborationCutover(source.context, replanned, cutoverOptions(source.context, replanned.source)),
    ]);

    // Invariant: a fence always keeps its own publication, and an active target
    // always has a fence. A restage never removed the row a fence depends on.
    const fencedSource = await openStore(source.context, "read");
    const fence = readCollaborationFence(fencedSource.db);
    fencedSource.close();
    const state = await cutoverState(location);
    if (fence !== null) {
      expect(state.publications.some((row) => row.manifest_id === fence.manifestId)).toBe(true);
    }
    if (state.authority.state === "active") {
      expect(fence).not.toBeNull();
      const published = state.publications.find((row) => row.phase === "active");
      expect(published?.manifest_id).toBe(fence?.manifestId);
    }
  }, 30000);

  test("legacy receipts move with the domain and replay exactly", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-receipts.git");
    const source = await seedSource(repo);
    const location = locationAt(repo);
    const manifest = await planCollaborationCutover(source.context);
    // Payload classification, not id shape: a normal roadmap write, an issue
    // operation that happens to be called `restore-attempt:...`, and the
    // collaboration receipts all move; the execution lane's own records
    // (recovery and current/historical imports) stay with the execution store.
    expect(manifest.counts.store_operations).toBe(3);

    const sourceReceipt = async (operationId: string): Promise<Record<string, unknown> | undefined> => {
      const handle = await openStore(source.context, "read");
      try {
        return handle.db
          .prepare("select request_hash, result_json, committed_at from store_operations where operation_id = ?")
          .get(operationId) as Record<string, unknown> | undefined;
      } finally {
        handle.close();
      }
    };
    const roadmapSource = await sourceReceipt("roadmap-op");
    expect(roadmapSource).toBeDefined();
    expect(JSON.parse(String(roadmapSource?.result_json))).toMatchObject({
      projectId: "p-one",
      outcome: "committed",
      provenance: null,
    });

    await applyCollaborationCutover(source.context, manifest);
    const expectedIds = ["issue-op-legacy", "restore-attempt:customer-request", "roadmap-op"];
    const state = await cutoverState(location);
    expect(state.receipts.map((row) => row.operation_id).sort()).toEqual(expectedIds);

    // The roadmap receipt's exact bytes survive, including the producer's
    // outcome/provenance, and its request hash is the producer's own replay key.
    const roadmap = state.receipts.find((row) => row.operation_id === "roadmap-op")!;
    expect(roadmap.request_hash).toBe(roadmapSource?.request_hash);
    expect(roadmap.result_json).toBe(roadmapSource?.result_json);
    expect(roadmap.committed_at).toBe(roadmapSource?.committed_at);
    const replayKey = createHash("sha256")
      .update(
        JSON.stringify({
          domain: "roadmap-content-authority",
          projectId: "p-one",
          declaredProjectRevision: 1,
          declaredRoadmapRevision: "absent",
          contentHash: createHash("sha256").update(ROADMAP_CONTENT).digest("hex"),
          provenance: null,
        }),
      )
      .digest("hex");
    expect(roadmap.request_hash).toBe(replayKey);
    // A different request for the same id computes another hash, which is the
    // conflict the preserved row must still be able to report.
    const differentKey = createHash("sha256")
      .update(
        JSON.stringify({
          domain: "roadmap-content-authority",
          projectId: "p-one",
          declaredProjectRevision: 1,
          declaredRoadmapRevision: "absent",
          contentHash: createHash("sha256").update(`${ROADMAP_CONTENT}x`).digest("hex"),
          provenance: null,
        }),
      )
      .digest("hex");
    expect(differentKey === roadmap.request_hash).toBe(false);

    // Execution-lane records are not promoted, including the supported
    // historical import receipt that predates `inputDigest`.
    for (const operationId of ["restore-attempt:abc", "upgrade-op", "upgrade-op-old"]) {
      expect(state.receipts.some((row) => row.operation_id === operationId)).toBe(false);
    }

    // An exact re-stage keeps the population, and activation preserves it.
    expect((await applyCollaborationCutover(source.context, manifest)).replayed).toBe(true);
    expect((await cutoverState(location)).receipts.map((row) => row.operation_id).sort()).toEqual(expectedIds);
    await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source));
    expect((await cutoverState(location)).receipts.map((row) => row.operation_id).sort()).toEqual(expectedIds);
  });

  test("two concurrent activations leave exactly one fence and one active authority", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-concurrent-activation.git");
    const source = await seedSource(repo);
    const location = locationAt(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);

    const results = await Promise.allSettled([
      activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source)),
      activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(["collaboration.cutover-conflict", "collaboration.cutover-not-quiescent", "store.busy"]).toContain(
          result.reason?.code,
        );
      }
    }

    expect((await readCollaborationAuthority(source.context)).state).toBe("active");
    const state = await cutoverState(location);
    expect(state.publications).toEqual([{ manifest_id: manifest.manifestId, phase: "active" }]);
    expect(state.claims).toEqual([]);
    const fenced = await openStore(source.context, "read");
    try {
      expect(readCollaborationFence(fenced.db)?.manifestId).toBe(manifest.manifestId);
    } finally {
      fenced.close();
    }
  }, 20000);

  test("concurrent identical applies copy the rows once", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-concurrent-apply.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);

    const results = await Promise.allSettled([
      applyCollaborationCutover(source.context, manifest),
      applyCollaborationCutover(source.context, manifest),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      // A loser refuses either on the local cutover lock or on the source writer slot.
      if (result.status === "rejected") {
        expect(["collaboration.cutover-conflict", "store.busy"]).toContain(result.reason?.code);
      }
    }
    const staged = await stagedRows(locationAt(repo));
    expect(staged.rows.issues).toHaveLength(2);
    expect(staged.authority.state).toBe("staged");
  }, 20000);

  test("the cutover holds one local lock for its whole critical section", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-lock.git");
    const source = await seedSource(repo);
    const lockPath = lockPathOf(source.context);
    const manifest = await planCollaborationCutover(source.context);
    expect(existsSync(lockPath)).toBe(false);
    await applyCollaborationCutover(source.context, manifest);
    expect(existsSync(lockPath)).toBe(false);

    // A live lock (this host, a running process) refuses every entry before it
    // inspects, claims, fences or publishes anything.
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: "2026-11-21T00:00:00.000Z", token: "held" })}\n`,
    );
    try {
      for (const entry of [
        () => planCollaborationCutover(source.context),
        () => applyCollaborationCutover(source.context, manifest),
        () => activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source)),
      ]) {
        const refusal = await refusalOf(entry);
        expect(refusal.code).toBe("collaboration.cutover-conflict");
        expect(refusal.message).toContain("Another collaboration cutover is running on this host");
      }
    } finally {
      rmSync(lockPath, { force: true });
    }

    // Released: the same manifest activates and its fence replays, with no lock
    // file left behind.
    expect((await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).phase).toBe("active");
    expect(existsSync(lockPath)).toBe(false);
    expect((await applyCollaborationCutover(source.context, manifest)).phase).toBe("active");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a stale lock from a dead local process is recovered", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-lock-stale.git");
    const source = await seedSource(repo);
    const lockPath = lockPathOf(source.context);
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid;
    await new Promise<void>((settle) => child.on("exit", () => settle()));
    expect(typeof deadPid).toBe("number");

    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: deadPid, host: hostname(), startedAt: "2026-11-21T00:00:00.000Z", token: "dead" })}\n`,
    );
    const manifest = await planCollaborationCutover(source.context);
    expect(manifest.counts.issues).toBe(2);
    // The recovered stale lock is retired, and this attempt's own lock is released.
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a stale recovery is serialized by its recovery slot", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-lock-recovery-slot.git");
    const source = await seedSource(repo);
    const lockPath = lockPathOf(source.context);
    const recoveryPath = `${lockPath}.recover`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 999999, host: hostname(), startedAt: "2026-11-21T00:00:00.000Z", token: "dead" })}\n`,
    );

    // A live recovery slot blocks every other recoverer: the recovery step is a
    // real critical section, so two processes can never both act on the stale
    // lock (and therefore can never both acquire).
    writeFileSync(
      recoveryPath,
      `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: "2026-11-21T00:00:00.000Z", token: "recovering" })}\n`,
    );
    try {
      const busy = await refusalOf(() => planCollaborationCutover(source.context));
      expect(busy.code).toBe("collaboration.cutover-conflict");
      expect(busy.message).toContain("recovering the stale collaboration cutover lock");
      // The stale file was not touched by the refused recoverer.
      expect(readFileSync(lockPath, "utf8")).toContain('"token":"dead"');
    } finally {
      rmSync(recoveryPath, { force: true });
    }

    // With the slot free the same stale lock is recovered and released.
    expect((await planCollaborationCutover(source.context)).counts.issues).toBe(2);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(recoveryPath)).toBe(false);
  });

  test("competing stale-lock recoveries never admit two owners", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-lock-race.git");
    const source = await seedSource(repo);
    const lockPath = lockPathOf(source.context);
    const script = join(ROOT, `child-hold-${sequence++}.ts`);
    writeFileSync(
      script,
      [
        `import { withCollaborationCutoverLock } from ${JSON.stringify(join(import.meta.dir, "collaboration-cutover.ts"))};`,
        "const [harnessDir, checkoutRoot, holdMs] = process.argv.slice(2);",
        "const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));",
        "try {",
        "  await withCollaborationCutoverLock({ harnessDir, checkoutRoot }, async () => {",
        '    console.log("enter " + Date.now());',
        "    await sleep(Number(holdMs));",
        '    console.log("exit " + Date.now());',
        "  });",
        "} catch (error) {",
        '  console.log("code:" + String((error as { code?: string }).code));',
        "}",
        "",
      ].join("\n"),
    );

    // One real dead owner's lock; every child must recover it atomically.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid!;
    await new Promise<void>((settle) => dead.on("exit", () => settle()));
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: deadPid, host: hostname(), startedAt: "2026-11-21T00:00:00.000Z", token: "dead" })}\n`,
    );

    const env = { ...process.env, HOME: resolvedHome };
    const children = [0, 1, 2].map(() =>
      spawn(process.execPath, [script, source.context.harnessDir, source.context.checkoutRoot!, "700"], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    const outputs = await Promise.all(
      children.map(async (child) => {
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        await new Promise<void>((settle) => child.on("exit", () => settle()));
        return output;
      }),
    );

    const intervals = outputs.flatMap((output): Array<readonly [number, number]> => {
      const enter = /enter (\d+)/.exec(output);
      const exit = /exit (\d+)/.exec(output);
      return enter !== null && exit !== null ? [[Number(enter[1]), Number(exit[1])] as const] : [];
    });
    expect(intervals.length).toBeGreaterThanOrEqual(1);
    for (let first = 0; first < intervals.length; first++) {
      for (let second = first + 1; second < intervals.length; second++) {
        const a = intervals[first]!;
        const b = intervals[second]!;
        // Two owners would mean overlapping critical sections.
        expect(a[1] < b[0] || b[1] < a[0]).toBe(true);
      }
    }
    for (const output of outputs) {
      if (!output.includes("enter ")) expect(output).toContain("code:collaboration.cutover-conflict");
    }
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.recover`)).toBe(false);
  }, 30000);

  test("a foreign-host or unreadable lock refuses with its recovery", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-lock-foreign.git");
    const source = await seedSource(repo);
    const lockPath = lockPathOf(source.context);

    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 1, host: "another-host", startedAt: "2026-11-21T00:00:00.000Z", token: "foreign" })}\n`,
    );
    const foreign = await refusalOf(() => planCollaborationCutover(source.context));
    expect(foreign.code).toBe("collaboration.cutover-conflict");
    expect(foreign.message).toContain("another-host");
    expect(foreign.message).toContain("remove the lock file only then");

    writeFileSync(lockPath, "not a lock document\n");
    const malformed = await refusalOf(() => planCollaborationCutover(source.context));
    expect(malformed.code).toBe("collaboration.cutover-conflict");
    expect(malformed.message).toContain("unreadable or malformed");
    expect(malformed.message).toContain("remove that file");

    rmSync(lockPath, { force: true });
    expect((await planCollaborationCutover(source.context)).counts.issues).toBe(2);
  });

  test("a cutover lock held by another process refuses this process", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-lock-cross.git");
    const source = await seedSource(repo);
    const lockPath = lockPathOf(source.context);
    const script = join(ROOT, `child-plan-${sequence++}.ts`);
    writeFileSync(
      script,
      [
        `import { planCollaborationCutover } from ${JSON.stringify(join(import.meta.dir, "collaboration-cutover.ts"))};`,
        "const [harnessDir, checkoutRoot] = process.argv.slice(2);",
        "try {",
        "  const manifest = await planCollaborationCutover({ harnessDir, checkoutRoot });",
        '  console.log("ok:" + manifest.manifestId);',
        "} catch (error) {",
        '  console.log("code:" + String((error as { code?: string }).code));',
        "}",
        "",
      ].join("\n"),
    );
    const child = (): { stdout: string } =>
      spawnSync(process.execPath, [script, source.context.harnessDir, source.context.checkoutRoot!], {
        env: { ...process.env, HOME: resolvedHome },
        encoding: "utf8",
      }) as { stdout: string };

    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: "2026-11-21T00:00:00.000Z", token: "parent" })}\n`,
    );
    try {
      expect(child().stdout).toContain("code:collaboration.cutover-conflict");
    } finally {
      rmSync(lockPath, { force: true });
    }
    expect(child().stdout).toContain("ok:");
  }, 20000);

  test("an unproven legacy receipt refuses the cutover instead of being guessed", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-receipts-unproven.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);

    const injected = await openStore(source.context, "write");
    try {
      injected.db.exec(`
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('mystery-op', 'mystery-hash', '{"note":"hand written"}', '2026-11-21T00:00:04.000Z');
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('malformed-op', 'malformed-hash', 'not-json', '2026-11-21T00:00:05.000Z');
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('incomplete-op', 'incomplete-hash', '{"verdict":"upgraded","importedIds":[]}', '2026-11-21T00:00:06.000Z');
`);
    } finally {
      injected.close();
    }

    const refused = await refusalOf(() => planCollaborationCutover(source.context));
    expect(refused.code).toBe("collaboration.cutover-conflict");
    expect(refused.message).toContain("cannot be proven collaboration- or execution-owned");
    expect(existsSync(locationAt(repo).dbPath)).toBe(false);
    await expect(applyCollaborationCutover(source.context, manifest)).rejects.toMatchObject({
      code: "collaboration.cutover-conflict",
    });

    // The supported recovery: resolve or remove the unproven receipts, then
    // re-plan. The reviewed collaboration receipts are still all that moves.
    const cleaned = await openStore(source.context, "write");
    try {
      cleaned.db.exec("delete from store_operations where operation_id in ('mystery-op','malformed-op','incomplete-op')");
    } finally {
      cleaned.close();
    }
    const replanned = await planCollaborationCutover(source.context);
    expect(replanned.counts.store_operations).toBe(3);
    expect(replanned.manifestId).toBe(manifest.manifestId);
  });

  test("the fence advances a schema-19 source and preserves pins, history and execution rows", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-schema19.git");
    const source = seedSchema19Source(repo);
    const location = locationAt(repo);
    const manifest = await planCollaborationCutover(source.context);
    expect(manifest.source).toMatchObject({ storeId: source.storeId, epoch: 1, schemaVersion: 19, revision: 7, catalogRevision: 3 });

    const pinQuery = `select ${source.pinColumns.join(", ")} from catalog_execution_bindings order by workflow_id`;
    const before = await openStore(source.context, "read");
    const pinsBefore = before.db.prepare(pinQuery).all();
    const pinsForeignKeysBefore = before.db.prepare("pragma foreign_key_list(catalog_execution_bindings)").all();
    const authorityBefore = readStoreAuthority(before.db);
    const executionBefore = before.execution;
    const historyBefore = before.db
      .prepare("select id, disposition, revision from issues order by id")
      .all() as Array<{ id: string; disposition: string; revision: number }>;
    before.close();
    expect(pinsBefore).toHaveLength(1);
    expect(pinsForeignKeysBefore).toHaveLength(2);

    expect((await applyCollaborationCutover(source.context, manifest)).phase).toBe("verified");
    const receipt = await activateCollaborationCutover(
      source.context,
      manifest,
      cutoverOptions(source.context, manifest.source),
    );
    expect(receipt.phase).toBe("active");
    expect(receipt.source.schemaVersion).toBe(19);

    // The source advanced through migration 20 inside the fence transaction.
    const after = await openStore(source.context, "read");
    try {
      const schema = after.db.prepare("select max(version) as v from schema_version").get() as { v?: unknown };
      expect(schema.v).toBe(MIGRATIONS.length);
      expect(readCollaborationFence(after.db)).toMatchObject({
        manifestId: manifest.manifestId,
        sourceSchemaVersion: 19,
        sourceRevision: 7,
        sourceCatalogRevision: 3,
      });
      // The pin is untouched; only its cross-domain foreign key is gone.
      expect(after.db.prepare(pinQuery).all()).toEqual(pinsBefore);
      expect(after.db.prepare("pragma foreign_key_list(catalog_execution_bindings)").all()).toEqual([]);
      expect(after.db.prepare("pragma foreign_key_check").all()).toEqual([]);
      // Execution rows, tokens and epoch are not rewritten by extraction.
      expect(readStoreAuthority(after.db)).toEqual(authorityBefore);
      expect(after.execution).toEqual(executionBefore);
      // The moved collaboration tables are gone from the source.
      expect(() => after.db.prepare("select count(*) as n from issues").get()).toThrow();
    } finally {
      after.close();
    }

    // The target holds exactly the reviewed history and the preserved receipts.
    const staged = await stagedRows(location);
    expect(staged.authority).toMatchObject({ state: "active", revision: 7, catalogRevision: 3 });
    expect(staged.rows.issues!.map((row) => ({ id: row.id, disposition: row.disposition, revision: row.revision }))).toEqual(
      historyBefore,
    );
    expect(staged.rows.issue_transitions).toHaveLength(1);
    expect(staged.rows.project_bindings![0]?.remote_project).toBe("acme/eng");
    expect((await cutoverState(location)).receipts.map((row) => row.operation_id)).toEqual(["issue-op-legacy"]);
  });

  test("a failed fence rolls the schema-19 source back and publishes nothing", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-schema19-rollback.git");
    const source = seedSchema19Source(repo);
    const location = locationAt(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);

    const pinQuery = `select ${source.pinColumns.join(", ")} from catalog_execution_bindings order by workflow_id`;
    const before = await openStore(source.context, "read");
    const pinsBefore = before.db.prepare(pinQuery).all();
    const issuesBefore = before.db.prepare("select id, disposition from issues order by id").all() as Array<{
      id: string;
      disposition: string;
    }>;
    before.close();

    // A child table the fence does not move keeps a foreign key into `issues`,
    // so the final `drop table issues` inside the fence transaction violates it
    // AFTER the schema advance, the fence row and the earlier drops.
    const blocker = new DatabaseSync(join(source.context.harnessDir, "store.db"));
    try {
      blocker.exec(
        "create table issue_notes(id integer primary key, issue_id text not null references issues(id));" +
          "insert into issue_notes(issue_id) values ('I-000001')",
      );
    } finally {
      blocker.close();
    }

    await expect(
      activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source)),
    ).rejects.toMatchObject({ code: "store.corrupt" });

    // The source is readable, still at schema 19, with every row and the pin's
    // foreign key intact and no fence evidence.
    const restored = await openStore(source.context, "read");
    try {
      const schema = restored.db.prepare("select max(version) as v from schema_version").get() as { v?: unknown };
      expect(schema.v).toBe(19);
      expect(readCollaborationFence(restored.db)).toBeNull();
      expect(restored.db.prepare(pinQuery).all()).toEqual(pinsBefore);
      expect(restored.db.prepare("pragma foreign_key_list(catalog_execution_bindings)").all()).toHaveLength(2);
      expect(restored.db.prepare("select id, disposition from issues order by id").all()).toEqual(issuesBefore);
    } finally {
      restored.close();
    }
    // No partial target publication: the target is still the verified stage.
    const staged = await cutoverState(location);
    expect(staged.authority.state).toBe("staged");
    expect(staged.publications).toEqual([{ manifest_id: manifest.manifestId, phase: "verified" }]);

    // Removing the blocking fact lets the same activation resume and fence.
    const unblocked = new DatabaseSync(join(source.context.harnessDir, "store.db"));
    try {
      unblocked.exec("drop table issue_notes");
    } finally {
      unblocked.close();
    }
    expect(
      (await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).phase,
    ).toBe("active");
  });
});
