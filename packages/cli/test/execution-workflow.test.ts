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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  encodeExecutionSessionRef,
  initializeExecutionAuthority,
  initializeStore,
  readExecutionAuthority,
  serializeExecutionValue,
  type ExecutionIdentity,
  type ExecutionSessionRef,
  type ExecutionState,
  type StoreContext,
} from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

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

function coordinatorIdentity(workflowId = WORKFLOW_ID): ExecutionIdentity {
  return { source: "local", sessionId: COORDINATOR_ID, workflowId, role: "coordinator", planId: null };
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
  await initializeExecutionAuthority(context);
  const planMarkdown = join(harnessDir, "plans", `${PLAN_ID}.md`);
  writeText(planMarkdown, `# Plan ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n`);
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
      "--branch-source",
      "feature/exec-workflow",
      "--branch-target",
      "main",
      "--expect",
      rootToken,
      "--operation",
      operationId,
      "--harness",
      fixture.harnessDir,
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
      "--json",
    ],
    fixture,
    identity,
  );
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
      "--json",
    ],
    fixture,
    coordinatorIdentity(workflowId),
  );
  expect(bound.exitCode).toBe(0);
  return jsonOf(bound).data as unknown as ExecutionSessionRef;
}

/** One active workflow verb invocation, in the documented §3.2 shape. */
function workflowVerbArgs(
  verb: string,
  fixture: Fixture,
  ref: ExecutionSessionRef,
  token: string,
  operationId: string,
  options: string[],
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
    ...options,
    "--json",
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
    expect(jsonOf(registered).route).toBe("execution");
    expect((await storedHeader(fixture)) as Record<string, unknown>).toMatchObject({
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
    expect(replayed.exitCode).toBe(0);
    expect(jsonOf(replayed).replayed).toBe(true);
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
        "--json",
      ],
      fixture,
      identity,
    );
    expect(refused.exitCode).toBe(1);
    expect(String(jsonOf(refused).code)).toBe("coordination.invalid-transition");
    expect((await storedHeader(fixture)).status).toBe("running");

    // The retired file close has no route at all on an active authority.
    const legacy = runCli(
      ["status", "workflow-close", "--workflow", WORKFLOW_ID, "--harness", fixture.harnessDir, "--json"],
      fixture,
    );
    expect(legacy.exitCode).toBe(1);
    expect(String(jsonOf(legacy).code)).toBe("execution.consumer-not-ready");

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
    expect(jsonOf(stopped).operation_id).toBe("stop-1");
    expect(jsonOf(stopped).replayed).toBe(false);
    // The accepted transaction advanced the store: its root token moved.
    expect(jsonOf(stopped).token).not.toBe(beforeStopToken);
    // The committed graph this transition returned no longer holds the
    // lifecycle: a terminal close drops the registry membership in the SAME
    // transaction, and the active adapter keeps no terminal lifecycle — which is
    // exactly why the workflow-id read afterwards must answer not-found.
    const committed = dataOf(stopped) as unknown as ExecutionState;
    expect(committed.workflows.some((entry) => entry.state.id === WORKFLOW_ID)).toBe(false);

    const register = await readExecutionAuthority(fixture.context);
    if (!("workflows" in register.data)) throw new Error("the register read did not return the whole state");
    expect(register.data.workflows.some((entry) => entry.state.id === WORKFLOW_ID)).toBe(false);

    // A closed lifecycle is never reopened: the authority holds no active
    // lifecycle for it, so any further transition is its own refusal.
    const reopened = runCli(
      workflowVerbArgs("lifecycle", fixture, bound, jsonOf(stopped).token as string, "stop-2", [
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
        "--branch-target",
        "main",
        "--row",
        JSON.stringify({ id: PLAN_ID, title: "Iteration row", file: `plans/${PLAN_ID}.md` }),
        "--expect",
        await rootTokenOf(fixture),
        "--operation",
        "register-iteration-1",
        "--harness",
        fixture.harnessDir,
        "--json",
      ],
      fixture,
      identity,
    );
    expect(registered.exitCode).toBe(0);
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

    // The token that op just consumed is stale: the revision moved.
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
    expect(reused.exitCode).toBe(1);
    expect(String(jsonOf(reused).code)).toMatch(/^execution\./);
    expect((await storedHeader(fixture)).status).toBe("paused");

    // A foreign identity (another workflow's coordinator) is refused.
    const foreign = coordinatorIdentity("wf-somewhere-else");
    const wrongScope = runCli(
      workflowVerbArgs("lifecycle", fixture, bound, await workflowTokenOf(fixture), "lifecycle-foreign", [
        "--status",
        "running",
        "--reason",
        "foreign",
      ]),
      fixture,
      foreign,
    );
    expect(wrongScope.exitCode).toBe(1);
    expect(String(jsonOf(wrongScope).code)).toMatch(/^coordination\./);
    expect((await storedHeader(fixture)).status).toBe("paused");

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
    expect(mixed.exitCode).toBe(2);
    expect(mixed.stderr).toContain("--session");

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
      ],
      fixture,
      identity,
    );
    expect(evidenceMix.exitCode).toBe(2);
    expect(evidenceMix.stderr).toContain("disjoint transports");

    // The one-time delivery-kind rewrite has no active operation.
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
        "--json",
      ],
      fixture,
      identity,
    );
    expect(declare.exitCode).toBe(1);
    expect(String(jsonOf(declare).code)).toBe("execution.consumer-not-ready");
    expect((await storedHeader(fixture)).status).toBe("paused");
  });

  test("the retired pre-activation registration path is refused while the authority is active", async () => {
    const fixture = await activeFixture("mstar-workflow-legacy");
    const identity = coordinatorIdentity();
    const legacy = runCli(
      [
        "workflow",
        "register",
        "--workflow",
        "wf-legacy-form",
        "--plan-id",
        PLAN_ID,
        "--plan-title",
        "Legacy form",
        "--plan-file",
        `plans/${PLAN_ID}.md`,
        "--delivery-kind",
        "development",
        "--branch-source",
        "feature/x",
        "--branch-target",
        "main",
        "--harness",
        fixture.harnessDir,
        "--json",
      ],
      fixture,
      identity,
    );
    expect(legacy.exitCode).toBe(1);
    expect(String(jsonOf(legacy).code)).toBe("execution.consumer-not-ready");
    // No file-route bytes were created by the refusal.
    expect(existsSync(join(fixture.harnessDir, "workflows", "wf-legacy-form", "snapshot.json"))).toBe(false);
    expect(existsSync(join(fixture.harnessDir, "status.json"))).toBe(false);
  });
});
