/**
 * push.test.ts — the push ledger protocol without a transport: planning a
 * payload, recording the caller's results, and reconciling ambiguous creates.
 *
 * Everything here runs against a REAL store (the ledger is SQL). No fake
 * provider: mstar makes no call, so the test plays the agent's side and hands
 * the engine what a Linear tool would return.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { initializeStore, type StoreDb } from "../store-db.js";
import type { IssueKind, Severity } from "../issue.js";
import { acquireRun, readItem, type SyncItem } from "../issue-sync.js";
import { SyncError } from "../issue-sync.js";
import type { ProviderItem } from "./provider.js";
import {
  adoptItem,
  assertReleaseTargets,
  correlationMarker,
  externalIdOf,
  identityConflict,
  planItem,
  reconcileWith,
  recordResults,
  selectPushCandidates,
  type PushContext,
  type PushPlan,
} from "./push.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-push-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const PROJECT = "p-push";
const BINDING = "linear:" + PROJECT;
const STORE_ID = "store-alpha";

async function openedStore(name: string): Promise<{ db: StoreDb; harnessDir: string; close: () => void }> {
  const harnessDir = mkdtempSync(join(ROOT, name));
  const handle = await initializeStore({ harnessDir });
  const db = handle.db;
  db.prepare(
    "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', ?, 'Push', 'projects', ?, 'now', 'now')",
  ).run(PROJECT, PROJECT + "/roadmap.md");
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
    overrides.title ?? "Issue " + id,
    overrides.kind ?? "bug",
    overrides.severity ?? "high",
    overrides.disposition ?? "open",
    "sync-issue-" + id,
  );
}

function context(overrides: Partial<PushContext> = {}): PushContext {
  return { bindingId: BINDING, binding: { workspace: "acme", team: "ENG" }, storeId: STORE_ID, ...overrides };
}

function row(db: StoreDb, localId: string): SyncItem | null {
  return readItem(db, { bindingId: BINDING, direction: "push", localId });
}

function candidate(db: StoreDb, localId: string) {
  const found = selectPushCandidates(db, BINDING).find((item) => item.localId === localId);
  if (found === undefined) throw new Error("not a push candidate: " + localId);
  return found;
}

/** Plan one item, asserting it was plannable, and hand back the plan. */
function plan(db: StoreDb, ctx: PushContext, localId: string): PushPlan {
  const outcome = planItem(db, ctx, candidate(db, localId));
  if (outcome.outcome !== "planned") throw new Error("expected a plan, got " + JSON.stringify(outcome));
  return outcome.plan;
}

function markerOf(localId: string, storeId: string = STORE_ID): string {
  return correlationMarker({ workspace: "acme", team: "ENG" }, storeId, localId);
}

/** What a Linear tool would return for one listed issue. */
function record(externalId: string, description: string): ProviderItem {
  return {
    externalId,
    title: "remote title",
    description,
    state: "Todo",
    priority: "2",
    labels: ["bug"],
    updatedAt: "2026-11-02T00:00:00.000Z",
    url: "https://linear.app/acme/issue/" + externalId,
  };
}

/**
 * Take the run lease, as the command does before any planning. The holder pid is
 * part of the run token, so two acquisitions in the same millisecond still name
 * different runs.
 */
function lease(db: StoreDb, options: { holderPid?: number; takeRun?: boolean } = {}) {
  return acquireRun(db, {
    bindingId: BINDING,
    direction: "push",
    holderPid: options.holderPid ?? 4242,
    holderHost: "test-host",
    reason: "issue-sync pending",
    ...(options.takeRun === undefined ? {} : { takeRun: options.takeRun }),
  });
}

describe("selectPushCandidates", () => {
  test("only this project's local captures are candidates; imported mirrors never echo back", async () => {
    const { db, close } = await openedStore("candidates");
    try {
      addIssue(db, "I-000901");
      addIssue(db, "I-000902");
      db.prepare("update issues set provider = 'linear', external_id = 'LIN-9' where id = 'I-000902'").run();
      expect(selectPushCandidates(db, BINDING).map((entry) => entry.localId)).toEqual(["I-000901"]);
    } finally {
      close();
    }
  });
});

describe("planItem builds the payload the caller writes", () => {
  test("a create carries the mapped fields, the two local sections and the marker last", async () => {
    const { db, close } = await openedStore("plan-create");
    try {
      addIssue(db, "I-000911", { kind: "bug", severity: "high", disposition: "open" });
      const planned = plan(db, context(), "I-000911");
      expect(planned).toMatchObject({ localId: "I-000911", operation: "create", externalId: null });
      expect(planned.payload).toMatchObject({ title: "Issue I-000911", priority: 2, state: "Todo", labels: ["bug"] });
      expect(planned.payload.removeLabels).toBeUndefined();
      expect(planned.marker).toBe(markerOf("I-000911"));
      expect(planned.payload.description).toBe(
        "## Impact\n\nimpact body\n\n## Acceptance\n\nacceptance body\n\n" + planned.marker,
      );
      // Planning is the intent record: the claim leaves a pending row behind.
      expect(row(db, "I-000911")).toMatchObject({ itemState: "pending", externalId: null, revision: 1 });
    } finally {
      close();
    }
  });

  test("a mapped disposition and severity reach the payload verbatim", async () => {
    const { db, close } = await openedStore("plan-mapped");
    try {
      addIssue(db, "I-000912", { disposition: "open", severity: "critical" });
      const planned = plan(
        db,
        context({ mapping: { disposition: { Todo: "Ready for Dev" }, kind: {}, severity: {} } }),
        "I-000912",
      );
      expect(planned.payload.state).toBe("Ready for Dev");
      expect(planned.payload.priority).toBe(1);
    } finally {
      close();
    }
  });

  test("an unchanged applied item is skipped and nothing is written", async () => {
    const { db, close } = await openedStore("plan-skip");
    try {
      addIssue(db, "I-000921");
      const ctx = context();
      const planned = plan(db, ctx, "I-000921");
      recordResults(db, ctx, [
        { localId: "I-000921", outcome: "confirmed", externalId: "LIN-1", remoteUpdatedAt: "2026-11-02T00:00:00.000Z" },
      ]);
      const settled = row(db, "I-000921")!;
      expect(settled).toMatchObject({ itemState: "applied", externalId: "LIN-1", lastRequestHash: planned.requestHash });

      const again = planItem(db, ctx, candidate(db, "I-000921"));
      expect(again).toEqual({ outcome: "skipped", localId: "I-000921", externalId: "LIN-1", reason: "unchanged" });
      expect(row(db, "I-000921")).toEqual(settled);
    } finally {
      close();
    }
  });

  test("changed content plans an update on the same identity", async () => {
    const { db, close } = await openedStore("plan-update");
    try {
      addIssue(db, "I-000922");
      const ctx = context();
      plan(db, ctx, "I-000922");
      recordResults(db, ctx, [{ localId: "I-000922", outcome: "confirmed", externalId: "LIN-1" }]);

      db.prepare("update issues set title = 'Retitled' where id = 'I-000922'").run();
      const planned = plan(db, ctx, "I-000922");
      expect(planned).toMatchObject({ operation: "update", externalId: "LIN-1" });
      expect(planned.payload.title).toBe("Retitled");
    } finally {
      close();
    }
  });

  test("a changed kind replaces exactly the label this tool recorded; unknown ownership only adds", async () => {
    const { db, close } = await openedStore("plan-labels");
    try {
      addIssue(db, "I-000923", { kind: "bug" });
      const ctx = context();
      plan(db, ctx, "I-000923");
      recordResults(db, ctx, [{ localId: "I-000923", outcome: "confirmed", externalId: "LIN-1" }]);
      expect(row(db, "I-000923")!.lastKindLabels).toEqual(["bug"]);

      db.prepare("update issues set kind = 'risk' where id = 'I-000923'").run();
      const replaced = plan(db, ctx, "I-000923");
      expect(replaced.payload.labels).toEqual(["risk"]);
      expect(replaced.payload.removeLabels).toEqual(["bug"]);

      // No recorded ownership (an adopted identity carries no label proof).
      addIssue(db, "I-000924");
      adoptItem(db, BINDING, "I-000924", "LIN-2");
      const adopted = plan(db, ctx, "I-000924");
      expect(adopted.payload.labels).toEqual(["bug"]);
      expect(adopted.payload.removeLabels).toBeUndefined();
    } finally {
      close();
    }
  });

  test("an unconfirmed create is never planned twice: the residue names both recoveries", async () => {
    const { db, close } = await openedStore("plan-residue");
    try {
      addIssue(db, "I-000931");
      const ctx = context();
      plan(db, ctx, "I-000931");
      recordResults(db, ctx, [{ localId: "I-000931", outcome: "ambiguous", cause: "tool call timed out after send" }]);
      expect(row(db, "I-000931")).toMatchObject({ itemState: "pending", externalId: null });

      const again = planItem(db, ctx, candidate(db, "I-000931"));
      expect(again.outcome).toBe("unresolved");
      expect(again.outcome === "unresolved" ? again.cause : "").toContain("--adopt <localId>=<issueUrl|externalId>");
      expect(again.outcome === "unresolved" ? again.cause : "").toContain("--release <localId>");
      // Still the one residue the claim opened: the unconfirmed result wrote nothing.
      expect(row(db, "I-000931")).toMatchObject({ itemState: "pending", externalId: null, revision: 1 });
    } finally {
      close();
    }
  });
});

describe("recordResults records what the caller's tools proved", () => {
  test("confirmed records identity, hash and the label it wrote", async () => {
    const { db, close } = await openedStore("record-confirmed");
    try {
      addIssue(db, "I-000941");
      const ctx = context();
      const planned = plan(db, ctx, "I-000941");
      const [outcome] = recordResults(db, ctx, [
        { localId: "I-000941", outcome: "confirmed", externalId: "LIN-7", remoteUpdatedAt: "2026-11-19T12:00:00.000Z" },
      ]);
      expect(outcome).toEqual({ localId: "I-000941", outcome: "applied", externalId: "LIN-7" });
      expect(row(db, "I-000941")).toMatchObject({
        itemState: "applied",
        externalId: "LIN-7",
        lastRequestHash: planned.requestHash,
        lastKindLabels: ["bug"],
        lastRemoteUpdatedAt: "2026-11-19T12:00:00.000Z",
        lastError: null,
      });
    } finally {
      close();
    }
  });

  test("refused is the retryable edge: the next plan creates again", async () => {
    const { db, close } = await openedStore("record-refused");
    try {
      addIssue(db, "I-000942");
      const ctx = context();
      plan(db, ctx, "I-000942");
      const [refused] = recordResults(db, ctx, [
        { localId: "I-000942", outcome: "refused", cause: "label bug does not exist in team ENG" },
      ]);
      expect(refused.outcome).toBe("refused");
      expect(refused.cause).toContain("label bug does not exist");
      expect(row(db, "I-000942")).toMatchObject({ itemState: "failed", externalId: null });
      expect(row(db, "I-000942")!.lastError).toContain("label bug does not exist");

      expect(plan(db, ctx, "I-000942").operation).toBe("create");
      expect(row(db, "I-000942")!.itemState).toBe("pending");
    } finally {
      close();
    }
  });

  test("a refused update keeps the identity and the state, and records the cause", async () => {
    const { db, close } = await openedStore("record-refused-update");
    try {
      addIssue(db, "I-000943");
      const ctx = context();
      plan(db, ctx, "I-000943");
      recordResults(db, ctx, [{ localId: "I-000943", outcome: "confirmed", externalId: "LIN-1" }]);

      db.prepare("update issues set title = 'Retitled' where id = 'I-000943'").run();
      plan(db, ctx, "I-000943");
      const [refused] = recordResults(db, ctx, [{ localId: "I-000943", outcome: "refused", cause: "HTTP 400" }]);
      expect(refused).toMatchObject({ outcome: "refused", externalId: null });
      expect(row(db, "I-000943")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
      expect(row(db, "I-000943")!.lastError).toContain("HTTP 400");
    } finally {
      close();
    }
  });

  test("an ambiguous update keeps the identity, drops the proof and joins the label ownership", async () => {
    const { db, close } = await openedStore("record-ambiguous-update");
    try {
      addIssue(db, "I-000944", { kind: "bug" });
      const ctx = context();
      plan(db, ctx, "I-000944");
      recordResults(db, ctx, [{ localId: "I-000944", outcome: "confirmed", externalId: "LIN-1" }]);

      db.prepare("update issues set kind = 'risk' where id = 'I-000944'").run();
      plan(db, ctx, "I-000944");
      const [ambiguous] = recordResults(db, ctx, [{ localId: "I-000944", outcome: "ambiguous", cause: "timeout" }]);
      expect(ambiguous).toMatchObject({ outcome: "unconfirmed", externalId: "LIN-1" });
      expect(row(db, "I-000944")).toMatchObject({ itemState: "applied", externalId: "LIN-1", lastRequestHash: null });
      expect(row(db, "I-000944")!.lastKindLabels).toEqual(["bug", "risk"]);

      // The corrective update removes whatever the remote may still carry.
      expect(plan(db, ctx, "I-000944").payload.removeLabels).toEqual(["bug"]);
    } finally {
      close();
    }
  });

  test("an unknown local id and a confirmed result without an identity are per-item refusals", async () => {
    const { db, close } = await openedStore("record-refusals");
    try {
      addIssue(db, "I-000945");
      const ctx = context();
      plan(db, ctx, "I-000945");
      const outcomes = recordResults(db, ctx, [
        { localId: "I-999999", outcome: "confirmed", externalId: "LIN-2" },
        { localId: "I-000945", outcome: "confirmed" },
      ]);
      expect(outcomes.map((entry) => entry.outcome)).toEqual(["refused", "refused"]);
      expect(outcomes[0]!.cause).toContain("no push ledger row");
      expect(outcomes[1]!.cause).toContain("externalId");
      // Neither wrote anything: the planned row is still the unconfirmed create.
      expect(row(db, "I-000945")).toMatchObject({ itemState: "pending", externalId: null });
    } finally {
      close();
    }
  });
});

describe("the run lease bounds every write", () => {
  test("a taken-over run plans and records nothing", async () => {
    const { db, close } = await openedStore("lease-taken");
    try {
      addIssue(db, "I-000951");
      const predecessor = lease(db);
      lease(db, { holderPid: 4343, takeRun: true });
      const ctx = context({ runId: predecessor.runId });

      expect(() => planItem(db, ctx, candidate(db, "I-000951"))).toThrow(/sync\.run-taken/);
      expect(() => recordResults(db, ctx, [{ localId: "I-000951", outcome: "confirmed", externalId: "LIN-1" }])).toThrow(
        /sync\.run-taken/,
      );
      expect(row(db, "I-000951")).toBeNull();
    } finally {
      close();
    }
  });

  test("the holder's own token passes", async () => {
    const { db, close } = await openedStore("lease-held");
    try {
      addIssue(db, "I-000952");
      const held = lease(db);
      const ctx = context({ runId: held.runId });
      expect(plan(db, ctx, "I-000952").operation).toBe("create");
      expect(recordResults(db, ctx, [{ localId: "I-000952", outcome: "confirmed", externalId: "LIN-1" }])[0]!.outcome).toBe(
        "applied",
      );
    } finally {
      close();
    }
  });
});

describe("reconcileWith associates only on exact marker equality", () => {
  async function ambiguousCreate(db: StoreDb, localId: string): Promise<string> {
    addIssue(db, localId);
    const ctx = context();
    plan(db, ctx, localId);
    recordResults(db, ctx, [{ localId, outcome: "ambiguous", cause: "connection closed mid-call" }]);
    expect(row(db, localId)!.itemState).toBe("pending");
    return markerOf(localId);
  }

  test("exactly one marker match is adopted, and the next plan is an update", async () => {
    const { db, close } = await openedStore("reconcile-unique");
    try {
      const marker = await ambiguousCreate(db, "I-000961");
      const report = reconcileWith(db, context(), [record("LIN-77", "pushed body\n\n" + marker)]);
      expect(report).toEqual({ adopted: [{ localId: "I-000961", externalId: "LIN-77" }], unresolved: [] });
      expect(row(db, "I-000961")).toMatchObject({ itemState: "applied", externalId: "LIN-77" });
      expect(plan(db, context(), "I-000961")).toMatchObject({ operation: "update", externalId: "LIN-77" });
    } finally {
      close();
    }
  });

  test("another store's marker, no marker, several matches and an empty listing all stay unresolved", async () => {
    const cases: Array<{ name: string; records: (marker: string) => ProviderItem[] }> = [
      { name: "other-store", records: () => [record("LIN-88", "body\n\n" + markerOf("I-000962", "store-beta"))] },
      { name: "no-marker", records: () => [record("LIN-99", "## Impact\n\nimpact body\n\n## Acceptance\n\nacceptance body")] },
      {
        name: "several",
        records: (marker) => [record("LIN-1", "body\n\n" + marker), record("LIN-2", "body\n\n" + marker)],
      },
      { name: "none", records: () => [] },
    ];
    for (const testCase of cases) {
      const { db, close } = await openedStore("reconcile-" + testCase.name);
      try {
        const marker = await ambiguousCreate(db, "I-000962");
        const report = reconcileWith(db, context(), testCase.records(marker));
        expect(report.adopted).toEqual([]);
        expect(report.unresolved).toHaveLength(1);
        expect(row(db, "I-000962")).toMatchObject({ itemState: "pending", externalId: null });
      } finally {
        close();
      }
    }
  });

  test("the LAST marker in a description decides, so quoted prose cannot name the issue", async () => {
    const { db, close } = await openedStore("reconcile-last-marker");
    try {
      const marker = await ambiguousCreate(db, "I-000963");
      const quoted = "an operator wrote: " + markerOf("I-000999") + "\n\n" + marker;
      const report = reconcileWith(db, context(), [record("LIN-5", quoted)]);
      expect(report.adopted).toEqual([{ localId: "I-000963", externalId: "LIN-5" }]);
    } finally {
      close();
    }
  });

  test("no residue reads no record", async () => {
    const { db, close } = await openedStore("reconcile-noop");
    try {
      addIssue(db, "I-000964");
      expect(reconcileWith(db, context(), [record("LIN-1", markerOf("I-000964"))])).toEqual({ adopted: [], unresolved: [] });
      expect(row(db, "I-000964")).toBeNull();
    } finally {
      close();
    }
  });
});

describe("operator release clears a residue only when the listing found nothing", () => {
  async function ambiguousCreate(db: StoreDb, localId: string): Promise<string> {
    addIssue(db, localId);
    const ctx = context();
    plan(db, ctx, localId);
    recordResults(db, ctx, [{ localId, outcome: "ambiguous", cause: "connection closed mid-call" }]);
    return markerOf(localId);
  }

  test("no match: the residue drops to failed and the next plan creates", async () => {
    const { db, close } = await openedStore("release-none");
    try {
      await ambiguousCreate(db, "I-000971");
      const report = reconcileWith(db, context(), [], { release: new Set(["I-000971"]) });
      expect(report).toEqual({ adopted: [], unresolved: [] });
      expect(row(db, "I-000971")).toMatchObject({ itemState: "failed", externalId: null });
      expect(row(db, "I-000971")!.lastError).toContain("released by the operator");
      expect(plan(db, context(), "I-000971").operation).toBe("create");
    } finally {
      close();
    }
  });

  test("a match refuses the release before any write: that row's recovery is adoption", async () => {
    const { db, close } = await openedStore("release-match");
    try {
      const marker = await ambiguousCreate(db, "I-000972");
      expect(() => reconcileWith(db, context(), [record("LIN-1", marker)], { release: new Set(["I-000972"]) })).toThrow(
        /would discard a proved identity/,
      );
      expect(row(db, "I-000972")).toMatchObject({ itemState: "pending", externalId: null });
    } finally {
      close();
    }
  });

  test("a release that names anything but an unresolved create is refused before the listing", async () => {
    const { db, close } = await openedStore("release-target");
    try {
      addIssue(db, "I-000973");
      const ctx = context();
      plan(db, ctx, "I-000973");
      recordResults(db, ctx, [{ localId: "I-000973", outcome: "confirmed", externalId: "LIN-1" }]);
      expect(() => assertReleaseTargets(db, BINDING, new Set(["I-000973"]))).toThrow(/names no unresolved create/);
      expect(() => assertReleaseTargets(db, BINDING, new Set(["I-000999"]))).toThrow(/no push ledger row/);
      expect(row(db, "I-000973")).toMatchObject({ itemState: "applied", externalId: "LIN-1" });
    } finally {
      close();
    }
  });
});

describe("operator adoption", () => {
  test("--adopt records the identity from an issue URL and drops the previous issue's proof", async () => {
    const { db, close } = await openedStore("adopt");
    try {
      addIssue(db, "I-000981");
      const ctx = context();
      plan(db, ctx, "I-000981");
      recordResults(db, ctx, [{ localId: "I-000981", outcome: "confirmed", externalId: "LIN-1" }]);
      expect(row(db, "I-000981")!.lastRequestHash).not.toBeNull();

      const adopted = adoptItem(db, BINDING, "I-000981", "https://linear.app/acme/issue/LIN-123/some-slug", { force: true });
      expect(adopted).toMatchObject({ itemState: "applied", externalId: "LIN-123", lastRequestHash: null });
      // Nothing local changed, so carrying the hash would report a skip for
      // content LIN-123 never received.
      expect(plan(db, ctx, "I-000981")).toMatchObject({ operation: "update", externalId: "LIN-123" });
    } finally {
      close();
    }
  });

  test("an ambiguous residue is adopted directly, never refused as an illegal transition", async () => {
    const { db, close } = await openedStore("adopt-residue");
    try {
      addIssue(db, "I-000982");
      const ctx = context();
      plan(db, ctx, "I-000982");
      recordResults(db, ctx, [{ localId: "I-000982", outcome: "ambiguous", cause: "connection closed" }]);
      expect(adoptItem(db, BINDING, "I-000982", "LIN-321")).toMatchObject({ itemState: "applied", externalId: "LIN-321" });
      expect(plan(db, ctx, "I-000982")).toMatchObject({ operation: "update", externalId: "LIN-321" });
    } finally {
      close();
    }
  });

  test("replacing an established identity is refused unless the operator forces it", () => {
    const existing = { externalId: "LIN-1", itemState: "applied" } as SyncItem;
    expect(identityConflict(existing, "I-1", "LIN-1")).toBeNull();
    const conflict = identityConflict(existing, "I-1", "LIN-2");
    expect(conflict).toBeInstanceOf(SyncError);
    expect(conflict?.code).toBe("sync.identity-conflict");
    expect(conflict?.message).toContain("--force-adopt I-1");
  });

  test("a reference that is not a Linear URL is refused by name", () => {
    expect(externalIdOf("LIN-5")).toBe("LIN-5");
    expect(() => externalIdOf("https://example.test/acme/issue/LIN-5")).toThrow(/not a Linear host/);
    expect(() => externalIdOf("https://linear.app/acme/no-issue-here")).toThrow(/not a Linear issue URL/);
  });
});



