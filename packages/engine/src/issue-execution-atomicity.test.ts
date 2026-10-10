/**
 * issue-execution-atomicity — the handle-taking issue bodies the DB
 * coordination route composes into its own transaction (W3).
 *
 * Run with
 * `bun test packages/engine/src/issue-execution-atomicity.test.ts --test-name-pattern 'execution-issue-atomicity'`.
 *
 * Every case drives the SAME bodies the public issue verbs run and the DB
 * residual operations compose, on a handle the CALLER owns. The bodies open no
 * store and begin no transaction: whatever they do inside a caller's transaction
 * is committed whole or rolled back whole, and a refusal anywhere after an
 * earlier step already wrote leaves none of it behind. That is the property the
 * DB route depends on (plan row, issue rows and receipts in one commit) and the
 * property the public verbs must keep (each verb is still exactly one
 * transaction of its own).
 *
 * Every fixture is its own temporary control root: no case reads or writes this
 * checkout's `store.db`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertIssueStoreActive,
  captureIssue,
  captureIssueOn,
  closeIssue,
  closeIssueOn,
  getIssue,
  linkIssueOn,
  reopenIssue,
  reopenIssueOn,
  listIssues,
  type CaptureInput,
  type ClosureEvidence,
  type IssueError,
} from "./issue.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  readExecutionPlan,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionSessionRef,
} from "./execution-store.js";
import { mutateExecutionPlan } from "./execution-coordination.js";
import type { WorkflowSnapshot } from "./workflow.js";
import type { WorkflowEntry } from "./status.js";
import { deriveResidualEntries } from "./execution-coordination.js";
import { initializeStore, openStore, type StoreContext, type StoreDb } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-issue-atomicity-"));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const ACTOR = "project-manager";

/** An active issue/catalog store — the precondition of every privileged verb. */
async function activeStore(name: string): Promise<StoreContext> {
  const context: StoreContext = { harnessDir: mkdtempSync(join(ROOT, `${name}-`)) };
  const handle = await initializeStore(context);
  handle.close();
  return context;
}

async function executionPlanFixture(name: string): Promise<{
  context: StoreContext;
  workflowId: string;
  planId: string;
  caller: ExecutionCaller;
  session: ExecutionSessionRef;
}> {
  const repoRoot = realpathSync(mkdtempSync(join(ROOT, `${name}-`)));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  git(["init", "-q", "-b", "main"]);
  git(["-c", "user.email=test@example.invalid", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "fixture"]);
  const harnessDir = join(repoRoot, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const context: StoreContext = { harnessDir };
  (await initializeStore(context)).close();
  const initialized = await readExecutionState(context);
  const workflowId = "wf-issue-batch";
  const planId = "plan-issue-batch";
  const iterationId = "iter-issue-batch";
  const compassRef = `iterations/${iterationId}/delivery-compass.md`;
  const compassPath = join(harnessDir, compassRef);
  mkdirSync(dirname(compassPath), { recursive: true });
  writeFileSync(compassPath, [
    "---",
    `iteration_id: ${iterationId}`,
    "start_date: 2026-10-08",
    "status: active",
    "iteration_base_branch: main",
    "target_branch: main",
    `plans: [${planId}]`,
    "---",
    "",
    `# ${iterationId}`,
    "",
  ].join("\n"));
  const integrationPath = join(repoRoot, "integration");
  git(["worktree", "add", "-q", "-b", "integration/issue-batch", integrationPath]);
  const caller: ExecutionCaller = { sessionId: "coordinator-issue-batch", role: "coordinator", workflowId };
  const created = await createExecutionWorkflow({ harnessDir, caller }, {
    entry: { id: workflowId, type: "plan", started_at: "2026-10-08T00:00:00.000Z", dir: `workflows/${workflowId}` } as WorkflowEntry,
    snapshot: {
      schema_version: 1,
      id: workflowId,
      type: "plan",
      status: "running",
      started_at: "2026-10-08T00:00:00.000Z",
      phase: "phase-1-prepare",
      project: "harness",
      compass_ref: compassRef,
      updated_at: "2026-10-08T00:00:00.000Z",
      delivery_kind: "development",
      branch: { base: "main", source: "feature/issue-batch", target: "main", integration: "integration/issue-batch" },
      integration_worktree_path: integrationPath,
      execution_policy: { plan_parallelism: "serial", worktree_mode: "required" },
      plans: [{ id: planId, title: "Issue batch", file: `plans/${planId}.md`, status: "Todo", metadata: { working_branch: "feature/issue-batch" } }],
    } as unknown as WorkflowSnapshot,
    expected: initialized.token,
    operationId: `create-${name}`,
  });
  const workflow = created.data.workflows[0];
  if (workflow === undefined) throw new Error("fixture: execution workflow registration returned no workflow");
  const session = await bindExecutionSession({ harnessDir, caller }, {
    workflowId,
    expected: workflow.workflowToken,
    operationId: `bind-${name}`,
  });
  return { context, workflowId, planId, caller, session: session.data };
}

function baseInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    projectId: "_default",
    title: "residual finding",
    kind: "bug",
    severity: "high",
    impact: "the residual is unfixed",
    acceptance: "the residual is fixed",
    sourceIdentity: "qc/review.md",
    rootCauseKey: "missing-guard",
    acceptanceKey: "guard-present",
    occurrenceKey: "run-1",
    sourceKind: "qc",
    location: "packages/engine/src/execution-coordination.ts:1",
    observedBehavior: "the finding is visible",
    evidence: ["stack: TypeError"],
    discoveredAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

/** One caller-owned transaction, exactly as the DB coordination frame owns it. */
async function inTransaction<T>(context: StoreContext, body: (db: StoreDb) => T): Promise<T> {
  const handle = await openStore(context, "write");
  try {
    handle.db.exec("begin immediate");
    try {
      const result = body(handle.db);
      handle.db.exec("commit");
      return result;
    } catch (error) {
      handle.db.exec("rollback");
      throw error;
    }
  } finally {
    handle.close();
  }
}

/** Everything the issue authority holds, as one comparable value. */
type IssueFacts = {
  storeRevision: number;
  issues: number;
  occurrences: number;
  provenance: number;
  transitions: number;
  operations: number;
};

async function issueFacts(context: StoreContext): Promise<IssueFacts> {
  const handle = await openStore(context, "read");
  try {
    const db = handle.db;
    const count = (table: string): number => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
    const meta = db.prepare("select revision from store_meta where id = 1").get() as { revision: number };
    return {
      storeRevision: meta.revision,
      issues: count("issues"),
      occurrences: count("occurrences"),
      provenance: count("provenance"),
      transitions: count("issue_transitions"),
      operations: count("store_operations"),
    };
  } finally {
    handle.close();
  }
}

async function refusalOf(work: () => Promise<unknown>): Promise<IssueError> {
  try {
    await work();
    throw new Error("expected a refusal");
  } catch (error) {
    return error as IssueError;
  }
}

const resolvedEvidence: ClosureEvidence = { reason: "fixed", references: ["p-1"], alignmentRef: "qa-gate:accepted" };
const waivedEvidence: ClosureEvidence = {
  reason: "not this plan's work",
  scope: "all",
  references: [],
  alignmentRef: "user:alignment",
};

describe("execution-issue-atomicity: the composers of the DB residual transaction", () => {
  test("atomic issue capture rolls back when plan linking refuses", async () => {
    const context = await activeStore("capture-then-refused-link");
    const before = await issueFacts(context);

    const refused = await refusalOf(() =>
      inTransaction(context, (db) => {
        const capture = captureIssueOn(db, baseInput(), { operationId: "atomic-capture", actor: ACTOR });
        // The capture above already wrote the issue row, its counter, its
        // occurrence, its capture provenance and the store revision. The link
        // then refuses: the whole composition must vanish with it.
        linkIssueOn(db, capture.issueId, { kind: "plan", target: "p-1" }, {
          operationId: "atomic-link",
          actor: ACTOR,
          expectedRevision: capture.revision + 1,
        });
      }),
    );

    expect(refused.code).toBe("issue.revision-conflict");
    expect(await issueFacts(context)).toEqual(before);
    expect((await listIssues(context, {})).total).toBe(0);

    // The rolled-back capture consumed no identifier: the next accepted capture
    // takes the id the aborted one had allocated.
    const next = await captureIssue(context, baseInput({ occurrenceKey: "after-rollback" }), {
      operationId: "after-rollback",
      actor: ACTOR,
    });
    expect(next.issueId).toBe("I-000001");
    expect(next.created).toBe(true);
  });
  test("indexed validation retains field causes, accepted values, safe facts, and refuses before store mutation", async () => {
    const context = await activeStore("invalid-residual-facts");
    const derived = deriveResidualEntries([baseInput({ projectId: "caller-project", occurrenceKey: "event-17" })], "plan-project");
    expect(derived[0]).toMatchObject({ projectId: "plan-project", occurrenceKey: "event-17" });
    const before = await issueFacts(context);
    const secret = `sk_live_${"b".repeat(24)}`;
    let failure: unknown;
    try {
      deriveResidualEntries(
        [
          baseInput({ occurrenceKey: "event-bad-kind", kind: "tech-debt" as never }),
          baseInput({ occurrenceKey: "event-bad-both", kind: secret as never, severity: { token: secret } as never }),
          baseInput({ occurrenceKey: "event-mixed-cause", title: "", kind: secret as never }),
        ],
        "_default",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "coordination.invalid-input",
      details: {
        problems: [
          {
            path: "entries[0]",
            causes: [{
              path: "entries[0].kind",
              field: "kind",
              received: "tech-debt",
              expected: ["bug", "risk", "improvement", "request", "decision", "review-obligation"],
            }],
          },
          {
            path: "entries[1]",
            causes: [
              { path: "entries[1].kind", field: "kind" },
              { path: "entries[1].severity", field: "severity", received: "object" },
            ],
          },
          {
            path: "entries[2]",
            causes: [
              { code: "issue.scope-refused" },
              { path: "entries[2].kind", field: "kind" },
            ],
          },
        ],
      },
    });
    const message = (failure as Error).message;
    expect(JSON.stringify({ message, details: (failure as { details: unknown }).details })).not.toContain(secret);
    expect(message).toContain("Invalid residual-add entries; correct each reported problem, then retry through mstar plan issue-add.");
    expect(await issueFacts(context)).toEqual(before);

    const corrected = deriveResidualEntries(
      [
        baseInput({ occurrenceKey: "event-corrected-kind", kind: "improvement" }),
        baseInput({ occurrenceKey: "event-corrected-both", kind: "request", severity: "low" }),
      ],
      "_default",
    );
    expect(corrected.map(({ kind, severity }) => [kind, severity])).toEqual([
      ["improvement", "high"],
      ["request", "low"],
    ]);
    expect(await issueFacts(context)).toEqual(before);
  });
  test("indexed residual validation rejects sparse holes", () => {
    let mixedFailure: unknown;
    try {
      deriveResidualEntries(
        [baseInput({ occurrenceKey: "event-18" }), , baseInput({ occurrenceKey: "event-20" })],
        "plan-project",
      );
    } catch (error) {
      mixedFailure = error;
    }
    expect(mixedFailure).toMatchObject({
      code: "coordination.invalid-input",
      details: { problems: [{ path: "entries[1]" }] },
    });

    let allHolesFailure: unknown;
    try {
      deriveResidualEntries([, ,], "plan-project");
    } catch (error) {
      allHolesFailure = error;
    }
    expect(allHolesFailure).toMatchObject({
      code: "coordination.invalid-input",
      details: { problems: [{ path: "entries[0]" }, { path: "entries[1]" }] },
    });
  });


  test("occurrence replay retains the same event identity across capture and plan-link retries", async () => {
    const context = await activeStore("occurrence-replay");
    const input = baseInput({ occurrenceKey: "event-17" });
    const first = await inTransaction(context, (db) => {
      const captured = captureIssueOn(db, input, { operationId: "capture-event-17", actor: ACTOR });
      linkIssueOn(
        db,
        captured.issueId,
        { kind: "plan", target: "p-1" },
        { operationId: "link-event-17", actor: ACTOR, expectedRevision: captured.revision },
      );
      return captured;
    });
    const beforeReplay = await issueFacts(context);
    const replay = await inTransaction(context, (db) => {
      const captured = captureIssueOn(db, input, { operationId: "capture-event-17", actor: ACTOR });
      linkIssueOn(
        db,
        captured.issueId,
        { kind: "plan", target: "p-1" },
        { operationId: "link-event-17", actor: ACTOR, expectedRevision: captured.revision },
      );
      return captured;
    });

    expect(replay.issueId).toBe(first.issueId);
    expect(await issueFacts(context)).toEqual(beforeReplay);
    expect((await getIssue(context, first.issueId)).occurrences.map(({ occurrenceKey }) => occurrenceKey)).toEqual(["event-17"]);
  });

  test("residual-add child occurrence conflicts identify the entry and correction while rolling back the full batch", async () => {
    const fixture = await executionPlanFixture("residual-child-conflict");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const beforeIssues = await issueFacts(fixture.context);
    const initialPlan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const operationCount = async () => {
      const handle = await openStore(fixture.context, "read");
      try {
        return (handle.db.prepare("select count(*) as count from execution_operations").get() as { count: number }).count;
      } finally {
        handle.close();
      }
    };
    const beforeOperations = await operationCount();
    const conflictingEntries = [
      baseInput({ occurrenceKey: "batch-shared-event" }),
      baseInput({ occurrenceKey: "batch-shared-event", observedBehavior: "different observation reuses the same event key" }),
    ];
    const callBatch = (operationId: string, entries: CaptureInput[]) => mutateExecutionPlan(context, {
      operationId,
      session: fixture.session,
      expected: initialPlan.token,
      planId: fixture.planId,
      operation: { kind: "residual-add", entries },
    });
    const firstRefusal = await refusalOf(() => callBatch("outer-batch-first", conflictingEntries));
    expect(firstRefusal).toMatchObject({
      code: "store.operation-conflict",
      details: {
        entryIndex: 1,
        entryPath: "entries[1].occurrenceKey",
        childOperation: "capture",
        childOperationIdOrigin: "session + plan + entry occurrenceKey",
        causeCode: "store.operation-conflict",
      },
    });
    const secondRefusal = await refusalOf(() => callBatch("outer-batch-new-id", conflictingEntries));
    expect(secondRefusal).toMatchObject({
      code: "store.operation-conflict",
      details: {
        entryIndex: 1,
        entryPath: "entries[1].occurrenceKey",
        childOperation: "capture",
        childOperationIdOrigin: "session + plan + entry occurrenceKey",
        causeCode: "store.operation-conflict",
      },
    });
    expect(await issueFacts(fixture.context)).toEqual(beforeIssues);
    expect((await readExecutionPlan(context, fixture.session, fixture.planId)).token).toEqual(initialPlan.token);
    expect(await operationCount()).toBe(beforeOperations);

    const corrected = await callBatch("outer-batch-corrected", [
      baseInput({ occurrenceKey: "batch-event-1" }),
      baseInput({ occurrenceKey: "batch-event-2", observedBehavior: "a distinct observation with its own event key" }),
    ]);
    expect(corrected.replayed).toBe(false);
    expect(await operationCount()).toBe(beforeOperations + 1);
    const issues = await listIssues(fixture.context, {});
    expect(issues.total).toBe(1);
    expect((await getIssue(fixture.context, issues.items[0]!.id)).occurrences.map(({ occurrenceKey }) => occurrenceKey)).toEqual([
      "batch-event-1", "batch-event-2",
    ]);
    expect(await issueFacts(fixture.context)).toMatchObject({
      issues: 1,
      occurrences: 2,
      operations: beforeIssues.operations + 4,
    });
  });


  test("an issue transition written in a caller's transaction is rolled back with the step that fails after it", async () => {
    const context = await activeStore("close-then-refused-step");
    const closable = await captureIssue(context, baseInput({ occurrenceKey: "closable" }), {
      operationId: "seed-closable",
      actor: ACTOR,
    });
    const before = await issueFacts(context);

    const refused = await refusalOf(() =>
      inTransaction(context, (db) => {
        // First step: a complete, valid closure — disposition, transition row,
        // store revision and its operation receipt, all written.
        const closed = closeIssueOn(db, closable.issueId, "resolved", resolvedEvidence, {
          operationId: "atomic-close",
          actor: ACTOR,
          expectedRevision: closable.revision,
        });
        // Second step of the same composition: the same finding again, now
        // terminal INSIDE this transaction, refuses. The first closure is rolled
        // back with it — nothing of it is left in the issue or its history.
        closeIssueOn(db, closable.issueId, "waived", waivedEvidence, {
          operationId: "atomic-close-2",
          actor: ACTOR,
          expectedRevision: closed.revision,
        });
      }),
    );

    expect(refused.code).toBe("issue.invalid-disposition");
    expect(await issueFacts(context)).toEqual(before);
    const after = await getIssue(context, closable.issueId);
    expect(after.disposition).toBe("open");
    expect(after.revision).toBe(closable.revision);
    expect(after.transitions).toEqual([]);
  });
  test("a reopen body rolls back with a later refused transition in its owner transaction", async () => {
    const context = await activeStore("reopen-then-refused-step");
    const created = await captureIssue(context, baseInput({ occurrenceKey: "reopen-rollback" }), {
      operationId: "reopen-rollback-seed",
      actor: ACTOR,
    });
    const closed = await closeIssue(context, created.issueId, "resolved", resolvedEvidence, {
      operationId: "reopen-rollback-close",
      actor: ACTOR,
      expectedRevision: created.revision,
    });
    const before = await issueFacts(context);
    const refused = await refusalOf(() =>
      inTransaction(context, (db) => {
        const reopened = reopenIssueOn(db, created.issueId, { reason: "retry with new evidence" }, {
          operationId: "atomic-reopen",
          actor: ACTOR,
          expectedRevision: closed.revision,
        });
        reopenIssueOn(db, created.issueId, { reason: "illegal repeated reopen" }, {
          operationId: "atomic-reopen-again",
          actor: ACTOR,
          expectedRevision: reopened.revision,
        });
      }),
    );
    expect(refused.code).toBe("issue.invalid-disposition");
    expect(await issueFacts(context)).toEqual(before);
    const after = await getIssue(context, created.issueId);
    expect(after.disposition).toBe("resolved");
    expect(after.revision).toBe(closed.revision);
    expect(after.transitions).toHaveLength(1);
  });

  test("the public verbs keep one transaction each and the store precondition", async () => {
    const context = await activeStore("public-verbs-own-transaction");
    const created = await captureIssue(context, baseInput({ occurrenceKey: "public" }), {
      operationId: "public-capture",
      actor: ACTOR,
    });
    expect(created.created).toBe(true);
    const accepted = await issueFacts(context);

    // A second public call refuses on its own: the accepted capture above is not
    // rolled back with it, because each public verb is exactly one transaction
    // of its own rather than a step of somebody else's.
    const refused = await refusalOf(() =>
      captureIssue(context, baseInput({ occurrenceKey: "public-2", rootCauseKey: "unknown" }), {
        operationId: "public-capture-2",
        actor: ACTOR,
      }),
    );
    expect(refused.code).toBe("issue.ambiguous-identity");
    expect(await issueFacts(context)).toEqual(accepted);
    const closed = await closeIssue(context, created.issueId, "resolved", resolvedEvidence, {
      operationId: "public-close",
      actor: ACTOR,
      expectedRevision: created.revision,
    });
    expect(closed.storeRevision).toBe(accepted.storeRevision + 1);
    const beforeReopen = await issueFacts(context);
    const reopened = await reopenIssue(context, created.issueId, { reason: "public reopen" }, {
      operationId: "public-reopen",
      actor: ACTOR,
      expectedRevision: closed.revision,
    });
    expect(reopened.storeRevision).toBe(beforeReopen.storeRevision + 1);
    expect((await getIssue(context, created.issueId)).disposition).toBe("open");

    // A staged store refuses the composed route exactly where it refuses the
    // public one, before any body runs.
    const handle = await openStore(context, "write");
    try {
      handle.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
      expect(() => assertIssueStoreActive(handle.db)).toThrow(/store\.not-active/);
    } finally {
      handle.close();
    }
    const staged = await refusalOf(() => captureIssue(context, baseInput(), { operationId: "staged", actor: ACTOR }));
    expect(staged.code).toBe("store.not-active");
  });
});
