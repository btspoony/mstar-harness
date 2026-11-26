/**
 * Dashboard browser entry — bundled by `scripts/build-web.ts` into an offline
 * string served from `/assets/app.js`.
 *
 * This file is the **bootstrapping** layer and nothing else: it mounts one React
 * root, applies the two host contracts the shared package cannot decide for itself
 * (the colour scheme and the size container), and renders the shared shell. Route
 * resolution and the destination screens arrive in later tasks of this plan; the
 * entry deliberately carries no view code, so porting a screen never touches
 * bootstrapping.
 *
 * Two contracts are satisfied here rather than inside a component:
 *
 *  - `data-ms-theme` — the shared layer has no `"system"` arm (a host resolves
 *    "follow the OS" itself), so the dashboard states its scheme explicitly;
 *  - `ms-container` — every reflow rule in the shared package is
 *    `@container pane (…)`, so the named container has to exist on the wrapper.
 *
 * The stylesheets come from the bundle: importing the package pulls
 * `styles/tokens.css` and `styles/base.css`, and `Bun.build` emits them as the one
 * CSS asset the generator writes. There is no hand-maintained `style.css`.
 */
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_PROJECT_FEATURE,
  EmptyState,
  IssueDetail,
  Issues,
  IterationDetail,
  Iterations,
  LocaleProvider,
  MS_CONTAINER_CLASS,
  MS_PANE_HEAD_CLASS,
  MS_THEME_ATTRIBUTE,
  Nav,
  Notice,
  Overview,
  ProjectDetail,
  Projects,
  WorkflowDetail,
  Workflows,
  DEFAULT_ITERATION_FILTERS,
  DEFAULT_WORKFLOW_FILTERS,
  parseIssueQuery,
  useCopy,
  type IterationFilters,
  type WorkflowFilters,
  type IssueQuery,
  type Locale,
} from "@mstar-harness/ui";

import "./shell.css";

import type { IssuePage } from "@mstar-harness/engine";

import { ABSENT_PROJECTION } from "./absent-projection";
import { browserStore, resolveLocale, resolveTheme, storeLocale, storeTheme, type Theme } from "./prefs";
import {
  iterationDetailCopy,
  iterationDetailOutcome,
  iterationsCopy,
  iterationsOutcome,
  readIterationDetail,
  readIterations,
  type IterationDetailOutcome,
} from "./iterations-data";
import {
  ISSUE_FILTER_OPTIONS,
  keepPreviousOnLoad,
  issueDetailCopy,
  issueDetailOutcome,
  issuesCopy,
  issuesOutcome,
  issuesPath,
  assignableOptions,
  readAssignableIssues,
  readIssueDetail,
  readIssues,
  startRead,
  type IssueDetailOutcome,
  type IssuesOutcome,
} from "./issues-data";
import { overviewCopy, overviewOutcome, readOverview, type OverviewOutcome } from "./overview-data";
import type { IssueFlowSeries } from "@mstar-harness/ui";
import {
  createMilestoneDraftStore,
  projectDetailCopy,
  projectIdentity,
  projectIdentityFor,
  projectOptions,
  projectsCopy,
  projectsOutcome,
  readProjectMilestones,
  readProjects,
  projectMilestonesOutcome,
  milestoneWriteIds,
  milestoneWriteFollowUp,
  writeMilestone,
  type AssignableIssuesRead,
  type MilestoneMutationRequest,
  type MilestoneWriteSurface,
  type ProjectFeature,
  type ProjectMilestonesOutcome,
  type ProjectsOutcome,
} from "./projects-data";
import {
  readWorkflowDetail,
  readWorkflows,
  workflowDetailCatalogNotice,
  workflowDetailCopy,
  workflowDetailOutcome,
  workflowsCatalogNotice,
  workflowsCopy,
  workflowsOutcome,
  type WorkflowDetailOutcome,
} from "./workflows-data";
import {
  detailReturnTarget,
  escapeTarget,
  initialAddress,
  parentAddress,
  parseRoute,
  routeFilters,
  routeHash,
  type Address,
  type Route,
} from "./route";
import {
  isNavDestination,
  navItemFor,
  navRoute,
  scopedIssuesTarget,
  shellChrome,
  skipToMain,
} from "./shell-chrome";

/**
 * Push a destination, or replace the current entry when only the filters changed.
 *
 * A route change pushes so Back steps through destinations; a filter change
 * replaces so Back does not step through keystrokes (the Preact dashboard's
 * behaviour, kept).
 */
function navigate(route: Route, query: string, mode: "push" | "replace"): void {
  const hash = routeHash(route, query);
  if (mode === "push") window.history.pushState(null, "", hash);
  else window.history.replaceState(null, "", hash);
  // `pushState`/`replaceState` do not fire `hashchange`; the listener below only
  // sees Back/Forward and hand-edited hashes.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/**
 * The aggregated read, once per mount.
 *
 * The outcome is the host's, the model is the shared layer's: this hook never
 * unwraps a member or decides an absence — it fetches, hands the envelope over and
 * keeps the three outcomes apart.
 */
function useOverview(enabled: boolean, projectId?: string, reloadKey?: string): OverviewOutcome {
  const [outcome, setOutcome] = useState<OverviewOutcome>({ kind: "loading" });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let current = true;
    setOutcome({ kind: "loading" });
    void readOverview(fetch, controller.signal, projectId).then((result) => {
      if (!current) return;
      setOutcome(overviewOutcome(result));
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [enabled, projectId, reloadKey]);
  return outcome;
}

/** The landing page: the shared Overview behind the one aggregated read. */
/** The project scope the address carries, or "" for all projects. */
function issueScope(address: Address): string {
  return address.route.name === "issues" ? parseIssueQuery(address.query).filters.project : "";
}

function OverviewDestination(props: { query: string; outcome: OverviewOutcome }) {
  const outcome = props.outcome;
  const copy = useCopy();

  if (outcome.kind === "loading") return null;

  if (outcome.kind === "failed") {
    // A whole-read failure has nothing to render. One honest statement beats a page
    // whose every panel would be an absence arm for a read that never happened.
    return (
      <EmptyState
        arm="unavailable"
        labelWord={copy.state.unavailable.labelWord}
        heading={copy.overview.pageTitle}
        body={copy.state.unavailable.body}
        reason={outcome.message}
      />
    );
  }

  return (
    <Overview
      model={outcome.model}
      copy={overviewCopy(copy)}
      identity={{
        packageName: __MSTAR_PACKAGE__,
        version: __MSTAR_VERSION__,
        ...(document.documentElement.dataset.harnessDir === undefined ? {} : { harnessDir: document.documentElement.dataset.harnessDir }),
      }}
      onOpenWorkflow={(id) => navigate({ name: "workflow", id }, props.query, "push")}
      onOpenIssues={(severity) => {
        // The residual row names a severity; the destination has to carry it, or the
        // link lands on the unfiltered list it was counted from.
        const filtered: IssueQuery = { ...DEFAULT_ISSUES, filters: { ...DEFAULT_ISSUES.filters, severity } };
        navigate({ name: "issues" }, issueQueryString(filtered), "push");
      }}
    />
  );
}

/**
 * The assign picker's own read: every open issue of one project, independent of
 * the address bar and the list's page. `refreshToken` re-issues it after a write
 * moves an issue's milestone or revision; `retry()` re-issues it after a failure.
 *
 * Three arms, never two: a rejected read is `failed` with the store's own reason,
 * so the picker states the cause and offers the retry instead of spinning or
 * vanishing.
 */
function useAssignableIssues(
  projectId: string | null,
  refreshToken: number,
): {
  read: { kind: "loading" } | { kind: "ready"; model: readonly IssuePage["items"][number][] } | { kind: "failed"; reason: string };
  retry: () => void;
} {
  const [read, setRead] = useState<
    { kind: "loading" } | { kind: "ready"; model: readonly IssuePage["items"][number][] } | { kind: "failed"; reason: string }
  >({ kind: "loading" });
  const [retryToken, setRetryToken] = useState(0);
  useEffect(() => {
    if (projectId === null) return;
    const controller = new AbortController();
    let current = true;
    setRead({ kind: "loading" });
    void readAssignableIssues(fetch, projectId, controller.signal).then((result) => {
      if (!current) return;
      setRead(
        result.status === "ready"
          ? { kind: "ready", model: result.envelope.data.items }
          : { kind: "failed", reason: result.message },
      );
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [projectId, refreshToken, retryToken]);
  return { read, retry: () => setRetryToken((token) => token + 1) };
}

/**
 * The project's scoped Issues list, behind its own read.
 *
 * The query is the address bar's: the screen reports a whole query change and this
 * destination turns it into history — `replace` for a filter change, so Back steps
 * through destinations rather than keystrokes.
 */
/**
 * The iterations envelope at one scope, kept raw so a filter change re-derives the rows
 * instead of re-fetching. Lifted out of the screen so a caller can state the total before
 * the screen mounts.
 */
function useIterationsRaw(scope: string | null, enabled = true): Parameters<typeof iterationsOutcome>[0] | null {
  const [raw, setRaw] = useState<Parameters<typeof iterationsOutcome>[0] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let current = true;
    setRaw(null);
    void readIterations(fetch, scope, controller.signal).then((result) => {
      if (current) setRaw(result);
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [scope, enabled]);
  return raw;
}

function useIssues(query: IssueQuery, enabled = true, refreshToken = 0): IssuesOutcome {
  const [outcome, setOutcome] = useState<IssuesOutcome>({ kind: "loading" });
  const key = `${query.filters.disposition}|${query.filters.project}|${query.filters.kind}|${query.filters.severity}|${query.filters.q}|${query.offset}`;
  useEffect(() => {
    // A caller that already made this read passes its outcome in, and the hook then issues
    // nothing: a second identical request is free to disagree with the first.
    if (!enabled) return;
    const controller = new AbortController();
    let current = true;
    // Starting the next read keeps the painted rows: setting `loading` here unmounted
    // the list's search box between keystrokes, so focus died after every character.
    setOutcome(startRead);
    void readIssues(fetch, query, controller.signal).then((result) => {
      if (current) setOutcome((previous) => keepPreviousOnLoad(previous, issuesOutcome(result, query)));
    });
    return () => {
      current = false;
      controller.abort();
    };
    // The key is the request's identity: a new object with the same values must not
    // refetch on every render. `refreshToken` is the explicit re-issue a write asks
    // for (the store moved, so the painted rows are stale).
  }, [key, enabled, refreshToken]);
  return outcome;
}

/**
 * The Issues list at one scope.
 *
 * `scope` is a project id when a project detail renders it, and `null` for the
 * destination. It is applied to the request and to the query the screen reports,
 * so the project page owns exactly one authority over the scope.
 */
function IssueListScreen(props: {
  query: IssueQuery;
  projectIds: readonly string[];
  scope: string | null;
  onQueryChange: (query: IssueQuery) => void;
  onOpen?: (id: string) => void;
  /**
   * A read the caller already made. Supplying it keeps one read for two consumers — the
   * list's table and the caller's tab count — instead of two reads that can disagree.
   */
  outcome?: IssuesOutcome;
}) {
  const query = props.scope === null ? props.query : { ...props.query, filters: { ...props.query.filters, project: props.scope } };
  // The previous rows stay painted while the next read is in flight, so the search box
  // is never unmounted between keystrokes.
  const ownOutcome = useIssues(query, props.outcome === undefined);
  const outcome = props.outcome ?? ownOutcome;
  const copy = useCopy();
  // The prototype's issues screen carries the flow trend above its table, drawn from the
  // same series the overview renders. The chart holds the prototype's fixed `full`
  // height (132px), so a wider pane does not stretch it.
  const [trend, setTrend] = useState<IssueFlowSeries | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    // The trend is the same series the overview draws; a project's tab must read the
    // project's flow, not every project's.
    void readOverview(fetch, controller.signal, props.scope ?? undefined).then((result) => {
      if (!current || result.status !== "ready") return;
      const flow = overviewOutcome(result);
      if (flow.kind === "ready" && flow.model.issueFlow.kind === "populated") {
        setTrend(flow.model.issueFlow.value);
      }
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [props.scope]);
  if (outcome.kind === "loading") return null;
  if (outcome.kind === "failed") {
    return (
      <EmptyState
        arm="unavailable"
        labelWord={copy.state.unavailable.labelWord}
        heading={copy.issues.pageTitle}
        body={copy.state.unavailable.body}
        reason={outcome.message}
      />
    );
  }

  return (
    <Issues
      model={outcome.model}
      query={query}
      copy={issuesCopy(copy)}
      options={{ ...ISSUE_FILTER_OPTIONS, project: props.projectIds }}
      onQueryChange={props.onQueryChange}
      onOpen={props.onOpen}
      {...(trend === null ? {} : { trend, trendCopy: issuesTrendCopy(copy) })}
    />
  );
}

/** The issues screen's trend panel strings, borrowed from the overview's own copy. */
function issuesTrendCopy(copy: ReturnType<typeof useCopy>) {
  return {
    heading: copy.overview.trendHeading,
    range: copy.overview.trendRange,
    chartTitle: copy.overview.trendChartTitle,
    captured: copy.overview.trendCaptured,
    retired: copy.overview.trendRetired,
    legend: copy.overview.trendLegend,
    tableSummary: copy.issues.trendTableSummary,
    table: {
      columns: {
        date: copy.overview.flowDate,
        captured: copy.overview.flowCaptured,
        retired: copy.overview.flowRetired,
        open: copy.overview.flowOpen,
        origin: copy.overview.flowOrigin,
      },
    },
  };
}

function IssuesDestination(props: { address: Address; projectIds: readonly string[] }) {
  const query = routeFilters(props.address);
  return (
    <IssueListScreen
      query={query}
      projectIds={props.projectIds}
      scope={null}
      onQueryChange={(next) => {
        // A filter change replaces: Back should step through destinations, not
        // through every keystroke.
        navigate({ name: "issues" }, issueQueryString(next), "replace");
      }}
      onOpen={(id) => {
        // The filters travel with the reader: a detail that dropped them would send
        // them back to an unfiltered list.
        navigate({ name: "issue", id }, props.address.query, "push");
      }}
    />
  );
}

/** The query string for one query, through the shared pair's field order. */
function issueQueryString(query: IssueQuery): string {
  return issuesPath(query).split("?")[1] ?? "";
}

/** One issue, behind its own read. */
function IssueDetailDestination(props: { id: string }) {
  const copy = useCopy();
  const [outcome, setOutcome] = useState<IssueDetailOutcome>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setOutcome({ kind: "loading" });
    void readIssueDetail(fetch, props.id, controller.signal).then((result) => {
      if (current) setOutcome(issueDetailOutcome(result));
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [props.id]);

  if (outcome.kind === "loading") return null;
  if (outcome.kind === "failed") {
    return (
      <EmptyState
        arm="unavailable"
        labelWord={copy.state.unavailable.labelWord}
        heading={copy.issueDetail.identityHeading}
        body={copy.state.unavailable.body}
        reason={outcome.message}
      />
    );
  }

  return (
    <IssueDetail
      // `absent` has no envelope of its own: the record is not there, which is the
      // `absent` arm rather than an unreadable one. The projection passed alongside
      // is the list's honest "no generation" value only when a read failed, and a
      // 404 never carries one — so the screen is handed a null payload, which the
      // package-wide ruling reads as absent.
      read={
        outcome.kind === "absent"
          ? { data: null, projection: ABSENT_PROJECTION }
          : outcome.read
      }
      copy={issueDetailCopy(copy)}
      onBack={() => {
        const target = detailReturnTarget(parseRoute(window.location.hash));
        if (target !== null) navigate(target.route, target.query, "push");
      }}
    />
  );
}

/** The Workflows list, behind its own read. */
function WorkflowsDestination(props: { address: Address }) {
  const [raw, setRaw] = useState<Parameters<typeof workflowsOutcome>[0] | null>(null);
  const [filters, setFilters] = useState<WorkflowFilters>(DEFAULT_WORKFLOW_FILTERS);
  const copy = useCopy();
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    void readWorkflows(fetch, controller.signal).then((result) => {
      if (current) setRaw(result);
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, []);

  const outcome = workflowsOutcome(raw ?? { status: "loading" }, filters);
  if (outcome.kind === "loading") return null;
  if (outcome.kind === "failed") {
    return (
      <EmptyState
        arm="unavailable"
        labelWord={copy.state.unavailable.labelWord}
        heading={copy.workflows.pageTitle}
        body={copy.state.unavailable.body}
        reason={outcome.message}
      />
    );
  }

  // why: The rows are execution data and stay; an unavailable catalog association is
  // stated above them instead of leaving its join cell to read as a healthy `—`.
  const catalogNotice = workflowsCatalogNotice(outcome, copy);

  return (
    <>
      {catalogNotice === null ? null : <Notice lead={catalogNotice.lead} reason={catalogNotice.reason} />}
      <Workflows
        model={outcome.model}
        // note: The head's closing segment reads the envelope's own revision, which the model does
        // not carry: it is a fact about the read, not about a workflow.
        {...(raw !== null && raw.status === "ready" && raw.envelope.storeRevision !== null
          ? { storeRevision: raw.envelope.storeRevision }
          : {})}
        filters={filters}
        onFiltersChange={setFilters}
        copy={workflowsCopy(copy)}
        onOpen={(id) => {
          navigate({ name: "workflow", id }, props.address.query, "push");
        }}
      />
    </>
  );
}

/** One workflow, behind its own read. */
function WorkflowDetailDestination(props: { id: string }) {
  const [outcome, setOutcome] = useState<WorkflowDetailOutcome>({ kind: "loading" });
  const copy = useCopy();
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setOutcome({ kind: "loading" });
    void readWorkflowDetail(fetch, props.id, controller.signal).then((result) => {
      if (current) setOutcome(workflowDetailOutcome(result));
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [props.id]);

  if (outcome.kind === "loading") return null;
  if (outcome.kind === "failed") {
    return (
      <EmptyState
        arm="unavailable"
        labelWord={copy.state.unavailable.labelWord}
        heading={copy.workflowDetail.executionHeading}
        body={copy.state.unavailable.body}
        reason={outcome.message}
      />
    );
  }

  // invariant: The execution record stays; an unavailable catalog association is stated
  // above it, exactly as the list states the same optional gap.
  const catalogNotice = workflowDetailCatalogNotice(outcome, copy);

  return (
    <>
      {catalogNotice === null ? null : <Notice lead={catalogNotice.lead} reason={catalogNotice.reason} />}
      <WorkflowDetail
        model={outcome.model}
        copy={workflowDetailCopy(copy)}
        onBack={() => {
          const target = detailReturnTarget(parseRoute(window.location.hash));
          if (target !== null) navigate(target.route, target.query, "push");
        }}
      />
    </>
  );
}

/** The Iterations list, behind its own read. */
/** The Iterations list at one scope: `null` store-wide, or a project's own. */
function IterationListScreen(props: {
  scope: string | null;
  onOpen?: (id: string) => void;
  /** A read the caller already made, so the tab count and the list share one fetch. */
  raw?: Parameters<typeof iterationsOutcome>[0] | null;
}) {
  // The read is kept raw, so the model can be rebuilt from the data in hand. A filter
  // change must NOT re-fetch: it only re-derives the rows, which is what the screen
  // promises by keeping the filter state here.
  const ownRaw = useIterationsRaw(props.scope, props.raw === undefined);
  const raw = props.raw === undefined ? ownRaw : props.raw;
  const [filters, setFilters] = useState<IterationFilters>(DEFAULT_ITERATION_FILTERS);
  const copy = useCopy();

  // The model is derived at render time, so a filter change re-derives the rows from
  // the envelope already in hand instead of issuing a second read.
  const outcome = iterationsOutcome(raw ?? { status: "loading" }, filters);

  if (outcome.kind === "loading") return null;
  if (outcome.kind === "failed") {
    return (
      <EmptyState
        arm="unavailable"
        labelWord={copy.state.unavailable.labelWord}
        heading={copy.iterations.pageTitle}
        body={copy.state.unavailable.body}
        reason={outcome.message}
      />
    );
  }

  return (
    <Iterations
      model={outcome.model}
      copy={iterationsCopy(copy)}
      filters={filters}
      onFiltersChange={setFilters}
      {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
    />
  );
}

function IterationsDestination(props: { address: Address }) {
  return (
    <IterationListScreen
      scope={null}
      onOpen={(id) => navigate({ name: "iteration", id }, props.address.query, "push")}
    />
  );
}

/** One iteration, behind its own read. */
function IterationDetailDestination(props: { id: string; address: Address }) {
  const [outcome, setOutcome] = useState<IterationDetailOutcome>({ kind: "loading" });
  const copy = useCopy();
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setOutcome({ kind: "loading" });
    void readIterationDetail(fetch, props.id, controller.signal).then((result) => {
      if (current) setOutcome(iterationDetailOutcome(result));
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [props.id]);

  if (outcome.kind === "loading") return null;
  if (outcome.kind === "failed") {
    return (
      <EmptyState
        arm="unavailable"
        labelWord={copy.state.unavailable.labelWord}
        heading={copy.iterationDetail.compassHeading}
        body={copy.state.unavailable.body}
        reason={outcome.message}
      />
    );
  }

  return (
    <IterationDetail
      model={outcome.model}
      copy={iterationDetailCopy(copy)}
      onBack={() => {
        const target = detailReturnTarget(parseRoute(window.location.hash));
        if (target !== null) navigate(target.route, target.query, "push");
      }}
      onOpenWorkflow={(id) => {
        navigate({ name: "workflow", id }, props.address.query, "push");
      }}
    />
  );
}

/**
 * The project list, read once for the whole shell.
 *
 * Obligation 2 of the shared package's README: a component cannot know how a host
 * enumerates projects, so the host supplies them. One read feeds both consumers —
 * the Issues filter bar's project vocabulary and the Projects destination — rather
 * than each fetching its own copy and disagreeing after one of them fails.
 */
function useProjects(): ProjectsOutcome {
  const [outcome, setOutcome] = useState<ProjectsOutcome>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    void readProjects(fetch, controller.signal).then((result) => {
      if (current) setOutcome(projectsOutcome(result));
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, []);
  return outcome;
}

/** The Projects list. */
function ProjectsDestination(props: { outcome: ProjectsOutcome }) {
  const copy = useCopy();

  if (props.outcome.kind === "loading") return null;
  if (props.outcome.kind === "failed") {
    return (
      <EmptyState
        arm="unavailable"
        labelWord={copy.state.unavailable.labelWord}
        heading={copy.projects.pageTitle}
        body={copy.state.unavailable.body}
        reason={props.outcome.message}
      />
    );
  }

  return (
    <Projects
      model={props.outcome.model}
      copy={projectsCopy(copy)}
      onOpen={(projectId) => {
        // The default feature is the route model's: `#project/<id>` means the default.
        navigate({ name: "project", id: projectId, feature: DEFAULT_PROJECT_FEATURE }, "", "push");
      }}
    />
  );
}

/**
 * One project: the identity head, the milestone rollup as the default body, and
 * the two list features. `Issues` is the route's default and never "the first
 * feature with data".
 */
function ProjectDetailDestination(props: { address: Address; feature: ProjectFeature; projectIds: readonly string[]; projects: ProjectsOutcome }) {
  const projectId = props.address.route.name === "project" ? props.address.route.id : "";
  const [outcome, setOutcome] = useState<ProjectMilestonesOutcome>({ kind: "loading" });
  /**
   * The forms' drafts live OUTSIDE the read's subtree (the overview read
   * unmounts them on a re-read), so a typed name/effort survives an accepted
   * write's re-read and a revision-conflict retry.
   */
  const [drafts] = useState(createMilestoneDraftStore);
  const [writesState, setWritesState] = useState<{ busy: boolean; refusal: string | null }>({ busy: false, refusal: null });
  /** One operation id per logical write, retained across a transport-ambiguous retry. */
  const [operationIds] = useState(milestoneWriteIds);
  const [reloadToken, setReloadToken] = useState(0);
  /**
   * The scoped Issues list and the assignable read both follow an assignment:
   * an assigned issue leaves the offer set and its revision moves, so the picker
   * and the list must re-read after an accepted assign/unassign (and after the
   * revision-conflict re-read, whose store moved for the same reason).
   */
  const [issuesRefreshToken, setIssuesRefreshToken] = useState(0);
  /**
   * The list's read follows the address bar: a filter change navigates, the route
   * re-derives this query, and the rows read from it. A read frozen to the defaults
   * left every control inert while still painting its own value.
   */
  const query: IssueQuery = routeFilters(props.address);
  const scopedIssues: IssuesOutcome = useIssues(
    { ...query, filters: { ...query.filters, project: projectId } },
    projectId !== "",
    issuesRefreshToken,
  );
  /**
   * The project's size for the tab and head: the default `open` read over the whole
   * project, independent of the list's current filters.
   */
  const countIssues = useIssues(
    { ...DEFAULT_ISSUES, filters: { ...DEFAULT_ISSUES.filters, project: projectId } },
    projectId !== "",
  );
  const issuesCount = countIssues.kind === "ready" ? countIssues.model.total : undefined;
  /**
   * The same for iterations: read here so the tab can state its count before that tab is
   * opened, and handed to the list so both read the same envelope.
   */
  const scopedIterations = useIterationsRaw(projectId === "" ? null : projectId, projectId !== "");
  // Derived once, and narrowed by `kind` rather than cast: the second `iterationsOutcome`
  // call this used to make was the same computation twice, and the casts hid what it
  // returned.
  //
  // The count is the project's *size*, not the list's current filter result: the prototype's
  // tab reads `Iterations 2` whatever the list below is filtered to. That is why the default
  // filters are stated here rather than the screen's live ones.
  const iterationsModel =
    scopedIterations === null ? null : iterationsOutcome(scopedIterations, DEFAULT_ITERATION_FILTERS);
  const iterationsCount =
    iterationsModel !== null && iterationsModel.kind === "ready" ? iterationsModel.model.total : undefined;
  const copy = useCopy();

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setOutcome({ kind: "loading" });
    void readProjectMilestones(fetch, projectId, controller.signal).then((result) => {
      if (!current) return;
      const next = projectMilestonesOutcome(result);
      setOutcome(next);
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [projectId, reloadToken]);

  // The assign picker's options: the project's OPEN issues, read by its OWN query
  // (disposition only, every page) so the address bar's filters, search and page
  // window can never shrink the offer; the unassigned subset is the picker's rule.
  const assignable = useAssignableIssues(projectId === "" ? null : projectId, issuesRefreshToken);
  const assignableIssues: AssignableIssuesRead =
    assignable.read.kind === "ready"
      ? assignableOptions(assignable.read.model)
      : assignable.read.kind === "failed"
        ? { kind: "failed", reason: assignable.read.reason }
        : { kind: "loading" };

  /**
   * The milestone write channel: one write at a time, each carrying the store
   * revision of the overview read that rendered the forms. A revision conflict
   * re-reads (the read moved under the observation, so the re-armed channel gets
   * the new revision and the operator's draft survives the re-mount); an input
   * refusal wrote nothing and does not re-read. An ambiguous transport failure
   * keeps its operation id and revision so a retry replays the engine's receipt.
   */
  const writes: MilestoneWriteSurface | undefined =
    outcome.kind !== "ready" || outcome.storeRevision === null
      ? undefined
      : {
          busy: writesState.busy,
          refusal: writesState.refusal,
          create: (input) => runMilestoneWrite({ verb: "create", projectId, input }),
          update: (milestoneId, patch) => runMilestoneWrite({ verb: "update", projectId, milestoneId, patch }),
          assign: (issueId, issueRevision, milestoneId) =>
            runMilestoneWrite({ verb: "assign", projectId, issueId, milestoneId, issueRevision }),
          remove: (milestoneId) => runMilestoneWrite({ verb: "remove", projectId, milestoneId }),
        };

  function runMilestoneWrite(request: MilestoneMutationRequest): void {
    if (outcome.kind !== "ready" || outcome.storeRevision === null || writesState.busy) return;
    const revision = outcome.storeRevision;
    setWritesState({ busy: true, refusal: null });
    const retained = operationIds.for(JSON.stringify(request), { expectedStoreRevision: revision });
    void writeMilestone(fetch, {
      ...request,
      operationId: retained.operationId,
      expectedStoreRevision: retained.request.expectedStoreRevision,
    }).then((result) => {
      // The whole policy lives in one asserted function: accepted → re-read and clear
      // the draft; conflict → re-read and KEEP it; input refusal → neither; ambiguous
      // transport failure → retain the operation for a replay.
      const followUp = milestoneWriteFollowUp(request, result);
      if (!followUp.retainOperation) operationIds.settled();
      setWritesState({ busy: false, refusal: followUp.refusal });
      if (followUp.reloadOverview) setReloadToken((token) => token + 1);
      // An assignment moves an issue's milestone and revision, so the scoped list and
      // the picker both re-read — the assigned issue leaves the offer set, and an
      // unassigned one comes back at its new revision.
      if (followUp.refreshIssues) setIssuesRefreshToken((token) => token + 1);
    });
  }

  // The head's identity comes from the same list read the Projects destination
  // renders, so the two can never disagree; a project the list does not carry
  // gets the route's own id and nothing invented beside it.
  const identity = (() => {
    if (props.projects.kind === "ready" && props.projects.model.rows.kind === "populated") {
      const row = props.projects.model.rows.value.find((candidate) => candidate.projectId === projectId);
      if (row !== undefined) return projectIdentity(row);
    }
    return projectIdentityFor(projectId);
  })();

  if (outcome.kind === "loading") return null;
  if (outcome.kind === "failed") {
    return (
      <EmptyState
        arm="unavailable"
        labelWord={copy.state.unavailable.labelWord}
        heading={copy.projects.pageTitle}
        body={copy.state.unavailable.body}
        reason={outcome.message}
      />
    );
  }

  return (
    <ProjectDetail
      identity={identity}
      feature={props.feature}
      onFeatureChange={(feature) => {
        navigate({ name: "project", id: projectId, feature }, "", "push");
      }}
      milestones={outcome.milestones}
      issues={
        <IssueListScreen
          // The route carries the feature's own filter state; the table reads it, not
          // the default query those controls started from.
          query={query}
          projectIds={props.projectIds}
          scope={projectId}
          onQueryChange={(next) => {
            const target = scopedIssuesTarget(projectId, next);
            // `replace`: a filter change must not become a Back step per keystroke.
            navigate(target.route, target.query, "replace");
          }}
          outcome={scopedIssues}
          onOpen={(id) => {
            // The project is the only trace of the page this record was opened from:
            // without it the breadcrumb and Escape landed on the store-wide list.
            const params = new URLSearchParams(props.address.query);
            params.set("project", projectId);
            navigate({ name: "issue", id }, params.toString(), "push");
          }}
        />
      }
      iterations={
        <IterationListScreen
          scope={projectId}
          raw={scopedIterations}
          onOpen={(id) => navigate({ name: "iteration", id }, props.address.query, "push")}
        />
      }
      {...(issuesCount === undefined ? {} : { issuesCount })}
      {...(iterationsCount === undefined ? {} : { iterationsCount })}
      {...(writes === undefined ? {} : { writes })}
      assignableIssues={assignableIssues}
      onRetryAssignable={assignable.retry}
      drafts={drafts}
      copy={projectDetailCopy(copy)}
      onBack={() => {
        // The breadcrumb and Escape are one move from two places: a hardcoded
        // `projects` target here disagreed with `parentOf` there, so a non-default
        // feature left the project on one control and stayed in it on the other.
        const parent = parentAddress(props.address);
        if (parent !== null) navigate(parent.route, parent.query, "push");
      }}
      onClearScope={() => {
        // Clearing the scope is leaving the project, not merely dropping a filter.
        navigate({ name: "issues" }, "", "push");
      }}
    />
  );
}

/** The neutral query a project's Issues feature opens with. */
const DEFAULT_ISSUES: IssueQuery = {
  filters: { disposition: "open", project: "", kind: "", severity: "", q: "" },
  offset: 0,
};

/** The shell: skip link, header with the shared navigation, the main region, footer. */
function Shell(props: {
  locale: Locale;
  theme: Theme;
  /** Whether the two choices will survive this visit. */
  persisted: boolean;
  onThemeChange: (theme: Theme) => void;
  onLocaleChange: (locale: Locale) => void;
}) {
  const [address, setAddress] = useState<Address>(() =>
    initialAddress(window.location.hash, window.location.search),
  );
  const copy = useCopy();
  const projects = useProjects();
  const projectIds = projects.kind === "ready" ? projectOptions(projects.model) : [];
  // Two reads with two scopes. The page head says `All projects` and its issue flow and
  // residuals cover the store, while the milestone and latest-iteration panels are one
  // project's (the prototype names that project on the panel). One scoped read for both
  // made the flow and the footer count only the first project.
  // The landing page's read is refreshed whenever the destination becomes active: a
  // session-long first read left the page stale after a store change and a round trip.
  const overviewReloadKey = address.route.name;
  const storeOutcome = useOverview(true, undefined, overviewReloadKey);
  const projectOutcome = useOverview(projectIds[0] !== undefined, projectIds[0], overviewReloadKey);
  const pageOutcome: OverviewOutcome =
    storeOutcome.kind === "ready" && projectOutcome.kind === "ready"
      ? {
          ...storeOutcome,
          model: {
            ...storeOutcome.model,
            milestones: projectOutcome.model.milestones,
            milestoneProject: projectOutcome.model.milestoneProject,
            latestIteration: projectOutcome.model.latestIteration,
          },
        }
      : storeOutcome;
  // why: The footer's two facts are the page's own read, not a side read: the model
  // downgrades an incomplete collaboration observation, so a suppressed count or
  // revision is suppressed here too.
  const revision = pageOutcome.kind === "ready" ? pageOutcome.revision : null;
  // The prototype's footer opens with the open-issue count, then the store revision.
  const residuals = pageOutcome.kind === "ready" ? pageOutcome.model.residuals : null;
  const openIssues = residuals !== null && residuals.kind === "populated" ? residuals.value.total : null;

  useEffect(() => {
    const onHashChange = (): void => {
      setAddress(parseRoute(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  /**
   * Escape goes to the parent destination with the query preserved: a reader who
   * filtered a list and opened a record returns to the same filtered list, not to
   * an unfiltered one. At the landing destination there is no parent and the key
   * does nothing, which is the honest answer rather than a no-op that looks like
   * a bug.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape") return;
      // Only a detail has somewhere to go; in a list's search box the reader wants
      // the input cleared, not the page changed under them.
      const target = escapeTarget(address);
      if (target === null) return;
      event.preventDefault();
      navigate(target.route, target.query, "push");
    },
    [address],
  );

  // A list destination is active when the route is that list or one of its
  // details; the landing destination highlights nothing.
  const activeId = navItemFor(address.route);
  const chrome = shellChrome(copy);
  const mainRef = useRef<HTMLElement | null>(null);

  return (
    <div className="app-shell" onKeyDown={onKeyDown}>
      {/* The hash is the routing channel, so this must move focus rather than
          navigate: `#main` would resolve to Overview, scroll to top and discard the
          reader's filters. */}
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => skipToMain(event, () => mainRef.current)}
      >
        {chrome.skipLink}
      </a>
      <header className={`app-header ${MS_PANE_HEAD_CLASS}`}>
        {/* The prototype's brand block: a star, the name, and the version. `app-title`
            was the whole of it here — no mark, no version. */}
        <div className="brand">
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 0l1.9 6.1L16 8l-6.1 1.9L8 16 6.1 9.9 0 8l6.1-1.9z"
            />
          </svg>
          <span className="brand-name">Morning Star</span>
          <span className="brand-ver">v{__MSTAR_VERSION__}</span>
        </div>
        <Nav
          items={chrome.navItems}
          activeId={activeId}
          onSelect={(id) => {
            // A destination change is a push: Back returns to where the reader was.
            // `Nav` is shared with the dsh host and hands back a plain string; an id
            // outside this host's table has no route here.
            if (isNavDestination(id)) navigate(navRoute(id), "", "push");
          }}
          label={copy.shell.nav.primary}
        />
        <div className="app-controls">
          {/* The prototype puts the project scope in the header, left of the language
              group (`design-v1.html:800-807`). It filters the issue list, the only
              destination whose address carries a project. */}
          <select
            className="ctl"
            aria-label={copy.shell.scope.label}
            value={address.route.name === "issues" ? issueScope(address) : ""}
            onChange={(event) => {
              const project = event.target.value;
              navigate({ name: "issues" }, project === "" ? "" : `project=${encodeURIComponent(project)}`, "push");
            }}
          >
            <option value="">{copy.shell.scope.all}</option>
            {projectIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          {/* The prototype's treatment (`design-v1.html:179-196`): a segmented
              language group and a theme button carrying a shape per scheme — not
              two native selects. Both are real buttons, so both are reachable by
              keyboard and neither states its value by colour alone. */}
          <SegmentedControl
            label={copy.shell.language.label}
            value={props.locale}
            options={[
              { value: "en", label: copy.shell.language.en },
              { value: "zh", label: copy.shell.language.zh },
            ]}
            onChange={(value) => props.onLocaleChange(value === "zh" ? "zh" : "en")}
          />
          <ThemeButton
            label={copy.shell.theme.label}
            theme={props.theme}
            onChange={props.onThemeChange}
          />
          {props.persisted ? null : <p className="app-controls-note">{copy.shell.store.sessionOnly}</p>}
        </div>
      </header>
      {/* Only the landing destination is mounted (Task 3); the four lists arrive in
          Task 4, and until then their routes resolve but render nothing rather than
          a placeholder that would claim a state the dashboard cannot answer. */}
      {/* `tabIndex={-1}` makes the landmark a focus target; without it the skip
          link's focus() call is a no-op and the affordance silently does nothing. */}
      <main
        id="main"
        className="app-main"
        tabIndex={-1}
        ref={mainRef}
        data-ms-route={routeHash(address.route)}
      >
        {address.route.name === "overview" ? <OverviewDestination query={address.query} outcome={pageOutcome} /> : null}
        {address.route.name === "issues" ? <IssuesDestination address={address} projectIds={projectIds} /> : null}
        {address.route.name === "issue" ? <IssueDetailDestination id={address.route.id} /> : null}
        {address.route.name === "workflows" ? <WorkflowsDestination address={address} /> : null}
        {address.route.name === "workflow" ? <WorkflowDetailDestination id={address.route.id} /> : null}
        {address.route.name === "iterations" ? <IterationsDestination address={address} /> : null}
        {address.route.name === "iteration" ? (
          <IterationDetailDestination id={address.route.id} address={address} />
        ) : null}
        {address.route.name === "projects" ? <ProjectsDestination outcome={projects} /> : null}
        {address.route.name === "project" ? (
          <ProjectDetailDestination
            address={address}
            feature={(address.route as Extract<Route, { name: "project" }>).feature}
            projectIds={projectIds}
            projects={projects}
          />
        ) : null}
      </main>
      <footer className="app-footer">
        {/* Two segments, as the prototype has them: the count and the revision on the
            left, the read-only note on the right. */}
        <span>
          {openIssues === null ? null : `${chrome.openIssueCount(openIssues)} · `}
          <span data-ms-store-revision={revision === null ? undefined : revision}>
            {revision === null ? null : chrome.storeRevision(revision)}
          </span>
        </span>
        <span>{chrome.footer}</span>
      </footer>
    </div>
  );
}


/**
 * The two choices the reader owns, and the element that renders them.
 *
 * They are host controls, not shared components: which schemes exist and how a
 * choice is remembered are the host's business, while the shared package owns how a
 * scheme *looks* (its `[data-ms-theme="dark"]` token block) and what a language
 * *says* (its dictionary).
 */
function Boot() {
  // Resolved once: a browser that blocks storage gets a session-only one, and that
  // fact is disclosed rather than hidden — a reader who believes their choice was
  // remembered and finds it gone next visit has been misled by silence.
  const [{ store, persisted }] = useState(browserStore);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(store));
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(store));

  useEffect(() => {
    // The attribute is the only channel: the shared package selects its dark tokens
    // through `[data-ms-theme="dark"]`, and a media query over product colours would
    // be a second mechanism that can disagree with this one.
    // Two places on purpose: `#app` is the product wrapper, and `:root` is where the
    // base sheet's `body` rules read the scheme. Setting only the wrapper left the page
    // canvas and inherited text light in a dark UI.
    document.getElementById("app")?.setAttribute(MS_THEME_ATTRIBUTE, theme);
    document.documentElement.setAttribute(MS_THEME_ATTRIBUTE, theme);
    // `color-scheme` is what makes native controls (the two selects) and the initial
    // canvas follow the theme; pinned to `light` they stayed light in a dark page.
    document.documentElement.style.colorScheme = theme;
    storeTheme(store, theme);
  }, [store, theme]);

  useEffect(() => {
    storeLocale(store, locale);
    // The document's language follows the switch. Rendered copy is only half of what
    // declares a language: assistive technology reads `<html lang>` for pronunciation
    // and translation tools read it for what to offer, so leaving it at the shell's
    // initial value tells both of them the wrong thing after a switch.
    document.documentElement.lang = locale;
  }, [store, locale]);

  return (
    <StrictMode>
      <LocaleProvider locale={locale}>
        <Shell
          locale={locale}
          theme={theme}
          persisted={persisted}
          onThemeChange={setTheme}
          onLocaleChange={setLocale}
        />
      </LocaleProvider>
    </StrictMode>
  );
}

/**
 * One choice among a few, as a segmented group: the prototype's `.seg`
 * (`design-v1.html:183-189`).
 *
 * The pressed button carries `aria-pressed`, so the choice is announced as state
 * and does not depend on the fill colour. The group is labelled from the
 * dictionary; each button's own text is its label, so nothing here is icon-only.
 */
function SegmentedControl(props: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="app-seg" role="group" aria-label={props.label} data-ms-control="language">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === props.value}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The scheme switch, as the prototype's icon button (`design-v1.html:191-196`).
 *
 * The two icons are different SHAPES (a sun and a moon), and both are hidden from
 * assistive technology: the accessible name is the dictionary's label, and the
 * pressed state is announced. So the control reads the same in forced colors and
 * to a screen reader, and the icon is never the only channel.
 */
function ThemeButton(props: {
  label: string;
  theme: Theme;
  onChange: (theme: Theme) => void;
}) {
  const dark = props.theme === "dark";
  return (
    <button
      type="button"
      className="app-icon-btn"
      aria-label={props.label}
      aria-pressed={dark}
      data-ms-control="theme"
      onClick={() => props.onChange(dark ? "light" : "dark")}
    >
      <svg className="app-icon-sun" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="8" cy="8" r="3.1" />
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M12.9 3.1l-1.4 1.4M4.5 11.5l-1.4 1.4" />
      </svg>
      <svg className="app-icon-moon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M13.2 9.6A5.6 5.6 0 016.4 2.8a5.6 5.6 0 106.8 6.8z" />
      </svg>
    </button>
  );
}

/** The wrapper the shell renders into, with both host contracts applied. */
function mount(): void {
  const rootElement = document.getElementById("app");
  if (rootElement === null) return;
  rootElement.classList.add(MS_CONTAINER_CLASS);
  createRoot(rootElement).render(<Boot />);
}

mount();
