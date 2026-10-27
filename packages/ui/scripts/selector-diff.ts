/**
 * Lists prototype selectors this implementation does not define.
 *
 * `check:classes` walks the other direction (a component names a class no sheet defines) and
 * misses a class that a *compound selector nobody renders* happens to mention — which is how
 * `.seg` and `.icon-btn` stayed undefined while both were in use.
 *
 * `NOT_APPLICABLE` is the whole judgement of this check: each prefix or name below is a
 * prototype surface the product must not have, and the reason is written beside it. Anything
 * not listed is a difference worth looking at, so the script exits 1 on it.
 *
 * Needs the prototype file (gitignored). `STRICT_SELECTORS=1` makes a missing prototype fail.
 *
 * Run: `bun run --cwd packages/ui check:selectors`
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROTOTYPE = join(
  import.meta.dir, "..", "..", "..",
  ".mstar", "iterations", "iter-20261025-frontend-unification", "prototypes", "design-v1.html",
);

/** Prototype-only selectors that are correct to omit, with the reason. */
const NOT_APPLICABLE: ReadonlyArray<{ match: (selector: string) => boolean; why: string }> = [
  { match: (s) => s.startsWith(".proto-"), why: "the design document's own screen switcher" },
  { match: (s) => s.startsWith(".pane-stage") || s.startsWith(".pane-shell") || s === ".pane-ctl", why: "the design document's preview frame and its width picker" },
  { match: (s) => s.startsWith(".pane-tab") || s === ".pane-tabs" || s === ".pane-tabs-spacer" || s === ".pane-wrap", why: "the design document's preview tabs" },
  { match: (s) => s === "*" || s === "*::before" || s === "*::after", why: "global reset, in base.css without the .ms-container scope" },
  { match: (s) => s === ":root" || s === "html" || s === "body", why: "document-level reset, outside the scoped sheet" },
  { match: (s) => s.startsWith("[data-theme="), why: "the prototype's theme attribute; this product uses data-ms-theme" },
  { match: (s) => s === ".ctl", why: "written as `select.ctl` here: every `.ctl` in this product is a select, and a bare class would also box any future button or input that reuses the name" },
  { match: (s) => s === ".dsh-top" || s === ".dsh-top-right" || s === ".dash-main" || s === ".host-chrome-note" || s.startsWith(".host-crumb"), why: "the host shell, spelled by each host package" },
];

function selectors(source: string): Set<string> {
  const out = new Set<string>();
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of clean.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const head = rule[1].trim();
    if (head === "from" || head === "to" || head.includes("%")) continue;
    for (const part of head.split(",")) {
      const selector = part.trim().replace(/\.ms-container ?/g, "");
      if (selector === "" || selector.startsWith("@")) continue;
      out.add(selector);
    }
  }
  return out;
}

let html: string;
try {
  html = readFileSync(PROTOTYPE, "utf8");
} catch {
  const message = "selector-diff: prototype not found (see src/styles/product.css)";
  if (process.env.STRICT_SELECTORS === "1") {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

const prototypeCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
const stylesDir = join(import.meta.dir, "..", "src", "styles");
const ours = new Set([
  ...selectors(readFileSync(join(stylesDir, "product.css"), "utf8")),
  ...selectors(readFileSync(join(stylesDir, "base.css"), "utf8")),
]);
const prototypeKeys = new Set(selectors(prototypeCss));
const unexplained = [...prototypeKeys]
  .filter((selector) => !ours.has(selector))
  .filter((selector) => !NOT_APPLICABLE.some((rule) => rule.match(selector)))
  .sort();

if (unexplained.length > 0) {
  console.error(unexplained.map((s) => `  ${s}`).join("\n"));
  console.error(`\n${unexplained.length} prototype selector(s) are neither defined nor explained.`);
  process.exit(1);
}
// The other direction, reported and not failed. This sheet legitimately carries surfaces the
// prototype has no rule for — the absence arms, the chart frame, the dsh pane body — so a
// surplus is not by itself a defect. Stating the count keeps the asymmetry visible: this check
// guards "the prototype has something we lack", and nothing guards the reverse.
const surplus = [...ours].filter((selector) => !prototypeKeys.has(selector)).length;
console.log(
  `every prototype-only selector is one this product should not have — ` +
    `${unexplained.length === 0 ? "0" : String(unexplained.length)} unexplained, ` +
    `${surplus} selector(s) this sheet carries that the prototype does not`,
);
