import { describe, expect, test } from "bun:test";
import { createMcpEffects } from "../src/mcp/effects.js";

describe("mcp process effects", () => {
  test("survives a child that exits before draining the piped stdin payload", async () => {
    // Issue #441: the MCP server spawns with a piped stdin; a child that exits
    // first closes the read end, so the stdin write raises EPIPE — unhandled it
    // crashed the whole MCP process instead of reporting the child's exit code.
    const result = await createMcpEffects([]).spawn({
      argv: [process.execPath, "-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: {},
      stdin: "x".repeat(1024 * 1024),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ exitCode: 0, signal: null });
  });
});
