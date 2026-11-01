/**
 * import.test.ts -- M0 read-only ingest (mirror-import plan Task 3): the
 * external row shape, replay/zero-delta, exactly-once for a changed item, and
 * the local-only gate exclusion.
 * Run with `bun test packages/engine/src/issue-sync/import.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { initializeStore, openStore, type StoreContext, type StoreDb } from "../store-db.js";
import { findingsCleanupGate } from "../project.js";
import type { ProviderItem } from "./provider.js";
import {
  IMPORTED_ACCEPTANCE_KEY,
  IMPORTED_ROOT_CAUSE_KEY,
  importPage,
} from "./import.js";
import { readItem, SyncError } from "../issue-sync.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-import-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const PROJECT = "p-mirror";
const BINDING = `linear:${PROJECT}`;

function context(name: string): StoreContext {
  return { harnessDir: mkdtempSync(join(ROOT, name)) };
}

async function store(name: string): Promise<{ context: StoreContext; db: StoreDb; close: () => void }> {
  const ctx = context(name);
  const handle = await initializeStore(ctx);
  handle.db.prepare(
    "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', ?, 'Mirror', 'projects', ?, 'now', 'now')",
  ).run(PROJECT, `${PROJECT}/roadmap.md`);
  return { context: ctx, db: handle.db, close: () => handle.close() };
}

function item(overrides: Partial<ProviderItem> = {}): ProviderItem {
  return {
    externalId: "LIN-1",
    title: "Remote title",
    description: "Remote description",
    state: "Todo",
    priority: "high",
    labels: ["bug"],
    updatedAt: "2026-10-31T00:00:00.000Z",
    url: "https://linear.app/acme/issue/LIN-1",
    ...overrides,
  };
}

function issueRows(db: StoreDb): Array<Record<string, unknown>> {
  return db.prepare("select id, provider, external_id, url, title, revision, updated_at from issues order by id").all() as Array<
    Record<string, unknown>
  >;
}

describe("first import", () => {
  test("a page imports rows as visibly external issues with a stable external_id", async () => {
    const { db, close } = await store("first-page");
    const result = importPage(db, BINDING, [item(), item({ externalId: "LIN-2", title: "Second", updatedAt: "2026-11-01T00:00:00.000Z" })]);
    expect(result).toEqual({ imported: 2, updated: 0, skipped: 0, failed: 0 });

    const rows = issueRows(db);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.provider).toBe("linear");
      expect(row.url).toMatch(/^https:\/\/linear\.app\//);
      expect(row.id).toMatch(/^I-\d{6}$/);
    }
    expect(rows.map((row) => row.external_id)).toEqual(["LIN-1", "LIN-2"]);

    // The ledger row for each item points at its local issue and records the
    // remote revision the import consumed.
    const ledger = db
      .prepare("select local_id, external_id, item_state, last_remote_updated_at from issue_sync_state order by external_id")
      .all();
    expect(ledger).toEqual([
      { local_id: rows[0].id, external_id: "LIN-1", item_state: "applied", last_remote_updated_at: item().updatedAt },
      { local_id: rows[1].id, external_id: "LIN-2", item_state: "applied", last_remote_updated_at: "2026-11-01T00:00:00.000Z" },
    ]);

    // The synthetic identity triple is the documented one, not a false match.
    const occurrence = db.prepare("select source_identity, root_cause_key, acceptance_key from occurrences").get() as Record<string, string>;
    expect(occurrence.source_identity).toBe("linear:LIN-1");
    expect(occurrence.root_cause_key).toBe(IMPORTED_ROOT_CAUSE_KEY);
    expect(occurrence.acceptance_key).toBe(IMPORTED_ACCEPTANCE_KEY);
    close();
  });

  test("a replayed page imports nothing and mutates nothing (zero delta)", async () => {
    const { db, close } = await store("replay-page");
    const page = [item(), item({ externalId: "LIN-2", title: "Second" })];
    importPage(db, BINDING, page);
    const before = issueRows(db);
    const ledgerBefore = db.prepare("select * from issue_sync_state order by local_id").all();
    const receiptsBefore = db.prepare("select count(*) as n from store_operations").get();

    const second = importPage(db, BINDING, page);
    expect(second).toEqual({ imported: 0, updated: 0, skipped: 2, failed: 0 });
    expect(issueRows(db)).toEqual(before);
    expect(db.prepare("select * from issue_sync_state order by local_id").all()).toEqual(ledgerBefore);
    expect(db.prepare("select count(*) as n from store_operations").get()).toEqual(receiptsBefore);
    close();
  });
});

describe("a remote change imports exactly once", () => {
  test("run 1 imports, run 2 updates the changed item once, run 3 is zero-delta", async () => {
    const { db, close } = await store("exactly-once");
    const first = importPage(db, BINDING, [item(), item({ externalId: "LIN-2", title: "Second" })]);
    expect(first).toEqual({ imported: 2, updated: 0, skipped: 0, failed: 0 });
    const localId = (db.prepare("select id from issues where external_id = 'LIN-1'").get() as { id: string }).id;

    // Remote edit of LIN-1 only: a newer revision and a new title.
    const changed = item({ title: "Remote title v2", updatedAt: "2026-11-02T00:00:00.000Z" });
    const second = importPage(db, BINDING, [changed, item({ externalId: "LIN-2", title: "Second" })]);
    expect(second).toEqual({ imported: 0, updated: 1, skipped: 1, failed: 0 });
    expect((db.prepare("select title from issues where id = ?").get(localId) as { title: string }).title).toBe("Remote title v2");
    expect(readItem(db, { bindingId: BINDING, direction: "import", localId })).toMatchObject({
      itemState: "applied",
      lastRemoteUpdatedAt: "2026-11-02T00:00:00.000Z",
    });

    // Run 3 sees the same remote state: nothing is re-applied.
    const before = issueRows(db);
    const third = importPage(db, BINDING, [changed, item({ externalId: "LIN-2", title: "Second" })]);
    expect(third).toEqual({ imported: 0, updated: 0, skipped: 2, failed: 0 });
    expect(issueRows(db)).toEqual(before);
    close();
  });

  test("an item first seen after it changed is imported once (row absent -> planItem)", async () => {
    const { db, close } = await store("first-seen-changed");
    expect(importPage(db, BINDING, [item()])).toEqual({ imported: 1, updated: 0, skipped: 0, failed: 0 });
    // A different remote item, already at its second revision, appears.
    expect(importPage(db, BINDING, [item(), item({ externalId: "LIN-9", updatedAt: "2026-11-05T00:00:00.000Z" })])).toEqual({
      imported: 1, updated: 0, skipped: 1, failed: 0,
    });
    expect(importPage(db, BINDING, [item(), item({ externalId: "LIN-9", updatedAt: "2026-11-05T00:00:00.000Z" })])).toEqual({
      imported: 0, updated: 0, skipped: 2, failed: 0,
    });
    close();
  });

  test("a crash between capture and the plan is resumed, not duplicated", async () => {
    const { db, close } = await store("crash-resume");
    importPage(db, BINDING, [item()]);
    // Simulate the interruption: the local row exists, the ledger row is gone.
    db.prepare("delete from issue_sync_state").run();
    expect(importPage(db, BINDING, [item()])).toEqual({ imported: 0, updated: 1, skipped: 0, failed: 0 });
    expect(issueRows(db)).toHaveLength(1);
    close();
  });
});

describe("local identity and local-only gates", () => {
  test("a local issue already holding the synthetic identity refuses linear.identity-collision", async () => {
    const { db, close } = await store("identity-collision");
    const { computeIdentityKey } = await import("../issue.js");
    const identityKey = computeIdentityKey(PROJECT, "linear:LIN-1", IMPORTED_ROOT_CAUSE_KEY, IMPORTED_ACCEPTANCE_KEY);
    db.prepare(
      "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
        " values ('I-000900', ?, 'Local', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', ?)",
    ).run(PROJECT, identityKey);
    expect(importPage(db, BINDING, [item()])).toEqual({ imported: 0, updated: 0, skipped: 0, failed: 1 });
    expect(issueRows(db)).toHaveLength(1);
    expect(db.prepare("select provider from issues where id = 'I-000900'").get()).toEqual({ provider: "local" });
    close();
  });

  test("a mirrored row never counts toward the local-only findings gate", async () => {
    const { context: ctx, db, close } = await store("gate-exclusion");
    importPage(db, BINDING, [item({ priority: "urgent" })]);
    const localId = (db.prepare("select id from issues where external_id = 'LIN-1'").get() as { id: string }).id;
    // Link the mirrored row to a plan exactly like a local finding, at critical
    // severity -- the shape that WOULD violate zero-residual.
    db.prepare("insert into provenance(issue_id, kind, target, source_hash, origin) values (?, 'plan', 'plan-z', 'h', 'scoped')").run(localId);
    expect((db.prepare("select severity from issues where id = ?").get(localId) as { severity: string }).severity).toBe("critical");
    close();

    const gate = await findingsCleanupGate(ctx, "plan-z", { mode: "zero-residual" });
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);

    // Control: the same row with provider='local' DOES violate.
    const handle = await openStore(ctx, "write");
    handle.db.prepare("update issues set provider = 'local' where id = ?").run(localId);
    handle.close();
    const violation = await findingsCleanupGate(ctx, "plan-z", { mode: "zero-residual" });
    expect(violation.ok).toBe(false);
    expect(violation.violations[0]?.code).toBe("findings.zero-residual-critical");
  });

  test("a store that is not active refuses store.not-active before any write", async () => {
    const { db, close } = await store("not-active");
    db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
    const before = issueRows(db);
    expect(() => importPage(db, BINDING, [item()])).toThrow(/store\.not-active/);
    expect(issueRows(db)).toEqual(before);
    close();
  });

  test("a [linear.mapping] override reaches the captured row, and an illegal target is refused", async () => {
    const { db, close } = await store("mapping-override");
    const mapping = { disposition: {}, kind: {}, severity: { high: "critical" } };
    importPage(db, BINDING, [item({ priority: "high" })], mapping);
    const row = db.prepare("select severity from issues where external_id = 'LIN-1'").get() as { severity: string };
    expect(row.severity).toBe("critical");

    // A target the local enum does not have is refused by name instead of being
    // stored and failing validation somewhere that no longer names the .mstarc.
    // A per-item refusal fails THAT item and lets the page proceed, so the run
    // reports it rather than throwing the whole page away.
    const refused = importPage(db, BINDING, [item({ externalId: "LIN-9", priority: "low" })], { disposition: {}, kind: {}, severity: { low: "nonexistent" } });
    expect(refused).toMatchObject({ imported: 0, updated: 0, failed: 1 });
    close();
  });

  test("a sub-second newer revision is ingested, not skipped by string order", async () => {
    const { db, close } = await store("instant-order");
    importPage(db, BINDING, [item()]);
    const localId = (db.prepare("select id from issues where external_id = 'LIN-1'").get() as { id: string }).id;
    // "…00.500Z" sorts BELOW "…00Z" as a string but is a LATER instant.
    const later = item({ title: "Sub-second change", updatedAt: "2026-10-31T00:00:00.500Z" });
    expect(importPage(db, BINDING, [later])).toEqual({ imported: 0, updated: 1, skipped: 0, failed: 0 });
    expect((db.prepare("select title from issues where id = ?").get(localId) as { title: string }).title).toBe("Sub-second change");
    close();
  });

  test("a stale page replayed over a pending row mirrors nothing and does not walk backwards", async () => {
    const { db, close } = await store("stale-pending");
    importPage(db, BINDING, [item()]);
    const localId = (db.prepare("select id from issues where external_id = 'LIN-1'").get() as { id: string }).id;
    // Open a re-plan cycle for a NEWER revision, then replay the OLD page.
    const { replanItem } = await import("../issue-sync.js");
    replanItem(db, {
      bindingId: BINDING, direction: "import", localId,
      externalId: "LIN-1", remoteUpdatedAt: "2026-12-01T00:00:00.000Z", operationId: "op-stale-replan",
    });
    expect(importPage(db, BINDING, [item({ title: "Older content" })])).toEqual({
      imported: 0, updated: 0, skipped: 1, failed: 0,
    });
    const row = db.prepare("select title from issues where id = ?").get(localId) as { title: string };
    expect(row.title).toBe("Remote title");
    expect(readItem(db, { bindingId: BINDING, direction: "import", localId })).toMatchObject({
      itemState: "applied",
      lastRemoteUpdatedAt: "2026-12-01T00:00:00.000Z",
    });
    close();
  });

  test("a local capture never appends an occurrence to a mirrored row", async () => {
    const { db, close } = await store("symmetry");
    importPage(db, BINDING, [item()]);
    const before = db.prepare("select revision from issues where external_id = 'LIN-1'").get();
    const { captureIssueOn } = await import("../issue.js");
    // The reserved triple the ingest uses, reached through the ordinary capture
    // path: refusing here is the other half of the identity invariant.
    const attempt = () =>
      captureIssueOn(
        db,
        {
          projectId: PROJECT, title: "Local capture", kind: "bug", severity: "low",
          impact: "impact", acceptance: "acceptance",
          sourceIdentity: "linear:LIN-1", rootCauseKey: IMPORTED_ROOT_CAUSE_KEY, acceptanceKey: IMPORTED_ACCEPTANCE_KEY,
          occurrenceKey: "linear:LIN-1-other", sourceKind: "local", location: "here",
          observedBehavior: "seen", evidence: [], discoveredAt: "2026-11-01T00:00:00.000Z",
        },
        { operationId: "op-symmetry", actor: "project-manager" },
      );
    expect(attempt).toThrow(/issue\.scope-refused/);
    expect(db.prepare("select revision from issues where external_id = 'LIN-1'").get()).toEqual(before);
    close();
  });

  test("an unmappable binding id is refused sync.invalid-input", async () => {
    const { db, close } = await store("binding-shape");
    expect(() => importPage(db, "jira:p-mirror", [item()])).toThrow(SyncError);
    try {
      importPage(db, "jira:p-mirror", [item()]);
    } catch (error) {
      expect((error as SyncError).code).toBe("sync.invalid-input");
    }
    close();
  });
});
