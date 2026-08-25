/**
 * CLI `mstar harness scaffold` — one-shot harness bootstrap wrapper.
 *
 * Thin wrapper over engine `path.scaffoldHarness` + `path.emitGitignoreSnippet`
 * (plan-conventions § 初始化 Plan 目录 / § Git 跟踪策略; mstar-project-governance
 * § `_default` 回退):
 * - Creates the resolved harness dir (default `.mstar/`; `.mstarc`
 *   harness_dir honored) with plans/iterations/knowledge/specs/sdd + v2
 *   status.json + `_default/` under the resolved `{PROJECT_DIR}`
 *   (`.mstarc` project_dir honored) with roadmap.md + residuals.json.
 * - Appends the canonical `.gitignore` snippet when missing (only for the
 *   default `.mstar/` layout — custom layouts are skipped); skips cleanly
 *   when the complete fence is already present. A reversed partial fence
 *   (re-includes without the broad rule) is spliced, not appended; a
 *   complete-but-misordered fence (broad rule after re-includes) is
 *   repaired by relocating the broad rule before the first re-include.
 * - Writes a minimal `{HARNESS_DIR}/AGENTS.md` when absent.
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
  const proc = Bun.spawnSync([process.execPath, "run", "src/index.ts", "harness", "scaffold", ...args], {
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

/**
 * Minimal valid git work tree (no `git init` subprocess): the CLI's
 * workspace-root probe runs `git rev-parse --show-cdup`, which only needs a
 * valid `.git` layout (HEAD + config + objects/ + refs/) — no commits.
 * Mirrors the engine path.test.ts `gitInit` fixture.
 */
function gitInit(root: string): void {
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  mkdirSync(join(root, ".git", "refs"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
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

describe("mstar harness scaffold — one-shot harness bootstrap", () => {
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

  test("reversed partial fence: splices .mstar/** before existing !.mstar/ re-includes", () => {
    withRoot((root) => {
      // Pre-existing fence with ONLY re-include lines and no broad rule —
      // appending .mstar/** at the end would shadow them (last-match-wins).
      writeFileSync(join(root, ".gitignore"), "!.mstar/knowledge/\n!.mstar/knowledge/**\n", "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("created: .gitignore (canonical harness snippet)");

      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      const lines = gitignore.split(/\r?\n/);
      const broadIndex = lines.findIndex((line) => line.trim() === ".mstar/**");
      const firstNegationIndex = lines.findIndex((line) => line.trim().startsWith("!.mstar/"));
      expect(broadIndex).toBeGreaterThan(-1);
      // Broad rule must precede every re-include (gitignore last-match-wins).
      expect(firstNegationIndex).toBeGreaterThan(broadIndex);
      // All re-includes present; the pre-existing ones are not duplicated.
      expect(gitignore.split(".mstar/**").length - 1).toBe(1);
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
    });
  });

  test("complete-but-misordered fence: relocates .mstar/** before the first !.mstar/ re-include, preserving unrelated lines", () => {
    withRoot((root) => {
      // All canonical entries present, but the broad rule sits AFTER the
      // re-includes — gitignore last-match-wins would shadow them. Unrelated
      // user lines (comments, other rules) must survive byte-for-byte.
      const userLines = [
        "# user comment",
        "node_modules/",
        "!.mstar/knowledge/**",
        ".mstar/**",
        "!.mstar/AGENTS.md",
        "!.mstar/knowledge/",
        "!.mstar/specs/",
        "!.mstar/specs/**",
        ".mstarc",
        "dist/",
      ];
      writeFileSync(join(root, ".gitignore"), `${userLines.join("\n")}\n`, "utf8");

      const first = runScaffold([root]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("created: .gitignore (canonical harness snippet reordered)");

      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      const lines = gitignore.split(/\r?\n/);
      const broadIndex = lines.findIndex((line) => line.trim() === ".mstar/**");
      const firstNegationIndex = lines.findIndex((line) => line.trim().startsWith("!.mstar/"));
      expect(broadIndex).toBeGreaterThan(-1);
      // Broad rule now precedes EVERY re-include.
      expect(firstNegationIndex).toBeGreaterThan(broadIndex);
      // Exactly one broad rule; all canonical entries present.
      expect(gitignore.split(".mstar/**").length - 1).toBe(1);
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      // Unrelated user lines preserved byte-for-byte, in order.
      for (const line of ["# user comment", "node_modules/", "dist/"]) expect(gitignore).toContain(line);
      expect(gitignore.indexOf("node_modules/")).toBeLessThan(gitignore.indexOf(".mstar/**"));
      expect(gitignore.indexOf("dist/")).toBeGreaterThan(gitignore.indexOf(".mstar/**"));

      // Idempotent: second run changes nothing.
      const second = runScaffold([root]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("skipped: .gitignore (canonical harness snippet already present)");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gitignore);
    });
  });

  test("incomplete-and-misordered fence (PM repro): appends missing entries AND relocates .mstar/** before every re-include", () => {
    withRoot((root) => {
      // PM-verified repro: the fence is missing !.mstar/knowledge/ and
      // !.mstar/specs/ (directory re-includes) AND the broad rule sits after
      // !.mstar/knowledge/** — gitignore last-match-wins would shadow
      // .mstar/knowledge/<file>. The append branch must ALSO repair order.
      const reproLines = [
        "!.mstar/knowledge/**",
        ".mstar/**",
        "!.mstar/AGENTS.md",
        "!.mstar/specs/**",
        ".mstarc",
      ];
      writeFileSync(join(root, ".gitignore"), `${reproLines.join("\n")}\n`, "utf8");

      const first = runScaffold([root]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("created: .gitignore (canonical harness snippet)");
      expect(first.stdout).toContain("created: .gitignore (canonical harness snippet reordered)");

      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      const lines = gitignore.split(/\r?\n/);
      const broadIndex = lines.findIndex((line) => line.trim() === ".mstar/**");
      const negationIndexes = lines
        .map((line, index) => (line.trim().startsWith("!.mstar/") ? index : -1))
        .filter((index) => index !== -1);
      expect(broadIndex).toBeGreaterThan(-1);
      // Broad rule precedes EVERY re-include.
      for (const negationIndex of negationIndexes) expect(broadIndex).toBeLessThan(negationIndex);
      // Exactly one broad rule; all canonical entries present.
      expect(gitignore.split(".mstar/**").length - 1).toBe(1);
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      // Unrelated pre-existing lines preserved byte-for-byte, in order.
      for (const line of reproLines) expect(gitignore).toContain(line);
      expect(gitignore.indexOf("!.mstar/AGENTS.md")).toBeGreaterThan(gitignore.indexOf(".mstar/**"));
      expect(gitignore.indexOf(".mstarc")).toBeGreaterThan(gitignore.indexOf(".mstar/**"));

      // Idempotent: second run changes nothing.
      const second = runScaffold([root]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("skipped: .gitignore (canonical harness snippet already present)");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gitignore);
    });
  });

  test("trailing duplicate .mstar/** after a correctly ordered fence: dedupes to one broad rule before every re-include, preserving other lines", () => {
    withRoot((root) => {
      // Correctly ordered complete fence, then a trailing duplicate
      // .mstar/** at the very end. findIndex-based normalization only sees
      // the FIRST broad rule (already correctly placed), so the trailing
      // duplicate would survive and shadow the re-includes (last-match-wins).
      const userLines = [
        "# user comment",
        "node_modules/",
        "# Morning Star harness (.mstar/)",
        "# Default-ignore everything under .mstar/, then re-include the tracked results.",
        ".mstar/**",
        "!.mstar/AGENTS.md",
        "!.mstar/knowledge/",
        "!.mstar/knowledge/**",
        "!.mstar/specs/",
        "!.mstar/specs/**",
        ".mstarc",
        "dist/",
        ".mstar/**",
      ];
      writeFileSync(join(root, ".gitignore"), `${userLines.join("\n")}\n`, "utf8");

      const first = runScaffold([root]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("created: .gitignore (canonical harness snippet reordered)");

      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      const lines = gitignore.split(/\r?\n/);
      // Exactly ONE broad rule, positioned immediately before the first re-include.
      expect(gitignore.split(".mstar/**").length - 1).toBe(1);
      const broadIndex = lines.findIndex((line) => line.trim() === ".mstar/**");
      const negationIndexes = lines
        .map((line, index) => (line.trim().startsWith("!.mstar/") ? index : -1))
        .filter((index) => index !== -1);
      expect(broadIndex).toBeGreaterThan(-1);
      expect(negationIndexes.length).toBeGreaterThan(0);
      expect(broadIndex).toBe(negationIndexes[0] - 1);
      for (const negationIndex of negationIndexes) expect(broadIndex).toBeLessThan(negationIndex);
      // All canonical entries present; unrelated user lines preserved in order.
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      for (const line of ["# user comment", "node_modules/", "dist/"]) expect(gitignore).toContain(line);
      expect(gitignore.indexOf("node_modules/")).toBeLessThan(gitignore.indexOf(".mstar/**"));
      expect(gitignore.indexOf("dist/")).toBeGreaterThan(gitignore.indexOf(".mstar/**"));

      // Idempotent: second run changes nothing.
      const second = runScaffold([root]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("skipped: .gitignore (canonical harness snippet already present)");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gitignore);
    });
  });

  test("duplicate .mstar/** both before AND after re-includes: keeps the earliest, drops the trailing one, never moves a correctly-placed broad rule", () => {
    withRoot((root) => {
      // One broad rule before the negations (correctly placed) and a second
      // one after them (shadowing). The kept rule must be the EARLIEST
      // occurrence, and the trailing duplicate must be removed. The kept
      // rule already sits before every canonical negation, so the
      // un-crossable-lines invariant must NOT move it across node_modules/.
      const userLines = [
        "# user comment",
        ".mstar/**",
        "node_modules/",
        "!.mstar/knowledge/**",
        "!.mstar/AGENTS.md",
        "!.mstar/knowledge/",
        "!.mstar/specs/",
        "!.mstar/specs/**",
        ".mstarc",
        "dist/",
        ".mstar/**",
      ];
      writeFileSync(join(root, ".gitignore"), `${userLines.join("\n")}\n`, "utf8");

      const first = runScaffold([root]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("created: .gitignore (canonical harness snippet reordered)");

      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      const lines = gitignore.split(/\r?\n/);
      // Exactly ONE broad rule, still at its original position (before
      // node_modules/ and before every re-include).
      expect(gitignore.split(".mstar/**").length - 1).toBe(1);
      const broadIndex = lines.findIndex((line) => line.trim() === ".mstar/**");
      const negationIndexes = lines
        .map((line, index) => (line.trim().startsWith("!.mstar/") ? index : -1))
        .filter((index) => index !== -1);
      expect(broadIndex).toBeGreaterThan(-1);
      expect(negationIndexes.length).toBeGreaterThan(0);
      expect(broadIndex).toBe(1);
      expect(broadIndex).toBeLessThan(lines.findIndex((line) => line.trim() === "node_modules/"));
      for (const negationIndex of negationIndexes) expect(broadIndex).toBeLessThan(negationIndex);
      // All canonical entries present; unrelated user lines preserved in order.
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      for (const line of ["# user comment", "node_modules/", "dist/"]) expect(gitignore).toContain(line);
      // The kept broad rule stays at its original position, BEFORE
      // node_modules/ (it was already correctly placed).
      expect(gitignore.indexOf(".mstar/**")).toBeLessThan(gitignore.indexOf("node_modules/"));
      expect(gitignore.indexOf("dist/")).toBeGreaterThan(gitignore.indexOf(".mstar/**"));

      // Idempotent: second run changes nothing.
      const second = runScaffold([root]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("skipped: .gitignore (canonical harness snippet already present)");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gitignore);
    });
  });

  test(".mstarc harness_dir=.custom: files land in .custom/, .gitignore untouched", () => {
    withRoot((root) => {
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.custom\n", "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`scaffold: harness initialized at ${join(root, ".custom")}`);
      expect(result.stdout).toContain(`  harness dir: ${join(root, ".custom")}`);
      expect(result.stdout).toContain(
        "skipped: .gitignore (canonical harness snippet) — custom harness layout manages its own ignore rules",
      );
      // Files land under the declared dir, not .mstar/.
      expect(existsSync(join(root, ".custom", "status.json"))).toBe(true);
      expect(existsSync(join(root, ".custom", "projects", "_default", "roadmap.md"))).toBe(true);
      expect(existsSync(join(root, ".custom", "AGENTS.md"))).toBe(true);
      expect(existsSync(join(root, ".mstar"))).toBe(false);
      // No .gitignore mutation for custom layouts.
      expect(existsSync(join(root, ".gitignore"))).toBe(false);
    });
  });

  test(".mstarc project_dir=process/projects: _default lands under the overridden project dir", () => {
    withRoot((root) => {
      writeFileSync(join(root, ".mstarc"), "[config]\nproject_dir=process/projects\n", "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`  harness dir: ${join(root, ".mstar")}`);
      expect(result.stdout).toContain(`  project dir: ${join(root, "process", "projects")}`);
      // Harness layout stays .mstar/ (canonical snippet still appended).
      expect(result.stdout).toContain("created: .gitignore (canonical harness snippet)");
      expect(existsSync(join(root, ".mstar", "status.json"))).toBe(true);
      // _default lands under the resolved project dir, NOT {HARNESS_DIR}/projects.
      expect(existsSync(join(root, "process", "projects", "_default", "roadmap.md"))).toBe(true);
      expect(existsSync(join(root, "process", "projects", "_default", "residuals.json"))).toBe(true);
      expect(existsSync(join(root, ".mstar", "projects"))).toBe(false);
    });
  });

  test("defaults to cwd when [path] is omitted", () => {
    withRoot((root) => {
      const proc = Bun.spawnSync([process.execPath, "run", join(CLI_ROOT, "src/index.ts"), "harness", "scaffold"], {
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

  test(".mstarc harness_dir=config/.mstar: basename matches default but path is custom — .gitignore untouched", () => {
    withRoot((root) => {
      // Regression (PR #147 round-5): a custom harness dir whose BASENAME
      // is `.mstar` (e.g. config/.mstar) used to be misclassified as the
      // default layout, so scaffold wrote root-relative `.mstar/**` patterns
      // into <root>/.gitignore that never match config/.mstar/... — process
      // artifacts stayed unignored while scaffold reported the fence
      // installed. The gate must be exact-path equality with <root>/.mstar.
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=config/.mstar\n", "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`scaffold: harness initialized at ${join(root, "config", ".mstar")}`);
      expect(result.stdout).toContain(`  harness dir: ${join(root, "config", ".mstar")}`);
      expect(result.stdout).toContain(
        "skipped: .gitignore (canonical harness snippet) — custom harness layout manages its own ignore rules",
      );
      // Files land under the declared custom dir.
      expect(existsSync(join(root, "config", ".mstar", "status.json"))).toBe(true);
      expect(existsSync(join(root, "config", ".mstar", "projects", "_default", "roadmap.md"))).toBe(true);
      expect(existsSync(join(root, "config", ".mstar", "AGENTS.md"))).toBe(true);
      // No default-layout dir and NO .gitignore created/modified.
      expect(existsSync(join(root, ".mstar"))).toBe(false);
      expect(existsSync(join(root, ".gitignore"))).toBe(false);
    });
  });

  test("repo-root .mstarc harness_dir=.mstar + subdir path arg: fence installed at the git top-level (PR #147 round-6)", () => {
    withRoot((root) => {
      // Regression (PR #147 round-6): a repo-root `.mstarc` declaring
      // `harness_dir=.mstar` resolves the harness dir against the config
      // file's location — <repoRoot>/.mstar. Scaffolding a SUBDIRECTORY path
      // used to compare that against <subdir>/.mstar, skip the canonical
      // fence, and leave status/plans/projects committable. The comparison
      // AND the fence target must anchor at the git top-level.
      gitInit(root);
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.mstar\n", "utf8");
      mkdirSync(join(root, "packages", "foo"), { recursive: true });

      const result = runScaffold([join(root, "packages", "foo")]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`scaffold: harness initialized at ${join(root, ".mstar")}`);
      expect(result.stdout).toContain("created: .gitignore (canonical harness snippet)");

      // Fence lands in the REPO-ROOT .gitignore, not the subdir's.
      expect(existsSync(join(root, ".gitignore"))).toBe(true);
      expect(existsSync(join(root, "packages", "foo", ".gitignore"))).toBe(false);
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      // Harness files land under the repo-root .mstar/.
      expect(existsSync(join(root, ".mstar", "status.json"))).toBe(true);

      // git check-ignore confirms the fence actually ignores process artifacts.
      const check = Bun.spawnSync(["git", "check-ignore", "-v", join(root, ".mstar", "status.json")], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(check.exitCode).toBe(0);
      expect(check.stdout.toString()).toContain(".mstar/**");
    });
  });

  test("custom !.mstar negation before the broad rule: fence left untouched, custom path stays ignored (PR #147 round-6)", () => {
    withRoot((root) => {
      // Regression (PR #147 round-6): the unconditional normalization used to
      // relocate `.mstar/**` before the FIRST `!.mstar/...` line, treating a
      // user-authored non-canonical negation (deliberately placed BEFORE a
      // later `.mstar/**` so the custom path stays ignored) as a canonical
      // fence member — flipping its intent. Here the broad rule is already
      // correctly placed (after the custom negation, before every canonical
      // re-include), so the fixed code must leave the file byte-for-byte
      // untouched — the old code would have moved the broad rule before
      // the custom negation and re-included the custom path.
      const userLines = [
        "# user comment",
        "!.mstar/custom-keep/**",
        ".mstar/**",
        "!.mstar/AGENTS.md",
        "!.mstar/knowledge/",
        "!.mstar/knowledge/**",
        "!.mstar/specs/",
        "!.mstar/specs/**",
        ".mstarc",
        "dist/",
      ];
      writeFileSync(join(root, ".gitignore"), `${userLines.join("\n")}\n`, "utf8");
      // git check-ignore below needs a valid work tree.
      gitInit(root);

      const first = runScaffold([root]);
      expect(first.exitCode).toBe(0);
      // No reorder: the file was already correctly ordered.
      expect(first.stdout).not.toContain("created: .gitignore (canonical harness snippet reordered)");
      expect(first.stdout).toContain("skipped: .gitignore (canonical harness snippet already present)");

      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      const lines = gitignore.split(/\r?\n/);
      const broadIndex = lines.findIndex((line) => line.trim() === ".mstar/**");
      const customIndex = lines.findIndex((line) => line.trim() === "!.mstar/custom-keep/**");
      const canonicalIndexes = lines
        .map((line, index) => (MSTAR_FENCE_ENTRIES.slice(1).includes(line.trim()) ? index : -1))
        .filter((index) => index !== -1);
      expect(broadIndex).toBeGreaterThan(-1);
      // Broad rule sits AFTER the custom negation and BEFORE every canonical re-include.
      expect(broadIndex).toBeGreaterThan(customIndex);
      for (const canonicalIndex of canonicalIndexes) expect(broadIndex).toBeLessThan(canonicalIndex);
      // Exactly one broad rule; all canonical entries present.
      expect(gitignore.split(".mstar/**").length - 1).toBe(1);
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      // Unrelated user lines preserved byte-for-byte, in order.
      for (const line of ["# user comment", "dist/"]) expect(gitignore).toContain(line);
      expect(gitignore.indexOf("dist/")).toBeGreaterThan(gitignore.indexOf(".mstar/**"));

      // git check-ignore semantics: the custom path stays ignored (its
      // negation precedes the broad rule, so the broad rule re-ignores it),
      // while knowledge contents stay re-included. check-ignore exits 0 for
      // BOTH (a negation pattern also "matches"), so the observable proof is
      // `git add -A` + `git ls-files`: knowledge/adr.md gets tracked,
      // custom-keep/note.md stays untracked.
      mkdirSync(join(root, ".mstar", "custom-keep"), { recursive: true });
      mkdirSync(join(root, ".mstar", "knowledge"), { recursive: true });
      writeFileSync(join(root, ".mstar", "custom-keep", "note.md"), "# n\n", "utf8");
      writeFileSync(join(root, ".mstar", "knowledge", "adr.md"), "# a\n", "utf8");
      const customCheck = Bun.spawnSync(["git", "check-ignore", "-v", join(root, ".mstar", "custom-keep", "note.md")], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(customCheck.exitCode).toBe(0);
      expect(customCheck.stdout.toString()).toContain(".mstar/**");
      const addAll = Bun.spawnSync(["git", "add", "-A"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(addAll.exitCode).toBe(0);
      const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(tracked.exitCode).toBe(0);
      const trackedFiles = tracked.stdout.toString();
      expect(trackedFiles).toContain(".mstar/knowledge/adr.md");
      expect(trackedFiles).not.toContain(".mstar/custom-keep/note.md");

      // Idempotent: second run changes nothing.
      const second = runScaffold([root]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("skipped: .gitignore (canonical harness snippet already present)");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gitignore);
    });
  });

  test("infeasible ordering (custom negation after a canonical one): broad rule NOT moved, missing entries appended (PR #147 round-6)", () => {
    withRoot((root) => {
      // Regression (PR #147 round-6): when a custom negation is interleaved
      // AFTER a canonical re-include, no slot satisfies both constraints
      // (after every custom negation AND before every canonical re-include).
      // The normalization must NOT reorder — the file keeps its user-authored
      // order — and must still append missing canonical entries. No silent
      // skip message when content changed.
      const userLines = [
        "!.mstar/AGENTS.md",
        "!.mstar/custom-keep/**",
        ".mstar/**",
        "!.mstar/knowledge/",
        "!.mstar/knowledge/**",
        "!.mstar/specs/",
        ".mstarc",
      ];
      writeFileSync(join(root, ".gitignore"), `${userLines.join("\n")}\n`, "utf8");

      const first = runScaffold([root]);
      expect(first.exitCode).toBe(0);
      // Missing !.mstar/specs/** was appended (created message, not a skip).
      expect(first.stdout).toContain("created: .gitignore (canonical harness snippet)");
      // No reorder message — the infeasible ordering was left untouched.
      expect(first.stdout).not.toContain("created: .gitignore (canonical harness snippet reordered)");
      // No silent skip message: content changed, so "already present" must
      // not be claimed.
      expect(first.stdout).not.toContain("skipped: .gitignore (canonical harness snippet already present)");

      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      const lines = gitignore.split(/\r?\n/);
      const broadIndex = lines.findIndex((line) => line.trim() === ".mstar/**");
      const customIndex = lines.findIndex((line) => line.trim() === "!.mstar/custom-keep/**");
      const canonicalIndex = lines.findIndex((line) => line.trim() === "!.mstar/AGENTS.md");
      // Order preserved: canonical negation still precedes the custom one,
      // and the broad rule still sits after the custom negation.
      expect(canonicalIndex).toBeLessThan(customIndex);
      expect(broadIndex).toBeGreaterThan(customIndex);
      // The missing canonical entry was appended at the end.
      expect(gitignore).toContain("!.mstar/specs/**");
      expect(gitignore.indexOf("!.mstar/specs/**")).toBeGreaterThan(gitignore.indexOf(".mstar/**"));
    });
  });

  test("custom re-inclusion AFTER .mstar/**: ordering untouched, custom path stays tracked (PR #147 round-7)", () => {
    withRoot((root) => {
      // Regression (PR #147 round-7): the round-6 normalization relocated
      // .mstar/** to sit after every CUSTOM !.mstar/... negation. That
      // breaks the opposite deliberate layout: a user-authored custom
      // re-inclusion placed AFTER .mstar/** (last-match-wins => deliberately
      // re-included) gets crossed by the relocated broad rule and becomes
      // IGNORED. The broad rule here is already correctly placed (before
      // every canonical negation), so the un-crossable-lines invariant must
      // leave the file byte-for-byte untouched.
      const userLines = [
        "# user comment",
        ".mstar/**",
        "!.mstar/custom/",
        "!.mstar/custom/**",
        "!.mstar/AGENTS.md",
        "!.mstar/knowledge/",
        "!.mstar/knowledge/**",
        "!.mstar/specs/",
        "!.mstar/specs/**",
        ".mstarc",
        "dist/",
      ];
      writeFileSync(join(root, ".gitignore"), `${userLines.join("\n")}\n`, "utf8");
      // git add -A / ls-files below need a valid work tree.
      gitInit(root);

      const first = runScaffold([root]);
      expect(first.exitCode).toBe(0);
      // No reorder: the file was already correctly ordered.
      expect(first.stdout).not.toContain("created: .gitignore (canonical harness snippet reordered)");
      expect(first.stdout).toContain("skipped: .gitignore (canonical harness snippet already present)");

      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      // Byte-for-byte unchanged apart from nothing (complete fence).
      expect(gitignore).toBe(`${userLines.join("\n")}\n`);
      const lines = gitignore.split(/\r?\n/);
      const broadIndex = lines.findIndex((line) => line.trim() === ".mstar/**");
      const customIndex = lines.findIndex((line) => line.trim() === "!.mstar/custom/**");
      const canonicalIndexes = lines
        .map((line, index) => (MSTAR_FENCE_ENTRIES.slice(1).includes(line.trim()) ? index : -1))
        .filter((index) => index !== -1);
      expect(broadIndex).toBeGreaterThan(-1);
      // Broad rule sits BEFORE the custom re-inclusion and before every
      // canonical re-include.
      expect(broadIndex).toBeLessThan(customIndex);
      for (const canonicalIndex of canonicalIndexes) expect(broadIndex).toBeLessThan(canonicalIndex);
      // Exactly one broad rule; all canonical entries present.
      expect(gitignore.split(".mstar/**").length - 1).toBe(1);
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);

      // Observable git semantics: the custom re-inclusion after .mstar/**
      // keeps .mstar/custom/x TRACKED, knowledge stays TRACKED, and
      // .mstar/status.json stays ignored (check-ignore).
      mkdirSync(join(root, ".mstar", "custom"), { recursive: true });
      mkdirSync(join(root, ".mstar", "knowledge"), { recursive: true });
      writeFileSync(join(root, ".mstar", "custom", "x.md"), "# x\n", "utf8");
      writeFileSync(join(root, ".mstar", "knowledge", "y.md"), "# y\n", "utf8");
      writeFileSync(join(root, ".mstar", "status.json"), "{}\n", "utf8");
      const addAll = Bun.spawnSync(["git", "add", "-A"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(addAll.exitCode).toBe(0);
      const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(tracked.exitCode).toBe(0);
      const trackedFiles = tracked.stdout.toString();
      expect(trackedFiles).toContain(".mstar/custom/x.md");
      expect(trackedFiles).toContain(".mstar/knowledge/y.md");
      const ignored = Bun.spawnSync(["git", "check-ignore", "-v", join(root, ".mstar", "status.json")], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ignored.exitCode).toBe(0);
      expect(ignored.stdout.toString()).toContain(".mstar/**");

      // Idempotent: second run changes nothing.
      const second = runScaffold([root]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("skipped: .gitignore (canonical harness snippet already present)");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gitignore);
    });
  });

  test("misordered broad rule with an un-crossable line in the way: no relocation, order preserved (PR #147 round-7)", () => {
    withRoot((root) => {
      // Regression (PR #147 round-7): the broad rule sits AFTER the first
      // canonical negation, but a user line (node_modules/) lies strictly
      // between the first canonical negation and the broad rule. Moving the
      // broad rule up would cross that un-owned line and flip its path
      // semantics, so the normalization must NOT reorder — the file keeps
      // its user-authored order — and must still append missing canonical
      // entries. No silent skip message when content changed.
      const userLines = [
        "!.mstar/AGENTS.md",
        "node_modules/",
        ".mstar/**",
        "!.mstar/knowledge/",
        "!.mstar/knowledge/**",
        "!.mstar/specs/",
        ".mstarc",
      ];
      writeFileSync(join(root, ".gitignore"), `${userLines.join("\n")}\n`, "utf8");

      const first = runScaffold([root]);
      expect(first.exitCode).toBe(0);
      // Missing !.mstar/specs/** was appended (created message, not a skip).
      expect(first.stdout).toContain("created: .gitignore (canonical harness snippet)");
      // No reorder message — the infeasible ordering was left untouched.
      expect(first.stdout).not.toContain("created: .gitignore (canonical harness snippet reordered)");
      // No silent skip message: content changed, so "already present" must
      // not be claimed.
      expect(first.stdout).not.toContain("skipped: .gitignore (canonical harness snippet already present)");

      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      const lines = gitignore.split(/\r?\n/);
      const broadIndex = lines.findIndex((line) => line.trim() === ".mstar/**");
      const canonicalIndex = lines.findIndex((line) => line.trim() === "!.mstar/AGENTS.md");
      const nodeModulesIndex = lines.findIndex((line) => line.trim() === "node_modules/");
      // Order preserved: canonical negation still precedes node_modules/,
      // which still precedes the broad rule.
      expect(canonicalIndex).toBeLessThan(nodeModulesIndex);
      expect(nodeModulesIndex).toBeLessThan(broadIndex);
      // The missing canonical entry was appended at the end.
      expect(gitignore).toContain("!.mstar/specs/**");
      expect(gitignore.indexOf("!.mstar/specs/**")).toBeGreaterThan(gitignore.indexOf(".mstar/**"));
    });
  });

  test("misordered broad rule with only owned lines in the way: relocates before the first canonical negation (PR #147 round-7)", () => {
    withRoot((root) => {
      // Feasible reorder: the broad rule sits after the first canonical
      // negation, and every line between them is one we own (a comment and
      // a canonical negation). The move crosses no un-owned line, so the
      // broad rule is relocated to sit immediately before the first
      // canonical negation; every other line stays byte-for-byte.
      const userLines = [
        "# user comment",
        "!.mstar/AGENTS.md",
        "# a comment we own the semantics of",
        "!.mstar/knowledge/",
        ".mstar/**",
        "!.mstar/knowledge/**",
        "!.mstar/specs/",
        "!.mstar/specs/**",
        ".mstarc",
        "dist/",
      ];
      writeFileSync(join(root, ".gitignore"), `${userLines.join("\n")}\n`, "utf8");

      const first = runScaffold([root]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("created: .gitignore (canonical harness snippet reordered)");

      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      const lines = gitignore.split(/\r?\n/);
      const broadIndex = lines.findIndex((line) => line.trim() === ".mstar/**");
      const canonicalIndexes = lines
        .map((line, index) => (MSTAR_FENCE_ENTRIES.slice(1).includes(line.trim()) ? index : -1))
        .filter((index) => index !== -1);
      expect(broadIndex).toBeGreaterThan(-1);
      // Broad rule now precedes EVERY canonical re-include.
      for (const canonicalIndex of canonicalIndexes) expect(broadIndex).toBeLessThan(canonicalIndex);
      // Exactly one broad rule; all canonical entries present.
      expect(gitignore.split(".mstar/**").length - 1).toBe(1);
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      // Unrelated user lines preserved byte-for-byte, in order.
      for (const line of ["# user comment", "dist/"]) expect(gitignore).toContain(line);
      expect(gitignore.indexOf("dist/")).toBeGreaterThan(gitignore.indexOf(".mstar/**"));

      // Idempotent: second run changes nothing.
      const second = runScaffold([root]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("skipped: .gitignore (canonical harness snippet already present)");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gitignore);
    });
  });
});
