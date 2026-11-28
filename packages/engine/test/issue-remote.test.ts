/**
 * note: issue-remote.test.ts — the remote issue-write gates the local lanes already answer.
 *
 * Run with `bun test packages/engine/test/issue-remote.test.ts`.
 *
 * Cases drive the REAL remote boundary against a real bound checkout (the shared
 * remote-scope fixture): one complete observation, the real outbox freeze, and the
 * real receipts. They prove:
 *
 * - a recurring remote capture resolves the established occurrence or the
 *   established identity before any create — same occurrence answers the established
 *   receipt, same identity appends through ONE issue-replace, only a new identity
 *   enqueues issue-create, and a reused key refuses like the local body does.
 * - remote closure answers the local open-state gate (a terminal issue is
 *   never closed again, so no transition records `fromDisposition: "open"`) and the
 *   multi-plan acceptance gate against the observed project's plan links.
 * - a remote milestone assignment compares `--expect-store` with the observed
 *   store revision before enqueueing, exactly like the local `withWrite` branch.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeOs from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveCollaborationLocation } from "../src/collaboration-identity.js";
import {
  bindRemoteAuthority,
  ingestRemoteObservation,
  prepareRemoteIntent,
  setRemoteWriteScopeGapForTest,
  type RemoteSnapshot,
} from "../src/collaboration-remote.js";
import { assignIssueMilestone, captureIssue, closeIssue, showIssue, type CaptureInput, type ClosureEvidence } from "../src/issue.js";
import {
  completeSnapshot,
  confirmFrozenIntent,
  createRemoteScope,
  FIXTURE_AT,
  positiveCheck,
  REMOTE_IDS,
  submission,
} from "../src/remote-scope.fixture.js";
import {
  bindExecutionSession,
  createExecutionWorkflow,
  readExecutionPlan,
  readExecutionState,
  type ExecutionCaller,
  type ExecutionSessionRef,
  type ExecutionToken,
} from "../src/execution-store.js";
import { mutateExecutionPlan } from "../src/execution-coordination.js";
import type { WorkflowSnapshot } from "../src/workflow.js";
import type { WorkflowEntry } from "../src/status.js";
import { initializeStore, openStore, type StoreContext } from "../src/store-db.js";

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

function expectNoChangeClaim(context: StoreContext): void {
  expect(outboxRows(context).map((row) => row.state)).toEqual(["abandoned"]);
}

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

const RESIDUAL_PLAN_ID = "20261121-issue-remote-residual";
const RESIDUAL_WORKFLOW_ID = "wf-issue-remote";

type RemotePlanFixture = RemoteFixture & {
  caller: ExecutionCaller;
  session: ExecutionSessionRef;
  token: () => Promise<ExecutionToken>;
};

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
  expectNoChangeClaim(fixture.context);
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

  const established = await captureIssue(fixture.context, captureInput(identity), {
    operationId: "30000000-0000-4000-8000-000000000007",
    actor: "project-manager",
  });
  expect(established).toMatchObject({ issueId: REMOTE_IDS.providerOnlyIssueId, created: false });
  expectNoChangeClaim(fixture.context);
});

test("an occurrence that arrives before the freeze answers the established receipt instead of appending twice", async () => {
  const fixture = await remoteFixture("capture-freeze-race");
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
  expectNoChangeClaim(fixture.context);
});

test("an operation id with a frozen entry answers through the replay gate, not an observed no-op", async () => {
  const fixture = await remoteFixture("capture-metadata-collision");
  const operationId = "30000000-0000-4000-8000-000000000009";
  const queued = await refusalOf(() =>
    captureIssue(fixture.context, captureInput({ occurrenceKey: "run-2" }), { operationId, actor: "project-manager" }),
  );
  expect(queued.code).toBe("remote.effect-pending");
  expect(outboxRows(fixture.context)).toHaveLength(1);

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
  expect(established).toMatchObject({
    issueId: REMOTE_IDS.providerOnlyIssueId,
    occurrenceId: "11111111-1111-4111-8111-199999999999",
    created: false,
  });
  expectNoChangeClaim(fixture.context);
});

test("a scope that moves after the last sample refuses the freeze and keeps retrying the same id", async () => {
  const fixture = await remoteFixture("capture-moved-after-sample");
  const identity = { occurrenceKey: "late-move", sourceIdentity: "review:late", rootCauseKey: "late.cause", acceptanceKey: "late.acceptance" };
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

  const established = await captureIssue(fixture.context, captureInput(identity), {
    operationId: "30000000-0000-4000-8000-00000000000b",
    actor: "project-manager",
  });
  expect(established).toMatchObject({ issueId: REMOTE_IDS.providerOnlyIssueId, created: false });
  expectNoChangeClaim(fixture.context);
});

test("a durable operation under the same id refuses an established no-op answer", async () => {
  const fixture = await remoteFixture("capture-noop-overlap");
  const operationId = "30000000-0000-4000-8000-00000000000c";
  let samples = 0;
  setRemoteWriteScopeGapForTest(async () => {
    samples += 1;
    if (samples < 2) return;
    setRemoteWriteScopeGapForTest(undefined);
    const marked = completeSnapshot(positiveCheck()).issues[0]!.mstar!;
    const { issueRef: _derivedRef, head: _derivedHead, ...subject } = marked;
    await prepareRemoteIntent(fixture.context, {
      binding: {
        generation: 3,
        projectKey: REMOTE_IDS.projectId,
        selectorCommit: fixture.commit,
        provider: "linear",
        workspaceId: REMOTE_IDS.workspaceId,
        teamId: REMOTE_IDS.teamId,
        projectId: REMOTE_IDS.providerProjectId,
        journalIssueId: REMOTE_IDS.journalIssueId,
        writerId: REMOTE_IDS.writerId,
      },
      event: {
        version: 1,
        repoKey: fixture.scope.repoKey,
        projectId: REMOTE_IDS.projectId,
        operationId,
        parents: ["2".repeat(64)],
        change: {
          kind: "issue-replace",
          issueRef: REMOTE_IDS.issueRef,
          mstar: { ...subject, occurrences: [...subject.occurrences, { ...subject.occurrences[0]!, occurrenceKey: "winner-payload" }] },
        },
      },
      target: REMOTE_IDS.markedIssueId,
      expectedHeads: ["2".repeat(64)],
      executionKey: null,
      origin: { verb: "capture", request: { different: true } },
    });
  });
  const refused = await refusalOf(() =>
    captureIssue(fixture.context, captureInput({ occurrenceKey: "occurrence-one" }), {
      operationId,
      actor: "project-manager",
    }),
  );
  expect(samples).toBe(2);
  expect(refused.code).toBe("remote.operation-conflict");
  expect(refused.message).toContain("frozen under the business request");
  const rows = outboxRows(fixture.context);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ operation_id: operationId, state: "enqueued" });
});

test("an established occurrence success is recorded and replays its own answer under the same id", async () => {
  const fixture = await remoteFixture("capture-established-replay");
  const operationId = "30000000-0000-4000-8000-00000000000d";
  const established = await captureIssue(fixture.context, captureInput(), { operationId, actor: "project-manager" });
  expect(established).toMatchObject({ issueId: REMOTE_IDS.markedIssueId, created: false, storeRevision: 0 });
  expectNoChangeClaim(fixture.context);

  const replayed = await captureIssue(fixture.context, captureInput(), { operationId, actor: "project-manager" });
  expect(replayed).toEqual(established);
  const rows = outboxRows(fixture.context);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ operation_id: operationId, state: "abandoned" });
});

test("a different payload under an established operation id refuses instead of reusing it", async () => {
  const fixture = await remoteFixture("capture-established-reuse");
  const operationId = "30000000-0000-4000-8000-00000000000e";
  const established = await captureIssue(fixture.context, captureInput(), { operationId, actor: "project-manager" });
  expect(established).toMatchObject({ created: false });

  const refused = await refusalOf(() =>
    captureIssue(fixture.context, captureInput({ occurrenceKey: "run-2" }), { operationId, actor: "project-manager" }),
  );
  expect(refused.code).toBe("remote.operation-conflict");
  expect(refused.message).toContain("frozen under the business request");
  expectNoChangeClaim(fixture.context);
});

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
  expect(recovery).toContain(`mstar issue show --id ${REMOTE_IDS.markedIssueId} --project ${REMOTE_IDS.projectId}`);
  const shown = await showIssue(fixture.context, REMOTE_IDS.markedIssueId, REMOTE_IDS.projectId);
  expect(JSON.stringify(shown)).toContain(REMOTE_IDS.markedIssueId);
  expect(recovery).toContain("mstar issue reopen");
  expect(recovery).toContain("mstar issue reopen --help");
  expect(recovery).toContain("mstar schema IssueReopen");
  expect(recovery).toContain("--payload");
  expect(recovery).not.toContain("--reason");
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
  expect(recovery).toContain(`mstar issue show --id ${REMOTE_IDS.issueRef}`);
  expect(recovery).not.toContain("--project");
  const shown = await showIssue(fixture.context, REMOTE_IDS.issueRef);
  expect(JSON.stringify(shown)).toContain(REMOTE_IDS.markedIssueId);
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("a closure whose scope moves after its sample refuses the freeze on the freeze revision", async () => {
  const fixture = await remoteFixture("close-moved-scope", withCanonicalTarget);
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
  expect(refused.code).toBe("collaboration.operation-partial");
  const details = (refused.details ?? {}) as Record<string, unknown>;
  expect(details).toMatchObject({ phase: "prepared", cause_code: "collaboration.observation-stale" });
  expect(await intentPhases(fixture.context, "residual-moved-scope")).toEqual(["prepared"]);
  expect(outboxRows(fixture.context)).toHaveLength(0);
});

test("a remote closure enforces multi-plan acceptance against the observed project", async () => {
  const fixture = await remoteFixture("close-multi-plan", withSecondPlanLink);
  const one = await refusalOf(() =>
    closeIssue(fixture.context, REMOTE_IDS.markedIssueId, "resolved", { ...resolvedEvidence, references: ["20261122-second-plan"] }, {
      operationId: "30000000-0000-4000-8000-000000000007",
      actor: "project-manager",
      expectedRevision: 1,
    }),
  );
  expect(one.code).toBe("issue.invalid-disposition");
  expect(JSON.stringify(one.details)).toContain("scope");
  expect(JSON.stringify(one.details)).toContain("evidence file");
  expect(outboxRows(fixture.context)).toHaveLength(0);
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

  expect((await close("30000000-0000-4000-8000-000000000020", "duplicate", REMOTE_IDS.markedIssueId)).code).toBe(
    "issue.invalid-disposition",
  );
  expect((await close("30000000-0000-4000-8000-000000000021", "superseded", REMOTE_IDS.issueRef)).code).toBe(
    "issue.invalid-disposition",
  );
  expect(
    (await close("30000000-0000-4000-8000-000000000022", "duplicate", REMOTE_IDS.markedIssueId, REMOTE_IDS.issueRef))
      .code,
  ).toBe("issue.invalid-disposition");
  expect(
    (await close("30000000-0000-4000-8000-000000000023", "duplicate", "99999999-9999-4999-8999-999999999999")).code,
  ).toBe("issue.not-found");
  expect(outboxRows(fixture.context)).toHaveLength(0);
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

  expect((await close("residual-canonical-self", "duplicate", REMOTE_IDS.markedIssueId)).code).toBe("issue.invalid-disposition");
  expect((await close("residual-canonical-self-ref", "superseded", REMOTE_IDS.issueRef)).code).toBe("issue.invalid-disposition");
  expect(
    (await close("residual-canonical-alias", "duplicate", REMOTE_IDS.markedIssueId, REMOTE_IDS.issueRef)).code,
  ).toBe("issue.invalid-disposition");
  expect((await close("residual-canonical-missing", "duplicate", "99999999-9999-4999-8999-999999999999")).code).toBe(
    "issue.not-found",
  );
  expect(outboxRows(fixture.context)).toHaveLength(0);
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

test("a remote milestone assignment refuses on a stale store revision", async () => {
  const fixture = await remoteFixture("milestone-stale-store");
  const assign = (operationId: string, expectedStoreRevision: number): Promise<unknown> =>
    assignIssueMilestone(
      fixture.context,
      REMOTE_IDS.markedIssueId,
      { projectId: REMOTE_IDS.projectId, milestoneId: "milestone-1", reason: "tracked here" },
      { operationId, actor: "project-manager", expectedRevision: 1, expectedStoreRevision },
    );
  const stale = await refusalOf(() => assign("30000000-0000-4000-8000-000000000009", 0));
  expect(stale.code).toBe("milestone.revision-conflict");
  const details = stale.details;
  const recovery = details !== null && typeof details === "object" && "recovery" in details ? String(details.recovery) : "";
  expect(recovery).toContain("mstar store collaboration remote status --harness <abs>");
  expect(recovery).toContain(`--project ${REMOTE_IDS.projectId}`);
  expect(recovery).toContain("--expect-store");
  expect((await refusalOf(() => assign("30000000-0000-4000-8000-00000000000a", 7))).code).toBe("milestone.revision-conflict");
  expect(outboxRows(fixture.context)).toHaveLength(0);
  expect((await refusalOf(() => assign("30000000-0000-4000-8000-00000000000b", 1))).code).toBe("remote.effect-pending");
  expect(outboxRows(fixture.context)).toHaveLength(1);
});
