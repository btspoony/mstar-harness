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
const rows = [...dead].sort();
if (rows.length > 0) {
  console.error(rows.map(([c, f]) => `.${c}  (${f})`).join("\n"));
  console.error(`\n${rows.length} class name(s) appear in no stylesheet.`);
  process.exit(1);
}
console.log("no class is missing from the sheets");
