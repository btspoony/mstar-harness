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
import { DatabaseSync } from "node:sqlite";
import type { ExtensionActions, ExtensionContext, ExtensionContextActions, ExtensionMode, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
  ExtensionRunner,
  RegisteredToolAdapter,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
// The live host validates a registered tool's arguments with
// `validateToolArguments` (pi-agent-core `agent-loop.ts`) BEFORE
// `RegisteredToolAdapter.execute`; the raw schema's `.parse` alone is not the
// registered boundary. `pi-coding-agent` re-exports pi-ai's validator through its
// legacy-pi-ai shim, resolvable here without adding a dependency.
import { validateToolArguments as validateHostToolArguments } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
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
  initializeStore,
  mutateExecutionPlan,
  readExecutionAuthority,
  registerCatalogEntity,
  readExecutionState,
  setArtifactStore,
} from "@mstar-harness/engine";
import type { ExecutionCaller, ExecutionContext, ExecutionSessionRef } from "@mstar-harness/engine";

/* --------------------------------------------------------------- scratch --- */

const SCRATCH: string[] = [];
/** The module resolves the harness through the engine's documented precedence. */
const HARNESS_ENV = process.env.MSTAR_HARNESS_DIR;
/** The readiness step is only ever held open; the real checkpoint still runs. */
const REAL_INSPECT_READINESS = handoffSeams.inspectReadiness;
/** The fire path's decision preference read; a probe may hold this step open. */
const REAL_DECISION_PREFERENCE_READ = handoffSeams.decisionPreferenceRead;

beforeAll(() => {
  delete process.env.MSTAR_HARNESS_DIR;
});
afterAll(() => {
  handoffSeams.inspectReadiness = REAL_INSPECT_READINESS;
  handoffSeams.decisionPreferenceRead = REAL_DECISION_PREFERENCE_READ;
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
    // The host's own registered-tool call order: normalize+validate the arguments
    // against the registered schema (`validateToolArguments`), then forward the
    // normalized object to `RegisteredToolAdapter.execute`. Validation is the real
    // gate — a schema-level refusal is not the handler's aggregated refusal.
    const validated = validateHostToolArguments(registeredTool.definition as never, {
      type: "toolCall",
      id: "fixture-tool-call",
      name: registeredTool.definition.name,
      arguments: params,
    });
    return (await adapter.execute("fixture-tool-call", validated, undefined, undefined)) as ToolResult;
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
      const validated = validateHostToolArguments(coordinatorTool.definition as never, {
        type: "toolCall",
        id: "fixture-coordinator-call",
        name: coordinatorTool.definition.name,
        arguments: params,
      });
      return (await coordinatorAdapter.execute(
        "fixture-coordinator-call",
        validated,
        undefined,
        undefined,
      )) as ToolResult;
    },
    validateCoordinator: (params: ToolParams) => {
      const parsed = coordinatorTool.definition.parameters.safeParse(params);
      return parsed.success ? { success: true } : { success: false, message: parsed.error?.message ?? "" };
    },
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

function completionParams(artifacts: Artifacts, reviews = artifacts.reviews): ToolParams {
  return {
    operation: "phase1-complete",
    workflowId: artifacts.workflowId,
    coordinatorSessionPath: artifacts.coordinatorSessionPath,
    mainWorktreeBranch: artifacts.mainWorktreeBranch,
    reviews,
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
  test("new coordinator start only: ordinary chat, unrelated commands and task sessions and mid-flight enable cause no model action", async () => {
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
    // None of these entries starts an iteration, so none creates a reservation.
    expect(JSON.parse(readFileSync(join(repo.harness, "status.json"), "utf8"))).toEqual(JSON.parse(before.register));
    expect(readdirSync(join(repo.harness, "workflows")).sort()).toEqual(before.workflows);
    expect(readdirSync(join(repo.harness, "iterations")).sort()).toEqual(before.iterations);

    // Mid-flight enable: turning the native preference on does not retro-arm and
    // does not start observing anything.
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    await harness.emitInput("continue", "interactive");
    expect(harness.records()).toHaveLength(0);
    expect(harness.attempts).toHaveLength(0);

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
    expect(codeOf(refused)).toBe("task-session");
    expect(refused.isError).toBe(true);
    expect(taskHarness.records()).toHaveLength(0);
    expect(taskHarness.attempts).toHaveLength(0);
    expect(taskHarness.notices().some((line) => line.includes("task-session"))).toBe(true);

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


});

describe("preference off is a neutral no-op", () => {
  test("disabled start and unbound fire leave the model and ledger unchanged", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: false, handoffTarget: "@smol" });
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: newSession(repo.main) });
    const start = await harness.runTool(startParams("disabled-iteration"));
    const fire = await harness.runTool({ operation: "phase1-complete", workflowId: "disabled-iteration" });
    for (const result of [start, fire]) {
      expect(codeOf(result)).toBe("preference-off");
      expect(result.isError).toBe(false);
      expect(result.details.ok).toBe(true);
    }
    expect(harness.liveSpec()).toBe("probe/default-model");
    expect(harness.attempts).toEqual([]);
    expect(harness.records()).toEqual([]);
    expect(harness.notices()).toEqual([
      "Model handoff preference off: modelHandoff is off in native settings; no model action was taken.",
      "Model handoff preference off: modelHandoff is off in native settings; no model action was taken.",
    ]);
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


/* ------------------------------------------------ registered coordinator --- */


function coordinatorCodeOf(result: ToolResult): string {
  return String(result.details.mstarCoordinator?.code ?? "");
}



/** Plain-object narrowing for the fixture JSON (no inline cast at member access). */
function isPlainFixtureRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


/* ------------------------------------------------------- native ACTIVE handler --- */

/**
 * A REAL active execution authority whose workflow is created by
 * `creatorSessionId` and holds NO coordinator row — the state an ordinary
 * minimal bind addresses. No root register and no workflow snapshot exist on
 * this route. The returned token is the lifecycle's CURRENT token at this
 * moment: once a later operation advances the header revision it is exactly the
 * stale CAS value a supplied-controls retry carries.
 */
async function seedBindableActiveWorkflow(
  repo: ControlRepo,
  creatorSessionId: string,
  workflowId: string,
): Promise<string> {
  const harness = repo.harness;
  mkdirSync(join(harness, "plans"), { recursive: true });
  setArtifactStore(createFsStore(harness));
  const store = await initializeStore({ harnessDir: harness });
  store.close();
  const initialized = await readExecutionState({ harnessDir: harness });
  const context: ExecutionContext = {
    harnessDir: harness,
    caller: { sessionId: creatorSessionId, role: "coordinator", workflowId } satisfies ExecutionCaller,
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
      plans: [],
    } as never,
    expected: initialized.token,
    operationId: `create-${workflowId}`,
  });
  return (await readExecutionAuthority({ harnessDir: harness }, { workflowId })).token;
}

/**
 * A valid operator `ActivationAttestation` for one recovery: it attests the
 * current coordinator consumer and names exactly the stopped prior holder —
 * never the replacement session that performs the recovery.
 */
function activationAttestation(
  priorSessionId: string,
  stoppedSessions: readonly Readonly<{ sessionId: string; host: string; state: "stopped" | "reloaded" }> = [
    { sessionId: priorSessionId, host: "fixture-host", state: "stopped" },
  ],
): Record<string, unknown> {
  return {
    version: 1,
    attestedAt: "2026-09-16T00:00:00.000Z",
    operator: { actor: "fixture-operator", authorizationRef: "fixture-authorization-1" },
    consumers: [
      {
        entryId: "omp-model-handoff",
        kind: "coordinator",
        entrypoint: "extensions/model-handoff.js",
        runtime: "bun",
        runtimeVersion: "1.4.0",
        version: "3.11.2",
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions: [...stoppedSessions],
  };
}

/** The DB coordinator seat of one workflow, read through the engine's own authority. */
async function activeCoordinatorOf(repo: ControlRepo, workflowId: string): Promise<string | null> {
  const read = await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId });
  const workflow = "workflows" in read.data ? read.data.workflows[0] : undefined;
  return workflow?.coordinator?.sessionId ?? null;
}

/**
 * The number of ACCEPTED execution operations the store records, read through
 * the engine's own database (`store.db` beside the harness root). A refusal must
 * never append here: a failed engine verb leaves no success receipt, and a
 * replay restores the already-recorded receipt instead of committing a second.
 */
function executionOperationCount(repo: ControlRepo): number {
  const db = new DatabaseSync(join(repo.harness, "store.db"), { readOnly: true });
  try {
    const row = db.prepare("select count(*) as n from execution_operations").get() as { n?: unknown } | undefined;
    return typeof row?.n === "number" ? row.n : 0;
  } finally {
    db.close();
  }
}

describe("native coordinator tool on the ACTIVE route", () => {
  test("the registered handler performs an ordinary minimal bind and keeps exactly one owner", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const hostId = harness.sessionManager.getSessionId();
    const workflowId = "native-bind-iteration";
    await seedBindableActiveWorkflow(repo, hostId, workflowId);

    // The registered schema accepts the minimal pair, and the handler binds
    // through the DB verb with the controls it derived itself.
    expect(harness.validateCoordinator({ operation: "bind", workflowId }).success).toBe(true);
    const bound = await harness.runCoordinatorTool({ operation: "bind", workflowId });
    expect(bound.isError).toBe(false);
    expect(bound.details.mstarCoordinator).toMatchObject({
      workflowId,
      sessionId: hostId,
      role: "coordinator",
      replayed: false,
    });
    // §3.3: the coordinator envelope path is coordinator-owned transport, so this
    // model-visible tool result carries neither the path nor the derived token.
    expect(JSON.stringify(bound.details)).not.toContain("sessions/");
    expect(String(bound.content[0]?.text)).not.toContain("sessions/");
    expect(await activeCoordinatorOf(repo, workflowId)).toBe(hostId);

    // A second bind is the ENGINE's own ownership refusal — with the recorded
    // holder and its structured recovery problem preserved — and nothing moves.
    const again = await harness.runCoordinatorTool({ operation: "bind", workflowId });
    expect(again.isError).toBe(true);
    expect(coordinatorCodeOf(again)).toBe("execution.session-unavailable");
    const refusal = again.details.mstarCoordinator as Record<string, unknown>;
    expect(refusal.holder).toBe(hostId);
    expect(Array.isArray(refusal.available_work)).toBe(true);
    expect(typeof refusal.loadedEntry).toBe("string");
    expect(await activeCoordinatorOf(repo, workflowId)).toBe(hostId);
  }, 120_000);

  test("a stale supplied CAS and a wrong-holder stop proof are refused through the registered handler without moving the owner", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const hostId = harness.sessionManager.getSessionId();
    const workflowId = "native-stale-iteration";
    const createdToken = await seedBindableActiveWorkflow(repo, hostId, workflowId);

    // A supplied-but-stale CAS is not permission to pick a route or an identity:
    // the engine re-checks the token inside its own write transaction and refuses.
    // The successful bind in between is what makes `createdToken` stale.
    expect((await harness.runCoordinatorTool({ operation: "bind", workflowId })).isError).toBe(false);
    const afterBind = await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId });
    const ownerBefore = await activeCoordinatorOf(repo, workflowId);
    expect(ownerBefore).toBe(hostId);

    const stale = await harness.runCoordinatorTool({
      operation: "bind",
      workflowId,
      expected: createdToken,
      operationId: "native-stale-op-1",
    });
    expect(stale.isError).toBe(true);
    expect(coordinatorCodeOf(stale)).toBe("execution.stale-token");
    expect(await activeCoordinatorOf(repo, workflowId)).toBe(ownerBefore);
    expect((await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId })).epoch).toBe(afterBind.epoch);

    // A recovery whose stop evidence names a DIFFERENT session than the recorded
    // holder is refused: the host forwards the assertion verbatim and the engine's
    // own guard rejects it against the binding it reads inside the transaction.
    const wrongHolder = await harness.runCoordinatorTool({
      operation: "recover",
      workflowId,
      priorSessionId: "some-other-session",
      reason: "the recorded host session was stopped",
      attestation: activationAttestation("some-other-session"),
    });
    expect(wrongHolder.isError).toBe(true);
    // The engine refuses a named holder the workflow does not record; the exact
    // stable code is the engine's own coordination vocabulary.
    expect(coordinatorCodeOf(wrongHolder)).toBe("coordination.session-not-found");
    expect(await activeCoordinatorOf(repo, workflowId)).toBe(ownerBefore);

    // An unusable stop proof is refused BEFORE any authority IO, and the owner and
    // header revision are untouched by every refusal above.
    const unproven = await harness.runCoordinatorTool({
      operation: "recover",
      workflowId,
      priorSessionId: hostId,
      reason: "",
      attestation: activationAttestation(hostId),
    });
    expect(unproven.isError).toBe(true);
    expect(coordinatorCodeOf(unproven)).toBe("invalid-input");
    const afterAllRefusals = await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId });
    expect(afterAllRefusals.token).toBe(afterBind.token);
    expect(await activeCoordinatorOf(repo, workflowId)).toBe(ownerBefore);
  }, 120_000);

  test("a malformed and a stop-evidence-free recovery reach the real engine refusal with the owner and header intact", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const hostId = harness.sessionManager.getSessionId();
    const workflowId = "native-proof-iteration";
    await seedBindableActiveWorkflow(repo, hostId, workflowId);
    expect((await harness.runCoordinatorTool({ operation: "bind", workflowId })).isError).toBe(false);
    const afterBind = await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId });
    const ownerBefore = await activeCoordinatorOf(repo, workflowId);
    const operationsBefore = executionOperationCount(repo);

    // A malformed operator document is not proof: the host forwards the object
    // UNTOUCHED and the engine's own `validateActivationAttestation` refuses it
    // BEFORE its write transaction. The reason here is non-empty and the holder
    // is the real recorded owner, so only the document is defective.
    const malformed = await harness.runCoordinatorTool({
      operation: "recover",
      workflowId,
      priorSessionId: hostId,
      reason: "the recorded host session was stopped",
      attestation: { version: 1 },
    });
    expect(malformed.isError).toBe(true);
    expect(coordinatorCodeOf(malformed)).toBe("store.attestation-invalid");

    // A well-formed attestation that omits stop evidence for the REAL recorded
    // holder is refused INSIDE the transaction: the engine cannot observe a dead
    // process, so a named holder nobody attested stopped is never replaced. This
    // is the actual recorded prior holder with a valid nonempty reason.
    const noStopEvidence = await harness.runCoordinatorTool({
      operation: "recover",
      workflowId,
      priorSessionId: hostId,
      reason: "the recorded host session was stopped",
      attestation: activationAttestation(hostId, []),
    });
    expect(noStopEvidence.isError).toBe(true);
    expect(coordinatorCodeOf(noStopEvidence)).toBe("coordination.invalid-transition");

    // Both refusals left the owner, the header revision and the accepted-operation
    // log exactly as the successful bind left them: a refusal writes no receipt.
    const after = await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId });
    expect(after.token).toBe(afterBind.token);
    expect(after.epoch).toBe(afterBind.epoch);
    expect(await activeCoordinatorOf(repo, workflowId)).toBe(ownerBefore);
    expect(executionOperationCount(repo)).toBe(operationsBefore);
  }, 120_000);

  test("an identical accepted recovery retry is the recorded replay and never a second commit", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const hostId = harness.sessionManager.getSessionId();
    const workflowId = "native-replay-iteration";
    await seedActiveHandoffAuthority(repo, "recorded-owner", workflowId);

    // The SAME accepted operation, invoked twice with identical supplied controls
    // (the workflow token and an explicit operation id): the engine is the one
    // that recognises the retry, so the host never re-runs the write.
    const expected = (await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId })).token;
    const operationId = "native-replay-op-1";
    const request: Record<string, unknown> = {
      operation: "recover",
      workflowId,
      priorSessionId: "recorded-owner",
      reason: "the recorded host session was stopped",
      attestation: activationAttestation("recorded-owner"),
      expected,
      operationId,
    };

    const first = await harness.runCoordinatorTool(request);
    expect(first.isError).toBe(false);
    expect((first.details.mstarCoordinator as Record<string, unknown>).replayed).toBe(false);
    const ownerAfterFirst = await activeCoordinatorOf(repo, workflowId);
    expect(ownerAfterFirst).toBe(hostId);
    const headerAfterFirst = await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId });
    const operationsAfterFirst = executionOperationCount(repo);

    const retry = await harness.runCoordinatorTool(request);
    expect(retry.isError).toBe(false);
    expect((retry.details.mstarCoordinator as Record<string, unknown>).replayed).toBe(true);
    // The replay restored the RECORDED receipt: the owner, header and the accepted
    // operation log are byte-for-byte the state the first commit produced.
    expect(await activeCoordinatorOf(repo, workflowId)).toBe(ownerAfterFirst);
    expect((await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId })).token).toBe(headerAfterFirst.token);
    expect(executionOperationCount(repo)).toBe(operationsAfterFirst);
  }, 120_000);

  test("a supplied holder null and an absent holder reach the real engine distinctly", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const hostId = harness.sessionManager.getSessionId();
    const workflowId = "native-unowned-iteration";
    await seedBindableActiveWorkflow(repo, hostId, workflowId);

    // The workflow records NO coordinator yet (the seed created but never bound
    // it), so the explicit `null` holder is the documented unowned claim — and the
    // host forwards it UNTOUCHED through `validateToolArguments` → the adapter →
    // the handler. The real engine accepts it and binds THIS host as the
    // coordinator, proving a legal unowned recovery, not a schema-level rejection.
    const operationsBefore = executionOperationCount(repo);
    const unowned = await harness.runCoordinatorTool({
      operation: "recover",
      workflowId,
      priorSessionId: null,
      reason: "no coordinator was ever bound to this workflow",
      attestation: activationAttestation(hostId, []),
    });
    expect(unowned.isError).toBe(false);
    expect(await activeCoordinatorOf(repo, workflowId)).toBe(hostId);
    expect(executionOperationCount(repo)).toBe(operationsBefore + 1);

    // An ABSENT holder is a different request: the classifier reports the missing
    // semantic selector and nothing is written, so a null and an omission never
    // collapse into the same path.
    const secondRepo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const secondHarness = await createHarness({
      cwd: secondRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(secondRepo.main),
    });
    const secondHost = secondHarness.sessionManager.getSessionId();
    const absentWorkflow = "native-absent-iteration";
    await seedBindableActiveWorkflow(secondRepo, secondHost, absentWorkflow);
    const secondOperations = executionOperationCount(secondRepo);
    const absent = await secondHarness.runCoordinatorTool({
      operation: "recover",
      workflowId: absentWorkflow,
      reason: "no coordinator was ever bound to this workflow",
      attestation: activationAttestation(secondHost, []),
    });
    expect(absent.isError).toBe(true);
    expect(coordinatorCodeOf(absent)).toBe("invalid-input");
    expect((absent.details.mstarCoordinator as Record<string, unknown>).missing).toContain("priorSessionId");
    expect(await activeCoordinatorOf(secondRepo, absentWorkflow)).toBeNull();
    expect(executionOperationCount(secondRepo)).toBe(secondOperations);
  }, 120_000);

  test("one malformed-holder call names the forbidden, missing and invalid fields together", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const hostId = harness.sessionManager.getSessionId();
    const workflowId = "native-combined-iteration";
    await seedBindableActiveWorkflow(repo, hostId, workflowId);
    const operationsBefore = executionOperationCount(repo);

    // One call carrying all three classes: a forbidden identity key, an absent
    // required key and an unusable NAMED value — a malformed (wrong-typed) holder
    // that the JSON-value union now lets through to the classifier. The registered
    // gate (validateToolArguments → adapter → handler) reports every one of them in
    // a SINGLE refusal, so one repair is enough, and the request never mutates.
    const combined = await harness.runCoordinatorTool({
      operation: "recover",
      workflowId,
      priorSessionId: 7,
      sessionId: "attacker",
    });
    expect(coordinatorCodeOf(combined)).toBe("forbidden-field");
    expect(combined.details.mstarCoordinator).toMatchObject({
      form: "active",
      forbidden: ["sessionId"],
      missing: ["reason"],
      fields: ["priorSessionId"],
    });
    expect(await activeCoordinatorOf(repo, workflowId)).toBeNull();
    expect(executionOperationCount(repo)).toBe(operationsBefore);
  }, 120_000);

  test("show-recovery reads the ACTIVE authority through the registered handler", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const hostId = harness.sessionManager.getSessionId();
    const workflowId = "native-show-iteration";
    await seedBindableActiveWorkflow(repo, hostId, workflowId);
    expect((await harness.runCoordinatorTool({ operation: "bind", workflowId })).isError).toBe(false);

    const shown = await harness.runCoordinatorTool({ operation: "show-recovery", workflowId });
    expect(shown.isError).toBe(false);
    expect(shown.details.mstarCoordinator).toMatchObject({
      workflowId,
      status: "running",
      coordinatorSessionId: hostId,
    });
    expect(JSON.stringify(shown.details)).not.toContain("sessions/");
  }, 120_000);

  test("a minimal ACTIVE recovery replaces the recorded holder through the registered handler", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const hostId = harness.sessionManager.getSessionId();
    const state = await seedActiveHandoffAuthority(repo, "recorded-owner", "native-recovery-iteration");

    // The schema accepts the ACTIVE recovery shape, and the handler derives the
    // token and operation id itself: the operator supplies only the holder, the
    // reason and the attestation document.
    expect(
      harness.validateCoordinator({
        operation: "recover",
        workflowId: state.workflowId,
        priorSessionId: "recorded-owner",
        reason: "the recorded host session was stopped",
        attestation: activationAttestation("recorded-owner"),
      }).success,
    ).toBe(true);
    const recovered = await harness.runCoordinatorTool({
      operation: "recover",
      workflowId: state.workflowId,
      priorSessionId: "recorded-owner",
      reason: "the recorded host session was stopped",
      attestation: activationAttestation("recorded-owner"),
    });
    expect(recovered.isError).toBe(false);
    expect(recovered.details.mstarCoordinator).toMatchObject({
      workflowId: state.workflowId,
      priorSessionId: "recorded-owner",
      sessionId: hostId,
      replayed: false,
    });
    // The DB authority actually moved: the recorded holder was replaced by THIS
    // host session, and the replacement is audited as a distinct operation.
    expect(await activeCoordinatorOf(repo, state.workflowId)).toBe(hostId);
    const audited = recovered.details.mstarCoordinator as Record<string, unknown>;
    expect(typeof audited.operationId).toBe("string");
    expect(String(audited.operationId).length).toBeGreaterThan(0);
    expect(JSON.stringify(recovered.details)).not.toContain("sessions/");
  }, 120_000);

  test("a newer store schema surfaces the loaded build's own refusal and its running-module provenance", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const store = await initializeStore({ harnessDir: repo.harness });
    store.db.exec("insert into schema_version values(999, 'future', 'future', 'now')");
    store.close();

    // The route probe refuses with the engine's OWN code — never a masked Prepare
    // refusal or a fabricated success — and the provenance is the module the host
    // ACTUALLY loaded, reported by that module itself.
    const refused = await harness.runCoordinatorTool({ operation: "bind", workflowId: "native-schema-iteration" });
    expect(refused.isError).toBe(true);
    expect(coordinatorCodeOf(refused)).toBe("store.schema-unsupported");
    const details = refused.details.mstarCoordinator as Record<string, unknown>;
    // The consumer reads whatever structured facts the LOADED build supplies —
    // it never pins an engine message substring. B3 adds the concrete
    // highest-applied / supported-max / first-unknown fields to `StoreError.details`;
    // this seat asserts the code and the provenance now, and the integration wave
    // extends the same details read to those named facts once the engine emits them.
    expect(typeof details.loadedEntry).toBe("string");
    expect(String(details.loadedEntry)).toMatch(/\.(ts|js)$/);
    expect(JSON.stringify(details)).not.toContain("sessions/");
  }, 120_000);

  test("an identical bind retry with only an explicit operation id is the recorded replay (BUG-101)", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const hostId = harness.sessionManager.getSessionId();
    const workflowId = "native-bind-replay-iteration";
    await seedBindableActiveWorkflow(repo, hostId, workflowId);

    // The documented minimal lost-response recovery: the caller pins its OWN
    // operation id and nothing else. The engine resolves the workflow's current
    // token itself, so the first commit's revision advance never turns the
    // unchanged retry into `execution.operation-conflict`; freshness the caller
    // never supplied stays out of the request fingerprint.
    const request = { operation: "bind", workflowId, operationId: "native-bind-replay-op-1" };
    const first = await harness.runCoordinatorTool(request);
    expect(first.isError).toBe(false);
    const firstReceipt = first.details.mstarCoordinator as Record<string, unknown>;
    expect(firstReceipt).toMatchObject({ workflowId, sessionId: hostId, operationId: "native-bind-replay-op-1", replayed: false });
    const headerAfterFirst = await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId });
    const operationsAfterFirst = executionOperationCount(repo);

    const retry = await harness.runCoordinatorTool(request);
    expect(retry.isError).toBe(false);
    const replayed = retry.details.mstarCoordinator as Record<string, unknown>;
    expect(replayed.replayed).toBe(true);
    // The replay restored the RECORDED receipt: same owner, same session token
    // and the same single accepted-operation row.
    expect(replayed.sessionId).toBe(hostId);
    expect(replayed.epoch).toBe(firstReceipt.epoch);
    expect(replayed.storeId).toBe(firstReceipt.storeId);
    expect(await activeCoordinatorOf(repo, workflowId)).toBe(hostId);
    expect((await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId })).token).toBe(headerAfterFirst.token);
    expect(executionOperationCount(repo)).toBe(operationsAfterFirst);
  }, 120_000);

  test("the registered handler refuses a caller-supplied sentinel as a changed request (BUG-201)", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const hostId = harness.sessionManager.getSessionId();
    const workflowId = "native-bind-sentinel-iteration";
    await seedBindableActiveWorkflow(repo, hostId, workflowId);

    // The omitted bind commits under the caller's own operation id.
    const operationId = "native-bind-sentinel-op-1";
    const first = await harness.runCoordinatorTool({ operation: "bind", workflowId, operationId });
    expect(first.isError).toBe(false);
    const ownerAfterFirst = await activeCoordinatorOf(repo, workflowId);
    const headerAfterFirst = await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId });
    const operationsAfterFirst = executionOperationCount(repo);

    // The same operation id retried with the sentinel string `"current"` — the
    // value the old fingerprint used for an OMITTED freshness — is a CHANGED
    // request now: the omp shape gate forwards the non-empty string verbatim and
    // the engine refuses `execution.operation-conflict` instead of replaying.
    const sentinel = await harness.runCoordinatorTool({ operation: "bind", workflowId, expected: "current", operationId });
    expect(sentinel.isError).toBe(true);
    expect(coordinatorCodeOf(sentinel)).toBe("execution.operation-conflict");

    // A sentinel under a FRESH operation id carries no replay context, so the
    // malformed token reaches `parseExecutionToken` and refuses on the grammar.
    const malformed = await harness.runCoordinatorTool({
      operation: "bind",
      workflowId,
      expected: "current",
      operationId: "native-bind-sentinel-op-2",
    });
    expect(malformed.isError).toBe(true);
    expect(coordinatorCodeOf(malformed)).toBe("execution.token-invalid");

    // The omitted form still replays, and no refusal above moved the owner,
    // header or accepted-operation log.
    const replayed = await harness.runCoordinatorTool({ operation: "bind", workflowId, operationId });
    expect(replayed.isError).toBe(false);
    expect((replayed.details.mstarCoordinator as Record<string, unknown>).replayed).toBe(true);
    expect(await activeCoordinatorOf(repo, workflowId)).toBe(ownerAfterFirst);
    expect((await readExecutionAuthority({ harnessDir: repo.harness }, { workflowId })).token).toBe(headerAfterFirst.token);
    expect(executionOperationCount(repo)).toBe(operationsAfterFirst);
  }, 120_000);
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
 * A REAL active execution authority on the fixture repo: the store upgraded to
 * an execution authority, the plan registered in the catalog, one running
 * workflow with its branch anchors, compass reference, integration checkout and
 * plan row, the coordinator bound under `coordinatorSessionId`, the plan
 * configured through ordinary prepare, and the real artifact/Git witnesses the
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
  const initialized = await readExecutionState({ harnessDir: harness });
  await registerCatalogEntity(
    { harnessDir: harness },
    { kind: "plan", id: planId, title: planId, rootKind: "plans", relativePath: `plans/${planId}.md` },
    { operationId: `register-${planId}`, actor: "model-handoff-extension.test" },
  );
  const context: ExecutionContext = {
    harnessDir: harness,
    caller: { sessionId: coordinatorSessionId, role: "coordinator", workflowId } satisfies ExecutionCaller,
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
    role: "coordinator",
    expected: (await readExecutionAuthority({ harnessDir: harness }, { workflowId })).token,
    operationId: `bind-${coordinatorSessionId}`,
  });
  await mutateExecutionPlan(context, {
    operationId: `prepare-${planId}`,
    session: plainRef(bound.data),
    expected: (await readExecutionAuthority({ harnessDir: harness }, { workflowId, planId })).token,
    planId,
    operation: { kind: "prepare", config: { worktreePath: planWorktree, workingBranch: `feature/${planId}` } },
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
    expect(adopted?.session).toEqual(state.coordinator);
    expect(Object.getPrototypeOf(adopted?.session)).toBe(Object.prototype);

    // The completion checkpoint runs the ACTIVE readiness arm: no envelope path
    // is accepted or required, and the DB views plus the real witnesses fire the
    // one-shot switch.
    const fired = await harness.runTool(activeCompletionParams(state));
    expect(codeOf(fired)).toBe("handed_off");
    expect(statesOf(harness)).toEqual(["attempting", "pending", "attempting", "handed_off"]);
    expect(harness.liveSpec()).toBe("probe/default-model");
    expect(fired.details.mstarModelHandoff?.integrationHead).toBe(git(["rev-parse", "HEAD"], repo.integration));
    const switchesAfterHandoff = harness.switched.length;
    const duplicateFire = await harness.runTool(activeCompletionParams(state));
    expect(codeOf(duplicateFire)).toBe("not-pending");
    expect(harness.switched).toHaveLength(switchesAfterHandoff);


  }, 120_000);
  test("an interrupted ACTIVE handoff attempt resumes as uncertain without retrying", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const state = await seedActiveHandoffAuthority(repo, session.getSessionId());
    expect(codeOf(await harness.runTool(startParams(state.workflowId)))).toBe("armed");

    const pending = harness.records()[0]!;
    session.appendCustomEntry(HANDOFF_CUSTOM_TYPE, {
      ...pending,
      state: "attempting",
      operationId: "interrupted-active-fire",
      action: "handoff",
    } satisfies HandoffRecord);
    const resumed = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: session,
      initialModelId: "slow-model",
    });
    await resumed.emit({ type: "session_start" });
    expect(resumed.records().at(-1)).toMatchObject({ state: "uncertain", action: "handoff" });
    expect(resumed.records().at(-1)?.reason).toContain("no recorded outcome");
    expect(codeOf(await resumed.runTool(activeCompletionParams(state)))).toBe("not-pending");
    expect(resumed.attempts).toHaveLength(0);
    expect(resumed.switched).toHaveLength(0);
    expect(resumed.liveSpec()).toBe("probe/slow-model");
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
    const refused = await harness.runTool(startParams("absent-iteration"));
    expect(codeOf(refused)).toBe("register-invalid");
    expect(harness.attempts).toHaveLength(0);
    expect(harness.records()).toHaveLength(0);
  }, 120_000);
  test("ACTIVE fire re-reads preference and refuses incomplete readiness without switching", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const state = await seedActiveHandoffAuthority(repo, session.getSessionId());
    expect(codeOf(await harness.runTool(startParams(state.workflowId)))).toBe("armed");
    const switchesAfterArm = harness.switched.length;

    writePluginOverrides(repo.main, { modelHandoff: false, handoffTarget: "@default" });
    const preferenceOff = await harness.runTool(activeCompletionParams(state));
    expect(codeOf(preferenceOff)).toBe("preference-off");
    expect(harness.liveSpec()).toBe("probe/slow-model");
    expect(harness.switched).toHaveLength(switchesAfterArm);

    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    rmSync(state.reviews[0]!.reportPath, { force: true });
    const notReady = await harness.runTool(activeCompletionParams(state));
    expect(codeOf(notReady)).toBe("not-ready");
    expect(harness.switched).toHaveLength(switchesAfterArm);
    expect(harness.liveSpec()).toBe("probe/slow-model");
  }, 120_000);

  test("ACTIVE fire cancels an unowned model change and never retries a refused switch", async () => {
    const repo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    const state = await seedActiveHandoffAuthority(repo, session.getSessionId());
    expect(codeOf(await harness.runTool(startParams(state.workflowId)))).toBe("armed");
    const switchesAfterArm = harness.switched.length;

    session.appendModelChange("probe/external-model", "picker");
    const cancelled = await harness.runTool(activeCompletionParams(state));
    expect(codeOf(cancelled)).toBe("cancelled");
    expect(harness.switched).toHaveLength(switchesAfterArm);

    const secondRepo = buildControlRepo("fixture-sibling-iteration", { legacySources: false });
    writePluginOverrides(secondRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const secondSession = newSession(secondRepo.main);
    const secondHarness = await createHarness({ cwd: secondRepo.main, sessionDir: scratchDir("unused-"), sessionManager: secondSession });
    const secondState = await seedActiveHandoffAuthority(secondRepo, secondSession.getSessionId());
    expect(codeOf(await secondHarness.runTool(startParams(secondState.workflowId)))).toBe("armed");
    const secondSwitchesAfterArm = secondHarness.switched.length;
    secondHarness.auth.allowed = false;
    const refused = await secondHarness.runTool(activeCompletionParams(secondState));
    expect(codeOf(refused)).toBe("switch-refused");
    expect(secondHarness.switched).toHaveLength(secondSwitchesAfterArm);
    expect(secondHarness.liveSpec()).toBe("probe/slow-model");
    expect(statesOf(secondHarness).at(-1)).toBe("failed");
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
    // initializeStore establishes the ACTIVE authority on this cutover path.
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
    });

    const fired = await harness.runTool(completionParams(artifacts));
    expect(codeOf(fired)).toBe("not-pending");
    expect(harness.attempts).toHaveLength(0);
    expect(harness.switched).toHaveLength(0);
    expect(statesOf(harness)).toEqual([]);
    expect(harness.liveSpec()).toBe("probe/default-model");
  }, 120_000);
});
