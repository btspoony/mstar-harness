/**
 * note: The complete host-mediated round trip and explicit adoption, at the shipped boundary.
 *
 * Every step runs the BUILT CLI as a subprocess in a sandbox with its own workspace and `HOME`;
 * the provider state lives in this test runner and only the normalized bind, observation, send and
 * lookup documents cross into the CLI. The assertions are the durable facts an operator recovers
 * from — states, identities, receipt outcomes and refusal codes — never a byte digest, a snapshot
 * text or a provider client.
 *
 * The lane: select and bind, observe a populated provider (portable project, roadmap, milestone
 * and one marked finding with occurrences, transitions, relations and provenance) beside an
 * unmarked issue of the SAME title, refuse every non-strict adoption, adopt only the exact
 * unmarked provider UUID, obtain exactly one send permit, record the provider's answer, re-observe
 * and read the finding by its new `IssueRef`. The negatives run at the same host boundary: a lost
 * response, a competing effect, and a stale base.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  FIXTURE_ISSUE_ID,
  REMOTE_PROJECT,
  RemoteCollaborationFixture,
  type OutboxIntent,
  type OutboxPermit,
  type ProviderIssueRecord,
  type RemoteSandbox,
  type SandboxCommand,
} from "./support/remote-collaboration-fixture";

const REMOTE = ["store", "collaboration", "remote"] as const;

const AT = "2026-11-20T00:00:00.000Z";
const SHARED_TITLE = "Shared provider title";
const MARKED_ISSUE_ID = "77777777-7777-4777-8777-777777777701";
const MARKED_ISSUE_REF = "mstar:issue:77777777-7777-4777-8777-777777777702";
const RELATED_REF = "mstar:issue:99999999-9999-4999-8999-999999999999";
const MILESTONE_ID = "milestone-roundtrip";

const ADOPT_OPERATION = "44444444-4444-4444-8444-444444444441";
const REFUSED_OPERATION = "44444444-4444-4444-8444-444444444442";
const REFUSED_TITLE_OPERATION = "44444444-4444-4444-8444-444444444446";
const REFUSED_PROJECT_OPERATION = "44444444-4444-4444-8444-444444444447";
const MARKED_OPERATION = "44444444-4444-4444-8444-444444444443";
const LOST_OPERATION = "44444444-4444-4444-8444-444444444444";
const CONFLICT_OPERATION = "44444444-4444-4444-8444-444444444445";

/** note: Two native issues of one title; only the first carries an MStar marker. */
const PROVIDER_ISSUES = [
  { issueId: MARKED_ISSUE_ID, title: SHARED_TITLE, status: "Todo", updatedAt: AT },
  { issueId: FIXTURE_ISSUE_ID, title: SHARED_TITLE, status: "Todo", updatedAt: AT },
] as const;

/**
 * note: The extension history the provider already holds for the marked finding. A traversal
 * must materialize it (roadmap, milestone, occurrence, transition, relation, provenance), so the
 * stock fixture's empty history fields alone would not prove the reconstruction.
 */
const MARKED_RECORD: ProviderIssueRecord = {
  issueRef: MARKED_ISSUE_REF,
  head: ["2".repeat(64)],
  subject: {
    fields: {
      title: SHARED_TITLE,
      kind: "bug",
      severity: "high",
      disposition: "open",
      impact: "A provider traversal must carry the whole extension history.",
      acceptance: "The observation materializes the roadmap, the milestone and the issue history.",
      owner: "fullstack-dev",
      registeredAt: AT,
      closedAt: null,
      closureNote: null,
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
      milestoneId: MILESTONE_ID,
    },
    occurrences: [
      {
        eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurrenceKey: "occurrence-prior",
        sourceKind: "review",
        sourceIdentity: "review:prior",
        rootCauseKey: "remote.roundtrip.history",
        acceptanceKey: "remote.roundtrip.history.carried",
        location: "packages/cli/test/remote-host-roundtrip.test.ts",
        observedBehavior: "The prior finding was reconstructed from the provider.",
        evidence: ["controlled host fixture"],
        discoveredAt: AT,
        recordedAt: AT,
        imported: false,
      },
    ],
    transitions: [
      {
        eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        fromDisposition: "resolved",
        toDisposition: "open",
        actor: "project-manager",
        occurredAt: AT,
        recordedAt: AT,
        reason: "Reopened by review",
        evidence: { reason: "Reopened by review", scope: null, references: [], canonicalIssueId: null, alignmentRef: null },
        issueRevision: 1,
        imported: false,
      },
    ],
    relations: [{ relation: "related", target: RELATED_REF }],
    provenance: [
      {
        eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        kind: "plan",
        target: "20261123-remote-host-lane",
        sourceHash: "3".repeat(64),
        origin: "scoped",
        legacyProject: null,
        legacyBucket: null,
        legacyEntryId: null,
        legacyRecord: null,
        importedAt: null,
      },
    ],
    projectMoves: [],
  },
};

/** note: The portable project document the provider renders on every traversal. */
const PROJECT_DOCUMENT = {
  milestones: [
    {
      milestoneId: MILESTONE_ID,
      name: "Round-trip delivery",
      target: "2026-12-01",
      status: "active",
      ordinal: 0,
      revision: 1,
      createdAt: AT,
      updatedAt: AT,
    },
  ],
  roadmap: {
    contentMarkdown: [
      "---",
      `project_id: ${JSON.stringify(REMOTE_PROJECT.localProjectId)}`,
      `title: ${JSON.stringify("Round-trip roadmap")}`,
      `status: ${JSON.stringify("active")}`,
      `created_at: ${JSON.stringify("2026-11-20")}`,
      "---",
      "",
      "# Roadmap",
      "",
      "## Direction",
      "",
      "Prove the host-mediated round trip at the controlled boundary.",
      "",
      "- [ ] One complete extension cycle",
      "",
    ].join("\n"),
    revision: 2,
    updatedAt: AT,
  },
  catalogEntities: [
    {
      kind: "project",
      id: REMOTE_PROJECT.localProjectId,
      title: "Fixture project",
      description: null,
      documentKind: null,
      lifecycle: "active",
      revision: 1,
    },
    {
      kind: "plan",
      id: "20261123-remote-host-lane",
      title: "Host-mediated remote lane",
      description: null,
      documentKind: null,
      lifecycle: "active",
      revision: 1,
    },
  ],
  catalogLinks: [
    {
      fromKind: "plan",
      fromId: "20261123-remote-host-lane",
      relation: "belongs-to",
      toKind: "project",
      toId: REMOTE_PROJECT.localProjectId,
      ordinal: 0,
    },
  ],
} as const;

/** note: The strict `new` adoption the host submits; a capture's title and project come from the provider. */
function adoptionDocument(operation: string): Record<string, unknown> {
  return {
    version: 1,
    kind: "new",
    capture: {
      kind: "bug",
      severity: "high",
      impact: "A native provider issue must become an MStar finding through one explicit adoption.",
      acceptance: "The adopted finding maps to the exact provider issue it was adopted from.",
      sourceIdentity: `review:${operation}`,
      rootCauseKey: "remote.roundtrip.adoption",
      acceptanceKey: "remote.roundtrip.adoption.proven",
      occurrenceKey: `occurrence-${operation}`,
      sourceKind: "review",
      location: "remote-host-roundtrip.test.ts",
      observedBehavior: "The host adopted one observed, unmarked provider issue.",
      evidence: ["controlled host fixture"],
      discoveredAt: new Date().toISOString(),
    },
  };
}

/** note: Publish the selector and bring one sandbox to a bound, initialized, observed lane. */
function prepareHost(fixture: RemoteCollaborationFixture): RemoteSandbox {
  fixture.publish(1);
  fixture.setIssues(PROVIDER_ISSUES);
  fixture.setProjectDocument(PROJECT_DOCUMENT);
  fixture.seedRecord(MARKED_ISSUE_ID, MARKED_RECORD);
  const sandbox = fixture.sandbox("host");
  expect(sandbox.status().data.binding).toMatchObject({ state: "unbound" });
  expect(sandbox.bind(fixture.verify()).exitCode).toBe(0);
  expect(sandbox.init().exitCode).toBe(0);
  return sandbox;
}

/** note: The cache revision the next submission must expect, read from the lane's own status. */
function revisionOf(sandbox: RemoteSandbox): number {
  const status = sandbox.status();
  const projects = status.data.projects as Array<Record<string, unknown>>;
  const revision = projects[0]?.revision;
  if (typeof revision !== "number") throw new Error(`roundtrip: status reported no revision: ${status.result.stderr}`);
  return revision;
}

/** note: Observe the provider's traversal at the cache revision it addresses. */
function observeAt(fixture: RemoteCollaborationFixture, sandbox: RemoteSandbox, revision: number): SandboxCommand {
  return sandbox.observe(fixture.observe(REMOTE_PROJECT, revision));
}

/**
 * note: Re-submit the host check and traversal so the next freshness-gated verb runs inside the
 * product's 60 s window; this suite's own deadline is longer than that window, so an expired
 * check must never masquerade as the refusal under test.
 */
function refreshHost(fixture: RemoteCollaborationFixture, sandbox: RemoteSandbox): void {
  expect(observeAt(fixture, sandbox, revisionOf(sandbox)).exitCode).toBe(0);
}

function adopt(
  sandbox: RemoteSandbox,
  operation: string,
  issueId: string,
  document: unknown = adoptionDocument(operation),
): SandboxCommand {
  return sandbox.runJson([
    ...REMOTE, "adopt-issue",
    "--harness", sandbox.harness,
    "--project", REMOTE_PROJECT.localProjectId,
    "--issue", issueId,
    "--operation", operation,
    "--input", sandbox.writeJson("adopt", document),
  ]);
}

function dispatch(sandbox: RemoteSandbox, operation: string): SandboxCommand {
  return sandbox.runJson([...REMOTE, "outbox-dispatch", "--harness", sandbox.harness, "--operation", operation]);
}

function receipt(sandbox: RemoteSandbox, document: unknown): SandboxCommand {
  return sandbox.runJson([...REMOTE, "outbox-receipt", "--harness", sandbox.harness, "--input", sandbox.writeJson("receipt", document)]);
}

describe("remote host round trip", () => {
  const hosts: RemoteCollaborationFixture[] = [];

  function host(name: string): RemoteCollaborationFixture {
    const created = new RemoteCollaborationFixture(`remote-roundtrip-${name}`);
    hosts.push(created);
    return created;
  }

  afterEach(() => {
    for (const created of hosts.splice(0)) created.dispose();
  });

  test("the host cycle observes populated history, refuses every non-strict adoption, adopts once and reads it back", () => {
    const fixture = host("cycle");
    const sandbox = prepareHost(fixture);
    const cli = (args: readonly string[]) => sandbox.runJson(args);

    const observed = observeAt(fixture, sandbox, 0);
    expect(observed.exitCode).toBe(0);
    expect(observed.data).toMatchObject({ revision: 1, completeness: "complete" });
    expect(cli([...REMOTE, "status", "--harness", sandbox.harness]).data).toMatchObject({
      available: true,
      binding: { state: "bound", generation: 1 },
    });

    // note: The fresh observation materialized the provider's roadmap, milestone and issue history.
    const roadmap = cli(["roadmap", "show", "--harness", sandbox.harness, "--project", REMOTE_PROJECT.localProjectId]);
    expect(roadmap.exitCode).toBe(0);
    const roadmapData = roadmap.data;
    expect(roadmapData.roadmap).toMatchObject({ projectId: REMOTE_PROJECT.localProjectId, revision: 2 });
    expect(roadmapData.content).toMatchObject({ frontmatter: { project_id: REMOTE_PROJECT.localProjectId } });
    const direction = (roadmapData.content as { direction?: unknown } | null)?.direction;
    expect(typeof direction).toBe("string");
    expect(String(direction)).toContain("controlled boundary");

    const milestones = cli(["milestone", "list", "--harness", sandbox.harness, "--project", REMOTE_PROJECT.localProjectId]);
    expect(milestones.exitCode).toBe(0);
    const milestoneRead = milestones.data.data as Record<string, unknown>;
    expect(milestoneRead).toMatchObject({
      milestones: [expect.objectContaining({ milestoneId: MILESTONE_ID, name: "Round-trip delivery", totalIssues: 1, openIssues: 1 })],
      issues: [expect.objectContaining({ id: MARKED_ISSUE_REF, milestoneId: MILESTONE_ID })],
    });

    const marked = cli(["issue", "show", "--id", MARKED_ISSUE_REF, "--harness", sandbox.harness]);
    expect(marked.exitCode).toBe(0);
    const occurrences = marked.data.occurrences as Array<Record<string, unknown>>;
    const transitions = marked.data.transitions as Array<Record<string, unknown>>;
    const relations = marked.data.relations as Array<Record<string, unknown>>;
    const provenance = marked.data.provenance as Array<Record<string, unknown>>;
    expect(marked.data).toMatchObject({
      issueRef: MARKED_ISSUE_REF,
      externalId: MARKED_ISSUE_ID,
      disposition: "open",
      nativeTitle: SHARED_TITLE,
      providerIdentity: { issueId: MARKED_ISSUE_ID },
    });
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ occurrenceKey: "occurrence-prior", sourceIdentity: "review:prior" });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromDisposition: "resolved", toDisposition: "open", reason: "Reopened by review" });
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ relation: "related", toIssue: RELATED_REF, title: null });
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({ kind: "plan", target: "20261123-remote-host-lane" });

    // note: The unmarked issue of the SAME title stays visible and unadopted: no reference, no
    // disposition, no count, no intent and no send.
    const listed = cli(["issue", "list", "--harness", sandbox.harness]);
    expect(listed.data).toMatchObject({ total: 1, projectCount: 1 });
    expect((listed.data.items as Array<Record<string, unknown>>).map((item) => item.issueRef)).toEqual([MARKED_ISSUE_REF]);
    expect(listed.data.providerIssues).toMatchObject([
      { kind: "provider-only", issueRef: null, title: SHARED_TITLE, identity: { issueId: FIXTURE_ISSUE_ID } },
    ]);
    const native = cli(["issue", "show", "--id", FIXTURE_ISSUE_ID, "--project", REMOTE_PROJECT.localProjectId, "--harness", sandbox.harness]);
    expect(native.exitCode).toBe(0);
    expect(native.data).toMatchObject({ kind: "provider-only", issueRef: null, title: SHARED_TITLE });

    // note: The refusal block below runs several built-CLI subprocesses; re-prove the base first
    // so each refusal is its own tested cause and never an expired access check.
    refreshHost(fixture, sandbox);

    // note: Without the strict document the verb is a usage refusal (exit 2), before any store work.
    const missing = cli([
      ...REMOTE, "adopt-issue",
      "--harness", sandbox.harness,
      "--project", REMOTE_PROJECT.localProjectId,
      "--issue", FIXTURE_ISSUE_ID,
      "--operation", REFUSED_OPERATION,
    ]);
    expect(missing.exitCode).toBe(2);
    expect(missing.code).toBe("command.invalid-input");

    // note: Each caller-supplied field is its own case over the SAME strict baseline, so either one
    // being wrongly accepted fails on its own instead of hiding behind the other's refusal.
    const strayField = (operation: string, field: string): Record<string, unknown> => {
      const document = adoptionDocument(operation);
      return { ...document, capture: { ...(document.capture as Record<string, unknown>), [field]: "caller-supplied" } };
    };
    const callerTitle = adopt(sandbox, REFUSED_TITLE_OPERATION, FIXTURE_ISSUE_ID, strayField(REFUSED_TITLE_OPERATION, "title"));
    expect(callerTitle.exitCode).toBe(1);
    expect(callerTitle.code).toBe("remote.input-invalid");
    const callerProject = adopt(sandbox, REFUSED_PROJECT_OPERATION, FIXTURE_ISSUE_ID, strayField(REFUSED_PROJECT_OPERATION, "projectId"));
    expect(callerProject.exitCode).toBe(1);
    expect(callerProject.code).toBe("remote.input-invalid");

    // note: A marked issue of the same title refuses: adoption addresses only an unmarked identity,
    // and a title match is never an adoption.
    const markedAdoption = adopt(sandbox, MARKED_OPERATION, MARKED_ISSUE_ID);
    expect(markedAdoption.exitCode).toBe(1);
    expect(markedAdoption.code).toBe("remote.scope-mismatch");

    // invariant: Every refusal recorded nothing, and not only nothing dispatchable: the operation
    // ids name no intent at all, so `outbox-show` refuses instead of an empty pending query hiding
    // a terminal or in-flight row that reserved the id.
    for (const operation of [REFUSED_OPERATION, REFUSED_TITLE_OPERATION, REFUSED_PROJECT_OPERATION, MARKED_OPERATION]) {
      const shown = cli([...REMOTE, "outbox-show", "--harness", sandbox.harness, "--operation", operation]);
      expect(shown.exitCode).toBe(1);
      expect(shown.code).toBe("remote.intent-not-found");
    }
    expect(cli([...REMOTE, "outbox-pending", "--harness", sandbox.harness, "--project", REMOTE_PROJECT.localProjectId]).data).toMatchObject({ intents: [] });
    const afterRefusals = cli(["issue", "list", "--harness", sandbox.harness]);
    expect(afterRefusals.data).toMatchObject({ total: 1 });
    expect(afterRefusals.data.providerIssues).toMatchObject([
      { issueRef: null, title: SHARED_TITLE, identity: { issueId: FIXTURE_ISSUE_ID } },
    ]);
    const stillNative = cli(["issue", "show", "--id", FIXTURE_ISSUE_ID, "--project", REMOTE_PROJECT.localProjectId, "--harness", sandbox.harness]);
    expect(stillNative.exitCode).toBe(0);
    expect(stillNative.data).toMatchObject({ kind: "provider-only", issueRef: null });
    expect(stillNative.data.disposition).toBeUndefined();
    expect(fixture.providerCalls).toEqual([]);

    // note: The exact unmarked provider UUID freezes ONE durable intent — not an adoption.
    refreshHost(fixture, sandbox);
    const adopted = adopt(sandbox, ADOPT_OPERATION, FIXTURE_ISSUE_ID);
    expect(adopted.exitCode).toBe(0);
    expect(adopted.data).toMatchObject({ state: "enqueued", operationId: ADOPT_OPERATION, target: FIXTURE_ISSUE_ID });
    const pending = cli([...REMOTE, "outbox-pending", "--harness", sandbox.harness, "--project", REMOTE_PROJECT.localProjectId]);
    expect(pending.data.intents).toEqual([
      expect.objectContaining({ operationId: ADOPT_OPERATION, state: "enqueued", kind: "issue-adopt", target: FIXTURE_ISSUE_ID }),
    ]);
    // invariant: A pending summary is never a send permit.
    expect((pending.data.intents as Array<Record<string, unknown>>)[0]?.permit).toBeUndefined();

    // note: Exactly one permit across dispatch and its replay.
    refreshHost(fixture, sandbox);
    const dispatched = dispatch(sandbox, ADOPT_OPERATION);
    expect(dispatched.exitCode).toBe(0);
    expect(dispatched.data.kind).toBe("permit");
    const permit = dispatched.data.permit as unknown as OutboxPermit;
    expect(permit).toMatchObject({ operationId: ADOPT_OPERATION, binding: { generation: 1, projectKey: REMOTE_PROJECT.localProjectId } });
    expect(permit.frozenRequest.target).toBe(FIXTURE_ISSUE_ID);
    expect(typeof permit.attemptId).toBe("string");
    expect(typeof permit.requestHash).toBe("string");
    const replay = dispatch(sandbox, ADOPT_OPERATION);
    expect(replay.exitCode).toBe(0);
    expect(replay.data).toMatchObject({ kind: "state", state: "unconfirmed" });
    expect(replay.data.permit).toBeUndefined();

    // note: The host sends only that permit, and records the provider's answer.
    const confirmed = receipt(sandbox, fixture.send(permit));
    expect(confirmed.exitCode).toBe(0);
    expect(confirmed.data).toMatchObject({ state: "confirmed" });
    expect(fixture.providerCalls).toEqual([{ kind: "send", operationId: ADOPT_OPERATION }]);

    // invariant: A confirmed effect invalidates the base it moved, and a reader then gets no count
    // at all rather than a stale or zero one.
    expect(cli([...REMOTE, "status", "--harness", sandbox.harness]).data).toMatchObject({
      available: false,
      projects: [expect.objectContaining({ completeness: "unavailable", code: "remote.effect-confirmed" })],
    });
    const invalidated = cli(["issue", "list", "--harness", sandbox.harness]);
    expect(invalidated.exitCode).toBe(1);
    expect(invalidated.code).toBe("remote.unavailable");
    expect(invalidated.data.total).toBeUndefined();

    // note: Refresh from the provider, then read the finding by the reference its adoption minted.
    const revision = revisionOf(sandbox);
    const refreshed = observeAt(fixture, sandbox, revision);
    expect(refreshed.exitCode).toBe(0);
    expect(refreshed.data).toMatchObject({ revision: revision + 1, completeness: "complete" });

    const frozenChange = (permit.frozenRequest.event as { change: { issueRef: string } }).change;
    const issueRef = frozenChange.issueRef;
    const read = cli(["issue", "show", "--id", issueRef, "--harness", sandbox.harness]);
    expect(read.exitCode).toBe(0);
    expect(read.data).toMatchObject({
      issueRef,
      externalId: FIXTURE_ISSUE_ID,
      providerIdentity: { issueId: FIXTURE_ISSUE_ID },
      projectId: REMOTE_PROJECT.localProjectId,
      title: SHARED_TITLE,
      disposition: "open",
      revision: 1,
    });
    expect((read.data.occurrences as Array<Record<string, unknown>>)[0]).toMatchObject({
      occurrenceKey: `occurrence-${ADOPT_OPERATION}`,
      sourceIdentity: `review:${ADOPT_OPERATION}`,
    });

    // invariant: A provider-native `Done` is a display fact; the MStar disposition never follows it.
    fixture.setIssues([
      PROVIDER_ISSUES[0],
      { issueId: FIXTURE_ISSUE_ID, title: SHARED_TITLE, status: "Done", updatedAt: new Date().toISOString() },
    ]);
    const doneObservation = observeAt(fixture, sandbox, revision + 1);
    expect(doneObservation.exitCode).toBe(0);
    const afterDone = cli(["issue", "show", "--id", issueRef, "--harness", sandbox.harness]);
    expect(afterDone.exitCode).toBe(0);
    expect(afterDone.data).toMatchObject({ disposition: "open", nativeStatus: "Done" });
    expect(cli(["issue", "list", "--harness", sandbox.harness]).data).toMatchObject({ total: 2 });
  }, 120_000);

  test("a lost response stays unconfirmed on missing or ambiguous lookup evidence and confirms only the record it sent", () => {
    const fixture = host("lost-response");
    const sandbox = prepareHost(fixture);
    expect(observeAt(fixture, sandbox, 0).exitCode).toBe(0);
    expect(adopt(sandbox, LOST_OPERATION, FIXTURE_ISSUE_ID).data.state).toBe("enqueued");
    refreshHost(fixture, sandbox);
    const dispatched = dispatch(sandbox, LOST_OPERATION);
    expect(dispatched.exitCode).toBe(0);
    const permit = dispatched.data.permit as unknown as OutboxPermit;

    // note: The effect lands and the response is lost; the host records only what it saw. The
    // provider keeps the ONE record that send produced for the whole recovery.
    const sent = fixture.send(permit);
    const original = sent.outcome as { recordId: string; identity: unknown };
    const uncertain = receipt(sandbox, {
      ...sent,
      observedAt: new Date().toISOString(),
      outcome: { kind: "unconfirmed", reason: "no-response" },
    });
    expect(uncertain.exitCode).toBe(0);
    expect(uncertain.data).toMatchObject({ state: "unconfirmed", confirmed: null });

    // invariant: A replayed dispatch of an uncertain attempt answers state only — no second permit,
    // so no blind retry and no duplicate create.
    const replay = dispatch(sandbox, LOST_OPERATION);
    expect(replay.exitCode).toBe(0);
    expect(replay.data).toMatchObject({ kind: "state", state: "unconfirmed" });
    expect(replay.data.permit).toBeUndefined();

    const shown = sandbox.runJson([...REMOTE, "outbox-show", "--harness", sandbox.harness, "--operation", LOST_OPERATION]);
    expect(shown.data).toMatchObject({ state: "unconfirmed", attemptId: permit.attemptId });
    const intent = shown.data as unknown as OutboxIntent;

    // note: Each lookup is its own submission; a distinct observation instant keeps each one its
    // own evidence row instead of replaying the previous one.
    let tick = Date.now();
    const settle = (document: unknown): SandboxCommand =>
      sandbox.runJson([
        ...REMOTE, "outbox-reconcile", "--harness", sandbox.harness,
        "--input", sandbox.writeJson("reconcile", { ...(document as Record<string, unknown>), observedAt: new Date((tick += 2_000)).toISOString() }),
      ]);

    // note: The provider holds the record the send produced, but a stale read has not exposed it
    // yet: an effect a lookup cannot observe is an absence, never a confirmation.
    fixture.setAttemptObservable(permit, "stale");
    const missing = fixture.lookup(intent);
    expect(missing.outcome).toMatchObject({ kind: "unconfirmed", reason: "not-found" });
    const stillUncertain = settle(missing);
    expect(stillUncertain.exitCode).toBe(0);
    expect(stillUncertain.data).toMatchObject({ state: "unconfirmed", confirmed: null });
    const missingReplay = dispatch(sandbox, LOST_OPERATION);
    expect(missingReplay.data).toMatchObject({ kind: "state", state: "unconfirmed" });
    expect(missingReplay.data.permit).toBeUndefined();

    // invariant: A record the provider applied twice is ambiguous, never the effect — and the
    // ambiguity comes from provider-side history, not from a second host send.
    fixture.setAttemptObservable(permit, "duplicated");
    const ambiguous = fixture.lookup(intent);
    expect(ambiguous.outcome).toMatchObject({ kind: "unconfirmed", reason: "ambiguous" });
    const ambiguousSettlement = settle(ambiguous);
    expect(ambiguousSettlement.exitCode).toBe(0);
    expect(ambiguousSettlement.data).toMatchObject({ state: "unconfirmed", confirmed: null });
    const ambiguousReplay = dispatch(sandbox, LOST_OPERATION);
    expect(ambiguousReplay.data).toMatchObject({ kind: "state", state: "unconfirmed" });
    expect(ambiguousReplay.data.permit).toBeUndefined();

    // invariant: Only a unique exact match advances the attempt to confirmed — and it is the
    // immutable record the original send produced, with the identity it landed on.
    fixture.setAttemptObservable(permit, "sole");
    const unique = fixture.lookup(intent);
    // note: The lookup's outcome is the host evidence document; only its own record may confirm.
    const confirmedOutcome = unique.outcome as { identity: unknown; recordId: string };
    expect(confirmedOutcome).toMatchObject({ kind: "confirmed", recordId: original.recordId });
    expect(confirmedOutcome.identity).toEqual(original.identity);
    const settled = settle(unique);
    expect(settled.exitCode).toBe(0);
    expect(settled.data.state).toBe("confirmed");
    expect(settled.data.confirmed).toMatchObject({ recordId: original.recordId, identity: original.identity });

    // invariant: One host send and three read-only lookups — no retry, so no duplicate create.
    expect(fixture.providerCalls).toEqual([
      { kind: "send", operationId: LOST_OPERATION },
      { kind: "lookup", operationId: LOST_OPERATION },
      { kind: "lookup", operationId: LOST_OPERATION },
      { kind: "lookup", operationId: LOST_OPERATION },
    ]);

    const refreshed = observeAt(fixture, sandbox, revisionOf(sandbox));
    expect(refreshed.exitCode).toBe(0);
    const listed = sandbox.runJson(["issue", "list", "--harness", sandbox.harness]);
    expect(listed.data).toMatchObject({ total: 2 });
    const refs = (listed.data.items as Array<Record<string, unknown>>).map((item) => item.issueRef);
    expect(new Set(refs).size).toBe(2);
  }, 120_000);

  test("a competing provider effect is surfaced as a conflict, never overwritten", () => {
    const fixture = host("conflict");
    const sandbox = prepareHost(fixture);
    expect(observeAt(fixture, sandbox, 0).exitCode).toBe(0);
    expect(adopt(sandbox, CONFLICT_OPERATION, FIXTURE_ISSUE_ID).data.state).toBe("enqueued");
    refreshHost(fixture, sandbox);
    const dispatched = dispatch(sandbox, CONFLICT_OPERATION);
    expect(dispatched.exitCode).toBe(0);
    const permit = dispatched.data.permit as unknown as OutboxPermit;
    const competing = fixture.conflict(permit);
    expect(competing.outcome).toMatchObject({ kind: "conflict" });

    const surfaced = receipt(sandbox, competing);
    expect(surfaced.exitCode).toBe(0);
    expect(surfaced.data).toMatchObject({ state: "conflict", confirmed: null });
    expect(fixture.providerCalls).toEqual([{ kind: "send", operationId: CONFLICT_OPERATION }]);

    // invariant: A conflict is terminal for that intent: no permit, and no confirmation rewrites it.
    // note: Re-prove the check and traversal first, so the refusal can only be the recorded conflict
    // and never a check that expired while the suite queued its subprocesses.
    refreshHost(fixture, sandbox);
    const blocked = dispatch(sandbox, CONFLICT_OPERATION);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.code).toBe("remote.dispatch-refused");
    expect(blocked.data.permit).toBeUndefined();

    const overwrite = receipt(sandbox, {
      version: 1,
      selectorCommit: permit.binding.selectorCommit,
      generation: permit.binding.generation,
      projectId: REMOTE_PROJECT.localProjectId,
      operationId: CONFLICT_OPERATION,
      attemptId: permit.attemptId,
      requestHash: permit.requestHash,
      observedAt: new Date().toISOString(),
      outcome: {
        kind: "confirmed",
        identity: {
          provider: "linear",
          workspaceId: REMOTE_PROJECT.workspaceId,
          teamId: REMOTE_PROJECT.teamId,
          projectId: REMOTE_PROJECT.projectId,
          issueId: FIXTURE_ISSUE_ID,
        },
        recordId: "88888888-8888-4888-8888-888888888888",
        event: permit.frozenRequest.event,
      },
    });
    expect(overwrite.exitCode).toBe(1);
    expect(overwrite.code).toBe("remote.dispatch-refused");

    // invariant: The recorded fork is durable proof the base moved, so the cache stops serving a
    // count at all instead of zero.
    const invalidated = sandbox.runJson(["issue", "list", "--harness", sandbox.harness]);
    expect(invalidated.exitCode).toBe(1);
    expect(invalidated.code).toBe("remote.unavailable");
    expect(invalidated.data.total).toBeUndefined();
    const shown = sandbox.runJson([...REMOTE, "outbox-show", "--harness", sandbox.harness, "--operation", CONFLICT_OPERATION]);
    expect(shown.data).toMatchObject({ state: "conflict" });

    // invariant: The competing record is PROVIDER state, not a receipt echo: it survives the whole
    // conflict handling, so the next traversal still renders the subject the host never sent.
    const competingOutcome = competing.outcome as { observedHeads: readonly string[] };
    const held = fixture.confirmedIssue(CONFLICT_OPERATION);
    expect(held).not.toBeNull();
    expect(competingOutcome.observedHeads).toContain(held!.head[0]);
    expect(held!.subject).toMatchObject({ fields: { revision: 2, disposition: "open", title: SHARED_TITLE } });

    const refreshed = observeAt(fixture, sandbox, revisionOf(sandbox));
    expect(refreshed.exitCode).toBe(0);
    expect(refreshed.data).toMatchObject({ completeness: "complete" });

    // note: A fresh provider traversal still renders the competing subject, so the record lives in
    // provider state rather than in the receipt the host recorded.
    const traversal = fixture.observe(REMOTE_PROJECT, 0).snapshot as { issues: Array<Record<string, unknown>> };
    const carried = traversal.issues.find((issue) => (issue.identity as { issueId: string }).issueId === FIXTURE_ISSUE_ID);
    expect(carried?.mstar).toMatchObject({
      issueRef: held!.issueRef,
      head: held!.head,
      fields: { title: SHARED_TITLE, disposition: "open", revision: 2 },
    });

    // invariant: The fork is unresolved, so the read still refuses rather than answering the frozen
    // adoption's subject — and it refuses with the fork's own cause, never a count.
    const rendered = sandbox.runJson(["issue", "show", "--id", held!.issueRef, "--harness", sandbox.harness]);
    expect(rendered.exitCode).toBe(1);
    expect(rendered.code).toBe("remote.unavailable");
    expect(rendered.data.total).toBeUndefined();
    expect(sandbox.runJson(["issue", "list", "--harness", sandbox.harness]).code).toBe("remote.unavailable");
  }, 120_000);

  test("a stale observation base refuses and leaves the admitted cache in place", () => {
    const fixture = host("stale");
    const sandbox = prepareHost(fixture);
    expect(observeAt(fixture, sandbox, 0).data).toMatchObject({ revision: 1, completeness: "complete" });

    // note: The refused submission carries a DIFFERENT, valid payload, so a regression that wrote
    // it while still reporting the stale revision would become visible in the admitted cache.
    const refusedDirection = "A refused base must never replace the admitted direction.";
    fixture.setProjectDocument({
      ...PROJECT_DOCUMENT,
      roadmap: {
        ...PROJECT_DOCUMENT.roadmap,
        contentMarkdown: PROJECT_DOCUMENT.roadmap.contentMarkdown.replace(
          "Prove the host-mediated round trip at the controlled boundary.",
          refusedDirection,
        ),
      },
    });

    // note: The submission addresses revision 0 while the cache already holds 1.
    const stale = observeAt(fixture, sandbox, 0);
    expect(stale.exitCode).toBe(1);
    expect(stale.code).toBe("collaboration.observation-stale");

    // invariant: The refused base wrote nothing: the cached revision, the admitted roadmap, the
    // marked finding and the visible unmarked issue all stay as the previous observation left them.
    const roadmap = sandbox.runJson(["roadmap", "show", "--harness", sandbox.harness, "--project", REMOTE_PROJECT.localProjectId]);
    expect(roadmap.exitCode).toBe(0);
    const direction = (roadmap.data.content as { direction?: unknown } | null)?.direction;
    expect(String(direction)).toContain("controlled boundary");
    expect(String(direction)).not.toContain("refused base");
    const status = sandbox.status();
    expect(status.data).toMatchObject({ available: true, projects: [expect.objectContaining({ revision: 1, completeness: "complete" })] });
    const listed = sandbox.runJson(["issue", "list", "--harness", sandbox.harness]);
    expect(listed.data).toMatchObject({ total: 1 });
    expect(listed.data.providerIssues).toMatchObject([
      { issueRef: null, identity: { issueId: FIXTURE_ISSUE_ID } },
    ]);
    expect(fixture.providerCalls).toEqual([]);
  }, 120_000);
});
