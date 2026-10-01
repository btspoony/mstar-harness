Status: DONE_WITH_CONCERNS

## Finding 1 — command paths
Updated `store.activation-stale` and `store.schema-drift` recoveries to use the real `store execution` prefix. Schema-drift includes `--out <preview-file>` before restore. Exact tested command: `store execution restore-preview --backup <backup-file> --out <preview-file>`; restore command text: `store execution restore --preview <preview-file> --accept-loss-digest <loss-digest> --operator <name> --authorization <ref>`.

## Finding 2 — unreadable live database
The existing engine implementation contract and review evidence establish that preview inventories live DB first; I did not obtain a successful isolated fixture reproduction in this task. The targeted attempted CLI test selection `bun test test/execution-migrate.test.ts -t 'unreadable live store'` ran zero tests, so this requested empirical fixture proof remains incomplete. Diagnostic now explicitly says preview cannot recover unreadable live store, no online operator restore is available, and rebuilding through `store init` loses SQLite-only catalog/execution data. Exact text: “A restore preview requires inventory of the live database, so `store execution restore-preview` cannot recover an unreadable live store. No online operator restore is available in this state. If no verified backup can be restored through a supported recovery process, rebuild the store with `store init` only after preserving the corrupt database and legacy sources; rebuilding loses SQLite-only catalog/execution data.”

## Finding 3 — pending catalog registration
Replaced unconditional abort recommendation with phase-aware guidance: inspect using `catalog reconcile --operation-id <operation-id>`; only prepared operations with neither snapshot nor root entry should be retried with `--abort`; existing execution bytes mean abort refuses, so complete reconciliation after correcting reported ownership/evidence conflicts, or remove the affected workflow through lifecycle. The test pins this distinction. Exact text is included in the emitted recovery: “Inspect the operation with `catalog reconcile --operation-id <operation-id>`. For phase `prepared` with no workflow snapshot or root registration, rerun with `--abort`; if a snapshot or root registration exists, abort is refused—complete reconciliation after correcting the reported ownership/evidence conflict, or remove the affected workflow through its supported lifecycle before retrying.”

Concern: the staged-path refusal cases (non-`execution-written`, non-stale, ownership mismatch) still use the generic unclassified fallback. I did not map each to a proven distinct operator procedure, so cannot claim this review criterion is fully satisfied.

## Finding 4 — terminal states
Staged missing record, inconsistent identity, and missing manifest now say the entry's interactive abandon confirmation only applies to changed-evidence activation and cannot fix these states; no in-place operator recovery is available. Each recommends rebuild via `store init` after preserving state and explicitly discloses SQLite-only data loss. I did not verify in a live isolated fixture that `store init` is accepted from each precise state; treat rebuild advice as needing further confirmation before operator use. Exact stated outcome: “No operator-executable in-place recovery is available. Preserve the legacy sources; rebuild with `store init` only after preserving the store and source bytes, understanding that SQLite-only catalog/execution data will be lost.”

No-backup corrupt state: explicitly no online operator restore and names the same rebuild/loss path. Staged abandonment is not asserted as reachable for missing/inconsistent-record states.

## Finding 5 — hygiene
Expanded path redaction to common Unix/macOS/Windows locations and redacts internal field tokens including `workflowId`, `operationId`, and `lossDigest`. Added a path-bearing and identifier-bearing payload test that asserts these values do not leak.

## Cause → code → exact recovery → test
- Stale recovery evidence → `store.activation-stale` → `store execution restore-preview --backup <backup-file> --out <preview-file>` (conditional on readable live store) → cause/action table test.
- Unreadable/corrupt store → `store.corrupt` → no online preview recovery; preserve bytes, then `store init` rebuild with SQLite-only data-loss warning → dedicated corrupt test.
- Schema drift → `store.schema-drift` → install schema-owning CLI; readable-store restore preview with `--out` and subsequent exact `store execution restore` path → cause/action table test.
- Pending registration → `store.upgrade-pending-registration` → inspect via `catalog reconcile --operation-id <operation-id>`; abort only with prepared/no bytes; otherwise reconcile/remove via lifecycle → dedicated pending test.
- Staged record absent/inconsistent/manifest absent → corresponding `store.upgrade-staged-*` → no in-place recovery; preserve and rebuild with `store init`, SQLite-only loss disclosed → staged producer-refusal tests.

## Verification
- `bun test test/store-upgrade-diagnostics.test.ts` (from `packages/commands`): 29 pass, 0 fail, 141 expect() calls.
- Attempted unreadable fixture test selection: `bun test test/execution-migrate.test.ts -t 'unreadable live store'` (from `packages/cli`): zero tests matched; no empirical reproduction completed.
- Primary checkout safety before/after writes: `git -C /Users/bibi/workspace/ai/mstar-harness status --short` empty; branch `main`.

Commit SHA: pending.
