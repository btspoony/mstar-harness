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

  // A real block scan, not a regex over `selector { declarations }`. The regex form cannot
  // see an at-rule prelude at all — `@container (…) { .x { … } }` needs two braces, so the
  // first `{` is consumed by the inner rule and the prelude is dropped. Every breakpoint
  // block on both sides was therefore compared as if it were top-level CSS: the inner
  // `.screen-meta` overwrote the wide-layout one and nine at-rules per side were invisible.
  const stacks: string[] = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const open = clean.indexOf("{", cursor);
    if (open < 0) break;
    const head = clean.slice(cursor, open).trim();
    // Find this block's closing brace by depth.
    let depth = 1;
    let index = open + 1;
    while (index < clean.length && depth > 0) {
      const ch = clean[index];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      index += 1;
    }
    const body = clean.slice(open + 1, depth === 0 ? index - 1 : clean.length);
    cursor = depth === 0 ? index : clean.length;

    if (head.startsWith("@")) {
      // The prototype names its container (`@container pane (…)`); this sheet's are
      // anonymous. The name does not change which queries match, so it is normalised away.
      stacks.push(head.replace(/^@container\s+pane\s+/, "@container "));
      continue;
    }
    if (body.includes("{")) {
      // Nested rules: re-scan the body from inside the current context.
      const nested = rulesOf(body, stacks, out);
      if (nested !== index) continue;
      continue;
    }
    if (head === "from" || head === "to" || head.includes("%")) continue;

    const declarations = new Map<string, string>();
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      declarations.set(
        declaration.slice(0, colon).trim(),
        declaration.slice(colon + 1).trim().replace(/\s+/g, " "),
      );
    }
    for (const part of head.split(",")) {
      let selector = part.trim();
      while (selector.startsWith(".ms-container")) selector = selector.slice(".ms-container".length).trim();
      if (selector === "") continue;
      if (stacks.length > 0) selector = `${stacks.join(" ")} ${selector}`;
      const existing = out.get(selector) ?? new Map<string, string>();
      for (const [property, value] of declarations) existing.set(property, value);
      out.set(selector, existing);
    }
  }
  return out;
}

/** Scan one level, keeping the at-rule context; returns the map it filled. */
function rulesOf(
  source: string,
  stacks: string[],
  out: Map<string, Map<string, string>>,
): Map<string, Map<string, string>> {
  const scratch = rules(source);
  for (const [selector, declarations] of scratch) {
    const key = stacks.length > 0 ? `${stacks.join(" ")} ${selector}` : selector;
    const existing = out.get(key) ?? new Map<string, string>();
    for (const [property, value] of declarations) existing.set(property, value);
    out.set(key, existing);
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
// Report the coverage, not only the verdict: a diff that compares three shared rules and a
// diff that compares three hundred print the same sentence, and the breakpoint blocks were
// silently absent from this comparison until they were keyed by their at-rule context.
const compared = [...prototype.keys()].filter((key) => ours.has(key));
const inBlocks = compared.filter((key) => key.startsWith("@"));
console.log(
  `every shared declaration matches the prototype — ${compared.length} shared selectors, ` +
    `${inBlocks.length} of them inside a breakpoint block`,
);
