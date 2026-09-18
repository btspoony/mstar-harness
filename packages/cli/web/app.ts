/**
 * Dashboard browser entry — bundled by scripts/build-web.ts into an offline
 * string served from /assets/app.js. Preact + htm template-tag components,
 * no JSX plugin, no CDN or remote assets (DESIGN.md, plan 20260918-dashboard).
 *
 * D1 carries the shell skeleton only; D3/D4 fill the views into <main>.
 */
import { render } from "preact";
import { html } from "htm/preact";

const NAV_ITEMS = [
  { id: "issues", label: "Issues" },
  { id: "workflows", label: "Workflows" },
  { id: "iterations", label: "Iterations" },
  { id: "roadmap", label: "Roadmap" },
] as const;

function App() {
  return html`
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="app-header">
      <nav class="app-nav" aria-label="Primary">
        <span class="app-title">Morning Star</span>
        ${NAV_ITEMS.map(
          (item, index) => html`
            <a
              key=${item.id}
              class="nav-link${index === 0 ? " is-active" : ""}"
              href="#${item.id}"
            >
              ${item.label}
            </a>
          `,
        )}
      </nav>
    </header>
    <main id="main" class="app-main">
      <h1 class="heading-28">Issues</h1>
      <p class="placeholder">No view data is wired yet.</p>
    </main>
    <footer class="app-footer">Read-only · Make changes with the CLI</footer>
  `;
}

const root = document.getElementById("app");
if (root) {
  render(html`<${App} />`, root);
}
