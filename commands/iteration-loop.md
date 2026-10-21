---
name: iteration-loop
description: "Run a whole iteration Phase 1→6 autonomously — code-first direction lock with a retained prototype, then execute → close → PR → merge-ready → post-merge close. Optional direction hint and scale S|M|L|XL; explicit autonomous opt-in, no grill-me, no routine confirmation."
agent: project-manager
input: "[direction] [scale]"
---

# Iteration Loop

The whole lifecycle with an **autonomous** direction lock: this command's explicit autonomous opt-in replaces the interactive direction dialogue. Sibling entries: `/iteration-start` locks interactively and `/iteration-drive` resumes a locked iteration. **Done = Phase 6 post-merge close.**

## Args

`/iteration-loop [direction] [scale]` — a trailing token exactly `S` / `M` / `L` / `XL` (case-insensitive) is `scale`, default `M`; the remaining text is `direction` (a lone scale token means an empty direction). Scale budgets the iteration's **business** plans only (`S` 1 / `M` 2–3 / `L` 3–4 / `XL` >4) — budget rules and what stays outside it → **`mstar-iteration/references/autonomous-direction-lock.md`** § Scale budget.

## Boot

`mstar-harness-core` → `mstar-roles` → `references/project-manager.md` → `mstar-iteration` (route map: **start** → `references/phase-1-prepare.md`) → **`mstar-iteration/references/command-shared-invariants.md`**.

## Execute

1. **Phase 1 — autonomous start** → execute **`mstar-iteration/references/phase-1-prepare.md`** §1.1–§1.6 with `Direction lock mode: autonomous` (ranking, branch resolve, prototype disposition → **`references/autonomous-direction-lock.md`**). Retain a prototype (HTML, Markdown or JSON) with format rationale and autonomous disposition; never fabricate user approval. **Do not read `skills/grill-me/SKILL.md`** for this entry.
   Host Plan-mode permissions still apply — use the active host bridge's supported resume. Print the §1.6 Phase 1 completion checklist: clear the pre-integration items before the §2.3 integration step and mark the integration item after the branch push; loop session todo `phase-1-autonomous-start` closes when the compass is locked and the integration branch is pushed.
2. **No credible candidate and no `direction`** → STOP and escalate; never invent a direction or default the branch policy.
3. **Phase 2→6** → continue through **`iteration-drive`** exactly (same route map, gates, phase headers and report). Continuous execution and STOP rules → **`mstar-iteration` §2.6** plus **`command-shared-invariants.md`**.

## Report

The Phase 6 close report: iteration id, locked direction and scale, plans completed, compound summary, PR link, merge-ready and post-merge close evidence.
