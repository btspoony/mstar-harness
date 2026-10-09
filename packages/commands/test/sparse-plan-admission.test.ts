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
  type ExecutionIdentity,
  type ExecutionPlanView,
  type ExecutionRead,
  type ExecutionSessionRef,
  type ExecutionToken,
  type StoreContext,
  type WorkflowEntry,
  type WorkflowSnapshot,
} from "@mstar-harness/engine";
import { DatabaseSync } from "node:sqlite";
import { executeCommand } from "../src/definitions.js";
import type { CommandEnvelope, InvocationContext } from "../src/types.js";

const TS = "2026-01-02T03:04:05.000Z";
const WORKFLOW_ID = "wf-1";
const PLAN_ID = "p-1";
const PLAN2_ID = "p-2";
const COORDINATOR_ID = "host-coord";
const GHOST_ID = "host-coord-ghost";
const OTHER_ID = "host-coord-other";
const SOURCE_BRANCH = `feature/${PLAN_ID}`;
const INTEGRATION_BRANCH = `integration/${WORKFLOW_ID}`;
const COMPASS_REF = "iterations/iter-20260101-plan/delivery-compass.md";
const WORKTREE = "/srv/worktrees/sparse-plan";

const PROGRESS = { status: "InProgress", summary: "sparse intent", evidence_paths: [] };

/** The trusted coordinator's identity tuple (the one §3.1 shape, no plan scope). */
function coordinatorTupleOf(sessionId: string): ExecutionIdentity {
  return { source: "local", sessionId, workflowId: WORKFLOW_ID, role: "coordinator" };
}

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
 * One real isolated ACTIVE execution store holding one running workflow with
 * two plan rows prepared through the ordinary revisable configuration under its
 * coordinator binding — the shape the direct coordinator model produces. There
 * is no second seat: one workflow has one coordinator.
 */
async function buildFixture(label: string): Promise<{
  context: StoreContext;
  repoRoot: string;
  coordinatorRef: ExecutionSessionRef;
}> {
  const repoRoot = realpathSync(mkdtempSync(join(scratchRoot(), `${label}-`)));
  runGit(["init", "-q", "-b", "main"], repoRoot);
  runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], repoRoot);
  mkdirSync(join(repoRoot, ".mstar"), { recursive: true });
  const context: StoreContext = { harnessDir: join(repoRoot, ".mstar") };
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

  const coordinatorCaller: ExecutionCaller = { sessionId: COORDINATOR_ID, role: "coordinator", workflowId: WORKFLOW_ID };
  const coordinatorIdentity = coordinatorTupleOf(COORDINATOR_ID);
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
    expected: created.data.workflows[0]!.workflowToken,
    operationId: `bind-coordinator-${label}`,
  });

  const harnessRoot = join(repoRoot, ".mstar");
  const coordinatorContext = executionContextFor(context, coordinatorIdentity);
  for (const planId of [PLAN_ID, PLAN2_ID] as const) {
    const planPath = join(harnessRoot, "plans", `${planId}.md`);
    writeText(planPath, `# ${planId}\n`);
    // A REAL checkout on the branch prepare records: prepare validates the
    // actual checkout and branch, not merely that a directory exists.
    const worktree = join(repoRoot, `wt-${planId}`);
    runGit(["worktree", "add", "-q", "-b", `feature/${planId}`, worktree], repoRoot);
    const planToken: ExecutionToken = (await readExecutionPlan(coordinatorContext, planId)).token;
    await mutateExecutionPlan(coordinatorContext, {
      operationId: `prepare-${planId}-${label}`,
      session: coordinatorBind.data,
      expected: planToken,
      planId,
      operation: {
        kind: "prepare",
        config: { worktreePath: worktree, workingBranch: `feature/${planId}`, qaGate: "mandatory", findingsCleanup: "allow-residual" },
      },
    });
  }
  return { context, repoRoot, coordinatorRef: coordinatorBind.data };
}

async function runPlanCommand(
  repoRoot: string,
  input: Record<string, unknown>,
  sessionId?: string,
  executionIdentity?: ExecutionIdentity,
): Promise<CommandEnvelope> {
  const context: InvocationContext = {
    cwd: repoRoot,
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    ...(executionIdentity === undefined ? {} : { executionIdentity }),
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
type GroupedFacts = {
  current_facts?: unknown[];
  sources_tried?: unknown[];
  available_work?: unknown[];
  recoveryFacts?: { outcome?: unknown; commitState?: unknown; unresolved?: Array<{ code?: unknown }> };
};

/** Raw row counts proving a refused call changed nothing (no receipt, no binding, no plan write). */
function executionFootprint(context: StoreContext): { operations: number; sessions: number; plans: number } {
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
  test("a sparse active operation with sessionRef, plan, operation id and payload is admitted by the engine", async () => {
    const { context, repoRoot, coordinatorRef } = await buildFixture("sparse-accepted");
    const envelope = await runPlanCommand(
      repoRoot,
      { sessionRef: encodeExecutionSessionRef(coordinatorRef), plan: PLAN_ID, operation: "op-sparse-admitted", progress: PROGRESS },
      COORDINATOR_ID,
    );
    expect(envelope.status).toBe("ok");
    if (envelope.status !== "ok") throw new Error(envelope.message);
    const receipt = envelope.data as PlanReceiptData;
    expect(receipt.replayed).toBe(false);
    expect(receipt.data?.coordination?.progress?.summary).toBe("sparse intent");
    // The authoritative read serves the written state, not just the receipt.
    const stored = await readExecutionPlan(
      executionContextFor(context, { source: "local", sessionId: COORDINATOR_ID, role: "coordinator", workflowId: WORKFLOW_ID }),
      coordinatorRef,
      PLAN_ID,
    );
    expect(stored.data.plan.status).toBe("InProgress");
  });

  test("the same sparse operation id replays its own receipt", async () => {
    const { repoRoot, coordinatorRef } = await buildFixture("sparse-replay");
    const input = { sessionRef: encodeExecutionSessionRef(coordinatorRef), plan: PLAN_ID, operation: "op-sparse-replay", progress: PROGRESS };
    const first = await runPlanCommand(repoRoot, input, COORDINATOR_ID);
    expect(first.status).toBe("ok");
    const second = await runPlanCommand(repoRoot, input, COORDINATOR_ID);
    expect(second.status).toBe("ok");
    if (second.status !== "ok") throw new Error(second.message);
    expect((second.data as PlanReceiptData).replayed).toBe(true);
  });

  test("the coordinator reads a row with no session reference at all", async () => {
    const { context: storeContext, repoRoot } = await buildFixture("sparse-direct-show");
    const before = executionFootprint(storeContext);
    const planBefore = planRowJson(storeContext, PLAN_ID);
    const context: InvocationContext = {
      cwd: repoRoot,
      controlRoot: null,
      sessionId: COORDINATOR_ID,
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal: new AbortController().signal,
      effects: {
        readInput: async () => "",
        spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
        startDashboard: async () => { throw new Error("unused"); },
        openBrowser: async () => { throw new Error("unused"); },
      },
    };
    const envelope = await executeCommand("plan.show", { workflow: WORKFLOW_ID, plan: PLAN_ID, harness: join(repoRoot, ".mstar") }, context);
    expect(envelope.status).toBe("ok");
    if (envelope.status !== "ok") throw new Error(envelope.message);
    const data = envelope.data as ExecutionRead<ExecutionPlanView>;
    expect(data.data.plan.id).toBe(PLAN_ID);
    expect(executionFootprint(storeContext)).toEqual(before);
    expect(planRowJson(storeContext, PLAN_ID)).toEqual(planBefore);
  });

  test("a sparse active operation without an addressed plan is a usage refusal", async () => {
    const { repoRoot, coordinatorRef } = await buildFixture("sparse-no-plan");
    const envelope = await runPlanCommand(
      repoRoot,
      { sessionRef: encodeExecutionSessionRef(coordinatorRef), operation: "op-sparse-no-plan", progress: PROGRESS },
      COORDINATOR_ID,
    );
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (envelope.status !== "usage") throw new Error(`expected usage, got ${envelope.status}`);
    expect(envelope.message).toContain("--plan");
  });

  test("an explicit stale execution token is refused at the engine authority boundary", async () => {
    const { context, repoRoot, coordinatorRef } = await buildFixture("sparse-stale");
    const staleToken: ExecutionToken = (await readExecutionPlan(
      executionContextFor(context, { source: "local", sessionId: COORDINATOR_ID, role: "coordinator", workflowId: WORKFLOW_ID }),
      coordinatorRef,
      PLAN_ID,
    )).token;
    // One committed operation moves the plan's revision: the captured token
    // WAS genuinely valid and is now stale.
    const accepted = await runPlanCommand(
      repoRoot,
      { sessionRef: encodeExecutionSessionRef(coordinatorRef), plan: PLAN_ID, operation: "op-stale-mover", progress: PROGRESS },
      COORDINATOR_ID,
    );
    expect(accepted.status).toBe("ok");
    const afterMover = executionFootprint(context);
    const planAfterMover = planRowJson(context, PLAN_ID);
    const moverReceipt = operationReceiptJson(context, "op-stale-mover");
    expect(moverReceipt).not.toBeNull();
    const envelope = await runPlanCommand(
      repoRoot,
      { sessionRef: encodeExecutionSessionRef(coordinatorRef), plan: PLAN_ID, operation: "op-sparse-stale", expect: staleToken, progress: PROGRESS },
      COORDINATOR_ID,
    );
    expect(envelope).toMatchObject({ status: "refused", exitCode: 1, code: "execution.stale-token" });
    // The stale refusal neither mutates in place nor records a receipt.
    expect(executionFootprint(context)).toEqual(afterMover);
    expect(planRowJson(context, PLAN_ID)).toEqual(planAfterMover);
    expect(operationReceiptJson(context, "op-stale-mover")).toEqual(moverReceipt);
    expect(operationReceiptJson(context, "op-sparse-stale")).toBeNull();
  });

  test("a caller without an independent runtime identity cannot adopt the ref's identity", async () => {
    const { repoRoot, coordinatorRef } = await buildFixture("sparse-no-identity");
    const envelope = await runPlanCommand(
      repoRoot,
      { sessionRef: encodeExecutionSessionRef(coordinatorRef), plan: PLAN_ID, operation: "op-sparse-no-identity", progress: PROGRESS },
    );
    // The ref names a session, but the transport carries no runtime caller:
    // the command refuses before constructing any identity from the ref —
    // nothing executes and the ref's identity is never adopted.
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (envelope.status !== "usage") throw new Error(`expected usage, got ${envelope.status}`);
    expect(envelope.message).toContain("runtime session identity");
  });

  test("an active progress update without an operation id persists the plan state", async () => {
    const { context, repoRoot, coordinatorRef } = await buildFixture("sparse-derived-operation");
    const progress = { ...PROGRESS, summary: "persisted without explicit operation id" };
    const envelope = await runPlanCommand(
      repoRoot,
      { sessionRef: encodeExecutionSessionRef(coordinatorRef), plan: PLAN_ID, progress },
      COORDINATOR_ID,
    );
    expect(envelope.status).toBe("ok");
    const stored = await readExecutionPlan(
      executionContextFor(context, { source: "local", sessionId: COORDINATOR_ID, role: "coordinator", workflowId: WORKFLOW_ID }),
      coordinatorRef,
      PLAN_ID,
    );
    expect(stored.data.plan.status).toBe("InProgress");
    expect(stored.data.coordination?.progress?.summary).toBe(progress.summary);
  });

  test("a reference under another acquired identity cannot write for the bound coordinator", async () => {
    const { context, repoRoot, coordinatorRef } = await buildFixture("sparse-copied");
    const before = executionFootprint(context);
    const planRowsBefore = planRowJson(context, PLAN_ID);
    // A copied reference cannot authorize the independently acquired caller.
    const envelope = await runPlanCommand(
      repoRoot,
      { sessionRef: encodeExecutionSessionRef(coordinatorRef), plan: PLAN_ID, operation: "op-sparse-copied", progress: PROGRESS },
      OTHER_ID,
    );
    expect(envelope).toMatchObject({ status: "refused", code: "coordination.identity-mismatch", exitCode: 1 });
    expect(envelope.status).not.toBe("ok");
    expect(envelope.status).not.toBe("usage");
    expect(executionFootprint(context)).toEqual(before);
    expect(planRowJson(context, PLAN_ID)).toEqual(planRowsBefore);
    expect(operationReceiptJson(context, "op-sparse-copied")).toBeNull();
  });

  test("a self-consistent but unbound session reference is refused at the authority boundary", async () => {
    const { context, repoRoot, coordinatorRef } = await buildFixture("sparse-ghost");
    const before = executionFootprint(context);
    const planRowsBefore = planRowJson(context, PLAN_ID);
    const ghost = encodeExecutionSessionRef({ ...coordinatorRef, sessionId: GHOST_ID });
    const envelope = await runPlanCommand(
      repoRoot,
      { sessionRef: ghost, plan: PLAN_ID, operation: "op-sparse-ghost", progress: PROGRESS },
      GHOST_ID,
    );
    expect(envelope).toMatchObject({ status: "refused", code: "execution.session-unavailable" });
    expect(envelope.status).not.toBe("usage");
    expect(envelope.code).not.toBe("command.invalid-input");
    expect(executionFootprint(context)).toEqual(before);
    expect(planRowJson(context, PLAN_ID)).toEqual(planRowsBefore);
    expect(operationReceiptJson(context, "op-sparse-ghost")).toBeNull();
    // The refusal keeps its stable authority verdict and carries the engine's
    // grouped recovery facts — what the store actually read.
    const details = envelope.details as GroupedFacts;
    expect(details.current_facts?.length).toBeGreaterThan(0);
    expect(JSON.stringify(details.current_facts)).toContain(GHOST_ID);
    expect(details.sources_tried?.length).toBeGreaterThan(0);
    expect(details.available_work?.length).toBeGreaterThan(0);
    expect(details.recoveryFacts).toMatchObject({ outcome: "unresolved", commitState: "none" });
    expect(details.recoveryFacts?.unresolved?.[0]).toMatchObject({ code: "execution.session-unavailable" });
  });

  test("the legacy file route still requires its own session instead of reaching the engine", async () => {
    const { repoRoot } = await buildFixture("sparse-file-route");
    const envelope = await runPlanCommand(repoRoot, { plan: PLAN_ID, operation: "op-file-route", progress: PROGRESS });
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
  });

  test("a minted coordinator identity with no reference or workflow selector mutates its row", async () => {
    const { repoRoot } = await buildFixture("sparse-minted");
    const envelope = await runPlanCommand(
      repoRoot,
      { plan: PLAN_ID, operation: "op-sparse-minted", progress: PROGRESS },
      COORDINATOR_ID,
      coordinatorTupleOf(COORDINATOR_ID),
    );
    expect(envelope.status).toBe("ok");
    if (envelope.status !== "ok") throw new Error(envelope.message);
    const receipt = envelope.data as PlanReceiptData;
    expect(receipt.replayed).toBe(false);
    expect(receipt.data?.coordination?.progress?.summary).toBe("sparse intent");
  });

  test("an explicit session ID with no reference or minted transport mutates its row", async () => {
    const { repoRoot } = await buildFixture("sparse-explicit-id");
    const envelope = await runPlanCommand(
      repoRoot,
      { plan: PLAN_ID, operation: "op-sparse-explicit-id", progress: PROGRESS, workflow: WORKFLOW_ID },
      COORDINATOR_ID,
    );
    expect(envelope.status).toBe("ok");
    if (envelope.status !== "ok") throw new Error(envelope.message);
    expect((envelope.data as PlanReceiptData).data?.coordination?.progress?.summary).toBe("sparse intent");
  });

  test("an ambient host session ID with no reference or minted transport mutates its row", async () => {
    const { repoRoot } = await buildFixture("sparse-ambient-id");
    const envelope = await runPlanCommand(
      repoRoot,
      { plan: PLAN_ID, operation: "op-sparse-ambient", progress: PROGRESS, workflow: WORKFLOW_ID },
      COORDINATOR_ID,
    );
    expect(envelope.status).toBe("ok");
    if (envelope.status !== "ok") throw new Error(envelope.message);
    expect((envelope.data as PlanReceiptData).data?.coordination?.progress?.summary).toBe("sparse intent");
  });

  test("the legacy file route still demands its own revision token", async () => {
    const { repoRoot } = await buildFixture("sparse-file-route-revision");
    // A valid legacy session envelope at the exact path the JSON route writes,
    // so the refusal is the route's own revision gate — not a missing file.
    const sessionPath = join(repoRoot, "workflows", WORKFLOW_ID, "sessions", `coordinator-${COORDINATOR_ID}.json`);
    writeText(
      sessionPath,
      JSON.stringify({ schema_version: 1, role: "coordinator", session_id: COORDINATOR_ID, workflow_id: WORKFLOW_ID, harness_root: repoRoot }, null, 2),
    );
    const envelope = await runPlanCommand(
      repoRoot,
      { session: sessionPath, plan: PLAN_ID, operation: "op-file-route-revision", progress: PROGRESS },
      COORDINATOR_ID,
    );
    // The file route's own expectedRevision gate fires before any store read:
    // the execution token vocabulary never substitutes for the revision.
    expect(envelope.status).toBe("usage");
    if (envelope.status !== "usage") throw new Error(`expected usage, got ${envelope.status}`);
    expect(envelope.message).toContain("expect must be a nonnegative integer revision");
  });
});
