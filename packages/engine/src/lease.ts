/**
 * Engine lease module — `execution_lease` / `integration_merge_lease` state
 * machines + same-host status write lock.
 *
 * Spec sources (each export cites the skill/reference section it enforces):
 * - Lease objects + required fields: `mstar-artifacts`
 *   `references/status-and-residuals.md` § `plans[].execution_lease` +
 *   § Snapshot top-level `integration_merge_lease` (v3 — relocated from the
 *   v1 root `metadata.integration_merge_lease` in the workflow-engine-core
 *   hard cutover), and the iteration-worktree-plan-lease maintenance ADR
 *   (normative field names — `holder`, `claimed_at` RFC 3339 UTC with
 *   explicit `Z`, `worktree_path`, `working_branch`; merge lease adds
 *   `plan_id`, `source_branch`, `target_branch`; `session_label`
 *   display-only).
 * - `null` / tombstone lease objects are invalid; writers delete the key on
 *   release, never write `null`: § "Hold, release, and override" + § Agent
 *   prohibitions.
 * - Claim-before-`InProgress` (Todo/Blocked → InProgress + full lease),
 *   same-holder resume with verify-held-lease (worktree_path +
 *   working_branch match the Assignment), different-holder → Blocked ("no
 *   timestamp makes it stealable"), InProgress-without-lease orphan (STOP,
 *   never invent a lease): § Claim-before-`InProgress` + § Orphan recovery;
 *   `mstar-iteration/references/phase-2-worktree-lease.md` § Execution lease.
 * - Steal override requires explicit current-turn user instruction + audit
 *   `plans[].notes`: § "Hold, release, and override" + § Agent prohibitions.
 * - Same-host exclusive write lock: § "Same-host exclusive write lock
 *   (control status.json)" — `flock` on `{HARNESS_DIR}/.status-write.lock`
 *   preferred, atomic `mkdir` on `{HARNESS_DIR}/.status-write.lockdir/`
 *   alternative (success acquires; existing dir → another writer holds the
 *   lock; remove only after success/rollback). Bun 1.2 has no `node:fs`
 *   flock (`flockSync` undefined), so this module implements the documented
 *   mkdir alternative.
 */
import { mkdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import type { GateResult, Severity, ValidationResult } from "./core.js";


/**
 * Snapshot top-level `integration_merge_lease` (v3 — relocated from the v1
 * root `metadata.integration_merge_lease`) — see spec header. Absent =
 * unclaimed; writers delete the key on release (never `null`/tombstone).
 */
export type IntegrationMergeLease = {
  holder: string;
  claimed_at: string;
  plan_id: string;
  source_branch: string;
  target_branch: string;
  session_label?: string;
  [key: string]: unknown;
};


function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

function validateNonEmptyString(
  violations: ValidationResult[],
  value: unknown,
  field: string,
  missingCode: string,
  invalidCode: string,
): void {
  if (value === undefined) {
    violations.push(violation("high", missingCode, `missing required field: ${field}`));
  } else if (typeof value !== "string" || value.trim() === "") {
    violations.push(violation("medium", invalidCode, `${field} must be a non-empty string`));
  }
}

/** Normative claimed_at form: RFC 3339 UTC with explicit `Z` (ADR field table). */
const DATE_PART = String.raw`\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])`;
const RFC3339_Z_RE = new RegExp(String.raw`^${DATE_PART}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`);
/** Repo local-date convention: `YYYY-MM-DD` (used by the real control status.json lease). */
const DATE_ONLY_RE = new RegExp(String.raw`^${DATE_PART}$`);

/**
 * A `claimed_at` is valid as RFC 3339 UTC with explicit `Z` (normative) or as
 * a `YYYY-MM-DD` date (repo convention — the real control status.json
 * execution_lease uses `"claimed_at": "2026-08-08"` and `mstar lease verify`
 * must pass on it).
 */
function isValidClaimedAt(value: unknown): value is string {
  return typeof value === "string" && (RFC3339_Z_RE.test(value) || DATE_ONLY_RE.test(value));
}


/**
 * Validate one snapshot top-level `integration_merge_lease` object
 * (status-and-residuals.md § Snapshot top-level `integration_merge_lease`
 * (v3)): required `holder` / `claimed_at` / `plan_id` / `source_branch` /
 * `target_branch`; optional `session_label`. Absent = unclaimed; `null` and
 * tombstone objects are invalid (writers delete the key on release).
 * Integration merges into `spec_integration_branch` are serial — one holder
 * at a time (phase-2-worktree-lease.md § Integration merge lease).
 */
export function validateIntegrationMergeLease(lease: unknown): GateResult {
  const violations: ValidationResult[] = [];
  if (!isPlainObject(lease)) {
    return {
      ok: false,
      violations: [
        violation(
          "high",
          "lease.merge-lease.invalid",
          "integration_merge_lease must be an object \u2014 absent means unclaimed; null and tombstone objects are invalid; writers delete the key on release",
        ),
      ],
    };
  }
  validateNonEmptyString(
    violations,
    lease.holder,
    "holder",
    "lease.merge-lease.missing-holder",
    "lease.merge-lease.invalid-holder",
  );
  if (lease.claimed_at === undefined) {
    violations.push(violation("high", "lease.merge-lease.missing-claimed-at", "missing required field: claimed_at"));
  } else if (!isValidClaimedAt(lease.claimed_at)) {
    violations.push(
      violation(
        "medium",
        "lease.merge-lease.invalid-claimed-at",
        "claimed_at must be an RFC 3339 UTC timestamp with explicit Z (e.g. 2026-07-22T04:00:00Z) or a YYYY-MM-DD date",
      ),
    );
  }
  validateNonEmptyString(violations, lease.plan_id, "plan_id", "lease.merge-lease.missing-plan-id", "lease.merge-lease.invalid-plan-id");
  validateNonEmptyString(
    violations,
    lease.source_branch,
    "source_branch",
    "lease.merge-lease.missing-source-branch",
    "lease.merge-lease.invalid-source-branch",
  );
  validateNonEmptyString(
    violations,
    lease.target_branch,
    "target_branch",
    "lease.merge-lease.missing-target-branch",
    "lease.merge-lease.invalid-target-branch",
  );
  if (lease.session_label !== undefined && typeof lease.session_label !== "string") {
    violations.push(
      violation(
        "medium",
        "lease.merge-lease.invalid-session-label",
        "session_label must be a string (display only \u2014 never used for ownership comparison)",
      ),
    );
  }
  return { ok: violations.length === 0, violations };
}

/** Lock-directory name (SSOT § Same-host exclusive write lock, mkdir alternative). */
const STATUS_WRITE_LOCKDIR = ".status-write.lockdir";
/** Holder pid-file name inside the lockdir (crash diagnosis; F-3). */
const LOCKDIR_HOLDER_PID = "holder.pid";

/**
 * Async-local set of lockdirs held by THIS process+async-context. Used for
 * reentrancy detection: a nested `withStatusWriteLock` call on the same
 * lockdir (same async chain) throws immediately instead of waiting out the
 * 30s poll timeout. Independent concurrent writers (separate call chains)
 * have no shared store and serialize via mkdir as designed.
 */
const heldLockDirs = new AsyncLocalStorage<Set<string>>();

/**
 * Same-host exclusive write lock around coordination writes — the root
 * `status.json` AND `workflows/<id>/snapshot.json` (status-and-residuals.md
 * § "Same-host exclusive write lock (control status.json)";
 * phase-2-worktree-lease.md § "Same-host exclusive write lock"). Lease
 * mutations and plan-status transitions that touch leases MUST run inside
 * this lock for the full read-check-replace-verify sequence.
 *
 * Acquires by atomic `mkdir` on `<status dir>/.status-write.lockdir/`
 * (success acquires; existing dir → another writer holds the lock). While
 * another writer holds it, wait up to `timeoutMs` (default 30s) and then
 * throw (Blocked) — the lockdir is never removed for another holder.
 *
 * Ownership guard (double-unlock safety): the lockdir's `(dev, ino)` is
 * captured at acquisition; `finally` re-stats the path and removes the
 * directory ONLY when the identity is unchanged. When `fn` itself removed
 * the lockdir (e.g. explicit rollback), or another writer replaced it with
 * a fresh lockdir before this writer's `finally` ran, the removal is
 * skipped — a second writer's lock is never destroyed.
 *
 * Reentrancy: a nested acquisition on the same lockdir within the same
 * async context (i.e. `fn` calling `withStatusWriteLock` on the same
 * status.json) throws immediately instead of waiting out the timeout.
 *
 * Crash diagnosis: a `holder.pid` file (acquiring process id) is written
 * inside the lockdir on acquisition and removed on release. A hard crash
 * between `mkdirSync` and release leaks the lockdir; the timeout error
 * message names the recovery step (remove the lockdir when no writer is
 * alive).
 *
 * simplify: mkdir lockdir is the SSOT-documented alternative to `flock`
 * (`{HARNESS_DIR}/.status-write.lock`) — Bun 1.2 exposes no `node:fs`
 * flock/flockSync, so the advisory-file variant is unavailable here. Unlike
 * flock, a hard process crash leaks the lockdir; swap to flock when the
 * runtime provides it.
 */
export async function withStatusWriteLock<T>(
  statusPath: string,
  fn: () => T | Promise<T>,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  const lockDir = join(dirname(resolve(statusPath)), STATUS_WRITE_LOCKDIR);
  const held = heldLockDirs.getStore();
  if (held !== undefined && held.has(lockDir)) {
    throw new Error(
      `${lockDir} is already held by this process in this async context \u2014 withStatusWriteLock is not reentrant; a nested acquisition on the same status.json is a bug`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let acquired: { dev: number; ino: number } | null = null;
  for (;;) {
    try {
      mkdirSync(lockDir);
      const st = statSync(lockDir);
      acquired = { dev: st.dev, ino: st.ino };
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `${lockDir} already exists \u2014 another writer holds the status write lock; Blocked (same-host exclusive lock; status-and-residuals.md \u00a7 Same-host exclusive write lock). ` +
            `Recovery: remove ${lockDir} if no writer is alive (holder.pid inside names the acquiring process)`,
        );
      }
      await sleep(pollMs);
    }
  }
  try {
    writeFileSync(join(lockDir, LOCKDIR_HOLDER_PID), String(process.pid), "utf8");
  } catch {
    // pid file is best-effort diagnosis only — a failed write must not abort the lock
  }
  const owns = held ?? new Set<string>();
  owns.add(lockDir);
  try {
    return await heldLockDirs.run(owns, fn);
  } finally {
    owns.delete(lockDir);
    try {
      const current = statSync(lockDir);
      // Remove only our own lockdir: absent (fn rolled back) or a different
      // (dev, ino) (another writer acquired after fn removed ours) ⇒ skip.
      if (acquired !== null && current.dev === acquired.dev && current.ino === acquired.ino) {
        try {
          unlinkSync(join(lockDir, LOCKDIR_HOLDER_PID));
        } catch {
          // pid file already removed by fn — proceed to remove the directory
        }
        rmdirSync(lockDir);
      }
    } catch {
      // lockdir already removed (e.g. explicit rollback) — nothing to clean
    }
  }
}
