/**
 * Dashboard browser entry — bundled by scripts/build-web.ts into an offline
 * string served from /assets/app.js. Preact + htm template-tag components,
 * no JSX plugin, no CDN or remote assets (DESIGN.md, plan 20260918-dashboard).
 *
 * D3 wires the Issues destination (list + detail); D4 registers the remaining
 * three views in `WIRED_DESTINATIONS`, which is also what the navigation shows,
 * so no destination is ever a dead link.
 */
import { render } from "preact";
import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { IssueDetailView, IssuesView } from "./views/issues";

const NAV_ITEMS = [
  { id: "issues", label: "Issues" },
  { id: "workflows", label: "Workflows" },
  { id: "iterations", label: "Iterations" },
  { id: "roadmap", label: "Roadmap" },
] as const;

type DestinationId = (typeof NAV_ITEMS)[number]["id"];

/** Destinations with a view module in this build. */
const WIRED_DESTINATIONS: ReadonlyArray<DestinationId> = ["issues"];

type Route = { name: "issues" } | { name: "issue"; id: string };

/** `#issue/<id>` selects the detail; anything else is the default landing. */
function parseRoute(hash: string): Route {
  const segments = hash.replace(/^#/, "").split("/");
  if (segments[0] === "issue" && segments[1] !== undefined && segments[1] !== "") {
    try {
      return { name: "issue", id: decodeURIComponent(segments[1]) };
    } catch {
      return { name: "issues" };
    }
  }
  return { name: "issues" };
}

function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  // The issue link to refocus when the list comes back (DESIGN.md: closing
  // details returns focus to the originating issue link).
  const returnFocusId = useRef<string | null>(null);

  useEffect(() => {
    const onHashChange = (): void => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const active: DestinationId = route.name === "issue" ? "issues" : route.name;

  return html`
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="app-header">
      <nav class="app-nav" aria-label="Primary">
        <span class="app-title">Morning Star</span>
        ${NAV_ITEMS.filter((item) => WIRED_DESTINATIONS.includes(item.id)).map(
          (item) => html`
            <a
              key=${item.id}
              class="nav-link${item.id === active ? " is-active" : ""}"
              href=${`#${item.id}`}
              aria-current=${item.id === active ? "page" : null}
            >
              ${item.label}
            </a>
          `,
        )}
      </nav>
    </header>
    <main id="main" class="app-main">
      ${route.name === "issue"
        ? html`<${IssueDetailView} key=${route.id} id=${route.id} />`
        : html`<${IssuesView}
            focusIssueId=${returnFocusId.current}
            onFocusRestored=${() => {
              returnFocusId.current = null;
            }}
            onOpenIssue=${(id: string) => {
              returnFocusId.current = id;
            }}
          />`}
    </main>
    <footer class="app-footer">Read-only · Make changes with the CLI</footer>
  `;
}

const root = document.getElementById("app");
if (root) {
  render(html`<${App} />`, root);
}
