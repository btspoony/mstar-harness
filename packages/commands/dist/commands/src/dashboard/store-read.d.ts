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
import { type DashboardFilters, type DashboardView, type DashboardViewData, type ReadEnvelope, type StoreContext } from "@mstar-harness/engine";
/** Longest accepted literal search (dashboard D2). */
export declare const MAX_DASHBOARD_SEARCH_LENGTH = 200;
/** The fixed list routes; `/api/<resource>/<id>` selects the detail view. */
export declare const DASHBOARD_API_VIEWS: {
    readonly "/api/issues": "issues";
    readonly "/api/issue-flow": "issue-flow";
    readonly "/api/workflows": "workflows";
    readonly "/api/iterations": "iterations";
    readonly "/api/roadmap": "roadmap";
};
/**
 * One pathname → view (+ the detail id). `null` means the path is not one of
 * the dashboard's fixed routes; the caller answers 404 rather than guessing.
 */
export declare function resolveDashboardRoute(pathname: string): {
    view: DashboardView;
    id?: string;
} | null;
/**
 * Raw query parameters → engine filters, refusing everything the contract does
 * not define. Called before any store access, so a malformed request never
 * opens the database.
 */
export declare function dashboardFilters(view: DashboardView, params?: Record<string, string | undefined>, id?: string): DashboardFilters;
/** Execute one dashboard view and return the engine's read envelope. */
export declare function readDashboardView(input: {
    context: StoreContext;
    view: DashboardView;
    params?: Record<string, string | undefined>;
    id?: string;
}): Promise<ReadEnvelope<DashboardViewData[DashboardView]>>;
/**
 * Structured failure for an API response: the frozen refusal code, the engine's
 * usage class, or an internal fallback -- never a raw payload or credential.
 */
export declare function dashboardFailure(error: unknown): {
    code: string;
    message: string;
};
