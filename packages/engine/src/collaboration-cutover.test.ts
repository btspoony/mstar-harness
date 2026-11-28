/**
 * why: collaboration cutover -- reviewed manifest, verified staged copy, activation
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

import { historicalStore } from "./store-migration-fixtures.js";
import {
  MIGRATIONS,
  initializeStore,
  openStore,
  readAppliedMigrations,
  readCollaborationFence,
  readStoreAuthority,
  upgradeStore,
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

function makeRepo(origin: string, mode = "local"): string {
  const dir = join(ROOT, `repo-${sequence++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Cutover Test");
  git(dir, "config", "user.email", "cutover@example.test");
  git(dir, "config", "remote.origin.url", origin);
  git(dir, "config", `url.${dir}.insteadOf`, origin);
  writeFileSync(
    join(dir, ".mstarc"),
    `[collaboration]\nmode=${mode}\nrepo_id=fixture-${dir.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(-110)}\n`,
  );
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

const ROADMAP_CONTENT =
  "---\nproject_id: p-one\ntitle: Synthetic roadmap\nstatus: active\ncreated_at: 2026-09-25\n---\n\n" +
  "## Direction\n\nCutover fixture.\n\n## Goals\n\n- [ ] Parent goal\n";

function seedSchemaPreFloorSource(repo: string): { context: StoreContext; storeId: string; pinColumns: string[] } {
  const context = contextAt(repo);
  const db = historicalStore(context.harnessDir, MIGRATIONS.length - 1);
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
values ('restore-attempt:abc', 'restore-hash', '{"recoveryVersion":1,"phase":"replaced","storeId":"restored-store","verified":{"integrity":"ok","foreignKeys":"ok","schemaVersion":19}}', '2026-11-21T00:00:02.000Z');
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('upgrade-op', 'upgrade-hash', '{"verdict":"upgraded","imported":1,"importedIds":["wf-imported"],"skipped":[],"dispositions":[],"sourceDigest":"source-digest","inputDigest":"input-digest"}', '2026-11-21T00:00:03.000Z');
insert into store_operations(operation_id, request_hash, result_json, committed_at)
values ('upgrade-op-old', 'upgrade-old-hash', '{"verdict":"upgraded","imported":1,"importedIds":["wf-historical"],"skipped":[],"dispositions":[],"sourceDigest":"historical-digest"}', '2026-11-21T00:00:07.000Z');
update issue_counter set next_value = 3 where id = 1;
`);
    const roadmapResult = {
      projectId: "p-one",
      revision: 1,
      contentHash: createHash("sha256").update(ROADMAP_CONTENT).digest("hex"),
      storeRevision: 7,
      outcome: "committed",
      provenance: null,
    };
    const roadmapReplayKey = createHash("sha256")
      .update(
        JSON.stringify({
          domain: "roadmap-content-authority",
          projectId: "p-one",
          declaredProjectRevision: 1,
          declaredRoadmapRevision: "absent",
          contentHash: roadmapResult.contentHash,
          provenance: null,
        }),
      )
      .digest("hex");
    db.prepare(
      "insert into store_operations(operation_id, request_hash, result_json, committed_at) values (?, ?, ?, ?)",
    ).run("roadmap-op", roadmapReplayKey, JSON.stringify(roadmapResult), "2026-11-21T00:00:04.000Z");
    storeId = handle.storeId;
  } finally {
    handle.close();
  }
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
    ]) {
      rows[table] = db.prepare(`select * from ${table}`).all() as Array<Record<string, unknown>>;
    }
    return { authority, rows, foreignKeyViolations: db.prepare("pragma foreign_key_check").all() };
  });
}

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
  test("a combined source below the cutover source floor is refused with the store-upgrade recovery", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-below-floor.git");
    const context = contextAt(repo);
    const db = historicalStore(context.harnessDir, MIGRATIONS.length - 1);
    db.close();
    const refusal = await refusalOf(() => planCollaborationCutover(context));
    expect(refusal.code).toBe("collaboration.cutover-required");
    expect(refusal.message).toContain("store upgrade");
  });

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

    await expect(readCollaborationAuthority(source.context)).rejects.toMatchObject({ code: "collaboration.not-active" });
    const sourceHandle = await openStore(source.context, "read");
    try {
      const counted = sourceHandle.db.prepare("select count(*) as n from issues").get() as { n?: unknown };
      expect(counted.n).toBe(2);
    } finally {
      sourceHandle.close();
    }
  });

  test("a source roadmap document is copied as other, and the fence drops the roadmap table", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-roadmap-source.git");
    const source = await seedSource(repo);
    const location = locationAt(repo);
    // see packages/engine/src/collaboration-cutover.test.ts - // note: A combined source still carries both the retired marker row and the roadmap table that
    // immutable execution-store migration 6 created.
    const seeded = await openStore(source.context, "write");
    try {
      seeded.db.exec(`
insert into catalog_entities(kind, id, title, root_kind, relative_path, document_kind, revision, registered_at, updated_at)
values ('document', 'doc-roadmap', 'Roadmap', 'projects', 'p-one/roadmap.md', 'roadmap', 5, '2026-09-02T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into project_roadmaps(project_id, content_markdown, content_hash, revision, updated_at)
values ('p-one', '# Roadmap', 'roadmap-hash', 1, '2026-11-21T00:00:00.000Z');
`);
    } finally {
      seeded.close();
    }

    const manifest = await planCollaborationCutover(source.context);
    expect(manifest.blockers).toEqual([]);
    expect((await applyCollaborationCutover(source.context, manifest)).phase).toBe("verified");
    // see packages/engine/src/collaboration-cutover.test.ts - // invariant: The retired kind becomes `other` on the combined-to-lane path with its identity,
    // revision and registration intact - the lane's CHECK no longer admits the value.
    const staged = await stagedRows(location);
    // see packages/engine/src/collaboration-cutover.test.ts - // invariant: Only the retired KIND changes: identity, revision and the registration instant are
    // the source row's own values, so the registration is preserved rather than re-created.
    expect(staged.rows.catalog_entities!.find((row) => row.id === "doc-roadmap")).toMatchObject({
      document_kind: "other",
      kind: "document",
      relative_path: "p-one/roadmap.md",
      revision: 5,
      registered_at: "2026-09-02T00:00:00.000Z",
      updated_at: "2026-11-21T00:00:00.000Z",
    });
    expect(staged.foreignKeyViolations).toEqual([]);

    // see packages/engine/src/collaboration-cutover.test.ts - // invariant: Activation fences the source and drops the retired table with it, child first.
    expect((await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).phase).toBe("active");
    const fenced = await openStore(source.context, "read");
    try {
      const tables = (fenced.db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      );
      expect(tables).not.toContain("project_roadmaps");
      expect(tables).not.toContain("catalog_entities");
    } finally {
      fenced.close();
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

  test("a settled aborted catalog journal is not pending work", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-journal-settled.git");
    const source = await seedSource(repo);
    const seed = await openStore(source.context, "write");
    try {
      seed.db.exec(`
insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, created_at, updated_at)
values ('op-aborted', 'aborted-hash', 'aborted', '{}', '{}', '{}', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, created_at, updated_at)
values ('op-prepared', 'prepared-hash', 'prepared', '{}', '{}', '{}', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
`);
    } finally {
      seed.close();
    }

    const manifest = await planCollaborationCutover(source.context);
    const subjects = manifest.blockers.map((blocker) => blocker.subject);
    expect(subjects.filter((subject) => subject.includes("catalog operation"))).toHaveLength(1);
    expect(subjects.some((subject) => subject.includes("op-prepared"))).toBe(true);
    expect(subjects.some((subject) => subject.includes("op-aborted"))).toBe(false);
    expect(subjects.find((subject) => subject.includes("op-prepared"))).toContain("prepared");

    const settled = await openStore(source.context, "write");
    try {
      settled.db.exec("delete from catalog_operations where operation_id = 'op-prepared'");
    } finally {
      settled.close();
    }
    const replanned = await planCollaborationCutover(source.context);
    expect(replanned.blockers).toEqual([]);
    expect((await applyCollaborationCutover(source.context, replanned)).phase).toBe("verified");
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

    const blocker = join(source.context.harnessDir, "archived");
    writeFileSync(blocker, "not a directory");
    try {
      await expect(
        activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source)),
      ).rejects.toMatchObject({ code: "collaboration.backup-incomplete" });
    } finally {
      rmSync(blocker, { force: true });
    }

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

    const blocker = join(source.context.harnessDir, "archived");
    writeFileSync(blocker, "not a directory");
    try {
      await expect(activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).rejects.toMatchObject({
        code: "collaboration.backup-incomplete",
      });
    } finally {
      rmSync(blocker, { force: true });
    }

    const drifted = await openStore(source.context, "write");
    try {
      drifted.db.exec(`
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)
values ('I-000003', 'p-one', 'Late finding', 'bug', 'low', 'open', 'late', 'stays fixed', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'identity-three');
`);
    } finally {
      drifted.close();
    }

    await expect(activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).rejects.toMatchObject({
      code: "collaboration.cutover-conflict",
    });
    expect((await cutoverState(location)).claims).toEqual([]);
    expect((await stagedRows(location)).authority.state).toBe("staged");
    expect(await planCollaborationCutover(source.context)).not.toEqual(manifest);

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

    expect(await planCollaborationCutover(source.context)).toEqual(manifest);
    expect((await stagedRows(location)).authority.state).toBe("staged");
    expect((await cutoverState(location)).claims).toEqual([]);

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

    for (const operationId of ["restore-attempt:abc", "upgrade-op", "upgrade-op-old"]) {
      expect(state.receipts.some((row) => row.operation_id === operationId)).toBe(false);
    }

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

    writeFileSync(
      recoveryPath,
      `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: "2026-11-21T00:00:00.000Z", token: `rec-${process.pid}-overing` })}\n`,
    );
    try {
      const busy = await refusalOf(() => planCollaborationCutover(source.context));
      expect(busy.code).toBe("collaboration.cutover-conflict");
      expect(busy.message).toContain("recovering the stale collaboration cutover lock");
      expect(readFileSync(lockPath, "utf8")).toContain('"token":"dead"');
    } finally {
      rmSync(recoveryPath, { force: true });
    }

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

  test("a pre-importedIds execution upgrade receipt is owned rather than blocking the cutover", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-receipts-historical-import.git");
    const source = await seedSource(repo);
    const location = locationAt(repo);
    const legacyId = "postmerge-pr405-schema9-upgrade-20261007";

    const injected = await openStore(source.context, "write");
    try {
      injected.db
        .prepare("insert into store_operations(operation_id, request_hash, result_json, committed_at) values (?, ?, ?, ?)")
        .run(
          legacyId,
          "historical-request-hash",
          JSON.stringify({
            verdict: "upgraded",
            imported: 0,
            skipped: [],
            dispositions: [],
            sourceDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          }),
          "2026-10-07T00:00:00.000Z",
        );
    } finally {
      injected.close();
    }

    const manifest = await planCollaborationCutover(source.context);
    expect(manifest.blockers).toEqual([]);
    expect(manifest.counts.store_operations).toBe(3);

    await applyCollaborationCutover(source.context, manifest);
    expect(
      (await activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source))).phase,
    ).toBe("active");

    const staged = await cutoverState(location);
    expect(staged.receipts.map((row) => row.operation_id)).not.toContain(legacyId);
    expect(staged.receipts.map((row) => row.operation_id)).toContain("issue-op-legacy");
    expect(staged.authority.state).toBe("active");
  });

  test("the fence advances a schema-20 source and preserves pins, history and execution rows", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-schema19.git");
    const source = seedSchemaPreFloorSource(repo);
    expect(await upgradeStore(source.context)).toEqual({ schemaVersion: MIGRATIONS.length });
    const location = locationAt(repo);
    const manifest = await planCollaborationCutover(source.context);
    expect(manifest.source).toMatchObject({ storeId: source.storeId, epoch: 1, schemaVersion: MIGRATIONS.length, revision: 7, catalogRevision: 3 });

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
    expect(pinsForeignKeysBefore).toHaveLength(0);

    expect((await applyCollaborationCutover(source.context, manifest)).phase).toBe("verified");
    const receipt = await activateCollaborationCutover(
      source.context,
      manifest,
      cutoverOptions(source.context, manifest.source),
    );
    expect(receipt.phase).toBe("active");
    expect(receipt.source.schemaVersion).toBe(MIGRATIONS.length);

    const after = await openStore(source.context, "read");
    try {
      const schema = after.db.prepare("select max(version) as v from schema_version").get() as { v?: unknown };
      expect(schema.v).toBe(MIGRATIONS.length);
      expect(readCollaborationFence(after.db)).toMatchObject({
        manifestId: manifest.manifestId,
        sourceSchemaVersion: MIGRATIONS.length,
        sourceRevision: 7,
        sourceCatalogRevision: 3,
      });
      expect(after.db.prepare(pinQuery).all()).toEqual(pinsBefore);
      expect(after.db.prepare("pragma foreign_key_list(catalog_execution_bindings)").all()).toEqual([]);
      expect(after.db.prepare("pragma foreign_key_check").all()).toEqual([]);
      expect(readStoreAuthority(after.db)).toEqual(authorityBefore);
      expect(after.execution).toEqual(executionBefore);
      expect(() => after.db.prepare("select count(*) as n from issues").get()).toThrow();
    } finally {
      after.close();
    }

    const staged = await stagedRows(location);
    expect(staged.authority).toMatchObject({ state: "active", revision: 7, catalogRevision: 3 });
    expect(staged.rows.issues!.map((row) => ({ id: row.id, disposition: row.disposition, revision: row.revision }))).toEqual(
      historyBefore,
    );
    expect(staged.rows.issue_transitions).toHaveLength(1);
    expect(staged.rows.project_bindings![0]?.remote_project).toBe("acme/eng");
    expect((await cutoverState(location)).receipts.map((row) => row.operation_id)).toEqual(["issue-op-legacy"]);
  });

  test("a fence commit failure is reported as unconfirmed, never as unchanged", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-commit-unconfirmed.git");
    const source = seedSchemaPreFloorSource(repo);
    expect(await upgradeStore(source.context)).toEqual({ schemaVersion: MIGRATIONS.length });
    const location = locationAt(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);

    const blocker = new DatabaseSync(join(source.context.harnessDir, "store.db"));
    try {
      blocker.exec(
        "create table issue_notes(id integer primary key, issue_id text not null references issues(id) deferrable initially deferred);" +
          "insert into issue_notes(issue_id) values ('I-000001')",
      );
    } finally {
      blocker.close();
    }

    const failure = await refusalOf(() =>
      activateCollaborationCutover(source.context, manifest, cutoverOptions(source.context, manifest.source)),
    );
    expect(failure.code).toBe("collaboration.cutover-unconfirmed");
    expect(failure.message).toContain("UNCONFIRMED");
    expect(failure.message).toContain("do not treat the combined source as unchanged");
    expect(failure.message).toContain("Inspect the persisted fence record");
    expect(failure.message).toContain("FOREIGN KEY constraint failed");
    expect(failure.message).not.toContain("is still at its pre-cutover schema with no fence record");
    expect(failure.message).not.toContain("nothing was fenced and no target publication was made");
    expect((await cutoverState(location)).authority.state).toBe("staged");
  });

  test("a failed fence rolls the schema-20 source back and publishes nothing", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-schema19-rollback.git");
    const source = seedSchemaPreFloorSource(repo);
    expect(await upgradeStore(source.context)).toEqual({ schemaVersion: MIGRATIONS.length });
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

    const restored = await openStore(source.context, "read");
    try {
      const schema = restored.db.prepare("select max(version) as v from schema_version").get() as { v?: unknown };
      expect(schema.v).toBe(MIGRATIONS.length);
      expect(readCollaborationFence(restored.db)).toBeNull();
      expect(restored.db.prepare(pinQuery).all()).toEqual(pinsBefore);
      expect(restored.db.prepare("pragma foreign_key_list(catalog_execution_bindings)").all()).toHaveLength(0);
      expect(restored.db.prepare("select id, disposition from issues order by id").all()).toEqual(issuesBefore);
    } finally {
      restored.close();
    }
    const staged = await cutoverState(location);
    expect(staged.authority.state).toBe("staged");
    expect(staged.publications).toEqual([{ manifest_id: manifest.manifestId, phase: "verified" }]);

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

  test("a fenced combined store upgrades past the effort migration the fence's drop left behind", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-fenced-upgrade.git");
    const context = contextAt(repo);
    const fenced = historicalStore(context.harnessDir, MIGRATIONS.length - 1);
    try {
      fenced.exec(
        "insert into collaboration_cutover(id, manifest_id, manifest_digest, source_store_id, source_epoch, " +
          "source_schema_version, source_revision, source_catalog_revision, target_store_id, target_epoch, " +
          "backup_path, fenced_at) values (1, 'manifest-one', 'digest-one', 'source-store', 1, 20, 7, 3, " +
          "'target-store', 1, '/tmp/pre-fence.db', '2026-11-21T00:00:00.000Z')",
      );
      fenced.exec("drop table project_milestones");
    } finally {
      fenced.close();
    }

    expect(await upgradeStore(context)).toMatchObject({ schemaVersion: MIGRATIONS.length });

    const after = new DatabaseSync(join(context.harnessDir, "store.db"));
    try {
      expect(
        after.prepare("select count(*) as n from sqlite_master where type='table' and name='project_milestones'").get(),
      ).toEqual({ n: 0 });
    } finally {
      after.close();
    }

    const damaged = contextAt(makeRepo("https://github.com/acme/cutover-unfenced-damage.git"));
    const unfenced = historicalStore(damaged.harnessDir, MIGRATIONS.length - 1);
    try {
      unfenced.exec("drop table project_milestones");
    } finally {
      unfenced.close();
    }
    await expect(upgradeStore(damaged)).rejects.toMatchObject({ code: "store.corrupt" });
  });
});
