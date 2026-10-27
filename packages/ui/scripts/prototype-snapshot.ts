/**
 * Derive a committed snapshot of the prototype's authoritative scalars.
 *
 * The prototype lives under `.mstar/`, which this repository gitignores, so **CI cannot read
 * it**. That is why every check that compares against it (`check:declarations`,
 * `check:selectors`, `check:tones`) warns and exits 0 in CI: it has nothing to compare with.
 *
 * The consequence showed up as a real defect: `tokens.test.ts` pinned `padding: 14px 20px
 * 24px` while the prototype says `14px 20px 16px`, so the test guarded the wrong number and
 * the dsh pane drifted from the dashboard. **A literal in a test is a decision someone made,
 * not a fact about the prototype** — unless something re-derives it.
 *
 * This script is that something. It writes `src/styles/prototype.snapshot.json`, which IS
 * committed, so CI compares against the prototype's values without needing the prototype.
 *
 *   bun run scripts/prototype-snapshot.ts           # rewrite the snapshot
 *   bun run scripts/prototype-snapshot.ts --check   # fail if it has drifted
 *
 * Run `--check` before pushing whenever the prototype changes; a stale snapshot is worse than
 * none, because it looks authoritative.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROTOTYPE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".mstar",
  "iterations",
  "iter-20261025-frontend-unification",
  "prototypes",
  "design-v1.html",
);
const SNAPSHOT = join(import.meta.dir, "..", "src", "styles", "prototype.snapshot.json");

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
  const message = "prototype-snapshot: prototype not found (it lives under the gitignored `.mstar/`)";
  if (process.env.STRICT_SNAPSHOT === "1") {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

const derived = extract(source);
const rendered = `${JSON.stringify(derived, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let committed: string;
  try {
    committed = readFileSync(SNAPSHOT, "utf8");
  } catch {
    console.error("prototype-snapshot: no committed snapshot — run `bun run scripts/prototype-snapshot.ts`");
    process.exit(1);
  }
  if (committed !== rendered) {
    console.error("prototype-snapshot: the committed snapshot disagrees with the prototype:\n");
    console.error("  committed:", committed.replace(/\s+/g, " ").slice(0, 200));
    console.error("  prototype:", rendered.replace(/\s+/g, " ").slice(0, 200));
    console.error("\nrun `bun run scripts/prototype-snapshot.ts` and commit the result");
    process.exit(1);
  }
  console.log(`prototype snapshot is current — ${derived.containerBreakpoints.length} breakpoints, screen padding ${derived.screenPadding}`);
  process.exit(0);
}

writeFileSync(SNAPSHOT, rendered);
console.log(`wrote ${SNAPSHOT}`);
console.log(rendered);
