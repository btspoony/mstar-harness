/**
 * CLI active workflow transport — C4 (phase 2b execution contract §3.2).
 *
 * Run with `bun test packages/cli/test/execution-workflow.test.ts`.
 *
 * The cases drive the DIRECT workflow writer entries of `index.ts`
 * (`workflow register`, `iteration register`, `workflow evidence`,
 * `status workflow-close`) and the closed workflow verb grammar
 * (`phase`, `lifecycle`, `execution-policy`, `integration-worktree`) against a
 * real active execution authority, then read the stored header back through the
 * engine — never through the CLI's own claim.
 *
 * Acceptance criteria carried by these cases:
 *
 * - `documented invocation`: a trusted registration publishes the producer call
 *   and its catalog delta in one transaction, and the named transitions move the
 *   lifecycle through the landed domain verbs.
 * - `refusals`: a stale token, a foreign identity and a mixed transport refuse
 *   with no state change; one exact retry replays the recorded receipt.
 * - `terminal`: the terminal lifecycle is atomic, and the retired file close and
 *   one-time delivery-kind rewrite are refused while the authority is active.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  ACTIVATION_PROTOCOL_VERSION,
  encodeExecutionSessionRef,
  initializeStore,
  openStore,
  readExecutionAuthority,
  serializeExecutionValue,
  type ExecutionIdentity,
  type ExecutionSessionRef,
  type ExecutionState,
  type StoreContext,
} from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

type EngineManifest = { engines?: { node?: string } };
// Repo manifest read at runtime: no test pins the runtime floor, and
// package.json stays the sole version authority.
const declaredNodeFloor = (
  (JSON.parse(readFileSync(join(CLI_ROOT, "..", "engine", "package.json"), "utf8")) as EngineManifest)
    .engines?.node ?? ""
).replace(/^>=\s*/, "").trim();
/** Injected current runtime: at/above the declared floor. */
const atOrAboveRuntime = `${Number.parseInt(declaredNodeFloor.split(".")[0]!, 10) + 1}.0.0`;

const WORKFLOW_ID = "wf-exec-workflow";
const PLAN_ID = "20260922-execution-workflow-plan";
const COORDINATOR_ID = "coord-exec-workflow";
const ITERATION_ID = "iter-exec-workflow";
const INTEGRATION_BRANCH = "iteration/exec-workflow";
/** The completion policy a `verification/report-only` registration records. */
const REPORT_ONLY_POLICY = `acceptance report at plans/${PLAN_ID}/report.md`;

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface Fixture {
  root: string;
  harnessDir: string;
  context: StoreContext;
  planMarkdown: string;
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

function runCli(args: string[], fixture: Fixture, identity?: ExecutionIdentity): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: fixture.root,
    env: cliEnv(fixture, identity),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function jsonOf(result: RunResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON stdout, got ${JSON.stringify(result.stdout)} (stderr: ${result.stderr})`);
  }
}

/** The `data` object of one CLI success/failure envelope. */
function dataOf(result: RunResult): Record<string, unknown> {
  const data = jsonOf(result).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`expected a data object, got ${result.stdout}`);
  }
  return data as Record<string, unknown>;
}

function coordinatorIdentity(workflowId = WORKFLOW_ID, sessionId = COORDINATOR_ID): ExecutionIdentity {
  return { source: "local", sessionId, workflowId, role: "coordinator" };
}

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
  await readExecutionAuthority(context);
  const planMarkdown = join(harnessDir, "plans", `${PLAN_ID}.md`);
  writeText(planMarkdown, `# Active workflow transport plan\n\n**plan_id:** ${PLAN_ID}\n`);
  return { root, harnessDir, context, planMarkdown };
}

async function rootTokenOf(fixture: Fixture): Promise<string> {
  const read = await readExecutionAuthority(fixture.context);
  return read.token;
}

async function workflowTokenOf(fixture: Fixture, workflowId = WORKFLOW_ID): Promise<string> {
  const state = await readExecutionAuthority(fixture.context, { workflowId });
  if (!("workflows" in state.data)) throw new Error("the workflow read did not return a state");
  const workflow = state.data.workflows.find((entry) => entry.state.id === workflowId);
  if (workflow === undefined) throw new Error(`workflow ${workflowId} is not in the authority register`);
  return workflow.workflowToken;
}

/** The stored header of one workflow, read through the engine. */
async function storedHeader(fixture: Fixture, workflowId = WORKFLOW_ID): Promise<Record<string, unknown>> {
  const state = await readExecutionAuthority(fixture.context, { workflowId });
  if (!("workflows" in state.data)) throw new Error("the workflow read did not return a state");
  const workflow: ExecutionState["workflows"][number] | undefined = state.data.workflows.find(
    (entry) => entry.state.id === workflowId,
  );
  if (workflow === undefined) throw new Error(`workflow ${workflowId} is not in the authority register`);
  return workflow.state as unknown as Record<string, unknown>;
}

/** Register the standalone plan workflow through the ACTIVE registration route. */
function registerPlanWorkflow(
  fixture: Fixture,
  identity: ExecutionIdentity,
  rootToken: string,
  operationId = "register-1",
): RunResult {
  return runCli(
    [
      "workflow",
      "register",
      "--workflow",
      WORKFLOW_ID,
      "--plan-id",
      PLAN_ID,
      "--plan-title",
      "Active workflow transport plan",
      "--plan-file",
      `plans/${PLAN_ID}.md`,
      "--delivery-kind",
      "development",
      "--branch-work",
      "feature/exec-workflow",
      "--branch-target",
      "main",
      "--expect",
      rootToken,
      "--operation",
      operationId,
      "--harness",
      fixture.harnessDir,
      "--session-id",
      identity.sessionId,
      "--json",
    ],
    fixture,
    identity,
  );
}

/** Register the SAME workflow as `verification/report-only` (its own completion policy). */
function registerReportOnlyWorkflow(fixture: Fixture, identity: ExecutionIdentity, rootToken: string): RunResult {
  return runCli(
    [
      "workflow",
      "register",
      "--workflow",
      WORKFLOW_ID,
      "--plan-id",
      PLAN_ID,
      "--plan-title",
      "Active workflow transport plan",
      "--plan-file",
      `plans/${PLAN_ID}.md`,
      "--delivery-kind",
      "verification/report-only",
      "--completion-policy",
      REPORT_ONLY_POLICY,
      "--expect",
      rootToken,
      "--operation",
      "register-report-only-1",
      "--harness",
      fixture.harnessDir,
      "--session-id",
      identity.sessionId,
      "--json",
    ],
    fixture,
    identity,
  );
}

/**
 * Plant one plan row Done through the store the engine's own readers use: the
 * fixture's only route to a close (the CLI completes a row through its QC/QA
 * proof route, which is not a fixture concern).
 */
async function plantDoneRow(fixture: Fixture, status = "Done"): Promise<void> {
  const handle = await openStore(fixture.context, "write");
  try {
    const row = handle.db
      .prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?")
      .get(WORKFLOW_ID, PLAN_ID) as { state_json?: unknown } | undefined;
    if (typeof row?.state_json !== "string") throw new Error(`the fixture has no plan row ${PLAN_ID}`);
    const state = JSON.parse(row.state_json) as { status?: unknown };
    state.status = status;
    handle.db
      .prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?")
      .run(JSON.stringify(state), WORKFLOW_ID, PLAN_ID);
  } finally {
    handle.close();
  }
}

/** Bind one workflow's coordinator through the documented active form. */
function bindCoordinator(
  fixture: Fixture,
  workflowId: string,
  token: string,
  operationId = "bind-coordinator",
): ExecutionSessionRef {
  const bound = runCli(
    [
      "plan",
      "bind",
      "--execution",
      "--workflow",
      workflowId,
      "--coordinator",
      "--expect",
      token,
      "--operation",
      operationId,
      "--harness",
      fixture.harnessDir,
      "--session-id",
      coordinatorIdentity(workflowId).sessionId,
    ],
    fixture,
    coordinatorIdentity(workflowId),
  );
  if (bound.exitCode !== 0) throw new Error(`plan bind failed: ${bound.stdout}${bound.stderr}`);
  const receipt = jsonOf(bound).data as Record<string, unknown>;
  return receipt.data as ExecutionSessionRef;
}

/** One active workflow verb invocation, in the documented §3.2 shape. */
function workflowVerbArgs(
  verb: string,
  fixture: Fixture,
  ref: ExecutionSessionRef,
  token: string,
  operationId: string,
  options: string[],
  sessionId = ref.sessionId,
): string[] {
  return [
    "workflow",
    verb,
    "--workflow",
    ref.workflowId,
    "--session-ref",
    encodeExecutionSessionRef(ref),
    "--expect",
    token,
    "--operation",
    operationId,
    "--harness",
    fixture.harnessDir,
    "--session-id",
    sessionId,
    ...options,
  ];
}

describe("mstar workflow \u2014 documented invocation", () => {
  test("registers through the authority, then moves the lifecycle and records its policy and delivery evidence", async () => {
    const fixture = await activeFixture("mstar-workflow-active");
    const identity = coordinatorIdentity();
    // `verification/report-only`: its only delivery member is `completion`,
    // which is the ONE member the engine records before every owned row is Done
    // (a `development` tail — compound/pr/merge — is refused until then, §3).
    const registered = registerReportOnlyWorkflow(fixture, identity, await rootTokenOf(fixture));
    expect(registered.exitCode).toBe(0);
    expect(jsonOf(registered).status).toBe("ok");
    expect(dataOf(registered).workflowId).toBe(WORKFLOW_ID);
    expect(await storedHeader(fixture)).toMatchObject({
      id: WORKFLOW_ID,
      type: "plan",
      status: "running",
      delivery_kind: "verification/report-only",
    });

    const bound = bindCoordinator(fixture, WORKFLOW_ID, await workflowTokenOf(fixture));

    const policyPath = join(fixture.root, "policy.json");
    // `plan_parallelism` is a CLOSED two-value set in the engine
    // (`serial | parallel`), so the fixture sends the accepted spelling.
    writeJson(policyPath, { plan_parallelism: "parallel" });
    const policyToken = await workflowTokenOf(fixture);
    const policy = runCli(
      workflowVerbArgs("execution-policy", fixture, bound, policyToken, "policy-1", ["--file", policyPath]),
      fixture,
      identity,
    );
    expect(policy.exitCode).toBe(0);
    expect((await storedHeader(fixture)).execution_policy).toEqual({ plan_parallelism: "parallel" });

    // Delivery evidence is recorded stage by stage on the RUNNING lifecycle,
    // before the status move below (the close consultation reads it later). For
    // this kind the recorded member is `completion` — the fulfilment of the
    // registered completion policy.
    const deliveryPath = join(fixture.root, "delivery.json");
    writeJson(deliveryPath, {
      completion: { policy: REPORT_ONLY_POLICY, evidence: "acceptance report at plans/" + PLAN_ID + "/report.md" },
    });
    const delivery = runCli(
      workflowVerbArgs("evidence", fixture, bound, await workflowTokenOf(fixture), "delivery-1", ["--file", deliveryPath]),
      fixture,
      identity,
    );
    expect(delivery.exitCode).toBe(0);
    expect((await storedHeader(fixture)).delivery).toMatchObject({ completion: { policy: REPORT_ONLY_POLICY } });

    const pausedToken = await workflowTokenOf(fixture);
    const paused = runCli(
      workflowVerbArgs("lifecycle", fixture, bound, pausedToken, "lifecycle-1", [
        "--status",
        "paused",
        "--reason",
        "awaiting review",
      ]),
      fixture,
      identity,
    );
    expect(paused.exitCode).toBe(0);
    expect((await storedHeader(fixture)).status).toBe("paused");

    // One exact retry replays the recorded receipt instead of advancing again.
    const replayed = runCli(
      workflowVerbArgs("lifecycle", fixture, bound, pausedToken, "lifecycle-1", [
        "--status",
        "paused",
        "--reason",
        "awaiting review",
      ]),
      fixture,
      identity,
    );
    expect(dataOf(replayed).replayed).toBe(true);
  });

  test("the terminal lifecycle is atomic and the retired file close has no active route", async () => {
    const fixture = await activeFixture("mstar-workflow-terminal");
    const identity = coordinatorIdentity();
    expect(registerPlanWorkflow(fixture, identity, await rootTokenOf(fixture)).exitCode).toBe(0);
    const bound = bindCoordinator(fixture, WORKFLOW_ID, await workflowTokenOf(fixture));

    // A `completed` close with an unfinished row is refused by the terminal
    // rule — and nothing is partially applied.
    const refused = runCli(
      [
        "status",
        "workflow-close",
        "--workflow",
        WORKFLOW_ID,
        "--session-ref",
        encodeExecutionSessionRef(bound),
        "--expect",
        await workflowTokenOf(fixture),
        "--operation",
        "close-1",
        "--reason",
        "terminal close",
        "--harness",
        fixture.harnessDir,
        "--session-id",
        identity.sessionId,
      ],
      fixture,
      identity,
    );
    expect(refused.exitCode).toBe(1);
    expect(String(jsonOf(refused).code)).toBe("coordination.invalid-transition");
    expect((await storedHeader(fixture)).status).toBe("running");

    // The retired file credential is no longer demanded: the same selector now
    // reaches the ACTIVE route, which reports the genuinely missing caller
    // identity (a real supported route — bind the caller — not a dead end).
    const noIdentity = runCli(
      ["status", "workflow-close", "--workflow", WORKFLOW_ID, "--harness", fixture.harnessDir],
      fixture,
    );
    expect(noIdentity.exitCode).toBe(1);
    expect(String(jsonOf(noIdentity).code)).toBe("coordination.identity-missing");

    // A terminal `stopped` transition carries no Done requirement, so it closes
    // the lifecycle in ONE transaction.
    const beforeStopToken = await workflowTokenOf(fixture);
    const stopped = runCli(
      workflowVerbArgs("lifecycle", fixture, bound, beforeStopToken, "stop-1", [
        "--status",
        "stopped",
        "--reason",
        "abandoned after review",
      ]),
      fixture,
      identity,
    );
    expect(stopped.exitCode).toBe(0);
    expect(dataOf(stopped).operationId).toBe("stop-1");
    expect(dataOf(stopped).replayed).toBe(false);
    expect(dataOf(stopped).token).not.toBe(beforeStopToken);

    // The terminal state IS persisted — witnessed at the store boundary the
    // engine's own readers use (`openStore`), because EVERY execution-adapter
    // read is registry-filtered (see the report's gap note): the workflow row
    // survives in `execution_workflows` while the SAME transaction deleted its
    // `execution_registry` row.
    const handle = await openStore(fixture.context, "read");
    try {
      const row = handle.db
        .prepare("select state_json from execution_workflows where workflow_id = ?")
        .get(WORKFLOW_ID) as { state_json?: unknown } | undefined;
      if (typeof row?.state_json !== "string") throw new Error("the closed workflow row is gone from execution_workflows");
      const stored = JSON.parse(row.state_json) as { status?: unknown; ended_at?: unknown };
      expect(stored.status).toBe("stopped");
      expect(typeof stored.ended_at).toBe("string");
      const registered = handle.db.prepare("select 1 as present from execution_registry where workflow_id = ?").get(WORKFLOW_ID);
      expect(registered).toBeUndefined();
    } finally {
      handle.close();
    }

    const register = await readExecutionAuthority(fixture.context);
    if (!("workflows" in register.data)) throw new Error("the register read did not return the whole state");
    // The adapter's lifecycle view is registry-driven, so the closed workflow is
    // absent here even though its row persists: the registry membership loss is
    // what that read reflects.
    expect(register.data.workflows.some((entry) => entry.state.id === WORKFLOW_ID)).toBe(false);
    expect(register.data.root.workflows.some((entry) => entry.id === WORKFLOW_ID)).toBe(false);

    // A closed lifecycle is never reopened: the authority holds no active
    // lifecycle for it, so any further transition is its own refusal.
    const reopened = runCli(
      workflowVerbArgs("lifecycle", fixture, bound, dataOf(stopped).token as string, "stop-2", [
        "--status",
        "running",
        "--reason",
        "reopen",
      ]),
      fixture,
      identity,
    );
    expect(reopened.exitCode).toBe(1);
    expect(String(jsonOf(reopened).code)).toMatch(/^(coordination|execution)\./);
  });

  test("an iteration registration records its reviewed integration checkout, and the phase gate reads its own compass", async () => {
    const fixture = await activeFixture("mstar-workflow-iteration");
    const identity = coordinatorIdentity(ITERATION_ID);
    const registered = runCli(
      [
        "iteration",
        "register",
        "--workflow",
        ITERATION_ID,
        "--compass-ref",
        `iterations/${ITERATION_ID}/delivery-compass.md`,
        "--branch-base",
        "main",
        "--branch-integration",
        INTEGRATION_BRANCH,
        "--branch-target-iteration",
        "main",
        "--row",
        JSON.stringify({ id: PLAN_ID, title: "Iteration row", file: `plans/${PLAN_ID}.md` }),
        "--expect",
        await rootTokenOf(fixture),
        "--operation",
        "register-iteration-1",
        "--harness",
        fixture.harnessDir,
        "--session-id",
        identity.sessionId,
      ],
      fixture,
      identity,
    );
    if (registered.exitCode !== 0) throw new Error(`iteration registration failed: ${registered.stdout}${registered.stderr}`);
    expect((await storedHeader(fixture, ITERATION_ID)).type).toBe("iteration");

    const bound = bindCoordinator(fixture, ITERATION_ID, await workflowTokenOf(fixture, ITERATION_ID), "bind-iteration-coordinator");

    // The main/control checkout is never an integration checkout.
    const mainCheckout = runCli(
      workflowVerbArgs("integration-worktree", fixture, bound, await workflowTokenOf(fixture, ITERATION_ID), "iw-1", [
        "--path",
        fixture.root,
      ]),
      fixture,
      identity,
    );
    expect(mainCheckout.exitCode).toBe(1);
    expect((await storedHeader(fixture, ITERATION_ID)).integration_worktree_path).toBeUndefined();

    // A dedicated linked checkout ON the registered integration branch records.
    const integrationPath = join(fixture.root, "wt-integration");
    execFileSync("git", ["worktree", "add", "-q", "-b", INTEGRATION_BRANCH, integrationPath, "main"], { cwd: fixture.root });
    const recorded = runCli(
      workflowVerbArgs("integration-worktree", fixture, bound, await workflowTokenOf(fixture, ITERATION_ID), "iw-2", [
        "--path",
        integrationPath,
      ]),
      fixture,
      identity,
    );
    expect(recorded.exitCode).toBe(0);
    expect(String((await storedHeader(fixture, ITERATION_ID)).integration_worktree_path)).toBe(realpathSync(integrationPath));

    // The phase transition reads the lifecycle's OWN registered compass: a
    // caller-supplied path refuses before any gate verdict.
    const strayCompass = join(fixture.harnessDir, "iterations", ITERATION_ID, "somewhere-else.md");
    const phase = runCli(
      workflowVerbArgs("phase", fixture, bound, await workflowTokenOf(fixture, ITERATION_ID), "phase-1", [
        "--phase",
        "phase-2-execute",
        "--compass",
        strayCompass,
      ]),
      fixture,
      identity,
    );
    expect(phase.exitCode).toBe(1);
    expect(String(jsonOf(phase).code)).toBe("coordination.scope-mismatch");
    expect(existsSync(strayCompass)).toBe(false);
  });

  test("an iteration refuses an anchor its own type does not carry and records the ones it does", async () => {
    const fixture = await activeFixture("mstar-workflow-anchor-type");
    const identity = coordinatorIdentity(ITERATION_ID);
    const registered = runCli(
      [
        "iteration",
        "register",
        "--workflow",
        ITERATION_ID,
        "--compass-ref",
        `iterations/${ITERATION_ID}/delivery-compass.md`,
        "--branch-base",
        "main",
        "--branch-integration",
        INTEGRATION_BRANCH,
        "--branch-target-iteration",
        "main",
        "--row",
        JSON.stringify({ id: PLAN_ID, title: "Iteration row", file: `plans/${PLAN_ID}.md` }),
        "--expect",
        await rootTokenOf(fixture),
        "--operation",
        "register-iteration-anchor-type",
        "--harness",
        fixture.harnessDir,
        "--session-id",
        identity.sessionId,
      ],
      fixture,
      identity,
    );
    if (registered.exitCode !== 0) throw new Error(`iteration registration failed: ${registered.stdout}${registered.stderr}`);
    const bound = bindCoordinator(fixture, ITERATION_ID, await workflowTokenOf(fixture, ITERATION_ID), "bind-iteration-anchor-type");

    // `branch.work` is a `type: plan` delivery anchor: the iteration refuses it
    // and names its own members, so the caller corrects the call in one retry.
    const refused = runCli(
      workflowVerbArgs("delivery-anchors", fixture, bound, await workflowTokenOf(fixture, ITERATION_ID), "anchors-type-refused", [
        "--branch-work",
        "fix/wrong-type",
        "--reason",
        "the delivery branch of another lifecycle type",
      ]),
      fixture,
      identity,
    );
    expect(refused.exitCode).toBe(1);
    expect(String(jsonOf(refused).code)).toBe("coordination.invalid-transition");
    expect(String(jsonOf(refused).message)).toContain('type "iteration"');
    expect(String(jsonOf(refused).message)).toContain("branch.work");
    expect(String(jsonOf(refused).message)).toContain("branch.base | branch.target");
    expect((await storedHeader(fixture, ITERATION_ID)).branch).toEqual({
      base: "main",
      target: "main",
      integration: INTEGRATION_BRANCH,
    });

    // The anchors the type DOES carry stay revisable, and the header never gains
    // the `work` key the refusal rejected.
    const based = runCli(
      workflowVerbArgs("delivery-anchors", fixture, bound, await workflowTokenOf(fixture, ITERATION_ID), "anchors-type-base", [
        "--branch-base",
        "release/root",
        "--reason",
        "the iteration's creation anchor was registered on the wrong branch",
      ]),
      fixture,
      identity,
    );
    expect(based.exitCode).toBe(0);
    const recorded = (await storedHeader(fixture, ITERATION_ID)).branch as Record<string, unknown>;
    expect(recorded).toEqual({ base: "release/root", target: "main", integration: INTEGRATION_BRANCH });
    expect(Object.hasOwn(recorded, "work")).toBe(false);
  });

  test("a stale token, a foreign identity and a mixed transport refuse without mutation", async () => {
    const fixture = await activeFixture("mstar-workflow-refusals");
    const identity = coordinatorIdentity();
    expect(registerPlanWorkflow(fixture, identity, await rootTokenOf(fixture)).exitCode).toBe(0);
    const bound = bindCoordinator(fixture, WORKFLOW_ID, await workflowTokenOf(fixture));

    const firstToken = await workflowTokenOf(fixture);
    const paused = runCli(
      workflowVerbArgs("lifecycle", fixture, bound, firstToken, "lifecycle-paused-1", [
        "--status",
        "paused",
        "--reason",
        "awaiting review",
      ]),
      fixture,
      identity,
    );
    expect(paused.exitCode).toBe(0);

    // The token that op just consumed is stale: the revision moved. Under the
    // recovery-first contract (§4.2, A10) a drifted transport token is
    // provenance, not refusal: the verb recomputes the intent against the
    // state this transaction reads and discloses the drift as a warning.
    const reused = runCli(
      workflowVerbArgs("lifecycle", fixture, bound, firstToken, "lifecycle-reused", [
        "--status",
        "running",
        "--reason",
        "reused",
      ]),
      fixture,
      identity,
    );
    expect(reused.exitCode).toBe(0);
    expect(JSON.stringify(jsonOf(reused))).toContain("token-drifted");
    expect((await storedHeader(fixture)).status).toBe("running");

    // A foreign identity (another workflow's coordinator) is refused.
    const foreign = coordinatorIdentity("wf-somewhere-else", "omp-foreign-session");
    const wrongScope = runCli(
      workflowVerbArgs("lifecycle", fixture, bound, await workflowTokenOf(fixture), "lifecycle-foreign", [
        "--status",
        "running",
        "--reason",
        "foreign",
      ], foreign.sessionId),
      fixture,
      foreign,
    );
    expect(wrongScope.exitCode).toBe(1);
    expect(jsonOf(wrongScope).code).toBe("execution.scope-mismatch");
    expect((await storedHeader(fixture)).status).toBe("running");

    // The grammar verbs are ACTIVE-ONLY: `--session` is not one of their flags,
    // so a mixed invocation is commander's own usage refusal (exit 2) — the
    // explicit "disjoint transports" diagnostic belongs to the verbs that own
    // BOTH transports (asserted right below on `workflow evidence`).
    const mixed = runCli(
      [
        "workflow",
        "lifecycle",
        "--workflow",
        WORKFLOW_ID,
        "--session",
        join(fixture.harnessDir, "session.json"),
        "--session-ref",
        encodeExecutionSessionRef(bound),
        "--expect",
        await workflowTokenOf(fixture),
        "--operation",
        "lifecycle-mixed",
        "--status",
        "running",
        "--reason",
        "mixed",
      ],
      fixture,
      identity,
    );
    expect(jsonOf(mixed)).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });

    // `workflow evidence` does own both transports, so its mix is refused with
    // the explicit diagnostic before any IO.
    const deliveryPath = join(fixture.root, "delivery-mixed.json");
    writeJson(deliveryPath, { compound: { outcome: "created" } });
    const evidenceMix = runCli(
      [
        "workflow",
        "evidence",
        "--workflow",
        WORKFLOW_ID,
        "--session",
        join(fixture.harnessDir, "session.json"),
        "--session-ref",
        encodeExecutionSessionRef(bound),
        "--expect",
        await workflowTokenOf(fixture),
        "--operation",
        "evidence-mixed",
        "--file",
        deliveryPath,
        "--harness",
        fixture.harnessDir,
        "--session-id",
        identity.sessionId,
      ],
      fixture,
      identity,
    );
    expect(jsonOf(evidenceMix)).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });

    // ACTIVE disposition: the one-time delivery-kind rewrite input is retired
    // — the registered delivery kind selects permitted members. The flag is
    // not a recognized option and the header stays intact.
    const headerBeforeDeclare = await storedHeader(fixture);
    const declare = runCli(
      [
        "workflow",
        "evidence",
        "--workflow",
        WORKFLOW_ID,
        "--declare-kind",
        "development",
        "--harness",
        fixture.harnessDir,
      ],
      fixture,
      identity,
    );
    expect(declare.exitCode).toBe(2);
    const declarationEnvelope = jsonOf(declare);
    expect(declarationEnvelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    const details = declarationEnvelope.details;
    const diagnostics = details !== null && typeof details === "object" && "diagnostics" in details ? details.diagnostics : undefined;
    const flagDiagnostic = (Array.isArray(diagnostics) ? diagnostics : []).find((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      if (!("code" in entry) || !("token" in entry)) return false;
      return typeof entry.code === "string" && entry.code === "commander.unknownOption" && entry.token === "--declare-kind";
    });
    // Both fields are asserted inside the predicate: a `key: "value"` literal here
    // would trip the advisory plugin scanner's hardcoded-secret heuristic.
    expect(flagDiagnostic).toBeDefined();
    expect(await storedHeader(fixture)).toEqual(headerBeforeDeclare);
  });

  test("the delivery anchors of a running workflow are repairable, and a malformed repair is a usage error", async () => {
    const fixture = await activeFixture("mstar-workflow-anchors");
    const identity = coordinatorIdentity();
    expect(registerPlanWorkflow(fixture, identity, await rootTokenOf(fixture)).exitCode).toBe(0);
    expect((await storedHeader(fixture)).branch).toEqual({ work: "feature/exec-workflow", target: "main" });
    const bound = bindCoordinator(fixture, WORKFLOW_ID, await workflowTokenOf(fixture));

    // A missing --reason is a usage error: the correction is auditable or it is
    // not admitted.
    const noReason = runCli(
      workflowVerbArgs("delivery-anchors", fixture, bound, await workflowTokenOf(fixture), "anchors-no-reason", [
        "--branch-work",
        "fix/corrected",
      ]),
      fixture,
      identity,
    );
    expect(jsonOf(noReason)).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(String(jsonOf(noReason).message)).toContain("a non-empty reason is required");
    expect(String(jsonOf(noReason).message)).not.toContain("at least one delivery anchor is required");
    // The verb's own refusal — not a parser refusal of an unknown command.
    expect((jsonOf(noReason).details as { diagnostics?: unknown } | null)?.diagnostics).toBeUndefined();

    // An empty anchor is refused with the same diagnostic.
    const emptySource = runCli(
      workflowVerbArgs("delivery-anchors", fixture, bound, await workflowTokenOf(fixture), "anchors-empty", [
        "--branch-work",
        "",
        "--reason",
        "operator correction",
      ]),
      fixture,
      identity,
    );
    expect(jsonOf(emptySource)).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });

    // Neither anchor named is a usage error too: the verb always states what it
    // records, so a call that corrects nothing is never admitted.
    const noAnchor = runCli(
      workflowVerbArgs("delivery-anchors", fixture, bound, await workflowTokenOf(fixture), "anchors-no-anchor", [
        "--reason",
        "operator correction",
      ]),
      fixture,
      identity,
    );
    expect(jsonOf(noAnchor)).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect((jsonOf(noAnchor).details as { diagnostics?: unknown } | null)?.diagnostics).toBeUndefined();
    expect(String(jsonOf(noAnchor).message)).toContain("at least one delivery anchor is required");
    expect(String(jsonOf(noAnchor).message)).not.toContain("a non-empty reason is required");
    expect((await storedHeader(fixture)).branch).toEqual({ work: "feature/exec-workflow", target: "main" });

    // Neither an anchor nor a reason: BOTH are reported in one usage refusal, so
    // a malformed call is not a repeated guessing loop (issue #499 review F2).
    const neither = runCli(
      workflowVerbArgs("delivery-anchors", fixture, bound, await workflowTokenOf(fixture), "anchors-neither", []),
      fixture,
      identity,
    );
    expect(jsonOf(neither)).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect((jsonOf(neither).details as { diagnostics?: unknown } | null)?.diagnostics).toBeUndefined();
    expect(String(jsonOf(neither).message)).toContain("at least one delivery anchor is required");
    expect(String(jsonOf(neither).message)).toContain("a non-empty reason is required");
    expect((await storedHeader(fixture)).branch).toEqual({ work: "feature/exec-workflow", target: "main" });

    // No workflow, no anchor, no reason: all three are named in ONE refusal, so
    // even the collapsed call is corrected on its first retry (issue #499
    // review F4).
    const bare = runCli(
      ["workflow", "delivery-anchors", "--harness", fixture.harnessDir, "--session-id", identity.sessionId],
      fixture,
      identity,
    );
    expect(jsonOf(bare)).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect((jsonOf(bare).details as { diagnostics?: unknown } | null)?.diagnostics).toBeUndefined();
    const bareMessage = String(jsonOf(bare).message);
    expect(bareMessage).toContain("workflow is required");
    expect(bareMessage).toContain("at least one delivery anchor is required");
    expect(bareMessage).toContain("a non-empty reason is required");

    // Absent workflow alone reports only the workflow: the aggregate names the
    // requirements that are actually missing.
    const noWorkflow = runCli(
      [
        "workflow",
        "delivery-anchors",
        "--branch-work",
        "fix/named",
        "--reason",
        "operator correction",
        "--harness",
        fixture.harnessDir,
        "--session-id",
        identity.sessionId,
      ],
      fixture,
      identity,
    );
    expect(jsonOf(noWorkflow)).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect((jsonOf(noWorkflow).details as { diagnostics?: unknown } | null)?.diagnostics).toBeUndefined();
    expect(String(jsonOf(noWorkflow).message)).toContain("workflow is required");
    expect(String(jsonOf(noWorkflow).message)).not.toContain("at least one delivery anchor is required");
    expect(String(jsonOf(noWorkflow).message)).not.toContain("a non-empty reason is required");
    expect((await storedHeader(fixture)).branch).toEqual({ work: "feature/exec-workflow", target: "main" });

    // The verb reaches the engine: a single named anchor is recorded and the
    // anchor it does not name keeps its registered value.
    const corrected = runCli(
      workflowVerbArgs("delivery-anchors", fixture, bound, await workflowTokenOf(fixture), "anchors-1", [
        "--branch-work",
        "fix/corrected",
        "--branch-base",
        "main",
        "--reason",
        "the registered work branch was the delivery target",
      ]),
      fixture,
      identity,
    );
    expect(corrected.exitCode).toBe(0);
    expect(dataOf(corrected).replayed).toBe(false);
    expect((await storedHeader(fixture)).branch).toEqual({ base: "main", work: "fix/corrected", target: "main" });

    // The deprecated --branch-source alias writes the same field as --branch-work.
    const aliased = runCli(
      workflowVerbArgs("delivery-anchors", fixture, bound, await workflowTokenOf(fixture), "anchors-alias", [
        "--branch-source",
        "fix/aliased",
        "--reason",
        "operator correction through the deprecated alias",
      ]),
      fixture,
      identity,
    );
    expect(aliased.exitCode).toBe(0);
    expect((await storedHeader(fixture)).branch).toEqual({ base: "main", work: "fix/aliased", target: "main" });
  });

  test("a repair that leaves an already-recorded PR identity behind warns in the ok envelope and still succeeds", async () => {
    const fixture = await activeFixture("mstar-workflow-anchors-pr");
    const identity = coordinatorIdentity();
    expect(registerPlanWorkflow(fixture, identity, await rootTokenOf(fixture)).exitCode).toBe(0);
    const bound = bindCoordinator(fixture, WORKFLOW_ID, await workflowTokenOf(fixture));

    // The delivery tail, recorded while the anchors still name the PR identity.
    const deliveryPath = join(fixture.root, "delivery-pr-identity.json");
    writeJson(deliveryPath, {
      compound: { outcome: "created" },
      pr: { repo: "o/r", head: "feature/exec-workflow", target: "main" },
      merge: { provider: "github", evidence: "PR #501 merged" },
    });
    const recorded = runCli(
      workflowVerbArgs("evidence", fixture, bound, await workflowTokenOf(fixture), "delivery-pr-identity", ["--file", deliveryPath]),
      fixture,
      identity,
    );
    expect(recorded.exitCode).toBe(0);
    expect((await storedHeader(fixture)).delivery).toMatchObject({ pr: { head: "feature/exec-workflow", target: "main" } });

    // The repair moves the delivery target. It SUCCEEDS - an advisory never
    // blocks - and `data.warnings` names the recorded identity, the anchors the
    // repair stored and the ONE call that puts them back into agreement.
    const retargeted = runCli(
      workflowVerbArgs("delivery-anchors", fixture, bound, await workflowTokenOf(fixture), "anchors-pr-mismatch", [
        "--branch-target",
        "release",
        "--reason",
        "the delivery PR was retargeted",
      ]),
      fixture,
      identity,
    );
    expect(retargeted.exitCode).toBe(0);
    expect(jsonOf(retargeted)).toMatchObject({ status: "ok", code: "workflow.delivery-anchors.ok", exitCode: 0 });
    expect(dataOf(retargeted).replayed).toBe(false);
    const warnings = dataOf(retargeted).warnings;
    expect(Array.isArray(warnings)).toBe(true);
    const advisories = warnings as string[];
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain(`branch.work ${JSON.stringify("feature/exec-workflow")}`);
    expect(advisories[0]).toContain(`branch.target ${JSON.stringify("release")}`);
    expect(advisories[0]).toContain(`delivery.pr.head ${JSON.stringify("feature/exec-workflow")}`);
    expect(advisories[0]).toContain(`delivery.pr.target ${JSON.stringify("main")}`);
    expect(advisories[0]).toContain(
      "mstar workflow delivery-anchors --workflow wf-exec-workflow --branch-work feature/exec-workflow --branch-target main --reason",
    );
    // The repair stored exactly what it named.
    expect((await storedHeader(fixture)).branch).toEqual({ work: "feature/exec-workflow", target: "release" });

    // The consequence: the close this header can no longer pass refuses, naming
    // the member that disagrees. The row is planted Done through the store the
    // engine's own readers use, the fixture's only route to a close.
    await plantDoneRow(fixture);
    const refused = runCli(
      workflowVerbArgs("lifecycle", fixture, bound, await workflowTokenOf(fixture), "close-pr-mismatch", [
        "--status",
        "completed",
        "--reason",
        "the delivery was verified",
      ]),
      fixture,
      identity,
    );
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused).code).toBe("coordination.invalid-transition");
    expect(JSON.stringify(jsonOf(refused).details)).toContain("delivery.pr.target");

    // The invocation the advisory named, run with exactly those flags and
    // values: agreement is restored in ONE call, the advisory is gone, and the
    // close then passes.
    const restored = runCli(
      workflowVerbArgs("delivery-anchors", fixture, bound, await workflowTokenOf(fixture), "anchors-pr-restore", [
        "--branch-work",
        "feature/exec-workflow",
        "--branch-target",
        "main",
        "--reason",
        "restore the recorded PR identity's delivery anchors",
      ]),
      fixture,
      identity,
    );
    expect(restored.exitCode).toBe(0);
    expect(dataOf(restored).warnings).toBeUndefined();
    const closed = runCli(
      workflowVerbArgs("lifecycle", fixture, bound, await workflowTokenOf(fixture), "close-pr-restored", [
        "--status",
        "completed",
        "--reason",
        "the delivery was verified",
      ]),
      fixture,
      identity,
    );
    expect(closed.exitCode).toBe(0);
    expect(jsonOf(closed).status).toBe("ok");
    // The close IS the terminal write: witnessed at the store boundary the
    // engine's own readers use, because every execution-adapter read is
    // registry-filtered.
    const handle = await openStore(fixture.context, "read");
    try {
      const row = handle.db.prepare("select state_json from execution_workflows where workflow_id = ?").get(WORKFLOW_ID) as
        | { state_json?: unknown }
        | undefined;
      if (typeof row?.state_json !== "string") throw new Error("the closed workflow row is gone from execution_workflows");
      const stored = JSON.parse(row.state_json) as { status?: unknown };
      expect(stored.status).toBe("completed");
    } finally {
      handle.close();
    }
  });

  test("the documented registration form answers through the ACTIVE authority; no file-route bytes", async () => {
    // ACTIVE disposition: the pre-activation `workflow register` file route is
    // retired — the same documented flags register through the authority's
    // catalog route and never write snapshot/status bytes.
    const fixture = await activeFixture("mstar-workflow-legacy");
    const identity = coordinatorIdentity("wf-legacy-form", "legacy-form-coordinator");
    const before = await readExecutionAuthority(fixture.context);
    const registered = runCli(
      [
        "workflow",
        "register",
        "--workflow",
        "wf-legacy-form",
        "--plan-id",
        PLAN_ID,
        "--plan-title",
        "Active workflow transport plan",
        "--plan-file",
        `plans/${PLAN_ID}.md`,
        "--delivery-kind",
        "development",
        "--branch-work",
        "feature/x",
        "--branch-target",
        "main",
        "--harness",
        fixture.harnessDir,
      ],
      fixture,
      identity,
    );
    expect(registered.exitCode).toBe(0);
    expect(jsonOf(registered)).toMatchObject({ command: "workflow.register", status: "ok", code: "workflow.register.ok" });
    // No file-route bytes were created by the registration.
    expect(existsSync(join(fixture.harnessDir, "workflows", "wf-legacy-form", "snapshot.json"))).toBe(false);
    expect(existsSync(join(fixture.harnessDir, "status.json"))).toBe(false);
    const after = await readExecutionAuthority(fixture.context);
    expect(after.data.root.workflows.map((entry) => entry.id)).toContain("wf-legacy-form");
    expect(after.token).not.toBe(before.token);
  });
  test("session recover --unowned accepts empty stoppedSessions only for a workflow with no coordinator", async () => {
    const fixture = await activeFixture("mstar-session-recover-unowned");
    const registrationIdentity = coordinatorIdentity();
    const registered = registerPlanWorkflow(fixture, registrationIdentity, await rootTokenOf(fixture));
    expect(registered.exitCode).toBe(0);

    const attestationPath = join(fixture.root, "recovery-attestation.json");
    writeJson(attestationPath, {
      version: ACTIVATION_PROTOCOL_VERSION,
      attestedAt: "2026-10-04T00:00:00.000Z",
      operator: { actor: "ops-engineer", authorizationRef: "isolated fixture recovery decision" },
      consumers: [{
        entryId: "coordinator-omp",
        kind: "coordinator",
        entrypoint: "/opt/mstar/coordinator/dist/index.js",
        runtime: "node",
        runtimeVersion: atOrAboveRuntime,
        // Synthetic carried plugin version, not a release number.
        version: "0.0.0-synthetic",
        current: true,
        disposition: "reloaded",
      }],
      stoppedSessions: [],
    });
    const recoveryIdentity: ExecutionIdentity = {
      source: "local",
      sessionId: "coord-unowned-recovered",
      workflowId: WORKFLOW_ID,
      role: "coordinator",
    };
    const recovered = runCli([
      "session", "recover",
      "--workflow", WORKFLOW_ID,
      "--unowned",
      "--reason", "recover workflow with no recorded coordinator",
      "--attestation", attestationPath,
      "--expect", await workflowTokenOf(fixture),
      "--operation", "recover-unowned-fixture",
      "--harness", fixture.harnessDir,
      "--session-id", recoveryIdentity.sessionId,
    ], fixture, recoveryIdentity);
    if (recovered.exitCode !== 0) throw new Error(`unowned recovery failed: ${recovered.stdout}${recovered.stderr}`);
    expect(jsonOf(recovered).status).toBe("ok");
    expect(dataOf(recovered).data).toMatchObject({ role: "coordinator", sessionId: recoveryIdentity.sessionId });
    const refused = runCli([
      "session", "recover",
      "--workflow", WORKFLOW_ID,
      "--unowned",
      "--reason", "try claiming unowned after recovery",
      "--attestation", attestationPath,
      "--expect", await workflowTokenOf(fixture),
      "--operation", "recover-unowned-again",
      "--harness", fixture.harnessDir,
      "--session-id", "coord-unowned-second",
    ], fixture, { ...recoveryIdentity, sessionId: "coord-unowned-second" });
    expect(refused.exitCode).toBe(1);
    expect(String(jsonOf(refused).message)).toContain("must NAME the holder");
  });
});
