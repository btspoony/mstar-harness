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
 * `scoped-operations`. The `integration-recovery` group (handoff → accept →
 * integration-start → explicit merge → integration-accept → complete →
 * reconcile) is not present: the engine's row verbs for it are unlanded and
 * refuse with `coordination.not-implemented` — see the task report.
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
      ["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--json", "--nope"],
    ];
    for (const args of cases) {
      const result = runCli(args, fixture.root);
      expect({ args, exitCode: result.exitCode }).toEqual({ args, exitCode: 2 });
      expect(result.stdout).toBe("");
    }
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
    for (const value of ["latest", "sha256:ABC", "sha256:0"]) {
      const result = runCli(
        [
          "plan",
          "residual-add",
          "--session",
          "/tmp/nope.json",
          "--file",
          join(fixture.root, "entries.json"),
          "--expect",
          "0",
          "--expect-register",
          value,
        ],
        fixture.root,
      );
      expect({ value, exitCode: result.exitCode }).toEqual({ value, exitCode: 2 });
    }
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
