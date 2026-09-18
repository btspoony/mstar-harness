/**
 * Issues view-model (plan 20260918-dashboard D3).
 *
 * The three edges the task brief names — filter defaults/round-trip, history
 * derived strictly from recorded events, and unknown dates — are checked here
 * against real DTO shapes. Rendering is D5's actual local browser smoke; no
 * test asserts a mocked HTML string.
 */
import { describe, expect, test } from "bun:test";
import type { IssueDetail, IssueFlow } from "@mstar-harness/engine";

import type { LoadState } from "./components";
import { UNKNOWN_DATE, evidenceText, externalLinkHref, formatDate, migrationNote } from "./format";
import {
  DEFAULT_ISSUE_FILTERS,
  captureOccurrence,
  capturedTotal,
  emptyListState,
  issueQuery,
  isDefaultFilters,
  occurrenceRows,
  parseIssueQuery,
  transitionRows,
} from "./views/issues";

type IssueOccurrence = IssueDetail["occurrences"][number];
type IssueTransition = IssueDetail["transitions"][number];
type IssueProvenance = IssueDetail["provenance"][number];

const RECORDED_AT = "2026-09-18T02:00:00.000Z";
const IMPORT_LABEL = "Imported from projects/proj-a/residuals.json (proj-a / closed #R1)";

function occurrence(id: number, discoveredAt: string | null, overrides: Partial<IssueOccurrence> = {}): IssueOccurrence {
  return {
    id,
    occurrenceKey: `occ-${id}`,
    sourceKind: "review",
    sourceIdentity: `packages/engine/src/issue.ts#finding-${id}`,
    rootCauseKey: "root-cause",
    acceptanceKey: "acceptance",
    location: "packages/engine/src/issue.ts",
    observedBehavior: "observed behaviour",
    evidence: ["a log line"],
    discoveredAt,
    recordedAt: RECORDED_AT,
    imported: false,
    ...overrides,
  };
}

function transition(id: number, occurredAt: string | null, overrides: Partial<IssueTransition> = {}): IssueTransition {
  return {
    id,
    fromDisposition: "open",
    toDisposition: "resolved",
    actor: "project-manager",
    occurredAt,
    recordedAt: RECORDED_AT,
    reason: "acceptance met",
    evidence: null,
    imported: false,
    issueRevision: 2,
    ...overrides,
  };
}

function detail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    id: "I-000001",
    projectId: "proj-a",
    title: "issue title",
    kind: "bug",
    severity: "high",
    disposition: "open",
    impact: "impact",
    acceptance: "acceptance",
    owner: null,
    registeredAt: "2026-01-02",
    closedAt: null,
    closureNote: null,
    createdAt: RECORDED_AT,
    updatedAt: RECORDED_AT,
    revision: 1,
    provider: "local",
    externalId: null,
    url: null,
    identityKey: "identity",
    occurrences: [],
    transitions: [],
    relations: [],
    provenance: [],
    ...overrides,
  };
}

const MIGRATION_PROVENANCE: IssueProvenance[] = [
  {
    id: 1,
    kind: "migration",
    target: "projects/proj-a/residuals.json",
    sourceHash: "0f1e2d",
    legacyProject: "proj-a",
    legacyBucket: "closed",
    legacyEntryId: "R1",
    legacyJson: '{"lifecycle":"wont-fix"}',
    importedAt: RECORDED_AT,
  },
];

/** The dated-history probe the empty list depends on (D3 empty-state edge). */
const EMPTY_FLOW: IssueFlow = {
  buckets: [],
  unknownCaptureDates: 0,
  unknownClosureDates: 0,
  currentOpen: 0,
  incompleteHistory: false,
};
const RECORDED_FLOW: IssueFlow = {
  buckets: [{ date: "2026-01-02", capturedCumulative: 3, retiredCumulative: 1, openDifference: 2, origin: "store" }],
  unknownCaptureDates: 0,
  unknownClosureDates: 0,
  currentOpen: 2,
  incompleteHistory: false,
};
const PROBE_FAILURE = "store.not-initialized: no store — initialize the issue store with the CLI, then reload.";
const PROBE_LOADING: LoadState<IssueFlow> = { status: "loading", envelope: null, message: null };
const PROBE_FAILED: LoadState<IssueFlow> = { status: "error", envelope: null, message: PROBE_FAILURE };
function probeReady(data: IssueFlow): LoadState<IssueFlow> {
  return { status: "ready", envelope: { data, storeRevision: 1, catalogRevision: 0 }, message: null };
}

describe("issue list filters", () => {
  test("filter defaults are open-only across all projects and round-trip through the URL", () => {
    // No search string: the D17 default (open-only, all projects), first page.
    expect(parseIssueQuery("")).toEqual({ filters: DEFAULT_ISSUE_FILTERS, offset: 0 });
    expect(isDefaultFilters(DEFAULT_ISSUE_FILTERS)).toBe(true);
    expect(issueQuery({ filters: DEFAULT_ISSUE_FILTERS, offset: 0 })).toBe("disposition=open&limit=50");

    const applied = parseIssueQuery("?project=proj-a&disposition=resolved&kind=risk&severity=critical&q=timeout&offset=50");
    expect(applied).toEqual({
      filters: { project: "proj-a", disposition: "resolved", kind: "risk", severity: "critical", q: "timeout" },
      offset: 50,
    });
    expect(isDefaultFilters(applied.filters)).toBe(false);
    // The same string drives the API request and the address bar (plan D2 query fields).
    expect(issueQuery(applied)).toBe(
      "disposition=resolved&project=proj-a&kind=risk&severity=critical&q=timeout&limit=50&offset=50",
    );
  });

  test("filter keeps an unknown enum value out of the request instead of asking the API", () => {
    expect(parseIssueQuery("?disposition=closed").filters.disposition).toBe("open");
    expect(parseIssueQuery("?kind=nonsense").filters.kind).toBe("");
    expect(parseIssueQuery("?severity=blocker").filters.severity).toBe("");
    // A malformed offset is the first page, never a refused request.
    expect(parseIssueQuery("?offset=2.5").offset).toBe(0);
    expect(parseIssueQuery("?offset=-1").offset).toBe(0);
  });

  test("filter escapes a literal search value — it is text, not a pattern space", () => {
    const escaped = issueQuery({ filters: { ...DEFAULT_ISSUE_FILTERS, q: "a&b=c #frag 100%_x" }, offset: 0 });
    expect(escaped).toBe("disposition=open&q=a%26b%3Dc+%23frag+100%25_x&limit=50");
    expect(parseIssueQuery(`?${escaped}`).filters.q).toBe("a&b=c #frag 100%_x");
  });

  test("filter: an empty store is distinguished from an empty filter result", () => {
    const empty: IssueFlow = {
      buckets: [],
      unknownCaptureDates: 0,
      unknownClosureDates: 0,
      currentOpen: 0,
      incompleteHistory: false,
    };
    expect(capturedTotal(empty)).toBe(0);
    const withHistory: IssueFlow = {
      buckets: [{ date: "2026-01-02", capturedCumulative: 3, retiredCumulative: 1, openDifference: 2, origin: "store" }],
      unknownCaptureDates: 2,
      unknownClosureDates: 1,
      currentOpen: 2,
      incompleteHistory: true,
    };
    expect(capturedTotal(withHistory)).toBe(5);
  });
});

describe("empty list state", () => {
  test("an empty list under default filters never claims a filter miss while the probe is unresolved", () => {
    // The store probe is in flight: neither the empty-store copy nor the
    // filter-empty copy is honest yet.
    expect(emptyListState(true, PROBE_LOADING)).toEqual({ kind: "probing" });
    // A non-default filter never probes at all: the empty result is a filter miss.
    expect(emptyListState(false, PROBE_LOADING)).toEqual({ kind: "filtered" });
  });

  test("a settled probe picks one copy, and a failed probe stays neutral", () => {
    expect(emptyListState(true, probeReady(EMPTY_FLOW))).toEqual({ kind: "store" });
    expect(emptyListState(true, probeReady(RECORDED_FLOW))).toEqual({ kind: "filtered" });
    // The probe failed, so the empty list cannot be attributed to the filters;
    // the panel keeps the probe's own "what failed / what next" copy.
    expect(emptyListState(true, PROBE_FAILED)).toEqual({ kind: "unknown", message: PROBE_FAILURE });
  });
});

describe("issue history", () => {
  test("history lists exactly the recorded events of an imported closed issue", () => {
    const imported = detail({
      disposition: "resolved",
      closedAt: null,
      occurrences: [occurrence(1, null, { imported: true })],
      transitions: [transition(1, null, { imported: true })],
      provenance: MIGRATION_PROVENANCE,
    });

    const occurrences = occurrenceRows(imported);
    const transitions = transitionRows(imported);
    // Capture + closure only: nothing between them is invented.
    expect(occurrences).toHaveLength(1);
    expect(transitions).toHaveLength(1);
    expect(occurrences[0]!.kind).toBe("Capture");
    expect(transitions[0]!.summary).toBe("open → resolved");

    // Both recorded events carry the migration label/path/legacy id/bucket.
    expect(occurrences[0]!.migration).toBe(IMPORT_LABEL);
    expect(transitions[0]!.migration).toBe(IMPORT_LABEL);
    expect(migrationNote(imported.provenance)).toBe(IMPORT_LABEL);
    // A locally recorded issue is never labelled migrated.
    expect(migrationNote([])).toBeNull();
  });

  test("history never manufactures an intermediate status or finding for a recurrence", () => {
    const recurring = detail({
      occurrences: [occurrence(1, "2026-01-02"), occurrence(2, "2026-02-02"), occurrence(3, "2026-03-02")],
    });

    // Three sightings of one open issue: one capture, two recurrences, and no
    // disposition change at all.
    expect(occurrenceRows(recurring).map((row) => row.kind)).toEqual(["Recurrence", "Recurrence", "Capture"]);
    expect(transitionRows(recurring)).toHaveLength(0);
    expect(occurrenceRows(recurring).every((row) => row.migration === null)).toBe(true);
  });

  test("history orders occurrences newest-first and transitions oldest-first, unknown dates last", () => {
    const ordered = detail({
      occurrences: [occurrence(7, null), occurrence(3, "2026-01-02"), occurrence(5, "2026-03-04")],
      transitions: [
        transition(4, null, { fromDisposition: "waived", toDisposition: "superseded" }),
        transition(2, "2026-05-01"),
        transition(1, "2026-02-02", { fromDisposition: "open", toDisposition: "waived" }),
      ],
    });

    expect(occurrenceRows(ordered).map((row) => row.occurrence.id)).toEqual([5, 3, 7]);
    expect(occurrenceRows(ordered).map((row) => row.at)).toEqual(["2026-03-04", "2026-01-02", null]);
    expect(transitionRows(ordered).map((row) => row.transition.id)).toEqual([1, 2, 4]);
    expect(transitionRows(ordered).map((row) => row.at)).toEqual(["2026-02-02", "2026-05-01", null]);
  });

  test("the capture is the issue's initial occurrence, not its earliest evidence date", () => {
    // The migrated row is the capture the store committed with the issue (issue
    // contract §3); the later recurrence carries the earlier evidence date and a
    // higher id. Allocation order decides, so the recurrence is never relabelled.
    const migrated = detail({
      occurrences: [occurrence(4, null, { imported: true }), occurrence(9, "2026-02-02")],
    });

    expect(captureOccurrence(migrated)?.id).toBe(4);
    expect(occurrenceRows(migrated).map((row) => [row.occurrence.id, row.kind])).toEqual([
      [9, "Recurrence"],
      [4, "Capture"],
    ]);
  });
});

describe("unknown date", () => {
  test("unknown date says so instead of the recording or import time", () => {
    expect(formatDate(null)).toBe(UNKNOWN_DATE);
    expect(formatDate(undefined)).toBe(UNKNOWN_DATE);
    expect(formatDate("")).toBe(UNKNOWN_DATE);
    // A stored lexeme keeps its own precision.
    expect(formatDate("2026-01-02")).toBe("2026-01-02");
    expect(formatDate("2026-01-02T03:04:05.000Z")).toBe("2026-01-02T03:04:05.000Z");

    // The imported events were recorded (imported) at RECORDED_AT, but their
    // own historical dates are unknown and stay unknown.
    const imported = detail({
      occurrences: [occurrence(1, null, { imported: true })],
      transitions: [transition(1, null, { imported: true })],
      provenance: MIGRATION_PROVENANCE,
    });
    expect(occurrenceRows(imported)[0]!.at).toBeNull();
    expect(occurrenceRows(imported)[0]!.occurrence.recordedAt).toBe(RECORDED_AT);
    expect(transitionRows(imported)[0]!.at).toBeNull();
    expect(transitionRows(imported)[0]!.transition.recordedAt).toBe(RECORDED_AT);
  });

  test("history and untrusted text: an external link renders only for http/https", () => {
    expect(externalLinkHref("javascript:alert(1)")).toBeNull();
    expect(externalLinkHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(externalLinkHref("/etc/passwd")).toBeNull();
    expect(externalLinkHref(null)).toBeNull();
    expect(externalLinkHref("https://example.com/issue/1")).toBe("https://example.com/issue/1");

    // Structured evidence is shown as text, and an empty value shows nothing.
    expect(evidenceText({ b: 1, a: [2] })).toBe('{\n  "b": 1,\n  "a": [\n    2\n  ]\n}');
    expect(evidenceText("plain")).toBe("plain");
    expect(evidenceText({})).toBeNull();
    expect(evidenceText([])).toBeNull();
    expect(evidenceText(null)).toBeNull();
  });
});
