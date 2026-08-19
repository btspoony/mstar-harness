/**
 * Engine migrate module — v1 -> v2 migration planner + executor (plan
 * `20260819-workflow-engine-core.md` Task 6). Fixtures are built from this
 * repo's REAL legacy tree snapshot (`fixtures/migrate-real/`): the live
 * `status.json` copied verbatim (40 rows: 36 Done / 1 InProgress / 3 Todo,
 * 11 `plan_id`-keyed rows, zero `execution_lease` on Done rows, empty
 * `residual_findings`), every canonical iteration compass frontmatter
 * verbatim (18 iterations incl. the `v2.1.0` review-chain VARIANT
 * `delivery-compass.code-reviewer-role.md` which is NOT a grouping
 * source), two real archived residual files (legacy history — not lifted),
 * plus ONE synthetic zero-plan compass (`iter-0000-fixture-zero-plan`) —
 * the real tree has no zero-plan compass, and the brief requires the
 * fixture to cover that shape.
 *
 * Spec sources (each test cites the frozen migrate semantics):
 * - Grouping: compass frontmatter is the SSOT; row id from `id` OR legacy
 *   `plan_id`; registered-but-missing ids -> owning snapshot
 *   `legacy_metadata.compact_missing[]` (23 observed — never fabricated).
 * - Status mapping: compass `active|locked` -> `running`, `completed` ->
 *   `completed`; standalone `Done` -> `completed`, `InProgress|InReview` ->
 *   `running`, `Blocked` -> `paused`, `Todo` -> `paused` + not-started
 *   note; nothing maps to `failed|stopped`; row statuses stay verbatim.
 * - Field lift: execution-policy keys first-class `execution_policy` +
 *   branch/control_worktree_path/integration_merge_lease on the ACTIVE
 *   iteration snapshot (v3.0.0); `program_roadmap` seeds the default
 *   project roadmap; `harness_root` dropped with a legacy note; all other
 *   root-metadata keys -> `legacy_metadata` (nothing dropped silently).
 * - Residuals: open `residual_findings` -> `projects/_default/residuals.json`
 *   (keyed by plan id, `source_plan`/`registered_at` provenance); the
 *   register holds ONE entry per plan key — multi-entry plans keep the
 *   first (by residual id) and record the skip in `migration_notes[]`.
 *   Archived residuals are never lifted.
 * - Notes: per-plan `notes` ARRAYS -> `workflows/<id>/notes.jsonl` initial
 *   entries; string `notes` stay on the row (not lifted).
 * - Ordering/idempotence: additive-first steps; root v2 replacement LAST
 *   (commit point — a failed run leaves v1 intact); v2 root -> no-op;
 *   dry-run -> steps only, zero writes.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJson } from "../src/core.js";
import { parseCompassFrontmatterText } from "../src/iteration.js";
import {
  ARCHIVED_STATUS_V1_FILE,
  applyMigratePlan,
  migrateHarnessTree,
  type MigratePlan,
} from "../src/migrate.js";
import { validateProjectRegister } from "../src/project.js";
import { validateStatusV2 } from "../src/status.js";
import { WORKFLOW_SNAPSHOT_FILE, validateWorkflowSnapshot } from "../src/workflow.js";

const FIXTURES = join(import.meta.dir, "fixtures", "migrate-real");

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Copy the committed real-tree fixture into a fresh tmp harness dir. */
function fixtureTree(): string {
  const root = tmpRoot("migrate-fixture-");
  cpSync(FIXTURES, root, { recursive: true });
  return root;
}

/** Deep-read every file under `dir` (rel path -> content) for tree equality. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[full.slice(dir.length + 1)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** Minimal valid residual entry (v1 shape — validated by validateResidual). */
function residual(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "R1",
    title: "residual title",
    severity: "low",
    source: "QC fixture",
    scope: "migrate.test.ts",
    decision: "defer",
    owner: "@fullstack-dev",
    target: "next iteration",
    tracking: null,
    ...overrides,
  };
}

const REAL_ITERATION_IDS = [
  "iter-20260809-dsh-workflow-viz",
  "iter-20260809-harness-root-fix",
  "iter-20260809-mstar-panel-beautify",
  "iter-20260810-panel-fix-agentflow",
  "iter-20260810-panel-zones",
  "iter-20260811-panel-f4",
  "iter-20260811-panel-fixes",
  "iter-20260812-sync-v211-panel-f5",
  "iter-20260814-fallbacks-integration",
  "iter-20260815-fallbacks-personas-workflow",
  "iter-20260815-dsh-skills-adoption",
  "iter-20260816-dsh-seeds-bridges",
  "iter-20260816-dsh-inspect-adoption",
  "iter-20260816-audit-mechanical-alignment",
  "iter-20260817-dsh-cli-roles",
  "v2.0.0",
  "v2.1.0",
];

const REAL_STANDALONE_IDS = [
  "20260717-kimi-host",
  "20260722-iter-wt-lease",
  "20260728-zero-residual",
  "20260807-agent-plugins-v1",
  "20260808-omp-inprocess-binding",
  "20260809-omp-engine-compat-hotfix",
  "20260811-code-reviewer-role",
  "20260811-gitignore-default-ignore",
  "20260816-mechanical-verification",
  "20260817-cli-bin-alias",
];

describe("migrateHarnessTree — planner on the real-tree fixture", () => {
  test("plans 29 snapshots (18 completed iterations incl. zero-plan compass + 1 running v3.0.0 + 10 standalone), ids sorted", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      expect(plan.alreadyMigrated).toBe(false);
      expect(plan.snapshots).toHaveLength(29);

      const ids = plan.snapshots.map((s) => s.id);
      expect(ids).toEqual([...ids].sort());

      const iterations = plan.snapshots.filter((s) => s.type === "iteration");
      const plansOnly = plan.snapshots.filter((s) => s.type === "plan");
      expect(iterations).toHaveLength(19);
      expect(plansOnly).toHaveLength(10);

      expect(iterations.filter((s) => s.status === "completed").map((s) => s.id).sort()).toEqual([
        ...REAL_ITERATION_IDS,
        "iter-0000-fixture-zero-plan",
      ].sort());
      expect(iterations.filter((s) => s.status === "running").map((s) => s.id)).toEqual(["v3.0.0"]);
      expect(plansOnly.map((s) => s.id).sort()).toEqual([...REAL_STANDALONE_IDS].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("v3.0.0 active iteration snapshot carries execution_policy / branch / control_worktree_path / legacy_metadata lifts + verbatim rows", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      const v3 = plan.snapshots.find((s) => s.id === "v3.0.0");
      expect(v3).toBeDefined();
      const data = v3!.data;

      expect(data.type).toBe("iteration");
      expect(data.status).toBe("running");
      expect(data.ended_at).toBeUndefined();
      expect(data.started_at).toBe("2026-08-19");
      expect(data.updated_at).toBe("2026-08-19");
      expect(data.compass_ref).toBe("iterations/v3.0.0/delivery-compass.md");

      expect(data.execution_policy).toEqual({
        plan_parallelism: "serial",
        worktree_mode: "feature-worktree",
        push_policy: "push to mirror dev-dsh authorized (2026-08-09)",
      });
      expect(data.branch).toEqual({ base: "main", integration: "iteration/v3.0.0", target: "main" });
      expect(data.control_worktree_path).toBe("/Users/bibi/workspace/ai/mstar-harness");
      expect(data.integration_merge_lease).toBeUndefined();

      expect(data.legacy_metadata).toMatchObject({
        primary_spec: ".mstar/references/dsh-adapter-roadmap.md",
        iteration_refs: ["v3.0.0"],
        iteration_merge_commit: "14dfddb",
      });
      expect(typeof data.legacy_metadata!.harness_root_note).toBe("string");
      expect(data.legacy_metadata!.harness_root_note).toContain("dropped as redundant");
      // harness_root is note-only: the raw value is NOT copied verbatim and
      // there is no first-class harness_root field (declaration == behavior).
      expect(data.legacy_metadata!.harness_root).toBeUndefined();
      expect((data as Record<string, unknown>).harness_root).toBeUndefined();

      // 4 registered plans, rows sorted by id, statuses + lease verbatim.
      expect(data.plans.map((row) => row.id)).toEqual([
        "20260819-workflow-dsh-viz",
        "20260819-workflow-engine-core",
        "20260819-workflow-migrate-cli",
        "20260819-workflow-skills-thinning",
      ]);
      const engineCore = data.plans.find((row) => row.id === "20260819-workflow-engine-core")!;
      expect(engineCore.status).toBe("InProgress");
      expect(engineCore.execution_lease).toMatchObject({ holder: "omp-pm-v3.0.0" });
      const todoRow = data.plans.find((row) => row.id === "20260819-workflow-migrate-cli")!;
      expect(todoRow.status).toBe("Todo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy plan_id-keyed rows group into the v2.0.0 iteration snapshot (rows without id key)", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      const v2 = plan.snapshots.find((s) => s.id === "v2.0.0");
      expect(v2).toBeDefined();
      const data = v2!.data;
      expect(data.status).toBe("completed");
      expect(data.ended_at).toBe("2026-08-08");
      expect(data.plans.map((row) => row.plan_id)).toEqual([
        "20260808-slice1-engine-foundation",
        "20260808-slice2-sdd-iteration",
        "20260808-slice3-dispatch-git-gates",
        "20260808-slice4-lints-scaffolds",
        "20260808-slice5-hardgates-close",
      ]);
      for (const row of data.plans) {
        expect(row.id).toBeUndefined(); // legacy plan_id-only rows stay verbatim
        expect(row.status).toBe("Done");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("registered-but-compacted ids recorded as compact_missing (23 total), never fabricated as rows", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      let total = 0;
      for (const snapshot of plan.snapshots) {
        const missing = snapshot.data.legacy_metadata?.compact_missing;
        if (missing !== undefined) {
          expect(Array.isArray(missing)).toBe(true);
          total += (missing as string[]).length;
        }
      }
      expect(total).toBe(23);

      const v21 = plan.snapshots.find((s) => s.id === "v2.1.0")!;
      expect(v21.data.legacy_metadata!.compact_missing).toEqual([
        "20260808-dsh-host-adapter",
        "20260808-dsh-package-core",
        "20260808-dsh-seams-bundle",
      ]);
      expect(v21.data.plans).toEqual([]);

      const viz = plan.snapshots.find((s) => s.id === "iter-20260809-dsh-workflow-viz")!;
      expect(viz.data.legacy_metadata!.compact_missing).toEqual(["20260809-dsh-workflow-viz-panel"]);
      expect(viz.data.plans).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the delivery-compass.code-reviewer-role.md variant is NOT a grouping source", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      // 20260811-code-reviewer-role is registered only in the v2.1.0 VARIANT
      // compass (never the canonical one) -> standalone plan snapshot.
      const row = plan.snapshots.find((s) => s.id === "20260811-code-reviewer-role");
      expect(row).toBeDefined();
      expect(row!.type).toBe("plan");
      expect(plan.snapshots.find((s) => s.id === "v2.1.0")!.data.legacy_metadata!.compact_missing).not.toContain(
        "20260811-code-reviewer-role",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("zero-plan compass still produces an empty terminal iteration snapshot", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      const zero = plan.snapshots.find((s) => s.id === "iter-0000-fixture-zero-plan");
      expect(zero).toBeDefined();
      expect(zero!.type).toBe("iteration");
      expect(zero!.status).toBe("completed");
      expect(zero!.data.plans).toEqual([]);
      expect(zero!.data.ended_at).toBe("2026-08-02");
      expect(zero!.data.legacy_metadata).toBeUndefined(); // no plans -> no compact_missing
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("standalone snapshots: 10 completed plan lifecycles with verbatim rows and legacy dates", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      const standalone = plan.snapshots.filter((s) => s.type === "plan");
      for (const snapshot of standalone) {
        expect(snapshot.status).toBe("completed");
        expect(snapshot.data.plans).toHaveLength(1);
        expect(snapshot.data.ended_at).toBeDefined();
        expect(snapshot.data.compass_ref).toBeUndefined();
        expect(snapshot.data.execution_policy).toBeUndefined();
        expect(snapshot.data.legacy_metadata).toBeUndefined();
      }
      // plan_id-keyed row with no dates: every timestamp falls back to the
      // root v1 updated_at (deterministic — no clock reads).
      const kimi = standalone.find((s) => s.id === "20260717-kimi-host")!;
      expect(kimi.data.started_at).toBe("2026-08-19");
      expect(kimi.data.ended_at).toBe("2026-08-19");
      expect(kimi.data.updated_at).toBe("2026-08-19");
      expect(kimi.data.plans[0]!.plan_id).toBe("20260717-kimi-host");
      expect(kimi.data.plans[0]!.id).toBeUndefined();

      const zeroResidual = standalone.find((s) => s.id === "20260728-zero-residual")!;
      expect(zeroResidual.data.started_at).toBe("2026-07-28");
      expect(zeroResidual.data.ended_at).toBe("2026-07-28");
      expect(zeroResidual.data.plans[0]!.notes).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every planned snapshot passes validateWorkflowSnapshot", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      for (const snapshot of plan.snapshots) {
        const gate = validateWorkflowSnapshot(snapshot.data);
        expect(gate.violations).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("step list: additive-first, root v2 replacement LAST, harness-relative destinations", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      expect(plan.steps[0]).toMatchObject({ kind: "archive-status-v1", destination: ARCHIVED_STATUS_V1_FILE });
      expect(plan.steps[plan.steps.length - 1]).toMatchObject({ kind: "replace-root-v2" });

      const kinds = plan.steps.map((step) => step.kind);
      expect(kinds.filter((kind) => kind === "write-snapshot")).toHaveLength(29);
      expect(kinds.filter((kind) => kind === "write-notes")).toHaveLength(7);
      expect(kinds.filter((kind) => kind === "write-roadmap")).toHaveLength(1);
      expect(kinds.filter((kind) => kind === "write-register")).toHaveLength(0);

      // additivity: every snapshot/notes step precedes the root replacement
      const rootIdx = kinds.lastIndexOf("replace-root-v2");
      expect(kinds.slice(0, rootIdx)).not.toContain("replace-root-v2");
      for (const step of plan.steps) expect(step.destination.startsWith("/")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("notes files: row notes arrays lifted per workflow, string notes stay on the row", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      const files = plan.notesFiles.map((n) => n.file);
      expect(files).toEqual([
        "workflows/20260728-zero-residual/notes.jsonl",
        "workflows/20260807-agent-plugins-v1/notes.jsonl",
        "workflows/20260808-omp-inprocess-binding/notes.jsonl",
        "workflows/20260809-omp-engine-compat-hotfix/notes.jsonl",
        "workflows/20260811-code-reviewer-role/notes.jsonl",
        "workflows/20260811-gitignore-default-ignore/notes.jsonl",
        "workflows/v2.0.0/notes.jsonl",
      ]);

      const zero = plan.notesFiles.find((n) => n.file === "workflows/20260728-zero-residual/notes.jsonl")!;
      expect(zero.lines).toHaveLength(2);
      for (const line of zero.lines) {
        const parsed = JSON.parse(line) as { kind: string; ts: string; text: string };
        expect(parsed.kind).toBe("note");
        expect(parsed.ts).toBe("2026-07-28");
      }
      expect(JSON.parse(zero.lines[0]!).text).toBe("2026-07-28 registered from CreatePlan zero_residual_mode");

      // string-typed notes are NOT lifted (they stay verbatim on the row).
      expect(files).not.toContain("workflows/20260816-inspect-redteam-consolidation/notes.jsonl");
      const inspect = plan.snapshots.find((s) => s.id === "iter-20260816-dsh-inspect-adoption")!;
      expect(typeof inspect.data.plans[2]!.notes).toBe("string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("roadmap seed preserves program_roadmap.no_intermediate_releases and deferred_beyond (nothing dropped silently)", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      const content = plan.roadmap!.content;
      expect(content).toContain("no_intermediate_releases: true");
      expect(content).toContain("### Deferred beyond");
      expect(content).toContain("- pi/dsh adapters (host APIs unknown)");
      expect(content).toContain("- omp in-process binding (no TS plugin surface as of 2026-08-07)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("applyMigratePlan — executor on a copied fixture tree", () => {
  test("migrates the tree end-to-end (file-by-file v2 tree assertion)", async () => {
    const root = fixtureTree();
    try {
      const v1Before = readJson(join(root, "status.json"));
      const plan = migrateHarnessTree(root);
      const result = await applyMigratePlan(plan);
      expect(result.applied).toBe(true);

      // Root becomes v2 with empty workflows[] (re-registration is a runtime step).
      const rootDoc = readJson(join(root, "status.json"));
      expect(rootDoc).toEqual({ version: 2, updated_at: "2026-08-19", workflows: [] });
      expect(validateStatusV2(join(root, "status.json")).ok).toBe(true);

      // v1 root archived — never deleted without that copy.
      expect(readJson(join(root, ARCHIVED_STATUS_V1_FILE))).toEqual(v1Before);

      // Every planned snapshot written and valid.
      for (const snapshot of plan.snapshots) {
        const filePath = join(root, snapshot.file);
        expect(existsSync(filePath)).toBe(true);
        expect(validateWorkflowSnapshot(readJson(filePath)).ok).toBe(true);
      }

      // Roadmap seeded from metadata.program_roadmap.
      const roadmapPath = join(root, "projects", "_default", "roadmap.md");
      expect(existsSync(roadmapPath)).toBe(true);
      const roadmap = readFileSync(roadmapPath, "utf8");
      const frontmatter = parseCompassFrontmatterText(roadmap, roadmapPath);
      expect(frontmatter.project_id).toBe("_default");
      expect(frontmatter.title).toBe("Skill programmatic split \u2192 TS engine");
      expect(frontmatter.status).toBe("active");
      expect(frontmatter.created_at).toBe("2026-08-19");
      expect(frontmatter.residuals_ref).toBe("residuals.json");
      expect(frontmatter.milestones).toHaveLength(5);
      expect(String((frontmatter.milestones as string[])[0])).toContain("Slice 1");

      // Empty residual_findings -> no register file.
      expect(existsSync(join(root, "projects", "_default", "residuals.json"))).toBe(false);

      // Notes ledgers written.
      for (const notes of plan.notesFiles) {
        expect(existsSync(join(root, notes.file))).toBe(true);
      }

      // Archived residual files stay untouched (legacy history, not lifted).
      expect(existsSync(join(root, "archived", "residuals", "20260722-iter-wt-lease.json"))).toBe(true);
      expect(existsSync(join(root, "archived", "residuals", "20260811-gitignore-default-ignore.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("idempotent re-run on the migrated tree is a no-op and changes nothing", async () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      await applyMigratePlan(plan);
      const treeBefore = snapshotTree(root);

      const second = await applyMigratePlan(plan);
      expect(second.applied).toBe(false);
      expect(second.message).toContain("no-op");
      expect(snapshotTree(root)).toEqual(treeBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("planner on a v2 root returns an alreadyMigrated plan with no steps", async () => {
    const root = fixtureTree();
    try {
      await applyMigratePlan(migrateHarnessTree(root)); // migrate the tree first
      const v2plan = migrateHarnessTree(root);
      expect(v2plan.alreadyMigrated).toBe(true);
      expect(v2plan.steps).toEqual([]);
      expect(v2plan.snapshots).toEqual([]);
      expect(v2plan.message).toContain("no-op");
      const result = await applyMigratePlan(v2plan);
      expect(result.applied).toBe(false);
      expect(result.message).toContain("no-op");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a mid-apply failure leaves the v1 root intact (root v2 replacement is the commit point)", async () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      const v1Before = readJson(join(root, "status.json"));

      // Poison one snapshot (invalid id) so the apply fails mid-loop.
      const poisoned = structuredClone(plan) as MigratePlan;
      poisoned.snapshots[3]!.data.id = "";

      await expect(applyMigratePlan(poisoned)).rejects.toThrow(/invalid snapshot/);

      // Root still v1 — the failed run is recoverable by re-running.
      expect(readJson(join(root, "status.json"))).toEqual(v1Before);
      expect(existsSync(join(root, ARCHIVED_STATUS_V1_FILE))).toBe(true);

      // Re-run with the valid plan completes the migration.
      const retry = await applyMigratePlan(plan);
      expect(retry.applied).toBe(true);
      expect(readJson(join(root, "status.json")).version).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run: steps are listed, apply writes nothing", async () => {
    const root = fixtureTree();
    try {
      const before = snapshotTree(root);
      const plan = migrateHarnessTree(root, { dryRun: true });
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.dryRun).toBe(true);

      const result = await applyMigratePlan(plan);
      expect(result.applied).toBe(false);
      expect(result.message).toContain("dry-run");
      expect(snapshotTree(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a v1 tree with no status.json refuses to migrate", () => {
    const root = tmpRoot("migrate-nov1-");
    try {
      expect(() => migrateHarnessTree(root)).toThrow(/no v1 status\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a plans[] row without id/plan_id refuses to migrate (never dropped silently)", () => {
    const root = fixtureTree();
    try {
      const doc = readJson(join(root, "status.json"));
      (doc.plans as Record<string, unknown>[]).push({ title: "orphan", file: ".mstar/plans/orphan.md", status: "Done" });
      writeJson(join(root, "status.json"), doc);
      expect(() => migrateHarnessTree(root)).toThrow(/cannot be lifted/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("residual lift + status-mapping fixture (derived from the real tree)", () => {
  /** Real fixture + synthetic standalone rows (Todo/InProgress/Blocked) + a
   * non-empty residual_findings map covering: single-entry plan (iteration-
   * grouped -> lifecycle_id), multi-entry plan (collapse -> migration_notes),
   * closed entries (never lifted), and empty arrays (skipped). */
  function mappedTree(): string {
    const root = fixtureTree();
    const statusPath = join(root, "status.json");
    const doc = readJson(statusPath);
    const plans = (doc.plans as Record<string, unknown>[]).concat([
      {
        id: "20260819-fixture-standalone-todo",
        file: ".mstar/plans/20260819-fixture-standalone-todo.md",
        title: "Fixture standalone Todo row",
        status: "Todo",
        created_at: "2026-08-19",
      },
      {
        id: "20260819-fixture-standalone-running",
        file: ".mstar/plans/20260819-fixture-standalone-running.md",
        title: "Fixture standalone InProgress row",
        status: "InProgress",
        created_at: "2026-08-19",
      },
      {
        id: "20260819-fixture-standalone-blocked",
        file: ".mstar/plans/20260819-fixture-standalone-blocked.md",
        title: "Fixture standalone Blocked row",
        status: "Blocked",
        created_at: "2026-08-19",
      },
    ]);
    doc.plans = plans;
    doc.residual_findings = {
      "20260814-dsh-fallbacks-integration": [residual({ id: "R1" })],
      "20260728-zero-residual": [residual({ id: "R2", title: "second" }), residual({ id: "R1" }), residual({ id: "R3", lifecycle: "resolved", closed_at: "2026-08-19" })],
      "20260816-mechanical-verification": [],
    };
    writeJson(statusPath, doc);
    return root;
  }

  test("standalone row status mapping: Todo/Blocked -> paused + note, InProgress -> running", async () => {
    const root = mappedTree();
    try {
      const plan = migrateHarnessTree(root);
      const todo = plan.snapshots.find((s) => s.id === "20260819-fixture-standalone-todo")!;
      expect(todo.status).toBe("paused");
      expect(todo.data.status).toBe("paused");
      expect(todo.data.ended_at).toBeUndefined();
      expect(todo.data.plans[0]!.status).toBe("Todo"); // row verbatim

      const blocked = plan.snapshots.find((s) => s.id === "20260819-fixture-standalone-blocked")!;
      expect(blocked.status).toBe("paused");
      // Blocked -> paused WITHOUT a not-started note (the note is Todo-only).
      expect(plan.notesFiles.map((n) => n.file)).not.toContain("workflows/20260819-fixture-standalone-blocked/notes.jsonl");

      const running = plan.snapshots.find((s) => s.id === "20260819-fixture-standalone-running")!;
      expect(running.status).toBe("running");

      // Not-started note on the Todo workflow's notes ledger.
      const todoNotes = plan.notesFiles.find((n) => n.file === "workflows/20260819-fixture-standalone-todo/notes.jsonl")!;
      expect(todoNotes.lines).toHaveLength(1);
      const parsed = JSON.parse(todoNotes.lines[0]!) as { kind: string; text: string };
      expect(parsed.kind).toBe("note");
      expect(parsed.text).toContain("20260819-fixture-standalone-todo not started");
      expect(parsed.text).toContain("paused");

      const result = await applyMigratePlan(plan);
      expect(result.applied).toBe(true);
      expect(readJson(join(root, "workflows", "20260819-fixture-standalone-todo", WORKFLOW_SNAPSHOT_FILE)).status).toBe("paused");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("open residuals lift into projects/_default/residuals.json keyed by plan id with provenance", async () => {
    const root = mappedTree();
    try {
      const plan = migrateHarnessTree(root);
      expect(plan.register).not.toBeNull();
      const register = plan.register!;
      expect(register.file).toBe("projects/_default/residuals.json");
      expect(Object.keys(register.data.entries)).toEqual(["20260728-zero-residual", "20260814-dsh-fallbacks-integration"]);

      const grouped = register.data.entries["20260814-dsh-fallbacks-integration"]!;
      expect(grouped.source_plan).toBe("20260814-dsh-fallbacks-integration");
      expect(grouped.registered_at).toBe("2026-08-19");
      expect(grouped.lifecycle_id).toBe("iter-20260814-fallbacks-integration");
      expect(grouped.id).toBe("R1");

      // Multi-entry plan: first by residual id kept, skip recorded, closed entries never lifted.
      const collapsed = register.data.entries["20260728-zero-residual"]!;
      expect(collapsed.id).toBe("R1");
      expect(register.data.migration_notes).toEqual([
        "20260728-zero-residual: 2 open residuals share one register key (register is keyed by plan id); kept R1, skipped R2",
      ]);
      expect(plan.migrationNotes).toContain(register.data.migration_notes[0]!);
      expect(collapsed.lifecycle_id).toBeUndefined(); // standalone plan

      expect(validateProjectRegister(register.data).ok).toBe(true);

      const result = await applyMigratePlan(plan);
      expect(result.applied).toBe(true);
      const onDisk = readJson(join(root, "projects", "_default", "residuals.json"));
      expect(onDisk).toEqual(register.data);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no residual_findings at all -> no register step and no register file", () => {
    const root = fixtureTree();
    try {
      const plan = migrateHarnessTree(root);
      expect(plan.register).toBeNull();
      expect(plan.steps.map((step) => step.kind)).not.toContain("write-register");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("projectId option routes register + roadmap to the chosen project", async () => {
    const root = mappedTree();
    try {
      const plan = migrateHarnessTree(root, { projectId: "acme" });
      expect(plan.register!.file).toBe("projects/acme/residuals.json");
      expect(plan.roadmap!.file).toBe("projects/acme/roadmap.md");
      await applyMigratePlan(plan);
      expect(existsSync(join(root, "projects", "acme", "roadmap.md"))).toBe(true);
      expect(existsSync(join(root, "projects", "acme", "residuals.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("archived residual files are legacy history — never lifted, never touched", async () => {
    const root = mappedTree();
    try {
      const archivedResidualsBefore = snapshotTree(join(root, "archived", "residuals"));
      const plan = migrateHarnessTree(root);
      await applyMigratePlan(plan);
      expect(snapshotTree(join(root, "archived", "residuals"))).toEqual(archivedResidualsBefore);
      // The register holds only the synthetic residual_findings entries.
      const registerDoc = readJson(join(root, "projects", "_default", "residuals.json")) as { entries: Record<string, unknown> };
      expect(Object.keys(registerDoc.entries)).toEqual([
        "20260728-zero-residual",
        "20260814-dsh-fallbacks-integration",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
