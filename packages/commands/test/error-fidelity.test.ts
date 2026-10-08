import { describe, expect, test } from "bun:test";
import { executeCommand } from "../src/definitions.js";
import type { InvocationContext } from "../src/types.js";

describe("session.recover input discovery", () => {
  const context: InvocationContext = {
    cwd: process.cwd(),
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { throw new Error("session.recover must not spawn a process"); },
      async startDashboard() { throw new Error("dashboard is unavailable in this test"); },
      async openBrowser() { throw new Error("browser is unavailable in this test"); },
    },
  };

  test("reports all independently known missing requirements, including caller identity", async () => {
    const result = await executeCommand("session.recover", { workflow: "wf-recover" }, context);
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    const diagnostics = result.details?.diagnostics;
    if (!Array.isArray(diagnostics)) throw new Error("the aggregated refusal must carry structured diagnostics");
    const paths = diagnostics.map((entry) => {
      const diagnostic = entry as { path?: string; code?: string };
      return { path: diagnostic.path, code: diagnostic.code };
    });
    for (const path of ["priorSession", "unowned", "reason", "attestation", "expect", "operation", "sessionId"]) {
      expect(paths).toContainEqual({ path, code: "required" });
    }
  });

  test("reports both addressable source fields as mutually exclusive", async () => {
    const result = await executeCommand("session.recover", {
      workflow: "wf-recover", priorSession: "stopped-session", unowned: true,
      reason: "recovery", attestation: "/tmp/attestation.json", expect: "token", operation: "recover-1",
    }, { ...context, sessionId: "caller-session" });
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    const diagnostics = result.details?.diagnostics;
    if (!Array.isArray(diagnostics)) throw new Error("the exclusivity refusal must carry structured diagnostics");
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "priorSession", code: "exclusive" }),
      expect.objectContaining({ path: "unowned", code: "exclusive" }),
    ]));
  });
});
