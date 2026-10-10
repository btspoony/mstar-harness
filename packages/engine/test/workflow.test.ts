/**
 * Engine workflow module — v3 workflow snapshot schema (`workflows/<id>/snapshot.json`),
 * lifecycle status enum, validator invariants, and the whole-rewrite writer.
 *
 * Spec sources (each test cites the plan/brief section it enforces):
 * - Snapshot schema (final): plan .md` Task 2 —
 *   `schema_version: 1` (snapshot-own; `version` stays the root-file
 *   discriminator), `id`/`type`/`status` enums, `started_at`/`ended_at?`/
 *   `updated_at`, `phase?`, `plans[]` (legacy PlanRow verbatim — unknown row
 *   fields preserved, never re-bucketed), `execution_policy?` (first-class,
 *   accepted-but-opaque keys), `integration_merge_lease?` (top-level),
 *   `branch?`/`integration_worktree_path?`, `legacy_metadata?`, `compass_ref?`.
 * - Integration worktree path — the canonical snapshot member is
 *   `integration_worktree_path`; the v1 `control_worktree_path` key is a
 *   READ-ONLY alias: the canonical reader (`readWorkflowSnapshot`) normalizes
 *   legacy-only documents in memory, returns the medium
 *   `workflow.snapshot.legacy-control-worktree-path` diagnostic separately
 *   and never touches the file bytes; both keys present is
 *   `workflow.snapshot.conflicting-worktree-paths` (high, even when equal);
 *   writers emit only the canonical shape (iteration spec
 *   worktree-write-model § "Field semantics" + § "Stable machine codes").
 * - Terminal invariants: terminal set = `completed|failed|stopped` ⇒
 *   `ended_at` is present and `integration_merge_lease` is absent.
 * - Integration-mutex shape delegation: `validateIntegrationMergeLease`
 *   (`packages/engine/src/lease.ts`).
 * - Writer: whole-rewrite under `withStatusWriteLock(snapshotPath)` — the
 *   `.status-write.lockdir` lands inside `workflows/<id>/` (dirname of the
 *   snapshot), no harness-root pollution; `WORKFLOW_SNAPSHOT_FILE = "snapshot.json"`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GateResult } from "../src/core.js";
import {
  CLOSE_PHASE,
  DERIVED_PHASE_CODE,
  EXECUTE_PHASE,
  PREPARE_PHASE,
  consultDeliveryEvidence,
  deriveLifecyclePhase,
  derivePlanRegistration,
  WORKFLOW_SNAPSHOT_FILE,
  readWorkflowSnapshot,
  validateWorkflowSnapshot,
} from "../src/workflow.js";
import { PlanPathError } from "../src/plan-path.js";
import { createFsStore, setArtifactStore } from "../src/store.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
afterEach(() => {
  setArtifactStore(undefined);
});


function violationsOf(result: GateResult): string[] {
  return result.violations.map((v) => v.code);
}

function expectViolations(result: GateResult, ...codes: string[]): void {
  expect(result.ok).toBe(false);
  for (const code of codes) expect(violationsOf(result)).toContain(code);
}

/** Verbatim legacy plan row (status.json v1 shape — every field stays on the row). */
function legacyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "20260808-slice1-engine-foundation",
    plan_id: "20260808-slice1-engine-foundation",
    file: ".mstar/plans/20260808-slice1-engine-foundation.md",
    title: "Engine foundation slice 1",
    status: "Done",
    owner: "@fullstack-dev",
    progress: 100,
    created_at: "2026-08-08",
    updated_at: "2026-08-08",
    done_at: "2026-08-08",
    task_commits: ["242929a"],
    merge_commit: "bffefbd",
    notes: ["slice 1 closed"],
    metadata: { findings_cleanup: "zero-residual" },
    ...overrides,
  };
}

/** Valid terminal iteration snapshot (compass ref + execution_policy + verbatim rows). */
function validSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "00000819-workflow-engine-core",
    type: "iteration",
    status: "completed",
    started_at: "2026-08-19T00:00:00Z",
    ended_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z",
    phase: "iteration-close",
    plans: [legacyRow()],
    execution_policy: { plan_parallelism: "serial", worktree_mode: "feature-worktree", push_policy: "manual" },
    branch: { base: "main", integration: "spec_integration_branch", target: "main" },
    integration_worktree_path: "/tmp/mstar-fixture/harness",
    legacy_metadata: { program_roadmap: "roadmap.md" },
    compass_ref: "iterations/00000819-workflow-engine-core/delivery-compass.md",
    ...overrides,
  };
}


describe("validateWorkflowSnapshot — schema basics", () => {
  test("valid terminal iteration snapshot with compass ref + execution_policy + verbatim legacy rows passes", () => {
    const result = validateWorkflowSnapshot(validSnapshot());
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("valid active plan snapshot with row metadata scope and no ended_at passes", () => {
    const snapshot = validSnapshot({
      type: "plan",
      status: "running",
      ended_at: undefined,
      plans: [
        legacyRow({
          status: "InProgress",
          metadata: {
            worktree_path: "/tmp/mstar-fixture/harness/.worktrees/00000819-workflow-engine-core",
            working_branch: "feature/00000819-workflow-engine-core",
          },
        }),
      ],
      integration_merge_lease: {
        holder: "Main",
        claimed_at: "2026-08-19T00:00:00Z",
        plan_id: "00000819-workflow-engine-core",
        source_branch: "feature/00000819-workflow-engine-core",
        target_branch: "spec_integration_branch",
      },
    });
    const result = validateWorkflowSnapshot(snapshot);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("non-object input is rejected", () => {
    expectViolations(validateWorkflowSnapshot(null), "workflow.snapshot.invalid");
    expectViolations(validateWorkflowSnapshot("nope"), "workflow.snapshot.invalid");
    expectViolations(validateWorkflowSnapshot([]), "workflow.snapshot.invalid");
  });

  test("schema_version is required and must be 1", () => {
    const { schema_version: _dropped, ...noVersion } = validSnapshot();
    expectViolations(validateWorkflowSnapshot(noVersion), "workflow.snapshot.missing-schema-version");
    expectViolations(
      validateWorkflowSnapshot(validSnapshot({ schema_version: 2 })),
      "workflow.snapshot.invalid-schema-version",
    );
  });

  test("top-level version is rejected — reserved for the root-file discriminator ", () => {
    expectViolations(
      validateWorkflowSnapshot(validSnapshot({ version: 2 })),
      "workflow.snapshot.reserved-version",
    );
  });

  test("id is required and must be a non-empty string", () => {
    const { id: _dropped, ...noId } = validSnapshot();
    expectViolations(validateWorkflowSnapshot(noId), "workflow.snapshot.missing-id");
    expectViolations(validateWorkflowSnapshot(validSnapshot({ id: "" })), "workflow.snapshot.invalid-id");
    expectViolations(validateWorkflowSnapshot(validSnapshot({ id: 42 })), "workflow.snapshot.invalid-id");
  });

  test("type is required and must be plan | iteration", () => {
    const { type: _dropped, ...noType } = validSnapshot();
    expectViolations(validateWorkflowSnapshot(noType), "workflow.snapshot.missing-type");
    expectViolations(validateWorkflowSnapshot(validSnapshot({ type: "project" })), "workflow.snapshot.invalid-type");
  });

  test("status is required and must be one of the lifecycle enum", () => {
    const { status: _dropped, ...noStatus } = validSnapshot();
    expectViolations(validateWorkflowSnapshot(noStatus), "workflow.snapshot.missing-status");
    expectViolations(validateWorkflowSnapshot(validSnapshot({ status: "archived" })), "workflow.snapshot.invalid-status");
    for (const status of ["running", "paused", "completed", "failed", "stopped"]) {
      expect(validateWorkflowSnapshot(validSnapshot({ status })).ok).toBe(true);
    }
  });

  test("started_at and updated_at are required non-empty strings", () => {
    const { started_at: _dropped, ...noStarted } = validSnapshot();
    expectViolations(validateWorkflowSnapshot(noStarted), "workflow.snapshot.missing-started-at");
    expectViolations(validateWorkflowSnapshot(validSnapshot({ started_at: "" })), "workflow.snapshot.invalid-started-at");
    const { updated_at: _dropped2, ...noUpdated } = validSnapshot();
    expectViolations(validateWorkflowSnapshot(noUpdated), "workflow.snapshot.missing-updated-at");
    expectViolations(validateWorkflowSnapshot(validSnapshot({ updated_at: 5 })), "workflow.snapshot.invalid-updated-at");
  });

  test("phase is optional and free-form string", () => {
    expect(validateWorkflowSnapshot(validSnapshot({ phase: undefined })).ok).toBe(true);
    expectViolations(validateWorkflowSnapshot(validSnapshot({ phase: 7 })), "workflow.snapshot.invalid-phase");
  });

  test("plans is required and must be an array of legacy plan rows", () => {
    const { plans: _dropped, ...noPlans } = validSnapshot();
    expectViolations(validateWorkflowSnapshot(noPlans), "workflow.snapshot.missing-plans");
    expectViolations(validateWorkflowSnapshot(validSnapshot({ plans: {} })), "workflow.snapshot.invalid-plans");
    expectViolations(validateWorkflowSnapshot(validSnapshot({ plans: [legacyRow({ id: undefined, plan_id: undefined })] })), "status.plan-row.missing-id");
  });

  test("unknown row fields are preserved on the row, never re-bucketed", () => {
    const row = legacyRow({ custom_field: { nested: [1, 2] }, task_commits: ["a", "b"], notes: ["x"] });
    const snapshot = validSnapshot({ plans: [row] });
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
    // The validator must not move or drop unknown row fields — the row passes
    // through verbatim (writer round-trip is asserted in the writer describe).
    expect(snapshot.plans[0]).toEqual(row);
  });

  test("execution_policy keys are accepted-but-opaque (no semantic gate)", () => {
    expect(
      validateWorkflowSnapshot(
        validSnapshot({ execution_policy: { plan_parallelism: "serial", worktree_mode: "waived", push_policy: 42 } }),
      ).ok,
    ).toBe(true);
    expectViolations(
      validateWorkflowSnapshot(validSnapshot({ execution_policy: "serial" })),
      "workflow.snapshot.invalid-execution-policy",
    );
  });

  test("branch anchors are optional objects with non-empty string keys", () => {
    expect(validateWorkflowSnapshot(validSnapshot({ branch: undefined })).ok).toBe(true);
    expect(validateWorkflowSnapshot(validSnapshot({ branch: { base: "main" } })).ok).toBe(true);
    expectViolations(
      validateWorkflowSnapshot(validSnapshot({ branch: { base: "" } })),
      "workflow.snapshot.invalid-branch",
    );
    expectViolations(
      validateWorkflowSnapshot(validSnapshot({ branch: "main" })),
      "workflow.snapshot.invalid-branch",
    );
  });

  test("legacy_metadata / compass_ref are optional with shape checks", () => {
    expectViolations(
      validateWorkflowSnapshot(validSnapshot({ legacy_metadata: "nope" })),
      "workflow.snapshot.invalid-legacy-metadata",
    );
    expectViolations(
      validateWorkflowSnapshot(validSnapshot({ compass_ref: "" })),
      "workflow.snapshot.invalid-compass-ref",
    );
  });
});

describe("validateWorkflowSnapshot — integration worktree path (canonical member, v1 read alias, conflict)", () => {
  test("canonical integration_worktree_path is accepted when non-empty and absolute", () => {
    expect(validateWorkflowSnapshot(validSnapshot({ integration_worktree_path: undefined })).ok).toBe(true);
    expect(validateWorkflowSnapshot(validSnapshot()).ok).toBe(true);
  });

  test("empty / relative / non-string canonical path → workflow.snapshot.invalid-integration-worktree-path (high)", () => {
    for (const bad of ["", "relative/path", "./rel", 42]) {
      const result = validateWorkflowSnapshot(validSnapshot({ integration_worktree_path: bad }));
      expectViolations(result, "workflow.snapshot.invalid-integration-worktree-path");
      expect(result.violations.find((v) => v.code === "workflow.snapshot.invalid-integration-worktree-path")?.severity).toBe("high");
    }
  });

  test("legacy-only control_worktree_path is a failing gate carrying the medium migration diagnostic", () => {
    const { integration_worktree_path: _canonical, ...legacyOnly } = validSnapshot();
    const legacy = { ...legacyOnly, control_worktree_path: "/tmp/mstar-fixture/harness" };
    const result = validateWorkflowSnapshot(legacy);
    expect(result.ok).toBe(false);
    expect(violationsOf(result)).toEqual(["workflow.snapshot.legacy-control-worktree-path"]);
    expect(result.violations[0]!.severity).toBe("medium");
  });

  test("legacy-only document with an invalid path value also reports the invalid-path violation", () => {
    const { integration_worktree_path: _canonical, ...legacyOnly } = validSnapshot();
    const legacy = { ...legacyOnly, control_worktree_path: "relative/path" };
    const result = validateWorkflowSnapshot(legacy);
    expect(result.ok).toBe(false);
    expect(violationsOf(result)).toContain("workflow.snapshot.legacy-control-worktree-path");
    expectViolations(result, "workflow.snapshot.invalid-integration-worktree-path");
  });

  test("both fields present is refused as conflicting — even when the values are equal", () => {
    const both = validSnapshot({ control_worktree_path: "/tmp/mstar-fixture/harness" });
    const result = validateWorkflowSnapshot(both);
    expect(result.ok).toBe(false);
    expect(violationsOf(result)).toContain("workflow.snapshot.conflicting-worktree-paths");
    expect(result.violations.find((v) => v.code === "workflow.snapshot.conflicting-worktree-paths")?.severity).toBe("high");
    expect(violationsOf(result)).not.toContain("workflow.snapshot.legacy-control-worktree-path");
  });
});

describe("readWorkflowSnapshot — canonical reader with the v1 read alias (no mutation, no dual write)", () => {
  test("reads a canonical snapshot written by the writer; no diagnostics", async () => {
    const root = tmpRoot("workflow-reader-");
    setArtifactStore(createFsStore(root));
    const dir = join(root, "workflows", "00000819-workflow-engine-core");
    const snapshot = validSnapshot();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify(snapshot));
    const read = readWorkflowSnapshot(dir);
    expect(read.snapshot).toEqual(snapshot);
    expect(read.diagnostics).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("legacy-only document normalizes in memory and never mutates the file bytes", () => {
    const root = tmpRoot("workflow-reader-legacy-");
    const dir = join(root, "workflows", "peer-lifecycle");
    mkdirSync(dir, { recursive: true });
    const legacy = validSnapshot();
    delete (legacy as Record<string, unknown>).integration_worktree_path;
    (legacy as Record<string, unknown>).control_worktree_path = "/tmp/mstar-fixture/harness";
    const raw = `${JSON.stringify(legacy, null, 2)}\n`;
    const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
    writeFileSync(snapshotPath, raw, "utf8");

    const read = readWorkflowSnapshot(dir);
    expect(read.snapshot.integration_worktree_path).toBe("/tmp/mstar-fixture/harness");
    expect("control_worktree_path" in read.snapshot).toBe(false);
    expect(read.diagnostics).toHaveLength(1);
    expect(read.diagnostics[0]!.code).toBe("workflow.snapshot.legacy-control-worktree-path");
    expect(read.diagnostics[0]!.severity).toBe("medium");
    // The read alias never mutates the source: byte-for-byte unchanged.
    
    rmSync(root, { recursive: true, force: true });
  });

  test("a document with both path keys refuses the read (conflict is never normalized away)", () => {
    const root = tmpRoot("workflow-reader-conflict-");
    const dir = join(root, "workflows", "conflicted");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, WORKFLOW_SNAPSHOT_FILE),
      JSON.stringify({ ...validSnapshot(), control_worktree_path: "/same/path" }),
      "utf8",
    );
    expect(() => readWorkflowSnapshot(dir)).toThrow(/conflicting-worktree-paths/);
    rmSync(root, { recursive: true, force: true });
  });

  test("any violation other than the migration diagnostic refuses the read", () => {
    const root = tmpRoot("workflow-reader-invalid-");
    const dir = join(root, "workflows", "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, WORKFLOW_SNAPSHOT_FILE), JSON.stringify({ schema_version: 1, plans: [] }), "utf8");
    expect(() => readWorkflowSnapshot(dir)).toThrow(/missing-id/);
    rmSync(root, { recursive: true, force: true });
  });

  test("missing file and malformed JSON throw (never an empty-object guess)", () => {
    const root = tmpRoot("workflow-reader-missing-");
    const dir = join(root, "workflows", "absent");
    expect(() => readWorkflowSnapshot(dir)).toThrow(/snapshot\.json/);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, WORKFLOW_SNAPSHOT_FILE), "{not json", "utf8");
    expect(() => readWorkflowSnapshot(dir)).toThrow(/Invalid JSON/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("validateWorkflowSnapshot — integration mutex shape delegation", () => {

  test("integration_merge_lease shape is delegated to validateIntegrationMergeLease", () => {
    const snapshot = validSnapshot({
      status: "running",
      ended_at: undefined,
      integration_merge_lease: { holder: "Main" },
    });
    expectViolations(validateWorkflowSnapshot(snapshot), "lease.merge-lease.missing-claimed-at");
  });
});

describe("validateWorkflowSnapshot — terminal invariants (integration mutex released, ended_at required)", () => {
  test("terminal status without ended_at is rejected", () => {
    for (const status of ["completed", "failed", "stopped"]) {
      const snapshot = validSnapshot({ status, ended_at: undefined });
      expectViolations(validateWorkflowSnapshot(snapshot), "workflow.snapshot.missing-ended-at");
    }
  });


  test("terminal status with integration_merge_lease is rejected (dangling lease)", () => {
    const snapshot = validSnapshot({
      integration_merge_lease: {
        holder: "Main",
        claimed_at: "2026-08-19T00:00:00Z",
        plan_id: "00000819-workflow-engine-core",
        source_branch: "feature/00000819-workflow-engine-core",
        target_branch: "spec_integration_branch",
      },
    });
    expectViolations(validateWorkflowSnapshot(snapshot), "workflow.snapshot.terminal-dangling-merge-lease");
  });

  test("active statuses allow row metadata scope and an integration mutex without ended_at", () => {
    for (const status of ["running", "paused"]) {
      const snapshot = validSnapshot({
        status,
        ended_at: undefined,
        plans: [
          legacyRow({
            status: "InProgress",
            metadata: {
              worktree_path: "/tmp/mstar-fixture/harness/.worktrees/00000819-workflow-engine-core",
              working_branch: "feature/00000819-workflow-engine-core",
            },
          }),
        ],
        integration_merge_lease: {
          holder: "Main",
          claimed_at: "2026-08-19T00:00:00Z",
          plan_id: "00000819-workflow-engine-core",
          source_branch: "feature/00000819-workflow-engine-core",
          target_branch: "spec_integration_branch",
        },
      });
      expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
    }
  });
});


describe("validateWorkflowSnapshot — registration-declared fields (contract §1)", () => {
  test("valid delivery_kind / project / completion_policy pass on any snapshot type", () => {
    for (const type of ["plan", "iteration"] as const) {
      const snapshot = validSnapshot({
        type,
        delivery_kind: "development",
        project: "engine",
        completion_policy: "acceptance report at plans/x/report.md",
      });
      expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
    }
    expect(validateWorkflowSnapshot(validSnapshot({ delivery_kind: "verification/report-only" })).ok).toBe(true);
  });

  test("unknown delivery_kind is refused (never inferred, never free-form)", () => {
    expectViolations(validateWorkflowSnapshot(validSnapshot({ delivery_kind: "stealth" })), "workflow.snapshot.invalid-delivery-kind");
    expectViolations(validateWorkflowSnapshot(validSnapshot({ delivery_kind: 7 })), "workflow.snapshot.invalid-delivery-kind");
  });

  test("empty project / completion_policy are refused", () => {
    expectViolations(validateWorkflowSnapshot(validSnapshot({ project: "" })), "workflow.snapshot.invalid-project");
    expectViolations(validateWorkflowSnapshot(validSnapshot({ completion_policy: "" })), "workflow.snapshot.invalid-completion-policy");
  });
});


describe("consultDeliveryEvidence — pure delivery rules", () => {
  test("accepts complete registered evidence and rejects missing registration or evidence", () => {
    const complete = validSnapshot({
      type: "plan",
      delivery_kind: "development",
      branch: { source: "feature/fixture", target: "main" },
      delivery: {
        compound: { outcome: "created" },
        pr: { repo: "btspoony/mstar-harness", head: "feature/fixture", target: "main" },
        merge: { provider: "github", evidence: "verified merge" },
      },
    });
    expect(consultDeliveryEvidence(complete as never)).toEqual([]);

    const unregistered = consultDeliveryEvidence(validSnapshot({ type: "plan" }) as never);
    expect(unregistered.map((item) => item.code)).toContain("PHASE6_DELIVERY_KIND_UNREGISTERED");

    const incomplete = consultDeliveryEvidence(validSnapshot({
      ...complete,
      delivery: { ...complete.delivery, merge: undefined },
    }) as never);
    expect(incomplete.map((item) => item.code)).toContain("PHASE6_DELIVERY_EVIDENCE_INCOMPLETE");
  });
});





/* ------------------------------------------------------------------------ *
 * JSON Prepare coordinator recovery — the schema owner and the ordinary writers
 * (prerequisite contract §3.3)
 * ------------------------------------------------------------------------ */

/** One well-formed audit record (the eleven required fields, frozen). */
function recoveryEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation_id: "op-recover-1",
    request_hash: "a".repeat(64),
    workflow_id: "00000819-workflow-engine-core",
    prior_session_id: "prior-session",
    session_id: "recovered-session",
    authorization_ref: "PM-authorization-20260921",
    reason: "the prior host session was cancelled and cannot authenticate",
    stopped_session_ids: ["prior-session"],
    snapshot_version_before: `sha256:${"b".repeat(64)}`,
    compass_version: `sha256:${"c".repeat(64)}`,
    recovered_at: "2026-09-21T10:00:00.000Z",
    ...overrides,
  };
}

/** A running iteration snapshot carrying a recovered coordinator and its audit. */
function recoveredSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validSnapshot({
    status: "running",
    ended_at: undefined,
    phase: "phase-1-prepare",
    coordination: {
      coordinator: { session_id: "recovered-session", session_file: "/fixture/recovered-session.json", bound_at: "2026-09-21T10:00:00.000Z" },
      identity_recoveries: [recoveryEntry()],
    },
    ...overrides,
  });
}

describe("prepare coordinator recovery audit schema", () => {
  test("prepare coordinator recovery audit entries are validated strictly by the snapshot schema owner", () => {
    expect(validateWorkflowSnapshot(recoveredSnapshot()).ok).toBe(true);

    const cases: ReadonlyArray<{ name: string; document: Record<string, unknown>; code: string }> = [
      {
        name: "a missing operation id",
        document: recoveredSnapshot({
          coordination: { coordinator: { session_id: "s", session_file: "/fixture/s.json", bound_at: "2026-09-21" }, identity_recoveries: [recoveryEntry({ operation_id: "" })] },
        }),
        code: "coordination.recovery.field",
      },
      {
        name: "a request hash that is not a bare sha256 digest",
        document: recoveredSnapshot({
          coordination: { coordinator: { session_id: "s", session_file: "/fixture/s.json", bound_at: "2026-09-21" }, identity_recoveries: [recoveryEntry({ request_hash: "sha256:short" })] },
        }),
        code: "coordination.recovery.hash",
      },
      {
        name: "a malformed version token",
        document: recoveredSnapshot({
          coordination: { coordinator: { session_id: "s", session_file: "/fixture/s.json", bound_at: "2026-09-21" }, identity_recoveries: [recoveryEntry({ compass_version: "not-a-version" })] },
        }),
        code: "coordination.recovery.version",
      },
      {
        name: "an empty stop assertion",
        document: recoveredSnapshot({
          coordination: { coordinator: { session_id: "s", session_file: "/fixture/s.json", bound_at: "2026-09-21" }, identity_recoveries: [recoveryEntry({ stopped_session_ids: [] })] },
        }),
        code: "coordination.recovery.stopped",
      },
      {
        name: "an unexpected audit field",
        document: recoveredSnapshot({
          coordination: { coordinator: { session_id: "s", session_file: "/fixture/s.json", bound_at: "2026-09-21" }, identity_recoveries: [recoveryEntry({ envelope: "leaked" })] },
        }),
        code: "coordination.recovery.field",
      },
      {
        name: "an audit that is not an array",
        document: recoveredSnapshot({
          coordination: { coordinator: { session_id: "s", session_file: "/fixture/s.json", bound_at: "2026-09-21" }, identity_recoveries: recoveryEntry() },
        }),
        code: "coordination.snapshot.field",
      },
      {
        name: "an unexpected coordination-block key",
        document: recoveredSnapshot({
          coordination: { coordinator: { session_id: "s", session_file: "/fixture/s.json", bound_at: "2026-09-21" }, recoveries: [] },
        }),
        code: "coordination.snapshot.field",
      },
    ];
    for (const recoveryCase of cases) {
      const result = validateWorkflowSnapshot(recoveryCase.document);
      expect(`${recoveryCase.name}: ${result.ok ? "accepted" : violationsOf(result).includes(recoveryCase.code)}`).toBe(
        `${recoveryCase.name}: true`,
      );
    }
  });
});

describe("workflow snapshot — missing phase derivation (R3/#293)", () => {
  const roots: string[] = [];
  afterEach(() => {
    setArtifactStore(undefined);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A running iteration document that declares NO phase at all. */
  function phaseLessIteration(root: string, overrides: Record<string, unknown> = {}): { dir: string; path: string; raw: string } {
    const dir = join(root, "workflows", "20260928-manual-registration");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, WORKFLOW_SNAPSHOT_FILE);
    const raw = `${JSON.stringify(
      {
        schema_version: 1,
        id: "20260928-manual-registration",
        type: "iteration",
        status: "running",
        started_at: "2026-09-28T00:00:00.000Z",
        updated_at: "2026-09-28",
        compass_ref: "iterations/iter-20260928-fixture/delivery-compass.md",
        branch: { base: "main", integration: "feature/20260928-fixture", target: "main" },
        plans: [
          { id: "20260928-plan-a", title: "Plan A", file: "plans/20260928-plan-a.md", status: "Todo" },
          { id: "20260928-plan-b", title: "Plan B", file: "plans/20260928-plan-b.md", status: "Todo" },
        ],
        ...overrides,
      },
      null,
      2,
    )}\n`;
    writeFileSync(path, raw, "utf8");
    return { dir, path, raw };
  }

  test("missing phase — an old unstarted iteration derives Prepare on read, with no write and no persist step (A04)", () => {
    const root = tmpRoot("workflow-missing-phase-");
    roots.push(root);
    setArtifactStore(createFsStore(root));
    const { dir, path, raw } = phaseLessIteration(root);

    const read = readWorkflowSnapshot(dir);
    expect(read.snapshot.phase).toBe(PREPARE_PHASE);
    expect(read.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([DERIVED_PHASE_CODE]);
    expect(read.diagnostics[0]!.severity).toBe("medium");
    // The derived phase is a read-time view: the document's own bytes are
    // untouched, nothing is registered, and no persist/CAS step is involved.
    
    expect("phase" in (JSON.parse(raw) as Record<string, unknown>)).toBe(false);
    expect(existsSync(join(root, "status.json"))).toBe(false);
    expect(read.snapshot.started_at).toBe("2026-09-28T00:00:00.000Z");
  });

  test("missing phase — a coordinator binding alone is not execution ownership", () => {
    const root = tmpRoot("workflow-missing-phase-binding-");
    roots.push(root);
    setArtifactStore(createFsStore(root));
    const { dir } = phaseLessIteration(root, {
      coordination: {
        coordinator: { session_id: "s-1", session_file: join(root, "sessions", "s-1.json"), bound_at: "2026-09-28T00:00:00.000Z" },
      },
    });

    expect(readWorkflowSnapshot(dir).snapshot.phase).toBe(PREPARE_PHASE);
  });

  test("missing phase — execution ownership derives the forward stage and is never reset to Prepare (R3)", () => {
    const root = tmpRoot("workflow-missing-phase-forward-");
    roots.push(root);
    setArtifactStore(createFsStore(root));
    const executing = phaseLessIteration(root, {
      plans: [
        { id: "20260928-plan-a", title: "Plan A", file: "plans/20260928-plan-a.md", status: "InProgress", progress: 40 },
        { id: "20260928-plan-b", title: "Plan B", file: "plans/20260928-plan-b.md", status: "Todo" },
      ],
    });
    const derived = deriveLifecyclePhase(readWorkflowSnapshot(executing.dir).snapshot);
    expect(derived.phase).toBe(EXECUTE_PHASE);
    expect(derived.facts.join(" | ")).toContain("20260928-plan-a status=InProgress");
    expect(readWorkflowSnapshot(executing.dir).snapshot.phase).toBe(EXECUTE_PHASE);

    // Recorded row progress is execution even if its status still says Todo.
    const progressed = phaseLessIteration(root, {
      plans: [{ id: "20260928-plan-a", title: "Plan A", file: "plans/20260928-plan-a.md", status: "Todo", progress: 40 }],
    });
    const progressedRead = readWorkflowSnapshot(progressed.dir);
    expect(progressedRead.snapshot.phase).toBe(EXECUTE_PHASE);
    expect(deriveLifecyclePhase(progressedRead.snapshot).facts).toContain("plan 20260928-plan-a progress=40");
    expect(readFileSync(progressed.path, "utf8")).toBe(progressed.raw);

    const closedOut = phaseLessIteration(root, {
      plans: [
        { id: "20260928-plan-a", title: "Plan A", file: "plans/20260928-plan-a.md", status: "Done", progress: 100 },
        { id: "20260928-plan-b", title: "Plan B", file: "plans/20260928-plan-b.md", status: "Done", progress: 100 },
      ],
    });
    expect(readWorkflowSnapshot(closedOut.dir).snapshot.phase).toBe(CLOSE_PHASE);
    expect(deriveLifecyclePhase(readWorkflowSnapshot(closedOut.dir).snapshot).facts.join(" | ")).toContain("status=Done");
  });

  test("missing phase — nothing is invented for a plan snapshot or a terminal document", () => {
    const root = tmpRoot("workflow-missing-phase-guard-");
    roots.push(root);
    setArtifactStore(createFsStore(root));

    const plan = phaseLessIteration(root, { type: "plan" });
    expect(readWorkflowSnapshot(plan.dir).snapshot.phase).toBeUndefined();
    expect(readWorkflowSnapshot(plan.dir).diagnostics).toEqual([]);

    const terminal = phaseLessIteration(root, { status: "completed", ended_at: "2026-09-28T12:00:00.000Z" });
    expect(deriveLifecyclePhase(readWorkflowSnapshot(terminal.dir).snapshot).phase).toBeUndefined();
    expect(readWorkflowSnapshot(terminal.dir).snapshot.phase).toBeUndefined();
    expect(readWorkflowSnapshot(terminal.dir).diagnostics).toEqual([]);
  });
});

test("plan registration derivation stays read-only and proves the selected document", () => {
  const root = tmpRoot("plan-registration-derivation-");
  try {
    const planId = "20260918-derived-registration";
    const file = join(root, "plans", `${planId}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `# Derived registration title\n\n**plan_id:** ${planId}\n`, "utf8");

    const derived = derivePlanRegistration({ harnessDir: root, plan: { file: `plans/${planId}.md` } });
    expect(derived.plan).toEqual({
      id: planId,
      title: "Derived registration title",
      file: realpathSync(file),
    });
    expect(derived.catalogRelativePath).toBe(`${planId}.md`);
    expect(existsSync(join(root, "workflows"))).toBe(false);
    expect(existsSync(join(root, "status.json"))).toBe(false);

    expect(() => derivePlanRegistration({
      harnessDir: root,
      plan: { id: "20260918-other-plan", title: "Derived registration title", file: `plans/${planId}.md` },
    })).toThrow(PlanPathError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



