---
name: iteration-drive
description: "Drive or resume the selected locked iteration through Phase 2→6 — autonomous execute → iteration-close → PR → merge-ready loop → post-merge close. Takes no arguments."
agent: project-manager
input: "[no args]"
---

# Drive Iteration

Drive the selected iteration to completion with one primary coordinator. **Not Done until Phase 6 post-merge close** — a Phase 3 close, an open PR or a merge-ready exit is not delivery.

## Entry

Accepts no arguments: reject a nonempty invocation before boot and name the supported no-argument form instead of broadening its scope. A leaf executor that receives this command refuses it on role grounds (`mstar-dispatch-gates`) and never promotes itself to PM.

## Boot

`mstar-harness-core` → `mstar-roles` → `references/project-manager.md` → `mstar-iteration` → **`mstar-iteration/references/command-shared-invariants.md`** (Phase 2–5 PM invariants, assignment preflight, session todos, continuous-execution STOP list) → the current phase's detail reference only.

## Execute

Phase route and transition gates → **`mstar-iteration`** `## Phase route map` / `## Phase transition gates`: run Phase 2 → 3 → 4 → 5 → 6 in order, loading only the current phase's detail and printing each `## Phase N` header at its boundary. Phase 5 optional helper-skill discovery → **`mstar-iteration/references/phase5-helper-discovery.md`** (non-`mstar-*` helpers stay out of the `mstar-*` load order). Continuous execution → **`mstar-iteration` §2.6**.

Merge is authorized by the compass `pr_merge_policy`, never by flow completeness: under `reviewed-auto` Phase 5 runs the PR-level review loop and only a settled, posted `ship it` report whose `head` equals the current PR head authorizes the merge; under `owner-gated` Phase 5 stops at merge-ready and waits for the owner's explicit written approval of the current PR head. A missing `pr_merge_policy` is a STOP back to Phase 1 — never infer a default. Rules and every refusal recovery → **`mstar-iteration`** §5.3. A verified merge immediately enters Phase 6.

## Report

Iteration id, plans completed, compound summary, PR link, merge-ready evidence, the recorded `pr_merge_policy` and the merge-authorization evidence that satisfied `mstar-iteration` §5.3, and post-merge close evidence (workflow `completed` + `ended_at`, root unregister, projections consistent).
