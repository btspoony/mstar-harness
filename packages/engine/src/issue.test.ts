/**
 * issue.test.ts — C2 proof: capture identity, occurrences and public reads.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";
import { initializeStore, openStore } from "./store-db.js";
import {
  IssueError,
  appendOccurrence,
  captureIssue,
  computeIdentityKey,
  getIssue,
  listIssues,
  type CaptureInput,
  type MutationContext,
} from "./issue.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-issue-test-"));
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function ctx(name: string) {
  return { harnessDir: mkdtempSync(join(ROOT, name)) };
}

function baseInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    projectId: "proj-a",
    title: "Shared title",
    kind: "bug",
    severity: "high",
    impact: "users see a failure",
    acceptance: "failure no longer reproduces",
    sourceIdentity: "qc/review.md",
    rootCauseKey: "missing-null-check",
    acceptanceKey: "null-guard-present",
    occurrenceKey: "run-1",
    sourceKind: "qc",
    location: "packages/engine/src/store-db.ts:10",
    observedBehavior: "throws on empty path",
    evidence: ["stack: TypeError"],
    discoveredAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function mut(operationId: string, actor = "pm"): MutationContext {
  return { operationId, actor };
}

describe("capture identity", () => {
  test("captureIssue allocates I- plus six-digit id with counter, occurrence, provenance and receipt together", async () => {
    const context = ctx("capture-id-");
    await initializeStore(context).then((h) => h.close());
    const receipt = await captureIssue(context, baseInput(), mut("op-1"));
    expect(receipt.created).toBe(true);
    expect(receipt.issueId).toBe("I-000001");
    expect(receipt.occurrenceId).toBe(1);
    expect(receipt.revision).toBe(1);
    expect(receipt.storeRevision).toBe(1);
    const detail = await getIssue(context, receipt.issueId);
    expect(detail.identityKey).toBe(
      computeIdentityKey("proj-a", "qc/review.md", "missing-null-check", "null-guard-present"),
    );
    expect(detail.occurrences).toHaveLength(1);
    expect(detail.provenance).toHaveLength(1);
    expect(detail.disposition).toBe("open");
  });

  test("two concurrent processes capturing the same identity create exactly one issue", async () => {
    const context = ctx("capture-concurrent-");
    await initializeStore(context).then((h) => h.close());
    const worker = join(ROOT, "capture-worker.mjs");
    writeFileSync(
      worker,
      `
import { captureIssue } from ${JSON.stringify(join(SRC_DIR, "issue.ts"))};
const context = { harnessDir: process.argv[2] };
const occurrenceKey = process.argv[3];
const operationId = process.argv[4];
const input = {
  projectId: "proj-a",
  title: "Shared title",
  kind: "bug",
  severity: "high",
  impact: "users see a failure",
  acceptance: "failure no longer reproduces",
  sourceIdentity: "qc/review.md",
  rootCauseKey: "missing-null-check",
  acceptanceKey: "null-guard-present",
  occurrenceKey,
  sourceKind: "qc",
  location: "packages/engine/src/store-db.ts:10",
  observedBehavior: "throws on empty path",
  evidence: ["stack: TypeError"],
  discoveredAt: "2026-09-18T10:00:00.000Z",
};
const receipt = await captureIssue(context, input, { operationId, actor: "pm" });
process.stdout.write(JSON.stringify(receipt));
`,
    );
    const run = (occurrenceKey: string, operationId: string) =>
      new Promise<{ status: number | null }>((resolve) => {
        const child = spawn("bun", [worker, context.harnessDir, occurrenceKey, operationId]);
        child.on("close", (status) => resolve({ status }));
      });
    const [a, b] = await Promise.all([run("run-a", "op-a"), run("run-b", "op-b")]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const page = await listIssues(context, {});
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe("I-000001");
    const detail = await getIssue(context, "I-000001");
    expect(detail.occurrences).toHaveLength(2);
  });

  test("two overlapping child processes capturing the same identity still create one issue", async () => {
    const context = ctx("capture-overlap-");
    await initializeStore(context).then((h) => h.close());
    const worker = join(ROOT, "capture-overlap.mjs");
    writeFileSync(
      worker,
      `
import { captureIssue } from ${JSON.stringify(join(SRC_DIR, "issue.ts"))};
const context = { harnessDir: process.argv[2] };
const occurrenceKey = process.argv[3];
const operationId = process.argv[4];
const input = {
  projectId: "proj-a",
  title: "Shared title",
  kind: "bug",
  severity: "high",
  impact: "users see a failure",
  acceptance: "failure no longer reproduces",
  sourceIdentity: "qc/review.md",
  rootCauseKey: "missing-null-check",
  acceptanceKey: "null-guard-present",
  occurrenceKey,
  sourceKind: "qc",
  location: "loc",
  observedBehavior: "obs",
  evidence: [],
  discoveredAt: "2026-09-18T10:00:00.000Z",
};
const receipt = await captureIssue(context, input, { operationId, actor: "pm" });
process.stdout.write(JSON.stringify(receipt));
`,
    );
    const left = spawnSync("bun", [worker, context.harnessDir, "occ-1", "op-1"], { encoding: "utf8" });
    const right = spawnSync("bun", [worker, context.harnessDir, "occ-2", "op-2"], { encoding: "utf8" });
    expect(left.status).toBe(0);
    expect(right.status).toBe(0);
    const page = await listIssues(context, {});
    expect(page.total).toBe(1);
  });

  test("distinct root causes sharing a title remain distinct issues", async () => {
    const context = ctx("capture-title-");
    await initializeStore(context).then((h) => h.close());
    const a = await captureIssue(context, baseInput({ rootCauseKey: "cause-a", occurrenceKey: "o1" }), mut("t1"));
    const b = await captureIssue(context, baseInput({ rootCauseKey: "cause-b", occurrenceKey: "o2" }), mut("t2"));
    expect(a.issueId).not.toBe(b.issueId);
    expect(a.created && b.created).toBe(true);
    const page = await listIssues(context, {});
    expect(page.total).toBe(2);
  });

  test("unknown semantic identity returns triage ambiguity rather than a guessed dedup", async () => {
    const context = ctx("capture-ambiguous-");
    await initializeStore(context).then((h) => h.close());
    await expect(captureIssue(context, baseInput({ rootCauseKey: "unknown" }), mut("amb"))).rejects.toMatchObject({
      code: "issue.ambiguous-identity",
    });
    await expect(captureIssue(context, baseInput({ acceptanceKey: "?" }), mut("amb2"))).rejects.toMatchObject({
      code: "issue.ambiguous-identity",
    });
    const page = await listIssues(context, {});
    expect(page.total).toBe(0);
  });

  test("reopening the DB retains captured data", async () => {
    const context = ctx("capture-reopen-");
    await initializeStore(context).then((h) => h.close());
    const receipt = await captureIssue(context, baseInput(), mut("reopen-1"));
    const again = await openStore(context, "read");
    again.close();
    const detail = await getIssue(context, receipt.issueId);
    expect(detail.title).toBe("Shared title");
    expect(detail.occurrences[0]?.occurrenceKey).toBe("run-1");
  });
});

describe("occurrence replay and recurrence", () => {
  test("distinct sightings append evidence without altering disposition", async () => {
    const context = ctx("occurrence-append-");
    await initializeStore(context).then((h) => h.close());
    const first = await captureIssue(context, baseInput(), mut("occ-1"));
    const handle = await openStore(context, "write");
    handle.db.prepare("update issues set disposition = 'resolved' where id = ?").run(first.issueId);
    handle.close();
    const second = await captureIssue(
      context,
      baseInput({ occurrenceKey: "run-2", discoveredAt: "2026-09-18T11:00:00.000Z" }),
      mut("occ-2"),
    );
    expect(second.created).toBe(false);
    expect(second.issueId).toBe(first.issueId);
    const detail = await getIssue(context, first.issueId);
    expect(detail.disposition).toBe("resolved");
    expect(detail.occurrences).toHaveLength(2);
  });

  test("exact replay returns the existing occurrence and receipt", async () => {
    const context = ctx("occurrence-replay-");
    await initializeStore(context).then((h) => h.close());
    const first = await captureIssue(context, baseInput(), mut("replay-1"));
    const replay = await captureIssue(context, baseInput(), mut("replay-1"));
    expect(replay).toEqual(first);
    const viaAppend = await appendOccurrence(
      context,
      first.issueId,
      {
        sourceIdentity: "qc/review.md",
        rootCauseKey: "missing-null-check",
        acceptanceKey: "null-guard-present",
        occurrenceKey: "run-1",
        sourceKind: "qc",
        location: "packages/engine/src/store-db.ts:10",
        observedBehavior: "throws on empty path",
        evidence: ["stack: TypeError"],
        discoveredAt: "2026-09-18T10:00:00.000Z",
      },
      mut("replay-append"),
    );
    expect(viaAppend.occurrenceId).toBe(first.occurrenceId);
    expect(viaAppend.created).toBe(false);
    const detail = await getIssue(context, first.issueId);
    expect(detail.occurrences).toHaveLength(1);
  });
});

describe("query order and literal search", () => {
  test("listIssues query default order ranks severity then last real activity; null historical activity sorts last", async () => {
    const context = ctx("query-order-");
    const handle = await initializeStore(context);
    const now = "2026-09-18T12:00:00.000Z";
    handle.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, created_at, updated_at, revision, identity_key) values (?, 'p', 'null-activity', 'bug', 'high', 'open', 'i', 'a', null, ?, ?, 1, 'k-null')",
      )
      .run("I-000010", now, now);
    handle.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, created_at, updated_at, revision, identity_key) values (?, 'p', 'older-high', 'bug', 'high', 'open', 'i', 'a', ?, ?, ?, 1, 'k-old')",
      )
      .run("I-000011", "2026-09-01T00:00:00.000Z", now, now);
    handle.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, created_at, updated_at, revision, identity_key) values (?, 'p', 'newer-medium', 'bug', 'medium', 'open', 'i', 'a', ?, ?, ?, 1, 'k-med')",
      )
      .run("I-000012", "2026-09-18T00:00:00.000Z", now, now);
    handle.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, created_at, updated_at, revision, identity_key) values (?, 'p', 'critical-old', 'bug', 'critical', 'open', 'i', 'a', ?, ?, ?, 1, 'k-crit')",
      )
      .run("I-000013", "2026-08-01T00:00:00.000Z", now, now);
    handle.close();
    const page = await listIssues(context, {});
    expect(page.items.map((item) => item.id)).toEqual(["I-000013", "I-000011", "I-000010", "I-000012"]);
    expect(page.items[2]?.lastActivity).toBeNull();
  });

  test("query treats a literal wildcard as text, not SQL", async () => {
    const context = ctx("query-wildcard-");
    await initializeStore(context).then((h) => h.close());
    await captureIssue(context, baseInput({ title: "plain finding", occurrenceKey: "w1" }), mut("q1"));
    await captureIssue(
      context,
      baseInput({
        title: "100% complete",
        rootCauseKey: "other-cause",
        occurrenceKey: "w2",
        observedBehavior: "uses _underscore_",
      }),
      mut("q2"),
    );
    const percent = await listIssues(context, { query: "%" });
    expect(percent.total).toBe(1);
    expect(percent.items[0]?.title).toBe("100% complete");
    const underscore = await listIssues(context, { query: "_underscore_" });
    expect(underscore.total).toBe(1);
    const likeAll = await listIssues(context, { query: "%" });
    expect(likeAll.total).not.toBe(2);
  });
});

describe("failed capture leaves no partial finding", () => {
  test("capture refuses blank title without allocating an id", async () => {
    const context = ctx("capture-partial-");
    await initializeStore(context).then((h) => h.close());
    await expect(captureIssue(context, baseInput({ title: "  " }), mut("bad"))).rejects.toBeInstanceOf(IssueError);
    const page = await listIssues(context, { disposition: "open" });
    expect(page.total).toBe(0);
  });
});
