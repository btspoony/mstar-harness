/**
 * CLI `mstar lease verify` — thin wrapper over the engine lease-verify gate.
 *
 * The four-case `execution_lease` location matrix (row-level SSOT vs legacy
 * `plans[].metadata.execution_lease`, dual-write, InProgress-orphan, missing)
 * lives in `@mstar-harness/engine` (`lease.verifyPlanExecutionLease` /
 * `planExecutionLeaseLocations`) so every host hook / CLI entry / Slice-2+
 * consumer imports ONE policy. This file only re-exports it for the CLI
 * entry (`packages/cli/src/index.ts`) — no logic here.
 *
 * SSOT location rules (status-and-residuals.md § `plans[].execution_lease`;
 * ADR 2026-07-22-iteration-worktree-plan-lease.md A3 — `plans[].execution_lease`
 * in status.json is the claim/hold/release SSOT):
 * - Row-level `plans[].execution_lease` only, valid → OK.
 * - Metadata-only (`plans[].metadata.execution_lease`) → high-severity
 *   `lease.verify.non-ssot-location`: the metadata location is a
 *   legacy/hand-written read-compat fallback, NOT equivalent to SSOT
 *   success. No documented compat mode exists (the real control
 *   control status.json stores the lease at the row level), so this is
 *   always a FAIL (non-zero exit) with the lease shape still validated and
 *   reported.
 * - Both locations present → `lease.verify.dual-write`: the row-level lease
 *   wins and is validated; the metadata copy must be deleted.
 * - Neither present → existing missing / InProgress-orphan logic.
 */
export {
  planExecutionLeaseLocations,
  verifyPlanExecutionLease,
} from "@mstar-harness/engine";
export type { ExecutionLeaseLocations, LeaseVerifyResult } from "@mstar-harness/engine";
