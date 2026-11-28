import { createHash } from "node:crypto";
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
          legacyJson: JSON.stringify({ legacyId: "legacy-1", title: "Imported finding", detailDoc: "legacy-doc" }),
          importedAt: AT,
        },
      ],
      projectMoves: [],
    },
  } as const;
}

function remoteHost(fixture: RemoteCollaborationFixture, name = "remote"): RemoteSandbox {
  fixture.seedRecord(MARKED_ISSUE, markedRecord());
  fixture.setIssues([{ issueId: MARKED_ISSUE, title: "Moving finding", status: "Todo", updatedAt: AT }]);
  const sandbox = fixture.sandbox(name);
  expect(sandbox.bind(fixture.verify()).exitCode).toBe(0);
  expect(sandbox.init().exitCode).toBe(0);
  expect(sandbox.observe(fixture.observe(REMOTE_PROJECT, 0)).exitCode).toBe(0);
  return sandbox;
}

function localHost(fixture: RemoteCollaborationFixture, name = "local"): RemoteSandbox {
  const sandbox = fixture.localSandbox(name);
  expect(sandbox.init().exitCode).toBe(0);
  return sandbox;
}

function generation(sandbox: RemoteSandbox): unknown {
  return sandbox.status().data.binding;
}

function laneOf(fixture: RemoteCollaborationFixture, sandbox: RemoteSandbox): DatabaseSync {
  return new DatabaseSync(fixture.cachePath(sandbox));
}

function laneGeneration(db: DatabaseSync): { storeId: string; epoch: number } {
  const row = db.prepare("select store_id as storeId, authority_epoch as epoch from collaboration_meta where id = 1").get() as
    | { storeId?: unknown; epoch?: unknown }
    | undefined;
  if (typeof row?.storeId !== "string" || typeof row.epoch !== "number") {
    throw new Error("the sandbox lane answered no store generation");
  }
  return { storeId: row.storeId, epoch: row.epoch };
}

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
      const sourceLane = laneOf(fixture, source);
      const sourceGeneration = laneGeneration(sourceLane);
      try {
        expect(request.sourceStoreId).toBe(sourceGeneration.storeId);
        expect(request.sourceEpoch).toBe(sourceGeneration.epoch);
        expect(moveGeneration(sourceLane, MOVE_OPERATION, "source")).toEqual(sourceGeneration);
      } finally {
        sourceLane.close();
      }

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
      expect(source.readOut(switchPath)).toMatchObject({ phase: "switch", issueRef: FIXTURE_REF });

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

      const destinationLaneNow = laneOf(fixture, destination);
      try {
        expect(moveGeneration(destinationLaneNow, MOVE_OPERATION, "destination")).toEqual(sourceGeneration);
      } finally {
        destinationLaneNow.close();
      }

      const shown = destination.runJson(["issue", "show", "--id", String(admitted.data.destinationIssueId), "--harness", destination.harness]);
      expect(shown.exitCode).toBe(0);
      expect(shown.data).toMatchObject({ issueRef: FIXTURE_REF, projectId: "_default" });
      expect((shown.data.occurrences as unknown[]).length).toBe(2);
      expect((shown.data.provenance as unknown[]).length).toBe(1);
      const provenance = (shown.data.provenance as Array<Record<string, unknown>>)[0]!;
      expect(JSON.parse(String(provenance.legacyJson)) as Record<string, unknown>).toMatchObject({ legacyId: "legacy-1" });
      expect(provenance.legacyProject).toBe("legacy-project");
      expect((shown.data.projectMoves as Array<Record<string, unknown>>).at(-1)).toMatchObject({
        fromProject: REMOTE_PROJECT.localProjectId,
        toProject: "_default",
      });

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

      expect(generation(source)).toMatchObject({ state: "bound", generation: 1 });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a mismatched switch handoff discards the destination's own staged row, never the ledger as corrupt", () => {
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
      const localLane = laneOf(fixture, source);
      const localGeneration = laneGeneration(localLane);
      try {
        expect(request.sourceStoreId).toBe(localGeneration.storeId);
        expect(request.sourceEpoch).toBe(localGeneration.epoch);
        expect(moveGeneration(localLane, MOVE_OPERATION, "source")).toEqual(localGeneration);
      } finally {
        localLane.close();
      }

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
      const remoteLaneNow = laneOf(fixture, destination);
      try {
        expect(moveGeneration(remoteLaneNow, MOVE_OPERATION, "destination")).toEqual(localGeneration);
      } finally {
        remoteLaneNow.close();
      }

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

      expect(generation(destination)).toMatchObject({ state: "bound", generation: 1 });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a remote record with a live provider intent refuses to stage, and stages once the intent is abandoned", () => {
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

      const requestPath = source.outPath("request");
      const refused = source.runJson([...moveArgs, "--out", requestPath]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("remote.effect-pending");
      const details = refusalDetails(refused);
      expect(details).toMatchObject({ issue_ref: FIXTURE_REF, pending_intents: 1, operationId: triageOperation, state: "enqueued" });
      expect(String(details.recovery)).toContain("outbox-abandon");
      expect(existsSync(requestPath)).toBe(false);

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

      const forged = source.writeJson("forged-admission", {
        ...destination.readOut(stagedPath),
        phase: "admission",
        destinationIssueId: "66666666-6666-4666-8666-666666666666",
      });
      const refused = source.runJson([...moveArgs, "--id", FIXTURE_REF, "--input", forged]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("collaboration.move-phase-invalid");

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

      const forged = source.writeJson("forged-admission", { ...source.readOut(requestPath), phase: "admission" });
      const refused = source.runJson([...moveArgs, "--input", forged]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("collaboration.move-phase-invalid");

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

      const forged = source.writeJson("forged-confirmation", {
        ...source.readOut(requestPath),
        phase: "admission",
        destinationIssueId: "88888888-8888-4888-8888-888888888888",
      });
      const refused = source.runJson([...moveArgs, "--input", forged]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("collaboration.move-phase-invalid");

      const shown = source.runJson(["issue", "show", "--id", localId, "--harness", source.harness]);
      expect(shown.exitCode).toBe(0);
      expect(shown.data).toMatchObject({ id: localId, revision: 1 });
      expect(destination.status().exitCode).toBe(0);
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a remote source stage compares the caller's bases against the observation it froze", () => {
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
    const fixture = host("destination-collision");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const destination = localHost(fixture);
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

      function reobserve(): SandboxCommand {
        let last = source.observe(fixture.observe(REMOTE_PROJECT, 0));
        for (const revision of [1, 2, 3, 4, 5]) {
          last = source.observe(fixture.observe(REMOTE_PROJECT, revision));
          if (last.exitCode === 0) return last;
        }
        return last;
      }
      expect(reobserve().exitCode).toBe(0);

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
      expect(restorePermit.frozenRequest.event.change.mstar.fields.disposition).toBe("open");
      const restoreReceipt = fixture.send(restorePermit as never);
      const restoreRecorded = source.runJson([
        ...REMOTE, "outbox-receipt", "--harness", source.harness,
        "--input", source.writeJson("restore-receipt", restoreReceipt),
      ]);
      expect(restoreRecorded.exitCode).toBe(0);
      expect(restoreRecorded.data.state).toBe("confirmed");

      expect(reobserve().exitCode).toBe(0);
      const released = source.runJson([...moveArgs, "--discard"]);
      expect(released.result.stderr).toBe("");
      expect(released.exitCode).toBe(0);
      expect(released.data).toMatchObject({ phase: "discarded" });
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
    const fixture = host("rollover-move");
    try {
      fixture.publish(1);
      const source = remoteHost(fixture);
      const destination = localHost(fixture);
      const payload = JSON.stringify({ projectId: "_default", reason: "leave the provider project" });

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
      expect(pending.exitCode).toBe(1);
      expect(pending.code).toBe("remote.effect-pending");
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);
  function reobserve(source: RemoteSandbox, fixture: RemoteCollaborationFixture): SandboxCommand {
    let last = source.observe(fixture.observe(REMOTE_PROJECT, 0));
    for (const revision of [1, 2, 3, 4, 5, 6]) {
      last = source.observe(fixture.observe(REMOTE_PROJECT, revision));
      if (last.exitCode === 0) return last;
    }
    return last;
  }

  test("a restored source refuses the staged-handoff replay that would publish a duplicate", () => {
    const fixture = host("restore-then-replay");
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
      expect(source.runJson([...moveArgs, "--expect-store", "1", "--out", requestPath]).data).toMatchObject({ phase: "staged" });
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

      const tombstone = source.runJson([...moveArgs, "--expect-store", "1", "--input", stagedPath]);
      expect(tombstone.exitCode).toBe(1);
      const tombstoneOperation = String(refusalDetails(tombstone).operationId);
      const dispatch = source.runJson([...REMOTE, "outbox-dispatch", "--harness", source.harness, "--operation", tombstoneOperation]);
      expect(dispatch.exitCode).toBe(0);
      expect(source.runJson([
        ...REMOTE, "outbox-receipt", "--harness", source.harness,
        "--input", source.writeJson("receipt", fixture.send(dispatch.data.permit as never)),
      ]).data.state).toBe("confirmed");
      expect(reobserve(source, fixture).exitCode).toBe(0);
      const discard = source.runJson([...moveArgs, "--discard"]);
      expect(discard.exitCode).toBe(1);
      const restoreOperation = String(refusalDetails(discard).operationId);
      const restoreDispatch = source.runJson([...REMOTE, "outbox-dispatch", "--harness", source.harness, "--operation", restoreOperation]);
      expect(restoreDispatch.exitCode).toBe(0);
      expect(source.runJson([
        ...REMOTE, "outbox-receipt", "--harness", source.harness,
        "--input", source.writeJson("restore-receipt", fixture.send(restoreDispatch.data.permit as never)),
      ]).data.state).toBe("confirmed");
      expect(reobserve(source, fixture).exitCode).toBe(0);

      const switchPath = source.outPath("switch-after-restore");
      const replayed = source.runJson([...moveArgs, "--expect-store", "1", "--input", stagedPath, "--out", switchPath]);
      expect(replayed.exitCode).toBe(1);
      expect(replayed.code).toBe("collaboration.move-phase-invalid");
      expect(existsSync(switchPath)).toBe(false);
      const sourceLane = laneOf(fixture, source);
      try {
        expect(
          sourceLane.prepare("select phase from issue_moves where operation_id = ? and role = 'source'").get(MOVE_OPERATION),
        ).toEqual({ phase: "verified" });
      } finally {
        sourceLane.close();
      }

      expect(source.runJson([...moveArgs, "--discard"]).data).toMatchObject({ phase: "discarded" });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("an abandoned unsent restore is re-frozen by the discard instead of stranding the closed record", () => {
    const fixture = host("abandoned-restore");
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
      expect(source.runJson([...moveArgs, "--expect-store", "1", "--out", requestPath]).data).toMatchObject({ phase: "staged" });
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
      const tombstone = source.runJson([...moveArgs, "--expect-store", "1", "--input", stagedPath]);
      expect(tombstone.exitCode).toBe(1);
      const tombstoneOperation = String(refusalDetails(tombstone).operationId);
      const dispatch = source.runJson([...REMOTE, "outbox-dispatch", "--harness", source.harness, "--operation", tombstoneOperation]);
      expect(dispatch.exitCode).toBe(0);
      expect(source.runJson([
        ...REMOTE, "outbox-receipt", "--harness", source.harness,
        "--input", source.writeJson("receipt", fixture.send(dispatch.data.permit as never)),
      ]).data.state).toBe("confirmed");
      expect(reobserve(source, fixture).exitCode).toBe(0);

      const discard = source.runJson([...moveArgs, "--discard"]);
      expect(discard.exitCode).toBe(1);
      const restoreOperation = String(refusalDetails(discard).operationId);
      expect(source.runJson([
        ...REMOTE, "outbox-abandon", "--harness", source.harness,
        "--operation", restoreOperation, "--reason", "restore never sent",
      ]).data.state).toBe("abandoned");

      const reissued = source.runJson([...moveArgs, "--discard"]);
      expect(reissued.exitCode).toBe(1);
      expect(reissued.code).toBe("remote.effect-pending");
      const secondAttempt = String(refusalDetails(reissued).operationId);
      expect(secondAttempt).not.toBe(restoreOperation);

      const replayedWhileLive = source.runJson([...moveArgs, "--expect-store", "1", "--input", stagedPath]);
      expect(replayedWhileLive.exitCode).toBe(1);
      expect(replayedWhileLive.code).toBe("remote.effect-pending");
      const liveDetails = refusalDetails(replayedWhileLive);
      expect(liveDetails.operationId).toBe(secondAttempt);
      expect(String(liveDetails.recovery)).toContain("outbox-dispatch");
      expect(String(liveDetails.recovery)).toContain(secondAttempt);
      expect(String(liveDetails.recovery)).not.toContain("reviewed resolution");
      expect(String(liveDetails.recovery)).not.toContain("competing record");
      const secondDispatch = source.runJson([...REMOTE, "outbox-dispatch", "--harness", source.harness, "--operation", secondAttempt]);
      expect(secondDispatch.exitCode).toBe(0);
      expect(source.runJson([
        ...REMOTE, "outbox-receipt", "--harness", source.harness,
        "--input", source.writeJson("restore-receipt-2", fixture.send(secondDispatch.data.permit as never)),
      ]).data.state).toBe("confirmed");
      expect(reobserve(source, fixture).exitCode).toBe(0);
      expect(source.runJson([...moveArgs, "--discard"]).data).toMatchObject({ phase: "discarded" });
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);

  test("a carried copy that prepends an observation refuses admission instead of changing identity", () => {
    const fixture = host("carried-identity");
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
      expect(source.runJson([...moveArgs, "--expect-store", "1", "--out", requestPath]).data).toMatchObject({ phase: "staged" });
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
      const tombstone = source.runJson([...moveArgs, "--expect-store", "1", "--input", stagedPath]);
      expect(tombstone.exitCode).toBe(1);
      const tombstoneOperation = String(refusalDetails(tombstone).operationId);
      const dispatch = source.runJson([...REMOTE, "outbox-dispatch", "--harness", source.harness, "--operation", tombstoneOperation]);
      expect(dispatch.exitCode).toBe(0);
      expect(source.runJson([
        ...REMOTE, "outbox-receipt", "--harness", source.harness,
        "--input", source.writeJson("receipt", fixture.send(dispatch.data.permit as never)),
      ]).data.state).toBe("confirmed");
      const switchPath = source.outPath("switch");
      expect(source.runJson([...moveArgs, "--expect-store", "1", "--input", stagedPath, "--out", switchPath]).data)
        .toMatchObject({ phase: "switched" });

      const handoff = source.readOut(switchPath) as Record<string, unknown>;
      const copy = JSON.parse(String(handoff.payloadJson)) as { occurrences: Array<Record<string, unknown>> };
      copy.occurrences.unshift({
        occurrence_key: "occ-move-prepended",
        source_kind: "test",
        source_identity: "review/another",
        root_cause_key: "another.root",
        acceptance_key: "another.accept",
        location: "packages/cli/test/cross-authority-move-remote.test.ts",
        observed_behavior: "A repair-supplied earlier observation.",
        evidence_json: "[]",
        discovered_at: AT,
        recorded_at: AT,
        imported: 0,
      });
      const payloadJson = JSON.stringify(copy);
      const counts = JSON.parse(String(handoff.stagedCounts)) as Record<string, number>;
      counts.occurrences = copy.occurrences.length;
      const tampered = destination.writeJson("tampered-switch-identity", {
        ...handoff,
        payloadJson,
        payloadDigest: createHash("sha256").update(payloadJson, "utf8").digest("hex"),
        stagedCounts: JSON.stringify(counts),
      });
      const refused = destination.runJson([
        "issue", "move",
        "--id", FIXTURE_REF,
        "--to-authority", fixture.localRepoKey,
        "--payload", payload,
        "--expect-store", "0",
        "--actor", "project-manager",
        "--operation-id", MOVE_OPERATION,
        "--input", tampered,
      ]);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("collaboration.operation-partial");
      const lane = laneOf(fixture, destination);
      try {
        expect(lane.prepare("select count(*) as n from issues").get()).toEqual({ n: 0 });
        expect(
          lane.prepare("select phase from issue_moves where operation_id = ? and role = 'destination'").get(MOVE_OPERATION),
        ).toEqual({ phase: "discarded" });
      } finally {
        lane.close();
      }
    } finally {
      for (const created of fixtures.splice(0)) created.dispose();
    }
  }, 240_000);



});
