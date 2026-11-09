/**
 * Shared, bounded Git probes used by the path resolver, the worktree checks and
 * the host write gates. One implementation per question:
 *
 * - `mainWorktreeRoot` — first record of `git worktree list --porcelain -z`
 *   (the main worktree in every checkout: linked worktree, submodule, plain
 *   repo). Parsed with `-z`, so a C-quoted path never becomes a bogus root.
 * - `checkoutRoot` — `git rev-parse --show-toplevel` (the caller's own
 *   checkout; a linked worktree answers itself).
 * - `gitIgnored` — `git check-ignore` verdict with an explicit "Git could not
 *   answer" state.
 *
 * Every probe is bounded by `gitProbeTimeoutMs()`. This module imports only
 * Node built-ins: `worktree.ts` re-exports its probes from here, and
 * `path.ts` imports them, so the old `path -> worktree -> workflow -> path`
 * cycle never forms.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Timeout for every Git probe (shared knob: `MSTAR_GIT_PROBE_TIMEOUT_MS`). */
export function gitProbeTimeoutMs(): number {
  const raw = process.env.MSTAR_GIT_PROBE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROBE_TIMEOUT_MS;
}

/** Exit status of a failed child process, when the platform reports one. */
export function exitStatusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = error.status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/** Real path when it exists, lexical resolution otherwise. */
function realpathOrResolve(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

/**
 * Canonical path for a target that may not exist yet: realpath of the nearest
 * existing ancestor plus the remaining segments. `/var` vs `/private/var` (and
 * any other symlinked mount) must not make two spellings of one location look
 * like different repositories.
 */
export function realpathNearest(target: string): string {
  let dir = resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(dir), ...rest.reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return resolve(target);
      rest.push(basename(dir));
      dir = parent;
    }
  }
}

/**
 * The main worktree root of the checkout containing `startDir`, or `null` when
 * Git cannot answer. Same `-z` parse as `readMainWorktree`, minus the branch
 * requirement (a detached or branch-less main record still names the root).
 */
export function mainWorktreeRoot(startDir: string): string | null {
  try {
    const out = execFileSync("git", ["-C", startDir, "worktree", "list", "--porcelain", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: gitProbeTimeoutMs(),
    });
    const first = out.split("\0").find((entry) => entry.startsWith("worktree "));
    if (first === undefined) return null;
    return realpathOrResolve(first.slice("worktree ".length));
  } catch {
    return null;
  }
}

/** The Git checkout root containing `startDir` (a linked worktree answers itself). */
export function checkoutRoot(startDir: string): string | null {
  try {
    const out = execFileSync("git", ["-C", startDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: gitProbeTimeoutMs(),
    }).trim();
    return out === "" ? null : realpathOrResolve(out);
  } catch {
    return null;
  }
}

/**
 * `check-ignore` verdict: `true` (ignored), `false` (not ignored), or `null`
 * when Git cannot answer. Callers treat `null` as "keep the main checkout" —
 * a failed probe must never silently choose the caller's checkout.
 */
export function gitIgnored(root: string, target: string): boolean | null {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", target], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: gitProbeTimeoutMs(),
    });
    return true;
  } catch (error) {
    return exitStatusOf(error) === 1 ? false : null;
  }
}
