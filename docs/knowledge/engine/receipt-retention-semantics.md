# Execution receipts lifecycle: retention anchors, per-verb replay expiry, and the epoch fallacy

**Kind**: Knowledge (design semantics) · **Status**: implemented — retention anchors merged as PR #467 (#448); payload slimming (#466) landed · **Feeds**: anyone changing receipt retention, payload shape or restore inventory

## The one-paragraph model

Every accepted operation writes one `execution_operations` row (PK `(epoch, operation_id)`); no writer ever deleted rows until the retention anchors landed. `authority_epoch` advances only at authority-lifecycle boundaries — store-init bump (`execution-store.ts:1469`), staged→active activation (`store-activation.ts:1985`), restore-image epoch patch (`execution-recovery.ts:1713`) — never during ordinary operation, so receipt rows lived forever in normal projects. Per-row payload varies by verb class: workflow-level transitions persist the full root graph, plan verbs persist one plan view, bind/recovery/catalog receipts are small.

**Sibling ledger — do not conflate them.** The tables below describe `execution_operations`, whose retention is workflow-scoped. `store_operations` is a separate, unpruned ledger, and it is the durable evidence a legacy execution import is proven from: see *Legacy execution import: proven replay versus an unproven ID collision* alongside this document.

## Retention anchors (landed)

1. **Terminal-close prune** — inside `mutateExecutionWorkflow`'s transaction, after the close receipt write, when `membershipLost` (surfaced from `applyWorkflowOperation` via module-private return shape): delete every receipt of that workflow **except the close receipt itself** through `pruneWorkflowOperationReceipts(tx, workflowId, keepOperationId)` — the retained terminal receipt is the durable replay anchor (an exact same request replays its recorded receipt; `workflow-close` reruns exit successfully).
2. **Adopt-time prune** — same helper (own receipt kept) immediately after `adoptTerminalWorkflow`'s receipt write.
3. **Epoch-bump purge** — `delete ... where epoch < current` beside the in-place bump only. Provably a no-op today (init's `assertExecutionDomainEmpty` precondition); kept as the constraint-pinned invariant. **It does not generalize**: restore's epoch advance deliberately preserves prior-epoch rows (frozen bytes-plus-one-epoch contract).

**Retention rule**: registered (RUNNING) workflows keep every receipt — no time/count window, and no eviction to make room. A count cap (`RUNNING_WORKFLOW_OPERATION_RECEIPT_LIMIT = 256`, `execution.receipt-retention-exhausted`) briefly existed and was RETIRED in #661: a fixed bound turns ordinary work volume into a dead end (close/adopt is unavailable to an unfinished lifecycle), so lifecycle end is the only bound. Do not reintroduce a running-workflow receipt count cap. This is the smallest rule honoring all four consumers; per-workflow accumulation stays linear in that workflow's own operation count (intentional, user-disclosed; the graph-sized peak is #466's slimming concern).

## Replay expiry is per-verb, never a global refusal

With the receipt row absent, `readCommittedOperation`/`readOperationReplay` return `null` → the same-id retry is processed as a **first attempt**. `execution.operation-conflict` fires only when the row exists with a different `request_hash`. Post-prune outcomes by verb class (each safe, each with cause + recovery):

| Verb class | First refusal after prune |
|---|---|
| Workflow lifecycle ops | registry witness `coordination.workflow-not-found` / terminal-amendment refusal |
| Terminal close | same registry-witness refusal (read-back = header + `mstar status validate`) |
| Terminal adopt | explicit stale CAS → `execution.header-revision-conflict` (CAS gate is load-bearing, stays ahead of read-back); omitted/current revision → `execution.adoption-refused` read-back |
| Plan verbs | `coordination.workflow-not-running`; Done row `complete` → `requireCompletableStatus`; RUNNING workflows are never pruned so receipt-first replay always answers |
| Bind/recovery/session | terminal/unregistered refusals; recovery chain reads only current-epoch live bindings |
| Registration | original root token → `execution.stale-token` first; stale catalog expectation → catalog revision conflict; current token → `execution.not-empty` (create-only identity) |

## Consumer constraints (the four walls any retention/payload change must preserve)

1. Coordinator recovery chain — `hasCoordinatorRecoveryChain` reads receipts by `committed_at = bound_at` of live bindings.
2. Idempotent replay — the `plan complete` case whose external proof is expensive to repeat; RUNNING workflows must keep receipts.
3. Terminal adoption read-back — close/adopt refusal via header state, not receipt presence.
4. Restore loss inventory — `AUTHORITY_TABLES` rows (incl. `result_json`) feed digests; pruned rows surface as declared backup-only differences (`authorityDifferences` + `resurrectedOperationIds`), never silent.

## Payload slimming (issue #466, landed after the retention anchors)

The graph-sized class (workflow creation, lifecycle transitions, terminal adoption) now persists a **slim envelope** instead of the full root graph:

```json
{ "slim": true, "token": "<commit-era root token>", "storeId": "<store>", "epoch": 3, "operationRecovery": { "…only when the verb persists one" } }
```

- **One writer, one reader.** `writeOperationReceipt(..., {slim: true})` is the only slim persistence path (creation's inline INSERT folded into it); `readCommittedReceipt` branches on the marker — slim rows replay `readExecutionStateGraph(tx)` (the LIVE data+token pair minted by the same transaction read), fat rows replay their stored bytes. Mixed forms coexist in one store forever: rows keep their write-time form; no rewrite job, no dual-write, no read-time normalization.
- **Token coherence.** Replay was never CAS re-evaluation; the recorded token survives in the envelope only as the address/epoch witness behind the `store.corrupt` validations. The SERVED token/data pair is the live one — serving a commit-era token beside live data would hand the caller a stale `--expect`.
- **What stays full, and why.** Plan-verb receipts (bounded by the plan's own row; §4.1's never-re-derived wall protects expensive external proofs on retry), bind/recovery receipts (`hasCoordinatorRecoveryChain` parses the stored bytes AS evidence), catalog registration (`replayed.data` consumed programmatically). Only the graph-sized class slims.
- **Forward-only versioning.** `result_json` is write-time versioned: a pre-slim engine reading a slim row refuses `store.corrupt` (version mismatch, not data loss — the unblock is the matching build). Restore inventory digests compare write-time bytes per row, so mixed forms produce declared presence differences only, never same-key content drift.
- **Bound.** Per-row size is now a small constant (pinned by a K=2 vs K=25 bounded-size test) while per-workflow row count stays linear in that workflow's own operation count — the RUNNING retention rule is unchanged. Together with the retention anchors, both growth dimensions of the receipt table are bounded.

## Fallacies this plan retired (do not re-derive them)

- "A fixed running-workflow receipt count bounds growth safely" — tried at 256 and reverted (#661); it dead-ends an unfinished lifecycle, and every retained receipt is a replay anchor the engine must not evict.

- "Epoch bump purges receipts" — only the init-time in-place bump touches the table; restore preserves.
- "Pruned retries degrade to `execution.operation-conflict`" — no; they become first attempts and each verb's own admission handles them.
- "Restored receipts re-arm replay" — no; replay is current-epoch scoped, restored rows keep the point's older epoch.
- "Terminal-only prune bounds growth" — it bounds cross-workflow accumulation only; the ACTIVE-workflow peak needed payload slimming, which landed (see the slimming section above).
