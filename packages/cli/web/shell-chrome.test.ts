/**
 * The shell's chrome: its navigation entries, its skip link, its footer.
 *
 * These live outside any component because the defects they close are not render
 * bugs — they are "the wrong string" and "the wrong thing on click", and both are
 * cheaper to pin as behaviour than to re-derive by eye.
 */
import { describe, expect, test } from "bun:test";

import { copyFor } from "@mstar-harness/ui";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NAV_DESTINATIONS, scopedIssuesTarget, skipToMain, shellChrome } from "./shell-chrome";

const mainSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "main.tsx"), "utf8");

/** A main landmark stand-in: only `focus()` matters to the skip link. */
function fakeMain() {
  let focused = false;
  return {
    focus: (): void => {
      focused = true;
    },
    get focused(): boolean {
      return focused;
    },
  };
}

describe("the skip link moves focus, it does not navigate", () => {
  test("clicking it focuses the main landmark and cancels the hash navigation", () => {
    // The hash *is* the routing channel: letting `#main` through makes the router
    // resolve Overview and scroll to top, so the affordance would throw the reader
    // back to the landing page and lose their filters while focus never moved.
    let prevented = false;
    const main = fakeMain();
    skipToMain({ preventDefault: () => (prevented = true) }, () => main);
    expect(prevented).toBe(true);
    expect(main.focused).toBe(true);
  });

  test("with no landmark mounted it cancels the navigation and does nothing else", () => {
    // Still cancel: a plain `#main` hash would be worse than a no-op.
    let prevented = false;
    skipToMain({ preventDefault: () => (prevented = true) }, () => null);
    expect(prevented).toBe(true);
  });
});

describe("the navigation entries are the product's, in the product's language", () => {
  test("Overview is an entry: the landing destination is reachable from the nav", () => {
    // It is the page an unknown route resolves to, and the only destination a reader
    // starts on — leaving it out meant the way back was the Back button.
    expect(NAV_DESTINATIONS[0]).toBe("overview");
    expect(NAV_DESTINATIONS).toContain("issues");
    expect(NAV_DESTINATIONS).toContain("projects");
  });

  test("every entry is labelled from the dictionary, in both languages", () => {
    for (const locale of ["en", "zh"] as const) {
      const chrome = shellChrome(copyFor(locale));
      expect(chrome.navItems.map((item) => item.id)).toEqual([...NAV_DESTINATIONS]);
      for (const item of chrome.navItems) expect(item.label).not.toBe("");
    }
    // Not derived from the id: `issues` capitalised is `Issues`, which is not Chinese.
    const zh = shellChrome(copyFor("zh"));
    expect(zh.navItems.map((item) => item.label)).not.toEqual(
      NAV_DESTINATIONS.map((id) => id[0]!.toUpperCase() + id.slice(1)),
    );
  });

  test("no English shell string survives a Chinese render", () => {
    // The whole point: a zh reader previously got English navigation, skip link and
    // footer, because those three were literals or id-derived while every screen
    // around them was translated.
    const en = shellChrome(copyFor("en"));
    const zh = shellChrome(copyFor("zh"));
    const englishStrings = [
      en.skipLink,
      en.footer,
      ...en.navItems.map((item) => item.label),
    ].filter((value) => value.trim() !== "");
    const zhStrings = [zh.skipLink, zh.footer, ...zh.navItems.map((item) => item.label)];

    for (let index = 0; index < englishStrings.length; index += 1) {
      expect(zhStrings[index]).not.toBe(englishStrings[index]);
      // A Chinese string must carry no Latin letters beyond the product name.
      expect(/^[A-Za-z\s·|]+$/.test(zhStrings[index]!)).toBe(false);
    }
  });
});

describe("a project's Issues feature keeps its own state", () => {
  test("a filter change reaches the request, scoped to the project", () => {
    // It used to receive a frozen query and an empty callback: the segmented selects
    // snapped back, the search box could not be typed into, and Clear-all did
    // nothing — the project could only ever show page one of open issues.
    const next = {
      filters: { disposition: "resolved" as const, project: "", kind: "", severity: "high", q: "tone" },
      offset: 0,
    };
    const target = scopedIssuesTarget("engine", next);
    expect(target.route).toEqual({ name: "project", id: "engine", feature: "issues" });
    expect(target.query).toContain("disposition=resolved");
    expect(target.query).toContain("severity=high");
    expect(target.query).toContain("q=tone");
    // The page owns the scope, so the address bar must not carry it twice.
    expect(target.query).not.toContain("project=");
  });

  test("a page change reaches the request too", () => {
    const next = { filters: { disposition: "open" as const, project: "", kind: "", severity: "", q: "" }, offset: 50 };
    expect(scopedIssuesTarget("engine", next).query).toContain("offset=50");
  });
});

describe("the shell's markup uses those pieces", () => {
  test("the skip link has a click handler and the landmark is focusable", () => {
    // The behaviour test above passes even if nothing calls `skipToMain`; this is the
    // half that fails when the markup goes back to a plain `href="#main"`.
    expect(/className="skip-link"[\s\S]{0,200}onClick=/.test(mainSource)).toBe(true);
    expect(/<main[\s\S]{0,200}tabIndex=\{-1\}/.test(mainSource)).toBe(true);
    expect(mainSource).toContain("mainRef");
  });

  test("the shell's strings come from the dictionary, not from literals or ids", () => {
    expect(mainSource).toContain("shellChrome(copy)");
    expect(mainSource).toContain("{chrome.skipLink}");
    expect(mainSource).toContain("{chrome.footer}");
    // The id-derived label this round removed.
    expect(/id\[0\]!\.toUpperCase\(\)/.test(mainSource)).toBe(false);
    expect(mainSource).not.toContain("Skip to content");
    expect(mainSource).not.toContain("Read-only · Make changes with the CLI");
  });

  test("opening a detail keeps the reader's filters, and the scheme follows the theme", () => {
    // qc2: the list opened a detail with an empty query, so Back returned to an
    // unfiltered list. And `color-scheme` was pinned to light in the shell, so native
    // controls and the first frame stayed light inside a dark page.
    expect(mainSource.match(/navigate\(\{ name: "(issue|workflow|iteration)", id \}, "", "push"\)/g)).toBeNull();
    expect(mainSource).toContain("document.documentElement.style.colorScheme = theme");
    expect(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "shell.html"), "utf8")).toContain(
      "content=\"light dark\"",
    );
  });

  test("a project's Issues feature is not wired to an inert callback", () => {
    // The shape qc1 and qc3 both found: `onQueryChange={() => {}}` with a frozen
    // query, which makes every control in the feature do nothing.
    expect(mainSource).not.toMatch(/onQueryChange=\{\(\) => \{\}/);
    expect(mainSource).toContain("scopedIssuesTarget(projectId, next)");
  });
});
