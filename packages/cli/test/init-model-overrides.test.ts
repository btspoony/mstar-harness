/**
 * `init --*-models` group semantics against the BUILT CLI bundle (the resolver
 * lives in `src/index.ts`, whose module scope parses argv, so it is only
 * reachable as a subprocess), plus partial-override cases driven directly
 * through `buildModelAssignments`. A supplied but empty group must refuse; an
 * absent group must stay silent and write nothing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildModelAssignments } from "../src/assignment";
import { ALL_ROLES, ROLE_GROUPS } from "../src/constants";

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

const GROUPED = ["project-manager", ...ROLE_GROUPS.strategic, ...ROLE_GROUPS.dev, ...ROLE_GROUPS.qc];
const UNGROUPED = ALL_ROLES.filter((role) => !(GROUPED as string[]).includes(role));

describe("buildModelAssignments partial overrides", () => {
  test("others alone fills only the ungrouped roles", () => {
    const assignments = buildModelAssignments({ pm: [], strategic: [], dev: [], qc: [], others: ["m"] });
    expect(Object.keys(assignments).sort()).toEqual([...UNGROUPED].sort());
    expect(Object.values(assignments)).toEqual(UNGROUPED.map(() => "m"));
    for (const role of GROUPED) expect(assignments[role]).toBeUndefined();
  });

  test("dev plus others leaves every other grouped role unassigned", () => {
    const assignments = buildModelAssignments({ pm: [], strategic: [], dev: ["a", "b"], qc: [], others: ["m"] });
    expect(assignments["fullstack-dev"]).toBe("a");
    expect(assignments["fullstack-dev-2"]).toBe("b");
    expect(assignments["frontend-dev"]).toBe("a");
    expect(Object.keys(assignments).sort()).toEqual([...ROLE_GROUPS.dev, ...UNGROUPED].sort());
    for (const role of UNGROUPED) expect(assignments[role]).toBe("m");
    for (const role of ["project-manager", ...ROLE_GROUPS.strategic, ...ROLE_GROUPS.qc]) expect(assignments[role]).toBeUndefined();
  });
});

describe("init model override groups", () => {
  test("a supplied value that names no model refuses, whatever its shape", () => {
    withTempRoot((root) => {
      for (const value of ["", " ", ",,"]) {
        const result = runInit(root, ["--dev-models", value]);
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("dev-models: the supplied value names no model.");
      }
    });
  });

  test("an empty single-value --pm-model refuses instead of reading as an absent flag", () => {
    withTempRoot((root) => {
      const result = runInit(root, ["--pm-model", " "]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("pm-model: the supplied value names no model.");
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
