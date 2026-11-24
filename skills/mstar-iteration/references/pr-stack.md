# Iteration PR stack

> **Iterations only.** This reference extends `mstar-roles/references/project-manager/pr-delivery.md`, which keeps owning publish, push cadence, review paths and surfaces, merge-ready, merge authorization, head reconciliation and the unresolved conversation gate for every PR in the chain. A standalone development plan keeps that file's single-PR route and never enters this one, and a report-only workflow has no PR at all. **Read `mstar-harness-core` first.**

## Layer

- A layer is a coherent, task-reviewed integration range with exactly one accountable plan; not every commit is a layer, and a plan's last layer carries its tracked compound output. Per-plan integration/Done proof and compound are unchanged. The accountable scope of a close layer is the iteration's corpus promotion: an oversized close delta is split by the plan that owns each corpus document, with that plan as the accountable scope, and the documents no plan owns form a last close layer whose accountable scope is the iteration close. The close step builds that split: one commit per owner group, each group its own layer ref (`phase-3-iteration-close.md` §3.5). The landing prerequisite follows the accountable scope: a plan-scoped layer's plan is `Done`; a close layer has the close commit it belongs to made and the iteration-close exit checklist passed.
- Layer refs live in their own namespace, `iteration-stack/<iteration-id>/sNN`, never as a child of `branch.integration` — Git cannot hold a branch and a nested branch of the same name.

## Sizing

- Aim for about 300 changed lines per layer and measure a candidate with `mstar pr-review size --base <previous layer> --head <layer>`; publication stops where `adviseSplit` is true (more than 1,000 changed lines) unless the owner's written size exception is recorded in that layer's pending `PR stack` row.
- An exception is asked for before publication. Otherwise split the unpublished range at a coherent reviewed boundary and measure again; when one task cannot be split safely and its plan is not yet `Done`, revise the plan and its acceptance boundaries with the owner first. An indivisible task of a `Done` plan is published as one layer under the exception.
- Never absorb a base-versus-target delta silently: reconcile the anchors or scope the prerequisite work explicitly.

## Opening

- Push the layer ref first, then open the PR. The first open layer targets `branch.target` after any merged prefix, every other PR targets its live predecessor, and `branch.integration` is never a stacked layer's PR head.
- The PR body is `mstar-roles/references/project-manager/pr-description.md` plus the stack position: iteration id, layer order, predecessor PR, accountable plan.
- An open layer is review input, not completion: plan QC, PM Acceptance, row `Done` and compound are unchanged, and nothing merges before its accountable scope's landing prerequisite (「Layer」) is met.

## Tracking

- Start one PR tracker when a plan's first review-ready layer opens, and feed that plan's later PRs to the same tracker. It observes checks, triages review and returns actionable findings with evidence, and it has no nested dispatch, no workflow credentials, no writes to integration or chain records, no merge, no owner-approval collection and no waiver authority; fixes go through the owning implementer in an isolated fix checkout, with one pusher per PR head. Two results come back. **Settled**: per PR, the readiness evidence — head, checks, review verdict and every finding at its merge class. **Blocked**: the specific blocker and its recovery. The coordinator takes over at its next checkpoint: a carrier failure (the tracker is gone or cannot observe) means the coordinator observes those PRs itself and grants the tracker nothing; a real dependency or an owner decision goes to its owner or becomes a recorded issue and never stops independent work.
- Prefer a native background task where the host offers one; a terminal-agent carrier is optional and capability-gated, follows the shape of the existing optional-capability reference `mstar-pr-loop/references/terminal-agent-channel.md` without inheriting its authority, and is never a requirement. With no background carrier, the coordinator interleaves observations at the existing rescheduling checkpoints.
- The coordinator keeps dispatching every independent ready development item; only real dependencies and stack order serialize work. `mstar iteration push-cadence` is evaluated per PR.

## Landing

- Land bottom-up over the contiguous ready prefix: a layer whose landing prerequisite (「Layer」) is met may land before the iteration ends, and every landed layer must be safe on `branch.target` by itself. Use merge commits; when the target rejects them, the landing stops until the owning project policy resolves the allowed method.
- Policy-neutral, before any layer merge: a changed head, an unexpected base transition or a non-equivalent candidate makes that PR's existing review, CI and authorization evidence stale for it, and the merge is refused until the evidence its policy requires is produced again on the current head and candidate.
- `owner-gated` prefix approval: one written approval may name the current ready prefix — repo, each PR, exact head, observed base ref and SHA, intended target — and covers the expected promotion from predecessor to target only for an equivalent reviewed candidate. Before each merge, re-read the live tuple and the candidate: a changed head, an unexpected base transition or a non-equivalent candidate needs fresh evidence and authorization for that layer. Do not require the retargeted base SHA to equal the predecessor head — merge commits preserve ancestry, not SHA equality. The per-thread waiver and its two confirmations stay independent (`mstar-roles/references/project-manager/pr-delivery.md`「Unresolved conversation gate」).
- Verify the provider's auto-retarget or retarget the correct next PR when authorized; never continue on a wrong or unverifiable target.

## Propagation

- Fix the layer that owns the finding. At a named checkpoint the coordinator serializes the integration update, then each affected published upper layer has exactly one pusher that fast-forwards or merges its updated predecessor in an isolated checkout under that PR's push cadence. No rebase, force-push, branch replacement or moving an active task's base.
- Compare the live base and head and the actual check inputs, not the displayed diff alone: an unchanged upper head with the same displayed delta can produce a different merge candidate after the target moves (`git merge-tree --write-tree`). Refresh affected evidence, keeping only what its owning rule permits.

## Records

- The primary coordinator alone writes the compass `PR stack` table: order, accountable scope, repo and PR, branch refs, witnessed base and head, readiness and merge evidence. It creates the row when it creates the layer ref, before any push — marked pending, with the head it measured and, when used, the owner's written size exception — and completes it with the PR number, base and head after the PR opens.
- Resume a partly performed publication by reconciling the exact refs and the existing PR; never infer by title or newest PR.

## Whole-chain proof and close

- After iteration close, seal the expected list and the final accepted content, and open a final PR only for a nonempty close delta; that layer runs `mstar-roles/references/project-manager/pr-delivery.md`「Publish the PR」,「Merge-ready checklist」and「Merge authorization」, then lands here (「Landing」) until the whole chain is merged.
- Proof: every entry carries its evidence and the sealed final accepted chain is the expectation — the chain top is an ancestor of the target ref, plus per-PR merge evidence. Compare the current `branch.target` with that final accepted chain over the affected paths: a difference that removes content the final accepted chain still requires is loss — a target-side revert — so the chain is not proved and the lost change is landed again as a new layer before close; a replacement made by an accepted later layer is already part of the final accepted chain and is not loss.
- A proof that stops on a partly merged chain returns to「Landing」for the layers still open, discloses the landed prefix and enters no close-out.
- Proof ends when this evidence is recorded in the compass `PR stack` table. The delivery projection — the compass `delivered` marker with its `## Roadmap Position` row, the roadmap row and the milestone rollup — is written by Workflow Close Out's Projection reconciliation, because whole-chain proof is recorded, through the existing `mstar-project-governance` operations; until then the roadmap row stays at its pre-delivery state.
- The engine verifies no iteration merge today (GitHub #819), so this proof is the coordinator's recorded duty.

## Cleanup

- The cleanup CLI does not own stack refs (GitHub #821). Stack refs are cleaned only after terminal close: before deleting any layer ref, local or remote, reconcile the actual ref and its head exactly with the ref and head witnessed in the compass `PR stack` table — a moved ref no longer matches and is not deleted — and confirm no open PR uses it as base or head. A local ref is deleted only as an ancestor of the target ref (`git branch -d`, never `-D`); a remote ref only after its PR shows merged. Any condition that fails stops the deletion and reports the residue; no force.

## Rollout

- An iteration whose aggregate PR — head `branch.integration`, never a layer ref — is already open finishes under the contract that opened it: that one PR runs `mstar-roles/references/project-manager/pr-delivery.md` merge-ready, authorization and merge, no layer refs and no new aggregate PR are created, and its whole-chain proof is that PR merged with its content on `branch.target`; never reinterpret it as a stack. Its head is `branch.integration`, so the layer-ref precondition and the stack candidate check do not apply.
- Its fix boundary: a fix is made in a fix feature worktree off `branch.integration`, reviewed, then merged serially by the coordinator in the integration worktree and pushed under the push cadence; conflict repair happens on that branch in the integration worktree, and when the shared merge-ready loop delegates to `mstar-pr-loop`, that loop's iteration fix site takes this form for this PR. Authorization predicates and the thread gate apply unchanged.
