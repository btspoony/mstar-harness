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
  const child = Bun.spawn([process.execPath, cliEntry, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text();
  const exitCode = await child.exited;
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
    expect(envelope.message.split("\n")[0]).toBe(
      "Rejected --delivery-kind: expected development | verification/report-only; received pr",
    );
    expect(envelope.details).toMatchObject({ diagnostics: [{ path: "deliveryKind", code: "invalid_value" }] });
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
    // The flattened messages are identical; only the structured path tells them apart.
    expect(cli?.message).toBe(engine?.message);
    // Diagnostics carry only safe facts: field path, stable code, message, array index.
    for (const entry of diagnostics) {
      expect(Object.keys(entry).every((key) => ["path", "code", "message", "index"].includes(key))).toBe(true);
    }
  });

  test("invalid array item rejection includes formatter-generated expected and received facts", async () => {
    const envelope = await executeCommand("worktree.qc-alignment", { files: [42] }, context());
    expect(envelope.status).toBe("usage");
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(envelope.message.split("\n")[0]).toBe("Rejected files[0]: expected string; received 42");
  });

  test("numeric array indices are reported for the offending array item", async () => {
    const envelope = await executeCommand("worktree.qc-alignment", { files: [42] }, context());
    const diagnostics = usageDiagnostics(envelope);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ path: "files[0]", code: "invalid_type", index: 0 });
  });

  test("secret-shaped submitted values never appear in the diagnostic output", async () => {
    const secret = "sk-live-9f2c4ab1-secret";
    const envelope = await executeCommand("worktree.qc-alignment", { files: [{ token: secret }] }, context());
    const diagnostics = usageDiagnostics(envelope);
    expect(JSON.stringify(envelope)).not.toContain(secret);
    // The offending member is still identified by its safe path.
    expect(diagnostics.map((entry) => entry.path)).toContain("files[0]");
  });
  test("secret-shaped scalar received values are redacted from the usage message", async () => {
    const secret = "sk-live-test-123";
    const envelope = await executeCommand("worktree.qc-alignment", { files: secret }, context());
    expect(envelope.status).toBe("usage");
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(envelope.message).not.toContain(secret);
    expect(envelope.message).toContain("[REDACTED]");
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
    expect(envelope.message).toContain('Unrecognized key: "bogus"');
  });
  test("all diagnostics are rendered without an omission note", async () => {
    const issueCount = 5000;
    const envelope = await executeCommand("worktree.qc-alignment", { files: Array(issueCount).fill(42) }, context());
    const diagnostics = usageDiagnostics(envelope);
    expect(diagnostics).toHaveLength(issueCount);
    expect(envelope.status).toBe("usage");
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(envelope.message).not.toContain("…and");
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
    expect(envelope.message.split("\n")[0]).toBe('Rejected --session-id: expected non-empty string; received ""');
    expect(envelope.details).toMatchObject({
      helpRoute: "mstar plan bind --help",
      recovery: "Run mstar plan bind --help and correct the flagged input.",
    });
  });

  test("a whitespace session selector is rejected the same way", async () => {
    const envelope = await executeCommand("plan.bind", { sessionId: "   " }, context());
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(envelope.message.split("\n")[0]).toBe('Rejected --session-id: expected non-empty string; received "   "');
  });

  test("a non-string session selector names the received type", async () => {
    const envelope = await executeCommand("plan.bind", { sessionId: 42 }, context());
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (envelope.status !== "usage") throw new Error("expected usage envelope");
    expect(envelope.message.split("\n")[0]).toBe("Rejected --session-id: expected non-empty string; received number");
    expect(envelope.details).toMatchObject({ helpRoute: "mstar plan bind --help" });
  });
});

describe("CLI parser diagnostics", () => {
  test("missing required argument reports the field and the leaf help route", async () => {
    // `--key` is supplied so Commander deterministically reports the missing
    // positional argument instead of the required option.
    const { exitCode, stdout } = await runCliSource(["persist", "get", "--key", "probe-key"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout) as {
      command: string;
      status: string;
      code: string;
      exitCode: number;
      details?: { diagnostics?: Array<{ path?: string; code: string; message: string; helpRoute?: string }> };
    };
    expect(envelope).toMatchObject({ command: "persist.get", status: "usage", code: "command.invalid-input", exitCode: 2 });
    const diagnostic = envelope.details?.diagnostics?.[0];
    expect(diagnostic?.path).toBe("kind");
    expect(diagnostic?.code).toBe("commander.missingArgument");
    expect(diagnostic?.helpRoute).toBe("mstar persist get --help");
  });

  test("a required option without its value reports the option's input field", async () => {
    const { exitCode, stdout } = await runCliSource(["persist", "get", "json"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout) as {
      status: string;
      details?: { diagnostics?: Array<{ path?: string; code: string; message: string; helpRoute?: string }> };
    };
    expect(envelope.status).toBe("usage");
    const diagnostic = envelope.details?.diagnostics?.[0];
    expect(diagnostic?.path).toBe("key");
    expect(diagnostic?.code).toBe("commander.missingMandatoryOptionValue");
    expect(diagnostic?.helpRoute).toBe("mstar persist get --help");
  });

  test("a flag present without its value reports the option's input field", async () => {
    const { exitCode, stdout } = await runCliSource(["persist", "get", "json", "--key"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout) as {
      status: string;
      details?: { diagnostics?: Array<{ path?: string; code: string; message: string; helpRoute?: string }> };
    };
    expect(envelope.status).toBe("usage");
    const diagnostic = envelope.details?.diagnostics?.[0];
    expect(diagnostic?.path).toBe("key");
    expect(diagnostic?.code).toBe("commander.optionMissingArgument");
    expect(diagnostic?.helpRoute).toBe("mstar persist get --help");
  });

  test("a malformed flag keeps the honest parser diagnostic without guessing a field", async () => {
    const { exitCode, stdout } = await runCliSource(["persist", "get", "json", "--key", "probe-key", "--definitely-not-a-flag"]);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(stdout) as {
      status: string;
      details?: { diagnostics?: Array<{ path?: string; code: string; message: string; helpRoute?: string }> };
    };
    expect(envelope.status).toBe("usage");
    const diagnostic = envelope.details?.diagnostics?.[0];
    expect(diagnostic?.code).toBe("commander.unknownOption");
    expect(diagnostic?.message).toContain("--definitely-not-a-flag");
    // An unknown flag is not a determinable input field: no path is invented.
    expect(diagnostic).not.toHaveProperty("path");
    expect(diagnostic?.helpRoute).toBe("mstar persist get --help");
  });
});
