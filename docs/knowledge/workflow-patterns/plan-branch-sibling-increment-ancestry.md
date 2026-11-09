---
module: mstar-sdd plan gates (plan QC tri + PM Acceptance) over parallel implementation tracks
last_updated: 2026-11-09
date: 2026-09-23
problem_type: workflow_issue
category: workflow-patterns
severity: high
plan_id: "<plan-id>, <plan-id>, <plan-id>"
applies_when:
  - "A plan splits a task into an isolated sibling track (its own branch/worktree) that must land before that plan's gate"
  - "Preparing a plan QC or PM Acceptance round for a multi-track plan"
  - "A gate returns Blocked with the named behaviour missing from the reviewed artifact"
tags:
  - sibling-track
  - ancestry
  - plan-branch
  - gate-blocked
  - merge-order
  - review-basis
---

# A plan gate consumes the branch tip: merge every sibling track before dispatching it

## Context

When a plan splits work into an isolated sibling track — its own branch and worktree, reviewed by its own task review — the track's reviewed commit lives somewhere else until someone merges it onto the plan branch. Three plans in one iteration each reached a gate with a required sibling increment *not* on the reviewed tip:

- the completion-witness task was approved on its own `-c5` branch while the plan branch still carried the refs-only witness and its completion selector still exercised three tests instead of the reviewed ten;
- the notes-ledger fix delta was absent from the plan branch when the plan QC seat read it, so the seat had to grade those items by reading the sibling worktree — separating "the fix is wrong" from "the fix is not merged";
- the host-side OpenCode arm was a sibling-branch commit that was not an ancestor of the tip the seats reviewed.

Every gate behaved correctly: it reported the gap as a blocked/missing-evidence result rather than approving an artifact that did not contain the reviewed behaviour.

## Guidance

1. **The gate's evidence is the reviewed branch tip, and ancestry is checkable.** Before dispatching plan QC or the PM Acceptance round, verify each required sibling increment is an ancestor of the reviewed HEAD (`git merge-base --is-ancestor <sibling-tip> HEAD`), not merely merged into some other branch. The check belongs in the dispatch preparation, alongside the review range pin — a plan whose task list names a sibling merge (e.g. "F1 into the Files branch", "H4 into the Hosts branch") has this obligation by construction.
2. **Write the merge order into the plan, as a serialization rule.** Name which track lands where and before which gate. Ordering is a coordination decision, so it is recorded, not inferred from dependencies.
3. **Merge the track, then re-run the affected selector, then re-dispatch.** The remediation is a merge on the plan branch plus a fresh gate round on the new tip. Re-running the same seat against the same tip is not a remediation, and re-reading the sibling worktree is only a diagnosis — it cannot turn into approval.
4. **Treat a Blocked for a missing increment as correct behaviour, not an acceptance defect.** Report it as a merge-order miss with the named increment and the two tips; the fix is on the work side. Likewise, a reviewer who graded an item from a sibling worktree should say so explicitly, so the PM can distinguish "not merged yet" from "merged and broken".
5. **Refresh the review basis after every merge.** A gate round's diff basis is the tip it read; once a sibling merge advances the tip, the earlier verdict covers the earlier artifact and the affected acceptance must be re-witnessed, not inherited.

## Why This Matters

The gate is the last cheap place to add a reviewed increment. If a seat approves a tip that lacks it, the plan can be marked `Done` with a required behaviour unevidenced — and the missing increment then has to be re-proven against an already-closed plan, with its leases and worktree released. The failure is also expensive in the other direction: a Blocked round costs a merge, a re-run and a second seat, and it repeats for every track the plan forgets, so a plan with three isolated tracks pays the same round up to three times.

## When to Apply

- Any plan whose tasks are split into isolated sibling tracks (own branch/worktree, own task review) that converge on the plan branch.
- Preparing a plan-level QC tri or PM Acceptance round: the ancestry check is part of the dispatch, not of the seat's reading.
- A second Blocked→Pass round on the same plan — read the first Blocked as a merge-order signal before re-dispatching.
- Writing a plan's Global Constraints or a PM integration checklist: record the merge order next to the gate definitions.

## Examples

### Before

A plan's completion-witness task is approved on `feature/<plan>-c5`; the plan branch still carries the previous witness implementation. The gate reads the plan branch, the acceptance criterion is unmet, and the round returns Blocked — then a merge and a re-run turn the same selector from three tests to the reviewed ten and the gate passes.

### After

The plan records "sibling track → plan branch before this plan's gate" as a serialization rule; the dispatch verifies ancestry at the pinned review range, merges the track, re-runs the affected selector, and only then dispatches the gate — one round instead of two.

## Source

Iteration `iter-<plan-id>`, plans `<plan-id>`, `<plan-id>` and `<plan-id>`. Evidence: the plan QC consolidated reports and the L4 acceptance reports (then the QA route) under each plan's `{SDD_DIR}/review/` (the Blocked round, the sibling-worktree grading disclosure and the post-merge revalidation). Related: `workflow-patterns/merge-state-seam-review.md` (the composite is reviewed as its own artifact once landed), `skills/mstar-branch-worktree/SKILL.md` § QC / PM Acceptance 检出对齐与多 worktree 门禁衔接 (the single-review-snapshot precondition the ancestry check feeds).
