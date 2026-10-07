import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeExecutionAuthority, initializeStore, openStore } from "@mstar-harness/engine";
import { executeCommand, getCommandDefinitions } from "../definitions.js";
import type { InvocationContext } from "../types.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function fixture(): Promise<{ root: string; harness: string }> {
  const root = mkdtempSync(join(tmpdir(), "mstar-adopt-terminal-command-"));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  const initial = await initializeStore({ harnessDir: harness });
  initial.close();
  await initializeExecutionAuthority({ harnessDir: harness });
  const writer = await openStore({ harnessDir: harness }, "write");
  try {
    writer.db.prepare(
      "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) values (?, 1, null, ?, ?, ?)",
    ).run("wf-command", JSON.stringify({
      id: "wf-command", schema_version: 1, type: "plan", status: "completed",
      started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z",
      updated_at: "2026-10-01T01:00:00.000Z",
    }), "2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z");
  } finally { writer.close(); }
  return { root, harness };
}

function invocation(cwd: string): InvocationContext {
  return {
    cwd, controlRoot: null, sessionId: "caller-session",
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("not available in this test"); },
      async openBrowser() { throw new Error("not available in this test"); },
    },
  };
}

test("workflow adopt-terminal publishes revision source, replays, and reports adopted terminal state", async () => {
  const { root, harness } = await fixture();
  const input = { workflow: "wf-command", harness, expect: "1", operation: "command-adopt-1", reason: "close imported terminal header" };
  const first = await executeCommand("workflow.adopt-terminal", input, invocation(root));
  expect(first).toMatchObject({ status: "ok" });
  const replay = await executeCommand("workflow.adopt-terminal", input, invocation(root));
  expect(replay.status).toBe("ok");
  if (replay.status === "ok") expect((replay.data as { replayed: boolean }).replayed).toBe(true);

  const status = await executeCommand("status.validate", {}, invocation(root));
  expect(status.status).toBe("ok");
  if (status.status === "ok") {
    expect((status.data as { terminalUnregistered: Array<{ id: string; revision: number; adoption: unknown }> }).terminalUnregistered)
      .toMatchObject([{ id: "wf-command", revision: 2, adoption: { reason: input.reason } }]);
  }
  const definition = getCommandDefinitions().find((entry) => entry.id === "workflow.adopt-terminal");
  expect(definition).toBeDefined();
  expect(definition!.cli.options.find((option) => option.key === "expect")?.help)
    .toBe("Header revision CAS (positive integer) acquired from the terminalUnregistered[].revision entry in `mstar status validate`, not an execution token.");
  const schema = await executeCommand("schema", { command: "workflow.adopt-terminal" }, invocation(root));
  expect(schema.status).toBe("ok");
  if (schema.status === "ok") {
    const descriptor = (schema.data as { descriptor: { requirements: Array<{ name: string; tokenKind?: string }> } }).descriptor;
    expect(descriptor.requirements.find((requirement) => requirement.name === "expect")?.tokenKind).toBe("revision");
  }
});

test("workflow adopt-terminal refusal keeps exact engine message first and names the recovery", async () => {
  const { root, harness } = await fixture();
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "2", operation: "command-adopt-stale", reason: "stale header",
  }, invocation(root));
  expect(refused).toMatchObject({ status: "refused", code: "execution.header-revision-conflict", exitCode: 1 });
  if (refused.status === "refused") {
    expect(refused.message).toBe(
      "[execution.header-revision-conflict] workflow wf-command header revision is 1, not expected revision 2; re-read status validate and retry with its listed revision\n" +
      "Help: mstar workflow adopt-terminal --help\n" +
      "Recovery: Run `mstar status validate`, then retry `mstar workflow adopt-terminal --workflow <id> --expect <listed-revision>`."
    );
    expect(refused.details).toMatchObject({ helpRoute: "mstar workflow adopt-terminal --help", recovery: "Run `mstar status validate`, then retry `mstar workflow adopt-terminal --workflow <id> --expect <listed-revision>`." });
  }
});
