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
  MS_THEME_ATTRIBUTE,
  Nav,
  Overview,
  ProjectDetail,
  Projects,
  WorkflowDetail,
  Workflows,
  useCopy,
  type IssueQuery,
  type Locale,
  type ProjectFeature,
} from "@mstar-harness/ui";

import "./shell.css";

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
  type IterationsOutcome,
} from "./iterations-data";
import {
  ISSUE_FILTER_OPTIONS,
  keepPreviousOnLoad,
  issueDetailCopy,
  issueDetailOutcome,
  issuesCopy,
  issuesOutcome,
  issuesPath,
  readIssueDetail,
  readIssues,
  type IssueDetailOutcome,
  type IssuesOutcome,
} from "./issues-data";
import { overviewCopy, overviewOutcome, readOverview, type OverviewOutcome } from "./overview-data";
import {
  projectDetailCopy,
  projectOptions,
  projectsCopy,
  projectsOutcome,
  readProjects,
  readRoadmap,
  roadmapOutcome,
  type ProjectsOutcome,
  type RoadmapOutcome,
} from "./projects-data";
import {
  readWorkflowDetail,
  readWorkflows,
  workflowDetailCopy,
  workflowDetailOutcome,
  workflowsCopy,
  workflowsOutcome,
  type WorkflowDetailOutcome,
  type WorkflowsOutcome,
} from "./workflows-data";
import {
  LIST_DESTINATIONS,
  detailReturnTarget,
  initialAddress,
  parentAddress,
  parseRoute,
  routeFilters,
  routeHash,
  type Address,
  type Route,
} from "./route";
import { navItemFor, scopedIssuesTarget, shellChrome, skipToMain } from "./shell-chrome";

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
function useOverview(enabled: boolean): OverviewOutcome {
  const [outcome, setOutcome] = useState<OverviewOutcome>({ kind: "loading" });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let current = true;
    setOutcome({ kind: "loading" });
    void readOverview(fetch, controller.signal).then((result) => {
      if (!current) return;
      setOutcome(overviewOutcome(result));
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [enabled]);
  return outcome;
}

/** The landing page: the shared Overview behind the one aggregated read. */
function OverviewDestination() {
  const outcome = useOverview(true);
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

  return <Overview model={outcome.model} copy={overviewCopy(copy)} />;
}

/**
 * The Issues list, behind its own read.
 *
 * The query is the address bar's: the screen reports a whole query change and this
 * destination turns it into history — `replace` for a filter change, so Back steps
 * through destinations rather than keystrokes.
 */
function useIssues(query: IssueQuery): IssuesOutcome {
  const [outcome, setOutcome] = useState<IssuesOutcome>({ kind: "loading" });
  const key = `${query.filters.disposition}|${query.filters.project}|${query.filters.kind}|${query.filters.severity}|${query.filters.q}|${query.offset}`;
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setOutcome({ kind: "loading" });
    void readIssues(fetch, query, controller.signal).then((result) => {
      if (current) setOutcome((previous) => keepPreviousOnLoad(previous, issuesOutcome(result, query)));
    });
    return () => {
      current = false;
      controller.abort();
    };
    // The key is the request's identity: a new object with the same values must not
    // refetch on every render.
  }, [key]);
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
}) {
  const query = props.scope === null ? props.query : { ...props.query, filters: { ...props.query.filters, project: props.scope } };
  // The previous rows stay painted while the next read is in flight, so the search box
  // is never unmounted between keystrokes.
  const outcome = useIssues(query);
  const copy = useCopy();

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
    />
  );
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
  const [outcome, setOutcome] = useState<WorkflowsOutcome>({ kind: "loading" });
  const copy = useCopy();
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    void readWorkflows(fetch, controller.signal).then((result) => {
      if (current) setOutcome(workflowsOutcome(result));
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, []);

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

  return (
    <Workflows
      model={outcome.model}
      copy={workflowsCopy(copy)}
      onOpen={(id) => {
        navigate({ name: "workflow", id }, props.address.query, "push");
      }}
    />
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

  return (
    <WorkflowDetail
      model={outcome.model}
      copy={workflowDetailCopy(copy)}
      onBack={() => {
        const target = detailReturnTarget(parseRoute(window.location.hash));
        if (target !== null) navigate(target.route, target.query, "push");
      }}
    />
  );
}

/** The Iterations list, behind its own read. */
/** The Iterations list at one scope: `null` store-wide, or a project's own. */
function IterationListScreen(props: { scope: string | null; onOpen?: (id: string) => void }) {
  const [outcome, setOutcome] = useState<IterationsOutcome>({ kind: "loading" });
  const copy = useCopy();
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setOutcome({ kind: "loading" });
    void readIterations(fetch, props.scope, controller.signal).then((result) => {
      if (current) setOutcome(iterationsOutcome(result));
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
        heading={copy.iterations.pageTitle}
        body={copy.state.unavailable.body}
        reason={outcome.message}
      />
    );
  }

  return <Iterations model={outcome.model} copy={iterationsCopy(copy)} onOpen={props.onOpen} />;
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
        // The default feature is the route model's: `#project/<id>` means Roadmap.
        navigate({ name: "project", id: projectId, feature: DEFAULT_PROJECT_FEATURE }, "", "push");
      }}
    />
  );
}

/**
 * One project: the identity head, the three fixed features, and the selected
 * feature's content. `Roadmap` is the route's default and never "the first
 * feature with data".
 */
function ProjectDetailDestination(props: { address: Address; feature: ProjectFeature; projectIds: readonly string[] }) {
  const projectId = props.address.route.name === "project" ? props.address.route.id : "";
  const [outcome, setOutcome] = useState<RoadmapOutcome>({ kind: "loading" });
  const [identity, setIdentity] = useState<{ title: string; description: string | null } | null>(null);
  const copy = useCopy();

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setOutcome({ kind: "loading" });
    void readRoadmap(fetch, projectId, controller.signal).then((result) => {
      if (!current) return;
      const next = roadmapOutcome(result, projectId);
      setOutcome(next);
      if (next.kind === "ready") setIdentity({ title: next.identity.title, description: next.identity.description });
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [projectId]);

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
      identity={outcome.identity}
      feature={props.feature}
      onFeatureChange={(feature) => {
        navigate({ name: "project", id: projectId, feature }, "", "push");
      }}
      roadmap={outcome.roadmap}
      issues={
        <IssueListScreen
          // The route carries the feature's own filter state; the page supplies only
          // the scope. A frozen query with an empty callback made every control inert.
          query={props.address.query === "" ? DEFAULT_ISSUES : routeFilters({ route: props.address.route, query: props.address.query })}
          projectIds={props.projectIds}
          scope={projectId}
          onQueryChange={(next) => {
            const target = scopedIssuesTarget(projectId, next);
            // `replace`: a filter change must not become a Back step per keystroke.
            navigate(target.route, target.query, "replace");
          }}
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
          onOpen={(id) => navigate({ name: "iteration", id }, props.address.query, "push")}
        />
      }
      copy={projectDetailCopy(copy)}
      onBack={() => {
        navigate({ name: "projects" }, "", "push");
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
      const parent = parentAddress(address);
      if (parent === null) return;
      event.preventDefault();
      navigate(parent.route, parent.query, "push");
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
      <header className="app-header">
        <span className="app-title">Morning Star</span>
        <Nav
          items={chrome.navItems}
          activeId={activeId}
          onSelect={(id) => {
            // A destination change is a push: Back returns to where the reader was.
            navigate({ name: id as (typeof LIST_DESTINATIONS)[number] }, "", "push");
          }}
          label={copy.shell.nav.primary}
        />
        <div className="app-controls">
          <Switch
            label={copy.shell.theme.label}
            value={props.theme}
            options={[
              { value: "light", label: copy.shell.theme.light },
              { value: "dark", label: copy.shell.theme.dark },
            ]}
            onChange={(value) => props.onThemeChange(value === "dark" ? "dark" : "light")}
          />
          <Switch
            label={copy.shell.language.label}
            value={props.locale}
            options={[
              { value: "en", label: copy.shell.language.en },
              { value: "zh", label: copy.shell.language.zh },
            ]}
            onChange={(value) => props.onLocaleChange(value === "zh" ? "zh" : "en")}
          />
          {props.persisted ? null : <p className="app-switch-note">{copy.shell.store.sessionOnly}</p>}
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
        {address.route.name === "overview" ? <OverviewDestination /> : null}
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
          />
        ) : null}
      </main>
      <footer className="app-footer">{chrome.footer}</footer>
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

/** One switch: a label and a select, both driven by the dictionary. */
function Switch(props: { label: string; value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void }) {
  return (
    <label className="app-switch">
      <span className="app-switch-label">{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
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
