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

/**
 * Child environment for every probe: the inherited environment with the
 * locale pinned. Fatal-128 classes are indistinguishable by exit code, so the
 * classification reads stderr and that text must not depend on the user locale.
 */
function probeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", LANG: "C" };
}

/** stderr text of a failed child process, when the platform captured one. */
function stderrOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = error.stderr;
    if (typeof stderr === "string") return stderr;
    if (stderr instanceof Uint8Array) return Buffer.from(stderr).toString("utf8");
  }
  return "";
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
 * Parse the first record of `git worktree list --porcelain -z`. The first
 * record is always the MAIN worktree; `refs/heads/` is stripped; `detached`
 * yields `branch: ""`; a record with neither a branch nor `detached` yields
 * `branch: null` (callers that require a branch treat it as malformed).
 */
export function parseWorktreeList(out: string): { root: string; branch: string | null } | null {
  const tokens = out.split("\0");
  const first = tokens.findIndex((t) => t.startsWith("worktree "));
  if (first === -1) return null;
  const rawPath = tokens[first]!.slice("worktree ".length);
  if (rawPath.trim() === "") return null;
  let branch: string | null = null;
  let detached = false;
  for (let i = first + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("worktree ")) break; // second record begins
    if (token === "bare") return null;
    if (token === "detached") detached = true;
    else if (token.startsWith("branch ")) {
      const ref = token.slice("branch ".length).trim();
      branch = ref === "" ? null : ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  if (detached) branch = "";
  return { root: realpathOrResolve(rawPath), branch };
}

/** One `git worktree list --porcelain -z` run, parsed. */
export function worktreeList(startDir: string, opts: GitProbeOptions = {}): { root: string; branch: string | null } | null {
  try {
    const out = execFileSync(opts.gitPath ?? "git", ["-C", startDir, "worktree", "list", "--porcelain", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? gitProbeTimeoutMs(),
      env: probeEnv(),
    });
    return parseWorktreeList(out);
  } catch {
    return null;
  }
}

/**
 * The main worktree root of the checkout containing `startDir`, or `null` when
 * Git cannot answer. A detached or branch-less main record still names the root.
 */
export function mainWorktreeRoot(startDir: string, opts: GitProbeOptions = {}): string | null {
  return worktreeList(startDir, opts)?.root ?? null;
}

export type GitProbeOptions = {
  /** git executable to invoke (default `git`). */
  gitPath?: string;
  /** Override the shared probe timeout. */
  timeoutMs?: number;
};

/** The Git checkout root containing `startDir` (a linked worktree answers itself). */
export function checkoutRoot(startDir: string, opts: GitProbeOptions = {}): string | null {
  return checkoutRootOrFailure(startDir, opts).root;
}

/**
 * Checkout probe with the failure state kept: `root` is the checkout root,
 * `failed` is true when Git could not answer at all (missing executable,
 * timeout, unexpected exit). "Not a Git repository" (exit 128) is not a
 * failure — it is the documented non-git start, where local discovery is
 * correct.
 */
export function checkoutRootOrFailure(
  startDir: string,
  opts: GitProbeOptions = {},
): { root: string | null; failed: boolean } {
  try {
    const out = execFileSync(opts.gitPath ?? "git", ["-C", startDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? gitProbeTimeoutMs(),
      env: probeEnv(),
    }).trim();
    if (out === "") return { root: null, failed: false };
    // Git answered, but an unresolvable toplevel is not a usable checkout:
    // report no root (the pre-change `probeCheckoutRoot` null) rather than a
    // probe failure.
    try {
      return { root: realpathSync(out), failed: false };
    } catch {
      return { root: null, failed: false };
    }
  } catch (error) {
    // Only Git's own "not a repository" refusal (exit 128 with that message)
    // is the documented non-git start. Every other failure — a missing
    // executable, a timeout, or a different fatal 128 — is "could not answer"
    // and fails closed.
    const notARepository = exitStatusOf(error) === 128 && /not a git repository/i.test(stderrOf(error));
    return { root: null, failed: !notARepository };
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
      env: probeEnv(),
    });
    return true;
  } catch (error) {
    return exitStatusOf(error) === 1 ? false : null;
  }
}
