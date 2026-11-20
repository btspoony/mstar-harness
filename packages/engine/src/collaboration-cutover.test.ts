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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type ActivationAttestation,
} from "./store-activation.js";
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

function attestation(stopped: readonly string[] = []): ActivationAttestation {
  return {
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
        version: "4.8.1",
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions: stopped.map((sessionId) => ({ sessionId, host: "omp", state: "stopped" as const })),
  };
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
update issue_counter set next_value = 3 where id = 1;
update store_meta set revision = 7, catalog_revision = 3 where id = 1;
`);
    return { context, storeId: handle.storeId };
  } finally {
    handle.close();
  }
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
        activateCollaborationCutover(source.context, manifest, { operator: "ops-engineer", attestation: attestation() }),
      ).rejects.toMatchObject({ code: "collaboration.backup-incomplete" });
    } finally {
      rmSync(blocker, { force: true });
    }

    // The source is still unfenced with unchanged evidence, the claim is held
    // (no second claim was taken), and the target is still staged.
    expect(await planCollaborationCutover(source.context)).toEqual(manifest);
    expect((await stagedRows(locationAt(repo))).authority.state).toBe("staged");

    const receipt = await activateCollaborationCutover(source.context, manifest, {
      operator: "ops-engineer",
      attestation: attestation(),
    });
    expect(receipt.phase).toBe("active");
    expect(receipt.replayed).toBe(false);
  });

  test("a fence that committed before publication is resumed by the same activation", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-fence.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);

    const fenced = await fenceCollaborationCutoverSource(source.context, manifest, {
      operator: "ops-engineer",
      attestation: attestation(),
    });
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

    const receipt = await activateCollaborationCutover(source.context, manifest, {
      operator: "ops-engineer",
      attestation: attestation(),
    });
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
    const options = { operator: "ops-engineer", attestation: attestation() };

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

    await activateCollaborationCutover(source.context, manifest, {
      operator: "ops-engineer",
      attestation: attestation(),
    });

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

    const receipt = await activateCollaborationCutover(sourceA.context, manifestA, {
      operator: "ops-engineer",
      attestation: attestation(),
    });
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
      activateCollaborationCutover(source.context, manifest, { operator: "ops-engineer", attestation: attestation() }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(await planCollaborationCutover(source.context)).toEqual(manifest);
  });

  test("a stale binding refuses a clone whose configured mode disagrees", async () => {
    const repo = makeRepo("https://github.com/acme/cutover-binding.git");
    const source = await seedSource(repo);
    const manifest = await planCollaborationCutover(source.context);
    await applyCollaborationCutover(source.context, manifest);
    await activateCollaborationCutover(source.context, manifest, {
      operator: "ops-engineer",
      attestation: attestation(),
    });

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
    const activated = await activateCollaborationCutover(source.context, manifest, {
      operator: "ops-engineer",
      attestation: attestation(),
    });

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
});
