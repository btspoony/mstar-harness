/**
 * store-migrate.test.ts -- G1a proof for the read-only migration planner
 * (plan 20260918-issue-governance-cutover Task 1; issue-store-contract §3/§7).
 *
 * The suite runs the real planner over real register fixtures in per-test
 * temporary harness roots. No database is created anywhere: the preview
 * itself must stay read-only, and a dedicated case asserts that fact from the
 * filesystem rather than from a returned value.
 *
 * Run with `bun test packages/engine/src/store-migrate.test.ts --test-name-pattern 'preview|mapping'`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { MIGRATION_MANIFEST_VERSION, planStoreMigration, StoreMigrationError } from "./store-migrate.js";
import type { StoreContext } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-migrate-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

type Fixture = { context: StoreContext; harness: string };

/** A temp workspace with a real `.mstar` harness root and NO database. */
function freshWorkspace(name: string): Fixture {
  const harness = join(mkdtempSync(join(ROOT, name)), ".mstar");
  mkdirSync(harness, { recursive: true });
  return { context: { harnessDir: dirname(harness) }, harness };
}

function write(harness: string, relativePath: string, text: string): void {
  const absolute = join(harness, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text.endsWith("\n") ? text : `${text}\n`);
}

function writeRegister(harness: string, project: string, doc: unknown): void {
  write(harness, join("projects", project, "residuals.json"), JSON.stringify(doc, null, 2));
}

/** One valid register entry; individual fields are dropped by the callers that need a missing-field row. */
function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "R1",
    title: "Fix the flaky gate",
    severity: "high",
    source: "qc1.md",
    scope: "plan-scope",
    decision: "defer",
    owner: "pm",
    target: "next-iteration",
    tracking: "issue",
    source_plan: "plan-2026-09-01",
    registered_at: "2026-09-01",
    ...overrides,
  };
}

/** Every `*.db`/`*.db-wal`/`*.db-shm` file under `dir` (recursive). */
function dbFilesUnder(dir: string): string[] {
  const found: string[] = [];
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (/\.(db|db-wal|db-shm)$/.test(name)) found.push(full);
  }
  return found;
}

describe("store-migrate preview", () => {
  test("preview of a four-project fixture classifies open/closed/missing-field rows and preserves multi-bucket same R1", async () => {
    const { context, harness } = freshWorkspace("four-project-");
    // The four live projects, in the fixture's own deterministic order.
    writeRegister(harness, "_default", {
      entries: {
        "plan-alpha": [
          entry({ id: "R1", severity: "critical", decision: "defer" }),
          entry({ id: "R2", lifecycle: "resolved", decision: "accept", closed_at: "2026-09-02", closure_note: "fixed" }),
        ],
      },
    });
    writeRegister(harness, "engine", {
      entries: {
        // The SAME id R1 in a DIFFERENT project/bucket is a distinct row (§3).
        "plan-alpha": [entry({ id: "R1", severity: "medium" })],
      },
    });
    writeRegister(harness, "dsh-integration", {
      entries: { "backlog-2026-09": [entry({ id: "R1", lifecycle: "wont-fix", decision: "risk-accepted" })] },
    });
    writeRegister(harness, "omp-integration", {
      entries: {
        // Missing required evidence: an entry without `owner` never maps.
        "plan-beta": [entry({ id: "R9", owner: undefined })],
      },
    });

    const manifest = await planStoreMigration(context);

    expect(manifest.version).toBe(MIGRATION_MANIFEST_VERSION);
    expect(manifest.sources.map((source) => source.project)).toEqual([
      "_default",
      "dsh-integration",
      "engine",
      "omp-integration",
    ]);
    expect(manifest.sources.map((source) => source.entryCount)).toEqual([2, 1, 1, 1]);

    // Multi-bucket same R1: three distinct source identities survive.
    const r1s = manifest.mappings.filter((mapping) => mapping.source.entryId === "R1");
    expect(r1s).toHaveLength(3);
    expect(new Set(r1s.map((mapping) => `${mapping.source.project}/${mapping.source.bucket}`)).size).toBe(3);

    // Dispositions follow the reviewed vocabulary.
    const defaultRows = manifest.mappings.filter((mapping) => mapping.source.project === "_default");
    expect(defaultRows.map((mapping) => mapping.disposition).sort()).toEqual(["open", "resolved"]);
    expect(defaultRows.find((mapping) => mapping.disposition === "open")!.legacy.severity).toBe("critical");
    expect(manifest.mappings.find((mapping) => mapping.source.project === "dsh-integration")!.disposition).toBe("waived");

    // The missing-field row is unresolved with the missing field named, and blocks apply.
    expect(manifest.unresolved).toHaveLength(1);
    expect(manifest.unresolved[0]!.code).toBe("missing-field");
    expect(manifest.unresolved[0]!.source!.project).toBe("omp-integration");
    expect(manifest.unresolved[0]!.detail).toContain("owner");
    expect(manifest.blocksApply).toBe(true);

    // Byte digests and the source-set digest are present and distinct from a count.
    expect(manifest.sources.every((source) => /^[0-9a-f]{64}$/.test(source.sha256))).toBe(true);
    expect(manifest.sourceSetDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.retirement.registers).toHaveLength(4);
  });

  test("preview refuses a duplicate entry id within one bucket", async () => {
    const { context, harness } = freshWorkspace("duplicate-");
    writeRegister(harness, "engine", {
      entries: { "plan-alpha": [entry({ id: "R1" }), entry({ id: "R1", title: "A different finding" })] },
    });

    try {
      await planStoreMigration(context);
      throw new Error("expected planStoreMigration to refuse the duplicate entry id");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreMigrationError);
      expect((error as StoreMigrationError).code).toBe("store.migration-duplicate-entry");
      expect((error as StoreMigrationError).message).toContain("R1");
    }
  });

  test("preview creates no database and no receipt", async () => {
    const { context, harness } = freshWorkspace("no-db-");
    writeRegister(harness, "engine", { entries: { "plan-alpha": [entry({ id: "R1" })] } });

    await planStoreMigration(context);

    expect(dbFilesUnder(harness)).toEqual([]);
    // No staged receipt or store file appeared anywhere in the harness root.
    expect(existsSync(join(harness, "store.db"))).toBe(false);
  });

  test("preview blocks on a catalog conflict instead of choosing a winner", async () => {
    const { context, harness } = freshWorkspace("catalog-conflict-");
    writeRegister(harness, "engine", { entries: { "plan-alpha": [entry({ id: "R1" })] } });
    // Two explicit ids claim the SAME catalog location: a conflict a reviewer
    // must resolve, never a silent preference (state-projection §4).
    write(
      harness,
      "iterations/README.md",
      [
        "# Iterations",
        "",
        "| Iteration | Path | Description | Status |",
        "|-----------|------|-------------|--------|",
        "| `iter-one` | `iter-shared/` | First claim | `active` |",
        "| `iter-two` | `iter-shared/` | Second claim | `active` |",
        "",
      ].join("\n"),
    );
    write(harness, "iterations/iter-shared/delivery-compass.md", "# iter-shared\n");

    const manifest = await planStoreMigration(context);

    expect(manifest.catalog.conflicts).toHaveLength(1);
    expect(manifest.catalog.conflicts[0]!.field).toBe("id");
    expect(manifest.blocksApply).toBe(true);
    // The valid issue mapping still previews, but nothing is preferred: the
    // disputed location is dropped from the proposals and every competing
    // claim (both index rows and the directory's own compass identity) travels
    // in the conflict for review, never a silent winner.
    expect(manifest.mappings).toHaveLength(1);
    expect(manifest.catalog.entities.filter((entity) => entity.relativePath === "iter-shared")).toHaveLength(0);
    const claimValues = manifest.catalog.conflicts[0]!.values.map((value) => value.value);
    expect(claimValues).toContain("iteration:iter-one");
    expect(claimValues).toContain("iteration:iter-two");
  });
});

describe("legacy vocabulary mapping", () => {
  test("mapping maps reviewed wont-fix to waived and retains the exact legacy label", async () => {
    const { context, harness } = freshWorkspace("wontfix-");
    writeRegister(harness, "dsh-integration", {
      entries: {
        "backlog-2026-09": [
          entry({
            id: "R1",
            lifecycle: "wont-fix",
            decision: "risk-accepted",
            closed_at: "2026-09-03",
            closure_note: "accepted risk",
          }),
        ],
      },
    });

    const manifest = await planStoreMigration(context);

    expect(manifest.blocksApply).toBe(false);
    const mapping = manifest.mappings[0]!;
    expect(mapping.disposition).toBe("waived");
    // The exact legacy label survives verbatim in the mapping and in the
    // lossless record — never relabelled "resolved".
    expect(mapping.legacy.lifecycle).toBe("wont-fix");
    expect(mapping.legacy.decision).toBe("risk-accepted");
    expect(mapping.legacy.closedAt).toBe("2026-09-03");
    expect(JSON.parse(mapping.legacyJson).lifecycle).toBe("wont-fix");
    expect(mapping.proposedIssueId).toMatch(/^I-\d{6}$/);
  });

  test("mapping keeps a synthetic backlog bucket as provenance only, never a fabricated plan", async () => {
    const { context, harness } = freshWorkspace("backlog-");
    writeRegister(harness, "engine", {
      entries: { "backlog-2026-09": [entry({ id: "R1" })] },
    });

    const manifest = await planStoreMigration(context);

    expect(manifest.blocksApply).toBe(false);
    expect(manifest.mappings).toHaveLength(1);
    // The bucket name stays exactly where it belongs: the source identity.
    expect(manifest.mappings[0]!.source.bucket).toBe("backlog-2026-09");
    // No catalog plan/document row is proposed for the synthetic bucket: the
    // catalog proposals come from the P2 inventory, which never saw it.
    expect(manifest.catalog.entities.some((entity) => entity.id.includes("backlog"))).toBe(false);
  });

  test("mapping reports unknown legacy semantics as unresolved instead of guessing", async () => {
    const { context, harness } = freshWorkspace("unknown-");
    writeRegister(harness, "engine", {
      entries: {
        "plan-alpha": [entry({ id: "R1", lifecycle: "archived" })],
        "plan-beta": [entry({ id: "R2", severity: "blocker" })],
      },
    });

    const manifest = await planStoreMigration(context);

    expect(manifest.mappings).toHaveLength(0);
    expect(manifest.unresolved.map((unknown) => unknown.code).sort()).toEqual(["unknown-lifecycle", "unknown-severity"]);
    expect(manifest.blocksApply).toBe(true);
  });
});
