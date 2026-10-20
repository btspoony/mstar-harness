// Build @mstar-harness/commands before running this isolated SDK consumer suite.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { commandEnvelopeSchema, getCommandDefinitions, type CommandDefinition, type CommandEnvelope, type InvocationContext } from "@mstar-harness/commands";
import { z } from "zod";
import { registerMcpCommands } from "../src/mcp/register.js";

async function withClient(definitions: readonly CommandDefinition[], run: (client: Client, cwd: string) => Promise<void>) {
  const cwd = mkdtempSync(join(tmpdir(), "mstar-mcp-consumer-"));
  const server = new McpServer({ name: "isolated-command-server", version: "1.0.0" });
  const client = new Client({ name: "independent-command-consumer", version: "1.0.0" });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  try {
    registerMcpCommands(server, definitions, (_definition, _sessionId, signal, _services, effects): InvocationContext => ({
      cwd, controlRoot: null, signal, effects,
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    }));
    await server.connect(serverEnd);
    await client.connect(clientEnd);
    await run(client, cwd);
  } finally {
    await client.close();
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** The folded tool one command id publishes under, and the `action` selecting it. */
function folded(id: string): { name: string; action: string } {
  const dot = id.indexOf(".");
  return {
    name: `mstar_${(dot === -1 ? id : id.slice(0, dot)).replace(/[.-]/g, "_")}`,
    action: dot === -1 ? id : id.slice(dot + 1),
  };
}

function definition(id: string): CommandDefinition {
  const found = getCommandDefinitions().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
}

// SDK pre-handler rejection is isError/text, not structuredContent. Its text
// must contain the safe canonical refusal, after the SDK's own validation prefix.
function envelope(result: CallToolResult): CommandEnvelope {
  if (result.structuredContent !== undefined) return result.structuredContent as CommandEnvelope;
  const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const start = text.indexOf('{"version":1,');
  if (start < 0) throw new Error(`SDK result lost recoverable command facts: ${text}`);
  return JSON.parse(text.slice(start)) as CommandEnvelope;
}

function diagnostics(result: CommandEnvelope): Array<Record<string, unknown>> {
  const entries = result.details?.diagnostics;
  if (!Array.isArray(entries)) throw new Error("missing grouped input diagnostics");
  return entries;
}

// A real, effect-free command with observable computation, not a forwarding
// mock. It exercises the same descriptor/admission/SDK interfaces as families.
const evaluate: CommandDefinition = {
  id: "fixture.evaluate",
  description: "Sum numeric payloads or normalize a label with caller attribution.",
  effects: ["validate"],
  cli: {
    path: ["fixture", "evaluate"], aliases: [], arguments: [],
    options: [
      { key: "mode", flags: "--mode <mode>", required: false, defaultValue: "sum" },
      { key: "base", flags: "--base <number>", required: false, defaultValue: 10 },
      { key: "payload", flags: "--payload <json>", required: false },
      { key: "label", flags: "--label <text>", required: false },
      { key: "sessionId", flags: "--session-id <id>", required: false, context: "sessionId" },
    ],
  },
  input: z.object({
    mode: z.enum(["sum", "label"]).optional(), base: z.number().int().optional(),
    payload: z.unknown().optional(), label: z.string().min(1).optional(),
  }).strict(),
  payloads: { payload: { schema: z.object({ numbers: z.array(z.number()).min(1) }).strict() } },
  requirements: [
    { name: "payload", route: "mcp", ownership: "caller", required: true, condition: { field: "mode", equals: "sum" } },
    { name: "label", route: "mcp", ownership: "caller", required: true, condition: { field: "mode", equals: "label" } },
  ],
  output: commandEnvelopeSchema,
  async execute(input, context) {
    const value = input as { mode: string; base: number; payload?: { numbers: number[] }; label?: string };
    const data = value.mode === "label"
      ? { label: value.label!.toUpperCase(), owner: context.sessionId ?? "anonymous" }
      : { total: value.payload!.numbers.reduce((sum, number) => sum + number, value.base), owner: context.sessionId ?? "anonymous" };
    return { version: 1, command: "fixture.evaluate", status: "ok", code: "fixture.evaluate.ok", exitCode: 0, data };
  },
};

describe("registered MCP transport consumers", () => {
  test("qc report discovery and omitted/supplied calls agree at the actual SDK boundary", async () => {
    await withClient([definition("qc.validate-report")], async (client, cwd) => {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "mstar_qc");
      expect(tool?.inputSchema.required).toEqual(["action"]);
      expect(tool?.inputSchema.properties).toMatchObject({
        action: { enum: ["validate-report"] },
        reportFile: { type: "string" },
      });

      const omitted = await client.callTool({ name: "mstar_qc", arguments: { action: "validate-report" } });
      expect(omitted.isError).toBe(true);
      expect(omitted.structuredContent).toBeUndefined();
      const refusal = envelope(omitted);
      expect(refusal).toMatchObject({ command: "qc.validate-report", status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(diagnostics(refusal)).toContainEqual(expect.objectContaining({ path: "reportFile", expected: "string", received: "undefined" }));
      expect(refusal.details).toMatchObject({ helpRoute: "mstar qc validate-report --help", recovery: expect.stringContaining("mstar qc validate-report --help") });

      const forgedAdmission = envelope(await client.callTool({
        name: "mstar_qc",
        arguments: { action: "validate-report", success: true, data: { reportFile: "unvalidated.md" }, definition: { id: "report" } },
      }));
      expect(forgedAdmission).toMatchObject({ command: "qc.validate-report", status: "usage", code: "command.invalid-input" });
      expect(diagnostics(forgedAdmission)).toContainEqual(expect.objectContaining({ path: "reportFile", received: "undefined" }));

      const reportFile = join(cwd, "invalid-report.md");
      writeFileSync(reportFile, "# Incomplete seat report\n");
      const supplied = await client.callTool({ name: "mstar_qc", arguments: { action: "validate-report", reportFile } });
      const domain = envelope(supplied);
      expect(supplied.isError).toBe(true);
      expect(domain).toMatchObject({ status: "refused", code: "qcreview.report.missing-frontmatter", exitCode: 1 });
      expect(domain.details?.violations).toContainEqual(expect.objectContaining({ code: "qcreview.report.missing-frontmatter", fix: expect.any(String) }));
      expect(domain.details?.helpRoute).toBe("mstar qc validate-report --help");
      const validReport = join(cwd, "valid-report.md");
      writeFileSync(validReport, `---
report_kind: qc
reviewer: fixture-reviewer
reviewer_index: 1
plan_id: fixture-plan
verdict: Approve
generated_at: 2026-01-02
---

**Verdict**: Approve
`);
      const valid = await client.callTool({ name: "mstar_qc", arguments: { action: "validate-report", reportFile: validReport } });
      expect(valid.isError).not.toBe(true);
      expect(envelope(valid)).toMatchObject({ status: "ok", code: "qc.validate-report.ok", data: { ok: true, violations: [] } });
    });
  });


  test("defaulted conditional payloads and optional identity survive real publication and admission", async () => {
    await withClient([evaluate], async (client) => {
      const { tools } = await client.listTools();
      const schema = tools.find((entry) => entry.name === "mstar_fixture")!.inputSchema;
      expect(schema.required).toEqual(["action"]);
      expect(schema.properties).toMatchObject({
        action: { enum: ["evaluate"] },
        mode: { enum: ["sum", "label"] },
        sessionId: { type: "string" },
      });
      // Per-action defaults and nested payload shapes are `mstar_schema`
      // detail: the family contract is the field index, not one action's
      // conditional requirements.
      expect(schema.required ?? []).not.toContain("payload");
      expect(schema.required ?? []).not.toContain("label");
      expect(schema.required ?? []).not.toContain("sessionId");

      const defaulted = await client.callTool({ name: "mstar_fixture", arguments: { action: "evaluate", payload: { numbers: [2, 3] } } });
      expect(defaulted.isError).not.toBe(true);
      expect(envelope(defaulted)).toMatchObject({ status: "ok", data: { total: 15, owner: "anonymous" } });
      const labeled = await client.callTool({ name: "mstar_fixture", arguments: { action: "evaluate", mode: "label", label: "hello", sessionId: "caller-seat" } });
      expect(labeled.isError).not.toBe(true);
      expect(envelope(labeled)).toMatchObject({ status: "ok", data: { label: "HELLO", owner: "caller-seat" } });

      const missing = envelope(await client.callTool({ name: "mstar_fixture", arguments: { action: "evaluate" } }));
      expect(diagnostics(missing)).toContainEqual(expect.objectContaining({ path: "payload", expected: "present", received: "undefined" }));
      expect(diagnostics(missing).some((entry) => entry.path === "label")).toBe(false);
      const wrongBranch = envelope(await client.callTool({ name: "mstar_fixture", arguments: { action: "evaluate", mode: "label", payload: { numbers: [1] } } }));
      expect(diagnostics(wrongBranch)).toContainEqual(expect.objectContaining({ path: "label", expected: "present", received: "undefined" }));
      const emptyIdentity = envelope(await client.callTool({ name: "mstar_fixture", arguments: { action: "evaluate", payload: { numbers: [1] }, sessionId: " " } }));
      expect(diagnostics(emptyIdentity)).toContainEqual(expect.objectContaining({ path: "sessionId", expected: "non-empty string" }));
    });
  });

  test("composed payload failures retain grouped safe facts instead of generic SDK prose", async () => {
    await withClient([evaluate], async (client) => {
      // Built by join so secret scanners do not flag the canary literal in
      // source; the runtime value is the same credential-shaped string the
      // redaction contract must withhold.
      const secret = ["sk", "live-consumer-secret"].join("-");
      const result = await client.callTool({ name: "mstar_fixture", arguments: { action: "evaluate", payload: { numbers: [secret, null] } } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
      const refusal = envelope(result);
      expect(refusal).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(diagnostics(refusal)).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "payload.numbers[0]", expected: "number", received: "[REDACTED]" }),
        expect.objectContaining({ path: "payload.numbers[1]", expected: "number", received: "null" }),
      ]));
      expect(refusal.details?.diagnosticSummary).toMatchObject({ total: 2, shown: 2, omitted: 0 });
      expect(refusal.details?.recovery).toContain("mstar fixture evaluate --help");
    });
  });
  test("PR seat-prompt publishes and consumes conditional accepted-value facts through MCP", async () => {
    await withClient([definition("pr-review.seat-prompt")], async (client, cwd) => {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "mstar_pr_review")!;
      expect(tool.inputSchema.properties).toMatchObject({ action: { enum: expect.arrayContaining(["seat-prompt"]) } });
      // The family description lists each action's unconditional required
      // fields; conditional accepted-value facts live in the command contract
      // that `mstar_schema` serves.
      expect(tool.description).toContain("- seat-prompt: stage, domain, seat");
      expect(tool.inputSchema["x-mstar-requirements"]).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "action" }),
      ]));

      const ordinary = await client.callTool({
        name: "mstar_pr_review",
        arguments: { action: "seat-prompt", stage: "1", domain: "cli", seat: "reviewer", collectFolded: false },
      });
      expect(envelope(ordinary).status).toBe("ok");

      // Same join-built canary: identical runtime value, no secret-shaped
      // literal in source for scanners to flag.
      const secret = ["sk", "live-consumer-secret"].join("-");
      const rejected = await client.callTool({
        name: "mstar_pr_review",
        arguments: { action: "seat-prompt", stage: secret, domain: "cli", seat: "reviewer" },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).not.toContain(secret);
      expect(diagnostics(envelope(rejected))).toContainEqual(expect.objectContaining({
        path: "stage", code: "not_allowed", received: '"[REDACTED]"',
      }));

      const aggregate = await client.callTool({
        name: "mstar_pr_review",
        arguments: { action: "seat-prompt", stage: secret, domain: { secret }, seat: "reviewer", collectFolded: true, security: true },
      });
      expect(aggregate.isError).toBe(true);
      expect(JSON.stringify(aggregate)).not.toContain(secret);
      const refusal = envelope(aggregate);
      expect(diagnostics(refusal)).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "domain", code: "invalid_type", received: "object" }),
        expect.objectContaining({ path: "stage", code: "not_allowed", expected: '"2"', received: '"[REDACTED]"' }),
        expect.objectContaining({ path: "diffFile", code: "required" }),
        expect.objectContaining({ path: "security", code: "not_allowed", expected: "false" }),
      ]));
    });
  });

  test("large SDK rejection keeps all safe diagnostics and a bounded truthful summary", async () => {
    await withClient([definition("worktree.qc-alignment")], async (client) => {
      const result = await client.callTool({ name: "mstar_worktree", arguments: { action: "qc-alignment", files: Array(5000).fill(42) } });
      expect(result.isError).toBe(true);
      const refusal = envelope(result);
      expect(diagnostics(refusal)).toHaveLength(5000);
      expect(diagnostics(refusal)[4999]).toMatchObject({ path: "files[4999]", index: 4999, expected: "string", received: "42" });
      if (refusal.status === "ok") throw new Error("expected refusal");
      expect(refusal.message.length).toBeLessThan(3000);
      expect(refusal.message).toContain("5000");
      expect(refusal.message).toContain("files[0]");
      expect(refusal.message).toContain("received 42");
      const counts = refusal.details?.diagnosticSummary as { total: number; shown: number; omitted: number };
      expect(counts.total).toBe(5000);
      expect(counts.shown).toBeGreaterThan(1);
      expect(counts.shown + counts.omitted).toBe(counts.total);
      expect(refusal.message).toContain(String(counts.omitted));
    });
  });

  test("the SDD missing-task exit-3 refusal survives the MCP consumer round trip", async () => {
    await withClient([definition("sdd.task-brief")], async (client, cwd) => {
      const planFile = join(cwd, "plan.md");
      writeFileSync(planFile, "# Plan\n\n### Task 1: first task\n\n- [ ] step one\n");
      const result = await client.callTool({
        name: "mstar_sdd",
        arguments: { action: "task-brief", planFile, taskNumber: "9", outfile: join(cwd, "task-9-brief.md") },
      });
      expect(result.isError).toBe(true);
      const refusal = envelope(result);
      // The nonstandard exit 3 is the SDD contract; the MCP surface must carry
      // it, the engine's first-line message, and the recovery metadata — not
      // collapse it to a generic exit 1 with a re-derived message.
      expect(refusal).toMatchObject({ command: "sdd.task-brief", status: "refused", exitCode: 3 });
      expect(String(refusal.message).split("\n")[0]).toContain("task 9 not found");
      expect(refusal.details?.helpRoute).toBe("mstar sdd task-brief --help");
      expect(refusal.details?.recovery).toEqual(expect.stringContaining("mstar sdd task-brief"));
    });
  });

  test("domain payloads stay constructible while pathname and kind-keyed contracts keep their actual transport", async () => {
    await withClient([definition("issue.add"), definition("workflow.execution-policy"), definition("persist.write"), definition("schema")], async (client) => {
      const { tools } = await client.listTools();
      // The family contract is the field index: the domain payload shape is
      // one action's detail, served by `mstar_schema` instead of being
      // repeated inside every family schema.
      const issue = tools.find((entry) => entry.name === "mstar_issue")!.inputSchema;
      expect(issue.properties).toMatchObject({ action: { enum: expect.arrayContaining(["add"]) }, payload: {} });
      const detail = envelope(await client.callTool({
        name: "mstar_schema", arguments: { action: "schema", command: "issue.add" },
      }));
      expect(JSON.stringify(detail)).toContain("rootCauseKey");
      const malformed = envelope(await client.callTool({
        name: "mstar_issue", arguments: { action: "add", payload: {}, operationId: "fixture-capture", actor: "project-manager" },
      }));
      expect(malformed).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(diagnostics(malformed)).toContainEqual(expect.objectContaining({ path: "payload.rootCauseKey", received: "undefined" }));

      const policy = tools.find((entry) => entry.name === "mstar_workflow")!.inputSchema;
      expect(policy.properties).toMatchObject({ file: { type: "string" } });
      const wrongTransport = envelope(await client.callTool({ name: "mstar_workflow", arguments: { action: "execution-policy", file: { policy: "fixture" } } }));
      expect(diagnostics(wrongTransport)).toContainEqual(expect.objectContaining({ path: "file", expected: "string", received: "object" }));

      const persist = tools.find((entry) => entry.name === "mstar_persist")!.inputSchema;
      const properties = persist.properties as Record<string, unknown>;
      expect(properties).toHaveProperty("input");
      expect(properties).toHaveProperty("file");
      for (const kind of ["status", "snapshot", "review", "json"]) expect(properties).not.toHaveProperty(kind);
    });
  });

  test("the resolver receives only the primitive session selector while the handler runs on the admitted value", async () => {
    const selections: Array<{ sessionId: string | undefined }> = [];
    const cwd = mkdtempSync(join(tmpdir(), "mstar-mcp-selection-"));
    const server = new McpServer({ name: "selection-server", version: "1.0.0" });
    const client = new Client({ name: "selection-consumer", version: "1.0.0" });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    try {
      registerMcpCommands(server, [evaluate], (_definition, sessionId, signal, _services, effects): InvocationContext => {
        selections.push({ sessionId });
        return {
          cwd, controlRoot: null, signal, effects,
          versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
          // A resolver default the admitted selector must override.
          sessionId: "resolver-default",
        };
      });
      await server.connect(serverEnd);
      await client.connect(clientEnd);
      const result = await client.callTool({
        name: "mstar_fixture",
        arguments: { action: "evaluate", payload: { numbers: [2, 3] }, sessionId: "caller-seat" },
      });
      expect(result.isError).not.toBe(true);
      // The handler observed the schema-validated value and the admitted
      // selector, not the resolver default and not a caller-replaceable alias.
      expect(envelope(result)).toMatchObject({ status: "ok", data: { total: 15, owner: "caller-seat" } });
      // Only the primitive fact admission validated reached the resolver: no
      // parsed handler value is available to it at all.
      expect(selections).toEqual([{ sessionId: "caller-seat" }]);
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the actual schema tool admits each selector alternative and preserves invalid-input recovery", async () => {
    await withClient([definition("schema")], async (client) => {
      const { tools } = await client.listTools();
      // A union input (`schema` is three strict selector alternatives) still
      // publishes every alternative's fields on its folded tool.
      const tool = tools.find((entry) => entry.name === "mstar_schema")!.inputSchema;
      expect(tool.properties).toMatchObject({
        action: { enum: ["schema"] }, command: { type: "string" }, family: { type: "string" }, type: { type: "string" },
      });
      const family = envelope(await client.callTool({ name: "mstar_schema", arguments: { action: "schema", family: "worktree" } }));
      expect(family).toMatchObject({ status: "ok", data: { kind: "family", family: "worktree" } });
      const leaf = envelope(await client.callTool({ name: "mstar_schema", arguments: { action: "schema", command: "qc.validate-report" } }));
      expect(leaf).toMatchObject({ status: "ok", data: { kind: "command", descriptor: { required: ["reportFile"] } } });
      const payload = envelope(await client.callTool({ name: "mstar_schema", arguments: { action: "schema", type: "CaptureInput" } }));
      expect(payload).toMatchObject({ status: "ok", data: { type: "CaptureInput" } });
      const empty = envelope(await client.callTool({ name: "mstar_schema", arguments: { action: "schema" } }));
      expect(empty).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(empty.details?.helpRoute).toBe("mstar schema --help");
      const collision = envelope(await client.callTool({ name: "mstar_schema", arguments: { action: "schema", command: "qc.validate-report", family: "worktree" } }));
      expect(collision).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    });
  });
});
