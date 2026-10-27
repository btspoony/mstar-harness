/**
 * The testable half of the dashboard asset generator.
 *
 * `build-web.ts` is a script — it reads files, writes the generated module and
 * exits the process. Everything that decides *whether* a build is acceptable lives
 * here instead, so the build test can assert each rule directly rather than
 * re-implementing it (a test that rewrites the producer's logic proves only that
 * two copies agree).
 */

/**
 * The reviewed size policy, in bytes. A ceiling is a decision, not a measurement:
 * it is exported so raising the budget is one visible line rather than a number
 * nobody can find. Both artifacts sit well inside today.
 */
// The narrow-band work (declared column widths, the table floor and its scroller,
// the shared pane band) cost ~350 B: the table markup grew one wrapper, each list
// screen carries its widths, and the header carries the band class. Raised once,
// visibly, from 300 KB to 308 KB — the artifact is still an order of magnitude
// inside what a dashboard of this size needs, and a ceiling that cannot absorb a
// design fix stops being a budget and starts being a wall.
//
// Raised again, 308 KB to 320 KB, for the Overview's plan table: the prototype's
// five columns per plan are new markup (a table, its five cell renderers, the
// branch chain and the workflow header line) plus their two locales. The growth is
// content the owner asked for, not a dependency; the headroom stays ~10 KB so the
// next design fix does not need this line edited again.
// Raised, 320 KB to 328 KB (~6 KB headroom over the current 322 KB): the project detail
// gained the prototype's two identity panels, its Stored facts panel (five rows and
// their labels in two locales), and the disclosure/direction consolidation. The first
// draft of that change rendered the direction twice and so asked for 340 KB; the
// duplicate is gone, and the budget is back to the growth that is actually there.
// Raised, 328 KB to 332 KB: the flow chart states its scale beside the drawing (three
// labels and the frame around them). That is 34 bytes of markup over the old ceiling — the
// smallest raise this file has needed, and still worth a fresh ~4 KB of headroom rather
// than a line that has to be edited again next round.
// Raised, 332 KB to 340 KB: the issue detail gained its `Source` and `Identity keys`
// panels — two of the six §8.1 removed and the prototype keeps. The remaining four are
// larger still (two tables and an event log), so this raise is sized for them rather than
// for what is here now.
// 344 KB: the footer gained the open-issue count the prototype leads with, which needs the
// shell to reach the overview's residual total.
// 344 KB. Raised from 340 by the footer's open-issue count, which needs the shell to reach
// the overview's residual total. Measured: the previous bundle was 348231B against 348160B —
// **71 bytes over**, so this is not slack for new growth. The next thing to shrink is the
// locale table, which ships both dictionaries in full.
export const JS_CEILING = 344 * 1024;
// Raised, 60 KB to 100 KB: the product's component styles are now generated from the
// approved prototype and shipped whole (values unchanged, selectors scoped, queries
// unnamed) instead of being re-typed one screen at a time. Re-typing is exactly what
// produced three rounds of "close but not the same"; the sheet is the fix, and the
// budget follows the decision rather than blocking it.
export const CSS_CEILING = 100 * 1024;

/**
 * The define that selects React's production build. Exported so the test pins the
 * exact value the generator passes, not a paraphrase of it.
 */
export const PRODUCTION_DEFINE = { "process.env.NODE_ENV": '"production"' } as const;

/**
 * The offline guard: no remote or CDN reference in anything a browser fetches.
 *
 * The bundled JS is deliberately not scanned — a minified runtime carries
 * documentation URLs as string constants (React's error texts do), which are not
 * runtime fetches. The HTML and the CSS are what a page actually resolves.
 */
export function remoteReference(value: string): string | null {
  const match = /https?:\/\/|cdn\.|fonts\.googleapis/i.exec(value);
  return match === null ? null : match[0];
}

/** The single CSS asset of a build's output, or `null` when the build carries none. */
export function pickCssAsset(outputs: readonly { path: string }[]): { path: string } | null {
  const candidates = outputs.filter((output) => output.path.endsWith(".css"));
  if (candidates.length > 1) {
    throw new Error(`build-web: expected one CSS output, found ${candidates.length}`);
  }
  return candidates[0] ?? null;
}

/**
 * JSON.stringify is a correct, deterministic string escaper for TS string literals
 * (quotes, backslashes, control chars, line terminators all escaped). The CLI
 * bundle misdecodes raw multi-byte UTF-8 in string literals (spec §7.4), so every
 * non-ASCII code unit additionally becomes a \uXXXX escape — the generated module
 * stays pure ASCII while the runtime string values (and the round-trip check) are
 * unchanged.
 */
export function toAsciiJsonLiteral(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (unit) =>
    `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Whether a bundle carries React's development build.
 *
 * Three markers survive minification in the dev build and are absent from the
 * production one; they are checked by name because a size comparison would pass
 * for a development build that happened to be small.
 */
export function carriesDevelopmentReact(js: string): boolean {
  return js.includes("validateDOMNesting") || js.includes("ReactDebugCurrentFrame") || js.includes('"Warning: ');
}

/** The generated module's source for one build. Pure: same inputs, same string. */
export function renderModule(html: string, js: string, css: string): string {
  return `// Generated by packages/cli/scripts/build-web.ts — do not edit.
// Regenerate with \`bun run packages/cli/scripts/build-web.ts\` (runs before every CLI build/prepublish).
export const dashboardHtml = ${toAsciiJsonLiteral(html)};

export const dashboardJs = ${toAsciiJsonLiteral(js)};

export const dashboardCss = ${toAsciiJsonLiteral(css)};
`;
}
