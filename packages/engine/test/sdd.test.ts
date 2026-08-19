/**
 * Engine sdd module — SDD loop state machine + the engine implementations
 * of the SDD workspace / task-brief / review-package helpers (CLI form:
 * `mstar sdd workspace|task-brief|review-package`).
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - Per-task loop, BASE_SHA rule, progress ledger, model tiers, red flags:
 *   `skills/mstar-sdd/SKILL.md` § Per-task loop, § Progress ledger,
 *   § Red flags (NEVER) — `HEAD~1` as review BASE, resume without
 *   `host_agent_id`, re-dispatch of completed tasks, skip task review.
 * - Helper contracts: `skills/mstar-sdd/SKILL.md` § CLI table
 *   (`sddWorkspace`, `taskBrief`, `reviewPackage`). Golden-fixture parity:
 *   the task-brief extraction output is compared against a fixture captured
 *   from the former bash oracle (byte-proven in slice 2, scripts removed in
 *   slice 5); path-shaped outputs (workspace resolution, review-package
 *   files) are asserted directly against git/fs ground truth.
 * - File handoffs (task-N-report.md, review-package usage):
 *   `skills/mstar-sdd/references/file-handoffs.md`.
 * - Sticky implementer session (host_agent_id required for resume,
 *   micro-batch ≤ 3, fresh fallback, reviewers never sticky):
 *   `skills/mstar-sdd/references/sticky-implementer-session.md` +
 *   SKILL.md red flag "Resume implementer without host_agent_id".
 * - Harness-root override (`MSTAR_HARNESS_DIR` env / option) in addition
 *   to CONTROL_ROOT, because the status.json probe only knows `.mstar`/`.agents`
 *   and misses repos with another root:
 *   plan 20260808-slice2-sdd-iteration Task 1 Finding (2026-08-08, PM).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SddScriptError,
  assertBaseSha,
  implementerSessionStickyRules,
  readProgressLedger,
  reviewPackage,
  sddWorkspace,
  taskBrief,
  taskReportExists,
  type ImplementerSessionLedger,
} from "../src/sdd.js";

const MSTAR_CONTROL_ROOT = "MSTAR_CONTROL_ROOT";
const MSTAR_HARNESS_DIR = "MSTAR_HARNESS_DIR";
const SDD_DIR = "SDD_DIR";

/** Ambient env vars `sddWorkspace` / `taskBrief` / `reviewPackage` read. */
const AMBIENT_ENV_KEYS = [MSTAR_CONTROL_ROOT, MSTAR_HARNESS_DIR, SDD_DIR] as const;
const ambientEnvValues = new Map<string, string | undefined>(
  AMBIENT_ENV_KEYS.map((key) => [key, process.env[key]]),
);

// Env pinning (qc3 W-4): `sddWorkspace` reads MSTAR_CONTROL_ROOT and
// MSTAR_HARNESS_DIR ahead of probing, and taskBrief/reviewPackage read
// SDD_DIR — an ambient shell export would redirect fixture resolution and
// fail these tests spuriously (or worse, resolve against the developer's
// real control worktree). Pin all three to undefined before every test and
// restore the ambient values once at the end of the suite.
beforeEach(() => {
  for (const key of AMBIENT_ENV_KEYS) delete process.env[key];
});
afterAll(() => {
  for (const [key, value] of ambientEnvValues) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const SAMPLE_PLAN = join(import.meta.dir, "fixtures", "sample-plan.md");
const TASK1_BRIEF_GOLDEN = join(import.meta.dir, "fixtures", "task-1-brief.golden.md");

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

/** Create a git repo at `root` with commits A (base) and B (head). */
function gitFixture(root: string): { base: string; head: string } {
  git(["init", "-q"], root);
  git(["config", "user.email", "sdd-test@example.com"], root);
  git(["config", "user.name", "SDD Test"], root);
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

function errOf(fn: () => unknown): SddScriptError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SddScriptError);
    return e as SddScriptError;
  }
  throw new Error("expected SddScriptError, got no throw");
}

describe("assertBaseSha — BASE_SHA rule (mstar-sdd SKILL.md § Red flags: NEVER `HEAD~1` as review BASE)", () => {
  test("rejects HEAD~1", () => {
    const err = errOf(() => assertBaseSha("HEAD~1"));
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain("HEAD~1");
    expect(err.message).toMatch(/Never use HEAD~1 as review BASE/i);
  });

  test("rejects HEAD, HEAD^, branches, tags and other non-SHA refs", () => {
    for (const ref of ["HEAD", "HEAD^", "HEAD@{1}", "main", "feature/x", "v1.0", ""]) {
      expect(() => assertBaseSha(ref)).toThrow(SddScriptError);
    }
  });

  test("rejects a well-formed but nonexistent SHA", () => {
    const root = tmpRoot("sdd-assert-missing-");
    try {
      gitFixture(root);
      const err = errOf(() => assertBaseSha("0123456789abcdef0123456789abcdef01234567", { cwd: root }));
      expect(err.exitCode).toBe(2);
      expect(err.message).toMatch(/commit not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts a full SHA and an unambiguous prefix that exist", () => {
    const root = tmpRoot("sdd-assert-ok-");
    try {
      const { base } = gitFixture(root);
      expect(() => assertBaseSha(base, { cwd: root })).not.toThrow();
      expect(() => assertBaseSha(base.slice(0, 8), { cwd: root })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("taskReportExists — file handoffs (file-handoffs.md: implementer writes task-N-report.md)", () => {
  test("false when the report file is missing", () => {
    const dir = tmpRoot("sdd-report-");
    try {
      expect(taskReportExists(dir, 1)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("false when the report file exists but is empty (no evidence)", () => {
    const dir = tmpRoot("sdd-report-");
    try {
      writeFileSync(join(dir, "task-1-report.md"), "");
      expect(taskReportExists(dir, 1)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("true when a non-empty task-N-report.md exists", () => {
    const dir = tmpRoot("sdd-report-");
    try {
      writeFileSync(join(dir, "task-3-report.md"), "Status: DONE\n");
      expect(taskReportExists(dir, 3)).toBe(true);
      expect(taskReportExists(dir, 2)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readProgressLedger — progress ledger (mstar-sdd SKILL.md § Progress ledger)", () => {
  test("returns [] when progress.md is missing", () => {
    const dir = tmpRoot("sdd-ledger-");
    try {
      expect(readProgressLedger(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns non-empty trimmed lines; completed tasks are not re-dispatched", () => {
    const dir = tmpRoot("sdd-ledger-");
    try {
      writeFileSync(join(dir, "progress.md"), "Task 1: complete (abc..def, review clean)\n\n## Minor (for plan QC)\n- nit\n");
      const ledger = readProgressLedger(dir);
      expect(ledger).toEqual(["Task 1: complete (abc..def, review clean)", "## Minor (for plan QC)", "- nit"]);
      expect(ledger.some((line) => line.startsWith("Task 1: complete"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("implementerSessionStickyRules — sticky resume rules (sticky-implementer-session.md)", () => {
  function stickyLedger(overrides: Partial<ImplementerSessionLedger> = {}): ImplementerSessionLedger {
    return {
      plan_id: "test-plan",
      execute_as: "fullstack-dev",
      session_mode: "sticky",
      host: "omp",
      host_agent_id: "agent-123",
      working_branch: "feature/x",
      started_task: 1,
      last_task: 1,
      started_at: "2026-08-08T00:00:00Z",
      ...overrides,
    };
  }

  test("fresh session never resumes", () => {
    const result = implementerSessionStickyRules({ session: stickyLedger({ session_mode: "fresh" }), nextTask: 2 });
    expect(result.resume).toBe(false);
    expect(result.reason).toMatch(/fresh/);
  });

  test("sticky without host_agent_id falls back to fresh (SKILL.md red flag)", () => {
    const result = implementerSessionStickyRules({
      session: stickyLedger({ host_agent_id: undefined }),
      nextTask: 2,
    });
    expect(result.resume).toBe(false);
    expect(result.reason).toMatch(/host_agent_id/);
  });

  test("sticky with host_agent_id and a new task resumes", () => {
    const result = implementerSessionStickyRules({ session: stickyLedger(), nextTask: 2 });
    expect(result.resume).toBe(true);
    expect(result.reason).toMatch(/agent-123/);
  });

  test("never resumes a task already completed through last_task", () => {
    const result = implementerSessionStickyRules({ session: stickyLedger({ last_task: 3 }), nextTask: 3 });
    expect(result.resume).toBe(false);
    expect(result.reason).toMatch(/last_task/);
  });

  test("micro-batch of 4 is rejected, 3 is allowed (max 3 without user override)", () => {
    const over = { session: stickyLedger(), nextTask: 2 };
    expect(implementerSessionStickyRules({ ...over, microBatchTasks: 4 }).resume).toBe(false);
    expect(implementerSessionStickyRules({ ...over, microBatchTasks: 3 }).resume).toBe(true);
    expect(implementerSessionStickyRules({ ...over, microBatchTasks: 1 }).resume).toBe(true);
  });
});

describe("sddWorkspace — SDD dir resolution (SKILL.md § Per-task loop + § CLI)", () => {
  test("resolves/creates {HARNESS_DIR}/sdd/<plan-id>/.gitignore when .mstar/status.json exists", () => {
    const root = tmpRoot("sdd-ws-mstar-");
    try {
      git(["init", "-q"], root);
      mkdirSync(join(root, ".mstar"), { recursive: true });
      writeFileSync(join(root, ".mstar", "status.json"), "{}\n");
      const dir = sddWorkspace("plan-1", { cwd: root });
      expect(dir).toBe(realpathSync(join(root, ".mstar", "sdd", "plan-1")));
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
      expect(statSync(dir).isDirectory()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("probes an active workflow via snapshot presence when status.json is absent (v3 probe)", () => {
    // Task 5: probe semantics unchanged (root status.json existence) PLUS
    // workflow-snapshot presence detects an active lifecycle — a harness
    // whose root status.json does not exist yet still resolves.
    const root = tmpRoot("sdd-ws-snapshot-");
    try {
      git(["init", "-q"], root);
      mkdirSync(join(root, ".mstar", "workflows", "wf-1"), { recursive: true });
      writeFileSync(
        join(root, ".mstar", "workflows", "wf-1", "snapshot.json"),
        JSON.stringify({ schema_version: 1, id: "wf-1", type: "plan", status: "running", started_at: "2026-08-19T08:00:00Z", updated_at: "2026-08-19", plans: [] }),
        "utf8",
      );
      const dir = sddWorkspace("plan-1", { cwd: root });
      expect(dir).toBe(realpathSync(join(root, ".mstar", "sdd", "plan-1")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors the CONTROL_ROOT option (CLI 2nd arg) and MSTAR_CONTROL_ROOT env", () => {
    const control = tmpRoot("sdd-ws-control-");
    const elsewhere = tmpRoot("sdd-ws-elsewhere-");
    try {
      mkdirSync(join(control, ".mstar"), { recursive: true });
      writeFileSync(join(control, ".mstar", "status.json"), "{}\n");
      const fromArg = sddWorkspace("plan-1", { cwd: elsewhere, controlRoot: control });
      expect(fromArg).toBe(realpathSync(join(control, ".mstar", "sdd", "plan-1")));
      withEnv(MSTAR_CONTROL_ROOT, control, () => {
        const fromEnv = sddWorkspace("plan-1", { cwd: elsewhere });
        expect(fromEnv).toBe(realpathSync(join(control, ".mstar", "sdd", "plan-1")));
      });
    } finally {
      rmSync(control, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("non-directory CONTROL_ROOT fails with exit code 1", () => {
    const err = errOf(() => sddWorkspace("plan-1", { controlRoot: "/definitely/not/a/dir-xyz" }));
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain("is not a directory");
  });

  test("fail-closed: linked worktree without status.json refuses a second SDD tree", () => {
    const main = tmpRoot("sdd-ws-main-");
    const parent = tmpRoot("sdd-ws-parent-");
    try {
      gitFixture(main);
      const linked = join(parent, "linked");
      mkdirSync(dirname(linked), { recursive: true });
      git(["worktree", "add", "-q", linked, "-b", "feature/linked"], main);
      // linked worktree has no .mstar/status.json and no control root
      const err = errOf(() => sddWorkspace("plan-1", { cwd: linked }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toMatch(/linked worktree at .* has no \{HARNESS_DIR\}\/status\.json/);
      expect(err.message).toMatch(/Refusing to create a second SDD tree/);
      expect(err.message).toContain("MSTAR_CONTROL_ROOT");
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fail-closed first: MSTAR_HARNESS_DIR cannot bypass the linked-worktree guard", () => {
    const main = tmpRoot("sdd-ws-guard-");
    const parent = tmpRoot("sdd-ws-guard-parent-");
    try {
      gitFixture(main);
      const linked = join(parent, "linked");
      mkdirSync(dirname(linked), { recursive: true });
      git(["worktree", "add", "-q", linked, "-b", "feature/guarded"], main);
      // override + no CONTROL_ROOT must still fail closed — the override
      // may never create a second SDD tree under the feature checkout
      withEnv(MSTAR_HARNESS_DIR, ".custom-root", () => {
        const err = errOf(() => sddWorkspace("plan-1", { cwd: linked }));
        expect(err.exitCode).toBe(1);
        expect(err.message).toMatch(/linked worktree at .* has no \{HARNESS_DIR\}\/status\.json/);
        expect(err.message).toMatch(/Refusing to create a second SDD tree/);
      });
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("harness-root override: MSTAR_HARNESS_DIR picks a non-probed root (plan finding 2026-08-08)", () => {
    const root = tmpRoot("sdd-ws-harness-");
    try {
      git(["init", "-q"], root);
      mkdirSync(join(root, ".custom-root"), { recursive: true });
      withEnv(MSTAR_HARNESS_DIR, ".custom-root", () => {
        const dir = sddWorkspace("plan-1", { cwd: root });
        expect(dir).toBe(realpathSync(join(root, ".custom-root", "sdd", "plan-1")));
      });
      withEnv(MSTAR_HARNESS_DIR, undefined, () => {
        // no probed harness and not a linked worktree → default .mstar
        const dir = sddWorkspace("plan-1", { cwd: root });
        expect(dir).toBe(realpathSync(join(root, ".mstar", "sdd", "plan-1")));
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("override wins over CONTROL_ROOT probing (non-probed control repo root)", () => {
    const control = tmpRoot("sdd-ws-override-");
    try {
      git(["init", "-q"], control);
      mkdirSync(join(control, ".custom-root"), { recursive: true });
      withEnv(MSTAR_HARNESS_DIR, ".custom-root", () => {
        const dir = sddWorkspace("plan-1", { cwd: control, controlRoot: control });
        expect(dir).toBe(realpathSync(join(control, ".custom-root", "sdd", "plan-1")));
      });
    } finally {
      rmSync(control, { recursive: true, force: true });
    }
  });

  test("`.mstarc` [config] harness_dir picks the declared root (no override needed)", () => {
    const control = tmpRoot("sdd-ws-rc-");
    try {
      git(["init", "-q"], control);
      writeFileSync(join(control, ".mstarc"), "[config]\nharness_dir=.custom-root\n");
      withEnv(MSTAR_HARNESS_DIR, undefined, () => {
        const dir = sddWorkspace("plan-1", { cwd: control, controlRoot: control });
        expect(dir).toBe(realpathSync(join(control, ".custom-root", "sdd", "plan-1")));
      });
    } finally {
      rmSync(control, { recursive: true, force: true });
    }
  });
});

describe("taskBrief — task brief extraction (SKILL.md § Per-task loop + § CLI)", () => {
  test("extracts from the matching '## Task N' heading; fenced headings and number boundaries ignored", () => {
    const out = tmpRoot("sdd-brief-");
    try {
      const file = join(out, "task-2-brief.md");
      const written = taskBrief(SAMPLE_PLAN, 2, file);
      expect(written).toBe(file);
      const content = readFileSync(file, "utf8");
      expect(content.startsWith("### Task 2: second task\n")).toBe(true);
      expect(content).not.toContain("hidden behind a fence");
      expect(content).not.toContain("Task 1: first task");
      const task10 = join(out, "task-10-brief.md");
      taskBrief(SAMPLE_PLAN, 10, task10);
      expect(readFileSync(task10, "utf8")).toBe("### Task 10: tenth task\n\n- [ ] not task 1 (heading number boundary)\n");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("missing plan file fails with exit code 2", () => {
    const err = errOf(() => taskBrief("/no/such/plan.md", 1, "/tmp/out.md"));
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain("no such plan file");
  });

  test("missing task heading fails with exit code 3 and writes an empty out file", () => {
    const out = tmpRoot("sdd-brief-");
    try {
      const file = join(out, "task-5-brief.md");
      const err = errOf(() => taskBrief(SAMPLE_PLAN, 5, file));
      expect(err.exitCode).toBe(3);
      expect(err.message).toContain("task 5 not found");
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("default out path uses SDD_DIR/task-N-brief.md and creates SDD_DIR", () => {
    const out = tmpRoot("sdd-brief-");
    try {
      const sddDir = join(out, "sdd", "sub");
      withEnv(SDD_DIR, sddDir, () => {
        const file = taskBrief(SAMPLE_PLAN, 1);
        expect(file).toBe(join(sddDir, "task-1-brief.md"));
        expect(existsSync(file)).toBe(true);
      });
      withEnv(SDD_DIR, undefined, () => {
        const err = errOf(() => taskBrief(SAMPLE_PLAN, 1));
        expect(err.exitCode).toBe(2);
        expect(err.message).toMatch(/set SDD_DIR or pass OUTFILE/);
      });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("reviewPackage — review diff packaging (SKILL.md § After all tasks + § CLI)", () => {
  test("writes commit list, stat, and -U10 diff for BASE..HEAD", () => {
    const root = tmpRoot("sdd-rp-");
    const out = tmpRoot("sdd-rp-out-");
    try {
      const { base, head } = gitFixture(root);
      const file = join(out, "package.diff");
      const written = reviewPackage(base, head, file, { cwd: root });
      expect(written).toBe(file);
      const content = readFileSync(file, "utf8");
      expect(content.startsWith(`# Review package: ${base}..${head}\n`)).toBe(true);
      expect(content).toContain("## Commits\n");
      expect(content).toContain(`${head.slice(0, 7)} head commit\n`);
      expect(content).toContain("## Files changed\n");
      expect(content).toContain("file1.txt");
      expect(content).toContain("file2.txt");
      expect(content).toContain("## Diff\n");
      expect(content).toContain("@@"); // unified diff hunks
      expect(content).toContain("CHANGED line four"); // -U10 context from the head commit
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("default out file is SDD_DIR/review-<short base>..<short head>.diff", () => {
    const root = tmpRoot("sdd-rp-");
    const out = tmpRoot("sdd-rp-out-");
    try {
      const { base, head } = gitFixture(root);
      const sddDir = join(out, "sdd");
      const file = reviewPackage(base, head, undefined, { cwd: root, sddDir });
      expect(file).toBe(join(sddDir, `review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("bad BASE / HEAD fail with exit code 2", () => {
    const root = tmpRoot("sdd-rp-");
    try {
      const { base, head } = gitFixture(root);
      const bad = errOf(() => reviewPackage("does-not-exist", head, undefined, { cwd: root }));
      expect(bad.exitCode).toBe(2);
      expect(bad.message).toContain("bad BASE");
      const badHead = errOf(() => reviewPackage(base, "nope", undefined, { cwd: root }));
      expect(badHead.exitCode).toBe(2);
      expect(badHead.message).toContain("bad HEAD");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("engine helper contracts (bash originals removed in slice 5 — behavior asserted directly / against golden fixtures)", () => {
  test("sddWorkspace: resolves/creates {SDD_DIR} with symlink normalization and .gitignore", () => {
    const root = tmpRoot("sdd-ws-");
    try {
      git(["init", "-q"], root);
      mkdirSync(join(root, ".mstar"), { recursive: true });
      writeFileSync(join(root, ".mstar", "status.json"), "{}\n");
      const tsDir = sddWorkspace("parity-plan", { cwd: root });
      expect(tsDir).toBe(realpathSync(join(root, ".mstar", "sdd", "parity-plan")));
      expect(readFileSync(join(tsDir, ".gitignore"), "utf8")).toBe("*\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sddWorkspace fail-closed: exit 1 with the linked-worktree message", () => {
    const main = tmpRoot("sdd-fc-main-");
    const parent = tmpRoot("sdd-fc-parent-");
    try {
      gitFixture(main);
      const linked = join(parent, "linked");
      mkdirSync(linked, { recursive: true });
      git(["worktree", "add", "-q", linked, "-b", "feature/parity"], main);
      const err = errOf(() => sddWorkspace("parity-plan", { cwd: linked }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("linked worktree");
      expect(err.message).toContain("Refusing to create a second SDD tree");
      expect(err.message).toContain("or: mstar sdd workspace parity-plan <control_worktree_path>");
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("sddWorkspace harness override lands on the real harness root (plan finding)", () => {
    const control = tmpRoot("sdd-override-control-");
    try {
      git(["init", "-q"], control);
      mkdirSync(join(control, ".custom-root"), { recursive: true });
      // The status.json probe misses non-probed roots → the explicit override
      // (MSTAR_HARNESS_DIR) is required to land on the real harness root.
      withEnv(MSTAR_HARNESS_DIR, ".custom-root", () => {
        const tsDir = sddWorkspace("parity-plan", { cwd: control, controlRoot: control });
        expect(tsDir).toBe(realpathSync(join(control, ".custom-root", "sdd", "parity-plan")));
      });
    } finally {
      rmSync(control, { recursive: true, force: true });
    }
  });

  test("taskBrief: file content matches the golden fixture (captured from the former bash oracle)", () => {
    const out = tmpRoot("sdd-brief-golden-");
    try {
      const tsOut = join(out, "ts-task-1.md");
      taskBrief(SAMPLE_PLAN, 1, tsOut);
      expect(readFileSync(tsOut)).toEqual(readFileSync(TASK1_BRIEF_GOLDEN));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("reviewPackage: file content matches git ground truth (commits + stat + -U10 diff)", () => {
    const root = tmpRoot("sdd-rp-contract-");
    const out = tmpRoot("sdd-rp-contract-out-");
    try {
      const { base, head } = gitFixture(root);
      const tsOut = join(out, "ts.diff");
      reviewPackage(base, head, tsOut, { cwd: root });
      const run = (args: string[]): Buffer =>
        execFileSync("git", args, { cwd: root }) as Buffer;
      const expected = Buffer.concat([
        Buffer.from(`# Review package: ${base}..${head}\n\n## Commits\n`),
        run(["log", "--oneline", `${base}..${head}`]),
        Buffer.from("\n## Files changed\n"),
        run(["diff", "--stat", `${base}..${head}`]),
        Buffer.from("\n## Diff\n"),
        run(["diff", "-U10", `${base}..${head}`]),
      ]);
      expect(readFileSync(tsOut)).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("reviewPackage: >1MiB diff does not hit the default maxBuffer", () => {
    const root = tmpRoot("sdd-rp-large-");
    const out = tmpRoot("sdd-rp-large-out-");
    try {
      // One ~2MiB line changed between commits → the -U10 diff output
      // exceeds Node's default 1 MiB capture cap (qc3 W-2 regression).
      git(["init", "-q"], root);
      git(["config", "user.email", "sdd-test@example.com"], root);
      git(["config", "user.name", "SDD Test"], root);
      const bigLine = "x".repeat(2 * 1024 * 1024);
      writeFileSync(join(root, "big.txt"), `before\n${bigLine}\nafter\n`);
      git(["add", "-A"], root);
      git(["commit", "-q", "-m", "base commit"], root);
      const base = git(["rev-parse", "HEAD"], root);
      writeFileSync(join(root, "big.txt"), `before\n${bigLine}!\nafter\n`);
      git(["add", "-A"], root);
      git(["commit", "-q", "-m", "head commit"], root);
      const head = git(["rev-parse", "HEAD"], root);

      const tsOut = join(out, "ts-large.diff");
      expect(() => reviewPackage(base, head, tsOut, { cwd: root })).not.toThrow();
      // Guard: the fixture really exceeds the old 1 MiB cap — without this
      // the test would pass vacuously if the diff shrank below the cap.
      expect(statSync(tsOut).size).toBeGreaterThan(1024 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("repo under a directory named 'worktrees' is classified as linked (fail-closed)", () => {
    const parent = tmpRoot("sdd-wt-");
    const root = join(parent, "worktrees", "proj");
    try {
      mkdirSync(root, { recursive: true });
      git(["init", "-q"], root);
      git(["config", "user.email", "sdd-test@example.com"], root);
      git(["config", "user.name", "SDD Test"], root);
      writeFileSync(join(root, "a.txt"), "a\n");
      git(["add", "-A"], root);
      git(["commit", "-q", "-m", "base commit"], root);
      // The `git_dir` path contains `/worktrees/` → the substring branch
      // classifies this MAIN checkout as linked and fails closed —
      // documented in `isLinkedWorktree` (qc3 S-2).
      const err = errOf(() => sddWorkspace("parity-plan", { cwd: root }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("linked worktree");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("stray status.json in a linked worktree: fail-closed first (intentional divergence)", () => {
    const main = tmpRoot("sdd-stray-main-");
    const parent = tmpRoot("sdd-stray-parent-");
    try {
      gitFixture(main);
      const linked = join(parent, "linked");
      mkdirSync(dirname(linked), { recursive: true });
      git(["worktree", "add", "-q", linked, "-b", "feature/stray"], main);
      // Stray `.mstar/status.json` under the feature checkout (default
      // gitignore lets it exist uncommitted). A status.json-first probe
      // would resolve and create a second SDD tree under the feature
      // checkout (the hazard); the engine guards FIRST (fail-closed-before-
      // override, mstar-branch-worktree «Harness path SSOT under default
      // gitignore») and refuses regardless of the probe result (qc2 F-004,
      // intentional divergence).
      mkdirSync(join(linked, ".mstar"), { recursive: true });
      writeFileSync(join(linked, ".mstar", "status.json"), "{}\n");
      const err = errOf(() => sddWorkspace("parity-plan", { cwd: linked }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toMatch(/Refusing to create a second SDD tree/);
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
