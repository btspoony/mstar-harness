/**
 * Prepare workflow amendment and prepare coordinator recovery families.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
  amendPrepareWorkflow,
  bindPlanSession,
  mutatePlanCoordination,
  readPlanCoordination,
  recoverPrepareCoordinator,
  replaceCoordinatedArtifact,
  resolveProcessHarnessDir,
  showPrepareCoordinatorRecovery,
  showPrepareWorkflow,
  type PrepareCoordinatorRecoveryView,
  type PrepareWorkflowPatch,
  type PrepareWorkflowResult,
} from "../src/coordination.js";
import { initializeExecutionAuthority } from "../src/execution-store.js";
import type { RecoveryDetails } from "../src/recovery-intent.js";
import { ACTIVATION_PROTOCOL_VERSION, type ActivationAttestation } from "../src/store-activation.js";
import { initializeStore } from "../src/store-db.js";
import { CoordinationError } from "../src/coordination-write.js";
import { registerWorkflow } from "../src/status.js";
import { createFsStore, setArtifactStore, type ArtifactDoc, type ArtifactRef, type ArtifactStore } from "../src/store.js";
import { writeWorkflowSnapshot, type WorkflowSnapshot } from "../src/workflow.js";
import {
  FIXTURE_COORDINATOR_ID,
  PLAN_ID,
  PROJECT_ID,
  WORKFLOW_ID,
  afterEachCleanup,
  assignmentText,
  errorCodeOf,
  ensureCoordinator,
  coordinatorCall,
  prepareCall,
  progressCall,
  git,
  makeFixture,
  planRow,
  planRowOf,
  readJson,
  updatePlanRow,
  writeJson,
  writeText,
  roots,
  type Fixture,
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

async function amendPrepare(fixture: PrepareFixture, patch: unknown): Promise<PrepareWorkflowResult> {
  return amendWith(fixture, patch);
}

/** Amend one patch through the coordinator-authenticated Prepare route. */
function amendWith(
  fixture: PrepareFixture,
  patch: unknown,
  options: { sessionPath?: string; cwd?: string } = {},
): Promise<PrepareWorkflowResult> {
  return amendPrepareWorkflow({
    sessionPath: options.sessionPath ?? fixture.coordinatorSession,
    cwd: options.cwd ?? fixture.root,
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
  test("show-prepare reports the admission view without writing", async () => {
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
    // A read writes nothing.
    
  });

  test("amend-prepare appends the approved row and records the integration checkout and parallelism, preserving every prior value", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const beforeSnapshot = prepareSnapshotOf(fixture);
    const oldRow = beforeSnapshot.plans[0]!;

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

    // A second show reports the authorized plan selection.
    const afterView = await prepareViewOf(fixture);
    expect(afterView.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
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

  test("a plan that declares no branch form, or a policy naming no feature worktree, refuses an appended plan", async () => {
    // #278/A07: the plan document is still the reviewed authority for the row's
    // branch, but the DECLARATION that establishes it is whatever form the
    // document actually carries — the literal `Working branch` header, or a
    // `Working branch policy` naming a feature worktree (derived as the plan's
    // own feature branch). What still refuses is a document that establishes no
    // branch at all: never a prose sentence scanned for a branch-shaped token.
    const planCases: ReadonlyArray<{
      name: string;
      lines: readonly string[];
      /** The field the refusal must name. */
      field: string;
      /** A phrase the message must carry, so the refusal stays actionable. */
      names: string;
    }> = [
      {
        name: "no-branch-declaration",
        lines: [
          `**plan_id:** ${PREPARE_APPEND}`,
          "**Status:** Todo",
          "**Main worktree branch:** main",
        ],
        field: "metadata.working_branch",
        names: "declares no branch declaration",
      },
      {
        name: "policy-names-no-feature-worktree",
        lines: [
          `**plan_id:** ${PREPARE_APPEND}`,
          "**Status:** Todo",
          "**Main worktree branch:** main",
          "**Working branch policy:** Work happens directly on the integration branch; merge back into it.",
        ],
        field: "metadata.working_branch",
        names: "names no feature worktree",
      },
      {
        name: "missing-main-worktree-branch",
        lines: [`**plan_id:** ${PREPARE_APPEND}`, "**Status:** Todo", `**Working branch:** feature/${PREPARE_APPEND}`],
        field: "mainWorktreeBranch",
        names: "Main worktree branch",
      },
    ];

    for (const planCase of planCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const planPath = join(fixture.planDir, `${PREPARE_APPEND}.md`);
      writeText(planPath, [`# Plan ${PREPARE_APPEND}`, "", ...planCase.lines, "", "Body.", ""].join("\n"));
      const beforeRows = prepareSnapshotOf(fixture).plans.map(({ id, status, file }) => ({ id, status, file }));

      const failure = await failureOf(() => amendPrepare(fixture, preparePatchOf(fixture)));
      if (!(failure instanceof CoordinationError)) throw failure;

      const label = `${planCase.name}: `;
      expect(`${label}${failure.code}`).toBe(`${label}coordination.prepare-amendment.invalid-plan`);
      // The refusal names the missing declaration, the row and the reviewed
      // file as facts, so it stays actionable without pinning one sentence.
      expect(failure.message).toContain(planCase.names);
      expect(failure.message).toContain(planPath);
      expect(failure.details).toMatchObject({ plan_id: PREPARE_APPEND, field: planCase.field, path: planPath });
      expect(prepareSnapshotOf(fixture).plans.map(({ id, status, file }) => ({ id, status, file }))).toEqual(beforeRows);
    }
  });

  test("concurrent append retries converge on one row and one applied effect", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const patch = preparePatchOf(fixture, { planParallelism: "parallel" });

    const results = await Promise.all([amendWith(fixture, patch), amendWith(fixture, patch)]);
    expect(results.map((entry) => entry.outcome).sort()).toEqual(["already-satisfied", "amended"]);
    expect(prepareSnapshotOf(fixture).plans.map((row) => row.id)).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(prepareSnapshotOf(fixture).execution_policy?.plan_parallelism).toBe("parallel");
  });

  test("current field values permit unrelated drift but still reject a changed plan path", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const drifted = prepareSnapshotOf(fixture);
    drifted.plans.push(planRow(PREPARE_UNREVIEWED, PROJECT_ID));
    writeJson(fixture.snapshotPath, drifted);
    writeText(
      fixture.compassPath,
      [readFileSync(fixture.compassPath, "utf8"), "Reviewed prose added after the caller's read.", ""].join("\n"),
    );
    const landed = await amendWith(
      fixture,
      preparePatchOf(fixture, {
        appendPlans: [],
        correctPlanFiles: [{ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }],
      }),
    );
    expect(landed.outcome).toBe("amended");
    expect(landed.recovery?.applied).toEqual([`correct-plan-file ${PREPARE_ROW}`]);
    expect(prepareSnapshotOf(fixture).plans.map((row) => row.id)).toEqual([PREPARE_ROW, PREPARE_UNREVIEWED]);
    expect(prepareSnapshotOf(fixture).plans[0]!.file).toBe(join(fixture.planDir, `${PREPARE_ROW}.md`));

    const semantic = makePrepareFixture();
    await ensurePrepareCoordinator(semantic);
    const moved = prepareSnapshotOf(semantic);
    moved.plans[0]!.file = `.mstar/plans/${PREPARE_UNREVIEWED}.md`;
    writeJson(semantic.snapshotPath, moved);
    const before = protectedBytes(semantic);
    const refusal = await prepareRefusalOf(() =>
      amendWith(
        semantic,
        preparePatchOf(semantic, {
          appendPlans: [],
          correctPlanFiles: [{ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(semantic.planDir, `${PREPARE_ROW}.md`) }],
        }),
      ),
    );
    expect(refusal.code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(refusal.details).toMatchObject({
      plan_id: PREPARE_ROW,
      expected: `.mstar/plans/${PREPARE_ROW}.md`,
      actual: `.mstar/plans/${PREPARE_UNREVIEWED}.md`,
    });
    
  });

  test("a wrong-role, forged, relocated or foreign-root envelope refuses with the existing auth errors", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
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

    // A real envelope of the wrong role is never a coordinator session.
    const planPm = envelope({ role: "plan-pm", session_id: "plan-pm-envelope" });
    expect(typeof (await prepareRefusalOf(() => prepareViewOf(fixture, planPm))).code).toBe("string");

    // A forged coordinator envelope: a session id the snapshot never bound.
    const forged = envelope({ session_id: "22222222-2222-2222-2222-222222222222" });
    expect(typeof (await prepareRefusalOf(() => prepareViewOf(fixture, forged))).code).toBe("string");

    // The bound session at another path: identity is the canonical file, never a copy.
    const relocated = join(fixture.root, "relocated-envelope.json");
    writeText(relocated, readFileSync(fixture.coordinatorSession, "utf8"));
    expect(typeof (await prepareRefusalOf(() => prepareViewOf(fixture, relocated))).code).toBe("string");

    // An envelope claiming another harness root: the active store is the control root.
    const foreign = envelope({ session_id: "33333333-3333-3333-3333-333333333333", harness_root: join(fixture.root, "other-harness") });
    expect((await prepareRefusalOf(() => prepareViewOf(fixture, foreign))).code).toBe("coordination.path-mismatch");
  });

  test("an unregistered workflow refuses before the read or the amendment can proceed", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const root = readJson(fixture.statusPath);
    root.workflows = (root.workflows as Array<Record<string, unknown>>).filter((entry) => entry.id !== PREPARE_WORKFLOW);
    writeJson(fixture.statusPath, root);
    const before = protectedBytes(fixture);

    expect((await prepareRefusalOf(() => prepareViewOf(fixture))).code).toBe("coordination.workflow-not-found");
    expect(
      (
        await prepareRefusalOf(() =>
          amendWith(fixture, preparePatchOf(fixture)),
        )
      ).code,
    ).toBe("coordination.workflow-not-found");
    
  });

  test("only the lifecycle state refuses; an unrelated running row, a forward phase label or a merge lease no longer blocks the amendment", async () => {
    // E07 action-local admission (design §4.1): the amendment is admitted while
    // the addressed lifecycle is a REGISTERED RUNNING workflow. A sibling row's
    // status, progress, lease or coordination block belongs to that row's own
    // work — it is preserved by value and never blocks adding independently
    // authorized work or repairing another row's pointer (A06).
    const lifecycleCases: ReadonlyArray<{
      name: string;
      code: string;
      patchSnapshot: (doc: { plans: Array<Record<string, unknown>> } & Record<string, unknown>, fixture: PrepareFixture) => void;
    }> = [
      {
        name: "terminal",
        code: "coordination.prepare-amendment.not-prepare",
        patchSnapshot: (doc) => {
          doc.status = "completed";
          doc.ended_at = "2026-09-16";
        },
      },
      {
        name: "root-entry-not-running",
        code: "coordination.prepare-amendment.not-prepare",
        patchSnapshot: (_doc, fixture) => {
          const register = readJson(fixture.statusPath) as { workflows: Array<Record<string, unknown>> };
          register.workflows[0]!.status = "completed";
          writeJson(fixture.statusPath, register);
        },
      },
    ];

    for (const lifecycleCase of lifecycleCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const doc = prepareSnapshotOf(fixture);
      lifecycleCase.patchSnapshot(doc, fixture);
      writeJson(fixture.snapshotPath, doc);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() => amendWith(fixture, preparePatchOf(fixture)));

      // The case name names the state; the code names the refusal reason.
      expect(`${lifecycleCase.name}: ${refusal.code}`).toBe(`${lifecycleCase.name}: ${lifecycleCase.code}`);
      

      // The read reports the same state as a blocker instead of a refusal.
      const readOnly = await prepareViewOf(fixture);
      expect(readOnly.view.allowed).toBe(false);
      expect(readOnly.view.blockers).toHaveLength(1);
    }

    // The admitted states: the sibling row (or the recorded phase label, or an
    // in-flight integration merge) is NOT part of the append's read set, so the
    // append lands and every unrelated byte of that row survives unchanged. The
    // stage view still reports what moved the lifecycle off a pristine Prepare.
    const driftCases: ReadonlyArray<{
      name: string;
      blocker: string;
      patchSnapshot: (doc: { plans: Array<Record<string, unknown>> } & Record<string, unknown>, fixture: PrepareFixture) => void;
    }> = [
      { name: "phase-2", blocker: "not-prepare", patchSnapshot: (doc) => { doc.phase = "phase-2-execute"; } },
      { name: "row-in-progress", blocker: "execution-started", patchSnapshot: (doc) => { doc.plans[0]!.status = "InProgress"; } },
      { name: "row-progress", blocker: "execution-started", patchSnapshot: (doc) => { doc.plans[0]!.progress = 40; } },
      {
        name: "row-execution-lease",
        blocker: "execution-started",
        patchSnapshot: (doc, fixture) => {
          doc.plans[0]!.execution_lease = {
            holder: "11111111-1111-1111-1111-111111111111",
            claimed_at: "2026-09-16T00:00:00Z",
            worktree_path: join(fixture.root, "wt-row"),
            working_branch: `feature/${PREPARE_ROW}`,
          };
        },
      },
      {
        name: "row-coordination",
        blocker: "execution-started",
        patchSnapshot: (doc) => { doc.plans[0]!.coordination = { revision: 1 }; },
      },
      {
        name: "integration-merge-lease",
        blocker: "execution-started",
        patchSnapshot: (doc) => {
          doc.integration_merge_lease = {
            holder: "11111111-1111-1111-1111-111111111111",
            claimed_at: "2026-09-16T00:00:00Z",
            plan_id: PREPARE_ROW,
            source_branch: `feature/${PREPARE_ROW}`,
            target_branch: PREPARE_INTEGRATION_BRANCH,
          };
        },
      },
    ];

    for (const driftCase of driftCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const doc = prepareSnapshotOf(fixture);
      driftCase.patchSnapshot(doc, fixture);
      const siblingRow = doc.plans[0]!;
      writeJson(fixture.snapshotPath, doc);

      const amended = await amendPrepare(fixture, preparePatchOf(fixture));

      expect(`${driftCase.name}: ${amended.view.planIds.join()}`).toBe(
        `${driftCase.name}: ${[PREPARE_ROW, PREPARE_APPEND].join()}`,
      );
      // The unrelated row is preserved by value — the drift is not "repaired",
      // rewritten or reset to Todo by an amendment that never addressed it.
      expect(prepareSnapshotOf(fixture).plans[0]).toEqual(siblingRow);
      // ...and the stage view reports the drift without making it a dead end:
      // the fact is named, and the repair above still landed.
      const readOnly = await prepareViewOf(fixture);
      expect(`${driftCase.name}: ${readOnly.view.allowed}`).toBe(`${driftCase.name}: false`);
      expect(`${driftCase.name}: ${readOnly.view.blockers.join(" ")}`).toMatch(
        new RegExp(`${driftCase.name}: .*${driftCase.blocker}`),
      );
    }
  }, 60000);

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
      
    }
  }, 60000);

  test("the reviewed compass approves the addressed plans; its plan set is not an equality gate", async () => {
    const undeclared = makePrepareFixture();
    await ensurePrepareCoordinator(undeclared);
    const undeclaredRefusal = await prepareRefusalOf(() =>
      amendPrepare(undeclared, preparePatchOf(undeclared, { appendPlans: [prepareAppendOf(undeclared, PREPARE_UNREVIEWED)] })),
    );
    expect(undeclaredRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(undeclaredRefusal.details.undeclared).toEqual([PREPARE_UNREVIEWED]);

    // The compass declares a plan this patch leaves unregistered: that is
    // missing registration the plan's own ordinary append repairs, so the
    // addressed work lands and the gap is reported as a warning instead of
    // blocking it (§4.1/A06).
    const incomplete = makePrepareFixture();
    await ensurePrepareCoordinator(incomplete);
    writeText(
      incomplete.compassPath,
      readFileSync(incomplete.compassPath, "utf8").replace(`  - ${PREPARE_APPEND}\n`, `  - ${PREPARE_APPEND}\n  - ${PREPARE_UNREVIEWED}\n`),
    );
    const incompleteResult = await amendPrepare(incomplete, preparePatchOf(incomplete));
    expect(incompleteResult.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(incompleteResult.recovery?.outcome).toBe("applied");
    expect(incompleteResult.recovery?.warnings.map((entry) => entry.code)).toContain("coordination.compass-plan-missing");
    expect(incompleteResult.recovery?.warnings.find((entry) => entry.code === "coordination.compass-plan-missing")?.message).toContain(
      PREPARE_UNREVIEWED,
    );
    // The existing row was neither re-pointed nor deleted to make the sets equal.
    expect(prepareSnapshotOf(incomplete).plans).toHaveLength(2);

    // A row the compass does not declare is isolated drift: preserved by value,
    // reported, never a reason to withhold the addressed append.
    const undeclaredRow = makePrepareFixture();
    await ensurePrepareCoordinator(undeclaredRow);
    writeText(
      undeclaredRow.compassPath,
      readFileSync(undeclaredRow.compassPath, "utf8").replace(`  - ${PREPARE_ROW}\n`, ""),
    );
    const undeclaredRowResult = await amendPrepare(undeclaredRow, preparePatchOf(undeclaredRow));
    expect(undeclaredRowResult.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(undeclaredRowResult.recovery?.warnings.map((entry) => entry.code)).toContain(
      "coordination.compass-plan-undeclared",
    );

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
    

    // The declaration is the reviewed state, so a workflow that has not
    // recorded the reviewed checkout yet refuses the same way.
    const unrecorded = makePrepareFixture();
    await ensurePrepareCoordinator(unrecorded);
    writeText(unrecorded.compassPath, withDeclaredPath(unrecorded.integrationPath));
    const unrecordedBefore = protectedBytes(unrecorded);

    const unrecordedRefusal = await prepareRefusalOf(() => amendPrepare(unrecorded, preparePatchOf(unrecorded)));

    expect(unrecordedRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
    

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
        amendPrepare(fixture, preparePatchOf(fixture, { appendPlans: [], integrationWorktreePath: candidate })),
      );

      expect(`${worktreeCase.name}: ${refusal.code}`).toBe(
        `${worktreeCase.name}: coordination.prepare-amendment.invalid-worktree`,
      );
      
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

    const before = protectedBytes(fixture);
    const refusal = await prepareRefusalOf(() =>
      amendWith(fixture, preparePatchOf(fixture, { appendPlans: [], integrationWorktreePath: cloneCheckout }), { cwd: clone }),
    );
    expect(refusal.code).toBe("coordination.prepare-amendment.invalid-worktree");
    
    expect(prepareSnapshotOf(fixture).integration_worktree_path).toBeUndefined();

    // The legitimate call from the control root's own repository still records
    // that repository's reviewed checkout.
    const amended = await amendPrepare(fixture, preparePatchOf(fixture, { integrationWorktreePath: fixture.integrationPath }));
    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(prepareSnapshotOf(fixture).integration_worktree_path).toBe(fixture.integrationPath);
  }, 30000);


  test("unknown patch keys, malformed values and an empty patch refuse as invalid-patch", async () => {
    const cases: ReadonlyArray<{ name: string; patch: (fixture: PrepareFixture) => Record<string, unknown> }> = [
      { name: "unknown-key", patch: (fixture) => preparePatchOf(fixture, { replacePlans: [] }) },
      { name: "missing-main-branch", patch: (fixture) => preparePatchOf(fixture, { mainWorktreeBranch: undefined }) },
      { name: "appends-not-an-array", patch: (fixture) => preparePatchOf(fixture, { appendPlans: "plan-append" }) },
      // A malformed policy value is COMPONENT-scoped (it belongs to the connected
      // integration/policy group), not a patch-wide shape failure: the case below
      // addresses nothing else, so the policy component alone is withheld, the
      // refusal keeps its `invalid-patch` code and no byte moves. The aggregation
      // of a malformed policy beside an independent component is covered by
      // "a malformed policy withholds only the connected group it belongs to".
      { name: "bad-parallelism", patch: (fixture) => preparePatchOf(fixture, { appendPlans: [], planParallelism: "maybe" }) },
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
      
    }

    // §5/A09/A12 a patch that re-states the recorded path and policy is the
    // effect ALREADY HELD, not a no-op refusal: both components are recognized,
    // the receipt says so, and no byte moves. (This supersedes the pre-E08
    // `invalid-patch` refusal for a satisfied re-statement.)
    const noop = makePrepareFixture();
    await ensurePrepareCoordinator(noop);
    writeText(
      noop.compassPath,
      readFileSync(noop.compassPath, "utf8").replace(`  - ${PREPARE_APPEND}\n`, ""),
    );
    await amendPrepare(noop, preparePatchOf(noop, { appendPlans: [], integrationWorktreePath: noop.integrationPath }));
    const before = protectedBytes(noop);
    const held = await amendPrepare(
      noop,
      preparePatchOf(noop, { appendPlans: [], integrationWorktreePath: noop.integrationPath, planParallelism: "serial" }),
    );
    expect(held.outcome).toBe("already-satisfied");
    expect(held.recovery?.outcome).toBe("already-satisfied");
    expect(held.recovery?.applied).toEqual([]);
    expect(held.recovery?.warnings.map((entry) => entry.code)).toEqual([
      "coordination.prepare-amendment.held",
      "coordination.prepare-amendment.held",
    ]);
    expect(held.recovery?.warnings.map((entry) => entry.path)).toEqual([
      `integration-worktree ${noop.integrationPath}`,
      "execution-policy serial",
    ]);
    expect(held.recovery?.commitState).toBe("none");
    
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
    
  });

  test("the generic snapshot writers still refuse the same row delta", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const current = prepareSnapshotOf(fixture);
    const before = protectedBytes(fixture);
    const proposed = {
      ...current,
      updated_at: "2026-09-16T12:00:00.000Z",
      plans: [...current.plans, { id: "plan-smuggled", title: "Smuggled", file: "plans/plan-smuggled.md", status: "Todo" }],
    } as unknown as WorkflowSnapshot;

    const generic = await prepareRefusalOf(() =>
      writeWorkflowSnapshot(proposed, fixture.workflowDir, { sessionPath: fixture.coordinatorSession }),
    );
    expect(generic.code).toBe("coordination.direct-write-refused");
    expect(prepareSnapshotOf(fixture).plans.map(({ id, status, file }) => ({ id, status, file }))).toEqual(
      current.plans.map(({ id, status, file }) => ({ id, status, file })),
    );

    const replacement = await prepareRefusalOf(() =>
      replaceCoordinatedArtifact({
        harnessRoot: fixture.harness,
        ref: { kind: "snapshot", key: PREPARE_WORKFLOW },
        payload: proposed,
        sessionPath: fixture.coordinatorSession,
      }),
    );
    expect(replacement.code).toBe("coordination.direct-write-refused");
    expect(prepareSnapshotOf(fixture).plans.some((row) => row.id === "plan-smuggled")).toBe(false);
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

    const recreate = await prepareRefusalOf(() => writeWorkflowSnapshot(orphan, orphanDir, { createOnly: true }));
    expect(recreate.code).toBe("coordination.direct-write-refused");
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
        amendPrepare(fixture, preparePatchOf(fixture, { appendPlans: [], correctPlanFiles: [correctionCase.correction(fixture)] })),
      );

      expect(`${correctionCase.name}: ${refusal.code}`).toBe(
        `${correctionCase.name}: coordination.prepare-amendment.invalid-plan`,
      );
      
    }

    // §5/A09/A12 the exact already-applied correction is a CURRENT SUCCESS: a
    // row that already records this plan's canonical file has the requested
    // effect, so the call returns the current state and writes nothing. (This
    // supersedes the pre-E08 no-op refusal: `coordination.prepare-amendment`
    // no longer refuses an intent whose effect already holds.)
    const noop = makePrepareFixture();
    await ensurePrepareCoordinator(noop);
    const canonical = join(noop.planDir, `${PREPARE_ROW}.md`);
    const noopDoc = prepareSnapshotOf(noop);
    noopDoc.plans[0]!.file = canonical;
    writeJson(noop.snapshotPath, noopDoc);
    const noopBefore = protectedBytes(noop);
    const current = await amendPrepare(
      noop,
      preparePatchOf(noop, {
        appendPlans: [],
        correctPlanFiles: [{ id: PREPARE_ROW, expectedFile: canonical, file: canonical }],
      }),
    );
    expect(current.outcome).toBe("already-satisfied");
    expect(current.recovery?.outcome).toBe("already-satisfied");
    // Nothing was applied twice: the component is recognized BY NAME in the
    // warnings, and `applied` stays empty because this call recorded nothing.
    expect(current.recovery?.applied).toEqual([]);
    expect(current.recovery?.warnings.map((entry) => entry.code)).toEqual([
      "coordination.compass-plan-missing",
      "coordination.prepare-amendment.held",
    ]);
    expect(current.recovery?.warnings.find((entry) => entry.code === "coordination.prepare-amendment.held")?.path).toBe(
      `correct-plan-file ${PREPARE_ROW}`,
    );
    expect(current.recovery?.commitState).toBe("none");
    
  }, 30000);

  test("a plan-file correction is gated by the collision, CAS and addressed-row rules", async () => {
    // `correctPlanFiles` is validated as an array like every other patch key.
    const malformed = makePrepareFixture();
    await ensurePrepareCoordinator(malformed);
    const malformedBefore = protectedBytes(malformed);
    const malformedRefusal = await prepareRefusalOf(() =>
      amendPrepare(malformed, preparePatchOf(malformed, { correctPlanFiles: "plan-prepare" })),
    );
    expect(malformedRefusal.code).toBe("coordination.prepare-amendment.invalid-patch");
    

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
    

    // …and never twice in one correction list. The duplicate is a PER-COMPONENT
    // problem, not a preflight throw: both entries are withheld with the
    // aggregated vocabulary, and a patch that addresses nothing else writes
    // nothing. (That independent components still land beside it is covered by
    // "duplicate ids are per-component problems…" below.)
    const duplicate = makePrepareFixture();
    await ensurePrepareCoordinator(duplicate);
    const duplicateBefore = protectedBytes(duplicate);
    const duplicateRefusal = await prepareRefusalOf(() =>
      amendPrepare(
        duplicate,
        preparePatchOf(duplicate, {
          appendPlans: [],
          correctPlanFiles: [
            { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(duplicate.planDir, `${PREPARE_ROW}.md`) },
            { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(duplicate.planDir, `${PREPARE_ROW}.md`) },
          ],
        }),
      ),
    );
    expect(duplicateRefusal.code).toBe("coordination.prepare-amendment.duplicate-plan");
    expect(duplicateRefusal.details.plan_id).toBe(PREPARE_ROW);
    const duplicateRecovery = duplicateRefusal.details.recovery as RecoveryDetails;
    expect(duplicateRecovery.outcome).toBe("unresolved");
    expect(duplicateRecovery.applied).toEqual([]);
    expect(duplicateRecovery.unresolved.map((entry) => entry.path)).toEqual(["correctPlanFiles[0]", "correctPlanFiles[1]"]);
    expect(duplicateRecovery.commitState).toBe("none");
    


    // A prepared/sealed ADDRESSED row is never repointed: the row this
    // correction names carries execution evidence of its own, so the correction
    // refuses with that state named. Sibling rows are not read at all — their
    // state cannot block a pointer repair of another row (§4.1/A06).
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
      
    }
  }, 30000);

  test("a pointer correction lands while a sibling row runs and the compass set is incomplete (pointer correction — A06/#278)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // The addressed row holds the malformed repository-relative pointer the
    // legacy registration wrote; the sibling row is mid-execution, with its own
    // lease, progress and coordination evidence.
    const runningSibling: Record<string, unknown> = {
      ...planRow(PREPARE_APPEND, PROJECT_ID, `feature/${PREPARE_APPEND}`),
      status: "InProgress",
      progress: 40,
      execution_lease: {
        holder: "11111111-1111-1111-1111-111111111111",
        claimed_at: "2026-09-16T00:00:00Z",
        worktree_path: join(fixture.root, "wt-sibling"),
        working_branch: `feature/${PREPARE_APPEND}`,
      },
      coordination: { revision: 7 },
    };
    const doc = prepareSnapshotOf(fixture);
    doc.plans.push(runningSibling);
    writeJson(fixture.snapshotPath, doc);
    // ...and the reviewed compass declares an approved plan that has no row yet.
    writeText(
      fixture.compassPath,
      readFileSync(fixture.compassPath, "utf8").replace(
        `  - ${PREPARE_APPEND}\n`,
        `  - ${PREPARE_APPEND}\n  - ${PREPARE_UNREVIEWED}\n`,
      ),
    );
    const addressedBefore = prepareSnapshotOf(fixture).plans[0]!;

    // The stage signal of this lifecycle is no longer pristine — a sibling row
    // is mid-flight — so the view reports that fact instead of a dead end, while
    // the amendment below still repairs the addressed row: the sibling's state is
    // not the correction's read set (A06).
    const view = await prepareViewOf(fixture);
    expect(view.view.allowed).toBe(false);
    expect(view.view.blockers.join(" ")).toMatch(/execution-started/);
    expect(view.view.blockers.join(" ")).toContain(PREPARE_APPEND);

    const amended = await amendPrepare(
      fixture,
      preparePatchOf(fixture, {
        appendPlans: [],
        correctPlanFiles: [
          {
            id: PREPARE_ROW,
            expectedFile: `.mstar/plans/${PREPARE_ROW}.md`,
            file: join(fixture.planDir, `${PREPARE_ROW}.md`),
          },
        ],
      }),
    );

    const after = prepareSnapshotOf(fixture).plans;
    // The addressed row moved exactly one field — its pointer.
    expect(after[0]).toEqual({ ...addressedBefore, file: join(fixture.planDir, `${PREPARE_ROW}.md`) });
    // The running sibling is untouched: status, progress, lease and coordination
    // evidence all survive by value (A06: other row/evidence preserved).
    expect(after[1]).toEqual(runningSibling);
    // The compass gap is unrelated drift this patch never consumed: reported,
    // never a refusal, and no row was deleted to make the sets equal.
    expect(amended.recovery?.outcome).toBe("applied");
    expect(amended.recovery?.applied).toEqual([`correct-plan-file ${PREPARE_ROW}`]);
    expect(amended.recovery?.warnings.map((entry) => entry.code)).toEqual(["coordination.compass-plan-missing"]);
    expect(amended.recovery?.warnings[0]?.message).toContain(PREPARE_UNREVIEWED);
    expect(amended.recovery?.commitState).toBe("committed");
    // The declarations the repair resolved from are named as provenance.
    expect(amended.recovery?.resolvedFrom).toEqual([
      { path: "patch", source: "intent.request" },
      { path: `plans.${PREPARE_ROW}`, source: "reviewed compass declaration" },
      { path: "correctPlanFiles", source: "addressed row's own pointer" },
    ]);
  }, 30000);

  test("a plan declaring its branch through `Working branch policy` appends with every reference derived (branch policy — A07/#278)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const planPath = join(fixture.planDir, `${PREPARE_APPEND}.md`);
    // The document declares its branch through the policy form and no literal
    // `Working branch` header — the declaration form a real reviewed plan carries.
    writeText(
      planPath,
      [
        `# Plan ${PREPARE_APPEND}`,
        "",
        `**plan_id:** ${PREPARE_APPEND}`,
        "**Status:** Todo",
        "**Main worktree branch:** main",
        "**Working branch policy:** Feature worktree from the integration branch; merge back into that integration branch.",
        "",
        "Body.",
        "",
      ].join("\n"),
    );

    // Only the governing spec is supplied: the branch is derived from the
    // declaration the document carries, and the lifecycle references are derived
    // from the amended workflow's own compass and integration anchor.
    const amended = await amendPrepare(
      fixture,
      preparePatchOf(fixture, {
        appendPlans: [
          {
            id: PREPARE_APPEND,
            title: `Plan ${PREPARE_APPEND}`,
            file: planPath,
            metadata: { primary_spec: fixture.specPath },
          },
        ],
      }),
    );

    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    const appended = prepareSnapshotOf(fixture).plans[1]!;
    expect(appended.file).toBe(planPath);
    expect(appended.metadata).toEqual({
      primary_spec: fixture.specPath,
      spec_refs: [fixture.specPath],
      iteration_compass: fixture.compassPath,
      iteration_refs: [fixture.compassPath],
      working_branch: `feature/${PREPARE_APPEND}`,
      spec_integration_branch: PREPARE_INTEGRATION_BRANCH,
      merge_target: PREPARE_INTEGRATION_BRANCH,
    });
    expect(amended.recovery?.outcome).toBe("applied");
    expect(amended.recovery?.warnings).toEqual([]);
    expect(amended.recovery?.resolvedFrom).toContainEqual({
      path: `plans.${PREPARE_APPEND}`,
      source: "reviewed compass declaration",
    });

    // A fenced example is not a declaration: with the policy hidden in a fence
    // the document establishes no branch, and the append refuses instead of
    // guessing one from prose.
    const fenced = makePrepareFixture();
    await ensurePrepareCoordinator(fenced);
    const fencedPath = join(fenced.planDir, `${PREPARE_APPEND}.md`);
    writeText(
      fencedPath,
      [
        `# Plan ${PREPARE_APPEND}`,
        "",
        `**plan_id:** ${PREPARE_APPEND}`,
        "**Status:** Todo",
        "**Main worktree branch:** main",
        "```md",
        "**Working branch policy:** Feature worktree from the integration branch.",
        "```",
        "",
        "Body.",
        "",
      ].join("\n"),
    );

    const refusal = await prepareRefusalOf(() => amendPrepare(fenced, preparePatchOf(fenced)));
    expect(refusal.code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(refusal.details).toMatchObject({ plan_id: PREPARE_APPEND, field: "metadata.working_branch", path: fencedPath });
  }, 30000);

  test("an iteration that declares no phase derives its Prepare view and adopts it on the next amendment (derived Prepare — A04/#293)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // The manual/legacy registration shape: no phase anywhere in the document.
    const doc = prepareSnapshotOf(fixture);
    delete doc.phase;
    writeJson(fixture.snapshotPath, doc);
    const before = protectedBytes(fixture);

    const view = await prepareViewOf(fixture);
    expect(view.view.allowed).toBe(true);
    expect(view.view.blockers).toEqual([]);
    // The view reports the phase it read and that the label was DERIVED from the
    // lifecycle facts rather than declared (E06a's phase authority).
    expect(view.view.phase).toBe("phase-1-prepare");
    expect(view.view.phaseDerived).toBe(true);
    // The derivation is a read: no snapshot byte moved, and no `persist
    // snapshot` step is needed for the lifecycle to be addressable.
    

    const amended = await amendPrepare(fixture, preparePatchOf(fixture));
    expect(amended.view.phaseDerived).toBe(true);
    expect(amended.view.phase).toBe("phase-1-prepare");
    // The ordinary intent persisted the repair it derived.
    expect(prepareSnapshotOf(fixture).phase).toBe("phase-1-prepare");

    // ...and the next read reports the label as recorded, not as a derivation.
    const after = await prepareViewOf(fixture);
    expect(after.view.phase).toBe("phase-1-prepare");
    expect(after.view.phaseDerived).toBeUndefined();
  }, 30000);

  test("unknown custom metadata survives a repair inertly while recorded authority is refused (unknown metadata — A08)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);

    // An append carries custom keys this verb does not recognize: they travel
    // onto the row inertly and the requested effect still completes.
    const amended = await amendPrepare(
      fixture,
      preparePatchOf(fixture, {
        appendPlans: [
          prepareAppendOf(fixture, PREPARE_APPEND, {}, { execution_mode: "sdd", custom_note: { nested: [1, 2] } }),
        ],
      }),
    );
    expect(amended.recovery?.outcome).toBe("applied");
    expect(prepareSnapshotOf(fixture).plans[1]!.metadata).toMatchObject({
      execution_mode: "sdd",
      custom_note: { nested: [1, 2] },
    });
    // The preservation is SAID, not silent: the receipt names what it kept
    // without consuming it.
    expect(amended.recovery?.warnings.map((entry) => entry.code)).toEqual(["coordination.append-custom-metadata"]);
    expect(amended.recovery?.warnings[0]?.message).toContain("custom_note");

    // A key the engine READS AS RECORDED AUTHORITY is refused instead of being
    // preserved: custom metadata never becomes a fact (no authority elevation).
    const reserved = makePrepareFixture();
    await ensurePrepareCoordinator(reserved);
    const refusal = await prepareRefusalOf(() =>
      amendPrepare(
        reserved,
        preparePatchOf(reserved, {
          appendPlans: [prepareAppendOf(reserved, PREPARE_APPEND, {}, { catalog_pin: { catalog_revision: 9 } })],
        }),
      ),
    );
    expect(refusal.code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(refusal.details.reserved).toEqual(["catalog_pin"]);

    // An EXISTING row's custom metadata survives a pointer repair by value.
    const existing = makePrepareFixture();
    await ensurePrepareCoordinator(existing);
    const existingDoc = prepareSnapshotOf(existing);
    existingDoc.plans[0]!.metadata = {
      ...(existingDoc.plans[0]!.metadata as Record<string, unknown>),
      custom_note: "keep",
    };
    writeJson(existing.snapshotPath, existingDoc);

    await amendPrepare(
      existing,
      preparePatchOf(existing, {
        appendPlans: [],
        correctPlanFiles: [
          {
            id: PREPARE_ROW,
            expectedFile: `.mstar/plans/${PREPARE_ROW}.md`,
            file: join(existing.planDir, `${PREPARE_ROW}.md`),
          },
        ],
      }),
    );
    expect(prepareSnapshotOf(existing).plans[0]!.metadata).toMatchObject({ custom_note: "keep" });
  }, 30000);

  test("a local pointer correction proceeds on the trusted root when the Git fact is unreadable (pointer correction — A24/R12)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // A directory that looks like a linked checkout whose Git fact cannot be
    // read: `git` answers non-zero for it, so the process root is genuinely
    // unavailable there — the R12/A24 situation, not a stub.
    const linked = join(fixture.root, "linked-checkout");
    writeText(join(linked, ".git"), `gitdir: ${join(fixture.root, "no-such-main", ".git", "worktrees", "linked")}\n`);
    expect(await errorCodeOf(async () => resolveProcessHarnessDir(linked))).toBe("coordination.not-in-git");

    const view = await prepareViewOf(fixture);
    const correction = preparePatchOf(fixture, {
      appendPlans: [],
      correctPlanFiles: [
        {
          id: PREPARE_ROW,
          expectedFile: `.mstar/plans/${PREPARE_ROW}.md`,
          file: join(fixture.planDir, `${PREPARE_ROW}.md`),
        },
      ],
    });
    const amended = await amendWith(fixture, correction, { cwd: linked });

    expect(amended.recovery?.outcome).toBe("applied");
    // The unreadable Git fact is a warning beside the repair this call needs no
    // Git fact for; the still-unregistered compass plan is unrelated drift.
    expect(amended.recovery?.warnings.map((entry) => entry.code)).toContain("coordination.git-unavailable");
    expect(prepareSnapshotOf(fixture).plans[0]!.file).toBe(join(fixture.planDir, `${PREPARE_ROW}.md`));

    // The same unreadable Git fact still refuses the component that genuinely
    // needs an owned checkout/branch fact (an append), as an unavailable
    // prerequisite rather than a global environment gate (A25).
    const appendRefusal = await prepareRefusalOf(() =>
      amendWith(fixture, preparePatchOf(fixture), { cwd: linked }),
    );
    expect(appendRefusal.code).toBe("coordination.not-in-git");
  }, 30000);

  test("a local pointer correction proceeds when Git answers on a different branch (pointer correction — A24)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // Git genuinely ANSWERS here — a readable main worktree on its own branch —
    // so this is the available-yet-different case, not the unreadable one.
    const onBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).trim();
    expect(onBranch).toBe("main");

    const view = await prepareViewOf(fixture);
    const correction = {
      appendPlans: [],
      mainWorktreeBranch: "release",
      correctPlanFiles: [
        {
          id: PREPARE_ROW,
          expectedFile: `.mstar/plans/${PREPARE_ROW}.md`,
          file: join(fixture.planDir, `${PREPARE_ROW}.md`),
        },
      ],
    };
    const amended = await amendWith(fixture, correction);

    expect(amended.recovery?.outcome).toBe("applied");
    // The differing branch is drift beside the repair this call needs no branch
    // fact for — the same verdict the unreadable-Git case gives, never a gate.
    expect(amended.recovery?.warnings.map((entry) => entry.code)).toContain("coordination.main-branch-drift");
    expect(prepareSnapshotOf(fixture).plans[0]!.file).toBe(join(fixture.planDir, `${PREPARE_ROW}.md`));

    // The same available-yet-different branch still refuses the components that
    // anchor a checkout/branch fact to it (A25): an append, and an integration
    // checkout. Neither refusal writes anything.
    const afterCorrection = protectedBytes(fixture);
    const appendRefusal = await prepareRefusalOf(() =>
      amendWith(fixture, preparePatchOf(fixture, { mainWorktreeBranch: "release" })),
    );
    expect(appendRefusal.code).toBe("coordination.scope-mismatch");
    expect(appendRefusal.details.expected).toBe("release");
    expect(appendRefusal.details.actual).toBe("main");

    const integrationRefusal = await prepareRefusalOf(() =>
      amendWith(
        fixture,
        preparePatchOf(fixture, {
          mainWorktreeBranch: "release",
          appendPlans: [],
          integrationWorktreePath: fixture.integrationPath,
        }),
      ),
    );
    expect(integrationRefusal.code).toBe("coordination.scope-mismatch");
    
  }, 30000);

  test("an independent correction lands while the conflicting append is withheld, in ONE partial receipt (independent amendment — A23/A27)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // The reviewed compass declares the registered row only, so the appended id
    // has no approval: that component carries its own conflict.
    writeText(fixture.compassPath, readFileSync(fixture.compassPath, "utf8").replace(`  - ${PREPARE_APPEND}\n`, ""));
    const patch = preparePatchOf(fixture, {
      appendPlans: [prepareAppendOf(fixture, PREPARE_UNREVIEWED)],
      correctPlanFiles: [
        { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) },
      ],
    });
    const before = protectedBytes(fixture);

    const refusal = await prepareRefusalOf(() => amendPrepare(fixture, patch));

    // The refusal classifies the WITHHELD component, and the ONE receipt names
    // the whole call: what landed, what did not, and the commit boundary.
    expect(refusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(refusal.details.undeclared).toEqual([PREPARE_UNREVIEWED]);
    expect(refusal.details.withheld_components).toEqual([`append plan ${PREPARE_UNREVIEWED}`]);
    expect(refusal.details.components).toEqual([`append plan ${PREPARE_UNREVIEWED}`, `correct-plan-file ${PREPARE_ROW}`]);
    const recovery = refusal.details.recovery as RecoveryDetails;
    expect(recovery.outcome).toBe("partial");
    expect(recovery.applied).toEqual([`correct-plan-file ${PREPARE_ROW}`]);
    expect(recovery.unresolved).toHaveLength(1);
    expect(recovery.unresolved[0]!.component).toBe(`append plan ${PREPARE_UNREVIEWED}`);
    expect(recovery.unresolved[0]!.path).toBe("appendPlans[0]");
    expect(recovery.unresolved[0]!.currentFacts[0]).toContain(PREPARE_UNREVIEWED);
    expect(recovery.unresolved[0]!.needed).toContain("reviewed compass");
    expect(recovery.commitState).toBe("partial");

    // The independent repair landed ONCE and the conflicting append left no row.
    const after = prepareSnapshotOf(fixture);
    expect(after.plans).toHaveLength(1);
    expect(after.plans[0]!.file).toBe(join(fixture.planDir, `${PREPARE_ROW}.md`));

    // The lost-response retry of the SAME patch converges (A09/A28): the applied
    // component is recognized as already recorded, the conflict stays withheld,
    // and NOTHING is applied twice — no duplicate row, no second pointer move,
    // no new bytes.
    const settled = protectedBytes(fixture);
    const retry = await prepareRefusalOf(() => amendPrepare(fixture, patch));
    const retryRecovery = retry.details.recovery as RecoveryDetails;
    expect(retry.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(retryRecovery.outcome).toBe("unresolved");
    // The already-recorded component is NOT reported as applied a second time:
    // the receipt recognizes it (by name) instead, so no duplicate mutation and
    // no duplicate `applied` entry can occur on a replay.
    expect(retryRecovery.applied).toEqual([]);
    expect(retryRecovery.commitState).toBe("none");
    expect(retryRecovery.warnings.map((entry) => entry.code)).toEqual(["coordination.prepare-amendment.held"]);
    expect(retryRecovery.warnings[0]!.path).toBe(`correct-plan-file ${PREPARE_ROW}`);
    
  }, 30000);

  test("the connected checkout/policy pair is withheld together while an independent repair lands (connected amendment — A06/A23)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // The integration owner is mid-merge: the connected pair that would rewrite
    // the integration checkout and its policy cannot land, while the pointer
    // repair — an independent component that reads no integration fact — still
    // does (A06: a sibling's integration ownership never blocks it).
    const doc = prepareSnapshotOf(fixture);
    const mergeLease = {
      holder: "11111111-1111-1111-1111-111111111111",
      claimed_at: "2026-09-16T00:00:00Z",
      plan_id: PREPARE_ROW,
      source_branch: `feature/${PREPARE_ROW}`,
      target_branch: PREPARE_INTEGRATION_BRANCH,
    };
    doc.integration_merge_lease = mergeLease;
    writeJson(fixture.snapshotPath, doc);
    const correction = {
      id: PREPARE_ROW,
      expectedFile: `.mstar/plans/${PREPARE_ROW}.md`,
      file: join(fixture.planDir, `${PREPARE_ROW}.md`),
    };

    const refusal = await prepareRefusalOf(() =>
      amendPrepare(fixture, {
        mainWorktreeBranch: "main",
        appendPlans: [],
        correctPlanFiles: [correction],
        integrationWorktreePath: fixture.integrationPath,
        planParallelism: "parallel",
      } as unknown as PrepareWorkflowPatch),
    );

    expect(refusal.code).toBe("coordination.prepare-amendment.execution-started");
    expect(refusal.details.withheld_components).toEqual([
      `integration-worktree ${fixture.integrationPath}`,
      "execution-policy parallel",
    ]);
    const recovery = refusal.details.recovery as RecoveryDetails;
    expect(recovery.outcome).toBe("partial");
    expect(recovery.applied).toEqual([`correct-plan-file ${PREPARE_ROW}`]);
    // BOTH members carry the same problem: the pair is withheld as one unit, so
    // a caller never observes the checkout recorded without its policy.
    expect(recovery.unresolved.map((entry) => entry.component)).toEqual([
      `integration-worktree ${fixture.integrationPath}`,
      "execution-policy parallel",
    ]);
    expect(recovery.unresolved.map((entry) => entry.path)).toEqual(["integrationWorktreePath", "planParallelism"]);
    expect(recovery.unresolved.map((entry) => entry.code)).toEqual([
      "coordination.prepare-amendment.execution-started",
      "coordination.prepare-amendment.execution-started",
    ]);
    expect(recovery.commitState).toBe("partial");

    const after = prepareSnapshotOf(fixture);
    expect(after.plans[0]!.file).toBe(join(fixture.planDir, `${PREPARE_ROW}.md`));
    expect(after.integration_worktree_path).toBeUndefined();
    expect(after.execution_policy).toEqual({ plan_parallelism: "serial", worktree_mode: "required" });
    expect(after.integration_merge_lease).toEqual(mergeLease);

    // Control: without the in-flight merge the SAME patch lands every component
    // in one call — the connected pair commits together, in one write.
    const idle = makePrepareFixture();
    await ensurePrepareCoordinator(idle);
    const applied = await amendPrepare(
      idle,
      preparePatchOf(idle, {
        appendPlans: [],
        correctPlanFiles: [
          { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(idle.planDir, `${PREPARE_ROW}.md`) },
        ],
        integrationWorktreePath: idle.integrationPath,
        planParallelism: "parallel",
      }),
    );
    expect(applied.recovery?.outcome).toBe("applied");
    expect(applied.recovery?.applied).toEqual([
      `correct-plan-file ${PREPARE_ROW}`,
      `integration-worktree ${idle.integrationPath}`,
      "execution-policy parallel",
    ]);
    const control = prepareSnapshotOf(idle);
    expect(control.integration_worktree_path).toBe(idle.integrationPath);
    expect(control.execution_policy).toEqual({ plan_parallelism: "parallel", worktree_mode: "required" });
  }, 60000);

  test("a repeated append recognizes the held row without applying it again", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const patch = preparePatchOf(fixture, {
      integrationWorktreePath: fixture.integrationPath,
      planParallelism: "parallel",
    });
    const first = await amendPrepare(fixture, patch);
    expect(first.outcome).toBe("amended");
    const applied = prepareSnapshotOf(fixture);
    const repeated = await amendPrepare(fixture, patch);
    expect(repeated.outcome).toBe("already-satisfied");
    expect(repeated.recovery?.applied).toEqual([]);
    expect(prepareSnapshotOf(fixture)).toEqual(applied);
    expect(prepareSnapshotOf(fixture).plans.map((row) => row.id)).toEqual([PREPARE_ROW, PREPARE_APPEND]);
  }, 30000);

  test("one refusal names every withheld component's field path, facts and minimum choice (independent amendment — A27)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // Three irreducible component problems at once: an unsafe plan id, a missing
    // pointer, and an omitted `expectedFile`. None of them is derivable, and
    // every one of them must be named in the SAME result (A27).
    const before = protectedBytes(fixture);
    const refusal = await prepareRefusalOf(() =>
      amendPrepare(fixture, {
        mainWorktreeBranch: "main",
        appendPlans: [
          prepareAppendOf(fixture, PREPARE_APPEND, { id: ".." }),
          prepareAppendOf(fixture, PREPARE_APPEND, { id: PREPARE_UNREVIEWED, file: undefined }),
        ],
        correctPlanFiles: [{ id: PREPARE_ROW, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }],
      } as unknown as PrepareWorkflowPatch),
    );

    expect(refusal.code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(refusal.details.withheld_components).toEqual([
      "append plan ..",
      `append plan ${PREPARE_UNREVIEWED}`,
      `correct-plan-file ${PREPARE_ROW}`,
    ]);
    const recovery = refusal.details.recovery as RecoveryDetails;
    expect(recovery.outcome).toBe("unresolved");
    expect(recovery.applied).toEqual([]);
    expect(recovery.commitState).toBe("none");
    // Every withheld component carries its own field path, the facts that were
    // read, the minimum choice and the effect that stays withheld.
    expect(recovery.unresolved.map((entry) => entry.path)).toEqual([
      "appendPlans[0]",
      "appendPlans[1]",
      "correctPlanFiles[0]",
    ]);
    for (const problem of recovery.unresolved) {
      expect(problem.component).not.toBe("");
      expect(problem.needed).not.toBe("");
      expect(problem.withheldEffect).toContain(problem.component);
      expect(problem.sourcesTried.length).toBeGreaterThan(0);
      expect(problem.currentFacts.length).toBeGreaterThan(0);
    }
    expect(recovery.unresolved[0]!.component).toBe("append plan ..");
    

    // The patch-level problems aggregate the same way: ONE result naming every
    // broken field path instead of the first one found.
    const shape = makePrepareFixture();
    await ensurePrepareCoordinator(shape);
    const shapeBefore = protectedBytes(shape);
    const shapeRefusal = await prepareRefusalOf(() =>
      amendPrepare(shape, {
        mainWorktreeBranch: "main",
        appendPlans: [],
        correctPlanFiles: "plan-prepare",
        planParallelism: "maybe",
        replacePlans: [],
      }),
    );

    expect(shapeRefusal.code).toBe("coordination.prepare-amendment.invalid-patch");
    const shapeRecovery = shapeRefusal.details.recovery as RecoveryDetails;
    expect(shapeRecovery.outcome).toBe("unresolved");
    expect(shapeRecovery.applied).toEqual([]);
    expect(shapeRecovery.unresolved.map((entry) => entry.path)).toEqual(["patch", "correctPlanFiles", "planParallelism"]);
    
  }, 60000);

  test("a malformed policy withholds only the connected group it belongs to while an independent correction lands (independent amendment — A23/A27)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // `planParallelism` is the execution-policy member of the connected
    // integration/policy group, so a value outside the approved set is that
    // GROUP's own problem: it must not fail the whole amendment before the
    // partition, because the pointer correction beside it is independent.
    const refusal = await prepareRefusalOf(() =>
      amendPrepare(
        fixture,
        preparePatchOf(fixture, {
          appendPlans: [],
          correctPlanFiles: [
            { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) },
          ],
          integrationWorktreePath: fixture.integrationPath,
          planParallelism: "maybe",
        }),
      ),
    );

    // The refusal keeps the malformed field's own code and details, and the ONE
    // receipt names the whole call: the withheld connected pair, the component
    // that landed and the commit boundary between them.
    expect(refusal.code).toBe("coordination.prepare-amendment.invalid-patch");
    expect(refusal.details.actual).toBe("maybe");
    expect(refusal.details.allowed).toEqual(["serial", "parallel"]);
    expect(refusal.details.withheld_components).toEqual([
      `integration-worktree ${fixture.integrationPath}`,
      "execution-policy maybe",
    ]);
    const recovery = refusal.details.recovery as RecoveryDetails;
    expect(recovery.outcome).toBe("partial");
    expect(recovery.applied).toEqual([`correct-plan-file ${PREPARE_ROW}`]);
    expect(recovery.unresolved.map((entry) => entry.component)).toEqual([
      `integration-worktree ${fixture.integrationPath}`,
      "execution-policy maybe",
    ]);
    expect(recovery.unresolved.map((entry) => entry.path)).toEqual(["integrationWorktreePath", "planParallelism"]);
    expect(recovery.unresolved.map((entry) => entry.code)).toEqual([
      "coordination.prepare-amendment.invalid-patch",
      "coordination.prepare-amendment.invalid-patch",
    ]);
    // The policy problem names its own minimum choice and the fact it read, so the
    // caller repairs the value instead of re-deriving the whole patch.
    expect(recovery.unresolved[1]!.currentFacts[0]).toContain("planParallelism must be one of serial | parallel");
    expect(recovery.unresolved[1]!.needed).toBe("one of serial | parallel");
    expect(recovery.commitState).toBe("partial");

    // The independent repair landed ONCE and the connected pair left no fact:
    // no checkout recorded, the policy still serial.
    const after = prepareSnapshotOf(fixture);
    expect(after.plans).toHaveLength(1);
    expect(after.plans[0]!.file).toBe(join(fixture.planDir, `${PREPARE_ROW}.md`));
    expect(after.integration_worktree_path).toBeUndefined();
    expect(after.execution_policy).toEqual({ plan_parallelism: "serial", worktree_mode: "required" });
  }, 30000);

  test("duplicate ids are per-component problems while an independent correction lands (independent amendment — A27)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // The same plan id twice in `appendPlans`: no single entry can be resolved,
    // so BOTH are withheld with the public duplicate code and their own field
    // path — never a preflight throw that would also block the correction.
    const refusal = await prepareRefusalOf(() =>
      amendPrepare(
        fixture,
        preparePatchOf(fixture, {
          appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND), prepareAppendOf(fixture, PREPARE_APPEND)],
          correctPlanFiles: [
            { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) },
          ],
        }),
      ),
    );

    expect(refusal.code).toBe("coordination.prepare-amendment.duplicate-plan");
    expect(refusal.details.plan_id).toBe(PREPARE_APPEND);
    expect(refusal.details.withheld_components).toEqual([
      `append plan ${PREPARE_APPEND}`,
      `append plan ${PREPARE_APPEND}`,
    ]);
    const recovery = refusal.details.recovery as RecoveryDetails;
    expect(recovery.outcome).toBe("partial");
    expect(recovery.applied).toEqual([`correct-plan-file ${PREPARE_ROW}`]);
    expect(recovery.unresolved.map((entry) => entry.path)).toEqual(["appendPlans[0]", "appendPlans[1]"]);
    expect(recovery.unresolved.map((entry) => entry.code)).toEqual([
      "coordination.prepare-amendment.duplicate-plan",
      "coordination.prepare-amendment.duplicate-plan",
    ]);
    for (const problem of recovery.unresolved) {
      expect(problem.currentFacts[0]).toContain(`${PREPARE_APPEND} appears twice in one patch`);
      expect(problem.needed).toContain("a plan id this workflow does not already hold");
    }
    expect(recovery.commitState).toBe("partial");

    // The ambiguous appends left no row and the independent pointer moved once.
    const after = prepareSnapshotOf(fixture);
    expect(after.plans).toHaveLength(1);
    expect(after.plans[0]!.file).toBe(join(fixture.planDir, `${PREPARE_ROW}.md`));
  }, 30000);

  test("an aliased checkout spelling reports the canonical component identity of the same checkout (independent amendment — canonical identity)", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // ONE integration checkout spelled three ways: its canonical path, a lexical
    // alias and a symlink. §4.1/E08 the component identity is the CANONICAL
    // effective path — the value the proposal records, and the identity the ACTIVE
    // route builds from `canonicalTarget(operation.path)` — so a spelling can
    // never create a second `integration-worktree` component.
    const lexical = `${fixture.integrationPath}/../${basename(fixture.integrationPath)}`;
    const symlink = join(fixture.root, "wt-integration-alias");
    symlinkSync(fixture.integrationPath, symlink, "dir");
    const identity = `integration-worktree ${fixture.integrationPath}`;

    const applied = await amendPrepare(
      fixture,
      preparePatchOf(fixture, { appendPlans: [], integrationWorktreePath: lexical }),
    );

    expect(applied.recovery?.applied).toEqual([identity]);
    // The recorded fact is that same canonical path, so receipt and snapshot agree.
    expect(prepareSnapshotOf(fixture).integration_worktree_path).toBe(fixture.integrationPath);

    // A DIFFERENT SPELLING of a satisfied checkout is not a second component: the
    // symlink alias is recognized as the effect already held, so no byte moves.
    const before = protectedBytes(fixture);
    const replayed = await amendPrepare(
      fixture,
      preparePatchOf(fixture, { appendPlans: [], integrationWorktreePath: symlink }),
    );

    expect(replayed.outcome).toBe("already-satisfied");
    expect(replayed.recovery?.outcome).toBe("already-satisfied");
    expect(replayed.recovery?.applied).toEqual([]);
    expect(replayed.recovery?.unresolved).toEqual([]);
    expect(
      replayed.recovery?.warnings.find((entry) => entry.code === "coordination.prepare-amendment.held")?.path,
    ).toBe(identity);
    expect(replayed.recovery?.commitState).toBe("none");
    
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

/** One recovery request with its semantic identity and stop attestation. */
function recoveryInputOf(
  fixture: PrepareFixture,
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
    operationId: "op-recover-1",
    reason: "the prior host session was cancelled and cannot authenticate",
    authorizationRef: "PM-authorization-20260921",
    stoppedSessionIds: [FIXTURE_COORDINATOR_ID],
    ...overrides,
  } as Parameters<typeof recoverPrepareCoordinator>[0];
}

/**
 * The operator's validated stop attestation for one quiesced session, in the
 * exact `ActivationAttestation` shape `validateActivationAttestation` accepts.
 */
function stopAttestationOf(attestedAt: string, stoppedSessionId: string): ActivationAttestation {
  return {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt,
    operator: { actor: "ops-engineer", authorizationRef: "PM-authorization-20260921" },
    consumers: [
      {
        entryId: "fixture-coordinator",
        kind: "coordinator",
        entrypoint: "/fixture/engine",
        runtime: "bun",
        runtimeVersion: "1.4.0",
        version: "fixture",
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions: [{ sessionId: stoppedSessionId, host: "fixture", state: "stopped" }],
  };
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
  test("prepare coordinator recovery view reports the recorded owner and provenance fields without envelope bytes", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);

    const view = await recoveryViewOf(fixture);

    expect(view.workflowId).toBe(PREPARE_WORKFLOW);
    expect(view.priorSessionId).toBe(FIXTURE_COORDINATOR_ID);
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
    
  }, 30000);

  test("interrupted-claim recovery releases the predecessor's own mutex under a validated operator stop attestation, leaving rows/anchors/evidence untouched", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // A REAL interrupted integration claim held by the EXACT recorded predecessor.
    const ownedLease = {
      holder: FIXTURE_COORDINATOR_ID,
      claimed_at: "2026-09-15T00:00:00Z",
      plan_id: PREPARE_ROW,
      source_branch: `feature/${PREPARE_ROW}`,
      target_branch: PREPARE_INTEGRATION_BRANCH,
    };
    const seeded = prepareSnapshotOf(fixture);
    seeded.integration_merge_lease = ownedLease;
    writeJson(fixture.snapshotPath, seeded);
    const planRowsBefore = JSON.stringify(seeded.plans);
    const branchBefore = JSON.stringify(seeded.branch);
    const integrationPathBefore = seeded.integration_worktree_path;

    // The claim is discarded only under the operator's validated stop attestation.
    const attestation = stopAttestationOf("2026-09-15T01:00:00Z", FIXTURE_COORDINATOR_ID);
    const recovered = await recoverPrepareCoordinator(recoveryInputOf(fixture, { attestation }));
    expect(recovered.recovery.replay).toBe(false);
    const after = prepareSnapshotOf(fixture);
    expect(after.integration_merge_lease).toBeUndefined();
    expect(JSON.stringify(after.plans)).toBe(planRowsBefore);
    expect(JSON.stringify(after.branch)).toBe(branchBefore);
    expect(after.integration_worktree_path).toBe(integrationPathBefore);
    expect(recordedCoordinatorOf(fixture)).toMatchObject({ session_id: RECOVERED_COORDINATOR_ID });
    // The audit records the attestation instant, derived from the document.
    expect(recoveryAuditOf(fixture)[0]).toMatchObject({ attested_at: "2026-09-15T01:00:00.000Z" });

    // An EXACT retry replays the recorded receipt and does not rewrite the audit.
    const auditAfterFirst = JSON.stringify(recoveryAuditOf(fixture));
    const replay = await recoverPrepareCoordinator(recoveryInputOf(fixture, { attestation }));
    expect(replay.recovery.replay).toBe(true);
    expect(JSON.stringify(recoveryAuditOf(fixture))).toBe(auditAfterFirst);
  }, 60000);

  test("interrupted-claim recovery refuses a missing, foreign-holder, newer-than-stop or running-state attestation without mutating", async () => {
    /** A fixture with the recorded predecessor's own interrupted claim seeded. */
    function seeded(): PrepareFixture {
      const fixture = makePrepareFixture();
      const doc = prepareSnapshotOf(fixture);
      doc.integration_merge_lease = {
        holder: FIXTURE_COORDINATOR_ID,
        claimed_at: "2026-09-15T00:00:00Z",
        plan_id: PREPARE_ROW,
        source_branch: `feature/${PREPARE_ROW}`,
        target_branch: PREPARE_INTEGRATION_BRANCH,
      };
      writeJson(fixture.snapshotPath, doc);
      return fixture;
    }

    // (a) No attestation at all: the mutex recovery cannot proceed.
    const missing = seeded();
    await ensurePrepareCoordinator(missing);
    const missingDoc = prepareSnapshotOf(missing);
    const missingBefore = protectedBytes(missing);
    expect((await prepareRefusalOf(() => recoverPrepareCoordinator(recoveryInputOf(missing)))).code).toBe(
      "coordination.identity-recovery.unauthorized",
    );
    expect(protectedBytes(missing)).toEqual(missingBefore);
    expect(prepareSnapshotOf(missing).integration_merge_lease).toEqual(missingDoc.integration_merge_lease);

    // (b) A foreign holder with a compliant attestation that stops the foreign
    // session only: the exact recorded predecessor is not named.
    const foreign = seeded();
    await ensurePrepareCoordinator(foreign);
    const foreignDoc = prepareSnapshotOf(foreign);
    foreignDoc.integration_merge_lease = { ...foreignDoc.integration_merge_lease, holder: "11111111-1111-1111-1111-111111111111" };
    writeJson(foreign.snapshotPath, foreignDoc);
    const foreignBefore = protectedBytes(foreign);
    const foreignRefusal = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(recoveryInputOf(foreign, { attestation: stopAttestationOf("2026-09-15T01:00:00Z", "11111111-1111-1111-1111-111111111111") })),
    );
    expect(foreignRefusal.code).toBe("coordination.identity-recovery.unauthorized");
    expect(protectedBytes(foreign)).toEqual(foreignBefore);
    expect(prepareSnapshotOf(foreign).integration_merge_lease).toEqual(foreignDoc.integration_merge_lease);

    // (c) A claim taken AFTER the attested stop: the holder had not stopped.
    const newer = seeded();
    await ensurePrepareCoordinator(newer);
    const newerDoc = prepareSnapshotOf(newer);
    newerDoc.integration_merge_lease = { ...newerDoc.integration_merge_lease, claimed_at: "2026-09-15T02:00:00Z" };
    writeJson(newer.snapshotPath, newerDoc);
    const newerBefore = protectedBytes(newer);
    expect(
      (
        await prepareRefusalOf(() =>
          recoverPrepareCoordinator(recoveryInputOf(newer, { attestation: stopAttestationOf("2026-09-15T01:00:00Z", FIXTURE_COORDINATOR_ID) })),
        )
      ).code,
    ).toBe("coordination.identity-recovery.unauthorized");
    expect(protectedBytes(newer)).toEqual(newerBefore);

    // (d) A stop entry in the RUNNING state is not quiesced: the document itself
    // is refused by the shared validator before any ownership decision.
    const running = seeded();
    await ensurePrepareCoordinator(running);
    const runningDoc = prepareSnapshotOf(running);
    const runningBefore = protectedBytes(running);
    const runningAttestation = stopAttestationOf("2026-09-15T01:00:00Z", FIXTURE_COORDINATOR_ID);
    (runningAttestation.stoppedSessions[0] as { state: string }).state = "running";
    const runningRefusal = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(recoveryInputOf(running, { attestation: runningAttestation })),
    );
    expect(typeof runningRefusal.code).toBe("string");
    expect(protectedBytes(running)).toEqual(runningBefore);
    expect(prepareSnapshotOf(running).integration_merge_lease).toEqual(runningDoc.integration_merge_lease);

    // (e) The replacement named as stopped is refused.
    const selfStopped = seeded();
    await ensurePrepareCoordinator(selfStopped);
    const selfDoc = prepareSnapshotOf(selfStopped);
    const selfAttestation = stopAttestationOf("2026-09-15T01:00:00Z", FIXTURE_COORDINATOR_ID);
    selfAttestation.stoppedSessions.push({ sessionId: RECOVERED_COORDINATOR_ID, host: "fixture", state: "stopped" });
    const selfBefore = protectedBytes(selfStopped);
    expect((await prepareRefusalOf(() => recoverPrepareCoordinator(recoveryInputOf(selfStopped, { attestation: selfAttestation })))).code).toBe(
      "coordination.identity-recovery.unauthorized",
    );
    expect(protectedBytes(selfStopped)).toEqual(selfBefore);
    expect(prepareSnapshotOf(selfStopped).integration_merge_lease).toEqual(selfDoc.integration_merge_lease);
  }, 60000);

  test("interrupted-claim recovery accepts the predecessor's own mutex while no-mutex InProgress still refuses", async () => {
    // A real mutex held by the recorded predecessor with a compliant attestation:
    // the new narrow path DOES admit it (the integration stage is not a blanket
    // refusal once the holder's stop is attested).
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const doc = prepareSnapshotOf(fixture);
    doc.integration_merge_lease = {
      holder: FIXTURE_COORDINATOR_ID,
      claimed_at: "2026-09-15T00:00:00Z",
      plan_id: PREPARE_ROW,
      source_branch: `feature/${PREPARE_ROW}`,
      target_branch: PREPARE_INTEGRATION_BRANCH,
    };
    writeJson(fixture.snapshotPath, doc);
    const recovered = await recoverPrepareCoordinator(
      recoveryInputOf(fixture, { attestation: stopAttestationOf("2026-09-15T01:00:00Z", FIXTURE_COORDINATOR_ID) }),
    );
    expect(recovered.recovery.replay).toBe(false);
    expect(prepareSnapshotOf(fixture).integration_merge_lease).toBeUndefined();

    // A row already InProgress WITHOUT a mutex keeps the stage refusal.
    const staged = makePrepareFixture();
    await ensurePrepareCoordinator(staged);
    const stagedDoc = prepareSnapshotOf(staged);
    stagedDoc.plans[0]!.status = "InProgress";
    writeJson(staged.snapshotPath, stagedDoc);
    const stagedBefore = protectedBytes(staged);
    const stagedRefusal = await prepareRefusalOf(() => recoverPrepareCoordinator(recoveryInputOf(staged)));
    expect(stagedRefusal.code).toBe("coordination.identity-recovery.execution-started");
    expect(protectedBytes(staged)).toEqual(stagedBefore);
  }, 60000);

  test("prepare coordinator recovery replaces the binding under explicit authorization and the old reference refuses", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = prepareSnapshotOf(fixture);
    const beforeRecovery = await recoveryViewOf(fixture);
    const planRows = before.plans;
    const branch = before.branch;

    const result = await recoverPrepareCoordinator(recoveryInputOf(fixture));

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
    const recovered = prepareSnapshotOf(fixture);
    expect(recovered.plans).toEqual(planRows);
    expect(recovered.branch).toEqual(branch);

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
      compass_version: beforeRecovery.compassVersion,
      snapshot_version_before: beforeRecovery.snapshotVersion,
    });
    expect(audit[0]!.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(audit[0]!.recovered_at).toBe(result.recovery.recoveredAt);


    // The old reference is historical: its envelope still names the old owner,
    // and every Prepare verb now refuses it because the BINDING moved.
    const oldUse = await prepareRefusalOf(() => prepareViewOf(fixture, fixture.coordinatorSession));
    // The replaced envelope is historical: the refusal is its own typed code,
    // never an adoption of the moved binding.
    expect(typeof oldUse.code).toBe("string");
    // The replacement session is the live coordinator.
    const live = await prepareViewOf(fixture, newEnvelope);
    expect(live.view.allowed).toBe(true);
    expect(live.session.session_id).toBe(RECOVERED_COORDINATOR_ID);
  }, 30000);

  test("prepare coordinator recovery refuses foreign, unauthorized and executed requests without mutating", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);
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
        recoverPrepareCoordinator(recoveryInputOf(fixture, recoveryCase.overrides)),
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
      expect((await recoveryViewOf(fixture)).priorSessionId).toBe(FIXTURE_COORDINATOR_ID);
      expect(existsSync(coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID))).toBe(false);
    }

    // An executed row (any row coordination block) is never recovered: the
    // ORIGINAL all-row admission decides, and nothing is written.
    const snapshot = prepareSnapshotOf(fixture);
    (snapshot.plans[0] as Record<string, unknown>).coordination = { revision: 1 };
    writeJson(fixture.snapshotPath, snapshot);
    const executed = protectedBytes(fixture);
    const activeRefusal = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(recoveryInputOf(fixture)),
    );
    expect(activeRefusal.code).toBe("coordination.identity-recovery.execution-started");
    
  }, 60000);

  test("prepare coordinator recovery enforces current ownership and request-hash replay conflict", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    // No caller-provided artifact version is an admission token.

    const [first, second] = await Promise.allSettled([
      recoverPrepareCoordinator(recoveryInputOf(fixture)),
      recoverPrepareCoordinator(
        recoveryInputOf(fixture, { operationId: "op-recover-2", identity: recoveredIdentity(RECOVERED_COORDINATOR_ID_2) }),
      ),
    ]);
    const rejected = [first, second].find((entry) => entry.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("expected exactly one refused concurrent recovery");
    expect((rejected.reason as CoordinationError).code).toBe("coordination.identity-recovery.foreign-owner");
    // Exactly one owner and exactly one audit entry: the loser wrote nothing.
    const audit = recoveryAuditOf(fixture);
    expect(audit).toHaveLength(1);
    expect(recordedCoordinatorOf(fixture).session_id).toBe(audit[0]!.session_id);
    const loserId = audit[0]!.session_id === RECOVERED_COORDINATOR_ID ? RECOVERED_COORDINATOR_ID_2 : RECOVERED_COORDINATOR_ID;
    expect(existsSync(coordinatorEnvelopeOf(fixture, loserId))).toBe(false);

    // A replayed operation id with a DIFFERENT request is not the same
    // operation: it refuses without moving anything.
    const boundFile = recordedCoordinatorOf(fixture).session_file;
    const replayDifferent = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(fixture, {
          operationId: audit[0]!.operation_id as string,
          reason: "a different reason entirely",
          priorSessionId: audit[0]!.prior_session_id as string,
        }),
      ),
    );
    expect(recordedCoordinatorOf(fixture).session_file).toBe(boundFile);
  }, 60000);

  test("prepare coordinator recovery returns the recorded receipt on an exact retry", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const request = recoveryInputOf(fixture);

    const first = await recoverPrepareCoordinator(request);
    const firstEntry = recoveryAuditOf(fixture)[0]!;

    // The same request replays the stored receipt after its own commit.
    const retry = await recoverPrepareCoordinator(request);

    expect(retry.ok).toBe(true);
    expect(retry.recovery.replay).toBe(true);
    expect(retry.recovery.operationId).toBe(first.recovery.operationId);
    expect(retry.recovery.sessionId).toBe(RECOVERED_COORDINATOR_ID);
    expect(retry.session_file).toBe(first.session_file);
    expect(recoveryAuditOf(fixture)).toHaveLength(1);

    const second = await recoverPrepareCoordinator(
      recoveryInputOf(fixture, {
        operationId: "op-recover-3",
        identity: recoveredIdentity(RECOVERED_COORDINATOR_ID_2),
        priorSessionId: RECOVERED_COORDINATOR_ID,
        priorSessionPath: first.session_file,
        stoppedSessionIds: [RECOVERED_COORDINATOR_ID],
      }),
    );
    const audit = recoveryAuditOf(fixture);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toEqual(firstEntry);

    // The first operation's replay is no longer this workflow's state.
    const superseded = await prepareRefusalOf(() => recoverPrepareCoordinator(request));
    expect(superseded.code).toBe("coordination.identity-recovery.operation-conflict");
  }, 60000);

  test("prepare coordinator recovery reclaims only a matching session envelope after commit failure", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const newEnvelope = coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID);
    const before = protectedBytes(fixture);
    const request = recoveryInputOf(fixture);

    instrumentLocalStore(fixture.harness, (inner) => new FailOnceSnapshotStore(inner));
    await expect(recoverPrepareCoordinator(request)).rejects.toThrow(/injected store failure/);
    expect(existsSync(newEnvelope)).toBe(false);
    
    expect(recoveryAuditOf(fixture)).toEqual([]);
    setArtifactStore(createFsStore(fixture.harness));
    const retry = await recoverPrepareCoordinator(request);
    expect(retry.recovery.replay).toBe(false);
    expect(recoveryAuditOf(fixture)).toHaveLength(1);

    const crashed = makePrepareFixture();
    await ensurePrepareCoordinator(crashed);
    writeJson(coordinatorEnvelopeOf(crashed, RECOVERED_COORDINATOR_ID), {
      schema_version: 1,
      role: "coordinator",
      session_id: RECOVERED_COORDINATOR_ID,
      workflow_id: PREPARE_WORKFLOW,
      harness_root: crashed.harness,
    });
    const reclaimed = await recoverPrepareCoordinator(recoveryInputOf(crashed));
    expect(reclaimed.recovery.replay).toBe(false);
    expect(recoveryAuditOf(crashed)).toHaveLength(1);

    const alien = makePrepareFixture();
    await ensurePrepareCoordinator(alien);
    const alienEnvelope = coordinatorEnvelopeOf(alien, RECOVERED_COORDINATOR_ID);
    writeText(alienEnvelope, `${JSON.stringify({ schema_version: 1, role: "coordinator", session_id: "someone-else" })}\n`);
    const refusal = await prepareRefusalOf(() => recoverPrepareCoordinator(recoveryInputOf(alien)));
    expect(typeof refusal.code).toBe("string");
    // The foreign identity that replaced the created envelope is left untouched
    // and no audit record is written.
    expect(recoveryAuditOf(alien)).toEqual([]);
    expect(readJson(alienEnvelope).session_id).toBe("someone-else");
  }, 60000);

  test("prepare recovery records compass version provenance but does not gate on prose bytes", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    writeText(fixture.compassPath, `${readFileSync(fixture.compassPath, "utf8")}\n`);

    const recovered = await recoverPrepareCoordinator(recoveryInputOf(fixture));
    expect(recovered.recovery.replay).toBe(false);
    expect(recoveryAuditOf(fixture)).toHaveLength(1);
    const after = await recoveryViewOf(fixture);
    expect(after.priorSessionId).toBe(RECOVERED_COORDINATOR_ID);
    expect(after.blockers).toEqual([]);
  }, 60000);

  test("prepare coordinator recovery never unlinks an envelope that was replaced after its exclusive creation", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const newEnvelope = coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID);
    const alien = `${JSON.stringify({ schema_version: 1, role: "plan-pm", session_id: "somebody-else" })}\n`;

    // The snapshot commit fails after a different session identity replaces
    // the created envelope; cleanup must leave that foreign identity untouched.
    instrumentLocalStore(fixture.harness, (inner) => new ReplaceEnvelopeOnFailureStore(inner, newEnvelope, alien));
    await expect(recoverPrepareCoordinator(recoveryInputOf(fixture))).rejects.toThrow(/injected store failure/);
    setArtifactStore(createFsStore(fixture.harness));

    expect(recoveryAuditOf(fixture)).toEqual([]);
  }, 60000);

  test("prepare coordinator recovery refuses a malformed stop-list entry before hashing, storing or echoing it", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);

    // A stop entry is hashed into the request digest and persisted in the
    // immutable audit: only public session ids are acceptable, never an
    // arbitrary string (path-like or credential-like). The refusal is itself a
    // PUBLIC diagnostic (§5), so it must not repeat the rejected value — the
    // caller learns the rule and the entry's position/length instead.
    const rejected = ["a/b", "../creds/secret.json", `ghp_${"a".repeat(140)}`, "with space"];
    for (const entry of rejected) {
      const failure = await failureOf(() =>
        recoverPrepareCoordinator(recoveryInputOf(fixture, { stoppedSessionIds: [FIXTURE_COORDINATOR_ID, entry] })),
      );
      if (!(failure instanceof CoordinationError)) throw failure;
      const label = `${JSON.stringify(entry).slice(0, 12)}:`;
      expect(`${label} ${failure.code}`).toBe(`${label} coordination.identity-recovery.invalid-request`);
      expect(failure.message).toContain("public session id");
      expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toContain(entry);
      expect(failure.details).toMatchObject({ index: 1, length: entry.length });
      
      expect(existsSync(coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID))).toBe(false);
    }

    // An empty entry is refused by the same field rule (it is not a session id
    // at all), and a non-array stop assertion reports its SHAPE rather than the
    // value it was given.
    const blank = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(recoveryInputOf(fixture, { stoppedSessionIds: [FIXTURE_COORDINATOR_ID, ""] })),
    );
    expect(blank.code).toBe("coordination.identity-recovery.invalid-request");
    const notAList = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(recoveryInputOf(fixture, { stoppedSessionIds: "credential-like-secret" })),
    );
    expect(notAList.code).toBe("coordination.identity-recovery.unauthorized");
    expect(JSON.stringify(notAList.details)).not.toContain("credential-like-secret");
    
  }, 60000);

  test("prepare coordinator recovery never runs the JSON writer under an active execution authority", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
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
        recoveryInputOf(fixture, { cwd: activeRoot, harnessDir: activeHarness }),
      ),
    );
    expect("code" in failure && typeof failure.code === "string" ? failure.code : "").toBe("execution.direct-write-refused");
    // ... and it points at the existing DB recovery verb instead of aliasing it.
    expect(failure.message).toContain("session recover");
    expect(existsSync(coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID))).toBe(false);
    
  }, 60000);
});

/* A prose note beside the plan that no coordinator operation reads as a gate. */
function rewriteAssignment(fixture: Fixture, note: string, changeQaGate = true): void {
  writeText(
    join(fixture.sddDir, "assignment.md"),
    assignmentText({
      harness: fixture.harness,
      planId: PLAN_ID,
      planPath: fixture.planPath,
      worktreePath: fixture.worktreePath,
      sddDir: fixture.sddDir,
      branch: "feature/plan-a",
      note,
    }).replace("**QA gate**: mandatory", `**QA gate**: ${changeQaGate ? "pm-acceptance" : "mandatory"}`),
  );
}

/** Reissue one `prepare` through the coordinator session with a given config. */
function reissuePrepare(sessionPath: string, fixture: Fixture, expectedRevision: number, config?: Record<string, unknown>): Promise<unknown> {
  return mutatePlanCoordination({
    sessionPath,
    planId: PLAN_ID,
    expectedRevision,
    operation: config === undefined ? { kind: "prepare" } : { kind: "prepare", config },
  });
}

describe("one-shot prepared coordination — ordinary revisable config", () => {
  test("an unchanged prepare config is already satisfied and writes nothing", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    const config = { worktreePath: fixture.worktreePath, workingBranch: "feature/plan-a" };
    const first = await coordinatorCall(fixture, PLAN_ID, { kind: "prepare", config });
    expect(first.outcome).toBe("prepared");

    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    const before = readJson(fixture.snapshotPath);
    await expect(reissuePrepare(fixture.coordinatorSession, fixture, view.revision, config)).resolves.toMatchObject({
      outcome: "already-satisfied",
    });
    // An unrelated prose edit to an Assignment file is not a config change at all.
    rewriteAssignment(fixture, "non-semantic note edit after Prepare", false);
    await expect(reissuePrepare(fixture.coordinatorSession, fixture, view.revision, config)).resolves.toMatchObject({
      outcome: "already-satisfied",
    });
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  });

  test("prepare config stays revisable while the row is active, and a Done row refuses a new prepare", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    await coordinatorCall(fixture, PLAN_ID, { kind: "prepare", config: { worktreePath: fixture.worktreePath, workingBranch: "feature/plan-a" } });
    await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "start", evidence_paths: [] });

    // A mistaken config naming a branch the ACTUAL checkout is not on refuses and
    // leaves the valid prior config alone.
    const activeView = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    const refusedBefore = readJson(fixture.snapshotPath);
    expect(
      await errorCodeOf(() => reissuePrepare(fixture.coordinatorSession, fixture, activeView.revision, { workingBranch: "feature/plan-a-v2" })),
    ).toBe("coordination.invalid-input");
    expect(readJson(fixture.snapshotPath)).toEqual(refusedBefore);

    // The real correction: switch the disposable feature checkout onto the new
    // branch, then prepare that actual scope while the row stays active.
    git(["checkout", "-q", "-b", "feature/plan-a-v2"], fixture.worktreePath);
    const switchedView = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    const revised = await reissuePrepare(fixture.coordinatorSession, fixture, switchedView.revision, { workingBranch: "feature/plan-a-v2" });
    expect(revised).toMatchObject({ outcome: "prepared" });
    const row = planRowOf(fixture, PLAN_ID);
    expect((row.metadata as Record<string, unknown>).working_branch).toBe("feature/plan-a-v2");
    // A config revision never resets the row's own status or progress.
    expect(row.status).toBe("InProgress");
    const afterRevision = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    // The FULL recorded progress block is retained, not just one member.
    expect(afterRevision.row.coordination?.progress).toEqual({ status: "InProgress", summary: "start", evidence_paths: [] });

    // A Done row is not revisable configuration any more.
    updatePlanRow(fixture, PLAN_ID, (current) => ({ ...current, status: "Done" }));
    const doneView = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    const before = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => reissuePrepare(fixture.coordinatorSession, fixture, doneView.revision, { workingBranch: "feature/plan-a-v3" }))).toBe(
      "coordination.prepare-status",
    );
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  });

  test("a session that is not the workflow coordinator cannot prepare a row", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    await prepareCall(fixture, PLAN_ID);
    // A wrong-role envelope sitting at a plausible path is refused, never adopted.
    const outsider = join(fixture.workflowDir, "sessions", "prepare-reissue-outsider.json");
    writeJson(outsider, {
      schema_version: 1,
      role: "plan-pm",
      session_id: "prepare-reissue-outsider",
      workflow_id: WORKFLOW_ID,
      harness_root: fixture.harness,
    });
    const before = readJson(fixture.snapshotPath);
    const code = await errorCodeOf(() => reissuePrepare(outsider, fixture, 0, { workingBranch: "feature/plan-a" }));
    expect(typeof code).toBe("string");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  });
});
