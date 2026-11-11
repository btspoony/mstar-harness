/**
 * push.test.ts — SDD task 2, brief cases (a)-(g2): the push ledger protocol and
 * ambiguous-create recovery.
 *
 * Everything here runs against a REAL store (the ledger is SQL) and a fixture
 * provider (no transport, no credential). Run with
 * `bun test packages/engine/src/issue-sync/push.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { initializeStore, openStore, type StoreDb } from "../store-db.js";
import type { IssueKind, Severity } from "../issue.js";
import { acquireRun, claimItem, planItem, readItem, releaseRun } from "../issue-sync.js";
import type { IssueProvider, ProviderPage, ProviderWrite, ProviderWriteReceipt } from "./provider.js";
import {
  adoptItem,
  correlationMarker,
  externalIdOf,
  reconcilePendingCreate,
  pushItem,
  requestHash,
  selectPushCandidates,
  type PushContext,
} from "./push.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-push-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const PROJECT = "p-push";
const BINDING = `linear:${PROJECT}`;
const STORE_ID = "store-alpha";

async function openedStore(name: string): Promise<{ db: StoreDb; harnessDir: string; close: () => void }> {
  const harnessDir = mkdtempSync(join(ROOT, name));
  const handle = await initializeStore({ harnessDir });
  const db = handle.db;
  db.prepare(
    "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', ?, 'Push', 'projects', ?, 'now', 'now')",
  ).run(PROJECT, `${PROJECT}/roadmap.md`);
  return { db, harnessDir, close: () => handle.close() };
}

function addIssue(
  db: StoreDb,
  id: string,
  overrides: Partial<{ kind: IssueKind; severity: Severity; disposition: string; title: string }> = {},
): void {
  db.prepare(
    "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)" +
      " values (?, ?, ?, ?, ?, ?, 'impact body', 'acceptance body', 'now', 'now', ?)",
  ).run(
    id,
    PROJECT,
    overrides.title ?? `Issue ${id}`,
    overrides.kind ?? "bug",
    overrides.severity ?? "high",
    overrides.disposition ?? "open",
    `sync-issue-${id}`,
  );
}

type Fake = IssueProvider & {
  writes: ProviderWrite[];
  listings: Array<string | null>;
  /** Scripted receipts, one per write; a missing entry confirms with a fresh id. */
  receipts?: ProviderWriteReceipt[];
};

function provider(options: { pages?: ProviderPage[]; receipts?: ProviderWriteReceipt[] } = {}): Fake {
  const writes: ProviderWrite[] = [];
  const listings: Array<string | null> = [];
  const pages = [...(options.pages ?? [])];
  let created = 0;
  return {
    writes,
    listings,
    async probe() {
      return { state: "ready", cause: "ready: fixture" };
    },
    async listIssues(cursor) {
      listings.push(cursor);
      const page = pages.shift();
      if (page === undefined) return { items: [], nextCursor: null };
      return page;
    },
    async applyWrite(write) {
      writes.push(write);
      const scripted = options.receipts?.shift();
      if (scripted !== undefined) return scripted;
      // An update confirms the identity it was given; only a create mints one.
      if (write.kind === "update") return { kind: "confirmed", externalId: write.externalId, updatedAt: "2026-11-02T00:00:00.000Z" };
      created++;
      return { kind: "confirmed", externalId: `LIN-${created}`, updatedAt: "2026-11-02T00:00:00.000Z" };
    },
  };
}

function context(overrides: Partial<PushContext> = {}): PushContext {
  return {
    bindingId: BINDING,
    binding: { workspace: "acme", team: "ENG" },
    storeId: STORE_ID,
    labels: new Set(["bug", "risk", "improvement", "request", "decision", "review-obligation"]),
    states: new Set(["Todo", "Done", "Canceled"]),
    ...overrides,
  };
}

function candidates(db: StoreDb) {
  return selectPushCandidates(db, BINDING);
}

function row(db: StoreDb, localId: string) {
  return readItem(db, { bindingId: BINDING, direction: "push", localId });
}

/** One captured write, narrowed to the variant the test is asserting on. */
function writeOf(fake: Fake, index: number, kind: ProviderWrite["kind"]): ProviderWrite {
  const write = fake.writes[index];
  if (write === undefined) throw new Error(`no write at index ${index}; captured ${fake.writes.length}`);
  expect(write.kind).toBe(kind);
  return write;
}

/**
 * A provider whose create stays inside the provider call until `release()`.
 *
 * `started` settles once the write is captured and the call is about to wait, so
 * a test observes the in-flight attempt by awaiting a real signal instead of a
 * guessed delay. That state — the write sent, nothing confirmed yet — is the
 * network-sized window another run can enter.
 */
function writeInFlight(): { fake: Fake; started: Promise<void>; release: () => void } {
  const writes: ProviderWrite[] = [];
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  return {
    started,
    release,
    fake: {
      writes,
      listings: [],
      async probe() {
        return { state: "ready", cause: "ready: fixture" };
      },
      async listIssues() {
        return { items: [], nextCursor: null };
      },
      async applyWrite(write) {
        writes.push(write);
        markStarted();
        await held;
        return { kind: "confirmed", externalId: "LIN-1", updatedAt: "2026-11-02T00:00:00.000Z" };
      },
    },
  };
}

/**
 * A db whose FIRST `issue_sync_state` read returns `stale` instead of the store's
 * row: the view a run has when it reads the ledger before a concurrent claim
 * commits. Later reads (the claim's own, which must see the real row) pass
 * through, so the race is reproduced deterministically instead of in prose.
 */
function staleFirstLedgerRead(db: StoreDb, stale: unknown): StoreDb {
  let armed = true;
  return {
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      if (armed && sql.includes("from issue_sync_state")) {
        return {
          get: (...args: unknown[]) => {
            if (!armed) return stmt.get(...(args as never[]));
            armed = false;
            return stale;
          },
          all: (...args: unknown[]) => stmt.all(...(args as never[])),
          run: (...args: unknown[]) => stmt.run(...(args as never[])),
        };
      }
      return stmt;
    },
  } as unknown as StoreDb;
}

describe("selectPushCandidates", () => {
  test("only this project's local captures are candidates; imported mirrors never echo back", async () => {
    const { db, close } = await openedStore("candidates");
    try {
      addIssue(db, "I-000901");
      addIssue(db, "I-000902");
      db.prepare("update issues set provider = 'linear', external_id = 'LIN-9' where id = 'I-000902'").run();
      expect(candidates(db).map((candidate) => candidate.localId)).toEqual(["I-000901"]);
    } finally {
      close();
    }
  });
});

describe("(a) a confirmed create records identity and hash; a later change updates that id", () => {
  test("create -> applied with external_id and last_request_hash; changed title -> update on the same id", async () => {
    const { db, close } = await openedStore("confirmed-create");
    try {
      addIssue(db, "I-000911");
      const fake = provider();
      const ctx = context();
      const first = await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect(first).toMatchObject({ outcome: "created", externalId: "LIN-1" });
      const applied = row(db, "I-000911")!;
      expect(applied.itemState).toBe("applied");
      expect(applied.externalId).toBe("LIN-1");
      expect(applied.lastRequestHash).not.toBeNull();
      expect(applied.lastKindLabels).toEqual(["bug"]);

      db.prepare("update issues set title = 'Retitled' where id = 'I-000911'").run();
      const second = await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect(second).toMatchObject({ outcome: "updated", externalId: "LIN-1" });
      expect(fake.writes[1]).toMatchObject({ kind: "update", externalId: "LIN-1" });
      expect(writeOf(fake, 1, "update").payload.title).toBe("Retitled");
      // The identity never changes on update, and the hash follows the new payload.
      const updated = row(db, "I-000911")!;
      expect(updated.externalId).toBe("LIN-1");
    } finally {
      close();
    }
  });
});

describe("(b) an unchanged payload is skipped with zero write calls", () => {
  test("second identical push issues no write and leaves the ledger untouched", async () => {
    const { db, close } = await openedStore("skip");
    try {
      addIssue(db, "I-000921");
      const fake = provider();
      const ctx = context();
      await pushItem(db, fake, ctx, candidates(db)[0]!);
      const before = row(db, "I-000921")!;
      const second = await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect(second.outcome).toBe("skipped");
      expect(fake.writes).toHaveLength(1);
      expect(row(db, "I-000921")).toEqual(before);
    } finally {
      close();
    }
  });
});

describe("(c) an ambiguous create never becomes a duplicate", () => {
  test("the row stays pending without an external_id and no second create is issued in that run", async () => {
    const { db, close } = await openedStore("ambiguous");
    try {
      addIssue(db, "I-000931");
      const fake = provider({ receipts: [{ kind: "ambiguous", cause: "timeout after the request was sent" }] });
      const ctx = context();
      const outcome = await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect(outcome.outcome).toBe("unresolved");
      expect(outcome.cause).toContain("timeout");
      const ledger = row(db, "I-000931")!;
      expect(ledger.itemState).toBe("pending");
      expect(ledger.externalId).toBeNull();
      expect(fake.writes).toHaveLength(1);

      // Same run, pushed again: the pending row is ambiguous residue, so it is
      // never re-created — it waits for reconciliation.
      const again = await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect(again.outcome).toBe("unresolved");
      expect(fake.writes).toHaveLength(1);
    } finally {
      close();
    }
  });
});

describe("(c2) reconciliation costs nothing when there is no ambiguous residue", () => {
  test("a store with no pending push row issues ZERO listing calls", async () => {
    const { db, close } = await openedStore("no-listing");
    try {
      addIssue(db, "I-000941");
      const fake = provider();
      const ctx = context();
      await pushItem(db, fake, ctx, candidates(db)[0]!);
      const report = await reconcilePendingCreate(db, fake, ctx);
      expect(report).toEqual({ adopted: [], unresolved: [] });
      expect(fake.listings).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("(d) ambiguous creates are adopted by correlation marker only", () => {
  const markerOf = (storeId: string): string => correlationMarker({ workspace: "acme", team: "ENG" }, storeId, "I-000951");

  async function ambiguous(db: StoreDb): Promise<void> {
    addIssue(db, "I-000951");
    const fake = provider({ receipts: [{ kind: "ambiguous", cause: "connection closed mid-call" }] });
    await pushItem(db, fake, context(), candidates(db)[0]!);
    expect(row(db, "I-000951")!.itemState).toBe("pending");
  }

  test("exactly one marker match is adopted, then the normal update path applies", async () => {
    const { db, close } = await openedStore("adopt-unique");
    try {
      await ambiguous(db);
      const fake = provider({
        pages: [
          {
            items: [
              {
                externalId: "LIN-77",
                title: "Something else entirely",
                description: `pushed body\n\n${markerOf(STORE_ID)}`,
                state: "Todo",
                priority: "High",
                labels: [],
                updatedAt: "2026-11-02T00:00:00.000Z",
                url: "https://linear.app/acme/issue/LIN-77",
              },
            ],
            nextCursor: null,
          },
        ],
      });
      const report = await reconcilePendingCreate(db, fake, context());
      expect(report.adopted).toEqual([{ localId: "I-000951", externalId: "LIN-77" }]);
      expect(row(db, "I-000951")).toMatchObject({ itemState: "applied", externalId: "LIN-77" });
      expect(fake.writes).toEqual([]);
    } finally {
      close();
    }
  });

  test("a marker from a DIFFERENT store id never matches", async () => {
    const { db, close } = await openedStore("adopt-other-store");
    try {
      await ambiguous(db);
      const fake = provider({
        pages: [
          {
            items: [
              {
                externalId: "LIN-88",
                title: "Issue I-000951",
                description: `pushed body\n\n${markerOf("store-beta")}`,
                state: "Todo",
                priority: "High",
                labels: [],
                updatedAt: "2026-11-02T00:00:00.000Z",
                url: "https://linear.app/acme/issue/LIN-88",
              },
            ],
            nextCursor: null,
          },
        ],
      });
      const report = await reconcilePendingCreate(db, fake, context());
      expect(report.adopted).toEqual([]);
      expect(report.unresolved).toHaveLength(1);
      expect(row(db, "I-000951")).toMatchObject({ itemState: "pending", externalId: null });
    } finally {
      close();
    }
  });

  test("a unique title+description match WITHOUT the marker stays unresolved: prose is never identity", async () => {
    const { db, close } = await openedStore("adopt-prose");
    try {
      await ambiguous(db);
      const fake = provider({
        pages: [
          {
            items: [
              {
                externalId: "LIN-99",
                title: "Issue I-000951",
                description: "## Impact\n\nimpact body\n\n## Acceptance\n\nacceptance body",
                state: "Todo",
                priority: "High",
                labels: [],
                updatedAt: "2026-11-02T00:00:00.000Z",
                url: "https://linear.app/acme/issue/LIN-99",
              },
            ],
            nextCursor: null,
          },
        ],
      });
      const report = await reconcilePendingCreate(db, fake, context());
      expect(report.adopted).toEqual([]);
      expect(report.unresolved).toHaveLength(1);
      expect(row(db, "I-000951")).toMatchObject({ itemState: "pending", externalId: null });
    } finally {
      close();
    }
  });

  for (const [label, count] of [
    ["zero", 0],
    ["multiple", 2],
  ] as const) {
    test(`${label} marker matches stay unresolved and never create`, async () => {
      const { db, close } = await openedStore(`adopt-${label}`);
      try {
        await ambiguous(db);
        const items = Array.from({ length: count }, (_, index) => ({
          externalId: `LIN-${index + 1}`,
          title: "t",
          description: `body\n\n${markerOf(STORE_ID)}`,
          state: "Todo",
          priority: "High",
          labels: [],
          updatedAt: "2026-11-02T00:00:00.000Z",
          url: `https://linear.app/acme/issue/LIN-${index + 1}`,
        }));
        const fake = provider({ pages: [{ items, nextCursor: null }] });
        const report = await reconcilePendingCreate(db, fake, context());
        expect(report.adopted).toEqual([]);
        expect(report.unresolved).toHaveLength(1);
        expect(fake.writes).toEqual([]);
        expect(row(db, "I-000951")).toMatchObject({ itemState: "pending", externalId: null });
      } finally {
        close();
      }
    });
  }
});

describe("(e) a refused write is a retryable failure", () => {
  test("failed with linear.write-refused, then the next run retries the create", async () => {
    const { db, close } = await openedStore("refused");
    try {
      addIssue(db, "I-000961");
      const fake = provider({ receipts: [{ kind: "refused", code: "linear.write-refused", cause: "HTTP 400" }] });
      const ctx = context();
      const first = await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect(first.outcome).toBe("failed");
      const failedRow = row(db, "I-000961")!;
      expect(failedRow.itemState).toBe("failed");
      expect(failedRow.externalId).toBeNull();
      expect(failedRow.lastError).toContain("linear.write-refused");

      // Only a refusal writes `failed`, so delivery was never confirmed: the
      // next run retries the create.
      const second = await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect(second).toMatchObject({ outcome: "created", externalId: "LIN-1" });
      expect(row(db, "I-000961")!.itemState).toBe("applied");
    } finally {
      close();
    }
  });

  test("a refused UPDATE records its cause on the applied row without wedging the retry", async () => {
    const { db, close } = await openedStore("refused-update");
    try {
      addIssue(db, "I-000962");
      const ctx = context();
      // A confirmed create first, so the row is `applied` WITH an identity.
      await pushItem(db, provider(), ctx, candidates(db)[0]!);
      expect(row(db, "I-000962")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });

      // A changed title turns the next attempt into an update; the provider
      // refuses it (an HTTP 4xx is provably not delivered).
      db.prepare("update issues set title = 'Retitled' where id = ?").run("I-000962");
      const fake = provider({ receipts: [{ kind: "refused", code: "linear.write-refused", cause: "HTTP 400" }] });
      const refused = await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect(refused.outcome).toBe("failed");
      expect(refused.cause).toContain("linear.write-refused");

      // `applied → failed` is not in the contract, so the row keeps its state,
      // its identity and its proof — but the cause is now ON the row instead of
      // existing only in that run's stdout.
      const afterRefusal = row(db, "I-000962")!;
      expect(afterRefusal).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
      expect(afterRefusal.lastError).toContain("linear.write-refused");

      // And the retry succeeds instead of throwing `sync.illegal-transition`.
      const retried = await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect(retried).toMatchObject({ outcome: "updated", externalId: "LIN-1" });
      const settled = row(db, "I-000962")!;
      expect(settled.itemState).toBe("applied");
      expect(settled.lastError).toBeNull();
      // The refusal was the first write this provider saw; the retry is the second.
      expect(fake.writes.map((write) => write.kind)).toEqual(["update", "update"]);
      expect(writeOf(fake, 1, "update").payload.title).toBe("Retitled");
    } finally {
      close();
    }
  });
});

describe("(f) the operator verbs reach the ledger through the same verbs", () => {
  test("--adopt records the identity from an issue URL without a write", async () => {
    const { db, close } = await openedStore("adopt-verb");
    try {
      addIssue(db, "I-000971");
      const applied = adoptItem(db, BINDING, "I-000971", "https://linear.app/acme/issue/LIN-123/some-slug");
      expect(applied).toMatchObject({ itemState: "applied", externalId: "LIN-123" });
      expect(row(db, "I-000971")!.externalId).toBe("LIN-123");
      // The next push converges content onto the adopted id.
      const fake = provider();
      const outcome = await pushItem(db, fake, context(), candidates(db)[0]!);
      expect(outcome).toMatchObject({ outcome: "updated", externalId: "LIN-123" });
    } finally {
      close();
    }
  });

  test("a reference that is not a Linear URL is refused by name", () => {
    expect(externalIdOf("LIN-5")).toBe("LIN-5");
    expect(() => externalIdOf("https://example.test/acme/issue/LIN-5")).toThrow(/not a Linear host/);
  });
});

describe("(f3) adopting a different issue drops the previous issue's proof", () => {
  test("unchanged content is NOT skipped after adopting an applied row onto another issue", async () => {
    const { db, close } = await openedStore("adopt-other-issue");
    try {
      addIssue(db, "I-000981");
      // A confirmed create leaves an applied row whose hash proves what LIN-1 says.
      const first = provider();
      await pushItem(db, first, context(), candidates(db)[0]!);
      const applied = row(db, "I-000981")!;
      expect(applied).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
      const hashBefore = applied.lastRequestHash;
      expect(hashBefore).not.toBeNull();

      // The operator points the item at LIN-2 instead. Nothing local changed, so
      // carrying the hash forward would let this run report `skipped` for content
      // LIN-2 never received.
      const adopted = adoptItem(db, BINDING, "I-000981", "LIN-2", { force: true });
      expect(adopted).toMatchObject({ itemState: "applied", externalId: "LIN-2", lastRequestHash: null });

      const second = provider();
      const outcome = await pushItem(db, second, context(), candidates(db)[0]!);
      expect(outcome).toMatchObject({ outcome: "updated", externalId: "LIN-2" });
      expect(second.writes.map((write) => write.kind)).toEqual(["update"]);
    } finally {
      close();
    }
  });

  test("re-adopting the SAME issue keeps its recorded proof, so the kind change still removes the old label", async () => {
    const { db, close } = await openedStore("adopt-same-issue");
    try {
      addIssue(db, "I-000984", { kind: "bug" });
      await pushItem(db, provider(), context(), candidates(db)[0]!);
      const before = row(db, "I-000984")!;
      expect(before.externalId).toBe("LIN-1");
      expect(before.lastKindLabels).toEqual(["bug"]);
      const hashBefore = before.lastRequestHash;
      expect(hashBefore).not.toBeNull();

      // The operator re-confirms the SAME issue after changing the kind. That
      // recorded ownership still describes this remote issue, so the update that
      // adds `risk` has to remove `bug` too.
      db.prepare("update issues set kind = 'risk' where id = ?").run("I-000984");
      const adopted = adoptItem(db, BINDING, "I-000984", "LIN-1");
      expect(adopted).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
      expect(adopted.lastKindLabels).toEqual(["bug"]);

      const fake = provider();
      const outcome = await pushItem(db, fake, context(), candidates(db)[0]!);
      expect(outcome).toMatchObject({ outcome: "updated", externalId: "LIN-1" });
      const update = writeOf(fake, 0, "update").payload;
      expect(update.labels).toEqual(["risk"]);
      expect(update.removeLabels).toEqual(["bug"]);
      expect(row(db, "I-000984")!.lastKindLabels).toEqual(["risk"]);
    } finally {
      close();
    }
  });

  test("a later kind change removes only labels this identity owns", async () => {
    const { db, close } = await openedStore("adopt-ownership");
    try {
      addIssue(db, "I-000982");
      await pushItem(db, provider(), context(), candidates(db)[0]!);
      expect(row(db, "I-000982")!.lastKindLabels).toEqual(["bug"]);

      // Adoption onto a different issue forgets that ownership too: the old
      // label belongs to LIN-1, so replacing the kind must not remove it from
      // LIN-2.
      adoptItem(db, BINDING, "I-000982", "LIN-2", { force: true });
      expect(row(db, "I-000982")!.lastKindLabels).toEqual([]);

      db.prepare("update issues set kind = 'risk' where id = ?").run("I-000982");
      const fake = provider();
      await pushItem(db, fake, context(), candidates(db)[0]!);
      const update = writeOf(fake, 0, "update");
      expect(update.payload.removeLabels).toBeUndefined();
      expect(update.payload.labels).toEqual(["risk"]);
      expect(row(db, "I-000982")!.lastKindLabels).toEqual(["risk"]);
    } finally {
      close();
    }
  });

  test("a forced re-point back to a previously held issue is a new operation, so the row follows it", async () => {
    const { db, close } = await openedStore("adopt-repoint");
    try {
      addIssue(db, "I-000985");
      expect(adoptItem(db, BINDING, "I-000985", "LIN-1").externalId).toBe("LIN-1");
      expect(adoptItem(db, BINDING, "I-000985", "LIN-2", { force: true }).externalId).toBe("LIN-2");
      // Back to LIN-1. The request repeats the FIRST adoption's binding, local
      // id, external id and proof-clearing flag, so only the operation identity
      // can tell them apart; replaying that receipt would leave the row on LIN-2
      // while the caller reports LIN-1.
      expect(adoptItem(db, BINDING, "I-000985", "LIN-1", { force: true }).externalId).toBe("LIN-1");
      expect(row(db, "I-000985")!.externalId).toBe("LIN-1");
    } finally {
      close();
    }
  });

  test("replacing an already-recorded identity is refused unless the operator forces it", async () => {
    const { db, close } = await openedStore("adopt-fresh");
    try {
      addIssue(db, "I-000983");
      const first = adoptItem(db, BINDING, "I-000983", "LIN-1");
      expect(first.externalId).toBe("LIN-1");
      expect(() => adoptItem(db, BINDING, "I-000983", "LIN-2")).toThrow(/sync\.identity-conflict/);
      expect(row(db, "I-000983")!.externalId).toBe("LIN-1");
      // Re-adopting the SAME id is not a replacement.
      expect(adoptItem(db, BINDING, "I-000983", "LIN-1").externalId).toBe("LIN-1");
      expect(adoptItem(db, BINDING, "I-000983", "LIN-2", { force: true }).externalId).toBe("LIN-2");
    } finally {
      close();
    }
  });
});

describe("(g) kind labels are resolved against the discovered set, never created", () => {
  test("a present label is sent as addLabels; an absent one refuses only that item", async () => {
    const { db, close } = await openedStore("labels");
    try {
      addIssue(db, "I-000981", { kind: "bug" });
      addIssue(db, "I-000982", { kind: "risk" });
      const fake = provider();
      // `risk` is genuinely absent from this workspace's label set.
      const ctx = context({ labels: new Set(["bug"]) });
      const [first, second] = candidates(db);
      const ok = await pushItem(db, fake, ctx, first!);
      expect(ok.outcome).toBe("created");
      expect(writeOf(fake, 0, "create").payload.labels).toEqual(["bug"]);

      const refused = await pushItem(db, fake, ctx, second!);
      expect(refused.outcome).toBe("failed");
      expect(refused.cause).toContain("linear.label-unresolved");
      expect(refused.cause).toContain('"risk"');
      expect(fake.writes).toHaveLength(1);
      // The failing item never wrote a label, so no ownership is claimed for it.
      expect(row(db, "I-000982")!.lastKindLabels).toEqual([]);
    } finally {
      close();
    }
  });
});

describe("(g2) a changed kind replaces exactly the label mstar recorded", () => {
  test("removeLabels carries the recorded label and addLabels the new one", async () => {
    const { db, close } = await openedStore("label-replace");
    try {
      addIssue(db, "I-000991", { kind: "bug" });
      const fake = provider();
      const ctx = context();
      await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect(row(db, "I-000991")!.lastKindLabels).toEqual(["bug"]);

      db.prepare("update issues set kind = 'risk' where id = 'I-000991'").run();
      await pushItem(db, fake, ctx, candidates(db)[0]!);
      const update = writeOf(fake, 1, "update").payload;
      expect(update.labels).toEqual(["risk"]);
      expect(update.removeLabels).toEqual(["bug"]);
      expect(row(db, "I-000991")!.lastKindLabels).toEqual(["risk"]);
    } finally {
      close();
    }
  });

  test("a row with NO recorded label only adds: ownership unknown means no removal", async () => {
    const { db, close } = await openedStore("label-add-only");
    try {
      addIssue(db, "I-000992", { kind: "bug" });
      const fake = provider();
      adoptItem(db, BINDING, "I-000992", "LIN-42");
      expect(row(db, "I-000992")!.lastKindLabels).toEqual([]);
      await pushItem(db, fake, context(), candidates(db)[0]!);
      const update = writeOf(fake, 0, "update").payload;
      expect(update.labels).toEqual(["bug"]);
      expect(update.removeLabels).toBeUndefined();
    } finally {
      close();
    }
  });
});

describe("(f2) --adopt recovers an actual ambiguous residue", () => {
  test("a pending row with no identity is adopted directly, never refused as an illegal transition", async () => {
    const { db, close } = await openedStore("adopt-pending-residue");
    try {
      addIssue(db, "I-001021");
      const ambiguous = provider({ receipts: [{ kind: "ambiguous", cause: "connection closed mid-call" }] });
      await pushItem(db, ambiguous, context(), candidates(db)[0]!);
      expect(row(db, "I-001021")).toMatchObject({ itemState: "pending", externalId: null });

      const adopted = adoptItem(db, BINDING, "I-001021", "https://linear.app/acme/issue/LIN-321/slug");
      expect(adopted).toMatchObject({ itemState: "applied", externalId: "LIN-321" });

      // Content then converges onto the adopted identity: one update, no create.
      const after = provider();
      const converged = await pushItem(db, after, context(), candidates(db)[0]!);
      expect(converged).toMatchObject({ outcome: "updated", externalId: "LIN-321" });
      expect(after.writes.map((write) => write.kind)).toEqual(["update"]);
    } finally {
      close();
    }
  });
});

describe("(h) a label preflight failure never erases an earlier ambiguous create", () => {
  test("ambiguous create, zero marker matches, label unavailable, restored: retry creates nothing", async () => {
    const { db, close } = await openedStore("label-vs-ambiguity");
    try {
      addIssue(db, "I-001001", { kind: "risk" });
      const ambiguous = provider({ receipts: [{ kind: "ambiguous", cause: "connection closed mid-call" }] });
      const available = context();
      await pushItem(db, ambiguous, available, candidates(db)[0]!);
      expect(row(db, "I-001001")).toMatchObject({ itemState: "pending", externalId: null });

      // Reconciliation finds no marker: the create stays unattributed.
      const scanned = provider();
      const report = await reconcilePendingCreate(db, scanned, available);
      expect(report.unresolved).toHaveLength(1);

      // The mapped label is unavailable now. That says nothing about whether the
      // earlier create was delivered, so the residue must survive it untouched.
      const missingLabel = context({ labels: new Set(["bug"]) });
      const blocked = await pushItem(db, ambiguous, missingLabel, candidates(db)[0]!);
      expect(blocked.outcome).toBe("unresolved");
      expect(blocked.externalId).toBeNull();
      expect(row(db, "I-001001")).toMatchObject({ itemState: "pending", externalId: null, lastError: null });
      expect(ambiguous.writes).toHaveLength(1);

      // Label restored: the row is still ambiguous residue, so it is NOT retried.
      const retried = await pushItem(db, ambiguous, available, candidates(db)[0]!);
      expect(retried.outcome).toBe("unresolved");
      expect(ambiguous.writes).toHaveLength(1);
      expect(row(db, "I-001001")).toMatchObject({ itemState: "pending", externalId: null });
    } finally {
      close();
    }
  });
});

describe("(i) an ambiguous update drops the payload proof but keeps the identity", () => {
  test("confirm A, send B, ambiguous, local back to A: the next push converges instead of skipping", async () => {
    const { db, close } = await openedStore("ambiguous-update");
    try {
      addIssue(db, "I-001011", { title: "A" });
      // Explicit scripts: create confirms, the B update goes ambiguous, the
      // corrective update confirms on the same id.
      const scripted = provider({
        receipts: [
          { kind: "confirmed", externalId: "LIN-1", updatedAt: "2026-11-02T00:00:00.000Z" },
          { kind: "ambiguous", cause: "timeout after the request was sent" },
          { kind: "confirmed", externalId: "LIN-1", updatedAt: "2026-11-02T00:10:00.000Z" },
        ],
      });
      const ctx = context();
      const created = await pushItem(db, scripted, ctx, candidates(db)[0]!);
      expect(created).toMatchObject({ outcome: "created", externalId: "LIN-1" });
      const hashOfA = row(db, "I-001011")!.lastRequestHash;
      expect(hashOfA).not.toBeNull();

      db.prepare("update issues set title = 'B' where id = 'I-001011'").run();
      const sent = await pushItem(db, scripted, ctx, candidates(db)[0]!);
      expect(sent.outcome).toBe("unresolved");
      // The identity survived; the proof that the remote says A did not.
      const afterAmbiguous = row(db, "I-001011")!;
      expect(afterAmbiguous.externalId).toBe("LIN-1");
      expect(afterAmbiguous.itemState).toBe("applied");
      expect(afterAmbiguous.lastRequestHash).toBeNull();

      db.prepare("update issues set title = 'A' where id = 'I-001011'").run();
      const converged = await pushItem(db, scripted, ctx, candidates(db)[0]!);
      expect(converged).toMatchObject({ outcome: "updated", externalId: "LIN-1" });
      expect(writeOf(scripted, 2, "update").payload.title).toBe("A");
    } finally {
      close();
    }
  });

  test("an ambiguous kind change that did NOT land still converges: the remote ends with exactly the new label", async () => {
    const { db, close } = await openedStore("ambiguous-label-not-applied");
    try {
      addIssue(db, "I-001013", { kind: "bug", title: "A" });
      // A remote that really holds the labels the writes applied. The ambiguous
      // second write is one that never landed, which its receipt cannot say.
      const remote = new Set<string>();
      const writes: ProviderWrite[] = [];
      const outcomes: ProviderWriteReceipt[] = [
        { kind: "confirmed", externalId: "LIN-1", updatedAt: "2026-11-02T00:00:00.000Z" },
        { kind: "ambiguous", cause: "timeout after the request was sent" },
        { kind: "confirmed", externalId: "LIN-1", updatedAt: "2026-11-02T00:10:00.000Z" },
      ];
      const fake: IssueProvider = {
        async probe() {
          return { state: "ready", cause: "ready: fixture" };
        },
        async listIssues() {
          return { items: [], nextCursor: null };
        },
        async applyWrite(write) {
          writes.push(write);
          const outcome = outcomes.shift()!;
          if (outcome.kind === "confirmed") {
            for (const label of write.payload.removeLabels ?? []) remote.delete(label);
            for (const label of write.payload.labels ?? []) remote.add(label);
          }
          return outcome;
        },
      };

      const ctx = context();
      await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect([...remote]).toEqual(["bug"]);

      // The change to `risk` is sent and does not land; both labels are now
      // possibly on the remote, so both stay owned.
      db.prepare("update issues set kind = 'risk' where id = 'I-001013'").run();
      expect((await pushItem(db, fake, ctx, candidates(db)[0]!)).outcome).toBe("unresolved");
      expect([...remote]).toEqual(["bug"]);
      expect(row(db, "I-001013")!.lastKindLabels).toEqual(["bug", "risk"]);

      // Retry with the local kind unchanged: `bug` is the label the remote
      // actually kept, so the corrective update has to remove it.
      expect((await pushItem(db, fake, ctx, candidates(db)[0]!)).outcome).toBe("updated");
      expect(writes[2]!.payload.removeLabels).toEqual(["bug"]);
      expect([...remote]).toEqual(["risk"]);
      expect(row(db, "I-001013")!.lastKindLabels).toEqual(["risk"]);

      // Converged: the following pass skips because nothing changed, which the
      // remote now really reflects.
      expect((await pushItem(db, fake, ctx, candidates(db)[0]!)).outcome).toBe("skipped");
      expect(writes).toHaveLength(3);
      expect([...remote]).toEqual(["risk"]);
    } finally {
      close();
    }
  });

  test("a kind-label change during the unconfirmed update stays owned, so the corrective update replaces it", async () => {
    const { db, close } = await openedStore("ambiguous-update-label");
    try {
      addIssue(db, "I-001012", { kind: "bug", title: "A" });
      const scripted = provider({
        receipts: [
          { kind: "confirmed", externalId: "LIN-1", updatedAt: "2026-11-02T00:00:00.000Z" },
          { kind: "ambiguous", cause: "dropped" },
          { kind: "confirmed", externalId: "LIN-1", updatedAt: "2026-11-02T00:10:00.000Z" },
        ],
      });
      const ctx = context();
      await pushItem(db, scripted, ctx, candidates(db)[0]!);
      db.prepare("update issues set kind = 'risk' where id = 'I-001012'").run();
      await pushItem(db, scripted, ctx, candidates(db)[0]!);
      expect(row(db, "I-001012")!.lastKindLabels).toEqual(["bug", "risk"]);
      // Back to bug: the possibly-delivered `risk` label is the one to replace.
      db.prepare("update issues set kind = 'bug' where id = 'I-001012'").run();
      await pushItem(db, scripted, ctx, candidates(db)[0]!);
      const corrective = writeOf(scripted, 2, "update").payload;
      expect(corrective.labels).toEqual(["bug"]);
      expect(corrective.removeLabels).toEqual(["risk"]);
    } finally {
      close();
    }
  });
});

describe("(j) an unresolved create blocks every later create until reconcile attributes it", () => {
  test("a run over the residue sends nothing, names its recoveries, and leaves reconcile able to adopt", async () => {
    const { db, close } = await openedStore("unresolved-residue");
    try {
      addIssue(db, "I-001031", { kind: "risk" });
      const ctx = context();
      // 1. An ambiguous create leaves the residue: pending, no id.
      const ambiguous = provider({ receipts: [{ kind: "ambiguous", cause: "connection closed mid-call" }] });
      await pushItem(db, ambiguous, ctx, candidates(db)[0]!);
      expect(row(db, "I-001031")).toMatchObject({ itemState: "pending", externalId: null });

      // 2. Nothing can act on it. The row it reads may belong to a create still
      //    inside its provider call — its claim is what advanced the revision — so
      //    "the remote issue does not exist" is not an assertion anybody can
      //    establish from this state. The report names the recoveries instead of
      //    sending a second create.
      const again = provider();
      const blocked = await pushItem(db, again, context(), candidates(db)[0]!);
      expect(blocked.outcome).toBe("unresolved");
      expect(blocked.cause).toContain("--adopt <localId>=<issueUrl|externalId>");
      expect(blocked.cause).toContain("--release <localId>");
      expect(again.writes).toEqual([]);
      // The residue survives as an AMBIGUITY: still pending, still no id.
      expect(row(db, "I-001031")).toMatchObject({ itemState: "pending", externalId: null });

      // 3. Reconciliation still finds it: one marker match adopts the interrupted
      //    create, which is the recovery the refusal named.
      const marker = correlationMarker({ workspace: "acme", team: "ENG" }, STORE_ID, "I-001031");
      const scanning = provider({
        pages: [
          {
            items: [
              {
                externalId: "LIN-77",
                title: "Issue I-001031",
                description: `## Impact\n\nimpact body\n\n${marker}`,
                state: "Todo",
                priority: "2",
                labels: ["bug"],
                updatedAt: "2026-11-02T00:00:00.000Z",
                url: "https://linear.app/acme/issue/LIN-77",
              },
            ],
            nextCursor: null,
          },
        ],
      });
      const report = await reconcilePendingCreate(db, scanning, ctx);
      expect(report.adopted).toEqual([{ localId: "I-001031", externalId: "LIN-77" }]);
      expect(row(db, "I-001031")).toMatchObject({ itemState: "applied", externalId: "LIN-77" });
    } finally {
      close();
    }
  });

  test("a refusal on a row with NO ambiguity still records the retryable failed edge", async () => {
    const { db, close } = await openedStore("refusal-no-residue");
    try {
      addIssue(db, "I-001032", { kind: "risk" });
      // No prior attempt at all: the label preflight refuses before any write.
      const fake = provider();
      const refused = await pushItem(db, fake, context({ labels: new Set(["bug"]) }), candidates(db)[0]!);
      expect(refused.outcome).toBe("failed");
      expect(row(db, "I-001032")!.itemState).toBe("failed");
      expect(fake.writes).toEqual([]);
      // `failed → pending` is the legal retry edge, so the next run tries again.
      const retried = await pushItem(db, fake, context(), candidates(db)[0]!);
      expect(retried.outcome).toBe("created");
    } finally {
      close();
    }
  });
});

describe("(k) a stale ledger read cannot mint a second create for the same content", () => {
  const PLAN_OP = `linear-push:${BINDING}:I-001041:plan:hash:0`;
  const planInput = { bindingId: BINDING, direction: "push" as const, localId: "I-001041", operationId: PLAN_OP };

  test("only the first identical claim holds the send right; a replay of it does not", async () => {
    const { db, harnessDir, close } = await openedStore("claim-once");
    try {
      addIssue(db, "I-001041");
      // The second connection is opened BEFORE the first claim, so exclusivity
      // cannot come from one connection's in-process view: the two handles hold
      // independent connections to the same store file.
      const rival = await openStore({ harnessDir }, "write");
      try {
        // Two callers that derive the SAME operationId from content + revision.
        // `planItem` replays its receipt for both of them, which is exactly how
        // two concurrent pushes each concluded they owned the create.
        const first = claimItem(db, planInput);
        const second = claimItem(rival.db, planInput);
        expect(first.claimed).toBe(true);
        expect(second.claimed).toBe(false);
        // The loser is told what the ledger now holds, not what the winner's
        // receipt said, so it can act on the current row.
        expect(second.item).toEqual(first.item);
        // `planItem` keeps its idempotent-replay semantics for everyone else.
        expect(planItem(db, planInput)).toEqual(first.item);
        // The losing connection cannot turn the winner's residue into a second
        // create: the ledger row, not the caller's view, holds the send right.
        const loser = provider();
        const lost = await pushItem(rival.db, loser, context(), candidates(rival.db)[0]!);
        expect(lost).toMatchObject({ outcome: "unresolved", externalId: null });
        expect(loser.writes).toEqual([]);
      } finally {
        rival.close();
      }
    } finally {
      close();
    }
  });

  test("a push holding a stale ledger view cannot create beside an in-flight attempt", async () => {
    const { db, close } = await openedStore("claim-lost");
    try {
      addIssue(db, "I-001042");
      const ctx = context();
      const candidate = candidates(db)[0]!;

      // A provably-undelivered attempt leaves the retryable `failed` edge.
      const refused = provider({ receipts: [{ kind: "refused", code: "linear.write-refused", cause: "HTTP 400" }] });
      expect((await pushItem(db, refused, ctx, candidate)).outcome).toBe("failed");
      const preClaim = db
        .prepare("select * from issue_sync_state where binding_id = ? and direction = ? and local_id = ?")
        .get(BINDING, "push", "I-001042");
      expect(row(db, "I-001042")).toMatchObject({ itemState: "failed", externalId: null, revision: 2 });

      // The attempt claims and parks inside its provider call.
      const { fake: winner, started, release } = writeInFlight();
      const winnerRun = pushItem(db, winner, ctx, candidate);
      await started;

      // A caller holding the PRE-claim view derives the same claim key — the key
      // is a stable per-residue identity, not a per-attempt one — and the store
      // answers with the row that attempt already opened instead of a send
      // right. That is the residue guard's own backstop inside one process: the
      // run lease is what stops a second process from getting this far.
      const loser = provider();
      const lost = await pushItem(staleFirstLedgerRead(db, preClaim), loser, ctx, candidate);
      expect(lost).toMatchObject({ outcome: "unresolved", externalId: null });
      expect(lost.cause).toContain("could not take the send right");
      expect(loser.writes).toEqual([]);
      // Nothing else moved: the row is still the winner's unresolved create.
      expect(row(db, "I-001042")).toMatchObject({ itemState: "pending", externalId: null });

      release();
      expect(await winnerRun).toMatchObject({ outcome: "created", externalId: "LIN-1" });
      expect(winner.writes.filter((write) => write.kind === "create")).toHaveLength(1);
      expect(loser.writes).toEqual([]);
      expect(row(db, "I-001042")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
    } finally {
      close();
    }
  });
});

describe("(l) disposition -> state names are preflighted against the team, like labels", () => {
  test("a team without the mapped state refuses that item before the call, naming the mapping key", async () => {
    const { db, close } = await openedStore("state-preflight");
    try {
      addIssue(db, "I-001051", { disposition: "open" });
      addIssue(db, "I-001052", { disposition: "resolved" });
      // A team whose workflow renamed `Todo` to `Ready for Dev`.
      const fake = provider();
      const ctx = context({ states: new Set(["Ready for Dev", "Done", "Canceled"]) });
      const [first, second] = candidates(db);

      const refused = await pushItem(db, fake, ctx, first!);
      expect(refused.outcome).toBe("failed");
      expect(refused.cause).toContain("linear.state-unresolved");
      expect(refused.cause).toContain('"Todo"');
      expect(refused.cause).toContain("disposition.Todo");
      expect(fake.writes).toEqual([]);

      // The item whose state DOES exist proceeds: an unknown name refuses one item only.
      const ok = await pushItem(db, fake, ctx, second!);
      expect(ok.outcome).toBe("created");
      expect(writeOf(fake, 0, "create").payload.state).toBe("Done");
    } finally {
      close();
    }
  });

  test("the remediation key is the one the resolver reads, and the collapsed dispositions say so", async () => {
    const { db, close } = await openedStore("state-collapsed-key");
    try {
      // `waived` maps to the default `Canceled`; a team with no such state must
      // name `disposition.Canceled`, NOT `disposition.waived` — the resolver looks
      // up the default target, so the local spelling would be a key nobody reads.
      addIssue(db, "I-001054", { disposition: "waived" });
      const refused = await pushItem(db, provider(), context({ states: new Set(["Todo", "Done"]) }), candidates(db)[0]!);
      expect(refused.cause).toContain("[linear.mapping] disposition.Canceled=<name>");
      expect(refused.cause).not.toContain("disposition.waived");
      expect(refused.cause).toContain("waived maps to");
      // And the printed advice is what resolves: the refusal above named
      // `disposition.Canceled`, the key this mapping would have to set.
      db.prepare("update issues set disposition = 'open' where id = ?").run("I-001054");
      const fake = provider();
      const mapped = context({
        states: new Set(["Ready for Dev", "Done"]),
        mapping: { disposition: { Todo: "Ready for Dev" }, kind: {}, severity: {} },
      });
      expect((await pushItem(db, fake, mapped, candidates(db)[0]!)).outcome).toBe("created");
    } finally {
      close();
    }
  });

  test("a mapped state name that the team does have is sent verbatim", async () => {
    const { db, close } = await openedStore("state-mapped");
    try {
      addIssue(db, "I-001053", { disposition: "open" });
      const fake = provider();
      const ctx = context({
        states: new Set(["Ready for Dev", "Done", "Canceled"]),
        mapping: { disposition: { Todo: "Ready for Dev" }, kind: {}, severity: {} },
      });
      const outcome = await pushItem(db, fake, ctx, candidates(db)[0]!);
      expect(outcome.outcome).toBe("created");
      expect(writeOf(fake, 0, "create").payload.state).toBe("Ready for Dev");
    } finally {
      close();
    }
  });
});

describe("(m) one claim key arbitrates every create for a content and revision", () => {
  test("a run that starts while another run's create awaits its write sends nothing", async () => {
    const { db, close } = await openedStore("in-flight-window");
    try {
      addIssue(db, "I-001071");
      const candidate = candidates(db)[0]!;
      // Both runs share ONE store, so this is arbitration and not key
      // derivation. The ordinary run claims first — that claim is what writes the
      // `pending` row at revision 1 — and then stands inside its provider call:
      // the network-sized window another process enters.
      const { fake: ordinary, started, release } = writeInFlight();
      const second = provider();
      const ordinaryRun = pushItem(db, ordinary, context(), candidate);
      await started;
      expect(ordinary.writes).toHaveLength(1);
      expect(row(db, "I-001071")).toMatchObject({ itemState: "pending", externalId: null });

      // Started inside that window. The residue it reads IS the in-flight
      // attempt, so a create here would land beside the first one's.
      const secondRun = await pushItem(db, second, context(), candidate);
      expect(second.writes).toEqual([]);
      expect(secondRun.outcome).toBe("unresolved");
      expect(secondRun.cause).toContain("--adopt <localId>=<issueUrl|externalId>");

      release();
      expect(await ordinaryRun).toMatchObject({ outcome: "created", externalId: "LIN-1" });
      // One local item, exactly one remote create.
      expect([...ordinary.writes, ...second.writes].filter((write) => write.kind === "create")).toHaveLength(1);
      expect(row(db, "I-001071")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
    } finally {
      close();
    }
  });

  test("a run that follows a confirmed create over the same content sends nothing", async () => {
    const { db, close } = await openedStore("confirmed-then-same-content");
    try {
      addIssue(db, "I-001072");
      const candidate = candidates(db)[0]!;
      // The ordinary run wins the create for revision 0 of this content.
      const plainProvider = provider();
      expect((await pushItem(db, plainProvider, context(), candidate)).outcome).toBe("created");

      // A second run over the same content sends nothing: the skip rule answers
      // first, because the confirmed write's hash still matches.
      const straggler = provider();
      const replayed = await pushItem(db, straggler, context(), candidate);
      expect(straggler.writes).toEqual([]);
      expect(replayed.outcome).toBe("skipped");
      expect(row(db, "I-001072")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
    } finally {
      close();
    }
  });

  test("a sequential retry after a provable refusal still creates", async () => {
    const { db, close } = await openedStore("sequential-retry");
    try {
      addIssue(db, "I-001062");
      const candidate = candidates(db)[0]!;
      // The ordinary attempt claims, then fails for a reason that proves nothing
      // was delivered. `markFailed` advances the revision, which is the only
      // discriminator the claim key needs: the retry's key differs without any
      // intent segment.
      const refused = provider({ receipts: [{ kind: "refused", code: "linear.write-refused", cause: "HTTP 400" }] });
      expect((await pushItem(db, refused, context(), candidate)).outcome).toBe("failed");
      expect(row(db, "I-001062")).toMatchObject({ itemState: "failed", externalId: null, revision: 2 });

      // The retry arbitrates on a key no earlier attempt used, so the refusal's
      // receipt cannot shadow it.
      const retried = provider();
      const outcome = await pushItem(db, retried, context(), candidates(db)[0]!);
      expect(outcome.outcome).toBe("created");
      expect(retried.writes.filter((write) => write.kind === "create")).toHaveLength(1);
    } finally {
      close();
    }
  });
});

describe("(n) an operator release clears a pending create only when reconciliation found nothing", () => {
  async function residue(db: StoreDb, localId: string): Promise<void> {
    addIssue(db, localId);
    const ambiguous = provider({ receipts: [{ kind: "ambiguous", cause: "connection closed mid-call" }] });
    await pushItem(db, ambiguous, context(), candidates(db)[0]!);
    expect(row(db, localId)).toMatchObject({ itemState: "pending", externalId: null });
  }

  test("zero marker matches: the release drops the residue to failed, and the next push creates exactly one issue", async () => {
    const { db, close } = await openedStore("release-zero");
    try {
      await residue(db, "I-001081");
      // One push run: reconcile's full scan proves absence (one listing), the
      // release lands on the retryable `failed` edge, and the candidate loop
      // then creates the issue it just released.
      const fake = provider();
      const report = await reconcilePendingCreate(db, fake, context(), { release: new Set(["I-001081"]) });
      expect(report).toEqual({ adopted: [], unresolved: [] });
      expect(fake.listings).toEqual([null]);
      expect(row(db, "I-001081")).toMatchObject({ itemState: "failed", externalId: null });
      expect(row(db, "I-001081")!.lastError).toContain("released by the operator");

      const created = await pushItem(db, fake, context(), candidates(db)[0]!);
      expect(created).toMatchObject({ outcome: "created", externalId: "LIN-1" });
      expect(fake.writes.filter((write) => write.kind === "create")).toHaveLength(1);
      expect(row(db, "I-001081")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
    } finally {
      close();
    }
  });

  test("a scan that finds the marker refuses the release and writes nothing: that item's recovery is adoption", async () => {
    const { db, close } = await openedStore("release-found");
    try {
      await residue(db, "I-001082");
      const marker = correlationMarker({ workspace: "acme", team: "ENG" }, STORE_ID, "I-001082");
      const scanning = provider({
        pages: [
          {
            items: [
              {
                externalId: "LIN-77",
                title: "Issue I-001082",
                description: `body\n\n${marker}`,
                state: "Todo",
                priority: "High",
                labels: [],
                updatedAt: "2026-11-02T00:00:00.000Z",
                url: "https://linear.app/acme/issue/LIN-77",
              },
            ],
            nextCursor: null,
          },
        ],
      });
      await expect(reconcilePendingCreate(db, scanning, context(), { release: new Set(["I-001082"]) })).rejects.toThrow(
        /adoption, not release/,
      );
      expect(scanning.writes).toEqual([]);
      // Refused over the whole scan, before the adoption write: the row is still
      // the unresolved create that the next run can adopt.
      expect(row(db, "I-001082")).toMatchObject({ itemState: "pending", externalId: null });
    } finally {
      close();
    }
  });

  test("one matched release refuses the whole run before ANY release or adopt-by-marker write", async () => {
    const { db, close } = await openedStore("release-partial");
    try {
      // Two residues of the same run: one the operator released, one it did not.
      await residue(db, "I-001085");
      addIssue(db, "I-001086");
      const ambiguous = provider({ receipts: [{ kind: "ambiguous", cause: "connection closed mid-call" }] });
      await pushItem(db, ambiguous, context(), candidates(db)[1]!);
      expect(row(db, "I-001086")).toMatchObject({ itemState: "pending", externalId: null });

      const adopted = correlationMarker({ workspace: "acme", team: "ENG" }, STORE_ID, "I-001085");
      const released = correlationMarker({ workspace: "acme", team: "ENG" }, STORE_ID, "I-001086");
      const scanning = provider({
        pages: [
          {
            items: [
              // Would be adopted by marker if the run got that far.
              { externalId: "LIN-85", title: "I-001085", description: adopted, state: "Todo", priority: "High", labels: [], updatedAt: "2026-11-02T00:00:00.000Z", url: "https://linear.app/acme/issue/LIN-85" },
              // The match that refuses the release.
              { externalId: "LIN-86", title: "I-001086", description: released, state: "Todo", priority: "High", labels: [], updatedAt: "2026-11-02T00:00:00.000Z", url: "https://linear.app/acme/issue/LIN-86" },
            ],
            nextCursor: null,
          },
        ],
      });
      await expect(reconcilePendingCreate(db, scanning, context(), { release: new Set(["I-001086"]) })).rejects.toThrow(
        /adoption, not release/,
      );
      // Zero ledger change: the refused release never landed, and neither did the
      // adoption the scan had already proved for the OTHER row.
      expect(scanning.writes).toEqual([]);
      expect(row(db, "I-001085")).toMatchObject({ itemState: "pending", externalId: null });
      expect(row(db, "I-001086")).toMatchObject({ itemState: "pending", externalId: null });
    } finally {
      close();
    }
  });

  test("a release that names anything but an unresolved create is refused before the scan", async () => {
    const { db, close } = await openedStore("release-wrong-shape");
    try {
      addIssue(db, "I-001083");
      const created = provider();
      await pushItem(db, created, context(), candidates(db)[0]!);
      expect(row(db, "I-001083")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });

      const scanning = provider();
      await expect(reconcilePendingCreate(db, scanning, context(), { release: new Set(["I-001083"]) })).rejects.toThrow(
        /names no unresolved create/,
      );
      expect(scanning.listings).toEqual([]);
      expect(row(db, "I-001083")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
    } finally {
      close();
    }
  });

  test("a pending row that already carries an id is refused before the scan, and keeps that id", async () => {
    const { db, close } = await openedStore("release-pending-with-id");
    try {
      await residue(db, "I-001084");
      // The shape `--release` must not touch: `pending` WITH an identity is a
      // cycle nobody closed, not an unresolved create. Forced into place directly
      // because no push path produces it (an ambiguous create never records an id).
      db.prepare("update issue_sync_state set external_id = ? where binding_id = ? and direction = 'push' and local_id = ?").run(
        "LIN-84",
        BINDING,
        "I-001084",
      );
      const scanning = provider();
      await expect(reconcilePendingCreate(db, scanning, context(), { release: new Set(["I-001084"]) })).rejects.toThrow(
        /as LIN-84/,
      );
      // Refused before ANY listing call: the row's shape is the operator's error,
      // and a scan that cannot change the answer is not run.
      expect(scanning.listings).toEqual([]);
      expect(row(db, "I-001084")).toMatchObject({ itemState: "pending", externalId: "LIN-84" });
    } finally {
      close();
    }
  });

  test("a release naming a local id that has no ledger row is refused, naming the absence", async () => {
    const { db, close } = await openedStore("release-missing-row");
    try {
      addIssue(db, "I-001085");
      const scanning = provider();
      await expect(reconcilePendingCreate(db, scanning, context(), { release: new Set(["I-001085"]) })).rejects.toThrow(
        /has no push ledger row/,
      );
      expect(scanning.listings).toEqual([]);
      expect(row(db, "I-001085")).toBeNull();
    } finally {
      close();
    }
  });

  test("a scan that finds SEVERAL marker matches refuses the release as a duplicate risk", async () => {
    const { db, close } = await openedStore("release-multi-match");
    try {
      await residue(db, "I-001086");
      const marker = correlationMarker({ workspace: "acme", team: "ENG" }, STORE_ID, "I-001086");
      const duplicates = ["LIN-201", "LIN-202"].map((externalId) => ({
        externalId,
        title: "Issue I-001086",
        description: `body\n\n${marker}`,
        state: "Todo",
        priority: "High",
        labels: [],
        updatedAt: "2026-11-02T00:00:00.000Z",
        url: `https://linear.app/acme/issue/${externalId}`,
      }));
      const scanning = provider({ pages: [{ items: duplicates, nextCursor: null }] });
      await expect(reconcilePendingCreate(db, scanning, context(), { release: new Set(["I-001086"]) })).rejects.toThrow(
        /would risk a duplicate: 2 remote issues carry this item's correlation marker/,
      );
      expect(scanning.writes).toEqual([]);
      // Nothing adopted either: the row is still the unresolved create, so the
      // operator names the right issue with --adopt instead of the tool guessing.
      expect(row(db, "I-001086")).toMatchObject({ itemState: "pending", externalId: null });
    } finally {
      close();
    }
  });

  test("a marker match on a LATER page still refuses the release: the scan is whole, not first-page", async () => {
    const { db, close } = await openedStore("release-found-later-page");
    try {
      await residue(db, "I-001088");
      const marker = correlationMarker({ workspace: "acme", team: "ENG" }, STORE_ID, "I-001088");
      // Page 1 carries nothing; the identity lives on page 2. A scan that stopped
      // at its first page would release over a proved identity.
      const scanning = provider({
        pages: [
          { items: [], nextCursor: "c-2" },
          {
            items: [
              {
                externalId: "LIN-2",
                title: "Issue I-001088",
                description: `body\n\n${marker}`,
                state: "Todo",
                priority: "High",
                labels: [],
                updatedAt: "2026-11-02T00:00:00.000Z",
                url: "https://linear.app/acme/issue/LIN-2",
              },
            ],
            nextCursor: null,
          },
        ],
      });
      await expect(reconcilePendingCreate(db, scanning, context(), { release: new Set(["I-001088"]) })).rejects.toThrow(
        /would discard a proved identity: LIN-2 carries this item's correlation marker/,
      );
      // Both pages were read, in order, before the refusal decided anything.
      expect(scanning.listings).toEqual([null, "c-2"]);
      expect(scanning.writes).toEqual([]);
      expect(row(db, "I-001088")).toMatchObject({ itemState: "pending", externalId: null });
    } finally {
      close();
    }
  });

  test("zero matches across EVERY page releases the residue, and the same run creates exactly one issue", async () => {
    const { db, close } = await openedStore("release-zero-multi-page");
    try {
      await residue(db, "I-001089");
      // Two empty pages: absence is a fact about the whole scan, so the release
      // is only reachable once the cursor is exhausted.
      const fake = provider({
        pages: [
          { items: [], nextCursor: "c-2" },
          { items: [], nextCursor: null },
        ],
      });
      const report = await reconcilePendingCreate(db, fake, context(), { release: new Set(["I-001089"]) });
      expect(report).toEqual({ adopted: [], unresolved: [] });
      expect(fake.listings).toEqual([null, "c-2"]);
      expect(row(db, "I-001089")).toMatchObject({ itemState: "failed", externalId: null });
      expect(row(db, "I-001089")!.lastError).toContain("released by the operator");

      const created = await pushItem(db, fake, context(), candidates(db)[0]!);
      expect(created).toMatchObject({ outcome: "created", externalId: "LIN-1" });
      expect(fake.writes.filter((write) => write.kind === "create")).toHaveLength(1);
      expect(row(db, "I-001089")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
    } finally {
      close();
    }
  });

  test("a listing that ADOPTS the row mid-scan makes the release throw from applied and keeps the identity", async () => {
    const { db, close } = await openedStore("release-adopted-mid-scan");
    try {
      await residue(db, "I-001087");
      // The listing is where a concurrent `--adopt` (exported, lease-free) lands.
      // The scan itself finds nothing, so the run decides to release — and by the
      // time it writes, the row is `applied` with an identity somebody proved. A
      // release over that stale read would drop the proved identity back to
      // `failed` and let the next push create a second remote issue beside it.
      const adopting = provider();
      const listIssues = adopting.listIssues.bind(adopting);
      adopting.listIssues = async (cursor) => {
        const page = await listIssues(cursor);
        adoptItem(db, BINDING, "I-001087", "https://linear.app/acme/issue/LIN-301/slug");
        return page;
      };
      await expect(reconcilePendingCreate(db, adopting, context(), { release: new Set(["I-001087"]) })).rejects.toThrow(
        /from 'applied' is not in the contract/,
      );
      expect(adopting.writes).toEqual([]);
      // The release wrote nothing: the mid-scan adoption stands.
      expect(row(db, "I-001087")).toMatchObject({ itemState: "applied", externalId: "LIN-301" });
    } finally {
      close();
    }
  });
});

describe("(o) a taken-over run's later write is refused, and its successor is not", () => {
  const RUN = { bindingId: BINDING, direction: "push" as const, holderPid: 4242, holderHost: "builder-1" };

  test("a holder taken over mid-call has its confirmed write refused instead of applied", async () => {
    const { db, close } = await openedStore("lease-taken-mid-call");
    try {
      addIssue(db, "I-001091");
      const candidate = candidates(db)[0]!;
      // The run that will be taken over: it holds the lease, sends its create, and
      // parks inside the provider call — the window a takeover enters.
      const holder = acquireRun(db, { ...RUN, reason: "issue-sync push" });
      const { fake: held, started, release: land } = writeInFlight();
      const heldRun = pushItem(db, held, context({ runId: holder.runId }), candidate);
      await started;
      expect(row(db, "I-001091")).toMatchObject({ itemState: "pending", externalId: null });

      // The operator judged that holder hung (not dead) and took the run over.
      // Nothing at acquisition can stop the request already in flight, so the
      // guard has to be on the WRITE the predecessor records afterwards.
      const taken = acquireRun(db, { ...RUN, holderPid: 5000, holderHost: "builder-2", reason: "operator took the run over with --take-run", takeRun: true });
      land();
      await expect(heldRun).rejects.toThrow(/sync\.run-taken/);
      // The confirmed remote write was NOT recorded as this run's apply: the row
      // stays the unresolved create with no id, which is exactly what the marker
      // scan recovers. Recording it would be a write by a run that no longer holds
      // the direction.
      expect(row(db, "I-001091")).toMatchObject({ itemState: "pending", externalId: null });

      // The successor inherits the residue, not a second create: its own id passes
      // the guard, and the residue guard answers before any send.
      const successor = provider();
      const blocked = await pushItem(db, successor, context({ runId: taken.runId }), candidate);
      expect(blocked).toMatchObject({ outcome: "unresolved", externalId: null });
      expect(successor.writes).toEqual([]);
      expect(releaseRun(db, { ...RUN, runId: taken.runId })).toBe(true);
    } finally {
      close();
    }
  });

  test("a takeover leaves the successor free to write: only the predecessor's token is refused", async () => {
    const { db, close } = await openedStore("lease-successor-unaffected");
    try {
      addIssue(db, "I-001094");
      const dead = acquireRun(db, { ...RUN, reason: "issue-sync push" });
      const taken = acquireRun(db, { ...RUN, holderPid: 5000, holderHost: "builder-2", reason: "operator took the run over with --take-run", takeRun: true });
      // The dead run's own release deletes nothing; the successor still owns it.
      expect(releaseRun(db, { ...RUN, runId: dead.runId })).toBe(false);
      const fake = provider();
      const outcome = await pushItem(db, fake, context({ runId: taken.runId }), candidates(db)[0]!);
      expect(outcome).toMatchObject({ outcome: "created", externalId: "LIN-1" });
      expect(fake.writes.filter((write) => write.kind === "create")).toHaveLength(1);
      expect(row(db, "I-001094")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
    } finally {
      close();
    }
  });

  test("a run whose lease was released underneath it sends nothing further", async () => {
    const { db, close } = await openedStore("lease-gone-before-send");
    try {
      addIssue(db, "I-001092");
      const candidate = candidates(db)[0]!;
      const lease = acquireRun(db, { ...RUN, reason: "issue-sync push" });
      // The row is gone by the time this run would send: checked BEFORE the
      // request leaves, so no provider call happens at all.
      expect(releaseRun(db, { ...RUN, runId: lease.runId })).toBe(true);
      const fake = provider();
      await expect(pushItem(db, fake, context({ runId: lease.runId }), candidate)).rejects.toThrow(
        /its run row is gone/,
      );
      expect(fake.writes).toEqual([]);
      expect(row(db, "I-001092")).toBeNull();
    } finally {
      close();
    }
  });

  test("a normal single run takes today's path: its own lease token passes the guard", async () => {
    const { db, close } = await openedStore("lease-own-token");
    try {
      addIssue(db, "I-001093");
      const lease = acquireRun(db, { ...RUN, reason: "issue-sync push" });
      const fake = provider();
      const outcome = await pushItem(db, fake, context({ runId: lease.runId }), candidates(db)[0]!);
      expect(outcome).toMatchObject({ outcome: "created", externalId: "LIN-1" });
      expect(row(db, "I-001093")).toMatchObject({ itemState: "applied", externalId: "LIN-1", lastRequestHash: expect.any(String) });
      // Same behaviour as a caller that names no lease at all (import), which is
      // the path every pre-existing push test exercises.
      expect(releaseRun(db, { ...RUN, runId: lease.runId })).toBe(true);
    } finally {
      close();
    }
  });
});
