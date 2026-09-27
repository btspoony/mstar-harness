import assert from "node:assert/strict";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { mcpToolName } from "../src/register.js";

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const nodePath = process.env.PATH?.split(path.delimiter)
  .map((directory) => path.join(directory, "node"))
  .find(executable);
assert.ok(nodePath, "Node runtime is required to smoke built Node surfaces");

const root = mkdtempSync(path.join(os.tmpdir(), "mcp-report-smoke-"));
const env = Object.fromEntries(Object.entries(process.env).filter(
  (entry): entry is [string, string] => entry[1] !== undefined
    && entry[0] !== "MSTAR_HARNESS_DIR"
    && entry[0] !== "MSTAR_STORE_MODULE",
));
const cliPath = path.resolve(import.meta.dir, "../../cli/dist/mstar-harness.js");
const serverPath = path.resolve(import.meta.dir, "../dist/stdio.js");
const input = {
  title: "synthetic report",
  command: "mstar status",
  arguments: JSON.stringify(["--workflow", "wf-synthetic"]),
  expected: "workflow is listed",
  actual: "workflow is missing",
  reproduction: "run mstar status --workflow wf-synthetic",
  stableCode: "workflow.not-found",
  exitStatus: 1,
  host: "synthetic-host",
  platform: "synthetic-platform",
  versionOverrides: { cli: "caller-cli", engine: "caller-engine", plugin: "caller-plugin" },
};
const cli = spawnSync(nodePath, [
  cliPath,
  "report",
  "--title", input.title,
  "--command", input.command,
  "--arguments", input.arguments,
  "--expected", input.expected,
  "--actual", input.actual,
  "--reproduction", input.reproduction,
  "--stable-code", input.stableCode,
  "--exit-status", String(input.exitStatus),
  "--host", input.host,
  "--platform", input.platform,
  "--version-overrides", JSON.stringify(input.versionOverrides),
], { cwd: root, env, encoding: "utf8" });
assert.equal(cli.status, 0, `built CLI failed (${cli.status}): ${cli.stderr}`);
const reportDataSchema = z.object({
  issueUrl: z.string(),
  prompt: z.string(),
  redactions: z.array(z.object({ field: z.string(), count: z.number() })),
});
const cliEnvelope = z.object({ status: z.literal("ok"), data: reportDataSchema }).parse(JSON.parse(cli.stdout));

const client = new Client({ name: "mstar-report-built-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({ command: nodePath, args: [serverPath], cwd: root, env, stderr: "inherit" });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const tool = listed.tools.find(({ name }) => name === mcpToolName("report"));
  assert.ok(tool, "built stdio server must register the report command");
  assert.equal(Object.hasOwn(tool, "effects"), false, "report descriptor must not expose a command-effects capability");
  assert.equal(Object.hasOwn(tool, "annotations") && Object.hasOwn(tool.annotations ?? {}, "effects"), false);
  const response = await client.callTool({ name: mcpToolName("report"), arguments: input });
  assert.equal(response.isError, false);
  const mcpReport = z.object({ status: z.literal("ok"), data: reportDataSchema }).parse(response.structuredContent);
  assert.equal(cliEnvelope.data.issueUrl, mcpReport.data.issueUrl);
  assert.deepEqual(cliEnvelope.data.redactions, mcpReport.data.redactions);
  const cliLines = cliEnvelope.data.prompt.split("\n");
  const mcpLines = mcpReport.data.prompt.split("\n");
  assert.ok(cliLines.includes('- CLI (observed): "3.11.2"'));
  assert.ok(cliLines.includes('- Engine (observed): "3.11.2"'));
  assert.ok(mcpLines.includes('- CLI (unknown): "unknown"'));
  assert.ok(mcpLines.includes('- Engine (unknown): "unknown"'));
  assert.ok(mcpLines.includes('- Plugin (unknown): "unknown"'));
  assert.deepEqual(
    cliLines.filter((line) => !line.startsWith("- CLI (") && !line.startsWith("- Engine (")),
    mcpLines.filter((line) => !line.startsWith("- CLI (") && !line.startsWith("- Engine (")),
    "caller-supplied report fields and canonical rendering must match; only observed CLI/engine facts differ by source",
  );
  assert.match(mcpReport.data.prompt, /Review this draft before submission\./);
  console.log("Built CLI and stdio MCP report smoke passed: caller-data parity, spec-correct source versions, and no MCP report effects capability.");
} finally {
  await client.close().catch(() => undefined);
  await rmSync(root, { recursive: true, force: true });
}
