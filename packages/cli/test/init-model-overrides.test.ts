/**
 * `init --*-models` group semantics against the BUILT CLI bundle (the resolver
 * lives in `src/index.ts`, whose module scope parses argv, so it is only
 * reachable as a subprocess). A supplied but empty group must refuse; an absent
 * group must stay silent and write nothing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_DIST = resolve(import.meta.dir, "../dist/mstar-harness.js");

function runInit(root: string, extra: string[]) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.MSTAR_CLI_PROJECT_ROOT = root;
  const args = ["init", "--dry-run", "--yes", "--no-global-cli", ...extra];
  const result = Bun.spawnSync([process.execPath, CLI_DIST, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
    root,
  };
}

function withTempRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mstar-init-model-overrides-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("init model override groups", () => {
  test("a supplied value that names no model refuses", () => {
    withTempRoot((root) => {
      for (const value of [",,", " "]) {
        const result = runInit(root, ["--dev-models", value]);
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("dev-models: the supplied value names no model.");
      }
    });
  });

  test("an absent group writes nothing and exits 0", () => {
    withTempRoot((root) => {
      const result = runInit(root, []);
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("  - fullstack-dev:");
    });
  });

  test("a supplied group writes exactly its roles", () => {
    withTempRoot((root) => {
      const result = runInit(root, ["--dev-models", "a,b"]);
      expect(result.exitCode).toBe(0);
      const devLines = result.output.split("\n").filter((line) => /^ {2}- (fullstack-dev|fullstack-dev-2|frontend-dev):/.test(line));
      expect(devLines).toEqual(["  - fullstack-dev: a", "  - fullstack-dev-2: b", "  - frontend-dev: a"]);
    });
  });
});
