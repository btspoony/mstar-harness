import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DSH_LLM_FALLBACKS_VERSION } from "@mstar-harness/engine";
import {
  compareSemver,
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

  test("shared semver comparison applies prerelease precedence", () => {
    expect(compareSemver("2.0.0-rc.2", "2.0.0-rc.10")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "2.0.0-rc.10")).toBeGreaterThan(0);
  });

  test("shared manifest discovery selects the highest installed version and preserves note wording", () => {
    const project = fixture();
    const global = fixture();
    writeJson(project, ".cursor-plugin/plugin.json", { version: "1.2.0" });
    writeJson(global, "package.json", { version: "1.3.0" });
    expect(detectCursorPluginVersionForScope("project", { project, global })).toBe("1.2.0");
    expect(detectCursorPluginVersionForScope("global", { project, global })).toBe("1.3.0");
    expect(formatPluginVersionDoctorNote("cursor", "1.3.0", "1.3.0")).toBe("Plugin/CLI versions aligned (1.3.0).");
    expect(formatPluginVersionDoctorNote("cursor", "1.3.0", null)).toContain("No installed Morning Star plugin found");
  });

  test("shared ZCode discovery tolerates missing manifests and orders cache versions", () => {
    const root = fixture();
    writeJson(root, "marketplace/morning-star-harness/1.0.0/.zcode-plugin/plugin.json", { version: "1.0.0" });
    mkdirSync(path.join(root, "marketplace", "morning-star-harness", "2.1.0"), { recursive: true });
    expect(detectZcodePluginVersion(root)).toBe("2.1.0");
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
      if (args[0] === "--version") return "codex 0.144.1";
      if (args[1] === "marketplace") return JSON.stringify({ marketplaces: [{ name: "mstar-repo" }] });
      return JSON.stringify({ installed: [{ pluginId: "morning-star-harness@mstar-repo" }] });
    }, legacyPath);
    expect(result.errors).toEqual([]);
    expect(result.notes).toEqual([
      `Legacy personal marketplace entry found at ${legacyPath} — the morning-star-harness plugin now installs from the repo marketplace (btspoony/mstar-harness). Remove the entry, then install: codex plugin add morning-star-harness@mstar-repo`,
    ]);
    expect(detectCodexPluginVersion(() => JSON.stringify({
      installed: [{ pluginId: "morning-star-harness@mstar-repo", version: "3.6.3" }],
    }))).toBe("3.6.3");
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
    writeJson(home, "plugins/managed/morning-star-harness/.kimi-plugin/plugin.json", { version: "3.7.0" });

    expect(managedRoot).toBe(path.join(home, "plugins", "managed"));
    expect(detectKimiPluginVersion(home)).toBe("3.7.0");
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
    writeJson(pluginRoot, ".cursor-plugin/plugin.json", { version: "1.0.0" });
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
      plugin: ["@mstar-harness/opencode@3.11.2"],
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
      missingGitignoreEntries: [],
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
      missingGitignoreEntries: [],
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
      missingGitignoreEntries: [],
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
      missingGitignoreEntries: [],
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
    if (args[0] === "--version") return "dsh 0.1.0-rc.6";
    if (args.includes("--dump-config")) return dump;
    throw new Error(`unexpected dsh args: ${args.join(" ")}`);
  };
}

describe("dsh host health", () => {
  test("discovers dsh diagnostics from a synthetic host root", () => {
    const root = fixture();
    writeJson(root, "profiles/web/node_modules/dsh-llm-fallbacks/package.json", {
      version: DSH_LLM_FALLBACKS_VERSION,
    });
    const profileDir = resolveDshProfileDir(root);
    expect(profileDir).toBe(path.join(root, "profiles", "web"));

    const mounted = diagnoseDshHost(dshProbe(DSH_DUMP_BOTH), { dshHome: root });
    expect(mounted.location).toBe(profileDir);
    expect(mounted.errors).toEqual([]);
    expect(mounted.notes).toEqual([
      "@mstar-harness/dsh: mounted",
      `dsh-llm-fallbacks@${DSH_LLM_FALLBACKS_VERSION}: mounted`,
    ]);

    const disabled = diagnoseDshHost(dshProbe(DSH_DUMP_FALLBACKS_DISABLED), { dshHome: root });
    expect(disabled.notes).toEqual([
      "@mstar-harness/dsh: mounted",
      `dsh-llm-fallbacks@${DSH_LLM_FALLBACKS_VERSION}: disabled`,
    ]);
    expect(disabled.errors).toEqual([
      `dsh-llm-fallbacks@${DSH_LLM_FALLBACKS_VERSION} is disabled. Enable it (e.g. remove the disable entry from cordis.patch.yml) and re-run doctor.`,
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
      `dsh-llm-fallbacks@${DSH_LLM_FALLBACKS_VERSION}: drifted (installed unknown, pinned ${DSH_LLM_FALLBACKS_VERSION})`,
    ]);
    expect(missing.errors).toEqual([
      `dsh-llm-fallbacks@${DSH_LLM_FALLBACKS_VERSION} is drifted (profile has unknown, harness pins ${DSH_LLM_FALLBACKS_VERSION}). Run: mstar-harness init --target dsh`,
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
