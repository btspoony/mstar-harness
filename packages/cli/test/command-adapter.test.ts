// Build prerequisite: run `bun run --cwd packages/commands build` before this package test.
// These adapter tests load @mstar-harness/commands through its generated package entry.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { Command, CommanderError } from "commander";
import { executeCommand, getCommandDefinitions } from "@mstar-harness/commands";
import { serializeExecutionValue } from "@mstar-harness/engine";
import { registerMcpCommand } from "../src/mcp/command";
import { mapParserError, registerCliCommands, renderCommandContract } from "../src/command-adapter";
import type { CommandDefinition, InvocationContext } from "@mstar-harness/commands";


function context(): InvocationContext {
  return {
    cwd: process.cwd(),
    controlRoot: null,
    versions: { engine: null, cli: "test", plugin: null, host: null, platform: "test" },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { throw new Error("unused"); },
      async startDashboard() { throw new Error("unused"); },
      async openBrowser() { throw new Error("unused"); },
    },
  };
}

async function run(args: string[], definitions: readonly CommandDefinition[] = getCommandDefinitions(), includeMcp = false): Promise<{ status: number; stdout: string; stderr: string }> {
  const program = new Command();
  program.name("mstar").exitOverride();
  registerCliCommands(program, definitions, context());
  if (includeMcp) registerMcpCommand(program);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const log = console.log;
  const errorLog = console.error;
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let status = 0;
  try {
    await program.parseAsync(["node", "mstar", ...args], { from: "node" });
    status = process.exitCode ?? 0;
  } catch (caught) {
    const usage = mapParserError(caught, ["node", "mstar", ...args]);
    if (usage !== null) {
      stdout.push(JSON.stringify(usage));
      status = usage.exitCode;
    } else if (caught instanceof CommanderError) status = caught.exitCode;
    else status = 1;
  } finally {
    console.log = log;
    console.error = errorLog;
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
    process.exitCode = 0;
  }
  return { status, stdout: stdout.join(""), stderr: stderr.join("") };
}
test("mcp is a top-level CLI command and documents its stdio server purpose", async () => {
  const result = await run(["mcp", "--help"], undefined, true);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage: mstar mcp");
  expect(result.stdout).toContain("Run the Morning Star MCP server over stdio");
});

describe("generated CLI adapter", () => {


  test("issue show positional parse errors retain their diagnostic shape", () => {
    const error = new CommanderError(2, "commander.excessArguments", "too many arguments for 'show'. Expected 0 arguments but got 1");
    const envelope = mapParserError(error, ["node", "mstar", "issue", "show", "BADPOS"]);
    const details = envelope?.details;
    expect(details).toMatchObject({
      diagnostics: [{ code: "commander.excessArguments", message: error.message, helpRoute: "mstar issue show --help" }],
    });
    if (details !== undefined && "diagnostics" in details && Array.isArray(details.diagnostics)) {
      expect(details.diagnostics[0]).not.toHaveProperty("path");
    }
  });



  test("an issue --payload is decoded and validated by its own descriptor with pathful diagnostics", async () => {
    const invalid = await run(["issue", "add", "--payload", "{}", "--operation-id", "probe", "--actor", "project-manager"]);
    const body = JSON.parse(invalid.stdout) as {
      code?: string;
      message?: string;
      details?: { diagnostics?: Array<{ path: string }> };
    };
    // The shared decoder must be the one that rejects it: the descriptor is
    // bound to the `payload` input field, so the refusal carries indexed
    // `payload.<field>` paths rather than falling through to the family parser.
    expect(body.code).toBe("command.invalid-input");
    expect(body.message).toContain("Invalid command payload");
    const paths = (body.details?.diagnostics ?? []).map((entry) => entry.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((entry) => entry.startsWith("payload."))).toBe(true);
  });

  test("report accepts empty input and invokes the bounded canonical handler", async () => {
    const empty = await run(["report"]);
    expect(empty.status).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({
      command: "report",
      status: "ok",
      code: "report.ok",
      data: { issueUrl: expect.stringContaining("issues/new"), prompt: expect.stringContaining("Title: \"absent\"") },
    });

    const titled = await run(["report", "--title", "CLI report", "--exit-status", "2", "--version-overrides", "{\"cli\":\"override\"}"]);
    expect(titled.status).toBe(0);
    expect(JSON.parse(titled.stdout).data.prompt).toContain("Caller-supplied version overrides:");
    const oversized = await run(["report", "--title", "x".repeat(8193)]);
    expect(oversized.status).toBe(1);
    expect(JSON.parse(oversized.stdout)).toMatchObject({
      command: "report",
      status: "refused",
      code: "report.input-too-large",
      details: { field: "title", limit: 8192 },
    });
    expect(JSON.parse(titled.stdout).data.prompt).toContain("Title: \"CLI report\"");
  });
  test("report decodes CLI JSON arguments into the bounded array handler", async () => {
    const result = await run(["report", "--arguments", '["first","second"]']);
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ command: "report", status: "ok", code: "report.ok" });
    expect(envelope.data.prompt).toContain('Arguments: ["first","second"]');
    const mcp = await executeCommand("report", { arguments: ["first", "second"] }, context());
    expect(envelope.data.prompt).toBe(mcp.data.prompt);

    const tooLarge = await run(["report", "--arguments", JSON.stringify(["x".repeat(8193)])]);
    expect(JSON.parse(tooLarge.stdout)).toMatchObject({
      command: "report",
      status: "refused",
      code: "report.input-too-large",
      details: { field: "arguments", limit: 8192 },
    });

    const invalid = await run(["report", "--arguments", "[not-json"]);
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      command: "report",
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
    });
  });

  test("report rejects an empty exit status", async () => {
    const result = await run(["report", "--exit-status", ""]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "report", status: "usage", code: "command.invalid-input" });
  });



  test("report rejects unknown and file options as invalid input", async () => {
    for (const option of ["--unknown", "--file"]) {
      const result = await run(["report", option]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "report",
        status: "usage",
        code: "command.invalid-input",
        exitCode: 2,
      });
    }
  });

  test("forwards workflow recovery selectors and multi-value stopped assertions", async () => {
    const args = [
      "workflow", "recover-coordinator",
      "--session", "/tmp/missing-prior-coordinator.json",
      "--operation-id", "recover-op",
      "--reason", "prior coordinator stopped",
      "--authorization-ref", "approval-1",
      "--stopped", "prior-coordinator", "another-stopped-session",
    ];
    const recovered = await run([...args, "--session-id", "cli-main-session"]);
    const recoveredEnvelope = JSON.parse(recovered.stdout);
    expect(recoveredEnvelope.status).toBe("refused");
    expect(recoveredEnvelope.message).not.toContain("recovery requires the main conversation session identity");
    expect(recoveredEnvelope.code).not.toBe("command.invalid-input");

    const priorIdentity = process.env.MSTAR_HOST_SESSION_ID;
    const priorMinted = process.env.MSTAR_EXECUTION_IDENTITY;
    delete process.env.MSTAR_HOST_SESSION_ID;
    delete process.env.MSTAR_EXECUTION_IDENTITY;
    try {
      const withoutRuntimeIdentity = await run(args);
      const usageEnvelope = JSON.parse(withoutRuntimeIdentity.stdout);
      expect(usageEnvelope).toMatchObject({ status: "usage" });
      expect(String(usageEnvelope.message)).toContain("recovery requires the main conversation session identity");
      expect(String(usageEnvelope.message)).toContain("--session-id");
      expect(String(usageEnvelope.message)).toContain("sessionId");
    } finally {
      if (priorIdentity !== undefined) process.env.MSTAR_HOST_SESSION_ID = priorIdentity;
      if (priorMinted !== undefined) process.env.MSTAR_EXECUTION_IDENTITY = priorMinted;
    }
  });

  test("help is a successful parser outcome, not a usage envelope", async () => {
    const result = await run(["schema", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).not.toContain('"status":"usage"');
  });

  test("schema returns the payload field contract", async () => {
    const result = await run(["schema", "CaptureInput"]);
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ version: 1, command: "schema", status: "ok", exitCode: 0 });
    expect(envelope.data.type).toBe("CaptureInput");
    expect(envelope.data.fields.some((field: { name: string }) => field.name === "title")).toBe(true);
  });

  test("published descriptions label only declared input fields as payloads", () => {
    const persist = getCommandDefinitions().find((definition) => definition.id === "persist.write");
    const worktree = getCommandDefinitions().find((definition) => definition.id === "worktree.check");
    if (persist === undefined || worktree === undefined) throw new Error("canonical definitions missing");

    const persistCli = renderCommandContract(persist, "cli");
    expect(persistCli).toContain("Payload contracts: status, snapshot, review, json");
    expect(persistCli).not.toContain("Payload fields:");
    expect(persistCli).not.toContain("decoded against the declared schema");

    const persistMcp = renderCommandContract(persist, "mcp");
    expect(persistMcp).toContain("Payload contracts:");
    expect(persistMcp).not.toContain("Payload fields:");

    const worktreeCli = renderCommandContract(worktree, "cli");
    expect(worktreeCli).toContain("Payload fields: tracks");
    expect(worktreeCli).toContain("Payload field values arrive as JSON strings and are decoded against the declared schema.");
    const worktreeMcp = renderCommandContract(worktree, "mcp");
    expect(worktreeMcp).toContain("Payload fields: tracks");
    expect(worktreeMcp).not.toContain("arrive as JSON strings");
  });

  test("host detect is a real read", async () => {
    const result = await run(["host", "detect", "--signals", "question"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "host.detect", status: "ok", data: { host: "opencode" } });
  });

  test("retired status verb refuses without a mutation", async () => {
    const result = await run(["status", "archive-residuals"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ command: "status.archive-residuals", status: "refused", code: "status.verb-retired" });
  });

  test("unknown options map to a usage envelope and exit 2", async () => {
    const result = await run(["schema", "CaptureInput", "--nope"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout) as {
      status: string;
      code: string;
      exitCode: number;
      details?: { helpRoute?: string; diagnostics?: Array<{ code: string; path?: string }> };
    };
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(envelope.details?.helpRoute).toBe("mstar schema --help");
    // The unknown flag is not a determinable input field: no path is invented.
    expect(envelope.details?.diagnostics?.[0]?.code).toBe("commander.unknownOption");
    expect(envelope.details?.diagnostics?.[0]).not.toHaveProperty("path");
  });

  test("a root unknown option routes recovery to the root help, never a doubled command", async () => {
    const result = await run(["--bogus"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout) as {
      status: string;
      code: string;
      exitCode: number;
      details?: { helpRoute?: string; recovery?: string };
    };
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(envelope.details?.helpRoute).toBe("mstar --help");
    expect(envelope.details?.recovery).toContain("mstar --help");
    expect(JSON.stringify(envelope)).not.toContain("mstar mstar --help");
  });

  test("an unknown command routes recovery to the root help, never an invented leaf route", async () => {
    const result = await run(["definitely-not-a-command"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout) as {
      status: string;
      code: string;
      exitCode: number;
      details?: { helpRoute?: string; recovery?: string };
    };
    expect(envelope).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(envelope.details?.helpRoute).toBe("mstar --help");
    expect(envelope.details?.recovery).toContain("mstar --help");
    expect(JSON.stringify(envelope)).not.toContain("mstar definitely-not-a-command --help");
  });
});

describe("schema selector routes", () => {
  test("CLI --command returns the selected leaf contract with the typed tracks schema", async () => {
    const result = await run(["schema", "--command", "worktree.check"]);
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ version: 1, command: "schema", status: "ok", exitCode: 0 });
    expect(envelope.data.kind).toBe("command");
    expect(envelope.data.descriptor.id).toBe("worktree.check");
    // The discovery route publishes the same contract the runtime enforces:
    // tracks is the typed array, not an opaque placeholder.
    expect(envelope.data.descriptor.input.properties.tracks).toMatchObject({ type: "array" });
    expect(envelope.data.descriptor.payloadSchemas).toHaveProperty("tracks");
  });

  test("CLI --family returns a compact member list", async () => {
    const result = await run(["schema", "--family", "worktree"]);
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.data.kind).toBe("family");
    expect(envelope.data.family).toBe("worktree");
    const ids = envelope.data.members.map((member: { id: string }) => member.id);
    expect(ids).toContain("worktree.check");
    for (const member of envelope.data.members) {
      expect(Object.keys(member).sort()).toEqual(["description", "id"]);
    }
  });

  test("CLI refuses an unknown command id with grouped selectors", async () => {
    const result = await run(["schema", "--command", "no-such-command"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ command: "schema", status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(envelope.message).toContain("available families");
  });

  test("CLI refuses colliding positional and option selectors", async () => {
    const result = await run(["schema", "CaptureInput", "--command", "worktree.check"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("usage");
    expect(envelope.exitCode).toBe(2);
    expect(envelope.message).toContain("exactly one");
  });


});
describe("payload option decoding", () => {
  test("worktree cleanup accepts a lone --worktree path as a one-element list", async () => {
    const result = await run(["worktree", "cleanup", "--worktree", "/abs/some-path"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout);
    // The lone path decoded cleanly into a one-element list: the refusal is
    // the missing --workflow validation, not a payload JSON decode error.
    expect(envelope).toMatchObject({ command: "worktree.cleanup", status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(envelope.message).not.toContain("payload");
    expect(envelope.message).not.toContain("valid JSON");
    // Structured diagnostics (plan 005) may be present, but they must point at
    // the missing --workflow member, never at a payload decode failure.
    for (const diagnostic of envelope.details?.diagnostics ?? []) {
      expect(diagnostic.path).toBe("workflow");
    }
  });

  test("worktree cleanup --apply --worktree <path> decodes the lone path before execution", async () => {
    const result = await run(["worktree", "cleanup", "--apply", "--worktree", "/abs/some-path"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ command: "worktree.cleanup", status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(envelope.message).not.toContain("payload");
    expect(envelope.message).not.toContain("valid JSON");
    for (const diagnostic of envelope.details?.diagnostics ?? []) {
      expect(diagnostic.path).toBe("workflow");
    }
  });

  test("worktree cleanup refuses a JSON-object --worktree occurrence via the declared schema", async () => {
    const result = await run(["worktree", "cleanup", "--worktree", '{"a":1}']);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ command: "worktree.cleanup", status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(envelope.message).toContain("Invalid command payload");
    const diagnostics = envelope.details?.diagnostics as Array<{ path: string }>;
    expect(diagnostics[0]?.path).toBe("worktree[0]");
  });

  test("worktree cleanup refuses a malformed JSON-looking --worktree occurrence", async () => {
    const result = await run(["worktree", "cleanup", "--worktree", "{not json"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ command: "worktree.cleanup", status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(envelope.message).toContain("Invalid command payload");
    const diagnostics = envelope.details?.diagnostics as Array<{ path: string }>;
    expect(diagnostics[0]?.path).toBe("worktree[0]");
  });
});

test("payload decoding reports malformed JSON as usage without executing the command", async () => {
  const result = await run(["report", "--arguments", "[not-json"]);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: "report",
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
  });
});

test("sparse input reaches the command resolver without transport defaulting", async () => {
  const result = await run(["report"]);
  expect(JSON.parse(result.stdout)).toMatchObject({ command: "report", status: "ok" });
});
test("plan payload decode returns indexed field paths in the usage envelope", async () => {
  const result = await run(["plan", "issue-add", "--entries", "[{},5]"]);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: "plan.issue-add",
    status: "usage",
    details: {
      diagnostics: [{ path: "entries[1]", index: 1 }],
    },
  });
});
test("generated CLI adapter decodes schema-typed numeric options and registers booleans as flags", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cli-typed-options-"));
  const source = path.join(root, "roadmap.md");
  writeFileSync(source, "# Roadmap\n");
  try {
    const numeric = await run([
      "roadmap", "replace", "--project", "project-a", "--file", source,
      "--expect-project", "5", "--expect-roadmap", "5", "--operation", "replace-a", "--harness", root,
    ]);
    const numericResult = JSON.parse(numeric.stdout) as { code?: string; message?: string };
    expect(numericResult.code).not.toBe("command.invalid-input");
    expect(numericResult.message ?? "").not.toContain("expected number");

  const boolean = await run(["plan", "bind", "--execution"]);
  const booleanResult = JSON.parse(boolean.stdout) as { message?: string };
  expect(booleanResult.message ?? "").not.toContain("argument missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("generated CLI adapter — minted identity transport", () => {
  const minted = (overrides: Record<string, unknown> = {}): string =>
    serializeExecutionValue({ source: "local", sessionId: "minted-adapter", workflowId: "wf-adapter", role: "coordinator", ...overrides });

  /**
   * One envelope field read by name. The parsed JSON is our own adapter's
   * output; the object-ness is checked and the value read through the
   * descriptor rather than by fabricating a shape.
   */
  function field(value: unknown, key: string): unknown {
    if (typeof value !== "object" || value === null) return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  }

  /** The typed identity cause the adapter discloses in `details.identity.code`. */
  const identityCode = (envelope: unknown): unknown => field(field(envelope, "details"), "identity") === undefined
    ? undefined
    : field(field(field(envelope, "details"), "identity"), "code");

  test("a malformed launched identity refuses through the adapter, never downgrading to the ambient value", async () => {
    const prior = process.env.MSTAR_EXECUTION_IDENTITY;
    const priorHost = process.env.MSTAR_HOST_SESSION_ID;
    try {
      process.env.MSTAR_HOST_SESSION_ID = "ambient-host";
      for (const malformed of ["not json", "[]", '"scalar"', minted({ sessionId: "" }), minted({ planId: null })]) {
        process.env.MSTAR_EXECUTION_IDENTITY = malformed;
        const result = await run(["plan", "bind", "--execution", "--workflow", "wf-adapter", "--coordinator"]);
        const envelope: unknown = JSON.parse(result.stdout);
        expect(field(envelope, "exitCode")).toBe(2);
        expect(field(envelope, "code")).toBe("command.invalid-input");
        // The typed engine cause rides in details (attribution provenance, not a
        // second shape): the ambient host value never substituted.
        expect(String(identityCode(envelope))).toMatch(/^(command\.invalid-identity|coordination\.)/);
      }
    } finally {
      if (prior === undefined) delete process.env.MSTAR_EXECUTION_IDENTITY; else process.env.MSTAR_EXECUTION_IDENTITY = prior;
      if (priorHost === undefined) delete process.env.MSTAR_HOST_SESSION_ID; else process.env.MSTAR_HOST_SESSION_ID = priorHost;
    }
  });

  test("a minted identity addressing another workflow refuses before the command runs", async () => {
    const prior = process.env.MSTAR_EXECUTION_IDENTITY;
    try {
      process.env.MSTAR_EXECUTION_IDENTITY = minted({ workflowId: "wf-elsewhere" });
      const result = await run(["plan", "bind", "--execution", "--workflow", "wf-adapter", "--coordinator"]);
      const envelope: unknown = JSON.parse(result.stdout);
      expect(result.status).toBe(2);
      expect(field(envelope, "code")).toBe("command.invalid-input");
      expect(identityCode(envelope)).toBe("command.identity-scope-mismatch");
    } finally {
      if (prior === undefined) delete process.env.MSTAR_EXECUTION_IDENTITY; else process.env.MSTAR_EXECUTION_IDENTITY = prior;
    }
  });


  test("a retired plan transfer verb is absent from the CLI surface", async () => {
    const result = await run(["plan", "release", "--workflow", "wf-adapter", "--plan", "plan-foreign"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("plan.release.ok");
  });

  test("a plan operation without --plan states the addressing fact it requires", async () => {
    const prior = process.env.MSTAR_EXECUTION_IDENTITY;
    try {
      process.env.MSTAR_EXECUTION_IDENTITY = minted({ workflowId: "wf-adapter" });
      const result = await run(["plan", "progress", "--workflow", "wf-adapter", "--progress", JSON.stringify({ status: "InProgress", summary: "s", evidence_paths: [] })]);
      const envelope: unknown = JSON.parse(result.stdout);
      expect(result.status).toBe(2);
      expect(field(envelope, "code")).toBe("command.invalid-input");
      expect(String(field(envelope, "message"))).toContain("--plan");
    } finally {
      if (prior === undefined) delete process.env.MSTAR_EXECUTION_IDENTITY; else process.env.MSTAR_EXECUTION_IDENTITY = prior;
    }
  });
});
