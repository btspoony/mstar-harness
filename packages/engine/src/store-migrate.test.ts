/**
 * store-migrate.test.ts -- proof for the read-only migration planner
 * (issue-store-contract §3/§7).
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

// ---------------------------------------------------------------------------
// G1b — staged apply, receipt and replay (issue contract §7)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { applyStoreMigration, StoreMigrationError as MigrationError } from "./store-migrate.js";
import { openStore } from "./store-db.js";
import { captureIssue } from "./issue.js";

/** Write a register with exact raw bytes (for drift assertions). */
function registerBytes(harness: string, project: string): Buffer {
  return readFileSync(join(harness, "projects", project, "residuals.json"));
}

async function openStoreForTest(context: { harnessDir: string }) {
  return openStore(context, "read");
}

async function createStagedApplyFixture(name: string): Promise<Fixture & { manifest: Awaited<ReturnType<typeof planStoreMigration>> }> {
  const fixture = freshWorkspace(name);
  writeRegister(fixture.harness, "_default", {
    entries: {
      "plan-alpha": [
        entry({ id: "R1", severity: "critical", decision: "defer" }),
        entry({ id: "R2", lifecycle: "resolved", decision: "accept", closed_at: "2026-09-02", closure_note: "fixed" }),
      ],
    },
  });
  writeRegister(fixture.harness, "engine", {
    entries: { "plan-alpha": [entry({ id: "R1", severity: "medium" })] },
  });
  // A consistent catalog source so the same transaction also imports catalog
  // rows (one iteration index row with its compass document).
  write(
    fixture.harness,
    join("iterations", "README.md"),
    [
      "# Iterations",
      "",
      "| Iteration | Path | Description | Status |",
      "|-----------|------|-------------|--------|",
      "| `iter-one` | `iter-one/` | First iteration | `active` |",
      "",
    ].join("\n"),
  );
  write(fixture.harness, join("iterations", "iter-one", "delivery-compass.md"), "# iter-one compass\n");
  const manifest = await planStoreMigration(fixture.context);
  return { ...fixture, manifest };
}

function sqlAll(handle: { db: import("./store-db.js").StoreDb }, sql: string): Record<string, unknown>[] {
  return handle.db.prepare(sql).all() as Record<string, unknown>[];
}

describe("store-migrate apply", () => {
  test("apply imports the reviewed manifest into a staged store and an identical rerun replays the same IDs", async () => {
    const { context, harness, manifest } = await createStagedApplyFixture("apply-replay-");

    const receipt = await applyStoreMigration(context, manifest);

    expect(receipt.replayed).toBe(false);
    expect(receipt.phase).toBe("applied");
    expect(receipt.counts.issues).toBe(manifest.mappings.length);
    expect(receipt.counts.created).toBe(manifest.mappings.length);
    expect(receipt.counts.updated).toBe(0);
    expect(receipt.counts.open).toBe(2);
    expect(receipt.counts.closed).toBe(1);

    // The receipt's persistent ID mapping matches the applied rows exactly.
    const handle = await openStoreForTest(context);
    try {
      const issues = sqlAll(handle, "select id, project_id, disposition, severity from issues order by id");
      expect(issues.map((row) => row.id)).toEqual(receipt.issueIds.map((entry) => entry.issueId).sort());
      // One capture occurrence per row; the closed row also carries its single
      // imported terminal transition.
      expect(sqlAll(handle, "select id from occurrences where imported = 1")).toHaveLength(3);
      const transitions = sqlAll(handle, "select to_disposition, occurred_at from issue_transitions where imported = 1");
      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.to_disposition).toBe("resolved");
      expect(transitions[0]!.occurred_at).toBe("2026-09-02");
      // The store stays staged and the catalog half imported.
      const meta = handle.db.prepare("select authority_state, revision, catalog_revision from store_meta where id = 1").get() as Record<string, unknown>;
      expect(meta.authority_state).toBe("staged");
      expect(receipt.counts.catalogEntities).toBe(manifest.catalog.entities.length);
      expect(manifest.catalog.entities.length).toBeGreaterThan(0);
      expect(Number(meta.catalog_revision)).toBeGreaterThan(0);
      // The counter sits past the deterministic first allocation (§3).
      const counter = sqlAll(handle, "select next_value from issue_counter")[0] as { next_value: number };
      expect(counter.next_value).toBeGreaterThan(3);
      // One receipt row records the applied manifest + mapping.
      const receipts = sqlAll(handle, "select manifest_hash, phase from migration_receipts");
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.manifest_hash).toBe(receipt.manifestHash);
      expect(receipts[0]!.phase).toBe("applied");
    } finally {
      handle.close();
    }

    // Exact rerun of the identical manifest: replay returns the same IDs and
    // counts with no additional writes.
    const revisionBefore = receipt.storeRevision;
    const replay = await applyStoreMigration(context, manifest);
    expect(replay.replayed).toBe(true);
    expect(replay.issueIds).toEqual(receipt.issueIds);
    expect(replay.counts.issues).toBe(receipt.counts.issues);
    expect(replay.counts.created).toBe(0);
    expect(replay.storeRevision).toBe(revisionBefore);
    void harness;
  });

  test("apply refuses source set and byte drift with no writes", async () => {
    const { context, harness, manifest } = await createStagedApplyFixture("drift-");
    const before = registerBytes(harness, "_default");

    // Byte drift: one register changes after review.
    writeRegister(harness, "_default", {
      entries: {
        "plan-alpha": [
          entry({ id: "R1", severity: "critical", decision: "defer" }),
          entry({ id: "R2", lifecycle: "resolved", decision: "accept", closed_at: "2026-09-02", closure_note: "fixed" }),
          entry({ id: "R3" }),
        ],
      },
    });
    try {
      await applyStoreMigration(context, manifest);
      throw new Error("expected byte drift to refuse the apply");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe("store.migration-source-changed");
    }
    // Source-set drift: a NEW register appears after review; the stale
    // manifest no longer matches the source set.
    writeRegister(harness, "omp-integration", { entries: { "plan-beta": [entry({ id: "R9" })] } });
    try {
      await applyStoreMigration(context, manifest);
      throw new Error("expected source-set drift to refuse the apply");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe("store.migration-source-changed");
    }

    // Nothing was written: no database file exists after either refusal.
    expect(dbFilesUnder(harness)).toEqual([]);
    expect(readFileSync(join(harness, "projects", "_default", "residuals.json")).equals(before)).toBe(false);
  });

  test("apply refuses an unresolved manifest and a live active store", async () => {
    const blocked = freshWorkspace("blocked-");
    writeRegister(blocked.harness, "engine", { entries: { "plan-alpha": [entry({ id: "R1", lifecycle: "archived" })] } });
    const unresolved = await planStoreMigration(blocked.context);
    try {
      await applyStoreMigration(blocked.context, unresolved);
      throw new Error("expected an unresolved manifest to refuse the apply");
    } catch (error) {
      expect((error as MigrationError).code).toBe("store.migration-unresolved");
    }
    expect(dbFilesUnder(blocked.harness)).toEqual([]);

    // A live ACTIVE store (one that already holds data) refuses the reimport
    // of an old manifest. The active-EMPTY shape instead is the crashed
    // create+demote artifact and is RECOVERED by the next apply (see the
    // dedicated crash-window test below).
    const { context, manifest } = await createStagedApplyFixture("active-guard-");
    const { initializeStore } = await import("./store-db.js");
    const active = await initializeStore(context);
    active.close();
    await captureIssue(context, {
      projectId: "engine",
      title: "Live finding before activation",
      kind: "bug",
      severity: "high",
      impact: "live authority",
      acceptance: "no longer reproduces",
      sourceIdentity: "qc/live.md",
      rootCauseKey: "live-root-cause",
      acceptanceKey: "fixed",
      occurrenceKey: "run-live-1",
      sourceKind: "qc",
      location: "packages/engine/src/store-migrate.ts:1",
      observedBehavior: "a live store must not be reimported",
      evidence: ["proof"],
      discoveredAt: "2026-09-18T00:00:00.000Z",
    }, { operationId: "op-live-1", actor: "project-manager" });
    try {
      await applyStoreMigration(context, manifest);
      throw new Error("expected an active store to refuse the reimport");
    } catch (error) {
      expect((error as MigrationError).code).toBe("store.migration-active-store");
    }
  });

  test("apply recovers the crashed create+demote artifact (active empty store) and applies", async () => {
    // Simulate the crash window: the workspace got its store through the
    // migration create primitive, but the demotion to staged never committed.
    const fixture = freshWorkspace("crash-recovery-");
    writeRegister(fixture.harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1" })] } });
    const { initializeStore } = await import("./store-db.js");
    const crashed = await initializeStore(fixture.context);
    expect(crashed.epoch).toBe(1);
    crashed.close();
    const manifest = await planStoreMigration(fixture.context);

    // The next apply detects the active-EMPTY artifact in a legacy workspace,
    // recovers it to staged and proceeds instead of refusing misleadingly.
    const receipt = await applyStoreMigration(fixture.context, manifest);
    expect(receipt.replayed).toBe(false);
    expect(receipt.counts.issues).toBe(1);

    const handle = await openStoreForTest(fixture.context);
    try {
      const meta = handle.db.prepare("select authority_state from store_meta where id = 1").get() as Record<string, unknown>;
      expect(meta.authority_state).toBe("staged");
    } finally {
      handle.close();
    }

    // An active store holding ANY data is still a live store: after this
    // apply the store is staged with rows, and a forced active flip refuses.
    const promote = await (await import("./store-db.js")).openStore(fixture.context, "write");
    promote.db.exec("update store_meta set authority_state = 'active', activated_at = '2026-09-18T00:00:00.000Z' where id = 1");
    promote.close();
    try {
      await applyStoreMigration(fixture.context, manifest);
      throw new Error("expected a live active store with data to refuse the reimport");
    } catch (error) {
      expect((error as MigrationError).code).toBe("store.migration-active-store");
    }
  });

  test("reconciliation to closed inserts the imported terminal transition", async () => {
    const fixture = freshWorkspace("reconcile-closed-");
    writeRegister(fixture.harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1" })] } });
    const manifest = await planStoreMigration(fixture.context);
    const first = await applyStoreMigration(fixture.context, manifest);
    const issueId = first.issueIds[0]!.issueId;

    // The row resolves after re-review: same tuple, now closed with a time.
    writeRegister(fixture.harness, "_default", {
      entries: { "plan-alpha": [entry({ id: "R1", lifecycle: "resolved", decision: "accept", closed_at: "2026-09-05", closure_note: "done" })] },
    });
    const revised = await planStoreMigration(fixture.context);
    const second = await applyStoreMigration(fixture.context, revised);
    expect(second.counts.updated).toBe(1);
    expect(second.issueIds[0]!.issueId).toBe(issueId);

    const handle = await openStoreForTest(fixture.context);
    try {
      const rows = handle.db
        .prepare("select to_disposition, occurred_at from issue_transitions where issue_id = ? and imported = 1")
        .all(issueId) as Array<{ to_disposition: string; occurred_at: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.to_disposition).toBe("resolved");
      expect(rows[0]!.occurred_at).toBe("2026-09-05");
    } finally {
      handle.close();
    }
  });

  test("reconciliation back to open removes the stale imported terminal transition", async () => {
    const fixture = freshWorkspace("reconcile-open-");
    writeRegister(fixture.harness, "_default", {
      entries: { "plan-alpha": [entry({ id: "R1", lifecycle: "resolved", decision: "accept", closed_at: "2026-09-02" })] },
    });
    const manifest = await planStoreMigration(fixture.context);
    const first = await applyStoreMigration(fixture.context, manifest);
    const issueId = first.issueIds[0]!.issueId;
    expect(first.counts.closed).toBe(1);

    // The row reopens after re-review (the legacy lifecycle was corrected).
    writeRegister(fixture.harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1", decision: "reopen" })] } });
    const revised = await planStoreMigration(fixture.context);
    const second = await applyStoreMigration(fixture.context, revised);
    expect(second.counts.updated).toBe(1);

    const handle = await openStoreForTest(fixture.context);
    try {
      const issue = handle.db.prepare("select disposition, closed_at from issues where id = ?").get(issueId) as Record<string, unknown>;
      expect(issue.disposition).toBe("open");
      expect(issue.closed_at).toBeNull();
      const rows = handle.db
        .prepare("select id from issue_transitions where issue_id = ? and imported = 1")
        .all(issueId) as unknown[];
      expect(rows).toEqual([]);
    } finally {
      handle.close();
    }
  });

  test("an injected mid-import failure rolls back the whole apply", async () => {
    const { context, harness, manifest } = await createStagedApplyFixture("rollback-");
    const previousRunner = process.env.MSTAR_STORE_TEST_RUNNER;
    const previousHook = process.env.MSTAR_STORE_FAIL_MIGRATION_AFTER;
    process.env.MSTAR_STORE_TEST_RUNNER = "1";
    process.env.MSTAR_STORE_FAIL_MIGRATION_AFTER = "1";
    try {
      try {
        await applyStoreMigration(context, manifest);
        throw new Error("expected the injected failure to abort the apply");
      } catch (error) {
        expect((error as Error).message).toContain("induced migration failure");
      }
    } finally {
      if (previousRunner === undefined) delete process.env.MSTAR_STORE_TEST_RUNNER;
      else process.env.MSTAR_STORE_TEST_RUNNER = previousRunner;
      if (previousHook === undefined) delete process.env.MSTAR_STORE_FAIL_MIGRATION_AFTER;
      else process.env.MSTAR_STORE_FAIL_MIGRATION_AFTER = previousHook;
    }

    // No partial state survived: no issues, no receipt, counter and revision
    // untouched — the transaction rolled back as one unit.
    const handle = await openStoreForTest(context);
    try {
      expect(sqlAll(handle, "select id from issues")).toEqual([]);
      expect(sqlAll(handle, "select id from migration_receipts")).toEqual([]);
      expect(sqlAll(handle, "select id from occurrences")).toEqual([]);
      const meta = handle.db.prepare("select revision, catalog_revision from store_meta where id = 1").get() as Record<string, number>;
      expect(meta.revision).toBe(0);
      expect(meta.catalog_revision).toBe(0);
      expect(sqlAll(handle, "select next_value from issue_counter")[0]!.next_value).toBe(1);
    } finally {
      handle.close();
    }

    // The same manifest applies cleanly afterwards.
    const receipt = await applyStoreMigration(context, manifest);
    expect(receipt.replayed).toBe(false);
    expect(receipt.counts.issues).toBe(manifest.mappings.length);
    void harness;
  });

  test("a staged apply blocks ordinary issue mutations and leaves the current register authoritative", async () => {
    const { context, harness, manifest } = await createStagedApplyFixture("staged-block-");
    const registersBefore = ["_default", "engine"].map((project) => registerBytes(harness, project));
    const receipt = await applyStoreMigration(context, manifest);
    expect(receipt.replayed).toBe(false);

    // Ordinary issue capture refuses a staged store: the current register
    // remains the only live issue authority until activation.
    try {
      await captureIssue(context, {
        projectId: "engine",
        title: "New finding after migration",
        kind: "bug",
        severity: "high",
        impact: "blocks activation",
        acceptance: "no longer reproduces",
        sourceIdentity: "qc/late.md",
        rootCauseKey: "late-root-cause",
        acceptanceKey: "fixed",
        occurrenceKey: "run-late-1",
        sourceKind: "qc",
        location: "packages/engine/src/store-migrate.ts:1",
        observedBehavior: "would bypass the staged barrier",
        evidence: ["proof"],
        discoveredAt: "2026-09-18T00:00:00.000Z",
      }, { operationId: "op-late-1", actor: "project-manager" });
      throw new Error("expected ordinary capture to refuse a staged store");
    } catch (error) {
      expect((error as Error).message).toContain("store.not-active");
    }

    // The register bytes were never written by the migration.
    const registersAfter = ["_default", "engine"].map((project) => registerBytes(harness, project));
    expect(registersAfter.map((buffer, index) => buffer.equals(registersBefore[index]!))).toEqual([true, true]);
  });

  test("a removed source row refuses reconciliation instead of blind deletion", async () => {
    const { context, manifest } = await createStagedApplyFixture("removed-row-");
    const first = await applyStoreMigration(context, manifest);
    expect(first.counts.issues).toBe(3);

    // A re-reviewed manifest that drops a previously imported row (a reviewed
    // history-only decision) refuses rather than deleting the row silently.
    const reduced = { ...manifest, mappings: manifest.mappings.slice(1) };
    try {
      await applyStoreMigration(context, reduced);
      throw new Error("expected the removed row to refuse reconciliation");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe("store.migration-row-removed");
      expect((error as MigrationError).message).toContain("explicit reviewed disposition");
    }
  });

  test("a changed staged manifest reconciles migration-owned data only", async () => {
    const { context, harness, manifest } = await createStagedApplyFixture("reconcile-");
    const first = await applyStoreMigration(context, manifest);
    const originalId = first.issueIds.find((entry2) => entry2.source.entryId === "R1" && entry2.source.project === "_default")!.issueId;

    // The source row changes (severity + title) and a fresh reviewed manifest
    // is planned against the new bytes.
    writeRegister(harness, "_default", {
      entries: {
        "plan-alpha": [
          entry({ id: "R1", severity: "low", decision: "defer", title: "Renamed after review" }),
          entry({ id: "R2", lifecycle: "resolved", decision: "accept", closed_at: "2026-09-02", closure_note: "fixed" }),
        ],
      },
    });
    writeRegister(harness, "engine", {
      entries: { "plan-alpha": [entry({ id: "R1", severity: "medium" })] },
    });
    const revised = await planStoreMigration(context);
    expect(revised.mappings).toHaveLength(3);

    const second = await applyStoreMigration(context, revised);
    expect(second.replayed).toBe(false);
    expect(second.counts.updated).toBe(1);
    expect(second.counts.created).toBe(0);

    const handle = await openStoreForTest(context);
    try {
      const row = handle.db.prepare("select id, title, severity, created_at, identity_key, revision from issues where id = ?").get(originalId) as Record<string, unknown>;
      expect(row.title).toBe("Renamed after review");
      expect(row.severity).toBe("low");
      // The persistent ID, the created_at and the revision survive: only the
      // migration-owned columns reconciled.
      expect(row.created_at).toBe(
        (handle.db.prepare("select created_at from issues where id = ?").get(second.issueIds[0]!.issueId) as Record<string, unknown>).created_at,
      );
      expect(row.revision).toBe(1);
    } finally {
      handle.close();
    }
    void harness;
  });
});
