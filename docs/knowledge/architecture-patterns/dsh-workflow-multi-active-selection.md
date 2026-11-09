---
module: dsh-workflow
date: 2026-09-12
problem_type: architecture_pattern
category: architecture-patterns
severity: high
tags:
  - dsh
  - workflow-selection
  - concurrent-active
  - execution-scope
  - fail-loud
related_components:
  - packages/dsh
source_plans:
  - 20260911-dsh-multi-active-selection
status: active
last_updated: 2026-11-09
---

# Concurrent-active workflow selection: bind, never first-entry

## Context

The active set legally holds N>1 active lifecycles (operator design intent: parallel worktrees under one control root). The pre-fix resolver picked `workflows[0]` and logged a `workflow.selection.multi-active` warning whose text claimed "no silent pick" while silently picking. Every consumer fanned off that one value: agent-flow ledger write dir, dispatch P-b, adapter, catalog/panel read.

## Guidance

Binding order — one resolver (`workflow-selection.ts` `selectActiveWorkflow`), all consumers call it with a `SessionHint` (`cwd` / `sessionId` / `selectedWorkflowId` / `planId`):

1. **Row scope** — a plan row's `metadata.worktree_path` (with a recorded `working_branch`) contains the session cwd.
2. **Cwd** — session cwd equals/inside the lifecycle's `integration_worktree_path` (realpath when both exist; trailing-sep-guarded prefix otherwise). Collected independently of rung 1: a row-scope match never removes an entry from the cwd candidate set.
3. **Explicit** — session-persisted `selectedWorkflowId` naming an *active* id (terminal ids ignored on the write path). It outranks an inferred rung.
4. **Plan row named by the operation** — `hint.planId` is a row of exactly one lifecycle (the normal parallel-worktree case: cwd alone can never discriminate).
5. **Unique active** — `length === 1`, no warning.
6. **Else** — `kind: 'error', code: 'workflow.selection.unbound-multi-active'`; write path returns `null` (skip, never throw out of a listener); panel shows the active-id list + picker. Each automatic rung needs EXACTLY ONE distinct match — zero or several fall through, never arbitrated by array order — and nothing falls back to the registry's first entry.

Per-row `execution_lease` no longer exists (migration 9 settled retired holders into row metadata); the row-scope rung reads `metadata.worktree_path` / `working_branch`, and the orphan-`InProgress`-without-scope red line is P-b's `workflow.lease.uncovered`. Omitted hint ≡ unbound. Every entry is validated (`validateWorkflowEntry`-contract: type/started_at, harness-relative dir, no `..`, duplicate-id rejection) before it can be a candidate; a `JSON null` / non-object status root or snapshot is a selection error, never a throw. Two authority routes feed the SAME binding rule: while the execution authority is ACTIVE, `readExecutionWorkflowSource` normalizes the store's registry/plan state into the identical active-set input, so the retired `status.json` bytes are never consulted.

## Why This Matters

First-entry steal meant: with two actives, both sessions' ledger rows landed in `workflows[0]`'s dir and the panel showed only the first — silent cross-contamination of exactly the evidence the ledger exists to keep.

## When to Apply

Any "pick the active X" code over a register that permits multiple actives. The warning text is not a gate; a rejected-promise/error-kind that makes downstream skip is.

## Examples

- `packages/dsh/src/gates/workflow-selection.ts` (`selectActiveWorkflow` binding order, `resolveActiveWorkflow` file route, `readExecutionWorkflowSource` route decision, `resolveExecutionLedgerTarget`)
- `packages/dsh/src/gates/agent-flow.ts` (the ledger writer resolves its target dir through `resolveExecutionLedgerTarget` and skips on unbound)
- `packages/dsh/tests/catalog.spec.ts` (two-actives fixture: the unbound error, `activeWorkflowIds`, and the empty `plans`/`direction` that follow from it). `workflow-selection.spec.ts` now only retains the retired file-route refusals.

Promoted from: `iterations/iter-20260911-dsh-native-workflow/specs/multi-active-binding.md`.
