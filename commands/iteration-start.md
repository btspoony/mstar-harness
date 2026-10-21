---
name: iteration-start
description: "Start a new harness iteration — research, interactive direction lock, retained design prototype and confirmation, compass/plans, selected specialist Review & Edit, PM lock, integration branch — then auto-continue Phase 2→6 unless `pause` is given."
agent: project-manager
input: "[direction] [pause]"
---

# Start Iteration

Phase 1 of a new iteration. **Phase 1 is complete only when the current prototype design is approved, the selected Review & Edit roles have returned (writing-specialist last) and PM locks the package — not when the files are first written.**

## Args

`/iteration-start [direction] [pause]` — a token exactly `pause` (case-insensitive) stops after Phase 1 (lock + integration worktree) so `/iteration-drive` can resume later; the remaining tokens join into `direction`, a free-text hint that narrows the candidates and seeds `grill-me` **without** locking the direction. Without `pause`, auto-continue into Phase 2→6.

## Boot

`mstar-harness-core` → `mstar-roles` → `references/project-manager.md` → `mstar-iteration` (route map: **start** → `references/phase-1-prepare.md`) → `mstar-phase-gates` + `mstar-dispatch-gates` → `mstar-conventions` / `mstar-artifacts` → `mstar-host` → active host reference. A host Plan-mode session also loads that host's plan-mode bridge.

## Execute

1. **Plan-mode session?** Execute the active host reference's plan-mode bridge for `mstar-iteration` Phase 1 **instead of step 2**, then continue with steps 3–6. A session-plan carrier is UX, not a formal draft, and design approval is not Build authorization.
2. **Phase 1 (non-Plan path)** — execute **`mstar-iteration/references/phase-1-prepare.md`** §1.1–§1.6 end to end: research → 2–4 candidates → **interactive** direction lock through the bundled `skills/grill-me/SKILL.md` (seed it with `direction`; never auto-lock; never default the branch policy to `main`/`master`) → retained prototype approved at its current revision → formal compass/plans → workflow registration + coordinator seat → `direction-lock` host action → selected Review & Edit (product-manager → architect → writing-specialist last) → PM lock.
3. **Phase 1 completion checklist** — print the §1.6 checklist in full; clear its pre-integration items before step 5, then mark the integration item once the branch push in step 5 has happened.
4. **Assignment preflight** before every role invoke → **`mstar-iteration/references/command-shared-invariants.md`**.
5. **Integration branch** → **`mstar-iteration/references/phase-2-worktree-lease.md`** §2.3 checklist steps 1–7; branch anchors live in the compass frontmatter and the ACTIVE workflow, and the plan header records the actual `Main worktree branch`.
6. **Continue**: no `pause` → execute **`iteration-drive`** for Phase 2→6. With `pause` → stop here and say `/iteration-drive` resumes.

## Report

Iteration id, locked direction and branch policy, plan list, role selection (include/skip reasons with the actual returns) and Phase 1 lock evidence — or, with `pause`, the resume instruction.
