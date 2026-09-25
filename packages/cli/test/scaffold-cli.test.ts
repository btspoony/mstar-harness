/**
 * CLI `mstar harness scaffold` — one-shot harness bootstrap wrapper.
 *
 * Thin wrapper over engine `path.scaffoldHarness` + `path.emitGitignoreSnippet`
 * (plan-conventions § 初始化 Plan 目录 / § Git 跟踪策略; mstar-project-governance
 * § `_default` 回退):
 * - Creates the resolved harness dir (default `.mstar/`; `.mstarc`
 *   harness_dir honored) with plans/iterations/knowledge/specs/sdd + v2
 *   status.json + `_default/` under the resolved `{PROJECT_DIR}` (a directory
 *   only; roadmap content is imported explicitly) and no residuals register.
 * - Appends the canonical `.gitignore` snippet when the file states no
 *   harness-root declaration (only for the default `.mstar/` layout — custom
 *   layouts are skipped). An authored harness-root declaration (`.mstar/…`,
 *   `.agents/…`, with or without a leading slash or `!`) makes the file
 *   author-owned: the fence writes no bytes at all — no append, reorder,
 *   dedupe or normalization.
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
 * Spawn env with ambient MSTAR_HARNESS_DIR pinned out: the CLI
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
  test("fresh bootstrap: creates .mstar/ with dirs, v2 status.json, projects/_default/, .gitignore snippet, and .mstar/AGENTS.md but no roadmap authority", () => {
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
      expect(existsSync(join(harnessDir, "projects", "_default"))).toBe(true);
      expect(existsSync(join(harnessDir, "projects", "_default", "roadmap.md"))).toBe(false);
      // The issue store is the findings authority (G2a/G2b): scaffold creates no
      // project register — a `residuals.json` would be migration history.
      expect(existsSync(join(harnessDir, "projects", "_default", "residuals.json"))).toBe(false);
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
      expect(existsSync(join(root, ".mstar", "projects", "_default", "roadmap.md"))).toBe(false);

      const second = runScaffold([root]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("skipped: .mstar/AGENTS.md (already present)");
      expect(second.stdout).not.toContain("created:");
      // Nothing changed on re-run.
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(gitignoreAfterFirst);
      expect(readFileSync(join(root, ".mstar", "AGENTS.md"), "utf8")).toBe(agentsAfterFirst);
      expect(existsSync(join(root, ".mstar", "projects", "_default", "roadmap.md"))).toBe(false);
    });
  });

  test("unrelated entries: preserves an existing .gitignore and .mstar/AGENTS.md (never clobbers)", () => {
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

  test("harness authored ignore: a whole-directory .mstar/** declaration keeps its exact bytes and stays ignored", () => {
    withRoot((root) => {
      gitInit(root);
      // Issue #248: the repository declares "the harness root is local-only";
      // the fence must not invert that into the tracked-results shape.
      const authored = "node_modules\n.mstar/**\n";
      writeFileSync(join(root, ".gitignore"), authored, "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("skipped: .gitignore");
      expect(result.stdout).not.toContain("created: .gitignore");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(authored);

      // Observable git semantics: the authored policy still ignores the root.
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "spec.md"), "# spec\n", "utf8");
      const addAll = Bun.spawnSync(["git", "add", "-A"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(addAll.exitCode).toBe(0);
      const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(tracked.exitCode).toBe(0);
      expect(tracked.stdout.toString()).not.toContain(".mstar/specs/spec.md");
    });
  });

  test("harness authored ignore: a partial or negated declaration is author-owned (no canonical completion)", () => {
    withRoot((root) => {
      const authored = "/.mstar/plans/\n!.mstar/specs/**\n";
      writeFileSync(join(root, ".gitignore"), authored, "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("created: .gitignore");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(authored);
    });
  });

  test("harness authored ignore: an .agents declaration with CRLF, comments, duplicates and no final newline survives byte-for-byte", () => {
    withRoot((root) => {
      const authored = "# authored policy\r\n.agents/**\r\n.agents/**\r\n!.agents/knowledge/**";
      writeFileSync(join(root, ".gitignore"), authored, "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("created: .gitignore");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(authored);
    });
  });

  test("harness authored ignore: .mstarc alone does not declare — the canonical snippet is still bootstrapped", () => {
    withRoot((root) => {
      const authored = "node_modules/\n.mstarc\n";
      writeFileSync(join(root, ".gitignore"), authored, "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("created: .gitignore (canonical harness snippet)");
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      // Authored lines stay in place; the canonical entries follow them.
      expect(gitignore.startsWith(authored)).toBe(true);
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      expect(gitignore.indexOf("node_modules/")).toBeLessThan(gitignore.indexOf(".mstar/**"));
    });
  });

  test(".mstarc harness_dir=.custom: custom layout keeps .gitignore untouched", () => {
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
      expect(existsSync(join(root, ".custom", "projects", "_default"))).toBe(true);
      expect(existsSync(join(root, ".custom", "projects", "_default", "roadmap.md"))).toBe(false);
      expect(existsSync(join(root, ".custom", "AGENTS.md"))).toBe(true);
      expect(existsSync(join(root, ".mstar"))).toBe(false);
      // No .gitignore mutation for custom layouts.
      expect(existsSync(join(root, ".gitignore"))).toBe(false);
    });
  });

  test(".mstarc project_dir=process/projects: fresh canonical fence, _default under the overridden project dir", () => {
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
      expect(existsSync(join(root, "process", "projects", "_default"))).toBe(true);
      expect(existsSync(join(root, "process", "projects", "_default", "roadmap.md"))).toBe(false);
      expect(existsSync(join(root, "process", "projects", "_default", "residuals.json"))).toBe(false);
      expect(existsSync(join(root, ".mstar", "projects"))).toBe(false);
    });
  });

  test("fresh bootstrap: defaults to cwd when [path] is omitted", () => {
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
      // Regression (PR #147): a custom harness dir whose BASENAME
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
      expect(existsSync(join(root, "config", ".mstar", "projects", "_default"))).toBe(true);
      expect(existsSync(join(root, "config", ".mstar", "projects", "_default", "roadmap.md"))).toBe(false);
      expect(existsSync(join(root, "config", ".mstar", "AGENTS.md"))).toBe(true);
      // No default-layout dir and NO .gitignore created/modified.
      expect(existsSync(join(root, ".mstar"))).toBe(false);
      expect(existsSync(join(root, ".gitignore"))).toBe(false);
    });
  });

  test("fresh fence at the git top-level: repo-root .mstarc harness_dir=.mstar + subdir path arg (PR #147)", () => {
    withRoot((root) => {
      // Regression (PR #147): a repo-root `.mstarc` declaring
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

  test("an existing malformed status.json is refused, never reinitialized (create-only bootstrap)", () => {
    withRoot((root) => {
      expect(runScaffold([root]).exitCode).toBe(0);
      // Replace the bootstrapped document with a v1-shaped one: the
      // create-only contract validates what is on disk instead of
      // overwriting it (spec §C4), so the bytes must survive untouched.
      writeFileSync(join(root, ".mstar", "status.json"), "{}\n", "utf8");

      const second = runScaffold([root]);
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain("scaffold never replaces existing state");
      expect(readFileSync(join(root, ".mstar", "status.json"), "utf8")).toBe("{}\n");
      // The refusal happens before the manifest is reported as created.
      expect(second.stdout).not.toContain("created:");
    });
  });
});
