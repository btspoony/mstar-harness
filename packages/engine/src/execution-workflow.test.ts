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
  readExecutionPlan,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionMutation,
  type ExecutionPlanWitness,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionState,
  type ExecutionToken,
} from "../src/execution-store.js";
import {
  mutateExecutionPlan,
  withExecutionPlanAuthority,
} from "../src/execution-coordination.js";
import {
  mutateExecutionWorkflow,
  recoverExecutionCoordinator,
  setWorkflowWitnessGapForTest,
} from "../src/execution-workflow.js";
import { initializeStore, storeDbPath, type StoreContext, type StoreDb } from "../src/store-db.js";
import type { PlanProgress } from "../src/coordination-write.js";
import { prepareAmendmentComponent } from "../src/coordination.js";
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
const PLAN_PM_ID = "host-plan";
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
  test("exports both APIs verbatim with their §3 signatures", () => {
    // The compile-time pins: each binding fails to typecheck if the declared
    // signature drifts from primary spec §3. § One resolver path (S2/E02) the
    // workflow intent accepts the same envelope with its derivable half
    // (`session`, `expected`, `workflowId`) optional, so a fully specified call
    // still satisfies the pin.
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
    // A request for the path the header ALREADY records is a satisfied effect:
    // it writes nothing, so no probe of it can go stale (A12). The call below is
    // a CHANGE of the recorded path, which is what takes the probe this case is
    // about — and the checkout it probes is switched in the probe→commit window.
    withRaw(fixture.context, (db) => {
      db.prepare(
        "update execution_workflows set state_json = json_set(state_json, '$.integration_worktree_path', ?) where workflow_id = ?",
      ).run(join(fixture.repoRoot, "wt-recorded-earlier"), WORKFLOW_ID);
    });
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
    // §R5/A19 the delivery tail (compound | pr | merge) is EXTERNAL evidence:
    // it is captured when it is observed, whatever the row's own `Done`
    // projection is, because the close composes that projection itself from the
    // same evidence — the ordering is bookkeeping, never a caller ceremony.
    const captured = await workflowMutation(fixture, "op-delivery-early", {
      kind: "delivery",
      delivery: { compound: { outcome: "created" } },
    });
    expect(captured.data.workflows[0]!.state.delivery).toMatchObject({ compound: { outcome: "created" } });
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

    // §R5/§R10 (A18) the close COMPOSES a row that its recorded evidence can
    // complete; a row that records no reviewed evidence at all is the ONE
    // decision the close cannot supply, and it is named on its own.
    const notDone = await refusalOf(() =>
      workflowMutation(fixture, "op-close-notdone", { kind: "lifecycle", status: "completed", reason: "done" }),
    );
    expect(notDone.code).toBe("coordination.invalid-transition");
    expect(notDone.message).toContain("records no handoff at all");
    expect(notDone.details.needed).toContain("reviewed evidence");
    expect(notDone.details.recovery).toMatchObject({ outcome: "unresolved", commitState: "none" });
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

  test("a completed report-only plan terminally unregisters after its completion evidence", async () => {
    const fixture = await workflowFixture("close-report-only");
    withRaw(fixture.context, (db) => {
      const row = db.prepare("select state_json from execution_workflows where workflow_id = ?").get(WORKFLOW_ID) as { state_json: string };
      const state = JSON.parse(row.state_json) as Record<string, unknown>;
      state.delivery_kind = "verification/report-only";
      state.completion_policy = "acceptance report";
      delete state.branch;
      state.delivery = { completion: { policy: "acceptance report", evidence: "acceptance.md" } };
      db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(JSON.stringify(state), WORKFLOW_ID);
    });
    setRowStatus(fixture.context, PLAN_ID, "Done");
    const receipt = await workflowMutation(fixture, "op-close-report-only", {
      kind: "lifecycle",
      status: "completed",
      reason: "acceptance report verified",
    });
    expect(receipt.data.workflows.some((workflow) => workflow.state.id === WORKFLOW_ID)).toBe(false);
    const [stored] = rows(
      fixture.context,
      `select (select count(*) as n from execution_registry where workflow_id = '${WORKFLOW_ID}') as registered, ` +
        `(select json_extract(state_json, '$.status') from execution_workflows where workflow_id = '${WORKFLOW_ID}') as status`,
    );
    expect(stored!.registered).toBe(0);
    expect(stored!.status).toBe("completed");
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

    // A token of a SUPERSEDED AUTHORITY GENERATION is a generation fence: it
    // authorizes nothing, is reported with the typed re-resolution cause, and
    // nothing is replayed (A26). A superseded REVISION alone is not a fence — the
    // intent is recomputed against the current state instead (the
    // `unrelated revision` case below).
    const [storeRow] = rows(fixture.context, "select store_id, authority_epoch from store_meta where id = 1");
    const [headerRow] = rows(
      fixture.context,
      `select revision from execution_workflows where workflow_id = '${WORKFLOW_ID}'`,
    );
    const futureEpochToken = executionToken(
      "workflow",
      String(storeRow!.store_id),
      Number(storeRow!.authority_epoch) + 1,
      [WORKFLOW_ID],
      Number(headerRow!.revision),
    );
    const staleEpochRefusal = await refusalOf(() =>
      workflowMutation(fixture, "op-stale-epoch", { kind: "lifecycle", status: "paused", reason: "stale" }, {
        expected: futureEpochToken,
      }),
    );
    expect(staleEpochRefusal.code).toBe("store.stale-epoch");
    expect(recoveryOf(staleEpochRefusal.details).commitState).toBe("none");

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
 * §4.1/§4.2 semantic replay, reconciliation and typed causes
 * ------------------------------------------------------------------------ */

/** The typed cause one refusal carries, as the consumer contract exposes it. */
function recoveryOf(details: Record<string, unknown>): Record<string, unknown> {
  const recovery = details.recovery;
  if (typeof recovery !== "object" || recovery === null || Array.isArray(recovery)) {
    throw new Error(`the refusal carries no recovery sidecar: ${JSON.stringify(details)}`);
  }
  return recovery as Record<string, unknown>;
}

/** The unresolved components of one recovery sidecar, in order. */
function problemsOf(recovery: Record<string, unknown>): Array<Record<string, unknown>> {
  const unresolved = recovery.unresolved;
  if (!Array.isArray(unresolved)) throw new Error("the recovery sidecar lists no unresolved components");
  return unresolved as Array<Record<string, unknown>>;
}

/** One string list of a recovery sidecar or problem, as one line a consumer can read. */
function listOf(owner: Record<string, unknown>, key: string): string {
  const value = owner[key];
  if (!Array.isArray(value)) throw new Error(`the recovery report carries no ${key}`);
  return value.map((entry) => String(entry)).join("; ");
}

/**
 * The ONE thing a committed plan operation does to the workflow it belongs to:
 * `advancePlanOperationRevisions` moves the workflow's revision and the store's
 * revision without touching the workflow header. A caller's token for that header
 * is then stale for a reason that says nothing about the intent it carries.
 */
function commitSiblingPlanChange(context: StoreContext): void {
  withRaw(context, (db) => {
    db.prepare("update execution_workflows set revision = revision + 1 where workflow_id = ?").run(WORKFLOW_ID);
    db.prepare("update store_meta set revision = revision + 1 where id = 1").run();
  });
}

describe("execution-workflow: \u00A74.1/\u00A74.2 semantic replay and typed causes", () => {
  test("semantic replay: a repeat that re-read the state replays the recorded receipt with zero churn (A09/A01)", async () => {
    const fixture = await workflowFixture("replay-zero-churn");
    const policy = { plan_parallelism: "parallel" };
    const firstToken = await liveWorkflowToken(fixture);
    const first = await workflowMutation(fixture, "op-replay-policy", { kind: "execution-policy", policy }, {
      expected: firstToken,
    });
    expect(first.replayed).toBe(false);
    expect(first.recovery?.outcome).toBe("applied");
    expect(first.recovery?.commitState).toBe("committed");
    const settled = await workflowFootprint(fixture.context);

    // The retry re-read the state first, so it presents a token read AFTER the
    // commit: the transport freshness moved, the intent did not. That is the
    // replay — the recorded receipt, and not one revision or receipt row more.
    const retryToken = await liveWorkflowToken(fixture);
    expect(retryToken).not.toBe(firstToken);
    const again = await workflowMutation(fixture, "op-replay-policy", { kind: "execution-policy", policy });
    expect(again.replayed).toBe(true);
    expect(again.operationId).toBe("op-replay-policy");
    expect(again.token).toBe(first.token);
    expect(again.recovery?.outcome).toBe("already-satisfied");
    expect(again.recovery?.commitState).toBe("committed");
    expect(await workflowFootprint(fixture.context)).toEqual(settled);
  });

  test("semantic replay: a satisfied effect is the current success with no receipt and no churn (A12)", async () => {
    const fixture = await workflowFixture("satisfied-effect");
    const policy = { plan_parallelism: "parallel" };
    const expected = await liveWorkflowToken(fixture);
    await workflowMutation(fixture, "op-settled-policy", { kind: "execution-policy", policy }, { expected });
    const settled = await workflowFootprint(fixture.context);

    // A DIFFERENT operation id and the token read BEFORE the commit: the effect
    // is already held, so this is the current success — no receipt row, no
    // revision, no timestamp — and the drift is reported as provenance (A10),
    // never as a refusal.
    const held = await workflowMutation(fixture, "op-already-held", { kind: "execution-policy", policy }, { expected });
    expect(held.replayed).toBe(true);
    expect(held.recovery?.outcome).toBe("already-satisfied");
    expect(held.recovery?.commitState).toBe("none");
    expect(held.recovery?.warnings?.[0]?.code).toBe("execution.token-drifted");
    expect(held.recovery?.warnings?.[0]?.path).toBe("expected");
    expect(await workflowFootprint(fixture.context)).toEqual(settled);
  });

  test("unrelated revision: a token drifted by a committed sibling change is recomputed, sibling retained (A10)", async () => {
    const fixture = await workflowFixture("unrelated-drift");
    const expected = await liveWorkflowToken(fixture);
    const before = revisions(fixture.context);
    // A committed operation on a CHILD of the workflow: the row moves and the
    // workflow's revision with it, while the header — the read set of a policy
    // change — is byte-identical to what the caller read.
    setRowStatus(fixture.context, PLAN_ID, "InProgress");
    commitSiblingPlanChange(fixture.context);
    const drifted = revisions(fixture.context);
    expect(drifted.workflow).toBe(before.workflow + 1);
    expect(drifted.store).toBe(before.store + 1);

    const receipt = await workflowMutation(
      fixture,
      "op-drift-policy",
      { kind: "execution-policy", policy: { plan_parallelism: "parallel" } },
      { expected },
    );
    expect(receipt.replayed).toBe(false);
    expect(receipt.recovery?.outcome).toBe("applied");
    expect(receipt.recovery?.warnings?.[0]?.code).toBe("execution.token-drifted");

    // The sibling's own work is retained, the header carries the requested
    // policy, and this accepted operation spends ONE revision of each counter.
    const [row] = rows(
      fixture.context,
      `select json_extract(state_json, '$.status') as status from execution_plans ` +
        `where workflow_id = '${WORKFLOW_ID}' and plan_id = '${PLAN_ID}'`,
    );
    expect(row!.status).toBe("InProgress");
    const [header] = rows(
      fixture.context,
      `select json_extract(state_json, '$.execution_policy') as policy from execution_workflows where workflow_id = '${WORKFLOW_ID}'`,
    );
    expect(JSON.parse(String(header!.policy))).toEqual({ plan_parallelism: "parallel" });
    expect(revisions(fixture.context)).toEqual({
      root: drifted.root,
      store: drifted.store + 1,
      workflow: drifted.workflow + 1,
    });
  });

  test("relevant conflict: a phase the current gate does not produce is refused with its exact field (A11)", async () => {
    const fixture = await workflowFixture("relevant-conflict");
    setRowStatus(fixture.context, PLAN_ID, "Done");
    await workflowMutation(fixture, "op-conflict-evidence", { kind: "delivery", delivery: DELIVERY_TAIL });
    writeCompass(fixture.compassPath, {
      status: "completed",
      plans: [PLAN_ID],
      targetBranch: "main",
      endDate: "2026-01-02",
    });
    const before = await workflowFootprint(fixture.context);

    // The gate of this lifecycle produces phase-4; the request asks for phase-2.
    // The refusal keeps its own verdict AND names the exact conflicting field,
    // its current value, the requested one and the one decision left.
    const refused = await refusalOf(() =>
      workflowMutation(fixture, "op-conflict-phase", {
        kind: "phase",
        phase: "phase-2-execute",
        compassPath: fixture.compassPath,
      }),
    );
    expect(refused.code).toBe("coordination.invalid-transition");
    expect(refused.details.gate).toBe("phase-4-pr-delivery");
    const recovery = recoveryOf(refused.details);
    expect(recovery.outcome).toBe("unresolved");
    expect(recovery.commitState).toBe("none");
    const problems = problemsOf(recovery);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.component).toBe("workflow-header");
    expect(problems[0]!.path).toBe("operation.phase");
    expect(listOf(problems[0]!, "currentFacts")).toContain("phase-4-pr-delivery");
    expect(String(problems[0]!.withheldEffect)).toContain("was not overwritten");
    expect(String(problems[0]!.needed)).toContain("phase-2-execute");
    expect(listOf(problems[0]!, "availableWork")).toContain("read the current state of workflow");
    expect(await workflowFootprint(fixture.context)).toEqual(before);
  });

  test("relevant conflict: an operation id reused for a different payload is disclosed, not replayed (A13)", async () => {
    const fixture = await workflowFixture("reused-operation-id");
    const first = await workflowMutation(fixture, "op-reused", {
      kind: "execution-policy",
      policy: { plan_parallelism: "parallel" },
    });
    expect(first.replayed).toBe(false);
    const settled = await workflowFootprint(fixture.context);

    // The same id with a DIFFERENT business payload is not the same intent: the
    // recorded receipt must not answer it, and the typed cause names both the
    // committed fingerprint and the requested one.
    const refused = await refusalOf(() =>
      workflowMutation(fixture, "op-reused", { kind: "execution-policy", policy: { plan_parallelism: "serial" } }),
    );
    expect(refused.code).toBe("execution.operation-conflict");
    const recovery = recoveryOf(refused.details);
    expect(recovery.outcome).toBe("unresolved");
    // This call committed nothing; the RECORDED operation is the committed one,
    // and the facts say so.
    expect(recovery.commitState).toBe("none");
    const problems = problemsOf(recovery);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.component).toBe("operation");
    expect(listOf(problems[0]!, "currentFacts")).toContain("is committed for workflow");
    expect(String(problems[0]!.needed)).toContain("new operation id");
    expect(await workflowFootprint(fixture.context)).toEqual(settled);
  });

  test("semantic replay: a superseded receipt is disclosed, never restored (A13)", async () => {
    const fixture = await workflowFixture("superseded-receipt");
    const pause = await workflowMutation(fixture, "op-supersede", {
      kind: "lifecycle",
      status: "paused",
      reason: "operator hold",
    });
    expect(pause.replayed).toBe(false);
    // A later accepted operation moves the SAME field on: the recorded effect no
    // longer holds, so its receipt is historical evidence and is never served as
    // current state.
    await workflowMutation(fixture, "op-supersede-on", { kind: "lifecycle", status: "running", reason: "operator release" });
    const current = await workflowFootprint(fixture.context);
    expect(parsedJson(current.workflow_state).status).toBe("running");

    const refused = await refusalOf(() =>
      workflowMutation(fixture, "op-supersede", { kind: "lifecycle", status: "paused", reason: "operator hold" }),
    );
    expect(refused.code).toBe("execution.effect-superseded");
    const recovery = recoveryOf(refused.details);
    expect(recovery.outcome).toBe("unresolved");
    expect(recovery.commitState).toBe("none");
    const problems = problemsOf(recovery);
    expect(problems[0]!.path).toBe("operation.status");
    expect(listOf(problems[0]!, "currentFacts")).toContain("running");
    expect(String(problems[0]!.withheldEffect)).toContain("never restored");
    expect(await workflowFootprint(fixture.context)).toEqual(current);
  });

  test("authority epoch: a generation change is re-resolved and never replays the old epoch (A26)", async () => {
    const fixture = await workflowFixture("epoch-generation");
    const expected = await liveWorkflowToken(fixture);
    const policy = { plan_parallelism: "parallel" };
    const first = await workflowMutation(fixture, "op-epoch-policy", { kind: "execution-policy", policy }, { expected });
    expect(first.replayed).toBe(false);
    const before = await workflowFootprint(fixture.context);

    // A real generation change: the store's authority epoch advances (the step
    // the activation path performs), while this caller's reference and token
    // still name the old one. The committed receipt of the OLD epoch must not
    // answer this call, and the cause names the re-resolution it needs.
    withRaw(fixture.context, (db) => {
      db.prepare("update store_meta set authority_epoch = authority_epoch + 1 where id = 1").run();
    });
    const refused = await refusalOf(() =>
      workflowMutation(fixture, "op-epoch-policy", { kind: "execution-policy", policy }, { expected }),
    );
    expect(refused.code).toBe("store.stale-epoch");
    const recovery = recoveryOf(refused.details);
    expect(recovery.outcome).toBe("unresolved");
    expect(recovery.commitState).toBe("none");
    const problems = problemsOf(recovery);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.path).toBe("epoch");
    expect(listOf(problems[0]!, "currentFacts")).toContain("current authority epoch");
    expect(listOf(problems[0]!, "availableWork")).toContain("resume or rebind your own execution session");
    expect(await workflowFootprint(fixture.context)).toEqual(before);
  });

  test("relevant conflict: an unavailable prerequisite is typed with no commit (A25)", async () => {
    const fixture = await workflowFixture("git-unavailable");
    const before = await workflowFootprint(fixture.context);

    // Git is genuinely required to prove an integration checkout belongs to this
    // repository. With no readable Git worktree the transition is reported as an
    // unavailable prerequisite with its known commit boundary (none) and the work
    // that remains possible — never as a missing user field and never as a
    // fabricated substitute fact.
    rmSync(join(fixture.repoRoot, ".git"), { recursive: true, force: true });
    const refused = await refusalOf(() =>
      workflowMutation(fixture, "op-git-unavailable", {
        kind: "integration-worktree",
        path: fixture.integrationPath,
      }),
    );
    expect(refused.code).toBe("coordination.not-in-git");
    const recovery = recoveryOf(refused.details);
    expect(recovery.outcome).toBe("unresolved");
    expect(recovery.commitState).toBe("none");
    const problems = problemsOf(recovery);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.component).toBe("operation-prerequisite");
    expect(problems[0]!.code).toBe("coordination.not-in-git");
    expect(refused.details.stage).toBe("read");
    expect(listOf(problems[0]!, "currentFacts")).toContain("did not get past that read");
    expect(listOf(problems[0]!, "availableWork")).toContain("lifecycle, execution-policy, delivery");
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

/* ------------------------------------------------------------------------ *
 * E08 — the Prepare amendment's components on the ACTIVE DB route
 * ------------------------------------------------------------------------ */

/**
 * The compound Prepare amendment is the FILE route's patch surface
 * (`amendPrepareWorkflow`). Two of its components also exist as ACTIVE-route
 * operations — `execution-policy` and `integration-worktree` — and the contract
 * the two authority routes share is what these cases pin: the ONE closed
 * `plan_parallelism` set (exported by `coordination.ts`, not mirrored here), the
 * ONE `recovery.applied` component vocabulary, one connected effect per accepted
 * operation (one revision + one receipt), and a replayed component that spends
 * no second mutation. Every fixture is a real Git control harness in its own
 * temporary directory; no test reads or writes this checkout's `store.db`.
 */
describe("execution-workflow: the Prepare amendment's components on the ACTIVE route (E08)", () => {
  /** One amendment component identity, as the FILE route emits it. */
  function fileRouteEntry(kind: "integration-worktree" | "execution-policy", value: string): string {
    return prepareAmendmentComponent(kind, value);
  }

  test("connected amendment — the active route applies ONE shared execution-policy rule and reports ONE component identity (A23)", async () => {
    const fixture = await workflowFixture("amendment-shared-rule");
    // The closed vocabulary is one rule for both routes: the active route accepts
    // exactly the values the file route's amendment accepts, and its receipt
    // names the component in the SAME vocabulary that amendment emits.
    for (const value of ["parallel", "serial"]) {
      const receipt = await workflowMutation(fixture, `op-amendment-policy-${value}`, {
        kind: "execution-policy",
        policy: { plan_parallelism: value, worktree_mode: "required" },
      });
      expect((receipt.data.workflows[0]!.state as unknown as Record<string, unknown>).execution_policy).toEqual({
        plan_parallelism: value,
        worktree_mode: "required",
      });
      expect(receipt.recovery?.applied).toEqual([fileRouteEntry("execution-policy", value)]);
      expect(receipt.recovery?.outcome).toBe("applied");
      expect(receipt.recovery?.commitState).toBe("committed");
    }
    const outsideTheSet = await refusalOf(() =>
      workflowMutation(fixture, "op-amendment-policy-outside", {
        kind: "execution-policy",
        policy: { plan_parallelism: "sequential" },
      }),
    );
    expect(outsideTheSet.code).toBe("coordination.invalid-input");

    // The integration-checkout component reports the same identity form, built
    // from the canonical checkout this operation records.
    const fresh = join(fixture.repoRoot, "wt-amendment-shared");
    runGit(["worktree", "add", "-q", "-b", `${INTEGRATION_BRANCH}-shared`, fresh], fixture.repoRoot);
    runGit(["checkout", "--ignore-other-worktrees", "-q", INTEGRATION_BRANCH], fresh);
    const moved = await workflowMutation(fixture, "op-amendment-worktree", {
      kind: "integration-worktree",
      path: fresh,
    });
    expect(moved.recovery?.applied).toEqual([fileRouteEntry("integration-worktree", realpathSync(fresh))]);
    expect((moved.data.workflows[0]!.state as unknown as Record<string, unknown>).integration_worktree_path).toBe(
      realpathSync(fresh),
    );
  });

  test("partial replay — the amendment's components commit once each on the active route and a retry duplicates nothing (A09/A28)", async () => {
    const fixture = await workflowFixture("amendment-components");
    const policy = { plan_parallelism: "parallel", worktree_mode: "required" };

    // Component 1: the policy — one accepted operation, one connected effect.
    const policyReceipt = await workflowMutation(fixture, "op-amendment-policy", { kind: "execution-policy", policy });
    expect(policyReceipt.replayed).toBe(false);
    expect(policyReceipt.recovery?.outcome).toBe("applied");
    expect(policyReceipt.recovery?.applied).toEqual([fileRouteEntry("execution-policy", "parallel")]);
    const afterPolicy = await workflowFootprint(fixture.context);

    // Component 2: the integration checkout. On this route each component is its
    // own transaction, so the second lands on top of the first and touches
    // neither its receipt nor its revision history.
    const fresh = join(fixture.repoRoot, "wt-amendment-2");
    runGit(["worktree", "add", "-q", "-b", `${INTEGRATION_BRANCH}-2`, fresh], fixture.repoRoot);
    runGit(["checkout", "--ignore-other-worktrees", "-q", INTEGRATION_BRANCH], fresh);
    const pathReceipt = await workflowMutation(fixture, "op-amendment-worktree", {
      kind: "integration-worktree",
      path: fresh,
    });
    expect(pathReceipt.replayed).toBe(false);
    expect(pathReceipt.recovery?.applied).toEqual([fileRouteEntry("integration-worktree", realpathSync(fresh))]);
    const afterBoth = await workflowFootprint(fixture.context);
    // Exactly ONE revision of the workflow and the store per applied component.
    expect(Number(afterBoth.workflow_revision)).toBe(Number(afterPolicy.workflow_revision) + 1);
    expect(Number(afterBoth.store_revision)).toBe(Number(afterPolicy.store_revision) + 1);
    expect(Number(afterBoth.operations)).toBe(Number(afterPolicy.operations) + 1);

    // A lost-response retry of the FIRST component — same operation id, the
    // tokens re-read — is the recorded receipt: no second mutation, no revision,
    // and NO applied component reported twice (the later component's commit does
    // not disturb the earlier one's receipt).
    const retry = await workflowMutation(fixture, "op-amendment-policy", { kind: "execution-policy", policy });
    expect(retry.replayed).toBe(true);
    expect(retry.token).toBe(policyReceipt.token);
    expect(retry.recovery?.outcome).toBe("already-satisfied");
    expect(retry.recovery?.applied).toEqual([]);
    expect(await workflowFootprint(fixture.context)).toEqual(afterBoth);
    const state = (await readExecutionState(fixture.context)).data.workflows[0]!.state as unknown as Record<string, unknown>;
    expect(state.execution_policy).toEqual(policy);
    expect(state.integration_worktree_path).toBe(realpathSync(fresh));

    // Independence (A23): a component the route refuses writes nothing and never
    // rolls back the components that already committed.
    const otherRepo = realpathSync(mkdtempSync(join(ROOT, "amendment-foreign-")));
    runGit(["init", "-q", "-b", "main"], otherRepo);
    runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], otherRepo);
    const refused = await refusalOf(() =>
      workflowMutation(fixture, "op-amendment-foreign", { kind: "integration-worktree", path: otherRepo }),
    );
    expect(refused.code).toBe("coordination.scope-mismatch");
    const refusalRecovery = recoveryOf(refused.details);
    expect(refusalRecovery.commitState).toBe("none");
    expect(problemsOf(refusalRecovery).length).toBeGreaterThan(0);
    expect(await workflowFootprint(fixture.context)).toEqual(afterBoth);
    const settled = (await readExecutionState(fixture.context)).data.workflows[0]!.state as unknown as Record<string, unknown>;
    expect(settled.execution_policy).toEqual(policy);
    expect(settled.integration_worktree_path).toBe(realpathSync(fresh));
  });

  test("connected amendment — an aliased checkout spelling reports the SAME component identity the FILE route emits (A23)", async () => {
    const fixture = await workflowFixture("amendment-alias-identity");
    const fresh = join(fixture.repoRoot, "wt-amendment-alias");
    runGit(["worktree", "add", "-q", "-b", `${INTEGRATION_BRANCH}-alias`, fresh], fixture.repoRoot);
    runGit(["checkout", "--ignore-other-worktrees", "-q", INTEGRATION_BRANCH], fresh);

    // ONE checkout, spelled with a lexical ALIAS (`<path>/.`). The route
    // canonicalizes the requested path, so the receipt names the one
    // `integration-worktree` component the FILE route's amendment emits for the
    // recorded value — `prepareAmendmentComponent` over the canonical path, the
    // same rule `coordination.test.ts` pins on the file route. A transport
    // therefore consumes ONE component vocabulary across both authorities, and a
    // spelling never becomes a second component identity.
    const receipt = await workflowMutation(fixture, "op-amendment-alias", {
      kind: "integration-worktree",
      path: `${fresh}/.`,
    });
    expect(receipt.replayed).toBe(false);
    expect(receipt.recovery?.outcome).toBe("applied");
    expect(receipt.recovery?.applied).toEqual([fileRouteEntry("integration-worktree", realpathSync(fresh))]);
    const state = (await readExecutionState(fixture.context)).data.workflows[0]!.state as unknown as Record<string, unknown>;
    expect(state.integration_worktree_path).toBe(realpathSync(fresh));

    // The CANONICAL spelling of that same checkout is the effect already held:
    // the intent is recomputed against the state this transaction reads (A09/A12),
    // so the second spelling spends no revision and reports no applied component.
    const afterAlias = await workflowFootprint(fixture.context);
    const repeat = await workflowMutation(fixture, "op-amendment-alias-repeat", {
      kind: "integration-worktree",
      path: fresh,
    });
    expect(repeat.recovery?.outcome).toBe("already-satisfied");
    expect(repeat.recovery?.applied).toEqual([]);
    expect(repeat.recovery?.commitState).toBe("none");
    expect(await workflowFootprint(fixture.context)).toEqual(afterAlias);
  });
});

/* ------------------------------------------------------------------------ *
 * E10 — the terminal close's residue repair and its convergence (§R5/§R10, A20/A28)
 * ------------------------------------------------------------------------ */

describe("execution-close-composition: §R10/A20 the terminal close's residue repair", () => {
  test("terminal cleanup: a terminal snapshot whose registry row remains is repaired, preserving its outcome (A20)", async () => {
    const fixture = await workflowFixture("close-residue");
    setRowStatus(fixture.context, PLAN_ID, "Done");
    const endedAt = "2026-01-05T06:07:08.000Z";
    // The residue a crashed or foreign writer leaves: the lifecycle already
    // records its terminal outcome and `ended_at`, while its ACTIVE registry row
    // remains. It is a valid terminal snapshot, so nothing here is a rewrite.
    withRaw(fixture.context, (db) => {
      db.prepare(
        "update execution_workflows set state_json = json_set(state_json, '$.status', 'completed', '$.ended_at', ?) " +
          "where workflow_id = ?",
      ).run(endedAt, WORKFLOW_ID);
    });
    const before = revisions(fixture.context);
    // §3.1 the CAS the close is admitted against, captured so the retry below is
    // an EXACT retry of the same request (the close's receipt token is the POST-
    // close ROOT token, which addresses a different kind).
    const expected = await liveWorkflowToken(fixture);

    const receipt = await workflowMutation(
      fixture,
      "op-close-residue",
      { kind: "lifecycle", status: "completed", reason: "residue repaired" },
      { expected },
    );
    expect(receipt.data.workflows.some((workflow) => workflow.state.id === WORKFLOW_ID)).toBe(false);
    const [stored] = rows(
      fixture.context,
      `select (select count(*) as n from execution_registry where workflow_id = '${WORKFLOW_ID}') as registered, ` +
        `(select json_extract(state_json, '$.status') from execution_workflows where workflow_id = '${WORKFLOW_ID}') as status, ` +
        `(select json_extract(state_json, '$.ended_at') from execution_workflows where workflow_id = '${WORKFLOW_ID}') as ended_at`,
    );
    expect(stored!.registered).toBe(0);
    // The recorded outcome and its time are PRESERVED, never rewritten.
    expect(stored!.status).toBe("completed");
    expect(stored!.ended_at).toBe(endedAt);
    // One accepted operation: the workflow and the store each advance once, and
    // the membership loss advances the root once.
    const after = revisions(fixture.context);
    expect(after).toEqual({ root: before.root + 1, store: before.store + 1, workflow: before.workflow + 1 });

    // §R6/A28 the identical retry converges on the SAME effect: the recorded
    // receipt is served, nothing is re-registered and no second cleanup runs.
    const replay = await workflowMutation(
      fixture,
      "op-close-residue",
      { kind: "lifecycle", status: "completed", reason: "residue repaired" },
      { expected },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.recovery?.outcome).toBe("already-satisfied");
    expect(revisions(fixture.context)).toEqual(after);
  });

  test("terminal cleanup: a different terminal outcome is never rewritten over the recorded one (A20)", async () => {
    const fixture = await workflowFixture("close-residue-outcome");
    setRowStatus(fixture.context, PLAN_ID, "Done");
    const endedAt = "2026-01-05T06:07:08.000Z";
    withRaw(fixture.context, (db) => {
      db.prepare(
        "update execution_workflows set state_json = json_set(state_json, '$.status', 'stopped', '$.ended_at', ?) " +
          "where workflow_id = ?",
      ).run(endedAt, WORKFLOW_ID);
    });
    const before = await workflowFootprint(fixture.context);

    // A closed lifecycle is never amended and its outcome is never rewritten —
    // only the restatement of the RECORDED status is its own membership repair.
    const refused = await refusalOf(() =>
      workflowMutation(fixture, "op-close-residue-rewrite", {
        kind: "lifecycle",
        status: "completed",
        reason: "claim it finished",
      }),
    );
    expect(refused.code).toBe("coordination.invalid-transition");
    expect(refused.message).toContain("never amended");
    expect(await workflowFootprint(fixture.context)).toEqual(before);

    const repaired = await workflowMutation(fixture, "op-close-residue-stop", {
      kind: "lifecycle",
      status: "stopped",
      reason: "residue repaired",
    });
    expect(repaired.data.workflows.some((workflow) => workflow.state.id === WORKFLOW_ID)).toBe(false);
    const [stored] = rows(
      fixture.context,
      `select json_extract(state_json, '$.status') as status, json_extract(state_json, '$.ended_at') as ended_at ` +
        `from execution_workflows where workflow_id = '${WORKFLOW_ID}'`,
    );
    expect(stored!.status).toBe("stopped");
    expect(stored!.ended_at).toBe(endedAt);
  });
});

/* ------------------------------------------------------------------------ *
 * §R11/A21/A28 the failed/stopped lifecycle of the DB authority
 * ------------------------------------------------------------------------ */

/**
 * Plant one plan-pm session row in the state a crash leaves it. No W-phase verb
 * hands a lease to a session that then stops — and a plan-pm bind requires a
 * prepared Assignment, a state this fixture deliberately does not build — so the
 * crash states are planted raw, exactly as the W4 fixtures plant a foreign merge
 * lease. `epoch` is the fixture's own, so the row is one ownership fact with the
 * lease that names it.
 */
function plantPlanPmSession(
  context: StoreContext,
  input: { epoch: number; state: "active" | "suspended" | "revoked"; sessionId?: string },
): void {
  withRaw(context, (db) => {
    db.prepare(
      "insert or replace into execution_sessions(workflow_id, role, session_id, plan_id, epoch, revision, state, bound_at) " +
        "values (?, 'plan-pm', ?, ?, ?, 1, ?, ?)",
    ).run(WORKFLOW_ID, input.sessionId ?? PLAN_PM_ID, PLAN_ID, input.epoch, input.state, TS);
  });
}

/** One workflow-level integration merge claim, planted raw (as the W4 fixtures do). */
function plantMergeClaim(context: StoreContext, input: { ownerEpoch: number; holder: string; status?: "held" | "released" }): void {
  withRaw(context, (db) => {
    db.prepare(
      "insert or replace into execution_integration_leases(workflow_id, revision, owner_epoch, lease_json) values (?, 1, ?, ?)",
    ).run(
      WORKFLOW_ID,
      input.ownerEpoch,
      JSON.stringify({
        holder: input.holder,
        claimed_at: TS,
        plan_id: PLAN_ID,
        source_branch: SOURCE_BRANCH,
        target_branch: "main",
        ...(input.status === undefined ? {} : { status: input.status }),
      }),
    );
  });
}

/** The stored execution lease record of the fixture's plan, parsed. */
function storedLease(context: StoreContext): Record<string, unknown> {
  const [row] = rows(
    context,
    `select lease_json from execution_leases where workflow_id = '${WORKFLOW_ID}' and plan_id = '${PLAN_ID}'`,
  );
  if (row === undefined) throw new Error(`fixture: no execution lease row for ${PLAN_ID}`);
  return parsedJson(row!.lease_json);
}

/** The stored integration merge claim of the fixture's workflow, parsed. */
function storedMergeClaim(context: StoreContext): Record<string, unknown> {
  const [row] = rows(
    context,
    `select lease_json from execution_integration_leases where workflow_id = '${WORKFLOW_ID}'`,
  );
  if (row === undefined) throw new Error("fixture: no integration merge lease row");
  return parsedJson(row!.lease_json);
}

/** The terminal outcome and routing one closed lifecycle left behind. */
function closedRow(context: StoreContext): Record<string, unknown> {
  const [row] = rows(
    context,
    `select (select count(*) from execution_registry where workflow_id = '${WORKFLOW_ID}') as registered, ` +
      `(select json_extract(state_json, '$.status') from execution_workflows where workflow_id = '${WORKFLOW_ID}') as status, ` +
      `(select json_extract(state_json, '$.ended_at') from execution_workflows where workflow_id = '${WORKFLOW_ID}') as ended_at, ` +
      `(select json_extract(state_json, '$.delivery') from execution_workflows where workflow_id = '${WORKFLOW_ID}') as delivery, ` +
      `(select json_extract(state_json, '$.status') from execution_plans where workflow_id = '${WORKFLOW_ID}' and plan_id = '${PLAN_ID}') as row_status`,
  );
  return row!;
}

describe("execution-workflow: §R11/A21/A28 the failed/stopped lifecycle and its own stopped claims", () => {
  test("failed lifecycle: an explicit failed close settles its own stopped claims with no delivery evidence (R11/A21)", async () => {
    const fixture = await workflowFixture("failed-lifecycle");
    plantPlanPmSession(fixture.context, { epoch: fixture.epoch, state: "suspended" });
    plantLease(fixture.context, { ownerEpoch: fixture.epoch, holderId: PLAN_PM_ID, holderRole: "plan-pm" });
    plantMergeClaim(fixture.context, { ownerEpoch: fixture.epoch, holder: PLAN_PM_ID });
    const before = revisions(fixture.context);
    // The workflow this close addresses is UNREADABLE through the whole-view
    // reader — a held lease whose holder session stopped is exactly the state
    // `assertLeaseOwnership` refuses — so the caller's CAS is the stored row's
    // token, the last read it could take before the owner died.
    const expected = workflowTokenOfRow(fixture.context);

    const receipt = await workflowMutation(
      fixture,
      "op-failed-lifecycle",
      { kind: "lifecycle", status: "failed", reason: "operator abandoned the wave" },
      { expected },
    );

    // §R11 no successful-delivery precondition: the row is still Todo, no
    // delivery evidence was ever recorded, and the lifecycle still ends.
    const closed = closedRow(fixture.context);
    expect(receipt.data.workflows.some((workflow) => workflow.state.id === WORKFLOW_ID)).toBe(false);
    expect(closed.registered).toBe(0);
    expect(closed.status).toBe("failed");
    expect(closed.row_status).toBe("Todo");
    expect(closed.delivery).toBeNull();
    expect(typeof closed.ended_at).toBe("string");

    // §R11/A21 the cleanup settles EXACTLY the claims this lifecycle owns whose
    // holder stopped: both become retained tombstones that record the stopped
    // owner, so "who owned this claim and who ended it" survives the close.
    expect(storedLease(fixture.context)).toMatchObject({
      holder_session_id: PLAN_PM_ID,
      status: "released",
      released_by: COORDINATOR_ID,
      release_reason: `stopped-owner:${PLAN_PM_ID}`,
    });
    expect(storedMergeClaim(fixture.context)).toMatchObject({
      holder: PLAN_PM_ID,
      status: "released",
      released_by: COORDINATOR_ID,
      release_reason: `stopped-owner:${PLAN_PM_ID}`,
    });
    // One accepted operation: the workflow and the store each advance once, and
    // the membership loss advances the root once.
    expect(revisions(fixture.context)).toEqual({ root: before.root + 1, store: before.store + 1, workflow: before.workflow + 1 });
  });

  test("stopped lifecycle: an explicit stopped close settles its own stopped claim and keeps a released one (R11/A21)", async () => {
    const fixture = await workflowFixture("stopped-lifecycle");
    plantPlanPmSession(fixture.context, { epoch: fixture.epoch, state: "suspended" });
    // An OWN claim that a prior step already released: settled, and never
    // rewritten by this close.
    plantLease(fixture.context, {
      ownerEpoch: fixture.epoch,
      holderId: COORDINATOR_ID,
      holderRole: "coordinator",
      status: "released",
    });
    const tombstone = storedLease(fixture.context);
    plantMergeClaim(fixture.context, { ownerEpoch: fixture.epoch, holder: PLAN_PM_ID });

    const receipt = await workflowMutation(fixture, "op-stopped-lifecycle", {
      kind: "lifecycle",
      status: "stopped",
      reason: "operator cancelled the wave",
    });

    const closed = closedRow(fixture.context);
    expect(receipt.data.workflows.some((workflow) => workflow.state.id === WORKFLOW_ID)).toBe(false);
    expect(closed.registered).toBe(0);
    expect(closed.status).toBe("stopped");
    expect(typeof closed.ended_at).toBe("string");
    // The already released claim is exactly the tombstone it was: the close
    // settles only what a stopped holder left held.
    expect(storedLease(fixture.context)).toEqual(tombstone);
    expect(storedMergeClaim(fixture.context)).toMatchObject({
      status: "released",
      released_by: COORDINATOR_ID,
      release_reason: `stopped-owner:${PLAN_PM_ID}`,
    });
    expect(rows(fixture.context, `select 1 from execution_leases where workflow_id = '${WORKFLOW_ID}'`)).toHaveLength(1);
  });

  test("foreign claim: a live holder's claim is never released and refuses the close (R11/A21)", async () => {
    const fixture = await workflowFixture("foreign-claim");
    plantPlanPmSession(fixture.context, { epoch: fixture.epoch, state: "active" });
    plantLease(fixture.context, { ownerEpoch: fixture.epoch, holderId: PLAN_PM_ID, holderRole: "plan-pm" });
    const before = await workflowFootprint(fixture.context);

    // §R11 a genuinely LIVE holder is never inferred stopped: the terminal close
    // withholds the outcome and names the holder whose own stop or transfer the
    // claim needs.
    const held = await refusalOf(() =>
      workflowMutation(fixture, "op-foreign-claim", { kind: "lifecycle", status: "failed", reason: "abandon the wave" }),
    );
    expect(held.code).toBe("coordination.invalid-transition");
    expect(held.message).toContain(PLAN_PM_ID);
    expect(held.message).toContain("stop or transfer");
    // No foreign release: the claim stays held and the refused close spent no
    // revision, row or receipt.
    expect(storedLease(fixture.context)).toMatchObject({ status: "held", holder_session_id: PLAN_PM_ID });
    expect(await workflowFootprint(fixture.context)).toEqual(before);

    // The same rule covers a LIVE integration claim: `execution_integration_leases`
    // is not readable through the narrow held-lease reader, so this is the half the
    // terminal decision settles beside the claim it already judges.
    const merge = await workflowFixture("foreign-merge-claim");
    plantPlanPmSession(merge.context, { epoch: merge.epoch, state: "active" });
    plantMergeClaim(merge.context, { ownerEpoch: merge.epoch, holder: PLAN_PM_ID });
    const mergeBefore = await workflowFootprint(merge.context);
    const mergeHeld = await refusalOf(() =>
      workflowMutation(merge, "op-foreign-merge", { kind: "lifecycle", status: "stopped", reason: "cancelled" }),
    );
    expect(mergeHeld.code).toBe("coordination.invalid-transition");
    expect(mergeHeld.message).toContain(PLAN_PM_ID);
    // A held claim carries no release record at all: it is exactly where the live
    // holder left it.
    expect(storedMergeClaim(merge.context)).toMatchObject({ holder: PLAN_PM_ID });
    expect(storedMergeClaim(merge.context).released_by).toBeUndefined();
    expect(await workflowFootprint(merge.context)).toEqual(mergeBefore);

    // Only THIS lifecycle's own live coordinator settles anything: a foreign
    // coordinator's failed close is refused before the cleanup runs, so a stopped
    // claim is left exactly where it was by an unauthorized address.
    const unauthorized = await workflowFixture("foreign-authority");
    plantPlanPmSession(unauthorized.context, { epoch: unauthorized.epoch, state: "suspended" });
    plantLease(unauthorized.context, { ownerEpoch: unauthorized.epoch, holderId: PLAN_PM_ID, holderRole: "plan-pm" });
    const unauthorizedBefore = await workflowFootprint(unauthorized.context);
    const foreignCaller: ExecutionCaller = { sessionId: "host-other", role: "coordinator", workflowId: "wf-other", planId: null };
    const refused = await refusalOf(() =>
      workflowMutation(
        unauthorized,
        "op-foreign-authority",
        { kind: "lifecycle", status: "failed", reason: "not mine to end" },
        {
          // The whole-view read refuses this fixture's stopped-holder lease, so the
          // CAS is the stored row's token: the refusal below is the ADDRESS's, not
          // a read failure.
          expected: workflowTokenOfRow(unauthorized.context),
          who: foreignCaller,
          session: {
            ...unauthorized.coordinator,
            sessionId: "host-other",
            workflowId: "wf-other",
          },
        },
      ),
    );
    expect(refused.code).toBe("execution.scope-mismatch");
    expect(storedLease(unauthorized.context)).toMatchObject({ status: "held", holder_session_id: PLAN_PM_ID });
    expect(await workflowFootprint(unauthorized.context)).toEqual(unauthorizedBefore);
  });

  test("colliding identity: a stopped plan-pm holder sharing the live coordinator's session id settles, and a live one still blocks (R11/A21)", async () => {
    const fixture = await workflowFixture("colliding-identity");
    // §2.2 `execution_sessions` is keyed by (workflow, role, session_id), so the
    // workflow's own ACTIVE coordinator and a STOPPED plan-pm holder may carry
    // the same session id. A crash state is planted (no W-phase verb produces a
    // lease held by a session that is not its own).
    plantPlanPmSession(fixture.context, { epoch: fixture.epoch, state: "suspended", sessionId: COORDINATOR_ID });
    plantLease(fixture.context, { ownerEpoch: fixture.epoch, holderId: COORDINATOR_ID, holderRole: "plan-pm" });
    // The pair is unreadable through the whole-view reader (a held lease whose
    // plan-pm holder row stopped) — the state this close's own cleanup exists to
    // settle — so the CAS is the stored row's token.
    expect((await refusalOf(() => readExecutionState(fixture.context))).code).toBe("store.corrupt");
    const expected = workflowTokenOfRow(fixture.context);

    const receipt = await workflowMutation(
      fixture,
      "op-colliding-identity",
      { kind: "lifecycle", status: "failed", reason: "the holder of record stopped" },
      { expected },
    );

    // Liveness is the lease's OWN ownership identity — role, session id, and the
    // plan a plan-pm holds — not its session id: the ACTIVE coordinator row that
    // happens to carry that id is a different owner, so the stopped plan-pm's
    // claim is settled as stopped-owned instead of being left held, which would
    // make the close's whole-view read refuse and wedge the terminal outcome.
    const closed = closedRow(fixture.context);
    expect(receipt.data.workflows.some((workflow) => workflow.state.id === WORKFLOW_ID)).toBe(false);
    expect(closed.registered).toBe(0);
    expect(closed.status).toBe("failed");
    expect(typeof closed.ended_at).toBe("string");
    expect(storedLease(fixture.context)).toMatchObject({
      holder_session_id: COORDINATOR_ID,
      holder_role: "plan-pm",
      status: "released",
      released_by: COORDINATOR_ID,
      release_reason: `stopped-owner:${COORDINATOR_ID}`,
    });

    // The identity rule is not "release whatever shares a session id": the SAME
    // collision whose plan-pm holder row IS active at this epoch is a genuine
    // owner, so its claim stays held and the close refuses on it.
    const live = await workflowFixture("colliding-identity-live");
    plantPlanPmSession(live.context, { epoch: live.epoch, state: "active", sessionId: COORDINATOR_ID });
    plantLease(live.context, { ownerEpoch: live.epoch, holderId: COORDINATOR_ID, holderRole: "plan-pm" });
    const before = await workflowFootprint(live.context);
    const held = await refusalOf(() =>
      workflowMutation(live, "op-colliding-identity-live", {
        kind: "lifecycle",
        status: "failed",
        reason: "abandon the wave",
      }),
    );
    expect(held.code).toBe("coordination.invalid-transition");
    expect(held.message).toContain(COORDINATOR_ID);
    expect(held.message).toContain("stop or transfer");
    expect(storedLease(live.context)).toMatchObject({ status: "held", holder_role: "plan-pm" });
    expect(await workflowFootprint(live.context)).toEqual(before);
  });

  test("repeated terminal: the identical retry replays the recorded outcome and settles nothing twice (A28)", async () => {
    const fixture = await workflowFixture("repeated-terminal");
    plantPlanPmSession(fixture.context, { epoch: fixture.epoch, state: "suspended" });
    plantLease(fixture.context, { ownerEpoch: fixture.epoch, holderId: PLAN_PM_ID, holderRole: "plan-pm" });
    // The whole-view read refuses this state (a held lease whose holder stopped),
    // so the CAS is the stored row's token — and BOTH calls below present the same
    // request, which is what makes the second one a replay rather than a new intent.
    const expected = workflowTokenOfRow(fixture.context);
    const close: WorkflowExecutionOperation = { kind: "lifecycle", status: "failed", reason: "operator abandoned the wave" };

    const receipt = await workflowMutation(fixture, "op-repeated-terminal", close, { expected });
    expect(receipt.replayed).toBe(false);
    const after = revisions(fixture.context);
    const settled = storedLease(fixture.context);
    const recorded = closedRow(fixture.context);

    // §R6/A28 the crash at the terminal boundary: the retry of the SAME intent is
    // answered from the recorded receipt, no claim is settled a second time, no
    // revision moves, and the recorded outcome keeps its own ended_at.
    const replay = await workflowMutation(fixture, "op-repeated-terminal", close, { expected });
    expect(replay.replayed).toBe(true);
    expect(replay.recovery?.outcome).toBe("already-satisfied");
    expect(revisions(fixture.context)).toEqual(after);
    expect(storedLease(fixture.context)).toEqual(settled);
    expect(closedRow(fixture.context)).toEqual(recorded);
  });

  test("repeated terminal: a residue settles its leftover claims and never rewrites a recorded outcome (A28)", async () => {
    const endedAt = "2026-01-05T06:07:08.000Z";
    const fixture = await workflowFixture("terminal-residue");
    plantPlanPmSession(fixture.context, { epoch: fixture.epoch, state: "suspended" });
    plantLease(fixture.context, { ownerEpoch: fixture.epoch, holderId: PLAN_PM_ID, holderRole: "plan-pm" });
    plantMergeClaim(fixture.context, { ownerEpoch: fixture.epoch, holder: PLAN_PM_ID });
    // The residue a crash at the terminal boundary leaves: the outcome and its
    // ended_at are already recorded, the ACTIVE routing row remains, and the
    // workflow's own stopped claims were never settled.
    withRaw(fixture.context, (db) => {
      db.prepare("update execution_workflows set state_json = json_set(state_json, '$.status', 'failed', '$.ended_at', ?) where workflow_id = ?").run(
        endedAt,
        WORKFLOW_ID,
      );
    });
    // The whole-view read refuses this state (a held lease whose holder stopped),
    // so the caller's CAS is the stored row's token.
    const expected = workflowTokenOfRow(fixture.context);

    const repaired = await workflowMutation(
      fixture,
      "op-terminal-residue",
      { kind: "lifecycle", status: "failed", reason: "residue repaired" },
      { expected },
    );

    // §R10/A20 the restatement of the RECORDED status is the residue's own
    // repair: the outcome and its time stay exactly as they were recorded, the
    // routing row goes, and the claims the crashed close never settled are
    // settled by this repair.
    const closed = closedRow(fixture.context);
    expect(repaired.data.workflows.some((workflow) => workflow.state.id === WORKFLOW_ID)).toBe(false);
    expect(closed.registered).toBe(0);
    expect(closed.status).toBe("failed");
    expect(closed.ended_at).toBe(endedAt);
    expect(storedLease(fixture.context)).toMatchObject({
      status: "released",
      released_by: COORDINATOR_ID,
      release_reason: `stopped-owner:${PLAN_PM_ID}`,
    });
    expect(storedMergeClaim(fixture.context)).toMatchObject({
      status: "released",
      release_reason: `stopped-owner:${PLAN_PM_ID}`,
    });

    // §R10/E11 a RECORDED outcome is never rewritten: asking the same residue to
    // become an outcome it did not record refuses and changes no byte at all.
    const completed = await workflowFixture("terminal-completed");
    withRaw(completed.context, (db) => {
      db.prepare("update execution_workflows set state_json = json_set(state_json, '$.status', 'completed', '$.ended_at', ?) where workflow_id = ?").run(
        endedAt,
        WORKFLOW_ID,
      );
    });
    const before = await workflowFootprint(completed.context);
    const refused = await refusalOf(() =>
      workflowMutation(completed, "op-terminal-rewrite", {
        kind: "lifecycle",
        status: "failed",
        reason: "claim the wave failed",
      }),
    );
    expect(refused.code).toBe("coordination.invalid-transition");
    expect(refused.message).toContain("never amended");
    expect(await workflowFootprint(completed.context)).toEqual(before);
  });
});
/* ------------------------------------------------------------------------ *
 * § One resolver path (S2/E02): the SPARSE intent of the published DB verbs
 * ------------------------------------------------------------------------ */

/**
 * A DB fixture with ONE prepared plan and its bound plan-pm seat — the state a
 * plan-owned write needs. The reviewed Assignment is a real document the DB
 * `prepare` transition seals, and the plan's own session binds through the real
 * verb (so the lease the row admission requires is one the store recorded
 * rather than one a fixture planted).
 */
async function preparedPlanFixture(label: string): Promise<{
  context: StoreContext;
  harnessRoot: string;
  coordinatorCaller: ExecutionCaller;
  coordinator: ExecutionSessionRef;
  planCaller: ExecutionCaller;
  planSession: ExecutionSessionRef;
}> {
  const fixture = await workflowFixture(label);
  // The directory that owns `store.db` IS the control harness the sealed
  // Assignment must name (the engine reads it back from the store's own path).
  const harnessRoot = realpathSync(dirname(storeDbPath(fixture.context)));
  const planDir = join(harnessRoot, "plans");
  const sddDir = join(harnessRoot, "sdd", PLAN_ID);
  const planWorktree = join(harnessRoot, "worktrees", PLAN_ID);
  mkdirSync(planDir, { recursive: true });
  mkdirSync(sddDir, { recursive: true });
  const planPath = join(planDir, `${PLAN_ID}.md`);
  writeText(planPath, `# ${PLAN_ID}\n`);
  const assignmentPath = join(harnessRoot, "assignments", `${PLAN_ID}.md`);
  mkdirSync(dirname(assignmentPath), { recursive: true });
  writeText(
    assignmentPath,
    [
      "**Execution scope**: plan",
      "**Execute as**: project-manager",
      "**Delegation**: allowed",
      `**Control harness root**: ${harnessRoot}`,
      `**Workflow id**: ${WORKFLOW_ID}`,
      `**Plan id**: ${PLAN_ID}`,
      `**Plan Path**: ${planPath}`,
      `**Worktree path**: ${planWorktree}`,
      `**Working branch**: ${SOURCE_BRANCH}`,
      `**SDD dir**: ${sddDir}`,
      "**QA gate**: mandatory",
      "**Findings cleanup**: zero-residual",
      "**Prepare gate**: go",
      "",
    ].join("\n"),
  );

  const coordinatorContext = domainContext(fixture.context, fixture.coordinatorCaller);
  await mutateExecutionPlan(coordinatorContext, {
    operationId: `prepare-${label}`,
    session: fixture.coordinator,
    expected: (await readExecutionPlan(coordinatorContext, fixture.coordinator, PLAN_ID)).token,
    planId: PLAN_ID,
    operation: { kind: "prepare", assignmentPath },
  });
  const planCaller = trustedCaller(PLAN_PM_ID, "plan-pm", PLAN_ID);
  const bound = await bindExecutionSession(domainContext(fixture.context, planCaller), {
    workflowId: WORKFLOW_ID,
    planId: PLAN_ID,
    role: "plan-pm",
    expected: (await readExecutionPlan(coordinatorContext, fixture.coordinator, PLAN_ID)).token,
    operationId: `bind-plan-${label}`,
  });
  return {
    context: fixture.context,
    harnessRoot,
    coordinatorCaller: fixture.coordinatorCaller,
    coordinator: fixture.coordinator,
    planCaller,
    planSession: bound.data,
  };
}

/** One plan-progress operation, identical for the strict and the sparse call. */
const SPARSE_PROGRESS: { kind: "progress"; progress: PlanProgress } = {
  kind: "progress",
  progress: { status: "InProgress", summary: "sparse intent", evidence_paths: [] },
};

describe("execution-intent-sparse: § One resolver path (S2/E02)", () => {
  test("a sparse workflow intent omitting the session, the token and the workflow id reaches the same result (A02)", async () => {
    // Only the intent's own operation is stated. The engine resolves the
    // CURRENT authority route, the trusted coordinator's OWN live binding and
    // the workflow token of the record that read returned — and the receipt's
    // semantic fingerprint is built from the intent alone, so the same sparse
    // call replays its own receipt instead of writing twice.
    const specified = await workflowFixture("sparse-workflow-specified");
    const specifiedReceipt = await workflowMutation(specified, "op-sparse-specified", {
      kind: "phase",
      phase: "phase-2-execute",
      compassPath: specified.compassPath,
    });

    const sparse = await workflowFixture("sparse-workflow-resolved");
    const sparseCall = (operationId: string) =>
      mutateExecutionWorkflow(domainContext(sparse.context, sparse.coordinatorCaller), {
        operationId,
        operation: { kind: "phase", phase: "phase-2-execute", compassPath: sparse.compassPath },
      });

    const sparseReceipt = await sparseCall("op-sparse-resolved");

    expect(sparseReceipt.replayed).toBe(false);
    expect(sparseReceipt.data.workflows[0]!.state.phase).toBe(specifiedReceipt.data.workflows[0]!.state.phase);
    expect(sparseReceipt.recovery?.outcome).toBe(specifiedReceipt.recovery?.outcome);
    expect(sparseReceipt.recovery?.warnings).toEqual([]);
    expect(sparseReceipt.data.workflows[0]!.workflowToken).toBe(await liveWorkflowToken(sparse));

    const repeated = await sparseCall("op-sparse-resolved");
    expect(repeated.replayed).toBe(true);
    expect(repeated.data.workflows[0]!.state.phase).toBe("phase-2-execute");
  });

  test("a sparse plan intent omitting the session, the token and the plan id reaches the same result (A02)", async () => {
    const specified = await preparedPlanFixture("sparse-plan-specified");
    const specifiedReceipt = await mutateExecutionPlan(domainContext(specified.context, specified.planCaller), {
      operationId: "op-plan-specified",
      session: specified.planSession,
      expected: (await readExecutionPlan(domainContext(specified.context, specified.planCaller), specified.planSession, PLAN_ID)).token,
      planId: PLAN_ID,
      operation: SPARSE_PROGRESS,
    });

    const sparse = await preparedPlanFixture("sparse-plan-resolved");
    // The plan id, the session reference and the plan token are all omitted: the
    // plan-pm identity names the plan, so the engine reads its own binding and
    // the plan's own token.
    const sparseReceipt = await mutateExecutionPlan(domainContext(sparse.context, sparse.planCaller), {
      operationId: "op-plan-sparse",
      operation: SPARSE_PROGRESS,
    });

    expect(sparseReceipt.replayed).toBe(false);
    expect(sparseReceipt.data.plan.status).toBe(specifiedReceipt.data.plan.status);
    expect(sparseReceipt.data.coordination?.progress?.summary).toBe(specifiedReceipt.data.coordination?.progress?.summary);
    expect(sparseReceipt.recovery?.outcome).toBe(specifiedReceipt.recovery?.outcome);
    expect(sparseReceipt.recovery?.warnings).toEqual([]);
    const stored = await readExecutionPlan(domainContext(sparse.context, sparse.planCaller), sparse.planSession, PLAN_ID);
    expect((stored.data.plan as { status?: unknown }).status).toBe("InProgress");
  });

  test("a sparse plan-authority call resolves the caller's own binding and the plan's own token (A02)", async () => {
    const fixture = await preparedPlanFixture("sparse-authority");
    const strict = await readExecutionPlan(domainContext(fixture.context, fixture.planCaller), fixture.planSession, PLAN_ID);
    const before = await workflowFootprint(fixture.context);
    const strictWitness = await withExecutionPlanAuthority(
      domainContext(fixture.context, fixture.planCaller),
      {
        session: fixture.planSession,
        expected: (await readExecutionPlan(domainContext(fixture.context, fixture.planCaller), fixture.planSession, PLAN_ID)).token,
        planId: PLAN_ID,
        operation: SPARSE_PROGRESS,
      },
      (witness) => witness,
    );
    const sparseWitness: ExecutionPlanWitness = await withExecutionPlanAuthority(
      domainContext(fixture.context, fixture.planCaller),
      { operation: SPARSE_PROGRESS },
      (witness) => witness,
    );

    expect(sparseWitness.workflowId).toBe(strictWitness.workflowId);
    expect(sparseWitness.planId).toBe(PLAN_ID);
    expect(sparseWitness.token).toBe(strictWitness.token);
    expect(sparseWitness.token).toBe(strict.token);
    expect(sparseWitness.session).toEqual(strictWitness.session);
    expect(sparseWitness.session.sessionId).toBe(PLAN_PM_ID);
    // Both calls are read-only transitions: resolving the sparse intent wrote
    // nothing — the row, its revisions and the session rows are untouched.
    expect(await workflowFootprint(fixture.context)).toEqual(before);
    expect((await readExecutionPlan(domainContext(fixture.context, fixture.planCaller), fixture.planSession, PLAN_ID)).token).toBe(strict.token);
  });

  test("a sparse workflow intent on a root whose authority is not the ACTIVE store refuses without falling back", async () => {
    // § One resolver path: the CURRENT route decides, and a control root whose
    // authority is not the ACTIVE execution store answers on the files route —
    // so a sparse DB intent refuses `execution.not-active` rather than falling
    // back to the file route or inventing a binding to derive from.
    const workspace = realpathSync(mkdtempSync(join(ROOT, "sparse-no-authority-")));
    mkdirSync(join(workspace, ".mstar"), { recursive: true });
    const context: StoreContext = { harnessDir: workspace };
    const refusal = await refusalOf(() =>
      mutateExecutionWorkflow(domainContext(context, trustedCaller(COORDINATOR_ID, "coordinator", null)), {
        operationId: "op-sparse-uninitialized",
        operation: { kind: "phase", phase: "phase-2-execute", compassPath: join(workspace, ".mstar", COMPASS_REF) },
      }),
    );
    expect(refusal.code).toBe("execution.not-active");
  });
});
