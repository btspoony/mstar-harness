# Concurrent-write safety (engine-absent guidance)

Read `mstar-harness-core` first. This reference supplies safety guidance only when engine capabilities are absent; it does not recreate removed plan-session admission or authorize raw edits to protected execution state. Engine-absent hosts have no file execution route — execution state is conversation tracking (no-plan mode).

## Workflow

1. Keep process state under the primary checkout/control harness root. Product edits use distinct feature checkouts; integration uses its recorded separate checkout and branch. Never bootstrap a second process authority in a feature tree.
2. The coordinator selects the workflow/plan, records source facts and effective QA/cleanup configuration in conversation/plan docs, and dispatches ordinary leaf tasks. Default QA is mandatory and cleanup allow-residual; configuration stays revisable. No per-plan claim, identity or binding is required.
3. Apply Prepare/Execute, SDD task review, plan QC tri and QA obligations; keep the work in review until its QC/QA evidence is complete.
4. For iteration work, serialize the real Git merge in the recorded integration checkout and retain actual base/source/result SHAs. Standalone development verifies its own source; report-only consumes recorded policy fulfilment without invented Git.
5. Engine-absent hosts track execution state in conversation (no-plan mode). If a supported CLI/host operation is available, use it instead of hand-editing state — restoring that capability is an optional transition, never a requirement for no-plan tracking. A validator, manual lock, hand-edited snapshot or recreated transfer state is not a substitute for a supported operation.

## Decision Rules

- Never bootstrap a second process authority in a feature tree; serial scheduling does not waive checkout integrity.
- Per-plan execution leases are removed; do not recreate a claim, binding or transfer protocol. An InProgress item without a historical lease is not an orphan admission failure.
- Independent source tasks may run concurrently after L1/L2 isolation. Without a shared safe coordination authority, schedule serially.
- On an in-flight/conflicted merge, resolve or explicitly abort Git in that checkout; never perform a second merge after a successful one. Retained base/source/result SHAs are the merge evidence.
- Never force worktree cleanup or terminal-close eligibility by clearing coordination state; retained source metadata and real merge evidence govern deletion.
- Never steal a foreign claim or exclusion by age, idle status, labels or TTL; complete only the exclusion that applies to your verified attempt.
- Engine-present hosts own the row/DB mechanics — atomic coordinator writes (transactions/CAS/receipts), integration merge exclusion, direct complete and receipt replay → `mstar-artifacts` / `mstar-use-cli`. This archive never presents them as the engine-absent workflow.

## References

- `mstar-iteration/references/phase-2-worktree-lease.md` — direct primary coordinator execution checklist (engine-present runtime)
- `mstar-artifacts/references/status-and-residuals.md` — current fields and authority
- `mstar-artifacts/references/plan-workflow-lifecycle-contract.md` — three distinct completion/outer-delivery routes
- `mstar-use-cli/references/plan-and-workflow.md` — supported operation parameters and recovery
