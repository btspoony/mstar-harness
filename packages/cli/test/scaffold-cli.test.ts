/**
 * CLI `mstar scaffold` — one-shot harness bootstrap wrapper.
 *
 * Thin wrapper over engine `path.scaffoldHarness` + `path.emitGitignoreSnippet`
 * (plan-conventions § 初始化 Plan 目录 / § Git 跟踪策略; mstar-project-governance
 * § `_default` 回退):
 * - Creates `.mstar/` (plans/iterations/knowledge/specs/sdd + v2 status.json
 *   + projects/_default/roadmap.md + residuals.json).
 * - Appends the canonical `.gitignore` snippet when absent; skips cleanly
 *   when the complete fence is already present.
 * - Writes a minimal `.mstar/AGENTS.md` when absent.
 * - Idempotent: re-running on an initialized tree changes nothing.
 *
 * Each case runs the real CLI as a subprocess against a temp fixture tree.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn env with ambient MSTAR_HARNESS_DIR pinned out (qc3 F-4): the CLI
 * resolves harness dirs from that env var ahead of probing, so an ambient
 * value would redirect every fixture to the env dir and fail spuriously.
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runScaffold(args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", "src/index.ts", "scaffold", ...args], {
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Empty temp root; `.mstar/` and specs content added per test. */
function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mstar-scaffold-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Canonical `.mstar/` fence entries (ignore + re-include), verbatim from plan-conventions § Git 跟踪策略. */
const MSTAR_FENCE_ENTRIES = [
  ".mstar/**",
  "!.mstar/AGENTS.md",
  "!.mstar/knowledge/",
  "!.mstar/knowledge/**",
  "!.mstar/specs/",
  "!.mstar/specs/**",
];

describe("mstar scaffold — one-shot harness bootstrap", () => {
  test("creates .mstar/ with dirs, v2 status.json, projects/_default/, .gitignore snippet, and .mstar/AGENTS.md", () => {
    withRoot((root) => {
      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`scaffold: harness initialized at ${join(root, ".mstar")}`);
      expect(result.stdout).toContain("created: .gitignore (canonical harness snippet)");
      expect(result.stdout).toContain("created: .mstar/AGENTS.md");

      const harnessDir = join(root, ".mstar");
      for (const dir of ["plans", "iterations", "knowledge", "specs", "sdd", "projects"]) {
        expect(existsSync(join(harnessDir, dir))).toBe(true);
      }
      expect(existsSync(join(harnessDir, "status.json"))).toBe(true);
      expect(existsSync(join(harnessDir, "projects", "_default", "roadmap.md"))).toBe(true);
      expect(existsSync(join(harnessDir, "projects", "_default", "residuals.json"))).toBe(true);
      expect(existsSync(join(harnessDir, "AGENTS.md"))).toBe(true);

      // Canonical snippet appended once, complete fence present.
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      expect(gitignore.split(".mstar/**").length - 1).toBe(1);
    });
  });

  test("is idempotent: second run changes nothing and reports skipped", () => {
    withRoot((root) => {
      const first = runScaffold([root]);
      expect(first.exitCode).toBe(0);
      const gitignoreAfterFirst = readFileSync(join(root, ".gitignore"), "utf8");
      const agentsAfterFirst = readFileSync(join(root, ".mstar", "AGENTS.md"), "utf8");
      const roadmapAfterFirst = readFileSync(join(root, ".mstar", "projects", "_default", "roadmap.md"), "utf8");

      const second = runScaffold([root]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("skipped: .gitignore (canonical harness snippet already present)");
      expect(second.stdout).toContain("skipped: .mstar/AGENTS.md (already present)");
      expect(second.stdout).not.toContain("created:");
      // Nothing changed on re-run.
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gitignoreAfterFirst);
      expect(readFileSync(join(root, ".mstar", "AGENTS.md"), "utf8")).toBe(agentsAfterFirst);
      expect(readFileSync(join(root, ".mstar", "projects", "_default", "roadmap.md"), "utf8")).toBe(roadmapAfterFirst);
    });
  });

  test("preserves an existing .gitignore and .mstar/AGENTS.md (never clobbers)", () => {
    withRoot((root) => {
      writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8");
      mkdirSync(join(root, ".mstar"), { recursive: true });
      writeFileSync(join(root, ".mstar", "AGENTS.md"), "# custom harness rules\n", "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("skipped: .mstar/AGENTS.md (already present)");
      // Existing content preserved; snippet appended after it.
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      expect(gitignore.startsWith("node_modules/\n")).toBe(true);
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      expect(readFileSync(join(root, ".mstar", "AGENTS.md"), "utf8")).toBe("# custom harness rules\n");
    });
  });

  test("partial fence: appends only the missing re-include entries, keeping the existing .mstar/** line", () => {
    withRoot((root) => {
      // Pre-existing fence with only the default-ignore entry.
      writeFileSync(join(root, ".gitignore"), ".mstar/**\n", "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("created: .gitignore (canonical harness snippet)");

      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      // Exactly ONE .mstar/** line — the pre-existing one is not duplicated.
      expect(gitignore.split(".mstar/**").length - 1).toBe(1);
      // All 5 re-include entries are now present.
      for (const entry of MSTAR_FENCE_ENTRIES.slice(1)) expect(gitignore).toContain(entry);
    });
  });

  test("defaults to cwd when [path] is omitted", () => {
    withRoot((root) => {
      const proc = Bun.spawnSync([process.execPath, "run", join(CLI_ROOT, "src/index.ts"), "scaffold"], {
        cwd: root,
        env: cliEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(0);
      // The subprocess cwd resolves symlinks (macOS /var → /private/var), so
      // assert the harness line + the created files rather than an exact path.
      expect(proc.stdout.toString()).toContain("scaffold: harness initialized at");
      expect(proc.stdout.toString()).toContain(".mstar");
      expect(existsSync(join(root, ".mstar", "status.json"))).toBe(true);
    });
  });
});
