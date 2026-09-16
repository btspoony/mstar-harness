/**
 * Coordinator session adapter tests — `packages/omp/src/extensions/model-handoff.ts`.
 *
 * ## What is real here, and what the test supplies
 *
 * Real host objects in disposable temporary storage (never the operator's
 * session, settings, credentials or repository):
 *
 * - `SessionManager` — a real session file and ledger; ids, `model_change`
 *   entries, `custom` records and `custom_message` notices are the host's own
 *   writes (`appendModelChange`, `appendCustomEntry`, `appendCustomMessageEntry`
 *   — the exact calls `pi.appendEntry` / `AgentSession.sendCustomMessage` make).
 * - `ModelControls` — the host's own picker/role-cycle implementation
 *   (`setModel`, `cycleRoleModels`); `pi.setModel` is wired to it the way
 *   `extension-ui-controller.ts` wires the public API (auth lookup, then the
 *   session model switch). The auth/metadata step is the brief's controlled
 *   barrier: `refreshSelectedModelMetadata` awaits a gate the test releases.
 * - `Settings.isolated` role mappings plus the real `ctx.models` facade, so
 *   `@slow`/`@smol`/`@default` resolve through the host's own role resolver.
 * - The real `getPluginSettings` reader through a **project** override file in
 *   the fixture root (the user-scope round trip belongs to Task 1, and writing
 *   the operator's `~/.omp` is forbidden here).
 * - The real E1/E2 modules (`reserveHandoffBinding`, `inspectPhase1Readiness`)
 *   and real Git facts (a disposable repository, a linked integration worktree,
 *   a local bare remote).
 *
 * The test supplies only what the harness cannot produce: **event delivery**
 * (the captured `pi.on` handlers are invoked the way the host runner invokes
 * them) and the **controlled auth/metadata barrier**. No TUI, provider request
 * or credential is involved, and no model action is claimed for any development
 * session.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/model-api";
import type { ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { ModelControls } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import modelHandoff, {
  HANDOFF_CUSTOM_TYPE,
  HANDOFF_NOTICE_CUSTOM_TYPE,
  decideSessionState,
  readSessionRecords,
} from "../src/extensions/model-handoff";
import type { HandoffRecord } from "../src/extensions/model-handoff";

/* --------------------------------------------------------------- scratch --- */

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

/** The host's own `Model` type, taken from the signature it appears in. */
type HostModel = Parameters<ModelControls["setModel"]>[0];
/** The fixture builds exactly the fields the host selection code reads. */
const asHostModel = (model: TestModel): HostModel => model as unknown as HostModel;

const PICKER_MODEL = testModel("picker-model");

/* ------------------------------------------------------------------ zod ----- */

type ZodModule = Readonly<{ z: { object: (shape: Record<string, unknown>) => { strict: () => unknown } } }>;

let zodShim: ZodModule | null = null;

/**
 * The schema builder the host itself injects (`ExtensionAPI.zod` is
 * `@oh-my-pi/omptype/zod`), resolved through the installed host package so the
 * schema under test is the real one — including strict unknown-key rejection.
 * A static import is impossible from this package: the shim is a dependency of
 * the installed host, not of `@mstar-harness/omp`.
 */
async function loadZod(): Promise<ZodModule> {
  if (zodShim !== null) return zodShim;
  const hostEntry = import.meta.resolve("@oh-my-pi/pi-coding-agent");
  const hostDir = new URL("./", hostEntry).pathname;
  zodShim = (await import(Bun.resolveSync("@oh-my-pi/omptype/zod", hostDir))) as ZodModule;
  return zodShim;
}

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

/** The lawful workflow creation the coordinator performs after a reservation. */
function createWorkflowArtifacts(repo: ControlRepo, sessionId: string, workflowId: string): Artifacts {
  const planIds = [`${workflowId}-plan`];
  const workflowDir = join(repo.harness, "workflows", workflowId);
  const guidesDir = join(repo.harness, "iterations", workflowId, "guides");
  mkdirSync(join(workflowDir, "sessions"), { recursive: true });
  mkdirSync(guidesDir, { recursive: true });

  const envelopePath = join(workflowDir, "sessions", `${sessionId}.json`);
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

type HostMode = "tui" | "print" | "json" | "rpc";

type ToolResult = Readonly<{
  content: readonly Readonly<{ type: string; text: string }>[];
  details: Readonly<{ mstarModelHandoff?: Record<string, unknown>; ok?: boolean }>;
  isError?: boolean;
}>;

type ToolParams = Record<string, unknown>;

type Harness = Readonly<{
  sessionManager: SessionManager;
  controls: ModelControls;
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
  emit: (event: string, payload?: Record<string, unknown>) => unknown;
  runTool: (params: ToolParams) => Promise<ToolResult>;
  /** `safeParse` through the extension's own registered parameter schema. */
  validate: (params: ToolParams) => { success: boolean; message?: string };
  useSession: (manager: SessionManager) => void;
}>;

type Handler = (event: unknown, ctx: unknown) => unknown;

type RegisteredTool = Readonly<{
  name: string;
  parameters: {
    safeParse: (value: unknown) => { success: boolean; error?: { message?: string } };
    parse: (value: unknown) => unknown;
  };
  execute: (
    toolCallId: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<ToolResult>;
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
  const zod = await loadZod();
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

  // The controlled host double implements the members `ModelControls` reads
  // (auth, metadata barrier, live model, real session manager and settings).
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

  const handlers = new Map<string, Handler[]>();
  let tool: RegisteredTool | null = null;

  const pi = {
    zod,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (definition: RegisteredTool) => {
      tool = definition;
    },
    // The durable writes the real actions perform: `sessionManager.appendCustomEntry`
    // for `pi.appendEntry`, `appendCustomMessageEntry` for `sendCustomMessage`.
    appendEntry: (customType: string, data?: unknown) => {
      testContext.sessionManager.appendCustomEntry(customType, data);
    },
    sendMessage: (payload: { customType?: string; content?: string; display?: boolean; details?: unknown }) => {
      testContext.sessionManager.appendCustomMessageEntry(
        payload.customType,
        payload.content,
        payload.display,
        payload.details,
      );
    },
    // The real extension action: auth lookup, then the session model switch
    // (`ModelControls.setModel`, the picker/cycle implementation).
    setModel: async (model: HostModel) => {
      attempts.push(`${model.provider}/${model.id}`);
      for (const waiter of actionWaiters.splice(0)) waiter();
      if (!auth.allowed) return false;
      await controls.setModel(model, "default");
      switched.push(`${model.provider}/${model.id}`);
      return true;
    },
  };

  const testContext = {
    cwd: options.cwd,
    hasUI: true,
    mode: options.mode ?? "tui",
    sessionManager,
    models,
    ui: { notify: () => {} },
  };
  // The double exposes the subset of `ExtensionContext` the extension consumes
  // (cwd, sessionManager, models, mode); the cast is confined to this boundary.
  const extensionContext = testContext as unknown as ExtensionContext;

  modelHandoff(pi as unknown as Parameters<typeof modelHandoff>[0]);

  return {
    sessionManager,
    controls,
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
    ledger: () => testContext.sessionManager.getEntries(),
    records: () => readSessionRecords(testContext.sessionManager.getEntries(), testContext.sessionManager.getSessionId()),
    notices: () =>
      testContext.sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "custom_message" && entry.customType === HANDOFF_NOTICE_CUSTOM_TYPE
            ? [typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)]
            : [],
        ),
    emit: (event: string, payload: Record<string, unknown> = {}) => {
      let first: unknown;
      for (const handler of handlers.get(event) ?? []) {
        const result = handler({ type: event, ...payload }, extensionContext);
        if (first === undefined && result !== undefined) first = result;
      }
      return first;
    },
    runTool: async (params: ToolParams) => {
      if (tool === null) throw new Error("the extension registered no tool");
      return tool.execute("fixture-tool-call", tool.parameters.parse(params), undefined, undefined, extensionContext);
    },
    validate: (params: ToolParams) => {
      if (tool === null) throw new Error("the extension registered no tool");
      const parsed = tool.parameters.safeParse(params);
      return parsed.success ? { success: true } : { success: false, message: parsed.error?.message ?? "" };
    },
    useSession: (manager: SessionManager) => {
      testContext.sessionManager = manager;
    },
  };
}

function startParams(workflowId: string, entry: "iteration-start" | "iteration-loop" | "skill-start"): ToolParams {
  return { operation: "start", workflowId, entry, intent: "new-iteration", authority: "coordinator" };
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
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: newSession(repo.main) });

    const before = {
      register: readFileSync(join(repo.harness, "status.json"), "utf8"),
      workflows: readdirSync(join(repo.harness, "workflows")).sort(),
      iterations: readdirSync(join(repo.harness, "iterations")).sort(),
    };

    // Ordinary chat, unrelated commands, natural-language starts, scoped-plan PM
    // routes and RPC/extension-sourced input: none of these is workflow
    // ownership, and the extension never classifies prose or a visible command
    // string. Arming happens only through the explicit PM first-action call.
    const entryTraces: readonly (readonly [string, Record<string, unknown>])[] = [
      ["input", { text: "hello, can you explain how the harness works?", source: "interactive" }],
      ["input", { text: "/iteration-start ship the adapter --pause", source: "interactive" }],
      ["input", { text: "/iteration-loop autonomous", source: "interactive" }],
      ["input", { text: "/iteration-drive --resume 20260916-omp-model-handoff", source: "interactive" }],
      ["input", { text: "start a new morning star iteration for the fixture", source: "rpc" }],
      ["input", { text: "please load the mstar-iteration skill and begin", source: "extension" }],
      ["before_agent_start", { prompt: "do the thing", systemPrompt: [] }],
      ["tool_result", { toolName: "read", isError: false }],
      ["agent_end", {}],
    ];
    for (const [event, payload] of entryTraces) harness.emit(event, payload);

    expect(harness.records()).toHaveLength(0);
    expect(harness.notices()).toHaveLength(0);
    expect(harness.attempts).toHaveLength(0);
    // `/iteration-drive` never creates a reservation, and none of these did.
    expect(readFileSync(join(repo.harness, "status.json"), "utf8")).toBe(before.register);
    expect(readdirSync(join(repo.harness, "workflows")).sort()).toEqual(before.workflows);
    expect(readdirSync(join(repo.harness, "iterations")).sort()).toEqual(before.iterations);

    // Mid-flight enable: turning the native preference on does not retro-arm,
    // and it does not start observing anything either.
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    for (const [event, payload] of entryTraces) harness.emit(event, payload);
    expect(harness.records()).toHaveLength(0);
    expect(harness.attempts).toHaveLength(0);

    // A native task/focused-agent session (`session_init` in its own ledger) is
    // refused by E1 even with the preference enabled.
    const taskSession = newSession(repo.main);
    taskSession.appendSessionInit({ systemPrompt: "task", task: "scout the repo", tools: ["read"], agent: "scout" });
    const taskHarness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: taskSession,
      mode: "json",
    });
    const refused = await taskHarness.runTool(startParams("task-session-iteration", "skill-start"));
    expect(codeOf(refused)).toBe("not-coordinator");
    expect(refused.isError).toBe(true);
    expect(taskHarness.records()).toHaveLength(0);
    expect(taskHarness.attempts).toHaveLength(0);
    expect(taskHarness.notices()).toHaveLength(0);
  });

  test("new coordinator start only: one arm per entry trace, identical across TUI, print, JSON and RPC modes", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const modes: readonly HostMode[] = ["tui", "print", "json", "rpc"];
    const traces = [
      { workflowId: "trace-slash-start", entry: "iteration-start" as const },
      { workflowId: "trace-loop-start", entry: "iteration-loop" as const },
      { workflowId: "trace-skill-start", entry: "skill-start" as const },
      { workflowId: "trace-print-start", entry: "iteration-start" as const },
      { workflowId: "trace-json-start", entry: "iteration-start" as const },
      { workflowId: "trace-rpc-start", entry: "iteration-start" as const },
      { workflowId: "trace-skill-second", entry: "skill-start" as const },
    ];

    // Separate bounded PM entry traces: a slash start, an autonomous loop start
    // and a skill start are not distinguished by any parser — the PM's explicit
    // first-action call is the only entry — and each adapter mode behaves the
    // same because the tool result is mode-independent.
    const armed: Array<{ harness: Harness; workflowId: string }> = [];
    for (const [index, trace] of traces.entries()) {
      const harness = await createHarness({
        cwd: repo.main,
        sessionDir: scratchDir("unused-"),
        sessionManager: newSession(repo.main),
        mode: modes[index % modes.length]!,
      });
      const result = await harness.runTool(startParams(trace.workflowId, trace.entry));
      expect(codeOf(result)).toBe("armed");
      expect(stateOf(result)).toBe("pending");
      expect(harness.mode).toBe(modes[index % modes.length]!);
      expect(harness.attempts).toEqual(["probe/slow-model"]);
      expect(harness.liveSpec()).toBe("probe/slow-model");
      // Exactly one `@slow` selection, one durable arm attempt and one durable
      // pending record whose baseline cursor is the real arm transition.
      expect(statesOf(harness)).toEqual(["attempting", "pending"]);
      const [attempt, pending] = harness.records();
      expect(attempt).toMatchObject({ action: "arm", baselineModelChangeId: null, observedModel: null });
      expect(pending).toMatchObject({ action: "arm", observedModel: "probe/slow-model" });
      // The E2 receipt is optional and belongs only to an invoked action.
      expect(attempt!.receipt).toBeUndefined();
      expect(pending!.receipt).toBeUndefined();
      expect(pending!.binding.workflowId).toBe(trace.workflowId);
      expect(harness.ledger().some((entry) => entry.id === pending!.baselineModelChangeId)).toBe(true);
      expect(harness.ledger().some((entry) => entry.type === "model_change" && entry.model === "probe/slow-model")).toBe(true);
      armed.push({ harness, workflowId: trace.workflowId });
    }

    // The completion checkpoint is exercised through the same four adapter modes:
    // the result is mode-independent, and each session switches only itself.
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
    // Every traced entry holds its own session: no session id is reused and no
    // firing session touched another session's model.
    const sessionIds = new Set(armed.map((entry) => entry.harness.sessionManager.getSessionId()));
    expect(sessionIds.size).toBe(armed.length);
    expect(armed.length).toBe(traces.length);

    // A false preference is inert: no record, no model action, no notice.
    const offRepo = buildControlRepo();
    const offHarness = await createHarness({
      cwd: offRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(offRepo.main),
    });
    const inert = await offHarness.runTool(startParams("off-iteration", "iteration-start"));
    expect(codeOf(inert)).toBe("preference-off");
    expect(inert.isError).toBe(false);
    expect(offHarness.records()).toHaveLength(0);
    expect(offHarness.attempts).toHaveLength(0);
    expect(offHarness.notices()).toHaveLength(0);

    // A malformed saved preference refuses visibly instead of being coerced.
    writePluginOverrides(offRepo.main, { modelHandoff: "yes", handoffTarget: "@smol" });
    const malformed = await offHarness.runTool(startParams("bad-preference-iteration", "iteration-start"));
    expect(codeOf(malformed)).toBe("settings-read-failed");
    expect(malformed.isError).toBe(true);
    expect(offHarness.records()).toHaveLength(0);
    expect(offHarness.attempts).toHaveLength(0);
  });

  test("new coordinator start only: the arm is once per binding, and a failed arm never becomes pending", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });

    const first = await harness.runTool(startParams("once-iteration", "iteration-start"));
    expect(codeOf(first)).toBe("armed");
    expect(harness.attempts).toEqual(["probe/slow-model"]);

    // Strict parameter validation: an unknown operation or an unknown key is
    // rejected by the registered schema before any code path runs.
    expect(harness.validate({ operation: "activate", workflowId: "once-iteration" }).success).toBe(false);
    expect(harness.validate({ ...startParams("once-iteration", "iteration-start"), extra: true }).success).toBe(false);
    expect(harness.validate(startParams("once-iteration", "iteration-start")).success).toBe(true);

    const second = await harness.runTool(startParams("once-iteration", "iteration-start"));
    expect(codeOf(second)).toBe("already-bound");
    expect(harness.attempts).toEqual(["probe/slow-model"]);
    expect(statesOf(harness)).toEqual(["attempting", "pending"]);

    // Arm failure: no role mapping exists in this session, so `@slow` cannot be
    // resolved (a role that maps to an unavailable model refuses the same way).
    // The arm must not leave a pending overwrite behind.
    const brokenRepo = buildControlRepo();
    writePluginOverrides(brokenRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const broken = await createHarness({
      cwd: brokenRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(brokenRepo.main),
      modelRoles: {},
    });
    const unresolved = await broken.runTool(startParams("broken-iteration", "iteration-start"));
    expect(codeOf(unresolved)).toBe("slow-unresolved");
    expect(broken.attempts).toHaveLength(0);
    expect(statesOf(broken)).toEqual(["attempting", "failed"]);
    expect(broken.records().at(-1)!.reason).toContain("cannot resolve @slow");

    // Missing auth at arm time: the public host action reports `false`, the arm
    // fails, the session keeps its model and nothing is pending.
    const noAuthRepo = buildControlRepo();
    writePluginOverrides(noAuthRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const noAuth = await createHarness({
      cwd: noAuthRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(noAuthRepo.main),
    });
    noAuth.auth.allowed = false;
    const refusedArm = await noAuth.runTool(startParams("no-auth-iteration", "iteration-start"));
    expect(codeOf(refusedArm)).toBe("slow-selection-refused");
    expect(noAuth.liveSpec()).toBe("probe/default-model");
    expect(statesOf(noAuth)).toEqual(["attempting", "failed"]);

    // A failed binding cannot fire later (it would overwrite the actual model).
    const artifacts = createWorkflowArtifacts(brokenRepo, broken.sessionManager.getSessionId(), "broken-iteration");
    const fireAfterFailure = await broken.runTool(completionParams(artifacts));
    expect(codeOf(fireAfterFailure)).toBe("not-pending");
    expect(broken.attempts).toHaveLength(0);
    expect(broken.liveSpec()).toBe("probe/default-model");
  });
});

describe("fire reads current preference", () => {
  test("fire reads current preference: destination, enablement and readiness are re-derived at fire time, and fire is one-shot", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@default" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });

    const armed = await harness.runTool(startParams("pref-iteration", "iteration-start"));
    expect(codeOf(armed)).toBe("armed");
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "pref-iteration");

    // Saved destination changed after the arm: fire re-reads it.
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const fired = await harness.runTool(completionParams(artifacts));
    expect(codeOf(fired)).toBe("handed_off");
    expect(harness.switched).toEqual(["probe/slow-model", "probe/smol-model"]);
    expect(harness.liveSpec()).toBe("probe/smol-model");
    expect(statesOf(harness)).toEqual(["attempting", "pending", "attempting", "handed_off"]);
    // The invocation record carries the frozen E2 receipt.
    expect(harness.records().at(-1)!.receipt).toBeDefined();
    expect(harness.records().at(-2)!.receipt).toBeDefined();

    // A one-shot binding never fires twice.
    const again = await harness.runTool(completionParams(artifacts));
    expect(codeOf(again)).toBe("not-pending");
    expect(harness.switched).toHaveLength(2);

    // Disabled before fire: the target switch is skipped, `@slow` stays, and the
    // preference edit does not terminalize the pending binding.
    const secondRepo = buildControlRepo();
    writePluginOverrides(secondRepo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const second = await createHarness({
      cwd: secondRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(secondRepo.main),
    });
    await second.runTool(startParams("pref-off-iteration", "iteration-start"));
    const secondArtifacts = createWorkflowArtifacts(secondRepo, second.sessionManager.getSessionId(), "pref-off-iteration");
    writePluginOverrides(secondRepo.main, { modelHandoff: false, handoffTarget: "@smol" });
    const suppressed = await second.runTool(completionParams(secondArtifacts));
    expect(codeOf(suppressed)).toBe("preference-off");
    expect(stateOf(suppressed)).toBe("pending");
    expect(second.switched).toEqual(["probe/slow-model"]);
    expect(second.notices().some((line) => line.includes("modelHandoff is off"))).toBe(true);
    expect(statesOf(second)).toEqual(["attempting", "pending"]);

    // Re-enabled while still pending and not cancelled: the same binding fires.
    writePluginOverrides(secondRepo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const refired = await second.runTool(completionParams(secondArtifacts));
    expect(codeOf(refired)).toBe("handed_off");
    expect(second.switched).toEqual(["probe/slow-model", "probe/smol-model"]);

    // Readiness is re-derived, never remembered: missing evidence refuses, and
    // the binding still fires once the evidence is intact again.
    const thirdRepo = buildControlRepo();
    writePluginOverrides(thirdRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const third = await createHarness({
      cwd: thirdRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(thirdRepo.main),
    });
    await third.runTool(startParams("pref-ready-iteration", "iteration-start"));
    const thirdArtifacts = createWorkflowArtifacts(thirdRepo, third.sessionManager.getSessionId(), "pref-ready-iteration");
    const reportPath = thirdArtifacts.reviews[1]!.reportPath;
    rmSync(reportPath);
    const notReady = await third.runTool(completionParams(thirdArtifacts));
    expect(codeOf(notReady)).toBe("not-ready");
    expect(stateOf(notReady)).toBe("pending");
    expect((notReady.details.mstarModelHandoff?.codes as readonly string[]).includes("review-evidence-missing")).toBe(true);
    expect(third.switched).toEqual(["probe/slow-model"]);
    writeFileSync(reportPath, "returned payload — architect\n");
    const ready = await third.runTool(completionParams(thirdArtifacts));
    expect(codeOf(ready)).toBe("handed_off");
    expect(third.switched).toEqual(["probe/slow-model", "probe/default-model"]);
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
    const armed = await harness.runTool(startParams("picker-iteration", "iteration-start"));
    expect(codeOf(armed)).toBe("armed");
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "picker-iteration");
    const pendingRecord = harness.records().at(-1)!;
    const baseline = pendingRecord.baselineModelChangeId;
    expect(baseline).not.toBeNull();
    expect(harness.ledger().some((entry) => entry.id === baseline)).toBe(true);

    // The arm's own transition must not cancel its own pending window.
    harness.emit("input", { text: "next", source: "interactive" });
    expect(statesOf(harness)).toEqual(["attempting", "pending"]);

    // The real picker path (`ModelControls.setModel`, the implementation behind
    // the temporary/role pickers) changes the model while the handoff is pending.
    await harness.controls.setModel(asHostModel(PICKER_MODEL), "default");
    expect(harness.liveSpec()).toBe("probe/picker-model");
    expect(harness.ledger().some((entry) => entry.type === "model_change" && entry.model === "probe/picker-model")).toBe(true);

    harness.emit("agent_end", {});
    const cancelled = harness.records().at(-1)!;
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.reason).toContain("unowned model change to probe/picker-model");
    expect(harness.notices().some((line) => line.includes("model handoff cancelled"))).toBe(true);
    // No target action was ever attempted: the only `pi.setModel` call is the arm.
    expect(harness.attempts).toEqual(["probe/slow-model"]);

    const afterCancel = await harness.runTool(completionParams(artifacts));
    expect(codeOf(afterCancel)).toBe("not-pending");
    expect(harness.attempts).toEqual(["probe/slow-model"]);
    expect(harness.liveSpec()).toBe("probe/picker-model");

    // Re-enabling the preference cannot resurrect a cancelled binding.
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const afterReEnable = await harness.runTool(completionParams(artifacts));
    expect(codeOf(afterReEnable)).toBe("not-pending");
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
    const backArmed = await back.runTool(startParams("away-back-iteration", "iteration-start"));
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

    back.emit("tool_result", { toolName: "bash", isError: false });
    const awayBack = back.records().at(-1)!;
    expect(awayBack.state).toBe("cancelled");
    expect(awayBack.reason).toContain("unowned model change to probe/picker-model");
    expect(back.liveSpec()).toBe(baselineModel);
    const backFire = await back.runTool(completionParams(backArtifacts));
    expect(codeOf(backFire)).toBe("not-pending");
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
    await harness.runTool(startParams("unowned-iteration", "iteration-start"));
    expect(statesOf(harness)).toEqual(["attempting", "pending"]);
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "unowned-iteration");

    // Another extension / host path appends a native model change: the extension
    // cannot attribute it, so it cancels conservatively and says so.
    harness.sessionManager.appendModelChange("probe/other-model", "temporary");
    harness.setLiveModel("other-model");
    harness.emit("before_agent_start", { prompt: "go", systemPrompt: [] });
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
    await live.runTool(startParams("live-only-iteration", "iteration-start"));
    const liveArtifacts = createWorkflowArtifacts(liveRepo, live.sessionManager.getSessionId(), "live-only-iteration");
    live.setLiveModel("default-model");
    expect(live.ledger().filter((entry) => entry.type === "model_change")).toHaveLength(1);
    live.emit("input", { text: "still there?", source: "interactive" });
    const byLive = live.records().at(-1)!;
    expect(byLive.state).toBe("cancelled");
    expect(byLive.reason).toContain("the live model is probe/default-model, not the armed baseline probe/slow-model");
    const liveFire = await live.runTool(completionParams(liveArtifacts));
    expect(codeOf(liveFire)).toBe("not-pending");
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
    await race.runTool(startParams("race-iteration", "iteration-start"));
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
  test("navigation and action exclude each other: navigation during an action is refused immediately, and an earlier navigation fences the action", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const harness = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    await harness.runTool(startParams("nav-iteration", "iteration-start"));
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "nav-iteration");

    // --- Navigation arriving *during* an invoked action ---
    const release = harness.metadata.hold();
    const invoked = harness.nextAction();
    const firing = harness.runTool(completionParams(artifacts));
    await invoked;
    // The attempt record is appended synchronously *before* the action is
    // invoked, so the durable state is already `attempting` here.
    expect(harness.records().at(-1)!.state).toBe("attempting");
    expect(harness.liveSpec()).toBe("probe/slow-model");

    const duringAction = harness.emit("session_before_tree", {
      preparation: { targetId: "root", oldLeafId: null, commonAncestorId: null, entriesToSummarize: [], userWantsSummary: false },
    });
    // Refused synchronously: a promise-like return would mean the handler waited
    // inside the event handler, where the host enforces a handler timeout.
    expect(duringAction).toEqual({ cancel: true });
    expect(isPromiseLike(duringAction)).toBe(false);
    expect(harness.notices().some((line) => line.includes("navigation was refused"))).toBe(true);
    for (const event of ["session_before_switch", "session_before_branch"]) {
      const refused = harness.emit(event, { reason: "new", entryId: "root" });
      expect(refused).toEqual({ cancel: true });
      expect(isPromiseLike(refused)).toBe(false);
    }

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
    await fence.runTool(startParams("fence-iteration", "iteration-start"));
    const fenceArtifacts = createWorkflowArtifacts(fenceRepo, fence.sessionManager.getSessionId(), "fence-iteration");

    // No action in flight: the navigation is allowed and only advances the fence.
    expect(fence.emit("session_before_tree", { preparation: {} })).toBeUndefined();
    const suspended = await fence.runTool(completionParams(fenceArtifacts));
    expect(codeOf(suspended)).toBe("suspended");
    expect(stateOf(suspended)).toBe("pending");
    expect(fence.attempts).toEqual(["probe/slow-model"]);
    expect(fence.notices().some((line) => line.includes("handoff suspended"))).toBe(true);
    expect(statesOf(fence)).toEqual(["attempting", "pending"]);

    // The matching post-event clears the fence and replays state; the same
    // completion call now fires, proving the fence was the only blocker.
    fence.emit("session_tree", { newLeafId: "leaf-1", oldLeafId: "leaf-2" });
    const afterFence = await fence.runTool(completionParams(fenceArtifacts));
    expect(codeOf(afterFence)).toBe("handed_off");
    expect(fence.switched).toEqual(["probe/slow-model", "probe/default-model"]);

    // A navigation that never completes (another extension cancelled it) leaves
    // a visible suspended condition; a reload recovers it.
    const stuckRepo = buildControlRepo();
    writePluginOverrides(stuckRepo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const stuck = await createHarness({
      cwd: stuckRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(stuckRepo.main),
    });
    await stuck.runTool(startParams("stuck-iteration", "iteration-start"));
    const stuckArtifacts = createWorkflowArtifacts(stuckRepo, stuck.sessionManager.getSessionId(), "stuck-iteration");
    stuck.emit("session_before_switch", { reason: "resume", targetSessionFile: "/tmp/elsewhere.jsonl" });
    const stuckFire = await stuck.runTool(completionParams(stuckArtifacts));
    expect(codeOf(stuckFire)).toBe("suspended");
    expect(stuck.attempts).toEqual(["probe/slow-model"]);
    expect(stuck.notices().some((line) => line.includes("handoff suspended"))).toBe(true);
    stuck.emit("session_start", {});
    const recovered = await stuck.runTool(completionParams(stuckArtifacts));
    expect(codeOf(recovered)).toBe("handed_off");
    expect(stuck.switched).toEqual(["probe/slow-model", "probe/smol-model"]);
  });
});

describe("terminal state survives tree and reload", () => {
  test("terminal state survives tree and reload: no re-arm, no second fire, and a fork inherits no authority", async () => {
    const repo = buildControlRepo();
    writePluginOverrides(repo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const session = newSession(repo.main);
    const harness = await createHarness({ cwd: repo.main, sessionDir: scratchDir("unused-"), sessionManager: session });
    await harness.runTool(startParams("terminal-iteration", "iteration-start"));
    const artifacts = createWorkflowArtifacts(repo, session.getSessionId(), "terminal-iteration");
    expect(codeOf(await harness.runTool(completionParams(artifacts)))).toBe("handed_off");
    const settled = statesOf(harness);
    const actions = [...harness.attempts];

    // Tree navigation inside the same session restores the terminal state from
    // the full ledger (the active branch alone would lose it).
    harness.emit("session_tree", { newLeafId: "leaf-9", oldLeafId: "leaf-3" });
    harness.emit("session_start", {});
    expect(statesOf(harness)).toEqual(settled);
    expect(harness.attempts).toEqual(actions);
    expect(harness.ledger().filter((entry) => entry.type === "model_change" && entry.model === "probe/slow-model")).toHaveLength(1);

    const refire = await harness.runTool(completionParams(artifacts));
    expect(codeOf(refire)).toBe("not-pending");
    const rearm = await harness.runTool(startParams("terminal-iteration", "iteration-start"));
    expect(codeOf(rearm)).toBe("already-bound");
    expect(harness.attempts).toEqual(actions);

    // A fork gets a new session id: the copied records carry the parent's
    // session id, so the fork has no authority and no pending binding. A fresh
    // session defers file creation, so the durable file is materialized with the
    // host's own `ensureOnDisk` before the fork reads it.
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
    fork.emit("session_switch", { reason: "fork", previousSessionFile: sessionFile });
    const forkFire = await fork.runTool(completionParams(artifacts));
    expect(codeOf(forkFire)).toBe("not-pending");
    expect(fork.attempts).toHaveLength(0);
    expect(fork.liveSpec()).toBe("probe/default-model");

    // A later new iteration in a *new* coordinator session still arms from the
    // saved preference (the terminated binding is not inherited, it is replaced).
    const later = await createHarness({
      cwd: repo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(repo.main),
    });
    const laterArm = await later.runTool(startParams("later-iteration", "iteration-start"));
    expect(codeOf(laterArm)).toBe("armed");
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
    await harness.runTool(startParams("attempt-iteration", "iteration-start"));
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
    resumed.emit("session_start", {});
    const uncertain = resumed.records().at(-1)!;
    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.action).toBe("handoff");
    expect(uncertain.reason).toContain("no recorded outcome");
    expect(resumed.notices().some((line) => line.includes("handoff uncertain"))).toBe(true);
    // Neither `@slow` nor the target is retried, and the actual model is kept.
    expect(resumed.attempts).toHaveLength(0);
    expect(resumed.liveSpec()).toBe("probe/slow-model");

    const afterResume = await resumed.runTool(completionParams(artifacts));
    expect(codeOf(afterResume)).toBe("not-pending");
    expect(resumed.attempts).toHaveLength(0);

    // Replaying the same reconstruction appends nothing new (terminal is stable).
    resumed.emit("session_start", {});
    expect(statesOf(resumed)).toEqual(["attempting", "pending", "attempting", "uncertain"]);
    expect(resumed.attempts).toHaveLength(0);

    // The interrupted action is released only now, after every assertion: it is
    // the *original* attempt completing, not a retry by the resumed session.
    held();
    await interrupted;
    expect(resumed.attempts).toHaveLength(0);

    // A missing armed baseline cursor is uncertainty, not a reason to reset the
    // observation window (a truncated or rewritten ledger is the real-world case).
    const cursorRepo = buildControlRepo();
    writePluginOverrides(cursorRepo.main, { modelHandoff: true, handoffTarget: "@default" });
    const cursor = await createHarness({
      cwd: cursorRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(cursorRepo.main),
    });
    await cursor.runTool(startParams("cursor-iteration", "iteration-start"));
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
    await harness.runTool(startParams("fail-iteration", "iteration-start"));
    const artifacts = createWorkflowArtifacts(repo, harness.sessionManager.getSessionId(), "fail-iteration");
    const armedModel = harness.liveSpec();

    // Missing auth at fire time: the public action reports `false`. The session
    // keeps the model it actually has, the failure is visible, and nothing is
    // rolled back to the pre-arm model.
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

    // No retry loop: a second completion call is refused and attempts nothing.
    const retry = await harness.runTool(completionParams(artifacts));
    expect(codeOf(retry)).toBe("not-pending");
    expect(harness.attempts).toEqual(["probe/slow-model", "probe/smol-model"]);

    // A throwing switch reports the throw and the actual model.
    const throwRepo = buildControlRepo();
    writePluginOverrides(throwRepo.main, { modelHandoff: true, handoffTarget: "@smol" });
    const throwing = await createHarness({
      cwd: throwRepo.main,
      sessionDir: scratchDir("unused-"),
      sessionManager: newSession(throwRepo.main),
    });
    await throwing.runTool(startParams("throw-iteration", "iteration-start"));
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
    await noTarget.runTool(startParams("no-target-iteration", "iteration-start"));
    const noTargetArtifacts = createWorkflowArtifacts(noTargetRepo, noTarget.sessionManager.getSessionId(), "no-target-iteration");
    const unresolved = await noTarget.runTool(completionParams(noTargetArtifacts));
    expect(codeOf(unresolved)).toBe("target-unresolved");
    expect(noTarget.liveSpec()).toBe("probe/slow-model");
    expect(noTarget.switched).toEqual(["probe/slow-model"]);
    expect(statesOf(noTarget)).toEqual(["attempting", "pending", "failed"]);
  });
});
