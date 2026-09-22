/**
 * CLI `mstar store execution` — C6 (phase 2b execution contract §3.2/§6/§7).
 *
 * Run with `bun test packages/cli/test/execution-migrate.test.ts`.
 *
 * Every case runs the REAL CLI entry as a subprocess against a temporary Git
 * workspace holding a REAL store plus a REAL populated legacy execution
 * workspace (a v2 root register, a registered snapshot with a coordinator
 * binding, a per-plan plan-pm session and a held execution lease), and drives
 * the real engine migration/recovery operations through the commands. Nothing
 * here runs against this repository's control root: every store is a temporary
 * fixture, and no assertion reads a credential file.
 *
 * Acceptance criteria carried by these cases:
 *
 * - `operator family`: the populated workspace reaches preview → coverage →
 *   apply → activate (with a real stop attestation naming every imported owner)
 *   → current-epoch stopped-coordinator recovery under an independent caller
 *   identity → retire, with the imported authority revoked, the imported held
 *   lease represented rather than adopted, and a stable replay per verb; a
 *   staged manifest returns to legacy through `abort` with every source byte
 *   preserved.
 * - `refusals`: a missing coverage / inventory / recovery-point receipt /
 *   operation / operator / attestation / reason / loss confirmation, a coverage
 *   set of another manifest, a malformed loss preview and an unknown flag each
 *   refuse without writing authority.
 * - `recovery`: restore-preview inventories the recovery point and reports the
 *   authority rows that point predates as the loss (an `execution` domain
 *   difference at minimum, under the canonical digest), and restore replaces
 *   the store only under the EXACT approved loss digest; the diagnostic export
 *   reports the key names it dropped and carries no concrete session identity
 *   (session rows without one, no envelope path, the recovery successor absent).
 * - `route`: the execution verbs live under `store execution`, while
 *   `store activate` remains the issue/catalog barrier.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  initializeStore,
  readExecutionAuthority,
  serializeExecutionValue,
  type ExecutionIdentity,
  type ExecutionPlanView,
  type StoreContext,
} from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

const WORKFLOW_ID = "wf-cli-c6";
const PLAN_ID = "20260921-cli-c6-plan";
const COORDINATOR_SESSION = "host-c6-coordinator";
const PLAN_SESSION = "host-c6-plan-pm";
const SUCCESSOR_SESSION = "host-c6-coordinator-successor";
const OPERATOR = "cli-c6-operator";
const TS = "2026-09-22T00:00:00.000Z";
const ROOT_UPDATED_AT = "2026-09-22";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  harnessDir: string;
  context: StoreContext;
  dbPath: string;
  inventoryPath: string;
  statusPath: string;
  snapshotPath: string;
  coordinatorEnvelope: string;
  planEnvelope: string;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface ReviewedArtifacts {
  manifestPath: string;
  coveragePath: string;
  manifestId: string;
  manifestHash: string;
  coverageDigest: string;
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2));
}

/** Spawn the real CLI entry with the ambient harness/identity channels pinned out of the child. */
function runCli(args: string[], fixture: Fixture, executionIdentity?: ExecutionIdentity): RunResult {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (key === "MSTAR_HOST_SESSION_ID" || key === "MSTAR_EXECUTION_IDENTITY") continue;
    if (value !== undefined) env[key] = value;
  }
  env.MSTAR_HARNESS_DIR = fixture.harnessDir;
  if (executionIdentity !== undefined) env.MSTAR_EXECUTION_IDENTITY = serializeExecutionValue(executionIdentity);
  const child = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: fixture.root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

function jsonOf(result: RunResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON stdout, got ${JSON.stringify(result.stdout)} (stderr: ${result.stderr})`);
  }
}

function dataOf(result: RunResult): Record<string, unknown> {
  const data = jsonOf(result).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`expected a data object, got ${result.stdout}`);
  }
  return data as Record<string, unknown>;
}

/** One successful verb: exit 0, the execution route and the verb's own operation name. */
function expectSuccess(result: RunResult, operation: string): Record<string, unknown> {
  if (result.exitCode !== 0) {
    throw new Error(`expected exit 0 from ${operation}, got ${String(result.exitCode)} (stdout: ${result.stdout} stderr: ${result.stderr})`);
  }
  const envelope = jsonOf(result);
  expect(envelope.ok).toBe(true);
  expect(envelope.route).toBe("execution");
  expect(envelope.operation).toBe(operation);
  return envelope;
}

/** One usage refusal: exit 2, the execution route, the `usage` code and the missing parameter named. */
function expectUsageRefusal(result: RunResult, operation: string, mentions: string): void {
  expect(result.exitCode).toBe(2);
  const envelope = jsonOf(result);
  expect(envelope.ok).toBe(false);
  expect(envelope.route).toBe("execution");
  expect(envelope.operation).toBe(operation);
  expect(envelope.code).toBe("usage");
  expect(String(envelope.message)).toContain(mentions);
}

/** The same argument vector without one flag and its value (for the missing-parameter cases). */
function withoutFlag(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  return index === -1 ? [...args] : [...args.slice(0, index), ...args.slice(index + 2)];
}

/**
 * A populated legacy execution workspace: a store whose execution authority is
 * still `legacy`, a v2 root register with one registered workflow, a snapshot
 * carrying a coordinator binding and a held plan lease, the session envelopes
 * those bindings name, and the explicit operator inventory (§4.2).
 */
async function legacyFixture(label: string): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });

  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const context: StoreContext = { harnessDir };
  const store = await initializeStore(context);
  store.close();

  const inventoryDir = join(harnessDir, "execution-inventory");
  const inventoryPath = join(inventoryDir, "inventory.json");
  writeJson(inventoryPath, {
    version: 2,
    roots: { sdd: join(inventoryDir, "sdd"), host: join(inventoryDir, "host"), package: join(inventoryDir, "package") },
    hostSessions: [],
    sddEvidence: [],
    consumers: [],
    injectors: [],
    injectorInventory: null,
    backup: null,
  });

  const workflowDir = join(harnessDir, "workflows", WORKFLOW_ID);
  const coordinatorEnvelope = join(workflowDir, "sessions", `coordinator-${COORDINATOR_SESSION}.json`);
  const planEnvelope = join(workflowDir, "sessions", `plan-pm-${PLAN_SESSION}.json`);
  const snapshotPath = join(workflowDir, "snapshot.json");
  const statusPath = join(harnessDir, "status.json");
  const planWorktree = join(root, "wt-cli-c6");

  writeJson(statusPath, {
    version: 2,
    updated_at: ROOT_UPDATED_AT,
    workflows: [{ id: WORKFLOW_ID, type: "plan", started_at: "2026-09-01", dir: join("workflows", WORKFLOW_ID) }],
  });
  writeJson(snapshotPath, {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    status: "running",
    started_at: "2026-09-01",
    updated_at: "2026-09-02",
    delivery_kind: "development",
    project: "_default",
    branch: { source: `feature/${WORKFLOW_ID}`, target: "main" },
    coordination: { coordinator: { session_id: COORDINATOR_SESSION, session_file: coordinatorEnvelope, bound_at: TS } },
    plans: [
      {
        id: PLAN_ID,
        title: "CLI C6 populated plan",
        file: `plans/${PLAN_ID}.md`,
        status: "InProgress",
        metadata: { worktree_path: planWorktree, working_branch: `feature/${PLAN_ID}` },
        coordination: { revision: 3, session: { session_id: PLAN_SESSION, session_file: planEnvelope, bound_at: TS } },
        execution_lease: {
          holder: PLAN_SESSION,
          claimed_at: TS,
          worktree_path: planWorktree,
          working_branch: `feature/${PLAN_ID}`,
          base_sha: "a".repeat(40),
        },
      },
    ],
  });
  writeJson(coordinatorEnvelope, {
    schema_version: 1,
    role: "coordinator",
    session_id: COORDINATOR_SESSION,
    workflow_id: WORKFLOW_ID,
    harness_root: harnessDir,
  });
  writeJson(planEnvelope, {
    schema_version: 1,
    role: "plan-pm",
    session_id: PLAN_SESSION,
    workflow_id: WORKFLOW_ID,
    harness_root: harnessDir,
    plan_id: PLAN_ID,
  });

  return {
    root,
    harnessDir,
    context,
    dbPath: join(harnessDir, "store.db"),
    inventoryPath,
    statusPath,
    snapshotPath,
    coordinatorEnvelope,
    planEnvelope,
  };
}

/**
 * The §7 stop attestation: exactly one CURRENT coordinator consumer (the
 * document rule) and one stopped entry per imported owner — which is also the
 * evidence a current-epoch stopped-coordinator recovery names its prior holder
 * with.
 */
function stopAttestation(stoppedSessions: readonly string[]): Record<string, unknown> {
  return {
    version: 1,
    attestedAt: TS,
    operator: { actor: OPERATOR, authorizationRef: "cli C6 execution activation" },
    consumers: [
      {
        entryId: "cli-global",
        kind: "coordinator",
        entrypoint: "/usr/local/lib/node_modules/@mstar-harness/cli/dist/index.js",
        runtime: "bun",
        runtimeVersion: "1.4.0",
        version: "3.11.2",
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions: stoppedSessions.map((sessionId) => ({ sessionId, host: "omp", state: "stopped" })),
  };
}

/** The documented preview invocation over one fixture, asserted through its own envelope. */
function previewAndCover(fixture: Fixture, label: string): ReviewedArtifacts {
  const manifestPath = join(fixture.root, `${label}-manifest.json`);
  const coveragePath = join(fixture.root, `${label}-coverage.json`);
  const preview = runCli([
    "store",
    "execution",
    "preview",
    "--operation",
    `${label}-preview`,
    "--operator",
    OPERATOR,
    "--inventory",
    fixture.inventoryPath,
    "--out",
    manifestPath,
    "--coverage-out",
    coveragePath,
    "--harness",
    fixture.harnessDir,
    "--json",
  ], fixture);
  const summary = dataOf(preview);
  expectSuccess(preview, "preview");
  expect(summary.version).toBe(2);
  expect(summary.inventoryPath).toBe(fixture.inventoryPath);
  expect(existsSync(manifestPath)).toBe(true);
  expect(existsSync(coveragePath)).toBe(true);
  const manifestHash = String(summary.manifestHash);
  const coverageDigest = String(summary.coverageDigest);
  expect(manifestHash).toMatch(/^[0-9a-f]{64}$/);
  expect(coverageDigest).toMatch(/^[0-9a-f]{64}$/);
  return { manifestPath, coveragePath, manifestId: String(summary.manifestId), manifestHash, coverageDigest };
}

/** `apply`'s documented argument vector, always with the reviewed inventory the manifest records. */
function applyFamily(fixture: Fixture, reviewed: ReviewedArtifacts, receiptPath: string, operation: string): string[] {
  return [
    "store",
    "execution",
    "apply",
    "--manifest",
    reviewed.manifestPath,
    "--coverage",
    reviewed.coveragePath,
    "--backup",
    receiptPath,
    "--inventory",
    fixture.inventoryPath,
    "--operation",
    operation,
    "--operator",
    OPERATOR,
    "--harness",
    fixture.harnessDir,
    "--json",
  ];
}

/** `activate`'s documented argument vector, always with the reviewed inventory the manifest records. */
function activateFamily(fixture: Fixture, reviewed: ReviewedArtifacts, attestationPath: string, operation: string): string[] {
  return [
    "store",
    "execution",
    "activate",
    "--manifest",
    reviewed.manifestPath,
    "--coverage",
    reviewed.coveragePath,
    "--attestation",
    attestationPath,
    "--inventory",
    fixture.inventoryPath,
    "--operation",
    operation,
    "--operator",
    OPERATOR,
    "--harness",
    fixture.harnessDir,
    "--json",
  ];
}

/** A verified recovery point taken through the existing store verb, as an operator takes one. */
function takeRecoveryPoint(fixture: Fixture, label: string): { imagePath: string; receiptPath: string } {
  const imagePath = join(fixture.harnessDir, "archived", "backups", `${label}-point.db`);
  const backup = runCli(["store", "backup", "--out", imagePath, "--harness", fixture.harnessDir, "--json"], fixture);
  const data = dataOf(backup);
  expect(backup.exitCode).toBe(0);
  expect(data.backupPath).toBe(imagePath);
  const receiptPath = join(fixture.root, `${label}-backup-receipt.json`);
  writeJson(receiptPath, data);
  return { imagePath, receiptPath };
}

/** The execution authority row of one fixture store, read straight from SQLite. */
function executionAuthorityOf(fixture: Fixture): { authority_state: string; manifest_id: string | null; revision: number } {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    return db.prepare("select authority_state, manifest_id, revision from execution_meta where id = 1").get() as {
      authority_state: string;
      manifest_id: string | null;
      revision: number;
    };
  } finally {
    db.close();
  }
}

/** The issue/catalog authority row: the route this family must never move. */
function issueCatalogAuthorityOf(fixture: Fixture): { authority_state: string; catalog_revision: number } {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    return db.prepare("select authority_state, catalog_revision from store_meta where id = 1").get() as {
      authority_state: string;
      catalog_revision: number;
    };
  } finally {
    db.close();
  }
}

function stagedManifestCount(fixture: Fixture): number {
  const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    return (db.prepare("select count(*) as n from execution_migrations").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** The workflow token the active writes consume, read through the engine (never the CLI's own claim). */
async function workflowTokenOf(fixture: Fixture): Promise<string> {
  const state = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID });
  if (!("workflows" in state.data)) throw new Error("the workflow read did not return the whole state");
  const workflow = state.data.workflows.find((entry) => entry.state.id === WORKFLOW_ID);
  if (workflow === undefined) throw new Error(`workflow ${WORKFLOW_ID} is not in the authority register`);
  return workflow.workflowToken;
}

async function planViewOf(fixture: Fixture): Promise<ExecutionPlanView> {
  const read = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
  if (!("plan" in read.data)) throw new Error("the plan read did not return a plan view");
  return read.data;
}

/** The held-lease facts of a plan view: its status and the holder the row still names. */
function leaseFacts(view: ExecutionPlanView): { status: unknown; holder: unknown } {
  const lease = view.executionLease as { status?: unknown; holder_session_id?: unknown } | null;
  return { status: lease?.status, holder: lease?.holder_session_id };
}

describe("mstar store execution \u2014 the operator family over populated input", () => {
  test("preview, apply, activate, stopped-coordinator recovery and retire reach the real engine operations", async () => {
    const fixture = await legacyFixture("cli-c6-operator");
    const protectedPaths = [fixture.statusPath, fixture.snapshotPath, fixture.coordinatorEnvelope, fixture.planEnvelope];
    const protectedBefore = protectedPaths.map((path) => readFileSync(path).toString("base64"));

    // ── §6 item 1: the preview is read-only and its replay is stable
    const reviewed = previewAndCover(fixture, "operator");
    const secondManifest = join(fixture.root, "operator-manifest-2.json");
    const secondCoverage = join(fixture.root, "operator-coverage-2.json");
    const replay = runCli([
      "store",
      "execution",
      "preview",
      "--operation",
      "operator-preview-2",
      "--operator",
      OPERATOR,
      "--inventory",
      fixture.inventoryPath,
      "--out",
      secondManifest,
      "--coverage-out",
      secondCoverage,
      "--harness",
      fixture.harnessDir,
      "--json",
    ], fixture);
    const replaySummary = dataOf(replay);
    expectSuccess(replay, "preview");
    expect(replaySummary.manifestId).toBe(reviewed.manifestId);
    expect(replaySummary.manifestHash).toBe(reviewed.manifestHash);
    expect(replaySummary.coverageDigest).toBe(reviewed.coverageDigest);
    expect(readFileSync(secondManifest).toString("utf8")).toBe(readFileSync(reviewed.manifestPath).toString("utf8"));
    expect(readFileSync(secondCoverage).toString("utf8")).toBe(readFileSync(reviewed.coveragePath).toString("utf8"));

    // Nothing was written: every protected source byte is identical, no manifest
    // was recorded and the execution authority is still the legacy one.
    expect(protectedPaths.map((path) => readFileSync(path).toString("base64"))).toEqual(protectedBefore);
    expect(stagedManifestCount(fixture)).toBe(0);
    expect(executionAuthorityOf(fixture).authority_state).toBe("legacy");

    // ── §6 item 2: apply stages behind a verified recovery point, and replays
    const point = takeRecoveryPoint(fixture, "operator");
    const applyArgs = applyFamily(fixture, reviewed, point.receiptPath, "operator-apply");
    const applied = runCli(applyArgs, fixture);
    const staged = dataOf(applied);
    expectSuccess(applied, "apply");
    expect(staged.phase).toBe("staged");
    expect(staged.replayed).toBe(false);
    expect(staged.manifestId).toBe(reviewed.manifestId);
    const executionAfterApply = executionAuthorityOf(fixture);
    expect(executionAfterApply.authority_state).toBe("staged");
    const catalogAfterApply = issueCatalogAuthorityOf(fixture);
    expect(catalogAfterApply.authority_state).toBe("active");

    const replayedApply = runCli(applyArgs, fixture);
    expect(replayedApply.exitCode).toBe(0);
    expect(jsonOf(replayedApply).operation).toBe("apply");
    expect(dataOf(replayedApply).replayed).toBe(true);
    expect(executionAuthorityOf(fixture)).toEqual(executionAfterApply);

    // ── §6 item 3: the barrier advances the store-wide epoch exactly once
    const attestationPath = join(fixture.root, "operator-attestation.json");
    writeJson(attestationPath, stopAttestation([COORDINATOR_SESSION, PLAN_SESSION]));
    const activateArgs = activateFamily(fixture, reviewed, attestationPath, "operator-activate");
    const activated = runCli(activateArgs, fixture);
    const activation = dataOf(activated);
    expectSuccess(activated, "activate");
    expect(activation.phase).toBe("active");
    expect(activation.replayed).toBe(false);
    const executionAfterActivation = executionAuthorityOf(fixture);
    expect(executionAfterActivation.authority_state).toBe("active");
    expect(executionAfterActivation.manifest_id).toBe(reviewed.manifestId);
    // The execution barrier is not the issue/catalog one: that authority is untouched.
    expect(issueCatalogAuthorityOf(fixture)).toEqual(catalogAfterApply);

    const replayedActivate = runCli(activateArgs, fixture);
    expect(replayedActivate.exitCode).toBe(0);
    expect(dataOf(replayedActivate).replayed).toBe(true);
    expect(executionAuthorityOf(fixture)).toEqual(executionAfterActivation);

    // The imported references authorize nothing, and the imported HELD lease is
    // represented rather than adopted (no lease takeover is claimed anywhere).
    const activatedPlan = await planViewOf(fixture);
    expect(activatedPlan.session).toBeNull();
    expect(leaseFacts(activatedPlan)).toEqual({ status: "held", holder: PLAN_SESSION });

    // ── current-epoch stopped-coordinator recovery under an independent identity
    const successor: ExecutionIdentity = {
      source: "local",
      sessionId: SUCCESSOR_SESSION,
      workflowId: WORKFLOW_ID,
      role: "coordinator",
      planId: null,
    };
    const recoverArgs = [
      "session",
      "recover",
      "--workflow",
      WORKFLOW_ID,
      "--prior-session",
      COORDINATOR_SESSION,
      "--reason",
      "the imported coordinator stopped before the cutover",
      "--attestation",
      attestationPath,
      "--expect",
      await workflowTokenOf(fixture),
      "--operation",
      "operator-recover",
      "--harness",
      fixture.harnessDir,
      "--json",
    ];
    const recovered = runCli(recoverArgs, fixture, successor);
    expect(recovered.exitCode).toBe(0);
    // §3.2's active success envelope: `operation_id` and `replayed` are envelope
    // fields of the receipt, while `data` is the session reference itself.
    expect(jsonOf(recovered).route).toBe("execution");
    expect(jsonOf(recovered).operation).toBe("recover");
    expect(jsonOf(recovered).operation_id).toBe("operator-recover");
    expect(jsonOf(recovered).replayed).toBe(false);
    expect(String(dataOf(recovered).sessionId)).toBe(SUCCESSOR_SESSION);
    const recoveredPlan = await planViewOf(fixture);
    // The recovery replaced the COORDINATOR only: the plan's held lease keeps its
    // own holder until an explicit reconcile moves it.
    expect(leaseFacts(recoveredPlan)).toEqual({ status: "held", holder: PLAN_SESSION });
    const replayedRecovery = runCli(recoverArgs, fixture, successor);
    expect(replayedRecovery.exitCode).toBe(0);
    expect(jsonOf(replayedRecovery).replayed).toBe(true);

    // ── §8: the diagnostic export describes the authority without identities
    const exportPath = join(fixture.root, "operator-export.json");
    const exported = runCli(["store", "execution", "export", "--out", exportPath, "--harness", fixture.harnessDir, "--json"], fixture);
    const exportData = dataOf(exported);
    expectSuccess(exported, "export");
    expect(exportData.format).toBe("execution-diagnostic-v1");
    expect(String(exportData.sha256)).toMatch(/^[0-9a-f]{64}$/);
    const canonicalJson = String(exportData.canonicalJson);
    expect(readFileSync(exportPath).toString("utf8")).toBe(canonicalJson);
    const canonical = JSON.parse(canonicalJson) as {
      redactedKeys?: unknown;
      execution?: { authorityState?: unknown } | null;
      workflows?: Array<{ workflowId?: unknown }>;
    };
    // The artifact describes the authority it was asked for…
    expect(canonical.execution?.authorityState).toBe("active");
    expect(canonical.workflows?.map((workflow) => workflow.workflowId)).toEqual([WORKFLOW_ID]);
    // The artifact reports the key names it dropped, and they are the imported
    // lease's holder identity fields. No traversed document carries a
    // `session_id` key at all: the import moves every session binding into the
    // `execution_sessions` row (the workflow header drops `coordination`, the
    // plan state and coordination block drop `session`) and the export projects
    // those session rows without an identity column.
    const redactedKeys = canonical.redactedKeys as string[];
    for (const key of ["holder", "holder_session_id", "holder_role"]) {
      expect(redactedKeys).toContain(key);
    }
    // The observable fact rather than the key names: the serialized artifact
    // carries no concrete session identity — neither the imported ones nor the
    // recovery successor, which exists only as a session row and in the recovery
    // operation receipt, neither of which the export projects.
    for (const sessionId of [COORDINATOR_SESSION, PLAN_SESSION, SUCCESSOR_SESSION]) {
      expect(canonicalJson.includes(sessionId)).toBe(false);
    }

    // ── §6 item 4: retirement moves exactly the reviewed core sources
    const retireArgs = [
      "store",
      "execution",
      "retire",
      "--manifest",
      reviewed.manifestPath,
      "--inventory",
      fixture.inventoryPath,
      "--operation",
      "operator-retire",
      "--operator",
      OPERATOR,
      "--harness",
      fixture.harnessDir,
      "--json",
    ];
    const retired = runCli(retireArgs, fixture);
    expectSuccess(retired, "retire");
    expect(dataOf(retired).phase).toBe("retired");
    const archiveDir = join(fixture.harnessDir, "archived", "execution", reviewed.manifestId);
    expect(existsSync(join(archiveDir, "status.json"))).toBe(true);
    expect(existsSync(join(archiveDir, "workflows", WORKFLOW_ID, "snapshot.json"))).toBe(true);
    // The retained surfaces keep their bytes: the referenced session envelopes are
    // NOT core sources of this manifest.
    expect(existsSync(fixture.coordinatorEnvelope)).toBe(true);
    expect(existsSync(fixture.planEnvelope)).toBe(true);
    expect(existsSync(fixture.statusPath)).toBe(false);

    const replayedRetire = runCli(retireArgs, fixture);
    expect(replayedRetire.exitCode).toBe(0);
    expect(dataOf(replayedRetire).phase).toBe("retired");
    expect(dataOf(replayedRetire).replayed).toBe(true);
  });

  test("abort returns a staged manifest to legacy and preserves every source byte", async () => {
    const fixture = await legacyFixture("cli-c6-abort");
    const reviewed = previewAndCover(fixture, "abort");
    const point = takeRecoveryPoint(fixture, "abort");
    const protectedPaths = [fixture.statusPath, fixture.snapshotPath, fixture.coordinatorEnvelope, fixture.planEnvelope];
    const protectedBefore = protectedPaths.map((path) => readFileSync(path).toString("base64"));

    const applied = runCli(applyFamily(fixture, reviewed, point.receiptPath, "abort-apply"), fixture);
    expectSuccess(applied, "apply");
    expect(executionAuthorityOf(fixture).authority_state).toBe("staged");

    const abortArgs = [
      "store",
      "execution",
      "abort",
      "--manifest",
      reviewed.manifestPath,
      "--reason",
      "legacy input changed while the manifest was staged",
      "--operation",
      "abort-1",
      "--operator",
      OPERATOR,
      "--harness",
      fixture.harnessDir,
      "--json",
    ];
    const aborted = runCli(abortArgs, fixture);
    expectSuccess(aborted, "abort");
    expect(dataOf(aborted).phase).toBe("aborted");
    expect(dataOf(aborted).replayed).toBe(false);
    // The staged rows are gone, the authority is legacy again and every source
    // byte — root register, snapshot and session envelopes — is preserved.
    const executionAfterAbort = executionAuthorityOf(fixture);
    expect(executionAfterAbort.authority_state).toBe("legacy");
    expect(executionAfterAbort.manifest_id).toBeNull();
    expect(protectedPaths.map((path) => readFileSync(path).toString("base64"))).toEqual(protectedBefore);

    // An aborted manifest is never re-staged: the replay reports the recorded abort.
    const replayedAbort = runCli(abortArgs, fixture);
    expect(replayedAbort.exitCode).toBe(0);
    expect(dataOf(replayedAbort).phase).toBe("aborted");
    expect(dataOf(replayedAbort).replayed).toBe(true);
  });

  test("a missing coverage, attestation, loss confirmation or reviewed inventory refuses without writing authority", async () => {
    const fixture = await legacyFixture("cli-c6-refusals");
    const reviewed = previewAndCover(fixture, "refusal");
    const point = takeRecoveryPoint(fixture, "refusal");
    const attestationPath = join(fixture.root, "refusal-attestation.json");
    writeJson(attestationPath, stopAttestation([COORDINATOR_SESSION, PLAN_SESSION]));
    const applyArgs = applyFamily(fixture, reviewed, point.receiptPath, "refusal-apply");

    // Missing --coverage: usage, and nothing staged.
    expectUsageRefusal(runCli(withoutFlag(applyArgs, "--coverage"), fixture), "apply", "--coverage");
    // Missing --inventory: the manifest records an explicit scope, so the
    // boundary's own discovery would not be the reviewed one.
    expectUsageRefusal(runCli(withoutFlag(applyArgs, "--inventory"), fixture), "apply", "--inventory");
    // A coverage set of ANOTHER manifest is never applied under this one.
    const foreignCoverage = join(fixture.root, "refusal-foreign-coverage.json");
    const coverageDocument = JSON.parse(readFileSync(reviewed.coveragePath, "utf8")) as Record<string, unknown>;
    writeJson(foreignCoverage, { ...coverageDocument, manifestId: "00000000-0000-4000-8000-000000000000" });
    const foreignArgs = applyArgs.map((arg) => (arg === reviewed.coveragePath ? foreignCoverage : arg));
    expectUsageRefusal(runCli(foreignArgs, fixture), "apply", "coverage");
    // A missing recovery point: the reviewed manifest alone never authorizes a write.
    expectUsageRefusal(runCli(withoutFlag(applyArgs, "--backup"), fixture), "apply", "--backup");
    // Every mutating verb also requires the operation id (its replay key) and the
    // accountable operator; neither is ever inferred.
    expectUsageRefusal(runCli(withoutFlag(applyArgs, "--operation"), fixture), "apply", "--operation");
    expectUsageRefusal(runCli(withoutFlag(applyArgs, "--operator"), fixture), "apply", "--operator");
    // Missing --attestation at the barrier.
    expectUsageRefusal(
      runCli(withoutFlag(activateFamily(fixture, reviewed, attestationPath, "refusal-activate"), "--attestation"), fixture),
      "activate",
      "--attestation",
    );
    // Missing --reason on abort.
    expectUsageRefusal(
      runCli([
        "store",
        "execution",
        "abort",
        "--manifest",
        reviewed.manifestPath,
        "--operation",
        "refusal-abort",
        "--operator",
        OPERATOR,
        "--harness",
        fixture.harnessDir,
        "--json",
      ], fixture),
      "abort",
      "--reason",
    );
    // Missing loss confirmation on restore: an approved digest is always required.
    const previewDocument = join(fixture.root, "refusal-preview.json");
    writeJson(previewDocument, { lossDigest: "b".repeat(64) });
    expectUsageRefusal(
      runCli([
        "store",
        "execution",
        "restore",
        "--preview",
        previewDocument,
        "--operator",
        OPERATOR,
        "--authorization",
        "cli C6 test",
        "--harness",
        fixture.harnessDir,
        "--json",
      ], fixture),
      "restore",
      "--accept-loss-digest",
    );
    // A malformed loss digest in the preview document is the SAME usage class as
    // a malformed --accept-loss-digest, decided before any engine IO.
    const malformedPreview = join(fixture.root, "refusal-malformed-preview.json");
    writeJson(malformedPreview, { lossDigest: "not-a-digest" });
    expectUsageRefusal(
      runCli([
        "store",
        "execution",
        "restore",
        "--preview",
        malformedPreview,
        "--accept-loss-digest",
        "b".repeat(64),
        "--operator",
        OPERATOR,
        "--authorization",
        "cli C6 test",
        "--harness",
        fixture.harnessDir,
        "--json",
      ], fixture),
      "restore",
      "--preview",
    );
    // Coverage without the inventory it needs, and an unknown flag.
    expectUsageRefusal(
      runCli([
        "store",
        "execution",
        "preview",
        "--operation",
        "refusal-preview",
        "--operator",
        OPERATOR,
        "--coverage-out",
        join(fixture.root, "refusal-coverage-only.json"),
        "--harness",
        fixture.harnessDir,
        "--json",
      ], fixture),
      "preview",
      "--coverage-out",
    );
    expectUsageRefusal(runCli(["store", "execution", "export", "--not-a-flag", "--harness", fixture.harnessDir, "--json"], fixture), "export", "--not-a-flag");

    // Every refusal above wrote nothing: no manifest was recorded and the
    // execution authority never left legacy.
    expect(stagedManifestCount(fixture)).toBe(0);
    expect(executionAuthorityOf(fixture).authority_state).toBe("legacy");
  });

  test("the issue/catalog activation stays a distinct route from the execution barrier", async () => {
    const fixture = await legacyFixture("cli-c6-route");
    const storeHelp = runCli(["store", "--help"], fixture);
    expect(storeHelp.exitCode).toBe(0);
    expect(storeHelp.stdout).toContain("execution");

    // The issue/catalog barrier keeps its own verb and its own wording…
    const catalogActivate = runCli(["store", "activate", "--help"], fixture);
    expect(catalogActivate.exitCode).toBe(0);
    expect(catalogActivate.stdout).toContain("issue/catalog");
    expect(catalogActivate.stdout).not.toContain("--coverage");
    // …while the execution barrier is the execution route.
    const executionActivate = runCli(["store", "execution", "activate", "--help"], fixture);
    expect(executionActivate.exitCode).toBe(0);
    expect(executionActivate.stdout).toContain("--coverage");
    expect(executionActivate.stdout).toContain("--attestation");

    const familyHelp = runCli(["store", "execution", "--help"], fixture);
    expect(familyHelp.exitCode).toBe(0);
    for (const verb of ["preview", "apply", "activate", "retire", "abort", "restore-preview", "restore", "export"]) {
      expect(familyHelp.stdout).toContain(verb);
    }
  });
});

describe("mstar store execution \u2014 whole-store recovery", () => {
  test("restore replaces the store only under the exact approved loss digest", async () => {
    const fixture = await legacyFixture("cli-c6-restore");
    const reviewed = previewAndCover(fixture, "restore");
    // The recovery point predates the staging, so the staging's own committed
    // operation is exactly the loss the restore would cause.
    const point = takeRecoveryPoint(fixture, "restore");
    const applied = runCli(applyFamily(fixture, reviewed, point.receiptPath, "restore-apply"), fixture);
    expectSuccess(applied, "apply");
    expect(dataOf(applied).phase).toBe("staged");

    const previewPath = join(fixture.root, "restore-preview.json");
    const preview = runCli([
      "store",
      "execution",
      "restore-preview",
      "--backup",
      point.imagePath,
      "--out",
      previewPath,
      "--harness",
      fixture.harnessDir,
      "--json",
    ], fixture);
    const previewData = dataOf(preview);
    expectSuccess(preview, "restore-preview");
    // The preview DOES report this fixture's loss, in the two shapes §8 uses:
    // every authority row the point predates is a `differences` entry (the staged
    // migration rows included, i.e. an `execution` domain entry exists), and the
    // canonical `lossDigest` covers the whole inventory. `lostOperationIds`
    // lists COMMITTED DOMAIN OPERATION receipts only — `execution_operations`
    // rows rendered as `execution:<epoch>:<operationId>` — and a staged store
    // holds none by construction: staging refuses while that table holds a row
    // and the migration verbs record into `execution_migrations` instead, so the
    // apply's own operation id is not (and cannot be) an entry here.
    const differences = previewData.authorityDifferences as Array<{ domain?: unknown }>;
    expect(Array.isArray(differences)).toBe(true);
    expect(differences.length).toBeGreaterThan(0);
    expect(differences.some((difference) => difference.domain === "execution")).toBe(true);
    expect(Array.isArray(previewData.lostOperationIds)).toBe(true);
    const lossDigest = String(previewData.lossDigest);
    expect(lossDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(previewPath)).toBe(true);
    expect(JSON.parse(readFileSync(previewPath, "utf8"))).toMatchObject({ lossDigest });

    const restoreArgs = (digest: string): string[] => [
      "store",
      "execution",
      "restore",
      "--preview",
      previewPath,
      "--accept-loss-digest",
      digest,
      "--operator",
      OPERATOR,
      "--authorization",
      "cli C6 restore test",
      "--harness",
      fixture.harnessDir,
      "--json",
    ];

    // A digest that is not this inventory's loss is refused, and the live store
    // keeps the staged authority it had.
    const authorityBefore = executionAuthorityOf(fixture);
    const refused = runCli(restoreArgs("0".repeat(64)), fixture);
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused).ok).toBe(false);
    expect(jsonOf(refused).route).toBe("execution");
    expect(jsonOf(refused).operation).toBe("restore");
    expect(jsonOf(refused).code).toBe("execution.recovery-loss-unaccepted");
    expect(executionAuthorityOf(fixture)).toEqual(authorityBefore);

    // The exact approved loss is accepted and the store is replaced.
    const restored = runCli(restoreArgs(lossDigest), fixture);
    const restoreData = dataOf(restored);
    expectSuccess(restored, "restore");
    expect(Number(restoreData.epoch)).toBeGreaterThan(0);
    expect(String(restoreData.recoveryReceiptPath)).toContain("recovery");

    // The replaced store is readable through the diagnostic export, and it is
    // the recovery point's own execution state (legacy), not the staged one.
    const exported = runCli(["store", "execution", "export", "--harness", fixture.harnessDir, "--json"], fixture);
    const exportData = dataOf(exported);
    expectSuccess(exported, "export");
    const canonical = JSON.parse(String(exportData.canonicalJson)) as {
      execution?: { authorityState?: unknown } | null;
      store?: { epoch?: unknown };
    };
    expect(canonical.execution?.authorityState).toBe("legacy");
    expect(canonical.store?.epoch).toBe(Number(restoreData.epoch));
    expect(stagedManifestCount(fixture)).toBe(0);
  });
});
