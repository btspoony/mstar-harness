/**
 * @mstar-harness/omp bundle smoke test — asserts the built `dist/` bundles
 * AND the packed installable artifact (npm pack) carry every surface omp
 * convention-scans from the installed package root: hooks/pre/, tools/*.js,
 * skills/, commands/, agents/, assets/, plugin.json. The packed check runs
 * `npm pack --json` (respecting `files` in package.json) into a temp dir so
 * a release cannot ship a tarball that omits convention-discovered metadata.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const HOOK_BUNDLE = join(DIST, "hooks", "pre", "mstar-gates.js");
const TOOLS = [
  "mstar_status_validate",
  "mstar_dispatch_validate",
  "mstar_iteration_gate",
  "mstar_lease_verify",
  "mstar_path_resolve",
  "mstar_worktree_check",
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

describe("@mstar-harness/omp packed artifact", () => {
  test(
    "npm pack tarball carries every omp convention-discovery surface",
    () => {
      const outDir = mkdtempSync(join(tmpdir(), "omp-pack-"));
      try {
        const packed = spawnSync("npm", ["pack", "--json"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
        expect(packed.status).toBe(0);
        const info = JSON.parse(packed.stdout) as Array<{ filename: string }>;
        const tarball = join(ROOT, info[0].filename);
        expect(existsSync(tarball)).toBe(true);
        const extract = spawnSync("tar", ["-xzf", tarball, "-C", outDir], { encoding: "utf8" });
        expect(extract.status).toBe(0);

        const pkgRoot = join(outDir, "package");
        // plugin.json + assets: convention-discovered metadata omp needs to
        // enumerate the plugin.
        expect(existsSync(join(pkgRoot, "plugin.json"))).toBe(true);
        expect(readdirSync(join(pkgRoot, "assets")).length).toBeGreaterThan(0);
        // Hook + tools at BOTH layouts (dist/ canonical, root discovery).
        expect(existsSync(join(pkgRoot, "dist", "hooks", "pre", "mstar-gates.js"))).toBe(true);
        expect(existsSync(join(pkgRoot, "hooks", "pre", "mstar-gates.js"))).toBe(true);
        for (const tool of TOOLS) {
          expect(existsSync(join(pkgRoot, "dist", "tools", tool, "index.js"))).toBe(true);
          expect(existsSync(join(pkgRoot, "tools", `${tool}.js`))).toBe(true);
        }
        // Skills/commands/agents (both layout names) with the PM entry set.
        for (const dir of ["skills", "harness-skills"]) {
          expect(existsSync(join(pkgRoot, dir, "mstar-harness-core", "SKILL.md"))).toBe(true);
          expect(existsSync(join(pkgRoot, dir, "pm", "SKILL.md"))).toBe(true);
        }
        for (const cmd of ["iteration-start", "iteration-drive", "iteration-loop"]) {
          expect(existsSync(join(pkgRoot, "commands", `${cmd}.md`))).toBe(true);
        }
        expect(existsSync(join(pkgRoot, "agents", "project-manager.md"))).toBe(true);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
        for (const f of readdirSync(ROOT)) {
          if (f.startsWith("mstar-harness-omp-") && f.endsWith(".tgz")) rmSync(join(ROOT, f));
        }
      }
    },
    150_000,
  );
});
