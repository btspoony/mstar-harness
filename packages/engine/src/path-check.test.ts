/**
 * Engine path-ownership probe — real `git init` fixtures and real Git probes,
 * no mocks. The facts are Git's (`rev-parse --show-toplevel` +
 * `check-ignore`), so the verdicts are true only against a real repository:
 * `.gitignore` patterns, a linked checkout, and a not-yet-existing path.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPathOwnership, expectForPath, probePathOwnership } from "./path-check.js";

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

/** A linked checkout of `repo` (the "non-control" half of the probe). */
function linkedWorktree(root: string, repo: string): string {
  const path = join(root, "wt-feat");
  git(["worktree", "add", "-q", "-b", "feat", path], repo);
  return path;
}

/**
 * Repo whose COMMITTED ignore policy keeps `.mstar/specs` committable, plus a
 * linked checkout — the two-domain fixture. A linked checkout only sees the
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

describe("probePathOwnership \u2014 tracked results", () => {
  test("a tracked, non-ignored result dir is owned as expected", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/**\n!.mstar/specs/\n!.mstar/specs/**\n");
      mkdirSync(join(repo, ".mstar", "specs"), { recursive: true });
      const probe = probePathOwnership({ path: join(repo, ".mstar", "specs"), expect: "tracked" }, realpathSync(repo));
      expect(probe.ignored).toBe(false);
      expect(probe.checkoutRoot).toBe(realpathSync(repo));
      expect(probe.code).toBeNull();
      expect(probe.severity).toBeNull();
    });
  });

  test("an ignored result dir refuses as path.result-ignored and names the .mstarc / .agents recovery", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/\n");
      mkdirSync(join(repo, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(repo, ".mstar", "specs", "spec.md"), "# spec\n");
      const probe = probePathOwnership({ path: join(repo, ".mstar", "specs"), expect: "tracked" }, realpathSync(repo));
      expect(probe.ignored).toBe(true);
      expect(probe.code).toBe("path.result-ignored");
      expect(probe.severity).toBe("high");
      expect(probe.fix).toContain(".mstarc");
      expect(probe.fix).toContain(".agents");
    });
  });

  test("a not-yet-existing result dir still answers the ignore verdict", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/\n");
      // No `.mstar` on disk: the probe path is a file inside the missing dir.
      const probe = probePathOwnership({ path: join(repo, ".mstar", "adr"), expect: "tracked" }, realpathSync(repo));
      expect(probe.ignored).toBe(true);
      expect(probe.code).toBe("path.result-ignored");
    });
  });

  test("an ignored FILE under the result dir is refused the same way", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/\n");
      mkdirSync(join(repo, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(repo, ".mstar", "specs", "0001.md"), "# spec\n");
      const probe = probePathOwnership({ path: join(repo, ".mstar", "specs", "0001.md"), expect: "tracked" }, realpathSync(repo));
      expect(probe.ignored).toBe(true);
      expect(probe.code).toBe("path.result-ignored");
    });
  });

  test("a tracked result in the caller's own checkout is owned", () => {
    withRoot((root) => {
      const { repo, worktree } = trackedRepo(root);
      mkdirSync(join(worktree, ".mstar", "specs"), { recursive: true });
      writeFileSync(join(worktree, ".mstar", "specs", "0001.md"), "# spec\n");
      const probe = probePathOwnership(
        { path: join(worktree, ".mstar", "specs"), expect: "tracked" },
        realpathSync(repo),
        realpathSync(worktree),
      );
      expect(probe.ignored).toBe(false);
      expect(probe.checkoutRoot).toBe(realpathSync(worktree));
      expect(probe.code).toBeNull();
    });
  });

  test("a tracked result in the control checkout refuses when the caller works in a linked checkout", () => {
    withRoot((root) => {
      const { repo, worktree } = trackedRepo(root);
      // The same tracked path exists only in the control checkout.
      mkdirSync(join(repo, ".mstar", "specs"), { recursive: true });
      const probe = probePathOwnership(
        { path: join(repo, ".mstar", "specs"), expect: "tracked" },
        realpathSync(repo),
        realpathSync(worktree),
      );
      expect(probe.ignored).toBe(false);
      expect(probe.checkoutRoot).toBe(realpathSync(repo));
      expect(probe.code).toBe("path.result-outside-worktree");
      expect(probe.severity).toBe("high");
      expect(probe.message).toContain(realpathSync(worktree));
      expect(probe.message).toContain(realpathSync(repo));
      expect(probe.fix).toContain("work/integration worktree");
    });
  });
});

describe("probePathOwnership \u2014 process state", () => {
  test("ignored process state in a checkout that is not the control root refuses as path.process-outside-control", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      // The ignore rules must be committed: a linked checkout only sees the
      // tracked `.gitignore` of the commit it was added from.
      writeFileSync(join(repo, ".gitignore"), ".mstar/\n");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "ignore"], repo);
      const worktree = linkedWorktree(root, repo);
      mkdirSync(join(worktree, ".mstar", "plans"), { recursive: true });
      const probe = probePathOwnership({ path: join(worktree, ".mstar", "plans"), expect: "process" }, realpathSync(repo));
      expect(probe.ignored).toBe(true);
      expect(probe.checkoutRoot).toBe(realpathSync(worktree));
      expect(probe.code).toBe("path.process-outside-control");
      expect(probe.severity).toBe("high");
      expect(probe.message).toContain(realpathSync(repo));
    });
  });

  test("ignored process state in the control checkout is owned as expected", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/\n");
      mkdirSync(join(repo, ".mstar", "iterations"), { recursive: true });
      const probe = probePathOwnership({ path: join(repo, ".mstar", "iterations"), expect: "process" }, realpathSync(repo));
      expect(probe.ignored).toBe(true);
      expect(probe.code).toBeNull();
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
      const inControl = probePathOwnership({ path: join(repo, ".mstar", "plans"), expect: "process" }, null);
      expect(inControl.controlRoot).toBe(realpathSync(repo));
      expect(inControl.code).toBeNull();

      const inLinked = probePathOwnership({ path: join(worktree, ".mstar", "plans"), expect: "process" }, null);
      expect(inLinked.controlRoot).toBe(realpathSync(repo));
      expect(inLinked.code).toBe("path.process-outside-control");
    });
  });
});

describe("probePathOwnership \u2014 unverifiable", () => {
  test("a path outside any Git checkout is path.unverifiable, never silently ok", () => {
    withRoot((root) => {
      const probe = probePathOwnership({ path: join(root, "docs", "adr"), expect: "tracked" }, null);
      expect(probe.checkoutRoot).toBeNull();
      expect(probe.ignored).toBeNull();
      expect(probe.code).toBe("path.unverifiable");
      expect(probe.severity).toBe("medium");
      expect(probe.fix).toContain("mstar path check");
    });
  });
});

describe("checkPathOwnership / expectForPath \u2014 layout classification", () => {
  test("the layout check reports only the failing targets, in order", () => {
    withRoot((root) => {
      const repo = gitRepo(root);
      writeFileSync(join(repo, ".gitignore"), ".mstar/**\n!.mstar/specs/\n!.mstar/specs/**\n.mstar/plans/\n");
      mkdirSync(join(repo, ".mstar", "specs"), { recursive: true });
      const controlRoot = realpathSync(repo);
      const clean = checkPathOwnership(
        [
          { path: join(repo, ".mstar", "specs"), expect: "tracked" },
          { path: join(repo, ".mstar", "plans"), expect: "process" },
        ],
        controlRoot,
      );
      expect(clean.ok).toBe(true);
      expect(clean.findings).toEqual([]);

      const dirty = checkPathOwnership(
        [
          { path: join(repo, ".mstar", "plans"), expect: "process" },
          { path: join(repo, ".mstar", "specs"), expect: "process" },
          { path: join(repo, ".mstar", "knowledge"), expect: "tracked" },
        ],
        controlRoot,
      );
      expect(dirty.ok).toBe(false);
      expect(dirty.findings.map((finding) => finding.code)).toEqual(["path.result-ignored"]);
      expect(dirty.findings[0]?.path).toBe(join(repo, ".mstar", "knowledge"));
    });
  });

  test("a caller-named path is classified against the resolved tracked dirs", () => {
    const harness = "/repo/.mstar";
    const tracked = [`${harness}/specs`, `${harness}/knowledge`, `${harness}/adr`];
    expect(expectForPath(`${harness}/specs`, tracked)).toBe("tracked");
    expect(expectForPath(`${harness}/specs/nested/spec.md`, tracked)).toBe("tracked");
    expect(expectForPath(`${harness}/adr/0001.md`, tracked)).toBe("tracked");
    expect(expectForPath(`${harness}/plans/p.md`, tracked)).toBe("process");
    // A sibling sharing the name prefix is not contained.
    expect(expectForPath(`${harness}/specs-old/x.md`, tracked)).toBe("process");
  });

  test("a result-named path stays a result even when the layout points elsewhere", () => {
    // Linked checkout: the resolved result dirs live at the control harness,
    // but a result-named directory in this checkout is still a result.
    expect(expectForPath("/wt/.mstar/specs", ["/control/.mstar/specs"])).toBe("tracked");
    expect(expectForPath("/wt/.mstar/specs/0001.md", ["/control/.mstar/specs"])).toBe("tracked");
    expect(expectForPath("/wt/.mstar/knowledge/db.md", [])).toBe("tracked");
    expect(expectForPath("/wt/.mstar/plans/p.md", [])).toBe("process");
  });
});
