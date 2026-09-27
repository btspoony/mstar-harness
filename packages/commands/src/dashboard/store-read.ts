/**
 * CLI store-read transport -- the dashboard API's read surface over the engine
 * read boundary (contract §6).
 *
 * The dashboard plan owns the HTTP server; this module owns everything between
 * a request and the engine: the fixed route table, query-parameter validation
 * with the contract's refusals, and the structured failure shape. It adds no
 * authority of its own -- every answer is an engine `ReadEnvelope` DTO, and the
 * render layer never sees source JSON.
 *
 * Validation rules (§6 + dashboard D2): unknown enum values, an over-limit page
 * and an excessive literal search (>200 chars) are refused before any store
 * access, and an id/project that could not be a catalog id (a path separator or
 * a traversal segment) is refused as a route/usage error rather than passed on.
 *
 * Execution route (primary spec §5, plan S2): a view whose envelope comes from
 * a projection refresh is refused with `execution.consumer-not-ready` while the
 * control harness's execution authority is ACTIVE. The refresh's sources are
 * the root register and the workflow snapshots — exactly the files activation
 * retires — so serving that view would present retired bytes as current
 * execution state, and rebuilding these DTOs from the DB authority is the
 * separate release obligation. The issue/catalog views never read the
 * projection and keep answering, since the issue authority is unchanged by
 * execution activation.
 */
import {
  SddScriptError,
  StoreError,
  queryDashboard,
  resolveExecutionReadRoute,
  withStoreRead,
  type DashboardFilters,
  type DashboardView,
  type DashboardViewData,
  type IssueFilter,
  type ReadEnvelope,
  type StoreContext,
} from "@mstar-harness/engine";

/** Longest accepted literal search (dashboard D2). */
export const MAX_DASHBOARD_SEARCH_LENGTH = 200;

/** The fixed list routes; `/api/<resource>/<id>` selects the detail view. */
export const DASHBOARD_API_VIEWS = {
  "/api/issues": "issues",
  "/api/issue-flow": "issue-flow",
  "/api/workflows": "workflows",
  "/api/iterations": "iterations",
  "/api/roadmap": "roadmap",
} as const;

/** Detail resource → contract §6 view. */
const DASHBOARD_DETAIL_VIEWS: Record<string, DashboardView> = {
  issues: "issue-detail",
  workflows: "workflow-detail",
  iterations: "iteration-detail",
};

/** Accepted query fields per view; anything else is a usage refusal. */
const VIEW_QUERY_FIELDS: Record<DashboardView, readonly string[]> = {
  issues: ["project", "disposition", "kind", "severity", "q", "limit", "offset"],
  "issue-detail": [],
  workflows: ["project", "limit", "offset"],
  "workflow-detail": [],
  iterations: ["project", "limit", "offset"],
  "iteration-detail": [],
  roadmap: ["project"],
  "issue-flow": ["project"],
};

const DISPOSITIONS: Record<string, true> = { open: true, resolved: true, waived: true, duplicate: true, superseded: true };
const KINDS: Record<string, true> = {
  bug: true,
  risk: true,
  improvement: true,
  request: true,
  decision: true,
  "review-obligation": true,
};
const SEVERITIES: Record<string, true> = { critical: true, high: true, medium: true, low: true, info: true };

function refuse(message: string): never {
  throw new SddScriptError(message, 2);
}

/** An id that could be a catalog/issue id: no separators, no traversal segment. */
function requireSafeId(label: string, value: string): string {
  if (value === "" || value === "." || value === ".." || /[/\\\u0000]/.test(value)) {
    refuse(`${label} must be a single safe id`);
  }
  return value;
}

/**
 * One pathname → view (+ the detail id). `null` means the path is not one of
 * the dashboard's fixed routes; the caller answers 404 rather than guessing.
 */
export function resolveDashboardRoute(pathname: string): { view: DashboardView; id?: string } | null {
  const exact = (DASHBOARD_API_VIEWS as Record<string, DashboardView>)[pathname];
  if (exact !== undefined) return { view: exact };
  const segments = pathname.split("/");
  if (segments.length !== 4 || segments[1] !== "api" || segments[3] === "") return null;
  const detail = DASHBOARD_DETAIL_VIEWS[segments[2] as string];
  if (detail === undefined) return null;
  let id: string;
  try {
    id = decodeURIComponent(segments[3] as string);
  } catch {
    refuse(`path segment ${JSON.stringify(segments[3])} is not valid percent-encoding`);
  }
  return { view: detail, id: requireSafeId("the detail id", id) };
}

function queryValue(params: Record<string, string | undefined>, field: string): string | undefined {
  const value = params[field];
  if (value === undefined || value === "") return undefined;
  return value;
}

function parsePageInteger(raw: string | undefined, field: string, max?: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/.test(raw)) refuse(`${field} must be a nonnegative integer`);
  const value = Number(raw);
  if (max !== undefined && (value < 1 || value > max)) refuse(`${field} must be an integer between 1 and ${max}`);
  return value;
}

/**
 * Raw query parameters → engine filters, refusing everything the contract does
 * not define. Called before any store access, so a malformed request never
 * opens the database.
 */
export function dashboardFilters(
  view: DashboardView,
  params: Record<string, string | undefined> = {},
  id?: string,
): DashboardFilters {
  const accepted = VIEW_QUERY_FIELDS[view];
  if (!Array.isArray(accepted)) refuse(`unknown dashboard view ${JSON.stringify(String(view))}`);
  for (const field of Object.keys(params)) {
    if (!accepted.includes(field)) refuse(`${JSON.stringify(field)} is not a supported ${view} query parameter`);
  }

  const limit = parsePageInteger(queryValue(params, "limit"), "limit", 200);
  const offset = parsePageInteger(queryValue(params, "offset"), "offset");
  const project = queryValue(params, "project");
  const scoped = project === undefined ? undefined : requireSafeId("project", project);

  if (view === "issues") {
    const disposition = queryValue(params, "disposition");
    if (disposition !== undefined && DISPOSITIONS[disposition] !== true) {
      refuse(`disposition must be one of ${Object.keys(DISPOSITIONS).join(", ")}`);
    }
    const kind = queryValue(params, "kind");
    if (kind !== undefined && KINDS[kind] !== true) refuse(`kind must be one of ${Object.keys(KINDS).join(", ")}`);
    const severity = queryValue(params, "severity");
    if (severity !== undefined && SEVERITIES[severity] !== true) {
      refuse(`severity must be one of ${Object.keys(SEVERITIES).join(", ")}`);
    }
    const search = queryValue(params, "q");
    if (search !== undefined && search.length > MAX_DASHBOARD_SEARCH_LENGTH) {
      refuse(`q must be at most ${MAX_DASHBOARD_SEARCH_LENGTH} characters`);
    }
    const issue: IssueFilter = {
      ...(scoped === undefined ? {} : { projectId: scoped }),
      ...(disposition === undefined ? {} : { disposition: disposition as IssueFilter["disposition"] }),
      ...(kind === undefined ? {} : { kind: kind as IssueFilter["kind"] }),
      ...(severity === undefined ? {} : { severity: severity as IssueFilter["severity"] }),
      ...(search === undefined ? {} : { query: search }),
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    };
    return { issue };
  }

  if (view === "issue-detail" || view === "workflow-detail" || view === "iteration-detail") {
    if (id === undefined) refuse(`the ${view} route requires an id`);
    return { id: requireSafeId(`${view} id`, id) };
  }

  // The roadmap view is per project; its identity is required, not guessed.
  if (view === "roadmap" && scoped === undefined) {
    refuse("the roadmap view requires a project query parameter");
  }

  return {
    ...(scoped === undefined ? {} : { projectId: scoped }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

/** Execute one dashboard view and return the engine's read envelope. */
export async function readDashboardView(input: {
  context: StoreContext;
  view: DashboardView;
  params?: Record<string, string | undefined>;
  id?: string;
}): Promise<ReadEnvelope<DashboardViewData[DashboardView]>> {
  const filters = dashboardFilters(input.view, input.params ?? {}, input.id);
  const query = queryDashboard(input.view, filters);
  // The engine's own classification of the view (its `needsProjection` flag),
  // not a second table here, decides whether a projection refresh is involved.
  if (query.needsProjection && (await resolveExecutionReadRoute(input.context)) === "execution") {
    throw new StoreError(
      "execution.consumer-not-ready",
      `The execution authority of ${input.context.harnessDir} is ACTIVE, so the "${input.view}" view's projection ` +
        `sources (the root register and the workflow snapshots) are retired. Nothing was read: this view is answered ` +
        `by the DB authority once its DTO projection lands, and the engine adapter serves workflow/plan state today.`,
    );
  }
  return withStoreRead(input.context, query);
}

/**
 * Structured failure for an API response: the frozen refusal code, the engine's
 * usage class, or an internal fallback -- never a raw payload or credential.
 */
export function dashboardFailure(error: unknown): { code: string; message: string } {
  if (error instanceof SddScriptError) return { code: "usage", message: error.message };
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && code !== "") {
    return { code, message: error instanceof Error ? error.message : String(error) };
  }
  return { code: "internal-error", message: error instanceof Error ? error.message : String(error) };
}
