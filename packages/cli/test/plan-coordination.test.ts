/**
 * CLI `mstar plan` — the scoped plan-coordination transport (spec §A2/§B).
 *
 * Every case runs the real CLI entry as a subprocess against a temporary Git
 * fixture (main worktree + harness + two plan rows), asserting the observable
 * contract: JSON on stdout, diagnostics on stderr, exit 0 ok/no-op,
 * 1 engine refusal, 2 usage. Authoritative state (snapshot / register bytes)
 * is read from disk after each call, never from the CLI's own claim.
 *
 * Groups: `entry-forms`, `strict-input`, `linked-control-root`,
 * `scoped-operations`, `integration-recovery`. The last one drives the whole
 * §D/§E chain against real Git worktrees (handoff → accept →
 * integration-start → operator merge → integration-accept → complete, plus the
 * crash `reconcile` legs); the merge itself is always the test's own Git call,
 * never the CLI's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { encodeExecutionSessionRef, serializeExecutionValue } from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

const WORKFLOW_ID = "wf-plana";
const PLAN_ID = "plan-a";
const PEER_PLAN_ID = "plan-b";
const PROJECT_ID = "proj-a";

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Spawn env with ambient harness env vars pinned out (fixtures must not leak). */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    // The identity channel is per-case input: an ambient value (the test itself
    // may run under a host that injects it) must never reach a fixture.
    if (key === "MSTAR_HOST_SESSION_ID") continue;
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
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Parse a `--json` success/failure envelope; throws with the raw stdout when absent. */
function jsonOf(result: RunResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON stdout, got ${JSON.stringify(result.stdout)} (stderr: ${result.stderr})`);
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
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

/** A plan row in the `validatePlanRow` shape, carrying its project id. */
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

/** Portable primary Assignment — the header block `parseAssignmentFile` accepts. */
function assignmentText(input: {
  harness: string;
  planId: string;
  planPath: string;
  worktreePath: string;
  sddDir: string;
  branch: string;
}): string {
  return [
    `# Assignment — ${input.planId}`,
    "",
    `**Control harness root**: ${input.harness}`,
    `**Workflow id**: ${WORKFLOW_ID}`,
    `**Plan id**: ${input.planId}`,
    `**Plan Path**: ${input.planPath}`,
    `**Worktree Path**: ${input.worktreePath}`,
    `**Working branch**: ${input.branch}`,
    `**SDD dir**: ${input.sddDir}`,
    "**Execute as**: project-manager",
    "**Execution scope**: plan",
    "**Delegation**: allowed (plan-local subagents only)",
    "**Prepare gate**: go",
    "**QA gate**: mandatory",
    "**Findings cleanup**: zero-residual",
    "",
    "Body.",
    "",
  ].join("\n");
}

interface Fixture {
  root: string;
  harness: string;
  worktreePath: string;
  peerWorktreePath: string;
  assignmentPath: string;
  peerAssignmentPath: string;
  snapshotPath: string;
  /** The retired register path — a command must never create it (G2b). */
  projectRegisterPath: string;
  evidencePath: string;
}

/**
 * Temporary Git fixture: main worktree + canonical harness + two prepared rows.
 *
 * The harness carries an initialized ACTIVE issue store (G2a made the store the
 * findings authority: the handoff gate reads it, and the scoped issue verbs
 * write it). `store: false` leaves the workspace store-less for the cases that
 * assert the pre-store disclosure (the catalog-pin absence path); a store-less
 * workspace is a legitimate pre-migration shape, not a broken one.
 */
function makeFixture(options: { store?: boolean } = {}): Fixture {
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
  const sddDir = join(harness, "sdd", PLAN_ID);
  const evidencePath = join(sddDir, "evidence.md");
  const worktreePath = join(root, "wt-plana");
  const peerWorktreePath = join(root, "wt-planb");

  writeText(planPath, "# plan a\n");
  writeText(peerPlanPath, "# plan b\n");
  writeText(evidencePath, "# evidence\n");
  for (const dir of [peerWorktreePath, worktreePath]) mkdirSync(dir, { recursive: true });

  // The store first: `store init` is create-only for a genuinely empty
  // workspace, so it must run before status.json registers a workflow.
  if (options.store !== false) {
    const init = runCli(["store", "init", "--harness", harness, "--json"], root);
    expect(init.exitCode).toBe(0);
  }

  writeJson(join(harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-15T00:00:00Z",
    workflows: [
      {
        id: WORKFLOW_ID,
        status: "running",
        type: "iteration",
        started_at: "2026-09-15T00:00:00Z",
        dir: `workflows/${WORKFLOW_ID}`,
      },
    ],
  });
  writeJson(snapshotPath, {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "iteration",
    status: "running",
    started_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    branch: { base: "main" },
    plans: [planRow(PLAN_ID), planRow(PEER_PLAN_ID, "feature/plan-b")],
  });

  const assignmentPath = join(sddDir, "assignment.md");
  const peerAssignmentPath = join(harness, "sdd", PEER_PLAN_ID, "assignment.md");
  writeText(
    assignmentPath,
    assignmentText({ harness, planId: PLAN_ID, planPath, worktreePath, sddDir, branch: "feature/plan-a" }),
  );
  mkdirSync(join(harness, "sdd", PEER_PLAN_ID), { recursive: true });
  writeText(
    peerAssignmentPath,
    assignmentText({
      harness,
      planId: PEER_PLAN_ID,
      planPath: peerPlanPath,
      worktreePath: peerWorktreePath,
      sddDir: join(harness, "sdd", PEER_PLAN_ID),
      branch: "feature/plan-b",
    }),
  );

  return {
    root,
    harness,
    worktreePath,
    peerWorktreePath,
    assignmentPath,
    peerAssignmentPath,
    snapshotPath,
    projectRegisterPath,
    evidencePath,
  };
}

/** The explicit local coordinator identity every CLI fixture acquires. */
const FIXTURE_COORDINATOR_ID = "fixture-coordinator";

/** Bind the workflow coordinator through the CLI and return its session file. */
function bindCoordinator(fixture: Fixture): string {
  const bound = runCli(
    [
      "plan",
      "bind",
      "--coordinator",
      "--workflow",
      WORKFLOW_ID,
      "--session-id",
      FIXTURE_COORDINATOR_ID,
      "--json",
    ],
    fixture.root,
  );
  expect(bound.exitCode).toBe(0);
  const payload = jsonOf(bound);
  expect(payload.ok).toBe(true);
  expect(payload.role).toBe("coordinator");
  return String(payload.session_file);
}

/** Prepare one row through the bound coordinator session. */
function preparePlan(fixture: Fixture, coordinatorSession: string, planId: string): void {
  const view = runCli(["plan", "show", "--session", coordinatorSession, "--plan", planId, "--json"], fixture.root);
  expect(view.exitCode).toBe(0);
  const revision = jsonOf(view).revision;
  const assignmentPath = planId === PLAN_ID ? fixture.assignmentPath : fixture.peerAssignmentPath;
  const prepared = runCli(
    [
      "plan",
      "prepare",
      "--session",
      coordinatorSession,
      "--plan",
      planId,
      "--assignment",
      assignmentPath,
      "--expect",
      String(revision),
      "--json",
    ],
    fixture.root,
  );
  expect(prepared.exitCode).toBe(0);
  expect(jsonOf(prepared).outcome).toBe("prepared");
}

/** Bind a plan session through the workflow+plan address form. */
function bindPlan(fixture: Fixture, planId: string): string {
  const bound = runCli(["plan", "bind", "--workflow", WORKFLOW_ID, "--plan", planId, "--json"], fixture.root);
  expect(bound.exitCode).toBe(0);
  const payload = jsonOf(bound);
  expect(payload.outcome).toBe("claimed");
  return String(payload.session_file);
}

/** Row revision of one plan as the CLI reports it. */
function rowRevision(fixture: Fixture, session: string, planId?: string): number {
  const args = ["plan", "show", "--session", session, "--json"];
  if (planId !== undefined) args.push("--plan", planId);
  const result = runCli(args, fixture.root);
  expect(result.exitCode).toBe(0);
  return Number(jsonOf(result).revision);
}

/** Bytes of the fixture's authoritative documents, for no-write assertions. */
function snapshotBytes(fixture: Fixture): string {
  return readText(fixture.snapshotPath);
}

/** One capture entry as `plan issue-add` takes it (the core input minus projectId). */
function issueEntryOf(occurrenceKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: `Finding ${occurrenceKey}`,
    kind: "bug",
    severity: "medium",
    impact: "the plan's acceptance is not met",
    acceptance: "the finding is fixed and verified",
    sourceIdentity: `cli-tests/${occurrenceKey}`,
    rootCauseKey: "cli-tests-root-cause",
    acceptanceKey: "cli-tests-acceptance",
    occurrenceKey,
    sourceKind: "qc",
    location: "packages/cli/src/index.ts",
    observedBehavior: "observed in the CLI cutover fixture",
    evidence: ["fixture evidence"],
    discoveredAt: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

/** Narrow an unknown value to a plain record (the test-side boundary for CLI JSON envelopes). */
function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // Checked immediately above: a non-null, non-array object.
  return value as Record<string, unknown>;
}

/** The plan's issues as the CLI's own `mstar issue list` reports them (DB truth, no CLI claim). */
function listedIssues(fixture: Fixture, extraArgs: string[] = []): Array<Record<string, unknown>> {
  const result = runCli(["issue", "list", "--harness", fixture.harness, "--json", ...extraArgs], fixture.root);
  expect(result.exitCode).toBe(0);
  const items = plainRecord(jsonOf(result).data)?.items;
  if (!Array.isArray(items)) throw new Error(`issue list returned no items: ${result.stdout}`);
  return items.filter((item): item is Record<string, unknown> => plainRecord(item) !== null);
}

/** The `issues[]` receipts of a `plan issue-add|issue-close --json` success envelope. */
function issueReceiptsOf(result: RunResult): Array<Record<string, unknown>> {
  const issues = jsonOf(result).issues;
  if (!Array.isArray(issues)) throw new Error(`expected issue receipts, got ${result.stdout}`);
  return issues.filter((item): item is Record<string, unknown> => plainRecord(item) !== null);
}

/** Run `plan issue-add` for one entry payload and return its parsed success envelope. */
function issueAdd(fixture: Fixture, session: string, payloadPath: string): RunResult {
  return runCli(
    ["plan", "issue-add", "--session", session, "--file", payloadPath, "--expect", String(rowRevision(fixture, session)), "--json"],
    fixture.root,
  );
}

describe("mstar plan — entry-forms", () => {
  test("both fresh addresses claim the same prepared row with distinct sessions", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);

    const first = runCli(["plan", "bind", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"], fixture.root);
    expect(first.exitCode).toBe(0);
    const firstPayload = jsonOf(first);
    expect(firstPayload.plan_id).toBe(PLAN_ID);
    expect(firstPayload.workflow_id).toBe(WORKFLOW_ID);
    expect(firstPayload.role).toBe("plan-pm");
    expect(typeof firstPayload.revision).toBe("number");

    // The Assignment address is the same row: a fresh claim there is refused
    // as a duplicate holder, naming the live session.
    const second = runCli(["plan", "bind", "--assignment", fixture.assignmentPath, "--json"], fixture.root);
    expect(second.exitCode).toBe(1);
    const refusal = jsonOf(second);
    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe("coordination.duplicate-holder");
    expect(refusal.holder).toBe(firstPayload.session_id);
  });

  test("explicit resume reports the live context without claiming a second time", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);
    const before = rowRevision(fixture, planSession);

    const resumed = runCli(["plan", "bind", "--resume", planSession, "--json"], fixture.root);
    expect(resumed.exitCode).toBe(0);
    const payload = jsonOf(resumed);
    expect(payload.outcome).toBe("resumed");
    expect(payload.session_file).toBe(planSession);

    // Resume is read-only: ownership and revision are unchanged.
    expect(rowRevision(fixture, planSession)).toBe(before);
  });

  test("a second fresh coordinator bind is refused like a duplicate holder", () => {
    const fixture = makeFixture();
    bindCoordinator(fixture);
    const again = runCli(
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--session-id", "second-coordinator", "--json"],
      fixture.root,
    );
    expect(again.exitCode).toBe(1);
    expect(jsonOf(again).code).toBe("coordination.duplicate-holder");
  });

  test("show on a plan session accepts no --plan and reports its own scope", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);

    const view = runCli(["plan", "show", "--session", planSession, "--json"], fixture.root);
    expect(view.exitCode).toBe(0);
    const payload = jsonOf(view);
    expect(payload.plan_id).toBe(PLAN_ID);
    expect(payload.role).toBe("plan-pm");
    expect(payload.snapshot_version).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Array.isArray(payload.allowed_operations)).toBe(true);
    const scope = payload.scope as Record<string, unknown>;
    expect(scope.worktreePath).toBe(fixture.worktreePath);
    expect(scope.workingBranch).toBe("feature/plan-a");

    // A plan session addresses only its own plan.
    const foreign = runCli(["plan", "show", "--session", planSession, "--plan", PEER_PLAN_ID, "--json"], fixture.root);
    expect(foreign.exitCode).toBe(1);
    expect(jsonOf(foreign).code).toBe("coordination.session-mismatch");
  });

  test("show on an unprepared row returns revision 0, no scope and prepare allowed", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    const view = runCli(["plan", "show", "--session", coordinator, "--plan", PLAN_ID, "--json"], fixture.root);
    expect(view.exitCode).toBe(0);
    const payload = jsonOf(view);
    expect(payload.revision).toBe(0);
    expect(payload.scope).toBeNull();
    expect(payload.allowed_operations).toContain("prepare");
  });
});

describe("mstar plan — session identity", () => {
  test("--session-id becomes the bound identity on both fresh address forms", () => {
    const fixture = makeFixture();
    const supplied = "host-session-coordinator";
    const coordinated = runCli(
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--session-id", supplied, "--json"],
      fixture.root,
    );
    expect(coordinated.exitCode).toBe(0);
    const coordinatorPayload = jsonOf(coordinated);
    expect(coordinatorPayload.session_id).toBe(supplied);
    expect(String(coordinatorPayload.session_file)).toBe(join(fixture.harness, "workflows", WORKFLOW_ID, "sessions", `coordinator-${supplied}.json`));
    const coordinator = String(coordinatorPayload.session_file);
    expect(readJson(coordinator).session_id).toBe(supplied);
    // The identity reached the engine's own binding, not just the file name.
    const coordination = readJson(fixture.snapshotPath).coordination as { coordinator?: { session_id?: string } };
    expect(coordination.coordinator?.session_id).toBe(supplied);

    preparePlan(fixture, coordinator, PLAN_ID);
    const claimed = runCli(
      ["plan", "bind", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--session-id", "host-session-plan-a", "--json"],
      fixture.root,
    );
    expect(claimed.exitCode).toBe(0);
    const planPayload = jsonOf(claimed);
    expect(planPayload.session_id).toBe("host-session-plan-a");
    expect(readJson(String(planPayload.session_file)).session_id).toBe("host-session-plan-a");
  });

  test("--session-id reaches the pinned-Assignment address form too", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);

    const supplied = "host-session-assignment";
    const bound = runCli(
      ["plan", "bind", "--assignment", fixture.assignmentPath, "--session-id", supplied, "--json"],
      fixture.root,
    );
    expect(bound.exitCode).toBe(0);
    const payload = jsonOf(bound);
    expect(payload.outcome).toBe("claimed");
    expect(payload.session_id).toBe(supplied);
    expect(readJson(String(payload.session_file)).session_id).toBe(supplied);
  });

  test("prerequisite identity — MSTAR_HOST_SESSION_ID no longer authorizes a coordinator bootstrap, and an omitted id writes nothing", () => {
    for (const injected of ["host-session-env", "", "   "]) {
      const fixture = makeFixture();
      const sessionsDir = join(fixture.harness, "workflows", WORKFLOW_ID, "sessions");
      const before = readFileSync(fixture.snapshotPath, "utf8");
      const bound = runCli(
        ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--json"],
        fixture.root,
        { MSTAR_HOST_SESSION_ID: injected },
      );
      expect({ injected, exitCode: bound.exitCode }).toEqual({ injected, exitCode: 1 });
      expect({ injected, code: jsonOf(bound).code }).toEqual({ injected, code: "coordination.identity-missing" });
      // Refused before any write: no envelope, no sessions dir, snapshot bytes intact.
      expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before);
      expect(existsSync(sessionsDir)).toBe(false);
    }
  });

  test("prerequisite identity — the explicit --session-id is the coordinator identity, and an env value cannot substitute for or displace it", () => {
    const fixture = makeFixture();
    const flagged = runCli(
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--session-id", "host-session-flag", "--json"],
      fixture.root,
      { MSTAR_HOST_SESSION_ID: "host-session-spoof" },
    );
    expect(flagged.exitCode).toBe(0);
    const payload = jsonOf(flagged);
    expect(payload.session_id).toBe("host-session-flag");
    // The env value never reaches the engine binding.
    const coordination = readJson(fixture.snapshotPath).coordination as { coordinator?: { session_id?: string } };
    expect(coordination.coordinator?.session_id).toBe("host-session-flag");
  });

  test("prerequisite identity — a rejected address and a rejected session id are never echoed into the bind diagnostic", () => {
    const fixture = makeFixture();
    const before = readFileSync(fixture.snapshotPath, "utf8");
    // A path-like address the caller typed (credential-adjacent by shape, and
    // relative so the CLI's own absolute-path rule refuses it) plus a
    // credential-like session id: the usage refusal (exit 2) and the engine's
    // own session-id refusal (exit 1) each report the rule and a
    // non-identifying fact, never the rejected value (§5 diagnostics).
    const pathLike = "../creds/coordinator-secret.json";
    const credentialLike = `ghp_${"a".repeat(140)}`;
    for (const args of [
      ["plan", "bind", "--resume", pathLike, "--json"],
      ["plan", "bind", "--assignment", pathLike, "--json"],
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--harness", pathLike, "--json"],
    ]) {
      const refused = runCli(args, fixture.root);
      expect({ args, exitCode: refused.exitCode }).toEqual({ args, exitCode: 2 });
      expect(jsonOf(refused).code).toBe("usage");
      expect(refused.stdout).not.toContain(pathLike);
      expect(refused.stderr).not.toContain(pathLike);
    }
    for (const rejected of [credentialLike, pathLike]) {
      const refused = runCli(
        ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--session-id", rejected, "--json"],
        fixture.root,
      );
      expect({ rejected, exitCode: refused.exitCode }).toEqual({ rejected, exitCode: 1 });
      expect(jsonOf(refused).code).toBe("coordination.invalid-session-id");
      expect(refused.stdout).not.toContain(rejected);
      expect(refused.stderr).not.toContain(rejected);
    }
    // Every refusal above is pre-write.
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before);
    expect(existsSync(join(fixture.harness, "workflows", WORKFLOW_ID, "sessions"))).toBe(false);
  });

  test("--resume accepts no identity input (exit 2) and stays resumable", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);

    for (const args of [
      ["plan", "bind", "--resume", coordinator, "--session-id", "host-session-nope"],
      ["plan", "bind", "--resume", coordinator, "--session-id", "host-session-nope", "--json"],
    ]) {
      const refused = runCli(args, fixture.root);
      expect({ args, exitCode: refused.exitCode }).toEqual({ args, exitCode: 2 });
    }
    const json = runCli(["plan", "bind", "--resume", coordinator, "--session-id", "x", "--json"], fixture.root);
    expect(jsonOf(json).code).toBe("usage");
    // The refusal is the resume guard's own, not commander's unknown-option path.
    expect(String(jsonOf(json).message)).toContain("--resume accepts no --session-id");

    // Fail-closed means no side effect: the same envelope still resumes.
    const resumed = runCli(["plan", "bind", "--resume", coordinator, "--json"], fixture.root);
    expect(resumed.exitCode).toBe(0);
    expect(jsonOf(resumed).outcome).toBe("resumed");
    expect(jsonOf(resumed).session_id).toBe(readJson(coordinator).session_id);
  });

  test("--coordinator still refuses a flag that belongs to another address form", () => {
    const fixture = makeFixture();
    const refused = runCli(
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"],
      fixture.root,
    );
    expect(refused.exitCode).toBe(2);
    expect(jsonOf(refused).code).toBe("usage");
    // The refusal happened before the engine saw anything: nothing is bound.
    expect(readJson(fixture.snapshotPath).coordination).toBeUndefined();
  });
});

describe("mstar plan — strict-input", () => {
  test("unknown flags, mixed address forms and missing values are usage errors (exit 2)", () => {
    const fixture = makeFixture();
    const cases: string[][] = [
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID],
      ["plan", "bind", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--assignment", fixture.assignmentPath],
      ["plan", "bind", "--assignment", fixture.assignmentPath, "--harness", fixture.harness],
      ["plan", "bind"],
      ["plan", "show", "--session", "relative.json"],
      ["plan", "progress", "--session", "/tmp/nope.json", "--expect", "0"],
      ["plan", "complete", "--session", "/tmp/nope.json", "--plan", PLAN_ID, "--handoff", "h1"],
      ["plan", "accept", "--session", "/tmp/nope.json", "--plan", PLAN_ID, "--expect", "1"],
      ["plan", "return", "--session", "/tmp/nope.json", "--plan", PLAN_ID, "--handoff", "h1", "--expect", "1"],
    ];
    for (const args of cases) {
      const result = runCli(args, fixture.root);
      expect({ args, exitCode: result.exitCode }).toEqual({ args, exitCode: 2 });
      // Without --json the usage failure stays human: stdout is machine-only.
      expect(result.stdout).toBe("");
    }
  });

  test("a commander-level usage failure still carries the A2 failure object under --json", () => {
    const fixture = makeFixture();
    const unknownFlag = runCli(
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--json", "--nope"],
      fixture.root,
    );
    expect(unknownFlag.exitCode).toBe(2);
    const payload = jsonOf(unknownFlag);
    expect(payload.ok).toBe(false);
    expect(payload.operation).toBe("bind");
    expect(payload.code).toBe("usage");
    expect(String(payload.message)).toContain("unknown option '--nope'");

    // A group-level failure (no verb yet) reports the family itself.
    const groupLevel = runCli(["plan", "--json", "--nope"], fixture.root);
    expect(groupLevel.exitCode).toBe(2);
    expect(jsonOf(groupLevel).operation).toBe("plan");
  });

  test("--resume refuses a --harness override instead of silently dropping it", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);
    const before = rowRevision(fixture, planSession);

    // `--resume <session-file>` addresses the envelope directly and the envelope
    // already records its harness root, so the mix cannot be honored: it fails
    // closed like the `--assignment` form instead of exiting 0 with the flag
    // quietly ignored.
    const mixed = runCli(
      ["plan", "bind", "--resume", planSession, "--harness", fixture.harness, "--json"],
      fixture.root,
    );
    expect(mixed.exitCode).toBe(2);
    const payload = jsonOf(mixed);
    expect(payload.ok).toBe(false);
    expect(payload.operation).toBe("bind");
    expect(payload.code).toBe("usage");
    expect(String(payload.message)).toContain("--harness");

    // Without --json the usage failure stays human: stdout is machine-only.
    const human = runCli(["plan", "bind", "--resume", planSession, "--harness", fixture.harness], fixture.root);
    expect(human.exitCode).toBe(2);
    expect(human.stdout).toBe("");

    // Fail-closed means no side effect: the same session still resumes untouched.
    const resumed = runCli(["plan", "bind", "--resume", planSession, "--json"], fixture.root);
    expect(resumed.exitCode).toBe(0);
    expect(jsonOf(resumed).outcome).toBe("resumed");
    expect(rowRevision(fixture, planSession)).toBe(before);
  });

  test("a non-numeric or negative --expect is a usage error, not an engine refusal", () => {
    const fixture = makeFixture();
    for (const value of ["abc", "-1", "1.5", ""]) {
      const result = runCli(
        ["plan", "progress", "--session", "/tmp/nope.json", "--file", "/tmp/nope.json", "--expect", value],
        fixture.root,
      );
      expect({ value, exitCode: result.exitCode }).toEqual({ value, exitCode: 2 });
    }
  });

  test("payload files must be absolute, present and parseable (exit 2)", () => {
    const fixture = makeFixture();
    const relative = runCli(
      ["plan", "progress", "--session", "/tmp/nope.json", "--file", "payload.json", "--expect", "0"],
      fixture.root,
    );
    expect(relative.exitCode).toBe(2);
    expect(relative.stderr).toContain("must be an absolute path");

    const missing = runCli(
      ["plan", "progress", "--session", "/tmp/nope.json", "--file", join(fixture.root, "absent.json"), "--expect", "0"],
      fixture.root,
    );
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("payload file not found");

    const malformed = join(fixture.root, "malformed.json");
    writeText(malformed, "{not json");
    const unparseable = runCli(
      ["plan", "progress", "--session", "/tmp/nope.json", "--file", malformed, "--expect", "0"],
      fixture.root,
    );
    expect(unparseable.exitCode).toBe(2);
    expect(unparseable.stderr).toContain("not valid JSON");
  });

  test("issue authority: --expect-issue accepts only a nonnegative revision, before any payload is read (exit 2)", () => {
    const fixture = makeFixture();
    // A real, parseable payload file. The flag is validated before any payload
    // is read, so a malformed token never degrades into a payload-read failure
    // and the payload bytes are never consumed.
    const evidencePath = join(fixture.root, "evidence.json");
    const payload = `${JSON.stringify({ reason: "fixed", references: ["packages/cli/src/index.ts"] }, null, 2)}\n`;
    writeText(evidencePath, payload);
    // Two payload states: the existing file above, and a missing one. The
    // missing leg is the one that pins the ordering — with the payload read
    // first it reports "payload file not found" (still exit 2) and this case
    // fails, so the refusal must come from the flag in both states.
    for (const [state, file] of [
      ["existing", evidencePath],
      ["missing", join(fixture.root, "absent.json")],
    ] as const) {
      for (const value of ["latest", "-1", "1.5"]) {
        const result = runCli(
          [
            "plan",
            "issue-close",
            "--session",
            "/tmp/nope.json",
            "--issue",
            "I-000001",
            "--disposition",
            "resolved",
            "--file",
            file,
            "--expect",
            "0",
            "--expect-issue",
            value,
          ],
          fixture.root,
        );
        expect(`${state} ${value} -> ${result.exitCode}`).toBe(`${state} ${value} -> 2`);
        expect(result.stderr).toContain("--expect-issue must be a nonnegative integer revision");
        expect(result.stderr).not.toContain("payload file not found");
      }
    }
    expect(readText(evidencePath)).toBe(payload);
    // Positive control: with a valid revision the same invocation gets past the
    // flag AND the payload read (the file above is genuinely parseable) and
    // fails later on the missing session — so the refusals above came from the
    // flag, never from the payload file.
    const accepted = runCli(
      [
        "plan",
        "issue-close",
        "--session",
        "/tmp/nope.json",
        "--issue",
        "I-000001",
        "--disposition",
        "resolved",
        "--file",
        evidencePath,
        "--expect",
        "0",
        "--expect-issue",
        "1",
      ],
      fixture.root,
    );
    expect(accepted.exitCode).toBe(1);
    expect(accepted.stderr).toContain("session envelope not found");
  });

  test("issue authority: --disposition names only the four terminal dispositions (exit 2)", () => {
    const fixture = makeFixture();
    const evidencePath = join(fixture.root, "evidence.json");
    writeText(evidencePath, `${JSON.stringify({ reason: "fixed", references: ["a"] })}\n`);
    const result = runCli(
      [
        "plan",
        "issue-close",
        "--session",
        "/tmp/nope.json",
        "--issue",
        "I-000001",
        "--disposition",
        "open",
        "--file",
        evidencePath,
        "--expect",
        "0",
        "--expect-issue",
        "1",
      ],
      fixture.root,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--disposition must be resolved | waived | duplicate | superseded");
  });

  test("--json failures are parseable on stdout and exit 1 differs from usage exit 2", () => {
    const fixture = makeFixture();
    const runtime = runCli(["plan", "show", "--session", join(fixture.root, "absent.json"), "--json"], fixture.root);
    expect(runtime.exitCode).toBe(1);
    const payload = jsonOf(runtime);
    expect(payload.ok).toBe(false);
    expect(payload.operation).toBe("show");
    expect(payload.code).toBe("coordination.session-not-found");
    expect(typeof payload.message).toBe("string");

    const usage = runCli(["plan", "show", "--session", "relative.json", "--json"], fixture.root);
    expect(usage.exitCode).toBe(2);
    expect(jsonOf(usage).code).toBe("usage");
  });

  test("human mode keeps stdout machine-only and writes diagnostics to stderr", () => {
    const fixture = makeFixture();
    const bound = runCli(
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--session-id", FIXTURE_COORDINATOR_ID],
      fixture.root,
    );
    expect(bound.exitCode).toBe(0);
    expect(bound.stdout).toBe("");
    expect(bound.stderr).toContain("session file");
  });
});

describe("mstar plan — linked-control-root", () => {
  test("a linked feature checkout still resolves the main worktree's harness", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);

    // A real linked worktree of the same repository: its own harness copy (if
    // one exists) must never win process-root discovery.
    const linked = join(fixture.root, "linked-feature");
    git(["worktree", "add", "-q", "-b", "feature/plan-a", linked], fixture.root);
    writeJson(join(linked, ".mstar", "status.json"), { version: 2, updated_at: "2026-01-01", workflows: [] });

    const bound = runCli(["plan", "bind", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"], linked);
    expect(bound.exitCode).toBe(0);
    const payload = jsonOf(bound);
    expect(payload.workflow_id).toBe(WORKFLOW_ID);
    // The session envelope landed in the MAIN checkout's workflow dir.
    expect(String(payload.session_file)).toContain(join(fixture.harness, "workflows", WORKFLOW_ID, "sessions"));

    // Coordinator residency is main-or-recorded-integration only.
    const refused = runCli(
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--session-id", FIXTURE_COORDINATOR_ID, "--json"],
      linked,
    );
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused).ok).toBe(false);
  });

  test("the workflow+plan form pins its --harness override, not the cwd-resolved root", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);

    // A process cwd outside any harness: the override is the only address the
    // engine can resolve, so the store pin has to follow the flag. Pinning the
    // cwd-derived root instead pins no store at all and refuses a valid bind.
    const outside = mkdtempSync(join(tmpdir(), "outside-harness-"));
    roots.push(outside);
    const bound = runCli(
      ["plan", "bind", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--harness", fixture.harness, "--json"],
      outside,
    );
    expect(bound.exitCode).toBe(0);
    const payload = jsonOf(bound);
    expect(payload.outcome).toBe("claimed");
    expect(String(payload.session_file)).toContain(join(fixture.harness, "workflows", WORKFLOW_ID, "sessions"));
  });

  test("a coordinator transition pins the session root before it reads the row", () => {
    const fixture = makeIntegrationFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);
    toInReview(fixture, planSession, "slice ready for review");
    const handoffId = submitHandoff(fixture, planSession);

    // A linked checkout carrying its own harness copy: cwd discovery alone
    // yields a foreign store, so the session-root pin must land before the
    // pre-check read that authorizes the transition.
    const linked = join(fixture.root, "linked-transition");
    git(["worktree", "add", "-q", "-b", "linked-transition", linked], fixture.root);
    writeJson(join(linked, ".mstar", "status.json"), { version: 2, updated_at: "2026-01-01", workflows: [] });

    const accepted = runCli(
      [
        "plan",
        "accept",
        "--session",
        coordinator,
        "--plan",
        PLAN_ID,
        "--handoff",
        handoffId,
        "--expect",
        String(rowRevision(fixture, coordinator, PLAN_ID)),
        "--json",
      ],
      linked,
    );
    expect(accepted.exitCode).toBe(0);
    expect(jsonOf(accepted).state).toBe("accepted");
    // The write landed in the control root named by the session envelope.
    expect(recordedHandoffState(fixture)).toBe("accepted");

    // The pre-check now reads THROUGH that pinned store: a stale id is refused
    // by the pre-check's own verdict, not by an unpinned store mismatch.
    const stale = runCli(
      [
        "plan",
        "accept",
        "--session",
        coordinator,
        "--plan",
        PLAN_ID,
        "--handoff",
        "handoff-stale",
        "--expect",
        String(rowRevision(fixture, coordinator, PLAN_ID)),
        "--json",
      ],
      linked,
    );
    expect(stale.exitCode).toBe(1);
    expect(jsonOf(stale).code).toBe("coordination.handoff-mismatch");
  });
});

describe("mstar plan — scoped-operations", () => {
  test("progress mutates only the calling row and reports its new revision", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);
    const before = rowRevision(fixture, planSession);

    const payloadPath = join(fixture.root, "progress.json");
    writeJson(payloadPath, { status: "InReview", summary: "handoff prepared", evidence_paths: [fixture.evidencePath] });
    const progressed = runCli(
      ["plan", "progress", "--session", planSession, "--file", payloadPath, "--expect", String(before), "--json"],
      fixture.root,
    );
    expect(progressed.exitCode).toBe(0);
    const payload = jsonOf(progressed);
    expect(payload.outcome).toBe("progressed");
    expect(payload.revision).toBe(before + 1);

    const snapshot = readJson(fixture.snapshotPath);
    const rows = snapshot.plans as Array<Record<string, unknown>>;
    expect(rows[0]!.status).toBe("InReview");
    // The sibling row is untouched — independent rows never invalidate each other.
    expect(rows[1]!.status).toBe("Todo");
    expect((rows[1] as Record<string, unknown>).coordination).toBeUndefined();
  });

  test("a stale row revision is refused and the authoritative bytes do not change", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);
    const revision = rowRevision(fixture, planSession);
    const before = snapshotBytes(fixture);

    const payloadPath = join(fixture.root, "progress.json");
    writeJson(payloadPath, { status: "InReview", summary: "stale", evidence_paths: [fixture.evidencePath] });
    const stale = runCli(
      ["plan", "progress", "--session", planSession, "--file", payloadPath, "--expect", String(revision - 1), "--json"],
      fixture.root,
    );
    expect(stale.exitCode).toBe(1);
    const payload = jsonOf(stale);
    expect(payload.code).toBe("coordination.version-conflict");
    expect(payload.expected).toBe(revision - 1);
    expect(payload.actual).toBe(revision);
    expect(snapshotBytes(fixture)).toBe(before);
  });

  test("a global field in the payload is refused, not silently dropped", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);
    const revision = rowRevision(fixture, planSession);
    const before = snapshotBytes(fixture);

    const payloadPath = join(fixture.root, "progress.json");
    writeJson(payloadPath, {
      status: "InReview",
      summary: "with a lifecycle anchor",
      evidence_paths: [fixture.evidencePath],
      phase: "Done",
    });
    const injected = runCli(
      ["plan", "progress", "--session", planSession, "--file", payloadPath, "--expect", String(revision), "--json"],
      fixture.root,
    );
    expect(injected.exitCode).toBe(1);
    const payload = jsonOf(injected);
    expect(payload.ok).toBe(false);
    // The extra key is reported as a validation failure, never dropped.
    expect(payload.code).toBe("coordination.invalid-input");
    expect(String(payload.message)).toContain("phase");
    expect(snapshotBytes(fixture)).toBe(before);
  });

  test("issue authority: plan issue-add captures into the store, links the plan, and never writes a register", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);
    const before = snapshotBytes(fixture);

    // No store-less register version is readable any more: the view carries
    // the snapshot version only, and the issues themselves are the CAS inputs.
    const view = jsonOf(runCli(["plan", "show", "--session", planSession, "--json"], fixture.root));
    expect(view.register_version).toBeUndefined();
    expect(view.allowed_operations).toEqual(["progress", "issue-add", "issue-close", "handoff"]);

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf("occ-1", { severity: "critical" })]);
    const added = issueAdd(fixture, planSession, entriesPath);
    expect(added.exitCode).toBe(0);
    const addPayload = jsonOf(added);
    expect(addPayload.outcome).toBe("issue-added");
    expect(addPayload.issues).toHaveLength(1);

    // The DB is the only target: the CLI's own `issue list` reads it back, and
    // no project register appeared anywhere under the harness.
    const listed = listedIssues(fixture);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.title).toBe("Finding occ-1");
    expect(listed[0]!.severity).toBe("critical");
    expect(existsSync(fixture.projectRegisterPath)).toBe(false);
    expect(existsSync(join(fixture.harness, "projects"))).toBe(false);
    // An issue-only mutation never touches the execution input.
    expect(snapshotBytes(fixture)).toBe(before);
  });

  test("issue authority: an exact issue-add replay converges instead of duplicating the finding", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf("occ-1")]);
    const first = issueAdd(fixture, planSession, entriesPath);
    expect(first.exitCode).toBe(0);
    const firstReceipt = issueReceiptsOf(first)[0]!;

    // Same session, same occurrence key: the core operation replays its own
    // receipt (the original outcome, `created: true`), so the second call
    // converges on the SAME issue instead of opening a second one.
    const replay = issueAdd(fixture, planSession, entriesPath);
    expect(replay.exitCode).toBe(0);
    expect(issueReceiptsOf(replay)[0]!.issue_id).toBe(firstReceipt.issue_id);
    expect(listedIssues(fixture)).toHaveLength(1);

    // A different observation of the same root cause is a second finding, not
    // a silent merge: identity is source identity + root cause, never a title.
    writeJson(entriesPath, [issueEntryOf("occ-2")]);
    const second = issueAdd(fixture, planSession, entriesPath);
    expect(second.exitCode).toBe(0);
    expect(issueReceiptsOf(second)[0]!.issue_id).not.toBe(firstReceipt.issue_id);
    expect(listedIssues(fixture)).toHaveLength(2);
  });

  test("issue authority: plan issue-close closes the named issue under the issue revision CAS", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf("occ-1")]);
    const added = issueAdd(fixture, planSession, entriesPath);
    expect(added.exitCode).toBe(0);
    const receipt = issueReceiptsOf(added)[0]!;
    const issueId = String(receipt.issue_id);
    const issueRevision = Number(receipt.revision);

    // The engine's findings gate sees the open issue; closing it releases the
    // gate — the exact authority path the handoff uses.
    const blocked = runCli(["status", "findings-cleanup", PLAN_ID, "--harness", fixture.harness, "--mode", "zero-residual"], fixture.root);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain(issueId);

    const evidencePath = join(fixture.root, "evidence.json");
    writeJson(evidencePath, {
      reason: "fixed by the reviewer round",
      references: ["packages/cli/src/index.ts"],
      alignmentRef: "QA gate acceptance 2026-09-19",
    });

    // A stale issue revision is refused and nothing is written.
    const stale = runCli(
      [
        "plan",
        "issue-close",
        "--session",
        planSession,
        "--issue",
        issueId,
        "--disposition",
        "resolved",
        "--file",
        evidencePath,
        "--expect-issue",
        String(issueRevision + 5),
        "--expect",
        String(rowRevision(fixture, planSession)),
        "--json",
      ],
      fixture.root,
    );
    expect(stale.exitCode).toBe(1);
    expect(jsonOf(stale).code).toBe("issue.revision-conflict");
    expect(listedIssues(fixture)[0]!.disposition).toBe("open");

    const closed = runCli(
      [
        "plan",
        "issue-close",
        "--session",
        planSession,
        "--issue",
        issueId,
        "--disposition",
        "resolved",
        "--file",
        evidencePath,
        "--expect-issue",
        String(issueRevision),
        "--expect",
        String(rowRevision(fixture, planSession)),
        "--json",
      ],
      fixture.root,
    );
    expect(closed.exitCode).toBe(0);
    expect(jsonOf(closed).outcome).toBe("issue-closed");
    // `issue list` defaults to the open disposition, so the closed issue is read
    // back through its own filter — the disposition moved, the row did not vanish.
    expect(listedIssues(fixture)).toHaveLength(0);
    const resolved = listedIssues(fixture, ["--disposition", "resolved"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.id).toBe(issueId);

    const released = runCli(["status", "findings-cleanup", PLAN_ID, "--harness", fixture.harness, "--mode", "zero-residual"], fixture.root);
    expect(released.exitCode).toBe(0);
    expect(released.stdout).toContain("findings-cleanup plan-a: OK");
    expect(existsSync(fixture.projectRegisterPath)).toBe(false);
  });

  test("issue authority: a plan session cannot close an issue linked to another plan", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    preparePlan(fixture, coordinator, PEER_PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);
    const peerSession = bindPlan(fixture, PEER_PLAN_ID);

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf("occ-1")]);
    const added = issueAdd(fixture, peerSession, entriesPath);
    expect(added.exitCode).toBe(0);
    const issueId = String(issueReceiptsOf(added)[0]!.issue_id);

    const evidencePath = join(fixture.root, "evidence.json");
    writeJson(evidencePath, {
      reason: "not this plan's finding",
      references: ["packages/cli/src/index.ts"],
      alignmentRef: "QA gate acceptance 2026-09-19",
    });
    const foreign = runCli(
      [
        "plan",
        "issue-close",
        "--session",
        planSession,
        "--issue",
        issueId,
        "--disposition",
        "resolved",
        "--file",
        evidencePath,
        "--expect-issue",
        "1",
        "--expect",
        String(rowRevision(fixture, planSession)),
        "--json",
      ],
      fixture.root,
    );
    expect(foreign.exitCode).toBe(1);
    expect(jsonOf(foreign).code).toBe("issue.scope-refused");
    expect(listedIssues(fixture)[0]!.disposition).toBe("open");
  });

  test("issue authority: the retired residual verbs refuse with the migration path and write nothing", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);
    const before = snapshotBytes(fixture);

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [issueEntryOf("occ-1")]);

    for (const [verb, replacement] of [
      ["residual-add", "issue-add"],
      ["residual-close", "issue-close"],
    ] as const) {
      const refused = runCli(
        ["plan", verb, "--session", planSession, "--file", entriesPath, "--expect", "0", "--json"],
        fixture.root,
      );
      expect(`${verb} -> ${refused.exitCode}`).toBe(`${verb} -> 1`);
      const payload = jsonOf(refused);
      expect(payload.ok).toBe(false);
      expect(payload.code).toBe("plan.verb-retired");
      expect(String(payload.message)).toContain(`\`mstar plan ${replacement}\``);
    }

    // A retired verb is not a write-through alias: no issue and no register.
    expect(listedIssues(fixture)).toHaveLength(0);
    expect(existsSync(fixture.projectRegisterPath)).toBe(false);
    expect(snapshotBytes(fixture)).toBe(before);
  });

  test("a coordinator session cannot execute plan operations and no bytes change", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const before = snapshotBytes(fixture);

    const payloadPath = join(fixture.root, "progress.json");
    writeJson(payloadPath, { status: "InReview", summary: "coordinator attempt", evidence_paths: [fixture.evidencePath] });
    const refused = runCli(
      ["plan", "progress", "--session", coordinator, "--file", payloadPath, "--expect", "1", "--json"],
      fixture.root,
    );
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused).code).toBe("coordination.session-role");
    expect(snapshotBytes(fixture)).toBe(before);
  });
});

const INTEGRATION_BRANCH = "integration/plan-a";

/** Every recovery case drives 10+ CLI subprocesses; 5s is a load-dependent coin flip. */
const RECOVERY_TIMEOUT = 120_000;

/** `git` with stdout captured — these fixtures need pins, not side effects. */
function gitOut(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Commit with the fixture's identity pinned (no ambient Git config reads). */
function gitCommit(cwd: string, message: string): void {
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message], cwd);
}

interface IntegrationFixture extends Fixture {
  /** The recorded base the coordinator merges onto (main's first commit). */
  baseSha: string;
  /** The plan worktree HEAD handed off as `source_sha`. */
  sourceSha: string;
  integrationPath: string;
  qcReport: string;
  qcConsolidated: string;
  qaReport: string;
}

/**
 * Real-Git fixture for the recovery group. The handoff/integration/complete
 * verbs read an actual plan checkout, an actual integration checkout and the
 * pinned objects they name, so the shared fixture's placeholder directories are
 * replaced by worktrees and the snapshot is given the anchors
 * `integrationAnchors` requires (`branch.integration` +
 * `integration_worktree_path`). The upgrade runs before the first bind, so no
 * writer's version precondition is invalidated by it.
 */
function makeIntegrationFixture(): IntegrationFixture {
  const fixture = makeFixture();
  const baseSha = gitOut(["rev-parse", "HEAD"], fixture.root);

  rmSync(fixture.worktreePath, { recursive: true, force: true });
  git(["worktree", "add", "-q", "-b", "feature/plan-a", fixture.worktreePath], fixture.root);
  writeText(join(fixture.worktreePath, "slice.txt"), "plan a slice\n");
  git(["add", "slice.txt"], fixture.worktreePath);
  gitCommit(fixture.worktreePath, "plan a: slice");
  const sourceSha = gitOut(["rev-parse", "HEAD"], fixture.worktreePath);

  const integrationPath = join(fixture.root, "wt-integration");
  git(["worktree", "add", "-q", "-b", INTEGRATION_BRANCH, integrationPath, "main"], fixture.root);
  // The integration checkout starts on the recorded base: integration-start
  // pins whatever HEAD it finds, and this pin must be the merge's first parent.
  expect(gitOut(["rev-parse", "HEAD"], integrationPath)).toBe(baseSha);

  const snapshot = readJson(fixture.snapshotPath);
  snapshot.branch = { base: "main", integration: INTEGRATION_BRANCH };
  snapshot.integration_worktree_path = integrationPath;
  writeJson(fixture.snapshotPath, snapshot);

  const sdd = join(fixture.harness, "sdd", PLAN_ID);
  const qcReport = join(sdd, "qc1.md");
  const qcConsolidated = join(sdd, "qc.md");
  const qaReport = join(sdd, "qa.md");
  writeText(qcReport, "# QC 1\ndecision: Approve\n");
  writeText(qcConsolidated, "# QC consolidated\ndecision: Approve\n");
  writeText(qaReport, "# QA\nverdict: pass\n");

  return { ...fixture, baseSha, sourceSha, integrationPath, qcReport, qcConsolidated, qaReport };
}

/** One row of the authoritative snapshot (never the CLI's own claim). */
function rowOf(fixture: Fixture, planId: string = PLAN_ID): Record<string, unknown> {
  const plans = readJson(fixture.snapshotPath).plans as Array<Record<string, unknown>>;
  const row = plans.find((entry) => entry.id === planId);
  if (row === undefined) throw new Error(`row ${planId} missing from ${fixture.snapshotPath}`);
  return row;
}

/** The row's recorded handoff state, read from disk. */
function recordedHandoffState(fixture: Fixture, planId: string = PLAN_ID): unknown {
  const coordination = rowOf(fixture, planId).coordination as Record<string, unknown> | undefined;
  const handoff = coordination?.handoff as Record<string, unknown> | undefined;
  return handoff?.state;
}

/** Drive the row to InReview through its own plan session (Todo → InProgress → InReview). */
function toInReview(fixture: Fixture, planSession: string, summary: string): void {
  for (const status of ["InProgress", "InReview"]) {
    const payload = join(fixture.root, `progress-${status}.json`);
    writeJson(payload, { status, summary, evidence_paths: [fixture.evidencePath] });
    const moved = runCli(
      [
        "plan",
        "progress",
        "--session",
        planSession,
        "--file",
        payload,
        "--expect",
        String(rowRevision(fixture, planSession)),
        "--json",
      ],
      fixture.root,
    );
    expect(moved.exitCode).toBe(0);
    expect(jsonOf(moved).ok).toBe(true);
    expect(recordedHandoffState(fixture)).toBeUndefined();
  }
}

/** Submit the pinned handoff and return the engine's own handoff id. */
function submitHandoff(fixture: IntegrationFixture, planSession: string): string {
  const payload = join(fixture.root, "handoff.json");
  writeJson(payload, {
    // Spec §D: the plan session supplies revisions and evidence paths only —
    // `worktree_path` is derived by the engine from the row/scope (T1-D-012),
    // and the engine refuses it as an unexpected key.
    source_sha: fixture.sourceSha,
    review_base: fixture.baseSha,
    review_head: fixture.sourceSha,
    qc: { decision: "Approve", reports: [fixture.qcReport], consolidated: fixture.qcConsolidated },
    qa: { gate: "mandatory", decision: "pass", report: fixture.qaReport },
  });
  const handed = runCli(
    [
      "plan",
      "handoff",
      "--session",
      planSession,
      "--file",
      payload,
      "--expect",
      String(rowRevision(fixture, planSession)),
      "--json",
    ],
    fixture.root,
  );
  expect(handed.exitCode).toBe(0);
  const result = jsonOf(handed);
  expect(result.outcome).toBe("handed-off");
  expect(typeof result.handoff_id).toBe("string");
  return String(result.handoff_id);
}

/** The row's live handoff id as the coordinator's `show` reports it. */
function liveHandoffId(fixture: Fixture, coordinator: string): string {
  const view = runCli(["plan", "show", "--session", coordinator, "--plan", PLAN_ID, "--json"], fixture.root);
  expect(view.exitCode).toBe(0);
  const view2 = jsonOf(view);
  expect(typeof view2.handoff_id).toBe("string");
  return String(view2.handoff_id);
}

/** One coordinator transition through the shared flag surface. */
function transition(fixture: Fixture, verb: string, coordinator: string, handoffId: string): RunResult {
  return runCli(
    [
      "plan",
      verb,
      "--session",
      coordinator,
      "--plan",
      PLAN_ID,
      "--handoff",
      handoffId,
      "--expect",
      String(rowRevision(fixture, coordinator, PLAN_ID)),
      "--json",
    ],
    fixture.root,
  );
}

/** The operator's merge — the CLI never runs one. */
function mergePlanA(fixture: IntegrationFixture): void {
  git(["-c", "user.email=t@t", "-c", "user.name=t", "merge", "--no-ff", "-m", "merge plan a", "feature/plan-a"], fixture.integrationPath);
}

/** The chain up to a handed-off, accepted, started attempt (`merge` optional). */
function attemptOf(
  fixture: IntegrationFixture,
  options: { merge: boolean },
): { coordinator: string; handoffId: string } {
  const coordinator = bindCoordinator(fixture);
  preparePlan(fixture, coordinator, PLAN_ID);
  const planSession = bindPlan(fixture, PLAN_ID);
  toInReview(fixture, planSession, "slice ready for review");
  const handoffId = submitHandoff(fixture, planSession);

  // The handoff id `plan handoff` minted is the row's live id, and the one the
  // coordinator transitions act on.
  expect(liveHandoffId(fixture, coordinator)).toBe(handoffId);

  const accepted = transition(fixture, "accept", coordinator, handoffId);
  expect(accepted.exitCode).toBe(0);
  expect(jsonOf(accepted).state).toBe("accepted");
  // Accept is the transfer of execution ownership, never a merge.
  expect(gitOut(["rev-parse", "HEAD"], fixture.integrationPath)).toBe(fixture.baseSha);

  const started = transition(fixture, "integration-start", coordinator, handoffId);
  expect(started.exitCode).toBe(0);
  expect(jsonOf(started).state).toBe("integrating");
  if (options.merge) mergePlanA(fixture);
  return { coordinator, handoffId };
}

/** The workflow's merge lease is gone once the attempt is over. */
function expectMergeLeaseReleased(fixture: Fixture): void {
  expect(readJson(fixture.snapshotPath).integration_merge_lease).toBeUndefined();
}

/** Completion releases both leases: nothing owns the row or the merge any more. */
function expectReleased(fixture: Fixture): void {
  expectMergeLeaseReleased(fixture);
  expect(rowOf(fixture).execution_lease).toBeUndefined();
}

describe("mstar plan — integration-recovery", () => {
  test("handoff → accept → integration-start → merge → integration-accept → complete ends Done", () => {
    const fixture = makeIntegrationFixture();
    const { coordinator, handoffId } = attemptOf(fixture, { merge: true });

    const mergeSha = gitOut(["rev-parse", "HEAD"], fixture.integrationPath);
    // The proven attempt is the two-parent merge of the pinned base then source.
    expect(gitOut(["rev-list", "--parents", "-n", "1", "HEAD"], fixture.integrationPath).split(" ")).toEqual([
      mergeSha,
      fixture.baseSha,
      fixture.sourceSha,
    ]);

    const merged = transition(fixture, "integration-accept", coordinator, handoffId);
    expect(merged.exitCode).toBe(0);
    expect(jsonOf(merged).state).toBe("merged");
    // Integration is verified, not completed: the leases and InReview stay.
    expect(rowOf(fixture).status).toBe("InReview");
    expect(rowOf(fixture).execution_lease).toBeDefined();

    const completed = transition(fixture, "complete", coordinator, handoffId);
    expect(completed.exitCode).toBe(0);
    const done = jsonOf(completed);
    expect(done.outcome).toBe("completed");
    expect(rowOf(fixture).status).toBe("Done");
    expect(recordedHandoffState(fixture)).toBe("completed");
    expectReleased(fixture);
  }, RECOVERY_TIMEOUT);

  test("reconcile completes an attempt whose merge already landed, without a second merge", () => {
    const fixture = makeIntegrationFixture();
    const { coordinator, handoffId } = attemptOf(fixture, { merge: true });

    const head = gitOut(["rev-parse", "HEAD"], fixture.integrationPath);
    const reconciled = transition(fixture, "reconcile", coordinator, handoffId);
    expect(reconciled.exitCode).toBe(0);
    expect(jsonOf(reconciled).outcome).toBe("completed");
    expect(rowOf(fixture).status).toBe("Done");
    expectReleased(fixture);

    // Recovery observed Git; it never merged again and never re-pinned.
    expect(gitOut(["rev-parse", "HEAD"], fixture.integrationPath)).toBe(head);
    expect(gitOut(["rev-list", "--count", "--first-parent", `${fixture.baseSha}..HEAD`], fixture.integrationPath)).toBe("1");

    // Replaying the crash recovery of a finished attempt is a read-only no-op.
    const replay = transition(fixture, "reconcile", coordinator, handoffId);
    expect(replay.exitCode).toBe(0);
    expect(jsonOf(replay).outcome).toBe("already-completed");
    expect(gitOut(["rev-parse", "HEAD"], fixture.integrationPath)).toBe(head);
  }, RECOVERY_TIMEOUT);

  test("reconcile releases an unmerged attempt as retry-ready and the retry re-pins", () => {
    const fixture = makeIntegrationFixture();
    const { coordinator, handoffId } = attemptOf(fixture, { merge: false });

    const reconciled = transition(fixture, "reconcile", coordinator, handoffId);
    expect(reconciled.exitCode).toBe(0);
    expect(jsonOf(reconciled).outcome).toBe("retry-ready");
    // Only the abandoned attempt is released: the row keeps InReview and its
    // execution lease, and the handoff goes back to accepted.
    expect(rowOf(fixture).status).toBe("InReview");
    expect(rowOf(fixture).execution_lease).toBeDefined();
    expect(recordedHandoffState(fixture)).toBe("accepted");
    expectMergeLeaseReleased(fixture);

    const retried = transition(fixture, "integration-start", coordinator, handoffId);
    expect(retried.exitCode).toBe(0);
    expect(jsonOf(retried).state).toBe("integrating");
    expect(gitOut(["rev-parse", "HEAD"], fixture.integrationPath)).toBe(fixture.baseSha);

    mergePlanA(fixture);
    const merged = transition(fixture, "integration-accept", coordinator, handoffId);
    expect(merged.exitCode).toBe(0);
    expect(jsonOf(merged).state).toBe("merged");
  }, RECOVERY_TIMEOUT);

  test("integration-accept refuses an attempt with no merge of the pinned source", () => {
    const fixture = makeIntegrationFixture();
    const { coordinator, handoffId } = attemptOf(fixture, { merge: false });
    const before = snapshotBytes(fixture);

    const refused = transition(fixture, "integration-accept", coordinator, handoffId);
    expect(refused.exitCode).toBe(1);
    const refusal = jsonOf(refused);
    expect(refusal.ok).toBe(false);
    expect(refusal.code).toBe("coordination.integration-unresolved");
    expect(recordedHandoffState(fixture)).toBe("integrating");
    expect(snapshotBytes(fixture)).toBe(before);
  }, RECOVERY_TIMEOUT);
});

/* ------------------------------------------------------------------ *
 * Prepare workflow amendment — the `mstar workflow show-prepare` /
 * `amend-prepare` transport of the guarded Prepare-stage amendment contract
 * (§ New API and CLI). Real subprocesses against a temporary Git repository, so
 * the JSON, the exit codes and the protected bytes on disk are what these cases
 * assert.
 * ------------------------------------------------------------------ */

const PREPARE_WORKFLOW = "wf-prepare";
const PREPARE_PEER = "wf-peer";
const PREPARE_ROW = "plan-prepare";
const PREPARE_APPEND = "plan-append";
const PREPARE_SPEC = "amendment-contract.md";
const PREPARE_INTEGRATION_BRANCH = "integration/wf-prepare";

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

/** SHA-256 of a file's exact bytes, computed independently of the CLI. */
function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
    ["plan", "bind", "--coordinator", "--workflow", PREPARE_WORKFLOW, "--session-id", FIXTURE_COORDINATOR_ID, "--json"],
    root,
  );
  expect(bound.exitCode).toBe(0);
  const coordinator = String(jsonOf(bound).session_file);

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
function showPrepareArgs(fixture: PrepareFixture, json = true): string[] {
  return [
    "workflow",
    "show-prepare",
    "--session",
    fixture.coordinator,
    ...(json ? ["--json"] : []),
  ];
}

/** The `amend-prepare` argv one case drives (tokens and payload supplied). */
function amendPrepareArgs(
  fixture: PrepareFixture,
  tokens: { snapshot: string; compass: string; patch?: string },
  json = true,
): string[] {
  return [
    "workflow",
    "amend-prepare",
    "--session",
    fixture.coordinator,
    "--expect-snapshot",
    tokens.snapshot,
    "--expect-compass",
    tokens.compass,
    "--input",
    tokens.patch ?? fixture.patchPath,
    ...(json ? ["--json"] : []),
  ];
}


interface StandaloneRepairFixture extends Fixture {
  baseSha: string;
  sourceSha: string;
  coordinator: string;
  planSession: string;
  qcReport: string;
  qcConsolidated: string;
  qaReport: string;
}

function makeStandaloneRepairFixture(withPr = false): StandaloneRepairFixture {
  const fixture = makeFixture();
  const baseSha = gitOut(["rev-parse", "HEAD"], fixture.root);
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  git(["worktree", "add", "-q", "-b", "feature/plan-a", fixture.worktreePath], fixture.root);
  writeText(join(fixture.worktreePath, "standalone.txt"), "standalone slice\n");
  git(["add", "standalone.txt"], fixture.worktreePath);
  gitCommit(fixture.worktreePath, "plan a: standalone");
  const sourceSha = gitOut(["rev-parse", "HEAD"], fixture.worktreePath);

  const snapshot: Record<string, unknown> = {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    delivery_kind: "development",
    status: "running",
    started_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    branch: { source: "main", target: "main" },
    plans: [planRow(PLAN_ID, "feature/plan-a")],
  };
  if (withPr) {
    snapshot.delivery = {
      compound: { outcome: "skipped", reason: "fixture probe" },
      pr: { repo: "btspoony/mstar-harness", head: "feature/plan-a", target: "main" },
      merge: { provider: "github", evidence: "PR #999 verified merged" },
    };
  }
  writeJson(join(fixture.harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-15T00:00:00Z",
    workflows: [{ id: WORKFLOW_ID, status: "running", type: "plan", started_at: "2026-09-15T00:00:00Z", dir: `workflows/${WORKFLOW_ID}` }],
  });
  writeJson(fixture.snapshotPath, snapshot);

  const sdd = join(fixture.harness, "sdd", PLAN_ID);
  const qcReport = join(sdd, "review", "qc1.md");
  const qcConsolidated = join(sdd, "review", "qc.md");
  const qaReport = join(sdd, "qa.md");
  writeText(qcReport, "# QC 1\ndecision: Approve\n");
  writeText(qcConsolidated, "# QC consolidated\ndecision: Approve\n");
  writeText(qaReport, "# QA\nverdict: pass\n");

  const coordinator = bindCoordinator(fixture);
  preparePlan(fixture, coordinator, PLAN_ID);
  const planSession = bindPlan(fixture, PLAN_ID);
  toInReview(fixture, planSession, "standalone ready");
  const handoffId = submitHandoff(
    { ...fixture, baseSha, sourceSha, integrationPath: "", qcReport, qcConsolidated, qaReport } as IntegrationFixture,
    planSession,
  );
  const accepted = transition(fixture, "accept", coordinator, handoffId);
  expect(accepted.exitCode).toBe(0);
  expect(jsonOf(accepted).state).toBe("accepted");

  return { ...fixture, baseSha, sourceSha, coordinator, planSession, qcReport, qcConsolidated, qaReport };
}

function snapshotWithoutRepairDeltaCli(snapshot: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  delete copy.updated_at;
  const branch = copy.branch as Record<string, unknown> | undefined;
  if (branch !== undefined) delete branch.source;
  const plans = copy.plans as Array<Record<string, unknown>>;
  const coordination = plans[0]?.coordination as Record<string, unknown> | undefined;
  if (coordination !== undefined) delete coordination.revision;
  return copy;
}



interface StandaloneCompletionFixture extends Fixture {
  baseSha: string;
  sourceSha: string;
  coordinator: string;
  planSession: string;
  qcReport: string;
  qcConsolidated: string;
  qaReport: string;
}

function makeStandaloneCompletionFixture(): StandaloneCompletionFixture {
  const fixture = makeFixture();
  const baseSha = gitOut(["rev-parse", "HEAD"], fixture.root);
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  git(["worktree", "add", "-q", "-b", "feature/plan-a", fixture.worktreePath], fixture.root);
  writeText(join(fixture.worktreePath, "standalone-complete.txt"), "standalone completion slice\n");
  git(["add", "standalone-complete.txt"], fixture.worktreePath);
  gitCommit(fixture.worktreePath, "plan a: standalone complete");
  const sourceSha = gitOut(["rev-parse", "HEAD"], fixture.worktreePath);

  writeJson(join(fixture.harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-15T00:00:00Z",
    workflows: [{ id: WORKFLOW_ID, status: "running", type: "plan", started_at: "2026-09-15T00:00:00Z", dir: `workflows/${WORKFLOW_ID}` }],
  });
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

  const coordinator = bindCoordinator(fixture);
  preparePlan(fixture, coordinator, PLAN_ID);
  const planSession = bindPlan(fixture, PLAN_ID);
  toInReview(fixture, planSession, "standalone ready for completion");
  const handoffId = submitHandoff(
    { ...fixture, baseSha, sourceSha, integrationPath: "", qcReport, qcConsolidated, qaReport } as IntegrationFixture,
    planSession,
  );
  const accepted = transition(fixture, "accept", coordinator, handoffId);
  expect(accepted.exitCode).toBe(0);
  expect(jsonOf(accepted).state).toBe("accepted");

  return { ...fixture, baseSha, sourceSha, coordinator, planSession, qcReport, qcConsolidated, qaReport };
}

describe("standalone-development-completion", () => {
  test("CLI accept → complete ends Done without integration and keeps workflow running", () => {
    const fixture = makeStandaloneCompletionFixture();
    const handoffId = liveHandoffId(fixture, fixture.coordinator);
    const beforeBytes = snapshotBytes(fixture);

    const refusedStart = transition(fixture, "integration-start", fixture.coordinator, handoffId);
    expect(refusedStart.exitCode).toBe(1);
    expect(snapshotBytes(fixture)).toBe(beforeBytes);

    const completed = transition(fixture, "complete", fixture.coordinator, handoffId);
    expect(completed.exitCode).toBe(0);
    const done = jsonOf(completed);
    expect(done.outcome).toBe("completed");
    expect(rowOf(fixture).status).toBe("Done");
    expect(recordedHandoffState(fixture)).toBe("completed");
    expect(rowOf(fixture).execution_lease).toBeUndefined();
    expect(readJson(fixture.snapshotPath).integration_merge_lease).toBeUndefined();
    expect(readJson(fixture.snapshotPath).status).toBe("running");
    const coordination = rowOf(fixture).coordination as Record<string, unknown>;
    const handoff = coordination.handoff as Record<string, unknown>;
    expect(handoff.integration).toBeUndefined();
  }, RECOVERY_TIMEOUT);

  test("CLI reconcile replays an already-completed standalone row as already-completed", () => {
    const fixture = makeStandaloneCompletionFixture();
    const handoffId = liveHandoffId(fixture, fixture.coordinator);
    expect(transition(fixture, "complete", fixture.coordinator, handoffId).exitCode).toBe(0);
    const afterComplete = snapshotBytes(fixture);

    const replay = transition(fixture, "reconcile", fixture.coordinator, handoffId);
    expect(replay.exitCode).toBe(0);
    expect(jsonOf(replay).outcome).toBe("already-completed");
    expect(snapshotBytes(fixture)).toBe(afterComplete);
  }, RECOVERY_TIMEOUT);
});

/* ------------------------------------------------------------------ *
 * Report-only completion — the CLI transport of the standalone
 * `verification/report-only` route (contract §1/§3, seams S1/S3). Real
 * subprocesses against a temporary Git repository: the whole chain is the
 * registration producer's own snapshot (`workflow register`), then bind →
 * prepare → progress → handoff → accept → policy completion evidence →
 * complete → close → the phase-6 projection. No merge and no integration
 * branch exist anywhere on this route; the accepted handoff plus the
 * fulfilment of the registered completion policy are the only evidence the
 * completion and the close consult. Each refusal case reads the
 * authoritative bytes back from disk.
 * ------------------------------------------------------------------ */

/** The completion policy the report-only fixture registers, and its fulfilment. */
const REPORT_ONLY_POLICY = "acceptance report at sdd/plan-a/report.md";
const REPORT_ONLY_EVIDENCE = "sdd/plan-a/report.md";

interface ReportOnlyFixture extends Fixture {
  /** The recorded base the fixture branched its feature checkout from. */
  baseSha: string;
  /** The pinned source commit of the feature checkout. */
  sourceSha: string;
  coordinator: string;
  planSession: string;
  qcReport: string;
  qcConsolidated: string;
  qaReport: string;
  /** The row's live handoff id, minted by `plan handoff`. */
  handoffId: string;
}

/**
 * The accepted report-only attempt, driven through the real CLI: the
 * registration producer writes the lifecycle, the coordinator prepares and
 * accepts, and nothing else. No delivery evidence is recorded yet, so each
 * case decides what the completion step is allowed to read.
 */
function makeAcceptedReportOnlyFixture(): ReportOnlyFixture {
  const fixture = makeFixture();
  const baseSha = gitOut(["rev-parse", "HEAD"], fixture.root);

  // Registration is create-only and produces BOTH documents itself, so the
  // shared fixture's placeholder snapshot and root entry are removed first —
  // the root entry the chain later unregisters is the producer's own.
  rmSync(fixture.snapshotPath, { force: true });
  rmSync(join(fixture.harness, "status.json"), { force: true });

  // A real feature checkout: `handoff` and `accept` read the pinned source
  // commit and the branch it was made on. A report-only workflow owns no
  // delivery branch, so this commit is the inspected source, never a merge
  // candidate and never an integration target.
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  git(["worktree", "add", "-q", "-b", "feature/plan-a", fixture.worktreePath], fixture.root);
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
  expect(registered.stdout).toContain(`workflow register: OK \u2014 ${WORKFLOW_ID} registered`);
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
  preparePlan(fixture, coordinator, PLAN_ID);
  const planSession = bindPlan(fixture, PLAN_ID);
  toInReview(fixture, planSession, "report-only ready for completion");
  const handoffId = submitHandoff(
    { ...fixture, baseSha, sourceSha, integrationPath: "", qcReport, qcConsolidated, qaReport } as IntegrationFixture,
    planSession,
  );
  const accepted = transition(fixture, "accept", coordinator, handoffId);
  expect(accepted.exitCode).toBe(0);
  expect(jsonOf(accepted).state).toBe("accepted");

  return { ...fixture, baseSha, sourceSha, coordinator, planSession, qcReport, qcConsolidated, qaReport, handoffId };
}

/** The stored `delivery` block (the recorded-evidence witness). */
function deliveryOf(fixture: Fixture): Record<string, unknown> {
  const delivery = readJson(fixture.snapshotPath).delivery;
  return typeof delivery === "object" && delivery !== null && !Array.isArray(delivery)
    ? (delivery as Record<string, unknown>)
    : {};
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
  test("register → accept → completion evidence → complete → close → phase 6 with no merge or integration", () => {
    const fixture = makeAcceptedReportOnlyFixture();
    const acceptedBytes = snapshotBytes(fixture);

    // There is no integration route to take on this kind: the verb refuses
    // before it writes anything, because the snapshot names no integration
    // target for it.
    const refusedStart = transition(fixture, "integration-start", fixture.coordinator, fixture.handoffId);
    expect(refusedStart.exitCode).toBe(1);
    expect(jsonOf(refusedStart).code).toBe("coordination.integration-unresolved");
    expect(snapshotBytes(fixture)).toBe(acceptedBytes);

    // Record the fulfilment of the registered policy, then complete from the
    // accepted handoff — evidence first, Done second, no merge in between.
    const recorded = recordCompletionEvidence(fixture, REPORT_ONLY_POLICY);
    expect(recorded.exitCode).toBe(0);
    expect(recorded.stdout).toContain("delivery evidence recorded");
    expect(deliveryOf(fixture)).toEqual({ completion: { policy: REPORT_ONLY_POLICY, evidence: REPORT_ONLY_EVIDENCE } });
    expect(rowOf(fixture).status).toBe("InReview");

    const completed = transition(fixture, "complete", fixture.coordinator, fixture.handoffId);
    expect(completed.exitCode).toBe(0);
    expect(jsonOf(completed).outcome).toBe("completed");
    expect(rowOf(fixture).status).toBe("Done");
    expect(recordedHandoffState(fixture)).toBe("completed");
    expect(rowOf(fixture).execution_lease).toBeUndefined();

    // The row is Done while the delivery tail is still ahead: the workflow
    // stays running, and no fabricated merge or integration anchor appears.
    const afterComplete = readJson(fixture.snapshotPath);
    expect(afterComplete.status).toBe("running");
    expect(afterComplete.integration_merge_lease).toBeUndefined();
    expect(afterComplete.integration_worktree_path).toBeUndefined();
    const branch = afterComplete.branch as Record<string, unknown> | undefined;
    expect(branch?.integration).toBeUndefined();
    const handoff = (rowOf(fixture).coordination as Record<string, unknown>).handoff as Record<string, unknown>;
    expect(handoff.integration).toBeUndefined();

    // Recovery replays the completed row without rewriting the terminal bytes.
    const completeBytes = snapshotBytes(fixture);
    const replay = transition(fixture, "reconcile", fixture.coordinator, fixture.handoffId);
    expect(replay.exitCode).toBe(0);
    expect(jsonOf(replay).outcome).toBe("already-completed");
    expect(snapshotBytes(fixture)).toBe(completeBytes);

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
    expect(gate.stdout).toContain("phase 6 (post-merge close): OK");

    // And the fixture never created the integration branch a merge would have
    // needed — "no merge" is observed here, not claimed.
    expect(gitOut(["branch", "--format=%(refname:short)"], fixture.root).split("\n")).not.toContain(INTEGRATION_BRANCH);
  }, RECOVERY_TIMEOUT);

  test("missing policy evidence refuses complete and close, and only the record unblocks it", () => {
    const fixture = makeAcceptedReportOnlyFixture();
    const before = snapshotBytes(fixture);

    const refused = transition(fixture, "complete", fixture.coordinator, fixture.handoffId);
    expect(refused.exitCode).toBe(1);
    const failure = jsonOf(refused);
    expect(failure.ok).toBe(false);
    expect(failure.code).toBe("coordination.invalid-transition");
    expect(String(failure.message)).toContain("requires matching report-only completion evidence");
    expect(String(failure.message)).toContain("delivery.completion");
    expect(rowOf(fixture).status).toBe("InReview");
    expect(recordedHandoffState(fixture)).toBe("accepted");
    expect(snapshotBytes(fixture)).toBe(before);

    // No fabricated Done state: the close refuses the unfinished row too.
    const closed = closeReportOnly(fixture);
    expect(closed.exitCode).toBe(1);
    expect(closed.stderr).toContain("every plan row must be Done");
    expect(readJson(fixture.snapshotPath).status).toBe("running");
    expect(snapshotBytes(fixture)).toBe(before);

    // The very same accepted handoff completes once its evidence is recorded.
    expect(recordCompletionEvidence(fixture, REPORT_ONLY_POLICY).exitCode).toBe(0);
    const completed = transition(fixture, "complete", fixture.coordinator, fixture.handoffId);
    expect(completed.exitCode).toBe(0);
    expect(rowOf(fixture).status).toBe("Done");
    expect(closeReportOnly(fixture).exitCode).toBe(0);
    expect(readJson(fixture.snapshotPath).status).toBe("completed");
  }, RECOVERY_TIMEOUT);

  test("mismatched completion policy refuses complete and preserves the recorded evidence", () => {
    const fixture = makeAcceptedReportOnlyFixture();
    expect(recordCompletionEvidence(fixture, "a different completion policy").exitCode).toBe(0);
    const before = snapshotBytes(fixture);

    const refused = transition(fixture, "complete", fixture.coordinator, fixture.handoffId);
    expect(refused.exitCode).toBe(1);
    const failure = jsonOf(refused);
    expect(failure.code).toBe("coordination.invalid-transition");
    expect(String(failure.message)).toContain("delivery.completion.policy");
    expect(rowOf(fixture).status).toBe("InReview");
    expect(snapshotBytes(fixture)).toBe(before);
    // The mismatched fulfilment is still the stored evidence: nothing repaired
    // it silently, and the registered policy was never overwritten.
    expect(deliveryOf(fixture)).toEqual({
      completion: { policy: "a different completion policy", evidence: REPORT_ONLY_EVIDENCE },
    });
    expect(readJson(fixture.snapshotPath).completion_policy).toBe(REPORT_ONLY_POLICY);

    // A matching fulfilment replaces it, and the same handoff then completes
    // and closes through the same evidence consultation.
    expect(recordCompletionEvidence(fixture, REPORT_ONLY_POLICY, "sdd/plan-a/report-v2.md").exitCode).toBe(0);
    const completed = transition(fixture, "complete", fixture.coordinator, fixture.handoffId);
    expect(completed.exitCode).toBe(0);
    expect(rowOf(fixture).status).toBe("Done");
    expect(closeReportOnly(fixture).exitCode).toBe(0);
    expect(readJson(fixture.snapshotPath).status).toBe("completed");
  }, RECOVERY_TIMEOUT);
});

describe("legacy-delivery-source-repair", () => {
  test("CLI repair succeeds with exact flags and preserves delivery bytes", () => {
    const fixture = makeStandaloneRepairFixture(true);
    const before = readJson(fixture.snapshotPath);
    const handoffId = liveHandoffId(fixture, fixture.coordinator);
    const repaired = transition(fixture, "repair-delivery-source", fixture.coordinator, handoffId);
    expect(repaired.exitCode).toBe(0);
    const payload = jsonOf(repaired);
    expect(payload.ok).toBe(true);
    expect(payload.operation).toBe("repair-delivery-source");
    expect(payload.outcome).toBe("delivery-source-repaired");
    const after = readJson(fixture.snapshotPath);
    expect(after.branch).toEqual({ source: "feature/plan-a", target: "main" });
    expect(after.delivery).toEqual(before.delivery);
    expect(snapshotWithoutRepairDeltaCli(after)).toEqual(snapshotWithoutRepairDeltaCli(before));
  });

  test("CLI refuses unknown replacement flags as usage errors", () => {
    const fixture = makeStandaloneRepairFixture(false);
    const handoffId = liveHandoffId(fixture, fixture.coordinator);
    const before = snapshotBytes(fixture);
    for (const extra of [["--branch-source", "feature/plan-a"], ["--force"], ["--status", "Done"]]) {
      const refused = runCli(
        [
          "plan",
          "repair-delivery-source",
          "--session",
          fixture.coordinator,
          "--plan",
          PLAN_ID,
          "--handoff",
          handoffId,
          "--expect",
          String(rowRevision(fixture, fixture.coordinator, PLAN_ID)),
          "--json",
          ...extra,
        ],
        fixture.root,
      );
      expect(refused.exitCode).toBe(2);
      expect(jsonOf(refused).code).toBe("usage");
      expect(snapshotBytes(fixture)).toBe(before);
    }
  });

  test("CLI second repair with fresh revision refuses already-aligned", () => {
    const fixture = makeStandaloneRepairFixture(false);
    const handoffId = liveHandoffId(fixture, fixture.coordinator);
    expect(transition(fixture, "repair-delivery-source", fixture.coordinator, handoffId).exitCode).toBe(0);
    const aligned = snapshotBytes(fixture);
    const second = transition(fixture, "repair-delivery-source", fixture.coordinator, handoffId);
    expect(second.exitCode).toBe(1);
    expect(jsonOf(second).code).toBe("coordination.delivery-source-repair.already-aligned");
    expect(snapshotBytes(fixture)).toBe(aligned);
  });
});

describe("Prepare workflow amendment", () => {
  test("show-prepare reports the byte versions and amend-prepare applies the approved delta with a readback", () => {
    const fixture = makePrepareFixture();
    const peerBefore = readText(fixture.peerSnapshotPath);
    const statusBefore = readText(fixture.statusPath);

    const show = runCli(showPrepareArgs(fixture), fixture.root);
    expect(show.exitCode).toBe(0);
    const view = jsonOf(show);
    expect(view.ok).toBe(true);
    expect(view.operation).toBe("show-prepare");
    expect(view.role).toBe("coordinator");
    expect(view.workflow_id).toBe(PREPARE_WORKFLOW);
    expect(view.allowed).toBe(true);
    expect(view.blockers).toEqual([]);
    expect(view.plan_ids).toEqual([PREPARE_ROW]);
    expect(view.snapshot_version).toBe(`sha256:${sha256OfFile(fixture.snapshotPath)}`);
    expect(view.compass_version).toBe(`sha256:${sha256OfFile(fixture.compassPath)}`);

    const amend = runCli(
      amendPrepareArgs(fixture, { snapshot: String(view.snapshot_version), compass: String(view.compass_version) }),
      fixture.root,
    );
    expect(amend.exitCode).toBe(0);
    const amended = jsonOf(amend);
    expect(amended.ok).toBe(true);
    expect(amended.operation).toBe("amend-prepare");
    expect(amended.outcome).toBe("amended");
    expect(amended.allowed).toBe(true);
    expect(amended.plan_ids).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(amended.compass_version).toBe(view.compass_version);
    expect(amended.snapshot_version).not.toBe(view.snapshot_version);
    expect(amended.snapshot_version).toBe(`sha256:${sha256OfFile(fixture.snapshotPath)}`);

    // The readback: the authoritative snapshot and a second show agree, and the
    // unrelated workflow / root register were never written.
    const snapshot = readJson(fixture.snapshotPath);
    expect((snapshot.plans as Array<Record<string, unknown>>).map((row) => row.id)).toEqual([
      PREPARE_ROW,
      PREPARE_APPEND,
    ]);
    expect(snapshot.integration_worktree_path).toBe(fixture.integrationPath);
    expect(snapshot.execution_policy).toEqual({ plan_parallelism: "parallel", worktree_mode: "required" });
    const readback = jsonOf(runCli(showPrepareArgs(fixture), fixture.root));
    expect(readback.snapshot_version).toBe(amended.snapshot_version);
    expect(readback.plan_ids).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(readText(fixture.peerSnapshotPath)).toBe(peerBefore);
    expect(readText(fixture.statusPath)).toBe(statusBefore);
  }, 30000);

  test("every required flag, malformed token and unknown flag is a usage error (exit 2)", () => {
    const fixture = makePrepareFixture();
    const snapshotVersion = `sha256:${sha256OfFile(fixture.snapshotPath)}`;
    const compassVersion = `sha256:${sha256OfFile(fixture.compassPath)}`;
    const before = readText(fixture.snapshotPath);
    const usageCases: Array<{ name: string; args: string[]; operation: string }> = [
      { name: "missing-session", args: ["workflow", "show-prepare", "--json"], operation: "show-prepare" },
      {
        name: "missing-expect-snapshot",
        args: [
          "workflow", "amend-prepare", "--session", fixture.coordinator,
          "--expect-compass", compassVersion, "--input", fixture.patchPath, "--json",
        ],
        operation: "amend-prepare",
      },
      {
        name: "missing-expect-compass",
        args: [
          "workflow", "amend-prepare", "--session", fixture.coordinator,
          "--expect-snapshot", snapshotVersion, "--input", fixture.patchPath, "--json",
        ],
        operation: "amend-prepare",
      },
      {
        name: "missing-input",
        args: [
          "workflow", "amend-prepare", "--session", fixture.coordinator,
          "--expect-snapshot", snapshotVersion, "--expect-compass", compassVersion, "--json",
        ],
        operation: "amend-prepare",
      },
      {
        name: "malformed-token",
        args: [
          "workflow", "amend-prepare", "--session", fixture.coordinator,
          "--expect-snapshot", "not-a-version", "--expect-compass", compassVersion,
          "--input", fixture.patchPath, "--json",
        ],
        operation: "amend-prepare",
      },
      {
        name: "unknown-flag",
        args: ["workflow", "amend-prepare", "--session", fixture.coordinator, "--force", "--json"],
        operation: "amend-prepare",
      },
    ];

    for (const usageCase of usageCases) {
      const result = runCli(usageCase.args, fixture.root);
      expect(`${usageCase.name}: ${result.exitCode}`).toBe(`${usageCase.name}: 2`);
      const payload = jsonOf(result);
      expect(`${usageCase.name}: ${String(payload.ok)}`).toBe(`${usageCase.name}: false`);
      expect(`${usageCase.name}: ${String(payload.code)}`).toBe(`${usageCase.name}: usage`);
      expect(`${usageCase.name}: ${String(payload.operation)}`).toBe(`${usageCase.name}: ${usageCase.operation}`);
    }
    // No usage case reached the engine.
    expect(readText(fixture.snapshotPath)).toBe(before);
  }, 60000);

  test("a stale compass token refuses with the structured failure and leaves the protected bytes byte-identical", () => {
    const fixture = makePrepareFixture();
    const view = jsonOf(runCli(showPrepareArgs(fixture), fixture.root));
    const before = readText(fixture.snapshotPath);
    const beforeStatus = readText(fixture.statusPath);
    const stale = `sha256:${"0".repeat(64)}`;

    const refused = runCli(
      amendPrepareArgs(fixture, { snapshot: String(view.snapshot_version), compass: stale }),
      fixture.root,
    );

    expect(refused.exitCode).toBe(1);
    const payload = jsonOf(refused);
    expect(payload.ok).toBe(false);
    expect(payload.operation).toBe("amend-prepare");
    expect(payload.code).toBe("coordination.prepare-amendment.stale");
    expect(payload.expected).toBe(stale);
    expect(payload.actual).toBe(view.compass_version);
    expect(readText(fixture.snapshotPath)).toBe(before);
    expect(readText(fixture.statusPath)).toBe(beforeStatus);

    // Human mode keeps stdout machine-only and names the family it refused.
    const human = runCli(
      amendPrepareArgs(fixture, { snapshot: String(view.snapshot_version), compass: stale }, false),
      fixture.root,
    );
    expect(human.exitCode).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("workflow amend-prepare:");
    expect(readText(fixture.snapshotPath)).toBe(before);
  });

  test("a duplicate plan id refuses through the CLI while the read stays available", () => {
    const fixture = makePrepareFixture();
    const view = jsonOf(runCli(showPrepareArgs(fixture), fixture.root));
    const patch = preparePatchOf(fixture);
    const appends = patch.appendPlans as Array<Record<string, unknown>>;
    writeJson(fixture.patchPath, { ...patch, appendPlans: [{ ...appends[0]!, id: PREPARE_ROW }] });
    const before = readText(fixture.snapshotPath);

    const refused = runCli(
      amendPrepareArgs(fixture, { snapshot: String(view.snapshot_version), compass: String(view.compass_version) }),
      fixture.root,
    );

    expect(refused.exitCode).toBe(1);
    const payload = jsonOf(refused);
    expect(payload.ok).toBe(false);
    expect(payload.operation).toBe("amend-prepare");
    expect(payload.code).toBe("coordination.prepare-amendment.duplicate-plan");
    expect(readText(fixture.snapshotPath)).toBe(before);
    // The stale-read route still works: the review can be re-read and re-applied.
    expect(jsonOf(runCli(showPrepareArgs(fixture), fixture.root)).allowed).toBe(true);
  });

  test("a workflow refusal carries the addressed workflow id from the engine details", () => {
    const fixture = makePrepareFixture();
    const view = jsonOf(runCli(showPrepareArgs(fixture), fixture.root));
    const before = readText(fixture.snapshotPath);
    // The reviewed compass disappears between the read and the amendment, so
    // the engine refusal carries the addressed workflow in its own details.
    rmSync(fixture.compassPath);

    const refused = runCli(
      amendPrepareArgs(fixture, { snapshot: String(view.snapshot_version), compass: String(view.compass_version) }),
      fixture.root,
    );

    expect(refused.exitCode).toBe(1);
    const payload = jsonOf(refused);
    expect(payload.ok).toBe(false);
    expect(payload.operation).toBe("amend-prepare");
    expect(payload.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(payload.workflow_id).toBe(PREPARE_WORKFLOW);
    expect(readText(fixture.snapshotPath)).toBe(before);
  });

  test("a usage payload names the family the caller invoked, not an argv value equal to a family token", () => {
    const fixture = makePrepareFixture();
    const before = readText(fixture.snapshotPath);
    // Both invocations carry an argv value equal to the *other* family token
    // (`--session plan` is the usage error itself), so only the command the
    // caller actually ran may decide the payload's family.
    const usageCases: Array<{ name: string; args: string[]; operation: string }> = [
      {
        name: "workflow-with-a-plan-valued-flag",
        args: ["workflow", "amend-prepare", "--session", "plan", "--force", "--json"],
        operation: "amend-prepare",
      },
      {
        name: "plan-with-a-workflow-valued-flag",
        args: ["plan", "show", "--session", "workflow", "--force", "--json"],
        operation: "show",
      },
    ];

    for (const usageCase of usageCases) {
      const result = runCli(usageCase.args, fixture.root);
      expect(`${usageCase.name}: ${result.exitCode}`).toBe(`${usageCase.name}: 2`);
      const payload = jsonOf(result);
      expect(`${usageCase.name}: ${String(payload.ok)}`).toBe(`${usageCase.name}: false`);
      expect(`${usageCase.name}: ${String(payload.code)}`).toBe(`${usageCase.name}: usage`);
      expect(`${usageCase.name}: ${String(payload.operation)}`).toBe(`${usageCase.name}: ${usageCase.operation}`);
    }
    expect(readText(fixture.snapshotPath)).toBe(before);
  }, 30000);

  test("an unexpected workflow-family failure carries the workflow family's own code", () => {
    const fixture = makePrepareFixture();
    const view = jsonOf(runCli(showPrepareArgs(fixture), fixture.root));
    const before = readText(fixture.snapshotPath);
    const snapshotDir = dirname(fixture.snapshotPath);
    // The snapshot directory loses write permission after the read, so the
    // write-lock mkdir next to snapshot.json throws a raw FS error (EACCES)
    // rather than a typed coordination / plan-path refusal. That is still
    // the unexpected-error path, which must name the family the caller ran
    // and must not have written anything.
    chmodSync(snapshotDir, 0o555);
    try {
      const failed = runCli(
        amendPrepareArgs(fixture, { snapshot: String(view.snapshot_version), compass: String(view.compass_version) }),
        fixture.root,
      );

      expect(failed.exitCode).toBe(1);
      const payload = jsonOf(failed);
      expect(payload.ok).toBe(false);
      expect(payload.operation).toBe("amend-prepare");
      expect(payload.code).toBe("workflow.internal-error");
      expect(readText(fixture.snapshotPath)).toBe(before);
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
    const statusBefore = readText(fixture.statusPath);

    const view = jsonOf(runCli(showPrepareArgs(fixture), fixture.root));
    const amended = runCli(
      amendPrepareArgs(fixture, { snapshot: String(view.snapshot_version), compass: String(view.compass_version) }),
      fixture.root,
    );

    expect(amended.exitCode).toBe(0);
    const payload = jsonOf(amended);
    expect(payload.ok).toBe(true);
    expect(payload.operation).toBe("amend-prepare");
    expect(payload.outcome).toBe("amended");
    expect(payload.plan_ids).toEqual([PREPARE_ROW, PREPARE_APPEND]);

    const after = readJson(fixture.snapshotPath) as { plans: Array<Record<string, unknown>> };
    expect(after.plans[0]!.file).toBe(correctedPath);
    // The correction is a delta: the root register never moves.
    expect(readText(fixture.statusPath)).toBe(statusBefore);

    // A correction whose old pointer names a foreign document refuses with exit
    // 1 and leaves the snapshot byte-identical.
    const before = readText(fixture.snapshotPath);
    const freshView = jsonOf(runCli(showPrepareArgs(fixture), fixture.root));
    writeJson(fixture.patchPath, {
      ...preparePatchOf(fixture),
      appendPlans: [],
      correctPlanFiles: [
        { id: PREPARE_ROW, expectedFile: join(fixture.root, `${PREPARE_ROW}.md`), file: correctedPath },
      ],
    });
    const refused = runCli(
      amendPrepareArgs(fixture, { snapshot: String(freshView.snapshot_version), compass: String(freshView.compass_version) }),
      fixture.root,
    );
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused).code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(readText(fixture.snapshotPath)).toBe(before);
  }, 30000);
});

describe("mstar plan — catalog pin", () => {
  test("catalog pin: a store-less prepare is disclosed as store-absent, and a planted pin refuses bind with the stable code", () => {
    const fixture = makeFixture({ store: false });
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);

    // No catalog store exists in this fixture. The reader discloses that
    // explicitly instead of reading the missing store as an empty catalog.
    const view = runCli(["plan", "show", "--session", coordinator, "--plan", PLAN_ID, "--json"], fixture.root);
    expect(view.exitCode).toBe(0);
    expect(jsonOf(view).catalog_pin).toMatchObject({
      source: null,
      pin: null,
      absence: "store-absent",
      conflict: null,
    });

    // A generic snapshot metadata update plants a pin whose document hash does
    // not match the frozen row: the engine neither repairs it nor follows it.
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

    const shown = runCli(["plan", "show", "--session", coordinator, "--plan", PLAN_ID, "--json"], fixture.root);
    expect(shown.exitCode).toBe(0);
    const shownPayload = jsonOf(shown) as { catalog_pin: { conflict: string | null; pin: { entity_revision: number } } };
    expect(shownPayload.catalog_pin.pin.entity_revision).toBe(1);
    expect(shownPayload.catalog_pin.conflict).not.toBeNull();

    // Execution start refuses with the engine's own code (exit 1, not an
    // internal error), and writes no session.
    const bound = runCli(["plan", "bind", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--json"], fixture.root);
    expect(bound.exitCode).toBe(1);
    const failure = jsonOf(bound);
    expect(failure.ok).toBe(false);
    expect(failure.code).toBe("catalog.execution-pin-conflict");
    expect(failure.workflow_id).toBe(WORKFLOW_ID);

    const human = runCli(["plan", "bind", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID], fixture.root);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain("catalog.execution-pin-conflict");
  });
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
  tokens: { snapshot: string; compass: string },
  overrides: Record<string, unknown> = {},
): string[] {
  const flags: Array<[string, string | undefined]> = [
    ["--prior-session", overrides.priorSession as string | undefined ?? fixture.coordinator],
    ["--session-id", overrides.sessionId as string | undefined ?? CLI_RECOVERY_SESSION_ID],
    ["--expect-snapshot", overrides.expectSnapshot as string | undefined ?? tokens.snapshot],
    ["--expect-compass", overrides.expectCompass as string | undefined ?? tokens.compass],
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
  if (overrides.json !== false) argv.push("--json");
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
    const view = jsonOf(runCli(showPrepareArgs(fixture), fixture.root));
    const tokens = { snapshot: String(view.snapshot_version), compass: String(view.compass_version) };
    const peerBefore = readText(fixture.peerSnapshotPath);
    const rowsBefore = JSON.stringify(cliPlanRowsOf(fixture));

    const recovered = runCli(recoverCoordinatorArgs(fixture, tokens), fixture.root);

    expect(recovered.exitCode).toBe(0);
    const payload = jsonOf(recovered);
    expect(payload.ok).toBe(true);
    expect(payload.operation).toBe("recover-coordinator");
    expect(payload.workflow_id).toBe(PREPARE_WORKFLOW);
    expect(payload.prior_session_id).toBe(FIXTURE_COORDINATOR_ID);
    expect(payload.session_id).toBe(CLI_RECOVERY_SESSION_ID);
    expect(payload.operation_id).toBe("op-cli-recover-1");
    expect(payload.replay).toBe(false);
    // §3.3's public projection: the envelope/credential path is coordinator-owned
    // transport and never a CLI (or diagnostic) output field.
    const newEnvelope = join(fixture.harness, "workflows", PREPARE_WORKFLOW, "sessions", `coordinator-${CLI_RECOVERY_SESSION_ID}.json`);
    expect(payload.session_file).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual([
      "compass_version",
      "ok",
      "operation",
      "operation_id",
      "prior_session_id",
      "replay",
      "session_id",
      "snapshot_version",
      "workflow_id",
    ]);
    expect(recovered.stdout).not.toContain("sessions");
    // Human mode keeps stdout machine-only and prints no envelope path either.
    const human = runCli(recoverCoordinatorArgs(fixture, tokens, { json: false }), fixture.root);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe("");
    expect(human.stderr).not.toContain(newEnvelope);
    expect(human.stderr).toContain(CLI_RECOVERY_SESSION_ID);

    // Authoritative state, read from disk — never from the CLI's claim.
    expect(cliRecordedCoordinator(fixture)).toMatchObject({ session_id: CLI_RECOVERY_SESSION_ID });
    const audit = cliRecoveryAudit(fixture);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operation_id: "op-cli-recover-1",
      prior_session_id: FIXTURE_COORDINATOR_ID,
      session_id: CLI_RECOVERY_SESSION_ID,
      snapshot_version_before: tokens.snapshot,
      compass_version: tokens.compass,
    });
    // Rows and the sibling workflow are untouched; the old envelope survives.
    expect(JSON.stringify(cliPlanRowsOf(fixture))).toBe(rowsBefore);
    expect(readText(fixture.peerSnapshotPath)).toBe(peerBefore);
    expect(existsSync(fixture.coordinator)).toBe(true);

    // The old reference is historical: the binding moved, so it refuses, while
    // the replacement session is the live coordinator.
    const oldRefused = runCli(showPrepareArgs(fixture), fixture.root);
    expect(oldRefused.exitCode).toBe(1);
    const oldPayload = jsonOf(oldRefused);
    expect(oldPayload.operation).toBe("show-prepare");
    expect(oldPayload.code).toBe("coordination.session-mismatch");
    const live = runCli(
      ["workflow", "show-prepare", "--session", newEnvelope, "--json"],
      fixture.root,
    );
    expect(live.exitCode).toBe(0);
    expect(jsonOf(live).allowed).toBe(true);

    // An exact retry with the same reviewed tokens is a stable receipt.
    const committedBytes = readText(fixture.snapshotPath);
    const retry = runCli(recoverCoordinatorArgs(fixture, tokens), fixture.root);
    expect(retry.exitCode).toBe(0);
    expect(jsonOf(retry).replay).toBe(true);
    expect(readText(fixture.snapshotPath)).toBe(committedBytes);
    expect(cliRecoveryAudit(fixture)).toHaveLength(1);

    // A changed request and an incomplete stop assertion both refuse with their
    // own engine codes, exit 1, and no mutation — each against the CURRENT
    // reviewed tokens, so the refusal is the guard's own and not a stale token.
    const liveView = jsonOf(runCli(["workflow", "show-prepare", "--session", newEnvelope, "--json"], fixture.root));
    const liveTokens = { snapshot: String(liveView.snapshot_version), compass: String(liveView.compass_version) };
    const changedReason = runCli(
      recoverCoordinatorArgs(fixture, liveTokens, { operationId: "op-cli-recover-1", reason: "another reason" }),
      fixture.root,
    );
    expect(changedReason.exitCode).toBe(1);
    expect(jsonOf(changedReason)).toMatchObject({ ok: false, code: "coordination.identity-recovery.operation-conflict", workflow_id: PREPARE_WORKFLOW });
    // The operator addresses the binding the workflow records NOW and names
    // somebody else as stopped: the engine authenticates the owner and then
    // refuses the incomplete attestation.
    const unauthorized = runCli(
      recoverCoordinatorArgs(fixture, liveTokens, {
        operationId: "op-cli-recover-3",
        priorSession: newEnvelope,
        sessionId: "another-coordinator",
        stopped: ["somebody-else"],
      }),
      fixture.root,
    );
    expect(unauthorized.exitCode).toBe(1);
    expect(jsonOf(unauthorized).code).toBe("coordination.identity-recovery.unauthorized");
    expect(readText(fixture.snapshotPath)).toBe(committedBytes);
    expect(cliRecoveryAudit(fixture)).toHaveLength(1);
  }, 60000);

  test("prepare coordinator recovery usage failures exit 2 without touching the workflow", () => {
    const fixture = makePrepareFixture();
    const view = jsonOf(runCli(showPrepareArgs(fixture), fixture.root));
    const tokens = { snapshot: String(view.snapshot_version), compass: String(view.compass_version) };
    const before = readText(fixture.snapshotPath);

    // No stop assertion, no reason, and a relative prior-session path are usage
    // errors (exit 2) decided before any engine I/O.
    const noStop = runCli(
      [
        "workflow",
        "recover-coordinator",
        "--prior-session",
        fixture.coordinator,
        "--session-id",
        CLI_RECOVERY_SESSION_ID,
        "--expect-snapshot",
        tokens.snapshot,
        "--expect-compass",
        tokens.compass,
        "--operation-id",
        "op-cli-usage-1",
        "--reason",
        "cancelled",
        "--authorization-ref",
        "PM-1",
        "--json",
      ],
      fixture.root,
    );
    expect(noStop.exitCode).toBe(2);
    expect(jsonOf(noStop)).toMatchObject({ ok: false, operation: "recover-coordinator", code: "usage" });

    const noReason = runCli(recoverCoordinatorArgs(fixture, tokens, { omitReason: true }), fixture.root);
    expect(noReason.exitCode).toBe(2);
    expect(jsonOf(noReason)).toMatchObject({ ok: false, operation: "recover-coordinator", code: "usage" });

    const relative = runCli(
      recoverCoordinatorArgs(fixture, tokens, { priorSession: ".mstar/workflows/x/sessions/coordinator-a.json" }),
      fixture.root,
    );
    expect(relative.exitCode).toBe(2);
    expect(jsonOf(relative).code).toBe("usage");
    // The rejected address is stated as a rule, never repeated (§5).
    expect(relative.stdout).not.toContain(".mstar/workflows/x/sessions/coordinator-a.json");
    expect(relative.stderr).not.toContain(".mstar/workflows/x/sessions/coordinator-a.json");

    // A credential-like replacement id is refused by the ENGINE (not by a CLI
    // guard), and that refusal reaches the same public diagnostic: it must name
    // the rule and the received length, never the value.
    for (const rejected of [`ghp_${"a".repeat(140)}`, "../creds/secret.json"]) {
      const badId = runCli(recoverCoordinatorArgs(fixture, tokens, { sessionId: rejected }), fixture.root);
      expect({ rejected, exitCode: badId.exitCode }).toEqual({ rejected, exitCode: 1 });
      expect(jsonOf(badId).code).toBe("coordination.invalid-session-id");
      expect(badId.stdout).not.toContain(rejected);
      expect(badId.stderr).not.toContain(rejected);
    }

    // A stop entry that is not a public session id (`a/b` would name another
    // path component) is decided as usage before any engine I/O, so the value is
    // never hashed into a request digest or persisted in the audit — and no
    // output (JSON payload or stderr) repeats the rejected value itself.
    for (const badStopped of ["a/b", "../creds/secret.json", `ghp_${"a".repeat(140)}`, "with space"]) {
      const malformed = runCli(recoverCoordinatorArgs(fixture, tokens, { stopped: [badStopped] }), fixture.root);
      const label = `${badStopped.slice(0, 12)}:`;
      expect(`${label} ${malformed.exitCode}`).toBe(`${label} 2`);
      expect(jsonOf(malformed)).toMatchObject({ ok: false, operation: "recover-coordinator", code: "usage" });
      expect(malformed.stdout).not.toContain(badStopped);
      expect(malformed.stderr).not.toContain(badStopped);
    }

    // A nonexistent absolute envelope is a runtime refusal (exit 1), never a
    // usage error, and it still writes nothing.
    const missing = runCli(
      recoverCoordinatorArgs(fixture, tokens, { priorSession: join(fixture.root, "no-such-session.json") }),
      fixture.root,
    );
    expect(missing.exitCode).toBe(1);
    expect(jsonOf(missing).code).toBe("coordination.session-not-found");

    expect(readText(fixture.snapshotPath)).toBe(before);
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
      role: "plan-pm",
      sessionId: "execution-ref-session",
      planId: PLAN_ID,
    });
  }

  function activeIdentityEnv(): Record<string, string> {
    return {
      MSTAR_EXECUTION_IDENTITY: serializeExecutionValue({
        source: "local",
        sessionId: "execution-ref-session",
        workflowId: WORKFLOW_ID,
        role: "plan-pm",
        planId: PLAN_ID,
      }),
    };
  }

  test("the active flags never mix with the pre-activation ones, and write nothing (exit 2)", () => {
    const fixture = makeFixture();
    const before = snapshotBytes(fixture);

    const mixedArgs = [
      "plan",
      "progress",
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
    expect(mixed.stderr).toContain("disjoint transports");

    // Under `--json` the SAME refusal is the A2 usage object on stdout — the
    // one output path this family already uses for every usage failure
    // ("a commander-level usage failure still carries the A2 failure object
    // under --json", above in this file).
    const mixedJson = runCli([...mixedArgs, "--json"], fixture.root);
    expect(mixedJson.exitCode).toBe(2);
    expect(jsonOf(mixedJson).code).toBe("usage");
    expect(String(jsonOf(mixedJson).message)).toContain("disjoint transports");

    const stated = runCli(
      ["plan", "bind", "--execution", "--workflow", WORKFLOW_ID, "--coordinator", "--session-id", "some-session"],
      fixture.root,
    );
    expect(stated.exitCode).toBe(2);
    expect(stated.stderr).toContain("--session-id");

    expect(snapshotBytes(fixture)).toBe(before);
    expect(existsSync(fixture.projectRegisterPath)).toBe(false);
  });

  test("a numeric execution expectation, a missing operation or a missing identity is usage (exit 2)", () => {
    const fixture = makeFixture();
    const before = snapshotBytes(fixture);
    const progressPath = join(fixture.root, "progress.json");
    writeJson(progressPath, { status: "InReview", summary: "no write expected", evidence_paths: [fixture.evidencePath] });

    const numeric = runCli(
      ["plan", "progress", "--session-ref", activeRefWire(), "--expect", "3", "--operation", "progress-numeric", "--file", progressPath],
      fixture.root,
      activeIdentityEnv(),
    );
    expect(numeric.exitCode).toBe(2);
    expect(numeric.stderr).toContain("full execution token");

    const noOperation = runCli(
      ["plan", "progress", "--session-ref", activeRefWire(), "--expect", "exec-v1:plan:store:1:key:1", "--file", progressPath],
      fixture.root,
      activeIdentityEnv(),
    );
    expect(noOperation.exitCode).toBe(2);
    expect(noOperation.stderr).toContain("--operation");

    const noIdentity = runCli(
      [
        "plan",
        "show",
        "--session-ref",
        activeRefWire(),
        "--plan",
        PLAN_ID,
        "--json",
      ],
      fixture.root,
    );
    expect(noIdentity.exitCode).toBe(2);
    // `--json` usage failures of this family are the A2 object on STDOUT (the
    // existing convention: "a commander-level usage failure still carries the
    // A2 failure object under --json"), never a stderr line.
    expect(jsonOf(noIdentity).code).toBe("usage");
    expect(String(jsonOf(noIdentity).message)).toContain("MSTAR_EXECUTION_IDENTITY");

    expect(snapshotBytes(fixture)).toBe(before);
  });

  test("an active call against a pre-activation harness is the engine's refusal, never a file-route write", () => {
    const fixture = makeFixture();
    const before = snapshotBytes(fixture);
    const progressPath = join(fixture.root, "progress.json");
    writeJson(progressPath, { status: "InReview", summary: "no write expected", evidence_paths: [fixture.evidencePath] });

    const refused = runCli(
      [
        "plan",
        "progress",
        "--session-ref",
        activeRefWire(),
        "--expect",
        "exec-v1:plan:stores%2Fexecution-test:1:key64:1",
        "--operation",
        "progress-not-active",
        "--file",
        progressPath,
        "--json",
      ],
      fixture.root,
      activeIdentityEnv(),
    );
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused).code).toBe("execution.not-active");
    expect(snapshotBytes(fixture)).toBe(before);
  });
});
