# ZCode Plan Mode × Harness Dual-Write Bridge

> **Load order**: Read **`mstar-harness-core`** first, then **`mstar-host`** and **`references/zcode.md`**, then **`references/_shared/plan-mode-bridge-core.md`** (shared contract) + this bridge. When Plan mode is active, also read **`mstar-conventions`** and **`mstar-artifacts`**. Path symbols `{HARNESS_DIR}`, `{PLAN_DIR}`, `{SPECS_DIR}` are defined in `mstar-conventions`. On conflict, **`mstar-harness-core`** wins.

**Shared contract** (dual-write SSOT rule + priority, bootstrap init, Build resume contract, bootstrap todos, implement done-gate, Phase 1 gate, shared anti-patterns) → **`references/_shared/plan-mode-bridge-core.md`**. This bridge covers ZCode plan-UX specifics only.

ZCode **Plan mode** (`EnterPlanMode` / `ExitPlanMode`) uses read-only exploration for design and a plan approval gate before implementation; the session todo list is a **session UX mirror** — **NEVER** cite only a session todo list path in Assignment **Plan Path**, **Context Loaded**, or Completion Report when `{PLAN_DIR}/<plan-id>-<name>.md` should exist.

## When this applies

- ZCode **Plan mode** is active (`EnterPlanMode` succeeded).
- Morning Star plugin is installed (`.zcode-plugin/plugin.json` skills loaded) or **`/morning-star-harness:pm`** / **`pm` skill** is in use.

## Plan mode workflow (dual-write)

| Step | ZCode session | Harness SSOT |
|------|---------------|--------------|
| Enter | `EnterPlanMode` — explore read-only | Ensure `{HARNESS_DIR}` exists; register the root `workflows[]` entry + snapshot plan row when known |
| Design | Draft plan content; surface via `ExitPlanMode` plan text | Mirror main plan to `{PLAN_DIR}/<plan-id>-<name>.md` with task checkboxes |
| Clarify | `AskUserQuestion` for blocking ambiguity only | Record decisions in plan / spec when durable |
| Exit | `ExitPlanMode` — user approves plan to implement | SSOT plan locked; snapshot plan row updated |
| Implement | Agent mode resumes | Per-task commits, Working branch, dispatch per `mstar-dispatch-gates` |

`TodoWrite` and ZCode UI todos are **session progress only** — sync meaningful state to SSOT plan checkboxes and the workflow snapshot (`{WORKFLOW_DIR}/<id>/snapshot.json` → `plans[]`) when coordination requires it.

## ExitPlanMode gate

Host plan approval (`ExitPlanMode`) is **not** Morning Star **Done** (gate → core). Implementation still follows phase gates, per-task commits, QC, and QA per the SSOT plan.

## `mstar-iteration` Phase 1

When iteration Phase 1 runs in Plan mode, the shared gate (single plan session, feedback-driven in-place edits, no Review & Edit / commit / integration branch until approval) → core. After approval: reload `mstar-harness-core` + **`zcode.md`**; resume as `project-manager` orchestration.

## Enforcement

Conflict with harness invariants → **`mstar-harness-core`** wins. Full Cursor CreatePlan bridge detail lives in `cursor-plan-mode-bridge.md` when hosts differ; ZCode uses this lighter Enter/Exit bridge only.
