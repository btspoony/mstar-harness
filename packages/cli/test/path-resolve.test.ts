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
 * - Specs resolution is read-only: `mstar path resolve` never creates
 *   `{HARNESS_DIR}/specs/` as a side effect.
 *
 * Each case runs the real CLI as a subprocess against a temp fixture tree.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
    findings?: Array<{ path: string; expect: string; code: string; severity: string; message: string }>;
    checked?: Array<{ path: string; expect: string }>;
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
function runCli(args: string[], cwd: string = CLI_ROOT): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", join(CLI_ROOT, "src", "index.ts"), ...args], {
    cwd,
    env: cliEnv(),
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

  test("read-only: resolve never creates {HARNESS_DIR}/specs when every candidate is absent", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar"), { recursive: true });
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      // Engine default would create the fallback; the CLI opts out.
      expect(existsSync(join(root, ".mstar", "specs"))).toBe(false);
      expect(data(result).specsDir).toBe(join(root, ".mstar", "specs"));
    });
  });

  test("resolve reports knowledgeDir and adrDir without creating them", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "spec.md"), "# spec\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(data(result).knowledgeDir).toBe(join(root, ".mstar", "knowledge"));
      expect(data(result).adrDir).toBe(join(root, ".mstar", "adr"));
      expect(existsSync(join(root, ".mstar", "knowledge"))).toBe(false);
      expect(existsSync(join(root, ".mstar", "adr"))).toBe(false);
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

describe("mstar path check — ownership of the resolved layout", () => {
  test("a fully gitignored `.mstar/` refuses with path.result-ignored and the .agents recovery", () => {
    withRoot((root) => {
      gitRepo(root);
      writeFileSync(join(root, ".gitignore"), ".mstar/\n");
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "spec.md"), "# spec\n");
      const result = runCli(["path", "check"], root);
      expect(result.exitCode).toBe(1);
      const refused = envelope(result);
      expect(refused.status).toBe("refused");
      expect(refused.code).toBe("path.result-ignored");
      const findings = refused.details?.findings as Array<{ code: string; path: string }>;
      // The layout resolver answers canonical (realpath'd) directories.
      expect(findings.map((finding) => finding.path)).toEqual([
        join(realpathSync(root), ".mstar", "specs"),
        join(realpathSync(root), ".mstar", "knowledge"),
        join(realpathSync(root), ".mstar", "adr"),
      ]);
      expect(findings.every((finding) => finding.code === "path.result-ignored")).toBe(true);
      // The recovery must name a command an operator can actually run.
      expect(String(refused.details?.recovery)).toContain("mstar path check");
      expect(refused.message).toContain("Git-ignored");
    });
  });

  test("re-included result dirs and ignored process dirs are clean (exit 0)", () => {
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
      expect(envelope(result)).toMatchObject({ command: "path.check", status: "ok", code: "path.check.ok" });
      expect(data(result).ok).toBe(true);
      expect(data(result).findings).toEqual([]);
      // Process state is checked too — the store is the notable one.
      expect(data(result).checked?.map((target) => target.expect)).toContain("process");
    });
  });

  test("a named tracked-result dir is refused, a named committable dir is ok", () => {
    withRoot((root) => {
      gitRepo(root);
      writeFileSync(join(root, ".gitignore"), ".mstar/\n");
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      const ignored = runCli(["path", "check", ".mstar/specs"], root);
      expect(ignored.exitCode).toBe(1);
      expect(envelope(ignored).code).toBe("path.result-ignored");

      const okDir = runCli(["path", "check", "docs/adr"], root);
      expect(okDir.exitCode).toBe(0);
      expect(data(okDir).ok).toBe(true);
    });
  });

  test("an ignored file named inside {HARNESS_DIR}/specs is still a tracked result", () => {
    withRoot((root) => {
      gitRepo(root);
      writeFileSync(join(root, ".gitignore"), ".mstar/\n");
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "0001.md"), "# spec\n");
      // The role comes from the resolved layout, not from the file's basename.
      const result = runCli(["path", "check", ".mstar/specs/0001.md"], root);
      expect(result.exitCode).toBe(1);
      expect(envelope(result).code).toBe("path.result-ignored");
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

  test("in a linked checkout, tracked results are checked in the caller's checkout and process state in the control root", () => {
    withRoot((root) => {
      const control = join(root, "control");
      mkdirSync(control);
      gitRepo(control);
      commitIgnore(control, TRACKED_RESULTS_IGNORE);
      const worktree = addWorktree(root, control);
      // The control harness owns process state, so it must exist.
      mkdirSync(join(control, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(control, ".mstar", "specs", "base.md"), "# spec\n");
      // Results live in the caller's checkout (the branch it carries).
      mkdirSync(join(worktree, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(worktree, ".mstar", "specs", "0001.md"), "# spec\n");
      const result = runCli(["path", "check"], worktree);
      expect(result.exitCode).toBe(0);
      expect(realpathSync(data(result).trackedHarness!)).toBe(realpathSync(join(worktree, ".mstar")));
      expect(realpathSync(data(result).processHarness!)).toBe(realpathSync(join(control, ".mstar")));
      expect(data(result).ok).toBe(true);
    });
  });

  test("a tracked path owned by the control checkout refuses when named from a linked checkout", () => {
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
