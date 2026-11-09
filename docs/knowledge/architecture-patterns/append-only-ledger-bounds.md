---
module: packages/engine store (execution-store, execution-ledgers)
date: 2026-10-31
last_updated: 2026-11-09
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: <plan-id>
tags:
  - append-only
  - retention
  - compaction
  - disclosure-marker
  - concurrency
applies_when:
  - A growing append-only file or table must be bounded without losing replay or audit identity
  - A reader must disclose that it saw only a window of history
  - A rewrite races a lock-free appender
---

# Bounding an append-only ledger without losing its identity

Three rules earned while bounding a running workflow's operation receipts and its `notes.jsonl` coverage
ledger. Each one replaced an approach that looked correct and was not.

## Where we are

- `execution_operations` rows are the replay identity for `--operation`. `notes.jsonl` lines are an append log
  whose coverage read feeds dashboards. Both grew with the age of the control root; the terminals-only prune
  and the whole-file read bounded neither. `execution_operations` is now **lifecycle**-bounded, not
  count-bounded (#661): a running lifecycle keeps one receipt per committed operation, the terminal mutation
  prunes to its own receipt (`pruneWorkflowOperationReceipts`), and an epoch bump clears the superseded epoch.
  The former `RUNNING_WORKFLOW_OPERATION_RECEIPT_LIMIT` bound and its `execution.receipt-retention-exhausted`
  refusal are retired with no shim.

## Guidance

1. **Bound by refusal, not eviction, when a row carries replay identity.** Deleting the oldest receipt
   destroys an `--operation` replay key, and no later read can tell a deleted key from one that never existed.
   The count-capped form of this rule (a `RUNNING_WORKFLOW_OPERATION_RECEIPT_LIMIT` ceiling refusing the next
   non-terminal id with an adopt-or-close recovery) was **retired in #661**: a fixed count turns ordinary work
   volume into a dead end, and an unfinished lifecycle cannot take the recovery it named. Retention is now
   lifecycle-bounded instead — every committed operation of the running lifecycle keeps its receipt, the
   terminal mutation prunes the set to its own receipt (`pruneWorkflowOperationReceipts`), and an epoch bump
   clears the superseded epoch.
2. **A capacity check must state its scan.** (Historical, with rule 1's retired cap.) The refusal counted rows
   filtered by `(workflow_id, epoch)` while the table's primary key is `(epoch, operation_id)`, so that count
   scanned. The lesson survives the retirement: a cap that is correct but unindexed turns every operation write
   into a history scan — state the scan rather than pretending the check is free.
3. **One file, one disclosure row, and the row must be the last line.** Compaction keeps the newest complete
   lines that fit `WORKFLOW_NOTES_LEDGER_READ_BYTES`, always keeps the triggering line whole, and appends one
   `workflow-notes-compaction` row carrying `dropped {bytes, lines, records, historical, unrecognized}` and the
   sha256 of every removed byte — superseded marker rows included, or the digest matches no byte range at all.
   Retained content is assembled span by span while skipping every marker, so exactly one survives.
4. **Pin the triggering line by bytes, not by position.** An ordinary append is lock-free, so a peer frame can
   land after the committing frame and before the compaction read; a position-based "keep the last line" rule
   then drops a note whose append already returned a receipt. Match the appended frame's bytes and lower the
   retention boundary to it.
5. **Publish on an unchanged snapshot, and name the gap that remains.** Write the temporary file, re-read the
   leaf's size, rename only when it is unchanged, and otherwise discard the temporary file. The residual
   stat→rename window is real; it belongs in a `shortcut:` note on the append path, not in a claim that the
   lock excludes peers — the maintenance lock excludes other over-ceiling appends, not ordinary ones.
6. **Disclose what the window did NOT see.** A reader opens at most `WORKFLOW_NOTES_LEDGER_READ_BYTES` of tail,
   drops the partial first line, and reports `readWindow {offset, totalBytes, truncated}`. The marker is only
   visible while it stays inside that window: once later appends push it out, coverage reports
   `truncated: true` with `compaction: null`. Say that in the reader's own doc; "the marker is always visible"
   is false the moment the ledger grows again.

## Why this matters

Every rule above replaces a silent-data-loss shape with a named one. An evicted replay key, a dropped receipted
note, a digest that hashes a reordered byte set, or a coverage report that presents a window as the whole file
all fail the same way: the artifact looks healthy and the history is gone. Refusals, receipts, and disclosure
rows are the only evidence a later reader can verify.

## When to apply

Use these rules whenever a growing append-only artifact must be bounded: operation logs, audit trails, JSONL
event ledgers, or any file a monitor reads on a schedule. They apply per surface, not per workflow kind.

## Examples

- Retained receipts: a running workflow accepts ordinary plan work past the former 256-receipt ceiling, the
  earliest and newest retained `--operation` keys both replay, a changed intent still conflicts
  (`execution.operation-conflict`), and the terminal close prunes to one receipt.
- Compaction: an over-ceiling append compacts under the store's `BEGIN IMMEDIATE`, and a concurrent lock-free
  append makes the compactor abandon its temporary file instead of overwriting that frame.
- Coverage: a 1 MiB tail read on a 4 MiB ledger reports `truncated: true`, so a dashboard can say "showing the
  newest window" instead of implying completeness.
