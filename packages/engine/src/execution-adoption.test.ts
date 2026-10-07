import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptTerminalWorkflow, initializeExecutionAuthority, readExecutionState, type ExecutionContext } from "./execution-store.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import { queryDashboard, withStoreRead } from "./store-read.js";
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function strandedTerminal(): Promise<{ context: StoreContext; caller: ExecutionContext["caller"]; epoch: number }> {
  const harnessDir = mkdtempSync(join(tmpdir(), "mstar-terminal-adoption-"));
  roots.push(harnessDir);
  const context = { harnessDir };
  const store = await initializeStore(context);
  store.close();
  const authority = await initializeExecutionAuthority(context);
  const handle = await openStore(context, "write");
  try {
    handle.db.prepare(
      "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) values (?, 1, null, ?, ?, ?)",
    ).run("wf-stranded", JSON.stringify({
      id: "wf-stranded", schema_version: 1, type: "plan", status: "completed",
      started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z",
      updated_at: "2026-10-01T01:00:00.000Z",
    }), "2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z");
  } finally { handle.close(); }
  return { context, caller: { sessionId: "adopter-session", role: "coordinator", workflowId: "wf-stranded" }, epoch: authority.epoch };
}

describe("terminal workflow adoption", () => {
  test("CAS-records adoption, preserves terminal state and registry absence, and replays idempotently", async () => {
    const { context, caller } = await strandedTerminal();
    const execution = { harnessDir: context.harnessDir, caller };
    const request = { workflowId: "wf-stranded", expectedRevision: 1, reason: "close the imported terminal record", operationId: "adopt-op-1" };
    const applied = await adoptTerminalWorkflow(execution, request);
    expect(applied.replayed).toBe(false);
    expect(applied.data.terminalUnregistered).toBeUndefined();
    expect(applied.data.terminalAdoptions).toEqual([{
      id: "wf-stranded", status: "completed", revision: 2,
      lifecycle_adopted_at: expect.any(String), adopt_reason: request.reason,
      actor_session_id: caller.sessionId, operation_id: request.operationId,
    }]);
    const db = await openStore(context, "read");
    try {
      expect((db.db.prepare("select count(*) as n from execution_registry where workflow_id = ?").get("wf-stranded") as { n: number }).n).toBe(0);
      expect(db.db.prepare("select revision, json_extract(state_json, '$.status') as status from execution_workflows where workflow_id = ?").get("wf-stranded")).toEqual({ revision: 2, status: "completed" });
      expect((db.db.prepare("select count(*) as n from execution_operations where operation_id = ?").get(request.operationId) as { n: number }).n).toBe(1);
    } finally { db.close(); }
    const replay = await adoptTerminalWorkflow(execution, request);
    expect(replay.replayed).toBe(true);
    expect(replay.data.terminalAdoptions).toEqual(applied.data.terminalAdoptions);
    expect((await readExecutionState(context)).data.terminalAdoptions).toEqual(applied.data.terminalAdoptions);
    const dashboard = await withStoreRead(context, queryDashboard("workflows"));
    expect(dashboard.data.terminalUnregistered).toBeUndefined();
    expect(dashboard.data.terminalAdoptions).toEqual(applied.data.terminalAdoptions);
  });

  test("refuses stale CAS, registered rows, active-session rows, non-terminal headers, and missing terminal reason", async () => {
    const stale = await strandedTerminal();
    await expect(adoptTerminalWorkflow({ harnessDir: stale.context.harnessDir, caller: stale.caller }, {
      workflowId: stale.caller.workflowId, expectedRevision: 2, reason: "stale", operationId: "adopt-stale",
    })).rejects.toMatchObject({
      code: "execution.header-revision-conflict",
      message: "[execution.header-revision-conflict] workflow wf-stranded header revision is 1, not expected revision 2; re-read status validate and retry with its listed revision",
    });

    const registered = await strandedTerminal();
    const registry = await openStore(registered.context, "write");
    registry.db.prepare("insert into execution_registry(workflow_id, entry_json) values (?, ?)")
      .run("wf-stranded", JSON.stringify({ id: "wf-stranded", type: "plan", started_at: "2026-10-01T00:00:00.000Z", dir: "workflows/wf-stranded" }));
    registry.close();
    await expect(adoptTerminalWorkflow({ harnessDir: registered.context.harnessDir, caller: registered.caller }, {
      workflowId: registered.caller.workflowId, expectedRevision: 1, reason: "registered", operationId: "adopt-registered",
    })).rejects.toMatchObject({
      code: "execution.adoption-refused",
      message: "[execution.adoption-refused] workflow wf-stranded is already registered; finish its lifecycle through mstar status workflow-close",
    });

    const active = await strandedTerminal();
    const session = await openStore(active.context, "write");
    session.db.prepare("insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at) values (?, 'coordinator', ?, ?, 1, 'active', ?)")
      .run("wf-stranded", "active-holder", active.epoch, "2026-10-01T00:00:00.000Z");
    session.close();
    await expect(adoptTerminalWorkflow({ harnessDir: active.context.harnessDir, caller: active.caller }, {
      workflowId: active.caller.workflowId, expectedRevision: 1, reason: "active", operationId: "adopt-active",
    })).rejects.toMatchObject({
      code: "execution.adoption-refused",
      message: "[execution.adoption-refused] workflow wf-stranded has an ACTIVE coordinator session at the current epoch; terminal adoption requires that holder's own close authority to restate the terminal lifecycle first",
    });

    const nonterminal = await strandedTerminal();
    const running = await openStore(nonterminal.context, "write");
    running.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
      .run(JSON.stringify({ id: "wf-stranded", schema_version: 1, type: "plan", status: "running", started_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T01:00:00.000Z" }), "wf-stranded");
    running.close();
    await expect(adoptTerminalWorkflow({ harnessDir: nonterminal.context.harnessDir, caller: nonterminal.caller }, {
      workflowId: nonterminal.caller.workflowId, expectedRevision: 1, reason: "running", operationId: "adopt-running",
    })).rejects.toMatchObject({
      code: "execution.adoption-refused",
      message: "[execution.adoption-refused] workflow wf-stranded is not terminal; terminal adoption only records an already-terminal header and will not change this header",
    });

    const missingReason = await strandedTerminal();
    const failed = await openStore(missingReason.context, "write");
    failed.db.prepare("update execution_workflows set state_json = ? where workflow_id = ?")
      .run(JSON.stringify({ id: "wf-stranded", schema_version: 1, type: "plan", status: "failed", started_at: "2026-10-01T00:00:00.000Z", ended_at: "2026-10-01T01:00:00.000Z", updated_at: "2026-10-01T01:00:00.000Z" }), "wf-stranded");
    failed.close();
    await expect(adoptTerminalWorkflow({ harnessDir: missingReason.context.harnessDir, caller: missingReason.caller }, {
      workflowId: missingReason.caller.workflowId, expectedRevision: 1, reason: "failed", operationId: "adopt-failed",
    })).rejects.toMatchObject({
      code: "execution.adoption-refused",
      message: "[execution.adoption-refused] workflow wf-stranded has no recorded terminal reason in its header; no supported online operation can add it",
    });
  });
});
