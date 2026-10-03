import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandDefinitions } from "../src/index.js";
import type { CommandEffects, InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function context(sessionId?: string, sessionIdSource?: "flag" | "env"): InvocationContext {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "workflow-register-refusal-"));
  roots.push(cwd);
  const effects: CommandEffects = {
    async readInput() { return ""; },
    async spawn() { throw new Error("not used"); },
    async startDashboard() { throw new Error("not used"); },
    async openBrowser() { throw new Error("not used"); },
  };
  return { cwd, controlRoot: null, versions: { engine: null, cli: null, plugin: null, host: null, platform: null }, signal: new AbortController().signal, effects, ...(sessionId === undefined ? {} : { sessionId }), ...(sessionIdSource === undefined ? {} : { sessionIdSource }) };
}

function definition(id: string) {
  const found = getCommandDefinitions().find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
}

describe("active registration refusals", () => {

  test("coordinator binding does not accept an environment-derived session identity", async () => {
    const result = await definition("plan.bind").execute({
      coordinator: true,
      workflow: "wf-test",
    }, context("environment-session", "env"));
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
  });
});
