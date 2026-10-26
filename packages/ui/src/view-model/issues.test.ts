/**
 * Issue list + detail behaviour that must not regress when the dashboard moves.
 *
 * The address-bar pair, the default filters, the list state machine and the
 * detail's fact set are all asserted here. The negative half matters as much:
 * the detail model must expose no history, provenance, relations or revision —
 * IA §8.1 removed them, and a model that carries them lets a screen resurrect the
 * surface.
 */
import { describe, expect, test } from "bun:test";
import type { IssueDetail, IssuePage } from "@mstar-harness/engine";

import {
  DEFAULT_ISSUE_FILTERS,
  PAGE_SIZE,
  activeIssueFilters,
  clearIssueFilter,
  isDefaultIssueFilters,
  issueDetailModel,
  issueListModel,
  issueQuery,
  parseIssueQuery,
} from "./issues.ts";

const projection = (generation: number | null) => ({
  generation,
  freshness: "current" as const,
  builtAt: null,
  checkedAt: "",
  diagnostics: [],
});

const summary = (over: Partial<IssuePage["items"][number]> = {}): IssuePage["items"][number] => ({
  id: "I-000001",
  projectId: "engine",
  title: "A title",
  kind: "bug",
  severity: "high",
  disposition: "open",
  registeredAt: "2026-10-01T09:00:00.000Z",
  lastActivity: "2026-10-02T10:00:00.000Z",
  revision: 3,
  milestoneId: null,
  ...over,
});

const page = (items: IssuePage["items"], total = items.length): IssuePage => ({
  items,
  total,
  storeRevision: 1224,
});

describe("the address-bar pair", () => {
  test("defaults are open-only across all projects", () => {
    expect(DEFAULT_ISSUE_FILTERS).toEqual({ project: "", disposition: "open", kind: "", severity: "", q: "" });
  });

  test("a query string round-trips through both halves", () => {
    const query = {
      filters: { project: "engine", disposition: "resolved", kind: "bug", severity: "high", q: "chart" },
      offset: 50,
    };
    expect(parseIssueQuery(issueQuery(query))).toEqual(query);
  });

  test("an unknown enum value falls back to the default instead of being forwarded", () => {
    const parsed = parseIssueQuery("?disposition=exploded&kind=banana&severity=nope");
    expect(parsed.filters.disposition).toBe("open");
    expect(parsed.filters.kind).toBe("");
    expect(parsed.filters.severity).toBe("");
  });

  test("a malformed offset falls back to the first page", () => {
    expect(parseIssueQuery("?offset=-3").offset).toBe(0);
    expect(parseIssueQuery("?offset=abc").offset).toBe(0);
  });

  test("the emitted query is in a fixed field order and always carries the page size", () => {
    const emitted = issueQuery({
      filters: { project: "engine", disposition: "open", kind: "", severity: "high", q: "" },
      offset: 0,
    });
    expect(emitted).toBe("disposition=open&project=engine&severity=high&limit=50");
  });

  test("the default filters are recognised, and a chip exists only for a real narrowing", () => {
    expect(isDefaultIssueFilters({ ...DEFAULT_ISSUE_FILTERS })).toBe(true);
    expect(activeIssueFilters({ ...DEFAULT_ISSUE_FILTERS })).toEqual([]);
    const filtered = { ...DEFAULT_ISSUE_FILTERS, severity: "critical", disposition: "resolved" };
    expect(activeIssueFilters(filtered)).toEqual([
      { field: "severity", value: "critical" },
      { field: "disposition", value: "resolved" },
    ]);
  });

  test("clearing one filter restores that field's default only", () => {
    const filtered = { project: "engine", disposition: "resolved", kind: "bug", severity: "high", q: "x" };
    expect(clearIssueFilter(filtered, "disposition").disposition).toBe("open");
    expect(clearIssueFilter(filtered, "project").project).toBe("");
    expect(clearIssueFilter(filtered, "project").severity).toBe("high");
  });
});

describe("the list state machine", () => {
  test("rows are listed and paged", () => {
    const model = issueListModel({ data: page([summary()], 120), projection: projection(4) }, {
      filters: DEFAULT_ISSUE_FILTERS,
      offset: 50,
    });
    expect(model.rows.kind).toBe("populated");
    expect(model.total).toBe(120);
    expect(model.page).toBe(2);
    expect(model.hasNext).toBe(true);
    expect(model.hasPrevious).toBe(true);
  });

  test("an empty store is empty, with no next page", () => {
    const model = issueListModel({ data: page([]), projection: projection(4) }, {
      filters: DEFAULT_ISSUE_FILTERS,
      offset: 0,
    });
    expect(model.rows).toEqual({ kind: "empty" });
    expect(model.hasNext).toBe(false);
    expect(model.hasPrevious).toBe(false);
  });

  test("no published generation still reads the store", () => {
    // Issues are store-backed: `generation: null` accompanies a *successful* read, so
    // vetoing it made every working list render as unavailable.
    const empty = issueListModel({ data: page([]), projection: projection(null) }, {
      filters: DEFAULT_ISSUE_FILTERS,
      offset: 0,
    });
    expect(empty.rows.kind).toBe("empty");
    const populated = issueListModel({ data: page([summary()]), projection: projection(null) }, {
      filters: DEFAULT_ISSUE_FILTERS,
      offset: 0,
    });
    expect(populated.rows.kind).toBe("populated");
  });

  test("a row carries exactly the §8.2 facts and the tone the label needs", () => {
    const model = issueListModel(
      { data: page([summary({ severity: "critical", disposition: "superseded" })]), projection: projection(4) },
      { filters: DEFAULT_ISSUE_FILTERS, offset: 0 },
    );
    if (model.rows.kind !== "populated") throw new Error("expected rows");
    const row = model.rows.value[0];
    expect(Object.keys(row).sort()).toEqual(
      [
        "disposition",
        "dispositionTone",
        "id",
        "kind",
        "lastActivity",
        "milestoneId",
        "projectId",
        "severity",
        "severityEmphasised",
        "severityTone",
        "title",
      ].sort(),
    );
    expect(row.severityTone).toBe("danger");
    expect(row.severityEmphasised).toBe(true);
    // A terminal disposition that is not `resolved` is not a success.
    expect(row.dispositionTone).toBe("purple");
  });

  test("a missing activity date says so instead of borrowing the read time", () => {
    const model = issueListModel({ data: page([summary({ lastActivity: null })]), projection: projection(4) }, {
      filters: DEFAULT_ISSUE_FILTERS,
      offset: 0,
    });
    if (model.rows.kind !== "populated") throw new Error("expected rows");
    expect(model.rows.value[0]?.lastActivity).toBe("Date unknown");
  });

  test("the page size is the read model's own default", () => {
    expect(PAGE_SIZE).toBe(50);
  });
});

describe("the detail fact block", () => {
  const detail = (over: Partial<IssueDetail> = {}): IssueDetail => ({
    id: "I-000001",
    projectId: "engine",
    title: "A title",
    kind: "bug",
    severity: "high",
    disposition: "open",
    impact: "Impact text",
    acceptance: "Acceptance text",
    owner: "frontend-dev",
    registeredAt: "2026-10-01T09:00:00.000Z",
    closedAt: null,
    closureNote: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-03T09:00:00.000Z",
    revision: 7,
    milestoneId: "9f2c4a10",
    provider: "store",
    externalId: "42",
    url: "https://tracker.example/42",
    identityKey: "a|b",
    occurrences: [
      {
        id: 1,
        occurrenceKey: "k1",
        sourceKind: "review",
        sourceIdentity: "qc1",
        rootCauseKey: "rc",
        acceptanceKey: "ac",
        location: "src/a.ts:1",
        observedBehavior: "behaviour",
        evidence: ["e"],
        discoveredAt: null,
        recordedAt: "2026-10-01T09:00:00.000Z",
        imported: false,
      },
      {
        id: 2,
        occurrenceKey: "k2",
        sourceKind: "review",
        sourceIdentity: "qc2",
        rootCauseKey: "rc",
        acceptanceKey: "ac",
        location: "src/a.ts:1",
        observedBehavior: "behaviour",
        evidence: [],
        discoveredAt: null,
        recordedAt: "2026-10-02T09:00:00.000Z",
        imported: false,
      },
    ],
    transitions: [],
    relations: [],
    provenance: [],
    projectMoves: [],
    ...over,
  });

  test("the occurrence LOG collapses to one integer count", () => {
    const model = issueDetailModel(detail());
    expect(model.occurrenceCount).toBe(2);
    expect(Object.keys(model)).not.toContain("occurrences");
  });

  test("no history, provenance, relations, tracker carry-over or revision is exposed", () => {
    const model = issueDetailModel(detail());
    for (const removed of [
      "transitions",
      "provenance",
      "relations",
      "url",
      "externalId",
      "provider",
      "identityKey",
      "revision",
      "createdAt",
      "updatedAt",
    ]) {
      expect(Object.keys(model)).not.toContain(removed);
    }
  });

  test("the two long-text fields and the dates that mean something survive", () => {
    const model = issueDetailModel(detail());
    expect(model.impact).toBe("Impact text");
    expect(model.acceptance).toBe("Acceptance text");
    expect(model.registeredAt).toBe("2026-10-01 09:00");
    expect(model.closedAt).toBeNull();
  });

  test("a closure note appears only when the issue is closed", () => {
    expect(issueDetailModel(detail({ closureNote: "fixed" })).closureNote).toBeNull();
    const closed = issueDetailModel(
      detail({ disposition: "resolved", closedAt: "2026-10-05T00:00:00.000Z", closureNote: "fixed" }),
    );
    expect(closed.closureNote).toBe("fixed");
    expect(closed.closedAt).toBe("2026-10-05 00:00");
  });

  test("an absent long-text field is null, not an empty string", () => {
    const model = issueDetailModel(detail({ impact: "   " }));
    expect(model.impact).toBeNull();
  });
});
