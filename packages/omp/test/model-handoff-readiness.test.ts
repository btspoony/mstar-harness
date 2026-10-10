/**
 * E1/E2 contract tests — explicit workflow binding and read-only Phase 1
 * readiness.
 *
 * Every Git fact runs in a disposable repository with a local bare remote and a
 * linked integration worktree; the harness root, register, workflow snapshot,
 * compass, coordinator envelope, plan files and review/Prepare payload copies
 * are fixtures inside that disposable main checkout. Nothing here reads or
 * writes the operator's repository, harness, sessions, model settings or
 * configuration, and no test reaches the network: the only remote is a local
 * bare repository created inside the fixture root.
 *
 * The binding E2 consumes is the *actual* return value of
 * `reserveHandoffBinding`, captured before the fixture creates the workflow
 * artifacts — the same order of operations the coordinator performs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  createFsStore,
  initializeStore,
  mutateExecutionPlan,
  readExecutionAuthority,
  registerCatalogEntity,
  setArtifactStore,
} from "@mstar-harness/engine";
import type { ExecutionCaller, ExecutionContext, ExecutionSessionRef, ExecutionToken } from "@mstar-harness/engine";
import { inspectPhase1Readiness, reserveHandoffBinding } from "../src/model-handoff-readiness";
import type {
  HandoffBinding,
  HandoffBindingInput,
  Phase1CompletionInput,
  Phase1Readiness,
} from "../src/model-handoff-readiness";
import { executionBindingOf } from "../src/coordinator-identity";

const SPECIALISTS = ["product-manager", "architect", "writing-specialist"] as const;
const SCRATCH: string[] = [];
/** The module resolves the harness through the engine's documented precedence. */
const HARNESS_ENV = process.env.MSTAR_HARNESS_DIR;

beforeAll(() => {
  delete process.env.MSTAR_HARNESS_DIR;
});
afterAll(() => {
  if (HARNESS_ENV !== undefined) process.env.MSTAR_HARNESS_DIR = HARNESS_ENV;
  for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-handoff-readiness-"));
  SCRATCH.push(dir);
  return dir;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function text(path: string): string {
  return readFileSync(path, "utf8");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** CAS version of a file's current bytes, computed independently of the module. */
function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Age a file's atime so a later read stays observable under Linux `relatime`. */
function ageAtime(path: string): void {
  utimesSync(path, new Date(Date.now() - 3_600_000), new Date());
}

function atimeOf(path: string): number {
  return statSync(path).atimeMs;
}

function codesOf(readiness: Phase1Readiness): readonly string[] {
  return readiness.ready ? [] : readiness.codes;
}

function detailsOf(readiness: Phase1Readiness): readonly string[] {
  return readiness.ready ? [] : readiness.diagnostics.map((entry) => entry.detail);
}

type Fixture = Readonly<{
  root: string;
  main: string;
  harness: string;
  integration: string;
  integrationBranch: string;
  workflowId: string;
  siblingId: string;
  sessionId: string;
  planIds: readonly string[];
  reportPaths: readonly string[];
  binding: HandoffBinding;
  input: Phase1CompletionInput;
}>;

async function buildFixture(options: { workflowId?: string; planIds?: readonly string[] } = {}): Promise<Fixture> {
  const workflowId = options.workflowId ?? "fixture-iteration";
  const siblingId = "fixture-sibling-iteration";
  const planIds = options.planIds ?? ["fixture-plan"];
  const sessionId = "fixture-session-0001";
  const integrationBranch = "iteration/fixture";

  const root = scratchDir();
  const bare = join(root, "remote.git");
  git(["init", "-q", "--bare", bare], root);
  const main = join(root, "main");
  git(["init", "-q", "-b", "main", main], root);
  git(["config", "user.email", "fixture@example.invalid"], main);
  git(["config", "user.name", "fixture"], main);
  writeFileSync(join(main, "README.md"), "fixture\n");
  git(["add", "README.md"], main);
  git(["commit", "-qm", "init"], main);
  git(["remote", "add", "origin", bare], main);
  git(["push", "-q", "-u", "origin", "main"], main);

  const integration = join(root, "integration");
  git(["worktree", "add", "-q", "-b", integrationBranch, integration], main);
  git(["push", "-q", "-u", "origin", integrationBranch], integration);

  const harness = join(main, ".mstar");
  const workflowsDir = join(harness, "workflows");
  const iterationsDir = join(harness, "iterations");
  const plansDir = join(harness, "plans");
  for (const dir of [workflowsDir, iterationsDir, plansDir]) mkdirSync(dir, { recursive: true });

  // A sibling active iteration: registered, running and never adopted.
  mkdirSync(join(workflowsDir, siblingId), { recursive: true });
  writeJson(join(workflowsDir, siblingId, "snapshot.json"), {
    schema_version: 1,
    id: siblingId,
    type: "iteration",
    status: "running",
    started_at: "2026-09-16",
    updated_at: "2026-09-16T00:00:00.000Z",
    plans: [],
  });
  writeRegister(harness, [siblingId]);

  // E1 runs before the workflow artifacts exist — the real order of operations.
  const reservation = await reserveHandoffBinding(
    { workflowId, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
    { sessionId, cwd: main, taskSession: false },
  );
  if (!reservation.ok) throw new Error(`fixture reservation refused: ${reservation.code} ${reservation.message}`);
  const binding = reservation.binding;

  // The lawful workflow creation the coordinator performs after the reservation.
  const workflowDir = join(workflowsDir, workflowId);
  const iterationDir = join(iterationsDir, workflowId);
  const guidesDir = join(iterationDir, "guides");
  mkdirSync(join(workflowDir, "sessions"), { recursive: true });
  mkdirSync(guidesDir, { recursive: true });
  const envelopePath = join(workflowDir, "sessions", `${sessionId}.json`);
  writeJson(envelopePath, {
    schema_version: 1,
    role: "coordinator",
    session_id: sessionId,
    workflow_id: workflowId,
    harness_root: harness,
  });
  const planPaths = planIds.map((id) => join(plansDir, `${id}.md`));
  // §4: a real registered plan markdown declares its own `plan_id` — the
  // shared resolver (registration, the Prepare append and readiness) requires
  // that declaration, so the fixture states it like any registered plan does.
  planPaths.forEach((path, index) =>
    writeFileSync(path, `# ${planIds[index]}\n\n**plan_id:** ${planIds[index]}\n\nPlan body.\n`),
  );
  const evidencePaths = planIds.map((id) => join(guidesDir, `${id}-prepare.md`));
  evidencePaths.forEach((path, index) => writeFileSync(path, `# Prepare evidence — ${planIds[index]}\n`));
  const reportPaths = SPECIALISTS.map((role) => join(guidesDir, `${role}-return.md`));
  reportPaths.forEach((path, index) => writeFileSync(path, `returned payload — ${SPECIALISTS[index]}\n`));
  writeJson(join(workflowDir, "snapshot.json"), {
    schema_version: 1,
    id: workflowId,
    type: "iteration",
    status: "running",
    phase: "phase-1-prepare",
    started_at: "2026-09-16",
    updated_at: "2026-09-16T00:00:00.000Z",
    compass_ref: `iterations/${workflowId}/delivery-compass.md`,
    branch: { base: "main", integration: integrationBranch, target: "main" },
    execution_policy: { plan_parallelism: "parallel", worktree_mode: "required", push_policy: "after-review-wave" },
    integration_worktree_path: integration,
    plans: planIds.map((id, index) => ({
      id,
      title: id,
      file: planPaths[index]!,
      status: "InProgress",
    })),
    coordination: {
      coordinator: { session_id: sessionId, session_file: envelopePath, bound_at: "2026-09-16T00:00:00.000Z" },
    },
  });
  writeFileSync(
    join(iterationDir, "delivery-compass.md"),
    [
      "---",
      `iteration_id: ${workflowId}`,
      "start_date: 2026-09-16",
      "status: locked",
      "iteration_base_branch: main",
      `spec_integration_branch: ${integrationBranch}`,
      "target_branch: main",
      `integration_worktree_path: ${integration}`,
      "plans:",
      ...planIds.map((id) => `  - ${id}`),
      "---",
      "",
      "# Fixture compass",
      "",
    ].join("\n"),
  );
  writeRegister(harness, [siblingId, workflowId]);

  const input: Phase1CompletionInput = {
    workflowId,
    coordinatorSessionPath: envelopePath,
    mainWorktreeBranch: "main",
    reviews: [
      { role: "product-manager", agentId: "fixture-pm-agent", resultRef: "agent://fixture-pm-agent", reportPath: reportPaths[0]! },
      {
        role: "architect",
        agentId: "fixture-architect-agent",
        resultRef: "agent://fixture-architect-agent",
        reportPath: reportPaths[1]!,
      },
      {
        role: "writing-specialist",
        agentId: "fixture-writer-agent",
        resultRef: "artifact://fixture-writer-agent",
        reportPath: reportPaths[2]!,
      },
    ],
    plans: planIds.map((id, index) => ({
      planId: id,
      planPath: planPaths[index]!,
      prepareEvidencePath: evidencePaths[index]!,
    })),
  };

  return { root, main, harness, integration, integrationBranch, workflowId, siblingId, sessionId, planIds, reportPaths, binding, input };
}

function writeRegister(harness: string, ids: readonly string[], dirs: Record<string, string> = {}): void {
  writeJson(join(harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-16",
    workflows: ids.map((id) => ({ id, type: "iteration", started_at: "2026-09-16", dir: dirs[id] ?? `workflows/${id}` })),
  });
}

function snapshotPathOf(fixture: Fixture): string {
  return join(fixture.harness, "workflows", fixture.workflowId, "snapshot.json");
}

function compassPathOf(fixture: Fixture): string {
  return join(fixture.harness, "iterations", fixture.workflowId, "delivery-compass.md");
}

/** The module derives refusal paths canonically (`realpath` of the nearest existing ancestor). */
function canonicalize(path: string): string {
  return realpathSync(dirname(path)) === dirname(path) ? path : join(realpathSync(dirname(path)), basename(path));
}

function patchSnapshot(fixture: Fixture, patch: Record<string, unknown>): void {
  const path = snapshotPathOf(fixture);
  const doc = JSON.parse(text(path)) as Record<string, unknown>;
  writeJson(path, { ...doc, ...patch });
}

/** Replace one compass frontmatter line, matched by its key. */
function setCompassField(fixture: Fixture, key: string, value: string): void {
  const path = compassPathOf(fixture);
  const body = text(path);
  const pattern = new RegExp(`^${key}: .*$`, "mu");
  if (!pattern.test(body)) throw new Error(`fixture compass has no ${key}`);
  writeFileSync(path, body.replace(pattern, `${key}: ${value}`));
}

/** Point both documents at one integration checkout path (anchors stay in agreement). */
function setIntegrationPath(fixture: Fixture, path: string): void {
  patchSnapshot(fixture, { integration_worktree_path: path });
  setCompassField(fixture, "integration_worktree_path", path);
}




/* ------------------------------------------------------------------------ *
 * The ACTIVE route (§6): DB root/workflow/plan views + real Git/artifact
 * witnesses. No retired document (root register, workflow snapshot, session
 * envelope) exists anywhere in these fixtures — a verdict that needed one could
 * not be produced at all.
 * ------------------------------------------------------------------------ */

type ActiveFixture = Readonly<{
  root: string;
  main: string;
  harness: string;
  integration: string;
  integrationBranch: string;
  workflowId: string;
  planId: string;
  sessionId: string;
  /** The DB's own coordinator seat, as `bindExecutionSession` returned it. */
  coordinator: ExecutionSessionRef;
  binding: HandoffBinding;
  input: Phase1CompletionInput;
  planPath: string;
  /** A second real plan document that is NOT the row's registered pointer. */
  movedPlanPath: string;
  prepareEvidencePath: string;
  reportPaths: readonly string[];
  compassPath: string;
}>;

type ActiveFixtureOptions = {
  compassStatus?: "locked" | "active";
  /** Skip the DB `prepare` operation, so the plan row records no Prepare. */
  skipPrepare?: boolean;
  /** Bind this session id as the coordinator instead of the default one. */
  sessionId?: string;
};

/** A canonical plain copy of an engine-returned session reference. */
function plainRef(ref: ExecutionSessionRef): ExecutionSessionRef {
  return {
    storeId: ref.storeId,
    epoch: ref.epoch,
    workflowId: ref.workflowId,
    role: ref.role,
    sessionId: ref.sessionId,
  };
}


/**
 * The real ACTIVE-authority fixture: a store upgraded to an execution authority,
 * the plan registered in the catalog, one created workflow (running, with its
 * branch anchors, compass reference, integration checkout and plan row), the
 * coordinator bound under the host session id the binding adopts, the plan
 * configured through ordinary prepare, and the real artifact/Git witnesses the
 * checkpoint samples.
 */
async function buildActiveFixture(options: ActiveFixtureOptions = {}): Promise<ActiveFixture> {
  const workflowId = "fixture-active-iteration";
  const planId = "fixture-active-plan";
  const sessionId = options.sessionId ?? "fixture-active-session-0001";
  const integrationBranch = "iteration/fixture-active";

  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-handoff-active-")));
  SCRATCH.push(root);
  const bare = join(root, "remote.git");
  git(["init", "-q", "--bare", bare], root);
  const main = join(root, "main");
  git(["init", "-q", "-b", "main", main], root);
  git(["config", "user.email", "fixture@example.invalid"], main);
  git(["config", "user.name", "fixture"], main);
  writeFileSync(join(main, "README.md"), "fixture\n");
  git(["add", "README.md"], main);
  git(["commit", "-qm", "init"], main);
  git(["remote", "add", "origin", bare], main);
  git(["push", "-q", "-u", "origin", "main"], main);

  const integration = join(root, "integration");
  git(["worktree", "add", "-q", "-b", integrationBranch, integration], main);
  git(["push", "-q", "-u", "origin", integrationBranch], integration);

  // No `status.json` and no `workflows/` directory: the execution authority is
  // initialized over an empty execution workspace, so no retired document can
  // silently answer any part of this route.
  const harness = join(main, ".mstar");
  const plansDir = join(harness, "plans");
  const sddDir = join(harness, "sdd", planId);
  const iterationDir = join(harness, "iterations", workflowId);
  const guidesDir = join(iterationDir, "guides");
  for (const dir of [plansDir, sddDir, guidesDir]) mkdirSync(dir, { recursive: true });

  const planPath = join(plansDir, `${planId}.md`);
  writeFileSync(planPath, `# ${planId}\n\n**plan_id:** ${planId}\n\nPlan body.\n`);
  const movedPlanPath = join(plansDir, "moved", `${planId}.md`);
  mkdirSync(dirname(movedPlanPath), { recursive: true });
  writeFileSync(movedPlanPath, `# ${planId} (moved)\n\n**plan_id:** ${planId}\n\nPlan body.\n`);
  const prepareEvidencePath = join(guidesDir, `${planId}-prepare.md`);
  writeFileSync(prepareEvidencePath, `# Prepare evidence — ${planId}\n`);
  const reportPaths = SPECIALISTS.map((role) => join(guidesDir, `${role}-return.md`));
  reportPaths.forEach((path, index) => writeFileSync(path, `returned payload — ${SPECIALISTS[index]}\n`));
  const planningWorktree = join(root, "plan-worktree");
  git(["worktree", "add", "-q", "-b", `feature/${planId}`, planningWorktree], main);
  const compassPath = join(iterationDir, "delivery-compass.md");
  writeFileSync(
    compassPath,
    [
      "---",
      `iteration_id: ${workflowId}`,
      "start_date: 2026-09-16",
      `status: ${options.compassStatus ?? "locked"}`,
      "iteration_base_branch: main",
      `spec_integration_branch: ${integrationBranch}`,
      "target_branch: main",
      `integration_worktree_path: ${integration}`,
      "plans:",
      `  - ${planId}`,
      "---",
      "",
      "# Fixture compass",
      "",
    ].join("\n"),
  );

  setArtifactStore(createFsStore(harness));
  const store = await initializeStore({ harnessDir: harness });
  store.close();
  const initialized = await readExecutionAuthority({ harnessDir: harness });
  await registerCatalogEntity(
    { harnessDir: harness },
    { kind: "plan", id: planId, title: planId, rootKind: "plans", relativePath: `plans/${planId}.md` },
    { operationId: `register-${planId}`, actor: "model-handoff-readiness.test" },
  );
  const context: ExecutionContext = {
    harnessDir: harness,
    caller: { sessionId, role: "coordinator", workflowId } satisfies ExecutionCaller,
  };
  await createExecutionWorkflow(context, {
    entry: { id: workflowId, type: "iteration", started_at: "2026-09-16T00:00:00Z", dir: `workflows/${workflowId}` },
    snapshot: {
      schema_version: 1,
      id: workflowId,
      type: "iteration",
      status: "running",
      phase: "phase-1-prepare",
      started_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
      compass_ref: `iterations/${workflowId}/delivery-compass.md`,
      branch: { base: "main", integration: integrationBranch, target: "main" },
      integration_worktree_path: integration,
      plans: [
        {
          id: planId,
          title: planId,
          file: `plans/${planId}.md`,
          status: "Todo",
        },
      ],
    } as never,
    expected: initialized.token,
    operationId: `create-${workflowId}`,
  });
  const workflowToken: ExecutionToken = (await readExecutionAuthority({ harnessDir: harness }, { workflowId })).token;
  const bound = await bindExecutionSession(context, {
    workflowId,
    role: "coordinator",
    expected: workflowToken,
    operationId: `bind-${sessionId}`,
  });
  if (options.skipPrepare !== true) {
    await mutateExecutionPlan(context, {
      operationId: `prepare-${planId}`,
      session: plainRef(bound.data),
      expected: (await readExecutionAuthority({ harnessDir: harness }, { workflowId, planId })).token,
      planId,
      operation: { kind: "prepare", config: { worktreePath: planningWorktree, workingBranch: `feature/${planId}` } },
    });
  }

  const reservation = await reserveHandoffBinding(
    { workflowId, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
    { sessionId, cwd: main, taskSession: false, executionBinding: executionBindingOf(harness, bound.data) },
  );
  if (!reservation.ok) throw new Error(`ACTIVE fixture reservation refused: ${reservation.code} ${reservation.message}`);
  const input: Phase1CompletionInput = {
    workflowId,
    mainWorktreeBranch: "main",
    reviews: [
      {
        role: "product-manager",
        agentId: "fixture-pm-agent",
        resultRef: "agent://fixture-pm-agent",
        reportPath: reportPaths[0]!,
      },
      {
        role: "architect",
        agentId: "fixture-architect-agent",
        resultRef: "agent://fixture-architect-agent",
        reportPath: reportPaths[1]!,
      },
      {
        role: "writing-specialist",
        agentId: "fixture-writer-agent",
        resultRef: "artifact://fixture-writer-agent",
        reportPath: reportPaths[2]!,
      },
    ],
    plans: [{ planId, planPath, prepareEvidencePath }],
  };
  return {
    root,
    main,
    harness,
    integration,
    integrationBranch,
    workflowId,
    planId,
    sessionId,
    coordinator: plainRef(bound.data),
    binding: reservation.binding,
    input,
    planPath,
    movedPlanPath,
    prepareEvidencePath,
    reportPaths,
    compassPath,
  };
}

/** The E1 input of one ACTIVE-route start. */
function activeBindingInput(workflowId: string): HandoffBindingInput {
  return { workflowId, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" };
}

describe("E1 explicit binding on the ACTIVE route", () => {
  test("the adopted DB session binding reserves and is returned as the durable record's binding", async () => {
    const f = await buildActiveFixture();
    const adopted = f.binding.executionBinding;
    expect(adopted).toBeDefined();
    if (adopted === null || adopted === undefined) throw new Error("the ACTIVE arm must adopt the DB binding");
    expect(adopted.version).toBe(1);
    expect(adopted.harnessRoot).toBe(realpathSync(f.harness));
    expect(adopted.session).toEqual(f.coordinator);
    // The reference a durable record persists is a plain canonical value, never
    // the engine's own object.
    expect(Object.getPrototypeOf(adopted.session)).toBe(Object.prototype);
    // The derived locations follow from the control root and the named workflow.
    expect(f.binding.controlRoot).toBe(realpathSync(f.main));
    expect(f.binding.compassPath).toBe(join(realpathSync(f.harness), "iterations", f.workflowId, "delivery-compass.md"));
  }, 120_000);

  test("a binding that does not describe this host session, workflow or coordinator seat refuses", async () => {
    const f = await buildActiveFixture();
    const adopted = f.binding.executionBinding!;
    const host = (executionBinding: unknown) => ({
      sessionId: f.sessionId,
      cwd: f.main,
      taskSession: false,
      executionBinding: executionBinding as never,
    });

    // Another session's reference: a copy-only claim never matches the session
    // this call acquired.
    const foreignSession = await reserveHandoffBinding(
      activeBindingInput(f.workflowId),
      host({ ...adopted, session: { ...adopted.session, sessionId: "someone-else-session" } }),
    );
    expect(foreignSession).toMatchObject({ ok: false, code: "not-coordinator" });

    // A stale epoch: the engine's own reference check refuses it.
    const stale = await reserveHandoffBinding(
      activeBindingInput(f.workflowId),
      host({ ...adopted, session: { ...adopted.session, epoch: adopted.session.epoch + 1 } }),
    );
    expect(stale).toMatchObject({ ok: false, code: "not-coordinator" });

    // The engine's own reference shape is part of the binding SHAPE this arm
    // admits (`assertRefShape`): the workflow's coordinator seat and no per-plan
    // scope. A reference declaring a plan id, or the removed plan-pm seat, is one
    // the engine could never accept — it is refused as a binding and never
    // reaches the seat comparison.
    const coordinatorWithPlan = await reserveHandoffBinding(
      activeBindingInput(f.workflowId),
      host({ ...adopted, session: { ...adopted.session, planId: f.planId } }),
    );
    expect(coordinatorWithPlan).toMatchObject({ ok: false, code: "not-coordinator" });
    const planPmSeat = await reserveHandoffBinding(
      activeBindingInput(f.workflowId),
      host({ ...adopted, session: { ...adopted.session, role: "plan-pm" } }),
    );
    expect(planPmSeat).toMatchObject({ ok: false, code: "not-coordinator" });

    // Another workflow's binding.
    const otherWorkflow = await reserveHandoffBinding(
      activeBindingInput(`${f.workflowId}-other`),
      host(adopted),
    );
    expect(otherWorkflow).toMatchObject({ ok: false, code: "not-coordinator" });

    // A foreign control root.
    const foreignRoot = await reserveHandoffBinding(
      activeBindingInput(f.workflowId),
      host({ ...adopted, harnessRoot: f.integration }),
    );
    expect(foreignRoot).toMatchObject({ ok: false, code: "invalid-root" });

    // retired file-route subject (T7a/T21): a host without the adopted ACTIVE
    // binding refuses with consumer-not-ready, never by reading the old snapshot.
    const fileForm = await reserveHandoffBinding(
      activeBindingInput(f.workflowId),
      { sessionId: f.sessionId, cwd: f.main, taskSession: false },
    );
    expect(fileForm).toMatchObject({ ok: false, code: "execution.consumer-not-ready" });
  }, 120_000);
});

describe("E2 phase 1 readiness on the ACTIVE route", () => {
  test("the DB root/workflow/plan views plus the real artifact and Git witnesses report ready", async () => {
    const f = await buildActiveFixture();
    const readiness = await inspectPhase1Readiness(f.binding, f.input);
    expect(readiness.ready).toBe(true);
    if (!readiness.ready) throw new Error(`unexpected refusal: ${readiness.codes.join(", ")}`);
    expect(readiness.integrationHead).toBe(git(["rev-parse", "HEAD"], f.integration));
    const versions = readiness.receipt.artifactVersions.map((row) => row.path);
    expect(versions).toContain(realpathSync(f.compassPath));
    expect(versions).toContain(realpathSync(f.planPath));
    expect(readiness.binding.executionBinding?.session.sessionId).toBe(f.sessionId);
    // The envelope path is not part of an ACTIVE checkpoint's input at all.
    expect(f.input.coordinatorSessionPath).toBeUndefined();
    const [, architect, writer] = f.input.reviews;
    for (const reviews of [[writer], [architect, writer]]) {
      const selected = await inspectPhase1Readiness(f.binding, { ...f.input, reviews });
      expect(selected.ready).toBe(true);
      if (!selected.ready) throw new Error(`unexpected refusal: ${selected.codes.join(", ")}`);
      expect(selected.receipt.input.reviews).toEqual(reviews);
      expect(selected.binding.executionBinding?.session.sessionId).toBe(f.sessionId);
    }
  }, 120_000);

  test("the plan's registered pointer is the DB plan view's own, and a receipt naming another file refuses", async () => {
    const f = await buildActiveFixture();
    const mismatched: Phase1CompletionInput = {
      ...f.input,
      plans: [{ planId: f.planId, planPath: f.movedPlanPath, prepareEvidencePath: f.prepareEvidencePath }],
    };
    const readiness = await inspectPhase1Readiness(f.binding, mismatched);
    expect(readiness.ready).toBe(false);
    expect(codesOf(readiness)).toContain("prepare-not-locked");
    expect(detailsOf(readiness)).toContain("plan-identity-mismatch");
    const detail = readiness.ready
      ? undefined
      : readiness.diagnostics.find((entry) => entry.detail === "plan-identity-mismatch");
    // The expectation is the DB row's OWN registered file — the plan view is
    // what resolves the pointer, and the receipt's caller-supplied path is never
    // echoed back (§5 safe rendering).
    expect(detail?.expected).toBe(realpathSync(f.planPath));
    expect(detail).toMatchObject({ planId: f.planId, source: "plan-row" });
    expect(detail).not.toHaveProperty("current");
  }, 120_000);

  test("artifact readiness does not require a ceremonial DB prepare record", async () => {
    const f = await buildActiveFixture({ skipPrepare: true });
    const readiness = await inspectPhase1Readiness(f.binding, f.input);
    expect(readiness.ready).toBe(true);
  }, 120_000);

  test("an unlocked DB-route compass is classified as an unlocked Prepare", async () => {
    const f = await buildActiveFixture({ compassStatus: "active" });
    const readiness = await inspectPhase1Readiness(f.binding, f.input);
    expect(readiness.ready).toBe(false);
    expect(codesOf(readiness)).toContain("prepare-not-locked");
    expect(detailsOf(readiness)).toContain("prepare-unlocked");
    expect(detailsOf(readiness)).not.toContain("plan-pointer-invalid");
    expect(readiness.ready ? undefined : readiness.diagnostics.find((entry) => entry.detail === "prepare-unlocked")?.current).toBe(
      "active",
    );
  }, 120_000);

  test("the real Git witnesses still gate the ACTIVE route", async () => {
    const f = await buildActiveFixture();
    const baseline = await inspectPhase1Readiness(f.binding, f.input);
    expect(baseline.ready).toBe(true);

    // A local commit the integration remote does not hold.
    writeFileSync(join(f.integration, "unpushed.txt"), "local only\n");
    git(["add", "unpushed.txt"], f.integration);
    git(["commit", "-qm", "unpushed"], f.integration);
    const unpushed = await inspectPhase1Readiness(f.binding, f.input);
    expect(unpushed.ready).toBe(false);
    expect(codesOf(unpushed)).toContain("push-unverified");
  }, 120_000);

  test("a missing writing-specialist return refuses review-evidence-missing", async () => {
    const f = await buildActiveFixture();
    const missingWriter: Phase1CompletionInput = { ...f.input, reviews: f.input.reviews.slice(0, -1) as never };
    const readiness = await inspectPhase1Readiness(f.binding, missingWriter);
    expect(readiness.ready).toBe(false);
    expect(codesOf(readiness)).toContain("review-evidence-missing");
  }, 120_000);
  // retired file-route subject (T7a/T21): a fabricated pre-activation binding,
  // snapshot and envelope no longer establish readiness authority.
});
