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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertIssueStoreActive,
  captureIssue,
  captureIssueOn,
  closeIssueOn,
  getIssue,
  linkIssueOn,
  listIssues,
  type CaptureInput,
  type ClosureEvidence,
  type IssueError,
} from "./issue.js";
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
  test("a refusal between the capture and its link leaves no issue, occurrence, link or revision", async () => {
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
