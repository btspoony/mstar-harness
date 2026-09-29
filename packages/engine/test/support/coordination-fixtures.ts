import { expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bindPlanSession, mutatePlanCoordination, readPlanCoordination, type CoordinationResult } from "../../src/coordination.js";
import { initializeStore, openStore, type StoreContext } from "../../src/store-db.js";
import { CoordinationError } from "../../src/coordination-write.js";
import { claimLease } from "../../src/lease.js";
import { registerCatalogEntity } from "../../src/catalog.js";
import { createFsStore, setArtifactStore } from "../../src/store.js";

export const WORKFLOW_ID = "wf-plana";
export const PLAN_ID = "plan-a";
export const PEER_PLAN_ID = "plan-b";
export const PROJECT_ID = "proj-a";
/**
 * The deterministic local identity every fixture-bind acquires. A coordinator
 * envelope is never created from a generated id, so the fixtures state theirs.
 */
export const FIXTURE_COORDINATOR_ID = "fixture-coordinator";

export type Fixture = {
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

export const roots: string[] = [];

export function afterEachCleanup(): void {
  setArtifactStore(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}


export function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** A plan row in the legacy `validatePlanRow` shape (id/title/file/status). */
export function planRow(id: string, projectId: string | undefined, workingBranch?: string): Record<string, unknown> {
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
export function assignmentText(input: {
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
export function makeFixture(): Fixture {
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
    updated_at: "2026-09-15",
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

/**
 * A bounded real-time window. Only the S1 lock-ordering case uses it, and only
 * because the interleave it asserts is between two live lock acquisitions: a
 * finding has to land inside the window in which a handoff is in flight.
 */
export async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * The stable refusal code of a failed call. The scoped layer keeps the core
 * domain codes it does not own — a stale issue revision stays
 * `issue.revision-conflict`, a broken store stays `store.*` — instead of
 * rewrapping them in a coordination code, so the reader below accepts either
 * shape and still pins the exact expectation at the call site.
 */
export async function errorCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CoordinationError) return error.code;
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.includes(".")) return code;
    throw error;
  }
  throw new Error("expected the coordination call to fail");
}

/** Bind the lifecycle coordinator once per fixture with an explicitly acquired id. */
export async function ensureCoordinator(fixture: Fixture): Promise<string> {
  if (fixture.coordinatorSession === "") {
    const bound = await bindPlanSession({
      coordinator: true,
      workflowId: WORKFLOW_ID,
      harnessDir: fixture.harness,
      cwd: fixture.root,
      sessionId: FIXTURE_COORDINATOR_ID,
    });
    expect(bound.ok).toBe(true);
    expect(bound.operation).toBe("bind");
    fixture.coordinatorSession = bound.session_file;
  }
  return fixture.coordinatorSession;
}

/** Prepare one plan through the bound coordinator session (slice A fixture path). */
export async function preparePlan(fixture: Fixture, planId: string): Promise<CoordinationResult> {
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
export async function bindPlan(fixture: Fixture, planId: string): Promise<CoordinationResult> {
  const bound = await bindPlanSession({
    scope: { workflowId: WORKFLOW_ID, planId, harnessDir: fixture.harness },
    cwd: fixture.root,
  });
  if (planId === PLAN_ID) fixture.planSession = bound.session_file;
  else fixture.peerSession = bound.session_file;
  return bound;
}

/** Read-only resume of an already bound plan session. */
export async function resumePlan(fixture: Fixture, planId: string): Promise<CoordinationResult> {
  const sessionPath = planId === PLAN_ID ? fixture.planSession : fixture.peerSession;
  return bindPlanSession({ resumePath: sessionPath, cwd: fixture.root });
}

export type GitFixture = Fixture & { integrationPath: string; baseSha: string; planSha: string };

export function headOf(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/**
 * A fixture whose plan worktree is a real Git checkout on the plan's own branch
 * and whose snapshot names a real integration checkout, so the handoff and
 * integration proofs run against real objects instead of path stubs.
 */
export async function gitFixture(): Promise<GitFixture> {
  const fixture = makeFixture() as GitFixture;
  // The findings cleanup gate consumes the issue store (G2a): handoff-level
  // fixtures run against an active store whose catalog has this workflow's
  // plan rows, so prepare and the lifecycle gate both see committed authority.
  await storeBacked(fixture, [PLAN_ID, PEER_PLAN_ID]);
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

export function snapshotOf(fixture: Fixture): Record<string, unknown> {
  return readJson(fixture.snapshotPath);
}

export function planRowOf(fixture: Fixture, planId: string): Record<string, unknown> {
  const rows = snapshotOf(fixture).plans;
  if (!Array.isArray(rows)) throw new Error("snapshot has no plans array");
  const row = rows.find((entry) => entry?.id === planId);
  if (row === undefined) throw new Error(`snapshot has no row ${planId}`);
  return row;
}

/** Direct fixture edits stand in for the session/status writes a live run does. */
export function updatePlanRow(
  fixture: Fixture,
  planId: string,
  patch: (row: Record<string, unknown>) => Record<string, unknown>,
): void {
  const snapshot = snapshotOf(fixture);
  const rows = snapshot.plans;
  if (!Array.isArray(rows)) throw new Error("snapshot has no plans array");
  writeJson(fixture.snapshotPath, { ...snapshot, plans: rows.map((row) => (row.id === planId ? patch(row) : row)) });
}

export function claimExecutionLease(fixture: Fixture, planId: string, sessionPath: string): void {
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

export function handoffFields(row: Record<string, unknown>): Record<string, unknown> {
  const coordination = row.coordination;
  if (coordination === null || typeof coordination !== "object" || !("handoff" in coordination)) {
    throw new Error("row has no coordination.handoff");
  }
  return coordination.handoff as Record<string, unknown>;
}

export function leaseHolder(row: Record<string, unknown>): string | undefined {
  const lease = row.execution_lease;
  if (lease === null || typeof lease !== "object" || !("holder" in lease)) return undefined;
  return typeof lease.holder === "string" ? lease.holder : undefined;
}

/** Handoff evidence the way a plan session submits it: paths and revisions. */
export type HandoffEvidence = {
  source_sha: string;
  review_base: string;
  review_head: string;
  qc: { decision: string; reports: string[]; consolidated: string };
  qa: { gate: string; decision: string; report: string };
};

/** Review/QA evidence inside the plan's own SDD area. */
export function handoffEvidenceOf(fixture: GitFixture, sourceSha: string): HandoffEvidence {
  const reports = [join(fixture.sddDir, "review", "qc1.md"), join(fixture.sddDir, "review", "qc2.md")];
  for (const path of reports) writeText(path, "# qc report\n");
  const consolidated = join(fixture.sddDir, "review", "qc.md");
  const qa = join(fixture.sddDir, "qa.md");
  writeText(consolidated, "# consolidated qc\n");
  writeText(qa, "# qa pass\n");
  return {
    source_sha: sourceSha,
    review_base: fixture.baseSha,
    review_head: sourceSha,
    qc: { decision: "Approve", reports, consolidated },
    qa: { gate: "mandatory", decision: "pass", report: qa },
  };
}

export function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (value === null || typeof value !== "object") throw new Error(`${key} is not an object`);
  return value as Record<string, unknown>;
}

/** The `sha256` of a stored evidence ref, or a failed assertion. */
export function digestOf(ref: unknown): string {
  if (ref === null || typeof ref !== "object" || !("sha256" in ref) || typeof ref.sha256 !== "string") {
    throw new Error("evidence ref has no sha256");
  }
  return ref.sha256;
}

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function handoffCall(fixture: Fixture, evidence: HandoffEvidence): Promise<CoordinationResult> {
  const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
  return mutatePlanCoordination({
    sessionPath: fixture.planSession,
    planId: PLAN_ID,
    expectedRevision: view.revision,
    operation: { kind: "handoff", evidence } as never,
  });
}

export async function coordinatorCall(
  fixture: Fixture,
  planId: string,
  operation: Record<string, unknown>,
  /** A deliberately stale id, to prove the engine re-checks the named handoff. */
  namedHandoffId?: string,
): Promise<CoordinationResult> {
  const view = await readPlanCoordination(fixture.coordinatorSession, planId, fixture.root);
  const handoffId = namedHandoffId ?? view.row?.coordination?.handoff?.id;
  return mutatePlanCoordination({
    sessionPath: fixture.coordinatorSession,
    planId,
    expectedRevision: view.revision,
    // The CLI sends the id it read with the operation; the engine re-checks it
    // under its own lock, so every coordinator transition names one.
    operation: (handoffId === undefined ? operation : { handoffId, ...operation }) as never,
  });
}
/** A single-row standalone development workflow with a real feature checkout and
 * delivery anchors only (no integration worktree or branch.integration).
 */
export async function standaloneGitFixture(): Promise<GitFixture> {
  const fixture = makeFixture() as GitFixture;
  await storeBacked(fixture, [PLAN_ID]);
  fixture.baseSha = headOf(fixture.root);
  fixture.integrationPath = join(fixture.root, "wt-integration-unused");
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  git(["worktree", "add", "-q", "-b", "feature/plan-a", fixture.worktreePath], fixture.root);
  writeText(join(fixture.worktreePath, "standalone.txt"), "standalone slice\n");
  git(["add", "-A"], fixture.worktreePath);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat: standalone"], fixture.worktreePath);
  fixture.planSha = headOf(fixture.worktreePath);
  writeJson(join(fixture.harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-15",
    workflows: [{ id: WORKFLOW_ID, status: "running", type: "plan", started_at: "2026-09-15T00:00:00Z", dir: `workflows/${WORKFLOW_ID}` }],
  });
  writeJson(fixture.snapshotPath, {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    delivery_kind: "development",
    status: "running",
    started_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    branch: { source: "feature/plan-a", target: "main" },
    plans: [planRow(PLAN_ID, PROJECT_ID, "feature/plan-a")],
  });
  return fixture;
}

/** Accepted standalone handoff: the state route-specific complete starts from. */
export async function acceptedStandaloneFixture(): Promise<GitFixture> {
  const fixture = await standaloneGitFixture();
  await preparePlan(fixture, PLAN_ID);
  await bindPlan(fixture, PLAN_ID);
  claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
  updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
  await handoffCall(fixture, handoffEvidenceOf(fixture, fixture.planSha));
  await coordinatorCall(fixture, PLAN_ID, { kind: "accept" });
  return fixture;
}

/** Legacy wrong-source shape: registered source equals target while the handoff names the feature branch. */
export async function wrongSourceLegacyGitFixture(withPr = false): Promise<GitFixture> {
  const fixture = await standaloneGitFixture();
  const snapshot = snapshotOf(fixture);
  snapshot.branch = { source: "main", target: "main" };
  if (withPr) {
    snapshot.delivery = {
      compound: { outcome: "skipped", reason: "fixture probe" },
      pr: { repo: "btspoony/mstar-harness", head: "feature/plan-a", target: "main" },
      merge: { provider: "github", evidence: "PR #999 verified merged" },
    };
  }
  writeJson(fixture.snapshotPath, snapshot);
  return fixture;
}

export async function wrongSourceAcceptedFixture(withPr = false): Promise<GitFixture> {
  const fixture = await wrongSourceLegacyGitFixture(withPr);
  await preparePlan(fixture, PLAN_ID);
  await bindPlan(fixture, PLAN_ID);
  claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
  updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
  await handoffCall(fixture, handoffEvidenceOf(fixture, fixture.planSha));
  await coordinatorCall(fixture, PLAN_ID, { kind: "accept" });
  return fixture;
}

/** A fixture handed off and accepted: the state integration starts from. */
export async function acceptedFixture(): Promise<GitFixture> {
  const fixture = await gitFixture();
  await preparePlan(fixture, PLAN_ID);
  await bindPlan(fixture, PLAN_ID);
  claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
  updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
  await handoffCall(fixture, handoffEvidenceOf(fixture, fixture.planSha));
  await coordinatorCall(fixture, PLAN_ID, { kind: "accept" });
  return fixture;
}

/**
 * Put a real catalog store behind the fixture's harness. The store context is
 * the harness dir the scoped calls themselves resolve (`fixture.harness`), so
 * the pin writer and the pin readers address the same database.
 */
export async function storeBacked(fixture: Fixture, plans: string[] = [PLAN_ID]): Promise<StoreContext> {
  const context: StoreContext = { harnessDir: fixture.harness };
  const handle = await initializeStore(context);
  handle.close();
  for (const [index, planId] of plans.entries()) {
    await registerCatalogEntity(
      context,
      { kind: "plan", id: planId, title: `Plan ${planId}`, rootKind: "plans", relativePath: `${planId}.md` },
      { operationId: `reg-${planId}-${index}`, actor: "project-manager" },
    );
  }
  // Seal IMMEDIATELY, while the writes above are still the most recent store
  // activity: the read-only open that follows can otherwise land in the
  // documented window (see `sealStoreForReaders` — this runtime checkpoints and
  // removes a closed handle's empty sidecars when it collects the handle, and a
  // first read-only open of that quiesced WAL shape fails `store.corrupt` /
  // SQLITE_CANTOPEN). Taking the read here keeps the fixture deterministic for
  // every test that reads the store later, instead of leaving it to allocation
  // timing.
  await sealStoreForReaders(fixture);
  return context;
}

/**
 * Read the fixture store once in THIS process before a child process reads it.
 * Workflow-boundary difference, not an engine behavior: under `bun test` a
 * child's first read-only open of a store whose last writer ran in the runner
 * intermittently fails `store.corrupt` (driver `SQLITE_CANTOPEN`), while the
 * same file opens fine from a plain-script parent (task-3 report §observations).
 * A reader in this process leaves the file readable for the children below, so
 * the child under test exercises the case it was written for and still opens
 * the store query-only through the engine.
 */
export async function sealStoreForReaders(fixture: Fixture): Promise<void> {
  const handle = await openStore({ harnessDir: fixture.harness }, "read");
  handle.close();
}

/**
 * An issue capture entry as the scoped `residual-add` operation now takes it
 * (G2a): the core `CaptureInput` minus `projectId` — the plan scope supplies
 * the project. No disposition is recorded at capture time (contract §6).
 */
export function finding(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: `Finding ${id}`,
    kind: "review-obligation",
    severity: "medium",
    impact: "blocks plan approval",
    acceptance: "fixed or explicitly dispositioned",
    owner: "@fullstack-dev",
    sourceIdentity: `qc:report:${id}`,
    rootCauseKey: `root-cause:${id}`,
    acceptanceKey: "fix-verified",
    occurrenceKey: `occ-${id}`,
    sourceKind: "qc-report",
    location: "packages/engine",
    observedBehavior: `finding ${id} observed`,
    evidence: ["review/qc1.md"],
    discoveredAt: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}
/** The open issues the issue store links to a plan (the authority the gate reads). */
export async function linkedOpenIssues(fixture: Fixture, planId: string): Promise<Array<{ id: string; severity: string; disposition: string }>> {
  const handle = await openStore({ harnessDir: fixture.harness }, "read");
  try {
    return handle.db
      .prepare(
        "select issues.id as id, issues.severity as severity, issues.disposition as disposition from issues " +
          "join provenance on provenance.issue_id = issues.id and provenance.kind = 'plan' and provenance.target = ? " +
          "where issues.disposition = 'open' order by issues.id asc",
      )
      .all(planId) as Array<{ id: string; severity: string; disposition: string }>;
  } finally {
    handle.close();
  }
}
