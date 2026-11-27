# ADR: Enforce per-plan layer publication with a compass lint rule, not a layer verb
Status: proposed — the rule and its two call sites are designed but not implemented
Date: 2026-11-27

## Problem

An iteration publishes one PR per accountable plan layer, during execution rather than after it: `skills/mstar-iteration/references/phase-2-worktree-lease.md` step 7 makes `Publish the layer` part of the per-plan loop, and `skills/mstar-iteration/references/pr-stack.md` admits an aggregate PR only for an iteration whose aggregate PR is already open.

Nothing enforces that. The only artifacts are the compass `## PR stack` table and the prose that points at it, so an execution can merge every plan into `branch.integration`, leave the table empty, and open a single aggregate PR once every plan is `Done`. The consequences are visible and repeatable: all review lands on one head, per-plan PR trackers never start, review stops overlapping implementation, and the reviewer sees three plans as one unreviewed delta.

A first proposal tried to make the fact authoritative: a `plan layer` verb writing a `RowCoordination.layers` record, a git check that the named ref exists at the named head, and a completion gate that reads it. That closes the hole by adding a lifecycle state and a write path for a bookkeeping obligation. The project has already paid for that kind of defense: every new mandatory step becomes a place where an agent must be taught a new verb, and a place where a legitimate case (an empty integration range, an in-flight aggregate rollout) needs its own exemption branch.

The decision this record captures is narrower: the publication obligation is a reminder, so express it once as a lint rule and hang it on actions the coordinator already performs.

## Proposal

One lint rule, two call sites, no new state.

**The rule.** Every plan whose `## Plans` row says `Done` has a row in `## PR stack` whose `Accountable plan` cell names that plan. Nothing else is inspected: not PR reachability, not the `Readiness` vocabulary, not merge evidence, not layer order.

**The call sites.**

- `mstar plan complete` on the iteration manual-merge route checks the **earlier** `Done` plans only, never the plan being completed — its layer is published after `compound`, so a self-check would deadlock. A missing row refuses the completion with `coordination.layer-unpublished`, names the earlier plan, and prints the recovery: publish that layer, add the row, retry the same completion.
- `mstar iteration gate` checks every `Done` plan in both the phase-2 and phase-3 windows. This covers the last plan of an iteration, which no later completion would force.
- `mstar lint <compass> --type iteration` exposes the same rule for a manual check; it is optional, not a gate.

**What stays out.** No new command, no database field, no git probe, no network call, no historical migration, and no CI job — the compass lives under the gitignored harness root, so CI has no target. The `compass_ref` a workflow already records locates the file; the completion path reads it from there.

## Alternatives considered

- **`plan layer` verb plus a `RowCoordination.layers` record.** It distinguishes a real PR from a written row. It lost because the truth it protects is proven later by merge authorization and whole-chain proof, while the new verb and record add a lifecycle state, a write path, a `--none` exemption branch, and a per-plan ceremony an agent must learn.
- **Prose only.** This is the current state. It failed observably: a whole iteration executed every step of the loop and skipped step 7, because no artifact failed when it was skipped.
- **Gate `plan prepare` or the `Todo → InProgress` transition.** It would block the next plan's implementation, contradicting the rule that publication delays never delay independent implementation.
- **Lint only, never called from a write path.** An optional lint is skipped by exactly the agent that skipped the prose.
- **Keep aggregate PRs as the normal route.** It is admissible only for an iteration whose aggregate PR is already open, and reinterpreting a stack as an aggregate is explicitly refused.

## Acceptance criteria

- `mstar lint <compass> --type iteration` reports a `Done` plan with no `PR stack` row, and passes when every `Done` plan has one.
- `mstar plan complete` refuses with `coordination.layer-unpublished` when an earlier `Done` plan lacks a row, and its recovery names the publish step, the row, and the retry.
- `mstar iteration gate` reports the same condition in the phase-2 and phase-3 windows.
- A plan whose integration range is empty satisfies the rule with a `—` PR cell; the rule never demands a PR that cannot exist.
- Independent development plans and report-only workflows are unaffected, and the first plan of an iteration always passes because it has no earlier `Done` plan.

## Risks

- **A row can be written without a real PR.** The check is a reminder, not a boundary. Delivery still rests on merge authorization and whole-chain proof; this record deliberately does not duplicate them.
- **The parser depends on the two table headers.** A reworded header fails as a missing section; the failure is visible and the recovery is restoring the header.
- **The last plan is covered only by the gate.** An operator who skips `mstar iteration gate` and closes directly still bypasses the rule. If that proves to happen, terminal close can reuse the same function; adding it now would be a second gate for an unobserved gap.
