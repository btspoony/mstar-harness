/**
 * Engine coordinator plan coordination — shared stored-shape cases.
 *
 * The FILE execution route is retired: the coordinator session envelope, the
 * scoped coordinator call path and the file-route binding frames are gone. What
 * remains here is the one stored-shape contract the ACTIVE route and the
 * migration tooling still share — the snapshot coordination block's strict
 * validator, including the coordinator recovery provenance the migration
 * importer reads.
 *
 * The coordinator's binding, ordinary plan operations and their route proofs
 * are covered by the ACTIVE route's own suites (`execution-coordination.test.ts`
 * and `execution-session.test.ts`); this file no longer drives them.
 */
import { describe, expect, test } from "bun:test";
import { validateSnapshotCoordination } from "../src/coordination-write.js";
import { WORKFLOW_ID } from "./support/coordination-fixtures.js";

describe("historical coordination snapshots", () => {
  test("accepts stored coordinator recovery provenance without requiring the original document bodies", () => {
    const result = validateSnapshotCoordination({
      coordinator: {
        session_id: "coordinator-1",
        session_file: "/tmp/coordinator.json",
        bound_at: "2026-10-03T00:00:00.000Z",
      },
      identity_recoveries: [
        {
          operation_id: "op-1",
          request_hash: "a".repeat(64),
          workflow_id: WORKFLOW_ID,
          prior_session_id: "prior",
          session_id: "coordinator-1",
          authorization_ref: "auth",
          reason: "stopped",
          stopped_session_ids: ["prior"],
          snapshot_version_before: `sha256:${"b".repeat(64)}`,
          compass_version: `sha256:${"c".repeat(64)}`,
          recovered_at: "2026-10-03T00:00:00.000Z",
        },
      ],
    });

    expect(result).toEqual([]);
  });
});
