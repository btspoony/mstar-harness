---
name: iteration-drive
description: "Drive or resume the selected locked iteration: autonomous execute with layered PRs → iteration-close → whole-chain proof → Workflow Close Out. Takes no arguments."
agent: project-manager
input: "[no args]"
---

# Drive Iteration

Drive the selected iteration to completion with one primary coordinator. **Not Done until whole-chain proof and Workflow Close Out** — an iteration-close, an open layer PR, a merge-ready exit or a single merge is not delivery.

## Entry

Accepts no arguments: reject a nonempty invocation before boot and name the supported no-argument form instead of broadening its scope. A leaf executor that receives this command refuses it on role grounds (`mstar-dispatch-gates`) and never promotes itself to PM.

## Boot

`mstar-harness-core` → `mstar-roles` → `references/project-manager.md` → `mstar-iteration` → **`mstar-iteration/references/command-shared-invariants.md`** (the shared PM invariants for execute through close, assignment preflight, session todos, continuous-execution STOP list) → the current phase's detail reference only.

## Execute

Action route and transition gates → **`mstar-iteration`** `## Phase route map` / `## Phase transition gates`: execute, with layer publication, → iteration-close → whole-chain proof → Workflow Close Out in order, loading only the current action's detail and printing the headers its owning detail requires. Optional PR helper-skill discovery → **`mstar-iteration/references/pr-helper-discovery.md`** (non-`mstar-*` helpers stay out of the `mstar-*` load order). Continuous execution → **`mstar-iteration` §2.6**. On resume, an iteration whose aggregate PR (head `branch.integration`, never a layer ref) is already open finishes that PR under `mstar-iteration/references/pr-stack.md`「Rollout」: no layer refs are created. When every row is Done and the compass `PR stack` record shows a reviewed range that is not published, the resume loads the delivery-only recovery of `mstar-iteration/references/phase-2-worktree-lease.md` §2.0「Resume with every row Done」for that range: it starts no implementation and goes to iteration-close only once that range is published or its stop is resolved with the owner.

Merge is authorized by the compass `pr_merge_policy`, never by flow completeness: under `reviewed-auto` the delivery chain runs the local PR-level review loop for that PR and only a settled, posted `ship it` report whose `head` equals the current PR head authorizes that layer's merge; under `reviewed-bot` it starts no local loop and the attached review bot's newest review on the current head must reach its own gate (mstar-inspector: the `mstar-inspector review` check concludes `success`) with no blocking finding — a missing bot is a configuration failure, not a pass; under `owner-gated` that layer stops at merge-ready and waits for the human owner's (the operator, not this harness's coordinator seat) explicit written approval of the current PR head (one approval may name the ready prefix per `mstar-iteration/references/pr-stack.md`). A missing `pr_merge_policy` is a STOP back to Phase 1 — never infer a default. Independently of the policy, the unresolved conversation gate blocks any merge while review threads on the current head are unresolved: the block lifts only when every thread is resolved, or each one is waived in writing by name and two explicit confirmations follow (the list and head repeated between them) — a generic "merge it" is not a per-thread waiver, and a final `mstar pr merge-gate --pr <n> [--confirm <file>]` run after the head reconciliation re-verifies before the merge. Rules and every refusal recovery → `mstar-roles/references/project-manager/pr-delivery.md`「Merge authorization」/「Unresolved conversation gate」. A verified layer merge continues with the remaining chain; whole-chain proof and Workflow Close Out complete the iteration.

## Report

Iteration id, plans completed, compound summary, the chain's layer PRs and per-layer merge-ready evidence, the recorded `pr_merge_policy` and the merge-authorization evidence that satisfied `mstar-roles/references/project-manager/pr-delivery.md`「Merge authorization」, the「Unresolved conversation gate」thread enumeration and, when it found unresolved threads, its two confirmations, and Workflow Close Out evidence (workflow `completed` + `ended_at`, root unregister, projections consistent).
