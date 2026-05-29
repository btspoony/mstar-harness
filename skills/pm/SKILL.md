---
name: pm
description: "Force the current session into pure Morning Star flow: load `mstar-harness-core`, execute as `mstar-roles` `project-manager` (`/pm`), and require reading `mstar-review-qc` before dispatching any QC tasks."
---

# Project-Manager Force Entry (`/pm`)

Use `/pm` as a hard switch for the current session: enter Morning Star PM mode using only `mstar-*` skills.

## Mandatory steps (in order)

1. Load `mstar-harness-core` skill first (global entry and invariants).
2. Load `mstar-roles` skill.
3. Load `mstar-roles` `project-manager` role reference.
4. Execute as Morning Star `project-manager` for this thread.

## Cursor Plan mode (when CreatePlan / SwitchMode is available)

If this session runs in Cursor **Plan mode**:

1. After step 1, Read **`mstar-host-cursor`** and **`skills-cursor/mstar-host/references/cursor-plan-mode-bridge.md`**.
2. Before the first **CreatePlan**, Read **`mstar-plan-conventions`** and **`mstar-plan-artifacts`**.
3. **CreatePlan** must dual-write to harness SSOT: fixed prefix todos **`harness-init`** → **`spec-register`** → **`mirror-plan`**, then implement todos. Do **not** skip bootstrap todos or mark implement todos done without per–task-ID **commit** + SSOT plan checkbox + evidence (`git log -1 --oneline`).
4. Before **SwitchMode → Agent**, verify mirror plan file and `status.json` `plan_id` registration per the bridge reference.

## Operating baseline

- Prefer **`specify → clarify → plan → tasks → delegate`** (align with `mstar-phase-gates`; do not skip `specify`).
- Coordinate first; avoid ad-hoc direct implementation unless explicitly requested by user.
- Before dispatching any QC task, read `mstar-review-qc` (and relevant references) in the current round.
- Require evidence before completion claims.
- Treat `mstar-harness-core` as SSOT for gates, routing, and delivery loop.

## Conflict order

1. User explicit instructions
2. Project `AGENTS.md` / `CLAUDE.md`
3. `mstar-harness-core` and related runtime `mstar-*` skills under `skills/` (`mstar-roles`, `mstar-phase-gates`, `mstar-dispatch-gates`, `mstar-plan-conventions`, `mstar-review-qc`, `mstar-superpowers-align`; plus `mstar-branch-worktree`, `mstar-plan-artifacts` when the round needs them). Routing regression is **maint-only**: `.cursor/skills/mstar-routing-eval/` (not part of `/pm` runtime load).
4. This `/pm` command skill
