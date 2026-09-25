/**
 * Dashboard browser entry — bundled by scripts/build-web.ts into an offline
 * string served from /assets/app.js. Preact + htm template-tag components,
 * no JSX plugin, no CDN or remote assets (DESIGN.md).
 *
 * Registers the Issues, Workflows, Iterations and Roadmap destinations so all
 * four are reachable and no navigation entry is a dead link.
 */
import { render } from "preact";
import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { IssueDetailView, IssuesView } from "./views/issues";
import { IterationDetailView, IterationsView } from "./views/iterations";
import { RoadmapView } from "./views/roadmap";
import { WorkflowDetailView, WorkflowsView } from "./views/workflows";

const NAV_ITEMS = [
  { id: "issues", label: "Issues" },
  { id: "workflows", label: "Workflows" },
  { id: "iterations", label: "Iterations" },
  { id: "roadmap", label: "Roadmap" },
] as const;

type DestinationId = (typeof NAV_ITEMS)[number]["id"];

type Route =
  | { name: "issues" }
  | { name: "issue"; id: string }
  | { name: "workflows" }
  | { name: "workflow"; id: string }
  | { name: "iterations" }
  | { name: "iteration"; id: string }
  | { name: "roadmap" };

/** Which navigation entry a route belongs to (details stay under their list). */
const DESTINATION_OF: Record<Route["name"], DestinationId> = {
  issues: "issues",
  issue: "issues",
  workflows: "workflows",
  workflow: "workflows",
  iterations: "iterations",
  iteration: "iterations",
  roadmap: "roadmap",
};

/**
 * `#<destination>` selects a list, `#<resource>/<id>` its detail; anything else
 * is the default landing (Issues).
 *
 * The destination segment stays plural (`#workflows`, `#iterations`) while the
 * detail resource is singular (`#workflow/<id>`, `#iteration/<id>`, matching
 * `#issue/<id>`), exactly as the list rows link: one vocabulary, so a row href
 * always parses back to its own detail.
 */
function parseRoute(hash: string): Route {
  const segments = hash.replace(/^#/, "").split("/");
  const resource = segments[0];
  const rawId = segments[1];
  if (rawId !== undefined && rawId !== "") {
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return { name: "issues" };
    }
    if (resource === "issue") return { name: "issue", id };
    if (resource === "workflow") return { name: "workflow", id };
    if (resource === "iteration") return { name: "iteration", id };
    return { name: "issues" };
  }
  if (resource === "workflows") return { name: "workflows" };
  if (resource === "iterations") return { name: "iterations" };
  if (resource === "roadmap") return { name: "roadmap" };
  return { name: "issues" };
}

/** The one rendered slice for a route. */
function Destination(props: {
  route: Route;
  returnFocusId: string | null;
  onFocusRestored: () => void;
  onOpenIssue: (id: string) => void;
}) {
  const route = props.route;
  switch (route.name) {
    case "issue":
      return html`<${IssueDetailView} key=${route.id} id=${route.id} />`;
    case "workflow":
      return html`<${WorkflowDetailView} key=${route.id} id=${route.id} />`;
    case "iteration":
      return html`<${IterationDetailView} key=${route.id} id=${route.id} />`;
    case "workflows":
      return html`<${WorkflowsView} />`;
    case "iterations":
      return html`<${IterationsView} />`;
    case "roadmap":
      return html`<${RoadmapView} />`;
    case "issues":
      return html`<${IssuesView}
        focusIssueId=${props.returnFocusId}
        onFocusRestored=${props.onFocusRestored}
        onOpenIssue=${props.onOpenIssue}
      />`;
  }
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

  const active = DESTINATION_OF[route.name];

  return html`
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="app-header">
      <nav class="app-nav" aria-label="Primary">
        <span class="app-title">Morning Star</span>
        ${NAV_ITEMS.map(
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
      <${Destination}
        route=${route}
        returnFocusId=${returnFocusId.current}
        onFocusRestored=${() => {
          returnFocusId.current = null;
        }}
        onOpenIssue=${(id: string) => {
          returnFocusId.current = id;
        }}
      />
    </main>
    <footer class="app-footer">Read-only · Make changes with the CLI</footer>
  `;
}

const root = document.getElementById("app");
if (root) {
  render(html`<${App} />`, root);
}
