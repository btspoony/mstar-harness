/**
 * Phase-2 host adapter tests — `packages/omp/src/extensions/phase2-orchestration.ts`
 * (plan the registered Phase-2 instances plan T3; primary spec §A native observation,
 * §B reminder event/latch, §C capacity/journal).
 *
 * ## What is real here, and what the test supplies
 *
 * The extension is loaded and driven by the **host's own machinery**, not by a
 * hand-written stand-in API:
 *
 * - `loadExtensionFromFactory` binds the module's real factory through the
 *   host's own loader (real injected `pi.zod`, real `on` / `registerTool`, real
 *   registration registry on the returned `Extension`).
 * - `ExtensionRunner` is the host's runner: it builds every `ExtensionContext`,
 *   dispatches the registered events, honors handler results and enforces the
 *   host's handler timeouts. `initialize(actions, contextActions, …, mode)` is
 *   the host's wiring entry point, and the ninth constructor argument is the
 *   host's `getAsyncJobSnapshot` hook.
 * - `RegisteredToolAdapter` is the host's tool adapter, so tool invocation,
 *   parameter order and result shape are the host's.
 * - `SessionManager` writes the real session file and ledger: ids, `custom`
 *   records and `custom_message` notices (`appendCustomEntry` /
 *   `appendCustomMessageEntry` — the same calls `pi.appendEntry` /
 *   `pi.sendMessage` make).
 * - `AsyncJobManager` is the host's own job manager: the snapshot the extension
 *   observes is projected from real registered jobs exactly as
 *   `AgentSession.getAsyncJobSnapshot` projects them (owner-filtered, five recent
 *   rows, delivery state), so "running", "settled" and "delivery pending" are
 *   real manager states rather than hand-written snapshot literals.
 * - Every engine fact (workflow snapshot, coordinator binding, prepared plan,
 *   plan session and lease) is created through the **real engine verbs**
 *   (`bindPlanSession`, `mutatePlanCoordination`) or the canonical snapshot
 *   writer, never by hand-writing an accepted lease/binding.
 * - Native settings come from the host's own project override surface
 *   (`<cwd>/.omp/plugin-overrides.json`), read through the real
 *   `getPluginSettings` helper — no user settings are read or written.
 *
 * Supplied by the test: the job *content* (which real jobs exist), the model
 * registry double (this extension must never touch models — the double throws),
 * and the fact that no live agent loop drives the events.
 *
 * ## What is *not* claimed here
 *
 * No multiplexer is executed: no pane is created, no OMP child is started and no
 * prompt is submitted. The Herdr/tmux transport is PM-executed skill work (plan
 * T4); these cases prove admission bookkeeping around real files, and the
 * `uncertain` launch stays occupied exactly as the spec requires when a real
 * submission outcome is unknown. No process start, no credentials, no user
 * terminal state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ExtensionActions,
  ExtensionContextActions,
  ExtensionMode,
  SessionEntry,
} from "@oh-my-pi/pi-coding-agent";
import {
  ExtensionRunner,
  RegisteredToolAdapter,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { CustomMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/custom-message";
import { ensureThemeSync } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
  bindPlanSession,
  createFsStore,
  mutatePlanCoordination,
  readPlanCoordination,
  readWorkflowSnapshot,
  setArtifactStore,
  writeWorkflowSnapshot,
  type WorkflowSnapshot,
} from "@mstar-harness/engine";
import phase2OrchestrationFactory, {
  PHASE2_ADVISORY_CUSTOM_TYPE,
  PHASE2_CUSTOM_TYPE,
  PHASE2_NOTICE_CUSTOM_TYPE,
  derivePhase2State,
  phase2Seams,
  readPhase2Records,
  type Phase2Record,
} from "../src/extensions/phase2-orchestration";

const WORKFLOW_ID = "wf-phase2";
const PROJECT_ID = "proj-phase2";
const PLAN_IDS = ["plan-a", "plan-b"] as const;
const JOURNAL_FILE = "omp-launches.json";
const PLUGIN_NAME = "@mstar-harness/omp";
const TOOL_NAME = "mstar_phase2";
/** The session owner whose jobs the snapshot exposes (the host's own owner filter). */
const OWNER = "primary-coordinator";
/** The extension's frozen event wiring: sampling boundaries, one emission point, navigation. */
const PHASE2_EVENTS = [
  "agent_end",
  "input",
  "session_before_branch",
  "session_before_switch",
  "session_before_tree",
  "session_branch",
  "session_shutdown",
  "session_start",
  "session_switch",
  "session_tree",
];

type PlanId = (typeof PLAN_IDS)[number];

/* --------------------------------------------------------------- scratch --- */

const SCRATCH: string[] = [];
const HARNESS_ENV = process.env.MSTAR_HARNESS_DIR;
const HERDR_ENV = process.env.HERDR_ENV;

beforeAll(() => {
  delete process.env.MSTAR_HARNESS_DIR;
});

beforeEach(() => {
  delete process.env.HERDR_ENV;
});

afterAll(() => {
  if (HARNESS_ENV === undefined) delete process.env.MSTAR_HARNESS_DIR;
  else process.env.MSTAR_HARNESS_DIR = HARNESS_ENV;
  if (HERDR_ENV === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = HERDR_ENV;
  for (const root of SCRATCH.splice(0)) rmSync(root, { recursive: true, force: true });
  setArtifactStore(undefined);
});

function makeScratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(dir);
  return realpathSync(dir);
}

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
    "Independent prepared plan for the Phase-2 host adapter cases.",
    "",
  ].join("\n");
}

/* -------------------------------------------------------------- fixture ---- */

type Fixture = {
  root: string;
  harness: string;
  workflowDir: string;
  snapshotPath: string;
  journalPath: string;
  integrationPath: string;
  coordinatorSession: string;
  planPaths: Record<string, string>;
  assignments: Record<string, string>;
  sddDirs: Record<string, string>;
  worktrees: Record<string, string>;
};

/**
 * A real repository with one running Phase-2 workflow, two prepared independent
 * plans (each on its own linked worktree/branch), a bound coordinator session
 * and a real integration checkout. Every coordination fact the adapter asserts
 * against is engine-produced.
 */
function makeFixture(): Fixture {
  const root = makeScratch("omp-phase2-ext-");
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
    const worktreePath = join(root, `wt-${planId}`);
    writeText(planPath, `# Plan ${planId}\n`);
    mkdirSync(sddDir, { recursive: true });
    git(["worktree", "add", "-q", "-b", branch, worktreePath], root);
    writeText(join(worktreePath, "slice.txt"), `${planId} slice\n`);
    git(["add", "-A"], worktreePath);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `feat: ${planId} slice`], worktreePath);
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
    planPaths,
    assignments,
    sddDirs,
    worktrees,
  };
}

/** Bind the lifecycle coordinator (real engine verb) and prepare both plans. */
async function buildFixture(): Promise<Fixture> {
  const fixture = makeFixture();
  const bound = await bindPlanSession({ coordinator: true, workflowId: WORKFLOW_ID, harnessDir: fixture.harness, cwd: fixture.root, sessionId: "fixture-coordinator" });
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

function snapshotOf(fixture: Fixture): WorkflowSnapshot {
  return readWorkflowSnapshot(fixture.workflowDir).snapshot;
}

/**
 * Rewrite the snapshot's phase through the canonical engine writer — the same
 * field-scoped delta the Phase-2 entry guidance uses: the compare-and-swap token
 * is the version of the bytes just read, and a coordinated snapshot accepts the
 * write only from its own bound coordinator envelope.
 */
async function writeSnapshot(fixture: Fixture, patch: Pick<WorkflowSnapshot, "phase">): Promise<void> {
  const now = new Date().toISOString();
  await writeWorkflowSnapshot({ ...snapshotOf(fixture), ...patch, updated_at: now }, fixture.workflowDir, {
    expectedVersion: `sha256:${sha256OfFile(fixture.snapshotPath)}`,
    sessionPath: fixture.coordinatorSession,
  });
}

/** Seed the native preference through the host's project override surface. */
function writeSettings(fixture: Fixture, settings: { enabled: boolean; cap: number }): void {
  writeJson(join(fixture.root, ".omp", "plugin-overrides.json"), {
    settings: { [PLUGIN_NAME]: { phase2PlanInstances: settings.enabled, maxPlanInstances: settings.cap } },
  });
}

/**
 * A terminal workflow fixture. It is written as a document rather than derived
 * from engine verbs on purpose: the engine refuses to bind a coordinator to a
 * non-running lifecycle and `closeWorkflow` requires every plan row `Done`, so
 * a closed lifecycle with a coordinator envelope cannot be produced through the
 * verbs at all. The envelope is a read-only copy — the terminal refusal happens
 * before ownership is consulted, which is what this case asserts.
 */
function makeClosedWorkflow(fixture: Fixture): string {
  const closedId = "wf-closed";
  const closedDir = join(fixture.harness, "workflows", closedId);
  const endedAt = new Date().toISOString();
  writeJson(join(closedDir, "snapshot.json"), {
    schema_version: 1,
    id: closedId,
    type: "iteration",
    status: "completed",
    started_at: "2026-09-15T00:00:00Z",
    ended_at: endedAt,
    updated_at: endedAt,
    phase: "phase-6-post-merge-close",
    plans: [
      {
        id: "plan-closed",
        plan_id: "plan-closed",
        title: "Closed plan",
        file: ".mstar/plans/plan-closed.md",
        status: "Done",
        metadata: { project_id: PROJECT_ID },
      },
    ],
  });
  const envelope = join(closedDir, "sessions", `${closedId}.json`);
  writeJson(envelope, { ...readJson(fixture.coordinatorSession), workflow_id: closedId, harness_root: fixture.harness });
  return envelope;
}

/* ---------------------------------------------------------------- jobs ----- */

/** A parked job whose completion this test controls, registered with the host's manager. */
function startJob(jobs: AsyncJobManager, id: string, label: string): () => void {
  const gate = Promise.withResolvers<void>();
  jobs.register(
    "task",
    label,
    async () => {
      await gate.promise;
      return `${label} completed`;
    },
    { id, ownerId: OWNER },
  );
  return () => gate.resolve();
}

/**
 * Await the host manager's own completion signal for one job. The manager flips
 * the row's status inside that promise, so this waits on the real event instead
 * of guessing a duration.
 */
async function awaitSettled(jobs: AsyncJobManager, id: string): Promise<void> {
  const job = jobs.getAllJobs({ ownerId: OWNER }).find((entry) => entry.id === id);
  if (job === undefined) throw new Error(`job ${id} disappeared from the host manager`);
  await job.promise;
  if (job.status === "running") throw new Error(`job ${id} resolved without a terminal status`);
}

/**
 * Wait until the host reports no queued and no in-flight delivery. A parked
 * delivery sink is released by resolving its own promise; this then advances the
 * manager's delivery loop on microtask ticks alone (no wall-clock waits) until
 * the delivery state is clean, so a later assertion cannot pass merely because
 * a delivery is still pending.
 */
async function awaitDeliveryDrain(jobs: AsyncJobManager): Promise<void> {
  for (let tick = 0; tick < 20_000; tick += 1) {
    const delivery = snapshotOfJobs(jobs).delivery;
    if (delivery.queued === 0 && !delivery.delivering && delivery.pendingJobIds.length === 0) return;
    await Promise.resolve();
  }
  throw new Error("the host delivery never drained");
}

/** The host's own owner-filtered projection (`AgentSession.getAsyncJobSnapshot`). */
function snapshotOfJobs(jobs: AsyncJobManager): AsyncJobSnapshot {
  type Item = AsyncJobSnapshot["running"][number];
  const project = (job: { id: string; type: string; status: string; label: string; startTime: number; agentId?: string }): Item => ({
    id: job.id,
    type: job.type as Item["type"],
    status: job.status as Item["status"],
    label: job.label,
    startTime: job.startTime,
    agentId: job.agentId,
  });
  const filter = { ownerId: OWNER };
  return {
    running: jobs.getRunningJobs(filter).map(project),
    recent: jobs.getRecentJobs(5, filter).map(project),
    delivery: jobs.getDeliveryState(filter),
  };
}

/* -------------------------------------------------------------- harness ---- */

type ToolResult = Readonly<{
  content: readonly Readonly<{ type: string; text: string }>[];
  details: Readonly<{ mstarPhase2?: Record<string, unknown>; ok?: boolean }>;
  isError?: boolean;
}>;

type Advisory = Readonly<{ content: string; options: Readonly<Record<string, unknown>> | undefined }>;

type Harness = Readonly<{
  sessionManager: SessionManager;
  runner: ExtensionRunner;
  registered: () => Readonly<{
    handlers: readonly string[];
    tools: readonly string[];
    commands: number;
    shortcuts: number;
    flags: number;
    messageRenderers: number;
  }>;
  runTool: (params: Record<string, unknown>) => Promise<ToolResult>;
  validate: (params: Record<string, unknown>) => { success: boolean; message?: string };
  emitAgentEnd: () => Promise<unknown>;
  emitInput: (text: string, source?: "interactive" | "rpc" | "extension") => Promise<unknown>;
  emitBeforeAgentStart: (prompt: string) => Promise<unknown>;
  emitToolResult: (toolCallId: string) => Promise<unknown>;
  emit: (event: Record<string, unknown>) => Promise<unknown>;
  advisories: () => readonly Advisory[];
  noticeTexts: () => readonly string[];
  ledger: () => readonly SessionEntry[];
  records: () => readonly Phase2Record[];
  setPendingMessages: (value: boolean) => void;
}>;

async function createHarness(options: {
  sessionManager: SessionManager;
  jobs: AsyncJobManager;
  cwd: string;
  /** Simulate an unavailable native snapshot (null is never "no jobs"). */
  snapshotUnavailable?: boolean;
  mode?: ExtensionMode;
}): Promise<Harness> {
  const settings = Settings.isolated({});
  // The model registry is never touched by this extension: an access fails loudly.
  const registry = new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`the phase-2 extension must not touch the model registry (${String(property)})`);
      },
    },
  ) as unknown as ModelRegistry;

  const runtime = new ExtensionRuntime();
  const extension = await loadExtensionFromFactory(
    phase2OrchestrationFactory,
    options.cwd,
    new EventBus(),
    runtime,
    "mstar-harness-phase2",
  );
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    options.cwd,
    options.sessionManager,
    registry,
    undefined,
    settings,
    undefined,
    () => (options.snapshotUnavailable === true ? null : snapshotOfJobs(options.jobs)),
  );

  const session = (): SessionManager => runner.sessionManager;
  const advisories: Advisory[] = [];
  let pendingMessages = false;

  const unsupported = (name: string) => () => {
    throw new Error(`${name} must not be called by the phase-2 extension`);
  };
  const actions: ExtensionActions = {
    sendMessage: (message, sendOptions) => {
      if (message.customType === PHASE2_ADVISORY_CUSTOM_TYPE) {
        advisories.push({ content: String(message.content), options: sendOptions as Readonly<Record<string, unknown>> | undefined });
      }
      session().appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
    appendEntry: (customType, data) => {
      session().appendCustomEntry(customType, data);
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
    getSessionName: () => undefined,
    setSessionName: async () => {},
  };
  const contextActions: ExtensionContextActions = {
    getModel: () => undefined,
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => pendingMessages,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: async () => {},
    getSystemPrompt: () => [],
  };
  runner.initialize(actions, contextActions, undefined, undefined, options.mode ?? "tui");

  const registeredTool = extension.tools.get(TOOL_NAME);
  if (registeredTool === undefined) throw new Error("the host registered no mstar_phase2 tool");
  const adapter = new RegisteredToolAdapter(registeredTool, runner);

  return {
    sessionManager: runner.sessionManager,
    runner,
    registered: () => ({
      handlers: [...extension.handlers.keys()].sort(),
      tools: [...extension.tools.keys()].sort(),
      commands: extension.commands.size,
      shortcuts: extension.shortcuts.size,
      flags: extension.flags.size,
      messageRenderers: extension.messageRenderers.size,
    }),
    runTool: async (params) => {
      const parsed = registeredTool.definition.parameters.parse(params);
      return (await adapter.execute("fixture-tool-call", parsed, undefined, undefined)) as ToolResult;
    },
    validate: (params) => {
      const parsed = registeredTool.definition.parameters.safeParse(params);
      return parsed.success ? { success: true } : { success: false, message: parsed.error?.message ?? "" };
    },
    emitAgentEnd: () => runner.emit({ type: "agent_end", messages: [] } as never),
    emitInput: (text, source = "interactive") => runner.emitInput(text, undefined, source),
    emitBeforeAgentStart: (prompt) => runner.emitBeforeAgentStart(prompt, undefined, []),
    emitToolResult: (toolCallId) =>
      runner.emitToolResult({ type: "tool_result", toolCallId, toolName: "read", input: {}, content: [], isError: false } as never),
    emit: (event) => runner.emit(event as never),
    advisories: () => advisories,
    noticeTexts: () =>
      session()
        .getEntries()
        .flatMap((entry) =>
          entry.type === "custom_message" && entry.customType === PHASE2_NOTICE_CUSTOM_TYPE
            ? [typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)]
            : [],
        ),
    ledger: () => runner.sessionManager.getEntries(),
    records: () => readPhase2Records(runner.sessionManager.getEntries(), runner.sessionManager.getSessionId()),
    setPendingMessages: (value) => {
      pendingMessages = value;
    },
  };
}

/* -------------------------------------------------------------- helpers ---- */

function codeOf(result: ToolResult): string {
  return String(result.details.mstarPhase2?.code ?? "");
}

function intentOf(result: ToolResult): Record<string, unknown> {
  return (result.details.mstarPhase2?.intent ?? {}) as Record<string, unknown>;
}

function bindParams(fixture: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { operation: "bind", workflowId: WORKFLOW_ID, coordinatorSessionPath: fixture.coordinatorSession, ...overrides };
}

function newSession(cwd: string): SessionManager {
  return SessionManager.create(cwd, makeScratch("omp-phase2-sessions-"));
}

/** The reminder keys this session recorded, in ledger order. */
function reminderKeys(harness: Harness): readonly string[] {
  return harness
    .records()
    .flatMap((record) => (record.kind === "reminder" ? [record.observationKey] : []));
}

function journalIntents(fixture: Fixture): Array<Record<string, unknown>> {
  if (!existsSync(fixture.journalPath)) return [];
  return readJson(fixture.journalPath).intents as Array<Record<string, unknown>>;
}

/* ----------------------------------------------------------------- tests --- */

describe("phase2 host adapter", () => {
  test("explicit phase2 coordinator bind records the identity pointer from the real session", async () => {
    const fixture = await buildFixture();
    const harness = await createHarness({
      sessionManager: newSession(fixture.root),
      jobs: new AsyncJobManager({}),
      cwd: fixture.root,
    });

    // Exactly one tool, the frozen event wiring, and no activation command,
    // shortcut, flag or renderer at all.
    expect(harness.registered()).toEqual({
      handlers: PHASE2_EVENTS,
      tools: [TOOL_NAME],
      commands: 0,
      shortcuts: 0,
      flags: 0,
      messageRenderers: 0,
    });

    // The host's own schema is the tool contract: strict per operation.
    expect(harness.validate(bindParams(fixture))).toEqual({ success: true });
    expect(harness.validate({ operation: "bind", workflowId: WORKFLOW_ID })).toMatchObject({ success: false });
    expect(harness.validate({ ...bindParams(fixture), extra: 1 })).toMatchObject({ success: false });
    expect(harness.validate({ operation: "checkpoint", reason: "before-wait" })).toMatchObject({ success: false });
    expect(harness.validate({ operation: "record-launch", intentId: "i", observation: "created", evidencePath: "/tmp/e" })).toMatchObject({
      success: false,
    });

    const snapshotBefore = sha256OfFile(fixture.snapshotPath);
    const bound = await harness.runTool(bindParams(fixture));
    expect(bound.isError).toBe(false);
    expect(codeOf(bound)).toBe("bound");
    expect(bound.details.mstarPhase2).toMatchObject({
      applied: true,
      workflowId: WORKFLOW_ID,
      hostSessionId: harness.sessionManager.getSessionId(),
      coordinatorSessionPath: fixture.coordinatorSession,
      harnessRoot: fixture.harness,
      phase: "phase-2-execute",
    });

    // The identity pointer is the only durable record, and it is exact-session
    // filtered: a record for another session id is not this session's binding.
    const records = harness.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "bind",
      workflowId: WORKFLOW_ID,
      hostSessionId: harness.sessionManager.getSessionId(),
      coordinatorSessionPath: fixture.coordinatorSession,
    });
    expect(readPhase2Records(harness.ledger(), "some-other-session")).toEqual([]);
    expect(derivePhase2State(harness.ledger(), harness.sessionManager.getSessionId()).binding).toMatchObject({
      workflowId: WORKFLOW_ID,
    });

    // Idempotent: a second identical bind writes nothing and authorizes nothing.
    const again = await harness.runTool(bindParams(fixture));
    expect(codeOf(again)).toBe("already-bound");
    expect(again.details.mstarPhase2).toMatchObject({ applied: false });
    expect(harness.records()).toHaveLength(1);

    // Refusals write nothing: a different workflow and an unreadable envelope.
    const foreignWorkflow = await harness.runTool(bindParams(fixture, { workflowId: "wf-other" }));
    expect(foreignWorkflow.isError).toBe(true);
    expect(codeOf(foreignWorkflow)).toBe("phase2.workflow-mismatch");
    const missingEnvelope = await harness.runTool(bindParams(fixture, { coordinatorSessionPath: join(fixture.root, "absent.json") }));
    expect(codeOf(missingEnvelope)).toBe("phase2.envelope-unreadable");
    expect(harness.records()).toHaveLength(1);

    // Nothing engine-visible changed: no journal, no snapshot bytes, no notice.
    expect(existsSync(fixture.journalPath)).toBe(false);
    expect(sha256OfFile(fixture.snapshotPath)).toBe(snapshotBefore);
    expect(harness.noticeTexts()).toEqual([]);

    // Bound but no opportunity: `agent_end` stays silent (an idle first sample
    // is not an overlooked opportunity).
    await harness.emitAgentEnd();
    expect(harness.advisories()).toEqual([]);
    expect(reminderKeys(harness)).toEqual([]);
  });

  test("opt-in off still permits bounded reminder", async () => {
    const fixture = await buildFixture();
    // The saved preference is explicitly off — and it gates launches only.
    writeSettings(fixture, { enabled: false, cap: 2 });
    const jobs = new AsyncJobManager({});
    const harness = await createHarness({ sessionManager: newSession(fixture.root), jobs, cwd: fixture.root });

    expect(codeOf(await harness.runTool(bindParams(fixture)))).toBe("bound");

    // Launch admission is refused while the opt-in is off (settings gate first).
    const refused = await harness.runTool({
      operation: "reserve-launch",
      planId: "plan-a",
      transport: "herdr",
      skill: { name: "herdr", source: "herdr" },
      capability: { executable: process.execPath, version: "0.9.0", target: "pane-current" },
    });
    expect(refused.isError).toBe(true);
    expect(codeOf(refused)).toBe("launch.settings-disabled");
    expect(existsSync(fixture.journalPath)).toBe(false);

    // The bounded reminder is independent of that opt-in: real running work is
    // an opportunity the coordinator has not been told about yet.
    startJob(jobs, "job-1", "background slice");
    await harness.emitAgentEnd();
    const advisories = harness.advisories();
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.options).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });
    expect(advisories[0]!.content).toContain("phase-2-worktree-lease.md");
    expect(advisories[0]!.content).toContain("observation, not a dispatch");
    // It points at the checkpoint; it never asserts that a plan is ready.
    expect(advisories[0]!.content).not.toContain("plan-a");
    const keys = reminderKeys(harness);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.noticeTexts()).toEqual([]);

    // The recorded latch is durable and precedes the advisory that used it.
    const ledger = harness.ledger();
    const reminderIndex = ledger.findIndex((entry) => entry.type === "custom" && entry.customType === PHASE2_CUSTOM_TYPE);
    const advisoryIndex = ledger.findIndex(
      (entry) => entry.type === "custom_message" && entry.customType === PHASE2_ADVISORY_CUSTOM_TYPE,
    );
    expect(reminderIndex).toBeGreaterThan(-1);
    expect(advisoryIndex).toBeGreaterThan(reminderIndex);
  });

  test("one followup per changed observation", async () => {
    const fixture = await buildFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });
    const jobs = new AsyncJobManager({});
    const harness = await createHarness({ sessionManager: newSession(fixture.root), jobs, cwd: fixture.root });
    expect(codeOf(await harness.runTool(bindParams(fixture)))).toBe("bound");

    // A: running job 1.
    const settleOne = startJob(jobs, "job-1", "slice one");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(1);
    const keyA = reminderKeys(harness)[0]!;

    // Unchanged facts never re-fire: same observation, same latch.
    await harness.emitAgentEnd();
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(1);
    expect(reminderKeys(harness)).toEqual([keyA]);

    // B: a second running job is a changed observation, so it gets its own turn.
    const settleTwo = startJob(jobs, "job-2", "slice two");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(2);
    const keyB = reminderKeys(harness)[1]!;
    expect(keyB).not.toBe(keyA);

    // …back to A: job 2 settles, so the running set is job 1 again. The newly
    // terminal id is covered by the host's own delivery for that observation…
    settleTwo();
    await awaitSettled(jobs, "job-2");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(2);

    // …and once native coverage is consumed, the replayed latch keeps A silent:
    // A → B → A never nudges A twice, even across a reload.
    await harness.emitToolResult("tool-1");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(2);
    expect(reminderKeys(harness)).toEqual([keyA, keyB]);

    // A fresh instance over the same ledger replays the same latch: no state is
    // carried in memory between instances.
    const reloaded = await createHarness({ sessionManager: harness.sessionManager, jobs, cwd: fixture.root });
    await reloaded.emitBeforeAgentStart("continue");
    await reloaded.emitAgentEnd();
    expect(reloaded.advisories()).toEqual([]);
    expect(reminderKeys(reloaded)).toEqual([keyA, keyB]);

    // A PM checkpoint reads the *runtime-attached* key of the sample taken at
    // that moment; the caller cannot choose or reset it.
    const checkpoint = await harness.runTool({
      operation: "checkpoint",
      reason: "result-settled",
      decision: "wait",
      note: "re-ran the scheduling checkpoint after the settled slice",
    });
    expect(codeOf(checkpoint)).toBe("recorded");
    expect(checkpoint.details.mstarPhase2).toMatchObject({ applied: true, observationKey: keyA, sampled: true });

    // With A acknowledged, the same observation stays silent.
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(2);

    // A recorded block outranks any further opportunity — a new running job is
    // real churn and still gets no advisory.
    const blocked = await harness.runTool({
      operation: "checkpoint",
      reason: "dependency-changed",
      decision: "blocked",
      note: "waiting on the dependency decision before dispatching",
    });
    expect(blocked.details.mstarPhase2).toMatchObject({ blocked: true, applied: true });
    startJob(jobs, "job-3", "blocked-era slice");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(2);

    // Only a real user turn or a later checkpoint clears it: an
    // extension-injected input is not the user taking over.
    await harness.emitInput("what is the status?", "extension");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(2);
    expect(harness.records().some((record) => record.kind === "user-turn")).toBe(false);

    // The explicit turn clears the block durably; its own turn end is the
    // continuation, so no advisory is emitted for it.
    await harness.emitInput("go ahead and re-check", "interactive");
    expect(harness.records().filter((record) => record.kind === "user-turn")).toHaveLength(1);
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(2);

    // A further real change is once again eligible — which is what proves the
    // block is gone rather than merely quiet.
    startJob(jobs, "job-4", "post-unblock slice");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(3);
    expect(reminderKeys(harness)).toHaveLength(3);

    // A rebind starts a fresh latch. Blocked/acknowledged state recorded before
    // the newest binding must not suppress the new binding's opportunities.
    // (The rebind record is appended through the host's own ledger writer —
    // `appendCustomEntry`, the same call `pi.appendEntry` makes — because the
    // engine refuses to bind a coordinated lifecycle to a second envelope; the
    // sequence is exactly what a coordinator's second `bind` writes.)
    const blockedAgain = await harness.runTool({
      operation: "checkpoint",
      reason: "dependency-changed",
      decision: "blocked",
      note: "blocked before the rebind",
    });
    expect(blockedAgain.details.mstarPhase2).toMatchObject({ blocked: true });
    startJob(jobs, "job-5", "pre-rebind slice");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(3);

    const envelopeSessionId = String(readJson(fixture.coordinatorSession).session_id);
    harness.sessionManager.appendCustomEntry(PHASE2_CUSTOM_TYPE, {
      version: 1,
      kind: "bind",
      workflowId: WORKFLOW_ID,
      hostSessionId: harness.sessionManager.getSessionId(),
      coordinatorSessionPath: fixture.coordinatorSession,
      coordinatorSessionId: envelopeSessionId,
      harnessRoot: fixture.harness,
    });
    const rebound = derivePhase2State(harness.ledger(), harness.sessionManager.getSessionId());
    expect(rebound.reminder).toEqual({ acknowledgedKey: null, remindedKeys: [], blocked: false });

    // The observation that the old block suppressed is now eligible again…
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(4);
    // …and the fresh latch bounds it exactly as before.
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(4);

    settleOne();
    await awaitSettled(jobs, "job-1");
  });

  test("native completion does not duplicate", async () => {
    const fixture = await buildFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });
    const jobs = new AsyncJobManager({});
    const harness = await createHarness({ sessionManager: newSession(fixture.root), jobs, cwd: fixture.root });
    expect(codeOf(await harness.runTool(bindParams(fixture)))).toBe("bound");

    // Baseline: a running job is reminded about exactly once.
    const settle = startJob(jobs, "job-1", "background compile");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(1);

    // The job settles: the host's own delivery owns that completion, so the
    // plugin stays silent for the observation that contains it — including when
    // this coordinator turn also produced tool results before `agent_end`.
    settle();
    await awaitSettled(jobs, "job-1");
    await harness.emitToolResult("tool-settled");
    await harness.emitBeforeAgentStart("continue after native delivery");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(1);
    expect(harness.noticeTexts()).toEqual([]);

    // Same when a delivery is queued or in flight: never duplicated.
    const parkedDelivery = Promise.withResolvers<void>();
    const stopSink = jobs.registerDeliverySink(OWNER, async () => {
      // Parked on purpose: the host's delivery state stays pending until this
      // sub-case is done, which is exactly the condition to test.
      await parkedDelivery.promise;
    });
    const settleTwo = startJob(jobs, "job-2", "second background compile");
    settleTwo();
    await awaitSettled(jobs, "job-2");
    expect(snapshotOfJobs(jobs).delivery.delivering || snapshotOfJobs(jobs).delivery.queued > 0).toBe(true);
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(1);
    // Release the parked delivery and wait for the host to report a clean
    // delivery state: the race sub-case below must not pass merely because a
    // delivery is still pending (that alone would silence it).
    parkedDelivery.resolve();
    await awaitDeliveryDrain(jobs);
    stopSink();
    expect(snapshotOfJobs(jobs).delivery).toMatchObject({ queued: 0, delivering: false, pendingJobIds: [] });

    // A job that settles while the decision is still awaiting the settings read
    // is not swallowed by that decision's consumption: the ids consumed are
    // exactly the ones the decision sampled.
    const beforeRace = harness.advisories().length;
    const heldSettings = Promise.withResolvers<void>();
    const realReadSettings = phase2Seams.readSettings;
    let seamEntered = false;
    phase2Seams.readSettings = async (cwd) => {
      seamEntered = true;
      await heldSettings.promise;
      return realReadSettings(cwd);
    };
    const settleThree = startJob(jobs, "job-3", "third background compile");
    const inFlight = harness.emitAgentEnd();
    // Advance the emission to the held settings read without wall-clock waits.
    for (let tick = 0; tick < 2000 && !seamEntered; tick += 1) await Promise.resolve();
    expect(seamEntered).toBe(true);
    settleThree();
    await awaitSettled(jobs, "job-3");
    heldSettings.resolve();
    await inFlight;
    phase2Seams.readSettings = realReadSettings;

    // The decision sampled job-3 as running, so this turn nudges exactly once
    // for that changed observation — and with nothing pending, the nudge cannot
    // be suppressed by a delivery.
    const afterRace = harness.advisories().length;
    expect(afterRace - beforeRace).toBe(1);
    expect(snapshotOfJobs(jobs).recent.some((job) => job.id === "job-3")).toBe(true);
    // The settle is native delivery's, so the next turn must not nudge a second
    // time — under a second-snapshot consumption it would (that id would have
    // been consumed by the race turn and the settled state would look new).
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(afterRace);

    // Nothing delivered at all is still a real opportunity: reminded once, then
    // bounded by the latch. Exact counts, so a silent no-op cannot pass.
    startJob(jobs, "job-4", "fourth background compile");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(afterRace + 1);
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(afterRace + 1);

    // No completion text is ever reproduced by the plugin notice.
    for (const advisory of harness.advisories()) {
      expect(advisory.content).not.toContain("completed");
    }
  });

  test("task scoped and foreign sessions inert", async () => {
    const fixture = await buildFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });
    const jobs = new AsyncJobManager({});
    startJob(jobs, "job-1", "running work");

    // (a) A leaf/task session: refused before anything is recorded.
    const taskSession = newSession(fixture.root);
    taskSession.appendSessionInit({ systemPrompt: "task", task: "scout the repo", tools: ["read"], agent: "scout" });
    const taskHarness = await createHarness({ sessionManager: taskSession, jobs, cwd: fixture.root });
    const taskRefusal = await taskHarness.runTool(bindParams(fixture));
    expect(taskRefusal.isError).toBe(true);
    expect(codeOf(taskRefusal)).toBe("phase2.task-session");
    expect(taskHarness.records()).toEqual([]);
    await taskHarness.emitAgentEnd();
    expect(taskHarness.advisories()).toEqual([]);

    // (b) A scoped-plan PM session (real engine plan binding): it never binds
    // the coordinator observation.
    const planBound = await bindPlanSession({
      scope: { workflowId: WORKFLOW_ID, planId: "plan-a", harnessDir: fixture.harness },
      cwd: fixture.root,
    });
    expect(planBound.outcome).toBe("claimed");
    const planHarness = await createHarness({ sessionManager: newSession(fixture.root), jobs, cwd: fixture.root });
    const planRefusal = await planHarness.runTool(bindParams(fixture, { coordinatorSessionPath: planBound.session_file }));
    expect(codeOf(planRefusal)).toBe("phase2.plan-pm-session");
    expect(planHarness.records()).toEqual([]);
    await planHarness.emitAgentEnd();
    expect(planHarness.advisories()).toEqual([]);

    // (c) A session sitting in an extra primary's feature checkout is outside
    // the engine's coordinator residency, so it cannot claim the observation.
    const foreign = await createHarness({
      sessionManager: newSession(fixture.worktrees["plan-b"]!),
      jobs,
      cwd: fixture.worktrees["plan-b"]!,
    });
    const foreignRefusal = await foreign.runTool(bindParams(fixture));
    expect(codeOf(foreignRefusal)).toBe("phase2.scope-mismatch");
    expect(foreign.records()).toEqual([]);
    await foreign.emitAgentEnd();
    expect(foreign.advisories()).toEqual([]);

    // (d) A non-Phase-2 lifecycle is inert, not fatal: the identity pointer
    // stands, nothing is emitted, and the diagnostic is bounded to one notice
    // per generation.
    const harness = await createHarness({ sessionManager: newSession(fixture.root), jobs, cwd: fixture.root });
    expect(codeOf(await harness.runTool(bindParams(fixture)))).toBe("bound");
    await writeSnapshot(fixture, { phase: "phase-1-prepare" });
    await harness.emitAgentEnd();
    expect(harness.advisories()).toEqual([]);
    expect(harness.noticeTexts()).toHaveLength(1);
    expect(harness.noticeTexts()[0]).toContain("phase2.phase-inactive");
    await harness.emitAgentEnd();
    expect(harness.noticeTexts()).toHaveLength(1);

    const checkpoint = await harness.runTool({
      operation: "checkpoint",
      reason: "before-wait",
      decision: "wait",
      note: "should refuse outside Phase 2",
    });
    expect(checkpoint.isError).toBe(true);
    expect(codeOf(checkpoint)).toBe("phase2.phase-inactive");

    // (e) The bound envelope is re-read on every probe: a same-path replacement
    // (a new engine session id) makes the binding not-current — the checkpoint
    // refuses, the reminder stays silent, and nothing is written as a handoff.
    const originalEnvelope = readFileSync(fixture.coordinatorSession, "utf8");
    await writeSnapshot(fixture, { phase: "phase-2-execute" });
    const originalSnapshot = readFileSync(fixture.snapshotPath, "utf8");
    writeJson(fixture.coordinatorSession, {
      ...(JSON.parse(originalEnvelope) as Record<string, unknown>),
      session_id: "replacement-session-id",
    });
    const superseded = await harness.runTool({
      operation: "checkpoint",
      reason: "ownership-changed",
      decision: "wait",
      note: "the bound envelope was replaced on disk",
    });
    expect(superseded.isError).toBe(true);
    expect(codeOf(superseded)).toBe("phase2.ownership-drift");
    expect(String(superseded.content[0]!.text)).toContain("marked not-current");
    // The event path is inert for the same reason, and says so once.
    await harness.emitAgentEnd();
    expect(harness.advisories()).toEqual([]);
    expect(harness.noticeTexts().at(-1)).toContain("phase2.ownership-drift");

    // Re-reading a restored envelope clears the mark: the binding is current again.
    writeFileSync(fixture.coordinatorSession, originalEnvelope);
    const restored = await harness.runTool({
      operation: "checkpoint",
      reason: "ownership-changed",
      decision: "wait",
      note: "the original envelope is back",
    });
    expect(codeOf(restored)).toBe("recorded");

    // (f) The named snapshot going away disables the observation too: no
    // guessed key, no advisory, one bounded diagnostic — and the tool says so.
    rmSync(fixture.snapshotPath);
    await harness.emitAgentEnd();
    expect(harness.advisories()).toEqual([]);
    expect(harness.noticeTexts().at(-1)).toContain("phase2.snapshot-unreadable");
    expect(await harness.runTool(bindParams(fixture))).toMatchObject({ isError: true });

    // (g) A missing envelope is the other half of the same rule.
    writeFileSync(fixture.snapshotPath, originalSnapshot);
    rmSync(fixture.coordinatorSession);
    await harness.emitAgentEnd();
    expect(harness.advisories()).toEqual([]);
    expect(harness.noticeTexts().at(-1)).toContain("phase2.envelope-unreadable");
    const unreadable = await harness.runTool({
      operation: "checkpoint",
      reason: "before-wait",
      decision: "wait",
      note: "the bound envelope is gone",
    });
    expect(codeOf(unreadable)).toBe("phase2.envelope-unreadable");
    writeFileSync(fixture.coordinatorSession, originalEnvelope);

    // (h) A terminal lifecycle is refused outright, before ownership is even
    // consulted, and records nothing.
    const closedEnvelope = makeClosedWorkflow(fixture);
    const terminal = await harness.runTool({
      operation: "bind",
      workflowId: "wf-closed",
      coordinatorSessionPath: closedEnvelope,
    });
    expect(terminal.isError).toBe(true);
    expect(codeOf(terminal)).toBe("phase2.workflow-terminal");
    expect(harness.records().filter((record) => record.kind === "bind")).toHaveLength(1);
  });

  test("terminal diagnostic uses the shared status title, not a fixed prefix", async () => {
    const fixture = await buildFixture();
    const jobs = new AsyncJobManager({});
    const harness = await createHarness({ sessionManager: newSession(fixture.root), jobs, cwd: fixture.root });
    expect(codeOf(await harness.runTool(bindParams(fixture)))).toBe("bound");

    // The bound workflow goes terminal on disk: the probe read the snapshot
    // successfully, so the notice carries its id and status as evidence.
    const endedAt = new Date().toISOString();
    const terminal = {
      ...JSON.parse(readFileSync(fixture.snapshotPath, "utf8")) as Record<string, unknown>,
      status: "completed",
      ended_at: endedAt,
    };
    writeJson(fixture.snapshotPath, terminal);
    await harness.emitAgentEnd();

    expect(harness.advisories()).toEqual([]);
    expect(harness.noticeTexts()).toHaveLength(1);
    const notice = harness.noticeTexts()[0]!;
    expect(notice).toContain(WORKFLOW_ID);
    expect(notice).toContain("completed");
    expect(notice).toContain("phase2.workflow-terminal");
    // No fixed prefix, and no detail sentence asserting a current Phase-2 position.
    expect(notice).not.toContain("Phase-2");
    expect(notice).not.toContain("observation inactive");
    // The dedup stands: one notice per code per generation.
    await harness.emitAgentEnd();
    expect(harness.noticeTexts()).toHaveLength(1);
  });

  test("journal replay preserves uncertain launch", async () => {
    const fixture = await buildFixture();
    writeSettings(fixture, { enabled: true, cap: 2 });
    // The caller is inside the matching managed environment (the real gate the
    // journal checks; the CLI itself is never executed here).
    process.env.HERDR_ENV = "1";
    const jobs = new AsyncJobManager({});
    const harness = await createHarness({ sessionManager: newSession(fixture.root), jobs, cwd: fixture.root });
    expect(codeOf(await harness.runTool(bindParams(fixture)))).toBe("bound");

    const reserved = await harness.runTool({
      operation: "reserve-launch",
      planId: "plan-a",
      transport: "herdr",
      skill: { name: "herdr", source: "herdr" },
      capability: { executable: process.execPath, version: "0.9.0", target: "pane-current" },
    });
    expect(reserved.isError).toBe(false);
    expect(codeOf(reserved)).toBe("reserved");
    expect(reserved.details.mstarPhase2).toMatchObject({ applied: true });
    const intentId = String(intentOf(reserved).id);

    const evidence = (name: string): string => {
      const path = join(fixture.root, "evidence", `${name}.txt`);
      writeText(path, `${name}\n`);
      return path;
    };
    const record = (observation: string, extra: Record<string, unknown> = {}): Promise<ToolResult> =>
      harness.runTool({
        operation: "record-launch",
        intentId,
        observation,
        evidencePath: evidence(`${intentId}-${observation}`),
        ...extra,
      });

    for (const observation of ["starting", "created", "submitting"]) {
      const step = await record(observation, observation === "created" ? { target: "pane-42" } : {});
      expect(step.isError).toBe(false);
      expect(step.details.mstarPhase2).toMatchObject({ applied: true });
    }
    // A stalled prompt is uncertainty, not a retryable failure.
    const uncertain = await record("uncertain", { target: "pane-42" });
    expect(codeOf(uncertain)).toBe("recorded");
    expect(intentOf(uncertain).state).toBe("uncertain");
    expect(journalIntents(fixture)).toHaveLength(1);

    // Replaying the same observation writes nothing and authorizes nothing…
    const replay = await record("uncertain", { target: "pane-42" });
    expect(codeOf(replay)).toBe("replayed");
    expect(replay.details.mstarPhase2).toMatchObject({ applied: false });
    // …a blind resubmission is refused (uncertain is terminal)…
    const retry = await record("submitted", { target: "pane-42" });
    expect(retry.isError).toBe(true);
    expect(codeOf(retry)).toBe("launch.transition-invalid");
    // …and the plan stays occupied: a duplicate request returns the recorded
    // intent without another authorization, so no second owner can appear.
    const duplicate = await harness.runTool({
      operation: "reserve-launch",
      planId: "plan-a",
      transport: "herdr",
      skill: { name: "herdr", source: "herdr" },
      capability: { executable: process.execPath, version: "0.9.0", target: "pane-current" },
    });
    expect(duplicate.isError).toBe(false);
    expect(codeOf(duplicate)).toBe("replayed");
    expect(duplicate.details.mstarPhase2).toMatchObject({ applied: false });
    expect(intentOf(duplicate).state).toBe("uncertain");
    expect(journalIntents(fixture)).toHaveLength(1);

    // A fresh instance replays both the identity pointer and the journal from
    // disk: the uncertain intent still occupies its slot, the other plan can
    // still take the remaining one.
    const reloaded = await createHarness({ sessionManager: harness.sessionManager, jobs, cwd: fixture.root });
    const rebound = await reloaded.runTool(bindParams(fixture));
    expect(codeOf(rebound)).toBe("already-bound");
    expect(rebound.details.mstarPhase2).toMatchObject({ applied: false });
    const second = await reloaded.runTool({
      operation: "reserve-launch",
      planId: "plan-b",
      transport: "herdr",
      skill: { name: "herdr", source: "herdr" },
      capability: { executable: process.execPath, version: "0.9.0", target: "pane-current" },
    });
    expect(second.isError).toBe(false);
    expect(codeOf(second)).toBe("reserved");

    const intents = journalIntents(fixture);
    expect(intents).toHaveLength(2);
    expect(intents.map((entry) => entry.state)).toEqual(["uncertain", "reserved"]);
    // The journal records transport observations only — no completion, no lease.
    expect(Object.keys(intents[0]!).sort()).toEqual([
      "assignmentPath",
      "coordinatorSessionId",
      "evidencePaths",
      "id",
      "planId",
      "preparedHash",
      "state",
      "target",
      "transport",
      "workflowId",
      "worktreePath",
    ]);
  });
});

/* ------------------------------------------------- coordinator bar titles --- */

/** SGR styling, stripped so a rendered row can be asserted as plain text. */
const SGR = /\u001b\[[0-9;]*m/g;
/** Box outline glyphs, removed so a wrapped body can be read as one string. */
const BOX_GLYPHS = /[│╭╮╰╯─]/g;

/**
 * Render this session's captured `custom_message` entries through the host's own
 * `CustomMessageComponent` — the component the transcript dispatcher mounts for
 * an extension message — so the bar header and the body are observed on the real
 * renderer instead of on our own string maths. No host process is started.
 */
function renderCustomMessages(entries: readonly SessionEntry[]): readonly (readonly string[])[] {
  ensureThemeSync();
  return entries
    .filter((entry): entry is Extract<SessionEntry, { type: "custom_message" }> => entry.type === "custom_message")
    .map((entry) => {
      const message: ConstructorParameters<typeof CustomMessageComponent>[0] = {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: true,
        timestamp: 0,
      };
      return new CustomMessageComponent(message, undefined).render(78).map((row) => row.replace(SGR, ""));
    });
}

/** Every rendered row except the bar header, as one whitespace-normalized string. */
function bodyText(rows: readonly string[], header: string | undefined): string {
  return rows
    .filter((row) => row !== header)
    .join(" ")
    .replace(BOX_GLYPHS, "")
    .replace(/\s+/g, " ");
}

describe("coordinator notice bar titles", () => {
  test("notice-bar-title: the bar carries the shared visible types, the header states no workflow status, the body states its status sentence once, and dedup, continuation and hidden ledger identities stay unchanged", async () => {
    const fixture = await buildFixture();
    const jobs = new AsyncJobManager({});
    const harness = await createHarness({ sessionManager: newSession(fixture.root), jobs, cwd: fixture.root });
    expect(codeOf(await harness.runTool(bindParams(fixture)))).toBe("bound");

    // (a) Advisory: one real running job is a changed observation.
    startJob(jobs, "job-1", "bar-title slice");
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(1);
    expect(harness.advisories()[0]!.options).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });
    // …and the durable latch keeps the continuation bounded.
    await harness.emitAgentEnd();
    expect(harness.advisories()).toHaveLength(1);

    // (b) Refusal diagnostic: the bound workflow goes terminal on disk, so the
    // probe read its snapshot and the notice is status-bearing.
    writeJson(fixture.snapshotPath, {
      ...readJson(fixture.snapshotPath),
      status: "completed",
      ended_at: new Date().toISOString(),
    });
    await harness.emitAgentEnd();
    expect(harness.noticeTexts()).toHaveLength(1);

    // Only the two shared visible types are emitted, and nothing else is.
    expect(harness.ledger().filter((entry) => entry.type === "custom_message").map((entry) => entry.customType)).toEqual([
      "mstar:advisory",
      "mstar:notice",
    ]);

    // Per-code dedup is unchanged: a repeated identical refusal stays silent.
    await harness.emitAgentEnd();
    expect(harness.noticeTexts()).toHaveLength(1);
    expect(harness.advisories()).toHaveLength(1);

    // The hidden durable identity is untouched, and the ledger still replays.
    const durableTypes = harness
      .ledger()
      .filter((entry) => entry.type === "custom")
      .map((entry) => entry.customType);
    expect(durableTypes.length).toBeGreaterThan(0);
    expect(durableTypes.every((type) => type === "mstar:phase2")).toBe(true);
    expect(derivePhase2State(harness.ledger(), harness.sessionManager.getSessionId()).binding).toMatchObject({
      workflowId: WORKFLOW_ID,
    });

    // (c) The real component: the visible type is the bar header and asserts no
    // workflow status; the observed id/status/code stay in the body.
    const [advisoryRows, noticeRows] = renderCustomMessages(harness.ledger());
    const advisoryHeader = advisoryRows!.filter((row) => row.includes("mstar:advisory"));
    const noticeHeader = noticeRows!.filter((row) => row.includes("mstar:notice"));
    expect(advisoryHeader).toHaveLength(1);
    expect(noticeHeader).toHaveLength(1);
    expect(noticeHeader[0]).not.toContain(WORKFLOW_ID);
    expect(noticeHeader[0]).not.toContain("Workflow");
    expect(noticeHeader[0]).not.toContain("completed");
    expect(noticeHeader[0]).not.toContain("phase2.workflow-terminal");

    const noticeBody = bodyText(noticeRows!, noticeHeader[0]);
    expect(noticeBody).toContain(WORKFLOW_ID);
    expect(noticeBody).toContain("completed");
    expect(noticeBody).toContain("phase2.workflow-terminal");
    // Title and detail never state the same status sentence twice.
    expect(noticeBody.match(/is completed/g) ?? []).toHaveLength(1);

    const advisoryBody = bodyText(advisoryRows!, advisoryHeader[0]);
    expect(advisoryBody).toContain("phase-2-worktree-lease.md");
    expect(advisoryBody).toContain("observation, not a dispatch");
  });
});
