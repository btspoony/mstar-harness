import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  encodeExecutionSessionRef,
  executionContextFor,
  initializeExecutionAuthority,
  initializeStore,
  mutateExecutionPlan,
  readExecutionPlan,
  registerCatalogEntity,
  storeDbPath,
  type ExecutionCaller,
  type ExecutionSessionRef,
  type ExecutionToken,
  type StoreContext,
  type WorkflowEntry,
  type WorkflowSnapshot,
} from "@mstar-harness/engine";
import { DatabaseSync } from "node:sqlite";
import { executeCommand } from "./definitions.js";
import type { CommandEnvelope, InvocationContext } from "./types.js";

const TS = "2026-01-02T03:04:05.000Z";
const WORKFLOW_ID = "wf-1";
const PLAN_ID = "p-1";
const COORDINATOR_ID = "host-coord";
const PLAN_PM_ID = "host-plan";
const PLAN2_ID = "p-2";
const PLAN2_PM_ID = "host-plan-2";
const GHOST_PM_ID = "host-plan-ghost";
const SOURCE_BRANCH = `feature/${PLAN_ID}`;
const INTEGRATION_BRANCH = `integration/${WORKFLOW_ID}`;
const COMPASS_REF = "iterations/iter-20260101-plan/delivery-compass.md";

const PROGRESS = { status: "InProgress", summary: "sparse intent", evidence_paths: [] };

const ROOT = mkdtempSync(join(tmpdir(), "mstar-sparse-plan-admission-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let scratch: string | null = null;
function scratchRoot(): string {
  if (scratch === null) scratch = mkdtempSync(join(ROOT, "fixture-"));
  return scratch;
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * One real isolated ACTIVE execution store holding one prepared workflow plan
 * (`wf-1`/`p-1`) with its coordinator and plan-pm seats bound through the real
 * verbs — the same shape the engine's own `preparedPlanFixture` builds.
 */
async function buildFixture(label: string): Promise<{
  context: StoreContext;
  repoRoot: string;
  coordinatorRef: ExecutionSessionRef;
  planRef: ExecutionSessionRef;
  plan2Ref: ExecutionSessionRef;
}> {
  const repoRoot = realpathSync(mkdtempSync(join(scratchRoot(), `${label}-`)));
  runGit(["init", "-q", "-b", "main"], repoRoot);
  runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], repoRoot);
  mkdirSync(join(repoRoot, ".mstar"), { recursive: true });
  const context: StoreContext = { harnessDir: repoRoot };
  const store = await initializeStore(context);
  store.close();
  const initialized = await initializeExecutionAuthority(context);
  const integrationPath = join(repoRoot, "wt-integration");
  runGit(["worktree", "add", "-q", "-b", INTEGRATION_BRANCH, integrationPath], repoRoot);
  writeText(join(repoRoot, ".mstar", COMPASS_REF), "---\nstatus: active\nplans:\n  - p-1\ntargetBranch: main\n---\n");
  await registerCatalogEntity(
    context,
    { kind: "plan", id: PLAN_ID, title: `${PLAN_ID} title`, rootKind: "plans", relativePath: `plans/${PLAN_ID}.md` },
    { operationId: `register-${label}`, actor: "sparse-plan-admission.test" },
  );
  await registerCatalogEntity(
    context,
    { kind: "plan", id: PLAN2_ID, title: `${PLAN2_ID} title`, rootKind: "plans", relativePath: `plans/${PLAN2_ID}.md` },
    { operationId: `register-${PLAN2_ID}-${label}`, actor: "sparse-plan-admission.test" },
  );

  const coordinatorCaller: ExecutionCaller = { sessionId: COORDINATOR_ID, role: "coordinator", workflowId: WORKFLOW_ID, planId: null };
  const coordinatorIdentity = { source: "local" as const, ...coordinatorCaller };
  // The snapshot literal is the engine's own workflow shape; the external type
  // is stricter than the fixture needs, so the cast is local and reasoned.
  const entry: WorkflowEntry = { id: WORKFLOW_ID, type: "plan", started_at: TS, dir: `workflows/${WORKFLOW_ID}` };
  const snapshot = {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    status: "running",
    started_at: TS,
    updated_at: TS,
    phase: "phase-1-prepare",
    project: "harness",
    compass_ref: COMPASS_REF,
    delivery_kind: "development",
    branch: { base: "main", source: SOURCE_BRANCH, target: "main", integration: INTEGRATION_BRANCH },
    integration_worktree_path: integrationPath,
    execution_policy: { plan_parallelism: "serial", worktree_mode: "required" },
    plans: [
      { id: PLAN_ID, title: `${PLAN_ID} title`, file: `plans/${PLAN_ID}.md`, status: "Todo" },
      { id: PLAN2_ID, title: `${PLAN2_ID} title`, file: `plans/${PLAN2_ID}.md`, status: "Todo" },
    ],
  } as unknown as WorkflowSnapshot;
  const created = await createExecutionWorkflow(executionContextFor(context, coordinatorIdentity), { entry, snapshot, expected: initialized.token, operationId: `create-${label}` });
  const coordinatorBind = await bindExecutionSession(executionContextFor(context, coordinatorIdentity), {
    workflowId: WORKFLOW_ID,
    planId: null,
    role: "coordinator",
    expected: created.data.workflows[0]!.workflowToken,
    operationId: `bind-coordinator-${label}`,
  });

  // The store's own control harness root is the `.mstar` directory under the
  // repo root; the sealed Assignment must name exactly that root.
  const harnessRoot = join(repoRoot, ".mstar");
  const coordinatorContext = executionContextFor(context, coordinatorIdentity);
  for (const planId of [PLAN_ID, PLAN2_ID] as const) {
    const planPath = join(harnessRoot, "plans", `${planId}.md`);
    writeText(planPath, `# ${planId}\n`);
    const assignmentPath = join(harnessRoot, "assignments", `${planId}.md`);
    writeText(
      assignmentPath,
      [
        "**Execution scope**: plan",
        "**Execute as**: project-manager",
        "**Delegation**: allowed",
        `**Control harness root**: ${harnessRoot}`,
        `**Workflow id**: ${WORKFLOW_ID}`,
        `**Plan id**: ${planId}`,
        `**Plan Path**: ${planPath}`,
        `**Worktree path**: ${join(harnessRoot, "worktrees", planId)}`,
        `**Working branch**: feature/${planId}`,
        `**SDD dir**: ${join(harnessRoot, "sdd", planId)}`,
        "**QA gate**: mandatory",
        "**Findings cleanup**: zero-residual",
        "**Prepare gate**: go",
        "",
      ].join("\n"),
    );
    const planToken: ExecutionToken = (await readExecutionPlan(coordinatorContext, coordinatorBind.data, planId)).token;
    await mutateExecutionPlan(coordinatorContext, {
      operationId: `prepare-${planId}-${label}`,
      session: coordinatorBind.data,
      expected: planToken,
      planId,
      operation: { kind: "prepare", assignmentPath },
    });
  }
  const planTokenAfterPrepare: ExecutionToken = (await readExecutionPlan(coordinatorContext, coordinatorBind.data, PLAN_ID)).token;
  const planBind = await bindExecutionSession(
    executionContextFor(context, { source: "local", sessionId: PLAN_PM_ID, role: "plan-pm", workflowId: WORKFLOW_ID, planId: PLAN_ID }),
    { workflowId: WORKFLOW_ID, planId: PLAN_ID, role: "plan-pm", expected: planTokenAfterPrepare, operationId: `bind-plan-${label}` },
  );
  const plan2Token: ExecutionToken = (await readExecutionPlan(coordinatorContext, coordinatorBind.data, PLAN2_ID)).token;
  const plan2Bind = await bindExecutionSession(
    executionContextFor(context, { source: "local", sessionId: PLAN2_PM_ID, role: "plan-pm", workflowId: WORKFLOW_ID, planId: PLAN2_ID }),
    { workflowId: WORKFLOW_ID, planId: PLAN2_ID, role: "plan-pm", expected: plan2Token, operationId: `bind-${PLAN2_ID}-${label}` },
  );
  return { context, repoRoot, coordinatorRef: coordinatorBind.data, planRef: planBind.data, plan2Ref: plan2Bind.data };
}

async function runPlanCommand(repoRoot: string, input: Record<string, unknown>, sessionId?: string): Promise<CommandEnvelope> {
  const context: InvocationContext = {
    cwd: repoRoot,
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    ...(sessionId === undefined ? {} : { sessionId }),
    effects: {
      readInput: async () => "",
      spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
      startDashboard: async () => {
        throw new Error("unused in sparse plan admission tests");
      },
      openBrowser: async () => {
        throw new Error("unused in sparse plan admission tests");
      },
    },
  };
  return executeCommand("plan.progress", input, context);
}

// ok(id, receipt) wraps the engine's whole ExecutionReceipt: its own `.data`
// is the ExecutionPlanView, while replayed/token/epoch sit beside it.
type PlanReceiptData = {
  data?: {
    plan?: { status?: string };
    coordination?: { progress?: { summary?: string } };
  };
  replayed?: boolean;
};
type GroupedFacts = { current_facts?: unknown[]; sources_tried?: unknown[] };

/** Raw row counts proving a refused call changed nothing (no receipt, no binding, no plan write). */
function executionFootprint(context: StoreContext): { operations: number; sessions: number; plans: number; leases: number } {
  const db = new DatabaseSync(storeDbPath(context));
  try {
    const count = (sql: string): number => {
      const row = db.prepare(sql).get() as { n: number };
      return Number(row.n);
    };
    return {
      operations: count("select count(*) as n from execution_operations"),
      sessions: count("select count(*) as n from execution_sessions"),
      plans: count("select count(*) as n from execution_plans"),
      leases: count("select count(*) as n from execution_leases"),
    };
  } finally {
    db.close();
  }
}

/** The raw sealed state of one plan row, compared byte-for-byte across a refusal. */
function planRowJson(context: StoreContext, planId: string): { state: string; coordination: string } {
  const db = new DatabaseSync(storeDbPath(context));
  try {
    const row = db
      .prepare("select state_json, coordination_json from execution_plans where plan_id = ?")
      .get(planId) as { state_json: string; coordination_json: string };
    return { state: String(row.state_json), coordination: String(row.coordination_json) };
  } finally {
    db.close();
  }
}

/** The committed receipt row of one operation id, byte-for-byte; null when none exists. */
function operationReceiptJson(context: StoreContext, operationId: string): string | null {
  const db = new DatabaseSync(storeDbPath(context));
  try {
    const row = db
      .prepare("select request_hash, result_json, committed_at from execution_operations where operation_id = ?")
      .get(operationId) as { request_hash: string; result_json: string; committed_at: string } | undefined;
    return row === undefined ? null : JSON.stringify(row);
  } finally {
    db.close();
  }
}

describe("sparse plan intent admission", () => {
  test("a sparse active operation with only sessionRef, operation id and payload is admitted by the engine", async () => {
    const { repoRoot, planRef } = await buildFixture("sparse-accepted");
    const envelope = await runPlanCommand(repoRoot, { sessionRef: encodeExecutionSessionRef(planRef), operation: "op-sparse-admitted", progress: PROGRESS }, PLAN_PM_ID);
    // RED (current transport gate): status usage, "active operation requires
    // runtime session identity, sessionRef, full execution token and operation
    // id" — the engine's sparse resolver never runs. Target contract: the
    // engine admits it and the plan moves to InProgress.
    expect(envelope.status).toBe("ok");
    if (envelope.status !== "ok") throw new Error(envelope.message);
    // executeCommand returns CommandEnvelope<unknown>; the receipt shape is
    // the engine's ExecutionReceipt<ExecutionPlanView>.
    const receipt = envelope.data as PlanReceiptData;
    expect(receipt.replayed).toBe(false);
    expect(receipt.data?.coordination?.progress?.summary).toBe("sparse intent");
    // The authoritative read serves the written state, not just the receipt.
    const stored = await readExecutionPlan(
      executionContextFor({ harnessDir: repoRoot }, { source: "local", sessionId: PLAN_PM_ID, role: "plan-pm", workflowId: WORKFLOW_ID, planId: PLAN_ID }),
      planRef,
      PLAN_ID,
    );
    // The plan row's JSON shape is engine-internal; the read-back is narrowed
    // locally to the one field this test asserts.
    const storedPlan = stored.data.plan as { status?: unknown };
    expect(storedPlan.status).toBe("InProgress");
  });

  test("the same sparse operation id replays its own receipt", async () => {
    const { repoRoot, planRef } = await buildFixture("sparse-replay");
    const input = { sessionRef: encodeExecutionSessionRef(planRef), operation: "op-sparse-replay", progress: PROGRESS };
    const first = await runPlanCommand(repoRoot, input, PLAN_PM_ID);
    expect(first.status).toBe("ok");
    const second = await runPlanCommand(repoRoot, input, PLAN_PM_ID);
    expect(second.status).toBe("ok");
    if (second.status !== "ok") throw new Error(second.message);
    const replayReceipt = second.data as PlanReceiptData;
    expect(replayReceipt.replayed).toBe(true);
  });

  test("an explicit stale execution token is refused at the engine authority boundary", async () => {
    const { context, repoRoot, planRef } = await buildFixture("sparse-stale");
    const staleToken: ExecutionToken = (await readExecutionPlan(
      executionContextFor({ harnessDir: repoRoot }, { source: "local", sessionId: PLAN_PM_ID, role: "plan-pm", workflowId: WORKFLOW_ID, planId: PLAN_ID }),
      planRef,
      PLAN_ID,
    )).token;
    // One committed operation moves the plan's revision: the captured token
    // WAS genuinely valid and is now stale.
    const accepted = await runPlanCommand(repoRoot, { sessionRef: encodeExecutionSessionRef(planRef), operation: "op-stale-mover", progress: PROGRESS }, PLAN_PM_ID);
    expect(accepted.status).toBe("ok");
    const afterMover = executionFootprint(context);
    const planAfterMover = planRowJson(context, PLAN_ID);
    const moverReceipt = operationReceiptJson(context, "op-stale-mover");
    expect(moverReceipt).not.toBeNull();
    const envelope = await runPlanCommand(repoRoot, { sessionRef: encodeExecutionSessionRef(planRef), operation: "op-sparse-stale", expect: staleToken, progress: PROGRESS }, PLAN_PM_ID);
    expect(envelope).toMatchObject({ status: "refused", exitCode: 1, code: "execution.stale-token" });
    // The stale refusal neither mutates in place nor records a receipt.
    expect(executionFootprint(context)).toEqual(afterMover);
    expect(planRowJson(context, PLAN_ID)).toEqual(planAfterMover);
    expect(operationReceiptJson(context, "op-stale-mover")).toEqual(moverReceipt);
    expect(operationReceiptJson(context, "op-sparse-stale")).toBeNull();
  });

  test("a caller without an independent runtime identity cannot adopt the ref's identity", async () => {
    const { repoRoot, planRef } = await buildFixture("sparse-no-identity");
    const envelope = await runPlanCommand(repoRoot, { sessionRef: encodeExecutionSessionRef(planRef), operation: "op-sparse-no-identity", progress: PROGRESS });
    // The ref names a session, but the transport carries no runtime caller:
    // the command refuses before constructing any identity from the ref —
    // nothing executes and the ref's identity is never adopted.
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (envelope.status !== "usage") throw new Error(`expected usage, got ${envelope.status}`);
    expect(envelope.message).toContain("runtime session identity");
  });

  test("a live foreign holder's reference is refused instead of being adopted", async () => {
    const { context, repoRoot, plan2Ref } = await buildFixture("sparse-foreign");
    const before = executionFootprint(context);
    const plan2RowsBefore = planRowJson(context, PLAN2_ID);
    // A REAL, live, bound plan-pm reference — of the plan this caller does
    // not own. The engine refuses it; it is never silently adopted.
    const envelope = await runPlanCommand(repoRoot, { sessionRef: encodeExecutionSessionRef(plan2Ref), operation: "op-sparse-foreign", progress: PROGRESS }, PLAN_PM_ID);
    expect(envelope).toMatchObject({ status: "refused", code: "coordination.session-mismatch" });
    expect(envelope.status).not.toBe("ok");
    expect(envelope.status).not.toBe("usage");
    expect(executionFootprint(context)).toEqual(before);
    expect(planRowJson(context, PLAN2_ID)).toEqual(plan2RowsBefore);
    expect(operationReceiptJson(context, "op-sparse-foreign")).toBeNull();
  });

  test("a self-consistent but unbound session reference is refused at the authority boundary", async () => {
    const { context, repoRoot, planRef } = await buildFixture("sparse-ghost");
    const before = executionFootprint(context);
    const planRowsBefore = planRowJson(context, PLAN_ID);
    const ghost = encodeExecutionSessionRef({ ...planRef, sessionId: GHOST_PM_ID });
    const envelope = await runPlanCommand(repoRoot, { sessionRef: ghost, operation: "op-sparse-ghost", progress: PROGRESS }, GHOST_PM_ID);
    expect(envelope).toMatchObject({ status: "refused", code: "execution.session-unavailable" });
    expect(envelope.status).not.toBe("usage");
    expect(envelope.code).not.toBe("command.invalid-input");
    expect(executionFootprint(context)).toEqual(before);
    expect(planRowJson(context, PLAN_ID)).toEqual(planRowsBefore);
    expect(operationReceiptJson(context, "op-sparse-ghost")).toBeNull();
  });

  test("a target no authority can name returns one grouped genuine-facts refusal", async () => {
    const { repoRoot, coordinatorRef } = await buildFixture("sparse-untargeted");
    const envelope = await runPlanCommand(repoRoot, { sessionRef: encodeExecutionSessionRef(coordinatorRef), operation: "op-sparse-untargeted", progress: PROGRESS }, COORDINATOR_ID);
    expect(envelope).toMatchObject({ status: "refused", code: "coordination.invalid-input" });
    const details = envelope.details as GroupedFacts;
    expect(Array.isArray(details.current_facts)).toBe(true);
    expect(details.current_facts?.length).toBeGreaterThan(0);
    expect(Array.isArray(details.sources_tried)).toBe(true);
  });

  test("the legacy file route still requires its own session instead of reaching the engine", async () => {
    const { repoRoot } = await buildFixture("sparse-file-route");
    const envelope = await runPlanCommand(repoRoot, { operation: "op-file-route", progress: PROGRESS });
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
  });

  test("the legacy file route still demands its own revision token", async () => {
    const { repoRoot } = await buildFixture("sparse-file-route-revision");
    // A valid legacy session envelope at the exact path the JSON route writes,
    // so the refusal is the route's own revision gate — not a missing file.
    const sessionPath = join(repoRoot, "workflows", WORKFLOW_ID, "sessions", `plan-pm-${PLAN_PM_ID}.json`);
    writeText(
      sessionPath,
      JSON.stringify({ schema_version: 1, role: "plan-pm", session_id: PLAN_PM_ID, plan_id: PLAN_ID, workflow_id: WORKFLOW_ID, harness_root: repoRoot }, null, 2),
    );
    const envelope = await runPlanCommand(
      repoRoot,
      { session: sessionPath, operation: "op-file-route-revision", progress: PROGRESS },
      PLAN_PM_ID,
    );
    // The file route's own expectedRevision gate fires before any store read:
    // the execution token vocabulary never substitutes for the revision.
    expect(envelope.status).toBe("usage");
    if (envelope.status !== "usage") throw new Error(`expected usage, got ${envelope.status}`);
    expect(envelope.message).toContain("expect must be a nonnegative integer revision");
  });
});
