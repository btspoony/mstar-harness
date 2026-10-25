/**
 * Token contract for `@mstar-harness/ui`.
 *
 * These assertions are the machine-readable half of `DESIGN.md`: the document
 * is the token SSOT and the CSS beside it is the implementation, so a token
 * that exists in only one of them is a defect (plan global constraint
 * "Design system SSOT is `DESIGN.md`").
 *
 * The checks, in the order they protect each other:
 *  1. the light and dark blocks declare the SAME colour role names;
 *  2. every declared custom property is either consumed by package CSS or
 *     claimed by a later task that will consume it;
 *  3. no bare colour literal outside the token file;
 *  4. the dark scheme is selected by `[data-ms-theme="dark"]`, never by a
 *     `prefers-color-scheme` media query;
 *  5. a `@media (forced-colors: active)` block re-states the status dot, so
 *     the five tones never depend on colour;
 *  6. `DESIGN.md` and `tokens.css` declare the same colour role names and the
 *     same container layout constants.
 *
 * Colocated per repo convention: `src/<module>.test.ts` is the unit mirror of
 * one module (AGENTS.md "Test layout").
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PKG_ROOT = join(import.meta.dir, "..", "..");
const SRC = join(PKG_ROOT, "src");
const STYLES = join(SRC, "styles");
const TOKENS_PATH = join(STYLES, "tokens.css");
const BASE_PATH = join(STYLES, "base.css");
const DESIGN_PATH = join(PKG_ROOT, "..", "..", "DESIGN.md");

/**
 * Tokens this task declares but does not consume: each is claimed by the task
 * that renders it. The claim is the review artefact — a token added here
 * without a consuming task is a token nobody needs (DESIGN.md § Token surface).
 */
const CONSUMED_BY_LATER_TASK: Readonly<Record<string, string>> = {
  "--ms-bg-surface": "Task 3 (panels, tables)",
  "--ms-bg-inset": "Task 3 (chips, progress tracks, code blocks)",
  "--ms-bg-hover": "Task 3 (row hover)",
  "--ms-bg-selected": "Task 3 (selected row, applied filter)",
  "--ms-border-strong": "Task 3 (input and control borders)",
  "--ms-text-secondary": "Task 3 (labels, secondary values)",
  "--ms-text-muted": "Task 3 (timestamps, field labels)",
  "--ms-success": "Task 3 StatusDot",
  "--ms-warning": "Task 3 StatusDot",
  "--ms-danger": "Task 3 StatusDot",
  "--ms-neutral": "Task 3 StatusDot",
  "--ms-purple": "Task 3 StatusDot (terminal lifecycle)",
  "--ms-space-1": "Task 3 (dot gap, inline gap)",
  "--ms-space-2": "Task 3 (inside a control group)",
  "--ms-space-4": "Task 3 (between blocks, columns)",
  "--ms-space-6": "Task 3 (detail column gutter)",
  "--ms-space-8": "Task 3 (section break)",
  "--ms-space-12": "Task 3 (page top rhythm)",
  "--ms-row-h": "Task 3 DataTable",
  "--ms-row-h-sm": "Task 3 (dense side lists)",
  "--ms-header-h": "Task 3 Nav",
  "--ms-radius-sm": "Task 3 (inputs, buttons)",
  "--ms-radius-md": "Task 3 (panels)",
  "--ms-fs-20": "Task 4 (page title)",
  "--ms-lh-20": "Task 4 (page title)",
};

/** Every `*.css` file under `src`, excluding the two global sheets. */
function componentCssFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".css")) out.push(full);
    }
  };
  if (existsSync(SRC)) walk(SRC);
  return out;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** The declarations inside the first `selector { … }` block (non-greedy). */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  const close = css.indexOf("\n}", open);
  return close === -1 ? "" : css.slice(open + 1, close);
}

/** `--name: value` declarations of a block, in source order. */
function declarations(cssBlock: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of cssBlock.split("\n")) {
    const match = /^\s*(--ms-[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line);
    if (match !== null) out.set(match[1], match[2].trim());
  }
  return out;
}

/** A value that renders as a colour rather than a length, font list, number… */
function isColourValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (
    v.startsWith("#") ||
    v.startsWith("rgb") ||
    v.startsWith("hsl") ||
    v.startsWith("oklch") ||
    v.startsWith("color-mix") ||
    v.startsWith("color(") ||
    ["transparent", "currentcolor", "canvas", "canvastext"].includes(v)
  );
}

function names(map: Map<string, string>): string[] {
  return [...map.keys()].sort();
}

describe("tokens.css — light/dark role parity", () => {
  test("the dark block is selected by [data-ms-theme=\"dark\"]", () => {
    const css = read(TOKENS_PATH);
    expect(css).toContain('[data-ms-theme="dark"] {');
    expect(block(css, '[data-ms-theme="dark"]').trim()).not.toBe("");
  });

  test("dark redeclares exactly the colour roles and no non-colour token", () => {
    const css = read(TOKENS_PATH);
    const light = declarations(block(css, ":root"));
    const dark = declarations(block(css, '[data-ms-theme="dark"]'));

    const colourRoles = names(light).filter((name) => isColourValue(light.get(name) ?? ""));
    expect(colourRoles.length).toBeGreaterThan(0);
    expect(names(dark)).toEqual(colourRoles);
  });

  test("every colour role differs between light and dark (a real dark palette)", () => {
    const css = read(TOKENS_PATH);
    const light = declarations(block(css, ":root"));
    const dark = declarations(block(css, '[data-ms-theme="dark"]'));
    const unchanged = names(dark).filter((name) => light.get(name) === dark.get(name));
    expect(unchanged).toEqual([]);
  });

  test("no --ms-* value aliases a host token", () => {
    const css = read(TOKENS_PATH);
    expect(css).not.toMatch(/--ms-[a-z0-9-]+\s*:\s*var\(--dsw-/);
  });
});

describe("tokens.css — declaration is consumed or claimed", () => {
  test("every declared token is consumed by package CSS or claimed by a later task", () => {
    const declared = names(declarations(block(read(TOKENS_PATH), ":root")));
    // The token sheet counts as a consumer: a token composed from another
    // (`--ms-hairline: 1px solid var(--ms-border-hairline)`) consumes it.
    const consumers = [TOKENS_PATH, BASE_PATH, ...componentCssFiles().filter((f) => f !== TOKENS_PATH && f !== BASE_PATH)]
      .filter((f) => existsSync(f))
      .map(read)
      .join("\n");
    const claimed = Object.keys(CONSUMED_BY_LATER_TASK);

    const unconsumed = declared.filter(
      (name) => !consumers.includes(`var(${name})`) && !claimed.includes(name),
    );
    expect(unconsumed).toEqual([]);
  });

  test("no claim is stale: a claimed token is not already consumed by any package CSS", () => {
    // Every sheet counts, not just base.css: a component that starts consuming a
    // claimed token must also drop the claim, or the list quietly becomes an
    // excuse list that no longer describes reality.
    const sheets = [TOKENS_PATH, BASE_PATH, ...componentCssFiles()]
      .filter((file) => existsSync(file))
      .map(read);
    const stale = Object.keys(CONSUMED_BY_LATER_TASK).filter((name) =>
      sheets.some((css) => css.includes(`var(${name})`)),
    );
    expect(stale).toEqual([]);
  });

  test("every claim names a task", () => {
    const unnamed = Object.entries(CONSUMED_BY_LATER_TASK)
      .filter(([, task]) => !/^Task \d/.test(task))
      .map(([name]) => name);
    expect(unnamed).toEqual([]);
  });
});

/**
 * DESIGN.md Rule 1 — tone luminance separation.
 *
 * The five status tones must stay distinguishable in greyscale, so each sits in
 * its own CIE L\* band and no two neighbours may crowd. This is the machine
 * guard the design rule needs: re-tuning one tone by eye now fails here instead
 * of shipping, which is exactly how the prototype's `warning`/`success` pair
 * ended up 0.7 L\* apart (indistinguishable in greyscale).
 *
 * The floor is 2.5, not 3.0, because the FROZEN prototype palette's tightest
 * pair measures 2.76 (`purple` 36.92 / `danger` 39.69) and the L2 review ruled
 * that pair must not move. A floor above the frozen palette would only be
 * satisfiable by overriding the review, so the rule states the floor the palette
 * actually meets and the guard enforces that one. `DESIGN.md` carries the same
 * number; the two must not disagree.
 */
const MIN_TONE_GAP = 2.5;

/** CIE L\* of an sRGB hex colour (D65, the same measure DESIGN.md quotes). */
function lightnessLStar(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return y > 0.008856 ? 116 * y ** (1 / 3) - 16 : 903.3 * y;
}

/** The five tone values of one scheme, as declared in tokens.css. */
function toneValues(selector: string): Record<string, string> {
  const declared = declarations(block(read(TOKENS_PATH), selector));
  const tones: Record<string, string> = {};
  for (const tone of ["danger", "warning", "success", "neutral", "purple"]) {
    const value = declared.get(`--ms-${tone}`);
    expect(value).toBeDefined();
    tones[tone] = value as string;
  }
  return tones;
}

describe("DESIGN.md Rule 1 — tone luminance separation", () => {
  for (const [scheme, selector] of [
    ["light", ":root"],
    ["dark", '[data-ms-theme="dark"]'],
  ] as const) {
    test(`${scheme}: every adjacent tone pair is at least ${MIN_TONE_GAP} L* apart`, () => {
      const tones = toneValues(selector);
      const ranked = Object.entries(tones)
        .map(([tone, hex]) => ({ tone, hex, l: lightnessLStar(hex) }))
        .sort((a, b) => a.l - b.l);

      const gaps = ranked.slice(1).map((entry, i) => ({
        pair: `${ranked[i]?.tone}→${entry.tone}`,
        gap: Number((entry.l - (ranked[i]?.l ?? 0)).toFixed(2)),
      }));
      expect(gaps).toHaveLength(4);

      const crowded = gaps.filter((g) => g.gap < MIN_TONE_GAP);
      expect(crowded).toEqual([]);
    });

    test(`${scheme}: the five tones are all distinct in lightness or hue`, () => {
      const tones = toneValues(selector);
      const hexes = Object.values(tones);
      expect(new Set(hexes).size).toBe(hexes.length);
    });
  }

  test("DESIGN.md quotes the same floor the guard enforces", () => {
    // The document escapes the asterisk for Markdown (`2.5 L\*`), so match either form.
    expect(read(DESIGN_PATH)).toMatch(new RegExp(`${MIN_TONE_GAP} L\\\\?\\*`));
  });
});

describe("colour literals live in exactly one file", () => {
  test("no bare colour literal outside tokens.css", () => {
    const offenders: string[] = [];
    for (const file of componentCssFiles()) {
      if (file === TOKENS_PATH) continue;
      const text = read(file);
      for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) {
        offenders.push(`${relative(PKG_ROOT, file)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the scheme is an attribute, never a media query", () => {
  test("no package CSS selects the dark scheme from prefers-color-scheme", () => {
    const offenders = [TOKENS_PATH, BASE_PATH, ...componentCssFiles()]
      .filter((f) => existsSync(f))
      .filter((f) => read(f).includes("prefers-color-scheme"))
      .map((f) => relative(PKG_ROOT, f));
    expect(offenders).toEqual([]);
  });
});

describe("forced colors: the status dot stops depending on colour", () => {
  test("base.css carries a forced-colors block that re-states the dot", () => {
    const base = read(BASE_PATH);
    expect(base).toContain("@media (forced-colors: active)");
    const start = base.indexOf("@media (forced-colors: active)");
    const forced = base.slice(start);
    expect(forced).toContain("[data-ms-tone]");
    // all five tones get their own shape, so greyscale/forced-colors keeps them apart
    for (const tone of ["danger", "warning", "success", "neutral", "purple"]) {
      expect(forced).toContain(`[data-ms-tone="${tone}"]`);
    }
  });
});

describe("DESIGN.md and tokens.css are one document", () => {
  /** The `colors:` group keys of the DESIGN.md frontmatter. */
  function frontmatterColourKeys(md: string): string[] {
    const fm = /^---\n([\s\S]*?)\n---/.exec(md);
    if (fm === null) return [];
    const colorsAt = fm[1].indexOf("\ncolors:");
    if (colorsAt === -1) return [];
    const rest = fm[1].slice(colorsAt + 1).split("\n");
    const keys: string[] = [];
    let inside = false;
    for (const line of rest) {
      if (/^colors:/.test(line)) {
        inside = true;
        continue;
      }
      if (inside) {
        if (/^\S/.test(line)) break; // next top-level group
        const match = /^ {2}([a-z0-9-]+):/.exec(line);
        if (match !== null) keys.push(match[1]);
      }
    }
    return keys.sort();
  }

  test("every colour role in tokens.css is declared in DESIGN.md and vice versa", () => {
    const css = read(TOKENS_PATH);
    const roles = names(declarations(block(css, ":root")))
      .filter((name) => isColourValue(declarations(block(css, ":root")).get(name) ?? ""))
      .map((name) => name.replace(/^--ms-/, ""));
    expect(roles.length).toBeGreaterThan(0);
    expect(frontmatterColourKeys(read(DESIGN_PATH))).toEqual(roles);
  });

  test("DESIGN.md documents the container layout constants the CSS uses", () => {
    const css = read(TOKENS_PATH);
    const md = read(DESIGN_PATH);
    // Container queries cannot read custom properties, so the floors are
    // documented constants: tokens.css lists them, base.css uses them, and
    // DESIGN.md must carry the same numbers.
    const constants = /\/\* Layout constants[\s\S]*?\*\//.exec(css);
    expect(constants).not.toBeNull();
    for (const px of ["900", "620", "480", "300", "220"]) {
      expect(constants?.[0]).toContain(`${px}px`);
      expect(md).toContain(`${px}px`);
    }
  });
});
