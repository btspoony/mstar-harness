// Build prerequisite: run `bun run --cwd packages/commands build` before this package test.
// These adapter tests load @mstar-harness/commands through its generated package entry.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { Command, CommanderError } from "commander";
import { executeCommand, getCommandDefinitions } from "@mstar-harness/commands";
import { registerMcpCommand } from "../src/mcp/command";
import { mcpToolInputSchema, registerMcpCommands } from "../src/mcp/register";
import { mapParserError, registerCliCommands, renderCommandContract, usageEnvelope } from "../src/command-adapter";
import type { CommandDefinition, InvocationContext } from "@mstar-harness/commands";

const census = [
  "harness.scaffold", "doctor", "plugin.validate", "path.resolve", "status.validate", "status.workflow-close",
  "status.archive-residuals", "status.findings-cleanup", "status.tech-debt", "status.backlog-register", "status.backlog-close",
  "workflow.register", "workflow.evidence", "workflow.show-prepare", "workflow.amend-prepare", "workflow.recover-coordinator",
  "workflow.phase", "workflow.lifecycle", "workflow.execution-policy", "workflow.integration-worktree", "migrate",
  "persist.get", "persist.list", "persist.delete", "persist.write", "lease.verify", "lease.verify-integration",
  "sdd.workspace", "sdd.task-brief", "sdd.review-package", "sdd.check-context", "sdd.exec", "sdd.evidence.capture",
  "sdd.evidence.verify", "iteration.gate", "iteration.register", "iteration.push-cadence", "dispatch.validate",
  "worktree.check", "worktree.qc-alignment", "worktree.cleanup", "review.seats", "lint", "design-md.validate",
  "audit.scaffold", "audit.promote", "audit.secret-scan", "audit.supply-chain", "compound.validate", "host.detect",
  "host.skill-root", "skill.lint", "roles.validate", "pr-review.tally", "pr-review.report-path", "pr-review.validate-report",
  "pr-review.post", "pr-review.worktree-cleanup", "pr-review.size", "pr-review.seat-prompt", "pr-review.worktree-setup",
  "milestone.add", "milestone.update", "milestone.assign", "milestone.list", "milestone.status",
  "pr-review.budget", "qc.validate-report",
  "catalog.discover", "catalog.import", "catalog.register", "catalog.update", "catalog.link", "catalog.list", "catalog.show", "catalog.export", "catalog.reconcile", "roadmap.import", "roadmap.replace",
  "roadmap.show", "roadmap.export", "issue.add", "issue.list", "issue.show", "issue.occurrence", "issue.triage", "issue.close",
  "issue.waive", "issue.duplicate", "issue.supersede", "issue.link", "issue.export", "schema", "plan.bind", "plan.show",
  "plan.prepare", "plan.progress", "plan.issue-add", "plan.issue-close", "plan.residual-add", "plan.residual-close",
  "plan.handoff", "plan.accept", "plan.return", "plan.integration-start", "plan.integration-accept", "plan.complete",
  "plan.reconcile", "plan.repair-delivery-source", "session.recover", "session.run", "store.init", "store.migrate",
  "store.safe-upgrade", "store.backup", "store.activate", "store.retire", "store.execution.preview", "store.execution.apply",
  "store.execution.activate", "store.execution.retire", "store.execution.abort", "store.execution.restore-preview",
  "store.execution.restore", "store.execution.export", "judgment.review-advice", "dashboard", "report",
];

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
  test("MCP tool schemas publish the domain-owned payload contract instead of an opaque field", () => {
    const definitions = getCommandDefinitions();
    const definition = (id: string): CommandDefinition => {
      const found = definitions.find((entry) => entry.id === id);
      if (found === undefined) throw new Error(`missing command definition: ${id}`);
      return found;
    };

    // An issue verb's placeholder `payload: z.unknown().optional()` becomes the
    // per-verb domain schema, so `tools/list` carries the constructible shape.
    const schema = mcpToolInputSchema(definition("issue.add")).toJSONSchema() as {
      properties: Record<string, Record<string, unknown>>;
      required?: readonly string[];
    };
    expect(schema.properties.payload).toMatchObject({ type: "object" });
    // The published payload carries the real domain contract, not `{}`.
    expect(schema.properties.payload.required).toContain("rootCauseKey");
    expect(Object.keys((schema.properties.payload.properties ?? {}) as object)).toContain("title");
    // …and stays transport-optional: the domain handler owns the requirement.
    expect(schema.required ?? []).not.toContain("payload");

    // A field the family itself shapes stays its own contract: the workflow
    // `--file` descriptor must not turn an absolute pathname into a document.
    const policy = mcpToolInputSchema(definition("workflow.execution-policy")).toJSONSchema() as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(policy.properties.file).toMatchObject({ type: "string" });

    // A descriptor keyed by a VALUE of the command's own argument
    // (`persist.write` declares one contract per `kind`) names no input field,
    // so it is never injected: a published tool field the handler does not read
    // is a capability `tools/list` must not advertise. The handler reads the
    // document from `input`/`file` only.
    const persist = mcpToolInputSchema(definition("persist.write")).toJSONSchema() as {
      properties: Record<string, unknown>;
      required?: readonly string[];
    };
    for (const field of ["status", "snapshot", "review", "json"]) {
      expect(Object.keys(persist.properties)).not.toContain(field);
      expect(persist.required ?? []).not.toContain(field);
    }
    // …and the transport the handler does read stays published.
    expect(Object.keys(persist.properties)).toContain("input");
    expect(Object.keys(persist.properties)).toContain("file");
  });

  test("a workflow --file pathname reaches the domain reader instead of being JSON-decoded", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mstar-workflow-file-"));
    try {
      const file = path.join(dir, "delivery.json");
      writeFileSync(file, JSON.stringify({ compound: { outcome: "created" } }));
      const result = await run(["workflow", "evidence", "--workflow", "cli-payload-probe", "--file", file]);
      const body = JSON.parse(result.stdout) as { code?: string; status?: string; message?: string };
      // The path must not be parsed as a JSON document: a payload-decode
      // failure is exactly the regression this guards.
      expect(body.message ?? "").not.toContain("Invalid command payload");
      expect(body.code).not.toBe("command.invalid-input");
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  test("report census accounts for every canonical identity and excludes installer init", () => {
    const ids = getCommandDefinitions().map(({ id }) => id);
    expect(new Set(ids)).toEqual(new Set(census));
    expect(ids).toHaveLength(128);
    expect(ids).not.toContain("init");
    expect(ids).toContain("report");
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
      "--expect-snapshot", "snapshot-token",
      "--expect-compass", "compass-token",
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

    const withoutRuntimeIdentity = await run(args);
    expect(JSON.parse(withoutRuntimeIdentity.stdout)).toMatchObject({
      status: "usage",
      message: "recovery requires the main conversation session identity",
    });
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
    expect(JSON.parse(result.stdout)).toMatchObject(usageEnvelope("schema", JSON.parse(result.stdout).message));
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

  test("MCP registers the schema tool with the exactly-one input contract", () => {
    const definition = getCommandDefinitions().find((entry) => entry.id === "schema");
    if (definition === undefined) throw new Error("schema command definition missing");
    const toolSchema = mcpToolInputSchema(definition).toJSONSchema() as { anyOf?: readonly Record<string, unknown>[] };
    const branches = toolSchema.anyOf ?? [];
    expect(branches).toHaveLength(3);
    const selectorKeys = branches.map((branch) => {
      expect(branch.additionalProperties).toBe(false);
      const properties = Object.keys(branch.properties as object);
      expect(properties).toHaveLength(1);
      return properties[0];
    });
    expect(selectorKeys).toEqual(["command", "family", "type"]);
  });

  test("MCP schema tool resolves a family query and refuses an empty one", async () => {
    let handler: ((input: unknown, extra: { mcpReq: { signal: AbortSignal } }) => Promise<unknown>) | undefined;
    const server = {
      registerTool(name: string, _options: unknown, registered: typeof handler) {
        if (name === "mstar_schema") handler = registered;
      },
    };
    registerMcpCommands(server as never, getCommandDefinitions(), () => context());
    if (handler === undefined) throw new Error("mstar_schema tool not registered");
    const signal = { mcpReq: { signal: new AbortController().signal } };

    const family = await handler!({ family: "worktree" }, signal) as {
      structuredContent: { status: string; data: { kind: string; members: readonly { id: string }[] } };
    };
    expect(family.structuredContent.status).toBe("ok");
    expect(family.structuredContent.data.kind).toBe("family");
    expect(family.structuredContent.data.members.some((member) => member.id === "worktree.check")).toBe(true);

    const empty = await handler!({}, signal) as {
      structuredContent: { status: string; code: string; message: string };
    };
    expect(empty.structuredContent.status).toBe("usage");
    expect(empty.structuredContent.exitCode).toBe(2);
    expect(empty.structuredContent.message).toContain("exactly one");
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
    expect(envelope.details?.diagnostics).toBeUndefined();
  });

  test("worktree cleanup --apply --worktree <path> decodes the lone path before execution", async () => {
    const result = await run(["worktree", "cleanup", "--apply", "--worktree", "/abs/some-path"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ command: "worktree.cleanup", status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(envelope.message).not.toContain("payload");
    expect(envelope.message).not.toContain("valid JSON");
    expect(envelope.details?.diagnostics).toBeUndefined();
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
