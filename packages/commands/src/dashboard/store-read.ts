/**
 * CLI store-read transport -- the dashboard API's URL surface.
 *
 * URL knowledge only: the fixed route table, the detail-path decode and the
 * route-level id refusal. Query validation and execution live in the engine's
 * `dashboard-view` layer, which every transport shares (contract §6), so this
 * module re-exports it rather than restating a single rule.
 */
import { refuse, requireSafeId, type DashboardView } from "@mstar-harness/engine";

export {
  MAX_DASHBOARD_SEARCH_LENGTH,
  dashboardFailure,
  dashboardFilters,
  readDashboardView,
} from "@mstar-harness/engine";

/** The fixed list routes; `/api/<resource>/<id>` selects the detail view. */
export const DASHBOARD_API_VIEWS = {
  "/api/issues": "issues",
  "/api/issue-flow": "issue-flow",
  "/api/workflows": "workflows",
  "/api/iterations": "iterations",
  "/api/roadmap": "roadmap",
  "/api/projects": "projects",
  // The aggregated read: one list-shaped route whose only filter is `project`.
  "/api/overview": "overview",
  // Read-only binding panel: `[linear]` summary + readiness (with its cause).
  "/api/sync-binding": "sync-binding",
} as const;

/** Detail resource → contract §6 view. */
const DASHBOARD_DETAIL_VIEWS: Record<string, DashboardView> = {
  issues: "issue-detail",
  workflows: "workflow-detail",
  iterations: "iteration-detail",
};

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
