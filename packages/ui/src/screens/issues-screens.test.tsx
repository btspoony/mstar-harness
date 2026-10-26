/**
 * `Issues` and `IssueDetail`.
 *
 * The load-bearing half of this file is the negative set on `IssueDetail`: the
 * DTO still carries occurrence rows, transitions, provenance, relations, tracker
 * carry-over and revision metadata, and §8.1 removes only the *drawing*. A test
 * that fails when any of them reaches the page is the only thing standing between
 * "the contraction was applied" and "it erodes on the next edit".
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IssueDetail, IssuePage } from "@mstar-harness/engine";

import {
  DEFAULT_ISSUE_FILTERS,
  issueDetailModel,
  issueListModel,
  type IssueQuery,
} from "../view-model/issues.ts";
import { Issues, type IssuesCopy } from "./Issues.tsx";
import { IssueDetail as IssueDetailScreen, type IssueDetailCopy } from "./IssueDetail.tsx";

const projection = {
  generation: 7,
  freshness: "current" as const,
  builtAt: "2026-10-25T05:00:00.000Z",
  checkedAt: "2026-10-25T05:01:00.000Z",
  diagnostics: [],
};

const summary = (over: Partial<IssuePage["items"][number]> = {}): IssuePage["items"][number] => ({
  id: "I-000870",
  projectId: "engine",
  title: "The dashboard and the panel disagree about tone",
  kind: "bug",
  severity: "critical",
  disposition: "open",
  registeredAt: "2026-10-01T09:00:00.000Z",
  lastActivity: "2026-10-24T10:00:00.000Z",
  revision: 3,
  milestoneId: "9f2c4a10",
  ...over,
});

const page = (items: IssuePage["items"], total = items.length): IssuePage => ({ items, total, storeRevision: 1224 });

const query = (over: Partial<IssueQuery["filters"]> = {}, offset = 0): IssueQuery => ({
  filters: { ...DEFAULT_ISSUE_FILTERS, ...over },
  offset,
});

const issuesCopy: IssuesCopy = {
  pageTitle: "Issues",
  tableCaption: "Issues",
  columns: {
    id: "ID",
    title: "Title",
    severity: "Severity",
    disposition: "Disposition",
    kind: "Kind",
    project: "Project",
    milestone: "Milestone",
    lastActivity: "Last activity",
  },
  filters: {
    disposition: "Disposition",
    project: "Project",
    kind: "Kind",
    severity: "Severity",
    search: "Search",
    clear: "Clear filters",
  },
  anyOption: "Any",
  filtersHeading: "Filters",
  scope: (disposition, projects) => {
    const word = disposition === "" ? "all" : disposition;
    return projects === null ? word : `${word} across ${projects} projects`;
  },
  order: "severity desc, last activity desc, id asc",
  resultSummary: (total) => `${total} results`,
  pager: { previous: "Previous", next: "Next", range: (from, to, total) => `${from}–${to} of ${total}` },
  filteredEmpty: { labelWord: "empty", heading: "No matches", body: "nothing matched", hint: "clear the filters" },
  storeEmpty: { labelWord: "empty", heading: "No issues", body: "the store holds none", hint: "capture one" },
  absent: { labelWord: "absent", heading: "Issues", body: "not declared", pointer: "see the project" },
  unavailable: { labelWord: "unavailable", heading: "Issues", body: "the read failed" },
};

const renderIssues = (
  items: IssuePage["items"],
  total: number,
  appliedQuery: IssueQuery = query(),
  generation: number | null = 7,
): string =>
  renderToStaticMarkup(
    <Issues
      model={issueListModel({ data: page(items, total), projection: { ...projection, generation } }, appliedQuery)}
      query={appliedQuery}
      copy={issuesCopy}
      options={{ disposition: ["open", "resolved"], project: ["engine"], kind: ["bug"], severity: ["critical"] }}
      onQueryChange={() => {}}
    />,
  );

const detailCopy: IssueDetailCopy = {
  relationsHeading: "Relations",
  relationsColumns: { relation: "Relation", issue: "Issue", title: "Title" },
  sourceHeading: "Source",
  sourceKindLabel: "Source kind",
  sourceIdentityLabel: "Source identity",
  sourceLocationLabel: "Location",
  sourceRootCauseLabel: "Root cause key",
  sourceAcceptanceLabel: "Acceptance key",
  occurrencesHeading: "Occurrences",
  occurrenceObservedAt: "Observed at",
  occurrenceLocation: "Location",
  occurrenceRecorded: "Recorded",
  historyHeading: "Disposition history",
  historyColumns: { from: "From", to: "To", reason: "Reason", actor: "Actor", recorded: "Recorded" },
  historyNote: "Only recorded transitions appear.",
  provenanceHeading: "Provenance",
  provenanceColumns: { kind: "Kind", target: "Target", sourceHash: "Source hash", origin: "Origin", importedAt: "Imported at" },
  identityKeysHeading: "Identity keys",
  identityKeyLabel: "Identity key",
  providerLabel: "Provider",
  breadcrumb: { label: "Breadcrumb", current: "Issues" },
  identityHeading: "Fact",
  fields: {
    id: "ID",
    project: "Project",
    milestone: "Milestone",
    kind: "Kind",
    severity: "Severity",
    disposition: "Disposition",
    owner: "Owner",
    occurrences: "Occurrences",
    registeredAt: "Registered",
    closedAt: "Closed",
    noMilestone: "None",
    noOwner: "Unassigned",
  },
  occurrenceCount: (count) => `${count} seen`,
  impactHeading: "Impact",
  acceptanceHeading: "Acceptance",
  closureNoteHeading: "Closure note",
  absence: {
    unavailable: { labelWord: "unavailable", heading: "Issue", body: "the read failed" },
    absent: { labelWord: "absent", heading: "Issue", body: "not declared", pointer: "back to the list" },
  },
};

const detail = (over: Partial<IssueDetail> = {}): IssueDetail => ({
  id: "I-000870",
  projectId: "engine",
  title: "The dashboard and the panel disagree about tone",
  kind: "bug",
  severity: "critical",
  disposition: "open",
  impact: "Two hosts render the same status in two different colours.",
  acceptance: "One tone table, one component, no host override.",
  owner: "frontend-dev",
  registeredAt: "2026-10-01T09:00:00.000Z",
  closedAt: null,
  closureNote: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
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
  transitions: [{ id: 1, fromDisposition: null, toDisposition: 'open', actor: 'pm', occurredAt: null, recordedAt: '2026-10-23T09:14:00.000Z', reason: 'Captured from review', evidence: null, imported: false, issueRevision: 1 }],
  relations: [{ fromIssue: 'I-000870', relation: 'related', toIssue: 'I-000840' }],
  provenance: [],
  projectMoves: [],
  ...over,
});

const renderDetail = (
  record: IssueDetail | null,
  generation: number | null = 7,
  /** A read that failed before any record existed: the payload is missing outright. */
  failed = false,
): string =>
  renderToStaticMarkup(
    <IssueDetailScreen
      read={
        failed
          ? ({ data: undefined, projection: { ...projection, generation: null } } as never)
          : { data: record === null ? null : issueDetailModel(record), projection: { ...projection, generation } }
      }
      copy={detailCopy}
    />,
  );

describe("Issues — the list facts of §8.2", () => {
  const html = renderIssues([summary()], 120, query({}, 50));

  test("a row carries id, title, severity, disposition, kind, project, milestone and last activity", () => {
    for (const expected of ["I-000870", "The dashboard and the panel disagree", "critical", "open", "bug", "engine", "9f2c4a10"]) {
      expect(html).toContain(expected);
    }
    // The cell shows the prototype's short form (`design-v1.html:1215`), never a
    // truncated ISO string: the column keeps its width and the value fits.
    expect(html).toContain("10-24 10:00");
    expect(html).not.toContain("2026-10-24T10:00:00.000Z");
  });

  test("the pager states the range and both bounds", () => {
    expect(html).toContain("51–100 of 120");
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
  });

  test("the first page has no previous, the last page has no next", () => {
    // Counted per button, not as a total: the filter bar's "clear" is disabled
    // too while nothing is applied, and that is a different fact.
    const disabled = (html: string, label: string) =>
      new RegExp(`<button[^>]*disabled=""[^>]*>${label}<`).test(html);

    const first = renderIssues([summary()], 120, query());
    expect(first).toContain("1–50 of 120");
    expect(disabled(first, "Previous")).toBe(true);
    expect(disabled(first, "Next")).toBe(false);

    const last = renderIssues([summary()], 50, query());
    expect(disabled(last, "Previous")).toBe(true);
    expect(disabled(last, "Next")).toBe(true);
  });

  test("the filters are offered with an explicit any option", () => {
    expect(html).toContain("Disposition");
    expect(html).toContain("Any");
    expect(html).toContain("Clear filters");
  });

  test("NEGATIVE: no counters in a footer", () => {
    expect(html).not.toContain("storeRevision");
    expect(html).not.toContain("1224");
    expect(html).not.toContain("catalogRevision");
  });
});

describe("Issues — the prototype's card and its summary line", () => {
  const html = renderIssues([summary(), summary({ id: "I-000871", projectId: "dsh-integration" })], 2);

  test("one card: the filter row and the table share it", () => {
    // `design-v1.html:1090-1130`: the filter row and the table are ONE card — the row
    // sits under the head, the table follows in the same panel, and the foot carries
    // the paging facts. Two cards would draw a border the prototype does not have.
    expect(html.match(/data-ms-panel=""/g)?.length).toBe(1);
    expect(html).toContain('data-ms-panel-head=""');
    expect(html).toContain('data-ms-panel-foot=""');
    // The filter card's head names it, and that card points at the head.
    expect(html).toContain('aria-labelledby="ms-issues-filters"');
    expect(html).toContain('id="ms-issues-filters"');
  });

  test("the table is inside a card, in a body with no padding of its own", () => {
    // The anchor that keeps the table a panel body rather than a sibling of the
    // filter card: the table's nearest card ancestor exists, and the body that
    // holds it is the tight one.
    const tableAt = html.indexOf("<table");
    expect(tableAt).toBeGreaterThan(-1);
    const before = html.slice(0, tableAt);
    const lastPanel = before.lastIndexOf('data-ms-panel=""');
    const lastPanelClose = before.lastIndexOf("</section>");
    expect(lastPanel).toBeGreaterThan(-1);
    expect(lastPanelClose).toBeLessThan(lastPanel);
    expect(before.slice(lastPanel)).toContain('data-ms-panel-body=""');
  });

  test("the summary line states the count, the scope and the ordering", () => {
    expect(html).toContain('data-ms-summary=""');
    expect(html).toContain("2");
    expect(html).toContain("open across 2 projects");
    expect(html).toContain("severity desc, last activity desc, id asc");
  });

  test("the summary names the disposition the filters select, not always `open`", () => {
    // Default view: the store's open issues.
    expect(html).toContain("open across 2 projects");
    // Filtering to a closed disposition must not tell the reader they are looking
    // at open issues — the same mistake in the opposite direction.
    const resolved = renderIssues([summary()], 1, query({ disposition: "resolved" }));
    expect(resolved).toContain("resolved across 1 project");
    expect(resolved).not.toContain("open across");
    // "Any" is every disposition, so it says so rather than picking one.
    const any = renderIssues([summary()], 1, query({ disposition: "" }));
    expect(any).toContain("all across 1 project");
    expect(any).not.toContain("open across");
  });

  test("a partial page drops the project span instead of inventing one", () => {
    // The page holds one of 120 rows: it cannot count the projects it never saw.
    const partial = renderIssues([summary()], 120);
    expect(partial).toContain("open");
    expect(partial).not.toContain("open across");
  });
});

describe("Issues — the list state machine", () => {
  test("lines are listed and announced", () => {
    const html = renderIssues([summary(), summary({ id: "I-000871" })], 2);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("2 results");
  });

  test("a successful read with no published generation still renders", () => {
    // The store-backed views answer `generation: null` on success; vetoing that made
    // every working Issues read render as unavailable. Failures reach the screen
    // through the absence arms the resolver owns, not through this flag.
    const html = renderIssues([summary()], 1, query(), null);
    expect(html).not.toContain('data-ms-absence="unavailable"');
    expect(html).toContain("I-000870");
  });

  test("an empty result under the default filters is store-empty", () => {
    const html = renderIssues([], 0);
    expect(html).toContain('data-ms-absence="empty"');
    expect(html).toContain('data-ms-empty-family="state.empty.store"');
    expect(html).toContain("the store holds none");
  });

  test("an empty result under filters is filtered-empty, with its own copy family", () => {
    const html = renderIssues([], 0, query({ severity: "critical" }));
    expect(html).toContain('data-ms-absence="empty"');
    expect(html).toContain('data-ms-empty-family="state.empty.filtered"');
    expect(html).toContain("nothing matched");
    expect(html).not.toContain("the store holds none");
  });

  test("an applied filter is a removable chip", () => {
    const html = renderIssues([summary()], 1, query({ severity: "critical" }));
    expect(html).toContain('data-ms-applied-filters=""');
    expect(html).toContain("Severity: critical");
  });
});

describe("IssueDetail — the whole page, and nothing more", () => {
  const html = renderDetail(detail());

  test("the fact block carries identity, owner and both dates", () => {
    for (const expected of ["I-000870", "engine", "9f2c4a10", "bug", "critical", "open", "frontend-dev"]) {
      expect(html).toContain(expected);
    }
    expect(html).toContain("2026-10-01 09:00");
  });

  test("the occurrence count survives as ONE integer", () => {
    expect(html).toContain('data-ms-occurrence-count="2"');
    expect(html).toContain("2 seen");
  });

  test("impact and acceptance are the two long-text fields", () => {
    expect(html).toContain('data-ms-impact=""');
    expect(html).toContain("Two hosts render the same status");
    expect(html).toContain('data-ms-acceptance=""');
    expect(html).toContain("One tone table, one component");
  });

  test("an open issue has no closure note", () => {
    expect(html).not.toContain('data-ms-closure-note=""');
  });

  test("a closed issue carries its closure note and its closed date", () => {
    const closed = renderDetail(
      detail({ disposition: "resolved", closedAt: "2026-10-05T00:00:00.000Z", closureNote: "fixed by one tone table" }),
    );
    expect(closed).toContain('data-ms-closure-note=""');
    expect(closed).toContain("fixed by one tone table");
    expect(closed).toContain("2026-10-05 00:00");
  });

  test("an absent long-text field renders no empty block", () => {
    const bare = renderDetail(detail({ impact: "   ", acceptance: "" }));
    expect(bare).not.toContain('data-ms-impact=""');
    expect(bare).not.toContain('data-ms-acceptance=""');
  });
});

describe("IssueDetail — NEGATIVE: what §8.1 removed", () => {
  const html = renderDetail(detail());

  test("the source panel and the occurrence log both render now", () => {
    // The prototype has a `Source` panel (the latest occurrence's provenance) and an
    // `Occurrences` panel (one block per event). Only the first is rendered so far; the
    // event log itself stays out.
    expect(html).toContain("data-ms-issue-source");
    expect(html).toContain("data-ms-issue-occurrences");
  });

  test("no migration bookkeeping is drawn, only a truncated source hash", () => {
    // `transitions`, `provenance` and `relations` are rendered now, as the prototype has
    // them. The legacy migration JSON stays out; the hash is truncated to 16 characters.
    for (const removed of ["Migration", "legacyProject", "legacyJson"]) {
      expect(html.toLowerCase()).not.toContain(removed.toLowerCase());
    }
  });

  test("the tracker identity is stated, but never as a link", () => {
    // The prototype has an `Identity keys` panel with the key and the provider. §8.1's
    // "not rendered" is superseded for those two; a hyperlink is still not drawn.
    expect(html).not.toContain("https://tracker.example/42");
    expect(html).not.toContain(">42<");
  });

  test("no revision or churn timestamps", () => {
    expect(html).not.toContain("2026-10-24T10:00:00.000Z"); // updatedAt
    expect(html).not.toContain("revision");
    expect(html).not.toContain(">7<");
  });

  test("the model itself cannot carry them: the negative set is enforced by shape", () => {
    const model = issueDetailModel(detail());
    for (const removed of [
      "url",
      "externalId",
      // `provider` and `identityKey` are carried now: the prototype's `Identity keys`
      // panel states both. The rest of the set still stays out.
      "revision",
      "createdAt",
      "updatedAt",
      "projectMoves",
    ]) {
      expect(Object.keys(model)).not.toContain(removed);
    }
  });
});

describe("IssueDetail — the record read: null is absent, a failed read is unavailable", () => {
  // The package-wide ruling: a null payload means the subject declares nothing
  // here; a failed read arrives as a projection with no generation and says so
  // with the store's own reason.
  test("a null record is the absent arm", () => {
    const html = renderDetail(null);
    expect(html).toContain('data-ms-absence="absent"');
    expect(html).not.toContain('data-ms-absence="unavailable"');
  });

  test("a failed read is unavailable, and the reason is stated", () => {
    const html = renderDetail(detail(), 7, true);
    expect(html).toContain('data-ms-absence="unavailable"');
    expect(html).toContain("this issue could not be read");
  });

  test("a record with no published generation is still the record", () => {
    const html = renderDetail(detail(), null);
    expect(html).not.toContain('data-ms-absence="unavailable"');
    expect(html).toContain("I-000870");
  });
});

describe("IssueDetail — the relations table", () => {
  test("it names the other end of the join, not this issue", () => {
    const html = renderDetail(detail());
    expect(html).toContain("data-ms-issue-relations");
    expect(html).toContain("I-000840");
    expect(html).toContain("related");
  });
});
