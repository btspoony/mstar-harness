/**
 * Phase-2 launch admission journal — scoped checks for
 * `packages/omp/src/phase2-launches.ts` (plan `20260916-omp-phase2-instances`
 * T2; primary spec §C capacity/reservation and §D transport boundary).
 *
 * Fixture discipline: every coordination fact these cases assert on is created
 * through the REAL engine verbs — `bindPlanSession` (coordinator and plan),
 * `mutatePlanCoordination` (`prepare` / `progress` / `handoff` / `return`) in a
 * real Git repository with real linked worktrees — never by writing an accepted
 * lease, binding or handoff into the snapshot by hand. The journal, by contrast,
 * is this module's own transport document, so the case that needs a stale or
 * foreign journal writes that file directly: it is not engine state, and reading
 * a foreign one must refuse rather than take over.
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
  bindPlanSession,
  createFsStore,
  mutatePlanCoordination,
  readPlanCoordination,
  setArtifactStore,
  type CoordinationResult,
} from "@mstar-harness/engine";
import { recordPlanLaunch, reservePlanLaunch, type LaunchIntent, type PlanLaunchResult } from "../src/phase2-launches";
import type { Phase2Request } from "../src/phase2-orchestration";

const WORKFLOW_ID = "wf-instances";
const PROJECT_ID = "proj-instances";
const PLAN_IDS = ["plan-a", "plan-b", "plan-c", "plan-d"] as const;
const JOURNAL_FILE = "omp-launches.json";
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
  coordinatorSession: string;
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
  const rows: Array<Record<string, unknown>> = [];
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
    rows.push({
      id: planId,
      plan_id: planId,
      title: `Plan ${planId}`,
      file: `.mstar/plans/${planId}.md`,
      status: "Todo",
      metadata: { project_id: PROJECT_ID },
    });
  }

  writeJson(join(harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-16",
    workflows: [
      { id: WORKFLOW_ID, status: "running", type: "iteration", started_at: "2026-09-16T00:00:00Z", dir: `workflows/${WORKFLOW_ID}` },
    ],
  });
  writeJson(snapshotPath, {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "iteration",
    status: "running",
    started_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    phase: "phase-2-execute",
    branch: { base: "main", integration: "integration/wf" },
    integration_worktree_path: integrationPath,
    plans: rows,
  });
  setArtifactStore(createFsStore(harness));

  return {
    root,
    harness,
    workflowDir,
    snapshotPath,
    journalPath: join(workflowDir, JOURNAL_FILE),
    integrationPath,
    coordinatorSession: "",
    baseSha: headOf(root),
    planPaths,
    assignments,
    sddDirs,
    worktrees,
  };
}

/** Bind the lifecycle coordinator (real engine verb) and prepare every plan. */
async function bindFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const fixture = makeFixture(options);
  const bound = await bindPlanSession({ coordinator: true, workflowId: WORKFLOW_ID, harnessDir: fixture.harness, cwd: fixture.root });
  expect(bound.outcome).toBe("bound");
  fixture.coordinatorSession = bound.session_file;
  for (const planId of PLAN_IDS) {
    const view = await readPlanCoordination(fixture.coordinatorSession, planId, fixture.root);
    const prepared = await mutatePlanCoordination({
      sessionPath: fixture.coordinatorSession,
      planId,
      expectedRevision: view.revision,
      operation: { kind: "prepare", assignmentPath: fixture.assignments[planId]! },
    });
    expect(prepared.outcome).toBe("prepared");
  }
  return fixture;
}

/** One coordinator-scoped operation on a plan, with the revision read just before. */
async function coordinatorOp(fixture: Fixture, planId: PlanId, operation: Record<string, unknown>): Promise<CoordinationResult> {
  const view = await readPlanCoordination(fixture.coordinatorSession, planId, fixture.root);
  return mutatePlanCoordination({
    sessionPath: fixture.coordinatorSession,
    planId,
    expectedRevision: view.revision,
    operation: operation as never,
  });
}

/** Bind one plan's own session (claims the row's execution lease), returning its envelope path. */
async function bindPlanSessionOf(fixture: Fixture, planId: PlanId): Promise<string> {
  const bound = await bindPlanSession({ scope: { workflowId: WORKFLOW_ID, planId, harnessDir: fixture.harness }, cwd: fixture.root });
  expect(bound.outcome).toBe("claimed");
  return bound.session_file;
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

function authorityOf(fixture: Fixture): { coordinatorSessionPath: string; cwd: string } {
  return { coordinatorSessionPath: fixture.coordinatorSession, cwd: fixture.root };
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
function preparedHashOf(fixture: Fixture, planId: string): string {
  const coordination = planRowOf(fixture, planId).coordination as Record<string, unknown> | undefined;
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

function planRowOf(fixture: Fixture, planId: string): Record<string, unknown> {
  const rows = readJson(fixture.snapshotPath).plans as Array<Record<string, unknown>>;
  const row = rows.find((entry) => entry.id === planId);
  if (row === undefined) throw new Error(`snapshot has no row ${planId}`);
  return row;
}

function handoffIdOf(fixture: Fixture, planId: PlanId): string {
  const coordination = planRowOf(fixture, planId).coordination as Record<string, unknown> | undefined;
  const handoff = coordination?.handoff as Record<string, unknown> | undefined;
  if (typeof handoff?.id !== "string") throw new Error(`plan ${planId} has no handoff id`);
  return handoff.id;
}

/** The child's own path to its scoped stop: bind, report InReview, hand off. */
async function handOffPlan(fixture: Fixture, planId: PlanId): Promise<string> {
  const sessionPath = await bindPlanSessionOf(fixture, planId);
  const view = await readPlanCoordination(sessionPath, planId, fixture.root);
  const progressed = await mutatePlanCoordination({
    sessionPath,
    planId,
    expectedRevision: view.revision,
    operation: { kind: "progress", progress: { status: "InReview", summary: "slice implemented", evidence_paths: [] } },
  });
  expect(progressed.outcome).toBe("progressed");

  const reports = [join(fixture.sddDirs[planId]!, "review", "qc1.md"), join(fixture.sddDirs[planId]!, "review", "qc2.md")];
  for (const path of reports) writeText(path, "# qc report\n");
  const consolidated = join(fixture.sddDirs[planId]!, "review", "qc.md");
  const qa = join(fixture.sddDirs[planId]!, "qa.md");
  writeText(consolidated, "# consolidated qc\n");
  writeText(qa, "# qa pass\n");

  const sourceSha = headOf(fixture.worktrees[planId]!);
  const after = await readPlanCoordination(sessionPath, planId, fixture.root);
  const handed = await mutatePlanCoordination({
    sessionPath,
    planId,
    expectedRevision: after.revision,
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
  expect(handed.outcome).toBe("handed-off");
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
    const lease = planRowOf(fixture, "plan-a").execution_lease as Record<string, unknown>;
    expect(lease.holder).toBe(readJson(childSession).session_id);
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
    const lease = planRowOf(fixture, "plan-a").execution_lease as Record<string, unknown>;
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
    expect(returned.outcome).toBe("returned");
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

    // A scoped plan session is not the lifecycle coordinator: it may not launch
    // sibling primaries, and neither call accepts its authority.
    const childSession = await bindPlanSessionOf(fixture, "plan-a");
    const planAuthority = { coordinatorSessionPath: childSession, cwd: fixture.root };
    expect(refusalOf(await reservePlanLaunch(
      { operation: "reserve-launch", planId: "plan-b", transport: "herdr", skill: { name: "herdr", source: "herdr" }, capability: { executable: process.execPath, version: "0.9.0", target: "pane-current" } },
      planAuthority,
    )).code).toBe("launch.session-denied");
    expect(refusalOf(await recordPlanLaunch(
      { operation: "record-launch", intentId: a.id, observation: "starting", evidencePath: evidenceOf(fixture, "foreign") },
      planAuthority,
    )).code).toBe("launch.session-denied");

    // A journal opened by another coordinator identity is never taken over.
    const ownJournal = readJson(fixture.journalPath);
    writeJson(fixture.journalPath, {
      ...ownJournal,
      coordinator: { session_id: "another-coordinator", session_file: join(fixture.workflowDir, "sessions", "another.json") },
    });
    expect(refusalOf(await reserveFor(fixture, "plan-b")).code).toBe("launch.journal-corrupt");
    writeJson(fixture.journalPath, ownJournal);

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
