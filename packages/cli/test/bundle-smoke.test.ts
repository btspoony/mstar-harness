/**
 * Bundle smoke — `mstar dispatch validate` run against the BUILT CLI bundle
 * (`packages/cli/dist/mstar-harness.js`), the exact execution face where the
 * bun runtime misdecodes raw non-ASCII regex/string literals (iteration spec
 * §7: bun 1.2.17 × 366KB `// @bun` bundle; node on the same bundle and a
 * direct engine-dist import both decode correctly). A legal UTF-8 em-dash
 * separator (`Branch policy: direct on main — <reason>`) must validate with
 * exit 0 — the regression that failed with two spurious violations
 * (`branch-policy-missing-reason` + `dispatch.default-branch.protected`).
 *
 * This test deliberately runs the bundle, not `src/index.ts` — the engine
 * unit tests and the src-running CLI tests never hit the misdecode path.
 * The CLI package `test` script builds the dist bundle as a pre-step.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(CLI_ROOT, "dist/mstar-harness.js");

/**
 * Spawn env with ambient harness env vars pinned out (qc3 F-4): the CLI
 * resolves harness dirs from MSTAR_HARNESS_DIR ahead of probing, and
 * `dispatch validate` reads the branch from MSTAR_WORKING_BRANCH — an
 * ambient value would redirect every fixture spuriously (same convention
 * as dispatch-cli.test.ts).
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR" || key === "MSTAR_WORKING_BRANCH") {
      continue;
    }
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run the built bundle (bun executing dist/mstar-harness.js) as a subprocess. */
function runBundle(args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, BUNDLE, ...args], {
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Write an assignment fixture and return its path. */
function withAssignment(assignmentText: string, fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mstar-bundle-smoke-"));
  const file = join(dir, "assignment.md");
  writeFileSync(file, assignmentText);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Legal writable assignment using the UTF-8 em-dash separator (U+2014, bytes e2 80 94). */
const EM_DASH_ASSIGNMENT = `## Assignment

**Execute as**: architect
**Delegation**: forbidden
**Task category**: docs
**Branch policy**: direct on main — hotfix: fix now

task body
`;

describe("mstar dispatch validate — built bundle (bun runtime) with non-ASCII separator", () => {
  test("legal UTF-8 em-dash separator → exit 0, no missing-reason / protected violations", () => {
    withAssignment(EM_DASH_ASSIGNMENT, (file) => {
      const result = runBundle(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("dispatch validate: OK");
      expect(result.stderr).not.toContain("branch-policy-missing-reason");
      expect(result.stderr).not.toContain("dispatch.default-branch.protected");
    });
  });

  test("ASCII -- separator still validates (regression guard)", () => {
    const ascii = EM_DASH_ASSIGNMENT.replace("direct on main — hotfix: fix now", "direct on main -- team hotfix convention");
    withAssignment(ascii, (file) => {
      const result = runBundle(["dispatch", "validate", file]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("dispatch validate: OK");
    });
  });
});
