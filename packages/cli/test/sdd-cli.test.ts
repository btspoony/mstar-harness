/**
 * CLI `mstar sdd workspace|task-brief|review-package` — engine-backed
 * wrappers with ported exit codes.
 *
 * Each case runs the real CLI as a subprocess against temp fixtures
 * (sample plan file; temp git repos incl. a linked worktree for the
 * fail-closed guard). Exit codes follow the ported engine contracts via
 * `SddScriptError`:
 * - `workspace`: 1 = resolution failure (linked worktree w/o control root,
 *   bad CONTROL_ROOT), 2 = usage.
 * - `task-brief`: 2 = usage / missing plan file / missing SDD_DIR, 3 = task
 *   N not found in the plan.
 * - `review-package`: 2 = bad BASE/HEAD ref / missing SDD_DIR.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

/** Sample plan mirroring the engine fixture: fenced fake headings + real ones. */
const SAMPLE_PLAN = `# Fixture Plan

## Goal

Extract per-task briefs (engine taskBrief).

### Task 1: first task

- [ ] step one

\`\`\`text
## Task 2: hidden behind a fence

This block must not be treated as the Task 2 heading.
\`\`\`

### Task 2: second task

- [ ] step three
- [ ] step four

### Task 3: third task

- [ ] step five
`;

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn env with ambient harness env vars pinned out (qc3 F-4): the CLI
 * resolves harness dirs from MSTAR_HARNESS_DIR / MSTAR_CONTROL_ROOT ahead
 * of probing (an ambient value would redirect every fixture to the env dir
 * and fail spuriously), and SDD_DIR redirects default outfile paths.
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Run the real CLI entry as a subprocess; cwd + env overrides per test. */
function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: opts.cwd ?? CLI_ROOT,
    env: { ...cliEnv(), ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Create a git repo at `root` with commits A (base) and B (head). */
function gitFixture(root: string): { base: string; head: string } {
  git(["init", "-q"], root);
  git(["config", "user.email", "sdd-cli-test@example.com"], root);
  git(["config", "user.name", "SDD CLI Test"], root);
  writeFileSync(join(root, "file1.txt"), "line one\nline two\nline three\nline four\nline five\nline six\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base commit"], root);
  const base = git(["rev-parse", "HEAD"], root);
  writeFileSync(join(root, "file2.txt"), "new file\n");
  writeFileSync(join(root, "file1.txt"), "line one\nline two\nline three\nCHANGED line four\nline five\nline six\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "head commit"], root);
  const head = git(["rev-parse", "HEAD"], root);
  return { base, head };
}

/** Create a git repo at `root` + a linked worktree at `root/linked` (branch `feature/linked`). */
function linkedWorktreeFixture(root: string): string {
  git(["init", "-q"], root);
  git(["config", "user.email", "sdd-cli-test@example.com"], root);
  git(["config", "user.name", "SDD CLI Test"], root);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base commit"], root);
  // Inside the tmp root so the caller's single rmSync(root) cleans it up
  // (qc3 S-3: a sibling dir outside the tmp root leaked on every run).
  const linked = join(root, "linked");
  git(["worktree", "add", "-q", linked, "-b", "feature/linked"], root);
  return linked;
}

describe("mstar sdd workspace — resolve/ensure {SDD_DIR}", () => {
  test("MSTAR_HARNESS_DIR override from a plain dir → exit 0, prints + creates SDD dir", () => {
    const root = tmpRoot("mstar-sdd-ws-");
    try {
      const harnessDir = join(root, ".harness");
      const result = runCli(["sdd", "workspace", "plan-1"], {
        cwd: root,
        env: { MSTAR_HARNESS_DIR: harnessDir },
      });
      expect(result.exitCode).toBe(0);
      // engine returns the physical path (macOS /var → /private/var symlink).
      const expected = realpathSync(join(harnessDir, "sdd", "plan-1"));
      expect(result.stdout).toContain(`sdd dir: ${expected}`);
      expect(result.stderr).toBe("");
      expect(existsSync(expected)).toBe(true);
      expect(readFileSync(join(expected, ".gitignore"), "utf8")).toBe("*\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("linked worktree without control root fails closed (exit 1, second SDD tree refused)", () => {
    const root = tmpRoot("mstar-sdd-ws-main-");
    try {
      const linked = linkedWorktreeFixture(root);
      const result = runCli(["sdd", "workspace", "plan-1"], { cwd: linked });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("linked worktree");
      expect(result.stderr).toContain("Refusing to create a second SDD tree");
      expect(result.stderr).toContain("MSTAR_CONTROL_ROOT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("linked worktree + CONTROL_ROOT + MSTAR_HARNESS_DIR → exit 0, SDD dir under control root", () => {
    const root = tmpRoot("mstar-sdd-ws-ctrl-");
    try {
      const linked = linkedWorktreeFixture(root);
      const harnessDir = join(root, ".harness");
      const result = runCli(["sdd", "workspace", "plan-1", root], {
        cwd: linked,
        env: { MSTAR_HARNESS_DIR: harnessDir },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`sdd dir: ${realpathSync(join(harnessDir, "sdd", "plan-1"))}`);
      expect(existsSync(join(harnessDir, "sdd", "plan-1"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CONTROL_ROOT that is not a directory → exit 1 with engine message", () => {
    const root = tmpRoot("mstar-sdd-ws-bad-");
    try {
      const result = runCli(["sdd", "workspace", "plan-1", join(root, "nope")], { cwd: root });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("CONTROL_ROOT");
      expect(result.stderr).toContain("not a directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing <plan-id> → exit 2 usage error (qc2 F-005: commander must not bypass the ported exit-2 usage contract)", () => {
    const root = tmpRoot("mstar-sdd-ws-usage-");
    try {
      const result = runCli(["sdd", "workspace"], { cwd: root });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage: mstar sdd workspace");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mstar sdd task-brief — extract `## Task N` sections", () => {
  test("existing task → exit 0, outfile holds the section (fenced fake headings ignored)", () => {
    const root = tmpRoot("mstar-sdd-brief-");
    try {
      const planFile = join(root, "plan.md");
      writeFileSync(planFile, SAMPLE_PLAN);
      const outfile = join(root, "task-2-brief.md");
      const result = runCli(["sdd", "task-brief", planFile, "2", outfile]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`task 2 brief: ${outfile}`);
      const content = readFileSync(outfile, "utf8");
      expect(content).toContain("### Task 2: second task");
      expect(content).toContain("- [ ] step three");
      expect(content).toContain("- [ ] step four");
      expect(content).not.toContain("### Task 3");
      expect(content).not.toContain("hidden behind a fence");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing task N → exit 3 with empty outfile", () => {
    const root = tmpRoot("mstar-sdd-brief-");
    try {
      const planFile = join(root, "plan.md");
      writeFileSync(planFile, SAMPLE_PLAN);
      const outfile = join(root, "task-9-brief.md");
      const result = runCli(["sdd", "task-brief", planFile, "9", outfile]);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("task 9 not found");
      expect(readFileSync(outfile, "utf8")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-integer task number → exit 2 usage error", () => {
    const root = tmpRoot("mstar-sdd-brief-");
    try {
      const planFile = join(root, "plan.md");
      writeFileSync(planFile, SAMPLE_PLAN);
      const result = runCli(["sdd", "task-brief", planFile, "abc", join(root, "out.md")]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage: mstar sdd task-brief");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing plan file → exit 2 usage error", () => {
    const root = tmpRoot("mstar-sdd-brief-");
    try {
      const result = runCli(["sdd", "task-brief", join(root, "nope.md"), "1", join(root, "out.md")]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("no such plan file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no outfile + no SDD_DIR → exit 2 with guidance", () => {
    const root = tmpRoot("mstar-sdd-brief-");
    try {
      const planFile = join(root, "plan.md");
      writeFileSync(planFile, SAMPLE_PLAN);
      const result = runCli(["sdd", "task-brief", planFile, "2"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("set SDD_DIR or pass OUTFILE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no outfile + SDD_DIR env → writes {SDD_DIR}/task-N-brief.md", () => {
    const root = tmpRoot("mstar-sdd-brief-");
    try {
      const planFile = join(root, "plan.md");
      writeFileSync(planFile, SAMPLE_PLAN);
      const sddDir = join(root, "sdd");
      const result = runCli(["sdd", "task-brief", planFile, "3"], { env: { SDD_DIR: sddDir } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`task 3 brief: ${join(sddDir, "task-3-brief.md")}`);
      expect(readFileSync(join(sddDir, "task-3-brief.md"), "utf8")).toContain("### Task 3: third task");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing required args → exit 2 usage error (qc2 F-005)", () => {
    const root = tmpRoot("mstar-sdd-brief-usage-");
    try {
      const result = runCli(["sdd", "task-brief"], { cwd: root });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage: mstar sdd task-brief");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mstar sdd review-package — commits + stat + diff -U10 for BASE..HEAD", () => {
  test("valid SHAs → exit 0, package file has header/commits/stat/diff", () => {
    const root = tmpRoot("mstar-sdd-rp-");
    try {
      const { base, head } = gitFixture(root);
      const outfile = join(root, "review.diff");
      const result = runCli(["sdd", "review-package", base, head, outfile], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`review package: ${outfile}`);
      const content = readFileSync(outfile, "utf8");
      expect(content).toContain(`# Review package: ${base}..${head}`);
      expect(content).toContain("## Commits");
      expect(content).toContain("head commit");
      expect(content).toContain("## Files changed");
      expect(content).toContain("## Diff");
      expect(content).toContain("CHANGED line four");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bad BASE SHA → exit 2 with engine validation message", () => {
    const root = tmpRoot("mstar-sdd-rp-");
    try {
      const { head } = gitFixture(root);
      const result = runCli(["sdd", "review-package", "deadbeef", head, join(root, "review.diff")], {
        cwd: root,
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("bad BASE: deadbeef");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no outfile + no SDD_DIR → exit 2 with guidance", () => {
    const root = tmpRoot("mstar-sdd-rp-");
    try {
      const { base, head } = gitFixture(root);
      const result = runCli(["sdd", "review-package", base, head], { cwd: root });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("set SDD_DIR or pass OUTFILE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing BASE/HEAD → exit 2 usage error (qc2 F-005)", () => {
    const root = tmpRoot("mstar-sdd-rp-usage-");
    try {
      const result = runCli(["sdd", "review-package"], { cwd: root });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage: mstar sdd review-package");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
