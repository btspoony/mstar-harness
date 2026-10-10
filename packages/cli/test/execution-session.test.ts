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
 *   launcher, the coordinator bind, resume and a plan mutation — with the
 *   child's exit code and signal propagated.
 * - `identity channel`: a missing, malformed or foreign identity refuses before
 *   any write; a copied reference cannot authorize another session.
 * - `transport disjointness`: `--session`/`--session-ref`, numeric `--expect`,
 *   `--session-id` and `--resume`/`--resume-ref` never mix (exit 2).
 * - `recovery`: a stopped coordinator is replaced through the active recovery
 *   verb under an independently acquired identity and a real stop attestation.
 * - `delivery tail`: one coordinator prepares, progresses and completes a
 *   standalone development row through direct operations — no bind after
 *   prepare, no handoff/accept transfer chain — then records evidence, closes
 *   and passes the phase-6 projection.
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

/**
 * One CLI invocation carrying the caller's identity the way a launcher does:
 * as the minted `MSTAR_EXECUTION_IDENTITY` channel, never as an explicit flag.
 * The engine then derives the caller's own coordinator binding instead of
 * requiring a copied session reference.
 */
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

/** One value read by name from a parsed envelope object, without a cast. */
function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/** One string member of a plain object, or `undefined` (never a cast). */
function stringMember(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const member = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof member === "string" ? member : undefined;
}

/** One object member of a plain object, or `undefined` (never a cast). */
function objectMember(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const member = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof member === "object" && member !== null && !Array.isArray(member)
    ? member as Record<string, unknown>
    : undefined;
}

function coordinatorIdentity(): ExecutionIdentity {
  return { source: "local", sessionId: COORDINATOR_ID, workflowId: WORKFLOW_ID, role: "coordinator" };
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

  const planMarkdown = join(harnessDir, "plans", `${PLAN_ID}.md`);
  const sddDir = join(harnessDir, "sdd", PLAN_ID);
  const worktreePath = join(root, "wt-exec-session");
  const evidencePath = join(sddDir, "evidence.md");
  writeText(planMarkdown, `# Execution session transport plan\n\n**plan_id:** ${PLAN_ID}\n`);
  writeText(evidencePath, "# evidence\n");
  // A REAL checkout on the branch prepare records: prepare validates the actual
  // checkout and branch, not merely that a directory exists.
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature/exec-session", worktreePath], { cwd: root });
  return { root, harnessDir, context, planMarkdown, worktreePath, sddDir, evidencePath };
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
  return { root, harnessDir, context, planMarkdown, worktreePath, sddDir, evidencePath };
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

/** The store-held coordinator view of the addressed workflow. */
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

/** The ordinary prepare configuration flags of one fixture row. */
function prepareConfig(fixture: Fixture, overrides: { worktreePath?: string; workingBranch?: string } = {}): string[] {
  return [
    "--worktree-path", overrides.worktreePath ?? fixture.worktreePath,
    "--working-branch", overrides.workingBranch ?? "feature/exec-session",
    "--qa-gate", "mandatory",
    "--findings-cleanup", "allow-residual",
  ];
}

/**
 * The full active plan chain of one fixture: register, bind the coordinator and
 * prepare the row through the DB route. The coordinator prepares and later
 * completes the same rows directly — no second seat, no bind after prepare.
 */
async function prepareRow(fixture: Fixture): Promise<{ coordinator: ExecutionSessionRef; coordinatorWire: string }> {
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
      "--plan",
      PLAN_ID,
      ...prepareConfig(fixture),
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
  expect(prepared.exitCode, prepared.stdout).toBe(0);
  expect(jsonOf(prepared).command).toBe("plan.prepare");
  return { coordinator: coordinator.ref, coordinatorWire: coordinator.wire };
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
        "coordinator",
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
    const childStdoutRaw = stringMember(objectMember(jsonOf(child), "details"), "stdout");
    if (childStdoutRaw === undefined) throw new Error(`no child stdout in ${child.stdout}`);
    const identity = JSON.parse(childStdoutRaw) as ExecutionIdentity;
    expect(identity.source).toBe("local");
    expect(identity.role).toBe("coordinator");
    expect(identity.workflowId).toBe(WORKFLOW_ID);
    expect(identity.sessionId.length).toBeGreaterThan(0);
    // The launched identity is minted, never inherited from the caller's env.
    expect(identity.sessionId).not.toBe(COORDINATOR_ID);
  });

  test("reports the signal a child was killed by, and refuses a plan selector on the coordinator launch", async () => {
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
    expect(stringMember(objectMember(jsonOf(killed), "details"), "signal")).toBe("SIGTERM");

    for (const invalid of [
      ["--role", "plan-pm", "--plan", PLAN_ID],
      ["--role", "coordinator", "--plan", PLAN_ID],
    ] as const) {
      const refused = runCli(
        ["session", "run", "--workflow", WORKFLOW_ID, ...invalid, "--", "true"],
        fixture,
      );
      expect(refused.exitCode).toBe(2);
      expect(jsonOf(refused).code).toBe("command.invalid-input");
    }
  });

  test("binds, resumes and mutates in a temporary DB, and a retry replays the same receipt", async () => {
    const fixture = await activeFixture("mstar-session-chain");
    const { coordinatorWire } = await prepareRow(fixture);
    const identity = coordinatorIdentity();

    // The session-authorized view of that binding, and the documented resume.
    const view = runCli(
      ["plan", "show", "--session-ref", coordinatorWire, "--plan", PLAN_ID, "--harness", fixture.harnessDir],
      fixture,
      identity,
    );
    expect(view.exitCode, view.stdout).toBe(0);
    expect(jsonOf(view).command).toBe("plan.show");
    expect(stringMember(objectMember(objectMember(dataOf(view), "data"), "plan"), "id")).toBe(PLAN_ID);

    // The coordinator reads its own row with no reference ceremony at all.
    const bare = runCli(["plan", "show", "--plan", PLAN_ID, "--harness", fixture.harnessDir], fixture, identity);
    expect(bare.exitCode, bare.stdout).toBe(0);
    expect(stringMember(objectMember(objectMember(dataOf(bare), "data"), "plan"), "id")).toBe(PLAN_ID);

    const resumed = runCli(
      ["plan", "bind", "--execution", "--resume-ref", coordinatorWire],
      fixture,
      identity,
    );
    expect(resumed.exitCode, resumed.stdout).toBe(0);
    expect(jsonOf(resumed).command).toBe("plan.bind");
    // A resume returns the same reference, without an operation receipt.
    expect(dataOf(resumed).operationId).toBeUndefined();
    expect(dataOf(resumed).replayed).toBeUndefined();
    expect(String((dataOf(resumed).data as ExecutionSessionRef).sessionId)).toBe(COORDINATOR_ID);

    // The ordinary start record first: prepare preserves row status, so the
    // first progress report moves Todo -> InProgress.
    const startPath = join(fixture.root, "progress-start.json");
    writeJson(startPath, { status: "InProgress", summary: "started", evidence_paths: [fixture.evidencePath] });
    const beforeStart = await tokensOf(fixture);
    const startArgs = [
      "plan",
      "progress",
      "--session-ref",
      coordinatorWire,
      "--plan",
      PLAN_ID,
      "--file",
      startPath,
      "--expect",
      beforeStart.plan,
      "--operation",
      "progress-start",
      "--harness",
      fixture.harnessDir,
    ];
    const started = runCli(startArgs, fixture, identity);
    expect(started.exitCode, started.stdout).toBe(0);
    expect(objectMember(objectMember(dataOf(started), "data"), "plan")).toMatchObject({ id: PLAN_ID, status: "InProgress" });

    // One plan mutation through the active transport, then its exact retry.
    const progressPath = join(fixture.root, "progress.json");
    writeJson(progressPath, { status: "InReview", summary: "reviewed delivery ready", evidence_paths: [fixture.evidencePath] });
    const beforeMutation = await tokensOf(fixture);
    const progressArgs = [
      "plan",
      "progress",
      "--session-ref",
      coordinatorWire,
      "--plan",
      PLAN_ID,
      "--file",
      progressPath,
      "--expect",
      beforeMutation.plan,
      "--operation",
      "progress-1",
      "--harness",
      fixture.harnessDir,
    ];
    const progressed = runCli(progressArgs, fixture, identity);
    expect(progressed.exitCode, progressed.stdout).toBe(0);
    expect(jsonOf(progressed).command).toBe("plan.progress");
    expect(dataOf(progressed).replayed).toBe(false);
    expect(objectMember(objectMember(dataOf(progressed), "data"), "plan")).toMatchObject({ id: PLAN_ID, status: "InReview" });
    const retried = runCli(progressArgs, fixture, identity);
    expect(retried.exitCode, retried.stdout).toBe(0);
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
    expect(launched.exitCode, launched.stdout).toBe(0);
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
    expect(bound.exitCode, bound.stdout).toBe(0);
    expect(jsonOf(bound).command).toBe("plan.bind");

    // The authority itself holds the coordinator row under that minted session.
    const workflow = await workflowStateOf(fixture);
    expect(workflow.coordinator?.sessionId).toBe(identity.sessionId);
  });

  test("a minted identity never authorizes a scope it does not declare", async () => {
    const fixture = await activeFixture("mstar-minted-scope");
    const foreign = { source: "local" as const, sessionId: "minted-foreign", workflowId: "wf-somewhere-else", role: "coordinator" as const };
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

  test("a malformed minted transport refuses before any write instead of falling back", async () => {
    const fixture = await activeFixture("mstar-minted-malformed");
    const rootToken = (await readExecutionAuthority(fixture.context)).token;
    for (const malformed of ["not-json", "[]", serializeExecutionValue({ source: "local", sessionId: "", workflowId: WORKFLOW_ID, role: "coordinator" })]) {
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

  test("with no minted identity the ambient host value is the fallback, and both absent registers with a NULL creator", async () => {
    const fixture = await activeFixture("mstar-minted-ambient");
    const rootToken = (await readExecutionAuthority(fixture.context)).token;

    const ambient = spawnCli(
      registerArgs(fixture, rootToken, "register-ambient"),
      fixture,
      { ...cliEnv(fixture), MSTAR_HOST_SESSION_ID: "ambient-host-session" },
    );
    expect(ambient.exitCode, ambient.stdout).toBe(0);
    expect(jsonOf(ambient).command).toBe("workflow.register");

    const second = await activeFixture("mstar-minted-absent");
    const secondToken = (await readExecutionAuthority(second.context)).token;
    const absent = spawnCli(
      registerArgs(second, secondToken, "register-absent"),
      second,
      cliEnv(second),
    );
    // Unset identity is creator ATTRIBUTION, not a registration requirement
    // (issue #383 T1): the registration succeeds, the creator column stays
    // NULL, and the first coordinator bind adopts. The creator-NULL detail is
    // pinned by the engine tests and the T4 stdio MCP regression.
    expect(absent.exitCode, absent.stdout).toBe(0);
    expect(jsonOf(absent).command).toBe("workflow.register");
    const state = await readExecutionAuthority(second.context);
    expect("workflows" in state.data ? state.data.workflows.length : -1).toBe(1);
  });

  test("an explicit --session-id overrides the minted identity", async () => {
    const fixture = await activeFixture("mstar-minted-flag-wins");
    const rootToken = (await readExecutionAuthority(fixture.context)).token;
    const minted = { source: "local" as const, sessionId: "minted-loses", workflowId: WORKFLOW_ID, role: "coordinator" as const };
    const registered = spawnCli(
      registerArgs(fixture, rootToken, "register-flag-wins", ["--session-id", "explicit-wins"]),
      fixture,
      { ...cliEnv(fixture), MSTAR_EXECUTION_IDENTITY: serializeExecutionValue(minted) },
    );
    expect(registered.exitCode, registered.stdout).toBe(0);
    // The explicit identity is the creator, so only it binds first.
    const workflowToken = (await tokensOf(fixture)).workflow;
    const byFlag = runCli(
      ["plan", "bind", "--execution", "--workflow", WORKFLOW_ID, "--coordinator", "--expect", workflowToken,
        "--operation", "bind-flag", "--harness", fixture.harnessDir, "--session-id", "explicit-wins"],
      fixture,
    );
    expect(byFlag.exitCode, byFlag.stdout).toBe(0);
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

describe("mstar plan — identity channel", () => {
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

describe("mstar plan — transport disjointness", () => {
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
    expect(String(jsonOf(mixedSession).message)).toContain("unknown option '--session'");

    const progressJson = join(fixture.root, "numeric-progress.json");
    writeJson(progressJson, { status: "InReview", summary: "numeric-token-check", evidence_paths: [fixture.evidencePath] });
    const numeric = runCli(
      [
        "plan",
        "progress",
        "--session-ref",
        `${WIRE_PREFIX}AAAA`,
        "--plan",
        PLAN_ID,
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
        "--session-id", "unrelated-session", "--expect", tokens.workflow, "--operation", "bind-unacquired",
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
    expect(jsonOf(resumeMix).code).toBe("command.invalid-input");
  });

  test("a copied or unheld reference cannot write under another acquired identity", async () => {
    const fixture = await activeFixture("mstar-session-copied");
    const { coordinatorWire, coordinator } = await prepareRow(fixture);
    const otherIdentity: ExecutionIdentity = { ...coordinatorIdentity(), sessionId: "coord-exec-session-other" };
    const before = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
    const beforeToken = before.token;

    const progressPath = join(fixture.root, "progress.json");
    writeJson(progressPath, { status: "InReview", summary: "copied", evidence_paths: [fixture.evidencePath] });
    // The same wire under a DIFFERENT independently acquired identity is not
    // that session: the engine compares the caller inside its own transaction,
    // so the copy cannot write even though its reference is a real one.
    const copied = runCli(
      [
        "plan",
        "progress",
        "--session-ref",
        coordinatorWire,
        "--plan",
        PLAN_ID,
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
      otherIdentity,
    );
    expect(copied.exitCode).toBe(1);
    expect(String(jsonOf(copied).code)).toMatch(/^(coordination|execution)\./);

    // A reference the store does not hold is refused even when the explicit
    // plan selector is present.
    const staleWire = encodeExecutionSessionRef({ ...coordinator, sessionId: "coord-exec-session-unheld" });
    const stale = runCli(
      ["plan", "show", "--session-ref", staleWire, "--plan", PLAN_ID, "--harness", fixture.harnessDir],
      fixture,
      { ...coordinatorIdentity(), sessionId: "coord-exec-session-unheld" },
    );
    expect(stale.exitCode).toBe(1);
    expect(String(jsonOf(stale).code)).toMatch(/^(coordination|execution)\./);

    // Neither refusal wrote: the row still carries the token this call read.
    const after = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
    expect(after.token).toBe(beforeToken);
  });
});

describe("mstar session recover — documented invocation", () => {
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
    expect(recovered.exitCode, recovered.stdout).toBe(0);
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

    // The removed plan-recovery selector is absent from the command surface.
    const planSelector = runCli(
      [
        "session", "recover", "--workflow", WORKFLOW_ID, "--plan", PLAN_ID, "--prior-session", SUCCESSOR_ID,
        "--reason", "removed selector", "--attestation", attestationPath,
        "--expect", afterBind.workflow, "--operation", "recover-plan", "--harness", fixture.harnessDir,
      ],
      fixture,
      successor,
    );
    expect(planSelector.exitCode).toBe(2);
    expect(jsonOf(planSelector)).toMatchObject({ status: "usage", code: "command.invalid-input" });
    expect(await workflowStateOf(fixture)).toEqual(workflow);
  });
});

describe("mstar status validate — tokens of the active register", () => {
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
    expect(data.state).toBe("execution");
    const rows = data.workflows as Array<{ token: string }>;
    expect(rows[0]?.token).toBe(tokens.workflow);
  });
});

describe("mstar status validate — disclosed authority state", () => {
  test("reports the active store authority rather than a legacy status projection", async () => {
    const legacy = await legacyFixture("mstar-session-legacy-state");
    const legacyResult = runCli(["status", "validate"], legacy);
    expect(legacyResult.exitCode, legacyResult.stderr).toBe(0);
    expect(dataOf(legacyResult)).toMatchObject({
      authority: { root: expect.any(Object) },
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
      code: "store.not-initialized",
      command: "status.validate",
    });
    const missing = await legacyFixture("mstar-session-missing-status");
    rmSync(join(missing.harnessDir, "status.json"));
    const missingResult = runCli(["status", "validate"], missing);
    expect(missingResult.exitCode).toBe(0);
    expect(dataOf(missingResult)).toMatchObject({
      authority: { root: expect.any(Object) },
    });
    const empty = await legacyFixture("mstar-session-empty-harness");
    rmSync(join(empty.harnessDir, "status.json"));
    rmSync(join(empty.harnessDir, "store.db"));
    const emptyResult = runCli(["status", "validate"], empty);
    expect(emptyResult.exitCode).toBe(1);
    expect(jsonOf(emptyResult)).toMatchObject({
      code: "store.not-initialized",
      command: "status.validate",
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
    expect(activeData.state).toBe("execution");
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
    expect(coordinator.wire.startsWith(WIRE_PREFIX)).toBe(true);
    const prepared = runCli(
      [
        "plan", "prepare", "--session-ref", coordinator.wire, "--plan", PLAN_ID,
        ...prepareConfig(fixture), "--expect", tokens.plan,
        "--operation", "prepare-registered-path", "--harness", fixture.harnessDir,
      ],
      fixture,
      identity,
    );
    expect(prepared.exitCode, prepared.stdout).toBe(0);
    expect(jsonOf(prepared).command).toBe("plan.prepare");
  });
  test("canonical absolute registration uses the configured plans root", async () => {
    const fixture = await activeFixture("mstar-register-configured-plans-root");
    writeText(join(fixture.harnessDir, ".mstarc"), "[config]\nplan_dir=custom-plans\n");
    fixture.planMarkdown = join(fixture.harnessDir, "custom-plans", `${PLAN_ID}.md`);
    writeText(fixture.planMarkdown, `# Execution session transport plan\n\n**plan_id:** ${PLAN_ID}\n`);

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
        ...prepareConfig(fixture), "--expect", tokens.plan,
        "--operation", "prepare-configured-path", "--harness", fixture.harnessDir,
      ],
      fixture,
      identity,
    );
    expect(prepared.exitCode, prepared.stdout).toBe(0);
    expect(jsonOf(prepared).command).toBe("plan.prepare");
  });
});

describe("workflow.register — state-aware transport refusals", () => {
  test("foreign-store token refuses with execution.scope-mismatch; ACTIVE registration succeeds under the acquired identity", async () => {
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
    ], legacy, { ...coordinatorIdentity(), workflowId: "legacy-refusal" });
    expect(legacyResult.exitCode).toBe(1);
    const legacyResponse = jsonOf(legacyResult);
    expect(legacyResponse.code).toBe("execution.scope-mismatch");
    expect(legacyResponse.message).toContain("the token belongs to store");
    expect(legacyResponse.message).toContain("Recovery: mstar status validate");
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
    ], active, { ...coordinatorIdentity(), workflowId: "active-refusal" });
    expect(activeResult.exitCode).toBe(0);
    expect(jsonOf(activeResult)).toMatchObject({
      command: "workflow.register",
      status: "ok",
      code: "workflow.register.ok",
    });
  });
});

/* ------------------------------------------------------------------------ *
 * ACTIVE direct coordinator delivery tail
 *
 * These cases drive the ordinary coordinator routes — one seat prepares,
 * progresses and completes — against the SAME public engine verbs and a real
 * temporary ACTIVE authority. The standalone development completion proves its
 * own source checkout, records delivery evidence, closes the workflow and
 * passes the phase-6 projection. Every mutation reads its authoritative state
 * back through the engine, never from the CLI's own claim.
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
 * source the standalone development completion reads. The prepare config pins
 * that same worktree and branch, so `complete` verifies the scope it records.
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
  const baseSha = headOf(root);

  const featurePath = join(root, "wt-feature");
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature/exec-session", featurePath], { cwd: root });
  writeText(join(featurePath, "slice.txt"), "slice\n");
  execFileSync("git", ["add", "slice.txt"], { cwd: featurePath });
  commitIn(featurePath, "feat: slice");
  const sourceSha = headOf(featurePath);

  const planMarkdown = join(harnessDir, "plans", `${PLAN_ID}.md`);
  const sddDir = join(harnessDir, "sdd", PLAN_ID);
  const evidencePath = join(sddDir, "evidence.md");
  writeText(planMarkdown, `# Execution session transport plan\n\n**plan_id:** ${PLAN_ID}\n`);
  writeText(evidencePath, "# evidence\n");

  const qcReport = join(sddDir, "review", "qc1.md");
  const qcConsolidated = join(sddDir, "review", "qc.md");
  const qaReport = join(sddDir, "qa.md");
  writeText(qcReport, "# QC 1\ndecision: Approve\n");
  writeText(qcConsolidated, "# QC consolidated\ndecision: Approve\n");
  writeText(qaReport, "# QA\nverdict: pass\n");
  return {
    root, harnessDir, context, planMarkdown, worktreePath: featurePath, sddDir, evidencePath,
    featurePath, sourceSha, baseSha, qcReport, qcConsolidated, qaReport,
  };
}

/** Read the row's stored status through the engine, never the CLI's own claim. */
async function storedRowStatus(fixture: Fixture): Promise<unknown> {
  const read = await readExecutionAuthority(fixture.context, { workflowId: WORKFLOW_ID, planId: PLAN_ID });
  if (!("plan" in read.data)) throw new Error("the plan read did not return a plan view");
  return fieldOf(read.data.plan, "status");
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

describe("mstar plan — direct coordinator prepare and completion (standalone development)", () => {
  test("the coordinator prepares, progresses and completes the row with no second seat", async () => {
    const fixture = await activeDeliveryFixture("mstar-direct-completion");
    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, identity, initial.token);
    const beforeBind = await tokensOf(fixture);
    const coordinator = activeBind(fixture, identity, ["--coordinator"], beforeBind.workflow, "bind-coordinator");

    // One coordinator prepares the row through the ordinary configuration and
    // later completes it: no plan session, no bind after prepare.
    const prepared = runCli(
      [
        "plan", "prepare", "--session-ref", coordinator.wire, "--plan", PLAN_ID,
        ...prepareConfig(fixture, { worktreePath: fixture.featurePath, workingBranch: "feature/exec-session" }),
        "--expect", beforeBind.plan, "--operation", "prepare-direct", "--harness", fixture.harnessDir,
      ],
      fixture,
      identity,
    );
    expect(prepared.exitCode, prepared.stdout).toBe(0);

    // The ordinary start record first: prepare preserves row status, so the
    // first progress report moves Todo -> InProgress.
    const startPath = join(fixture.root, "progress-start.json");
    writeJson(startPath, { status: "InProgress", summary: "direct coordinator start", evidence_paths: [fixture.qaReport] });
    const started = runCli(
      ["plan", "progress", "--plan", PLAN_ID, "--file", startPath, "--harness", fixture.harnessDir],
      fixture,
      identity,
    );
    expect(started.exitCode, started.stdout).toBe(0);

    // The configuration is revisable while the row is ACTIVE: a CHANGED
    // configuration — a different real checkout and branch, recorded after the
    // row already started — is adopted, not treated as a sealed admission gate.
    // (A same-value re-prepare only proves an equal-config no-op.)
    const correctedPath = join(fixture.root, "wt-corrected");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature/corrected", correctedPath], { cwd: fixture.root });
    const reprepped = runCli(
      ["plan", "prepare", "--session-ref", coordinator.wire, "--plan", PLAN_ID,
        ...prepareConfig(fixture, { worktreePath: correctedPath, workingBranch: "feature/corrected" }),
        "--operation", "prepare-direct-2", "--harness", fixture.harnessDir],
      fixture,
      identity,
    );
    expect(reprepped.exitCode, reprepped.stdout).toBe(0);
    const shownAfterCorrection = runCli(["plan", "show", "--plan", PLAN_ID, "--harness", fixture.harnessDir], fixture, identity);
    expect(objectMember(objectMember(objectMember(dataOf(shownAfterCorrection), "data"), "plan"), "metadata")).toMatchObject({
      worktree_path: correctedPath,
      working_branch: "feature/corrected",
    });
    // The correction preserves the started state: status and progress survive.
    expect(await storedRowStatus(fixture)).toBe("InProgress");

    // Revise BACK to the registered source scope before completion: standalone
    // development verifies the row's own recorded branch against the registered
    // source, so a completion naming `feature/exec-session` must find that scope.
    const restored = runCli(
      ["plan", "prepare", "--session-ref", coordinator.wire, "--plan", PLAN_ID,
        ...prepareConfig(fixture, { worktreePath: fixture.featurePath, workingBranch: "feature/exec-session" }),
        "--operation", "prepare-direct-3", "--harness", fixture.harnessDir],
      fixture,
      identity,
    );
    expect(restored.exitCode, restored.stdout).toBe(0);

    // The review record completes the started progression (InProgress → InReview).
    const progressPath = join(fixture.root, "progress-review.json");
    writeJson(progressPath, { status: "InReview", summary: "direct coordinator InReview", evidence_paths: [fixture.qaReport] });
    const progressed = runCli(
      ["plan", "progress", "--plan", PLAN_ID, "--file", progressPath, "--harness", fixture.harnessDir],
      fixture,
      identity,
    );
    expect(progressed.exitCode, progressed.stdout).toBe(0);
    expect(await storedRowStatus(fixture)).toBe("InReview");

    // The one direct completion: QC/QA evidence plus the source commit the row's
    // own feature checkout proves. No handoff, no accept, no integration pair on
    // the standalone development route.
    const evidencePath = join(fixture.root, "completion.json");
    writeJson(evidencePath, {
      source_sha: fixture.sourceSha,
      review_base: fixture.baseSha,
      review_head: fixture.sourceSha,
      qc: { decision: "Approve", reports: [fixture.qcReport], consolidated: fixture.qcConsolidated },
      qa: { gate: "mandatory", decision: "pass", report: fixture.qaReport },
    });
    const completed = runCli(
      ["plan", "complete", "--plan", PLAN_ID, "--file", evidencePath, "--harness", fixture.harnessDir],
      fixture,
      identity,
    );
    expect(completed.exitCode, completed.stdout).toBe(0);
    expect(jsonOf(completed).command).toBe("plan.complete");
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
    const evidence = runCli(
      ["workflow", "evidence", "--workflow", WORKFLOW_ID, "--file", deliveryPath, "--harness", fixture.harnessDir],
      fixture,
      identity,
    );
    expect(evidence.exitCode, evidence.stdout).toBe(0);
    expect(jsonOf(evidence).command).toBe("workflow.evidence");

    const closed = runCli(
      ["status", "workflow-close", "--workflow", WORKFLOW_ID, "--reason", "delivery complete", "--harness", fixture.harnessDir],
      fixture,
      identity,
    );
    expect(closed.exitCode, closed.stdout).toBe(0);
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

  test("the removed transfer verbs are absent from the command surface", async () => {
    const fixture = await activeFixture("mstar-transfer-verbs-gone");
    const { coordinatorWire } = await prepareRow(fixture);
    const identity = coordinatorIdentity();
    const before = await readExecutionAuthority(fixture.context);
    for (const verb of ["handoff", "accept", "return", "integration-start", "integration-accept", "reconcile", "release", "repair-delivery-source"] as const) {
      const result = runCli(["plan", verb, "--session-ref", coordinatorWire, "--plan", PLAN_ID, "--harness", fixture.harnessDir], fixture, identity);
      expect(result.exitCode).toBe(2);
      expect(jsonOf(result)).toMatchObject({ status: "usage", code: "command.invalid-input" });
    }
    expect(await readExecutionAuthority(fixture.context)).toEqual(before);
  }, 30_000);

  test("complete refuses the integration pair on the standalone development route", async () => {
    const fixture = await activeDeliveryFixture("mstar-direct-completion-contamination");
    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, identity, initial.token);
    const beforeBind = await tokensOf(fixture);
    const coordinator = activeBind(fixture, identity, ["--coordinator"], beforeBind.workflow, "bind-coordinator");
    const prepared = runCli(
      ["plan", "prepare", "--session-ref", coordinator.wire, "--plan", PLAN_ID,
        ...prepareConfig(fixture, { worktreePath: fixture.featurePath, workingBranch: "feature/exec-session" }),
        "--expect", beforeBind.plan, "--operation", "prepare-contamination", "--harness", fixture.harnessDir],
      fixture,
      identity,
    );
    expect(prepared.exitCode, prepared.stdout).toBe(0);
    for (const status of ["InProgress", "InReview"]) {
      const progressPath = join(fixture.root, `progress-${status}.json`);
      writeJson(progressPath, { status, summary: `direct coordinator ${status}`, evidence_paths: [fixture.qaReport] });
      const progressed = runCli(["plan", "progress", "--plan", PLAN_ID, "--file", progressPath, "--harness", fixture.harnessDir], fixture, identity);
      expect(progressed.exitCode, progressed.stdout).toBe(0);
    }

    const evidencePath = join(fixture.root, "completion.json");
    writeJson(evidencePath, {
      source_sha: fixture.sourceSha,
      review_base: fixture.baseSha,
      review_head: fixture.sourceSha,
      qc: { decision: "Approve", reports: [fixture.qcReport], consolidated: fixture.qcConsolidated },
      qa: { gate: "mandatory", decision: "pass", report: fixture.qaReport },
    });
    const contaminated = runCli(
      ["plan", "complete", "--plan", PLAN_ID, "--file", evidencePath,
        "--integration-base-sha", fixture.baseSha, "--integration-result-sha", fixture.sourceSha,
        "--harness", fixture.harnessDir],
      fixture,
      identity,
    );
    expect(contaminated.exitCode).toBe(1);
    expect(String(jsonOf(contaminated).code)).toMatch(/^(coordination|execution)\./);
    // The refusal wrote nothing: the row is still the InReview row the coordinator recorded.
    expect(await storedRowStatus(fixture)).toBe("InReview");

    // A half-stated integration pair is a caller-input refusal, never a
    // silently half-recorded merge.
    const partial = runCli(
      ["plan", "complete", "--plan", PLAN_ID, "--file", evidencePath, "--integration-base-sha", fixture.baseSha, "--harness", fixture.harnessDir],
      fixture,
      identity,
    );
    expect(partial.exitCode).toBe(2);
    expect(jsonOf(partial).code).toBe("command.invalid-input");
  }, 30_000);

  test("a direct command-context complete without an acquired identity refuses before any write", async () => {
    const fixture = await activeDeliveryFixture("mstar-direct-completion-identity");
    const identity = coordinatorIdentity();
    const initial = await readExecutionAuthority(fixture.context);
    registerThroughAuthority(fixture, identity, initial.token);
    const tokens = await tokensOf(fixture);
    const before = await storedRowStatus(fixture);

    const direct = await executeCommand("plan.complete", {
      plan: PLAN_ID,
      harness: fixture.harnessDir,
      file: join(fixture.root, "absent.json"),
    }, {
      cwd: fixture.root,
      controlRoot: null,
      versions: { engine: null, cli: "direct-context", plugin: null, host: null, platform: "test" },
      signal: new AbortController().signal,
      effects: {
        async readInput() { return ""; },
        async spawn() { throw new Error("complete must not spawn a process"); },
        async startDashboard() { throw new Error("dashboard is unavailable in this test"); },
        async openBrowser() { throw new Error("browser is unavailable in this test"); },
      },
    });
    expect(direct.exitCode).toBe(2);
    expect(direct.code).toBe("command.invalid-input");
    expect(await storedRowStatus(fixture)).toBe(before);
    const after = await tokensOf(fixture);
    expect(after.workflow).toBe(tokens.workflow);
  }, 30_000);
});

/* ------------------------------------------------------------------------ *
 * ACTIVE multi-plan continuation — ONE session id drives TWO plans of ONE
 * workflow (issue #400 acceptance #5, carried onto the removed-plan-PM model)
 *
 * The plan-PM seat and its execution leases are gone: one workflow holds one
 * coordinator session, and every plan verb is an ordinary operation of that
 * session. This case drives the acceptance scenario end to end through the
 * public CLI on a REAL ACTIVE authority: the SAME `--session-id` prepares,
 * progresses and completes plan A, then prepares, progresses and completes
 * plan B of the same running iteration — no second seat, no re-bind, no
 * release/handoff and no session/role gating anywhere in the chain.
 *
 * What is asserted is what the landed engine actually records: both rows reach
 * `Done`, each completion's `completed_by` is that one session identity, the
 * workflow is still `running` and still registered, the store holds exactly
 * ONE coordinator session row for the workflow, and every accepted operation
 * is receipted under its own plan row. The iteration route's serial merge is
 * performed for real in the registered integration checkout, so the completion
 * proof is the exact two-parent merge the engine re-derives.
 * ------------------------------------------------------------------------ */

const CONTINUATION_WORKFLOW = "wf-exec-session-continuation";
const CONTINUATION_PLAN_A = "20260924-continuation-plan-a";
const CONTINUATION_PLAN_B = "20260924-continuation-plan-b";
const CONTINUATION_INTEGRATION_BRANCH = "integration/exec-session-continuation";
const CONTINUATION_COMPASS_REF = `iterations/${CONTINUATION_WORKFLOW}/delivery-compass.md`;

interface ContinuationPlan {
  id: string;
  worktree: string;
  branch: string;
  sddDir: string;
  qaReport: string;
  qcReport: string;
  qcConsolidated: string;
  sourceSha: string;
  /** The integration HEAD this plan's serial merge started from. */
  mergeBase: string;
  /** The exact two-parent merge commit the completion names. */
  mergeResult: string;
}

interface ContinuationFixture extends Fixture {
  plans: readonly ContinuationPlan[];
  integrationPath: string;
  rootCommit: string;
}

function headAt(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

function mergeInto(integrationPath: string, sourceSha: string, message: string): string {
  execFileSync(
    "git",
    ["-C", integrationPath, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--no-ff", sourceSha, "-m", message],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  return headAt(integrationPath);
}

/**
 * A temp Git workspace with an ACTIVE authority and TWO plan rows of ONE
 * iteration: a real feature checkout per row and a real integration checkout
 * on the registered integration branch. The rows are registered through the
 * CLI (`iteration register`), so the fixture only prepares the artifacts.
 */
async function continuationFixture(label: string): Promise<ContinuationFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${label}-`)));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const rootCommit = headAt(root);

  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const context: StoreContext = { harnessDir };
  const store = await initializeStore(context);
  store.close();

  writeText(
    join(harnessDir, CONTINUATION_COMPASS_REF),
    `---\nstatus: active\nplans:\n  - ${CONTINUATION_PLAN_A}\n  - ${CONTINUATION_PLAN_B}\ntargetBranch: main\n---\n`,
  );

  const integrationPath = join(root, "wt-integration");
  execFileSync("git", ["worktree", "add", "-q", "-b", CONTINUATION_INTEGRATION_BRANCH, integrationPath, "main"], { cwd: root });

  const plans: ContinuationPlan[] = [];
  for (const [index, planId] of [CONTINUATION_PLAN_A, CONTINUATION_PLAN_B].entries()) {
    writeText(join(harnessDir, "plans", `${planId}.md`), `# Continuation plan ${index + 1}\n\n**plan_id:** ${planId}\n`);
    const worktree = join(root, `wt-${planId}`);
    const branch = `feature/${planId}`;
    execFileSync("git", ["worktree", "add", "-q", "-b", branch, worktree], { cwd: root });
    writeText(join(worktree, `slice-${index + 1}.txt`), `slice ${index + 1}\n`);
    execFileSync("git", ["add", `.`], { cwd: worktree });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: slice ${index + 1}`], { cwd: worktree });
    const sddDir = join(harnessDir, "sdd", planId);
    const qaReport = join(sddDir, "qa.md");
    const qcReport = join(sddDir, "review", "qc1.md");
    const qcConsolidated = join(sddDir, "review", "qc.md");
    writeText(qaReport, "# QA\nverdict: pass\n");
    writeText(qcReport, "# QC 1\ndecision: Approve\n");
    writeText(qcConsolidated, "# QC consolidated\ndecision: Approve\n");
    plans.push({
      id: planId,
      worktree,
      branch,
      sddDir,
      qaReport,
      qcReport,
      qcConsolidated,
      sourceSha: headAt(worktree),
      mergeBase: "",
      mergeResult: "",
    });
  }

  return {
    root,
    harnessDir,
    context,
    planMarkdown: join(harnessDir, "plans", `${CONTINUATION_PLAN_A}.md`),
    worktreePath: plans[0]!.worktree,
    sddDir: plans[0]!.sddDir,
    evidencePath: plans[0]!.qaReport,
    plans,
    integrationPath,
    rootCommit,
  };
}

async function continuationWorkflowToken(fixture: ContinuationFixture): Promise<string> {
  const state = await readExecutionAuthority(fixture.context, { workflowId: CONTINUATION_WORKFLOW });
  if (!("workflows" in state.data)) throw new Error("the workflow read did not return a state");
  const workflow = state.data.workflows.find((entry) => entry.state.id === CONTINUATION_WORKFLOW);
  if (workflow === undefined) throw new Error(`workflow ${CONTINUATION_WORKFLOW} is not in the authority register`);
  return workflow.workflowToken;
}

async function continuationPlanToken(fixture: ContinuationFixture, planId: string): Promise<string> {
  return (await readExecutionAuthority(fixture.context, { workflowId: CONTINUATION_WORKFLOW, planId })).token;
}

async function continuationPlanRow(fixture: ContinuationFixture, planId: string): Promise<ExecutionPlanView> {
  const read = await readExecutionAuthority(fixture.context, { workflowId: CONTINUATION_WORKFLOW, planId });
  if (!("plan" in read.data)) throw new Error("the plan read did not return a plan view");
  return read.data;
}

describe("mstar plan — ONE session drives two plans of one workflow (issue #400 acceptance #5)", () => {
  test("the same session id prepares, progresses and completes plan A, then plan B, with no session/role gate", async () => {
    const fixture = await continuationFixture("mstar-multi-plan-continuation");
    // The whole chain runs on the EXPLICIT `--session-id` transport alone: no
    // copied session reference and no minted launch identity are supplied, so
    // every plan verb must derive the caller's own live coordinator binding
    // from that one session id. A binding that gated the second plan, or
    // refused a verb for role/seat reasons, would fail here.
    const sessionArg = ["--session-id", COORDINATOR_ID];
    const harnessArg = ["--harness", fixture.harnessDir];
    /** The addressed workflow is the plan verbs' selection, never a seat. */
    const workflowArg = ["--workflow", CONTINUATION_WORKFLOW];
    const refusalCodes: Array<string | undefined> = [];
    /** Run one CLI step and record its refusal code, so the whole chain is audited at the end. */
    const step = (args: string[], label: string): RunResult => {
      const result = runCli(args, fixture);
      refusalCodes.push(result.exitCode === 0 ? undefined : String(jsonOf(result).code));
      expect(result.exitCode, `${label}: ${result.stdout}${result.stderr}`).toBe(0);
      return result;
    };

    // (1) Register BOTH rows of ONE iteration through the CLI producer.
    const registered = step(
      [
        "iteration", "register",
        "--workflow", CONTINUATION_WORKFLOW,
        "--compass-ref", CONTINUATION_COMPASS_REF,
        "--branch-base", "main",
        "--branch-integration", CONTINUATION_INTEGRATION_BRANCH,
        "--branch-target-iteration", "main",
        "--row", JSON.stringify({ id: CONTINUATION_PLAN_A, title: "Continuation plan 1", file: `plans/${CONTINUATION_PLAN_A}.md` }),
        "--row", JSON.stringify({ id: CONTINUATION_PLAN_B, title: "Continuation plan 2", file: `plans/${CONTINUATION_PLAN_B}.md` }),
        "--expect", (await readExecutionAuthority(fixture.context)).token,
        "--operation", "register-continuation",
        ...harnessArg,
      ],
      "iteration register",
    );
    expect(jsonOf(registered).command).toBe("iteration.register");

    // (2) ONE coordinator bind for the whole workflow: every later plan verb is
    // an ordinary operation of this very session, never a second seat.
    const bound = step(
      [
        "plan", "bind", "--execution",
        "--workflow", CONTINUATION_WORKFLOW,
        "--coordinator",
        "--expect", await continuationWorkflowToken(fixture),
        "--operation", "bind-continuation",
        ...sessionArg,
        ...harnessArg,
      ],
      "plan bind",
    );
    const reference = dataOf(bound).data as unknown as ExecutionSessionRef;
    expect(reference.sessionId).toBe(COORDINATOR_ID);
    expect(reference.role).toBe("coordinator");

    // (3) The registered integration checkout the serial merge will happen in.
    step(
      [
        "workflow", "integration-worktree",
        "--workflow", CONTINUATION_WORKFLOW,
        "--expect", await continuationWorkflowToken(fixture),
        "--operation", "iw-continuation",
        "--path", fixture.integrationPath,
        ...sessionArg,
        ...harnessArg,
      ],
      "workflow integration-worktree",
    );

    // (4) The one session drives plan A's whole chain, then plan B's, in the
    // order the registered serial integration lane requires.
    let mergeBase = headAt(fixture.integrationPath);
    for (const [index, plan] of fixture.plans.entries()) {
      const label = `plan ${index + 1} (${plan.id})`;

      const prepared = step(
        [
          "plan", "prepare",
          "--plan", plan.id,
          "--worktree-path", plan.worktree,
          "--working-branch", plan.branch,
          "--qa-gate", "mandatory",
          "--findings-cleanup", "allow-residual",
          "--expect", await continuationPlanToken(fixture, plan.id),
          "--operation", `prepare-${plan.id}`,
          ...sessionArg,
          ...workflowArg,
          ...harnessArg,
        ],
        `${label} prepare`,
      );
      expect(jsonOf(prepared).command).toBe("plan.prepare");

      // The row's own progression: prepare preserves the row status, so the
      // first report moves Todo -> InProgress and the review report closes it.
      for (const status of ["InProgress", "InReview"] as const) {
        const progressPath = join(fixture.root, `progress-${plan.id}-${status}.json`);
        writeJson(progressPath, { status, summary: `${plan.id} ${status}`, evidence_paths: [plan.qaReport] });
        const progressed = step(
          ["plan", "progress", "--plan", plan.id, "--file", progressPath, ...sessionArg, ...workflowArg, ...harnessArg],
          `${label} progress ${status}`,
        );
        expect(jsonOf(progressed).command).toBe("plan.progress");
      }

      // The serial merge the coordinator actually performs for this row.
      plan.mergeBase = mergeBase;
      plan.mergeResult = mergeInto(fixture.integrationPath, plan.sourceSha, `Merge ${plan.id}`);
      mergeBase = plan.mergeResult;

      const evidencePath = join(fixture.root, `completion-${plan.id}.json`);
      writeJson(evidencePath, {
        source_sha: plan.sourceSha,
        review_base: fixture.rootCommit,
        review_head: plan.sourceSha,
        qc: { decision: "Approve", reports: [plan.qcReport], consolidated: plan.qcConsolidated },
        qa: { gate: "mandatory", decision: "pass", report: plan.qaReport },
      });
      const completed = step(
        [
          "plan", "complete",
          "--plan", plan.id,
          "--file", evidencePath,
          "--integration-base-sha", plan.mergeBase,
          "--integration-result-sha", plan.mergeResult,
          ...sessionArg,
          ...workflowArg,
          ...harnessArg,
        ],
        `${label} complete`,
      );
      expect(jsonOf(completed).command).toBe("plan.complete");

      // The very same session id is what the store records against the row.
      const row = await continuationPlanRow(fixture, plan.id);
      expect(row.plan.status).toBe("Done");
      expect(row.coordination?.completion?.completed_by).toBe(COORDINATOR_ID);
      expect(row.coordination?.completion?.source_sha).toBe(plan.sourceSha);
      expect(row.coordination?.completion?.integration).toMatchObject({
        base_sha: plan.mergeBase,
        result_sha: plan.mergeResult,
      });
    }

    // (5) Both completions are recorded and the workflow is still running with
    // BOTH rows Done — the continuation never closed or forked the lifecycle.
    const state = await readExecutionAuthority(fixture.context, { workflowId: CONTINUATION_WORKFLOW });
    if (!("workflows" in state.data)) throw new Error("the workflow read did not return a state");
    const workflow = state.data.workflows.find((entry) => entry.state.id === CONTINUATION_WORKFLOW);
    if (workflow === undefined) throw new Error(`workflow ${CONTINUATION_WORKFLOW} is not in the authority register`);
    expect(workflow.state.status).toBe("running");
    expect(workflow.coordinator?.sessionId).toBe(COORDINATOR_ID);
    expect(workflow.plans.map((row) => [row.plan.id, row.plan.status])).toEqual([
      [CONTINUATION_PLAN_A, "Done"],
      [CONTINUATION_PLAN_B, "Done"],
    ]);
    const rootRead = await readExecutionAuthority(fixture.context);
    if (!("workflows" in rootRead.data)) throw new Error("the register read did not return the whole state");
    expect(rootRead.data.root.workflows.map((entry) => entry.id)).toEqual([CONTINUATION_WORKFLOW]);

    // (6) ONE session row, one identity: the two plans share the coordinator
    // binding instead of each carrying an attribution seat of its own.
    const handle = await openStore(fixture.context, "read");
    try {
      const sessions = handle.db
        .prepare("select role, session_id, state from execution_sessions where workflow_id = ?")
        .all(CONTINUATION_WORKFLOW) as Array<{ role: string; session_id: string; state: string }>;
      expect(sessions).toEqual([{ role: "coordinator", session_id: COORDINATOR_ID, state: "active" }]);
      // Every plan operation was receipted under its own addressed row.
      const receipts = handle.db
        .prepare("select plan_id, count(*) as n from execution_operations where workflow_id = ? group by plan_id order by plan_id")
        .all(CONTINUATION_WORKFLOW) as Array<{ plan_id: string | null; n: number }>;
      expect(receipts.map((row) => row.plan_id)).toEqual([null, CONTINUATION_PLAN_A, CONTINUATION_PLAN_B]);
      for (const row of receipts.filter((entry) => entry.plan_id !== null)) expect(row.n).toBeGreaterThanOrEqual(3);
    } finally {
      handle.close();
    }

    // (7) No step in the whole chain refused: every recorded code is undefined.
    expect(refusalCodes.every((code) => code === undefined)).toBe(true);
  }, 120_000);
});
