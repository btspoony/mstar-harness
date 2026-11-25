/**
 * Engine-absent inertness (Slice 5, roadmap §8.5 C4/D2) — subprocess fixture.
 *
 * When `@mstar-harness/engine` is genuinely missing from the install, the
 * plugin MODULE cannot even load (static `import` failure — architectural;
 * the host disables the plugin and no hook ever runs). The observable
 * in-process guard is the wrappers' never-throw contract: a broken or
 * unavailable engine surfaces as ONE `error` log line ("... validation
 * aborted: <cause>") plus a `null`/degraded result, and the hook never
 * throws — in BOTH warn and hard mode. The omp command-layer enforcement
 * point (the `command -v mstar-harness` guard) is covered by
 * dispatch-preflight-commands.test.ts.
 *
 * This fixture spawns a real `bun` subprocess against a temp project whose
 * `node_modules/@mstar-harness/engine` is a STUB whose validation entry
 * points throw `engine unavailable`; loads the ACTUAL plugin source, drives
 * `tool.execute.before` on both the dispatch (`task`) and status-write
 * (`write`) paths, and asserts the hook completes without throwing while
 * validation aborts are logged. The MCP stdio server runs in the CLI process
 * and is not part of this plugin-hook validation-failure test. It never depends
 * on the real `mstar-harness` install.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every runtime export the plugin imports, throwing like a dead engine.
 * Mirrors the CURRENT import surface of src/mstar.ts (dispatch composition
 * is a single engine call now — `composeDispatchGate`).
 */
const ENGINE_STUB = `const unavailable = () => {
  throw new Error("engine unavailable");
};
export const applyEnforcement = unavailable;
export const assertStoreRuntimeSupported = unavailable;
export const caseFoldedDocKind = unavailable;
export const caseFoldedRegisterRoot = unavailable;
export const composeDispatchGate = unavailable;
export const decodeExecutionSessionRef = unavailable;
export const detectStoreRuntime = unavailable;
export const probeCollaborationAuthority = unavailable;
export const executionContextFor = unavailable;
export const extractFrontmatterAndBody = unavailable;
export const harnessDocKindOfTarget = unavailable;
export const isReadOnlyAssignmentRole = unavailable;
export const isStoreAuthorityTarget = unavailable;
export const landedPathOf = unavailable;
export const parseAssignmentFields = unavailable;
export const parseSimpleFrontmatter = unavailable;
export const queryDashboard = unavailable;
export const readJson = unavailable;
export const resolveExecutionReadRoute = unavailable;
export const resolveHarnessDir = unavailable;
export const resolveProjectDir = unavailable;
export const resolveRepoEnforcement = unavailable;
export const resolveWorkflowDir = unavailable;
export const resumeExecutionSession = unavailable;
export const serializeExecutionValue = unavailable;
export const validateExecutionIdentity = unavailable;
export const validateProjectRegister = unavailable;
export const validateStatus = unavailable;
export const validateWorkflowSnapshot = unavailable;
export const withStoreRead = unavailable;
export class SymlinkResolutionError extends Error {}
`;

/** Probe: load the real plugin source, drive the hook, report no-throw + abort logs. */
const PROBE = `
import { MorningStarHarnessPlugin } from "./src/mstar.ts";

const plugin = await MorningStarHarnessPlugin();
const beforeExecute = plugin["tool.execute.before"];

const logs: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  logs.push(args.map(String).join(" "));
};

let threw: unknown = null;
try {
  // Dispatch path: task tool with a hard Assignment.
  await beforeExecute(
    { tool: "task", sessionID: "s1", callID: "c1" },
    { args: { subagent_type: "fullstack-dev", prompt: "## Assignment\\n\\n**Enforcement**: hard\\n" } },
  );
  // Status path: write tool targeting a harness status.json.
  await beforeExecute(
    { tool: "write", sessionID: "s1", callID: "c2" },
    { args: { filePath: "proj/.mstar/status.json", content: "{}" } },
  );
} catch (error) {
  threw = error;
}
console.error = originalError;

if (threw !== null) {
  console.error("PROBE: hook threw: " + (threw as Error).message);
  process.exit(1);
}
const aborted = logs.filter((l) => l.includes("validation aborted") && l.includes("engine unavailable"));
if (aborted.length < 2) {
  console.error("PROBE: expected dispatch + status abort logs, got: " + logs.join(" | "));
  process.exit(2);
}
console.log("PROBE_OK");
`;

describe("engine-absent inertness (subprocess fixture)", () => {
  test("hook never throws when the engine validation layer is unavailable", () => {
    const project = mkdtempSync(join(tmpdir(), "mstar-engine-absent-"));
    try {
      // Stub engine package (bare specifier resolved from the temp project).
      const engineDir = join(project, "node_modules", "@mstar-harness", "engine");
      mkdirSync(engineDir, { recursive: true });
      writeFileSync(
        join(engineDir, "package.json"),
        JSON.stringify({ name: "@mstar-harness/engine", type: "module", main: "index.js" }),
        "utf8",
      );
      writeFileSync(join(engineDir, "index.js"), ENGINE_STUB, "utf8");

      // The ACTUAL plugin source, loaded from the temp project so the stub
      // engine (not the repo install) is resolved.
      mkdirSync(join(project, "src"));
      copyFileSync(join(import.meta.dir, "../src/mstar.ts"), join(project, "src", "mstar.ts"));
      writeFileSync(
        join(project, "src", "mcp.js"),
        "export const createOpenCodeMcpTools = () => ({});\nexport const closeOpenCodeMcpSession = async () => {};\n",
        "utf8",
      );

      const probePath = join(project, "probe.ts");
      writeFileSync(probePath, PROBE, "utf8");

      const result = spawnSync(process.execPath, [probePath], {
        cwd: project,
        encoding: "utf8",
        env: { ...process.env, MSTAR_HARNESS_DIR: "" },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PROBE_OK");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

/**
 * V1 host loader parity (Task 4): agent and command front matter carrying
 * nested `tools:`/`permission:` block maps must come out of the V1 loaders as
 * the exact object an independent `parseSimpleFrontmatter` of the same bytes
 * produces — and the loader must reach that object through the shared reader.
 * The V1 loaders are module-private, so the probes drive the real plugin
 * source in a subprocess against a fixture package layout whose engine shim
 * re-exports the real src with call recording on the two reader exports.
 */
/** Absolute path of the real engine source: the shim re-exports it so the
 * copied plugin and the probe resolve one reader implementation. */
const engineIndexPath = join(import.meta.dir, "../../engine/src/index.ts");

/** T4-R2 instrumentation: the shim forwards `parseSimpleFrontmatter` and
 * `extractFrontmatterAndBody` to the real implementation while recording
 * every call and its input, so the probe can prove the real loader — not a
 * local parser in the plugin — read the fixture bytes. Explicit exports
 * shadow the same names in the `export *` re-export. */
const ENGINE_SHIM = `export * from ${JSON.stringify(engineIndexPath)};
import {
  parseSimpleFrontmatter as realParseSimpleFrontmatter,
  extractFrontmatterAndBody as realExtractFrontmatterAndBody,
} from ${JSON.stringify(engineIndexPath)};

export const __readerCalls = [];
export function parseSimpleFrontmatter(input, source) {
  __readerCalls.push({ fn: "parseSimpleFrontmatter", input });
  return realParseSimpleFrontmatter(input, source);
}
export function extractFrontmatterAndBody(input) {
  __readerCalls.push({ fn: "extractFrontmatterAndBody", input });
  return realExtractFrontmatterAndBody(input);
}
`;

/** The fixture package layout every parity probe shares: instrumented engine
 * shim, the ACTUAL plugin source and the MCP stub. Fixture markdown is the
 * caller's own. */
const scaffoldPluginProject = (project: string): void => {
  const engineDir = join(project, "node_modules", "@mstar-harness", "engine");
  mkdirSync(engineDir, { recursive: true });
  writeFileSync(
    join(engineDir, "package.json"),
    JSON.stringify({ name: "@mstar-harness/engine", type: "module", main: "index.js" }),
    "utf8",
  );
  writeFileSync(join(engineDir, "index.js"), ENGINE_SHIM, "utf8");

  mkdirSync(join(project, "src"));
  copyFileSync(join(import.meta.dir, "../src/mstar.ts"), join(project, "src", "mstar.ts"));
  writeFileSync(
    join(project, "src", "mcp.js"),
    "export const createOpenCodeMcpTools = () => ({});\nexport const closeOpenCodeMcpSession = async () => {};\n",
    "utf8",
  );
};

/** Probe: load the real plugin source, drive the config hook, compare the
 * loaded objects against an independent parse through the real implementation
 * (imported by absolute path, never through the instrumented shim), and prove
 * the loader invoked the shared reader on the exact fixture bytes. */
const PARITY_PROBE = `
import { MorningStarHarnessPlugin } from "./src/mstar.ts";
import { __readerCalls } from "@mstar-harness/engine";
import { extractFrontmatterAndBody, parseSimpleFrontmatter } from ${JSON.stringify(engineIndexPath)};
import { readFileSync } from "node:fs";

const fail = (message: string): never => {
  console.error("PROBE: " + message);
  process.exit(1);
};

const agentRaw = readFileSync("./harness-agents/nested-seat.md", "utf8");
const commandRaw = readFileSync("./harness-commands/nested-command.md", "utf8");
const parsedAgent = parseSimpleFrontmatter(extractFrontmatterAndBody(agentRaw).frontmatter);
const parsedCommand = parseSimpleFrontmatter(extractFrontmatterAndBody(commandRaw).frontmatter);

// The oracle parsing above already called the readers: only the plugin load
// below may account for the records the invocation assertions inspect.
__readerCalls.length = 0;

const plugin = await MorningStarHarnessPlugin();
const config: { agent?: Record<string, unknown>; command?: Record<string, unknown> } = {};
await plugin.config?.(config);

// T4-R2: the real loader must have driven BOTH shared readers — extraction
// with the raw fixture bytes, then the scalar parse with exactly the
// frontmatter slice extraction returns. A plugin that switched to a local
// parser leaves these arrays empty and fails here even when every output
// value matches.
const extractCalls = __readerCalls.filter((call) => call.fn === "extractFrontmatterAndBody");
const parseCalls = __readerCalls.filter((call) => call.fn === "parseSimpleFrontmatter");
if (!extractCalls.some((call) => call.input === agentRaw)) {
  fail("loader never passed the agent fixture bytes to extractFrontmatterAndBody");
}
if (!extractCalls.some((call) => call.input === commandRaw)) {
  fail("loader never passed the command fixture bytes to extractFrontmatterAndBody");
}
const agentFrontmatter = extractFrontmatterAndBody(agentRaw).frontmatter;
const commandFrontmatter = extractFrontmatterAndBody(commandRaw).frontmatter;
if (!parseCalls.some((call) => call.input === agentFrontmatter)) {
  fail("loader never passed the agent frontmatter to parseSimpleFrontmatter");
}
if (!parseCalls.some((call) => call.input === commandFrontmatter)) {
  fail("loader never passed the command frontmatter to parseSimpleFrontmatter");
}

const loadedAgent = config.agent?.["nested-seat"] as Record<string, unknown> | undefined;
if (!loadedAgent) fail("nested-seat missing from loaded agents");
for (const [key, value] of Object.entries(parsedAgent)) {
  if (JSON.stringify(loadedAgent[key]) !== JSON.stringify(value)) {
    fail("agent key " + key + " differs: " + JSON.stringify(loadedAgent[key]) + " vs " + JSON.stringify(value));
  }
}

const loadedCommand = config.command?.["nested-command"] as Record<string, unknown> | undefined;
if (!loadedCommand) fail("nested-command missing from loaded commands");
if (loadedCommand.description !== parsedCommand.description) fail("command description differs");
if (loadedCommand.agent !== parsedCommand.agent) fail("command agent differs");
if (loadedCommand.template !== "Drive the iteration.") fail("command template differs");

console.log("PROBE_OK");
`;

/** T4-R1 probe: one command whose nested permission map carries an
 * unsupported line. The loaders whitelist scalar keys, so the loader's
 * dependence on the shared reader's nested-map parsing is observable only
 * through the refusal propagating out of the config hook — attributed by the
 * loader's file-path source label, the document line and the recovery fix. */
const REFUSAL_PROBE = `
import { MorningStarHarnessPlugin } from "./src/mstar.ts";
import { join } from "node:path";

const fail = (message) => {
  console.error("PROBE: " + message);
  process.exit(1);
};

const plugin = await MorningStarHarnessPlugin();
const config = {};
let thrown;
try {
  await plugin.config?.(config);
} catch (error) {
  thrown = error;
}
if (!thrown) fail("the unsupported nested line did not refuse");
if (thrown.name !== "DocumentFrontmatterError") {
  fail("unexpected error type: " + String(thrown.name) + " / " + String(thrown.message));
}
// The loader passes the asset file path as the reader's source label, so the
// refusal attributes the violation: path, document line and recovery fix.
if (typeof thrown.source !== "string" || !thrown.source.endsWith(join("harness-commands", "nested-command.md"))) {
  fail("source not the asset path: " + String(thrown.source));
}
if (thrown.line !== 7) fail("line not propagated: " + String(thrown.line));
if (thrown.lineText !== '    "*": *deny') fail("lineText not propagated: " + JSON.stringify(thrown.lineText));
if (typeof thrown.fix !== "string" || thrown.fix.length === 0) fail("recovery fix not propagated: " + JSON.stringify(thrown.fix));
console.log("PROBE_REFUSED_OK");
`;

describe("host loader parity with nested front matter maps", () => {
  test("V1 agent and command loaders resolve nested tools/permission maps to the same objects", () => {
    const project = mkdtempSync(join(tmpdir(), "mstar-loader-parity-"));
    try {
      // The ACTUAL plugin source against an engine shim that re-exports the
      // real parser src — parity demands the same reader implementation on
      // both sides of the comparison, and the shim records the loader's calls.
      scaffoldPluginProject(project);

      // The fixture package layout the plugin loads agents and commands from
      // (`harness-agents/`, `harness-commands/` one level above src/).
      mkdirSync(join(project, "harness-agents"));

      writeFileSync(
        join(project, "harness-agents", "nested-seat.md"),
        '---\nname: nested-seat\ntools:\n  write: true\npermission:\n  edit:\n    "*": deny\n---\n\nSeat body.\n',
        "utf8",
      );
      mkdirSync(join(project, "harness-commands"));
      writeFileSync(
        join(project, "harness-commands", "nested-command.md"),
        '---\nname: nested-command\ndescription: Drive nested commands.\nagent: fullstack-dev\npermission:\n  edit:\n    "*": deny\n---\n\nDrive the iteration.\n',
        "utf8",
      );

      writeFileSync(join(project, "probe.ts"), PARITY_PROBE, "utf8");

      const result = spawnSync(process.execPath, [join(project, "probe.ts")], {
        cwd: project,
        encoding: "utf8",
        env: { ...process.env, MSTAR_HARNESS_DIR: "" },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PROBE_OK");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("an unsupported line inside a command's nested map propagates the shared reader's refusal", () => {
    const project = mkdtempSync(join(tmpdir(), "mstar-loader-refusal-"));
    try {
      scaffoldPluginProject(project);

      // T4-R1: the command loader whitelists scalar keys, so a valid nested
      // map can be dropped silently by a loader that never really parses it.
      // An unsupported line INSIDE the nested map makes the loader's
      // dependence on the shared reader observable: only a loader that hands
      // the whole frontmatter to parseSimpleFrontmatter surfaces this refusal.
      mkdirSync(join(project, "harness-commands"));
      writeFileSync(
        join(project, "harness-commands", "nested-command.md"),
        '---\nname: nested-command\ndescription: Drive nested commands.\nagent: fullstack-dev\npermission:\n  edit:\n    "*": *deny\n---\n\nDrive the iteration.\n',
        "utf8",
      );

      writeFileSync(join(project, "probe.ts"), REFUSAL_PROBE, "utf8");

      const result = spawnSync(process.execPath, [join(project, "probe.ts")], {
        cwd: project,
        encoding: "utf8",
        env: { ...process.env, MSTAR_HARNESS_DIR: "" },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PROBE_REFUSED_OK");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
