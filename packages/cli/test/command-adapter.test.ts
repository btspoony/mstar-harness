// Build prerequisite: run `bun run --cwd packages/commands build` before this package test.
// These adapter tests load @mstar-harness/commands through its generated package entry.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { Command, CommanderError } from "commander";
import { executeCommand, getCommandDefinitions } from "@mstar-harness/commands";
import {
  bindExecutionSession, createExecutionWorkflow, encodeExecutionSessionRef, executionContextFor,
  initializeExecutionAuthority, initializeStore, openStore, serializeExecutionValue,
  type ExecutionIdentity, type ExecutionSessionRef, type ExecutionToken,
} from "@mstar-harness/engine";
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

/**
 * One isolated issue harness with an initialized store whose writer is sealed
 * (the sibling fixture pattern): the registered CLI opens the store read-only,
 * and a just-closed writer's deferred cleanup can otherwise race that open.
 */
async function cliHarness(): Promise<{ root: string; harness: string; invocation: InvocationContext }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "cli-adapter-issue-"));
  const harness = path.join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  (await initializeStore({ harnessDir: harness })).close();
  (await openStore({ harnessDir: harness }, "read")).close();
  return { root, harness, invocation: { ...context(), cwd: root, controlRoot: harness } };
}

async function run(
  args: string[],
  definitions: readonly CommandDefinition[] = getCommandDefinitions(),
  includeMcp = false,
  invocation: InvocationContext = context(),
): Promise<{ status: number; stdout: string; stderr: string }> {
  const program = new Command();
  program.name("mstar").exitOverride();
  registerCliCommands(program, definitions, invocation);
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
  test("registered workflow-note append accepts acquired CLI context identities and rejects unsafe selectors", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cli-note-identity-"));
    const harnessDir = path.join(root, ".mstar");
    mkdirSync(harnessDir, { recursive: true });
    const storeContext = { harnessDir };
    (await initializeStore(storeContext)).close();
    const initialized = await initializeExecutionAuthority(storeContext);
    const workflow = "wf-cli-note-identity";
    const coordinator = "cli-note-coordinator";
    const identity: ExecutionIdentity = { source: "local", sessionId: coordinator, workflowId: workflow, role: "coordinator" };
    const created = await createExecutionWorkflow(executionContextFor(storeContext, identity), {
      entry: { id: workflow, type: "plan", status: "running", started_at: "2026-10-08T00:00:00Z", dir: `workflows/${workflow}` } as never,
      snapshot: {
        schema_version: 1, id: workflow, type: "plan", status: "running",
        started_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z",
        plans: [{ id: "p-1", title: "Plan One", file: "plans/p-1.md", status: "InProgress" }],
      } as never,
      expected: initialized.token,
      operationId: "create-cli-note-workflow",
    });
    const workflowToken = (created.data as unknown as { workflows: Array<{ workflowToken: ExecutionToken }> }).workflows[0]!.workflowToken;
    const bound = await bindExecutionSession(executionContextFor(storeContext, identity), {
      workflowId: workflow, expected: workflowToken, operationId: "bind-cli-note-coordinator",
    });
    const sessionRef = encodeExecutionSessionRef(bound.data as ExecutionSessionRef);
    // Settle the writer-close sidecars before the registered CLI opens its
    // reader, matching the existing fixture seal used by other CLI routes.
    (await openStore({ harnessDir }, "read")).close();
    const priorHost = process.env.MSTAR_HOST_SESSION_ID;
    const priorMinted = process.env.MSTAR_EXECUTION_IDENTITY;
    const ledgerPath = path.join(harnessDir, "workflows", workflow, "notes.jsonl");
    const append = (id: string, flags: string[] = []) => run([
      "workflow-note", "append", "--workflow", workflow, "--session-ref", sessionRef,
      "--id", id, "--text", id, "--harness", harnessDir, ...flags,
    ]);
    try {
      delete process.env.MSTAR_EXECUTION_IDENTITY;
      process.env.MSTAR_HOST_SESSION_ID = coordinator;
      const ambient = await append("ambient-note");
      expect(ambient.status).toBe(0);
      expect(JSON.parse(ambient.stdout)).toMatchObject({ status: "ok", data: { id: "ambient-note" } });

      delete process.env.MSTAR_HOST_SESSION_ID;
      process.env.MSTAR_EXECUTION_IDENTITY = JSON.stringify(identity);
      const minted = await append("minted-note");
      expect(minted.status).toBe(0);
      expect(JSON.parse(minted.stdout)).toMatchObject({ status: "ok", data: { id: "minted-note" } });

      delete process.env.MSTAR_EXECUTION_IDENTITY;
      const beforeRefusals = readFileSync(ledgerPath);
      const missing = await append("missing-identity");
      expect(missing.status).toBe(2);
      expect(JSON.parse(missing.stdout)).toMatchObject({ status: "usage", code: "command.invalid-input" });

      process.env.MSTAR_HOST_SESSION_ID = coordinator;
      const malformedExplicit = await append("malformed-explicit", ["--session-id", ""]);
      expect(malformedExplicit.status).toBe(2);
      expect(JSON.parse(malformedExplicit.stdout)).toMatchObject({ status: "usage", code: "command.invalid-input" });
      expect(readFileSync(ledgerPath)).toEqual(beforeRefusals);
    } finally {
      if (priorHost === undefined) delete process.env.MSTAR_HOST_SESSION_ID;
      else process.env.MSTAR_HOST_SESSION_ID = priorHost;
      if (priorMinted === undefined) delete process.env.MSTAR_EXECUTION_IDENTITY;
      else process.env.MSTAR_EXECUTION_IDENTITY = priorMinted;
      rmSync(root, { recursive: true, force: true });
    }
  });


  test("issue show positional parse errors retain their structured attribution", () => {
    const error = new CommanderError(2, "commander.excessArguments", "too many arguments for 'show'. Expected 0 arguments but got 1");
    const envelope = mapParserError(error, ["node", "mstar", "issue", "show", "BADPOS"]);
    const details = envelope?.details;
    // The offending positional is attributed by argv position and token — the
    // facts a three-call recovery needs — alongside the command's own usage.
    expect(details).toMatchObject({
      diagnostics: [{
        path: "argv[4]",
        argvIndex: 4,
        token: "BADPOS",
        code: "commander.excessArguments",
        message: error.message,
        usage: "Usage: mstar issue show --id <id> --project <id> --disposition <disposition> --kind <kind> --severity <severity> --query <text> --limit <n> --offset <n> --harness <path> --file <path> --operation-id <id> --actor <role> --expect <n> --payload <json>",
        helpRoute: "mstar issue show --help",
      }],
    });
  });

  test("excess-argument attribution skips consumed option values and declared positionals", () => {
    const usageError = (args: string[]) => {
      const error = new CommanderError(2, "commander.excessArguments", "too many arguments");
      return mapParserError(error, ["node", "mstar", ...args])?.details?.diagnostics;
    };
    // A consumed option value is not the excess token; the trailing unknown one is.
    expect(usageError(["issue", "show", "--id", "I-1", "BADPOS"])).toMatchObject([
      { path: "argv[6]", argvIndex: 6, token: "BADPOS" },
    ]);
    // A declared positional is explained by the syntax; only the extra one is.
    expect(usageError(["schema", "family", "extra"])).toMatchObject([
      { path: "argv[4]", argvIndex: 4, token: "extra" },
    ]);
    // Two declared positionals are consumed before the excess is attributed.
    expect(usageError(["sdd", "workspace", "plan-a", "/root", "extra"])).toMatchObject([
      { path: "argv[6]", argvIndex: 6, token: "extra" },
    ]);
  });
  test("excess attribution skips every variadic option value before later options", () => {
    const error = new CommanderError(2, "commander.excessArguments", "too many arguments");
    const envelope = mapParserError(error, [
      "node", "mstar", "worktree", "cleanup", "--worktree", "/a", "/b", "--apply", "BADPOS",
    ]);
    expect(envelope?.details?.diagnostics).toMatchObject([
      { path: "argv[8]", argvIndex: 8, token: "BADPOS" },
    ]);
  });
  test("excess attribution consumes a flag-looking first variadic value", () => {
    const error = new CommanderError(2, "commander.excessArguments", "too many arguments");
    const envelope = mapParserError(error, [
      "node", "mstar", "worktree", "cleanup", "--worktree", "-relative", "--apply", "BADPOS",
    ]);
    expect(envelope?.details?.diagnostics).toMatchObject([
      { path: "argv[7]", argvIndex: 7, token: "BADPOS" },
    ]);
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
    const paths = (body.details?.diagnostics ?? []).map((entry) => entry.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((entry) => entry.startsWith("payload."))).toBe(true);
  });

  test("a CLI payload failure and an independent missing requirement are reported together", async () => {
    // The same request over MCP already groups these; the public CLI must not
    // suppress the independently missing `actor`, and nested payload errors
    // must carry expected/received facts — not just a field list.
    const { root, harness, invocation } = await cliHarness();
    try {
      const result = await run(["issue", "add", "--payload", "{}", "--harness", harness], undefined, false, invocation);
      expect(result.status).toBe(2);
      const body = JSON.parse(result.stdout) as {
        status?: string;
        details?: { diagnostics?: Array<{ path: string; code: string; expected?: string; received?: string }> };
      };
      expect(body.status).toBe("usage");
      const diagnostics = body.details?.diagnostics ?? [];
      expect(diagnostics).toContainEqual(expect.objectContaining({
        path: "actor", code: "required", expected: "present", received: "undefined",
      }));
      expect(diagnostics).toContainEqual(expect.objectContaining({
        path: "payload.kind",
        code: "invalid_value",
        expected: "bug | risk | improvement | request | decision | review-obligation",
        received: "undefined",
      }));
      expect(diagnostics.some((entry) => entry.path?.startsWith("payload."))).toBe(true);
      const malformed = await run(["issue", "add", "--payload", "{", "--harness", harness], undefined, false, invocation);
      expect(malformed.status).toBe(2);
      const malformedBody = JSON.parse(malformed.stdout) as {
        status?: string;
        details?: { diagnostics?: Array<{ path: string; code: string }> };
      };
      expect(malformedBody.status).toBe("usage");
      expect(malformedBody.details?.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "payload", code: "invalid_json" }),
        expect.objectContaining({ path: "actor", code: "required" }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a nested issue payload enum violation carries per-field code/expected/received", async () => {
    const { root, harness, invocation } = await cliHarness();
    try {
      const payload = {
        projectId: "p", title: "t", kind: "not-a-kind", severity: "high", impact: "i", acceptance: "a",
        sourceIdentity: "s", rootCauseKey: "r", acceptanceKey: "a", occurrenceKey: "o", sourceKind: "qc",
        location: "l", observedBehavior: "o", evidence: ["e"], discoveredAt: "2026-09-26T10:00:00Z",
      };
      const result = await run(["issue", "add", "--payload", JSON.stringify(payload), "--actor", "project-manager", "--harness", harness], undefined, false, invocation);
      expect(result.status).toBe(2);
      const body = JSON.parse(result.stdout) as {
        details?: { diagnostics?: Array<{ path: string; code: string; expected?: string; received?: string }> };
      };
      expect(body.details?.diagnostics).toContainEqual(expect.objectContaining({
        path: "payload.kind",
        code: "invalid_value",
        expected: "bug | risk | improvement | request | decision | review-obligation",
        received: "not-a-kind",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a semantic capture failure keeps its typed engine causes on the CLI response", async () => {
    const { root, harness, invocation } = await cliHarness();
    try {
      const payload = {
        projectId: "p", title: "t", kind: "bug", severity: "high", impact: "i", acceptance: "a",
        sourceIdentity: "unknown", rootCauseKey: "unknown", acceptanceKey: "?", occurrenceKey: "o", sourceKind: "qc",
        location: "l", observedBehavior: "o", evidence: ["e"], discoveredAt: "2026-09-26T10:00:00Z",
      };
      const result = await run(["issue", "add", "--payload", JSON.stringify(payload), "--actor", "project-manager", "--harness", harness], undefined, false, invocation);
      expect(result.status).toBe(1);
      const body = JSON.parse(result.stdout) as {
        code?: string;
        details?: { causes?: Array<{ code: string; message: string }> };
      };
      expect(body.code).toBe("issue.ambiguous-identity");
      // The aggregated rejection is not collapsed to joined prose: the
      // structured cause (and its per-key sub-causes) survives the CLI mapping
      // instead of being replaced by a diagnostic-paths table.
      const causes = body.details?.causes ?? [];
      expect(causes.length).toBeGreaterThanOrEqual(1);
      expect(causes.every((cause) => cause.code === "issue.ambiguous-identity")).toBe(true);
      const nested = (causes[0] as { causes?: Array<{ code: string }> } | undefined)?.causes ?? [];
      expect(nested.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(recoveredEnvelope.code).not.toBe("command.invalid-input");

    const priorIdentity = process.env.MSTAR_HOST_SESSION_ID;
    const priorMinted = process.env.MSTAR_EXECUTION_IDENTITY;
    delete process.env.MSTAR_HOST_SESSION_ID;
    delete process.env.MSTAR_EXECUTION_IDENTITY;
    try {
      const withoutRuntimeIdentity = await run(args);
      const usageEnvelope = JSON.parse(withoutRuntimeIdentity.stdout);
      expect(usageEnvelope).toMatchObject({ status: "usage" });
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
    for (const id of ["issue.close", "issue.reopen"]) {
      const definition = getCommandDefinitions().find((candidate) => candidate.id === id);
      if (definition === undefined) throw new Error(`${id} definition missing`);
      const help = renderCommandContract(definition, "cli");
      expect(help).toContain("reason (required) (string)");
      if (id === "issue.close") {
        expect(help).toContain("references (requiredWhen: close) (string[])");
        expect(help).toContain("alignmentRef (requiredWhen: close or waive) (string)");
      }
    }
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
test("workflow registration discloses missing plan identity and succeeds after the document correction", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cli-workflow-registration-correction-"));
  const harness = path.join(root, ".mstar");
  const planFile = path.join(harness, "plans", "plan-public-registration.md");
  mkdirSync(path.dirname(planFile), { recursive: true });
  writeFileSync(planFile, "# Public registration plan\n");
  (await initializeStore({ harnessDir: harness })).close();
  // A registered CLI invocation opens the store query-only. On Bun 1.4.0 the
  // just-closed writer's deferred cleanup can still remove the WAL sidecars
  // WHILE that read-only open runs, so its first open intermittently refuses
  // `store.corrupt` (`SQLITE_CANTOPEN`). One read in this process settles the
  // file into its readable shape before the adapter runs, exactly as the
  // sibling fixture helper `sealStoreForReaders` does.
  (await openStore({ harnessDir: harness }, "read")).close();
  const args = [
    "workflow", "register",
    "--workflow", "wf-public-registration",
    "--plan-id", "plan-public-registration",
    "--plan-title", "Public registration plan",
    "--plan-file", "plans/plan-public-registration.md",
    "--delivery-kind", "development",
    "--project", "engine",
    "--branch-source", "feature/plan-public-registration",
    "--branch-target", "main",
    "--harness", harness,
  ];
  try {
    const missing = await run(args);
    expect(missing.status).toBe(1);
    const refusal = JSON.parse(missing.stdout) as { command: string; status: string; code: string; message?: string };
    expect(refusal).toMatchObject({ command: "workflow.register", status: "refused", code: "plan-path.identity-mismatch" });
    expect(refusal.message).toContain("declares no plan_id header");
    expect(refusal.message).toContain("Help: mstar workflow register --help");

    writeFileSync(planFile, "# Public registration plan\n\n**plan_id:** plan-public-registration\n");
    const corrected = await run(args);
    expect(corrected.status).toBe(0);
    expect(JSON.parse(corrected.stdout)).toMatchObject({
      command: "workflow.register", status: "ok", code: "workflow.register.ok",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  });

  test("CLI refuses an unknown command id with grouped selectors", async () => {
    const result = await run(["schema", "--command", "no-such-command"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ command: "schema", status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(envelope.details?.selectors).toEqual(["command"]);
    expect(envelope.details?.helpRoute).toBe("mstar schema --help");
  });

  test("CLI refuses colliding positional and option selectors", async () => {
    const result = await run(["schema", "CaptureInput", "--command", "worktree.check"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("usage");
    expect(envelope.exitCode).toBe(2);
    expect(envelope.details?.helpRoute).toBe("mstar schema --help");
    expect(envelope.details?.diagnostics.length).toBeGreaterThan(0);
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
    for (const diagnostic of envelope.details?.diagnostics ?? []) {
      expect(diagnostic.path).toBe("workflow");
    }
  });

  test("worktree cleanup refuses a JSON-object --worktree occurrence via the declared schema", async () => {
    const result = await run(["worktree", "cleanup", "--worktree", '{"a":1}']);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ command: "worktree.cleanup", status: "usage", code: "command.invalid-input", exitCode: 2 });
    const diagnostics = envelope.details?.diagnostics as Array<{ path: string; received?: string }>;
    // The payload's own member failure is reported with the missing workflow
    // requirement; the object value is the rejected received fact.
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: "worktree[0]", received: "object" }));
    expect(diagnostics.some((entry) => entry.path === "workflow")).toBe(true);
  });

  test("worktree cleanup refuses a malformed JSON-looking --worktree occurrence", async () => {
    const result = await run(["worktree", "cleanup", "--worktree", "{not json"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ command: "worktree.cleanup", status: "usage", code: "command.invalid-input", exitCode: 2 });
    const diagnostics = envelope.details?.diagnostics as Array<{ path: string; code: string; index?: number }>;
    // The malformed entry stays one literal occurrence the declared schema
    // rejects as a typed element; the missing workflow requirement groups
    // alongside it rather than being suppressed.
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: "worktree[0]", code: "invalid_type", index: 0 }));
    expect(diagnostics.some((entry) => entry.path === "workflow")).toBe(true);
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

  const boolean = await run(["plan", "bind", "--execution"]);
  const booleanResult = JSON.parse(boolean.stdout);
  expect(booleanResult.command).toBe("plan.bind");
  expect(booleanResult.details?.diagnostics ?? []).not.toContainEqual(expect.objectContaining({ path: "execution" }));
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
