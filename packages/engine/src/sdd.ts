/**
 * Engine sdd module — SDD loop state machine + the engine implementations
 * of the SDD workspace / task-brief / review-package helpers (CLI form:
 * `mstar sdd workspace|task-brief|review-package`).
 *
 * Spec source: `skills/mstar-sdd/SKILL.md` (per-task loop, BASE_SHA rule,
 * progress ledger, red flags) + `references/file-handoffs.md` +
 * `references/sticky-implementer-session.md`. The three engine functions
 * (`sddWorkspace`, `taskBrief`, `reviewPackage`) are the operative
 * implementation; byte parity with the former bash scripts was proven in
 * slice 2 (roadmap §8.2 / plan 20260808-slice2-sdd-iteration) before the
 * scripts were removed in slice 5.
 *
 * Harness-root override: `MSTAR_HARNESS_DIR` env / `opts.harnessDir` (plan
 * finding 2026-08-08) — the status.json probe only knows the probed names
 * (`.mstar`/`.agents`) and picks the wrong root in repos with another root;
 * the engine honors the explicit override in addition to CONTROL_ROOT.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolveSddDir } from "./path.js";
import { findMstarc, parseMstarc } from "./mstarc.js";

/**
 * Error carrying the ported script exit code so the CLI can map validation
 * failures to identical non-zero exits.
 */
export class SddScriptError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "SddScriptError";
    this.exitCode = exitCode;
  }
}

/**
 * Options for `sddWorkspace` — `mstar sdd workspace PLAN_ID [CONTROL_ROOT]`
 * usage plus the harness-root override (plan finding 2026-08-08).
 */
export type SddWorkspaceOptions = {
  /** Control worktree repo root — CLI 2nd arg / `MSTAR_CONTROL_ROOT`. */
  controlRoot?: string;
  /** Explicit harness root — `MSTAR_HARNESS_DIR` / `--harness-dir`. */
  harnessDir?: string;
  /** Working directory for git probes; default `process.cwd()`. */
  cwd?: string;
};

/** Options for `taskBrief` (mirrors `$SDD_DIR` for the default out path). */
export type TaskBriefOptions = {
  sddDir?: string;
};

/** Options for `reviewPackage` (mirrors `$SDD_DIR` + git probe cwd). */
export type ReviewPackageOptions = {
  sddDir?: string;
  cwd?: string;
};

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Git capture ceiling for `gitOut` / `reviewPackage` (qc3 W-2): Node's
 * default 1 MiB `maxBuffer` ENOBUFS'd on large review ranges. 64 MiB keeps
 * realistic iteration-close ranges working while bounding memory; captures
 * beyond that fail as SddScriptError via the CLI.
 */
const GIT_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

/** Run git, returning trimmed stdout or null on failure. */
function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_CAPTURE_MAX_BYTES,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Harness probe: a harness dir only counts when it carries `status.json`
 * (that is what distinguishes a real control harness from a linked feature
 * checkout under default gitignore).
 */
function probeHarnessWithStatus(root: string): string | null {
  if (isFile(join(root, ".mstar", "status.json"))) return join(root, ".mstar");
  if (isFile(join(root, ".agents", "status.json"))) return join(root, ".agents");
  return null;
}

/**
 * A linked worktree from `git worktree add` has `--git-dir` ≠
 * `--git-common-dir` (or a `.git/worktrees/` / `worktrees/` git dir path).
 *
 * The `/worktrees/` substring branches keep the original script's
 * fail-closed classification: a MAIN checkout cloned into a directory
 * literally named `worktrees` is ALSO classified as linked (fail-closed
 * until CONTROL_ROOT is given). The realpath comparison below would
 * classify such a checkout correctly, but the substring branches
 * short-circuit first; see the test "repo under a directory named
 * 'worktrees'".
 */
function isLinkedWorktree(root: string): boolean {
  const gitDirRaw = gitOut(root, ["rev-parse", "--git-dir"]);
  const commonRaw = gitOut(root, ["rev-parse", "--git-common-dir"]);
  if (gitDirRaw === null || commonRaw === null) return false;
  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(root, gitDirRaw);
  const common = isAbsolute(commonRaw) ? commonRaw : join(root, commonRaw);
  // Path contains /worktrees/ → definitely linked (original case glob).
  if (gitDir.includes("/.git/worktrees/") || gitDir.includes("/worktrees/")) return true;
  try {
    const gdParent = realpathSync(dirname(gitDir));
    const cmAbs = realpathSync(common);
    return join(gdParent, basename(gitDir)) !== cmAbs && gitDir !== cmAbs;
  } catch {
    return false;
  }
}

/**
 * Resolve and ensure `{SDD_DIR}` = `{HARNESS_DIR}/sdd/<plan-id>/` (prints
 * the absolute path). Resolution order:
 *
 * 1. fail-closed FIRST: a linked worktree without a control root never
 *    resolves or creates any SDD tree under the feature checkout (refuses a
 *    second SDD tree; no override or probe may bypass this guard);
 * 2. explicit harness-root override (`opts.harnessDir` / `MSTAR_HARNESS_DIR`)
 *    — plan finding 2026-08-08: covers repos the status.json probe misses;
 *    resolved relative to the established root;
 * 3. `.mstarc` `[config] harness_dir` at `root` (repo-declared root;
 *    resolved against the config file's directory);
 * 4. `status.json` probe at root (`.mstar` → `.agents`);
 * 5. fallback: existing `.mstar`/`.agents` dir, else `.mstar`.
 *
 * `controlRoot` (CLI 2nd arg / `MSTAR_CONTROL_ROOT`) pins `root` to the
 * control worktree instead of the cwd's git top-level.
 */
export function sddWorkspace(planId: string, opts: SddWorkspaceOptions = {}): string {
  if (!planId) {
    throw new SddScriptError(
      "usage: mstar sdd workspace PLAN_ID [CONTROL_ROOT]\n" +
        "  Set MSTAR_CONTROL_ROOT=<control_worktree_path> when running from a feature worktree.",
      2,
    );
  }
  const cwd = opts.cwd ?? process.cwd();
  const controlRoot = opts.controlRoot ?? (process.env.MSTAR_CONTROL_ROOT || undefined);
  let root: string;
  if (controlRoot) {
    if (!isDirectory(controlRoot)) {
      throw new SddScriptError(
        `mstar sdd workspace: CONTROL_ROOT / MSTAR_CONTROL_ROOT is not a directory: ${controlRoot}`,
        1,
      );
    }
    root = realpathSync(controlRoot);
  } else {
    const topLevel = gitOut(cwd, ["rev-parse", "--show-toplevel"]);
    root = realpathSync(topLevel ?? cwd);
  }

  // Fail-closed FIRST (mstar-branch-worktree «Harness path SSOT under
  // default gitignore»): a linked worktree without CONTROL_ROOT must never
  // resolve or create any SDD tree under the feature checkout — the harness
  // override and the status probe both run only after this guard passes.
  //
  // INTENTIONAL DIVERGENCE from the original script (qc2 F-004, pinned by
  // the test "stray status.json in a linked worktree"): a status.json-first
  // probe would resolve a linked feature checkout with a stray
  // `.mstar/status.json` and create the second SDD tree under the feature
  // checkout — exactly the hazard this guard exists to refuse. The engine
  // refuses regardless of the probe result.
  if (!controlRoot && isLinkedWorktree(root)) {
    // Fail-closed message (exit 1).
    throw new SddScriptError(
      `mstar sdd workspace: linked worktree at ${root} has no {HARNESS_DIR}/status.json (default gitignore).\n` +
        `  Refusing to create a second SDD tree under the feature checkout.\n` +
        `  Re-run with MSTAR_CONTROL_ROOT=<control_worktree_path> or: mstar sdd workspace ${planId} <control_worktree_path>\n` +
        `  See mstar-branch-worktree \u00abHarness path SSOT under default gitignore\u00bb.`,
      1,
    );
  }

  const harnessOverride = opts.harnessDir ?? (process.env.MSTAR_HARNESS_DIR || undefined);
  let harnessDir: string;
  if (harnessOverride) {
    harnessDir = resolve(root, harnessOverride);
  } else {
    // `.mstarc` [config] harness_dir — repo-declared harness root (root is
    // the workspace boundary; a config above it never applies).
    const rc = findMstarc(root, root);
    const rcHarnessDir = rc !== null ? parseMstarc(readFileSync(rc, "utf8")).harnessDir : undefined;
    if (rcHarnessDir) {
      harnessDir = resolve(rc !== null ? dirname(rc) : root, rcHarnessDir);
    } else {
      const probed = probeHarnessWithStatus(root);
      if (probed) {
        harnessDir = probed;
      } else if (isDirectory(join(root, ".mstar"))) {
        harnessDir = join(root, ".mstar");
      } else if (isDirectory(join(root, ".agents"))) {
        harnessDir = join(root, ".agents");
      } else {
        harnessDir = join(root, ".mstar");
      }
    }
  }

  const sddDir = resolveSddDir(harnessDir, planId);
  mkdirSync(sddDir, { recursive: true });
  writeFileSync(join(sddDir, ".gitignore"), "*\n");
  // Ends with `cd "$dir" && pwd` semantics — physical path, symlinks resolved.
  return realpathSync(sddDir);
}

/**
 * Extract the `## Task N` section of a plan into a file (default
 * `{SDD_DIR}/task-N-brief.md`). Line state machine: ``` fences toggle
 * `infence`; headings inside fences are ignored; printing starts at the
 * heading for `taskN` and continues until the NEXT `## Task` heading (or
 * EOF for the last task) — a later Task heading resets the section. A
 * missing task writes an empty file then fails with exit-3
 * (`SddScriptError.exitCode === 3`).
 */
export function taskBrief(planFile: string, taskN: number, outFile?: string, opts: TaskBriefOptions = {}): string {
  if (!planFile || !Number.isInteger(taskN) || taskN < 1) {
    throw new SddScriptError("usage: mstar sdd task-brief PLAN_FILE TASK_NUMBER [OUTFILE]", 2);
  }
  let content: string;
  try {
    content = readFileSync(planFile, "utf8");
  } catch {
    throw new SddScriptError(`no such plan file: ${planFile}`, 2);
  }

  let out: string;
  if (outFile) {
    out = outFile;
  } else {
    const sddDir = opts.sddDir ?? process.env.SDD_DIR;
    if (!sddDir) {
      throw new SddScriptError(
        "mstar sdd task-brief: set SDD_DIR or pass OUTFILE (run mstar sdd workspace PLAN_ID first)",
        2,
      );
    }
    mkdirSync(sddDir, { recursive: true });
    out = join(sddDir, `task-${taskN}-brief.md`);
  }

  // awk records: every newline-terminated line plus a final unterminated
  // line; each printed record is emitted with a trailing newline.
  const records = content.endsWith("\n") ? content.split("\n").slice(0, -1) : content.split("\n");
  const headingRe = /^#+[ \t]+Task[ \t]+[0-9]+/;
  const targetRe = new RegExp(`^#+[ \t]+Task[ \t]+${taskN}([^0-9]|$)`);
  let infence = false;
  let intask = false;
  const printed: string[] = [];
  for (const line of records) {
    if (/^```/.test(line)) infence = !infence;
    if (!infence && headingRe.test(line)) intask = targetRe.test(line);
    if (intask) printed.push(line);
  }
  const output = printed.length > 0 ? `${printed.join("\n")}\n` : "";
  writeFileSync(out, output);

  if (printed.length === 0) {
    throw new SddScriptError(`task ${taskN} not found in ${planFile} (no heading matching Task ${taskN})`, 3);
  }
  return out;
}

/**
 * Write commit list, stat summary and `git diff -U10` for `BASE..HEAD`
 * into a file (default `{SDD_DIR}/review-<short base>..<short head>.diff`).
 * Both refs are validated with `git rev-parse --verify --quiet` (any ref
 * the original accepted is accepted here; the SHA-only guard is
 * `assertBaseSha`).
 */
export function reviewPackage(base: string, head: string, outFile?: string, opts: ReviewPackageOptions = {}): string {
  if (!base || !head) {
    throw new SddScriptError("usage: mstar sdd review-package BASE HEAD [OUTFILE]", 2);
  }
  const cwd = opts.cwd ?? process.cwd();

  const verifyRef = (ref: string, what: "BASE" | "HEAD"): void => {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      throw new SddScriptError(`bad ${what}: ${ref}`, 2);
    }
  };
  verifyRef(base, "BASE");
  verifyRef(head, "HEAD");

  let out: string;
  if (outFile) {
    out = outFile;
  } else {
    const sddDir = opts.sddDir ?? process.env.SDD_DIR;
    if (!sddDir) {
      throw new SddScriptError("mstar sdd review-package: set SDD_DIR or pass OUTFILE", 2);
    }
    mkdirSync(sddDir, { recursive: true });
    const shortBase = gitOut(cwd, ["rev-parse", "--short", base]) ?? base;
    const shortHead = gitOut(cwd, ["rev-parse", "--short", head]) ?? head;
    out = join(sddDir, `review-${shortBase}..${shortHead}.diff`);
  }

  const run = (args: string[]): Buffer =>
    execFileSync("git", args, { cwd, maxBuffer: GIT_CAPTURE_MAX_BYTES });
  // `{ echo …; git …; } > file` layout, byte-for-byte.
  const parts: Buffer[] = [
    Buffer.from(`# Review package: ${base}..${head}\n\n## Commits\n`),
    run(["log", "--oneline", `${base}..${head}`]),
    Buffer.from("\n## Files changed\n"),
    run(["diff", "--stat", `${base}..${head}`]),
    Buffer.from("\n## Diff\n"),
    run(["diff", "-U10", `${base}..${head}`]),
  ];
  writeFileSync(out, Buffer.concat(parts));
  return out;
}

/**
 * BASE_SHA guard (mstar-sdd SKILL.md red flags: never use `HEAD~1` as the
 * review BASE — multi-commit tasks truncate). Accepts only a full or prefix
 * commit SHA that exists in the repo; throws `SddScriptError` (exit 2)
 * otherwise.
 */
export function assertBaseSha(ref: string, opts: { cwd?: string } = {}): void {
  if (typeof ref !== "string" || !/^[0-9a-f]{4,40}$/i.test(ref)) {
    throw new SddScriptError(
      `assertBaseSha: BASE must be a commit SHA (full or prefix); got ${JSON.stringify(ref)}. ` +
        "Never use HEAD~1 as review BASE (multi-commit tasks truncate).",
      2,
    );
  }
  try {
    // `^{commit}` forces an object-store lookup: bare `rev-parse --verify`
    // accepts any well-formed 40-hex string without checking existence.
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new SddScriptError(`assertBaseSha: commit not found: ${ref}`, 2);
  }
}

/**
 * True when `{sddDir}/task-N-report.md` exists and is non-empty
 * (file-handoffs.md: the implementer writes a full report to
 * `task-N-report.md`; an empty file carries no evidence).
 */
export function taskReportExists(sddDir: string, taskN: number): boolean {
  try {
    const st = statSync(join(sddDir, `task-${taskN}-report.md`));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Read the progress ledger (mstar-sdd SKILL.md § Progress ledger) as
 * non-empty trimmed lines; missing `progress.md` reads as `[]`. Tasks
 * marked `Task N: complete` are DONE and must not be re-dispatched.
 */
export function readProgressLedger(sddDir: string): string[] {
  let content: string;
  try {
    content = readFileSync(join(sddDir, "progress.md"), "utf8");
  } catch {
    return [];
  }
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Sticky implementer session ledger — `{SDD_DIR}/implementer-session.json`
 * (sticky-implementer-session.md § Session ledger).
 */
export type ImplementerSessionLedger = {
  plan_id: string;
  execute_as: string;
  session_mode: "sticky" | "fresh";
  host: string;
  /** Agent id from the first Task return — required for resume. */
  host_agent_id?: string;
  working_branch: string;
  started_task: number;
  last_task: number;
  started_at: string;
};

/** Input to `implementerSessionStickyRules`. */
export type StickyRulesInput = {
  session: ImplementerSessionLedger;
  /** Task about to be dispatched. */
  nextTask: number;
  /** Tasks covered by this dispatch (micro-batch); default 1. */
  microBatchTasks?: number;
};

/** Verdict of the sticky resume rules. */
export type StickyRulesResult = {
  resume: boolean;
  reason: string;
};

/**
 * Sticky resume rules (sticky-implementer-session.md + SKILL.md red flag
 * "Resume implementer without host_agent_id"): a sticky session may only
 * resume when `session_mode` is `sticky`, `host_agent_id` is present,
 * `nextTask` is not already completed through `last_task`, and the
 * micro-batch size is ≤ 3 (max without user override). Reviewers never
 * resume — that rule lives in the PM flow, not the session ledger.
 */
export function implementerSessionStickyRules(input: StickyRulesInput): StickyRulesResult {
  const { session, nextTask, microBatchTasks = 1 } = input;
  if (session.session_mode !== "sticky") {
    return { resume: false, reason: `session_mode is '${session.session_mode}'; sticky resume requires 'sticky'` };
  }
  if (typeof session.host_agent_id !== "string" || session.host_agent_id.length === 0) {
    return {
      resume: false,
      reason:
        "host_agent_id is missing from implementer-session.json; fall back to fresh for this task " +
        "(mstar-sdd SKILL.md red flag: resume implementer without host_agent_id)",
    };
  }
  if (nextTask <= session.last_task) {
    return {
      resume: false,
      reason: `nextTask ${nextTask} <= last_task ${session.last_task}; task already completed in this session`,
    };
  }
  if (microBatchTasks < 1 || microBatchTasks > 3) {
    return {
      resume: false,
      reason: `micro-batch of ${microBatchTasks} tasks is outside 1..3 (max 3 without user override, ` +
        "sticky-implementer-session.md \u00a7 Micro-batch fallback)",
    };
  }
  return { resume: true, reason: `sticky resume OK: host_agent_id ${session.host_agent_id}, next task ${nextTask}` };
}
