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
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
          legacyProject: "legacy-project",
          legacyBucket: "legacy-bucket",
          legacyEntryId: "legacy-entry",
          // note: the imported row's own document, which a move must carry to the other authority.
          legacyJson: JSON.stringify({ legacyId: "legacy-1", title: "Imported finding", detailDoc: "legacy-doc" }),
          importedAt: AT,
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

/**
 * note: One sandbox's own collaboration lane, opened read-only by the test runner: the ledger row a
 * side wrote and the generation its own store records are durable facts, never narrated by a receipt.
 */
function laneOf(fixture: RemoteCollaborationFixture, sandbox: RemoteSandbox): DatabaseSync {
  return new DatabaseSync(fixture.cachePath(sandbox));
}

/** note: The generation one sandbox's own store records, which both ledger halves must name. */
function laneGeneration(db: DatabaseSync): { storeId: string; epoch: number } {
  const row = db.prepare("select store_id as storeId, authority_epoch as epoch from collaboration_meta where id = 1").get() as
    | { storeId?: unknown; epoch?: unknown }
    | undefined;
  if (typeof row?.storeId !== "string" || typeof row.epoch !== "number") {
    throw new Error("the sandbox lane answered no store generation");
  }
  return { storeId: row.storeId, epoch: row.epoch };
}

/** note: The generation one side's ledger row carries for a move; `null` before that side wrote it. */
function moveGeneration(db: DatabaseSync, operationId: string, role: "source" | "destination"): { storeId: string; epoch: number } | null {
  const row = db
    .prepare("select source_store_id as storeId, source_epoch as epoch from issue_moves where operation_id = ? and role = ?")
    .get(operationId, role) as { storeId?: unknown; epoch?: unknown } | undefined;
  if (row === undefined) return null;
  if (typeof row.storeId !== "string" || typeof row.epoch !== "number") {
    throw new Error(`the ${role} ledger row of ${operationId} carries no generation`);
  }
  return { storeId: row.storeId, epoch: row.epoch };
}

/** note: The structured facts a refusal carries, narrowed from the envelope instead of cast. */
function refusalDetails(command: SandboxCommand): Record<string, unknown> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(command.result.stdout);
  } catch {
    return {};
  }
  if (typeof envelope !== "object" || envelope === null || !("details" in envelope)) return {};
  const details = envelope.details;
  return typeof details === "object" && details !== null && !Array.isArray(details) ? (details as Record<string, unknown>) : {};
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
      // invariant: The document names the source lane's OWN store generation, never the repository key
      // and never the destination's epoch: both ledger halves have to name one source generation.
      const sourceLane = laneOf(fixture, source);
      const sourceGeneration = laneGeneration(sourceLane);
      try {
        expect(request.sourceStoreId).toBe(sourceGeneration.storeId);
        expect(request.sourceEpoch).toBe(sourceGeneration.epoch);
        expect(moveGeneration(sourceLane, MOVE_OPERATION, "source")).toEqual(sourceGeneration);
      } finally {
        sourceLane.close();
      }

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

      // invariant: The destination's own ledger row names the SAME source generation the source froze,
      // not its own epoch and not the repository key.
      const destinationLaneNow = laneOf(fixture, destination);
      try {
        expect(moveGeneration(destinationLaneNow, MOVE_OPERATION, "destination")).toEqual(sourceGeneration);
      } finally {
        destinationLaneNow.close();
      }

      // invariant: The destination reads the SAME reference and the same history counts.
      const shown = destination.runJson(["issue", "show", "--id", String(admitted.data.destinationIssueId), "--harness", destination.harness]);
      expect(shown.exitCode).toBe(0);
      expect(shown.data).toMatchObject({ issueRef: FIXTURE_REF, projectId: "_default" });
      expect((shown.data.occurrences as unknown[]).length).toBe(2);
      expect((shown.data.provenance as unknown[]).length).toBe(1);
      // invariant: An imported row's own document survives the move. The remote detail exposes it as
      // `legacyJson`; a copy that read another member carried SQL NULL and silently lost it.
      const provenance = (shown.data.provenance as Array<Record<string, unknown>>)[0]!;
      expect(JSON.parse(String(provenance.legacyJson)) as Record<string, unknown>).toMatchObject({ legacyId: "legacy-1" });
      expect(provenance.legacyProject).toBe("legacy-project");
      // invariant: The membership row records the project the record LEFT — the OBSERVED provider
      // project — never the destination project the record just entered.
      expect((shown.data.projectMoves as Array<Record<string, unknown>>).at(-1)).toMatchObject({
        fromProject: REMOTE_PROJECT.localProjectId,
        toProject: "_default",
      });

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

      // invariant: A published move answers its receipt, never a re-emitted `request`: staging from one
      // would recreate a record this authority already published.
      const terminalPath = source.outPath("terminal-request");
      const terminal = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", terminalPath,
      ]);
      expect(terminal.result.stderr).toBe("");
      expect(terminal.exitCode).toBe(0);
      expect(terminal.data).toMatchObject({ phase: "published", document: null, out: null });
      expect(existsSync(terminalPath)).toBe(false);

      // invariant: The selector generation is the SAME before and after the move.
      expect(generation(source)).toMatchObject({ state: "bound", generation: 1 });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a mismatched switch handoff discards the destination's own staged row, never the ledger as corrupt", () => {
    // invariant: A destination-only lane holds no source row. A failed handoff verification there must
    // discard the row THAT lane holds and answer `collaboration.operation-partial`; a source-role lookup
    // would find nothing and report `store.corrupt`, leaving the staged copy in place.
    const fixture = host("destination-mismatch");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const destination = localHost(fixture);
      const moveArgs = [
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
      ];

      const requestPath = source.outPath("request");
      expect(source.runJson([...moveArgs, "--out", requestPath]).data).toMatchObject({ phase: "staged", side: "source" });
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
      expect(verified.data).toMatchObject({ phase: "verified", side: "destination" });

      // note: The document the source would hand over, with one carried count rewritten in transit:
      // every binding field still matches, so only the verification can tell it apart.
      const tampered = destination.writeJson("tampered-switch", {
        ...destination.readOut(stagedPath),
        phase: "switch",
        stagedCounts: JSON.stringify({
          occurrences: 9, issueTransitions: 0, provenance: 1, relations: 0, issueProjectMoves: 0, relationsLeftBehind: 0,
        }),
      });
      const refused = destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect-store", "0",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", tampered,
      ]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("collaboration.operation-partial");
      expect(refused.message).toContain("counts");
      expect(refusalDetails(refused)).toMatchObject({ operation_id: MOVE_OPERATION, phase: "discarded" });

      // invariant: THIS lane's row is the one that discarded, and no record was admitted.
      const lane = laneOf(fixture, destination);
      try {
        expect(
          lane.prepare("select phase from issue_moves where operation_id = ? and role = 'destination'").get(MOVE_OPERATION),
        ).toEqual({ phase: "discarded" });
        expect(lane.prepare("select count(*) as n from issues where issue_ref = ?").get(FIXTURE_REF)).toEqual({ n: 0 });
      } finally {
        lane.close();
      }
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
      // invariant: The other direction carries the same fact: a LOCAL source's own store generation
      // crosses in the document, and the remote destination's ledger row binds that value, not the
      // repository key and not the destination cache's epoch.
      const localLane = laneOf(fixture, source);
      const localGeneration = laneGeneration(localLane);
      try {
        expect(request.sourceStoreId).toBe(localGeneration.storeId);
        expect(request.sourceEpoch).toBe(localGeneration.epoch);
        expect(moveGeneration(localLane, MOVE_OPERATION, "source")).toEqual(localGeneration);
      } finally {
        localLane.close();
      }

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
      const permit = dispatch.data.permit as unknown as {
        frozenRequest: {
          event: { change: { kind: string; issueRef: string; mstar: { fields: { revision: number }; projectMoves: Array<Record<string, unknown>> } } };
        };
      };
      expect(permit.frozenRequest.event.change.kind).toBe("issue-create");
      expect(permit.frozenRequest.event.change.issueRef).toBe(localRef);
      // invariant: Admission is an event ON the record, so the create the destination freezes carries it
      // — the revision advanced by one and the membership row appended — instead of resetting the record
      // to revision 1 and dropping the move from its own history.
      expect(permit.frozenRequest.event.change.mstar.fields.revision).toBe(2);
      expect(permit.frozenRequest.event.change.mstar.projectMoves).toEqual([
        expect.objectContaining({ fromProject: "_default", toProject: REMOTE_PROJECT.localProjectId, issueRevision: 2 }),
      ]);
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
      // invariant: The remote destination's ledger row names the LOCAL source's generation.
      const remoteLaneNow = laneOf(fixture, destination);
      try {
        expect(moveGeneration(remoteLaneNow, MOVE_OPERATION, "destination")).toEqual(localGeneration);
      } finally {
        remoteLaneNow.close();
      }

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

      // invariant: The same guard on the local half: a published move answers its receipt, never a
      // re-emitted `request` the peer would stage a second record from.
      const terminalPath = source.outPath("terminal-request");
      const terminal = source.runJson([
        "issue", "move",
        "--id", localId,
        "--to-authority", remoteKey,
        "--payload", JSON.stringify({ projectId: REMOTE_PROJECT.localProjectId, reason: "cross to the provider" }),
        "--expect", "1",
        "--expect-store", storeRevision,
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", terminalPath,
      ]);
      expect(terminal.result.stderr).toBe("");
      expect(terminal.exitCode).toBe(0);
      expect(terminal.data).toMatchObject({ phase: "published", document: null, out: null });
      expect(existsSync(terminalPath)).toBe(false);

      // invariant: The selector generation is the SAME before and after the move.
      expect(generation(destination)).toMatchObject({ state: "bound", generation: 1 });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a remote record with a live provider intent refuses to stage, and stages once the intent is abandoned", () => {
    // invariant: The spec's stage precondition, at the shipped boundary: a `remote_outbox` intent whose
    // frozen event carries the record's reference refuses the remote source's `stage` with
    // `remote.effect-pending`, because the provider may already hold that write. The refusal happens
    // inside the lane's write transaction, so no `staged` row and no handoff exist afterwards.
    const fixture = host("intent-pending");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const destination = localHost(fixture);
      const moveArgs = [
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
      ];

      // note: One ordinary remote write freezes a live `issue-replace` for this same reference.
      const triage = source.runJson([
        "issue", "triage",
        "--id", FIXTURE_REF,
        "--payload", JSON.stringify({ reason: "reclassified before the move", severity: "low" }),
        "--expect", "2",
        "--project", REMOTE_PROJECT.localProjectId,
        "--actor", "project-manager",
        "--operation-id", "22222222-2222-4222-8222-222222222222",
      ]);
      expect(triage.exitCode).toBe(1);
      expect(triage.code).toBe("remote.effect-pending");
      const triageOperation = String(refusalDetails(triage).operationId);

      // invariant: The move refuses on that intent, before the source row is written.
      const requestPath = source.outPath("request");
      const refused = source.runJson([...moveArgs, "--out", requestPath]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("remote.effect-pending");
      const details = refusalDetails(refused);
      expect(details).toMatchObject({ issue_ref: FIXTURE_REF, pending_intents: 1, operationId: triageOperation, state: "enqueued" });
      expect(String(details.recovery)).toContain("outbox-abandon");
      // invariant: nothing was staged: the handoff file the stage would have written does not exist.
      expect(existsSync(requestPath)).toBe(false);

      // note: Settling the outbox route is the documented recovery, and the SAME command then stages.
      const abandoned = source.runJson([
        ...REMOTE, "outbox-abandon", "--harness", source.harness,
        "--operation", triageOperation, "--reason", "superseded by the move",
      ]);
      expect(abandoned.result.stderr).toBe("");
      expect(abandoned.exitCode).toBe(0);
      expect(abandoned.data.state).toBe("abandoned");
      const staged = source.runJson([...moveArgs, "--out", requestPath]);
      expect(staged.result.stderr).toBe("");
      expect(staged.exitCode).toBe(0);
      expect(staged.data).toMatchObject({ phase: "staged", side: "source", issueRef: FIXTURE_REF });
      expect(source.readOut(requestPath)).toMatchObject({ phase: "request", issueRef: FIXTURE_REF });

      // note: the destination half still works on the row this stage wrote.
      const verified = destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect-store", "0",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", requestPath,
      ]);
      expect(verified.result.stderr).toBe("");
      expect(verified.exitCode).toBe(0);
      expect(verified.data).toMatchObject({ phase: "verified", side: "destination" });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a remote to remote move still refuses collaboration.mode-unavailable", () => {
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

  test("an admission that arrives before the source switched is refused, leaving the provider record and the move intact", () => {
    const fixture = host("early-admission");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const destination = localHost(fixture);
      const moveArgs = [
        "issue", "move",
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
      ];

      const requestPath = source.outPath("request");
      expect(source.runJson([...moveArgs, "--id", FIXTURE_REF, "--out", requestPath]).data).toMatchObject({ phase: "staged" });
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
      expect(verified.data).toMatchObject({ phase: "verified", side: "destination" });

      // note: A document relabelled `admission` — the shape a mis-sequenced or forged handoff has —
      // reaches the source while ITS row is still `staged`. Publishing on it would mark the move done
      // with the provider record still live beside the admitted copy.
      const forged = source.writeJson("forged-admission", {
        ...destination.readOut(stagedPath),
        phase: "admission",
        destinationIssueId: "66666666-6666-4666-8666-666666666666",
      });
      const refused = source.runJson([...moveArgs, "--id", FIXTURE_REF, "--input", forged]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("collaboration.move-phase-invalid");

      // invariant: Nothing was published and nothing was tombstoned: the honest next step still runs,
      // freezing the obsolete replacement and answering it as pending.
      const staged = destination.readOut(stagedPath);
      const tombstone = source.runJson([...moveArgs, "--id", FIXTURE_REF, "--input", source.writeJson("staged", staged)]);
      expect(tombstone.exitCode).toBe(1);
      expect(tombstone.code).toBe("remote.effect-pending");
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("an admission naming no admitted record is refused, and the local source record survives", () => {
    const fixture = host("unadmitted-admission");
    try {
      fixture.publish(1);
      const destination = remoteHost(fixture, "remote-destination");
      const source = localHost(fixture, "local-source");
      const remoteKey = fixture.repoKey;
      const seeded = source.runJson([
        "issue", "add",
        "--payload", JSON.stringify({
          projectId: "_default",
          title: "Local record facing a forged admission",
          kind: "bug",
          severity: "high",
          impact: "A fabricated admission must never delete the source record.",
          acceptance: "The record is still readable in its own authority.",
          sourceIdentity: "review/forged-admission",
          rootCauseKey: "forged.admission.root",
          acceptanceKey: "forged.admission.accept",
          occurrenceKey: "occ-forged-admission",
          sourceKind: "test",
          location: "packages/cli/test/cross-authority-move-remote.test.ts",
          observedBehavior: "A forged admission arrived early.",
          evidence: ["controlled host fixture"],
          discoveredAt: AT,
        }),
        "--actor", "project-manager",
        "--operation-id", "55555555-5555-4555-8555-555555555555",
      ]);
      expect(seeded.exitCode).toBe(0);
      const localId = String(seeded.data.issueId);
      const localRef = String(source.runJson(["issue", "show", "--id", localId, "--harness", source.harness]).data.issueRef);
      const storeRevision = String(source.runJson(["issue", "list", "--harness", source.harness]).data.storeRevision);
      const moveArgs = [
        "issue", "move",
        "--id", localId,
        "--to-authority", remoteKey,
        "--payload", JSON.stringify({ projectId: REMOTE_PROJECT.localProjectId, reason: "cross to the provider" }),
        "--expect", "1",
        "--expect-store", storeRevision,
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
      ];

      const requestPath = source.outPath("request");
      expect(source.runJson([...moveArgs, "--out", requestPath]).data).toMatchObject({ phase: "staged" });

      // note: The forged document is the `request` document relabelled `admission`: it matches the frozen
      // digest and counts exactly, so only the missing admitted record distinguishes it from a real one.
      const forged = source.writeJson("forged-admission", { ...source.readOut(requestPath), phase: "admission" });
      const refused = source.runJson([...moveArgs, "--input", forged]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("collaboration.move-phase-invalid");

      // invariant: The source record was never removed: it is still readable here, at its own revision.
      const shown = source.runJson(["issue", "show", "--id", localId, "--harness", source.harness]);
      expect(shown.exitCode).toBe(0);
      expect(shown.data).toMatchObject({ id: localId, issueRef: localRef, revision: 1 });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a replay under the same operation id without a handoff is bound to the request it recorded", () => {
    const fixture = host("unbound-replay");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const first = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", source.outPath("request"),
      ]);
      expect(first.exitCode).toBe(0);

      // invariant: The same operation id with another record is a different request, so it refuses —
      // exactly as the handoff-carrying form does — instead of answering the first request's document.
      const unbound = source.runJson([
        "issue", "move",
        "--id", "mstar:issue:ffffffff-ffff-4fff-8fff-ffffffffffff",
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", source.outPath("second-request"),
      ]);
      expect(unbound.exitCode).toBe(1);
      expect(unbound.code).toBe("store.operation-conflict");
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
        sourceStoreId: "store-one",
        sourceEpoch: 1,
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

  test("an admission that carries no confirmed create never deletes the local source record", () => {
    // invariant: The local source publishes — and DELETES its only copy — on the destination's
    // admission. A handoff that merely names a provider issue id is not evidence that a member exists,
    // so it publishes nothing: before this gate any relabelled request with an id did.
    const fixture = host("forged-confirmation");
    try {
      fixture.publish(1);
      const destination = remoteHost(fixture, "remote-destination");
      const source = localHost(fixture, "local-source");
      const remoteKey = fixture.repoKey;
      const seeded = source.runJson([
        "issue", "add",
        "--payload", JSON.stringify({
          projectId: "_default",
          title: "Local record facing a fabricated confirmation",
          kind: "bug",
          severity: "high",
          impact: "A handoff naming no confirmed create must never delete the source record.",
          acceptance: "The record is still readable in its own authority.",
          sourceIdentity: "review/forged-confirmation",
          rootCauseKey: "forged.confirmation.root",
          acceptanceKey: "forged.confirmation.accept",
          occurrenceKey: "occ-forged-confirmation",
          sourceKind: "test",
          location: "packages/cli/test/cross-authority-move-remote.test.ts",
          observedBehavior: "A fabricated admission arrived.",
          evidence: ["controlled host fixture"],
          discoveredAt: AT,
        }),
        "--actor", "project-manager",
        "--operation-id", "55555555-5555-4555-8555-555555555556",
      ]);
      expect(seeded.result.stderr).toBe("");
      const localId = String(seeded.data.issueId);
      const storeRevision = String(source.runJson(["issue", "list", "--harness", source.harness]).data.storeRevision);
      const moveArgs = [
        "issue", "move",
        "--id", localId,
        "--to-authority", remoteKey,
        "--payload", JSON.stringify({ projectId: REMOTE_PROJECT.localProjectId, reason: "cross to the provider" }),
        "--expect", "1",
        "--expect-store", storeRevision,
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
      ];
      const requestPath = source.outPath("request");
      expect(source.runJson([...moveArgs, "--out", requestPath]).data).toMatchObject({ phase: "staged" });

      // note: The frozen request document relabelled `admission`, carrying an invented provider id and
      // no confirmed create: the exact shape a hand-edited handoff has.
      const forged = source.writeJson("forged-confirmation", {
        ...source.readOut(requestPath),
        phase: "admission",
        destinationIssueId: "88888888-8888-4888-8888-888888888888",
      });
      const refused = source.runJson([...moveArgs, "--input", forged]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("collaboration.move-phase-invalid");

      // invariant: The source record survives at its own revision: nothing was published.
      const shown = source.runJson(["issue", "show", "--id", localId, "--harness", source.harness]);
      expect(shown.exitCode).toBe(0);
      expect(shown.data).toMatchObject({ id: localId, revision: 1 });
      expect(destination.status().exitCode).toBe(0);
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a remote source stage compares the caller's bases against the observation it froze", () => {
    // invariant: The remote source stages a subject it OBSERVED, so `--expect` and `--expect-store`
    // name that sample; a stage that accepted any value staged bytes the caller's CAS never described.
    const fixture = host("remote-source-base");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const moveArgs = [
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
      ];
      const staleRevision = source.runJson([
        ...moveArgs, "--expect", "9", "--expect-store", "1", "--out", source.outPath("stale-revision"),
      ]);
      expect(staleRevision.exitCode).toBe(1);
      expect(staleRevision.code).toBe("issue.revision-conflict");
      const staleStore = source.runJson([
        ...moveArgs, "--expect", "2", "--expect-store", "9", "--out", source.outPath("stale-store"),
      ]);
      expect(staleStore.exitCode).toBe(1);
      expect(staleStore.code).toBe("milestone.revision-conflict");
      // invariant: a refused base stages nothing, so no handoff exists afterwards.
      expect(existsSync(source.outPath("stale-store"))).toBe(false);

      const staged = source.runJson([...moveArgs, "--expect", "2", "--expect-store", "1", "--out", source.outPath("request")]);
      expect(staged.result.stderr).toBe("");
      expect(staged.exitCode).toBe(0);
      expect(staged.data).toMatchObject({ phase: "staged", side: "source" });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a destination that already holds the finding identity refuses before the source can tombstone", () => {
    // invariant: The destination proves its identity and reference occupancy BEFORE it emits `staged`:
    // the remote source tombstones its provider record on that document, so a collision refused only at
    // admission would leave the record on neither authority.
    const fixture = host("destination-collision");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const destination = localHost(fixture);
      // note: The marked record's first occurrence is the SAME identity triple, in the destination
      // project, so admitting it here would give one identity two records.
      const seeded = destination.runJson([
        "issue", "add",
        "--payload", JSON.stringify({
          projectId: "_default",
          title: "Already admitted here",
          kind: "bug",
          severity: "low",
          impact: "i",
          acceptance: "a",
          sourceIdentity: "review/move",
          rootCauseKey: "move.root",
          acceptanceKey: "move.accept",
          occurrenceKey: "occ-collision",
          sourceKind: "test",
          location: "packages/cli/test/cross-authority-move-remote.test.ts",
          observedBehavior: "the finding is already here",
          evidence: [],
          discoveredAt: AT,
        }),
        "--actor", "project-manager",
        "--operation-id", "66666666-6666-4666-8666-666666666662",
      ]);
      expect(seeded.result.stderr).toBe("");
      expect(seeded.exitCode).toBe(0);
      // note: the seeded record advanced this lane's revision, so the destination's own base is what a
      // caller reads here; a stale one would refuse the CAS before the collision is ever reached.
      const destinationStoreRevision = String(
        destination.runJson(["issue", "list", "--harness", destination.harness]).data.storeRevision,
      );

      const requestPath = source.outPath("request");
      expect(source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", requestPath,
      ]).data).toMatchObject({ phase: "staged" });

      const stagedPath = destination.outPath("staged");
      const refused = destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", JSON.stringify({ projectId: "_default", reason: "leave the provider project" }),
        "--expect-store", destinationStoreRevision,
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", requestPath,
        "--out", stagedPath,
      ]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("issue.ambiguous-identity");
      // invariant: no `staged` handoff was emitted, so the source kept its provider record live and
      // its own ledger row where it was.
      expect(existsSync(stagedPath)).toBe(false);
      const sourceLane = laneOf(fixture, source);
      try {
        expect(
          sourceLane.prepare("select phase from issue_moves where operation_id = ? and role = 'source'").get(MOVE_OPERATION),
        ).toEqual({ phase: "staged" });
      } finally {
        sourceLane.close();
      }
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a staged two-checkout exchange is released by a discard on each side", () => {
    // invariant: `--discard` opens only the lanes a checkout holds, so a staged exchange is abandoned
    // one side at a time — before the source switches, when neither side holds the member.
    const fixture = host("exchange-discard");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const destination = localHost(fixture);
      const payload = JSON.stringify({ projectId: "_default", reason: "leave the provider project" });
      const requestPath = source.outPath("request");
      expect(source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", requestPath,
      ]).data).toMatchObject({ phase: "staged" });
      const stagedPath = destination.outPath("staged");
      // invariant: the destination stage accepts the record's --expect even though its own lane
      // holds no member of the source issue: the source's CAS was proved when the handoff was
      // frozen, so only the destination's own store revision is compared here.
      expect(destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect", "2",
        "--expect-store", "0",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", requestPath,
        "--out", stagedPath,
      ]).data).toMatchObject({ phase: "verified" });

      const destinationDiscard = destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect", "2",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--discard",
      ]);
      expect(destinationDiscard.result.stderr).toBe("");
      expect(destinationDiscard.exitCode).toBe(0);
      expect(destinationDiscard.data).toMatchObject({ phase: "discarded" });

      // invariant: the discard leaves a durable `discarded` row, so the saved `request` handoff
      // replayed afterwards is refused instead of staging a fresh row — the provider issue a
      // re-created staging would enqueue is exactly what the discard cancelled.
      const replayedStage = destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect-store", "0",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", requestPath,
      ]);
      expect(replayedStage.exitCode).toBe(1);
      expect(replayedStage.code).toBe("collaboration.move-phase-invalid");

      const sourceDiscard = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect", "2",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--discard",
      ]);
      expect(sourceDiscard.result.stderr).toBe("");
      expect(sourceDiscard.exitCode).toBe(0);
      expect(sourceDiscard.data).toMatchObject({ phase: "discarded" });

      // invariant: the move is over, so the original command answers a terminal receipt and hands the
      // peer no document it could stage a record from.
      const replay = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", source.outPath("after-discard"),
      ]);
      expect(replay.exitCode).toBe(0);
      expect(replay.data).toMatchObject({ phase: "discarded", document: null, out: null });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);
  test("--discard refuses the exchange's handoff flags instead of dropping them", () => {
    // invariant: `--discard` releases the row this checkout holds; it never reads or emits a
    // document, so `--input` and `--out` refuse by code before anything mutates — a discarded
    // move beside a silently dropped flag is exactly the misreport this refusal prevents.
    const fixture = host("discard-handoff-flags");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const payload = JSON.stringify({ projectId: "_default", reason: "leave the provider project" });
      const requestPath = source.outPath("request");
      expect(source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", requestPath,
      ]).data).toMatchObject({ phase: "staged" });

      const withOut = source.outPath("discarded-out");
      const refusedOut = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect", "2",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--discard",
        "--out", withOut,
      ]);
      expect(refusedOut.exitCode).toBe(1);
      expect(refusedOut.code).toBe("issue.scope-refused");
      expect(existsSync(withOut)).toBe(false);

      const refusedInput = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect", "2",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--discard",
        "--input", requestPath,
      ]);
      expect(refusedInput.exitCode).toBe(1);
      expect(refusedInput.code).toBe("issue.scope-refused");

      // invariant: both refusals mutated nothing, so the same --discard still releases the move.
      const discarded = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect", "2",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--discard",
      ]);
      expect(discarded.exitCode).toBe(0);
      expect(discarded.data).toMatchObject({ phase: "discarded" });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a confirmed tombstone is restored by the source discard, so a cancelled exchange never strands the record", () => {
    // invariant: Finding 4. `outbox-receipt` commits the tombstone before the ledger row reaches
    // `switched`, so a discard in that window owns a CLOSED provider record — and a destination that
    // may already have walked away. The discard therefore re-opens it (one `issue-replace` back to
    // the live disposition) and releases only once that restore confirms: refusing would freeze the
    // record forever, releasing silently would strand it closed.
    const fixture = host("discard-after-tombstone");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const destination = localHost(fixture);
      const payload = JSON.stringify({ projectId: "_default", reason: "leave the provider project" });
      const moveArgs = [
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect", "2",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
      ];

      const requestPath = source.outPath("request");
      expect(source.runJson([
        ...moveArgs, "--expect-store", "1", "--out", requestPath,
      ]).data).toMatchObject({ phase: "staged" });
      const stagedPath = destination.outPath("staged");
      expect(destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect-store", "0",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", requestPath,
        "--out", stagedPath,
      ]).data).toMatchObject({ phase: "verified" });

      // note: the tombstone is enqueued, dispatched and CONFIRMED before the discard is tried.
      const tombstone = source.runJson([...moveArgs, "--expect-store", "1", "--input", stagedPath]);
      expect(tombstone.exitCode).toBe(1);
      expect(tombstone.code).toBe("remote.effect-pending");
      const tombstoneDetails = refusalDetails(tombstone);
      const operation = String(tombstoneDetails.operationId);
      const dispatch = source.runJson([...REMOTE, "outbox-dispatch", "--harness", source.harness, "--operation", operation]);
      expect(dispatch.exitCode).toBe(0);
      const receipt = fixture.send(dispatch.data.permit as never);
      const recorded = source.runJson([
        ...REMOTE, "outbox-receipt", "--harness", source.harness,
        "--input", source.writeJson("receipt", receipt),
      ]);
      expect(recorded.exitCode).toBe(0);
      expect(recorded.data.state).toBe("confirmed");

      // note: every provider confirmation leaves this cache's observation stale, exactly as any other
      // provider write does; the scope is re-verified before the next write, and again before the read.
      function reobserve(): SandboxCommand {
        let last = source.observe(fixture.observe(REMOTE_PROJECT, 0));
        for (const revision of [1, 2, 3, 4, 5]) {
          last = source.observe(fixture.observe(REMOTE_PROJECT, revision));
          if (last.exitCode === 0) return last;
        }
        return last;
      }
      expect(reobserve().exitCode).toBe(0);

      // invariant: the discard owes the provider record one re-open, and reports it as pending.
      const discard = source.runJson([...moveArgs, "--discard"]);
      expect(discard.exitCode).toBe(1);
      expect(discard.code).toBe("remote.effect-pending");
      const restoreDetails = refusalDetails(discard);
      const restoreOperation = String(restoreDetails.operationId);
      const restoreDispatch = source.runJson([
        ...REMOTE, "outbox-dispatch", "--harness", source.harness, "--operation", restoreOperation,
      ]);
      expect(restoreDispatch.exitCode).toBe(0);
      const restorePermit = restoreDispatch.data.permit as unknown as {
        frozenRequest: { event: { change: { kind: string; mstar: { fields: { disposition: string } } } } };
      };
      expect(restorePermit.frozenRequest.event.change.kind).toBe("issue-replace");
      // invariant: the restore writes the LIVE disposition back, never another obsolete one.
      expect(restorePermit.frozenRequest.event.change.mstar.fields.disposition).toBe("open");
      const restoreReceipt = fixture.send(restorePermit as never);
      const restoreRecorded = source.runJson([
        ...REMOTE, "outbox-receipt", "--harness", source.harness,
        "--input", source.writeJson("restore-receipt", restoreReceipt),
      ]);
      expect(restoreRecorded.exitCode).toBe(0);
      expect(restoreRecorded.data.state).toBe("confirmed");

      expect(reobserve().exitCode).toBe(0);
      // invariant: with the record live again this half releases, and the move is terminal.
      const released = source.runJson([...moveArgs, "--discard"]);
      expect(released.result.stderr).toBe("");
      expect(released.exitCode).toBe(0);
      expect(released.data).toMatchObject({ phase: "discarded" });
      // invariant: the peer is handed no document it could stage a record from.
      const replay = source.runJson([
        ...moveArgs, "--expect-store", "1", "--out", source.outPath("after-restore"),
      ]);
      expect(replay.exitCode).toBe(0);
      expect(replay.data).toMatchObject({ phase: "discarded", document: null, out: null });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("discovery publishes the exchange handoff document the move verbs accept", () => {
    // invariant: Finding 10. `--input`/`--out` carry one strict document, so the contract discovery
    // reports must include its schema — an operator composing a handoff by hand has no other source.
    const fixture = host("move-handoff-schema");
    try {
      const sandbox = localHost(fixture);
      const described = sandbox.runJson(["schema", "--command", "issue.move"]);
      expect(described.exitCode).toBe(0);
      const descriptor = described.data.descriptor as {
        payloadSchemas: Record<string, { properties?: Record<string, { enum?: unknown[] }> }>;
      };
      const schemas = descriptor.payloadSchemas;
      expect(Object.keys(schemas)).toContain("inputDocument");
      expect(schemas.inputDocument?.properties?.route?.enum).toEqual([
        "local-local", "local-remote", "remote-local", "remote-unknown",
      ]);
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a remote move after a selector rollover reads only the admitted generation's observations", () => {
    // invariant: the observation sum a move's bases name is the admitted generation's — the rows a
    // superseded generation left behind are not this cache's evidence, so a predecessor revision
    // must not refuse a move whose bases the live view reported.
    const fixture = host("rollover-move");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const destination = localHost(fixture);
      const payload = JSON.stringify({ projectId: "_default", reason: "leave the provider project" });

      // note: a reviewed successor generation supersedes the bound one; the checkout rebinds and
      // re-observes, leaving the predecessor's observation rows in the same lane.
      fixture.publish(2);
      expect(source.bind(fixture.verify()).exitCode).toBe(0);
      expect(source.observe(fixture.observe(REMOTE_PROJECT, 0)).exitCode).toBe(0);

      const requestPath = source.outPath("request");
      const staged = source.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect", "2",
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", requestPath,
      ]);
      expect(staged.result.stderr).toBe("");
      expect(staged.exitCode).toBe(0);
      expect(staged.data).toMatchObject({ phase: "staged", side: "source" });

      const stagedPath = destination.outPath("staged");
      expect(destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect-store", "0",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", requestPath,
        "--out", stagedPath,
      ]).data).toMatchObject({ phase: "verified", side: "destination" });
      expect(generation(source)).toMatchObject({ state: "bound", generation: 2 });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a remote destination stage after a selector rollover compares the admitted generation", () => {
    // invariant: the remote destination's --expect-store names the same generation-scoped sum the
    // view serves; a sum over every retained observation row would refuse a correct base after a
    // successor selector bound.
    const fixture = host("rollover-destination");
    try {
      fixture.publish(1);
      const destination = remoteHost(fixture, "remote-destination");
      const source = localHost(fixture, "local-source");
      const remoteKey = fixture.repoKey;
      const payload = JSON.stringify({ projectId: REMOTE_PROJECT.localProjectId, reason: "cross to the provider" });

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
      expect(seeded.exitCode).toBe(0);
      const localId = String(seeded.data.issueId);
      const localRef = String(source.runJson(["issue", "show", "--id", localId, "--harness", source.harness]).data.issueRef);
      const storeRevision = String(source.runJson(["issue", "list", "--harness", source.harness]).data.storeRevision);

      const requestPath = source.outPath("request");
      expect(source.runJson([
        "issue", "move",
        "--id", localId,
        "--to-authority", remoteKey,
        "--payload", payload,
        "--expect", "1",
        "--expect-store", storeRevision,
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--out", requestPath,
      ]).data).toMatchObject({ phase: "staged" });

      // note: the rollover lands between the source's request and the destination's stage; the
      // re-observed lane keeps its predecessor's rows in the same cache.
      fixture.publish(2);
      expect(destination.bind(fixture.verify()).exitCode).toBe(0);
      expect(destination.observe(fixture.observe(REMOTE_PROJECT, 0)).exitCode).toBe(0);

      const pending = destination.runJson([
        "issue", "move",
        "--id", localRef,
        "--to-authority", remoteKey,
        "--payload", payload,
        "--expect-store", "1",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", requestPath,
      ]);
      // invariant: the stage accepted the admitted generation's base — `remote.effect-pending` is
      // the frozen create intent answering, never a revision conflict.
      expect(pending.exitCode).toBe(1);
      expect(pending.code).toBe("remote.effect-pending");
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

});
