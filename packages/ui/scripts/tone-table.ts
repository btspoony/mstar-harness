/**
 * Compares every `.tone-<name> .dot` background against the approved prototype's.
 *
 * Why this exists: `workflowStatusTone("running")` returned `neutral` for a long time — a
 * live workflow's dot was the same grey as a stopped one — and spot checks never caught it,
 * because each check asked "does the dot have a colour" rather than "the prototype's
 * colour". Diffing the whole table found it in one run, along with `completed`.
 *
 * The baseline is the tracked `design-system/prototype.html`. An unreadable baseline fails the
 * check: a comparator that could not read the prototype has not compared anything.
 *
 * Run: `bun run --cwd packages/ui check:tones`
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPrototype } from "./prototype-baseline.ts";

const PROTOTYPE = join(import.meta.dir, "..", "design-system", "prototype.html");

/** Every `.tone-<name> .dot { background: … }` value in a sheet, by tone name. */
function toneTable(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const rule = /((?:\.[a-z0-9-]+ )?\.tone-[a-z]+ \.dot(?:\s*,\s*(?:\.[a-z0-9-]+ )?\.tone-[a-z]+ \.dot)*)\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(rule)) {
    const background = /background:\s*([^;]+)/.exec(match[2])?.[1];
    if (background === undefined) continue;
    for (const name of match[1].matchAll(/\.tone-([a-z]+) \.dot/g)) {
      out.set(name[1], background.trim());
    }
  }
  return out;
}

const strip = (value: string | undefined) => (value ?? "").replace("var(--ms-", "").replace(")", "");

let prototypeSource: string;
try {
  prototypeSource = loadPrototype(PROTOTYPE);
} catch (error) {
  console.error(`tone-table: ${(error as Error).message}`);
  process.exit(1);
}

const dir = join(import.meta.dir, "..", "src", "styles");
const prototype = toneTable(prototypeSource);
const ours = new Map([
  ...toneTable(readFileSync(join(dir, "product.css"), "utf8")),
  ...toneTable(readFileSync(join(dir, "base.css"), "utf8")),
]);

const rows: string[] = [];
for (const name of [...new Set([...prototype.keys(), ...ours.keys()])].sort()) {
  const want = strip(prototype.get(name));
  const got = strip(ours.get(name));
  if (want === got) continue;
  // A name only this implementation has is its own vocabulary, not a mismatch.
  if (want === "") continue;
  rows.push(`.tone-${name}  prototype=${want} ours=${got || "(none)"}`);
}

if (rows.length > 0) {
  console.error(rows.join("\n"));
  console.error(`\n${rows.length} tone colour(s) disagree with the prototype.`);
  process.exit(1);
}
console.log(`every one of the prototype's ${prototype.size} tone colours matches`);
