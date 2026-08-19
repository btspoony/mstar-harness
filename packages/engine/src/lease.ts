/**
 * Engine lease module — `execution_lease` / `integration_merge_lease` state
 * machines + same-host status write lock.
 *
 * Spec sources (each export cites the skill/reference section it enforces):
 * - Lease objects + required fields: `mstar-plan-artifacts`
 *   `references/status-and-residuals.md` § `plans[].execution_lease` +
 *   § Root `metadata.integration_merge_lease` (v1), and the
 *   iteration-worktree-plan-lease maintenance ADR (normative
 *   field names — `holder`, `claimed_at` RFC 3339 UTC with explicit `Z`,
 *   `worktree_path`, `working_branch`; merge lease adds `plan_id`,
 *   `source_branch`, `target_branch`; `session_label` display-only).
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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import type { GateResult, Severity, ValidationResult } from "./core.js";
import type { PlanRow } from "./status.js";

/**
 * `plans[].execution_lease` (v1) — see spec header. Extra fields (e.g. the
 * real control data's `base_sha`) are allowed and preserved.
 */
export type ExecutionLease = {
  holder: string;
  claimed_at: string;
  worktree_path: string;
  working_branch: string;
  session_label?: string;
  [key: string]: unknown;
};

/**
 * Root `metadata.integration_merge_lease` (v1) — see spec header. Absent =
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

/** Assignment-side fields written into an `execution_lease` at claim time. */
export type ClaimLeaseFields = {
  worktree_path: string;
  working_branch: string;
  session_label?: string;
};

/**
 * Result of a pure lease transition on one plan row. `row` is the resulting
 * row (unchanged when `ok` is false); `outcome` distinguishes a fresh claim
 * from a same-holder resume / a release.
 */
export type LeaseTransition = {
  ok: boolean;
  row: PlanRow;
  outcome?: "claimed" | "resumed" | "released";
  violations: ValidationResult[];
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
 * execution_lease for 20260808-slice1-engine-foundation uses
 * `"claimed_at": "2026-08-08"` and `mstar lease verify` must pass on it).
 */
function isValidClaimedAt(value: unknown): value is string {
  return typeof value === "string" && (RFC3339_Z_RE.test(value) || DATE_ONLY_RE.test(value));
}

/**
 * Validate one `plans[].execution_lease` object (status-and-residuals.md
 * § `plans[].execution_lease`): required `holder` / `claimed_at` /
 * `worktree_path` (absolute) / `working_branch`; optional `session_label`
 * display-only. `null` and tombstone objects are invalid — writers delete
 * the key on release, never write `null` (§ Agent prohibitions). Extra
 * fields are allowed (the real control lease carries `base_sha`).
 */
export function validateExecutionLease(lease: unknown): GateResult {
  const violations: ValidationResult[] = [];
  if (!isPlainObject(lease)) {
    return {
      ok: false,
      violations: [
        violation(
          "high",
          "lease.execution-lease.invalid",
          "execution_lease must be an object \u2014 null and tombstone objects are invalid; writers delete the key on release",
        ),
      ],
    };
  }
  validateNonEmptyString(
    violations,
    lease.holder,
    "holder",
    "lease.execution-lease.missing-holder",
    "lease.execution-lease.invalid-holder",
  );
  if (lease.claimed_at === undefined) {
    violations.push(violation("high", "lease.execution-lease.missing-claimed-at", "missing required field: claimed_at"));
  } else if (!isValidClaimedAt(lease.claimed_at)) {
    violations.push(
      violation(
        "medium",
        "lease.execution-lease.invalid-claimed-at",
        "claimed_at must be an RFC 3339 UTC timestamp with explicit Z (e.g. 2026-07-22T02:30:00Z) or a YYYY-MM-DD date",
      ),
    );
  }
  if (lease.worktree_path === undefined) {
    violations.push(
      violation("high", "lease.execution-lease.missing-worktree-path", "missing required field: worktree_path"),
    );
  } else if (typeof lease.worktree_path !== "string" || lease.worktree_path.trim() === "") {
    violations.push(
      violation("medium", "lease.execution-lease.invalid-worktree-path", "worktree_path must be a non-empty string"),
    );
  } else if (!isAbsolute(lease.worktree_path)) {
    violations.push(
      violation(
        "medium",
        "lease.execution-lease.invalid-worktree-path",
        "worktree_path must be an absolute path \u2014 it identifies the dedicated feature-worktree root (and MUST differ from metadata.control_worktree_path)",
      ),
    );
  }
  validateNonEmptyString(
    violations,
    lease.working_branch,
    "working_branch",
    "lease.execution-lease.missing-working-branch",
    "lease.execution-lease.invalid-working-branch",
  );
  if (lease.session_label !== undefined && typeof lease.session_label !== "string") {
    violations.push(
      violation(
        "medium",
        "lease.execution-lease.invalid-session-label",
        "session_label must be a string (display only \u2014 never used for ownership comparison)",
      ),
    );
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Validate one root `metadata.integration_merge_lease` object
 * (status-and-residuals.md § Root `metadata.integration_merge_lease` (v1)):
 * required `holder` / `claimed_at` / `plan_id` / `source_branch` /
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

/**
 * Claim-before-`InProgress` transition (status-and-residuals.md
 * § Claim-before-`InProgress`; phase-2-worktree-lease.md § Execution lease).
 *
 * - No lease + status `Todo`/`Blocked` → claim: status becomes `InProgress`
 *   and the full `execution_lease` is written in one update (`claimed_at`
 *   = now, RFC 3339 UTC with `Z`).
 * - Lease with the **same** `holder` → resume: the stored lease is preserved
 *   verbatim, but `worktree_path`/`working_branch` must match the Assignment
 *   (`verify-held-lease`) or the resume is refused.
 * - Lease with a **different** `holder` → refused: no timestamp makes it
 *   stealable.
 * - `InProgress` **without** a lease → orphan: refused; never invent a
 *   lease (§ Orphan recovery — recovery is PM/human-owned).
 * - `null`/tombstone stored lease → refused, not silently replaced
 *   (§ Agent prohibitions).
 * - The fields to be written are validated via `validateExecutionLease`
 *   **before** the Todo/Blocked → InProgress transition commits: a relative
 *   `worktree_path` or missing fields are rejected without mutating the row
 *   (the written lease must itself pass the validator).
 *
 * Pure: returns the resulting row; the caller performs the locked
 * read-check-replace-verify around `status.json` and persists it.
 */
export function claimLease(row: PlanRow, holder: string, fields: ClaimLeaseFields): LeaseTransition {
  const lease = row.execution_lease;
  if (lease !== undefined) {
    if (!isPlainObject(lease)) {
      return {
        ok: false,
        row,
        violations: [
          violation(
            "high",
            "lease.claim.tombstone",
            "execution_lease must be an object \u2014 null and tombstone objects are invalid; resolve the corrupt state before claiming",
          ),
        ],
      };
    }
    if (lease.holder !== holder) {
      return {
        ok: false,
        row,
        violations: [
          violation(
            "high",
            "lease.claim.other-holder",
            `execution_lease held by ${JSON.stringify(lease.holder)} \u2014 no timestamp makes it stealable; Blocked unless the current-turn user explicitly overrides (then audit plans[].notes)`,
          ),
        ],
      };
    }
    if (lease.worktree_path !== fields.worktree_path || lease.working_branch !== fields.working_branch) {
      return {
        ok: false,
        row,
        violations: [
          violation(
            "high",
            "lease.claim.verify-held-lease",
            `same holder but lease ${lease.worktree_path} @ ${lease.working_branch} does not match the Assignment ${fields.worktree_path} @ ${fields.working_branch} \u2014 verify-held-lease failed`,
          ),
        ],
      };
    }
    return { ok: true, row, outcome: "resumed", violations: [] };
  }
  if (row.status === "InProgress") {
    return {
      ok: false,
      row,
      violations: [
        violation(
          "high",
          "lease.claim.orphan",
          "plan is InProgress without an execution_lease \u2014 orphan: STOP, no writable dispatch until recovery (status-and-residuals.md \u00a7 Orphan recovery); do not invent a lease",
        ),
      ],
    };
  }
  if (row.status !== "Todo" && row.status !== "Blocked") {
    return {
      ok: false,
      row,
      violations: [
        violation(
          "high",
          "lease.claim.status",
          `claim requires status Todo or Blocked (got ${JSON.stringify(row.status)}) \u2014 claim-before-InProgress contract`,
        ),
      ],
    };
  }
  const claimed: ExecutionLease = {
    holder,
    claimed_at: new Date().toISOString(),
    worktree_path: fields.worktree_path,
    working_branch: fields.working_branch,
    ...(fields.session_label !== undefined ? { session_label: fields.session_label } : {}),
  };
  // Validate before committing the transition: reject invalid ClaimLeaseFields
  // (relative worktree_path, missing fields) without mutating the row.
  const gate = validateExecutionLease(claimed);
  if (!gate.ok) {
    return { ok: false, row, violations: gate.violations };
  }
  return { ok: true, row: { ...row, status: "InProgress", execution_lease: claimed }, outcome: "claimed", violations: [] };
}

/**
 * Release transition — deletes `execution_lease` entirely, never writes
 * `null` (status-and-residuals.md § "Hold, release, and override" + § Agent
 * prohibitions). Requires the **same-session holder**: when `holder` differs
 * from the stored lease `holder`, the release is refused and the row is left
 * unmodified — a different holder must Blocked, never released by another
 * session (no timestamp makes a lease stealable). Idempotent when no lease
 * is present. The `Done` authority deletes the lease in the same
 * complete-file update as `status: "Done"` — **only after** successful
 * integration merge into `spec_integration_branch` (§ Integration merge
 * protocol); the caller enforces that ordering around the locked update.
 */
export function releaseLease(row: PlanRow, holder: string): LeaseTransition {
  if (row.execution_lease === undefined) {
    return { ok: true, row, outcome: "released", violations: [] };
  }
  if (!isPlainObject(row.execution_lease)) {
    return {
      ok: false,
      row,
      violations: [
        violation(
          "high",
          "lease.release.tombstone",
          "execution_lease must be an object \u2014 null and tombstone objects are invalid; resolve the corrupt state before releasing",
        ),
      ],
    };
  }
  if (row.execution_lease.holder !== holder) {
    return {
      ok: false,
      row,
      violations: [
        violation(
          "high",
          "lease.release.other-holder",
          `execution_lease held by ${JSON.stringify(row.execution_lease.holder)} \u2014 release requires the same-session holder; a different holder must Blocked (no timestamp makes it stealable)`,
        ),
      ],
    };
  }
  const { execution_lease: _dropped, ...rest } = row;
  return { ok: true, row: rest, outcome: "released", violations: [] };
}

/**
 * Same-holder resume check (status-and-residuals.md § Claim-before-`InProgress`
 * #2): `true` iff the stored lease `holder` equals the session `holder`.
 * Verify-held-lease (worktree_path/working_branch vs the Assignment) is the
 * caller's check via `claimLease`.
 */
export function sameHolderResume(lease: unknown, holder: string): boolean {
  return isPlainObject(lease) && lease.holder === holder;
}

/**
 * Steal decision (status-and-residuals.md § Agent prohibitions + § "Hold,
 * release, and override"): an active lease MUST NOT be stolen — `false`
 * unless the **current-turn user explicitly authorizes** the override
 * (`opts.userOverride: true`). The caller MUST still append an audit entry
 * to `plans[].notes` (timestamp, prior holder, new holder/release, user
 * authorized). Agents MUST NOT infer override from age, inactivity, `Blocked`
 * status, or a failed session.
 */
export function canSteal(lease: unknown, holder: string, opts: { userOverride?: boolean } = {}): boolean {
  if (!isPlainObject(lease) || lease.holder === holder) return false;
  return opts.userOverride === true;
}

/** Execution lease locations found on one plan row (SSOT + legacy read-compat). */
export type ExecutionLeaseLocations = {
  /** SSOT location: `plans[].execution_lease`. */
  row: unknown;
  /** Legacy/hand-written read-compat location: `plans[].metadata.execution_lease`. */
  metadata: unknown;
};

export function planExecutionLeaseLocations(row: Record<string, unknown>): ExecutionLeaseLocations {
  const meta = row.metadata;
  const metadataLease =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>).execution_lease
      : undefined;
  return { row: row.execution_lease, metadata: metadataLease };
}

export type LeaseVerifyResult = {
  ok: boolean;
  violations: ValidationResult[];
  /** The lease chosen for validation (row-level wins) — absent when neither location has one. */
  lease?: unknown;
};

/**
 * Verify a plan's `execution_lease` across its two possible locations
 * (status-and-residuals.md § `plans[].execution_lease`; ADR
 * 2026-07-22-iteration-worktree-plan-lease.md A3 — the plan row is the
 * claim/hold/release SSOT):
 * - Row-level `plans[].execution_lease` only, valid → OK.
 * - Metadata-only (`plans[].metadata.execution_lease`) → high-severity
 *   `lease.verify.non-ssot-location`: the metadata location is a
 *   legacy/hand-written read-compat fallback, NOT equivalent to SSOT
 *   success. Always a FAIL (non-zero exit) with the lease shape still
 *   validated and reported.
 * - Both locations present → `lease.verify.dual-write`: the row-level lease
 *   wins and is validated; the metadata copy must be deleted.
 * - Neither present → `lease.verify.missing` (non-InProgress) /
 *   `lease.verify.orphan` (InProgress).
 *
 * Kept in the engine so every host hook / CLI entry / Slice-2+ consumer
 * imports ONE gate (CLI `mstar lease verify` is a thin wrapper).
 */
export function verifyPlanExecutionLease(row: Record<string, unknown>, planId: string): LeaseVerifyResult {
  const { row: rowLease, metadata: metadataLease } = planExecutionLeaseLocations(row);
  const lease = rowLease !== undefined ? rowLease : metadataLease;
  if (lease === undefined) {
    if (row.status === "InProgress") {
      return {
        ok: false,
        violations: [
          violation(
            "high",
            "lease.verify.orphan",
            "plan is InProgress without an execution_lease \u2014 orphan: STOP, no writable dispatch until recovery (status-and-residuals.md \u00a7 Orphan recovery)",
          ),
        ],
      };
    }
    return {
      ok: false,
      violations: [
        violation(
          "high",
          "lease.verify.missing",
          `plan ${planId} has no execution_lease (neither plans[].execution_lease nor legacy plans[].metadata.execution_lease)`,
        ),
      ],
    };
  }
  const violations: ValidationResult[] = [];
  if (rowLease !== undefined && metadataLease !== undefined) {
    violations.push(
      violation(
        "high",
        "lease.verify.dual-write",
        "execution_lease present in BOTH plans[].execution_lease (SSOT) and plans[].metadata.execution_lease \u2014 the row-level lease wins; delete the metadata copy to remove the dual write",
      ),
    );
  } else if (rowLease === undefined) {
    violations.push(
      violation(
        "high",
        "lease.verify.non-ssot-location",
        "execution_lease found only under plans[].metadata.execution_lease \u2014 the SSOT location is plans[].execution_lease; the metadata location is a legacy/hand-written read-compat fallback, not equivalent to SSOT success (migrate the lease to the plan row)",
      ),
    );
  }
  violations.push(...validateExecutionLease(lease).violations);
  return { ok: violations.length === 0, violations, lease };
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
 * Same-host exclusive write lock around `status.json` coordination writes
 * (status-and-residuals.md § "Same-host exclusive write lock (control
 * status.json)"; phase-2-worktree-lease.md § "Same-host exclusive write
 * lock"). Lease mutations and plan-status transitions that touch leases MUST
 * run inside this lock for the full read-check-replace-verify sequence.
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
