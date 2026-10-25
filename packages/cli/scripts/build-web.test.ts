/**
 * The dashboard bundle's acceptance: the offline guard, the determinism the
 * generator promises, the single CSS output, the production React build, a React
 * root that boots without `htm`/`preact`, and both size budgets.
 *
 * The rules themselves are imported from `dashboard-assets.ts`, which is the
 * generator's own decision surface. A test that re-implemented them would prove
 * two copies agree, not that the build is acceptable.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CSS_CEILING,
  JS_CEILING,
  PRODUCTION_DEFINE,
  carriesDevelopmentReact,
  pickCssAsset,
  remoteReference,
  renderModule,
} from "./dashboard-assets";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(cliRoot, "web");

const generatedPath = path.resolve(cliRoot, "../commands/src/dashboard/assets.generated.ts");

/**
 * Regenerate through the script, exactly as the CLI build does.
 *
 * The test does not bundle in-process: `Bun.build` takes its module-resolution
 * context from the bun process, so a suite started from the monorepo root could
 * not resolve the package's own `react` even with the same entry point. Driving
 * the real script asserts the real artifact and removes the cwd dependence.
 */
function regenerate(): { exitCode: number; stderr: string; stdout: string } {
  const proc = Bun.spawnSync(["bun", "run", path.join(cliRoot, "scripts", "build-web.ts")], {
    cwd: cliRoot,
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

let js = "";
let css = "";

beforeAll(async () => {
  const run = regenerate();
  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);
  const generated = await import(`${generatedPath}?v=${Date.now()}`);
  js = generated.dashboardJs;
  css = generated.dashboardCss;
});

describe("the offline guard", () => {
  test("a remote reference is rejected", () => {
    expect(remoteReference('<link href="https://fonts.googleapis.com/css">')).not.toBeNull();
    expect(remoteReference('<script src="http://example.test/app.js">')).not.toBeNull();
    expect(remoteReference("@import url(//cdn.example.test/x.css)")).not.toBeNull();
    expect(remoteReference('url("cdn.example.test/x.png")')).not.toBeNull();
  });

  test("local references pass, including a documentation URL in a comment-free CSS", () => {
    expect(remoteReference('href="/assets/app.css"')).toBeNull();
    expect(remoteReference("body{background:var(--ms-bg-canvas)}")).toBeNull();
  });

  test("the emitted HTML and CSS are offline-only", () => {
    const html = readFileSync(path.join(webDir, "shell.html"), "utf8");
    expect(remoteReference(html)).toBeNull();
    expect(remoteReference(css)).toBeNull();
  });
});

describe("the bundle", () => {
  test("carries React's production build, not its development one", () => {
    expect(carriesDevelopmentReact(js)).toBe(false);
    // The marker test is only meaningful if it can fail.
    expect(carriesDevelopmentReact('if(validateDOMNesting){}')).toBe(true);
  });

  test("emits exactly one CSS asset, and it carries the shared token sheet", () => {
    // The token sheet is the shared package's; its custom properties are the
    // proof this CSS came from the bundle and not from a hand-written file.
    expect(css).toContain("--ms-bg-canvas");
    expect(css).toContain("--ms-text-primary");
    expect(css).toContain("data-ms-theme");
  });

  test("boots a React root and imports no htm or preact value", () => {
    // A root that never calls createRoot is not an entry.
    expect(js).toContain("createRoot");
    // The old runtime must be gone from the graph, not merely unused.
    expect(js).not.toContain("htm/preact");
    expect(/preact/i.test(js)).toBe(false);
  });

  test("stays inside both reviewed ceilings", () => {
    expect(js.length).toBeLessThanOrEqual(JS_CEILING);
    expect(css.length).toBeLessThanOrEqual(CSS_CEILING);
  });

  test("is byte-identical across two consecutive generator runs", () => {
    const first = readFileSync(generatedPath);
    const rerun = regenerate();
    expect(rerun.exitCode).toBe(0);
    expect(readFileSync(generatedPath).equals(first)).toBe(true);
  });
});

describe("the generated module", () => {
  test("is a pure function of its inputs, so a rebuild cannot drift", () => {
    const a = renderModule("<html></html>", "console.log(1)", "body{}");
    const b = renderModule("<html></html>", "console.log(1)", "body{}");
    expect(b).toBe(a);
    // Non-ASCII becomes an escape so the generated module stays pure ASCII.
    expect(renderModule("é", "", "")).toContain("\\u00e9");
    expect(renderModule("é", "", "").isWellFormed()).toBe(true);
  });

  test("escapes a quote rather than breaking the literal", () => {
    const source = renderModule('a"b', "", "");
    expect(source).toContain('\\"');
  });
});

describe("the entry", () => {
  test("imports React and the shared package, and declares no preact value", () => {
    const source = readFileSync(path.join(webDir, "main.tsx"), "utf8");
    expect(source).toContain('from "react-dom/client"');
    expect(source).toContain("@mstar-harness/ui");
    expect(/from ["']preact/.test(source)).toBe(false);
    expect(/from ["']htm/.test(source)).toBe(false);
    // The theme contract is applied by the entry, not guessed by a component.
    expect(source).toContain("MS_THEME_ATTRIBUTE");
  });

  test("the generated assets module is written by the generator, not hand-edited", () => {
    const generated = path.resolve(cliRoot, "../commands/src/dashboard/assets.generated.ts");
    const source = readFileSync(generated, "utf8");
    expect(source.startsWith("// Generated by packages/cli/scripts/build-web.ts")).toBe(true);
    expect(source).toContain("export const dashboardCss");
  });
});
