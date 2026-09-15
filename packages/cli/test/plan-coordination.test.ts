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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runCli(args: string[], cwd: string): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd,
    env: cliEnv(),
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
  registerPath: string;
  evidencePath: string;
}

/** Temporary Git fixture: main worktree + canonical harness + two prepared rows. */
function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-plan-cli-")));
  roots.push(root);
  git(["init", "-q", "-b", "main"], root);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], root);

  const harness = join(root, ".mstar");
  const workflowDir = join(harness, "workflows", WORKFLOW_ID);
  const snapshotPath = join(workflowDir, "snapshot.json");
  const registerPath = join(harness, "projects", PROJECT_ID, "residuals.json");
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
    registerPath,
    evidencePath,
  };
}

/** Bind the workflow coordinator through the CLI and return its session file. */
function bindCoordinator(fixture: Fixture): string {
  const bound = runCli(["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--json"], fixture.root);
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
    const again = runCli(["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--json"], fixture.root);
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

  test("--expect-register accepts only absent or the exact version token (exit 2)", () => {
    const fixture = makeFixture();
    // A real, parseable payload file. The flag is validated before any payload
    // is read, so a malformed token never degrades into a payload-read failure
    // and the payload bytes are never consumed.
    const entriesPath = join(fixture.root, "entries.json");
    const payload = `${JSON.stringify(
      [
        {
          id: "R1",
          title: "residual one",
          severity: "low",
          source: "cli-tests",
          scope: "cli",
          decision: "defer",
          owner: "pm",
          target: "later",
          tracking: "plan",
        },
      ],
      null,
      2,
    )}\n`;
    writeText(entriesPath, payload);
    // Two payload states: the existing file above, and a missing one. The
    // missing leg is the one that pins the ordering — with the payload read
    // first it reports "payload file not found" (still exit 2) and this case
    // fails, so the refusal must come from the flag in both states.
    for (const [state, file] of [
      ["existing", entriesPath],
      ["missing", join(fixture.root, "absent.json")],
    ] as const) {
      for (const value of ["latest", "sha256:ABC", "sha256:0"]) {
        const result = runCli(
          [
            "plan",
            "residual-add",
            "--session",
            "/tmp/nope.json",
            "--file",
            file,
            "--expect",
            "0",
            "--expect-register",
            value,
          ],
          fixture.root,
        );
        expect(`${state} ${value} -> ${result.exitCode}`).toBe(`${state} ${value} -> 2`);
        expect(result.stderr).toContain('--expect-register must be "absent" or sha256:<64 lowercase hex>');
        expect(result.stderr).not.toContain("payload file not found");
      }
    }
    expect(readText(entriesPath)).toBe(payload);
    // Positive control: with a valid token the same invocation gets past the
    // flag AND the payload read (the file above is genuinely parseable) and
    // fails later on the missing session — so the refusals above came from the
    // flag, never from the payload file.
    const accepted = runCli(
      [
        "plan",
        "residual-add",
        "--session",
        "/tmp/nope.json",
        "--file",
        entriesPath,
        "--expect",
        "0",
        "--expect-register",
        "absent",
      ],
      fixture.root,
    );
    expect(accepted.exitCode).toBe(1);
    expect(accepted.stderr).toContain("session envelope not found");
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
    const bound = runCli(["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID], fixture.root);
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
    const refused = runCli(["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--json"], linked);
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

  test("residual writes target the plan's own bucket with a register byte-version CAS", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);

    const view = runCli(["plan", "show", "--session", planSession, "--json"], fixture.root);
    const registerVersion = String(jsonOf(view).register_version);
    expect(registerVersion).toBe("absent");

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [
      {
        id: "R1",
        title: "residual one",
        severity: "low",
        source: "cli-tests",
        scope: "cli",
        decision: "defer",
        owner: "pm",
        target: "later",
        tracking: "plan",
      },
    ]);
    const added = runCli(
      [
        "plan",
        "residual-add",
        "--session",
        planSession,
        "--file",
        entriesPath,
        "--expect",
        String(rowRevision(fixture, planSession)),
        "--expect-register",
        registerVersion,
        "--json",
      ],
      fixture.root,
    );
    expect(added.exitCode).toBe(0);
    expect(jsonOf(added).outcome).toBe("residual-added");

    const register = readJson(fixture.registerPath);
    const entries = register.entries as Record<string, unknown[]>;
    expect(entries[PLAN_ID]).toHaveLength(1);
    expect(Object.keys(entries)).toEqual([PLAN_ID]);

    // Stale register version: refused, sibling buckets and own bytes preserved.
    const afterAdd = readText(fixture.registerPath);
    const staleAdd = runCli(
      [
        "plan",
        "residual-add",
        "--session",
        planSession,
        "--file",
        entriesPath,
        "--expect",
        String(rowRevision(fixture, planSession)),
        "--expect-register",
        registerVersion,
        "--json",
      ],
      fixture.root,
    );
    expect(staleAdd.exitCode).toBe(1);
    expect(jsonOf(staleAdd).ok).toBe(false);
    expect(readText(fixture.registerPath)).toBe(afterAdd);
  });

  test("residual-close resolves only the named entry with an evidence-bearing note", () => {
    const fixture = makeFixture();
    const coordinator = bindCoordinator(fixture);
    preparePlan(fixture, coordinator, PLAN_ID);
    const planSession = bindPlan(fixture, PLAN_ID);

    const entriesPath = join(fixture.root, "entries.json");
    writeJson(entriesPath, [
      {
        id: "R1",
        title: "residual one",
        severity: "low",
        source: "cli-tests",
        scope: "cli",
        decision: "defer",
        owner: "pm",
        target: "later",
        tracking: "plan",
      },
    ]);
    const added = runCli(
      [
        "plan",
        "residual-add",
        "--session",
        planSession,
        "--file",
        entriesPath,
        "--expect",
        String(rowRevision(fixture, planSession)),
        "--expect-register",
        "absent",
        "--json",
      ],
      fixture.root,
    );
    expect(added.exitCode).toBe(0);

    const version = String(jsonOf(runCli(["plan", "show", "--session", planSession, "--json"], fixture.root)).register_version);
    const closed = runCli(
      [
        "plan",
        "residual-close",
        "--session",
        planSession,
        "--entry",
        "R1",
        "--note",
        "fixed by the reviewer round",
        "--expect",
        String(rowRevision(fixture, planSession)),
        "--expect-register",
        version,
        "--json",
      ],
      fixture.root,
    );
    expect(closed.exitCode).toBe(0);
    expect(jsonOf(closed).outcome).toBe("residual-closed");

    const bucket = (readJson(fixture.registerPath).entries as Record<string, Array<Record<string, unknown>>>)[PLAN_ID]!;
    expect(bucket[0]!.lifecycle).toBe("resolved");
    expect(bucket[0]!.closure_note).toBe("fixed by the reviewer round");
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
