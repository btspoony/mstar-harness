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
    // tree-shaken value import that no screen happens to call yet.
    const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: import.meta.dir })].filter(
      (file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
    );
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      for (const line of source.split("\n")) {
        if (!line.includes("@mstar-harness/engine")) continue;
        if (line.trimStart().startsWith("import type ")) continue;
        if (line.trimStart().startsWith("} from \"@mstar-harness/engine\"") || line.includes("import type {")) continue;
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
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
