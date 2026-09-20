/**
 * execution-migrate.test.ts — proof for the R1 migration protocol: the
 * read-only preview and the staged apply (primary spec §6 items 1–2, plan
 * `20260920-activation-migration-recovery`).
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
 *
 * Run with
 * `bun test packages/engine/src/execution-migrate.test.ts --test-name-pattern 'execution-preview|execution-stage'`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCatalogEntity } from "./catalog.js";
import { executionInputHash } from "./coordination.js";
import {
  applyExecutionMigration,
  executionManifestHash,
  previewExecutionMigration,
  type ExecutionManifest,
} from "./execution-migrate.js";
import { readExecutionState } from "./execution-store.js";
import { captureIssue } from "./issue.js";
import { assertBackupDescribesStore, backupStore, canonicalPath, type BackupReceipt } from "./store-activation.js";
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

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture: a real legacy execution workspace
// ---------------------------------------------------------------------------

type Fixture = { root: string; harness: string; context: StoreContext };

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
  return { root, harness, context: { harnessDir: harness } };
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
    branch: { source: `feature/${workflowId}`, target: "main" },
    coordination: { coordinator: bindingOf(COORDINATOR_SESSION, coordinatorEnvelope) },
    integration_merge_lease: {
      holder: PLAN_A_SESSION,
      claimed_at: TS,
      plan_id: PLAN_A,
      source_branch: `feature/${PLAN_A}`,
      target_branch: "iteration/iter-example",
    },
    plans: [
      {
        id: PLAN_A,
        title: "Migration plan A",
        file: "plans/plan-a.md",
        status: "InProgress",
        metadata: scopeOf(PLAN_A),
        coordination: { revision: 3, session: bindingOf(PLAN_A_SESSION, planEnvelopes[PLAN_A]) },
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
  return { context: fixture.context, operationId, operator: "ops-engineer" };
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
    ...migrationInput(fixture, `op-apply-${suffix}`),
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
// Preview
// ---------------------------------------------------------------------------

describe("execution-preview", () => {
  test("execution-preview-inventory-writes-nothing", async () => {
    const fixture = await legacyWorkspace("preview-inventory");
    const before = protectedBytes(fixture.protectedPaths);
    const footprint = storeFootprint(fixture.dbPath);

    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-preview-1"));

    expect(manifest.version).toBe(1);
    expect(manifest.id.startsWith("exec-")).toBe(true);
    expect(manifest.root).toBe(canonicalPath(dirname(storeDbPath(fixture.context))));
    expect(manifest.storeId).toBe((footprint.storeMeta as { store_id: string }).store_id);
    expect(manifest.epoch).toBe((footprint.storeMeta as { authority_epoch: number }).authority_epoch);
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.catalogRevision).toBe((footprint.storeMeta as { catalog_revision: number }).catalog_revision);
    expect(manifest.pendingCatalogOperations).toEqual([]);
    expect(manifest.sources.map((witness) => witness.kind)).toEqual([
      "root",
      "workflow",
      "session-envelope",
      "session-envelope",
      "session-envelope",
    ]);
    expect(manifest.sources.map((witness) => witness.path)).toEqual([
      canonicalPath(fixture.statusPath),
      canonicalPath(fixture.snapshotPath),
      canonicalPath(fixture.coordinatorEnvelope),
      canonicalPath(fixture.planEnvelopes[PLAN_A]),
      canonicalPath(fixture.planEnvelopes[PLAN_B]),
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
    const refusal = await refusalOf(() => previewExecutionMigration(migrationInput(fixture, "op-missing")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("does not exist");
  });

  test("execution-preview-refuses-an-envelope-identity-mismatch", async () => {
    const fixture = await legacyWorkspace("preview-envelope-identity");
    writeJson(fixture.planEnvelopes[PLAN_A], envelopeOf("plan-pm", "host-someone-else", fixture.workflowId, fixture.harness, PLAN_A));
    const refusal = await refusalOf(() => previewExecutionMigration(migrationInput(fixture, "op-identity")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain(PLAN_A_SESSION);
  });

  test("execution-preview-refuses-a-symlinked-source", async () => {
    const fixture = await legacyWorkspace("preview-symlink");
    const outside = join(fixture.root, "outside-envelope.json");
    writeFileSync(outside, readFileSync(fixture.planEnvelopes[PLAN_B]));
    rmSync(fixture.planEnvelopes[PLAN_B]);
    symlinkSync(outside, fixture.planEnvelopes[PLAN_B]);
    const refusal = await refusalOf(() => previewExecutionMigration(migrationInput(fixture, "op-symlink")));
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
    const refusal = await refusalOf(() => previewExecutionMigration(migrationInput(fixture, "op-foreign-pin")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("pins catalog store");
  });

  test("execution-preview-refuses-a-catalog-binding-that-disagrees", async () => {
    const fixture = await legacyWorkspace("preview-binding-conflict");
    const storeId = rawGet<{ store_id: string }>(fixture.dbPath, "select store_id from store_meta where id = 1")!.store_id;
    const pin = { store_id: storeId, entity_revision: 3, document_hash: "2".repeat(64), relation_hash: "3".repeat(64) };
    const snapshot = JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as {
      plans: Array<{ id: string; metadata: Record<string, unknown> }>;
    };
    snapshot.plans[0]!.metadata.catalog_pin = pin;
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
    const refusal = await refusalOf(() => previewExecutionMigration(migrationInput(fixture, "op-binding")));
    expect(refusal.code).toBe("execution.migration-conflict");
    expect(refusal.message).toContain("neither side wins silently");
  });

  test("execution-preview-refuses-an-unclassified-workflow-entry", async () => {
    const fixture = await legacyWorkspace("preview-unclassified");
    writeText(join(fixture.workflowDir, "stray-artifact.txt"), "not a source this inventory classifies");
    const refusal = await refusalOf(() => previewExecutionMigration(migrationInput(fixture, "op-unclassified")));
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
    const refusal = await refusalOf(() => previewExecutionMigration(migrationInput(fixture, "op-unrecognized-field")));
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
    const refusal = await refusalOf(() => previewExecutionMigration(migrationInput(fixture, "op-pending")));
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
    expect(manifest.sources.filter((witness) => witness.kind === "deferred").map((witness) => witness.path)).toEqual([
      canonicalPath(join(fixture.workflowDir, "notes.jsonl")),
      canonicalPath(join(fixture.harness, "snapshots", "engine-status.json")),
    ]);
  });

  test("execution-preview-refuses-an-active-execution-authority", async () => {
    const fixture = await legacyWorkspace("preview-active-authority");
    rawRun(fixture.dbPath, "update execution_meta set authority_state = 'active' where id = 1");
    const refusal = await refusalOf(() => previewExecutionMigration(migrationInput(fixture, "op-active")));
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
      ...migrationInput(fixture, "op-stage-apply"),
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
    expect(JSON.parse(plans[0]!.coordination_json)).toEqual({});
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
    expect(JSON.parse(mergeLeases[0]!.lease_json)).toMatchObject({ status: "held", plan_id: PLAN_A, holder: PLAN_A_SESSION });

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
    const first = await applyExecutionMigration({ ...migrationInput(fixture, "op-replay-apply"), manifest, manifestHash, backup });
    const footprint = storeFootprint(fixture.dbPath);

    const second = await applyExecutionMigration({ ...migrationInput(fixture, "op-replay-apply-again"), manifest, manifestHash, backup });
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

    const refusal = await refusalOf(() =>
      applyExecutionMigration({
        ...migrationInput(fixture, "op-drift-apply"),
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
    const refusal = await refusalOf(() =>
      applyExecutionMigration({ ...migrationInput(fixture, "op-pair-apply"), manifest, manifestHash: "0".repeat(64), backup }),
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
    const stale = await refusalOf(() =>
      applyExecutionMigration({
        ...migrationInput(fixture, "op-unverified-apply"),
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
      withEnv({ MSTAR_STORE_FAIL_EXECUTION_IMPORT_AFTER: "1" }, () =>
        applyExecutionMigration({
          ...migrationInput(fixture, "op-rollback-apply"),
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
      ...migrationInput(fixture, "op-second-apply-1"),
      manifest: first,
      manifestHash: executionManifestHash(first),
      backup,
    });
    const second = await previewExecutionMigration(migrationInput(fixture, "op-second-preview-2"));
    const other: ExecutionManifest = { ...second, id: `${second.id}-other` };
    const refusal = await refusalOf(() =>
      applyExecutionMigration({
        ...migrationInput(fixture, "op-second-apply-2"),
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
      withEnv({ MSTAR_EXECUTION_MIGRATION_LOCK_WAIT_MS: "120" }, () =>
        applyExecutionMigration({
          ...migrationInput(fixture, "op-locks-apply"),
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

    const refusal = await refusalOf(() =>
      applyExecutionMigration({
        ...migrationInput(fixture, "op-escape-apply"),
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
    // A workflow dir carrying a real deferred ledger still stages: the surface
    // is reported blocked in the manifest for the 2b (and R2) barrier to read —
    // staging never claims activation readiness.
    const fixture = await legacyWorkspace("stage-deferred-surface");
    const ledger = join(fixture.workflowDir, "agent-flow.jsonl");
    writeText(ledger, '{"v":1,"ts":1,"kind":"dispatch"}');
    const backup = await recoveryPoint(fixture);
    const manifest = await previewExecutionMigration(migrationInput(fixture, "op-deferred-preview"));
    expect(manifest.deferred.find((surface) => surface.surface === "workflow-agent-flow-ledger")).toMatchObject({
      disposition: "blocked",
      paths: [canonicalPath(ledger)],
    });
    const receipt = await applyExecutionMigration({
      ...migrationInput(fixture, "op-deferred-apply"),
      manifest,
      manifestHash: executionManifestHash(manifest),
      backup,
    });
    expect(receipt.phase).toBe("staged");
    expect(readFileSync(ledger, "utf8")).toBe('{"v":1,"ts":1,"kind":"dispatch"}\n');
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
