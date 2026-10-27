/**
 * Derive a committed snapshot of the prototype's authoritative scalars.
 *
 * `snapshot.json` is what lets CI compare against the prototype's values: `check:snapshot`
 * re-derives them from the tracked prototype and fails when the fixture has drifted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The prototype is a TRACKED file, beside this script.
 *
 * Being tracked is what makes the prototype an actual test baseline rather than a local
 * convenience: every comparator (`check:snapshot`, `check:declarations`, `check:selectors`,
 * `check:tones`) reads it, and fails when it cannot. The copy is redacted: real iteration ids
 * are replaced with `iter-N` and harness paths with `{HARNESS_DIR}`, per this repository's rule
 * against tracked files naming them.
 *
 * **When the design changes, change this file first**, then run `snapshot:write`, then bring
 * `DESIGN.md` in line. See `packages/ui/design-system/README.md`.
 */
const PROTOTYPE = join(import.meta.dir, "prototype.html");
const SNAPSHOT = join(import.meta.dir, "snapshot.json");

/** The values a screen's frame is built from, and the widths it reflows at. */
type Snapshot = {
  /** `.dash-main`'s padding — the gutter every screen sits inside. */
  screenPadding: string;
  /** `.dash-main`'s max width. */
  screenMaxWidth: string;
  /** `.app-header`'s padding — the only viewport-driven chrome. */
  headerPadding: string;
  /** `.dash-main`'s padding below 860, where the chrome stacks. */
  narrowScreenPadding: string;
  /** Every `@container` breakpoint the prototype reflows at, sorted. */
  containerBreakpoints: readonly string[];
};

function extract(source: string): Snapshot {
  const css = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");

  const rule = (selector: string): string => {
    const found = clean.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    return found === null ? "" : found[1];
  };
  const declaration = (body: string, property: string): string =>
    (body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1] ?? "").trim();

  const main = rule(".dash-main");
  const header = rule(".app-header");
  // The narrow block is the second `.dash-main` rule, inside the 860 media query.
  const narrow = [...clean.matchAll(/@media \(max-width: 860px\) \{([\s\S]*?)\n\}/g)]
    .map((m) => m[1])
    .join("\n");
  const narrowMain = narrow.match(/\.dash-main\s*\{([^}]*)\}/)?.[1] ?? "";

  const breakpoints = [...new Set([...clean.matchAll(/@container\s+pane\s+\(([^)]+)\)/g)].map((m) => m[1].trim()))].sort();

  const snapshot: Snapshot = {
    screenPadding: declaration(main, "padding"),
    screenMaxWidth: declaration(main, "max-width"),
    headerPadding: declaration(header, "padding"),
    narrowScreenPadding: declaration(narrowMain, "padding"),
    containerBreakpoints: breakpoints,
  };
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === "" || (Array.isArray(value) && value.length === 0)) {
      throw new Error(`prototype-snapshot: could not derive \`${key}\` — the prototype's markup moved`);
    }
  }
  return snapshot;
}

let source: string;
try {
  source = readFileSync(PROTOTYPE, "utf8");
} catch {
  console.error(`prototype-snapshot: ${PROTOTYPE} is unreadable — the tracked prototype is the baseline`);
  process.exit(1);
}

const derived = extract(source);
const rendered = `${JSON.stringify(derived, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let committed: string;
  try {
    committed = readFileSync(SNAPSHOT, "utf8");
  } catch {
    console.error("prototype-snapshot: no committed snapshot — run `bun run --cwd packages/ui snapshot:write`");
    process.exit(1);
  }
  if (committed !== rendered) {
    console.error("prototype-snapshot: the committed snapshot disagrees with the prototype:\n");
    console.error("  committed:", committed.replace(/\s+/g, " ").slice(0, 200));
    console.error("  prototype:", rendered.replace(/\s+/g, " ").slice(0, 200));
    console.error("\nrun `bun run --cwd packages/ui snapshot:write` and commit the result");
    process.exit(1);
  }
  console.log(`prototype snapshot is current — ${derived.containerBreakpoints.length} breakpoints, screen padding ${derived.screenPadding}`);
  process.exit(0);
}

writeFileSync(SNAPSHOT, rendered);
console.log(`wrote ${SNAPSHOT}`);
console.log(rendered);
