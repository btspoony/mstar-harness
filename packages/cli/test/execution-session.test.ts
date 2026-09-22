/**
 * CLI active execution transport — C4 (phase 2b execution contract §3.2).
 *
 * Run with `bun test packages/cli/test/execution-session.test.ts`.
 *
 * Every case runs the real CLI entry as a subprocess against a temporary Git
 * workspace holding a REAL active execution authority (built by the engine's own
 * producers). The identity channel is set exactly the way a launcher sets it —
 * the engine's public `serializeExecutionValue(identity)` — and authoritative
 * state (sessions, rows, tokens) is read back through the engine, never from the
 * CLI's own claim.
 *
 * Acceptance criteria carried by these cases:
 *
 * - `documented invocation`: the §3.2 invocations themselves — the local
 *   launcher, the coordinator/plan-pm binds, resume and a plan mutation — with
 *   the child's exit code and signal propagated.
 * - `identity channel`: a missing, malformed or foreign identity refuses before
 *   any write; a copied reference cannot authorize another session.
 * - `transport disjointness`: `--session`/`--session-ref`, numeric `--expect`,
 *   `--session-id` and `--resume`/`--resume-ref` never mix (exit 2).
 * - `recovery`: a stopped coordinator is replaced through the active recovery
 *   verb under an independently acquired identity and a real stop attestation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  encodeExecutionSessionRef,
  initializeExecutionAuthority,
  initializeStore,
  readExecutionAuthority,
  serializeExecutionValue,
  type ExecutionIdentity,
  type ExecutionPlanView,
  type ExecutionSessionRef,
  type ExecutionState,
  type StoreContext,
} from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

const WORKFLOW_ID = "wf-exec-session";
const PLAN_ID = "20260921-execution-session-plan";
const COORDINATOR_ID = "coord-exec-session";
const PLAN_PM_ID = "planpm-exec-session";
const SUCCESSOR_ID = "coord-exec-session-2";
const WIRE_PREFIX = "exec-session-v1:";

interface RunResult {
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
}

interface Fixture {
  root: string;
  harnessDir: string;
  context: StoreContext;
  planMarkdown: string;
  assignmentPath: string;
  worktreePath: string;
  sddDir: string;
  evidencePath: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The header block `parseAssignmentFile` accepts (the DB prepare seals it). */
function assignmentText(input: { harnessDir: string; planMarkdown: string; worktreePath: string; sddDir: string }): string {
  return [
    `# Assignment \u2014 ${PLAN_ID}`,
    "",
    `**Control harness root**: ${input.harnessDir}`,
    `**Workflow id**: ${WORKFLOW_ID}`,
    `**Plan id**: ${PLAN_ID}`,
    `**Plan Path**: ${input.planMarkdown}`,
    `**Worktree Path**: ${input.worktreePath}`,
    "**Working branch**: feature/exec-session",
    `**SDD dir**: ${input.sddDir}`,
    "**Execute as**: project-manager",
    "**Execution scope**: plan",
    "**Delegation**: forbidden",
    "**Prepare gate**: go",
    "**QA gate**: mandatory",
    "**Findings cleanup**: allow-residual",
    "",
    "Body.",
    "",
  ].join("\n");
}

/** Spawn env with ambient harness/identity env vars pinned out, then the fixture's own. */
function cliEnv(fixture: Fixture, identity?: ExecutionIdentity): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (key === "MSTAR_HOST_SESSION_ID" || key === "MSTAR_EXECUTION_IDENTITY") continue;
    if (value !== undefined) env[key] = value;
  }
  env.MSTAR_HARNESS_DIR = fixture.harnessDir;
  if (identity !== undefined) env.MSTAR_EXECUTION_IDENTITY = serializeExecutionValue(identity);
  return env;
}

function spawnCli(args: string[], fixture: Fixture, env: Record<string, string>): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: fixture.root,
    env,
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

function runCli(args: string[], fixture: Fixture, identity?: ExecutionIdentity): RunResult {
  return spawnCli(args, fixture, cliEnv(fixture, identity));
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

function coordinatorIdentity(): ExecutionIdentity {
  return { source: "local", sessionId: COORDINATOR_ID, workflowId: WORKFLOW_ID, role: "coordinator", planId: null };
}

function planPmIdentity(sessionId = PLAN_PM_ID): ExecutionIdentity {
  return { source: "local", sessionId, workflowId: WORKFLOW_ID, role: "plan-pm", planId: PLAN_ID };
}

/** A temp Git workspace whose `.mstar` holds an ACTIVE execution authority. */
async function activeFixture(label: string): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: root,
  });
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const context: StoreContext = { harnessDir };
  const store = await initializeStore(context);
  store.close();
  await initializeExecutionAuthority(context);

  const planMarkdown = join(harnessDir, "plans", `${PLAN_ID}.md`);
  const sddDir = join(harnessDir, "sdd", PLAN_ID);
  const worktreePath = join(root, "wt-exec-session");
  const evidencePath = join(sddDir, "evidence.md");
  writeText(planMarkdown, `# ${PLAN_ID}\n`);
  writeText(evidencePath, "# evidence\n");
  mkdirSync(worktreePath, { recursive: true });
  const assignmentPath = join(sddDir, "assignment.md");
  writeText(assignmentPath, assignmentText({ harnessDir, planMarkdown, worktreePath, sddDir }));
  return { root, harnessDir, context, planMarkdown, assignmentPath, worktreePath, sddDir, evidencePath };
}

/** Register the workflow through the ACTIVE registration route (the real producer chain). */
function registerThroughAuthority(fixture: Fixture, identity: ExecutionIdentity, rootToken: string): void {
  const registered = runCli(
    [
      "workflow",
      "register",
      "--workflow",
      WORKFLOW_ID,
      "--plan-id",
      PLAN_ID,
      "--plan-title",
      "Execution session transport plan",
      "--plan-file",
      `plans/${PLAN_ID}.md`,
      "--delivery-kind",
      "development",
      "--branch-source",
      "feature/exec-session",
      "--branch-target",
      "main",
      "--expect",
      rootToken,
      "--operation",
      "register-1",
      "--harness",
      fixture.harnessDir,
      "--json",
    ],
    fixture,
    identity,
  );
  expect(registered.exitCode).toBe(0);
  expect(jsonOf(registered).route).toBe("execution");
  expect(dataOf(registered).workflowId).toBe(WORKFLOW_ID);
}

/** The store's own tokens, read through the engine (never the CLI's claim). */
async function tokensOf(fixture: Fixture): Promise<{ root: string; workflow: string; plan: string }> {
  const state = await readExecutionAuthority(fixture.context);
  if (!("workflows" in state.data)) throw new Error("the register read did not return the whole state");
  const workflow = state.data.workflows.find((entry) => entry.state.id === WORKFLOW_ID);
  if (workflow === undefined) throw new Error(`workflow ${WORKFLOW_ID} is not in the authority register`);
  const plan = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
  return { root: state.token, workflow: workflow.workflowToken, plan: plan.token };
}

/** The store-held coordinator/plan-pm view of the addressed workflow. */
async function workflowStateOf(fixture: Fixture): Promise<ExecutionState["workflows"][number]> {
  const state = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID });
  if (!("workflows" in state.data)) throw new Error("the workflow read did not return a state");
  const workflow = state.data.workflows.find((entry) => entry.state.id === WORKFLOW_ID);
  if (workflow === undefined) throw new Error(`workflow ${WORKFLOW_ID} is not in the authority register`);
  return workflow;
}

/** Bind a session through the documented active form and return its wire reference. */
function activeBind(
  fixture: Fixture,
  identity: ExecutionIdentity,
  args: string[],
  token: string,
  operationId: string,
): { ref: ExecutionSessionRef; wire: string } {
  const result = runCli(
    [
      "plan",
      "bind",
      "--execution",
      "--workflow",
      WORKFLOW_ID,
      ...args,
      "--expect",
      token,
      "--operation",
      operationId,
      "--harness",
      fixture.harnessDir,
      "--json",
    ],
    fixture,
    identity,
  );
  expect(result.exitCode).toBe(0);
  expect(jsonOf(result).route).toBe("execution");
  expect(jsonOf(result).operation).toBe("bind");
  expect(jsonOf(result).operation_id).toBe(operationId);
  const ref = dataOf(result) as unknown as ExecutionSessionRef;
  expect(ref.workflowId).toBe(WORKFLOW_ID);
  const wire = encodeExecutionSessionRef(ref);
  expect(wire.startsWith(WIRE_PREFIX)).toBe(true);
  return { ref, wire };
}

/** One stop attestation naming the prior coordinator (the §7 document shape). */
function attestationFor(priorSessionId: string): Record<string, unknown> {
  return {
    version: 1,
    attestedAt: "2026-09-22T00:00:00.000Z",
    operator: { actor: "cli-test-operator", authorizationRef: "exec-session-test" },
    consumers: [
      {
        entryId: "mstar-cli",
        kind: "coordinator",
        entrypoint: "packages/cli/src/index.ts",
        runtime: "bun",
        runtimeVersion: "1.4.0",
        version: "0.0.0-test",
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions: [{ sessionId: priorSessionId, host: "omp", state: "stopped" }],
  };
}

describe("mstar session run \u2014 documented invocation", () => {
  test("launches argv under one minted local identity and propagates its exit code", async () => {
    const fixture = await activeFixture("mstar-session-run");
    const script =
      "const v=JSON.parse(process.env.MSTAR_EXECUTION_IDENTITY);console.log(JSON.stringify(v));process.exit(3);";
    const child = spawnCli(
      [
        "session",
        "run",
        "--workflow",
        WORKFLOW_ID,
        "--role",
        "plan-pm",
        "--plan",
        PLAN_ID,
        "--harness",
        fixture.harnessDir,
        "--",
        process.execPath,
        "-e",
        script,
      ],
      fixture,
      cliEnv(fixture),
    );

    // The child's own exit code is the launcher's: nothing is swallowed.
    expect(child.exitCode).toBe(3);
    const identity = JSON.parse(child.stdout.toString()) as ExecutionIdentity;
    expect(identity.source).toBe("local");
    expect(identity.role).toBe("plan-pm");
    expect(identity.workflowId).toBe(WORKFLOW_ID);
    expect(identity.planId).toBe(PLAN_ID);
    expect(identity.sessionId.length).toBeGreaterThan(0);
    // The launched identity is minted, never inherited from the caller's env.
    expect(identity.sessionId).not.toBe(PLAN_PM_ID);
  });

  test("reports the signal a child was killed by, and refuses a coordinator identity with a plan", async () => {
    const fixture = await activeFixture("mstar-session-signal");
    const killed = spawnCli(
      [
        "session",
        "run",
        "--workflow",
        WORKFLOW_ID,
        "--role",
        "coordinator",
        "--harness",
        fixture.harnessDir,
        "--",
        "sh",
        "-c",
        "kill -TERM $$",
      ],
      fixture,
      cliEnv(fixture),
    );
    expect(killed.signalCode).toBe("SIGTERM");

    const mixed = runCli(
      ["session", "run", "--workflow", WORKFLOW_ID, "--role", "coordinator", "--plan", PLAN_ID, "--", "true"],
      fixture,
    );
    expect(mixed.exitCode).toBe(2);
    expect(mixed.stderr).toContain("--plan");
  });

  test("binds, resumes and mutates in a temporary DB, and a retry replays the same receipt", async () => {
    const fixture = await activeFixture("mstar-session-chain");
    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, identity, initial.token);

    // The tokens the active writes consume come from a read of THIS store.
    const beforeBind = await tokensOf(fixture);
    const coordinator = activeBind(fixture, identity, ["--coordinator"], beforeBind.workflow, "bind-coordinator");

    // The coordinator prepares the row through the DB route (no session file).
    const prepared = runCli(
      [
        "plan",
        "prepare",
        "--session-ref",
        coordinator.wire,
        "--plan",
        PLAN_ID,
        "--assignment",
        fixture.assignmentPath,
        "--expect",
        beforeBind.plan,
        "--operation",
        "prepare-1",
        "--harness",
        fixture.harnessDir,
        "--json",
      ],
      fixture,
      identity,
    );
    expect(prepared.exitCode).toBe(0);
    expect(jsonOf(prepared).route).toBe("execution");

    // The plan-pm seat claims the prepared row with its own acquired identity.
    const afterPrepare = await tokensOf(fixture);
    const planPm = activeBind(fixture, planPmIdentity(), ["--plan", PLAN_ID], afterPrepare.plan, "bind-plan-pm");
    expect(planPm.ref.role).toBe("plan-pm");
    expect(planPm.ref.planId).toBe(PLAN_ID);
    expect(planPm.ref.sessionId).toBe(PLAN_PM_ID);

    // The session-authorized view of that binding, and the documented resume.
    const view = runCli(
      ["plan", "show", "--session-ref", planPm.wire, "--plan", PLAN_ID, "--harness", fixture.harnessDir, "--json"],
      fixture,
      planPmIdentity(),
    );
    expect(view.exitCode).toBe(0);
    expect(jsonOf(view).operation).toBe("show");
    expect(jsonOf(view).route).toBe("execution");

    const resumed = runCli(
      ["plan", "bind", "--execution", "--resume-ref", planPm.wire, "--json"],
      fixture,
      planPmIdentity(),
    );
    expect(resumed.exitCode).toBe(0);
    expect(jsonOf(resumed).operation).toBe("bind");
    // A resume is a read: it carries no operation receipt.
    expect(jsonOf(resumed).operation_id).toBeUndefined();
    expect(jsonOf(resumed).replayed).toBeUndefined();
    expect(String(dataOf(resumed).sessionId)).toBe(PLAN_PM_ID);

    // One plan mutation through the active transport, then its exact retry.
    const progressPath = join(fixture.root, "progress.json");
    writeJson(progressPath, { status: "InReview", summary: "handoff prepared", evidence_paths: [fixture.evidencePath] });
    const beforeMutation = await tokensOf(fixture);
    const progressArgs = [
      "plan",
      "progress",
      "--session-ref",
      planPm.wire,
      "--file",
      progressPath,
      "--expect",
      beforeMutation.plan,
      "--operation",
      "progress-1",
      "--harness",
      fixture.harnessDir,
      "--json",
    ];
    const progressed = runCli(progressArgs, fixture, planPmIdentity());
    expect(progressed.exitCode).toBe(0);
    expect(jsonOf(progressed).operation).toBe("progress");
    expect(jsonOf(progressed).replayed).toBe(false);
    expect(dataOf(progressed).plan).toMatchObject({ id: PLAN_ID, status: "InReview" });

    const retried = runCli(progressArgs, fixture, planPmIdentity());
    expect(retried.exitCode).toBe(0);
    expect(jsonOf(retried).replayed).toBe(true);
    expect(jsonOf(retried).operation_id).toBe("progress-1");

    // The authority itself holds the mutation (the CLI's claim is not the proof).
    const stored = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
    if (!("plan" in stored.data)) throw new Error("the plan read did not return a plan view");
    const planView: ExecutionPlanView = stored.data;
    expect(planView.plan.status).toBe("InReview");
  });
});

describe("mstar plan \u2014 identity channel", () => {
  test("a missing or malformed identity refuses before any write (exit 2)", async () => {
    const fixture = await activeFixture("mstar-session-identity");
    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, identity, initial.token);
    const tokens = await tokensOf(fixture);
    const bindArgs = [
      "plan",
      "bind",
      "--execution",
      "--workflow",
      WORKFLOW_ID,
      "--coordinator",
      "--expect",
      tokens.workflow,
      "--operation",
      "bind-no-identity",
      "--harness",
      fixture.harnessDir,
      "--json",
    ];

    const absent = runCli(bindArgs, fixture);
    expect(absent.exitCode).toBe(2);
    expect(jsonOf(absent).code).toBe("usage");

    const malformed = spawnCli(bindArgs, fixture, {
      ...cliEnv(fixture, identity),
      MSTAR_EXECUTION_IDENTITY: "{not json",
    });
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr).toContain("MSTAR_EXECUTION_IDENTITY");
    expect(malformed.stdout).not.toContain(WIRE_PREFIX);

    // Nothing was bound by either refusal: the authority holds no coordinator.
    const workflow = await workflowStateOf(fixture);
    expect(workflow.coordinator).toBeNull();
  });
});

describe("mstar plan \u2014 transport disjointness", () => {
  test("the active flags never mix with the pre-activation ones (exit 2)", async () => {
    const fixture = await activeFixture("mstar-session-mixed");
    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, identity, initial.token);
    const tokens = await tokensOf(fixture);

    const mixedSession = runCli(
      [
        "plan",
        "progress",
        "--session",
        join(fixture.sddDir, "session.json"),
        "--session-ref",
        `${WIRE_PREFIX}AAAA`,
        "--expect",
        tokens.plan,
        "--operation",
        "progress-mixed",
        "--file",
        fixture.evidencePath,
      ],
      fixture,
      identity,
    );
    expect(mixedSession.exitCode).toBe(2);
    expect(mixedSession.stderr).toContain("disjoint transports");

    const numeric = runCli(
      [
        "plan",
        "progress",
        "--session-ref",
        `${WIRE_PREFIX}AAAA`,
        "--expect",
        "3",
        "--operation",
        "progress-numeric",
        "--file",
        fixture.evidencePath,
      ],
      fixture,
      identity,
    );
    expect(numeric.exitCode).toBe(2);
    expect(numeric.stderr).toContain("full execution token");

    const stated = runCli(
      ["plan", "bind", "--execution", "--workflow", WORKFLOW_ID, "--coordinator", "--session-id", PLAN_PM_ID],
      fixture,
      identity,
    );
    expect(stated.exitCode).toBe(2);
    expect(stated.stderr).toContain("--session-id");

    const resumeMix = runCli(
      ["plan", "bind", "--execution", "--resume-ref", `${WIRE_PREFIX}AAAA`, "--resume", "/tmp/x.json"],
      fixture,
      identity,
    );
    expect(resumeMix.exitCode).toBe(2);
    expect(resumeMix.stderr).toContain("--resume");
  });

  test("a copied reference under another acquired identity cannot write", async () => {
    const fixture = await activeFixture("mstar-session-copied");
    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, identity, initial.token);
    const tokens = await tokensOf(fixture);
    const coordinator = activeBind(fixture, identity, ["--coordinator"], tokens.workflow, "bind-coordinator");

    const progressPath = join(fixture.root, "progress.json");
    writeJson(progressPath, { status: "InReview", summary: "copied", evidence_paths: [fixture.evidencePath] });
    const afterBind = await tokensOf(fixture);

    // The same wire under a DIFFERENT independently acquired identity is not
    // that session: the engine compares the caller inside its own transaction.
    const foreign: ExecutionIdentity = { ...coordinatorIdentity(), sessionId: SUCCESSOR_ID };
    const copied = runCli(
      [
        "plan",
        "progress",
        "--session-ref",
        coordinator.wire,
        "--plan",
        PLAN_ID,
        "--file",
        progressPath,
        "--expect",
        afterBind.plan,
        "--operation",
        "progress-copied",
        "--harness",
        fixture.harnessDir,
        "--json",
      ],
      fixture,
      foreign,
    );
    expect(copied.exitCode).toBe(1);
    expect(String(jsonOf(copied).code)).toMatch(/^(coordination|execution)\./);

    // A reference the store does not hold is refused too.
    const staleWire = encodeExecutionSessionRef({ ...coordinator.ref, sessionId: SUCCESSOR_ID });
    const stale = runCli(
      ["plan", "show", "--session-ref", staleWire, "--plan", PLAN_ID, "--harness", fixture.harnessDir, "--json"],
      fixture,
      foreign,
    );
    expect(stale.exitCode).toBe(1);
    expect(String(jsonOf(stale).code)).toMatch(/^(coordination|execution)\./);
  });
});

describe("mstar session recover \u2014 documented invocation", () => {
  test("replaces a stopped coordinator under an independently acquired identity", async () => {
    const fixture = await activeFixture("mstar-session-recover");
    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, identity, initial.token);
    const tokens = await tokensOf(fixture);
    const coordinator = activeBind(fixture, identity, ["--coordinator"], tokens.workflow, "bind-coordinator");

    const attestationPath = join(fixture.root, "attestation.json");
    writeJson(attestationPath, attestationFor(COORDINATOR_ID));
    const successor: ExecutionIdentity = { ...coordinatorIdentity(), sessionId: SUCCESSOR_ID };
    const afterBind = await tokensOf(fixture);
    const recovered = runCli(
      [
        "session",
        "recover",
        "--workflow",
        WORKFLOW_ID,
        "--prior-session",
        COORDINATOR_ID,
        "--reason",
        "the recorded coordinator stopped",
        "--attestation",
        attestationPath,
        "--expect",
        afterBind.workflow,
        "--operation",
        "recover-1",
        "--harness",
        fixture.harnessDir,
        "--json",
      ],
      fixture,
      successor,
    );
    expect(recovered.exitCode).toBe(0);
    expect(jsonOf(recovered).route).toBe("execution");
    expect(jsonOf(recovered).operation).toBe("recover");
    expect(String(dataOf(recovered).sessionId)).toBe(SUCCESSOR_ID);
    expect(coordinator.ref.sessionId).toBe(COORDINATOR_ID);

    // The store now holds the successor.
    const workflow = await workflowStateOf(fixture);
    expect(workflow.coordinator?.sessionId).toBe(SUCCESSOR_ID);

    // Recovery without a named holder must be explicit (never guessed).
    const guessed = runCli(
      [
        "session",
        "recover",
        "--workflow",
        WORKFLOW_ID,
        "--reason",
        "guessing",
        "--attestation",
        attestationPath,
        "--expect",
        afterBind.workflow,
        "--operation",
        "recover-2",
        "--harness",
        fixture.harnessDir,
      ],
      fixture,
      successor,
    );
    expect(guessed.exitCode).toBe(2);
    expect(guessed.stderr).toContain("--unowned");
  });
});

describe("mstar status validate \u2014 tokens of the active register", () => {
  test("reports the root and per-workflow tokens the active writes expect", async () => {
    const fixture = await activeFixture("mstar-session-tokens");
    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, identity, initial.token);

    const validated = runCli(["status", "validate"], fixture);
    expect(validated.exitCode).toBe(0);
    const tokens = await tokensOf(fixture);
    expect(validated.stdout).toContain(`root token: ${tokens.root}`);
    expect(validated.stdout).toContain(`workflow ${WORKFLOW_ID} token: ${tokens.workflow}`);
  });
});
