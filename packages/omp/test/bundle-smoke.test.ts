/**
 * @mstar-harness/omp bundle smoke test — asserts the built `dist/` bundles
 * exist and that the engine is INLINED (no bare `@mstar-harness/engine`
 * import survives in the bundle output). Run `bun run build` first; the
 * test fails with a clear message when `dist/` is absent.
 *
 * Regression: the third-party `omp plugin install` failure was
 * `Cannot find package '@mstar-harness/engine'` at module link — the
 * repo-root hook/tools statically imported the workspace member whose
 * `dist/` is gitignored. Bundling inlines the engine so module link can
 * never fail on a missing package.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "dist");
const ROOT = join(import.meta.dir, "..");
const HOOK_BUNDLE = join(DIST, "hooks", "pre", "mstar-gates.js");
const TOOLS = [
  "mstar_status_validate",
  "mstar_worktree_check",
  "mstar_dispatch_validate",
  "mstar_iteration_gate",
  "mstar_lease_verify",
  "mstar_path_resolve",
];

describe("@mstar-harness/omp bundle smoke", () => {
  test("dist/hooks/pre/mstar-gates.js exists (run `bun run build` first)", () => {
    expect(existsSync(HOOK_BUNDLE)).toBe(true);
  });

  test("all six tool bundles exist under dist/tools/", () => {
    for (const tool of TOOLS) {
      expect(existsSync(join(DIST, "tools", tool, "index.js"))).toBe(true);
    }
  });

  test("omp discovery mirrors exist at the package root (hooks/pre/ + tools/*.js)", () => {
    // omp discovers plugin surfaces by convention from the installed package
    // root: `hooks/pre/` (any file) and `tools/` (direct *.js files — the
    // sub-directory scan only accepts `tools/<name>/index.ts`).
    expect(existsSync(join(ROOT, "hooks", "pre", "mstar-gates.js"))).toBe(true);
    for (const tool of TOOLS) {
      expect(existsSync(join(ROOT, "tools", `${tool}.js`))).toBe(true);
    }
  });

  test("hook bundle inlines the engine (validateStatus symbol present)", () => {
    const bundle = readFileSync(HOOK_BUNDLE, "utf8");
    expect(bundle).toContain("validateStatus");
  });

  test("hook bundle has no bare @mstar-harness/engine import reference", () => {
    const bundle = readFileSync(HOOK_BUNDLE, "utf8");
    expect(bundle).not.toMatch(/from\s*["']@mstar-harness\/engine["']/);
    expect(bundle).not.toMatch(/require\(["']@mstar-harness\/engine["']\)/);
    expect(bundle).not.toMatch(/import\(["']@mstar-harness\/engine["']\)/);
  });

  test("tool bundles inline the engine (no bare @mstar-harness/engine import)", () => {
    for (const tool of TOOLS) {
      const bundle = readFileSync(join(DIST, "tools", tool, "index.js"), "utf8");
      expect(bundle).not.toMatch(/from\s*["']@mstar-harness\/engine["']/);
      expect(bundle).not.toMatch(/require\(["']@mstar-harness\/engine["']\)/);
      expect(bundle).not.toMatch(/import\(["']@mstar-harness\/engine["']\)/);
    }
  });
});
