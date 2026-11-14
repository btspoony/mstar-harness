/**
 * runtime-floor.test.ts — the plugin-level below-floor case.
 *
 * The register authority route asserts the runtime floor on what the engine
 * detects, BEFORE it reads the store. This file pins that order at the plugin
 * level: a Node below the declared floor refuses the register write with
 * `store.authority-unavailable` wrapping the engine's `store.runtime-unsupported`,
 * and never reaches `withStoreRead` — even though the store is ACTIVE here.
 *
 * The runtime cannot be faked directly: this process IS Bun, and
 * `detectStoreRuntime` reads the Bun global first. So the engine module is
 * mocked before the plugin is imported, replacing ONLY the detection and
 * store-read channels; `assertStoreRuntimeSupported` stays real, and its own
 * refusal is the expected content of the wrapper message.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as engine from "@mstar-harness/engine";

/** Ambient MSTAR_HARNESS_DIR would redirect every `.mstar` fixture — pinned out. */
const ENV_KEY = "MSTAR_HARNESS_DIR";
let previousEnv: string | undefined;
beforeEach(() => {
  previousEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (previousEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousEnv;
});

const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

const validRegister = { entries: {} };
/** Below every Node floor this product declares, so the REAL assertion refuses. */
const belowFloor = "0.0.0";
const declaredNodeFloor = engine.readDeclaredNodeFloor();
/** Store reads the plugin performs below the floor: must stay at zero. */
let storeReads = 0;

/** Temp project rooted in a real git work tree (harness resolution boundary),
 * with an ACTIVE store and the `_default` project register path. */
async function makeActiveHarnessProject(): Promise<{ harness: string; registerPath: string }> {
  const project = mkdtempSync(join(tmpdir(), "mstar-opencode-floor-"));
  projects.push(project);
  execFileSync("git", ["init", "-q", project], { stdio: "ignore" });
  const harness = join(project, ".mstar");
  mkdirSync(join(harness, "projects", "_default"), { recursive: true });
  // REAL active store through the engine's own initializer — built BEFORE the
  // detection stub exists, since the engine's floor assertion gates it too.
  const handle = await engine.initializeStore({ harnessDir: harness });
  handle.close();
  return { harness, registerPath: join(harness, "projects", "_default", "residuals.json") };
}

/** Built at module load, i.e. BEFORE `mock.module` below: the engine's own
 * floor assertion gates store initialization, so the ACTIVE store has to be
 * seeded on the real runtime. */
const fixture = await makeActiveHarnessProject();

/** Captured BEFORE the override: Bun 1.4.4's `mock.restore()` does not drop a
 * `mock.module` replacement, so teardown re-registers this snapshot — otherwise
 * the stub leaks into every later file of the package's one-process `bun test`. */
const realEngine = { ...engine };

mock.module("@mstar-harness/engine", () => ({
  ...engine,
  detectStoreRuntime: () => ({ isBun: false, version: belowFloor }),
  withStoreRead: async () => {
    storeReads += 1;
    throw new Error("withStoreRead was reached below the runtime floor");
  },
}));

/** Dynamic on purpose (module-loading boundary): a static import is hoisted
 * above `mock.module` and would bind the REAL engine detection channel. */
const { validateStatusWrite } = await import("../src/mstar.js");

afterAll(() => {
  mock.restore();
  mock.module("@mstar-harness/engine", () => realEngine);
});

describe("opencode runtime floor — below the declared Node floor", () => {
  test("refuses the register write before reading the store", async () => {
    let thrown: { code?: string; message: string } | null = null;
    try {
      engine.assertStoreRuntimeSupported({ isBun: false, version: belowFloor });
    } catch (error) {
      thrown = error as { code?: string; message: string };
    }
    expect(thrown?.code).toBe("store.runtime-unsupported");
    expect(thrown?.message).toContain("Node");
    expect(declaredNodeFloor).not.toBeNull();
    expect(thrown?.message).toContain(declaredNodeFloor!);

    const result = await validateStatusWrite(fixture.registerPath, { doc: validRegister });

    expect(storeReads).toBe(0);
    expect(result?.hardBlocked).toBe(true);
    expect(result?.violations[0]!.code).toBe("store.authority-unavailable");
    expect(result?.violations[0]!.message).toBe(
      `the issue authority could not be read ([store.runtime-unsupported] ${thrown!.message}) — the register write is ` +
        "refused rather than applied against an unreadable authority; no older-runtime or JSON fallback exists",
    );
  });
});
