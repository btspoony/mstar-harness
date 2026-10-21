import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareSemver,
  dshFallbacksSpec,
  dshFallbacksVersion,
  diagnoseZcodeHost,
  diagnoseOpencodeHost,
  diagnoseCodexHost,
  diagnoseCursorHost,
  diagnoseDshHost,
  diagnoseKimiHost,
  diagnoseOmpHost,
  detectCodexPluginVersion,
  detectCursorPluginVersionForScope,
  detectKimiPluginVersion,
  detectZcodePluginVersion,
  formatPluginVersionDoctorNote,
  globalInstallPath,
  isCodexAvailable,
  isDshAvailable,
  joinWithinRoot,
  kimiManagedRoot,
  legacyCodexMarketplaceNote,
  parseCodexInstalledEntries,
  parseCodexMarketplaceNames,
  parseDshLoaderEntries,
  projectInstallPath,
  readInstalledFallbacksVersion,
  resolveCliPath,
  resolveDshProfileDir,
  validateAgentPlugin,
} from "../src/index.js";
import { detectHost, resolveHarnessDir, resolveWorkflowDir } from "@mstar-harness/engine";
import { getLocalCommandDefinitions } from "../src/index.js";

const previousProjectRoot = process.env.MSTAR_CLI_PROJECT_ROOT;
const fixtures: string[] = [];

afterEach(() => {
  if (previousProjectRoot === undefined) delete process.env.MSTAR_CLI_PROJECT_ROOT;
  else process.env.MSTAR_CLI_PROJECT_ROOT = previousProjectRoot;
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "commands-host-health-"));
  fixtures.push(root);
  return root;
}

function writeJson(root: string, relative: string, value: unknown): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
function writeText(root: string, relative: string, value: string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
}
function writeOmpPluginTree(
  root: string,
  options: { identityExtension?: boolean; registerIdentityExtension?: boolean } = {},
): void {
  writeJson(root, "plugin.json", { name: "@mstar-harness/omp" });
  for (const skill of ["mstar-host", "mstar-harness-core", "pm"]) writeText(root, `skills/${skill}/SKILL.md`, "synthetic skill");
  for (const command of ["iteration-start", "iteration-drive", "iteration-loop", "codebase-audit"]) writeText(root, `commands/${command}.md`, "synthetic command");
  writeText(root, "skills/mstar-host/references/omp.md", "synthetic host reference");
  if (options.identityExtension !== false) writeText(root, "extensions/mcp-identity.js", "synthetic identity extension");
  writeJson(root, "package.json", { omp: { extensions: options.registerIdentityExtension === false ? [] : ["./extensions/mcp-identity.js"] } });
}


describe("shared host-health helpers", () => {
  test("shared path helpers resolve relative paths and reject lexical root escapes", () => {
    const root = fixture();
    process.env.MSTAR_CLI_PROJECT_ROOT = root;
    expect(resolveCliPath("docs/spec.md")).toBe(path.join(root, "docs/spec.md"));
    expect(joinWithinRoot(root, "child", "file.json")).toBe(path.join(root, "child", "file.json"));
    expect(() => joinWithinRoot(root, "..", "outside")).toThrow(`path escapes ${root}`);
  });

  test("path resolve reports reviewDir, honoring a .mstarc review_dir override outside the harness", async () => {
    const root = fixture();
    writeText(root, ".mstarc", "[config]\nharness_dir=.mstar\nreview_dir=process/reviews\n");
    mkdirSync(path.join(root, ".mstar"), { recursive: true });
    const definition = getLocalCommandDefinitions().find(({ id }) => id === "path.resolve");
    expect(definition).toBeDefined();
    if (!definition) return;
    // No control root, so the start directory is an explicit input: the
    // invocation cwd is then the host's launch directory, never a default.
    const result = await definition.execute({ path: root }, {
      cwd: root,
      controlRoot: null,
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal: new AbortController().signal,
      effects: {
        readInput: async () => "",
        spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
        startDashboard: async () => ({ url: "", close: async () => {} }),
        openBrowser: async () => {},
      },
    });
    expect(result).toMatchObject({
      status: "ok",
      data: {
        harnessDir: path.join(root, ".mstar"),
        specsDir: path.join(root, ".mstar", "specs"),
        workflowDir: path.join(root, ".mstar", "workflows"),
        projectDir: path.join(root, ".mstar", "projects"),
        // The override points outside the harness: the default would be
        // <root>/.mstar/reviews, so this proves the declaration is honored.
        reviewDir: path.join(root, "process", "reviews"),
      },
    });
  });

  test("shared semver comparison applies prerelease precedence", () => {
    // Comparator spec vectors: a zero core plus synthetic prerelease
    // identifiers. The bare core is the release counterpart any prerelease
    // sorts below — none of these is a repository version.
    const a = "0.0.0-synthetic-a";
    const a1 = "0.0.0-synthetic-a.1";
    const b = "0.0.0-synthetic-b";
    const release = "0.0.0";
    expect(compareSemver(a, a1)).toBeLessThan(0);
    expect(compareSemver(a1, b)).toBeLessThan(0);
    expect(compareSemver(release, a)).toBeGreaterThan(0);
  });

  test("shared manifest discovery selects the highest installed version and preserves note wording", () => {
    const project = fixture();
    const global = fixture();
    // Synthetic version constants, not release numbers.
    const projectVersion = "0.0.0-synthetic-a";
    const globalVersion = "0.0.0-synthetic-b";
    writeJson(project, ".cursor-plugin/plugin.json", { version: projectVersion });
    writeJson(global, "package.json", { version: globalVersion });
    expect(detectCursorPluginVersionForScope("project", { project, global })).toBe(projectVersion);
    expect(detectCursorPluginVersionForScope("global", { project, global })).toBe(globalVersion);
    expect(formatPluginVersionDoctorNote("cursor", globalVersion, globalVersion))
      .toBe(`Plugin/CLI versions aligned (${globalVersion}).`);
    expect(formatPluginVersionDoctorNote("cursor", globalVersion, null)).toContain("No installed Morning Star plugin found");
  });

  test("shared ZCode discovery tolerates missing manifests and orders cache versions", () => {
    const root = fixture();
    // Synthetic version constants: the cache-dir name is the version candidate.
    const lower = "0.0.0-synthetic-a";
    const higher = "0.0.0-synthetic-b";
    writeJson(root, `marketplace/morning-star-harness/${lower}/.zcode-plugin/plugin.json`, { version: lower });
    mkdirSync(path.join(root, "marketplace", "morning-star-harness", higher), { recursive: true });
    expect(detectZcodePluginVersion(root)).toBe(higher);
    expect(detectZcodePluginVersion(path.join(root, "missing"))).toBeNull();
  });

  test("shared agent-plugin validation reads fixtures and reports schema violations", () => {
    const root = fixture();
    writeJson(root, "plugin.json", {
      "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "fixture-plugin",
    });
    expect(validateAgentPlugin(root)).toMatchObject({ ok: true, errors: [], warnings: [] });
    writeJson(root, "plugin.json", { name: "Invalid--Name" });
    const invalid = validateAgentPlugin(root);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toContain('plugin.json: "$schema" is required and must be the string https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(invalid.errors.some((error) => error.includes("violates Agent Plugins name rules"))).toBe(true);
  });
});

describe("codex host health", () => {
  test("discovers Codex diagnostics from a synthetic host root", () => {
    const root = fixture();
    const legacyPath = path.join(root, ".agents", "plugins", "marketplace.json");
    writeJson(root, ".agents/plugins/marketplace.json", {
      plugins: [{ name: "morning-star-harness" }],
    });
    const result = diagnoseCodexHost((args) => {
      // Synthetic probe output; the version is never compared to a real one.
      if (args[0] === "--version") return "codex 0.0.0-synthetic";
      if (args[1] === "marketplace") return JSON.stringify({ marketplaces: [{ name: "mstar-repo" }] });
      return JSON.stringify({ installed: [{ pluginId: "morning-star-harness@mstar-repo" }] });
    }, legacyPath);
    expect(result.errors).toEqual([]);
    expect(result.notes).toEqual([
      `Legacy personal marketplace entry found at ${legacyPath} — the morning-star-harness plugin now installs from the repo marketplace (btspoony/mstar-harness). Remove the entry, then install: codex plugin add morning-star-harness@mstar-repo`,
    ]);
    // Synthetic installed-plugin version, echoed back by the detector.
    const installedVersion = "0.0.0-synthetic";
    expect(detectCodexPluginVersion(() => JSON.stringify({
      installed: [{ pluginId: "morning-star-harness@mstar-repo", version: installedVersion }],
    }))).toBe(installedVersion);
  });

  test("reports unavailable Codex and missing legacy artifacts from a synthetic root", () => {
    const root = fixture();
    const missingPath = path.join(root, ".agents", "plugins", "marketplace.json");
    const result = diagnoseCodexHost(() => {
      throw new Error("codex unavailable");
    }, missingPath);
    expect(result.errors).toEqual([
      "codex CLI not found on PATH. Install the Codex CLI (https://github.com/openai/codex), e.g. `npm install -g @openai/codex`, then re-run init.",
    ]);
    expect(result.notes).toEqual([]);
    expect(isCodexAvailable(() => { throw new Error("codex unavailable"); })).toBe(false);
    expect(() => parseCodexInstalledEntries("{ invalid json")).toThrow();
    expect(parseCodexMarketplaceNames(JSON.stringify({ marketplaces: [{ name: "mstar-repo" }, {}, null] })))
      .toEqual(["mstar-repo"]);
    expect(legacyCodexMarketplaceNote(JSON.stringify({ plugins: [] }), missingPath)).toBeNull();
  });
});
describe("kimi host health", () => {
  test("discovers the Kimi managed root and installed plugin from a synthetic host root", () => {
    const home = fixture();
    const managedRoot = kimiManagedRoot(home);
    // Synthetic version constant, not a release number.
    const installedVersion = "0.0.0-synthetic";
    writeJson(home, "plugins/managed/morning-star-harness/.kimi-plugin/plugin.json", { version: installedVersion });

    expect(managedRoot).toBe(path.join(home, "plugins", "managed"));
    expect(detectKimiPluginVersion(home)).toBe(installedVersion);
    expect(diagnoseKimiHost(home)).toEqual({ location: managedRoot, errors: [], notes: [] });
  });

  test("reports a missing plugin artifact without failing diagnostics", () => {
    const home = fixture();

    expect(detectKimiPluginVersion(home)).toBeNull();
    expect(diagnoseKimiHost(home)).toEqual({
      location: kimiManagedRoot(home),
      errors: [],
      notes: [],
    });
  });
});

describe("cursor host health", () => {
  test("discovers and validates a synthetic project plugin checkout", () => {
    const projectRoot = fixture();
    const pluginRoot = projectInstallPath(projectRoot);
    mkdirSync(path.join(pluginRoot, ".git"), { recursive: true });
    // Synthetic version constant, not a release number.
    writeJson(pluginRoot, ".cursor-plugin/plugin.json", { version: "0.0.0-synthetic" });
    for (const agent of ["fullstack-dev", "qc-specialist"]) {
      const file = path.join(pluginRoot, "agents", `${agent}.md`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `---\nname: ${agent}\ndescription: test\nmodel: test\n---\n`);
    }

    expect(globalInstallPath(projectRoot)).toBe(
      path.join(projectRoot, ".cursor", "plugins", "local", "morning-star-harness"),
    );
    expect(diagnoseCursorHost("project", { project: pluginRoot })).toEqual({
      location: pluginRoot,
      errors: [],
    });
  });

  test("reports a missing Cursor plugin marker from a synthetic root", () => {
    const pluginRoot = fixture();
    mkdirSync(path.join(pluginRoot, ".git"), { recursive: true });
    for (const agent of ["fullstack-dev", "qc-specialist"]) {
      const file = path.join(pluginRoot, "agents", `${agent}.md`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `---\nname: ${agent}\ndescription: test\nmodel: test\n---\n`);
    }

    expect(diagnoseCursorHost("global", { global: pluginRoot }).errors).toEqual([
      `Missing marker file: ${path.join(pluginRoot, ".cursor-plugin/plugin.json")}`,
    ]);
  });
});
describe("opencode host health", () => {
  test("discovers and validates a synthetic OpenCode config root", () => {
    const root = fixture();
    writeJson(root, "opencode.json", {
      $schema: "https://opencode.ai/config.json",
      // Synthetic slot version; the detector only matches the owned spec shape.
      plugin: ["@mstar-harness/opencode@0.0.0-synthetic"],
    });

    expect(diagnoseOpencodeHost(root, [])).toEqual({
      location: path.join(root, "opencode.json"),
      errors: [],
      warnings: [],
    });
  });

  test("reports a missing OpenCode config artifact from a synthetic root", () => {
    const root = fixture();

    expect(diagnoseOpencodeHost(root, [])).toEqual({
      location: path.join(root, "opencode.json"),
      errors: [`Missing config file: ${path.join(root, "opencode.json")}`],
      warnings: [],
    });
  });
});
describe("doctor OpenCode scope", () => {
  test("validates the OpenCode config root selected by project or global scope", async () => {
    const home = fixture();
    const projectRoot = fixture();
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    process.env.MSTAR_CLI_PROJECT_ROOT = projectRoot;
    const config = {
      $schema: "https://opencode.ai/config.json",
      plugin: ["@mstar-harness/opencode@latest"],
      mcp: {
        servers: {
          "morning-star": { type: "local", command: ["npx", "-y", "@mstar-harness/cli", "mcp"] },
        },
      },
    };
    writeJson(home, path.join(".config", "opencode", "opencode.json"), config);
    writeJson(projectRoot, "opencode.json", config);
    const definition = getLocalCommandDefinitions().find(({ id }) => id === "doctor");
    expect(definition).toBeDefined();
    if (!definition) return;
    const context = {
      cwd: projectRoot,
      controlRoot: projectRoot,
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal: new AbortController().signal,
      effects: {
        readInput: async () => "",
        spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
        startDashboard: async () => ({ url: "", close: async () => {} }),
        openBrowser: async () => {},
      },
    };
    try {
      const global = await definition.execute({ target: "opencode", scope: "global", generation: "v1" }, context);
      const project = await definition.execute({ target: "opencode", scope: "project", generation: "v1" }, context);
      expect(global).toMatchObject({
        status: "ok",
        data: { location: path.join(home, ".config", "opencode", "opencode.json") },
      });
      expect(project).toMatchObject({ status: "ok", data: { location: path.join(projectRoot, "opencode.json") } });
    } finally {
      homedir.mockRestore();
    }
  });
  test("checks the project OpenCode MCP row in the project config", async () => {
    const home = fixture();
    const projectRoot = fixture();
    const homedir = spyOn(os, "homedir").mockReturnValue(home);
    process.env.MSTAR_CLI_PROJECT_ROOT = projectRoot;
    const projectConfigPath = "opencode.json";
    const host = { $schema: "https://opencode.ai/config.json", plugin: ["@mstar-harness/opencode@latest"] };
    writeJson(home, path.join(".config", "opencode", "opencode.json"), {
      mcp: { servers: { unrelated: { type: "local", command: ["other"] } } },
    });
    writeJson(projectRoot, projectConfigPath, {
      ...host,
      mcp: {
        servers: {
          "morning-star": { type: "local", command: ["npx", "-y", "@mstar-harness/cli", "mcp"] },
        },
      },
    });
    const definition = getLocalCommandDefinitions().find(({ id }) => id === "doctor");
    expect(definition).toBeDefined();
    if (!definition) return;
    const context = {
      cwd: projectRoot,
      controlRoot: projectRoot,
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal: new AbortController().signal,
      effects: {
        readInput: async () => "",
        spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
        startDashboard: async () => ({ url: "", close: async () => {} }),
        openBrowser: async () => {},
      },
    };
    try {
      const result = await definition.execute({ target: "opencode", scope: "project", generation: "v1" }, context);
      expect(result).toMatchObject({
        status: "ok",
        data: { mcpHealth: { status: "aligned", location: path.join(projectRoot, projectConfigPath) } },
      });
    } finally {
      homedir.mockRestore();
    }
  });
});


describe("omp host health", () => {
  test("validates the selected installed omp plugin tree", () => {
    const harnessRepo = fixture();
    const installedRoot = path.join(harnessRepo, "installed-omp");
    writeOmpPluginTree(installedRoot);
    expect(diagnoseOmpHost({
      harnessRepoPath: harnessRepo,
      scope: "global",
      ompAvailable: true,
      installedPlugins: [{ name: "@mstar-harness/omp", path: installedRoot, enabled: true }],
      localHarnessRepoErrors: [],
    })).toEqual({ location: harnessRepo, errors: [] });
  });

  test("falls back to the repo package tree when no installed omp entry exists", () => {
    const harnessRepo = fixture();
    const result = diagnoseOmpHost({
      harnessRepoPath: harnessRepo,
      scope: "global",
      ompAvailable: true,
      installedPlugins: [],
      localHarnessRepoErrors: [],
    });
    expect(result.errors).toContain(`Missing omp plugin marker: ${path.join(harnessRepo, "packages", "omp", "plugin.json")}`);
    expect(result.errors).toContain(`Missing omp host reference: ${path.join(harnessRepo, "packages", "omp", "skills", "mstar-host", "references", "omp.md")}`);
  });

  test("reports a missing session identity extension in the installed omp plugin", () => {
    const harnessRepo = fixture();
    const installedRoot = path.join(harnessRepo, "installed-omp");
    writeOmpPluginTree(installedRoot, { identityExtension: false });
    const result = diagnoseOmpHost({
      harnessRepoPath: harnessRepo,
      scope: "global",
      ompAvailable: true,
      installedPlugins: [{ name: "@mstar-harness/omp", path: installedRoot, enabled: true }],
      localHarnessRepoErrors: [],
    });
    expect(result.errors).toContain(
      `Missing omp MCP session identity injection extension: ${path.join(installedRoot, "extensions", "mcp-identity.js")}. Update @mstar-harness/omp and enable its mcp-identity extension; ACTIVE workflow registration requires the host to supply sessionId on each MCP call.`,
    );
  });

  test("reports when the installed omp manifest omits identity extension registration", () => {
    const harnessRepo = fixture();
    const installedRoot = path.join(harnessRepo, "installed-omp");
    writeOmpPluginTree(installedRoot, { registerIdentityExtension: false });
    const result = diagnoseOmpHost({
      harnessRepoPath: harnessRepo,
      scope: "global",
      ompAvailable: true,
      installedPlugins: [{ name: "@mstar-harness/omp", path: installedRoot, enabled: true }],
      localHarnessRepoErrors: [],
    });
    expect(result.errors).toContain(
      `omp MCP session identity injection is not registered in ${path.join(installedRoot, "package.json")}. Update @mstar-harness/omp so its mcp-identity extension supplies sessionId for ACTIVE workflow registration.`,
    );
  });
});

const DSH_DUMP_BOTH = [
  "# == @mstar-harness/dsh",
  "- id: mstar",
  "  name: '@mstar-harness/dsh'",
  "  config: {}",
  "# == dsh-llm-fallbacks",
  "- id: llm-fallbacks",
  "  name: dsh-llm-fallbacks",
  "  config: {}",
  "",
].join("\n");

const DSH_DUMP_FALLBACKS_DISABLED = [
  "# == @mstar-harness/dsh",
  "- id: mstar",
  "  name: '@mstar-harness/dsh'",
  "# == dsh-llm-fallbacks",
  "- id: llm-fallbacks",
  "  name: dsh-llm-fallbacks",
  "  enabled: false",
  "",
].join("\n");

function dshProbe(dump: string): (args: string[]) => string {
  return (args) => {
    // Synthetic probe output; the version is never compared to a real one.
    if (args[0] === "--version") return "dsh 0.0.0-synthetic";
    if (args.includes("--dump-config")) return dump;
    throw new Error(`unexpected dsh args: ${args.join(" ")}`);
  };
}

describe("dsh host health", () => {
  test("discovers dsh diagnostics from a synthetic host root", () => {
    const root = fixture();
    writeJson(root, "profiles/web/node_modules/dsh-llm-fallbacks/package.json", {
      version: dshFallbacksVersion(),
    });
    const profileDir = resolveDshProfileDir(root);
    expect(profileDir).toBe(path.join(root, "profiles", "web"));

    const mounted = diagnoseDshHost(dshProbe(DSH_DUMP_BOTH), { dshHome: root });
    expect(mounted.location).toBe(profileDir);
    expect(mounted.errors).toEqual([]);
    expect(mounted.notes).toEqual([
      "@mstar-harness/dsh: mounted",
      `${dshFallbacksSpec()}: mounted`,
    ]);

    const disabled = diagnoseDshHost(dshProbe(DSH_DUMP_FALLBACKS_DISABLED), { dshHome: root });
    expect(disabled.notes).toEqual([
      "@mstar-harness/dsh: mounted",
      `${dshFallbacksSpec()}: disabled`,
    ]);
    expect(disabled.errors).toEqual([
      `${dshFallbacksSpec()} is disabled. Enable it (e.g. remove the disable entry from cordis.patch.yml) and re-run doctor.`,
    ]);
    expect(parseDshLoaderEntries(DSH_DUMP_FALLBACKS_DISABLED)?.find((entry) => entry.name === "dsh-llm-fallbacks")?.enabled)
      .toBe(false);
  });

  test("reports a missing dsh artifact from a synthetic root", () => {
    const root = fixture();
    const profileDir = resolveDshProfileDir(root);
    expect(readInstalledFallbacksVersion(profileDir)).toBeNull();

    const missing = diagnoseDshHost(dshProbe(DSH_DUMP_BOTH), { dshHome: root });
    expect(missing.location).toBe(profileDir);
    expect(missing.notes).toEqual([
      "@mstar-harness/dsh: mounted",
      `${dshFallbacksSpec()}: drifted (installed unknown, pinned ${dshFallbacksVersion()})`,
    ]);
    expect(missing.errors).toEqual([
      `${dshFallbacksSpec()} is drifted (profile has unknown, harness pins ${dshFallbacksVersion()}). Run: mstar-harness init --target dsh`,
    ]);

    const unavailable = diagnoseDshHost(() => {
      throw new Error("dsh unavailable");
    }, { dshHome: root });
    expect(unavailable.location).toBe(profileDir);
    expect(unavailable.notes).toEqual([]);
    expect(unavailable.errors).toEqual([
      "dsh CLI not found on PATH. Install the DeepSeek Harness CLI (@deepseek-ai/dsh), e.g. `pnpm add -g @deepseek-ai/dsh` or `npm install -g @deepseek-ai/dsh`, then re-run init.",
    ]);
    expect(isDshAvailable(() => {
      throw new Error("dsh unavailable");
    })).toBe(false);
    expect(parseDshLoaderEntries("not a loader dump")).toBeNull();
  });
});

describe("zcode host health", () => {
  test("discovers ZCode diagnostics from synthetic host roots", () => {
    const root = fixture();
    const pluginsRoot = path.join(root, "plugins");
    const harnessRepoPath = path.join(root, "harness");
    mkdirSync(path.join(harnessRepoPath, ".zcode-plugin"), { recursive: true });
    writeJson(harnessRepoPath, ".zcode-plugin/plugin.json", { name: "morning-star-harness" });
    writeJson(pluginsRoot, "known_marketplaces.json", {
      marketplaces: [{ id: "mstar-local", source: { source: "github", repo: "btspoony/mstar-harness" } }],
    });
    writeJson(pluginsRoot, "marketplaces/mstar-local/marketplace.json", {
      name: "mstar-local",
      plugins: [{ name: "morning-star-harness", source: { source: "github", repo: "btspoony/mstar-harness" } }],
    });
    for (const agent of ["fullstack-dev", "qc-specialist"]) {
      writeText(harnessRepoPath, `agents/${agent}.md`, `agent: ${agent}`);
    }

    expect(diagnoseZcodeHost("global", { pluginsRoot, harnessRepoPath })).toEqual({
      location: path.join(pluginsRoot, "known_marketplaces.json"),
      errors: [],
    });
  });

  test("reports missing ZCode marketplace and agent artifacts", () => {
    const root = fixture();
    const pluginsRoot = path.join(root, "plugins");
    const harnessRepoPath = path.join(root, "harness");
    mkdirSync(path.join(harnessRepoPath, ".zcode-plugin"), { recursive: true });
    writeJson(harnessRepoPath, ".zcode-plugin/plugin.json", { name: "morning-star-harness" });
    writeJson(pluginsRoot, "known_marketplaces.json", {
      marketplaces: [{ id: "mstar-local", source: { source: "github", repo: "btspoony/mstar-harness" } }],
    });

    expect(diagnoseZcodeHost("global", { pluginsRoot, harnessRepoPath }).errors).toEqual([
      `Missing plugin agents directory: ${path.join(harnessRepoPath, "agents")}`,
      `Missing ZCode marketplace: ${path.join(pluginsRoot, "marketplaces", "mstar-local", "marketplace.json")}`,
    ]);
  });
});
describe("trusted root, author.declared ignore, and host capability", () => {
  test("trusted root path reads resolve without Git root discovery", () => {
    const root = fixture();
    const nested = path.join(root, "nested");
    const harness = path.join(root, ".mstar");
    mkdirSync(nested, { recursive: true });
    mkdirSync(harness);
    expect(resolveHarnessDir(nested, { workspaceRoot: root })).toBe(harness);
    expect(resolveWorkflowDir(nested, { workspaceRoot: root })).toBe(path.join(harness, "workflows"));
  });

  test("author.declared ignore policy is retained during scaffold", async () => {
    const root = fixture();
    const ignore = "# authored policy\n/.mstar/**\n";
    writeText(root, ".gitignore", ignore);
    const definition = getLocalCommandDefinitions().find(({ id }) => id === "harness.scaffold");
    expect(definition).toBeDefined();
    if (!definition) return;
    const context = {
      cwd: root, controlRoot: root,
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal: new AbortController().signal,
      effects: {
        readInput: async () => "",
        spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
        startDashboard: async () => ({ url: "", close: async () => {} }),
        openBrowser: async () => {},
      },
    };
    const result = await definition.execute({ path: root }, context);
    expect(result.status).toBe("ok");
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(ignore);
  });

  test("host capability signals are explicit and resolve correctly", () => {
    expect(detectHost(["task_agent_batch"])).toBe("omp");
  });
});
