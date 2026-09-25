/**
 * View-model edges.
 *
 * The edges this suite checks — filter defaults/round-trip, history
 * derived strictly from recorded events, unknown dates, and the authority
 * split between the catalog and the execution projection with its honest
 * stale/unavailable disclosure — are asserted against real DTO shapes.
 * Rendering is exercised by the actual local browser smoke; no test asserts a
 * mocked HTML string.
 */
import { describe, expect, test } from "bun:test";
import type {
  CatalogIdentityDTO,
  IssueDetail,
  IssueFlow,
  IterationDTO,
  IterationListDTO,
  IterationPlanDTO,
  ReadProjection,
  RoadmapDTO,
  WorkflowDTO,
  WorkflowListDTO,
} from "@mstar-harness/engine";

import type { Envelope, LoadState } from "./components";
import { dataBadgeText, disclosureLines, pinState, pinText } from "./components";
import { UNKNOWN_DATE, evidenceText, externalLinkHref, formatDate, migrationNote } from "./format";
import {
  DEFAULT_ISSUE_FILTERS,
  captureOccurrence,
  capturedTotal,
  emptyListState,
  issueFlowPath,
  issueQuery,
  isDefaultFilters,
  occurrenceRows,
  parseIssueQuery,
  transitionRows,
} from "./views/issues";
import { chartModel, chartSummary, flowNotes, flowPanelState, originLabel, yAxisTicks } from "./views/issue-flow";
import { compassState, iterationExecutionState, iterationListState, iterationPlanRow } from "./views/iterations";
import { roadmapProject, roadmapState } from "./views/roadmap";
import { workflowDetailState, workflowListState } from "./views/workflows";

type IssueOccurrence = IssueDetail["occurrences"][number];
type IssueTransition = IssueDetail["transitions"][number];
type IssueProvenance = IssueDetail["provenance"][number];

const RECORDED_AT = "2026-09-18T02:00:00.000Z";
const IMPORT_LABEL = "Imported from projects/proj-a/residuals.json (proj-a / closed #R1)";

/** The three projection health states the read boundary can disclose (contract §6). */
const BUILT_AT = "2026-09-18T10:00:00.000Z";
const CHECKED_AT = "2026-09-19T09:00:00.000Z";
const CURRENT_PROJECTION: ReadProjection = {
  generation: 4,
  freshness: "current",
  builtAt: BUILT_AT,
  checkedAt: CHECKED_AT,
  diagnostics: [],
};
const STALE_PROJECTION: ReadProjection = {
  generation: 3,
  freshness: "stale",
  builtAt: BUILT_AT,
  checkedAt: CHECKED_AT,
  diagnostics: [
    {
      sourceKey: "workflows/20260918-dashboard/snapshot.json",
      reason: "missing",
      message: "the declared snapshot is missing",
    },
  ],
};
const UNAVAILABLE_PROJECTION: ReadProjection = {
  generation: null,
  freshness: "unavailable",
  builtAt: null,
  checkedAt: CHECKED_AT,
  diagnostics: [{ sourceKey: "status.json", reason: "invalid", message: "status.json does not validate" }],
};

function envelope<T>(data: T, projection: ReadProjection = CURRENT_PROJECTION): Envelope<T> {
  return { data, storeRevision: 12, catalogRevision: 5, projection };
}

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
  return { status: "ready", envelope: envelope(data), message: null };
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

describe("issue flow panel model", () => {
  test("issue flow: a never-recorded store is empty; unknown-date captures and open issues are data", () => {
    expect(flowPanelState(EMPTY_FLOW)).toEqual({ kind: "empty" });
    // An open issue whose capture date is unknown still earns the data panel:
    // its count is disclosed there, never silently dropped.
    expect(flowPanelState({ ...EMPTY_FLOW, currentOpen: 2 })).toEqual({ kind: "data" });
    expect(flowPanelState({ ...EMPTY_FLOW, unknownCaptureDates: 1 })).toEqual({ kind: "data" });
    expect(flowPanelState(RECORDED_FLOW)).toEqual({ kind: "data" });
  });

  test("issue flow: missing dates are counted separately from the dated lines and the current open total", () => {
    const gap: IssueFlow = {
      buckets: [
        { date: "2026-09-01", capturedCumulative: 3, retiredCumulative: 1, openDifference: 2, origin: "store" },
        { date: "2026-09-02", capturedCumulative: 3, retiredCumulative: 2, openDifference: 1, origin: "store" },
      ],
      unknownCaptureDates: 2,
      unknownClosureDates: 1,
      currentOpen: 3,
      incompleteHistory: true,
    };
    const notes = flowNotes(gap);
    // Both unknown-date counts are named, with the honest exclusion rule.
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("dated history closes at 1 open");
    expect(notes[0]).toContain("the store currently records 3 open");
    expect(notes[1]).toContain("2 captured issues have no recorded date");
    expect(notes[1]).toContain("1 retired issue has no recorded closure date");
    expect(notes[1]).toContain("never imputed");

    // No gap to disclose when the dated history closes at the current open count.
    const clean: IssueFlow = {
      buckets: [{ date: "2026-09-01", capturedCumulative: 2, retiredCumulative: 0, openDifference: 2, origin: "store" }],
      unknownCaptureDates: 0,
      unknownClosureDates: 0,
      currentOpen: 2,
      incompleteHistory: false,
    };
    expect(flowNotes(clean)).toEqual([]);
  });

  test("issue flow: every terminal disposition contributes to the retired series", () => {
    // waived and duplicate both count as retired (issue contract §4 vocabulary);
    // retired never means "all fixed".
    const terminal: IssueFlow = {
      buckets: [
        { date: "2026-09-01", capturedCumulative: 4, retiredCumulative: 0, openDifference: 4, origin: "store" },
        { date: "2026-09-02", capturedCumulative: 4, retiredCumulative: 1, openDifference: 3, origin: "store" },
        { date: "2026-09-03", capturedCumulative: 4, retiredCumulative: 3, openDifference: 1, origin: "store" },
      ],
      unknownCaptureDates: 0,
      unknownClosureDates: 0,
      currentOpen: 1,
      incompleteHistory: false,
    };
    const model = chartModel(terminal);
    expect(model.capturedPath).toContain("M");
    expect(model.retiredPath).not.toBeNull();
    // The retired step ends at the same x as the captured step, one jump lower.
    expect(model.retiredPath!.split(" ").length).toBe(model.capturedPath.split(" ").length);
    expect(chartSummary(terminal)).toContain("retired issues (any terminal disposition) reach 3");
  });

  test("issue flow: pre-store buckets are labelled register history", () => {
    const migrated: IssueFlow = {
      buckets: [
        { date: "2026-01-02", capturedCumulative: 2, retiredCumulative: 1, openDifference: 1, origin: "register-history" },
        { date: "2026-09-01", capturedCumulative: 3, retiredCumulative: 1, openDifference: 2, origin: "store" },
      ],
      unknownCaptureDates: 0,
      unknownClosureDates: 0,
      currentOpen: 2,
      incompleteHistory: false,
    };
    expect(originLabel("register-history")).toBe("Register history");
    expect(originLabel("store")).toBe("Store");
    expect(flowNotes(migrated).join(" ")).toContain("register history");
  });

  test("issue flow: geometry scales to the captured maximum and spaces the dated buckets in order", () => {
    const flow: IssueFlow = {
      buckets: [
        { date: "2026-09-01", capturedCumulative: 1, retiredCumulative: 0, openDifference: 1, origin: "store" },
        { date: "2026-09-02", capturedCumulative: 2, retiredCumulative: 1, openDifference: 1, origin: "store" },
        { date: "2026-09-04", capturedCumulative: 6, retiredCumulative: 2, openDifference: 4, origin: "store" },
      ],
      unknownCaptureDates: 0,
      unknownClosureDates: 0,
      currentOpen: 4,
      incompleteHistory: false,
    };
    const model = chartModel(flow);
    expect(model.yMax).toBe(6);
    expect(model.yTicks[0]).toBe(0);
    expect(model.yTicks[model.yTicks.length - 1]).toBe(6);
    expect(model.xLabels.map((label) => label.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-04"]);
    expect(model.xLabels[0]!.x).toBeLessThan(model.xLabels[1]!.x);
    expect(model.xLabels[1]!.x).toBeLessThan(model.xLabels[2]!.x);
    // A zero retired first bucket still draws a retired line that never divides by zero.
    expect(model.retiredPath).not.toBeNull();
    expect(yAxisTicks(1)).toEqual([0, 1]);
  });

  test("issue flow: a single dated bucket draws a flat step, not a degenerate point", () => {
    const single: IssueFlow = {
      buckets: [{ date: "2026-09-01", capturedCumulative: 2, retiredCumulative: 1, openDifference: 1, origin: "store" }],
      unknownCaptureDates: 0,
      unknownClosureDates: 0,
      currentOpen: 1,
      incompleteHistory: false,
    };
    const model = chartModel(single);
    // One horizontal segment per series: an "H" with no vertical jump.
    expect(model.capturedPath).toMatch(/^M [\d.]+ [\d.]+ H [\d.]+$/);
    expect(model.retiredPath).toMatch(/^M [\d.]+ [\d.]+ H [\d.]+$/);
    expect(model.xLabels).toEqual([{ date: "2026-09-01", x: model.xLabels[0]!.x }]);
  });

  test("issue flow: the panel path is the bare rollup by default and project-scoped on filter", () => {
    expect(issueFlowPath("")).toBe("/api/issue-flow");
    expect(issueFlowPath("proj-a")).toBe("/api/issue-flow?project=proj-a");
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

// ---------------------------------------------------------------------------
// D4: the authority split between the catalog and the execution projection
// ---------------------------------------------------------------------------

function catalogIdentity(overrides: Partial<CatalogIdentityDTO> = {}): CatalogIdentityDTO {
  return {
    kind: "plan",
    id: "20260918-dashboard",
    title: "Local read-only dashboard",
    description: null,
    rootKind: "plans",
    relativePath: "20260918-dashboard.md",
    documentKind: null,
    lifecycle: "active",
    revision: 5,
    registeredAt: RECORDED_AT,
    updatedAt: RECORDED_AT,
    ...overrides,
  };
}

function workflow(overrides: Partial<WorkflowDTO> = {}): WorkflowDTO {
  return {
    id: "20260918-dashboard",
    type: "plan",
    status: "InProgress",
    phase: "implement",
    startedAt: RECORDED_AT,
    endedAt: null,
    updatedAt: RECORDED_AT,
    branch: { base: "main", source: "feature/20260918-dashboard", integration: null, target: "main" },
    activeRegistration: true,
    catalog: catalogIdentity(),
    plans: [],
    badges: [],
    ...overrides,
  };
}

function iteration(overrides: Partial<IterationDTO> = {}): IterationDTO {
  return {
    iterationId: "iter-20260918-issue-store-dashboard",
    catalog: catalogIdentity({
      kind: "iteration",
      id: "iter-20260918-issue-store-dashboard",
      title: "Issue store and dashboard",
      rootKind: "iterations",
      relativePath: "iter-20260918-issue-store-dashboard",
    }),
    compass: null,
    workflow: null,
    plans: [],
    documents: [],
    badges: [],
    ...overrides,
  };
}

function iterationPlan(overrides: Partial<IterationPlanDTO> = {}): IterationPlanDTO {
  return {
    planId: "20260918-dashboard",
    catalog: catalogIdentity(),
    execution: null,
    catalogPinRevision: null,
    badges: [],
    ...overrides,
  };
}

function roadmap(overrides: Partial<RoadmapDTO> = {}): RoadmapDTO {
  return {
    projectId: "engine",
    catalog: catalogIdentity({
      kind: "project",
      id: "engine",
      title: "Engine",
      rootKind: "projects",
      relativePath: "engine",
      documentKind: null,
    }),
    authority: { state: "present", revision: 2, contentHash: "a".repeat(64) },
    content: {
      contentMarkdown: "---\nproject_id: engine\n---\n",
      frontmatter: { project_id: "engine", title: "Engine roadmap", status: "active", created_at: "2026-09-25" },
      direction: "One local store.",
      goals: [{ ordinal: 0, parentOrdinal: null, checked: false, title: "Ship phase 1", body: "- [ ] Ship phase 1" }],
      milestones: ["Phase 1"],
      sections: [{ level: 2, heading: "Direction", body: "One local store." }],
    },
    ...overrides,
  };
}

const EMPTY_WORKFLOWS: WorkflowListDTO = { items: [], total: 0 };
const EMPTY_ITERATIONS: IterationListDTO = { items: [], total: 0 };

describe("projection disclosure", () => {
  test("stale projection disclosures remain on execution views, not authoritative roadmap content", () => {
    const views = [
      workflowListState(envelope({ items: [workflow()], total: 1 }, STALE_PROJECTION)),
      iterationListState(envelope({ items: [iteration()], total: 1 }, STALE_PROJECTION)),
    ];
    for (const view of views) {
      expect(view.disclosure).not.toBeNull();
      const lines = disclosureLines(view.disclosure!);
      expect(lines[0]).toContain("stale");
      const copy = lines.join("\n");
      expect(copy).toContain("workflows/20260918-dashboard/snapshot.json");
      expect(copy).toContain("missing");
      expect(copy).toContain(`Last successful build: ${BUILT_AT}.`);
      expect(copy).toContain(`Last checked: ${CHECKED_AT}.`);
    }
    expect(roadmapState(envelope(roadmap(), STALE_PROJECTION)).disclosure).toBeNull();
  });

  test("a current projection leaves execution views nothing to disclose", () => {
    expect(workflowListState(envelope(EMPTY_WORKFLOWS)).disclosure).toBeNull();
    expect(iterationListState(envelope(EMPTY_ITERATIONS)).disclosure).toBeNull();
  });

  test("a projection disclosure with no recorded diagnostic says so instead of naming a source", () => {
    const lines = disclosureLines({ freshness: "unavailable", diagnostics: [], builtAt: null, checkedAt: "" });
    expect(lines[0]).toContain("unavailable");
    const copy = lines.join("\n");
    expect(copy).toContain("No source diagnostic was recorded for this state.");
    expect(copy).toContain("Last successful build: none recorded.");
    expect(copy).toContain("Last checked: unknown.");
  });

});

describe("catalog and projection authority", () => {
  test("an unavailable first projection is not an empty workflow catalog", () => {
    // No valid generation: the list says unavailable, never "no workflows".
    expect(workflowListState(envelope(EMPTY_WORKFLOWS, UNAVAILABLE_PROJECTION)).content).toEqual({
      kind: "unavailable",
    });
    // A published generation with no rows is the empty case…
    expect(workflowListState(envelope(EMPTY_WORKFLOWS)).content).toEqual({ kind: "empty" });
    // …and a stale retained generation still lists what it has.
    const stale = workflowListState(envelope({ items: [workflow()], total: 1 }, STALE_PROJECTION));
    expect(stale.content).toEqual({ kind: "listed", total: 1 });
  });

  test("row payloads served without a valid generation stay unavailable, never listed", () => {
    // W-001: the list paints only on `listed`, so rows arriving alongside no
    // valid generation must not become a listed state — the whole point of the
    // "unreadable source is never rendered as work" STOP rule.
    const rows = workflowListState(envelope({ items: [workflow()], total: 1 }, UNAVAILABLE_PROJECTION));
    expect(rows.content).toEqual({ kind: "unavailable" });
    expect(rows.disclosure).not.toBeNull();
    // The identical payload with a published generation is the one listed case.
    expect(workflowListState(envelope({ items: [workflow()], total: 1 })).content).toEqual({ kind: "listed", total: 1 });
  });

  test("the iteration list stays catalog-driven while the execution projection is unavailable", () => {
    const listed = iterationListState(envelope({ items: [iteration()], total: 1 }, UNAVAILABLE_PROJECTION));
    expect(listed.content).toEqual({ kind: "listed", total: 1 });
    expect(listed.disclosure).not.toBeNull();
    expect(iterationListState(envelope(EMPTY_ITERATIONS)).content).toEqual({ kind: "empty" });
  });

  test("an iteration with no execution row is not the same fact as an unavailable projection", () => {
    // Absent execution data: a valid generation simply carries no row for it.
    expect(iterationExecutionState(iteration(), CURRENT_PROJECTION)).toEqual({ kind: "not-started" });
    // No valid generation: nothing is claimed about execution at all.
    expect(iterationExecutionState(iteration(), UNAVAILABLE_PROJECTION)).toEqual({ kind: "unavailable" });
    // The row case carries the projected values through unchanged.
    const running = iteration({
      workflow: { id: "iter-1", status: "InProgress", phase: "execute", activeRegistration: true },
    });
    expect(iterationExecutionState(running, CURRENT_PROJECTION)).toEqual({
      kind: "row",
      workflow: { id: "iter-1", status: "InProgress", phase: "execute", activeRegistration: true },
    });
  });

  test("a plan with no execution row keeps its catalog membership and claims no pin", () => {
    const row = iterationPlanRow(iterationPlan(), true);
    expect(row.catalog?.title).toBe("Local read-only dashboard");
    expect(row.execution).toEqual({ kind: "not-started" });
    // The same row under an unavailable projection: unknown, not a claim.
    expect(iterationPlanRow(iterationPlan(), false).execution).toEqual({ kind: "unknown" });
  });

  test("a workflow detail paints no projected facts without a valid generation", () => {
    // The row itself is a projection fact: with no valid generation the detail
    // is `unavailable` (with its disclosure), never a loaded page of projected
    // status/phase/plan/lease values. A null payload is the server's own shape
    // for that same state, so both spellings land in one place.
    const missingPayload = workflowDetailState(envelope(null, UNAVAILABLE_PROJECTION));
    expect(missingPayload.kind).toBe("unavailable");
    expect(missingPayload.disclosure).not.toBeNull();
    // Defensive: projected rows handed in alongside no valid generation must not
    // become painted work either.
    const contradictory = workflowDetailState(envelope(workflow(), UNAVAILABLE_PROJECTION));
    expect(contradictory.kind).toBe("unavailable");
    expect(contradictory.disclosure).not.toBeNull();
    // A published generation is the one loaded case, and a current one discloses
    // nothing.
    const loaded = workflowDetailState(envelope(workflow()));
    expect(loaded.kind === "loaded" ? loaded.workflow.id : null).toBe("20260918-dashboard");
    expect(loaded.disclosure).toBeNull();
  });

  test("the compass is projected content: no valid generation means unknown, never absent", () => {
    const compass = {
      iterationId: "iter-20260918-issue-store-dashboard",
      summary: "projected summary",
      milestones: [],
      startedAt: RECORDED_AT,
      endedAt: null,
      status: "running",
    };
    // A valid generation without a compass document is `absent`…
    expect(compassState(null, true)).toEqual({ kind: "absent" });
    // …and no valid generation is `unknown`, with or without a compass value.
    expect(compassState(null, false)).toEqual({ kind: "unknown" });
    expect(compassState(compass, false)).toEqual({ kind: "unknown" });
    const document = compassState(compass, true);
    expect(document.kind === "document" ? document.compass.summary : null).toBe("projected summary");
  });

  test("a missing prepared catalog pin is disclosed, never filled from the catalog revision", () => {
    const unpinned = iterationPlanRow(
      iterationPlan({
        execution: { workflowId: "w", status: "InProgress", progress: null, phase: null, doneAt: null },
        catalogPinRevision: null,
        badges: ["catalog-pin-missing"],
      }),
      true,
    );
    expect(unpinned.execution.kind).toBe("row");
    const pin = unpinned.execution.kind === "row" ? unpinned.execution.pin : null;
    expect(pin).toEqual({ kind: "missing" });
    // The catalog's current revision is 5; a missing pin never borrows it.
    expect(pinText(pin!)).toContain("missing");
    expect(pinText(pin!)).not.toContain("revision 5");

    // A pin that predates the catalog row keeps both revisions in view.
    expect(pinState(3, 5)).toEqual({ kind: "conflict", pin: 3, current: 5 });
    expect(pinText({ kind: "conflict", pin: 3, current: 5 })).toContain("revision 3");
    expect(pinState(5, 5)).toEqual({ kind: "pinned", revision: 5 });
    // No catalog row to compare against: no conflict is claimed.
    expect(pinState(3, null)).toEqual({ kind: "pinned", revision: 3 });
  });

  test("join badges name the missing catalog join instead of resolving it", () => {
    expect(dataBadgeText(["catalog-pin-missing", "catalog-missing"])).toEqual([
      "Prepared pin missing",
      "No catalog row",
    ]);
    expect(dataBadgeText([])).toEqual([]);
  });
});

describe("roadmap", () => {
  test("roadmap presence is authoritative even when the execution projection is unavailable", () => {
    expect(roadmapProject("")).toBeNull();
    expect(roadmapProject("?project=")).toBeNull();
    expect(roadmapProject("?project=%20")).toBeNull();
    expect(roadmapProject("?project=engine")).toBe("engine");

    const absent = roadmapState(envelope(roadmap({ authority: { state: "absent" }, content: null }), UNAVAILABLE_PROJECTION));
    expect(absent.content.kind).toBe("absent");
    expect(absent.disclosure).toBeNull();

    const ready = roadmapState(envelope(roadmap(), UNAVAILABLE_PROJECTION));
    expect(ready.content.kind).toBe("ready");
    expect(ready.disclosure).toBeNull();
    expect(ready.content.kind === "ready" ? ready.content.roadmap.content?.goals : []).toEqual([
      { ordinal: 0, parentOrdinal: null, checked: false, title: "Ship phase 1", body: "- [ ] Ship phase 1" },
    ]);
  });
});
