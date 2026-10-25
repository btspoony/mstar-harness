/**
 * The URL contract (compass D27) — one grammar for the dashboard and for any link
 * the product emits.
 *
 * It extends the hash grammar the Preact dashboard already shipped rather than
 * inventing a second one: plural destination segments, singular detail segments
 * with an id, and a query string that belongs to the filters.
 *
 * Three rules carry the semantics, and each is a decision rather than a parsing
 * detail:
 *
 *  - **`#roadmap` is removed, not aliased.** The roadmap is a project feature now
 *    (D8); an alias would keep a dead vocabulary alive. The route is absent from
 *    the model, so unrecognised input — including it — lands on `#overview`.
 *  - **The query string belongs to the filters.** The screens never see a URL, so
 *    this module is where the filter keys are read and written; it delegates to the
 *    shared `parseIssueQuery` / `issueQuery` pair rather than re-deriving keys, and
 *    the round-trip is therefore the same one the panel uses.
 *  - **One authority per page.** A project feature page scopes the API call with
 *    `project=<id>`; a `project` key in the address bar would scope it twice, so it
 *    is dropped on the way in.
 */
import { issueQuery, parseIssueQuery, type IssueQuery } from "@mstar-harness/ui";

/** The features a project detail exposes, in the product's fixed order (IA §4). */
export const PROJECT_FEATURES = ["roadmap", "issues", "iterations"] as const;
export type ProjectFeature = (typeof PROJECT_FEATURES)[number];

/** The default feature — always Roadmap, for every project (IA §4). */
export const DEFAULT_PROJECT_FEATURE: ProjectFeature = "roadmap";

/** The four list destinations, in navigation order. */
export const LIST_DESTINATIONS = ["issues", "workflows", "iterations", "projects"] as const;
export type ListDestination = (typeof LIST_DESTINATIONS)[number];

/** A destination and the query string it arrived with. */
export type Address = { readonly route: Route; readonly query: string };

/** One addressable route. The union is the contract: a route not here cannot be emitted. */
export type Route =
  | { name: "overview" }
  | { name: ListDestination }
  | { name: "issue"; id: string }
  | { name: "workflow"; id: string }
  | { name: "iteration"; id: string }
  | { name: "project"; id: string; feature: ProjectFeature };

/** The landing route: `#`, `#/` and anything unrecognised. */
export const OVERVIEW: Route = { name: "overview" };

/** Detail segment → the destination it belongs to. Singular in, plural out. */
const DETAIL_PARENT = {
  issue: "issues",
  workflow: "workflows",
  iteration: "iterations",
} as const;

type DetailSegment = keyof typeof DETAIL_PARENT;

function isDetailSegment(value: string): value is DetailSegment {
  return value === "issue" || value === "workflow" || value === "iteration";
}

function isListDestination(value: string): value is ListDestination {
  return (LIST_DESTINATIONS as readonly string[]).includes(value);
}

function isProjectFeature(value: string): value is ProjectFeature {
  return (PROJECT_FEATURES as readonly string[]).includes(value);
}

/**
 * Split a hash into its path segments and its query string.
 *
 * A hash always starts with `#` (or is empty); anything else is not an address at
 * all, and the parser says so rather than treating a bare word as a route.
 */
function isHash(value: string): boolean {
  return value === "" || value.startsWith("#");
}

/** Split a hash into its path segments and its query string, tolerating `#`/`#/`. */
function splitHash(hash: string): { segments: string[]; query: string } {
  const withoutHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const [rawPath = "", ...queryParts] = withoutHash.split("?");
  const query = queryParts.join("?");
  const segments = rawPath.split("/").filter((segment) => segment !== "");
  return { segments, query };
}

/** Decode one path segment, or `null` when it is malformed. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The route a hash addresses.
 *
 * Unrecognised input — including `#roadmap` — is the landing destination. The
 * parser never guesses a nearest match: a wrong route that renders is worse than a
 * landing page that is honest about where the reader is.
 */
export function parseRoute(hash: string): Address {
  if (!isHash(hash)) return { route: OVERVIEW, query: "" };
  const { segments, query } = splitHash(hash);
  const route = parseSegments(segments);
  // A project feature page has its own scoping authority, so a `project` key in
  // the address bar would scope it twice.
  return { route, query: queryFor(route, query) };
}

function parseSegments(segments: readonly string[]): Route {
  const first = segments[0];
  if (first === undefined) return OVERVIEW;

  if (first === "overview") return OVERVIEW;
  if (isListDestination(first)) return { name: first };

  if (first === "project") {
    const rawId = segments[1];
    if (rawId === undefined) return OVERVIEW;
    const id = decodeSegment(rawId);
    if (id === null || id === "") return OVERVIEW;
    const rawFeature = segments[2];
    const feature = rawFeature !== undefined && isProjectFeature(rawFeature) ? rawFeature : DEFAULT_PROJECT_FEATURE;
    return { name: "project", id, feature };
  }

  if (isDetailSegment(first)) {
    const rawId = segments[1];
    if (rawId === undefined) return OVERVIEW;
    const id = decodeSegment(rawId);
    if (id === null || id === "") return OVERVIEW;
    return { name: first, id };
  }

  return OVERVIEW;
}

/**
 * The hash a route emits.
 *
 * The query string is passed in rather than carried on the route, because a route
 * is a destination and a query is a filter state: keeping them separate is what
 * lets a project page drop a stale `project` key without inventing a second route.
 */
export function routeHash(route: Route, query = ""): string {
  const base = (() => {
    switch (route.name) {
      case "overview":
        return "#overview";
      case "issue":
      case "workflow":
      case "iteration":
        return `#${route.name}/${encodeURIComponent(route.id)}`;
      case "project":
        return `#project/${encodeURIComponent(route.id)}/${route.feature}`;
      default:
        return `#${route.name}`;
    }
  })();
  return query === "" ? base : `${base}?${query}`;
}

/**
 * The query string for a destination, with the keys that would scope the page
 * twice removed.
 *
 * Only a project feature page has a second scoping authority, so only there does
 * `project` disappear; every other route keeps the filters the reader arrived with.
 */
export function queryFor(route: Route, query: string): string {
  if (query === "" || route.name !== "project") return query;
  const params = new URLSearchParams(query);
  if (!params.has("project")) return query;
  // Removed, not normalised: round-tripping through the filter model would also
  // write the keys the reader never wrote (`disposition=open`, `limit=50`), which
  // changes the address they are looking at.
  params.delete("project");
  return params.toString();
}

/**
 * The address one step out, or `null` at the landing destination.
 *
 * Escape and the breadcrumb are the same move from two controls, so they share
 * one function: a second implementation is how the two drift into disagreeing
 * about whether the reader's filters survive.
 */
export function parentAddress(address: Address): Address | null {
  const parent = parentOf(address.route);
  return parent === null ? null : { route: parent, query: address.query };
}

/** The filters an address carries, decoded through the shared pair. */
export function routeFilters(address: Address): IssueQuery {
  return parseIssueQuery(address.query);
}

/**
 * The parent a detail returns to — Escape and the breadcrumb — or `null` at the
 * landing destination.
 *
 * A project feature goes back to its project's roadmap before leaving the project,
 * so leaving is always one step further out rather than one step sideways.
 */
export function parentOf(route: Route): Route | null {
  switch (route.name) {
    case "overview":
      return null;
    case "issue":
    case "workflow":
    case "iteration":
      return { name: DETAIL_PARENT[route.name] };
    case "project":
      return route.feature === DEFAULT_PROJECT_FEATURE
        ? { name: "projects" }
        : { name: "project", id: route.id, feature: DEFAULT_PROJECT_FEATURE };
    default:
      return OVERVIEW;
  }
}
