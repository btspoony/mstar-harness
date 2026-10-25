/**
 * The host's half of the Issues pair: two reads, the envelope outcomes, and the
 * copy each shared screen needs.
 *
 * The same three-outcome discipline as Overview, with one addition the detail
 * route forces:
 *
 *  - **ok** — a `ReadEnvelope<IssuePage>` / `ReadEnvelope<IssueDetail>`; the host
 *    hands it to the shared model and unwraps nothing.
 *  - **a degraded member** — for the list this is a projection with no generation
 *    while the catalog is readable; the shared model answers `unavailable` and the
 *    host renders it as such. It must never be drawn as "nothing here".
 *  - **a whole-read failure** — no envelope at all.
 *  - **absent (detail only)** — the server answers `404 issue.not-found`. That is a
 *    transport fact ("there is no record at this address"), which the package-wide
 *    ruling maps to the `absent` arm — not to `unavailable`, and not to a page
 *    that pretends the issue exists with empty fields.
 *
 * The address-bar query is the shared pair's, imported rather than re-derived; this
 * module only decides *which path* a query produces.
 */
import type { IssueDetail, IssuePage, ReadEnvelope } from "@mstar-harness/engine";

import { UNREACHABLE, asEnvelope, refusalMessage } from "./read-envelope";
import {
  issueDetailModel,
  issueListModel,
  issueQuery,
  type Copy,
  type IssueDetailCopy,
  type IssueDetailModel,
  type IssueFilters,
  type IssueListModel,
  type IssueQuery,
  type IssuesCopy,
} from "@mstar-harness/ui";

/** Where the list and one issue answer. */
export function issuesPath(query: IssueQuery): string {
  return `/api/issues?${issueQuery(query)}`;
}

export function issueDetailPath(id: string): string {
  return `/api/issues/${encodeURIComponent(id)}`;
}

/**
 * The list screen's copy, composed from one dictionary.
 *
 * The shared package ships the sections; the pager labels, the "any" option and
 * the two empty families are composition. This duplicates the shared package's own
 * `copyForScreen` composition (still test-local there) — when that export lands,
 * both collapse to a call.
 */
export function issuesCopy(copy: Copy): IssuesCopy {
  return {
    ...copy.issues,
    pager: { previous: copy.common.previous, next: copy.common.next, range: copy.issues.range },
    anyOption: copy.common.anyOption,
    filteredEmpty: { ...copy.state["empty-filtered"], heading: copy.issues.pageTitle },
    storeEmpty: { ...copy.state.empty, heading: copy.issues.pageTitle },
    absent: { ...copy.state.absent, heading: copy.issues.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.issues.pageTitle },
  };
}

/** The detail screen's copy. */
export function issueDetailCopy(copy: Copy): IssueDetailCopy {
  return {
    ...copy.issueDetail,
    absence: {
      unavailable: { ...copy.state.unavailable, heading: copy.issueDetail.identityHeading },
      absent: { ...copy.state.absent, heading: copy.issueDetail.identityHeading },
    },
  };
}

/** What the list screen is handed. */
export type IssuesOutcome =
  | { kind: "loading" }
  | { kind: "ready"; model: IssueListModel }
  | { kind: "failed"; message: string };

/** What the detail screen is handed. */
export type IssueDetailOutcome =
  | { kind: "loading" }
  | { kind: "ready"; read: { data: IssueDetailModel; projection: ReadEnvelope<IssueDetail>["projection"] } }
  | { kind: "absent" }
  | { kind: "failed"; message: string };

/** The error code a refusal carries, or `null`. */
function refusalCode(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const error = (body as { error?: { code?: unknown } }).error;
  return error !== undefined && typeof error.code === "string" ? error.code : null;
}

/** One list read. */
export async function readIssues(
  fetchImpl: typeof fetch,
  query: IssueQuery,
  signal?: AbortSignal,
): Promise<{ status: "ready"; envelope: ReadEnvelope<IssuePage> } | { status: "error"; message: string }> {
  try {
    const response = await fetchImpl(issuesPath(query), {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
    const envelope = asEnvelope<IssuePage>(body);
    if (envelope === null) return { status: "error", message: "The issue list answered with something that is not a read envelope." };
    return { status: "ready", envelope };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}

/**
 * One record read.
 *
 * `404` is `absent`, not a failure: the record is not there. Every other refusal
 * is a failure, and a 200 that is not an envelope is a failure too — never an
 * absence.
 */
export async function readIssueDetail(
  fetchImpl: typeof fetch,
  id: string,
  signal?: AbortSignal,
): Promise<
  | { status: "ready"; envelope: ReadEnvelope<IssueDetail> }
  | { status: "absent" }
  | { status: "error"; message: string }
> {
  try {
    const response = await fetchImpl(issueDetailPath(id), {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 404 && refusalCode(body) === "issue.not-found") return { status: "absent" };
    if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
    const envelope = asEnvelope<IssueDetail>(body);
    if (envelope === null) return { status: "error", message: "The issue read answered with something that is not a read envelope." };
    if (envelope.data === null) return { status: "absent" };
    return { status: "ready", envelope };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}

/** The list outcome for a settled read. */
export function issuesOutcome(
  result:
    | { status: "loading" }
    | { status: "ready"; envelope: ReadEnvelope<IssuePage> }
    | { status: "error"; message: string },
  query: IssueQuery,
): IssuesOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "ready":
      return { kind: "ready", model: issueListModel(result.envelope, query) };
    case "error":
      return { kind: "failed", message: result.message };
  }
}

/** The detail outcome for a settled read. */
export function issueDetailOutcome(
  result:
    | { status: "loading" }
    | { status: "ready"; envelope: ReadEnvelope<IssueDetail> }
    | { status: "absent" }
    | { status: "error"; message: string },
): IssueDetailOutcome {
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "absent":
      return { kind: "absent" };
    case "error":
      return { kind: "failed", message: result.message };
    case "ready":
      return {
        kind: "ready",
        read: { data: issueDetailModel(result.envelope.data), projection: result.envelope.projection },
      };
  }
}

/** The filter vocabularies the bar offers; the project list is data the host supplies. */
export const ISSUE_FILTER_OPTIONS = {
  disposition: ["open", "resolved", "waived", "duplicate", "superseded"],
  kind: ["bug", "risk", "improvement", "request", "decision", "review-obligation"],
  severity: ["critical", "high", "medium", "low", "nit"],
} as const;

/** The filters a list request applies, with a project scope forced when the page owns one. */
export function scopedFilters(filters: IssueFilters, projectId: string | null): IssueFilters {
  return projectId === null ? filters : { ...filters, project: projectId };
}
