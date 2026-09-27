import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zod } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  createExecutionWorkflow,
  executionContextFor,
  initializeExecutionAuthority,
  initializeStore,
} from "@mstar-harness/engine";
import { getCommandDefinitions } from "@mstar-harness/commands";
import { mcpToolName } from "@mstar-harness/mcp";
import mcpAdapter from "../src/extensions/mcp";

function commandResult(output: unknown): { status: string; code: string } {
  if (output === null || typeof output !== "object" || !("details" in output)) throw new Error("missing native tool details");
  const details = output.details;
  if (details === null || typeof details !== "object" || !("mstarCommand" in details)) throw new Error("missing shared command result");
  const result = details.mstarCommand;
  if (result === null || typeof result !== "object" || !("status" in result) || !("code" in result)) throw new Error("invalid shared command result");
  if (typeof result.status !== "string" || typeof result.code !== "string") throw new Error("invalid shared command status");
  return { status: result.status, code: result.code };
}

test("OMP registers canonical commands and preserves shared main-session admission", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-mcp-adapter-"));
  try {
    const git = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    const commit = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root, encoding: "utf8" });
    assert.equal(commit.status, 0, commit.stderr);
    const harness = path.join(root, ".mstar");
    mkdirSync(harness, { recursive: true });

    const storeContext = { harnessDir: root };
    (await initializeStore(storeContext)).close();
    const initialized = await initializeExecutionAuthority(storeContext);
    const workflow = "wf-omp-mcp";
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
        plans: [{ id: "plan-omp-mcp", plan_id: "plan-omp-mcp", title: "OMP MCP fixture", file: `.mstar/plans/plan-omp-mcp.md`, status: "Todo", metadata: { project_id: "_default" } }],
      } as never,
      expected: initialized.token,
      operationId: "create-fixture",
    });
    const workflowToken = zod.object({ workflows: zod.array(zod.object({ workflowToken: zod.string() })) }).parse(created.data).workflows[0]!.workflowToken;

    const registrations = new Map<string, { parameters: unknown; execute: (...args: unknown[]) => Promise<unknown> }>();
    const pi = {
      zod,
      registerTool(tool: { name: string; parameters: unknown; execute: (...args: unknown[]) => Promise<unknown> }) {
        registrations.set(tool.name, tool);
      },
      on() {},
    } as unknown as ExtensionAPI;
    mcpAdapter(pi);

    const definitions = getCommandDefinitions();
    assert.equal(registrations.size, definitions.length);
    for (const definition of definitions) assert.ok(registrations.has(mcpToolName(definition.id)), definition.id);
    for (const name of ["mstar_status_validate", "mstar_worktree_check", "mstar_dispatch_validate", "mstar_lease_verify", "mstar_iteration_gate", "mstar_path_resolve"]) {
      assert.ok(registrations.has(name), `canonical replacement missing ${name}`);
    }

    const tool = registrations.get("mstar_plan_bind")!;
    const invoke = async (sessionId: string, operation: string) => {
      const ctx = {
        cwd: root,
        sessionManager: { getSessionId: () => sessionId },
      } as unknown as ExtensionContext;
      return commandResult(await tool.execute("call", {
        execution: true,
        coordinator: true,
        workflow,
        harness,
        expect: workflowToken,
        operation,
      }, new AbortController().signal, undefined, ctx));
    };

    const wrongSession = await invoke("child-session", "bind-child-session");
    assert.equal(wrongSession.status, "refused");
    assert.equal(wrongSession.code, "execution.session-unavailable");

    const mainSession = await invoke("main-session", "bind-main-session");
    assert.equal(mainSession.status, "ok");

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
