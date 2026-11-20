/**
 * CLI `mstar harness scaffold` — one-shot harness bootstrap wrapper.
 *
 * Thin wrapper over engine `path.scaffoldHarness` + `path.emitGitignoreSnippet`
 * (plan-conventions § 初始化 Plan 目录 / § Git 跟踪策略; mstar-project-governance
 * § `_default` 回退):
 * - Creates the resolved harness dir (default `.mstar/`; `.mstarc`
 *   harness_dir honored) with plans/iterations/sdd/reviews + `_default/`
 *   under the resolved `{PROJECT_DIR}` (a directory only; roadmap content is
 *   imported explicitly), the tracked `.mstarc` declaring the layout, the
 *   resolved `.agents/{knowledge,specs,adr}` corpora, an ADR tree seeded with
 *   README + both templates, and no residuals register.
 * - Appends the canonical `.gitignore` snippet when the file states no
 *   harness-root declaration (only for the default `.mstar/` layout — custom
 *   layouts are skipped). An authored harness-root declaration (`.mstar/…`,
 *   `.agents/…`, with or without a leading slash or `!`) makes the file
 *   author-owned: the fence writes no bytes at all — no append, reorder,
 *   dedupe or normalization.
 * - Writes a minimal `.agents/AGENTS.md` (harness-layer rule file; tracked)
 *   when absent.
 * - Idempotent: re-running on an initialized tree changes nothing.
 *
 * Each case runs the real CLI as a subprocess against a temp fixture tree.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type RunResult } from "./harness";

interface ScaffoldData {
  harnessDir: string;
  projectDir: string;
  created: string[];
  skipped: string[];
}

function envelope(result: RunResult): { status: string; code: string; message?: string; data?: ScaffoldData } {
  return JSON.parse(result.stdout);
}

function scaffoldData(result: RunResult): ScaffoldData {
  const data = envelope(result).data;
  if (!data) throw new Error("expected scaffold result data");
  return data;
}

/** Spawn `mstar harness scaffold` against a fixture root. */
function runScaffold(args: string[]): RunResult {
  return runCli(["harness", "scaffold", ...args]);
}

/** Empty temp root; `.mstar/` and specs content added per test. */
function withRoot(fn: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-scaffold-")));
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

/** Canonical `.mstar/` fence entries, verbatim from plan-conventions § Git 跟踪策略. */
const MSTAR_FENCE_ENTRIES = [".mstar/"];

describe("mstar harness scaffold — one-shot harness bootstrap", () => {
  test("a legacy-only checkout does not block help or the scaffold recovery", () => {
    withRoot((root) => {
      gitInit(root);
      mkdirSync(join(root, ".agents"), { recursive: true });
      writeFileSync(join(root, ".agents", "status.json"), "{}");
      // why: the retired layout must not kill the CLI before dispatch.
      const help = runCli(["--help"], { cwd: root });
      expect(help.exitCode, help.stdout + help.stderr).toBe(0);
      const outside = mkdtempSync(join(tmpdir(), "mstar-scaffold-outside-"));
      try {
        const result = runCli(["harness", "scaffold", root], { cwd: outside });
        expect(result.exitCode, result.stdout + result.stderr).toBe(0);
        expect(existsSync(join(root, ".mstar"))).toBe(true);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  test("fresh bootstrap: creates .mstar/ process dirs, .agents/ tracked corpora, .mstarc, .gitignore snippet and .agents/AGENTS.md but no roadmap authority", () => {
    withRoot((root) => {
      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(scaffoldData(result).harnessDir).toBe(join(root, ".mstar"));
      expect(scaffoldData(result).created).toEqual([".gitignore (canonical harness snippet)", ".agents/AGENTS.md"]);

      const harnessDir = join(root, ".mstar");
      for (const dir of ["plans", "iterations", "sdd", "reviews", "projects"]) {
        expect(existsSync(join(harnessDir, dir))).toBe(true);
      }
      // ACTIVE disposition: scaffold provisions the layout only — the register
      // lives in store.db once `mstar store init` activates it; no status.json.
      expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
      expect(existsSync(join(harnessDir, "projects", "_default"))).toBe(true);
      expect(existsSync(join(harnessDir, "projects", "_default", "roadmap.md"))).toBe(false);
      // The issue store is the findings authority (G2a/G2b): scaffold creates no
      // project register — a `residuals.json` would be migration history.
      expect(existsSync(join(harnessDir, "projects", "_default", "residuals.json"))).toBe(false);

      // Tracked results: the harness-layer rule file, the declared corpora and
      // an ADR tree seeded deeply enough to accept the first record.
      expect(existsSync(join(root, ".agents", "AGENTS.md"))).toBe(true);
      for (const dir of ["knowledge", "specs"]) expect(existsSync(join(root, ".agents", dir))).toBe(true);
      const adrDir = join(root, ".agents", "adr");
      expect(existsSync(join(adrDir, "README.md"))).toBe(true);
      expect(existsSync(join(adrDir, "proposed", "TEMPLATE.md"))).toBe(true);
      expect(existsSync(join(adrDir, "implemented", "TEMPLATE.md"))).toBe(true);
      for (const bucket of ["proposed", "implemented", "rejected", "archived"]) {
        expect(existsSync(join(adrDir, bucket))).toBe(true);
      }
      expect(existsSync(join(harnessDir, "AGENTS.md"))).toBe(false);

      // why: The tracked .mstarc declares only the corpus layout: the harness root
      // is fixed at `.mstar/`, so no `harness_dir` key is emitted (a file that
      // still declares it is refused as retired).
      const config = readFileSync(join(root, ".mstarc"), "utf8");
      expect(config).toContain("The harness root is fixed at .mstar/");
      expect(config).not.toContain("harness_dir");
      expect(config).toContain("knowledge_dir=.agents/knowledge");
      expect(config).toContain("specs_dir=.agents/specs");
      expect(config).toContain("adr_dir=.agents/adr");

      // Canonical snippet appended once, complete fence present.
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      // Exact entry lines, not a substring count: `.mstar/**` also contains
      // `.mstar/` once and must not satisfy the fence assertion.
      expect(gitignore.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.startsWith("#")))
        .toEqual(MSTAR_FENCE_ENTRIES);
    });
  });

  test("is idempotent: second run changes nothing and reports skipped", () => {
    withRoot((root) => {
      const first = runScaffold([root]);
      expect(first.exitCode).toBe(0);
      appendFileSync(join(root, ".gitignore"), "\ncustom-cache/\n");
      appendFileSync(join(root, ".agents", "AGENTS.md"), "\n<!-- authored agent policy -->\n");
      appendFileSync(join(root, ".mstarc"), "\n# authored layout policy\n");
      appendFileSync(join(root, ".agents", "adr", "README.md"), "\n<!-- authored ADR index -->\n");
      expect(existsSync(join(root, ".mstar", "projects", "_default", "roadmap.md"))).toBe(false);

      const second = runScaffold([root]);
      expect(second.exitCode).toBe(0);
      expect(scaffoldData(second).skipped).toContain(".agents/AGENTS.md (already present)");
      expect(scaffoldData(second).created).toEqual([]);
      expect(scaffoldData(second).harnessDir).toBe(scaffoldData(first).harnessDir);
      const rules = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/);
      for (const entry of [...MSTAR_FENCE_ENTRIES, "custom-cache/"]) {
        expect(rules.filter((line) => line === entry)).toHaveLength(1);
      }
      expect(readFileSync(join(root, ".agents", "AGENTS.md"), "utf8")).toContain("authored agent policy");
      const config = readFileSync(join(root, ".mstarc"), "utf8");
      expect(config).toContain("authored layout policy");
      // why: the harness root is fixed; the retired key is never emitted.
      expect(config).not.toContain("harness_dir");
      expect(readFileSync(join(root, ".agents", "adr", "README.md"), "utf8")).toContain("authored ADR index");
      expect(existsSync(join(root, ".mstar", "projects", "_default", "roadmap.md"))).toBe(false);
    });
  });

  test("unrelated entries: preserves an existing .gitignore and .agents/AGENTS.md (never clobbers)", () => {
    withRoot((root) => {
      writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8");
      mkdirSync(join(root, ".agents"), { recursive: true });
      writeFileSync(join(root, ".agents", "AGENTS.md"), "# custom harness rules\n", "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(scaffoldData(result).skipped).toContain(".agents/AGENTS.md (already present)");
      // Existing content preserved; snippet appended after it.
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      expect(gitignore.startsWith("node_modules/\n")).toBe(true);
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      expect(readFileSync(join(root, ".agents", "AGENTS.md"), "utf8")).toContain("custom harness rules");
    });
  });

  test("harness authored ignore: a whole-directory .mstar/** declaration survives and stays ignored", () => {
    withRoot((root) => {
      gitInit(root);
      // Issue #248: the repository declares "the harness root is local-only";
      // the fence must not invert that into the tracked-results shape.
      const authored = "node_modules\n.mstar/**\n";
      writeFileSync(join(root, ".gitignore"), authored, "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(scaffoldData(result).skipped).toContain(".gitignore (author-owned harness-root declaration)");
      expect(scaffoldData(result).created).not.toContain(".gitignore (canonical harness snippet)");
      const rules = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/);
      expect(rules).toContain("node_modules");
      expect(rules).toContain(".mstar/**");
      expect(rules).not.toContain(".mstar/");

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
      expect(scaffoldData(result).created).not.toContain(".gitignore (canonical harness snippet)");
      expect(scaffoldData(result).skipped).toContain(".gitignore (author-owned harness-root declaration)");
      const rules = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/);
      expect(rules).toContain("/.mstar/plans/");
      expect(rules).toContain("!.mstar/specs/**");
      expect(rules).not.toContain(".mstar/");
    });
  });

  test("harness authored ignore: .agents rules, comments and exclusions survive mixed formatting", () => {
    withRoot((root) => {
      const authored = "# authored policy\r\n.agents/**\r\n.agents/**\r\n!.agents/knowledge/**";
      writeFileSync(join(root, ".gitignore"), authored, "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(scaffoldData(result).created).not.toContain(".gitignore (canonical harness snippet)");
      expect(scaffoldData(result).skipped).toContain(".gitignore (author-owned harness-root declaration)");
      const preserved = readFileSync(join(root, ".gitignore"), "utf8");
      expect(preserved).toContain("\r\n");
      expect(preserved).not.toMatch(/(?<!\r)\n/);
      expect(preserved.endsWith("\n")).toBe(false);
      const rules = preserved.split(/\r?\n/);
      expect(rules).toContain("# authored policy");
      expect(rules.filter((line) => line === ".agents/**")).toHaveLength(2);
      expect(rules).toContain("!.agents/knowledge/**");
      expect(rules).not.toContain(".mstar/");
    });
  });

  test("harness authored ignore: .mstarc alone does not declare — the canonical snippet is still bootstrapped", () => {
    withRoot((root) => {
      const authored = "node_modules/\n.mstarc\n";
      writeFileSync(join(root, ".gitignore"), authored, "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      expect(scaffoldData(result).created).toContain(".gitignore (canonical harness snippet)");
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      const rules = gitignore.split(/\r?\n/);
      expect(rules).toContain("node_modules/");
      expect(rules).toContain(".mstarc");
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      expect(gitignore.indexOf("node_modules/")).toBeLessThan(gitignore.indexOf(".mstar/"));
      expect(rules.indexOf(".mstarc")).toBeLessThan(rules.indexOf(".mstar/"));
    });
  });

  test(".mstarc harness_dir=.custom is refused as retired: nothing is scaffolded and .gitignore is untouched", () => {
    withRoot((root) => {
      writeFileSync(join(root, ".mstarc"), "[config]\nharness_dir=.custom\n", "utf8");

      const result = runScaffold([root]);
      // why: The harness root is fixed at `<checkout>/.mstar`; a `.mstarc` that
      // still declares `harness_dir` refuses by name instead of scaffolding a
      // second layout.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("harness_dir");
      expect(result.stdout).toContain("retired");
      expect(result.stdout).toContain("mstar path resolve");
      // why: Nothing is created for the retired declaration.
      expect(existsSync(join(root, ".custom"))).toBe(false);
      expect(existsSync(join(root, ".mstar"))).toBe(false);
      expect(existsSync(join(root, ".gitignore"))).toBe(false);
      expect(existsSync(join(root, ".agents"))).toBe(false);
    });
  });

  test(".mstarc project_dir=process/projects: fresh canonical fence, _default under the overridden project dir", () => {
    withRoot((root) => {
      writeFileSync(join(root, ".mstarc"), "[config]\nproject_dir=process/projects\n", "utf8");

      const result = runScaffold([root]);
      expect(result.exitCode).toBe(0);
      const resultData = scaffoldData(result);
      expect(resultData.harnessDir).toBe(join(root, ".mstar"));
      expect(resultData.projectDir).toBe(join(root, "process", "projects"));
      expect(resultData.created).toContain(".gitignore (canonical harness snippet)");
      expect(existsSync(join(root, ".mstar", "status.json"))).toBe(false);
      // _default lands under the resolved project dir, NOT {HARNESS_DIR}/projects.
      expect(existsSync(join(root, "process", "projects", "_default"))).toBe(true);
      expect(existsSync(join(root, "process", "projects", "_default", "roadmap.md"))).toBe(false);
      expect(existsSync(join(root, "process", "projects", "_default", "residuals.json"))).toBe(false);
      expect(existsSync(join(root, ".mstar", "projects"))).toBe(false);
    });
  });

  test("fresh bootstrap: defaults to cwd when [path] is omitted", () => {
    withRoot((root) => {
      const procResult = runCli(["harness", "scaffold"], { cwd: root });
      expect(procResult.exitCode).toBe(0);
      expect(scaffoldData(procResult).harnessDir.endsWith(join(".mstar"))).toBe(true);
      expect(existsSync(join(root, ".mstar", "status.json"))).toBe(false);
    });
  });

  test("fresh fence at the git top-level: subdir path arg scaffolds the repo-root .mstar (PR #147)", () => {
    withRoot((root) => {
      // Regression (PR #147): scaffolding a SUBDIRECTORY path used to compare
      // the harness dir against <subdir>/.mstar, skip the canonical fence and
      // leave status/plans/projects committable. Under the fixed-root contract
      // the harness dir is `<repoRoot>/.mstar`, and BOTH the comparison and the
      // fence target must anchor at the git top-level.
      gitInit(root);
      mkdirSync(join(root, "packages", "foo"), { recursive: true });

      // why: Spawned from a nested directory with the checkout root named: the
      // harness dir is `<repoRoot>/.mstar` and BOTH the comparison and the
      // fence target anchor at the git top-level.
      const result = runCli(["harness", "scaffold", root], { cwd: join(root, "packages", "foo") });
      expect(result.exitCode).toBe(0);
      const resultData = scaffoldData(result);
      expect(resultData.harnessDir).toBe(join(realpathSync(root), ".mstar"));
      expect(resultData.created).toContain(".gitignore (canonical harness snippet)");

      // Fence lands in the REPO-ROOT .gitignore, not the subdir's.
      expect(existsSync(join(root, ".gitignore"))).toBe(true);
      expect(existsSync(join(root, "packages", "foo", ".gitignore"))).toBe(false);
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      for (const entry of MSTAR_FENCE_ENTRIES) expect(gitignore).toContain(entry);
      // Harness files land under the repo-root .mstar/; no status.json exists.
      expect(existsSync(join(root, ".mstar", "status.json"))).toBe(false);

      // git check-ignore confirms the fence actually ignores process artifacts.
      const check = Bun.spawnSync(["git", "check-ignore", "-v", join(root, ".mstar", "status.json")], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(check.exitCode).toBe(0);
      expect(check.stdout.toString()).toContain(".mstar/");
    });
  });

  test("a leftover status.json is never consulted or rewritten (ACTIVE disposition)", () => {
    withRoot((root) => {
      expect(runScaffold([root]).exitCode).toBe(0);
      // ACTIVE disposition: the create-only status.json validation is retired
      // — the register lives in store.db once activated, so a leftover
      // pre-activation document is neither validated nor rewritten.
      writeFileSync(join(root, ".mstar", "status.json"), "{}\n", "utf8");

      const second = runScaffold([root]);
      expect(second.exitCode).toBe(0);
      expect(envelope(second).status).toBe("ok");
      expect(JSON.parse(readFileSync(join(root, ".mstar", "status.json"), "utf8"))).toEqual({});
      expect(scaffoldData(second).created).toEqual([]);
    });
  });
});
