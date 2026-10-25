/**
 * Dashboard asset generator — `bun run packages/cli/scripts/build-web.ts`.
 *
 * Bundles `web/main.tsx` (React 18, browser target) and reads `web/shell.html`,
 * then emits the ignored generated module
 * `packages/commands/src/dashboard/assets.generated.ts` exporting `dashboardHtml`,
 * `dashboardJs` and `dashboardCss` as escaped strings. The CLI build runs this
 * before bundling, so the published single artifact inlines the dashboard with no
 * disk asset directory, CDN, fonts or telemetry.
 *
 * Three facts decide the bundling, all measured rather than assumed:
 *
 *  - **`process.env.NODE_ENV` must be defined.** React 18 ships its development
 *    build when `NODE_ENV` is not statically known: 332,592 B minified without the
 *    define against 137,498 B with it in this checkout (Bun 1.4.0). The define is
 *    not a size tweak — it is what selects the production build at all.
 *  - **The CSS comes from the bundle output, not from a hand-maintained file.**
 *    `Bun.build` emits one CSS asset for the shared package's stylesheet imports;
 *    the generator finds it by extension. A second, hand-edited sheet is how two
 *    sources of truth for one token set appear.
 *  - **No version constant is embedded.** The identity line that once wanted one
 *    is gone (compass D30); the page's only validity fact is the projection state,
 *    which arrives at runtime.
 *
 * **Order matters.** After this generator runs, `packages/commands` must be
 * rebuilt before `bun test packages/cli`: the server serves the generated module
 * from `packages/commands/dist` while the tests import it from source, so a stale
 * `dist` fails the server suite with a byte mismatch that looks like a race. The
 * package's `build` and `typecheck:src` scripts already run both in order.
 *
 * Determinism: inputs are read from the repo only; no timestamp, random id or
 * absolute build path is embedded. Running the generator twice on unchanged
 * inputs produces byte-identical output (verified by the script itself after each
 * write via re-import and string equality).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CSS_CEILING,
  JS_CEILING,
  carriesDevelopmentReact,
  pickCssAsset,
  remoteReference,
  renderModule,
} from "./dashboard-assets";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commandsRoot = path.resolve(cliRoot, "../commands");
const webDir = path.join(cliRoot, "web");
/**
 * Where the generated module goes.
 *
 * The default is the module the CLI build consumes. An optional first argument
 * overrides it, which is what lets the build test assert the real generator's
 * output without rewriting a tracked file — a test that rewrites the artifact the
 * build owns races any concurrent build of the same tree.
 */
const defaultOutPath = path.join(commandsRoot, "src", "dashboard", "assets.generated.ts");
const outPath = process.argv[2] === undefined ? defaultOutPath : path.resolve(process.argv[2]);

async function main(): Promise<void> {
  const shellHtml = readFileSync(path.join(webDir, "shell.html"), "utf8");

  const bundle = await Bun.build({
    entrypoints: [path.join(webDir, "main.tsx")],
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!bundle.success) {
    console.error("build-web: main.tsx bundle failed");
    for (const log of bundle.logs) console.error(String(log));
    process.exit(1);
  }

  const jsAsset = bundle.outputs.find((output) => output.path.endsWith(".js"));
  if (jsAsset === undefined) {
    console.error("build-web: the build emitted no JS asset");
    process.exit(1);
  }
  const appJs = await jsAsset.text();

  const cssAsset = pickCssAsset(bundle.outputs);
  if (cssAsset === null) {
    console.error("build-web: the build emitted no CSS asset (the token sheet is imported by @mstar-harness/ui)");
    process.exit(1);
  }
  const styleCss = await cssAsset.text();

  if (carriesDevelopmentReact(appJs)) {
    console.error("build-web: the bundle carries React's development build; the NODE_ENV define is missing");
    process.exit(1);
  }
  if (appJs.length > JS_CEILING) {
    console.error(`build-web: dashboard JS is ${appJs.length}B, over the ${JS_CEILING}B ceiling`);
    process.exit(1);
  }
  if (styleCss.length > CSS_CEILING) {
    console.error(`build-web: dashboard CSS is ${styleCss.length}B, over the ${CSS_CEILING}B ceiling`);
    process.exit(1);
  }

  // Fixed asset references only; no disk asset directory is required at runtime.
  if (!shellHtml.includes('"/assets/app.css"') || !shellHtml.includes('"/assets/app.js"')) {
    console.error('build-web: shell.html must reference fixed "/assets/app.css" and "/assets/app.js"');
    process.exit(1);
  }
  for (const [name, value] of [["html", shellHtml], ["css", styleCss]] as const) {
    const found = remoteReference(value);
    if (found !== null) {
      console.error(`build-web: dashboard ${name} embeds a remote/CDN reference (${found}); offline only`);
      process.exit(1);
    }
  }

  const moduleSource = renderModule(shellHtml, appJs, styleCss);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, moduleSource, "utf8");

  // Round-trip check: the generated module must import cleanly and reproduce the
  // exact source strings (escape correctness + byte determinism of this run).
  const generated = await import(pathToFileURL(outPath).href);
  const roundTrips =
    generated.dashboardHtml === shellHtml &&
    generated.dashboardJs === appJs &&
    generated.dashboardCss === styleCss;
  if (!roundTrips) {
    console.error("build-web: generated module does not round-trip the source strings");
    process.exit(1);
  }

  console.log(
    `build-web: wrote ${path.relative(cliRoot, outPath)} ` +
      `(html ${shellHtml.length}B, js ${appJs.length}B, css ${styleCss.length}B)`,
  );
}

// Only run when invoked as a script: the helpers live in `dashboard-assets.ts`,
// which is what the build test imports.
if (import.meta.main) await main();
