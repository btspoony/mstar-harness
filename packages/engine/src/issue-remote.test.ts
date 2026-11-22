/**
 * issue-remote.test.ts — the remote issue-write gates the local lanes already answer.
 *
 * Run with `bun test packages/engine/src/issue-remote.test.ts`.
 *
 * Cases drive the REAL remote boundary against a real bound checkout (the shared
 * remote-scope fixture): one complete observation, the real outbox freeze, and the
 * real receipts. They prove:
 *
 * - I-001224: a recurring remote capture resolves the established occurrence or the
 *   established identity before any create — same occurrence answers the established
 *   receipt, same identity appends through ONE issue-replace, only a new identity
 *   enqueues issue-create, and a reused key refuses like the local body does.
 * - I-001225: remote closure answers the local open-state gate (a terminal issue is
 *   never closed again, so no transition records `fromDisposition: "open"`) and the
 *   multi-plan acceptance gate against the observed project's plan links.
 * - I-001226: a remote milestone assignment compares `--expect-store` with the observed
 *   store revision before enqueueing, exactly like the local `withWrite` branch.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeOs from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import {
  bindRemoteAuthority,
  ingestRemoteObservation,
  setRemoteWriteScopeGapForTest,
  type RemoteSnapshot,
} from "./collaboration-remote.js";
import { assignIssueMilestone, captureIssue, closeIssue, showIssue, type CaptureInput, type ClosureEvidence } from "./issue.js";
import {
  completeSnapshot,
  confirmFrozenIntent,
  createRemoteScope,
  FIXTURE_AT,
  positiveCheck,
  REMOTE_IDS,
  submission,
} from "./remote-scope.fixture.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  readExecutionPlan,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionSessionRef,
  type ExecutionToken,
} from "./execution-store.js";
import { mutateExecutionPlan } from "./execution-coordination.js";
import type { WorkflowSnapshot } from "./workflow.js";
import type { WorkflowEntry } from "./status.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-issue-remote-"));
const HOME = join(ROOT, "home");

let homeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  mkdirSync(HOME, { recursive: true });
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

/** note: The phases of every recorded reservation for one operation id. */
async function intentPhases(context: StoreContext, operationId: string): Promise<string[]> {
  const handle = await openStore(context, "read");
  try {
    const rows = handle.db
      .prepare("select phase from execution_collaboration_intents where operation_id = ? order by created_at")
      .all(operationId);
    return rows.map((row) => String((row as Record<string, unknown>).phase));
  } finally {
    handle.close();
  }
}

/** note: The cache's outbox rows, newest last, as the verbs froze them. */
function outboxRows(context: StoreContext): Array<Record<string, unknown>> {
  const db = new DatabaseSync(resolveCollaborationLocation(context).dbPath);
  try {
    return db
      .prepare("select operation_id, state, request_json from remote_outbox order by created_at, operation_id")
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function frozenChange(row: Record<string, unknown>): { kind: string; issueRef: string; mstar: Record<string, unknown> } {
  return (JSON.parse(String(row.request_json)) as { event: { change: { kind: string; issueRef: string; mstar: Record<string, unknown> } } }).event.change;
}

/** note: One refusal as its envelope: the test's own failure when nothing refused. */
async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; message: string; details?: unknown }> {
  try {
    await run();
  } catch (error) {
    return error as { code: string; message: string; details?: unknown };
  }
  throw new Error("fixture: the operation should have refused");
}

type RemoteFixture = Readonly<{
  scope: ReturnType<typeof createRemoteScope>;
  commit: string;
  context: StoreContext;
}>;

/** note: The observed fixture issue rewritten to a terminal disposition, as a closed provider record carries it. */
function withTerminalSubject(snapshot: RemoteSnapshot): RemoteSnapshot {
  const [first, ...rest] = snapshot.issues;
  if (first === undefined || first.mstar === null) return snapshot;
  return {
    ...snapshot,
    issues: [
      { ...first, mstar: { ...first.mstar, fields: { ...first.mstar.fields, disposition: "resolved" } } },
      ...rest,
    ],
  };
}

/** note: The observed fixture issue linked to a SECOND plan, so closure needs the whole acceptance. */
function withSecondPlanLink(snapshot: RemoteSnapshot): RemoteSnapshot {
  const [first, ...rest] = snapshot.issues;
  if (first === undefined || first.mstar === null) return snapshot;
  return {
    ...snapshot,
    issues: [
      {
        ...first,
        mstar: {
          ...first.mstar,
          provenance: [
            ...first.mstar.provenance,
            {
              eventId: "55555555-5555-4555-8555-555555555555",
              kind: "plan",
              target: "20261122-second-plan",
              sourceHash: "4".repeat(64),
              origin: "scoped",
              legacyProject: null,
              legacyBucket: null,
              legacyRecord: null,
              importedAt: null,
            },
          ],
        },
      },
      ...rest,
    ],
  };
}

/**
 * A second MARKED observed issue beside the fixture's own, so a duplicate/superseded
 * closure has a canonical target that carries a portable reference the frozen relation
 * can name.
 */
function withCanonicalTarget(snapshot: RemoteSnapshot): RemoteSnapshot {
  const [first, second, ...rest] = snapshot.issues;
  if (first === undefined || first.mstar === null) return snapshot;
  return {
    ...snapshot,
    issues: [
      first,
      {
        ...first,
        identity: { ...first.identity, issueId: "88888888-8888-4888-8888-888888888888" },
        nativeTitle: "Canonical native title",
        mstar: {
          ...first.mstar,
          issueRef: "mstar:issue:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          head: ["4".repeat(64)],
          occurrences: [],
          transitions: [],
          relations: [],
          provenance: [],
          projectMoves: [],
        },
      },
      ...(second === undefined ? [] : [second]),
      ...rest,
    ],
  };
}

/**
 * The fixture's provider-only issue carrying the capture's occurrence as its genesis subject,
 * exactly as a re-observation would install it between a capture's dedupe read and its freeze:
 * the identity the old snapshot did not carry is now marked on the authority.
 */
function withAdoptedOccurrence(snapshot: RemoteSnapshot, overrides: Partial<CaptureInput> = {}): RemoteSnapshot {
  const input = captureInput(overrides);
  return {
    ...snapshot,
    issues: snapshot.issues.map((issue) =>
      issue.mstar === null && issue.identity.issueId === REMOTE_IDS.providerOnlyIssueId
        ? {
            ...issue,
            mstar: {
              issueRef: "mstar:issue:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              head: ["7".repeat(64)],
              fields: {
                title: input.title,
                kind: input.kind,
                severity: input.severity,
                disposition: "open",
                impact: input.impact,
                acceptance: input.acceptance,
                owner: null,
                registeredAt: FIXTURE_AT,
                closedAt: null,
                closureNote: null,
                createdAt: FIXTURE_AT,
                updatedAt: FIXTURE_AT,
                revision: 1,
                milestoneId: null,
              },
              occurrences: [
                {
                  eventId: "11111111-1111-4111-8111-199999999999",
                  occurrenceKey: input.occurrenceKey,
                  sourceKind: input.sourceKind,
                  sourceIdentity: input.sourceIdentity,
                  rootCauseKey: input.rootCauseKey,
                  acceptanceKey: input.acceptanceKey,
                  location: input.location,
                  observedBehavior: input.observedBehavior,
                  evidence: input.evidence,
                  discoveredAt: input.discoveredAt,
                  recordedAt: FIXTURE_AT,
                  imported: false,
                },
              ],
              transitions: [],
              relations: [],
              provenance: [],
              projectMoves: [],
            },
          }
        : issue,
    ),
  };
}

/**
 * The observed marked issue carrying ONE more occurrence, exactly as a re-observation would
 * install it between a capture's dedupe read and its freeze: the same identity triple, the given
 * occurrence key, and content that matches the capture input built from the same overrides.
 */
function withExtraOccurrence(snapshot: RemoteSnapshot, overrides: Partial<CaptureInput> = {}): RemoteSnapshot {
  const input = captureInput(overrides);
  const [first, ...rest] = snapshot.issues;
  if (first === undefined || first.mstar === null) return snapshot;
  return {
    ...snapshot,
    issues: [
      {
        ...first,
        mstar: {
          ...first.mstar,
          occurrences: [
            ...first.mstar.occurrences,
            {
              eventId: "11111111-1111-4111-8111-199999999999",
              occurrenceKey: input.occurrenceKey,
              sourceKind: input.sourceKind,
              sourceIdentity: input.sourceIdentity,
              rootCauseKey: input.rootCauseKey,
              acceptanceKey: input.acceptanceKey,
              location: input.location,
              observedBehavior: input.observedBehavior,
              evidence: input.evidence,
              discoveredAt: input.discoveredAt,
              recordedAt: FIXTURE_AT,
              imported: false,
            },
          ],
        },
      },
      ...rest,
    ],
  };
}

/**
 * The plan provenance one composite's own scope check reads: the residual-close
 * remote half refuses an issue whose observed subject names no link to THIS plan,
 * so the fixture subjects name the link before any gate below it can answer.
 */
function withResidualPlanLinks(snapshot: RemoteSnapshot): RemoteSnapshot {
  const [first, ...rest] = snapshot.issues;
  if (first === undefined || first.mstar === null) return snapshot;
  const link = (target: string, eventId: string, hashSeed: string) => ({
    eventId,
    kind: "plan",
    target,
    sourceHash: hashSeed,
    origin: "scoped",
    legacyProject: null,
    legacyBucket: null,
    legacyRecord: null,
    importedAt: null,
  });
  return {
    ...snapshot,
    issues: [
      {
        ...first,
        mstar: {
          ...first.mstar,
          provenance: [
            link(RESIDUAL_PLAN_ID, "66666666-6666-4666-8666-666666666661", "5".repeat(64)),
            link("20261122-second-plan", "66666666-6666-4666-8666-666666666662", "4".repeat(64)),
          ],
        },
      },
      ...rest,
    ],
  };
}

/**
 * One bound checkout whose cache holds one complete observation. `mutate` adjusts the
 * observed subject before ingest (a terminal disposition, extra plan links), the same
 * way the Host Agent's snapshot would differ.
 */
async function remoteFixture(
  label: string,
  mutate?: (snapshot: RemoteSnapshot) => RemoteSnapshot,
): Promise<RemoteFixture> {
  const scope = createRemoteScope(ROOT, label);
  const commit = scope.publish();
  const context = scope.context();
  await bindRemoteAuthority(context, scope.batch(commit));
  const check = positiveCheck();
  const snapshot = mutate ? mutate(completeSnapshot(check)) : completeSnapshot(check);
  await ingestRemoteObservation(context, submission(commit, check, snapshot, 0));
  await initializeStore(context).then((handle) => handle.close());
  return { scope, commit, context };
}

/** note: The observed fixture occurrence, exactly as the complete snapshot froze it. */
function captureInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    projectId: REMOTE_IDS.projectId,
    title: "Recurring finding",
    kind: "bug",
    severity: "high",
    impact: "the provider holds a duplicate",
    acceptance: "the recurrence attaches to the established issue",
    sourceIdentity: "review:fixture",
    rootCauseKey: "remote.observation",
    acceptanceKey: "remote.observation.stored",
    occurrenceKey: "occurrence-one",
    sourceKind: "review",
    location: "packages/engine/src/collaboration-remote.ts",
    observedBehavior: "The store refused a complete scope.",
    evidence: ["review-fixture"],
    discoveredAt: FIXTURE_AT,
    ...overrides,
  };
}

const resolvedEvidence: ClosureEvidence = {
  reason: "verified",
  references: ["qa/run.md"],
  alignmentRef: "QA gate: Approve",
};

/** note: The plan-scoped residual-close composite's own target id, as every plan row names it. */
const RESIDUAL_PLAN_ID = "20261121-issue-remote-residual";
const RESIDUAL_WORKFLOW_ID = "wf-issue-remote";

type RemotePlanFixture = RemoteFixture & {
  caller: ExecutionCaller;
  session: ExecutionSessionRef;
  token: () => Promise<ExecutionToken>;
};

/**
 * One remote-bound checkout that also holds an ACTIVE execution workflow and plan row,
 * so the residual-close composite can run its remote half against the observed subject.
 */
async function remotePlanFixture(
  label: string,
  mutate?: (snapshot: RemoteSnapshot) => RemoteSnapshot,
): Promise<RemotePlanFixture> {
  const fixture = await remoteFixture(label, mutate);
  const harnessDir = fixture.context.harnessDir;
  const compassRef = "iterations/iter-issue-remote/delivery-compass.md";
  mkdirSync(dirname(join(harnessDir, compassRef)), { recursive: true });
  writeFileSync(join(harnessDir, compassRef), [
    "---",
    "iteration_id: iter-issue-remote",
    "start_date: 2026-11-21",
    "status: active",
    "iteration_base_branch: main",
    "target_branch: main",
    `plans: [${RESIDUAL_PLAN_ID}]`,
    "---",
    "",
    "# iter-issue-remote",
    "",
  ].join("\n"));
  const integrationPath = join(dirname(harnessDir), "integration-issue-remote");
  execFileSync("git", ["worktree", "add", "-q", "-b", "integration/issue-remote", integrationPath], { cwd: fixture.scope.repo, stdio: "ignore" });
  const caller: ExecutionCaller = { sessionId: "coordinator-issue-remote", role: "coordinator", workflowId: RESIDUAL_WORKFLOW_ID };
  const executionContext = { harnessDir, caller };
  const state = await readExecutionState(fixture.context);
  const created = await createExecutionWorkflow(executionContext, {
    entry: { id: RESIDUAL_WORKFLOW_ID, type: "plan", started_at: "2026-11-21T00:00:00.000Z", dir: `workflows/${RESIDUAL_WORKFLOW_ID}` } as WorkflowEntry,
    snapshot: {
      schema_version: 1,
      id: RESIDUAL_WORKFLOW_ID,
      type: "plan",
      status: "running",
      started_at: "2026-11-21T00:00:00.000Z",
      phase: "phase-1-prepare",
      project: "harness",
      compass_ref: compassRef,
      updated_at: "2026-11-21T00:00:00.000Z",
      delivery_kind: "development",
      branch: { base: "main", source: "feature/issue-remote", target: "main", integration: "integration/issue-remote" },
      integration_worktree_path: integrationPath,
      execution_policy: { plan_parallelism: "serial", worktree_mode: "required" },
      plans: [{ id: RESIDUAL_PLAN_ID, title: "Residual plan", file: `plans/${RESIDUAL_PLAN_ID}.md`, status: "Todo", metadata: { working_branch: "feature/issue-remote" } }],
    } as unknown as WorkflowSnapshot,
    expected: state.token,
    operationId: `create-${label}`,
  });
  const workflow = created.data.workflows[0];
  if (workflow === undefined) throw new Error("fixture: workflow registration returned no workflow");
  const session = (await bindExecutionSession(executionContext, {
    workflowId: RESIDUAL_WORKFLOW_ID,
    expected: workflow.workflowToken,
    operationId: `bind-${label}`,
  })).data;
  const token = async (): Promise<ExecutionToken> =>
    (await readExecutionPlan(executionContext, session, RESIDUAL_PLAN_ID)).token;
  return { ...fixture, caller, session, token };
}

function residualCloseRequest(
  fixture: RemotePlanFixture,
  operationId: string,
  evidence: ClosureEvidence,
): Parameters<typeof mutateExecutionPlan>[1] {
  return {
    operationId,
    session: fixture.session,
    expected: undefined,
    planId: RESIDUAL_PLAN_ID,
    operation: {
      kind: "residual-close" as const,
      issueId: REMOTE_IDS.markedIssueId,
      disposition: "resolved" as const,
      expectedIssueRevision: 1,
      evidence,
    },
  };
}

// ---------------------------------------------------------------------------
// I-001224 — remote capture dedupe
// ---------------------------------------------------------------------------

test("a recurring remote capture returns the established occurrence without a second create", async () => {
  const fixture = await remoteFixture("capture-established");
  const receipt = await captureIssue(fixture.context, captureInput(), { operationId: "30000000-0000-4000-8000-000000000001", actor: "project-manager" });
  expect(receipt).toMatchObject({
    issueId: REMOTE_IDS.markedIssueId,
    occurrenceId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    storeRevision: 0,
    created: false,
  });
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("the same identity appends one occurrence through one issue-replace", async () => {
  const fixture = await remoteFixture("capture-append");
  const refused = await refusalOf(() =>
    captureIssue(fixture.context, captureInput({ occurrenceKey: "run-2" }), { operationId: "30000000-0000-4000-8000-000000000002", actor: "project-manager" }),
  );
  expect(refused.code).toBe("remote.effect-pending");
  const rows = outboxRows(fixture.context);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "enqueued" });
  const change = frozenChange(rows[0]!);
  expect(change.kind).toBe("issue-replace");
  expect(change.issueRef).toBe(REMOTE_IDS.issueRef);
  const occurrences = change.mstar.occurrences as Array<Record<string, unknown>>;
  expect(occurrences).toHaveLength(2);
  expect(occurrences[0]).toMatchObject({ occurrenceKey: "occurrence-one" });
  expect(occurrences[1]).toMatchObject({ occurrenceKey: "run-2" });

  // invariant: The confirmed append receipt answers the observed occurrence: the recorded
  // provider effect, not a pending row, is the business outcome a replay reports, and the
  // receipt's occurrenceId names the occurrence ACTUALLY in the confirmed event.
  await confirmFrozenIntent(fixture.context, rows[0]!.operation_id as string);
  const appendedEventId = (occurrences[1] as Record<string, unknown>).eventId;
  const confirmed = await captureIssue(fixture.context, captureInput({ occurrenceKey: "run-2" }), {
    operationId: "30000000-0000-4000-8000-000000000002",
    actor: "project-manager",
  });
  expect(confirmed).toMatchObject({
    issueId: REMOTE_IDS.markedIssueId,
    occurrenceId: appendedEventId,
    revision: 2,
    created: false,
  });
  expect(outboxRows(fixture.context)).toHaveLength(1);
});

test("only a new identity enqueues issue-create", async () => {
  const fixture = await remoteFixture("capture-create");
  const refused = await refusalOf(() =>
    captureIssue(
      fixture.context,
      captureInput({ occurrenceKey: "brand-new", sourceIdentity: "review:other", rootCauseKey: "other.cause", acceptanceKey: "other.acceptance" }),
      { operationId: "30000000-0000-4000-8000-000000000003", actor: "project-manager" },
    ),
  );
  expect(refused.code).toBe("remote.effect-pending");
  const rows = outboxRows(fixture.context);
  expect(rows).toHaveLength(1);
  const change = frozenChange(rows[0]!);
  expect(change.kind).toBe("issue-create");
  expect(change.mstar.occurrences as unknown[]).toHaveLength(1);
});

test("a reused occurrence key refuses like the local capture body", async () => {
  const fixture = await remoteFixture("capture-conflict");
  const conflict = await refusalOf(() =>
    captureIssue(fixture.context, captureInput({ observedBehavior: "a different observation reuses the key" }), {
      operationId: "30000000-0000-4000-8000-000000000004",
      actor: "project-manager",
    }),
  );
  expect(conflict.code).toBe("issue.occurrence-conflict");
  const ambiguous = await refusalOf(() =>
    captureIssue(fixture.context, captureInput({ rootCauseKey: "different.cause" }), {
      operationId: "30000000-0000-4000-8000-000000000005",
      actor: "project-manager",
    }),
  );
  expect(ambiguous.code).toBe("issue.ambiguous-identity");
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("a snapshot that moves under the dedupe read never freezes a second subject", async () => {
  const fixture = await remoteFixture("capture-moved-snapshot");
  const identity = { occurrenceKey: "moved-in", sourceIdentity: "review:moved", rootCauseKey: "moved.cause", acceptanceKey: "moved.acceptance" };
  // note: A re-observation installs the same identity BETWEEN the capture's dedupe read and the
  // freeze, so the create must be decided against the freeze-time snapshot, not the older sample.
  let sampled = false;
  setRemoteWriteScopeGapForTest(async () => {
    if (sampled) return;
    sampled = true;
    setRemoteWriteScopeGapForTest(undefined);
    await ingestRemoteObservation(
      fixture.context,
      submission(fixture.commit, positiveCheck(), withAdoptedOccurrence(completeSnapshot(positiveCheck()), identity), 1),
    );
  });
  const refused = await refusalOf(() =>
    captureIssue(fixture.context, captureInput(identity), {
      operationId: "30000000-0000-4000-8000-000000000006",
      actor: "project-manager",
    }),
  );
  expect(sampled).toBe(true);
  expect(refused.code).toBe("remote.scope-mismatch");
  expect(refused.message).toContain("already carries this identity");
  expect(outboxRows(fixture.context)).toHaveLength(0);

  // invariant: The named correction route works: after the refresh the SAME capture answers the
  // established receipt instead of freezing anything.
  const established = await captureIssue(fixture.context, captureInput(identity), {
    operationId: "30000000-0000-4000-8000-000000000007",
    actor: "project-manager",
  });
  expect(established).toMatchObject({ issueId: REMOTE_IDS.providerOnlyIssueId, created: false });
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("an occurrence that arrives before the freeze answers the established receipt instead of appending twice", async () => {
  const fixture = await remoteFixture("capture-freeze-race");
  // note: The dedupe read sees NO occurrence with this key (so the capture chooses append), and
  // the re-observation installs it before the replacement is formed.
  let sampled = false;
  setRemoteWriteScopeGapForTest(async () => {
    if (sampled) return;
    sampled = true;
    setRemoteWriteScopeGapForTest(undefined);
    await ingestRemoteObservation(
      fixture.context,
      submission(fixture.commit, positiveCheck(), withExtraOccurrence(completeSnapshot(positiveCheck()), { occurrenceKey: "race-key" }), 1),
    );
  });
  const receipt = await captureIssue(fixture.context, captureInput({ occurrenceKey: "race-key" }), {
    operationId: "30000000-0000-4000-8000-000000000008",
    actor: "project-manager",
  });
  expect(sampled).toBe(true);
  expect(receipt).toMatchObject({ issueId: REMOTE_IDS.markedIssueId, created: false });
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("an operation id with a frozen entry answers through the replay gate, not an observed no-op", async () => {
  const fixture = await remoteFixture("capture-metadata-collision");
  const operationId = "30000000-0000-4000-8000-000000000009";
  const queued = await refusalOf(() =>
    captureIssue(fixture.context, captureInput({ occurrenceKey: "run-2" }), { operationId, actor: "project-manager" }),
  );
  expect(queued.code).toBe("remote.effect-pending");
  expect(outboxRows(fixture.context)).toHaveLength(1);

  // note: The access check expires, so the frozen request is disclosed metadata-only: the serial
  // replay identity still answers FIRST, exactly as the local operation ledger does.
  const db = new DatabaseSync(resolveCollaborationLocation(fixture.context).dbPath);
  try {
    db.prepare("update remote_bindings set verified_at = ?").run(new Date(Date.now() - 61_000).toISOString());
  } finally {
    db.close();
  }
  const replay = await refusalOf(() =>
    captureIssue(fixture.context, captureInput({ occurrenceKey: "occurrence-one" }), { operationId, actor: "project-manager" }),
  );
  expect(replay.code).toBe("remote.unavailable");
  expect(replay.message).toContain("cannot be replayed");
  expect(outboxRows(fixture.context)).toHaveLength(1);
});

test("a key another subject carries answers the established receipt, never a second append", async () => {
  const fixture = await remoteFixture("capture-cross-subject-key");
  const input = captureInput({ occurrenceKey: "cross-key" });
  // note: A re-observation installs the SAME identity and key on a DIFFERENT subject between the
  // capture's dedupe read and the replacement's own scope read, so the project-wide key now
  // belongs to the other subject and the append callback's target-only scan would miss it.
  let sampled = false;
  setRemoteWriteScopeGapForTest(async () => {
    if (sampled) return;
    sampled = true;
    setRemoteWriteScopeGapForTest(undefined);
    await ingestRemoteObservation(
      fixture.context,
      submission(fixture.commit, positiveCheck(), withAdoptedOccurrence(completeSnapshot(positiveCheck()), input), 1),
    );
  });
  const established = await captureIssue(fixture.context, input, {
    operationId: "30000000-0000-4000-8000-00000000000a",
    actor: "project-manager",
  });
  expect(sampled).toBe(true);
  // invariant: The project-wide key decides: the occurrence the OTHER subject already carries is
  // the established answer, and nothing is appended a second time.
  expect(established).toMatchObject({
    issueId: REMOTE_IDS.providerOnlyIssueId,
    occurrenceId: "11111111-1111-4111-8111-199999999999",
    created: false,
  });
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("a scope that moves after the last sample refuses the freeze and keeps retrying the same id", async () => {
  const fixture = await remoteFixture("capture-moved-after-sample");
  const identity = { occurrenceKey: "late-move", sourceIdentity: "review:late", rootCauseKey: "late.cause", acceptanceKey: "late.acceptance" };
  // note: The move lands AFTER the LAST scope sample (the write's own read), so every sampled
  // view the verb decided from is already stale when the freeze transaction opens. Only the
  // freeze-time observation revision can prove that; the samples cannot.
  let samples = 0;
  setRemoteWriteScopeGapForTest(async () => {
    samples += 1;
    if (samples < 2) return;
    setRemoteWriteScopeGapForTest(undefined);
    await ingestRemoteObservation(
      fixture.context,
      submission(fixture.commit, positiveCheck(), withAdoptedOccurrence(completeSnapshot(positiveCheck()), identity), 1),
    );
  });
  const refused = await refusalOf(() =>
    captureIssue(fixture.context, captureInput(identity), {
      operationId: "30000000-0000-4000-8000-00000000000b",
      actor: "project-manager",
    }),
  );
  expect(samples).toBe(2);
  expect(refused.code).toBe("collaboration.observation-stale");
  expect(outboxRows(fixture.context)).toHaveLength(0);

  // invariant: The refusal is an environment state, so the SAME capture (same operation id,
  // same payload) proceeds after the refresh and answers the established occurrence instead of
  // creating a second subject.
  const established = await captureIssue(fixture.context, captureInput(identity), {
    operationId: "30000000-0000-4000-8000-00000000000b",
    actor: "project-manager",
  });
  expect(established).toMatchObject({ issueId: REMOTE_IDS.providerOnlyIssueId, created: false });
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// I-001225 — remote close gates
// ---------------------------------------------------------------------------

test("a remote closure refuses an already-terminal issue", async () => {
  const fixture = await remoteFixture("30000000-0000-4000-8000-000000000006", withTerminalSubject);
  const refused = await refusalOf(() =>
    closeIssue(fixture.context, REMOTE_IDS.markedIssueId, "resolved", resolvedEvidence, {
      operationId: "30000000-0000-4000-8000-000000000006",
      actor: "project-manager",
      expectedRevision: 1,
    }),
  );
  expect(refused.code).toBe("issue.invalid-disposition");
  // invariant: The refusal names the usable next steps: inspect, reopen only deliberately.
  expect(JSON.stringify(refused.details)).toContain("mstar issue show");
  expect(JSON.stringify(refused.details)).toContain("mstar issue reopen");
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("a terminal refusal addressed by provider id names an executable inspect command", async () => {
  const fixture = await remoteFixture("close-terminal-native-id", withTerminalSubject);
  const refused = await refusalOf(() =>
    closeIssue(fixture.context, REMOTE_IDS.markedIssueId, "resolved", resolvedEvidence, {
      operationId: "30000000-0000-4000-8000-00000000000c",
      actor: "project-manager",
      expectedRevision: 1,
    }),
  );
  expect(refused.code).toBe("issue.invalid-disposition");
  const details = (refused.details ?? {}) as Record<string, unknown>;
  const recovery = String(details.recovery);
  // invariant: A provider UUID refuses `issue show` without --project in remote mode, so the
  // terminal refusal of a UUID-addressed closure names the command WITH its project — the exact
  // command this checkout can run.
  expect(recovery).toContain(`mstar issue show --id ${REMOTE_IDS.markedIssueId} --project ${REMOTE_IDS.projectId}`);
  // note: And it is executable: the printed inspect form reads the addressed issue.
  const shown = await showIssue(fixture.context, REMOTE_IDS.markedIssueId, REMOTE_IDS.projectId);
  // note: The marked subject's provider id surfaces as the detail's externalId either way.
  expect(JSON.stringify(shown)).toContain(REMOTE_IDS.markedIssueId);
  // invariant: Reopening is never the default suggestion: the recovery states the deliberate
  // inputs a reopen needs instead of pointing at reopen as the next step.
  expect(recovery).toContain("mstar issue reopen");
  expect(recovery).toContain("--reason");
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("a terminal refusal addressed by portable reference names the reference form", async () => {
  const fixture = await remoteFixture("close-terminal-ref", withTerminalSubject);
  const refused = await refusalOf(() =>
    closeIssue(fixture.context, REMOTE_IDS.issueRef, "resolved", resolvedEvidence, {
      operationId: "30000000-0000-4000-8000-00000000000d",
      actor: "project-manager",
      expectedRevision: 1,
    }),
  );
  expect(refused.code).toBe("issue.invalid-disposition");
  const recovery = String(((refused.details ?? {}) as Record<string, unknown>).recovery);
  // invariant: A stable reference needs no --project, so the refusal prints exactly the form the
  // caller addressed — and that form reads the same issue.
  expect(recovery).toContain(`mstar issue show --id ${REMOTE_IDS.issueRef}`);
  expect(recovery).not.toContain("--project");
  const shown = await showIssue(fixture.context, REMOTE_IDS.issueRef);
  expect(JSON.stringify(shown)).toContain(REMOTE_IDS.markedIssueId);
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("a closure whose scope moves after its sample refuses the freeze on the freeze revision", async () => {
  const fixture = await remoteFixture("close-moved-scope", withCanonicalTarget);
  // note: The re-observation removes the canonical target AFTER the closure's own scope read, so
  // the sampled gate decision (duplicate-of observed) is stale when the freeze transaction opens.
  let sampled = false;
  setRemoteWriteScopeGapForTest(async () => {
    if (sampled) return;
    sampled = true;
    setRemoteWriteScopeGapForTest(undefined);
    const check = positiveCheck();
    const full = completeSnapshot(check);
    await ingestRemoteObservation(
      fixture.context,
      submission(fixture.commit, check, { ...full, issues: full.issues.filter((issue) => issue.identity.issueId !== "88888888-8888-4888-8888-888888888888") }, 1),
    );
  });
  const refused = await refusalOf(() =>
    closeIssue(fixture.context, REMOTE_IDS.markedIssueId, "duplicate", {
      reason: "same defect",
      references: ["qa/run.md"],
      canonicalIssueId: "88888888-8888-4888-8888-888888888888",
      alignmentRef: "QA gate: Approve",
    }, {
      operationId: "30000000-0000-4000-8000-00000000000e",
      actor: "project-manager",
      expectedRevision: 1,
    }),
  );
  // invariant: The gates hold on the revision that can actually freeze: a sample the freeze
  // transaction no longer observes refuses, and nothing is enqueued behind it.
  expect(refused.code).toBe("collaboration.observation-stale");
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("a plan-scoped closure whose scope moves after its sample keeps its reservation", async () => {
  const fixture = await remotePlanFixture("residual-close-moved-scope", (snapshot) =>
    withCanonicalTarget(withResidualPlanLinks(snapshot)),
  );
  let sampled = false;
  setRemoteWriteScopeGapForTest(async () => {
    if (sampled) return;
    sampled = true;
    setRemoteWriteScopeGapForTest(undefined);
    const check = positiveCheck();
    const full = completeSnapshot(check);
    await ingestRemoteObservation(
      fixture.context,
      submission(fixture.commit, check, { ...full, issues: full.issues.filter((issue) => issue.identity.issueId !== "88888888-8888-4888-8888-888888888888") }, 1),
    );
  });
  const refused = await refusalOf(async () => mutateExecutionPlan({ ...fixture.context, caller: fixture.caller }, {
    operationId: "residual-moved-scope",
    session: fixture.session,
    expected: await fixture.token(),
    planId: RESIDUAL_PLAN_ID,
    operation: {
      kind: "residual-close" as const,
      issueId: REMOTE_IDS.markedIssueId,
      disposition: "duplicate" as const,
      expectedIssueRevision: 1,
      evidence: { reason: "same defect", references: ["qa/run.md"], canonicalIssueId: "88888888-8888-4888-8888-888888888888", alignmentRef: "QA gate: Approve" },
    },
  }));
  // invariant: A scope that moved under the sampled base is an environment state: the composite
  // reports a partial naming it and RETAINS the reservation for the same-id reissue after the
  // refresh, instead of declining an operation that proved no pre-freeze failure.
  expect(refused.code).toBe("collaboration.operation-partial");
  const details = (refused.details ?? {}) as Record<string, unknown>;
  expect(details).toMatchObject({ phase: "prepared", cause_code: "collaboration.observation-stale" });
  expect(await intentPhases(fixture.context, "residual-moved-scope")).toEqual(["prepared"]);
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("a remote closure enforces multi-plan acceptance against the observed project", async () => {
  const fixture = await remoteFixture("close-multi-plan", withSecondPlanLink);
  // note: One linked plan covered while two are linked: the local gate's own refusal.
  const one = await refusalOf(() =>
    closeIssue(fixture.context, REMOTE_IDS.markedIssueId, "resolved", { ...resolvedEvidence, references: ["20261122-second-plan"] }, {
      operationId: "30000000-0000-4000-8000-000000000007",
      actor: "project-manager",
      expectedRevision: 1,
    }),
  );
  expect(one.code).toBe("issue.invalid-disposition");
  // invariant: The refusal names the two supported corrections: the complete references, or an
  // honest scope:all in the original verb's evidence file.
  expect(JSON.stringify(one.details)).toContain("scope");
  expect(JSON.stringify(one.details)).toContain("evidence file");
  expect(outboxRows(fixture.context)).toHaveLength(0);
  // note: The whole acceptance verified: the closure enqueues.
  const all = await refusalOf(() =>
    closeIssue(fixture.context, REMOTE_IDS.markedIssueId, "resolved", { ...resolvedEvidence, scope: "all" }, {
      operationId: "30000000-0000-4000-8000-000000000008",
      actor: "project-manager",
      expectedRevision: 1,
    }),
  );
  expect(all.code).toBe("remote.effect-pending");
  expect(outboxRows(fixture.context)).toHaveLength(1);
});

test("an unscoped remote closure enforces the canonical gate and stores the portable reference", async () => {
  const fixture = await remoteFixture("close-canonical-unscoped", withCanonicalTarget);
  const close = (
    operationId: string,
    disposition: "duplicate" | "superseded",
    canonicalIssueId: string,
    issueId: string = REMOTE_IDS.markedIssueId,
  ): Promise<{ code: string }> =>
    refusalOf(() =>
      closeIssue(
        fixture.context,
        issueId,
        disposition,
        { reason: "same defect", references: ["qa/run.md"], canonicalIssueId, alignmentRef: "QA gate: Approve" },
        { operationId, actor: "project-manager", expectedRevision: 1 },
      ),
    );

  // invariant: The closing issue is never its own canonical target, by provider id or by IssueRef.
  expect((await close("30000000-0000-4000-8000-000000000020", "duplicate", REMOTE_IDS.markedIssueId)).code).toBe(
    "issue.invalid-disposition",
  );
  expect((await close("30000000-0000-4000-8000-000000000021", "superseded", REMOTE_IDS.issueRef)).code).toBe(
    "issue.invalid-disposition",
  );
  // invariant: A subject addressed by its portable reference still refuses its own native alias.
  expect(
    (await close("30000000-0000-4000-8000-000000000022", "duplicate", REMOTE_IDS.markedIssueId, REMOTE_IDS.issueRef))
      .code,
  ).toBe("issue.invalid-disposition");
  // invariant: A canonical target the observed project does not carry is never frozen.
  expect(
    (await close("30000000-0000-4000-8000-000000000023", "duplicate", "99999999-9999-4999-8999-999999999999")).code,
  ).toBe("issue.not-found");
  expect(outboxRows(fixture.context)).toHaveLength(0);
  // invariant: An observed canonical target passes the gate, and the frozen relation names its
  // portable reference even when the caller addressed it by provider id.
  expect(
    (await close("30000000-0000-4000-8000-000000000024", "duplicate", "88888888-8888-4888-8888-888888888888")).code,
  ).toBe("remote.effect-pending");
  const change = frozenChange(outboxRows(fixture.context)[0]!);
  expect(change.mstar.relations).toContainEqual({
    relation: "duplicate-of",
    target: "mstar:issue:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  });
  expect(outboxRows(fixture.context)).toHaveLength(1);
});

test("a plan-scoped remote residual-close refuses an already-terminal issue", async () => {
  const fixture = await remotePlanFixture("residual-close-terminal", (snapshot) => withTerminalSubject(withResidualPlanLinks(snapshot)));
  const request = residualCloseRequest(fixture, "residual-terminal-1", resolvedEvidence);
  const refused = await refusalOf(async () => mutateExecutionPlan({ ...fixture.context, caller: fixture.caller }, {
    ...request,
    expected: await fixture.token(),
  }));
  expect(refused.code).toBe("issue.invalid-disposition");
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("a plan-scoped remote residual-close enforces multi-plan acceptance", async () => {
  const fixture = await remotePlanFixture("residual-close-multi", withResidualPlanLinks);
  const one = await refusalOf(async () => mutateExecutionPlan({ ...fixture.context, caller: fixture.caller }, {
    ...residualCloseRequest(fixture, "residual-multi-one", { ...resolvedEvidence, references: ["20261122-second-plan"] }),
    expected: await fixture.token(),
  }));
  expect(one.code).toBe("issue.invalid-disposition");
  const all = await refusalOf(async () => mutateExecutionPlan({ ...fixture.context, caller: fixture.caller }, {
    ...residualCloseRequest(fixture, "residual-multi-all", { ...resolvedEvidence, scope: "all" }),
    expected: await fixture.token(),
  }));
  // note: The composite's own report for a durably enqueued, unconfirmed provider intent:
  // the gate passed, so the closure waits on its provider effect like any remote composite.
  expect(all.code).toBe("collaboration.operation-partial");
  expect(outboxRows(fixture.context)).toHaveLength(1);
  expect(outboxRows(fixture.context)[0]).toMatchObject({ state: "enqueued" });
});

test("a plan-scoped remote residual-close enforces the canonical gate", async () => {
  const fixture = await remotePlanFixture("residual-close-canonical", (snapshot) =>
    withCanonicalTarget(withResidualPlanLinks(snapshot)),
  );
  const close = (
    operationId: string,
    disposition: "duplicate" | "superseded",
    canonicalIssueId: string,
    issueId: string = REMOTE_IDS.markedIssueId,
  ): Promise<{ code: string }> =>
    refusalOf(async () =>
      mutateExecutionPlan({ ...fixture.context, caller: fixture.caller }, {
        operationId,
        session: fixture.session,
        expected: await fixture.token(),
        planId: RESIDUAL_PLAN_ID,
        operation: {
          kind: "residual-close" as const,
          issueId,
          disposition,
          expectedIssueRevision: 1,
          evidence: { reason: "same defect", references: ["qa/run.md"], canonicalIssueId, alignmentRef: "QA gate: Approve" },
        },
      }),
    );

  // invariant: The closing issue is never its own canonical target, by provider id or by IssueRef.
  expect((await close("residual-canonical-self", "duplicate", REMOTE_IDS.markedIssueId)).code).toBe("issue.invalid-disposition");
  expect((await close("residual-canonical-self-ref", "superseded", REMOTE_IDS.issueRef)).code).toBe("issue.invalid-disposition");
  // invariant: A subject addressed by its portable reference still refuses its own native alias.
  expect(
    (await close("residual-canonical-alias", "duplicate", REMOTE_IDS.markedIssueId, REMOTE_IDS.issueRef)).code,
  ).toBe("issue.invalid-disposition");
  // invariant: A canonical target the observed project does not carry is never frozen.
  expect((await close("residual-canonical-missing", "duplicate", "99999999-9999-4999-8999-999999999999")).code).toBe(
    "issue.not-found",
  );
  expect(outboxRows(fixture.context)).toHaveLength(0);
  // invariant: An observed canonical target passes the gate, and the frozen relation names its
  // portable reference even when the caller addressed it by provider id.
  expect(
    (await close("residual-canonical-observed", "duplicate", "88888888-8888-4888-8888-888888888888")).code,
  ).toBe("collaboration.operation-partial");
  const change = frozenChange(outboxRows(fixture.context)[0]!);
  expect(change.mstar.relations).toContainEqual({
    relation: "duplicate-of",
    target: "mstar:issue:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  });
  expect(outboxRows(fixture.context)).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// I-001226 — remote milestone assignment store revision
// ---------------------------------------------------------------------------

test("a remote milestone assignment refuses on a stale store revision", async () => {
  const fixture = await remoteFixture("milestone-stale-store");
  const assign = (operationId: string, expectedStoreRevision: number): Promise<unknown> =>
    assignIssueMilestone(
      fixture.context,
      REMOTE_IDS.markedIssueId,
      { projectId: REMOTE_IDS.projectId, milestoneId: "milestone-1", reason: "tracked here" },
      { operationId, actor: "project-manager", expectedRevision: 1, expectedStoreRevision },
    );
  // note: The ingest left the observed store at revision 1; a stale base refuses.
  const stale = await refusalOf(() => assign("30000000-0000-4000-8000-000000000009", 0));
  expect(stale.code).toBe("milestone.revision-conflict");
  // invariant: The recovery names the command that reads this project's observation revision and
  // the flag that carries it: a remote write's base is that revision, never a local listing.
  const details = stale.details;
  const recovery = details !== null && typeof details === "object" && "recovery" in details ? String(details.recovery) : "";
  expect(recovery).toContain("mstar store collaboration remote status --harness <abs>");
  expect(recovery).toContain(`--project ${REMOTE_IDS.projectId}`);
  expect(recovery).toContain("--expect-store");
  expect((await refusalOf(() => assign("30000000-0000-4000-8000-00000000000a", 7))).code).toBe("milestone.revision-conflict");
  expect(outboxRows(fixture.context)).toHaveLength(0);
  // note: The observed base matches: the assignment enqueues.
  expect((await refusalOf(() => assign("30000000-0000-4000-8000-00000000000b", 1))).code).toBe("remote.effect-pending");
  expect(outboxRows(fixture.context)).toHaveLength(1);
});
