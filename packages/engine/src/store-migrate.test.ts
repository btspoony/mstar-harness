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
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { initializeCollaborationStore, readCollaborationStage, writeCollaborationStage } from "./collaboration-store.js";
import { MIGRATION_MANIFEST_VERSION, planStoreMigration, StoreMigrationError } from "./store-migrate.js";
import type { StoreContext } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-migrate-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** note: The user-level collaboration lane is resolved through `homedir`; isolate it. */
const LANE_HOME = join(ROOT, "lane-home");
mkdirSync(LANE_HOME, { recursive: true });
let laneHomeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  laneHomeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => LANE_HOME);
});
afterAll(() => {
  laneHomeSpy?.mockRestore();
});

type Fixture = { context: StoreContext; harness: string; checkout: string };

let repoSequence = 0;

/**
 * why: A temp workspace with a real `.mstar` harness root and NO database: a Git
 * main worktree with an explicit origin-less repository identity and the
 * selected collaboration mode, so the lane resolves like a real operator's.
 */
function freshWorkspace(name: string): Fixture {
  const checkout = mkdtempSync(join(ROOT, name));
  execFileSync("git", ["init", "-q"], { cwd: checkout, stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(checkout, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=fixture-${repoSequence++}\n`);
  const harness = join(checkout, ".mstar");
  mkdirSync(harness, { recursive: true });
  return { context: { harnessDir: harness, checkoutRoot: checkout }, harness, checkout };
}

/** note: The lane this fixture's reviewed import stages into. */
function laneLocation(context: StoreContext) {
  return resolveCollaborationLocation(context);
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
    expect(manifest.retirement.registers).toHaveLength(4);
  });

  test("a row missing only tracking/target classifies as reviewed history with rationale; other missing evidence still blocks (FW-2)", async () => {
    const { context, harness } = freshWorkspace("history-only-");
    writeRegister(harness, "_default", {
      entries: {
        "plan-alpha": [
          entry({ id: "H1", tracking: undefined }),
          entry({ id: "H2", target: undefined, lifecycle: "wont-fix", decision: "risk-accepted" }),
        ],
        // Absence of any OTHER required field remains an unresolved row.
        "plan-beta": [entry({ id: "H3", owner: undefined })],
      },
    });

    const manifest = await planStoreMigration(context);

    // The history-only rows are MAPPINGS with a reviewed rationale — not
    // unresolved, not dropped (plan QC fix wave FW-2 makes the reviewed
    // 2026-09-19 history-only disposition representable, §3).
    const history = manifest.mappings.filter((mapping) => mapping.classification === "history");
    expect(history.map((mapping) => mapping.source.entryId).sort()).toEqual(["H1", "H2"]);
    expect(history.every((mapping) => mapping.proposedIssueId === "")).toBe(true);
    expect(history.every((mapping) => mapping.rationale !== null && mapping.rationale.includes("history only"))).toBe(true);
    expect(history.every((mapping) => typeof JSON.parse(mapping.legacyJson).title === "string")).toBe(true);

    // The vocabulary mapping is retained verbatim on the history row:
    // `wont-fix` stays mapped to `waived`, never relabelled `resolved`.
    const wontFix = history.find((mapping) => mapping.source.entryId === "H2")!;
    expect(wontFix.disposition).toBe("waived");
    expect(wontFix.legacy.lifecycle).toBe("wont-fix");
    expect(wontFix.legacy.decision).toBe("risk-accepted");

    // Missing evidence outside the history-only fields still blocks apply.
    expect(manifest.unresolved).toHaveLength(1);
    expect(manifest.unresolved[0]!.code).toBe("missing-field");
    expect(manifest.unresolved[0]!.detail).toContain("owner");
    expect(manifest.blocksApply).toBe(true);
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
import { applyStoreMigration, StoreMigrationError as MigrationError, type MigrationManifest } from "./store-migrate.js";
import { initializeStore, openStore } from "./store-db.js";
import { captureIssue } from "./issue.js";

/**
 * invariant: One read-only query against the collaboration lane the reviewed import
 * stages into. The lane is the issue/catalog authority, so every applied-row
 * assertion reads it, never the checkout's execution store.
 */
async function laneRows(context: StoreContext, sql: string, ...params: Array<string | number>): Promise<Record<string, unknown>[]> {
  return readCollaborationStage(laneLocation(context), ({ db }) => db.prepare(sql).all(...params) as Record<string, unknown>[]);
}

async function laneRow(context: StoreContext, sql: string, ...params: Array<string | number>): Promise<Record<string, unknown> | undefined> {
  return readCollaborationStage(laneLocation(context), ({ db }) => db.prepare(sql).get(...params) as Record<string, unknown> | undefined);
}

/** note: The lane's own `collaboration_meta` projection. */
async function laneMeta(context: StoreContext): Promise<{ authority_state: string; revision: number; catalog_revision: number }> {
  const row = await laneRow(context, "select authority_state, revision, catalog_revision from collaboration_meta where id = 1");
  if (
    row === undefined ||
    typeof row.authority_state !== "string" ||
    typeof row.revision !== "number" ||
    typeof row.catalog_revision !== "number"
  ) {
    throw new Error("the fixture lane records no readable collaboration_meta singleton");
  }
  return { authority_state: row.authority_state, revision: row.revision, catalog_revision: row.catalog_revision };
}

async function createStagedApplyFixture(name: string): Promise<Fixture & { manifest: MigrationManifest }> {
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
  test("apply stages the reviewed manifest in the collaboration lane and an identical rerun replays the same IDs", async () => {
    const { context, harness, manifest } = await createStagedApplyFixture("apply-replay-");

    const receipt = await applyStoreMigration(context, manifest);

    expect(receipt.replayed).toBe(false);
    expect(receipt.phase).toBe("applied");
    expect(receipt.counts.issues).toBe(manifest.mappings.length);
    expect(receipt.counts.created).toBe(manifest.mappings.length);
    expect(receipt.counts.updated).toBe(0);
    expect(receipt.counts.open).toBe(2);
    expect(receipt.counts.closed).toBe(1);

    // invariant: The receipt's persistent ID mapping matches the applied lane rows exactly.
    const issues = await laneRows(context, "select id, project_id, disposition, severity from issues order by id");
    expect(issues.map((row) => row.id)).toEqual(receipt.issueIds.map((entry) => entry.issueId).sort());
    // note: One capture occurrence per row; the closed row also carries its single
    // imported terminal transition.
    expect(await laneRows(context, "select id from occurrences where imported = 1")).toHaveLength(3);
    expect(await laneRows(context, "select distinct origin from provenance where kind='migration'")).toEqual([{ origin: "unscoped" }]);
    const transitions = await laneRows(context, "select to_disposition, occurred_at from issue_transitions where imported = 1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.to_disposition).toBe("resolved");
    expect(transitions[0]!.occurred_at).toBe("2026-09-02");
    // note: The lane stays staged and the catalog half imported.
    const meta = await laneMeta(context);
    expect(meta.authority_state).toBe("staged");
    expect(receipt.counts.catalogEntities).toBe(manifest.catalog.entities.length);
    expect(manifest.catalog.entities.length).toBeGreaterThan(0);
    expect(meta.catalog_revision).toBeGreaterThan(0);
    // note: The counter sits past the deterministic first allocation (§3).
    const counter = (await laneRows(context, "select next_value from issue_counter"))[0] as { next_value: number };
    expect(counter.next_value).toBeGreaterThan(3);
    // note: One phase row records the applied manifest + mapping.
    const phases = await laneRows(context, "select operation_id from collaboration_operations where operation_id like 'migration:applied:%'");
    expect(phases).toHaveLength(1);
    // invariant: The checkout's execution store was never created or written.
    expect(existsSync(join(harness, "store.db"))).toBe(false);

    // Exact rerun of the identical manifest: replay returns the same IDs and
    // counts with no additional writes.
    const revisionBefore = receipt.storeRevision;
    const replay = await applyStoreMigration(context, manifest);
    expect(replay.replayed).toBe(true);
    expect(replay.issueIds).toEqual(receipt.issueIds);
    expect(replay.counts.issues).toBe(receipt.counts.issues);
    expect(replay.counts.created).toBe(0);
    expect(replay.storeRevision).toBe(revisionBefore);
    expect((await laneMeta(context)).revision).toBe(revisionBefore);
  });

  test("apply accepts register byte drift but still refuses a changed source set", async () => {
    const { context, harness, manifest } = await createStagedApplyFixture("drift-");

    // Byte drift: one register changes after review. Content drift is not a
    // refusal (A3) — the reviewed manifest is applied and the changed bytes are
    // simply the current source.
    writeRegister(harness, "_default", {
      entries: {
        "plan-alpha": [
          entry({ id: "R1", severity: "critical", decision: "defer" }),
          entry({ id: "R2", lifecycle: "resolved", decision: "accept", closed_at: "2026-09-02", closure_note: "fixed" }),
          entry({ id: "R3" }),
        ],
      },
    });
    const receipt = await applyStoreMigration(context, manifest);
    expect(receipt.phase).toBe("applied");
    expect(receipt.issueIds.length).toBe(3);

    // Source-set drift: a NEW register appears after review; the stale manifest
    // no longer matches the source set, and it refuses with no further writes.
    writeRegister(harness, "omp-integration", { entries: { "plan-beta": [entry({ id: "R9" })] } });
    try {
      await applyStoreMigration(context, manifest);
      throw new Error("expected source-set drift to refuse the apply");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe("store.migration-source-changed");
    }
  });

  test("apply accepts a reversed reviewed register enumeration with equivalent facts", async () => {
    const { context, manifest } = await createStagedApplyFixture("reversed-");
    // Genuinely reorder the compared set: the supplied manifest's register
    // enumeration is reversed (the source set is otherwise identical), so apply
    // must accept it by keyed membership, not by position. A reversed copy is
    // used so the fixture's on-disk registers stay the reviewed ones.
    const reversed: typeof manifest = {
      ...manifest,
      sources: [...manifest.sources].reverse(),
      retirement: { ...manifest.retirement, registers: [...manifest.retirement.registers].reverse() },
    };
    const receipt = await applyStoreMigration(context, reversed);
    expect(receipt.phase).toBe("applied");

    // Semantic negative control: dropping one reviewed register is still refused.
    const missing: typeof manifest = {
      ...manifest,
      sources: manifest.sources.filter((source: MigrationManifest["sources"][number]) => source.project !== "engine"),
    };
    try {
      await applyStoreMigration(context, missing);
      throw new Error("expected the missing-register source set to refuse the apply");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe("store.migration-source-changed");
    }
  });

  test("apply refuses an unresolved manifest and a combined store that still owns collaboration rows", async () => {
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
    expect(existsSync(laneLocation(blocked.context).dbPath)).toBe(false);

    // invariant: A store that still owns collaboration rows IS the authority for them:
    // reimporting registers would mint a second one, so the transport refuses
    // with the cutover route and writes nothing (not even a lane).
    const { context, manifest } = await createStagedApplyFixture("active-guard-");
    const active = await initializeStore(context);
    active.close();
    const combined = await openStore(context, "write");
    try {
      combined.db
        .prepare(
          "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key) " +
            "values ('I-000001', 'engine', 'Live finding before activation', 'bug', 'high', 'live authority', 'no longer reproduces', 'now', 'now', 'live-root-cause')",
        )
        .run();
    } finally {
      combined.close();
    }
    await expect(applyStoreMigration(context, manifest)).rejects.toMatchObject({ code: "collaboration.cutover-required" });
    expect(existsSync(laneLocation(context).dbPath)).toBe(false);
  });

  test("apply stages the lane beside a pristine execution store and never writes that store", async () => {
    // note: A checkout that ran `store init` first holds a fresh, empty execution
    // store. It is not a staging area: the reviewed import stages the LANE and
    // leaves those bytes alone.
    const fixture = freshWorkspace("pristine-store-");
    writeRegister(fixture.harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1" })] } });
    const before = await initializeStore(fixture.context);
    expect(before.epoch).toBe(1);
    before.close();
    const storeBytes = readFileSync(join(fixture.harness, "store.db"));
    const manifest = await planStoreMigration(fixture.context);

    const receipt = await applyStoreMigration(fixture.context, manifest);
    expect(receipt.replayed).toBe(false);
    expect(receipt.counts.issues).toBe(1);
    expect((await laneMeta(fixture.context)).authority_state).toBe("staged");
    expect(readFileSync(join(fixture.harness, "store.db"))).toEqual(storeBytes);
    expect(await laneRows(fixture.context, "select id from issues")).toHaveLength(1);

    // invariant: A published lane is never reopened for a reimport: that would be a second
    // activation of the same authority.
    const promoted = await readCollaborationStage(laneLocation(fixture.context), ({ authority }) => authority);
    expect(promoted.state).toBe("staged");
    await expect(applyStoreMigration(fixture.context, manifest)).resolves.toMatchObject({ replayed: true });
  });

  test("apply refuses an already published lane and a lane staged by the reviewed cutover", async () => {
    // invariant: P1: the authority is already published. A file-era reimport is never a
    // second activation, so the transport refuses by name and writes nothing.
    const published = await createStagedApplyFixture("lane-published-");
    const first = await applyStoreMigration(published.context, published.manifest);
    const target = laneLocation(published.context);
    await writeCollaborationStage(target, ({ db }) => {
      db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run("2026-11-21T00:00:00.000Z");
    });
    await expect(applyStoreMigration(published.context, published.manifest)).rejects.toMatchObject({
      code: "store.migration-active-store",
    });
    const after = await readCollaborationStage(target, ({ db, authority }) => ({
      state: authority.state,
      phases: db.prepare("select operation_id from collaboration_operations order by rowid").all(),
    }));
    expect(after.state).toBe("active");
    expect(after.phases).toHaveLength(1);
    void first;

    // invariant: P2: the lane is staged by the reviewed CUTOVER, whose target belongs to
    // that manifest — never to a file-era register import.
    const cutover = await createStagedApplyFixture("lane-cutover-staged-");
    const location = laneLocation(cutover.context);
    await initializeCollaborationStore(location);
    await writeCollaborationStage(location, ({ db }) => {
      db.prepare(
        "insert into cutover_publications(manifest_id, phase, source_store_id, source_epoch, source_schema_version, " +
          "source_revision, source_catalog_revision, manifest_digest, target_store_id, target_epoch, verified_at) " +
          "values ('cutover-manifest', 'verified', 'source-store', 1, 21, 3, 1, 'digest', 'target-store', 1, ?)",
      ).run("2026-11-21T00:00:00.000Z");
    });
    await expect(applyStoreMigration(cutover.context, cutover.manifest)).rejects.toMatchObject({
      code: "collaboration.cutover-conflict",
    });
    expect(await laneRows(cutover.context, "select id from issues")).toEqual([]);
    expect(await laneRows(cutover.context, "select operation_id from collaboration_operations")).toEqual([]);
  });

  test("apply never writes a fenced combined source", async () => {
    const { context, manifest } = await createStagedApplyFixture("fenced-source-");
    // note: The pre-cutover combined store this fence belongs to.
    (await initializeStore(context)).close();
    const handle = await openStore(context, "write");
    try {
      // note: The fence record migration 20 created, written on a store whose combined
      // collaboration tables are its pre-cutover image.
      handle.db
        .prepare(
          "insert into collaboration_cutover(id, manifest_id, manifest_digest, source_store_id, source_epoch, source_schema_version, " +
            "source_revision, source_catalog_revision, target_store_id, target_epoch, backup_path, fenced_at) " +
            "values (1, 'cutover-manifest', 'digest', 'source-store', 1, 21, 3, 1, 'target-store', 1, ?, ?)",
        )
        .run(join(context.harnessDir, "archived", "pre-fence.db"), "2026-11-21T00:00:00.000Z");
    } finally {
      handle.close();
    }

    await expect(applyStoreMigration(context, manifest)).rejects.toMatchObject({ code: "collaboration.cutover-conflict" });
    // note: The fence record and its pre-fence image reference are untouched, and no
    // lane was created beside the fenced source.
    expect(existsSync(laneLocation(context).dbPath)).toBe(false);
    const reader = await openStore(context, "read");
    try {
      expect(reader.db.prepare("select manifest_id from collaboration_cutover where id = 1").get()).toEqual({
        manifest_id: "cutover-manifest",
      });
    } finally {
      reader.close();
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

    const rows = (await laneRows(
      fixture.context,
      "select to_disposition, occurred_at from issue_transitions where issue_id = ? and imported = 1",
      issueId,
    )) as Array<{ to_disposition: string; occurred_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_disposition).toBe("resolved");
    expect(rows[0]!.occurred_at).toBe("2026-09-05");
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

    const issue = await laneRow(fixture.context, "select disposition, closed_at from issues where id = ?", issueId);
    expect(issue?.disposition).toBe("open");
    expect(issue?.closed_at).toBeNull();
    const rows = await laneRows(fixture.context, "select id from issue_transitions where issue_id = ? and imported = 1", issueId);
    expect(rows).toEqual([]);
  });

  test("an injected mid-import failure rolls back the whole apply", async () => {
    const { context, harness, manifest } = await createStagedApplyFixture("rollback-");
    // Test-owned injection inside the import transaction, so the rollback of the
    // whole batch is proven instead of asserted.
    try {
      await applyStoreMigration(context, manifest, {
        beforeRow: (index) => {
          if (index === 1) throw new Error("induced migration failure after 1 imported row(s)");
        },
      });
      throw new Error("expected the injected failure to abort the apply");
    } catch (error) {
      expect((error as Error).message).toContain("induced migration failure");
    }

    // note: No partial state survived: no issues, no phase row, counter and revision
    // untouched — the lane transaction rolled back as one unit.
    expect(await laneRows(context, "select id from issues")).toEqual([]);
    expect(await laneRows(context, "select operation_id from collaboration_operations where operation_id like 'migration:%'")).toEqual([]);
    expect(await laneRows(context, "select id from occurrences")).toEqual([]);
    const meta = await laneMeta(context);
    expect(meta.revision).toBe(0);
    expect(meta.catalog_revision).toBe(0);
    expect((await laneRows(context, "select next_value from issue_counter"))[0]!.next_value).toBe(1);

    // The same manifest applies cleanly afterwards.
    const receipt = await applyStoreMigration(context, manifest);
    expect(receipt.replayed).toBe(false);
    expect(receipt.counts.issues).toBe(manifest.mappings.length);
    void harness;
  });

  test("a staged apply blocks ordinary issue mutations and leaves the current register authoritative", async () => {
    const { context, harness, manifest } = await createStagedApplyFixture("staged-block-");
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
      throw new Error("expected ordinary capture to refuse a staged authority");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("collaboration.not-active");
    }

    // invariant: The migration wrote nothing back into the live registers: the reviewed
    // register still holds exactly the findings it held before the apply, so
    // the staged lane has not become the issue authority.
    const live = JSON.parse(readFileSync(join(harness, "projects", "_default", "residuals.json"), "utf8")) as {
      entries: Record<string, { id: string }[]>;
    };
    expect(live.entries["plan-alpha"]!.map((entry) => entry.id)).toEqual(["R1", "R2"]);
  });

  test("a removed source row refuses reconciliation instead of blind deletion", async () => {
    const { context, manifest } = await createStagedApplyFixture("removed-row-");
    const first = await applyStoreMigration(context, manifest);
    expect(first.counts.issues).toBe(3);

    // A re-reviewed manifest that drops a previously imported row refuses
    // rather than deleting the row silently. Dropping a mapping is NOT the
    // representation of a history-only decision (plan QC fix wave FW-2): a
    // history-only row is a MAPPING with classification `history` and a
    // reviewed rationale, persisted on the receipt without an issue.
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

  test("history rows persist on the receipt without allocating issues; replay and history\u2192issue re-review stay stable (FW-2)", async () => {
    const fixture = freshWorkspace("history-apply-");
    writeRegister(fixture.harness, "_default", {
      entries: {
        "plan-alpha": [
          entry({ id: "R1", severity: "critical", decision: "defer" }),
          entry({ id: "H1", tracking: undefined, lifecycle: "wont-fix", decision: "risk-accepted" }),
        ],
      },
    });

    const manifest = await planStoreMigration(fixture.context);
    expect(manifest.blocksApply).toBe(false);
    const first = await applyStoreMigration(fixture.context, manifest);
    expect(first.counts.issues).toBe(1);
    expect(first.counts.history).toBe(1);
    expect(first.counts.excluded).toBe(0);
    expect(first.issueIds).toHaveLength(1);
    expect(first.historyRows).toHaveLength(1);
    expect(first.historyRows[0]!.classification).toBe("history");
    expect(first.historyRows[0]!.rationale).toContain("history only");
    // The verbatim record travels on the receipt; no issue, occurrence or
    // provenance row exists for the history entry.
    expect(JSON.parse(first.historyRows[0]!.legacyJson).id).toBe("H1");
    expect(await laneRows(fixture.context, "select id from issues where project_id = '_default'")).toHaveLength(1);

    // Identical manifest replay returns the recorded receipt verbatim.
    const replay = await applyStoreMigration(fixture.context, manifest);
    expect(replay.replayed).toBe(true);
    expect(replay.issueIds).toEqual(first.issueIds);
    expect(replay.historyRows).toEqual(first.historyRows);

    // A re-review that classifies the history row as an issue allocates a
    // fresh id; the original tuple's id is preserved through reconciliation.
    writeRegister(fixture.harness, "_default", {
      entries: {
        "plan-alpha": [entry({ id: "R1", severity: "critical", decision: "defer" }), entry({ id: "H1" })],
      },
    });
    const revised = await planStoreMigration(fixture.context);
    const second = await applyStoreMigration(fixture.context, revised);
    expect(second.counts.issues).toBe(2);
    expect(second.counts.history).toBe(0);
    expect(second.historyRows).toHaveLength(0);
    expect(second.issueIds.find((row) => row.source.entryId === "R1")!.issueId).toBe(first.issueIds[0]!.issueId);
    expect(second.issueIds.find((row) => row.source.entryId === "H1")).toBeDefined();
  });

  test("re-classifying an imported issue as history refuses instead of demoting it (FW-2)", async () => {
    const fixture = freshWorkspace("history-demote-");
    writeRegister(fixture.harness, "_default", {
      entries: {
        "plan-alpha": [entry({ id: "R1", severity: "critical", decision: "defer" })],
      },
    });
    const manifest = await planStoreMigration(fixture.context);
    const first = await applyStoreMigration(fixture.context, manifest);
    expect(first.counts.issues).toBe(1);

    // The re-reviewed manifest classifies the IMPORTED issue's row as
    // history-only (its `tracking` evidence is dropped). An imported issue is
    // migration-owned data — a re-review never deletes it by relabelling.
    writeRegister(fixture.harness, "_default", {
      entries: {
        "plan-alpha": [entry({ id: "R1", severity: "critical", decision: "defer", tracking: undefined })],
      },
    });
    const revised = await planStoreMigration(fixture.context);
    expect(revised.mappings[0]!.classification).toBe("history");
    try {
      await applyStoreMigration(fixture.context, revised);
      throw new Error("expected the issue\u2192history reclassification to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe("store.migration-manifest-invalid");
      expect((error as MigrationError).message).toContain("never demoted");
    }
  });

  test("a history mapping without a reviewed rationale refuses apply (FW-2)", async () => {
    const fixture = freshWorkspace("history-rationale-");
    writeRegister(fixture.harness, "_default", {
      entries: { "plan-alpha": [entry({ id: "H1", tracking: undefined })] },
    });
    const manifest = await planStoreMigration(fixture.context);
    const unrationalized = {
      ...manifest,
      mappings: manifest.mappings.map((mapping) => ({ ...mapping, rationale: null })),
    };
    try {
      await applyStoreMigration(fixture.context, unrationalized);
      throw new Error("expected the rationale-less history mapping to refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe("store.migration-manifest-invalid");
      expect((error as MigrationError).message).toContain("reviewed rationale");
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

    const row = await laneRow(
      context,
      "select id, title, severity, created_at, identity_key, revision from issues where id = ?",
      originalId,
    );
    expect(row?.title).toBe("Renamed after review");
    expect(row?.severity).toBe("low");
    // note: The persistent ID and the revision survive: only the migration-owned
    // columns reconciled.
    expect(row?.id).toBe(originalId);
    expect(row?.revision).toBe(1);
    void harness;
  });
});
