import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  CommandDefinitionError,
  commandEnvelopeSchema,
  getCommandDefinitions,
  getCommandSchemas,
  getPayloadSchema,
  validateCommandDefinitions,
} from "../src/index.js";
import { ISSUE_PAYLOAD_SCHEMAS } from "@mstar-harness/engine";
import type { CommandDefinition } from "../src/types.js";

function definition(id: string, cliPath: string[]): CommandDefinition<{ name: string }, { greeting: string }> {
  return {
    id,
    cli: { path: cliPath, aliases: [], arguments: [{ key: "name", required: true, variadic: false }], options: [] },
    input: z.object({ name: z.string().min(1) }),
    output: commandEnvelopeSchema,
    effects: ["read"],
    description: "Greet a user",
    async execute(input) {
      return { version: 1, command: id, status: "ok", code: "command.ok", exitCode: 0, data: { greeting: `Hello ${input.name}` } };
    },
  };
}

describe("command definitions", () => {
  test("canonical registry includes all composed family identities", () => {
    // C7 closes the 122-identity census (report=123 via P2).
    expect(getCommandDefinitions()).toHaveLength(122);
    expect(getCommandDefinitions().map(({ id }) => id)).toEqual([
      "status.validate",
      "status.workflow-close",
      "status.archive-residuals",
      "status.findings-cleanup",
      "status.tech-debt",
      "status.backlog-register",
      "status.backlog-close",
      "persist.write",
      "persist.get",
      "persist.list",
      "persist.delete",
      "migrate",
      "lease.verify",
      "lease.verify-integration",
      "iteration.gate",
      "iteration.push-cadence",
      "plan.bind",
      "plan.show",
      "plan.prepare",
      "plan.progress",
      "plan.issue-add",
      "plan.issue-close",
      "plan.handoff",
      "plan.accept",
      "plan.return",
      "plan.integration-start",
      "plan.integration-accept",
      "plan.complete",
      "plan.repair-delivery-source",
      "plan.reconcile",
      "plan.residual-add",
      "plan.residual-close",
      "session.run",
      "session.recover",
      "workflow.register",
      "workflow.evidence",
      "workflow.show-prepare",
      "workflow.amend-prepare",
      "workflow.recover-coordinator",
      "workflow.phase",
      "workflow.lifecycle",
      "workflow.execution-policy",
      "workflow.integration-worktree",
      "iteration.register",
      "issue.add",
      "issue.list",
      "issue.show",
      "issue.occurrence",
      "issue.triage",
      "issue.close",
      "issue.waive",
      "issue.duplicate",
      "issue.supersede",
      "issue.link",
      "issue.export",
      "catalog.discover",
      "catalog.import",
      "catalog.register",
      "catalog.update",
      "catalog.link",
      "catalog.list",
      "catalog.show",
      "catalog.export",
      "catalog.reconcile",
      "roadmap.import",
      "roadmap.replace",
      "roadmap.show",
      "roadmap.export",
      "store.init",
      "store.migrate",
      "store.upgrade",
      "store.backup",
      "store.activate",
      "store.retire",
      "store.execution.preview",
      "store.execution.apply",
      "store.execution.activate",
      "store.execution.retire",
      "store.execution.abort",
      "store.execution.restore-preview",
      "store.execution.restore",
      "store.execution.export",
      "sdd.workspace",
      "sdd.task-brief",
      "sdd.review-package",
      "sdd.check-context",
      "sdd.evidence.capture",
      "sdd.evidence.verify",
      "audit.scaffold",
      "audit.promote",
      "audit.secret-scan",
      "audit.supply-chain",
      "dispatch.validate",
      "worktree.check",
      "worktree.qc-alignment",
      "review.seats",
      "lint",
      "design-md.validate",
      "compound.validate",
      "skill.lint",
      "roles.validate",
      "qc.validate-report",
      "pr-review.tally",
      "pr-review.report-path",
      "pr-review.validate-report",
      "pr-review.post",
      "pr-review.worktree-cleanup",
      "pr-review.size",
      "pr-review.seat-prompt",
      "pr-review.budget",
      "sdd.exec",
      "worktree.cleanup",
      "pr-review.worktree-setup",
      "judgment.review-advice",
      "dashboard",
      "harness.scaffold",
      "doctor",
      "plugin.validate",
      "path.resolve",
      "host.detect",
      "host.skill-root",
      "schema",
    ]);
  });

  test("rejects MCP name collisions after command ID normalization", () => {
    expect(() => validateCommandDefinitions([
      definition("plan.issue-add", ["plan", "issue-add"]),
      definition("plan-issue.add", ["plan-issue", "add"]),
    ])).toThrow("Duplicate MCP tool name: mstar_plan_issue_add");
  });

  test("rejects CLI syntax whose keys diverge from its input schema", () => {
    const valid = definition("greet", ["greet"]);
    const invalid = { ...valid, cli: { ...valid.cli, arguments: [{ ...valid.cli.arguments[0]!, key: "person" }] } };
    expect(() => validateCommandDefinitions([invalid])).toThrow(CommandDefinitionError);
  });

  test("input schemas reject malformed caller input", () => {
    const input = definition("greet", ["greet"]).input;
    expect(input.safeParse({ name: "Ada" }).success).toBe(true);
    expect(input.safeParse({ name: "" }).success).toBe(false);
    expect(input.safeParse({ name: 42 }).success).toBe(false);
  });

  test("keeps payload schema query shape and reuses the engine registry for command schemas", () => {
    const payload = getPayloadSchema("CaptureInput");
    expect(payload.type).toBe("CaptureInput");
    expect(payload.fields.find((field) => field.name === "projectId")).toMatchObject({ required: true, type: "string" });
    expect(() => getPayloadSchema("NotAPayload")).toThrow("Unknown payload type");
    const commandSchemas = getCommandSchemas([definition("greet", ["greet"])]);
    expect(commandSchemas).toHaveLength(1);
    expect(commandSchemas[0]!.input).toMatchObject({ type: "object", properties: { name: { type: "string" } } });
    expect(commandSchemas[0]!.payloadSchemas.CaptureInput).toBe(ISSUE_PAYLOAD_SCHEMAS.CaptureInput);
  });
});
