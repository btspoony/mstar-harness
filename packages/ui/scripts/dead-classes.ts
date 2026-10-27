/**
 * Fails when a component names a class the stylesheets never define.
 *
 * The check exists because the issue detail carried `className="fact-block"` for several
 * rounds: a class I invented while writing the components, defined nowhere, and harmless
 * enough that every DOM assertion passed. What it renders as is nothing — the block lost its
 * separator and no test noticed.
 *
 * Run: `bun run --cwd packages/ui check:classes`
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const dir = join(import.meta.dir, "..", "src");
const sheets = ["tokens.css", "base.css", "product.css"]
  .map((f) => readFileSync(join(dir, "styles", f), "utf8")).join("\n");
const files: string[] = [];
const walk = (d: string) => {
  for (const entry of readdirSync(d, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(d, entry.name));
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) files.push(join(d, entry.name));
  }
};
walk(dir);
const dead = new Map<string, string>();
for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/className=\{?"([^"{}]+)"/g)) {
    for (const cls of m[1].split(/\s+/).filter(Boolean)) {
      // A word boundary, not a substring. `.res-grid` is present in `.res-gridZZ` as a
      // prefix, so `includes` said a class was defined when the only rule carrying that
      // spelling was a different one — the same blind spot that let a renamed class pass.
      if (!new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(sheets)) {
        dead.set(cls, file.replace(dir + "/", ""));
      }
    }
  }
}
// The other direction, and the one that hid `.goal-list` for months: a rule whose class no
// component ever names. This script's name promised it and only the first direction was
// implemented — "dead classes" read as "classes with no stylesheet", which is the opposite
// failure. Both are dead in their own way; a rule nothing selects is dead CSS.
const defined = new Set<string>();
for (const match of sheets.matchAll(/\.([A-Za-z][\w-]*)/g)) defined.add(match[1]);
const namedInComponents = new Set<string>();
for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const match of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
    for (const group of match.slice(1)) {
      if (group === undefined) continue;
      for (const token of group.split(/[\s$`{}()+?:|&]+/)) if (token !== "") namedInComponents.add(token);
    }
  }
}
// Classes a test asserts on, or a host passes through a constant, are not dead. The check
// stays advisory for them: it prints what it cannot see named rather than failing.
const UNUSED_OK = new Set(["row", "ms-pane-body", "ms-pane-head", "ms-container", "app-icon-sun", "app-icon-moon"]);
const unused = [...defined].filter((cls) => !namedInComponents.has(cls) && !UNUSED_OK.has(cls)).sort();
const rows = [...dead].sort();
if (rows.length > 0) {
  console.error(rows.map(([c, f]) => `.${c}  (${f})`).join("\n"));
  console.error(`\n${rows.length} class name(s) appear in no stylesheet.`);
  process.exit(1);
}
if (process.env.SHOW_UNUSED === "1") console.log(`${unused.length} defined but unnamed: ${unused.slice(0, 20).join(" ")}`);
console.log("no class is missing from the sheets");
