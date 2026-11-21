/**
 * issue-execution-atomicity — the handle-taking issue bodies and the composite
 * reservation frame that composes them across the two authorities.
 *
 * Run with
 * `bun test packages/engine/src/issue-execution-atomicity.test.ts -t 'collaboration composite residual'`.
 *
 * The combined store is gone: issue rows live in the collaboration lane, plan
 * rows and operation receipts in the execution lane. The composer cases below
 * drive the SAME bodies the public issue verbs run, on a handle the CALLER owns,
 * to prove each body is atomic inside one transaction. The composite cases drive
 * the admitted residual verbs and the frame's crash/interleaving boundaries,
 * where a durable reservation excludes conflicting execution writers and a
 * committed collaboration effect is resumed instead of applied twice.
 *
 * Every fixture is its own temporary control root AND its own user home: the
 * `homedir` spy below is a real spy on the live module binding, every resolved
 * collaboration database is asserted to live inside the temp root before it is
 * created, and no case reads or writes this checkout's `store.db` or the
 * operator's real `~/.mstar`.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeOs from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompletionEvidence } from "./coordination-write.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import {
  initializeCollaborationStore,
  openCollaborationStore,
  readCollaborationAuthority,
  withCollaborationWrite,
  type CollaborationStamp,
} from "./collaboration-store.js";
import {
  repairCompositeAcknowledgement,
  reserveCompositeIntent,
  runCollaborationComposite,
  type CompositeIntent,
} from "./collaboration-operations.js";
import {
  assertIssueStoreActive,
  captureIssue,
  captureIssueOn,
  closeIssue,
  closeIssueOn,
  getIssue,
  linkIssueOn,
  linkIssueScoped,
  reopenIssue,
  reopenIssueOn,
  listIssues,
  type CaptureInput,
  type ClosureEvidence,
} from "./issue.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  parseExecutionToken,
  readExecutionPlan,
  readExecutionState,
  withExecutionTransaction,
  type ExecutionCaller,
  type ExecutionContext,
  type ExecutionPlanView,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionToken,
} from "./execution-store.js";
import {
  completeExecutionPlan,
  deriveResidualEntries,
  mutateExecutionPlan,
  prepareExecutionPlan,
  progressExecutionPlan,
  setCompleteWitnessGapForTest,
} from "./execution-coordination.js";
import { resolveSddDir } from "./path.js";
import { registerCatalogEntity } from "./catalog.js";
import type { CatalogExecutionPin } from "./coordination.js";
import { readExecutionCatalogPin } from "./coordination.js";
import { mutateExecutionWorkflow } from "./execution-workflow.js";
import type { WorkflowSnapshot } from "./workflow.js";
import type { WorkflowEntry } from "./status.js";
import { initializeStore, openStore, type StoreContext, type StoreDb } from "./store-db.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-atomicity-")));
const HOME = join(ROOT, "home");
mkdirSync(HOME);

/**
 * The collaboration store is user-level, so `homedir` must resolve into this
 * fixture and never to the operator's real home. This is the same live-binding
 * spy the issue suite uses; the resolved database path is asserted below before
 * anything is created.
 */
let homeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

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

/**
 * The fixture's collaboration location, refused loudly if the resolver escaped
 * the temporary home. This is the isolation guarantee: a broken `homedir` spy
 * fails the case instead of creating a database in the operator's storage.
 */
function collaborationLocation(context: StoreContext) {
  const location = resolveCollaborationLocation(context);
  if (!location.dbPath.startsWith(`${ROOT}${sep}`)) {
    throw new Error(`fixture: resolved collaboration store ${location.dbPath} is outside the temporary root ${ROOT}`);
  }
  return location;
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
  await initializeCollaborationStore(collaborationLocation(fixture.context));
  activate(collaborationLocation(fixture.context).dbPath);
  return fixture.context;
}

async function executionPlanFixture(
  name: string,
  options: { collaboration?: "active" | "staged"; plans?: readonly string[] } = {},
): Promise<{
  context: StoreContext;
  workflowId: string;
  planId: string;
  planIds: readonly string[];
  caller: ExecutionCaller;
  session: ExecutionSessionRef;
}> {
  const fixture = checkout(name);
  const { root: repoRoot, harnessDir } = fixture;
  const context: StoreContext = fixture.context;
  (await initializeStore(context)).close();
  await initializeCollaborationStore(collaborationLocation(context));
  if ((options.collaboration ?? "active") === "active") activate(collaborationLocation(context).dbPath);
  const initialized = await readExecutionState(context);
  const workflowId = "wf-issue-batch";
  const planIds = options.plans ?? ["plan-issue-batch"];
  const planId = planIds[0]!;
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
    `plans: [${planIds.join(", ")}]`,
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
      plans: planIds.map((id) => ({
        id,
        title: `Plan ${id}`,
        file: `plans/${id}.md`,
        status: "Todo",
        metadata: { working_branch: "feature/issue-batch" },
      })),
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
  return { context, workflowId, planId, planIds, caller, session: session.data };
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
  const db = new DatabaseSync(collaborationLocation(context).dbPath);
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
  declined: number;
};

function issueFacts(context: StoreContext): Promise<IssueFacts> {
  return withCollaborationWrite(context, (handle) => {
    const db = handle.db;
    const count = (table: string): number => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
    const meta = db.prepare("select revision, catalog_revision from collaboration_meta where id = 1").get() as {
      revision: number;
      catalog_revision: number;
    };
    const operations = db.prepare("select key_space, result_json from collaboration_operations").all() as Array<{
      key_space: string;
      result_json: string;
    }>;
    return {
      revision: meta.revision,
      catalogRevision: meta.catalog_revision,
      issues: count("issues"),
      occurrences: count("occurrences"),
      provenance: count("provenance"),
      transitions: count("issue_transitions"),
      standalone: operations.filter((row) => row.key_space === "standalone").length,
      composite: operations.filter((row) => row.key_space === "composite").length,
      declined: operations.filter((row) => row.result_json.includes('"declined"')).length,
    };
  });
}

/** Everything the execution authority holds about operations, intents and its own counters. */
async function executionFacts(context: StoreContext): Promise<{ storeRevision: number; operations: number; intents: number }> {
  const handle = await openStore(context, "read");
  try {
    const count = (sql: string): number => (handle.db.prepare(sql).get() as { n: number }).n;
    return {
      // The counter every accepted plan operation advances once (the execution
      // frame's own revision is the root/header identity, not a per-operation one).
      storeRevision: (handle.db.prepare("select revision from store_meta where id = 1").get() as { revision: number }).revision,
      operations: count("select count(*) as n from execution_operations"),
      intents: count("select count(*) as n from execution_collaboration_intents"),
    };
  } finally {
    handle.close();
  }
}

/** The phases of every recorded reservation for one operation id. */
async function intentPhases(context: StoreContext, operationId: string): Promise<string[]> {
  const handle = await openStore(context, "read");
  try {
    return (handle.db
      .prepare("select phase from execution_collaboration_intents where operation_id = ? order by created_at")
      .all(operationId) as Array<{ phase: string }>).map((row) => row.phase);
  } finally {
    handle.close();
  }
}

/** One raw execution write, used to simulate a writer outside the composite frame. */
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

/** The frozen collaboration target of the active fixture, as the verb would read it. */
async function collaborationStamp(context: StoreContext): Promise<CollaborationStamp> {
  const handle = await openCollaborationStore(context, "read");
  try {
    return {
      repoKey: handle.authority.repoKey,
      mode: handle.authority.mode,
      storeId: handle.authority.storeId,
      epoch: handle.authority.epoch,
    };
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

function detailsOf(refusal: { details?: unknown }): Record<string, unknown> {
  if (refusal.details === null || typeof refusal.details !== "object") throw new Error("refusal carries no details");
  return refusal.details as Record<string, unknown>;
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
    const dbPath = collaborationLocation(context).dbPath;
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

    // The execution lane advanced its own counter exactly once, holds one
    // committed operation receipt and one CONFIRMED reservation.
    const afterExecution = await executionFacts(fixture.context);
    expect(afterExecution.storeRevision).toBe(beforeExecution.storeRevision + 1);
    expect(afterExecution.operations).toBe(beforeExecution.operations + 1);
    expect(afterExecution.intents).toBe(beforeExecution.intents + 1);
    expect(await intentPhases(fixture.context, "composite-add-1")).toEqual(["confirmed"]);

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

    // The same operation id with the SAME spent token: the recorded receipt is
    // served before the CAS the first attempt already spent.
    const replay = await mutateExecutionPlan(context, request);
    expect(replay.replayed).toBe(true);
    expect(replay.token).toBe(first.token);
    expect(await issueFacts(fixture.context)).toEqual(after);
    expect(await executionFacts(fixture.context)).toEqual(afterExecution);
  });

  test("both crash boundaries resume from the durable reservation without repeating the effect", async () => {
    const fixture = await executionPlanFixture("composite-resumed");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const state = await readExecutionState(context);
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const revision = parseExecutionToken(plan.token).revision;
    const target = await collaborationStamp(fixture.context);
    const synthetic = (operationId: string): CompositeIntent => ({
      key: { executionStoreId: state.storeId, executionEpoch: state.epoch, operationId },
      kind: "residual-add",
      requestHash: `hash-${operationId}`,
      target,
      scope: { workflowId: fixture.workflowId, planId: fixture.planId },
      actor: ACTOR,
      expectedExecution: plan.token,
      frozenPayload: JSON.stringify({ plan: fixture.planId }),
    });

    // Crash BEFORE the effect ran: the reservation is prepared, nothing else.
    const beforeApply = synthetic("composite-before-apply");
    const reserved = await withExecutionTransaction(context, (tx) =>
      reserveCompositeIntent(tx, beforeApply, { revision }),
    );
    expect(reserved).toMatchObject({ outcome: "reserved", reservedRevision: revision });
    let applies = 0;
    const first = await runCollaborationComposite<{ applies: number; revision: number }>(context, beforeApply, {
      apply: () => {
        applies += 1;
        return JSON.stringify({ applied: true });
      },
      finalize: (_tx, receipt) => ({ applies, revision: receipt.collaborationRevision }),
    });
    expect(first.applies).toBe(1);
    expect(await intentPhases(fixture.context, "composite-before-apply")).toEqual(["confirmed"]);

    // Crash AFTER the effect committed but BEFORE the execution delta: the frame
    // reports the committed phase and the reservation stays prepared.
    const afterApply = synthetic("composite-after-apply");
    await withExecutionTransaction(context, (tx) => reserveCompositeIntent(tx, afterApply, { revision }));
    let effectApplications = 0;
    const interrupted = await refusalOf(() =>
      runCollaborationComposite<string>(context, afterApply, {
        apply: () => {
          effectApplications += 1;
          return JSON.stringify({ applied: true });
        },
        finalize: () => {
          throw new Error("simulated process loss");
        },
      }),
    );
    expect(interrupted.code).toBe("collaboration.operation-partial");
    expect(detailsOf(interrupted)).toMatchObject({ phase: "collaboration-confirmed", operation_id: "composite-after-apply" });
    expect(effectApplications).toBe(1);
    expect(await intentPhases(fixture.context, "composite-after-apply")).toEqual(["prepared"]);

    // The same reservation, reissued: the effect receipt is replayed (not applied
    // again) and only the execution delta is committed.
    const resumed = await runCollaborationComposite<string>(context, afterApply, {
      apply: () => {
        effectApplications += 1;
        return JSON.stringify({ applied: true });
      },
      finalize: () => "finalized",
    });
    expect(resumed).toBe("finalized");
    expect(effectApplications).toBe(1);
    expect(await intentPhases(fixture.context, "composite-after-apply")).toEqual(["confirmed"]);
  });

  test("a transient failure keeps the reservation and blocks conflicting writers until it resumes", async () => {
    const fixture = await executionPlanFixture("composite-transient");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const state = await readExecutionState(context);
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const intent: CompositeIntent = {
      key: { executionStoreId: state.storeId, executionEpoch: state.epoch, operationId: "composite-transient-1" },
      kind: "residual-add",
      requestHash: "hash-transient",
      target: await collaborationStamp(fixture.context),
      scope: { workflowId: fixture.workflowId, planId: fixture.planId },
      actor: ACTOR,
      expectedExecution: plan.token,
      frozenPayload: JSON.stringify({ plan: fixture.planId }),
    };
    await withExecutionTransaction(context, (tx) =>
      reserveCompositeIntent(tx, intent, { revision: parseExecutionToken(plan.token).revision }),
    );

    const transient = await refusalOf(() =>
      runCollaborationComposite<string>(context, intent, {
        apply: () => {
          throw Object.assign(new Error("the collaboration store is locked"), { code: "store.busy" });
        },
        finalize: () => "never",
      }),
    );
    expect(transient.code).toBe("collaboration.operation-partial");
    expect(detailsOf(transient)).toMatchObject({ phase: "prepared", operation_id: "composite-transient-1" });
    expect(await intentPhases(fixture.context, "composite-transient-1")).toEqual(["prepared"]);

    // The reservation still excludes the row: a plain plan writer refuses.
    const blocked = await refusalOf(() =>
      progressExecutionPlan(context, {
        operationId: "progress-while-reserved",
        session: fixture.session,
        expected: plan.token,
        planId: fixture.planId,
        operation: { kind: "progress", progress: { status: "InProgress", summary: "blocked", evidence_paths: [] } },
      }),
    );
    expect(blocked.code).toBe("collaboration.operation-partial");
    expect(detailsOf(blocked)).toMatchObject({ phase: "prepared", operation_id: "composite-transient-1" });
    expect(await readExecutionPlan(context, fixture.session, fixture.planId).then((read) => read.token)).toBe(plan.token);

    // Once the transient cause is gone the SAME intent resumes and completes.
    const completed = await runCollaborationComposite<string>(context, intent, {
      apply: () => JSON.stringify({ applied: true }),
      finalize: () => "completed",
    });
    expect(completed).toBe("completed");
    expect(await intentPhases(fixture.context, "composite-transient-1")).toEqual(["confirmed"]);
  });

  test("a reservation is refreshed when the addressed row moves, and released by its completion", async () => {
    const fixture = await executionPlanFixture("composite-refresh");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const state = await readExecutionState(context);
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const revision = parseExecutionToken(plan.token).revision;
    const target = await collaborationStamp(fixture.context);
    const intent: CompositeIntent = {
      key: { executionStoreId: state.storeId, executionEpoch: state.epoch, operationId: "composite-refresh-1" },
      kind: "residual-add",
      requestHash: "hash-refresh",
      target,
      scope: { workflowId: fixture.workflowId, planId: fixture.planId },
      actor: ACTOR,
      expectedExecution: plan.token,
      frozenPayload: JSON.stringify({ plan: fixture.planId }),
    };
    await withExecutionTransaction(context, (tx) => reserveCompositeIntent(tx, intent, { revision }));

    // A second composite on the same row refuses at prepare, naming the pending id.
    const secondComposite = await refusalOf(() =>
      mutateExecutionPlan(context, {
        operationId: "composite-refresh-other",
        session: fixture.session,
        expected: plan.token,
        planId: fixture.planId,
        operation: { kind: "residual-add", entries: [baseInput({ occurrenceKey: "refresh-other" })] },
      }),
    );
    expect(secondComposite.code).toBe("collaboration.operation-partial");
    expect(detailsOf(secondComposite)).toMatchObject({ operation_id: "composite-refresh-1", phase: "prepared" });

    // A writer outside the composite frame moves the row (a bypass). The retry
    // refreshes the reservation instead of stranding the committed effect.
    await inExecutionWrite(fixture.context, (db) => {
      db.prepare("update execution_plans set revision = revision + 1 where workflow_id = ? and plan_id = ?").run(
        fixture.workflowId,
        fixture.planId,
      );
    });
    const moved = parseExecutionToken((await readExecutionPlan(context, fixture.session, fixture.planId)).token).revision;
    const refreshed = await withExecutionTransaction(context, (tx) =>
      reserveCompositeIntent(tx, intent, { revision: moved }),
    );
    expect(refreshed).toMatchObject({ outcome: "resume", reservedRevision: moved });

    // Completion releases the row: a real residual verb then proceeds.
    const completed = await runCollaborationComposite<string>(context, intent, {
      apply: () => JSON.stringify({ applied: true }),
      finalize: () => "completed",
    });
    expect(completed).toBe("completed");
    const accepted = await mutateExecutionPlan(context, {
      operationId: "composite-refresh-real",
      session: fixture.session,
      expected: (await readExecutionPlan(context, fixture.session, fixture.planId)).token,
      planId: fixture.planId,
      operation: { kind: "residual-add", entries: [baseInput({ occurrenceKey: "refresh-real" })] },
    });
    expect(accepted.replayed).toBe(false);
    expect((await listIssues(fixture.context, {})).total).toBe(1);
  });

  test("a failed acknowledgement is repaired by a replay without repeating the effect", async () => {
    const fixture = await executionPlanFixture("composite-ack");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const request = {
      operationId: "composite-ack-1",
      session: fixture.session,
      expected: plan.token,
      planId: fixture.planId,
      operation: { kind: "residual-add" as const, entries: [baseInput({ occurrenceKey: "ack-1" })] },
    };
    await mutateExecutionPlan(context, request);
    const before = await issueFacts(fixture.context);

    const setAcknowledgement = (value: string | null): Promise<void> =>
      withCollaborationWrite(fixture.context, (handle) => {
        const row = handle.db
          .prepare("select result_json from collaboration_operations where key_space = 'composite' and operation_id = ?")
          .get("composite-ack-1") as { result_json: string };
        const parsed = JSON.parse(row.result_json) as { receipt: unknown; acknowledgedAt: string | null };
        parsed.acknowledgedAt = value;
        handle.db
          .prepare("update collaboration_operations set result_json = ? where key_space = 'composite' and operation_id = ?")
          .run(JSON.stringify(parsed), "composite-ack-1");
      });
    const acknowledgement = (): Promise<string | null> =>
      withCollaborationWrite(fixture.context, (handle) => {
        const row = handle.db
          .prepare("select result_json from collaboration_operations where key_space = 'composite' and operation_id = ?")
          .get("composite-ack-1") as { result_json: string };
        return (JSON.parse(row.result_json) as { acknowledgedAt: string | null }).acknowledgedAt;
      });

    // A lost acknowledgement: the effect receipt is durable but unacknowledged.
    await setAcknowledgement(null);
    expect(await acknowledgement()).toBeNull();

    // The direct repair path (used when the caller already knows the key).
    await repairCompositeAcknowledgement(fixture.context, {
      executionStoreId: (await readExecutionState(fixture.context)).storeId,
      executionEpoch: (await readExecutionState(fixture.context)).epoch,
      operationId: "composite-ack-1",
    });
    expect(await acknowledgement()).not.toBeNull();

    // A replay of the same operation repairs it too, without repeating either
    // business effect.
    await setAcknowledgement(null);
    expect(await acknowledgement()).toBeNull();
    const replay = await mutateExecutionPlan(context, request);
    expect(replay.replayed).toBe(true);
    expect(await issueFacts(fixture.context)).toEqual(before);
    expect(await acknowledgement()).not.toBeNull();

    // A repair that genuinely cannot run (the collaboration authority is not
    // available) is disclosed on the committed result, every time it is replayed,
    // instead of being reported as a silent success.
    await setAcknowledgement(null);
    const dbPath = collaborationLocation(fixture.context).dbPath;
    const stage = new DatabaseSync(dbPath);
    try {
      stage.prepare("update collaboration_meta set authority_state = 'staged' where id = 1").run();
    } finally {
      stage.close();
    }
    const warningOf = (receipt: { recovery?: { warnings?: readonly { message: string }[] } }): string =>
      (receipt.recovery?.warnings ?? []).map((warning) => warning.message).join(" | ");
    const operationsBefore = (await executionFacts(fixture.context)).operations;
    const outstanding = await mutateExecutionPlan(context, request);
    expect(outstanding.replayed).toBe(true);
    expect(warningOf(outstanding)).toContain("collaboration acknowledgement pending");
    const repeated = await mutateExecutionPlan(context, request);
    expect(repeated.replayed).toBe(true);
    expect(warningOf(repeated)).toContain("collaboration acknowledgement pending");
    // The business effect did not move while the acknowledgement stayed outstanding.
    expect((await executionFacts(fixture.context)).operations).toBe(operationsBefore);
    const restore = new DatabaseSync(dbPath);
    try {
      restore.prepare("update collaboration_meta set authority_state = 'active' where id = 1").run();
    } finally {
      restore.close();
    }
    const repaired = await mutateExecutionPlan(context, request);
    expect(repaired.replayed).toBe(true);
    expect(warningOf(repaired)).not.toContain("collaboration acknowledgement pending");
    expect(await acknowledgement()).not.toBeNull();
  });

  test("a missing or malformed collaboration receipt discloses an unverifiable acknowledgement", async () => {
    const fixture = await executionPlanFixture("composite-ack-unverifiable");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const request = {
      operationId: "composite-ack-unverifiable-1",
      session: fixture.session,
      expected: plan.token,
      planId: fixture.planId,
      operation: { kind: "residual-add" as const, entries: [baseInput({ occurrenceKey: "ack-unverifiable" })] },
    };
    const accepted = await mutateExecutionPlan(context, request);
    const before = await issueFacts(fixture.context);
    const warningOf = (receipt: { recovery?: { warnings?: readonly { message: string }[] } }): string =>
      (receipt.recovery?.warnings ?? []).map((warning) => warning.message).join(" | ");

    // The execution receipt proves the effect committed; a MISSING collaboration
    // row means the acknowledgement state cannot be verified at all.
    await withCollaborationWrite(fixture.context, (handle) => {
      handle.db
        .prepare(
          "delete from collaboration_operations where key_space = 'composite' and execution_store_id = ? " +
            "and execution_epoch = ? and operation_id = ?",
        )
        .run(accepted.storeId, accepted.epoch, "composite-ack-unverifiable-1");
    });
    const missing = await mutateExecutionPlan(context, request);
    expect(missing.replayed).toBe(true);
    expect(warningOf(missing)).toContain("collaboration acknowledgement unverifiable");
    // Replay cannot reconstruct a missing effect: no same-id repair promise.
    expect(warningOf(missing)).not.toContain("repairs the acknowledgement only");
    expect(warningOf(missing)).toContain("cannot reconstruct the effect");
    const missingAgain = await mutateExecutionPlan(context, request);
    expect(warningOf(missingAgain)).toContain("collaboration acknowledgement unverifiable");
    expect(warningOf(missingAgain)).not.toContain("repairs the acknowledgement only");

    // A MALFORMED receipt is the same class of disclosure, never a silent success.
    await withCollaborationWrite(fixture.context, (handle) => {
      handle.db
        .prepare(
          "insert into collaboration_operations(key_space, operation_id, execution_store_id, execution_epoch, request_hash, " +
            "result_json, collaboration_revision, catalog_revision, committed_at) values ('composite', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("composite-ack-unverifiable-1", accepted.storeId, accepted.epoch, "malformed-hash", "{not-json", 0, 0, new Date().toISOString());
    });
    const malformed = await mutateExecutionPlan(context, request);
    expect(malformed.replayed).toBe(true);
    expect(warningOf(malformed)).toContain("collaboration acknowledgement unverifiable");
    expect(warningOf(malformed)).not.toContain("repairs the acknowledgement only");
    expect(warningOf(malformed)).toContain("cannot reconstruct the effect");
    const malformedAgain = await mutateExecutionPlan(context, request);
    expect(warningOf(malformedAgain)).toContain("collaboration acknowledgement unverifiable");
    expect(warningOf(malformedAgain)).not.toContain("repairs the acknowledgement only");

    // The committed business result never moved while the state was unverifiable.
    expect(await issueFacts(fixture.context)).toMatchObject({
      issues: before.issues,
      occurrences: before.occurrences,
      provenance: before.provenance,
      revision: before.revision,
    });
    expect((await listIssues(fixture.context, {})).total).toBe(1);
  });

  test("a deterministic refusal is declined durably and cannot later apply", async () => {
    const fixture = await executionPlanFixture("composite-declined");
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
    // Nothing applied; the decline is durable on BOTH sides.
    expect(await issueFacts(fixture.context)).toMatchObject({
      issues: before.issues,
      occurrences: before.occurrences,
      provenance: before.provenance,
      transitions: before.transitions,
      composite: before.composite + 1,
      declined: before.declined + 1,
    });
    expect(await intentPhases(fixture.context, "composite-close-1")).toEqual(["declined"]);

    // The identical retry replays the recorded refusal instead of applying it.
    const replayed = await refusalOf(() => mutateExecutionPlan(context, closeRequest));
    expect(replayed.code).toBe("issue.scope-refused");
    expect(detailsOf(replayed)).toMatchObject({ phase: "declined", operation_id: "composite-close-1" });
    expect((await getIssue(fixture.context, outsider.issueId)).disposition).toBe("open");

    // The same id with a different payload is a different intent: refused.
    const reused = await refusalOf(() =>
      mutateExecutionPlan(context, {
        ...closeRequest,
        operation: { ...closeRequest.operation, expectedIssueRevision: outsider.revision + 1 },
      }),
    );
    expect(reused.code).toBe("execution.operation-conflict");
  });

  test("the multi-entry batch rolls back whole and keeps its child-occurrence conflict", async () => {
    const fixture = await executionPlanFixture("composite-child-conflict");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const before = await issueFacts(fixture.context);
    const beforeExecution = await executionFacts(fixture.context);
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const conflictingEntries = [
      baseInput({ occurrenceKey: "batch-shared-event" }),
      baseInput({ occurrenceKey: "batch-shared-event", observedBehavior: "different observation reuses the same event key" }),
    ];
    const callBatch = (operationId: string, entries: CaptureInput[]) =>
      mutateExecutionPlan(context, {
        operationId,
        session: fixture.session,
        expected: plan.token,
        planId: fixture.planId,
        operation: { kind: "residual-add", entries },
      });
    const expectedConflict = {
      entryIndex: 1,
      entryPath: "entries[1].occurrenceKey",
      childOperation: "capture",
      childOperationIdOrigin: "session + plan + entry occurrenceKey",
      causeCode: "store.operation-conflict",
    };
    const firstConflict = await refusalOf(() => callBatch("outer-batch-first", conflictingEntries));
    expect(firstConflict.code).toBe("store.operation-conflict");
    expect(detailsOf(firstConflict)).toMatchObject(expectedConflict);
    // The child ids derive from session + plan + occurrenceKey, so a second
    // batch under a different outer id hits the same conflict.
    const secondConflict = await refusalOf(() => callBatch("outer-batch-second", conflictingEntries));
    expect(secondConflict.code).toBe("store.operation-conflict");
    expect(detailsOf(secondConflict)).toMatchObject(expectedConflict);

    // The whole effect rolled back: no issue, occurrence or plan-link rows, the
    // plan token untouched, and no success receipt.
    const after = await issueFacts(fixture.context);
    expect(after).toMatchObject({
      issues: before.issues,
      occurrences: before.occurrences,
      provenance: before.provenance,
      transitions: before.transitions,
      revision: before.revision,
      // Each refusal left its durable decline; neither left an effect.
      declined: before.declined + 2,
    });
    expect(await readExecutionPlan(context, fixture.session, fixture.planId).then((read) => read.token)).toBe(plan.token);
    const afterExecution = await executionFacts(fixture.context);
    expect(afterExecution.operations).toBe(beforeExecution.operations);

    const corrected = await callBatch("outer-batch-corrected", [
      baseInput({ occurrenceKey: "batch-event-1" }),
      baseInput({ occurrenceKey: "batch-event-2", observedBehavior: "a distinct observation with its own event key" }),
    ]);
    expect(corrected.replayed).toBe(false);
    const issues = await listIssues(fixture.context, {});
    expect(issues.total).toBe(1);
    expect((await getIssue(fixture.context, issues.items[0]!.id)).occurrences.map(({ occurrenceKey }) => occurrenceKey)).toEqual([
      "batch-event-1", "batch-event-2",
    ]);
    expect(await issueFacts(fixture.context)).toMatchObject({
      issues: 1,
      occurrences: 2,
      standalone: before.standalone + 4,
    });
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
    expect(await readExecutionPlan(context, fixture.session, fixture.planId).then((read) => read.token)).toBe(plan.token);
  });

  test("a terminal lifecycle close is withheld while a composite reservation is pending", async () => {
    const fixture = await executionPlanFixture("composite-lifecycle");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const state = await readExecutionState(context);
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const intent: CompositeIntent = {
      key: { executionStoreId: state.storeId, executionEpoch: state.epoch, operationId: "composite-lifecycle" },
      kind: "residual-add",
      requestHash: "hash-lifecycle",
      target: await collaborationStamp(fixture.context),
      scope: { workflowId: fixture.workflowId, planId: fixture.planId },
      actor: ACTOR,
      expectedExecution: plan.token,
      frozenPayload: JSON.stringify({ plan: fixture.planId }),
    };
    await withExecutionTransaction(context, (tx) =>
      reserveCompositeIntent(tx, intent, { revision: parseExecutionToken(plan.token).revision }),
    );

    const close = (operationId: string) => ({
      operationId,
      session: fixture.session,
      operation: { kind: "lifecycle" as const, status: "failed" as const, reason: "operator stopped the lifecycle" },
    });
    const withheld = await refusalOf(() => mutateExecutionWorkflow(context, close("close-while-reserved")));
    expect(withheld.code).toBe("collaboration.operation-partial");
    expect(detailsOf(withheld)).toMatchObject({ operation_id: "composite-lifecycle", phase: "prepared" });
    // The lifecycle and the row are exactly as they were: the reservation still
    // owns the facts it will finalize.
    expect((await readExecutionPlan(context, fixture.session, fixture.planId)).token).toBe(plan.token);

    // Settling the pending operation releases the lifecycle, which then closes.
    const completed = await runCollaborationComposite<string>(context, intent, {
      apply: () => JSON.stringify({ applied: true }),
      finalize: () => "completed",
    });
    expect(completed).toBe("completed");
    const closed = await mutateExecutionWorkflow(context, close("close-after-finalize"));
    expect(closed.replayed).toBe(false);
    const afterClose = await refusalOf(() =>
      mutateExecutionPlan(context, {
        operationId: "post-close-add",
        session: fixture.session,
        expected: plan.token,
        planId: fixture.planId,
        operation: { kind: "residual-add", entries: [baseInput({ occurrenceKey: "post-close" })] },
      }),
    );
    expect(afterClose.code).toBe("coordination.workflow-not-running");
  });

  test("a composite admitted while running still finalizes after the lifecycle ends", async () => {
    const fixture = await executionPlanFixture("composite-after-lifecycle");
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const state = await readExecutionState(context);
    const plan = await readExecutionPlan(context, fixture.session, fixture.planId);
    const intent: CompositeIntent = {
      key: { executionStoreId: state.storeId, executionEpoch: state.epoch, operationId: "composite-after-lifecycle" },
      kind: "residual-add",
      requestHash: "hash-after-lifecycle",
      target: await collaborationStamp(fixture.context),
      scope: { workflowId: fixture.workflowId, planId: fixture.planId },
      actor: ACTOR,
      expectedExecution: plan.token,
      frozenPayload: JSON.stringify({ plan: fixture.planId }),
    };
    await withExecutionTransaction(context, (tx) =>
      reserveCompositeIntent(tx, intent, { revision: parseExecutionToken(plan.token).revision }),
    );
    let applications = 0;
    const interrupted = await refusalOf(() =>
      runCollaborationComposite<string>(context, intent, {
        apply: () => {
          applications += 1;
          return JSON.stringify({ applied: true });
        },
        finalize: () => {
          throw new Error("simulated process loss");
        },
      }),
    );
    expect(interrupted.code).toBe("collaboration.operation-partial");
    expect(applications).toBe(1);

    // A writer outside the lifecycle frame ends the workflow (the supported
    // transitions refuse, so only a bypass can reach this state).
    await inExecutionWrite(fixture.context, (db) => {
      const row = db
        .prepare("select state_json from execution_workflows where workflow_id = ?")
        .get(fixture.workflowId) as { state_json: string };
      const stored = JSON.parse(row.state_json) as Record<string, unknown>;
      stored.status = "failed";
      db.prepare("update execution_workflows set state_json = ? where workflow_id = ?").run(
        JSON.stringify(stored),
        fixture.workflowId,
      );
    });

    // The running gate belongs to admission: an operation admitted while running
    // still commits its execution delta, so the committed effect is never stranded.
    const resumed = await runCollaborationComposite<string>(context, intent, {
      apply: () => {
        applications += 1;
        return JSON.stringify({ applied: true });
      },
      finalize: () => "finalized",
    });
    expect(resumed).toBe("finalized");
    expect(applications).toBe(1);
    expect(await intentPhases(fixture.context, "composite-after-lifecycle")).toEqual(["confirmed"]);
  });

  test("an operation id is reserved across plans and both execution ledgers", async () => {
    const fixture = await executionPlanFixture("composite-namespace", {
      plans: ["plan-issue-batch", "plan-issue-second"],
    });
    const context = { harnessDir: fixture.context.harnessDir, caller: fixture.caller };
    const state = await readExecutionState(context);
    const [planAId, planBId] = fixture.planIds;
    if (planAId === undefined || planBId === undefined) throw new Error("fixture: two plans expected");
    const planA = await readExecutionPlan(context, fixture.session, planAId);
    const planB = await readExecutionPlan(context, fixture.session, planBId);
    const sharedId = "composite-shared-id";
    const intent: CompositeIntent = {
      key: { executionStoreId: state.storeId, executionEpoch: state.epoch, operationId: sharedId },
      kind: "residual-add",
      requestHash: "hash-shared-id",
      target: await collaborationStamp(fixture.context),
      scope: { workflowId: fixture.workflowId, planId: planAId },
      actor: ACTOR,
      expectedExecution: planA.token,
      frozenPayload: JSON.stringify({ plan: planAId }),
    };
    await withExecutionTransaction(context, (tx) =>
      reserveCompositeIntent(tx, intent, { revision: parseExecutionToken(planA.token).revision }),
    );

    // A plain writer on ANOTHER plan reusing the id is refused when it tries to
    // commit the receipt, inside its own transaction, so nothing survives.
    const beforeOperations = (await executionFacts(fixture.context)).operations;
    const stolen = await refusalOf(() =>
      progressExecutionPlan(context, {
        operationId: sharedId,
        session: fixture.session,
        expected: planB.token,
        planId: planBId,
        operation: { kind: "progress", progress: { status: "InProgress", summary: "stolen id", evidence_paths: [] } },
      }),
    );
    expect(stolen.code).toBe("execution.operation-conflict");
    expect(detailsOf(stolen)).toMatchObject({ operation_id: sharedId });
    expect((await readExecutionPlan(context, fixture.session, planBId)).token).toBe(planB.token);
    expect((await executionFacts(fixture.context)).operations).toBe(beforeOperations);

    // A second composite on plan B with the same id is refused by the frozen
    // identity (one operation id, one reservation).
    const secondComposite = await refusalOf(() =>
      mutateExecutionPlan(context, {
        operationId: sharedId,
        session: fixture.session,
        expected: planB.token,
        planId: planBId,
        operation: { kind: "residual-add", entries: [baseInput({ occurrenceKey: "namespace-b" })] },
      }),
    );
    expect(secondComposite.code).toBe("execution.operation-conflict");
    expect((await listIssues(fixture.context, {})).total).toBe(0);

    // The admitted reservation is the only owner: it resumes, finalizes, and then
    // plan B proceeds under its own id.
    const finalized = await runCollaborationComposite<string>(context, intent, {
      apply: () => JSON.stringify({ applied: true }),
      finalize: () => "finalized",
    });
    expect(finalized).toBe("finalized");
    const accepted = await mutateExecutionPlan(context, {
      operationId: "composite-namespace-b",
      session: fixture.session,
      expected: planB.token,
      planId: planBId,
      operation: { kind: "residual-add", entries: [baseInput({ occurrenceKey: "namespace-b-ok" })] },
    });
    expect(accepted.replayed).toBe(false);
    expect((await listIssues(fixture.context, {})).total).toBe(1);
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
    // An unavailable/foreign authority is uncertain work, not a decision about
    // the request: the frame reports the prepared phase with the binding cause.
    expect(refused.code).toBe("collaboration.operation-partial");
    expect(detailsOf(refused)).toMatchObject({ phase: "prepared", cause_code: "collaboration.stale-binding" });
    expect(await issueFacts(fixture.context)).toMatchObject({ issues: 0, composite: 0 });
  });
});

/* ------------------------------------------------------------------------ *
 * Completion findings — the observation is taken before the execution
 * transaction, and its accepted proof is recorded on the completed row
 * ------------------------------------------------------------------------ */

const COMPLETION_PLAN = "plan-findings-completion";
const COMPLETION_WORKFLOW = "wf-findings-completion";
const COMPLETION_TS = "2026-11-21T00:00:00.000Z";

/**
 * A standalone development plan prepared and progressed to `InProgress`, with
 * real QC/acceptance bodies in its plan area. Both lanes are active, so the
 * completion's findings observation has a readable collaboration authority.
 */
async function completionFixture(
  name: string,
  findingsCleanup: "zero-residual" | "allow-residual" = "allow-residual",
): Promise<{
  context: StoreContext;
  planContext: ExecutionContext;
  session: ExecutionSessionRef;
  planId: string;
  worktreePath: string;
  token: () => Promise<ExecutionToken>;
  complete: (operationId: string) => Promise<ExecutionReceipt<ExecutionPlanView>>;
}> {
  const fixture = checkout(name);
  const { root, harnessDir, context } = fixture;
  (await initializeStore(context)).close();
  await initializeCollaborationStore(collaborationLocation(context));
  activate(collaborationLocation(context).dbPath);
  const initialized = await readExecutionState(context);
  const worktreePath = join(root, "wt-completion-findings");
  git(root, ["worktree", "add", "-q", "-b", `feature/${COMPLETION_PLAN}`, worktreePath]);
  writeFileSync(join(worktreePath, "slice.txt"), "reviewed slice\n");
  git(worktreePath, ["add", "-A"]);
  git(worktreePath, ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "commit", "-q", "-m", "feat: slice"]);
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const caller: ExecutionCaller = { sessionId: `coordinator-${name}`, role: "coordinator", workflowId: COMPLETION_WORKFLOW };
  const created = await createExecutionWorkflow({ harnessDir, caller }, {
    entry: { id: COMPLETION_WORKFLOW, type: "plan", started_at: COMPLETION_TS, dir: `workflows/${COMPLETION_WORKFLOW}` } as WorkflowEntry,
    snapshot: {
      schema_version: 1,
      id: COMPLETION_WORKFLOW,
      type: "plan",
      status: "running",
      started_at: COMPLETION_TS,
      updated_at: COMPLETION_TS,
      phase: "phase-2-execute",
      project: "harness",
      delivery_kind: "development",
      branch: { base: "main", source: `feature/${COMPLETION_PLAN}`, target: "main" },
      execution_policy: { plan_parallelism: "serial", worktree_mode: "required" },
      plans: [{ id: COMPLETION_PLAN, title: `Plan ${COMPLETION_PLAN}`, file: `plans/${COMPLETION_PLAN}.md`, status: "Todo" }],
    } as unknown as WorkflowSnapshot,
    expected: initialized.token,
    operationId: `create-${name}`,
  });
  const session = (
    await bindExecutionSession({ harnessDir, caller }, {
      workflowId: COMPLETION_WORKFLOW,
      expected: created.data.workflows[0]!.workflowToken,
      operationId: `bind-${name}`,
    })
  ).data;
  const planContext: ExecutionContext = { ...context, caller };
  const token = async (): Promise<ExecutionToken> =>
    (await readExecutionPlan(planContext, session, COMPLETION_PLAN)).token;
  await prepareExecutionPlan(planContext, {
    operationId: `prepare-${name}`,
    session,
    expected: await token(),
    planId: COMPLETION_PLAN,
    operation: {
      kind: "prepare",
      config: { worktreePath, workingBranch: `feature/${COMPLETION_PLAN}`, findingsCleanup },
    },
  });
  await progressExecutionPlan(planContext, {
    operationId: `progress-${name}`,
    session,
    expected: await token(),
    planId: COMPLETION_PLAN,
    operation: { kind: "progress", progress: { status: "InProgress", summary: "reviewed", evidence_paths: [] } },
  });
  const sddDir = resolveSddDir(harnessDir, COMPLETION_PLAN);
  mkdirSync(sddDir, { recursive: true });
  const bodies = { qc: join(sddDir, "qc1.md"), consolidated: join(sddDir, "qc.md"), acceptance: join(sddDir, "acceptance.md") };
  writeFileSync(bodies.qc, "reviewed QC body\n");
  writeFileSync(bodies.consolidated, "consolidated QC body\n");
  writeFileSync(bodies.acceptance, "acceptance verdict body\n");
  const evidence: CompletionEvidence = {
    source_sha: sourceSha,
    review_base: baseSha,
    review_head: sourceSha,
    qc: { decision: "Approve", reports: [bodies.qc], consolidated: bodies.consolidated },
    acceptance: { gate: "pm-acceptance", decision: "pass", report: bodies.acceptance },
  };
  return {
    context,
    planContext,
    session,
    planId: COMPLETION_PLAN,
    worktreePath,
    token,
    complete: async (operationId: string) =>
      completeExecutionPlan(planContext, {
        operationId,
        session,
        expected: await token(),
        planId: COMPLETION_PLAN,
        operation: { kind: "complete", evidence },
      }),
  };
}

describe("collaboration findings observation \u2014 completion evidence", () => {
  test("collaboration findings observation: an open critical refuses completion and leaves the row unchanged", async () => {
    const fixture = await completionFixture("completion-findings-open");
    const issue = await captureIssue(fixture.context, baseInput({ severity: "critical", occurrenceKey: "completion-critical" }), {
      operationId: "cap-completion-critical",
      actor: ACTOR,
    });
    await linkIssueScoped(fixture.context, issue.issueId, { kind: "plan", target: fixture.planId }, {
      operationId: "link-completion-critical",
      actor: ACTOR,
      expectedRevision: issue.revision,
    });

    const refusal = await refusalOf(() => fixture.complete("complete-findings-open"));
    expect(refusal.code).toBe("coordination.findings-open");
    expect(detailsOf(refusal).findings).toEqual([issue.issueId]);
    expect(detailsOf(refusal).findings_cleanup).toBe("allow-residual");
    expect((await readExecutionPlan(fixture.planContext, fixture.session, fixture.planId)).data.plan.status).toBe("InProgress");
  });

  test("collaboration findings observation: a findings change in the proof gap refuses as stale", async () => {
    const fixture = await completionFixture("completion-findings-stale");
    let seamRan = false;
    // The seam runs after the observation and before the execution transaction:
    // another collaboration write advances the lane revision in that gap.
    setCompleteWitnessGapForTest(() => {
      seamRan = true;
      const db = new DatabaseSync(collaborationLocation(fixture.context).dbPath);
      try {
        db.prepare("update collaboration_meta set revision = revision + 1 where id = 1").run();
      } finally {
        db.close();
      }
    });
    try {
      const refusal = await refusalOf(() => fixture.complete("complete-findings-stale"));
      expect(seamRan).toBe(true);
      expect(refusal.code).toBe("coordination.version-conflict");
    } finally {
      setCompleteWitnessGapForTest(undefined);
    }
    expect((await readExecutionPlan(fixture.planContext, fixture.session, fixture.planId)).data.plan.status).toBe("InProgress");
  });

  test("collaboration findings observation: a legitimate completion records the accepted observation", async () => {
    const fixture = await completionFixture("completion-findings-recorded");
    const receipt = await fixture.complete("complete-findings-recorded");
    expect(receipt.data.plan.status).toBe("Done");

    const metadata = receipt.data.plan.metadata as Record<string, unknown>;
    const recorded = metadata.completion_findings as Record<string, unknown>;
    expect(recorded.scope).toEqual({ kind: "plan", key: fixture.planId });
    expect(recorded.completeness).toBe("complete");
    expect(recorded.mode).toBe("allow-residual");
    expect(recorded.open).toEqual([]);
    expect(recorded.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isInteger(recorded.revision)).toBe(true);
    expect(Number.isInteger(recorded.catalogRevision)).toBe(true);
    expect((recorded.authority as Record<string, unknown>).storeId).toBe(
      (await readCollaborationAuthority(fixture.context)).storeId,
    );
  });

  test("collaboration findings observation: zero-residual blocks an open medium and passes once it is legitimately zero", async () => {
    const fixture = await completionFixture("completion-findings-zero", "zero-residual");
    const issue = await captureIssue(fixture.context, baseInput({ occurrenceKey: "completion-zero" }), {
      operationId: "cap-completion-zero",
      actor: ACTOR,
    });
    await linkIssueScoped(fixture.context, issue.issueId, { kind: "plan", target: fixture.planId }, {
      operationId: "link-completion-zero",
      actor: ACTOR,
      expectedRevision: issue.revision,
    });

    const refusal = await refusalOf(() => fixture.complete("complete-findings-zero-open"));
    expect(refusal.code).toBe("coordination.findings-open");
    expect(detailsOf(refusal).findings_cleanup).toBe("zero-residual");
    expect(detailsOf(refusal).findings).toEqual([issue.issueId]);

    // A disposition is a separate authorized act; once it is closed the plan's
    // own scope is a legitimate zero and completion records that observation.
    await withCollaborationWrite(fixture.context, (handle) => {
      handle.db.prepare("update issues set disposition = 'resolved' where id = ?").run(issue.issueId);
      handle.db.prepare("update collaboration_meta set revision = revision + 1 where id = 1").run();
    });
    const receipt = await fixture.complete("complete-findings-zero-closed");
    expect(receipt.data.plan.status).toBe("Done");
    const metadata = receipt.data.plan.metadata as Record<string, unknown>;
    expect((metadata.completion_findings as Record<string, unknown>).mode).toBe("zero-residual");
  });
});

/* ------------------------------------------------------------------------ *
 * Catalog pin source in prepare — verified lineage, missing identity and
 * receipt-first replay
 * ------------------------------------------------------------------------ */

/** The completion fixture's sealed execution input and its recorded pin bytes. */
async function sealedPinFacts(context: StoreContext): Promise<{ inputHash: string; pinJson: string | null }> {
  const handle = await openStore(context, "read");
  try {
    const row = handle.db
      .prepare("select input_hash, catalog_pin_json from execution_inputs where workflow_id = ? and plan_id = ?")
      .get(COMPLETION_WORKFLOW, COMPLETION_PLAN) as { input_hash?: unknown; catalog_pin_json?: unknown } | undefined;
    if (row === undefined || typeof row.input_hash !== "string") {
      throw new Error("fixture: the completion plan has no sealed execution input");
    }
    return {
      inputHash: row.input_hash,
      pinJson: typeof row.catalog_pin_json === "string" ? row.catalog_pin_json : null,
    };
  } finally {
    handle.close();
  }
}

/** Write a pin into the sealed input exactly as a prior prepare would have. */
async function seedSealedPin(context: StoreContext, pin: CatalogExecutionPin): Promise<void> {
  await inExecutionWrite(context, (db) => {
    db.prepare("update execution_inputs set catalog_pin_json = ? where workflow_id = ? and plan_id = ?").run(
      JSON.stringify(pin),
      COMPLETION_WORKFLOW,
      COMPLETION_PLAN,
    );
  });
}

/** Record the verified cutover publication that proves this migration target. */
async function recordActiveCutover(context: StoreContext, sourceStoreId: string): Promise<void> {
  const authority = await readCollaborationAuthority(context);
  await withCollaborationWrite(context, (handle) => {
    handle.db
      .prepare(
        "insert into cutover_publications(manifest_id, phase, source_store_id, source_epoch, source_schema_version, " +
          "source_revision, source_catalog_revision, manifest_digest, target_store_id, target_epoch, verified_at, activated_at) " +
          "values (?, 'active', ?, 1, 21, 0, 0, ?, ?, ?, ?, ?)",
      )
      .run(
        `manifest-${sourceStoreId}`,
        sourceStoreId,
        "0".repeat(64),
        authority.storeId,
        authority.epoch,
        COMPLETION_TS,
        COMPLETION_TS,
      );
  });
}

/** The prepare config the fixture itself used (plus a different findings mode). */
function preparePins(fixture: { worktreePath: string }) {
  return {
    worktreePath: fixture.worktreePath,
    workingBranch: `feature/${COMPLETION_PLAN}`,
    findingsCleanup: "zero-residual" as const,
  };
}

describe("catalog pin \u2014 prepare source lineage and replay", () => {
  test("catalog pin: a historical pin cannot rebind onto an unrelated active catalog", async () => {
    const fixture = await completionFixture("pin-lineage-unproven");
    const execution = await readExecutionState(fixture.context);
    const sealed = await sealedPinFacts(fixture.context);
    const historical: CatalogExecutionPin = {
      store_id: execution.storeId,
      entity_revision: 1,
      document_hash: sealed.inputHash,
      relation_hash: "0".repeat(64),
    };
    await seedSealedPin(fixture.context, historical);

    const refusal = await refusalOf(async () =>
      prepareExecutionPlan(fixture.planContext, {
        operationId: "prepare-lineage-unproven",
        session: fixture.session,
        expected: await fixture.token(),
        planId: fixture.planId,
        operation: { kind: "prepare", config: preparePins(fixture) },
      }),
    );
    expect(refusal.code).toBe("catalog.execution-pin-conflict");
    expect(detailsOf(refusal).verified_source_stores).toEqual([]);
    expect((await sealedPinFacts(fixture.context)).pinJson).toBe(JSON.stringify(historical));
  });

  test("catalog pin: a verified migration publication proves the historical source", async () => {
    const fixture = await completionFixture("pin-lineage-verified");
    const execution = await readExecutionState(fixture.context);
    const authority = await readCollaborationAuthority(fixture.context);
    const sealed = await sealedPinFacts(fixture.context);
    const historical: CatalogExecutionPin = {
      store_id: execution.storeId,
      entity_revision: 1,
      document_hash: sealed.inputHash,
      relation_hash: "0".repeat(64),
    };
    await seedSealedPin(fixture.context, historical);
    await registerCatalogEntity(
      fixture.context,
      {
        kind: "plan",
        id: fixture.planId,
        title: `Plan ${fixture.planId}`,
        rootKind: "plans",
        relativePath: `plans/${fixture.planId}.md`,
      },
      { operationId: "register-lineage-verified", actor: ACTOR },
    );
    await recordActiveCutover(fixture.context, execution.storeId);

    const prepared = await prepareExecutionPlan(fixture.planContext, {
      operationId: "prepare-lineage-verified",
      session: fixture.session,
      expected: await fixture.token(),
      planId: fixture.planId,
      operation: { kind: "prepare", config: preparePins(fixture) },
    });
    expect(prepared.replayed).toBe(false);
    const stored = JSON.parse((await sealedPinFacts(fixture.context)).pinJson!) as CatalogExecutionPin;
    expect(stored.store_id).toBe(authority.storeId);
    expect(stored.entity_revision).toBe(1);
  });

  test("catalog pin: an active catalog missing the pinned plan refuses instead of clearing the pin", async () => {
    const fixture = await completionFixture("pin-missing-entity");
    const authority = await readCollaborationAuthority(fixture.context);
    const sealed = await sealedPinFacts(fixture.context);
    const pinned: CatalogExecutionPin = {
      store_id: authority.storeId,
      entity_revision: 1,
      document_hash: sealed.inputHash,
      relation_hash: "0".repeat(64),
    };
    await seedSealedPin(fixture.context, pinned);

    const refusal = await refusalOf(async () =>
      prepareExecutionPlan(fixture.planContext, {
        operationId: "prepare-missing-entity",
        session: fixture.session,
        expected: await fixture.token(),
        planId: fixture.planId,
        operation: { kind: "prepare", config: preparePins(fixture) },
      }),
    );
    expect(refusal.code).toBe("catalog.execution-pin-conflict");
    expect(detailsOf(refusal).catalog_store_id).toBe(authority.storeId);
    expect((await sealedPinFacts(fixture.context)).pinJson).toBe(JSON.stringify(pinned));

    // Only an explicit registration lets the authorized prepare re-select it.
    await registerCatalogEntity(
      fixture.context,
      {
        kind: "plan",
        id: fixture.planId,
        title: `Plan ${fixture.planId}`,
        rootKind: "plans",
        relativePath: `plans/${fixture.planId}.md`,
      },
      { operationId: "register-missing-entity", actor: ACTOR },
    );
    const prepared = await prepareExecutionPlan(fixture.planContext, {
      operationId: "prepare-missing-entity-registered",
      session: fixture.session,
      expected: await fixture.token(),
      planId: fixture.planId,
      operation: { kind: "prepare", config: preparePins(fixture) },
    });
    expect(prepared.replayed).toBe(false);
    const stored = JSON.parse((await sealedPinFacts(fixture.context)).pinJson!) as CatalogExecutionPin;
    expect(stored.store_id).toBe(authority.storeId);
    expect(stored.entity_revision).toBe(1);
  });

  test("catalog pin: an unchanged prepare under a new operation id still validates historical lineage", async () => {
    const fixture = await completionFixture("pin-unchanged-lineage");
    const execution = await readExecutionState(fixture.context);
    const sealed = await sealedPinFacts(fixture.context);
    const historical: CatalogExecutionPin = {
      store_id: execution.storeId,
      entity_revision: 1,
      document_hash: sealed.inputHash,
      relation_hash: "0".repeat(64),
    };
    await seedSealedPin(fixture.context, historical);

    // The requested config equals the fixture's recorded one, so a naive
    // already-satisfied shortcut would never revisit the pin.
    const refusal = await refusalOf(async () =>
      prepareExecutionPlan(fixture.planContext, {
        operationId: "prepare-unchanged-unproven",
        session: fixture.session,
        expected: await fixture.token(),
        planId: fixture.planId,
        operation: {
          kind: "prepare",
          config: {
            worktreePath: fixture.worktreePath,
            workingBranch: `feature/${COMPLETION_PLAN}`,
            findingsCleanup: "allow-residual",
          },
        },
      }),
    );
    expect(refusal.code).toBe("catalog.execution-pin-conflict");
    expect(detailsOf(refusal).verified_source_stores).toEqual([]);
    expect((await sealedPinFacts(fixture.context)).pinJson).toBe(JSON.stringify(historical));

    // With the verified publication the same unchanged prepare is satisfied and
    // leaves the recorded lineage untouched (no reselect happens).
    await recordActiveCutover(fixture.context, execution.storeId);
    const satisfied = await prepareExecutionPlan(fixture.planContext, {
      operationId: "prepare-unchanged-verified",
      session: fixture.session,
      expected: await fixture.token(),
      planId: fixture.planId,
      operation: {
        kind: "prepare",
        config: {
          worktreePath: fixture.worktreePath,
          workingBranch: `feature/${COMPLETION_PLAN}`,
          findingsCleanup: "allow-residual",
        },
      },
    });
    expect(satisfied.recovery?.outcome).toBe("already-satisfied");
    expect((await sealedPinFacts(fixture.context)).pinJson).toBe(JSON.stringify(historical));
  });

  test("catalog pin: the read path refuses an unproven historical pin and accepts a verified migration", async () => {
    const fixture = await completionFixture("pin-read-lineage");
    const execution = await readExecutionState(fixture.context);
    const sealed = await sealedPinFacts(fixture.context);
    await registerCatalogEntity(
      fixture.context,
      {
        kind: "plan",
        id: fixture.planId,
        title: `Plan ${fixture.planId}`,
        rootKind: "plans",
        relativePath: `plans/${fixture.planId}.md`,
      },
      { operationId: "register-read-lineage", actor: ACTOR },
    );
    const historical: CatalogExecutionPin = {
      store_id: execution.storeId,
      entity_revision: 1,
      document_hash: sealed.inputHash,
      relation_hash: "0".repeat(64),
    };
    const row = {
      id: fixture.planId,
      title: `Plan ${fixture.planId}`,
      file: `plans/${fixture.planId}.md`,
      status: "Todo",
      metadata: { catalog_pin: historical },
    };
    const read = () =>
      readExecutionCatalogPin({
        harnessRoot: fixture.context.harnessDir,
        workflowId: COMPLETION_WORKFLOW,
        planId: fixture.planId,
        row,
      });

    const unproven = await read();
    expect(unproven.source).toBe("row");
    expect(unproven.conflict).not.toBeNull();
    expect(unproven.conflict).toContain("verified migration source");

    await recordActiveCutover(fixture.context, execution.storeId);
    const verified = await read();
    expect(verified.conflict).toBeNull();
    expect(verified.pin).toEqual(historical);
    expect(verified.catalog_moved).toBe(false);
  });

  test("catalog pin: an exact prepare retry replays after the collaboration store becomes unreadable", async () => {
    const fixture = await completionFixture("prepare-replay-unavailable");
    const expected = await fixture.token();
    const config = {
      worktreePath: fixture.worktreePath,
      workingBranch: `feature/${COMPLETION_PLAN}`,
      findingsCleanup: "allow-residual" as const,
    };
    const first = await prepareExecutionPlan(fixture.planContext, {
      operationId: "prepare-replay",
      session: fixture.session,
      expected,
      planId: fixture.planId,
      operation: { kind: "prepare", config },
    });
    expect(first.replayed).toBe(false);

    // The lane is now unreadable: a NEW attempt would refuse, but the exact
    // retry must be served from the execution receipt before any catalog read.
    writeFileSync(collaborationLocation(fixture.context).dbPath, "not a sqlite database\n", "utf8");
    const retry = await prepareExecutionPlan(fixture.planContext, {
      operationId: "prepare-replay",
      session: fixture.session,
      expected,
      planId: fixture.planId,
      operation: { kind: "prepare", config },
    });
    expect(retry.replayed).toBe(true);
    expect({ ...retry, replayed: false }).toEqual(first);
  });
});
