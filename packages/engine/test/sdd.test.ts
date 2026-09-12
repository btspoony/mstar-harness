/**
 * Engine sdd module — SDD loop state machine + the engine implementations
 * of the SDD workspace / task-brief / review-package helpers (CLI form:
 * `mstar sdd workspace|task-brief|review-package`).
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - Per-task loop, BASE_SHA rule, progress ledger, model tiers, red flags:
 * `skills/mstar-sdd/SKILL.md` § Per-task loop, § Progress ledger,
 * § Red flags (NEVER) — `HEAD~1` as review BASE, resume without
 * `host_agent_id`, re-dispatch of completed tasks, skip task review.
 * - Helper contracts: `skills/mstar-sdd/SKILL.md` § CLI table
 * (`sddWorkspace`, `taskBrief`, `reviewPackage`). Golden-fixture parity:
 * the task-brief extraction output is compared against a fixture captured
 * from the former bash oracle (byte-proven in slice 2, scripts removed in
 * slice 5); path-shaped outputs (workspace resolution, review-package
 * files) are asserted directly against git/fs ground truth.
 * - File handoffs (task-N-report.md, review-package usage):
 * `skills/mstar-sdd/references/file-handoffs.md`.
 * - Sticky implementer session (host_agent_id required for resume,
 * micro-batch ≤ 3, fresh fallback, reviewers never sticky):
 * `skills/mstar-sdd/references/sticky-implementer-session.md` +
 * SKILL.md red flag "Resume implementer without host_agent_id".
 * - Harness-root override (`MSTAR_HARNESS_DIR` env / option) in addition
 * to CONTROL_ROOT, because the status.json probe only knows `.mstar`/`.agents`
 * and misses repos with another root.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  SddScriptError,
  assertBaseSha,
  checkSddAction,
  implementerSessionStickyRules,
  readProgressLedger,
  resolveSddExecutionContext,
  reviewPackage,
  runInSddContext,
  sddWorkspace,
  taskBrief,
  taskReportExists,
  type ImplementerSessionLedger,
  type SddExecutionContext,
} from "../src/sdd.js";

const MSTAR_CONTROL_ROOT = "MSTAR_CONTROL_ROOT";
const MSTAR_HARNESS_DIR = "MSTAR_HARNESS_DIR";
const SDD_DIR = "SDD_DIR";

/** Ambient env vars `sddWorkspace` / `taskBrief` / `reviewPackage` read. */
const AMBIENT_ENV_KEYS = [MSTAR_CONTROL_ROOT, MSTAR_HARNESS_DIR, SDD_DIR] as const;
const ambientEnvValues = new Map<string, string | undefined>(
  AMBIENT_ENV_KEYS.map((key) => [key, process.env[key]]),
);

// Env pinning : `sddWorkspace` reads MSTAR_CONTROL_ROOT and
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

/** Async twin of `errOf` for the launcher's promise rejections. */
async function errOfAsync(fn: () => Promise<unknown>): Promise<SddScriptError> {
  try {
    await fn();
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
 // probe semantics unchanged (root status.json existence) PLUS
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

  test("probes a custom `.mstarc` workflow_dir via the engine resolver (Phase-5 F1)", () => {
 // The v3 snapshot probe must look under the DECLARED workflow_dir
 // (`.mstarc` `[config] workflow_dir`) — the hardcoded `workflows`
 // name would miss the active lifecycle and the probe would fall
 // through to the decoy default-layout `.mstar/` root (wrong root
 // for a custom layout). Assert the declared dir is consulted.
    const root = tmpRoot("sdd-ws-custom-wf-");
    try {
      git(["init", "-q"], root);
 // Decoy default-layout root: exists, but carries no status.json
 // and no workflows/ — it must NOT win over the active lifecycle.
      mkdirSync(join(root, ".mstar"), { recursive: true });
      mkdirSync(join(root, ".agents", "cw-wf", "wf-1"), { recursive: true });
      writeFileSync(join(root, ".agents", ".mstarc"), "[config]\nworkflow_dir=cw-wf\n", "utf8");
      writeFileSync(
        join(root, ".agents", "cw-wf", "wf-1", "snapshot.json"),
        JSON.stringify({ schema_version: 1, id: "wf-1", type: "plan", status: "running", started_at: "2026-08-19T08:00:00Z", updated_at: "2026-08-19", plans: [] }),
        "utf8",
      );
      const dir = sddWorkspace("plan-1", { cwd: root });
      expect(dir).toBe(realpathSync(join(root, ".agents", "sdd", "plan-1")));
 // The default-layout dirs are never consulted.
      expect(existsSync(join(root, ".mstar", "sdd"))).toBe(false);
      expect(existsSync(join(root, ".agents", "workflows"))).toBe(false);
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

  test("discovery from a linked checkout reaches only main — the SDD tree lands on the main worktree", () => {
    const main = tmpRoot("sdd-ws-main-");
    const parent = tmpRoot("sdd-ws-parent-");
    try {
      gitFixture(main);
      const linked = join(parent, "linked");
      mkdirSync(dirname(linked), { recursive: true });
      git(["worktree", "add", "-q", linked, "-b", "feature/linked"], main);
 // no explicit root: Git-derived main discovery (first worktree record)
 // resolves the main worktree and the SDD tree is created THERE — never a
 // second SDD tree under the feature checkout.
      const dir = sddWorkspace("plan-1", { cwd: linked });
      expect(dir).toBe(realpathSync(join(main, ".mstar", "sdd", "plan-1")));
      expect(existsSync(join(linked, ".mstar"))).toBe(false);
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("harness override from a linked checkout resolves against the main root, never the feature checkout", () => {
    const main = tmpRoot("sdd-ws-guard-");
    const parent = tmpRoot("sdd-ws-guard-parent-");
    try {
      gitFixture(main);
      const linked = join(parent, "linked");
      mkdirSync(dirname(linked), { recursive: true });
      git(["worktree", "add", "-q", linked, "-b", "feature/guarded"], main);
      withEnv(MSTAR_HARNESS_DIR, ".custom-root", () => {
        const dir = sddWorkspace("plan-1", { cwd: linked });
        expect(dir).toBe(realpathSync(join(main, ".custom-root", "sdd", "plan-1")));
        expect(existsSync(join(linked, ".custom-root"))).toBe(false);
        expect(existsSync(join(linked, ".mstar"))).toBe(false);
      });
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("an override redirecting the process SSOT into the linked checkout is refused and writes nowhere", () => {
    const main = tmpRoot("sdd-ws-redirect-");
    const parent = tmpRoot("sdd-ws-redirect-parent-");
    try {
      gitFixture(main);
      const linked = join(parent, "linked");
      mkdirSync(dirname(linked), { recursive: true });
      git(["worktree", "add", "-q", linked, "-b", "feature/redirect"], main);
      withEnv(MSTAR_HARNESS_DIR, join(linked, "harness-redirect"), () => {
        const err = errOf(() => sddWorkspace("plan-1", { cwd: main }));
        expect(err.exitCode).toBe(1);
        expect(err.message).toContain("linked");
        expect(existsSync(join(linked, "harness-redirect"))).toBe(false);
        expect(existsSync(join(linked, ".mstar"))).toBe(false);
      });
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("failed main discovery writes nowhere (fail-closed before any mkdir)", () => {
    const root = tmpRoot("sdd-ws-faildisc-");
    try {
      gitFixture(root);
 // A hung git (slow shim + bounded probe timeout) makes main discovery
 // return null — the workspace must refuse BEFORE resolving any harness
 // dir or creating anything.
      const shim = join(root, "shim");
      mkdirSync(shim, { recursive: true });
      const fakeGit = join(shim, "git");
      writeFileSync(fakeGit, "#!/bin/sh\nsleep 30\nexit 0\n", { mode: 0o755 });
      chmodSync(fakeGit, 0o755);
      const previousPath = process.env.PATH;
      const previousTimeout = process.env.MSTAR_GIT_PROBE_TIMEOUT_MS;
      process.env.PATH = `${shim}:${previousPath ?? ""}`;
      process.env.MSTAR_GIT_PROBE_TIMEOUT_MS = "300";
      try {
        const err = errOf(() => sddWorkspace("plan-1", { cwd: root }));
        expect(err.exitCode).toBe(1);
        expect(err.message).toContain("main worktree");
        expect(existsSync(join(root, ".mstar"))).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousTimeout === undefined) delete process.env.MSTAR_GIT_PROBE_TIMEOUT_MS;
        else process.env.MSTAR_GIT_PROBE_TIMEOUT_MS = previousTimeout;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an explicit control root that is an integration/foreign linked checkout is refused, not silently redirected", () => {
    const main = tmpRoot("sdd-ws-foreign-");
    const parent = tmpRoot("sdd-ws-foreign-parent-");
    try {
      gitFixture(main);
      const linked = join(parent, "linked");
      mkdirSync(dirname(linked), { recursive: true });
      git(["worktree", "add", "-q", linked, "-b", "feature/foreign"], main);
      const err = errOf(() => sddWorkspace("plan-1", { cwd: linked, controlRoot: linked }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("main worktree");
      expect(existsSync(join(linked, ".mstar"))).toBe(false);
      expect(existsSync(join(main, ".mstar"))).toBe(false);
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("an explicit control root on the main worktree itself is verified and used", () => {
    const main = tmpRoot("sdd-ws-explicit-main-");
    const parent = tmpRoot("sdd-ws-explicit-parent-");
    try {
      gitFixture(main);
      const linked = join(parent, "linked");
      mkdirSync(dirname(linked), { recursive: true });
      git(["worktree", "add", "-q", linked, "-b", "feature/elsewhere"], main);
      const dir = sddWorkspace("plan-1", { cwd: linked, controlRoot: main });
      expect(dir).toBe(realpathSync(join(main, ".mstar", "sdd", "plan-1")));
      expect(existsSync(join(linked, ".mstar"))).toBe(false);
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

  test("an EMPTY range fails loudly (exit 1) and writes nothing", () => {
    // Regression: from the control checkout the range resolves to nothing
    // (HEAD === base), and the command used to exit 0 with a ~72-byte package
    // whose `## Commits` / `## Diff` sections were empty — a QC seat would be
    // handed a file with nothing to review while every exit code stayed 0.
    const root = tmpRoot("sdd-rp-");
    const out = tmpRoot("sdd-rp-out-");
    try {
      const { head } = gitFixture(root);
      const file = join(out, "empty.diff");
      const empty = errOf(() => reviewPackage(head, head, file, { cwd: root }));
      expect(empty.exitCode).toBe(1);
      expect(empty.message).toContain("is empty in");
      expect(empty.message).toContain(root);
      expect(empty.message).toContain("refusing to write an empty package");
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
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

  test("sddWorkspace fail-closed: no verified main worktree refuses with exit 1 (non-Git cwd, no explicit root)", () => {
    const root = tmpRoot("sdd-fc-nongit-");
    try {
 // Automatic non-Git discovery never authorizes an SDD write: without a
 // Git-verified main worktree the engine refuses before resolving any
 // harness dir — nothing is written anywhere.
      const err = errOf(() => sddWorkspace("parity-plan", { cwd: root }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("cannot verify the main worktree");
      expect(err.message).toContain("or: mstar sdd workspace parity-plan <main-repo-root>");
      expect(existsSync(join(root, ".mstar"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
 // exceeds Node's default 1 MiB capture cap (regression).
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

  test("a main checkout under a directory named 'worktrees' verifies as its own main (Git identity, not path substring)", () => {
    const parent = tmpRoot("sdd-wt-");
    const root = join(parent, "worktrees", "proj");
    try {
      mkdirSync(root, { recursive: true });
      gitFixture(root);
 // Git-worktree discovery (first porcelain record) classifies by checkout
 // identity, not by a `/worktrees/` substring: this MAIN checkout verifies
 // as its own main and the SDD tree is created at its own harness.
      const dir = sddWorkspace("parity-plan", { cwd: root });
      expect(dir).toBe(realpathSync(join(root, ".mstar", "sdd", "parity-plan")));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("stray status.json in a linked worktree never wins — discovery reaches main only", () => {
    const main = tmpRoot("sdd-stray-main-");
    const parent = tmpRoot("sdd-stray-parent-");
    try {
      gitFixture(main);
      const linked = join(parent, "linked");
      mkdirSync(dirname(linked), { recursive: true });
      git(["worktree", "add", "-q", linked, "-b", "feature/stray"], main);
 // Stray `.mstar/status.json` under the feature checkout (default
 // gitignore lets it exist uncommitted). A status.json-first probe would
 // resolve the linked checkout and create a second SDD tree there; the
 // Git-derived main discovery ignores the stray and writes only at main.
      mkdirSync(join(linked, ".mstar"), { recursive: true });
      writeFileSync(join(linked, ".mstar", "status.json"), "{}\n");
      const dir = sddWorkspace("parity-plan", { cwd: linked });
      expect(dir).toBe(realpathSync(join(main, ".mstar", "sdd", "parity-plan")));
      expect(existsSync(join(linked, ".mstar", "sdd"))).toBe(false);
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SDD execution context + action checks (spec A3, plan
// 20260907-sdd-execution-paths Task 1). Fixtures build separate disposable
// primary / control / feature checkouts with real `git worktree add` — never
// the real main checkout. Checks must be read-only.
// ---------------------------------------------------------------------------

type ExecutionFixture = {
  root: string;
 /** Disposable "primary checkout" on `main` — stands in for the incident scene. */
  primary: string;
 /** Control worktree on an integration branch, carrying the control harness. */
  control: string;
 /** Feature worktree on the plan's Working branch. */
  feature: string;
  harnessDir: string;
  planId: string;
  planFile: string;
  sddDir: string;
  workingBranch: string;
};

const PLAN_ID = "20260907-sdd-execution-paths";

function executionFixture(root: string, opts: { nested?: boolean; nestedHarness?: boolean } = {}): ExecutionFixture {
  const primary = join(root, "primary");
  mkdirSync(primary);
  git(["init", "-q"], primary);
  git(["checkout", "-q", "-b", "main"], primary); // deterministic default branch
  git(["config", "user.email", "sdd-test@example.com"], primary);
  git(["config", "user.name", "SDD Test"], primary);
  writeFileSync(join(primary, "src-sentinel.txt"), "primary source sentinel\n");
  mkdirSync(join(primary, "src"));
  writeFileSync(join(primary, "src", "module.ts"), "export const primary = true;\n");
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

  // Nested-harness variant: the harness sits under a configured subdir of
  // the control checkout (`<control>/state/.mstar`) — the resolver must
  // derive the real checkout root by git probe, never dirname(harness).
  const harnessDir = opts.nestedHarness ? join(control, "state", ".mstar") : join(control, ".mstar");
  const planFile = join(harnessDir, "plans", `${PLAN_ID}.md`);
  mkdirSync(dirname(planFile), { recursive: true });
  writeFileSync(
    planFile,
    "# Plan\n\n**Main worktree branch**: main\n\n## Task 1\n\n- implement\n",
  );
  const sddDir = join(harnessDir, "sdd", PLAN_ID);
  mkdirSync(sddDir, { recursive: true });
  return { root, primary, control, feature, harnessDir, planId: PLAN_ID, planFile, sddDir, workingBranch };
}

function contextOf(f: ExecutionFixture): SddExecutionContext {
  return {
    planId: f.planId,
    controlHarnessRoot: f.harnessDir,
    featureCwd: f.feature,
    workingBranch: f.workingBranch,
    planFile: f.planFile,
    sddDir: f.sddDir,
  };
}

function executionLease(f: ExecutionFixture, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    holder: "fullstack-dev-2",
    claimed_at: "2026-09-07T00:00:00Z",
    worktree_path: f.feature,
    working_branch: f.workingBranch,
    ...overrides,
  };
}

function writeSnapshot(f: ExecutionFixture, workflowId: string, plans: unknown[], extra: Record<string, unknown> = {}): void {
  const dir = join(f.harnessDir, "workflows", workflowId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ schema_version: 1, ...extra, plans }));
}

/**
 * Write the v2 root `status.json` register listing the given workflow ids as
 * ACTIVE lifecycles (removal-at-terminal: the register holds the live set).
 */
function writeStatusRegister(f: ExecutionFixture, workflowIds: string[]): void {
  writeFileSync(
    join(f.harnessDir, "status.json"),
    JSON.stringify({
      version: 2,
      updated_at: "2026-09-07",
      workflows: workflowIds.map((id) => ({ id, type: "plan", started_at: "2026-09-07T00:00:00Z", dir: `workflows/${id}` })),
    }),
    "utf8",
  );
}

function codesOf(result: { ok: boolean; violations: { code: string }[] }): string[] {
  return result.violations.map((v) => v.code);
}

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      out.push(relative(root, join(dir, entry.name)));
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };
  walk(root);
  return out;
}

describe("resolveSddExecutionContext — A3 declared-context resolution", () => {
  test("resolves against the declared control root and canonicalizes every path", () => {
    const root = tmpRoot("sdd-ctx-ok-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
      expect(resolved.planId).toBe(PLAN_ID);
      expect(resolved.workingBranch).toBe(f.workingBranch);
      expect(resolved.controlHarnessRoot).toBe(realpathSync(f.harnessDir));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));
      expect(resolved.planFile).toBe(realpathSync(f.planFile));
      expect(resolved.sddDir).toBe(realpathSync(f.sddDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mismatched declared branch fails the gate (exit 1, reused worktree.branch-mismatch)", () => {
    const root = tmpRoot("sdd-ctx-branch-");
    try {
      const f = executionFixture(root);
      const err = errOf(() => resolveSddExecutionContext({ ...contextOf(f), workingBranch: "feature/other" }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.branch-mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing feature worktree fails the gate (exit 1)", () => {
    const root = tmpRoot("sdd-ctx-nofeature-");
    try {
      const f = executionFixture(root);
      const err = errOf(() =>
        resolveSddExecutionContext({ ...contextOf(f), featureCwd: join(root, "no-such-feature") }),
      );
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.feature-cwd-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("usage errors are exit 2: relative paths, unsafe planId, plan/sdd identity mismatch", () => {
    const root = tmpRoot("sdd-ctx-usage-");
    try {
      const f = executionFixture(root);
      expect(errOf(() => resolveSddExecutionContext({ ...contextOf(f), controlHarnessRoot: "relative/.mstar" })).exitCode).toBe(2);
      expect(errOf(() => resolveSddExecutionContext({ ...contextOf(f), planId: "../escape" })).exitCode).toBe(2);
      expect(errOf(() => resolveSddExecutionContext({ ...contextOf(f), sddDir: join(f.harnessDir, "sdd", "other-plan") })).exitCode).toBe(2);
      expect(errOf(() => resolveSddExecutionContext({ ...contextOf(f), planFile: join(f.harnessDir, "plans", "other-plan.md") })).exitCode).toBe(2);
      expect(errOf(() => resolveSddExecutionContext({ ...contextOf(f), planFile: join(f.harnessDir, "plans", "no-such-plan.md") })).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("feature cwd inside the control checkout is refused (L1 hard rule, exit 1)", () => {
    const root = tmpRoot("sdd-ctx-nest1-");
    try {
      const f = executionFixture(root);
      mkdirSync(join(f.control, "accidental-feature"));
      const err = errOf(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: join(f.control, "accidental-feature") }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.feature-in-control");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("control harness declared inside the feature checkout is refused (exit 1)", () => {
    const root = tmpRoot("sdd-ctx-nest2-");
    try {
      const f = executionFixture(root);
      const strayHarness = join(f.feature, ".mstar", "nested-harness");
      const strayPlan = join(strayHarness, "plans", `${PLAN_ID}.md`);
      mkdirSync(dirname(strayPlan), { recursive: true });
      writeFileSync(strayPlan, "# stray\n");
      const err = errOf(() =>
        resolveSddExecutionContext({
          ...contextOf(f),
          controlHarnessRoot: strayHarness,
          planFile: strayPlan,
          sddDir: join(strayHarness, "sdd", PLAN_ID),
        }),
      );
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.control-inside-feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nested feature worktree inside the control checkout passes (real linked worktree, arbitrary folder name)", () => {
    const root = tmpRoot("sdd-ctx-nested-ok-");
    try {
      const f = executionFixture(root, { nested: true });
      const resolved = resolveSddExecutionContext(contextOf(f));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));
      expect(resolved.controlHarnessRoot).toBe(realpathSync(f.harnessDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nested feature worktree with a verified lease resolves (L1 + lease binding)", () => {
    const root = tmpRoot("sdd-ctx-nested-lease-");
    try {
      const f = executionFixture(root, { nested: true });
      writeSnapshot(f, "wf-1", [{ id: PLAN_ID, status: "InProgress", execution_lease: executionLease(f) }]);
      const resolved = resolveSddExecutionContext(contextOf(f));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("coherent harness alias passes (control harness root declared through a symlink alias)", () => {
    const root = tmpRoot("sdd-ctx-alias-ok-");
    try {
      const f = executionFixture(root, { nested: true });
      const alias = join(root, "control-alias");
      symlinkSync(f.control, alias);
      const aliasHarness = join(alias, ".mstar");
      const resolved = resolveSddExecutionContext({
        ...contextOf(f),
        controlHarnessRoot: aliasHarness,
        planFile: join(aliasHarness, "plans", `${PLAN_ID}.md`),
        sddDir: join(aliasHarness, "sdd", PLAN_ID),
      });
      expect(resolved.controlHarnessRoot).toBe(realpathSync(f.harnessDir));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("feature cwd equal to the control checkout is refused (exit 1)", () => {
    const root = tmpRoot("sdd-ctx-same-");
    try {
      const f = executionFixture(root);
      const err = errOf(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: f.control }));
      expect(err.exitCode).toBe(1);
      // The control harness lives inside the feature cwd (the control
      // checkout itself) — control-inside-feature is the first gate.
      expect(err.message).toContain("sdd.context.control-inside-feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlink alias of the control checkout is refused as feature cwd (exit 1)", () => {
    const root = tmpRoot("sdd-ctx-alias-neg-");
    try {
      const f = executionFixture(root);
      const alias = join(root, "control-alias");
      symlinkSync(f.control, alias);
      const err = errOf(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: alias }));
      expect(err.exitCode).toBe(1);
      // The alias canonicalizes to the control checkout, whose harness is
      // inside the feature cwd — control-inside-feature is the first gate.
      expect(err.message).toContain("sdd.context.control-inside-feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plain subdirectory of the control checkout refused even when the declared branch equals the control branch (exit 1)", () => {
    const root = tmpRoot("sdd-ctx-branch-eq-");
    try {
      const f = executionFixture(root);
      const subdir = join(f.control, "plain-subdir");
      mkdirSync(subdir);
      const controlBranch = git(["branch", "--show-current"], f.control);
      const err = errOf(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: subdir, workingBranch: controlBranch }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.feature-in-control");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured nested harness (standalone): nested real linked worktree passes", () => {
    const root = tmpRoot("sdd-ctx-nested-harness-ok-");
    try {
      const f = executionFixture(root, { nested: true, nestedHarness: true });
      const resolved = resolveSddExecutionContext(contextOf(f));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));
      expect(resolved.controlHarnessRoot).toBe(realpathSync(f.harnessDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured nested harness (standalone): plain subdirectory of the control checkout refused", () => {
    const root = tmpRoot("sdd-ctx-nested-harness-subdir-");
    try {
      const f = executionFixture(root, { nestedHarness: true });
      const subdir = join(f.control, "plain-feature");
      mkdirSync(subdir);
      const controlBranch = git(["branch", "--show-current"], f.control);
      const err = errOf(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: subdir, workingBranch: controlBranch }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.feature-in-control");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured nested harness (standalone): symlink alias of the control checkout refused", () => {
    const root = tmpRoot("sdd-ctx-nested-harness-alias-");
    try {
      const f = executionFixture(root, { nestedHarness: true });
      const alias = join(root, "control-alias");
      symlinkSync(f.control, alias);
      const controlBranch = git(["branch", "--show-current"], f.control);
      const err = errOf(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: alias, workingBranch: controlBranch }));
      expect(err.exitCode).toBe(1);
      // The alias canonicalizes to the control checkout, whose harness is
      // inside the feature cwd — control-inside-feature is the first gate.
      expect(err.message).toContain("sdd.context.control-inside-feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured nested harness (active lease): nested real linked worktree passes; plain subdir lease refused", () => {
    const root = tmpRoot("sdd-ctx-nested-harness-lease-");
    try {
      const f = executionFixture(root, { nested: true, nestedHarness: true });
      writeSnapshot(f, "wf-1", [{ id: PLAN_ID, status: "InProgress", execution_lease: executionLease(f) }]);
      const resolved = resolveSddExecutionContext(contextOf(f));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));

      // A lease naming a plain subdirectory of the harness checkout is not
      // the context's feature worktree — the context binding refuses it
      // (the L1 pairwise identity check compares against the MAIN worktree
      // and the snapshot's integration checkout, not the harness checkout).
      const subdir = join(f.control, "plain-feature");
      mkdirSync(subdir);
      const controlBranch = git(["branch", "--show-current"], f.control);
      writeSnapshot(f, "wf-1", [
        { id: PLAN_ID, status: "InProgress", execution_lease: executionLease(f, { worktree_path: subdir, working_branch: controlBranch }) },
      ]);
      const err = errOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.lease-worktree-mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a lease naming a plain subdirectory of the MAIN worktree is refused by L1 (lease-equals-main)", () => {
    const root = tmpRoot("sdd-ctx-lease-mainsub-");
    try {
      const f = executionFixture(root);
      const subdir = join(f.primary, "plain-subdir");
      mkdirSync(subdir);
      writeSnapshot(f, "wf-1", [
        { id: PLAN_ID, status: "InProgress", execution_lease: executionLease(f, { worktree_path: subdir, working_branch: "feature/sub" }) },
      ]);
      const err = errOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.l1.lease-equals-main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("active workflow lease matching the context resolves; a mismatching context is refused", () => {
    const root = tmpRoot("sdd-ctx-lease-");
    try {
      const f = executionFixture(root);
      writeSnapshot(f, "wf-1", [{ id: PLAN_ID, status: "InProgress", execution_lease: executionLease(f) }]);
      const resolved = resolveSddExecutionContext(contextOf(f));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));

 // Context featureCwd ≠ verified lease worktree (lease points at the
 // primary checkout on main) — the L1 gate refuses first: the feature
 // worktree MUST be a distinct checkout from the MAIN worktree.
      writeSnapshot(f, "wf-1", [
        { id: PLAN_ID, status: "InProgress", execution_lease: executionLease(f, { worktree_path: f.primary, working_branch: "main" }) },
      ]);
      const worktreeErr = errOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(worktreeErr.exitCode).toBe(1);
      expect(worktreeErr.message).toContain("worktree.l1.lease-equals-main");

 // Context workingBranch ≠ verified lease branch (lease matches the real
 // checkout; the declared branch is what differs).
      writeSnapshot(f, "wf-1", [{ id: PLAN_ID, status: "InProgress", execution_lease: executionLease(f) }]);
      const branchErr = errOf(() => resolveSddExecutionContext({ ...contextOf(f), workingBranch: "feature/other" }));
      expect(branchErr.exitCode).toBe(1);
      expect(branchErr.message).toContain("sdd.context.lease-branch-mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("InProgress row without a lease is the orphan refusal (exit 1)", () => {
    const root = tmpRoot("sdd-ctx-orphan-");
    try {
      const f = executionFixture(root);
      writeSnapshot(f, "wf-1", [{ id: PLAN_ID, status: "InProgress" }]);
      const err = errOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("lease.verify.orphan");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("standalone behavior is preserved: no snapshot / non-InProgress row without lease", () => {
    const root = tmpRoot("sdd-ctx-standalone-");
    try {
      const f = executionFixture(root);
 // No workflow snapshots at all — existing branch policy only.
      expect(resolveSddExecutionContext(contextOf(f)).planId).toBe(PLAN_ID);
 // A finished plan row without a lease never mandates one.
      writeSnapshot(f, "wf-done", [{ id: PLAN_ID, status: "Done" }]);
      expect(resolveSddExecutionContext(contextOf(f)).planId).toBe(PLAN_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the registered active workflow's lease governs even when a retained terminal snapshot also lists the plan", () => {
    const root = tmpRoot("sdd-ctx-terminal-shadow-");
    try {
      const f = executionFixture(root);
 // A completed lifecycle's snapshot stays on disk next to the live one;
 // the root register names the live workflow, and scan order must never
 // let the retained terminal row shadow it.
      writeSnapshot(f, "wf-completed", [
        { id: PLAN_ID, title: "finished run", file: `plans/${PLAN_ID}.md`, status: "Done" },
      ]);
      writeSnapshot(f, "wf-live", [
        { id: PLAN_ID, title: "live run", file: `plans/${PLAN_ID}.md`, status: "InProgress", execution_lease: executionLease(f) },
      ]);
      writeStatusRegister(f, ["wf-live"]);
      expect(resolveSddExecutionContext(contextOf(f)).planId).toBe(PLAN_ID);

 // The ACTIVE row's lease is what got enforced: point that lease at the
 // primary checkout (main) and the L1 gate refuses with lease-equals-main —
 // a terminal-row win would have fallen through to standalone success.
      writeSnapshot(f, "wf-live", [
        {
          id: PLAN_ID,
          title: "live run",
          file: `plans/${PLAN_ID}.md`,
          status: "InProgress",
          execution_lease: executionLease(f, { worktree_path: f.primary, working_branch: "main" }),
        },
      ]);
      const err = errOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.l1.lease-equals-main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a plan claimed by two registered active workflows fails closed (never a silent standalone fallback)", () => {
    const root = tmpRoot("sdd-ctx-ambiguous-");
    try {
      const f = executionFixture(root);
 // Both rows' leases match the declared context, so a silent standalone
 // fallback would RESOLVE — the refusal itself is the contract.
      writeStatusRegister(f, ["wf-a", "wf-b"]);
      const row = {
        id: PLAN_ID,
        title: "claimed twice",
        file: `plans/${PLAN_ID}.md`,
        status: "InProgress",
        execution_lease: executionLease(f),
      };
      writeSnapshot(f, "wf-a", [row]);
      writeSnapshot(f, "wf-b", [row]);
      const err = errOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.workflow-plan-ambiguous");
      expect(err.message).toContain("wf-a");
      expect(err.message).toContain("wf-b");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a plan matching only unregistered (terminal) snapshots gets the standalone branch policy", () => {
    const root = tmpRoot("sdd-ctx-terminal-only-");
    try {
      const f = executionFixture(root);
 // The register names a different live workflow; the plan's only snapshot
 // row belongs to a retained completed lifecycle and carries a stale
 // lease that must NOT satisfy lease enforcement.
      writeStatusRegister(f, ["wf-other"]);
      writeSnapshot(f, "wf-other", [
        { id: "another-plan", title: "other plan", file: "plans/another-plan.md", status: "InProgress" },
      ]);
      writeSnapshot(f, "wf-finished", [
        {
          id: PLAN_ID,
          title: "finished",
          file: `plans/${PLAN_ID}.md`,
          status: "Done",
          execution_lease: executionLease(f, { worktree_path: f.primary, working_branch: "main" }),
        },
      ]);
      expect(resolveSddExecutionContext(contextOf(f)).planId).toBe(PLAN_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("residency expectation: recorded plan header wins, explicit branch.base is the fallback, neither refuses", () => {
    const root = tmpRoot("sdd-ctx-mainbranch-");
    try {
      const f = executionFixture(root);
      const row = { id: PLAN_ID, status: "InProgress", execution_lease: executionLease(f) };
 // Recorded plan header (the fixture plan carries "Main worktree branch:
 // main") — resolves.
      writeSnapshot(f, "wf-1", [row]);
      expect(resolveSddExecutionContext(contextOf(f)).planId).toBe(PLAN_ID);
 // Headerless plan falls back conservatively to the snapshot's explicit
 // branch.base — never the branch observed at check time.
      writeFileSync(f.planFile, "# Plan\n\n## Task 1\n\n- implement\n");
      writeSnapshot(f, "wf-1", [row], { branch: { base: "main" } });
      expect(resolveSddExecutionContext(contextOf(f)).planId).toBe(PLAN_ID);
 // Neither recorded header nor branch.base → expected-branch-missing refusal.
      writeSnapshot(f, "wf-1", [row]);
      const err = errOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.main.expected-branch-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an iteration snapshot's integration worktree drives the full L1 checks", () => {
    const root = tmpRoot("sdd-ctx-iteration-");
    try {
      const f = executionFixture(root);
      const row = { id: PLAN_ID, status: "InProgress", execution_lease: executionLease(f) };
 // Aligned, distinct integration checkout (the control worktree is on the
 // integration branch in this fixture) — full checks pass.
      writeSnapshot(f, "wf-iter", [row], {
        type: "iteration",
        integration_worktree_path: f.control,
        branch: { integration: "codex/iter-integration" },
      });
      expect(resolveSddExecutionContext(contextOf(f)).planId).toBe(PLAN_ID);
 // Integration checkout IS the main worktree → integration-equals-main.
      writeSnapshot(f, "wf-iter", [row], {
        type: "iteration",
        integration_worktree_path: f.primary,
        branch: { integration: "main" },
      });
      const eqMain = errOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(eqMain.exitCode).toBe(1);
      expect(eqMain.message).toContain("worktree.l1.integration-equals-main");
 // Feature worktree equals the integration checkout → lease-equals-integration.
      writeSnapshot(f, "wf-iter", [row], {
        type: "iteration",
        integration_worktree_path: f.feature,
        branch: { integration: f.workingBranch },
      });
      const eqLease = errOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(eqLease.exitCode).toBe(1);
      expect(eqLease.message).toContain("worktree.l1.lease-equals-integration");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a declared control root is never re-inferred from a stray feature-local harness", () => {
    const root = tmpRoot("sdd-ctx-stray-");
    try {
      const f = executionFixture(root);
 // Feature-local second-harness shape (the Aug-26 incident scene).
      const straySdd = join(f.feature, ".mstar", "sdd", PLAN_ID);
      mkdirSync(straySdd, { recursive: true });
      writeFileSync(join(f.feature, ".mstar", "status.json"), "{}\n");
      const resolved = resolveSddExecutionContext(contextOf(f));
      expect(resolved.controlHarnessRoot).toBe(realpathSync(f.harnessDir));
 // …and the artifact gate refuses the stray feature-local SDD tree.
      const stray = checkSddAction(resolved, {
        kind: "artifact",
        cwd: f.feature,
        target: join(straySdd, "task-1-brief.md"),
      });
      expect(stray.ok).toBe(false);
      expect(codesOf(stray)).toContain("sdd.context.artifact-outside-plan");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkSddAction — A3 source/artifact/launch seams", () => {
  test("correct declared context with wrong actual source cwd fails", () => {
    const root = tmpRoot("sdd-act-wrongcwd-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
      const result = checkSddAction(resolved, { kind: "source", cwd: f.primary, target: "src/probe.txt" });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("sdd.context.source-cwd-outside-feature");
 // Unrelated directory outside both checkouts is equally refused.
      const unrelated = checkSddAction(resolved, { kind: "source", cwd: root, target: "probe.txt" });
      expect(codesOf(unrelated)).toContain("sdd.context.source-cwd-outside-feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("safe relative nested source passes; traversal and absolute escape fail", () => {
    const root = tmpRoot("sdd-act-nested-");
    try {
      const f = executionFixture(root);
      const nested = join(f.feature, "src", "nested");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "writer.ts"), "export const w = 1;\n");
      const resolved = resolveSddExecutionContext(contextOf(f));
      expect(
        checkSddAction(resolved, { kind: "source", cwd: nested, target: "../../src/deep/new.txt" }).ok,
      ).toBe(true);
      const traversal = checkSddAction(resolved, { kind: "source", cwd: nested, target: "../../../outside.txt" });
      expect(codesOf(traversal)).toContain("sdd.context.source-target-outside-feature");
      const absolute = checkSddAction(resolved, { kind: "source", cwd: f.feature, target: join(f.primary, "src", "probe.txt") });
      expect(codesOf(absolute)).toContain("sdd.context.source-target-outside-feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlink escape fails before mutation", () => {
    const root = tmpRoot("sdd-act-symlink-");
    try {
      const f = executionFixture(root);
      symlinkSync(join(f.primary, "src"), join(f.feature, "src", "escape"));
      const resolved = resolveSddExecutionContext(contextOf(f));
      const result = checkSddAction(resolved, { kind: "source", cwd: f.feature, target: "src/escape/probe.txt" });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("sdd.context.target-symlink-escape");
 // …and nothing was written through the link.
      expect(existsSync(join(f.primary, "src", "probe.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("valid control artifact targets pass: fresh leaf, nested review dir, repair, planFile", () => {
    const root = tmpRoot("sdd-act-artifact-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
      expect(
        checkSddAction(resolved, { kind: "artifact", cwd: f.feature, target: join(f.sddDir, "task-1-report.md") }).ok,
      ).toBe(true);
      expect(
        checkSddAction(resolved, { kind: "artifact", cwd: f.control, target: join(f.sddDir, "review", "qc1.md") }).ok,
      ).toBe(true);
 // Repair pass: overwriting an existing control artifact is allowed.
      writeFileSync(join(f.sddDir, "task-1-report.md"), "# Task 1 report\n");
      expect(
        checkSddAction(resolved, { kind: "artifact", cwd: f.control, target: join(f.sddDir, "task-1-report.md") }).ok,
      ).toBe(true);
 // The declared planFile itself is a permitted artifact destination.
      expect(checkSddAction(resolved, { kind: "artifact", cwd: f.control, target: f.planFile }).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("arbitrary control source edits and artifact symlink escapes fail", () => {
    const root = tmpRoot("sdd-act-artifact-bad-");
    try {
      const f = executionFixture(root);
      symlinkSync(f.primary, join(f.sddDir, "escape"));
      const resolved = resolveSddExecutionContext(contextOf(f));
      const controlSource = checkSddAction(resolved, {
        kind: "artifact",
        cwd: f.control,
        target: join(f.control, "packages", "engine.ts"),
      });
      expect(codesOf(controlSource)).toContain("sdd.context.artifact-outside-plan");
 // Declared inside the plan's sddDir (resolved context form) but routed
 // through a symlinked ancestor out of the control artifacts.
      const escape = checkSddAction(resolved, {
        kind: "artifact",
        cwd: f.control,
        target: join(resolved.sddDir, "escape", "x.md"),
      });
      expect(codesOf(escape)).toContain("sdd.context.artifact-symlink-escape");
 // …and nothing was written through the link.
      expect(existsSync(join(f.primary, "x.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("launch check verifies the resolved launch destination, not the parent cwd", () => {
    const root = tmpRoot("sdd-act-launch-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
 // Launch may be invoked from control/main — the destination is what is gated.
      expect(checkSddAction(resolved, { kind: "launch", cwd: f.primary }).ok).toBe(true);
      expect(checkSddAction(resolved, { kind: "launch", cwd: f.control }).ok).toBe(true);
 // An optional launch target resolves the way the child would (from featureCwd).
      expect(checkSddAction(resolved, { kind: "launch", cwd: f.primary, target: "src/probe.txt" }).ok).toBe(true);
      const escape = checkSddAction(resolved, { kind: "launch", cwd: f.primary, target: "../../../outside.txt" });
      expect(codesOf(escape)).toContain("sdd.context.launch-target-outside-feature");
 // A branch swapped after resolution still fails the launch gate.
      git(["checkout", "-q", "-b", "feature/detour"], f.feature);
      const branch = checkSddAction(resolved, { kind: "launch", cwd: f.control });
      expect(branch.ok).toBe(false);
      expect(codesOf(branch)).toContain("worktree.branch-mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("checks perform no writes anywhere in the fixture", () => {
    const root = tmpRoot("sdd-act-readonly-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
      const before = listTree(root);
      checkSddAction(resolved, { kind: "artifact", cwd: f.control, target: join(f.sddDir, "review", "qc1.md") });
      checkSddAction(resolved, { kind: "source", cwd: f.feature, target: "src/never.txt" });
      checkSddAction(resolved, { kind: "launch", cwd: f.primary });
      checkSddAction(resolved, { kind: "artifact", cwd: f.control, target: join(f.sddDir, "escape", "x.md") });
      expect(listTree(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("usage-level refusals: unknown kind, missing cwd, artifact without target", () => {
    const root = tmpRoot("sdd-act-usage-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
      expect(codesOf(checkSddAction(resolved, { kind: "rename" as never, cwd: f.feature }))).toContain("sdd.context.kind-unknown");
      expect(codesOf(checkSddAction(resolved, { kind: "source", cwd: "" }))).toContain("sdd.context.cwd-missing");
      expect(codesOf(checkSddAction(resolved, { kind: "artifact", cwd: f.control }))).toContain("sdd.context.target-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
//: sddDir escape classification
// (task-1 review Minor 1 prerequisite), the bound argv launcher and the
// bound task-brief/review-package artifact writes.
// ---------------------------------------------------------------------------

describe("resolveSddExecutionContext sddDir escape classification (task-1 review Minor 1)", () => {
  test("a declared sddDir that canonicalizes outside the control harness is a gate fail (exit 1, sdd.context.sdd-dir-escape)", () => {
    const root = tmpRoot("sdd-esc-out-");
    try {
      const f = executionFixture(root);
 // A DIFFERENT sddDir that routes outside the harness through a symlink:
 // divergent from the composition AND physically escaping it is the
 // environmental escape (exit 1). (A declaration whose canonical form
 // EQUALS the composition is valid — see the canonical-equality tests.)
      const outside = join(root, "outside-sdd", PLAN_ID);
      mkdirSync(outside, { recursive: true });
      const alias = join(f.harnessDir, "sdd", "escape-plan");
      symlinkSync(outside, alias);
      const err = errOf(() => resolveSddExecutionContext({ ...contextOf(f), sddDir: alias }));
 // Environmental escape — exit 1, not the exit-2 usage mismatch.
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.sdd-dir-escape");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a divergent-but-inside sddDir stays a usage error (exit 2) — only the escaping divergence is exit 1", () => {
    const root = tmpRoot("sdd-esc-in-");
    try {
      const f = executionFixture(root);
 // Symlink divergence INSIDE the harness: the alias canonicalizes to a
 // different real dir (not the composed plan dir) but never leaves the
 // harness — a wrong declaration (exit 2), not an environmental escape.
      const other = join(f.harnessDir, "sdd", "other-plan");
      mkdirSync(other, { recursive: true });
      const alias = join(f.harnessDir, "sdd", "alias-plan");
      symlinkSync(other, alias);
      const err = errOf(() => resolveSddExecutionContext({ ...contextOf(f), sddDir: alias }));
      expect(err.exitCode).toBe(2);
      expect(err.message).toMatch(/does not match plan/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlinked sdd base whose canonical form equals the composition is valid (canonical comparison on both sides)", () => {
    const root = tmpRoot("sdd-esc-canonical-eq-");
    try {
      const f = executionFixture(root);
 // The repo declares its sdd base through a symlink while the context
 // carries the physical path: equivalent destinations in different
 // string forms must resolve, not misclassify as a composition mismatch.
      const realBase = join(f.harnessDir, "real-sdd");
      mkdirSync(join(realBase, PLAN_ID), { recursive: true });
      symlinkSync(realBase, join(f.harnessDir, "sdd-link"));
      writeFileSync(join(f.control, ".mstarc"), `[config]\nsdd_dir=${join(".mstar", "sdd-link")}\n`);
      const resolved = resolveSddExecutionContext({ ...contextOf(f), sddDir: join(realBase, PLAN_ID) });
      expect(resolved.sddDir).toBe(realpathSync(join(realBase, PLAN_ID)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a `.mstarc` sdd base composed outside the harness honors the matching declaration (canonical equality is valid)", () => {
    const root = tmpRoot("sdd-esc-out-composed-");
    try {
      const f = executionFixture(root);
 // The repo's own path SSOT composes an sdd base that physically lands
 // outside the harness (symlinked declaration); the engine honors a
 // context whose sddDir canonicalizes to that composition instead of
 // refusing it as a symlink escape — resolveSddDir is authoritative.
      const outside = join(root, "outside-sdd");
      mkdirSync(join(outside, PLAN_ID), { recursive: true });
      symlinkSync(outside, join(f.harnessDir, "outside-link"));
      writeFileSync(join(f.control, ".mstarc"), `[config]\nsdd_dir=${join(".mstar", "outside-link")}\n`);
      const resolved = resolveSddExecutionContext({ ...contextOf(f), sddDir: join(outside, PLAN_ID) });
      expect(resolved.sddDir).toBe(realpathSync(join(outside, PLAN_ID)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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

describe("runInSddContext — A3 bound argv launcher ()", () => {
  test("runs the child in the feature worktree; the argv literal arrives unchanged (no shell)", async () => {
    const root = tmpRoot("sdd-exec-cwd-");
    try {
      const f = executionFixture(root);
      const writer = childWriterFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
      const record = join(root, "record.json");
      const code = await runInSddContext(resolved, [process.execPath, writer, record, "a b", "$(touch pwn.txt)", "`touch pwn.txt`", "*"]);
      expect(code).toBe(0);
      const doc = JSON.parse(readFileSync(record, "utf8")) as { cwd: string; argv: string[] };
      expect(doc.cwd).toBe(realpathSync(f.feature));
      expect(doc.argv).toEqual(["a b", "$(touch pwn.txt)", "`touch pwn.txt`", "*"]);
 // No shell ever ran: the command substitutions left nothing behind.
      expect(existsSync(join(f.feature, "pwn.txt"))).toBe(false);
      expect(existsSync(join(root, "pwn.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("numeric child exit is preserved (7 → 7); spawn-not-found resolves 127", async () => {
    const root = tmpRoot("sdd-exec-exit-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
      expect(await runInSddContext(resolved, [process.execPath, "-e", "process.exit(7)"])).toBe(7);
      expect(await runInSddContext(resolved, ["definitely-not-a-real-binary-xyz"])).toBe(127);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gate failure throws (exit 1) and launches no child", async () => {
    const root = tmpRoot("sdd-exec-gate-");
    try {
      const f = executionFixture(root);
      const writer = childWriterFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
 // Swap the feature branch after resolution: the gate must refuse
 // BEFORE the child runs — the child itself is the probe (it would
 // write the probe file as its first action).
      git(["checkout", "-q", "-b", "feature/detour"], f.feature);
      const probe = join(f.feature, "probe-should-not-exist.json");
      const err = await errOfAsync(() => runInSddContext(resolved, [process.execPath, writer, probe]));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.branch-mismatch");
      expect(existsSync(probe)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SIGTERM is forwarded: child terminated 128+15, listeners cleaned", async () => {
    const root = tmpRoot("sdd-exec-term-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
      const beforeInt = process.listenerCount("SIGINT");
      const beforeTerm = process.listenerCount("SIGTERM");
      const pending = runInSddContext(resolved, [process.execPath, "-e", "setInterval(() => {}, 1000)"]);
      await new Promise((r) => setTimeout(r, 300)); // child up
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
      process.kill(process.pid, "SIGTERM");
      expect(await pending).toBe(128 + 15);
      expect(process.listenerCount("SIGINT")).toBe(beforeInt);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SIGINT is forwarded: child terminated 128+2, listeners cleaned", async () => {
    const root = tmpRoot("sdd-exec-int-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
      const beforeInt = process.listenerCount("SIGINT");
      const pending = runInSddContext(resolved, [process.execPath, "-e", "setInterval(() => {}, 1000)"]);
      await new Promise((r) => setTimeout(r, 300));
      process.kill(process.pid, "SIGINT");
      expect(await pending).toBe(128 + 2);
      expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bound task-brief / review-package — A3 artifact producers ()", () => {
  test("bound task-brief defaults into the control sddDir and emits an absolute path", () => {
    const root = tmpRoot("sdd-bound-brief-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
 // Observed invocation cwd = the primary checkout — the producer's own
 // cwd is not gated; the ARTIFACT destination is.
      const out = taskBrief(f.planFile, 1, undefined, { context: resolved, cwd: f.primary });
      expect(out).toBe(join(resolved.sddDir, "task-1-brief.md"));
      expect(isAbsolute(out)).toBe(true);
      expect(readFileSync(out, "utf8")).toContain("- implement");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bound task-brief refuses an escaping destination before any write (nothing created)", () => {
    const root = tmpRoot("sdd-bound-brief-esc-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
 // Same string universe as the resolved context (macOS /var →
 // /private/var): the symlink escape diagnostic is a same-universe
 // declared-prefix classification (Task-1 self-review note).
      symlinkSync(f.primary, join(resolved.sddDir, "escape"));
      const destination = join(resolved.sddDir, "escape", "brief.md");
      const err = errOf(() => taskBrief(f.planFile, 1, destination, { context: resolved, cwd: f.primary }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.artifact-symlink-escape");
 // Refusal-before-mutation: nothing through the link, no partial output.
      expect(existsSync(join(f.primary, "brief.md"))).toBe(false);
      expect(existsSync(destination)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bound task-brief refuses a foreign plan file before any read or write; the matching plan file works", () => {
    const root = tmpRoot("sdd-bound-brief-foreign-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
 // Another plan's plan file passed with THIS plan's bound context: the
 // extraction must refuse instead of writing foreign content into this
 // plan's control SDD dir.
      const foreignPlan = join(f.harnessDir, "plans", "other-plan.md");
      writeFileSync(foreignPlan, "# Other plan\n\n## Task 1\n\n- foreign step\n");
      const err = errOf(() => taskBrief(foreignPlan, 1, undefined, { context: resolved, cwd: f.primary }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.plan-file-mismatch");
      expect(existsSync(join(resolved.sddDir, "task-1-brief.md"))).toBe(false);
      expect(readFileSync(foreignPlan, "utf8")).not.toContain("task-1-brief");

 // The context's own plan file still extracts normally.
      const out = taskBrief(f.planFile, 1, undefined, { context: resolved, cwd: f.primary });
      expect(out).toBe(join(resolved.sddDir, "task-1-brief.md"));
      expect(readFileSync(out, "utf8")).toContain("- implement");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bound review-package probes git in the feature worktree and lands in the control sddDir (absolute path)", () => {
    const root = tmpRoot("sdd-bound-rp-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
      writeFileSync(join(f.feature, "feature-file.txt"), "feature change\n");
      git(["add", "-A"], f.feature);
      git(["commit", "-q", "-m", "feature commit"], f.feature);
      const base = git(["rev-parse", "main"], f.primary);
      const head = git(["rev-parse", "HEAD"], f.feature);
 // Invocation cwd = control checkout; bound git probe = feature worktree.
      const out = reviewPackage(base, head, undefined, { context: resolved, cwd: f.control });
      expect(out).toBe(join(resolved.sddDir, `review-${base.slice(0, 7)}..${head.slice(0, 7)}.diff`));
      const content = readFileSync(out, "utf8");
      expect(content).toContain("feature commit");
      expect(content).toContain("feature-file.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bound review-package refuses an artifact outside the plan and writes nothing", () => {
    const root = tmpRoot("sdd-bound-rp-esc-");
    try {
      const f = executionFixture(root);
      const resolved = resolveSddExecutionContext(contextOf(f));
      writeFileSync(join(f.feature, "feature-file.txt"), "feature change\n");
      git(["add", "-A"], f.feature);
      git(["commit", "-q", "-m", "feature commit"], f.feature);
      const base = git(["rev-parse", "main"], f.primary);
      const head = git(["rev-parse", "HEAD"], f.feature);
      const destination = join(f.control, "elsewhere.diff");
      const err = errOf(() => reviewPackage(base, head, destination, { context: resolved, cwd: f.control }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.artifact-outside-plan");
      expect(existsSync(destination)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("context-less helpers stay explicitly unbound (no protection claim, A3)", () => {
    const root = tmpRoot("sdd-unbound-");
    try {
      const f = executionFixture(root);
 // Legacy behavior: SDD_DIR alone directs the write anywhere — this is
 // the documented UNBOUND mode, not evidence of action protection.
      const arbitrary = join(root, "arbitrary-destination");
      withEnv(SDD_DIR, arbitrary, () => {
        const out = taskBrief(f.planFile, 1);
        expect(out).toBe(join(arbitrary, "task-1-brief.md"));
        expect(existsSync(out)).toBe(true);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("explicit linked marker refuses unavailable Git without creating process state", () => {
  const root = tmpRoot("sdd-linked-marker-");
  const previousPath = process.env.PATH;
  try {
    writeFileSync(join(root, ".git"), "gitdir: /unavailable/common/worktrees/linked\n");
    process.env.PATH = root;
    expect(() => sddWorkspace("plan-a", { controlRoot: root })).toThrow("cannot verify");
    expect(existsSync(join(root, ".mstar"))).toBe(false);
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});


test("governing active snapshot with both topology keys refuses standalone downgrade", () => {
  const root = tmpRoot("sdd-both-topology-");
  try {
    const f = executionFixture(root);
    writeSnapshot(f, "wf-a", [{ id: PLAN_ID, status: "InProgress", execution_lease: executionLease(f) }], {
      integration_worktree_path: f.control, control_worktree_path: f.control,
    });
    expect(() => resolveSddExecutionContext(contextOf(f))).toThrow("refusing conflicting");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review and base verification bound hung Git before artifact writes", () => {
  const root = tmpRoot("sdd-bounded-git-");
  const previousPath = process.env.PATH;
  const previousTimeout = process.env.MSTAR_GIT_PROBE_TIMEOUT_MS;
  try {
    writeFileSync(join(root, "git"), "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
    process.env.PATH = root;
    process.env.MSTAR_GIT_PROBE_TIMEOUT_MS = "50";
    const started = Date.now();
    expect(() => reviewPackage("abcd", "efab", join(root, "review.diff"), { cwd: root })).toThrow("bad BASE");
    expect(() => assertBaseSha("abcd", { cwd: root })).toThrow("commit not found");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(existsSync(join(root, "review.diff"))).toBe(false);
  } finally {
    process.env.PATH = previousPath;
    if (previousTimeout === undefined) delete process.env.MSTAR_GIT_PROBE_TIMEOUT_MS;
    else process.env.MSTAR_GIT_PROBE_TIMEOUT_MS = previousTimeout;
    rmSync(root, { recursive: true, force: true });
  }
});
