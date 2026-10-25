/**
 * The host's own accessibility affordances, and the two prototype gaps this task
 * exists to close.
 *
 * The primitives belong to the shared layer — a focusable `TruncatedText` and a
 * `StatusDot` that carries a literal label — so what is asserted here is that the
 * *host* puts them in play and does not reintroduce a mouse-only or colour-only
 * channel of its own.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowDTO, WorkflowListDTO } from "@mstar-harness/engine";
import { Workflows, copyFor, workflowListModel, type WorkflowsCopy } from "@mstar-harness/ui";

const webDir = path.dirname(fileURLToPath(import.meta.url));

const mainSource = readFileSync(path.join(webDir, "main.tsx"), "utf8");

/** The shell stylesheet: the host's only own styling. */
const shellCss = readFileSync(path.join(webDir, "shell.css"), "utf8");

describe("the page's landmark layer", () => {
  test("the skip link targets the main region, and that region exists", () => {
    expect(mainSource).toContain('href="#main"');
    expect(mainSource).toContain('id="main"');
  });

  test("the page declares exactly one main landmark", () => {
    // Two `main` regions make the skip link's destination ambiguous, and a screen
    // reader's landmark list shows the page twice.
    expect(mainSource.match(/<main\b/g)?.length).toBe(1);
    expect(mainSource.match(/<header\b/g)?.length).toBe(1);
    expect(mainSource.match(/<footer\b/g)?.length).toBe(1);
  });

  test("the navigation landmark is labelled from the dictionary, not a literal", () => {
    // Task 5 moved this into `shell.nav.primary`; a literal here would survive every
    // screening of the Chinese dictionary because nothing paints it.
    expect(mainSource).toContain("copy.shell.nav.primary");
    expect(/label="Primary"/.test(mainSource)).toBe(false);
  });
});

describe("truncation is reachable without a mouse", () => {
  test("the host markup exposes no full text through `title` alone", () => {
    // `title` is a hover convenience. A host that put the full value there and
    // nowhere else would be mouse-only, which is the gap this round closes.
    expect(mainSource.includes("title=")).toBe(false);
  });

  test("a long cell in the ported tables carries the focusable affordance", () => {
    const long = "A workflow title long enough that the table has to truncate it somewhere in the middle";
    const items = [
      {
        id: "wf-1",
        type: "plan",
        status: "running",
        phase: null,
        startedAt: null,
        endedAt: null,
        updatedAt: "2026-10-25T05:00:00.000Z",
        branch: { base: "main", source: "w", integration: "w", target: "main" },
        catalog: { title: long },
        plans: [],
        badges: [],
      } as unknown as WorkflowDTO,
    ];
    const projection = {
      generation: 1,
      freshness: "current" as const,
      builtAt: null,
      checkedAt: "",
      diagnostics: [],
    };
    const copy: WorkflowsCopy = {
      ...copyFor("en").workflows,
      empty: { ...copyFor("en").state.empty, heading: "Workflows" },
      unavailable: { ...copyFor("en").state.unavailable, heading: "Workflows" },
      absent: { ...copyFor("en").state.absent, heading: "Workflows" },
    };
    const model = workflowListModel({
      data: { items, total: 1 } as WorkflowListDTO,
      projection,
    });
    const html = renderToStaticMarkup(createElement(Workflows, { model, copy }));

    // The same string is content, `data-ms-full` and `title`; the first two are what
    // a keyboard user reaches, so both must be present.
    expect(html).toContain(escapeAttr(long));
    expect(html).toContain("data-ms-full");
    expect(html).toContain('tabindex="0"');
  });
});

describe("status survives colour removal", () => {
  test("the shell stylesheet introduces no colour of its own", () => {
    // Every product colour comes from a token, and a tone is never the only channel:
    // the shared layer separates tones by luminance and forces colours in
    // `forced-colors` mode. The host's own chrome must not add a colour rule that
    // carries meaning — `currentColor` for a border is the one allowed use.
    // A token reference is not a colour of the host's own: it is the shared sheet's
    // value, so the shell may paint with it (the page canvas, the text colour) without
    // introducing a second palette.
    const allowed = ["currentColor", "inherit", "transparent", "unset", "var(--ms-"];
    const colourDeclarations = shellCss
      .split("\n")
      .filter((line) => /(^|[^-\w])(color|background|background-color)\s*:/.test(line))
      .filter((line) => !allowed.some((value) => line.includes(value)));
    expect(colourDeclarations).toEqual([]);
  });

  test("the shell's only stateful marks are text and shape, not hue", () => {
    // The two controls are native `<select>`s with a visible label, so their value is
    // always text; nothing in the shell encodes a state as a colour swatch.
    expect(mainSource).toContain("<select");
    expect(mainSource).toContain("app-switch-label");
    // The shared sheet owns the `forced-colors` block; this one must not add a second.
    expect(/#?@media[^{]*forced-colors/.test(shellCss)).toBe(false);
  });
});

/** `renderToStaticMarkup` escapes quotes in an attribute; match what it emits. */
function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}
