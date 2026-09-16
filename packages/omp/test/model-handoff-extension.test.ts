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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * and a harness root with one registered sibling active iteration.
 */
function buildControlRepo(siblingId = "fixture-sibling-iteration"): ControlRepo {
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
  for (const dir of ["workflows", "iterations", "plans"]) mkdirSync(join(harness, dir), { recursive: true });
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
  planPaths.forEach((path, index) => writeFileSync(path, `# ${planIds[index]}\n\nPlan body.\n`));
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
  emitInput: (text: string, source?: "interactive" | "rpc" | "extension") => Promise<void>;
  emitBeforeAgentStart: (prompt: string) => Promise<unknown>;
  emitToolResult: (toolCallId: string, toolName: string, isError: boolean) => Promise<unknown>;
  runTool: (params: ToolParams) => Promise<ToolResult>;
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
    emitInput: async (text: string, source: "interactive" | "rpc" | "extension" = "interactive") => {
      await runner.emitInput(text, undefined, source);
    },
    emitBeforeAgentStart: (prompt: string) => runner.emitBeforeAgentStart(prompt, undefined, []),
    emitToolResult: (toolCallId: string, toolName: string, isError: boolean) =>
      runner.emitToolResult({ type: "tool_result", toolCallId, toolName, input: {}, content: [], isError } as never),
    runTool: runToolCall,
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
        "tool_result",
      ],
      tools: [TOOL_NAME],
      commands: 0,
      shortcuts: 0,
      flags: 0,
      messageRenderers: 0,
      composerShapes: 0,
      fileWriteFallbacks: 0,
      fileDeleteFallbacks: 0,
    });
  });

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
  });

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
  });
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
  });
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
  });
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
  });
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

    // --- Navigation arriving *first* fences the action ---
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
  });
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
  });
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
  });
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
  });
});
