/**
 * Native plugin-settings contract for the iteration model handoff.
 *
 * Persistence cases exercise the real host path inside disposable host roots: a
 * child `bun` process with `HOME` redirected to a temp root (and the XDG /
 * profile variables removed) writes through the native `PluginManager` and reads
 * through the exported `getPluginSettings` helper, against
 * `<root>/.omp/plugins/omp-plugins.lock.json`. Each child refuses to run unless
 * the helper still resolves to the seeded disposable root, so a broken redirect
 * fails the test instead of touching the operator's real plugin settings. This
 * test also reads the settings file from disk itself; a mock echoing the written
 * value would not prove persistence.
 *
 * Documented host limitation, recorded rather than papered over: native
 * `/settings` → Plugins builds its npm rows from the user-scope plugin manager,
 * so a project-only install has no row there. The user-scope path above is the
 * supported scope; the "project-only install stays absent" case pins that
 * limitation instead of fabricating project-scope success.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeHandoffSettings } from "../src/model-handoff-settings";

const PACKAGE_DIR = join(import.meta.dir, "..");
const MODULE_PATH = join(PACKAGE_DIR, "src", "model-handoff-settings.ts");
const PLUGIN_NAME = "@mstar-harness/omp";
/** Sentinel plugin seeded into each disposable root; a child that cannot read it must not run. */
const SENTINEL_PLUGIN = "mstar-settings-probe";
/** Prefix the child prints its result with, so unrelated host output cannot be mistaken for it. */
const RESULT_MARKER = "MSTAR_PROBE_RESULT ";

/** Observable result shape this test expects from the reader, independent of its own types. */
type HandoffResult =
  | { ok: true; value: { modelHandoff: boolean; handoffTarget: string } }
  | { ok: false; reason: string; message: string };

const DEFAULTS: HandoffResult = { ok: true, value: { modelHandoff: false, handoffTarget: "@default" } };

const MODEL_HANDOFF_DESCRIPTION =
  "When enabled, each new Morning Star iteration arms @slow once the direction is locked and before the Phase 1 draft is written, then switches this coordinator session to handoffTarget after Phase 1 fully completes. Off by default.";
const HANDOFF_TARGET_DESCRIPTION =
  "Coordinator model after a completed Phase 1. Used only when modelHandoff is enabled.";

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function makeScratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Native user-scope settings file of a host root using the default (non-XDG) layout. */
function userSettingsPath(hostRoot: string): string {
  return join(hostRoot, ".omp", "plugins", "omp-plugins.lock.json");
}

/** Disposable host root, pre-seeded so a child can prove it reads this root. */
function disposableHostRoot(): { root: string; settingsPath: string } {
  const root = makeScratch("omp-handoff-host-");
  const settingsPath = userSettingsPath(root);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({ plugins: {}, settings: { [SENTINEL_PLUGIN]: { disposableRoot: true } } }, null, 2),
  );
  return { root, settingsPath };
}

/** Saved `@mstar-harness/omp` settings as the host actually persisted them. */
function readPersistedSettings(settingsPath: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    settings?: Record<string, Record<string, unknown>>;
  };
  return parsed.settings?.[PLUGIN_NAME] ?? {};
}

/**
 * Run `body` in a child bun process whose `HOME`, user-scope plugin settings and
 * project root are all disposable. The body runs with `project`, `lockPath`,
 * `pluginName`, the host `PluginManager`/`getPluginSettings` and the module
 * under test's `readHandoffSettings` already in scope.
 */
function runProbe<T>(body: string, hostRoot: { root: string }, projectDir: string): T {
  const script = `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PluginManager, getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { readHandoffSettings } from ${JSON.stringify(MODULE_PATH)};

const project = process.env.MSTAR_PROBE_PROJECT;
const lockPath = process.env.MSTAR_PROBE_LOCK;
const pluginName = ${JSON.stringify(PLUGIN_NAME)};
const seed = await getPluginSettings(${JSON.stringify(SENTINEL_PLUGIN)}, project);
if (seed.disposableRoot !== true) {
  throw new Error("native plugin settings did not resolve to the disposable host root; refusing to run");
}
console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(await (async () => { ${body} })()));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: PACKAGE_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: hostRoot.root,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG ?? "C.UTF-8",
      MSTAR_PROBE_PROJECT: projectDir,
      MSTAR_PROBE_LOCK: userSettingsPath(hostRoot.root),
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`settings probe failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  const reported = result.stdout
    .split("\n")
    .filter((line) => line.startsWith(RESULT_MARKER))
    .pop();
  if (reported === undefined) {
    throw new Error(`settings probe reported no result:\n${result.stdout}`);
  }
  return JSON.parse(reported.slice(RESULT_MARKER.length)) as T;
}

describe("native plugin settings", () => {
  test("native user settings round trip", () => {
    const hostRoot = disposableHostRoot();
    const projectDir = makeScratch("omp-handoff-project-");

    const observed = runProbe<{
      freshUser: HandoffResult;
      saved: HandoffResult;
      editedInSession: HandoffResult;
    }>(
      `
    const freshUser = await readHandoffSettings(project);
    const manager = new PluginManager(project);
    await manager.setPluginSetting(pluginName, "modelHandoff", true);
    await manager.setPluginSetting(pluginName, "handoffTarget", "@smol");
    const saved = await readHandoffSettings(project);
    const sessionEditor = new PluginManager(project);
    await sessionEditor.setPluginSetting(pluginName, "handoffTarget", "@default");
    const editedInSession = await readHandoffSettings(project);
    return { freshUser, saved, editedInSession };
    `,
      hostRoot,
      projectDir,
    );

    // Nothing saved yet: the manifest defaults, per key.
    expect(observed.freshUser).toEqual(DEFAULTS);
    expect(observed.saved).toEqual({ ok: true, value: { modelHandoff: true, handoffTarget: "@smol" } });
    // Edited later in the same session through the native writer, observed without a reload.
    expect(observed.editedInSession).toEqual({ ok: true, value: { modelHandoff: true, handoffTarget: "@default" } });

    // Persisted by the host itself, not echoed by a mock.
    expect(readPersistedSettings(hostRoot.settingsPath)).toEqual({ modelHandoff: true, handoffTarget: "@default" });

    // A later session reads the saved preference without writing it again.
    const laterSession = runProbe<HandoffResult>(`return await readHandoffSettings(project);`, hostRoot, projectDir);
    expect(laterSession).toEqual({ ok: true, value: { modelHandoff: true, handoffTarget: "@default" } });
  });

  test("rereads saved settings and honors project precedence", () => {
    const hostRoot = disposableHostRoot();
    const projectDir = makeScratch("omp-handoff-project-");

    const observed = runProbe<{
      userScopeOnly: HandoffResult;
      projectOverride: HandoffResult;
      afterRemoval: HandoffResult;
    }>(
      `
    const overridePath = join(project, ".omp", "plugin-overrides.json");
    const manager = new PluginManager(project);
    await manager.setPluginSetting(pluginName, "modelHandoff", true);
    await manager.setPluginSetting(pluginName, "handoffTarget", "@smol");
    const userScopeOnly = await readHandoffSettings(project);
    mkdirSync(dirname(overridePath), { recursive: true });
    writeFileSync(overridePath, JSON.stringify({ settings: { [pluginName]: { handoffTarget: "@default" } } }));
    const projectOverride = await readHandoffSettings(project);
    rmSync(overridePath);
    const afterRemoval = await readHandoffSettings(project);
    return { userScopeOnly, projectOverride, afterRemoval };
    `,
      hostRoot,
      projectDir,
    );

    expect(observed.userScopeOnly).toEqual({ ok: true, value: { modelHandoff: true, handoffTarget: "@smol" } });
    // Project override wins for the key it sets; the user-scope key it omits survives.
    expect(observed.projectOverride).toEqual({ ok: true, value: { modelHandoff: true, handoffTarget: "@default" } });
    // Re-read after the override disappears: no cached effective settings.
    expect(observed.afterRemoval).toEqual({ ok: true, value: { modelHandoff: true, handoffTarget: "@smol" } });

    // The project override never leaks into the saved user preference.
    expect(readPersistedSettings(hostRoot.settingsPath)).toEqual({ modelHandoff: true, handoffTarget: "@smol" });
  });

  test("rejects malformed persisted preference", () => {
    const hostRoot = disposableHostRoot();
    const projectDir = makeScratch("omp-handoff-project-");

    const observed = runProbe<{ wrongType: HandoffResult; unknownTarget: HandoffResult }>(
      `
    const manager = new PluginManager(project);
    await manager.setPluginSetting(pluginName, "modelHandoff", "true");
    const wrongType = await readHandoffSettings(project);
    await manager.setPluginSetting(pluginName, "modelHandoff", true);
    await manager.setPluginSetting(pluginName, "handoffTarget", "@slow");
    const unknownTarget = await readHandoffSettings(project);
    return { wrongType, unknownTarget };
    `,
      hostRoot,
      projectDir,
    );

    expect(observed.wrongType).toMatchObject({
      ok: false,
      reason: "invalid-settings",
      message: expect.stringContaining("modelHandoff"),
    });
    // "@slow" is a real role name but not a declared value of this setting.
    expect(observed.unknownTarget).toMatchObject({
      ok: false,
      reason: "invalid-settings",
      message: expect.stringContaining("handoffTarget"),
    });

    // Refused, never rewritten: the saved preference is left exactly as the host stored it.
    expect(readPersistedSettings(hostRoot.settingsPath)).toEqual({ modelHandoff: true, handoffTarget: "@slow" });
  });

  test("reports a settings read failure instead of a preference", () => {
    const hostRoot = disposableHostRoot();
    const projectDir = makeScratch("omp-handoff-project-");

    const observed = runProbe<HandoffResult>(
      `
    writeFileSync(lockPath, "{ this is not json");
    return await readHandoffSettings(project);
    `,
      hostRoot,
      projectDir,
    );

    expect(observed).toMatchObject({ ok: false, reason: "settings-read-failed" });
  });

  test("project-only install stays absent from the native plugin listing (documented host limitation)", () => {
    const hostRoot = disposableHostRoot();
    const projectDir = makeScratch("omp-handoff-project-");
    const installedPackage = join(projectDir, "node_modules", PLUGIN_NAME);
    mkdirSync(installedPackage, { recursive: true });
    writeFileSync(
      join(installedPackage, "package.json"),
      JSON.stringify({ name: PLUGIN_NAME, version: "0.0.0", omp: { name: "morning-star-harness" } }, null, 2),
    );
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "handoff-probe-project", dependencies: { [PLUGIN_NAME]: "0.0.0" } }, null, 2),
    );

    const listed = runProbe<string[]>(
      `return (await new PluginManager(project).list()).map((plugin) => plugin.name);`,
      hostRoot,
      projectDir,
    );

    // Not a success gate for this feature. The native panel enumerates user-scope
    // installs, so a project-only package has no row; the user-scope settings path
    // exercised above stays the supported scope.
    expect(listed).not.toContain(PLUGIN_NAME);
  });
});

describe("decodeHandoffSettings", () => {
  test("absent keys fall back to the manifest defaults per key", () => {
    expect(decodeHandoffSettings({})).toEqual(DEFAULTS);
    expect(decodeHandoffSettings({ handoffTarget: "@smol" })).toEqual({
      ok: true,
      value: { modelHandoff: false, handoffTarget: "@smol" },
    });
    expect(decodeHandoffSettings({ modelHandoff: true })).toEqual({
      ok: true,
      value: { modelHandoff: true, handoffTarget: "@default" },
    });
  });

  test("present values are validated instead of coerced", () => {
    expect(decodeHandoffSettings({ modelHandoff: "false" })).toMatchObject({
      ok: false,
      reason: "invalid-settings",
    });
    // Present-and-null is a value, not an absent key.
    expect(decodeHandoffSettings({ modelHandoff: null })).toMatchObject({ ok: false, reason: "invalid-settings" });
    expect(decodeHandoffSettings({ handoffTarget: "@slow" })).toMatchObject({ ok: false, reason: "invalid-settings" });
    expect(decodeHandoffSettings({ handoffTarget: 7 })).toMatchObject({ ok: false, reason: "invalid-settings" });
  });
});

describe("omp.settings manifest", () => {
  test("declares both handoff keys with the defaults the reader applies", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      omp?: {
        settings?: Record<string, { type?: string; default?: unknown; values?: string[]; description?: string }>;
      };
    };
    const settings = manifest.omp?.settings ?? {};

    expect(settings.modelHandoff).toEqual({
      type: "boolean",
      default: false,
      description: MODEL_HANDOFF_DESCRIPTION,
    });
    expect(settings.handoffTarget).toEqual({
      type: "enum",
      default: "@default",
      values: ["@default", "@smol"],
      description: HANDOFF_TARGET_DESCRIPTION,
    });

    // A displayed default that disagrees with the reader's fallback would show one
    // preference and act on another.
    expect(
      decodeHandoffSettings({
        modelHandoff: settings.modelHandoff?.default,
        handoffTarget: settings.handoffTarget?.default,
      }),
    ).toEqual(DEFAULTS);
  });
});
