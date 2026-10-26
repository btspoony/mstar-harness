/**
 * Fails when the generated dashboard assets are older than the styles they are built from.
 *
 * Why this exists: a round rebuilt only `packages/ui`, started the dashboard, measured the
 * chart, and reported `844 x 88` — the value that had just been deleted. The CLI's
 * `assets.generated.ts` still carried the old CSS, so every browser measurement after it was
 * a measurement of the previous change. It happened twice.
 *
 * This is a timestamp comparison, not a content hash: it answers "was the CLI built after the
 * sheets changed", which is the question that was missed.
 *
 * Run: `bun run --cwd packages/ui check:stale`
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const generated = join(root, "packages", "commands", "src", "dashboard", "assets.generated.ts");
const stylesDir = join(root, "packages", "ui", "src", "styles");

let generatedAt: number;
try {
  generatedAt = statSync(generated).mtimeMs;
} catch {
  console.log("stale-assets: no generated assets, nothing to compare");
  process.exit(0);
}

const stale = readdirSync(stylesDir)
  .filter((name) => name.endsWith(".css"))
  .map((name) => ({ name, at: statSync(join(stylesDir, name)).mtimeMs }))
  .filter((sheet) => sheet.at > generatedAt);

if (stale.length > 0) {
  console.error(
    stale.map((sheet) => `  ${sheet.name} is newer than assets.generated.ts`).join("\n"),
  );
  console.error("\nthe dashboard bundle predates its styles: run `bun run --cwd packages/cli build`");
  process.exit(1);
}
console.log("the generated dashboard assets are newer than every stylesheet");
