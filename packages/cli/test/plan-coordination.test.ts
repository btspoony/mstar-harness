/**
 * CLI `mstar plan` — the coordinator plan-coordination transport.
 *
 * Every case runs the real CLI entry as a subprocess against a temporary Git
 * fixture (main worktree + harness + two plan rows), asserting the observable
 * contract: JSON on stdout, diagnostics on stderr, exit 0 ok/no-op, 1 engine
 * refusal, 2 usage. Authoritative state (snapshot / register bytes) is read from
 * disk after each call, never from the CLI's own claim.
 *
 * The plan-PM seat, the sealed Assignment, the per-plan execution lease and the
 * handoff/accept/integration transfer protocol are removed. One workflow has one
 * coordinator, which prepares, progresses and completes rows directly; completion
 * is one operation carrying the QC/QA evidence and the optional already-performed
 * integration pair.
 *
 * Groups: `entry-forms`, `session identity`, `admission`, `strict-input`,
 * `linked-control-root`, `coordinator operations`, `direct completion`,
 * `Prepare amendment`, `catalog pin`, `prepare recovery`, `execution transport`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { encodeExecutionSessionRef, serializeExecutionValue } from "@mstar-harness/engine";
import { executeCommand } from "@mstar-harness/commands";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

const WORKFLOW_ID = "wf-plana";
const PLAN_ID = "plan-a";
const PEER_PLAN_ID = "plan-b";
const PROJECT_ID = "proj-a";
const INTEGRATION_BRANCH = "integration/plan-a";

const CLI_INTEGRATION_TIMEOUT = 120_000;
const RECOVERY_TIMEOUT = CLI_INTEGRATION_TIMEOUT;

interface RunResult {
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Ambient identity/harness env pinned out, so a case's own env is the only one. */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (key === "MSTAR_HOST_SESSION_ID" || key === "MSTAR_EXECUTION_IDENTITY") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runCli(args: string[], cwd: string, extraEnv: Record<string, string> = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd,
    env: { ...cliEnv(), ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    signalCode: proc.signalCode ?? null,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function jsonOf(result: RunResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON stdout, got ${JSON.stringify(result.stdout)} (stderr: ${result.stderr})`);
  }
}

function objectOf(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The owning command's data, never a legacy top-level projection. */
function dataOf(result: RunResult): Record<string, unknown> {
  const envelope = jsonOf(result);
  if (envelope.status !== "ok" || !objectOf(envelope.data)) {
    throw new Error(`expected successful command data: ${result.stdout}`);
  }
  return envelope.data;
}

function viewOf(result: RunResult): Record<string, unknown> {
  const view = dataOf(result).view;
  if (!objectOf(view)) throw new Error(`expected command view: ${result.stdout}`);
  return view;
}

/**
 * Initialize the fixture's issue store WITHOUT the execution authority: the
 * shared suite is deliberately a FILE-route corpus (the pre-activation
 * `--session` binds and snapshot readbacks), and a store-less workspace is a
 * legitimate pre-migration shape rather than a broken one.
 */
function initializeFixtureStore(harness: string, cwd: string): void {
  const engineEntry = join(CLI_ROOT, "../engine/src/index.ts");
  const script = `import { initializeStore } from ${JSON.stringify(engineEntry)};
const store = await initializeStore({ harnessDir: ${JSON.stringify(harness)} });
store.close();
`;
  const proc = Bun.spawnSync([process.execPath, "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`fixture store init failed: ${proc.stderr.toString()}`);
}

/**
 * Initialize BOTH the issue store and the ACTIVE execution authority, for the
 * cases that assert the ACTIVE/FILE route guard itself.
 */
function initializeActiveFixtureStore(harness: string, cwd: string): void {
  const engineEntry = join(CLI_ROOT, "../engine/src/index.ts");
  const script = `import { initializeExecutionAuthority, initializeStore } from ${JSON.stringify(engineEntry)};
const store = await initializeStore({ harnessDir: ${JSON.stringify(harness)} });
store.close();
await initializeExecutionAuthority({ harnessDir: ${JSON.stringify(harness)} });
`;
  const proc = Bun.spawnSync([process.execPath, "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`fixture store init failed: ${proc.stderr.toString()}`);
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function gitOut(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Commit with the fixture's identity pinned (no ambient Git config reads). */
function gitCommit(cwd: string, message: string): void {
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message], cwd);
}

/** A plan row in the persisted snapshot shape, carrying its project id. */
function planRow(id: string, workingBranch?: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = { project_id: PROJECT_ID };
  if (workingBranch !== undefined) metadata.working_branch = workingBranch;
  return {
    id,
    plan_id: id,
    title: `Plan ${id}`,
    file: `.mstar/plans/${id}.md`,
    status: "Todo",
    metadata,
  };
}

interface Fixture {
  root: string;
  harness: string;
  worktreePath: string;
  peerWorktreePath: string;
  snapshotPath: string;
  /** The retired register path — a command must never create it (G2b). */
  projectRegisterPath: string;
  evidencePath: string;
}

/**
 * Temporary Git fixture: main worktree + canonical harness + two Todo rows.
 * The harness carries an initialized ACTIVE execution authority (the issue store
 * is the findings authority the completion gate reads). `store: false` leaves
 * the workspace store-less for the catalog-absence case.
 */
function makeFixture(options: { store?: boolean; active?: boolean } = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-plan-cli-")));
  roots.push(root);
  git(["init", "-q", "-b", "main"], root);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], root);

  const harness = join(root, ".mstar");
  const workflowDir = join(harness, "workflows", WORKFLOW_ID);
  const snapshotPath = join(workflowDir, "snapshot.json");
  const projectRegisterPath = join(harness, "projects", PROJECT_ID, "residuals.json");
  const planPath = join(harness, "plans", `${PLAN_ID}.md`);
  const peerPlanPath = join(harness, "plans", `${PEER_PLAN_ID}.md`);
  const evidencePath = join(harness, "sdd", PLAN_ID, "evidence.md");
  const worktreePath = join(root, "wt-plana");
  const peerWorktreePath = join(root, "wt-planb");

  writeText(planPath, "# plan a\n");
  writeText(peerPlanPath, "# plan b\n");
  writeText(evidencePath, "# evidence\n");
  // REAL checkouts on the branches the snapshot rows record: prepare validates
  // the actual checkout and branch.
  git(["worktree", "add", "-q", "-b", "feature/plan-a", worktreePath], root);
  git(["worktree", "add", "-q", "-b", "feature/plan-b", peerWorktreePath], root);

  if (options.active === true) initializeActiveFixtureStore(harness, root);
  else if (options.store !== false) initializeFixtureStore(harness, root);

  writeJson(join(harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-15T00:00:00Z",
    workflows: [
      {
        id: WORKFLOW_ID,
        status: "running",
        type: "plan",
        started_at: "2026-09-15T00:00:00Z",
        dir: `workflows/${WORKFLOW_ID}`,
      },
    ],
  });
  writeJson(snapshotPath, {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    delivery_kind: "development",
    status: "running",
    started_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    branch: { source: "feature/plan-a", target: "main" },
    plans: [planRow(PLAN_ID, "feature/plan-a"), planRow(PEER_PLAN_ID, "feature/plan-b")],
  });

  return { root, harness, worktreePath, peerWorktreePath, snapshotPath, projectRegisterPath, evidencePath };
}

/** The explicit local coordinator identity every CLI fixture acquires. */
const FIXTURE_COORDINATOR_ID = "fixture-coordinator";

/** The Prepare-stage amendment fixture's own lifecycle/rows. */
const PREPARE_WORKFLOW = "wf-prepare";
const PREPARE_PEER = "wf-peer";
const PREPARE_ROW = "plan-prepare";
const PREPARE_APPEND = "plan-append";
const PREPARE_SPEC = "amendment-contract.md";
const PREPARE_INTEGRATION_BRANCH = "integration/wf-prepare";

/** Bind the workflow coordinator through the CLI and return its session file. */
function bindCoordinator(fixture: Fixture, sessionId = FIXTURE_COORDINATOR_ID): string {
  const bound = runCli(
    ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--session-id", sessionId],
    fixture.root,
  );
  expect(bound.exitCode, bound.stdout).toBe(0);
  const payload = dataOf(bound);
  expect(payload.session).toMatchObject({ role: "coordinator", session_id: sessionId, workflow_id: WORKFLOW_ID });
  return String(payload.session_file);
}

/** Prepare one row through the coordinator session's ordinary configuration. */
function preparePlan(fixture: Fixture, coordinatorSession: string, planId: string, worktree?: string): void {
  const view = runCli(["plan", "show", "--session", coordinatorSession, "--plan", planId], fixture.root);
  expect(view.exitCode, view.stdout).toBe(0);
  const prepared = runCli(
    [
      "plan", "prepare", "--session", coordinatorSession, "--plan", planId,
      "--worktree-path", worktree ?? (planId === PLAN_ID ? fixture.worktreePath : fixture.peerWorktreePath),
      "--working-branch", `feature/${planId}`,
      "--qa-gate", "mandatory", "--findings-cleanup", "allow-residual",
      "--expect", String(dataOf(view).revision),
    ],
    fixture.root,
  );
  expect(prepared.exitCode, prepared.stdout).toBe(0);
  expect(dataOf(prepared).outcome).toBe("prepared");
}

/** Row revision of one plan as the coordinator's CLI read reports it. */
function rowRevision(fixture: Fixture, session: string, planId: string = PLAN_ID): number {
  const result = runCli(["plan", "show", "--session", session, "--plan", planId], fixture.root);
  expect(result.exitCode, result.stdout).toBe(0);
  return Number(dataOf(result).revision);
}

/** Parsed authority state used to verify refusal and replay non-mutation. */
function snapshotState(fixture: Fixture): Record<string, unknown> {
  return readJson(fixture.snapshotPath);
}

/** One row of the authoritative snapshot (never the CLI's own claim). */
function rowOf(fixture: Fixture, planId: string = PLAN_ID): Record<string, unknown> {
  const plans = readJson(fixture.snapshotPath).plans as Array<Record<string, unknown>>;
  const row = plans.find((entry) => entry.id === planId);
  if (row === undefined) throw new Error(`row ${planId} missing from ${fixture.snapshotPath}`);
  return row;
}

/** Move a row to InProgress through the coordinator (the ordinary start record). */
function toInProgress(fixture: Fixture, coordinator: string, summary: string, planId: string = PLAN_ID): void {
  const payload = join(fixture.root, `progress-${planId}-start.json`);
  writeJson(payload, { status: "InProgress", summary, evidence_paths: [fixture.evidencePath] });
  const moved = runCli(
    ["plan", "progress", "--session", coordinator, "--plan", planId, "--file", payload, "--expect", String(rowRevision(fixture, coordinator, planId))],
    fixture.root,
  );
  expect(moved.exitCode, moved.stdout).toBe(0);
}

/** Drive a row to InReview through the coordinator (Todo → InProgress → InReview). */
function toInReview(fixture: Fixture, coordinator: string, summary: string, planId: string = PLAN_ID): void {
  for (const status of ["InProgress", "InReview"]) {
    const payload = join(fixture.root, `progress-${planId}-${status}.json`);
    writeJson(payload, { status, summary, evidence_paths: [fixture.evidencePath] });
    const moved = runCli(
      ["plan", "progress", "--session", coordinator, "--plan", planId, "--file", payload, "--expect", String(rowRevision(fixture, coordinator, planId))],
      fixture.root,
    );
    expect(moved.exitCode, moved.stdout).toBe(0);
    expect(jsonOf(moved).status).toBe("ok");
  }
}


/* ------------------------------------------------------------------ issue helpers */

/** One capture entry as `plan issue-add` takes it. */
function issueEntryOf(occurrenceKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: PROJECT_ID,
    title: `Finding ${occurrenceKey}`,
    kind: "bug",
    severity: "high",
    impact: "an acceptance is not met",
    acceptance: "the finding is fixed and verified",
    sourceIdentity: "cli/plan-coordination",
    rootCauseKey: "cli-root-cause",
    acceptanceKey: "cli-acceptance",
    occurrenceKey,
    sourceKind: "qc",
    location: "packages/cli/src/index.ts",
    observedBehavior: "observed",
    evidence: ["trace"],
    discoveredAt: "2026-09-15T00:00:00Z",
    ...overrides,
  };
}

function issueAdd(fixture: Fixture, coordinator: string, payloadPath: string, planId: string = PLAN_ID): RunResult {
  return runCli(
    [
      "plan", "issue-add", "--session", coordinator, "--plan", planId,
      "--file", payloadPath,
      "--expect", String(rowRevision(fixture, coordinator, planId)),
    ],
    fixture.root,
  );
}

function issueReceiptsOf(result: RunResult): Array<Record<string, unknown>> {
  const issues = dataOf(result).issues;
  if (!Array.isArray(issues) || !issues.every(objectOf)) throw new Error(`expected issue receipts: ${result.stdout}`);
  return issues;
}

function listedIssues(fixture: Fixture, extraArgs: string[] = []): Array<Record<string, unknown>> {
  const result = runCli(["issue", "list", "--harness", fixture.harness, ...extraArgs], fixture.root);
  expect(result.exitCode, result.stdout).toBe(0);
  const issues = dataOf(result).items;
  if (!Array.isArray(issues) || !issues.every(objectOf)) throw new Error(`expected issue page: ${result.stdout}`);
  return issues;
}

/* ------------------------------------------------------------------ entry forms */

describe("mstar plan — entry-forms", () => {
  test("the active coordinator bind adopts the workflow's own seat and records the identity", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    expect(existsSync(coordinator)).toBe(true);
    const envelope = readJson(coordinator);
    expect(envelope.role).toBe("coordinator");
    expect(envelope.session_id).toBe(FIXTURE_COORDINATOR_ID);
    expect(envelope.workflow_id).toBe(WORKFLOW_ID);
    const coordination = readJson(fixture.snapshotPath).coordination as { coordinator?: { session_id?: string } };
    expect(coordination.coordinator?.session_id).toBe(FIXTURE_COORDINATOR_ID);
  });

  test("explicit resume reports the live context without claiming a second time", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    const before = readJson(fixture.snapshotPath);

    const resumed = runCli(["plan", "bind", "--resume", coordinator], fixture.root);
    expect(resumed.exitCode, resumed.stdout).toBe(0);
    const payload = dataOf(resumed);
    expect(payload.outcome).toBe("resumed");
    expect(payload.session_file).toBe(coordinator);
    // Resume is read-only: the recorded binding is unchanged.
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  });

  test("a second coordinator bind with a different session is a holder conflict", () => {
    const fixture = makeFixture();
    bindCoordinator(fixture);
    const again = runCli(
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--session-id", "second-coordinator"],
      fixture.root,
    );
    expect(again.exitCode).toBe(1);
    expect(jsonOf(again).code).toBe("coordination.identity-mismatch");
  });

  test("the coordinator reads any row of its workflow by explicit plan id", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);

    const view = runCli(["plan", "show", "--session", coordinator, "--plan", PLAN_ID], fixture.root);
    expect(view.exitCode, view.stdout).toBe(0);
    const payload = dataOf(view);
    expect(payload.row).toMatchObject({ id: PLAN_ID });
    expect(payload.session).toMatchObject({ role: "coordinator", workflow_id: WORKFLOW_ID });
    expect(payload.allowed_operations).toContain("complete");
    const scope = payload.scope as Record<string, unknown>;
    expect(scope.worktreePath).toBe(fixture.worktreePath);
    expect(scope.workingBranch).toBe("feature/plan-a");

    // The coordinator addresses its rows explicitly; the same read works for the peer row.
    const peer = runCli(["plan", "show", "--session", coordinator, "--plan", PEER_PLAN_ID], fixture.root);
    expect(peer.exitCode, peer.stdout).toBe(0);
    expect(dataOf(peer).row).toMatchObject({ id: PEER_PLAN_ID });
  });

  test("an active plan operation without --plan states the addressing fact it requires", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    const payload = join(fixture.root, "progress.json");
    writeJson(payload, { status: "InProgress", summary: "no row addressed", evidence_paths: [fixture.evidencePath] });

    const refused = runCli(
      ["plan", "progress", "--session", coordinator, "--file", payload, "--expect", "0"],
      fixture.root,
    );
    expect(refused.exitCode).toBe(2);
    expect(jsonOf(refused).code).toBe("command.invalid-input");
    expect(String(jsonOf(refused).message)).toContain("--plan");
  });

  test("show on an unprepared row returns revision 0 and the recorded branch without requiring prepare", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    const view = runCli(["plan", "show", "--session", coordinator, "--plan", PLAN_ID], fixture.root);
    expect(view.exitCode, view.stdout).toBe(0);
    const payload = dataOf(view);
    expect(payload.revision).toBe(0);
    expect(payload.scope).toMatchObject({ workingBranch: "feature/plan-a", worktreePath: null });
    expect(payload.allowed_operations).toContain("prepare");
  });
});

/* --------------------------------------------------------------- session identity */

describe("mstar plan — session identity", () => {
  test("--session-id becomes the bound coordinator identity", () => {
    const fixture = makeFixture();
    const supplied = "host-session-coordinator";
    const coordinated = runCli(
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--session-id", supplied],
      fixture.root,
    );
    expect(coordinated.exitCode, coordinated.stdout).toBe(0);
    const payload = dataOf(coordinated);
    expect(payload.session).toMatchObject({ session_id: supplied });
    expect(String(payload.session_file)).toBe(
      join(fixture.harness, "workflows", WORKFLOW_ID, "sessions", `coordinator-${supplied}.json`),
    );
    expect(readJson(String(payload.session_file)).session_id).toBe(supplied);
  });

  test("a rejected address id is never echoed into the bind diagnostic", () => {
    const fixture = makeFixture();
    const bound = runCli(
      ["plan", "bind", "--coordinator", "--workflow", "  ", "--session-id", "attacker-session"],
      fixture.root,
    );
    expect(bound.exitCode).toBe(2);
    expect(jsonOf(bound).code).toBe("command.invalid-input");
    expect(bound.stdout).not.toContain("attacker-session");
  });

  test("a coordinator bootstrap through the legacy file route redirects to the active form", () => {
    const fixture = makeFixture({ active: true });
    const legacy = runCli(
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--session-id", "legacy-coordinator"],
      fixture.root,
    );
    // `--coordinator` without `--execution` is the pre-activation bootstrap; on a
    // root whose authority is ACTIVE it refuses and names the active form.
    expect(legacy.exitCode).toBe(1);
    expect(jsonOf(legacy).code).toBe("execution.consumer-not-ready");
    expect(String(jsonOf(legacy).message)).toContain("--execution");
  });

  test("--resume accepts no identity input and stays resumable", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    const flagged = runCli(["plan", "bind", "--resume", coordinator, "--session-id", "other"], fixture.root);
    expect(flagged.exitCode).toBe(2);
    expect(jsonOf(flagged).code).toBe("command.invalid-input");
  });

  test("the active bind requires the runtime session identity before any IO", () => {
    const fixture = makeFixture();
    const absent = runCli(["plan", "bind", "--execution", "--workflow", WORKFLOW_ID, "--coordinator"], fixture.root);
    expect(absent.exitCode).toBe(2);
    expect(jsonOf(absent).code).toBe("command.invalid-input");
    expect(existsSync(fixture.projectRegisterPath)).toBe(false);
  });
});

/* ------------------------------------------------------------------- strict input */

describe("mstar plan — strict-input", () => {
  test("missing required inputs are usage errors", () => {
    const fixture = makeFixture();
    for (const args of [
      ["plan", "prepare"],
      ["plan", "progress", "--session", "x", "--plan", PLAN_ID],
      ["plan", "complete"],
      ["plan", "issue-add"],
    ]) {
      const result = runCli(args, fixture.root);
      expect(`${args.join(" ")} -> ${result.exitCode}`).toBe(`${args.join(" ")} -> 2`);
      expect(jsonOf(result).code).toBe("command.invalid-input");
    }
  });

  test("payload files must be absolute and present (exit 2), before the engine sees them", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    for (const file of ["relative.json", join(fixture.root, "absent.json")]) {
      const result = runCli(
        ["plan", "progress", "--session", coordinator, "--plan", PLAN_ID, "--file", file, "--expect", "0"],
        fixture.root,
      );
      expect(`${file} -> ${result.exitCode}`).toBe(`${file} -> 2`);
      expect(jsonOf(result).code).toBe("command.invalid-input");
    }
  });

  test("a malformed progress payload is rejected before mutation, not silently dropped", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    const before = snapshotState(fixture);
    const payload = join(fixture.root, "progress.json");
    writeJson(payload, { summary: "no status at all" });
    const refused = runCli(
      ["plan", "progress", "--session", coordinator, "--plan", PLAN_ID, "--file", payload, "--expect", "0"],
      fixture.root,
    );
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused)).toMatchObject({ status: "refused", code: "coordination.invalid-input" });
    expect(snapshotState(fixture)).toEqual(before);
  });

  test("issue authority: --expect-issue accepts only a nonnegative revision, before any payload is read (exit 2)", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    const refused = runCli(
      [
        "plan", "issue-close", "--session", coordinator, "--plan", PLAN_ID,
        "--issue", "issue-1", "--disposition", "resolved",
        "--file", join(fixture.root, "absent.json"),
        "--expect-issue", "-2", "--expect", "1",
      ],
      fixture.root,
    );
    expect(refused.exitCode).toBe(2);
    expect(jsonOf(refused).code).toBe("command.invalid-input");
  });

  test("issue authority: --disposition names only the four terminal dispositions (exit 2)", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    const refused = runCli(
      [
        "plan", "issue-close", "--session", coordinator, "--plan", PLAN_ID,
        "--issue", "issue-1", "--disposition", "not-a-disposition",
        "--file", join(fixture.root, "absent.json"),
        "--expect-issue", "1", "--expect", "1",
      ],
      fixture.root,
    );
    expect(refused.exitCode).toBe(2);
    expect(jsonOf(refused).code).toBe("command.invalid-input");
  });
});

/* ------------------------------------------------------------------ linked control root */

describe("mstar plan — linked-control-root", () => {
  test("an explicit harness serves the addressed workflow from an unrelated cwd", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const here = runCli(
      ["plan", "show", "--session", coordinator, "--plan", PLAN_ID, "--harness", fixture.harness],
      tmpdir(),
    );
    expect(here.exitCode, here.stdout).toBe(0);
    expect(dataOf(here).row).toMatchObject({ id: PLAN_ID });
  });

  test("an explicitly unavailable harness refuses instead of reading another one", () => {
    const fixture = makeFixture();
    const before = snapshotState(fixture);
    const refused = runCli(
      ["plan", "show", "--workflow", WORKFLOW_ID, "--session-id", FIXTURE_COORDINATOR_ID, "--plan", PLAN_ID, "--harness", join(fixture.root, "absent")],
      fixture.root,
    );
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused)).toMatchObject({ status: "refused", code: "store.not-initialized" });
    expect(snapshotState(fixture)).toEqual(before);
  });
});

/* --------------------------------------------------------------- coordinator operations */

describe("mstar plan — coordinator operations", () => {
  test("progress mutates only the addressed row and reports its new revision", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const before = rowRevision(fixture, coordinator);

    const payloadPath = join(fixture.root, "progress.json");
    writeJson(payloadPath, { status: "InProgress", summary: "coordinator start record", evidence_paths: [fixture.evidencePath] });
    const progressed = runCli(
      ["plan", "progress", "--session", coordinator, "--plan", PLAN_ID, "--file", payloadPath, "--expect", String(before)],
      fixture.root,
    );
    expect(progressed.exitCode, progressed.stdout).toBe(0);
    expect(dataOf(progressed).outcome).toBe("progressed");
    expect(viewOf(progressed).revision).toBe(before + 1);

    const rows = readJson(fixture.snapshotPath).plans as Array<Record<string, unknown>>;
    expect(rows[0]!.status).toBe("InProgress");
    // The sibling row is untouched — independent rows never invalidate each other.
    expect(rows[1]!.status).toBe("Todo");
    expect(rows[1]!.coordination).toBeUndefined();
  });

  test("a drifted row revision is provenance, not a refusal (A10)", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const revision = rowRevision(fixture, coordinator);
    const before = snapshotState(fixture);

    const payloadPath = join(fixture.root, "progress.json");
    writeJson(payloadPath, { status: "InProgress", summary: "stale", evidence_paths: [fixture.evidencePath] });
    const stale = runCli(
      ["plan", "progress", "--session", coordinator, "--plan", PLAN_ID, "--file", payloadPath, "--expect", String(revision - 1)],
      fixture.root,
    );
    expect(stale.exitCode, stale.stdout).toBe(0);
    expect(JSON.stringify(jsonOf(stale))).toContain("token-drifted");
    expect(snapshotState(fixture)).not.toEqual(before);
  });

  test("a global field in the payload is refused, not silently dropped", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const revision = rowRevision(fixture, coordinator);
    const before = snapshotState(fixture);

    const payloadPath = join(fixture.root, "progress.json");
    writeJson(payloadPath, {
      status: "InProgress",
      summary: "with a lifecycle anchor",
      evidence_paths: [fixture.evidencePath],
      phase: "Done",
    });
    const injected = runCli(
      ["plan", "progress", "--session", coordinator, "--plan", PLAN_ID, "--file", payloadPath, "--expect", String(revision)],
      fixture.root,
    );
    expect(injected.exitCode).toBe(1);
    expect(jsonOf(injected)).toMatchObject({ status: "refused", code: "coordination.invalid-input" });
    expect(snapshotState(fixture)).toEqual(before);
  });

  test("issue authority: plan issue-add captures into the store, links the plan, and never writes a register", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const before = snapshotState(fixture);

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf("occ-1", { severity: "critical" })]);
    const added = issueAdd(fixture, coordinator, entriesPath);
    expect(added.exitCode, added.stdout).toBe(0);
    expect(dataOf(added).outcome).toBe("residual-added");

    const listed = listedIssues(fixture);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.title).toBe("Finding occ-1");
    expect(existsSync(fixture.projectRegisterPath)).toBe(false);
    expect(existsSync(join(fixture.harness, "projects"))).toBe(false);
    // An issue-only mutation never touches the execution input.
    expect(snapshotState(fixture)).toEqual(before);
  });

  test("issue authority: an exact issue-add replay converges instead of duplicating the finding", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf("occ-1")]);
    const first = issueAdd(fixture, coordinator, entriesPath);
    expect(first.exitCode, first.stdout).toBe(0);
    const firstReceipt = issueReceiptsOf(first)[0]!;

    const replay = issueAdd(fixture, coordinator, entriesPath);
    expect(replay.exitCode, replay.stdout).toBe(0);
    expect(issueReceiptsOf(replay)[0]!.issue_id).toBe(firstReceipt.issue_id);
    expect(listedIssues(fixture)).toHaveLength(1);

    writeJson(entriesPath, [issueEntryOf("occ-2")]);
    const second = issueAdd(fixture, coordinator, entriesPath);
    expect(second.exitCode, second.stdout).toBe(0);
    expect(issueReceiptsOf(second)[0]!.issue_id).not.toBe(firstReceipt.issue_id);
    expect(listedIssues(fixture)).toHaveLength(2);
  });

  test("issue authority: plan issue-close closes the named issue under the issue revision CAS", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf("occ-1")]);
    const added = issueAdd(fixture, coordinator, entriesPath);
    expect(added.exitCode, added.stdout).toBe(0);
    const receipt = issueReceiptsOf(added)[0]!;
    const issueId = String(receipt.issue_id);
    const issueRevision = Number(receipt.revision);

    const blocked = runCli(
      ["status", "findings-cleanup", PLAN_ID, "--harness", fixture.harness, "--mode", "zero-residual"],
      fixture.root,
    );
    expect(blocked.exitCode).toBe(1);
    expect(JSON.stringify(jsonOf(blocked).details)).toContain(issueId);

    const evidencePath = join(fixture.root, "evidence.json");
    writeJson(evidencePath, {
      reason: "fixed by the reviewer round",
      references: ["packages/cli/src/index.ts"],
      alignmentRef: "QA gate acceptance 2026-09-19",
    });

    const stale = runCli(
      [
        "plan", "issue-close", "--session", coordinator, "--plan", PLAN_ID,
        "--issue", issueId, "--disposition", "resolved", "--file", evidencePath,
        "--expect-issue", String(issueRevision + 5),
        "--expect", String(rowRevision(fixture, coordinator)),
      ],
      fixture.root,
    );
    expect(stale.exitCode).toBe(1);
    expect(jsonOf(stale).code).toBe("issue.revision-conflict");
    expect(listedIssues(fixture)[0]!.disposition).toBe("open");

    const closed = runCli(
      [
        "plan", "issue-close", "--session", coordinator, "--plan", PLAN_ID,
        "--issue", issueId, "--disposition", "resolved", "--file", evidencePath,
        "--expect-issue", String(issueRevision),
        "--expect", String(rowRevision(fixture, coordinator)),
      ],
      fixture.root,
    );
    expect(closed.exitCode, closed.stdout).toBe(0);
    expect(dataOf(closed).outcome).toBe("residual-closed");
    expect(listedIssues(fixture)).toHaveLength(0);
    expect(listedIssues(fixture, ["--disposition", "resolved"])).toHaveLength(1);

    const released = runCli(
      ["status", "findings-cleanup", PLAN_ID, "--harness", fixture.harness, "--mode", "zero-residual"],
      fixture.root,
    );
    expect(released.exitCode).toBe(0);
    expect(existsSync(fixture.projectRegisterPath)).toBe(false);
  }, CLI_INTEGRATION_TIMEOUT);

  test("issue authority: a row cannot close an issue linked to another plan", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    preparePlan(fixture, coordinator, PEER_PLAN_ID);

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf("occ-peer")]);
    const added = issueAdd(fixture, coordinator, entriesPath, PEER_PLAN_ID);
    expect(added.exitCode, added.stdout).toBe(0);
    const issueId = String(issueReceiptsOf(added)[0]!.issue_id);

    const evidencePath = join(fixture.root, "evidence.json");
    writeJson(evidencePath, {
      reason: "not this plan's finding",
      references: ["packages/cli/src/index.ts"],
      alignmentRef: "QA gate acceptance 2026-09-19",
    });
    const foreign = runCli(
      [
        "plan", "issue-close", "--session", coordinator, "--plan", PLAN_ID,
        "--issue", issueId, "--disposition", "resolved", "--file", evidencePath,
        "--expect-issue", "1",
        "--expect", String(rowRevision(fixture, coordinator)),
      ],
      fixture.root,
    );
    expect(foreign.exitCode).toBe(1);
    expect(jsonOf(foreign).code).toBe("issue.scope-refused");
    expect(listedIssues(fixture)[0]!.disposition).toBe("open");
  });
});

/* ----------------------------------------------------------------- preparation */

describe("mstar plan — prepare configuration", () => {
  test("prepare records the ordinary configuration and the scope resolves from it", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);

    const view = dataOf(runCli(["plan", "show", "--session", coordinator, "--plan", PLAN_ID], fixture.root));
    expect(view.revision).toBe(1);
    const scope = view.scope as Record<string, unknown>;
    expect(scope.worktreePath).toBe(fixture.worktreePath);
    expect(scope.workingBranch).toBe("feature/plan-a");
    const prepared = view.prepared;
    if (!objectOf(prepared)) throw new Error("prepared configuration missing from plan read");
    expect(prepared.qa_gate).toBe("mandatory");
    expect(prepared.findings_cleanup).toBe("allow-residual");
    expect(prepared.prepared_by).toBe(FIXTURE_COORDINATOR_ID);
  });

  test("a mistaken configuration stays correctable while the row is active", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    // The ordinary start record first: the corrected configuration must be
    // exercised against a row that has already started.
    toInProgress(fixture, coordinator, "started before the correction");
    const correctedPath = join(fixture.root, "wt-corrected");
    git(["worktree", "add", "-q", "-b", "feature/corrected", correctedPath], fixture.root);

    const corrected = runCli(
      [
        "plan", "prepare", "--session", coordinator, "--plan", PLAN_ID,
        "--worktree-path", correctedPath, "--working-branch", "feature/corrected",
        "--expect", String(rowRevision(fixture, coordinator)),
      ],
      fixture.root,
    );
    expect(corrected.exitCode, corrected.stdout).toBe(0);
    expect(dataOf(corrected).outcome).toBe("prepared");
    const scope = dataOf(runCli(["plan", "show", "--session", coordinator, "--plan", PLAN_ID], fixture.root)).scope as Record<string, unknown>;
    expect(scope.worktreePath).toBe(correctedPath);
    expect(scope.workingBranch).toBe("feature/corrected");
    // The started state is preserved by the correction: status/progress survive.
    expect(rowOf(fixture).status).toBe("InProgress");
  });

  test("prose edits alone never lock a row: the configuration is ordinary revisable data", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    writeText(join(fixture.harness, "plans", `${PLAN_ID}.md`), "# plan a\n\nedited prose\n");
    toInReview(fixture, coordinator, "prose edited after prepare");
    expect(rowOf(fixture).status).toBe("InReview");
  });

});

/* ------------------------------------------------------------------ direct completion */

const REPORT_ONLY_POLICY = "acceptance report at sdd/plan-a/report.md";
const REPORT_ONLY_EVIDENCE = "sdd/plan-a/report.md";

interface DeliveryFixture extends Fixture {
  baseSha: string;
  sourceSha: string;
  qcReport: string;
  qcConsolidated: string;
  qaReport: string;
}

/**
 * A standalone development fixture whose plan worktree is a REAL feature
 * checkout on `feature/plan-a` — the delivery source `complete` verifies.
 */
function makeDeliveryFixture(): DeliveryFixture {
  const fixture = makeFixture();
  const baseSha = gitOut(["rev-parse", "HEAD"], fixture.root);
  // Reuse the checkout the shared fixture already created and registered.
  writeText(join(fixture.worktreePath, "slice.txt"), "plan a slice\n");
  git(["add", "slice.txt"], fixture.worktreePath);
  gitCommit(fixture.worktreePath, "plan a: slice");
  const sourceSha = gitOut(["rev-parse", "HEAD"], fixture.worktreePath);

  writeJson(fixture.snapshotPath, {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    delivery_kind: "development",
    status: "running",
    started_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    branch: { source: "feature/plan-a", target: "main" },
    plans: [planRow(PLAN_ID, "feature/plan-a")],
  });

  const sdd = join(fixture.harness, "sdd", PLAN_ID);
  const qcReport = join(sdd, "review", "qc1.md");
  const qcConsolidated = join(sdd, "review", "qc.md");
  const qaReport = join(sdd, "qa.md");
  writeText(qcReport, "# QC 1\ndecision: Approve\n");
  writeText(qcConsolidated, "# QC consolidated\ndecision: Approve\n");
  writeText(qaReport, "# QA\nverdict: pass\n");
  return { ...fixture, baseSha, sourceSha, qcReport, qcConsolidated, qaReport };
}

/** The completion evidence document the standalone development route accepts. */
function completionEvidence(fixture: DeliveryFixture): Record<string, unknown> {
  return {
    source_sha: fixture.sourceSha,
    review_base: fixture.baseSha,
    review_head: fixture.sourceSha,
    qc: { decision: "Approve", reports: [fixture.qcReport], consolidated: fixture.qcConsolidated },
    qa: { gate: "mandatory", decision: "pass", report: fixture.qaReport },
  };
}

describe("standalone-development completion — direct coordinator operation", () => {
  test("prepare → progress → complete ends Done with no second seat and keeps the workflow running", () => {
    const fixture = makeDeliveryFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    toInReview(fixture, coordinator, "standalone ready for completion");

    const evidencePath = join(fixture.root, "completion.json");
    writeJson(evidencePath, completionEvidence(fixture));
    const completed = runCli(
      ["plan", "complete", "--session", coordinator, "--plan", PLAN_ID, "--file", evidencePath, "--expect", String(rowRevision(fixture, coordinator))],
      fixture.root,
    );
    expect(completed.exitCode, completed.stdout).toBe(0);
    expect(dataOf(completed).outcome).toBe("completed");
    expect(rowOf(fixture).status).toBe("Done");
    const completion = (rowOf(fixture).coordination as Record<string, unknown>).completion as Record<string, unknown>;
    expect(completion.source_sha).toBe(fixture.sourceSha);
    expect(completion.completed_by).toBe(FIXTURE_COORDINATOR_ID);
    expect(completion.integration).toBeUndefined();
    // The workflow stays active: compound disposition, its own delivery PR and
    // terminal close are still ahead.
    expect(readJson(fixture.snapshotPath).status).toBe("running");
    // Completion retained the row's own recorded scope for later cleanup.
    const metadata = rowOf(fixture).metadata as Record<string, unknown>;
    expect(metadata.worktree_path).toBe(fixture.worktreePath);
    expect(metadata.working_branch).toBe("feature/plan-a");
  }, CLI_INTEGRATION_TIMEOUT);

  test("an exact complete replay returns the recorded receipt and never rewrites the timestamp", () => {
    const fixture = makeDeliveryFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    toInReview(fixture, coordinator, "standalone ready for completion");

    const evidencePath = join(fixture.root, "completion.json");
    writeJson(evidencePath, completionEvidence(fixture));
    const args = ["plan", "complete", "--session", coordinator, "--plan", PLAN_ID, "--file", evidencePath, "--expect", String(rowRevision(fixture, coordinator))];
    const first = runCli(args, fixture.root);
    expect(first.exitCode, first.stdout).toBe(0);
    const completionOf = (): Record<string, unknown> =>
      (rowOf(fixture).coordination as Record<string, unknown>).completion as Record<string, unknown>;
    const firstAt = completionOf().completed_at;
    const snapshotStateBeforeReplay = snapshotState(fixture);

    const replay = runCli(args, fixture.root);
    expect(replay.exitCode, replay.stdout).toBe(0);
    expect(dataOf(replay).outcome).toBe("already-satisfied");
    expect(snapshotState(fixture)).toEqual(snapshotStateBeforeReplay);
    expect(completionOf().completed_at).toBe(firstAt);
  }, CLI_INTEGRATION_TIMEOUT);

  test("integration inputs are refused on the standalone development route", () => {
    const fixture = makeDeliveryFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    toInReview(fixture, coordinator, "standalone ready for completion");
    const before = snapshotState(fixture);

    const evidencePath = join(fixture.root, "completion.json");
    writeJson(evidencePath, completionEvidence(fixture));
    const contaminated = runCli(
      [
        "plan", "complete", "--session", coordinator, "--plan", PLAN_ID, "--file", evidencePath,
        "--integration-base-sha", fixture.baseSha, "--integration-result-sha", fixture.sourceSha,
        "--expect", String(rowRevision(fixture, coordinator)),
      ],
      fixture.root,
    );
    expect(contaminated.exitCode).toBe(1);
    expect(String(jsonOf(contaminated).code)).toMatch(/^(coordination|execution)\./);
    expect(snapshotState(fixture)).toEqual(before);

    // A half-stated integration pair is a caller-input refusal, never a silently
    // half-recorded merge.
    const partial = runCli(
      ["plan", "complete", "--session", coordinator, "--plan", PLAN_ID, "--file", evidencePath, "--integration-base-sha", fixture.baseSha, "--expect", String(rowRevision(fixture, coordinator))],
      fixture.root,
    );
    expect(partial.exitCode).toBe(2);
    expect(jsonOf(partial).code).toBe("command.invalid-input");
  }, CLI_INTEGRATION_TIMEOUT);

  test("complete refuses Todo and Blocked but completes a genuinely started InProgress row", () => {
    const fixture = makeDeliveryFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const evidencePath = join(fixture.root, "completion.json");
    writeJson(evidencePath, completionEvidence(fixture));
    const before = snapshotState(fixture);

    const refused = runCli(
      ["plan", "complete", "--session", coordinator, "--plan", PLAN_ID, "--file", evidencePath, "--expect", String(rowRevision(fixture, coordinator))],
      fixture.root,
    );
    expect(refused.exitCode).toBe(1);
    expect(String(jsonOf(refused).code)).toMatch(/^coordination\./);
    expect(rowOf(fixture).status).toBe("Todo");
    expect(snapshotState(fixture)).toEqual(before);
    const blockedPath = join(fixture.root, "blocked.json");
    writeJson(blockedPath, { status: "Blocked", summary: "awaiting work", evidence_paths: [fixture.evidencePath] });
    const blocked = runCli(
      ["plan", "progress", "--session", coordinator, "--plan", PLAN_ID, "--file", blockedPath, "--expect", String(rowRevision(fixture, coordinator))],
      fixture.root,
    );
    expect(blocked.exitCode, blocked.stdout).toBe(0);
    const blockedState = snapshotState(fixture);
    const blockedComplete = runCli(
      ["plan", "complete", "--session", coordinator, "--plan", PLAN_ID, "--file", evidencePath, "--expect", String(rowRevision(fixture, coordinator))],
      fixture.root,
    );
    expect(blockedComplete.exitCode).toBe(1);
    expect(snapshotState(fixture)).toEqual(blockedState);
    toInProgress(fixture, coordinator, "work resumed");
    const completed = runCli(
      ["plan", "complete", "--session", coordinator, "--plan", PLAN_ID, "--file", evidencePath, "--expect", String(rowRevision(fixture, coordinator))],
      fixture.root,
    );
    expect(completed.exitCode, completed.stdout).toBe(0);
    expect(rowOf(fixture).status).toBe("Done");
  }, CLI_INTEGRATION_TIMEOUT);
});

/* ------------------------------------------------------------------ retired verbs */

describe("mstar plan — retired transfer verbs are absent", () => {
  test("every removed verb is unknown to the CLI and writes nothing", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const before = snapshotState(fixture);
    for (const verb of [
      "handoff", "accept", "return", "integration-start", "integration-accept",
      "reconcile", "release", "repair-delivery-source", "residual-add", "residual-close",
    ]) {
      const result = runCli(
        ["plan", verb, "--session", coordinator, "--plan", PLAN_ID, "--expect", "1"],
        fixture.root,
      );
      expect(result.exitCode).toBe(2);
      expect(jsonOf(result)).toMatchObject({ status: "usage", code: "command.invalid-input" });
    }
    expect(snapshotState(fixture)).toEqual(before);
  });

});

/* ------------------------------------------------------------------ catalog pin */

describe("mstar plan — catalog pin", () => {
  test("catalog provenance on a store-less row does not become an execution lock", () => {
    const fixture = makeFixture({ store: false });
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);

    // No catalog store exists in this fixture. The reader discloses that
    // explicitly instead of reading the missing store as an empty catalog.
    const view = runCli(["plan", "show", "--session", coordinator, "--plan", PLAN_ID], fixture.root);
    expect(view.exitCode, view.stdout).toBe(0);
    expect(dataOf(view).catalog_pin).toMatchObject({
      source: null,
      pin: null,
      absence: "store-absent",
      conflict: null,
    });

    // Recorded hashes are provenance; without a store they cannot veto binding.
    const snapshot = readJson(fixture.snapshotPath) as { plans: Array<Record<string, unknown>> };
    const planted = { store_id: "store-x", entity_revision: 1, document_hash: "0".repeat(64), relation_hash: "0".repeat(64) };
    writeJson(fixture.snapshotPath, {
      ...snapshot,
      plans: snapshot.plans.map((row) =>
        row.id === PLAN_ID || row.plan_id === PLAN_ID
          ? { ...row, metadata: { ...(row.metadata as Record<string, unknown>), catalog_pin: planted } }
          : row,
      ),
    });

    const shown = runCli(["plan", "show", "--session", coordinator, "--plan", PLAN_ID], fixture.root);
    expect(shown.exitCode, shown.stdout).toBe(0);
    const pin = dataOf(shown).catalog_pin as { conflict: string | null; pin: { entity_revision: number } };
    expect(pin.pin.entity_revision).toBe(1);
    expect(pin.conflict).toBeNull();

    const bound = runCli(["plan", "bind", "--resume", coordinator], fixture.root);
    expect(bound.exitCode, bound.stdout).toBe(0);
    expect(rowOf(fixture).status).toBe("Todo");
  });

  test("an unknown plan id refuses instead of inventing a row", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    const refused = runCli(["plan", "show", "--session", coordinator, "--plan", "no-such-plan"], fixture.root);
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused)).toMatchObject({ status: "refused", code: "coordination.plan-not-found" });
  });
});

/** The `show-prepare` / `amend-prepare` argv one case drives, and the
 * fixtures the guard reads. Every engine fact is produced through the real
 * CLI/engine verbs.
 */
interface PrepareFixture {
  root: string;
  harness: string;
  snapshotPath: string;
  statusPath: string;
  compassPath: string;
  integrationPath: string;
  peerSnapshotPath: string;
  patchPath: string;
  planDir: string;
  specPath: string;
  coordinator: string;
}


/** A Prepare lifecycle with one Todo row, a reviewed compass and a real integration checkout. */
function makePrepareFixture(): PrepareFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-prepare-cli-")));
  roots.push(root);
  git(["init", "-q", "-b", "main"], root);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], root);

  const harness = join(root, ".mstar");
  const snapshotPath = join(harness, "workflows", PREPARE_WORKFLOW, "snapshot.json");
  const peerSnapshotPath = join(harness, "workflows", PREPARE_PEER, "snapshot.json");
  const statusPath = join(harness, "status.json");
  const compassPath = join(harness, "iterations", PREPARE_WORKFLOW, "delivery-compass.md");
  const integrationPath = join(root, "wt-integration");
  const planDir = join(harness, "plans");
  const specPath = join(harness, "specs", PREPARE_SPEC);
  const patchPath = join(root, "patch.json");

  for (const id of [PREPARE_ROW, PREPARE_APPEND]) {
    writeText(
      join(planDir, `${id}.md`),
      [
        `# Plan ${id}`,
        "",
        `**plan_id:** ${id}`,
        "**Status:** Todo",
        "**Main worktree branch:** main",
        `**Working branch:** feature/${id}`,
        "",
        "Body.",
        "",
      ].join("\n"),
    );
  }
  writeText(specPath, "# primary spec\n");
  writeText(
    compassPath,
    [
      "---",
      `iteration_id: ${PREPARE_WORKFLOW}`,
      "status: locked",
      "iteration_base_branch: main",
      `spec_integration_branch: ${PREPARE_INTEGRATION_BRANCH}`,
      "target_branch: main",
      "plans:",
      `  - ${PREPARE_ROW}`,
      `  - ${PREPARE_APPEND}`,
      "---",
      "",
      "# Compass",
      "",
    ].join("\n"),
  );
  git(["worktree", "add", "-q", "-b", PREPARE_INTEGRATION_BRANCH, integrationPath], root);

  writeJson(statusPath, {
    version: 2,
    updated_at: "2026-09-16",
    workflows: [
      {
        id: PREPARE_WORKFLOW,
        status: "running",
        type: "iteration",
        started_at: "2026-09-16",
        dir: `workflows/${PREPARE_WORKFLOW}`,
      },
      { id: PREPARE_PEER, status: "running", type: "iteration", started_at: "2026-09-16", dir: `workflows/${PREPARE_PEER}` },
    ],
  });
  writeJson(snapshotPath, {
    schema_version: 1,
    id: PREPARE_WORKFLOW,
    type: "iteration",
    status: "running",
    phase: "phase-1-prepare",
    started_at: "2026-09-16",
    updated_at: "2026-09-16",
    compass_ref: `iterations/${PREPARE_WORKFLOW}/delivery-compass.md`,
    branch: { base: "main", integration: PREPARE_INTEGRATION_BRANCH, target: "main" },
    execution_policy: { plan_parallelism: "serial", worktree_mode: "required" },
    plans: [{ id: PREPARE_ROW, title: `Plan ${PREPARE_ROW}`, file: join(planDir, `${PREPARE_ROW}.md`), status: "Todo" }],
  });
  writeJson(peerSnapshotPath, {
    schema_version: 1,
    id: PREPARE_PEER,
    type: "iteration",
    status: "running",
    phase: "phase-1-prepare",
    started_at: "2026-09-16",
    updated_at: "2026-09-16",
    plans: [{ id: "plan-peer", title: "Plan peer", file: join(planDir, "plan-peer.md"), status: "Todo" }],
  });
  writeJson(patchPath, preparePatchOf({ planDir, specPath, compassPath, integrationPath }));

  const bound = runCli(
    ["plan", "bind", "--coordinator", "--workflow", PREPARE_WORKFLOW, "--session-id", FIXTURE_COORDINATOR_ID],
    root,
  );
  expect(bound.exitCode).toBe(0);
  const coordinator = String(dataOf(bound).session_file);

  return {
    root,
    harness,
    snapshotPath,
    statusPath,
    compassPath,
    integrationPath,
    peerSnapshotPath,
    patchPath,
    planDir,
    specPath,
    coordinator,
  };
}

/** The paths one approved patch carries (the fixture's own reviewed references). */
type PreparePaths = {
  planDir: string;
  specPath: string;
  compassPath: string;
  integrationPath: string;
};

/** The approved delta: append one Todo row, record the checkout and the policy. */
function preparePatchOf(paths: PreparePaths): Record<string, unknown> {
  return {
    mainWorktreeBranch: "main",
    appendPlans: [
      {
        id: PREPARE_APPEND,
        title: `Plan ${PREPARE_APPEND}`,
        file: join(paths.planDir, `${PREPARE_APPEND}.md`),
        metadata: {
          primary_spec: paths.specPath,
          spec_refs: [paths.specPath],
          iteration_compass: paths.compassPath,
          iteration_refs: [paths.compassPath],
          working_branch: `feature/${PREPARE_APPEND}`,
          spec_integration_branch: PREPARE_INTEGRATION_BRANCH,
          merge_target: PREPARE_INTEGRATION_BRANCH,
        },
      },
    ],
    integrationWorktreePath: paths.integrationPath,
    planParallelism: "parallel",
  };
}

/** The `show-prepare` argv one case drives. */
function showPrepareArgs(fixture: PrepareFixture): string[] {
  return ["workflow", "show-prepare", "--session", fixture.coordinator];
}

/** The amendment carries actual public patch data, not unused byte-token mirrors. */
function amendPrepareArgs(fixture: PrepareFixture): string[] {
  return ["workflow", "amend-prepare", "--session", fixture.coordinator, "--input", JSON.stringify(readJson(fixture.patchPath))];
}


interface ReportOnlyFixture extends Fixture {
  /** The recorded base the fixture branched its feature checkout from. */
  baseSha: string;
  /** The pinned source commit of the feature checkout. */
  sourceSha: string;
  coordinator: string;
  qcReport: string;
  qcConsolidated: string;
  qaReport: string;
}

/**
 * A report-only row driven through the real CLI: registration records its
 * lifecycle and the coordinator prepares and starts it. No policy fulfilment
 * is recorded yet, so each case supplies the explicit outer evidence that
 * direct completion must consult.
 */
function makeAcceptedReportOnlyFixture(): ReportOnlyFixture {
  const fixture = makeFixture();
  const baseSha = gitOut(["rev-parse", "HEAD"], fixture.root);

  // Registration is create-only and produces BOTH documents itself, so the
  // shared fixture's placeholder snapshot and root entry are removed first —
  // the root entry the chain later unregisters is the producer's own.
  rmSync(fixture.snapshotPath, { force: true });
  rmSync(join(fixture.harness, "status.json"), { force: true });

  // The registration producer DERIVES the row identity and title from the
  // selected plan document (contract R1: the document is the registration
  // authority), so the shared fixture's `# plan a` placeholder — which declares
  // no `plan_id` — is not registrable. Seed the document the registration is
  // reviewed against; the title must agree with the `--plan-title` below, which
  // is a constraint against the document rather than an override of it.
  writeText(join(fixture.harness, "plans", `${PLAN_ID}.md`), `# Plan ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n\n**title:** Plan ${PLAN_ID}\n`);

  // The real feature checkout supplies optional report provenance only.
  // Report-only completion owns no delivery branch and requires no Git proof,
  // source merge or integration target.
  // The shared fixture already created and registered `feature/plan-a` at this
  // path: reuse that checkout (a second `-b` would collide with the existing
  // branch/worktree registration).
  writeText(join(fixture.worktreePath, "report-only.txt"), "report-only slice\n");
  git(["add", "report-only.txt"], fixture.worktreePath);
  gitCommit(fixture.worktreePath, "plan a: report-only slice");
  const sourceSha = gitOut(["rev-parse", "HEAD"], fixture.worktreePath);

  const registered = runCli(
    [
      "workflow",
      "register",
      "--workflow",
      WORKFLOW_ID,
      "--plan-id",
      PLAN_ID,
      "--plan-title",
      `Plan ${PLAN_ID}`,
      // The CLI-boundary spelling for a plan pointer is harness-relative
      // (`plans/<id>.md`), exactly as `workflow-register.test.ts` and
      // `iteration-register.test.ts` pass it: the register producer records
      // this string on the row AND as the catalog entity's `relativePath`,
      // whose root is `{PLAN_DIR}` — an absolute value is refused there
      // (`catalog.path-refused`, `packages/engine/src/catalog.ts:296`).
      "--plan-file",
      join("plans", `${PLAN_ID}.md`),
      "--delivery-kind",
      "verification/report-only",
      "--completion-policy",
      REPORT_ONLY_POLICY,
      "--project",
      PROJECT_ID,
      "--started-at",
      "2026-09-22T00:00:00Z",
      "--harness",
      fixture.harness,
    ],
    fixture.root,
  );
  // The refusal text is carried in the expectation, so a failed run reports the
  // engine's own code instead of only an exit code.
  expect(`workflow register: exit ${registered.exitCode} (${registered.stderr.trim()})`).toBe(
    "workflow register: exit 0 ()",
  );
  expect(jsonOf(registered)).toMatchObject({
    command: "workflow.register",
    status: "ok",
    code: "workflow.register.ok",
    exitCode: 0,
  });
  const registeredDoc = readJson(fixture.snapshotPath);
  expect(registeredDoc.delivery_kind).toBe("verification/report-only");
  expect(registeredDoc.completion_policy).toBe(REPORT_ONLY_POLICY);
  // The declared kind owns its own registration evidence: no branch anchors.
  expect(registeredDoc.branch).toBeUndefined();

  const sdd = join(fixture.harness, "sdd", PLAN_ID);
  const qcReport = join(sdd, "review", "qc1.md");
  const qcConsolidated = join(sdd, "review", "qc.md");
  const qaReport = join(sdd, "qa.md");
  writeText(qcReport, "# QC 1\ndecision: Approve\n");
  writeText(qcConsolidated, "# QC consolidated\ndecision: Approve\n");
  writeText(qaReport, "# QA\nverdict: pass\n");

  const coordinator = bindCoordinator(fixture);
  preparePlan(fixture, coordinator, PLAN_ID, fixture.worktreePath);
  toInReview(fixture, coordinator, "report-only ready for completion");

  return { ...fixture, baseSha, sourceSha, coordinator, qcReport, qcConsolidated, qaReport };
}

/** The stored `delivery` block (the recorded-evidence witness). */
function deliveryOf(fixture: Fixture): Record<string, unknown> {
  const delivery = readJson(fixture.snapshotPath).delivery;
  return typeof delivery === "object" && delivery !== null && !Array.isArray(delivery)
    ? (delivery as Record<string, unknown>)
    : {};
}

/** One direct completion of the report-only row through the coordinator. */
function completeReportOnly(fixture: ReportOnlyFixture): RunResult {
  const payload = join(fixture.root, "completion.json");
  writeJson(payload, {
    source_sha: fixture.sourceSha,
    review_base: fixture.baseSha,
    review_head: fixture.sourceSha,
    qc: { decision: "Approve", reports: [fixture.qcReport], consolidated: fixture.qcConsolidated },
    qa: { gate: "mandatory", decision: "pass", report: fixture.qaReport },
  });
  return runCli(
    ["plan", "complete", "--session", fixture.coordinator, "--plan", PLAN_ID, "--file", payload,
      "--expect", String(rowRevision(fixture, fixture.coordinator))],
    fixture.root,
  );
}

/** Record one `delivery.completion` fulfilment through the authorized evidence verb. */
function recordCompletionEvidence(
  fixture: ReportOnlyFixture,
  policy: string,
  evidence = REPORT_ONLY_EVIDENCE,
): RunResult {
  const payload = join(fixture.root, "completion-evidence.json");
  writeJson(payload, { completion: { policy, evidence } });
  return runCli(
    [
      "workflow",
      "evidence",
      "--workflow",
      WORKFLOW_ID,
      "--file",
      payload,
      "--session",
      fixture.coordinator,
      "--at",
      "2026-09-22T01:00:00Z",
      "--harness",
      fixture.harness,
    ],
    fixture.root,
  );
}

/** The terminal close of the coordinated report-only lifecycle. */
function closeReportOnly(fixture: ReportOnlyFixture, endedAt = "2026-09-22"): RunResult {
  return runCli(
    [
      "status",
      "workflow-close",
      "--workflow",
      WORKFLOW_ID,
      "--ended-at",
      endedAt,
      "--session",
      fixture.coordinator,
      "--harness",
      fixture.harness,
    ],
    fixture.root,
  );
}

/** The read-only phase-6 projection over the same lifecycle state as the close. */
function phase6Gate(fixture: ReportOnlyFixture): RunResult {
  return runCli(
    ["iteration", "gate", "--phase", "6", "--workflow", WORKFLOW_ID, "--harness", fixture.harness],
    fixture.root,
  );
}

describe("report-only completion", () => {
  test("register → completion evidence → complete → close → phase 6 with no merge or integration", () => {
    const fixture = makeAcceptedReportOnlyFixture();
    const acceptedBytes = snapshotState(fixture);

    // Readable evidence must reach the actual report-only integration guard.
    const contaminatedPath = join(fixture.root, "contaminated-completion.json");
    writeJson(contaminatedPath, {
      qc: { decision: "Approve", reports: [fixture.qcReport], consolidated: fixture.qcConsolidated },
      qa: { gate: "mandatory", decision: "pass", report: fixture.qaReport },
    });
    const refusedStart = runCli(
      ["plan", "complete", "--session", fixture.coordinator, "--plan", PLAN_ID, "--file", contaminatedPath,
        "--expect", String(rowRevision(fixture, fixture.coordinator)),
        "--integration-base-sha", "a".repeat(40), "--integration-result-sha", "b".repeat(40)],
      fixture.root,
    );
    expect(refusedStart.exitCode).toBe(1);
    expect(jsonOf(refusedStart).code).toBe("coordination.invalid-transition");
    expect(snapshotState(fixture)).toEqual(acceptedBytes);

    // Explicit registered-policy fulfilment precedes direct row completion;
    // Done does not imply any source merge or outer close.
    const recorded = recordCompletionEvidence(fixture, REPORT_ONLY_POLICY);
    expect(recorded.exitCode).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({ command: "workflow.evidence", status: "ok", exitCode: 0 });
    expect(deliveryOf(fixture)).toEqual({ completion: { policy: REPORT_ONLY_POLICY, evidence: REPORT_ONLY_EVIDENCE } });
    expect(rowOf(fixture).status).toBe("InReview");

    const completed = completeReportOnly(fixture);
    expect(completed.exitCode).toBe(0);
    expect(dataOf(completed).outcome).toBe("completed");
    expect(rowOf(fixture).status).toBe("Done");
    expect((rowOf(fixture).coordination as Record<string, unknown>).completion).toBeDefined();
    
    // The row is Done while the delivery tail is still ahead: the workflow
    // stays running, and no fabricated merge or integration anchor appears.
    const afterComplete = readJson(fixture.snapshotPath);
    expect(afterComplete.status).toBe("running");
    expect(afterComplete.integration_merge_lease).toBeUndefined();
    expect(afterComplete.integration_worktree_path).toBeUndefined();
    const branch = afterComplete.branch as Record<string, unknown> | undefined;
    expect(branch?.integration).toBeUndefined();
    const completion = (rowOf(fixture).coordination as Record<string, unknown>).completion as Record<string, unknown>;
    expect(completion.integration).toBeUndefined();

    // Recovery replays the completed row without rewriting the terminal bytes.
    const completeBytes = snapshotState(fixture);
    const replay = runCli(
      ["plan", "complete", "--session", fixture.coordinator, "--plan", PLAN_ID, "--file", join(fixture.root, "completion.json"),
        "--expect", String(rowRevision(fixture, fixture.coordinator))],
      fixture.root,
    );
    expect(replay.exitCode, replay.stdout).toBe(0);
    expect(dataOf(replay).outcome).toBe("already-satisfied");
    expect(snapshotState(fixture)).toEqual(completeBytes);

    // The close writes `completed` from the evidence it already consults, then
    // unregisters the producer's own root entry.
    const closed = closeReportOnly(fixture);
    expect(closed.exitCode).toBe(0);
    const terminal = readJson(fixture.snapshotPath);
    expect(terminal.status).toBe("completed");
    expect(terminal.ended_at).toBe("2026-09-22");
    expect(readJson(join(fixture.harness, "status.json")).workflows).toEqual([]);

    // The phase-6 projection passes on the same lifecycle state.
    const gate = phase6Gate(fixture);
    expect(gate.exitCode).toBe(0);
    expect(JSON.parse(gate.stdout)).toMatchObject({ status: "ok", exitCode: 0 });

    // And the fixture never created the integration branch a merge would have
    // needed — "no merge" is observed here, not claimed.
    expect(gitOut(["branch", "--format=%(refname:short)"], fixture.root).split("\n")).not.toContain(INTEGRATION_BRANCH);
  }, RECOVERY_TIMEOUT);

  test("missing policy evidence refuses complete with zero writes until explicit evidence lands (A17)", () => {
    const fixture = makeAcceptedReportOnlyFixture();
    const before = snapshotState(fixture);

    // Without a recorded fulfilment the direct completion refuses: QA pass and
    // an InReview row are not fulfilment, and the route never invents it.
    const refused = completeReportOnly(fixture);
    expect(refused.exitCode).toBe(1);
    const failure = jsonOf(refused);
    expect(failure.status).toBe("refused");
    expect(failure.code).toBe("coordination.invalid-transition");
    expect(rowOf(fixture).status).toBe("InReview");
    expect((rowOf(fixture).coordination as Record<string, unknown>).completion).toBeUndefined();
    expect(snapshotState(fixture)).toEqual(before);

    // The ordinary terminal close also refuses while the row is not Done: the
    // outer lifecycle obligation (evidence-backed terminal close) is not met by
    // an uncompleted row, so nothing is fabricated here either.
    const closed = closeReportOnly(fixture);
    expect(closed.exitCode).toBe(1);

    // Zero writes so far: the row stays InReview and the registered policy is
    // still unfulfilled — the operator must supply the explicit evidence.
    expect(rowOf(fixture).status).toBe("InReview");
    expect(deliveryOf(fixture)).toEqual({});
    expect(snapshotState(fixture)).toEqual(before);
  }, RECOVERY_TIMEOUT);

  test("mismatched completion policy refuses complete and preserves the recorded evidence", () => {
    const fixture = makeAcceptedReportOnlyFixture();
    expect(recordCompletionEvidence(fixture, "a different completion policy").exitCode).toBe(0);
    const before = snapshotState(fixture);

    const refused = completeReportOnly(fixture);
    expect(refused.exitCode).toBe(1);
    const failure = jsonOf(refused);
    expect(failure).toMatchObject({ status: "refused", code: "coordination.invalid-transition" });
    expect(rowOf(fixture).status).toBe("InReview");
    expect(snapshotState(fixture)).toEqual(before);
    // The mismatched fulfilment is still the stored evidence: nothing repaired
    // it silently, and the registered policy was never overwritten.
    expect(deliveryOf(fixture)).toEqual({
      completion: { policy: "a different completion policy", evidence: REPORT_ONLY_EVIDENCE },
    });
    expect(readJson(fixture.snapshotPath).completion_policy).toBe(REPORT_ONLY_POLICY);

    // Correct the missing matching fulfilment through ordinary workflow
    // evidence, then complete the row and close the report-only workflow.
    expect(recordCompletionEvidence(fixture, REPORT_ONLY_POLICY, "sdd/plan-a/report-v2.md").exitCode).toBe(0);
    const completed = completeReportOnly(fixture);
    expect(completed.exitCode).toBe(0);
    expect(rowOf(fixture).status).toBe("Done");
    expect(closeReportOnly(fixture).exitCode).toBe(0);
    expect(readJson(fixture.snapshotPath).status).toBe("completed");
  }, RECOVERY_TIMEOUT);

  test("completion reference remains the accepted basis after Done", () => {
    const fixture = makeAcceptedReportOnlyFixture();
    expect(recordCompletionEvidence(fixture, REPORT_ONLY_POLICY).exitCode).toBe(0);
    const completed = completeReportOnly(fixture);
    expect(completed.exitCode).toBe(0);
    expect(rowOf(fixture).status).toBe("Done");
    const done = rowOf(fixture);

    const revised = recordCompletionEvidence(fixture, REPORT_ONLY_POLICY, "sdd/plan-a/report-v2.md");
    expect(revised.exitCode).toBe(1);
    expect(jsonOf(revised).code).toBe("coordination.completion-frozen");
    expect(deliveryOf(fixture)).toEqual({ completion: { policy: REPORT_ONLY_POLICY, evidence: REPORT_ONLY_EVIDENCE } });
    expect(rowOf(fixture)).toEqual(done);

    const retried = recordCompletionEvidence(fixture, REPORT_ONLY_POLICY);
    expect(retried.exitCode).toBe(0);
    expect(rowOf(fixture)).toEqual(done);

    // Close consumes the current fulfilment under the registered policy.
    const closed = closeReportOnly(fixture);
    expect(closed.exitCode).toBe(0);
    expect(readJson(fixture.snapshotPath).status).toBe("completed");
  }, RECOVERY_TIMEOUT);

  // QC seat 2 F-1: the close authority must not be bypassable by planting a
  // stored handoff on a Done row. The invalid payload is constructed EXPLICITLY
  // here (the direct model never creates one); only the stored state moves, and
  // the row stays Done, so the close's row-Done precondition is satisfied.
  test("a stored handoff planted on a Done row refuses the close (F-1)", () => {
    const fixture = makeAcceptedReportOnlyFixture();
    expect(recordCompletionEvidence(fixture, REPORT_ONLY_POLICY).exitCode).toBe(0);
    const completed = completeReportOnly(fixture);
    expect(completed.exitCode).toBe(0);
    expect(rowOf(fixture).status).toBe("Done");

    const snapshot = readJson(fixture.snapshotPath);
    const plan = (snapshot.plans as Array<Record<string, unknown>>)[0]!;
    const coordination = (plan.coordination ?? {}) as Record<string, unknown>;
    coordination.handoff = {
      state: "accepted",
      id: "planted-legacy-handoff",
      source_branch: "feature/plan-a",
      worktree_path: fixture.worktreePath,
    };
    plan.coordination = coordination;
    snapshot.integration_worktree_path = fixture.root;
    writeJson(fixture.snapshotPath, snapshot);
    const rewritten = snapshotState(fixture);

    const closed = closeReportOnly(fixture);
    expect(closed.exitCode).toBe(1);
    expect(jsonOf(closed).code).toBe("coordination.store");
    // Zero writes: the workflow stays running, registered and byte-identical.
    expect(readJson(fixture.snapshotPath).status).toBe("running");
    expect(snapshotState(fixture)).toEqual(rewritten);
    expect((readJson(join(fixture.harness, "status.json")).workflows as unknown[]).length).toBe(1);

    // The read-only gate reaches the same refusal through the SAME validator:
    // the rewritten document is an invalid snapshot, not merely non-terminal.
    const gate = phase6Gate(fixture);
    expect(gate.exitCode).toBe(1);
    expect(jsonOf(gate).details).toMatchObject({
      gate: { violations: expect.arrayContaining([expect.objectContaining({ code: "PHASE6_INVALID_SNAPSHOT" })]) },
    });
  }, RECOVERY_TIMEOUT);
});

describe("Prepare workflow amendment", () => {
  test("show-prepare reads the admissible scope and amend-prepare applies the approved delta with a readback", () => {
    const fixture = makePrepareFixture();
    const peerBefore = readJson(fixture.peerSnapshotPath);
    const statusBefore = readJson(fixture.statusPath);

    const show = runCli(showPrepareArgs(fixture), fixture.root);
    expect(show.exitCode).toBe(0);
    const view = viewOf(show);
    expect(view.workflowId).toBe(PREPARE_WORKFLOW);
    expect(view.allowed).toBe(true);
    expect(view.blockers).toEqual([]);
    expect(view.planIds).toEqual([PREPARE_ROW]);
    
    

    const amend = runCli(
      amendPrepareArgs(fixture),
      fixture.root,
    );
    expect(amend.exitCode).toBe(0);
    const amended = viewOf(amend);
    expect(dataOf(amend).outcome).toBe("amended");
    expect(amended.allowed).toBe(true);
    expect(amended.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    
    
    

    // The readback: the authoritative snapshot and a second show agree, and the
    // unrelated workflow / root register were never written.
    const snapshot = readJson(fixture.snapshotPath);
    expect((snapshot.plans as Array<Record<string, unknown>>).map((row) => row.id)).toEqual([
      PREPARE_ROW,
      PREPARE_APPEND,
    ]);
    expect(snapshot.integration_worktree_path).toBe(fixture.integrationPath);
    expect(snapshot.execution_policy).toEqual({ plan_parallelism: "parallel", worktree_mode: "required" });
    const readback = viewOf(runCli(showPrepareArgs(fixture), fixture.root));
    
    expect(readback.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(readJson(fixture.peerSnapshotPath)).toEqual(peerBefore);
    expect(readJson(fixture.statusPath)).toEqual(statusBefore);
  }, 30000);

  test("missing required inputs and unknown flags are usage errors", () => {
    const fixture = makePrepareFixture();
    const before = readJson(fixture.snapshotPath);
    const usageCases: Array<{ name: string; args: string[] }> = [
      { name: "missing-session", args: ["workflow", "show-prepare"] },
      {
        name: "missing-input",
        args: [
          "workflow", "amend-prepare", "--session", fixture.coordinator,
        ],
      },
      {
        name: "unknown-flag",
        args: ["workflow", "amend-prepare", "--session", fixture.coordinator, "--force"],
      },
    ];

    for (const usageCase of usageCases) {
      const result = runCli(usageCase.args, fixture.root);
      expect(`${usageCase.name}: ${result.exitCode}`).toBe(`${usageCase.name}: 2`);
      const payload = jsonOf(result);
      expect(payload.status).toBe("usage");
      expect(`${usageCase.name}: ${String(payload.code)}`).toBe(`${usageCase.name}: command.invalid-input`);
    }
    // No usage case reached the engine.
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  }, 60000);


  test("a duplicate plan id refuses through the CLI while the read stays available", () => {
    const fixture = makePrepareFixture();
    const patch = preparePatchOf(fixture);
    const appends = patch.appendPlans as Array<Record<string, unknown>>;
    // Re-declare the EXISTING row COHERENTLY: id, title, document and branch all
    // name `plan-prepare`'s own facts. Keeping the append's `plan-append.md`
    // pointer under the id `plan-prepare` (or its `feature/plan-append` branch)
    // is an incoherent declaration the resolver refuses earlier as `invalid-plan`,
    // which would mask the duplicate check this case is about.
    writeJson(fixture.patchPath, {
      ...patch,
      appendPlans: [
        {
          ...appends[0]!,
          id: PREPARE_ROW,
          title: `Plan ${PREPARE_ROW}`,
          file: join(fixture.planDir, `${PREPARE_ROW}.md`),
          metadata: {
            ...(appends[0]!.metadata as Record<string, unknown>),
            working_branch: `feature/${PREPARE_ROW}`,
          },
        },
      ],
    });

    const refused = runCli(
      amendPrepareArgs(fixture),
      fixture.root,
    );

    expect(refused.exitCode).toBe(1);
    const payload = jsonOf(refused);
    expect(payload.status).toBe("refused");
    expect(payload.code).toBe("coordination.prepare-amendment.duplicate-plan");
    // Components are independent (§4.1/A23/A27): the DUPLICATE is withheld while
    // this patch's unrelated components (the checkout and the policy) still land,
    // so the snapshot legitimately moves. What must hold is that the row was not
    // re-declared and the review stays readable and re-appliable.
    const after = JSON.parse(readText(fixture.snapshotPath)) as { plans: Array<{ id: string }> };
    expect(after.plans.filter((row) => row.id === PREPARE_ROW)).toHaveLength(1);
    expect(viewOf(runCli(showPrepareArgs(fixture), fixture.root)).allowed).toBe(true);
  });

  test("a workflow refusal carries the addressed workflow id from the engine details", () => {
    const fixture = makePrepareFixture();
    const before = readJson(fixture.snapshotPath);
    // The reviewed compass disappears between the read and the amendment, so
    // the engine refusal carries the addressed workflow in its own details.
    rmSync(fixture.compassPath);

    const refused = runCli(
      amendPrepareArgs(fixture),
      fixture.root,
    );

    expect(refused.exitCode).toBe(1);
    const payload = jsonOf(refused);
    expect(payload.status).toBe("refused");
    expect(payload.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(payload.details).toMatchObject({ workflow_id: PREPARE_WORKFLOW });
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  });


  test("an unexpected workflow-family failure carries the workflow family's own code", () => {
    const fixture = makePrepareFixture();
    const before = readJson(fixture.snapshotPath);
    const snapshotDir = dirname(fixture.snapshotPath);
    // The snapshot directory loses write permission after the read, so the
    // write-lock mkdir next to snapshot.json throws a raw FS error (EACCES)
    // rather than a typed coordination / plan-path refusal. That is still
    // the unexpected-error path, which must name the family the caller ran
    // and must not have written anything.
    chmodSync(snapshotDir, 0o555);
    try {
      const failed = runCli(
        amendPrepareArgs(fixture),
        fixture.root,
      );

      expect(failed.exitCode).toBe(1);
      const payload = jsonOf(failed);
      expect(payload.status).toBe("refused");
      expect(payload.code).toBe("EACCES");
      expect(readJson(fixture.snapshotPath)).toEqual(before);
    } finally {
      chmodSync(snapshotDir, 0o755);
    }
  }, 30000);

  test("a plan-file correction travels through the CLI JSON payload and repairs a malformed pointer", () => {
    const fixture = makePrepareFixture();
    // The row holds the repository-relative pointer rows registered before the
    // resolver landed; the correction names that same plan's canonical file and
    // the exact pointer it replaces.
    const doc = readJson(fixture.snapshotPath) as { plans: Array<Record<string, unknown>> };
    doc.plans[0]!.file = `.mstar/plans/${PREPARE_ROW}.md`;
    writeJson(fixture.snapshotPath, doc);
    const correctedPath = join(fixture.planDir, `${PREPARE_ROW}.md`);
    writeJson(fixture.patchPath, {
      ...preparePatchOf(fixture),
      correctPlanFiles: [{ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: correctedPath }],
    });
    const statusBefore = readJson(fixture.statusPath);

    const amended = runCli(
      amendPrepareArgs(fixture),
      fixture.root,
    );

    expect(amended.exitCode).toBe(0);
    const payload = viewOf(amended);
    expect(dataOf(amended).outcome).toBe("amended");
    expect(payload.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);

    const after = readJson(fixture.snapshotPath) as { plans: Array<Record<string, unknown>> };
    expect(after.plans[0]!.file).toBe(correctedPath);
    // The correction is a delta: the root register never moves.
    expect(readJson(fixture.statusPath)).toEqual(statusBefore);

    // A correction whose old pointer names a foreign document refuses with exit
    // 1 and leaves the snapshot byte-identical.
    const before = readJson(fixture.snapshotPath);
    writeJson(fixture.patchPath, {
      ...preparePatchOf(fixture),
      appendPlans: [],
      correctPlanFiles: [
        { id: PREPARE_ROW, expectedFile: join(fixture.root, `${PREPARE_ROW}.md`), file: correctedPath },
      ],
    });
    const refused = runCli(
      amendPrepareArgs(fixture),
      fixture.root,
    );
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused).code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  }, 30000);
});

/* ------------------------------------------------------------------------ *
 * `mstar workflow recover-coordinator` — JSON Prepare coordinator recovery
 * (prerequisite contract §3.3)
 * ------------------------------------------------------------------------ */

/** The replacement coordinator identity the CLI cases state explicitly. */
const CLI_RECOVERY_SESSION_ID = "recovered-cli-coordinator";

/** The `workflow recover-coordinator` argv one case drives. */
function recoverCoordinatorArgs(
  fixture: PrepareFixture,
  overrides: Record<string, unknown> = {},
): string[] {
  const flags: Array<[string, string | undefined]> = [
    ["--session", overrides.priorSession as string | undefined ?? fixture.coordinator],
    ["--session-id", overrides.sessionId as string | undefined ?? CLI_RECOVERY_SESSION_ID],
    ["--operation-id", overrides.operationId as string | undefined ?? "op-cli-recover-1"],
  ];
  if (overrides.omitReason !== true) {
    flags.push(["--reason", (overrides.reason as string | undefined) ?? "the prior host session was cancelled"]);
  }
  flags.push(["--authorization-ref", (overrides.authorizationRef as string | undefined) ?? "PM-authorization-20260921"]);
  const argv = ["workflow", "recover-coordinator"];
  for (const [flag, value] of flags) {
    if (value === undefined) continue;
    argv.push(flag, value);
  }
  const stopped = overrides.stopped as string[] | undefined ?? ["fixture-coordinator"];
  for (const id of stopped) argv.push("--stopped", id);
  return argv;
}

/**
 * The stored top-level `coordination` block of the CLI fixture's workflow,
 * narrowed by `typeof` before any member is read (the snapshot JSON is
 * `unknown` at this boundary).
 */
function cliCoordinationOf(fixture: PrepareFixture): Record<string, unknown> {
  const coordination = readJson(fixture.snapshotPath).coordination;
  // Narrowed above; the block is a plain object when present.
  return typeof coordination === "object" && coordination !== null && !Array.isArray(coordination)
    ? (coordination as Record<string, unknown>)
    : {};
}

/** The stored coordinator binding of the CLI fixture's workflow. */
function cliRecordedCoordinator(fixture: PrepareFixture): Record<string, unknown> {
  const coordinator = cliCoordinationOf(fixture).coordinator;
  return typeof coordinator === "object" && coordinator !== null && !Array.isArray(coordinator)
    ? (coordinator as Record<string, unknown>)
    : {};
}

/** The stored recovery audit of the CLI fixture's workflow. */
function cliRecoveryAudit(fixture: PrepareFixture): Array<Record<string, unknown>> {
  const recoveries = cliCoordinationOf(fixture).identity_recoveries;
  return Array.isArray(recoveries) ? (recoveries as Array<Record<string, unknown>>) : [];
}

/** The workflow's plan rows as stored on disk (the preservation witness). */
function cliPlanRowsOf(fixture: PrepareFixture): unknown {
  return readJson(fixture.snapshotPath).plans;
}

describe("prepare coordinator recovery — CLI transport", () => {
  test("prepare coordinator recovery travels through `workflow recover-coordinator` and the old reference refuses", () => {
    const fixture = makePrepareFixture();
    const peerBefore = readJson(fixture.peerSnapshotPath);
    const rowsBefore = cliPlanRowsOf(fixture);
    const basis = viewOf(runCli(showPrepareArgs(fixture), fixture.root));

    const recovered = runCli(recoverCoordinatorArgs(fixture), fixture.root);

    expect(recovered.exitCode).toBe(0);
    const envelope = JSON.parse(recovered.stdout);
    expect(envelope).toMatchObject({ command: "workflow.recover-coordinator", status: "ok", exitCode: 0 });
    const data = envelope.data;
    expect(data.outcome).toBe("recovered");
    const newEnvelope = join(fixture.harness, "workflows", PREPARE_WORKFLOW, "sessions", `coordinator-${CLI_RECOVERY_SESSION_ID}.json`);
    expect(data.session_file).toBe(newEnvelope);
    expect(data.recovery).toMatchObject({
      workflowId: PREPARE_WORKFLOW,
      priorSessionId: FIXTURE_COORDINATOR_ID,
      sessionId: CLI_RECOVERY_SESSION_ID,
      operationId: "op-cli-recover-1",
      replay: false,
    });
    expect(existsSync(newEnvelope)).toBe(true);
    expect(recovered.stderr).toBe("");
    const human = runCli(recoverCoordinatorArgs(fixture), fixture.root);
    expect(human.exitCode).toBe(0);
    expect(JSON.parse(human.stdout)).toMatchObject({ command: "workflow.recover-coordinator", status: "ok" });
    expect(human.stderr).toBe("");
    // Authoritative state, read from disk — never from the CLI's claim.
    expect(cliRecordedCoordinator(fixture)).toMatchObject({ session_id: CLI_RECOVERY_SESSION_ID });
    const audit = cliRecoveryAudit(fixture);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operation_id: "op-cli-recover-1",
      prior_session_id: FIXTURE_COORDINATOR_ID,
      session_id: CLI_RECOVERY_SESSION_ID,
      snapshot_version_before: basis.snapshotVersion,
      compass_version: basis.compassVersion,
    });
    // Rows and the sibling workflow are untouched; the old envelope survives.
    expect(cliPlanRowsOf(fixture)).toEqual(rowsBefore);
    expect(readJson(fixture.peerSnapshotPath)).toEqual(peerBefore);
    expect(existsSync(fixture.coordinator)).toBe(true);

    // The old reference is historical: the binding moved, so it refuses, while
    // the replacement session is the live coordinator.
    const oldRefused = runCli(showPrepareArgs(fixture), fixture.root);
    expect(oldRefused.exitCode).toBe(1);
    const oldPayload = jsonOf(oldRefused);
    expect(oldPayload.code).toBe("coordination.session-mismatch");
    const live = runCli(
      ["workflow", "show-prepare", "--session", newEnvelope],
      fixture.root,
    );
    expect(live.exitCode).toBe(0);
    expect(viewOf(live).allowed).toBe(true);

    // An exact retry with the same operation identity is a stable receipt.
    const committedBytes = readJson(fixture.snapshotPath);
    const retry = runCli(recoverCoordinatorArgs(fixture), fixture.root);
    expect(retry.exitCode).toBe(0);
    const replay = dataOf(retry).recovery;
    if (!objectOf(replay)) throw new Error("recovery receipt missing");
    expect(replay.replay).toBe(true);
    expect(readJson(fixture.snapshotPath)).toEqual(committedBytes);
    expect(cliRecoveryAudit(fixture)).toHaveLength(1);

    // Changed request facts and an incomplete stop assertion refuse without
    // moving the committed coordinator or rewriting the audit.
    const changedReason = runCli(
      recoverCoordinatorArgs(fixture, { operationId: "op-cli-recover-1", reason: "another reason" }),
      fixture.root,
    );
    expect(changedReason.exitCode).toBe(1);
    expect(jsonOf(changedReason)).toMatchObject({ status: "refused", code: "coordination.identity-recovery.operation-conflict", details: { workflow_id: PREPARE_WORKFLOW } });
    // The operator addresses the binding the workflow records NOW and names
    // somebody else as stopped: the engine authenticates the owner and then
    // refuses the incomplete attestation.
    const unauthorized = runCli(
      recoverCoordinatorArgs(fixture, {
        operationId: "op-cli-recover-3",
        priorSession: newEnvelope,
        sessionId: "another-coordinator",
        stopped: ["somebody-else"],
      }),
      fixture.root,
    );
    expect(unauthorized.exitCode).toBe(1);
    expect(jsonOf(unauthorized).code).toBe("coordination.identity-recovery.unauthorized");
    expect(readJson(fixture.snapshotPath)).toEqual(committedBytes);
    expect(cliRecoveryAudit(fixture)).toHaveLength(1);
  }, 60000);

  test("prepare coordinator recovery distinguishes usage errors from runtime refusals", () => {
    const fixture = makePrepareFixture();
    const before = readJson(fixture.snapshotPath);

    // No stop assertion, no reason, and a relative prior-session path are usage
    // errors (exit 2) decided before any engine I/O.
    const noStop = runCli(
      [
        "workflow",
        "recover-coordinator",
        "--session",
        fixture.coordinator,
        "--session-id",
        CLI_RECOVERY_SESSION_ID,
        "--operation-id",
        "op-cli-usage-1",
        "--reason",
        "cancelled",
        "--authorization-ref",
        "PM-1",
      ],
      fixture.root,
    );
    expect(noStop.exitCode).toBe(2);
    expect(jsonOf(noStop)).toMatchObject({ status: "usage", code: "command.invalid-input" });

    const noReason = runCli(recoverCoordinatorArgs(fixture, { omitReason: true }), fixture.root);
    expect(noReason.exitCode).toBe(2);
    expect(jsonOf(noReason)).toMatchObject({ status: "usage", code: "command.invalid-input" });

    const relative = runCli(
      recoverCoordinatorArgs(fixture, { priorSession: ".mstar/workflows/x/sessions/coordinator-a.json" }),
      fixture.root,
    );
    expect(relative.exitCode).toBe(2);
    expect(jsonOf(relative).code).toBe("command.invalid-input");
    // The rejected address is stated as a rule, never repeated (§5).
    expect(relative.stdout).not.toContain(".mstar/workflows/x/sessions/coordinator-a.json");
    expect(relative.stderr).not.toContain(".mstar/workflows/x/sessions/coordinator-a.json");

    // A credential-like replacement id is refused by the ENGINE (not by a CLI
    // guard), and that refusal reaches the same public diagnostic: it must name
    // the rule and the received length, never the value.
    for (const rejected of [`ghp_${"a".repeat(140)}`, "../creds/secret.json"]) {
      const badId = runCli(recoverCoordinatorArgs(fixture, { sessionId: rejected }), fixture.root);
      expect({ rejected, exitCode: badId.exitCode }).toEqual({ rejected, exitCode: 1 });
      expect(jsonOf(badId).code).toBe("coordination.invalid-session-id");
      expect(badId.stdout).not.toContain(rejected);
      expect(badId.stderr).not.toContain(rejected);
    }

    // The engine classifies malformed stop attestations as runtime refusals;
    // their public projection must not repeat credential- or path-like values.
    for (const badStopped of ["a/b", "../creds/secret.json", `ghp_${"a".repeat(140)}`, "with space"]) {
      const malformed = runCli(recoverCoordinatorArgs(fixture, { stopped: [badStopped] }), fixture.root);
      const label = `${badStopped.slice(0, 12)}:`;
      expect(`${label} ${malformed.exitCode}`).toBe(`${label} 1`);
      expect(jsonOf(malformed)).toMatchObject({ status: "refused", code: "coordination.identity-recovery.invalid-request" });
      expect(malformed.stdout).not.toContain(badStopped);
      expect(malformed.stderr).not.toContain(badStopped);
    }

    // A nonexistent absolute envelope is a runtime refusal (exit 1), never a
    // usage error, and it still writes nothing.
    const missing = runCli(
      recoverCoordinatorArgs(fixture, { priorSession: join(fixture.root, "no-such-session.json") }),
      fixture.root,
    );
    expect(missing.exitCode).toBe(1);
    expect(jsonOf(missing).code).toBe("coordination.session-not-found");

    expect(readJson(fixture.snapshotPath)).toEqual(before);
    expect(existsSync(join(fixture.harness, "workflows", PREPARE_WORKFLOW, "sessions", `coordinator-${CLI_RECOVERY_SESSION_ID}.json`))).toBe(false);
  }, 60000);
});

/**
 * The ACTIVE transport (`--execution` / `--session-ref` / full-token `--expect`)
 * as this family sees it: the two transports are disjoint BEFORE any IO, a
 * malformed active invocation is usage (exit 2), and an active call against a
 * pre-activation harness reaches the ENGINE's DB verb — which refuses
 * `execution.not-active` (exit 1) — instead of falling back to the file route.
 * Every case asserts the file-route bytes are untouched, so "cannot write" is
 * observed, not claimed. The successful bind→resume→mutation chain lives in
 * `execution-session.test.ts`, which owns the active DB fixture.
 */
describe("mstar plan \u2014 execution transport", () => {
  /** A canonical, engine-produced reference the active flags can carry. */
  function activeRefWire(): string {
    return encodeExecutionSessionRef({
      storeId: "stores/execution-test",
      epoch: 1,
      workflowId: WORKFLOW_ID,
      role: "coordinator",
      sessionId: "execution-ref-session",
    });
  }

  function activeIdentityEnv(): Record<string, string> {
    return {
      MSTAR_EXECUTION_IDENTITY: serializeExecutionValue({
        source: "local",
        sessionId: "execution-ref-session",
        workflowId: WORKFLOW_ID,
        role: "coordinator",
      }),
    };
  }

  test("the active flags never mix with the pre-activation ones, and a pre-activation bind refuses without writing", () => {
    const fixture = makeFixture();
    const before = snapshotState(fixture);

    const mixedArgs = [
      "plan",
      "progress",
      "--plan",
      PLAN_ID,
      "--session",
      join(fixture.harness, "sessions", "plan-a.json"),
      "--session-ref",
      activeRefWire(),
      "--expect",
      "exec-v1:plan:store:1:key:1",
      "--operation",
      "progress-mixed",
      "--file",
      join(fixture.root, "progress.json"),
    ];
    const mixed = runCli(mixedArgs, fixture.root);
    expect(mixed.exitCode).toBe(2);
    expect(jsonOf(mixed).code).toBe("command.invalid-input");


    // A pre-activation control root has no ACTIVE claim to bind against, so the
    // bind states its capability refusal truthfully (the supported operator
    // route is the store upgrade) — a real refusal, not a missing-token ritual.
    const stated = runCli(
      ["plan", "bind", "--execution", "--workflow", WORKFLOW_ID, "--coordinator", "--session-id", "some-session"],
      fixture.root,
    );
    expect(stated.exitCode).toBe(1);
    expect(jsonOf(stated).code).toBe("execution.not-active");

    expect(snapshotState(fixture)).toEqual(before);
    expect(existsSync(fixture.projectRegisterPath)).toBe(false);
  });

  test("active transport classification: a numeric expectation is usage, an omitted operation id reaches the engine, and a missing identity is usage", () => {
    const fixture = makeFixture();
    const before = snapshotState(fixture);
    const progressPath = join(fixture.root, "progress.json");
    writeJson(progressPath, { status: "InReview", summary: "no write expected", evidence_paths: [fixture.evidencePath] });

    const numeric = runCli(
      ["plan", "progress", "--session-ref", activeRefWire(), "--plan", PLAN_ID, "--expect", "3", "--operation", "progress-numeric", "--file", progressPath],
      fixture.root,
      activeIdentityEnv(),
    );
    // A revision integer is the file route's CAS transport: the active route
    // classifies it as usage before any payload is read.
    expect(numeric.exitCode).toBe(2);
    expect(jsonOf(numeric).code).toBe("command.invalid-input");

    const noOperation = runCli(
      ["plan", "progress", "--session-ref", activeRefWire(), "--plan", PLAN_ID, "--expect", "exec-v1:plan:store:1:key:1", "--file", progressPath],
      fixture.root,
      activeIdentityEnv(),
    );
    // An omitted operation id is generated by the CLI, so this call reaches the
    // engine's own token check and refuses there as a genuine CAS fact.
    expect(noOperation.exitCode).toBe(1);
    expect(String(jsonOf(noOperation).code)).toMatch(/^(execution|coordination)\./);

    const noIdentity = runCli(
      [
        "plan",
        "show",
        "--session-ref",
        activeRefWire(),
        "--plan",
        PLAN_ID,
      ],
      fixture.root,
    );
    // Missing acquired identity is usage and never reads a file-route envelope.
    expect(noIdentity.exitCode).toBe(2);
    expect(jsonOf(noIdentity).code).toBe("command.invalid-input");

    expect(snapshotState(fixture)).toEqual(before);
  });

  test("the numeric transport refusal precedes payload IO (exit 2)", () => {
    const fixture = makeFixture();
    const before = snapshotState(fixture);
    // The same ordering pattern as the file route's --expect-issue case: both
    // payload states must yield the SAME numeric-transport refusal, proving
    // the ACTIVE-route admission runs before materialization and the payload
    // bytes are never consumed on a refused transport.
    const malformed = join(fixture.root, "malformed.json");
    writeText(malformed, "{not json");
    for (const [state, file] of [
      ["malformed", malformed],
      ["missing", join(fixture.root, "absent.json")],
    ] as const) {
      const numeric = runCli(
        [
          "plan",
          "progress",
          "--session-ref",
          activeRefWire(),
          "--plan",
          PLAN_ID,
          "--expect",
          "3",
          "--operation",
          "progress-numeric-no-io",
          "--file",
          file,
        ],
        fixture.root,
        activeIdentityEnv(),
      );
      expect(`${state} -> ${numeric.exitCode}`).toBe(`${state} -> 2`);
      expect(jsonOf(numeric).code).toBe("command.invalid-input");
      // The payload bytes are never consumed: the refusal names the transport,
      // not the payload file.
      expect(String(jsonOf(numeric).message)).not.toContain("payload");
    }
    expect(snapshotState(fixture)).toEqual(before);
  }, 30_000);

  test("an active call whose execution token names another store refuses at the engine without a file-route write", () => {
    const fixture = makeFixture();
    const before = snapshotState(fixture);
    const progressPath = join(fixture.root, "progress.json");
    writeJson(progressPath, { status: "InReview", summary: "no write expected", evidence_paths: [fixture.evidencePath] });

    // A well-formed token for a different store is a genuine CAS fact, so the
    // request reaches the engine's own authority/token boundary and refuses
    // there (exit 1) — the pre-activation file route is never used instead.
    const refused = runCli(
      [
        "plan",
        "progress",
        "--session-ref",
        activeRefWire(),
        "--plan",
        PLAN_ID,
        "--expect",
        "exec-v1:plan:stores%2Fexecution-test:1:key64:1",
        "--operation",
        "progress-not-active",
        "--file",
        progressPath,
      ],
      fixture.root,
      activeIdentityEnv(),
    );
    expect(refused.exitCode).toBe(1);
    expect(snapshotState(fixture)).toEqual(before);
  });
});
