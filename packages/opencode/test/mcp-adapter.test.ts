import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createExecutionWorkflow, executionContextFor, initializeExecutionAuthority, initializeStore } from "@mstar-harness/engine";
import { getCommandDefinitions } from "@mstar-harness/commands";
import { mcpToolName } from "@mstar-harness/mcp";
import { closeOpenCodeMcpSession, type OpenCodeMcpServices } from "../src/mcp.js";
import { MorningStarHarnessPlugin } from "../src/mstar.js";

function commandResult(output: string): { status: string; code: string } {
  const parsed: unknown = JSON.parse(output);
  if (parsed === null || typeof parsed !== "object" || !("status" in parsed) || !("code" in parsed)) {
    throw new Error("invalid shared command result");
  }
  if (typeof parsed.status !== "string" || typeof parsed.code !== "string") throw new Error("invalid shared command status");
  return { status: parsed.status, code: parsed.code };
}

test("OpenCode MCP exposes canonical commands and admits only the native main session in-process", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-mcp-adapter-"));
  const sentinel = path.join(root, "global-cli-was-spawned");
  const oldExecutionCli = process.env.MSTAR_EXECUTION_CLI;
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
    const harness = path.join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    const globalCli = path.join(root, "global-mstar");
    writeFileSync(globalCli, `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`);
    chmodSync(globalCli, 0o755);
    process.env.MSTAR_EXECUTION_CLI = globalCli;

    const storeContext = { harnessDir: root };
    (await initializeStore(storeContext)).close();
    const initialized = await initializeExecutionAuthority(storeContext);
    const workflow = "wf-opencode-mcp";
    const created = await createExecutionWorkflow(executionContextFor(storeContext, {
      source: "local",
      sessionId: "main-session",
      workflowId: workflow,
      role: "coordinator",
      planId: null,
    }), {
      entry: { id: workflow, type: "iteration", status: "running", started_at: "2026-09-26T00:00:00Z", dir: `workflows/${workflow}` } as never,
      snapshot: {
        schema_version: 1,
        id: workflow,
        type: "iteration",
        status: "running",
        started_at: "2026-09-26T00:00:00Z",
        updated_at: "2026-09-26T00:00:00Z",
        branch: { base: "main" },
        plans: [],
      } as never,
      expected: initialized.token,
      operationId: "create-fixture",
    });
    const workflowToken = (created.data as { workflows: Array<{ workflowToken: string }> }).workflows[0]!.workflowToken;

    const plugin = await MorningStarHarnessPlugin();
    const tools = plugin.tool as Record<string, { args: Record<string, unknown>; execute(params: unknown, context: unknown): Promise<string> }>;
    const definitions = getCommandDefinitions();
    assert.equal(Object.keys(tools).length, definitions.length);
    for (const definition of definitions) {
      const registered = tools[mcpToolName(definition.id)];
      assert.ok(registered, definition.id);
      const input = definition.input;
      if (!("shape" in input) || input.shape === null || typeof input.shape !== "object") {
        throw new Error(`OpenCode command input must be an object schema: ${definition.id}`);
      }
      const expectedArgs = Object.keys(input.shape);
      if (definition.id === "judgment.review-advice") expectedArgs.push("input");
      assert.deepEqual(Object.keys(registered.args).sort(), expectedArgs.sort(), definition.id);
    }
    for (const name of ["mstar_status_validate", "mstar_worktree_check", "mstar_dispatch_validate", "mstar_lease_verify", "mstar_iteration_gate", "mstar_path_resolve"]) {
      assert.ok(tools[name], `canonical replacement missing ${name}`);
    }

    const bind = tools.mstar_plan_bind!;
    const invoke = async (sessionID: string, operation: string) => commandResult(await bind.execute({
      execution: true,
      coordinator: true,
      workflow,
      harness,
      expect: workflowToken,
      operation,
    }, {
      directory: root,
      worktree: root,
      sessionID,
      abort: new AbortController().signal,
    }));

    assert.deepEqual(await invoke("child-session", "bind-child-session"), {
      status: "refused",
      code: "execution.session-unavailable",
    });
    assert.deepEqual(await invoke("main-session", "bind-main-session"), {
      status: "ok",
      code: "plan.bind.ok",
    });
    assert.equal(existsSync(sentinel), false, "the legacy global CLI override must not be invoked");
  } finally {
    if (oldExecutionCli === undefined) delete process.env.MSTAR_EXECUTION_CLI;
    else process.env.MSTAR_EXECUTION_CLI = oldExecutionCli;
    rmSync(root, { recursive: true, force: true });
  }
});
test("OpenCode MCP dashboard handles close only when their host session ends", async () => {
  const closed: string[] = [];
  const services: OpenCodeMcpServices = new Map([
    ["session-a", [{ async close() { closed.push("a"); } }]],
    ["session-b", [{ async close() { closed.push("b"); } }]],
  ]);
  await closeOpenCodeMcpSession(services, "session-a");
  assert.deepEqual(closed, ["a"]);
  assert.equal(services.has("session-a"), false);
  assert.equal(services.has("session-b"), true);
});
