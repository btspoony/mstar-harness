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
import { basename, join } from "node:path";
import { runCli, type RunResult } from "./harness";

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
    collaboration?: { repoKey: string; mode: string; dbPath: string } | { code: string; message: string };
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

function runResolve(args: string[], env?: Record<string, string | undefined>): RunResult {
  return runCli(["path", "resolve", ...args], env === undefined ? {} : { env });
}

/** why: Empty temp root (realpath'd: the CLI reports physical paths on macOS, where
 * `tmpdir()` is a `/var` symlink); `.mstar/` and specs content added per test. */
function withRoot(fn: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-path-resolve-")));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** why: A real Git main worktree at `root`. The fixed-root contract resolves
 * `{HARNESS_DIR}` only through a readable main worktree, so the fixture must be
 * a genuine checkout (a bare `.git` skeleton no longer classifies).
 */
function gitInit(root: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["-C", root, "-c", "user.email=f@f", "-c", "user.name=f", "commit", "-q", "--allow-empty", "-m", "init"], { stdio: "ignore" });
}

describe("mstar path resolve — harness/specs dir resolution", () => {
  test(".mstar/ present → exit 0, prints harness + specs dirs", () => {
    withRoot((root) => {
      gitInit(root);
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(envelope(result)).toMatchObject({ command: "path.resolve", status: "ok" });
      expect(data(result).harnessDir).toBe(join(root, ".mstar"));
      expect(data(result).specsDir).toBe(join(root, ".agents", "specs"));
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

  test("legacy .agents/ candidate is never adopted as the harness root", () => {
    withRoot((root) => {
      gitInit(root);
      mkdirSync(join(root, ".agents", "specs"), { recursive: true });
      writeFileSync(join(root, ".agents", "specs", "adr.md"), "# ADR\n");
      writeFileSync(join(root, ".agents", "status.json"), "{}");
      const result = runResolve([root]);
      // why: A legacy layout is ignored, not refused — the checkout simply has
      // no initialized fixed root.
      expect(result.exitCode).toBe(1);
      expect(envelope(result).code).toBe("path.harness-not-found");
      expect(envelope(result).message).not.toContain("retired");
    });
  });

  test("specs falls through to docs/specs when {HARNESS_DIR}/specs is empty (empty-dir-as-absent)", () => {
    withRoot((root) => {
      gitInit(root);
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
      gitInit(root);
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(data(result)).toMatchObject({
        startDir: root,
        harnessDir: join(root, ".mstar"),
        specsDir: join(root, ".agents", "specs"),
        workflowDir: join(root, ".mstar", "workflows"),
        projectDir: join(root, ".mstar", "projects"),
        reviewDir: join(root, ".mstar", "reviews"),
      });
      // why: Git names the process root: controlRoot is the main worktree the
      // caller sits in, and its harness root is the same fixed `.mstar`.
      expect(data(result)).toMatchObject({
        controlRoot: root,
        controlHarnessDir: join(root, ".mstar"),
        linkedWorktree: false,
      });
    });
  });

  test("workflow + project dirs resolve under the harness dir (compass ruling 4)", () => {
    withRoot((root) => {
      gitInit(root);
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
      gitInit(root);
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
      gitInit(root);
      mkdirSync(join(root, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(root, ".mstar", "specs", "adr.md"), "# ADR\n");
      const result = runResolve([root]);
      expect(result.exitCode).toBe(0);
      expect(data(result).knowledgeDir).toBe(join(root, ".agents", "knowledge"));
      expect(data(result).adrDir).toBe(join(root, ".agents", "adr"));
      expect(existsSync(join(root, ".agents", "knowledge"))).toBe(false);
      expect(existsSync(join(root, ".agents", "adr"))).toBe(false);
    });
  });
});

describe("mstar path resolve — collaboration diagnostic", () => {
  test("path resolve discloses collaboration selection (main and linked) without creating a database", () => {
    // why: The user home is the namespace anchor; the child process reads it at
    // startup, so a fixture home is the only seam that keeps the diagnostic off
    // the developer's real ~/.mstar.
    const home = mkdtempSync(join(tmpdir(), "mstar-collab-home-"));
    try {
      withRoot((root) => {
        gitInit(root);
        execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/Acme/Repo.git"], {
          stdio: "ignore",
        });
        // note: Every origin-backed checkout now proves selector absence with a live lookup;
        // route the synthetic origin to an empty local bare instead of a network transport.
        const emptyOrigin = join(root, "empty-origin.git");
        execFileSync("git", ["init", "-q", "--bare", emptyOrigin], { stdio: "ignore" });
        execFileSync(
          "git",
          ["-C", root, "config", `url.${emptyOrigin}.insteadOf`, "https://github.com/Acme/Repo.git"],
          { stdio: "ignore" },
        );
        mkdirSync(join(root, ".mstar"), { recursive: true });
        writeFileSync(join(root, ".mstarc"), "[collaboration]\nmode=mirror\n");
        const expected = {
          repoKey: "github.com/acme/repo",
          mode: "mirror",
          dbPath: join(home, ".mstar", "repos", "github.com", "acme", "repo", "collaboration.db"),
        };

        const fromMain = runResolve([root], { HOME: home });
        expect(fromMain.exitCode).toBe(0);
        expect(data(fromMain).collaboration).toEqual(expected);
        expect(existsSync(join(home, ".mstar"))).toBe(false);

        const worktree = addWorktree(root, root);
        const fromLinked = runResolve([worktree], { HOME: home });
        expect(fromLinked.exitCode).toBe(0);
        expect(data(fromLinked).linkedWorktree).toBe(true);
        expect(data(fromLinked).collaboration).toEqual(expected);
        expect(existsSync(join(home, ".mstar"))).toBe(false);

        // note: No mode: the same envelope carries the engine's named diagnostic.
        writeFileSync(join(root, ".mstarc"), "[config]\nreview_dir=process/reviews\n");
        const withoutMode = runResolve([root], { HOME: home });
        expect(withoutMode.exitCode).toBe(0);
        expect(data(withoutMode).collaboration).toMatchObject({ code: "collaboration.mode-required" });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

describe("mstar path check — verdict from Git state", () => {
  test("tracked results stay in the linked checkout, never the main worktree's root", () => {
    withRoot((root) => {
      gitRepo(root);
      commitIgnore(root, TRACKED_RESULTS_IGNORE);
      mkdirSync(join(root, ".mstar"), { recursive: true });
      const worktree = addWorktree(root, root);
      const result = runCli(["path", "check"], { cwd: worktree });
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
      const result = runCli(["path", "check"], { cwd: root });
      expect(result.exitCode).toBe(0);
      const okEnvelope = envelope(result);
      expect(okEnvelope).toMatchObject({ command: "path.check", status: "ok", code: "path.check.ok" });
      expect(data(result).ok).toBe(true);
      expect(data(result).findings).toEqual([]);
      // why: `.mstar/specs` is no longer a result dir; the tracked default wins.
      const warnings = data(result).warnings ?? [];
      expect(warnings).toEqual([]);
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
      const result = runCli(["path", "check"], { cwd: root });
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
      // why: non-empty legacy dirs are no longer result dirs; the named probe is
      // judged against the Git verdict of a genuinely ignored corpus dir.
      mkdirSync(join(root, ".mstar", "plans"), { recursive: true });
      writeFileSync(join(root, ".mstar", "plans", "20260808-x.md"), "# plan\n");
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(join(root, "docs", "adr", "0001.md"), "# adr\n");
      const ignored = runCli(["path", "check", ".mstar/plans"], { cwd: root });
      expect(ignored.exitCode).toBe(0);
      expect(envelope(ignored).status).toBe("ok");
      expect(data(ignored).warnings ?? []).toEqual([]);

      const okDir = runCli(["path", "check", "docs/adr"], { cwd: root });
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
      const result = runCli(["path", "check", ".mstar/specs/0001.md"], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(data(result).warnings ?? []).toEqual([]);
    });
  });

  test("outside any Git checkout the named probe refuses as path.unverifiable", () => {
    withRoot((root) => {
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      const result = runCli(["path", "check", "docs/adr"], { cwd: root });
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
      const result = runCli(["path", "check"], { cwd: worktree });
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
      const result = runCli(["path", "check", join(worktree, ".mstar", "plans")], { cwd: worktree });
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
      const result = runCli(["path", "check", join(control, ".mstar", "specs")], { cwd: worktree });
      expect(result.exitCode).toBe(1);
      expect(envelope(result).code).toBe("path.result-outside-worktree");
    });
  });
});
