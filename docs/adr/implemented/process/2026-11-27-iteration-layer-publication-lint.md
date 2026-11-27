# ADR: Enforce per-plan layer publication with a compass lint rule, not a layer verb
Status: implemented — the rule ships with plan-complete and iteration-gate call sites
Date: 2026-11-27

## Problem

An iteration publishes one PR per accountable plan layer, during execution rather than after it: `skills/mstar-iteration/references/phase-2-worktree-lease.md` step 7 makes `Publish the layer` part of the per-plan loop, and `skills/mstar-iteration/references/pr-stack.md` admits an aggregate PR only for an iteration whose aggregate PR is already open.

Nothing enforced that. The only artifacts were the compass `## PR stack` table and the prose that pointed at it, so an execution could merge every plan into `branch.integration`, leave the table empty, and open a single aggregate PR once every plan was `Done`. The consequences were visible and repeatable: all review landed on one head, per-plan PR trackers never started, review stopped overlapping implementation, and the reviewer saw three plans as one unreviewed delta.

Making the fact authoritative instead — a `plan layer` verb writing a `RowCoordination.layers` record, a git check that the named ref exists at the named head, and a completion gate that reads it — would close the hole by adding a lifecycle state and a write path for a bookkeeping obligation. The project has already paid for that kind of defense: every new mandatory step becomes a place where an agent must be taught a new verb, and a place where a legitimate case (an empty integration range, an in-flight aggregate rollout) needs its own exemption branch.

## Decision

One lint rule, three call sites, no new state.

**The rule.** Every plan whose `## Plans` row says `Done` has a row in `## PR stack` whose `Accountable plan` cell names that plan. A compass without a `## PR stack` section counts as zero rows and violates only when a `Done` plan is therefore unrecorded; a compass without a `## Plans` table records no layer obligation. Nothing else is inspected: not PR reachability, not the `Readiness` vocabulary, not merge evidence, not layer order.

**The call sites.**

- `mstar plan complete` on the iteration manual-merge route checks the **earlier** `Done` plans only, never the plan being completed — its layer is published after `compound`, so a self-check would deadlock. A missing row refuses the completion with `coordination.layer-unpublished`, names the earlier plan, and prints the recovery: publish that layer, add the row, retry the same completion. An unset or unreadable `compass_ref` skips this check; the registration and compass checks own that failure.
- `mstar iteration gate` checks every `Done` plan in both the phase-2 and phase-3 windows. The finding rides the gate's existing entry checklist rather than a new gate: the phase-2 window reports it and stays `ok`, the phase-3 window refuses with the lint code. This covers the last plan of an iteration, which no later completion would force.
- `mstar lint <compass> --type iteration` exposes the same rule for a manual check; it is optional, not a gate.

**What stays out.** No new command, no database field, no git probe, no network call, no historical migration, and no CI job — the compass lives under the gitignored harness root, so CI has no target. The `compass_ref` a workflow already records locates the file; the completion path reads it from there.

## Alternatives considered

- **`plan layer` verb plus a `RowCoordination.layers` record.** It distinguishes a real PR from a written row. It lost because the truth it protects is proven later by merge authorization and whole-chain proof, while the new verb and record add a lifecycle state, a write path, a `--none` exemption branch, and a per-plan ceremony an agent must learn.
- **Prose only.** This was the state the decision replaced. It failed observably: a whole iteration executed every step of the loop and skipped step 7, because no artifact failed when it was skipped.
- **Gate `plan prepare` or the `Todo → InProgress` transition.** It would block the next plan's implementation, contradicting the rule that publication delays never delay independent implementation.
- **Lint only, never called from a write path.** An optional lint is skipped by exactly the agent that skipped the prose.
- **Keep aggregate PRs as the normal route.** It is admissible only for an iteration whose aggregate PR is already open, and reinterpreting a stack as an aggregate is explicitly refused.

## Consequences

- **Shipped behavior.** `mstar lint <compass> --type iteration` reports `lint.iteration.pr-stack-missing-row` for a `Done` plan with no `PR stack` row, and `lint.iteration.pr-stack-missing-section` when the section is absent and leaves a `Done` plan unrecorded. `mstar plan complete` refuses an earlier unpublished `Done` plan with `coordination.layer-unpublished`, naming it. `mstar iteration gate` reports the condition in the phase-2 window and refuses in the phase-3 window. A plan whose integration range is empty satisfies the rule with a `—` PR cell; the rule never demands a PR that cannot exist. Independent development plans and report-only workflows are unaffected, and the first plan of an iteration always passes because it has no earlier `Done` plan.
- **A row can be written without a real PR.** The check is a reminder, not a boundary. Delivery still rests on merge authorization and whole-chain proof; this record deliberately does not duplicate them.
- **The parser depends on the two table headers.** A reworded header fails as a missing section; the failure is visible and the recovery is restoring the header. An absent section is no exemption: an aggregate rollout records its PR once per `Done` plan, so the same PR number may repeat across rows.
- **The last plan is covered only by the gate.** An operator who skips `mstar iteration gate` and closes directly still bypasses the rule. If that proves to happen, terminal close can reuse the same function; adding it now would be a second gate for an unobserved gap.
