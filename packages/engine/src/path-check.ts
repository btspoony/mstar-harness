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
 *   integration worktree that carries the target branch.
 *
 * Names never decide; actual Git state does: an ignored path is wrong anywhere
 * but the control checkout, and a committable path is wrong anywhere but the
 * caller's checkout. The caller's tracked-result marking only adds a
 * non-blocking warning when such a location is ignored — the content can never
 * be shared, but nothing is misplaced.
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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Severity } from "./core.js";
import { gitProbeTimeoutMs, probeCheckoutRoot, readMainWorktree } from "./worktree.js";

/** Refusal/severity vocabulary of the ownership check. */
export type PathOwnershipCode =
  | "path.process-outside-control"
  | "path.result-ignored"
  | "path.result-outside-worktree"
  | "path.unverifiable";

/** One path to check; `result` marks a tracked-result location. */
export type PathOwnershipTarget = {
  /** Absolute or caller-relative path; the probe resolves it. */
  path: string;
  /**
   * The caller treats this path as a tracked-result dir (specs / knowledge /
   * adr). It only ever adds the non-blocking `path.result-ignored` warning —
   * names never decide the verdict, Git state does.
   */
  result?: boolean;
};

/** Facts shared by every probe verdict. */
type PathOwnershipFacts = {
  path: string;
  /** The caller's tracked-result marking, echoed for the warning. */
  result: boolean;
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

/**
 * A non-blocking signal: the path is a tracked-result dir AND Git ignores it.
 * The verdict above stays clean (an ignored result dir in the control checkout
 * is legal), but the caller is told the content can never be shared.
 */
export type PathOwnershipWarning = PathOwnershipFacts & {
  code: "path.result-ignored";
  severity: Severity;
  message: string;
  fix: string;
};

/** Layout-check result: `ok` ignores warnings; only findings fail the check. */
export type PathOwnershipCheck = {
  ok: boolean;
  findings: PathOwnershipFinding[];
  warnings: PathOwnershipWarning[];
};

/** Probe file name; a plain name so no dotfile pattern decides the verdict. */
const PROBE_FILE = "mstar-path-check-probe.md";

/**
 * Whether `target` is one of the caller's tracked-result locations. This is the
 * ONLY use of the result marking: Git decides the verdict, the marking decides
 * whether an ignored-but-legal path also earns the sharing warning.
 */
export function isResultPath(target: string, resultDirs: readonly string[]): boolean {
  const path = resolve(target);
  return resultDirs.some((dir) => isAtOrBelow(path, dir));
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
 * The verdict comes from Git state only:
 * - an unreadable ignore verdict is `path.unverifiable`;
 * - an IGNORED path outside the control checkout is `path.process-outside-control`;
 * - a COMMITTABLE path outside the caller's checkout is
 *   `path.result-outside-worktree`.
 * Directory names never decide. `controlRoot` is the process root (the main
 * worktree); `callerCheckoutRoot` is the checkout the caller works in. An
 * omitted `callerCheckoutRoot` leaves the committable half unasserted rather
 * than guessing one.
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
  const facts: PathOwnershipFacts = {
    path: target.path,
    result: target.result === true,
    ignored,
    checkoutRoot,
    controlRoot: processRoot,
  };
  if (ignored === null) {
    return {
      ...facts,
      code: "path.unverifiable",
      severity: "medium",
      message: `cannot read the Git ignore verdict for ${target.path}`,
      fix: `Confirm the path sits inside a readable Git checkout: run \`git -C ${anchor} check-ignore -v -- ${probePath}\`. Run mstar path check.`,
    };
  }
  if (ignored && checkoutRoot !== processRoot) {
    return {
      ...facts,
      code: "path.process-outside-control",
      severity: "high",
      message: `${target.path} is Git-ignored in the checkout ${checkoutRoot ?? "unknown"}, but ignored harness files belong to the control checkout ${processRoot ?? "unreadable"}`,
      fix: `Keep ignored harness files in the control checkout: run mstar path check from ${processRoot ?? "the main worktree"}, or declare harness_dir in .mstarc.`,
    };
  }
  if (!ignored && callerCheckoutRoot !== null && checkoutRoot !== null && checkoutRoot !== callerCheckoutRoot) {
    return {
      ...facts,
      code: "path.result-outside-worktree",
      severity: "high",
      message: `${target.path} is committable in the checkout ${checkoutRoot}, but the caller works in ${callerCheckoutRoot}`,
      fix: `Write tracked results in the checkout that carries the target branch (the work/integration worktree), not the control checkout. Run mstar path check.`,
    };
  }
  return { ...facts, code: null, severity: null, message: null, fix: null };
}

/**
 * The non-blocking signal for one probed path: a tracked-result location that
 * Git ignores. Clean paths only — a path that already failed does not need a
 * second line saying its content cannot be shared.
 */
export function pathOwnershipWarning(probe: PathOwnershipProbe): PathOwnershipWarning | null {
  if (probe.code !== null || !probe.result || probe.ignored !== true) return null;
  return {
    ...probe,
    code: "path.result-ignored",
    severity: "medium",
    message: `${probe.path} is a tracked-result location that Git ignores: content written there can never be committed or shared`,
    fix: `Write results under .agents/<sub> (or another committable directory) or declare the dir with specs_dir / knowledge_dir / adr_dir in .mstarc. Run mstar path check.`,
  };
}

/** Probe every target; findings fail the check, warnings never do. */
export function checkPathOwnership(
  targets: readonly PathOwnershipTarget[],
  controlRoot: string | null,
  callerCheckoutRoot: string | null = null,
): PathOwnershipCheck {
  const probes = targets.map((target) => probePathOwnership(target, controlRoot, callerCheckoutRoot));
  const findings = probes.filter((probe): probe is PathOwnershipFinding => probe.code !== null);
  const warnings = probes
    .filter((probe) => probe.result)
    .map((probe) => pathOwnershipWarning(probe))
    .filter((warning): warning is PathOwnershipWarning => warning !== null);
  return { ok: findings.length === 0, findings, warnings };
}
