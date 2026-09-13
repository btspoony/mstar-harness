import { collectActiveLifecycleBranches } from "./lifecycle-branches.js";
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
 * slice 2 (roadmap §8.2) before the
 * scripts were removed in slice 5.
 *
 * Harness-root override: `MSTAR_HARNESS_DIR` env / `opts.harnessDir` (plan
 * finding 2026-08-08) — the status.json probe only knows the probed names
 * (`.mstar`/`.agents`) and picks the wrong root in repos with another root;
 * the engine honors the explicit override in addition to CONTROL_ROOT.
 *
 * SDD execution context (spec A3):
 * `SddExecutionContext` / `resolveSddExecutionContext` / `checkSddAction`
 * resolve the control harness root / feature worktree cwd / artifact
 * destinations and gate actions at supported seams (source cwd, artifact
 * target, launch destination) before mutation; `runInSddContext` is the
 * bound argv launcher (cwd = feature worktree, no shell, inherited env and
 * stdio), and `taskBrief` / `reviewPackage` accept an optional `context` to
 * gate their artifact writes before mkdir/write. Branch/lease/path semantics
 * are reused from `worktree.ts` / `lease.ts` / `path.ts` — never duplicated.
 * Checks are read-only: a refused action performs no write. Context-less
 * helper calls remain explicitly unbound — no protection claim. Remaining
 * blind spots are part of the contract (A3): a child can deliberately
 * chdir, pass an overriding cwd flag, or write an absolute path; explicit
 * check-context is a snapshot, not a future-write lock.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertPlanWritingPath,
  assertSafePathComponent,
  canonicalizeNearestExisting,
  resolveSddDir,
  resolveWorkflowDir,
} from "./path.js";
import { findMstarc, parseMstarc } from "./mstarc.js";
import { readJson, type GateResult, type Severity, type ValidationResult } from "./core.js";
import { verifyPlanExecutionLease } from "./lease.js";
import { WORKFLOW_SNAPSHOT_FILE } from "./workflow.js";
import { assertBranchAlignment, gitProbeTimeoutMs, isDistinctCheckout, l1PreDispatchCheck, probeCheckoutRoot, readMainWorktree } from "./worktree.js";

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
 /** Main worktree repo root — CLI 2nd arg / `MSTAR_CONTROL_ROOT`. */
  controlRoot?: string;
 /** Explicit harness root — `MSTAR_HARNESS_DIR` / `--harness-dir`. */
  harnessDir?: string;
 /** Working directory for git probes; default `process.cwd()`. */
  cwd?: string;
};

/**
 * Options for `taskBrief` (mirrors `$SDD_DIR` for the default out path).
 *
 * Bound mode (spec A3): passing
 * `context` makes the destination an artifact gate check (before any
 * mkdir/write), defaults the destination to `{context.sddDir}/task-N-brief.md`
 * and returns/emits an absolute path. Without `context` the legacy helper
 * stays explicitly UNBOUND — a context-less call has no protection claim
 * (A3: "context-less legacy helper calls remain explicitly unbound").
 */
export type TaskBriefOptions = {
  sddDir?: string;
 /** Resolved SDD execution context — binds the artifact write (A3). */
  context?: SddExecutionContext;
 /** Observed invocation cwd for the artifact gate; default `process.cwd()`. */
  cwd?: string;
};

/**
 * Options for `reviewPackage` (mirrors `$SDD_DIR` + git probe cwd).
 *
 * Bound mode (spec A3): passing `context` makes the destination an artifact
 * gate check (before any mkdir/write), defaults the git probe cwd to the
 * context's feature worktree ("feature Git cwd, control artifact out") and
 * returns/emits an absolute path. Without `context` the legacy helper stays
 * explicitly UNBOUND — no protection claim.
 */
export type ReviewPackageOptions = {
  sddDir?: string;
 /** Git probe cwd; bound mode defaults to `context.featureCwd`. */
  cwd?: string;
 /** Resolved SDD execution context — binds the artifact write (A3). */
  context?: SddExecutionContext;
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
 * Git capture ceiling for `gitOut` / `reviewPackage` : Node's
 * default 1 MiB `maxBuffer` ENOBUFS'd on large review ranges. 64 MiB keeps
 * realistic iteration-close ranges working while bounding memory; captures
 * beyond that fail as SddScriptError via the CLI.
 */
export const GIT_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

/** Run git, returning trimmed stdout or null on failure. */
function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_CAPTURE_MAX_BYTES,
      timeout: gitProbeTimeoutMs(),
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Harness probe: a harness dir only counts when it carries `status.json`
 * (that is what distinguishes a real control harness from a linked feature
 * checkout under default gitignore) — or, in the v3 workflow-engine world,
 * an active workflow lifecycle: `workflows/<id>/snapshot.json` presence
 * proves a live harness even before/without the root `status.json`.
 */
function probeHarnessWithStatus(root: string): string | null {
  if (isFile(join(root, ".mstar", "status.json"))) return join(root, ".mstar");
  if (isFile(join(root, ".agents", "status.json"))) return join(root, ".agents");
  if (hasWorkflowSnapshot(join(root, ".mstar"))) return join(root, ".mstar");
  if (hasWorkflowSnapshot(join(root, ".agents"))) return join(root, ".agents");
  return null;
}

/** True when `{WORKFLOW_DIR}/<id>/snapshot.json` exists for any id. The
 * workflow dir comes from the engine resolver (Phase-5 F1): a `.mstarc`
 * `[config] workflow_dir` declaration wins, else `{HARNESS_DIR}/workflows`
 * — a custom layout is probed at the same location the runtime writes.
 * Probe semantics: never throws (a resolver failure falls back to the
 * default name). */
function hasWorkflowSnapshot(harnessDir: string): boolean {
  let workflowsDir: string;
  try {
    workflowsDir = resolveWorkflowDir(harnessDir, { harnessDir });
  } catch {
    workflowsDir = join(harnessDir, "workflows");
  }
  if (!isDirectory(workflowsDir)) return false;
  try {
    for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && isFile(join(workflowsDir, entry.name, "snapshot.json"))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Checkout root containing `dir`, probed through the nearest EXISTING
 * ancestor (a not-yet-created harness dir resolves through its parent).
 * When the walk starts inside `boundary` it never probes above the
 * boundary — a non-Git main root must not inherit an unrelated ancestor's
 * checkout identity. `null` when no Git checkout contains the walk.
 */
function checkoutRootNearestExisting(dir: string, boundary: string): string | null {
  const stop = resolve(boundary);
  const startInside = isInside(resolve(dir), stop);
  let current = resolve(dir);
  for (;;) {
    const probed = probeCheckoutRoot(current);
    if (probed !== null) return probed;
    if (startInside && current === stop) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    if (startInside && !isInside(parent, stop)) return null; // next hop leaves the boundary
    current = parent;
  }
}

/**
 * Resolve and ensure `{SDD_DIR}` = `{HARNESS_DIR}/sdd/<plan-id>/` (prints
 * the absolute path). Resolution order:
 *
 * 1. Git-derived MAIN discovery FIRST (fail-closed): the process-SSOT
 *    control root is the MAIN worktree (`readMainWorktree` — the first
 *    `git worktree list --porcelain -z` record). From a linked checkout the
 *    first record still reaches main; a failed/unavailable probe (null)
 *    refuses BEFORE any harness resolution or mkdir — nothing is written.
 * 2. An explicit `controlRoot` (CLI 2nd arg / `MSTAR_CONTROL_ROOT`) must BE
 *    the main worktree when Git is available — an integration/foreign
 *    linked checkout is refused, never silently redirected; explicit
 *    non-Git standalone roots are preserved;
 * 3. explicit harness-root override (`opts.harnessDir` / `MSTAR_HARNESS_DIR`)
 *    — resolved relative to the established main root;
 * 4. `.mstarc` `[config] harness_dir` at the main root (repo-declared root;
 *    resolved against the config file's directory);
 * 5. `status.json` probe at the main root (`.mstar` → `.agents`);
 * 6. fallback: existing `.mstar`/`.agents` dir under the main root, else
 *    `.mstar`;
 * 7. the resolved harness dir must not redirect the process SSOT into a
 *    linked/foreign Git checkout — refused before any mkdir/write.
 */
export function sddWorkspace(planId: string, opts: SddWorkspaceOptions = {}): string {
  if (!planId) {
    throw new SddScriptError(
      "usage: mstar sdd workspace PLAN_ID [CONTROL_ROOT]\n" +
        "  Set MSTAR_CONTROL_ROOT=<main-repo-root> when running from a feature worktree.",
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
    const supplied = realpathSync(controlRoot);
    const main = readMainWorktree(supplied);
    if (main !== null) {
      if (main.root !== supplied) {
 // The supplied root is a linked (integration/foreign) checkout of the
 // discovered main worktree — the process control root is the main
 // worktree itself. Refuse, never silently redirect.
        throw new SddScriptError(
          `mstar sdd workspace: CONTROL_ROOT / MSTAR_CONTROL_ROOT "${supplied}" is a linked (integration/foreign) checkout of the main worktree "${main.root}".\n` +
            `  The process control root is the main worktree itself \u2014 refusing to redirect the process SSOT.\n` +
            `  Re-run with MSTAR_CONTROL_ROOT=${main.root}`,
          1,
        );
      }
      root = main.root;
    } else if (isFile(join(supplied, ".git")) || gitOut(supplied, ["rev-parse", "--is-inside-work-tree"]) === "true") {
 // A Git checkout whose main discovery failed — fail closed; a failed
 // Git probe must never fall through to mkdir.
      throw new SddScriptError(
        `mstar sdd workspace: cannot verify the main worktree for CONTROL_ROOT "${supplied}" (git worktree discovery failed).\n` +
          `  Refusing to resolve or create any SDD tree without a verified main worktree.`,
        1,
      );
    } else {
 // Explicit non-Git standalone SDD root — preserved.
      root = supplied;
    }
  } else {
    const main = readMainWorktree(cwd);
    if (main === null) {
 // Fail-closed FIRST (iteration spec worktree-write-model § Field
 // semantics): without a verified main root the engine never resolves or
 // creates any SDD tree — a failed Git probe must not fall through to
 // mkdir, and no automatic non-Git discovery may authorize a
 // linked-checkout write.
      throw new SddScriptError(
        `mstar sdd workspace: cannot verify the main worktree from cwd ${cwd} (git worktree discovery failed, git is unavailable, or the directory is not a Git worktree).\n` +
          `  Refusing to resolve or create any SDD tree without a verified main worktree \u2014 no second process-SSOT tree is ever created under a linked checkout.\n` +
          `  Re-run with MSTAR_CONTROL_ROOT=<main-repo-root> or: mstar sdd workspace ${planId} <main-repo-root>`,
        1,
      );
    }
    root = main.root;
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

 // The resolved harness dir must not redirect the process SSOT into a
 // linked/foreign Git checkout (an absolute override or a `.mstarc`
 // declaration could). The checkout containing the harness (nearest
 // existing ancestor) must be the established main root — a walk bounded
 // at the root so a non-Git main root never inherits an unrelated
 // ancestor's checkout identity.
  const harnessCheckout = checkoutRootNearestExisting(harnessDir, root);
  if (harnessCheckout !== null && harnessCheckout !== root) {
    throw new SddScriptError(
      `mstar sdd workspace: harness root "${harnessDir}" resolves inside Git checkout "${harnessCheckout}", not the verified main worktree "${root}".\n` +
        `  Refusing to redirect the process SSOT into a linked checkout \u2014 resolve MSTAR_HARNESS_DIR / .mstarc harness_dir relative to the main worktree.`,
      1,
    );
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
 *
 * Bound mode (`opts.context`, spec A3): the artifact destination is gated
 * with `checkSddAction` BEFORE any mkdir/write — a refused destination
 * writes nothing — and the returned path is absolute. The INPUT is bound
 * too: the plan file must canonicalize to the context's `planFile`, and a
 * mismatch is refused (exit 1) before any read or write — a foreign plan's
 * content must never land in this plan's SDD dir. Context-less calls
 * keep the legacy unbound behavior (no protection claim).
 */
export function taskBrief(planFile: string, taskN: number, outFile?: string, opts: TaskBriefOptions = {}): string {
  if (!planFile || !Number.isInteger(taskN) || taskN < 1) {
    throw new SddScriptError("usage: mstar sdd task-brief PLAN_FILE TASK_NUMBER [OUTFILE]", 2);
  }
  const bound = opts.context;
  const observedCwd = opts.cwd ?? process.cwd();
  if (bound) {
 // Bound input binding: the plan file read must BE the context's plan
 // file (canonical comparison — equivalent paths via symlinked ancestors
 // pass). A foreign plan's content must never land in this plan's SDD
 // dir, so the mismatch is refused before any read or write.
    const inputPlan = canonicalizeNearestExisting(resolve(observedCwd, planFile));
    if (inputPlan !== canonicalizeNearestExisting(bound.planFile)) {
      throwGateFail([
        contextViolation(
          "high",
          "sdd.context.plan-file-mismatch",
          `plan file "${planFile}" does not match the bound context plan file "${bound.planFile}" \u2014 ` +
            "bound mode extracts only the resolved context's plan; refused before any read or write",
        ),
      ]);
    }
  }
  let content: string;
  try {
    content = readFileSync(planFile, "utf8");
  } catch {
    throw new SddScriptError(`no such plan file: ${planFile}`, 2);
  }

  let out: string;
  let mkdirAfterGate: string | null = null;
  if (outFile) {
 // Bound mode emits absolute paths; unbound keeps the legacy literal path.
    out = bound ? resolve(observedCwd, outFile) : outFile;
  } else if (bound) {
    out = join(bound.sddDir, `task-${taskN}-brief.md`);
    mkdirAfterGate = bound.sddDir;
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
  if (bound) {
 // Gate BEFORE mkdir/write — a refused destination creates nothing.
    const gate = checkSddAction(bound, { kind: "artifact", cwd: observedCwd, target: out });
    if (!gate.ok) throwGateFail(gate.violations);
    if (mkdirAfterGate !== null) mkdirSync(mkdirAfterGate, { recursive: true });
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
 // Bound mode emits absolute paths (A3: handoff producers carry absolute
 // destinations); unbound keeps the legacy literal return.
  return bound ? resolve(observedCwd, out) : out;
}

/**
 * Write commit list, stat summary and `git diff -U10` for `BASE..HEAD`
 * into a file (default `{SDD_DIR}/review-<short base>..<short head>.diff`).
 * Both refs are validated with `git rev-parse --verify --quiet` (any ref
 * the original accepted is accepted here; the SHA-only guard is
 * `assertBaseSha`).
 *
 * Bound mode (`opts.context`, spec A3): the review range is probed in the
 * context's feature worktree (feature Git cwd) while the package lands in
 * the plan's control artifacts — gated with `checkSddAction` BEFORE any
 * mkdir/write (a refused destination writes nothing). The returned path is
 * absolute. Context-less calls keep the legacy unbound behavior (no
 * protection claim); an explicit `opts.cwd` still overrides the git probe
 * cwd in both modes.
 */
export function reviewPackage(base: string, head: string, outFile?: string, opts: ReviewPackageOptions = {}): string {
  if (!base || !head) {
    throw new SddScriptError("usage: mstar sdd review-package BASE HEAD [OUTFILE]", 2);
  }
  const bound = opts.context;
  const cwd = bound && opts.cwd === undefined ? bound.featureCwd : (opts.cwd ?? process.cwd());
  const observedCwd = opts.cwd ?? process.cwd();

  const verifyRef = (ref: string, what: "BASE" | "HEAD"): void => {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: gitProbeTimeoutMs() });
    } catch {
      throw new SddScriptError(`bad ${what}: ${ref}`, 2);
    }
  };
  verifyRef(base, "BASE");
  verifyRef(head, "HEAD");

  let out: string;
  let mkdirAfterGate: string | null = null;
  if (outFile) {
 // Bound mode emits absolute paths; unbound keeps the legacy literal path.
    out = bound ? resolve(observedCwd, outFile) : outFile;
  } else if (bound) {
    const shortBase = gitOut(cwd, ["rev-parse", "--short", base]) ?? base;
    const shortHead = gitOut(cwd, ["rev-parse", "--short", head]) ?? head;
    out = join(bound.sddDir, `review-${shortBase}..${shortHead}.diff`);
    mkdirAfterGate = bound.sddDir;
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
  if (bound) {
 // Gate BEFORE mkdir/write — a refused destination creates nothing.
    const gate = checkSddAction(bound, { kind: "artifact", cwd: observedCwd, target: out });
    if (!gate.ok) throwGateFail(gate.violations);
    if (mkdirAfterGate !== null) mkdirSync(mkdirAfterGate, { recursive: true });
  }

  const run = (args: string[]): Buffer =>
    execFileSync("git", args, { cwd, maxBuffer: GIT_CAPTURE_MAX_BYTES, timeout: gitProbeTimeoutMs() });
  const commits = run(["log", "--oneline", `${base}..${head}`]);
  // FAIL LOUD on an empty range instead of writing an empty package. The range
  // resolves to nothing whenever the command runs outside the branch worktree
  // (e.g. from the control checkout, where HEAD is the base): the package then
  // has empty `## Commits` / `## Diff` sections and a QC seat would be handed a
  // file with nothing to review while every exit code stays 0. An empty commit
  // list is never a legitimate review input, so refuse before any write.
  if (commits.length === 0) {
    throw new SddScriptError(
      `review package range ${base}..${head} is empty in ${cwd} \u2014 refusing to write an empty package ` +
        `(run the command from the branch worktree, not the control checkout)`,
      1,
    );
  }
 // `{ echo …; git …; } > file` layout, byte-for-byte.
  const parts: Buffer[] = [
    Buffer.from(`# Review package: ${base}..${head}\n\n## Commits\n`),
    commits,
    Buffer.from("\n## Files changed\n"),
    run(["diff", "--stat", `${base}..${head}`]),
    Buffer.from("\n## Diff\n"),
    run(["diff", "-U10", `${base}..${head}`]),
  ];
  writeFileSync(out, Buffer.concat(parts));
 // Bound mode emits absolute paths (A3); unbound keeps the legacy return.
  return bound ? resolve(observedCwd, out) : out;
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
      timeout: gitProbeTimeoutMs(),
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

/**
 * Resolved SDD execution context (spec A3): where control artifacts live,
 * where feature source edits happen, and which branch the feature checkout
 * must be on. All paths normalized absolute (canonicalized on resolve);
 * `planFile` / `sddDir` must resolve within the control harness and match
 * `planId`; the feature branch/worktree must match the verified lease when
 * an active workflow supplies one (standalone non-iteration contexts remain
 * possible under the existing branch policy — no new global lease mandate).
 * A declared control root is authoritative: it is never re-inferred from
 * the feature cwd (mstar-branch-worktree «Harness path SSOT»).
 */
export type SddExecutionContext = {
  planId: string;
 /** Control harness dir (`<control-worktree>/{HARNESS_DIR}`), absolute. */
  controlHarnessRoot: string;
 /** Feature worktree — the required cwd for product/source edits, absolute. */
  featureCwd: string;
 /** Assignment Working branch checked out at `featureCwd`. */
  workingBranch: string;
 /** Control plan file (`{PLAN_DIR}/<plan-id>.md`), absolute. */
  planFile: string;
 /** Control `{SDD_DIR}` = `{HARNESS_DIR}/sdd/<plan-id>/`, absolute. */
  sddDir: string;
};

/** One action seam to gate with `checkSddAction` (spec A3). */
export type SddAction = {
  /**
 * Observed invocation cwd — the real cwd at the seam, never an Assignment
 * echo. Relative `target` values resolve from this cwd.
 */
  cwd: string;
 /** Path the action would touch; optional for source/launch, required for artifact. */
  target?: string;
  kind: SddActionKind;
};

/** Action seam kinds (spec A3): feature source write, control artifact write, child-process launch. */
export type SddActionKind = "source" | "artifact" | "launch";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `child` is `ancestor` itself or a descendant (lexical, both absolute). */
function isInside(child: string, ancestor: string): boolean {
  const rel = relative(ancestor, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** realpath of `path` when it exists and is a directory; `null` otherwise. */
function canonicalDir(path: string): string | null {
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

function contextViolation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

/** Throw one `SddScriptError` summarizing a failed gate (exit 1 — gate fail). */
function throwGateFail(violations: readonly ValidationResult[]): never {
  const detail = violations
    .map((v) => `${v.code}: ${v.message}${v.fix ? ` (fix: ${v.fix})` : ""}`)
    .join("\n  ");
  throw new SddScriptError(`SDD execution context rejected:\n  ${detail}`, 1);
}

function throwUsage(message: string): never {
  throw new SddScriptError(message, 2);
}

/**
 * Recorded main-worktree branch from the declared plan file (the plan
 * header `**Main worktree branch**: <branch>` written at lifecycle start —
 * SDD reads the plan it already declares). Missing record → `""`: the
 * caller falls back conservatively to the governing snapshot's explicit
 * `branch.base`, never to the branch observed at check time.
 */
function recordedMainWorktreeBranch(planFile: string): string {
  try {
    const text = readFileSync(planFile, "utf8");
    const match = text.match(/^\s*\*{0,2}Main worktree branch\*{0,2}\s*[:\uff1a][ \t]*(\S+)/m);
    return match ? match[1]! : "";
  } catch {
    return "";
  }
}

/**
 * Outcome of the workflow plan-row lookup: the governing row from the single
 * registered active workflow holding the plan (`row`) plus the governing
 * snapshot document (its integration topology feeds L1) and the readable
 * ACTIVE snapshots (the lifecycle-owned branch set), no active workflow at
 * all (`none` — standalone branch policy applies), or the plan claimed by
 * more than one registered active workflow (`ambiguous` — fail-closed).
 */
type WorkflowPlanRowMatch =
  | { kind: "none" }
  | {
      kind: "row";
      workflowId: string;
      row: Record<string, unknown>;
      /** Governing snapshot document (legacy `control_worktree_path` normalized in memory). */
      snapshot: Record<string, unknown>;
      /** Readable active lifecycle snapshots — the L1 lifecycle-branch ownership set. */
      activeSnapshots: readonly Record<string, unknown>[];
    }
  | { kind: "ambiguous"; workflowIds: string[] };

/**
 * Minimal in-memory normalization for the governing-row lookup: the
 * canonical reader (`readWorkflowSnapshot`) owns full validation, but the
 * row lookup must tolerate partially-written snapshots (the lenient
 * row-preserving read is unchanged) — so it normalizes ONLY the single
 * permitted legacy alias. A document carrying BOTH path keys is corrupted
 * topology and is refused for a governing active row rather than normalized.
 */
function normalizeSnapshotWorktreePath(doc: Record<string, unknown>): Record<string, unknown> | null {
  const legacy = doc.control_worktree_path;
  const canonical = doc.integration_worktree_path;
  if (legacy !== undefined && canonical !== undefined) return null;
  if (legacy === undefined) return doc;
  const { control_worktree_path: _dropped, ...rest } = doc;
  return { ...rest, integration_worktree_path: legacy };
}

/**
 * Registered active workflow ids from the v2 root `status.json`
 * (`{HARNESS_DIR}/status.json` — the same harness root the snapshots live
 * under). The `workflows[]` list holds ACTIVE lifecycles only
 * (removal-at-terminal), so it is the register that decides which retained
 * snapshot is live. Returns `null` when no v2 register is present or
 * readable (missing file, malformed JSON, non-v2 document, missing
 * `workflows[]`) — the caller then keeps the legacy first-match behavior.
 * Read-only.
 */
function readActiveWorkflowIds(controlHarnessRoot: string): Set<string> | null {
  const statusPath = join(controlHarnessRoot, "status.json");
  if (!isFile(statusPath)) return null;
  let doc: unknown;
  try {
    doc = readJson(statusPath);
  } catch {
    return null;
  }
  if (!isPlainObject(doc) || doc.version !== 2 || !Array.isArray(doc.workflows)) return null;
  const ids = new Set<string>();
  for (const entry of doc.workflows) {
    if (isPlainObject(entry) && typeof entry.id === "string") ids.add(entry.id);
  }
  return ids;
}

/**
 * Find the GOVERNING plan row for `planId` across the control harness's
 * workflow snapshots (`{WORKFLOW_DIR}/<id>/snapshot.json`, v3 SSOT — same
 * probe shape as `probeHarnessWithStatus`), resolved against the v2 root
 * workflow register:
 *
 * - a snapshot whose workflow id is registered active in
 * `status.json` `workflows[]` wins over retained terminal snapshots —
 * filesystem scan order never lets a completed lifecycle shadow a live
 * one; the row match carries the governing snapshot document (legacy alias
 * normalized in memory) and every readable ACTIVE snapshot (the
 * lifecycle-owned branch ownership set for L1);
 * - the plan appearing in MORE THAN ONE registered active workflow is
 * ambiguous — returned as `kind: "ambiguous"` so the caller fails closed
 * instead of silently picking one;
 * - a match ONLY in snapshots that are not registered active (retained
 * terminal lifecycles) is `kind: "none"` — a terminal snapshot must never
 * satisfy lease enforcement;
 * - without a v2 register the legacy behavior is unchanged: the first
 * snapshot mentioning the plan wins (the ownership set is every readable
 * snapshot — no register to distinguish active from terminal).
 *
 * Unreadable/malformed snapshots are skipped (consistent with
 * `hasWorkflowSnapshot`): an unreadable snapshot cannot establish an active
 * workflow. Read-only.
 */
function findWorkflowPlanRow(controlHarnessRoot: string, planId: string): WorkflowPlanRowMatch {
  let workflowsDir: string;
  try {
    workflowsDir = resolveWorkflowDir(controlHarnessRoot, { harnessDir: controlHarnessRoot });
  } catch {
    return { kind: "none" };
  }
  if (!isDirectory(workflowsDir)) return { kind: "none" };
  let workflowIds: string[];
  try {
    workflowIds = readdirSync(workflowsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { kind: "none" };
  }
  const registeredActive = readActiveWorkflowIds(controlHarnessRoot);
  const scanned: { workflowId: string; doc: Record<string, unknown> }[] = [];
  const matches: { workflowId: string; row: Record<string, unknown>; doc: Record<string, unknown> }[] = [];
  for (const id of workflowIds) {
    const snapshotPath = join(workflowsDir, id, WORKFLOW_SNAPSHOT_FILE);
    if (!isFile(snapshotPath)) continue;
    let doc: Record<string, unknown>;
    try {
      doc = readJson(snapshotPath);
    } catch {
      continue; // malformed snapshot — cannot establish an active workflow
    }
    const normalized = normalizeSnapshotWorktreePath(doc);
    if (normalized === null) {
      if ((registeredActive === null || registeredActive.has(id)) && Array.isArray(doc.plans) &&
          doc.plans.some((row) => isPlainObject(row) && (row.id === planId || row.plan_id === planId))) {
        throw new SddScriptError(`refusing conflicting integration_worktree_path / control_worktree_path in ${snapshotPath}`, 1);
      }
      continue;
    }
    scanned.push({ workflowId: id, doc: normalized });
    const plans = normalized.plans;
    if (!Array.isArray(plans)) continue;
    for (const row of plans) {
      if (isPlainObject(row) && (row.id === planId || row.plan_id === planId)) {
        matches.push({ workflowId: id, row, doc: normalized });
        break; // one row per snapshot is enough for the register comparison
      }
    }
  }
  if (matches.length === 0) return { kind: "none" };
  if (registeredActive === null) {
    return {
      kind: "row",
      workflowId: matches[0]!.workflowId,
      row: matches[0]!.row,
      snapshot: matches[0]!.doc,
      activeSnapshots: scanned.map((s) => s.doc),
    };
  }
  const active = matches.filter((m) => registeredActive.has(m.workflowId));
  if (active.length === 0) return { kind: "none" }; // only unregistered (terminal) snapshots mention the plan
  if (active.length > 1) {
    return { kind: "ambiguous", workflowIds: active.map((m) => m.workflowId) };
  }
  // The L1 lifecycle-branch ownership set spans ALL registered active
  // lifecycles, never only the governing one.
  const activeDocs = scanned.filter((s) => registeredActive.has(s.workflowId)).map((s) => s.doc);
  return {
    kind: "row",
    workflowId: active[0]!.workflowId,
    row: active[0]!.row,
    snapshot: active[0]!.doc,
    activeSnapshots: activeDocs,
  };
}

/**
 * Resolve and validate a declared SDD execution context (spec A3) into a
 * canonical context. Read-only — resolves/validates, never writes.
 *
 * Validation (reusing the existing machinery — never duplicated here):
 * - shape: all paths absolute, `planId` a single safe path component
 * (`assertSafePathComponent`);
 * - `controlHarnessRoot` exists (declared root is authoritative — never
 * re-inferred from the feature cwd);
 * - `planFile` identity (basename stem = `planId`) + placement via
 * `assertPlanWritingPath` (inside `{PLAN_DIR}` of the control harness,
 * symlink escape checked against the canonical path);
 * - `sddDir` canonicalizes (nearest existing ancestor on BOTH sides) to the
 * same path as `resolveSddDir(controlHarnessRoot, planId)` — the path
 * SSOT composition, `.mstarc` overrides included; equivalent string forms
 * of one physical destination are valid. Composition equality on the
 * canonical pair subsumes the escape case — a declared sddDir cannot
 * equal the canonical composition and escape at the same time — so
 * divergence is classified at one decision point: divergence because the
 * declared path physically canonicalizes OUTSIDE the control harness
 * (symlinked sdd segment routing out) is environmental →
 * `sdd.context.sdd-dir-escape` gate fail (exit 1); any other divergence
 * (wrong declaration) is usage (exit 2). A context matching a
 * `.mstarc`-declared sdd base is honored wherever the repo's own path
 * SSOT composes it — the engine never second-guesses a composition it
 * would itself produce (`resolveSddDir` is authoritative);
 * - `featureCwd` exists and never nests with the control checkout
 * (`featureCwd` inside the control checkout, or the control harness
 * inside the feature checkout, are both refused — L1 hard rules);
 * - branch/lease: when the control harness's workflow snapshots supply a
 * plan row from a REGISTERED ACTIVE workflow (v2 root `status.json`
 * `workflows[]`; a retained terminal snapshot never satisfies lease
 * enforcement, and a plan claimed by multiple active workflows fails
 * closed), its lease is verified (`verifyPlanExecutionLease`) and the
 * L1 checklist runs (`l1PreDispatchCheck` with the Git-derived MAIN
 * worktree, the governing snapshot's integration topology, the recorded
 * residency expectation and the active lifecycle-branch ownership set);
 * the context must then match the verified lease exactly. Without an
 * active lease (no row, or a non-InProgress row without lease), the
 * standalone branch policy applies (`assertBranchAlignment`) — an
 * InProgress row without lease is the orphan refusal.
 *
 * Throws `SddScriptError` — exit 2 when the declared context itself is
 * malformed (non-absolute path, identity/composition mismatch, missing plan
 * file), exit 1 when the environment fails the gate (missing dirs, branch
 * mismatch, lease/orphan refusal, symlink escape). A rejected context never
 * reaches an action check.
 */
export function resolveSddExecutionContext(input: SddExecutionContext): SddExecutionContext {
  const { planId, workingBranch } = input;
  if (typeof planId !== "string" || planId.trim() === "") {
    throwUsage("SddExecutionContext.planId must be a non-empty string");
  }
  if (typeof workingBranch !== "string" || workingBranch.trim() === "") {
    throwUsage("SddExecutionContext.workingBranch must be a non-empty string");
  }
  for (const field of ["controlHarnessRoot", "featureCwd", "planFile", "sddDir"] as const) {
    const value = input[field];
    if (typeof value !== "string" || value.trim() === "") {
      throwUsage(`SddExecutionContext.${field} must be a non-empty string`);
    }
    if (!isAbsolute(value)) {
      throwUsage(
        `SddExecutionContext.${field} must be an absolute path (A3: all paths normalized absolute); got ${JSON.stringify(value)}`,
      );
    }
  }
  try {
    assertSafePathComponent(planId, "SddExecutionContext.planId");
  } catch (err) {
    throwUsage(`SddExecutionContext rejected: ${(err as Error).message}`);
  }

  const canonicalControlHarnessRoot = canonicalDir(input.controlHarnessRoot);
  if (canonicalControlHarnessRoot === null) {
    throwGateFail([
      contextViolation(
        "high",
        "sdd.context.control-root-missing",
        `controlHarnessRoot "${input.controlHarnessRoot}" does not exist or is not a directory \u2014 a declared control root is authoritative and is never re-inferred from the feature cwd (A3)`,
      ),
    ]);
  }

  const stem = basename(input.planFile).replace(/\.md$/, "");
  if (stem !== planId) {
    throwUsage(
      `SddExecutionContext.planFile "${input.planFile}" does not match plan "${planId}" \u2014 the plan file must be {PLAN_DIR}/<plan-id>.md under the declared control harness`,
    );
  }
  if (!isFile(input.planFile)) {
    throwUsage(`no such plan file: ${input.planFile}`);
  }
 // Declared paths on both sides — the gate's own canonical step still
 // catches a symlink escape (canonical file vs canonical {PLAN_DIR});
 // mixing declared with realpath'd here would false-fail on symlinked
 // tmp roots (macOS /var → /private/var).
  const planGate = assertPlanWritingPath(input.planFile, input.controlHarnessRoot);
  if (!planGate.ok) {
    if (planGate.code === "plan-path.symlink-escape") {
      throwGateFail([planGate]); // environmental escape — gate fail
    }
    throwUsage(`SddExecutionContext.planFile rejected: ${planGate.code}: ${planGate.message}`);
  }

 // sddDir identity vs the path-SSOT composition, classified at one
 // decision point over the CANONICAL pair: both sides are canonicalized
 // through their nearest existing ancestor, so equivalent destinations
 // with different string forms (a `.mstarc` sdd base reached through a
 // symlink, realpath divergence) compare equal and stay valid. On
 // divergence: a declared path that physically canonicalizes OUTSIDE the
 // control harness (symlinked sdd segment routing out) is environmental →
 // `sdd.context.sdd-dir-escape` gate fail (exit 1); any other divergence
 // (wrong declaration) is usage (exit 2). A context matching a
 // `.mstarc`-declared sdd base is honored wherever the repo's own path
 // SSOT composes it — the engine never second-guesses a composition it
 // would itself produce (`resolveSddDir` is authoritative).
  const composedSddDir = resolveSddDir(canonicalControlHarnessRoot, planId);
  const canonicalComposedSddDir = canonicalizeNearestExisting(composedSddDir);
  const canonicalSddDir = canonicalizeNearestExisting(input.sddDir);
  if (canonicalSddDir !== canonicalComposedSddDir) {
    if (!isInside(canonicalSddDir, canonicalControlHarnessRoot)) {
      throwGateFail([
        contextViolation(
          "high",
          "sdd.context.sdd-dir-escape",
          `sddDir "${input.sddDir}" canonicalizes to "${canonicalSddDir}", outside the control harness "${canonicalControlHarnessRoot}" \u2014 symlink escape refused (environmental gate failure)`,
        ),
      ]);
    }
    throwUsage(
      `SddExecutionContext.sddDir "${input.sddDir}" does not match plan "${planId}" \u2014 expected the {SDD_DIR} composition ${composedSddDir}`,
    );
  }

  const canonicalFeatureCwd = canonicalDir(input.featureCwd);
  if (canonicalFeatureCwd === null) {
    throwGateFail([
      contextViolation(
        "high",
        "sdd.context.feature-cwd-missing",
        `featureCwd "${input.featureCwd}" does not exist or is not a directory \u2014 the feature worktree is the required cwd for product edits`,
        `create the feature worktree first (git worktree add ${input.featureCwd} ${workingBranch})`,
      ),
    ]);
  }

  // L1 hard rules — the feature cwd and the control checkout must not nest
  // UNLESS the feature is a distinct Git checkout: a real linked worktree
  // nested inside the control checkout (the documented .worktrees layout)
  // is a distinct checkout and passes; the same checkout, a plain
  // subdirectory, or a symlink alias of it is refused (checkout identity
  // via the canonical per-worktree git dir; probe failure fails closed).
  //
  // control-inside-feature is checked FIRST (physical, unchanged): a
  // harness declared inside the feature cwd is diagnosed here, before any
  // checkout-root derivation — a git probe from such a misplaced harness
  // would resolve to the feature worktree itself, misdiagnosing the case.
  if (isInside(canonicalControlHarnessRoot, canonicalFeatureCwd)) {
    throwGateFail([
      contextViolation(
        "critical",
        "sdd.context.control-inside-feature",
        `controlHarnessRoot "${canonicalControlHarnessRoot}" is inside featureCwd "${canonicalFeatureCwd}" \u2014 a feature worktree's same-looking {HARNESS_DIR} is not the SSOT; the control harness must live outside the feature checkout`,
      ),
    ]);
  }
  // The control checkout root is derived from the harness dir by a
  // bounded, fail-closed git probe (`--show-toplevel`) — never
  // dirname(harness), which is only correct when the harness sits directly
  // under the checkout (a `.mstarc`-declared nested harness like
  // `<control>/state/.mstar` would otherwise infer the wrong boundary).
  // An unresolvable root (harness outside any git checkout) fails closed.
  const controlCheckout = probeCheckoutRoot(canonicalControlHarnessRoot);
  if (controlCheckout === null) {
    throwGateFail([
      contextViolation(
        "high",
        "sdd.context.control-root-unresolvable",
        `cannot resolve the control checkout root for controlHarnessRoot "${canonicalControlHarnessRoot}" (git rev-parse --show-toplevel failed) \u2014 the control harness must live inside a git checkout`,
        "verify the control harness root is inside the control worktree checkout",
      ),
    ]);
  }
  if (isInside(canonicalFeatureCwd, controlCheckout) && !isDistinctCheckout(canonicalControlHarnessRoot, canonicalFeatureCwd)) {
    throwGateFail([
      contextViolation(
        "critical",
        "sdd.context.feature-in-control",
        `featureCwd "${canonicalFeatureCwd}" is inside the control checkout "${controlCheckout}" and is not a distinct Git checkout \u2014 a plain subdirectory or symlink alias of the control checkout is not isolation; product edits never land in the control checkout (execution_lease.worktree_path MUST be a distinct checkout)`,
        "use a distinct feature worktree for the plan (git worktree add <path> <branch>)",
      ),
    ]);
  }

 // (The sddDir escape classification ran with the composition check above;
 // from here `canonicalSddDir === canonicalComposedSddDir` — the canonical
 // form of the composition produced from the canonical control harness
 // root, so no separate escape check.)

 // Branch/lease policy: verified lease when an active workflow supplies one,
 // standalone branch alignment otherwise (spec A3 — no new global lease mandate).
  const match = findWorkflowPlanRow(canonicalControlHarnessRoot, planId);
  if (match.kind === "ambiguous") {
 // Fail-closed: more than one registered active workflow claims this plan
 // — the governing lease is undecidable, never a silent standalone fallback.
    throwGateFail([
      contextViolation(
        "high",
        "sdd.context.workflow-plan-ambiguous",
        `plan "${planId}" appears in multiple registered active workflows (${match.workflowIds.join(", ")}) \u2014 ` +
          "the governing execution_lease is undecidable; resolve the duplicate registration before dispatch",
      ),
    ]);
  }
  if (match.kind === "row" && match.row.execution_lease !== undefined) {
    const row = match.row;
    const leaseVerify = verifyPlanExecutionLease(row, planId);
    if (!leaseVerify.ok) throwGateFail(leaseVerify.violations);
    const lease = leaseVerify.lease as Record<string, unknown>;
    // L1 consumes the full governing snapshot and the Git-derived MAIN
    // worktree separately (never the harness checkout as a stand-in):
    // main residency against the recorded expectation (plan header, with
    // the explicit branch.base fallback), non-ownership of every active
    // lifecycle branch, the snapshot's integration topology, and the
    // pairwise main/integration/feature checkout identity.
    const snapshot = match.snapshot;
    const main = readMainWorktree(canonicalControlHarnessRoot);
    const snapshotBase =
      isPlainObject(snapshot.branch) && typeof snapshot.branch.base === "string" && snapshot.branch.base.trim() !== ""
        ? snapshot.branch.base
        : "";
    const expectedMainBranch = recordedMainWorktreeBranch(input.planFile) || snapshotBase;
    const l1 = l1PreDispatchCheck({
      workflowType: snapshot.type === "iteration" ? "iteration" : "plan",
      integrationWorktreePath:
        typeof snapshot.integration_worktree_path === "string" ? snapshot.integration_worktree_path : "",
      integrationBranch:
        isPlainObject(snapshot.branch) && typeof snapshot.branch.integration === "string"
          ? snapshot.branch.integration
          : "",
      mainWorktree: main,
      expectedMainBranch,
      lifecycleBranches: collectActiveLifecycleBranches(match.activeSnapshots),
      leaseWorktreePath: lease.worktree_path as string,
      leaseWorkingBranch: lease.working_branch as string,
      planId,
    });
    if (!l1.ok) throwGateFail(l1.violations);
    if (canonicalizeNearestExisting(lease.worktree_path as string) !== canonicalFeatureCwd) {
      throwGateFail([
        contextViolation(
          "high",
          "sdd.context.lease-worktree-mismatch",
          `SddExecutionContext.featureCwd "${canonicalFeatureCwd}" does not match the verified execution_lease.worktree_path "${String(lease.worktree_path)}" \u2014 the context must match the verified lease (A3)`,
        ),
      ]);
    }
    if (workingBranch !== lease.working_branch) {
      throwGateFail([
        contextViolation(
          "high",
          "sdd.context.lease-branch-mismatch",
          `SddExecutionContext.workingBranch "${workingBranch}" does not match the verified execution_lease.working_branch "${String(lease.working_branch)}" (plan "${planId}")`,
        ),
      ]);
    }
  } else if (match.kind === "row" && match.row.status === "InProgress") {
 // InProgress without a lease is the orphan refusal (status-and-residuals
 // § Orphan recovery) — fail with the reused violation, never invent a lease.
    throwGateFail(verifyPlanExecutionLease(match.row, planId).violations);
  } else {
 // Standalone (no active workflow row, or a non-InProgress row without a
 // lease): existing branch policy only — no lease mandate.
    const branchGate = assertBranchAlignment(canonicalFeatureCwd, workingBranch);
    if (!branchGate.ok) throwGateFail(branchGate.violations);
  }

  return {
    planId,
    controlHarnessRoot: canonicalControlHarnessRoot,
    featureCwd: canonicalFeatureCwd,
    workingBranch,
    planFile: realpathSync(input.planFile),
    sddDir: canonicalSddDir,
  };
}

/**
 * Gate one action seam against a resolved context (spec A3). Read-only —
 * a refused action performs no write and the check itself never writes.
 *
 * - `kind: "source"` — the observed `cwd` must sit inside the feature
 * worktree (nested directories allowed); a relative `target` resolves from
 * that actual cwd. Targets outside the feature — traversal, absolute
 * elsewhere, wrong-cwd, or symlink escape — are refused before mutation.
 * - `kind: "artifact"` — the `target` must stay inside the plan's control
 * `sddDir` or equal the declared `planFile`; legitimate control artifact
 * edits are allowed while arbitrary control source edits are not. A
 * nonexistent leaf canonicalizes through its nearest existing ancestor
 * (`canonicalizeNearestExisting`); symlink escapes are refused.
 * - `kind: "launch"` — verifies the resolved launch destination
 * `featureCwd` (exists + on `workingBranch` via the reused
 * `assertBranchAlignment`); the parent's own cwd is not gated, because a
 * launch may legitimately run from control/main — its purpose is to bind
 * the child's starting cwd to the feature worktree. An optional `target`
 * is checked as a source target relative to `featureCwd` (where the child
 * will start).
 *
 * Violations minted here carry the `sdd.context.*` prefix; violations from
 * the reused branch/lease helpers keep their own codes (`worktree.*`,
 * `lease.*`, `plan-path.*`) — the rules stay single-sourced. A3 limits
 * apply: this is a snapshot check, not a future-write lock, and offers no
 * protection against a concurrent hostile symlink swap.
 *
 * API contract (task-1 review Minor 2): `context` must be a
 * `resolveSddExecutionContext`-produced (or equivalently already-validated)
 * context. This function gates the action seam only and does NOT
 * re-validate the context declaration — identity, branch, lease and
 * control/feature nesting checks run at resolve time — so a hand-assembled
 * structurally-valid context gets no protection claim from this check
 * alone.
 */
export function checkSddAction(context: SddExecutionContext, action: SddAction): GateResult {
  const violations: ValidationResult[] = [];
  const add = (code: string, message: string, fix?: string): void => {
    violations.push(contextViolation("high", code, message, fix));
  };

  if (action.kind !== "source" && action.kind !== "artifact" && action.kind !== "launch") {
    add("sdd.context.kind-unknown", `unknown action kind ${JSON.stringify((action as { kind?: unknown }).kind)} \u2014 expected "source" | "artifact" | "launch"`);
    return { ok: false, violations };
  }
  if (typeof action.cwd !== "string" || action.cwd.trim() === "") {
    add("sdd.context.cwd-missing", "action.cwd (the observed invocation cwd) is required \u2014 never an Assignment echo");
    return { ok: false, violations };
  }

  const featureReal = canonicalDir(context.featureCwd);
  const canonicalSddDir = canonicalizeNearestExisting(context.sddDir);
  const canonicalPlanFile = canonicalizeNearestExisting(context.planFile);
  const cwdResolved = resolve(action.cwd);

  /**
 * Physical containment decision: canonicalize the target through its
 * nearest existing ancestor (resolving symlinked ancestors and macOS
 * `/var` → `/private/var`) and compare against the canonical base. When
 * it escapes, the declared-prefix test (same string universe) picks the
 * diagnostic: a declared-inside path routed elsewhere is a symlink
 * escape, anything else is simply outside.
 */
  const checkTarget = (baseDir: string, target: string, kind: "source" | "launch"): void => {
    if (featureReal === null) return; // reported by the kind-specific cwd/launch checks
    const targetAbs = resolve(baseDir, target);
    const canonical = canonicalizeNearestExisting(targetAbs);
    if (!isInside(canonical, featureReal)) {
      const declaredPrefix = targetAbs === featureReal || targetAbs.startsWith(`${featureReal}/`);
      if (declaredPrefix) {
        add(
          "sdd.context.target-symlink-escape",
          `${kind} target "${target}" canonicalizes to "${canonical}", outside the feature worktree \u2014 symlink escape refused before mutation`,
        );
      } else {
        add(
          `sdd.context.${kind}-target-outside-feature`,
          `${kind} target "${target}" resolves to "${targetAbs}", outside the feature worktree "${featureReal}" \u2014 refused before mutation`,
        );
      }
    }
  };

  if (action.kind === "source") {
    const cwdReal = canonicalDir(cwdResolved);
    if (cwdReal === null) {
      add("sdd.context.cwd-missing", `observed source cwd "${action.cwd}" does not exist or is not a directory`);
      return { ok: false, violations };
    }
    if (featureReal === null || !isInside(cwdReal, featureReal)) {
      add(
        "sdd.context.source-cwd-outside-feature",
        `observed source cwd "${cwdReal}" is outside the feature worktree "${context.featureCwd}" \u2014 a declared-correct context does not make a wrong-checkout write safe (A3)`,
        `run the source action from inside ${context.featureCwd}`,
      );
      return { ok: false, violations };
    }
    if (action.target !== undefined) checkTarget(cwdReal, action.target, "source");
  } else if (action.kind === "artifact") {
    if (typeof action.target !== "string" || action.target.trim() === "") {
      add("sdd.context.target-missing", "artifact checks require the destination target");
      return { ok: false, violations };
    }
 // Physical containment against the plan's control artifacts: the target
 // (canonicalized through its nearest existing ancestor) must stay inside
 // the plan's sddDir or equal the declared planFile — legitimate control
 // artifact edits are allowed while arbitrary control source edits are not.
    const targetAbs = resolve(cwdResolved, action.target);
    const canonical = canonicalizeNearestExisting(targetAbs);
    if (!isInside(canonical, canonicalSddDir) && canonical !== canonicalPlanFile) {
 // Same-universe declared-prefix test picks the diagnostic code only.
      const rawSddDir = resolve(context.sddDir);
      const declaredPrefix =
        targetAbs === rawSddDir ||
        targetAbs.startsWith(`${rawSddDir}/`) ||
        targetAbs === canonicalSddDir ||
        targetAbs.startsWith(`${canonicalSddDir}/`) ||
        targetAbs === canonicalPlanFile;
      if (declaredPrefix) {
        add(
          "sdd.context.artifact-symlink-escape",
          `artifact target "${targetAbs}" canonicalizes to "${canonical}", outside the plan's control sddDir \u2014 symlink escape refused before write`,
        );
      } else {
        add(
          "sdd.context.artifact-outside-plan",
          `artifact target "${targetAbs}" is outside the plan's control sddDir "${context.sddDir}" and is not the declared planFile "${context.planFile}" \u2014 legitimate control artifact edits stay inside the plan's artifacts; arbitrary control source edits are not allowed (A3)`,
        );
      }
    }
  } else {
 // launch: verify the resolved launch destination, not the parent's cwd.
    if (featureReal === null) {
      add(
        "sdd.context.launch-cwd-missing",
        `feature worktree "${context.featureCwd}" does not exist or is not a directory \u2014 cannot bind the child's starting cwd`,
      );
    } else {
 // Reused branch semantics (worktree.branch-* codes) — not duplicated.
      violations.push(...assertBranchAlignment(featureReal, context.workingBranch).violations);
    }
    if (action.target !== undefined && action.target.trim() !== "" && featureReal !== null) {
 // The child starts in featureCwd: check the target the way the child
 // would resolve it (relative values from featureCwd).
      checkTarget(featureReal, action.target, "launch");
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * POSIX signal name → conventional exit number (bash `128+n` convention),
 * resolved from the runtime's public signal constants. An unlisted name
 * falls back to 0 (→ exit 128) — documented edge, not a protection claim.
 */
function signalExitNumber(signal: string): number {
  return (osConstants.signals as Record<string, number>)[signal] ?? 0;
}

/**
 * Bound argv launcher (spec A3):
 * resolve + gate the context, then spawn a DIRECT executable argv — never
 * a shell (no command-string interpolation; the argv array reaches the
 * child literally, spaces/`$()`/backticks unchanged) — with
 * cwd = the resolved feature worktree, inherited stdio and the inherited
 * process environment unchanged (no HOME/CODEX_HOME edits, no credential
 * copies). The parent's own cwd is deliberately not gated: a launch may
 * run from control/main, and the `launch` seam validates the resolved
 * launch destination (featureCwd + workingBranch) instead.
 *
 * Exit contract (Task 2 CLI mapping):
 * - empty/invalid argv → `SddScriptError` exit 2 (usage);
 * - context/gate failure → `SddScriptError` exit 1 (usage-class declaration
 * errors from resolution keep their own exit 2);
 * - spawn-not-found (ENOENT) → resolves 127;
 * - numeric child exit → resolved unchanged (exit 7 returns 7);
 * - child killed by signal n → resolves 128+n (SIGTERM → 143, SIGINT → 130).
 *
 * SIGINT/SIGTERM are forwarded to the running child; the listeners are
 * removed once the child settles — the launcher leaves no handlers behind.
 *
 * A3 limits apply unchanged: the launcher binds the child's STARTING cwd;
 * it is not a sandbox — a child can later chdir, pass an overriding cwd
 * flag, write absolute paths elsewhere, or use host edit tooling. Other
 * spawn errors (e.g. EACCES) reject; the CLI maps them to exit 1 with the
 * cause in the message.
 */
export async function runInSddContext(context: SddExecutionContext, argv: readonly string[]): Promise<number> {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string" || argv[0].trim() === "") {
    throwUsage(
      "runInSddContext: argv must be [executable, ...args] with a non-empty executable \u2014 the array is passed to the child literally (no shell)",
    );
  }
  const resolved = resolveSddExecutionContext(context);
  const gate = checkSddAction(resolved, { kind: "launch", cwd: process.cwd() });
  if (!gate.ok) throwGateFail(gate.violations);

  return await new Promise<number>((settle, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: resolved.featureCwd,
        shell: false, // never a shell — the argv literal arrives unchanged
        stdio: "inherit",
      });
    } catch (err) {
 // Synchronous spawn failure (rare); ENOENT keeps the 127 contract.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        settle(127);
        return;
      }
      throw err;
    }

    let done = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    const forward = (signal: NodeJS.Signals): void => {
 // Never signal a child that already settled.
      if (!done && child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const cleanup = (): void => {
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err;
      if (err.code !== "ENOENT" && !done) {
 // Non-ENOENT errors have no conventional exit code — reject ('close'
 // is not guaranteed for every error class; settle here once).
        done = true;
        cleanup();
        reject(err);
      }
    });
    child.on("close", (code, signal) => {
      if (done) return;
      done = true;
      cleanup();
      if (spawnError !== null) {
        if (spawnError.code === "ENOENT") settle(127);
        else reject(spawnError);
        return;
      }
      if (signal !== null) settle(128 + signalExitNumber(signal));
      else settle(code ?? 0);
    });
  });
}
