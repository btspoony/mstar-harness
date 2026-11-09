---
module: mstar-sdd plan QC tri and PM Acceptance dispatch metadata (review basis fields)
date: 2026-09-25
problem_type: workflow_issue
category: workflow-patterns
severity: high
plan_id: "<plan-id>"
last_updated: 2026-11-09
applies_when:
  - "A plan QC round returns Request Changes and a fix wave lands on the plan branch before the PM Acceptance round"
  - "Preparing a PM Acceptance dispatch after a QC seat has revalidated a fix delta in place"
  - "Acceptance is blocked with plan_id / Review range / Diff basis as the only stated gap"
tags:
  - qc-qa-alignment
  - review-range
  - diff-basis
  - fix-wave
  - revalidation
  - qa-blocked
---

# Range alignment after a fix wave: the QC/acceptance gate is text-identity over metadata

## Context

The L3 plan-QC tri and the PM Acceptance round are dispatched with `plan_id`, `Review range / Diff basis`, `Working branch` and `Review cwd`, and the alignment contract requires those fields **text-identical** across the three QC reports and the acceptance record (`skills/mstar-roles/references/project-manager/qc-and-residuals.md` § QC / Findings NEVER ("NEVER consolidate tri-review into `Approve` when any QC report's alignment fields differ"), `skills/mstar-roles/references/project-manager/acceptance.md` step 2). The seat-file side of that contract is machine-checked by `mstar worktree qc-alignment <assignment files...>` (engine `assertQcAlignment`, `qc.alignment.mismatch`), which exits 1 on a mismatch or a missing field.

A plan QC round that returns `Request Changes` legitimately advances the plan branch. The fix wave lands, and the targeted re-review convention has each raising seat update its **own** `{SDD_DIR}/review/qcN.md` in place with a `## Revalidation` section and a refreshed verdict (`mstar-review-qc`) — the report keeps declaring the range round 1 read, because that is the range round 1 reviewed. The acceptance record, by contrast, is written against the accumulated `merge-base..final-tip` range, because acceptance must grade the artifact that contains the fix.

The two declarations therefore diverge **by construction**, and the divergence is metadata, not evidence:

- the three reports declare the round-1 range plus a revalidation delta on the fix wave;
- the acceptance record declares the whole accumulated range up to the post-fix tip.

An acceptance reader of that pair returns `Blocked` on the alignment rule. That is the gate working as designed: it exists so that a signed-off range cannot silently absorb commits nobody reviewed.

Observed in plan `<plan-id>`: QC round 1 returned `Request Changes` from all three seats on one blocking finding; the fix wave landed (`c4b47819..91661aa0`, plus a comment-only nit `eda4c5cd`); each seat revalidated in place and moved to `Approve`; the acceptance record declared `ecdf67b3..79d01a00` while the reports still declared `ecdf67b3..c4b47819`. The first acceptance dispatch returned `Blocked` for the metadata mismatch alone, with no product evidence in question. The mechanism is role-independent: that round ran under the retired L4 QA seat, and the same gate now checks QC reports against the PM Acceptance record.

## Guidance

1. **Read the drift as expected bookkeeping, and account for it before accepting.** When a fix wave lands after a tri round, the PM knows the reports' declared range and the acceptance range will differ; the fix is to make the *reports* declare the range acceptance is recorded against, not to bend the record.

2. **Do not resolve it in either cheap direction.** Pulling the acceptance range back to the round-1 range asks acceptance to grade an artifact that predates the fix; accepting "the ranges differ but the evidence is fine" defeats a gate whose whole purpose is that a signed-off range is auditable. Neither is a reconciliation.

3. **Reconcile by per-seat declaration, appended to each existing report.** Every QC seat appends its own `## Final range alignment` section carrying:
   - `plan_id`, the final `Review range / Diff basis` (identical text in every seat and in the acceptance record), and the verified `Working branch` / `Review cwd`;
   - a **coverage accounting** that names every reviewed segment — the round-1 range, each fix delta revalidated under `## Revalidation`, and any commit absorbed as already-confirmed (see 4) — and states that they tile the final range contiguously, with no gap;
   - an explicit statement that the verdict is unchanged and that the earlier round's stated scope limits remain limits rather than newly reviewed coverage.

4. **The accounting must be true commit-by-commit, or the gap is closed by review instead.** The declaration only works when every commit in the final range belongs to a reviewed segment. A comment-only or docs-only commit inside the range can be recorded as confirmed against its file, naming what it changes; a commit that changes behaviour and lies outside every reviewed segment is not absorbable — assign it to the seat that raised the blocking finding, or take a fresh bounded round over it, and say which happened.

5. **No seat reopens already-reviewed code.** The alignment section is an accounting statement over work already reviewed in the wave and its revalidation; re-reviewing the round-1 range to "make the metadata true" invalidates the earlier verdict and costs a full round for no coverage gain.

6. **Record the aligned range in the consolidated, then record acceptance against it.** The consolidated's aligned-basis block is the readable home of the final range and of what each delta was; the acceptance report repeats the same text. Acceptance then grades the product evidence, which is all that was ever in question.

7. **Prepare the dispatch so the mismatch is visible before acceptance reads it.** Run `mstar worktree qc-alignment` over the QC plus acceptance seat-file set as part of dispatch preparation, and, when a fix wave is pending, write the final range into the consolidated at the same time the fix wave lands rather than at acceptance time.

## Why This Matters

The gate compares text, so an evidence-correct range change is indistinguishable, at the gate, from an unreviewed commit smuggled into a signed-off range. Both failure responses are worse than the reconciliation: accepting the mismatch removes the only check on what an `Approve` verdict covers, and collapsing the range hides the fix from the seat that must grade it. The reconciliation costs one extra acceptance round plus one appended section per seat; skipping it costs either a full second tri round or a sign-off whose range cannot be audited.

It is also the cheapest possible failure to misread. A `Blocked` that names only `plan_id` / range / branch / cwd is not a finding about the product, not a seat defect and not a reason to re-run reviewers — it is a request for the accounting step above.

## When to Apply

- Any plan whose QC round 1 verdict was `Request Changes` and whose fix wave merges before acceptance.
- Any acceptance round that follows in-place `## Revalidation` of a fix delta.
- A `Blocked` whose only stated gap is alignment metadata (range, plan id, branch, cwd).
- Any round where a report annotated in place must be read against an outer dispatch range that moved.
- Writing the plan's dispatch checklist: the ancestry/range check belongs there, together with the merge of every sibling track.

## Examples

### Before

Three QC reports declare `Review range / Diff basis: A..B` and record their fix-delta revalidation; the acceptance record declares `A..C` for the same plan. Acceptance returns `Blocked` on the mismatch; the visible options look like "shrink the acceptance range" or "re-run the tri".

### After

Each seat appends `## Final range alignment`, declaring `A..C` with the coverage accounting `A..B` (round 1) + `B..C` (revalidated fix delta, plus a comment-only commit confirmed against its file), each keeping its `Approve`; the consolidated records the aligned range; acceptance is re-run on `A..C` and grades the product evidence.

## Source

Iteration `iter-<plan-id>`, plan `<plan-id>`. Evidence: the seat `## Final range alignment` sections and the consolidated range-alignment and QA-retry record under `{SDD_DIR}/<plan-id>/review/`, plus that plan's acceptance report (written under the then-current QA route). Related: `workflow-patterns/plan-branch-sibling-increment-ancestry.md` (the review basis is refreshed after every merge, and ancestry is checked at dispatch), `workflow-patterns/merge-state-seam-review.md` (the tri and the acceptance round must share tip and range), `testing-patterns/mechanical-check-corpus-honesty.md` (`worktree qc-alignment` and the canonical combined label).
