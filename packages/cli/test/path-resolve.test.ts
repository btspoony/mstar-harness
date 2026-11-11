/**
 * CLI `mstar path resolve` — {HARNESS_DIR} + {SPECS_DIR} + {WORKFLOW_DIR} +
 * {PROJECT_DIR} resolution wrapper.
 *
 * Thin wrapper over engine `path.resolveHarnessDir` + `path.resolveSpecsDir`
 * + `path.resolveWorkflowDir` + `path.resolveProjectDir`
 * (plan-conventions § 路径符号 / § {HARNESS_DIR} 解析顺序 / § {SPECS_DIR} 解析;
 * compass ruling 4 — the v3 workflow/project dirs join the path-symbol SSOT):
 * - Exit 0 returns resolved directories in a structured CLI envelope.
 * - Refusal with guidance when no harness dir resolves from the start dir.
 * - Specs resolution is read-only: `mstar path resolve` never creates the
 *   `<repoRoot>/.agents/specs/` fallback as a side effect.
 *
 * Each case runs the real CLI as a subprocess against a temp fixture tree.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface PathEnvelope {
  command: string;
  status: "ok" | "refused" | "usage" | "error";
  code: string;
  message?: string;
  recovery?: string;
  details?: Record<string, unknown>;
  data?: {
    startDir: string;
    harnessDir: string | null;
    specsDir: string | null;
    workflowDir: string;
    projectDir: string;
    knowledgeDir?: string | null;
    adrDir?: string | null;
    trackedHarness?: string | null;
    processHarness?: string | null;
    callerCheckoutRoot?: string | null;
    ok?: boolean;
    findings?: Array<{ path: string; expect?: string; code: string; severity: string; message: string }>;
    warnings?: Array<{ path: string; code: string; severity: string; message: string }>;
    checked?: Array<{ path: string; result?: boolean; kind?: "directory" | "file" }>;
  };
}

function envelope(result: RunResult): PathEnvelope {
  return JSON.parse(result.stdout) as PathEnvelope;
}

function data(result: RunResult): NonNullable<PathEnvelope["data"]> {
  const value = envelope(result).data;
  if (!value) throw new Error("expected path resolution data");
  return value;
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

function runResolve(args: string[]): RunResult {
  return runCli(["path", "resolve", ...args]);
}

/** Run an arbitrary CLI verb; `cwd` is the directory the caller stands in. */
function runCli(args: string[], cwd: string = CLI_ROOT, env: Record<string, string> = cliEnv()): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", join(CLI_ROOT, "src", "index.ts"), ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Empty temp root; `.mstar/` and specs content added per test. */
function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mstar-path-resolve-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Minimal valid git work tree (no `git init` subprocess): the engine's
 * default CLI boundary runs `git rev-parse --show-cdup`, which only needs a
 * valid `.git` layout (HEAD + config + objects/ + refs/) — no commits.
 * Mirrors the engine path.test.ts `gitInit` fixture.
 */
function gitInit(root: string): void {
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  mkdirSync(join(root, ".git", "refs"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
}

describe("mstar path resolve — harness/specs dir resolution", () => {
  test(".mstar/ present → exit 0, prints harness + specs dirs", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(envelope(result)).toMatchObject({ command: "path.resolve", status: "ok" });
      expect(data(result).harnessDir).toBe(join(root, ".mstar"));
      expect(data(result).specsDir).toBe(join(root, ".mstar", "specs"));
    });
  });

  test("resolves upward from a nested start dir inside a git top-level (explicit [path] arg)", () => {
    withRoot((root) => {
      // Real git repo fixture: default boundary = git top-level of the start
      // dir, so a harness at the repo root resolves from a nested subdir.
      gitInit(root);
      mkdirSync(join(root, ".mstar"), { recursive: true });
      mkdirSync(join(root, "nested", "deep"), { recursive: true });
      const result = runResolve([join(root, "nested", "deep")]);
      expect(result.exitCode).toBe(0);
      expect(data(result).harnessDir).toBe(join(root, ".mstar"));
    });
  });

  test("harness only above the git top-level (global ~/.mstar collision) → exit 1", () => {
    withRoot((root) => {
      // `.mstar` sits one level ABOVE the git top-level (`root/proj`) — the
      // engine boundary must stop the probe at the repo root and never return
      // it (all-temp fixture; never touches the real ~/.mstar).
      gitInit(join(root, "proj"));
      mkdirSync(join(root, ".mstar"), { recursive: true });
      mkdirSync(join(root, "proj", "nested", "deep"), { recursive: true });
      const result = runResolve([join(root, "proj", "nested", "deep")]);
      expect(envelope(result).status).toBe("refused");
      expect(envelope(result).message).toContain("no harness dir");
    });
  });

  test("non-git start probes only itself — no walk-up to a parent harness", () => {
    withRoot((root) => {
      // Non-git temp tree: default boundary = the start dir itself, so a
      // harness one level up is never probed (deliberate tightening).
      mkdirSync(join(root, ".mstar"), { recursive: true });
      mkdirSync(join(root, "nested", "deep"), { recursive: true });
      const result = runResolve([join(root, "nested", "deep")]);
      expect(envelope(result).status).toBe("refused");
      expect(envelope(result).message).toContain("no harness dir");
    });
  });

  test("legacy .agents/ harness resolves when .mstar/ absent", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".agents", "specs"), { recursive: true });
      writeFileSync(join(root, ".agents", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(data(result).harnessDir).toBe(join(root, ".agents"));
    });
  });

  test("specs falls through to docs/specs when {HARNESS_DIR}/specs is empty (empty-dir-as-absent)", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true }); // empty
      mkdirSync(join(root, "docs", "specs"), { recursive: true });
      writeFileSync(join(root, "docs", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(data(result).harnessDir).toBe(join(root, ".mstar"));
      expect(data(result).specsDir).toBe(join(root, "docs", "specs"));
    });
  });

  test("no harness anywhere → exit 1 with bootstrap guidance on stderr", () => {
    withRoot((root) => {
      const result = runResolve([root]);
      expect(envelope(result).status).toBe("refused");
      expect(envelope(result).message).toContain("no harness dir");
    });
  });

  test("success returns structured harness, specs, workflow, project and review directories", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(data(result)).toMatchObject({
        startDir: root,
        harnessDir: join(root, ".mstar"),
        specsDir: join(root, ".mstar", "specs"),
        workflowDir: join(root, ".mstar", "workflows"),
        projectDir: join(root, ".mstar", "projects"),
        reviewDir: join(root, ".mstar", "reviews"),
      });
      // Outside Git there is no process root: controlRoot stays null, and the
      // control harness falls back to the same local probe (never a guess).
      expect(data(result)).toMatchObject({
        controlRoot: null,
        controlHarnessDir: join(root, ".mstar"),
        linkedWorktree: false,
      });
    });
  });

  test("workflow + project dirs resolve under the harness dir (compass ruling 4)", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(data(result).workflowDir).toBe(join(root, ".mstar", "workflows"));
      expect(data(result).projectDir).toBe(join(root, ".mstar", "projects"));
    });
  });

  test("no harness returns a refusal envelope with bootstrap guidance", () => {
    withRoot((root) => {
      const result = runResolve([root]);
      expect(result.exitCode).toBe(1);
      expect(envelope(result).status).toBe("refused");
    });
  });

  test("read-only: resolve never creates the .agents fallback when every candidate is absent", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar"), { recursive: true });
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      // Engine default would create the fallback; the CLI opts out.
      expect(existsSync(join(root, ".agents", "specs"))).toBe(false);
      expect(data(result).specsDir).toBe(join(root, ".agents", "specs"));
    });
  });

  test("resolve reports knowledgeDir and adrDir without creating them", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "spec.md"), "# spec\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(data(result).knowledgeDir).toBe(join(root, ".agents", "knowledge"));
      expect(data(result).adrDir).toBe(join(root, ".agents", "adr"));
      expect(existsSync(join(root, ".agents", "knowledge"))).toBe(false);
      expect(existsSync(join(root, ".agents", "adr"))).toBe(false);
    });
  });
});

/** Real `git init`: `check-ignore` needs a repository, unlike the resolve probes. */
function gitRepo(root: string): void {
  execFileSync("git", ["init", "-q", root], { stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["-C", root, "config", "user.email", "path-check-test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Path Check Test"], { stdio: "ignore" });
}

/** Commit `content` as `.gitignore`: a linked checkout only sees committed rules. */
function commitIgnore(repo: string, content: string): void {
  writeFileSync(join(repo, ".gitignore"), content);
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "ignore"], { stdio: "ignore" });
}

/** A real linked checkout of `repo`. */
function addWorktree(root: string, repo: string): string {
  const worktree = join(root, "wt");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "feat", worktree], { stdio: "ignore" });
  return worktree;
}

/** The `.gitignore` that re-includes the tracked results of a `.mstar/` harness. */
const TRACKED_RESULTS_IGNORE = [
  ".mstar/**",
  "!.mstar/specs/",
  "!.mstar/specs/**",
  "!.mstar/knowledge/",
  "!.mstar/knowledge/**",
  "!.mstar/adr/",
  "!.mstar/adr/**",
  "",
].join("\n");

describe("mstar path check \u2014 verdict from Git state", () => {
  test("a control harness environment override keeps tracked results in the linked checkout", () => {
    withRoot((root) => {
      gitRepo(root);
      commitIgnore(root, TRACKED_RESULTS_IGNORE);
      mkdirSync(join(root, ".mstar"), { recursive: true });
      const worktree = addWorktree(root, root);
      const result = runCli(["path", "check"], worktree, { ...cliEnv(), MSTAR_HARNESS_DIR: join(root, ".mstar") });
      expect(result.exitCode).toBe(0);
      expect(data(result).trackedHarness).toBe(join(realpathSync(worktree), ".mstar"));
      expect(data(result).specsDir).toBe(join(realpathSync(worktree), ".agents", "specs"));
      expect(data(result).knowledgeDir).toBe(join(realpathSync(worktree), ".agents", "knowledge"));
    });
  });

  test("an ignored result dir in the control checkout exits 0 with a path.result-ignored warning", () => {
    withRoot((root) => {
      gitRepo(root);
      writeFileSync(join(root, ".gitignore"), ".mstar/\n");
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "spec.md"), "# spec\n");
      const result = runCli(["path", "check"], root);
      expect(result.exitCode).toBe(0);
      const okEnvelope = envelope(result);
      expect(okEnvelope).toMatchObject({ command: "path.check", status: "ok", code: "path.check.ok" });
      expect(data(result).ok).toBe(true);
      expect(data(result).findings).toEqual([]);
      // The layout resolver answers canonical (realpath'd) directories.
      const warnings = data(result).warnings ?? [];
      // Only the legacy read rung resolves under `{HARNESS_DIR}` now; knowledge
      // and adr default to the tracked `.agents/` tree and are never ignored.
      expect(warnings.map((warning) => warning.path)).toEqual([join(realpathSync(root), ".mstar", "specs")]);
      expect(warnings.every((warning) => warning.code === "path.result-ignored")).toBe(true);
      expect(warnings[0]?.message).toContain("never be committed or shared");
    });
  });

  test("a re-included result dir is clean with no warning (exit 0)", () => {
    withRoot((root) => {
      gitRepo(root);
      writeFileSync(join(root, ".gitignore"), TRACKED_RESULTS_IGNORE);
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "spec.md"), "# spec\n");
      mkdirSync(join(root, ".mstar", "knowledge"), { recursive: true });
      writeFileSync(join(root, ".mstar", "knowledge", "kb.md"), "# kb\n");
      mkdirSync(join(root, ".mstar", "adr"), { recursive: true });
      writeFileSync(join(root, ".mstar", "adr", "0001.md"), "# adr\n");
      const result = runCli(["path", "check"], root);
      expect(result.exitCode).toBe(0);
      expect(data(result).ok).toBe(true);
      expect(data(result).findings).toEqual([]);
      expect(data(result).warnings).toEqual([]);
      // Process state is checked too — the store is the notable one.
      expect(data(result).checked?.some((target) => target.result === true)).toBe(true);
      expect(data(result).checked?.some((target) => target.result !== true)).toBe(true);
    });
  });

  test("an ignored named result dir warns without failing; a committable dir is clean", () => {
    withRoot((root) => {
      gitRepo(root);
      writeFileSync(join(root, ".gitignore"), ".mstar/\n");
      // Non-empty legacy dirs are the resolved result dirs (`mstarc` declares
      // none here), so the named probe is judged against their Git verdict.
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "spec.md"), "# spec\n");
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(join(root, "docs", "adr", "0001.md"), "# adr\n");
      const ignored = runCli(["path", "check", ".mstar/specs"], root);
      expect(ignored.exitCode).toBe(0);
      expect(envelope(ignored).status).toBe("ok");
      expect(data(ignored).warnings?.map((warning) => warning.code)).toEqual(["path.result-ignored"]);

      const okDir = runCli(["path", "check", "docs/adr"], root);
      expect(okDir.exitCode).toBe(0);
      expect(data(okDir).ok).toBe(true);
      expect(data(okDir).warnings).toEqual([]);
    });
  });

  test("an ignored file named inside {HARNESS_DIR}/specs still earns the warning", () => {
    withRoot((root) => {
      gitRepo(root);
      writeFileSync(join(root, ".gitignore"), ".mstar/\n");
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "0001.md"), "# spec\n");
      const result = runCli(["path", "check", ".mstar/specs/0001.md"], root);
      expect(result.exitCode).toBe(0);
      expect(data(result).warnings?.map((warning) => warning.path)).toEqual([realpathSync(join(root, ".mstar", "specs", "0001.md"))]);
    });
  });

  test("outside any Git checkout the named probe refuses as path.unverifiable", () => {
    withRoot((root) => {
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      const result = runCli(["path", "check", "docs/adr"], root);
      expect(result.exitCode).toBe(1);
      expect(envelope(result).code).toBe("path.unverifiable");
    });
  });

  test("in a linked checkout, ignored state is checked in the control root and results in the caller's checkout", () => {
    withRoot((root) => {
      const control = join(root, "control");
      mkdirSync(control);
      gitRepo(control);
      commitIgnore(control, TRACKED_RESULTS_IGNORE);
      const worktree = addWorktree(root, control);
      // The control harness owns ignored state, so it must exist.
      mkdirSync(join(control, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(control, ".mstar", "specs", "base.md"), "# spec\n");
      // Committable results live in the caller's checkout (the branch it carries).
      mkdirSync(join(worktree, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(worktree, ".mstar", "specs", "0001.md"), "# spec\n");
      const result = runCli(["path", "check"], worktree);
      expect(result.exitCode).toBe(0);
      expect(realpathSync(data(result).trackedHarness!)).toBe(realpathSync(join(worktree, ".mstar")));
      expect(realpathSync(data(result).processHarness!)).toBe(realpathSync(join(control, ".mstar")));
      expect(data(result).checked?.find((entry) => basename(entry.path) === "store.db")?.kind).toBe("file");
      expect(data(result).ok).toBe(true);
    });
  });

  test("an ignored process dir in a linked checkout refuses as path.process-outside-control", () => {
    withRoot((root) => {
      const control = join(root, "control");
      mkdirSync(control);
      gitRepo(control);
      commitIgnore(control, TRACKED_RESULTS_IGNORE);
      const worktree = addWorktree(root, control);
      mkdirSync(join(worktree, ".mstar", "plans"), { recursive: true });
      const result = runCli(["path", "check", join(worktree, ".mstar", "plans")], worktree);
      expect(result.exitCode).toBe(1);
      expect(envelope(result).code).toBe("path.process-outside-control");
    });
  });

  test("a committable result owned by the control checkout refuses when named from a linked checkout", () => {
    withRoot((root) => {
      const control = join(root, "control");
      mkdirSync(control);
      gitRepo(control);
      commitIgnore(control, TRACKED_RESULTS_IGNORE);
      const worktree = addWorktree(root, control);
      mkdirSync(join(control, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(control, ".mstar", "specs", "0001.md"), "# spec\n");
      const result = runCli(["path", "check", join(control, ".mstar", "specs")], worktree);
      expect(result.exitCode).toBe(1);
      expect(envelope(result).code).toBe("path.result-outside-worktree");
    });
  });
});
