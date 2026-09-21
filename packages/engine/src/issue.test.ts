/**
 * issue.test.ts — C2/C3 proof: capture, occurrences, reads, disposition.
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";
import { bindPlanSession, mutatePlanCoordination, readPlanCoordination } from "./coordination.js";
import { createFsStore, setArtifactStore } from "./store.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";
import {
  IssueError,
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
});

/* -------------------------------------------------------------------------
 * Live-workflow authority fixtures (contract §4)
 *
 * A privileged mutation is authorized only by the engine-issued session
 * envelope of a live workflow, so these fixtures build a real control root (a
 * Git repository, a running root register entry, a valid snapshot) and let the
 * engine itself issue every envelope through `bindPlanSession`. Nothing here
 * hand-writes a session file: a hand-written one is exactly what the refusal
 * cases below must reject.
 * ---------------------------------------------------------------------- */

const LIVE_WORKFLOW_ID = "wf-issue";
const LIVE_PLAN_ID = "20260918-a";
const LIVE_PEER_PLAN_ID = "20260918-b";

type LiveAuthority = {
  /** The harness dir that owns the fixture's store. */
  harness: string;
  workflowId: string;
  planId: string;
  peerPlanId: string;
  /** The engine-issued lifecycle (`coordinator`) envelope. */
  coordinatorSession: string;
  /** Engine-issued `plan-pm` envelopes by plan id (`{}` unless `bindPlans`). */
  planSessions: Record<string, string>;
};

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/** Fixture JSON read (a JSON document written by the fixture or the engine). */
function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** The session id an envelope file records. */
function sessionIdOf(path: string): string {
  const sessionId = readJsonFile(path).session_id;
  if (typeof sessionId !== "string" || sessionId === "") throw new Error(`fixture: no session_id in ${path}`);
  return sessionId;
}

/** Fixture snapshot path of one authority. */
function snapshotPathOf(authority: LiveAuthority): string {
  return join(authority.harness, "workflows", authority.workflowId, "snapshot.json");
}

/** The pinned Assignment header block `parseAssignmentFile` accepts. */
function assignmentText(input: {
  harness: string;
  workflowId: string;
  planId: string;
  planPath: string;
  worktreePath: string;
  sddDir: string;
}): string {
  return [
    `# Assignment \u2014 ${input.planId}`,
    "",
    `**Control harness root**: ${input.harness}`,
    `**Workflow id**: ${input.workflowId}`,
    `**Plan id**: ${input.planId}`,
    `**Plan Path**: ${input.planPath}`,
    `**Worktree Path**: ${input.worktreePath}`,
    `**Working branch**: feature/fixture-plan`,
    `**SDD dir**: ${input.sddDir}`,
    "**Execute as**: project-manager",
    "**Execution scope**: plan",
    "**Delegation**: allowed (plan-local subagents only)",
    "**Prepare gate**: go",
    "**QA gate**: mandatory",
    "**Findings cleanup**: allow-residual",
    "",
    "Fixture plan.",
    "",
  ].join("\n");
}

/**
 * A live workflow in its own control root, with the envelopes the engine
 * issues for it: the lifecycle `coordinator` seat, plus each plan row's
 * `plan-pm` seat when `bindPlans` is set (a plan bind requires a prepared
 * plan). The store is initialized, so callers mutate it directly.
 */
async function liveAuthority(name: string, options: { bindPlans?: boolean } = {}): Promise<LiveAuthority> {
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

  const planSessions: Record<string, string> = {};
  let coordinatorSession = "";
  setArtifactStore(createFsStore(harness));
  try {
    coordinatorSession = (
      await bindPlanSession({ coordinator: true, workflowId, harnessDir: harness, cwd: root, sessionId: "fixture-coordinator" })
    ).session_file;
    if (options.bindPlans === true) {
      for (const planId of planIds) {
        const sddDir = join(harness, "sdd", planId);
        const assignmentPath = join(sddDir, "assignment.md");
        writeTextFile(
          assignmentPath,
          assignmentText({
            harness,
            workflowId,
            planId,
            planPath: join(harness, "plans", `${planId}.md`),
            worktreePath: join(root, `wt-${planId}`),
            sddDir,
          }),
        );
        const view = await readPlanCoordination(coordinatorSession, planId, root);
        await mutatePlanCoordination({
          sessionPath: coordinatorSession,
          planId,
          expectedRevision: view.revision,
          operation: { kind: "prepare", assignmentPath },
        });
        planSessions[planId] = (
          await bindPlanSession({ scope: { workflowId, planId, harnessDir: harness }, cwd: root })
        ).session_file;
      }
    }
  } finally {
    setArtifactStore(undefined);
  }
  await initializeStore({ harnessDir: harness }).then((handle) => handle.close());
  return {
    harness,
    workflowId,
    planId: LIVE_PLAN_ID,
    peerPlanId: LIVE_PEER_PLAN_ID,
    coordinatorSession,
    planSessions,
  };
}

/** Finish the fixture's lifecycle: a terminal workflow holds no live authority. */
function retireWorkflow(authority: LiveAuthority): void {
  const path = snapshotPathOf(authority);
  writeJsonFile(path, {
    ...readJsonFile(path),
    status: "completed",
    ended_at: "2026-09-18T23:00:00Z",
    updated_at: "2026-09-18T23:00:00Z",
  });
}

/** Point the workflow's own coordinator record at another file (a tampered binding). */
function rebindCoordinatorRecord(authority: LiveAuthority, sessionFile: string): void {
  const path = snapshotPathOf(authority);
  const snapshot = readJsonFile(path);
  const coordination = snapshot.coordination;
  if (typeof coordination !== "object" || coordination === null || !("coordinator" in coordination)) {
    throw new Error(`fixture: ${path} carries no coordinator binding`);
  }
  const coordinator = coordination.coordinator;
  if (typeof coordinator !== "object" || coordinator === null) {
    throw new Error(`fixture: ${path} carries no coordinator binding`);
  }
  writeJsonFile(path, {
    ...snapshot,
    coordination: { ...coordination, coordinator: Object.assign({}, coordinator, { session_file: sessionFile }) },
  });
}

/**
 * Point one plan row's recorded session binding at another file. Used to
 * reproduce a released-3.11.0 workflow: its plan row records the pre-#264
 * bare envelope name `sessions/<session-id>.json`.
 */
function rebindPlanSessionRecord(authority: LiveAuthority, planId: string, sessionFile: string): void {
  const path = snapshotPathOf(authority);
  const snapshot = readJsonFile(path);
  const plans = snapshot.plans;
  if (!Array.isArray(plans)) throw new Error(`fixture: ${path} carries no plan rows`);
  const row = plans.find(
    (candidate) => (candidate as Record<string, unknown>).id === planId || (candidate as Record<string, unknown>).plan_id === planId,
  );
  if (row === undefined) throw new Error(`fixture: ${path} has no row for plan ${planId}`);
  const source = row as Record<string, unknown>;
  const coordination = source.coordination;
  if (typeof coordination !== "object" || coordination === null || !("session" in coordination)) {
    throw new Error(`fixture: plan ${planId} of ${path} carries no session binding`);
  }
  const session = (coordination as Record<string, unknown>).session;
  if (typeof session !== "object" || session === null) {
    throw new Error(`fixture: plan ${planId} of ${path} carries no session binding`);
  }
  const rebound = plans.map((candidate) =>
    candidate === source
      ? { ...source, coordination: { ...(coordination as Record<string, unknown>), session: Object.assign({}, session, { session_file: sessionFile }) } }
      : candidate,
  );
  writeJsonFile(path, { ...snapshot, plans: rebound });
}

/**
 * A `project-manager` mutation authorized by one of the fixture's
 * engine-issued envelopes: the lifecycle coordinator seat by default, a plan
 * seat when `sessionFile` overrides it (plan provenance must match that seat's
 * plan id).
 */
function pmMut(authority: LiveAuthority, operationId: string, extra: Partial<MutationContext> = {}): MutationContext {
  return { operationId, actor: "project-manager", sessionFile: authority.coordinatorSession, ...extra };
}

/** A caller-written envelope, byte-shaped like the engine's, at any path. */
function forgedEnvelope(dir: string, name: string, fields: Record<string, unknown>): string {
  const path = join(dir, name);
  writeJsonFile(path, {
    schema_version: 1,
    role: "plan-pm",
    session_id: "11111111-1111-1111-1111-111111111111",
    workflow_id: LIVE_WORKFLOW_ID,
    plan_id: LIVE_PLAN_ID,
    ...fields,
  });
  return path;
}

describe("capture authorization", () => {
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

  test("the envelope proves the seat; the actor label is audited, never trusted", async () => {
    const authority = await liveAuthority("authorization-seat-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-seat"));
    const other = await captureIssue(context, baseInput({ occurrenceKey: "seat-b", rootCauseKey: "seat-other" }), mut("cap-seat-b"));
    await expect(
      linkIssue(
        context,
        created.issueId,
        { relation: "related", issueId: other.issueId },
        { operationId: "link-wrong-seat", actor: "qa-engineer", sessionFile: authority.coordinatorSession, expectedRevision: created.revision },
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(
      triageIssue(
        context,
        created.issueId,
        { severity: "low", reason: "downgrade" },
        { operationId: "triage-inherited", actor: "toString", sessionFile: authority.coordinatorSession, expectedRevision: created.revision },
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
      pmMut(authority, "triage-envelope", { expectedRevision: created.revision }),
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

describe("disposition revision relation authorization", () => {
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

  test("unauthorized closure leaves issue and history unchanged", async () => {
    const authority = await liveAuthority("authorization-close-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-2"));
    const evidence = { reason: "looks good", references: ["note"], alignmentRef: "qa gate" };
    // A claimed seat the envelope does not prove never closes the issue.
    await expect(
      closeIssue(context, created.issueId, "resolved", evidence, {
        operationId: "close-leaf",
        actor: "fullstack-dev",
        sessionFile: authority.coordinatorSession,
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(
      closeIssue(context, created.issueId, "resolved", evidence, {
        operationId: "close-arbitrary",
        actor: "toString",
        sessionFile: authority.coordinatorSession,
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    // A forged `project-manager` claim with no envelope at all, and a missing
    // envelope path, refuse as before.
    await expect(
      closeIssue(context, created.issueId, "resolved", evidence, {
        operationId: "close-forged-pm",
        actor: "project-manager",
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(
      closeIssue(context, created.issueId, "resolved", evidence, {
        operationId: "close-missing-session",
        actor: "project-manager",
        sessionFile: join(context.harnessDir, "no-such-session.json"),
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    // A hand-written envelope that parses, names the store's own harness root
    // and this workflow, and lies under the harness root — but sits outside the
    // engine's issued path and was issued by nobody.
    const handWritten = forgedEnvelope(authority.harness, "hand-written-session.json", {
      harness_root: authority.harness,
    });
    await expect(
      closeIssue(context, created.issueId, "resolved", evidence, {
        operationId: "close-hand-written",
        actor: "project-manager",
        sessionFile: handWritten,
        expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    const detail = await getIssue(context, created.issueId);
    expect(detail.disposition).toBe("open");
    expect(detail.transitions).toEqual([]);
    expect(detail.revision).toBe(created.revision);
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
    const authority = await liveAuthority("relation-multiplan-", { bindPlans: true });
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-mp"));
    const sessionA = authority.planSessions[authority.planId]!;
    const sessionB = authority.planSessions[authority.peerPlanId]!;
    const afterPlan1 = await linkIssue(
      context,
      created.issueId,
      { kind: "plan", target: authority.planId },
      pmMut(authority, "link-a", { expectedRevision: created.revision, sessionFile: sessionA }),
    );
    const afterPlan2 = await linkIssue(
      context,
      created.issueId,
      { kind: "plan", target: authority.peerPlanId },
      pmMut(authority, "link-b", { expectedRevision: afterPlan1.revision, sessionFile: sessionB }),
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

  test("only the engine-issued envelope at its own path authorizes the mutation", async () => {
    const authority = await liveAuthority("authority-binding-", { bindPlans: true });
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-authz"));
    const planSession = authority.planSessions[authority.planId]!;
    const sessionId = sessionIdOf(planSession);
    expect(planSession).toBe(
      join(authority.harness, "workflows", authority.workflowId, "sessions", `plan-pm-${sessionId}.json`),
    );

    // (1) A byte-identical copy of the engine's own envelope at another path.
    const copy = join(authority.harness, "copied-session.json");
    writeFileSync(copy, readFileSync(planSession, "utf8"));
    await expect(
      linkIssue(
        context,
        created.issueId,
        { kind: "plan", target: authority.planId },
        pmMut(authority, "link-copy", { expectedRevision: created.revision, sessionFile: copy }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });

    // (2) A hand-written envelope that parses, names this workflow, this plan
    // and the store's own harness root, and lies under the harness root.
    const handWritten = forgedEnvelope(authority.harness, "hand-written.json", {
      harness_root: authority.harness,
    });
    await expect(
      linkIssue(
        context,
        created.issueId,
        { kind: "plan", target: authority.planId },
        pmMut(authority, "link-hand-written", { expectedRevision: created.revision, sessionFile: handWritten }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });

    // (3) At the engine's own path, but for a session id the workflow never
    // recorded: the workflow's own record does not point at it.
    const unrecorded = forgedEnvelope(join(authority.harness, "workflows", authority.workflowId, "sessions"), "plan-pm-22222222-2222-2222-2222-222222222222.json", {
      harness_root: authority.harness,
      session_id: "22222222-2222-2222-2222-222222222222",
    });
    await expect(
      linkIssue(
        context,
        created.issueId,
        { kind: "plan", target: authority.planId },
        pmMut(authority, "link-unrecorded", { expectedRevision: created.revision, sessionFile: unrecorded }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });

    // (4) A hand-written envelope whose harness_root is a foreign root refuses,
    // even at its own canonical path inside that root.
    const foreignRoot = join(authority.harness, "other-root");
    const foreign = forgedEnvelope(join(foreignRoot, "workflows", authority.workflowId, "sessions"), `plan-pm-${sessionId}.json`, {
      harness_root: foreignRoot,
      session_id: sessionId,
    });
    await expect(
      linkIssue(
        context,
        created.issueId,
        { kind: "plan", target: authority.planId },
        pmMut(authority, "link-foreign-root", { expectedRevision: created.revision, sessionFile: foreign }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });

    const refused = await getIssue(context, created.issueId);
    expect(refused.provenance.every((row) => row.kind !== "plan")).toBe(true);
    expect(refused.revision).toBe(created.revision);

    // (5) The engine-issued `plan-pm` envelope for that same plan authorizes
    // the very same action.
    const linked = await linkIssue(
      context,
      created.issueId,
      { kind: "plan", target: authority.planId },
      pmMut(authority, "link-issued", { expectedRevision: created.revision, sessionFile: planSession }),
    );
    expect(linked.revision).toBe(created.revision + 1);
    expect(
      (await getIssue(context, created.issueId)).provenance.some(
        (row) => row.kind === "plan" && row.target === authority.planId,
      ),
    ).toBe(true);
  });

  test("an envelope is refused when the workflow record or the lifecycle stops matching it", async () => {
    // A finished lifecycle: the engine's own envelope holds no live authority.
    const retired = await liveAuthority("authority-retired-");
    const retiredContext: StoreContext = { harnessDir: retired.harness };
    const retiredIssue = await captureIssue(retiredContext, baseInput(), mut("cap-retired"));
    retireWorkflow(retired);
    await expect(
      triageIssue(
        retiredContext,
        retiredIssue.issueId,
        { severity: "low", reason: "after the lifecycle ended" },
        pmMut(retired, "triage-retired", { expectedRevision: retiredIssue.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    expect((await getIssue(retiredContext, retiredIssue.issueId)).severity).toBe("high");

    // A live workflow whose own coordination record names another file.
    const rebound = await liveAuthority("authority-rebound-");
    const reboundContext: StoreContext = { harnessDir: rebound.harness };
    const reboundIssue = await captureIssue(reboundContext, baseInput(), mut("cap-rebound"));
    rebindCoordinatorRecord(rebound, join(rebound.harness, "elsewhere.json"));
    await expect(
      triageIssue(
        reboundContext,
        reboundIssue.issueId,
        { severity: "low", reason: "rebound elsewhere" },
        pmMut(rebound, "triage-rebound", { expectedRevision: reboundIssue.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    expect((await getIssue(reboundContext, reboundIssue.issueId)).revision).toBe(reboundIssue.revision);

    // An envelope issued for a different control root never authorizes this
    // store, even though that root's own workflow is live.
    const other = await liveAuthority("authority-other-root-");
    const second = await captureIssue(
      reboundContext,
      baseInput({ occurrenceKey: "other-root", rootCauseKey: "other-root" }),
      mut("cap-other-root"),
    );
    await expect(
      triageIssue(
        reboundContext,
        second.issueId,
        { severity: "low", reason: "foreign root" },
        pmMut(other, "triage-other-root", { expectedRevision: second.revision }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    expect((await getIssue(reboundContext, second.issueId)).revision).toBe(second.revision);
  });

  test("plan target that does not match the session plan_id is refused", async () => {
    const authority = await liveAuthority("authorization-identity-", { bindPlans: true });
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-id"));
    const session = authority.planSessions[authority.planId]!;
    await expect(
      linkIssue(
        context,
        created.issueId,
        { kind: "plan", target: "20260918-other" },
        pmMut(authority, "link-mismatch", { expectedRevision: created.revision, sessionFile: session }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    // The same envelope stays authoritative for its own plan.
    const linked = await linkIssue(
      context,
      created.issueId,
      { kind: "plan", target: authority.planId },
      pmMut(authority, "link-own-plan", { expectedRevision: created.revision, sessionFile: session }),
    );
    expect(linked.revision).toBe(created.revision + 1);
    expect((await getIssue(context, created.issueId)).provenance.some((row) => row.target === "20260918-other")).toBe(false);
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

    // The QA gate's acceptance (§4's `qa-engineer` authority, supplied as
    // evidence per §6) is expressible: the envelope-proven seat writes the
    // closure and the QA acceptance is recorded verbatim in the history.
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

describe("legacy plan-pm envelope path (pre-#264 upgrade tolerance)", () => {
  /**
   * A released-3.11.0-shaped workflow: the plan-pm envelope file and the plan
   * row's recorded `session_file` both use the pre-#264 bare name
   * `sessions/<session-id>.json` (no role prefix) — exactly what
   * `sessionFilePath` wrote before #264 renamed it. Every bound content
   * field (workflow, plan, session id, harness root) is unchanged.
   */
  async function legacyBoundAuthority(name: string): Promise<{ authority: LiveAuthority; legacyPath: string }> {
    const authority = await liveAuthority(name, { bindPlans: true });
    const canonicalPath = authority.planSessions[authority.planId]!;
    const legacyPath = join(dirname(canonicalPath), `${sessionIdOf(canonicalPath)}.json`);
    renameSync(canonicalPath, legacyPath);
    rebindPlanSessionRecord(authority, authority.planId, legacyPath);
    return { authority, legacyPath };
  }

  test("a legacy-named envelope with fully bound content authorizes the mutation", async () => {
    const { authority, legacyPath } = await legacyBoundAuthority("legacy-ok-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-legacy-ok"));
    const linked = await linkIssue(
      context,
      created.issueId,
      { kind: "plan", target: authority.planId },
      pmMut(authority, "link-legacy-ok", { expectedRevision: created.revision, sessionFile: legacyPath }),
    );
    expect(linked.revision).toBe(created.revision + 1);
    expect(
      (await getIssue(context, created.issueId)).provenance.some(
        (row) => row.kind === "plan" && row.target === authority.planId,
      ),
    ).toBe(true);
  });

  test("a legacy-named envelope whose content does not bind is still refused", async () => {
    const { authority, legacyPath } = await legacyBoundAuthority("legacy-forged-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-legacy-forged"));
    // The exact legacy name and path, but a session id the workflow never
    // recorded: the legacy tolerance is path-shape only, the content
    // binding (session_id against the workflow's record) is unchanged.
    const sessionId = sessionIdOf(legacyPath);
    const forged = forgedEnvelope(dirname(legacyPath), `${sessionId}.json`, {
      harness_root: authority.harness,
      session_id: "22222222-2222-2222-2222-222222222222",
    });
    expect(forged).toBe(legacyPath);
    await expect(
      linkIssue(
        context,
        created.issueId,
        { kind: "plan", target: authority.planId },
        pmMut(authority, "link-legacy-forged", { expectedRevision: created.revision, sessionFile: forged }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    expect((await getIssue(context, created.issueId)).revision).toBe(created.revision);
  });

  test("the canonical plan-pm path still authorizes a current bind", async () => {
    const authority = await liveAuthority("legacy-canonical-", { bindPlans: true });
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-legacy-canonical"));
    const linked = await linkIssue(
      context,
      created.issueId,
      { kind: "plan", target: authority.planId },
      pmMut(authority, "link-legacy-canonical", {
        expectedRevision: created.revision,
        sessionFile: authority.planSessions[authority.planId]!,
      }),
    );
    expect(linked.revision).toBe(created.revision + 1);
  });

  test("a legacy-named coordinator envelope with fully bound content authorizes the mutation", async () => {
    const authority = await liveAuthority("legacy-coordinator-", { bindPlans: true });
    // Released 3.11.0 issued the coordinator envelope at the SAME bare
    // pre-#264 name (`sessions/<session-id>.json` — v3.11.0's
    // `sessionFilePath` had no role parameter), so a legacy workflow's
    // coordinator record names the bare path. Reproduce that shape.
    const canonicalCoordinator = authority.coordinatorSession;
    const legacyCoordinator = join(dirname(canonicalCoordinator), `${sessionIdOf(canonicalCoordinator)}.json`);
    renameSync(canonicalCoordinator, legacyCoordinator);
    rebindCoordinatorRecord(authority, legacyCoordinator);
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-legacy-coord"));
    // A coordinator session is a valid issue-authorization surface:
    // triageIssue/closeIssue/linkIssue take both roles and the seat map
    // grants the coordinator the PM seat (plan-provenance links additionally
    // demand plan-pm identity, so this pins the surface with a triage).
    const triaged = await triageIssue(
      context,
      created.issueId,
      { severity: "medium", reason: "coordinator legacy session re-triage" },
      pmMut(authority, "triage-legacy-coord", { expectedRevision: created.revision, sessionFile: legacyCoordinator }),
    );
    expect(triaged.revision).toBe(created.revision + 1);
    expect((await getIssue(context, created.issueId)).severity).toBe("medium");
  });

  test("a bare-named coordinator envelope with unbound content is still refused", async () => {
    const authority = await liveAuthority("legacy-coordinator-forged-", { bindPlans: true });
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-legacy-coord-forged"));
    // The bare pre-#264 SHAPE, but a session id the workflow never recorded:
    // the tolerance covers the recorded path's shape, never its content.
    const coordinatorId = sessionIdOf(authority.coordinatorSession);
    const bare = forgedEnvelope(join(authority.harness, "workflows", authority.workflowId, "sessions"), `${coordinatorId}.json`, {
      role: "coordinator",
      harness_root: authority.harness,
      session_id: "22222222-2222-2222-2222-222222222222",
      plan_id: undefined,
    });
    await expect(
      linkIssue(
        context,
        created.issueId,
        { kind: "plan", target: authority.planId },
        pmMut(authority, "link-legacy-coord-forged", { expectedRevision: created.revision, sessionFile: bare }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    expect((await getIssue(context, created.issueId)).revision).toBe(created.revision);
  });

  test("a bound bare-named copy does not authorize a current (canonical-record) workflow", async () => {
    const authority = await liveAuthority("legacy-cross-current-", { bindPlans: true });
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-legacy-cross-current"));
    // F1 tie: a byte-identical copy of the engine's own canonical envelope
    // at the legacy bare path must NOT authorize a workflow whose record
    // names the canonical path — the presented file must be exactly the
    // bound session file, in whichever single shape the record carries.
    const canonicalPath = authority.planSessions[authority.planId]!;
    const bareCopy = join(dirname(canonicalPath), `${sessionIdOf(canonicalPath)}.json`);
    writeFileSync(bareCopy, readFileSync(canonicalPath, "utf8"));
    await expect(
      linkIssue(
        context,
        created.issueId,
        { kind: "plan", target: authority.planId },
        pmMut(authority, "link-legacy-cross-current", { expectedRevision: created.revision, sessionFile: bareCopy }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    expect((await getIssue(context, created.issueId)).revision).toBe(created.revision);
  });

  test("a canonical-named copy does not authorize a legacy (bare-record) workflow", async () => {
    const { authority, legacyPath } = await legacyBoundAuthority("legacy-cross-legacy-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-legacy-cross-legacy"));
    // Cross-shape pin in the other direction: the legacy workflow's record
    // names the bare path, so a canonical-named copy refuses too.
    const canonicalCopy = join(dirname(legacyPath), `plan-pm-${sessionIdOf(legacyPath)}.json`);
    writeFileSync(canonicalCopy, readFileSync(legacyPath, "utf8"));
    await expect(
      linkIssue(
        context,
        created.issueId,
        { kind: "plan", target: authority.planId },
        pmMut(authority, "link-legacy-cross-legacy", { expectedRevision: created.revision, sessionFile: canonicalCopy }),
      ),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    expect((await getIssue(context, created.issueId)).revision).toBe(created.revision);
  });
});
