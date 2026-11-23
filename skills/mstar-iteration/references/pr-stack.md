# Iteration PR stack

> **Iterations only.** This reference extends `mstar-roles/references/project-manager/pr-delivery.md`, which keeps owning publish, push cadence, review paths and surfaces, merge-ready, merge authorization, head reconciliation and the unresolved conversation gate for every PR in the chain. A standalone development plan keeps that file's single-PR route and never enters this one, and a report-only workflow has no PR at all. **Read `mstar-harness-core` first.**

## Layer

- A layer is a coherent, task-reviewed integration range with exactly one accountable plan; not every commit is a layer, and a plan's last layer carries its tracked compound output. Per-plan integration/Done proof and compound are unchanged.
- Layer refs live in their own namespace, `iteration-stack/<iteration-id>/sNN`, never as a child of `branch.integration` — Git cannot hold a branch and a nested branch of the same name.

## Sizing

- Aim for about 300 changed lines per layer and measure a candidate with `mstar pr-review size --base <previous layer> --head <layer>`; do not publish a range where `adviseSplit` is true (more than 1,000 changed lines).
- Recover by splitting the unpublished range at a coherent reviewed boundary and measuring again; when one task cannot be split safely, revise the plan and its acceptance boundaries with the owner before publishing.
- Never absorb a base-versus-target delta silently: reconcile the anchors or scope the prerequisite work explicitly.

## Opening

- Push the layer ref first, then open the PR. The first open layer targets `branch.target` after any merged prefix, and every other PR targets its live predecessor.
- The PR body is `mstar-roles/references/project-manager/pr-description.md` plus the stack position: iteration id, layer order, predecessor PR, accountable plan.
- An open layer is review input, not completion: plan QC, PM Acceptance, row `Done` and compound are unchanged, and nothing merges before its accountable plan is Done.

## Tracking

- Start one PR tracker when a plan's first review-ready layer opens, and feed that plan's later PRs to the same tracker. It observes checks, triages review and returns actionable findings with evidence, and it has no nested dispatch, no workflow credentials, no writes to integration or chain records, no merge, no owner-approval collection and no waiver authority; fixes go through the owning implementer in an isolated fix checkout, with one pusher per PR head.
- Prefer a native background task where the host offers one; a terminal-agent carrier is optional and capability-gated, follows the shape of the existing optional-capability reference `mstar-pr-loop/references/terminal-agent-channel.md` without inheriting its authority, and is never a requirement. With no background carrier, the coordinator interleaves observations at the existing rescheduling checkpoints.
- The coordinator keeps dispatching every independent ready development item; only real dependencies and stack order serialize work. `mstar iteration push-cadence` is evaluated per PR.

## Landing

- Land bottom-up over the contiguous ready prefix: a plan-Done layer may land before the iteration ends, and every landed layer must be safe on `branch.target` by itself. Use merge commits; when the target rejects them, the landing stops until the owning project policy resolves the allowed method.
- `owner-gated` prefix approval: one written approval may name the current ready prefix — repo, each PR, exact head, observed base ref and SHA, intended target — and covers the expected promotion from predecessor to target only for an equivalent reviewed candidate. Before each merge, re-read the live tuple and the candidate: a changed head, an unexpected base transition or a non-equivalent candidate needs fresh evidence and authorization for that layer. Do not require the retargeted base SHA to equal the predecessor head — merge commits preserve ancestry, not SHA equality. The per-thread waiver and its two confirmations stay independent (`mstar-roles/references/project-manager/pr-delivery.md`「Unresolved conversation gate」).
- Verify the provider's auto-retarget or retarget the correct next PR when authorized; never continue on a wrong or unverifiable target.

## Propagation

- Fix the layer that owns the finding. At a named checkpoint the coordinator serializes the integration update, then each affected published upper layer has exactly one pusher that fast-forwards or merges its updated predecessor in an isolated checkout under that PR's push cadence. No rebase, force-push, branch replacement or moving an active task's base.
- Compare the live base and head and the actual check inputs, not the displayed diff alone: an unchanged upper head with the same displayed delta can produce a different merge candidate after the target moves (`git merge-tree --write-tree`). Refresh affected evidence, keeping only what its owning rule permits.

## Records

- The primary coordinator alone writes the compass `PR stack` table: order, accountable scope, repo and PR, branch refs, witnessed base and head, readiness and merge evidence.
- Resume a partly performed publication by reconciling the exact refs and the existing PR; never infer by title or newest PR.

## Whole-chain proof and close

- After iteration close, seal the expected list and the final accepted content, and open a final PR only for a nonempty close delta.
- Close needs evidence for every entry and proof that the final accepted content is on `branch.target`: the chain top is an ancestor of the target ref, plus per-PR merge evidence. An interrupted or partly merged iteration stays open and discloses its landed prefix, and the `delivered` projection waits for whole-chain proof.
- The engine verifies no iteration merge today (GitHub #819), so this proof is the coordinator's recorded duty.

## Cleanup

- The cleanup CLI does not own stack refs (GitHub #821). After terminal close, delete a local layer ref only when it is an ancestor of the target ref (`git branch -d`, never `-D`) and no open PR uses it; delete a remote ref only after the provider shows its PR merged; otherwise stop and report the residue.

## Rollout

- Never reinterpret an already-open aggregate PR as a stack.
