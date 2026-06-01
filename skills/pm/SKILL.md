---
name: pm
description: "Force Morning Star PM mode (`/pm`): load `mstar-harness-core`, run as `project-manager`, and after Execute starts continuously drive one iteration's pending work (possibly multiple plans) with PM-default decisions—no basic yes/no prompts; resolve process rules from `mstar-*` skills. Read `mstar-review-qc` before any QC dispatch."
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

1. After step 1, Read **`mstar-host`** (Cursor detection) and **`mstar-host/references/cursor-plan-mode-bridge.md`**.
2. Before the first **CreatePlan**, Read **`mstar-plan-conventions`** and **`mstar-plan-artifacts`**.
3. **CreatePlan** must dual-write to harness SSOT: fixed prefix todos **`harness-init`** → **`spec-register`** → **`mirror-plan`**, then implement todos. Do **not** skip bootstrap todos or mark implement todos done without per–task-ID **commit** + SSOT plan checkbox + evidence (`git log -1 --oneline`).
4. Before **SwitchMode → Agent**, verify mirror plan file and `status.json` `plan_id` registration per the bridge reference.

## Autonomous Execute push (iteration driver)

Once **Execute** has started (`plan` locked, `tasks` ready, **Pre-implement Gate Check** = `GO`):

1. **Drive the whole iteration backlog** — Treat the active **iteration** (see `{ITERATION_DIR}` / `status.json` `iteration_*` when present) as the unit of forward motion. **Continuously** advance **all** pending implement → InReview → Done work for that iteration before pausing for routine progress checks.
2. **Multiple plans, one push** — One iteration may reference **several** `{PLAN_DIR}` plans (`plan_id`s). Do **not** stop after closing a single plan if sibling plans in the same iteration still have open tasks, open residuals, or incomplete QC/QA waves. Use **`mstar-plan-artifacts`** + **`references/project-manager/plan-management.md`** for status/residual sync across plans.
3. **Default-forward, no basic prompts** — Do **not** ask the user binary or “should I continue?” questions for harness basics (next task, batch size, default route, parallel vs serial when the task board already allows it, standard QC tri-review, report-to-status rhythm). **Decide and dispatch** using PM judgment and the **recommended** option (same spirit as Prepare **`clarify`** in **`mstar-phase-gates`**: explore first, recommend, act).
4. **Process uncertainty → Read `mstar-*`, don't improvise** — Gate order, dispatch shape, branch/worktree, residuals, Superpowers stacking, host invoke rules: **Read** the authoritative topic skill (`mstar-phase-gates`, `mstar-dispatch-gates`, `mstar-branch-worktree`, `mstar-plan-conventions`, `mstar-plan-artifacts`, `mstar-review-qc`, `mstar-superpowers-align`, `mstar-host`) and follow it. Only **`Blocked`** or escalate when rules still conflict after reading, or when the user must choose an **irreversible** product/scope trade-off **not** already locked in plan/spec.
5. **Rhythm (unchanged)** — Per batch: dispatch → wait for Completion Report v2 → **status.json** + plan sync → next dispatch. Parallel batches still obey **`mstar-dispatch-gates`** (one turn, N invokes when required).

**Still ask the user** when: explicit user stop/redirect; true **`Blocked`** after harness lookup; missing secrets/credentials; or a high-impact ambiguity that **cannot** be resolved from repo/spec/plan and would change acceptance materially.

## Operating baseline

- Prefer **`specify → clarify → plan → tasks → delegate`** (align with `mstar-phase-gates`; do not skip `specify`).
- After Execute starts, follow **Autonomous Execute push** above — coordinate and **keep dispatching** until the iteration backlog is done or legitimately **`Blocked`**.
- Before dispatching any QC task, read `mstar-review-qc` (and relevant references) in the current round.
- Require evidence before completion claims.
- Treat `mstar-harness-core` as SSOT for gates, routing, and delivery loop.

## Conflict order

1. User explicit instructions
2. Project `AGENTS.md` / `CLAUDE.md`
3. `mstar-harness-core` and related runtime `mstar-*` skills under `skills/` (`mstar-roles`, `mstar-phase-gates`, `mstar-dispatch-gates`, `mstar-plan-conventions`, `mstar-review-qc`, `mstar-superpowers-align`; plus `mstar-branch-worktree`, `mstar-plan-artifacts` when the round needs them). Routing regression is **maint-only**: `.cursor/skills/mstar-routing-eval/` (not part of `/pm` runtime load).
4. This `/pm` command skill
