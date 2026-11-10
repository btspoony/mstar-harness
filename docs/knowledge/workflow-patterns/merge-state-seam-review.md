---
module: mstar-sdd task composition and plan QC, including normative documentation
date: 2026-09-15
last_updated: 2026-11-09
problem_type: workflow_issue
category: workflow-patterns
severity: high
plan_id: <plan-id>
applies_when:
  - Separate implementation tracks are composed before plan QC
  - Tasks touch opposite halves of one contract
  - A documentation plan rewrites normative rules or adds exclusions across sections
tags:
  - seam-review
  - merged-state
  - parallel-slices
  - cross-slice-contradiction
  - plan-qc
  - documentation
  - normative-rules
---

# Merge-state seam review: per-slice approvals are not evidence about the composite

## Context

When a plan task proves too large for one implementer turn, it is split into slices over disjoint write sets and the slices run as concurrent review tracks from the same integration commit. Each slice then passes its own L2 task review, and the plan QC tri keeps working from the per-slice approvals.

That sequence leaves a gap with no owner. A slice review answers "is this slice correct against the frozen contract?" It cannot answer "do any two slices contradict each other now that they are merged?" — the reviewer never sees the composite, and each slice's tests exercise its own half of the contract with the other half stubbed or imported as-is.

In `<plan-id>` the gap produced a measurable result: three engine slices (core/binding, row verbs + exports, protected-writer switchover) plus a CLI task each passed their own review — including one slice whose own L2 closed two Critical findings with red→green evidence — and a review of the *merged* engine diff then found **12 defects, 8 of them Critical and 4 Important**.

The same gap exists without parallel branches or executable code. A documentation task can satisfy its additions while deleting an unchanged obligation, or introduce an exclusion that conflicts with an older rule elsewhere in the file. The full plan's normative contract is the composite. For an SDD documentation plan, the existing L3 tri-review is the place to check that composite; this does not create another mandatory review layer or replace L2.

## Guidance

1. **For split implementation tracks, give the merged composite its own review round before plan QC consumes per-slice approvals.** Review the full merged diff (one task as one deliverable), not only isolated deltas. Supply a per-file navigation aid and named seam questions within the core's bounded review allowance; if that scope cannot be covered, report truncation and let the PM rescope rather than silently enlarging the seat or inheriting approval.
2. **Scope it to seams and forbid re-derivation.** The Assignment states which slices are already closed by their own review ("do not re-derive them; check that the fix composes"), and lists the seam questions verbatim: does the writer's lock/version protocol compose with the store boundary and the row-level revision checks; do the refusals cover every protected writer the contract names; does the state-machine path encode the required ordering; do the verbs' role/state gates match the contract; **does anything in the slices contradict another slice once merged**.
3. **Reusable seam-finding taxonomy** — these are the classes that survived per-slice review:
   - *Writer / protection half-pairing.* Slice C protects a write path; slice B widens the same writer's accepted input. Each half is defensible alone; together the protection is bypassed (an omitted version token must mean create-only, never "replace whatever is there").
   - *Identity aliasing across slices.* One slice keys rows by `String(row.id)`; the accepted row shape also allows the legacy `plan_id`. A row carrying only the legacy key escapes the ownership guard — a gap that sits in the *seam* between the coordination route and the register helpers, so each side's own cases are green.
   - *Ownership-transfer half-pairing.* A handoff deliberately leaves the lease with the submitting session; a later `return` from the pre-accept state transfers from the coordinator. Both behaviors are individually correct and compose into a refusal that can never succeed.
   - *No-op where the contract requires fail-closed.* A lease transfer that silently no-ops on an absent lease lets a state transition record success without the required transfer.
   - *Precondition drift.* A state gate checks Todo/Blocked but not "no lease present"; a row-binding check authenticates the session but not the matching active lease. The verbs then run after ownership disappeared.
   - *Producer / consumer key lists.* A payload key removed on the producer side stays mandatory in the consumer's exact-key parser, so a conforming caller is rejected before the gates run.
   - *Object identity used as set membership.* Deduping a list by path while testing membership by object identity breaks as soon as a replacement retains an existing entry — and throws a store-level refusal instead of judging the legitimate case.
   - *Error-code vocabulary.* Two slices emit different codes for the same conflict class, so the stable contract surface is half-implemented.
   - *Ancestry/pinning actor.* An "already integrated" proof that omits the current target HEAD accepts an attempt after the target was force-moved — the proof is a function of two slices' assumptions about which ref is authoritative.
4. **Serialize the merge order explicitly, and record it as a serialization rule, not a dependency.** Disjoint tracks branched from the same integration commit merge in a named order (B first, C second); the rule is written down in the plan because the order is a coordination decision, not an inferred prerequisite. When the composite is what is being reviewed, say so: merging tracks *before* the per-plan QC / PM Acceptance round is a deliberate ordering deviation that buys the seam review, and it must not be presented as a shortcut past the gates.
5. **Treat a coverage transfer as an unverified claim.** A supplementary round that covers a range someone else "already reviewed" must re-verify it rather than inherit the verdict. In the plan QC round that followed this seam review, the supplementary seat withdrew its own earlier "transfer honoured" claim and reported an additional Warning inside the supposedly covered range — which is why the rule is published as "re-review transfers must be verified, not accepted", and why such a round must name the range it actually re-checked.
6. **Route the seam findings back through the normal fix path, one regression case per Critical**, and prove each case load-bearing — the seam round is where non-load-bearing cases surface, because a case written against a slice's own assumption stops discriminating once the other slice's behavior changes (see `testing-patterns/load-bearing-regression-proof.md`).

### Documentation-plan tri-review: preserve propositions, reconcile owners

**General rule:** an L2 approval establishes only what that task's review actually covered. It is not evidence that the full document retains all prior obligations or that every new rule agrees with existing owners. A heading count, keyword match, or application example can show additions exist while a normative rule disappears next to them.

The PM's **SDD plan-QC dispatch** therefore needs the three distinct QC role identities on the same branch tip/range and the same review package, even when every changed product file is Markdown. A docs-only `Acceptance gate: pm-acceptance` changes the acceptance route, not the L3 seat count. The inline/hotfix exception remains owned by the runtime QC policy; document format alone does not select it.

Put these three checks in the shared dispatch, rather than assuming that earlier task approvals cover them:

1. **Preserved-rule check.** Compare the plan's full before/after range, including deleted lines and explicitly preserved sections. Account for each normative proposition that disappears: equivalent retained rule, explicit authorized relocation, or explicit authorized removal. Descriptive prose and an unchanged heading do not replace an imperative evidence requirement.
2. **Owner-consistency check.** Read each new exception/exclusion together with the rule it qualifies and every directly linked owner. The same signal must not yield incompatible verdicts. A pointer is complete only if the target states the entire distinction; “one home” means one coherent owner, not a short pointer to half a rule.
3. **Consumed-contract check.** Give seats the authoritative contract through an absolute control-root path when it is local, plus the tracked destination. Review the meaning of qualifiers and thresholds, not just label presence. A feature worktree's inability to find an ignored draft does not authorize substituting an enum for the normative contract.

These checks fit inside bounded, diff-first QC over the plan and directly affected interfaces. They do not authorize a repository-wide re-audit, model-efficacy claims from static counts, or test/build execution by QC. A failed review goes through the normal scoped fix and targeted re-review; unreviewed surfaces remain unreviewed.

#### Evidence calibration from the audit-distillation iteration

The iteration had one engine/CLI implementation plan and two documentation plans, **not three documentation-only plans**. All three reached plan QC after task approvals and required fixes; the following attribution keeps the layers distinct:

| Observable defect | Layer that found it | Reusable lesson |
|---|---|---|
| The coverage rewrite lost “skip findings already planned” and “mark superseded plans stale”; the `out_of_scope` row also omitted its no-evidence invariant. | Plan B tri-review, after L2 approval. | Review removed obligations and every status boundary against the whole contract, not merely the new table's presence. |
| §12 lost the explicit “Static evidence required … No evidence, no finding” bullet inside a preserve range. Descriptive evidence prose remained elsewhere. | Plan C tri-review; two seats found the deletion independently. | Proposition preservation requires a normative rule, not an unchanged heading or a nearby paraphrase. |
| §9f treated a missing/gitignored/bypassed lockfile as an unconditional finding while its new exclusion required a reachable trust/authority failure. | Plan C tri-review, after the task reviews. | Read new exclusions against pre-existing rules in the same owner, not only against adjacent added bullets. |
| Severity anchors allowed every explicit-control defeat to count as high, omitting “with substantial consequences” and colliding with medium. | **Plan C task-1 L2**, corrected before plan QC. | L2 contract review is useful and complementary; this is not evidence of a tri-only discovery or an L2 miss. |

Plan A's tri-only blockers were executable field-contract gaps (lone surrogates in typed paths and non-positive/non-safe evidence lines). They support the broader composition lesson, but are not examples of documentation-only defects.

The evidence supports retaining both layers, not claiming L2 never catches semantic drift, that each seat found every defect, or that three seats prove exhaustive coverage. The final targeted re-reviews accepted the fixes; this document does not reopen or re-run those reviews.

### A fix wave is not a closing argument

The seam round finds the defect, but closing it is a separate risk. In one two-plan iteration, every seam finding was eventually fixed — one needed **three** fix waves and another **two** — and each intermediate wave looked like a fix:

- **A fix report is a claim, not evidence.** One wave described a design (a `needsRead()` helper plus a microtask read) that was not in the commit. The re-reviewer caught it by reading the diff against the report, not by re-reading the report. Revalidation must diff the delta; a wave whose report and commit disagree is unverified regardless of its green tests.
- **The same defect can survive a locally correct fix.** A render path was fixed to re-read host facts, but the fix kept a freshness window and blessed a copied read on outcome-only state changes; the stale value still reached one render. Re-review must ask "does this cover the *other* paths into the same decision", not "does this code look right".
- **Ordering is the safety property.** A duplicate-create barrier existed but sat after a validation step that could downgrade an ambiguous outcome to a retryable failure. Nothing was wrong with either statement; the guard simply ran second. When a finding is "X can happen", check where the guard sits relative to every write that precedes it.
- **One value cannot express "either A or B".** Recording the attempted value of an owned label overwrote the record of the value that might still exist remotely, so the corrective write removed the wrong one. Represent uncertainty as the candidate set, and keep it until a confirmed write narrows it.

Practical consequence for dispatch: a fix wave gets `file:line` plus the failing sequence, the re-review is scoped to those findings *and* the delta, and the PM reads the diff rather than the report before accepting it. Three waves on one finding is not thrash — it is the cost of the defect class, and each wave was cheaper than shipping the duplicate-create path.

## Why This Matters

Composition defects are silent by construction: every slice's suite is green, every per-slice verdict is `Approve`, and no single artifact is wrong. The composite is the only place the contradiction exists, so without a merged-state round the plan QC gate starts from defects nobody has seen, and the defects that matter most — a protection bypass, an ownership guard with a key-shaped hole, a state machine that cannot reach a required transition — are exactly the ones a per-slice lens cannot reach. In the measured case, 8 of the 12 findings were Critical, i.e. the difference between "the plan looks done" and "the plan is safe". Related: `workflow-patterns/multi-agent-time-budgeting.md` (cross-plan gloss sweep over a shared SSOT file — the same "later plan invalidates an earlier surface" failure one level up); [provenance hygiene](provenance-hygiene-tracked-comments.md) covers the narrower local-reference leak class, and `skills/mstar-use-cli/references/plan-and-workflow.md` covers the current plan/workflow transport and store pinning. The conceptual vocabulary is root `CONCEPTS.md` under “Review seat layers (L1–L4)” and “Three-domain write model”; no new term is introduced.

## When to Apply

- A plan task is split into slices for capacity, and slices land as separate review tracks.
- Two or more tracks merge into one integration branch before plan QC or PM Acceptance consumes their evidence.
- A cutover arrives in halves: a new writer plus a new protection on that writer, a new state machine plus the lease/ownership rules around it, a producer's payload shape plus its consumer's parser.
- Any iteration where a later change to a shared SSOT file invalidates earlier per-plan surfaces (same family of defect, one layer up).
- An SDD documentation/policy plan changes preserved sections, introduces false-positive exclusions, or consumes a contract owned by another file or the control harness.

## Examples

- *Seam reviewed as one deliverable:* Task 1's merged engine diff (core + row verbs + switchover) reviewed against the frozen spec §B–§E as one contract, with the seam questions listed above as the stated scope.
- *Defects found only at the seam:* CAS/authority widening on the snapshot writer; legacy-key ownership hole spanning coordination, status and the register helpers; handoff/return lease pairing; prepare accepting a row that still carries a lease; a lease transfer that no-ops; row binding without a lease; an already-integrated proof blind to a force-moved HEAD; register validation and conflict-code drift; object-identity lock membership; a handoff-evidence key kept mandatory on one side only.
- *Ordering deviation recorded honestly:* tracks merged before per-plan QC so the composite could be reviewed; the deviation is recorded with its reason and with an explicit statement that it does not shorten the gates, instead of being left implicit.
