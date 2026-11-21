/**
 * issue-execution-atomicity — the handle-taking issue bodies and the composite
 * frame that composes them across the two authorities.
 *
 * Run with
 * `bun test packages/engine/src/issue-execution-atomicity.test.ts -t 'collaboration composite residual|residual-add|residual-close'`.
 *
 * The combined store is gone: issue rows live in the collaboration lane, plan
 * rows and operation receipts in the execution lane. The composer cases below
 * still drive the SAME bodies the public issue verbs run, on a handle the CALLER
 * owns, to prove each body is atomic inside one transaction. The composite cases
 * drive the admitted residual verbs, whose three phases (execution prepare,
 * collaboration effect, execution finalize) are correlated by a durable intent
 * and effect receipt.
 *
 * Every fixture is its own temporary control root and user home: no case reads
 * or writes this checkout's `store.db` or the operator's real home.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeOs from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { initializeCollaborationStore, withCollaborationWrite } from "./collaboration-store.js";
import { runCollaborationComposite, type CompositeIntent } from "./collaboration-operations.js";
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
  parseExecutionToken,
  readExecutionPlan,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionSessionRef,
} from "./execution-store.js";
import { deriveResidualEntries, mutateExecutionPlan } from "./execution-coordination.js";
import type { WorkflowSnapshot } from "./workflow.js";
import type { WorkflowEntry } from "./status.js";
import { initializeStore, openStore, type StoreContext, type StoreDb } from "./store-db.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-atomicity-")));
const HOME = join(ROOT, "home");
mkdirSync(HOME);

/**
 * The collaboration store is user-level, so the resolver's home must be this
 * fixture and never the operator's. One spy serves the whole file.
 */
let homeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  homeSpy = spyOnHomedir();
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

function spyOnHomedir(): { mockRestore(): void } {
  // A static import would run before the spy is installed; bun's spyOn wraps the
  // live namespace binding the store entry points read.
  return (nodeOs as unknown as { homedir: { mockImplementation?(fn: () => string): { mockRestore(): void } } }).homedir?.mockImplementation?.(
    () => HOME,
  ) ?? { mockRestore() {} };
}

const ACTOR = "project-manager";

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

/**
 * A synthetic checkout: the origin names the repository the collaboration
 * authority is keyed by, and `.mstarc` selects the local mode an operator's own
 * clone would declare.
 */
function checkout(name: string): { root: string; harnessDir: string; context: StoreContext } {
  const root = realpathSync(mkdtempSync(join(ROOT, `${name}-`)));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "fixture"]);
  git(root, ["remote", "add", "origin", `https://github.com/acme/${basename(root)}.git`]);
  writeFileSync(join(root, ".mstarc"), "[collaboration]\nmode=local\n");
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  return { root, harnessDir, context: { harnessDir, checkoutRoot: root } };
}

/** Flip a staged collaboration record to active: this plan ships no public activator. */
function activate(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

/** A combined store plus an ACTIVE collaboration authority, both empty. */
async function activeStore(name: string): Promise<StoreContext> {
  const fixture = checkout(name);
  (await initializeStore(fixture.context)).close();
  await initializeCollaborationStore(resolveCollaborationLocation(fixture.context));
  activate(resolveCollaborationLocation(fixture.context).dbPath);
  return fixture.context;
}

async function executionPlanFixture(
  name: string,
  options: { collaboration?: "active" | "staged" } = {},
): Promise<{
  context: StoreContext;
  workflowId: string;
  planId: string;
  caller: ExecutionCaller;
  session: ExecutionSessionRef;
}> {
  const fixture = checkout(name);
  const { root: repoRoot, harnessDir } = fixture;
  const context: StoreContext = fixture.context;
  (await initializeStore(context)).close();
  await initializeCollaborationStore(resolveCollaborationLocation(context));
  if ((options.collaboration ?? "active") === "active") activate(resolveCollaborationLocation(context).dbPath);
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
  git(repoRoot, ["worktree", "add", "-q", "-b", "integration/issue-batch", integrationPath]);
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

/** One caller-owned collaboration transaction, exactly as the effect phase owns it. */
function inTransaction<T>(context: StoreContext, body: (db: StoreDb) => T): T {
  const db = new DatabaseSync(resolveCollaborationLocation(context).dbPath);
  // node:sqlite's typed statements are the same engine StoreDb wraps; a raw
  // connection is what lets this test roll a composed effect back by hand.
  const handle = db as unknown as StoreDb;
  try {
    handle.exec("pragma foreign_keys=ON");
    handle.exec("begin immediate");
    try {
      const result = body(handle);
      handle.exec("commit");
      return result;
    } catch (error) {
      handle.exec("rollback");
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Everything the collaboration authority holds, as one comparable value. */
type IssueFacts = {
  revision: number;
  catalogRevision: number;
  issues: number;
  occurrences: number;
  provenance: number;
  transitions: number;
  standalone: number;
  composite: number;
};

function issueFacts(context: StoreContext): Promise<IssueFacts> {
  return withCollaborationWrite(context, (handle) => {
    const db = handle.db;
    const count = (table: string): number => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
    const meta = db.prepare("select revision, catalog_revision from collaboration_meta where id = 1").get() as {
      revision: number;
      catalog_revision: number;
    };
    const operations = db.prepare("select key_space, count(*) as n from collaboration_operations group by key_space").all() as Array<{
      key_space: string;
      n: number;
    }>;
    const bySpace = (space: string): number => operations.find((row) => row.key_space === space)?.n ?? 0;
    return {
      revision: meta.revision,
      catalogRevision: meta.catalog_revision,
      issues: count("issues"),
      occurrences: count("occurrences"),
      provenance: count("provenance"),
      transitions: count("issue_transitions"),
      standalone: bySpace("standalone"),
      composite: bySpace("composite"),
    };
  });
}

/** Everything the execution authority holds about operations and its own revisions. */
async function executionFacts(context: StoreContext): Promise<{ storeRevision: number; operations: number }> {
  const handle = await openStore(context, "read");
  try {
    return {
      // The counter every accepted plan operation advances once (the execution
      // frame's own revision is the root/header identity, not a per-operation one).
      storeRevision: (handle.db.prepare("select revision from store_meta where id = 1").get() as { revision: number }).revision,
      operations: (handle.db.prepare("select count(*) as n from execution_operations").get() as { n: number }).n,
    };
  } finally {
    handle.close();
  }
}

/** One raw execution write, used only to simulate a lost finalization. */
async function inExecutionWrite<T>(context: StoreContext, body: (db: StoreDb) => T): Promise<T> {
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

async function refusalOf(work: () => Promise<unknown>): Promise<{ code: string; message: string; details?: unknown }> {
  try {
    await work();
    throw new Error("expected a refusal");
  } catch (error) {
    return error as { code: string; message: string; details?: unknown };
  }
}

const resolvedEvidence: ClosureEvidence = { reason: "fixed", references: ["p-1"], alignmentRef: "qa-gate:accepted" };
const waivedEvidence: ClosureEvidence = {
  reason: "not this plan's work",
  scope: "all",
  references: [],
  alignmentRef: "user:alignment",
};

describe("execution-issue-atomicity: the composers of one collaboration effect", () => {
  test("atomic issue capture rolls back when plan linking refuses", async () => {
    const context = await activeStore("capture-then-refused-link");
    const before = await issueFacts(context);

    const refused = await refusalOf(async () =>
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
    const first = inTransaction(context, (db) => {
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
    const replay = inTransaction(context, (db) => {
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

  test("an issue transition written in a caller's transaction is rolled back with the step that fails after it", async () => {
    const context = await activeStore("close-then-refused-step");
    const closable = await captureIssue(context, baseInput({ occurrenceKey: "closable" }), {
      operationId: "seed-closable",
      actor: ACTOR,
    });
    const before = await issueFacts(context);

    const refused = await refusalOf(async () =>
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
    const refused = await refusalOf(async () =>
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
    expect(closed.storeRevision).toBe(accepted.revision + 1);
    const beforeReopen = await issueFacts(context);
    const reopened = await reopenIssue(context, created.issueId, { reason: "public reopen" }, {
      operationId: "public-reopen",
      actor: ACTOR,
      expectedRevision: closed.revision,
    });
    expect(reopened.storeRevision).toBe(beforeReopen.revision + 1);
    expect((await getIssue(context, created.issueId)).disposition).toBe("open");

    // A staged collaboration store refuses the composed route exactly where it
    // refuses the public one, before any body runs.
    const dbPath = resolveCollaborationLocation(context).dbPath;
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("update collaboration_meta set authority_state = 'staged' where id = 1").run();
      expect(() => assertIssueStoreActive(db as unknown as StoreDb)).toThrow(/store\.not-active/);
    } finally {
      db.prepare("update collaboration_meta set authority_state = 'active' where id = 1").run();
      db.close();
    }
    const staged = await refusalOf(async () => {
      const raw = new DatabaseSync(dbPath);
      try {
        raw.prepare("update collaboration_meta set authority_state = 'staged' where id = 1").run();
      } finally {
        raw.close();
      }
      try {
        return await captureIssue(context, baseInput(), { operationId: "staged", actor: ACTOR });
      } finally {
        const restore = new DatabaseSync(dbPath);
        try {
          restore.prepare("update collaboration_meta set authority_state = 'active' where id = 1").run();
        } finally {
          restore.close();
        }
      }
    });
    expect(staged.code).toBe("collaboration.not-active");
  });
});

describe("collaboration composite residual", () => {
  test("an accepted residual commits the issue effect, its receipt and the plan delta once each", async () => {
    const fixture = await executionPlanFixture("composite-accepted");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const before = await issueFacts(fixture.context);
    const beforeExecution = await executionFacts(fixture.context);
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);

    const receipt = await mutateExecutionPlan(context, {
      operationId: "composite-add-1",
      session: fixture.session,
      expected: plan.token,
      planId: fixture.planId,
      operation: { kind: "residual-add", entries: [baseInput({ occurrenceKey: "composite-1" })] },
    });

    expect(receipt.replayed).toBe(false);
    // One collaboration revision advance for the whole effect transaction; the
    // capture and the plan link keep their own standalone receipts.
    const after = await issueFacts(fixture.context);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.catalogRevision).toBe(before.catalogRevision);
    expect(after.issues).toBe(before.issues + 1);
    expect(after.occurrences).toBe(before.occurrences + 1);
    expect(after.provenance).toBe(before.provenance + 2);
    expect(after.standalone).toBe(before.standalone + 2);
    expect(after.composite).toBe(before.composite + 1);

    // The execution lane advanced its own counters exactly once and holds the one
    // committed operation receipt; the collaboration revision is a separate
    // namespace.
    const afterExecution = await executionFacts(fixture.context);
    expect(afterExecution.storeRevision).toBe(beforeExecution.storeRevision + 1);
    expect(afterExecution.operations).toBe(beforeExecution.operations + 1);

    const issues = await listIssues(fixture.context, {});
    expect(issues.total).toBe(1);
    expect((await getIssue(fixture.context, issues.items[0]!.id)).provenance.some((entry) => entry.kind === "plan" && entry.target === fixture.planId)).toBe(true);
    const committed = await readExecutionPlan(context, fixture.session, fixture.planId);
    expect(parseExecutionToken(committed.token).revision).toBe(parseExecutionToken(plan.token).revision + 1);
  });

  test("an exact retry replays the recorded receipt before the CAS and changes nothing", async () => {
    const fixture = await executionPlanFixture("composite-replay");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const request = {
      operationId: "composite-replay-1",
      session: fixture.session,
      expected: plan.token,
      planId: fixture.planId,
      operation: { kind: "residual-add" as const, entries: [baseInput({ occurrenceKey: "replay-1" })] },
    };
    const first = await mutateExecutionPlan(context, request);
    const after = await issueFacts(fixture.context);
    const afterExecution = await executionFacts(fixture.context);

    // The same operation id with the SAME stale token: the recorded receipt is
    // served before the CAS the first attempt already spent.
    const replay = await mutateExecutionPlan(context, request);
    expect(replay.replayed).toBe(true);
    expect(replay.token).toBe(first.token);
    expect(await issueFacts(fixture.context)).toEqual(after);
    expect(await executionFacts(fixture.context)).toEqual(afterExecution);
  });

  test("an interruption after the collaboration effect resumes from its receipt without allocating another issue", async () => {
    const fixture = await executionPlanFixture("composite-interrupted");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const request = {
      operationId: "composite-interrupted-1",
      session: fixture.session,
      expected: plan.token,
      planId: fixture.planId,
      operation: { kind: "residual-add" as const, entries: [baseInput({ occurrenceKey: "interrupted-1" })] },
    };
    await mutateExecutionPlan(context, request);
    const committed = await issueFacts(fixture.context);

    // A lost execution acknowledgement: the collaboration receipt survives, the
    // single operation row is gone, and the caller never saw the success.
    await inExecutionWrite(fixture.context, (db) => {
      db.prepare("delete from execution_operations where operation_id = ?").run("composite-interrupted-1");
    });
    const current = await readExecutionPlan(context, fixture.session, fixture.planId);
    const resumed = await mutateExecutionPlan(context, { ...request, expected: current.token });

    expect(resumed.replayed).toBe(false);
    const after = await issueFacts(fixture.context);
    // The effect is NOT applied twice: same issue, same occurrence, same
    // composite receipt; only the execution delta and its receipt were committed.
    expect(after.issues).toBe(committed.issues);
    expect(after.occurrences).toBe(committed.occurrences);
    expect(after.composite).toBe(committed.composite);
    expect(after.standalone).toBe(committed.standalone);
    expect((await listIssues(fixture.context, {})).total).toBe(1);
  });

  test("the same operation id with a different payload refuses before applying", async () => {
    const fixture = await executionPlanFixture("composite-conflict");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    await mutateExecutionPlan(context, {
      operationId: "composite-conflict-1",
      session: fixture.session,
      expected: plan.token,
      planId: fixture.planId,
      operation: { kind: "residual-add", entries: [baseInput({ occurrenceKey: "conflict-1" })] },
    });
    const before = await issueFacts(fixture.context);
    const beforeExecution = await executionFacts(fixture.context);

    const refused = await refusalOf(() =>
      mutateExecutionPlan(context, {
        operationId: "composite-conflict-1",
        session: fixture.session,
        expected: plan.token,
        planId: fixture.planId,
        operation: { kind: "residual-add", entries: [baseInput({ occurrenceKey: "conflict-2" })] },
      }),
    );
    expect(refused.code).toBe("execution.operation-conflict");
    expect(await issueFacts(fixture.context)).toEqual(before);
    expect(await executionFacts(fixture.context)).toEqual(beforeExecution);
  });

  test("a concurrent same-id attempt applies the effect exactly once", async () => {
    const fixture = await executionPlanFixture("composite-concurrent");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const request = {
      operationId: "composite-concurrent-1",
      session: fixture.session,
      expected: plan.token,
      planId: fixture.planId,
      operation: { kind: "residual-add" as const, entries: [baseInput({ occurrenceKey: "concurrent-1" })] },
    };
    const [first, second] = await Promise.all([mutateExecutionPlan(context, request), mutateExecutionPlan(context, request)]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.token).toBe(second.token);

    const after = await issueFacts(fixture.context);
    expect(after.issues).toBe(1);
    expect(after.occurrences).toBe(1);
    expect(after.composite).toBe(1);
    expect((await listIssues(fixture.context, {})).total).toBe(1);
  });

  test("an unavailable collaboration authority refuses before any reservation and never reports success", async () => {
    const fixture = await executionPlanFixture("composite-unavailable", { collaboration: "staged" });
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const beforeExecution = await executionFacts(fixture.context);

    const refused = await refusalOf(() =>
      mutateExecutionPlan(context, {
        operationId: "composite-unavailable-1",
        session: fixture.session,
        expected: plan.token,
        planId: fixture.planId,
        operation: { kind: "residual-add", entries: [baseInput({ occurrenceKey: "unavailable-1" })] },
      }),
    );
    expect(refused.code).toBe("collaboration.not-active");
    expect(await executionFacts(fixture.context)).toEqual(beforeExecution);
    expect(parseExecutionToken((await readExecutionPlan(context, fixture.session, fixture.planId)).token).revision).toBe(
      parseExecutionToken(plan.token).revision,
    );
  });

  test("a wrong collaboration binding refuses before the effect runs", async () => {
    const fixture = await executionPlanFixture("composite-binding");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const state = await readExecutionState(context);
    const intent: CompositeIntent = {
      key: { executionStoreId: state.storeId, executionEpoch: state.epoch, operationId: "composite-binding-1" },
      kind: "residual-add",
      requestHash: "forged-fingerprint",
      target: { repoKey: "github/acme/other", mode: "local", storeId: "00000000-0000-4000-8000-000000000000", epoch: 1 },
      scope: { workflowId: fixture.workflowId, planId: fixture.planId },
      actor: ACTOR,
      expectedExecution: state.token,
      frozenPayload: "{}",
    };
    const refused = await refusalOf(() =>
      runCollaborationComposite(context, intent, {
        apply: () => "never applied",
        finalize: () => "never finalized",
      }),
    );
    expect(refused.code).toBe("collaboration.stale-binding");
    expect(await issueFacts(fixture.context)).toMatchObject({ issues: 0, composite: 0 });
  });

  test("a deterministic refusal inside the effect releases the reservation so the corrected retry is admitted", async () => {
    const fixture = await executionPlanFixture("composite-deterministic");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    // An issue that is NOT linked to this plan: closing it refuses scope.
    const outsider = await captureIssue(fixture.context, baseInput({ occurrenceKey: "outsider" }), {
      operationId: "seed-outsider",
      actor: ACTOR,
    });
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const before = await issueFacts(fixture.context);
    const closeRequest = {
      operationId: "composite-close-1",
      session: fixture.session,
      expected: plan.token,
      planId: fixture.planId,
      operation: {
        kind: "residual-close" as const,
        issueId: outsider.issueId,
        disposition: "resolved" as const,
        expectedIssueRevision: outsider.revision,
        evidence: resolvedEvidence,
      },
    };

    const refused = await refusalOf(() => mutateExecutionPlan(context, closeRequest));
    expect(refused.code).toBe("issue.scope-refused");
    expect(await issueFacts(fixture.context)).toEqual(before);

    // The same operation id is reusable because nothing was applied: the caller
    // corrected the payload (the finding is now linked to this plan) and the
    // reservation was released with the refusal, exactly as the one-transaction
    // route behaved.
    const linked = await mutateExecutionPlan(context, {
      operationId: "composite-add-linked",
      session: fixture.session,
      expected: plan.token,
      planId: fixture.planId,
      operation: { kind: "residual-add", entries: [baseInput({ occurrenceKey: "linked-close" })] },
    });
    const refreshed = await getIssue(fixture.context, outsider.issueId);
    expect(refreshed.provenance.some((entry) => entry.kind === "plan" && entry.target === fixture.planId)).toBe(true);
    const closed = await mutateExecutionPlan(context, {
      ...closeRequest,
      expected: linked.token,
      operation: { ...closeRequest.operation, expectedIssueRevision: refreshed.revision },
    });
    expect(closed.replayed).toBe(false);
    expect((await getIssue(fixture.context, outsider.issueId)).disposition).toBe("resolved");
  });
});
