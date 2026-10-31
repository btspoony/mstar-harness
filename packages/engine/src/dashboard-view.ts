/**
 * Dashboard view layer — the generic half of the dashboard read transport.
 *
 * One view name becomes validated `DashboardFilters`, then one `withStoreRead`
 * envelope: unknown enum values, an over-limit page and an excessive literal
 * search (>200 chars) are refused before any store access, and an id/project
 * that could not be a catalog id (a path separator or a traversal segment) is
 * refused as a usage error rather than passed on.
 *
 * No transport knowledge lives here. The CLI's HTTP server and the dsh panel
 * endpoint each keep their own route/argument surface and call this layer, so
 * the refusals above have exactly one implementation.
 *
 * Execution route: projection-backed views are served through the engine's
 * read boundary, which refreshes their projection from the current authority.
 */
import { SddScriptError } from "./sdd.js";
import { queryDashboard, querySyncBinding, withStoreRead, type StoreReadQuery, type SyncProbeState } from "./store-read.js";
import type { IssueFilter } from "./issue.js";
import type { StoreContext } from "./store-db.js";
import type { DashboardFilters, DashboardView, DashboardViewData, ReadEnvelope } from "./store-read.js";

/** Longest accepted literal search (dashboard D2). */
export const MAX_DASHBOARD_SEARCH_LENGTH = 200;

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
  projects: [],
  // `project` scopes milestones, latestIteration and issueFlow; the view reads
  // no page window and no issue filter, so both keep refusing.
  overview: ["project"],
  // The host may attach ONE probe result; both fields ride together or neither.
  "sync-binding": ["probe_state", "probe_cause"],
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
const SEVERITIES: Record<string, true> = { critical: true, high: true, medium: true, low: true, nit: true };

/** The host probe vocabulary (`ProbeResult`); `not-probed` is never accepted as input. */
const SYNC_PROBE_STATES: Record<SyncProbeState, true> = {
  ready: true,
  "service-absent": true,
  unreachable: true,
  "access-denied": true,
};

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

// The URL route table in `@mstar-harness/commands` still resolves a pathname to
// a detail id, so it needs the same refusal convention -- exported rather than
// copied, so both transports refuse with one message source.
export { refuse, requireSafeId };

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

  if (view === "sync-binding") {
    const probeState = queryValue(params, "probe_state");
    const probeCause = queryValue(params, "probe_cause");
    if (probeState === undefined && probeCause !== undefined) {
      refuse("probe_cause requires probe_state — supply the host probe result as a pair");
    }
    if (probeState !== undefined && !(probeState in SYNC_PROBE_STATES)) {
      refuse(`probe_state must be one of ${Object.keys(SYNC_PROBE_STATES).join(", ")}`);
    }
    if (probeCause !== undefined && probeCause.length > MAX_DASHBOARD_SEARCH_LENGTH) {
      refuse(`probe_cause must be at most ${MAX_DASHBOARD_SEARCH_LENGTH} characters`);
    }
    return {
      ...(probeState === undefined ? {} : { probeState: probeState as SyncProbeState }),
      ...(probeCause === undefined ? {} : { probeCause }),
    };
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
  const query: StoreReadQuery<DashboardViewData[DashboardView]> =
    input.view === "sync-binding"
      ? querySyncBinding(input.context.harnessDir, filters)
      : queryDashboard(input.view, filters);
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
