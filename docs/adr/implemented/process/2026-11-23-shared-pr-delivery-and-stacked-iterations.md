# ADR: Shared PR delivery references and stacked iteration delivery

Status: implemented — an iteration now delivers as a chain of layered pull requests, and both callers read the same PR-delivery and workflow-close procedure
Date: 2026-11-23

## Problem

An iteration delivered through one aggregate pull request opened after iteration close made three things worse at once. The close could not be verified against landed work, because the work was still in a branch no merge had proved. A single PR concentrated every review wave and CI run at the end, so a late failure invalidated the whole delivery and the coordinator had nothing merge-ready while work continued. And because close was the gate before the PR, a plan-level fix could only be exercised by reopening the delivery after the fact.

Splitting the prompt surface made a second problem visible: the iteration-only path named its stages after close by number, but the shared delivery line replaced those stages, while an independent development plan reached PR delivery and close with no stage number at all — two spellings of one procedure, drifting apart.

## Decision

An iteration is delivered as a stack of layered pull requests. A layer is a coherent, task-reviewed range landed on `branch.integration` by one integration merge and recorded as a named ref; for a stacked PR every head is a layer ref, never the integration branch itself. The first open layer targets `branch.target` after any merged prefix; each later open layer targets its live predecessor. `branch.integration` stays the single integration writer's target and is never a stacked layer's PR head. An iteration whose aggregate PR is already open continues on `branch.integration` under the rollout rule and is not converted. A final close-delta layer opens only when the close produces a nonempty delta.

Publication, the merge-ready loop (CI green, every review thread resolved or each one waived in writing by name, and the PR mergeable), the independent merge authorization under the recorded policy, and the post-merge closure are shared project-manager references. Merge-ready is a readiness milestone, not an authorization: under `owner-gated` the coordinator reaches merge-ready, presents the evidence and asks for the owner's written approval of that head. The iteration path extends those references with the stack rules; an independent development plan reads them without any stack. The post-merge procedure is named Workflow Close Out and carries no stage number.

Development does not wait for review. The main line keeps developing and opening layers while a PR tracker observes, triages and reports; the tracker never dispatches, merges, approves or waives. Merges happen in stack order, one layer at a time, each with its own authorization evidence bound to that head.

## Alternatives considered

**One aggregate PR per iteration.** It is simpler to operate and needs one authorization. It lost because it makes late failures total, keeps nothing merge-ready during execution, and leaves close unverifiable against merged work.

**Splitting only at plan boundaries.** It reuses an existing unit and would have needed no new concept. It lost because a plan is a review unit, not a mergeable increment: a plan can spend its whole life unmergeable, and several plans may share one file, so the stack would still wait on the widest plan.

**A second coordinator seat for PR tracking.** It would centralize PR duty. It lost because it duplicates authority the coordinator already holds and creates a second writer to reconcile; the supported shape is one coordinator plus read-only observation.

**Waiting for all external review before the next plan starts.** It is the safest reading of the review gate. It lost because it serializes development behind a bot's latency for no evidence gain: the gate is per PR head, and a later head re-opens review anyway.

**Keeping a single-PR mode switch.** It would let existing iterations finish unchanged. It lost because two delivery shapes in one prompt surface drift: the stage numbers and the merge-ready milestones would keep two meanings, and the retired-name guard cannot distinguish them. Existing aggregate-PR iterations finish under the rollout rule instead.

## Consequences

Each layer costs its own CI run and review wave, so an iteration with N layers pays roughly N times the review latency; the mitigation is that the layers open during execution and merge independently, so the latency overlaps the work instead of following it. A layered stack makes authorization bookkeeping heavier: an owner-gated approval names the PR, the head and the observed base, and a retarget with an unchanged head is covered only when the equivalent retarget was stated up front. The proof obligation moves to whole-chain proof: every required layer merge, including a nonempty close-delta layer, lands before that proof, and the proof admits Workflow Close Out — delivery completes only after that procedure finishes, not at the proof or at the last merge. The distinct completion predicates of a standalone development plan are unchanged and remain governed by their own record ([the standalone-development completion decision](../architecture/2026-09-17-standalone-development-completion.md)).

The engine still speaks the old vocabulary internally (`--phase 6`, the `PHASE6_*` codes, the `phase-4-pr-delivery` reference name) as read-only compatibility probes; the prompt surface names none of them as a stage. The follow-ups that close the gap are tracked as engine issues: an iteration close that needs no merge proof of its own, a phase gate that models a linear stage list, and a cleanup path that does not recognize layer branches.
