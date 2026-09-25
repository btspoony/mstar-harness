/**
 * execution-migrate.test.ts — proof for the R1 migration protocol: the
 * read-only preview and the staged apply (primary spec §6 items 1–2).
 *
 * Every case runs the REAL modules, the REAL `node:sqlite` driver and REAL
 * filesystem fixtures in per-test temporary workspaces — a real Git main
 * worktree with a `.mstar` control harness, a real store created by
 * `initializeStore`, a real legacy v2 root register plus snapshot plus session
 * envelopes written in the released shape, and a real `backupStore` recovery
 * point. No mocked database, no mocked filesystem, and no injected failure the
 * production code could not meet (the one crash seam is the same
 * test-runner-gated hook the rest of the store uses).
 *
 * Acceptance criteria carried by these cases:
 *
 * - `execution-preview-*`: preview writes no protected byte; identity, pin,
 *   unknown-field, pending-journal, source-drift and symlink mismatches each
 *   refuse; exact replay is stable; a configured (non-default) workflow root is
 *   discovered; a populated deferred surface is reported blocked rather than
 *   treated as absent.
 * - `execution-stage-*`: apply stages every core row, keeps held ownership,
 *   suspends imported sessions, leaves JSON the sole live execution authority,
 *   preserves issue/catalog evidence, replays idempotently, refuses drift and
 *   an unverified recovery point, rolls a mid-import failure back whole, and
 *   takes the maintenance → root → workflow locks in that order.
 * - `execution-activation-*` (R2): a no-deferred-file core fixture activates
 *   only behind the real barrier — one epoch advance, one root revision, old
 *   references revoked, the migrated graph readable and the file route fenced.
 *   A populated surface is no longer a block: the barrier activates on the
 *   VALIDATED coverage (recomputed from the named bytes, closed through the pure
 *   validator), while a coverage set that is missing, forged or drifted, a
 *   `coverageDigest` the workspace does not recompute, source drift, a tampered
 *   staged graph and an attestation the frozen owner inventory cannot justify
 *   each refuse with the staged footprint unchanged. A crash before the commit
 *   leaves exactly the staged (JSON-live) authority and the retry commits once;
 *   a replay returns the recorded receipt without a second epoch bump.
 * - `execution-retirement-*` (R2): retirement moves exactly the root register
 *   and the registered snapshots into manifest-addressed history, leaves every
 *   deferred/host file byte-identical, refuses a source written since the
 *   receipt and refuses before the activation receipt; a crash after a rename
 *   (and one before the receipt) resumes from the exact destination hash; a
 *   durable ledger that redirects an archive destination or rewrites any
 *   addressed field of an item is refused without a rename, and a symlinked
 *   archive destination is refused before the first one.
 * - `execution-abort-*` (R2): a staged manifest returns to legacy with its rows
 *   gone, its epoch unmoved, issue/catalog and every source byte preserved; an
 *   active or retired manifest refuses to abort; a failed attempt rolls back
 *   whole, an aborted manifest cannot be re-staged, and changed legacy input
 *   applies anew under a fresh manifest.
 *
 * Run with
 * `bun test packages/engine/src/execution-migrate.test.ts --test-name-pattern
 * 'execution-preview|execution-stage|execution-activation|execution-retirement|execution-abort'`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCatalogEntity } from "./catalog.js";
import { executionInputHash } from "./coordination.js";
import {
  abortExecutionMigration,
  activateExecutionMigration,
  applyExecutionMigration,
  collectExecutionCoverage,
  executionManifestHash,
  previewExecutionMigration,
  retireExecutionSources,
  type ExecutionManifest,
  type ExecutionManifestDocument,
} from "./execution-migrate.js";
import { type ExecutionCoverageSet } from "./execution-coverage.js";
import { readExecutionState, serializeExecutionValue } from "./execution-store.js";
import { captureIssue } from "./issue.js";
import {
  assertBackupDescribesStore,
  backupStore,
  canonicalPath,
  ACTIVATION_PROTOCOL_VERSION,
  type ActivationAttestation,
  type BackupReceipt,
} from "./store-activation.js";
import { assertExecutionFileWriteAllowed, initializeStore, storeDbPath, type StoreContext } from "./store-db.js";
import { createFsStore, setArtifactStore } from "./store.js";
import { registerWorkflow } from "./status.js";
import { readWorkflowSnapshot, WORKFLOW_SNAPSHOT_FILE, type WorkflowSnapshot } from "./workflow.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-migrate-"));
const PRIMARY = "20260920-migration-primary";
const SECONDARY = "20260920-migration-secondary";
const PLAN_A = `${PRIMARY}-plan-a`;
const PLAN_B = `${PRIMARY}-plan-b`;
const COORDINATOR_SESSION = "host-coordinator-0001";
const PLAN_A_SESSION = "host-plan-a-0001";
const PLAN_B_SESSION = "host-plan-b-0001";
const ROOT_UPDATED_AT = "2026-09-03";
const TS = "2026-09-02T00:00:00.000Z";
const INTEGRATION_BRANCH = "iteration/iter-example";
const INTEGRATION_WORKTREE = "integration";

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture: a real legacy execution workspace
// ---------------------------------------------------------------------------

type Fixture = {
  root: string;
  harness: string;
  context: StoreContext;
  /** §4.2 the explicit inventory path every migration verb names. */
  inventoryPath: string;
};

type LegacyWorkspace = Fixture & {
  workflowId: string;
  workflowDir: string;
  snapshotPath: string;
  statusPath: string;
  sessionsDir: string;
  coordinatorEnvelope: string;
  planEnvelopes: Record<string, string>;
  /** The canonical store path, resolved once so raw reads do not re-probe Git. */
  dbPath: string;
  /** Every protected source path, for the "writes nothing" proofs. */
  protectedPaths: string[];
};

function workspace(name: string): Fixture {
  const root = mkdtempSync(join(ROOT, `${name}-`));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const fixture: Fixture = { root, harness, context: { harnessDir: harness }, inventoryPath: join(harness, INV, "inventory.json") };
  writeInventory(fixture);
  return fixture;
}

const INV = "execution-inventory";

/** §4.2 the explicit inventory of one fixture: the configured roots and the evidence inputs. */
function writeInventory(fixture: Fixture, extra: Record<string, unknown> = {}): void {
  writeJson(fixture.inventoryPath, {
    version: 2,
    roots: { sdd: join(fixture.harness, INV, "sdd"), host: join(fixture.harness, INV, "host"), package: join(fixture.harness, INV, "package") },
    hostSessions: [],
    sddEvidence: [],
    consumers: [],
    injectors: [],
    injectorInventory: null,
    backup: null,
    ...extra,
  });
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2));
}

function envelopeOf(role: "coordinator" | "plan-pm", sessionId: string, workflowId: string, harness: string, planId?: string) {
  const envelope: Record<string, unknown> = {
    schema_version: 1,
    role,
    session_id: sessionId,
    workflow_id: workflowId,
    harness_root: harness,
  };
  if (planId !== undefined) envelope.plan_id = planId;
  return envelope;
}

/**
 * One legacy workspace shaped the way the released file route leaves it: a v2
 * root register, one snapshot carrying a coordinator binding, a per-plan
 * session, prepared progress, a submitted handoff and a held execution lease,
 * plus the session envelopes those bindings name — all over a store whose
 * execution authority is still `legacy`.
 */
async function legacyWorkspace(
  name: string,
  options: { secondWorkflow?: boolean; workflowDirName?: string } = {},
): Promise<LegacyWorkspace> {
  const fixture = workspace(name);
  const handle = await initializeStore(fixture.context);
  handle.close();

  const layout = options.workflowDirName ?? "workflows";
  const workflowId = PRIMARY;
  const workflowDir = join(fixture.harness, layout, workflowId);
  const sessionsDir = join(workflowDir, "sessions");
  const coordinatorEnvelope = join(sessionsDir, `coordinator-${COORDINATOR_SESSION}.json`);
  const planEnvelopes = {
    [PLAN_A]: join(sessionsDir, `plan-pm-${PLAN_A_SESSION}.json`),
    [PLAN_B]: join(sessionsDir, `plan-pm-${PLAN_B_SESSION}.json`),
  };
  const bindingOf = (sessionId: string, path: string) => ({ session_id: sessionId, session_file: path, bound_at: TS });
  const scopeOf = (planId: string) => ({
    worktree_path: join(fixture.harness, "worktrees", planId),
    working_branch: `feature/${planId}`,
  });

  const snapshot: Record<string, unknown> = {
    schema_version: 1,
    id: workflowId,
    type: "plan",
    status: "running",
    started_at: "2026-09-01",
    updated_at: "2026-09-02",
    delivery_kind: "development",
    project: "_default",
    branch: { source: `feature/${workflowId}`, target: "main", integration: INTEGRATION_BRANCH },
    integration_worktree_path: join(fixture.harness, "worktrees", INTEGRATION_WORKTREE),
    coordination: { coordinator: bindingOf(COORDINATOR_SESSION, coordinatorEnvelope) },
    // §2.2/§3 the released shape of held integration ownership: the workflow's
    // coordinator holds the claim for PLAN_A's accepted attempt, which it moved
    // to `integrating` against the snapshot's integration branch.
    integration_merge_lease: {
      holder: COORDINATOR_SESSION,
      claimed_at: TS,
      plan_id: PLAN_A,
      source_branch: `feature/${PLAN_A}`,
      target_branch: INTEGRATION_BRANCH,
    },
    plans: [
      {
        id: PLAN_A,
        title: "Migration plan A",
        file: "plans/plan-a.md",
        status: "InProgress",
        metadata: scopeOf(PLAN_A),
        coordination: {
          revision: 3,
          session: bindingOf(PLAN_A_SESSION, planEnvelopes[PLAN_A]),
          progress: {
            status: "InReview",
            summary: "integrating onto the iteration branch",
            evidence_paths: [join(fixture.harness, "sdd", PLAN_A, "qc.md")],
          },
          handoff: {
            id: "hoff-a",
            attempt: 1,
            state: "integrating",
            submitted_by: PLAN_A_SESSION,
            submitted_at: TS,
            source_branch: `feature/${PLAN_A}`,
            source_sha: "a".repeat(40),
            worktree_path: join(fixture.harness, "worktrees", PLAN_A),
            review_base: "c".repeat(40),
            review_head: "d".repeat(40),
            accepted_by: COORDINATOR_SESSION,
            accepted_at: TS,
            qc: {
              decision: "Approve",
              reports: [{ path: join(fixture.harness, "sdd", PLAN_A, "qc1.md"), sha256: "e".repeat(64) }],
              consolidated: { path: join(fixture.harness, "sdd", PLAN_A, "qc.md"), sha256: "f".repeat(64) },
            },
            qa: {
              gate: "mandatory",
              decision: "pass",
              report: { path: join(fixture.harness, "sdd", PLAN_A, "qa.md"), sha256: "1".repeat(64) },
            },
            integration: {
              target_branch: INTEGRATION_BRANCH,
              worktree_path: join(fixture.harness, "worktrees", INTEGRATION_WORKTREE),
              base_sha: "2".repeat(40),
              started_at: TS,
            },
          },
        },
        execution_lease: { holder: PLAN_A_SESSION, claimed_at: TS, ...scopeOf(PLAN_A), base_sha: "a".repeat(40) },
      },
      {
        id: PLAN_B,
        title: "Migration plan B",
        file: "plans/plan-b.md",
        status: "InReview",
        metadata: scopeOf(PLAN_B),
        coordination: {
          revision: 5,
          session: bindingOf(PLAN_B_SESSION, planEnvelopes[PLAN_B]),
          progress: {
            status: "InReview",
            summary: "QC complete pending handoff",
            evidence_paths: [join(fixture.harness, "sdd", PLAN_B, "qc.md")],
          },
          handoff: {
            id: "hoff-1",
            attempt: 1,
            state: "submitted",
            submitted_by: PLAN_B_SESSION,
            submitted_at: TS,
            source_branch: `feature/${PLAN_B}`,
            source_sha: "b".repeat(40),
            worktree_path: join(fixture.harness, "worktrees", PLAN_B),
            review_base: "c".repeat(40),
            review_head: "d".repeat(40),
            qc: {
              decision: "approve",
              reports: [{ path: join(fixture.harness, "sdd", PLAN_B, "qc1.md"), sha256: "e".repeat(64) }],
              consolidated: { path: join(fixture.harness, "sdd", PLAN_B, "qc.md"), sha256: "f".repeat(64) },
            },
            qa: {
              gate: "mandatory",
              decision: "pass",
              report: { path: join(fixture.harness, "sdd", PLAN_B, "qa.md"), sha256: "1".repeat(64) },
            },
          },
        },
      },
    ],
  };

  const entries = [{ id: workflowId, type: "plan", started_at: "2026-09-01", dir: join(layout, workflowId) }];
  if (options.secondWorkflow === true) {
    writeJson(join(fixture.harness, layout, SECONDARY, WORKFLOW_SNAPSHOT_FILE), {
      schema_version: 1,
      id: SECONDARY,
      type: "plan",
      status: "running",
      started_at: "2026-09-01",
      updated_at: "2026-09-02",
      delivery_kind: "development",
      branch: { source: `feature/${SECONDARY}`, target: "main" },
      plans: [{ id: `${SECONDARY}-plan`, title: "Second plan", file: "plans/second.md", status: "Todo", metadata: {} }],
    });
    entries.push({ id: SECONDARY, type: "plan", started_at: "2026-09-01", dir: join(layout, SECONDARY) });
  }

  const statusPath = join(fixture.harness, "status.json");
  writeJson(statusPath, { version: 2, updated_at: ROOT_UPDATED_AT, workflows: entries });
  writeJson(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), snapshot);
  writeJson(coordinatorEnvelope, envelopeOf("coordinator", COORDINATOR_SESSION, workflowId, fixture.harness));
  writeJson(planEnvelopes[PLAN_A], envelopeOf("plan-pm", PLAN_A_SESSION, workflowId, fixture.harness, PLAN_A));
  writeJson(planEnvelopes[PLAN_B], envelopeOf("plan-pm", PLAN_B_SESSION, workflowId, fixture.harness, PLAN_B));

  // The fixture claims to be the released shape, so the production reader must
  // accept it before any case runs against it.
  readWorkflowSnapshot(workflowDir);
  const dbPath = storeDbPath(fixture.context);
  return {
    ...fixture,
    workflowId,
    workflowDir,
    snapshotPath: join(workflowDir, WORKFLOW_SNAPSHOT_FILE),
    statusPath,
    sessionsDir,
    coordinatorEnvelope,
    planEnvelopes,
    dbPath,
    protectedPaths: [statusPath, join(workflowDir, WORKFLOW_SNAPSHOT_FILE), coordinatorEnvelope, ...Object.values(planEnvelopes)],
  };
}

// ---------------------------------------------------------------------------
// Raw store access, footprints and small test plumbing
// ---------------------------------------------------------------------------

const EXECUTION_TABLES = [
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

function rawAll<T>(dbPath: string, sql: string): T[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function rawGet<T>(dbPath: string, sql: string): T | undefined {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get() as T | undefined;
  } finally {
    db.close();
  }
}

function rawRun(dbPath: string, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** Everything a migration must leave untouched (or move in exactly the staged way). */
function storeFootprint(dbPath: string): Record<string, unknown> {
  const footprint: Record<string, unknown> = {};
  for (const table of EXECUTION_TABLES) {
    footprint[table] = rawGet<{ n: number }>(dbPath, `select count(*) as n from ${table}`);
  }
  footprint.executionMeta = rawGet(
    dbPath,
    "select protocol_version, authority_state, revision, root_updated_at, manifest_id, activated_at from execution_meta where id = 1",
  );
  footprint.storeMeta = rawGet(
    dbPath,
    "select store_id, authority_state, authority_epoch, revision, catalog_revision from store_meta where id = 1",
  );
  footprint.issues = rawGet(dbPath, "select count(*) as n from issues");
  footprint.catalogEntities = rawGet(dbPath, "select count(*) as n from catalog_entities");
  return footprint;
}

function protectedBytes(paths: readonly string[]): string[] {
  return paths.map((path) => readFileSync(path).toString("base64"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Set test-runner-gated environment for one call, then restore it. */
async function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]] as const));
  const runner = process.env.MSTAR_STORE_TEST_RUNNER;
  process.env.MSTAR_STORE_TEST_RUNNER = "1";
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    return await run();
  } finally {
    if (runner === undefined) delete process.env.MSTAR_STORE_TEST_RUNNER;
    else process.env.MSTAR_STORE_TEST_RUNNER = runner;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The typed refusal of one call: its stable code and message, whatever domain raised it. */
async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate?.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code, message: candidate.message };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

function migrationInput(fixture: Fixture, operationId: string) {
  return { context: fixture.context, operationId, operator: "ops-engineer", inventoryPath: fixture.inventoryPath };
}

/** §4.1/§4.2 the coverage of one reviewed manifest, recomputed by the real collector. */
async function coverageOf(fixture: Fixture, manifest: ExecutionManifest): Promise<ExecutionCoverageSet> {
  return collectExecutionCoverage({ ...migrationInput(fixture, "op-coverage"), manifest });
}

/** §4.2 the coverage digest of one reviewed manifest. */
async function coverageDigestOf(fixture: Fixture, manifest: ExecutionManifest): Promise<string> {
  return (await coverageOf(fixture, manifest)).digest;
}

/** A verified recovery point of the current store state. */
let backupSeq = 0;
async function recoveryPoint(fixture: Fixture): Promise<BackupReceipt> {
  backupSeq += 1;
  return backupStore(fixture.context, { out: join(fixture.harness, "archived", "backups", `point-${backupSeq}.db`) });
}

async function stageReviewed(fixture: Fixture, suffix: string): Promise<ExecutionManifest> {
  const backup = await recoveryPoint(fixture);
  const manifest = await previewExecutionMigration(migrationInput(fixture, `op-preview-${suffix}`));
  await applyExecutionMigration({
    ...migrationInput(fixture, `op-apply-${suffix}`), coverage: await coverageOf(fixture, manifest),
    manifest,
    manifestHash: executionManifestHash(manifest),
    backup,
  });
  return manifest;
}

function issueInput(title: string) {
  return {
    projectId: "_default",
    title,
    kind: "bug" as const,
    severity: "high" as const,
    impact: "issue authority must survive the execution import",
    acceptance: "the row is still there afterwards",
    sourceIdentity: `qc/${title}.md`,
    rootCauseKey: `${title}-root-cause`,
    acceptanceKey: "preserved",
    occurrenceKey: `run-${title}`,
    sourceKind: "qc" as const,
    location: "packages/engine/src/execution-migrate.ts:1",
    observedBehavior: "the import must not touch issue rows",
    evidence: ["proof"],
    discoveredAt: TS,
  };
}

// ---------------------------------------------------------------------------
// Fixture: the no-deferred-file core workspace of §2.3
// ---------------------------------------------------------------------------

/**
 * §2.3: a real workspace that carries session envelopes CANNOT pass the 2a
 * activation barrier — that is the fail-closed boundary, not a fixture
 * limitation — so the activation/retirement path is proven on a workspace that
 * holds no deferred surface at all: a v2 root register whose registered
 * snapshots have no coordinator binding, no plan session, no lease, no
 * note/flow ledger, no launch journal and no host status file.
 */
const CORE_A = "20260920-core-workflow-a";
const CORE_B = "20260920-core-workflow-b";

type CoreWorkspace = Fixture & {
  workflowIds: string[];
  workflowDirs: string[];
  snapshotPaths: string[];
  statusPath: string;
  dbPath: string;
};

async function coreWorkspace(name: string, options: { workflows?: number } = {}): Promise<CoreWorkspace> {
  const fixture = workspace(name);
  const handle = await initializeStore(fixture.context);
  handle.close();
  const workflowIds = [CORE_A, CORE_B].slice(0, options.workflows ?? 1);
  const workflowDirs = workflowIds.map((id) => join(fixture.harness, "workflows", id));
  const snapshotPaths = workflowDirs.map((dir) => join(dir, WORKFLOW_SNAPSHOT_FILE));
  const entries = workflowIds.map((id) => {
    writeJson(join(fixture.harness, "workflows", id, WORKFLOW_SNAPSHOT_FILE), {
      schema_version: 1,
      id,
      type: "plan",
      status: "running",
      started_at: "2026-09-01",
      updated_at: "2026-09-02",
      delivery_kind: "development",
      project: "_default",
      branch: { source: `feature/${id}`, target: "main" },
      plans: [{ id: `${id}-plan`, title: "Core plan", file: `plans/${id}.md`, status: "Todo", metadata: {} }],
    });
    return { id, type: "plan", started_at: "2026-09-01", dir: join("workflows", id) };
  });
  const statusPath = join(fixture.harness, "status.json");
  writeJson(statusPath, { version: 2, updated_at: ROOT_UPDATED_AT, workflows: entries });
  for (const dir of workflowDirs) readWorkflowSnapshot(dir);
  return { ...fixture, workflowIds, workflowDirs, snapshotPaths, statusPath, dbPath: storeDbPath(fixture.context) };
}

/** The typed refusal of one SYNCHRONOUS call, for the file-route guards. */
function syncRefusalOf(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate?.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code, message: candidate.message };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

/**
 * A conforming barrier attestation. `stoppedSessions` defaults to empty — the
 * core fixture imports no session owner — so a test that names an owner can
 * only do so by claiming one the frozen inventory contains.
 */
function migrationAttestation(stoppedSessions: ActivationAttestation["stoppedSessions"] = []): ActivationAttestation {
  return {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt: "2026-09-21T00:00:00.000Z",
    operator: { actor: "ops-engineer", authorizationRef: "D29 execution activation" },
    consumers: [
      {
        entryId: "cli-global",
        kind: "cli",
        entrypoint: "/usr/local/lib/node_modules/@mstar-harness/cli/dist/index.js",
        runtime: "bun",
        runtimeVersion: "1.4.0",
        version: "3.11.0",
        current: false,
        disposition: "upgraded",
      },
      {
        entryId: "coordinator-omp",
        kind: "coordinator",
        entrypoint: "/Users/op/.omp/plugins/mstar/packages/cli/dist/index.js",
        runtime: "node",
        runtimeVersion: "24.18.0",
        version: "3.11.0",
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions,
  };
}

async function activationInput(fixture: Fixture, manifest: ExecutionManifest, suffix: string, attestation = migrationAttestation()) {
  return {
    ...migrationInput(fixture, `op-activate-${suffix}`),
    manifestId: manifest.id,
    manifestHash: executionManifestHash(manifest),
    expectedEpoch: manifest.epoch,
    attestation,
    coverageDigest: await coverageDigestOf(fixture, manifest),
  };
}

function retirementInput(fixture: Fixture, manifest: ExecutionManifest, suffix: string) {
  return {
    ...migrationInput(fixture, `op-retire-${suffix}`),
    manifestId: manifest.id,
    manifestHash: executionManifestHash(manifest),
  };
}

function abortInput(fixture: Fixture, manifest: ExecutionManifest, suffix: string, reason = "legacy input changed while staged") {
  return { ...migrationInput(fixture, `op-abort-${suffix}`), manifestId: manifest.id, manifestHash: executionManifestHash(manifest), reason };
}

/** Stage one reviewed manifest and return it — the state every R2 verb starts from. */
async function stageCore(fixture: Fixture, suffix: string): Promise<ExecutionManifest> {
  const backup = await recoveryPoint(fixture);
  const manifest = await previewExecutionMigration(migrationInput(fixture, `op-${suffix}-preview`));
  await applyExecutionMigration({
    ...migrationInput(fixture, `op-${suffix}-apply`), coverage: await coverageOf(fixture, manifest),
    manifest,
    manifestHash: executionManifestHash(manifest),
    backup,
  });
  return manifest;
}

function sha256OfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Every file under one directory (harness-relative path → sha256). "Retirement
 * moved exactly the core sources" is checkable as a whole-tree comparison
 * rather than a list of paths someone remembered to check.
 */
function treeInventory(dir: string): Record<string, string> {
  const inventory: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else inventory[relative(dir, path)] = sha256OfBytes(readFileSync(path));
    }
  };
  walk(dir);
  return inventory;
}

/** The tree minus the store's own files and the archive — the bytes a retirement must not touch. */
function nonStoreFiles(inventory: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inventory).filter(
      ([path]) => !path.startsWith("store.db") && !path.startsWith("archived/"),
    ),
  );
}

function authorityOf(dbPath: string): { authority_state: string; authority_epoch: number; revision: number } {
  return rawGet<{ authority_state: string; authority_epoch: number; revision: number }>(
    dbPath,
    "select authority_state, authority_epoch, revision from store_meta where id = 1",
  )!;
}

function executionMetaOf(dbPath: string): { authority_state: string; revision: number; manifest_id: string | null; activated_at: string | null } {
  return rawGet(
    dbPath,
    "select authority_state, revision, manifest_id, activated_at from execution_meta where id = 1",
  )!;
}

/** The recorded phase of the newest staged/active/retired/aborted manifest row. */
function migrationPhaseOf(dbPath: string): string {
  return rawGet<{ phase: string }>(dbPath, "select phase from execution_migrations order by rowid desc limit 1")!.phase;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe("execution-preview", () => {
  test("execution-preview-inventory-writes-nothing", async () => {
    const fixture = await legacyWorkspace("preview-inventory");
    const before = protectedBytes(fixture.protectedPaths);
    const footprint = storeFootprint(fixture.dbPath);

    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-preview-1"));

    expect(manifest.version).toBe(2);
    expect(manifest.id.startsWith("exec-")).toBe(true);
    expect(manifest.root).toBe(canonicalPath(dirname(storeDbPath(fixture.context))));
    expect(manifest.storeId).toBe((footprint.storeMeta as { store_id: string }).store_id);
    expect(manifest.epoch).toBe((footprint.storeMeta as { authority_epoch: number }).authority_epoch);
    // The manifest pins the store's OWN schema generation: assert it against the
    // live store rather than a literal that a new append-only migration would
    // silently outdate.
    expect(manifest.schemaVersion).toBe(
      rawGet<{ v: number }>(fixture.dbPath, "select max(version) as v from schema_version")!.v,
    );
    expect(manifest.catalogRevision).toBe((footprint.storeMeta as { catalog_revision: number }).catalog_revision);
    expect(manifest.pendingCatalogOperations).toEqual([]);
    expect(manifest.sources.map((witness) => witness.kind)).toEqual([
      "root",
      "workflow",
      "session-envelope",
      "session-envelope",
      "session-envelope",
      // §4.2 the explicit inventory is itself a witnessed input: the discovery it
      // drives is bound to those exact bytes.
      "inventory",
    ]);
    expect(manifest.sources.map((witness) => witness.path)).toEqual([
      canonicalPath(fixture.statusPath),
      canonicalPath(fixture.snapshotPath),
      canonicalPath(fixture.coordinatorEnvelope),
      canonicalPath(fixture.planEnvelopes[PLAN_A]),
      canonicalPath(fixture.planEnvelopes[PLAN_B]),
      canonicalPath(fixture.inventoryPath),
    ]);
    // The 2b deferred register is inventoried surface by surface; this fixture
    // occupies none of them.
    expect(manifest.deferred.map((entry) => entry.surface)).toEqual([
      "workflow-session-envelopes",
      "workflow-notes-ledger",
      "workflow-agent-flow-ledger",
      "workflow-ledger-cursors",
      "workflow-omp-launch-journal",
      "legacy-write-lock",
      "engine-status-snapshot",
    ]);
    // Referenced session envelopes are files under the workflow dir, so the
    // session surface is BLOCKED exactly as the 2b register describes — staging
    // stages them, activation (R2) is what needs them absent.
    for (const surface of manifest.deferred) {
      if (surface.surface === "workflow-session-envelopes") {
        expect(surface.disposition).toBe("blocked");
        expect(surface.paths).toEqual([
          canonicalPath(fixture.coordinatorEnvelope),
          canonicalPath(fixture.planEnvelopes[PLAN_A]),
          canonicalPath(fixture.planEnvelopes[PLAN_B]),
        ].sort());
        continue;
      }
      expect(surface.disposition, surface.surface).toBe("absent");
      expect(surface.paths, surface.surface).toEqual([]);
    }

    expect(protectedBytes(fixture.protectedPaths)).toEqual(before);
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
  });

  test("execution-preview-replay-is-stable", async () => {
    const fixture = await legacyWorkspace("preview-stable");
    const first = await previewExecutionMigration(migrationInput(fixture, "op-stable-1"));
    const second = await previewExecutionMigration(migrationInput(fixture, "op-stable-2"));
    expect(second).toEqual(first);
    expect(executionManifestHash(second)).toBe(executionManifestHash(first));
  });

  test("execution-preview-discovers-a-configured-workflow-root", async () => {
    // Discovery follows the recorded harness-relative dir, so a workspace whose
    // workflow layout is not the default is found rather than overlooked.
    const fixture = await legacyWorkspace("preview-configured-root", { workflowDirName: "cw-wf" });
    writeText(join(fixture.harness, ".mstarc"), "[config]\nworkflow_dir=cw-wf\n");
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-configured"));
    expect(manifest.sources.find((witness) => witness.kind === "workflow")?.path).toBe(canonicalPath(fixture.snapshotPath));
    expect(fixture.snapshotPath).toBe(join(fixture.harness, "cw-wf", PRIMARY, WORKFLOW_SNAPSHOT_FILE));
    expect(manifest.sources.filter((witness) => witness.kind === "session-envelope")).toHaveLength(3);
  });

  test("execution-preview-refuses-a-missing-referenced-envelope", async () => {
    const fixture = await legacyWorkspace("preview-missing-envelope");
    rmSync(fixture.planEnvelopes[PLAN_A]);
    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-missing")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("does not exist");
  });

  test("execution-preview-refuses-an-envelope-identity-mismatch", async () => {
    const fixture = await legacyWorkspace("preview-envelope-identity");
    writeJson(fixture.planEnvelopes[PLAN_A], envelopeOf("plan-pm", "host-someone-else", fixture.workflowId, fixture.harness, PLAN_A));
    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-identity")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain(PLAN_A_SESSION);
  });

  test("execution-preview-refuses-a-symlinked-source", async () => {
    const fixture = await legacyWorkspace("preview-symlink");
    const outside = join(fixture.root, "outside-envelope.json");
    writeFileSync(outside, readFileSync(fixture.planEnvelopes[PLAN_B]));
    rmSync(fixture.planEnvelopes[PLAN_B]);
    symlinkSync(outside, fixture.planEnvelopes[PLAN_B]);
    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-symlink")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("symlink");
  });

  test("execution-preview-refuses-a-foreign-catalog-pin", async () => {
    const fixture = await legacyWorkspace("preview-foreign-pin");
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as {
      plans: Array<{ id: string; metadata: Record<string, unknown> }>;
    };
    snapshot.plans[0]!.metadata.catalog_pin = {
      store_id: "00000000-0000-4000-8000-000000000000",
      entity_revision: 3,
      document_hash: "2".repeat(64),
      relation_hash: "3".repeat(64),
    };
    writeJson(fixture.snapshotPath, snapshot);
    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-foreign-pin")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("pins catalog store");
  });

  test("execution-preview-refuses-a-catalog-binding-that-disagrees", async () => {
    const fixture = await legacyWorkspace("preview-binding-conflict");
    const storeId = rawGet<{ store_id: string }>(fixture.dbPath, "select store_id from store_meta where id = 1")!.store_id;
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as {
      plans: Array<{ id: string; metadata: Record<string, unknown> }>;
    };
    const row = snapshot.plans[0]!;
    // The row's OWN pin is coherent (the released prepare shape), so the only
    // disagreement this case carries is the committed binding's recorded hash.
    const pin = {
      store_id: storeId,
      entity_revision: 3,
      document_hash: executionInputHash(row, PLAN_A),
      relation_hash: "3".repeat(64),
    };
    row.metadata.catalog_pin = pin;
    writeJson(fixture.snapshotPath, snapshot);
    // The binding's foreign key needs the catalog entity it points at.
    rawRun(
      fixture.dbPath,
      "insert into catalog_entities(kind, id, title, root_kind, relative_path, revision, lifecycle, registered_at, updated_at) " +
        "values ('plan', ?, 'Plan A', 'plans', 'plans/plan-a.md', 1, 'active', ?, ?)",
      PLAN_A,
      TS,
      TS,
    );
    rawRun(
      fixture.dbPath,
      "insert into catalog_execution_bindings(workflow_id, catalog_kind, catalog_id, workflow_root_kind, " +
        "workflow_relative_path, catalog_revision, input_hash, pin_json, operation_id) " +
        "values (?, 'plan', ?, 'harness', ?, 1, ?, ?, 'op-bind')",
      fixture.workflowId,
      PLAN_A,
      "plans/plan-a.md",
      "0".repeat(64),
      JSON.stringify(pin),
    );
    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-binding")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("neither side wins silently");
  });

  test("execution-preview-refuses-a-pin-that-disagrees-with-its-row", async () => {
    // §7/§1 a pin freezes the row it is sealed with, so a same-store pin whose
    // `document_hash` is not that row's frozen-input hash is refused even
    // though NO binding row exists to disagree with it — the missing binding
    // side never licenses sealing an incoherent pin. Both live routes refuse
    // the same disagreement (create: `assertSelectedCatalogEntities`; read:
    // `readExecutionCatalogPin`).
    const fixture = await legacyWorkspace("preview-pin-row-disagreement");
    const storeId = rawGet<{ store_id: string }>(fixture.dbPath, "select store_id from store_meta where id = 1")!.store_id;
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as {
      plans: Array<{ id: string; metadata: Record<string, unknown> }>;
    };
    snapshot.plans[0]!.metadata.catalog_pin = {
      store_id: storeId,
      entity_revision: 3,
      document_hash: "2".repeat(64),
      relation_hash: "3".repeat(64),
    };
    writeJson(fixture.snapshotPath, snapshot);
    const footprint = storeFootprint(fixture.dbPath);
    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-pin-row")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("the pin and its row disagree");
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);

    // The same pin with the row's OWN hash — the released prepare shape — is
    // the coherent pair and previews.
    snapshot.plans[0]!.metadata.catalog_pin = {
      ...(snapshot.plans[0]!.metadata.catalog_pin as Record<string, unknown>),
      document_hash: executionInputHash(snapshot.plans[0]!, PLAN_A),
    };
    writeJson(fixture.snapshotPath, snapshot);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-pin-row-ok"));
    expect(manifest.sources.length).toBeGreaterThan(0);
  });

  test("execution-preview-imports-a-bound-plan-that-records-no-pin", async () => {
    // §1 coexistence — deliberately NOT a refusal. A plan row that records no
    // pin does not disagree with its workflow's committed binding: the
    // binding IS that plan's pin, read exactly as `readExecutionCatalogPin`
    // reads it (the association's identity, with the document half supplied by
    // the frozen row). A binding stores its own identity in `input_hash` /
    // `pin_json` (`writeBinding`), not an execution pin, so comparing the two
    // as if they were one quantity would refuse a state the contract keeps
    // importable — the reviewer-visible `document_hash` invariant lives on the
    // pin itself and is enforced above, independently of any binding.
    const fixture = await legacyWorkspace("preview-bound-unpinned");
    rawRun(
      fixture.dbPath,
      "insert into catalog_entities(kind, id, title, root_kind, relative_path, revision, lifecycle, registered_at, updated_at) " +
        "values ('plan', ?, 'Plan A', 'plans', 'plans/plan-a.md', 1, 'active', ?, ?)",
      PLAN_A,
      TS,
      TS,
    );
    const bindingIdentity = JSON.stringify({
      kind: "plan",
      id: PLAN_A,
      rootKind: "plans",
      relativePath: "plans/plan-a.md",
      documentKind: null,
      sourceHash: null,
    });
    rawRun(
      fixture.dbPath,
      "insert into catalog_execution_bindings(workflow_id, catalog_kind, catalog_id, workflow_root_kind, " +
        "workflow_relative_path, catalog_revision, input_hash, pin_json, operation_id) " +
        "values (?, 'plan', ?, 'harness', ?, 1, ?, ?, 'op-bind')",
      fixture.workflowId,
      PLAN_A,
      "plans/plan-a.md",
      createHash("sha256").update(bindingIdentity, "utf8").digest("hex"),
      bindingIdentity,
    );
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-bound-unpinned-preview"));
    const receipt = await applyExecutionMigration({
      ...migrationInput(fixture, "op-bound-unpinned-apply"), coverage: await coverageOf(fixture, manifest),
      manifest,
      manifestHash: executionManifestHash(manifest),
      backup,
    });
    expect(receipt.phase).toBe("staged");
    // The sealed input records no pin, and the association is left exactly as
    // it was: the migration preserves catalog rows, it never rewrites them.
    expect(
      rawGet<{ catalog_pin_json: string | null }>(
        fixture.dbPath,
        `select catalog_pin_json from execution_inputs where workflow_id = '${fixture.workflowId}' and plan_id = '${PLAN_A}'`,
      ),
    ).toEqual({ catalog_pin_json: null });
    expect(
      rawGet<{ n: number; input_hash: string }>(
        fixture.dbPath,
        `select count(*) as n, min(input_hash) as input_hash from catalog_execution_bindings where workflow_id = '${fixture.workflowId}'`,
      ),
    ).toEqual({ n: 1, input_hash: createHash("sha256").update(bindingIdentity, "utf8").digest("hex") });
  });

  test("execution-preview-refuses-an-unclassified-workflow-entry", async () => {
    const fixture = await legacyWorkspace("preview-unclassified");
    writeText(join(fixture.workflowDir, "stray-artifact.txt"), "not a source this inventory classifies");
    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-unclassified")));
    expect(refusal.code).toBe("execution.coverage-incomplete");
    expect(refusal.message).toContain("stray-artifact.txt");
  });

  test("execution-preview-refuses-an-unrecognized-execution-field", async () => {
    // §2.2: an unrecognized field in a checked execution shape refuses rather
    // than being silently dropped on the way into the DB columns.
    const fixture = await legacyWorkspace("preview-unrecognized-field");
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as {
      plans: Array<{ coordination: Record<string, unknown> }>;
    };
    snapshot.plans[1]!.coordination.audit = [{ at: TS, actor: "someone" }];
    writeJson(fixture.snapshotPath, snapshot);
    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-unrecognized-field")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("unexpected key(s): audit");
  });

  test("execution-preview-refuses-a-pending-catalog-journal", async () => {
    const fixture = await legacyWorkspace("preview-pending-journal");
    rawRun(
      fixture.dbPath,
      "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, " +
        "after_versions_json, result_json, created_at, updated_at) " +
        "values ('op-pending', 'hash', 'execution-written', '{}', '{}', '{}', null, ?, ?)",
      TS,
      TS,
    );
    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-pending")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("op-pending");
  });

  test("execution-preview-reports-a-populated-deferred-surface-as-blocked", async () => {
    const fixture = await legacyWorkspace("preview-deferred");
    writeText(join(fixture.workflowDir, "notes.jsonl"), '{"kind":"note","ts":1,"text":"legacy note"}');
    writeText(join(fixture.harness, "snapshots", "engine-status.json"), '{"sv":1,"entries":[]}');
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-deferred"));
    const blocked = manifest.deferred.filter((surface) => surface.disposition === "blocked");
    expect(blocked.map((surface) => surface.surface)).toEqual([
      "workflow-session-envelopes",
      "workflow-notes-ledger",
      "engine-status-snapshot",
    ]);
    expect(blocked.find((surface) => surface.surface === "workflow-notes-ledger")!.paths).toEqual([
      canonicalPath(join(fixture.workflowDir, "notes.jsonl")),
    ]);
    for (const surface of manifest.deferred) {
      // The invariant a 2b activation receipt reads: discovered paths exist
      // exactly when the surface is blocked.
      expect(surface.paths.length > 0, surface.surface).toBe(surface.disposition === "blocked");
    }
    // Discovery order: the harness-level status file is witnessed after the
    // workflow dirs, and the per-workflow retained ledgers are witnessed when
    // their §4.1 rows are built.
    expect(manifest.sources.filter((witness) => witness.kind === "deferred").map((witness) => witness.path)).toEqual([
      canonicalPath(join(fixture.harness, "snapshots", "engine-status.json")),
      canonicalPath(join(fixture.workflowDir, "notes.jsonl")),
    ]);
  });

  test("execution-preview-refuses-an-active-execution-authority", async () => {
    const fixture = await legacyWorkspace("preview-active-authority");
    rawRun(fixture.dbPath, "update execution_meta set authority_state = 'active' where id = 1");
    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-active")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// Staged apply
// ---------------------------------------------------------------------------

describe("execution-stage", () => {
  test("execution-stage-stages-every-core-row-and-keeps-ownership", async () => {
    const fixture = await legacyWorkspace("stage-rows", { secondWorkflow: true });
    await captureIssue(fixture.context, issueInput("Pre-migration finding"), {
      operationId: "op-issue-1",
      actor: "project-manager",
    });
    await registerCatalogEntity(
      fixture.context,
      { kind: "document", id: "doc-guide", title: "Guide", rootKind: "harness", relativePath: "guide.md", documentKind: "guide" },
      { operationId: "op-doc-1", actor: "project-manager" },
    );
    const before = protectedBytes(fixture.protectedPaths);
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-stage-preview"));
    const manifestHash = executionManifestHash(manifest);
    const epoch = manifest.epoch;

    const receipt = await applyExecutionMigration({
      ...migrationInput(fixture, "op-stage-apply"), coverage: await coverageOf(fixture, manifest),
      manifest,
      manifestHash,
      backup,
    });
    expect(receipt).toEqual({ manifestId: manifest.id, phase: "staged", replayed: false });

    // ── the recorded manifest, its reviewed hash and the staged phase
    const migrations = rawAll<{ manifest_id: string; manifest_hash: string; phase: string; manifest_json: string }>(
      fixture.dbPath,
      "select manifest_id, manifest_hash, phase, manifest_json from execution_migrations",
    );
    expect(migrations).toHaveLength(1);
    expect(migrations[0]!.manifest_id).toBe(manifest.id);
    expect(migrations[0]!.manifest_hash).toBe(manifestHash);
    expect(migrations[0]!.phase).toBe("staged");
    expect(JSON.parse(migrations[0]!.manifest_json) as ExecutionManifest).toEqual(manifest);

    // ── STAGED authority; the root revision advanced once; the epoch did not move
    expect(
      rawGet<Record<string, unknown>>(
        fixture.dbPath,
        "select authority_state, revision, root_updated_at, manifest_id from execution_meta where id = 1",
      ),
    ).toEqual({ authority_state: "staged", revision: 2, root_updated_at: ROOT_UPDATED_AT, manifest_id: manifest.id });
    expect(
      rawGet<{ authority_epoch: number }>(fixture.dbPath, "select authority_epoch from store_meta where id = 1")!.authority_epoch,
    ).toBe(epoch);

    // ── workflow headers: the snapshot minus the blocks their own tables own
    const headers = rawAll<{ workflow_id: string; revision: number; creator_session_id: string | null; state_json: string }>(
      fixture.dbPath,
      "select workflow_id, revision, creator_session_id, state_json from execution_workflows order by workflow_id",
    );
    expect(headers.map((row) => row.workflow_id)).toEqual([PRIMARY, SECONDARY].sort());
    expect(headers.every((row) => row.revision === 1)).toBe(true);
    const primaryHeader = headers.find((row) => row.workflow_id === PRIMARY)!;
    const header = JSON.parse(primaryHeader.state_json) as Record<string, unknown>;
    expect(header.id).toBe(PRIMARY);
    expect(header.plans).toBeUndefined();
    expect(header.coordination).toBeUndefined();
    expect(header.integration_merge_lease).toBeUndefined();
    expect(header.delivery_kind).toBe("development");
    expect(primaryHeader.creator_session_id).toBeNull();

    // ── registry entries are the root register's own entries, verbatim
    const registry = rawAll<{ entry_json: string }>(
      fixture.dbPath,
      "select entry_json from execution_registry order by rowid",
    );
    const rootDoc = JSON.parse(readFileSync(fixture.statusPath, "utf8")) as { workflows: unknown[] };
    expect(registry.map((row) => JSON.parse(row.entry_json))).toEqual(rootDoc.workflows);

    // ── plan rows: the row minus coordination/execution_lease, block minus revision/session
    const plans = rawAll<{ plan_id: string; ordinal: number; state_json: string; coordination_json: string }>(
      fixture.dbPath,
      `select plan_id, ordinal, state_json, coordination_json from execution_plans where workflow_id = '${PRIMARY}' order by ordinal`,
    );
    expect(plans.map((row) => row.plan_id)).toEqual([PLAN_A, PLAN_B]);
    const stateA = JSON.parse(plans[0]!.state_json) as Record<string, unknown>;
    expect(stateA.id).toBe(PLAN_A);
    expect(stateA.coordination).toBeUndefined();
    expect(stateA.execution_lease).toBeUndefined();
    expect(stateA.status).toBe("InProgress");
    const blockA = JSON.parse(plans[0]!.coordination_json) as Record<string, unknown>;
    expect(blockA.revision).toBeUndefined();
    expect(blockA.session).toBeUndefined();
    expect(blockA.handoff).toMatchObject({ state: "integrating", source_branch: `feature/${PLAN_A}` });
    expect(blockA.progress).toEqual({
      status: "InReview",
      summary: "integrating onto the iteration branch",
      evidence_paths: [join(fixture.harness, "sdd", PLAN_A, "qc.md")],
    });
    const blockB = JSON.parse(plans[1]!.coordination_json) as Record<string, unknown>;
    expect(blockB.revision).toBeUndefined();
    expect(blockB.session).toBeUndefined();
    expect((blockB.handoff as { state: string }).state).toBe("submitted");
    expect(blockB.progress).toEqual({
      status: "InReview",
      summary: "QC complete pending handoff",
      evidence_paths: [join(fixture.harness, "sdd", PLAN_B, "qc.md")],
    });

    // ── sealed frozen inputs: the unchanged selection, no pin
    const inputs = rawAll<{ plan_id: string; input_hash: string; catalog_pin_json: string | null }>(
      fixture.dbPath,
      `select plan_id, input_hash, catalog_pin_json from execution_inputs where workflow_id = '${PRIMARY}' order by plan_id`,
    );
    expect(inputs.map((row) => row.plan_id)).toEqual([PLAN_A, PLAN_B]);
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as { plans: Array<Record<string, unknown>> };
    for (const input of inputs) {
      const row = snapshot.plans.find((candidate) => candidate.id === input.plan_id)!;
      expect(input.input_hash).toBe(executionInputHash(row, input.plan_id));
      expect(input.catalog_pin_json).toBeNull();
    }

    // ── imported sessions are SUSPENDED with the recorded binding identity
    expect(
      rawAll<{ role: string; session_id: string; plan_id: string | null; state: string; epoch: number }>(
        fixture.dbPath,
        `select role, session_id, plan_id, state, epoch from execution_sessions where workflow_id = '${PRIMARY}' order by role, session_id`,
      ).map((row) => [row.role, row.session_id, row.plan_id, row.state, row.epoch]),
    ).toEqual([
      ["coordinator", COORDINATOR_SESSION, null, "suspended", epoch],
      ["plan-pm", PLAN_A_SESSION, PLAN_A, "suspended", epoch],
      ["plan-pm", PLAN_B_SESSION, PLAN_B, "suspended", epoch],
    ]);

    // ── held ownership is RETAINED: the lease still names its holder
    const leases = rawAll<{ plan_id: string; owner_epoch: number; revision: number; lease_json: string }>(
      fixture.dbPath,
      `select plan_id, owner_epoch, revision, lease_json from execution_leases where workflow_id = '${PRIMARY}'`,
    );
    expect(leases).toHaveLength(1);
    expect(leases[0]!.plan_id).toBe(PLAN_A);
    expect(leases[0]!.owner_epoch).toBe(epoch);
    expect(leases[0]!.revision).toBe(1);
    expect(JSON.parse(leases[0]!.lease_json) as Record<string, unknown>).toMatchObject({
      status: "held",
      holder_session_id: PLAN_A_SESSION,
      holder_role: "plan-pm",
      worktree_path: join(fixture.harness, "worktrees", PLAN_A),
      plan_worktree_path: join(fixture.harness, "worktrees", PLAN_A),
      plan_branch: `feature/${PLAN_A}`,
      base_sha: "a".repeat(40),
    });

    const mergeLeases = rawAll<{ owner_epoch: number; lease_json: string }>(
      fixture.dbPath,
      `select owner_epoch, lease_json from execution_integration_leases where workflow_id = '${PRIMARY}'`,
    );
    expect(mergeLeases).toHaveLength(1);
    expect(mergeLeases[0]!.owner_epoch).toBe(epoch);
    expect(JSON.parse(mergeLeases[0]!.lease_json)).toMatchObject({
      status: "held",
      plan_id: PLAN_A,
      holder: COORDINATOR_SESSION,
      source_branch: `feature/${PLAN_A}`,
      target_branch: INTEGRATION_BRANCH,
    });

    // ── the imported lifecycle keeps its OWN timestamps: the migration receipt
    // is the only thing stamped `now`, and the header carries the source
    // snapshot's validated `started_at` / `updated_at` verbatim.
    expect(
      rawGet<{ created_at: string; updated_at: string }>(
        fixture.dbPath,
        `select created_at, updated_at from execution_workflows where workflow_id = '${PRIMARY}'`,
      ),
    ).toEqual({ created_at: "2026-09-01", updated_at: "2026-09-02" });
    expect(
      rawGet<{ created_at: string; updated_at: string }>(
        fixture.dbPath,
        `select created_at, updated_at from execution_workflows where workflow_id = '${SECONDARY}'`,
      ),
    ).toEqual({ created_at: "2026-09-01", updated_at: "2026-09-02" });

    // ── sources, issue/catalog evidence and revisions survive untouched
    expect(protectedBytes(fixture.protectedPaths)).toEqual(before);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from issues")!.n).toBe(1);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from catalog_entities")!.n).toBe(1);
  });

  test("execution-stage-leaves-json-the-live-authority", async () => {
    const fixture = await legacyWorkspace("stage-json-live");
    await stageReviewed(fixture, "json-live");

    // Ordinary DB reads refuse: staged rows are not execution authority.
    await expect(readExecutionState(fixture.context)).rejects.toMatchObject({ code: "execution.not-active" });
    // The retired file route is still live: its write guard admits writes and
    // its readers still serve the snapshot.
    expect(() => assertExecutionFileWriteAllowed(fixture.context)).not.toThrow();
    expect(readWorkflowSnapshot(fixture.workflowDir).snapshot.id).toBe(PRIMARY);
    // A legacy root write still lands — JSON remains the sole live authority.
    setArtifactStore(createFsStore(fixture.harness));
    await registerWorkflow(fixture.statusPath, {
      id: PRIMARY,
      type: "plan",
      started_at: "2026-09-01",
      dir: "workflows/20260920-migration-primary",
    });
    const rootDoc = JSON.parse(readFileSync(fixture.statusPath, "utf8")) as { workflows: Array<{ id: string }> };
    expect(rootDoc.workflows.map((entry) => entry.id)).toEqual([PRIMARY]);
  });

  test("execution-stage-replay-is-idempotent", async () => {
    const fixture = await legacyWorkspace("stage-replay");
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-replay-preview"));
    const manifestHash = executionManifestHash(manifest);
    const first = await applyExecutionMigration({ ...migrationInput(fixture, "op-replay-apply"), coverage: await coverageOf(fixture, manifest), manifest, manifestHash, backup });
    const footprint = storeFootprint(fixture.dbPath);

    const second = await applyExecutionMigration({ ...migrationInput(fixture, "op-replay-apply-again"), coverage: await coverageOf(fixture, manifest), manifest, manifestHash, backup });
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ manifestId: manifest.id, phase: "staged", replayed: true });
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
  });

  test("execution-stage-refuses-source-drift-since-the-preview", async () => {
    const fixture = await legacyWorkspace("stage-drift");
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-drift-preview"));
    const footprint = storeFootprint(fixture.dbPath);
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot.updated_at = "2026-09-05";
    writeJson(fixture.snapshotPath, snapshot);

    const refusal = await refusalOf(async () =>
      applyExecutionMigration({
        ...migrationInput(fixture, "op-drift-apply"), coverage: await coverageOf(fixture, manifest),
        manifest,
        manifestHash: executionManifestHash(manifest),
        backup,
      }),
    );
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("no longer holds the reviewed bytes");
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
  });

  test("execution-stage-refuses-a-manifest-that-is-not-the-reviewed-pair", async () => {
    const fixture = await legacyWorkspace("stage-manifest-pair");
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-pair-preview"));
    const footprint = storeFootprint(fixture.dbPath);
    const refusal = await refusalOf(async () =>
      applyExecutionMigration({ ...migrationInput(fixture, "op-pair-apply"), coverage: await coverageOf(fixture, manifest), manifest, manifestHash: "0".repeat(64), backup }),
    );
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("does not hash to the reviewed value");
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
  });

  test("execution-stage-refuses-an-unverified-recovery-point", async () => {
    const fixture = await legacyWorkspace("stage-unverified-backup");
    const backup = await recoveryPoint(fixture);
    // The store moves after the point was recorded.
    await captureIssue(fixture.context, issueInput("Later finding"), { operationId: "op-later-issue", actor: "project-manager" });
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-unverified-preview"));
    const footprint = storeFootprint(fixture.dbPath);

    const reviewed = {
      storeId: manifest.storeId,
      epoch: manifest.epoch,
      schemaVersion: manifest.schemaVersion,
      catalogRevision: manifest.catalogRevision,
    };
    const stale = await refusalOf(async () =>
      applyExecutionMigration({
        ...migrationInput(fixture, "op-unverified-apply"), coverage: await coverageOf(fixture, manifest),
        manifest,
        manifestHash: executionManifestHash(manifest),
        backup,
      }),
    );
    expect(stale.code).toBe("store.activation-stale");
    expect(stale.message).toContain("no longer describes the live issue/catalog authority");
    // The verifier refuses a receipt that names another store, and one whose
    // claimed execution identity is not the bytes behind it.
    await expect(
      assertBackupDescribesStore(fixture.context, { ...backup, storeId: "00000000-0000-4000-8000-000000000000" }, reviewed),
    ).rejects.toMatchObject({ code: "store.activation-stale" });
    await expect(
      assertBackupDescribesStore(fixture.context, { ...backup, execution: null }, reviewed),
    ).rejects.toMatchObject({ code: "store.activation-stale" });
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
  });

  test("execution-stage-rolls-a-failed-import-back-whole", async () => {
    const fixture = await legacyWorkspace("stage-rollback", { secondWorkflow: true });
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-rollback-preview"));
    const footprint = storeFootprint(fixture.dbPath);

    await expect(
      withEnv({ MSTAR_STORE_FAIL_EXECUTION_IMPORT_AFTER: "1" }, async () =>
        applyExecutionMigration({
          ...migrationInput(fixture, "op-rollback-apply"), coverage: await coverageOf(fixture, manifest),
          manifest,
          manifestHash: executionManifestHash(manifest),
          backup,
        }),
      ),
    ).rejects.toThrow(/induced execution-import failure/);
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
    expect(
      rawGet<{ authority_state: string }>(fixture.dbPath, "select authority_state from execution_meta where id = 1")!.authority_state,
    ).toBe("legacy");
  });

  test("execution-stage-refuses-while-another-manifest-is-staged", async () => {
    const fixture = await legacyWorkspace("stage-second-manifest");
    const backup = await recoveryPoint(fixture);
    const first = await previewExecutionMigration(migrationInput(fixture, "op-second-preview-1"));
    await applyExecutionMigration({
      ...migrationInput(fixture, "op-second-apply-1"), coverage: await coverageOf(fixture, first),
      manifest: first,
      manifestHash: executionManifestHash(first),
      backup,
    });
    const second = await previewExecutionMigration(migrationInput(fixture, "op-second-preview-2"));
    const other: ExecutionManifest = { ...second, id: `${second.id}-other` };
    const refusal = await refusalOf(async () =>
      applyExecutionMigration({
        ...migrationInput(fixture, "op-second-apply-2"), coverage: await coverageOf(fixture, other),
        manifest: other,
        manifestHash: executionManifestHash(other),
        backup,
      }),
    );
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("already staged");
  });

  test("execution-stage-takes-maintenance-then-root-then-workflow-locks", async () => {
    const fixture = await legacyWorkspace("stage-lock-order");
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-locks-preview"));
    const footprint = storeFootprint(fixture.dbPath);
    const maintenanceLock = join(fixture.harness, ".execution-maintenance", ".status-write.lockdir");
    const rootLock = join(fixture.harness, ".status-write.lockdir");
    const workflowLock = join(fixture.workflowDir, ".status-write.lockdir");
    const apply = () =>
      withEnv({ MSTAR_EXECUTION_MIGRATION_LOCK_WAIT_MS: "120" }, async () =>
        applyExecutionMigration({
          ...migrationInput(fixture, "op-locks-apply"), coverage: await coverageOf(fixture, manifest),
          manifest,
          manifestHash: executionManifestHash(manifest),
          backup,
        }),
      );

    // The OUTER maintenance lock is taken first: while another holder owns it
    // the apply refuses before touching the store at all.
    mkdirSync(maintenanceLock, { recursive: true });
    try {
      await expect(apply()).rejects.toThrow(/already exists/);
      expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
    } finally {
      rmSync(maintenanceLock, { recursive: true, force: true });
    }

    // Then the root status lock, INSIDE the maintenance lock and before SQL: a
    // held root lock refuses the apply, the OUTER maintenance lock is provably
    // held while the apply waits for it, and it is released rather than leaked.
    mkdirSync(rootLock, { recursive: true });
    try {
      const waiting = apply();
      await sleep(40);
      expect(existsSync(maintenanceLock)).toBe(true);
      await expect(waiting).rejects.toThrow(/already exists/);
      expect(existsSync(maintenanceLock)).toBe(false);
      expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
    } finally {
      rmSync(rootLock, { recursive: true, force: true });
    }

    // Then each registered workflow's snapshot lock, still before the
    // transaction: both outer locks are held while it is contended.
    mkdirSync(workflowLock, { recursive: true });
    try {
      const waiting = apply();
      await sleep(40);
      expect(existsSync(maintenanceLock)).toBe(true);
      expect(existsSync(rootLock)).toBe(true);
      await expect(waiting).rejects.toThrow(/already exists/);
      expect(existsSync(rootLock)).toBe(false);
      expect(existsSync(maintenanceLock)).toBe(false);
      expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
    } finally {
      rmSync(workflowLock, { recursive: true, force: true });
    }

    // With the ladder free the same request stages, and every lock is released.
    const receipt = await apply();
    expect(receipt.phase).toBe("staged");
    expect(existsSync(maintenanceLock)).toBe(false);
    expect(existsSync(rootLock)).toBe(false);
    expect(existsSync(workflowLock)).toBe(false);
  });

  test("execution-stage-refuses-a-workflow-dir-outside-the-control-root", async () => {
    const fixture = await legacyWorkspace("stage-escape");
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-escape-preview"));
    const escaped = join(fixture.root, "outside-harness");
    writeText(join(escaped, WORKFLOW_SNAPSHOT_FILE), readFileSync(fixture.snapshotPath, "utf8"));
    const rootDoc = JSON.parse(readFileSync(fixture.statusPath, "utf8")) as { workflows: Array<{ dir: string }> };
    rootDoc.workflows[0]!.dir = join("..", "outside-harness");
    writeJson(fixture.statusPath, rootDoc);

    const refusal = await refusalOf(async () =>
      applyExecutionMigration({
        ...migrationInput(fixture, "op-escape-apply"), coverage: await coverageOf(fixture, manifest),
        manifest,
        manifestHash: executionManifestHash(manifest),
        backup,
      }),
    );
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("outside-harness");
    expect(existsSync(join(fixture.harness, ".execution-maintenance", ".status-write.lockdir"))).toBe(false);
  });

  test("execution-stage-stages-with-a-populated-deferred-surface", async () => {
    // §4.1 a populated surface is no longer "blocked by definition": the
    // manifest inventories it, the collector RECOMPUTES its receipt from the
    // retained bytes and staging persists that validated set. Staging still
    // claims nothing about activation readiness.
    const fixture = await legacyWorkspace("stage-deferred-surface");
    const ledger = join(fixture.workflowDir, "agent-flow.jsonl");
    const line = '{"v":1,"ts":1,"kind":"dispatch","role":"plan-pm","verdict":"ok","hard":false}';
    writeText(ledger, line);
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-deferred-preview"));
    expect(manifest.deferred.find((surface) => surface.surface === "workflow-agent-flow-ledger")).toMatchObject({
      disposition: "blocked",
      paths: [canonicalPath(ledger)],
    });
    const coverage = await coverageOf(fixture, manifest);
    const row = manifest.surfaces.find((surface) => surface.surface === "workflow-agent-flow-ledger");
    expect(row?.sources.map((witness) => witness.path)).toContain(`workflows/${PRIMARY}/agent-flow.jsonl`);
    const ledgerReceipt = coverage.receipts.find((receipt) => receipt.surface === "workflow-agent-flow-ledger");
    expect(ledgerReceipt).toMatchObject({ disposition: "retain", protocol: "agent-flow-v2", workflowId: PRIMARY });
    const receipt = await applyExecutionMigration({
      ...migrationInput(fixture, "op-deferred-apply"), coverage,
      manifest,
      manifestHash: executionManifestHash(manifest),
      backup,
    });
    expect(receipt.phase).toBe("staged");
    expect(readFileSync(ledger, "utf8")).toBe(`${line}\n`);
    // The validated set is what the staged record carries.
    expect(
      rawGet<{ coverage_json: string }>(fixture.dbPath, "select coverage_json from execution_migrations")!.coverage_json,
    ).toContain(coverage.digest);
  });

  test("execution-stage-refuses-a-handoff-without-its-plan-session", async () => {
    // §2.2/§D a handoff requires a bound plan session, on both transports: the
    // source snapshot refuses the block itself, and the import validates the
    // stored block with `sessionBound: plan.session !== null` — the DB reader's
    // own rule (`sessionRow !== undefined`) — so a plan whose handoff has no
    // session row to own it never stages.
    const fixture = await legacyWorkspace("stage-handoff-no-session");
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as {
      plans: Array<{ id: string; coordination: Record<string, unknown> }>;
    };
    delete snapshot.plans[1]!.coordination.session;
    writeJson(fixture.snapshotPath, snapshot);
    const footprint = storeFootprint(fixture.dbPath);

    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-handoff-preview")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("handoff requires a bound plan session");
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
    expect(
      rawGet<{ authority_state: string }>(fixture.dbPath, "select authority_state from execution_meta where id = 1")!.authority_state,
    ).toBe("legacy");
  });

  test("execution-stage-refuses-an-incoherent-integration-merge-lease", async () => {
    // §2.2/§3 only the workflow's coordinator claims its merge lease, and only
    // for the accepted attempt it is integrating, on that attempt's source
    // branch and the snapshot's own integration target. Each incoherent claim
    // below previews (its bytes are valid) and is refused by the import gate.
    const claimRefusalOf = async (label: string, mutate: (lease: Record<string, unknown>) => void) => {
      const fixture = await legacyWorkspace(`stage-merge-${label}`);
      const snapshot = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as {
        integration_merge_lease: Record<string, unknown>;
      };
      mutate(snapshot.integration_merge_lease);
      writeJson(fixture.snapshotPath, snapshot);
      const backup = await recoveryPoint(fixture);
      const manifest = await previewExecutionMigration(migrationInput(fixture, `op-merge-${label}-preview`));
      const footprint = storeFootprint(fixture.dbPath);
      const refusal = await refusalOf(async () =>
        applyExecutionMigration({
          ...migrationInput(fixture, `op-merge-${label}-apply`), coverage: await coverageOf(fixture, manifest),
          manifest,
          manifestHash: executionManifestHash(manifest),
          backup,
        }),
      );
      expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
      return refusal;
    };

    // A plan-pm holder: the file route's caller constructs the claim from the
    // COORDINATOR session, so a plan session never holds a workflow-wide claim.
    const holder = await claimRefusalOf("holder", (lease) => {
      lease.holder = PLAN_A_SESSION;
    });
    expect(holder.code).toBe("execution.migration-conflict");
    expect(holder.message).toContain("not the workflow's recorded coordinator");

    // A claim on a plan this workflow does not own.
    const foreign = await claimRefusalOf("foreign-plan", (lease) => {
      lease.plan_id = "20260920-migration-somewhere-else";
    });
    expect(foreign.code).toBe("execution.migration-conflict");
    expect(foreign.message).toContain("not a plan of this workflow");

    // A claim on a plan whose attempt is not being integrated.
    const unaccepted = await claimRefusalOf("unaccepted", (lease) => {
      lease.plan_id = PLAN_B;
    });
    expect(unaccepted.code).toBe("execution.migration-conflict");
    expect(unaccepted.message).toContain("recorded handoff is");

    // A claim for another attempt's source branch.
    const source = await claimRefusalOf("source", (lease) => {
      lease.source_branch = "feature/someone-elses-attempt";
    });
    expect(source.code).toBe("execution.migration-conflict");
    expect(source.message).toContain("a claim on another attempt");

    // A claim against a branch that is not this workflow's integration target.
    const target = await claimRefusalOf("target", (lease) => {
      lease.target_branch = "iteration/iter-other";
    });
    expect(target.code).toBe("execution.migration-conflict");
    expect(target.message).toContain("snapshot records integration target");
  });

  test("execution-stage-refuses-a-manifest-whose-coverage-was-edited", async () => {
    // §6/§2b the deferred coverage claim is revalidated under the locks against
    // the SAME manifest hash the caller hands back, so editing a blocked
    // surface to `absent` after review (and rehashing) cannot stage rows that
    // report false coverage to the activation barrier.
    const fixture = await legacyWorkspace("stage-coverage-edit");
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-coverage-preview"));
    const footprint = storeFootprint(fixture.dbPath);
    const edited: ExecutionManifest = {
      ...manifest,
      deferred: manifest.deferred.map((surface) =>
        surface.surface === "workflow-session-envelopes" ? { ...surface, paths: [], disposition: "absent" } : surface,
      ),
    };

    const refusal = await refusalOf(async () =>
      applyExecutionMigration({
        ...migrationInput(fixture, "op-coverage-apply"), coverage: await coverageOf(fixture, edited),
        manifest: edited,
        manifestHash: executionManifestHash(edited),
        backup,
      }),
    );
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("deferred-surface coverage changed");
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);

    // The pending-catalog witness half of the same revalidation.
    const second = await legacyWorkspace("stage-pending-claim-edit");
    const secondBackup = await recoveryPoint(second);
    const secondManifest = await previewExecutionMigration(migrationInput(second, "op-pending-claim-preview"));
    const secondFootprint = storeFootprint(second.dbPath);
    const claimed: ExecutionManifest = { ...secondManifest, pendingCatalogOperations: ["op-ghost"] };

    const secondRefusal = await refusalOf(async () =>
      applyExecutionMigration({
        ...migrationInput(second, "op-pending-claim-apply"), coverage: await coverageOf(second, claimed),
        manifest: claimed,
        manifestHash: executionManifestHash(claimed),
        backup: secondBackup,
      }),
    );
    expect(secondRefusal.code).toBe("execution.migration-conflict");
    expect(secondRefusal.message).toContain("pending catalog operation(s)");
    expect(storeFootprint(second.dbPath)).toEqual(secondFootprint);
  });

  test("execution-stage-refuses-the-live-store-as-its-recovery-point", async () => {
    // §8 "copying `store.db` bytes is not a backup": the gate's whole point is
    // an INDEPENDENT recovery copy, so the live database and its WAL/SHM
    // sidecars are refused as their own recovery point — even when the fields
    // they carry match the receipt, which for an unchanged store they do.
    const fixture = await legacyWorkspace("stage-live-recovery-point");
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-live-preview"));
    const reviewed = {
      storeId: manifest.storeId,
      epoch: manifest.epoch,
      schemaVersion: manifest.schemaVersion,
      catalogRevision: manifest.catalogRevision,
    };

    for (const suffix of ["", "-wal", "-shm"]) {
      const refusal = await refusalOf(async () =>
        assertBackupDescribesStore(fixture.context, { ...backup, backupPath: `${fixture.dbPath}${suffix}` }, reviewed),
      );
      expect(refusal.code, suffix).toBe("store.activation-stale");
      expect(refusal.message, suffix).toContain("names the live store database");
    }
    // The independent copy itself still verifies: the gate gained a refusal,
    // not a different rule.
    await expect(assertBackupDescribesStore(fixture.context, backup, reviewed)).resolves.toBeUndefined();
  });

  test("execution-stage-stamps-only-its-own-receipt-with-the-apply-clock", async () => {
    // §6 timestamps: the imported lifecycle's own history is preserved, and
    // `now` is the MIGRATION's bookkeeping only.
    const fixture = await legacyWorkspace("stage-import-clock");
    await stageReviewed(fixture, "import-clock");

    const migration = rawGet<{ created_at: string; updated_at: string }>(
      fixture.dbPath,
      "select created_at, updated_at from execution_migrations",
    )!;
    expect(migration.created_at).not.toBe("2026-09-01");
    expect(migration.updated_at).not.toBe("2026-09-02");
    expect(Number.isNaN(Date.parse(migration.created_at))).toBe(false);
    expect(
      rawGet<{ created_at: string; updated_at: string }>(
        fixture.dbPath,
        `select created_at, updated_at from execution_workflows where workflow_id = '${PRIMARY}'`,
      ),
    ).toEqual({ created_at: "2026-09-01", updated_at: "2026-09-02" });
  });

  test("execution-stage-source-witnesses-are-canonically-ordered", async () => {
    // §6 the manifest is content-addressed and compared by index, so the source
    // inventory must not depend on the order a directory was written in: the
    // same workspace content read back in any creation order is the same
    // manifest, and the unreferenced session surface reads back sorted.
    const build = async (label: string, reverse: boolean) => {
      const fixture = await legacyWorkspace(`stage-witness-order-${label}`);
      const unreferenced = ["plan-pm-legacy-a.json", "plan-pm-legacy-z.json"];
      for (const file of reverse ? [...unreferenced].reverse() : unreferenced) {
        writeJson(join(fixture.sessionsDir, file), envelopeOf("plan-pm", `host-${file}`, fixture.workflowId, fixture.harness, PLAN_A));
      }
      writeText(join(fixture.workflowDir, "notes.jsonl"), '{"kind":"note","ts":1,"text":"legacy note"}');
      const manifest = await previewExecutionMigration(migrationInput(fixture, `op-order-${label}`));
      const root = canonicalPath(fixture.root);
      const rel = (path: string) => relative(root, path);
      return {
        witnesses: manifest.sources.map((witness) => `${witness.kind} ${rel(witness.path)}`),
        coverage: manifest.deferred.map(
          (surface) => `${surface.surface} ${surface.disposition} ${surface.paths.map(rel).join(",")}`,
        ),
      };
    };

    const forward = await build("forward", false);
    const backward = await build("backward", true);
    expect(backward.witnesses).toEqual(forward.witnesses);
    expect(backward.coverage).toEqual(forward.coverage);
    const deferredWitnesses = forward.witnesses.filter((entry) => entry.startsWith("deferred "));
    expect(deferredWitnesses.length).toBeGreaterThan(0);
    expect(deferredWitnesses).toEqual([...deferredWitnesses].sort());
    // §4.1 an UNREFERENCED envelope is a source of the workflow's session
    // surface, enumerated in canonical order — it is never an unclassified
    // stranger, and the same content in any creation order reads back identically.
    const unreferenced = forward.witnesses
      .filter((entry) => entry.startsWith("session-envelope "))
      .map((entry) => entry.slice("session-envelope ".length))
      .filter((path) => path.includes("plan-pm-legacy"));
    expect(unreferenced.length).toBe(2);
    expect(unreferenced).toEqual([...unreferenced].sort());
  });

  test("execution-stage-writes-rows-the-db-reader-accepts", async () => {
    // The staged rows are exactly what the DB reader will accept once an
    // activation commits: no second authority in the header, no credential
    // path in the DB, and the file route untouched.
    const fixture = await legacyWorkspace("stage-reader-shape");
    await stageReviewed(fixture, "reader-shape");
    const header = JSON.parse(
      rawGet<{ state_json: string }>(fixture.dbPath, `select state_json from execution_workflows where workflow_id = '${PRIMARY}'`)!
        .state_json,
    ) as Record<string, unknown>;
    expect(header.coordinator_session).toBeUndefined();
    expect(header.coordination).toBeUndefined();
    expect(JSON.stringify(header)).not.toContain("session_file");
    expect(
      rawAll<{ state: string }>(fixture.dbPath, `select state from execution_sessions where workflow_id = '${PRIMARY}'`).every(
        (row) => row.state === "suspended",
      ),
    ).toBe(true);
    const served = readWorkflowSnapshot(fixture.workflowDir).snapshot as WorkflowSnapshot & { coordination?: unknown };
    expect(served.coordination).toMatchObject({ coordinator: { session_id: COORDINATOR_SESSION } });
  });
});

// ---------------------------------------------------------------------------
// Activation (§6 item 3)
// ---------------------------------------------------------------------------

describe("execution-activation", () => {
  test("execution-activation-core-fixture-activates-only-behind-the-barrier", async () => {
    const fixture = await coreWorkspace("activate-core", { workflows: 2 });
    await captureIssue(fixture.context, issueInput("Pre-activation finding"), {
      operationId: "op-activation-issue",
      actor: "project-manager",
    });
    await registerCatalogEntity(
      fixture.context,
      { kind: "document", id: "doc-activation", title: "Guide", rootKind: "harness", relativePath: "guide.md", documentKind: "guide" },
      { operationId: "op-activation-doc", actor: "project-manager" },
    );
    const protectedPaths = [fixture.statusPath, ...fixture.snapshotPaths];
    const before = protectedBytes(protectedPaths);
    const manifest = await stageCore(fixture, "core");
    // The stages really are separate: `apply` left the JSON route live and the
    // staged rows unreadable, so nothing before the barrier was activation.
    expect(manifest.deferred.every((surface) => surface.disposition === "absent")).toBe(true);
    expect(executionMetaOf(fixture.dbPath).authority_state).toBe("staged");
    await expect(readExecutionState(fixture.context)).rejects.toMatchObject({ code: "execution.not-active" });
    expect(() => assertExecutionFileWriteAllowed(fixture.context)).not.toThrow();
    const prepared = authorityOf(fixture.dbPath);
    expect(prepared.authority_epoch).toBe(manifest.epoch);

    const receipt = await activateExecutionMigration(await activationInput(fixture, manifest, "core"));
    expect(receipt).toEqual({ manifestId: manifest.id, phase: "active", replayed: false });

    // ── the cutover: authority active, ONE epoch advance, ONE root revision
    expect(executionMetaOf(fixture.dbPath)).toMatchObject({
      authority_state: "active",
      revision: 3,
      manifest_id: manifest.id,
    });
    expect(executionMetaOf(fixture.dbPath).activated_at).not.toBeNull();
    const activated = authorityOf(fixture.dbPath);
    expect(activated.authority_epoch).toBe(prepared.authority_epoch + 1);
    expect(activated.revision).toBe(prepared.revision + 1);
    expect(migrationPhaseOf(fixture.dbPath)).toBe("active");

    // ── the recorded receipt names what is left to do (residual R13)
    const recorded = JSON.parse(
      rawGet<{ activation_receipt_json: string }>(fixture.dbPath, "select activation_receipt_json from execution_migrations")!
        .activation_receipt_json,
    ) as Record<string, unknown>;
    expect(recorded).toMatchObject({ previousEpoch: manifest.epoch, epoch: manifest.epoch + 1, storeId: manifest.storeId });
    expect(recorded.revokedSessions).toEqual([]);
    expect(String(recorded.requiredReconciliation)).toContain("recoverExecutionCoordinator");
    expect(String(recorded.requiredReconciliation)).toContain("bindExecutionSession");

    // ── the migrated graph is readable through the ordinary reader, and its
    // old references are stale: the epoch moved for every handle.
    const state = await readExecutionState(fixture.context);
    expect(state.epoch).toBe(manifest.epoch + 1);
    expect(state.data.workflows.map((workflow) => workflow.state.id).sort()).toEqual([...fixture.workflowIds].sort());
    expect(state.data.workflows.every((workflow) => workflow.coordinator === null)).toBe(true);

    // ── activation moved no byte and returned nothing to JSON
    expect(protectedBytes(protectedPaths)).toEqual(before);
    expect(syncRefusalOf(() => assertExecutionFileWriteAllowed(fixture.context)).code).toBe("execution.direct-write-refused");
    expect(protectedBytes(protectedPaths)).toEqual(before);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from issues")!.n).toBe(1);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from catalog_entities")!.n).toBe(1);
  });

  test("execution-activation-refuses-a-coverage-digest-this-workspace-does-not-recompute", async () => {
    // §4.1 the barrier recomputes every receipt from the named bytes: a digest
    // the workspace does not recompute — forged, drifted or taken from another
    // discovery — refuses with zero authority switch. There is no
    // allow-incomplete flag and no operator acknowledgement that substitutes for
    // bytes.
    const fixture = await legacyWorkspace("activate-deferred");
    const manifest = await stageCore(fixture, "deferred");
    const footprint = storeFootprint(fixture.dbPath);
    // A populated surface is VALIDATED coverage, not a block: the reviewed set
    // carries the envelope surface this fixture really holds.
    const coverage = await coverageOf(fixture, manifest);
    expect(coverage.receipts.find((receipt) => receipt.surface === "workflow-session-envelopes")).toMatchObject({
      disposition: "migrate",
      protocol: "session-v1",
      workflowId: PRIMARY,
    });
    expect(coverage.receipts.length).toBe(manifest.surfaces.length);

    const refusal = await refusalOf(async () =>
      activateExecutionMigration({
        ...(await activationInput(fixture, manifest, "deferred")),
        coverageDigest: "0".repeat(64),
      }),
    );
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("coverage recomputed from this workspace");
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
    expect(authorityOf(fixture.dbPath).authority_epoch).toBe(manifest.epoch);
    expect(migrationPhaseOf(fixture.dbPath)).toBe("staged");
    // JSON still owns execution, so the staged workspace is still recoverable by
    // the ordinary file route.
    expect(() => assertExecutionFileWriteAllowed(fixture.context)).not.toThrow();
    expect(readWorkflowSnapshot(fixture.workflowDir).snapshot.id).toBe(PRIMARY);
  });

  test("execution-activation-refuses-source-drift", async () => {
    const fixture = await coreWorkspace("activate-drift");
    const manifest = await stageCore(fixture, "drift");
    const footprint = storeFootprint(fixture.dbPath);
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPaths[0]!, "utf8")) as Record<string, unknown>;
    snapshot.updated_at = "2026-09-05";
    writeJson(fixture.snapshotPaths[0]!, snapshot);

    const refusal = await refusalOf(async () => activateExecutionMigration(await activationInput(fixture, manifest, "drift")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("no longer holds the reviewed bytes");
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
    expect(migrationPhaseOf(fixture.dbPath)).toBe("staged");
  });

  test("execution-activation-refuses-an-attestation-the-inventory-cannot-justify", async () => {
    const fixture = await coreWorkspace("activate-attestation");
    const manifest = await stageCore(fixture, "attestation");
    const footprint = storeFootprint(fixture.dbPath);

    // An unknown stopped owner is a claim the frozen inventory does not contain.
    const ghost = await refusalOf(async () =>
      activateExecutionMigration(
        await activationInput(fixture, manifest, "ghost", migrationAttestation([{ sessionId: "sess-ghost", host: "omp", state: "stopped" }])),
      ),
    );
    expect(ghost.code).toBe("execution.coverage-incomplete");
    expect(ghost.message).toContain("does not");

    // An inventory of pure exclusions attests that nobody runs this build.
    const excluded = migrationAttestation();
    excluded.consumers = excluded.consumers.map((consumer) => ({
      ...consumer,
      disposition: consumer.current ? ("excluded:no-store-access" as const) : ("excluded:superseded-binary" as const),
    }));
    const noneAdopted = await refusalOf(async () =>
      activateExecutionMigration(await activationInput(fixture, manifest, "excluded", excluded)),
    );
    expect(noneAdopted.code).toBe("execution.coverage-incomplete");
    expect(noneAdopted.message).toContain("none adopted this build");

    // The operator who reviewed the manifest attests the barrier.
    const otherOperator = migrationAttestation();
    otherOperator.operator = { actor: "someone-else", authorizationRef: "D29" };
    const wrongOperator = await refusalOf(async () =>
      activateExecutionMigration(await activationInput(fixture, manifest, "operator", otherOperator)),
    );
    expect(wrongOperator.code).toBe("store.attestation-invalid");
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
  });

  test("execution-activation-reaches-the-owner-gate-behind-validated-coverage", async () => {
    // With §4.1 coverage the barrier no longer stops at a populated surface, so
    // the frozen-owner gate is REACHABLE: an attestation that names no owner is
    // refused for the owners the import would revoke, with the owner inventory
    // provably non-empty.
    const fixture = await legacyWorkspace("activate-owner-closure");
    const manifest = await stageCore(fixture, "owner-closure");
    const footprint = storeFootprint(fixture.dbPath);

    // The frozen manifest does carry owner-bearing sources: every referenced
    // envelope is a witness, so this fixture's owner set is not empty…
    expect(manifest.sources.filter((witness) => witness.kind === "session-envelope").length).toBeGreaterThan(0);
    // …and the very same pass records that surface as populated coverage.
    expect(manifest.deferred.find((surface) => surface.surface === "workflow-session-envelopes")?.paths.length).toBeGreaterThan(0);

    const omission = await refusalOf(async () => activateExecutionMigration(await activationInput(fixture, manifest, "owner-closure")));
    expect(omission.code).toBe("execution.coverage-incomplete");
    expect(omission.message).toContain("does not name");
    expect(omission.message).toContain("stopped/reloaded");
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
    expect(migrationPhaseOf(fixture.dbPath)).toBe("staged");
    expect(authorityOf(fixture.dbPath).authority_epoch).toBe(manifest.epoch);
  });

  test("execution-activation-crash-before-the-commit-leaves-legacy-authority", async () => {
    const fixture = await coreWorkspace("activate-crash");
    const manifest = await stageCore(fixture, "crash");
    const staged = storeFootprint(fixture.dbPath);
    const epoch = authorityOf(fixture.dbPath).authority_epoch;

    const crash = withEnv({ MSTAR_STORE_FAIL_EXECUTION_ACTIVATION: "before-commit" }, async () =>
      activateExecutionMigration(await activationInput(fixture, manifest, "crash")),
    );
    await expect(crash).rejects.toThrow(/induced execution-migration failure/);
    // Exactly the staged authority: no partial activation, no epoch move, no
    // receipt, and the JSON route still the live one.
    expect(storeFootprint(fixture.dbPath)).toEqual(staged);
    expect(authorityOf(fixture.dbPath).authority_epoch).toBe(epoch);
    expect(migrationPhaseOf(fixture.dbPath)).toBe("staged");
    expect(executionMetaOf(fixture.dbPath).activated_at).toBeNull();
    await expect(readExecutionState(fixture.context)).rejects.toMatchObject({ code: "execution.not-active" });
    expect(() => assertExecutionFileWriteAllowed(fixture.context)).not.toThrow();

    // The retry resolves the same unknown-commit question once, and once only.
    const receipt = await activateExecutionMigration(await activationInput(fixture, manifest, "after-crash"));
    expect(receipt).toEqual({ manifestId: manifest.id, phase: "active", replayed: false });
    expect(authorityOf(fixture.dbPath).authority_epoch).toBe(epoch + 1);
  });

  test("execution-activation-replays-and-never-double-bumps-the-epoch", async () => {
    const fixture = await coreWorkspace("activate-replay");
    const manifest = await stageCore(fixture, "replay");
    await activateExecutionMigration(await activationInput(fixture, manifest, "first"));
    const activated = storeFootprint(fixture.dbPath);

    const replay = await activateExecutionMigration(await activationInput(fixture, manifest, "second"));
    expect(replay).toEqual({ manifestId: manifest.id, phase: "active", replayed: true });
    expect(storeFootprint(fixture.dbPath)).toEqual(activated);

    // A different attestation cannot re-activate an immutable history.
    const other = migrationAttestation();
    other.attestedAt = "2026-09-21T01:00:00.000Z";
    const refusal = await refusalOf(async () => activateExecutionMigration(await activationInput(fixture, manifest, "other", other)));
    expect(refusal.message).toContain("different attestation");
    expect(storeFootprint(fixture.dbPath)).toEqual(activated);

    // No JSON rollback: the file route stays fenced and the DB stays live.
    expect(syncRefusalOf(() => assertExecutionFileWriteAllowed(fixture.context)).code).toBe("execution.direct-write-refused");
    await expect(readExecutionState(fixture.context)).resolves.toBeDefined();
    expect(storeFootprint(fixture.dbPath)).toEqual(activated);
  });

  test("execution-activation-refuses-a-staged-graph-edited-since-the-import", async () => {
    // §6 item 3 "recheck ... every identity/pin", through the migration diagnostic
    // path: the staged rows are re-read and compared with the reviewed import, so
    // an out-of-band write to store.db (raw SQL is outside this engine's
    // authorization boundary, §2.3) can never be activated as if it were reviewed.
    const fixture = await coreWorkspace("activate-tampered");
    const manifest = await stageCore(fixture, "tampered");
    rawRun(fixture.dbPath, "update execution_inputs set input_hash = ? where workflow_id = ?", "f".repeat(64), CORE_A);
    const footprint = storeFootprint(fixture.dbPath);

    const refusal = await refusalOf(async () => activateExecutionMigration(await activationInput(fixture, manifest, "tampered")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("sealed inputs are not the reviewed import");
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
    expect(migrationPhaseOf(fixture.dbPath)).toBe("staged");
  });

  test("execution-activation-refuses-a-stale-epoch-witness", async () => {
    const fixture = await coreWorkspace("activate-stale");
    const manifest = await stageCore(fixture, "stale");
    const staged = storeFootprint(fixture.dbPath);

    const refusal = await refusalOf(async () =>
      activateExecutionMigration({
        ...migrationInput(fixture, "op-activate-stale"),
        manifestId: manifest.id,
        manifestHash: executionManifestHash(manifest),
        expectedEpoch: manifest.epoch + 1,
        attestation: migrationAttestation(),
        coverageDigest: await coverageDigestOf(fixture, manifest),
      }),
    );
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("CAS on the store epoch");
    expect(storeFootprint(fixture.dbPath)).toEqual(staged);
  });
});

// ---------------------------------------------------------------------------
// Retirement (§6 item 4)
// ---------------------------------------------------------------------------

describe("execution-retirement", () => {
  test("execution-retirement-moves-exactly-the-core-sources", async () => {
    const fixture = await coreWorkspace("retire-core", { workflows: 2 });
    const manifest = await stageCore(fixture, "retire");
    await activateExecutionMigration(await activationInput(fixture, manifest, "retire"));

    // Deferred 2b files that appear AFTER activation: retirement must move the
    // core sources and leave every one of them exactly where it is.
    const notesPath = join(fixture.workflowDirs[0]!, "notes.jsonl");
    const lateEnvelope = join(fixture.workflowDirs[0]!, "sessions", "plan-pm-late.json");
    const engineStatus = join(fixture.harness, "snapshots", "engine-status.json");
    writeText(notesPath, '{"note":"post-activation ledger"}');
    writeText(lateEnvelope, JSON.stringify({ schema_version: 1, role: "plan-pm", session_id: "late-1" }));
    writeJson(engineStatus, { generation: 7 });
    const deferred = [notesPath, lateEnvelope, engineStatus];
    const before = treeInventory(fixture.harness);
    const epoch = authorityOf(fixture.dbPath).authority_epoch;
    const archiveDir = join(fixture.harness, "archived", "execution", manifest.id);
    const moved = new Set(["status.json", ...fixture.workflowIds.map((id) => `workflows/${id}/${WORKFLOW_SNAPSHOT_FILE}`)]);

    const receipt = await retireExecutionSources(retirementInput(fixture, manifest, "core"));
    expect(receipt).toEqual({ manifestId: manifest.id, phase: "retired", replayed: false });

    // The exact root/snapshot files are in manifest-addressed history…
    expect(existsSync(fixture.statusPath)).toBe(false);
    expect(existsSync(join(archiveDir, "status.json"))).toBe(true);
    for (const [index, snapshotPath] of fixture.snapshotPaths.entries()) {
      expect(existsSync(snapshotPath)).toBe(false);
      expect(existsSync(join(archiveDir, "workflows", fixture.workflowIds[index]!, WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    }
    // …and nothing else moved: every remaining byte is identical, deferred files included.
    const after = nonStoreFiles(treeInventory(fixture.harness));
    const expectedRemaining = Object.fromEntries(
      Object.entries(nonStoreFiles(before)).filter(([path]) => !moved.has(path)),
    );
    expect(after).toEqual(expectedRemaining);
    for (const path of deferred) expect(existsSync(path)).toBe(true);

    // The DB records the retirement and the authority is untouched: retirement
    // is not a rollback, and it never returns the store to JSON.
    expect(migrationPhaseOf(fixture.dbPath)).toBe("retired");
    const retirement = JSON.parse(
      rawGet<{ retirement_json: string }>(fixture.dbPath, "select retirement_json from execution_migrations")!.retirement_json,
    ) as { items: Array<{ relativePath: string }>; archiveDir: string };
    expect(canonicalPath(retirement.archiveDir)).toBe(canonicalPath(archiveDir));
    expect(retirement.items.map((item) => item.relativePath).sort()).toEqual([...moved].sort());
    expect(executionMetaOf(fixture.dbPath)).toMatchObject({ authority_state: "active", manifest_id: manifest.id });
    expect(authorityOf(fixture.dbPath).authority_epoch).toBe(epoch);
    await expect(readExecutionState(fixture.context)).resolves.toBeDefined();

    // An interrupted-then-finished retirement replays as recorded, changing nothing.
    const replay = await retireExecutionSources(retirementInput(fixture, manifest, "again"));
    expect(replay).toEqual({ manifestId: manifest.id, phase: "retired", replayed: true });
    expect(nonStoreFiles(treeInventory(fixture.harness))).toEqual(after);
  });

  test("execution-retirement-refuses-a-source-written-since-the-receipt", async () => {
    const fixture = await coreWorkspace("retire-drift");
    const manifest = await stageCore(fixture, "retire-drift");
    await activateExecutionMigration(await activationInput(fixture, manifest, "retire-drift"));
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPaths[0]!, "utf8")) as Record<string, unknown>;
    snapshot.updated_at = "2026-09-09";
    writeJson(fixture.snapshotPaths[0]!, snapshot);

    const refusal = await refusalOf(async () => retireExecutionSources(retirementInput(fixture, manifest, "drift")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("no longer holds the reviewed bytes");
    // The pre-pass verifies every source BEFORE the first rename, so a changed
    // source refuses with the live tree completely untouched.
    expect(existsSync(fixture.statusPath)).toBe(true);
    expect(existsSync(fixture.snapshotPaths[0]!)).toBe(true);
    expect(existsSync(join(fixture.harness, "archived", "execution", manifest.id, "status.json"))).toBe(false);
    expect(migrationPhaseOf(fixture.dbPath)).toBe("active");
  });

  test("execution-retirement-resumes-from-the-destination-hash", async () => {
    const fixture = await coreWorkspace("retire-resume", { workflows: 1 });
    const manifest = await stageCore(fixture, "retire-resume");
    await activateExecutionMigration(await activationInput(fixture, manifest, "retire-resume"));
    const archiveDir = join(fixture.harness, "archived", "execution", manifest.id);
    const archivedRoot = join(archiveDir, "status.json");

    // Crash right after the first rename and BEFORE its progress was recorded:
    // the archive is the only witness, and the ledger does not exist yet.
    const crash = withEnv({ MSTAR_STORE_FAIL_EXECUTION_RETIREMENT: "after-rename" }, () =>
      retireExecutionSources(retirementInput(fixture, manifest, "crash")),
    );
    await expect(crash).rejects.toThrow(/induced execution-migration failure/);
    expect(existsSync(fixture.statusPath)).toBe(false);
    expect(existsSync(archivedRoot)).toBe(true);
    expect(sha256OfBytes(readFileSync(archivedRoot))).toBe(
      manifest.sources.find((witness) => witness.kind === "root")!.sha256,
    );
    expect(existsSync(fixture.snapshotPaths[0]!)).toBe(true);
    expect(existsSync(join(archiveDir, "retirement.json"))).toBe(false);
    expect(migrationPhaseOf(fixture.dbPath)).toBe("active");

    // The resume reads the exact destination hash, finishes the set and records
    // the receipt without a second epoch bump or any returned authority.
    const epoch = authorityOf(fixture.dbPath).authority_epoch;
    const receipt = await retireExecutionSources(retirementInput(fixture, manifest, "resume"));
    expect(receipt).toEqual({ manifestId: manifest.id, phase: "retired", replayed: false });
    expect(existsSync(fixture.snapshotPaths[0]!)).toBe(false);
    expect(existsSync(join(archiveDir, "workflows", fixture.workflowIds[0]!, WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    expect(authorityOf(fixture.dbPath).authority_epoch).toBe(epoch);
    expect(executionMetaOf(fixture.dbPath).authority_state).toBe("active");
  });

  test("execution-retirement-refuses-a-ledger-that-redirects-an-archive-destination", async () => {
    const fixture = await coreWorkspace("retire-ledger-redirect");
    const manifest = await stageCore(fixture, "retire-ledger-redirect");
    await activateExecutionMigration(await activationInput(fixture, manifest, "retire-ledger-redirect"));
    const archiveDir = join(fixture.harness, "archived", "execution", manifest.id);
    const ledgerPath = join(archiveDir, "retirement.json");

    // Crash right after the root register's rename: the archive holds the root
    // register, the ledger does not exist yet, and the snapshot is still live.
    const crash = withEnv({ MSTAR_STORE_FAIL_EXECUTION_RETIREMENT: "after-rename" }, () =>
      retireExecutionSources(retirementInput(fixture, manifest, "redirect-crash")),
    );
    await expect(crash).rejects.toThrow(/induced execution-migration failure/);
    expect(existsSync(fixture.statusPath)).toBe(false);
    expect(existsSync(fixture.snapshotPaths[0]!)).toBe(true);
    expect(existsSync(ledgerPath)).toBe(false);

    const rootWitness = manifest.sources.find((witness) => witness.kind === "root")!;
    const workflowWitness = manifest.sources.find((witness) => witness.kind === "workflow")!;
    /**
     * The ledger an operator (or a corrupted write) can leave behind: the source
     * paths and the reviewed hashes are INTACT — the resume used to trust exactly
     * that pair — and only the destination of the not-yet-moved snapshot is
     * redirected out of the manifest-addressed archive.
     */
    const ledgerWith = (tamper: Record<string, unknown>): Record<string, unknown> => ({
      version: 1,
      manifestId: manifest.id,
      manifestHash: executionManifestHash(manifest),
      storeId: manifest.storeId,
      epoch: manifest.epoch,
      archiveDir,
      startedAt: TS,
      updatedAt: TS,
      items: [
        {
          kind: "root",
          path: rootWitness.path,
          relativePath: "status.json",
          archivePath: join(archiveDir, "status.json"),
          sha256: rootWitness.sha256,
          state: "moved",
        },
        {
          kind: "workflow",
          path: workflowWitness.path,
          relativePath: `workflows/${fixture.workflowIds[0]}/${WORKFLOW_SNAPSHOT_FILE}`,
          archivePath: join(archiveDir, "workflows", fixture.workflowIds[0]!, WORKFLOW_SNAPSHOT_FILE),
          sha256: workflowWitness.sha256,
          state: "pending",
          ...tamper,
        },
      ],
    });

    const destinations = [
      // An absolute destination outside the control root…
      join(fixture.root, "escaped-snapshot.json"),
      // …and the same escape spelled as traversal inside the harness.
      `${archiveDir}/../../../escaped-snapshot.json`,
    ];
    for (const [index, destination] of destinations.entries()) {
      writeJson(ledgerPath, ledgerWith({ archivePath: destination }));
      const refusal = await refusalOf(async () => retireExecutionSources(retirementInput(fixture, manifest, `redirect-${index}`)));
      expect(refusal.code).toBe("execution.migration-conflict");
      expect(refusal.message).toContain("archive destination");
      // Nothing moved: the redirected destination was never created, the
      // snapshot is still the live source and the root register was not restored.
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(fixture.snapshotPaths[0]!)).toBe(true);
      expect(existsSync(fixture.statusPath)).toBe(false);
      expect(migrationPhaseOf(fixture.dbPath)).toBe("active");
      expect(executionMetaOf(fixture.dbPath).authority_state).toBe("active");
    }
  });

  test("execution-retirement-refuses-a-ledger-that-rewrites-an-addressed-field", async () => {
    const fixture = await coreWorkspace("retire-ledger-fields");
    const manifest = await stageCore(fixture, "retire-ledger-fields");
    await activateExecutionMigration(await activationInput(fixture, manifest, "retire-ledger-fields"));
    const archiveDir = join(fixture.harness, "archived", "execution", manifest.id);
    const ledgerPath = join(archiveDir, "retirement.json");

    const crash = withEnv({ MSTAR_STORE_FAIL_EXECUTION_RETIREMENT: "after-rename" }, () =>
      retireExecutionSources(retirementInput(fixture, manifest, "fields-crash")),
    );
    await expect(crash).rejects.toThrow(/induced execution-migration failure/);

    const rootWitness = manifest.sources.find((witness) => witness.kind === "root")!;
    const workflowWitness = manifest.sources.find((witness) => witness.kind === "workflow")!;
    const ledgerWith = (tamper: Record<string, unknown>): Record<string, unknown> => ({
      version: 1,
      manifestId: manifest.id,
      manifestHash: executionManifestHash(manifest),
      storeId: manifest.storeId,
      epoch: manifest.epoch,
      archiveDir,
      startedAt: TS,
      updatedAt: TS,
      items: [
        {
          kind: "root",
          path: rootWitness.path,
          relativePath: "status.json",
          archivePath: join(archiveDir, "status.json"),
          sha256: rootWitness.sha256,
          state: "moved",
        },
        {
          kind: "workflow",
          path: workflowWitness.path,
          relativePath: `workflows/${fixture.workflowIds[0]}/${WORKFLOW_SNAPSHOT_FILE}`,
          archivePath: join(archiveDir, "workflows", fixture.workflowIds[0]!, WORKFLOW_SNAPSHOT_FILE),
          sha256: workflowWitness.sha256,
          state: "pending",
          ...tamper,
        },
      ],
    });

    // Every addressed field of one item, rewritten one at a time: the resume may
    // only contribute per-item progress, so a changed kind, path, relativePath,
    // hash or an open state is a claim this manifest cannot reconcile.
    const variants: Array<{ what: string; tamper: Record<string, unknown>; names: string }> = [
      { what: "an unknown item state", tamper: { state: "running" }, names: "in state" },
      { what: "a rewritten item kind", tamper: { kind: "deferred" }, names: "with kind" },
      { what: "a rewritten relativePath", tamper: { relativePath: "workflows/elsewhere/snapshot.json" }, names: "relativePath" },
      { what: "a rewritten source path", tamper: { path: join(fixture.harness, "elsewhere.json") }, names: "at source path" },
      { what: "a rewritten sha256", tamper: { sha256: "0".repeat(64) }, names: "with sha256" },
    ];
    for (const [index, variant] of variants.entries()) {
      writeJson(ledgerPath, ledgerWith(variant.tamper));
      const refusal = await refusalOf(async () =>
        retireExecutionSources(retirementInput(fixture, manifest, `fields-${index}`)),
      );
      expect(refusal.code).toBe("execution.migration-conflict");
      // The refusal names the LEDGER, not a source that is in fact untouched.
      expect(refusal.message).toContain("refusing to resume against it");
      expect(refusal.message).toContain(variant.names);
      expect(existsSync(fixture.snapshotPaths[0]!)).toBe(true);
      expect(migrationPhaseOf(fixture.dbPath)).toBe("active");
    }
  });

  test("execution-retirement-refuses-a-symlinked-archive-destination-before-any-rename", async () => {
    const fixture = await coreWorkspace("retire-archive-symlink");
    const manifest = await stageCore(fixture, "retire-archive-symlink");
    await activateExecutionMigration(await activationInput(fixture, manifest, "retire-archive-symlink"));
    const archiveDir = join(fixture.harness, "archived", "execution", manifest.id);
    const escaped = join(fixture.root, "escaped-archive");
    mkdirSync(escaped, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });

    // A destination directory that is a LINK out of the archive: the canonical
    // destination of the snapshot is then outside the manifest-addressed history.
    symlinkSync(escaped, join(archiveDir, "workflows"));
    const outward = await refusalOf(async () => retireExecutionSources(retirementInput(fixture, manifest, "symlink-out")));
    expect(outward.code).toBe("execution.migration-conflict");
    expect(outward.message).toContain("outside the manifest-addressed archive");

    // …and a link that resolves BACK INSIDE the archive: the addressed path stays
    // inside, so only the link itself can be refused — a rename through it files
    // the snapshot under a path the manifest does not address while the receipt
    // would claim the addressed one.
    rmSync(join(archiveDir, "workflows"));
    mkdirSync(join(archiveDir, "elsewhere"), { recursive: true });
    symlinkSync(join(archiveDir, "elsewhere"), join(archiveDir, "workflows"));
    const inward = await refusalOf(async () => retireExecutionSources(retirementInput(fixture, manifest, "symlink-in")));
    expect(inward.code).toBe("execution.migration-conflict");
    expect(inward.message).toContain("is a symlink");

    // Every destination is checked before the FIRST rename, so the root register
    // is still live, the snapshot is still live and neither link holds a byte.
    expect(existsSync(fixture.statusPath)).toBe(true);
    expect(existsSync(fixture.snapshotPaths[0]!)).toBe(true);
    expect(readdirSync(escaped)).toEqual([]);
    expect(readdirSync(join(archiveDir, "elsewhere"))).toEqual([]);
    expect(migrationPhaseOf(fixture.dbPath)).toBe("active");
    expect(executionMetaOf(fixture.dbPath).authority_state).toBe("active");
  });

  test("execution-retirement-records-the-receipt-only-after-every-item-moved", async () => {
    const fixture = await coreWorkspace("retire-receipt");
    const manifest = await stageCore(fixture, "retire-receipt");
    await activateExecutionMigration(await activationInput(fixture, manifest, "retire-receipt"));
    const archiveDir = join(fixture.harness, "archived", "execution", manifest.id);

    const crash = withEnv({ MSTAR_STORE_FAIL_EXECUTION_RETIREMENT: "before-receipt" }, () =>
      retireExecutionSources(retirementInput(fixture, manifest, "crash")),
    );
    await expect(crash).rejects.toThrow(/induced execution-migration failure/);
    // Every item is already moved and durably recorded, and the store still
    // records the manifest as active: partial retirement never returns authority.
    const ledger = JSON.parse(readFileSync(join(archiveDir, "retirement.json"), "utf8")) as {
      items: Array<{ state: string; relativePath: string }>;
    };
    expect(ledger.items.every((item) => item.state === "moved")).toBe(true);
    expect(migrationPhaseOf(fixture.dbPath)).toBe("active");
    expect(executionMetaOf(fixture.dbPath).authority_state).toBe("active");

    const receipt = await retireExecutionSources(retirementInput(fixture, manifest, "receipt"));
    expect(receipt).toEqual({ manifestId: manifest.id, phase: "retired", replayed: false });
    expect(migrationPhaseOf(fixture.dbPath)).toBe("retired");
  });

  test("execution-retirement-refuses-before-the-activation-receipt", async () => {
    const fixture = await coreWorkspace("retire-unactivated");
    const manifest = await stageCore(fixture, "retire-unactivated");
    const footprint = storeFootprint(fixture.dbPath);

    const refusal = await refusalOf(async () => retireExecutionSources(retirementInput(fixture, manifest, "early")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("retired only behind an ACTIVE receipt");
    expect(existsSync(fixture.statusPath)).toBe(true);
    expect(existsSync(fixture.snapshotPaths[0]!)).toBe(true);
    expect(existsSync(join(fixture.harness, "archived", "execution", manifest.id))).toBe(false);
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
  });
});

// ---------------------------------------------------------------------------
// Staged abort (§6 item 5)
// ---------------------------------------------------------------------------

describe("execution-abort", () => {
  test("execution-abort-returns-a-staged-manifest-to-legacy", async () => {
    const fixture = await legacyWorkspace("abort-legacy");
    await captureIssue(fixture.context, issueInput("Pre-abort finding"), {
      operationId: "op-abort-issue",
      actor: "project-manager",
    });
    await registerCatalogEntity(
      fixture.context,
      { kind: "document", id: "doc-abort", title: "Guide", rootKind: "harness", relativePath: "guide.md", documentKind: "guide" },
      { operationId: "op-abort-doc", actor: "project-manager" },
    );
    const before = protectedBytes(fixture.protectedPaths);
    const legacy = authorityOf(fixture.dbPath);
    const manifest = await stageCore(fixture, "abort");
    expect(migrationPhaseOf(fixture.dbPath)).toBe("staged");

    const receipt = await abortExecutionMigration(abortInput(fixture, manifest, "staged"));
    expect(receipt).toEqual({ manifestId: manifest.id, phase: "aborted", replayed: false });

    // Every staged row is gone and the authority is legacy again…
    for (const table of EXECUTION_TABLES) {
      if (table === "execution_migrations") continue;
      expect(rawGet<{ n: number }>(fixture.dbPath, `select count(*) as n from ${table}`)!.n, table).toBe(0);
    }
    expect(executionMetaOf(fixture.dbPath)).toMatchObject({
      authority_state: "legacy",
      manifest_id: null,
      activated_at: null,
    });
    // …the epoch did NOT move (no activation happened), and the store revision
    // advanced once for the abort itself.
    const after = authorityOf(fixture.dbPath);
    expect(after.authority_epoch).toBe(legacy.authority_epoch);
    expect(after.revision).toBe(legacy.revision + 2);
    // …with the aborted receipt recorded, and no JSON authority rewritten.
    const row = rawGet<{ phase: string; activation_receipt_json: string }>(
      fixture.dbPath,
      "select phase, activation_receipt_json from execution_migrations",
    )!;
    expect(row.phase).toBe("aborted");
    const abort = JSON.parse(row.activation_receipt_json) as Record<string, unknown>;
    expect(abort).toMatchObject({
      reason: "legacy input changed while staged",
      operator: "ops-engineer",
      previousAuthority: "staged",
    });
    expect((abort.deletedRows as Record<string, number>).execution_workflows).toBe(1);

    // Issue/catalog rows and every source byte survive: abort touches neither.
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from issues")!.n).toBe(1);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from catalog_entities")!.n).toBe(1);
    expect(protectedBytes(fixture.protectedPaths)).toEqual(before);
    // The JSON route is the live execution authority again.
    expect(() => assertExecutionFileWriteAllowed(fixture.context)).not.toThrow();
    await expect(readExecutionState(fixture.context)).rejects.toMatchObject({ code: "execution.not-active" });
    expect(readWorkflowSnapshot(fixture.workflowDir).snapshot.id).toBe(PRIMARY);
  });

  test("execution-abort-refuses-an-active-manifest-and-preserves-authority", async () => {
    const fixture = await coreWorkspace("abort-active");
    const manifest = await stageCore(fixture, "abort-active");
    await activateExecutionMigration(await activationInput(fixture, manifest, "abort-active"));
    const activated = storeFootprint(fixture.dbPath);

    const refusal = await refusalOf(async () => abortExecutionMigration(abortInput(fixture, manifest, "active")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("is recorded active");
    expect(storeFootprint(fixture.dbPath)).toEqual(activated);
    await expect(readExecutionState(fixture.context)).resolves.toBeDefined();
    expect(syncRefusalOf(() => assertExecutionFileWriteAllowed(fixture.context)).code).toBe("execution.direct-write-refused");

    // A retired manifest cannot abort either: retirement is forward-only.
    await retireExecutionSources(retirementInput(fixture, manifest, "after-abort-attempt"));
    const retired = await refusalOf(async () => abortExecutionMigration(abortInput(fixture, manifest, "retired")));
    expect(retired.message).toContain("is recorded retired");
  });

  test("execution-abort-rolls-back-a-failed-attempt-whole", async () => {
    const fixture = await coreWorkspace("abort-crash");
    const manifest = await stageCore(fixture, "abort-crash");
    const staged = storeFootprint(fixture.dbPath);

    const crash = withEnv({ MSTAR_STORE_FAIL_EXECUTION_ABORT: "before-commit" }, () =>
      abortExecutionMigration(abortInput(fixture, manifest, "crash")),
    );
    await expect(crash).rejects.toThrow(/induced execution-migration failure/);
    expect(storeFootprint(fixture.dbPath)).toEqual(staged);
    expect(migrationPhaseOf(fixture.dbPath)).toBe("staged");

    const receipt = await abortExecutionMigration(abortInput(fixture, manifest, "real"));
    expect(receipt).toEqual({ manifestId: manifest.id, phase: "aborted", replayed: false });
    const replay = await abortExecutionMigration(abortInput(fixture, manifest, "again"));
    expect(replay).toEqual({ manifestId: manifest.id, phase: "aborted", replayed: true });
  });

  test("execution-abort-refuses-to-restage-an-aborted-manifest", async () => {
    const fixture = await legacyWorkspace("abort-restage");
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-restage-preview"));
    const manifestHash = executionManifestHash(manifest);
    await applyExecutionMigration({ ...migrationInput(fixture, "op-restage-apply"), coverage: await coverageOf(fixture, manifest), manifest, manifestHash, backup });
    await abortExecutionMigration(abortInput(fixture, manifest, "restage"));
    const footprint = storeFootprint(fixture.dbPath);

    const refusal = await refusalOf(async () =>
      applyExecutionMigration({ ...migrationInput(fixture, "op-restage-again"), coverage: await coverageOf(fixture, manifest), manifest, manifestHash, backup }),
    );
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("is recorded aborted");
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
  });

  test("execution-abort-lets-changed-legacy-input-apply-under-a-fresh-manifest", async () => {
    const fixture = await legacyWorkspace("abort-repreview");
    const firstBackup = await recoveryPoint(fixture);
    const first = await previewExecutionMigration(migrationInput(fixture, "op-repreview-first"));
    await applyExecutionMigration({
      ...migrationInput(fixture, "op-repreview-apply"), coverage: await coverageOf(fixture, first),
      manifest: first,
      manifestHash: executionManifestHash(first),
      backup: firstBackup,
    });
    await abortExecutionMigration(abortInput(fixture, first, "repreview"));

    // The legacy input CHANGED while the staging was live — exactly the case an
    // abort exists for. The new preview is a different reviewed manifest, and it
    // stages the changed content rather than a hidden merge of the two.
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot.updated_at = "2026-09-07";
    writeJson(fixture.snapshotPath, snapshot);
    const second = await previewExecutionMigration(migrationInput(fixture, "op-repreview-second"));
    expect(second.id).not.toBe(first.id);
    const secondBackup = await recoveryPoint(fixture);
    const staged = await applyExecutionMigration({
      ...migrationInput(fixture, "op-repreview-second-apply"), coverage: await coverageOf(fixture, second),
      manifest: second,
      manifestHash: executionManifestHash(second),
      backup: secondBackup,
    });
    expect(staged).toEqual({ manifestId: second.id, phase: "staged", replayed: false });

    expect(migrationPhaseOf(fixture.dbPath)).toBe("staged");
    expect(
      rawAll<{ manifest_id: string; phase: string }>(fixture.dbPath, "select manifest_id, phase from execution_migrations order by rowid")
        .map((row) => [row.manifest_id, row.phase]),
    ).toEqual([
      [first.id, "aborted"],
      [second.id, "staged"],
    ]);
    expect(
      (JSON.parse(
        rawGet<{ state_json: string }>(fixture.dbPath, `select state_json from execution_workflows where workflow_id = '${PRIMARY}'`)!
          .state_json,
      ) as { updated_at: string }).updated_at,
    ).toBe("2026-09-07");
  });
});

// ---------------------------------------------------------------------------
// Phase 2b — the populated version-2 manifest, validated coverage, session
// retirement and the real-producer bytes (§4.1/§4.2/§5)
// ---------------------------------------------------------------------------

/**
 * The canonical bytes `exportExecutionHostInventory` produced on the Hosts
 * track (`packages/omp/src/execution-host-inventory.ts`, `buildExecutionHostInventory`
 * + `exportExecutionHostInventory`): one `mstar:model-handoff` entry of ONE
 * native session, bound to ONE workflow, in the released envelope shape. The
 * bytes below are the producer's own output, captured verbatim; the digest is
 * what the producer itself reports for them, so the interop regression can
 * prove that C2's closed comparison accepts producer bytes UNCHANGED.
 */
const PRODUCER_WORKFLOW = "20260921-producer-workflow";
const PRODUCER_SESSION = "native-session-c3-producer";
const PRODUCER_ENVELOPE =
  '{"export":{"document":{"diagnostics":[],"document":"execution-host-history","records":[{"entryId":"entry-handoff-1","index":0,"payload":{"action":"arm","baselineModelChangeId":null,"binding":{"sessionId":"native-session-c3-producer","workflowId":"20260921-producer-workflow"},"observedModel":null,"operationId":"op-1","reason":null,"state":"pending","version":1},"payloadHash":"4076bdd1fa1fe6ac20157efb3022e724c323b6a454aa09c936c9e33a4999aaa7","sessionId":"native-session-c3-producer","type":"mstar:model-handoff","view":{"cancelled":false,"checkpointId":null,"declaredAction":"arm","declaredKind":null,"declaredState":"pending","dedupKey":"op-1","generation":1,"operationId":"op-1","provenance":[],"workflowId":"20260921-producer-workflow"}}],"version":1},"sha256":"5a96c5bc766f91c5d44cfff7ef34a12c1a8ab2083137535f15031f08bbfa0ab7"},"host":"omp","hostSessionId":"native-session-c3-producer","protocol":"host-hidden-inventory-v1","version":1,"workflowId":"20260921-producer-workflow"}\n';
const PRODUCER_ENVELOPE_SHA = "0643293fa09da5be7e89728b3595e41e3d29d0c2647ac9c570ba1cbde49c80c8";

const TERMINAL_WORKFLOW = "20260921-terminal-history";
const TERMINAL_PLAN = `${TERMINAL_WORKFLOW}-plan`;
const TERMINAL_SESSION = "host-terminal-0001";
/** P4's immutable recovery audit: provenance the import must never drop. */
const RECOVERY_RECORD = {
  operation_id: "op-recover-1",
  request_hash: "c".repeat(64),
  workflow_id: PRODUCER_WORKFLOW,
  prior_session_id: "host-prior-0001",
  session_id: COORDINATOR_SESSION,
  authorization_ref: "D29 Prepare recovery",
  reason: "prior coordinator stopped",
  stopped_session_ids: ["host-prior-0001"],
  snapshot_version_before: `sha256:${"d".repeat(64)}`,
  compass_version: `sha256:${"e".repeat(64)}`,
  recovered_at: "2026-09-04T00:00:00.000Z",
};

type PopulatedWorkspace = Fixture & {
  workflowId: string;
  workflowDir: string;
  snapshotPath: string;
  statusPath: string;
  envelopePath: string;
  terminalDir: string;
  terminalSnapshotPath: string;
  terminalEnvelopePath: string;
  hostEnvelopePath: string;
  coverageAttestationPath: string;
  sddPath: string;
  dbPath: string;
  protectedPaths: string[];
};

/**
 * §4.2 the fully populated workspace: one registered running workflow (a bound
 * coordinator envelope, the four retained ledgers, the operator's SDD evidence,
 * the host-session export produced by the real producer and P4's recovery
 * audit) plus one TERMINAL workflow dir the root register no longer lists (an
 * unreferenced envelope, so its session surface is `retire`).
 */
async function populatedWorkspace(name: string): Promise<PopulatedWorkspace> {
  const fixture = workspace(name);
  const handle = await initializeStore(fixture.context);
  handle.close();

  const workflowId = PRODUCER_WORKFLOW;
  const workflowDir = join(fixture.harness, "workflows", workflowId);
  const envelopePath = join(workflowDir, "sessions", `coordinator-${COORDINATOR_SESSION}.json`);
  const statusPath = join(fixture.harness, "status.json");
  const snapshotPath = join(workflowDir, WORKFLOW_SNAPSHOT_FILE);
  const terminalDir = join(fixture.harness, "workflows", TERMINAL_WORKFLOW);
  const terminalSnapshotPath = join(terminalDir, WORKFLOW_SNAPSHOT_FILE);
  const terminalEnvelopePath = join(terminalDir, "sessions", `coordinator-${TERMINAL_SESSION}.json`);

  writeJson(snapshotPath, {
    schema_version: 1,
    id: workflowId,
    type: "plan",
    status: "running",
    started_at: "2026-09-01",
    updated_at: "2026-09-02",
    delivery_kind: "development",
    project: "_default",
    branch: { source: `feature/${workflowId}`, target: "main" },
    coordination: {
      coordinator: { session_id: COORDINATOR_SESSION, session_file: envelopePath, bound_at: TS },
      identity_recoveries: [RECOVERY_RECORD],
    },
    plans: [{ id: PLAN_A, title: "Populated plan", file: "plans/plan-a.md", status: "InReview", metadata: {} }],
  });
  writeJson(terminalSnapshotPath, {
    schema_version: 1,
    id: TERMINAL_WORKFLOW,
    type: "plan",
    status: "completed",
    started_at: "2026-08-01",
    ended_at: "2026-08-20",
    updated_at: "2026-08-20",
    delivery_kind: "development",
    project: "_default",
    branch: { source: `feature/${TERMINAL_WORKFLOW}`, target: "main" },
    plans: [{ id: TERMINAL_PLAN, title: "Terminal plan", file: "plans/terminal.md", status: "Done", metadata: {} }],
  });
  writeJson(statusPath, {
    version: 2,
    updated_at: ROOT_UPDATED_AT,
    workflows: [{ id: workflowId, type: "plan", started_at: "2026-09-01", dir: join("workflows", workflowId) }],
  });
  writeJson(envelopePath, envelopeOf("coordinator", COORDINATOR_SESSION, workflowId, fixture.harness));
  // The terminal dir's envelope is referenced by NO binding: it is historical
  // evidence the session surface owns, and its row is therefore `retire`.
  writeJson(terminalEnvelopePath, envelopeOf("coordinator", TERMINAL_SESSION, TERMINAL_WORKFLOW, fixture.harness));

  // The four retained workflow ledgers, in their released formats.
  writeText(
    join(workflowDir, "notes.jsonl"),
    [
      JSON.stringify({ kind: "note", ts: "2026-09-01T00:00:00.000Z", text: "legacy note body" }),
      JSON.stringify({ version: 1, id: "note-1", workflowId, sessionId: COORDINATOR_SESSION, kind: "note", ts: "2026-09-01T00:00:01.000Z", text: "recorded" }),
    ].join("\n"),
  );
  writeText(join(workflowDir, "agent-flow.jsonl"), JSON.stringify({ v: 1, ts: 1, kind: "dispatch", role: "plan-pm", verdict: "ok", hard: false }));
  writeText(join(workflowDir, "workflow-ledger-cursors.json"), serializeExecutionValue({ v: 2, cursors: { [COORDINATOR_SESSION]: { next: 2 } } }));
  writeJson(join(workflowDir, "omp-launches.json"), {
    version: 1,
    workflow_id: workflowId,
    coordinator: { session_id: COORDINATOR_SESSION, session_file: envelopePath },
    intents: [],
  });

  // The explicit evidence roots: SDD bodies, the host export, the injector
  // deployment, the recovery point and the operator's coverage attestation.
  const evidenceDir = join(fixture.harness, INV);
  const hostEnvelopePath = join(evidenceDir, "host", "host-sessions", "producer.json");
  const coverageAttestationPath = join(evidenceDir, "host", "attestation.json");
  const sddPath = join(evidenceDir, "sdd", workflowId, "task-1-report.md");
  const injectorPath = join(evidenceDir, "package", "injectors", "fs-store.js");
  const injectorInventoryPath = join(evidenceDir, "package", "coverage", "injector-inventory.json");
  const backupImagePath = join(evidenceDir, "package", "backups", "store.db");
  const backupInventoryPath = join(evidenceDir, "package", "coverage", "recovery-inventory.json");

  mkdirSync(dirname(hostEnvelopePath), { recursive: true });
  writeFileSync(hostEnvelopePath, PRODUCER_ENVELOPE);
  writeJson(coverageAttestationPath, {
    ...migrationAttestation([{ sessionId: PRODUCER_SESSION, host: "omp", state: "stopped" }]),
  });
  writeText(sddPath, "# populated workflow report");
  writeText(injectorPath, "export const store = {};");
  writeText(injectorInventoryPath, serializeExecutionValue({
    version: 1,
    protocol: "injector-inventory-v1",
    injectors: [{ module: { root: "package", path: "injectors/fs-store.js", sha256: sha256OfBytes(readFileSync(injectorPath)) }, capability: "body-only" }],
  }));
  writeText(backupImagePath, "sqlite-consistent-backup");
  writeText(backupInventoryPath, serializeExecutionValue({
    version: 1,
    document: "recovery-inventory",
    backup: { path: "backups/store.db", sha256: sha256OfBytes(readFileSync(backupImagePath)) },
    schemaVersion: 4,
    integrity: "verified",
    coverageDigest: "7".repeat(64),
    recoveryGeneration: 2,
  }));

  // §4.2 the explicit inventory: every root and every evidence pointer.
  writeInventory(fixture, {
    hostSessions: [
      { workflowId, host: "omp", sessionId: PRODUCER_SESSION, envelope: hostEnvelopePath, attestation: coverageAttestationPath },
    ],
    sddEvidence: [{ workflowId, path: sddPath }],
    injectors: [injectorPath],
    injectorInventory: injectorInventoryPath,
    backup: { image: backupImagePath, inventory: backupInventoryPath },
  });

  return {
    ...fixture,
    workflowId,
    workflowDir,
    snapshotPath,
    statusPath,
    envelopePath,
    terminalDir,
    terminalSnapshotPath,
    terminalEnvelopePath,
    hostEnvelopePath,
    coverageAttestationPath,
    sddPath,
    dbPath: storeDbPath(fixture.context),
    protectedPaths: [statusPath, snapshotPath, envelopePath, terminalSnapshotPath, terminalEnvelopePath, hostEnvelopePath],
  };
}

describe("Phase 2b - populated manifest, validated coverage and session retirement", () => {
  test("Phase 2b a fully populated workspace stages, activates and retires under validated coverage", async () => {
    const fixture = await populatedWorkspace("c3-populated");
    await captureIssue(fixture.context, issueInput("Phase 2b issue"), { operationId: "op-c3-issue", actor: "project-manager" });
    const issueFootprint = rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from issues");
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-c3-preview"));

    // ── the version-2 manifest covers DISCOVERY: roots, rows, proofs
    expect(manifest.version).toBe(2);
    expect(manifest.roots.control).toBe(canonicalPath(dirname(storeDbPath(fixture.context))));
    expect(manifest.surfaces.length).toBeGreaterThan(0);
    expect(manifest.surfaces.find((row) => row.surface === "artifact-store-injectors")?.consumerProof).toBeUndefined();
    const hiddenRow = manifest.surfaces.find((row) => row.surface === "omp-hidden-entries" && row.workflowId === fixture.workflowId)!;
    expect(hiddenRow.sources.map((witness) => witness.path)).toEqual(["host-sessions/producer.json"]);
    expect(hiddenRow.hostProof).toMatchObject({ sessions: [{ host: "omp", sessionId: PRODUCER_SESSION }] });
    expect(hiddenRow.sources[0]!.sha256).toBe(PRODUCER_ENVELOPE_SHA);

    const coverage = await coverageOf(fixture, manifest);
    expect(coverage.manifestId).toBe(manifest.id);
    expect(coverage.receipts.length).toBe(manifest.surfaces.length);
    // Every receipt's source set IS its manifest row's assigned set.
    for (const receipt of coverage.receipts) {
      const row = manifest.surfaces.find((candidate) => candidate.surface === receipt.surface && candidate.workflowId === receipt.workflowId)!;
      expect(receipt.sources).toEqual(row.sources);
    }
    expect(coverage.receipts.find((receipt) => receipt.surface === "workflow-notes-ledger")!.disposition).toBe("retain");
    expect(coverage.receipts.find((receipt) => receipt.surface === "omp-hidden-entries")!).toMatchObject({
      disposition: "retain",
      protocol: "omp-hidden-v1",
      workflowId: PRODUCER_WORKFLOW,
    });
    const terminalEnvelopeReceipt = coverage.receipts.find(
      (receipt) => receipt.surface === "workflow-session-envelopes" && receipt.workflowId === TERMINAL_WORKFLOW,
    )!;
    expect(terminalEnvelopeReceipt.disposition).toBe("retire");

    const staged = await applyExecutionMigration({
      ...migrationInput(fixture, "op-c3-apply"),
      manifest,
      manifestHash: executionManifestHash(manifest),
      backup,
      coverage,
    });
    expect(staged.phase).toBe("staged");
    // Terminal history is imported WITHOUT root registry membership.
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from execution_registry")!.n).toBe(1);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from execution_workflows")!.n).toBe(2);

    const receipt = await activateExecutionMigration({
      ...(await activationInput(fixture, manifest, "c3", migrationAttestation([{ sessionId: COORDINATOR_SESSION, host: "omp", state: "stopped" }]))),
    });
    expect(receipt).toEqual({ manifestId: manifest.id, phase: "active", replayed: false });
    expect(migrationPhaseOf(fixture.dbPath)).toBe("active");

    // P4's recovery audit survives as PROVENANCE and the coordinator seat is
    // not revived: the read view serves the audit and no active coordinator.
    const state = await readExecutionState(fixture.context);
    const imported = state.data.workflows.find((workflow) => workflow.state.id === fixture.workflowId)!;
    expect(imported.coordinator).toBeNull();
    // P4's audit is carried in the imported workflow STATE, byte-for-byte.
    const storedHeader = JSON.parse(
      rawGet<{ state_json: string }>(
        fixture.dbPath,
        `select state_json from execution_workflows where workflow_id = '${PRODUCER_WORKFLOW}'`,
      )!.state_json,
    ) as Record<string, unknown>;
    expect(storedHeader.identity_recoveries).toEqual([RECOVERY_RECORD]);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from issues")).toEqual(issueFootprint);

    // ── §3.3 retirement: core sources PLUS the retire-disposition envelope row
    const retired = await retireExecutionSources(retirementInput(fixture, manifest, "c3"));
    expect(retired).toEqual({ manifestId: manifest.id, phase: "retired", replayed: false });
    const archiveDir = join(fixture.harness, "archived", "execution", manifest.id);
    expect(existsSync(join(archiveDir, "status.json"))).toBe(true);
    expect(existsSync(join(archiveDir, "workflows", fixture.workflowId, WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    expect(existsSync(join(archiveDir, "workflows", TERMINAL_WORKFLOW, WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    // The unreferenced terminal envelope was archived; the REFERENCED one stays.
    expect(existsSync(join(archiveDir, "workflows", TERMINAL_WORKFLOW, "sessions", `coordinator-${TERMINAL_SESSION}.json`))).toBe(true);
    expect(existsSync(fixture.terminalEnvelopePath)).toBe(false);
    expect(existsSync(fixture.envelopePath)).toBe(true);
    // Nothing else moved: the retained ledgers, the host export and the SDD
    // evidence are byte-identical.
    expect(readFileSync(join(fixture.workflowDir, "agent-flow.jsonl"), "utf8")).toContain('"kind":"dispatch"');
    expect(readFileSync(fixture.hostEnvelopePath, "utf8")).toBe(PRODUCER_ENVELOPE);
    expect(readFileSync(fixture.sddPath, "utf8")).toContain("populated workflow report");
  });

  test("Phase 2b closes the host-inventory row against the real producer bytes", async () => {
    // The `omp-hidden-entries` row is built from bytes the real H2 producer
    // (`packages/omp/src/execution-host-inventory.ts`) emits, and the closed
    // substrate decodes those bytes UNCHANGED: `export.sha256` covers the
    // canonical serialization of the embedded document with the exporter's
    // framing LF excluded (contract section 4.2, one rule), while the envelope's
    // own digest covers the bytes as delivered.
    const fixture = await populatedWorkspace("c3-host-interop");
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-host-preview"));
    const row = manifest.surfaces.find((candidate) => candidate.surface === "omp-hidden-entries")!;
    expect(row.sources.map((witness) => witness.path)).toEqual(["host-sessions/producer.json"]);
    expect(row.hostProof).toMatchObject({ sessions: [{ host: "omp", sessionId: PRODUCER_SESSION }] });
    expect(row.hostProof!.sessions[0]!.source.sha256).toBe(PRODUCER_ENVELOPE_SHA);
    expect(row.hostProof!.attestation.sha256).toBe(sha256OfBytes(readFileSync(fixture.coverageAttestationPath)));

    // The producer's own bytes, recomputed here: the envelope file digest covers
    // the delivered bytes; the embedded digest covers the export without the
    // framing LF that the canonical serializer appends.
    expect(sha256OfBytes(readFileSync(fixture.hostEnvelopePath))).toBe(PRODUCER_ENVELOPE_SHA);
    const envelope = JSON.parse(PRODUCER_ENVELOPE) as { export: { sha256: string; document: unknown } };
    const exported = serializeExecutionValue(envelope.export.document);
    expect(envelope.export.sha256).toBe(sha256OfBytes(Buffer.from(exported.slice(0, -1), "utf8")));
    expect(envelope.export.sha256).not.toBe(sha256OfBytes(Buffer.from(exported, "utf8")));

    // ...and the row closes through the closed substrate.
    const coverage = await coverageOf(fixture, manifest);
    const receipt = coverage.receipts.find((candidate) => candidate.surface === "omp-hidden-entries")!;
    expect(receipt).toMatchObject({ disposition: "retain", protocol: "omp-hidden-v1", workflowId: PRODUCER_WORKFLOW });
    expect(receipt.sources).toEqual([{ root: "host", path: "host-sessions/producer.json", sha256: PRODUCER_ENVELOPE_SHA }]);
    expect(receipt.evidence).toEqual([
      { root: "host", path: "attestation.json", sha256: sha256OfBytes(readFileSync(fixture.coverageAttestationPath)) },
    ]);

    // ONE byte of the producer's payload and the closed comparison refuses: the
    // embedded export digest is recomputed from the bytes, never carried on
    // trust.
    writeFileSync(fixture.hostEnvelopePath, PRODUCER_ENVELOPE.replace('"action":"arm"', '"action":"arm!"'));
    const mutated = await previewExecutionMigration(migrationInput(fixture, "op-host-mutated-preview"));
    const refusal = await refusalOf(async () => coverageOf(fixture, mutated));
    expect(refusal.code).toBe("execution.coverage-incomplete");
    expect(refusal.message).toContain("export.sha256");
  });

  test("Phase 2b refuses a present agent-flow compaction journal before any receipt", async () => {
    const fixture = await populatedWorkspace("c3-compaction");
    writeJson(join(fixture.workflowDir, "agent-flow-compaction.json"), {
      version: 1,
      tailBefore: { bytes: 1, sha256: "1".repeat(64) },
      tailAfter: { bytes: 1, sha256: "2".repeat(64) },
      archive: { chunk: "chunk-000001.jsonl", offset: 0, bytes: 1, sha256: "3".repeat(64) },
      lines: 1,
    });
    const refusal = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-compaction-preview")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("agent-flow-compaction.json");
    expect(refusal.message).toContain("UNFINISHED compaction transaction");
    // Nothing was staged and no receipt was built.
    expect(rawGet<{ phase: string }>(fixture.dbPath, "select phase from execution_migrations order by rowid desc limit 1")).toBeUndefined();
  });

  test("Phase 2b refuses a forged coverage set and a drifted receipt with zero authority switch", async () => {
    const fixture = await populatedWorkspace("c3-refusals");
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-refusals-preview"));
    const coverage = await coverageOf(fixture, manifest);
    const staged = storeFootprint(fixture.dbPath);

    // A forged receipt (one flipped resultHash) is not the recomputed set.
    const forged: ExecutionCoverageSet = {
      ...coverage,
      receipts: coverage.receipts.map((receipt, index) =>
        index === 0 ? { ...receipt, resultHash: "0".repeat(64) } : receipt,
      ),
    };
    const forgedRefusal = await refusalOf(async () =>
      applyExecutionMigration({
        ...migrationInput(fixture, "op-refusals-forged"),
        manifest,
        manifestHash: executionManifestHash(manifest),
        backup,
        coverage: forged,
      }),
    );
    expect(forgedRefusal.code).toBe("execution.migration-conflict");
    expect(storeFootprint(fixture.dbPath)).toEqual(staged);

    // A receipt drifted since review (a source byte changed) refuses too.
    writeText(join(fixture.workflowDir, "notes.jsonl"), '{"kind":"note","ts":"2026-09-09T00:00:00.000Z","text":"rewritten after review"}');
    const drifted = await refusalOf(async () =>
      applyExecutionMigration({
        ...migrationInput(fixture, "op-refusals-drifted"),
        manifest,
        manifestHash: executionManifestHash(manifest),
        backup,
        coverage,
      }),
    );
    expect(drifted.code).toBe("execution.migration-conflict");
    expect(storeFootprint(fixture.dbPath)).toEqual(staged);
    // The EXECUTION authority never left `legacy`: a refused staging attempt
    // writes nothing at all.
    expect(executionMetaOf(fixture.dbPath).authority_state).toBe("legacy");
  });

  test("Phase 2b replay preserves issue/catalog state and the archive identity", async () => {
    const fixture = await populatedWorkspace("c3-replay");
    await captureIssue(fixture.context, issueInput("Replay issue"), { operationId: "op-c3-replay-issue", actor: "project-manager" });
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-c3-replay-preview"));
    const coverage = await coverageOf(fixture, manifest);
    const applyInput = {
      ...migrationInput(fixture, "op-c3-replay-apply"),
      manifest,
      manifestHash: executionManifestHash(manifest),
      backup,
      coverage,
    };
    await applyExecutionMigration(applyInput);
    const footprint = storeFootprint(fixture.dbPath);
    const replay = await applyExecutionMigration({ ...applyInput, operationId: "op-c3-replay-apply-again" });
    expect(replay).toEqual({ manifestId: manifest.id, phase: "staged", replayed: true });
    expect(storeFootprint(fixture.dbPath)).toEqual(footprint);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from issues")!.n).toBe(1);

    await activateExecutionMigration({
      ...(await activationInput(fixture, manifest, "c3-replay", migrationAttestation([{ sessionId: COORDINATOR_SESSION, host: "omp", state: "stopped" }]))),
    });
    const activated = storeFootprint(fixture.dbPath);
    const activationReplay = await activateExecutionMigration({
      ...(await activationInput(fixture, manifest, "c3-replay-again", migrationAttestation([{ sessionId: COORDINATOR_SESSION, host: "omp", state: "stopped" }]))),
    });
    expect(activationReplay).toEqual({ manifestId: manifest.id, phase: "active", replayed: true });
    expect(storeFootprint(fixture.dbPath)).toEqual(activated);

    await retireExecutionSources(retirementInput(fixture, manifest, "c3-replay"));
    const retiredArchive = treeInventory(join(fixture.harness, "archived", "execution", manifest.id));
    const retirementReplay = await retireExecutionSources(retirementInput(fixture, manifest, "c3-replay-again"));
    expect(retirementReplay).toEqual({ manifestId: manifest.id, phase: "retired", replayed: true });
    expect(treeInventory(join(fixture.harness, "archived", "execution", manifest.id))).toEqual(retiredArchive);
  });

  test("Phase 2b refuses a version-1 staged manifest and requires an explicit abort", async () => {
    const fixture = await populatedWorkspace("c3-v1-manifest");
    const legacyManifest: ExecutionManifestDocument = {
      version: 1,
      id: "exec-legacy-v1",
      storeId: "store",
      epoch: 1,
      schemaVersion: 4,
      root: fixture.harness,
      sources: [],
      coreHash: "0".repeat(64),
      deferred: [],
      catalogRevision: 0,
      pendingCatalogOperations: [],
    };
    const now = "2026-09-21T00:00:00.000Z";
    rawRun(
      fixture.dbPath,
      "insert into execution_migrations(manifest_id, manifest_hash, phase, manifest_json, coverage_json, activation_receipt_json, retirement_json, created_at, updated_at) values (?, ?, 'staged', ?, null, null, null, ?, ?)",
      legacyManifest.id,
      executionManifestHash(legacyManifest),
      JSON.stringify(legacyManifest),
      now,
      now,
    );
    rawRun(fixture.dbPath, "update execution_meta set authority_state = 'staged', manifest_id = ? where id = 1", legacyManifest.id);

    const activateRefusal = await refusalOf(async () =>
      activateExecutionMigration({
        ...migrationInput(fixture, "op-c3-v1-activate"),
        manifestId: legacyManifest.id,
        manifestHash: executionManifestHash(legacyManifest),
        expectedEpoch: 1,
        attestation: migrationAttestation(),
        coverageDigest: "1".repeat(64),
      }),
    );
    expect(activateRefusal.code).toBe("execution.migration-conflict");
    expect(activateRefusal.message).toContain("version 1");
    expect(migrationPhaseOf(fixture.dbPath)).toBe("staged");

    const abort = await abortExecutionMigration({
      ...migrationInput(fixture, "op-c3-v1-abort"),
      manifestId: legacyManifest.id,
      manifestHash: executionManifestHash(legacyManifest),
      reason: "v1 staging superseded by the version-2 discovery",
    });
    expect(abort).toEqual({ manifestId: legacyManifest.id, phase: "aborted", replayed: false });
    expect(migrationPhaseOf(fixture.dbPath)).toBe("aborted");
    expect(executionMetaOf(fixture.dbPath).authority_state).toBe("legacy");
  });

  /**
   * A minimal reference implementation of R1's canonical closure, transcribed
   * from `scripts/execution-consumer-manifest.ts` (`treeEntries`,
   * `digestEntries`, `hashCopiedTree`) so C3's derivation can be compared with
   * R1's own rule without importing a repo script into the engine package.
   */
  function referenceTreeEntries(rootPath: string, exclude: readonly string[] = []): Array<{ path: string; kind: "file" | "symlink"; sha256: string; linkTarget: string | null }> {
    // R1 canonicalizes every root before walking it, so a link target is
    // recorded relative to the CANONICAL tree root.
    const rootAbs = realpathSync(rootPath);
    const entries: Array<{ path: string; kind: "file" | "symlink"; sha256: string; linkTarget: string | null }> = [];
    const walk = (dirAbs: string, relDir: string): void => {
      for (const dirent of readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (exclude.includes(dirent.name)) continue;
        const abs = join(dirAbs, dirent.name);
        const rel = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
        if (dirent.isDirectory()) {
          walk(abs, rel);
          continue;
        }
        if (dirent.isSymbolicLink()) {
          const resolved = realpathSync(abs);
          entries.push({
            path: rel,
            kind: "symlink",
            sha256: sha256OfBytes(readFileSync(resolved)),
            linkTarget: relative(rootAbs, resolved).split("\\").join("/"),
          });
          continue;
        }
        entries.push({ path: rel, kind: "file", sha256: sha256OfBytes(readFileSync(abs)), linkTarget: null });
      }
    };
    walk(rootAbs, "");
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  }

  /** R1's digest: sha256 over the compact JSON of the sorted entry closure. */
  function referenceTreeDigest(entries: readonly unknown[]): string {
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  }

  type ConsumerFixture = Fixture & { manifestPath: string; sourceRoot: string; generatedRoot: string; linkPath: string };

  /** §4.2 a fixture consumer package whose declaration is written in the shape the reviewed substrate decodes. */
  async function consumerWorkspace(name: string): Promise<ConsumerFixture> {
    const fixture = workspace(name);
    // The migration route opens the store AND reads the v2 root register, so the
    // fixture carries both: a store and one registered workflow dir.
    const handle = await initializeStore(fixture.context);
    handle.close();
    const workflowId = "20260921-consumer-fixture";
    const workflowDir = join(fixture.harness, "workflows", workflowId);
    writeJson(join(workflowDir, WORKFLOW_SNAPSHOT_FILE), {
      schema_version: 1,
      id: workflowId,
      type: "plan",
      status: "running",
      started_at: "2026-09-01",
      updated_at: "2026-09-02",
      delivery_kind: "development",
      project: "_default",
      branch: { source: `feature/${workflowId}`, target: "main" },
      plans: [{ id: `${workflowId}-plan`, title: "Consumer fixture plan", file: "plans/consumer.md", status: "Todo", metadata: {} }],
    });
    writeJson(join(fixture.harness, "status.json"), {
      version: 2,
      updated_at: ROOT_UPDATED_AT,
      workflows: [{ id: workflowId, type: "plan", started_at: "2026-09-01", dir: join("workflows", workflowId) }],
    });
    const packageRoot = join(fixture.root, "packages", "cli");
    const sourceRoot = join(packageRoot, "src");
    const generatedRoot = join(packageRoot, "dist");
    writeText(join(sourceRoot, "nested", "util.ts"), "export const util = 1;");
    writeText(join(sourceRoot, "index.ts"), "export const index = util;");
    const linkPath = join(sourceRoot, "alias.ts");
    symlinkSync(join(sourceRoot, "nested", "util.ts"), linkPath);
    writeText(join(packageRoot, "package.json"), '{"name":"@mstar-harness/cli"}');
    writeText(join(generatedRoot, "mstar-harness.js"), "// built entry");
    // R1's own non-build allowlist: the producer's manifest basename is skipped
    // inside a GENERATED tree even though it sits there on disk.
    writeText(join(generatedRoot, "execution-consumer.json"), "{}");
    writeText(join(fixture.root, "skills", "mstar-harness-core", "SKILL.md"), "# copied skill\n");
    writeText(join(packageRoot, "harness-skills", "mstar-harness-core", "SKILL.md"), "# copied skill\n");
    writeText(join(fixture.root, "agents", "dev.md"), "# merged agent\n");
    writeText(join(packageRoot, "harness-agents", "dev.md"), "# merged agent\n");
    writeText(join(packageRoot, "harness-agents", "host-only.md"), "# host overlay\n");

    const sourceEntries = referenceTreeEntries(sourceRoot);
    const generatedEntries = referenceTreeEntries(generatedRoot, ["execution-consumer.json"]);
    const copyEntries = referenceTreeEntries(join(fixture.root, "skills"));
    const mergeEntries = referenceTreeEntries(join(fixture.root, "agents"));
    // The producer's OWN handoff form and location
    // (`scripts/packaging-manifests/<consumer>.json`, canonical §3.1, outside
    // every declared tree), so the migration chain takes its evidence straight
    // from producer bytes and never from an operator projection.
    const manifestPath = join(fixture.root, "scripts", "packaging-manifests", "cli.json");
    writeText(
      manifestPath,
      serializeExecutionValue({
        version: 1,
        protocol: "consumer-v1",
        repoRoot: ".",
        consumers: [
          {
            id: "cli",
            packageRoot: "packages/cli",
            capability: "writer",
            capabilityNote: null,
            entrypoint: "packages/cli/dist/mstar-harness.js",
            runtime: { target: "node", floor: ">=24.18.0", declaration: "package-engines" },
            sources: {
              trees: [{ root: "packages/cli/src", files: sourceEntries.length, sha256: referenceTreeDigest(sourceEntries) }],
              files: [{ path: "packages/cli/package.json", sha256: sha256OfBytes(readFileSync(join(packageRoot, "package.json"))) }],
            },
            generated: {
              trees: [{ root: "packages/cli/dist", files: generatedEntries.length, sha256: referenceTreeDigest(generatedEntries) }],
              files: [{ path: "packages/cli/dist/mstar-harness.js", sha256: sha256OfBytes(readFileSync(join(generatedRoot, "mstar-harness.js"))) }],
            },
            copiedInstructions: [
              { sourceRoot: "skills", targetRoot: "packages/cli/harness-skills", mode: "copy", files: copyEntries.length, sha256: referenceTreeDigest(copyEntries) },
              { sourceRoot: "agents", targetRoot: "packages/cli/harness-agents", mode: "merge", files: mergeEntries.length, sha256: referenceTreeDigest(mergeEntries) },
            ],
          },
        ],
      }),
    );
    // R1 records repo-relative paths, so the configured package root IS this
    // fixture's checkout root.
    writeInventory(fixture, {
      roots: { sdd: join(fixture.harness, INV, "sdd"), host: join(fixture.harness, INV, "host"), package: fixture.root },
      consumers: [{ surface: "cli-writer", path: manifestPath, consumerId: "cli" }],
    });
    return { ...fixture, manifestPath, sourceRoot, generatedRoot, linkPath };
  }

  test("Phase 2b closes the consumer surface against R1's own tree/copy rule", async () => {
    const fixture = await consumerWorkspace("c3-consumer-interop");
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-consumer-preview"));
    const row = manifest.surfaces.find((candidate) => candidate.surface === "cli-writer")!;
    const coverage = await coverageOf(fixture, manifest);
    const receipt = coverage.receipts.find((candidate) => candidate.surface === "cli-writer")!;
    expect(receipt).toMatchObject({ disposition: "retain", protocol: "consumer-v1", workflowId: null });

    // Every proof fact is R1's own rule, recomputed from the real bytes.
    const sourceEntries = referenceTreeEntries(fixture.sourceRoot);
    const generatedEntries = referenceTreeEntries(fixture.generatedRoot, ["execution-consumer.json"]);
    const proof = row.consumerProof!;
    const sourceTree = proof.trees.find((tree) => tree.kind === "source")!;
    const generatedTree = proof.trees.find((tree) => tree.kind === "generated")!;
    expect(sourceTree).toMatchObject({ path: "packages/cli/src", files: sourceEntries.length, sha256: referenceTreeDigest(sourceEntries) });
    expect(generatedTree).toMatchObject({ path: "packages/cli/dist", files: generatedEntries.length, sha256: referenceTreeDigest(generatedEntries) });
    // R1 records a symlink by its tree-relative target and the resolved bytes.
    const linkEntry = sourceEntries.find((entry) => entry.kind === "symlink")!;
    expect(linkEntry).toMatchObject({ path: "alias.ts", linkTarget: "nested/util.ts" });
    expect(row.sources.find((witness) => witness.path === "packages/cli/src/alias.ts")?.sha256).toBe(linkEntry.sha256);
    // Copies: the source-side closure is the digest, a merge keeps host-only extras out of the pair.
    const copyProof = proof.copies.find((copy) => copy.mode === "copy")!;
    expect(copyProof).toMatchObject({ sourceRoot: "skills", targetRoot: "packages/cli/harness-skills", files: 1, sha256: referenceTreeDigest(referenceTreeEntries(join(fixture.root, "skills"))) });
    expect(copyProof.sourceWitnesses.map((witness) => witness.path)).toEqual(["skills/mstar-harness-core/SKILL.md"]);
    const mergeProof = proof.copies.find((copy) => copy.mode === "merge")!;
    expect(mergeProof.targetWitnesses.map((witness) => witness.path)).toEqual(["packages/cli/harness-agents/dev.md"]);
    expect(row.sources.some((witness) => witness.path.includes("host-only.md"))).toBe(false);
    // The row's evidence document IS the producer-side artifact at its own path.
    expect(row.evidence).toEqual([
      { root: "package", path: "scripts/packaging-manifests/cli.json", sha256: sha256OfBytes(readFileSync(fixture.manifestPath)) },
    ]);

    // ONE changed source byte and the declared closure no longer holds: the
    // frozen manifest no longer describes the discovered world (a conflict, the
    // same verdict `apply` gives for source drift).
    writeText(join(fixture.sourceRoot, "index.ts"), "export const index = 2;");
    const drift = await refusalOf(async () => coverageOf(fixture, manifest));
    expect(drift.code).toBe("execution.migration-conflict");
    expect(drift.message).toContain("surface discovery no longer holds the reviewed bytes");

    // Re-discovering the drifted tree still refuses: the proof is recomputed
    // from the real bytes and the DECLARED digest is now stale.
    const rediscoved = await previewExecutionMigration(migrationInput(fixture, "op-consumer-drift-preview"));
    const declared = await refusalOf(async () => coverageOf(fixture, rediscoved));
    expect(declared.code).toBe("execution.coverage-incomplete");
    expect(declared.message).toContain("discovery proof disagrees with the declared source tree");
  });

  test("Phase 2b names the producer-encoding conflict instead of reformatting the artifact", async () => {
    // The repository producer serializes its manifest with two-space
    // indentation and writes ONE aggregate document for all consumers, while the
    // reviewed consumer substrate decodes canonical §3.1 bytes with exactly one
    // consumer entry. C3 refuses and NAMES the cross-package conflict; it never
    // reformats, reduces or rewrites the producer artifact to fit the decoder.
    const fixture = await consumerWorkspace("c3-consumer-encoding");
    const document = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as Record<string, unknown>;

    writeFileSync(fixture.manifestPath, `${JSON.stringify(document, null, 2)}\n`);
    const pretty = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-consumer-pretty")));
    expect(pretty.code).toBe("execution.migration-conflict");
    expect(pretty.message).toContain("cross-package encoding conflict");
    expect(pretty.message).toContain("canonical");

    const aggregate = { ...document, consumers: [...(document.consumers as unknown[]), { ...(document.consumers as Array<Record<string, unknown>>)[0], id: "engine" }] };
    writeFileSync(fixture.manifestPath, serializeExecutionValue(aggregate));
    const many = await refusalOf(async () => previewExecutionMigration(migrationInput(fixture, "op-consumer-aggregate")));
    expect(many.code).toBe("execution.migration-conflict");
    expect(many.message).toContain("carries 2 consumer entries");
  });
});
