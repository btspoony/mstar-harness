/**
 * Compares the declarations of every selector the prototype and this product share.
 *
 * `check:selectors` compares names and cannot see a selector that exists on both sides with
 * different values — which is how `.chart-svg { height: 88px }` survived: the prototype lets
 * its `viewBox` ratio decide the height, this product pinned a pixel and then invented
 * `.chart-svg.is-full` to compensate.
 *
 * `KEPT_DIFFERENT` is the entire judgement: each entry is a declaration that is deliberately
 * not the prototype's, with the reason. Anything else fails.
 *
 * Needs the prototype file (gitignored). `STRICT_DECLARATIONS=1` makes a missing prototype
 * fail.
 *
 * Run: `bun run --cwd packages/ui check:declarations`
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROTOTYPE = join(
  import.meta.dir, "..", "..", "..",
  ".mstar", "iterations", "iter-20261025-frontend-unification", "prototypes", "design-v1.html",
);

/** Declarations that are deliberately not the prototype's, keyed as `selector|property`. */
const KEPT_DIFFERENT: Readonly<Record<string, string>> = {
  // e.g. ".ctl|border": "written as select.ctl here; see check:selectors",
};

/** selector → declaration map, with the `.ms-container` scope stripped. */
function rules(source: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of clean.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const head = rule[1].trim();
    if (head === "from" || head === "to" || head.includes("%")) continue;
    const body = new Map<string, string>();
    for (const declaration of rule[2].split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      body.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim().replace(/\s+/g, " "));
    }
    for (const part of head.split(",")) {
      let selector = part.trim();
      while (selector.startsWith(".ms-container")) selector = selector.slice(".ms-container".length).trim();
      if (selector === "") continue;
      const existing = out.get(selector) ?? new Map<string, string>();
      for (const [property, value] of body) existing.set(property, value);
      out.set(selector, existing);
    }
  }
  return out;
}

let html: string;
try {
  html = readFileSync(PROTOTYPE, "utf8");
} catch {
  const message = "declaration-diff: prototype not found (see src/styles/product.css)";
  if (process.env.STRICT_DECLARATIONS === "1") {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

const stylesDir = join(import.meta.dir, "..", "src", "styles");
const prototype = rules([...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n"));
const ours = rules(
  [readFileSync(join(stylesDir, "product.css"), "utf8"), readFileSync(join(stylesDir, "base.css"), "utf8")].join("\n"),
);

const rows: string[] = [];
for (const [selector, declarations] of prototype) {
  const mine = ours.get(selector);
  if (mine === undefined) continue;
  for (const [property, value] of declarations) {
    const got = mine.get(property);
    if (got === undefined) continue;
    if (got.replace(/\s+/g, "") === value.replace(/\s+/g, "")) continue;
    if (`${selector}|${property}` in KEPT_DIFFERENT) continue;
    rows.push(`${selector} { ${property}: ${value} }   ours: ${got}`);
  }
}

if (rows.length > 0) {
  console.error(rows.map((row) => `  ${row}`).join("\n"));
  console.error(`\n${rows.length} shared declaration(s) differ from the prototype.`);
  process.exit(1);
}
console.log("every shared declaration matches the prototype");
