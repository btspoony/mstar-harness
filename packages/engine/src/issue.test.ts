/**
 * issue.test.ts — C2/C3 proof: capture, occurrences, reads, disposition.
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";
import { initializeExecutionAuthority } from "./execution-store.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import {
  assertIssueTriageVocabulary,
  IssueError,
  assertCaptureRequest,
  appendOccurrence,
  captureIssue,
  closeIssue,
  computeIdentityKey,
  getIssue,
  linkIssue,
  listIssues,
  triageIssue,
  type CaptureInput,
  type Disposition,
  type IssueKind,
  type IssueLink,
  type MutationContext,
  type OccurrenceInput,
  type Severity,
} from "./issue.js";
import {
  closeIssue as closeIssueFromIndex,
  linkIssue as linkIssueFromIndex,
  triageIssue as triageIssueFromIndex,
} from "./index.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-issue-test-"));
const SRC_DIR = dirname(fileURLToPath(import.meta.url));


test("triage vocabulary rejects array values instead of coercing them to keys", () => {
  expect(() => assertIssueTriageVocabulary({ kind: ["bug"] } as never)).toThrow(
    expect.objectContaining({ code: "issue.scope-refused" }),
  );
});
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

function mut(operationId: string, actor = "project-manager"): MutationContext {
  return { operationId, actor };
}

/** Observation half of `baseInput`; a recurrence differs only in these fields. */
function occInput(overrides: Partial<OccurrenceInput> = {}): OccurrenceInput {
  return {
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
const receipt = await captureIssue(context, input, { operationId, actor: "project-manager" });
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
const receipt = await captureIssue(context, input, { operationId, actor: "project-manager" });
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

  test("capture request validates all malformed identity and required fields together", () => {
    let failure: unknown;
    try {
      assertCaptureRequest({ title: "only supplied field" } as CaptureInput);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "issue.ambiguous-identity" });
    const message = failure instanceof Error ? failure.message : "";
    for (const field of [
      "projectId", "impact", "acceptance", "kind", "severity", "sourceIdentity", "rootCauseKey", "acceptanceKey",
      "occurrenceKey", "sourceKind", "location", "observedBehavior", "discoveredAt",
    ]) {
      expect(message).toContain(field);
    }
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

  test("a recurrence for a different root cause refuses without appending", async () => {
    const context = ctx("occurrence-identity-");
    await initializeStore(context).then((h) => h.close());
    const created = await captureIssue(context, baseInput(), mut("cap-occ-id"));
    await expect(
      appendOccurrence(context, created.issueId, occInput({ rootCauseKey: "different-root-cause", occurrenceKey: "run-other" }), mut("occ-mismatch")),
    ).rejects.toMatchObject({ code: "issue.ambiguous-identity" });
    await expect(
      appendOccurrence(context, created.issueId, occInput({ sourceIdentity: "other/source.md", occurrenceKey: "run-other" }), mut("occ-mismatch-src")),
    ).rejects.toMatchObject({ code: "issue.ambiguous-identity" });
    const detail = await getIssue(context, created.issueId);
    expect(detail.occurrences).toHaveLength(1);
    expect(detail.revision).toBe(created.revision);
    expect(detail.identityKey).toBe(computeIdentityKey("proj-a", "qc/review.md", "missing-null-check", "null-guard-present"));
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

  test("reusing an occurrence_key under a different identity refuses without a second issue", async () => {
    const context = ctx("occurrence-key-collision-");
    await initializeStore(context).then((h) => h.close());
    const first = await captureIssue(context, baseInput(), mut("col-1"));
    await expect(
      captureIssue(context, baseInput({ rootCauseKey: "other-cause", occurrenceKey: "run-1" }), mut("col-2")),
    ).rejects.toMatchObject({ code: "issue.ambiguous-identity" });
    const page = await listIssues(context, {});
    expect(page.total).toBe(1);
    expect(page.items[0]?.id).toBe(first.issueId);
    const detail = await getIssue(context, first.issueId);
    expect(detail.occurrences).toHaveLength(1);
    expect(detail.occurrences[0]?.occurrenceKey).toBe("run-1");
  });

  test("appendOccurrence with the same key and a different payload refuses and keeps original bytes", async () => {
    const context = ctx("occurrence-payload-conflict-");
    await initializeStore(context).then((h) => h.close());
    const first = await captureIssue(context, baseInput(), mut("pay-1"));
    const before = await getIssue(context, first.issueId);
    const original = before.occurrences[0];
    await expect(
      appendOccurrence(
        context,
        first.issueId,
        {
          sourceIdentity: "qc/review.md",
          rootCauseKey: "missing-null-check",
          acceptanceKey: "null-guard-present",
          occurrenceKey: "run-1",
          sourceKind: "qc",
          location: "packages/engine/src/store-db.ts:10",
          observedBehavior: "different observed failure",
          evidence: ["stack: TypeError"],
          discoveredAt: "2026-09-18T10:00:00.000Z",
        },
        mut("pay-2"),
      ),
    ).rejects.toMatchObject({ code: "issue.occurrence-conflict" });
    const after = await getIssue(context, first.issueId);
    expect(after.occurrences).toHaveLength(1);
    expect(after.occurrences[0]).toEqual(original);
  });

  test("identical replay of capture and append still returns the original receipt", async () => {
    const context = ctx("occurrence-exact-replay-");
    await initializeStore(context).then((h) => h.close());
    const first = await captureIssue(context, baseInput(), mut("exact-1"));
    const captureReplay = await captureIssue(context, baseInput(), mut("exact-2"));
    expect(captureReplay.issueId).toBe(first.issueId);
    expect(captureReplay.occurrenceId).toBe(first.occurrenceId);
    expect(captureReplay.created).toBe(false);
    const appendReplay = await appendOccurrence(
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
      mut("exact-3"),
    );
    expect(appendReplay.occurrenceId).toBe(first.occurrenceId);
    expect(appendReplay.created).toBe(false);
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
  test("required occurrence fields reject missing evidence and blank timestamps", () => {
    const absentEvidence = { ...baseInput(), evidence: undefined } as unknown as CaptureInput;
    expect(() => assertCaptureRequest(absentEvidence)).toThrow("evidence must be an array of strings");
    expect(() => assertCaptureRequest(baseInput({ discoveredAt: " " }))).toThrow("discoveredAt must be nonblank");
  });
});

/* -------------------------------------------------------------------------
 * Workflow-backed fixtures used by provenance and closure behavior tests.
 * Issue write authorization is actor-only and does not consult workflow
 * snapshots or session envelopes.
 * ---------------------------------------------------------------------- */

const LIVE_WORKFLOW_ID = "wf-issue";
const LIVE_PLAN_ID = "20260918-a";
const LIVE_PEER_PLAN_ID = "20260918-b";

type LiveAuthority = {
  harness: string;
  planId: string;
  peerPlanId: string;
};

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}


/** A real workflow snapshot fixture for issue-store behavior tests. */
async function liveAuthority(name: string): Promise<LiveAuthority> {
  const root = realpathSync(mkdtempSync(join(ROOT, name)));
  git(["init", "-q", "-b", "main"], root);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], root);
  const harness = join(root, ".mstar");
  const workflowId = LIVE_WORKFLOW_ID;
  const planIds = [LIVE_PLAN_ID, LIVE_PEER_PLAN_ID];
  const workflowDir = join(harness, "workflows", workflowId);
  mkdirSync(join(harness, "plans"), { recursive: true });
  for (const planId of planIds) {
    writeFileSync(join(harness, "plans", `${planId}.md`), `# ${planId}\n`);
    mkdirSync(join(root, `wt-${planId}`), { recursive: true });
  }
  writeJsonFile(join(harness, "status.json"), {
    version: 2,
    updated_at: "2026-09-18",
    workflows: [
      { id: workflowId, status: "running", type: "iteration", started_at: "2026-09-18T00:00:00Z", dir: `workflows/${workflowId}` },
    ],
  });
  writeJsonFile(join(workflowDir, "snapshot.json"), {
    schema_version: 1,
    id: workflowId,
    type: "iteration",
    status: "running",
    started_at: "2026-09-18T00:00:00Z",
    updated_at: "2026-09-18T00:00:00Z",
    branch: { base: "main" },
    plans: planIds.map((planId) => ({
      id: planId,
      plan_id: planId,
      title: `Plan ${planId}`,
      file: `.mstar/plans/${planId}.md`,
      status: "Todo",
    })),
  });

  await initializeStore({ harnessDir: harness }).then((handle) => handle.close());
  return { harness, planId: LIVE_PLAN_ID, peerPlanId: LIVE_PEER_PLAN_ID };
}

function pmMut(_authority: LiveAuthority, operationId: string, extra: Partial<MutationContext> = {}): MutationContext {
  return { operationId, actor: "project-manager", ...extra };
}


describe("capture actor auditing", () => {
  test("leaf seats cannot capture or append, and the PM seat captures without a plan", async () => {
    const context = ctx("capture-seat-");
    await initializeStore(context).then((h) => h.close());
    for (const actor of ["fullstack-dev", "frontend-dev", "qc-specialist-2", "qa-engineer", "ops-engineer"]) {
      await expect(captureIssue(context, baseInput(), mut("cap-leaf", actor))).rejects.toMatchObject({
        code: "issue.scope-refused",
      });
    }
    const created = await captureIssue(context, baseInput(), mut("cap-pm"));
    expect(created.created).toBe(true);
    await expect(appendOccurrence(context, created.issueId, occInput({ occurrenceKey: "leaf-occ" }), mut("occ-leaf", "qc-specialist"))).rejects.toMatchObject(
      { code: "issue.scope-refused" },
    );
    const page = await listIssues(context, {});
    expect(page.total).toBe(1);
    expect((await getIssue(context, created.issueId)).occurrences).toHaveLength(1);
  });

  test("only the PM actor can mutate; accepted mutations record that actor", async () => {
    const authority = await liveAuthority("authorization-seat-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-seat"));
    const other = await captureIssue(context, baseInput({ occurrenceKey: "seat-b", rootCauseKey: "seat-other" }), mut("cap-seat-b"));
    await expect(
      linkIssue(
        context,
        created.issueId,
        { relation: "related", issueId: other.issueId },
        { operationId: "link-wrong-seat", actor: "qa-engineer", expectedRevision: created.revision },
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(
      triageIssue(
        context,
        created.issueId,
        { severity: "low", reason: "downgrade" },
        { operationId: "triage-inherited", actor: "toString", expectedRevision: created.revision },
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    const after = await getIssue(context, created.issueId);
    expect(after.revision).toBe(created.revision);
    expect(after.severity).toBe("high");
    expect(after.relations).toEqual([]);
    const triaged = await triageIssue(
      context,
      created.issueId,
      { severity: "low", reason: "downgrade" },
      pmMut(authority, "triage-actor-only", { expectedRevision: created.revision }),
    );
    expect(triaged.revision).toBe(created.revision + 1);
  });

  test("inherited Object.prototype keys are refused as kind, severity and disposition", async () => {
    const authority = await liveAuthority("vocabulary-inherited-");
    const context: StoreContext = { harnessDir: authority.harness };
    await expect(
      captureIssue(context, baseInput({ kind: "toString" as IssueKind }), mut("cap-proto-kind")),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(
      captureIssue(context, baseInput({ severity: "constructor" as Severity }), mut("cap-proto-sev")),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    const created = await captureIssue(context, baseInput(), mut("cap-vocab"));
    await expect(
      triageIssue(context, created.issueId, { kind: "hasOwnProperty" as IssueKind, reason: "reclass" }, pmMut(authority, "triage-proto-kind", { expectedRevision: created.revision })),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(listIssues(context, { disposition: "toString" as Disposition })).rejects.toMatchObject({
      code: "issue.scope-refused",
    });
    await expect(listIssues(context, { kind: "valueOf" as IssueKind })).rejects.toMatchObject({ code: "issue.scope-refused" });
    expect((await listIssues(context, {})).total).toBe(1);
    expect((await getIssue(context, created.issueId)).revision).toBe(created.revision);
  });
});

describe("issue dispositions, revisions, and relations", () => {
  test("stale revision leaves issue and history unchanged", async () => {
    const authority = await liveAuthority("revision-stale-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-1"));
    await expect(
      closeIssue(
        context,
        created.issueId,
        "resolved",
        { reason: "fixed", references: ["qa.md"], alignmentRef: "qa gate" },
        pmMut(authority, "close-stale", { expectedRevision: 0 }),
      ),
    ).rejects.toMatchObject({ code: "issue.revision-conflict" });
    const detail = await getIssue(context, created.issueId);
    expect(detail.disposition).toBe("open");
    expect(detail.revision).toBe(created.revision);
    expect(detail.transitions).toEqual([]);
  });

  test("ACTIVE execution authority accepts actor-only issue writes without workflow or sessions", async () => {
    const context = ctx("actor-only-active-");
    await initializeStore(context).then((handle) => handle.close());
    const activated = await initializeExecutionAuthority(context);
    expect(activated.data.workflows).toEqual([]);
    const store = await openStore(context, "read");
    try {
      expect(store.execution?.authorityState).toBe("active");
      expect(store.db.prepare("select count(*) as count from execution_workflows").get()).toEqual({ count: 0 });
      expect(store.db.prepare("select count(*) as count from execution_sessions").get()).toEqual({ count: 0 });
    } finally {
      store.close();
    }

    const resolvedIssue = await captureIssue(context, baseInput(), mut("actor-only-resolved"));
    const resolved = await closeIssue(context, resolvedIssue.issueId, "resolved", {
      reason: "acceptance verified", references: ["qa/run.md"], alignmentRef: "QA gate: Approve",
    }, { operationId: "actor-only-close-resolved", actor: "project-manager", expectedRevision: resolvedIssue.revision });
    expect((await getIssue(context, resolved.issueId)).disposition).toBe("resolved");

    const target = await captureIssue(context, baseInput({ occurrenceKey: "target", rootCauseKey: "target" }), mut("actor-only-target"));
    const issue = await captureIssue(context, baseInput({ occurrenceKey: "triage", rootCauseKey: "triage" }), mut("actor-only-triage-seed"));
    const triaged = await triageIssue(context, issue.issueId, { severity: "medium", reason: "reclassified" }, {
      operationId: "actor-only-triage", actor: "project-manager", expectedRevision: issue.revision,
    });
    const linked = await linkIssue(context, issue.issueId, { kind: "plan", target: "unregistered-plan-label" }, {
      operationId: "actor-only-link", actor: "project-manager", expectedRevision: triaged.revision,
    });
    const superseded = await closeIssue(context, issue.issueId, "superseded", {
      reason: "replaced", references: [], canonicalIssueId: target.issueId,
    }, { operationId: "actor-only-supersede", actor: "project-manager", expectedRevision: linked.revision });

    expect(superseded.revision).toBe(issue.revision + 3);
    const detail = await getIssue(context, issue.issueId);
    expect(detail.disposition).toBe("superseded");
    expect(detail.provenance).toContainEqual(expect.objectContaining({ kind: "plan", target: "unregistered-plan-label" }));
    expect(detail.severity).toBe("medium");
    expect(detail.transitions[0]?.actor).toBe("project-manager");
  });

  test("non-PM actor still cannot write an issue", async () => {
    const context = ctx("actor-only-refusal-");
    await initializeStore(context).then((handle) => handle.close());
    const created = await captureIssue(context, baseInput(), mut("actor-only-seed"));
    await expect(closeIssue(context, created.issueId, "resolved", {
      reason: "looks good", references: ["note"], alignmentRef: "qa gate",
    }, { operationId: "actor-only-leaf", actor: "fullstack-dev", expectedRevision: created.revision }))
      .rejects.toMatchObject({ code: "issue.scope-refused" });
  });

  test("valid closure records the exact evidence", async () => {
    const authority = await liveAuthority("disposition-evidence-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-3"));
    const evidence = {
      reason: "acceptance met in qa-run-9",
      references: ["qa/run-9.md"],
      scope: "proj-a",
      alignmentRef: "QA gate: Approve \u2014 qa/run-9.md",
    };
    const closed = await closeIssue(
      context,
      created.issueId,
      "resolved",
      evidence,
      pmMut(authority, "close-ok", { expectedRevision: created.revision }),
    );
    const detail = await getIssue(context, created.issueId);
    expect(detail.disposition).toBe("resolved");
    expect(detail.closureNote).toBe(evidence.reason);
    expect(detail.revision).toBe(closed.revision);
    expect(detail.transitions).toHaveLength(1);
    expect(detail.transitions[0]?.toDisposition).toBe("resolved");
    expect(detail.transitions[0]?.evidence).toEqual({
      reason: evidence.reason,
      scope: evidence.scope,
      references: evidence.references,
      canonicalIssueId: null,
      alignmentRef: evidence.alignmentRef,
    });
    const replay = await closeIssue(
      context,
      created.issueId,
      "resolved",
      evidence,
      pmMut(authority, "close-ok", { expectedRevision: created.revision }),
    );
    expect(replay).toEqual(closed);
    await expect(
      closeIssue(
        context,
        created.issueId,
        "waived",
        { reason: "won't", references: [], scope: "proj-a", alignmentRef: "user-ok" },
        pmMut(authority, "close-other", { expectedRevision: closed.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.invalid-disposition" });
  });

  test("duplicate and superseded require a canonical issue", async () => {
    const authority = await liveAuthority("disposition-canonical-");
    const context: StoreContext = { harnessDir: authority.harness };
    const original = await captureIssue(context, baseInput({ occurrenceKey: "orig" }), mut("cap-orig"));
    const dup = await captureIssue(
      context,
      baseInput({ occurrenceKey: "dup", rootCauseKey: "other-cause" }),
      mut("cap-dup"),
    );
    await expect(
      closeIssue(
        context,
        dup.issueId,
        "duplicate",
        { reason: "same bug", references: [] },
        pmMut(authority, "dup-missing", { expectedRevision: dup.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.invalid-disposition" });
    await expect(
      closeIssue(
        context,
        dup.issueId,
        "duplicate",
        { reason: "same bug", references: [], canonicalIssueId: "I-999999" },
        pmMut(authority, "dup-missing-id", { expectedRevision: dup.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.not-found" });
    const closed = await closeIssue(
      context,
      dup.issueId,
      "duplicate",
      { reason: "same bug", references: [], canonicalIssueId: original.issueId },
      pmMut(authority, "dup-ok", { expectedRevision: dup.revision }),
    );
    const detail = await getIssue(context, dup.issueId);
    expect(detail.disposition).toBe("duplicate");
    expect(detail.relations.some((r) => r.relation === "duplicate-of" && r.toIssue === original.issueId)).toBe(true);
    expect(closed.revision).toBe(dup.revision + 1);

    const later = await captureIssue(
      context,
      baseInput({ occurrenceKey: "sup", rootCauseKey: "third-cause" }),
      mut("cap-sup"),
    );
    await closeIssue(
      context,
      later.issueId,
      "superseded",
      { reason: "replaced", references: [], canonicalIssueId: original.issueId },
      pmMut(authority, "sup-ok", { expectedRevision: later.revision }),
    );
    expect((await getIssue(context, later.issueId)).disposition).toBe("superseded");
  });

  test("terminal recurrence records an occurrence without reopening", async () => {
    const authority = await liveAuthority("disposition-recurrence-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-term"));
    await closeIssue(
      context,
      created.issueId,
      "resolved",
      { reason: "fixed", references: ["qa.md"], alignmentRef: "PM acceptance \u2014 handoff evidence" },
      pmMut(authority, "close-term", { expectedRevision: created.revision }),
    );
    await appendOccurrence(
      context,
      created.issueId,
      {
        sourceIdentity: "qc/review.md",
        rootCauseKey: "missing-null-check",
        acceptanceKey: "null-guard-present",
        occurrenceKey: "run-later",
        sourceKind: "qc",
        location: "packages/engine/src/store-db.ts:10",
        observedBehavior: "throws on empty path",
        evidence: ["again"],
        discoveredAt: "2026-09-18T12:00:00.000Z",
      },
      mut("occ-later"),
    );
    const detail = await getIssue(context, created.issueId);
    expect(detail.disposition).toBe("resolved");
    expect(detail.occurrences).toHaveLength(2);
  });

  test("multi-plan obligation cannot be resolved from one linked plan alone", async () => {
    const authority = await liveAuthority("relation-multiplan-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-mp"));
    const afterPlan1 = await linkIssue(
      context,
      created.issueId,
      { kind: "plan", target: authority.planId },
      pmMut(authority, "link-a", { expectedRevision: created.revision }),
    );
    const afterPlan2 = await linkIssue(
      context,
      created.issueId,
      { kind: "plan", target: authority.peerPlanId },
      pmMut(authority, "link-b", { expectedRevision: afterPlan1.revision }),
    );
    await expect(
      closeIssue(
        context,
        created.issueId,
        "resolved",
        { reason: "one plan done", references: [authority.planId], alignmentRef: "QA gate: Approve" },
        pmMut(authority, "close-one-plan", { expectedRevision: afterPlan2.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.invalid-disposition" });
    expect((await getIssue(context, created.issueId)).disposition).toBe("open");

    await closeIssue(
      context,
      created.issueId,
      "resolved",
      {
        reason: "both plans verified",
        references: [authority.planId, authority.peerPlanId],
        scope: "all",
        alignmentRef: "QA gate: Approve",
      },
      pmMut(authority, "close-all-plans", { expectedRevision: afterPlan2.revision }),
    );
    expect((await getIssue(context, created.issueId)).disposition).toBe("resolved");
  });

  test("relation form refuses self-edges and canonicalizes related order", async () => {
    const authority = await liveAuthority("relation-related-");
    const context: StoreContext = { harnessDir: authority.harness };
    const a = await captureIssue(context, baseInput({ occurrenceKey: "a" }), mut("cap-a"));
    const b = await captureIssue(
      context,
      baseInput({ occurrenceKey: "b", rootCauseKey: "other" }),
      mut("cap-b"),
    );
    await expect(
      linkIssue(context, a.issueId, { relation: "related", issueId: a.issueId }, pmMut(authority, "self", { expectedRevision: a.revision })),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    const linked = await linkIssue(
      context,
      b.issueId,
      { relation: "related", issueId: a.issueId },
      pmMut(authority, "rel-1", { expectedRevision: b.revision }),
    );
    const replay = await linkIssue(
      context,
      b.issueId,
      { relation: "related", issueId: a.issueId },
      pmMut(authority, "rel-1", { expectedRevision: b.revision }),
    );
    expect(replay).toEqual(linked);
    const detail = await getIssue(context, a.issueId);
    expect(detail.relations).toHaveLength(1);
    expect(detail.relations[0]?.fromIssue < detail.relations[0]?.toIssue).toBe(true);
    expect(detail.relations[0]?.relation).toBe("related");
  });

  test("triage records kind severity impact owner acceptance without changing identity", async () => {
    const authority = await liveAuthority("revision-triage-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-triage"));
    const before = await getIssue(context, created.issueId);
    await triageIssue(
      context,
      created.issueId,
      { kind: "risk", severity: "medium", impact: "ops delay", acceptance: "runbook exists", owner: "ops", reason: "reclass" },
      pmMut(authority, "triage-1", { expectedRevision: created.revision }),
    );
    const after = await getIssue(context, created.issueId);
    expect(after.kind).toBe("risk");
    expect(after.severity).toBe("medium");
    expect(after.impact).toBe("ops delay");
    expect(after.acceptance).toBe("runbook exists");
    expect(after.owner).toBe("ops");
    expect(after.identityKey).toBe(before.identityKey);
  });

  test("unsupported relation or provenance kind yields a domain refusal", async () => {
    const authority = await liveAuthority("relation-vocab-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-vocab"));
    await expect(
      linkIssue(
        context,
        created.issueId,
        { relation: "depends-on", issueId: "I-000002" } as unknown as IssueLink,
        pmMut(authority, "bad-rel", { expectedRevision: created.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(
      linkIssue(
        context,
        created.issueId,
        { kind: "ticket", target: "T-1" } as unknown as IssueLink,
        pmMut(authority, "bad-kind", { expectedRevision: created.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    expect((await getIssue(context, created.issueId)).relations).toEqual([]);
    expect((await getIssue(context, created.issueId)).provenance.every((row) => row.kind === "capture")).toBe(true);
  });

  test("inherited Object.prototype keys are refused as relation and provenance kind", async () => {
    const authority = await liveAuthority("relation-inherited-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-inherited"));
    await expect(
      linkIssue(
        context,
        created.issueId,
        { relation: "toString", issueId: "I-000002" } as unknown as IssueLink,
        pmMut(authority, "bad-rel-proto", { expectedRevision: created.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(
      linkIssue(
        context,
        created.issueId,
        { kind: "constructor", target: "T-1" } as unknown as IssueLink,
        pmMut(authority, "bad-kind-proto", { expectedRevision: created.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    const after = await getIssue(context, created.issueId);
    expect(after.relations).toEqual([]);
    expect(after.provenance.every((row) => row.kind === "capture")).toBe(true);
    expect(after.revision).toBe(created.revision);
  });

  test("a closure carrying QA-gate acceptance evidence is accepted and stays distinguishable", async () => {
    const authority = await liveAuthority("closure-acceptance-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-accept"));
    // Acceptance evidence without the authority that accepted it records half of
    // §4's requirement and refuses.
    await expect(
      closeIssue(
        context,
        created.issueId,
        "resolved",
        { reason: "the QA seat said so", references: ["sdd/plan/review/qa.md"] },
        pmMut(authority, "close-no-authority", { expectedRevision: created.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.invalid-disposition" });
    // Acceptance authority without acceptance evidence refuses too: neither half
    // is a closure on its own.
    await expect(
      closeIssue(
        context,
        created.issueId,
        "resolved",
        { reason: "trust the gate", references: [], alignmentRef: "QA gate: Approve" },
        pmMut(authority, "close-no-evidence", { expectedRevision: created.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.invalid-disposition" });
    expect((await getIssue(context, created.issueId)).disposition).toBe("open");

    // Acceptance provenance is recorded in the closure evidence; writing it
    // does not establish or verify an execution-authority session.
    const qaAcceptance = "QA gate: Approve \u2014 .mstar/sdd/20260918-a/review/qa.md";
    await closeIssue(
      context,
      created.issueId,
      "resolved",
      { reason: "acceptance met", references: ["sdd/20260918-a/review/qa.md"], alignmentRef: qaAcceptance },
      pmMut(authority, "close-qa-gate", { expectedRevision: created.revision }),
    );
    const qaTransition = await getIssue(context, created.issueId);
    expect(qaTransition.disposition).toBe("resolved");
    expect(qaTransition.transitions).toHaveLength(1);
    expect(qaTransition.transitions[0]?.evidence).toEqual({
      reason: "acceptance met",
      scope: null,
      references: ["sdd/20260918-a/review/qa.md"],
      canonicalIssueId: null,
      alignmentRef: qaAcceptance,
    });

    // A PM-acceptance closure stays a different record: the two acceptance
    // routes are distinguishable in the append-only history, never merged.
    const second = await captureIssue(
      context,
      baseInput({ occurrenceKey: "pm-accept", rootCauseKey: "pm-accept-cause" }),
      mut("cap-pm-accept"),
    );
    await closeIssue(
      context,
      second.issueId,
      "resolved",
      { reason: "PM verified the fix", references: ["sdd/20260918-a/handoff.md"], alignmentRef: "PM acceptance \u2014 handoff.md" },
      pmMut(authority, "close-pm-accept", { expectedRevision: second.revision }),
    );
    const pmTransition = await getIssue(context, second.issueId);
    expect(pmTransition.transitions[0]?.evidence).toEqual({
      reason: "PM verified the fix",
      scope: null,
      references: ["sdd/20260918-a/handoff.md"],
      canonicalIssueId: null,
      alignmentRef: "PM acceptance \u2014 handoff.md",
    });
    expect(pmTransition.transitions[0]?.evidence).not.toEqual(qaTransition.transitions[0]?.evidence);
  });

  test("C3 verbs are reachable through the engine entrypoint", async () => {
    expect(typeof triageIssueFromIndex).toBe("function");
    expect(typeof closeIssueFromIndex).toBe("function");
    expect(typeof linkIssueFromIndex).toBe("function");
  });
});
