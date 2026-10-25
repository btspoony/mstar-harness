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
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider, MS_CONTAINER_CLASS, MS_THEME_ATTRIBUTE, Nav } from "@mstar-harness/ui";

import { LIST_DESTINATIONS, parentAddress, parseRoute, routeHash, type Address, type Route } from "./route";

/** The navigation entries: the four lists, in the product's order. */
const NAV_ITEMS = LIST_DESTINATIONS.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));

/**
 * Push a destination, or replace the current entry when only the filters changed.
 *
 * A route change pushes so Back steps through destinations; a filter change
 * replaces so Back does not step through keystrokes (the Preact dashboard's
 * behaviour, kept).
 */
function navigate(route: Route, query: string, mode: "push" | "replace"): void {
  const hash = routeHash(route, query);
  if (mode === "push") window.history.pushState(null, "", hash);
  else window.history.replaceState(null, "", hash);
  // `pushState`/`replaceState` do not fire `hashchange`; the listener below only
  // sees Back/Forward and hand-edited hashes.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** The shell: skip link, header with the shared navigation, the main region, footer. */
function Shell() {
  const [address, setAddress] = useState<Address>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHashChange = (): void => {
      setAddress(parseRoute(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  /**
   * Escape goes to the parent destination with the query preserved: a reader who
   * filtered a list and opened a record returns to the same filtered list, not to
   * an unfiltered one. At the landing destination there is no parent and the key
   * does nothing, which is the honest answer rather than a no-op that looks like
   * a bug.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape") return;
      const parent = parentAddress(address);
      if (parent === null) return;
      event.preventDefault();
      navigate(parent.route, parent.query, "push");
    },
    [address],
  );

  // A list destination is active when the route is that list or one of its
  // details; the landing destination highlights nothing.
  const activeId = navItemFor(address.route);

  return (
    <div className="app-shell" onKeyDown={onKeyDown}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <span className="app-title">Morning Star</span>
        <Nav
          items={NAV_ITEMS}
          activeId={activeId}
          onSelect={(id) => {
            // A destination change is a push: Back returns to where the reader was.
            navigate({ name: id as (typeof LIST_DESTINATIONS)[number] }, "", "push");
          }}
          label="Primary"
        />
      </header>
      {/* The main region resolves the URL but renders no destination yet: Tasks 3–4
          mount the screens. Rendering an empty container makes no claim, where
          placeholder copy would claim a state the dashboard cannot answer. */}
      <main id="main" className="app-main" data-ms-route={routeHash(address.route)} />
      <footer className="app-footer">Read-only · Make changes with the CLI</footer>
    </div>
  );
}

/**
 * Which navigation entry a route belongs to: a detail belongs to its list, a
 * project feature to Projects, the landing destination to none.
 */
function navItemFor(route: Route): string | null {
  switch (route.name) {
    case "overview":
      return null;
    case "issue":
      return "issues";
    case "workflow":
      return "workflows";
    case "iteration":
      return "iterations";
    case "project":
      return "projects";
    default:
      return route.name;
  }
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
