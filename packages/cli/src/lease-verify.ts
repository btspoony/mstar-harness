/**
 * CLI `mstar lease verify` — thin wrapper over the engine lease-verify gate.
 *
 * The execution_lease SSOT in v3 is the workflow snapshot plan row
 * (`workflows/<id>/snapshot.json` `plans[].execution_lease`); the CLI
 * resolves `--workflow <id>` to the snapshot and feeds the engine the row
 * (`lease.verifyPlanExecutionLease` / `planExecutionLeaseLocations`) so
 * every host hook / CLI entry / Slice-2+ consumer imports ONE policy. This
 * file only re-exports it for the CLI entry (`packages/cli/src/index.ts`) —
 * no logic here.
 *
 * SSOT location rules (workflow snapshot plan row; the v1-era
 * `plans[].metadata.execution_lease` legacy read-compat location was
 * DELETED in the v3 cutover — the snapshot is machine-written whole-rewrite,
 * so no metadata-only / dual-write branches remain):
 * - Row-level `plans[].execution_lease` only, valid → OK.
 * - Neither present → `lease.verify.missing` (non-InProgress) /
 *   `lease.verify.orphan` (InProgress).
 */
export {
  planExecutionLeaseLocations,
  verifyPlanExecutionLease,
} from "@mstar-harness/engine";
export type { ExecutionLeaseLocations, LeaseVerifyResult } from "@mstar-harness/engine";
