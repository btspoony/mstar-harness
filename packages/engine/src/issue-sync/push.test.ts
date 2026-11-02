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
import { initializeStore, type StoreDb } from "../store-db.js";
import type { IssueKind, Severity } from "../issue.js";
import { claimItem, planItem, readItem } from "../issue-sync.js";
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

async function openedStore(name: string): Promise<{ db: StoreDb; close: () => void }> {
  const handle = await initializeStore({ harnessDir: mkdtempSync(join(ROOT, name)) });
  const db = handle.db;
  db.prepare(
    "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', ?, 'Push', 'projects', ?, 'now', 'now')",
  ).run(PROJECT, `${PROJECT}/roadmap.md`);
  return { db, close: () => handle.close() };
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
  test("create → applied with external_id and last_request_hash; changed title → update on the same id", async () => {
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
      expect(updated.lastRequestHash).not.toBe(applied.lastRequestHash);
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

  test("--force-create bypasses the reconcile guard for that one item and still classifies the receipt", async () => {
    const { db, close } = await openedStore("force-create");
    try {
      addIssue(db, "I-000972");
      const fake = provider({ receipts: [{ kind: "ambiguous", cause: "dropped" }] });
      await pushItem(db, fake, context(), candidates(db)[0]!);
      expect(row(db, "I-000972")!.itemState).toBe("pending");
      const forced = await pushItem(db, fake, context({ forceCreate: true }), candidates(db)[0]!);
      expect(forced).toMatchObject({ outcome: "created", externalId: "LIN-1" });
      expect(fake.writes).toHaveLength(2);
    } finally {
      close();
    }
  });

  test("a reference that is not a Linear URL is refused by name", () => {
    expect(externalIdOf("LIN-5")).toBe("LIN-5");
    expect(() => externalIdOf("https://example.test/acme/issue/LIN-5")).toThrow(/not a Linear host/);
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

describe("requestHash", () => {
  test("is deterministic over content and independent of the removal instruction", () => {
    const payload = { title: "t", description: "d", priority: 2, state: "Todo", labels: ["bug"] };
    expect(requestHash(payload)).toBe(requestHash({ ...payload }));
    expect(requestHash({ ...payload, title: "other" })).not.toBe(requestHash(payload));
    expect(requestHash({ ...payload, removeLabels: ["risk"] })).toBe(requestHash(payload));
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
      expect(row(db, "I-001011")!.lastRequestHash).toBe(hashOfA);
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

describe("(j) a pre-send refusal under --force-create keeps the ambiguous residue reconcilable", () => {
  test("pending residue + missing label: the row stays pending with the error recorded, and reconcile still sees it", async () => {
    const { db, close } = await openedStore("force-create-refusal");
    try {
      addIssue(db, "I-001031", { kind: "risk" });
      const ctx = context();
      // 1. An ambiguous create leaves the residue: pending, no id.
      const ambiguous = provider({ receipts: [{ kind: "ambiguous", cause: "connection closed mid-call" }] });
      await pushItem(db, ambiguous, ctx, candidates(db)[0]!);
      expect(row(db, "I-001031")).toMatchObject({ itemState: "pending", externalId: null, lastError: null });
      const writesBefore = ambiguous.writes.length;

      // 2. --force-create with a label the workspace does not have. The refusal
      //    provably sent nothing, but the row it would have written `failed` on
      //    is the ONLY record that a remote issue may already exist.
      const missingLabel = context({ labels: new Set(["bug"]), forceCreate: true });
      const blocked = await pushItem(db, ambiguous, missingLabel, candidates(db)[0]!);
      expect(blocked.outcome).toBe("failed");
      expect(blocked.cause).toContain("linear.label-unresolved");
      // Nothing was sent for this attempt.
      expect(ambiguous.writes).toHaveLength(writesBefore);

      // The residue is untouched as an AMBIGUITY: still pending, still no id,
      // and the diagnostic is recorded on the row.
      const afterRefusal = row(db, "I-001031")!;
      expect(afterRefusal).toMatchObject({ itemState: "pending", externalId: null });
      expect(afterRefusal.lastError).toContain("linear.label-unresolved");

      // 3. Reconciliation still finds it: that is what `failed` would have
      //    destroyed. One marker match adopts the interrupted create.
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

describe("(k) two pushes with the same content and revision produce exactly one create", () => {
  const PLAN_OP = `linear-push:${BINDING}:I-001041:plan:hash:0`;
  const planInput = { bindingId: BINDING, direction: "push" as const, localId: "I-001041", operationId: PLAN_OP };

  test("only the first identical claim holds the send right; a replay of it does not", async () => {
    const { db, close } = await openedStore("claim-once");
    try {
      addIssue(db, "I-001041");
      // Two callers that derive the SAME operationId from content + revision.
      // `planItem` replays its receipt for both of them, which is exactly how
      // two concurrent pushes each concluded they owned the create.
      const first = claimItem(db, planInput);
      const second = claimItem(db, planInput);
      expect(first.claimed).toBe(true);
      expect(second.claimed).toBe(false);
      // The loser is told what the ledger now holds, not what the winner's
      // receipt said, so it can act on the current row.
      expect(second.item).toEqual(first.item);
      // `planItem` keeps its idempotent-replay semantics for everyone else.
      expect(planItem(db, planInput)).toEqual(first.item);
    } finally {
      close();
    }
  });

  test("a push that finds the claim already taken sends nothing", async () => {
    const { db, close } = await openedStore("claim-lost");
    try {
      addIssue(db, "I-001042");
      const fake = provider();
      const ctx = context();
      const candidate = candidates(db)[0]!;

      // The winner: a create is sent and confirmed.
      const won = await pushItem(db, fake, ctx, candidate);
      expect(won.outcome).toBe("created");
      expect(fake.writes.filter((write) => write.kind === "create")).toHaveLength(1);

      // A concurrent caller that read the same unsynced issue now finds the
      // claimed row. It must send nothing: the row's identity already exists.
      const second = await pushItem(db, fake, ctx, candidate);
      expect(second.outcome).toBe("skipped");
      expect(fake.writes.filter((write) => write.kind === "create")).toHaveLength(1);
      expect(row(db, "I-001042")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
    } finally {
      close();
    }
  });
});

describe("(l) disposition→state names are preflighted against the team, like labels", () => {
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
      expect(refused.cause).toContain("disposition.open");
      expect(fake.writes).toEqual([]);

      // The item whose state DOES exist proceeds: an unknown name refuses one item only.
      const ok = await pushItem(db, fake, ctx, second!);
      expect(ok.outcome).toBe("created");
      expect(writeOf(fake, 0, "create").payload.state).toBe("Done");
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
