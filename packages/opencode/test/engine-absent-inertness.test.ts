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
 * (`write`) paths, and asserts the hook completes without throwing and the
 * documented abort logs were emitted. It never depends on the real
 * mstar-harness install.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every runtime export the plugin imports, throwing like a dead engine.
 * Mirrors the CURRENT import surface of src/mstar.ts (dispatch composition
 * is a single engine call now — `composeDispatchGate`; qc1 F-001).
 */
const ENGINE_STUB = `const unavailable = () => {
  throw new Error("engine unavailable");
};
export const applyEnforcement = unavailable;
export const composeDispatchGate = unavailable;
export const isReadOnlyAssignmentRole = unavailable;
export const parseAssignmentFields = unavailable;
export const resolveCompassEnforcement = unavailable;
export const resolveHarnessDir = unavailable;
export const validateStatus = unavailable;
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
