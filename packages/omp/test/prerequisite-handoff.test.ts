/**
 * Readiness integration on the real producers — prerequisite contract §5.
 *
 * The state this fixture builds is the reported one: a **registered**
 * iteration, a document Prepare lock, and a coordinator binding whose recorded
 * owner can no longer authenticate (the cancelled host handoff). Everything on
 * that state is produced by the shipped entry points, never by a hand-written
 * stand-in for them:
 *
 * - `registerShippedCatalogExecution` — the shipped registration producer the
 *   `mstar iteration register` verb calls — creates the root register entry, the
 *   snapshot and the **canonical absolute** plan pointer from a harness-relative
 *   input spelling;
 * - the engine's own `bindPlanSession` records the prior coordinator envelope;
 * - the readiness verdict is `inspectPhase1Readiness` — the function the
 *   registered model-handoff tool calls;
 * - the guarded recovery and its `show-recovery` view run through the REAL
 *   registered `mstar_coordinator` tool handler inside the host's own
 *   `ExtensionRunner` / `RegisteredToolAdapter`, including the registered
 *   input schema (a forged identity-shaped field is refused by the schema AND
 *   by the handler's own boundary).
 *
 * Contract pinned here (§5): the broad refusal codes are preserved while a
 * typed subreason distinguishes the identity failure (`identity-missing` /
 * `identity-mismatch` / `foreign-owner` / `recovery-not-prepare` /
 * `recovery-stale` / `recovery-unauthorized`) and the path failure
 * (`plan-pointer-invalid` / `plan-identity-mismatch` / a genuinely
 * `prepare-unlocked`). An old `.mstar/plans/<id>.md` row is never rendered as
 * an unlocked compass, and the engine's own route verdict
 * (`execution.consumer-not-ready`) is captured separately from an
 * identity-invalid verdict. No diagnostic carries an envelope path, credential
 * or session JSON.
 *
 * **Source fixture success is not evidence of this workflow's real handoff.**
 * Nothing here starts a host process, switches a model or claims `handed_off`;
 * the fixture proves the readiness/identity/path integration only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionActions, ExtensionContextActions, ExtensionMode } from "@oh-my-pi/pi-coding-agent";
import {
  ExtensionRunner,
  RegisteredToolAdapter,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
  amendPrepareWorkflow,
  bindPlanSession,
  createFsStore,
  initializeExecutionAuthority,
  initializeStore,
  registerShippedCatalogExecution,
  setArtifactStore,
  showPrepareWorkflow,
  writeWorkflowSnapshot,
} from "@mstar-harness/engine";
import type { WorkflowSnapshot } from "@mstar-harness/engine";
import { COORDINATOR_TOOL_NAME } from "../src/coordinator-identity";
import modelHandoffFactory, { HANDOFF_CUSTOM_TYPE } from "../src/extensions/model-handoff";
import { readHandoffSettings } from "../src/model-handoff-settings";
import { inspectPhase1Readiness, reserveHandoffBinding } from "../src/model-handoff-readiness";
import type { HandoffBinding, Phase1CompletionInput, Phase1Readiness } from "../src/model-handoff-readiness";

const WORKFLOW_ID = "20260921-prerequisite-handoff";
const PLAN_ID = "20260921-prerequisite-plan";
const INTEGRATION_BRANCH = "iteration/20260921-prerequisite-handoff";
const PRIOR_SESSION = "cancelled-prior-coordinator";
const HOST_SESSION = "fresh-host-coordinator";
const SPECIALISTS = ["product-manager", "architect", "writing-specialist"] as const;
const SCRATCH: string[] = [];
const HARNESS_ENV = process.env.MSTAR_HARNESS_DIR;

beforeAll(() => {
  delete process.env.MSTAR_HARNESS_DIR;
});
afterAll(() => {
  setArtifactStore(undefined);
  if (HARNESS_ENV !== undefined) process.env.MSTAR_HARNESS_DIR = HARNESS_ENV;
  for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true });
});

/* --------------------------------------------------------------- helpers --- */

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

/** CAS version of a file's current bytes, computed independently of the writer. */
function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function codesOf(readiness: Phase1Readiness): readonly string[] {
  return readiness.ready ? [] : readiness.codes;
}

function detailsOf(readiness: Phase1Readiness): readonly string[] {
  return readiness.ready ? [] : readiness.diagnostics.map((entry) => entry.detail);
}

function snapshotPathOf(harness: string): string {
  return join(harness, "workflows", WORKFLOW_ID, "snapshot.json");
}

function envelopePathOf(harness: string, sessionId: string): string {
  return join(harness, "workflows", WORKFLOW_ID, "sessions", `coordinator-${sessionId}.json`);
}

/* --------------------------------------------------------------- fixture --- */

type Fixture = Readonly<{
  root: string;
  main: string;
  harness: string;
  integration: string;
  /** The coordinator the workflow records: PRIOR (the cancelled owner) or HOST. */
  boundSession: string;
  binding: HandoffBinding;
  input: Phase1CompletionInput;
}>;

type FixtureOptions = {
  /** Who the snapshot records as coordinator; defaults to the cancelled owner. */
  boundSession?: string;
  /** A row pointer written AFTER the real registration (a stale stored row). */
  staleRowPointer?: string;
  /** The reviewed compass status; defaults to the document Prepare lock. */
  compassStatus?: string;
};

/**
 * One disposable control repository plus the real shipped registration:
 * bare remote, main checkout on `main` (pushed), a linked integration worktree
 * on its own pushed branch, the plan markdown declaring its `plan_id`, the CLI
 * registration, the recorded integration checkout, the document Prepare lock
 * and the engine's own coordinator bind.
 */
async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const boundSession = options.boundSession ?? PRIOR_SESSION;
  const root = scratchDir("omp-prerequisite-handoff-");
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
  git(["worktree", "add", "-q", "-b", INTEGRATION_BRANCH, integration], main);
  git(["push", "-q", "-u", "origin", INTEGRATION_BRANCH], integration);

  const harness = join(main, ".mstar");
  mkdirSync(join(harness, "plans"), { recursive: true });
  const planPath = join(harness, "plans", `${PLAN_ID}.md`);
  // §4: the registered plan markdown declares its own plan_id.
  writeFileSync(planPath, `# ${PLAN_ID}\n\n**plan_id:** ${PLAN_ID}\n\nPlan body for the integration fixture.\n`);

  // The shipped registration producer (the entry point `mstar iteration
  // register` calls): it journals through the catalog and normalizes every row
  // pointer to the canonical absolute plan file before it writes anything. The
  // control harness root is pinned as the store root first, exactly as the CLI
  // transport pins it; an initialized store below activation keeps the
  // unchanged FILE route.
  setArtifactStore(createFsStore(harness));
  await initializeStore({ harnessDir: harness }).then((handle) => handle.close());
  await registerShippedCatalogExecution(
    { harnessDir: harness },
    {
      operationId: "op-prerequisite-handoff-register",
      actor: "prerequisite-handoff.test",
      workflow: {
        kind: "iteration",
        workflowId: WORKFLOW_ID,
        options: {
          harnessDir: harness,
          compassRef: `iterations/${WORKFLOW_ID}/delivery-compass.md`,
          branch: { base: "main", integration: INTEGRATION_BRANCH, target: "main" },
          rows: [{ id: PLAN_ID, title: "Prerequisite plan", file: `plans/${PLAN_ID}.md` }],
          startedAt: "2026-09-21T00:00:00.000Z",
        },
      },
    },
  );

  const snapshotPath = snapshotPathOf(harness);
  const registeredSnapshot = JSON.parse(text(snapshotPath)) as WorkflowSnapshot & Record<string, unknown>;
  const canonicalPlanPath = (registeredSnapshot.plans[0] as { file?: string } | undefined)?.file;
  if (canonicalPlanPath !== realpathSync(planPath)) {
    throw new Error(`the registration did not persist the canonical plan pointer: ${String(canonicalPlanPath)}`);
  }
  // The Prepare phase is the one projection the ordinary snapshot writer may
  // change; the recorded integration checkout below belongs to the Prepare
  // amendment, exactly as the lifecycle records it.
  const workflowDir = dirname(snapshotPath);
  await writeWorkflowSnapshot(
    { ...registeredSnapshot, phase: "phase-1-prepare" },
    workflowDir,
    { expectedVersion: sha256(snapshotPath) },
  );

  // The engine's own coordinator bind: the envelope, the role and the recorded
  // top-level binding all come from `bindPlanSession`.
  await bindPlanSession({
    coordinator: true,
    workflowId: WORKFLOW_ID,
    harnessDir: harness,
    source: "host",
    cwd: main,
    sessionId: boundSession,
  });

  const iterationDir = join(harness, "iterations", WORKFLOW_ID);
  const guidesDir = join(iterationDir, "guides");
  mkdirSync(guidesDir, { recursive: true });
  const evidencePath = join(guidesDir, `${PLAN_ID}-prepare.md`);
  writeFileSync(evidencePath, `# Prepare evidence — ${PLAN_ID}\n`);
  const reportPaths = SPECIALISTS.map((role) => join(guidesDir, `${role}-return.md`));
  reportPaths.forEach((path, index) => writeFileSync(path, `returned payload — ${SPECIALISTS[index]}\n`));
  // The reviewed document Prepare lock (the review lock itself is a document
  // the PM owns; the checkpoint re-reads its frontmatter and bytes).
  const compassPath = join(iterationDir, "delivery-compass.md");
  writeFileSync(
    compassPath,
    [
      "---",
      `iteration_id: ${WORKFLOW_ID}`,
      "start_date: 2026-09-21",
      "status: locked",
      "iteration_base_branch: main",
      `spec_integration_branch: ${INTEGRATION_BRANCH}`,
      "target_branch: main",
      `integration_worktree_path: ${integration}`,
      "plans:",
      `  - ${PLAN_ID}`,
      "---",
      "",
      "# Prerequisite fixture compass",
      "",
    ].join("\n"),
  );

  // The guarded Prepare amendment records the integration checkout the
  // reviewed compass declares — the only route that may write that field.
  const envelopePath = envelopePathOf(harness, boundSession);
  const prepareView = await showPrepareWorkflow({ sessionPath: envelopePath, cwd: main });
  await amendPrepareWorkflow({
    sessionPath: envelopePath,
    cwd: main,
    expectedSnapshotVersion: prepareView.view.snapshotVersion,
    expectedCompassVersion: prepareView.view.compassVersion,
    patch: { mainWorktreeBranch: "main", appendPlans: [], integrationWorktreePath: integration },
  });

  if (options.compassStatus !== undefined) {
    // An UNLOCKED document: the review lock was written above and amended
    // against, and the PM's own document is reopened afterwards. That is the
    // state the checkpoint must report as `prepare-unlocked`.
    const body = text(compassPath);
    writeFileSync(compassPath, body.replace(/^status: .*$/mu, `status: ${options.compassStatus}`));
  }

  if (options.staleRowPointer !== undefined) {
    // A row registered BEFORE the path contract, holding the pre-contract
    // repository-relative spelling. No shipped writer can produce it (that is
    // the point of §4), so the legacy row is written straight to the snapshot
    // and left exactly as stored — readiness never normalizes or repairs it.
    const stale = JSON.parse(text(snapshotPath)) as WorkflowSnapshot & { plans: Array<Record<string, unknown>> };
    stale.plans = stale.plans.map((row) => ({ ...row, file: options.staleRowPointer }));
    writeJson(snapshotPath, stale);
  }

  const reservation = await reserveHandoffBinding(
    { workflowId: WORKFLOW_ID, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
    { sessionId: HOST_SESSION, cwd: main, taskSession: false },
    "attach",
  );
  if (!reservation.ok) throw new Error(`fixture reservation refused: ${reservation.code} ${reservation.message}`);

  const input: Phase1CompletionInput = {
    workflowId: WORKFLOW_ID,
    coordinatorSessionPath: envelopePath,
    mainWorktreeBranch: "main",
    reviews: [
      { role: "product-manager", agentId: "fixture-pm", resultRef: "agent://fixture-pm", reportPath: reportPaths[0]! },
      {
        role: "architect",
        agentId: "fixture-architect",
        resultRef: "agent://fixture-architect",
        reportPath: reportPaths[1]!,
      },
      {
        role: "writing-specialist",
        agentId: "fixture-writer",
        resultRef: "artifact://fixture-writer",
        reportPath: reportPaths[2]!,
      },
    ],
    plans: [{ planId: PLAN_ID, planPath: canonicalPlanPath, prepareEvidencePath: evidencePath }],
  };
  return { root, main, harness, integration, boundSession, binding: reservation.binding, input };
}

/* ------------------------------------------------- registered coordinator --- */

type ToolResult = Readonly<{
  content: readonly Readonly<{ type: string; text: string }>[];
  details: Readonly<{
    mstarCoordinator?: Record<string, unknown>;
    mstarModelHandoff?: Record<string, unknown>;
    ok?: boolean;
  }>;
  isError?: boolean;
}>;

/** The registered model-handoff tool's own name (`packages/omp/src/extensions/model-handoff.ts`). */
const HANDOFF_TOOL_NAME = "mstar_model_handoff";

/**
 * The host's own machinery for one session: `loadExtensionFromFactory` binds
 * the real extension through `ConcreteExtensionAPI`, `ExtensionRunner` builds
 * every `ExtensionContext`, and `RegisteredToolAdapter` is the host's tool
 * adapter, so a call traverses the registered input schema and the real
 * handler. No model credential is read and no model action is reachable.
 *
 * A caller-supplied `sessionManager` lets the fixture own the native session id
 * *before* it builds the workflow state that must name it (the pending handoff
 * ledger record and the recorded coordinator binding).
 */
async function coordinatorHarness(
  cwd: string,
  options: { sessionManager?: SessionManager } = {},
): Promise<{
  sessionId: string;
  runTool: (params: Record<string, unknown>) => Promise<ToolResult>;
  validate: (params: Record<string, unknown>) => { success: boolean };
  runRawTool: (params: Record<string, unknown>) => Promise<ToolResult>;
  runHandoffTool: (params: Record<string, unknown>) => Promise<ToolResult>;
  validateHandoff: (params: Record<string, unknown>) => { success: boolean };
}> {
  const settings = Settings.isolated({
    modelRoles: { slow: "probe/slow-model", default: "probe/default-model", smol: "probe/smol-model" },
  });
  const sessionManager = options.sessionManager ?? SessionManager.create(cwd, scratchDir("omp-prerequisite-session-"));
  const registry = {
    getAvailable: () => [],
    hasConfiguredAuth: () => false,
    getApiKey: async () => undefined,
    getApiKeyForProvider: async () => undefined,
    clearSuppressedSelector: () => {},
    refreshSelectedModelMetadata: async (model: unknown) => model,
  };
  const runtime = new ExtensionRuntime();
  const extension = await loadExtensionFromFactory(
    modelHandoffFactory,
    cwd,
    new EventBus(),
    runtime,
    "mstar-harness-model-handoff",
  );
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    cwd,
    sessionManager,
    registry as unknown as ModelRegistry,
    undefined,
    settings,
  );
  const unsupported = (name: string) => () => {
    throw new Error(`${name} must not be called by this fixture`);
  };
  const actions: ExtensionActions = {
    sendMessage: () => {},
    // The host's own durable append, so a handler that records state writes it.
    appendEntry: (customType, data) => {
      sessionManager.appendCustomEntry(customType, data);
    },
    sendUserMessage: unsupported("sendUserMessage"),
    setLabel: unsupported("setLabel"),
    getActiveTools: unsupported("getActiveTools"),
    getAllTools: unsupported("getAllTools"),
    setActiveTools: unsupported("setActiveTools"),
    getCommands: unsupported("getCommands"),
    setModel: unsupported("setModel"),
    getThinkingLevel: unsupported("getThinkingLevel"),
    setThinkingLevel: unsupported("setThinkingLevel"),
    getSessionName: unsupported("getSessionName"),
    setSessionName: unsupported("setSessionName"),
  };
  const contextActions: ExtensionContextActions = {
    getModel: unsupported("getModel"),
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: async () => {},
    getSystemPrompt: () => [],
  };
  runner.initialize(actions, contextActions, undefined, undefined, "json" as ExtensionMode);

  const registered = extension.tools.get(COORDINATOR_TOOL_NAME);
  if (registered === undefined) throw new Error("the host registered no coordinator-identity tool");
  const adapter = new RegisteredToolAdapter(registered, runner);
  const runRawTool = async (params: Record<string, unknown>): Promise<ToolResult> =>
    (await adapter.execute("fixture-call", params, undefined, undefined)) as ToolResult;

  const handoffTool = extension.tools.get(HANDOFF_TOOL_NAME);
  if (handoffTool === undefined) throw new Error("the host registered no model-handoff tool");
  const handoffAdapter = new RegisteredToolAdapter(handoffTool, runner);

  return {
    sessionId: sessionManager.getSessionId(),
    runTool: async (params) => runRawTool(registered.definition.parameters.parse(params) as Record<string, unknown>),
    validate: (params) => ({ success: registered.definition.parameters.safeParse(params).success }),
    runRawTool,
    runHandoffTool: async (params) =>
      (await handoffAdapter.execute(
        "fixture-handoff-call",
        handoffTool.definition.parameters.parse(params) as Record<string, unknown>,
        undefined,
        undefined,
      )) as ToolResult,
    validateHandoff: (params) => ({ success: handoffTool.definition.parameters.safeParse(params).success }),
  };
}

/* --------------------------------------------------------------- cases ----- */

describe("prerequisite handoff — readiness integration", () => {
  test("prerequisite handoff: a registered locked Prepare with a cancelled owner refuses as foreign-owner and names the guarded recovery", async () => {
    const fixture = await buildFixture();
    const readiness = await inspectPhase1Readiness(fixture.binding, fixture.input);
    expect(readiness.ready).toBe(false);
    expect(codesOf(readiness)).toContain("binding-invalid");

    const foreign = readiness.diagnostics.find((entry) => entry.detail === "foreign-owner");
    expect(foreign).toMatchObject({
      code: "binding-invalid",
      workflowId: WORKFLOW_ID,
      source: "snapshot-coordinator",
      expected: PRIOR_SESSION,
      current: HOST_SESSION,
    });
    // A repair is admitted for this Prepare lifecycle, so the next supported
    // operation is the audited recovery — not a blind re-bind.
    expect(foreign?.next).toContain(COORDINATOR_TOOL_NAME);
    expect(foreign?.next).toContain("recover");

    // The path predicate is untouched by the identity refusal, and the compass
    // is genuinely locked: no `prepare-unlocked` may appear.
    expect(detailsOf(readiness)).not.toContain("prepare-unlocked");
    expect(detailsOf(readiness)).not.toContain("plan-pointer-invalid");

    // Safe rendering: no envelope path, credential or session payload.
    const rendered = JSON.stringify(readiness.diagnostics);
    expect(rendered).not.toContain("/sessions/");
    expect(rendered).not.toContain("harness_root");
    expect(rendered).not.toContain("session_file");
    expect(rendered).not.toContain("store.db");
  }, 60_000);

  test("prerequisite handoff: the registered coordinator handler recovers the cancelled binding and readiness then passes", async () => {
    const fixture = await buildFixture();
    // The coordinator adapter resolves its control root from the ACTIVE store
    // root; pin it to this fixture's harness (no live harness is touched).
    setArtifactStore(createFsStore(fixture.harness));
    const host = await coordinatorHarness(fixture.main);
    // The REAL host session id is what the adapter derives; the fixture's own
    // `HOST_SESSION` is the value the file binding is asserted against.
    const hostId = host.sessionId;
    expect(hostId).not.toBe(PRIOR_SESSION);

    // The read-only view the recovery is reviewed against.
    const view = await host.runTool({ operation: "show-recovery", workflowId: WORKFLOW_ID });
    expect(view.isError).toBe(false);
    const details = view.details.mstarCoordinator as Record<string, unknown>;
    expect(details).toMatchObject({ priorSessionId: PRIOR_SESSION, allowed: true });
    expect(JSON.stringify(details)).not.toContain("/sessions/");

    // A caller-chosen identity, root or prior path is refused by the registered
    // schema AND by the handler's own boundary.
    for (const forged of [
      { operation: "recover", workflowId: WORKFLOW_ID, sessionId: hostId },
      { operation: "recover", workflowId: WORKFLOW_ID, harnessRoot: "/elsewhere/.mstar" },
      { operation: "recover", workflowId: WORKFLOW_ID, priorSessionPath: "/tmp/creds.json" },
    ]) {
      expect({ forged, valid: host.validate(forged).success }).toEqual({ forged, valid: false });
    }

    const recovered = await host.runTool({
      operation: "recover",
      workflowId: WORKFLOW_ID,
      expectedSnapshotVersion: details.snapshotVersion,
      expectedCompassVersion: details.compassVersion,
      operationId: "op-prerequisite-recover-1",
      reason: "the prior host handoff of this workflow was cancelled",
      authorizationRef: "PM-authorization-prerequisite",
      stoppedSessionIds: [PRIOR_SESSION],
    });
    expect(recovered.isError).toBe(false);
    expect(recovered.details.mstarCoordinator).toMatchObject({
      workflowId: WORKFLOW_ID,
      priorSessionId: PRIOR_SESSION,
      sessionId: hostId,
      replay: false,
    });

    // The engine's own state: the binding moved to this session and the old
    // envelope's bytes remain as history without authorizing anything.
    const snapshot = JSON.parse(text(snapshotPathOf(fixture.harness))) as {
      coordination?: { coordinator?: { session_id?: string } };
    };
    expect(snapshot.coordination?.coordinator?.session_id).toBe(hostId);
    expect(existsSync(envelopePathOf(fixture.harness, hostId))).toBe(true);
    // The prior (cancelled) binding no longer authorizes this checkpoint.
    const staleBinding = await inspectPhase1Readiness({ ...fixture.binding, sessionId: PRIOR_SESSION }, fixture.input);
    expect(codesOf(staleBinding)).toContain("binding-invalid");

    // Readiness on the recovered session: the same fixture now passes, which is
    // what makes the refusal above an identity verdict, never a weakened path.
    const recoveredBinding = await reserveHandoffBinding(
      { workflowId: WORKFLOW_ID, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
      { sessionId: hostId, cwd: fixture.main, taskSession: false },
      "attach",
    );
    if (!recoveredBinding.ok) throw new Error(`recovered reservation refused: ${recoveredBinding.code}`);
    const readiness = await inspectPhase1Readiness(recoveredBinding.binding, {
      ...fixture.input,
      coordinatorSessionPath: envelopePathOf(fixture.harness, hostId),
    });
    expect(readiness.ready).toBe(true);
    if (!readiness.ready) throw new Error(`unexpected refusal: ${readiness.codes.join(", ")}`);
    expect(readiness.integrationHead).toBe(git(["rev-parse", "HEAD"], fixture.integration));
  }, 120_000);

  test("prerequisite handoff: a genuinely unlocked compass is distinct from a stale plan pointer", async () => {
    const unlocked = await buildFixture({ boundSession: HOST_SESSION, compassStatus: "active" });
    setArtifactStore(createFsStore(unlocked.harness));
    const unlockedReadiness = await inspectPhase1Readiness(unlocked.binding, unlocked.input);
    expect(unlockedReadiness.ready).toBe(false);
    expect(codesOf(unlockedReadiness)).toContain("prepare-not-locked");
    expect(detailsOf(unlockedReadiness)).toContain("prepare-unlocked");
    expect(detailsOf(unlockedReadiness)).not.toContain("plan-pointer-invalid");
    expect(unlockedReadiness.diagnostics.find((entry) => entry.detail === "prepare-unlocked")?.current).toBe("active");

    // The stale stored row — the pre-contract `.mstar/plans/<id>.md` spelling —
    // is NEVER rendered as an unlocked compass: it keeps its own path detail.
    const stale = await buildFixture({ boundSession: HOST_SESSION, staleRowPointer: `.mstar/plans/${PLAN_ID}.md` });
    setArtifactStore(createFsStore(stale.harness));
    const staleReadiness = await inspectPhase1Readiness(stale.binding, stale.input);
    expect(staleReadiness.ready).toBe(false);
    expect(codesOf(staleReadiness)).toContain("prepare-not-locked");
    expect(detailsOf(staleReadiness)).toContain("plan-pointer-invalid");
    expect(detailsOf(staleReadiness)).not.toContain("prepare-unlocked");
    const pointer = staleReadiness.diagnostics.find((entry) => entry.detail === "plan-pointer-invalid");
    // §5 safe rendering: only the pointer's received *form* is classified — the
    // raw stored value (which may be any path at all) is never projected.
    expect(pointer).not.toHaveProperty("current");
    expect(pointer).toMatchObject({ planId: PLAN_ID, received: "harness-relative" });
    expect(pointer?.base).toBe(join(realpathSync(stale.harness), "plans"));
    expect(pointer?.target).toBe(join(realpathSync(stale.harness), "plans", `${PLAN_ID}.md`));
    expect(String(pointer?.next)).toContain("iteration register");
  }, 120_000);

  test("prerequisite handoff: cancelled, unpushed and missing-review states still refuse with their preserved codes", async () => {
    const fixture = await buildFixture({ boundSession: HOST_SESSION });
    setArtifactStore(createFsStore(fixture.harness));

    const baseline = await inspectPhase1Readiness(fixture.binding, fixture.input);
    expect(baseline.ready).toBe(true);

    // An unpushed integration commit: the remote tip no longer equals HEAD.
    writeFileSync(join(fixture.integration, "unpushed.txt"), "local only\n");
    git(["add", "unpushed.txt"], fixture.integration);
    git(["commit", "-qm", "unpushed"], fixture.integration);
    const unpushed = await inspectPhase1Readiness(fixture.binding, fixture.input);
    expect(codesOf(unpushed)).toContain("push-unverified");

    // A missing ordered specialist return.
    const missingReview = await inspectPhase1Readiness(fixture.binding, {
      ...fixture.input,
      reviews: fixture.input.reviews.slice(1),
    } as Phase1CompletionInput);
    expect(codesOf(missingReview)).toContain("review-evidence-missing");

    // A cancelled/foreign recorded owner: identity-invalid, and the recovery
    // verdict for THAT workflow (its own lifecycle admits a repair).
    const cancelled = await buildFixture();
    setArtifactStore(createFsStore(cancelled.harness));
    const cancelledReadiness = await inspectPhase1Readiness(cancelled.binding, cancelled.input);
    expect(codesOf(cancelledReadiness)).toContain("binding-invalid");
    expect(detailsOf(cancelledReadiness)).toContain("foreign-owner");
  }, 120_000);

  test("prerequisite handoff: the engine route verdict is captured separately from an identity-invalid verdict", async () => {
    // The identity verdict on the file route: a registered locked Prepare whose
    // recorded owner this session is not answers about the identity.
    const fixture = await buildFixture();
    setArtifactStore(createFsStore(fixture.harness));
    const identityVerdict = await inspectPhase1Readiness(fixture.binding, fixture.input);
    expect(identityVerdict.ready).toBe(false);
    expect(codesOf(identityVerdict)).toContain("binding-invalid");
    expect(detailsOf(identityVerdict)).toContain("foreign-owner");

    // The engine ROUTE verdict is a different cause entirely. An execution
    // authority is initialized only over an EMPTY workspace, so this half uses
    // its own disposable control checkout with no registration at all: the
    // binding is reserved first (file route), then the authority activates.
    const root = scratchDir("omp-prerequisite-route-");
    const bare = join(root, "remote.git");
    git(["init", "-q", "--bare", bare], root);
    const main = join(root, "main");
    git(["init", "-q", "-b", "main", main], root);
    git(["config", "user.email", "fixture@example.invalid"], main);
    git(["config", "user.name", "fixture"], main);
    writeFileSync(join(main, "README.md"), "fixture\n");
    git(["add", "README.md"], main);
    git(["commit", "-qm", "init"], main);
    const harness = join(main, ".mstar");
    mkdirSync(join(harness, "plans"), { recursive: true });

    const reserved = await reserveHandoffBinding(
      { workflowId: WORKFLOW_ID, entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
      { sessionId: HOST_SESSION, cwd: main, taskSession: false },
      "reserve",
    );
    if (!reserved.ok) throw new Error(`route fixture reservation refused: ${reserved.code}`);

    setArtifactStore(createFsStore(harness));
    await initializeStore({ harnessDir: harness }).then((handle) => handle.close());
    await initializeExecutionAuthority({ harnessDir: harness });

    const activeRoute = await inspectPhase1Readiness(reserved.binding, {
      workflowId: WORKFLOW_ID,
      coordinatorSessionPath: join(harness, "workflows", WORKFLOW_ID, "sessions", "coordinator-x.json"),
      mainWorktreeBranch: "main",
      reviews: fixture.input.reviews,
      plans: fixture.input.plans,
    });
    expect(activeRoute.ready).toBe(false);
    expect(codesOf(activeRoute)).toEqual(["execution.consumer-not-ready"]);
    // No file-route identity check ran at all: the verdict carries no identity
    // diagnostic, so the two causes are never conflated.
    expect(detailsOf(activeRoute)).toEqual([]);

    // The same reserved binding also refuses to reserve under the ACTIVE
    // authority instead of inventing a session reference for it.
    const reReserved = await reserveHandoffBinding(
      { workflowId: "20260921-prerequisite-route", entry: "iteration-start", intent: "new-iteration", authority: "coordinator" },
      { sessionId: HOST_SESSION, cwd: main, taskSession: false },
      "reserve",
    );
    expect(reReserved.ok).toBe(false);
    if (reReserved.ok) throw new Error("an ACTIVE authority must not yield a file binding");
    expect(reReserved.code).toBe("execution.consumer-not-ready");
  }, 120_000);

  test("prerequisite handoff: the registered model-handoff handler drives the shipped register → Prepare lock → readiness and forwards only safe path diagnostics", async () => {
    // Two stored pointers no shipped writer can produce — one path-shaped, one
    // credential-shaped. Neither its value NOR a credential/envelope path may
    // reach the readiness diagnostics or the registered tool's forwarded result
    // (contract §4 last bullet / §5 safe rendering).
    const cases = [
      { pointer: `/elsewhere/plans/${PLAN_ID}.md` },
      { pointer: "/var/credentials/coordinator-envelope.json" },
    ] as const;
    for (const { pointer } of cases) {
      // The native host session is created FIRST: the workflow binding, its
      // recorded coordinator and the pending ledger record all have to name it.
      // Its own cwd is kept as a handle: the host reads the native settings for
      // `ctx.cwd`, and `ExtensionRunner.cwd` is `sessionManager.getCwd()` (the
      // first argument below) — never the fixture repo.
      const sessionCwd = scratchDir("omp-prerequisite-session-home-");
      const sessionManager = SessionManager.create(sessionCwd, scratchDir("omp-prerequisite-session-"));
      const hostId = sessionManager.getSessionId();
      const fixture = await buildFixture({ boundSession: hostId, staleRowPointer: pointer });
      setArtifactStore(createFsStore(fixture.harness));
      // The saved preference a real `start` arm required: without it the
      // completion checkpoint refuses before readiness ever runs.
      //
      // The override goes to the session's own project root — the directory the
      // host resolves plugin settings from — and it declares every key this case
      // depends on, so the project layer alone decides the effective value: the
      // case never inherits the operator's or CI's user-level host settings.
      mkdirSync(join(sessionCwd, ".omp"), { recursive: true });
      writeJson(join(sessionCwd, ".omp", "plugin-overrides.json"), {
        settings: { "@mstar-harness/omp": { modelHandoff: true, handoffTarget: "@smol" } },
      });
      // The host helper the handler itself calls, resolved for that same
      // directory: a host-side change in where the project layer is read then
      // fails HERE, naming the settings contract, instead of surfacing later as
      // an unexplained `preference-off` on a machine without user settings.
      expect(await readHandoffSettings(sessionCwd)).toMatchObject({
        ok: true,
        value: { modelHandoff: true, handoffTarget: "@smol" },
      });

      // The pending binding a real arm records. Arming also performs a live
      // model selection (explicitly out of this task's scope), so the record is
      // seeded here while every read below is the registered handler's own.
      const recordBinding: HandoffBinding = { ...fixture.binding, sessionId: hostId };
      const baselineModelChangeId = sessionManager.appendModelChange("probe/slow-model");
      sessionManager.appendCustomEntry(HANDOFF_CUSTOM_TYPE, {
        version: 1,
        binding: recordBinding,
        state: "pending",
        operationId: "fixture-pending-handoff",
        action: "arm",
        baselineModelChangeId,
        observedModel: "probe/slow-model",
        reason: null,
      });

      const host = await coordinatorHarness(fixture.main, { sessionManager });
      expect(host.sessionId).toBe(hostId);

      // The REAL registered tool: schema parse → handler → `fire` → the E2
      // readiness checkpoint. The state under it was built by the shipped
      // registration producer and the document Prepare lock.
      const params = {
        operation: "phase1-complete",
        workflowId: WORKFLOW_ID,
        coordinatorSessionPath: fixture.input.coordinatorSessionPath,
        mainWorktreeBranch: "main",
        reviews: fixture.input.reviews,
        plans: fixture.input.plans,
      };
      expect(host.validateHandoff(params).success).toBe(true);
      const result = await host.runHandoffTool(params);
      expect(result.isError).toBe(false);
      const details = result.details.mstarModelHandoff as Record<string, unknown>;
      expect(details).toMatchObject({ code: "not-ready", state: "pending" });
      expect(details.codes).toContain("prepare-not-locked");

      const forwarded = details.diagnostics as readonly Record<string, unknown>[];
      const pointerEntry = forwarded.find((entry) => entry.detail === "plan-pointer-invalid");
      expect(pointerEntry).toMatchObject({ planId: PLAN_ID, source: "plan-row" });
      expect(pointerEntry).not.toHaveProperty("current");
      expect(forwarded.map((entry) => entry.detail)).not.toContain("prepare-unlocked");

      // The same verdict read from the checkpoint directly, and the tool's own
      // rendered result: neither carries the stored pointer or any credential
      // or envelope path.
      const readiness = await inspectPhase1Readiness(recordBinding, fixture.input);
      expect(codesOf(readiness)).toContain("prepare-not-locked");
      expect(JSON.stringify(readiness)).not.toContain(pointer);
      const rendered = JSON.stringify({ text: result.content.map((entry) => entry.text), details });
      expect(rendered).not.toContain(pointer);
      expect(rendered).not.toContain("credentials");
      expect(rendered).not.toContain("/sessions/");
    }
  }, 180_000);
});
