/**
 * CLI `mstar sdd workspace|task-brief|review-package|check-context|exec` —
 * engine-backed wrappers with ported exit codes.
 *
 * Each case runs the real CLI as a subprocess against temp fixtures
 * (sample plan file; temp git repos incl. a linked worktree for the
 * fail-closed guard, plus disposable primary/control/feature checkouts for
 * the spec-A3 bound surface). Exit codes follow the ported engine contracts
 * via `SddScriptError`:
 * - `workspace`: 1 = resolution failure (unverifiable main worktree, bad
 *   CONTROL_ROOT, linked-checkout redirect), 2 = usage.
 * - `task-brief`: 2 = usage / missing plan file / missing SDD_DIR, 3 = task
 *   N not found in the plan.
 * - `review-package`: 2 = bad BASE/HEAD ref / missing SDD_DIR.
 * - `check-context` (spec A3): 0 = pass, 1 = gate fail, 2 = usage.
 * - `exec` (spec A3): 1 = gate failure (no child), 2 = usage,
 *   127 = spawn-not-found, child exit preserved, signals 128+n.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
 * Spawn env with ambient harness env vars pinned out: the CLI
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
  //(a sibling dir outside the tmp root leaked on every run).
  const linked = join(root, "linked");
  git(["worktree", "add", "-q", linked, "-b", "feature/linked"], root);
  return linked;
}

describe("mstar sdd workspace — resolve/ensure {SDD_DIR}", () => {
  test("plain non-Git dir with only a harness override fails closed (exit 1, nothing created)", () => {
    const root = tmpRoot("mstar-sdd-ws-");
    try {
      const harnessDir = join(root, ".custom-root");
      const result = runCli(["sdd", "workspace", "plan-1"], {
        cwd: root,
        env: { MSTAR_HARNESS_DIR: harnessDir },
      });
      // Verified-discovery invariant: without a verified main worktree the
      // engine resolves and creates NO SDD tree — a harness override alone
      // never authorizes a write from a plain (non-Git) dir; an explicit
      // standalone root must come via CONTROL_ROOT.
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("cannot verify the main worktree");
      expect(result.stderr).toContain("MSTAR_CONTROL_ROOT");
      expect(existsSync(harnessDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("linked worktree discovers the main worktree — SDD tree created at main, none under the linked checkout", () => {
    const root = tmpRoot("mstar-sdd-ws-main-");
    try {
      const linked = linkedWorktreeFixture(root);
      const result = runCli(["sdd", "workspace", "plan-1"], { cwd: linked });
      // Git-derived main discovery (first worktree record) reaches main from
      // a linked checkout: the SDD tree lands THERE — never a second
      // process-SSOT tree under the feature checkout.
      expect(result.exitCode).toBe(0);
      const expected = realpathSync(join(root, ".mstar", "sdd", "plan-1"));
      expect(result.stdout).toContain(`sdd dir: ${expected}`);
      expect(existsSync(join(root, ".mstar", "sdd", "plan-1"))).toBe(true);
      expect(existsSync(join(linked, ".mstar"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("linked worktree + CONTROL_ROOT + MSTAR_HARNESS_DIR → exit 0, SDD dir under control root", () => {
    const root = tmpRoot("mstar-sdd-ws-ctrl-");
    try {
      const linked = linkedWorktreeFixture(root);
      const harnessDir = join(root, ".custom-root");
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

  test("missing <plan-id> → exit 2 usage error(commander must not bypass the ported exit-2 usage contract)", () => {
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

  test("missing required args → exit 2 usage error", () => {
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

  test("missing BASE/HEAD → exit 2 usage error", () => {
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

// ---------------------------------------------------------------------------
// Spec-A3 bound execution surface: `sdd check-context`, `sdd exec` and `--context` on
// task-brief/review-package. Fixtures build disposable primary/control/
// feature checkouts with real `git worktree add` — never the real main
// checkout; the context JSON lives in the control sdd dir.
// ---------------------------------------------------------------------------

const PLAN_ID = "20260907-sdd-execution-paths";

interface ExecFixture {
  root: string;
  primary: string;
  control: string;
  feature: string;
  harnessDir: string;
  planFile: string;
  sddDir: string;
  ctxFile: string;
  workingBranch: string;
}

function executionFixture(root: string, opts: { nested?: boolean } = {}): ExecFixture {
  const primary = join(root, "primary");
  mkdirSync(primary);
  git(["init", "-q"], primary);
  git(["checkout", "-q", "-b", "main"], primary);
  git(["config", "user.email", "sdd-cli-test@example.com"], primary);
  git(["config", "user.name", "SDD CLI Test"], primary);
  writeFileSync(join(primary, "src-sentinel.txt"), "primary source sentinel\n");
  // Mirror the real default: control artifacts (.mstar/) are gitignored, so
  // the causal-replay suite can assert "sources clean" via git status while
  // bound producers legitimately write into the control sddDir.
  writeFileSync(join(primary, ".gitignore"), ".mstar/\n");
  git(["add", "-A"], primary);
  git(["commit", "-q", "-m", "primary base"], primary);

  const control = join(root, "control");
  git(["worktree", "add", "-q", "-b", "codex/iter-integration", control], primary);
  const workingBranch = `feature/${PLAN_ID}`;
  // Nested variant: the feature worktree lives INSIDE the control checkout
  // under an arbitrary folder name (the documented .worktrees layout) — the
  // checkout-identity gate must accept it without a name special-case.
  const feature = opts.nested ? join(control, "nested-checkouts", `wt-${PLAN_ID}`) : join(root, "feature");
  git(["worktree", "add", "-q", "-b", workingBranch, feature], primary);

  const harnessDir = join(control, ".mstar");
  const planFile = join(harnessDir, "plans", `${PLAN_ID}.md`);
  mkdirSync(dirname(planFile), { recursive: true });
  writeFileSync(planFile, "# Plan\n\n## Task 1\n\n- implement\n");
  const sddDir = join(harnessDir, "sdd", PLAN_ID);
  mkdirSync(sddDir, { recursive: true });
  const ctxFile = join(sddDir, "context.json");
  writeFileSync(
    ctxFile,
    JSON.stringify({ planId: PLAN_ID, controlHarnessRoot: harnessDir, featureCwd: feature, workingBranch, planFile, sddDir }, null, 2),
  );
  return { root, primary, control, feature, harnessDir, planFile, sddDir, ctxFile, workingBranch };
}

/** Child fixture: records {cwd, argv} as JSON into its first argument. */
function childWriterFixture(root: string): string {
  const writer = join(root, "child-writer.mjs");
  writeFileSync(
    writer,
    "import { writeFileSync } from 'node:fs';\n" +
      "const [out, ...rest] = process.argv.slice(2);\n" +
      "writeFileSync(out, JSON.stringify({ cwd: process.cwd(), argv: rest }));\n",
  );
  return writer;
}

describe("mstar sdd check-context — gate one action seam (spec A3)", () => {
  test("help advertises --context/--kind/--target", () => {
    const result = runCli(["sdd", "check-context", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--context");
    expect(result.stdout).toContain("--kind");
    expect(result.stdout).toContain("--target");
  });

  test("launch kind passes from the control checkout (destination is gated, not the parent cwd)", () => {
    const root = tmpRoot("mstar-sdd-cc-ok-");
    try {
      const f = executionFixture(root);
      const result = runCli(["sdd", "check-context", "--context", f.ctxFile, "--kind", "launch"], { cwd: f.control });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("check-context: OK");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("source kind from the control checkout fails the gate (exit 1, no write)", () => {
    const root = tmpRoot("mstar-sdd-cc-src-");
    try {
      const f = executionFixture(root);
      const result = runCli(
        ["sdd", "check-context", "--context", f.ctxFile, "--kind", "source", "--target", "src/probe.txt"],
        { cwd: f.control },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("sdd.context.source-cwd-outside-feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("artifact escape is blocked before write (exit 1)", () => {
    const root = tmpRoot("mstar-sdd-cc-esc-");
    try {
      const f = executionFixture(root);
      symlinkSync(f.primary, join(realpathSync(f.sddDir), "escape"));
      const result = runCli(
        ["sdd", "check-context", "--context", f.ctxFile, "--kind", "artifact", "--target", join(realpathSync(f.sddDir), "escape", "x.md")],
        { cwd: f.control },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("sdd.context.artifact-symlink-escape");
      expect(existsSync(join(f.primary, "x.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("usage errors exit 2: missing --context, missing --kind, bad kind, relative/missing/unparseable context file", () => {
    const root = tmpRoot("mstar-sdd-cc-usage-");
    try {
      const f = executionFixture(root);
      const missingContext = runCli(["sdd", "check-context", "--kind", "launch"], { cwd: root });
      expect(missingContext.exitCode).toBe(2);
      expect(missingContext.stderr).toContain("usage: mstar sdd check-context");

      const missingKind = runCli(["sdd", "check-context", "--context", f.ctxFile], { cwd: f.control });
      expect(missingKind.exitCode).toBe(2);
      expect(missingKind.stderr).toContain("--kind");

      const badKind = runCli(["sdd", "check-context", "--context", f.ctxFile, "--kind", "rename"], { cwd: f.control });
      expect(badKind.exitCode).toBe(2);
      expect(badKind.stderr).toContain("source|artifact|launch");

      const relativeCtx = runCli(["sdd", "check-context", "--context", "relative/context.json", "--kind", "launch"], { cwd: f.control });
      expect(relativeCtx.exitCode).toBe(2);
      expect(relativeCtx.stderr).toContain("absolute path");

      const noFile = runCli(["sdd", "check-context", "--context", join(root, "no-such.json"), "--kind", "launch"], { cwd: root });
      expect(noFile.exitCode).toBe(2);
      expect(noFile.stderr).toContain("no such context file");

      const badJson = join(root, "bad.json");
      writeFileSync(badJson, "{ not json");
      const unparseable = runCli(["sdd", "check-context", "--context", badJson, "--kind", "launch"], { cwd: root });
      expect(unparseable.exitCode).toBe(2);
      expect(unparseable.stderr).toContain("not valid JSON");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mstar sdd exec — bound argv launcher (spec A3)", () => {
  test("help advertises --context and the literal argv placement after --", () => {
    const result = runCli(["sdd", "exec", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--context");
    expect(result.stdout).toContain("--");
  });

  test("child runs in the feature worktree; argv literal with spaces/$()/backticks arrives unchanged (no shell)", () => {
    const root = tmpRoot("mstar-sdd-exec-literal-");
    try {
      const f = executionFixture(root);
      const writer = childWriterFixture(root);
      const record = join(root, "record.json");
      const result = runCli(
        ["sdd", "exec", "--context", f.ctxFile, "--", process.execPath, writer, record, "a b", "$(touch pwn.txt)", "`touch pwn.txt`", "*"],
        { cwd: f.control },
      );
      expect(result.exitCode).toBe(0);
      const doc = JSON.parse(readFileSync(record, "utf8")) as { cwd: string; argv: string[] };
      expect(doc.cwd).toBe(realpathSync(f.feature));
      expect(doc.argv).toEqual(["a b", "$(touch pwn.txt)", "`touch pwn.txt`", "*"]);
      // No shell ever ran: the command substitutions left nothing behind.
      expect(existsSync(join(f.feature, "pwn.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("context failure exits 1 and launches no child", () => {
    const root = tmpRoot("mstar-sdd-exec-gate-");
    try {
      const f = executionFixture(root);
      const writer = childWriterFixture(root);
      // Branch swap after the context file was written: the child itself is
      // the probe (it would write the probe file as its first action).
      git(["checkout", "-q", "-b", "feature/detour"], f.feature);
      const probe = join(f.feature, "probe-should-not-exist.json");
      const result = runCli(["sdd", "exec", "--context", f.ctxFile, "--", process.execPath, writer, probe], { cwd: f.control });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("worktree.branch-mismatch");
      expect(existsSync(probe)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("child exit 7 returns 7; spawn-not-found returns 127", () => {
    const root = tmpRoot("mstar-sdd-exec-exit-");
    try {
      const f = executionFixture(root);
      const exit7 = runCli(["sdd", "exec", "--context", f.ctxFile, "--", process.execPath, "-e", "process.exit(7)"], { cwd: f.control });
      expect(exit7.exitCode).toBe(7);
      const notFound = runCli(["sdd", "exec", "--context", f.ctxFile, "--", "definitely-not-a-real-binary-xyz"], { cwd: f.control });
      expect(notFound.exitCode).toBe(127);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SIGTERM is forwarded and the launcher settles at 128+15 (fixture child cleaned)", async () => {
    const root = tmpRoot("mstar-sdd-exec-term-");
    try {
      const f = executionFixture(root);
      // The child announces startup (handlers are installed before the child
      // can possibly run), so the kill below can only take the forwarding
      // path — never a vacuous default-disposition death.
      const marker = join(root, "child-started.txt");
      const childScript = join(root, "sleepy-child.mjs");
      writeFileSync(
        childScript,
        "import { writeFileSync } from 'node:fs';\n" +
          `writeFileSync(${JSON.stringify(marker)}, "started\\n");\n` +
          "setInterval(() => {}, 1000);\n",
      );
      const proc = Bun.spawn(
        [process.execPath, "run", SRC_ENTRY, "sdd", "exec", "--context", f.ctxFile, "--", process.execPath, childScript],
        { cwd: f.control, env: cliEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(50);
      expect(existsSync(marker)).toBe(true);
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(128 + 15);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("usage errors exit 2: no --context, no argv after --, relative --context", () => {
    const root = tmpRoot("mstar-sdd-exec-usage-");
    try {
      const f = executionFixture(root);
      const noContext = runCli(["sdd", "exec"], { cwd: root });
      expect(noContext.exitCode).toBe(2);
      expect(noContext.stderr).toContain("usage: mstar sdd exec");

      const noArgv = runCli(["sdd", "exec", "--context", f.ctxFile], { cwd: f.control });
      expect(noArgv.exitCode).toBe(2);
      expect(noArgv.stderr).toContain("usage: mstar sdd exec");

      const relativeCtx = runCli(["sdd", "exec", "--context", "ctx.json", "--", "true"], { cwd: f.control });
      expect(relativeCtx.exitCode).toBe(2);
      expect(relativeCtx.stderr).toContain("absolute path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mstar sdd task-brief/review-package --context — bound artifact producers (spec A3)", () => {
  test("help advertises --context on both commands (positional surface unchanged)", () => {
    const briefHelp = runCli(["sdd", "task-brief", "--help"]);
    expect(briefHelp.exitCode).toBe(0);
    expect(briefHelp.stdout).toContain("--context");
    expect(briefHelp.stdout).toContain("[plan-file]");
    expect(briefHelp.stdout).toContain("[outfile]");
    const rpHelp = runCli(["sdd", "review-package", "--help"]);
    expect(rpHelp.exitCode).toBe(0);
    expect(rpHelp.stdout).toContain("--context");
    expect(rpHelp.stdout).toContain("[base]");
    expect(rpHelp.stdout).toContain("[outfile]");
  });

  test("bound task-brief writes into the control sddDir without SDD_DIR and prints an absolute path", () => {
    const root = tmpRoot("mstar-sdd-brief-ctx-");
    try {
      const f = executionFixture(root);
      const result = runCli(["sdd", "task-brief", f.planFile, "1", "--context", f.ctxFile], { cwd: f.control });
      expect(result.exitCode).toBe(0);
      const expected = realpathSync(join(f.sddDir, "task-1-brief.md"));
      expect(result.stdout).toContain(`task 1 brief: ${expected}`);
      expect(readFileSync(expected, "utf8")).toContain("- implement");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bound review-package probes the feature worktree and lands in the control sddDir", () => {
    const root = tmpRoot("mstar-sdd-rp-ctx-");
    try {
      const f = executionFixture(root);
      writeFileSync(join(f.feature, "feature-file.txt"), "feature change\n");
      git(["add", "-A"], f.feature);
      git(["commit", "-q", "-m", "feature commit"], f.feature);
      const base = git(["rev-parse", "main"], f.primary);
      const head = git(["rev-parse", "HEAD"], f.feature);
      const result = runCli(["sdd", "review-package", base, head, "--context", f.ctxFile], { cwd: f.control });
      expect(result.exitCode).toBe(0);
      const expected = realpathSync(join(f.sddDir, `review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`));
      expect(result.stdout).toContain(`review package: ${expected}`);
      expect(readFileSync(expected, "utf8")).toContain("feature-file.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bound review-package refuses an artifact outside the plan (exit 1, nothing written)", () => {
    const root = tmpRoot("mstar-sdd-rp-ctx-esc-");
    try {
      const f = executionFixture(root);
      writeFileSync(join(f.feature, "feature-file.txt"), "feature change\n");
      git(["add", "-A"], f.feature);
      git(["commit", "-q", "-m", "feature commit"], f.feature);
      const base = git(["rev-parse", "main"], f.primary);
      const head = git(["rev-parse", "HEAD"], f.feature);
      const destination = join(f.control, "elsewhere.diff");
      const result = runCli(["sdd", "review-package", base, head, destination, "--context", f.ctxFile], { cwd: f.control });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("sdd.context.artifact-outside-plan");
      expect(existsSync(destination)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Nested layout: the feature worktree is a real
// linked worktree created INSIDE the control checkout under an arbitrary
// folder name (the documented .worktrees layout). The bound surface must
// accept it as a distinct checkout — no .worktrees name special-case — and
// keep every containment behavior: child writes land in the nested feature
// only, artifacts stay under the control sddDir, and a source action from
// the control cwd is still refused.
// ---------------------------------------------------------------------------

describe("mstar sdd bound surface with a nested feature worktree", () => {
  test("check-context launch passes for the nested feature (exit 0)", () => {
    const root = tmpRoot("mstar-sdd-nested-launch-");
    try {
      const f = executionFixture(root, { nested: true });
      const result = runCli(["sdd", "check-context", "--context", f.ctxFile, "--kind", "launch"], { cwd: f.control });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("check-context: OK");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("source action from the control cwd is still refused for the nested feature (exit 1)", () => {
    const root = tmpRoot("mstar-sdd-nested-source-");
    try {
      const f = executionFixture(root, { nested: true });
      const result = runCli(
        ["sdd", "check-context", "--context", f.ctxFile, "--kind", "source", "--target", "src/probe.txt"],
        { cwd: f.control },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("sdd.context.source-cwd-outside-feature");
      expect(existsSync(join(f.feature, "src", "probe.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bound task-brief --context lands in the control sddDir for the nested feature (exit 0)", () => {
    const root = tmpRoot("mstar-sdd-nested-brief-");
    try {
      const f = executionFixture(root, { nested: true });
      const result = runCli(["sdd", "task-brief", f.planFile, "1", "--context", f.ctxFile], { cwd: f.control });
      expect(result.exitCode).toBe(0);
      const expected = realpathSync(join(f.sddDir, "task-1-brief.md"));
      expect(result.stdout).toContain(`task 1 brief: ${expected}`);
      expect(readFileSync(expected, "utf8")).toContain("- implement");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bound review-package probes the nested feature and lands in the control sddDir (exit 0)", () => {
    const root = tmpRoot("mstar-sdd-nested-rp-");
    try {
      const f = executionFixture(root, { nested: true });
      writeFileSync(join(f.feature, "feature-file.txt"), "feature change\n");
      git(["add", "-A"], f.feature);
      git(["commit", "-q", "-m", "feature commit"], f.feature);
      const base = git(["rev-parse", "main"], f.primary);
      const head = git(["rev-parse", "HEAD"], f.feature);
      const result = runCli(["sdd", "review-package", base, head, "--context", f.ctxFile], { cwd: f.control });
      expect(result.exitCode).toBe(0);
      const expected = realpathSync(join(f.sddDir, `review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`));
      expect(result.stdout).toContain(`review package: ${expected}`);
      expect(readFileSync(expected, "utf8")).toContain("feature-file.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bound exec child runs in the nested feature; the sentinel lands there and nowhere else", () => {
    const root = tmpRoot("mstar-sdd-nested-exec-");
    try {
      const f = executionFixture(root, { nested: true });
      const writer = childWriterFixture(root);
      const record = join(f.sddDir, "child-record.json");
      const result = runCli(["sdd", "exec", "--context", f.ctxFile, "--", process.execPath, writer, record], { cwd: f.control });
      expect(result.exitCode).toBe(0);
      const doc = JSON.parse(readFileSync(record, "utf8")) as { cwd: string; argv: string[] };
      expect(doc.cwd).toBe(realpathSync(f.feature));
      expect(existsSync(join(f.primary, "child-record.json"))).toBe(false);
      expect(existsSync(join(f.control, "child-record.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Causal replay (spec A3 / AC4): the historical incident was an implementer
// writing a RELATIVE path that resolved against the wrong checkout. The SAME
// relative source writer runs in both arms against disposable fixtures only
// (never the real main checkout): raw launch from a disposable primary must
// reproduce the wrong-primary write; the bound `sdd exec` launch must send
// the identical writer to the feature worktree and leave primary/control
// source sentinels untouched. Explicit blind spots stay untested on purpose
// (no total-sandbox claim): a deliberate chdir, an overriding cwd flag, an
// absolute-path write outside feature, and host-native edit tooling
// (apply_patch/native sessions) are NOT blocked by the launcher.
// ---------------------------------------------------------------------------

/** The one writer both replay arms run — relative paths only, like the incident. */
const RELATIVE_SOURCE_WRITER =
  "import { mkdirSync, writeFileSync } from 'node:fs';\n" +
  "const rel = process.argv[2] ?? 'src/probe.txt';\n" +
  "mkdirSync('src', { recursive: true });\n" +
  "writeFileSync(rel, 'relative source write\\n');\n";

function relativeSourceWriterFixture(root: string): string {
  const writer = join(root, "relative-source-writer.mjs");
  writeFileSync(writer, RELATIVE_SOURCE_WRITER);
  return writer;
}

/** Raw launch (no launcher): child cwd = wherever the parent invokes from. */
function runRaw(argv: string[], cwd: string): RunResult {
  const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function expectSourcesUntouched(f: ExecFixture): void {
  expect(git(["status", "--porcelain"], f.primary)).toBe("");
  expect(git(["status", "--porcelain"], f.control)).toBe("");
  expect(readFileSync(join(f.primary, "src-sentinel.txt"), "utf8")).toBe("primary source sentinel\n");
  expect(readFileSync(join(f.control, "src-sentinel.txt"), "utf8")).toBe("primary source sentinel\n");
}

describe("sdd exec causal replay — same relative source writer, raw vs bound (spec A3, AC4)", () => {
  test("relative source writer launched raw from a disposable primary reproduces the wrong-primary write", () => {
    const root = tmpRoot("mstar-sdd-replay-raw-");
    try {
      const f = executionFixture(root);
      const writer = relativeSourceWriterFixture(root);
      const raw = runRaw([process.execPath, writer], f.primary);
      expect(raw.exitCode).toBe(0);
      // The historical mistake, reproduced: the relative write resolved
      // against the primary checkout, dirtying it.
      expect(existsSync(join(f.primary, "src", "probe.txt"))).toBe(true);
      expect(git(["status", "--porcelain", "--untracked-files=all"], f.primary)).toContain("?? src/probe.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("relative source writer via bound sdd exec lands in the feature only; primary/control sentinels unchanged", () => {
    const root = tmpRoot("mstar-sdd-replay-bound-");
    try {
      const f = executionFixture(root);
      const writer = relativeSourceWriterFixture(root);
      // A declared-correct context plus explicit source check with the actual
      // primary cwd fails BEFORE any writer invocation (rejection precedes
      // mutation where a blocking seam exists).
      const preCheck = runCli(
        ["sdd", "check-context", "--context", f.ctxFile, "--kind", "source", "--target", "src/probe.txt"],
        { cwd: f.primary },
      );
      expect(preCheck.exitCode).toBe(1);
      expect(preCheck.stderr).toContain("sdd.context.source-cwd-outside-feature");
      expect(existsSync(join(f.feature, "src", "probe.txt"))).toBe(false);

      // The same writer, bound: launched from the primary checkout (launch
      // gates the resolved destination, not the parent cwd), child starts in
      // the feature worktree.
      const bound = runCli(["sdd", "exec", "--context", f.ctxFile, "--", process.execPath, writer], { cwd: f.primary });
      expect(bound.exitCode).toBe(0);
      expect(existsSync(join(f.feature, "src", "probe.txt"))).toBe(true);
      expect(existsSync(join(f.primary, "src", "probe.txt"))).toBe(false);
      expect(git(["status", "--porcelain", "--untracked-files=all"], f.feature)).toContain("?? src/probe.txt");
      expectSourcesUntouched(f);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("relative source writer resume repeat: a second bound launch (fresh then resume) still changes the feature only", () => {
    const root = tmpRoot("mstar-sdd-replay-resume-");
    try {
      const f = executionFixture(root);
      const writer = relativeSourceWriterFixture(root);
      const fresh = runCli(["sdd", "exec", "--context", f.ctxFile, "--", process.execPath, writer], { cwd: f.primary });
      expect(fresh.exitCode).toBe(0);
      const resume = runCli(
        ["sdd", "exec", "--context", f.ctxFile, "--", process.execPath, writer, "src/probe-resume.txt"],
        { cwd: f.primary },
      );
      expect(resume.exitCode).toBe(0);
      expect(existsSync(join(f.feature, "src", "probe.txt"))).toBe(true);
      expect(existsSync(join(f.feature, "src", "probe-resume.txt"))).toBe(true);
      expect(existsSync(join(f.primary, "src", "probe.txt"))).toBe(false);
      expect(existsSync(join(f.primary, "src", "probe-resume.txt"))).toBe(false);
      expectSourcesUntouched(f);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("relative source writer bound arm plus ignored control-artifact writes: artifacts stay control-local, sources stay clean", () => {
    const root = tmpRoot("mstar-sdd-replay-artifact-");
    try {
      const f = executionFixture(root);
      const writer = relativeSourceWriterFixture(root);
      const bound = runCli(["sdd", "exec", "--context", f.ctxFile, "--", process.execPath, writer], { cwd: f.primary });
      expect(bound.exitCode).toBe(0);

      // Bound control-artifact producers: the sddDir is gitignored in the
      // fixture, so legitimate control writes must not dirty any git status.
      const brief = runCli(["sdd", "task-brief", f.planFile, "1", "--context", f.ctxFile], { cwd: f.primary });
      expect(brief.exitCode).toBe(0);
      const briefPath = realpathSync(join(f.sddDir, "task-1-brief.md"));
      expect(existsSync(briefPath)).toBe(true);

      writeFileSync(join(f.feature, "feature-file.txt"), "feature change\n");
      git(["add", "-A"], f.feature);
      git(["commit", "-q", "-m", "feature commit"], f.feature);
      const base = git(["rev-parse", "main"], f.primary);
      const head = git(["rev-parse", "HEAD"], f.feature);
      const rp = runCli(["sdd", "review-package", base, head, "--context", f.ctxFile], { cwd: f.primary });
      expect(rp.exitCode).toBe(0);
      const diffPath = realpathSync(join(f.sddDir, `review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`));
      expect(existsSync(diffPath)).toBe(true);
      expect(readFileSync(diffPath, "utf8")).toContain("feature-file.txt");

      // Feature shows exactly the committed change; primary/control sources
      // are untouched; the control artifacts are invisible to git (ignored).
      expect(git(["status", "--porcelain"], f.feature)).toBe("");
      expectSourcesUntouched(f);
      expect(briefPath.startsWith(realpathSync(f.sddDir))).toBe(true);
      expect(diffPath.startsWith(realpathSync(f.sddDir))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
