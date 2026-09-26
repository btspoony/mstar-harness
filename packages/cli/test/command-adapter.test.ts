// Build prerequisite: run `bun run --cwd packages/commands build` before this package test.
// These adapter tests load @mstar-harness/commands through its generated package entry.

import { describe, expect, test } from "bun:test";
import { Command, CommanderError } from "commander";
import { getCommandDefinitions } from "@mstar-harness/commands";
import { mapParserError, registerCliCommands, usageEnvelope } from "../src/command-adapter";
import type { InvocationContext } from "@mstar-harness/commands";

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
  "pr-review.budget", "qc.validate-report", "catalog.discover", "catalog.import", "catalog.register", "catalog.update",
  "catalog.link", "catalog.list", "catalog.show", "catalog.export", "catalog.reconcile", "roadmap.import", "roadmap.replace",
  "roadmap.show", "roadmap.export", "issue.add", "issue.list", "issue.show", "issue.occurrence", "issue.triage", "issue.close",
  "issue.waive", "issue.duplicate", "issue.supersede", "issue.link", "issue.export", "schema", "plan.bind", "plan.show",
  "plan.prepare", "plan.progress", "plan.issue-add", "plan.issue-close", "plan.residual-add", "plan.residual-close",
  "plan.handoff", "plan.accept", "plan.return", "plan.integration-start", "plan.integration-accept", "plan.complete",
  "plan.reconcile", "plan.repair-delivery-source", "session.recover", "session.run", "store.init", "store.migrate",
  "store.upgrade", "store.backup", "store.activate", "store.retire", "store.execution.preview", "store.execution.apply",
  "store.execution.activate", "store.execution.retire", "store.execution.abort", "store.execution.restore-preview",
  "store.execution.restore", "store.execution.export", "judgment.review-advice", "dashboard",
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

async function run(args: string[], definitions: readonly CommandDefinition[] = getCommandDefinitions()): Promise<{ status: number; stdout: string; stderr: string }> {
  const program = new Command();
  program.name("mstar").exitOverride();
  registerCliCommands(program, definitions, context());
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

describe("generated CLI adapter", () => {
  test("accounts for every census identity and excludes installer init", () => {
    const ids = getCommandDefinitions().map(({ id }) => id);
    expect(new Set(ids)).toEqual(new Set(census));
    expect(ids).not.toContain("init");
    expect(ids).not.toContain("report");
  });

  test("forwards declared CLI context selectors through the real handler", async () => {
    const result = await run(["plan", "bind", "--resume-ref", "invalid-ref", "--session-id", "cli-main-session"]);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).not.toBe("usage");
    expect(envelope.message).not.toContain("active resume requires runtime session identity");
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
    expect(JSON.parse(result.stdout)).toMatchObject(usageEnvelope("schema.CaptureInput", JSON.parse(result.stdout).message));
  });
});
