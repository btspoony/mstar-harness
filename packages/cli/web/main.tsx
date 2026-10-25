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
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider, MS_CONTAINER_CLASS, MS_THEME_ATTRIBUTE, Nav } from "@mstar-harness/ui";

/**
 * The four destinations, in the product's order. Task 2 replaces the static list
 * with the route table; the shell only needs to know there are four.
 */
const DESTINATIONS = [
  { id: "issues", label: "Issues" },
  { id: "workflows", label: "Workflows" },
  { id: "iterations", label: "Iterations" },
  { id: "projects", label: "Projects" },
] as const;

type DestinationId = (typeof DESTINATIONS)[number]["id"];

/** `#<destination>` selects a destination; anything else lands on the first. */
function activeDestination(hash: string): DestinationId {
  const segment = hash.replace(/^#/, "").split("/")[0];
  const match = DESTINATIONS.find((destination) => destination.id === segment);
  return match?.id ?? "issues";
}

/** The shell: skip link, header with the shared navigation, the main region, footer. */
function Shell() {
  const [active, setActive] = useState<DestinationId>(() => activeDestination(window.location.hash));

  useEffect(() => {
    const onHashChange = (): void => {
      setActive(activeDestination(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <span className="app-title">Morning Star</span>
        <Nav
          items={DESTINATIONS.map((destination) => ({ id: destination.id, label: destination.label }))}
          activeId={active}
          onSelect={(id) => {
            window.location.hash = `#${id}`;
          }}
          label="Primary"
        />
      </header>
      {/* The main region is empty until the destinations are ported: an empty
          container makes no claim, where placeholder copy would claim a state the
          dashboard cannot answer yet. */}
      <main id="main" className="app-main" />
      <footer className="app-footer">Read-only · Make changes with the CLI</footer>
    </>
  );
}

function Boot() {
  return (
    <StrictMode>
      <LocaleProvider locale="en">
        <Shell />
      </LocaleProvider>
    </StrictMode>
  );
}

/** The wrapper the shell renders into, with both host contracts applied. */
function mount(): void {
  const rootElement = document.getElementById("app");
  if (rootElement === null) return;
  rootElement.setAttribute(MS_THEME_ATTRIBUTE, "light");
  rootElement.classList.add(MS_CONTAINER_CLASS);
  createRoot(rootElement).render(<Boot />);
}

mount();
