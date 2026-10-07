import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeExecutionAuthority, initializeStore, openStore, type StoreDb } from "@mstar-harness/engine";
import { executeCommand, getCommandDefinitions } from "../definitions.js";
import type { CommandEnvelope, InvocationContext } from "../types.js";

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
function expectAdoptionRefusal(result: CommandEnvelope, firstLine: string, recovery: string): void {
  if (result.status !== "refused") throw new Error(`expected refusal, received ${result.status}`);
  expect(result.message).toBe(
    `${firstLine}\nHelp: mstar workflow adopt-terminal --help\nRecovery: ${recovery}`,
  );
  expect(result.details).toMatchObject({
    helpRoute: "mstar workflow adopt-terminal --help",
    recovery,
  });
}
async function withWriter(harness: string, action: (db: StoreDb) => void): Promise<void> {
  const writer = await openStore({ harnessDir: harness }, "write");
  try { action(writer.db); }
  finally { writer.close(); }
}

test("workflow adopt-terminal publishes revision source, replays, and reports adopted terminal state", async () => {
  const { root, harness } = await fixture();
  const input = { workflow: "wf-command", harness, expect: "1", operation: "command-adopt-1", reason: "close imported terminal header" };
  const before = await executeCommand("status.validate", {}, invocation(root));
  expect(before.status).toBe("ok");
  if (before.status === "ok") {
    expect((before.data as { terminalUnregistered: unknown[]; terminalAdoptions: unknown[] }).terminalUnregistered)
      .toEqual([{ id: "wf-command", status: "completed", revision: 1 }]);
    expect((before.data as { terminalAdoptions: unknown[] }).terminalAdoptions).toEqual([]);
  }
  const first = await executeCommand("workflow.adopt-terminal", input, invocation(root));
  expect(first).toMatchObject({ status: "ok" });
  const replay = await executeCommand("workflow.adopt-terminal", input, invocation(root));
  expect(replay.status).toBe("ok");
  if (replay.status === "ok") expect((replay.data as { replayed: boolean }).replayed).toBe(true);

  const status = await executeCommand("status.validate", {}, invocation(root));
  expect(status.status).toBe("ok");
  if (status.status === "ok") {
    expect((status.data as { terminalUnregistered: unknown[]; terminalAdoptions: Array<{ id: string; revision: number; lifecycle_adopted_at: string; adopt_reason: string }> }).terminalUnregistered).toEqual([]);
    expect((status.data as { terminalAdoptions: Array<{ id: string; revision: number; lifecycle_adopted_at: string; adopt_reason: string }> }).terminalAdoptions)
      .toMatchObject([{ id: "wf-command", revision: 2, lifecycle_adopted_at: expect.any(String), adopt_reason: input.reason }]);
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
  expectAdoptionRefusal(
    refused,
    "[execution.header-revision-conflict] workflow wf-command header revision is 1, not expected revision 2; re-read status validate and retry with its listed revision",
    "Run `mstar status validate`, then retry `mstar workflow adopt-terminal --workflow <id> --expect <listed-revision>`.",
  );
});
test("registered-row refusal advertises the existing close path", async () => {
  const { root, harness } = await fixture();
  await withWriter(harness, (db) => {
    db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)")
      .run("wf-command", JSON.stringify({ id: "wf-command", type: "plan", started_at: "2026-10-01T00:00:00.000Z", dir: "workflows/wf-command" }));
    const epoch = (db.prepare("select authority_epoch from store_meta where id = 1").get() as { authority_epoch: number }).authority_epoch;
    db.prepare("insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) values (?, 'coordinator', ?, ?, 1, 'active', ?)")
      .run("wf-command", "caller-session", epoch, "2026-10-01T00:00:00.000Z");
  });
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-registered", reason: "already registered",
  }, invocation(root));
  expectAdoptionRefusal(
    refused,
    "[execution.adoption-refused] workflow wf-command is already registered; finish its lifecycle through mstar status workflow-close",
    "Use `mstar status workflow-close --workflow <id> --reason <text>` under the ACTIVE coordinator holder's binding to finish the existing terminal close.",
  );
});

test("ACTIVE-session refusal routes the existing holder to its close authority", async () => {
  const { root, harness } = await fixture();
  await withWriter(harness, (db) => {
    const epoch = (db.prepare("select authority_epoch from store_meta where id = 1").get() as { authority_epoch: number }).authority_epoch;
    db.prepare("insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) values (?, 'coordinator', ?, ?, 1, 'active', ?)")
      .run("wf-command", "caller-session", epoch, "2026-10-01T00:00:00.000Z");
  });
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-active", reason: "active holder",
  }, invocation(root));
  expectAdoptionRefusal(
    refused,
    "[execution.adoption-refused] workflow wf-command has an ACTIVE coordinator session at the current epoch; terminal adoption requires that holder's own close authority to restate the terminal lifecycle first",
    "The ACTIVE coordinator holder must use its own bound authority: run `mstar status workflow-close --workflow <id> --reason <text>` to restate the terminal lifecycle and finish close.",
  );
});

test("nonterminal-header refusal routes through execution bind and normal close", async () => {
  const { root, harness } = await fixture();
  await withWriter(harness, (db) => db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
    .run(JSON.stringify({ id: "wf-command", schema_version: 1, type: "plan", status: "running", started_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T01:00:00.000Z" }), "wf-command"));
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-running", reason: "not terminal",
  }, invocation(root));
  expectAdoptionRefusal(
    refused,
    "[execution.adoption-refused] workflow wf-command is not terminal; terminal adoption only records an already-terminal header and will not change this header",
    "Bind the non-terminal header with `mstar plan bind --execution --workflow <id> --coordinator` using a fresh runtime identity, then run `mstar status workflow-close --workflow <id> --reason <text>` under that binding.",
  );
});

test("missing terminal-reason refusal states the dead end and issue-capture route", async () => {
  const { root, harness } = await fixture();
  await withWriter(harness, (db) => db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
    .run(JSON.stringify({ id: "wf-command", schema_version: 1, type: "plan", status: "failed", started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z", updated_at: "2026-10-01T01:00:00.000Z" }), "wf-command"));
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-no-reason", reason: "missing provenance",
  }, invocation(root));
  expectAdoptionRefusal(
    refused,
    "[execution.adoption-refused] workflow wf-command has no recorded terminal reason in its header; no supported online operation can add it",
    "No supported online verb can add the missing stopped/failed reason. Preserve the header and capture this dead end with `mstar issue add`; do not claim it can be adopted.",
  );
});

test("missing-header refusal directs to new registration, not adoption", async () => {
  const { root, harness } = await fixture();
  await withWriter(harness, (db) => db.prepare("delete from execution_workflows where workflow_id = ?").run("wf-command"));
  const refused = await executeCommand("workflow.adopt-terminal", {
    workflow: "wf-command", harness, expect: "1", operation: "adopt-missing", reason: "header absent",
  }, invocation(root));
  expectAdoptionRefusal(
    refused,
    "[execution.adoption-refused] workflow wf-command has no terminal header to adopt; register the workflow through the supported workflow registration route",
    "The missing header cannot be adopted; create/register a new workflow through `mstar workflow register` with a valid catalog selection.",
  );
});
