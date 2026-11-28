/**
 * issue.test.ts — C2/C3 proof: capture, occurrences, reads, disposition.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeOs from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { collaborationLocationOfRepoKey, resolveCollaborationLocation } from "./collaboration-identity.js";
import { assertIssueRef, initializeCollaborationStore, openCollaborationStore, withCollaborationWrite, writeCollaborationBinding, writeCollaborationStage } from "./collaboration-store.js";
import { bindRemoteAuthority, ingestRemoteObservation, type RemoteSnapshot } from "./collaboration-remote.js";
import {
  completeSnapshot,
  createRemoteScope,
  positiveCheck,
  REMOTE_IDS,
  submission,
} from "./remote-scope.fixture.js";
import { moveAcrossAuthorities } from "./cross-authority-move.js";
import { readExecutionState } from "./execution-store.js";
import { initializeStore, openStore, type StoreContext, type StoreDb } from "./store-db.js";
import {
  assertIssueLinkedToPlanOn,
  assertIssueTriageVocabulary,
  assertTerminalDisposition,
  IssueError,
  ISSUE_ACTIONS,
  ISSUE_ACTION_NAMES,
  ISSUE_DISPOSITIONS,
  ISSUE_PAYLOAD_SCHEMAS,
  TERMINAL_DISPOSITIONS,
  assertCaptureRequest,
  appendOccurrence,
  captureIssue,
  closeIssue,
  getIssue,
  showIssue,
  reopenIssue,
  computeIdentityKey,
  linkIssue,
  listIssues,
  linkIssueScoped,
  moveIssue,
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
const HOME = join(ROOT, "home");
mkdirSync(HOME);
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * invariant: The collaboration store is user-level, so the resolver's home must be this
 * fixture and never the operator's. One spy serves the whole file: nesting a
 * second and restoring it would discard this one.
 */
let homeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});

test("triage vocabulary rejects array values instead of coercing them to keys", () => {
  expect(() => assertIssueTriageVocabulary({ kind: ["bug"] } as never)).toThrow(
    expect.objectContaining({ code: "issue.scope-refused" }),
  );
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * why: A synthetic checkout: the git origin names the repository the collaboration
 * authority is keyed by, and `.mstarc` selects the local mode an operator's own
 * clone would declare.
 */
function ctx(name: string) {
  const checkoutRoot = mkdtempSync(join(ROOT, name));
  execFileSync("git", ["init", "-q"], { cwd: checkoutRoot, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["config", "user.name", "Issue Store Test"], { cwd: checkoutRoot });
  execFileSync("git", ["config", "user.email", "issue@example.test"], { cwd: checkoutRoot });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${basename(checkoutRoot)}.git`], {
    cwd: checkoutRoot,
  });
  // note: The live selector lookup is real Git I/O; route the synthetic origin to this fixture's
  // own repository, which never publishes the selector ref.
  execFileSync(
    "git",
    ["config", `url.${checkoutRoot}.insteadOf`, `https://github.com/acme/${basename(checkoutRoot)}.git`],
    { cwd: checkoutRoot },
  );
  writeFileSync(join(checkoutRoot, ".mstarc"), "[collaboration]\nmode=local\n");
  const harnessDir = join(checkoutRoot, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  return { harnessDir, checkoutRoot };
}

/** note: Publish the staged lane and this checkout's binding, as real activation does. */
function activate(context: StoreContext): void {
  const location = resolveCollaborationLocation(context);
  const db = new DatabaseSync(location.dbPath);
  let storeId = "";
  let epoch = 0;
  try {
    db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(
      new Date().toISOString(),
    );
    const row = db.prepare("select store_id, authority_epoch from collaboration_meta where id = 1").get() as
      | { store_id?: unknown; authority_epoch?: unknown }
      | undefined;
    if (typeof row?.store_id === "string") storeId = row.store_id;
    if (typeof row?.authority_epoch === "number") epoch = row.authority_epoch;
  } finally {
    db.close();
  }
  writeCollaborationBinding(context, { repoKey: location.repoKey, mode: location.mode, storeId, epoch, binding: "active" });
}

/** note: Initialize this context's collaboration authority without activating it. */
async function stagedIssueStore(context: StoreContext): Promise<void> {
  await initializeCollaborationStore(resolveCollaborationLocation(context));
}

/** note: The collaboration authority the issue verbs read and write. */
async function activeIssueStore(context: StoreContext): Promise<void> {
  await stagedIssueStore(context);
  activate(context);
}

/** note: One fixture effect on the collaboration authority. */
function seedCollab<T>(context: StoreContext, fn: (db: StoreDb) => T): Promise<T> {
  return withCollaborationWrite(context, ({ db }) => fn(db));
}

/** note: One fixture read of the collaboration authority. */
async function readCollab<T>(context: StoreContext, fn: (db: StoreDb) => T): Promise<T> {
  const handle = await openCollaborationStore(context, "read");
  try {
    return fn(handle.db);
  } finally {
    handle.close();
  }
}

/** note: The collaboration revision the receipts of this fixture's effects report. */
function collaborationRevision(context: StoreContext): Promise<number> {
  return readCollab(context, (db) => (db.prepare("select revision from collaboration_meta where id = 1").get() as {
    revision: number;
  }).revision);
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

describe("collaboration issues", () => {
  test("capture, triage and close advance the collaboration revision once per accepted effect, and a replay does not", async () => {
    const context = ctx("collaboration-issues-");
    await activeIssueStore(context);
    expect(await collaborationRevision(context)).toBe(0);

    const captured = await captureIssue(context, baseInput(), mut("collab-capture"));
    expect(captured.created).toBe(true);
    expect(captured.storeRevision).toBe(1);
    expect(await collaborationRevision(context)).toBe(1);

    const replay = await captureIssue(context, baseInput(), mut("collab-capture"));
    expect(replay).toEqual(captured);
    expect(await collaborationRevision(context)).toBe(1);

    const triaged = await triageIssue(
      context,
      captured.issueId,
      { severity: "medium", reason: "reclassified" },
      { operationId: "collab-triage", actor: "project-manager", expectedRevision: captured.revision },
    );
    expect(triaged.storeRevision).toBe(2);
    expect(await collaborationRevision(context)).toBe(2);

    await closeIssue(
      context,
      captured.issueId,
      "resolved",
      { reason: "accepted", references: ["qa/run.md"], alignmentRef: "QA gate: Approve" },
      { operationId: "collab-close", actor: "project-manager", expectedRevision: triaged.revision },
    );
    expect(await collaborationRevision(context)).toBe(3);
    // note: The rows the verbs wrote are the collaboration lane's own.
    expect(await readCollab(context, (db) => db.prepare("select count(*) as n from issues").get())).toEqual({ n: 1 });
  });

  test("an execution store revision is never accepted as the collaboration CAS", async () => {
    const context = ctx("collaboration-cas-");
    await activeIssueStore(context);
    await initializeStore(context).then((handle) => handle.close());
    const captured = await captureIssue(context, baseInput(), mut("cas-capture"));
    await captureIssue(context, baseInput({ rootCauseKey: "second", occurrenceKey: "second" }), mut("cas-capture-2"));
    expect(await collaborationRevision(context)).toBe(2);

    // invariant: The EXECUTION lane keeps its own counter; a move carrying that number as
    // its store CAS is refused by the collaboration lane, because the two lanes
    // never share a revision.
    const execution = await openStore(context, "read");
    let executionRevision: number;
    try {
      executionRevision = (execution.db.prepare("select revision from store_meta where id = 1").get() as {
        revision: number;
      }).revision;
    } finally {
      execution.close();
    }
    expect(executionRevision).not.toBe(await collaborationRevision(context));
    await expect(
      moveIssue(
        context,
        captured.issueId,
        { projectId: "proj-b", reason: "wrong lane" },
        {
          operationId: "cas-move",
          actor: "project-manager",
          expectedRevision: captured.revision,
          expectedStoreRevision: executionRevision,
        },
      ),
    ).rejects.toMatchObject({ code: "milestone.revision-conflict" });
    expect((await getIssue(context, captured.issueId)).projectId).toBe("proj-a");
  });

  test("an operation id another collaboration domain recorded refuses a reused payload", async () => {
    const context = ctx("collaboration-operation-");
    await activeIssueStore(context);
    const at = "2026-11-21T00:00:00.000Z";
    await seedCollab(context, (db) => {
      db.prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, revision, provider, identity_key, issue_ref)" +
          " values ('I-000001', 'proj-a', 'Ledger row', 'bug', 'high', 'open', 'i', 'a', ?, ?, 1, 'local', 'ledger-row', 'mstar:issue:11111111-1111-4111-8111-111111111111')",
      ).run(at, at);
    });
    // note: The sync ledger records its own standalone receipt under this id.
    await seedCollab(context, (db) => {
      db.prepare(
        "insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at)" +
          " values ('standalone', 'shared-operation', 'ledger-hash', '{}', ?)",
      ).run(at);
    });
    await expect(captureIssue(context, baseInput(), mut("shared-operation"))).rejects.toMatchObject({
      code: "store.operation-conflict",
    });
    expect(await readCollab(context, (db) => db.prepare("select count(*) as n from issues").get())).toEqual({ n: 1 });
  });

  test("capture mints one portable IssueRef per issue and a recurrence keeps it", async () => {
    const context = ctx("issue-ref-");
    await activeIssueStore(context);
    const created = await captureIssue(context, baseInput(), mut("ref-first"));
    const rows = await readCollab(context, (db) =>
      db.prepare("select id, issue_ref from issues order by id").all(),
    );
    expect(rows).toHaveLength(1);
    const first = rows[0] as { id: string; issue_ref: string };
    expect(first.id).toBe(created.issueId);
    assertIssueRef(first.issue_ref);

    // invariant: A recurrence appends history to the same issue and never re-keys it.
    const recurrence = await captureIssue(context, baseInput({ occurrenceKey: "run-2" }), mut("ref-second"));
    expect(recurrence.issueId).toBe(created.issueId);
    // invariant: A different semantic identity is a different issue with its own reference.
    const other = await captureIssue(
      context,
      baseInput({ rootCauseKey: "other-cause", occurrenceKey: "run-3" }),
      mut("ref-third"),
    );
    expect(other.issueId).not.toBe(created.issueId);
    const after = await readCollab(context, (db) =>
      db.prepare("select id, issue_ref from issues order by id").all(),
    );
    const refs = after.map((row) => {
      if (row === null || typeof row !== "object" || !("issue_ref" in row)) throw new Error("a row has no issue_ref");
      return String(row.issue_ref);
    });
    expect(refs).toEqual([first.issue_ref, expect.stringMatching(/^mstar:issue:[0-9a-f-]{36}$/)]);
  });

  test("a staged collaboration store is not issue read authority", async () => {
    const context = ctx("collaboration-staged-");
    await stagedIssueStore(context);
    await expect(listIssues(context, {})).rejects.toMatchObject({ code: "collaboration.not-active" });
    await expect(captureIssue(context, baseInput(), mut("staged-capture"))).rejects.toMatchObject({
      code: "collaboration.not-active",
    });
  });
});

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
    await activeIssueStore(context);
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

  test("blank operation ids are rejected before issue capture writes", async () => {
    const context = ctx("capture-blank-operation-");
    await activeIssueStore(context);
    await expect(captureIssue(context, baseInput(), mut(""))).rejects.toMatchObject({
      name: "IssueError",
      code: "issue.invalid-operation-id",
    });
    expect((await listIssues(context, {})).total).toBe(0);
    const next = await captureIssue(context, baseInput(), mut("capture-after-blank"));
    expect(next.issueId).toBe("I-000001");
  });

  test("two concurrent processes capturing the same identity create exactly one issue", async () => {
    const context = ctx("capture-concurrent-");
    await activeIssueStore(context);
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
        const child = spawn("bun", [worker, context.harnessDir, occurrenceKey, operationId], {
          env: { ...process.env, HOME },
        });
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
    await activeIssueStore(context);
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
    const childEnv = { ...process.env, HOME };
    const left = spawnSync("bun", [worker, context.harnessDir, "occ-1", "op-1"], { encoding: "utf8", env: childEnv });
    const right = spawnSync("bun", [worker, context.harnessDir, "occ-2", "op-2"], { encoding: "utf8", env: childEnv });
    expect(left.status).toBe(0);
    expect(right.status).toBe(0);
    const page = await listIssues(context, {});
    expect(page.total).toBe(1);
  });

  test("distinct root causes sharing a title remain distinct issues", async () => {
    const context = ctx("capture-title-");
    await activeIssueStore(context);
    const a = await captureIssue(context, baseInput({ rootCauseKey: "cause-a", occurrenceKey: "o1" }), mut("t1"));
    const b = await captureIssue(context, baseInput({ rootCauseKey: "cause-b", occurrenceKey: "o2" }), mut("t2"));
    expect(a.issueId).not.toBe(b.issueId);
    expect(a.created && b.created).toBe(true);
    const page = await listIssues(context, {});
    expect(page.total).toBe(2);
  });

  test("unknown semantic identity returns triage ambiguity rather than a guessed dedup", async () => {
    const context = ctx("capture-ambiguous-");
    await activeIssueStore(context);
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
  test("capture enum refusals identify the invalid field and derive their correction values from the schema vocabulary", () => {
    let failure: unknown;
    try {
      assertCaptureRequest(baseInput({ kind: "tech-debt" as IssueKind }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "issue.scope-refused",
      details: {
        causes: [{
          field: "kind",
          expected: ISSUE_PAYLOAD_SCHEMAS.CaptureInput.kind.values,
          received: "tech-debt",
        }],
      },
    });
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('kind received "tech-debt"');
    expect(message).toContain("bug, risk, improvement, request, decision, review-obligation");
    expect(message).not.toContain("severity");
    expect(message).toContain("mstar schema CaptureInput");
    expect(message).toContain("mstar plan issue-add --help");
  });
  test("capture severity refusal names severity alone and its supported values", () => {
    let failure: unknown;
    try {
      assertCaptureRequest(baseInput({ severity: "urgent" as Severity }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "issue.scope-refused",
      details: { causes: [{ field: "severity", received: "urgent" }] },
    });
    expect((failure as Error).message).toContain("critical, high, medium, low, nit");
    expect((failure as Error).message).not.toContain("kind");
  });
  test("capture enum refusals redact credential-like scalar input and reduce object input to type facts", () => {
    const secret = `sk_live_${"a".repeat(24)}`;
    for (const [field, value] of [
      ["kind", secret],
      ["severity", secret],
      ["kind", { token: secret }],
      ["severity", { token: secret }],
    ] as const) {
      let failure: IssueError | undefined;
      try {
        assertCaptureRequest(baseInput({ [field]: value } as Partial<CaptureInput>));
      } catch (error) {
        if (error instanceof IssueError) failure = error;
      }
      const serialized = JSON.stringify({ message: failure?.message, details: failure?.details });
      expect(serialized).not.toContain(secret);
      expect(failure).toMatchObject({
        code: "issue.scope-refused",
        details: { causes: [{ field, received: typeof value === "string" ? expect.any(String) : "object" }] },
      });
      expect(failure?.message).toContain(field);
      expect(failure?.message).toContain("mstar schema CaptureInput");
      expect(failure?.message).toContain("mstar plan issue-add --help");
    }
  });

  test("reopening the DB retains captured data", async () => {
    const context = ctx("capture-reopen-");
    await activeIssueStore(context);
    const receipt = await captureIssue(context, baseInput(), mut("reopen-1"));
    expect(await readCollab(context, (db) => db.prepare("select count(*) as n from issues").get())).toEqual({ n: 1 });
    const detail = await getIssue(context, receipt.issueId);
    expect(detail.title).toBe("Shared title");
    expect(detail.occurrences[0]?.occurrenceKey).toBe("run-1");
  });
});

describe("occurrence replay and recurrence", () => {
  test("distinct sightings append evidence without altering disposition", async () => {
    const context = ctx("occurrence-append-");
    await activeIssueStore(context);
    const first = await captureIssue(context, baseInput(), mut("occ-1"));
    await seedCollab(context, (db) => {
      db.prepare("update issues set disposition = 'resolved' where id = ?").run(first.issueId);
    });
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
    await activeIssueStore(context);
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

  test("an imported row refuses a by-id occurrence", async () => {
    const context = ctx("occurrence-mirrored-");
    await activeIssueStore(context);
    const created = await captureIssue(context, baseInput(), mut("cap-mirrored"));
    await seedCollab(context, (db) => {
      db.prepare("update issues set provider = 'linear' where id = ?").run(created.issueId);
    });
    await expect(
      appendOccurrence(context, created.issueId, occInput({ occurrenceKey: "run-onto-mirror" }), mut("occ-onto-mirror")),
    ).rejects.toMatchObject({ code: "issue.scope-refused" });
    const row = await readCollab(context, (db) =>
      db.prepare("select revision, provider from issues where id = ?").get(created.issueId) as {
        revision: number;
        provider: string;
      },
    );
    expect(row.provider).toBe("linear");
    expect(row.revision).toBe(created.revision);
  });

  test("exact replay returns the existing occurrence and receipt", async () => {
    const context = ctx("occurrence-replay-");
    await activeIssueStore(context);
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
    await activeIssueStore(context);
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
    await activeIssueStore(context);
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
    await activeIssueStore(context);
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
    await activeIssueStore(context);
    const now = "2026-09-18T12:00:00.000Z";
    await seedCollab(context, (db) => {
      db
        .prepare(
          "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, created_at, updated_at, revision, identity_key, issue_ref) values (?, 'p', 'null-activity', 'bug', 'high', 'open', 'i', 'a', null, ?, ?, 1, 'k-null', 'mstar:issue:10000000-0000-4000-8000-000000000000')",
        )
        .run("I-000010", now, now);
      db
        .prepare(
          "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, created_at, updated_at, revision, identity_key, issue_ref) values (?, 'p', 'older-high', 'bug', 'high', 'open', 'i', 'a', ?, ?, ?, 1, 'k-old', 'mstar:issue:11000000-0000-4000-8000-000000000000')",
        )
        .run("I-000011", "2026-09-01T00:00:00.000Z", now, now);
      db
        .prepare(
          "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, created_at, updated_at, revision, identity_key, issue_ref) values (?, 'p', 'newer-medium', 'bug', 'medium', 'open', 'i', 'a', ?, ?, ?, 1, 'k-med', 'mstar:issue:12000000-0000-4000-8000-000000000000')",
        )
        .run("I-000012", "2026-09-18T00:00:00.000Z", now, now);
      db
        .prepare(
          "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, created_at, updated_at, revision, identity_key, issue_ref) values (?, 'p', 'critical-old', 'bug', 'critical', 'open', 'i', 'a', ?, ?, ?, 1, 'k-crit', 'mstar:issue:13000000-0000-4000-8000-000000000000')",
        )
        .run("I-000013", "2026-08-01T00:00:00.000Z", now, now);
    });
    const page = await listIssues(context, {});
    expect(page.items.map((item) => item.id)).toEqual(["I-000013", "I-000011", "I-000010", "I-000012"]);
    expect(page.items[2]?.lastActivity).toBeNull();
  });

  test("query treats a literal wildcard as text, not SQL", async () => {
    const context = ctx("query-wildcard-");
    await activeIssueStore(context);
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
    await activeIssueStore(context);
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
  git(["remote", "add", "origin", `https://github.com/acme/${basename(root)}.git`], root);
  // note: The live selector lookup is real Git I/O; route the synthetic origin to this fixture's
  // own repository, which never publishes the selector ref.
  git(["config", `url.${root}.insteadOf`, `https://github.com/acme/${basename(root)}.git`], root);
  writeFileSync(join(root, ".mstarc"), "[collaboration]\nmode=local\n");
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
  await activeIssueStore({ harnessDir: harness });
  return { harness, planId: LIVE_PLAN_ID, peerPlanId: LIVE_PEER_PLAN_ID };
}

function pmMut(_authority: LiveAuthority, operationId: string, extra: Partial<MutationContext> = {}): MutationContext {
  return { operationId, actor: "project-manager", ...extra };
}


describe("capture actor auditing", () => {
  test("leaf seats cannot capture or append, and the PM seat captures without a plan", async () => {
    const context = ctx("capture-seat-");
    await activeIssueStore(context);
    for (const actor of ["fullstack-dev", "frontend-dev", "qc-specialist-2", "ops-engineer"]) {
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
        { operationId: "link-wrong-seat", actor: "fullstack-dev", expectedRevision: created.revision },
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
    await activeIssueStore(context);
    const activated = await readExecutionState(context);
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
    const linked = await Reflect.apply(linkIssueFromIndex, undefined, [
      context,
      issue.issueId,
      { kind: "plan", target: "unregistered-plan-label" },
      { operationId: "actor-only-link", actor: "project-manager", expectedRevision: triaged.revision },
      { origin: "scoped" },
    ]);
    const superseded = await closeIssue(context, issue.issueId, "superseded", {
      reason: "replaced", references: [], canonicalIssueId: target.issueId,
    }, { operationId: "actor-only-supersede", actor: "project-manager", expectedRevision: linked.revision });

    expect(superseded.revision).toBe(issue.revision + 3);
    const detail = await getIssue(context, issue.issueId);
    expect(detail.disposition).toBe("superseded");
    expect(detail.provenance).toContainEqual(expect.objectContaining({ kind: "capture", origin: "unscoped" }));
    expect(detail.provenance).toContainEqual(expect.objectContaining({
      kind: "plan",
      target: "unregistered-plan-label",
      origin: "unscoped",
    }));
    expect(detail.severity).toBe("medium");
    expect(detail.transitions[0]?.actor).toBe("project-manager");
  });

  test("non-PM actor still cannot write an issue", async () => {
    const context = ctx("actor-only-refusal-");
    await activeIssueStore(context);
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
  test("reopen restores open state, appends reason, preserves closure note and replays by operation id", async () => {
    const context = ctx("reopen-terminal-");
    await activeIssueStore(context);
    const created = await captureIssue(context, baseInput(), mut("reopen-seed"));
    const closureReason = "acceptance verified";
    const closed = await closeIssue(context, created.issueId, "resolved", {
      reason: closureReason,
      references: ["qa/reopen.md"],
      alignmentRef: "QA gate: Approve",
    }, { operationId: "reopen-close", actor: "project-manager", expectedRevision: created.revision });
    const beforeReopen = await listIssues(context, {});
    const reason = "new evidence reopens investigation";
    const reopened = await reopenIssue(context, created.issueId, { reason }, {
      operationId: "reopen-once", actor: "project-manager", expectedRevision: closed.revision,
    });
    expect(reopened.revision).toBe(closed.revision + 1);
    expect(reopened.storeRevision).toBe(beforeReopen.storeRevision + 1);

    const detail = await getIssue(context, created.issueId);
    expect(detail.disposition).toBe("open");
    expect(detail.closedAt).toBeNull();
    expect(detail.closureNote).toBe(closureReason);
    expect(detail.revision).toBe(reopened.revision);
    expect(detail.transitions).toHaveLength(2);
    expect(detail.transitions[1]).toMatchObject({
      fromDisposition: "resolved",
      toDisposition: "open",
      reason,
      evidence: { reason },
      actor: "project-manager",
      issueRevision: reopened.revision,
    });

    expect(await reopenIssue(context, created.issueId, { reason }, {
      operationId: "reopen-once", actor: "project-manager", expectedRevision: closed.revision,
    })).toEqual(reopened);
    await expect(reopenIssue(context, created.issueId, { reason: "again" }, {
      operationId: "reopen-open-guard", actor: "project-manager", expectedRevision: reopened.revision,
    })).rejects.toMatchObject({
      code: "issue.invalid-disposition",
      message: "[issue.invalid-disposition] Only terminal\u2192open is accepted; open cannot transition to open",
    });
    await expect(reopenIssue(context, created.issueId, { reason }, {
      operationId: "reopen-stale", actor: "project-manager", expectedRevision: closed.revision,
    })).rejects.toMatchObject({ code: "issue.revision-conflict" });
    const again = await getIssue(context, created.issueId);
    // invariant: A read's observation time is not state: the persisted detail must match.
    expect({ ...again, collaboration: { ...again.collaboration, asOf: "same" } }).toEqual({
      ...detail,
      collaboration: { ...detail.collaboration, asOf: "same" },
    });
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
    // The prototype's Relations table has a `Title` column: the other end's title, which is
    // the row this one is not.
    const relation = detail.relations.find((r) => r.relation === "duplicate-of");
    // `original` is a receipt, which carries no title; the title is the one the capture
    // was given.
    expect(relation?.title).toBe(baseInput().title);
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

  test("obsolete records a removed subject: evidence required, no canonical id, reopenable", async () => {
    const context = ctx("obsolete-disposition-");
    await activeIssueStore(context);
    const created = await captureIssue(context, baseInput(), mut("cap-obsolete"));
    const evidence = { reason: "subject removed", references: ["commit abc123 removes packages/engine/src/gone.ts"] };

    // No removal evidence: refused before any write, with the exact recovery.
    const refusal = await closeIssue(context, created.issueId, "obsolete", { reason: "gone", references: [] }, {
      operationId: "obsolete-no-refs", actor: "project-manager", expectedRevision: created.revision,
    }).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "issue.invalid-disposition" });
    expect(String((refusal as Error).message)).toContain("obsolete requires removal evidence in references");
    const recovery =
      refusal && typeof refusal === "object" && "details" in refusal
        && typeof refusal.details === "object" && refusal.details !== null && "recovery" in refusal.details
        ? refusal.details.recovery
        : undefined;
    expect(recovery).toContain(
      "mstar issue close --id <id> --disposition obsolete --file <closure-evidence.json> --actor project-manager --expect <revision>",
    );
    // A blank reference is no reference.
    await expect(
      closeIssue(context, created.issueId, "obsolete", { reason: "gone", references: ["   "] }, {
        operationId: "obsolete-blank-ref", actor: "project-manager", expectedRevision: created.revision,
      }),
    ).rejects.toMatchObject({ code: "issue.invalid-disposition" });
    // A canonical issue is a different claim than "the subject is gone". Every
    // spelling of it — including the empty string and an explicit null — is
    // refused by the engine, not by the transport that carried it here.
    for (const [operationId, canonicalIssueId] of [
      ["obsolete-canonical", "I-000001"],
      ["obsolete-canonical-blank", ""],
      ["obsolete-canonical-null", null],
    ] as const) {
      await expect(
        closeIssue(context, created.issueId, "obsolete", { ...evidence, canonicalIssueId }, {
          operationId, actor: "project-manager", expectedRevision: created.revision,
        }),
      ).rejects.toMatchObject({ code: "issue.invalid-disposition" });
    }

    // Nothing above wrote: the issue is still open at its original revision.
    const untouched = await getIssue(context, created.issueId);
    expect(untouched.disposition).toBe("open");
    expect(untouched.revision).toBe(created.revision);
    expect(untouched.transitions).toEqual([]);

    const closed = await closeIssue(context, created.issueId, "obsolete", evidence, {
      operationId: "obsolete-ok", actor: "project-manager", expectedRevision: created.revision,
    });
    const detail = await getIssue(context, created.issueId);
    expect(detail.disposition).toBe("obsolete");
    expect(detail.closureNote).toBe(evidence.reason);
    // The disposition and its removal evidence are recorded verbatim.
    expect(detail.transitions).toHaveLength(1);
    expect(detail.transitions[0]).toMatchObject({
      fromDisposition: "open",
      toDisposition: "obsolete",
      reason: evidence.reason,
      evidence: { reason: evidence.reason, references: evidence.references, canonicalIssueId: null, alignmentRef: null },
    });
    // It is listed as its own disposition and reported (not resolved) in reads.
    expect((await listIssues(context, { disposition: "obsolete" })).items.map((row) => row.id)).toEqual([created.issueId]);
    expect((await listIssues(context, { disposition: "resolved" })).items).toEqual([]);

    // Reopen stays available, exactly like the other terminal states.
    const reopened = await reopenIssue(context, created.issueId, { reason: "the subject came back" }, {
      operationId: "obsolete-reopen", actor: "project-manager", expectedRevision: closed.revision,
    });
    expect((await getIssue(context, created.issueId)).disposition).toBe("open");
    expect(reopened.revision).toBe(closed.revision + 1);
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
    const afterPlan1 = await linkIssueScoped(
      context,
      created.issueId,
      { kind: "plan", target: authority.planId },
      pmMut(authority, "link-a", { expectedRevision: created.revision }),
    );
    const afterPlan2 = await linkIssueScoped(
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
  test("unscoped plan label neither satisfies membership nor creates a multi-plan obligation", async () => {
    const authority = await liveAuthority("relation-unscoped-plan-");
    const context: StoreContext = { harnessDir: authority.harness };
    const created = await captureIssue(context, baseInput(), mut("cap-unscoped-plan"));
    const linked = await linkIssueScoped(
      context,
      created.issueId,
      { kind: "plan", target: authority.planId },
      pmMut(authority, "unscoped-primary", { expectedRevision: created.revision }),
    );
    await linkIssue(
      context,
      created.issueId,
      { kind: "plan", target: authority.peerPlanId },
      pmMut(authority, "unscoped-poison", { expectedRevision: linked.revision }),
    );

    await readCollab(context, (db) => {
      assertIssueLinkedToPlanOn(db, created.issueId, authority.planId);
      expect(() => assertIssueLinkedToPlanOn(db, created.issueId, authority.peerPlanId)).toThrow(
        expect.objectContaining({ code: "issue.scope-refused" }),
      );
    });
    await closeIssue(
      context,
      created.issueId,
      "resolved",
      { reason: "single plan complete", references: [authority.planId], alignmentRef: "QA gate: Approve" },
      pmMut(authority, "close-single-plan", { expectedRevision: linked.revision + 1 }),
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
    expect(detail.relations[0]!.fromIssue < detail.relations[0]!.toIssue!).toBe(true);
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

describe("the disposition vocabulary is one authored tuple", () => {
  test("open plus every terminal is the whole set, and obsolete is terminal exactly once", () => {
    expect([...ISSUE_DISPOSITIONS]).toEqual(["open", ...TERMINAL_DISPOSITIONS]);
    expect(TERMINAL_DISPOSITIONS.filter((value) => value === "obsolete")).toHaveLength(1);
    // The published registry and both assert paths read the same tuple, so a new
    // disposition is accepted the moment it is declared — and an invented one is
    // refused by the derived maps rather than an independent list.
    const references = ISSUE_PAYLOAD_SCHEMAS.ClosureEvidence.references;
    expect(references.requiredWhen).toEqual(expect.arrayContaining(["resolved", "obsolete"]));
    expect(references.minItems).toBe(1);
    for (const disposition of TERMINAL_DISPOSITIONS) expect(() => assertTerminalDisposition(disposition)).not.toThrow();
    expect(() => assertTerminalDisposition("gone" as never)).toThrow(
      expect.objectContaining({ code: "issue.invalid-disposition", message: expect.stringContaining("obsolete") }),
    );
  });
});

describe("issue action vocabulary", () => {
  test("one table owns the tokens, the payload registry links and the closure defaults", () => {
    // Golden list: these tokens are a published surface, so a change here must
    // be deliberate rather than a copy drifting.
    expect(ISSUE_ACTION_NAMES).toEqual([
      "add", "list", "show", "occurrence", "triage", "close", "reopen", "move", "waive", "duplicate", "supersede", "link", "export",
    ]);
    const registry = Object.keys(ISSUE_PAYLOAD_SCHEMAS);
    for (const [verb, action] of Object.entries(ISSUE_ACTIONS)) {
      if (action.payload !== null) expect(registry).toContain(action.payload);
      else expect(action.read).toBe(true);
      if (action.disposition !== null) expect(["close", "waive", "duplicate", "supersede"]).toContain(verb);
    }
    expect(ISSUE_ACTION_NAMES.filter((verb) => ISSUE_ACTIONS[verb].read)).toEqual(["list", "show", "export"]);
    expect(ISSUE_ACTION_NAMES.filter((verb) => ISSUE_ACTIONS[verb].cas)).toEqual(["triage", "close", "reopen", "move", "waive", "duplicate", "supersede", "link"]);
    expect(ISSUE_ACTION_NAMES.flatMap((verb) => {
      const disposition = ISSUE_ACTIONS[verb].disposition;
      return disposition === null ? [] : [[verb, disposition]];
    })).toEqual([["close", "resolved"], ["waive", "waived"], ["duplicate", "duplicate"], ["supersede", "superseded"]]);
  });
});

// ---------------------------------------------------------------------------
// note: Remote selection: portable reference, native detail and a refused write path
// ---------------------------------------------------------------------------

describe("remote issue reads", () => {
  test("a remote checkout reads admitted findings and keeps an unmarked issue visible", async () => {
    const fixture = createRemoteScope(ROOT, "issue-remote");
    const commit = fixture.publish();
    const context = fixture.context();
    await bindRemoteAuthority(context, fixture.batch(commit));
    const check = positiveCheck();
    await ingestRemoteObservation(context, submission(commit, check, completeSnapshot(check), 0));

    const page = await listIssues(context, {});
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ id: REMOTE_IDS.issueRef, issueRef: REMOTE_IDS.issueRef, nativeStatus: "Todo" });
    expect(page.providerIssues).toEqual([
      expect.objectContaining({ kind: "provider-only", issueRef: null, nativeStatus: "Done" }),
    ]);
    expect(page.collaboration).toMatchObject({ source: "remote", completeness: "complete" });

    const shown = await showIssue(context, REMOTE_IDS.issueRef);
    expect(shown).toMatchObject({ issueRef: REMOTE_IDS.issueRef, projectId: REMOTE_IDS.projectId });
    const native = await showIssue(context, REMOTE_IDS.providerOnlyIssueId, REMOTE_IDS.projectId);
    expect(native).toMatchObject({ kind: "provider-only", issueRef: null, nativeStatus: "Done" });

    // invariant: The unmarked issue has no MStar detail; a display id and a guessed project never resolve.
    await expect(getIssue(context, REMOTE_IDS.providerOnlyIssueId)).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(showIssue(context, REMOTE_IDS.providerOnlyIssueId)).rejects.toMatchObject({ code: "issue.scope-refused" });
    await expect(showIssue(context, "I-000001", REMOTE_IDS.projectId)).rejects.toMatchObject({ code: "issue.scope-refused" });

    // invariant: A remote closure is never a local write: it freezes one outbox intent and reports
    // the pending effect. The CAS baseline is mandatory, and a missing one writes nothing.
    await expect(
      closeIssue(
        context,
        REMOTE_IDS.issueRef,
        "resolved",
        { reason: "native done", references: ["native-status"], alignmentRef: "fixture" },
        { operationId: crypto.randomUUID(), actor: "project-manager" },
      ),
    ).rejects.toMatchObject({ code: "issue.revision-conflict" });
    await expect(
      closeIssue(
        context,
        REMOTE_IDS.issueRef,
        "resolved",
        { reason: "native done", references: ["native-status"], alignmentRef: "fixture" },
        { operationId: crypto.randomUUID(), actor: "project-manager", expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "remote.effect-pending" });
  });

  test("provider-only issues answer the requested bounded, stably ordered page", async () => {
    const fixture = createRemoteScope(ROOT, "issue-remote-page");
    const commit = fixture.publish();
    const context = fixture.context();
    await bindRemoteAuthority(context, fixture.batch(commit));
    const check = positiveCheck();
    const base = completeSnapshot(check);
    const native = (issueId: string, title: string, providerUpdatedAt: string) => ({
      identity: { ...check.scope, issueId },
      nativeTitle: title,
      nativeStatus: "Todo",
      providerUpdatedAt,
      mstar: null,
    });
    const snapshot: RemoteSnapshot = {
      ...base,
      issues: [
        ...base.issues,
        native("aaaaaaaa-0000-4000-8000-000000000001", "Native newest", "2026-11-20T00:00:01.000Z"),
        native("aaaaaaaa-0000-4000-8000-000000000002", "Native middle", "2026-11-20T00:00:00.500Z"),
        native("aaaaaaaa-0000-4000-8000-000000000003", "Native oldest", "2026-11-19T00:00:00.000Z"),
      ],
    };
    await ingestRemoteObservation(context, submission(commit, check, snapshot, 0));

    // invariant: The MStar total stays its own; the provider list honours the same page, ordered
    // by provider update so an offset names the same rows on a re-read.
    const first = await listIssues(context, { limit: 2 });
    expect(first.total).toBe(1);
    expect(first.providerIssues?.map((issue) => issue.title)).toEqual(["Native newest", "Native middle"]);

    const second = await listIssues(context, { limit: 2, offset: 2 });
    expect(second.providerIssues?.map((issue) => issue.title)).toEqual(["Unmarked native issue", "Native oldest"]);

    const last = await listIssues(context, { limit: 1, offset: 3 });
    expect(last.providerIssues?.map((issue) => issue.title)).toEqual(["Native oldest"]);
  });

  test("provider-only pages order mixed timestamp spellings by instant", async () => {
    const fixture = createRemoteScope(ROOT, "issue-remote-page-instants");
    const commit = fixture.publish();
    const context = fixture.context();
    await bindRemoteAuthority(context, fixture.batch(commit));
    const check = positiveCheck();
    const base = completeSnapshot(check);
    const native = (issueId: string, title: string, providerUpdatedAt: string) => ({
      identity: { ...check.scope, issueId },
      nativeTitle: title,
      nativeStatus: "Todo",
      providerUpdatedAt,
      mstar: null,
    });
    const snapshot: RemoteSnapshot = {
      ...base,
      issues: [
        // note: Only MStar subjects carry findings semantics; the page's native arm is under test.
        ...base.issues.filter((issue) => issue.mstar !== null),
        // invariant: Within one second `00.500Z` is NEWER than whole-second `00Z`; a text
        // comparison puts `Z` after `.` and would page the earlier issue first.
        native("aaaaaaaa-0000-4000-8000-000000000001", "Fractional half", "2026-11-20T00:00:00.500Z"),
        native("aaaaaaaa-0000-4000-8000-000000000002", "Whole second", "2026-11-20T00:00:00Z"),
        native("aaaaaaaa-0000-4000-8000-000000000003", "Earlier", "2026-11-19T23:59:59.999Z"),
      ],
    };
    await ingestRemoteObservation(context, submission(commit, check, snapshot, 0));

    const first = await listIssues(context, { limit: 1 });
    expect(first.providerIssues?.map((issue) => issue.title)).toEqual(["Fractional half"]);
    const second = await listIssues(context, { limit: 2, offset: 1 });
    expect(second.providerIssues?.map((issue) => issue.title)).toEqual(["Whole second", "Earlier"]);
  });
});

describe("cross-authority relations", () => {
  /**
   * note: An ACTIVE lane of an unrelated repository, the destination of a first hop: no checkout,
   * only the catalog project the admission needs.
   */
  async function bareLane(repoKey: string, projectId: string): Promise<void> {
    const location = collaborationLocationOfRepoKey(repoKey, "local");
    mkdirSync(join(location.dbPath, ".."), { recursive: true, mode: 0o700 });
    await initializeCollaborationStore(location);
    await writeCollaborationStage(location, ({ db }) => {
      db.prepare("update collaboration_meta set authority_state = 'active' where id = 1").run();
      db.prepare(
        "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) " +
          "values ('project', ?, ?, 'projects', ?, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
      ).run(projectId, projectId, `projects/${projectId}`);
    });
  }

  /** note: Register one project in the lane of a bound checkout (admission lands on it). */
  async function registerLaneProject(context: StoreContext, projectId: string): Promise<void> {
    await withCollaborationWrite(context, ({ db }) => {
      db.prepare(
        "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) " +
          "values ('project', ?, ?, 'projects', ?, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
      ).run(projectId, projectId, `projects/${projectId}`);
    });
  }

  test("an unresolved relation reads toIssue null with the target's reference, and a local one is unchanged", async () => {
    const context = ctx("unresolved-relation-");
    await activeIssueStore(context);
    const a = await captureIssue(context, baseInput(), mut("cap-unres-a"));
    const b = await captureIssue(
      context,
      baseInput({ occurrenceKey: "unres-b", rootCauseKey: "unres-other", title: "Staying" }),
      mut("cap-unres-b"),
    );
    await linkIssue(context, a.issueId, { relation: "related", issueId: b.issueId }, { ...mut("link-local"), expectedRevision: a.revision });

    const aRefRow = await readCollab(context, (db) => db.prepare("select issue_ref from issues where id = ?").get(a.issueId));
    const aRef = (aRefRow as { issue_ref: string }).issue_ref;
    const gone = "mstar:issue:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    // note: The row publication rewrites an edge into: the record whose reference is not in this
    // lane is named by `to_ref` with `to_issue` null.
    await seedCollab(context, (db) => {
      db.prepare("insert into relations(from_issue, relation, to_ref) values (?, 'blocks', ?)").run(a.issueId, gone);
    });

    const detail = await getIssue(context, a.issueId);
    // invariant: The detail read now names the stable reference the lane holds for this record.
    expect(detail.issueRef).toBe(aRef);
    expect(detail.relations).toContainEqual({ fromIssue: a.issueId, relation: "related", toIssue: b.issueId, toRef: null, title: "Staying" });
    expect(detail.relations).toContainEqual({ fromIssue: a.issueId, relation: "blocks", toIssue: null, toRef: gone, title: null });
  });

  test("a switched source record is refused by the domain read with collaboration.operation-partial", async () => {
    const context = ctx("switched-refusal-");
    await activeIssueStore(context);
    const a = await captureIssue(context, baseInput(), mut("cap-switched"));
    const repoKey = resolveCollaborationLocation(context).repoKey;
    const aRefRow = await readCollab(context, (db) => db.prepare("select issue_ref from issues where id = ?").get(a.issueId));
    const aRef = (aRefRow as { issue_ref: string }).issue_ref;
    await seedCollab(context, (db) => {
      db.prepare(
        "insert into issue_moves(operation_id, role, request_hash, issue_ref, source_issue_id, destination_issue_id, " +
          "source_authority, destination_authority, destination_project, actor, reason, phase, payload_json, payload_digest, " +
          "staged_counts, source_store_id, source_epoch, created_at, updated_at) " +
          "values ('move-refusal', 'source', 'hash', ?, ?, 'I-000001', ?, 'github.com/acme/elsewhere', 'p-dest', " +
          "'project-manager', 'moved on', 'switched', '{}', 'digest', '{}', 'store-one', 1, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')",
      ).run(aRef, a.issueId, repoKey);
    });

    const refused = await getIssue(context, a.issueId).then(
      () => null,
      (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
    );
    expect(refused?.code).toBe("collaboration.operation-partial");
    expect(refused?.details).toMatchObject({ phase: "switched", operation_id: "move-refusal" });
  });

  test("a canonical related swap replaces the unresolved edge stored from the local issue", async () => {
    // invariant: `related` is stored in canonical order, but an unresolved edge is stored from whichever
    // LOCAL issue asked for it. When the target's display id sorts lower, the canonical write swaps the
    // sides — so the stale-edge lookup must address the ORIGINAL local issue, or it misses the row it
    // was meant to replace and leaves both spellings of one logical relation.
    const context = ctx("related-swap-");
    await activeIssueStore(context);
    const lower = await captureIssue(
      context,
      baseInput({ occurrenceKey: "swap-lower", rootCauseKey: "swap-lower", title: "Lower target" }),
      mut("cap-swap-lower"),
    );
    const higher = await captureIssue(
      context,
      baseInput({ occurrenceKey: "swap-higher", rootCauseKey: "swap-higher", title: "Higher local" }),
      mut("cap-swap-higher"),
    );
    // note: The canonical swap under test: the local issue we link FROM is the higher display id, so
    // the resolved row is stored from `lower`. The unresolved row is stored from `higher`, as a local
    // writer does when the target is not in the lane yet.
    expect(higher.issueId > lower.issueId).toBe(true);
    const lowerRef = (await readCollab(context, (db) =>
      db.prepare("select issue_ref from issues where id = ?").get(lower.issueId))) as { issue_ref: string };
    await seedCollab(context, (db) => {
      db.prepare("insert into relations(from_issue, relation, to_ref) values (?, 'related', ?)").run(
        higher.issueId,
        lowerRef.issue_ref,
      );
    });

    await linkIssue(
      context,
      higher.issueId,
      { relation: "related", issueId: lower.issueId },
      { ...mut("link-swap"), expectedRevision: higher.revision },
    );

    // invariant: One logical relation, in exactly one spelling, with no `to_ref` row left behind.
    const detail = await getIssue(context, higher.issueId);
    expect(detail.relations).toEqual([
      { fromIssue: lower.issueId, relation: "related", toIssue: higher.issueId, toRef: null, title: "Lower target" },
    ]);
    expect(
      await readCollab(context, (db) => db.prepare("select count(*) as n from relations where to_ref = ?").get(lowerRef.issue_ref)),
    ).toEqual({ n: 0 });
  });

  test("an unresolved edge resolves in the transaction that admits its target back into the lane", async () => {
    const context = ctx("arrival-source-");
    await activeIssueStore(context);
    await initializeStore(context).then((handle) => handle.close());

    // note: The record that leaves, then returns.
    const moving = await captureIssue(context, baseInput({ title: "Moving target" }), mut("cap-arrival-t"));
    const staying = await captureIssue(
      context,
      baseInput({ occurrenceKey: "arrival-b", rootCauseKey: "arrival-staying", title: "Staying" }),
      mut("cap-arrival-b"),
    );
    await linkIssue(context, staying.issueId, { relation: "blocks", issueId: moving.issueId }, { ...mut("link-arrival"), expectedRevision: staying.revision });

    // note: The first hop's destination lane is keyed by the SECOND checkout's repository: a
    // checkout may write only the lane it is bound to, so the checkout below is the one that
    // moves the record back into this lane.
    const bound = ctx("arrival-second-");
    const boundContext: StoreContext = { harnessDir: bound.harnessDir, checkoutRoot: bound.checkoutRoot };
    const boundLocation = resolveCollaborationLocation(boundContext);
    const hopOne = boundLocation.repoKey;
    await bareLane(hopOne, "p-dest");
    await moveAcrossAuthorities(context, {
      operationId: "move-out",
      actor: "project-manager",
      sourceIssueId: moving.issueId,
      destinationAuthority: hopOne,
      destinationProject: "p-dest",
      reason: "to the other authority",
    });

    // invariant: Publication left the staying record's edge in the unresolved shape.
    const unresolved = await getIssue(context, staying.issueId);
    expect(unresolved.relations).toHaveLength(1);
    expect(unresolved.relations[0]).toMatchObject({
      fromIssue: staying.issueId,
      relation: "blocks",
      toIssue: null,
      title: null,
    });
    const movingRef = unresolved.relations[0]!.toRef!;
    expect(movingRef).toMatch(/^mstar:issue:/);

    // note: The display id the hop allocated is recorded on that lane's destination row.
    const admitted = new DatabaseSync(boundLocation.dbPath);
    let admittedId: string;
    try {
      const moveRow = admitted
        .prepare("select destination_issue_id as id from issue_moves where operation_id = 'move-out'")
        .get() as { id: string };
      admittedId = moveRow.id;
    } finally {
      admitted.close();
    }
    // note: The bound checkout needs the same two stores any source checkout does: its execution
    // store for the composite, and the collaboration binding to the lane the record lives in.
    await initializeStore(boundContext).then((handle) => handle.close());
    activate(boundContext);
    await registerLaneProject(context, "proj-a");
    await moveAcrossAuthorities(boundContext, {
      operationId: "move-back",
      actor: "project-manager",
      sourceIssueId: admittedId,
      destinationAuthority: resolveCollaborationLocation(context).repoKey,
      destinationProject: "proj-a",
      reason: "back to the first authority",
    });

    // invariant: The same transaction that admitted the record localised the edge: it is a plain
    // local relation now, under the new display id, with no leftover `to_ref` spelling.
    const resolved = await getIssue(context, staying.issueId);
    const [edge] = resolved.relations;
    expect(resolved.relations).toHaveLength(1);
    expect(edge?.relation).toBe("blocks");
    expect(edge?.toIssue).not.toBeNull();
    expect(edge?.toRef).toBeNull();
    expect(edge?.title).toBe("Moving target");
    expect(
      await readCollab(context, (db) => db.prepare("select count(*) as n from relations where to_ref = ?").get(movingRef)),
    ).toEqual({ n: 0 });
  }, 120_000);
});
