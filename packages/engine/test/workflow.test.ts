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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GateResult } from "../src/core.js";
import {
  closeWorkflow,
  consultDeliveryEvidence,
  declareWorkflowDeliveryKind,
  isTerminalSnapshot,
  WORKFLOW_SNAPSHOT_FILE,
  readWorkflowSnapshot,
  recordWorkflowDelivery,
  registerIterationWorkflow,
  registerPlanWorkflow,
  validateWorkflowSnapshot,
  writeWorkflowSnapshot,
  type RegisterIterationWorkflowOptions,
  type RegisterPlanWorkflowOptions,
} from "../src/workflow.js";
import { evaluatePostMergeClose } from "../src/iteration.js";
import { PlanPathError } from "../src/plan-path.js";
import { artifactVersion, CoordinationError } from "../src/coordination-write.js";
import { getCatalog, listCatalog } from "../src/catalog.js";
import {
  listPendingCatalogRegistrations,
  reconcileCatalogExecution,
  registerCatalogExecution,
  resolveCatalogRegistrationState,
  type CatalogExecutionRequest,
} from "../src/catalog-registration.js";
import { createFsStore, setArtifactStore, type ArtifactDoc, type ArtifactStore } from "../src/store.js";
import { initializeStore, type StoreContext } from "../src/store-db.js";
import { validateStatus } from "../src/status.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
afterEach(() => {
  setArtifactStore(undefined);
});

/** The stable coordination error code of a refusal, or a failed assertion. */
async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CoordinationError) return error.code;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

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

/**
 * Complete registered delivery evidence for a `type: plan` snapshot
 * (contract §1/§4c/§4d/§4f): the delivery kind, the delivery anchors and the
 * three collected evidence members the close consultation requires. Spread it
 * into a plan-snapshot fixture; override single members to pin a refusal.
 */
const registeredDelivery = {
  delivery_kind: "development",
  branch: { source: "feature/fixture", target: "main" },
  delivery: {
    compound: { outcome: "created" },
    pr: { repo: "btspoony/mstar-harness", head: "feature/fixture", target: "main" },
    merge: { provider: "github", evidence: "PR #244 verified merged at 2c792c01" },
  },
};

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

  test("an existing snapshot needs the CAS token — an omitted one may only create (T1-CAS-001)", async () => {
    const root = tmpRoot("workflow-writer-");
    setArtifactStore(createFsStore(root));
    const dir = join(root, "workflows", "00000819-workflow-engine-core");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, WORKFLOW_SNAPSHOT_FILE);
    const first = validSnapshot({ updated_at: "2026-08-19T10:00:00Z" });
    const second = validSnapshot({ updated_at: "2026-08-19T11:00:00Z" });
    await writeWorkflowSnapshot(first as never, dir);
    const onDisk = readFileSync(path, "utf8");
    const version = artifactVersion(onDisk);
    // The forbidden missing-version fallback: an existing document is never
    // replaced by a caller that named no version.
    expect(await refusalCode(() => writeWorkflowSnapshot(second as never, dir))).toBe(
      "coordination.expected-version-required",
    );
    expect(readFileSync(path, "utf8")).toBe(onDisk);
    // A stale token is a conflict, not a retry.
    const stale = `sha256:${"0".repeat(64)}`;
    expect(await refusalCode(() => writeWorkflowSnapshot(second as never, dir, { expectedVersion: stale }))).toBe(
      "coordination.version-conflict",
    );
    expect(readFileSync(path, "utf8")).toBe(onDisk);
    // The exact token replaces, and only phase/updated_at may differ.
    await writeWorkflowSnapshot(second as never, dir, { expectedVersion: version });
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.updated_at).toBe("2026-08-19T11:00:00Z");
    expect(written).toEqual(second);
    rmSync(root, { recursive: true, force: true });
  });

  test("a replacement may not change anything but phase and updated_at (T1-CAS-002)", async () => {
    const root = tmpRoot("workflow-writer-fields-");
    setArtifactStore(createFsStore(root));
    const dir = join(root, "workflows", "00000819-workflow-engine-core");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, WORKFLOW_SNAPSHOT_FILE);
    const stored = validSnapshot({ updated_at: "2026-08-19T10:00:00Z" });
    await writeWorkflowSnapshot(stored as never, dir);
    const onDisk = readFileSync(path, "utf8");
    const version = artifactVersion(onDisk);
    const tampered = {
      ...stored,
      status: "completed",
      ended_at: "2026-08-19",
      started_at: "2020-01-01",
      updated_at: "2026-08-19T11:00:00Z",
    };
    expect(await refusalCode(() => writeWorkflowSnapshot(tampered as never, dir, { expectedVersion: version }))).toBe(
      "coordination.direct-write-refused",
    );
    expect(readFileSync(path, "utf8")).toBe(onDisk);
    // The widening this case pins: the pre-fix public surface let a caller
    // *name* the lifecycle scalars it was rewriting on top of
    // `phase`/`updated_at`, so this exact shape used to be honoured. The
    // option is gone from the type — the cast is the test boundary, and the
    // runtime path it opened must stay closed.
    const legacyAuthority = ["status", "ended_at", "type", "started_at"] as const;
    const widened = { ...stored, status: "running", ended_at: undefined, updated_at: "2026-08-19T11:00:00Z" };
    expect(
      await refusalCode(() =>
        writeWorkflowSnapshot(widened as never, dir, { expectedVersion: version, authority: legacyAuthority } as never),
      ),
    ).toBe("coordination.direct-write-refused");
    expect(readFileSync(path, "utf8")).toBe(onDisk);
    const projected = { ...stored, phase: "Phase 3", updated_at: "2026-08-19T11:00:00Z" };
    await writeWorkflowSnapshot(projected as never, dir, { expectedVersion: version });
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.phase).toBe("Phase 3");
    expect(written.updated_at).toBe("2026-08-19T11:00:00Z");
    expect(written.status).toBe(stored.status);
    expect(written.ended_at).toEqual(stored.ended_at);
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


describe("closeWorkflow", () => {
  const id = "00000101-close-fixture";
  const endedAt = "2026-09-12T10:20:30+08:00";
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function fixture(overrides: Record<string, unknown> = {}) {
    const root = tmpRoot("workflow-close-");
    roots.push(root);
    const dir = join(root, "workflows", id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, WORKFLOW_SNAPSHOT_FILE);
    const snapshot = validSnapshot({ id, type: "plan", status: "running", ended_at: undefined, ...registeredDelivery, ...overrides });
    writeFileSync(path, JSON.stringify(snapshot, null, 4) + "\n");
    setArtifactStore(createFsStore(root));
    return { root, dir, path, snapshot };
  }
  const lease = { holder: "fixture-owner", claimed_at: "2026-09-12", worktree_path: "/fixture/worktree", working_branch: "feature/fixture" };
  test.each(["plan", "iteration"])("completes an all-Done %s and preserves rows", async (type) => {
    const { dir, path, snapshot } = fixture({ type });
    const closed = await closeWorkflow(id, dir, { endedAt });
    expect(closed).toEqual({ ...JSON.parse(JSON.stringify(snapshot)), status: "completed", ended_at: endedAt, updated_at: endedAt });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(closed);
    expect(isTerminalSnapshot(closed)).toBe(true);
  });
  test.each(["completed", "failed", "stopped"])("keeps valid %s terminal bytes and timestamps", async (status) => {
    const { dir, path } = fixture({ status, ended_at: "2026-09-11", plans: [legacyRow({ status: "Blocked" })] });
    const before = readFileSync(path, "utf8");
    expect((await closeWorkflow(id, dir, { endedAt })).status).toBe(status);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
  test.each([
    { plans: [legacyRow({ execution_lease: lease })] },
    { integration_merge_lease: { holder: "fixture-owner", claimed_at: "2026-09-12", plan_id: "00000101-fixture", source_branch: "feature/fixture", target_branch: "integration/fixture" } },
    { plans: [legacyRow({ status: "InReview" })] },
    { id: "00000101-other" },
    { status: "completed", ended_at: undefined },
    { status: "completed", ended_at: "2026-09-11", plans: [legacyRow({ execution_lease: lease })] },
    { control_worktree_path: "/fixture/legacy" },
  ])("refuses unsafe snapshot without rewriting it: %j", async (overrides) => {
    const { dir, path } = fixture(overrides);
    const before = readFileSync(path, "utf8");
    await expect(closeWorkflow(id, dir, { endedAt })).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
  test.each(["", "yesterday", "2026-02-30", "2026-09-12T25:00:00Z", "2026-09-12T12:00:00"])("rejects invalid endedAt %s", async (value) => {
    const { dir, path } = fixture();
    const before = readFileSync(path, "utf8");
    await expect(closeWorkflow(id, dir, { endedAt: value })).rejects.toThrow(/endedAt/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
  test("date-only timestamps and legacy normalization are supported on authorized close", async () => {
    const { dir, path } = fixture({ integration_worktree_path: undefined, control_worktree_path: "/fixture/integration" });
    const closed = await closeWorkflow(id, dir, { endedAt: "2026-09-12" });
    expect(closed.integration_worktree_path).toBe("/fixture/integration");
    expect(closed.ended_at).toBe("2026-09-12");
    expect(readFileSync(path, "utf8")).not.toContain("control_worktree_path");
  });
  test.each(["missing", "malformed"])("refuses %s snapshot", async (kind) => {
    const { dir, path } = fixture();
    if (kind === "missing") rmSync(path); else writeFileSync(path, "{");
    await expect(closeWorkflow(id, dir, { endedAt })).rejects.toThrow();
    expect(existsSync(path)).toBe(kind !== "missing");
    if (kind === "malformed") expect(readFileSync(path, "utf8")).toBe("{");
  });
  test("reads a lease claimed while waiting for the snapshot lock", async () => {
    const { dir, path, snapshot } = fixture();
    const lock = join(dir, ".status-write.lockdir");
    mkdirSync(lock); // another writer holds the same filesystem lock
    const pending = closeWorkflow(id, dir, { endedAt });
    const rejection = pending.then(() => null, (error: Error) => error);
    await Bun.sleep(40);
    writeFileSync(path, JSON.stringify({ ...snapshot, plans: [legacyRow({ execution_lease: lease })] }));
    const claimed = readFileSync(path, "utf8");
    rmSync(lock, { recursive: true });
    expect(await rejection).toBeInstanceOf(Error);
    expect((await rejection)?.message).toContain("lease");
    expect(readFileSync(path, "utf8")).toBe(claimed);
  });
  test("pins the store for the locked read and write without consulting disk", async () => {
    const { dir, path, snapshot } = fixture({ status: "paused" });
    writeFileSync(path, "{invalid disk snapshot");
    const puts: ArtifactDoc[] = [];
    const recording: ArtifactStore = {
      async get<T>(ref): Promise<T> {
        expect(ref).toEqual({ kind: "snapshot", key: id });
        expect(existsSync(join(dir, ".status-write.lockdir"))).toBe(true);
        setArtifactStore({ async get() { throw new Error("wrong store"); }, async put() { throw new Error("wrong store"); } });
        return snapshot as T;
      },
      async put(doc) { expect(existsSync(join(dir, ".status-write.lockdir"))).toBe(true); puts.push(doc); },
    };
    setArtifactStore(recording);
    await closeWorkflow(id, dir, { endedAt });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toBe(id);
    expect(readFileSync(path, "utf8")).toBe("{invalid disk snapshot");
  });
  test("refuses mismatched FsStore path before creating a directory", async () => {
    const { root } = fixture();
    const dir = join(root, "elsewhere", id);
    await expect(closeWorkflow(id, dir, { endedAt })).rejects.toThrow(/routed writer path mismatch/);
    expect(existsSync(dir)).toBe(false);
  });
  test("terminal predicate checks only the enum", () => {
    expect(isTerminalSnapshot({ status: "completed" } as never)).toBe(true);
    expect(isTerminalSnapshot({ status: "running" } as never)).toBe(false);
    expect(isTerminalSnapshot({ status: "paused" } as never)).toBe(false);
  });

  // Delivery-kind evidence consultation on the WRITE path (seam S3, contract
  // §4g): the close refuses an incomplete delivery before writing anything,
  // and the read-only Phase-6 gate reaches the same verdict for the same
  // snapshot because both run `consultDeliveryEvidence`.
  test.each([
    { name: "no registered delivery kind", overrides: { delivery_kind: undefined } },
    { name: "development without the compound disposition", overrides: { delivery: { ...registeredDelivery.delivery, compound: undefined } } },
    { name: "development without the PR identity", overrides: { delivery: { ...registeredDelivery.delivery, pr: undefined } } },
    { name: "development without verified-merge evidence", overrides: { delivery: { ...registeredDelivery.delivery, merge: undefined } } },
    { name: "development without the delivery anchors", overrides: { branch: undefined } },
    {
      name: "development with a PR identity for another head",
      overrides: {
        delivery: { ...registeredDelivery.delivery, pr: { repo: "btspoony/mstar-harness", head: "feature/other", target: "main" } },
      },
    },
    {
      name: "development with a PR identity for another target",
      overrides: {
        delivery: { ...registeredDelivery.delivery, pr: { repo: "btspoony/mstar-harness", head: "feature/fixture", target: "release/9" } },
      },
    },
    { name: "verification/report-only without fulfilment", overrides: { delivery_kind: "verification/report-only", branch: undefined, completion_policy: "acceptance report", delivery: undefined } },
  ])("refuses an incomplete delivery before any write: $name", async ({ overrides }) => {
    const { dir, path } = fixture(overrides);
    const before = readFileSync(path, "utf8");
    let refusal = "";
    try {
      await closeWorkflow(id, dir, { endedAt });
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain("refusing to close workflow");
    expect(refusal).toMatch(/PHASE6_DELIVERY_KIND_UNREGISTERED|PHASE6_DELIVERY_EVIDENCE_INCOMPLETE/);
    // The refusal names the recording seam (§4c/§4d/§4f) — never an inferred fix.
    const expectedFix = refusal.includes("PHASE6_DELIVERY_KIND_UNREGISTERED") ? "owner snapshot amendment" : "mstar workflow evidence";
    expect(refusal).toContain(expectedFix);
    // Zero writes: the snapshot keeps its bytes and is still resumable.
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("running");
    // One shared consultation (never two rule sets): the close refusal and the
    // read-only Phase-6 gate republish the SAME violation for the same
    // snapshot.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const consulted = consultDeliveryEvidence(onDisk as never);
    expect(consulted.length).toBeGreaterThan(0);
    expect(refusal).toContain(consulted[0]!.code);
    const terminalGate = evaluatePostMergeClose(
      { ...onDisk, status: "completed", ended_at: "2026-09-12" },
      { version: 2, updated_at: "2026-09-12", workflows: [] },
    );
    expect(terminalGate.ok).toBe(false);
    expect(terminalGate.violations.map((v) => v.code)).toContain(consulted[0]!.code);
  });

  test("close retry after the terminal write preserves the original timestamp byte-for-byte", async () => {
    const { dir, path } = fixture();
    const closed = await closeWorkflow(id, dir, { endedAt });
    expect(closed.status).toBe("completed");
    const after = readFileSync(path, "utf8");
    const retried = await closeWorkflow(id, dir, { endedAt: "2027-01-01" });
    expect(retried.ended_at).toBe(endedAt);
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  test.each(["failed", "stopped"])(
    "an already-terminal %s snapshot is preserved and never demanded delivery evidence (gate and close agree, §5)",
    async (status) => {
      // Failure/abandonment close: no delivery kind, no anchors, no evidence.
      const { dir, path } = fixture({
        status,
        ended_at: "2026-09-11",
        delivery_kind: undefined,
        branch: undefined,
        delivery: undefined,
        plans: [legacyRow({ status: "Blocked" })],
      });
      const before = readFileSync(path, "utf8");
      const closed = await closeWorkflow(id, dir, { endedAt });
      expect(closed.status).toBe(status);
      expect(readFileSync(path, "utf8")).toBe(before);
      // The same bytes read by the read-only gate reach the same verdict: a
      // failure close is never treated as a delivery.
      const onDisk = JSON.parse(before) as Record<string, unknown>;
      const gate = evaluatePostMergeClose(onDisk, { version: 2, updated_at: "2026-09-12", workflows: [] });
      expect(gate.ok).toBe(true);
      expect(gate.violations).toEqual([]);
    },
  );
});

describe("recordWorkflowDelivery — authorized delivery-evidence recording (seam S3)", () => {
  const id = "00000102-evidence-fixture";
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function fixture(overrides: Record<string, unknown> = {}) {
    const root = tmpRoot("workflow-evidence-");
    roots.push(root);
    const dir = join(root, "workflows", id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, WORKFLOW_SNAPSHOT_FILE);
    const snapshot = validSnapshot({
      id,
      type: "plan",
      status: "running",
      ended_at: undefined,
      delivery_kind: "development",
      branch: { source: "feature/fixture", target: "main" },
      ...overrides,
    });
    writeFileSync(path, JSON.stringify(snapshot, null, 4) + "\n");
    setArtifactStore(createFsStore(root));
    return { root, dir, path, snapshot };
  }

  test("records the evidence stage by stage, merging instead of replacing", async () => {
    const { dir, path } = fixture();
    const compound = await recordWorkflowDelivery(id, dir, { evidence: { compound: { outcome: "skipped", reason: "overlapping doc updated in place" } }, at: "2026-09-12T01:00:00Z" });
    expect(compound.written).toBe(true);
    const pr = await recordWorkflowDelivery(id, dir, {
      evidence: { pr: { repo: "btspoony/mstar-harness", head: "feature/fixture", target: "main" } },
      at: "2026-09-12T02:00:00Z",
    });
    expect(pr.written).toBe(true);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(stored.delivery).toEqual({
      compound: { outcome: "skipped", reason: "overlapping doc updated in place" },
      pr: { repo: "btspoony/mstar-harness", head: "feature/fixture", target: "main" },
    });
    expect(stored.updated_at).toBe("2026-09-12T02:00:00Z");
    // The lifecycle scalars are untouched — only the delivery evidence grows.
    expect(stored.status).toBe("running");
    expect(stored.branch).toEqual({ source: "feature/fixture", target: "main" });
  });

  test("re-recording identical evidence rewrites nothing (idempotent, re-entrant)", async () => {
    const { dir, path } = fixture();
    const evidence = { merge: { provider: "github", evidence: "PR #244 verified merged at 2c792c01" } };
    await recordWorkflowDelivery(id, dir, { evidence, at: "2026-09-12T01:00:00Z" });
    const after = readFileSync(path, "utf8");
    const again = await recordWorkflowDelivery(id, dir, { evidence, at: "2026-09-13T01:00:00Z" });
    expect(again.written).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  test("the recorded PR identity is immutable except for an identical re-record (§4d)", async () => {
    const { dir, path } = fixture();
    const pr = { repo: "btspoony/mstar-harness", head: "feature/fixture", target: "main" };
    expect((await recordWorkflowDelivery(id, dir, { evidence: { pr }, at: "2026-09-12T01:00:00Z" })).written).toBe(true);
    const afterRecord = readFileSync(path, "utf8");
    // Identical re-record: idempotent, no write.
    expect((await recordWorkflowDelivery(id, dir, { evidence: { pr }, at: "2026-09-13T01:00:00Z" })).written).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(afterRecord);
    // A different identity is refused — a later payload cannot swap the PR.
    await expect(
      recordWorkflowDelivery(id, dir, { evidence: { pr: { ...pr, head: "feature/other" } } }),
    ).rejects.toThrow(/refusing to rewrite the recorded PR identity/);
    await expect(
      recordWorkflowDelivery(id, dir, { evidence: { pr: { ...pr, target: "release/9" } } }),
    ).rejects.toThrow(/refusing to rewrite the recorded PR identity/);
    expect(readFileSync(path, "utf8")).toBe(afterRecord);
  });

  test("the compound disposition and the merge record stay updatable (legitimate evolution)", async () => {
    const { dir, path } = fixture();
    await recordWorkflowDelivery(id, dir, { evidence: { compound: { outcome: "created" } }, at: "2026-09-12T01:00:00Z" });
    const corrected = await recordWorkflowDelivery(id, dir, {
      evidence: { compound: { outcome: "skipped", reason: "overlapping doc updated in place" } },
      at: "2026-09-12T02:00:00Z",
    });
    expect(corrected.written).toBe(true);
    expect(corrected.snapshot.delivery).toEqual({ compound: { outcome: "skipped", reason: "overlapping doc updated in place" } });
    const reread = await recordWorkflowDelivery(id, dir, {
      evidence: { merge: { provider: "github", evidence: "PR #244 verified merged at 2c792c01" } },
      at: "2026-09-12T03:00:00Z",
    });
    expect(reread.written).toBe(true);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(stored.delivery).toEqual({
      compound: { outcome: "skipped", reason: "overlapping doc updated in place" },
      merge: { provider: "github", evidence: "PR #244 verified merged at 2c792c01" },
    });
  });

  test("refuses delivery-tail evidence when any owned plan row is not Done (write-time gate, §3)", async () => {
    const { dir, path } = fixture({ plans: [legacyRow({ status: "Todo", done_at: undefined })] });
    const before = readFileSync(path, "utf8");
    await expect(
      recordWorkflowDelivery(id, dir, { evidence: { compound: { outcome: "created" } }, at: "2026-09-12T01:00:00Z" }),
    ).rejects.toThrow(/PHASE6_PLAN_ROW_NOT_DONE/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("records delivery-tail evidence once every owned plan row is Done", async () => {
    const { dir, path } = fixture({ plans: [legacyRow({ status: "Done" })] });
    const result = await recordWorkflowDelivery(id, dir, {
      evidence: { compound: { outcome: "created" } },
      at: "2026-09-12T01:00:00Z",
    });
    expect(result.written).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).delivery).toEqual({ compound: { outcome: "created" } });
  });

  test("grandfathering: pre-existing delivery evidence with non-Done rows is untouched and close consultation is unchanged", async () => {
    const { dir, path } = fixture({
      plans: [legacyRow({ status: "Todo", done_at: undefined })],
      delivery: registeredDelivery.delivery,
    });
    const before = readFileSync(path, "utf8");
    const again = await recordWorkflowDelivery(id, dir, { evidence: registeredDelivery.delivery, at: "2026-09-13T01:00:00Z" });
    expect(again.written).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    await expect(
      recordWorkflowDelivery(id, dir, { evidence: { compound: { outcome: "updated" } } }),
    ).rejects.toThrow(/PHASE6_PLAN_ROW_NOT_DONE/);
    expect(readFileSync(path, "utf8")).toBe(before);
    await expect(closeWorkflow(id, dir, { endedAt: "2026-09-12" })).rejects.toThrow(/every plan row must be Done/);
    const onDisk = JSON.parse(before) as Record<string, unknown>;
    const gate = evaluatePostMergeClose(
      { ...onDisk, status: "completed", ended_at: "2026-09-12" },
      { version: 2, updated_at: "2026-09-12", workflows: [] },
    );
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain("PHASE6_PLAN_ROW_NOT_DONE");
    expect(gate.violations.map((v) => v.code)).not.toContain("PHASE6_DELIVERY_EVIDENCE_INCOMPLETE");
  });

  test("recording the complete evidence makes the close succeed end to end", async () => {
    const { dir, path } = fixture({ plans: [legacyRow({ status: "Done" })] });
    // The close refuses first: evidence has not been collected yet.
    await expect(closeWorkflow(id, dir, { endedAt: "2026-09-12" })).rejects.toThrow(/PHASE6_DELIVERY_EVIDENCE_INCOMPLETE/);
    await recordWorkflowDelivery(id, dir, { evidence: registeredDelivery.delivery, at: "2026-09-12T01:00:00Z" });
    const closed = await closeWorkflow(id, dir, { endedAt: "2026-09-12" });
    expect(closed.status).toBe("completed");
    expect(closed.delivery).toEqual(registeredDelivery.delivery);
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("completed");
  });

  test.each([
    { name: "an empty patch", evidence: {} },
    { name: "a member outside the declared kind", evidence: { completion: { policy: "p", evidence: "e" } } },
    { name: "a malformed member", evidence: { compound: { outcome: "skipped" } } },
    { name: "an unknown member", evidence: { ticket: "x" } },
    { name: "an absent member value (never a silent clear)", evidence: { compound: undefined } },
  ])("refuses $name before any write", async ({ evidence }) => {
    const { dir, path } = fixture();
    const before = readFileSync(path, "utf8");
    await expect(recordWorkflowDelivery(id, dir, { evidence: evidence as never })).rejects.toThrow(/refusing to record|must name at least one/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("refuses an iteration snapshot and a terminal plan snapshot (evidence belongs to a live declared kind, §1/§5)", async () => {
    const iteration = fixture({ type: "iteration", delivery_kind: undefined });
    await expect(
      recordWorkflowDelivery(id, iteration.dir, { evidence: { pr: { repo: "r", head: "h", target: "t" } } }),
    ).rejects.toThrow(/only a type: plan lifecycle with a registered delivery_kind/);
    const root = tmpRoot("workflow-evidence-terminal-");
    roots.push(root);
    const dir = join(root, "workflows", id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, WORKFLOW_SNAPSHOT_FILE);
    writeFileSync(path, JSON.stringify({ ...iteration.snapshot, type: "plan", status: "completed", ended_at: "2026-09-12" }, null, 2));
    setArtifactStore(createFsStore(root));
    const before = readFileSync(path, "utf8");
    await expect(
      recordWorkflowDelivery(id, dir, { evidence: { pr: { repo: "r", head: "h", target: "t" } } }),
    ).rejects.toThrow(/is terminal/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a coordinated workflow is written only for its own bound coordinator envelope", async () => {
    const root = tmpRoot("workflow-evidence-coordinated-");
    roots.push(root);
    const dir = join(root, "workflows", id);
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    const sessionFile = join(sessions, "s-1.json");
    const foreign = join(sessions, "s-2.json");
    writeFileSync(sessionFile, JSON.stringify({ session_id: "s-1" }));
    writeFileSync(foreign, JSON.stringify({ session_id: "s-2" }));
    const path = join(dir, WORKFLOW_SNAPSHOT_FILE);
    const snapshot = validSnapshot({
      id,
      type: "plan",
      status: "running",
      ended_at: undefined,
      delivery_kind: "development",
      branch: { source: "feature/fixture", target: "main" },
      coordination: { coordinator: { session_id: "s-1", session_file: sessionFile, bound_at: "2026-09-15T00:00:00Z" } },
    });
    writeFileSync(path, JSON.stringify(snapshot, null, 4));
    setArtifactStore(createFsStore(root));
    const before = readFileSync(path, "utf8");
    const evidence = { compound: { outcome: "created" as const } };
    await expect(recordWorkflowDelivery(id, dir, { evidence })).rejects.toMatchObject({ code: "coordination.session-mismatch" });
    await expect(recordWorkflowDelivery(id, dir, { evidence, sessionPath: foreign })).rejects.toMatchObject({ code: "coordination.session-mismatch" });
    expect(readFileSync(path, "utf8")).toBe(before);
    const recorded = await recordWorkflowDelivery(id, dir, { evidence, sessionPath: sessionFile });
    expect(recorded.written).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).delivery).toEqual(evidence);
  });
});

describe("declareWorkflowDeliveryKind — one-time kind declaration (seam S3 population)", () => {
  const id = "00000103-declare-fixture";
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  /** An ACTIVE kind-less plan snapshot — the audit-promotion / v1-lift shape. */
  function fixture(overrides: Record<string, unknown> = {}) {
    const root = tmpRoot("workflow-declare-");
    roots.push(root);
    const dir = join(root, "workflows", id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, WORKFLOW_SNAPSHOT_FILE);
    const snapshot = validSnapshot({
      id,
      type: "plan",
      status: "running",
      ended_at: undefined,
      plans: [legacyRow({ status: "Done" })],
      ...overrides,
    });
    writeFileSync(path, JSON.stringify(snapshot, null, 4) + "\n");
    setArtifactStore(createFsStore(root));
    return { root, dir, path, snapshot };
  }

  test("declares the kind + anchors once, then the full delivery tail closes end to end (declare → record → close → gate)", async () => {
    // The audit-promotion / v1-lift shape: active, no kind, no anchors.
    const { root, dir, path } = fixture({ branch: undefined });
    // The close refuses first: no declared kind, so no consultable evidence.
    await expect(closeWorkflow(id, dir, { endedAt: "2026-09-12" })).rejects.toThrow(/PHASE6_DELIVERY_KIND_UNREGISTERED/);

    const declared = await declareWorkflowDeliveryKind(id, dir, {
      deliveryKind: "development",
      branchSource: "feature/audit-plans",
      branchTarget: "main",
      at: "2026-09-12T01:00:00Z",
    });
    expect(declared.delivery_kind).toBe("development");
    expect(declared.branch).toEqual({ source: "feature/audit-plans", target: "main" });
    expect(declared.updated_at).toBe("2026-09-12T01:00:00Z");

    // The close now consults the kind: evidence is still missing.
    await expect(closeWorkflow(id, dir, { endedAt: "2026-09-12" })).rejects.toThrow(/PHASE6_DELIVERY_EVIDENCE_INCOMPLETE/);
    await recordWorkflowDelivery(id, dir, {
      evidence: {
        compound: { outcome: "created" },
        pr: { repo: "btspoony/mstar-harness", head: "feature/audit-plans", target: "main" },
        merge: { provider: "github", evidence: "PR #244 verified merged at 2c792c01" },
      },
      at: "2026-09-12T02:00:00Z",
    });
    const closed = await closeWorkflow(id, dir, { endedAt: "2026-09-12" });
    expect(closed.status).toBe("completed");
    // The declared kind, its anchors and every recorded member agree: the
    // read-only gate passes on the closed bytes.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const gate = evaluatePostMergeClose(onDisk, { version: 2, updated_at: "2026-09-12", workflows: [] });
    expect(gate.violations).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(existsSync(join(root, "status.json"))).toBe(false);
  });

  test("the declaration is ONE-TIME: a second one is refused, even with the same kind (bytes unchanged)", async () => {
    const { dir, path } = fixture();
    await declareWorkflowDeliveryKind(id, dir, { deliveryKind: "development", branchSource: "feature/a", branchTarget: "main" });
    const after = readFileSync(path, "utf8");
    for (const second of [
      { deliveryKind: "development", branchSource: "feature/other", branchTarget: "main" },
      { deliveryKind: "verification/report-only", completionPolicy: "acceptance report" },
    ] as const) {
      await expect(declareWorkflowDeliveryKind(id, dir, second)).rejects.toThrow(/already declares/);
    }
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  test("a supplied anchor never overwrites a registered one: a conflict is refused with the field named, an identical value restates it (§1)", async () => {
    const both = fixture({ branch: { source: "feature/registered", target: "main" } });
    const before = readFileSync(both.path, "utf8");
    await expect(
      declareWorkflowDeliveryKind(id, both.dir, { deliveryKind: "development", branchSource: "feature/other", branchTarget: "main" }),
    ).rejects.toThrow(/branch\.source is already "feature\/registered"/);
    await expect(
      declareWorkflowDeliveryKind(id, both.dir, { deliveryKind: "development", branchSource: "feature/registered", branchTarget: "release" }),
    ).rejects.toThrow(/branch\.target is already "main"/);
    // A refusal writes nothing: the registered anchors stay the snapshot's.
    expect(readFileSync(both.path, "utf8")).toBe(before);

    // Identical supplied values restate the registered anchors — the
    // declaration completes over them instead of being refused.
    const declared = await declareWorkflowDeliveryKind(id, both.dir, {
      deliveryKind: "development",
      branchSource: "feature/registered",
      branchTarget: "main",
      at: "2026-09-16T03:00:00Z",
    });
    expect(declared.branch).toEqual({ source: "feature/registered", target: "main" });
    // The declaration stays ONE-TIME over the registered anchors too.
    await expect(
      declareWorkflowDeliveryKind(id, both.dir, { deliveryKind: "development", branchSource: "feature/registered", branchTarget: "main" }),
    ).rejects.toThrow(/already declares/);

    // A partially anchored snapshot keeps the registered anchor and gets the
    // missing one filled — the rule is per field, not all-or-nothing.
    const sourceOnly = fixture({ branch: { source: "feature/registered" } });
    const filled = await declareWorkflowDeliveryKind(id, sourceOnly.dir, {
      deliveryKind: "development",
      branchSource: "feature/registered",
      branchTarget: "main",
    });
    expect(filled.branch).toEqual({ source: "feature/registered", target: "main" });
  });

  test("an incomplete declaration is refused before any write (shared per-kind coherence, §1)", async () => {
    const { dir, path } = fixture();
    const before = readFileSync(path, "utf8");
    await expect(declareWorkflowDeliveryKind(id, dir, { deliveryKind: "development", branchSource: "feature/a" })).rejects.toThrow(
      /delivery source and target branches/,
    );
    await expect(declareWorkflowDeliveryKind(id, dir, { deliveryKind: "verification/report-only" })).rejects.toThrow(
      /completion policy/,
    );
    await expect(declareWorkflowDeliveryKind(id, dir, { deliveryKind: "wing-it" as never })).rejects.toThrow(/deliveryKind must be one of/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a terminal snapshot and a non-plan lifecycle are refused (the terminal dead end is never amended, §5)", async () => {
    const terminal = fixture({ status: "completed", ended_at: "2026-09-11" });
    await expect(
      declareWorkflowDeliveryKind(id, terminal.dir, { deliveryKind: "development", branchSource: "feature/a", branchTarget: "main" }),
    ).rejects.toThrow(/is terminal/);
    const iteration = fixture({ type: "iteration" });
    await expect(
      declareWorkflowDeliveryKind(id, iteration.dir, { deliveryKind: "development", branchSource: "feature/a", branchTarget: "main" }),
    ).rejects.toThrow(/only a type: plan lifecycle/);
  });

  test("a coordinated snapshot is declared only by its bound coordinator envelope", async () => {
    const root = tmpRoot("workflow-declare-coordinated-");
    roots.push(root);
    const dir = join(root, "workflows", id);
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    const sessionFile = join(sessions, "s-1.json");
    writeFileSync(sessionFile, JSON.stringify({ session_id: "s-1" }));
    const path = join(dir, WORKFLOW_SNAPSHOT_FILE);
    writeFileSync(
      path,
      JSON.stringify(
        validSnapshot({
          id,
          type: "plan",
          status: "running",
          ended_at: undefined,
          coordination: { coordinator: { session_id: "s-1", session_file: sessionFile, bound_at: "2026-09-15T00:00:00Z" } },
        }),
        null,
        2,
      ),
    );
    setArtifactStore(createFsStore(root));
    const declaration = { deliveryKind: "development", branchSource: "feature/a", branchTarget: "main" } as const;
    const before = readFileSync(path, "utf8");
    await expect(declareWorkflowDeliveryKind(id, dir, declaration)).rejects.toMatchObject({ code: "coordination.session-mismatch" });
    expect(readFileSync(path, "utf8")).toBe(before);
    const declared = await declareWorkflowDeliveryKind(id, dir, { ...declaration, sessionPath: sessionFile });
    expect(declared.delivery_kind).toBe("development");
    // The declaration ADDS the delivery anchors — the snapshot's other anchors
    // (base/integration) are preserved, never dropped.
    expect(declared.branch).toEqual({
      base: "main",
      integration: "spec_integration_branch",
      source: "feature/a",
      target: "main",
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      delivery_kind: "development",
      coordination: { coordinator: { session_id: "s-1" } },
    });
  });
});

// ---------------------------------------------------------------------------
// coordinated-writer — create-only snapshot writes (spec C4)
// ---------------------------------------------------------------------------

describe("coordinated-writer — create-only snapshot writes", () => {
  test("creates the snapshot when the target is absent", async () => {
    const root = tmpRoot("coordinated-writer-create-absent-");
    setArtifactStore(createFsStore(root));
    const dir = join(root, "workflows", "00000819-workflow-engine-core");
    try {
      await writeWorkflowSnapshot(validSnapshot(), dir, { createOnly: true });
      expect(existsSync(join(dir, WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses an existing snapshot and leaves its bytes unchanged", async () => {
    const root = tmpRoot("coordinated-writer-create-existing-");
    setArtifactStore(createFsStore(root));
    const dir = join(root, "workflows", "00000819-workflow-engine-core");
    const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
    try {
      await writeWorkflowSnapshot(validSnapshot(), dir, { createOnly: true });
      const before = readFileSync(snapshotPath, "utf8");
      await expect(writeWorkflowSnapshot(validSnapshot(), dir, { createOnly: true })).rejects.toMatchObject({
        code: "coordination.version-conflict",
      });
      expect(readFileSync(snapshotPath, "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// coordinated-writer — coordinated close authorization (spec C4)
// ---------------------------------------------------------------------------

describe("coordinated-writer — coordinated close authorization", () => {
  const id = "00000101-close-coordinated";
  const endedAt = "2026-09-12T10:20:30+08:00";
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  /** Coordinator-bound, all-rows-Done running snapshot + the matching envelope. */
  function fixture(overrides: Record<string, unknown> = {}) {
    const root = tmpRoot("workflow-close-coordinated-");
    roots.push(root);
    const dir = join(root, "workflows", id);
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    const sessionFile = join(sessions, "s-1.json");
    const otherSessionFile = join(sessions, "s-2.json");
    for (const file of [sessionFile, otherSessionFile]) {
      writeFileSync(file, JSON.stringify({ session_id: `s-${file === sessionFile ? 1 : 2}` }) + "\n");
    }
    const path = join(dir, WORKFLOW_SNAPSHOT_FILE);
    const snapshot = validSnapshot({
      id,
      type: "plan",
      status: "running",
      ended_at: undefined,
      coordination: { coordinator: { session_id: "s-1", session_file: sessionFile, bound_at: "2026-09-15T00:00:00Z" } },
      ...registeredDelivery,
      ...overrides,
    });
    writeFileSync(path, JSON.stringify(snapshot, null, 4) + "\n");
    setArtifactStore(createFsStore(root));
    return { root, dir, path, sessionFile, otherSessionFile, snapshot };
  }

  test("refuses to close a coordinated workflow with no session and leaves the bytes unchanged", async () => {
    const { dir, path, sessionFile } = fixture();
    const before = readFileSync(path, "utf8");
    await expect(closeWorkflow(id, dir, { endedAt })).rejects.toMatchObject({
      code: "coordination.session-mismatch",
      details: { path, expected: sessionFile, actual: undefined },
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("refuses to close a coordinated workflow from a foreign session and leaves the bytes unchanged", async () => {
    const { dir, path, otherSessionFile } = fixture();
    const before = readFileSync(path, "utf8");
    await expect(closeWorkflow(id, dir, { endedAt, sessionPath: otherSessionFile })).rejects.toMatchObject({
      code: "coordination.session-mismatch",
      details: { path, actual: otherSessionFile },
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("closes a coordinated workflow for its bound coordinator and preserves the binding", async () => {
    const { dir, path, sessionFile, snapshot } = fixture();
    const closed = await closeWorkflow(id, dir, { endedAt, sessionPath: sessionFile });
    expect(closed).toEqual({ ...JSON.parse(JSON.stringify(snapshot)), status: "completed", ended_at: endedAt, updated_at: endedAt });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(closed);
  });

  test("refuses a coordinated close while any plan row is not Done and leaves the bytes unchanged", async () => {
    const { dir, path, sessionFile } = fixture({ plans: [legacyRow({ status: "InProgress" })] });
    const before = readFileSync(path, "utf8");
    await expect(closeWorkflow(id, dir, { endedAt, sessionPath: sessionFile })).rejects.toThrow(/every plan row must be Done/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("returns an already-terminal coordinated snapshot unchanged without a session", async () => {
    const { dir, path } = fixture({ status: "completed", ended_at: "2026-09-11" });
    const before = readFileSync(path, "utf8");
    expect((await closeWorkflow(id, dir, { endedAt })).status).toBe("completed");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("closes an uncoordinated workflow with no session (unchanged behavior)", async () => {
    const { dir, path, snapshot } = fixture({ coordination: undefined });
    const closed = await closeWorkflow(id, dir, { endedAt, sessionPath: undefined });
    expect(closed).toEqual({ ...JSON.parse(JSON.stringify(snapshot)), status: "completed", ended_at: endedAt, updated_at: endedAt });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(closed);
  });
});

// ---------------------------------------------------------------------------
// registerPlanWorkflow — generic registration producer (seam S1, contract
// §2/§4a/§6): create-only `type: plan` snapshot + root entry under one lock,
// mirroring the audit-promotion primitive sequence; refusals never leave
// partial activation; crash/retry recovery preserves identity/timestamps.
// ---------------------------------------------------------------------------

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

describe("registerPlanWorkflow — generic registration producer (seam S1)", () => {
  const id = "20260916-plan-register-fixture";
  const roots: string[] = [];
  afterEach(() => {
    setArtifactStore(undefined);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function harness(): { root: string; statusPath: string; dir: string; snapshotPath: string } {
    const root = tmpRoot("workflow-register-");
    roots.push(root);
    setArtifactStore(createFsStore(root));
    return { root, statusPath: join(root, "status.json"), dir: join(root, "workflows", id), snapshotPath: join(root, "workflows", id, WORKFLOW_SNAPSHOT_FILE) };
  }

  function options(root: string, overrides: Partial<RegisterPlanWorkflowOptions> = {}): RegisterPlanWorkflowOptions {
    return {
      harnessDir: root,
      plan: { id: "20260916-plan-example", title: "Example plan", file: "plans/20260916-plan-example.md" },
      deliveryKind: "development",
      project: "engine",
      branchSource: "feature/20260916-plan-example",
      branchTarget: "main",
      startedAt: "2026-09-16T00:00:00.000Z",
      ...overrides,
    };
  }

  test("registers a standalone development plan: snapshot + root entry under one lock, fields recorded", async () => {
    const { root, statusPath, snapshotPath } = harness();
    const result = await registerPlanWorkflow(id, options(root));

    expect(result.recovered).toBe(false);
    expect(result.workflowId).toBe(id);
    expect(result.snapshotPath).toBe(snapshotPath);
    expect(existsSync(snapshotPath)).toBe(true);

    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      schema_version: 1,
      id,
      type: "plan",
      status: "running",
      started_at: "2026-09-16T00:00:00.000Z",
      updated_at: "2026-09-16",
      delivery_kind: "development",
      project: "engine",
    });
    // The delivery branch lands on `branch.source`; `branch.base` (the
    // protected base anchor cleanup Rule 2 / L1 consume) stays unset.
    expect(snapshot.branch).toEqual({ source: "feature/20260916-plan-example", target: "main" });
    // One owned plan row, Todo — registration does not authorize implementation.
    expect(snapshot.plans).toEqual([{ id: "20260916-plan-example", title: "Example plan", file: "plans/20260916-plan-example.md", status: "Todo" }]);

    const rootDoc = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
    expect(rootDoc.workflows).toEqual([{ id, type: "plan", started_at: "2026-09-16T00:00:00.000Z", dir: `workflows/${id}` }]);

    // Both documents validate against the harness (root+snapshot pairing).
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
    expect(validateStatus(statusPath).ok).toBe(true);
  });

  test("second register refuses without mutating bytes (create-only idempotence)", async () => {
    const { root, statusPath, snapshotPath } = harness();
    await registerPlanWorkflow(id, options(root));
    const beforeSnapshot = readFileSync(snapshotPath, "utf8");
    const beforeRoot = readFileSync(statusPath, "utf8");

    await expect(registerPlanWorkflow(id, options(root))).rejects.toThrow(/already registered/);
    expect(readFileSync(snapshotPath, "utf8")).toBe(beforeSnapshot);
    expect(readFileSync(statusPath, "utf8")).toBe(beforeRoot);
  });

  test.each([
    { name: "development without branches", overrides: { deliveryKind: "development", branchSource: undefined, branchTarget: undefined } },
    { name: "development with target only", overrides: { deliveryKind: "development", branchSource: undefined } },
    { name: "verification/report-only without completion policy", overrides: { deliveryKind: "verification/report-only", branchSource: undefined, branchTarget: undefined } },
    { name: "unknown delivery kind", overrides: { deliveryKind: "stealth" } },
    { name: "missing plan title", overrides: { plan: { id: "p", title: "", file: "plans/p.md" } } },
  ])("missing required fields refuse before any write: $name", async ({ overrides }) => {
    const { root } = harness();
    await expect(registerPlanWorkflow(id, options(root, overrides as Partial<RegisterPlanWorkflowOptions>))).rejects.toThrow(
      /registerPlanWorkflow/,
    );
    // Refusal before any write — no partial activation anywhere.
    expect(existsSync(join(root, "workflows"))).toBe(false);
    expect(existsSync(join(root, "status.json"))).toBe(false);
  });

  test("a failed register write rolls back the created snapshot so a retry converges", async () => {
    const { root, statusPath, snapshotPath } = harness();
    // Conflicting root state (same trick as the audit-promotion W-001 case):
    // a listed workflow whose snapshot is missing fails validateStatusV2 for
    // the whole document — the refusal fires only AFTER this call already
    // wrote its own snapshot, so the rollback is what prevents a partial
    // activation.
    const staleRoot = {
      version: 2,
      updated_at: "2026-09-15",
      workflows: [{ id: "other-wf", type: "plan", started_at: "2026-09-15T00:00:00.000Z", dir: "workflows/other-wf" }],
    };
    mkdirSync(root, { recursive: true });
    writeFileSync(statusPath, JSON.stringify(staleRoot, null, 2));

    await expect(registerPlanWorkflow(id, options(root))).rejects.toThrow(/invalid status\.json/);
    // Rollback: only this call's created snapshot (and its now-empty dir) are gone.
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(join(root, "workflows", id))).toBe(false);
    expect(existsSync(join(root, "workflows", "other-wf"))).toBe(false);
    // Root bytes survive the failed register.
    expect(readFileSync(statusPath, "utf8")).toBe(JSON.stringify(staleRoot, null, 2));

    // Retry after the root conflict is resolved converges end-to-end.
    writeFileSync(statusPath, JSON.stringify({ version: 2, updated_at: "2026-09-15", workflows: [] }, null, 2));
    const retry = await registerPlanWorkflow(id, options(root));
    expect(retry.recovered).toBe(false);
    expect(existsSync(snapshotPath)).toBe(true);
    expect(validateStatus(statusPath).ok).toBe(true);
  });

  test("rollback removes only the exact snapshot version this call created", async () => {
    const { root, statusPath, snapshotPath } = harness();
    // A foreign writer changes the snapshot between this call's create and
    // its rollback (injected through the store's status put): the rollback
    // must recognize the version drift and leave that snapshot alone.
    const fs = createFsStore(root);
    const corrupting: ArtifactStore = {
      root,
      async put(doc: ArtifactDoc): Promise<void> {
        if (doc.kind === "status") {
          const current = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
          writeFileSync(snapshotPath, JSON.stringify({ ...current, phase: "foreign-write" }, null, 2) + "\n");
          throw new Error("injected root write failure");
        }
        return fs.put(doc);
      },
      async get<T>(ref): Promise<T | undefined> {
        return fs.get<T>(ref);
      },
      async delete(ref): Promise<void> {
        return fs.delete(ref);
      },
    };
    setArtifactStore(corrupting);

    await expect(registerPlanWorkflow(id, options(root))).rejects.toThrow(/injected root write failure/);
    // The foreign-version snapshot survives; the dir is not force-removed.
    expect(existsSync(snapshotPath)).toBe(true);
    expect(JSON.parse(readFileSync(snapshotPath, "utf8")).phase).toBe("foreign-write");
    expect(existsSync(join(root, "workflows", id))).toBe(true);
    expect(existsSync(statusPath)).toBe(false);
  });

  test("crash between snapshot creation and registration: retry preserves identity, timestamps, ownership", async () => {
    const { root, statusPath, snapshotPath } = harness();
    // Round 1: a successful registration, then simulate the crash — the root
    // write is lost while the snapshot survived.
    const first = await registerPlanWorkflow(id, options(root, { coordinator: { session_id: "s-1", session_file: join(root, "sessions", "s-1.json") } }));
    expect(first.recovered).toBe(false);
    const orphanBytes = readFileSync(snapshotPath, "utf8");
    const orphan = JSON.parse(orphanBytes) as Record<string, unknown>;
    writeFileSync(statusPath, JSON.stringify({ version: 2, updated_at: "2026-09-01", workflows: [] }, null, 2));

    // Round 2: re-running the producer completes the registration without
    // duplicating identity — the snapshot bytes (identity, timestamps,
    // coordinator ownership) are preserved verbatim. The retry runs with a
    // fresh clock (no explicit startedAt): the orphan's timestamps must win.
    const { startedAt: _retryClock, ...retryOptions } = options(root, {
      coordinator: { session_id: "s-1", session_file: join(root, "sessions", "s-1.json") },
    });
    const retry = await registerPlanWorkflow(id, retryOptions);
    expect(retry.recovered).toBe(true);
    expect(readFileSync(snapshotPath, "utf8")).toBe(orphanBytes);

    const rootDoc = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
    expect(rootDoc.workflows).toEqual([{ id, type: "plan", started_at: orphan.started_at, dir: `workflows/${id}` }]);
    expect(validateStatus(statusPath).ok).toBe(true);
  });

  test("recovery refuses an orphan snapshot with a different registration identity", async () => {
    const { root, statusPath, snapshotPath } = harness();
    await registerPlanWorkflow(id, options(root, { deliveryKind: "development", project: "engine" }));
    const before = readFileSync(snapshotPath, "utf8");
    // The orphan belongs to a different registration (different delivery kind).
    const foreign = JSON.parse(before) as Record<string, unknown>;
    foreign.delivery_kind = "verification/report-only";
    foreign.completion_policy = "report at plans/x/report.md";
    writeFileSync(snapshotPath, JSON.stringify(foreign, null, 2));
    writeFileSync(statusPath, JSON.stringify({ version: 2, updated_at: "2026-09-01", workflows: [] }, null, 2));

    await expect(registerPlanWorkflow(id, options(root, { deliveryKind: "development", project: "engine" }))).rejects.toThrow(
      /different registration identity/,
    );
    // Neither the foreign snapshot nor the root moved.
    expect(readFileSync(snapshotPath, "utf8")).toBe(JSON.stringify(foreign, null, 2));
    expect((JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>).workflows).toEqual([]);
  });

  test("records an optional coordinator binding at registration (validated strictly)", async () => {
    const { root, statusPath, snapshotPath } = harness();
    const sessionFile = join(root, "sessions", "coordinator.json");
    await registerPlanWorkflow(id, options(root, { coordinator: { session_id: "s-9", session_file: sessionFile } }));
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    expect(snapshot.coordination).toEqual({
      coordinator: { session_id: "s-9", session_file: sessionFile, bound_at: "2026-09-16T00:00:00.000Z" },
    });
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
    expect(validateStatus(statusPath).ok).toBe(true);
  });

  test("unreadable root (malformed JSON) refuses and rolls back — no partial activation", async () => {
    const { root, statusPath, snapshotPath } = harness();
    mkdirSync(root, { recursive: true });
    writeFileSync(statusPath, "{invalid", "utf8");
    const before = readFileSync(statusPath, "utf8");

    await expect(registerPlanWorkflow(id, options(root))).rejects.toThrow(/Invalid JSON/);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(join(root, "workflows", id))).toBe(false);
    expect(readFileSync(statusPath, "utf8")).toBe(before);
  });

  test("hostile workflow id is refused by the path-component guard", async () => {
    const { root } = harness();
    await expect(registerPlanWorkflow("../escape", options(root))).rejects.toThrow(/safe path component/);
    expect(existsSync(join(root, "workflows"))).toBe(false);
    expect(existsSync(join(root, "escape"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// registerIterationWorkflow — iteration registration producer (seam S1
// sibling): create-only `type: iteration` snapshot (compass ref, three branch
// anchors, Todo rows with §1.5-derived metadata) + root entry under one lock,
// same primitive sequence as registerPlanWorkflow; stale-same-id refusal
// before BOTH branches; recovery identity includes coordinator ownership.
// ---------------------------------------------------------------------------

describe("registerIterationWorkflow — iteration registration producer", () => {
  const id = "20260918-iteration-register-fixture";
  const ROW_IDS = ["20260918-iteration-register-cli", "20260918-iteration-register-cli-2"] as const;
  const roots: string[] = [];
  afterEach(() => {
    setArtifactStore(undefined);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /**
   * Write one registered plan markdown under the default `{PLAN_DIR}` and
   * return its canonical absolute path — the pointer the §4 resolver admits and
   * the producer persists. Every fixture harness owns its own plan files: the
   * registration path resolves and reads them, so a pointer without a real
   * matching declaration is refused.
   */
  function planFile(root: string, planId: string, dir = "plans"): string {
    const file = join(root, dir, `${planId}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `# Plan ${planId}\n\n**plan_id:** ${planId}\n`);
    return realpathSync(file);
  }

  function harness(): { root: string; statusPath: string; dir: string; snapshotPath: string } {
    const root = tmpRoot("iteration-register-");
    roots.push(root);
    setArtifactStore(createFsStore(root));
    for (const planId of ROW_IDS) planFile(root, planId);
    return { root, statusPath: join(root, "status.json"), dir: join(root, "workflows", id), snapshotPath: join(root, "workflows", id, WORKFLOW_SNAPSHOT_FILE) };
  }

  function options(root: string, overrides: Partial<RegisterIterationWorkflowOptions> = {}): RegisterIterationWorkflowOptions {
    return {
      harnessDir: root,
      compassRef: "iterations/20260918-fixture/delivery-compass.md",
      branch: { base: "main", integration: "feature/20260918-iteration-fixture", target: "main" },
      rows: [
        { id: ROW_IDS[0], title: "Engine producer", file: `plans/${ROW_IDS[0]}.md` },
        { id: ROW_IDS[1], title: "CLI verb", file: `plans/${ROW_IDS[1]}.md` },
      ],
      project: "engine",
      startedAt: "2026-09-18T00:00:00.000Z",
      ...overrides,
    };
  }

  function emptyRoot(): string {
    return JSON.stringify({ version: 2, updated_at: "2026-09-01", workflows: [] }, null, 2);
  }

  test("registers an iteration: ordered Todo rows with derived metadata, anchors, compass, project — recovered false", async () => {
    const { root, statusPath, snapshotPath } = harness();
    const result = await registerIterationWorkflow(id, options(root));

    expect(result.recovered).toBe(false);
    expect(result.workflowId).toBe(id);
    expect(result.snapshotPath).toBe(snapshotPath);
    expect(existsSync(snapshotPath)).toBe(true);

    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    // RFC3339 startedAt derives a date-only updated_at.
    expect(snapshot).toMatchObject({
      schema_version: 1,
      id,
      type: "iteration",
      status: "running",
      started_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18",
      compass_ref: "iterations/20260918-fixture/delivery-compass.md",
      project: "engine",
    });
    expect(snapshot.branch).toEqual({ base: "main", integration: "feature/20260918-iteration-fixture", target: "main" });
    expect(snapshot.delivery_kind).toBeUndefined();
    // Rows keep order, are forced Todo, and carry §1.5-derived metadata.
    expect(snapshot.plans).toEqual([
      {
        id: "20260918-iteration-register-cli",
        title: "Engine producer",
        file: planFile(root, "20260918-iteration-register-cli"),
        status: "Todo",
        metadata: {
          iteration_refs: ["iterations/20260918-fixture/delivery-compass.md"],
          spec_integration_branch: "feature/20260918-iteration-fixture",
          merge_target: "feature/20260918-iteration-fixture",
        },
      },
      {
        id: "20260918-iteration-register-cli-2",
        title: "CLI verb",
        file: planFile(root, "20260918-iteration-register-cli-2"),
        status: "Todo",
        metadata: {
          iteration_refs: ["iterations/20260918-fixture/delivery-compass.md"],
          spec_integration_branch: "feature/20260918-iteration-fixture",
          merge_target: "feature/20260918-iteration-fixture",
        },
      },
    ]);

    const rootDoc = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
    expect(rootDoc.workflows).toEqual([{ id, type: "iteration", started_at: "2026-09-18T00:00:00.000Z", dir: `workflows/${id}` }]);

    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
    expect(validateStatus(statusPath).ok).toBe(true);
  });

  test("date-only startedAt is valid; a plan producer registration in a separate harness stays type plan", async () => {
    const iteration = harness();
    const r1 = await registerIterationWorkflow(id, options(iteration.root, { startedAt: "2026-09-18" }));
    expect(r1.recovered).toBe(false);
    const snapshot = JSON.parse(readFileSync(iteration.snapshotPath, "utf8")) as Record<string, unknown>;
    expect(snapshot.started_at).toBe("2026-09-18");
    expect(snapshot.updated_at).toBe("2026-09-18");

    // Type isolation: the plan producer registers a type: plan workflow under
    // the same id in a SEPARATE harness — never two successes under one id.
    const planRoot = tmpRoot("iteration-register-plan-isolation-");
    roots.push(planRoot);
    setArtifactStore(createFsStore(planRoot));
    const r2 = await registerPlanWorkflow(id, {
      harnessDir: planRoot,
      plan: { id: "p-1", title: "P", file: "plans/p.md" },
      deliveryKind: "development",
      branchSource: "feature/p",
      branchTarget: "main",
      startedAt: "2026-09-18T00:00:00.000Z",
    });
    expect(r2.recovered).toBe(false);
    const planSnapshot = JSON.parse(readFileSync(join(planRoot, "workflows", id, WORKFLOW_SNAPSHOT_FILE), "utf8")) as Record<string, unknown>;
    expect(planSnapshot.type).toBe("plan");
    expect(planSnapshot.compass_ref).toBeUndefined();
  });

  test("a failed root registration rolls the created snapshot back; retry after fixing converges; malformed/v1 roots keep their bytes", async () => {
    const { root, statusPath, snapshotPath } = harness();
    const staleRoot = {
      version: 2,
      updated_at: "2026-09-15",
      workflows: [{ id: "other-wf", type: "plan", started_at: "2026-09-15T00:00:00.000Z", dir: "workflows/other-wf" }],
    };
    mkdirSync(root, { recursive: true });
    writeFileSync(statusPath, JSON.stringify(staleRoot, null, 2));

    await expect(registerIterationWorkflow(id, options(root))).rejects.toThrow(/invalid status\.json/);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(join(root, "workflows", id))).toBe(false);
    expect(readFileSync(statusPath, "utf8")).toBe(JSON.stringify(staleRoot, null, 2));

    // Retry after fixing the stale root converges.
    writeFileSync(statusPath, emptyRoot());
    const retry = await registerIterationWorkflow(id, options(root));
    expect(retry.recovered).toBe(false);
    expect(existsSync(snapshotPath)).toBe(true);
    expect(validateStatus(statusPath).ok).toBe(true);

    // Malformed JSON root refuses without replacing its bytes.
    const { root: badRoot, statusPath: badStatus, snapshotPath: badSnapshot } = harness();
    mkdirSync(badRoot, { recursive: true });
    writeFileSync(badStatus, "{invalid", "utf8");
    await expect(registerIterationWorkflow(id, options(badRoot))).rejects.toThrow(/Invalid JSON/);
    expect(existsSync(badSnapshot)).toBe(false);
    expect(readFileSync(badStatus, "utf8")).toBe("{invalid");

    // A v1 root refuses without replacing its bytes.
    const { root: v1Root, statusPath: v1Status, snapshotPath: v1Snapshot } = harness();
    mkdirSync(v1Root, { recursive: true });
    writeFileSync(v1Status, JSON.stringify({ version: 1, updated_at: "2026-09-01", workflows: [] }, null, 2));
    await expect(registerIterationWorkflow(id, options(v1Root))).rejects.toThrow(/invalid status\.json/);
    expect(existsSync(v1Snapshot)).toBe(false);
    expect(JSON.parse(readFileSync(v1Status, "utf8")).version).toBe(1);
  });

  test("rollback removes only the exact snapshot version this call created", async () => {
    const { root, statusPath, snapshotPath } = harness();
    const fs = createFsStore(root);
    const corrupting: ArtifactStore = {
      root,
      async put(doc: ArtifactDoc): Promise<void> {
        if (doc.kind === "status") {
          const current = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
          writeFileSync(snapshotPath, JSON.stringify({ ...current, phase: "foreign-write" }, null, 2) + "\n");
          throw new Error("injected root write failure");
        }
        return fs.put(doc);
      },
      async get<T>(ref): Promise<T | undefined> {
        return fs.get<T>(ref);
      },
      async delete(ref): Promise<void> {
        return fs.delete(ref);
      },
    };
    setArtifactStore(corrupting);

    await expect(registerIterationWorkflow(id, options(root))).rejects.toThrow(/injected root write failure/);
    // The foreign-version snapshot survives; the dir is not force-removed.
    expect(existsSync(snapshotPath)).toBe(true);
    expect(JSON.parse(readFileSync(snapshotPath, "utf8")).phase).toBe("foreign-write");
    expect(existsSync(join(root, "workflows", id))).toBe(true);
    expect(existsSync(statusPath)).toBe(false);
  });

  test("create-only id collisions refuse without changing either document — including a stale same-id root entry", async () => {
    const { root, statusPath, snapshotPath } = harness();
    await registerIterationWorkflow(id, options(root));
    const beforeSnapshot = readFileSync(snapshotPath, "utf8");
    const beforeRoot = readFileSync(statusPath, "utf8");

    await expect(registerIterationWorkflow(id, options(root))).rejects.toThrow(/already registered/);
    expect(readFileSync(snapshotPath, "utf8")).toBe(beforeSnapshot);
    expect(readFileSync(statusPath, "utf8")).toBe(beforeRoot);

    // Stale same-id root entry whose snapshot is missing: refused before the
    // create branch — no replacement snapshot is created and the stale entry
    // is never rewritten.
    const { root: staleRootDir, statusPath: staleStatus } = harness();
    mkdirSync(staleRootDir, { recursive: true });
    writeFileSync(staleStatus, JSON.stringify({
      version: 2,
      updated_at: "2026-09-17",
      workflows: [{ id, type: "iteration", started_at: "2026-09-17T00:00:00.000Z", dir: `workflows/${id}` }],
    }, null, 2));

    await expect(registerIterationWorkflow(id, options(staleRootDir))).rejects.toThrow(/already registered/);
    expect(existsSync(join(staleRootDir, "workflows", id))).toBe(false);
    expect(JSON.parse(readFileSync(staleStatus, "utf8")).workflows).toEqual([
      { id, type: "iteration", started_at: "2026-09-17T00:00:00.000Z", dir: `workflows/${id}` },
    ]);
  });

  test("matching orphan recovery preserves bytes; a failed recovery root write never deletes the orphan", async () => {
    const { root, statusPath, snapshotPath } = harness();
    const first = await registerIterationWorkflow(id, options(root));
    expect(first.recovered).toBe(false);
    const orphanBytes = readFileSync(snapshotPath, "utf8");
    const orphan = JSON.parse(orphanBytes) as Record<string, unknown>;
    writeFileSync(statusPath, emptyRoot());

    // Retry with a fresh clock (no explicit startedAt): the orphan's
    // timestamps win and the snapshot bytes stay verbatim.
    const { startedAt: _retryClock, ...retryOptions } = options(root);
    const retry = await registerIterationWorkflow(id, retryOptions);
    expect(retry.recovered).toBe(true);
    expect(readFileSync(snapshotPath, "utf8")).toBe(orphanBytes);

    const rootDoc = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
    expect(rootDoc.workflows).toEqual([{ id, type: "iteration", started_at: orphan.started_at, dir: `workflows/${id}` }]);
    expect(validateStatus(statusPath).ok).toBe(true);

    // Recovery root-write failure: the orphan snapshot is never deleted.
    const { root: failRoot, statusPath: failStatus, snapshotPath: failSnapshot } = harness();
    await registerIterationWorkflow(id, options(failRoot));
    const orphan2Bytes = readFileSync(failSnapshot, "utf8");
    writeFileSync(failStatus, emptyRoot());
    const fs = createFsStore(failRoot);
    setArtifactStore({
      root: failRoot,
      async put(doc: ArtifactDoc): Promise<void> {
        if (doc.kind === "status") throw new Error("injected recovery root failure");
        return fs.put(doc);
      },
      async get<T>(ref): Promise<T | undefined> {
        return fs.get<T>(ref);
      },
      async delete(ref): Promise<void> {
        return fs.delete(ref);
      },
    });
    const { startedAt: _c2, ...recoverOptions } = options(failRoot);
    await expect(registerIterationWorkflow(id, recoverOptions)).rejects.toThrow(/injected recovery root failure/);
    expect(readFileSync(failSnapshot, "utf8")).toBe(orphan2Bytes);
    expect((JSON.parse(readFileSync(failStatus, "utf8")) as Record<string, unknown>).workflows).toEqual([]);
  });

  test("foreign orphan refusals: compass, branch, project, rows, snapshot id, coordinator; key order alone recovers", async () => {
    // Row identity/order mismatch refuses.
    {
      const { root, statusPath, snapshotPath } = harness();
      await registerIterationWorkflow(id, options(root));
      const before = readFileSync(snapshotPath, "utf8");
      writeFileSync(statusPath, emptyRoot());
      const foreignRows = [...options(root).rows].reverse();
      await expect(registerIterationWorkflow(id, options(root, { rows: foreignRows }))).rejects.toThrow(
        /different registration identity/,
      );
      expect(readFileSync(snapshotPath, "utf8")).toBe(before);
      expect((JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>).workflows).toEqual([]);
    }
    // Compass / branch / project mismatch refuses with bytes unchanged.
    for (const overrides of [
      { compassRef: "iterations/other/delivery-compass.md" },
      { branch: { base: "main", integration: "feature/other", target: "main" } },
      { project: undefined },
    ] as Partial<RegisterIterationWorkflowOptions>[]) {
      const { root, statusPath, snapshotPath } = harness();
      await registerIterationWorkflow(id, options(root));
      const before = readFileSync(snapshotPath, "utf8");
      writeFileSync(statusPath, emptyRoot());
      await expect(registerIterationWorkflow(id, options(root, overrides))).rejects.toThrow(/different registration identity/);
      expect(readFileSync(snapshotPath, "utf8")).toBe(before);
    }
    // A snapshot id differing from the requested id refuses even when the
    // rest of the identity matches.
    {
      const { root, statusPath, snapshotPath } = harness();
      await registerIterationWorkflow(id, options(root));
      const before = readFileSync(snapshotPath, "utf8");
      const misId = JSON.parse(before) as Record<string, unknown>;
      misId.id = "some-other-id";
      writeFileSync(snapshotPath, JSON.stringify(misId, null, 2));
      writeFileSync(statusPath, emptyRoot());
      await expect(registerIterationWorkflow(id, options(root))).rejects.toThrow(/different registration identity/);
    }
    // An already-bound orphan refuses: the candidate carries no coordinator.
    {
      const { root, statusPath, snapshotPath } = harness();
      await registerIterationWorkflow(id, options(root));
      const before = readFileSync(snapshotPath, "utf8");
      const bound = JSON.parse(before) as Record<string, unknown>;
      bound.coordination = { coordinator: { session_id: "s-1", session_file: join(root, "sessions", "s-1.json"), bound_at: "2026-09-18T00:00:00.000Z" } };
      writeFileSync(snapshotPath, JSON.stringify(bound, null, 2));
      writeFileSync(statusPath, emptyRoot());
      await expect(registerIterationWorkflow(id, options(root))).rejects.toThrow(/different registration identity/);
      expect(readFileSync(snapshotPath, "utf8")).toBe(JSON.stringify(bound, null, 2));
    }
    // JSON object-key order alone must NOT cause a mismatch: a reordered
    // orphan with identical identity recovers.
    {
      const { root, statusPath, snapshotPath } = harness();
      await registerIterationWorkflow(id, options(root));
      const orphanBytes = readFileSync(snapshotPath, "utf8");
      const reordered: Record<string, unknown> = {};
      for (const key of [...Object.keys(JSON.parse(orphanBytes) as Record<string, unknown>)].reverse()) {
        reordered[key] = (JSON.parse(orphanBytes) as Record<string, unknown>)[key];
      }
      writeFileSync(snapshotPath, JSON.stringify(reordered, null, 2));
      writeFileSync(statusPath, emptyRoot());
      const { startedAt: _c, ...noClock } = options(root);
      const retry = await registerIterationWorkflow(id, noClock);
      expect(retry.recovered).toBe(true);
      expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual(JSON.parse(orphanBytes));
    }
  });

  test("input refusals happen before any write", async () => {
    const { root } = harness();
    const cases: Array<{ name: string; id?: string; options: Partial<RegisterIterationWorkflowOptions> }> = [
      { name: "blank harnessDir", options: { harnessDir: "  " } },
      { name: "blank compassRef", options: { compassRef: "" } },
      { name: "branch object missing", options: { branch: undefined as unknown as RegisterIterationWorkflowOptions["branch"] } },
      { name: "blank branch base", options: { branch: { base: "", integration: "feature/x", target: "main" } } },
      { name: "blank branch integration", options: { branch: { base: "main", integration: " ", target: "main" } } },
      { name: "blank branch target", options: { branch: { base: "main", integration: "feature/x", target: "" } } },
      { name: "blank project", options: { project: "" } },
      { name: "empty rows", options: { rows: [] } },
      { name: "rows not an array", options: { rows: "nope" as unknown as RegisterIterationWorkflowOptions["rows"] } },
      { name: "row not an object", options: { rows: ["nope" as unknown as RegisterIterationWorkflowOptions["rows"][number]] } },
      { name: "row missing title", options: { rows: [{ id: "r", title: "", file: "plans/r.md" }] } },
      { name: "row missing file", options: { rows: [{ id: "r", title: "R", file: "" }] } },
      { name: "duplicate row ids", options: { rows: [{ id: "r", title: "R", file: "a.md" }, { id: "r", title: "R2", file: "b.md" }] } },
      { name: "supplied row status", options: { rows: [{ id: "r", title: "R", file: "a.md", status: "InProgress" } as unknown as RegisterIterationWorkflowOptions["rows"][number]] } },
      { name: "invalid startedAt", options: { startedAt: "not-a-date" } },
    ];
    for (const c of cases) {
      await expect(registerIterationWorkflow(c.id ?? id, options(root, c.options))).rejects.toThrow(/registerIterationWorkflow/);
    }
    // No partial activation anywhere: engine domain refusals (not CLI
    // transport errors) fired before any artifact was created.
    expect(existsSync(join(root, "workflows"))).toBe(false);
    expect(existsSync(join(root, "status.json"))).toBe(false);
  });

  test("hostile workflow id is refused by the path-component guard", async () => {
    const { root } = harness();
    await expect(registerIterationWorkflow("../escape", options(root))).rejects.toThrow(/safe path component/);
    expect(existsSync(join(root, "workflows"))).toBe(false);
    expect(existsSync(join(root, "escape"))).toBe(false);
  });

  // §4 registered-plan path contract on the iteration producer: the snapshot
  // persists the canonical absolute pointer, and the old repository-relative
  // spelling (or a foreign/absent declaration) refuses BEFORE any write.
  test("prerequisite path: a valid pointer registers as the canonical absolute plan file", async () => {
    const { root, snapshotPath } = harness();
    const result = await registerIterationWorkflow(id, options(root));
    expect(result.recovered).toBe(false);

    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { plans: Array<{ file: string }> };
    expect(snapshot.plans.map((row) => row.file)).toEqual([planFile(root, ROW_IDS[0]), planFile(root, ROW_IDS[1])]);
    // Canonical absolute, resolved through the configured root — never the
    // caller's `plans/<id>.md` spelling.
    expect(snapshot.plans.every((row) => row.file.startsWith(realpathSync(root)))).toBe(true);
  });

  test("prerequisite path: the repository-relative .mstar/plans spelling refuses with no root or snapshot write", async () => {
    const { root, statusPath, snapshotPath } = harness();
    const rows = [
      { id: ROW_IDS[0], title: "Engine producer", file: `.mstar/plans/${ROW_IDS[0]}.md` },
      { id: ROW_IDS[1], title: "CLI verb", file: `plans/${ROW_IDS[1]}.md` },
    ];
    const refusal = await registerIterationWorkflow(id, options(root, { rows })).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PlanPathError);
    expect((refusal as PlanPathError).code).toBe("plan-path.invalid-pointer");
    expect(existsSync(statusPath)).toBe(false);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(join(root, "workflows"))).toBe(false);
  });

  test("prerequisite path: a .mstarc-declared plan root resolves from its own base", async () => {
    const root = tmpRoot("iteration-register-mstarc-");
    roots.push(root);
    setArtifactStore(createFsStore(root));
    writeFileSync(join(root, ".mstarc"), "[config]\nplan_dir=planning\n");
    const planPath = planFile(root, ROW_IDS[0], "planning");

    const result = await registerIterationWorkflow(
      id,
      options(root, { rows: [{ id: ROW_IDS[0], title: "Engine producer", file: `planning/${ROW_IDS[0]}.md` }] }),
    );
    expect(result.recovered).toBe(false);
    const snapshot = JSON.parse(readFileSync(result.snapshotPath, "utf8")) as { plans: Array<{ file: string }> };
    expect(snapshot.plans).toEqual([
      expect.objectContaining({ id: ROW_IDS[0], file: planPath }),
    ]);
    expect(realpathSync(dirname(planPath))).toBe(realpathSync(join(root, "planning")));

    // The default-root spelling is NOT the configured root: it refuses.
    const other = tmpRoot("iteration-register-mstarc-default-");
    roots.push(other);
    setArtifactStore(createFsStore(other));
    writeFileSync(join(other, ".mstarc"), "[config]\nplan_dir=planning\n");
    planFile(other, ROW_IDS[0], "planning");
    const refusal = await registerIterationWorkflow(
      id,
      options(other, { rows: [{ id: ROW_IDS[0], title: "Engine producer", file: `plans/${ROW_IDS[0]}.md` }] }),
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PlanPathError);
    expect(existsSync(join(other, "workflows"))).toBe(false);
  });

  test("prerequisite path: an external plan root is admitted only as an absolute pointer", async () => {
    const root = tmpRoot("iteration-register-external-");
    const external = tmpRoot("iteration-register-external-plans-");
    roots.push(root, external);
    setArtifactStore(createFsStore(root));
    writeFileSync(join(root, ".mstarc"), `[config]\nplan_dir=${external}\n`);
    const planPath = planFile(external, ROW_IDS[0], "");

    // A harness-relative spelling cannot reach an external configured root.
    const refusal = await registerIterationWorkflow(
      id,
      options(root, { rows: [{ id: ROW_IDS[0], title: "Engine producer", file: `${ROW_IDS[0]}.md` }] }),
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PlanPathError);
    expect(existsSync(join(root, "workflows"))).toBe(false);

    // The same file addressed absolutely is the declared input form.
    const result = await registerIterationWorkflow(
      id,
      options(root, { rows: [{ id: ROW_IDS[0], title: "Engine producer", file: planPath }] }),
    );
    expect(result.recovered).toBe(false);
    const snapshot = JSON.parse(readFileSync(result.snapshotPath, "utf8")) as { plans: Array<{ file: string }> };
    expect(snapshot.plans[0]!.file).toBe(planPath);
  });

  test("prerequisite path: a missing or mismatched declaration refuses before any write", async () => {
    const { root, snapshotPath } = harness();
    // A same-basename file in an unrelated directory: not this plan's file.
    const foreign = tmpRoot("iteration-register-foreign-");
    roots.push(foreign);
    const foreignPlan = planFile(foreign, ROW_IDS[0]);
    const missing = await registerIterationWorkflow(
      id,
      options(root, { rows: [{ id: ROW_IDS[0], title: "Engine producer", file: foreignPlan }] }),
    ).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(PlanPathError);

    // A declaration naming a different plan refuses as an identity mismatch.
    writeFileSync(join(root, "plans", `${ROW_IDS[0]}.md`), "# Plan\n\n**plan_id:** some-other-plan\n");
    const mismatched = await registerIterationWorkflow(id, options(root)).catch((error: unknown) => error);
    expect(mismatched).toBeInstanceOf(PlanPathError);
    expect((mismatched as PlanPathError).code).toBe("plan-path.identity-mismatch");
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(join(root, "workflows"))).toBe(false);
  });
});

describe("standalone-completion-shape", () => {
  function standaloneCompletedHandoff(sourceBranch = "feature/fixture") {
    const sha = "a".repeat(40);
    const digest = "c".repeat(64);
    const qaDigest = "d".repeat(64);
    return {
      id: "handoff-standalone",
      attempt: 1,
      state: "completed",
      submitted_by: "plan-session",
      submitted_at: "2026-09-15T00:00:00Z",
      source_branch: sourceBranch,
      source_sha: sha,
      worktree_path: "/tmp/standalone-wt",
      review_base: "b".repeat(40),
      review_head: sha,
      qc: {
        decision: "Approve",
        reports: [{ path: "/tmp/qc1.md", sha256: digest }],
        consolidated: { path: "/tmp/qc.md", sha256: digest },
      },
      qa: { gate: "mandatory", decision: "pass", report: { path: "/tmp/qa.md", sha256: qaDigest } },
      accepted_by: "coordinator",
      accepted_at: "2026-09-15T01:00:00Z",
      completed_at: "2026-09-15T02:00:00Z",
    };
  }

  function standaloneCompletedRow(sourceBranch = "feature/fixture") {
    return {
      ...legacyRow({ status: "Done", done_at: "2026-09-15" }),
      coordination: {
        revision: 3,
        session: {
          session_id: "plan-session",
          session_file: "/tmp/plan-session.json",
          bound_at: "2026-09-15T00:00:00Z",
        },
        handoff: standaloneCompletedHandoff(sourceBranch),
      },
    };
  }

  function standaloneSnapshot(overrides: Record<string, unknown> = {}) {
    return validSnapshot({
      type: "plan",
      delivery_kind: "development",
      status: "running",
      ended_at: undefined,
      branch: { source: "feature/fixture", target: "main" },
      integration_worktree_path: undefined,
      integration_merge_lease: undefined,
      plans: [standaloneCompletedRow()],
      ...overrides,
    });
  }

  test("accepts the precise standalone completed handoff without integration", () => {
    const snapshot = standaloneSnapshot();
    delete (snapshot as Record<string, unknown>).integration_worktree_path;
    const result = validateWorkflowSnapshot(snapshot);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("refuses the same completed shape on the iteration route", () => {
    const snapshot = validSnapshot({
      type: "iteration",
      status: "running",
      ended_at: undefined,
      plans: [standaloneCompletedRow()],
    });
    expectViolations(validateWorkflowSnapshot(snapshot), "coordination.row.handoff-field");
  });

  test("refuses standalone completion copied to non-development or multi-row plan workflows", () => {
    const auditCopy = standaloneSnapshot({ delivery_kind: "audit", plans: [standaloneCompletedRow()] });
    expectViolations(validateWorkflowSnapshot(auditCopy), "coordination.row.handoff-field");

    const multiRow = standaloneSnapshot({
      plans: [standaloneCompletedRow(), legacyRow({ id: "plan-b", plan_id: "plan-b", status: "Todo", done_at: undefined })],
    });
    expectViolations(validateWorkflowSnapshot(multiRow), "coordination.row.handoff-field");
  });

  test("refuses standalone completed coherence when source_branch disagrees with branch.source", () => {
    const snapshot = standaloneSnapshot({ plans: [standaloneCompletedRow("feature/other")] });
    expectViolations(validateWorkflowSnapshot(snapshot), "coordination.row.handoff-field");
  });

  test("refuses standalone completed handoff missing acceptance or QC/QA seals", () => {
    for (const field of ["accepted_at", "accepted_by", "qc", "qa"] as const) {
      const handoff = { ...standaloneCompletedHandoff() } as Record<string, unknown>;
      delete handoff[field];
      const row = standaloneCompletedRow();
      const snapshot = standaloneSnapshot({
        plans: [
          {
            ...row,
            coordination: {
              ...(row.coordination as Record<string, unknown>),
              handoff,
            },
          },
        ],
      });
      expectViolations(validateWorkflowSnapshot(snapshot), "coordination.row.handoff-field");
    }
  });
});


// ---------------------------------------------------------------------------
// catalog registration — the registration journal drives this producer
// (state-projection-contract §3). The producer keeps its own
// create-only/orphan/rollback semantics; these cases prove the journal joins
// them to the catalog half with no split success.
// ---------------------------------------------------------------------------
describe("catalog registration — the journal joins this producer to the catalog", () => {
  const roots: string[] = [];
  afterEach(() => {
    setArtifactStore(undefined);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /**
   * A temp workspace with the real harness marker (`{root}/.mstar`) and an
   * initialized active store, plus the artifact store pinned to `root` — the
   * producers write `{root}/status.json` + `{root}/workflows/`, the store and
   * catalog roots resolve under the marker.
   */
  async function workspace(prefix: string): Promise<{ root: string; context: StoreContext }> {
    const root = tmpRoot(prefix);
    roots.push(root);
    mkdirSync(join(root, ".mstar"), { recursive: true });
    const context: StoreContext = { harnessDir: root };
    const handle = await initializeStore(context);
    handle.close();
    setArtifactStore(createFsStore(root));
    return { root, context };
  }

  function planOptions(root: string, planId: string, title: string): RegisterPlanWorkflowOptions {
    return {
      harnessDir: root,
      plan: { id: planId, title, file: `plans/${planId}.md` },
      deliveryKind: "development",
      project: "engine",
      branchSource: `feature/${planId}`,
      branchTarget: "main",
      startedAt: "2026-09-16T00:00:00.000Z",
    };
  }

  function planRequest(root: string, operationId: string, workflowId: string, planId: string, title: string, expected: number): CatalogExecutionRequest {
    return {
      operationId,
      actor: "project-manager",
      expectedCatalogRevision: expected,
      workflow: { kind: "plan", workflowId, options: planOptions(root, planId, title) },
      delta: {
        entities: [{ kind: "plan", id: planId, title, rootKind: "plans", relativePath: `plans/${planId}.md` }],
        binding: { catalogKind: "plan", catalogId: planId },
      },
    };
  }

  test("catalog registration — the plan is registered and its catalog delta publishes only after the execution half holds", async () => {
    const { root, context } = await workspace("catalog-registration-plan-");
    const workflowId = "20260916-plan-register-catalog";
    const first = planRequest(root, "op-workflow-suite", workflowId, "20260916-plan-example", "Example plan", 0);

    const receipt = await registerCatalogExecution(context, first);
    expect(receipt).toEqual({ operationId: "op-workflow-suite", workflowId, catalogRevision: 1, recovered: false });
    expect(existsSync(join(root, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    expect(validateStatus(join(root, "status.json")).ok).toBe(true);
    expect((await getCatalog(context, { kind: "plan", id: "20260916-plan-example" })).entity.title).toBe("Example plan");
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);

    // The failure boundary: a lost root write leaves a pending operation and
    // NO catalog row for it — the half-registration is never reported as
    // success, and reconcile is the way forward.
    const second = planRequest(root, "op-workflow-suite-2", `${workflowId}-2`, "20260916-plan-example-2", "Second plan", 1);
    const base = createFsStore(root);
    let armed = true;
    setArtifactStore({
      ...base,
      put: async (doc: ArtifactDoc) => {
        if (armed && doc.kind === "status") {
          armed = false;
          throw new Error("injected status write failure");
        }
        return base.put(doc);
      },
    });
    await expect(registerCatalogExecution(context, second)).rejects.toThrow(/injected status write failure/);
    setArtifactStore(createFsStore(root));
    expect((await listCatalog(context, { kind: "plan" })).total).toBe(1);
    expect((await listPendingCatalogRegistrations(context)).map((entry) => entry.operationId)).toEqual(["op-workflow-suite-2"]);

    const recovered = await reconcileCatalogExecution(context, "op-workflow-suite-2");
    expect(recovered.recovered).toBe(true);
    expect((await listCatalog(context, { kind: "plan" })).total).toBe(2);
    expect(validateStatus(join(root, "status.json")).ok).toBe(true);
  });

  test("catalog registration — the iteration registers with its committed catalog binding", async () => {
    const { root, context } = await workspace("catalog-registration-iteration-");
    const id = "20260918-iteration-register-catalog";
    const rowId = "20260918-iteration-register-cli";
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans", `${rowId}.md`), `# Plan ${rowId}\n\n**plan_id:** ${rowId}\n`);
    const request: CatalogExecutionRequest = {
      operationId: "op-iteration-workflow-suite",
      actor: "project-manager",
      expectedCatalogRevision: 0,
      workflow: {
        kind: "iteration",
        workflowId: id,
        options: {
          harnessDir: root,
          compassRef: "iterations/20260918-fixture/delivery-compass.md",
          branch: { base: "main", integration: "feature/20260918-iteration-fixture", target: "main" },
          rows: [{ id: rowId, title: "Engine producer", file: `plans/${rowId}.md` }],
          project: "engine",
          startedAt: "2026-09-18T00:00:00.000Z",
        },
      },
      delta: {
        entities: [{ kind: "iteration", id, title: "Fixture iteration", rootKind: "iterations", relativePath: id }],
        binding: { catalogKind: "iteration", catalogId: id },
      },
    };

    const receipt = await registerCatalogExecution(context, request);
    expect(receipt).toEqual({ operationId: "op-iteration-workflow-suite", workflowId: id, catalogRevision: 1, recovered: false });
    const snapshot = readWorkflowSnapshot(join(root, "workflows", id));
    expect(snapshot.snapshot.type).toBe("iteration");
    expect(validateWorkflowSnapshot(snapshot.snapshot).ok).toBe(true);
    expect((await resolveCatalogRegistrationState(context, id)).binding).toEqual({
      catalogKind: "iteration",
      catalogId: id,
      catalogRevision: 1,
    });
  });
});
