/**
 * The MCP route inherits the CALLING session's workspace and harness (PR #558
 * review, finding A). The stdio server is a child process, so a host process
 * running in repo A that serves a session in repo B cannot let the server
 * probe `process.cwd()` — the launcher passes both facts on the launch
 * (`--harness` + `--workspace`). These regressions drive the PRODUCTION
 * composition (`createMcpServer` + `createContextResolver`) with the real
 * folded tool surface, while the host process cwd is repo A:
 *
 * An MCP server is the calling session's own transport for commands: the
 * retired `--harness`/`MSTAR_HARNESS_DIR` launch pins once let the connection
 * carry that session's workspace and harness. Those rungs are gone — an MCP
 * connection resolves its root only from the selector each call publishes,
 * and the command must accept the root the selector names.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { initializeStore, registerCatalogEntity } from "@mstar-harness/engine";
import type { CommandEnvelope } from "@mstar-harness/commands";
import { createMcpServer } from "../src/mcp/server";
import { createContextResolver, type McpStdioOptions } from "../src/mcp/stdio";
import { KNOWLEDGE_GOOD } from "./support/cli-content-fixtures";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** An Assignment whose `execution_mode` front matter field drives the QC seat count. */
const ASSIGNMENT_SDD = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
execution_mode: sdd
working_branch: feature/foo
---

## Assignment
`;

/** One QC Assignment carrying the three byte-identical alignment front matter keys. */
function qcAssignment(planId: string, range: string): string {
  return `---
execute_as: qc-specialist
task_category: logic
plan_id: ${planId}
review_range: "${range}"
diff_basis: "${range}"
---
`;
}

/** A STRATEGY.md that passes `lint` with no violations. */
const STRATEGY_GOOD = ["# Strategy", "", "## Vision", "## What we build", "## What we don't build", "## Guiding Principles", "## Technology Direction", "## Decision Log", ""].join("\n");

async function workspaceRoot(prefix: string): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(path.join(root, ".mstar"), { recursive: true });
  // Canonical path: the engine realpaths its roots, and macOS tmpdirs are symlinked.
  return realpathSync(root);
}

/** Run one folded call against the production server assembly. */
async function callFolded(options: McpStdioOptions, tool: string, args: Record<string, unknown>): Promise<CommandEnvelope> {
  const server = createMcpServer(createContextResolver(options));
  const client = new Client({ name: "session-context-consumer", version: "1.0.0" });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverEnd);
    await client.connect(clientEnd);
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.structuredContent !== undefined) return result.structuredContent as CommandEnvelope;
    const text = (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const start = text.indexOf('{"version":1,');
    if (start < 0) throw new Error(`no command envelope in the tool result: ${text}`);
    return JSON.parse(text.slice(start)) as CommandEnvelope;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP session context", () => {
  test("sdd.workspace resolves and writes under the control root the call names, never the host cwd", async () => {
    const repoA = await workspaceRoot("mstar-session-ctx-a-");
    const repoB = await workspaceRoot("mstar-session-ctx-b-");
    const previousCwd = process.cwd();
    process.chdir(repoA);
    try {
      const envelope = await callFolded(
        { workspace: repoB },
        "mstar_sdd",
        { action: "workspace", planId: "plan-b", controlRoot: path.join(repoB, ".mstar") },
      );

      expect(envelope).toMatchObject({ command: "sdd.workspace", status: "ok", exitCode: 0 });
      const sddDir = (envelope.data as { sddDir: string }).sddDir;
      expect(sddDir).toBe(path.join(repoB, ".mstar", "sdd", "plan-b"));
      expect(existsSync(sddDir)).toBe(true);
      // The host's own workspace got no SDD tree from the call.
      expect(existsSync(path.join(repoA, ".mstar", "sdd"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test("a relative path argument resolves under the declared workspace", async () => {
    const repoA = await workspaceRoot("mstar-session-ctx-a-");
    const repoB = await workspaceRoot("mstar-session-ctx-b-");
    // Every file lives in B, the DECLARED workspace; A (the host process's own
    // checkout) holds none of them. A relative path read from the launch
    // directory would therefore fail to find its subject, and one resolved
    // against A's project root would read A's tree instead.
    writeFileSync(path.join(repoB, "assignment.md"), ASSIGNMENT_SDD, "utf8");
    writeFileSync(path.join(repoB, "qc1.md"), qcAssignment("plan-b", "merge-base: main + tip: HEAD"), "utf8");
    writeFileSync(path.join(repoB, "qc2.md"), qcAssignment("plan-b", "merge-base: main + tip: HEAD"), "utf8");
    writeFileSync(path.join(repoB, "STRATEGY.md"), STRATEGY_GOOD, "utf8");
    const previousCwd = process.cwd();
    process.chdir(repoA);
    try {
      // The seat count is read FROM the assignment: 3 is B's `sdd` mode.
      const seats = await callFolded({ workspace: repoB }, "mstar_review", { action: "seats", assignmentFile: "assignment.md" });
      expect(seats).toMatchObject({ command: "review.seats", status: "ok", code: "review.seats.ok" });
      expect((seats.data as { n: number }).n).toBe(3);

      // Both alignment subjects are B's files, byte-identical there.
      const alignment = await callFolded({ workspace: repoB }, "mstar_worktree", { action: "qc-alignment", files: ["qc1.md", "qc2.md"] });
      expect(alignment).toMatchObject({ command: "worktree.qc-alignment", status: "ok", code: "worktree.qc-alignment.ok" });
      expect((alignment.data as { assignments: unknown[] }).assignments).toHaveLength(2);

      // The same rule covers the rest of the validation family: `lint` resolves
      // its relative target from the workspace, not from this process's root.
      const linted = await callFolded({ workspace: repoB }, "mstar_lint", { action: "lint", target: "STRATEGY.md" });
      expect(linted).toMatchObject({ command: "lint", status: "ok", code: "lint.ok" });
      expect((linted.data as { results: Array<{ file: string }> }).results[0]?.file).toBe(path.join(repoB, "STRATEGY.md"));

      // Nothing was read from, or written to, the host checkout.
      expect(existsSync(path.join(repoA, "assignment.md"))).toBe(false);
      expect(existsSync(path.join(repoA, "STRATEGY.md"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
