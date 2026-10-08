import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { executeCommand } from "./definitions.js";
import type { CommandEnvelope, InvocationContext } from "./types.js";

function context(): InvocationContext {
  return {
    cwd: process.cwd(),
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      readInput: async () => "",
      spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
      startDashboard: async () => {
        throw new Error("unused in input diagnostics tests");
      },
      openBrowser: async () => {
        throw new Error("unused in input diagnostics tests");
      },
    },
  };
}

function at(diagnostics: ReadonlyArray<Record<string, unknown>>, path: string): Record<string, unknown> {
  const found = diagnostics.find((entry) => entry.path === path);
  if (found === undefined) throw new Error(`no diagnostic for path ${path}`);
  return found;
}

function usageDiagnostics(envelope: CommandEnvelope): ReadonlyArray<Record<string, unknown>> {
  if (envelope.status !== "usage") throw new Error(`expected usage envelope, got status ${envelope.status}`);
  const diagnostics = (envelope.details as { diagnostics?: unknown } | undefined)?.diagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    throw new Error("usage envelope carries no grouped details.diagnostics");
  }
  return diagnostics as Array<Record<string, unknown>>;
}

async function runCliSource(args: readonly string[]): Promise<{ exitCode: number; stdout: string }> {
  const cliEntry = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cliEntry, ...args], { stdout: "pipe", stderr: "ignore" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { exitCode, stdout };
}

describe("executeCommand input diagnostics", () => {
  // `report.versionOverrides` and `worktree.qc-alignment.files` are rejected by
  // definition.input.safeParse itself, so these cases prove the canonical
  // admission envelope — not a handler's own recovery path.
  test("enum schema rejection names the CLI flag, accepted values, and received value", async () => {
    const envelope = await executeCommand("workflow.register", { deliveryKind: "pr" }, context());
    expect(envelope.status).toBe("usage");
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(at(usageDiagnostics(envelope), "deliveryKind")).toMatchObject({
      code: "invalid_value", expected: "development | verification/report-only", received: "pr",
    });
    expect(envelope.details?.helpRoute).toBe("mstar workflow register --help");
  });

  test("two identical violations at different object paths keep distinct safe paths in one grouped response", async () => {
    const envelope = await executeCommand("report", { versionOverrides: { cli: 1, engine: 2 } }, context());
    const diagnostics = usageDiagnostics(envelope);
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    const paths = diagnostics.map((entry) => String(entry.path)).sort();
    expect(paths).toEqual(["versionOverrides.cli", "versionOverrides.engine"]);
    const cli = at(diagnostics, "versionOverrides.cli");
    const engine = at(diagnostics, "versionOverrides.engine");
    expect(cli).toMatchObject({ code: "invalid_type" });
    expect(engine).toMatchObject({ code: "invalid_type" });
    expect(cli).not.toHaveProperty("index");
    expect(engine).not.toHaveProperty("index");
    expect(cli).toMatchObject({ expected: "string", received: "1" });
    expect(engine).toMatchObject({ expected: "string", received: "2" });
  });

  test("numeric array indices are reported for the offending array item", async () => {
    const envelope = await executeCommand("worktree.qc-alignment", { files: [42] }, context());
    const diagnostics = usageDiagnostics(envelope);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ path: "files[0]", code: "invalid_type", index: 0, expected: "string", received: "42" });
  });

  test("secret-shaped submitted values never appear in the diagnostic output", async () => {
    const secret = "sk-live-9f2c4ab1-secret";
    const envelope = await executeCommand("worktree.qc-alignment", { files: [{ token: secret }] }, context());
    const diagnostics = usageDiagnostics(envelope);
    expect(JSON.stringify(envelope)).not.toContain(secret);
    // The offending member is still identified by its safe path.
    expect(diagnostics.map((entry) => entry.path)).toContain("files[0]");
    expect(at(diagnostics, "files[0]")).toMatchObject({ expected: "string", received: "object" });
  });
  test("secret-shaped scalar received values are redacted from the usage message", async () => {
    const secret = "sk-live-test-123";
    const envelope = await executeCommand("worktree.qc-alignment", { files: secret }, context());
    const diagnostics = usageDiagnostics(envelope);
    expect(envelope.status).toBe("usage");
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(envelope.message).not.toContain(secret);
    expect(envelope.message).toContain("[REDACTED]");
    expect(at(diagnostics, "files")).toMatchObject({ expected: "array", received: "[REDACTED]" });
  });

  test("non-secret scalar received values remain fully rendered", async () => {
    const envelope = await executeCommand("worktree.qc-alignment", { files: 42 }, context());
    expect(envelope.status).toBe("usage");
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(envelope.message).toContain("received 42");
  });

  test("a secret-shaped scalar quoted outside the issue path is redacted from message and diagnostics", async () => {
    // A strict object reports the offending KEY by name, and the issue path is
    // the object root — sanitizing only the value at the path left the key's
    // copy of the submitted secret in both the message and the diagnostic.
    const secret = "sk-live-test-123";
    const envelope = await executeCommand("report", { [secret]: "x" }, context());
    expect(envelope.status).toBe("usage");
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(envelope.message).toContain("[REDACTED]");
    const diagnostics = usageDiagnostics(envelope);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: "unrecognized_keys" });
    expect(diagnostics[0]?.message).not.toContain(secret);
  });

  test("a benign unrecognized key stays fully rendered", async () => {
    const envelope = await executeCommand("report", { bogus: 1 }, context());
    expect(envelope.status).toBe("usage");
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(envelope.message).toContain("bogus");
    expect(usageDiagnostics(envelope)[0]).toMatchObject({ code: "unrecognized_keys", expected: "recognized keys", received: "object" });
  });
  test("large invalid input bounds the message while retaining every diagnostic", async () => {
    const issueCount = 5000;
    const envelope = await executeCommand("worktree.qc-alignment", { files: Array(issueCount).fill(42) }, context());
    const diagnostics = usageDiagnostics(envelope);
    expect(diagnostics).toHaveLength(issueCount);
    expect(diagnostics[0]).toMatchObject({ path: "files[0]", code: "invalid_type", index: 0 });
    expect(diagnostics[0]).toMatchObject({ expected: "string", received: "42" });
    expect(diagnostics[issueCount - 1]).toMatchObject({ path: `files[${issueCount - 1}]`, index: issueCount - 1, expected: "string", received: "42" });
    expect(envelope.status).toBe("usage");
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    const summary = envelope.details?.diagnosticSummary as { total: number; shown: number; omitted: number };
    expect(summary.total).toBe(issueCount);
    expect(summary.shown).toBeGreaterThan(1);
    expect(summary.shown + summary.omitted).toBe(issueCount);
    expect(envelope.message).toContain(String(issueCount));
    expect(envelope.message).toContain(String(summary.omitted));
    expect(envelope.message).toContain("files[0]");
    expect(envelope.message).toContain("files[1]");
    expect(envelope.message.length).toBeLessThan(3000);
    expect(envelope.message).toContain("received 42");
  });

});

describe("session selector admission", () => {
  // The central selector rejection is a consumer-visible admission point: it
  // must carry the same factory metadata as every other usage refusal, with the
  // code and exit unchanged.
  test("an empty session selector is rejected with the shared usage shape", async () => {
    const envelope = await executeCommand("plan.bind", { sessionId: "" }, context());
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(at(usageDiagnostics(envelope), "sessionId")).toMatchObject({ expected: "non-empty string", received: '""' });
    expect(envelope.details).toMatchObject({
      helpRoute: "mstar plan bind --help",
      recovery: expect.stringContaining("mstar plan bind --help"),
    });
  });

  test("a whitespace session selector is rejected the same way", async () => {
    const envelope = await executeCommand("plan.bind", { sessionId: "   " }, context());
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(at(usageDiagnostics(envelope), "sessionId")).toMatchObject({ expected: "non-empty string", received: '"   "' });
  });

  test("a non-string session selector names the received type", async () => {
    const envelope = await executeCommand("plan.bind", { sessionId: 42 }, context());
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(at(usageDiagnostics(envelope), "sessionId")).toMatchObject({ expected: "non-empty string", received: "number" });
    expect(envelope.details).toMatchObject({ helpRoute: "mstar plan bind --help" });
  });
});

describe("CLI parser diagnostics", () => {
  test("an omitted positional input reaches shared admission diagnostics", async () => {
    const { exitCode, stdout } = await runCliSource(["persist", "get", "--key", "probe-key"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout) as CommandEnvelope;
    expect(envelope).toMatchObject({ command: "persist.get", status: "usage", code: "command.invalid-input", exitCode: 2 });
    const diagnostic = usageDiagnostics(envelope).find((entry) => entry.path === "kind");
    expect(diagnostic?.path).toBe("kind");
    expect(envelope.details?.helpRoute).toBe("mstar persist get --help");
  });

  test("an omitted required option reaches shared admission diagnostics", async () => {
    const { exitCode, stdout } = await runCliSource(["persist", "get", "json"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout) as CommandEnvelope;
    expect(envelope.status).toBe("usage");
    const diagnostic = usageDiagnostics(envelope).find((entry) => entry.path === "key");
    expect(diagnostic?.path).toBe("key");
    expect(envelope.details?.helpRoute).toBe("mstar persist get --help");
  });

  test("a flag present without its value reports missing-value facts in the JSON envelope", async () => {
    const { exitCode, stdout } = await runCliSource(["persist", "get", "json", "--key"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout) as CommandEnvelope;
    expect(envelope.status).toBe("usage");
    const diagnostic = usageDiagnostics(envelope)[0]!;
    expect(diagnostic.code).toMatch(/^commander\./);
    expect(diagnostic).toMatchObject({ token: "--key", path: "key", expected: "option value", received: "missing value" });
    expect(envelope.details?.helpRoute).toBe("mstar persist get --help");
  });

  test("an unknown option is reported without inventing a schema field path", async () => {
    const { exitCode, stdout } = await runCliSource(["persist", "get", "json", "--key", "probe-key", "--definitely-not-a-flag"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout) as CommandEnvelope;
    expect(envelope.status).toBe("usage");
    const diagnostic = usageDiagnostics(envelope)[0]!;
    expect(diagnostic.code).toBe("commander.unknownOption");
    expect(diagnostic).toMatchObject({ expected: "recognized option", received: "--definitely-not-a-flag" });
    expect(diagnostic).not.toHaveProperty("path");
    expect(envelope.details?.helpRoute).toBe("mstar persist get --help");
  });

});
