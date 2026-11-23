---
name: iteration-drive
description: "Drive or resume the selected locked iteration through Phase 2→6 — autonomous execute → iteration-close → PR → merge-ready loop → post-merge close. Takes no arguments."
agent: project-manager
input: "[no args]"
---

# Drive Iteration

Drive the selected iteration to completion with one primary coordinator. **Not Done until Workflow Close Out** — a Phase 3 close, an open PR or a merge-ready exit is not delivery.

## Entry

Accepts no arguments: reject a nonempty invocation before boot and name the supported no-argument form instead of broadening its scope. A leaf executor that receives this command refuses it on role grounds (`mstar-dispatch-gates`) and never promotes itself to PM.

## Boot

`mstar-harness-core` → `mstar-roles` → `references/project-manager.md` → `mstar-iteration` → **`mstar-iteration/references/command-shared-invariants.md`** (Phase 2 through PR delivery PM invariants, assignment preflight, session todos, continuous-execution STOP list) → the current phase's detail reference only.

## Execute

Phase route and transition gates → **`mstar-iteration`** `## Phase route map` / `## Phase transition gates`: run Phase 2 → 3, then PR delivery → merge-ready → Workflow Close Out in order, loading only the current part's detail; Phase 2 and Phase 3 print their `## Phase N` header at their boundary, and the three responsibilities print the headers the shared references print (`## PR delivery`, `## Merge-ready checklist`, `## Workflow Close Out`) at their boundaries. Optional helper-skill discovery for the merge-ready loop → **`mstar-iteration/references/pr-helper-discovery.md`** (non-`mstar-*` helpers stay out of the `mstar-*` load order). Continuous execution → **`mstar-iteration` §2.6**.

Merge is authorized by the compass `pr_merge_policy`, never by flow completeness: under `reviewed-auto` the merge-ready loop runs the local PR-level review and only a settled, posted `ship it` report whose `head` equals the current PR head authorizes the merge; under `reviewed-bot` it starts no local loop and the attached review bot's newest review on the current head must reach its own gate (mstar-inspector: the `mstar-inspector review` check concludes `success`) with no blocking finding — a missing bot is a configuration failure, not a pass; under `owner-gated` it stops at merge-ready and waits for the human owner's (the operator, not this harness's coordinator seat) explicit written approval of the current PR head. A missing `pr_merge_policy` is a STOP back to Phase 1 — never infer a default. Independently of the policy, the unresolved conversation gate blocks any merge while review threads on the current head are unresolved: the block lifts only when every thread is resolved, or each one is waived in writing by name and two explicit confirmations follow (the list and head repeated between them) — a generic "merge it" is not a per-thread waiver, and a final `mstar pr merge-gate --pr <n> [--confirm <file>]` run after the head reconciliation re-verifies before the merge. Rules and every refusal recovery → `mstar-roles/references/project-manager/pr-delivery.md`「Merge authorization」/「Unresolved conversation gate」. A verified merge immediately enters Workflow Close Out.

## Report

Iteration id, plans completed, compound summary, PR link, merge-ready evidence, the recorded `pr_merge_policy` and the merge-authorization evidence that satisfied `mstar-roles/references/project-manager/pr-delivery.md`「Merge authorization」, the「Unresolved conversation gate」thread enumeration and, when it found unresolved threads, its two confirmations, and post-merge close evidence (workflow `completed` + `ended_at`, root unregister, projections consistent).
