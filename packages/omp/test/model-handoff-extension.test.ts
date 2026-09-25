/**
 * Coordinator session adapter tests — `packages/omp/src/extensions/model-handoff.ts`.
 *
 * ## What is real here, and what the test supplies
 *
 * The extension is loaded and driven by the **host's own machinery**, not by a
 * hand-written stand-in API:
 *
 * - `loadExtensionFromFactory` binds the module's real factory through the
 *   host's `ConcreteExtensionAPI` (real injected `pi.zod`, real `on` /
 *   `registerTool`, real registration registry on the returned `Extension`).
 * - `ExtensionRunner` is the host's runner: it builds every `ExtensionContext`,
 *   dispatches the events (`emit`, `emitInput`, `emitBeforeAgentStart`,
 *   `emitToolResult`) to the registered handlers, honors cancellation results
 *   and enforces the host's handler timeouts. `initialize(actions, …)` is the
 *   host's own wiring entry point, and `mode` is its parameter.
 * - `RegisteredToolAdapter` is the host's tool adapter, so tool invocation,
 *   parameter order and result shape are the host's.
 * - `SessionManager` writes the real session file and ledger: ids,
 *   `model_change` entries, `custom` records and `custom_message` notices
 *   (`appendModelChange`, `appendCustomEntry`, `appendCustomMessageEntry` —
 *   the same calls `pi.appendEntry` / `AgentSession.sendCustomMessage` make).
 * - `ModelControls` is the host's picker/role-cycle implementation; the
 *   `setModel` action is wired exactly as `extension-ui-controller.ts` wires it
 *   (auth lookup, then the session model switch).
 * - `Settings.isolated` role mappings plus the real `ctx.models` facade, the real
 *   `getPluginSettings` reader (project override layer), the real E1/E2 modules,
 *   and real Git facts in disposable repositories.
 *
 * Supplied by the test: the `ModelRegistry` double (no credentials may be used),
 * the **controlled auth/metadata barrier** inside it, the action implementations
 * for the three effects this extension uses (the rest throw, proving non-use),
 * and the fact that no live agent loop drives the events. **No TUI/print/JSON/RPC
 * process was started** — process-level loading evidence is handed to T4/QA.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionActions, ExtensionContext, ExtensionContextActions, ExtensionMode, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
  ExtensionRunner,
  RegisteredToolAdapter,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/model-api";
import type { ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { ModelControls } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import modelHandoffFactory, {
  HANDOFF_CUSTOM_TYPE,
  HANDOFF_NOTICE_CUSTOM_TYPE,
  decideSessionState,
  handoffSeams,
  readSessionRecords,
} from "../src/extensions/model-handoff";
import type { HandoffRecord } from "../src/extensions/model-handoff";
import { COORDINATOR_TOOL_NAME } from "../src/coordinator-identity";
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
} from "@mstar-harness/engine";
import type { ExecutionCaller, ExecutionContext, ExecutionSessionRef } from "@mstar-harness/engine";

/* --------------------------------------------------------------- scratch --- */

const SCRATCH: string[] = [];
/** The module resolves the harness through the engine's documented precedence. */
const HARNESS_ENV = process.env.MSTAR_HARNESS_DIR;
/** The readiness step is only ever held open; the real checkpoint still runs. */
const REAL_INSPECT_READINESS = handoffSeams.inspectReadiness;

beforeAll(() => {
  delete process.env.MSTAR_HARNESS_DIR;
});
afterAll(() => {
  handoffSeams.inspectReadiness = REAL_INSPECT_READINESS;
  setArtifactStore(undefined);
  if (HARNESS_ENV !== undefined) process.env.MSTAR_HARNESS_DIR = HARNESS_ENV;
  for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(dir);
  return dir;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRegister(harness: string, ids: readonly string[]): void {
  writeJson(join(harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-16",
    workflows: ids.map((id) => ({ id, type: "iteration", started_at: "2026-09-16", dir: `workflows/${id}` })),
  });
}

/** Native reader path used by the fixtures: the project override layer of `getPluginSettings`. */
function writePluginOverrides(cwd: string, settings: Record<string, unknown>): void {
  const path = join(cwd, ".omp", "plugin-overrides.json");
  mkdirSync(dirname(path), { recursive: true });
  writeJson(path, { settings: { "@mstar-harness/omp": settings } });
}

/* ----------------------------------------------------------------- models --- */

/** Minimal catalog-shaped model: only the fields the host's selection code reads. */
type TestModel = Readonly<{
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: readonly string[];
  cost: Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
  contextWindow: number;
  maxTokens: number;
  compat: Record<string, never>;
}>;

function testModel(id: string): TestModel {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "probe",
    baseUrl: "http://127.0.0.1:9",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    compat: {},
  };
}

/** The host's own `Model` type, taken from the action signature it appears in. */
type HostModel = Parameters<ExtensionActions["setModel"]>[0];
/** The fixture builds exactly the fields the host selection code reads. */
const asHostModel = (model: TestModel): HostModel => model as unknown as HostModel;

const PICKER_MODEL = testModel("picker-model");

/* -------------------------------------------------------------- fixtures ---- */

type ControlRepo = Readonly<{
  root: string;
  main: string;
  harness: string;
  integration: string;
  integrationBranch: string;
  siblingId: string;
}>;

/**
 * Disposable control repository: a main checkout (branch `main`, pushed to a
 * local bare remote), a linked integration worktree on its own pushed branch,
 * and a harness root. `legacySources` (default `true`) also plants the
 * pre-activation file state — one registered sibling active iteration with its
 * own snapshot — which the FILE route derives from; the ACTIVE-route fixtures
 * pass `false`, because an execution authority is initialized only over an
 * empty execution workspace.
 */
function buildControlRepo(
  siblingId = "fixture-sibling-iteration",
  options: { legacySources?: boolean } = {},
): ControlRepo {
  const root = scratchDir("omp-handoff-ext-");
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

  const integrationBranch = "iteration/fixture";
  const integration = join(root, "integration");
  git(["worktree", "add", "-q", "-b", integrationBranch, integration], main);
  git(["push", "-q", "-u", "origin", integrationBranch], integration);

  const harness = join(main, ".mstar");
  mkdirSync(join(harness, "plans"), { recursive: true });
  if (options.legacySources === false) return { root, main, harness, integration, integrationBranch, siblingId };
  for (const dir of ["workflows", "iterations"]) mkdirSync(join(harness, dir), { recursive: true });
  mkdirSync(join(harness, "workflows", siblingId), { recursive: true });
  writeJson(join(harness, "workflows", siblingId, "snapshot.json"), {
    schema_version: 1,
    id: siblingId,
    type: "iteration",
    status: "running",
    started_at: "2026-09-16",
    updated_at: "2026-09-16T00:00:00.000Z",
    plans: [],
  });
  writeRegister(harness, [siblingId]);

  return { root, main, harness, integration, integrationBranch, siblingId };
}

type Artifacts = Readonly<{
  workflowId: string;
  coordinatorSessionPath: string;
  mainWorktreeBranch: string;
  reviews: readonly Readonly<{ role: string; agentId: string; resultRef: string; reportPath: string }>[];
  plans: readonly Readonly<{ planId: string; planPath: string; prepareEvidencePath: string }>[];
}>;

const SPECIALISTS = ["product-manager", "architect", "writing-specialist"] as const;

/** The workflow's session envelope directory (the coordinator-authority evidence). */
function sessionsDirOf(repo: ControlRepo, workflowId: string): string {
  return join(repo.harness, "workflows", workflowId, "sessions");
}

/** The lawful workflow creation the coordinator performs after a reservation. */
function createWorkflowArtifacts(repo: ControlRepo, sessionId: string, workflowId: string): Artifacts {
  const planIds = [`${workflowId}-plan`];
  const workflowDir = join(repo.harness, "workflows", workflowId);
  const guidesDir = join(repo.harness, "iterations", workflowId, "guides");
  const sessionsDir = join(workflowDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(guidesDir, { recursive: true });

  const envelopePath = join(sessionsDir, `${sessionId}.json`);
  writeJson(envelopePath, {
    schema_version: 1,
    role: "coordinator",
    session_id: sessionId,
    workflow_id: workflowId,
    harness_root: repo.harness,
  });
  const planPaths = planIds.map((id) => join(repo.harness, "plans", `${id}.md`));
  const evidencePaths = planIds.map((id) => join(guidesDir, `${id}-prepare.md`));
  // The registered-plan path contract (§4): a registered plan markdown declares
  // its own `plan_id`, and readiness resolves every row pointer through the
  // shared resolver — so the fixture declares it like the real producer does.
  planPaths.forEach((path, index) =>
    writeFileSync(path, `# ${planIds[index]}\n\n**plan_id:** ${planIds[index]}\n\nPlan body.\n`),
  );
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
    branch: { base: "main", integration: repo.integrationBranch, target: "main" },
    execution_policy: { plan_parallelism: "parallel", worktree_mode: "required", push_policy: "after-review-wave" },
    integration_worktree_path: repo.integration,
    plans: planIds.map((id, index) => ({ id, title: id, file: planPaths[index]!, status: "InProgress" })),
    coordination: {
      coordinator: { session_id: sessionId, session_file: envelopePath, bound_at: "2026-09-16T00:00:00.000Z" },
    },
  });
  writeFileSync(
    join(repo.harness, "iterations", workflowId, "delivery-compass.md"),
    [
      "---",
      `iteration_id: ${workflowId}`,
      "start_date: 2026-09-16",
      "status: locked",
      "iteration_base_branch: main",
      `spec_integration_branch: ${repo.integrationBranch}`,
      "target_branch: main",
      `integration_worktree_path: ${repo.integration}`,
      "plans:",
      ...planIds.map((id) => `  - ${id}`),
      "---",
      "",
      "# Fixture compass",
      "",
    ].join("\n"),
  );
  writeRegister(repo.harness, [repo.siblingId, workflowId]);

  return {
    workflowId,
    coordinatorSessionPath: envelopePath,
    mainWorktreeBranch: "main",
    reviews: [
      { role: "product-manager", agentId: "fixture-pm-agent", resultRef: "agent://fixture-pm-agent", reportPath: reportPaths[0]! },
      { role: "architect", agentId: "fixture-architect-agent", resultRef: "agent://fixture-architect-agent", reportPath: reportPaths[1]! },
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
}

/* --------------------------------------------------------------- harness ---- */

const TOOL_NAME = "mstar_model_handoff";

type HostMode = ExtensionMode;

type ToolResult = Readonly<{
  content: readonly Readonly<{ type: string; text: string }>[];
  details: Readonly<{ mstarModelHandoff?: Record<string, unknown>; ok?: boolean }>;
  isError?: boolean;
}>;

type ToolParams = Record<string, unknown>;

type Harness = Readonly<{
  sessionManager: SessionManager;
  controls: ModelControls;
  runner: ExtensionRunner;
  /** The host-registered extension object (handlers, tools, commands, …). */
  registeredCounts: () => Readonly<{
    handlers: readonly string[];
    tools: readonly string[];
    commands: number;
    shortcuts: number;
    flags: number;
    messageRenderers: number;
    composerShapes: number;
    fileWriteFallbacks: number;
    fileDeleteFallbacks: number;
  }>;
  cwd: string;
  mode: HostMode;
  /** Every `pi.setModel` invocation the extension made (accepted or refused). */
  attempts: readonly string[];
  /** Accepted switches whose native ledger write completed. */
  switched: readonly string[];
  /** Resolves when the next model action is invoked by the code under test. */
  nextAction: () => Promise<void>;
  liveSpec: () => string;
  /** A live-model mutation with no ledger append (host/other-extension change). */
  setLiveModel: (id: string) => void;
  auth: { allowed: boolean };
  metadata: { failNext: boolean; hold: () => () => void };
  ledger: () => readonly SessionEntry[];
  records: () => readonly HandoffRecord[];
  notices: () => readonly string[];
  /** The raw (unawaited) return value of a registered navigation handler. */
  rawHandlerResult: (event: string, payload: Record<string, unknown>) => unknown;
  emit: (event: Record<string, unknown>) => Promise<unknown>;
  /** The host's pre-tool dispatch: the returned revision is what the tool runs with. */
  emitToolCall: (event: Record<string, unknown>) => Promise<unknown>;
  emitInput: (text: string, source?: "interactive" | "rpc" | "extension") => Promise<void>;
  emitBeforeAgentStart: (prompt: string) => Promise<unknown>;
  emitToolResult: (toolCallId: string, toolName: string, isError: boolean) => Promise<unknown>;
  runTool: (params: ToolParams) => Promise<ToolResult>;
  /** The host's adapter for the `mstar_coordinator` tool (same machinery). */
  runCoordinatorTool: (params: ToolParams) => Promise<ToolResult>;
  /** The coordinator tool's own registered input schema. */
  validateCoordinator: (params: ToolParams) => { success: boolean; message?: string };
  /** The coordinator tool definition invoked directly, bypassing schema validation (forgery probe). */
  runRawCoordinatorTool: (params: ToolParams) => Promise<ToolResult>;
  /** The tool definition invoked directly, bypassing schema validation (forgery probe). */
  runRawTool: (params: ToolParams) => Promise<ToolResult>;
  /** `safeParse` through the extension's own registered parameter schema. */
  validate: (params: ToolParams) => { success: boolean; message?: string };
}>;

async function createHarness(options: {
  cwd: string;
  sessionDir: string;
  sessionManager?: SessionManager;
  modelRoles?: Record<string, string>;
  mode?: HostMode;
  initialModelId?: string;
  /** Authenticated models this session sees; defaults to the five fixture models. */
  availableIds?: readonly string[];
}): Promise<Harness> {
  const settings = Settings.isolated({
    modelRoles: options.modelRoles ?? { slow: "probe/slow-model", default: "probe/default-model", smol: "probe/smol-model" },
  });
  const catalogue = [
    testModel("slow-model"),
    testModel("default-model"),
    testModel("smol-model"),
    PICKER_MODEL,
    testModel("other-model"),
  ];
  const available =
    options.availableIds === undefined
      ? catalogue
      : options.availableIds.flatMap((id) => catalogue.filter((model) => model.id === id));
  const sessionManager = options.sessionManager ?? SessionManager.create(options.cwd, options.sessionDir);

  let liveModel = testModel(options.initialModelId ?? "default-model");
  let metadataGate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;
  const attempts: string[] = [];
  const switched: string[] = [];
  const actionWaiters: Array<() => void> = [];

  const auth = { allowed: true };
  const metadata = {
    failNext: false,
    /** Hold the real picker/cycle metadata step open; the returned call releases it. */
    hold: () => {
      metadataGate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      return () => {
        const release = openGate;
        openGate = null;
        metadataGate = null;
        release?.();
      };
    },
  };

  // The controlled host double: no credential is read or written, and the
  // metadata step is the barrier the brief allows.
  const registry = {
    getAvailable: () => available,
    hasConfiguredAuth: () => auth.allowed,
    getApiKey: async () => (auth.allowed ? "probe-key" : undefined),
    getApiKeyForProvider: async () => (auth.allowed ? "probe-key" : undefined),
    clearSuppressedSelector: () => {},
    refreshSelectedModelMetadata: async (model: unknown) => {
      if (metadataGate !== null) await metadataGate;
      if (metadata.failNext) throw new Error("probe metadata refresh failed");
      return model;
    },
  };
  const controlsHost = {
    agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {}, metadataForProvider: () => undefined },
    settings,
    modelRegistry: registry,
    sessionManager,
    providerSessionState: new Map<string, unknown>(),
    model: () => asHostModel(liveModel),
    sessionId: () => sessionManager.getSessionId(),
    promptGeneration: () => 0,
    resolveActiveEditMode: () => "default",
    syncAfterModelChange: async () => {},
    setModelWithProviderSessionReset: async (model: HostModel) => {
      liveModel = testModel(model.id);
    },
    clearActiveRetryFallback: () => {},
    clearInheritedProviderPromptCacheKey: () => {},
    magicKeywordEnabled: () => false,
    emit: () => {},
    emitSessionEvent: async () => {},
    emitNotice: () => {},
  };
  const controls = new ModelControls(controlsHost as unknown as ModelControlsHost, { thinkingLevel: undefined });
  const models = createExtensionModelQuery(registry as unknown as ModelRegistry, settings, () => asHostModel(liveModel));

  // The extension is bound by the host's own loader with the host's runtime.
  const runtime = new ExtensionRuntime();
  const extension = await loadExtensionFromFactory(
    modelHandoffFactory,
    options.cwd,
    new EventBus(),
    runtime,
    "mstar-harness-model-handoff",
  );
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    options.cwd,
    sessionManager,
    registry as unknown as ModelRegistry,
    undefined,
    settings,
  );

  const session = (): SessionManager => runner.sessionManager;

  // Unsupported actions throw: an extension that touched one would fail loudly.
  const unsupported = (name: string) => () => {
    throw new Error(`${name} must not be called by the model-handoff extension`);
  };
  const actions: ExtensionActions = {
    // The durable effects the real actions perform (the host's own writers).
    sendMessage: (message) => {
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
    // Exactly the wiring `extension-ui-controller.ts` gives the public API.
    setModel: async (model) => {
      attempts.push(`${model.provider}/${model.id}`);
      for (const waiter of actionWaiters.splice(0)) waiter();
      if (!auth.allowed) return false;
      await controls.setModel(model, "default");
      switched.push(`${model.provider}/${model.id}`);
      return true;
    },
    getThinkingLevel: unsupported("getThinkingLevel"),
    setThinkingLevel: unsupported("setThinkingLevel"),
    getSessionName: unsupported("getSessionName"),
    setSessionName: unsupported("setSessionName"),
  };
  const contextActions: ExtensionContextActions = {
    getModel: () => asHostModel(liveModel),
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: async () => {},
    getSystemPrompt: () => [],
  };
  runner.initialize(actions, contextActions, undefined, undefined, options.mode ?? "tui");

  const registeredTool = extension.tools.get(TOOL_NAME);
  if (registeredTool === undefined) throw new Error("the host registered no model-handoff tool");
  const adapter = new RegisteredToolAdapter(registeredTool, runner);
  const coordinatorTool = extension.tools.get(COORDINATOR_TOOL_NAME);
  if (coordinatorTool === undefined) throw new Error("the host registered no coordinator-identity tool");
  const coordinatorAdapter = new RegisteredToolAdapter(coordinatorTool, runner);

  const runToolCall = async (params: ToolParams): Promise<ToolResult> => {
    const parsed = registeredTool.definition.parameters.parse(params);
    // `RegisteredToolAdapter` is the host's adapter: it forwards to the
    // definition with the host's own parameter order and context.
    return (await adapter.execute("fixture-tool-call", parsed, undefined, undefined)) as ToolResult;
  };

  return {
    sessionManager: runner.sessionManager,
    controls,
    runner,
    registeredCounts: () => ({
      handlers: [...extension.handlers.keys()].sort(),
      tools: [...extension.tools.keys()].sort(),
      commands: extension.commands.size,
      shortcuts: extension.shortcuts.size,
      flags: extension.flags.size,
      messageRenderers: extension.messageRenderers.size,
      composerShapes: extension.composerShapes.size,
      fileWriteFallbacks: extension.fileWriteFallbackHandlers.length,
      fileDeleteFallbacks: extension.fileDeleteFallbackHandlers.length,
    }),
    cwd: options.cwd,
    mode: options.mode ?? "tui",
    attempts,
    switched,
    nextAction: () =>
      new Promise<void>((resolve) => {
        actionWaiters.push(resolve);
      }),
    liveSpec: () => `${liveModel.provider}/${liveModel.id}`,
    setLiveModel: (id: string) => {
      liveModel = testModel(id);
    },
    auth,
    metadata,
    ledger: () => runner.sessionManager.getEntries(),
    records: () =>
      readSessionRecords(runner.sessionManager.getEntries(), runner.sessionManager.getSessionId()),
    notices: () =>
      runner.sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "custom_message" && entry.customType === HANDOFF_NOTICE_CUSTOM_TYPE
            ? [typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)]
            : [],
        ),
    rawHandlerResult: (event: string, payload: Record<string, unknown>) => {
      const handler = extension.handlers.get(event)?.[0];
      if (handler === undefined) throw new Error(`no ${event} handler was registered`);
      // Deliberately NOT awaited: this asserts the handler's own synchronicity.
      return handler({ type: event, ...payload } as never, runner.createContext());
    },
    emit: (event: Record<string, unknown>) => runner.emit(event as never),
    emitToolCall: (event: Record<string, unknown>) => runner.emitToolCall(event as never),
    emitInput: async (text: string, source: "interactive" | "rpc" | "extension" = "interactive") => {
      await runner.emitInput(text, undefined, source);
    },
    emitBeforeAgentStart: (prompt: string) => runner.emitBeforeAgentStart(prompt, undefined, []),
    emitToolResult: (toolCallId: string, toolName: string, isError: boolean) =>
      runner.emitToolResult({ type: "tool_result", toolCallId, toolName, input: {}, content: [], isError } as never),
    runTool: runToolCall,
    runCoordinatorTool: async (params: ToolParams) => {
      const parsed = coordinatorTool.definition.parameters.parse(params);
      return (await coordinatorAdapter.execute("fixture-coordinator-call", parsed, undefined, undefined)) as ToolResult;
    },
    validateCoordinator: (params: ToolParams) => {
      const parsed = coordinatorTool.definition.parameters.safeParse(params);
      return parsed.success ? { success: true } : { success: false, message: parsed.error?.message ?? "" };
    },
    runRawCoordinatorTool: async (params: ToolParams) =>
      (await coordinatorTool.definition.execute(
        "fixture-coordinator-raw-call",
        params,
        undefined,
        undefined,
        runner.createContext(),
      )) as ToolResult,
    runRawTool: async (params: ToolParams) =>
      (await registeredTool.definition.execute(
        "fixture-raw-call",
        params,
        undefined,
        undefined,
        runner.createContext(),
      )) as ToolResult,
    validate: (params: ToolParams) => {
      const parsed = registeredTool.definition.parameters.safeParse(params);
      return parsed.success ? { success: true } : { success: false, message: parsed.error?.message ?? "" };
    },
  };
}

function startParams(workflowId: string): ToolParams {
  return { operation: "start", workflowId };
}

function completionParams(artifacts: Artifacts): ToolParams {
  return {
    operation: "phase1-complete",
    workflowId: artifacts.workflowId,
    coordinatorSessionPath: artifacts.coordinatorSessionPath,
    mainWorktreeBranch: artifacts.mainWorktreeBranch,
    reviews: artifacts.reviews,
    plans: artifacts.plans,
  };
}

function codeOf(result: ToolResult): string {
  return String(result.details.mstarModelHandoff?.code ?? "");
}

function stateOf(result: ToolResult): string {
  return String(result.details.mstarModelHandoff?.state ?? "");
}

function statesOf(harness: Harness): readonly string[] {
  return harness.records().map((record) => record.state);
}

/** A fresh coordinator session for one fixture repository. */
function newSession(cwd: string): SessionManager {
  return SessionManager.create(cwd, scratchDir("omp-handoff-sessions-"));
}

/** Promise-like without inline-cast member access: `in` narrowing, then `typeof`. */
function isPromiseLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("then" in value)) return false;
  return typeof value.then === "function";
}

/* ----------------------------------------------------------------- tests ---- */

describe("new coordinator start only", () => {
  test("new coordinator start only: ordinary chat, unrelated commands, task and scoped-plan PM sessions and mid-flight enable cause no model action", async () => {
    const repo = buildControlRepo();
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });

    const before = {
      register: readFileSync(join(repo.harness, "status.json"), "utf8"),
      workflows: readdirSync(join(repo.harness, "workflows")).sort(),
      iterations: readdirSync(join(repo.harness, "iterations")).sort(),
    };

    // Ordinary chat, unrelated commands, natural-language starts and RPC input
    // arrive as the host's own input events. None of them is workflow ownership;
    // arming happens only through the explicit PM first-action call.
    const entryTraces: readonly (readonly [string, "interactive" | "rpc" | "extension"])[] = [
      ["hello, can you explain how the harness works?", "interactive"],
      ["/iteration-start ship the adapter --pause", "interactive"],
      ["/iteration-loop autonomous", "interactive"],
      ["start a new morning star iteration for the fixture", "rpc"],
      ["please load the mstar-iteration skill and begin", "extension"],
    ];
    for (const [text, source] of entryTraces) await harness.emitInput(text, source);
    await harness.emitBeforeAgentStart("do the thing");
    await harness.emitToolResult("call-1", "read", false);
    await harness.emit({ type: "agent_end", messages: [] });

    expect(harness.records()).toHaveLength(0);
    expect(harness.notices()).toHaveLength(0);
    expect(harness.attempts).toHaveLength(0);
    // `/iteration-drive` never creates a reservation, and none of these did.
    expect(readFileSync(join(repo.harness, "status.json"), "utf8")).toBe(before.register);
    expect(readdirSync(join(repo.harness, "workflows")).sort()).toEqual(before.workflows);
    expect(readdirSync(join(repo.harness, "iterations")).sort()).toEqual(before.iterations);

    // Mid-flight enable: turning the native preference on does not retro-arm and
    // does not start observing anything.
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    await harness.emitInput("continue", "interactive");
    expect(harness.records()).toHaveLength(0);
    expect(harness.attempts).toHaveLength(0);

    // An *explicitly* scoped-plan PM session: the host observed that route, and
    // the start is refused from host facts alone — the caller supplies no
    // authority field it could have lied in.
    const scoped = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    await scoped.emitInput("/iteration-drive --assignment .mstar/assignments/a.md", "interactive");
    const scopedRefusal = await scoped.runTool(startParams("scoped-iteration"));
    expect(codeOf(scopedRefusal)).toBe("scoped-plan-route");
    expect(scopedRefusal.isError).toBe(true);
    expect(scoped.records()).toHaveLength(0);
    expect(scoped.attempts).toHaveLength(0);
    expect(scoped.notices().some((line) => line.includes("start refused"))).toBe(true);

    // `/iteration-drive` with no arguments is the restore-only form: it must
    // never retro-arm either.
    const restore = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    await restore.emitInput("/iteration-drive", "interactive");
    expect(codeOf(await restore.runTool(startParams("restore-iteration")))).toBe("scoped-plan-route");
    expect(restore.attempts).toHaveLength(0);

    // A native task/focused-agent session (`session_init` in its own ledger).
    const taskSession = newSession(repo.main);
    taskSession.appendSessionInit({ systemPrompt: "task", task: "scout the repo", tools: ["read"], agent: "scout" });
    const taskHarness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: taskSession,
      mode: "json",
    });
    const refused = await taskHarness.runTool(startParams("task-session-iteration"));
    expect(codeOf(refused)).toBe("not-coordinator");
    expect(refused.isError).toBe(true);
    expect(taskHarness.records()).toHaveLength(0);
    expect(taskHarness.attempts).toHaveLength(0);
    expect(taskHarness.notices()).toHaveLength(0);

    // What the extension registers: exactly the frozen events and one tool, and
    // no command, shortcut, flag, renderer or file-write seam at all.
    expect(harness.registeredCounts()).toEqual({
      handlers: [
        "agent_end",
        "before_agent_start",
        "input",
        "session_before_branch",
        "session_before_switch",
        "session_before_tree",
        "session_branch",
        "session_shutdown",
        "session_start",
        "session_switch",
        "session_tree",
        "tool_call",
        "tool_result",
      ],
      tools: [COORDINATOR_TOOL_NAME, TOOL_NAME],
      commands: 0,
      shortcuts: 0,
      flags: 0,
      messageRenderers: 0,
      composerShapes: 0,
      fileWriteFallbacks: 0,
      fileDeleteFallbacks: 0,
    });
  }, 60_000);

  test("new coordinator start only: one arm per entry trace across TUI, print, JSON and RPC modes, and two concurrent starts arm once", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const modes: readonly HostMode[] = ["tui", "print", "json", "rpc"];
    const traces = [
      { workflowId: "trace-slash-start", input: "/iteration-start ship it", entry: "iteration-start" as const },
      { workflowId: "trace-loop-start", input: "/iteration-loop autonomous", entry: "iteration-loop" as const },
      { workflowId: "trace-skill-start", input: "please start a new morning star iteration", entry: "skill-start" as const },
      { workflowId: "trace-print-start", input: "/iteration-start print mode", entry: "iteration-start" as const },
      { workflowId: "trace-json-start", input: "/iteration-loop json mode", entry: "iteration-loop" as const },
      { workflowId: "trace-rpc-start", input: "begin the iteration via rpc", entry: "skill-start" as const },
      { workflowId: "trace-skill-second", input: "load the mstar-iteration skill and begin", entry: "skill-start" as const },
    ];

    // The caller cannot declare authority, intent or the entry route: those keys
    // are not in the tool's schema at all.
    const armed: Array<{ harness: Harness; workflowId: string }> = [];
    for (const [index, trace] of traces.entries()) {
      const harness = await createHarness({
        cwd: repo.main,
        sessionDir: scratchDir("unused-"),
        sessionManager: newSession(repo.main),
        mode: modes[index % modes.length]!,
      });
      expect(harness.validate({ ...startParams(trace.workflowId), authority: "coordinator" }).success).toBe(false);
      expect(harness.validate({ ...startParams(trace.workflowId), intent: "new-iteration" }).success).toBe(false);
      expect(harness.validate({ ...startParams(trace.workflowId), entry: "iteration-loop" }).success).toBe(false);
      expect(harness.validate(startParams(trace.workflowId)).success).toBe(true);

      // The entry route comes from the host's own input event for this session.
      await harness.emitInput(trace.input, "interactive");
      const result = await harness.runTool(startParams(trace.workflowId));
      expect(codeOf(result)).toBe("armed");
      expect(stateOf(result)).toBe("pending");
      expect(result.details.mstarModelHandoff?.entry).toBe(trace.entry);
      expect(harness.mode).toBe(modes[index % modes.length]!);
      expect(harness.attempts).toEqual(["probe/slow-model"]);
      expect(harness.liveSpec()).toBe("probe/slow-model");
      expect(statesOf(harness)).toEqual(["attempting", "pending"]);
      const [attempt, pending] = harness.records();
      expect(attempt).toMatchObject({ action: "arm", baselineModelChangeId: null, observedModel: null });
      expect(pending).toMatchObject({ action: "arm", observedModel: "probe/slow-model" });
      expect(attempt!.receipt).toBeUndefined();
      expect(pending!.receipt).toBeUndefined();
      expect(pending!.binding.workflowId).toBe(trace.workflowId);
      expect(harness.ledger().some((entry) => entry.id === pending!.baselineModelChangeId)).toBe(true);
      expect(harness.ledger().some((entry) => entry.type === "model_change" && entry.model === "probe/slow-model")).toBe(true);
      armed.push({ harness, workflowId: trace.workflowId });
    }

    // The completion checkpoint runs through the same four adapter modes; each
    // session switches only itself.
    for (const [index, mode] of modes.entries()) {
      const entry = armed[index]!;
      const artifacts = createWorkflowArtifacts(repo, entry.harness.sessionManager.getSessionId(), entry.workflowId);
      const before = armed.map((other) => other.harness.attempts.length);
      const fired = await entry.harness.runTool(completionParams(artifacts));
      expect(codeOf(fired)).toBe("handed_off");
      expect(entry.harness.mode).toBe(mode);
      expect(entry.harness.switched).toEqual(["probe/slow-model", "probe/default-model"]);
      expect(entry.harness.liveSpec()).toBe("probe/default-model");
      expect(statesOf(entry.harness)).toEqual(["attempting", "pending", "attempting", "handed_off"]);
      expect(entry.harness.records().at(-1)!.receipt).toBeDefined();
      // Exactly one model action was invoked, and only in this session.
      expect(armed.map((other) => other.harness.attempts.length)).toEqual(
        before.map((count, position) => (position === index ? count + 1 : count)),
      );
    }
    const sessionIds = new Set(armed.map((entry) => entry.harness.sessionManager.getSessionId()));
    expect(sessionIds.size).toBe(armed.length);

    // Two concurrent starts in one session: the in-memory arm guard refuses the
    // second entry before it can reserve anything, and exactly one arm happens.
    const raceRepo = buildControlRepo();
    writePluginOverrides(raceRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const race = await createHarness({
      cwd: raceRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(raceRepo.main),
    });
    await race.emitInput("/iteration-start concurrent", "interactive");
    const [first, second] = await Promise.all([
      race.runTool(startParams("concurrent-iteration")),
      race.runTool(startParams("concurrent-iteration")),
    ]);
    expect([codeOf(first), codeOf(second)].sort()).toEqual(["arm-in-flight", "armed"]);
    expect(race.attempts).toEqual(["probe/slow-model"]);
    expect(race.ledger().filter((entry) => entry.type === "model_change" && entry.model === "probe/slow-model")).toHaveLength(1);
    expect(statesOf(race)).toEqual(["attempting", "pending"]);

    // Two *instances* over the same durable session share no memory, so the
    // durable re-check is what has to refuse the loser.
    const crossRepo = buildControlRepo();
    writePluginOverrides(crossRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const crossSession = newSession(crossRepo.main);
    const crossA = await createHarness({ cwd: crossRepo.main, sessionDir: scratchDir("unused-"), sessionManager: crossSession });
    const crossB = await createHarness({ cwd: crossRepo.main, sessionDir: scratchDir("unused-"), sessionManager: crossSession });
    const [crossFirst, crossSecond] = await Promise.all([
      crossA.runTool(startParams("cross-iteration")),
      crossB.runTool(startParams("cross-iteration")),
    ]);
    expect([codeOf(crossFirst), codeOf(crossSecond)].sort()).toEqual(["already-bound", "armed"]);
    const crossActions = [...crossA.attempts, ...crossB.attempts];
    expect(crossActions).toEqual(["probe/slow-model"]);
    expect(crossSession.getEntries().filter((entry) => entry.type === "model_change" && entry.model === "probe/slow-model")).toHaveLength(1);
    expect(readSessionRecords(crossSession.getEntries(), crossSession.getSessionId()).map((record) => record.state)).toEqual([
      "attempting",
      "pending",
    ]);
  }, 60_000);

  test("new coordinator start only: the arm is once per binding, a failed arm never becomes pending, and authority is derived from host facts", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });

    await harness.emitInput("/iteration-start once", "interactive");
    const first = await harness.runTool(startParams("once-iteration"));
    expect(codeOf(first)).toBe("armed");
    expect(harness.attempts).toEqual(["probe/slow-model"]);
    const second = await harness.runTool(startParams("once-iteration"));
    expect(codeOf(second)).toBe("already-bound");
    expect(harness.attempts).toEqual(["probe/slow-model"]);
    expect(statesOf(harness)).toEqual(["attempting", "pending"]);

    // Arm failure: no role mapping exists in this session, so `@slow` cannot be
    // resolved (a role mapped to an unavailable model refuses the same way).
    const brokenRepo = buildControlRepo();
    writePluginOverrides(brokenRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const broken = await createHarness({
      cwd: brokenRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(brokenRepo.main),
      modelRoles: {},
    });
    const unresolved = await broken.runTool(startParams("broken-iteration"));
    expect(codeOf(unresolved)).toBe("slow-unresolved");
    expect(broken.attempts).toHaveLength(0);
    expect(statesOf(broken)).toEqual(["attempting", "failed"]);
    expect(broken.records().at(-1)!.reason).toContain("cannot resolve @slow");
    // This terminalize site has no readable workflow snapshot (no artifacts
    // exist yet), so its title is the fallback shape: it names the observed
    // condition and asserts no workflow status.
    expect(broken.notices().some((line) => line.startsWith("Model handoff failed needs attention: "))).toBe(true);
    expect(broken.notices().some((line) => line.startsWith("Workflow "))).toBe(false);

    // Missing auth at arm time: the public host action reports `false`.
    const noAuthRepo = buildControlRepo();
    writePluginOverrides(noAuthRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const noAuth = await createHarness({
      cwd: noAuthRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(noAuthRepo.main),
    });
    noAuth.auth.allowed = false;
    const refusedArm = await noAuth.runTool(startParams("no-auth-iteration"));
    expect(codeOf(refusedArm)).toBe("slow-selection-refused");
    expect(noAuth.liveSpec()).toBe("probe/default-model");
    expect(statesOf(noAuth)).toEqual(["attempting", "failed"]);

    // A failed binding cannot fire later (it would overwrite the actual model).
    const artifacts = createWorkflowArtifacts(brokenRepo, broken.sessionManager.getSessionId(), "broken-iteration");
    const fireAfterFailure = await broken.runTool(completionParams(artifacts));
    expect(codeOf(fireAfterFailure)).toBe("not-pending");
    expect(broken.attempts).toHaveLength(0);
    expect(broken.liveSpec()).toBe("probe/default-model");

    // --- Host-derived authority ---
    // A control: without any envelope this session arms (the fixture is lawful).
    const controlRepo = buildControlRepo();
    writePluginOverrides(controlRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const control = await createHarness({
      cwd: controlRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(controlRepo.main),
    });
    expect(codeOf(await control.runTool(startParams("authority-control")))).toBe("armed");

    // A plan-pm envelope for this session refuses the start.
    const planPmRepo = buildControlRepo();
    writePluginOverrides(planPmRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const planPmSession = newSession(planPmRepo.main);
    const planPm = await createHarness({
      cwd: planPmRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: planPmSession,
    });
    const planPmDir = sessionsDirOf(planPmRepo, "plan-pm-iteration");
    mkdirSync(planPmDir, { recursive: true });
    writeJson(join(planPmDir, `${planPmSession.getSessionId()}.json`), {
      schema_version: 1,
      role: "plan-pm",
      session_id: planPmSession.getSessionId(),
      workflow_id: "plan-pm-iteration",
      plan_id: "some-plan",
      harness_root: planPmRepo.harness,
    });
    const planPmRefusal = await planPm.runTool(startParams("plan-pm-iteration"));
    expect(codeOf(planPmRefusal)).toBe("plan-pm-session");
    expect(planPm.attempts).toHaveLength(0);
    expect(statesOf(planPm)).toHaveLength(0);
    expect(planPm.notices().some((line) => line.includes("plan-pm-session"))).toBe(true);

    // Forgery probe: even a *raw* call that bypasses schema validation and
    // carries every former authority claim cannot arm — the adapter never reads
    // those fields, so the host derivation still decides.
    const forged = await planPm.runRawTool({
      operation: "start",
      workflowId: "plan-pm-iteration",
      authority: "coordinator",
      intent: "new-iteration",
      entry: "iteration-start",
    });
    expect(codeOf(forged)).toBe("plan-pm-session");
    expect(planPm.attempts).toHaveLength(0);
    expect(statesOf(planPm)).toHaveLength(0);

    // The same forged call in a session with no disqualifying host fact still
    // arms, so the refusal above is caused by the derivation and not by the
    // extra keys.
    const forgeControl = await createHarness({
      cwd: controlRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(controlRepo.main),
    });
    const forgedControl = await forgeControl.runRawTool({
      operation: "start",
      workflowId: "forge-control-iteration",
      authority: "coordinator",
      intent: "new-iteration",
      entry: "iteration-start",
    });
    expect(codeOf(forgedControl)).toBe("armed");
    expect(forgedControl.details.mstarModelHandoff?.entry).toBe("skill-start");

    // The named workflow is bound to a *different* coordinator session.
    const otherCoordinatorRepo = buildControlRepo();
    writePluginOverrides(otherCoordinatorRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const otherCoordinator = await createHarness({
      cwd: otherCoordinatorRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(otherCoordinatorRepo.main),
    });
    const boundDir = sessionsDirOf(otherCoordinatorRepo, "bound-elsewhere");
    mkdirSync(boundDir, { recursive: true });
    writeJson(join(boundDir, "someone-else.json"), {
      schema_version: 1,
      role: "coordinator",
      session_id: "someone-else-session",
      workflow_id: "bound-elsewhere",
      harness_root: otherCoordinatorRepo.harness,
    });
    const elsewhere = await otherCoordinator.runTool(startParams("bound-elsewhere"));
    expect(codeOf(elsewhere)).toBe("coordinator-elsewhere");
    expect(otherCoordinator.attempts).toHaveLength(0);

    // The register names this session as the coordinator of another *running*
    // workflow: one session coordinates one iteration.
    const busyRepo = buildControlRepo();
    writePluginOverrides(busyRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const busySession = newSession(busyRepo.main);
    const busy = await createHarness({
      cwd: busyRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: busySession,
    });
    const otherWorkflowDir = join(busyRepo.harness, "workflows", "other-running-iteration");
    mkdirSync(otherWorkflowDir, { recursive: true });
    writeJson(join(otherWorkflowDir, "snapshot.json"), {
      schema_version: 1,
      id: "other-running-iteration",
      type: "iteration",
      status: "running",
      started_at: "2026-09-16",
      updated_at: "2026-09-16T00:00:00.000Z",
      plans: [],
      coordination: {
        coordinator: {
          session_id: busySession.getSessionId(),
          session_file: join(otherWorkflowDir, "sessions", `${busySession.getSessionId()}.json`),
          bound_at: "2026-09-16T00:00:00.000Z",
        },
      },
    });
    writeRegister(busyRepo.harness, [busyRepo.siblingId, "other-running-iteration"]);
    const busyRefusal = await busy.runTool(startParams("busy-iteration"));
    expect(codeOf(busyRefusal)).toBe("coordinator-elsewhere");
    expect(busy.attempts).toHaveLength(0);
    expect(busy.notices().some((line) => line.includes("coordinator-elsewhere"))).toBe(true);

    // --- Arm-window history ---
    // A model change away and back *inside* the arm window is a conflict even
    // though the live model looks right at the end.
    const windowRepo = buildControlRepo();
    writePluginOverrides(windowRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const windowSession = newSession(windowRepo.main);
    const windowed = await createHarness({
      cwd: windowRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: windowSession,
    });
    const held = windowed.metadata.hold();
    const invoked = windowed.nextAction();
    const arming = windowed.runTool(startParams("window-iteration"));
    await invoked;
    // The arm's own transition is still parked at the metadata gate: a foreign
    // away-and-back lands in the same window.
    windowSession.appendModelChange("probe/other-model", "default");
    windowSession.appendModelChange("probe/slow-model", "default");
    windowed.setLiveModel("slow-model");
    held();
    const windowedResult = await arming;
    expect(codeOf(windowedResult)).toBe("arm-evidence-conflict");
    expect(statesOf(windowed)).toEqual(["attempting", "failed"]);
    expect(windowed.records().at(-1)!.reason).toContain("probe/other-model, probe/slow-model");
    expect(windowed.liveSpec()).toBe("probe/slow-model");
  }, 60_000);
});

describe("fire reads current preference", () => {
  test("fire reads current preference: destination, enablement, readiness and a settings edit during the readiness checkpoint are honored", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });

    await harness.emitInput("/iteration-start pref", "interactive");
    const armed = await harness.runTool(startParams("pref-iteration"));
    expect(codeOf(armed)).toBe("armed");
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "pref-iteration");

    // Saved destination changed after the arm: fire re-reads it.
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const fired = await harness.runTool(completionParams(artifacts));
    expect(codeOf(fired)).toBe("handed_off");
    expect(harness.switched).toEqual(["probe/slow-model", "probe/smol-model"]);
    expect(harness.liveSpec()).toBe("probe/smol-model");
    expect(statesOf(harness)).toEqual(["attempting", "pending", "attempting", "handed_off"]);
    expect(harness.records().at(-1)!.receipt).toBeDefined();

    // A one-shot binding never fires twice.
    expect(codeOf(await harness.runTool(completionParams(artifacts)))).toBe("not-pending");
    expect(harness.switched).toHaveLength(2);

    // Disabled before fire: skipped, still pending; re-enabled: the same binding
    // fires.
    const secondRepo = buildControlRepo();
    writePluginOverrides(secondRepo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const second = await createHarness({
      cwd: secondRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(secondRepo.main),
    });
    await second.runTool(startParams("pref-off-iteration"));
    const secondArtifacts = createWorkflowArtifacts(secondRepo, second.sessionManager.getSessionId(), "pref-off-iteration");
    writePluginOverrides(secondRepo.main, { modelHandoff: false, handoffTarget: "@smol" });
    const suppressed = await second.runTool(completionParams(secondArtifacts));
    expect(codeOf(suppressed)).toBe("preference-off");
    expect(stateOf(suppressed)).toBe("pending");
    expect(second.switched).toEqual(["probe/slow-model"]);
    expect(second.notices().some((line) => line.includes("modelHandoff is off"))).toBe(true);
    // A bound site: the skipped fire's title carries the observed workflow id
    // and status, with the skipped condition in the detail.
    expect(second.notices().some((line) => line.startsWith("Workflow pref-off-iteration is running: "))).toBe(true);
    writePluginOverrides(secondRepo.main, { modelHandoff: true, handoffTarget: "@smol" });
    expect(codeOf(await second.runTool(completionParams(secondArtifacts)))).toBe("handed_off");
    expect(second.switched).toEqual(["probe/slow-model", "probe/smol-model"]);

    // Readiness is re-derived, never remembered.
    const thirdRepo = buildControlRepo();
    writePluginOverrides(thirdRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const third = await createHarness({
      cwd: thirdRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(thirdRepo.main),
    });
    await third.runTool(startParams("pref-ready-iteration"));
    const thirdArtifacts = createWorkflowArtifacts(thirdRepo, third.sessionManager.getSessionId(), "pref-ready-iteration");
    const reportPath = thirdArtifacts.reviews[1]!.reportPath;
    rmSync(reportPath);
    const notReady = await third.runTool(completionParams(thirdArtifacts));
    expect(codeOf(notReady)).toBe("not-ready");
    expect(stateOf(notReady)).toBe("pending");
    expect((notReady.details.mstarModelHandoff?.codes as readonly string[]).includes("review-evidence-missing")).toBe(true);
    expect(third.switched).toEqual(["probe/slow-model"]);
    writeFileSync(reportPath, "returned payload — architect\n");
    expect(codeOf(await third.runTool(completionParams(thirdArtifacts)))).toBe("handed_off");
    expect(third.switched).toEqual(["probe/slow-model", "probe/default-model"]);

    // --- A settings edit that lands while the readiness checkpoint is running ---
    // The awaited checkpoint is held open (the module's documented test seam), so
    // the edit provably happens after the first read and before the second.
    const duringRepo = buildControlRepo();
    writePluginOverrides(duringRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const during = await createHarness({
      cwd: duringRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(duringRepo.main),
    });
    await during.runTool(startParams("during-readiness-iteration"));
    const duringArtifacts = createWorkflowArtifacts(duringRepo, during.sessionManager.getSessionId(), "during-readiness-iteration");

    let releaseCheckpoint: (() => void) | undefined;
    let enterCheckpoint: (() => void) | undefined;
    const checkpointOpen = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const checkpointEntered = new Promise<void>((resolve) => {
      enterCheckpoint = resolve;
    });
    handoffSeams.inspectReadiness = async (binding, input) => {
      enterCheckpoint?.();
      await checkpointOpen;
      return REAL_INSPECT_READINESS(binding, input);
    };
    const duringFire = during.runTool(completionParams(duringArtifacts));
    // The checkpoint is only entered after the *first* preference read resolved,
    // so this edit provably lands inside the awaited window.
    await checkpointEntered;
    writePluginOverrides(duringRepo.main, { modelHandoff: true, handoffTarget: "@smol" });
    releaseCheckpoint?.();
    const duringResult = await duringFire;
    handoffSeams.inspectReadiness = REAL_INSPECT_READINESS;
    expect(codeOf(duringResult)).toBe("handed_off");
    expect(during.switched).toEqual(["probe/slow-model", "probe/smol-model"]);

    // The same window with the preference turned off: the destination switch is
    // suppressed from the re-read, not from a cached value.
    const offRepo = buildControlRepo();
    writePluginOverrides(offRepo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const offDuring = await createHarness({
      cwd: offRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(offRepo.main),
    });
    await offDuring.runTool(startParams("off-during-iteration"));
    const offArtifacts = createWorkflowArtifacts(offRepo, offDuring.sessionManager.getSessionId(), "off-during-iteration");
    let releaseSecond: (() => void) | undefined;
    let enterSecond: (() => void) | undefined;
    const secondOpen = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const secondEntered = new Promise<void>((resolve) => {
      enterSecond = resolve;
    });
    handoffSeams.inspectReadiness = async (binding, input) => {
      enterSecond?.();
      await secondOpen;
      return REAL_INSPECT_READINESS(binding, input);
    };
    const offFire = offDuring.runTool(completionParams(offArtifacts));
    await secondEntered;
    writePluginOverrides(offRepo.main, { modelHandoff: false, handoffTarget: "@smol" });
    releaseSecond?.();
    const offResult = await offFire;
    handoffSeams.inspectReadiness = REAL_INSPECT_READINESS;
    expect(codeOf(offResult)).toBe("preference-off");
    expect(stateOf(offResult)).toBe("pending");
    expect(offDuring.switched).toEqual(["probe/slow-model"]);
    expect(offDuring.liveSpec()).toBe("probe/slow-model");
    // The second skip site (the re-read after the readiness checkpoint) is a
    // bound site too: same status-bearing title shape, no bare condition.
    expect(offDuring.notices().some((line) => line.startsWith("Workflow off-during-iteration is running: "))).toBe(true);
  }, 60_000);
});

describe("pending picker and cycle changes cancel", () => {
  test("pending picker and cycle changes cancel: a completed away-and-back still cancels before any target action", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });

    const armed = await harness.runTool(startParams("picker-iteration"));
    expect(codeOf(armed)).toBe("armed");
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "picker-iteration");
    const pendingRecord = harness.records().at(-1)!;
    const baseline = pendingRecord.baselineModelChangeId;
    expect(baseline).not.toBeNull();
    expect(harness.ledger().some((entry) => entry.id === baseline)).toBe(true);

    // The arm's own transition must not cancel its own pending window.
    await harness.emitInput("next", "interactive");
    expect(statesOf(harness)).toEqual(["attempting", "pending"]);

    // The real picker path (`ModelControls.setModel`, the implementation behind
    // the temporary/role pickers) changes the model while the handoff is pending.
    await harness.controls.setModel(asHostModel(PICKER_MODEL), "default");
    expect(harness.liveSpec()).toBe("probe/picker-model");
    expect(harness.ledger().some((entry) => entry.type === "model_change" && entry.model === "probe/picker-model")).toBe(true);

    await harness.emit({ type: "agent_end", messages: [] });
    const cancelled = harness.records().at(-1)!;
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.reason).toContain("unowned model change to probe/picker-model");
    expect(harness.notices().some((line) => line.includes("model handoff cancelled"))).toBe(true);
    // The terminalize notice is a bound site: the title names the observed
    // workflow and its actual status, and the cancellation reason stays in the
    // detail.
    const cancelledNotice = harness.notices().find((line) => line.includes("model handoff cancelled"));
    expect(cancelledNotice?.startsWith("Workflow picker-iteration is running: ")).toBe(true);
    expect(cancelledNotice).toContain("unowned model change to probe/picker-model");
    expect(harness.attempts).toEqual(["probe/slow-model"]);

    expect(codeOf(await harness.runTool(completionParams(artifacts)))).toBe("not-pending");
    expect(harness.attempts).toEqual(["probe/slow-model"]);
    expect(harness.liveSpec()).toBe("probe/picker-model");

    // Re-enabling the preference cannot resurrect a cancelled binding.
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    expect(codeOf(await harness.runTool(completionParams(artifacts)))).toBe("not-pending");
    expect(harness.attempts).toEqual(["probe/slow-model"]);

    // Away and back: the real role-cycle path returns the session to the armed
    // baseline model, so the live model matches again — history still cancels.
    const backRepo = buildControlRepo();
    writePluginOverrides(backRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const back = await createHarness({
      cwd: backRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(backRepo.main),
    });
    const backArmed = await back.runTool(startParams("away-back-iteration"));
    expect(codeOf(backArmed)).toBe("armed");
    const backArtifacts = createWorkflowArtifacts(backRepo, back.sessionManager.getSessionId(), "away-back-iteration");
    const baselineModel = back.liveSpec();
    expect(baselineModel).toBe("probe/slow-model");

    await back.controls.setModel(asHostModel(PICKER_MODEL), "default");
    expect(back.liveSpec()).toBe("probe/picker-model");
    await back.controls.cycleRoleModels(["default", "slow"], "forward");
    expect(back.liveSpec()).toBe(baselineModel);
    expect(back.ledger().filter((entry) => entry.type === "model_change").map((entry) => entry.model)).toEqual([
      "probe/slow-model",
      "probe/picker-model",
      "probe/slow-model",
    ]);

    await back.emitToolResult("call-2", "bash", false);
    const awayBack = back.records().at(-1)!;
    expect(awayBack.state).toBe("cancelled");
    expect(awayBack.reason).toContain("unowned model change to probe/picker-model");
    expect(back.liveSpec()).toBe(baselineModel);
    expect(codeOf(await back.runTool(completionParams(backArtifacts)))).toBe("not-pending");
    expect(back.attempts).toEqual(["probe/slow-model"]);
  }, 60_000);
});

describe("unowned model change cancels conservatively", () => {
  test("unowned model change cancels conservatively: ledger entries, a bare live-model change and a change inside the awaited checkpoint", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    await harness.runTool(startParams("unowned-iteration"));
    expect(statesOf(harness)).toEqual(["attempting", "pending"]);

    // Another extension / host path appends a native model change: the extension
    // cannot attribute it, so it cancels conservatively and says so.
    harness.sessionManager.appendModelChange("probe/other-model", "temporary");
    harness.setLiveModel("other-model");
    await harness.emitBeforeAgentStart("go");
    const byHistory = harness.records().at(-1)!;
    expect(byHistory.state).toBe("cancelled");
    expect(byHistory.reason).toContain("unowned model change to probe/other-model");
    expect(byHistory.observedModel).toBe("probe/other-model");
    expect(harness.attempts).toEqual(["probe/slow-model"]);

    // A live mutation with no history append is caught by the live-model
    // comparison alone (the pre-append window). The disclosure is explicit: the
    // extension cannot tell who moved it.
    const liveRepo = buildControlRepo();
    writePluginOverrides(liveRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const live = await createHarness({
      cwd: liveRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(liveRepo.main),
    });
    await live.runTool(startParams("live-only-iteration"));
    const liveArtifacts = createWorkflowArtifacts(liveRepo, live.sessionManager.getSessionId(), "live-only-iteration");
    live.setLiveModel("default-model");
    expect(live.ledger().filter((entry) => entry.type === "model_change")).toHaveLength(1);
    await live.emitInput("still there?", "interactive");
    const byLive = live.records().at(-1)!;
    expect(byLive.state).toBe("cancelled");
    expect(byLive.reason).toContain("the live model is probe/default-model, not the armed baseline probe/slow-model");
    expect(codeOf(await live.runTool(completionParams(liveArtifacts)))).toBe("not-pending");
    expect(live.attempts).toEqual(["probe/slow-model"]);

    // A change that lands while the awaited settings/readiness work runs is
    // caught by the final scan in the same synchronous turn as the transition.
    const raceRepo = buildControlRepo();
    writePluginOverrides(raceRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const race = await createHarness({
      cwd: raceRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(raceRepo.main),
    });
    await race.runTool(startParams("race-iteration"));
    const raceArtifacts = createWorkflowArtifacts(raceRepo, race.sessionManager.getSessionId(), "race-iteration");
    const pendingFire = race.runTool(completionParams(raceArtifacts));
    // The fire path suspends on its first real read; this synchronous change
    // therefore lands before its continuation resumes.
    race.sessionManager.appendModelChange("probe/other-model", "default");
    race.setLiveModel("other-model");
    const raced = await pendingFire;
    expect(codeOf(raced)).toBe("cancelled");
    expect(statesOf(race)).toEqual(["attempting", "pending", "cancelled"]);
    expect(race.attempts).toEqual(["probe/slow-model"]);
    expect(race.liveSpec()).toBe("probe/other-model");

    // A ledger terminal written while readiness is awaited (observation handler)
    // must stop the fire path even when live model and history still look armed.
    const ledgerRepo = buildControlRepo();
    writePluginOverrides(ledgerRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const ledger = await createHarness({
      cwd: ledgerRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(ledgerRepo.main),
    });
    await ledger.runTool(startParams("ledger-race-iteration"));
    const ledgerArtifacts = createWorkflowArtifacts(
      ledgerRepo,
      ledger.sessionManager.getSessionId(),
      "ledger-race-iteration",
    );
    const pending = ledger.records().at(-1)!;
    expect(pending.state).toBe("pending");
    let releaseLedger: (() => void) | undefined;
    let enterLedger: (() => void) | undefined;
    const ledgerOpen = new Promise<void>((resolve) => {
      releaseLedger = resolve;
    });
    const ledgerEntered = new Promise<void>((resolve) => {
      enterLedger = resolve;
    });
    handoffSeams.inspectReadiness = async (binding, input) => {
      enterLedger?.();
      await ledgerOpen;
      return REAL_INSPECT_READINESS(binding, input);
    };
    const ledgerFire = ledger.runTool(completionParams(ledgerArtifacts));
    await ledgerEntered;
    ledger.sessionManager.appendCustomEntry(HANDOFF_CUSTOM_TYPE, {
      ...pending,
      state: "cancelled",
      reason: "an observation handler terminalized this binding while fire awaited",
    });
    releaseLedger?.();
    const ledgerResult = await ledgerFire;
    handoffSeams.inspectReadiness = REAL_INSPECT_READINESS;
    expect(codeOf(ledgerResult)).toBe("cancelled");
    expect(ledger.attempts).toEqual(["probe/slow-model"]);
    expect(ledger.switched).toEqual(["probe/slow-model"]);
    expect(statesOf(ledger).at(-1)).toBe("cancelled");
  }, 60_000);
});

describe("navigation and action exclude each other", () => {
  test("navigation and action exclude each other: navigation during an action is refused immediately, an earlier navigation fences the action, and an overlapping checkpoint never mislabels a running attempt", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    await harness.runTool(startParams("nav-iteration"));
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "nav-iteration");

    // --- Navigation arriving *during* an invoked action ---
    const release = harness.metadata.hold();
    const invoked = harness.nextAction();
    const firing = harness.runTool(completionParams(artifacts));
    await invoked;
    expect(harness.records().at(-1)!.state).toBe("attempting");
    expect(harness.liveSpec()).toBe("probe/slow-model");

    // The handler's own raw return is synchronous: a promise-like value would
    // mean it waited inside the event handler, where the host enforces a timeout.
    const raw = harness.rawHandlerResult("session_before_tree", { preparation: {}, signal: new AbortController().signal });
    expect(raw).toEqual({ cancel: true });
    expect(isPromiseLike(raw)).toBe(false);
    // …and the host's runner agrees, for every guarded navigation event.
    const duringAction = await harness.emit({
      type: "session_before_tree",
      preparation: { targetId: "root", oldLeafId: null, commonAncestorId: null, entriesToSummarize: [], userWantsSummary: false },
      signal: new AbortController().signal,
    });
    expect(duringAction).toEqual({ cancel: true });
    expect(harness.notices().some((line) => line.includes("navigation was refused"))).toBe(true);
    for (const event of ["session_before_switch", "session_before_branch"]) {
      const refused = await harness.emit(
        event === "session_before_switch"
          ? { type: event, reason: "new" }
          : { type: event, entryId: "root" },
      );
      expect(refused).toEqual({ cancel: true });
    }

    // A completion checkpoint that overlaps the running action must not
    // mislabel it uncertain.
    const overlapping = await harness.runTool(completionParams(artifacts));
    expect(codeOf(overlapping)).toBe("in-flight");
    expect(harness.records().at(-1)!.state).toBe("attempting");
    expect(statesOf(harness)).toEqual(["attempting", "pending", "attempting"]);

    release();
    const fired = await firing;
    expect(codeOf(fired)).toBe("handed_off");
    expect(harness.liveSpec()).toBe("probe/smol-model");
    expect(statesOf(harness)).toEqual(["attempting", "pending", "attempting", "handed_off"]);

    // The arm invocation is guarded by the same semantics as the target one: a
    // navigation arriving while it is in flight is refused, and no observation
    // during that await may terminalize the running attempt or notify the
    // coordinator as uncertain.
    const armNavRepo = buildControlRepo();
    writePluginOverrides(armNavRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const armNav = await createHarness({
      cwd: armNavRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(armNavRepo.main),
    });
    await armNav.emitInput("/iteration-start arm navigation", "interactive");
    const releaseArm = armNav.metadata.hold();
    const armInvoked = armNav.nextAction();
    const arming = armNav.runTool(startParams("arm-nav-iteration"));
    await armInvoked;
    expect(statesOf(armNav)).toEqual(["attempting"]);

    const rawDuringArm = armNav.rawHandlerResult("session_before_tree", {
      preparation: {},
      signal: new AbortController().signal,
    });
    expect(rawDuringArm).toEqual({ cancel: true });
    expect(isPromiseLike(rawDuringArm)).toBe(false);
    await armNav.emit({ type: "session_before_tree", preparation: {}, signal: new AbortController().signal });
    // Observation opportunities during the await must not invent a terminal state.
    await armNav.emit({ type: "agent_end", messages: [] });
    await armNav.emitInput("still arming", "interactive");
    expect(statesOf(armNav)).toEqual(["attempting"]);
    expect(armNav.notices().some((line) => line.includes("navigation was refused"))).toBe(true);
    expect(armNav.notices().filter((line) => line.includes("uncertain") || line.includes("suspended"))).toHaveLength(0);

    releaseArm();
    expect(codeOf(await arming)).toBe("armed");
    expect(statesOf(armNav)).toEqual(["attempting", "pending"]);
    expect(armNav.attempts).toEqual(["probe/slow-model"]);
    await armNav.emit({ type: "session_start" });
    expect(statesOf(armNav)).toEqual(["attempting", "pending"]);

    // Navigation arriving *first* keeps the arm action from starting at all: no
    // attempt record, no model action, and the same call succeeds afterwards.
    const preNavRepo = buildControlRepo();
    writePluginOverrides(preNavRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const preNav = await createHarness({
      cwd: preNavRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(preNavRepo.main),
    });
    await preNav.emit({ type: "session_before_tree", preparation: {}, signal: new AbortController().signal });
    const suspendedArm = await preNav.runTool(startParams("pre-nav-iteration"));
    expect(codeOf(suspendedArm)).toBe("suspended");
    expect(stateOf(suspendedArm)).toBe("none");
    expect(preNav.records()).toHaveLength(0);
    expect(preNav.attempts).toHaveLength(0);
    await preNav.emit({ type: "session_tree", newLeafId: "leaf-1", oldLeafId: null });
    expect(codeOf(await preNav.runTool(startParams("pre-nav-iteration")))).toBe("armed");
    expect(statesOf(preNav)).toEqual(["attempting", "pending"]);

    // --- Navigation arriving *first* fences the target action ---
    const fenceRepo = buildControlRepo();
    writePluginOverrides(fenceRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const fence = await createHarness({
      cwd: fenceRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(fenceRepo.main),
    });
    await fence.runTool(startParams("fence-iteration"));
    const fenceArtifacts = createWorkflowArtifacts(fenceRepo, fence.sessionManager.getSessionId(), "fence-iteration");

    const allowed = await fence.emit({ type: "session_before_tree", preparation: {}, signal: new AbortController().signal });
    expect(allowed).toBeUndefined();
    const suspended = await fence.runTool(completionParams(fenceArtifacts));
    expect(codeOf(suspended)).toBe("suspended");
    expect(stateOf(suspended)).toBe("pending");
    expect(fence.attempts).toEqual(["probe/slow-model"]);
    expect(fence.notices().some((line) => line.includes("handoff suspended"))).toBe(true);
    expect(statesOf(fence)).toEqual(["attempting", "pending"]);

    await fence.emit({ type: "session_tree", newLeafId: "leaf-1", oldLeafId: "leaf-2" });
    const afterFence = await fence.runTool(completionParams(fenceArtifacts));
    expect(codeOf(afterFence)).toBe("handed_off");
    expect(fence.switched).toEqual(["probe/slow-model", "probe/default-model"]);

    // A navigation that never completes leaves a visible suspended condition; a
    // reload recovers it.
    const stuckRepo = buildControlRepo();
    writePluginOverrides(stuckRepo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const stuck = await createHarness({
      cwd: stuckRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(stuckRepo.main),
    });
    await stuck.runTool(startParams("stuck-iteration"));
    const stuckArtifacts = createWorkflowArtifacts(stuckRepo, stuck.sessionManager.getSessionId(), "stuck-iteration");
    await stuck.emit({ type: "session_before_switch", reason: "resume", targetSessionFile: "/tmp/elsewhere.jsonl" });
    const stuckFire = await stuck.runTool(completionParams(stuckArtifacts));
    expect(codeOf(stuckFire)).toBe("suspended");
    expect(stuck.attempts).toEqual(["probe/slow-model"]);
    expect(stuck.notices().some((line) => line.includes("handoff suspended"))).toBe(true);
    await stuck.emit({ type: "session_start" });
    expect(codeOf(await stuck.runTool(completionParams(stuckArtifacts)))).toBe("handed_off");
    expect(stuck.switched).toEqual(["probe/slow-model", "probe/smol-model"]);
  }, 60_000);
});

describe("terminal state survives tree and reload", () => {
  test("terminal state survives tree and reload: no re-arm, no second fire, and a fork inherits no authority", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    await harness.runTool(startParams("terminal-iteration"));
    const artifacts = createWorkflowArtifacts(repo, session.getSessionId(), "terminal-iteration");
    expect(codeOf(await harness.runTool(completionParams(artifacts)))).toBe("handed_off");
    const settled = statesOf(harness);
    const actions = [...harness.attempts];

    await harness.emit({ type: "session_tree", newLeafId: "leaf-9", oldLeafId: "leaf-3" });
    await harness.emit({ type: "session_start" });
    expect(statesOf(harness)).toEqual(settled);
    expect(harness.attempts).toEqual(actions);
    expect(harness.ledger().filter((entry) => entry.type === "model_change" && entry.model === "probe/slow-model")).toHaveLength(1);

    expect(codeOf(await harness.runTool(completionParams(artifacts)))).toBe("not-pending");
    expect(codeOf(await harness.runTool(startParams("terminal-iteration")))).toBe("already-bound");
    expect(harness.attempts).toEqual(actions);

    // A fork gets a new session id: the copied records carry the parent's
    // session id, so the fork has no authority. A fresh session defers file
    // creation, so the durable file is materialized with the host's own
    // `ensureOnDisk` before the fork reads it.
    await session.ensureOnDisk();
    const sessionFile = session.getSessionFile();
    expect(sessionFile).toBeDefined();
    expect(existsSync(sessionFile!)).toBe(true);
    const forked = await SessionManager.forkFrom(sessionFile!, repo.main, scratchDir("omp-handoff-sessions-"));
    expect(forked.getSessionId()).not.toBe(session.getSessionId());
    expect(forked.getEntries().some((entry) => entry.type === "custom" && entry.customType === HANDOFF_CUSTOM_TYPE)).toBe(true);
    expect(decideSessionState(forked.getEntries(), forked.getSessionId()).kind).toBe("none");
    expect(readSessionRecords(forked.getEntries(), forked.getSessionId())).toHaveLength(0);

    const fork = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: forked,
    });
    await fork.emit({ type: "session_switch", reason: "fork", previousSessionFile: sessionFile });
    expect(codeOf(await fork.runTool(completionParams(artifacts)))).toBe("not-pending");
    expect(fork.attempts).toHaveLength(0);
    expect(fork.liveSpec()).toBe("probe/default-model");

    // A later new iteration in a *new* coordinator session still arms from the
    // saved preference.
    const later = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    expect(codeOf(await later.runTool(startParams("later-iteration")))).toBe("armed");
    expect(later.attempts).toEqual(["probe/slow-model"]);
    expect(statesOf(later)).toEqual(["attempting", "pending"]);
  }, 60_000);

  test("a reused coordinator session arms a later workflow after the previous binding is terminal", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    await harness.emitInput("/iteration-start first", "interactive");
    expect(codeOf(await harness.runTool(startParams("first-iteration")))).toBe("armed");
    const first = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "first-iteration");
    expect(codeOf(await harness.runTool(completionParams(first)))).toBe("handed_off");
    expect(statesOf(harness).at(-1)).toBe("handed_off");
    expect(harness.liveSpec()).toBe("probe/smol-model");

    const firstSnapshotPath = join(repo.harness, "workflows", "first-iteration", "snapshot.json");
    const firstSnapshot = JSON.parse(readFileSync(firstSnapshotPath, "utf8")) as Record<string, unknown>;
    firstSnapshot.status = "completed";
    writeJson(firstSnapshotPath, firstSnapshot);
    writeRegister(repo.harness, [repo.siblingId]);

    await harness.emitInput("/iteration-start second", "interactive");
    const later = await harness.runTool(startParams("second-iteration"));
    expect(codeOf(later)).toBe("armed");
    expect(later.details.mstarModelHandoff).toMatchObject({
      workflowId: "second-iteration",
      state: "pending",
    });
    expect(harness.liveSpec()).toBe("probe/slow-model");
    expect(harness.attempts.filter((model) => model === "probe/slow-model")).toHaveLength(2);
  }, 60_000);
});

describe("persisted attempt resumes uncertain without retry", () => {
  test("persisted attempt resumes uncertain without retry: an interrupted attempt is never replayed and no model is restored", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    await harness.runTool(startParams("attempt-iteration"));
    const artifacts = createWorkflowArtifacts(repo, session.getSessionId(), "attempt-iteration");

    // The target action is invoked and then interrupted: the metadata barrier
    // stays held, so the durable state is `attempting` with no outcome — what a
    // process death mid-action leaves behind.
    const held = harness.metadata.hold();
    const invoked = harness.nextAction();
    const interrupted = harness.runTool(completionParams(artifacts));
    await invoked;
    expect(harness.records().at(-1)!.state).toBe("attempting");
    expect(harness.records().at(-1)!.receipt).toBeDefined();
    expect(harness.liveSpec()).toBe("probe/slow-model");

    // Resume: a second extension instance over the same durable session — the
    // session still runs `@slow`, since the interrupted switch never completed.
    const resumed = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: harness.sessionManager,
      initialModelId: "slow-model",
    });
    await resumed.emit({ type: "session_start" });
    const uncertain = resumed.records().at(-1)!;
    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.action).toBe("handoff");
    expect(uncertain.reason).toContain("no recorded outcome");
    expect(resumed.notices().some((line) => line.includes("handoff uncertain"))).toBe(true);
    expect(resumed.attempts).toHaveLength(0);
    expect(resumed.liveSpec()).toBe("probe/slow-model");

    expect(codeOf(await resumed.runTool(completionParams(artifacts)))).toBe("not-pending");
    expect(resumed.attempts).toHaveLength(0);

    // Replaying the same reconstruction appends nothing new (terminal is stable).
    await resumed.emit({ type: "session_start" });
    expect(statesOf(resumed)).toEqual(["attempting", "pending", "attempting", "uncertain"]);
    expect(resumed.attempts).toHaveLength(0);

    // The interrupted action is released only now, after every assertion: it is
    // the *original* attempt completing, not a retry by the resumed session.
    held();
    await interrupted;
    expect(resumed.attempts).toHaveLength(0);

    // A missing armed baseline cursor is uncertainty, not a reason to reset the
    // observation window (a truncated or rewritten ledger is the real case).
    const cursorRepo = buildControlRepo();
    writePluginOverrides(cursorRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const cursor = await createHarness({
      cwd: cursorRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(cursorRepo.main),
    });
    await cursor.runTool(startParams("cursor-iteration"));
    const entries = cursor.ledger();
    const baseline = cursor.records().at(-1)!.baselineModelChangeId;
    expect(decideSessionState(entries, cursor.sessionManager.getSessionId()).kind).toBe("pending");
    const pruned = entries.filter((entry) => entry.id !== baseline);
    expect(pruned).toHaveLength(entries.length - 1);
    const prunedDecision = decideSessionState(pruned, cursor.sessionManager.getSessionId());
    expect(prunedDecision.kind).toBe("uncertain");
    expect(prunedDecision.kind === "uncertain" ? prunedDecision.reason : "").toContain("is not in the ledger");
  }, 60_000);
});

describe("registered attach and shared notice shape", () => {
  test("registered attach: a genuinely registered workflow with its own snapshot arms and hands off, a foreign coordinator refuses already-bound without any action, and notices carry the shared title shape", async () => {
    // --- Lawful attach: the register row, the own snapshot and this session's
    // coordinator envelope all exist *before* the start call (the real anchor
    // after Prepare §1.5). The structural branch is host-derived; the caller
    // supplies only the workflow id.
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "attach-iteration");
    const armed = await harness.runTool(startParams("attach-iteration"));
    expect(codeOf(armed)).toBe("armed");
    expect(stateOf(armed)).toBe("pending");
    expect(harness.attempts).toEqual(["probe/slow-model"]);
    expect(statesOf(harness)).toEqual(["attempting", "pending"]);

    // After authority approval the unchanged one-shot protocol completes:
    // readiness → handed_off.
    const fired = await harness.runTool(completionParams(artifacts));
    expect(codeOf(fired)).toBe("handed_off");
    expect(statesOf(harness)).toEqual(["attempting", "pending", "attempting", "handed_off"]);

    // The notice channel is unchanged, and the completion notice (a bound site
    // with an own snapshot) carries a status-bearing title: observed id and
    // status verbatim, with the handoff condition preserved in the detail.
    expect(
      harness.ledger().some((entry) => entry.type === "custom_message" && entry.customType === HANDOFF_NOTICE_CUSTOM_TYPE),
    ).toBe(true);
    const completeNotice = harness.notices().find((line) => line.includes("model handoff complete"));
    expect(completeNotice).toBeDefined();
    expect(completeNotice).toContain("Workflow attach-iteration is running:");
    expect(completeNotice).toContain("model handoff complete for this coordinator session");

    // --- A snapshot-free (unsampled) title is a fallback: it names the observed
    // condition and asserts no workflow status.
    const fenceRepo = buildControlRepo();
    writePluginOverrides(fenceRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const fenced = await createHarness({
      cwd: fenceRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(fenceRepo.main),
    });
    await fenced.emit({ type: "session_before_tree", preparation: {}, signal: new AbortController().signal });
    const suspended = await fenced.runTool(startParams("fence-attach-iteration"));
    expect(codeOf(suspended)).toBe("suspended");
    const suspendedNotice = fenced.notices()[0]!;
    expect(suspendedNotice).toContain("handoff suspended");
    expect(suspendedNotice).toContain("needs attention: ");
    expect(suspendedNotice).not.toContain("Workflow fence-attach-iteration is");

    // --- Foreign-coordinator attach: the registered workflow's own envelope
    // names a different coordinator session. The observable outcome is
    // `already-bound` with the original detail, and zero model action or record.
    const foreignRepo = buildControlRepo();
    writePluginOverrides(foreignRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const foreign = await createHarness({
      cwd: foreignRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(foreignRepo.main),
    });
    createWorkflowArtifacts(foreignRepo, "someone-else-session", "foreign-bound");
    const refused = await foreign.runTool(startParams("foreign-bound"));
    expect(codeOf(refused)).toBe("already-bound");
    expect(String(refused.content[0]?.text)).toContain(
      "workflow foreign-bound is bound to coordinator session someone-else-session, not to this session",
    );
    expect(foreign.attempts).toHaveLength(0);
    expect(foreign.records()).toHaveLength(0);
    expect(foreign.notices().some((line) => line.includes("already-bound"))).toBe(true);

    // --- Attach structural failure: the register names the workflow but its own
    // snapshot is missing — never adopted, never a fallback into reservation.
    const ghostRepo = buildControlRepo();
    writePluginOverrides(ghostRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const ghost = await createHarness({
      cwd: ghostRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(ghostRepo.main),
    });
    writeRegister(ghostRepo.harness, [ghostRepo.siblingId, "ghost-iteration"]);
    expect(codeOf(await ghost.runTool(startParams("ghost-iteration")))).toBe("invalid-root");
    expect(ghost.attempts).toHaveLength(0);
    expect(ghost.records()).toHaveLength(0);

    // --- The unregistered reservation path keeps its refusal vocabulary
    // byte-for-byte: an existing snapshot without a register row refuses
    // `already-bound` with the exact frozen message template.
    const staleRepo = buildControlRepo();
    writePluginOverrides(staleRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const stale = await createHarness({
      cwd: staleRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(staleRepo.main),
    });
    mkdirSync(join(staleRepo.harness, "workflows", "stale-iteration"), { recursive: true });
    writeJson(join(staleRepo.harness, "workflows", "stale-iteration", "snapshot.json"), {
      schema_version: 1,
      id: "stale-iteration",
      type: "iteration",
      status: "running",
      started_at: "2026-09-16",
      updated_at: "2026-09-16T00:00:00.000Z",
      plans: [],
    });
    const staleRefusal = await stale.runTool(startParams("stale-iteration"));
    expect(codeOf(staleRefusal)).toBe("already-bound");
    const staleText = String(staleRefusal.content[0]?.text);
    expect(staleText.startsWith("the new-iteration handoff binding was refused (already-bound): a workflow snapshot already exists at ")).toBe(true);
    expect(staleText.endsWith(join("workflows", "stale-iteration", "snapshot.json"))).toBe(true);
    expect(stale.attempts).toHaveLength(0);
    expect(stale.records()).toHaveLength(0);
  }, 60_000);

  test("attach never adopts a workflow the root register lists twice", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "duplicate-row-iteration");

    // A hand-edited register that lists the same workflow id twice. The
    // duplicated row is itself a register violation (`status.workflow.duplicate-id`),
    // so the register gate refuses before the attach path's own "exactly one
    // active register row" check can run — the observable end of that guard: no
    // classification, no re-read and no TOCTOU window can turn a doubled
    // register row into an adoption. (The guard's own branch therefore stays
    // defense-in-depth, like the missing-snapshot branch the register gate also
    // fronts; only the refusal it guarantees is observable.)
    writeJson(join(repo.harness, "status.json"), {
      version: 2,
      updated_at: "2026-09-16",
      workflows: [
        { id: repo.siblingId, type: "iteration", started_at: "2026-09-16", dir: `workflows/${repo.siblingId}` },
        { id: "duplicate-row-iteration", type: "iteration", started_at: "2026-09-16", dir: "workflows/duplicate-row-iteration" },
        { id: "duplicate-row-iteration", type: "iteration", started_at: "2026-09-16", dir: "workflows/duplicate-row-iteration" },
      ],
    });

    const refused = await harness.runTool(startParams("duplicate-row-iteration"));
    expect(codeOf(refused)).toBe("invalid-root");
    expect(refused.isError).toBe(true);
    expect(String(refused.content[0]?.text)).toContain(
      "the root register is not a valid v2 status document: status.workflow.duplicate-id",
    );
    expect(harness.attempts).toHaveLength(0);
    expect(harness.records()).toHaveLength(0);
  }, 60_000);
});

describe("switch failure reports actual model", () => {
  test("switch failure reports actual model: refused and throwing switches fail visibly with no retry and no restore", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    await harness.runTool(startParams("fail-iteration"));
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "fail-iteration");
    const armedModel = harness.liveSpec();

    // Missing auth at fire time: the public action reports `false`. The session
    // keeps the model it actually has, and nothing is rolled back.
    harness.auth.allowed = false;
    const refused = await harness.runTool(completionParams(artifacts));
    expect(codeOf(refused)).toBe("switch-refused");
    expect(refused.isError).toBe(true);
    expect(harness.liveSpec()).toBe(armedModel);
    expect(harness.liveSpec()).not.toBe("probe/default-model");
    const failed = harness.records().at(-1)!;
    expect(failed.state).toBe("failed");
    expect(failed.action).toBe("handoff");
    expect(failed.receipt).toBeDefined();
    expect(failed.reason).toContain("probe/smol-model");
    expect(harness.notices().some((line) => line.includes(armedModel))).toBe(true);

    expect(codeOf(await harness.runTool(completionParams(artifacts)))).toBe("not-pending");
    expect(harness.attempts).toEqual(["probe/slow-model", "probe/smol-model"]);

    // A throwing switch reports the throw and the actual model.
    const throwRepo = buildControlRepo();
    writePluginOverrides(throwRepo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const throwing = await createHarness({
      cwd: throwRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(throwRepo.main),
    });
    await throwing.runTool(startParams("throw-iteration"));
    const throwArtifacts = createWorkflowArtifacts(throwRepo, throwing.sessionManager.getSessionId(), "throw-iteration");
    throwing.metadata.failNext = true;
    const threw = await throwing.runTool(completionParams(throwArtifacts));
    expect(codeOf(threw)).toBe("switch-threw");
    expect(threw.isError).toBe(true);
    expect(throwing.liveSpec()).toBe("probe/slow-model");
    expect(throwing.records().at(-1)!.state).toBe("failed");
    expect(throwing.records().at(-1)!.reason).toContain("probe metadata refresh failed");

    // An unresolvable destination fails before the action instead of switching
    // to some other model.
    const noTargetRepo = buildControlRepo();
    writePluginOverrides(noTargetRepo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const noTarget = await createHarness({
      cwd: noTargetRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(noTargetRepo.main),
      modelRoles: { slow: "probe/slow-model", default: "probe/default-model", smol: "probe/gone-model" },
    });
    await noTarget.runTool(startParams("no-target-iteration"));
    const noTargetArtifacts = createWorkflowArtifacts(noTargetRepo, noTarget.sessionManager.getSessionId(), "no-target-iteration");
    const unresolved = await noTarget.runTool(completionParams(noTargetArtifacts));
    expect(codeOf(unresolved)).toBe("target-unresolved");
    expect(noTarget.liveSpec()).toBe("probe/slow-model");
    expect(noTarget.switched).toEqual(["probe/slow-model"]);
    expect(statesOf(noTarget)).toEqual(["attempting", "pending", "failed"]);
  }, 60_000);
});

describe("prerequisite identity — managed coordinator bind transport", () => {
  test("a bare or namespaced shell coordinator bind is blocked before execution", async () => {
    const repo = buildControlRepo();
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });

    // The bounded classifier recognizes the two supported shell identities and
    // one command shape, and returns an actionable redirect instead of letting
    // the CLI trust an injected environment value.
    const bindCommand = "mstar plan bind --coordinator --workflow fixture-iteration";
    for (const toolName of ["bash", "functions.bash"]) {
      const refused = await harness.emitToolCall({
        type: "tool_call",
        toolCallId: `call-${toolName}`,
        toolName,
        input: { command: bindCommand },
      });
      expect(refused).toMatchObject({ block: true });
      expect(String((refused as { reason?: string }).reason)).toContain(COORDINATOR_TOOL_NAME);
    }

    // Unrelated tool calls are not revised. Host session identity injection
    // for bash is covered separately and must not change the coordinator route.
    for (const [toolName, input] of [
      ["read", { command: bindCommand }],
      [TOOL_NAME, { command: bindCommand }],
      ["bash", "not-an-object"],
    ] as const) {
      expect(
        await harness.emitToolCall({ type: "tool_call", toolCallId: "call-other", toolName, input }),
      ).toBeUndefined();
    }

    // Coordinator binds remain on the dedicated host tool; shell interception
    // continues to block them before any identity prefix can be applied.
    expect(harness.records()).toHaveLength(0);
    expect(harness.notices()).toHaveLength(0);
    expect(harness.ledger().filter((entry) => entry.type === "custom")).toHaveLength(0);
  }, 30_000);
});

describe("host session identity injection", () => {
  test("repeated bash revisions inject the host id once and preserve caller input", async () => {
    const repo = buildControlRepo();
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const sessionId = harness.sessionManager.getSessionId();
    const baseCommand = 'printf %s "$MSTAR_HOST_SESSION_ID"';
    let input: Record<string, unknown> = { command: baseCommand, timeout: 5 };
    for (let fire = 0; fire < 3; fire += 1) {
      const revision = await harness.emitToolCall({
        type: "tool_call",
        toolCallId: `call-bash-${fire}`,
        toolName: "bash",
        input,
      });
      if (isPlainFixtureRecord(revision) && isPlainFixtureRecord(revision.input)) {
        input = revision.input;
      }
    }

    const command = input.command;
    expect(typeof command).toBe("string");
    if (typeof command !== "string") throw new Error("expected revised bash command");
    expect(command.match(/export MSTAR_HOST_SESSION_ID=/g)).toHaveLength(1);
    expect(command).toBe(`export MSTAR_HOST_SESSION_ID='${sessionId}'; ${baseCommand}`);
    const child = Bun.spawnSync(["sh", "-c", command]);
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe(sessionId);

    const env = { KEEP: "yes", MSTAR_HOST_SESSION_ID: "caller-value" };
    const envRevision = await harness.emitToolCall({
      type: "tool_call",
      toolCallId: "call-env",
      toolName: "bash",
      input: { command: "true", env },
    });
    if (!isPlainFixtureRecord(envRevision) || !isPlainFixtureRecord(envRevision.input)) {
      throw new Error("expected a revised bash input");
    }
    expect(envRevision.input.env).toBe(env);

    for (const [toolName, malformedInput] of [
      ["bash", { timeout: 5 }],
      ["bash", "not-an-object"],
      ["read", { command: "true" }],
    ] as const) {
      expect(
        await harness.emitToolCall({
          type: "tool_call",
          toolCallId: `call-skip-${toolName}`,
          toolName,
          input: malformedInput,
        }),
      ).toBeUndefined();
    }

    const manager = harness.sessionManager as unknown as { getSessionId: () => string };
    const getSessionId = manager.getSessionId;
    manager.getSessionId = () => "";
    try {
      expect(
        await harness.emitToolCall({
          type: "tool_call",
          toolCallId: "call-idless",
          toolName: "bash",
          input: { command: "true" },
        }),
      ).toBeUndefined();
    } finally {
      manager.getSessionId = getSessionId;
    }
    expect(harness.records()).toHaveLength(0);
    expect(harness.notices()).toHaveLength(0);
  }, 30_000);
  test("functions.bash revisions inject the host id once across re-fires", async () => {
    const repo = buildControlRepo();
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const baseCommand = "mstar plan bind --workflow wf-a --plan plan-a";
    let input: Record<string, unknown> = { command: baseCommand };
    for (let fire = 0; fire < 3; fire += 1) {
      const revision = await harness.emitToolCall({
        type: "tool_call",
        toolCallId: `call-functions-bash-${fire}`,
        toolName: "functions.bash",
        input,
      });
      if (isPlainFixtureRecord(revision) && isPlainFixtureRecord(revision.input)) {
        input = revision.input;
      }
    }

    const command = input.command;
    expect(typeof command).toBe("string");
    if (typeof command !== "string") throw new Error("expected revised functions.bash command");
    expect(command.match(/export MSTAR_HOST_SESSION_ID=/g)).toHaveLength(1);
    expect(command.endsWith(baseCommand)).toBe(true);
  }, 30_000);
  test("caller-supplied session export is respected without revision", async () => {
    const repo = buildControlRepo();
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const command = "export MSTAR_HOST_SESSION_ID=caller-value; true";
    const input = { command };

    expect(
      await harness.emitToolCall({
        type: "tool_call",
        toolCallId: "call-caller-session-export",
        toolName: "bash",
        input,
      }),
    ).toBeUndefined();
    expect(input.command).toBe(command);
  }, 30_000);
});

describe("coordinator diagnostic forwarding", () => {
  test("the registered handoff tool forwards the checkpoint's typed diagnostic verbatim into a refusal", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    expect(codeOf(await harness.runTool(startParams("diagnostic-iteration")))).toBe("armed");
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "diagnostic-iteration");

    // The checkpoint's own refusal, with the §5 typed refinement a real
    // identity/path refusal carries. Replaced through the module's documented
    // test seam: the tool must project it, not re-derive or drop it.
    handoffSeams.inspectReadiness = async () => ({
      ready: false,
      codes: ["binding-invalid", "prepare-not-locked"],
      diagnostics: [
        {
          code: "binding-invalid",
          detail: "foreign-owner",
          workflowId: "diagnostic-iteration",
          source: "snapshot-coordinator",
          expected: "prior-host-session",
          current: harness.sessionManager.getSessionId(),
          next: "call `mstar_coordinator` with {operation:\"recover\", …}",
        },
      ],
    });
    const refused = await harness.runTool(completionParams(artifacts));
    handoffSeams.inspectReadiness = REAL_INSPECT_READINESS;

    expect(codeOf(refused)).toBe("not-ready");
    expect(stateOf(refused)).toBe("pending");
    const details = refused.details.mstarModelHandoff as Record<string, unknown>;
    expect(details.codes).toEqual(["binding-invalid", "prepare-not-locked"]);
    expect(details.diagnostics).toEqual([
      expect.objectContaining({ detail: "foreign-owner", expected: "prior-host-session", source: "snapshot-coordinator" }),
    ]);
    // The refusal text names the typed reason and the next supported operation.
    expect(String(refused.content[0]?.text)).toContain("foreign-owner");
    expect(String(refused.content[0]?.text)).toContain("mstar_coordinator");
    // Nothing was switched and the pending binding survives the refusal.
    expect(harness.switched).toEqual(["probe/slow-model"]);
  }, 60_000);
});

/* ------------------------------------------------ registered coordinator --- */

/** A running, registered workflow with no coordinator binding yet. */
function createBindableWorkflow(repo: ControlRepo, workflowId: string): void {
  const workflowDir = join(repo.harness, "workflows", workflowId);
  mkdirSync(workflowDir, { recursive: true });
  writeJson(join(workflowDir, "snapshot.json"), {
    schema_version: 1,
    id: workflowId,
    type: "iteration",
    status: "running",
    started_at: "2026-09-16",
    updated_at: "2026-09-16T00:00:00.000Z",
    plans: [],
  });
  writeRegister(repo.harness, [repo.siblingId, workflowId]);
}

function coordinatorCodeOf(result: ToolResult): string {
  return String(result.details.mstarCoordinator?.code ?? "");
}

function coordinatorSnapshotOf(repo: ControlRepo, workflowId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repo.harness, "workflows", workflowId, "snapshot.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("prerequisite identity — registered coordinator tool handler", () => {
  test("the real handler binds the current host identity and the workflow keeps exactly one owner", async () => {
    const repo = buildControlRepo();
    const workflowId = "fixture-bind-iteration";
    createBindableWorkflow(repo, workflowId);
    // The real engine bind resolves a control harness root against the ACTIVE
    // artifact store, and this suite's process cwd is a real checkout (so its
    // own default store would win). Pin the store to the fixture harness: the
    // fixture root is the only root these cases address.
    setArtifactStore(createFsStore(repo.harness));
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const hostId = harness.sessionManager.getSessionId();
    expect(hostId).not.toBe("");

    const bound = await harness.runCoordinatorTool({ operation: "bind", workflowId });
    expect(bound.isError).toBe(false);
    expect(bound.details.mstarCoordinator).toMatchObject({ workflowId, sessionId: hostId, role: "coordinator" });
    // §3.3: a model-visible tool result is NOT coordinator-owned transport, so
    // the coordinator envelope path is in neither the text nor the details.
    expect(JSON.stringify(bound.details.mstarCoordinator)).not.toContain("sessions/");
    expect(String(bound.content[0]?.text)).not.toContain("sessions/");

    // The native id reached the engine's own binding, and the envelope is the
    // role-scoped one for that identity.
    const snapshot = coordinatorSnapshotOf(repo, workflowId);
    const coordination = snapshot.coordination as { coordinator?: { session_id?: string } } | undefined;
    expect(coordination?.coordinator?.session_id).toBe(hostId);
    const envelopePath = join(repo.harness, "workflows", workflowId, "sessions", `coordinator-${hostId}.json`);
    expect(existsSync(envelopePath)).toBe(true);
    expect(JSON.parse(readFileSync(envelopePath, "utf8"))).toMatchObject({ role: "coordinator", session_id: hostId });

    // Duplicate-holder refusal is preserved: the second bind mutates nothing.
    const bytesBefore = readFileSync(join(repo.harness, "workflows", workflowId, "snapshot.json"), "utf8");
    const again = await harness.runCoordinatorTool({ operation: "bind", workflowId });
    expect(coordinatorCodeOf(again)).toBe("coordination.duplicate-holder");
    expect(readFileSync(join(repo.harness, "workflows", workflowId, "snapshot.json"), "utf8")).toBe(bytesBefore);
  }, 60_000);

  test("leaf, scoped-plan, id-less and caller-forged calls cannot cross-bind", async () => {
    const repo = buildControlRepo();
    const workflowId = "fixture-guard-iteration";
    createBindableWorkflow(repo, workflowId);
    setArtifactStore(createFsStore(repo.harness));
    const snapshotPath = join(repo.harness, "workflows", workflowId, "snapshot.json");
    const before = readFileSync(snapshotPath, "utf8");

    // A leaf/subagent session never bootstraps a coordinator identity.
    const taskSession = newSession(repo.main);
    taskSession.appendSessionInit({ systemPrompt: "task", task: "scout the repo", tools: ["read"], agent: "scout" });
    const taskHarness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: taskSession,
      mode: "json",
    });
    expect(coordinatorCodeOf(await taskHarness.runCoordinatorTool({ operation: "bind", workflowId }))).toBe(
      "leaf-session",
    );

    // The scoped-plan route restores a binding; it never bootstraps one.
    const scoped = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    await scoped.emitInput("/iteration-drive", "interactive");
    expect(coordinatorCodeOf(await scoped.runCoordinatorTool({ operation: "bind", workflowId }))).toBe(
      "scoped-plan-route",
    );

    // A host session with no native id has no identity to acquire.
    const idless = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const manager = idless.sessionManager as unknown as { getSessionId: () => string };
    const realGetSessionId = manager.getSessionId;
    manager.getSessionId = () => "";
    try {
      expect(coordinatorCodeOf(await idless.runCoordinatorTool({ operation: "bind", workflowId }))).toBe(
        "identity-missing",
      );
    } finally {
      manager.getSessionId = realGetSessionId;
    }

    // The registered schema rejects an identity-shaped field, and the raw
    // handler refuses it too: the adapter owns its own boundary.
    const lawful = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    expect(lawful.validateCoordinator({ operation: "bind", workflowId }).success).toBe(true);
    for (const forged of [
      { operation: "bind", workflowId, sessionId: "attacker" },
      { operation: "bind", workflowId, harnessRoot: "/elsewhere/.mstar" },
      { operation: "bind", workflowId, role: "coordinator" },
      { operation: "bind", workflowId, authority: true },
      { operation: "bind", workflowId, credentialPath: "/tmp/creds.json" },
    ]) {
      expect({ forged, valid: lawful.validateCoordinator(forged).success }).toEqual({ forged, valid: false });
      const raw = await lawful.runRawCoordinatorTool(forged);
      expect({ forged, code: coordinatorCodeOf(raw) }).toEqual({ forged, code: "forbidden-field" });
    }

    // Every refusal above wrote nothing.
    expect(readFileSync(snapshotPath, "utf8")).toBe(before);
    expect(existsSync(join(repo.harness, "workflows", workflowId, "sessions"))).toBe(false);
  }, 60_000);

  test("two control projects stay isolated, and each keeps its own single owner", async () => {
    const first = buildControlRepo();
    const second = buildControlRepo();
    const workflowId = "fixture-isolated-iteration";
    createBindableWorkflow(first, workflowId);
    createBindableWorkflow(second, workflowId);

    const firstHarness = await createHarness({
      cwd: first.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(first.main),
    });
    const secondHarness = await createHarness({
      cwd: second.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(second.main),
    });

    // Each root is addressed through its own pinned store; a bind in one project
    // can never adopt or write the other's root.
    setArtifactStore(createFsStore(first.harness));
    expect((await firstHarness.runCoordinatorTool({ operation: "bind", workflowId })).details.ok).toBe(true);
    setArtifactStore(createFsStore(second.harness));
    expect((await secondHarness.runCoordinatorTool({ operation: "bind", workflowId })).details.ok).toBe(true);

    const firstCoordination = coordinatorSnapshotOf(first, workflowId).coordination as {
      coordinator?: { session_id?: string };
    };
    const secondCoordination = coordinatorSnapshotOf(second, workflowId).coordination as {
      coordinator?: { session_id?: string };
    };
    expect(firstCoordination.coordinator?.session_id).toBe(firstHarness.sessionManager.getSessionId());
    expect(secondCoordination.coordinator?.session_id).toBe(secondHarness.sessionManager.getSessionId());
    // Neither root carries the other project's identity.
    expect(firstCoordination.coordinator?.session_id).not.toBe(secondHarness.sessionManager.getSessionId());
    expect(
      existsSync(
        join(second.harness, "workflows", workflowId, "sessions", `coordinator-${firstHarness.sessionManager.getSessionId()}.json`),
      ),
    ).toBe(false);
  }, 90_000);
});

/* ------------------------------------------------- coordinator bar titles --- */

/**
 * The extension's own visible output for a captured `custom_message` entry is
 * the `formatNotice` string — the `<title>: <detail>` line the host bar mounts
 * under the entry's `customType` label. Asserting that string keeps the
 * observation on the extension's output contract instead of on the host's
 * private UI components, which the 18.3.0 host package stopped shipping.
 */
function customMessageTexts(entries: readonly SessionEntry[]): readonly string[] {
  return entries
    .filter((entry): entry is Extract<SessionEntry, { type: "custom_message" }> => entry.type === "custom_message")
    .map((entry) => String(entry.content));
}

describe("coordinator notice bar titles", () => {
  test("notice-bar-title: a handoff notice renders the shared visible bar title, which states no workflow status, while the hidden durable type, its restore and the refusal codes stay unchanged", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });

    expect(codeOf(await harness.runTool(startParams("bar-title-iteration")))).toBe("armed");
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "bar-title-iteration");
    await harness.emitInput("next", "interactive");

    // An unowned model change while pending cancels the handoff. The terminal
    // notice is a bound site, so its title names the observed workflow and its
    // actual status.
    await harness.controls.setModel(asHostModel(PICKER_MODEL), "default");
    await harness.emit({ type: "agent_end", messages: [] });

    // The only visible type this extension emits is the shared bar title.
    const visible = harness.ledger().filter((entry) => entry.type === "custom_message");
    expect(visible.map((entry) => entry.customType)).toEqual(["mstar:notice"]);

    // The hidden durable identity is untouched, and its restore still replays.
    const durableTypes = harness
      .ledger()
      .filter((entry) => entry.type === "custom")
      .map((entry) => entry.customType);
    expect(durableTypes.length).toBeGreaterThan(0);
    expect(durableTypes.every((type) => type === "mstar:model-handoff")).toBe(true);
    expect(decideSessionState(harness.ledger(), harness.sessionManager.getSessionId()).kind).toBe("terminal");

    // The bar label itself is the entry's customType (asserted above); the
    // status sentence and the reason live in the single formatNotice line,
    // each stated once.
    const [content] = customMessageTexts(harness.ledger());
    expect(content).toContain("Workflow bar-title-iteration is running");
    expect(content).toContain("model handoff cancelled for this coordinator session");
    expect(content?.match(/is running/g) ?? []).toHaveLength(1);

    // The machine refusal code is unchanged.
    expect(codeOf(await harness.runTool(completionParams(artifacts)))).toBe("not-pending");
  }, 60_000);
});

/* ---------------------------------------------- prepare coordinator recovery --- */

const RECOVERY_PRIOR_SESSION = "cancelled-host-session";

/**
 * A running Prepare iteration that RECORDS a coordinator the host can no longer
 * authenticate — `phase-1-prepare`, an empty plan set, a reviewed locked compass
 * and the prior coordinator's envelope on disk. This is the state the blocked
 * iteration is in after its host handoff was cancelled: a binding exists, and the
 * session that holds it can no longer pass authorization.
 */
function createRecoverableWorkflow(repo: ControlRepo, workflowId: string, priorSessionId: string): void {
  const workflowDir = join(repo.harness, "workflows", workflowId);
  const sessionsDir = join(workflowDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const priorEnvelope = join(sessionsDir, `coordinator-${priorSessionId}.json`);
  writeJson(join(workflowDir, "snapshot.json"), {
    schema_version: 1,
    id: workflowId,
    type: "iteration",
    status: "running",
    phase: "phase-1-prepare",
    started_at: "2026-09-16",
    updated_at: "2026-09-16T00:00:00.000Z",
    compass_ref: `iterations/${workflowId}/delivery-compass.md`,
    branch: { base: "main", integration: repo.integrationBranch, target: "main" },
    plans: [],
    coordination: {
      coordinator: { session_id: priorSessionId, session_file: priorEnvelope, bound_at: "2026-09-16T00:00:00.000Z" },
    },
  });
  writeJson(priorEnvelope, {
    schema_version: 1,
    role: "coordinator",
    session_id: priorSessionId,
    workflow_id: workflowId,
    harness_root: repo.harness,
  });
  mkdirSync(join(repo.harness, "iterations", workflowId), { recursive: true });
  writeFileSync(
    join(repo.harness, "iterations", workflowId, "delivery-compass.md"),
    ["---", `iteration_id: ${workflowId}`, "status: locked", "plans:", "  - 20260921-recovery-fixture", "---", "", "# Compass", ""].join("\n"),
  );
  writeRegister(repo.harness, [repo.siblingId, workflowId]);
}

/** The recovery request body a reviewed caller sends (tokens filled per case). */
function recoveryToolParams(
  workflowId: string,
  view: Record<string, unknown>,
  priorSessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operation: "recover",
    workflowId,
    expectedSnapshotVersion: view.snapshotVersion,
    expectedCompassVersion: view.compassVersion,
    operationId: "op-host-recover-1",
    reason: "the host handoff of the prior session was cancelled",
    authorizationRef: "PM-authorization-20260921",
    stoppedSessionIds: [priorSessionId],
    ...overrides,
  };
}

/** The recorded coordinator binding of one fixture workflow. */
function recordedCoordinatorOfWorkflow(repo: ControlRepo, workflowId: string): Record<string, unknown> {
  const snapshot = coordinatorSnapshotOf(repo, workflowId);
  const coordination = snapshot.coordination;
  const coordinator = isPlainFixtureRecord(coordination) ? coordination.coordinator : undefined;
  return isPlainFixtureRecord(coordinator) ? coordinator : {};
}

/** The stored recovery audit of one fixture workflow. */
function recoveryAuditOfWorkflow(repo: ControlRepo, workflowId: string): Array<Record<string, unknown>> {
  const snapshot = coordinatorSnapshotOf(repo, workflowId);
  const coordination = snapshot.coordination;
  const recoveries = isPlainFixtureRecord(coordination) ? coordination.identity_recoveries : undefined;
  return Array.isArray(recoveries) ? (recoveries as Array<Record<string, unknown>>) : [];
}

/** Plain-object narrowing for the fixture JSON (no inline cast at member access). */
function isPlainFixtureRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("prerequisite identity — registered coordinator recovery tool handler", () => {
  test("prepare coordinator recovery replaces a cancelled binding through the real tool handler", async () => {
    const repo = buildControlRepo();
    const workflowId = "fixture-recovery-iteration";
    createRecoverableWorkflow(repo, workflowId, RECOVERY_PRIOR_SESSION);
    setArtifactStore(createFsStore(repo.harness));
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const hostId = harness.sessionManager.getSessionId();
    const snapshotPath = join(repo.harness, "workflows", workflowId, "snapshot.json");
    const priorEnvelope = join(repo.harness, "workflows", workflowId, "sessions", `coordinator-${RECOVERY_PRIOR_SESSION}.json`);
    const priorBytes = readFileSync(priorEnvelope, "utf8");

    // The host reads the view first: the recorded owner and both reviewed tokens.
    const view = await harness.runCoordinatorTool({ operation: "show-recovery", workflowId });
    expect(view.isError).toBe(false);
    expect(view.details.ok).toBe(true);
    const details = view.details.mstarCoordinator as Record<string, unknown>;
    expect(details.priorSessionId).toBe(RECOVERY_PRIOR_SESSION);
    expect(details.allowed).toBe(true);
    expect(JSON.stringify(details)).not.toContain("sessions/");

    const recovered = await harness.runCoordinatorTool(recoveryToolParams(workflowId, details, RECOVERY_PRIOR_SESSION));
    expect(recovered.isError).toBe(false);
    const receipt = recovered.details.mstarCoordinator as Record<string, unknown>;
    expect(receipt).toMatchObject({
      workflowId,
      priorSessionId: RECOVERY_PRIOR_SESSION,
      sessionId: hostId,
      operationId: "op-host-recover-1",
      replay: false,
    });
    // §3.3: the coordinator envelope path is coordinator-owned transport, and a
    // model-visible tool result is not that transport — neither the details nor
    // the text names the new or the prior envelope.
    expect(receipt.sessionFile).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain("sessions/");
    expect(String(recovered.content[0]?.text)).not.toContain("sessions/");

    // The engine's own state: the binding moved to THIS host session, the new
    // envelope is the role-scoped one, and the prior envelope is retained.
    expect(recordedCoordinatorOfWorkflow(repo, workflowId).session_id).toBe(hostId);
    const newEnvelope = join(repo.harness, "workflows", workflowId, "sessions", `coordinator-${hostId}.json`);
    // The engine stores the CANONICAL path (macOS tmpdirs resolve through
    // /private), so the assertion is on the path contract, not on the spelling.
    const recordedFile = String(recordedCoordinatorOfWorkflow(repo, workflowId).session_file);
    expect(recordedFile.endsWith(`/sessions/coordinator-${hostId}.json`)).toBe(true);
    expect(existsSync(newEnvelope)).toBe(true);
    expect(JSON.parse(readFileSync(newEnvelope, "utf8"))).toMatchObject({ role: "coordinator", session_id: hostId });
    expect(readFileSync(priorEnvelope, "utf8")).toBe(priorBytes);

    const audit = recoveryAuditOfWorkflow(repo, workflowId);
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
      operation_id: "op-host-recover-1",
      prior_session_id: RECOVERY_PRIOR_SESSION,
      session_id: hostId,
      stopped_session_ids: [RECOVERY_PRIOR_SESSION],
      snapshot_version_before: details.snapshotVersion,
      compass_version: details.compassVersion,
    });

    // An exact retry is a stable receipt: the host learns it already holds the
    // binding instead of re-running the write.
    const committedBytes = readFileSync(snapshotPath, "utf8");
    const retry = await harness.runCoordinatorTool(recoveryToolParams(workflowId, details, RECOVERY_PRIOR_SESSION));
    expect(retry.isError).toBe(false);
    expect((retry.details.mstarCoordinator as Record<string, unknown>).replay).toBe(true);
    expect(readFileSync(snapshotPath, "utf8")).toBe(committedBytes);
    expect(recoveryAuditOfWorkflow(repo, workflowId)).toHaveLength(1);
  }, 90000);

  test("prepare coordinator recovery refuses forged, unstoppable and identity-less calls without writing", async () => {
    const repo = buildControlRepo();
    const workflowId = "fixture-recovery-guard-iteration";
    createRecoverableWorkflow(repo, workflowId, RECOVERY_PRIOR_SESSION);
    setArtifactStore(createFsStore(repo.harness));
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const hostId = harness.sessionManager.getSessionId();
    const snapshotPath = join(repo.harness, "workflows", workflowId, "snapshot.json");
    const before = readFileSync(snapshotPath, "utf8");
    const view = await harness.runCoordinatorTool({ operation: "show-recovery", workflowId });
    const details = view.details.mstarCoordinator as Record<string, unknown>;

    // The registered schema owns the union: an identity-shaped field is refused
    // by the schema AND by the raw handler's own boundary.
    for (const forged of [
      { ...recoveryToolParams(workflowId, details, RECOVERY_PRIOR_SESSION), sessionId: hostId },
      { ...recoveryToolParams(workflowId, details, RECOVERY_PRIOR_SESSION), priorSessionPath: "/tmp/creds.json" },
      { ...recoveryToolParams(workflowId, details, RECOVERY_PRIOR_SESSION), harnessRoot: "/elsewhere/.mstar" },
      { ...recoveryToolParams(workflowId, details, RECOVERY_PRIOR_SESSION), force: true },
    ]) {
      expect({ forged, valid: harness.validateCoordinator(forged).success }).toEqual({ forged, valid: false });
      const raw = await harness.runRawCoordinatorTool(forged);
      expect({ forged, code: coordinatorCodeOf(raw) }).toEqual({ forged, code: "forbidden-field" });
    }

    // A request that omits a reviewed token is not recoverable at all: the
    // registered schema refuses it and so does the raw handler.
    const incomplete = {
      operation: "recover",
      workflowId,
      operationId: "op-host-recover-x",
      reason: "r",
      authorizationRef: "a",
      stoppedSessionIds: [RECOVERY_PRIOR_SESSION],
    };
    expect(harness.validateCoordinator(incomplete).success).toBe(false);
    expect(coordinatorCodeOf(await harness.runRawCoordinatorTool(incomplete))).toBe("invalid-input");

    // A stop assertion that does not name the recorded holder is not proof: the
    // ENGINE refuses it (the host forwards the assertion verbatim, so the guard
    // is the one evaluated against the binding under the snapshot lock).
    const unstoppable = await harness.runCoordinatorTool(
      recoveryToolParams(workflowId, details, RECOVERY_PRIOR_SESSION, {
        operationId: "op-host-recover-2",
        stoppedSessionIds: ["some-other-session"],
      }),
    );
    expect(coordinatorCodeOf(unstoppable)).toBe("coordination.identity-recovery.unauthorized");

    // A refusal through the engine keeps the engine's own code (a stale token is
    // not a re-derivable identity and never becomes a success).
    const stale = await harness.runCoordinatorTool(
      recoveryToolParams(workflowId, details, RECOVERY_PRIOR_SESSION, {
        operationId: "op-host-recover-3",
        expectedSnapshotVersion: `sha256:${"0".repeat(64)}`,
      }),
    );
    expect(coordinatorCodeOf(stale)).toBe("coordination.identity-recovery.stale");

    // Leaf and identity-less host sessions cannot recover anything.
    const taskSession = newSession(repo.main);
    taskSession.appendSessionInit({ systemPrompt: "task", task: "scout", tools: ["read"], agent: "scout" });
    const taskHarness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: taskSession,
      mode: "json",
    });
    expect(coordinatorCodeOf(await taskHarness.runCoordinatorTool(recoveryToolParams(workflowId, details, RECOVERY_PRIOR_SESSION)))).toBe("leaf-session");

    const idless = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: newSession(repo.main) });
    const manager = idless.sessionManager as unknown as { getSessionId: () => string };
    const realGetSessionId = manager.getSessionId;
    manager.getSessionId = () => "";
    try {
      expect(coordinatorCodeOf(await idless.runCoordinatorTool(recoveryToolParams(workflowId, details, RECOVERY_PRIOR_SESSION)))).toBe("identity-missing");
    } finally {
      manager.getSessionId = realGetSessionId;
    }

    // Nothing above moved the workflow or created an envelope.
    expect(readFileSync(snapshotPath, "utf8")).toBe(before);
    expect(existsSync(join(repo.harness, "workflows", workflowId, "sessions", `coordinator-${hostId}.json`))).toBe(false);
    expect((await harness.runCoordinatorTool({ operation: "show-recovery", workflowId })).details.mstarCoordinator).toMatchObject({
      priorSessionId: RECOVERY_PRIOR_SESSION,
      allowed: true,
    });
  }, 120000);

  test("a foreign-owner refusal never names the envelope path in the model-visible tool result", async () => {
    const repo = buildControlRepo();
    const workflowId = "fixture-recovery-foreign-iteration";
    createRecoverableWorkflow(repo, workflowId, RECOVERY_PRIOR_SESSION);
    setArtifactStore(createFsStore(repo.harness));
    // The recorded holder's envelope is replaced by one that is not the
    // coordinator seat. It still exists and still names the recorded session id,
    // so the engine refuses it as `foreign-owner` rather than as a missing file —
    // the refusal path whose message once interpolated both envelope paths.
    const priorEnvelope = join(repo.harness, "workflows", workflowId, "sessions", `coordinator-${RECOVERY_PRIOR_SESSION}.json`);
    writeJson(priorEnvelope, {
      schema_version: 1,
      role: "plan-pm",
      plan_id: "some-plan",
      session_id: RECOVERY_PRIOR_SESSION,
      workflow_id: workflowId,
      harness_root: repo.harness,
    });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const snapshotPath = join(repo.harness, "workflows", workflowId, "snapshot.json");
    const before = readFileSync(snapshotPath, "utf8");
    const view = await harness.runCoordinatorTool({ operation: "show-recovery", workflowId });
    const details = view.details.mstarCoordinator as Record<string, unknown>;

    const refused = await harness.runCoordinatorTool(recoveryToolParams(workflowId, details, RECOVERY_PRIOR_SESSION));
    expect(coordinatorCodeOf(refused)).toBe("coordination.identity-recovery.foreign-owner");
    // §3.3: no envelope path — and no rejected caller value — in the tool text
    // or the details. The already-public workflow and recorded session ids name
    // the binding the caller failed to authenticate.
    expect(String(refused.content[0]?.text)).not.toContain("sessions/");
    expect(JSON.stringify(refused.details)).not.toContain("sessions/");
    expect(readFileSync(snapshotPath, "utf8")).toBe(before);
  }, 120000);
});

/* ------------------------------------------------------------------------ *
 * The ACTIVE route (§6): the host adapter takes its start authority from the
 * DB workflow/coordinator view, carries the adopted binding in the durable
 * handoff record, and keeps the pre-activation FILE arm distinct.
 * ------------------------------------------------------------------------ */

type ActiveHandoffState = Readonly<{
  planId: string;
  /** The DB's own coordinator seat of the seeded workflow. */
  coordinator: ExecutionSessionRef;
  workflowId: string;
  reviews: readonly Readonly<{ role: string; agentId: string; resultRef: string; reportPath: string }>[];
  plans: readonly Readonly<{ planId: string; planPath: string; prepareEvidencePath: string }>[];
}>;

/** The scoped Assignment header block `parseAssignmentFile` accepts. */
function activeAssignmentText(input: {
  harness: string;
  workflowId: string;
  planId: string;
  planPath: string;
  worktreePath: string;
  sddDir: string;
  branch: string;
}): string {
  return [
    `# Assignment — ${input.planId} independent slice`,
    "",
    `**Control harness root**: ${input.harness}`,
    `**Workflow id**: ${input.workflowId}`,
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
    "Prepared plan for the ACTIVE-route handoff fixtures.",
    "",
  ].join("\n");
}

/** A canonical plain copy of an engine-returned session reference. */
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

/**
 * A REAL active execution authority on the fixture repo: the store upgraded to
 * an execution authority, the plan registered in the catalog, one running
 * workflow with its branch anchors, compass reference, integration checkout and
 * plan row, the coordinator bound under `coordinatorSessionId`, the plan
 * PREPARED from a real Assignment, and the real artifact/Git witnesses the
 * readiness checkpoint samples. No root register and no workflow snapshot exist
 * anywhere on this route.
 */
async function seedActiveHandoffAuthority(
  repo: ControlRepo,
  coordinatorSessionId: string,
  workflowId = "active-iteration",
): Promise<ActiveHandoffState> {
  const planId = `${workflowId}-plan`;
  const harness = repo.harness;
  const plansDir = join(harness, "plans");
  const sddDir = join(harness, "sdd", planId);
  const iterationDir = join(harness, "iterations", workflowId);
  const guidesDir = join(iterationDir, "guides");
  for (const dir of [plansDir, sddDir, guidesDir]) mkdirSync(dir, { recursive: true });
  const planPath = join(plansDir, `${planId}.md`);
  writeFileSync(planPath, `# ${planId}\n\n**plan_id:** ${planId}\n\nPlan body.\n`);
  const prepareEvidencePath = join(guidesDir, `${planId}-prepare.md`);
  writeFileSync(prepareEvidencePath, `# Prepare evidence — ${planId}\n`);
  const reportPaths = SPECIALISTS.map((role) => join(guidesDir, `${role}-return.md`));
  reportPaths.forEach((path, index) => writeFileSync(path, `returned payload — ${SPECIALISTS[index]}\n`));
  const planWorktree = join(repo.root, `${workflowId}-plan-worktree`);
  git(["worktree", "add", "-q", "-b", `feature/${planId}`, planWorktree], repo.main);
  const assignmentPath = join(sddDir, "assignment.md");
  writeFileSync(
    assignmentPath,
    activeAssignmentText({
      harness,
      workflowId,
      planId,
      planPath,
      worktreePath: planWorktree,
      sddDir,
      branch: `feature/${planId}`,
    }),
  );
  writeFileSync(
    join(iterationDir, "delivery-compass.md"),
    [
      "---",
      `iteration_id: ${workflowId}`,
      "start_date: 2026-09-16",
      "status: locked",
      "iteration_base_branch: main",
      `spec_integration_branch: ${repo.integrationBranch}`,
      "target_branch: main",
      `integration_worktree_path: ${repo.integration}`,
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
  const initialized = await initializeExecutionAuthority({ harnessDir: harness });
  await registerCatalogEntity(
    { harnessDir: harness },
    { kind: "plan", id: planId, title: planId, rootKind: "plans", relativePath: `plans/${planId}.md` },
    { operationId: `register-${planId}`, actor: "model-handoff-extension.test" },
  );
  const context: ExecutionContext = {
    harnessDir: harness,
    caller: { sessionId: coordinatorSessionId, role: "coordinator", workflowId, planId: null } satisfies ExecutionCaller,
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
      branch: { base: "main", integration: repo.integrationBranch, target: "main" },
      integration_worktree_path: repo.integration,
      plans: [{ id: planId, title: planId, file: `plans/${planId}.md`, status: "Todo" }],
    } as never,
    expected: initialized.token,
    operationId: `create-${workflowId}`,
  });
  const bound = await bindExecutionSession(context, {
    workflowId,
    planId: null,
    role: "coordinator",
    expected: (await readExecutionAuthority({ harnessDir: harness }, { workflowId })).token,
    operationId: `bind-${coordinatorSessionId}`,
  });
  await mutateExecutionPlan(context, {
    operationId: `prepare-${planId}`,
    session: plainRef(bound.data),
    expected: (await readExecutionAuthority({ harnessDir: harness }, { workflowId, planId })).token,
    planId,
    operation: { kind: "prepare", assignmentPath } as never,
  });
  return {
    planId,
    coordinator: plainRef(bound.data),
    workflowId,
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
}

/** The completion checkpoint of one ACTIVE-route binding: no envelope path. */
function activeCompletionParams(state: ActiveHandoffState): ToolParams {
  return {
    operation: "phase1-complete",
    workflowId: state.workflowId,
    mainWorktreeBranch: "main",
    reviews: state.reviews,
    plans: state.plans,
  };
}

describe("model handoff on the ACTIVE route", () => {
  test("the arm adopts the DB coordinator binding, records it, and the target fires from the DB readiness", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const state = await seedActiveHandoffAuthority(repo, session.getSessionId());

    const armed = await harness.runTool(startParams(state.workflowId));
    expect(codeOf(armed)).toBe("armed");
    expect(stateOf(armed)).toBe("pending");
    expect(harness.attempts).toEqual(["probe/slow-model"]);
    expect(statesOf(harness)).toEqual(["attempting", "pending"]);

    // The durable record carries the adopted DB binding, not a file address.
    const record = harness.records()[0]!;
    const adopted = record.binding.executionBinding;
    expect(adopted).toBeDefined();
    expect(adopted?.harnessRoot).toBe(realpathSync(repo.harness));
    expect(adopted?.session).toEqual({
      storeId: state.coordinator.storeId,
      epoch: state.coordinator.epoch,
      workflowId: state.workflowId,
      role: "coordinator",
      sessionId: session.getSessionId(),
      planId: null,
    });
    expect(Object.getPrototypeOf(adopted?.session)).toBe(Object.prototype);

    // The completion checkpoint runs the ACTIVE readiness arm: no envelope path
    // is accepted or required, and the DB views plus the real witnesses fire the
    // one-shot switch.
    const fired = await harness.runTool(activeCompletionParams(state));
    expect(codeOf(fired)).toBe("handed_off");
    expect(statesOf(harness)).toEqual(["attempting", "pending", "attempting", "handed_off"]);
    expect(harness.liveSpec()).toBe("probe/default-model");
    expect(fired.details.mstarModelHandoff?.integrationHead).toBe(git(["rev-parse", "HEAD"], repo.integration));
  }, 120_000);

  test("the retired register and snapshot never decide an ACTIVE-route start (S3 order)", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const state = await seedActiveHandoffAuthority(repo, session.getSessionId());

    // The retired file evidence a route-blind classifier would have used: the
    // register names a DIFFERENT workflow (so the file arm's classifier says
    // `reserve`) while a leftover snapshot for THIS workflow sits at its derived
    // path (so the file arm's reservation would refuse `already-bound`). The
    // ACTIVE route must consult neither: it asks the engine's route first and
    // then answers from the DB workflow/coordinator view.
    writeRegister(repo.harness, ["legacy-sibling-iteration"]);
    mkdirSync(join(repo.harness, "workflows", state.workflowId), { recursive: true });
    writeJson(join(repo.harness, "workflows", state.workflowId, "snapshot.json"), {
      schema_version: 1,
      id: state.workflowId,
      type: "iteration",
      status: "running",
      phase: "phase-1-prepare",
      started_at: "2026-09-16",
      updated_at: "2026-09-16T00:00:00.000Z",
      plans: [],
    });

    const armed = await harness.runTool(startParams(state.workflowId));
    expect(codeOf(armed)).toBe("armed");
    expect(harness.attempts).toEqual(["probe/slow-model"]);
    expect(harness.records()[0]?.binding.executionBinding?.session).toMatchObject({
      workflowId: state.workflowId,
      sessionId: session.getSessionId(),
      role: "coordinator",
      planId: null,
    });
  }, 120_000);

  test("a session that is not the workflow's DB coordinator refuses the start without any model action", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    // A real workflow whose seat is another coordinator session.
    const state = await seedActiveHandoffAuthority(repo, "creator-session");

    const refused = await harness.runTool(startParams(state.workflowId));
    expect(codeOf(refused)).toBe("coordinator-elsewhere");
    expect(harness.attempts).toHaveLength(0);
    expect(harness.records()).toHaveLength(0);
    expect(harness.notices().some((line) => line.includes("coordinator-elsewhere"))).toBe(true);
  }, 120_000);

  test("a lifecycle the authority does not hold refuses instead of reserving an unregistered id", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const store = await initializeStore({ harnessDir: repo.harness });
    store.close();
    await initializeExecutionAuthority({ harnessDir: repo.harness });

    const refused = await harness.runTool(startParams("absent-iteration"));
    expect(codeOf(refused)).toBe("register-invalid");
    expect(harness.attempts).toHaveLength(0);
    expect(harness.records()).toHaveLength(0);
  }, 120_000);

  test("a durable FILE record on an ACTIVE root never fires from the retired route", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    // The authority governs the root first; the FILE arm's own artifacts are
    // planted afterwards, so a verdict derived from them would be a live
    // fallback — the checkpoint must refuse instead.
    const store = await initializeStore({ harnessDir: repo.harness });
    store.close();
    await initializeExecutionAuthority({ harnessDir: repo.harness });
    const artifacts = createWorkflowArtifacts(repo, session.getSessionId(), "legacy-iteration");

    // A pending binding as the pre-activation generation wrote it.
    const baselineModelChangeId = session.appendModelChange("probe/slow-model", "default");
    session.appendCustomEntry(HANDOFF_CUSTOM_TYPE, {
      version: 1,
      binding: {
        sessionId: session.getSessionId(),
        workflowId: "legacy-iteration",
        controlRoot: repo.main,
        harnessRoot: repo.harness,
        snapshotPath: join(repo.harness, "workflows", "legacy-iteration", "snapshot.json"),
        compassPath: join(repo.harness, "iterations", "legacy-iteration", "delivery-compass.md"),
      },
      state: "pending",
      operationId: "arm-legacy-fixture",
      action: "arm",
      baselineModelChangeId,
      observedModel: "probe/slow-model",
      reason: null,
    } satisfies HandoffRecord);

    const fired = await harness.runTool(completionParams(artifacts));
    expect(codeOf(fired)).toBe("not-ready");
    expect(fired.details.mstarModelHandoff?.codes).toEqual(["execution.consumer-not-ready"]);
    expect(harness.attempts).toHaveLength(0);
    expect(statesOf(harness)).toEqual(["pending"]);
    expect(harness.liveSpec()).toBe("probe/default-model");
  }, 120_000);
});
