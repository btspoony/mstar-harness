/**
 * Engine sdd module — SDD loop state machine + the engine implementations
 * of the SDD workspace / task-brief / review-package helpers (CLI form:
 * `mstar sdd workspace|task-brief|review-package`).
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - Per-task loop, BASE_SHA rule, progress ledger, red flags:
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
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, relative } from "node:path";
import { registerCatalogEntity } from "../src/catalog.js";
import { createExecutionWorkflow, readExecutionState, type ExecutionCaller } from "../src/execution-store.js";
import { initializeStore, type StoreContext } from "../src/store-db.js";
import type { WorkflowSnapshot } from "../src/workflow.js";
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

/**
 * Capture ANY rejection (store-level refusals surface as the store's own
 * typed errors — `StoreError`/`ExecutionError` with a `.code` — not
 * `SddScriptError`), failing the test when nothing throws.
 */
async function rejectionOf(fn: () => Promise<unknown>): Promise<Error & { code?: string; exitCode?: number }> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error & { code?: string; exitCode?: number };
  }
  throw new Error("expected a refusal, got no throw");
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
  test("resolves/creates {HARNESS_DIR}/sdd/<plan-id>/.gitignore for an existing .mstar harness dir", () => {
    const root = tmpRoot("sdd-ws-mstar-");
    try {
      git(["init", "-q"], root);
      mkdirSync(join(root, ".mstar"), { recursive: true });
      const dir = sddWorkspace("plan-1", { cwd: root });
      expect(dir).toBe(realpathSync(join(root, ".mstar", "sdd", "plan-1")));
      expect(statSync(dir).isDirectory()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves a harness dir without status.json (the retired file probe no longer gates resolution)", () => {
 // issue #428 retires the `status.json`/`workflows/<id>/snapshot.json`
 // harness probe: a harness dir is resolved by location (`.mstar` first,
 // then `.agents`); its authority is the store inside it, not a file
 // marker. An existing `.mstar` dir resolves without any retired file.
    const root = tmpRoot("sdd-ws-snapshot-");
    try {
      git(["init", "-q"], root);
      mkdirSync(join(root, ".mstar", "workflows", "wf-1"), { recursive: true });
      const dir = sddWorkspace("plan-1", { cwd: root });
      expect(dir).toBe(realpathSync(join(root, ".mstar", "sdd", "plan-1")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

// The `.mstarc` `[config] workflow_dir` snapshot probe retired with the
// file route (issue #428): harness resolution is location-based
// (`.mstarc harness_dir` → existing `.mstar` → `.agents`), and no probe
// reads `workflows/<id>/snapshot.json` for authority anymore. The
// dir-existence order (`.mstar` before `.agents`) is asserted by the
// status.json-less case above.

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
      expect(readFileSync(task10, "utf8")).toContain("### Task 10: tenth task");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("missing plan file fails with exit code 2", () => {
    const err = errOf(() => taskBrief("/no/such/plan.md", 1, "/tmp/out.md"));
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain("no such plan file");
  });

  test("missing task heading fails with exit code 3 without writing an out file", () => {
    const out = tmpRoot("sdd-brief-");
    try {
      const file = join(out, "task-5-brief.md");
      const err = errOf(() => taskBrief(SAMPLE_PLAN, 5, file));
      expect(err.exitCode).toBe(3);
      expect(err.message).toContain("task 5 not found");
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("missing task heading does not create the default SDD directory", () => {
    const out = tmpRoot("sdd-brief-");
    try {
      const sddDir = join(out, "missing", "sdd");
      withEnv(SDD_DIR, sddDir, () => {
        const err = errOf(() => taskBrief(SAMPLE_PLAN, 5));
        expect(err.exitCode).toBe(3);
        expect(existsSync(sddDir)).toBe(false);
      });
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


  test("reviewPackage includes the selected commit range, file summary and diff", () => {
    const root = tmpRoot("sdd-rp-contract-");
    const out = tmpRoot("sdd-rp-contract-out-");
    try {
      const { base, head } = gitFixture(root);
      const tsOut = join(out, "ts.diff");
      reviewPackage(base, head, tsOut, { cwd: root });
      const content = readFileSync(tsOut, "utf8");
      expect(content).toContain(`# Review package: ${base}..${head}`);
      expect(content).toContain("## Commits");
      expect(content).toContain("## Files changed");
      expect(content).toContain("## Diff");
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
// SDD execution context + action checks (spec A3). Fixtures build
// separate disposable
// primary / control / feature checkouts with real `git worktree add` — never
// the real main checkout. Checks must be read-only.
// ---------------------------------------------------------------------------

type ExecutionFixture = {
  root: string;
 /** Disposable "primary checkout" on `main` — stands in for the incident scene. */
  primary: string;
 /** Integration worktree; the primary-harness variant keeps process SSOT on main. */
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

function executionFixture(root: string, opts: { nested?: boolean; nestedHarness?: boolean; primaryHarness?: boolean } = {}): ExecutionFixture {
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
  // Real registration probes the process store from workflow paths, so its
  // harness belongs on the Git-derived primary checkout, not integration.
  const harnessCheckout = opts.primaryHarness ? primary : control;
  const harnessDir = opts.nestedHarness ? join(harnessCheckout, "state", ".mstar") : join(harnessCheckout, ".mstar");
  const planFile = join(harnessDir, "plans", `${PLAN_ID}.md`);
  mkdirSync(dirname(planFile), { recursive: true });
  // The registered plan document (§4): its `plan_id` header is the identity
  // authority a registration resolves the pointer against, and its heading is
  // the title authority (the registration calls declare that same title).
  writeFileSync(
    planFile,
    `# Plan\n\n**plan_id:** ${PLAN_ID}\n\n**Main worktree branch**: main\n\n## Task 1\n\n- implement\n`,
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

function rowMetadata(f: ExecutionFixture, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    worktree_path: f.feature,
    working_branch: f.workingBranch,
    ...overrides,
  };
}

const ACTIVE_STARTED_AT = "2026-09-07T00:00:00.000Z";

function rowPlanIdOf(row: Record<string, unknown>): string {
  return String(row.id ?? row.plan_id);
}

/** Initialize the fixture's ACTIVE execution authority once (idempotent). */
async function ensureAuthority(f: ExecutionFixture): Promise<StoreContext> {
  const context: StoreContext = { harnessDir: f.harnessDir };
  if (!existsSync(join(f.harnessDir, "store.db"))) {
    (await initializeStore(context)).close();
  }
  return context;
}

/** Plan ids already registered in the fixture catalog across this run (tmp fixture roots are unique). */
const catalogRegistered = new Set<string>();

/**
 * ACTIVE replacement for the retired file-probe fixture writers
 * (`writeSnapshot` + `writeStatusRegister`): registers the workflow — and
 * the catalog plan identities its rows address — in the fixture's execution
 * store, so `resolveSddExecutionContext` reads it through the same
 * transactional graph read production uses (the `dbPrepareFixture` pattern).
 */
async function seedWorkflow(
  f: ExecutionFixture,
  workflowId: string,
  plans: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const context = await ensureAuthority(f);
  for (const planId of new Set(plans.map(rowPlanIdOf))) {
    const catalogKey = `${context.harnessDir}\n${planId}`;
    if (catalogRegistered.has(catalogKey)) continue;
    await registerCatalogEntity(
      context,
      { kind: "plan", id: planId, title: planId, rootKind: "plans", relativePath: `plans/${planId}.md` },
      { operationId: `catalog-${planId}`, actor: "sdd.test" },
    );
    catalogRegistered.add(catalogKey);
  }
  const type = extra.type === "iteration" ? "iteration" : "plan";
  const snapshot = {
    schema_version: 1,
    id: workflowId,
    type,
    status: "running",
    started_at: ACTIVE_STARTED_AT,
    updated_at: ACTIVE_STARTED_AT,
    delivery_kind: "development",
    ...extra,
    plans: plans.map((row) => ({ title: rowPlanIdOf(row), file: `plans/${rowPlanIdOf(row)}.md`, ...row })),
  } as unknown as WorkflowSnapshot;
  await createExecutionWorkflow(
    {
      harnessDir: context.harnessDir,
      caller: { sessionId: `creator-${workflowId}`, role: "coordinator", workflowId },
    },
    {
      entry: { id: workflowId, type, started_at: ACTIVE_STARTED_AT, dir: `workflows/${workflowId}` },
      snapshot,
      expected: (await readExecutionState(context)).token,
      operationId: `seed-${workflowId}`,
    },
  );
}

/** A registered row that carries no feature scope yet (the resolver's standalone arm). */
function todoRow(): Record<string, unknown> {
  return { id: PLAN_ID, title: PLAN_ID, file: `plans/${PLAN_ID}.md`, status: "Todo" };
}

/** A registered row that owns the fixture feature scope (the resolver's L1 arm). */
function scopedRow(f: ExecutionFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: PLAN_ID, title: PLAN_ID, file: `plans/${PLAN_ID}.md`, status: "InProgress", metadata: rowMetadata(f), ...overrides };
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
  test("resolves against the declared control root and canonicalizes every path", async () => {
    const root = tmpRoot("sdd-ctx-ok-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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

  test("mismatched declared branch fails the gate (exit 1, reused worktree.branch-mismatch)", async () => {
    const root = tmpRoot("sdd-ctx-branch-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const err = await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), workingBranch: "feature/other" }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.branch-mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing feature worktree fails the gate (exit 1)", async () => {
    const root = tmpRoot("sdd-ctx-nofeature-");
    try {
      const f = executionFixture(root);
      const err = await errOfAsync(() =>
        resolveSddExecutionContext({ ...contextOf(f), featureCwd: join(root, "no-such-feature") }),
      );
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.feature-cwd-missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("usage errors are exit 2: relative paths, unsafe planId, plan/sdd identity mismatch", async () => {
    const root = tmpRoot("sdd-ctx-usage-");
    try {
      const f = executionFixture(root);
      expect((await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), controlHarnessRoot: "relative/.mstar" }))).exitCode).toBe(2);
      expect((await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), planId: "../escape" }))).exitCode).toBe(2);
      expect((await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), sddDir: join(f.harnessDir, "sdd", "other-plan") }))).exitCode).toBe(2);
      expect((await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), planFile: join(f.harnessDir, "plans", "other-plan.md") }))).exitCode).toBe(2);
      expect((await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), planFile: join(f.harnessDir, "plans", "no-such-plan.md") }))).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("feature cwd inside the control checkout is refused (L1 hard rule, exit 1)", async () => {
    const root = tmpRoot("sdd-ctx-nest1-");
    try {
      const f = executionFixture(root);
      mkdirSync(join(f.control, "accidental-feature"));
      const err = await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: join(f.control, "accidental-feature") }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.feature-in-control");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("control harness declared inside the feature checkout is refused (exit 1)", async () => {
    const root = tmpRoot("sdd-ctx-nest2-");
    try {
      const f = executionFixture(root);
      const strayHarness = join(f.feature, ".mstar", "nested-harness");
      const strayPlan = join(strayHarness, "plans", `${PLAN_ID}.md`);
      mkdirSync(dirname(strayPlan), { recursive: true });
      writeFileSync(strayPlan, "# stray\n");
      const err = await errOfAsync(() =>
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

  test("nested feature worktree inside the control checkout passes (real linked worktree, arbitrary folder name)", async () => {
    const root = tmpRoot("sdd-ctx-nested-ok-");
    try {
      const f = executionFixture(root, { nested: true });
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));
      expect(resolved.controlHarnessRoot).toBe(realpathSync(f.harnessDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nested feature worktree recorded in row metadata resolves (L1 + scope binding)", async () => {
    const root = tmpRoot("sdd-ctx-nested-lease-");
    try {
      const f = executionFixture(root, { nested: true });
      await seedWorkflow(f, "wf-1", [scopedRow(f)]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("coherent harness alias passes (control harness root declared through a symlink alias)", async () => {
    const root = tmpRoot("sdd-ctx-alias-ok-");
    try {
      const f = executionFixture(root, { nested: true });
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const alias = join(root, "control-alias");
      symlinkSync(f.control, alias);
      const aliasHarness = join(alias, ".mstar");
      const resolved = await resolveSddExecutionContext({
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

  test("feature cwd equal to the control checkout is refused (exit 1)", async () => {
    const root = tmpRoot("sdd-ctx-same-");
    try {
      const f = executionFixture(root);
      const err = await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: f.control }));
      expect(err.exitCode).toBe(1);
      // The control harness lives inside the feature cwd (the control
      // checkout itself) — control-inside-feature is the first gate.
      expect(err.message).toContain("sdd.context.control-inside-feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlink alias of the control checkout is refused as feature cwd (exit 1)", async () => {
    const root = tmpRoot("sdd-ctx-alias-neg-");
    try {
      const f = executionFixture(root);
      const alias = join(root, "control-alias");
      symlinkSync(f.control, alias);
      const err = await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: alias }));
      expect(err.exitCode).toBe(1);
      // The alias canonicalizes to the control checkout, whose harness is
      // inside the feature cwd — control-inside-feature is the first gate.
      expect(err.message).toContain("sdd.context.control-inside-feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plain subdirectory of the control checkout refused even when the declared branch equals the control branch (exit 1)", async () => {
    const root = tmpRoot("sdd-ctx-branch-eq-");
    try {
      const f = executionFixture(root);
      const subdir = join(f.control, "plain-subdir");
      mkdirSync(subdir);
      const controlBranch = git(["branch", "--show-current"], f.control);
      const err = await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: subdir, workingBranch: controlBranch }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.feature-in-control");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured nested harness (standalone): nested real linked worktree passes", async () => {
    const root = tmpRoot("sdd-ctx-nested-harness-ok-");
    try {
      const f = executionFixture(root, { nested: true, nestedHarness: true });
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));
      expect(resolved.controlHarnessRoot).toBe(realpathSync(f.harnessDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured nested harness (standalone): plain subdirectory of the control checkout refused", async () => {
    const root = tmpRoot("sdd-ctx-nested-harness-subdir-");
    try {
      const f = executionFixture(root, { nestedHarness: true });
      const subdir = join(f.control, "plain-feature");
      mkdirSync(subdir);
      const controlBranch = git(["branch", "--show-current"], f.control);
      const err = await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: subdir, workingBranch: controlBranch }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.feature-in-control");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured nested harness (standalone): symlink alias of the control checkout refused", async () => {
    const root = tmpRoot("sdd-ctx-nested-harness-alias-");
    try {
      const f = executionFixture(root, { nestedHarness: true });
      const alias = join(root, "control-alias");
      symlinkSync(f.control, alias);
      const controlBranch = git(["branch", "--show-current"], f.control);
      const err = await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), featureCwd: alias, workingBranch: controlBranch }));
      expect(err.exitCode).toBe(1);
      // The alias canonicalizes to the control checkout, whose harness is
      // inside the feature cwd — control-inside-feature is the first gate.
      expect(err.message).toContain("sdd.context.control-inside-feature");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an ACTIVE row cannot authorize a plain control-checkout subdirectory (the nesting gate runs first)", async () => {
    const root = tmpRoot("sdd-ctx-nested-harness-row-");
    try {
      const f = executionFixture(root, { nested: true, nestedHarness: true });
      await seedWorkflow(f, "wf-1", [scopedRow(f)]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));

      // The registered row's scope cannot authorize a plain subdirectory of
      // the harness checkout: the distinct-checkout gate refuses before any
      // row scope is consulted.
      const subdir = join(f.control, "plain-feature");
      mkdirSync(subdir);
      const controlBranch = git(["branch", "--show-current"], f.control);
      const err = await errOfAsync(() => resolveSddExecutionContext({
        ...contextOf(f), featureCwd: subdir, workingBranch: controlBranch,
      }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.feature-in-control");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("row metadata naming a plain subdirectory of the MAIN worktree is refused by L1", async () => {
    const root = tmpRoot("sdd-ctx-row-mainsub-");
    try {
      const f = executionFixture(root);
      const subdir = join(f.primary, "plain-subdir");
      mkdirSync(subdir);
      await seedWorkflow(f, "wf-1", [
        scopedRow(f, { metadata: rowMetadata(f, { worktree_path: subdir, working_branch: "feature/sub" }) }),
      ]);
      const err = await errOfAsync(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.l1.feature-equals-main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("active workflow row metadata matching the context resolves; a mismatching context is refused", async () => {
    const root = tmpRoot("sdd-ctx-row-scope-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [scopedRow(f)]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
      expect(resolved.featureCwd).toBe(realpathSync(f.feature));

      // Context workingBranch differs from the registered row branch.
      const branchErr = await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), workingBranch: "feature/other" }));
      expect(branchErr.exitCode).toBe(1);
      expect(branchErr.message).toContain("sdd.context.row-branch-mismatch");
      expect(branchErr.message).toContain("plan prepare --workflow wf-1 --plan");

      // Context featureCwd differs from the registered row worktree: L1
      // still requires feature scope to be distinct from main.
      const root2 = tmpRoot("sdd-ctx-row-scope2-");
      const f2 = executionFixture(root2);
      try {
        await seedWorkflow(f2, "wf-1", [
          scopedRow(f2, { metadata: rowMetadata(f2, { worktree_path: f2.primary, working_branch: "main" }) }),
        ]);
        const worktreeErr = await errOfAsync(() => resolveSddExecutionContext(contextOf(f2)));
        expect(worktreeErr.exitCode).toBe(1);
        expect(worktreeErr.message).toContain("worktree.l1.feature-equals-main");
      } finally {
        rmSync(root2, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("InProgress row without recorded worktree metadata refuses with the supported scope requirement", async () => {
    const root = tmpRoot("sdd-ctx-row-scope-missing-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [
        { id: PLAN_ID, title: PLAN_ID, file: `plans/${PLAN_ID}.md`, status: "InProgress" },
      ]);
      const err = await errOfAsync(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.l1.feature-scope-missing");
      expect(err.message).toContain(`plan prepare --workflow wf-1 --plan ${PLAN_ID}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a registered row without feature scope yet keeps the standalone branch alignment", async () => {
    const root = tmpRoot("sdd-ctx-standalone-");
    try {
      const f = executionFixture(root);
      // Registered ACTIVE workflow, row not InProgress and no scope
      // metadata: the plan IS registered, only its execution ownership is
      // not — the existing branch policy still gates the context.
      await seedWorkflow(f, "wf-done", [{ id: PLAN_ID, title: PLAN_ID, file: `plans/${PLAN_ID}.md`, status: "Done" }]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
      expect(resolved.planId).toBe(PLAN_ID);

      // The declared branch must still align: a mismatching branch refuses.
      const err = await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), workingBranch: "feature/other" }));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.branch-mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a control root without an ACTIVE execution store refuses with the bootstrap recovery (S1/S2 mapping)", async () => {
    const root = tmpRoot("sdd-ctx-nostore-");
    try {
      const f = executionFixture(root);
      const rejection = await rejectionOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(rejection.code).toBe("store.not-initialized");
      expect(rejection.message).toContain("mstar harness scaffold");
      expect(rejection.message).toContain("mstar store init");
      expect(rejection.message).toContain("mstar store upgrade");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a retained (unregistered) row is history, never registration evidence; the ACTIVE row governs (§4b)", async () => {
    const root = tmpRoot("sdd-ctx-terminal-shadow-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-live", [scopedRow(f)]);
      expect((await resolveSddExecutionContext(contextOf(f))).planId).toBe(PLAN_ID);

      // A completed lifecycle leaves registry membership: its plan row is
      // retained by the store but the ACTIVE graph no longer lists it, so
      // the row cannot satisfy registration (a completed plan id can never
      // be reused by riding its own history).
      const db = new DatabaseSync(join(f.harnessDir, "store.db"));
      try {
        db.exec("delete from execution_registry");
      } finally {
        db.close();
      }
      const err = await errOfAsync(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.plan-not-registered");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a plan claimed by two registered active workflows fails closed (never a silent standalone fallback)", async () => {
    const root = tmpRoot("sdd-ctx-ambiguous-");
    try {
      const f = executionFixture(root);
      // Both rows' scopes match the declared context, so a silent standalone
      // fallback would RESOLVE — the refusal itself is the contract.
      const row = scopedRow(f, { title: "claimed twice" });
      await seedWorkflow(f, "wf-a", [row]);
      await seedWorkflow(f, "wf-b", [row]);
      const err = await errOfAsync(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.workflow-plan-ambiguous");
      expect(err.message).toContain("wf-a");
      expect(err.message).toContain("wf-b");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a plan matching only retained (unregistered) rows is refused; an ACTIVE row passes (§4b/§6 S2)", async () => {
    const root = tmpRoot("sdd-ctx-terminal-only-");
    try {
      const f = executionFixture(root);
      // Another workflow runs in the store, but this plan has no ACTIVE
      // registration: a retained row (or no row at all) is never
      // registration evidence, and branch alignment is never a bypass.
      await seedWorkflow(f, "wf-other", [
        { id: "another-plan", title: "other plan", file: "plans/another-plan.md", status: "InProgress" },
      ]);
      const err = await errOfAsync(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.plan-not-registered");

      // An ACTIVE registered row IS registration evidence: the same plan id
      // under the graph resolves (its scope governs).
      await seedWorkflow(f, "wf-live", [scopedRow(f)]);
      expect((await resolveSddExecutionContext(contextOf(f))).planId).toBe(PLAN_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unregistered plan on an ACTIVE authority is refused with the register verb (lifecycle contract §6 S2)", async () => {
    const root = tmpRoot("sdd-ctx-unregistered-");
    try {
      const f = executionFixture(root);
      // The store is ACTIVE (another workflow runs), but this plan has no
      // registration evidence in any workflow row — admission never
      // silently continues on branch alignment alone (S2).
      await seedWorkflow(f, "wf-other", [
        { id: "another-plan", title: "other plan", file: "plans/another-plan.md", status: "InProgress" },
      ]);
      const err = await errOfAsync(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.plan-not-registered");
      // The refusal names the registration command and the recovery path.
      expect(err.message).toContain("mstar workflow register");
      expect(err.message).toContain("--delivery-kind");
      expect(err.message).toContain("retry");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a store file that cannot be read refuses admission closed (a damaged store is never 'no authority', §6 S2)", async () => {
    const root = tmpRoot("sdd-ctx-register-corrupt-");
    try {
      const f = executionFixture(root);
      // A PRESENT-but-unreadable store is a damaged control root, never
      // "no store": admission refuses through the store's own read refusal
      // instead of silently downgrading to branch-alignment-only.
      writeFileSync(join(f.harnessDir, "store.db"), "{ corrupted", "utf8");
      const rejection = await rejectionOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(rejection.code).toBe("store.corrupt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a store whose execution authority is not ACTIVE refuses closed (a staged store must be upgraded, not served)", async () => {
    const root = tmpRoot("sdd-ctx-register-v1-");
    try {
      const f = executionFixture(root);
      await ensureAuthority(f);
      const db = new DatabaseSync(join(f.harnessDir, "store.db"));
      try {
        db.exec("update execution_meta set authority_state = 'staged' where id = 1");
      } finally {
        db.close();
      }
      const rejection = await rejectionOf(() => resolveSddExecutionContext(contextOf(f)));
      expect(rejection.code).toBe("execution.not-active");
      // Fail-closed, never served as an empty authority: the read refuses a
      // staged store (its upgrade recovery lives in the store's own
      // authority readers, single-sourced).
      expect(rejection.message).toContain("staged store");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("residency expectation: recorded plan header wins, explicit branch.base is the fallback, neither refuses", async () => {
    // Recorded plan header (the fixture plan carries "Main worktree branch:
    // main") — resolves.
    const root1 = tmpRoot("sdd-ctx-mainbranch-");
    try {
      const f = executionFixture(root1);
      await seedWorkflow(f, "wf-1", [scopedRow(f)]);
      expect((await resolveSddExecutionContext(contextOf(f))).planId).toBe(PLAN_ID);
    } finally {
      rmSync(root1, { recursive: true, force: true });
    }

    // Headerless plan falls back conservatively to the workflow's explicit
    // branch.base — never the branch observed at check time.
    const root2 = tmpRoot("sdd-ctx-mainbranch-headerless-");
    try {
      const f2 = executionFixture(root2);
      writeFileSync(f2.planFile, "# Plan\n\n## Task 1\n\n- implement\n");
      await seedWorkflow(f2, "wf-1", [scopedRow(f2)], { branch: { base: "main" } });
      expect((await resolveSddExecutionContext(contextOf(f2))).planId).toBe(PLAN_ID);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }

    // Neither recorded header nor branch.base → expected-branch-missing refusal.
    const root3 = tmpRoot("sdd-ctx-mainbranch-missing-");
    try {
      const f3 = executionFixture(root3);
      writeFileSync(f3.planFile, "# Plan\n\n## Task 1\n\n- implement\n");
      await seedWorkflow(f3, "wf-1", [scopedRow(f3)]);
      const err = await errOfAsync(() => resolveSddExecutionContext(contextOf(f3)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.main.expected-branch-missing");
    } finally {
      rmSync(root3, { recursive: true, force: true });
    }
  });

  test("an iteration workflow's integration worktree drives the full L1 checks", async () => {
    // Aligned, distinct integration checkout (the control worktree is on the
    // integration branch in this fixture) — full checks pass.
    const rootOk = tmpRoot("sdd-ctx-iteration-ok-");
    try {
      const f = executionFixture(rootOk);
      await seedWorkflow(f, "wf-iter", [scopedRow(f)], {
        type: "iteration",
        integration_worktree_path: f.control,
        branch: { integration: "codex/iter-integration" },
      });
      expect((await resolveSddExecutionContext(contextOf(f))).planId).toBe(PLAN_ID);
    } finally {
      rmSync(rootOk, { recursive: true, force: true });
    }

    // Integration checkout IS the main worktree → integration-equals-main.
    const rootMain = tmpRoot("sdd-ctx-iteration-main-");
    try {
      const f = executionFixture(rootMain);
      await seedWorkflow(f, "wf-iter", [scopedRow(f)], {
        type: "iteration",
        integration_worktree_path: f.primary,
        branch: { integration: "main" },
      });
      const err = await errOfAsync(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.l1.integration-equals-main");
    } finally {
      rmSync(rootMain, { recursive: true, force: true });
    }

    // Feature worktree equals the integration checkout → feature-equals-integration.
    const rootLease = tmpRoot("sdd-ctx-iteration-lease-");
    try {
      const f = executionFixture(rootLease);
      await seedWorkflow(f, "wf-iter", [scopedRow(f)], {
        type: "iteration",
        integration_worktree_path: f.feature,
        branch: { integration: f.workingBranch },
      });
      const err = await errOfAsync(() => resolveSddExecutionContext(contextOf(f)));
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("worktree.l1.feature-equals-integration");
    } finally {
      rmSync(rootLease, { recursive: true, force: true });
    }
  });

  test("a declared control root is never re-inferred from a stray feature-local harness", async () => {
    const root = tmpRoot("sdd-ctx-stray-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      // Feature-local second-harness shape (the Aug-26 incident scene):
      // residue in the feature checkout never redirects resolution.
      const straySdd = join(f.feature, ".mstar", "sdd", PLAN_ID);
      mkdirSync(straySdd, { recursive: true });
      writeFileSync(join(f.feature, ".mstar", "status.json"), "{}\n");
      const resolved = await resolveSddExecutionContext(contextOf(f));
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
  test("correct declared context with wrong actual source cwd fails", async () => {
    const root = tmpRoot("sdd-act-wrongcwd-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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

  test("safe relative nested source passes; traversal and absolute escape fail", async () => {
    const root = tmpRoot("sdd-act-nested-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const nested = join(f.feature, "src", "nested");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "writer.ts"), "export const w = 1;\n");
      const resolved = await resolveSddExecutionContext(contextOf(f));
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

  test("symlink escape fails before mutation", async () => {
    const root = tmpRoot("sdd-act-symlink-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      symlinkSync(join(f.primary, "src"), join(f.feature, "src", "escape"));
      const resolved = await resolveSddExecutionContext(contextOf(f));
      const result = checkSddAction(resolved, { kind: "source", cwd: f.feature, target: "src/escape/probe.txt" });
      expect(result.ok).toBe(false);
      expect(codesOf(result)).toContain("sdd.context.target-symlink-escape");
 // …and nothing was written through the link.
      expect(existsSync(join(f.primary, "src", "probe.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("valid control artifact targets pass: fresh leaf, nested review dir, repair, planFile", async () => {
    const root = tmpRoot("sdd-act-artifact-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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

  test("arbitrary control source edits and artifact symlink escapes fail", async () => {
    const root = tmpRoot("sdd-act-artifact-bad-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      symlinkSync(f.primary, join(f.sddDir, "escape"));
      const resolved = await resolveSddExecutionContext(contextOf(f));
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

  test("launch check verifies the resolved launch destination, not the parent cwd", async () => {
    const root = tmpRoot("sdd-act-launch-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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

  test("checks perform no writes anywhere in the fixture", async () => {
    const root = tmpRoot("sdd-act-readonly-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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

  test("usage-level refusals: unknown kind, missing cwd, artifact without target", async () => {
    const root = tmpRoot("sdd-act-usage-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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
  test("a declared sddDir that canonicalizes outside the control harness is a gate fail (exit 1, sdd.context.sdd-dir-escape)", async () => {
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
      const err = await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), sddDir: alias }));
 // Environmental escape — exit 1, not the exit-2 usage mismatch.
      expect(err.exitCode).toBe(1);
      expect(err.message).toContain("sdd.context.sdd-dir-escape");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a divergent-but-inside sddDir stays a usage error (exit 2) — only the escaping divergence is exit 1", async () => {
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
      const err = await errOfAsync(() => resolveSddExecutionContext({ ...contextOf(f), sddDir: alias }));
      expect(err.exitCode).toBe(2);
      expect(err.message).toMatch(/does not match plan/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlinked sdd base whose canonical form equals the composition is valid (canonical comparison on both sides)", async () => {
    const root = tmpRoot("sdd-esc-canonical-eq-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
 // The repo declares its sdd base through a symlink while the context
 // carries the physical path: equivalent destinations in different
 // string forms must resolve, not misclassify as a composition mismatch.
      const realBase = join(f.harnessDir, "real-sdd");
      mkdirSync(join(realBase, PLAN_ID), { recursive: true });
      symlinkSync(realBase, join(f.harnessDir, "sdd-link"));
      writeFileSync(join(f.control, ".mstarc"), `[config]\nsdd_dir=${join(".mstar", "sdd-link")}\n`);
      const resolved = await resolveSddExecutionContext({ ...contextOf(f), sddDir: join(realBase, PLAN_ID) });
      expect(resolved.sddDir).toBe(realpathSync(join(realBase, PLAN_ID)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a `.mstarc` sdd base composed outside the harness honors the matching declaration (canonical equality is valid)", async () => {
    const root = tmpRoot("sdd-esc-out-composed-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
 // The repo's own path SSOT composes an sdd base that physically lands
 // outside the harness (symlinked declaration); the engine honors a
 // context whose sddDir canonicalizes to that composition instead of
 // refusing it as a symlink escape — resolveSddDir is authoritative.
      const outside = join(root, "outside-sdd");
      mkdirSync(join(outside, PLAN_ID), { recursive: true });
      symlinkSync(outside, join(f.harnessDir, "outside-link"));
      writeFileSync(join(f.control, ".mstarc"), `[config]\nsdd_dir=${join(".mstar", "outside-link")}\n`);
      const resolved = await resolveSddExecutionContext({ ...contextOf(f), sddDir: join(outside, PLAN_ID) });
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
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const writer = childWriterFixture(root);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const writer = childWriterFixture(root);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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
  test("bound task-brief defaults into the control sddDir and emits an absolute path", async () => {
    const root = tmpRoot("sdd-bound-brief-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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

  test("bound task-brief refuses an escaping destination before any write (nothing created)", async () => {
    const root = tmpRoot("sdd-bound-brief-esc-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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

  test("bound task-brief refuses a foreign plan file before any read or write; the matching plan file works", async () => {
    const root = tmpRoot("sdd-bound-brief-foreign-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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

  test("bound review-package probes git in the feature worktree and lands in the control sddDir (absolute path)", async () => {
    const root = tmpRoot("sdd-bound-rp-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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

  test("bound review-package refuses an artifact outside the plan and writes nothing", async () => {
    const root = tmpRoot("sdd-bound-rp-esc-");
    try {
      const f = executionFixture(root);
      await seedWorkflow(f, "wf-1", [todoRow()]);
      const resolved = await resolveSddExecutionContext(contextOf(f));
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


// The file-snapshot "both topology keys" refusal (`control_worktree_path`
// alongside `integration_worktree_path`) retired with the file probe: the
// ACTIVE graph is written only through `createExecutionWorkflow`, whose
// `validateWorkflowSnapshot` refuses the dual-key shape at registration, so
// the resolver can never observe it (workflow.snapshot validation tests own
// that invariant).


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
