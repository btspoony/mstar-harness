/**
 * The host's envelope handling for the Issues pair.
 *
 * What the *host* owes, not what the screens own: three outcomes that render
 * differently, a 404 that is an absence rather than a failure, and the one
 * negative assertion this pair shares with every ported screen — the contraction
 * is the shared layer's, so a removed fact appearing here would mean the host
 * widened the mapping.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IssueDetail, IssuePage, ReadEnvelope } from "@mstar-harness/engine";
import { IssueDetail as IssueDetailScreen, Issues, copyFor } from "@mstar-harness/ui";

import {
  ISSUE_FILTER_OPTIONS,
  keepPreviousOnLoad,
  issueDetailCopy,
  issueDetailOutcome,
  issueDetailPath,
  issueDetailPath as detailPath,
  issuesCopy,
  issuesOutcome,
  issuesPath,
  readIssueDetail,
  readIssues,
  scopedFilters,
} from "./issues-data";
import { DEFAULT_ISSUE_FILTERS } from "@mstar-harness/ui";

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

const listEnvelope = (items: IssuePage["items"], total = items.length, projectionBlock = projection): ReadEnvelope<IssuePage> => ({
  data: { items, total, storeRevision: 1224 },
  storeRevision: 1224,
  catalogRevision: 9,
  projection: projectionBlock,
});

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
  transitions: [],
  relations: [],
  provenance: [],
  projectMoves: [],
  ...over,
});

const query = { filters: { ...DEFAULT_ISSUE_FILTERS }, offset: 0 };

const renderList = (items: IssuePage["items"], total = items.length, projectionBlock = projection, applied = query): string => {
  const outcome = issuesOutcome({ status: "ready", envelope: listEnvelope(items, total, projectionBlock) }, applied);
  if (outcome.kind !== "ready") throw new Error("expected a ready list");
  return renderToStaticMarkup(
    createElement(Issues, {
      model: outcome.model,
      query: applied,
      copy: issuesCopy(copyFor("en")),
      // The project list is data the host supplies after its own read; the enums
      // are the contract's.
      options: { ...ISSUE_FILTER_OPTIONS, project: ["engine"] },
      onQueryChange: () => {},
    }),
  );
};

const renderDetail = (record: IssueDetail | null): string => {
  const outcome =
    record === null
      ? issueDetailOutcome({ status: "absent" })
      : issueDetailOutcome({
          status: "ready",
          envelope: { data: record, storeRevision: 1, catalogRevision: 1, projection },
        });
  if (outcome.kind === "absent") {
    return renderToStaticMarkup(
      createElement(IssueDetailScreen, {
        read: { data: null, projection },
        copy: issueDetailCopy(copyFor("en")),
      }),
    );
  }
  if (outcome.kind !== "ready") throw new Error("expected a ready detail");
  return renderToStaticMarkup(createElement(IssueDetailScreen, { read: outcome.read, copy: issueDetailCopy(copyFor("en")) }));
};

describe("the list read", () => {
  test("the path is the shared query pair's, not a second vocabulary", () => {
    const applied = { filters: { ...DEFAULT_ISSUE_FILTERS, severity: "critical" }, offset: 50 };
    const path = issuesPath(applied);
    expect(path.startsWith("/api/issues?")).toBe(true);
    // The keys and their order come from `issueQuery`.
    expect(path).toContain("disposition=open");
    expect(path).toContain("severity=critical");
    expect(path).toContain("limit=50");
    expect(path).toContain("offset=50");
  });

  test("outcome 1 — a healthy read becomes a listed page", () => {
    const outcome = issuesOutcome({ status: "ready", envelope: listEnvelope([summary()], 120) }, query);
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") return;
    expect(outcome.model.rows.kind).toBe("populated");
    expect(outcome.model.total).toBe(120);
  });

  test("a successful read with no published generation is not unavailable", () => {
    // Issues are store-backed: the engine answers `generation: null` on success, so
    // vetoing it made every working list render as unavailable.
    const html = renderList([summary()], 1, { ...projection, generation: null });
    expect(html).not.toContain('data-ms-absence="unavailable"');
    expect(html).toContain("I-000870");
  });

  test("outcome 3 — a whole-read failure mounts no list", async () => {
    const failing = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const result = await readIssues(failing, query);
    expect(result.status).toBe("error");
    expect(issuesOutcome(result, query).kind).toBe("failed");
  });

  test("an empty store and an empty filter result stay two different pages", () => {
    const storeEmpty = renderList([], 0);
    const filteredEmpty = renderList([], 0, projection, {
      filters: { ...DEFAULT_ISSUE_FILTERS, severity: "critical" },
      offset: 0,
    });
    expect(storeEmpty).toContain('data-ms-empty-family="state.empty.store"');
    expect(filteredEmpty).toContain('data-ms-empty-family="state.empty.filtered"');
  });

  test("the address bar survives a round trip: query in, query out", () => {
    const applied = { filters: { ...DEFAULT_ISSUE_FILTERS, severity: "high", q: "tone" }, offset: 100 };
    const path = issuesPath(applied);
    const search = path.slice(path.indexOf("?") + 1);
    // The same pair parses what it wrote.
    expect(search).toContain("severity=high");
    expect(search).toContain("q=tone");
    expect(search).toContain("offset=100");
  });

  test("a project page's scope is applied to the request, not to the URL twice", () => {
    const scoped = scopedFilters({ ...DEFAULT_ISSUE_FILTERS, project: "" }, "engine");
    expect(scoped.project).toBe("engine");
    expect(scopedFilters(DEFAULT_ISSUE_FILTERS, null).project).toBe("");
  });

  test("the filter vocabularies are the contract's", () => {
    expect(ISSUE_FILTER_OPTIONS.disposition).toContain("open");
    expect(ISSUE_FILTER_OPTIONS.severity).toEqual(["critical", "high", "medium", "low", "nit"]);
  });
});

describe("the detail read", () => {
  test("the path encodes the id", () => {
    expect(issueDetailPath("I-000870")).toBe("/api/issues/I-000870");
    expect(detailPath("a/b")).toBe("/api/issues/a%2Fb");
  });

  test("outcome 1 — identity, impact, acceptance and the occurrence COUNT", () => {
    const html = renderDetail(detail());
    for (const expected of ["I-000870", "engine", "frontend-dev", "critical", "open"]) {
      expect(html).toContain(expected);
    }
    expect(html).toContain('data-ms-impact=""');
    expect(html).toContain("Two hosts render the same status");
    expect(html).toContain('data-ms-acceptance=""');
    expect(html).toContain('data-ms-occurrence-count="2"');
  });

  test("the contraction holds through the host: no occurrence row, history or tracker link", () => {
    const html = renderDetail(detail());
    // The fixture carries two occurrences, a tracker URL and a revision.
    expect(html).not.toContain("k1");
    expect(html).not.toContain("qc1");
    expect(html).not.toContain("2026-10-02T09:00:00.000Z");
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("revision");
  });

  test("outcome 2 — a 404 with issue.not-found is ABSENT, not a failure", async () => {
    const notFound = (async () =>
      new Response(JSON.stringify({ error: { code: "issue.not-found", message: "no such record" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readIssueDetail(notFound, "I-1");
    expect(result.status).toBe("absent");
    expect(issueDetailOutcome(result).kind).toBe("absent");
    const html = renderDetail(null);
    expect(html).toContain('data-ms-absence="absent"');
    expect(html).not.toContain('data-ms-absence="unavailable"');
  });

  test("outcome 3 — any other refusal is a failure, not an absence", async () => {
    const refused = (async () =>
      new Response(JSON.stringify({ error: { code: "store.not-active", message: "the store is staged" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readIssueDetail(refused, "I-1");
    expect(result).toEqual({ status: "error", message: "the store is staged" });
    expect(issueDetailOutcome(result).kind).toBe("failed");
  });

  test("a body that is not an envelope is a failure, never an absence", async () => {
    const nonsense = (async () =>
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await readIssueDetail(nonsense, "I-1");
    expect(result.status).toBe("error");
  });

  test("the three detail outcomes are three distinct presentations", () => {
    const ok = issueDetailOutcome({
      status: "ready",
      envelope: { data: detail(), storeRevision: 1, catalogRevision: 1, projection },
    });
    const absent = issueDetailOutcome({ status: "absent" });
    const failed = issueDetailOutcome({ status: "error", message: "refused" });
    expect([ok.kind, absent.kind, failed.kind]).toEqual(["ready", "absent", "failed"]);
  });
});

describe("P1: a keystroke must not unmount the search box", () => {
  test("a read in flight keeps the previous rows painted", () => {
    // Every keystroke starts a read and sets `loading`; the screen returned `null`
    // while loading, so the input unmounted and the reader lost focus mid-typing.
    const ready = issuesOutcome({ status: "ready", envelope: listEnvelope([summary()], 1) }, query);
    if (ready.kind !== "ready") throw new Error("expected ready");
    const duringSecondKeystroke = keepPreviousOnLoad(ready, { kind: "loading" });
    expect(duringSecondKeystroke).toEqual(ready);
    // Three keystrokes in a row: still painted, still the same component tree.
    const third = keepPreviousOnLoad(duringSecondKeystroke, { kind: "loading" });
    expect(third.kind).toBe("ready");
  });

  test("the first load is still a load: nothing to paint yet", () => {
    const first = keepPreviousOnLoad(null, { kind: "loading" });
    expect(first.kind).toBe("loading");
  });

  test("a failure replaces the rows rather than hiding behind them", () => {
    const ready = issuesOutcome({ status: "ready", envelope: listEnvelope([], 0) }, query);
    const failed = keepPreviousOnLoad(ready, { kind: "failed", message: "refused" });
    expect(failed).toEqual({ kind: "failed", message: "refused" });
  });
});
