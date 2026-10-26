/**
 * Issues list + detail transforms.
 *
 * The address-bar pair (`parseIssueQuery` / `issueQuery`) and the default filters
 * are preserved **behaviour for behaviour** from the dashboard that worked: an
 * unknown enum value falls back to the default instead of being sent to the
 * server, the offset resets to 0 through the page size, and the query string is
 * emitted in a fixed field order so a URL is stable.
 *
 * IA §8.2 fixes the fact sets: a row carries id, title, severity, disposition,
 * kind, project, milestone and last activity; the detail page carries one fact
 * block plus the two long-text fields. Occurrences, disposition history,
 * provenance, relations, external links and revision metadata are **not**
 * produced here — the DTO still carries them (carried-but-never-drawn) and a
 * screen must not resurrect them.
 */
import type { IssueDetail, IssuePage } from "@mstar-harness/engine";

import type { Resolved } from "./state.ts";
import { resolveRead } from "./state.ts";
import {
  DISPOSITIONS,
  ISSUE_KINDS,
  SEVERITIES,
  dispositionTone,
  severityIsEmphasised,
  severityTone,
  type Tone,
} from "./status.ts";
import { UNKNOWN_DATE, formatDate, formatShortDate, longText } from "./format.ts";

/** Fixed page size; the read model's own default (`issue contract §5`). */
export const PAGE_SIZE = 50;

/** The filters the list carries. Empty string means "any". */
export type IssueFilters = {
  project: string;
  disposition: string;
  kind: string;
  severity: string;
  q: string;
};

/** One query: filters plus the page offset. */
export type IssueQuery = { filters: IssueFilters; offset: number };

/**
 * List defaults: open-only, all projects. The dashboard's `D17` ordering (open
 * across all projects) is what makes the landing list answer "what is wrong".
 */
export const DEFAULT_ISSUE_FILTERS: Readonly<IssueFilters> = Object.freeze({
  project: "",
  disposition: "open",
  kind: "",
  severity: "",
  q: "",
});

/** The closed (unfiltered-by-severity) query a "clear filters" acts on. */
export const DEFAULT_ISSUE_QUERY: Readonly<IssueQuery> = Object.freeze({
  filters: DEFAULT_ISSUE_FILTERS,
  offset: 0,
});

const ACCEPTED: Record<"disposition" | "kind" | "severity", readonly string[]> = {
  disposition: DISPOSITIONS,
  kind: ISSUE_KINDS,
  severity: SEVERITIES,
};

/**
 * The address bar → the applied query. Unknown enum values and a malformed
 * offset fall back to the defaults rather than being forwarded to a read that
 * would refuse them.
 */
export function parseIssueQuery(search: string): IssueQuery {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const filters: IssueFilters = { ...DEFAULT_ISSUE_FILTERS };
  const project = params.get("project");
  if (project !== null) filters.project = project;
  for (const field of ["disposition", "kind", "severity"] as const) {
    const value = params.get(field);
    // An empty value is the "Any" option: it clears the filter rather than being an
    // unknown literal. Without this, choosing Any re-parsed as the default `open` and
    // silently filtered the list to open issues.
    if (value === "") filters[field] = "";
    else if (value !== null && ACCEPTED[field].includes(value)) filters[field] = value;
  }
  const q = params.get("q");
  if (q !== null) filters.q = q;
  const rawOffset = params.get("offset");
  const offset = rawOffset !== null && /^[0-9]+$/.test(rawOffset) ? Number(rawOffset) : 0;
  return { filters, offset };
}

/** The applied query → the read/address-bar query string, in a fixed field order. */
export function issueQuery(query: IssueQuery): string {
  const params = new URLSearchParams();
  params.set("disposition", query.filters.disposition);
  if (query.filters.project !== "") params.set("project", query.filters.project);
  if (query.filters.kind !== "") params.set("kind", query.filters.kind);
  if (query.filters.severity !== "") params.set("severity", query.filters.severity);
  if (query.filters.q !== "") params.set("q", query.filters.q);
  params.set("limit", String(PAGE_SIZE));
  if (query.offset > 0) params.set("offset", String(query.offset));
  return params.toString();
}

/** Whether the default filters are still applied (drives the "clear" affordance). */
export function isDefaultIssueFilters(filters: IssueFilters): boolean {
  return (
    filters.project === DEFAULT_ISSUE_FILTERS.project &&
    filters.disposition === DEFAULT_ISSUE_FILTERS.disposition &&
    filters.kind === DEFAULT_ISSUE_FILTERS.kind &&
    filters.severity === DEFAULT_ISSUE_FILTERS.severity &&
    filters.q === DEFAULT_ISSUE_FILTERS.q
  );
}

/** The filters that are actually narrowing the list, as filter chips. */
export function activeIssueFilters(filters: IssueFilters): Array<{ field: keyof IssueFilters; value: string }> {
  const active: Array<{ field: keyof IssueFilters; value: string }> = [];
  for (const field of ["project", "kind", "severity", "q"] as const) {
    if (filters[field] !== "") active.push({ field, value: filters[field] });
  }
  // The default disposition is "open", so it is not a narrowing chip; any other
  // disposition is.
  if (filters.disposition !== DEFAULT_ISSUE_FILTERS.disposition) {
    active.push({ field: "disposition", value: filters.disposition });
  }
  return active;
}

/** Clear one filter back to its default. */
export function clearIssueFilter(filters: IssueFilters, field: keyof IssueFilters): IssueFilters {
  return { ...filters, [field]: field === "disposition" ? DEFAULT_ISSUE_FILTERS.disposition : "" };
}

/** One list row, as IA §8.2 lists it. */
export type IssueRow = {
  id: string;
  title: string;
  projectId: string;
  kind: string;
  severity: string;
  severityTone: Tone;
  severityEmphasised: boolean;
  disposition: string;
  dispositionTone: Tone;
  /** The milestone this issue is assigned to, or `null` when it has none. */
  milestoneId: string | null;
  /** The stored activity timestamp, or the `Date unknown` copy. */
  lastActivity: string;
};

/** One row from the page DTO. Order is the read's (severity, activity, id). */
export function issueRow(issue: IssuePage["items"][number]): IssueRow {
  return {
    id: issue.id,
    title: issue.title,
    projectId: issue.projectId,
    kind: issue.kind,
    severity: issue.severity,
    severityTone: severityTone(issue.severity),
    severityEmphasised: severityIsEmphasised(issue.severity),
    disposition: issue.disposition,
    dispositionTone: dispositionTone(issue.disposition),
    milestoneId: issue.milestoneId,
    lastActivity: formatShortDate(issue.lastActivity),
  };
}

/** The list's resolved content and its paging facts. */
export type IssueListModel = {
  rows: Resolved<readonly IssueRow[]>;
  total: number;
  /**
   * How many projects this result set spans, or `null` when the page holds only
   * part of it: a partial page cannot count the projects it never saw, and a
   * guessed span would be the kind of invented figure the read rules forbid.
   */
  projectCount: number | null;
  offset: number;
  pageSize: number;
  /** 1-based page number, for the pager. */
  page: number;
  /** Whether a next/previous page exists. */
  hasNext: boolean;
  hasPrevious: boolean;
};

/**
 * The list state machine: `listed` / `empty` / `unavailable`, plus the paging
 * facts. A projected view with no valid generation is `unavailable` — never
 * `empty`, which would claim the store holds no issues.
 */
export function issueListModel(
  read: { data: IssuePage; projection: { generation: number | null } },
  query: IssueQuery,
  phase: "loading" | "loaded" = "loaded",
): IssueListModel {
  const rows = resolveRead(
    { data: read.data.items, projection: read.projection },
    { phase, whenNull: "empty", isEmpty: (items) => items.length === 0 },
  );
  const mapped: Resolved<readonly IssueRow[]> =
    rows.kind === "populated" ? { kind: "populated", value: rows.value.map(issueRow) } : rows;
  const total = read.data.total;
  const offset = query.offset;
  const complete = read.data.items.length === total;
  return {
    rows: mapped,
    total,
    projectCount:
      // A project filter pins the result set to that one project: that is a fact about
      // the query, not a count of what this page happened to see. Without a filter the
      // span is only knowable from a complete read.
      query.filters.project !== ""
        ? 1
        : complete
          ? new Set(read.data.items.map((item) => item.projectId)).size
          : null,
    offset,
    pageSize: PAGE_SIZE,
    page: Math.floor(offset / PAGE_SIZE) + 1,
    hasNext: offset + PAGE_SIZE < total,
    hasPrevious: offset > 0,
  };
}

/**
 * One issue's fact block. IA §8.2: id, title, project, milestone, kind, severity,
 * disposition, owner, the occurrence **count**, registered date, closed date —
 * then the two long-text fields, and the closure note only when closed.
 *
 * The occurrence count is one integer; the occurrence rows themselves are not
 * returned (IA §8.1). `registeredAt` / `closedAt` survive where `createdAt` /
 * `updatedAt` / `revision` do not, because those two are the dates that mean
 * something to a reader.
 */
export type IssueDetailModel = {
  id: string;
  title: string;
  projectId: string;
  milestoneId: string | null;
  kind: string;
  severity: string;
  severityTone: Tone;
  severityEmphasised: boolean;
  disposition: string;
  dispositionTone: Tone;
  owner: string | null;
  /** How many times this issue has been seen. One integer, never a list. */
  occurrenceCount: number;
  registeredAt: string;
  closedAt: string | null;
  impact: string | null;
  acceptance: string | null;
  /** Present only when the issue is closed and the store recorded a note. */
  closureNote: string | null;
  /** The prototype's `Identity keys` panel: the tracker identity, when the store has one. */
  identityKey: string | null;
  provider: string | null;
  /** The prototype's `Occurrences`: one block per recorded event, newest last. */
  occurrences: ReadonlyArray<{
    id: number;
    sourceKind: string;
    sourceIdentity: string;
    observedBehavior: string;
    location: string | null;
    recordedAt: string;
    evidence: readonly string[];
  }>;
  /** The prototype's `Disposition history` table: every recorded transition. */
  transitions: ReadonlyArray<{
    from: string | null;
    to: string;
    reason: string | null;
    actor: string | null;
    recordedAt: string;
  }>;
  /** The prototype's `Provenance` table: how this record was imported. */
  provenance: ReadonlyArray<{
    kind: string;
    target: string;
    sourceHash: string | null;
    origin: string;
    importedAt: string | null;
  }>;
  /** The prototype's `Relations` table: what this issue is joined to. */
  relations: ReadonlyArray<{ relation: string; issue: string; title: string | null }>;
  /** The prototype's `Source` panel: the latest occurrence's own account of itself. */
  source: {
    kind: string;
    identity: string;
    location: string | null;
    rootCauseKey: string | null;
    acceptanceKey: string | null;
  } | null;
};

export function issueDetailModel(detail: IssueDetail): IssueDetailModel {
  const closed = detail.disposition !== "open";
  return {
    id: detail.id,
    title: detail.title,
    projectId: detail.projectId,
    milestoneId: detail.milestoneId,
    kind: detail.kind,
    severity: detail.severity,
    severityTone: severityTone(detail.severity),
    severityEmphasised: severityIsEmphasised(detail.severity),
    disposition: detail.disposition,
    dispositionTone: dispositionTone(detail.disposition),
    owner: detail.owner,
    occurrenceCount: detail.occurrences.length,
    registeredAt: formatDate(detail.registeredAt),
    closedAt: closed ? formatDate(detail.closedAt) : null,
    impact: longText(detail.impact),
    acceptance: longText(detail.acceptance),
    closureNote: closed ? longText(detail.closureNote) : null,
    identityKey: detail.identityKey ?? null,
    provider: detail.provider ?? null,
    occurrences: detail.occurrences.map((row) => ({
      id: row.id,
      sourceKind: row.sourceKind,
      sourceIdentity: row.sourceIdentity,
      observedBehavior: row.observedBehavior,
      location: row.location ?? null,
      recordedAt: formatDate(row.recordedAt),
      evidence: row.evidence,
    })),
    transitions: detail.transitions.map((row) => ({
      // The prototype prints `—` for the first transition, which has no `from`.
      from: row.fromDisposition ?? null,
      to: row.toDisposition,
      reason: longText(row.reason),
      actor: row.actor ?? null,
      recordedAt: formatDate(row.recordedAt),
    })),
    provenance: detail.provenance.map((row) => ({
      kind: row.kind,
      target: row.target,
      sourceHash: row.sourceHash ?? null,
      origin: row.origin,
      importedAt: row.importedAt === null ? null : formatDate(row.importedAt),
    })),
    relations: detail.relations.map((relation) => ({
      relation: relation.relation,
      // The row names the other end of the join, not this issue.
      issue: relation.fromIssue === detail.id ? relation.toIssue : relation.fromIssue,
      title: null,
    })),
    // The prototype's Source panel states the newest occurrence's provenance.
    source:
      detail.occurrences.length === 0
        ? null
        : {
            kind: detail.occurrences[0]!.sourceKind,
            identity: detail.occurrences[0]!.sourceIdentity,
            location: detail.occurrences[0]!.location ?? null,
            rootCauseKey: detail.occurrences[0]!.rootCauseKey ?? null,
            acceptanceKey: detail.occurrences[0]!.acceptanceKey ?? null,
          },
  };
}

/** The `Date unknown` copy, re-exported so a screen needs one import for it. */
export { UNKNOWN_DATE };
