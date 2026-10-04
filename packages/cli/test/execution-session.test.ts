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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { executeCommand } from "@mstar-harness/commands";
import {
  encodeExecutionSessionRef,
  getCatalog,
  initializeExecutionAuthority,
  initializeStore,
  openStore,
  readExecutionAuthority,
  serializeExecutionValue,
  type ExecutionIdentity,
  type ExecutionPlanView,
  type ExecutionSessionRef,
  type ExecutionState,
  type StoreContext,
} from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = process.env.MSTAR_CLI_ENTRY ?? join(CLI_ROOT, "src/index.ts");

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
function assignmentText(input: {
  harnessDir: string;
  planMarkdown: string;
  worktreePath: string;
  sddDir: string;
  workingBranch?: string;
  workflowId?: string;
  planId?: string;
}): string {
  const planId = input.planId ?? PLAN_ID;
  return [
    `# Assignment \u2014 ${planId}`,
    "",
    `**Control harness root**: ${input.harnessDir}`,
    `**Workflow id**: ${input.workflowId ?? WORKFLOW_ID}`,
    `**Plan id**: ${planId}`,
    `**Plan Path**: ${input.planMarkdown}`,
    `**Worktree Path**: ${input.worktreePath}`,
    `**Working branch**: ${input.workingBranch ?? "feature/exec-session"}`,
    `**SDD dir**: ${input.sddDir}`,
    "**Execute as**: project-manager",
    "**Execution scope**: plan",
    "**Delegation**: allowed (plan-local subagents only)",
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
  const requiresSessionContext = args[0] === "workflow" || args[0] === "plan" ||
    (args[0] === "session" && args[1] === "recover");
  const withSession = identity !== undefined && requiresSessionContext && !args.includes("--session-id")
    ? [...args, "--session-id", identity.sessionId]
    : args;
  return spawnCli(withSession, fixture, cliEnv(fixture, identity));
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

/** One value read by name from a parsed envelope object, without a cast. */
function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
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
  writeText(planMarkdown, `# Execution session transport plan\n\n**plan_id:** ${PLAN_ID}\n`);
  writeText(evidencePath, "# evidence\n");
  mkdirSync(worktreePath, { recursive: true });
  const assignmentPath = join(sddDir, "assignment.md");
  writeText(assignmentPath, assignmentText({ harnessDir, planMarkdown, worktreePath, sddDir }));
  return { root, harnessDir, context, planMarkdown, assignmentPath, worktreePath, sddDir, evidencePath };
}

/** A temp Git workspace with an initialized store and the file route still active. */
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

  const planMarkdown = join(harnessDir, "plans", `${PLAN_ID}.md`);
  const sddDir = join(harnessDir, "sdd", PLAN_ID);
  const worktreePath = join(root, "wt-exec-session");
  const evidencePath = join(sddDir, "evidence.md");
  writeText(planMarkdown, `# Execution session transport plan\n\n**plan_id:** ${PLAN_ID}\n`);
  writeText(evidencePath, "# evidence\n");
  writeJson(join(harnessDir, "status.json"), { version: 2, updated_at: "2026-09-21", workflows: [] });
  mkdirSync(worktreePath, { recursive: true });
  const assignmentPath = join(sddDir, "assignment.md");
  writeText(assignmentPath, assignmentText({ harnessDir, planMarkdown, worktreePath, sddDir }));
  return { root, harnessDir, context, planMarkdown, assignmentPath, worktreePath, sddDir, evidencePath };
}

/** Register the workflow through the ACTIVE registration route (the real producer chain). */
function registerThroughAuthority(fixture: Fixture, identity: ExecutionIdentity, rootToken: string, planFile = `plans/${PLAN_ID}.md`): void {
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
      planFile,
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
    ],
    fixture,
    identity,
  );
  expect(registered.exitCode).toBe(0);
  expect(jsonOf(registered).command).toBe("workflow.register");
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
    ],
    fixture,
    identity,
  );
  expect(result.exitCode).toBe(0);
  expect(jsonOf(result).command).toBe("plan.bind");
  const ref = dataOf(result).data as unknown as ExecutionSessionRef;
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

/**
 * The full active plan chain of one fixture: register, bind the coordinator,
 * prepare the row through the DB route (no session file) and bind the plan-pm
 * that claims the prepared row's execution lease.
 */
async function preparePlanSeat(
  fixture: Fixture,
  planPmId = PLAN_PM_ID,
): Promise<{ coordinator: ExecutionSessionRef; coordinatorWire: string; planPmWire: string; planPmRef: ExecutionSessionRef }> {
  const identity = coordinatorIdentity();
  const initial = await readExecutionAuthority(fixture.context);
  registerThroughAuthority(fixture, identity, initial.token);

  // The tokens the active writes consume come from a read of THIS store.
  const beforeBind = await tokensOf(fixture);
  const coordinator = activeBind(fixture, identity, ["--coordinator"], beforeBind.workflow, "bind-coordinator");

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
    ],
    fixture,
    identity,
  );
  expect(prepared.exitCode).toBe(0);
  expect(jsonOf(prepared).command).toBe("plan.prepare");

  // The plan-pm seat claims the prepared row with its own acquired identity.
  const afterPrepare = await tokensOf(fixture);
  const planPm = activeBind(fixture, planPmIdentity(planPmId), ["--plan", PLAN_ID], afterPrepare.plan, "bind-plan-pm");
  expect(planPm.ref.role).toBe("plan-pm");
  expect(planPm.ref.planId).toBe(PLAN_ID);
  expect(planPm.ref.sessionId).toBe(planPmId);
  return { coordinator: coordinator.ref, coordinatorWire: coordinator.wire, planPmWire: planPm.wire, planPmRef: planPm.ref };
}

describe("mstar session run — documented invocation", () => {
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
    const identity = JSON.parse(String((jsonOf(child).details as { stdout: string }).stdout)) as ExecutionIdentity;
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
    expect(killed.exitCode).toBe(143);
    expect((jsonOf(killed).details as { signal: string }).signal).toBe("SIGTERM");

    const mixed = runCli(
      ["session", "run", "--workflow", WORKFLOW_ID, "--role", "coordinator", "--plan", PLAN_ID, "--", "true"],
      fixture,
    );
    expect(jsonOf(mixed).code).toBe("command.invalid-input");
    expect(String(jsonOf(mixed).message)).toContain("--plan");
  });

  test("binds, resumes and mutates in a temporary DB, and a retry replays the same receipt", async () => {
    const fixture = await activeFixture("mstar-session-chain");
    const { planPmWire, planPmRef } = await preparePlanSeat(fixture);
    expect(planPmRef.sessionId).toBe(PLAN_PM_ID);

    // The session-authorized view of that binding, and the documented resume.
    const view = runCli(
      ["plan", "show", "--session-ref", planPmWire, "--plan", PLAN_ID, "--harness", fixture.harnessDir],
      fixture,
      planPmIdentity(),
    );
    expect(view.exitCode).toBe(0);
    expect(jsonOf(view).command).toBe("plan.show");
    expect((dataOf(view).data as { plan: { id: string } }).plan.id).toBe(PLAN_ID);

    const resumed = runCli(
      ["plan", "bind", "--execution", "--resume-ref", planPmWire],
      fixture,
      planPmIdentity(),
    );
    expect(resumed.exitCode).toBe(0);
    expect(jsonOf(resumed).command).toBe("plan.bind");
    // A resume returns the same reference, without an operation receipt.
    expect(dataOf(resumed).operationId).toBeUndefined();
    expect(dataOf(resumed).replayed).toBeUndefined();
    expect(String((dataOf(resumed).data as ExecutionSessionRef).sessionId)).toBe(PLAN_PM_ID);

    // One plan mutation through the active transport, then its exact retry.
    const progressPath = join(fixture.root, "progress.json");
    writeJson(progressPath, { status: "InReview", summary: "handoff prepared", evidence_paths: [fixture.evidencePath] });
    const beforeMutation = await tokensOf(fixture);
    const progressArgs = [
      "plan",
      "progress",
      "--session-ref",
      planPmWire,
      "--file",
      progressPath,
      "--expect",
      beforeMutation.plan,
      "--operation",
      "progress-1",
      "--harness",
      fixture.harnessDir,
    ];
    const progressed = runCli(progressArgs, fixture, planPmIdentity());
    expect(progressed.exitCode).toBe(0);
    expect(jsonOf(progressed).command).toBe("plan.progress");
    expect(dataOf(progressed).replayed).toBe(false);
    expect((dataOf(progressed).data as { plan: unknown }).plan).toMatchObject({ id: PLAN_ID, status: "InReview" });
    const retried = runCli(progressArgs, fixture, planPmIdentity());
    expect(retried.exitCode).toBe(0);
    expect(dataOf(retried).replayed).toBe(true);

    // The authority itself holds the mutation (the CLI's claim is not the proof).
    const stored = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
    if (!("plan" in stored.data)) throw new Error("the plan read did not return a plan view");
    const planView: ExecutionPlanView = stored.data;
    expect(planView.plan.status).toBe("InReview");
  });
});

/** The full public `workflow register` argv the active route requires. */
function registerArgs(fixture: Fixture, rootToken: string, operationId: string, extra: string[] = []): string[] {
  return [
    "workflow", "register",
    "--workflow", WORKFLOW_ID,
    "--plan-id", PLAN_ID,
    "--plan-title", "Execution session transport plan",
    "--plan-file", `plans/${PLAN_ID}.md`,
    "--delivery-kind", "development",
    "--branch-source", "feature/exec-session",
    "--branch-target", "main",
    "--expect", rootToken,
    "--operation", operationId,
    "--harness", fixture.harnessDir,
    ...extra,
  ];
}

/** The CLI child argv a `session run` launch executes inside the fixture. */
function registerArgv(fixture: Fixture, rootToken: string, operationId: string): string[] {
  return [process.execPath, "run", SRC_ENTRY, ...registerArgs(fixture, rootToken, operationId)];
}

/** The minted identity a `session run` receipt discloses for its one launch. */
function mintedOf(launch: RunResult): ExecutionIdentity {
  const identity = fieldOf(dataOf(launch), "identity");
  if (identity === null || typeof identity !== "object") throw new Error(`no minted identity in the launch receipt: ${launch.stdout}`);
  // The receipt is this adapter's own output: its identity member is the §3.1
  // tuple the launcher minted, so it is read as that named type.
  return identity as ExecutionIdentity;
}

/**
 * The minted-local-identity transport. `session.run` mints one local identity,
 * overwrites the identity channel and deletes the legacy one; these cases pin
 * that a launched child actually consumes that channel against the real active
 * authority — precedence, the ambient fallback, cross-scope refusal, and the
 * launch/register/bind chain under ONE acquired identity.
 */
describe("mstar session run — minted identity transport", () => {
  test("a launched child consumes its minted identity through register, and that same identity binds", async () => {
    const fixture = await activeFixture("mstar-minted-launch");
    const rootToken = (await readExecutionAuthority(fixture.context)).token;

    // The launch writes no binding itself; the child CLI (register) runs with
    // ONLY the minted channel — `session.run` deleted MSTAR_HOST_SESSION_ID.
    const launched = runCli(
      ["session", "run", "--workflow", WORKFLOW_ID, "--role", "coordinator", "--harness", fixture.harnessDir,
        "--", ...registerArgv(fixture, rootToken, "register-minted")],
      fixture,
    );
    expect(launched.exitCode).toBe(0);
    const identity = mintedOf(launched);
    expect(identity.source).toBe("local");
    expect(identity.workflowId).toBe(WORKFLOW_ID);
    expect(identity.role).toBe("coordinator");

    // The child's own stdout is the register success of that minted identity.
    const childStdout = JSON.parse(String(dataOf(launched).stdout).trim()) as Record<string, unknown>;
    expect(childStdout).toMatchObject({ command: "workflow.register", status: "ok" });

    // The SAME acquired identity is the workflow's creator, so its first bind
    // succeeds — through the minted channel itself, with no --session-id.
    const workflowToken = (await tokensOf(fixture)).workflow;
    const bound = spawnCli(
      ["plan", "bind", "--execution", "--workflow", WORKFLOW_ID, "--coordinator",
        "--expect", workflowToken, "--operation", "bind-minted", "--harness", fixture.harnessDir],
      fixture,
      { ...cliEnv(fixture, identity) },
    );
    expect(bound.exitCode).toBe(0);
    expect(jsonOf(bound).command).toBe("plan.bind");

    // The authority itself holds the coordinator row under that minted session.
    const workflow = await workflowStateOf(fixture);
    expect(workflow.coordinator?.sessionId).toBe(identity.sessionId);
  });

  test("a minted identity never authorizes a scope it does not declare", async () => {
    const fixture = await activeFixture("mstar-minted-scope");
    const foreign = { source: "local" as const, sessionId: "minted-foreign", workflowId: "wf-somewhere-else", role: "coordinator" as const, planId: null };
    const rootToken = (await readExecutionAuthority(fixture.context)).token;
    const refused = spawnCli(
      registerArgs(fixture, rootToken, "register-scope"),
      fixture,
      { ...cliEnv(fixture), MSTAR_EXECUTION_IDENTITY: serializeExecutionValue(foreign) },
    );
    // The complete request reaches the identity/scope gate, which refuses before
    // any write with its own typed cause (not a missing-field usage).
    expect(refused.exitCode).toBe(2);
    expect(jsonOf(refused).code).toBe("command.invalid-input");
    expect(fieldOf(jsonOf(refused), "details")).toMatchObject({ identity: { code: "command.identity-scope-mismatch" } });
    // No register happened: the root register still holds no workflow.
    const state = await readExecutionAuthority(fixture.context);
    expect("workflows" in state.data ? state.data.workflows.length : -1).toBe(0);
  });

  test("an active registration refuses a same-workflow identity addressing the wrong seat", async () => {
    const fixture = await activeFixture("mstar-minted-seat");
    const rootToken = (await readExecutionAuthority(fixture.context)).token;
    // A complete, otherwise-valid registration whose minted identity addresses the
    // SAME workflow but the plan-pm seat: registration's caller seat is the
    // coordinator, so this is refused before any mutation.
    const planPm = { source: "local" as const, sessionId: "minted-plan-pm", workflowId: WORKFLOW_ID, role: "plan-pm" as const, planId: PLAN_ID };
    const refused = spawnCli(
      registerArgs(fixture, rootToken, "register-wrong-seat"),
      fixture,
      { ...cliEnv(fixture), MSTAR_EXECUTION_IDENTITY: serializeExecutionValue(planPm) },
    );
    expect(refused.exitCode).toBe(2);
    expect(jsonOf(refused).code).toBe("command.invalid-input");
    expect(fieldOf(jsonOf(refused), "details")).toMatchObject({ identity: { code: "command.identity-scope-mismatch" } });
    // Nothing was written: no workflow row and no catalog plan entity.
    const state = await readExecutionAuthority(fixture.context);
    expect("workflows" in state.data ? state.data.workflows.length : -1).toBe(0);
    await expect(getCatalog(fixture.context, { kind: "plan", id: PLAN_ID })).rejects.toThrow();
  });

  test("a malformed minted transport refuses before any write instead of falling back", async () => {
    const fixture = await activeFixture("mstar-minted-malformed");
    const rootToken = (await readExecutionAuthority(fixture.context)).token;
    for (const malformed of ["not-json", "[]", serializeExecutionValue({ source: "local", sessionId: "", workflowId: WORKFLOW_ID, role: "coordinator", planId: null })]) {
      const refused = spawnCli(
        registerArgs(fixture, rootToken, "register-malformed"),
        fixture,
        { ...cliEnv(fixture), MSTAR_EXECUTION_IDENTITY: malformed, MSTAR_HOST_SESSION_ID: "ambient-must-not-substitute" },
      );
      // The complete request still refuses on the malformed transport alone, and
      // the ambient host value never substitutes for it.
      expect(`${malformed} -> ${refused.exitCode}`).toBe(`${malformed} -> 2`);
      expect(jsonOf(refused).code).toBe("command.invalid-input");
      const cause = fieldOf(fieldOf(jsonOf(refused), "details"), "identity");
      expect(String(fieldOf(cause, "code"))).toMatch(/^(command\.invalid-identity|coordination\.)/);
    }
    const state = await readExecutionAuthority(fixture.context);
    expect("workflows" in state.data ? state.data.workflows.length : -1).toBe(0);
  });

  test("with no minted identity the ambient host value is the fallback, and both absent is a usage refusal", async () => {
    const fixture = await activeFixture("mstar-minted-ambient");
    const rootToken = (await readExecutionAuthority(fixture.context)).token;

    const ambient = spawnCli(
      registerArgs(fixture, rootToken, "register-ambient"),
      fixture,
      { ...cliEnv(fixture), MSTAR_HOST_SESSION_ID: "ambient-host-session" },
    );
    expect(ambient.exitCode).toBe(0);
    expect(jsonOf(ambient).command).toBe("workflow.register");

    const second = await activeFixture("mstar-minted-absent");
    const secondToken = (await readExecutionAuthority(second.context)).token;
    const absent = spawnCli(
      registerArgs(second, secondToken, "register-absent"),
      second,
      cliEnv(second),
    );
    // A complete active registration with neither identity channel refuses on
    // the missing identity, not on any other field.
    expect(absent.exitCode).toBe(2);
    expect(String(jsonOf(absent).code)).toBe("command.invalid-input");
    const state = await readExecutionAuthority(second.context);
    expect("workflows" in state.data ? state.data.workflows.length : -1).toBe(0);
  });

  test("an explicit --session-id overrides the minted identity", async () => {
    const fixture = await activeFixture("mstar-minted-flag-wins");
    const rootToken = (await readExecutionAuthority(fixture.context)).token;
    const minted = { source: "local" as const, sessionId: "minted-loses", workflowId: WORKFLOW_ID, role: "coordinator" as const, planId: null };
    const registered = spawnCli(
      registerArgs(fixture, rootToken, "register-flag-wins", ["--session-id", "explicit-wins"]),
      fixture,
      { ...cliEnv(fixture), MSTAR_EXECUTION_IDENTITY: serializeExecutionValue(minted) },
    );
    expect(registered.exitCode).toBe(0);
    // The explicit identity is the creator, so only it binds first.
    const workflowToken = (await tokensOf(fixture)).workflow;
    const byFlag = runCli(
      ["plan", "bind", "--execution", "--workflow", WORKFLOW_ID, "--coordinator", "--expect", workflowToken,
        "--operation", "bind-flag", "--harness", fixture.harnessDir, "--session-id", "explicit-wins"],
      fixture,
    );
    expect(byFlag.exitCode).toBe(0);
    // …and the overridden minted identity cannot take the held scope: the same
    // bind through the minted channel alone is refused by the creator fence.
    const byMinted = spawnCli(
      ["plan", "bind", "--execution", "--workflow", WORKFLOW_ID, "--coordinator",
        "--expect", (await tokensOf(fixture)).workflow, "--operation", "bind-minted-loses", "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, minted),
    );
    expect(byMinted.exitCode).toBe(1);
    expect(String(jsonOf(byMinted).code)).toMatch(/^(coordination|execution)\./);
  });
});

describe("mstar plan \u2014 identity channel", () => {
  test("a missing runtime session identity refuses before any write (exit 2)", async () => {
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
    ];

    const absent = runCli(bindArgs, fixture);
    expect(absent.exitCode).toBe(2);
    expect(jsonOf(absent).code).toBe("command.invalid-input");

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
    expect(jsonOf(mixedSession).code).toBe("command.invalid-input");
    expect(String(jsonOf(mixedSession).message)).toContain("disjoint");

    const progressJson = join(fixture.root, "numeric-progress.json");
    writeJson(progressJson, { status: "InReview", summary: "numeric-token-check", evidence_paths: [fixture.evidencePath] });
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
        progressJson,
      ],
      fixture,
      identity,
    );
    expect(jsonOf(numeric).code).toBe("command.invalid-input");
    expect(String(jsonOf(numeric).message)).toContain("full execution token");

    const stated = runCli(
      [
        "plan", "bind", "--execution", "--workflow", WORKFLOW_ID, "--coordinator",
        "--session-id", PLAN_PM_ID, "--expect", tokens.workflow, "--operation", "bind-unacquired",
        "--harness", fixture.harnessDir,
      ],
      fixture,
      identity,
    );
    expect(stated.exitCode).toBe(1);
    expect(String(jsonOf(stated).code)).toMatch(/^execution\./);

    const resumeMix = runCli(
      ["plan", "bind", "--execution", "--resume-ref", `${WIRE_PREFIX}AAAA`, "--resume", "/tmp/x.json"],
      fixture,
      identity,
    );
    expect(jsonOf(resumeMix).code).toBe("execution.canonical-value");
  });

  test("a copied reference under another acquired identity cannot write", async () => {
    const fixture = await activeFixture("mstar-session-copied");
    const { planPmWire, planPmRef } = await preparePlanSeat(fixture);
    const progressPath = join(fixture.root, "progress.json");
    writeJson(progressPath, { status: "InReview", summary: "copied", evidence_paths: [fixture.evidencePath] });
    const before = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
    const beforeToken = before.token;

    // The same wire under a DIFFERENT independently acquired identity is not
    // that session: the engine compares the caller inside its own transaction,
    // so the copy cannot write even though its reference is a real one.
    const otherPlanPm = planPmIdentity("planpm-exec-session-other");
    const copied = runCli(
      [
        "plan",
        "progress",
        "--session-ref",
        planPmWire,
        "--file",
        progressPath,
        "--expect",
        beforeToken,
        "--operation",
        "progress-copied",
        "--harness",
        fixture.harnessDir,
      ],
      fixture,
      otherPlanPm,
    );
    expect(copied.exitCode).toBe(1);
    expect(String(jsonOf(copied).code)).toMatch(/^(coordination|execution)\./);

    // A reference the store does not hold is refused even when the explicit
    // plan selector is present.
    const staleWire = encodeExecutionSessionRef({ ...planPmRef, sessionId: "planpm-exec-session-unheld" });
    const stale = runCli(
      ["plan", "show", "--session-ref", staleWire, "--plan", PLAN_ID, "--harness", fixture.harnessDir],
      fixture,
      planPmIdentity("planpm-exec-session-unheld"),
    );
    expect(stale.exitCode).toBe(1);
    expect(String(jsonOf(stale).code)).toMatch(/^(coordination|execution)\./);

    // Neither refusal wrote: the row still carries the token this call read.
    const after = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
    expect(after.token).toBe(beforeToken);
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
      ],
      fixture,
      successor,
    );
    expect(recovered.exitCode).toBe(0);
    expect(jsonOf(recovered).command).toBe("session.recover");
    expect((dataOf(recovered).data as ExecutionSessionRef).sessionId).toBe(SUCCESSOR_ID);
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
  });
});

describe("mstar session recover — named plan owner", () => {
  test("recovers plan ownership into the current coordinator's independent identity", async () => {
    const fixture = await activeFixture("mstar-plan-session-recover");
    const coordinator = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, coordinator, initial.token);
    const beforeBind = await tokensOf(fixture);
    activeBind(fixture, coordinator, ["--coordinator"], beforeBind.workflow, "bind-coordinator");
    const prepared = runCli(
      ["plan", "prepare", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--assignment", fixture.assignmentPath, "--harness", fixture.harnessDir],
      fixture,
      coordinator,
    );
    expect(prepared.exitCode).toBe(0);
    const afterPrepare = await tokensOf(fixture);
    activeBind(fixture, planPmIdentity(), ["--plan", PLAN_ID], afterPrepare.plan, "bind-plan-pm");
    const attestationPath = join(fixture.root, "plan-owner-attestation.json");
    writeJson(attestationPath, attestationFor(PLAN_PM_ID));
    const recovered = runCli(
      ["session", "recover", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--prior-session", PLAN_PM_ID,
        "--reason", "the recorded plan owner stopped", "--attestation", attestationPath,
        "--expect", afterPrepare.plan, "--operation", "recover-plan-owner", "--harness", fixture.harnessDir],
      fixture,
      coordinator,
    );
    expect(recovered.exitCode).toBe(0);
    expect(dataOf(recovered).data).toMatchObject({ role: "plan-pm", sessionId: COORDINATOR_ID, planId: PLAN_ID });
    expect((await storedLease(fixture))?.holder_session_id).toBe(COORDINATOR_ID);
    const progressPath = join(fixture.root, "old-owner-progress.json");
    writeJson(progressPath, { status: "InProgress", summary: "stale owner attempt", evidence_paths: [fixture.evidencePath] });
    const oldOwner = runCli(
      ["plan", "progress", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--file", progressPath, "--harness", fixture.harnessDir],
      fixture,
      planPmIdentity(),
    );
    expect(oldOwner.exitCode).toBe(1);
    expect((await storedLease(fixture))?.holder_session_id).toBe(COORDINATOR_ID);
  }, 30_000);
  test("uses the recovered plan-PM binding for reviewed handoff, accept and completion", async () => {
    const fixture = await activeDeliveryFixture("mstar-recovered-plan-delivery");
    const coordinator = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, coordinator, initial.token);
    const beforeBind = await tokensOf(fixture);
    activeBind(fixture, coordinator, ["--coordinator"], beforeBind.workflow, "bind-coordinator");
    const prepared = runCli(
      ["plan", "prepare", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--assignment", fixture.assignmentPath, "--harness", fixture.harnessDir],
      fixture,
      coordinator,
    );
    expect(prepared.exitCode).toBe(0);
    const afterPrepare = await tokensOf(fixture);
    activeBind(fixture, planPmIdentity(), ["--plan", PLAN_ID], afterPrepare.plan, "bind-plan-pm");

    const attestationPath = join(fixture.root, "plan-owner-attestation.json");
    writeJson(attestationPath, attestationFor(PLAN_PM_ID));
    const recovered = runCli(
      ["session", "recover", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--prior-session", PLAN_PM_ID,
        "--reason", "the recorded plan owner stopped", "--attestation", attestationPath,
        "--expect", afterPrepare.plan, "--operation", "recover-plan-owner-lifecycle", "--harness", fixture.harnessDir],
      fixture,
      coordinator,
    );
    expect(recovered.exitCode).toBe(0);
    const newPlanOwner = planPmIdentity(COORDINATOR_ID);
    expect(dataOf(recovered).data).toMatchObject({ role: "plan-pm", sessionId: newPlanOwner.sessionId, planId: PLAN_ID });
    expect((await storedLease(fixture))?.holder_session_id).toBe(newPlanOwner.sessionId);

    const progressPath = join(fixture.root, "recovered-progress.json");
    writeJson(progressPath, { status: "InReview", summary: "reviewed delivery ready", evidence_paths: [fixture.qaReport] });
    const progressed = runCli(["plan", "progress", "--file", progressPath, "--harness", fixture.harnessDir], fixture, newPlanOwner);
    expect(progressed.exitCode).toBe(0);
    const handoffPath = join(fixture.root, "recovered-handoff.json");
    writeJson(handoffPath, {
      source_sha: fixture.sourceSha,
      review_base: fixture.baseSha,
      review_head: fixture.sourceSha,
      qc: { decision: "Approve", reports: [fixture.qcReport], consolidated: fixture.qcConsolidated },
      qa: { gate: "mandatory", decision: "pass", report: fixture.qaReport },
    });
    const handed = runCli(["plan", "handoff", "--file", handoffPath, "--harness", fixture.harnessDir], fixture, newPlanOwner);
    expect(handed.exitCode).toBe(0);
    const handoffId = handoffIdOf(handed);
    const accepted = runCli(
      ["plan", "accept", "--coordinator", "--plan", PLAN_ID, "--handoff", handoffId, "--harness", fixture.harnessDir],
      fixture,
      coordinator,
    );
    expect(accepted.exitCode).toBe(0);
    const completed = runCli(
      ["plan", "complete", "--coordinator", "--plan", PLAN_ID, "--handoff", handoffId, "--harness", fixture.harnessDir],
      fixture,
      coordinator,
    );
    expect(completed.exitCode).toBe(0);
    expect(await storedRowStatus(fixture)).toBe("Done");
  }, 30_000);

  test("rejects coordinator-only unowned selection for plan recovery before changing the claim", async () => {
    const fixture = await activeFixture("mstar-plan-session-recover-unowned");
    const coordinator = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, coordinator, initial.token);
    const tokens = await tokensOf(fixture);
    activeBind(fixture, coordinator, ["--coordinator"], tokens.workflow, "bind-coordinator");
    const prepared = runCli(
      ["plan", "prepare", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--assignment", fixture.assignmentPath, "--harness", fixture.harnessDir],
      fixture,
      coordinator,
    );
    expect(prepared.exitCode).toBe(0);
    const afterPrepare = await tokensOf(fixture);
    activeBind(fixture, planPmIdentity(), ["--plan", PLAN_ID], afterPrepare.plan, "bind-plan-pm");
    const attestationPath = join(fixture.root, "attestation.json");
    writeJson(attestationPath, attestationFor(PLAN_PM_ID));
    const refused = runCli(
      ["session", "recover", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--unowned",
        "--reason", "must name prior plan owner", "--attestation", attestationPath,
        "--expect", afterPrepare.plan, "--operation", "invalid-unowned-plan", "--harness", fixture.harnessDir],
      fixture,
      coordinator,
    );
    expect(refused.exitCode).toBe(2);
    expect((await storedLease(fixture))?.holder_session_id).toBe(PLAN_PM_ID);
  }, 30_000);
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
    const data = dataOf(validated);
    expect(data.token).toBe(tokens.root);
    expect(data.state).toBe("active");
    const rows = data.workflows as Array<{ token: string }>;
    expect(rows[0]?.token).toBe(tokens.workflow);
  });
});
  
describe("mstar status validate — disclosed authority state", () => {
  test("reports active additively and legacy with the single upgrade entry", async () => {
    const legacy = await legacyFixture("mstar-session-legacy-state");
    const legacyResult = runCli(["status", "validate"], legacy);
    expect(legacyResult.exitCode, legacyResult.stderr).toBe(0);
    expect(dataOf(legacyResult)).toMatchObject({
      path: join(legacy.harnessDir, "status.json"),
      violations: [],
      state: "legacy",
      upgrade: { entry: "mstar store safe-upgrade" },
    });
    const legacyWithoutStore = await legacyFixture("mstar-session-legacy-without-store");
    rmSync(join(legacyWithoutStore.harnessDir, "store.db"));
    writeJson(join(legacyWithoutStore.harnessDir, "status.json"), {
      version: 2,
      updated_at: "2026-09-21",
      workflows: [{ id: "wf-registered", type: "iteration", status: "running", started_at: "2026-09-21T00:00:00Z", dir: "workflows/wf-registered" }],
    });
    const legacyWithoutStoreResult = runCli(["status", "validate"], legacyWithoutStore);
    expect(legacyWithoutStoreResult.exitCode).toBe(1);
    expect(jsonOf(legacyWithoutStoreResult)).toMatchObject({
      code: "status.workflow.snapshot-missing",
      details: {
        state: "legacy",
        upgrade: { entry: "mstar store init → mstar store safe-upgrade" },
      },
    });
    const missing = await legacyFixture("mstar-session-missing-status");
    rmSync(join(missing.harnessDir, "status.json"));
    const missingResult = runCli(["status", "validate"], missing);
    expect(missingResult.exitCode).toBe(1);
    expect(jsonOf(missingResult)).toMatchObject({
      details: {
        state: "legacy",
        upgrade: { entry: "mstar store safe-upgrade" },
        selfCheck: {
          couldNotRead: "legacy status register is missing",
          recovery: expect.stringContaining("legacy upgrade path exists"),
        },
      },
    });
    const empty = await legacyFixture("mstar-session-empty-harness");
    rmSync(join(empty.harnessDir, "status.json"));
    rmSync(join(empty.harnessDir, "store.db"));
    const emptyResult = runCli(["status", "validate"], empty);
    expect(emptyResult.exitCode).toBe(1);
    expect(jsonOf(emptyResult)).toMatchObject({
      code: "status.file-not-found",
      details: {
        state: "legacy",
        upgrade: { entry: "mstar harness scaffold" },
        selfCheck: { recovery: expect.stringContaining("run mstar harness scaffold") },
      },
    });
    const scaffoldResult = runCli(["harness", "scaffold"], empty);
    expect(scaffoldResult.exitCode).toBe(0);
    expect(jsonOf(scaffoldResult).code).toBe("harness.scaffold.ok");

    const active = await activeFixture("mstar-session-active-state");
    const initial = await readExecutionAuthority(active.context);
    registerThroughAuthority(active, coordinatorIdentity(), initial.token);
    const activeResult = runCli(["status", "validate"], active);
    expect(activeResult.exitCode).toBe(0);
    const activeData = dataOf(activeResult);
    expect(activeData.state).toBe("active");
    expect(activeData.token).toBe((await tokensOf(active)).root);
    expect((activeData.workflows as Array<{ token: string }>)[0]?.token).toBe((await tokensOf(active)).workflow);
  });
  test("refuses an unreadable authority store with its typed cause and actionable self-check", async () => {
    const fixture = await legacyFixture("mstar-session-unreadable-state");
    rmSync(join(fixture.harnessDir, "store.db"));
    mkdirSync(join(fixture.harnessDir, "store.db"));
    const result = runCli(["status", "validate"], fixture);
    const envelope = jsonOf(result);
    expect(result.exitCode).toBe(1);
    expect(envelope.status).toBe("refused");
    expect(envelope.code).toBe("store.corrupt");
    expect(envelope.message).toContain("Self-check recovery:");
    expect(envelope.message).toContain("not a readable regular store file");
    expect(envelope.details).toMatchObject({
      state: "unreadable",
      selfCheck: {
        couldNotRead: expect.stringContaining("not a readable regular store file"),
        recovery: expect.stringContaining("Preserve the corrupt database and legacy sources"),
      },
    });
  });
});

describe("workflow.register — catalog plan paths", () => {
  test.each([
    ["harness-relative", false],
    ["canonical-absolute", true],
  ])("%s registration stores the plans-root-relative document and prepares successfully", async (label, canonicalAbsolute) => {
    const fixture = await activeFixture(`mstar-register-plan-path-${label}`);
    const planFile = canonicalAbsolute ? fixture.planMarkdown : `plans/${PLAN_ID}.md`;
    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);

    registerThroughAuthority(fixture, identity, initial.token, planFile);

    const entity = (await getCatalog(fixture.context, { kind: "plan", id: PLAN_ID })).entity;
    expect(entity.relativePath).toBe(`${PLAN_ID}.md`);
    const storedPlanFile = join(fixture.harnessDir, "plans", entity.relativePath);
    expect(storedPlanFile).toBe(fixture.planMarkdown);
    expect(readFileSync(storedPlanFile, "utf8")).toContain(`**plan_id:** ${PLAN_ID}`);

    const tokens = await tokensOf(fixture);
    const coordinator = activeBind(fixture, identity, ["--coordinator"], tokens.workflow, "bind-coordinator");
    const prepared = runCli(
      [
        "plan", "prepare", "--session-ref", coordinator.wire, "--plan", PLAN_ID,
        "--assignment", fixture.assignmentPath, "--expect", tokens.plan,
        "--operation", "prepare-registered-path", "--harness", fixture.harnessDir,
      ],
      fixture,
      identity,
    );
    expect(prepared.exitCode).toBe(0);
    expect(jsonOf(prepared).command).toBe("plan.prepare");
  });
  test("canonical absolute registration uses the configured plans root", async () => {
    const fixture = await activeFixture("mstar-register-configured-plans-root");
    writeText(join(fixture.harnessDir, ".mstarc"), "[config]\nplan_dir=custom-plans\n");
    fixture.planMarkdown = join(fixture.harnessDir, "custom-plans", `${PLAN_ID}.md`);
    writeText(fixture.planMarkdown, `# Execution session transport plan\n\n**plan_id:** ${PLAN_ID}\n`);
    writeText(fixture.assignmentPath, assignmentText({
      harnessDir: fixture.harnessDir,
      planMarkdown: fixture.planMarkdown,
      worktreePath: fixture.worktreePath,
      sddDir: fixture.sddDir,
    }));

    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, identity, initial.token, fixture.planMarkdown);

    const entity = (await getCatalog(fixture.context, { kind: "plan", id: PLAN_ID })).entity;
    expect(entity.relativePath).toBe(`${PLAN_ID}.md`);
    const storedPlanFile = join(fixture.harnessDir, "custom-plans", entity.relativePath);
    expect(storedPlanFile).toBe(fixture.planMarkdown);
    expect(readFileSync(storedPlanFile, "utf8")).toContain(`**plan_id:** ${PLAN_ID}`);

    const tokens = await tokensOf(fixture);
    const coordinator = activeBind(fixture, identity, ["--coordinator"], tokens.workflow, "bind-coordinator");
    const prepared = runCli(
      [
        "plan", "prepare", "--session-ref", coordinator.wire, "--plan", PLAN_ID,
        "--assignment", fixture.assignmentPath, "--expect", tokens.plan,
        "--operation", "prepare-configured-path", "--harness", fixture.harnessDir,
      ],
      fixture,
      identity,
    );
    expect(prepared.exitCode).toBe(0);
    expect(jsonOf(prepared).command).toBe("plan.prepare");
  });
});

describe("workflow.register — state-aware transport refusals", () => {
  test("legacy DB-route attempt gives the sole upgrade entry; active legacy-form attempt says upgrade is unnecessary", async () => {
    const legacy = await legacyFixture("mstar-session-legacy-refusal");
    const active = await activeFixture("mstar-session-active-refusal");
    const activeAuthority = await readExecutionAuthority(active.context);

    const legacyDb = join(legacy.harnessDir, "store.db");
    const legacyBefore = readFileSync(legacyDb);
    const legacyResult = runCli([
      "workflow", "register", "--workflow", "legacy-refusal",
      "--plan-id", PLAN_ID, "--plan-title", "Execution session transport plan",
      "--plan-file", `plans/${PLAN_ID}.md`, "--delivery-kind", "development",
      "--branch-source", "feature/refusal", "--branch-target", "main",
      "--expect", activeAuthority.token, "--operation", "legacy-refusal",
      "--harness", legacy.harnessDir,
    ], legacy, coordinatorIdentity());
    expect(legacyResult.exitCode).toBe(1);
    const legacyResponse = jsonOf(legacyResult);
    expect(legacyResponse.code).toBe("execution.not-active");
    expect(legacyResponse.message).toContain("state: legacy");
    expect(legacyResponse.message).toContain("mstar store safe-upgrade");
    expect(legacyResponse.message).not.toContain(activeAuthority.token);
    expect(readFileSync(legacyDb).equals(legacyBefore)).toBe(true);

    const activeDb = join(active.harnessDir, "store.db");
    const activeBefore = readFileSync(activeDb);
    const activeResult = runCli([
      "workflow", "register", "--workflow", "active-refusal",
      "--plan-id", PLAN_ID, "--plan-title", "Execution session transport plan",
      "--plan-file", `plans/${PLAN_ID}.md`, "--delivery-kind", "development",
      "--branch-source", "feature/refusal", "--branch-target", "main",
      "--harness", active.harnessDir,
    ], active, coordinatorIdentity());
    expect(activeResult.exitCode).toBe(1);
    const activeResponse = jsonOf(activeResult);
    expect(activeResponse.code).toBe("execution.consumer-not-ready");
    expect(activeResponse.message).toContain("state: active");
    expect(activeResponse.message).toContain("Upgrade outcome: not required");
    expect(activeResponse.message).toContain("active DB form");
    expect(readFileSync(activeDb).equals(activeBefore)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * ACTIVE public holder / delivery tail (T4b)
 *
 * These cases drive the ordinary sparse own-binding routes — no routine
 * `--session-ref`/`--expect`/`--operation` copying — against the SAME public
 * engine verbs and a real temporary ACTIVE authority. They cover the owned
 * release → explicit bind → repair/prepare/progress path and the independent
 * truthful stopped path (A6/A7), plus a successful development delivery that
 * completes, unregisters and passes the phase-6 projection (A4/A8). Every
 * mutation reads its authoritative state back through the engine, never from
 * the CLI's own claim.
 * ------------------------------------------------------------------------ */

/** The fixture root's HEAD as a commit id (the pinned review base). */
function headOf(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

/** Commit inside one checkout with a pinned fixture identity (no ambient config). */
function commitIn(cwd: string, message: string): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message], { cwd });
}

interface DeliveryFixture extends Fixture {
  /** The real feature checkout the standalone development completes from. */
  featurePath: string;
  sourceSha: string;
  baseSha: string;
  qcReport: string;
  qcConsolidated: string;
  qaReport: string;
}

/**
 * A temp Git workspace whose `.mstar` holds an ACTIVE authority and whose plan
 * worktree is a REAL feature checkout on `feature/exec-session` — the delivery
 * source the standalone development completion reads. The Assignment pins that
 * same worktree and branch, so `prepare` records the scope the tail completes
 * against.
 */
async function activeDeliveryFixture(label: string): Promise<DeliveryFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const context: StoreContext = { harnessDir };
  const store = await initializeStore(context);
  store.close();
  await initializeExecutionAuthority(context);
  const baseSha = headOf(root);

  const featurePath = join(root, "wt-feature");
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature/exec-session", featurePath], { cwd: root });
  writeText(join(featurePath, "slice.txt"), "slice\n");
  execFileSync("git", ["add", "slice.txt"], { cwd: featurePath });
  commitIn(featurePath, "feat: slice");
  const sourceSha = headOf(featurePath);

  const planMarkdown = join(harnessDir, "plans", `${PLAN_ID}.md`);
  const sddDir = join(harnessDir, "sdd", PLAN_ID);
  const assignmentPath = join(sddDir, "assignment.md");
  const evidencePath = join(sddDir, "evidence.md");
  writeText(planMarkdown, `# Execution session transport plan\n\n**plan_id:** ${PLAN_ID}\n`);
  writeText(evidencePath, "# evidence\n");
  writeText(assignmentPath, assignmentText({ harnessDir, planMarkdown, worktreePath: featurePath, sddDir }));

  const qcReport = join(sddDir, "review", "qc1.md");
  const qcConsolidated = join(sddDir, "review", "qc.md");
  const qaReport = join(sddDir, "qa.md");
  writeText(qcReport, "# QC 1\ndecision: Approve\n");
  writeText(qcConsolidated, "# QC consolidated\ndecision: Approve\n");
  writeText(qaReport, "# QA\nverdict: pass\n");
  return {
    root, harnessDir, context, planMarkdown, assignmentPath, worktreePath: featurePath,
    sddDir, evidencePath, featurePath, sourceSha, baseSha, qcReport, qcConsolidated, qaReport,
  };
}

/** Read the row's stored status through the engine, never the CLI's own claim. */
async function storedRowStatus(fixture: Fixture): Promise<unknown> {
  const read = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
  if (!("plan" in read.data)) throw new Error("the plan read did not return a plan view");
  return (read.data.plan as { status?: unknown }).status;
}

/** The row's stored execution lease through the engine. */
async function storedLease(fixture: Fixture): Promise<{ status?: unknown; holder_session_id?: unknown } | null> {
  const read = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
  if (!("executionLease" in read.data)) throw new Error("the plan read did not return a plan view");
  return (read.data.executionLease as { status?: unknown; holder_session_id?: unknown } | null);
}

/**
 * The handoff id a `plan handoff` receipt discloses, read through `in`/`typeof`
 * narrowing rather than an unchecked inline cast: the CLI envelope is the
 * adapter's own output, but its nested members are still runtime data.
 */
function handoffIdOf(result: RunResult): string {
  const receipt = jsonOf(result).data;
  if (typeof receipt !== "object" || receipt === null) throw new Error(`no receipt in ${result.stdout}`);
  if (!("data" in receipt)) throw new Error(`no plan view in ${result.stdout}`);
  const view = receipt.data;
  if (typeof view !== "object" || view === null) throw new Error(`no plan view object in ${result.stdout}`);
  if (!("coordination" in view)) throw new Error(`no coordination block in ${result.stdout}`);
  const coordination = view.coordination;
  if (typeof coordination !== "object" || coordination === null) throw new Error(`no coordination object in ${result.stdout}`);
  if (!("handoff" in coordination)) throw new Error(`no handoff record in ${result.stdout}`);
  const handoff = coordination.handoff;
  if (typeof handoff !== "object" || handoff === null) throw new Error(`no handoff object in ${result.stdout}`);
  if (!("id" in handoff) || typeof handoff.id !== "string") throw new Error(`no handoff id in ${result.stdout}`);
  return handoff.id;
}

/** The whole root register the authority serves right now. */
async function servedRoot(fixture: Fixture): Promise<readonly { id: string }[]> {
  const read = await readExecutionAuthority(fixture.context);
  if (!("workflows" in read.data)) throw new Error("the register read did not return the whole state");
  return read.data.root.workflows;
}

/**
 * The stored terminal header of one closed workflow, read from the real store
 * row (the execution registry no longer serves a terminal lifecycle, so the
 * register view is empty by design — the persisted state is the authoritative
 * witness).
 */
async function storedTerminalState(fixture: Fixture): Promise<{ status?: unknown; ended_at?: unknown }> {
  const handle = await openStore(fixture.context, "read");
  try {
    const row = handle.db
      .prepare("select state_json from execution_workflows where workflow_id = ?")
      .get(WORKFLOW_ID);
    if (typeof row !== "object" || row === null || !("state_json" in row) || typeof row.state_json !== "string") {
      throw new Error(`no stored row for ${WORKFLOW_ID}`);
    }
    const parsed: unknown = JSON.parse(row.state_json);
    if (typeof parsed !== "object" || parsed === null) throw new Error("stored row is not an object");
    return {
      ...("status" in parsed ? { status: parsed.status } : {}),
      ...("ended_at" in parsed ? { ended_at: parsed.ended_at } : {}),
    };
  } finally {
    handle.close();
  }
}

describe("mstar plan — owned release, reacquisition and the delivery tail (ACTIVE sparse)", () => {
  test("release → explicit same-holder bind → restore content → prepare → progress", async () => {
    const fixture = await activeFixture("mstar-owned-release-reacquire");
    await preparePlanSeat(fixture);
    const planPm = planPmIdentity();
    const assignmentBytes = readFileSync(fixture.assignmentPath);

    // A release never reads the Assignment bytes: remove them first so a
    // lingering read would refuse rather than pass.
    rmSync(fixture.assignmentPath);
    const released = spawnCli(
      ["plan", "release", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, planPm),
    );
    expect(released.exitCode).toBe(0);
    expect(jsonOf(released).command).toBe("plan.release");
    // The public effect is the persisted state, not the receipt echo: the row
    // is Blocked and the claim reads back released.
    expect(await storedRowStatus(fixture)).toBe("Blocked");
    expect((await storedLease(fixture))?.status).toBe("released");

    // The holder explicitly reacquires through the ordinary bind, without a
    // copied reference, token or operation id.
    const rebound = spawnCli(
      ["plan", "bind", "--execution", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, planPm),
    );
    expect(rebound.exitCode).toBe(0);
    expect(jsonOf(rebound).command).toBe("plan.bind");
    const lease = await storedLease(fixture);
    expect(lease?.status).toBe("held");
    expect(lease?.holder_session_id).toBe(PLAN_PM_ID);

    // The repaired content restores the prepared scope, so a re-prepare is the
    // satisfied no-op and progress resumes under the reacquired claim.
    writeText(fixture.assignmentPath, assignmentBytes.toString("utf8"));
    const reprepped = spawnCli(
      ["plan", "prepare", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--assignment", fixture.assignmentPath, "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, coordinatorIdentity()),
    );
    expect(reprepped.exitCode).toBe(0);
    expect(jsonOf(reprepped).command).toBe("plan.prepare");

    const progressPath = join(fixture.root, "progress-reacquired.json");
    // The released row is Blocked; its own allowed edges run Blocked → InProgress
    // → InReview, so the resume reports both.
    for (const status of ["InProgress", "InReview"]) {
      writeJson(progressPath, { status, summary: `resumed after reacquisition (${status})`, evidence_paths: [fixture.evidencePath] });
      const progressed = spawnCli(
        ["plan", "progress", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--file", progressPath, "--harness", fixture.harnessDir],
        fixture,
        cliEnv(fixture, planPm),
      );
      expect(progressed.exitCode).toBe(0);
      expect(jsonOf(progressed).command).toBe("plan.progress");
    }
    expect(await storedRowStatus(fixture)).toBe("InReview");
  }, 30_000);

  test("release → truthful stopped terminal unregisters without fabricating completion", async () => {
    const fixture = await activeFixture("mstar-owned-release-stopped");
    await preparePlanSeat(fixture);
    const planPm = planPmIdentity();
    rmSync(fixture.assignmentPath);
    const released = spawnCli(
      ["plan", "release", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, planPm),
    );
    expect(released.exitCode).toBe(0);

    const stopped = spawnCli(
      ["workflow", "lifecycle", "--status", "stopped", "--reason", "assignment content unavailable; truthful stop", "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, coordinatorIdentity()),
    );
    expect(stopped.exitCode).toBe(0);
    expect(jsonOf(stopped).command).toBe("workflow.lifecycle");
    expect(await servedRoot(fixture)).toHaveLength(0);
    // The terminal state persists in the store row (the registry unregister is
    // what the adapter's register view reflects), read through the real store.
    const stoppedRow = await storedTerminalState(fixture);
    expect(stoppedRow.status).toBe("stopped");
    expect(typeof stoppedRow.ended_at).toBe("string");
  }, 30_000);

  test("owned success: handoff → accept → complete → evidence → close → phase 6, generic routes", async () => {
    const fixture = await activeDeliveryFixture("mstar-owned-delivery-success");
    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, identity, initial.token);
    const beforeBind = await tokensOf(fixture);
    const coordinator = activeBind(fixture, identity, ["--coordinator"], beforeBind.workflow, "bind-coordinator");
    const prepared = runCli(
      [
        "plan", "prepare", "--session-ref", coordinator.wire, "--plan", PLAN_ID,
        "--assignment", fixture.assignmentPath, "--expect", beforeBind.plan,
        "--operation", "prepare-1", "--harness", fixture.harnessDir,
      ],
      fixture,
      identity,
    );
    expect(prepared.exitCode).toBe(0);
    const afterPrepare = await tokensOf(fixture);
    const planPm = activeBind(fixture, planPmIdentity(), ["--plan", PLAN_ID], afterPrepare.plan, "bind-plan-pm");
    expect(planPm.ref.sessionId).toBe(PLAN_PM_ID);

    // Progress and handoff through the sparse own-binding route: no token or
    // reference is copied; the plan-pm tuple is the caller.
    const progressPath = join(fixture.root, "progress-review.json");
    writeJson(progressPath, { status: "InReview", summary: "ready for review", evidence_paths: [fixture.qaReport] });
    const progressed = spawnCli(
      ["plan", "progress", "--file", progressPath, "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, planPmIdentity()),
    );
    expect(progressed.exitCode).toBe(0);
    expect(await storedRowStatus(fixture)).toBe("InReview");

    const handoffPath = join(fixture.root, "handoff.json");
    writeJson(handoffPath, {
      source_sha: fixture.sourceSha,
      review_base: fixture.baseSha,
      review_head: fixture.sourceSha,
      qc: { decision: "Approve", reports: [fixture.qcReport], consolidated: fixture.qcConsolidated },
      qa: { gate: "mandatory", decision: "pass", report: fixture.qaReport },
    });
    const handed = spawnCli(
      ["plan", "handoff", "--file", handoffPath, "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, planPmIdentity()),
    );
    expect(handed.exitCode).toBe(0);
    const handoffId = handoffIdOf(handed);
    expect(typeof handoffId).toBe("string");

    const accepted = spawnCli(
      ["plan", "accept", "--coordinator", "--plan", PLAN_ID, "--handoff", handoffId, "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, identity),
    );
    expect(accepted.exitCode).toBe(0);

    const completed = spawnCli(
      ["plan", "complete", "--coordinator", "--plan", PLAN_ID, "--handoff", handoffId, "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, identity),
    );
    expect(completed.exitCode).toBe(0);
    expect(await storedRowStatus(fixture)).toBe("Done");
    expect(await servedRoot(fixture)).toHaveLength(1);

    // Record the development delivery tail, then close through the generic
    // workflow-close route and confirm the root unregister plus the phase-6
    // projection. All delivery facts are synthetic fixture evidence.
    const deliveryPath = join(fixture.root, "delivery.json");
    writeJson(deliveryPath, {
      compound: { outcome: "skipped", reason: "fixture-only compound disposition" },
      pr: { repo: "synthetic/example", head: "feature/exec-session", target: "main" },
      merge: { provider: "synthetic-fixture", evidence: "fixture verified-merge record; no live provider" },
    });
    const evidence = spawnCli(
      ["workflow", "evidence", "--workflow", WORKFLOW_ID, "--file", deliveryPath, "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, identity),
    );
    expect(evidence.exitCode).toBe(0);
    expect(jsonOf(evidence).command).toBe("workflow.evidence");

    const closed = spawnCli(
      ["status", "workflow-close", "--workflow", WORKFLOW_ID, "--reason", "delivery complete", "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, identity),
    );
    expect(closed.exitCode).toBe(0);
    expect(jsonOf(closed).command).toBe("status.workflow-close");
    expect(await servedRoot(fixture)).toHaveLength(0);
    const completedRow = await storedTerminalState(fixture);
    expect(completedRow.status).toBe("completed");
    expect(typeof completedRow.ended_at).toBe("string");

    const phase6 = runCli(
      ["iteration", "gate", "--phase", "6", "--workflow", WORKFLOW_ID, "--harness", fixture.harnessDir],
      fixture,
    );
    expect(phase6.exitCode).toBe(0);
    expect(jsonOf(phase6)).toMatchObject({ status: "ok", data: { phase: 6 } });
  }, 30_000);
});


/**
 * Explicit seat selector vs the acquired role — the release regressions for the
 * role-constraint bypass. A request that STATES the coordinator seat while the
 * acquired/declared caller is the plan's own plan-pm must refuse as usage
 * before any mutation; the family must never silently reinterpret the declared
 * seat. Every leg asserts the typed refusal AND the persisted facts (row
 * unchanged, own lease still held by the plan-pm), never a prose echo.
 */
describe("mstar plan release — explicit coordinator selector vs the acquired plan-pm seat", () => {
  /** One prepared row whose plan-pm seat holds the execution lease. */
  async function heldSeatFixture(label: string): Promise<Fixture & { planPmWire: string }> {
    const fixture = await activeFixture(label);
    const seat = await preparePlanSeat(fixture);
    return { ...fixture, planPmWire: seat.planPmWire };
  }

  test("an explicit --coordinator selector with a full plan token refuses and keeps the claim held", async () => {
    const fixture = await heldSeatFixture("mstar-release-seat-expect");
    const planPm = planPmIdentity();
    const tokens = await tokensOf(fixture);
    const before = await storedRowStatus(fixture);

    const released = spawnCli(
      ["plan", "release", "--coordinator", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--expect", tokens.plan, "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, planPm),
    );
    expect(released.exitCode).toBe(2);
    expect(jsonOf(released).code).toBe("command.invalid-input");
    expect(await storedRowStatus(fixture)).toBe(before);
    const lease = await storedLease(fixture);
    expect(lease?.status).toBe("held");
    expect(lease?.holder_session_id).toBe(PLAN_PM_ID);
  }, 30_000);

  test("an explicit --coordinator selector with the caller's own session reference refuses and keeps the claim held", async () => {
    const fixture = await heldSeatFixture("mstar-release-seat-ref");
    const planPm = planPmIdentity();
    const before = await storedRowStatus(fixture);

    const released = spawnCli(
      ["plan", "release", "--coordinator", "--session-ref", fixture.planPmWire, "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--harness", fixture.harnessDir],
      fixture,
      cliEnv(fixture, planPm),
    );
    expect(released.exitCode).toBe(2);
    expect(jsonOf(released).code).toBe("command.invalid-input");
    expect(await storedRowStatus(fixture)).toBe(before);
    const lease = await storedLease(fixture);
    expect(lease?.status).toBe("held");
    expect(lease?.holder_session_id).toBe(PLAN_PM_ID);
  }, 30_000);

  test("a direct command-context release with an explicit --coordinator selector refuses and keeps the claim held", async () => {
    const fixture = await heldSeatFixture("mstar-release-seat-direct");
    const planPm = planPmIdentity();
    const before = await storedRowStatus(fixture);

    const direct = await executeCommand("plan.release", {
      coordinator: true,
      workflow: WORKFLOW_ID,
      plan: PLAN_ID,
      harness: fixture.harnessDir,
    }, {
      cwd: fixture.root,
      controlRoot: null,
      sessionId: planPm.sessionId,
      sessionIdSource: "env",
      executionIdentity: planPm,
      versions: { engine: null, cli: "direct-context", plugin: null, host: null, platform: "test" },
      signal: new AbortController().signal,
      effects: {
        async readInput() { return ""; },
        async spawn() { throw new Error("release must not spawn a process"); },
        async startDashboard() { throw new Error("dashboard is unavailable in this test"); },
        async openBrowser() { throw new Error("browser is unavailable in this test"); },
      },
    });
    expect(direct.exitCode).toBe(2);
    expect(direct.code).toBe("command.invalid-input");
    expect(await storedRowStatus(fixture)).toBe(before);
    const lease = await storedLease(fixture);
    expect(lease?.status).toBe("held");
    expect(lease?.holder_session_id).toBe(PLAN_PM_ID);
  }, 30_000);
});
