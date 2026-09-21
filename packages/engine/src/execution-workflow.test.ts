/**
 * execution-workflow — the DB transport of the WORKFLOW-LEVEL transitions and
 * the explicit coordinator recovery bootstrap (primary spec §2.3/§3/§4.1/§4.2).
 *
 * Run with
 * `bun test packages/engine/src/execution-workflow.test.ts --test-name-pattern 'execution-workflow|execution-coordinator-recovery'`.
 *
 * Every fixture is a real Git control harness in its own temporary directory:
 * the compass a phase transition reads is a real `delivery-compass.md`, the
 * integration checkout is a real `git worktree`, and the plan rows are the
 * store's own rows. No test reads or writes this checkout's `store.db`.
 *
 * The consumer-visible contract asserted here:
 * - `mutateExecutionWorkflow` refuses an unauthorized, skipped-phase,
 *   contradicted-evidence, stale-evidence or invalid-payload transition with
 *   the accepted state untouched, and applies a valid one leaving the
 *   lifecycle's identity anchors byte-identical;
 * - one accepted transition advances the addressed workflow once and the store
 *   once; a terminal close additionally advances the ROOT once, removes
 *   registry routing and commits the terminal state in ONE transaction while
 *   the history rows stay — and a refused close changes none of them;
 * - `recoverExecutionCoordinator` refuses without a named, attested-stopped
 *   prior holder and never replaces a live owner; on success it invalidates the
 *   old reference, binds the caller, and adopts exactly the lease ownership its
 *   revocation orphaned, without reviving an old-epoch lease.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  mutateExecutionWorkflow as publishedMutateExecutionWorkflow,
  recoverExecutionCoordinator as publishedRecoverExecutionCoordinator,
  type WorkflowExecutionOperation,
} from "../src/index.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  executionToken,
  initializeExecutionAuthority,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionMutation,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionState,
  type ExecutionToken,
} from "../src/execution-store.js";
import {
  mutateExecutionWorkflow,
  recoverExecutionCoordinator,
  setWorkflowWitnessGapForTest,
} from "../src/execution-workflow.js";
import { initializeStore, storeDbPath, type StoreContext, type StoreDb } from "../src/store-db.js";
import { ACTIVATION_PROTOCOL_VERSION, type ActivationAttestation } from "../src/store-activation.js";
import type { WorkflowEntry } from "../src/status.js";
import type { WorkflowSnapshot } from "../src/workflow.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-execution-workflow-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const TS = "2026-01-02T03:04:05.000Z";
const WORKFLOW_ID = "wf-1";
const PLAN_ID = "p-1";
const COORDINATOR_ID = "host-coord";
const RECOVERY_ID = "host-coord-next";
const ITERATION_ID = "iter-20260101-workflow";
const COMPASS_REF = `iterations/${ITERATION_ID}/delivery-compass.md`;
const INTEGRATION_BRANCH = `integration/${WORKFLOW_ID}`;
const SOURCE_BRANCH = `feature/${PLAN_ID}`;

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

function trustedCaller(sessionId: string, role: "coordinator" | "plan-pm", planId: string | null): ExecutionCaller {
  return { sessionId, role, workflowId: WORKFLOW_ID, planId };
}

function domainContext(context: StoreContext, who: ExecutionCaller): ExecutionContext {
  return { harnessDir: context.harnessDir, caller: who };
}

/** Run one raw fixture read/write directly against the store's own DB file. */
function withRaw<T>(context: StoreContext, body: (db: StoreDb) => T): T {
  const db = new DatabaseSync(storeDbPath(context));
  try {
    return body(db as unknown as StoreDb);
  } finally {
    db.close();
  }
}

function rows(context: StoreContext, sql: string): Array<Record<string, unknown>> {
  return withRaw(context, (db) => db.prepare(sql).all() as Array<Record<string, unknown>>);
}

function parsedJson(value: unknown): Record<string, unknown> {
  return JSON.parse(String(value)) as Record<string, unknown>;
}

/**
 * The lifecycle's identity anchors: the fields no workflow-level operation may
 * rekey. `registerPlanWorkflow`/`createExecutionWorkflow` fix them, and a
 * transition that changed one would be a re-registration in disguise.
 */
function identityAnchors(state: Record<string, unknown>): Record<string, unknown> {
  const anchors: Record<string, unknown> = {};
  for (const key of [
    "schema_version",
    "id",
    "type",
    "started_at",
    "project",
    "compass_ref",
    "delivery_kind",
    "completion_policy",
    "branch",
  ] as const) {
    if (state[key] !== undefined) anchors[key] = state[key];
  }
  return anchors;
}

/** The three revisions one accepted workflow transition must account for. */
function revisions(context: StoreContext): { root: number; store: number; workflow: number } {
  const [row] = rows(
    context,
    "select (select revision from execution_meta where id = 1) as root, " +
      "(select revision from store_meta where id = 1) as store, " +
      `(select revision from execution_workflows where workflow_id = '${WORKFLOW_ID}') as workflow`,
  );
  return { root: Number(row!.root), store: Number(row!.store), workflow: Number(row!.workflow) };
}

/** Everything a refused transition must leave untouched, as one comparable value. */
function workflowFootprint(context: StoreContext): Record<string, unknown> {
  const [row] = rows(
    context,
    "select (select revision from execution_meta where id = 1) as root_revision, " +
      "(select revision from store_meta where id = 1) as store_revision, " +
      `(select revision from execution_workflows where workflow_id = '${WORKFLOW_ID}') as workflow_revision, ` +
      `(select state_json from execution_workflows where workflow_id = '${WORKFLOW_ID}') as workflow_state, ` +
      `(select count(*) as n from execution_registry where workflow_id = '${WORKFLOW_ID}') as registered, ` +
      "(select count(*) as n from execution_operations) as operations, " +
      "(select count(*) as n from execution_sessions) as sessions, " +
      "(select count(*) as n from execution_leases) as leases",
  );
  return row!;
}

/** The workflow token of the stored header, built from its own revision. */
function workflowTokenOfRow(context: StoreContext): ExecutionToken {
  const [workflow] = rows(
    context,
    `select revision from execution_workflows where workflow_id = '${WORKFLOW_ID}'`,
  );
  const [store] = rows(context, "select store_id, authority_epoch from store_meta where id = 1");
  return executionToken("workflow", String(store!.store_id), Number(store!.authority_epoch), [WORKFLOW_ID], Number(workflow!.revision));
}

/** One Git command in a fixture repository (never the caller's checkout). */
function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The lifecycle's own compass frontmatter (the mstar-iteration §1.3 field set). */
function writeCompass(
  path: string,
  input: { status: string; plans: readonly string[]; targetBranch: string; endDate?: string },
): void {
  const lines = [
    "---",
    `iteration_id: ${ITERATION_ID}`,
    "start_date: 2026-01-01",
    `status: ${input.status}`,
    "iteration_base_branch: main",
    `target_branch: ${input.targetBranch}`,
    `plans: [${input.plans.join(", ")}]`,
    ...(input.endDate === undefined ? [] : [`end_date: ${input.endDate}`]),
    "---",
    "",
    `# ${ITERATION_ID}`,
  ];
  writeText(path, `${lines.join("\n")}\n`);
}

/**
 * One real control harness: a Git repository whose `.mstar` is the store's
 * control root, an integration worktree on the registered integration branch,
 * the lifecycle's own compass and ONE plan row (`Todo`).
 */
type Fixture = {
  context: StoreContext;
  repoRoot: string;
  integrationPath: string;
  compassPath: string;
  storeId: string;
  epoch: number;
  coordinator: ExecutionSessionRef;
  coordinatorCaller: ExecutionCaller;
};

async function workflowFixture(label: string): Promise<Fixture> {
  const repoRoot = realpathSync(mkdtempSync(join(ROOT, `${label}-`)));
  runGit(["init", "-q", "-b", "main"], repoRoot);
  runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], repoRoot);
  const harnessRoot = join(repoRoot, ".mstar");
  mkdirSync(harnessRoot, { recursive: true });
  const context: StoreContext = { harnessDir: repoRoot };
  const store = await initializeStore(context);
  store.close();
  const initialized = await initializeExecutionAuthority(context);
  const integrationPath = join(repoRoot, "wt-integration");
  runGit(["worktree", "add", "-q", "-b", INTEGRATION_BRANCH, integrationPath], repoRoot);
  const compassPath = join(harnessRoot, COMPASS_REF);
  writeCompass(compassPath, { status: "active", plans: [PLAN_ID], targetBranch: "main" });

  const coordinatorCaller = trustedCaller(COORDINATOR_ID, "coordinator", null);
  const created = await createExecutionWorkflow(domainContext(context, coordinatorCaller), {
    entry: { id: WORKFLOW_ID, type: "plan", started_at: TS, dir: `workflows/${WORKFLOW_ID}` } as WorkflowEntry,
    snapshot: {
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
      plans: [{ id: PLAN_ID, title: `${PLAN_ID} title`, file: `plans/${PLAN_ID}.md`, status: "Todo" }],
    } as unknown as WorkflowSnapshot,
    expected: initialized.token,
    operationId: `create-${label}`,
  });
  const [workflow] = created.data.workflows;
  const coordinator = await bindExecutionSession(domainContext(context, coordinatorCaller), {
    workflowId: WORKFLOW_ID,
    planId: null,
    role: "coordinator",
    expected: workflow.workflowToken,
    operationId: `bind-coordinator-${label}`,
  });
  return {
    context,
    repoRoot,
    integrationPath,
    compassPath,
    storeId: created.storeId,
    epoch: created.epoch,
    coordinator: coordinator.data,
    coordinatorCaller,
  };
}

/** The workflow token the store serves right now (the CAS a call presents back). */
async function liveWorkflowToken(fixture: Fixture): Promise<ExecutionToken> {
  const state = await readExecutionState(fixture.context);
  const workflow = state.data.workflows.find((candidate) => candidate.state.id === WORKFLOW_ID);
  if (workflow === undefined) throw new Error("fixture: the workflow is not registered");
  return workflow.workflowToken;
}

/** One `mutateExecutionWorkflow` call, at the token read right now unless given. */
function workflowMutation(
  fixture: Fixture,
  operationId: string,
  operation: WorkflowExecutionOperation,
  options: { expected?: ExecutionToken; who?: ExecutionCaller; session?: ExecutionSessionRef } = {},
) {
  const who = options.who ?? fixture.coordinatorCaller;
  const session = options.session ?? fixture.coordinator;
  return (async () => {
    const expected = options.expected ?? (await liveWorkflowToken(fixture));
    return mutateExecutionWorkflow(domainContext(fixture.context, who), {
      operationId,
      session,
      expected,
      workflowId: WORKFLOW_ID,
      operation,
    });
  })();
}

/** §Workflow one plan row's status, planted without moving the row revision. */
function setRowStatus(context: StoreContext, planId: string, status: string): void {
  withRaw(context, (db) => {
    const row = db
      .prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?")
      .get(WORKFLOW_ID, planId) as { state_json?: unknown } | undefined;
    if (row === undefined) throw new Error(`fixture: no plan row ${planId}`);
    const state = parsedJson(row.state_json);
    state.status = status;
    db.prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?").run(
      JSON.stringify(state),
      WORKFLOW_ID,
      planId,
    );
  });
}

/**
 * Plant one execution lease. No W-phase verb produces a lease held by a session
 * that is not its own, so the crash states the recovery bootstrap repairs are
 * planted here — exactly as the W4 fixtures plant a foreign merge lease.
 */
function plantLease(
  context: StoreContext,
  input: { ownerEpoch: number; holderId: string; holderRole: "coordinator" | "plan-pm"; status?: "held" | "released" },
): void {
  withRaw(context, (db) => {
    db.prepare(
      "insert or replace into execution_leases(workflow_id, plan_id, revision, owner_epoch, lease_json) values (?, ?, 1, ?, ?)",
    ).run(
      WORKFLOW_ID,
      PLAN_ID,
      input.ownerEpoch,
      JSON.stringify({
        holder: input.holderId,
        holder_session_id: input.holderId,
        holder_role: input.holderRole,
        plan_worktree_path: join(context.harnessDir, "wt-plan"),
        plan_branch: SOURCE_BRANCH,
        worktree_path: join(context.harnessDir, "wt-plan"),
        working_branch: SOURCE_BRANCH,
        claimed_at: TS,
        status: input.status ?? "held",
      }),
    );
  });
}

function leaseRows(context: StoreContext): Array<Record<string, unknown>> {
  return rows(
    context,
    `select plan_id, owner_epoch, lease_json from execution_leases where workflow_id = '${WORKFLOW_ID}' order by plan_id`,
  );
}

function sessionState(context: StoreContext, sessionId: string): unknown {
  const [row] = rows(
    context,
    `select state from execution_sessions where workflow_id = '${WORKFLOW_ID}' and session_id = '${sessionId}'`,
  );
  return row?.state ?? null;
}

/** A conforming installed-consumer attestation naming the given stopped sessions. */
function attestation(stopped: readonly string[]): ActivationAttestation {
  return {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt: "2026-01-02T04:00:00.000Z",
    operator: { actor: "ops-engineer", authorizationRef: "compass D29 / coordinator recovery decision" },
    consumers: [
      {
        entryId: "coordinator-omp",
        kind: "coordinator",
        entrypoint: "/opt/mstar/coordinator/dist/index.js",
        runtime: "node",
        runtimeVersion: "24.18.0",
        version: "3.11.2",
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions: stopped.map((sessionId) => ({ sessionId, host: "omp", state: "stopped" as const })),
  };
}

/** Run an operation that must refuse; return its stable code, message and details. */
async function refusalOf(
  work: () => Promise<unknown>,
): Promise<{ code?: string; message: string; details: Record<string, unknown> }> {
  try {
    await work();
  } catch (error) {
    const typed = error as { code?: string; message?: string; details?: Record<string, unknown> };
    return { ...(typed.code === undefined ? {} : { code: typed.code }), message: String(typed.message), details: typed.details ?? {} };
  }
  throw new Error("expected the call to refuse, but it resolved");
}

/** The development delivery tail every close needs (contract §4c/§4d/§4f). */
const DELIVERY_TAIL = {
  compound: { outcome: "created" },
  pr: { repo: "o/r", head: SOURCE_BRANCH, target: "main" },
  merge: { provider: "github", evidence: "PR #255 merged" },
} as const;

/* ------------------------------------------------------------------------ *
 * §3 the published surface
 * ------------------------------------------------------------------------ */

describe("execution-workflow: \u00A73 the published APIs and their verbatim signatures", () => {
  test("exports both APIs verbatim with their \u00A73 signatures", () => {
    // The compile-time pins: each binding fails to typecheck if the declared
    // signature drifts from primary spec §3.
    const workflowSurface: (
      context: ExecutionContext,
      request: ExecutionMutation & { workflowId: string; operation: WorkflowExecutionOperation },
    ) => Promise<ExecutionReceipt<ExecutionState>> = publishedMutateExecutionWorkflow;
    expect(workflowSurface).toBe(mutateExecutionWorkflow);
    expect(publishedMutateExecutionWorkflow.length).toBe(2);
    const recoverySurface: (
      context: ExecutionContext,
      input: {
        expected: ExecutionToken;
        operationId: string;
        priorSessionId: string | null;
        reason: string;
        attestation: ActivationAttestation;
      },
    ) => Promise<ExecutionReceipt<ExecutionSessionRef>> = publishedRecoverExecutionCoordinator;
    expect(recoverySurface).toBe(recoverExecutionCoordinator);
    expect(publishedRecoverExecutionCoordinator.length).toBe(2);
  });
});

/* ------------------------------------------------------------------------ *
 * §3 mutateExecutionWorkflow
 * ------------------------------------------------------------------------ */

describe("execution-workflow: \u00A73 workflow-level phase, lifecycle, policy, checkout and delivery", () => {
  test("a phase transition is decided by the registered compass and preserves the lifecycle identity", async () => {
    const fixture = await workflowFixture("phase-valid");
    const before = await readExecutionState(fixture.context);
    const initialState = before.data.workflows[0]!.state as unknown as Record<string, unknown>;
    const revisionsBefore = revisions(fixture.context);

    const receipt = await workflowMutation(fixture, "op-phase-2", {
      kind: "phase",
      phase: "phase-2-execute",
      compassPath: fixture.compassPath,
    });

    expect(receipt.replayed).toBe(false);
    const after = await readExecutionState(fixture.context);
    // The receipt witnesses the advance it committed: it IS the current root token.
    expect(receipt.token).toBe(after.token);
    const state = after.data.workflows[0]!.state as unknown as Record<string, unknown>;
    expect(state.phase).toBe("phase-2-execute");
    // Identity anchors are not writable through this route.
    expect(identityAnchors(state)).toEqual(identityAnchors(initialState));
    expect(state.integration_worktree_path).toEqual(initialState.integration_worktree_path);
    expect(state.execution_policy).toEqual(initialState.execution_policy);
    expect(after.data.workflows[0]!.coordinator).toEqual(fixture.coordinator);
    // §3.1 one accepted operation: the workflow advances once, the store once,
    // and registry membership (the root) is untouched.
    expect(revisions(fixture.context)).toEqual({
      root: revisionsBefore.root,
      store: revisionsBefore.store + 1,
      workflow: revisionsBefore.workflow + 1,
    });
  });

  test("a skipped phase and a compass that contradicts the request are refused with no mutation", async () => {
    const fixture = await workflowFixture("phase-skipped");
    const before = await workflowFootprint(fixture.context);

    // The row is Todo, so the gate produces phase-2-execute: Phase 4 is skipped.
    const skipped = await refusalOf(() =>
      workflowMutation(fixture, "op-phase-4", {
        kind: "phase",
        phase: "phase-4-pr-delivery",
        compassPath: fixture.compassPath,
      }),
    );
    expect(skipped.code).toBe("coordination.invalid-transition");
    expect(skipped.details.gate).toBe("phase-2-execute");
    expect(await workflowFootprint(fixture.context)).toEqual(before);

    // A compass that is not the lifecycle's registered one never enters the decision.
    const foreign = join(fixture.repoRoot, "compass-elsewhere.md");
    writeCompass(foreign, { status: "completed", plans: [PLAN_ID], targetBranch: "main", endDate: "2026-01-02" });
    const outsider = await refusalOf(() =>
      workflowMutation(fixture, "op-phase-foreign", {
        kind: "phase",
        phase: "phase-4-pr-delivery",
        compassPath: foreign,
      }),
    );
    expect(outsider.code).toBe("coordination.scope-mismatch");

    // Evidence that contradicts the requested phase: a closed compass over a Todo row.
    writeCompass(fixture.compassPath, {
      status: "completed",
      plans: [PLAN_ID],
      targetBranch: "main",
      endDate: "2026-01-02",
    });
    const contradicted = await refusalOf(() =>
      workflowMutation(fixture, "op-phase-4-again", {
        kind: "phase",
        phase: "phase-4-pr-delivery",
        compassPath: fixture.compassPath,
      }),
    );
    expect(contradicted.code).toBe("coordination.invalid-transition");
    expect(contradicted.message).toContain("PLAN_NOT_DONE");
    expect(await workflowFootprint(fixture.context)).toEqual(before);
  });

  test("phase-4 is accepted exactly when the gate's own evidence is complete", async () => {
    const fixture = await workflowFixture("phase-4");
    setRowStatus(fixture.context, PLAN_ID, "Done");
    // The §3.5 exit item 6 probe is the recorded PR identity (§4d): the DB
    // authority holds no operator PR probe, so that evidence is what makes
    // Phase 4 verifiable at all.
    await workflowMutation(fixture, "op-delivery-4", { kind: "delivery", delivery: DELIVERY_TAIL });
    writeCompass(fixture.compassPath, {
      status: "completed",
      plans: [PLAN_ID],
      targetBranch: "main",
      endDate: "2026-01-02",
    });

    const receipt = await workflowMutation(fixture, "op-phase-4-ok", {
      kind: "phase",
      phase: "phase-4-pr-delivery",
      compassPath: fixture.compassPath,
    });
    const state = receipt.data.workflows[0]!.state as unknown as Record<string, unknown>;
    expect(state.phase).toBe("phase-4-pr-delivery");
  });

  test("evidence read before the commit is revalidated: a compass edit refuses the phase", async () => {
    const fixture = await workflowFixture("phase-stale");
    const before = await workflowFootprint(fixture.context);
    setWorkflowWitnessGapForTest(() => {
      writeCompass(fixture.compassPath, { status: "locked", plans: [PLAN_ID], targetBranch: "main" });
    });
    try {
      const refused = await refusalOf(() =>
        workflowMutation(fixture, "op-phase-stale", {
          kind: "phase",
          phase: "phase-2-execute",
          compassPath: fixture.compassPath,
        }),
      );
      expect(refused.code).toBe("coordination.evidence-stale");
      expect(refused.message).toContain("changed after the phase gate was read");
    } finally {
      setWorkflowWitnessGapForTest(undefined);
    }
    expect(await workflowFootprint(fixture.context)).toEqual(before);
  });

  test("an execution-policy change stores only the closed policy vocabulary", async () => {
    const fixture = await workflowFixture("policy");
    const before = (await readExecutionState(fixture.context)).data.workflows[0]!.state as unknown as Record<string, unknown>;
    const receipt = await workflowMutation(fixture, "op-policy", {
      kind: "execution-policy",
      policy: { plan_parallelism: "parallel", worktree_mode: "required" },
    });
    const state = receipt.data.workflows[0]!.state as unknown as Record<string, unknown>;
    expect(state.execution_policy).toEqual({ plan_parallelism: "parallel", worktree_mode: "required" });
    expect(identityAnchors(state)).toEqual(identityAnchors(before));

    const invalid = await refusalOf(() =>
      workflowMutation(fixture, "op-policy-invalid", { kind: "execution-policy", policy: { plan_parallelism: "sometimes" } }),
    );
    expect(invalid.code).toBe("coordination.invalid-input");
    const unknown = await refusalOf(() =>
      workflowMutation(fixture, "op-policy-unknown", {
        kind: "execution-policy",
        policy: { plan_parallelism: "serial", extra: true },
      } as never),
    );
    expect(unknown.code).toBe("coordination.forbidden-field");
  });

  test("the integration checkout is recorded only when it is a distinct checkout of this repository on the integration branch", async () => {
    const fixture = await workflowFixture("worktree");

    const before = (await readExecutionState(fixture.context)).data.workflows[0]!.state as unknown as Record<string, unknown>;
    // The lifecycle's own registered integration checkout.
    const receipt = await workflowMutation(fixture, "op-worktree-ok", {
      kind: "integration-worktree",
      path: fixture.integrationPath,
    });
    const state = receipt.data.workflows[0]!.state as unknown as Record<string, unknown>;
    expect(state.integration_worktree_path).toBe(realpathSync(fixture.integrationPath));
    expect(identityAnchors(state)).toEqual(identityAnchors(before));

    // Another distinct checkout of this repository, on the same branch (git
    // allows one branch in two worktrees only behind this flag).
    const fresh = join(fixture.repoRoot, "wt-integration-2");
    runGit(["worktree", "add", "-q", "-b", `${INTEGRATION_BRANCH}-2`, fresh], fixture.repoRoot);
    runGit(["checkout", "--ignore-other-worktrees", "-q", INTEGRATION_BRANCH], fresh);
    const moved = await workflowMutation(fixture, "op-worktree-moved", {
      kind: "integration-worktree",
      path: fresh,
    });
    expect((moved.data.workflows[0]!.state as unknown as Record<string, unknown>).integration_worktree_path).toBe(
      realpathSync(fresh),
    );

    // The main/control checkout itself is never the integration checkout.
    const mainCheckout = await refusalOf(() =>
      workflowMutation(fixture, "op-worktree-main", { kind: "integration-worktree", path: fixture.repoRoot }),
    );
    expect(mainCheckout.code).toBe("coordination.invalid-transition");

    // A plain subdirectory of the main checkout is not a distinct checkout.
    const subdirectory = join(fixture.repoRoot, "plain-directory");
    mkdirSync(subdirectory, { recursive: true });
    const notDistinct = await refusalOf(() =>
      workflowMutation(fixture, "op-worktree-plain", { kind: "integration-worktree", path: subdirectory }),
    );
    expect(notDistinct.code).toBe("coordination.invalid-transition");

    // A directory that is not in any repository is not a checkout at all.
    const outside = mkdtempSync(join(ROOT, "not-a-repo-"));
    const notACheckout = await refusalOf(() =>
      workflowMutation(fixture, "op-worktree-outside", { kind: "integration-worktree", path: outside }),
    );
    expect(notACheckout.code).toBe("coordination.not-in-git");

    // A checkout of ANOTHER repository never becomes this lifecycle's checkout.
    const otherRepo = realpathSync(mkdtempSync(join(ROOT, "other-repo-")));
    runGit(["init", "-q", "-b", "main"], otherRepo);
    runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], otherRepo);
    const foreign = await refusalOf(() =>
      workflowMutation(fixture, "op-worktree-foreign", { kind: "integration-worktree", path: otherRepo }),
    );
    expect(foreign.code).toBe("coordination.scope-mismatch");

    // A checkout of this repository on ANOTHER branch is not the integration checkout.
    const wrongBranch = join(fixture.repoRoot, "wt-other-branch");
    runGit(["worktree", "add", "-q", "-b", "feature/elsewhere", wrongBranch], fixture.repoRoot);
    const misaligned = await refusalOf(() =>
      workflowMutation(fixture, "op-worktree-branch", { kind: "integration-worktree", path: wrongBranch }),
    );
    expect(misaligned.code).toBe("coordination.integration-diverged");
  });

  test("a checkout switched between the probe and the commit refuses as stale evidence", async () => {
    const fixture = await workflowFixture("worktree-stale");
    const before = await workflowFootprint(fixture.context);
    setWorkflowWitnessGapForTest(() => {
      runGit(["checkout", "-q", "-b", "feature/switched-in-the-window"], fixture.integrationPath);
    });
    try {
      const refused = await refusalOf(() =>
        workflowMutation(fixture, "op-worktree-stale", { kind: "integration-worktree", path: fixture.integrationPath }),
      );
      expect(refused.code).toBe("coordination.evidence-stale");
    } finally {
      setWorkflowWitnessGapForTest(undefined);
    }
    expect(await workflowFootprint(fixture.context)).toEqual(before);
  });

  test("delivery evidence follows the declared kind, records once and refuses a rewritten PR identity", async () => {
    const fixture = await workflowFixture("delivery");
    // The delivery tail waits for every owned row: contract §3 ordering.
    const early = await refusalOf(() =>
      workflowMutation(fixture, "op-delivery-early", { kind: "delivery", delivery: { compound: { outcome: "created" } } }),
    );
    expect(early.code).toBe("coordination.invalid-transition");
    setRowStatus(fixture.context, PLAN_ID, "Done");

    const before = (await readExecutionState(fixture.context)).data.workflows[0]!.state as unknown as Record<string, unknown>;
    const receipt = await workflowMutation(fixture, "op-delivery-tail", { kind: "delivery", delivery: DELIVERY_TAIL });
    const state = receipt.data.workflows[0]!.state as unknown as Record<string, unknown>;
    expect(state.delivery).toMatchObject({
      compound: { outcome: "created" },
      pr: { head: SOURCE_BRANCH, target: "main" },
      merge: { evidence: "PR #255 merged" },
    });
    expect(identityAnchors(state)).toEqual(identityAnchors(before));

    const rewritten = await refusalOf(() =>
      workflowMutation(fixture, "op-delivery-rewrite", {
        kind: "delivery",
        delivery: { pr: { repo: "o/r", head: "feature/somewhere-else", target: "main" } },
      }),
    );
    expect(rewritten.code).toBe("coordination.invalid-transition");
    expect(rewritten.message).toContain("once at submission");

    const foreignMember = await refusalOf(() =>
      workflowMutation(fixture, "op-delivery-member", {
        kind: "delivery",
        delivery: { completion: { policy: "x", evidence: "y" } },
      }),
    );
    expect(foreignMember.code).toBe("coordination.invalid-transition");

    const malformed = await refusalOf(() =>
      workflowMutation(fixture, "op-delivery-malformed", { kind: "delivery", delivery: { pr: { repo: "o/r" } } } as never),
    );
    expect(malformed.code).toBe("coordination.invalid-input");
  });

  test("a terminal close refuses an unfinished row, incomplete evidence and outstanding ownership", async () => {
    const fixture = await workflowFixture("close-refusals");
    const before = await workflowFootprint(fixture.context);

    const notDone = await refusalOf(() =>
      workflowMutation(fixture, "op-close-notdone", { kind: "lifecycle", status: "completed", reason: "done" }),
    );
    expect(notDone.code).toBe("coordination.invalid-transition");
    expect(notDone.message).toContain("must be Done");
    expect(await workflowFootprint(fixture.context)).toEqual(before);

    setRowStatus(fixture.context, PLAN_ID, "Done");
    const noEvidence = await refusalOf(() =>
      workflowMutation(fixture, "op-close-noevidence", { kind: "lifecycle", status: "completed", reason: "done" }),
    );
    expect(noEvidence.code).toBe("coordination.invalid-transition");
    expect(noEvidence.message).toContain("PHASE6_DELIVERY_EVIDENCE_INCOMPLETE");
    expect(await workflowFootprint(fixture.context)).toEqual(before);

    // The delivery tail is a separate ACCEPTED operation; the close attempts
    // after it are compared against the state it produced.
    await workflowMutation(fixture, "op-close-evidence", { kind: "delivery", delivery: DELIVERY_TAIL });
    plantLease(fixture.context, { ownerEpoch: fixture.epoch, holderId: COORDINATOR_ID, holderRole: "coordinator" });
    const readyToClose = await workflowFootprint(fixture.context);
    const dangling = await refusalOf(() =>
      workflowMutation(fixture, "op-close-dangling", { kind: "lifecycle", status: "completed", reason: "done" }),
    );
    expect(dangling.code).toBe("coordination.invalid-transition");
    expect(dangling.message).toContain("dangling lease");

    // A failed close leaves the routing, the header and the ledger untouched.
    const after = await workflowFootprint(fixture.context);
    expect(after).toEqual(readyToClose);
    expect(parsedJson(after.workflow_state).status).toBe("running");
    expect(parsedJson(after.workflow_state).ended_at).toBeUndefined();
    expect(after.registered).toBe(1);
  });

  test("the terminal close removes routing and keeps history in ONE commit", async () => {
    const fixture = await workflowFixture("close-ok");
    setRowStatus(fixture.context, PLAN_ID, "Done");
    await workflowMutation(fixture, "op-close-ok-evidence", { kind: "delivery", delivery: DELIVERY_TAIL });
    const before = revisions(fixture.context);

    const receipt = await workflowMutation(fixture, "op-close-ok", {
      kind: "lifecycle",
      status: "completed",
      reason: "delivery tail verified",
    });

    // Routing is gone from the receipt's own state.
    expect(receipt.data.workflows.some((workflow) => workflow.state.id === WORKFLOW_ID)).toBe(false);
    const [stored] = rows(
      fixture.context,
      `select (select count(*) as n from execution_registry where workflow_id = '${WORKFLOW_ID}') as registered, ` +
        `(select json_extract(state_json, '$.status') from execution_workflows where workflow_id = '${WORKFLOW_ID}') as status, ` +
        `(select json_extract(state_json, '$.ended_at') from execution_workflows where workflow_id = '${WORKFLOW_ID}') as ended_at, ` +
        `(select count(*) as n from execution_plans where workflow_id = '${WORKFLOW_ID}') as plans`,
    );
    // History stays: the terminal header and its plan rows are still there.
    expect(stored!.registered).toBe(0);
    expect(stored!.status).toBe("completed");
    expect(String(stored!.ended_at)).not.toBe("");
    expect(stored!.plans).toBe(1);
    // One operation: the workflow and the store each advance once, and the
    // registry loss advances the root once.
    expect(revisions(fixture.context)).toEqual({
      root: before.root + 1,
      store: before.store + 1,
      workflow: before.workflow + 1,
    });

    // A closed lifecycle is never amended, and recovery never reopens it.
    const amended = await refusalOf(() =>
      workflowMutation(fixture, "op-close-amend", { kind: "lifecycle", status: "running", reason: "reopen" }, {
        expected: workflowTokenOfRow(fixture.context),
      }),
    );
    expect(amended.code).toBe("coordination.workflow-not-found");
    const reopened = await refusalOf(() =>
      recoverExecutionCoordinator(domainContext(fixture.context, fixture.coordinatorCaller), {
        expected: workflowTokenOfRow(fixture.context),
        operationId: "op-close-recover",
        priorSessionId: COORDINATOR_ID,
        reason: "reopen a closed lifecycle",
        attestation: attestation([COORDINATOR_ID]),
      }),
    );
    expect(reopened.code).toBe("coordination.invalid-transition");
  });

  test("the terminal close's receipt witnesses the root revision it committed", async () => {
    const fixture = await workflowFixture("close-root-token");
    setRowStatus(fixture.context, PLAN_ID, "Done");
    await workflowMutation(fixture, "op-close-token-evidence", { kind: "delivery", delivery: DELIVERY_TAIL });
    const before = revisions(fixture.context);
    // The CAS the close is admitted against, captured so the retry below is an
    // EXACT retry of the same request: a different expected token is a different
    // request hash, not a replay.
    const expected = await liveWorkflowToken(fixture);

    const receipt = await workflowMutation(
      fixture,
      "op-close-token",
      { kind: "lifecycle", status: "completed", reason: "delivery tail verified" },
      { expected },
    );
    expect(receipt.replayed).toBe(false);

    // §3.1 the receipt witnesses the COMMITTED root this close produced: the
    // registry loss advanced the root revision and its timestamp in the SAME
    // transaction, so the token the caller stores back as CAS is the POST-close
    // root token — never the pre-close one the frame read at BEGIN.
    const after = await readExecutionState(fixture.context);
    expect(revisions(fixture.context).root).toBe(before.root + 1);
    expect(receipt.token).toBe(after.token);
    expect(receipt.data.root.updated_at).toBe(after.data.root.updated_at);

    // §3.1 the identical retry replays that same post-close receipt, so a caller
    // holding it addresses the authority the close actually left behind.
    const replay = await workflowMutation(
      fixture,
      "op-close-token",
      { kind: "lifecycle", status: "completed", reason: "delivery tail verified" },
      { expected },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.token).toBe(after.token);
  });

  test("pause and resume keep the lifecycle and never touch a lease", async () => {
    const fixture = await workflowFixture("pause-resume");
    plantLease(fixture.context, { ownerEpoch: fixture.epoch, holderId: COORDINATOR_ID, holderRole: "coordinator" });
    const leasesBefore = leaseRows(fixture.context);

    const before = (await readExecutionState(fixture.context)).data.workflows[0]!.state as unknown as Record<string, unknown>;
    const paused = await workflowMutation(fixture, "op-pause", {
      kind: "lifecycle",
      status: "paused",
      reason: "operator hold",
    });
    const pausedState = paused.data.workflows[0]!.state as unknown as Record<string, unknown>;
    expect(pausedState.status).toBe("paused");
    expect(identityAnchors(pausedState)).toEqual(identityAnchors(before));
    const resumed = await workflowMutation(fixture, "op-resume", {
      kind: "lifecycle",
      status: "running",
      reason: "hold lifted",
    });
    expect((resumed.data.workflows[0]!.state as unknown as Record<string, unknown>).status).toBe("running");
    // Retaining ownership IS the rule: the lease rows are byte-identical.
    expect(leaseRows(fixture.context)).toEqual(leasesBefore);
  });

  test("a terminal status refuses while a lease is held and never deletes one", async () => {
    const fixture = await workflowFixture("stop-lease");
    plantLease(fixture.context, { ownerEpoch: fixture.epoch, holderId: COORDINATOR_ID, holderRole: "coordinator" });
    const held = await refusalOf(() =>
      workflowMutation(fixture, "op-stop-held", { kind: "lifecycle", status: "stopped", reason: "operator cancelled" }),
    );
    expect(held.code).toBe("coordination.invalid-transition");
    expect(held.details.status).toBe("stopped");

    // Released through the existing release path (a retained tombstone): only
    // then does the lifecycle end, with the row still on disk.
    plantLease(fixture.context, {
      ownerEpoch: fixture.epoch,
      holderId: COORDINATOR_ID,
      holderRole: "coordinator",
      status: "released",
    });
    await workflowMutation(fixture, "op-stop-clean", { kind: "lifecycle", status: "stopped", reason: "operator cancelled" });
    expect(leaseRows(fixture.context)).toHaveLength(1);
  });

  test("an unauthorized, foreign, stale or staged address is refused before any write", async () => {
    const fixture = await workflowFixture("unauthorized");
    const before = await workflowFootprint(fixture.context);

    // A plan-pm identity never performs a workflow-level transition.
    const planSeat = await refusalOf(() =>
      workflowMutation(fixture, "op-unauthorized-seat", { kind: "lifecycle", status: "paused", reason: "not mine" }, {
        who: trustedCaller(COORDINATOR_ID, "plan-pm", PLAN_ID),
      }),
    );
    expect(planSeat.code).toBe("execution.scope-mismatch");

    // A coordinator reference of another workflow authorizes nothing here.
    const foreignCaller: ExecutionCaller = { sessionId: "host-other", role: "coordinator", workflowId: "wf-other", planId: null };
    const foreign = await refusalOf(() =>
      workflowMutation(fixture, "op-unauthorized-session", { kind: "lifecycle", status: "paused", reason: "not mine" }, {
        who: foreignCaller,
        session: { ...fixture.coordinator, sessionId: "host-other", workflowId: "wf-other" },
      }),
    );
    expect(foreign.code).toBe("execution.scope-mismatch");

    // A superseded token is a stale CAS, not a permission.
    const live = await liveWorkflowToken(fixture);
    const stale = live.replace(/:([0-9]+)$/, (_match: string, revision: string) => `:${Number(revision) + 7}`);
    const staleRefusal = await refusalOf(() =>
      workflowMutation(fixture, "op-stale-token", { kind: "lifecycle", status: "paused", reason: "stale" }, {
        expected: stale as ExecutionToken,
      }),
    );
    expect(staleRefusal.code).toBe("execution.stale-token");

    // A staged authority serves no workflow transition at all.
    withRaw(fixture.context, (db) => {
      db.prepare("update execution_meta set authority_state = 'staged' where id = 1").run();
    });
    const staged = await refusalOf(() =>
      workflowMutation(fixture, "op-staged", { kind: "lifecycle", status: "paused", reason: "staged" }),
    );
    expect(staged.code).toBe("execution.not-active");
    withRaw(fixture.context, (db) => {
      db.prepare("update execution_meta set authority_state = 'active' where id = 1").run();
    });

    expect(await workflowFootprint(fixture.context)).toEqual(before);
  });
});

/* ------------------------------------------------------------------------ *
 * §2.3/§4.2 recoverExecutionCoordinator
 * ------------------------------------------------------------------------ */

describe("execution-coordinator-recovery: \u00A72.3/\u00A74.2 the named recovery bootstrap", () => {
  test("recovery without a named, attested-stopped holder refuses", async () => {
    const fixture = await workflowFixture("recovery-refusals");
    const before = await workflowFootprint(fixture.context);
    const expected = await liveWorkflowToken(fixture);
    const recover = (input: { operationId: string; priorSessionId: string | null; attestation: ActivationAttestation }) =>
      recoverExecutionCoordinator(domainContext(fixture.context, fixture.coordinatorCaller), {
        expected,
        operationId: input.operationId,
        priorSessionId: input.priorSessionId,
        reason: "coordinator process stopped",
        attestation: input.attestation,
      });

    // The attestation does not name the holder being replaced.
    const unnamed = await refusalOf(() =>
      recover({ operationId: "op-recover-unnamed", priorSessionId: COORDINATOR_ID, attestation: attestation(["host-elsewhere"]) }),
    );
    expect(unnamed.code).toBe("coordination.invalid-transition");
    expect(unnamed.message).toContain("does not name the prior coordinator");

    // A holder the workflow does not record.
    const unknown = await refusalOf(() =>
      recover({ operationId: "op-recover-unknown", priorSessionId: "host-ghost", attestation: attestation(["host-ghost"]) }),
    );
    expect(unknown.code).toBe("coordination.session-not-found");

    // Claiming there is no prior holder while the workflow records one.
    const hidden = await refusalOf(() =>
      recover({ operationId: "op-recover-hidden", priorSessionId: null, attestation: attestation([COORDINATOR_ID]) }),
    );
    expect(hidden.code).toBe("coordination.invalid-transition");
    expect(hidden.message).toContain("must NAME the holder");

    // An incomplete attestation document never reaches the store.
    const document = { ...attestation([COORDINATOR_ID]), operator: { actor: "ops-engineer", authorizationRef: "   " } };
    const invalidDocument = await refusalOf(() =>
      recover({ operationId: "op-recover-document", priorSessionId: COORDINATOR_ID, attestation: document }),
    );
    expect(invalidDocument.code).toBe("store.attestation-invalid");

    expect(await workflowFootprint(fixture.context)).toEqual(before);
  });

  test("recovery never takes over an owner it may not replace", async () => {
    const fixture = await workflowFixture("recovery-live");
    // A live holder with NO stop evidence: the engine cannot observe a dead
    // process, so this is the silent takeover the transition must refuse.
    const expected = await liveWorkflowToken(fixture);
    const before = await workflowFootprint(fixture.context);
    const silent = await refusalOf(() =>
      recoverExecutionCoordinator(domainContext(fixture.context, fixture.coordinatorCaller), {
        expected,
        operationId: "op-recover-silent",
        priorSessionId: COORDINATOR_ID,
        reason: "take over a live coordinator",
        attestation: attestation([]),
      }),
    );
    expect(silent.code).toBe("coordination.invalid-transition");
    expect(silent.message).toContain("stop evidence");
    expect(await workflowFootprint(fixture.context)).toEqual(before);

    // After an authorized replacement, the replaced identity may not be named
    // again while the new holder is live.
    await recoverExecutionCoordinator(domainContext(fixture.context, trustedCaller(RECOVERY_ID, "coordinator", null)), {
      expected,
      operationId: "op-recover-live-first",
      priorSessionId: COORDINATOR_ID,
      reason: "coordinator process stopped",
      attestation: attestation([COORDINATOR_ID]),
    });
    const named = await refusalOf(() =>
      recoverExecutionCoordinator(domainContext(fixture.context, trustedCaller(RECOVERY_ID, "coordinator", null)), {
        expected: workflowTokenOfRow(fixture.context),
        operationId: "op-recover-live-second",
        priorSessionId: COORDINATOR_ID,
        reason: "replace the replaced identity",
        attestation: attestation([COORDINATOR_ID]),
      }),
    );
    expect(named.code).toBe("coordination.duplicate-holder");
    expect(named.details.holder).toBe(RECOVERY_ID);
  });

  test("recovery invalidates the old reference, binds the caller and replays idempotently", async () => {
    const fixture = await workflowFixture("recovery-ok");
    const expected = await liveWorkflowToken(fixture);
    const replacement = trustedCaller(RECOVERY_ID, "coordinator", null);
    const call = (operationId: string) =>
      recoverExecutionCoordinator(domainContext(fixture.context, replacement), {
        expected,
        operationId,
        priorSessionId: COORDINATOR_ID,
        reason: "coordinator process stopped",
        attestation: attestation([COORDINATOR_ID]),
      });

    const receipt = await call("op-recover-ok");
    expect(receipt.replayed).toBe(false);
    expect(receipt.data).toEqual({
      storeId: fixture.storeId,
      epoch: fixture.epoch,
      workflowId: WORKFLOW_ID,
      role: "coordinator",
      sessionId: RECOVERY_ID,
      planId: null,
    });

    // The store serves the replacement, and its binding is usable.
    const state = await readExecutionState(fixture.context);
    expect(state.data.workflows[0]!.coordinator).toEqual(receipt.data);
    const paused = await workflowMutation(fixture, "op-recovery-transition", {
      kind: "lifecycle",
      status: "paused",
      reason: "operator hold",
    }, { who: replacement, session: receipt.data });
    expect((paused.data.workflows[0]!.state as unknown as Record<string, unknown>).status).toBe("paused");

    // The old reference authorizes nothing any more.
    const revoked = await refusalOf(() =>
      workflowMutation(fixture, "op-recovery-old-ref", { kind: "lifecycle", status: "running", reason: "old identity returns" }),
    );
    expect(revoked.code).toBe("execution.session-unavailable");
    expect(sessionState(fixture.context, COORDINATOR_ID)).toBe("revoked");
    expect(sessionState(fixture.context, RECOVERY_ID)).toBe("active");

    // Replay: the same operation id returns its recorded receipt, advancing nothing.
    const before = await workflowFootprint(fixture.context);
    const replay = await call("op-recover-ok");
    expect(replay.replayed).toBe(true);
    expect(replay.data).toEqual(receipt.data);
    expect(await workflowFootprint(fixture.context)).toEqual(before);
  });

  test("a lease the revocation orphaned becomes readable and is adopted with its epoch unchanged", async () => {
    const fixture = await workflowFixture("recovery-orphan");
    // The state a crashed coordinator leaves: it holds a plan's lease in the
    // CURRENT epoch, while its session row is no longer active.
    plantLease(fixture.context, { ownerEpoch: fixture.epoch, holderId: COORDINATOR_ID, holderRole: "coordinator" });
    withRaw(fixture.context, (db) => {
      db.prepare("update execution_sessions set state = 'revoked' where workflow_id = ? and session_id = ?").run(
        WORKFLOW_ID,
        COORDINATOR_ID,
      );
    });

    // R7's consumer-visible symptom: the whole-view reader refuses the pair.
    const corrupt = await refusalOf(() => readExecutionState(fixture.context));
    expect(corrupt.code).toBe("store.corrupt");

    const receipt = await recoverExecutionCoordinator(
      domainContext(fixture.context, trustedCaller(RECOVERY_ID, "coordinator", null)),
      {
        expected: workflowTokenOfRow(fixture.context),
        operationId: "op-recover-orphan",
        priorSessionId: COORDINATOR_ID,
        reason: "coordinator stopped while holding a plan lease",
        attestation: attestation([COORDINATOR_ID]),
      },
    );
    expect(receipt.replayed).toBe(false);

    // The lifecycle reads again, and the orphaned ownership is now the recovery
    // session's — with the epoch it was claimed in, unchanged.
    const state = await readExecutionState(fixture.context);
    expect(state.data.workflows).toHaveLength(1);
    const [lease] = leaseRows(fixture.context);
    expect(parsedJson(lease!.lease_json)).toMatchObject({
      holder_session_id: RECOVERY_ID,
      holder_role: "coordinator",
      transferred_from: COORDINATOR_ID,
    });
    expect(Number(lease!.owner_epoch)).toBe(fixture.epoch);
  });

  test("recovery adopts only the ownership the revocation it names orphaned", async () => {
    const fixture = await workflowFixture("recovery-foreign-orphan");
    // An UNRELATED plan-pm holder that stopped while holding a plan lease in the
    // CURRENT epoch: the same unreadable pair the case above repairs, owned by a
    // session this recovery neither names nor attests. A crash state is planted
    // (no W-phase verb produces a lease held by a session that is not its own).
    const elsewhere = "host-plan-pm-elsewhere";
    plantLease(fixture.context, { ownerEpoch: fixture.epoch, holderId: elsewhere, holderRole: "plan-pm" });
    withRaw(fixture.context, (db) => {
      db.prepare(
        "insert into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
          "values (?, 'plan-pm', ?, ?, ?, 2, 'revoked', ?)",
      ).run(WORKFLOW_ID, elsewhere, PLAN_ID, fixture.epoch, TS);
    });
    const leasesBefore = leaseRows(fixture.context);
    expect((await refusalOf(() => readExecutionState(fixture.context))).code).toBe("store.corrupt");

    // The recovery names and attests ONLY the coordinator.
    const receipt = await recoverExecutionCoordinator(
      domainContext(fixture.context, trustedCaller(RECOVERY_ID, "coordinator", null)),
      {
        expected: workflowTokenOfRow(fixture.context),
        operationId: "op-recover-foreign-orphan",
        priorSessionId: COORDINATOR_ID,
        reason: "coordinator stopped",
        attestation: attestation([COORDINATOR_ID]),
      },
    );
    expect(receipt.replayed).toBe(false);
    expect(receipt.data.sessionId).toBe(RECOVERY_ID);
    expect(sessionState(fixture.context, RECOVERY_ID)).toBe("active");

    // The unrelated holder's ownership is NOT adopted: byte-identical row and no
    // transfer provenance. It stays outstanding — §2.3 keeps outstanding leases
    // at their own owner_epoch pending an explicit reconcile (or a recovery that
    // names THEIR holder), so the workflow stays fail-closed instead of handing
    // the new coordinator an ownership nothing attested.
    expect(leaseRows(fixture.context)).toEqual(leasesBefore);
    const [lease] = leaseRows(fixture.context);
    expect(parsedJson(lease!.lease_json)).toMatchObject({
      holder_session_id: elsewhere,
      holder_role: "plan-pm",
    });
    expect(parsedJson(lease!.lease_json).transferred_from).toBeUndefined();
    expect((await refusalOf(() => readExecutionState(fixture.context))).code).toBe("store.corrupt");
  });

  test("an old-epoch lease is never revived by recovery", async () => {
    const fixture = await workflowFixture("recovery-old-epoch");
    // Ownership from BEFORE the current epoch (what an activation leaves
    // behind) is represented, authorizes nothing, and stays exactly as it is.
    plantLease(fixture.context, {
      ownerEpoch: fixture.epoch - 1,
      holderId: "host-before-activation",
      holderRole: "coordinator",
    });
    const before = leaseRows(fixture.context);
    await recoverExecutionCoordinator(domainContext(fixture.context, trustedCaller(RECOVERY_ID, "coordinator", null)), {
      expected: await liveWorkflowToken(fixture),
      operationId: "op-recover-old-epoch",
      priorSessionId: COORDINATOR_ID,
      reason: "coordinator process stopped",
      attestation: attestation([COORDINATOR_ID]),
    });
    expect(leaseRows(fixture.context)).toEqual(before);
  });
});
