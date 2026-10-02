import { afterAll, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeIssueExecution, linkIssueExecution, triageIssueExecution } from "./execution-coordination.js";
import { bindExecutionSession, createExecutionWorkflow, initializeExecutionAuthority, type ExecutionCaller, type ExecutionContext } from "./execution-store.js";
import { initializeStore, openStore, storeDbPath, type StoreContext } from "./store-db.js";
import { captureIssue, getIssue } from "./issue.js";
import type { WorkflowEntry } from "./status.js";
import type { WorkflowSnapshot } from "./workflow.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-execution-issue-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const TS = "2026-10-02T00:00:00.000Z";
let sequence = 0;

async function fixture() {
  const harnessDir = join(ROOT, String(++sequence));
  mkdirSync(harnessDir, { recursive: true });
  const store: StoreContext = { harnessDir };
  const handle = await initializeStore(store); handle.close();
  const initialized = await initializeExecutionAuthority(store);
  const caller: ExecutionCaller = { sessionId: "coord-1", role: "coordinator", workflowId: "wf-issues", planId: null };
  const created = await createExecutionWorkflow({ ...store, caller }, {
    entry: { id: "wf-issues", type: "plan", started_at: TS, dir: "workflows/wf-issues" } as WorkflowEntry,
    snapshot: { schema_version: 1, id: "wf-issues", type: "plan", status: "running", started_at: TS, updated_at: TS,
      plans: [{ id: "p-1", title: "p-1", file: "plans/p-1.md", status: "Todo" }], delivery_kind: "development",
      branch: { source: "feature/test", target: "main" } } as unknown as WorkflowSnapshot,
    expected: initialized.token, operationId: `create-${sequence}`,
  });
  const bound = await bindExecutionSession({ ...store, caller }, { workflowId: caller.workflowId, planId: null, role: "coordinator",
    expected: created.data.workflows[0]!.workflowToken, operationId: `bind-${sequence}` });
  const context: ExecutionContext = { ...store, caller };
  const issue = await captureIssue(store, {
    projectId: "p", title: "Issue", kind: "bug", severity: "high", impact: "impact", acceptance: "acceptance",
    sourceIdentity: `source-${sequence}`, rootCauseKey: `root-${sequence}`, acceptanceKey: `accept-${sequence}`,
    occurrenceKey: `occ-${sequence}`, sourceKind: "qc", location: "file.ts", observedBehavior: "observed", evidence: ["evidence"], discoveredAt: TS,
  }, { operationId: `capture-${sequence}`, actor: "project-manager" });
  return { store, context, issue, bound: bound.data, workflow: created.data.workflows[0]! };
}
const mut = (operationId: string, expectedRevision = 1, actor = "project-manager") => ({ operationId, actor, expectedRevision });

test("close uses the live coordinator and writes one issue revision", async () => {
  const f = await fixture();
  const receipt = await closeIssueExecution(f.context, f.issue.issueId, "resolved", {
    reason: "accepted", references: ["https://github.com/btspoony/mstar-harness/pull/361", "commit 00000000deadbeef"], alignmentRef: "PM acceptance record",
  }, mut("close", 1));
  expect(receipt).toMatchObject({ revision: 2, created: false });
  expect((await getIssue(f.store, f.issue.issueId)).disposition).toBe("resolved");
});

test("triage replays idempotently and validates actor and revision", async () => {
  const f = await fixture();
  const patch = { reason: "reclassify", severity: "medium" as const, kind: "risk" as const };
  const first = await triageIssueExecution(f.context, f.issue.issueId, patch, mut("triage"));
  const replay = await triageIssueExecution(f.context, f.issue.issueId, patch, mut("triage"));
  expect(replay).toEqual(first);
  await expect(triageIssueExecution(f.context, f.issue.issueId, patch, mut("wrong-actor", 2, "qa-engineer"))).rejects.toMatchObject({ code: "issue.scope-refused" });
  await expect(triageIssueExecution(f.context, f.issue.issueId, patch, mut("stale", 1))).rejects.toMatchObject({ code: "issue.revision-conflict" });
  expect((await getIssue(f.store, f.issue.issueId)).revision).toBe(2);
});

test("link route admits relations and PRs but enforces plan identity and coordinator scope", async () => {
  const f = await fixture();
  const second = await captureIssue(f.store, {
    projectId: "p", title: "Second", kind: "bug", severity: "low", impact: "impact", acceptance: "acceptance",
    sourceIdentity: "second", rootCauseKey: "second-root", acceptanceKey: "second-accept", occurrenceKey: "second-occ",
    sourceKind: "qc", location: "file.ts", observedBehavior: "observed", evidence: ["evidence"], discoveredAt: TS,
  }, { operationId: "capture-second", actor: "project-manager" });
  expect((await linkIssueExecution(f.context, f.issue.issueId, { relation: "related", issueId: second.issueId }, mut("related"))).revision).toBe(2);
  await linkIssueExecution(f.context, f.issue.issueId, { kind: "pr", target: "pr-1" }, mut("pr", 2));
  await expect(linkIssueExecution(f.context, f.issue.issueId, { kind: "plan", target: "other-plan" }, mut("other-plan", 3))).rejects.toMatchObject({ code: "issue.scope-refused" });
  await expect(linkIssueExecution(f.context, f.issue.issueId, { kind: "plan", target: "p-1" }, mut("coordinator-plan", 3))).rejects.toMatchObject({ code: "issue.scope-refused" });
});

test("plan-PM links persist only provenance for the caller's own plan", async () => {
  const f = await fixture();
  const db = new DatabaseSync(storeDbPath(f.store));
  try {
    db.prepare("update execution_plans set coordination_json = ? where workflow_id = ? and plan_id = ?").run(
      JSON.stringify({
        prepared: {
          assignment_path: join(f.store.harnessDir, "assignments/p-1.md"),
          assignment_sha256: "a".repeat(64),
          plan_sha256: "b".repeat(64),
          qa_gate: "mandatory",
          findings_cleanup: "allow-residual",
          prepared_by: "coord-1",
          prepared_at: TS,
        },
      }),
      "wf-issues",
      "p-1",
    );
    const row = db.prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?").get("wf-issues", "p-1") as { state_json: string };
    const state = JSON.parse(row.state_json) as Record<string, unknown>;
    state.metadata = {
      worktree_path: join(f.store.harnessDir, "worktrees/p-1"),
      working_branch: "feature/p-1",
    };
    db.prepare("update execution_plans set state_json = ? where workflow_id = ? and plan_id = ?").run(JSON.stringify(state), "wf-issues", "p-1");
  } finally {
    db.close();
  }
  const planCaller: ExecutionCaller = { sessionId: "plan-1", role: "plan-pm", workflowId: "wf-issues", planId: "p-1" };
  await bindExecutionSession({ ...f.store, caller: planCaller }, {
    workflowId: "wf-issues",
    planId: "p-1",
    role: "plan-pm",
    expected: f.workflow.planTokens["p-1"],
    operationId: "bind-plan-pm",
  });
  const context: ExecutionContext = { ...f.store, caller: planCaller };
  const own = await linkIssueExecution(context, f.issue.issueId, { kind: "plan", target: "p-1" }, mut("plan-own"));
  expect(own.revision).toBe(2);
  expect((await getIssue(f.store, f.issue.issueId)).provenance).toContainEqual(expect.objectContaining({ kind: "plan", target: "p-1" }));
  await expect(linkIssueExecution(context, f.issue.issueId, { kind: "plan", target: "other-plan" }, mut("plan-other", 2))).rejects.toMatchObject({ code: "issue.scope-refused" });
  await expect(linkIssueExecution(f.context, f.issue.issueId, { kind: "plan", target: "p-1" }, mut("coordinator-plan", 2))).rejects.toMatchObject({ code: "issue.scope-refused" });
});

test("routes require a live bound session and a running workflow", async () => {
  const f = await fixture();
  const unbound: ExecutionCaller = { ...f.context.caller, sessionId: "not-bound" };
  await expect(triageIssueExecution({ ...f.context, caller: unbound }, f.issue.issueId, { reason: "x" }, mut("unbound"))).rejects.toMatchObject({ code: "execution.session-unavailable" });
  const db = new DatabaseSync(storeDbPath(f.store));
  try {
    db.prepare("update execution_workflows set state_json = json_set(state_json, '$.status', 'stopped', '$.ended_at', ?) where workflow_id = ?").run(TS, "wf-issues");
  } finally { db.close(); }
  await expect(triageIssueExecution(f.context, f.issue.issueId, { reason: "x" }, mut("terminal"))).rejects.toMatchObject({ code: "coordination.invalid-transition" });
});

test("the retired file-envelope route remains refused on an active authority", async () => {
  const f = await fixture();
  await expect(import("./issue.js").then(({ closeIssue }) => closeIssue(f.store, f.issue.issueId, "resolved", {
    reason: "accepted", references: ["evidence"], alignmentRef: "PM acceptance record",
  }, { ...mut("file-route"), sessionFile: join(f.store.harnessDir, "missing-session.json") }))).rejects.toMatchObject({ code: "issue.scope-refused" });
});
