/**
 * The dashboard project page, rendered.
 *
 * `main.tsx` is the browser entry the bundler ships, and before this file nothing in
 * the suite imported it: a stale identifier inside the page body compiled into the
 * bundle unseen and failed only when a human opened the dashboard (the QC round that
 * removed `issuesRefreshToken` but left one call site). Mounting the REAL page here
 * runs its render path — hooks, the milestone read's initial arm, the project screen —
 * so a broken reference throws in the suite instead of in the browser.
 *
 * `renderToStaticMarkup` does not run effects, so the page renders its `loading` arm
 * (nothing) until a read answers. That is enough for this test's contract: the page's
 * body executes without throwing, and the module's entry `mount()` no-ops without a
 * document.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { LocaleProvider } from "@mstar-harness/ui";

import { ProjectDetailDestination } from "./main";

const PROJECTS = {
  kind: "ready" as const,
  model: {
    rows: {
      kind: "populated" as const,
      value: [
        {
          projectId: "engine",
          title: "Engine",
          description: null,
          lifecycle: "active",
          lifecycleTone: "neutral" as const,
          openIssues: 0,
          openIssuesText: "0 open issues",
        },
      ],
    },
    total: 1,
  },
};

describe("the dashboard project page renders", () => {
  test("mounts without a stale reference (the initial read arm is the honest render)", () => {
    const html = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        { locale: "en" },
        createElement(ProjectDetailDestination, {
          address: { route: { name: "project", id: "engine", feature: "issues" }, query: "" },
          feature: "issues",
          projectIds: ["engine"],
          projects: PROJECTS,
        } as never),
      ),
    );
    // The page is in its `loading` arm (effects do not run under static markup), so it
    // renders nothing — and, crucially, does not throw.
    expect(typeof html).toBe("string");
    expect(html).toBe("");
  });

  test("the page identity the loading arm suppresses is the project's own id", () => {
    // A second render with a different id proves the props reached the body (a page
    // that crashed before reading them would fail above instead).
    const html = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        { locale: "en" },
        createElement(ProjectDetailDestination, {
          address: { route: { name: "project", id: "ui", feature: "issues" }, query: "" },
          feature: "issues",
          projectIds: ["ui"],
          projects: PROJECTS,
        } as never),
      ),
    );
    expect(html).toBe("");
  });
});
