import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationContext } from "../types.js";
import { getCommandDefinitions } from "../definitions.js";

const controlRoot = join(tmpdir(), "mstar-catalog-command-control");

function invocation(cwd: string): InvocationContext {
  return {
    cwd,
    controlRoot,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("not available in this command family"); },
      async openBrowser() { throw new Error("not available in this command family"); },
      writeStderr() {},
    },
  };
}

test("catalog purge-registration exposes the exact recovery inputs and reports all missing flags", async () => {
  const root = mkdtempSync(join(tmpdir(), "mstar-catalog-purge-command-"));
  try {
    const definition = getCommandDefinitions().find(({ id }) => id === "catalog.purge-registration");
    if (definition === undefined) throw new Error("missing catalog.purge-registration definition");
    expect(definition.cli.path).toEqual(["catalog", "purge-registration"]);
    expect(definition.cli.options.map(({ flags }) => flags)).toEqual([
      "--workflow <id>", "--operation <id>", "--expect <n>", "--actor <role>", "--harness <path>",
    ]);
    const result = await definition.execute(definition.input.parse({ harness: join(root, ".mstar") }), invocation(root));
    expect(result).toMatchObject({ status: "usage", exitCode: 2 });
    if (result.status !== "usage") throw new Error("expected usage envelope");
    expect(result.message).toContain("--workflow");
    expect(result.message).toContain("--operation");
    expect(result.message).toContain("--expect");
    expect(result.message).toContain("--actor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
