---
module: parallel track worktrees + subagent write routing + plan evidence paths
date: 2026-10-14
last_updated: 2026-11-09
problem_type: tooling_decision
category: tooling-decisions
severity: high
plan_id: <plan-id>
applies_when:
  - "Dispatching leaf implementers across several concurrent track worktrees"
  - "A dispatched task edits a package whose contract another track has already changed"
  - "A woody agent must write files (not just run commands) in a worktree that is not the primary checkout"
  - "Writing delivery evidence for `mstar plan complete`"
tags:
  - git-worktree
  - parallel-dispatch
  - stale-base
  - primary-checkout-pollution
  - evidence-paths
---

# Parallel tracks: three failure modes that all look like the leaf's bug

## Context

Three separate failures hit the same delivery (`<plan-id>`, four track worktrees, five tasks), and each was first read as the implementer's mistake:

1. **A leaf wrote to the primary checkout.** One implementer's `write`/`edit` calls resolved **relative** paths against `/Users/bibi/workspace/ai/mstar-harness` even though its shell `cd`ed into its track worktree. The three intended edits landed as uncommitted modifications in the primary checkout while its own worktree stayed clean. The agent's own `git status` in the worktree showed nothing, so its self-check passed while the change went to the wrong tree. PM saved the diff, applied it into the track worktree, restored the primary, and the implementer committed from there. A second implementer on the same host did the same thing for a different task.

2. **A leaf judged a contract from a stale base.** One dsh implementer reported that `packages/engine/src/core.ts` still typed severity as `...|nit` and offered to change the engine — correct for its checkout, wrong for the delivery: the track that owned the engine change (`track-b`) had already converged it, and the dsh track simply had not received that commit yet. Track worktrees isolate *tracked bytes*; they do not carry a sibling track's commits.

3. **`plan complete` rejected relative report paths.** The `qc.reports` / `qc.consolidated` / `acceptance.report` / `evidence_paths` members are all validated by `assertEvidenceInsidePlanArea` (`packages/engine/src/coordination.ts:1019`): each must be **absolute**, must exist, and must sit under `{PLAN_DIR}` or `{SDD_DIR}/<plan-id>`. A relative `review/qc1.md` is refused with `Evidence path must be absolute…` even though the same string works as a *stored* reference, and the refusal's recovery line suggests `--evidence <evidence-file>` (the flag takes inline JSON; `--file` takes the path).

## Guidance

1. **Put the absolute-path rule at the top of every writable Assignment, and require the two-check discipline.** State: relative `read`/`write`/`edit` paths resolve against the primary checkout on this host — use absolute worktree paths; after every edit check `git -C <worktree> diff --stat` **and** `git -C <primary> status --porcelain` (must stay empty). "Verify your worktree" alone is not enough: in failure mode 1 the worktree was genuinely clean.
2. **Before dispatching a task whose package contract a sibling track changed, merge that sibling into the target worktree and say so.** Otherwise the leaf reads a pre-change contract and either misreports it or "fixes" it twice. In failure mode 2 the correct answer was a PM-side merge plus an explicit "do not change `packages/engine` here".
3. **Treat a primary-checkout write as recoverable, not fatal:** capture `git diff` to a file under `.tmp/`, `git -C <worktree> apply` it into the right worktree, `git checkout --` the primary paths, then tell the implementer the state — including that its earlier cleanliness check raced the restore if it did.
4. **Write `plan complete` evidence with absolute paths** for every report and evidence member, and prefer `--file <json>` over `--evidence <json>` for readability. Expect the refusal if any member is relative.
5. **After a fix wave, re-read the branch head.** Every fix part merged into the source branch moves the review range; the QC re-review package and the PM Acceptance range must be regenerated from the new head, not reused.

## Why This Matters

All three failures are silent at the point they occur and expensive later: the primary-checkout write corrupts a tree other work depends on (and can be committed by an unrelated `git add -A`); the stale-base judgement spends a round on code that is already correct; the evidence-path refusal blocks the row's `Done` write at the end of a long delivery, when the operator is least willing to re-derive the layout. None of them is visible from "the tests passed in my worktree".

## Source

Delivery `<plan-id>` (workflow `wf-<plan-id>`). Incident evidence: `.tmp/incident-<plan-id>D-primary-write.diff` and the `progress.md` incident entry; the stale-base exchange is in the track D implementer transcript; the evidence-path refusal is reproduced by any `plan complete` with relative `qc.reports`. Related: `worktree-dependency-dist-isolation.md` (the same isolation gap, for `node_modules` and `dist`).
