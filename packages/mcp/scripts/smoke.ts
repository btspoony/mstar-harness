import assert from "node:assert/strict";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { getCommandDefinitions } from "@mstar-harness/commands";
import {
  createExecutionWorkflow,
  executionContextFor,
  initializeExecutionAuthority,
  initializeStore,
} from "@mstar-harness/engine";
import { z } from "zod";
import { mcpToolName } from "../src/register.js";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "mcp-built-smoke-"));
const harnessDir = path.join(tempRoot, ".mstar");
process.env.MSTAR_HARNESS_DIR = harnessDir;
delete process.env.MSTAR_STORE_MODULE;
const workflowId = "wf-smoke";
const planId = "plan-smoke";
function requireExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const runtimePath = process.env.PATH?.split(path.delimiter).filter((directory) =>
  !["mstar", "mstar-harness"].some((name) => requireExecutable(path.join(directory, name))),
).join(path.delimiter) ?? "";
const childEnv = Object.fromEntries(Object.entries(process.env).filter(
  (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "MSTAR_HARNESS_DIR" && entry[0] !== "MSTAR_STORE_MODULE",
));
childEnv.PATH = runtimePath;
const nodePath = process.env.PATH?.split(path.delimiter)
  .map((directory) => path.join(directory, "node"))
  .find(requireExecutable);
assert.ok(nodePath, "Node runtime is required to smoke the Node bundle");
const serverPath = path.resolve(import.meta.dir, "../dist/stdio.js");

const client = new Client({ name: "mstar-mcp-built-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: nodePath,
  args: [serverPath],
  cwd: tempRoot,
  env: childEnv,
  stderr: "inherit",
});

const envelopeSchema = z.object({
  status: z.string(),
  code: z.string(),
  data: z.unknown().optional(),
}).passthrough();

function envelope(result: { structuredContent?: unknown }): z.infer<typeof envelopeSchema> {
  return envelopeSchema.parse(result.structuredContent);
}

try {
  assert.ok(!runtimePath.split(path.delimiter).some((directory) =>
    ["mstar", "mstar-harness"].some((name) => requireExecutable(path.join(directory, name))),
  ), "runtime PATH must not expose the mstar CLI");
  mkdirSync(harnessDir, { recursive: true });
  const statusPath = path.join(tempRoot, "status-fixture.json");
  writeFileSync(statusPath, JSON.stringify({ version: 2, updated_at: "1970-01-01", workflows: [] }));

  const storeContext = { harnessDir: tempRoot };
  (await initializeStore(storeContext)).close();
  const initialized = await initializeExecutionAuthority(storeContext);
  const created = await createExecutionWorkflow(executionContextFor(storeContext, {
    source: "local",
    sessionId: "main-session",
    workflowId,
    role: "coordinator",
    planId: null,
  }), {
    entry: { id: workflowId, type: "iteration", status: "running", started_at: "2026-09-27T00:00:00Z", dir: `workflows/${workflowId}` } as never,
    snapshot: {
      schema_version: 1,
      id: workflowId,
      type: "iteration",
      status: "running",
      started_at: "2026-09-27T00:00:00Z",
      updated_at: "2026-09-27T00:00:00Z",
      branch: { base: "main" },
      plans: [{ id: planId, plan_id: planId, title: "MCP smoke fixture", file: `.mstar/plans/${planId}.md`, status: "Todo", metadata: { project_id: "_default" } }],
    } as never,
    expected: initialized.token,
    operationId: "create-smoke-fixture",
  });
  const workflowToken = z.object({
    workflows: z.array(z.object({ workflowToken: z.string() })).min(1),
  }).parse(created.data).workflows[0]!.workflowToken;

  await client.connect(transport);
  const listed = await client.listTools();
  const expected = getCommandDefinitions()
    .filter((definition) => definition.id !== "init")
    .map((definition) => mcpToolName(definition.id))
    .sort();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expected, "built server must expose the complete canonical non-init command set");

  const pathRead = envelope(await client.callTool({
    name: mcpToolName("status.validate"),
    arguments: { path: statusPath },
  }));
  assert.equal(pathRead.status, "ok", JSON.stringify(pathRead));
  assert.deepEqual(pathRead.data, { path: statusPath, violations: [] });

  const mutation = envelope(await client.callTool({
    name: mcpToolName("plan.bind"),
    arguments: {
      execution: true,
      coordinator: true,
      workflow: workflowId,
      harness: harnessDir,
      expect: workflowToken,
      operation: "bind-main-session",
      sessionId: "main-session",
    },
  }));
  assert.equal(mutation.status, "ok", JSON.stringify(mutation));

  const refusalResult = await client.callTool({
    name: mcpToolName("plan.bind"),
    arguments: {
      execution: true,
      coordinator: true,
      workflow: workflowId,
      harness: harnessDir,
      expect: workflowToken,
      operation: "bind-child-session",
      sessionId: "child-agent-session",
    },
  });
  const refusal = envelope(refusalResult);
  assert.equal(refusal.status, "refused", JSON.stringify(refusal));
  assert.equal(refusalResult.isError, true, "shared-handler refusal must be reported as an MCP tool error");
  assert.equal(refusal.code, "execution.stale-token");
  const bunClient = new Client({ name: "mstar-mcp-built-smoke-bun", version: "1.0.0" });
  const bunTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(import.meta.dir, "../dist/bun/stdio.js")],
    cwd: tempRoot,
    env: childEnv,
    stderr: "inherit",
  });
  await bunClient.connect(bunTransport);
  try {
    const bunTools = await bunClient.listTools();
    assert.deepEqual(bunTools.tools.map((tool) => tool.name).sort(), expected, "Bun bundle must expose the complete canonical non-init command set");
    const bunRead = envelope(await bunClient.callTool({
      name: mcpToolName("status.validate"),
      arguments: { path: statusPath },
    }));
    assert.equal(bunRead.status, "ok", JSON.stringify(bunRead));
  } finally {
    await bunClient.close();
  }

  console.log(`MCP built-server smoke passed: Node and Bun bundles, ${listed.tools.length} tools, path read, main-session mutation, ${refusal.code} refusal; runtime PATH excludes mstar.`);
} finally {
  await client.close().catch(() => undefined);
  await rmSync(tempRoot, { recursive: true, force: true });
}
