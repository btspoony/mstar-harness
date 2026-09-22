/**
 * Phase-2 launch admission journal — scoped checks for
 * `packages/omp/src/phase2-launches.ts` (plan the registered Phase-2 instances plan
 * T2; primary spec §C capacity/reservation and §D transport boundary).
 *
 * Fixture discipline: every coordination fact these cases assert on is created
 * through the REAL engine verbs on the DB authority — `createExecutionWorkflow`,
 * `bindExecutionSession` (coordinator and plan) and `mutateExecutionPlan`
 * (`prepare` / `progress` / `handoff` / `return`) in a real Git repository with
 * real linked worktrees — never by writing an accepted lease, binding or handoff
 * into a snapshot by hand. The journal, by contrast, is this module's own
 * transport document, so the case that needs a stale or recovered intent writes
 * that file directly: it is not engine state, and an intent the engine cannot
 * re-derive is exactly the state a replay has to survive.
 *
 * The harness is provisioned with a REAL issue store (`initializeStore`): since
 * the issue-governance cutover (G2a) the handoff gate reads the plan's open
 * findings from `{HARNESS_DIR}/store.db`, and it fails closed when that
 * authority is missing or staged — it has no pre-activation branch (engine
 * `issue-cutover.test.ts` pins the refusal, issue contract §7 governs register
 * CAPTURES, not a plan handoff). These cases assert on launch admission and
 * occupancy against a genuinely handing-off plan, so the fixture supplies the
 * same active store the store-cutover suites build — no open issue is linked to
 * these plans, so the `allow-residual` gate is clean.
 *
 * Launch transport is never executed here and no case claims it was: these cases
 * prove admission, occupancy and transition bookkeeping against real files. The
 * bounded before/after action traces of the optional Herdr/tmux skill are the
 * transport task's evidence (plan T4); a pane id in this file is an opaque
 * string the PM would have received, nothing more.
 *
 * Native settings are seeded through the host's own project override surface
 * (`<cwd>/.omp/plugin-overrides.json`), which `readPhase2Settings` reads through
 * the real `getPluginSettings` helper — no user settings are read or written,
 * and the managed-environment variables are set for the duration of one case.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  createFsStore,
  initializeExecutionAuthority,
  initializeStore,
  mutateExecutionPlan,
  readExecutionAuthority,
  registerCatalogEntity,
  setArtifactStore,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionPlanView,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionState,
  type ExecutionToken,
} from "@mstar-harness/engine";
import { recordPlanLaunch, reservePlanLaunch, type ExecutionLaunchAuthority, type LaunchIntent, type PlanLaunchResult } from "../src/phase2-launches";
import type { Phase2Request } from "../src/phase2-orchestration";

const WORKFLOW_ID = "wf-instances";
const PROJECT_ID = "proj-instances";
const PLAN_IDS = ["plan-a", "plan-b", "plan-c", "plan-d"] as const;
const JOURNAL_FILE = "omp-launches.json";
/** The native session the DB coordinator binding belongs to (a host observes its own). */
const COORDINATOR_SESSION_ID = "fixture-coordinator";
/** Managed-environment variables this feature reads; restored after every case. */
const MANAGED_ENV_KEYS = ["HERDR_ENV", "TMUX"] as const;

type PlanId = (typeof PLAN_IDS)[number];
type RecordObservation = Extract<Phase2Request, { operation: "record-launch" }>["observation"];

type Fixture = {
  root: string;
  harness: string;
  workflowDir: string;
  snapshotPath: string;
  journalPath: string;
  integrationPath: string;
  /** The DB coordinator session this fixture's launch authority resumes. */
  coordinator: ExecutionSessionRef;
  baseSha: string;
  planPaths: Record<string, string>;
  assignments: Record<string, string>;
  sddDirs: Record<string, string>;
  worktrees: Record<string, string>;
};

/** A plan whose Assignment deliberately points at a checkout that is not its own. */
type FixtureOptions = { atMainCheckout?: PlanId; atIntegrationCheckout?: PlanId };

const roots: string[] = [];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // The Herdr prerequisite of every positive case; the gate cases override it.
  process.env.HERDR_ENV = "1";
});

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setArtifactStore(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function headOf(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The scoped Assignment header block `parseAssignmentFile` accepts. */
function assignmentText(input: { harness: string; planId: string; planPath: string; worktreePath: string; sddDir: string; branch: string }): string {
  return [
    `# Assignment — ${input.planId} independent slice`,
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
    "**Findings cleanup**: allow-residual",
    "",
    "Independent prepared plan for the extra-primary launch cases.",
    "",
  ].join("\n");
}

/**
 * A real repository with one workflow, four prepared independent plans (each on
 * its own linked worktree/branch), a bound coordinator session and a real
 * integration checkout. Everything the journal asserts against exists as engine
 * state produced by engine verbs.
 */
function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-omp-launches-")));
  roots.push(root);
  git(["init", "-q", "-b", "main"], root);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], root);

  const harness = join(root, ".mstar");
  const workflowDir = join(harness, "workflows", WORKFLOW_ID);
  const snapshotPath = join(workflowDir, "snapshot.json");
  const integrationPath = join(root, "wt-integration");
  git(["worktree", "add", "-q", "-b", "integration/wf", integrationPath], root);

  const planPaths: Record<string, string> = {};
  const assignments: Record<string, string> = {};
  const sddDirs: Record<string, string> = {};
  const worktrees: Record<string, string> = {};
  for (const planId of PLAN_IDS) {
    const planPath = join(harness, "plans", `${planId}.md`);
    const sddDir = join(harness, "sdd", planId);
    const branch = `feature/${planId}`;
    const misdirected = planId === options.atMainCheckout ? root : planId === options.atIntegrationCheckout ? integrationPath : null;
    const worktreePath = misdirected ?? join(root, `wt-${planId}`);
    writeText(planPath, `# Plan ${planId}\n`);
    mkdirSync(sddDir, { recursive: true });
    if (misdirected === null) {
      git(["worktree", "add", "-q", "-b", branch, worktreePath], root);
      // A real slice commit, so the plan worktree is a genuine reviewed checkout.
      writeText(join(worktreePath, "slice.txt"), `${planId} slice\n`);
      git(["add", "-A"], worktreePath);
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${planId} slice`], worktreePath);
    }
    planPaths[planId] = planPath;
    worktrees[planId] = worktreePath;
    sddDirs[planId] = sddDir;
    assignments[planId] = join(sddDir, "assignment.md");
    writeText(assignments[planId]!, assignmentText({ harness, planId, planPath, worktreePath, sddDir, branch }));
  }

  setArtifactStore(createFsStore(harness));

  return {
    root,
    harness,
    workflowDir,
    snapshotPath,
    journalPath: join(workflowDir, JOURNAL_FILE),
    integrationPath,
    coordinator: null as unknown as ExecutionSessionRef,
    baseSha: headOf(root),
    planPaths,
    assignments,
    sddDirs,
    worktrees,
  };
}

/** Provision the harness's issue authority — the store the handoff gate reads
 * its findings from (real `node:sqlite` migrations, the same initializer the
 * store-cutover suites use; never a mocked reader). */
async function seedIssueStore(fixture: Fixture): Promise<void> {
  const handle = await initializeStore({ harnessDir: fixture.harness });
  handle.close();
}

/**
 * A canonical PLAIN copy of an engine-returned session reference. The engine's
 * canonical-value rule accepts only objects whose prototype is `Object.prototype`
 * or `null`, so a reference that travels back into a request has to be projected
 * field by field — never handed over as the engine's own object.
 */
function plainRef(ref: ExecutionSessionRef): ExecutionSessionRef {
  return {
    storeId: ref.storeId,
    epoch: ref.epoch,
    workflowId: ref.workflowId,
    role: ref.role,
    sessionId: ref.sessionId,
    planId: ref.planId,
  };
}

/** The trusted caller this fixture's DB verbs run as (the workflow's creator). */
function coordinatorContextOf(fixture: Fixture): ExecutionContext {
  return {
    harnessDir: fixture.harness,
    caller: { sessionId: COORDINATOR_SESSION_ID, role: "coordinator", workflowId: WORKFLOW_ID, planId: null } satisfies ExecutionCaller,
  };
}

/** The plan-pm caller of one plan's own session (its address is the plan). */
function planContextOf(fixture: Fixture, planId: PlanId, sessionId: string): ExecutionContext {
  return {
    harnessDir: fixture.harness,
    caller: { sessionId, role: "plan-pm", workflowId: WORKFLOW_ID, planId } satisfies ExecutionCaller,
  };
}

/**
 * REAL ACTIVE execution authority: the issue store upgraded to an execution
 * authority, the four plans registered in the catalog, one created workflow in
 * `phase-2-execute` holding them, every plan PREPARED from its real Assignment
 * file through the DB verb, and the coordinator bound under the native session
 * id this fixture's launch authority acquires. Nothing is planted as file
 * state: the DB authority is the only coordination source on this route.
 */
async function seedActiveAuthority(fixture: Fixture): Promise<void> {
  const initialized = await initializeExecutionAuthority({ harnessDir: fixture.harness });
  for (const planId of PLAN_IDS) {
    await registerCatalogEntity(
      { harnessDir: fixture.harness },
      { kind: "plan", id: planId, title: `Plan ${planId}`, rootKind: "plans", relativePath: `plans/${planId}.md` },
      { operationId: `register-${planId}`, actor: "phase2-launches.test" },
    );
  }
  const context = coordinatorContextOf(fixture);
  const created = await createExecutionWorkflow(context, {
    entry: { id: WORKFLOW_ID, type: "iteration", started_at: "2026-09-16T00:00:00Z", dir: `workflows/${WORKFLOW_ID}` },
    snapshot: {
      schema_version: 1,
      id: WORKFLOW_ID,
      type: "iteration",
      status: "running",
      phase: "phase-2-execute",
      started_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
      branch: { base: "main", integration: "integration/wf" },
      integration_worktree_path: fixture.integrationPath,
      plans: PLAN_IDS.map((planId) => ({
        id: planId,
        title: `Plan ${planId}`,
        file: `plans/${planId}.md`,
        status: "Todo",
        // The plan's own launch scope, as the engine's lease derivation expects
        // it (`planLeaseScope` requires exactly these two metadata fields).
        metadata: { project_id: PROJECT_ID, worktree_path: fixture.worktrees[planId]!, working_branch: `feature/${planId}` },
      })),
    } as never,
    // Creation is a ROOT-scoped CAS: the receipt's own token is a root token and
    // must never be handed to a workflow-scoped verb.
    expected: initialized.token,
    operationId: `create-${WORKFLOW_ID}`,
  });
  expect(created.data.workflows[0]?.state.id).toBe(WORKFLOW_ID);
  const bound = await bindExecutionSession(context, {
    workflowId: WORKFLOW_ID,
    planId: null,
    role: "coordinator",
    expected: await workflowTokenOf(fixture),
    operationId: `bind-${COORDINATOR_SESSION_ID}`,
  });
  fixture.coordinator = bound.data;
  // The journal (and the lock the launcher takes) lives in the canonical
  // workflow directory, so it must exist on disk — the authority never writes it.
  mkdirSync(fixture.workflowDir, { recursive: true });
  for (const planId of PLAN_IDS) {
    await mutateExecutionPlan(context, {
      operationId: `prepare-${planId}`,
      session: plainRef(fixture.coordinator),
      expected: await planTokenOf(fixture, planId),
      planId,
      operation: { kind: "prepare", assignmentPath: fixture.assignments[planId]! } as never,
    });
  }
}

/** Bind the lifecycle coordinator in the DB and prepare every plan. */
async function bindFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const fixture = makeFixture(options);
  await seedIssueStore(fixture);
  await seedActiveAuthority(fixture);
  return fixture;
}

/** The plan's own CAS token, read fresh from the authority at call time. */
async function planTokenOf(fixture: Fixture, planId: PlanId): Promise<ExecutionToken> {
  const read = await readExecutionAuthority({ harnessDir: fixture.harness }, { workflowId: WORKFLOW_ID, planId });
  return read.token;
}

/**
 * The workflow's own CAS token. A `{workflowId}` read returns the WORKFLOW token,
 * while `createExecutionWorkflow`'s receipt carries the ROOT token its creation
 * CAS used — the two are not interchangeable, and a workflow-scoped verb refuses
 * a root token (`execution.token-kind`) instead of coercing it.
 */
async function workflowTokenOf(fixture: Fixture): Promise<ExecutionToken> {
  const read = await readExecutionAuthority({ harnessDir: fixture.harness }, { workflowId: WORKFLOW_ID });
  return read.token;
}

/** One coordinator-scoped DB operation on a plan, with its own plan token read just before. */
async function coordinatorOp(fixture: Fixture, planId: PlanId, operation: Record<string, unknown>): Promise<ExecutionReceipt<ExecutionPlanView>> {
  return mutateExecutionPlan(coordinatorContextOf(fixture), {
    operationId: `coordinator-op-${planId}-${operation.kind}`,
    session: plainRef(fixture.coordinator),
    expected: await planTokenOf(fixture, planId),
    planId,
    operation: operation as never,
  });
}

/** Bind one plan's own session (claims the row's execution lease), returning the DB session reference. */
async function bindPlanSessionOf(fixture: Fixture, planId: PlanId): Promise<ExecutionSessionRef> {
  const sessionId = `plan-${planId}-${Math.random().toString(36).slice(2, 8)}`;
  const bound = await bindExecutionSession(planContextOf(fixture, planId, sessionId), {
    workflowId: WORKFLOW_ID,
    planId,
    role: "plan-pm",
    expected: await planTokenOf(fixture, planId),
    operationId: `bind-${sessionId}`,
  });
  return bound.data;
}

/** Seed the native preference through the host's project override surface. */
function writeSettings(fixture: Fixture, settings: { enabled: boolean; cap: number }): void {
  writeJson(join(fixture.root, ".omp", "plugin-overrides.json"), {
    settings: { "@mstar-harness/omp": { phase2PlanInstances: settings.enabled, maxPlanInstances: settings.cap } },
  });
}

/** A real read-only evidence file the PM records with a transition. */
function evidenceOf(fixture: Fixture, name: string): string {
  const path = join(fixture.root, "evidence", `${name}.txt`);
  writeText(path, `${name}\n`);
  return path;
}

function authorityOf(fixture: Fixture): ExecutionLaunchAuthority {
  return {
    cwd: fixture.root,
    identity: { source: "host", sessionId: fixture.coordinator.sessionId, workflowId: WORKFLOW_ID, role: "coordinator", planId: null },
    binding: { version: 1, harnessRoot: fixture.harness, session: plainRef(fixture.coordinator) },
  };
}

function reserveFor(fixture: Fixture, planId: string, overrides: Record<string, unknown> = {}): Promise<PlanLaunchResult> {
  const request = {
    operation: "reserve-launch",
    planId,
    transport: "herdr",
    skill: { name: "herdr", source: "herdr" },
    capability: { executable: process.execPath, version: "0.9.0", target: "pane-current" },
    ...overrides,
  } as Extract<Phase2Request, { operation: "reserve-launch" }>;
  return reservePlanLaunch(request, authorityOf(fixture));
}

function recordFor(
  fixture: Fixture,
  intentId: string,
  observation: RecordObservation,
  overrides: { target?: string; evidencePath?: string } = {},
): Promise<PlanLaunchResult> {
  return recordPlanLaunch(
    {
      operation: "record-launch",
      intentId,
      observation,
      ...(overrides.target !== undefined ? { target: overrides.target } : {}),
      evidencePath: overrides.evidencePath ?? evidenceOf(fixture, `${intentId}-${observation}`),
    },
    authorityOf(fixture),
  );
}

/** A refusal is the observable guarantee that nothing was authorized. */
function refusalOf(outcome: PlanLaunchResult): { code: string; message: string } {
  if (outcome.ok) throw new Error("expected the launch call to refuse, but it succeeded");
  return outcome;
}

/** The plan row's current prepared Assignment pin (what a launch must match). */
async function preparedHashOf(fixture: Fixture, planId: string): Promise<string> {
  const coordination = (await planRowOf(fixture, planId as PlanId)).coordination as Record<string, unknown> | undefined;
  const prepared = coordination?.prepared as Record<string, unknown> | undefined;
  if (typeof prepared?.assignment_sha256 !== "string") throw new Error(`plan ${planId} has no prepared pin`);
  return prepared.assignment_sha256;
}

/**
 * Recovered journal entries this plugin cannot re-derive from the engine: the
 * journal is this module's own transport document, so a stale or foreign
 * record is exactly the state a replay has to survive.
 */
function appendJournalIntents(fixture: Fixture, entries: Array<Record<string, unknown>>): void {
  const doc = readJson(fixture.journalPath);
  writeJson(fixture.journalPath, { ...doc, intents: [...(doc.intents as unknown[]), ...entries] });
}

/** Reserve, record the transport transitions, then let the child bind and stop. */
async function driveChildToScopedStop(fixture: Fixture, planId: PlanId, intentId: string): Promise<string> {
  await submitLaunch(fixture, intentId, `pane-${planId}`);
  return handOffPlan(fixture, planId);
}

function intentOf(outcome: PlanLaunchResult): LaunchIntent {
  if (!outcome.ok) throw new Error(`expected the launch call to succeed: ${outcome.code}: ${outcome.message}`);
  return outcome.intent;
}

function appliedOf(outcome: PlanLaunchResult): boolean {
  if (!outcome.ok) throw new Error(`expected the launch call to succeed: ${outcome.code}: ${outcome.message}`);
  return outcome.applied;
}

/** The full recorded lifecycle, as the PM would drive it around real CLI calls. */
async function submitLaunch(fixture: Fixture, intentId: string, target: string): Promise<LaunchIntent> {
  intentOf(await recordFor(fixture, intentId, "starting"));
  intentOf(await recordFor(fixture, intentId, "created", { target }));
  intentOf(await recordFor(fixture, intentId, "submitting", { target }));
  return intentOf(await recordFor(fixture, intentId, "submitted", { target }));
}

function journalIntents(fixture: Fixture): Array<Record<string, unknown>> {
  if (!existsSync(fixture.journalPath)) return [];
  return readJson(fixture.journalPath).intents as Array<Record<string, unknown>>;
}

/** The plan's authoritative view, read fresh from the DB (the snapshot is retired). */
async function planViewOf(fixture: Fixture, planId: string): Promise<ExecutionPlanView> {
  const read = await readExecutionAuthority({ harnessDir: fixture.harness }, { workflowId: WORKFLOW_ID, planId });
  if (!("workflows" in read.data)) throw new Error(`the authority read of ${planId} returned the whole state`);
  const view = read.data.workflows[0]?.plans.find((entry) => entry.plan.id === planId);
  if (view === undefined) throw new Error(`the authority holds no plan row ${planId}`);
  return view;
}

/** The same facts the legacy snapshot row carried, projected from the DB view. */
async function planRowOf(fixture: Fixture, planId: PlanId): Promise<Record<string, unknown>> {
  const view = await planViewOf(fixture, planId);
  return {
    ...(view.plan as Record<string, unknown>),
    coordination: view.coordination ?? undefined,
    session: view.session === null ? undefined : { session_id: view.session.sessionId },
    execution_lease: view.executionLease === null ? undefined : view.executionLease,
  };
}

async function handoffIdOf(fixture: Fixture, planId: PlanId): Promise<string> {
  const coordination = (await planRowOf(fixture, planId)).coordination as Record<string, unknown> | undefined;
  const handoff = coordination?.handoff as Record<string, unknown> | undefined;
  if (typeof handoff?.id !== "string") throw new Error(`plan ${planId} has no handoff id`);
  return handoff.id;
}

/** The child's own path to its scoped stop: bind, report InReview, hand off. */
async function handOffPlan(fixture: Fixture, planId: PlanId): Promise<string> {
  const bound = await bindPlanSessionOf(fixture, planId);
  const session = plainRef(bound);
  const context = planContextOf(fixture, planId, session.sessionId);
  const progressed = await mutateExecutionPlan(context, {
    operationId: `progress-${planId}`,
    session,
    expected: await planTokenOf(fixture, planId),
    planId,
    operation: { kind: "progress", progress: { status: "InReview", summary: "slice implemented", evidence_paths: [] } } as never,
  });
  expect(progressed.data.coordination?.handoff).toBeUndefined();

  const reports = [join(fixture.sddDirs[planId]!, "review", "qc1.md"), join(fixture.sddDirs[planId]!, "review", "qc2.md")];
  for (const path of reports) writeText(path, "# qc report\n");
  const consolidated = join(fixture.sddDirs[planId]!, "review", "qc.md");
  const qa = join(fixture.sddDirs[planId]!, "qa.md");
  writeText(consolidated, "# consolidated qc\n");
  writeText(qa, "# qa pass\n");

  const sourceSha = headOf(fixture.worktrees[planId]!);
  const handed = await mutateExecutionPlan(context, {
    operationId: `handoff-${planId}`,
    session,
    expected: await planTokenOf(fixture, planId),
    planId,
    operation: {
      kind: "handoff",
      evidence: {
        source_sha: sourceSha,
        review_base: fixture.baseSha,
        review_head: sourceSha,
        qc: { decision: "Approve", reports, consolidated },
        qa: { gate: "mandatory", decision: "pass", report: qa },
      },
    } as never,
  });
  expect(handed.data.coordination?.handoff?.state).toBe("submitted");
  return handoffIdOf(fixture, planId);
}

describe("phase2 launch admission journal", () => {
  test("pending and bound owner count once", async () => {
    const fixture = await bindFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });

    const reserved = intentOf(await reserveFor(fixture, "plan-a"));
    expect(reserved.state).toBe("reserved");
    expect(reserved.workflowId).toBe(WORKFLOW_ID);
    expect(reserved.preparedHash).toBe(sha256OfFile(fixture.assignments["plan-a"]!));
    expect(reserved.assignmentPath).toBe(fixture.assignments["plan-a"]!);
    expect(reserved.worktreePath).toBe(fixture.worktrees["plan-a"]!);
    expect(reserved.evidencePaths).toEqual([]);
    expect(existsSync(fixture.journalPath)).toBe(true);

    // The PM records the transitions around its real CLI calls, then the child
    // binds its own plan through the engine.
    const submitted = await submitLaunch(fixture, reserved.id, "pane-plan-a");
    expect(submitted.state).toBe("submitted");
    expect(submitted.target).toBe("pane-plan-a");
    expect(submitted.evidencePaths.length).toBe(4);
    const childSession = await bindPlanSessionOf(fixture, "plan-a");

    // plan-a is now BOTH pending in the journal and active in the engine: it is
    // one occupied slot, so one of the two slots is still free.
    expect(intentOf(await reserveFor(fixture, "plan-b")).state).toBe("reserved");
    expect(refusalOf(await reserveFor(fixture, "plan-c")).code).toBe("launch.capacity-exceeded");

    const intents = journalIntents(fixture);
    expect(intents.map((entry) => entry.planId)).toEqual(["plan-a", "plan-b"]);
    expect(intents[0]!.state).toBe("submitted");
    const lease = (await planRowOf(fixture, "plan-a")).execution_lease as Record<string, unknown>;
    expect(lease.holder).toBe(childSession.sessionId);
  });

  test("last slot race has one winner", async () => {
    const fixture = await bindFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });
    intentOf(await reserveFor(fixture, "plan-a"));

    // Two coordinator calls race for the single remaining slot; the journal lock
    // serializes them, so exactly one reservation is authorized.
    const racers = await Promise.all([reserveFor(fixture, "plan-b"), reserveFor(fixture, "plan-c")]);
    const winners = racers.filter((outcome) => outcome.ok);
    expect(winners.length).toBe(1);
    expect(refusalOf(racers.find((outcome) => !outcome.ok)!).code).toBe("launch.capacity-exceeded");
    expect(journalIntents(fixture).map((entry) => entry.planId).sort()).toEqual(["plan-a", intentOf(winners[0]!).planId].sort());
  });

  test("reduced cap never kills", async () => {
    const fixture = await bindFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });

    const a = intentOf(await reserveFor(fixture, "plan-a"));
    const b = intentOf(await reserveFor(fixture, "plan-b"));
    const submittedA = await submitLaunch(fixture, a.id, "pane-plan-a");
    await bindPlanSessionOf(fixture, "plan-a");

    // The operator lowers the cap to 1: no new launch and no new side-effecting
    // transition may pass, and nothing that exists is touched.
    writeSettings(fixture, { enabled: true, cap: 1 });
    expect(refusalOf(await reserveFor(fixture, "plan-c")).code).toBe("launch.capacity-exceeded");
    expect(refusalOf(await recordFor(fixture, b.id, "starting")).code).toBe("launch.capacity-exceeded");

    const intents = journalIntents(fixture);
    expect(intents.map((entry) => entry.state)).toEqual(["submitted", "reserved"]);
    expect(intents[0]!.target).toBe("pane-plan-a");
    expect(intents[0]!.evidencePaths).toEqual([...submittedA.evidencePaths]);
    const lease = (await planRowOf(fixture, "plan-a")).execution_lease as Record<string, unknown>;
    expect(typeof lease.holder).toBe("string");
  });

  test("returned handoff occupies capacity", async () => {
    const fixture = await bindFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });

    const a = intentOf(await reserveFor(fixture, "plan-a"));
    await submitLaunch(fixture, a.id, "pane-plan-a");

    // The child reaches its scoped stop: the durable handoff releases plan-a, so
    // both remaining slots become usable again.
    const handoffId = await handOffPlan(fixture, "plan-a");
    intentOf(await reserveFor(fixture, "plan-b"));
    intentOf(await reserveFor(fixture, "plan-c"));
    expect(refusalOf(await reserveFor(fixture, "plan-d")).code).toBe("launch.capacity-exceeded");

    // The coordinator returns the handoff for rework: returned work reactivates
    // occupancy, and plan-a still counts once (pending intent + live binding).
    const returned = await coordinatorOp(fixture, "plan-a", { kind: "return", handoffId, reason: "fix the slice" });
    expect((returned.data.coordination as Record<string, unknown> | null)?.handoff).toMatchObject({ state: "returned" });
    const afterReturn = refusalOf(await reserveFor(fixture, "plan-d"));
    expect(afterReturn.code).toBe("launch.capacity-exceeded");
    expect(afterReturn.message).toContain("plan-a");
    expect(journalIntents(fixture).map((entry) => entry.planId)).toEqual(["plan-a", "plan-b", "plan-c"]);
  });

  test("prepared hash drift refuses", async () => {
    const fixture = await bindFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });

    const a = intentOf(await reserveFor(fixture, "plan-a"));
    // The pinned Assignment changes after the reservation: the transition that
    // would create a pane must refuse instead of launching against drift.
    writeText(fixture.assignments["plan-a"]!, `${readFileSync(fixture.assignments["plan-a"]!, "utf8")}\nReworked scope.\n`);
    expect(refusalOf(await recordFor(fixture, a.id, "starting")).code).toBe("launch.prepared-hash-drift");
    const intents = journalIntents(fixture);
    expect(intents.length).toBe(1);
    expect(intents[0]!.state).toBe("reserved");
    expect(intents[0]!.evidencePaths).toEqual([]);

    // A fresh reservation against the same drifted Assignment refuses too,
    // authorizes nothing, and leaves the recorded intent alone.
    writeText(fixture.assignments["plan-b"]!, `${readFileSync(fixture.assignments["plan-b"]!, "utf8")}\nReworked scope.\n`);
    expect(refusalOf(await reserveFor(fixture, "plan-b")).code).toBe("launch.prepared-hash-drift");
    expect(journalIntents(fixture).length).toBe(1);
  });

  test("uncertain submission never retries", async () => {
    const fixture = await bindFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });

    const a = intentOf(await reserveFor(fixture, "plan-a"));
    intentOf(await recordFor(fixture, a.id, "starting"));
    const created = intentOf(await recordFor(fixture, a.id, "created", { target: "pane-plan-a" }));
    const submitting = intentOf(await recordFor(fixture, a.id, "submitting"));

    // A repeated side-effecting observation is an idempotent replay: no second
    // pane, no second evidence record, `applied: false`.
    const replay = await recordFor(fixture, a.id, "submitting");
    expect(appliedOf(replay)).toBe(false);
    expect(intentOf(replay).evidencePaths.length).toBe(submitting.evidencePaths.length);
    // A backward observation is refused outright, never replayed.
    expect(refusalOf(await recordFor(fixture, a.id, "created", { target: "pane-plan-a" })).code).toBe("launch.transition-invalid");

    // The stalled prompt is uncertainty: terminal, recorded, never retried.
    const uncertain = intentOf(await recordFor(fixture, a.id, "uncertain", { target: "pane-plan-a" }));
    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.target).toBe("pane-plan-a");
    expect(refusalOf(await recordFor(fixture, a.id, "submitted", { target: "pane-plan-a" })).code).toBe("launch.transition-invalid");
    const uncertainReplay = await recordFor(fixture, a.id, "uncertain", { target: "pane-plan-a" });
    expect(appliedOf(uncertainReplay)).toBe(false);
    expect(intentOf(uncertainReplay).evidencePaths.length).toBe(uncertain.evidencePaths.length);

    // The uncertain intent stays occupied: re-requesting plan-a returns the
    // terminal record without authorizing anything, while an unrelated plan
    // still has capacity.
    const again = await reserveFor(fixture, "plan-a");
    expect(appliedOf(again)).toBe(false);
    expect(intentOf(again).state).toBe("uncertain");
    expect(intentOf(await reserveFor(fixture, "plan-b")).state).toBe("reserved");
    expect(journalIntents(fixture).map((entry) => entry.state)).toEqual(["uncertain", "reserved"]);
  });

  test("foreign duplicate or unavailable capability refuses", async () => {
    const fixture = await bindFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });

    const a = intentOf(await reserveFor(fixture, "plan-a"));

    // A plan-pm session is not the lifecycle coordinator: the launch authority
    // is the coordinator identity, so a plan session's binding is refused by
    // name — before any store, snapshot or journal is read.
    const childSession = await bindPlanSessionOf(fixture, "plan-a");
    const planAuthority: ExecutionLaunchAuthority = {
      cwd: fixture.root,
      identity: { source: "host", sessionId: childSession.sessionId, workflowId: WORKFLOW_ID, role: "plan-pm", planId: "plan-a" },
      binding: { version: 1, harnessRoot: fixture.harness, session: childSession },
    };
    expect(refusalOf(await reservePlanLaunch(
      { operation: "reserve-launch", planId: "plan-b", transport: "herdr", skill: { name: "herdr", source: "herdr" }, capability: { executable: process.execPath, version: "0.9.0", target: "pane-current" } },
      planAuthority,
    )).code).toBe("launch.invalid-request");
    expect(refusalOf(await recordPlanLaunch(
      { operation: "record-launch", intentId: a.id, observation: "starting", evidencePath: evidenceOf(fixture, "foreign") },
      planAuthority,
    )).code).toBe("launch.invalid-request");

    // A binding that no longer describes the authority's current state is never
    // taken over: the DB authority is what continues the journal, and the refusal
    // is the ENGINE's own code for the state the reference is actually in — this
    // module renames nothing.
    const reservePlanB = (authority: ExecutionLaunchAuthority): Promise<PlanLaunchResult> =>
      reservePlanLaunch(
        { operation: "reserve-launch", planId: "plan-b", transport: "herdr", skill: { name: "herdr", source: "herdr" }, capability: { executable: process.execPath, version: "0.9.0", target: "pane-current" } },
        authority,
      );

    // (a) A reference from a superseded epoch is the §2.1 reference-authority
    //     fence, which the engine answers with the shared store-level
    //     `store.stale-epoch` before anything is read (`assertReferenceAuthority`).
    const supersededEpoch: ExecutionLaunchAuthority = {
      cwd: fixture.root,
      identity: { source: "host", sessionId: fixture.coordinator.sessionId, workflowId: WORKFLOW_ID, role: "coordinator", planId: null },
      binding: { version: 1, harnessRoot: fixture.harness, session: { ...plainRef(fixture.coordinator), epoch: fixture.coordinator.epoch + 1 } },
    };
    expect(refusalOf(await reservePlanB(supersededEpoch)).code).toBe("store.stale-epoch");

    // (b) A well-formed reference the store holds no ACTIVE row for — what the
    //     epoch fence never reaches — is the engine's own
    //     `execution.session-unavailable`: a session reference authorizes only
    //     the binding the store records at the current epoch.
    const unheldSession = "fixture-unbound-coordinator";
    const unheldAuthority: ExecutionLaunchAuthority = {
      cwd: fixture.root,
      identity: { source: "host", sessionId: unheldSession, workflowId: WORKFLOW_ID, role: "coordinator", planId: null },
      binding: { version: 1, harnessRoot: fixture.harness, session: { ...plainRef(fixture.coordinator), sessionId: unheldSession } },
    };
    expect(refusalOf(await reservePlanB(unheldAuthority)).code).toBe("execution.session-unavailable");
    expect(journalIntents(fixture).some((entry) => entry.planId === "plan-b")).toBe(false);

    // A duplicate identical request returns the recorded intent and consumes no
    // second slot.
    const duplicate = await reserveFor(fixture, "plan-a");
    expect(appliedOf(duplicate)).toBe(false);
    expect(intentOf(duplicate).id).toBe(a.id);
    expect(journalIntents(fixture).filter((entry) => entry.planId === "plan-a").length).toBe(1);

    // A stale journal entry this plugin cannot re-derive from the engine (an
    // intent recorded against an earlier prepared revision) is a duplicate
    // owner, not a second authorization.
    const recorded = journalIntents(fixture);
    writeJson(fixture.journalPath, {
      ...readJson(fixture.journalPath),
      intents: [...recorded, { ...a, id: "phase2-launch:plan-c:1", planId: "plan-c", preparedHash: "0".repeat(64) }],
    });
    expect(refusalOf(await reserveFor(fixture, "plan-c")).code).toBe("launch.plan-occupied");
    writeJson(fixture.journalPath, { ...readJson(fixture.journalPath), intents: recorded });

    // A plan already owned in the engine refuses outright: no second owner.
    await bindPlanSessionOf(fixture, "plan-c");
    expect(refusalOf(await reserveFor(fixture, "plan-c")).code).toBe("launch.plan-unavailable");
    expect(journalIntents(fixture).some((entry) => entry.planId === "plan-c")).toBe(false);

    // Capability: the CLI must resolve, the caller must be inside exactly the
    // matching managed environment, and an absent skill assertion is refused.
    expect(refusalOf(await reserveFor(fixture, "plan-b", { capability: { executable: "herdr-definitely-missing", version: "0.9.0", target: "pane-current" } })).code).toBe("launch.capability-unavailable");
    delete process.env.HERDR_ENV;
    expect(refusalOf(await reserveFor(fixture, "plan-b")).code).toBe("launch.capability-unavailable");
    process.env.HERDR_ENV = "1";
    process.env.TMUX = "1";
    expect(refusalOf(await reserveFor(fixture, "plan-b")).code).toBe("launch.capability-unavailable");
    delete process.env.TMUX;
    expect(refusalOf(await reserveFor(fixture, "plan-b", { skill: { name: "", source: "" } })).code).toBe("launch.invalid-request");
    expect(journalIntents(fixture).some((entry) => entry.planId === "plan-b")).toBe(false);
  });

  test("identity-matched handoff releases its own launch intent", async () => {
    const fixture = await bindFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });

    const a = intentOf(await reserveFor(fixture, "plan-a"));
    await driveChildToScopedStop(fixture, "plan-a", a.id);

    // The handoff was submitted by exactly plan-a's bound session, for the
    // prepared pin and the checkout this launch recorded: it releases the slot.
    expect(intentOf(await reserveFor(fixture, "plan-b")).state).toBe("reserved");
    expect(intentOf(await reserveFor(fixture, "plan-c")).state).toBe("reserved");
    expect(refusalOf(await reserveFor(fixture, "plan-d")).code).toBe("launch.capacity-exceeded");

    // Released, never deleted: the transport record survives its plan's stop.
    const released = journalIntents(fixture).find((entry) => entry.id === a.id);
    expect(released?.state).toBe("submitted");
    expect(released?.target).toBe("pane-plan-a");
  });

  test("mismatched prepared pin keeps a stale intent occupying capacity", async () => {
    const fixture = await bindFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });

    const a = intentOf(await reserveFor(fixture, "plan-a"));
    await driveChildToScopedStop(fixture, "plan-a", a.id);

    // A recovered intent from an earlier prepared revision: the row's durable
    // handoff belongs to the CURRENT pin, so it cannot reclaim this record, and
    // the recovered record keeps occupying plan-a.
    appendJournalIntents(fixture, [{ ...a, id: "phase2-launch:plan-a:0", preparedHash: "0".repeat(64) }]);

    expect(intentOf(await reserveFor(fixture, "plan-b")).state).toBe("reserved");
    const refused = refusalOf(await reserveFor(fixture, "plan-c"));
    expect(refused.code).toBe("launch.capacity-exceeded");
    expect(refused.message).toContain("plan-a");
    // Nothing was silently reclaimed to make room.
    expect(journalIntents(fixture).filter((entry) => entry.planId === "plan-a").length).toBe(2);
  });

  test("foreign or other-attempt handoff stays occupied until an explicit release", async () => {
    const fixture = await bindFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });

    const a = intentOf(await reserveFor(fixture, "plan-a"));
    await driveChildToScopedStop(fixture, "plan-a", a.id);

    // A recovered intent whose recorded checkout is NOT the one that handed off:
    // the durable handoff belongs to another launch/attempt, so it must not
    // discharge this record even though the prepared pin and plan match.
    expect(preparedHashOf(fixture, "plan-a")).toBe(a.preparedHash);
    const foreign = { ...a, id: "phase2-launch:plan-a:0", state: "reserved", worktreePath: fixture.worktrees["plan-b"]! };
    appendJournalIntents(fixture, [foreign]);

    expect(intentOf(await reserveFor(fixture, "plan-b")).state).toBe("reserved");
    expect(refusalOf(await reserveFor(fixture, "plan-c")).code).toBe("launch.capacity-exceeded");

    // The only release for such a record is an explicit observation — the
    // operator's recovery proves no pane/prompt ever existed.
    const released = intentOf(await recordFor(fixture, "phase2-launch:plan-a:0", "refused"));
    expect(released.state).toBe("refused");
    expect(intentOf(await reserveFor(fixture, "plan-c")).state).toBe("reserved");
    expect(journalIntents(fixture).map((entry) => entry.state)).toEqual(["submitted", "refused", "reserved", "reserved"]);
  });

  test("assigned worktree must be a distinct same-repository checkout", async () => {
    const atMain = await bindFixture({ atMainCheckout: "plan-a" });
    writeSettings(atMain, { enabled: true, cap: 2 });
    expect(refusalOf(await reserveFor(atMain, "plan-a")).code).toBe("launch.worktree-unavailable");
    expect(existsSync(atMain.journalPath)).toBe(false);

    const atIntegration = await bindFixture({ atIntegrationCheckout: "plan-b" });
    writeSettings(atIntegration, { enabled: true, cap: 2 });
    expect(refusalOf(await reserveFor(atIntegration, "plan-b")).code).toBe("launch.worktree-unavailable");
    expect(existsSync(atIntegration.journalPath)).toBe(false);
  });
});
