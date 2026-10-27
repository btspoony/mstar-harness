/**
 * The consumer contract's machine-checkable half: **this package's public surface
 * is browser-safe.**
 *
 * A host bundle pulls `src/index.ts` into a browser. Three things must never reach
 * that graph:
 *
 *  - a Node builtin (`node:fs`, `node:path`) — the renderer has no filesystem;
 *  - a host SDK (`@deepseek-ai/*`) — the shared layer must not depend on one host;
 *  - a *value* import from `@mstar-harness/engine` — the engine pulls SQLite, and a
 *    single non-type import would drag it into both bundles. Type-only engine
 *    imports are the coupling the plan allows, and they erase at build time.
 *
 * The assertion runs `Bun.build` over the real entry point with `target: "browser"`,
 * so it fails for the same reason a host build would fail — not because a regex
 * disliked a line.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "..", "..");

/**
 * A source with its type-only engine imports removed, so any remaining mention of the
 * specifier is a value import. Both import forms must go: one line, or the `import type {`
 * … `} from "@mstar-harness/engine"` block that `view-model/iterations.ts` uses.
 */
const withoutTypeOnlyEngineImports = (source: string): string =>
  source.replace(/^import type\s*\{[^}]*\}\s*from\s*"@mstar-harness\/engine";?[^\S\n]*\n/gm, "");

describe("the public surface is browser-safe", () => {
  test("it bundles for a browser target with no Node builtin and no host SDK", async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "index.ts")],
      target: "browser",
      // A bundle, not a library: this is what a host's renderer build does.
      outdir: join(PACKAGE_ROOT, "..", "..", ".tmp", "purity-out"),
    });
    expect(result.success).toBe(true);

    const banned = ["node:", "@deepseek-ai/", "bun:sqlite", "bun:ffi", "@mstar-harness/commands"];
    for (const output of result.outputs) {
      if (!output.path.endsWith(".js")) continue;
      const text = await output.text();
      const found = banned.filter((token) => text.includes(token));
      expect(found).toEqual([]);
    }
  }, 30_000);

  test("every engine import in the package is type-only", () => {
    // A value import would survive bundling and drag the engine in. Reading the
    // sources is the honest check: the bundle test above would pass for a
    // tree-shaken value import that no screen happens to call yet. Type-only imports
    // are stripped first, in either form, so a multi-line value import — which the
    // previous line-by-line scan could not see — is an offender too.
    const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: import.meta.dir })].filter(
      (file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
    );
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      if (withoutTypeOnlyEngineImports(source).includes("@mstar-harness/engine")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("the guard sees a value import written over several lines", () => {
    // The blind spot this pins: a multi-line value import mentions the specifier only on
    // its last line, which the old scan skipped as a bare `} from "…"` line.
    const value = 'import {\n  engineValue,\n} from "@mstar-harness/engine";\n';
    expect(withoutTypeOnlyEngineImports(value)).toContain("@mstar-harness/engine");
    const typeOnly = 'import type {\n  EngineType,\n} from "@mstar-harness/engine";\n';
    expect(withoutTypeOnlyEngineImports(typeOnly)).not.toContain("@mstar-harness/engine");
  });

  test("the entry point exposes the consumer surface and nothing host-specific", async () => {
    const surface = await import("./index.ts");
    // The tokens/base sheets are side-effect imports of the entry point, so a host
    // that imports the package gets the CSS contract too.
    const required = [
      "MS_THEME_ATTRIBUTE",
      "MS_CONTAINER_NAME",
      "MS_CONTAINER_CLASS",
      "MS_TONES",
      "LocaleProvider",
      "useCopy",
      "copyFor",
      "en",
      "zh",
      "Overview",
      "Focus",
      "Issues",
      "IssueDetail",
      "Workflows",
      "WorkflowDetail",
      "Iterations",
      "IterationDetail",
      "Projects",
      "ProjectDetail",
      "overviewModel",
      "focusModel",
      "issueListModel",
      "workflowListModel",
      "iterationListModel",
      "projectListModel",
      "resolveMember",
      "resolveRecord",
      "resolveSubjectMember",
      "parseIssueQuery",
      "issueQuery",
    ];
    const missing = required.filter((name) => !(name in surface));
    expect(missing).toEqual([]);
  });
});
