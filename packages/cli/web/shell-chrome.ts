/**
 * The shell's chrome — its navigation entries, its skip link, its footer — and the
 * one behaviour the skip link owes.
 *
 * Two defects live here rather than in `main.tsx`, because both are cheaper to pin
 * as data and behaviour than to re-derive by reading markup:
 *
 *  - The navigation entries are **copy**, from `shell.nav.*`. They were derived by
 *    capitalising the route id, which produced English labels in every locale —
 *    the same class of defect as an `aria-label` literal, since nothing paints the
 *    source of a label and so nothing went red when Chinese shipped.
 *  - The skip link must **move focus, not navigate**. The hash is the routing
 *    channel: `#main` resolves to Overview and `hashchange` scrolls to top, so the
 *    affordance threw the reader back to the landing page, discarded their filters,
 *    and never moved focus.
 */
import { issueQuery, type Copy, type IssueQuery } from "@mstar-harness/ui";

import { LIST_DESTINATIONS, type Route } from "./route";

/** The entries the navigation shows, Overview first: it is the landing destination. */
export const NAV_DESTINATIONS = ["overview", ...LIST_DESTINATIONS] as const;
export type NavDestination = (typeof NAV_DESTINATIONS)[number];

export type ShellChrome = {
  navItems: readonly { id: NavDestination; label: string }[];
  skipLink: string;
  footer: string;
  /** `1224 store revision` — the projection generation the read was served at. */
  storeRevision: (generation: number) => string;
  /** The footer's leading open-issue count. */
  openIssueCount: (n: number) => string;
};

/** Every string the shell itself shows, read from one dictionary. */
export function shellChrome(copy: Copy): ShellChrome {
  return {
    navItems: NAV_DESTINATIONS.map((id) => ({ id, label: copy.shell.nav[id] })),
    skipLink: copy.shell.skipLink,
    footer: copy.shell.footer,
    storeRevision: copy.shell.storeRevision,
    openIssueCount: copy.shell.openIssueCount,
  };
}

/** What a click on the skip link must do, with the DOM kept at arm's length. */
export function skipToMain(
  event: { preventDefault(): void },
  main: () => { focus(): void } | null,
): void {
  // Cancelled unconditionally: letting the hash through would route, and a router
  // that lands on Overview is worse than an affordance that does nothing.
  event.preventDefault();
  main()?.focus();
}

/** The nav entry a route belongs to, or `null` for a destination-less route. */
export function navItemFor(route: Route | { name: string }): NavDestination | null {
  switch (route.name) {
    case "overview":
      return "overview";
    case "issue":
      return "issues";
    case "workflow":
      return "workflows";
    case "iteration":
      return "iterations";
    case "project":
      return "projects";
    case "issues":
    case "workflows":
    case "iterations":
    case "projects":
      return route.name;
    default:
      return null;
  }
}

/**
 * Where a project's Issues feature reports a change to.
 *
 * The address bar is how that feature keeps state, so a filter or page change has to
 * become a route with a query — not a callback into nothing. `project` is dropped
 * because the page owns the scope: it forces `project=<id>` on the request, and a
 * second copy in the URL would scope the page twice.
 */
export function scopedIssuesTarget(
  projectId: string,
  query: IssueQuery,
): { route: Extract<Route, { name: "project" }>; query: string } {
  return {
    route: { name: "project", id: projectId, feature: "issues" },
    // Cleared, not deleted: the query pair skips an empty value but would serialise a
    // *missing* key as the literal string `undefined`.
    query: issueQuery({ filters: { ...query.filters, project: "" }, offset: query.offset }),
  };
}
