/**
 * ingest.test.ts — the association rule over a listing the caller fetched with
 * its own tools: repo + local + git author decide, and the ledger is the only
 * thing that is written.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { initializeStore, type StoreDb } from "../store-db.js";
import { readItem } from "../issue-sync.js";
import { ingestRecords, type IngestContext } from "./ingest.js";
import { encodeMarker } from "./marker.js";
import type { ProviderItem } from "./provider.js";
import { planItem, recordResults, selectPushCandidates, type PushContext } from "./push.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-ingest-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const PROJECT = "p-ingest";
const BINDING = "linear:" + PROJECT;
const REPO = "acme/widgets";
const AUTHOR = "Ada Lovelace <ada@example.com>";
const UPDATED = "2026-11-19T12:00:00.000Z";

async function openedStore(name: string): Promise<{ db: StoreDb; close: () => void }> {
  const harnessDir = mkdtempSync(join(ROOT, name));
  const handle = await initializeStore({ harnessDir });
  const db = handle.db;
  db.prepare(
    "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', ?, 'Ingest', 'projects', ?, 'now', 'now')",
  ).run(PROJECT, PROJECT + "/roadmap.md");
  return { db, close: () => handle.close() };
}

function addIssue(db: StoreDb, id: string): void {
  db.prepare(
    "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)" +
      " values (?, ?, ?, 'bug', 'high', 'open', 'impact body', 'acceptance body', 'now', 'now', ?)",
  ).run(id, PROJECT, "Issue " + id, "sync-issue-" + id);
}

function ingestContext(overrides: Partial<IngestContext> = {}): IngestContext {
  return { bindingId: BINDING, identity: { repo: REPO, author: AUTHOR }, ...overrides };
}

function pushContext(): PushContext {
  return { bindingId: BINDING, identity: { repo: REPO, author: AUTHOR } };
}

function marker(localId: string, overrides: { repo?: string; author?: string } = {}): string {
  return encodeMarker({ repo: overrides.repo ?? REPO, localId, author: overrides.author ?? AUTHOR });
}

function record(externalId: string, description: string, overrides: Partial<ProviderItem> = {}): ProviderItem {
  return {
    externalId,
    title: "remote title",
    description,
    state: "Todo",
    priority: "2",
    labels: ["bug"],
    updatedAt: UPDATED,
    url: "https://linear.app/acme/issue/" + externalId,
    ...overrides,
  };
}

function pushRow(db: StoreDb, localId: string) {
  return readItem(db, { bindingId: BINDING, direction: "push", localId });
}

/**
 * Push one local issue through the real planner and recorder, then hand back the
 * remote record a Linear tool would report for it: the payload mstar sent.
 */
function pushAndRecord(db: StoreDb, localId: string, externalId: string): ProviderItem {
  const push = pushContext();
  const candidate = selectPushCandidates(db, BINDING).find((entry) => entry.localId === localId)!;
  const outcome = planItem(db, push, candidate);
  if (outcome.outcome !== "planned") throw new Error("expected a plan for " + localId);
  recordResults(db, push, [{ localId, outcome: "confirmed", externalId }]);
  const payload = outcome.plan.payload;
  return {
    externalId,
    title: payload.title,
    description: payload.description,
    state: payload.state,
    priority: String(payload.priority),
    labels: [...(payload.labels ?? [])],
    updatedAt: UPDATED,
    url: "https://linear.app/acme/issue/" + externalId,
  };
}

describe("ingestRecords", () => {
  test("an exact marker on an existing local issue associates it, writing the ledger only", async () => {
    const { db, close } = await openedStore("associate");
    try {
      addIssue(db, "I-000801");
      const before = db.prepare("select title, updated_at from issues where id = 'I-000801'").get();
      const report = ingestRecords(db, ingestContext(), [record("LIN-1", "body\n\n" + marker("I-000801"))]);
      expect(report.associated).toEqual([
        { localId: "I-000801", externalId: "LIN-1", url: "https://linear.app/acme/issue/LIN-1" },
      ]);
      expect(report.drift).toEqual([]);
      expect(pushRow(db, "I-000801")).toMatchObject({
        itemState: "applied",
        externalId: "LIN-1",
        lastRemoteUpdatedAt: UPDATED,
      });
      // No local issue was created, updated or closed.
      expect(db.prepare("select title, updated_at from issues where id = 'I-000801'").get()).toEqual(before);
      expect((db.prepare("select count(*) as n from issues").get() as { n: number }).n).toBe(1);
    } finally {
      close();
    }
  });

  test("remote content equal to the last confirmed payload is associated without drift", async () => {
    const { db, close } = await openedStore("no-drift");
    try {
      addIssue(db, "I-000811");
      const pushed = pushAndRecord(db, "I-000811", "LIN-11");
      const report = ingestRecords(db, ingestContext(), [pushed]);
      expect(report.drift).toEqual([]);
      expect(report.associated).toHaveLength(1);
      expect(pushRow(db, "I-000811")).toMatchObject({ itemState: "applied", externalId: "LIN-11" });
    } finally {
      close();
    }
  });

  test("remote content that no longer matches the confirmed payload is reported as drift", async () => {
    const { db, close } = await openedStore("drift");
    try {
      addIssue(db, "I-000821");
      const pushed = pushAndRecord(db, "I-000821", "LIN-21");
      const hashBefore = pushRow(db, "I-000821")!.lastRequestHash;
      const edited = { ...pushed, title: "edited in Linear", updatedAt: "2026-11-19T13:00:00.000Z" };
      const report = ingestRecords(db, ingestContext(), [edited]);
      expect(report.associated).toEqual([]);
      expect(report.drift).toHaveLength(1);
      expect(report.drift[0]!.localId).toBe("I-000821");
      expect(report.drift[0]!.cause).toContain("no longer matches");
      // Association is still recorded, and the local proof is not rewritten.
      const after = pushRow(db, "I-000821")!;
      expect(after).toMatchObject({ itemState: "applied", externalId: "LIN-21" });
      expect(after.lastRequestHash).toBe(hashBefore);
      expect(after.lastRemoteUpdatedAt).toBe("2026-11-19T13:00:00.000Z");
    } finally {
      close();
    }
  });

  test("another author's marker in the same repository is foreign: reported, never written", async () => {
    const { db, close } = await openedStore("foreign");
    try {
      addIssue(db, "I-000831");
      const report = ingestRecords(db, ingestContext(), [
        record("LIN-31", "body\n\n" + marker("I-000831", { author: "Bo <bo@example.test>" })),
      ]);
      expect(report.foreign).toHaveLength(1);
      expect(report.foreign[0]!.cause).toContain("Bo <bo@example.test>");
      expect(report.associated).toEqual([]);
      expect(pushRow(db, "I-000831")).toBeNull();
    } finally {
      close();
    }
  });

  test("a marker naming an unknown local issue is an orphan: reported, never written", async () => {
    const { db, close } = await openedStore("orphan");
    try {
      const report = ingestRecords(db, ingestContext(), [record("LIN-41", "body\n\n" + marker("I-999999"))]);
      expect(report.orphan).toHaveLength(1);
      expect(report.orphan[0]!.localId).toBe("I-999999");
      expect(report.orphan[0]!.cause).toContain("does not hold");
      expect(pushRow(db, "I-999999")).toBeNull();
    } finally {
      close();
    }
  });

  test("an unmarked, a legacy-marked and another repository's issue are all unmanaged", async () => {
    const { db, close } = await openedStore("unmanaged");
    try {
      addIssue(db, "I-000841");
      const report = ingestRecords(db, ingestContext(), [
        record("LIN-51", "## Impact\n\nno marker at all"),
        record("LIN-52", "body\n\n<!-- mstar-sync: acme/ENG/store-alpha/I-000841 -->"),
        record("LIN-53", "body\n\n" + marker("I-000841", { repo: "acme/other" })),
      ]);
      expect(report.unmanaged.map((entry) => entry.externalId)).toEqual(["LIN-51", "LIN-52", "LIN-53"]);
      expect(report.unmanaged[2]!.cause).toContain("acme/other");
      expect(report.associated).toEqual([]);
      expect(pushRow(db, "I-000841")).toBeNull();
    } finally {
      close();
    }
  });

  test("a second remote issue claiming one local issue is reported instead of overwriting the identity", async () => {
    const { db, close } = await openedStore("conflict");
    try {
      addIssue(db, "I-000851");
      const pushed = pushAndRecord(db, "I-000851", "LIN-61");
      const second = { ...pushed, externalId: "LIN-62" };
      const report = ingestRecords(db, ingestContext(), [pushed, second]);
      expect(report.associated.map((entry) => entry.externalId)).toEqual(["LIN-61"]);
      expect(report.drift.map((entry) => entry.externalId)).toEqual(["LIN-62"]);
      expect(report.drift[0]!.cause).toContain("two remote issues claim one local issue");
      // The recorded identity is the one mstar confirmed, not the later claim.
      expect(pushRow(db, "I-000851")!.externalId).toBe("LIN-61");
    } finally {
      close();
    }
  });

  test("a rejected claim does not move the ledger watermark", async () => {
    const { db, close } = await openedStore("conflict-no-write");
    try {
      addIssue(db, "I-000852");
      const pushed = pushAndRecord(db, "I-000852", "LIN-61");
      const before = pushRow(db, "I-000852")!;
      expect(before).toMatchObject({ itemState: "applied", externalId: "LIN-61" });

      // A second remote issue carrying the same marker is the identity conflict;
      // it is reported, and NOTHING about it is recorded - not even a revision.
      const second = { ...pushed, externalId: "LIN-62", updatedAt: "2026-11-20T09:00:00.000Z" };
      const report = ingestRecords(db, ingestContext(), [second]);
      expect(report.drift).toHaveLength(1);
      expect(report.drift[0]!.cause).toContain("Nothing was written");
      const after = pushRow(db, "I-000852")!;
      expect(after).toEqual(before);
    } finally {
      close();
    }
  });

  test("records are independent: one unmanaged issue does not stop the association of the next", async () => {
    const { db, close } = await openedStore("mixed");
    try {
      addIssue(db, "I-000861");
      const report = ingestRecords(db, ingestContext(), [
        record("LIN-71", "no marker"),
        record("LIN-72", "body\n\n" + marker("I-000861")),
      ]);
      expect(report.unmanaged).toHaveLength(1);
      expect(report.associated).toHaveLength(1);
    } finally {
      close();
    }
  });
});
