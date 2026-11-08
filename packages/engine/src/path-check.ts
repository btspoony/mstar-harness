/**
 * Engine path-ownership module — decides whether a harness path is owned by the
 * Git checkout that is supposed to own it.
 *
 * Two ownership domains exist (plan-conventions § Git 跟踪策略), and they have
 * DIFFERENT owners:
 *
 * - **process** (plans, sdd, iterations, workflows, projects, reviews, the
 *   store) is local to the process: it may be Git-ignored, but it must live in
 *   the CONTROL checkout. An ignored process dir in a linked checkout is state
 *   nobody can find from the control root.
 * - **tracked** (specs, knowledge, adr) is shared through the branch: it must
 *   NOT be ignored, and it belongs to the CALLER's checkout — the work /
 *   integration worktree that carries the target branch. A result written into
 *   the control checkout while the caller works in a linked checkout never
 *   reaches the caller's branch, so it is refused just like an ignored one.
 *
 * Both facts come from bounded Git probes, never from a layout guess:
 * `rev-parse --show-toplevel` from the target's nearest existing directory names
 * the checkout, then `check-ignore -q` runs IN that checkout with the absolute
 * target. `check-ignore` refuses a path belonging to another worktree (exit 128
 * "outside repository"), so `-C` must be the resolved checkout root. The target
 * is probed as a file path: a not-yet-existing directory has no trailing-slash
 * identity for pattern matching, and a file path answers the ignore verdict of
 * the directory's contents.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Severity } from "./core.js";
import { gitProbeTimeoutMs, probeCheckoutRoot, readMainWorktree } from "./worktree.js";

/** What a path is expected to be: local process state, or a shared result. */
export type PathOwnershipExpect = "process" | "tracked";

/** Refusal/severity vocabulary of the ownership check. */
export type PathOwnershipCode =
  | "path.process-outside-control"
  | "path.result-ignored"
  | "path.result-outside-worktree"
  | "path.unverifiable";

/** One path plus the ownership class it is held to. */
export type PathOwnershipTarget = {
  /** Absolute or caller-relative path; the probe resolves it. */
  path: string;
  expect: PathOwnershipExpect;
};

/** Facts shared by every probe verdict. */
type PathOwnershipFacts = {
  path: string;
  expect: PathOwnershipExpect;
  /** `true` ignored, `false` tracked, `null` when Git could not answer. */
  ignored: boolean | null;
  /** Git top-level of the target's checkout, or `null` when unknown. */
  checkoutRoot: string | null;
  /** Main worktree of the repository, or `null` outside Git. */
  controlRoot: string | null;
};

/** A path owned as expected: no code, no severity, nothing to fix. */
type PathOwnershipClean = PathOwnershipFacts & {
  code: null;
  severity: null;
  message: null;
  fix: null;
};

/** A probe that found a violation. */
export type PathOwnershipFinding = PathOwnershipFacts & {
  code: PathOwnershipCode;
  severity: Severity;
  message: string;
  fix: string;
};

/** Facts and verdict of one probed path — `code === null` means it is clean. */
export type PathOwnershipProbe = PathOwnershipClean | PathOwnershipFinding;

/** Layout-check result: `ok` when no target produced a finding. */
export type PathOwnershipCheck = {
  ok: boolean;
  findings: PathOwnershipFinding[];
};

/** Probe file name; a plain name so no dotfile pattern decides the verdict. */
const PROBE_FILE = "mstar-path-check-probe.md";

/** Tracked-result directory names — content written there is meant to be shared. */
const TRACKED_RESULT_NAMES: Record<string, true> = { specs: true, knowledge: true, adr: true };

/**
 * The ownership class a caller-named path is held to. A path at or inside one
 * of the resolved tracked-result dirs is a result, and so is a path that IS (or
 * sits under) a directory carrying a result name: naming `.mstar/specs` in a
 * linked checkout means "my results live here", and that content can never be
 * committed — reporting the ignored result is the answer the operator needs,
 * not a placement complaint. Everything else is process state.
 */
export function expectForPath(target: string, trackedDirs: readonly string[]): PathOwnershipExpect {
  const path = resolve(target);
  if (trackedDirs.some((dir) => isAtOrBelow(path, dir))) return "tracked";
  return path.split(sep).some((part) => TRACKED_RESULT_NAMES[part] === true) ? "tracked" : "process";
}

/** True when `dir` is `root` itself or a descendant of `root` (lexical). */
function isAtOrBelow(dir: string, root: string): boolean {
  const rel = relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isDirectoryEntry(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Nearest existing directory at or above `target` — `git -C` needs a real dir. */
export function nearestExistingDir(target: string): string {
  let dir = resolve(target);
  for (;;) {
    if (isDirectoryEntry(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

/** The path whose ignore verdict stands for `target`: its own file, or a file in it. */
function probePathFor(target: string): string {
  const path = resolve(target);
  try {
    if (statSync(path).isFile()) return path;
  } catch {
    // Absent targets are probed as a file inside them (see the module note).
  }
  return join(path, PROBE_FILE);
}

/** Exit status of a failed `execFileSync` call, or `null` when it never ran. */
function exitStatus(error: unknown): number | null {
  if (error !== null && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return null;
}

/** `check-ignore` verdict inside `checkoutRoot`: `null` when Git cannot answer. */
function ignoreVerdict(checkoutRoot: string | null, probePath: string): boolean | null {
  if (checkoutRoot === null) return null;
  try {
    execFileSync("git", ["-C", checkoutRoot, "check-ignore", "-q", "--", probePath], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: gitProbeTimeoutMs(),
    });
    return true;
  } catch (error) {
    // Exit 1 is Git's "not ignored"; 128 (outside the repository) or a failed
    // spawn leaves the verdict unread — never a silent "ok".
    return exitStatus(error) === 1 ? false : null;
  }
}

/**
 * Probe one path and return its ownership verdict. `code === null` means the
 * path is owned as expected.
 *
 * `controlRoot` is the process root (the main worktree) and owns process state;
 * `callerCheckoutRoot` is the checkout the caller works in and owns tracked
 * results. An omitted `callerCheckoutRoot` leaves the tracked-ownership half
 * unasserted rather than guessing one.
 */
export function probePathOwnership(
  target: PathOwnershipTarget,
  controlRoot: string | null,
  callerCheckoutRoot: string | null = null,
): PathOwnershipProbe {
  const anchor = nearestExistingDir(target.path);
  const checkoutRoot = probeCheckoutRoot(anchor);
  const probePath = probePathFor(target.path);
  const ignored = ignoreVerdict(checkoutRoot, probePath);
  // A caller naming a not-yet-existing target cannot probe the process root
  // itself; the first `worktree list` record of the target's OWN checkout is
  // that same main checkout, so the verdict never depends on the caller.
  const processRoot = controlRoot ?? (checkoutRoot === null ? null : readMainWorktree(checkoutRoot)?.root ?? null);
  const facts: PathOwnershipFacts = { path: target.path, expect: target.expect, ignored, checkoutRoot, controlRoot: processRoot };
  if (ignored === null) {
    return {
      ...facts,
      code: "path.unverifiable",
      severity: "medium",
      message: `cannot read the Git ignore verdict for ${target.path}`,
      fix: `Confirm the path sits inside a readable Git checkout: run \`git -C ${anchor} check-ignore -v -- ${probePath}\`. Run mstar path check.`,
    };
  }
  if (target.expect === "tracked") {
    if (ignored) {
      return {
        ...facts,
        code: "path.result-ignored",
        severity: "high",
        message: `${target.path} is Git-ignored, so the tracked results written there can never be committed or shared`,
        fix: `Re-include ${target.path} in .gitignore, or declare a tracked directory (e.g. .agents/specs) with specs_dir / knowledge_dir / adr_dir in .mstarc. Run mstar path check.`,
      };
    }
    if (callerCheckoutRoot !== null && checkoutRoot !== null && checkoutRoot !== callerCheckoutRoot) {
      return {
        ...facts,
        code: "path.result-outside-worktree",
        severity: "high",
        message: `${target.path} is a tracked result in the checkout ${checkoutRoot}, but the caller works in ${callerCheckoutRoot}`,
        fix: `Write tracked results in the checkout that carries the target branch (the work/integration worktree), not the control checkout. Run mstar path check.`,
      };
    }
    return { ...facts, code: null, severity: null, message: null, fix: null };
  }
  if (ignored && checkoutRoot !== processRoot) {
    return {
      ...facts,
      code: "path.process-outside-control",
      severity: "high",
      message: `${target.path} is process state in a checkout that is not the control root (${processRoot ?? "unreadable"})`,
      fix: `Keep process artifacts in the control checkout: run mstar path check from ${processRoot ?? "the main worktree"}, or declare harness_dir in .mstarc.`,
    };
  }
  return { ...facts, code: null, severity: null, message: null, fix: null };
}

/** Probe every target and collect the violations. */
export function checkPathOwnership(
  targets: readonly PathOwnershipTarget[],
  controlRoot: string | null,
  callerCheckoutRoot: string | null = null,
): PathOwnershipCheck {
  const findings = targets
    .map((target) => probePathOwnership(target, controlRoot, callerCheckoutRoot))
    .filter((probe): probe is PathOwnershipFinding => probe.code !== null);
  return { ok: findings.length === 0, findings };
}
