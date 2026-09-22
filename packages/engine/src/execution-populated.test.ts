/**
 * execution-populated.test.ts — proof for R4: the populated whole-store and
 * retained-body recovery over the accepted coverage graph.
 *
 * One fixture graph carries the named 2b file surfaces at once, over REAL
 * modules, the REAL `node:sqlite` driver and real files: a Git main worktree
 * with a `.mstar` control harness; a running workflow (bound coordinator
 * envelope, the retained notes / agent-flow tail / cursor sidecar / launch
 * journal / root-level durable selection-and-cache snapshot) plus a TERMINAL
 * workflow dir the root register no longer lists; the explicit SDD body, the
 * host-session export the real OMP producer emits, the deployed injector module
 * with its inventory document and the recorded recovery point — all named
 * through the explicit §4.2 inventory, so `previewExecutionMigration` and
 * `collectExecutionCoverage` validate the graph by the reviewed substrate itself
 * rather than by this file's assertions.
 *
 * Acceptance criteria carried by these cases:
 *
 * - `populated graph`: the fixture stages and activates under validated
 *   coverage, the manifest records the explicit discovery scope, and the
 *   retained/selection/host/SDD/injector/recovery rows carry `retain` receipts
 *   while the terminal workflow's unreferenced envelope is `retire`.
 * - `populated recovery`: `backupStore` freezes the DB copy AND the retained
 *   accepted bodies with their record checkpoints; the preview lists the body
 *   and selection differences; the restore preserves append-only post-point
 *   records, does not resurrect a replaced or deleted body, advances the epoch
 *   above both generations and leaves issue/catalog authority in place.
 * - `populated refusals`: a present §5 compaction journal refuses the freeze and
 *   the preview; a missing, forged or other-generation retained inventory
 *   refuses; an unterminated record the point did not record refuses with both
 *   stores and every body retained and asks for an explicit salvage scope; a
 *   restore without the exact loss digest, an approval taken before a later
 *   change, a forged loss-payload generation and a crash/replay each refuse
 *   honestly.
 *
 * Run with `bun test packages/engine/src/execution-populated.test.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerCatalogEntity } from "./catalog.js";
import {
  collectExecutionCoverage,
  applyExecutionMigration,
  activateExecutionMigration,
  executionManifestHash,
  previewExecutionMigration,
  type ExecutionManifest,
} from "./execution-migrate.js";
import type { ExecutionCoverageSet } from "./execution-coverage.js";
import {
  previewExecutionRestore,
  restoreExecutionBackup,
  type ExecutionRecoveryRetainedDifference,
} from "./execution-recovery.js";
import { readExecutionState, serializeExecutionValue } from "./execution-store.js";
import { captureIssue } from "./issue.js";
import {
  assertAuthorityCurrent,
  backupStore,
  currentAuthorityHandle,
  freezeRetainedBodies,
  readRetainedBodyInventory,
  retainedInventoryPath,
  ACTIVATION_PROTOCOL_VERSION,
  type ActivationAttestation,
} from "./store-activation.js";
import { initializeStore, storeDbPath, type StoreContext } from "./store-db.js";
import { WORKFLOW_SNAPSHOT_FILE } from "./workflow.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-populated-"));
const TS = "2026-09-02T00:00:00.000Z";
const OPERATOR = "ops-engineer";
const AUTHORIZATION = "D29 execution recovery";
const INV = "execution-inventory";

const WORKFLOW = "20260921-populated-workflow";
const PLAN = `${WORKFLOW}-plan`;
const TERMINAL_WORKFLOW = "20260921-populated-terminal";
const TERMINAL_PLAN = `${TERMINAL_WORKFLOW}-plan`;
const SESSION = "host-populated-0001";
const TERMINAL_SESSION = "host-populated-terminal-0001";
const ROOT_UPDATED_AT = "2026-09-03";

/**
 * The canonical bytes one H2 producer envelope carries, rebuilt from the
 * producer's own published shape and §4.2's two digest rules rather than copied
 * from a report: the outer document is the engine's canonical serialization
 * with exactly one terminal LF, its embedded H1 export is hashed over that
 * serialization WITHOUT the trailing LF, and each record's `payloadHash` covers
 * its payload's FULL canonical serialization (the same `digestOf` rule the
 * verifier applies). Deriving the bytes here keeps the fixture self-consistent
 * when the embedded identity changes.
 */
function hostEnvelopeBytes(workflowId: string, hostSessionId: string): string {
  const payload = {
    action: "arm",
    baselineModelChangeId: null,
    binding: { sessionId: hostSessionId, workflowId },
    observedModel: null,
    operationId: "op-1",
    reason: null,
    state: "pending",
    version: 1,
  };
  const embedded = {
    diagnostics: [],
    document: "execution-host-history",
    records: [
      {
        entryId: "entry-handoff-1",
        index: 0,
        payload,
        payloadHash: sha256OfBytes(Buffer.from(serializeExecutionValue(payload), "utf8")),
        sessionId: hostSessionId,
        type: "mstar:model-handoff",
        view: {
          cancelled: false,
          checkpointId: null,
          declaredAction: "arm",
          declaredKind: null,
          declaredState: "pending",
          dedupKey: "op-1",
          generation: 1,
          operationId: "op-1",
          provenance: [],
          workflowId,
        },
      },
    ],
    version: 1,
  };
  return serializeExecutionValue({
    version: 1,
    protocol: "host-hidden-inventory-v1",
    workflowId,
    host: "omp",
    hostSessionId,
    export: {
      sha256: sha256OfBytes(Buffer.from(serializeExecutionValue(embedded).slice(0, -1), "utf8")),
      document: embedded,
    },
  });
}

/**
 * The canonical bytes the Hosts track's `exportExecutionHostInventory` produces:
 * one `mstar:model-handoff` entry of ONE native session, bound to ONE workflow,
 * in the released envelope shape. The producer's own output is captured
 * verbatim by C3's interop case; this fixture rebuilds the same bytes for its
 * own identities through the two §4.2 digest rules above.
 */
const PRODUCER_SESSION = "native-session-populated";
const PRODUCER_ENVELOPE = hostEnvelopeBytes(WORKFLOW, PRODUCER_SESSION);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture: one populated control harness
// ---------------------------------------------------------------------------

type Fixture = { root: string; harness: string; context: StoreContext; inventoryPath: string };

type Populated = Fixture & {
  workflowId: string;
  workflowDir: string;
  notesPath: string;
  flowPath: string;
  selectionPath: string;
  launchesPath: string;
  terminalDir: string;
  hostEnvelopePath: string;
  sddPath: string;
  dbPath: string;
};

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2));
}

function sha256OfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256OfFile(path: string): string {
  return sha256OfBytes(readFileSync(path));
}

function rawGet<T>(dbPath: string, sql: string): T | undefined {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get() as T | undefined;
  } finally {
    db.close();
  }
}

/** The typed refusal of one call: its stable code and message. */
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
  throw new Error("expected a refusal, but the call resolved");
}

/** Any failure, typed or not — the crash seam raises a plain error. */
async function errorOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure, but the call resolved");
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

function envelopeOf(sessionId: string, workflowId: string, harness: string) {
  return { schema_version: 1, role: "coordinator", session_id: sessionId, workflow_id: workflowId, harness_root: harness };
}

/** One conforming barrier attestation for the populated graph. */
function populatedAttestation(stoppedSessions: ActivationAttestation["stoppedSessions"]): ActivationAttestation {
  return {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt: "2026-09-21T00:00:00.000Z",
    operator: { actor: OPERATOR, authorizationRef: AUTHORIZATION },
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

/**
 * §4.2 the explicit inventory of this fixture: every configured root and every
 * evidence pointer, written where the operator would write it.
 */
function writeInventory(fixture: Fixture, extra: Record<string, unknown> = {}): void {
  writeJson(fixture.inventoryPath, {
    version: 2,
    roots: {
      sdd: join(fixture.harness, INV, "sdd"),
      host: join(fixture.harness, INV, "host"),
      package: join(fixture.harness, INV, "package"),
    },
    hostSessions: [],
    sddEvidence: [],
    consumers: [],
    injectors: [],
    injectorInventory: null,
    backup: null,
    ...extra,
  });
}

function workspace(name: string): Fixture {
  const root = mkdtempSync(join(ROOT, `${name}-`));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const fixture: Fixture = { root, harness, context: { harnessDir: harness }, inventoryPath: join(harness, INV, "inventory.json") };
  writeInventory(fixture);
  return fixture;
}

/**
 * The populated graph: authority, workflow, terminal history, every retained
 * body, the selection snapshot and each explicit evidence root. Nothing here is
 * a stub — the migration substrate validates these same bytes.
 */
async function populatedWorkspace(name: string): Promise<Populated> {
  const fixture = workspace(name);
  const handle = await initializeStore(fixture.context);
  handle.close();

  const workflowId = WORKFLOW;
  const workflowDir = join(fixture.harness, "workflows", workflowId);
  const notesPath = join(workflowDir, "notes.jsonl");
  const flowPath = join(workflowDir, "agent-flow.jsonl");
  const selectionPath = join(fixture.harness, "snapshots", "engine-status.json");
  const launchesPath = join(workflowDir, "omp-launches.json");
  const envelopePath = join(workflowDir, "sessions", `coordinator-${SESSION}.json`);
  const terminalDir = join(fixture.harness, "workflows", TERMINAL_WORKFLOW);

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
    coordination: { coordinator: { session_id: SESSION, session_file: envelopePath, bound_at: TS } },
    plans: [{ id: PLAN, title: "Populated plan", file: "plans/populated.md", status: "InReview", metadata: {} }],
  });
  writeJson(join(terminalDir, WORKFLOW_SNAPSHOT_FILE), {
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
  writeJson(join(fixture.harness, "status.json"), {
    version: 2,
    updated_at: ROOT_UPDATED_AT,
    workflows: [{ id: workflowId, type: "plan", started_at: "2026-09-01", dir: join("workflows", workflowId) }],
  });
  writeJson(envelopePath, envelopeOf(SESSION, workflowId, fixture.harness));
  // The terminal dir's envelope is referenced by no binding: it is historical
  // evidence the session surface owns, so its row is `retire`.
  writeJson(join(terminalDir, "sessions", `coordinator-${TERMINAL_SESSION}.json`), envelopeOf(TERMINAL_SESSION, TERMINAL_WORKFLOW, fixture.harness));

  // The retained accepted bodies: notes, the agent-flow tail, the cursor
  // sidecar, the launch journal and the root-level durable selection/cache.
  writeText(
    notesPath,
    [
      JSON.stringify({ kind: "note", ts: TS, text: "legacy note body" }),
      JSON.stringify({ version: 1, id: "note-1", workflowId, sessionId: SESSION, kind: "note", ts: TS, text: "recorded" }),
    ].join("\n"),
  );
  writeText(flowPath, JSON.stringify({ v: 1, ts: 1, kind: "dispatch", role: "plan-pm", verdict: "ok", hard: false }));
  writeText(join(workflowDir, "workflow-ledger-cursors.json"), serializeExecutionValue({ v: 2, cursors: { [SESSION]: { next: 2 } } }));
  writeJson(launchesPath, {
    version: 1,
    workflow_id: workflowId,
    coordinator: { session_id: SESSION, session_file: envelopePath },
    intents: [],
  });
  writeJson(selectionPath, {
    sv: 1,
    entries: { [SESSION]: [{ rv: 1, cwd: fixture.root, at: TS, turn: 3, payload: { workflowId } }] },
    bindings: { [SESSION]: { cwd: fixture.root, selectedWorkflowId: workflowId, excludedBeforeSeq: 0 } },
  });

  // The explicit evidence roots: SDD body, host export, injector deployment and
  // the recorded recovery point.
  const evidenceDir = join(fixture.harness, INV);
  const hostEnvelopePath = join(evidenceDir, "host", "host-sessions", "producer.json");
  const attestationPath = join(evidenceDir, "host", "attestation.json");
  const sddPath = join(evidenceDir, "sdd", workflowId, "task-1-report.md");
  const injectorPath = join(evidenceDir, "package", "injectors", "fs-store.js");
  const injectorInventoryPath = join(evidenceDir, "package", "coverage", "injector-inventory.json");
  const backupImagePath = join(evidenceDir, "package", "backups", "store.db");
  const backupInventoryPath = join(evidenceDir, "package", "coverage", "recovery-inventory.json");

  writeText(hostEnvelopePath, PRODUCER_ENVELOPE);
  writeJson(attestationPath, populatedAttestation([{ sessionId: PRODUCER_SESSION, host: "omp", state: "stopped" }]));
  writeText(sddPath, "# populated workflow report");
  writeText(injectorPath, "export const store = {};");
  writeText(
    injectorInventoryPath,
    serializeExecutionValue({
      version: 1,
      protocol: "injector-inventory-v1",
      injectors: [
        { module: { root: "package", path: "injectors/fs-store.js", sha256: sha256OfFile(injectorPath) }, capability: "body-only" },
      ],
    }),
  );
  writeText(backupImagePath, "sqlite-consistent-backup");
  writeText(
    backupInventoryPath,
    serializeExecutionValue({
      version: 1,
      document: "recovery-inventory",
      backup: { path: "backups/store.db", sha256: sha256OfFile(backupImagePath) },
      schemaVersion: 4,
      integrity: "verified",
      coverageDigest: "7".repeat(64),
      recoveryGeneration: 2,
    }),
  );
  writeInventory(fixture, {
    hostSessions: [{ workflowId, host: "omp", sessionId: PRODUCER_SESSION, envelope: hostEnvelopePath, attestation: attestationPath }],
    sddEvidence: [{ workflowId, path: sddPath }],
    injectors: [injectorPath],
    injectorInventory: injectorInventoryPath,
    backup: { image: backupImagePath, inventory: backupInventoryPath },
  });

  return {
    ...fixture,
    workflowId,
    workflowDir,
    notesPath,
    flowPath,
    selectionPath,
    launchesPath,
    terminalDir,
    hostEnvelopePath,
    sddPath,
    dbPath: storeDbPath(fixture.context),
  };
}

function migrationInput(fixture: Fixture, operationId: string) {
  return { context: fixture.context, operationId, operator: OPERATOR, inventoryPath: fixture.inventoryPath };
}

async function coverageOf(fixture: Fixture, manifest: ExecutionManifest): Promise<ExecutionCoverageSet> {
  return collectExecutionCoverage({ ...migrationInput(fixture, "op-coverage"), manifest });
}

/** The exact accepted-record digests of one body, by §5's own index rule. */
function acceptedRecords(path: string): string[] {
  const bytes = readFileSync(path);
  const records: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    records.push(sha256OfBytes(bytes.subarray(start, index)));
    start = index + 1;
  }
  return records;
}

/** One accepted §5 note line, in the released record shape. */
function noteLine(id: string, text: string): string {
  return `${serializeExecutionValue({ version: 1, id, workflowId: WORKFLOW, sessionId: SESSION, kind: "note", ts: TS, text }).trimEnd()}\n`;
}

function retainedOf(differences: readonly ExecutionRecoveryRetainedDifference[], path: string): ExecutionRecoveryRetainedDifference {
  const found = differences.find((difference) => difference.path === path);
  if (found === undefined) throw new Error(`no retained difference was listed for ${path}`);
  return found;
}

/**
 * The issue and catalog authority every case compares across the import and the
 * restore. It is written BEFORE the manifest is previewed, because the reviewed
 * authority pins the catalog revision the apply and the recovery point must
 * both still describe.
 */
async function seedAuthority(fixture: Fixture): Promise<void> {
  await captureIssue(
    fixture.context,
    {
      projectId: "_default",
      title: "Populated authority issue",
      kind: "bug",
      severity: "high",
      impact: "issue authority must survive the execution import and a loss-aware restore",
      acceptance: "the row is present before and after every step",
      sourceIdentity: "qc/populated-issue.md",
      rootCauseKey: "populated-root-cause",
      acceptanceKey: "survives",
      occurrenceKey: "run-populated",
      sourceKind: "qc",
      location: "packages/engine/src/execution-populated.test.ts:1",
      observedBehavior: "the import and the restore must not touch issue rows",
      evidence: ["proof"],
      discoveredAt: TS,
    },
    { operationId: "op-populated-issue", actor: "project-manager" },
  );
  await registerCatalogEntity(
    fixture.context,
    { kind: "plan", id: PLAN, title: "Populated plan", rootKind: "plans", relativePath: "plans/populated.md" },
    { operationId: "op-populated-catalog", actor: "project-manager" },
  );
}

/** Preview, cover, stage and activate the populated graph. */
async function stagePopulated(
  fixture: Populated,
  name: string,
): Promise<{ manifest: ExecutionManifest; coverage: ExecutionCoverageSet; epoch: number }> {
  const backup = await backupStore(fixture.context, { out: join(fixture.harness, "archived", "backups", `${name}-stage.db`) });
  const manifest = await previewExecutionMigration(migrationInput(fixture, `op-${name}-preview`));
  const coverage = await coverageOf(fixture, manifest);
  await applyExecutionMigration({
    ...migrationInput(fixture, `op-${name}-apply`),
    manifest,
    manifestHash: executionManifestHash(manifest),
    backup,
    coverage,
  });
  await activateExecutionMigration({
    ...migrationInput(fixture, `op-${name}-activate`),
    manifestId: manifest.id,
    manifestHash: executionManifestHash(manifest),
    expectedEpoch: manifest.epoch,
    attestation: populatedAttestation([{ sessionId: SESSION, host: "omp", state: "stopped" }]),
    coverageDigest: coverage.digest,
  });
  const state = await readExecutionState(fixture.context);
  return { manifest, coverage, epoch: state.epoch };
}

/** A seeded, staged and ACTIVATED populated graph: where every case starts. */
async function activePopulated(
  name: string,
): Promise<Populated & { manifest: ExecutionManifest; epoch: number; coverageDigest: string }> {
  const fixture = await populatedWorkspace(name);
  await seedAuthority(fixture);
  const staged = await stagePopulated(fixture, name);
  return { ...fixture, manifest: staged.manifest, epoch: staged.epoch, coverageDigest: staged.coverage.digest };
}

// ---------------------------------------------------------------------------
// The populated graph
// ---------------------------------------------------------------------------

describe("populated graph", () => {
  test("populated graph stages and activates under validated coverage with a real receipt per discovered surface", async () => {
    const fixture = await populatedWorkspace("populated-graph");
    await seedAuthority(fixture);
    const staged = await stagePopulated(fixture, "populated-graph");
    const { manifest, coverage } = staged;

    // §4.2: discovery is scoped by the explicit inventory, and the manifest
    // records that scope, every configured root and the surface identities.
    expect(manifest.version).toBe(2);
    expect(manifest.inventoryPath).not.toBeNull();
    expect(manifest.roots.sdd).toBeDefined();
    expect(manifest.roots.host).toBeDefined();
    expect(manifest.roots.package).toBeDefined();
    expect(coverage.receipts.length).toBe(manifest.surfaces.length);
    for (const receipt of coverage.receipts) {
      const row = manifest.surfaces.find((candidate) => candidate.surface === receipt.surface && candidate.workflowId === receipt.workflowId)!;
      expect(receipt.sources).toEqual(row.sources);
    }

    const receiptOf = (surface: string, workflowId: string | null) =>
      coverage.receipts.find((receipt) => receipt.surface === surface && receipt.workflowId === workflowId);
    const surfaces: readonly string[] = coverage.receipts.map((receipt) => receipt.surface);
    for (const expected of [
      "core-execution",
      "workflow-session-envelopes",
      "workflow-notes-ledger",
      "workflow-agent-flow-ledger",
      "workflow-ledger-cursors",
      "engine-status-snapshot",
      "workflow-omp-launch-journal",
      "omp-hidden-entries",
      "sdd-evidence",
      "artifact-store-injectors",
      "backup-recovery",
    ]) {
      expect(surfaces).toContain(expected);
    }

    // The named dispositions. The engine derives the session surface's row from
    // discovery (`coverageDisposition` / `envelopeRowRetires` in
    // `execution-migrate.ts`): a workflow's envelope row is `migrate` unless
    // EVERY envelope of that workflow is unreferenced, in which case it is
    // `retire`; §4.1's closed list for this surface is `migrate | retire |
    // absent`, so it never claims `retain`. A REFERENCED envelope's session
    // identity is imported into `execution_sessions` (and suspended by the
    // barrier) while its bytes stay historical evidence — `retain` is what the
    // file-native bodies use, because they stay bytes and no fact migrates into
    // the database. Every retained file body, the durable selection snapshot,
    // the host export, the SDD body, the injector deployment and the recorded
    // recovery point are `retain`.
    expect(receiptOf("core-execution", null)).toBeDefined();
    expect(["migrate", "retain"]).toContain(receiptOf("core-execution", null)!.disposition);
    expect(receiptOf("workflow-session-envelopes", WORKFLOW)).toMatchObject({ disposition: "migrate", protocol: "session-v1" });
    expect(receiptOf("workflow-session-envelopes", TERMINAL_WORKFLOW)).toMatchObject({ disposition: "retire" });
    expect(receiptOf("workflow-notes-ledger", WORKFLOW)).toMatchObject({ disposition: "retain", protocol: "notes-v1" });
    expect(receiptOf("workflow-agent-flow-ledger", WORKFLOW)).toMatchObject({ disposition: "retain", protocol: "agent-flow-v2" });
    expect(receiptOf("workflow-ledger-cursors", WORKFLOW)).toMatchObject({ disposition: "retain", protocol: "selection-v1" });
    expect(receiptOf("engine-status-snapshot", null)).toMatchObject({ disposition: "retain", protocol: "selection-v1" });
    expect(receiptOf("workflow-omp-launch-journal", WORKFLOW)).toMatchObject({ disposition: "retain", protocol: "omp-launch-v2" });
    expect(receiptOf("omp-hidden-entries", WORKFLOW)).toMatchObject({ disposition: "retain", protocol: "omp-hidden-v1" });
    expect(receiptOf("sdd-evidence", WORKFLOW)).toMatchObject({ disposition: "retain", protocol: "retained-body-v1" });
    expect(receiptOf("artifact-store-injectors", null)).toMatchObject({ disposition: "retain", protocol: "retained-body-v1" });
    expect(receiptOf("backup-recovery", null)).toMatchObject({ disposition: "retain", protocol: "recovery-v1" });

    // The terminal workflow is imported as history with NO root registry
    // membership, and issue/catalog authority is untouched by the import.
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from execution_registry")!.n).toBe(1);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from execution_workflows")!.n).toBe(2);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from issues")!.n).toBe(1);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from catalog_entities")!.n).toBe(1);
    expect(staged.epoch).toBeGreaterThan(manifest.epoch);
  });
});

// ---------------------------------------------------------------------------
// The populated recovery cycle
// ---------------------------------------------------------------------------

describe("populated recovery", () => {
  test("populated recovery freezes the bodies with the point and preserves append-only post-point history", async () => {
    const fixture = await activePopulated("populated-append");
    const preRestoreHandle = await currentAuthorityHandle(fixture.context);
    const point = await backupStore(fixture.context, { out: join(fixture.harness, "archived", "backups", "append-point.db") });

    const frozen = point.retained!;
    expect(frozen.bodies.map((body) => body.path)).toEqual([
      "snapshots/engine-status.json",
      `workflows/${WORKFLOW}/agent-flow.jsonl`,
      `workflows/${WORKFLOW}/notes.jsonl`,
      `workflows/${WORKFLOW}/omp-launches.json`,
      `workflows/${WORKFLOW}/workflow-ledger-cursors.json`,
    ]);
    const frozenNotes = frozen.bodies.find((body) => body.path.endsWith("notes.jsonl"))!;
    expect(frozenNotes.records).toEqual(acceptedRecords(fixture.notesPath));
    expect(frozenNotes.partial).toBeNull();
    expect(frozenNotes.selection).toBe(false);
    expect(frozen.bodies.find((body) => body.path === "snapshots/engine-status.json")!.selection).toBe(true);
    // The inventory is recorded canonically beside the copy and reads back equal.
    expect(await readRetainedBodyInventory(point.backupPath)).toEqual(frozen);

    // A post-point append: §7 preserves it rather than a loss.
    const before = acceptedRecords(fixture.notesPath).length;
    writeFileSync(fixture.notesPath, `${readFileSync(fixture.notesPath, "utf8")}${noteLine("note-2", "recorded after the point")}`);
    expect(acceptedRecords(fixture.notesPath).length).toBe(before + 1);

    const preview = await previewExecutionRestore(fixture.context, point.backupPath);
    expect(retainedOf(preview.retainedDifferences, `workflows/${WORKFLOW}/notes.jsonl`)).toMatchObject({
      kind: "preserved",
      lostRecords: 0,
      preservedRecords: 1,
    });
    expect(preview.retainedDigest).toBe(frozen.digest);
    expect(preview.authorityDifferences).toEqual([]);
    expect(preview.lostOperationIds).toEqual([]);
    // §7 R4/§4.2: the loss payload names the coverage generation the bytes it
    // would install were activated under, read from each store's own record.
    expect(preview.backupCoverageDigest).toBe(fixture.coverageDigest);
    expect(preview.liveCoverageDigest).toBe(fixture.coverageDigest);

    const receipt = await restoreExecutionBackup(fixture.context, {
      preview,
      // Nothing the point held is lost — the only difference is post-point
      // history this restore keeps — so no loss approval is owed.
      acceptLossDigest: null,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });
    expect(receipt.retainedDigest).toBe(frozen.digest);
    expect(receipt.retainedLiveDigest).toBe(preview.retainedLiveDigest);
    expect(receipt.backupCoverageDigest).toBe(fixture.coverageDigest);
    expect(receipt.liveCoverageDigest).toBe(fixture.coverageDigest);
    expect(receipt.epoch).toBe(Math.max(fixture.epoch, point.epoch) + 1);

    // The append survived byte for byte; the stale handle refuses at the new
    // epoch; the historical rows and the issue/catalog authority stay readable.
    expect(acceptedRecords(fixture.notesPath).length).toBe(before + 1);
    expect(readFileSync(fixture.notesPath, "utf8")).toContain("recorded after the point");
    const stale = await refusalOf(() => assertAuthorityCurrent(fixture.context, preRestoreHandle));
    expect(stale.code).toBe("store.stale-epoch");
    await expect(readExecutionState(fixture.context)).resolves.toMatchObject({ epoch: receipt.epoch });
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from issues")!.n).toBe(1);
    expect(rawGet<{ n: number }>(fixture.dbPath, "select count(*) as n from catalog_entities")!.n).toBe(1);
  });

  test("populated recovery discloses replaced and deleted bodies and selection facts, and does not resurrect them", async () => {
    const fixture = await activePopulated("populated-loss");
    const point = await backupStore(fixture.context, { out: join(fixture.harness, "archived", "backups", "loss-point.db") });

    // A replaced selection snapshot, a deleted launch journal and a notes
    // ledger whose accepted set was rewritten rather than extended.
    writeJson(fixture.selectionPath, {
      sv: 1,
      entries: {},
      bindings: { [SESSION]: { cwd: fixture.root, selectedWorkflowId: TERMINAL_WORKFLOW, excludedBeforeSeq: 4 } },
    });
    rmSync(fixture.launchesPath, { force: true });
    writeText(fixture.notesPath, JSON.stringify({ kind: "note", ts: TS, text: "a different legacy body" }));

    const preview = await previewExecutionRestore(fixture.context, point.backupPath);
    const selection = retainedOf(preview.retainedDifferences, "snapshots/engine-status.json");
    expect(selection.kind).toBe("selection");
    expect(selection.lostRecords).toBeGreaterThan(0);
    expect(retainedOf(preview.retainedDifferences, `workflows/${WORKFLOW}/omp-launches.json`)).toMatchObject({
      kind: "deleted",
      liveSha256: null,
    });
    expect(retainedOf(preview.retainedDifferences, `workflows/${WORKFLOW}/notes.jsonl`).lostRecords).toBeGreaterThan(0);

    // Without the exact loss digest the body and selection loss is not accepted.
    const noApproval = await refusalOf(() =>
      restoreExecutionBackup(fixture.context, {
        preview,
        acceptLossDigest: null,
        operator: OPERATOR,
        authorization: AUTHORIZATION,
      }),
    );
    expect(noApproval.code).toBe("execution.recovery-loss-unaccepted");
    expect(noApproval.message).toContain("acceptLossDigest");

    // A body change after the approval invalidates that approval.
    writeText(fixture.flowPath, JSON.stringify({ v: 1, ts: 2, kind: "dispatch", role: "plan-pm", verdict: "ok", hard: false }));
    const stale = await refusalOf(() =>
      restoreExecutionBackup(fixture.context, {
        preview,
        acceptLossDigest: preview.lossDigest,
        operator: OPERATOR,
        authorization: AUTHORIZATION,
      }),
    );
    expect(stale.code).toBe("execution.recovery-loss-unaccepted");
    expect(stale.message).toContain("moved");

    // The exact digest restores, and the disclosed bodies are NOT rolled back:
    // the loss stays exactly as the live store had it.
    const fresh = await previewExecutionRestore(fixture.context, point.backupPath);
    expect(fresh.retainedLiveDigest).not.toBe(preview.retainedLiveDigest);
    const receipt = await restoreExecutionBackup(fixture.context, {
      preview: fresh,
      acceptLossDigest: fresh.lossDigest,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });
    expect(receipt.retainedDifferences).toEqual(fresh.retainedDifferences);
    expect(receipt.retainedDigest).toBe(point.retained!.digest);
    expect(existsSync(fixture.launchesPath)).toBe(false);
    expect(readFileSync(fixture.notesPath, "utf8")).toContain("a different legacy body");

    // The pre-restore safety point still holds the bytes the loss names, and the
    // issue authority survived the replacement.
    const safety = new DatabaseSync(receipt.preRestoreBackup.backupPath, { readOnly: true });
    try {
      const safetyIssues = safety.prepare("select count(*) as n from issues").get() as { n?: unknown };
      expect(safetyIssues.n).toBe(1);
    } finally {
      safety.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("populated refusals", () => {
  test("populated refusals: an unfinished compaction journal refuses the freeze before any byte is written", async () => {
    const fixture = await activePopulated("populated-compaction");
    const journalPath = join(fixture.workflowDir, "agent-flow-compaction.json");
    writeJson(journalPath, {
      version: 1,
      tailBefore: { bytes: 1, sha256: "a".repeat(64) },
      tailAfter: { bytes: 1, sha256: "b".repeat(64) },
      archive: { chunk: "chunk-000001.jsonl", offset: 0, bytes: 1, sha256: "c".repeat(64) },
      lines: 1,
    });
    const liveBytes = sha256OfFile(fixture.dbPath);
    const target = join(fixture.harness, "archived", "backups", "compaction-point.db");
    const frozen = await refusalOf(() => backupStore(fixture.context, { out: target }));
    expect(frozen.code).toBe("store.activation-stale");
    expect(frozen.message).toContain("agent-flow-compaction.json");
    // Nothing was written: neither the image nor its inventory document, and no
    // body or store byte moved.
    expect(existsSync(target)).toBe(false);
    expect(existsSync(retainedInventoryPath(target))).toBe(false);
    expect(sha256OfFile(fixture.dbPath)).toBe(liveBytes);

    // An unfinished compaction in a workflow the point was taken without also
    // refuses the preview, with both stores and every body left in place.
    const clean = await activePopulated("populated-compaction-clean");
    const point = await backupStore(clean.context, { out: join(clean.harness, "archived", "backups", "clean-point.db") });
    const cleanLiveBytes = sha256OfFile(clean.dbPath);
    const pointBytes = sha256OfFile(point.backupPath);
    writeJson(join(clean.workflowDir, "agent-flow-compaction.json"), { version: 1 });
    const preview = await refusalOf(() => previewExecutionRestore(clean.context, point.backupPath));
    expect(preview.code).toBe("store.activation-stale");
    expect(preview.message).toContain("agent-flow-compaction.json");
    expect(sha256OfFile(clean.dbPath)).toBe(cleanLiveBytes);
    expect(sha256OfFile(point.backupPath)).toBe(pointBytes);
  });

  test("populated refusals: a missing, forged or other-generation retained inventory refuses", async () => {
    const fixture = await activePopulated("populated-receipt");
    const point = await backupStore(fixture.context, { out: join(fixture.harness, "archived", "backups", "receipt-point.db") });
    const sidecar = retainedInventoryPath(point.backupPath);
    const recorded = readFileSync(sidecar);

    // Missing: the copy alone is not a loss-aware recovery point.
    rmSync(sidecar, { force: true });
    const missing = await refusalOf(() => previewExecutionRestore(fixture.context, point.backupPath));
    expect(missing.code).toBe("store.activation-stale");
    expect(missing.message).toContain("records no retained-body inventory");

    // Forged: contents that do not hash to the document's own digest.
    const forged = JSON.parse(recorded.toString("utf8")) as { digest: string };
    forged.digest = "f".repeat(64);
    writeFileSync(sidecar, `${JSON.stringify(forged)}\n`);
    const forgedRefusal = await refusalOf(() => previewExecutionRestore(fixture.context, point.backupPath));
    expect(forgedRefusal.code).toBe("store.activation-stale");
    expect(forgedRefusal.message).toContain("does not describe the bodies it claims");

    // Another generation: a well-formed inventory of a different authority
    // generation is not this point's.
    writeFileSync(
      sidecar,
      `${JSON.stringify(freezeRetainedBodies(fixture.context, { storeId: point.storeId, epoch: point.epoch + 1, revision: point.revision }))}\n`,
    );
    const otherGeneration = await refusalOf(() => previewExecutionRestore(fixture.context, point.backupPath));
    expect(otherGeneration.code).toBe("store.activation-stale");
    expect(otherGeneration.message).toContain("not the point's");

    // The recorded document restored verbatim reads back equal, and a body the
    // point froze that is gone entirely is a DISCLOSED loss, not a refusal.
    writeFileSync(sidecar, recorded);
    expect((await readRetainedBodyInventory(point.backupPath)).digest).toBe(point.retained!.digest);
    rmSync(fixture.launchesPath, { force: true });
    const preview = await previewExecutionRestore(fixture.context, point.backupPath);
    expect(retainedOf(preview.retainedDifferences, `workflows/${WORKFLOW}/omp-launches.json`)).toMatchObject({
      kind: "deleted",
      preservedRecords: 0,
    });
  });

  test("populated refusals: an interrupted append refuses with every artifact retained and an explicit salvage scope", async () => {
    const fixture = await activePopulated("populated-interrupted");
    const point = await backupStore(fixture.context, { out: join(fixture.harness, "archived", "backups", "interrupted-point.db") });
    const liveStoreBytes = sha256OfFile(fixture.dbPath);
    const pointBytes = sha256OfFile(point.backupPath);
    const notesBytes = readFileSync(fixture.notesPath);

    // An unterminated record the point never recorded: no accepted identity, so
    // no hash reconciles it, and every artifact stays where it is.
    writeFileSync(fixture.notesPath, `${readFileSync(fixture.notesPath, "utf8")}{"version":1,"id":"note-half"`);
    const refusal = await refusalOf(() => previewExecutionRestore(fixture.context, point.backupPath));
    expect(refusal.code).toBe("execution.recovery-loss-unaccepted");
    expect(refusal.message).toContain("salvage scope");
    expect(refusal.message).toContain("notes.jsonl");
    expect(sha256OfFile(fixture.dbPath)).toBe(liveStoreBytes);
    expect(sha256OfFile(point.backupPath)).toBe(pointBytes);

    // An interrupted tail the POINT recorded is carried: the same state, decided
    // by exact hash instead of guessed.
    writeFileSync(fixture.notesPath, notesBytes);
    writeFileSync(fixture.flowPath, `${readFileSync(fixture.flowPath, "utf8")}{"v":1,"ts":2`);
    const tailPoint = await backupStore(fixture.context, { out: join(fixture.harness, "archived", "backups", "tail-point.db") });
    const frozenTail = tailPoint.retained!.bodies.find((body) => body.path.endsWith("agent-flow.jsonl"))!;
    expect(frozenTail.partial).not.toBeNull();
    const carried = await previewExecutionRestore(fixture.context, tailPoint.backupPath);
    expect(carried.retainedDifferences.some((difference) => difference.path.endsWith("agent-flow.jsonl"))).toBe(false);
    expect(carried.retainedDigest).toBe(tailPoint.retained!.digest);
  });

  test("populated refusals: a forged loss-payload generation, a crash and a replay each refuse honestly", async () => {
    const fixture = await activePopulated("populated-generation");
    const point = await backupStore(fixture.context, { out: join(fixture.harness, "archived", "backups", "generation-point.db") });
    writeFileSync(fixture.notesPath, `${readFileSync(fixture.notesPath, "utf8")}${noteLine("note-3", "after the point")}`);
    const preview = await previewExecutionRestore(fixture.context, point.backupPath);
    expect(preview.version).not.toBe(1);

    // §7 R4: an older loss-payload generation is refused by NAME rather than
    // silently restoring without the body loss it cannot describe.
    const oldGeneration = await refusalOf(() =>
      restoreExecutionBackup(fixture.context, {
        preview: { ...preview, version: 1 },
        acceptLossDigest: preview.lossDigest,
        operator: OPERATOR,
        authorization: AUTHORIZATION,
      }),
    );
    expect(oldGeneration.code).toBe("execution.migration-conflict");
    expect(oldGeneration.message).toContain("loss-payload version 1");

    // A crash before the replacement: the durable receipt identifies both sides
    // by hash and carries the retained digests the retry re-derives.
    const crash = await withEnv({ MSTAR_STORE_FAIL_EXECUTION_RESTORE: "before-replacement" }, () =>
      errorOf(() =>
        restoreExecutionBackup(fixture.context, {
          preview,
          acceptLossDigest: preview.lossDigest,
          operator: OPERATOR,
          authorization: AUTHORIZATION,
        }),
      ),
    );
    expect(crash.message).toContain("before-replacement");
    const receiptDir = join(fixture.harness, "archived", "store-migration", "recovery");
    const names = readdirSync(receiptDir).filter((name) => name.startsWith("restore-"));
    const pending = JSON.parse(readFileSync(join(receiptDir, names[names.length - 1]!), "utf8")) as Record<string, unknown>;
    expect(pending.phase).toBe("replacing");
    expect(pending.liveStoreSha256).toBe(sha256OfFile(fixture.dbPath));
    expect(pending.restoredCopySha256).not.toBe(pending.liveStoreSha256);
    expect(pending.retainedDigest).toBe(preview.retainedDigest);
    expect(pending.retainedLiveDigest).toBe(preview.retainedLiveDigest);

    // A replay after a later body change refuses: the retained set the approved
    // loss described is no longer the live set. The rewritten body stays a
    // complete accepted record (one terminal LF), so the refusal it reaches is
    // the moved loss, not an interrupted append.
    writeFileSync(fixture.flowPath, `${JSON.stringify({ v: 1, ts: 3, kind: "dispatch", role: "plan-pm", verdict: "ok", hard: false })}\n`);
    const moved = await refusalOf(() =>
      restoreExecutionBackup(fixture.context, {
        preview,
        acceptLossDigest: preview.lossDigest,
        operator: OPERATOR,
        authorization: AUTHORIZATION,
      }),
    );
    expect(moved.code).toBe("execution.recovery-loss-unaccepted");
    expect(moved.message).toContain("moved");

    // …and the clean replay of the same attempt installs the point.
    const fresh = await previewExecutionRestore(fixture.context, point.backupPath);
    const receipt = await restoreExecutionBackup(fixture.context, {
      preview: fresh,
      acceptLossDigest: fresh.lossDigest,
      operator: OPERATOR,
      authorization: AUTHORIZATION,
    });
    expect(receipt.storeId).toBe(point.storeId);
    expect(receipt.epoch).toBe(Math.max(fresh.liveEpoch, point.epoch) + 1);
    const finalized = JSON.parse(readFileSync(receipt.recoveryReceiptPath, "utf8")) as Record<string, unknown>;
    expect(finalized.phase).toBe("replaced");
    expect(finalized.retainedDifferences).toEqual(fresh.retainedDifferences);
  });

  test("populated refusals: a symlinked workflow body dir refuses the freeze", async () => {
    const fixture = await activePopulated("populated-symlink");
    const notesBytes = readFileSync(fixture.notesPath);
    mkdirSync(join(fixture.harness, "elsewhere"), { recursive: true });
    symlinkSync(fixture.workflowDir, join(fixture.harness, "workflows", "linked-workflow"));
    const target = join(fixture.harness, "archived", "backups", "symlink-point.db");
    const refusal = await refusalOf(() => backupStore(fixture.context, { out: target }));
    expect(refusal.code).toBe("store.activation-stale");
    expect(refusal.message).toContain("symlink");
    expect(existsSync(target)).toBe(false);
    // The real body dir is untouched by the refusal.
    expect(readFileSync(fixture.notesPath).equals(notesBytes)).toBe(true);
  });
});
