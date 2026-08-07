/**
 * CLI `mstar lease verify` decision logic — pure (no argv, no fs) so the
 * four-case execution_lease location matrix is unit/integration testable.
 *
 * SSOT location rules (status-and-residuals.md § `plans[].execution_lease`;
 * ADR 2026-07-22-iteration-worktree-plan-lease.md A3 — `plans[].execution_lease`
 * in status.json is the claim/hold/release SSOT):
 * - Row-level `plans[].execution_lease` only, valid → OK.
 * - Metadata-only (`plans[].metadata.execution_lease`) → high-severity
 *   `lease.verify.non-ssot-location`: the metadata location is a
 *   legacy/hand-written read-compat fallback, NOT equivalent to SSOT
 *   success. No documented compat mode exists (the real control
 *   `.harness/status.json` stores the lease at the row level), so this is
 *   always a FAIL (non-zero exit) with the lease shape still validated and
 *   reported.
 * - Both locations present → `lease.verify.dual-write`: the row-level lease
 *   wins and is validated; the metadata copy must be deleted.
 * - Neither present → existing missing / InProgress-orphan logic.
 */
import type { ValidationResult } from "@mstar-harness/engine";
import { validateExecutionLease } from "@mstar-harness/engine";

function violation(severity: ValidationResult["severity"], code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
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
            "plan is InProgress without an execution_lease — orphan: STOP, no writable dispatch until recovery (status-and-residuals.md § Orphan recovery)",
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
        "execution_lease present in BOTH plans[].execution_lease (SSOT) and plans[].metadata.execution_lease — the row-level lease wins; delete the metadata copy to remove the dual write",
      ),
    );
  } else if (rowLease === undefined) {
    violations.push(
      violation(
        "high",
        "lease.verify.non-ssot-location",
        "execution_lease found only under plans[].metadata.execution_lease — the SSOT location is plans[].execution_lease; the metadata location is a legacy/hand-written read-compat fallback, not equivalent to SSOT success (migrate the lease to the plan row)",
      ),
    );
  }
  violations.push(...validateExecutionLease(lease).violations);
  return { ok: violations.length === 0, violations, lease };
}
