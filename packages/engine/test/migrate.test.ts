/**
 * `migrate.ts` — the PURE legacy v1 conversion the store-upgrade importer
 * consumes (`convertLegacyV1Tree`).
 *
 * The fixture is the repo's single committed v1 tree
 * (`test/fixtures/migrate-real/`: root `status.json` `version: 1` plus
 * `iterations/<id>/delivery-compass.md`). Each case copies it into a fresh tmp
 * dir and asserts the in-memory conversion AND that nothing on disk moved —
 * the conversion is a read-only step; the native import is what commits.
 *
 * Coverage: grouping (compass vs standalone), status mapping, root-metadata
 * lifts, compacted registered ids, validation of every produced snapshot,
 * unsafe/duplicate id refusals, and cross-class id collisions.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson } from "../src/core.js";
import { convertLegacyV1Tree, MIGRATE_STATUS_FILE } from "../src/migrate.js";
import { validateWorkflowSnapshot } from "../src/workflow.js";

const FIXTURES = join(import.meta.dir, "fixtures", "migrate-real");

/** Copy the committed v1 fixture into a fresh tmp harness dir. */
function fixtureTree(): string {
  const root = mkdtempSync(join(tmpdir(), "convert-v1-fixture-"));
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

const REAL_ITERATION_IDS = [
  "iter-00000809-dsh-workflow-viz",
  "iter-00000809-harness-root-fix",
  "iter-00000809-mstar-panel-beautify",
  "iter-00000810-panel-fix-agentflow",
  "iter-00000810-panel-zones",
  "iter-00000811-panel-f4",
  "iter-00000811-panel-fixes",
  "iter-00000812-sync-v211-panel-f5",
  "iter-00000814-fallbacks-integration",
  "iter-00000815-fallbacks-personas-workflow",
  "iter-00000815-dsh-skills-adoption",
  "iter-00000816-dsh-seeds-bridges",
  "iter-00000816-dsh-inspect-adoption",
  "iter-00000816-audit-mechanical-alignment",
  "iter-00000817-dsh-cli-roles",
  "v2.0.0",
  "v2.1.0",
];

const REAL_STANDALONE_IDS = [
  "00000717-kimi-host",
  "00000722-iter-wt-lease",
  "00000728-zero-residual",
  "00000807-agent-plugins-v1",
  "00000808-omp-inprocess-binding",
  "00000809-omp-engine-compat-hotfix",
  "00000811-code-reviewer-role",
  "00000811-gitignore-default-ignore",
  "00000816-mechanical-verification",
  "00000817-cli-bin-alias",
];

describe("convertLegacyV1Tree — grouping and status mapping", () => {
  test("converts 29 lifecycles (18 completed + 1 running iteration, 10 standalone) with sorted ids", () => {
    const root = fixtureTree();
    try {
      const converted = convertLegacyV1Tree(root);
      expect(converted.snapshots).toHaveLength(29);

      const ids = converted.snapshots.map((s) => s.id);
      expect(ids).toEqual([...ids].sort());

      const iterations = converted.snapshots.filter((s) => s.type === "iteration");
      const standalone = converted.snapshots.filter((s) => s.type === "plan");
      expect(iterations).toHaveLength(19);
      expect(standalone).toHaveLength(10);

      expect(iterations.filter((s) => s.status === "completed").map((s) => s.id).sort()).toEqual([
        ...REAL_ITERATION_IDS,
        "iter-0000-fixture-zero-plan",
      ].sort());
      expect(iterations.filter((s) => s.status === "running").map((s) => s.id)).toEqual(["v3.0.0"]);
      expect(standalone.map((s) => s.id).sort()).toEqual([...REAL_STANDALONE_IDS].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the v3.0.0 active iteration carries the root-metadata lifts + verbatim rows", () => {
    const root = fixtureTree();
    try {
      const v3 = convertLegacyV1Tree(root).snapshots.find((s) => s.id === "v3.0.0")!;
      const data = v3.data;

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
      // v1 root metadata.control_worktree_path lifts into the CANONICAL
      // snapshot field (the old key name survives only as the v1 input).
      expect(data.integration_worktree_path).toBe("/Users/dev/workspace/ai/mstar-harness");
      expect((data as Record<string, unknown>).control_worktree_path).toBeUndefined();
      expect(data.integration_merge_lease).toBeUndefined();

      expect(data.legacy_metadata).toMatchObject({
        primary_spec: ".mstar/references/dsh-adapter-roadmap.md",
        iteration_refs: ["v3.0.0"],
        iteration_merge_commit: "14dfddb",
      });
      expect(typeof data.legacy_metadata!.harness_root_note).toBe("string");
      expect(data.legacy_metadata!.harness_root_note).toContain("dropped as redundant");
      expect(data.legacy_metadata!.harness_root).toBeUndefined();
      expect((data as Record<string, unknown>).harness_root).toBeUndefined();

      expect(data.plans.map((row) => row.id)).toEqual([
        "00000819-workflow-dsh-viz",
        "00000819-workflow-engine-core",
        "00000819-workflow-migrate-cli",
        "00000819-workflow-skills-thinning",
      ]);
      expect(data.plans.find((row) => row.id === "00000819-workflow-engine-core")!.status).toBe("InProgress");
      expect(data.plans.find((row) => row.id === "00000819-workflow-migrate-cli")!.status).toBe("Todo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy plan_id-keyed rows stay verbatim inside their owning iteration", () => {
    const root = fixtureTree();
    try {
      const data = convertLegacyV1Tree(root).snapshots.find((s) => s.id === "v2.0.0")!.data;
      expect(data.status).toBe("completed");
      expect(data.ended_at).toBe("2026-08-08");
      expect(data.plans.map((row) => row.plan_id)).toEqual([
        "00000808-slice1-engine-foundation",
        "00000808-slice2-sdd-iteration",
        "00000808-slice3-dispatch-git-gates",
        "00000808-slice4-lints-scaffolds",
        "00000808-slice5-hardgates-close",
      ]);
      for (const row of data.plans) {
        expect(row.id).toBeUndefined(); // legacy plan_id-only rows stay verbatim
        expect(row.status).toBe("Done");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("registered-but-compacted ids land in compact_missing (23 total), never fabricated as rows", () => {
    const root = fixtureTree();
    try {
      let total = 0;
      for (const snapshot of convertLegacyV1Tree(root).snapshots) {
        const missing = snapshot.data.legacy_metadata?.compact_missing;
        if (missing !== undefined) {
          expect(Array.isArray(missing)).toBe(true);
          total += (missing as string[]).length;
        }
      }
      expect(total).toBe(23);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the delivery-compass.<role>.md variant is NOT a grouping source", () => {
    const root = fixtureTree();
    try {
      const snapshots = convertLegacyV1Tree(root).snapshots;
      // 00000811-code-reviewer-role is registered only in the v2.1.0 VARIANT
      // compass (never the canonical one) -> standalone plan snapshot.
      const row = snapshots.find((s) => s.id === "00000811-code-reviewer-role");
      expect(row?.type).toBe("plan");
      expect(snapshots.find((s) => s.id === "v2.1.0")!.data.legacy_metadata!.compact_missing).not.toContain(
        "00000811-code-reviewer-role",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a zero-plan compass still yields an empty terminal iteration snapshot", () => {
    const root = fixtureTree();
    try {
      const zero = convertLegacyV1Tree(root).snapshots.find((s) => s.id === "iter-0000-fixture-zero-plan")!;
      expect(zero.type).toBe("iteration");
      expect(zero.status).toBe("completed");
      expect(zero.data.plans).toEqual([]);
      expect(zero.data.ended_at).toBe("2026-08-02");
      expect(zero.data.legacy_metadata).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("standalone rows keep their verbatim rows and legacy dates", () => {
    const root = fixtureTree();
    try {
      const standalone = convertLegacyV1Tree(root).snapshots.filter((s) => s.type === "plan");
      for (const snapshot of standalone) {
        expect(snapshot.status).toBe("completed");
        expect(snapshot.data.plans).toHaveLength(1);
        expect(snapshot.data.ended_at).toBeDefined();
        expect(snapshot.data.compass_ref).toBeUndefined();
        expect(snapshot.data.execution_policy).toBeUndefined();
        expect(snapshot.data.legacy_metadata).toBeUndefined();
      }
      // A plan_id-keyed row with no dates falls back to the root v1
      // updated_at — deterministic, no clock reads.
      const kimi = standalone.find((s) => s.id === "00000717-kimi-host")!;
      expect(kimi.data.started_at).toBe("2026-08-19");
      expect(kimi.data.ended_at).toBe("2026-08-19");
      expect(kimi.data.plans[0]!.plan_id).toBe("00000717-kimi-host");
      expect(kimi.data.plans[0]!.id).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every produced snapshot passes validateWorkflowSnapshot", () => {
    const root = fixtureTree();
    try {
      for (const snapshot of convertLegacyV1Tree(root).snapshots) {
        expect(validateWorkflowSnapshot(snapshot.data).violations).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("conversion reports a root updated_at and leaves the source tree byte-identical", () => {
    const root = fixtureTree();
    try {
      const before = snapshotTree(root);
      const converted = convertLegacyV1Tree(root);
      expect(converted.updatedAt).toBe("2026-08-19");
      expect(converted.sources.length).toBeGreaterThan(0);
      expect(converted.dispositions).toEqual([]);
      expect(snapshotTree(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("convertLegacyV1Tree — refusals", () => {
  test("no root status.json is a named refusal", () => {
    const root = fixtureTree();
    try {
      rmSync(join(root, MIGRATE_STATUS_FILE));
      expect(() => convertLegacyV1Tree(root)).toThrow(/no legacy status\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a v2 root is not a v1 conversion input (the store upgrade imports it natively)", () => {
    const root = fixtureTree();
    try {
      writeFileSync(join(root, MIGRATE_STATUS_FILE), JSON.stringify({ version: 2, updated_at: "2026-10-04", workflows: [] }));
      expect(() => convertLegacyV1Tree(root)).toThrow(/unrecognized schema version 2/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unrecognizable root version refuses", () => {
    const root = fixtureTree();
    try {
      writeFileSync(join(root, MIGRATE_STATUS_FILE), JSON.stringify({ version: 9, updated_at: "2026-10-04" }));
      expect(() => convertLegacyV1Tree(root)).toThrow(/unrecognized schema version 9/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a v1 row without id/plan_id refuses instead of being lifted nowhere", () => {
    const root = fixtureTree();
    try {
      const doc = readJson(join(root, MIGRATE_STATUS_FILE)) as { plans: Array<Record<string, unknown>> };
      doc.plans.push({ title: "unnamed", file: "x.md", status: "Todo" });
      writeFileSync(join(root, MIGRATE_STATUS_FILE), JSON.stringify(doc));
      expect(() => convertLegacyV1Tree(root)).toThrow(/cannot be lifted/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("duplicate plan ids refuse (every row must land in exactly one snapshot)", () => {
    const root = fixtureTree();
    try {
      const doc = readJson(join(root, MIGRATE_STATUS_FILE)) as { plans: Array<Record<string, unknown>> };
      const first = doc.plans[0]!;
      doc.plans.push({ ...first });
      writeFileSync(join(root, MIGRATE_STATUS_FILE), JSON.stringify(doc));
      expect(() => convertLegacyV1Tree(root)).toThrow(/duplicate plan id/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a plan id that is not one safe path component refuses", () => {
    const root = fixtureTree();
    try {
      const doc = readJson(join(root, MIGRATE_STATUS_FILE)) as { plans: Array<Record<string, unknown>> };
      doc.plans.push({ id: "../escape", title: "escape", file: "x.md", status: "Todo" });
      writeFileSync(join(root, MIGRATE_STATUS_FILE), JSON.stringify(doc));
      expect(() => convertLegacyV1Tree(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an iteration id equal to a standalone plan id refuses as a collision", () => {
    const root = fixtureTree();
    try {
      const doc = readJson(join(root, MIGRATE_STATUS_FILE)) as { plans: Array<Record<string, unknown>> };
      doc.plans.push({ id: "v2.0.0", title: "collides with the iteration", file: "x.md", status: "Todo" });
      writeFileSync(join(root, MIGRATE_STATUS_FILE), JSON.stringify(doc));
      expect(() => convertLegacyV1Tree(root)).toThrow(/lifecycle id collision/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
