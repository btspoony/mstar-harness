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
 *   `ended_at` present AND no row carries `execution_lease` AND no
 *   `integration_merge_lease` (no dangling leases).
 * - Lease shape delegation: `validateExecutionLease` /
 *   `validateIntegrationMergeLease` unchanged (`packages/engine/src/lease.ts`).
 * - Writer: whole-rewrite under `withStatusWriteLock(snapshotPath)` — the
 *   `.status-write.lockdir` lands inside `workflows/<id>/` (dirname of the
 *   snapshot), no harness-root pollution; `WORKFLOW_SNAPSHOT_FILE = "snapshot.json"`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateResult } from "../src/core.js";
import {
  WORKFLOW_SNAPSHOT_FILE,
  readWorkflowSnapshot,
  validateWorkflowSnapshot,
  writeWorkflowSnapshot,
} from "../src/workflow.js";
import { createFsStore, setArtifactStore, type ArtifactDoc, type ArtifactStore } from "../src/store.js";

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
    integration_worktree_path: "/Users/bibi/workspace/ai/mstar-harness",
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

  test("valid active plan snapshot with a row execution_lease and no ended_at passes", () => {
    const snapshot = validSnapshot({
      type: "plan",
      status: "running",
      ended_at: undefined,
      plans: [
        legacyRow({
          status: "InProgress",
          execution_lease: {
            holder: "P1T2Implement",
            claimed_at: "2026-08-19T00:00:00Z",
            worktree_path: "/Users/bibi/workspace/ai/mstar-harness/.worktrees/00000819-workflow-engine-core",
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
    const legacy = { ...legacyOnly, control_worktree_path: "/Users/bibi/workspace/ai/mstar-harness" };
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
    const both = validSnapshot({ control_worktree_path: "/Users/bibi/workspace/ai/mstar-harness" });
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
    await writeWorkflowSnapshot(snapshot as never, dir);
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
    (legacy as Record<string, unknown>).control_worktree_path = "/Users/bibi/workspace/ai/mstar-harness";
    const raw = `${JSON.stringify(legacy, null, 2)}\n`;
    const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
    writeFileSync(snapshotPath, raw, "utf8");

    const read = readWorkflowSnapshot(dir);
    expect(read.snapshot.integration_worktree_path).toBe("/Users/bibi/workspace/ai/mstar-harness");
    expect("control_worktree_path" in read.snapshot).toBe(false);
    expect(read.diagnostics).toHaveLength(1);
    expect(read.diagnostics[0]!.code).toBe("workflow.snapshot.legacy-control-worktree-path");
    expect(read.diagnostics[0]!.severity).toBe("medium");
    // The read alias never mutates the source: byte-for-byte unchanged.
    expect(readFileSync(snapshotPath, "utf8")).toBe(raw);
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

describe("validateWorkflowSnapshot — lease shape delegation", () => {
  test("row execution_lease shape is delegated to validateExecutionLease", () => {
    const snapshot = validSnapshot({
      status: "running",
      ended_at: undefined,
      plans: [legacyRow({ status: "InProgress", execution_lease: { holder: "P1T2Implement" } })],
    });
    expectViolations(validateWorkflowSnapshot(snapshot), "lease.execution-lease.missing-claimed-at");
  });

  test("integration_merge_lease shape is delegated to validateIntegrationMergeLease", () => {
    const snapshot = validSnapshot({
      status: "running",
      ended_at: undefined,
      integration_merge_lease: { holder: "Main" },
    });
    expectViolations(validateWorkflowSnapshot(snapshot), "lease.merge-lease.missing-claimed-at");
  });
});

describe("validateWorkflowSnapshot — terminal invariants (no dangling leases, ended_at required)", () => {
  test("terminal status without ended_at is rejected", () => {
    for (const status of ["completed", "failed", "stopped"]) {
      const snapshot = validSnapshot({ status, ended_at: undefined });
      expectViolations(validateWorkflowSnapshot(snapshot), "workflow.snapshot.missing-ended-at");
    }
  });

  test("terminal status with a row execution_lease is rejected (dangling lease)", () => {
    const snapshot = validSnapshot({
      plans: [legacyRow({ status: "InProgress", execution_lease: { holder: "P1T2Implement" } })],
    });
    expectViolations(validateWorkflowSnapshot(snapshot), "workflow.snapshot.terminal-dangling-execution-lease");
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

  test("active statuses allow leases and omit ended_at", () => {
    for (const status of ["running", "paused"]) {
      const snapshot = validSnapshot({
        status,
        ended_at: undefined,
        plans: [
          legacyRow({
            status: "InProgress",
            execution_lease: {
              holder: "P1T2Implement",
              claimed_at: "2026-08-19T00:00:00Z",
              worktree_path: "/Users/bibi/workspace/ai/mstar-harness/.worktrees/00000819-workflow-engine-core",
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

describe("writeWorkflowSnapshot — whole-rewrite under withStatusWriteLock", () => {
  test("writes snapshot.json into dir (created recursively) with the exact snapshot", async () => {
    const root = tmpRoot("workflow-writer-");
    setArtifactStore(createFsStore(root));
    const dir = join(root, "workflows", "00000819-workflow-engine-core");
    const snapshot = validSnapshot();
    await writeWorkflowSnapshot(snapshot as never, dir);

    const written = JSON.parse(readFileSync(join(dir, WORKFLOW_SNAPSHOT_FILE), "utf8"));
    expect(written).toEqual(snapshot);
    // Unknown row fields survive the write verbatim.
    expect(written.plans[0].task_commits).toEqual(["242929a"]);
    expect(written.plans[0].metadata).toEqual({ findings_cleanup: "zero-residual" });
    rmSync(root, { recursive: true, force: true });
  });

  test("the .status-write.lockdir lands inside the snapshot dir, never the parent", async () => {
    const root = tmpRoot("workflow-writer-");
    setArtifactStore(createFsStore(root));
    const dir = join(root, "workflows", "00000819-workflow-engine-core");
    await writeWorkflowSnapshot(validSnapshot() as never, dir);

    // Lockdir is transient (removed on release) — the invariant is location:
    // no lockdir at the harness-root level (parent of workflows/), and none
    // left behind inside the snapshot dir after the write completes.
    expect(existsSync(join(root, ".status-write.lockdir"))).toBe(false);
    expect(existsSync(join(dir, ".status-write.lockdir"))).toBe(false);
    expect(existsSync(join(dir, WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("refuses to write an invalid snapshot and leaves no file behind", async () => {
    const root = tmpRoot("workflow-writer-");
    setArtifactStore(createFsStore(root));
    const dir = join(root, "workflows", "00000819-workflow-engine-core");
    const invalid = validSnapshot({ status: "completed", ended_at: undefined });
    await expect(writeWorkflowSnapshot(invalid as never, dir)).rejects.toThrow(/invalid workflow snapshot/);
    expect(existsSync(join(dir, WORKFLOW_SNAPSHOT_FILE))).toBe(false);
    expect(existsSync(join(root, ".status-write.lockdir"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("canonical writers reject the v1 control_worktree_path key, even through an untyped caller", async () => {
    const root = tmpRoot("workflow-writer-legacy-");
    setArtifactStore(createFsStore(root));
    const dir = join(root, "workflows", "00000819-workflow-engine-core");
    // legacy-only shape — the medium read diagnostic must never become write permission
    const legacyOnly = validSnapshot();
    delete legacyOnly.integration_worktree_path;
    await expect(
      writeWorkflowSnapshot({ ...legacyOnly, control_worktree_path: "/repo/main" } as never, dir),
    ).rejects.toThrow(/invalid workflow snapshot/);
    // both keys present — conflict refuses too
    await expect(
      writeWorkflowSnapshot({ ...validSnapshot(), control_worktree_path: "/repo/main" } as never, dir),
    ).rejects.toThrow(/invalid workflow snapshot/);
    expect(existsSync(join(dir, WORKFLOW_SNAPSHOT_FILE))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("overwrites an existing snapshot (whole-rewrite)", async () => {
    const root = tmpRoot("workflow-writer-");
    setArtifactStore(createFsStore(root));
    const dir = join(root, "workflows", "00000819-workflow-engine-core");
    mkdirSync(dir, { recursive: true });
    const first = validSnapshot({ updated_at: "2026-08-19T10:00:00Z" });
    const second = validSnapshot({ updated_at: "2026-08-19T11:00:00Z" });
    await writeWorkflowSnapshot(first as never, dir);
    await writeWorkflowSnapshot(second as never, dir);
    const written = JSON.parse(readFileSync(join(dir, WORKFLOW_SNAPSHOT_FILE), "utf8"));
    expect(written.updated_at).toBe("2026-08-19T11:00:00Z");
    expect(written).toEqual(second);
    rmSync(root, { recursive: true, force: true });
  });

  test("routes the write through the active ArtifactStore ( put({ kind: \"snapshot\", ... }))", async () => {
    const root = tmpRoot("workflow-store-");
    const dir = join(root, "workflows", "00000819-workflow-engine-core");
    const snapshot = validSnapshot();
    const puts: ArtifactDoc[] = [];
    const recording: ArtifactStore = {
      puts,
      async put(doc: ArtifactDoc): Promise<void> {
        puts.push(doc);
      },
      async get(): Promise<undefined> {
        return undefined;
      },
    };
    setArtifactStore(recording);
    try {
      await writeWorkflowSnapshot(snapshot as never, dir);
      expect(puts).toHaveLength(1);
      expect(puts[0]!.kind).toBe("snapshot");
      expect(puts[0]!.key).toBe("00000819-workflow-engine-core");
      expect(puts[0]!.payload).toEqual(snapshot);
      // The recording store performs no FS write — the durable write is the
      // store's; the writer keeps only the lock + validation duties.
      expect(existsSync(join(dir, WORKFLOW_SNAPSHOT_FILE))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("fails loud when dir lies outside the active store root ; nothing written anywhere", async () => {
    const root = tmpRoot("workflow-writer-");
    const other = tmpRoot("workflow-outside-");
    setArtifactStore(createFsStore(root));
    try {
      const dir = join(other, "workflows", "00000819-workflow-engine-core");
      const snapshot = validSnapshot();
      await expect(writeWorkflowSnapshot(snapshot as never, dir)).rejects.toThrow(/routed writer path mismatch/);
      // The guard fires before mkdir/lockdir creation — neither the caller's
      // target nor the store-resolved path receives a snapshot file.
      expect(existsSync(join(dir, WORKFLOW_SNAPSHOT_FILE))).toBe(false);
      expect(existsSync(join(root, "workflows", "00000819-workflow-engine-core", WORKFLOW_SNAPSHOT_FILE))).toBe(false);
      expect(existsSync(join(dir, ".status-write.lockdir"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});
