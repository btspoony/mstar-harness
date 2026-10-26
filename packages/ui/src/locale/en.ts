/**
 * The English copy. This file is the **source list**: `zh.ts` is typed against
 * `typeof en`, so a key missing on either side fails `tsc` before any test runs,
 * and the parity test covers the runtime shape.
 *
 * Three rules this file is written to keep:
 *
 *  1. **No enum value, id, path or timestamp appears here.** `open`, `InProgress`,
 *     `running`, `plans:…md`, `2026-10-25T…` are identifier text the product
 *     renders verbatim; translating one would break a copy-paste into the CLI. The
 *     parity test asserts their absence by scanning this file's values.
 *  2. **No key exists for a fact IA §8 marks not-rendered.** There is no
 *     occurrence, history, provenance, relation, lease, document, counter, trend,
 *     identity-line or knowledge-rollup family — a translation pass cannot
 *     resurrect a removed surface by adding a string.
 *  3. **Two copy constraints the read model fixes.** The in-progress plan line
 *     says the plan's *recorded* progress (and, when blocked, its *recorded*
 *     reason) — never "the first uncompleted step", because the store carries no
 *     checklist. The five gate-step labels name all five steps while the read can
 *     only mark one of the first four.
 */

export const en = {
  /** The four absence states own four key families; there is no "no data". */
  state: {
    "not-applicable": {
      labelWord: "n/a",
      body: "This does not resolve to a subject, so the answer is undetermined.",
    },
    absent: {
      labelWord: "not declared",
      body: "The record declares nothing here.",
      pointer: "The concept exists elsewhere in this project.",
    },
    empty: {
      labelWord: "empty",
      body: "The read succeeded and there is nothing to show.",
      hint: "Nothing has been created here yet.",
    },
    /** A filtered list's empty result — its own family, never the store's. */
    "empty-filtered": {
      labelWord: "empty",
      body: "No record matches the current filters.",
      hint: "Clearing a filter may reveal more.",
    },
    unavailable: {
      labelWord: "unavailable",
      body: "This could not be read.",
    },
  },

  /**
   * The shell's own text: the navigation landmark's accessible name and the two
   * switch labels. `nav.primary` is copy even though nothing renders it, because an
   * `aria-label` reaches the reader through assistive technology.
   */
  shell: {
    nav: {
      primary: "Primary",
      overview: "Overview",
      issues: "Issues",
      workflows: "Workflows",
      iterations: "Iterations",
      projects: "Projects",
    },
    skipLink: "Skip to content",
    footer: "Read-only · Make changes with the CLI",
    storeRevision: (n: number) => `${n} store revision`,
    theme: { label: "Colour scheme", light: "Light", dark: "Dark" },
    scope: { label: "Project scope", all: "All projects" },
    language: { label: "Language", en: "English", zh: "中文" },
    store: {
      sessionOnly: "This browser blocks storage, so these choices last for this session only.",
    },
  },

  common: {
    previous: "Previous",
    next: "Next",
    clear: "Clear filters",
    anyOption: "Any",
    notKnown: "Not known",
    dateUnknown: "Date unknown",
    none: "None",
    dash: "—",
  },

  overview: {
    identityBuilt: (at: string) => `built ${at}`,
    identityBuiltUnknown: "never built",
    identityRead: (at: string) => `read ${at}`,
    screenScopeAll: "All projects",
    screenSubtitle: (scope: string, open: number) => `${scope} · ${open} open issues`,
    pageTitle: "Overview",
    workflowsHeading: "Active workflow",
    workflowsMore: (n: number) => `+${n} more running`,
    workflowsTruncated: (shown: number, total: number) => `Showing ${shown} of ${total}`,
    plansProgress: (done: number, total: number) => `${done}/${total} plans`,
    trendHeading: "Issue flow trend",
    trendRange: (from: string, to: string) => `${from} → ${to}`,
    trendChartTitle: (from: string, to: string) => `Cumulative captured and retired issues, ${from} to ${to}`,
    trendCaptured: "Captured (cumulative)",
    trendRetired: "Retired (cumulative)",
    trendLegend: (datedOpen: number, recordedOpen: number) =>
      `${datedOpen} dated open · ${recordedOpen} recorded open`,
    trendGap: (datedOpen: number, undated: number) =>
      undated === 0
        ? `Dated history closes at ${datedOpen} open.`
        : `Dated history closes at ${datedOpen} open; ${undated} events carry no recorded date.`,
    trendTableSummary: "Dated history (table alternative)",
      flowDate: "Date",
      flowCaptured: "Captured",
      flowRetired: "Retired",
      flowOpen: "Open difference",
      flowOrigin: "Origin",
    trendColumns: {
      date: "Date",
      captured: "Captured (cumulative)",
      retired: "Retired (cumulative)",
      open: "Open difference",
      origin: "Origin",
    },
    planColumns: { plan: "Plan", title: "Title", status: "Status", progress: "Progress", done: "Completed" },
    workflowMeta: (plans: number, status: string) => `${plans} plans · ${status}`,
    plansLabel: (n: number): string => (n === 1 ? "plan" : "plans"),
    planTableCaption: "Plans under this workflow",
    planStatusAbsent: "Status not recorded",
    planProgressAbsent: "Records no progress.",
    typeLabel: "Type",
    openWorkflow: "Open workflow",
    branchBase: "Base",
    branchSource: "Source",
    branchIntegration: "Integration",
    branchTarget: "Target",
    dash: "—",
    residualsHeading: "Open residuals",
    residualsTotal: (open: number) => `${open} open · all projects`,
    iterationHeading: "Latest iteration",
    iterationNoIteration: "No iteration yet",
    gateStep: (step: number, of: number) => `step ${step} of ${of}`,
    milestonesHeading: "Milestones",
    milestonesSummary: (milestones: number, open: number) => `${milestones} milestones · ${open} open`,
    milestoneProgress: (done: number, total: number) => `${done}/${total}`,
    milestoneOpenCount: (open: number) => ` · ${open} open`,
    milestoneOpen: (open: number) => `${open} open`,
    projection: {
      current: "current",
      stale: "stale",
      unavailable: "unavailable",
    },
    severityLabels: {
      critical: "Critical",
      high: "High",
      medium: "Medium",
      low: "Low",
      nit: "Nit",
    },
  },

  focus: {
    pageTitle: "Focus",
    branchBase: "Base",
    branchSource: "Source",
    branchIntegration: "Integration",
    branchTarget: "Target",
    bindingBound: (workflowId: string) => `Bound to ${workflowId}`,
    bindingTerminal: (workflowId: string) => `${workflowId} is terminal`,
    bindingUnbound: "No workflow is bound to this session.",
    pickerLabel: "Pick a workflow",
    boardHeading: "Plans",
    boardEmpty: "Plans",
    groupHeading: (status: string, count: number) => `${status} · ${count}`,
    plansProgress: (done: number, total: number) => `${done}/${total}`,
    /** The plan's RECORDED next move. Never "the first uncompleted step" (D26). */
    progressLabel: "Recorded progress",
    /** The plan's RECORDED blocked reason. */
    blockedLabel: "Recorded blocked reason",
    progressAbsent: "This plan records no progress.",
    planStatusAbsent: "Status not recorded",
    deliveryHeading: "Latest iteration",
    deliveryLine: (iterationId: string, step: number, of: number) => `${iterationId} · step ${step} of ${of}`,
    deliveryNoIteration: "No iteration",
    deliveryUnknownStep: "Iteration · no delivery step recorded",
    enforcementLabel: (flag: string) => `Enforcement ${flag}`,
  },

  issues: {
    filtersHeading: "Filters",
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
    // The prototype's screen meta (`design-v1.html:1098`), stating the disposition
    // the filters actually select — `open` is only true for the default view. A
    // partial page cannot count the projects it never saw, so the span drops
    // rather than guessing.
    scope: (disposition: string, projects: number | null) => {
      const word = disposition === "" ? "all" : disposition;
      if (projects === null) return word;
      return projects === 1 ? `${word} across 1 project` : `${word} across ${projects} projects`;
    },
    order: "severity desc, last activity desc, id asc",
    resultSummary: (total: number) => `${total} results`,
    range: (from: number, to: number, total: number) => `${from}–${to} of ${total}`,
  },

  issueDetail: {
    breadcrumb: { label: "Breadcrumb", current: "Issues" },
    identityHeading: "Identity",
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
    /** The count is the surviving fact; the rows it used to summarise are gone. */
    occurrenceCount: (count: number) => `${count} seen`,
    impactHeading: "Impact",
    acceptanceHeading: "Acceptance criteria",
    closureNoteHeading: "Closure note",
    identityKeysHeading: "Identity keys",
    relationsHeading: "Relations",
    provenanceHeading: "Provenance",
    historyHeading: "Disposition history",
    occurrencesHeading: "Occurrences",
    occurrenceObservedAt: "Observed at",
    occurrenceLocation: "Location",
    occurrenceRecorded: "Recorded",
    historyColumns: { from: "From", to: "To", reason: "Reason", actor: "Actor", recorded: "Recorded" },
    historyNote: "Only recorded transitions appear. Intermediate states were never recorded and are not inferred.",
    provenanceColumns: { kind: "Kind", target: "Target", sourceHash: "Source hash", origin: "Origin", importedAt: "Imported at" },
    relationsColumns: { relation: "Relation", issue: "Issue", title: "Title" },
    sourceHeading: "Source",
    sourceKindLabel: "Source kind",
    sourceIdentityLabel: "Source identity",
    sourceLocationLabel: "Location",
    sourceRootCauseLabel: "Root cause key",
    sourceAcceptanceLabel: "Acceptance key",
    identityKeyLabel: "Identity key",
    providerLabel: "Provider",
  },

  workflows: {
    pageTitle: "Workflows",
    filters: {
      status: "Status",
      type: "Type",
      search: "Search workflow id or title",
      clear: "Clear filters",
      any: "Any",
      results: (shown: number, total: number) => shown === total ? `${shown} results` : `${shown} of ${total} results`,
    },
    tableCaption: "Workflows",
    registryNote: (terminal: number) => `${terminal} terminal workflow${terminal === 1 ? "" : "s"} not in the active registry`,
    columns: {
      id: "Workflow",
      title: "Catalog title",
      status: "Status · phase",
      root: "Root register",
      updated: "Projected updated",
      plans: "Plans",
    badges: "Join badges",
    },
    plansProgress: (done: number, total: number) => `${done}/${total} plans`,
    truncated: (shown: number, total: number) => `Showing ${shown} of ${total}`,
    noCatalogTitle: "No catalog row",
    noRoot: "—",
    /** The degradation reason, not a badge. */
    executionUnavailable: "The execution projection for this workflow could not be read.",
  },

  workflowDetail: {
    leasesHeading: "Leases",
    leasesCount: (n: number) => `${n} active · exclusive`,
    leasesEmpty: "No lease is held on this workflow.",
    leaseColumns: { plan: "Plan", kind: "Lease kind", holder: "Holder", worktree: "Worktree path", expires: "Expires" },
    updatedMeta: (when: string) => `updated ${when}`,
    activeRegistration: "active registration",
    breadcrumb: { label: "Breadcrumb", root: "Workflows", current: "Workflow" },
    executionHeading: "Execution",
    planTableHeading: "Plans",
    catalogHeading: "Catalog",
    fields: {
      id: "ID",
      type: "Type",
      status: "Status",
      phase: "Phase",
      startedAt: "Started",
      endedAt: "Ended",
      updatedAt: "Updated",
      branchBase: "Branch base",
      branchSource: "Branch source",
      branchIntegration: "Branch integration",
      branchTarget: "Branch target",
      root: "Root",
      title: "Title",
      lifecycle: "Lifecycle",
      documentKind: "Document kind",
      revision: "Revision",
      registeredAt: "Registered",
      catalogUpdatedAt: "Updated",
      description: "Description",
      notStarted: "Not started",
      noCatalog: "No catalog row",
    },
    planColumns: { planId: "Plan", title: "Title", status: "Status", progress: "Progress", doneAt: "Completed" },
    planProgressAbsent: "Records no progress.",
    executionUnavailableLead: "Execution unavailable",
    absence: {
      "not-applicable": {
        labelWord: "n/a",
        heading: "Workflow",
        body: "No project resolves for this read, so the workflow is undetermined.",
      },
      absent: {
        labelWord: "not declared",
        heading: "Workflow",
        body: "This workflow is not here. It may have been retired or never registered.",
        pointer: "The workflow list shows what the store holds.",
      },
      empty: {
        labelWord: "empty",
        heading: "Workflow",
        body: "The read succeeded and this workflow records nothing yet.",
        hint: "Its first plan registration creates the record.",
      },
      unavailable: { labelWord: "unavailable", heading: "Workflow", body: "This workflow could not be read." },
    },
  },

  iterations: {
    membershipNote: "Membership comes from the catalog; execution is a projection over it.",
    filters: {
      lifecycle: "Lifecycle",
      search: "Search iteration id or title",
      clear: "Clear filters",
      any: "Any",
      results: (shown: number, total: number) => shown === total ? `${shown} results` : `${shown} of ${total} results`,
    },
    pageTitle: "Iterations",
    tableCaption: "Iterations",
    columns: {
      id: "Iteration",
      title: "Title",
      lifecycle: "Lifecycle",
      execution: "Projected execution",
      delivery: "Delivery",
      plans: "Plans",
      documents: "Documents",
      started: "Started",
    },
    gateStep: (step: number, of: number) => `step ${step} of ${of}`,
    noCompass: "No compass",
    noExecution: "No execution",
    plansProgress: (done: number, total: number) => `${done}/${total} plans`,
    attribution: (arm: "present" | "absent"): string =>
      arm === "present" ? "Iterations are attributed to projects." : "No iteration is attributed to any project.",
  },

  iterationDetail: {
    documentsHeading: "Documents",
    documentsCount: (n: number) => `${n} documents`,
    documentsEmpty: "No document is registered under this iteration.",
    documentColumns: { title: "Title", lifecycle: "Lifecycle", kind: "Document kind", location: "Location", revision: "Revision" },
    breadcrumb: { label: "Breadcrumb", root: "Iterations", current: "Iteration" },
    compassHeading: "Compass",
    compassStarted: (at: string) => `started ${at}`,
    planTableHeading: "Plans",
    catalogHeading: "Catalog",
    executionHeading: "Execution",
  compassColumns: { milestone: "Milestone", target: "Target", status: "Status" },
    fields: {
      id: "Iteration",
      title: "Title",
      lifecycle: "Lifecycle",
    kind: "Kind",
    revision: "Revision",
    registeredAt: "Registered",
    location: "Location",
    catalogUpdatedAt: "Updated",
      root: "Root",
      compassStatus: "Compass status",
      startedAt: "Started",
      endedAt: "Ended",
      workflow: "Workflow",
      status: "Status",
      phase: "Phase",
      noWorkflow: "None",
      noCompass: "No compass",
      noSummary: "No summary recorded",
      notStarted: "Not started",
    },
    gateStep: (step: number, of: number) => `step ${step} of ${of}`,
    /** All five steps are named; the read can only mark one of the first four. */
    gateStepLabels: {
      start: "Start",
      execute: "Execute",
      close: "Close",
      "pr-delivery": "PR delivery",
      "merge-ready": "Merge ready",
    },
    gateNoCompass: "Delivery",
    planColumns: { planId: "Plan", title: "Title", status: "Status", progress: "Progress", doneAt: "Completed" },
    planProgressAbsent: "Records no progress.",
  },

  projects: {
    listHeading: "Catalog projects",
    listMeta: "Select a project to open its roadmap, issues and iterations",
    lifecycleNote: "Lifecycle is the catalog lifecycle, never the execution state.",
    noLifecycle: "no lifecycle",
    pageTitle: "Projects",
    tableCaption: "Projects",
    columns: { title: "Title", id: "ID", lifecycle: "Lifecycle", openIssues: "Open", description: "Description" },
    openIssues: (count: number) => `${count} open`,
    noDescription: "—",
  },

  projectDetail: {
  catalogHeading: "Catalog identity",
  roadmapState: "roadmap present",
  revisionLabel: "Revision",
  openIssuesUnit: "open issues",
  authorityHeading: "Roadmap authority",
  authorityColumns: { state: "State", revision: "Revision", contentHash: "Content hash", frontmatter: "Frontmatter" },
  authorityAbsent: "This project declares no roadmap authority row.",
    breadcrumb: { label: "Breadcrumb", trail: "Projects" },
    fields: { title: "Identity", id: "ID", lifecycle: "Lifecycle", path: "Path", description: "Description", noDescription: "—", projectKind: "Kind", revision: "Revision", registeredAt: "Registered", catalogUpdatedAt: "Updated" },
  storedFactsHeading: "Direction",
  storedFacts: {
    factsHeading: "Stored facts",
    columns: {
      frontmatterStatus: "Frontmatter status",
      createdAt: "Created at",
      residualsRef: "Residuals ref",
      goals: "Goals",
      sections: "Sections",
    },
    note: "Direction is rendered as text; goals are read-only, never checkboxes in the UI.",
  },
    tabLabel: "Project features",
    /** The fixed three features, in their fixed order (IA §4). */
    features: { roadmap: "Roadmap", issues: "Issues", iterations: "Iterations" },
    roadmap: {
      directionHeading: "Direction",
      goalsHeading: "Goals",
      milestonesHeading: "Milestone board",
    milestonesUnit: "milestones",
    unassignedUnit: "unassigned issues",
      markdownHeading: "Stored document",
      noDirection: "The roadmap records no direction.",
      goalChecked: "Checked",
      goalUnchecked: "Open",
      milestoneProgress: (done: number, total: number) => `${done}/${total}`,
    milestoneOpenCount: (open: number) => ` · ${open} open`,
      milestoneOpen: (open: number) => `${open} open`,
    countLabels: { open: "open", resolved: "resolved", retired: "retired without resolution", total: "total" },
      noTarget: "No target",
      unassigned: (count: number) => `${count} issues are not assigned to a milestone`,
      absentNextStep: (features: string) => `This project still has: ${features}.`,
    },
    scope: {
      label: (projectId: string) => `project: ${projectId}`,
      clear: "Clear the project scope",
    },
  },
} as const;

/**
 * The shape every locale must provide: `en`'s **key set and function signatures**
 * with the string literals widened.
 *
 * Without the widening, `as const` would type each English string as its own
 * literal and no translation could satisfy `Copy` — the type would demand
 * Chinese copy equal to the English. Widening keeps the structure exact (a missing
 * or extra key still fails) and leaves the function signatures alone, so a locale
 * cannot change `plansProgress`'s arity.
 */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => R
    : { readonly [K in keyof T]: Widen<T[K]> };

/** The copy tree every locale must provide. `zh.ts` is typed against it. */
export type Copy = Widen<typeof en>;
