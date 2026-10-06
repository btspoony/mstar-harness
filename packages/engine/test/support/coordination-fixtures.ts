/**
 * Shared fixtures for the coordinator-only coordination suites.
 *
 * One workflow coordinator drives every row of its workflow. There is no
 * plan-PM session, no sealed Assignment, no handoff/accept/return chain and no
 * per-plan lease: `prepare` is ordinary revisable configuration, `progress`
 * reports states and `complete` carries the QC/QA evidence for the declared
 * delivery route.
 *
 * Fixture discipline: the temp root is `realpathSync`-ed before any path is
 * derived from it (the engine compares real Git worktree roots with
 * lexically-resolved harness paths), and every plan id is a safe path component.
 */
import { expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bindPlanSession,
  mutatePlanCoordination,
  readPlanCoordination,
  type CompletionEvidence,
  type CoordinationResult,
  type PlanPrepareConfig,
  type PlanProgress,
} from "../../src/coordination.js";
import { initializeStore, openStore, type StoreContext } from "../../src/store-db.js";
import { CoordinationError } from "../../src/coordination-write.js";
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
  peerSddDir: string;
  worktreePath: string;
  peerWorktreePath: string;
  snapshotPath: string;
  registerPath: string;
  /** Engine-generated envelope path, filled in by the first coordinator bind. */
  coordinatorSession: string;
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

/**
 * A plan row in the `validatePlanRow` shape (id/title/file/status). A row
 * records its own worktree/branch scope as ordinary metadata — that is the
 * only place the engine reads scope facts from, and a coordinator may revise
 * it through ordinary `prepare`.
 */
export function planRow(id: string, projectId: string | undefined, workingBranch?: string, worktreePath?: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (projectId !== undefined) metadata.project_id = projectId;
  if (workingBranch !== undefined) metadata.working_branch = workingBranch;
  if (worktreePath !== undefined) metadata.worktree_path = worktreePath;
  return {
    id,
    plan_id: id,
    title: `Plan ${id}`,
    file: `.mstar/plans/${id}.md`,
    status: "Todo",
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
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
  const peerSddDir = join(harness, "sdd", PEER_PLAN_ID);
  const worktreePath = join(root, "wt-plana");
  const peerWorktreePath = join(root, "wt-planb");

  writeText(planPath, "# plan a\n");
  writeText(peerPlanPath, "# plan b\n");
  mkdirSync(sddDir, { recursive: true });
  mkdirSync(peerSddDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(peerWorktreePath, { recursive: true });

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
    plans: [
      planRow(PLAN_ID, PROJECT_ID, "feature/plan-a", worktreePath),
      planRow(PEER_PLAN_ID, PROJECT_ID, "feature/plan-b", peerWorktreePath),
    ],
  });

  setArtifactStore(createFsStore(harness));

  return {
    root,
    harness,
    workflowDir,
    planPath,
    peerPlanPath,
    sddDir,
    peerSddDir,
    worktreePath,
    peerWorktreePath,
    snapshotPath,
    registerPath,
    coordinatorSession: "",
  };
}

/** A bounded real-time window for the interleavings two live writers assert. */
export async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** The stable `code` a typed engine refusal carries, or `undefined`. */
export function failureCode(error: unknown): string | undefined {
  if (error instanceof CoordinationError) return error.code;
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
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
    const code = failureCode(error);
    if (code !== undefined && code.includes(".")) return code;
    throw error;
  }
  throw new Error("expected the coordination call to fail");
}

/**
 * The thrown error of a call that must fail, so a case can assert on the
 * refusal's own fields (code AND details) without a second call site.
 */
export async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the call to fail");
}

/** Bind the one workflow coordinator once per fixture with an explicit id. */
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

/**
 * One ordinary coordinator operation on one explicitly addressed row. The
 * revision is read first (the way `mstar plan show` hands it to the caller)
 * unless the case supplies a deliberately stale one.
 */
export async function coordinatorCall(
  fixture: Fixture,
  planId: string,
  operation: Record<string, unknown>,
  expectedRevision?: number,
): Promise<CoordinationResult> {
  const sessionPath = await ensureCoordinator(fixture);
  const revision =
    expectedRevision ?? (await readPlanCoordination(sessionPath, planId, fixture.root)).revision;
  return mutatePlanCoordination({
    sessionPath,
    planId,
    expectedRevision: revision,
    operation: operation as never,
  });
}

/** Ordinary revisable execution configuration for the addressed row. */
export function prepareCall(fixture: Fixture, planId: string, config?: PlanPrepareConfig): Promise<CoordinationResult> {
  return coordinatorCall(fixture, planId, config === undefined ? { kind: "prepare" } : { kind: "prepare", config });
}

/** The coordinator's ordinary state report for one row. */
export function progressCall(fixture: Fixture, planId: string, progress: PlanProgress): Promise<CoordinationResult> {
  return coordinatorCall(fixture, planId, { kind: "progress", progress });
}

/** Direct completion with the consumer-visible evidence and optional merge result. */
export function completeCall(
  fixture: Fixture,
  planId: string,
  evidence: CompletionEvidence,
  integration?: { base_sha: string; result_sha: string },
): Promise<CoordinationResult> {
  return coordinatorCall(fixture, planId, { kind: "complete", evidence, ...(integration === undefined ? {} : { integration }) });
}

export type GitFixture = Fixture & { integrationPath: string; baseSha: string; planSha: string };

export function headOf(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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

/** Direct fixture edits stand in for the writes a live run does. */
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

/** The row's own recorded scope, where the ordinary operations read it from. */
export function metadataOf(row: Record<string, unknown>): Record<string, unknown> {
  const metadata = row.metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("row has no metadata object");
  }
  return metadata as Record<string, unknown>;
}

/** The plan's own recorded completion, the shape direct `complete` writes. */
export function completionOf(row: Record<string, unknown>): Record<string, unknown> {
  const coordination = row.coordination;
  if (coordination === null || typeof coordination !== "object" || !("completion" in coordination)) {
    throw new Error("row has no coordination.completion");
  }
  return coordination.completion as Record<string, unknown>;
}

/** The plan's own recorded prepare configuration. */
export function preparedOf(row: Record<string, unknown>): Record<string, unknown> {
  const coordination = row.coordination;
  if (coordination === null || typeof coordination !== "object" || !("prepared" in coordination)) {
    throw new Error("row has no coordination.prepared");
  }
  return coordination.prepared as Record<string, unknown>;
}

/**
 * Review/QA evidence inside the plan's own SDD area. It carries the paths a
 * caller submits; the engine hashes them into recorded `EvidenceRef`s.
 */
export function completionEvidenceOf(
  fixture: Fixture,
  sourceSha: string,
  overrides: Partial<CompletionEvidence> = {},
): CompletionEvidence {
  const sddDir = overrides.source_sha === undefined ? fixture.sddDir : fixture.sddDir;
  const reports = [join(sddDir, "review", "qc1.md"), join(sddDir, "review", "qc2.md")];
  for (const path of reports) writeText(path, "# qc report\n");
  const consolidated = join(sddDir, "review", "qc.md");
  const qa = join(sddDir, "qa.md");
  writeText(consolidated, "# consolidated qc\n");
  writeText(qa, "# qa pass\n");
  return {
    source_sha: sourceSha,
    review_base: fixture.baseSha,
    review_head: sourceSha,
    qc: { decision: "Approve", reports, consolidated },
    qa: { gate: "mandatory", decision: "pass", report: qa },
    ...overrides,
  };
}

export function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (value === null || typeof value !== "object") throw new Error(`${key} is not an object`);
  return value as Record<string, unknown>;
}

/** The array a record member holds, or a failed assertion. */
export function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${key} is not an array`);
  return value;
}

/* ------------------------------------------------------------------------ *
 * Real Git fixtures — one per delivery route
 * ------------------------------------------------------------------------ */

/**
 * An iteration fixture with two rows: a real feature checkout per row and a
 * real integration checkout whose recorded merge the iteration route verifies.
 */
export async function gitFixture(): Promise<GitFixture> {
  const fixture = makeFixture() as GitFixture;
  await storeBacked(fixture, [PLAN_ID, PEER_PLAN_ID]);
  fixture.baseSha = headOf(fixture.root);
  fixture.integrationPath = join(fixture.root, "wt-integration");
  for (const [path, branch] of [
    [fixture.worktreePath, "feature/plan-a"],
    [fixture.peerWorktreePath, "feature/plan-b"],
  ] as const) {
    rmSync(path, { recursive: true, force: true });
    git(["worktree", "add", "-q", "-b", branch, path], fixture.root);
  }
  git(["worktree", "add", "-q", "-b", "integration/plan-a", fixture.integrationPath], fixture.root);
  writeText(join(fixture.worktreePath, "slice.txt"), "slice A\n");
  git(["add", "-A"], fixture.worktreePath);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat: slice A"], fixture.worktreePath);
  fixture.planSha = headOf(fixture.worktreePath);
  writeJson(fixture.snapshotPath, {
    ...readJson(fixture.snapshotPath),
    branch: { base: "main", integration: "integration/plan-a" },
    integration_worktree_path: fixture.integrationPath,
  });
  return fixture;
}

/**
 * A single-row standalone development workflow: a real feature checkout and
 * delivery anchors only (no integration worktree or `branch.integration`).
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
    plans: [planRow(PLAN_ID, PROJECT_ID, "feature/plan-a", fixture.worktreePath)],
  });
  return fixture;
}

/**
 * A single-row report-only workflow: its registered completion policy and its
 * recorded fulfilment exist, its source facts are provenance only, and it has
 * no integration anchors to verify.
 */
export async function reportOnlyGitFixture(): Promise<GitFixture> {
  const fixture = await standaloneGitFixture();
  const snapshot = snapshotOf(fixture);
  snapshot.delivery_kind = "verification/report-only";
  snapshot.completion_policy = "acceptance report";
  snapshot.delivery = { completion: { policy: "acceptance report", evidence: "report.md" } };
  writeJson(fixture.snapshotPath, snapshot);
  return fixture;
}

/** The state an iteration row's `complete` starts from: real source and merge. */
export async function acceptedFixture(): Promise<GitFixture> {
  const fixture = await gitFixture();
  await prepareCall(fixture, PLAN_ID);
  await progressCall(fixture, PLAN_ID, { status: "InProgress" });
  await progressCall(fixture, PLAN_ID, { status: "InReview" });
  return fixture;
}

/** The state a standalone development row's `complete` starts from. */
export async function acceptedStandaloneFixture(): Promise<GitFixture> {
  const fixture = await standaloneGitFixture();
  await prepareCall(fixture, PLAN_ID);
  await progressCall(fixture, PLAN_ID, { status: "InProgress" });
  await progressCall(fixture, PLAN_ID, { status: "InReview" });
  return fixture;
}

/* ------------------------------------------------------------------------ *
 * Store-backed fixtures
 * ------------------------------------------------------------------------ */

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
 * An issue capture entry as the coordinator `residual-add` operation takes it:
 * the core `CaptureInput` minus `projectId` — the plan scope supplies the
 * project. No disposition is recorded at capture time.
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
