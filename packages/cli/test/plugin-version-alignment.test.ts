/**
 * plugin-version-alignment — the shared CLI ↔ host-plugin version-alignment
 * module plus the moved zcode discovery/note pins (the former
 * zcode-adapter.test.ts).
 *
 * Fully hermetic: temp-dir roots and injected paths everywhere; the codex and
 * omp subprocess surfaces are tested at their JSON-parsing layer only (no
 * subprocesses). The doctor note builder is a plain string builder used for
 * the informational `notes` channel, so nothing here can reach `errors` or
 * the exit code.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCursorPluginVersion,
  detectCursorPluginVersionForScope,
  detectDshPluginVersion,
  detectInstalledPluginVersion,
  detectKimiPluginVersion,
  detectOpencodePluginVersion,
  detectZcodePluginVersion,
  formatPluginVersionDoctorNote,
  ompEntryVersion,
} from "../src/plugin-version-alignment";
import type { Target } from "../src/types";
import { parseCodexInstalledEntries } from "../src/adapters/codex";
import { OMP_LIST_TIMEOUT_MS, findInstalledPlugin, parseOmpPluginList } from "../src/adapters/omp";

const PLUGIN_DIR_NAME = "morning-star-harness";

/** Fresh temp dir; `withDir` removes it after `fn`. */
function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pva-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a JSON file, creating parent dirs. */
function writeJsonAt(filePath: string, value: unknown): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// zcode discovery (moved verbatim from batch 1)
// ---------------------------------------------------------------------------

interface VersionDirOptions {
  /** `version` written into `.zcode-plugin/plugin.json`. */
  zcodeManifestVersion?: string;
  /** `version` written into root `plugin.json`. */
  rootManifestVersion?: string;
  /** Write an unparseable `.zcode-plugin/plugin.json`. */
  malformedManifest?: boolean;
}

/** Materialize one cache version dir under `<cacheRoot>/<marketplace>/morning-star-harness/<dirName>/`. */
function makeVersionDir(
  cacheRoot: string,
  marketplace: string,
  dirName: string,
  opts: VersionDirOptions = {},
): string {
  const dir = join(cacheRoot, marketplace, PLUGIN_DIR_NAME, dirName);
  mkdirSync(dir, { recursive: true });
  if (opts.zcodeManifestVersion !== undefined) {
    mkdirSync(join(dir, ".zcode-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: PLUGIN_DIR_NAME, version: opts.zcodeManifestVersion }),
    );
  }
  if (opts.rootManifestVersion !== undefined) {
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: PLUGIN_DIR_NAME, version: opts.rootManifestVersion }));
  }
  if (opts.malformedManifest) {
    mkdirSync(join(dir, ".zcode-plugin"), { recursive: true });
    writeFileSync(join(dir, ".zcode-plugin", "plugin.json"), "{ not json");
  }
  return dir;
}

describe("detectZcodePluginVersion", () => {
  test("missing cache root reports null (no throw)", () => {
    expect(detectZcodePluginVersion(join(tmpdir(), "zcode-cache-does-not-exist"))).toBeNull();
  });

  test("empty cache root reports null", () => {
    withDir((cacheRoot) => {
      expect(detectZcodePluginVersion(cacheRoot)).toBeNull();
    });
  });

  test("manifest version wins over the directory name", () => {
    withDir((cacheRoot) => {
      makeVersionDir(cacheRoot, "mstar-local", "3.7.0", { zcodeManifestVersion: "3.6.0" });
      expect(detectZcodePluginVersion(cacheRoot)).toBe("3.6.0");
    });
  });

  test("root plugin.json is the manifest fallback when .zcode-plugin is absent", () => {
    withDir((cacheRoot) => {
      makeVersionDir(cacheRoot, "mstar-local", "3.7.0", { rootManifestVersion: "3.7.0" });
      expect(detectZcodePluginVersion(cacheRoot)).toBe("3.7.0");
    });
  });

  test("directory name is the fallback when no manifest carries a version", () => {
    withDir((cacheRoot) => {
      makeVersionDir(cacheRoot, "mstar-local", "3.7.0");
      expect(detectZcodePluginVersion(cacheRoot)).toBe("3.7.0");
    });
  });

  test("malformed manifest degrades to the directory name instead of throwing", () => {
    withDir((cacheRoot) => {
      makeVersionDir(cacheRoot, "mstar-local", "3.7.0", { malformedManifest: true });
      expect(detectZcodePluginVersion(cacheRoot)).toBe("3.7.0");
    });
  });

  test("multiple versions across marketplaces resolve to the highest semver", () => {
    withDir((cacheRoot) => {
      makeVersionDir(cacheRoot, "mstar-local", "3.6.0");
      makeVersionDir(cacheRoot, "other-marketplace", "3.7.0", { zcodeManifestVersion: "3.7.0" });
      makeVersionDir(cacheRoot, "mstar-local", "3.7.0-rc.1", { rootManifestVersion: "3.7.0-rc.1" });
      expect(detectZcodePluginVersion(cacheRoot)).toBe("3.7.0");
    });
  });

  test("non-version-shaped directories are ignored", () => {
    withDir((cacheRoot) => {
      makeVersionDir(cacheRoot, "mstar-local", "tmp-checkout");
      expect(detectZcodePluginVersion(cacheRoot)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// opencode discovery (package cache scan)
// ---------------------------------------------------------------------------

/** Materialize one cached spec dir: `<root>/@mstar-harness/<spec>/node_modules/@mstar-harness/opencode/package.json`. */
function makeOpencodeSpec(packagesRoot: string, spec: string, version: string | null): string {
  const pkgJson = join(packagesRoot, "@mstar-harness", spec, "node_modules", "@mstar-harness", "opencode", "package.json");
  if (version !== null) writeJsonAt(pkgJson, { name: "@mstar-harness/opencode", version });
  return pkgJson;
}

describe("detectOpencodePluginVersion", () => {
  test("missing packages root reports null (no throw)", () => {
    expect(detectOpencodePluginVersion(join(tmpdir(), "opencode-cache-does-not-exist"))).toBeNull();
  });

  test("reads the version from the spec's nested opencode package.json", () => {
    withDir((root) => {
      makeOpencodeSpec(root, "opencode@latest", "2.3.0");
      expect(detectOpencodePluginVersion(root)).toBe("2.3.0");
    });
  });

  test("multiple cached specs resolve to the highest semver", () => {
    withDir((root) => {
      makeOpencodeSpec(root, "opencode@2.3.0", "2.3.0");
      makeOpencodeSpec(root, "opencode@latest", "2.4.0");
      expect(detectOpencodePluginVersion(root)).toBe("2.4.0");
    });
  });

  test("spec without an installed opencode package contributes nothing", () => {
    withDir((root) => {
      mkdirSync(join(root, "@mstar-harness", "opencode@latest"), { recursive: true });
      expect(detectOpencodePluginVersion(root)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// cursor discovery (tolerant manifest read + scope fallback)
// ---------------------------------------------------------------------------

describe("detectCursorPluginVersion", () => {
  test(".cursor-plugin/plugin.json wins over package.json", () => {
    withDir((root) => {
      writeJsonAt(join(root, ".cursor-plugin", "plugin.json"), { name: PLUGIN_DIR_NAME, version: "3.6.3" });
      writeJsonAt(join(root, "package.json"), { version: "0.0.1" });
      expect(detectCursorPluginVersion(root)).toBe("3.6.3");
    });
  });

  test("package.json is the manifest fallback", () => {
    withDir((root) => {
      writeJsonAt(join(root, "package.json"), { version: "3.6.3" });
      expect(detectCursorPluginVersion(root)).toBe("3.6.3");
    });
  });

  test("absent install reports null (no throw)", () => {
    withDir((root) => {
      expect(detectCursorPluginVersion(root)).toBeNull();
    });
  });
});

describe("detectCursorPluginVersionForScope", () => {
  /** Injected path set: a present dir or a stable absent path. */
  const paths = (project: string | null, global: string | null) => ({
    project: project ?? join(tmpdir(), "pva-cursor-project-absent"),
    global: global ?? join(tmpdir(), "pva-cursor-global-absent"),
  });

  test("project scope prefers the project install", () => {
    withDir((project) => {
      withDir((globalDir) => {
        writeJsonAt(join(project, ".cursor-plugin", "plugin.json"), { version: "3.5.0" });
        writeJsonAt(join(globalDir, "package.json"), { version: "3.6.3" });
        expect(detectCursorPluginVersionForScope("project", paths(project, globalDir))).toBe("3.5.0");
      });
    });
  });

  test("project scope falls back to the global install when the project checkout is absent", () => {
    withDir((globalDir) => {
      writeJsonAt(join(globalDir, ".cursor-plugin", "plugin.json"), { version: "3.6.3" });
      expect(detectCursorPluginVersionForScope("project", paths(null, globalDir))).toBe("3.6.3");
    });
  });

  test("global scope ignores the project install", () => {
    withDir((project) => {
      withDir((globalDir) => {
        writeJsonAt(join(project, "package.json"), { version: "3.5.0" });
        expect(detectCursorPluginVersionForScope("global", paths(project, globalDir))).toBeNull();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// dsh discovery (default web profile only — the profile init/add operates on)
// ---------------------------------------------------------------------------

describe("detectDshPluginVersion", () => {
  test("missing dsh home reports null (no throw)", () => {
    expect(detectDshPluginVersion(join(tmpdir(), "dsh-home-does-not-exist"))).toBeNull();
  });

  test("reads the version from the default web profile", () => {
    withDir((home) => {
      writeJsonAt(join(home, "profiles", "web", "node_modules", "@mstar-harness", "dsh", "package.json"), { version: "3.7.0" });
      expect(detectDshPluginVersion(home)).toBe("3.7.0");
    });
  });

  test("a newer version in a NON-default profile does NOT win (Greptile P1)", () => {
    withDir((home) => {
      writeJsonAt(join(home, "profiles", "web", "node_modules", "@mstar-harness", "dsh", "package.json"), { version: "3.6.0" });
      writeJsonAt(join(home, "profiles", "headless", "node_modules", "@mstar-harness", "dsh", "package.json"), { version: "9.9.9" });
      expect(detectDshPluginVersion(home)).toBe("3.6.0");
    });
  });

  test("link installs resolve by reading through the symlinked dir", () => {
    withDir((home) => {
      withDir((target) => {
        writeJsonAt(join(target, "package.json"), { version: "3.7.0" });
        const link = join(home, "profiles", "web", "node_modules", "@mstar-harness", "dsh");
        mkdirSync(join(link, ".."), { recursive: true });
        symlinkSync(target, link, "dir");
        expect(detectDshPluginVersion(home)).toBe("3.7.0");
      });
    });
  });

  test("dsh home without the web profile plugin reports null", () => {
    withDir((home) => {
      mkdirSync(join(home, "profiles", "headless", "node_modules", "@mstar-harness", "dsh"), { recursive: true });
      expect(detectDshPluginVersion(home)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// kimi discovery (managed scan + tolerant manifest)
// ---------------------------------------------------------------------------

/** Materialize one kimi managed plugin root with an optional manifest set. */
function makeKimiPlugin(
  managedRoot: string,
  rel: string,
  manifests: Array<{ file: string; version: string }>,
): string {
  const dir = join(managedRoot, rel);
  mkdirSync(dir, { recursive: true });
  for (const manifest of manifests) {
    writeJsonAt(join(dir, manifest.file), { name: PLUGIN_DIR_NAME, version: manifest.version });
  }
  return dir;
}

describe("detectKimiPluginVersion", () => {
  test("missing KIMI_CODE_HOME reports null (no throw)", () => {
    expect(detectKimiPluginVersion(join(tmpdir(), "kimi-home-does-not-exist"))).toBeNull();
  });

  test("finds a plugin directly under plugins/managed (depth 1)", () => {
    withDir((home) => {
      makeKimiPlugin(join(home, "plugins", "managed"), PLUGIN_DIR_NAME, [
        { file: ".kimi-plugin/plugin.json", version: "3.7.0" },
      ]);
      expect(detectKimiPluginVersion(home)).toBe("3.7.0");
    });
  });

  test("finds a plugin nested to depth 3 but not depth 4", () => {
    withDir((home) => {
      const managed = join(home, "plugins", "managed");
      makeKimiPlugin(managed, join("marketplace", "cache", PLUGIN_DIR_NAME), [
        { file: "plugin.json", version: "3.7.0" },
      ]);
      expect(detectKimiPluginVersion(home)).toBe("3.7.0");

      makeKimiPlugin(managed, join("too", "deep", "nesting", PLUGIN_DIR_NAME), [
        { file: "plugin.json", version: "9.9.9" },
      ]);
      expect(detectKimiPluginVersion(home)).toBe("3.7.0");
    });
  });

  test("tolerant manifest read: .kimi-plugin wins, then plugin.json, then package.json", () => {
    withDir((home) => {
      makeKimiPlugin(join(home, "plugins", "managed"), PLUGIN_DIR_NAME, [
        { file: ".kimi-plugin/plugin.json", version: "3.7.0" },
        { file: "plugin.json", version: "3.6.0" },
        { file: "package.json", version: "3.5.0" },
      ]);
      expect(detectKimiPluginVersion(home)).toBe("3.7.0");
    });
  });

  test("multiple plugin roots resolve to the highest semver; other names are ignored", () => {
    withDir((home) => {
      const managed = join(home, "plugins", "managed");
      makeKimiPlugin(managed, PLUGIN_DIR_NAME, [{ file: "plugin.json", version: "3.6.0" }]);
      makeKimiPlugin(managed, join("other", PLUGIN_DIR_NAME), [{ file: "plugin.json", version: "3.7.0" }]);
      makeKimiPlugin(managed, "some-other-plugin", [{ file: "plugin.json", version: "9.9.9" }]);
      expect(detectKimiPluginVersion(home)).toBe("3.7.0");
    });
  });
});

// ---------------------------------------------------------------------------
// codex discovery (JSON-parsing layer only — no subprocesses)
// ---------------------------------------------------------------------------

describe("parseCodexInstalledEntries", () => {
  test("returns the full installed[] entries (pluginId + version readable)", () => {
    const dump = JSON.stringify({
      installed: [
        { pluginId: "documents@openai-primary-runtime", version: "26.905.11957" },
        { pluginId: `${PLUGIN_DIR_NAME}@mstar-repo`, version: "3.6.3", enabled: true },
      ],
    });
    const entries = parseCodexInstalledEntries(dump);
    expect(entries).toHaveLength(2);
    const mstar = entries.find((entry) => entry.pluginId === `${PLUGIN_DIR_NAME}@mstar-repo`);
    expect(mstar?.version).toBe("3.6.3");
  });

  test("missing installed key yields an empty list", () => {
    expect(parseCodexInstalledEntries(JSON.stringify({}))).toEqual([]);
  });

  test("non-object entries are dropped", () => {
    expect(parseCodexInstalledEntries(JSON.stringify({ installed: ["nope", 42, null] }))).toEqual([]);
  });

  test("invalid JSON throws (doctor catches and degrades to an error line)", () => {
    expect(() => parseCodexInstalledEntries("{ not json")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// omp discovery (JSON-parsing layer only — no subprocesses)
// ---------------------------------------------------------------------------

describe("parseOmpPluginList", () => {
  test("omp 17.x shape: npm + marketplace groups flatten into entries", () => {
    const parsed = parseOmpPluginList(
      JSON.stringify({
        npm: [{ name: "@mstar-harness/omp", version: "3.7.0" }],
        marketplace: [{ name: "other", version: "1.0.0" }],
      }),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.name).toBe("@mstar-harness/omp");
  });

  test("plain array input passes through; { plugins: [...] } is honored; garbage yields []", () => {
    expect(parseOmpPluginList(JSON.stringify([{ name: "a" }]))).toEqual([{ name: "a" }]);
    expect(parseOmpPluginList(JSON.stringify({ plugins: [{ name: "a" }] }))).toEqual([{ name: "a" }]);
    expect(parseOmpPluginList(JSON.stringify({ unrelated: true }))).toEqual([]);
  });
});

describe("findInstalledPlugin + ompEntryVersion", () => {
  test("finds the mstar entry by npm name and reads its version", () => {
    const plugins = parseOmpPluginList(
      JSON.stringify({
        npm: [
          { name: "unrelated", version: "1.0.0" },
          {
            name: "@mstar-harness/omp",
            version: "3.7.0",
            path: "/omp/plugins/node_modules/@mstar-harness/omp",
            manifest: { name: PLUGIN_DIR_NAME, version: "3.7.0" },
          },
        ],
      }),
    );
    const found = findInstalledPlugin(plugins);
    expect(found).toBeDefined();
    expect(ompEntryVersion(found!)).toBe("3.7.0");
  });

  test("version precedence: entry.version > manifest.version > package.json at path", () => {
    withDir((entryPath) => {
      writeJsonAt(join(entryPath, "package.json"), { version: "3.5.0" });
      expect(ompEntryVersion({ version: "3.7.0" })).toBe("3.7.0");
      expect(ompEntryVersion({ version: "not-semver", manifest: { version: "3.7.0" } })).toBe("3.7.0");
      expect(ompEntryVersion({ path: entryPath })).toBe("3.5.0");
    });
  });

  test("no readable version anywhere reports null", () => {
    expect(ompEntryVersion({})).toBeNull();
    expect(ompEntryVersion({ path: join(tmpdir(), "pva-omp-path-absent") })).toBeNull();
  });

  test("the omp probe stays bounded: OMP_LIST_TIMEOUT_MS is the codex-parity 10s ceiling", () => {
    // Drift guard for the Greptile P1 fix: the execFileSync timeout option in
    // listInstalledPlugins must keep this constant wired (a stalled omp must
    // degrade to the catch's empty listing, never block doctor).
    expect(OMP_LIST_TIMEOUT_MS).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// note builder — four states, per-host hints
// ---------------------------------------------------------------------------

const ALL_TARGETS: readonly Target[] = ["opencode", "cursor", "codex", "zcode", "omp", "dsh", "kimi"];

describe("formatPluginVersionDoctorNote", () => {
  test("aligned — same line for every target", () => {
    for (const target of ALL_TARGETS) {
      expect(formatPluginVersionDoctorNote(target, "3.7.0", "3.7.0")).toBe(
        "Plugin/CLI versions aligned (3.7.0).",
      );
    }
  });

  test("plugin newer — the global-CLI update prompt is identical for every target", () => {
    for (const target of ALL_TARGETS) {
      expect(formatPluginVersionDoctorNote(target, "3.7.0", "3.8.0")).toBe(
        "Installed plugin 3.8.0 is newer than CLI 3.7.0 \u2014 update the global CLI: npm i -g @mstar-harness/cli@latest (or @3.8.0).",
      );
    }
  });

  test("CLI newer: zcode keeps the Plugin Management prompt (batch-1 wording)", () => {
    expect(formatPluginVersionDoctorNote("zcode", "3.8.0", "3.7.0")).toBe(
      "CLI 3.8.0 is newer than installed plugin 3.7.0 \u2014 update the Morning Star plugin in ZCode (Settings \u2192 Plugin Management \u2192 update from the mstar-local marketplace).",
    );
  });

  test("CLI newer: per-host plugin update hints (batch-2 hosts)", () => {
    expect(formatPluginVersionDoctorNote("opencode", "3.8.0", "3.7.0")).toBe(
      "CLI 3.8.0 is newer than installed plugin 3.7.0 \u2014 update the Morning Star plugin (@mstar-harness/opencode) and restart OpenCode.",
    );
    expect(formatPluginVersionDoctorNote("cursor", "3.8.0", "3.7.0")).toBe(
      "CLI 3.8.0 is newer than installed plugin 3.7.0 \u2014 update the Morning Star plugin checkout (git pull, or re-run mstar-harness init --target cursor).",
    );
    expect(formatPluginVersionDoctorNote("codex", "3.8.0", "3.7.0")).toBe(
      "CLI 3.8.0 is newer than installed plugin 3.7.0 \u2014 update the Morning Star plugin: codex plugin marketplace upgrade, then codex plugin add morning-star-harness@mstar-repo.",
    );
    expect(formatPluginVersionDoctorNote("omp", "3.8.0", "3.7.0")).toBe(
      "CLI 3.8.0 is newer than installed plugin 3.7.0 \u2014 update the Morning Star plugin: omp plugin install @mstar-harness/omp.",
    );
    expect(formatPluginVersionDoctorNote("dsh", "3.8.0", "3.7.0")).toBe(
      "CLI 3.8.0 is newer than installed plugin 3.7.0 \u2014 update the Morning Star plugin: re-run mstar-harness init --target dsh (re-adds @mstar-harness/dsh in the web profile).",
    );
    expect(formatPluginVersionDoctorNote("kimi", "3.8.0", "3.7.0")).toBe(
      "CLI 3.8.0 is newer than installed plugin 3.7.0 \u2014 update the Morning Star plugin via the Kimi TUI: /plugins install.",
    );
  });

  test("not installed: per-host install hints without a drift direction", () => {
    expect(formatPluginVersionDoctorNote("zcode", "3.7.0", null)).toBe(
      "No installed Morning Star plugin found under ~/.zcode/cli/plugins/cache/ (install from the mstar-local marketplace).",
    );
    expect(formatPluginVersionDoctorNote("opencode", "3.7.0", null)).toBe(
      "No installed Morning Star plugin found under ~/.cache/opencode/packages/ (run mstar-harness init --target opencode to add @mstar-harness/opencode).",
    );
    expect(formatPluginVersionDoctorNote("cursor", "3.7.0", null)).toBe(
      "No installed Morning Star plugin found under ~/.cursor/plugins/ (run mstar-harness init --target cursor).",
    );
    expect(formatPluginVersionDoctorNote("codex", "3.7.0", null)).toBe(
      "No installed Morning Star plugin found in `codex plugin list` (install: codex plugin add morning-star-harness@mstar-repo).",
    );
    expect(formatPluginVersionDoctorNote("omp", "3.7.0", null)).toBe(
      "No installed Morning Star plugin found in `omp plugin list` (install: omp plugin install @mstar-harness/omp).",
    );
    expect(formatPluginVersionDoctorNote("dsh", "3.7.0", null)).toBe(
      "No installed Morning Star plugin found under ~/.dsh/profiles/ (run mstar-harness init --target dsh to add @mstar-harness/dsh).",
    );
    expect(formatPluginVersionDoctorNote("kimi", "3.7.0", null)).toBe(
      "No installed Morning Star plugin found under $KIMI_CODE_HOME/plugins/managed (install via the Kimi TUI: /plugins install).",
    );
  });

  test("dispatcher honors the no-throw contract on an out-of-contract target (QC F-007)", () => {
    // An invalid runtime target degrades to null — the caller then prints
    // that target's standard not-installed line; doctor never sees a TypeError.
    expect(detectInstalledPluginVersion("not-a-host" as Target, "project")).toBeNull();
  });

  test("prerelease-aware: a prerelease CLI is older than its release plugin", () => {
    expect(formatPluginVersionDoctorNote("zcode", "3.7.0-rc.1", "3.7.0")).toBe(
      "Installed plugin 3.7.0 is newer than CLI 3.7.0-rc.1 \u2014 update the global CLI: npm i -g @mstar-harness/cli@latest (or @3.7.0).",
    );
  });
});
