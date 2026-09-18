/**
 * @mstar-harness/omp bundle smoke test — asserts the built `dist/` bundles
 * AND the packed installable artifact (npm pack) carry every surface omp
 * convention-scans from the installed package root: hooks/pre/, tools/*.js,
 * extensions/, skills/, commands/, agents/, assets/, plugin.json. The packed
 * check runs `npm pack --json` (respecting `files` in package.json) into a
 * temp dir so a release cannot ship a tarball that omits
 * convention-discovered metadata.
 *
 * The runtime case loads the PACKED artifact through the host's own discovery
 * and loaders inside a disposable host root (child `bun` process, `HOME`
 * redirected): plugin enumeration from the native plugin root, manifest
 * `omp.extensions` resolution, extension factory loading, custom-tool
 * discovery, and real tool/hook execution. It replaces the former source-text
 * assertions (`validateStatus` symbol present, no bare
 * `@mstar-harness/engine` import) with the behaviour those regexes stood for:
 * the emitted bundles run with no resolvable `@mstar-harness/engine` package,
 * and the extension's one runtime host import resolves to the running host
 * that the optional peer pins.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const HOOK_BUNDLE = join(DIST, "hooks", "pre", "mstar-gates.js");
const EXTENSION_BUNDLE = join(DIST, "extensions", "model-handoff.js");
/** Package-root path the manifest `omp.extensions` entry must resolve to. */
const EXTENSION_MIRROR = join(ROOT, "extensions", "model-handoff.js");
/** Suffix the discovered entry is matched by inside the child process. */
const EXTENSION_SUFFIX = "/extensions/model-handoff.js";
const SOURCE_ENTRY = join(ROOT, "src", "extensions", "model-handoff.ts");
const TOOLS = [
  "mstar_status_validate",
  "mstar_dispatch_validate",
  "mstar_iteration_gate",
  "mstar_lease_verify",
  "mstar_path_resolve",
  "mstar_worktree_check",
];

const HOST_PACKAGE = "@oh-my-pi/pi-coding-agent";
const PLUGIN_NAME = "@mstar-harness/omp";
/** Sentinel plugin seeded into each disposable host root; a child that cannot read it must not run. */
const SENTINEL_PLUGIN = "mstar-bundle-probe";
/** Prefix the child prints its result with, so unrelated host output cannot be mistaken for it. */
const RESULT_MARKER = "MSTAR_BUNDLE_PROBE_RESULT ";

/** The extension's frozen event wiring (primary spec §Durable state and action ordering / Task 3 §Events). */
const EXTENSION_EVENTS = [
  "input",
  "before_agent_start",
  "tool_result",
  "agent_end",
  "session_before_switch",
  "session_before_branch",
  "session_before_tree",
  "session_switch",
  "session_branch",
  "session_tree",
  "session_start",
  "session_shutdown",
  "tool_call",
];

/** `package.json` as this package publishes it. */
function manifest(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("packages/omp/package.json is not an object");
  }
  return parsed as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new Error(`package.json ${key} is not a string`);
  return value;
}

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  for (const file of readdirSync(ROOT)) {
    if (file.startsWith("mstar-harness-omp-") && file.endsWith(".tgz")) rmSync(join(ROOT, file));
  }
});

function makeScratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/**
 * `npm pack` this package and unpack the tarball into `destination`, returning
 * the extracted package root — the artifact an operator actually installs.
 */
function unpackPacked(destination: string): string {
  const packed = spawnSync("npm", ["pack", "--json"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  expect(packed.status).toBe(0);
  const info = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const tarball = join(ROOT, info[0].filename);
  expect(existsSync(tarball)).toBe(true);
  mkdirSync(destination, { recursive: true });
  const extract = spawnSync("tar", ["-xzf", tarball, "-C", destination, "--strip-components=1"], { encoding: "utf8" });
  expect(extract.status).toBe(0);
  return destination;
}

/**
 * Installed host package that the optional peer pins. Resolution runs from this
 * package, so the exercised artifact is whatever a consumer of this package
 * resolves — the assertion below fails loudly instead of silently exercising
 * the monorepo's older root copy.
 */
function resolvedHost(): { entry: string; root: string; version: string } {
  const entry = Bun.resolveSync(HOST_PACKAGE, ROOT);
  const root = resolve(dirname(entry), "..");
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof pkg !== "object" || pkg === null) throw new Error("host package.json is not an object");
  const name = (pkg as Record<string, unknown>).name;
  if (name !== HOST_PACKAGE) throw new Error(`resolved host package is ${String(name)}, not ${HOST_PACKAGE}`);
  const version = (pkg as Record<string, unknown>).version;
  if (typeof version !== "string") throw new Error("host package.json version is not a string");
  return { entry, root, version };
}

interface RuntimeReport {
  host: { entry: string; root: string; version: string };
  packages: Array<{ name: string; version: string; path: string; scope: string }>;
  packedNodeModules: boolean;
  extensionPaths: string[];
  packedEntry: string | null;
  packed: { errors: string[]; tools: string[]; handlers: string[] };
  schema: { parsed: unknown; rejectsMissingWorkflowId: string | null };
  startInert: { ok: boolean; isError: boolean; code: string; message: string };
  startUnsafeWorkflow: { ok: boolean; isError: boolean; code: string; message: string };
  fireWithoutBinding: { ok: boolean; isError: boolean; code: string; message: string };
  source: { errors: string[]; tools: string[]; handlers: string[] };
  hook: { errors: string[]; handlers: string[]; toolCallHandlers: number; benignResult: string | null };
  tools: { loaded: string[]; errors: string[]; pathResolve: string };
  engineFromPackedRoot: { resolved: string } | { error: string };
}

/**
 * Run the packed artifact through the host inside a child `bun` process whose
 * `HOME`, user-scope plugin root and project root are disposable. The child
 * refuses to run unless the native settings/plugin roots still resolve to that
 * disposable root, so a broken redirect fails the test instead of touching the
 * operator's real host state.
 */
function loadPackedRuntime(hostRoot: string, pluginsRoot: string, project: string): RuntimeReport {
  const script = `
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getEnabledPlugins, getPluginSettings, PluginManager, resolvePluginExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { discoverAndLoadCustomTools } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";

const project = process.env.MSTAR_BUNDLE_PROJECT;
const pluginsRoot = process.env.MSTAR_BUNDLE_PLUGINS;
const sourceEntry = process.env.MSTAR_BUNDLE_SOURCE;
const pluginName = ${JSON.stringify(PLUGIN_NAME)};

// Refuse to run against anything but the disposable host root this test seeded.
const seed = await getPluginSettings(${JSON.stringify(SENTINEL_PLUGIN)}, project);
if (seed.disposableRoot !== true) {
  throw new Error("native plugin settings did not resolve to the disposable host root; refusing to run");
}

function textOf(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\\n");
}

const report = await (async () => {
  const hostEntry = Bun.resolveSync(${JSON.stringify(HOST_PACKAGE)}, import.meta.dir);
  const hostRootPath = resolve(dirname(hostEntry), "..");
  const hostManifest = JSON.parse(readFileSync(join(hostRootPath, "package.json"), "utf8"));

  const packages = (await getEnabledPlugins(project)).map((plugin) => ({
    name: plugin.name,
    version: plugin.version,
    path: plugin.path,
    scope: plugin.scope,
  }));
  const plugin = packages.find((entry) => entry.name === pluginName);
  if (!plugin) throw new Error("the packed plugin was not enumerated from the disposable plugin root");
  if (!plugin.path.startsWith(pluginsRoot)) {
    throw new Error("the enumerated plugin is not inside the disposable plugin root; refusing to run");
  }
  const hostPlugin = (await getEnabledPlugins(project)).find((entry) => entry.name === pluginName);
  const extensionPaths = resolvePluginExtensionPaths(hostPlugin);
  const packedEntry = extensionPaths.find((entry) => entry.endsWith(${JSON.stringify(EXTENSION_SUFFIX)})) ?? null;
  if (packedEntry === null) throw new Error("the manifest omp.extensions entry did not resolve to the packed file");

  const packedLoad = await loadExtensions([packedEntry], project);
  const packedExtension = packedLoad.extensions[0];
  const packedTool = packedExtension?.tools.get("mstar_model_handoff")?.definition;
  const parameters = packedTool?.parameters;
  let parsed = null;
  let rejectsMissingWorkflowId = null;
  if (parameters && typeof parameters.parse === "function") {
    parsed = parameters.parse({ operation: "start", workflowId: "probe-iteration" });
    try {
      parameters.parse({ operation: "start" });
    } catch (error) {
      rejectsMissingWorkflowId = String(error).slice(0, 160);
    }
  }

  // The host binds this session context; the adapter reads only these facts.
  const ctx = {
    cwd: project,
    sessionManager: {
      getSessionId: () => "bundle-probe-session",
      getEntries: () => [],
      getBranch: () => [],
    },
    models: {
      current: () => ({ provider: "probe", id: "probe-model" }),
      resolve: () => undefined,
    },
  };
  const invoke = async (id, params) => {
    // Host extension-tool signature: (toolCallId, params, signal, onUpdate, ctx).
    const result = await packedTool.execute(id, params, undefined, undefined, ctx);
    const details = result?.details?.mstarModelHandoff ?? {};
    return {
      ok: details.ok === true,
      isError: result?.isError === true,
      code: details.code ?? null,
      message: textOf(result).slice(0, 200),
    };
  };

  // Default native settings: inert, no record and no model action.
  const startInert = await invoke("probe-start", { operation: "start", workflowId: "probe-iteration" });
  // Native write through the host's own settings path, then an unsafe workflow id:
  // the inlined engine must refuse before any model action.
  await new PluginManager(project).setPluginSetting(pluginName, "modelHandoff", true);
  const startUnsafeWorkflow = await invoke("probe-start-unsafe", { operation: "start", workflowId: "../escape" });
  const fireWithoutBinding = await invoke("probe-fire", { operation: "phase1-complete", workflowId: "probe-iteration" });

  const sourceLoad = await loadExtensions([sourceEntry], project);
  const sourceExtension = sourceLoad.extensions[0];

  const hookPath = join(plugin.path, "hooks", "pre", "mstar-gates.js");
  const hookLoad = await loadExtensions([hookPath], project);
  const hookExtension = hookLoad.extensions[0];
  const toolCallHandlers = hookExtension?.handlers.get("tool_call") ?? [];
  const benign = toolCallHandlers.length === 0
    ? "no-handler"
    : await toolCallHandlers[0](
        { tool: "write", input: { path: join(project, "note.txt"), content: "hello" } },
        { cwd: project },
      );

  const loadedTools = await discoverAndLoadCustomTools([], project, []);
  const pathResolve = loadedTools.tools.find((entry) => entry.tool.name === "mstar_path_resolve");
  const pathResolveResult = pathResolve === undefined ? null : await pathResolve.tool.execute("probe-paths", {}, undefined, { cwd: project });

  let engineFromPackedRoot;
  try {
    engineFromPackedRoot = { resolved: Bun.resolveSync("@mstar-harness/engine", plugin.path) };
  } catch (error) {
    engineFromPackedRoot = { error: String(error).slice(0, 200) };
  }

  return {
    host: { entry: hostEntry, root: hostRootPath, version: hostManifest.version },
    packages,
    packedNodeModules: existsSync(join(plugin.path, "node_modules")),
    extensionPaths,
    packedEntry,
    packed: {
      errors: packedLoad.errors.map((entry) => entry.error),
      tools: [...(packedExtension?.tools.keys() ?? [])],
      handlers: [...(packedExtension?.handlers.keys() ?? [])],
    },
    schema: { parsed, rejectsMissingWorkflowId },
    startInert,
    startUnsafeWorkflow,
    fireWithoutBinding,
    source: {
      errors: sourceLoad.errors.map((entry) => entry.error),
      tools: [...(sourceExtension?.tools.keys() ?? [])],
      handlers: [...(sourceExtension?.handlers.keys() ?? [])],
    },
    hook: {
      errors: hookLoad.errors.map((entry) => entry.error),
      handlers: [...(hookExtension?.handlers.keys() ?? [])],
      toolCallHandlers: toolCallHandlers.length,
      benignResult: benign === undefined ? null : JSON.stringify(benign),
    },
    tools: {
      loaded: loadedTools.tools.map((entry) => entry.tool.name),
      errors: loadedTools.errors.map((entry) => entry.error),
      pathResolve: pathResolveResult === null ? "" : textOf(pathResolveResult),
    },
    engineFromPackedRoot,
  };
})();

console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(report));
`;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: hostRoot,
      PI_CONFIG_DIR: ".omp",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG ?? "C.UTF-8",
      MSTAR_BUNDLE_PROJECT: project,
      MSTAR_BUNDLE_PLUGINS: pluginsRoot,
      MSTAR_BUNDLE_SOURCE: SOURCE_ENTRY,
    },
    encoding: "utf8",
    timeout: 180_000,
  });
  if (child.status !== 0) {
    throw new Error(`packed-runtime probe failed (exit ${child.status}):\n${child.stderr || child.stdout}`);
  }
  const reported = child.stdout
    .split("\n")
    .filter((line) => line.startsWith(RESULT_MARKER))
    .pop();
  if (reported === undefined) {
    throw new Error(`packed-runtime probe reported no result:\n${child.stdout}`);
  }
  return JSON.parse(reported.slice(RESULT_MARKER.length)) as RuntimeReport;
}

/* ------------------------------------------------------------------------- *
 * Phase-2 orchestration entry (instances row T3) — a second manifest entry
 * under the same packaging contract, so it gets its own namespaced constants,
 * its own two-process probe and its own packed case.
 * ------------------------------------------------------------------------- */

const PHASE2_EXTENSION_BUNDLE = join(DIST, "extensions", "phase2-orchestration.js");
const PHASE2_EXTENSION_MIRROR = join(ROOT, "extensions", "phase2-orchestration.js");
const PHASE2_EXTENSION_SUFFIX = "/extensions/phase2-orchestration.js";
const PHASE2_SOURCE_ENTRY = join(ROOT, "src", "extensions", "phase2-orchestration.ts");
const PHASE2_TOOL = "mstar_phase2";
/** The Phase-2 extension's frozen event wiring, in registration order. */
const PHASE2_EVENTS = [
  "input",
  "agent_end",
  "session_before_switch",
  "session_before_branch",
  "session_before_tree",
  "session_switch",
  "session_branch",
  "session_tree",
  "session_start",
  "session_shutdown",
];
/** Native settings keys the manifest publishes for Phase-2 orchestration. */
const PHASE2_SETTING_KEYS = ["phase2PlanInstances", "maxPlanInstances"] as const;

interface Phase2RuntimeReport {
  host: { entry: string; root: string; version: string };
  packages: Array<{ name: string; version: string; path: string; scope: string }>;
  packedNodeModules: boolean;
  extensionPaths: string[];
  packedEntry: string | null;
  packedManifestSettings: Record<string, unknown>;
  packed: { errors: string[]; tools: string[]; handlers: string[] };
  schema: {
    parsedBind: unknown;
    parsedCheckpoint: unknown;
    rejectsWrongTypeSessionPath: string | null;
    rejectsCreatedWithoutTarget: string | null;
    rejectsUnknownOperation: string | null;
    rejectsUnknownKey: string | null;
  };
  bindUnreadableEnvelope: { ok: boolean; isError: boolean; code: string | null; message: string };
  checkpointUnbound: { ok: boolean; isError: boolean; code: string | null; message: string };
  settings: { mode: string; observed: Record<string, unknown>; invalidCapacityAccepted: boolean | null };
  source: { errors: string[]; tools: string[]; handlers: string[] };
  engineFromPackedRoot: { resolved: string } | { error: string };
}

/**
 * The Phase-2 counterpart of {@link loadPackedRuntime}, in the same disposable
 * host root. It differs in one respect that matters: `settingsMode` selects
 * whether this process *writes* the declared native preference through the
 * host's own settings path or only *reads* it, so persistence is proven across
 * two processes (a memory cache cannot fake the second one).
 */
function loadPhase2PackedRuntime(
  hostRoot: string,
  pluginsRoot: string,
  project: string,
  settingsMode: "read" | "write",
): Phase2RuntimeReport {
  const script = `
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getEnabledPlugins, getPluginSettings, PluginManager, resolvePluginExtensionPaths, validateSetting } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

const project = process.env.MSTAR_BUNDLE_PROJECT;
const pluginsRoot = process.env.MSTAR_BUNDLE_PLUGINS;
const sourceEntry = process.env.MSTAR_BUNDLE_SOURCE;
const pluginName = ${JSON.stringify(PLUGIN_NAME)};
const settingKeys = ${JSON.stringify(PHASE2_SETTING_KEYS)};
const settingsMode = process.env.MSTAR_BUNDLE_SETTINGS_MODE ?? "read";

// Refuse to run against anything but the disposable host root this test seeded.
const seed = await getPluginSettings(${JSON.stringify(SENTINEL_PLUGIN)}, project);
if (seed.disposableRoot !== true) {
  throw new Error("native plugin settings did not resolve to the disposable host root; refusing to run");
}

function textOf(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\\n");
}

const report = await (async () => {
  const hostEntry = Bun.resolveSync(${JSON.stringify(HOST_PACKAGE)}, import.meta.dir);
  const hostRootPath = resolve(dirname(hostEntry), "..");
  const hostManifest = JSON.parse(readFileSync(join(hostRootPath, "package.json"), "utf8"));

  const packages = (await getEnabledPlugins(project)).map((plugin) => ({
    name: plugin.name,
    version: plugin.version,
    path: plugin.path,
    scope: plugin.scope,
  }));
  const plugin = packages.find((entry) => entry.name === pluginName);
  if (!plugin) throw new Error("the packed plugin was not enumerated from the disposable plugin root");
  if (!plugin.path.startsWith(pluginsRoot)) {
    throw new Error("the enumerated plugin is not inside the disposable plugin root; refusing to run");
  }
  const hostPlugin = (await getEnabledPlugins(project)).find((entry) => entry.name === pluginName);
  const extensionPaths = resolvePluginExtensionPaths(hostPlugin);
  const packedEntry = extensionPaths.find((entry) => entry.endsWith(${JSON.stringify(PHASE2_EXTENSION_SUFFIX)})) ?? null;
  if (packedEntry === null) throw new Error("the manifest omp.extensions entry did not resolve to the packed phase2 file");

  const packedManifest = JSON.parse(readFileSync(join(plugin.path, "package.json"), "utf8"));
  const packedManifestSettings = packedManifest?.omp?.settings ?? {};

  const packedLoad = await loadExtensions([packedEntry], project);
  const packedExtension = packedLoad.extensions[0];
  const packedTool = packedExtension?.tools.get("mstar_phase2")?.definition;
  const parameters = packedTool?.parameters;
  const rejectionOf = (params) => {
    try {
      parameters.parse(params);
      return null;
    } catch (error) {
      return String(error).slice(0, 240);
    }
  };
  const parsedBind = parameters.parse({ operation: "bind", workflowId: "probe-iteration", coordinatorSessionPath: "/probe/session.json" });
  const parsedCheckpoint = parameters.parse({ operation: "checkpoint", reason: "before-wait", decision: "wait", note: "probe" });
  const rejectsWrongTypeSessionPath = rejectionOf({ operation: "bind", workflowId: "probe-iteration", coordinatorSessionPath: 7 });
  const rejectsCreatedWithoutTarget = rejectionOf({
    operation: "record-launch",
    intentId: "probe-intent",
    observation: "created",
    evidencePath: join(project, "evidence.txt"),
  });
  const rejectsUnknownOperation = rejectionOf({ operation: "probe-unsupported" });
  const rejectsUnknownKey = rejectionOf({
    operation: "bind",
    workflowId: "probe-iteration",
    coordinatorSessionPath: "/probe/session.json",
    extra: 1,
  });

  // The host binds this session context; the adapter reads only these facts.
  const ctx = {
    cwd: project,
    sessionManager: {
      getSessionId: () => "bundle-probe-session",
      getEntries: () => [],
      getBranch: () => [],
    },
    getAsyncJobSnapshot: () => null,
    hasPendingMessages: () => false,
  };
  const invoke = async (id, params) => {
    // Host extension-tool signature: (toolCallId, params, signal, onUpdate, ctx).
    const result = await packedTool.execute(id, params, undefined, undefined, ctx);
    const details = result?.details?.mstarPhase2 ?? {};
    return {
      ok: details.ok === true,
      isError: result?.isError === true,
      code: details.code ?? null,
      message: textOf(result).slice(0, 200),
    };
  };

  // The inlined engine reads the real coordinator envelope before anything else,
  // and an unbound session cannot checkpoint: both refusals are visible results.
  const bindUnreadableEnvelope = await invoke("probe-bind", {
    operation: "bind",
    workflowId: "probe-iteration",
    coordinatorSessionPath: join(project, "absent-session.json"),
  });
  const checkpointUnbound = await invoke("probe-checkpoint", {
    operation: "checkpoint",
    reason: "before-wait",
    decision: "wait",
    note: "probe",
  });

  // Native settings exercised for real. This process either writes through the
  // host's own settings path or freshly reads what a *previous* process wrote.
  if (settingsMode === "write") {
    await new PluginManager(project).setPluginSetting(pluginName, "phase2PlanInstances", true);
  }
  const observed = await getPluginSettings(pluginName, project);
  const capacitySchema = packedManifestSettings?.maxPlanInstances;
  const invalidCapacityAccepted =
    capacitySchema === undefined ? null : validateSetting(0, capacitySchema).valid === true;

  const sourceLoad = await loadExtensions([sourceEntry], project);
  const sourceExtension = sourceLoad.extensions[0];

  let engineFromPackedRoot;
  try {
    engineFromPackedRoot = { resolved: Bun.resolveSync("@mstar-harness/engine", plugin.path) };
  } catch (error) {
    engineFromPackedRoot = { error: String(error).slice(0, 200) };
  }

  return {
    host: { entry: hostEntry, root: hostRootPath, version: hostManifest.version },
    packages,
    packedNodeModules: existsSync(join(plugin.path, "node_modules")),
    extensionPaths,
    packedEntry,
    packedManifestSettings,
    packed: {
      errors: packedLoad.errors.map((entry) => entry.error),
      tools: [...(packedExtension?.tools.keys() ?? [])],
      handlers: [...(packedExtension?.handlers.keys() ?? [])],
    },
    schema: {
      parsedBind,
      parsedCheckpoint,
      rejectsWrongTypeSessionPath,
      rejectsCreatedWithoutTarget,
      rejectsUnknownOperation,
      rejectsUnknownKey,
    },
    bindUnreadableEnvelope,
    checkpointUnbound,
    settings: {
      mode: settingsMode,
      observed: Object.fromEntries(settingKeys.map((key) => [key, observed?.[key] ?? null])),
      invalidCapacityAccepted,
    },
    source: {
      errors: sourceLoad.errors.map((entry) => entry.error),
      tools: [...(sourceExtension?.tools.keys() ?? [])],
      handlers: [...(sourceExtension?.handlers.keys() ?? [])],
    },
    engineFromPackedRoot,
  };
})();

console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(report));
`;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: hostRoot,
      PI_CONFIG_DIR: ".omp",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG ?? "C.UTF-8",
      MSTAR_BUNDLE_PROJECT: project,
      MSTAR_BUNDLE_PLUGINS: pluginsRoot,
      MSTAR_BUNDLE_SOURCE: PHASE2_SOURCE_ENTRY,
      MSTAR_BUNDLE_SETTINGS_MODE: settingsMode,
    },
    encoding: "utf8",
    timeout: 180_000,
  });
  if (child.status !== 0) {
    throw new Error(`phase2 packed-runtime probe failed (exit ${child.status}):\n${child.stderr || child.stdout}`);
  }
  const reported = child.stdout
    .split("\n")
    .filter((line) => line.startsWith(RESULT_MARKER))
    .pop();
  if (reported === undefined) {
    throw new Error(`phase2 packed-runtime probe reported no result:\n${child.stdout}`);
  }
  return JSON.parse(reported.slice(RESULT_MARKER.length)) as Phase2RuntimeReport;
}

describe("@mstar-harness/omp bundle smoke", () => {
  test("dist/hooks/pre/mstar-gates.js exists (run `bun run build` first)", () => {
    expect(existsSync(HOOK_BUNDLE)).toBe(true);
  });

  test("dist/extensions/model-handoff.js exists (run `bun run build` first)", () => {
    expect(existsSync(EXTENSION_BUNDLE)).toBe(true);
  });

  test("dist/extensions/phase2-orchestration.js exists (run `bun run build` first)", () => {
    expect(existsSync(PHASE2_EXTENSION_BUNDLE)).toBe(true);
  });

  test("all six tool bundles exist under dist/tools/", () => {
    for (const tool of TOOLS) {
      expect(existsSync(join(DIST, "tools", tool, "index.js"))).toBe(true);
    }
  });

  test("omp discovery mirrors exist at the package root (hooks/pre/ + tools/*.js + extensions/)", () => {
    // omp discovers plugin surfaces by convention from the installed package
    // root: `hooks/pre/` (any file), `tools/` (direct *.js files — the
    // sub-directory scan only accepts `tools/<name>/index.ts`) and the
    // manifest-declared `extensions/` entry.
    expect(existsSync(join(ROOT, "hooks", "pre", "mstar-gates.js"))).toBe(true);
    for (const tool of TOOLS) {
      expect(existsSync(join(ROOT, "tools", `${tool}.js`))).toBe(true);
    }
    expect(existsSync(EXTENSION_MIRROR)).toBe(true);
    expect(existsSync(PHASE2_EXTENSION_MIRROR)).toBe(true);
  });
});

describe("@mstar-harness/omp packed artifact", () => {
  test(
    "npm pack tarball carries every omp convention-discovery surface",
    () => {
      const pkgRoot = unpackPacked(makeScratch("omp-pack-"));
      try {
        // plugin.json + assets: convention-discovered metadata omp needs to
        // enumerate the plugin.
        expect(existsSync(join(pkgRoot, "plugin.json"))).toBe(true);
        expect(readdirSync(join(pkgRoot, "assets")).length).toBeGreaterThan(0);
        // Hook + extension + tools at BOTH layouts (dist/ canonical, root discovery).
        expect(existsSync(join(pkgRoot, "dist", "hooks", "pre", "mstar-gates.js"))).toBe(true);
        expect(existsSync(join(pkgRoot, "hooks", "pre", "mstar-gates.js"))).toBe(true);
        expect(existsSync(join(pkgRoot, "dist", "extensions", "model-handoff.js"))).toBe(true);
        expect(existsSync(join(pkgRoot, "extensions", "model-handoff.js"))).toBe(true);
        expect(existsSync(join(pkgRoot, "dist", "extensions", "phase2-orchestration.js"))).toBe(true);
        expect(existsSync(join(pkgRoot, "extensions", "phase2-orchestration.js"))).toBe(true);
        for (const tool of TOOLS) {
          expect(existsSync(join(pkgRoot, "dist", "tools", tool, "index.js"))).toBe(true);
          expect(existsSync(join(pkgRoot, "tools", `${tool}.js`))).toBe(true);
        }
        // Skills/commands/agents (both layout names) with the PM entry set.
        for (const dir of ["skills", "harness-skills"]) {
          expect(existsSync(join(pkgRoot, dir, "mstar-harness-core", "SKILL.md"))).toBe(true);
          expect(existsSync(join(pkgRoot, dir, "pm", "SKILL.md"))).toBe(true);
        }
        for (const cmd of ["iteration-start", "iteration-drive", "iteration-loop"]) {
          expect(existsSync(join(pkgRoot, "commands", `${cmd}.md`))).toBe(true);
        }
        // PM ships no agent shell here: the `mode: primary` project-manager
        // shell is OpenCode-only (packages/opencode/agents/) — omp registers
        // subagent shells only and takes PM via the pm skill.
        expect(existsSync(join(pkgRoot, "agents", "project-manager.md"))).toBe(false);
        expect(existsSync(join(pkgRoot, "agents", "fullstack-dev.md"))).toBe(true);
      } finally {
        rmSync(pkgRoot, { recursive: true, force: true });
      }
    },
    150_000,
  );

  test(
    "packed artifact loads model handoff through host discovery",
    () => {
      const hostRoot = makeScratch("omp-bundle-host-");
      const project = join(hostRoot, "project");
      const pluginsRoot = join(hostRoot, ".omp", "plugins");
      const pkgRoot = join(pluginsRoot, "node_modules", "@mstar-harness", "omp");
      const pkg = manifest();
      const packageVersion = stringField(pkg, "version");
      const peer = (pkg.peerDependencies ?? {}) as Record<string, unknown>;
      mkdirSync(join(project, ".mstar"), { recursive: true });
      mkdirSync(pluginsRoot, { recursive: true });
      // Seed the disposable host root: the packaged plugin row the native plugin
      // enumeration reads, plus a sentinel the child refuses to run without.
      writeFileSync(
        join(pluginsRoot, "package.json"),
        JSON.stringify({ name: "omp-plugins", private: true, dependencies: { [PLUGIN_NAME]: packageVersion } }),
      );
      writeFileSync(
        join(pluginsRoot, "omp-plugins.lock.json"),
        JSON.stringify({ plugins: {}, settings: { [SENTINEL_PLUGIN]: { disposableRoot: true } } }, null, 2),
      );

      unpackPacked(pkgRoot);
      const report = loadPackedRuntime(hostRoot, pluginsRoot, project);
      const host = resolvedHost();

      // The exercised host artifact is the packed plugin's pinned optional peer.
      expect(host.version).toBe(peer[HOST_PACKAGE]);
      expect(report.host.version).toBe(host.version);
      expect(report.host.entry).toBe(host.entry);
      expect(report.host.root).toBe(host.root);

      // Native discovery: the packed plugin is enumerated from the disposable
      // plugin root and its manifest entry resolves to the packed file. The
      // merged manifest declares both extension entries, so this case asserts
      // its own entry is among them (the sibling packed case asserts the other).
      expect(report.packages).toEqual([{ name: PLUGIN_NAME, version: packageVersion, path: pkgRoot, scope: "user" }]);
      expect(report.extensionPaths).toContain(join(pkgRoot, "extensions", "model-handoff.js"));
      expect(report.packedEntry).toBe(join(pkgRoot, "extensions", "model-handoff.js"));

      // The packed factory loads through the host with no engine package present.
      expect(report.packedNodeModules).toBe(false);
      expect("error" in report.engineFromPackedRoot).toBe(true);
      expect(report.packed.errors).toEqual([]);
      expect(report.packed.tools).toEqual(["mstar_model_handoff"]);
      expect(report.packed.handlers).toEqual(EXTENSION_EVENTS);

      // The model-facing tool contract is the host's own schema.
      expect(report.schema.parsed).toEqual({ operation: "start", workflowId: "probe-iteration" });
      expect(report.schema.rejectsMissingWorkflowId).toContain("workflowId");

      // Settings API exercised for real: disabled is inert, enabled reaches the
      // inlined engine and refuses an unsafe workflow id. Both return before the
      // host's model action, so neither can report a model change; each refusal
      // is visible in the tool result rather than silent.
      expect(report.startInert).toMatchObject({ ok: false, isError: false, code: "preference-off" });
      expect(report.startInert.message.length).toBeGreaterThan(0);
      expect(report.startUnsafeWorkflow).toMatchObject({ ok: false, isError: true, code: "invalid-workflow" });
      expect(report.startUnsafeWorkflow.message.length).toBeGreaterThan(0);
      expect(report.fireWithoutBinding).toMatchObject({ ok: false, isError: true, code: "not-pending" });

      // Source entry parity: the same host loader binds the TS source to the
      // same tool and event wiring.
      expect(report.source.errors).toEqual([]);
      expect(report.source.tools).toEqual(report.packed.tools);
      expect(report.source.handlers).toEqual(report.packed.handlers);

      // Hook + tool bundles are self-contained: they load and execute against
      // the inlined engine in the same engine-free disposable root.
      expect(report.hook.errors).toEqual([]);
      expect(report.hook.handlers).toEqual(["tool_call"]);
      expect(report.hook.toolCallHandlers).toBe(1);
      expect(report.hook.benignResult).toBeNull();
      expect(report.tools.errors).toEqual([]);
      expect([...report.tools.loaded].sort()).toEqual([...TOOLS].sort());
      expect(report.tools.pathResolve).toContain(`harness: ${join(project, ".mstar")}`);
    },
    240_000,
  );

  test(
    "packed artifact loads phase2 orchestration and native settings",
    () => {
      const hostRoot = makeScratch("omp-phase2-bundle-host-");
      const project = join(hostRoot, "project");
      const pluginsRoot = join(hostRoot, ".omp", "plugins");
      const pkgRoot = join(pluginsRoot, "node_modules", "@mstar-harness", "omp");
      const pkg = manifest();
      const packageVersion = stringField(pkg, "version");
      const peer = (pkg.peerDependencies ?? {}) as Record<string, unknown>;
      mkdirSync(join(project, ".mstar"), { recursive: true });
      mkdirSync(pluginsRoot, { recursive: true });
      // Seed the disposable host root: the packaged plugin row the native plugin
      // enumeration reads, plus a sentinel the child refuses to run without.
      writeFileSync(
        join(pluginsRoot, "package.json"),
        JSON.stringify({ name: "omp-plugins", private: true, dependencies: { [PLUGIN_NAME]: packageVersion } }),
      );
      writeFileSync(
        join(pluginsRoot, "omp-plugins.lock.json"),
        JSON.stringify({ plugins: {}, settings: { [SENTINEL_PLUGIN]: { disposableRoot: true } } }, null, 2),
      );

      unpackPacked(pkgRoot);
      // Two child processes: the first writes the declared key through the
      // host's own settings path and exits; a *fresh* process then loads the
      // packed artifact again and must read the persisted value. Same-process
      // read-after-write could pass on a memory cache, session survival cannot.
      const writeReport = loadPhase2PackedRuntime(hostRoot, pluginsRoot, project, "write");
      const report = loadPhase2PackedRuntime(hostRoot, pluginsRoot, project, "read");
      const host = resolvedHost();

      // The exercised host artifact is the packed plugin's pinned optional peer.
      expect(host.version).toBe(peer[HOST_PACKAGE]);
      expect(report.host.version).toBe(host.version);
      expect(report.host.entry).toBe(host.entry);
      expect(report.host.root).toBe(host.root);

      // Native discovery: the packed entry resolves from the manifest, and it
      // coexists with the model-handoff entry rather than replacing it.
      expect(report.packages).toEqual([{ name: PLUGIN_NAME, version: packageVersion, path: pkgRoot, scope: "user" }]);
      expect(report.extensionPaths).toContain(join(pkgRoot, "extensions", "phase2-orchestration.js"));
      expect(report.extensionPaths).toContain(join(pkgRoot, "extensions", "model-handoff.js"));
      expect(report.packedEntry).toBe(join(pkgRoot, "extensions", "phase2-orchestration.js"));

      // The packed factory loads through the host with no engine package present.
      expect(report.packedNodeModules).toBe(false);
      expect("error" in report.engineFromPackedRoot).toBe(true);
      expect(report.packed.errors).toEqual([]);
      expect(report.packed.tools).toEqual([PHASE2_TOOL]);
      expect(report.packed.handlers).toEqual(PHASE2_EVENTS);

      // The published native settings schema is the manifest's own declaration.
      expect(report.packedManifestSettings).toMatchObject({
        phase2PlanInstances: { type: "boolean", default: false },
        maxPlanInstances: { type: "number", default: 2, min: 1, step: 1 },
      });
      expect(Object.keys(report.packedManifestSettings).sort()).toEqual(
        ["handoffTarget", "maxPlanInstances", "modelHandoff", "phase2PlanInstances"].sort(),
      );

      // The model-facing tool contract is the host's own schema: exact round
      // trips for two operations and a visible refusal per strictness rule.
      expect(report.schema.parsedBind).toEqual({
        operation: "bind",
        workflowId: "probe-iteration",
        coordinatorSessionPath: "/probe/session.json",
      });
      expect(report.schema.parsedCheckpoint).toEqual({
        operation: "checkpoint",
        reason: "before-wait",
        decision: "wait",
        note: "probe",
      });
      expect(report.schema.rejectsWrongTypeSessionPath).toContain("coordinatorSessionPath must be a string");
      expect(report.schema.rejectsCreatedWithoutTarget).toContain("requires the returned opaque target");
      expect(report.schema.rejectsUnknownOperation).toContain("operation must be");
      expect(report.schema.rejectsUnknownKey).toBeTruthy();

      // The inlined engine runs inside the packed extension: a real
      // coordinator-envelope read refuses, and an unbound session cannot check
      // point. Both are visible results rather than silent no-ops.
      expect(report.bindUnreadableEnvelope).toMatchObject({ ok: false, isError: true, code: "phase2.envelope-unreadable" });
      expect(report.bindUnreadableEnvelope.message.length).toBeGreaterThan(0);
      expect(report.checkpointUnbound).toMatchObject({ ok: false, isError: true, code: "phase2.not-bound" });

      // Native settings API exercised for real, across sessions: the writing
      // process observed its own write, and the fresh process that never wrote
      // anything still reads it from the host's settings store. Keys that were
      // never declared stay absent (the schema defaults apply), and the declared
      // minimum refuses a malformed capacity.
      expect(writeReport.settings).toMatchObject({ mode: "write", observed: { phase2PlanInstances: true } });
      expect(report.settings.mode).toBe("read");
      expect(report.settings.observed).toEqual({ phase2PlanInstances: true, maxPlanInstances: null });
      expect(report.settings.invalidCapacityAccepted).toBe(false);

      // Source entry parity: the same host loader binds the TS source to the
      // same tool and event wiring. (Compiled-vs-source loader coverage: the
      // packed entry above is the emitted bundle; this is the TS source path.)
      expect(report.source.errors).toEqual([]);
      expect(report.source.tools).toEqual(report.packed.tools);
      expect(report.source.handlers).toEqual(report.packed.handlers);
    },
    300_000,
  );
});
