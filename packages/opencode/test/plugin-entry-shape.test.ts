/**
 * OpenCode plugin entry shape — default export must be a v1 PluginModule
 * (`{ server }`) so OpenCode does not treat helper function exports as plugins.
 *
 * Regression: without this, `validateStatusWrite` / `validateDispatchAssignment`
 * were invoked with PluginInput, returned `null`, and OpenCode logged
 * `plugin config hook failed: null is not an object (evaluating 'N.config')`.
 */
import { describe, expect, test } from "bun:test";
import pluginModule, {
  MorningStarHarnessPlugin,
  validateDispatchAssignment,
  validateStatusWrite,
} from "../src/mstar.js";

describe("OpenCode plugin module entry", () => {
  test("default export is PluginModule with server === MorningStarHarnessPlugin", () => {
    expect(pluginModule).toBeDefined();
    expect(typeof pluginModule).toBe("object");
    expect(pluginModule).not.toBeNull();
    expect(typeof pluginModule.server).toBe("function");
    expect(pluginModule.server).toBe(MorningStarHarnessPlugin);
  });

  test("helpers stay callable but must not be treated as the plugin entry", async () => {
    // Simulates what OpenCode would observe if it fell through to getLegacyPlugins:
    // calling validators with a PluginInput-shaped object must not throw, and
    // validateStatusWrite must return null (not a Hooks object).
    const fakePluginInput = {
      client: {},
      directory: "/tmp",
      worktree: "/tmp",
      project: {},
    };
    expect(await validateStatusWrite(fakePluginInput as unknown as string)).toBeNull();
    expect(validateDispatchAssignment(fakePluginInput as unknown as string)).toEqual({
      ok: true,
      violations: [],
    });
  });

  test("server() returns real hooks with config", async () => {
    const hooks = await pluginModule.server();
    expect(typeof hooks.config).toBe("function");
    expect(typeof hooks["tool.execute.before"]).toBe("function");
  });
});
