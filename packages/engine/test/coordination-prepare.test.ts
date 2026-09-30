/**
 * Prepare workflow amendment and prepare coordinator recovery families.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
  amendPrepareWorkflow,
  bindPlanSession,
  recoverPrepareCoordinator,
  replaceCoordinatedArtifact,
  setPrepareRecoveryEnvelopeGapForTest,
  showPrepareCoordinatorRecovery,
  showPrepareWorkflow,
  type PrepareCoordinatorRecoveryView,
  type PrepareWorkflowPatch,
  type PrepareWorkflowResult,
} from "../src/coordination.js";
import { initializeExecutionAuthority } from "../src/execution-store.js";
import { initializeStore } from "../src/store-db.js";
import { CoordinationError, readArtifactBytes } from "../src/coordination-write.js";
import { registerWorkflow } from "../src/status.js";
import { createFsStore, setArtifactStore, type ArtifactDoc, type ArtifactRef, type ArtifactStore } from "../src/store.js";
import { stableJson, writeWorkflowSnapshot, type WorkflowSnapshot } from "../src/workflow.js";
import {
  FIXTURE_COORDINATOR_ID,
  PROJECT_ID,
  afterEachCleanup,
  git,
  planRow,
  readJson,
  sha256OfFile,
  writeJson,
  writeText,
  roots,
} from "./support/coordination-fixtures.js";

afterEach(() => afterEachCleanup());
/* ------------------------------------------------------------------ *
 * Prepare workflow amendment — the guarded, coordinator-authenticated
 * Prepare-stage amendment contract § Admission and mutation. Every case drives
 * the real engine against a temporary Git repository, a genuine coordinator
 * bind, a real integration worktree and a reviewed compass, and asserts the
 * protected bytes rather than implementation text.
 * ------------------------------------------------------------------ */

const PREPARE_WORKFLOW = "wf-prepare";
const PREPARE_PEER = "wf-peer";
const PREPARE_ROW = "plan-prepare";
const PREPARE_APPEND = "plan-append";
const PREPARE_UNREVIEWED = "plan-unreviewed";
const PREPARE_SPEC = "amendment-contract.md";
const PREPARE_INTEGRATION_BRANCH = "integration/wf-prepare";

type PrepareFixture = {
  root: string;
  harness: string;
  workflowDir: string;
  snapshotPath: string;
  statusPath: string;
  compassPath: string;
  integrationPath: string;
  peerSnapshotPath: string;
  planDir: string;
  specPath: string;
  /** Filled in by the first coordinator bind (the engine picks the path). */
  coordinatorSession: string;
};

/** A plan markdown carrying the headers the amendment cross-checks. */
function preparePlanMarkdown(input: { id: string; workingBranch: string; mainBranch?: string }): string {
  return [
    `# Plan ${input.id}`,
    "",
    `**plan_id:** ${input.id}`,
    "**Status:** Todo",
    `**Main worktree branch:** ${input.mainBranch ?? "main"}`,
    `**Working branch:** ${input.workingBranch}`,
    "",
    "Body.",
    "",
  ].join("\n");
}

/**
 * A Prepare lifecycle that the amendment is meant to serve: one Todo row with
 * no coordination state, `phase-1-prepare`, a reviewed compass declaring two
 * plans, a real distinct integration checkout, and a sibling workflow whose
 * bytes must never move.
 */
function makePrepareFixture(): PrepareFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-prepare-amend-")));
  roots.push(root);
  git(["init", "-q", "-b", "main"], root);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], root);

  const harness = join(root, ".mstar");
  const workflowDir = join(harness, "workflows", PREPARE_WORKFLOW);
  const snapshotPath = join(workflowDir, "snapshot.json");
  const statusPath = join(harness, "status.json");
  const compassPath = join(harness, "iterations", PREPARE_WORKFLOW, "delivery-compass.md");
  const integrationPath = join(root, "wt-integration");
  const peerSnapshotPath = join(harness, "workflows", PREPARE_PEER, "snapshot.json");
  const planDir = join(harness, "plans");
  const specPath = join(harness, "specs", PREPARE_SPEC);

  for (const id of [PREPARE_ROW, PREPARE_APPEND, PREPARE_UNREVIEWED]) {
    writeText(join(planDir, `${id}.md`), preparePlanMarkdown({ id, workingBranch: `feature/${id}` }));
  }
  writeText(specPath, "# primary spec\n");
  writeText(
    compassPath,
    [
      "---",
      `iteration_id: ${PREPARE_WORKFLOW}`,
      "status: locked",
      "iteration_base_branch: main",
      `spec_integration_branch: ${PREPARE_INTEGRATION_BRANCH}`,
      "target_branch: main",
      "plans:",
      `  - ${PREPARE_ROW}`,
      `  - ${PREPARE_APPEND}`,
      "---",
      "",
      "# Compass",
      "",
    ].join("\n"),
  );
  // The reviewed integration checkout: a real, distinct checkout on the
  // workflow's own integration branch.
  git(["worktree", "add", "-q", "-b", PREPARE_INTEGRATION_BRANCH, integrationPath], root);

  writeJson(statusPath, {
    version: 2,
    updated_at: "2026-09-16",
    workflows: [
      {
        id: PREPARE_WORKFLOW,
        status: "running",
        type: "iteration",
        started_at: "2026-09-16",
        dir: `workflows/${PREPARE_WORKFLOW}`,
      },
      {
        id: PREPARE_PEER,
        status: "running",
        type: "iteration",
        started_at: "2026-09-16",
        dir: `workflows/${PREPARE_PEER}`,
      },
    ],
  });
  writeJson(snapshotPath, {
    schema_version: 1,
    id: PREPARE_WORKFLOW,
    type: "iteration",
    status: "running",
    phase: "phase-1-prepare",
    started_at: "2026-09-16",
    updated_at: "2026-09-16",
    compass_ref: `iterations/${PREPARE_WORKFLOW}/delivery-compass.md`,
    branch: { base: "main", integration: PREPARE_INTEGRATION_BRANCH, target: "main" },
    execution_policy: { plan_parallelism: "serial", worktree_mode: "required" },
    plans: [planRow(PREPARE_ROW, PROJECT_ID, `feature/${PREPARE_ROW}`)],
  });
  writeJson(peerSnapshotPath, {
    schema_version: 1,
    id: PREPARE_PEER,
    type: "iteration",
    status: "running",
    phase: "phase-1-prepare",
    started_at: "2026-09-16",
    updated_at: "2026-09-16",
    plans: [planRow("plan-peer", PROJECT_ID)],
  });

  setArtifactStore(createFsStore(harness));
  return {
    root,
    harness,
    workflowDir,
    snapshotPath,
    statusPath,
    compassPath,
    integrationPath,
    peerSnapshotPath,
    planDir,
    specPath,
    coordinatorSession: "",
  };
}

/** The authoritative snapshot document, with its row array narrowed. */
function prepareSnapshotOf(fixture: PrepareFixture): { plans: Array<Record<string, unknown>> } & Record<string, unknown> {
  const doc = readJson(fixture.snapshotPath);
  if (!Array.isArray(doc.plans)) throw new Error("prepare fixture snapshot has no plans array");
  return doc as { plans: Array<Record<string, unknown>> } & Record<string, unknown>;
}

/** Bind the lifecycle coordinator once per fixture with an explicitly acquired id. */
async function ensurePrepareCoordinator(fixture: PrepareFixture): Promise<string> {
  if (fixture.coordinatorSession === "") {
    const bound = await bindPlanSession({
      coordinator: true,
      workflowId: PREPARE_WORKFLOW,
      harnessDir: fixture.harness,
      cwd: fixture.root,
      sessionId: FIXTURE_COORDINATOR_ID,
    });
    expect(bound.ok).toBe(true);
    fixture.coordinatorSession = bound.session_file;
  }
  return fixture.coordinatorSession;
}

/** The workflow-level view (`show-prepare`) through a coordinator envelope. */
function prepareViewOf(fixture: PrepareFixture, sessionPath = fixture.coordinatorSession): Promise<PrepareWorkflowResult> {
  return showPrepareWorkflow({ sessionPath, cwd: fixture.root });
}

/** Amend with the tokens a fresh view reports (the reviewed-token route). */
async function amendPrepare(fixture: PrepareFixture, patch: unknown): Promise<PrepareWorkflowResult> {
  const view = await prepareViewOf(fixture);
  return amendWith(fixture, patch, { snapshotVersion: view.view.snapshotVersion, compassVersion: view.view.compassVersion });
}

/** Amend with the exact tokens the caller already holds. */
function amendWith(
  fixture: PrepareFixture,
  patch: unknown,
  tokens: { snapshotVersion: string; compassVersion: string; sessionPath?: string; cwd?: string },
): Promise<PrepareWorkflowResult> {
  return amendPrepareWorkflow({
    sessionPath: tokens.sessionPath ?? fixture.coordinatorSession,
    cwd: tokens.cwd ?? fixture.root,
    expectedSnapshotVersion: tokens.snapshotVersion,
    expectedCompassVersion: tokens.compassVersion,
    patch: patch as unknown as PrepareWorkflowPatch,
  });
}

/** The refusal code and details of a call that must refuse. */
async function prepareRefusalOf(run: () => Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> {
  const failure = await failureOf(run);
  if (failure instanceof CoordinationError) return { code: failure.code, details: failure.details };
  throw failure;
}

/** The error any failing call throws (`registerWorkflow` throws a plain Error). */
async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the call to fail");
}

/**
 * Activate an instrument through the REAL local store, and return it. Scoped
 * coordination is served only by the store `createFsStore` created: an injected
 * foreign store is wrapped by `guardedInjectedStore` and keeps no `root` claim,
 * so `localStore` refuses it (`coordination.local-store-required`) before the
 * instrument's ports are ever consulted. An instrument that must be reached
 * through the coordination surface therefore installs its ports — and its
 * claimed root, the consultation a window can trigger on — on that same
 * instance, instead of standing in for it. The instrument receives the
 * ORIGINAL ports as its `inner`, so its pass-through calls cannot recurse into
 * itself.
 */
function instrumentLocalStore<T extends ArtifactStore & { root: string }>(
  harness: string,
  build: (inner: ArtifactStore & { root: string }) => T,
): T {
  const local = createFsStore(harness);
  const originalPut = local.put;
  const originalGet = local.get;
  const inner: ArtifactStore & { root: string } = {
    root: local.root,
    put: (doc) => originalPut(doc),
    get: <R>(ref: ArtifactRef) => originalGet<R>(ref),
  };
  const instrument = build(inner);
  local.put = (doc) => instrument.put(doc);
  local.get = <R>(ref: ArtifactRef) => instrument.get<R>(ref);
  Object.defineProperty(local, "root", { configurable: true, get: () => instrument.root });
  setArtifactStore(local);
  return instrument;
}

/**
 * A store double standing in for a harness where a competing writer is active.
 *
 * A competing writer reaches the snapshot the moment the write lock is free, so
 * a version read taken *after* the critical section can name that writer's
 * commit instead of this call's. The double publishes its own valid version of
 * the document this call committed at the engine's next store consultation once
 * the commit is on disk and the lockdir is gone — the earliest point the engine
 * itself hands control back after the commit. `publishCompetitor` drives the
 * same commit explicitly, so a case asserts which commit the returned token
 * names without depending on when the engine consults the store again.
 */
class CompetingCommitStore implements ArtifactStore {
  /** Byte version of the snapshot this call committed. */
  commitVersion = "";
  /** Byte version of the competing commit (empty until it lands). */
  competingVersion = "";
  private committed: Record<string, unknown> | undefined;
  private published = false;

  constructor(
    private readonly inner: ArtifactStore & { root: string },
    private readonly snapshotPath: string,
    private readonly lockDir: string,
    private readonly competitorStamp: string,
  ) {}

  get root(): string {
    this.publish();
    return this.inner.root;
  }

  async put(doc: ArtifactDoc): Promise<void> {
    await this.inner.put(doc);
    if (doc.kind !== "snapshot") return;
    this.committed = doc.payload as Record<string, unknown>;
    this.commitVersion = readArtifactBytes(this.snapshotPath)?.version ?? "";
  }

  async get<T = unknown>(ref: ArtifactRef): Promise<T | undefined> {
    return this.inner.get<T>(ref);
  }

  /** Commit the competitor's version now — the writer that took the free lock. */
  publishCompetitor(): string {
    this.publish();
    return this.competingVersion;
  }

  private publish(): void {
    // The lock is the competitor's only gate: while this call holds it no other
    // writer can commit, so only a free lock is the window.
    if (this.committed === undefined || this.published || existsSync(this.lockDir)) return;
    this.published = true;
    writeFileSync(
      this.snapshotPath,
      `${JSON.stringify({ ...this.committed, updated_at: this.competitorStamp }, null, 2)}\n`,
    );
    this.competingVersion = readArtifactBytes(this.snapshotPath)?.version ?? "";
  }
}

/** Every protected artifact one refused amendment must leave untouched. */
function protectedBytes(fixture: PrepareFixture): Record<string, string> {
  return {
    snapshot: readFileSync(fixture.snapshotPath, "utf8"),
    status: readFileSync(fixture.statusPath, "utf8"),
    compass: readFileSync(fixture.compassPath, "utf8"),
    peer: readFileSync(fixture.peerSnapshotPath, "utf8"),
    session: readFileSync(fixture.coordinatorSession, "utf8"),
  };
}

/** One plan append carrying this workflow's own references. */
function prepareAppendOf(
  fixture: PrepareFixture,
  id: string,
  entry: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: `Plan ${id}`,
    file: join(fixture.planDir, `${id}.md`),
    metadata: {
      primary_spec: fixture.specPath,
      spec_refs: [fixture.specPath],
      iteration_compass: fixture.compassPath,
      iteration_refs: [fixture.compassPath],
      working_branch: `feature/${id}`,
      spec_integration_branch: PREPARE_INTEGRATION_BRANCH,
      merge_target: PREPARE_INTEGRATION_BRANCH,
      ...metadata,
    },
    ...entry,
  };
}

/**
 * One patch: the approved append plus whatever the case overrides. The base
 * patch is append-only — it names no integration checkout and no policy — so a
 * case that needs either supplies it explicitly and a case that omits them
 * exercises the omission deliberately.
 */
function preparePatchOf(fixture: PrepareFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mainWorktreeBranch: "main",
    appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND)],
    ...overrides,
  };
}

describe("Prepare workflow amendment", () => {
  test("show-prepare reports the raw-byte versions and the admission view of a Prepare workflow", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);

    const view = await prepareViewOf(fixture);

    expect(view.ok).toBe(true);
    expect(view.operation).toBe("show-prepare");
    expect(view.session.role).toBe("coordinator");
    expect(view.session_file).toBe(fixture.coordinatorSession);
    expect(view.view.workflowId).toBe(PREPARE_WORKFLOW);
    expect(view.view.planIds).toEqual([PREPARE_ROW]);
    expect(view.view.allowed).toBe(true);
    expect(view.view.blockers).toEqual([]);
    // The tokens are the bytes on disk, computed independently here.
    expect(view.view.snapshotVersion).toBe(`sha256:${sha256OfFile(fixture.snapshotPath)}`);
    expect(view.view.compassVersion).toBe(`sha256:${sha256OfFile(fixture.compassPath)}`);
    // A read writes nothing.
    expect(protectedBytes(fixture)).toEqual(before);
  });

  test("amend-prepare appends the approved row and records the integration checkout and parallelism, preserving every prior value", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);
    const beforeSnapshot = prepareSnapshotOf(fixture);
    const oldRow = beforeSnapshot.plans[0]!;
    const beforeView = await prepareViewOf(fixture);

    const amended = await amendPrepare(
      fixture,
      preparePatchOf(fixture, { integrationWorktreePath: fixture.integrationPath, planParallelism: "parallel" }),
    );

    expect(amended.ok).toBe(true);
    expect(amended.operation).toBe("amend-prepare");
    expect(amended.outcome).toBe("amended");
    expect(amended.view.allowed).toBe(true);
    expect(amended.view.blockers).toEqual([]);
    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(amended.view.compassVersion).toBe(beforeView.view.compassVersion);
    expect(amended.view.snapshotVersion).not.toBe(beforeView.view.snapshotVersion);
    expect(amended.view.snapshotVersion).toBe(`sha256:${sha256OfFile(fixture.snapshotPath)}`);

    const after = prepareSnapshotOf(fixture);
    // The prior row is preserved by value and by position; nothing is rewritten.
    expect(after.plans[0]).toEqual(oldRow);
    expect(after.plans).toHaveLength(2);
    const appended = after.plans[1]!;
    expect(appended.id).toBe(PREPARE_APPEND);
    expect(appended.plan_id).toBeUndefined();
    expect(appended.title).toBe(`Plan ${PREPARE_APPEND}`);
    expect(appended.file).toBe(join(fixture.planDir, `${PREPARE_APPEND}.md`));
    expect(appended.status).toBe("Todo");
    expect(appended.owner).toBe("project-manager");
    expect(appended.progress).toBe(0);
    expect(appended.execution_lease).toBeUndefined();
    expect(appended.coordination).toBeUndefined();
    expect(typeof appended.created_at).toBe("string");
    expect(appended.metadata).toEqual({
      primary_spec: fixture.specPath,
      spec_refs: [fixture.specPath],
      iteration_compass: fixture.compassPath,
      iteration_refs: [fixture.compassPath],
      working_branch: `feature/${PREPARE_APPEND}`,
      spec_integration_branch: PREPARE_INTEGRATION_BRANCH,
      merge_target: PREPARE_INTEGRATION_BRANCH,
    });
    // Only the whitelisted projections and `updated_at` moved; the lifecycle
    // anchors, the coordinator binding and the sibling workflow did not.
    expect(after.integration_worktree_path).toBe(fixture.integrationPath);
    expect(after.execution_policy).toEqual({ plan_parallelism: "parallel", worktree_mode: "required" });
    expect(after.branch).toEqual({ base: "main", integration: PREPARE_INTEGRATION_BRANCH, target: "main" });
    expect(after.compass_ref).toBe(`iterations/${PREPARE_WORKFLOW}/delivery-compass.md`);
    expect(after.coordination).toEqual(beforeSnapshot.coordination);
    expect(after.started_at).toBe("2026-09-16");
    expect(after.phase).toBe("phase-1-prepare");
    expect(after.status).toBe("running");
    expect(readFileSync(fixture.statusPath, "utf8")).toBe(before.status);
    expect(readFileSync(fixture.compassPath, "utf8")).toBe(before.compass);
    expect(readFileSync(fixture.peerSnapshotPath, "utf8")).toBe(before.peer);
    expect(readFileSync(fixture.coordinatorSession, "utf8")).toBe(before.session);

    // A second show reports exactly the committed bytes.
    const afterView = await prepareViewOf(fixture);
    expect(afterView.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(afterView.view.snapshotVersion).toBe(amended.view.snapshotVersion);
    expect(afterView.view.allowed).toBe(true);
  });

  test("both real plan-header forms are read by value: `**Label:** v` and `**Label**: v`", async () => {
    // Every other case writes the dominant form (the colon inside the bold).
    // The bootstrap plan's own header block writes the colon after the bold,
    // and its branch fields must read the same. A real reviewed plan also
    // carries the descriptive `**Working branch policy:**` line beside its
    // `**Working branch:**` declaration; the policy is prose about the branch,
    // never the branch value.
    const colonAfterBold = makePrepareFixture();
    await ensurePrepareCoordinator(colonAfterBold);
    writeText(
      join(colonAfterBold.planDir, `${PREPARE_APPEND}.md`),
      [
        `# Plan ${PREPARE_APPEND}`,
        "",
        `**plan_id:** ${PREPARE_APPEND}`,
        "**Status:** Todo",
        "**Main worktree branch**: main",
        `**Working branch:** feature/${PREPARE_APPEND}`,
        "**Working branch policy:** Feature worktree from the integration branch; merge back into that integration branch.",
        "",
        "Body.",
        "",
      ].join("\n"),
    );

    const amended = await amendPrepare(colonAfterBold, preparePatchOf(colonAfterBold));

    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    const acceptedRows = prepareSnapshotOf(colonAfterBold).plans;
    expect(acceptedRows).toHaveLength(2);
    // The accepted row carries the branch the `Working branch` header declares,
    // not the policy sentence beside it.
    expect(acceptedRows[1]!.metadata).toMatchObject({ working_branch: `feature/${PREPARE_APPEND}` });

    // The same form declaring another branch refuses: the parsed value is
    // compared, never swallowed into the markup.
    const mismatch = makePrepareFixture();
    await ensurePrepareCoordinator(mismatch);
    writeText(
      join(mismatch.planDir, `${PREPARE_APPEND}.md`),
      [
        `# Plan ${PREPARE_APPEND}`,
        "",
        `**plan_id:** ${PREPARE_APPEND}`,
        "**Main worktree branch**: trunk",
        `**Working branch**: feature/${PREPARE_APPEND}`,
        "",
        "Body.",
        "",
      ].join("\n"),
    );

    const refusal = await prepareRefusalOf(() => amendPrepare(mismatch, preparePatchOf(mismatch)));
    expect(refusal.code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(refusal.details.expected).toBe("trunk");
    expect(refusal.details.actual).toBe("main");
  });

  test("only the consulted headers refuse a conflict, and a fence closes only on its own marker", async () => {
    // A real multi-task plan repeats its body labels — `**Files:**`,
    // `**Interfaces:**`, `**Task budget:**` — with a different value per task.
    // Only the labels this verb consults are declarations, so the repeat is
    // plan content and the document stays appendable.
    const multiTask = makePrepareFixture();
    await ensurePrepareCoordinator(multiTask);
    writeText(
      join(multiTask.planDir, `${PREPARE_APPEND}.md`),
      [
        `# Plan ${PREPARE_APPEND}`,
        "",
        `**plan_id:** ${PREPARE_APPEND}`,
        "**Status:** Todo",
        "**Main worktree branch:** main",
        `**Working branch:** feature/${PREPARE_APPEND}`,
        "",
        "## Task 1",
        "",
        "**Files:** packages/engine/src/coordination.ts",
        "**Task budget:** 60k",
        "",
        "## Task 2",
        "",
        "**Files:** packages/cli/src/plan-coordination.ts",
        "**Task budget:** 20k",
        "",
      ].join("\n"),
    );

    const amended = await amendPrepare(multiTask, preparePatchOf(multiTask));

    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);

    // A consulted label repeated with a different value is still a conflict.
    const conflicting = makePrepareFixture();
    await ensurePrepareCoordinator(conflicting);
    writeText(
      join(conflicting.planDir, `${PREPARE_APPEND}.md`),
      [
        `# Plan ${PREPARE_APPEND}`,
        "",
        `**plan_id:** ${PREPARE_APPEND}`,
        "**plan_id:** plan-other",
        "**Status:** Todo",
        "**Main worktree branch:** main",
        `**Working branch:** feature/${PREPARE_APPEND}`,
        "",
        "Body.",
        "",
      ].join("\n"),
    );

    const conflict = await prepareRefusalOf(() => amendPrepare(conflicting, preparePatchOf(conflicting)));

    expect(conflict.code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(conflict.details.header).toBe("plan_id");

    // A fenced example is never a declaration, whatever marker opened the
    // block: a `~~~` block is not read at all, and a shorter backtick run
    // inside a longer fence does not close it early.
    const fenceCases: ReadonlyArray<{ name: string; lines: readonly string[] }> = [
      { name: "tilde-fence", lines: ["~~~md", "**plan_id:** plan-example", "~~~"] },
      { name: "shorter-run-inside-longer-fence", lines: ["````md", "```", "**plan_id:** plan-example", "```", "````"] },
    ];

    for (const fenceCase of fenceCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      writeText(
        join(fixture.planDir, `${PREPARE_APPEND}.md`),
        [
          `# Plan ${PREPARE_APPEND}`,
          "",
          `**plan_id:** ${PREPARE_APPEND}`,
          "**Status:** Todo",
          "**Main worktree branch:** main",
          `**Working branch:** feature/${PREPARE_APPEND}`,
          "",
          ...fenceCase.lines,
          "",
          "Body.",
          "",
        ].join("\n"),
      );

      const fenced = await amendPrepare(fixture, preparePatchOf(fixture));

      expect(`${fenceCase.name}: ${fenced.view.planIds.join()}`).toBe(
        `${fenceCase.name}: ${[PREPARE_ROW, PREPARE_APPEND].join()}`,
      );
    }
  }, 30000);

  test("both reviewed branch headers are required on an appended plan", async () => {
    // The plan document is the reviewed authority for the branch metadata: an
    // absent header is never treated as agreement with the branches the append
    // itself claims, and the descriptive `Working branch policy` line beside it
    // is prose — it cannot stand in for the `Working branch` declaration.
    const planCases: ReadonlyArray<{
      name: string;
      lines: readonly string[];
      /** The declaration the refusal must name as missing. */
      field: string;
      header: string;
    }> = [
      {
        name: "working-branch-policy-only",
        lines: [
          `**plan_id:** ${PREPARE_APPEND}`,
          "**Status:** Todo",
          "**Main worktree branch:** main",
          "**Working branch policy:** Feature worktree from the integration branch; merge back into that integration branch.",
        ],
        field: "metadata.working_branch",
        header: "Working branch",
      },
      {
        name: "missing-main-worktree-branch",
        lines: [`**plan_id:** ${PREPARE_APPEND}`, "**Status:** Todo", `**Working branch:** feature/${PREPARE_APPEND}`],
        field: "mainWorktreeBranch",
        header: "Main worktree branch",
      },
    ];

    for (const planCase of planCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const planPath = join(fixture.planDir, `${PREPARE_APPEND}.md`);
      writeText(planPath, [`# Plan ${PREPARE_APPEND}`, "", ...planCase.lines, "", "Body.", ""].join("\n"));
      const before = protectedBytes(fixture);

      const failure = await failureOf(() => amendPrepare(fixture, preparePatchOf(fixture)));
      if (!(failure instanceof CoordinationError)) throw failure;

      const label = `${planCase.name}: `;
      expect(`${label}${failure.code}`).toBe(`${label}coordination.prepare-amendment.invalid-plan`);
      // The owner supplies the plan identity, missing header field, and source path.
      expect(failure.details).toMatchObject({ plan_id: PREPARE_APPEND, field: planCase.field, path: planPath });
      // It refuses before mutation: every protected byte is unchanged.
      expect(protectedBytes(fixture)).toEqual(before);
    }
  });

  test("two amendments presenting the same tokens race under the lock: exactly one commits, the loser is stale", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const view = await prepareViewOf(fixture);
    const patch = preparePatchOf(fixture, { planParallelism: "parallel" });
    const tokens = { snapshotVersion: view.view.snapshotVersion, compassVersion: view.view.compassVersion };

    const results = await Promise.allSettled([
      amendWith(fixture, patch, tokens),
      amendWith(fixture, patch, tokens),
    ]);

    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as CoordinationError).code).toBe("coordination.prepare-amendment.stale");

    // Exactly one delta landed: the rows are the winner's, and the snapshot on
    // disk is the version the winner returned.
    const winner = fulfilled[0] as PromiseFulfilledResult<PrepareWorkflowResult>;
    expect(prepareSnapshotOf(fixture).plans.map((row) => row.id)).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(winner.value.view.snapshotVersion).toBe(`sha256:${sha256OfFile(fixture.snapshotPath)}`);
  });

  test("a stale snapshot or compass token refuses as stale and leaves every protected byte untouched", async () => {
    for (const staleToken of ["snapshot", "compass"] as const) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const view = await prepareViewOf(fixture);
      const before = protectedBytes(fixture);
      const stale = `sha256:${"0".repeat(64)}`;

      const refusal = await prepareRefusalOf(() =>
        amendWith(fixture, preparePatchOf(fixture), {
          snapshotVersion: staleToken === "snapshot" ? stale : view.view.snapshotVersion,
          compassVersion: staleToken === "compass" ? stale : view.view.compassVersion,
        }),
      );

      expect(refusal.code).toBe("coordination.prepare-amendment.stale");
      expect(refusal.details.expected).toBe(stale);
      expect(protectedBytes(fixture)).toEqual(before);
    }
  });

  test("a plan-pm, forged, relocated or foreign-root envelope refuses with the existing auth errors", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const view = await prepareViewOf(fixture);
    const sessionDir = dirname(fixture.coordinatorSession);
    const envelope = (overrides: Record<string, unknown>): string => {
      const path = join(sessionDir, `${String(overrides.session_id)}.json`);
      writeJson(path, {
        schema_version: 1,
        role: "coordinator",
        session_id: "11111111-1111-1111-1111-111111111111",
        workflow_id: PREPARE_WORKFLOW,
        harness_root: fixture.harness,
        ...overrides,
      });
      return path;
    };

    // A real envelope of the wrong role.
    const planPm = envelope({ role: "plan-pm", session_id: "plan-pm-envelope", plan_id: PREPARE_ROW });
    expect((await prepareRefusalOf(() => prepareViewOf(fixture, planPm))).code).toBe("coordination.session-role");

    // A forged coordinator envelope: a session id the snapshot never bound.
    const forged = envelope({ session_id: "22222222-2222-2222-2222-222222222222" });
    expect(
      (
        await prepareRefusalOf(() =>
          amendWith(fixture, preparePatchOf(fixture), {
            snapshotVersion: view.view.snapshotVersion,
            compassVersion: view.view.compassVersion,
            sessionPath: forged,
          }),
        )
      ).code,
    ).toBe("coordination.session-mismatch");

    // The bound session at another path: identity is the canonical file, never a copy.
    const relocated = join(fixture.root, "relocated-envelope.json");
    writeText(relocated, readFileSync(fixture.coordinatorSession, "utf8"));
    expect((await prepareRefusalOf(() => prepareViewOf(fixture, relocated))).code).toBe("coordination.session-mismatch");

    // An envelope claiming another harness root: the active store is the control root.
    const foreign = envelope({ session_id: "33333333-3333-3333-3333-333333333333", harness_root: join(fixture.root, "other-harness") });
    expect((await prepareRefusalOf(() => prepareViewOf(fixture, foreign))).code).toBe("coordination.path-mismatch");
  });

  test("an unregistered workflow refuses before the read or the amendment can proceed", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const view = await prepareViewOf(fixture);
    const root = readJson(fixture.statusPath);
    root.workflows = (root.workflows as Array<Record<string, unknown>>).filter((entry) => entry.id !== PREPARE_WORKFLOW);
    writeJson(fixture.statusPath, root);
    const before = protectedBytes(fixture);

    expect((await prepareRefusalOf(() => prepareViewOf(fixture))).code).toBe("coordination.workflow-not-found");
    expect(
      (
        await prepareRefusalOf(() =>
          amendWith(fixture, preparePatchOf(fixture), {
            snapshotVersion: view.view.snapshotVersion,
            compassVersion: view.view.compassVersion,
          }),
        )
      ).code,
    ).toBe("coordination.workflow-not-found");
    expect(protectedBytes(fixture).snapshot).toBe(before.snapshot);
  });

  test("a non-Prepare phase, a terminal lifecycle, a progressed row or any lease/handoff state refuses without mutation", async () => {
    const admissionCases: ReadonlyArray<{
      name: string;
      code: string;
      patchSnapshot: (doc: { plans: Array<Record<string, unknown>> } & Record<string, unknown>, fixture: PrepareFixture) => void;
    }> = [
      {
        name: "phase-2",
        code: "coordination.prepare-amendment.not-prepare",
        patchSnapshot: (doc) => {
          doc.phase = "phase-2-execute";
        },
      },
      {
        name: "terminal",
        code: "coordination.prepare-amendment.not-prepare",
        patchSnapshot: (doc) => {
          doc.status = "completed";
          doc.ended_at = "2026-09-16";
        },
      },
      {
        name: "row-in-progress",
        code: "coordination.prepare-amendment.execution-started",
        patchSnapshot: (doc) => {
          doc.plans[0]!.status = "InProgress";
        },
      },
      {
        name: "row-progress",
        code: "coordination.prepare-amendment.execution-started",
        patchSnapshot: (doc) => {
          doc.plans[0]!.progress = 40;
        },
      },
      {
        name: "row-execution-lease",
        code: "coordination.prepare-amendment.execution-started",
        patchSnapshot: (doc, fixture) => {
          doc.plans[0]!.execution_lease = {
            holder: "11111111-1111-1111-1111-111111111111",
            claimed_at: "2026-09-16T00:00:00Z",
            worktree_path: join(fixture.root, "wt-row"),
            working_branch: "feature/plan-prepare",
          };
        },
      },
      {
        name: "row-coordination",
        code: "coordination.prepare-amendment.execution-started",
        patchSnapshot: (doc) => {
          doc.plans[0]!.coordination = { revision: 1 };
        },
      },
      {
        name: "integration-merge-lease",
        code: "coordination.prepare-amendment.execution-started",
        patchSnapshot: (doc) => {
          doc.integration_merge_lease = {
            holder: "11111111-1111-1111-1111-111111111111",
            claimed_at: "2026-09-16T00:00:00Z",
            plan_id: PREPARE_ROW,
            source_branch: "feature/plan-prepare",
            target_branch: PREPARE_INTEGRATION_BRANCH,
          };
        },
      },
    ];

    for (const admissionCase of admissionCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const view = await prepareViewOf(fixture);
      const doc = prepareSnapshotOf(fixture);
      admissionCase.patchSnapshot(doc, fixture);
      writeJson(fixture.snapshotPath, doc);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() =>
        amendWith(fixture, preparePatchOf(fixture), {
          snapshotVersion: `sha256:${sha256OfFile(fixture.snapshotPath)}`,
          compassVersion: view.view.compassVersion,
        }),
      );

      // The case name names the state; the code names the refusal reason.
      expect(`${admissionCase.name}: ${refusal.code}`).toBe(`${admissionCase.name}: ${admissionCase.code}`);
      expect(protectedBytes(fixture)).toEqual(before);

      // The read reports the same state as a blocker instead of a refusal.
      const readOnly = await prepareViewOf(fixture);
      expect(readOnly.view.allowed).toBe(false);
      expect(readOnly.view.blockers).toHaveLength(1);
    }
  }, 30000);

  test("duplicate plan ids refuse: an existing row id and a repetition inside one patch", async () => {
    const existing = makePrepareFixture();
    await ensurePrepareCoordinator(existing);
    const existingRefusal = await prepareRefusalOf(() =>
      amendPrepare(existing, preparePatchOf(existing, { appendPlans: [prepareAppendOf(existing, PREPARE_ROW)] })),
    );
    expect(existingRefusal.code).toBe("coordination.prepare-amendment.duplicate-plan");
    expect(existingRefusal.details.plan_id).toBe(PREPARE_ROW);

    const repeated = makePrepareFixture();
    await ensurePrepareCoordinator(repeated);
    const repeatedRefusal = await prepareRefusalOf(() =>
      amendPrepare(
        repeated,
        preparePatchOf(repeated, {
          appendPlans: [prepareAppendOf(repeated, PREPARE_APPEND), prepareAppendOf(repeated, PREPARE_APPEND)],
        }),
      ),
    );
    expect(repeatedRefusal.code).toBe("coordination.prepare-amendment.duplicate-plan");
  });

  test("plan appends refuse unsafe ids, wrong plan files, mismatched headers and escaping or missing references", async () => {
    const invalidPlanCases: ReadonlyArray<{
      name: string;
      prepare?: (fixture: PrepareFixture) => void;
      patch: (fixture: PrepareFixture) => Record<string, unknown>;
    }> = [
      {
        name: "unsafe-id",
        patch: (fixture) =>
          preparePatchOf(fixture, { appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, { id: ".." })] }),
      },
      {
        name: "file-outside-plan-dir",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, { file: join(fixture.root, "elsewhere.md") })],
          }),
      },
      {
        name: "file-not-the-plan-id",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [
              prepareAppendOf(fixture, PREPARE_APPEND, { file: join(fixture.planDir, `${PREPARE_UNREVIEWED}.md`) }),
            ],
          }),
      },
      {
        // Missing / non-string pointers are shape violations this boundary owns:
        // the shared resolver names the pointer form with `path.isAbsolute(file)`
        // before its own type check, so reaching it with these would surface a
        // native `TypeError` instead of the refusal vocabulary.
        name: "file-missing",
        patch: (fixture) =>
          preparePatchOf(fixture, { appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, { file: undefined })] }),
      },
      {
        name: "file-null",
        patch: (fixture) => preparePatchOf(fixture, { appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, { file: null })] }),
      },
      {
        name: "file-not-a-string",
        patch: (fixture) => preparePatchOf(fixture, { appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, { file: 42 })] }),
      },
      {
        name: "header-id-mismatch",
        prepare: (fixture) => {
          writeText(join(fixture.planDir, `${PREPARE_APPEND}.md`), preparePlanMarkdown({ id: "plan-other", workingBranch: `feature/${PREPARE_APPEND}` }));
        },
        patch: (fixture) => preparePatchOf(fixture),
      },
      {
        name: "metadata-unexpected-key",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, {}, { execution_mode: "sdd" })],
          }),
      },
      {
        name: "working-branch-mismatch",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, {}, { working_branch: "feature/somewhere-else" })],
          }),
      },
      {
        name: "main-branch-header-mismatch",
        prepare: (fixture) => {
          writeText(join(fixture.planDir, `${PREPARE_APPEND}.md`), preparePlanMarkdown({ id: PREPARE_APPEND, workingBranch: `feature/${PREPARE_APPEND}`, mainBranch: "trunk" }));
        },
        patch: (fixture) => preparePatchOf(fixture),
      },
      {
        name: "spec-outside-harness",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [
              prepareAppendOf(fixture, PREPARE_APPEND, {}, { primary_spec: join(fixture.root, "outside-spec.md") }),
            ],
          }),
      },
      {
        name: "spec-missing",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [
              prepareAppendOf(fixture, PREPARE_APPEND, {}, { spec_refs: [join(fixture.harness, "specs", "missing.md")] }),
            ],
          }),
      },
      {
        name: "integration-branch-mismatch",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, {}, { merge_target: "main" })],
          }),
      },
    ];

    for (const invalidCase of invalidPlanCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      invalidCase.prepare?.(fixture);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() => amendPrepare(fixture, invalidCase.patch(fixture)));

      expect(`${invalidCase.name}: ${refusal.code}`).toBe(
        `${invalidCase.name}: coordination.prepare-amendment.invalid-plan`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }
  }, 60000);

  test("the proposal must match the reviewed compass exactly", async () => {
    const undeclared = makePrepareFixture();
    await ensurePrepareCoordinator(undeclared);
    const undeclaredRefusal = await prepareRefusalOf(() =>
      amendPrepare(undeclared, preparePatchOf(undeclared, { appendPlans: [prepareAppendOf(undeclared, PREPARE_UNREVIEWED)] })),
    );
    expect(undeclaredRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(undeclaredRefusal.details.undeclared).toEqual([PREPARE_UNREVIEWED]);

    // The compass declares a plan this patch leaves unregistered.
    const incomplete = makePrepareFixture();
    await ensurePrepareCoordinator(incomplete);
    writeText(
      incomplete.compassPath,
      readFileSync(incomplete.compassPath, "utf8").replace(`  - ${PREPARE_APPEND}\n`, `  - ${PREPARE_APPEND}\n  - ${PREPARE_UNREVIEWED}\n`),
    );
    const incompleteRefusal = await prepareRefusalOf(() => amendPrepare(incomplete, preparePatchOf(incomplete)));
    expect(incompleteRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(incompleteRefusal.details.missing).toEqual([PREPARE_UNREVIEWED]);

    // Another lifecycle's compass: the ref itself is refused, not silently used.
    const borrowed = makePrepareFixture();
    await ensurePrepareCoordinator(borrowed);
    const otherCompass = join(borrowed.harness, "iterations", "iter-other", "delivery-compass.md");
    writeText(otherCompass, readFileSync(borrowed.compassPath, "utf8").replace(`iteration_id: ${PREPARE_WORKFLOW}`, "iteration_id: iter-other"));
    const borrowedRefusal = await prepareRefusalOf(() =>
      amendPrepare(borrowed, preparePatchOf(borrowed, { appendPlans: [prepareAppendOf(borrowed, PREPARE_APPEND, {}, { iteration_compass: otherCompass })] })),
    );
    expect(borrowedRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");

    // A missing compass cannot approve anything.
    const missing = makePrepareFixture();
    await ensurePrepareCoordinator(missing);
    rmSync(missing.compassPath);
    const missingRefusal = await prepareRefusalOf(() => amendPrepare(missing, preparePatchOf(missing)));
    expect(missingRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");

    // A compass that declares no plan ids.
    const declaredNone = makePrepareFixture();
    await ensurePrepareCoordinator(declaredNone);
    writeText(declaredNone.compassPath, `---\niteration_id: ${PREPARE_WORKFLOW}\nstatus: locked\n---\n`);
    const declaredNoneRefusal = await prepareRefusalOf(() => amendPrepare(declaredNone, preparePatchOf(declaredNone)));
    expect(declaredNoneRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
  }, 30000);

  test("the reviewed compass must declare its lifecycle identity and a clean plan list", async () => {
    // A compass that is not bound to this lifecycle, or whose `plans` list is
    // malformed, or whose branch / checkout declaration is present without a
    // usable value, cannot authorize a structural delta: the declaration is
    // either read exactly as written or refused, never filtered, deduplicated
    // or silently dropped into a declaration it does not make.
    const compassCases: ReadonlyArray<{ name: string; frontmatter: readonly string[] }> = [
      {
        name: "missing-iteration-id",
        frontmatter: [
          "status: locked",
          `spec_integration_branch: ${PREPARE_INTEGRATION_BRANCH}`,
          "target_branch: main",
          "plans:",
          `  - ${PREPARE_ROW}`,
          `  - ${PREPARE_APPEND}`,
        ],
      },
      {
        name: "duplicate-plan-entry",
        frontmatter: [
          `iteration_id: ${PREPARE_WORKFLOW}`,
          "status: locked",
          "plans:",
          `  - ${PREPARE_ROW}`,
          `  - ${PREPARE_APPEND}`,
          `  - ${PREPARE_APPEND}`,
        ],
      },
      {
        name: "empty-plan-entry",
        frontmatter: [
          `iteration_id: ${PREPARE_WORKFLOW}`,
          "status: locked",
          "plans:",
          `  - ${PREPARE_ROW}`,
          `  - ${PREPARE_APPEND}`,
          '  - ""',
        ],
      },
      {
        name: "malformed-integration-branch",
        frontmatter: [
          `iteration_id: ${PREPARE_WORKFLOW}`,
          "status: locked",
          "spec_integration_branch:",
          `  - ${PREPARE_INTEGRATION_BRANCH}`,
          "  - integration/second",
          "plans:",
          `  - ${PREPARE_ROW}`,
          `  - ${PREPARE_APPEND}`,
        ],
      },
      {
        name: "malformed-integration-worktree-path",
        frontmatter: [
          `iteration_id: ${PREPARE_WORKFLOW}`,
          "status: locked",
          `spec_integration_branch: ${PREPARE_INTEGRATION_BRANCH}`,
          "integration_worktree_path:",
          "  - /tmp/wt-one",
          "plans:",
          `  - ${PREPARE_ROW}`,
          `  - ${PREPARE_APPEND}`,
        ],
      },
    ];

    for (const compassCase of compassCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      writeText(fixture.compassPath, ["---", ...compassCase.frontmatter, "---", ""].join("\n"));
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() => amendPrepare(fixture, preparePatchOf(fixture)));

      expect(`${compassCase.name}: ${refusal.code}`).toBe(
        `${compassCase.name}: coordination.prepare-amendment.compass-mismatch`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }
  });

  test("a compass-declared integration checkout is compared even when the patch omits the path", async () => {
    const withDeclaredPath = (path: string): string =>
      [
        "---",
        `iteration_id: ${PREPARE_WORKFLOW}`,
        "status: locked",
        `spec_integration_branch: ${PREPARE_INTEGRATION_BRANCH}`,
        "target_branch: main",
        `integration_worktree_path: ${path}`,
        "plans:",
        `  - ${PREPARE_ROW}`,
        `  - ${PREPARE_APPEND}`,
        "---",
        "",
      ].join("\n");

    // A workflow whose recorded checkout disagrees with its reviewed compass
    // refuses the append even though the patch never names a path.
    const conflicting = makePrepareFixture();
    await ensurePrepareCoordinator(conflicting);
    const reviewedPath = join(conflicting.root, "wt-integration-reviewed");
    git(["worktree", "add", "-q", "-b", "integration/wf-prepare-reviewed", reviewedPath], conflicting.root);
    const olderPath = join(conflicting.root, "wt-integration-old");
    git(["worktree", "add", "-q", "-b", "integration/wf-prepare-old", olderPath], conflicting.root);
    writeText(conflicting.compassPath, withDeclaredPath(reviewedPath));
    const recorded = prepareSnapshotOf(conflicting);
    recorded.integration_worktree_path = olderPath;
    writeJson(conflicting.snapshotPath, recorded);
    // The helper's base patch is append-only (it names no path and no policy),
    // so these cases exercise the omission the finding is about.
    const conflictingBefore = protectedBytes(conflicting);
    const refusal = await prepareRefusalOf(() => amendPrepare(conflicting, preparePatchOf(conflicting)));

    expect(refusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(protectedBytes(conflicting)).toEqual(conflictingBefore);

    // The declaration is the reviewed state, so a workflow that has not
    // recorded the reviewed checkout yet refuses the same way.
    const unrecorded = makePrepareFixture();
    await ensurePrepareCoordinator(unrecorded);
    writeText(unrecorded.compassPath, withDeclaredPath(unrecorded.integrationPath));
    const unrecordedBefore = protectedBytes(unrecorded);

    const unrecordedRefusal = await prepareRefusalOf(() => amendPrepare(unrecorded, preparePatchOf(unrecorded)));

    expect(unrecordedRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(protectedBytes(unrecorded)).toEqual(unrecordedBefore);

    // Control: the same path-omitting append is admitted once the recorded
    // checkout IS the reviewed one.
    const aligned = makePrepareFixture();
    await ensurePrepareCoordinator(aligned);
    writeText(aligned.compassPath, withDeclaredPath(aligned.integrationPath));
    const alignedDoc = prepareSnapshotOf(aligned);
    alignedDoc.integration_worktree_path = aligned.integrationPath;
    writeJson(aligned.snapshotPath, alignedDoc);

    const amended = await amendPrepare(aligned, preparePatchOf(aligned));

    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);

    // Control: the check targets the path this commit would leave, so naming
    // the reviewed checkout in the patch is a lawful correction of a stale
    // recording — the old recorded value is replaced, not compared.
    const corrected = makePrepareFixture();
    await ensurePrepareCoordinator(corrected);
    writeText(corrected.compassPath, withDeclaredPath(corrected.integrationPath));
    const staleDoc = prepareSnapshotOf(corrected);
    staleDoc.integration_worktree_path = join(corrected.root, "wt-integration-old");
    writeJson(corrected.snapshotPath, staleDoc);

    const correctedResult = await amendPrepare(
      corrected,
      preparePatchOf(corrected, { integrationWorktreePath: corrected.integrationPath }),
    );

    expect(correctedResult.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(prepareSnapshotOf(corrected).integration_worktree_path).toBe(corrected.integrationPath);
  }, 30000);

  test("a compass integration branch that disagrees with the workflow's recorded branch refuses a patch that appends nothing", async () => {
    // The declaration is compared where every patch is validated, so an
    // amendment that only records the policy or the checkout cannot commit a
    // workflow whose recorded integration branch contradicts it.
    const declaredBranch = "integration/declared-elsewhere";
    const patchCases: ReadonlyArray<{ name: string; patch: (fixture: PrepareFixture) => Record<string, unknown> }> = [
      {
        name: "policy-only",
        patch: (fixture) => preparePatchOf(fixture, { appendPlans: [], planParallelism: "parallel" }),
      },
      {
        name: "checkout-only",
        patch: (fixture) => preparePatchOf(fixture, { appendPlans: [], integrationWorktreePath: fixture.integrationPath }),
      },
    ];

    for (const patchCase of patchCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      // The compass declares only the already-registered plan, so the patch
      // below changes exactly one thing: the policy or the recorded checkout.
      writeText(
        fixture.compassPath,
        readFileSync(fixture.compassPath, "utf8")
          .replace(`  - ${PREPARE_APPEND}\n`, "")
          .replace(`spec_integration_branch: ${PREPARE_INTEGRATION_BRANCH}`, `spec_integration_branch: ${declaredBranch}`),
      );
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() => amendPrepare(fixture, patchCase.patch(fixture)));

      expect(`${patchCase.name}: ${refusal.code}`).toBe(
        `${patchCase.name}: coordination.prepare-amendment.compass-mismatch`,
      );
      expect(`${patchCase.name}: ${String(refusal.details.expected)}`).toBe(`${patchCase.name}: ${declaredBranch}`);
      expect(`${patchCase.name}: ${String(refusal.details.actual)}`).toBe(
        `${patchCase.name}: ${PREPARE_INTEGRATION_BRANCH}`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }
  }, 30000);

  test("the integration checkout must be a distinct real checkout of this repository on branch.integration", async () => {
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "mstar-prepare-other-")));
    roots.push(otherRoot);
    git(["init", "-q", "-b", "main"], otherRoot);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], otherRoot);
    const otherWorktree = join(otherRoot, "wt-other");
    git(["worktree", "add", "-q", "-b", PREPARE_INTEGRATION_BRANCH, otherWorktree], otherRoot);

    const worktreeCases: ReadonlyArray<{ name: string; path: (fixture: PrepareFixture) => string }> = [
      { name: "missing-path", path: (fixture) => join(fixture.root, "no-such-checkout") },
      { name: "main-checkout", path: (fixture) => fixture.root },
      { name: "control-root", path: (fixture) => fixture.harness },
      {
        name: "same-checkout-alias",
        path: (fixture) => {
          mkdirSync(join(fixture.root, "subdir"));
          return join(fixture.root, "subdir");
        },
      },
      {
        name: "wrong-branch",
        path: (fixture) => {
          const path = join(fixture.root, "wt-elsewhere");
          git(["worktree", "add", "-q", "-b", "feature/elsewhere", path], fixture.root);
          return path;
        },
      },
      { name: "other-repository", path: () => otherWorktree },
    ];

    for (const worktreeCase of worktreeCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const candidate = worktreeCase.path(fixture);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() =>
        amendPrepare(fixture, preparePatchOf(fixture, { integrationWorktreePath: candidate })),
      );

      expect(`${worktreeCase.name}: ${refusal.code}`).toBe(
        `${worktreeCase.name}: coordination.prepare-amendment.invalid-worktree`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }
  }, 30000);

  test("the recorded checkout is proven against the repository owning the control harness root, never the caller's clone", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);

    // A second clone of the same project: its own repository, its own `main`
    // and its own real checkout on the workflow's recorded branch.integration —
    // the checkout the caller's clone could otherwise record as this
    // lifecycle's integration worktree.
    const clonePath = realpathSync(mkdtempSync(join(tmpdir(), "mstar-prepare-clone-")));
    rmSync(clonePath, { recursive: true, force: true });
    git(["clone", "-q", fixture.root, clonePath], tmpdir());
    const clone = realpathSync(clonePath);
    roots.push(clone);
    const cloneCheckout = join(clone, "wt-integration");
    git(["worktree", "add", "-q", "-b", PREPARE_INTEGRATION_BRANCH, cloneCheckout], clone);

    const view = await prepareViewOf(fixture);
    const before = protectedBytes(fixture);

    const refusal = await prepareRefusalOf(() =>
      amendWith(fixture, preparePatchOf(fixture, { integrationWorktreePath: cloneCheckout }), {
        snapshotVersion: view.view.snapshotVersion,
        compassVersion: view.view.compassVersion,
        cwd: clone,
      }),
    );

    expect(refusal.code).toBe("coordination.prepare-amendment.invalid-worktree");
    expect(protectedBytes(fixture)).toEqual(before);
    expect(prepareSnapshotOf(fixture).integration_worktree_path).toBeUndefined();

    // The legitimate call from the control root's own repository still records
    // that repository's reviewed checkout.
    const amended = await amendPrepare(fixture, preparePatchOf(fixture, { integrationWorktreePath: fixture.integrationPath }));
    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(prepareSnapshotOf(fixture).integration_worktree_path).toBe(fixture.integrationPath);
  }, 30000);

  test("the returned snapshot version names the commit this call made, never a competing commit", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const view = await prepareViewOf(fixture);
    const lockDir = join(dirname(fixture.snapshotPath), ".status-write.lockdir");
    const store = instrumentLocalStore(
      fixture.harness,
      (inner) => new CompetingCommitStore(inner, fixture.snapshotPath, lockDir, "2099-01-01T00:00:00.000Z"),
    );

    const amended = await amendWith(fixture, preparePatchOf(fixture), {
      snapshotVersion: view.view.snapshotVersion,
      compassVersion: view.view.compassVersion,
    });

    // The returned token is the byte version of this call's own commit, not the
    // state the snapshot was left in afterwards.
    expect(amended.view.snapshotVersion).toBe(store.commitVersion);
    const competitor = store.publishCompetitor();
    expect(competitor).not.toBe("");
    expect(competitor).not.toBe(store.commitVersion);
    expect(amended.view.snapshotVersion).toBe(store.commitVersion);
    expect(readArtifactBytes(fixture.snapshotPath)?.version).toBe(competitor);
  }, 30000);

  test("unknown patch keys, malformed values and a no-op patch refuse as invalid-patch", async () => {
    const cases: ReadonlyArray<{ name: string; patch: (fixture: PrepareFixture) => Record<string, unknown> }> = [
      { name: "unknown-key", patch: (fixture) => preparePatchOf(fixture, { replacePlans: [] }) },
      { name: "missing-main-branch", patch: (fixture) => preparePatchOf(fixture, { mainWorktreeBranch: undefined }) },
      { name: "appends-not-an-array", patch: (fixture) => preparePatchOf(fixture, { appendPlans: "plan-append" }) },
      { name: "bad-parallelism", patch: (fixture) => preparePatchOf(fixture, { planParallelism: "maybe" }) },
      { name: "empty-patch", patch: (fixture) => preparePatchOf(fixture, { appendPlans: [] }) },
    ];

    for (const patchCase of cases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() => amendPrepare(fixture, patchCase.patch(fixture)));

      expect(`${patchCase.name}: ${refusal.code}`).toBe(
        `${patchCase.name}: coordination.prepare-amendment.invalid-patch`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }

    // A patch that re-states the recorded path and policy changes nothing. The
    // compass declares only the already-registered row, so the path can be
    // recorded on its own before the no-op is attempted.
    const noop = makePrepareFixture();
    await ensurePrepareCoordinator(noop);
    writeText(
      noop.compassPath,
      readFileSync(noop.compassPath, "utf8").replace(`  - ${PREPARE_APPEND}\n`, ""),
    );
    await amendPrepare(noop, preparePatchOf(noop, { appendPlans: [], integrationWorktreePath: noop.integrationPath }));
    const before = protectedBytes(noop);
    const noopRefusal = await prepareRefusalOf(() =>
      amendPrepare(
        noop,
        preparePatchOf(noop, { appendPlans: [], integrationWorktreePath: noop.integrationPath, planParallelism: "serial" }),
      ),
    );
    expect(noopRefusal.code).toBe("coordination.prepare-amendment.invalid-patch");
    expect(protectedBytes(noop)).toEqual(before);
  }, 30000);

  test("the caller's main worktree branch is verified from Git, not from the snapshot's branch.base", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);

    const refusal = await prepareRefusalOf(() =>
      amendPrepare(fixture, preparePatchOf(fixture, { mainWorktreeBranch: "release" })),
    );

    expect(refusal.code).toBe("coordination.scope-mismatch");
    expect(refusal.details.expected).toBe("release");
    expect(refusal.details.actual).toBe("main");
    expect(protectedBytes(fixture)).toEqual(before);
  });

  test("the generic snapshot writers still refuse the same row delta", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const current = prepareSnapshotOf(fixture);
    const before = protectedBytes(fixture);
    const version = `sha256:${sha256OfFile(fixture.snapshotPath)}`;
    const proposed = {
      ...current,
      updated_at: "2026-09-16T12:00:00.000Z",
      plans: [...current.plans, { id: "plan-smuggled", title: "Smuggled", file: "plans/plan-smuggled.md", status: "Todo" }],
    } as unknown as WorkflowSnapshot;

    const generic = await prepareRefusalOf(() =>
      writeWorkflowSnapshot(proposed, fixture.workflowDir, { expectedVersion: version, sessionPath: fixture.coordinatorSession }),
    );
    expect(generic.code).toBe("coordination.direct-write-refused");
    expect(protectedBytes(fixture)).toEqual(before);

    const replacement = await prepareRefusalOf(() =>
      replaceCoordinatedArtifact({
        harnessRoot: fixture.harness,
        ref: { kind: "snapshot", key: PREPARE_WORKFLOW },
        payload: proposed,
        expectedVersion: version,
        sessionPath: fixture.coordinatorSession,
      }),
    );
    expect(replacement.code).toBe("coordination.direct-write-refused");
    expect(protectedBytes(fixture)).toEqual(before);
  });

  test("the create-only + register bootstrap route stops on registration failure and never executes the unregistered orphan", async () => {
    const fixture = makePrepareFixture();
    const orphanId = "wf-orphan";
    const orphanDir = join(fixture.harness, "workflows", orphanId);
    const orphanSnapshotPath = join(orphanDir, "snapshot.json");
    const orphan: WorkflowSnapshot = {
      schema_version: 1,
      id: orphanId,
      type: "iteration",
      status: "running",
      phase: "phase-1-prepare",
      started_at: "2026-09-16",
      updated_at: "2026-09-16",
      plans: [planRow("plan-orphan", PROJECT_ID)],
    };
    // Creation succeeds …
    await writeWorkflowSnapshot(orphan, orphanDir, { createOnly: true });
    const createdBytes = readFileSync(orphanSnapshotPath, "utf8");
    // … and registration fails on a root document that cannot be written (a
    // duplicate workflow id), leaving the created snapshot unregistered.
    const root = readJson(fixture.statusPath);
    const workflows = root.workflows as Array<Record<string, unknown>>;
    root.workflows = [...workflows, workflows[1]!];
    writeJson(fixture.statusPath, root);
    const statusBytes = readFileSync(fixture.statusPath, "utf8");

    const registerFailure = await failureOf(() =>
      registerWorkflow(fixture.statusPath, {
        id: orphanId,
        type: "iteration",
        started_at: "2026-09-16",
        dir: `workflows/${orphanId}`,
      }),
    );
    expect(registerFailure.message).toContain("status.json");
    // The failed registration wrote nothing, and the orphan grants nothing: no
    // execution path admits a workflow the root never registered.
    expect(readFileSync(fixture.statusPath, "utf8")).toBe(statusBytes);
    const bindRefusal = await prepareRefusalOf(() =>
      bindPlanSession({
        coordinator: true,
        workflowId: orphanId,
        harnessDir: fixture.harness,
        cwd: fixture.root,
        sessionId: FIXTURE_COORDINATOR_ID,
      }),
    );
    expect(bindRefusal.code).toBe("coordination.workflow-not-found");

    // Retrying creation never overwrites the created bytes.
    const recreate = await prepareRefusalOf(() => writeWorkflowSnapshot(orphan, orphanDir, { createOnly: true }));
    expect(recreate.code).toBe("coordination.version-conflict");
    expect(readFileSync(orphanSnapshotPath, "utf8")).toBe(createdBytes);
  });

  test("a plan-file correction repairs a malformed repository-relative pointer and preserves every other row field", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = prepareSnapshotOf(fixture);
    const oldRow = before.plans[0]!;
    const correctedPath = join(fixture.planDir, `${PREPARE_ROW}.md`);
    // The fixture row holds the repository-relative pointer rows registered
    // before the resolver landed; the correction names that same plan's
    // canonical file and the exact pointer it replaces.
    expect(oldRow.file).toBe(`.mstar/plans/${PREPARE_ROW}.md`);

    const amended = await amendPrepare(
      fixture,
      preparePatchOf(fixture, {
        correctPlanFiles: [
          { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: correctedPath },
        ],
      }),
    );

    expect(amended.ok).toBe(true);
    expect(amended.view.allowed).toBe(true);
    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    const after = prepareSnapshotOf(fixture);
    // Only the pointer moved: the row keeps its identity, title, status,
    // metadata and position, and the appended row still lands after it.
    expect(after.plans[0]).toEqual({ ...oldRow, file: correctedPath });
    expect(after.plans[0]!.metadata).toEqual(oldRow.metadata);
    expect(after.plans[1]!.file).toBe(join(fixture.planDir, `${PREPARE_APPEND}.md`));
    expect(after.plans).toHaveLength(2);

    // A correction is a delta on its own: with the compass declaring only the
    // registered row it is admitted with an empty append array.
    const only = makePrepareFixture();
    await ensurePrepareCoordinator(only);
    writeText(only.compassPath, readFileSync(only.compassPath, "utf8").replace(`  - ${PREPARE_APPEND}\n`, ""));
    const onlyRow = prepareSnapshotOf(only).plans[0]!;
    const onlyPath = join(only.planDir, `${PREPARE_ROW}.md`);

    const correctedOnly = await amendPrepare(
      only,
      preparePatchOf(only, {
        appendPlans: [],
        correctPlanFiles: [
          { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: onlyPath },
        ],
      }),
    );

    expect(correctedOnly.view.planIds).toEqual([PREPARE_ROW]);
    expect(prepareSnapshotOf(only).plans).toEqual([{ ...onlyRow, file: onlyPath }]);

    // The declared harness-relative spelling is an accepted OLD form too — the
    // resolver reads it, and the correction canonicalizes it.
    const declared = makePrepareFixture();
    await ensurePrepareCoordinator(declared);
    writeText(declared.compassPath, readFileSync(declared.compassPath, "utf8").replace(`  - ${PREPARE_APPEND}\n`, ""));
    const declaredRow = prepareSnapshotOf(declared).plans[0]!;
    const declaredDoc = prepareSnapshotOf(declared);
    declaredDoc.plans[0]!.file = `plans/${PREPARE_ROW}.md`;
    writeJson(declared.snapshotPath, declaredDoc);

    const declaredAmended = await amendPrepare(
      declared,
      preparePatchOf(declared, {
        appendPlans: [],
        correctPlanFiles: [
          { id: PREPARE_ROW, expectedFile: `plans/${PREPARE_ROW}.md`, file: join(declared.planDir, `${PREPARE_ROW}.md`) },
        ],
      }),
    );

    expect(declaredAmended.view.planIds).toEqual([PREPARE_ROW]);
    expect(prepareSnapshotOf(declared).plans).toEqual([
      { ...declaredRow, file: join(declared.planDir, `${PREPARE_ROW}.md`) },
    ]);
  }, 30000);

  test("a plan-file correction refuses an unbindable old or new pointer without writing anything", async () => {
    const cases: ReadonlyArray<{
      name: string;
      prepare?: (fixture: PrepareFixture) => void;
      correction: (fixture: PrepareFixture) => unknown;
    }> = [
      { name: "entry-not-an-object", correction: () => "plan-prepare" },
      {
        name: "unexpected-key",
        correction: (fixture) => ({
          id: PREPARE_ROW,
          expectedFile: `.mstar/plans/${PREPARE_ROW}.md`,
          file: join(fixture.planDir, `${PREPARE_ROW}.md`),
          status: "Todo",
        }),
      },
      { name: "missing-id", correction: (fixture) => ({ expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }) },
      {
        name: "unsafe-id",
        correction: (fixture) => ({ id: "../plan-prepare", expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "unknown-row",
        correction: (fixture) => ({
          id: PREPARE_UNREVIEWED,
          expectedFile: `.mstar/plans/${PREPARE_UNREVIEWED}.md`,
          file: join(fixture.planDir, `${PREPARE_UNREVIEWED}.md`),
        }),
      },
      { name: "expected-file-missing", correction: (fixture) => ({ id: PREPARE_ROW, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }) },
      {
        // The exact value is required: a canonical absolute spelling of the
        // same pointer is not what the row holds, so the observation is stale.
        name: "expected-file-form-mismatch",
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: join(fixture.planDir, `${PREPARE_ROW}.md`), file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "expected-file-other-value",
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_APPEND}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "new-file-foreign",
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.root, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "new-file-another-plan",
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_APPEND}.md`) }),
      },
      {
        name: "new-file-traversal",
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: `../plans/${PREPARE_ROW}.md` }),
      },
      {
        name: "new-file-missing",
        prepare: (fixture) => rmSync(join(fixture.planDir, `${PREPARE_ROW}.md`)),
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "new-file-header-mismatch",
        prepare: (fixture) =>
          writeText(join(fixture.planDir, `${PREPARE_ROW}.md`), preparePlanMarkdown({ id: "plan-other", workingBranch: "feature/plan-other" })),
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        // The row's pointer names another plan: a correction repairs a
        // malformed pointer of the SAME plan, it never rebinds a row.
        name: "old-pointer-names-another-plan",
        prepare: (fixture) => {
          const doc = prepareSnapshotOf(fixture);
          doc.plans[0]!.file = `.mstar/plans/${PREPARE_APPEND}.md`;
          writeJson(fixture.snapshotPath, doc);
        },
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_APPEND}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "old-pointer-same-basename-elsewhere",
        prepare: (fixture) => {
          const doc = prepareSnapshotOf(fixture);
          doc.plans[0]!.file = `.mstar/plans/archive/${PREPARE_ROW}.md`;
          writeJson(fixture.snapshotPath, doc);
        },
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/archive/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "old-pointer-foreign-absolute",
        prepare: (fixture) => {
          const doc = prepareSnapshotOf(fixture);
          doc.plans[0]!.file = join(fixture.root, `${PREPARE_ROW}.md`);
          writeJson(fixture.snapshotPath, doc);
        },
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: join(fixture.root, `${PREPARE_ROW}.md`), file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        // A copied plan document with a matching header, under an unrelated
        // directory: neither its spelling nor its target is this plan's file.
        name: "old-pointer-copied-document-with-matching-header",
        prepare: (fixture) => {
          const copyDir = join(fixture.planDir, "copy");
          mkdirSync(copyDir, { recursive: true });
          writeText(join(copyDir, `${PREPARE_ROW}.md`), preparePlanMarkdown({ id: PREPARE_ROW, workingBranch: `feature/${PREPARE_ROW}` }));
          const doc = prepareSnapshotOf(fixture);
          doc.plans[0]!.file = `.mstar/plans/copy/${PREPARE_ROW}.md`;
          writeJson(fixture.snapshotPath, doc);
        },
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/copy/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
    ];

    for (const correctionCase of cases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      correctionCase.prepare?.(fixture);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() =>
        amendPrepare(fixture, preparePatchOf(fixture, { correctPlanFiles: [correctionCase.correction(fixture)] })),
      );

      expect(`${correctionCase.name}: ${refusal.code}`).toBe(
        `${correctionCase.name}: coordination.prepare-amendment.invalid-plan`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }

    // A correction that would not move the pointer is not a correction: the
    // already-canonical row refuses as a no-op.
    const noop = makePrepareFixture();
    await ensurePrepareCoordinator(noop);
    const canonical = join(noop.planDir, `${PREPARE_ROW}.md`);
    const noopDoc = prepareSnapshotOf(noop);
    noopDoc.plans[0]!.file = canonical;
    writeJson(noop.snapshotPath, noopDoc);
    const noopBefore = protectedBytes(noop);

    const noopRefusal = await prepareRefusalOf(() =>
      amendPrepare(
        noop,
        preparePatchOf(noop, {
          correctPlanFiles: [{ id: PREPARE_ROW, expectedFile: canonical, file: canonical }],
        }),
      ),
    );

    expect(noopRefusal.code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(protectedBytes(noop)).toEqual(noopBefore);
  }, 30000);

  test("a plan-file correction is gated by the collision, CAS and whole-workflow admission rules", async () => {
    // `correctPlanFiles` is validated as an array like every other patch key.
    const malformed = makePrepareFixture();
    await ensurePrepareCoordinator(malformed);
    const malformedBefore = protectedBytes(malformed);
    const malformedRefusal = await prepareRefusalOf(() =>
      amendPrepare(malformed, preparePatchOf(malformed, { correctPlanFiles: "plan-prepare" })),
    );
    expect(malformedRefusal.code).toBe("coordination.prepare-amendment.invalid-patch");
    expect(protectedBytes(malformed)).toEqual(malformedBefore);

    // The same id cannot be appended and corrected in one patch.
    const overlap = makePrepareFixture();
    await ensurePrepareCoordinator(overlap);
    const overlapBefore = protectedBytes(overlap);
    const overlapRefusal = await prepareRefusalOf(() =>
      amendPrepare(
        overlap,
        preparePatchOf(overlap, {
          correctPlanFiles: [
            {
              id: PREPARE_APPEND,
              expectedFile: `.mstar/plans/${PREPARE_APPEND}.md`,
              file: join(overlap.planDir, `${PREPARE_APPEND}.md`),
            },
          ],
        }),
      ),
    );
    expect(overlapRefusal.code).toBe("coordination.prepare-amendment.duplicate-plan");
    expect(protectedBytes(overlap)).toEqual(overlapBefore);

    // …and never twice in one correction list.
    const duplicate = makePrepareFixture();
    await ensurePrepareCoordinator(duplicate);
    const duplicateBefore = protectedBytes(duplicate);
    const duplicateRefusal = await prepareRefusalOf(() =>
      amendPrepare(
        duplicate,
        preparePatchOf(duplicate, {
          correctPlanFiles: [
            { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(duplicate.planDir, `${PREPARE_ROW}.md`) },
            { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(duplicate.planDir, `${PREPARE_ROW}.md`) },
          ],
        }),
      ),
    );
    expect(duplicateRefusal.code).toBe("coordination.prepare-amendment.duplicate-plan");
    expect(protectedBytes(duplicate)).toEqual(duplicateBefore);

    // A stale byte token refuses before any pointer moves.
    const stale = makePrepareFixture();
    await ensurePrepareCoordinator(stale);
    const staleView = await prepareViewOf(stale);
    const staleBefore = protectedBytes(stale);
    const staleRefusal = await prepareRefusalOf(() =>
      amendWith(
        stale,
        preparePatchOf(stale, {
          correctPlanFiles: [
            { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(stale.planDir, `${PREPARE_ROW}.md`) },
          ],
        }),
        { snapshotVersion: `sha256:${"0".repeat(64)}`, compassVersion: staleView.view.compassVersion },
      ),
    );
    expect(staleRefusal.code).toBe("coordination.prepare-amendment.stale");
    expect(protectedBytes(stale)).toEqual(staleBefore);

    // A prepared/sealed row is never repointed: the whole-workflow admission
    // refuses before the patch is even read, with the state named.
    const admissionCases: ReadonlyArray<{
      name: string;
      patch: (
        doc: { plans: Array<Record<string, unknown>> } & Record<string, unknown>,
        fixture: PrepareFixture,
      ) => void;
    }> = [
      { name: "prepared-row", patch: (doc) => { doc.plans[0]!.coordination = { revision: 1 }; } },
      {
        name: "sealed-row-lease",
        patch: (doc, fixture) => {
          doc.plans[0]!.execution_lease = {
            holder: "11111111-1111-1111-1111-111111111111",
            claimed_at: "2026-09-16T00:00:00Z",
            worktree_path: join(fixture.root, "wt-row"),
            working_branch: `feature/${PREPARE_ROW}`,
          };
        },
      },
    ];

    for (const admissionCase of admissionCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const doc = prepareSnapshotOf(fixture);
      admissionCase.patch(doc, fixture);
      writeJson(fixture.snapshotPath, doc);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() =>
        amendPrepare(
          fixture,
          preparePatchOf(fixture, {
            appendPlans: [],
            correctPlanFiles: [
              { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) },
            ],
          }),
        ),
      );

      expect(`${admissionCase.name}: ${refusal.code}`).toBe(
        `${admissionCase.name}: coordination.prepare-amendment.execution-started`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }
  }, 30000);
});
/* ------------------------------------------------------------------------ *
 * JSON Prepare coordinator recovery (prerequisite contract §3.3)
 * ------------------------------------------------------------------------ */

/** The replacement coordinator identity every single-recovery case acquires. */
const RECOVERED_COORDINATOR_ID = "recovered-coordinator";
/** A second, distinct replacement identity (the supersede/concurrency cases). */
const RECOVERED_COORDINATOR_ID_2 = "recovered-coordinator-2";

/** The recovery view of the fixture's workflow, read without any session envelope. */
function recoveryViewOf(fixture: PrepareFixture): Promise<PrepareCoordinatorRecoveryView> {
  return showPrepareCoordinatorRecovery({
    cwd: fixture.root,
    harnessDir: fixture.harness,
    workflowId: PREPARE_WORKFLOW,
  });
}

/** One recovery request carrying this workflow's own reviewed tokens. */
function recoveryInputOf(
  fixture: PrepareFixture,
  tokens: { snapshot: string; compass: string },
  overrides: Record<string, unknown> = {},
): Parameters<typeof recoverPrepareCoordinator>[0] {
  return {
    cwd: fixture.root,
    harnessDir: fixture.harness,
    identity: {
      source: "local",
      sessionId: RECOVERED_COORDINATOR_ID,
      workflowId: PREPARE_WORKFLOW,
      role: "coordinator",
      planId: null,
    },
    priorSessionPath: fixture.coordinatorSession,
    priorSessionId: FIXTURE_COORDINATOR_ID,
    expectedSnapshotVersion: tokens.snapshot,
    expectedCompassVersion: tokens.compass,
    operationId: "op-recover-1",
    reason: "the prior host session was cancelled and cannot authenticate",
    authorizationRef: "PM-authorization-20260921",
    stoppedSessionIds: [FIXTURE_COORDINATOR_ID],
    ...overrides,
  } as Parameters<typeof recoverPrepareCoordinator>[0];
}

/** One replacement identity for the multi-recovery cases. */
function recoveredIdentity(sessionId: string): Record<string, unknown> {
  return { source: "local", sessionId, workflowId: PREPARE_WORKFLOW, role: "coordinator", planId: null };
}

/** Where the engine keeps one coordinator envelope (the session-path contract). */
function coordinatorEnvelopeOf(fixture: PrepareFixture, sessionId: string): string {
  return join(fixture.harness, "workflows", PREPARE_WORKFLOW, "sessions", `coordinator-${sessionId}.json`);
}

/**
 * The stored top-level `coordination` block, narrowed by `typeof` before any
 * member is read (the snapshot JSON is `unknown` at this boundary).
 */
function coordinationBlockOf(fixture: PrepareFixture): Record<string, unknown> {
  const coordination = (prepareSnapshotOf(fixture) as Record<string, unknown>).coordination;
  // Narrowed above; the block is a plain object when present.
  return typeof coordination === "object" && coordination !== null && !Array.isArray(coordination)
    ? (coordination as Record<string, unknown>)
    : {};
}

/** The stored recovery audit of the fixture's workflow. */
function recoveryAuditOf(fixture: PrepareFixture): Array<Record<string, unknown>> {
  const recoveries = coordinationBlockOf(fixture).identity_recoveries;
  // Narrowed above; the audit is an array when present.
  return Array.isArray(recoveries) ? (recoveries as Array<Record<string, unknown>>) : [];
}

/** The stored coordinator binding of the fixture's workflow. */
function recordedCoordinatorOf(fixture: PrepareFixture): Record<string, unknown> {
  const coordinator = coordinationBlockOf(fixture).coordinator;
  // Narrowed above; the binding is a plain object when present.
  return typeof coordinator === "object" && coordinator !== null && !Array.isArray(coordinator)
    ? (coordinator as Record<string, unknown>)
    : {};
}

/**
 * A store that fails the next SNAPSHOT put once: the exact envelope-before-
 * snapshot window §3.3 requires an injectable proof for. Everything else (the
 * envelope file creation, which does not go through the store) proceeds.
 */
class FailOnceSnapshotStore implements ArtifactStore {
  readonly root: string;
  private failing = true;

  constructor(private readonly inner: ArtifactStore & { root: string }) {
    this.root = inner.root;
  }

  async put(doc: ArtifactDoc): Promise<void> {
    if (doc.kind === "snapshot" && this.failing) {
      this.failing = false;
      throw new Error("injected store failure between the envelope and the snapshot commit");
    }
    await this.inner.put(doc);
  }

  async get<T = unknown>(ref: ArtifactRef): Promise<T | undefined> {
    return this.inner.get<T>(ref);
  }
}

/**
 * A store that fails the next snapshot put once AND replaces the recovery's
 * newly created envelope with an unrelated session file first — the exact
 * "path replaced between exclusive creation and cleanup" window. Cleanup must
 * prove ownership by bytes before it unlinks anything.
 */
class ReplaceEnvelopeOnFailureStore implements ArtifactStore {
  readonly root: string;
  private failing = true;

  constructor(
    private readonly inner: ArtifactStore & { root: string },
    private readonly envelopePath: string,
    private readonly replacement: string,
  ) {
    this.root = inner.root;
  }

  async put(doc: ArtifactDoc): Promise<void> {
    if (doc.kind === "snapshot" && this.failing) {
      this.failing = false;
      writeText(this.envelopePath, this.replacement);
      throw new Error("injected store failure between the envelope and the snapshot commit");
    }
    await this.inner.put(doc);
  }

  async get<T = unknown>(ref: ArtifactRef): Promise<T | undefined> {
    return this.inner.get<T>(ref);
  }
}

describe("prepare coordinator recovery", () => {
  test("prepare coordinator recovery view reports the recorded owner and both versions without envelope bytes", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);

    const view = await recoveryViewOf(fixture);

    expect(view.workflowId).toBe(PREPARE_WORKFLOW);
    expect(view.priorSessionId).toBe(FIXTURE_COORDINATOR_ID);
    expect(view.snapshotVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(view.compassVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(view.allowed).toBe(true);
    expect(view.blockers).toEqual([]);
    // The read is owner-neutral: no envelope path, body or credential in it.
    expect(Object.keys(view).sort()).toEqual([
      "allowed",
      "blockers",
      "compassVersion",
      "priorSessionId",
      "snapshotVersion",
      "workflowId",
    ]);
    expect(JSON.stringify(view)).not.toContain(`sessions${sep}`);
    // Read-only: nothing moved.
    expect(protectedBytes(fixture)).toEqual(before);
  }, 30000);

  test("prepare coordinator recovery replaces the binding under explicit authorization and the old reference refuses", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);
    const tokens = await recoveryViewOf(fixture);
    const planRows = stableJson(prepareSnapshotOf(fixture).plans);
    const branch = stableJson(prepareSnapshotOf(fixture).branch);

    const result = await recoverPrepareCoordinator(
      recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion }),
    );

    expect(result.ok).toBe(true);
    expect(result.operation).toBe("recover-coordinator");
    expect(result.recovery.replay).toBe(false);
    expect(result.recovery.priorSessionId).toBe(FIXTURE_COORDINATOR_ID);
    expect(result.recovery.sessionId).toBe(RECOVERED_COORDINATOR_ID);
    expect(result.session.session_id).toBe(RECOVERED_COORDINATOR_ID);
    // The new envelope is role-scoped and exclusive; the old one stays as history.
    const newEnvelope = coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID);
    expect(result.session_file).toBe(newEnvelope);
    expect(readJson(newEnvelope)).toMatchObject({
      schema_version: 1,
      role: "coordinator",
      session_id: RECOVERED_COORDINATOR_ID,
      workflow_id: PREPARE_WORKFLOW,
    });
    expect(existsSync(fixture.coordinatorSession)).toBe(true);
    expect(recordedCoordinatorOf(fixture)).toMatchObject({
      session_id: RECOVERED_COORDINATOR_ID,
      session_file: newEnvelope,
    });

    // The immutable audit record carries exactly the contract's required fields.
    const audit = recoveryAuditOf(fixture);
    expect(audit).toHaveLength(1);
    expect(Object.keys(audit[0]!).sort()).toEqual([
      "authorization_ref",
      "compass_version",
      "operation_id",
      "prior_session_id",
      "reason",
      "recovered_at",
      "request_hash",
      "session_id",
      "snapshot_version_before",
      "stopped_session_ids",
      "workflow_id",
    ]);
    expect(audit[0]).toMatchObject({
      operation_id: "op-recover-1",
      workflow_id: PREPARE_WORKFLOW,
      prior_session_id: FIXTURE_COORDINATOR_ID,
      session_id: RECOVERED_COORDINATOR_ID,
      authorization_ref: "PM-authorization-20260921",
      reason: "the prior host session was cancelled and cannot authenticate",
      stopped_session_ids: [FIXTURE_COORDINATOR_ID],
      compass_version: tokens.compassVersion,
      snapshot_version_before: tokens.snapshotVersion,
    });
    expect(audit[0]!.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(audit[0]!.recovered_at).toBe(result.recovery.recoveredAt);

    // Every row, branch anchor and the sibling workflow survive byte-for-byte;
    // the prior envelope file is retained (never deleted, never rewritten).
    expect(stableJson(prepareSnapshotOf(fixture).plans)).toBe(planRows);
    expect(stableJson(prepareSnapshotOf(fixture).branch)).toBe(branch);
    expect(readFileSync(fixture.statusPath, "utf8")).toBe(before.status);
    expect(readFileSync(fixture.compassPath, "utf8")).toBe(before.compass);
    expect(readFileSync(fixture.peerSnapshotPath, "utf8")).toBe(before.peer);
    expect(readFileSync(fixture.coordinatorSession, "utf8")).toBe(before.session);

    // The old reference is historical: its envelope still names the old owner,
    // and every Prepare verb now refuses it because the BINDING moved.
    const oldUse = await prepareRefusalOf(() => prepareViewOf(fixture, fixture.coordinatorSession));
    expect(oldUse.code).toBe("coordination.session-mismatch");
    // The replacement session is the live coordinator.
    const live = await prepareViewOf(fixture, newEnvelope);
    expect(live.view.allowed).toBe(true);
    expect(live.session.session_id).toBe(RECOVERED_COORDINATOR_ID);
  }, 30000);

  test("prepare coordinator recovery refuses foreign, unauthorized, stale and executed requests without mutating", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);
    const tokens = await recoveryViewOf(fixture);
    // A second coordinator envelope that exists but is NOT the recorded binding:
    // a valid file the caller could point at, which still proves nothing.
    const impostorEnvelope = coordinatorEnvelopeOf(fixture, "impostor-session");
    writeJson(impostorEnvelope, {
      schema_version: 1,
      role: "coordinator",
      session_id: "impostor-session",
      workflow_id: PREPARE_WORKFLOW,
      harness_root: fixture.harness,
    });

    const cases: ReadonlyArray<{ name: string; overrides: Record<string, unknown>; code: string }> = [
      {
        name: "a prior session id the workflow does not record",
        overrides: { priorSessionId: "someone-else" },
        code: "coordination.identity-recovery.foreign-owner",
      },
      {
        name: "a prior envelope that is not the recorded binding",
        overrides: { priorSessionPath: impostorEnvelope, priorSessionId: "impostor-session" },
        code: "coordination.identity-recovery.foreign-owner",
      },
      {
        name: "a stop assertion that does not name the recorded holder",
        overrides: { stoppedSessionIds: ["some-other-session"] },
        code: "coordination.identity-recovery.unauthorized",
      },
      {
        name: "no stop assertion at all",
        overrides: { stoppedSessionIds: [] },
        code: "coordination.identity-recovery.unauthorized",
      },
      {
        name: "no authorization reference",
        overrides: { authorizationRef: "" },
        code: "coordination.identity-recovery.invalid-request",
      },
      { name: "no reason", overrides: { reason: "" }, code: "coordination.identity-recovery.invalid-request" },
      { name: "no operation id", overrides: { operationId: "" }, code: "coordination.identity-recovery.invalid-request" },
      {
        name: "a stale snapshot token",
        overrides: { expectedSnapshotVersion: `sha256:${"0".repeat(64)}` },
        code: "coordination.identity-recovery.stale",
      },
      {
        name: "a stale compass token",
        overrides: { expectedCompassVersion: `sha256:${"0".repeat(64)}` },
        code: "coordination.identity-recovery.stale",
      },
      {
        name: "an identity addressing a workflow that records no coordinator binding",
        overrides: {
          identity: { source: "local", sessionId: RECOVERED_COORDINATOR_ID, workflowId: PREPARE_PEER, role: "coordinator", planId: null },
        },
        code: "coordination.identity-recovery.not-prepare",
      },
      {
        name: "a plan-scoped identity",
        overrides: {
          identity: { source: "local", sessionId: RECOVERED_COORDINATOR_ID, workflowId: PREPARE_WORKFLOW, role: "coordinator", planId: "plan-a" },
        },
        code: "coordination.identity-mismatch",
      },
      {
        name: "the recorded owner itself",
        overrides: { identity: recoveredIdentity(FIXTURE_COORDINATOR_ID) },
        code: "coordination.identity-recovery.invalid-request",
      },
      {
        name: "an unknown input field",
        overrides: { force: true },
        code: "coordination.forbidden-field",
      },
    ];
    for (const recoveryCase of cases) {
      const failure = await failureOf(() =>
        recoverPrepareCoordinator(
          recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion }, recoveryCase.overrides),
        ),
      );
      const refusal = failure instanceof CoordinationError ? failure : undefined;
      expect(`${recoveryCase.name}: ${refusal?.code}`).toBe(`${recoveryCase.name}: ${recoveryCase.code}`);
      // §3.3/§5: a recovery refusal repeats neither a rejected value nor an
      // envelope path — it carries the code, the already-public ids and the
      // canonical base. The two foreign-owner cases below are the ones that once
      // interpolated both envelope paths; the invariant is pinned over every case.
      const projected = `${failure.message} ${JSON.stringify(refusal?.details ?? {})}`;
      expect(`${recoveryCase.name}: ${projected.includes(impostorEnvelope)}`).toBe(`${recoveryCase.name}: false`);
      expect(`${recoveryCase.name}: ${projected.includes(fixture.coordinatorSession)}`).toBe(`${recoveryCase.name}: false`);
      // The rejected prior session id of the first foreign-owner case is a value
      // the caller named, not a public record: it is never echoed back either.
      expect(`${recoveryCase.name}: ${projected.includes("someone-else")}`).toBe(`${recoveryCase.name}: false`);
      expect(protectedBytes(fixture)).toEqual(before);
      expect(existsSync(coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID))).toBe(false);
    }

    // An executed row (any row coordination block) is never recovered: the
    // ORIGINAL all-row admission decides, and nothing is written.
    const snapshot = prepareSnapshotOf(fixture);
    (snapshot.plans[0] as Record<string, unknown>).coordination = { revision: 1 };
    writeJson(fixture.snapshotPath, snapshot);
    const executed = protectedBytes(fixture);
    const activeRefusal = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(fixture, {
          snapshot: readArtifactBytes(fixture.snapshotPath)!.version,
          compass: tokens.compassVersion,
        }),
      ),
    );
    expect(activeRefusal.code).toBe("coordination.identity-recovery.execution-started");
    expect(protectedBytes(fixture)).toEqual(executed);
  }, 60000);

  test("prepare coordinator recovery refuses a concurrent second attempt and a replayed different request", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);

    const [first, second] = await Promise.allSettled([
      recoverPrepareCoordinator(recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion })),
      recoverPrepareCoordinator(
        recoveryInputOf(
          fixture,
          { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
          { operationId: "op-recover-2", identity: recoveredIdentity(RECOVERED_COORDINATOR_ID_2) },
        ),
      ),
    ]);

    expect([first, second].filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = [first, second].find((entry) => entry.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("expected exactly one refused concurrent recovery");
    // The loser reviewed the pre-recovery bytes, so it is refused as stale (the
    // same optimistic-concurrency verdict the amendment reports) and writes
    // nothing at all.
    expect((rejected.reason as CoordinationError).code).toBe("coordination.identity-recovery.stale");
    // Exactly one owner and exactly one audit entry: the loser wrote nothing.
    const audit = recoveryAuditOf(fixture);
    expect(audit).toHaveLength(1);
    expect(recordedCoordinatorOf(fixture).session_id).toBe(audit[0]!.session_id);
    const loserId = audit[0]!.session_id === RECOVERED_COORDINATOR_ID ? RECOVERED_COORDINATOR_ID_2 : RECOVERED_COORDINATOR_ID;
    expect(existsSync(coordinatorEnvelopeOf(fixture, loserId))).toBe(false);

    // A replayed operation id with a DIFFERENT request is not the same
    // operation: it refuses without moving anything.
    const boundBytes = readFileSync(fixture.snapshotPath, "utf8");
    const boundFile = recordedCoordinatorOf(fixture).session_file;
    const replayDifferent = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(
          fixture,
          { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
          {
            operationId: audit[0]!.operation_id as string,
            reason: "a different reason entirely",
            priorSessionId: audit[0]!.prior_session_id as string,
          },
        ),
      ),
    );
    expect(replayDifferent.code).toBe("coordination.identity-recovery.operation-conflict");
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(boundBytes);
    expect(recordedCoordinatorOf(fixture).session_file).toBe(boundFile);
  }, 60000);

  test("prepare coordinator recovery returns the recorded receipt on an exact retry without revision churn", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const request = recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion });

    const first = await recoverPrepareCoordinator(request);
    const committedBytes = readFileSync(fixture.snapshotPath, "utf8");
    const committedVersion = readArtifactBytes(fixture.snapshotPath)!.version;
    const firstEntry = recoveryAuditOf(fixture)[0]!;

    // The SAME request again — with the tokens it was authorized against, which
    // its own commit has since superseded.
    const retry = await recoverPrepareCoordinator(request);

    expect(retry.ok).toBe(true);
    expect(retry.recovery.replay).toBe(true);
    expect(retry.recovery.operationId).toBe(first.recovery.operationId);
    expect(retry.recovery.requestHash).toBe(first.recovery.requestHash);
    expect(retry.recovery.sessionId).toBe(RECOVERED_COORDINATOR_ID);
    expect(retry.session_file).toBe(first.session_file);
    // No revision churn: the snapshot bytes are still the winner's.
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(committedBytes);
    expect(readArtifactBytes(fixture.snapshotPath)!.version).toBe(committedVersion);
    expect(recoveryAuditOf(fixture)).toHaveLength(1);

    // A second, distinct recovery appends EXACTLY one entry and preserves the
    // whole previous prefix by value.
    const second = await recoverPrepareCoordinator(
      recoveryInputOf(
        fixture,
        { snapshot: committedVersion, compass: tokens.compassVersion },
        {
          operationId: "op-recover-3",
          identity: recoveredIdentity(RECOVERED_COORDINATOR_ID_2),
          priorSessionId: RECOVERED_COORDINATOR_ID,
          priorSessionPath: first.session_file,
          stoppedSessionIds: [RECOVERED_COORDINATOR_ID],
        },
      ),
    );
    expect(second.recovery.replay).toBe(false);
    expect(second.recovery.sessionId).toBe(RECOVERED_COORDINATOR_ID_2);
    const audit = recoveryAuditOf(fixture);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toEqual(firstEntry);

    // The first operation's replay is no longer this workflow's state.
    const superseded = await prepareRefusalOf(() => recoverPrepareCoordinator(request));
    expect(superseded.code).toBe("coordination.identity-recovery.operation-conflict");
  }, 60000);

  test("prepare coordinator recovery reclaims only its own envelope after an envelope-before-snapshot failure", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const newEnvelope = coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID);
    const before = protectedBytes(fixture);
    const request = recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion });

    // An IO failure between the exclusive envelope creation and the snapshot
    // commit is NOT a semantic refusal: the call reports failure, never a
    // success receipt, and reclaims exactly the envelope it created.
    instrumentLocalStore(fixture.harness, (inner) => new FailOnceSnapshotStore(inner));
    await expect(recoverPrepareCoordinator(request)).rejects.toThrow(/injected store failure/);
    expect(existsSync(newEnvelope)).toBe(false);
    expect(protectedBytes(fixture)).toEqual(before);
    expect(recoveryAuditOf(fixture)).toEqual([]);

    // The retry is lawful: nothing was left behind, and the reviewed tokens
    // still describe the same authorized request.
    setArtifactStore(createFsStore(fixture.harness));
    const retry = await recoverPrepareCoordinator(request);
    expect(retry.recovery.replay).toBe(false);
    expect(recoveryAuditOf(fixture)).toHaveLength(1);

    // A leftover envelope is reclaimed ONLY when its bytes are exactly the ones
    // this call would write. Those bytes are the session JSON, so they prove the
    // same TARGET SESSION — not the same operation.
    const crashed = makePrepareFixture();
    await ensurePrepareCoordinator(crashed);
    const crashedTokens = await recoveryViewOf(crashed);
    writeText(
      coordinatorEnvelopeOf(crashed, RECOVERED_COORDINATOR_ID),
      `${JSON.stringify(
        {
          schema_version: 1,
          role: "coordinator",
          session_id: RECOVERED_COORDINATOR_ID,
          workflow_id: PREPARE_WORKFLOW,
          harness_root: crashed.harness,
        },
        null,
        2,
      )}\n`,
    );
    const reclaimed = await recoverPrepareCoordinator(
      recoveryInputOf(crashed, { snapshot: crashedTokens.snapshotVersion, compass: crashedTokens.compassVersion }),
    );
    expect(reclaimed.recovery.replay).toBe(false);
    expect(recoveryAuditOf(crashed)).toHaveLength(1);

    // A file that is NOT this operation's envelope is never overwritten.
    const alien = makePrepareFixture();
    await ensurePrepareCoordinator(alien);
    const alienTokens = await recoveryViewOf(alien);
    const alienEnvelope = coordinatorEnvelopeOf(alien, RECOVERED_COORDINATOR_ID);
    writeText(alienEnvelope, `${JSON.stringify({ schema_version: 1, role: "coordinator", session_id: "someone-else" })}\n`);
    const alienBytes = readFileSync(alienEnvelope, "utf8");
    const refusal = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(alien, { snapshot: alienTokens.snapshotVersion, compass: alienTokens.compassVersion }),
      ),
    );
    expect(refusal.code).toBe("coordination.identity-recovery.invalid-request");
    expect(readFileSync(alienEnvelope, "utf8")).toBe(alienBytes);
    expect(recoveryAuditOf(alien)).toEqual([]);
  }, 60000);

  test("prepare coordinator recovery re-checks the reviewed compass before committing and reclaims only its own envelope", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const before = protectedBytes(fixture);
    const newEnvelope = coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID);

    // A concurrent compass edit lands in the window between this recovery's
    // exclusive envelope creation and its commit CAS. The snapshot write lock
    // does not lock the compass file, so without the final recheck the recovery
    // would commit and record a `compass_version` that was no longer current.
    setPrepareRecoveryEnvelopeGapForTest(() => {
      writeText(fixture.compassPath, `${readFileSync(fixture.compassPath, "utf8")}\n`);
    });
    let refusal: { code: string; details: Record<string, unknown> };
    try {
      refusal = await prepareRefusalOf(() =>
        recoverPrepareCoordinator(
          recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion }),
        ),
      );
    } finally {
      setPrepareRecoveryEnvelopeGapForTest(undefined);
    }

    expect(refusal.code).toBe("coordination.identity-recovery.stale");
    // No snapshot mutation, no audit entry, and only THIS operation's envelope
    // reclaimed; the prior envelope stays as history.
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before.snapshot);
    expect(readFileSync(fixture.coordinatorSession, "utf8")).toBe(before.session);
    expect(recoveryAuditOf(fixture)).toEqual([]);
    expect(existsSync(newEnvelope)).toBe(false);
    expect(readdirSync(join(fixture.workflowDir, "sessions"))).toEqual([basename(fixture.coordinatorSession)]);

    // The refusal wrote nothing, so a re-reviewed recovery is lawful.
    const fresh = await recoveryViewOf(fixture);
    const retry = await recoverPrepareCoordinator(
      recoveryInputOf(fixture, { snapshot: fresh.snapshotVersion, compass: fresh.compassVersion }),
    );
    expect(retry.recovery.replay).toBe(false);
    expect(recoveryAuditOf(fixture)).toHaveLength(1);
  }, 60000);

  test("prepare coordinator recovery never unlinks an envelope that was replaced after its exclusive creation", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const before = protectedBytes(fixture);
    const newEnvelope = coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID);
    const alien = `${JSON.stringify({ schema_version: 1, role: "plan-pm", session_id: "somebody-else" })}\n`;

    // The snapshot commit fails AND the path this call created exclusively has
    // since been replaced by an unrelated session file: `created` is only a
    // historical boolean, so cleanup must compare the CURRENT bytes before it
    // unlinks anything, and leave the replacement untouched.
    instrumentLocalStore(
      fixture.harness,
      (inner) => new ReplaceEnvelopeOnFailureStore(inner, newEnvelope, alien),
    );
    await expect(
      recoverPrepareCoordinator(recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion })),
    ).rejects.toThrow(/injected store failure/);
    setArtifactStore(createFsStore(fixture.harness));

    expect(readFileSync(newEnvelope, "utf8")).toBe(alien);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before.snapshot);
    expect(readFileSync(fixture.coordinatorSession, "utf8")).toBe(before.session);
    expect(recoveryAuditOf(fixture)).toEqual([]);
  }, 60000);

  test("prepare coordinator recovery refuses a malformed stop-list entry before hashing, storing or echoing it", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const before = protectedBytes(fixture);

    // A stop entry is hashed into the request digest and persisted in the
    // immutable audit: only public session ids are acceptable, never an
    // arbitrary string (path-like or credential-like). The refusal is itself a
    // PUBLIC diagnostic (§5), so it must not repeat the rejected value — the
    // caller learns the rule and the entry's position/length instead.
    const rejected = ["a/b", "../creds/secret.json", `ghp_${"a".repeat(140)}`, "with space"];
    for (const entry of rejected) {
      const failure = await failureOf(() =>
        recoverPrepareCoordinator(
          recoveryInputOf(
            fixture,
            { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
            { stoppedSessionIds: [FIXTURE_COORDINATOR_ID, entry] },
          ),
        ),
      );
      if (!(failure instanceof CoordinationError)) throw failure;
      const label = `${JSON.stringify(entry).slice(0, 12)}:`;
      expect(`${label} ${failure.code}`).toBe(`${label} coordination.identity-recovery.invalid-request`);
      expect(failure.message).toContain("public session id");
      expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toContain(entry);
      expect(failure.details).toMatchObject({ index: 1, length: entry.length });
      expect(protectedBytes(fixture)).toEqual(before);
      expect(existsSync(coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID))).toBe(false);
    }

    // An empty entry is refused by the same field rule (it is not a session id
    // at all), and a non-array stop assertion reports its SHAPE rather than the
    // value it was given.
    const blank = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(
          fixture,
          { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
          { stoppedSessionIds: [FIXTURE_COORDINATOR_ID, ""] },
        ),
      ),
    );
    expect(blank.code).toBe("coordination.identity-recovery.invalid-request");
    const notAList = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(
          fixture,
          { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
          { stoppedSessionIds: "credential-like-secret" },
        ),
      ),
    );
    expect(notAList.code).toBe("coordination.identity-recovery.unauthorized");
    expect(JSON.stringify(notAList.details)).not.toContain("credential-like-secret");
    expect(protectedBytes(fixture)).toEqual(before);
  }, 60000);

  test("prepare coordinator recovery never runs the JSON writer under an active execution authority", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const before = protectedBytes(fixture);

    // A REAL active execution authority on a genuinely separate control root
    // (its own Git repo and its own `.mstar`, so the store probe addresses it and
    // not this fixture's root): the create-only empty-execution initializer needs
    // an empty execution workspace, which is exactly what such a root is. The
    // authority veto decides before any payload, token or path is inspected, so
    // the fixture's reviewed tokens and recorded binding are never reached.
    const activeRoot = realpathSync(mkdtempSync(join(tmpdir(), "mstar-recovery-active-")));
    roots.push(activeRoot);
    git(["init", "-q", "-b", "main"], activeRoot);
    const activeHarness = join(activeRoot, ".mstar");
    mkdirSync(activeHarness, { recursive: true });
    const handle = await initializeStore({ harnessDir: activeHarness });
    handle.close();
    await initializeExecutionAuthority({ harnessDir: activeHarness });

    const failure = await failureOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(
          fixture,
          { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
          { cwd: activeRoot, harnessDir: activeHarness },
        ),
      ),
    );
    expect("code" in failure && typeof failure.code === "string" ? failure.code : "").toBe("execution.direct-write-refused");
    // ... and it points at the existing DB recovery verb instead of aliasing it.
    expect(failure.message).toContain("session recover");
    expect(existsSync(coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID))).toBe(false);
    expect(protectedBytes(fixture)).toEqual(before);
  }, 60000);
});
