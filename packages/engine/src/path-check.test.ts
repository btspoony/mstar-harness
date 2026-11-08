/**
 * Engine path-ownership probe — real `git init` fixtures and real Git probes,
 * no mocks.
 *
 * The verdict is Git state, not directory names: an ignored path is wrong
 * outside the control checkout, a committable path is wrong outside the
 * caller's checkout. The caller's `result` marking only adds the non-blocking
 * ignored-result warning.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPathOwnership,
  isResultPath,
  pathOwnershipWarning,
  probePathOwnership,
} from "./path-check.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Init a git repo with one commit at `root/repo`; returns the repo path. */
function gitRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q"], repo);
  git(["config", "user.email", "path-check-test@example.com"], repo);
  git(["config", "user.name", "Path Check Test"], repo);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  return repo;
}

/** A linked checkout of `repo` (the "caller" half of the probe). */
function linkedWorktree(root: string, repo: string): string {
  const path = join(root, "wt-feat");
  git(["worktree", "add", "-q", "-b", "feat", path], repo);
  return path;
}

/**
 * Repo whose COMMITTED ignore policy keeps `.mstar/specs` committable, plus a
 * linked checkout — the two-checkout fixture. A linked checkout only sees the
 * ignore rules of the commit it was added from.
 */
function trackedRepo(root: string): { repo: string; worktree: string } {
  const repo = gitRepo(root);
  writeFileSync(join(repo, ".gitignore"), ".mstar/**\n!.mstar/specs/\n!.mstar/specs/**\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "ignore"], repo);
  return { repo, worktree: linkedWorktree(root, repo) };
}

function withRoot(fn: (root: string) => void): void {
  const root = tmpRoot("mstar-path-check-");
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("verdict \u2014 ignored state belongs to the control checkout", () => {
  test("an ignored result dir in the control checkout is clean and warns without failing", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/\n");
      mkdirSync(join(repo, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(repo, ".mstar", "specs", "spec.md"), "# spec\n");
      const probe = probePathOwnership({ path: join(repo, ".mstar", "specs"), result: true }, realpathSync(repo));
      expect(probe.ignored).toBe(true);
      expect(probe.code).toBeNull();

      const warning = pathOwnershipWarning(probe);
      expect(warning?.code).toBe("path.result-ignored");
      expect(warning?.severity).toBe("medium");
      expect(warning?.message).toContain("never be committed or shared");
      expect(warning?.fix).toContain(".agents/");
      expect(warning?.fix).toContain(".mstarc");
    });
  });

  test("the same ignored dir without the result marking is clean and silent", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/\n");
      mkdirSync(join(repo, ".mstar", "specs"), { recursive: true });
      const probe = probePathOwnership({ path: join(repo, ".mstar", "specs") }, realpathSync(repo));
      expect(probe.ignored).toBe(true);
      expect(probe.code).toBeNull();
      expect(pathOwnershipWarning(probe)).toBeNull();
    });
  });

  test("an ignored process dir in the control checkout is clean", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/\n");
      mkdirSync(join(repo, ".mstar", "plans"), { recursive: true });
      const probe = probePathOwnership({ path: join(repo, ".mstar", "plans") }, realpathSync(repo));
      expect(probe.ignored).toBe(true);
      expect(probe.code).toBeNull();
    });
  });

  test("an ignored path in a linked checkout refuses as path.process-outside-control", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "ignore"], repo);
      const worktree = linkedWorktree(root, repo);
      mkdirSync(join(worktree, ".mstar", "plans"), { recursive: true });
      const probe = probePathOwnership({ path: join(worktree, ".mstar", "plans") }, realpathSync(repo), realpathSync(worktree));
      expect(probe.ignored).toBe(true);
      expect(probe.checkoutRoot).toBe(realpathSync(worktree));
      expect(probe.code).toBe("path.process-outside-control");
      expect(probe.severity).toBe("high");
      expect(probe.message).toContain(realpathSync(repo));
    });
  });

  test("a not-yet-existing target still compares against the real main worktree", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "ignore"], repo);
      const worktree = linkedWorktree(root, repo);
      // No `.mstar` on disk and no caller-supplied control root: the probe
      // derives the main worktree from the target's own checkout.
      const inControl = probePathOwnership({ path: join(repo, ".mstar", "plans") }, null);
      expect(inControl.controlRoot).toBe(realpathSync(repo));
      expect(inControl.code).toBeNull();

      const inLinked = probePathOwnership({ path: join(worktree, ".mstar", "plans") }, null);
      expect(inLinked.controlRoot).toBe(realpathSync(repo));
      expect(inLinked.code).toBe("path.process-outside-control");
    });
  });
});

describe("verdict \u2014 committable state belongs to the caller's checkout", () => {
  test("a committable result dir in the caller's own checkout is clean", () => {
    withRoot((root) => {
      const { repo, worktree } = trackedRepo(root);
      mkdirSync(join(worktree, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(worktree, ".mstar", "specs", "0001.md"), "# spec\n");
      const probe = probePathOwnership(
        { path: join(worktree, ".mstar", "specs"), result: true },
        realpathSync(repo),
        realpathSync(worktree),
      );
      expect(probe.ignored).toBe(false);
      expect(probe.checkoutRoot).toBe(realpathSync(worktree));
      expect(probe.code).toBeNull();
      expect(pathOwnershipWarning(probe)).toBeNull();
    });
  });

  test("a committable result in the control checkout refuses as path.result-outside-worktree", () => {
    withRoot((root) => {
      const { repo, worktree } = trackedRepo(root);
      mkdirSync(join(repo, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(repo, ".mstar", "specs", "base.md"), "# spec\n");
      const probe = probePathOwnership(
        { path: join(repo, ".mstar", "specs"), result: true },
        realpathSync(repo),
        realpathSync(worktree),
      );
      expect(probe.ignored).toBe(false);
      expect(probe.code).toBe("path.result-outside-worktree");
      expect(probe.severity).toBe("high");
      expect(probe.message).toContain(realpathSync(repo));
      expect(probe.message).toContain(realpathSync(worktree));
      expect(probe.fix).toContain("work/integration worktree");
    });
  });

  test("names do not decide: a committable non-result path outside the caller checkout is refused too", () => {
    withRoot((root) => {
      const { repo, worktree } = trackedRepo(root);
      const probe = probePathOwnership({ path: join(repo, "README.md") }, realpathSync(repo), realpathSync(worktree));
      expect(probe.ignored).toBe(false);
      expect(probe.code).toBe("path.result-outside-worktree");
    });
  });
});

describe("verdict \u2014 unverifiable", () => {
  test("a path outside any Git checkout is path.unverifiable, never silently ok", () => {
    withRoot((root) => {
      const probe = probePathOwnership({ path: join(root, "docs", "adr") }, null);
      expect(probe.checkoutRoot).toBeNull();
      expect(probe.ignored).toBeNull();
      expect(probe.code).toBe("path.unverifiable");
      expect(probe.severity).toBe("medium");
      expect(probe.fix).toContain("mstar path check");
    });
  });
});

describe("checkPathOwnership / isResultPath", () => {
  test("findings fail the check; warnings ride along without failing it", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "ignore"], repo);
      const worktree = linkedWorktree(root, repo);
      mkdirSync(join(repo, ".mstar", "specs"), { recursive: true });
      mkdirSync(join(worktree, ".mstar", "plans"), { recursive: true });
      const controlRoot = realpathSync(repo);

      const clean = checkPathOwnership([{ path: join(repo, ".mstar", "specs"), result: true }], controlRoot, controlRoot);
      expect(clean.ok).toBe(true);
      expect(clean.findings).toEqual([]);
      expect(clean.warnings.map((warning) => warning.code)).toEqual(["path.result-ignored"]);

      const dirty = checkPathOwnership(
        [
          { path: join(repo, ".mstar", "specs"), result: true },
          { path: join(worktree, ".mstar", "plans") },
        ],
        controlRoot,
        realpathSync(worktree),
      );
      expect(dirty.ok).toBe(false);
      expect(dirty.findings.map((finding) => finding.code)).toEqual(["path.process-outside-control"]);
      // The clean-but-ignored result dir still reports its warning; only the
      // misplaced path fails the check.
      expect(dirty.warnings.map((warning) => warning.path)).toEqual([join(repo, ".mstar", "specs")]);
    });
  });

  test("isResultPath compares containment, not names", () => {
    const harness = "/repo/.mstar";
    const resultDirs = [`${harness}/specs`, `${harness}/knowledge`, `${harness}/adr`];
    expect(isResultPath(`${harness}/specs`, resultDirs)).toBe(true);
    expect(isResultPath(`${harness}/specs/nested/spec.md`, resultDirs)).toBe(true);
    expect(isResultPath(`${harness}/adr/0001.md`, resultDirs)).toBe(true);
    expect(isResultPath(`${harness}/plans/p.md`, resultDirs)).toBe(false);
    // A sibling sharing the name prefix is not contained.
    expect(isResultPath(`${harness}/specs-old/x.md`, resultDirs)).toBe(false);
    // Outside the resolved layout a result-looking name is not a result.
    expect(isResultPath("/wt/.mstar/specs", resultDirs)).toBe(false);
  });
});
