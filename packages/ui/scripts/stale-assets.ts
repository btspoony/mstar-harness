/**
 * Fails when the generated dashboard assets are older than the sources they are built from.
 *
 * Why this exists: a round rebuilt only `packages/ui`, started the dashboard, measured the
 * chart, and reported `844 x 88` — the value that had just been deleted. The CLI's
 * `assets.generated.ts` still carried the old CSS, so every browser measurement after it was
 * a measurement of the previous change. It happened twice.
 *
 * The check covers the shared UI's whole source tree, not only its sheets: a screen, a
 * component, a view-model or a locale string is compiled into the same bundle, and a change
 * to one leaves the generated assets just as stale as a CSS edit.
 *
 * This is a timestamp comparison, not a content hash: it answers "was the CLI built after the
 * sources changed", which is the question that was missed.
 *
 * Run: `bun run --cwd packages/ui check:stale`
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const generated = join(root, "packages", "commands", "src", "dashboard", "assets.generated.ts");
const uiSrc = join(root, "packages", "ui", "src");

/** Every file under `target` older than `cutoff`, as repository-relative paths. */
function newerThan(target: string, cutoff: number, out: string[]): void {
  const info = statSync(target);
  if (info.isDirectory()) {
    for (const entry of readdirSync(target)) newerThan(join(target, entry), cutoff, out);
    return;
  }
  if (info.mtimeMs > cutoff) out.push(target.slice(root.length + 1));
}

let generatedAt: number;
try {
  generatedAt = statSync(generated).mtimeMs;
} catch {
  console.log("stale-assets: no generated assets, nothing to compare");
  process.exit(0);
}

const stale: string[] = [];
try {
  newerThan(uiSrc, generatedAt, stale);
} catch {
  // a checkout without the shared source tree has nothing to compare
}

if (stale.length > 0) {
  console.error(stale.map((path) => `  ${path} is newer than assets.generated.ts`).join("\n"));
  console.error("\nthe dashboard bundle predates its sources: run `bun run --cwd packages/cli build`");
  process.exit(1);
}

// A second hop: the CLI compiles `assets.generated.ts` into `dist/mstar-harness.js`, and a
// build that *failed* (an over-ceiling bundle, a type error) leaves that file older than the
// generated assets. The dashboard then serves the previous bundle and every browser
// measurement is of the previous change — the same failure this file's first hop was written
// for, one step further along.
const cliDist = join(root, "packages", "cli", "dist", "mstar-harness.js");
try {
  const distAt = statSync(cliDist).mtimeMs;
  const sources = [
    generated,
    join(root, "packages", "cli", "src"),
    join(root, "packages", "cli", "web"),
  ];
  const newer: string[] = [];
  for (const source of sources) {
    try {
      newerThan(source, distAt, newer);
    } catch {
      // a source directory that does not exist in this checkout
    }
  }
  if (newer.length > 0) {
    console.error(newer.slice(0, 5).map((path) => `  ${path} is newer than dist/mstar-harness.js`).join("\n"));
    console.error("\nthe CLI bundle predates its sources: run `bun run --cwd packages/cli build`");
    process.exit(1);
  }
} catch {
  // A checkout that never built the CLI is exactly the state this check exists for: there is
  // no bundle to compare against, and any measurement would be of whatever `dist` holds.
  const message = "stale-assets: no packages/cli/dist/mstar-harness.js — run `bun run --cwd packages/cli build`";
  if (process.env.STRICT_STALE === "1") {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

console.log("the generated dashboard assets and the CLI bundle are newer than their sources");
