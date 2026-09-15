/**
 * Engine scoped-plan coordination — slice A (core, binding and read
 * operations) of plan `20260915-plan-coordination` Task 1.
 *
 * Spec sources (each group cites the section it enforces):
 * - Spec §B — one coordinator session per lifecycle, one plan session per plan;
 *   the session envelope is identity + pointers only, absolute, `0600`, and it
 *   is the durable proof of who holds the session.
 * - Spec §B — `resolvePlanScope`: both address forms (pinned Assignment path,
 *   workflow/plan pair read through the row's `prepared` block) resolve to the
 *   same `ResolvedPlanScope`.
 * - Spec §C — prepared Assignment is hash-pinned (`assignment_sha256`); a
 *   mutated Assignment invalidates the row (`coordination.assignment-stale`).
 * - Spec §C — row `coordination.revision` is the snapshot CAS; the project
 *   register is compare-and-swapped on its **byte version** under the
 *   root→snapshot→register lock order, so a cross-process writer can never
 *   produce a lost update.
 * - Spec §D — residual writes are scoped to `entries[<plan-id>]`: the engine
 *   generates provenance (`source_plan` / `lifecycle_id` / `registered_at`)
 *   and never touches a sibling plan's bucket.
 * - Slice A boundary — the operations still owed by slice B (`handoff`,
 *   `accept`, `return`, `integration-*`, `complete`, `reconcile`) are neither
 *   advertised in `allowed_operations` nor silently no-ops: they refuse with
 *   the stable code `coordination.not-implemented`.
 *
 * Fixture discipline: the temp root is `realpathSync`-ed before any path is
 * derived from it, because the engine compares `realpathSync` worktree roots
 * (git) with lexically-resolved harness paths; every plan id is a safe path
 * component (`assertSafePathComponent`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bindPlanSession,
  mutatePlanCoordination,
  readPlanCoordination,
  resolvePlanScope,
  type CoordinationResult,
  type PlanCoordinationView,
} from "../src/coordination.js";
import { CoordinationError } from "../src/coordination-write.js";
import { claimLease } from "../src/lease.js";
import { createFsStore, setArtifactStore } from "../src/store.js";

const WORKFLOW_ID = "wf-plana";
const PLAN_ID = "plan-a";
const PEER_PLAN_ID = "plan-b";
const PROJECT_ID = "proj-a";

type Fixture = {
  root: string;
  harness: string;
  workflowDir: string;
  planPath: string;
  peerPlanPath: string;
  sddDir: string;
  worktreePath: string;
  assignmentPath: string;
  peerAssignmentPath: string;
  coordinatorSession: string;
  planSession: string;
  peerSession: string;
  snapshotPath: string;
  registerPath: string;
};

const roots: string[] = [];

afterEach(() => {
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

/** A plan row in the legacy `validatePlanRow` shape (id/title/file/status). */
function planRow(id: string, projectId: string | undefined, workingBranch?: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (projectId !== undefined) metadata.project_id = projectId;
  // A row records its retained working branch once a plan session binds it; the
  // engine then knows that branch belongs to that plan.
  if (workingBranch !== undefined) metadata.working_branch = workingBranch;
  return {
    id,
    plan_id: id,
    title: `Plan ${id}`,
    file: `.mstar/plans/${id}.md`,
    status: "Todo",
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

/** Assignment header block — the scoped format `parseAssignmentFile` accepts. */
function assignmentText(input: {
  harness: string;
  planId: string;
  planPath: string;
  worktreePath: string;
  sddDir: string;
  branch: string;
  note: string;
}): string {
  return [
    `# Assignment — ${input.planId} slice A`,
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
    "**Findings cleanup**: zero-residual",
    "",
    input.note,
    "",
  ].join("\n");
}

/** Both plans live under one project register: cross-plan writes contend for it. */
function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-coordination-")));
  roots.push(root);
  git(["init", "-q", "-b", "main"], root);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], root);

  const harness = join(root, ".mstar");
  const workflowDir = join(harness, "workflows", WORKFLOW_ID);
  const snapshotPath = join(workflowDir, "snapshot.json");
  const registerPath = join(harness, "projects", PROJECT_ID, "residuals.json");
  const planPath = join(harness, "plans", `${PLAN_ID}.md`);
  const peerPlanPath = join(harness, "plans", `${PEER_PLAN_ID}.md`);
  const sddDir = join(harness, "sdd", PLAN_ID);
  const worktreePath = join(root, "wt-plana");

  writeText(planPath, "# plan a\n");
  writeText(peerPlanPath, "# plan b\n");
  mkdirSync(sddDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });

  writeJson(join(harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-15T00:00:00Z",
    workflows: [{ id: WORKFLOW_ID, status: "running", type: "iteration", started_at: "2026-09-15T00:00:00Z", dir: `workflows/${WORKFLOW_ID}` }],
  });
  writeJson(snapshotPath, {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "iteration",
    status: "running",
    started_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    branch: { base: "main" },
    plans: [planRow(PLAN_ID, PROJECT_ID), planRow(PEER_PLAN_ID, PROJECT_ID, "feature/plan-b")],
  });

  const assignmentPath = join(harness, "sdd", PLAN_ID, "assignment.md");
  const peerAssignmentPath = join(harness, "sdd", PEER_PLAN_ID, "assignment.md");
  writeText(
    assignmentPath,
    assignmentText({ harness, planId: PLAN_ID, planPath, worktreePath, sddDir, branch: "feature/plan-a", note: "Slice A." }),
  );
  writeText(
    peerAssignmentPath,
    assignmentText({
      harness,
      planId: PEER_PLAN_ID,
      planPath: peerPlanPath,
      worktreePath: join(root, "wt-planb"),
      sddDir: join(harness, "sdd", PEER_PLAN_ID),
      branch: "feature/plan-b",
      note: "Slice B.",
    }),
  );
  mkdirSync(join(root, "wt-planb"), { recursive: true });

  setArtifactStore(createFsStore(harness));

  return {
    root,
    harness,
    workflowDir,
    planPath,
    peerPlanPath,
    sddDir,
    worktreePath,
    assignmentPath,
    peerAssignmentPath,
    // Engine-generated envelope paths, filled in by the first bind.
    coordinatorSession: "",
    planSession: "",
    peerSession: "",
    snapshotPath,
    registerPath,
  };
}

async function errorCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CoordinationError) return error.code;
    throw error;
  }
  throw new Error("expected the coordination call to fail");
}

/** Bind the lifecycle coordinator once per fixture (the engine picks the path). */
async function ensureCoordinator(fixture: Fixture): Promise<string> {
  if (fixture.coordinatorSession === "") {
    const bound = await bindPlanSession({ coordinator: true, workflowId: WORKFLOW_ID, harnessDir: fixture.harness, cwd: fixture.root });
    expect(bound.ok).toBe(true);
    expect(bound.operation).toBe("bind");
    fixture.coordinatorSession = bound.session_file;
  }
  return fixture.coordinatorSession;
}

/** Prepare one plan through the bound coordinator session (slice A fixture path). */
async function preparePlan(fixture: Fixture, planId: string): Promise<CoordinationResult> {
  const sessionPath = await ensureCoordinator(fixture);
  const assignmentPath = planId === PLAN_ID ? fixture.assignmentPath : fixture.peerAssignmentPath;
  const view = await readPlanCoordination(sessionPath, planId, fixture.root);
  return mutatePlanCoordination({
    sessionPath,
    planId,
    expectedRevision: view.revision,
    operation: { kind: "prepare", assignmentPath },
  });
}

/** Fresh bind of a prepared plan; the engine generates the envelope path. */
async function bindPlan(fixture: Fixture, planId: string): Promise<CoordinationResult> {
  const bound = await bindPlanSession({
    scope: { workflowId: WORKFLOW_ID, planId, harnessDir: fixture.harness },
    cwd: fixture.root,
  });
  if (planId === PLAN_ID) fixture.planSession = bound.session_file;
  else fixture.peerSession = bound.session_file;
  return bound;
}

/** Read-only resume of an already bound plan session. */
async function resumePlan(fixture: Fixture, planId: string): Promise<CoordinationResult> {
  const sessionPath = planId === PLAN_ID ? fixture.planSession : fixture.peerSession;
  return bindPlanSession({ resumePath: sessionPath, cwd: fixture.root });
}

function residual(id: string): Record<string, string> {
  return {
    id,
    title: `Finding ${id}`,
    severity: "medium",
    source: "qc",
    scope: "engine",
    decision: "defer",
    owner: "@fullstack-dev",
    target: "next-slice",
    tracking: "residual register",
  };
}

function registerBucket(fixture: Fixture, planId: string): Array<Record<string, unknown>> {
  const doc = readJson(fixture.registerPath);
  const entries = doc.entries;
  if (typeof entries !== "object" || entries === null) throw new Error("register has no entries object");
  const bucket = (entries as Record<string, unknown>)[planId];
  if (!Array.isArray(bucket)) throw new Error(`register has no bucket for ${planId}`);
  return bucket as Array<Record<string, unknown>>;
}

type GitFixture = Fixture & { integrationPath: string; baseSha: string; planSha: string };

function headOf(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/**
 * A fixture whose plan worktree is a real Git checkout on the plan's own branch
 * and whose snapshot names a real integration checkout, so the handoff and
 * integration proofs run against real objects instead of path stubs.
 */
function gitFixture(): GitFixture {
  const fixture = makeFixture() as GitFixture;
  fixture.baseSha = headOf(fixture.root);
  fixture.integrationPath = join(fixture.root, "wt-integration");
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  git(["worktree", "add", "-q", "-b", "feature/plan-a", fixture.worktreePath], fixture.root);
  git(["worktree", "add", "-q", "-b", "integration/plan-a", fixture.integrationPath], fixture.root);
  writeText(join(fixture.worktreePath, "slice.txt"), "slice B\n");
  git(["add", "-A"], fixture.worktreePath);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat: slice B"], fixture.worktreePath);
  fixture.planSha = headOf(fixture.worktreePath);
  // The snapshot names the integration checkout handoff/integration address.
  writeJson(fixture.snapshotPath, {
    ...readJson(fixture.snapshotPath),
    branch: { base: "main", integration: "integration/plan-a" },
    integration_worktree_path: fixture.integrationPath,
  });
  return fixture;
}

function snapshotOf(fixture: Fixture): Record<string, unknown> {
  return readJson(fixture.snapshotPath);
}

function planRowOf(fixture: Fixture, planId: string): Record<string, unknown> {
  const rows = snapshotOf(fixture).plans;
  if (!Array.isArray(rows)) throw new Error("snapshot has no plans array");
  const row = rows.find((entry) => entry?.id === planId);
  if (row === undefined) throw new Error(`snapshot has no row ${planId}`);
  return row;
}

/** Direct fixture edits stand in for the session/status writes a live run does. */
function updatePlanRow(
  fixture: Fixture,
  planId: string,
  patch: (row: Record<string, unknown>) => Record<string, unknown>,
): void {
  const snapshot = snapshotOf(fixture);
  const rows = snapshot.plans;
  if (!Array.isArray(rows)) throw new Error("snapshot has no plans array");
  writeJson(fixture.snapshotPath, { ...snapshot, plans: rows.map((row) => (row.id === planId ? patch(row) : row)) });
}

function claimExecutionLease(fixture: Fixture, planId: string, sessionPath: string): void {
  const sessionId = readJson(sessionPath).session_id;
  if (typeof sessionId !== "string") throw new Error("session envelope has no session_id");
  const branch = planId === PLAN_ID ? "feature/plan-a" : "feature/plan-b";
  updatePlanRow(fixture, planId, (row) => {
    const claimed = claimLease(row as never, sessionId, {
      worktree_path: planId === PLAN_ID ? fixture.worktreePath : join(fixture.root, "wt-planb"),
      working_branch: branch,
    });
    if (!claimed.ok) throw new Error(`claim failed: ${claimed.violations.map((entry) => entry.code).join(", ")}`);
    return claimed.row;
  });
}

function handoffFields(row: Record<string, unknown>): Record<string, unknown> {
  const coordination = row.coordination;
  if (coordination === null || typeof coordination !== "object" || !("handoff" in coordination)) {
    throw new Error("row has no coordination.handoff");
  }
  return coordination.handoff as Record<string, unknown>;
}

function leaseHolder(row: Record<string, unknown>): string | undefined {
  const lease = row.execution_lease;
  if (lease === null || typeof lease !== "object" || !("holder" in lease)) return undefined;
  return typeof lease.holder === "string" ? lease.holder : undefined;
}

/** Handoff evidence the way a plan session submits it: paths and revisions. */
type HandoffEvidence = {
  source_sha: string;
  worktree_path: string;
  review_base: string;
  review_head: string;
  qc: { decision: string; reports: string[]; consolidated: string };
  qa: { gate: string; decision: string; report: string };
};

/** Review/QA evidence inside the plan's own SDD area. */
function handoffEvidenceOf(fixture: GitFixture, sourceSha: string): HandoffEvidence {
  const reports = [join(fixture.sddDir, "review", "qc1.md"), join(fixture.sddDir, "review", "qc2.md")];
  for (const path of reports) writeText(path, "# qc report\n");
  const consolidated = join(fixture.sddDir, "review", "qc.md");
  const qa = join(fixture.sddDir, "qa.md");
  writeText(consolidated, "# consolidated qc\n");
  writeText(qa, "# qa pass\n");
  return {
    source_sha: sourceSha,
    worktree_path: fixture.worktreePath,
    review_base: fixture.baseSha,
    review_head: sourceSha,
    qc: { decision: "Approve", reports, consolidated },
    qa: { gate: "mandatory", decision: "pass", report: qa },
  };
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (value === null || typeof value !== "object") throw new Error(`${key} is not an object`);
  return value as Record<string, unknown>;
}

/** The `sha256` of a stored evidence ref, or a failed assertion. */
function digestOf(ref: unknown): string {
  if (ref === null || typeof ref !== "object" || !("sha256" in ref) || typeof ref.sha256 !== "string") {
    throw new Error("evidence ref has no sha256");
  }
  return ref.sha256;
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function handoffCall(fixture: Fixture, evidence: HandoffEvidence): Promise<CoordinationResult> {
  const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
  return mutatePlanCoordination({
    sessionPath: fixture.planSession,
    planId: PLAN_ID,
    expectedRevision: view.revision,
    operation: { kind: "handoff", evidence } as never,
  });
}

async function coordinatorCall(
  fixture: Fixture,
  planId: string,
  operation: Record<string, unknown>,
): Promise<CoordinationResult> {
  const view = await readPlanCoordination(fixture.coordinatorSession, planId, fixture.root);
  return mutatePlanCoordination({
    sessionPath: fixture.coordinatorSession,
    planId,
    expectedRevision: view.revision,
    operation: operation as never,
  });
}

describe("binding", () => {
  test("coordinator bind claims the lifecycle with a 0600 envelope and refuses a second holder", async () => {
    const fixture = makeFixture();

    const bound = await bindPlanSession({ coordinator: true, workflowId: WORKFLOW_ID, harnessDir: fixture.harness, cwd: fixture.root });
    fixture.coordinatorSession = bound.session_file;

    expect(bound.operation).toBe("bind");
    expect(bound.outcome).toBe("bound");
    expect(bound.session_file).toBe(join(fixture.workflowDir, "sessions", `${bound.session.session_id}.json`));
    expect(bound.session.role).toBe("coordinator");
    expect(bound.session.plan_id).toBeUndefined();
    expect(existsSync(fixture.coordinatorSession)).toBe(true);
    expect(statSync(fixture.coordinatorSession).mode & 0o777).toBe(0o600);
    const envelope = readJson(fixture.coordinatorSession);
    expect(Object.keys(envelope).sort()).toEqual(["harness_root", "role", "schema_version", "session_id", "workflow_id"]);
    expect(envelope.harness_root).toBe(fixture.harness);

    // The binding is durable in the snapshot, never copied into the envelope.
    const snapshot = readJson(fixture.snapshotPath);
    const coordination = snapshot.coordination as { coordinator?: { session_file?: string } };
    expect(coordination.coordinator?.session_file).toBe(fixture.coordinatorSession);

    // Same session file → read-only resume, no write at all.
    const bytesBefore = readFileSync(fixture.snapshotPath, "utf8");
    const resumed = await bindPlanSession({ resumePath: fixture.coordinatorSession, cwd: fixture.root });
    expect(resumed.outcome).toBe("resumed");
    expect(resumed.session.session_id).toBe(bound.session.session_id);
    expect(resumed.session_file).toBe(fixture.coordinatorSession);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(bytesBefore);

    // A second coordinator identity is refused and the binding is untouched.
    expect(
      await errorCodeOf(() =>
        bindPlanSession({ coordinator: true, workflowId: WORKFLOW_ID, harnessDir: fixture.harness, cwd: fixture.root }),
      ),
    ).toBe("coordination.duplicate-holder");
    const after = readJson(fixture.snapshotPath) as { coordination?: { coordinator?: { session_file?: string } } };
    expect(after.coordination?.coordinator?.session_file).toBe(fixture.coordinatorSession);
  });

  test("a plan session claims a prepared plan, resumes read-only, and refuses a second identity", async () => {
    const fixture = makeFixture();
    const prepared = await preparePlan(fixture, PLAN_ID);
    expect(prepared.outcome).toBe("prepared");

    const claimed = await bindPlan(fixture, PLAN_ID);
    expect(claimed.outcome).toBe("claimed");
    expect(claimed.session.role).toBe("plan-pm");
    expect(claimed.session.plan_id).toBe(PLAN_ID);

    const snapshot = readJson(fixture.snapshotPath);
    const row = (snapshot.plans as Array<Record<string, unknown>>)[0];
    expect(row.status).toBe("InProgress");
    const lease = row.execution_lease as Record<string, unknown>;
    expect(Object.values(lease)).toContain(claimed.session.session_id);
    expect(lease.worktree_path).toBe(fixture.worktreePath);
    expect(lease.working_branch).toBe("feature/plan-a");

    // Resume validates the persisted binding and re-acquires nothing.
    const bytesBefore = readFileSync(fixture.snapshotPath, "utf8");
    const resumed = await resumePlan(fixture, PLAN_ID);
    expect(resumed.outcome).toBe("resumed");
    expect(resumed.session.session_id).toBe(claimed.session.session_id);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(bytesBefore);

    // A second fresh bind cannot take over a held plan.
    expect(
      await errorCodeOf(() =>
        bindPlanSession({ scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness }, cwd: fixture.root }),
      ),
    ).toBe("coordination.duplicate-holder");

    // An unprepared plan cannot be bound at all.
    expect(await errorCodeOf(() => bindPlan(fixture, PEER_PLAN_ID))).toBe("coordination.not-prepared");
  });

  test("unimplemented operations are refused, never advertised, and never silently no-op", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);

    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect([...view.allowed_operations].sort()).toEqual(["handoff", "progress", "residual-add", "residual-close"]);
    for (const kind of ["integration-start", "integration-accept", "complete", "reconcile"]) {
      expect(view.allowed_operations).not.toContain(kind);
      expect(
        await errorCodeOf(() =>
          mutatePlanCoordination({
            sessionPath: fixture.planSession,
            planId: PLAN_ID,
            expectedRevision: view.revision,
            operation: { kind } as never,
          }),
        ),
      ).toBe("coordination.not-implemented");
    }
    // Coordinator verbs are implemented and scoped: a plan session cannot issue them.
    for (const kind of ["accept", "return"]) {
      expect(
        await errorCodeOf(() =>
          mutatePlanCoordination({
            sessionPath: fixture.planSession,
            planId: PLAN_ID,
            expectedRevision: view.revision,
            operation: { kind } as never,
          }),
        ),
      ).toBe("coordination.session-role");
    }
    // `handoff` is implemented: it refuses its own missing evidence, not the slice boundary.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.planSession,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: { kind: "handoff" } as never,
        }),
      ),
    ).toBe("coordination.invalid-input");
    // A precondition on the operation itself is refused: it belongs to the request.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.planSession,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: { kind: "progress", expectedRevision: view.revision } as never,
        }),
      ),
    ).toBe("coordination.invalid-input");
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.planSession,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: { kind: "nonsense" } as never,
        }),
      ),
    ).toBe("coordination.unknown-operation");

    // A coordinator view of an *unprepared* row is where first preparation is reachable.
    const coordinatorView = await readPlanCoordination(fixture.coordinatorSession, PEER_PLAN_ID, fixture.root);
    expect(coordinatorView.allowed_operations).toEqual(["prepare"]);
    expect(coordinatorView.scope).toBeNull();
  });
});

describe("handoff-transitions", () => {
  test("handoff seals the evidence, accept moves the lease to the coordinator, return restores it", async () => {
    const fixture = gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));

    const evidence = handoffEvidenceOf(fixture, fixture.planSha);
    const planSessionId = readJson(fixture.planSession).session_id;
    const coordinatorSessionId = readJson(fixture.coordinatorSession).session_id;

    // A dirty plan worktree is not a handoff-able state.
    writeText(join(fixture.worktreePath, "scratch.txt"), "wip\n");
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.git-proof");
    rmSync(join(fixture.worktreePath, "scratch.txt"), { force: true });

    // An abbreviated revision is never silently expanded into a pin.
    expect(await errorCodeOf(() => handoffCall(fixture, { ...evidence, source_sha: fixture.planSha.slice(0, 7) }))).toBe(
      "coordination.invalid-input",
    );

    // Evidence must live inside this plan's own plan/SDD area.
    const stray = join(fixture.root, "stray-qc.md");
    writeText(stray, "# qc\n");
    expect(
      await errorCodeOf(() => handoffCall(fixture, { ...evidence, qc: { ...evidence.qc, reports: [stray] } })),
    ).toBe("coordination.path-mismatch");

    // A QA gate the Assignment never pinned is a stale handoff.
    expect(
      await errorCodeOf(() => handoffCall(fixture, { ...evidence, qa: { ...evidence.qa, gate: "pm-acceptance" } })),
    ).toBe("coordination.assignment-stale");

    const handed = await handoffCall(fixture, evidence);
    expect(handed.outcome).toBe("handed-off");
    const handedRow = planRowOf(fixture, PLAN_ID);
    expect(handedRow.status).toBe("InReview");
    expect(leaseHolder(handedRow)).toBe(planSessionId);
    const handoff = handoffFields(handedRow);
    expect(handoff.state).toBe("submitted");
    expect(handoff.attempt).toBe(1);
    expect(handoff.submitted_by).toBe(planSessionId);
    expect(typeof handoff.submitted_at).toBe("string");
    expect(handoff.source_branch).toBe("feature/plan-a");
    expect(handoff.source_sha).toBe(fixture.planSha);
    expect(handoff.review_base).toBe(fixture.baseSha);
    expect(handoff.review_head).toBe(fixture.planSha);
    expect(handoff.worktree_path).toBe(fixture.worktreePath);

    // Evidence is sealed by content, not by reference: the digest is the file's.
    const qc = recordField(handoff, "qc");
    expect(qc.decision).toBe("Approve");
    const reports = qc.reports;
    if (!Array.isArray(reports)) throw new Error("qc.reports is not an array");
    expect(reports).toHaveLength(2);
    expect(reports.map(digestOf)).toEqual([
      sha256OfFile(join(fixture.sddDir, "review", "qc1.md")),
      sha256OfFile(join(fixture.sddDir, "review", "qc2.md")),
    ]);
    const consolidated = recordField(qc, "consolidated");
    expect(consolidated.path).toBe(join(fixture.sddDir, "review", "qc.md"));
    expect(digestOf(consolidated)).toBe(sha256OfFile(join(fixture.sddDir, "review", "qc.md")));
    const qa = recordField(handoff, "qa");
    expect(qa.gate).toBe("mandatory");
    expect(qa.decision).toBe("pass");
    expect(digestOf(recordField(qa, "report"))).toBe(sha256OfFile(join(fixture.sddDir, "qa.md")));

    // The plan session is done until the row comes back; the coordinator can act.
    const planView = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(planView.allowed_operations).toEqual([]);
    const coordinatorView = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect([...coordinatorView.allowed_operations].sort()).toEqual(["accept", "return"]);
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.invalid-transition");

    const accepted = await coordinatorCall(fixture, PLAN_ID, { kind: "accept" });
    expect(accepted.outcome).toBe("accepted");
    const acceptedRow = planRowOf(fixture, PLAN_ID);
    expect(acceptedRow.status).toBe("InReview");
    expect(leaseHolder(acceptedRow)).toBe(coordinatorSessionId);
    const acceptedHandoff = handoffFields(acceptedRow);
    expect(acceptedHandoff.id).toBe(handoff.id);
    expect(acceptedHandoff.state).toBe("accepted");
    expect(acceptedHandoff.accepted_by).toBe(coordinatorSessionId);
    expect(typeof acceptedHandoff.accepted_at).toBe("string");

    // A return needs a reason, and it puts the row back with its own session.
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "return" }))).toBe(
      "coordination.invalid-input",
    );
    const returned = await coordinatorCall(fixture, PLAN_ID, { kind: "return", reason: "review range is stale" });
    expect(returned.outcome).toBe("returned");
    const returnedRow = planRowOf(fixture, PLAN_ID);
    expect(returnedRow.status).toBe("InProgress");
    expect(leaseHolder(returnedRow)).toBe(planSessionId);
    const returnedHandoff = handoffFields(returnedRow);
    expect(returnedHandoff.state).toBe("returned");
    expect(returnedHandoff.return_reason).toBe("review range is stale");
    expect(typeof returnedHandoff.returned_at).toBe("string");

    // Rework is a new commit and a new attempt, never a rewritten record.
    writeText(join(fixture.worktreePath, "slice.txt"), "slice B v2\n");
    git(["add", "-A"], fixture.worktreePath);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix: rework"], fixture.worktreePath);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    const second = await handoffCall(fixture, handoffEvidenceOf(fixture, headOf(fixture.worktreePath)));
    expect(second.outcome).toBe("handed-off");
    const secondHandoff = handoffFields(planRowOf(fixture, PLAN_ID));
    expect(secondHandoff.state).toBe("submitted");
    expect(secondHandoff.attempt).toBe(2);
    expect(secondHandoff.id).not.toBe(returnedHandoff.id);
    expect(secondHandoff.source_sha).toBe(headOf(fixture.worktreePath));
  });
});

describe("scope-and-revisions", () => {
  test("both address forms resolve to the same pinned scope", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);

    const fromPair = await resolvePlanScope({ workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness }, fixture.root);
    const fromAssignment = await resolvePlanScope({ assignmentPath: fixture.assignmentPath }, fixture.root);

    expect(fromAssignment).toEqual(fromPair);
    expect(fromPair.harnessRoot).toBe(fixture.harness);
    expect(fromPair.workflowId).toBe(WORKFLOW_ID);
    expect(fromPair.planId).toBe(PLAN_ID);
    expect(fromPair.projectId).toBe(PROJECT_ID);
    expect(fromPair.planPath).toBe(fixture.planPath);
    expect(fromPair.worktreePath).toBe(fixture.worktreePath);
    expect(fromPair.workingBranch).toBe("feature/plan-a");
    expect(fromPair.sddDir).toBe(fixture.sddDir);

    // An unscoped Assignment (no `Prepare gate`, no plan pin) is refused.
    const unscoped = join(fixture.root, "unscoped-assignment.md");
    writeText(unscoped, "# Assignment — legacy\n\n**Workflow id**: wf-plana\n");
    expect(await errorCodeOf(() => resolvePlanScope({ assignmentPath: unscoped }, fixture.root))).toBe("coordination.assignment-invalid");
  });

  test("prepare pins the Assignment hash; a mutated Assignment invalidates the row", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);

    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(view.prepared?.assignment_path).toBe(fixture.assignmentPath);
    expect(view.prepared?.qa_gate).toBe("mandatory");
    expect(view.prepared?.findings_cleanup).toBe("zero-residual");
    expect(view.prepared?.assignment_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(view.revision).toBe(2); // prepare bumped it to 1, the fresh bind to 2
    expect(view.scope?.planPath).toBe(fixture.planPath);

    // The Assignment is the row's pin: editing it invalidates every later call.
    writeText(
      fixture.assignmentPath,
      `${readFileSync(fixture.assignmentPath, "utf8")}\nRewritten after prepare.\n`,
    );
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [] }},
    }),
      ),
    ).toBe("coordination.assignment-stale");
  });

  test("progress is revision-guarded, evidence-scoped and transition-checked", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);

    const evidence = join(fixture.sddDir, "evidence.txt");
    writeText(evidence, "proof\n");
    const outside = join(fixture.root, "outside.txt");
    writeText(outside, "not mine\n");
    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);

    // Stale revision: the row moved to revision 1 during prepare.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: 0,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [evidence] }},
    }),
      ),
    ).toBe("coordination.version-conflict");

    // Evidence outside the plan's own plan/SDD area is refused.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [outside] }},
    }),
      ),
    ).toBe("coordination.path-mismatch");

    // Missing evidence is refused.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [join(fixture.sddDir, "gone.txt")] }},
    }),
      ),
    ).toBe("coordination.evidence-stale");

    const progressed = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: {
        kind: "progress",
        progress: { status: "InReview", summary: "slice A implemented", evidence_paths: [evidence], track_branches: ["feature/plan-a"] } },
    });
    expect(progressed.outcome).toBe("progressed");
    const after = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(after.row.status).toBe("InReview");
    expect(after.revision).toBe(3); // prepare 1, fresh bind 2, progress 3
    const metadata = after.row.metadata as Record<string, unknown>;
    expect(metadata.track_branches).toEqual(["feature/plan-a"]);

    // The track branch may never be a snapshot branch or another plan's branch.
    for (const foreign of ["main", "feature/plan-b"]) {
      expect(
        await errorCodeOf(() =>
          mutatePlanCoordination({
            sessionPath: fixture.planSession,
            planId: PLAN_ID,
            expectedRevision: after.revision,
            operation: {
              kind: "progress",
              progress: { status: "Blocked", summary: "blocked", evidence_paths: [evidence], track_branches: [foreign] },
            },
          }),
        ),
        foreign,
      ).toBe("coordination.invalid-input");
    }

    const blocked = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: after.revision,
      operation: { kind: "progress", progress: { status: "Blocked", summary: "waiting on QC", evidence_paths: [evidence] }},
    });
    expect(blocked.outcome).toBe("progressed");
    const blockedView = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(blockedView.row.status).toBe("Blocked");
    // Blocked → InReview is not an allowed transition (Blocked resumes to InProgress).
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: blockedView.revision,
      operation: { kind: "progress", progress: { status: "InReview", summary: "resume out of order", evidence_paths: [evidence] }},
    }),
      ),
    ).toBe("coordination.invalid-transition");
  });

  test("a plan session can only address its own plan", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);

    expect(await errorCodeOf(() => readPlanCoordination(fixture.planSession, PEER_PLAN_ID, fixture.root))).toBe(
      "coordination.session-mismatch",
    );

    // A session file that is not an envelope at all is refused.
    const stray = join(fixture.root, "stray.json");
    writeJson(stray, { hello: "world" });
    expect(await errorCodeOf(() => readPlanCoordination(stray, PLAN_ID, fixture.root))).toBe("coordination.forbidden-field");
  });
});

describe("residual-ownership", () => {
  test("residual add/close touch only this plan's bucket and CAS on the register bytes", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await preparePlan(fixture, PEER_PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    await bindPlan(fixture, PEER_PLAN_ID);

    // Seed a sibling bucket: it must survive every write of this plan.
    writeJson(fixture.registerPath, {
      entries: {
        [PEER_PLAN_ID]: [{ ...residual("r-peer"), source_plan: PEER_PLAN_ID, registered_at: "2026-09-14" }],
      },
    });
    const peerBucketBefore = registerBucket(fixture, PEER_PLAN_ID);

    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(view.register_version).not.toBe("absent");

    const added = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [residual("r-1"), residual("r-2")] as never, expectedRegisterVersion: view.register_version },
    });
    expect(added.outcome).toBe("residual-added");
    const bucket = registerBucket(fixture, PLAN_ID);
    expect(bucket.map((entry) => entry.id)).toEqual(["r-1", "r-2"]);
    for (const entry of bucket) {
      expect(entry.source_plan).toBe(PLAN_ID);
      expect(entry.lifecycle_id).toBe(WORKFLOW_ID);
      expect(String(entry.registered_at)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(registerBucket(fixture, PEER_PLAN_ID)).toEqual(peerBucketBefore);

    // The register byte version moved; a stale CAS is refused.
    const afterAdd = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(afterAdd.register_version).not.toBe("absent");
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [residual("r-3")] as never, expectedRegisterVersion: "absent" },
    }),
      ),
    ).toBe("coordination.register-version-conflict");
    // A missing precondition is refused outright (never a blind write).
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [residual("r-3")] as never } as never,
    }),
      ),
    ).toBe("coordination.expected-version-required");

    const closed = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-close", entryId: "r-2", note: "fixed in slice A", expectedRegisterVersion: afterAdd.register_version },
    });
    expect(closed.outcome).toBe("residual-closed");
    const closedEntry = registerBucket(fixture, PLAN_ID)[1];
    expect(closedEntry.lifecycle).toBe("resolved");
    expect(String(closedEntry.closed_at)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(closedEntry.closure_note).toBe("fixed in slice A");
    expect(registerBucket(fixture, PEER_PLAN_ID)).toEqual(peerBucketBefore);

    // Closing twice, or closing a residual owned by another plan, is refused.
    const afterClose = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-close", entryId: "r-2", note: "again", expectedRegisterVersion: afterClose.register_version },
    }),
      ),
    ).toBe("coordination.invalid-transition");
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-close", entryId: "r-peer", note: "not mine", expectedRegisterVersion: afterClose.register_version },
    }),
      ),
    ).toBe("coordination.invalid-input");
  });

  test("two independent processes adding concurrently keep both register changes", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await preparePlan(fixture, PEER_PLAN_ID);
    const sessionA = (await bindPlan(fixture, PLAN_ID)).session_file;
    const sessionB = (await bindPlan(fixture, PEER_PLAN_ID)).session_file;

    const script = join(fixture.root, "child-add.ts");
    writeText(
      script,
      [
        `import { bindPlanSession, mutatePlanCoordination, readPlanCoordination } from ${JSON.stringify(
          join(import.meta.dir, "..", "src", "coordination.ts"),
        )};`,
        `import { createFsStore, setArtifactStore } from ${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))};`,
        "const [root, harness, planId, sessionPath, residualId] = process.argv.slice(2);",
        "setArtifactStore(createFsStore(harness));",
        "const resumed = await bindPlanSession({ resumePath: sessionPath, cwd: root });",
        "if (resumed.outcome !== \"resumed\") throw new Error(`bad resume: ${resumed.outcome}`);",
        "for (let attempt = 0; attempt < 8; attempt += 1) {",
        "  const view = await readPlanCoordination(sessionPath, planId, root);",
        "  try {",
        "    await mutatePlanCoordination({",
        "      sessionPath,",
        "      planId,",
        "      expectedRevision: view.revision,",
        "      operation: {",
        "        kind: \"residual-add\",",
        "        entries: [{ id: residualId, title: residualId, severity: \"low\", source: \"qa\", scope: \"engine\", decision: \"defer\", owner: \"@fullstack-dev\", target: null, tracking: null }] as never,",
        "        expectedRegisterVersion: view.register_version,",
        "      },",
        "    });",
        "    console.log(`added ${residualId}`);",
        "    process.exit(0);",
        "  } catch (error) {",
        "    if (error && error.code === \"coordination.register-version-conflict\") continue;",
        "    console.error(error);",
        "    process.exit(2);",
        "  }",
        "}",
        "console.error(\"exhausted retries\");",
        "process.exit(3);",
        "",
      ].join("\n"),
    );

    const children = [
      { planId: PLAN_ID, sessionPath: sessionA, residualId: "r-a" },
      { planId: PEER_PLAN_ID, sessionPath: sessionB, residualId: "r-b" },
    ].map((child) =>
      Bun.spawn([process.execPath, script, fixture.root, fixture.harness, child.planId, child.sessionPath, child.residualId], {
        cwd: fixture.root,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    const exits = await Promise.all(children.map((child) => child.exited));
    for (const child of children) {
      const message = await new Response(child.stderr).text();
      if (child.exitCode !== 0) console.error(`child ${String(child.pid)}: ${message}`);
      expect(child.exitCode, message).toBe(0);
    }

    // Both writers' changes survive: the register lock plus the byte-version CAS
    // serialize the two processes instead of letting one clobber the other.
    expect(registerBucket(fixture, PLAN_ID).map((entry) => entry.id)).toEqual(["r-a"]);
    expect(registerBucket(fixture, PEER_PLAN_ID).map((entry) => entry.id)).toEqual(["r-b"]);
  });
});
