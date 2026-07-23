# Kimi Plan Mode × Harness Dual-Write Bridge

> **Load order**: Read **`mstar-harness-core`** first, then **`mstar-plan-conventions`** and **`mstar-plan-artifacts`** when Plan mode is active. Path symbols `{HARNESS_DIR}`, `{PLAN_DIR}`, `{SPECS_DIR}` are defined in `mstar-plan-conventions`. On conflict, **`mstar-harness-core`** wins.

## Purpose

Kimi **Plan mode** (`EnterPlanMode` / `ExitPlanMode`, `/plan`, or `Shift-Tab`) uses a session plan file and read-only exploration for design. Morning Star **SSOT** lives on disk under **`{HARNESS_DIR}`** (default `.mstar/`, legacy `.agents/`). This reference defines **dual-write**: mirror durable plan artifacts to the repo; never treat the Kimi session plan file alone as the handoff surface.

## Priority (hard)

1. User explicit instructions (this turn)
2. Project `AGENTS.md` / `CLAUDE.md`
3. **`{HARNESS_DIR}` / `{PLAN_DIR}` / `status.json`** (harness SSOT)
4. Kimi plan file and `TodoList` UI (session UX mirror)

**NEVER** cite only a Kimi plan file path in Assignment **Plan Path**, **Context Loaded**, or Completion Report when `{PLAN_DIR}/<plan-id>-<name>.md` should exist.

## When this applies

- Kimi **Plan mode** is active (`EnterPlanMode` succeeded, `/plan on`, or `kimi --plan`).
- Morning Star plugin is installed (`.kimi-plugin/plugin.json` skills loaded) or **`/skill:pm`** / **`pm` skill** is in use.

## Before entering Plan mode

1. **Read** (minimum): `mstar-plan-conventions`, `mstar-plan-artifacts` (SKILL.md); Prepare gates from `mstar-phase-gates` if not hotfix.
2. **Discover** `{HARNESS_DIR}` / `{PLAN_DIR}` per `mstar-plan-conventions`.
3. **Initialize** if absent: `{HARNESS_DIR}/`, `{PLAN_DIR}/`, `status.json` from `mstar-plan-artifacts/templates/status.empty.json`, `archived/residuals/`, Morning Star process-artifact gitignore set (see `mstar-plan-conventions` SKILL.md「Git 跟踪策略」).

## Plan mode workflow (dual-write)

| Step | Kimi session | Harness SSOT |
|------|--------------|--------------|
| Enter | `EnterPlanMode` or `/plan on` — explore read-only | Ensure `{HARNESS_DIR}` exists; register `plan_id` in `status.json` when known |
| Design | Edit Kimi plan file with `Write` / `Edit` (when Plan mode allows writes) | Mirror main plan to `{PLAN_DIR}/<plan-id>-<name>.md` with task checkboxes |
| Clarify | `AskUserQuestion` for blocking ambiguity only | Record decisions in plan / spec when durable |
| Exit | `ExitPlanMode` — user approves plan to implement | SSOT plan locked; `status.json` row updated |
| Implement | Agent mode resumes | Per-task commits, Working branch, dispatch per `mstar-dispatch-gates` |

`TodoList` and Kimi UI todos are **session progress only** — sync meaningful state to SSOT plan checkboxes and `status.json` when coordination requires it.

## ExitPlanMode gate

Do **not** treat ExitPlanMode approval as Morning Star **Done**. Implementation still follows phase gates, per-task commits, QC, and QA per the SSOT plan.

## `mstar-iteration` Phase 1

When iteration Phase 1 runs in Plan mode:

- Use **one** plan session; iterate the **same** Kimi plan file and SSOT mirror in place (feedback-driven edits).
- Do **not** run Review & Edit, commit integration branch, or dispatch implementers until the user approves via `ExitPlanMode` (or explicit go-ahead after plan lock).
- After approval: reload `mstar-harness-core` + `kimi.md`; resume as `project-manager` orchestration.

## Enforcement

Conflict with harness invariants → **`mstar-harness-core`** wins. Full Cursor CreatePlan bridge detail lives in `cursor-plan-mode-bridge.md` when hosts differ; Kimi uses this lighter Enter/Exit bridge only.
