# Concurrent-write safety (engine-absent guidance)

Read `mstar-harness-core` first. This reference supplies safety guidance only when engine capabilities are absent; it does not recreate removed plan-session admission or authorize raw edits to protected execution state.

## Workflow

1. Keep process state under the primary checkout/control harness root. Product edits use distinct feature checkouts; integration uses its recorded separate checkout and branch. Never bootstrap a second process authority in a feature tree.
2. The primary coordinator selects the workflow/plan, records source facts and effective QA/cleanup configuration, and dispatches ordinary leaf tasks. Default QA is mandatory and cleanup allow-residual; configuration stays revisable. No per-plan claim, identity or binding is required.
3. Apply Prepare/Execute, SDD task review, plan QC tri and QA obligations. Keep the row InReview until its declared-route proof is complete.
4. For iteration rows, serialize the real Git merge in the recorded integration checkout and retain actual base/source/result SHAs. The supported direct complete operation verifies Git and review evidence before Done. Standalone development verifies its own source; report-only consumes recorded policy fulfilment without invented Git.
5. If no supported domain writer is available, report the exact missing capability and restore/use the supported CLI or host operation. A validator, manual lock, hand-edited snapshot or recreated transfer state is not a substitute.

## Decision Rules

- Coordinator state writes are atomic: file writers own same-host lock and atomic replacement; ACTIVE DB writers own transactions/CAS/receipts. Keep unrelated rows, metadata and evidence intact.
- Per-plan execution leases are removed; source scope comes from row metadata. An InProgress row without a historical lease is not an orphan admission failure.
- Workflow-wide integration merge exclusion protects actual concurrent writers; never steal a foreign claim by age, idle status, labels or TTL. Complete releases only applicable exclusion for its verified attempt.
- Independent source tasks may run concurrently after L1/L2 isolation. Without a shared safe coordination authority, schedule serially; serial scheduling does not waive checkout integrity.
- On an in-flight/conflicted merge, resolve or explicitly abort Git in that checkout. On lost output after a successful merge, retry direct complete with actual SHAs, never perform a second merge. Exact receipt replay does not rewrite completion timestamps.
- Worktree cleanup and terminal close never clear exclusion to force eligibility. Retained source metadata and real merge evidence govern deletion.

## References

- `mstar-iteration/references/phase-2-worktree-lease.md` — direct primary coordinator execution checklist
- `mstar-artifacts/references/status-and-residuals.md` — current fields and authority
- `mstar-artifacts/references/plan-workflow-lifecycle-contract.md` — three distinct completion/outer-delivery routes
- `mstar-use-cli/references/plan-and-workflow.md` — supported operation parameters and recovery
