/**
 * note: The two-checkout cross-authority move (T2) at the shipped CLI boundary.
 *
 * A checkout writes only the lane its own mode selects, so a record crossing a `local`/`remote`
 * boundary is two halves that exchange documents. Every step below runs the BUILT CLI in a sandbox
 * with its own workspace and `HOME`; the provider state lives in this test runner and only public
 * JSON documents cross into a child. Provider-free by construction: no client, credential or
 * transport is reachable from either side, and the isolation suite pins that.
 *
 * The assertions are the durable facts an operator recovers from — the ledger phase each side holds,
 * the one frozen intent a direction freezes, the refusal a source write meets mid-move, the
 * `IssueRef` both sides carry, and the selector generation the move never touches.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_ISSUE_ID,
  REMOTE_PROJECT,
  RemoteCollaborationFixture,
  type RemoteSandbox,
  type SandboxCommand,
} from "./support/remote-collaboration-fixture";

const REMOTE = ["store", "collaboration", "remote"] as const;
const FIXTURE_REF = "mstar:issue:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AT = "2026-11-20T00:00:00.000Z";
const MOVE_OPERATION = "11111111-1111-4111-8111-111111111111";

/** note: One marked provider record: the subject a remote source freezes and a destination admits. */
const MARKED_ISSUE = "77777777-7777-4777-8777-777777777701";

function markedRecord() {
  return {
    issueRef: FIXTURE_REF,
    head: ["3".repeat(64)],
    subject: {
      fields: {
        title: "Moving finding",
        kind: "bug",
        severity: "high",
        disposition: "open",
        impact: "A record must cross an authority with its history intact.",
        acceptance: "The destination carries the same reference and the same history counts.",
        owner: "fullstack-dev",
        registeredAt: AT,
        closedAt: null,
        closureNote: null,
        createdAt: AT,
        updatedAt: AT,
        revision: 2,
        milestoneId: null,
      },
      occurrences: [
        {
          eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          occurrenceKey: "occ-move-1",
          sourceKind: "test",
          sourceIdentity: "review/move",
          rootCauseKey: "move.root",
          acceptanceKey: "move.accept",
          location: "packages/cli/test/cross-authority-move-remote.test.ts",
          observedBehavior: "The first observation.",
          evidence: ["controlled host fixture"],
          discoveredAt: AT,
          recordedAt: AT,
          imported: false,
        },
        {
          eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
          occurrenceKey: "occ-move-2",
          sourceKind: "test",
          sourceIdentity: "review/move",
          rootCauseKey: "move.root",
          acceptanceKey: "move.accept",
          location: "packages/cli/test/cross-authority-move-remote.test.ts",
          observedBehavior: "The second observation.",
          evidence: [],
          discoveredAt: AT,
          recordedAt: AT,
          imported: false,
        },
      ],
      transitions: [],
      relations: [],
      provenance: [
        {
          eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
          kind: "plan",
          target: "20261124-cross-authority-move",
          sourceHash: "4".repeat(64),
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
  } as const;
}

/** note: Bring one remote sandbox to a bound, initialized, observed lane holding the marked record. */
function remoteHost(fixture: RemoteCollaborationFixture, name = "remote"): RemoteSandbox {
  fixture.seedRecord(MARKED_ISSUE, markedRecord());
  fixture.setIssues([{ issueId: MARKED_ISSUE, title: "Moving finding", status: "Todo", updatedAt: AT }]);
  const sandbox = fixture.sandbox(name);
  expect(sandbox.bind(fixture.verify()).exitCode).toBe(0);
  expect(sandbox.init().exitCode).toBe(0);
  expect(sandbox.observe(fixture.observe(REMOTE_PROJECT, 0)).exitCode).toBe(0);
  return sandbox;
}

/** note: One local sandbox: its own origin, its own `HOME`, and its own local lane. */
function localHost(fixture: RemoteCollaborationFixture, name = "local"): RemoteSandbox {
  const sandbox = fixture.localSandbox(name);
  expect(sandbox.init().exitCode).toBe(0);
  return sandbox;
}

/** note: The selector generation both sides observe, so a move is proved not to advance it. */
function generation(sandbox: RemoteSandbox): unknown {
  return sandbox.status().data.binding;
}

describe("cross-authority move through two checkouts", () => {
  const fixtures: RemoteCollaborationFixture[] = [];

  function host(name: string): RemoteCollaborationFixture {
    const created = new RemoteCollaborationFixture(`cross-authority-move-${name}`);
    fixtures.push(created);
    return created;
  }

  test("remote to local: the source tombstone is an obsolete replacement, confirmed before the destination admits", () => {
    const fixture = host("remote-to-local");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const destination = localHost(fixture);

      // note: Step 1 — the remote source freezes the OBSERVED subject and emits the request document.
      const requestPath = source.outPath("request");
      const staged = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", requestPath,
      ]);
      expect(staged.result.stderr).toBe("");
      expect(staged.exitCode).toBe(0);
      expect(staged.data).toMatchObject({ phase: "staged", side: "source", issueRef: FIXTURE_REF });
      expect(staged.data.out).toBe(requestPath);
      const request = source.readOut(requestPath);
      expect(request).toMatchObject({
        version: 1,
        phase: "request",
        operationId: MOVE_OPERATION,
        issueRef: FIXTURE_REF,
        destinationAuthority: fixture.localRepoKey,
        destinationProject: "_default",
      });

      // invariant: A source write during the move is refused, by the move's own fence.
      const blocked = source.runJson([
        "issue", "triage",
        "--id", FIXTURE_REF,
        "--payload", JSON.stringify({ reason: "mid-move edit", severity: "low" }),
        "--expect", "2",
        "--actor", "project-manager",
        "--operation-id", "22222222-2222-4222-8222-222222222222",
      ]);
      expect(blocked.exitCode).toBe(1);
      expect(blocked.code).toBe("issue.move-in-progress");

      // note: Step 2 — the local destination writes its own row, verifies, and emits the staged document.
      const stagedPath = destination.outPath("staged");
      const verified = destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect-store", "0",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", requestPath,
        "--out", stagedPath,
      ]);
      expect(verified.result.stderr).toBe("");
      expect(verified.exitCode).toBe(0);
      expect(verified.data).toMatchObject({ phase: "verified", side: "destination", issueRef: FIXTURE_REF });
      expect(destination.readOut(stagedPath)).toMatchObject({ phase: "staged", issueRef: FIXTURE_REF });

      // note: Step 3 — the source verifies the staged handoff, freezes ONE obsolete replacement and
      // answers `remote.effect-pending`: the tombstone is confirmed before the destination admits.
      const tombstone = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", stagedPath,
      ]);
      expect(tombstone.exitCode).toBe(1);
      expect(tombstone.code).toBe("remote.effect-pending");
      const tombstoneDetails = (JSON.parse(tombstone.result.stdout) as { details: Record<string, unknown> }).details;
      expect(tombstoneDetails).toMatchObject({ state: "enqueued" });

      // invariant: The tombstone is one `issue-replace`, and it closes the record obsolete.
      const operation = String(tombstoneDetails.operationId);
      const dispatch = source.runJson([...REMOTE, "outbox-dispatch", "--harness", source.harness, "--operation", operation]);
      expect(dispatch.exitCode).toBe(0);
      const permit = dispatch.data.permit as unknown as { frozenRequest: { event: { change: { kind: string; mstar: { fields: { disposition: string } } } } } };
      expect(permit.frozenRequest.event.change.kind).toBe("issue-replace");
      expect(permit.frozenRequest.event.change.mstar.fields.disposition).toBe("obsolete");
      const receipt = fixture.send(permit as never);
      const recorded = source.runJson([
        ...REMOTE, "outbox-receipt", "--harness", source.harness,
        "--input", source.writeJson("receipt", receipt),
      ]);
      expect(recorded.exitCode).toBe(0);
      expect(recorded.data.state).toBe("confirmed");

      // note: Step 3b — the same command now writes `switched` and emits the switch document.
      const switchPath = source.outPath("switch");
      const switched = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", stagedPath,
        "--out", switchPath,
      ]);
      expect(switched.result.stderr).toBe("");
      expect(switched.exitCode).toBe(0);
      expect(switched.data).toMatchObject({ phase: "switched", side: "source" });
      // invariant: the source is `switched` only after the tombstone confirmed, never before.
      expect(source.readOut(switchPath)).toMatchObject({ phase: "switch", issueRef: FIXTURE_REF });

      // note: Step 4 — the destination admits the record and emits the admission document.
      const admissionPath = destination.outPath("admission");
      const admitted = destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect-store", "0",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", switchPath,
        "--out", admissionPath,
      ]);
      expect(admitted.result.stderr).toBe("");
      expect(admitted.exitCode).toBe(0);
      expect(admitted.data).toMatchObject({ phase: "switched", side: "destination", issueRef: FIXTURE_REF });
      expect(admitted.data.destinationIssueId).toBeTruthy();

      // invariant: The destination reads the SAME reference and the same history counts.
      const shown = destination.runJson(["issue", "show", "--id", String(admitted.data.destinationIssueId), "--harness", destination.harness]);
      expect(shown.exitCode).toBe(0);
      expect(shown.data).toMatchObject({ issueRef: FIXTURE_REF, projectId: "_default" });
      expect((shown.data.occurrences as unknown[]).length).toBe(2);
      expect((shown.data.provenance as unknown[]).length).toBe(1);

      // note: Step 5 — the source publishes.
      const published = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", admissionPath,
      ]);
      expect(published.result.stderr).toBe("");
      expect(published.exitCode).toBe(0);
      expect(published.data).toMatchObject({ phase: "published", side: "source" });

      // invariant: The selector generation is the SAME before and after the move.
      expect(generation(source)).toMatchObject({ state: "bound", generation: 1 });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("local to remote: one issue-create carrying the existing reference, and the source publishes after the receipt", () => {
    const fixture = host("local-to-remote");
    try {
      fixture.publish(1);
      const destination = remoteHost(fixture, "remote-destination");
      const source = localHost(fixture, "local-source");
      const remoteKey = fixture.repoKey;

      // note: Seed one local record with occurrences and provenance, in the source checkout's lane.
      const seeded = source.runJson([
        "issue", "add",
        "--payload", JSON.stringify({
          projectId: "_default",
          title: "Local finding that leaves",
          kind: "bug",
          severity: "high",
          impact: "A local record must carry its reference to a remote authority.",
          acceptance: "The provider holds the same reference after the move.",
          sourceIdentity: "review/local-move",
          rootCauseKey: "local.move.root",
          acceptanceKey: "local.move.accept",
          occurrenceKey: "occ-local-move",
          sourceKind: "test",
          location: "packages/cli/test/cross-authority-move-remote.test.ts",
          observedBehavior: "The record left its local authority.",
          evidence: ["controlled host fixture"],
          discoveredAt: AT,
        }),
        "--actor", "project-manager",
        "--operation-id", "33333333-3333-4333-8333-333333333333",
      ]);
      expect(seeded.result.stderr).toBe("");
      expect(seeded.exitCode).toBe(0);
      const localId = String(seeded.data.issueId);
      const shown = source.runJson(["issue", "show", "--id", localId, "--harness", source.harness]);
      const localRef = String(shown.data.issueRef);
      const list = source.runJson(["issue", "list", "--harness", source.harness]);
      const storeRevision = String(list.data.storeRevision);

      // note: Step 1 — the local source freezes the record and emits the request document.
      const requestPath = source.outPath("request");
      const staged = source.runJson([
        "issue", "move",
        "--id", localId,
        "--to-authority", remoteKey,
        "--payload", JSON.stringify({ projectId: REMOTE_PROJECT.localProjectId, reason: "cross to the provider" }),
        "--expect", "1",
        "--expect-store", storeRevision,
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", requestPath,
      ]);
      expect(staged.result.stderr).toBe("");
      expect(staged.exitCode).toBe(0);
      expect(staged.data).toMatchObject({ phase: "staged", side: "source", issueRef: localRef });
      const request = source.readOut(requestPath);
      expect(request).toMatchObject({
        phase: "request",
        issueRef: localRef,
        destinationAuthority: remoteKey,
        destinationProject: REMOTE_PROJECT.localProjectId,
      });

      // invariant: A source write during the move is refused by the lane's own TRIGGER, which the
      // issue write entries map to the partial outcome naming the move: no calling path can write a
      // frozen record by forgetting to ask.
      const blocked = source.runJson([
        "issue", "triage",
        "--id", localId,
        "--payload", JSON.stringify({ reason: "mid-move edit", severity: "low" }),
        "--expect", "1",
        "--actor", "project-manager",
        "--operation-id", "44444444-4444-4444-8444-444444444444",
      ]);
      expect(blocked.exitCode).toBe(1);
      expect(blocked.code).toBe("collaboration.operation-partial");
      expect(blocked.message).toContain("issue.move-in-progress");
      expect(blocked.message).toContain(MOVE_OPERATION);

      // note: Step 2 — the local destination freezes ONE issue-create carrying the existing reference.
      const pending = destination.runJson([
        "issue", "move",
        "--id", localRef,
        "--to-authority", remoteKey,
        "--payload", JSON.stringify({ projectId: REMOTE_PROJECT.localProjectId, reason: "cross to the provider" }),
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", requestPath,
      ]);
      expect(pending.result.stderr).toBe("");
      expect(pending.exitCode).toBe(1);
      expect(pending.code).toBe("remote.effect-pending");
      const createOperation = String((JSON.parse(pending.result.stdout) as { details: { operationId: string } }).details.operationId);

      const dispatch = destination.runJson([...REMOTE, "outbox-dispatch", "--harness", destination.harness, "--operation", createOperation]);
      expect(dispatch.exitCode).toBe(0);
      const permit = dispatch.data.permit as unknown as { frozenRequest: { event: { change: { kind: string; issueRef: string } } } };
      expect(permit.frozenRequest.event.change.kind).toBe("issue-create");
      expect(permit.frozenRequest.event.change.issueRef).toBe(localRef);
      const receipt = fixture.send(permit as never);
      const recorded = destination.runJson([
        ...REMOTE, "outbox-receipt", "--harness", destination.harness,
        "--input", destination.writeJson("receipt", receipt),
      ]);
      expect(recorded.exitCode).toBe(0);
      expect(recorded.data.state).toBe("confirmed");

      // note: Step 3 — the same command verifies the confirmation and emits the admission document.
      const admissionPath = destination.outPath("admission");
      const admitted = destination.runJson([
        "issue", "move",
        "--id", localRef,
        "--to-authority", remoteKey,
        "--payload", JSON.stringify({ projectId: REMOTE_PROJECT.localProjectId, reason: "cross to the provider" }),
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", requestPath,
        "--out", admissionPath,
      ]);
      expect(admitted.result.stderr).toBe("");
      expect(admitted.exitCode).toBe(0);
      expect(admitted.data).toMatchObject({ phase: "switched", side: "destination", issueRef: localRef });
      expect(destination.readOut(admissionPath)).toMatchObject({ phase: "admission", issueRef: localRef });

      // note: Step 4 — the source verifies the admission, switches and publishes once.
      const published = source.runJson([
        "issue", "move",
        "--id", localId,
        "--to-authority", remoteKey,
        "--payload", JSON.stringify({ projectId: REMOTE_PROJECT.localProjectId, reason: "cross to the provider" }),
        "--expect", "1",
        "--expect-store", storeRevision,
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", admissionPath,
      ]);
      expect(published.result.stderr).toBe("");
      expect(published.exitCode).toBe(0);
      expect(published.data).toMatchObject({ phase: "published", side: "source" });

      // invariant: The selector generation is the SAME before and after the move.
      expect(generation(destination)).toMatchObject({ state: "bound", generation: 1 });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("remote to remote still refuses collaboration.mode-unavailable", () => {
    const fixture = host("remote-to-remote");
    try {
      fixture.publish(1);
      const second = fixture.sandbox("second-remote");
      expect(second.bind(fixture.verify()).exitCode).toBe(0);
      expect(second.init().exitCode).toBe(0);
      const source = remoteHost(fixture, "first-remote");
      // note: the second remote checkout's lane exists, so the combination is genuinely remote-to-remote.
      expect(second.status().exitCode).toBe(0);
      const refused = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.repoKey,
        "--payload", JSON.stringify({ projectId: REMOTE_PROJECT.localProjectId, reason: "should refuse" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
      ]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("collaboration.mode-unavailable");
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a handoff from another operation is refused, never acted on", () => {
    const fixture = host("foreign-handoff");
    try {
      const destination = localHost(fixture);
      const foreign = destination.writeJson("foreign", {
        version: 1,
        phase: "request",
        operationId: "99999999-9999-4999-8999-999999999999",
        issueRef: FIXTURE_REF,
        sourceAuthority: "github.com/other/authority",
        destinationAuthority: fixture.localRepoKey,
        destinationProject: "_default",
        actor: "project-manager",
        reason: "a foreign document",
        payloadJson: "{}",
        payloadDigest: "0".repeat(64),
        stagedCounts: "{}",
        sourceIssueId: null,
        destinationIssueId: null,
      });
      const refused = destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "carry my move" }),
        "--expect-store", "0",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", foreign,
      ]);
      expect(refused.exitCode).toBe(1);
      expect(["remote.input-invalid", "store.operation-conflict"]).toContain(String(refused.code));
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 120_000);
});
