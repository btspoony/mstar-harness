/**
 * View-model edges.
 *
 * The edges this suite checks — filter defaults/round-trip, history
 * derived strictly from recorded events, unknown dates, and the authority
 * split between the catalog and the execution projection with its honest
 * stale/unavailable disclosure, plus the roadmap's store-authoritative
 * milestone grouping, its catalog-driven project entry, and its freshness —
 * are asserted against real DTO shapes.
 * Rendering is exercised by the actual local browser smoke; the only render
 * assertions here walk the real Preact vnode tree the view produces.
 */
import { describe, expect, test } from "bun:test";
import type {
  CatalogIdentityDTO,
  IssueDetail,
  IssueFlow,
  IterationDTO,
  IterationListDTO,
  IterationPlanDTO,
  MilestoneIssueDTO,
  MilestoneRead,
  ProjectListDTO,
  ProjectListItem,
  ProjectMilestoneDTO,
  ReadProjection,
  RoadmapDTO,
  WorkflowDTO,
  WorkflowListDTO,
} from "@mstar-harness/engine";

import { UNKNOWN_DATE, evidenceText, externalLinkHref, formatDate, migrationNote } from "./format";

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
    origin: "scoped",
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

describe("unknown date", () => {
  test("unknown date says so instead of the recording or import time", () => {
    expect(formatDate(null)).toBe(UNKNOWN_DATE);
    expect(formatDate(undefined)).toBe(UNKNOWN_DATE);
    expect(formatDate("")).toBe(UNKNOWN_DATE);
    // A stored lexeme keeps its own precision.
    expect(formatDate("2026-01-02")).toBe("2026-01-02");
    expect(formatDate("2026-01-02T03:04:05.000Z")).toBe("2026-01-02T03:04:05.000Z");

    // The imported-event rows this used to assert are gone from the product: the
    // occurrence log and the transition history were removed (D30), and their host
    // view functions went with the screen in this round.
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
    gateStep: null,
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

function milestone(overrides: Partial<ProjectMilestoneDTO> = {}): ProjectMilestoneDTO {
  return {
    milestoneId: "m-1",
    projectId: "engine",
    name: "Phase 1",
    target: "2026-10-01",
    status: "active",
    ordinal: 0,
    revision: 1,
    createdAt: RECORDED_AT,
    updatedAt: RECORDED_AT,
    totalIssues: 0,
    openIssues: 0,
    resolvedIssues: 0,
    otherRetiredIssues: 0,
    ...overrides,
  };
}

function linkedIssue(
  id: string,
  milestoneId: string,
  overrides: Partial<MilestoneIssueDTO & { milestoneId: string }> = {},
): MilestoneIssueDTO & { milestoneId: string } {
  return {
    id,
    title: `${id} stored title`,
    acceptance: `${id} acceptance`,
    disposition: "open",
    revision: 1,
    milestoneId,
    ...overrides,
  };
}

function milestoneRead(overrides: Partial<MilestoneRead> = {}): MilestoneRead {
  return { projectId: "engine", milestones: [], issues: [], unassignedIssues: 0, ...overrides };
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
    milestones: milestoneRead(),
    ...overrides,
  };
}

const EMPTY_WORKFLOWS: WorkflowListDTO = { items: [], total: 0 };
const EMPTY_ITERATIONS: IterationListDTO = { items: [], total: 0, attribution: "absent" };

describe("projection disclosure", () => {
});

describe("catalog and projection authority", () => {
  // Issue #499 review F3: the projection DTO's `branch.source` field carries the
  // DELIVERY branch (`branch.work`). Next to the new `branch.base` anchor, a
  // "branch source" label would present the delivery branch as the branch the
  // workflow was created from — the exact ambiguity the anchor rename removes.
});

/**
 * A hostile stored value, used to prove the render path treats milestone data
 * as text. Preact escapes string children; the only way such a value could
 * become markup is a `dangerouslySetInnerHTML` prop, so the assertions are:
 * the raw value arrives verbatim as a text child and no such prop exists.
 */
const HOSTILE_NAME = '<img src=x onerror="alert(1)">';

/** The part of a Preact vnode these assertions walk: the template's own props. */
type VNodeLike = {
  type?: unknown;
  props: {
    children?: unknown;
    class?: unknown;
    "data-tone"?: unknown;
    dangerouslySetInnerHTML?: unknown;
    href?: unknown;
    open?: unknown;
    tabindex?: unknown;
    "aria-label"?: unknown;
  };
};

function isVNode(node: unknown): node is VNodeLike {
  return node !== null && typeof node === "object" && "props" in node;
}

/**
 * Every string/number the tree paints as text, walking the REAL `html` output.
 * Hook-free function components (Field, Badge, the milestone rows) are invoked
 * so their labels and values are included; no HTML string is built or mocked.
 */
function renderedText(node: unknown): string[] {
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(renderedText);
  if (!isVNode(node)) return [];
  const body = typeof node.type === "function" ? node.type(node.props) : node.props.children;
  return renderedText(body);
}

/** The vnodes that would bypass text escaping by injecting raw HTML. */
function markupSinks(node: unknown): unknown[] {
  if (Array.isArray(node)) return node.flatMap(markupSinks);
  if (!isVNode(node)) return [];
  const own = node.props.dangerouslySetInnerHTML === undefined ? [] : [node.props.dangerouslySetInnerHTML];
  const body = typeof node.type === "function" ? node.type(node.props) : node.props.children;
  return [...own, ...markupSinks(body)];
}

function readyLoad(data: RoadmapDTO | null, projection: ReadProjection = CURRENT_PROJECTION): LoadState<RoadmapDTO | null> {
  return { status: "ready", envelope: envelope(data, projection), message: null };
}

/** The ready-envelope state, for tests that need the state rather than the panel. */
function readyState(data: RoadmapDTO | null, projection: ReadProjection = CURRENT_PROJECTION) {
  return roadmapState(envelope(data, projection));
}

describe("milestone grouping", () => {

});

describe("milestone view states", () => {
});

describe("milestone freshness disclosure", () => {
});

// ---------------------------------------------------------------------------
// The milestone board: one column per milestone in ordinal order, the explicit
// unassigned trailing column, and Direction demoted below it
// ---------------------------------------------------------------------------

/** Every vnode the tree renders, in the order the browser would paint them. */
function walkVNodes(node: unknown): VNodeLike[] {
  if (Array.isArray(node)) return node.flatMap(walkVNodes);
  if (!isVNode(node)) return [];
  const body = typeof node.type === "function" ? node.type(node.props) : node.props.children;
  return [node, ...walkVNodes(body)];
}

function classNames(node: VNodeLike): string[] {
  return typeof node.props.class === "string" ? node.props.class.split(/\s+/) : [];
}

/** Every vnode the tree renders with this class, same hook-free walk as `renderedText`. */
function vnodesByClass(node: unknown, className: string): VNodeLike[] {
  return walkVNodes(node).filter((child) => classNames(child).includes(className));
}

/** The board's own columns, in paint order: the milestone columns plus the trailing unassigned one. */
function boardColumns(board: unknown): VNodeLike[] {
  return walkVNodes(board).filter((node) => classNames(node).includes("board-column"));
}

describe("milestone board", () => {
});

// ---------------------------------------------------------------------------
// The roadmap entry: the catalog's project list before a project is selected
// ---------------------------------------------------------------------------

const PROJECT_LIST_HINT = "Choose a project to view its stored roadmap. This list is read-only; make changes with the CLI.";
const EMPTY_CATALOG_COPY =
  "No projects are registered in the catalog. Use the CLI to register a project; this dashboard cannot create one.";

function projectItem(id: string, overrides: Partial<CatalogIdentityDTO> = {}, openIssues = 0): ProjectListItem {
  return {
    project: catalogIdentity({
      kind: "project",
      id,
      title: `Project ${id}`,
      rootKind: "projects",
      relativePath: id,
      ...overrides,
    }),
    openIssues,
  };
}

function projectListLoad(
  data: ProjectListDTO,
  projection: ReadProjection = CURRENT_PROJECTION,
): LoadState<ProjectListDTO> {
  return { status: "ready", envelope: envelope(data, projection), message: null };
}

/** Every href the tree links to, walking the real Preact vnode output. */
function renderedHrefs(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(renderedHrefs);
  if (!isVNode(node)) return [];
  const own = typeof node.props.href === "string" ? [node.props.href] : [];
  const body = typeof node.type === "function" ? node.type(node.props) : node.props.children;
  return [...own, ...renderedHrefs(body)];
}

/** Every accessible name the tree publishes, same walk. */
function renderedAriaLabels(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(renderedAriaLabels);
  if (!isVNode(node)) return [];
  const own = typeof node.props["aria-label"] === "string" ? [node.props["aria-label"]] : [];
  const body = typeof node.type === "function" ? node.type(node.props) : node.props.children;
  return [...own, ...renderedAriaLabels(body)];
}

describe("roadmap project entry", () => {
});
