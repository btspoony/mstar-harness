# Codex Plan / Goal Mode x Harness Bridge

> **Load order**: Read **`mstar-harness-core`** first, then **`mstar-host`** and **`references/codex.md`**. When plan management is required, also read **`mstar-plan-conventions`** and **`mstar-plan-artifacts`** before creating or claiming any durable plan state. On conflict, **`mstar-harness-core`** wins.

## Purpose

Codex **Plan Mode** (`/plan`) and **Goal Mode** (`/goal`) are host collaboration surfaces:

- **Plan Mode** helps shape a plan inside the active Codex conversation.
- **Goal Mode** attaches a persistent objective and success criteria to the active thread.

Morning Star durable state still lives under **`{HARNESS_DIR}`** (default `.mstar/`, legacy `.agents/`). This reference prevents Codex session plans, UI todos, goal text, or goal completion from replacing the harness SSOT.

## Priority (hard)

1. User explicit instructions (this turn)
2. Project `AGENTS.md` / `CLAUDE.md`
3. **`{HARNESS_DIR}` / `{PLAN_DIR}` / `status.json`** (harness SSOT)
4. Codex Goal Mode objective / progress controls
5. Codex Plan Mode output, `update_plan`, UI todos, chat summaries

**NEVER** cite only a Codex goal, session plan, UI todo, or chat summary in Assignment **Plan Path**, **Context Loaded**, or Completion Report when `{PLAN_DIR}/<plan-id>-<name>.md` should exist.

## When this applies

- Codex Plan Mode is active (`/plan`, Plan collaboration mode, or host guidance says planning-only).
- Codex Goal Mode is active (`/goal`, host goal controls, or goal tools such as `create_goal`, `get_goal`, `update_goal`).
- Morning Star plugin or `/pm` is in use under Codex.

## Codex Plan Mode

Use Plan Mode to clarify, inspect, compare approaches, and draft the harness plan. Do **not** treat Plan Mode output as a durable artifact.

Before implementation or PM dispatch:

1. Discover `{HARNESS_DIR}` / `{PLAN_DIR}` per `mstar-plan-conventions`.
2. Ensure `{HARNESS_DIR}/status.json` exists or initialize it via `mstar-plan-artifacts` templates.
3. Register a `plans[]` row in `status.json` when a Morning Star plan is needed.
4. Write `{PLAN_DIR}/<plan-id>-<name>.md` with task checkboxes, branch policy, verification, and roadmap / deferred scope when applicable.
5. Use the SSOT plan path in Assignment and Completion Report evidence.

Allowed in Plan Mode: exploration, clarify questions, spec/plan drafting, `.mstar/` initialization, SSOT plan/status edits, PM routing decisions.

Not allowed by default in Plan Mode: product implementation, test implementation, QC execution, QA execution, deployment, or ops changes. Switch to normal execution or dispatch through an actual callable subagent/multi-agent tool first.

## Codex Goal Mode

Goal text is useful as the top-level objective and success criteria, but it is **not** a Morning Star plan, status ledger, PM Assignment, QC report, or QA Done authority.

When starting or receiving a Goal Mode objective:

1. If the goal is implementation-sized or long-running, create or update the harness SSOT (`status.json` + `{PLAN_DIR}` plan) before implementation.
2. Mirror the goal's success criteria into the SSOT plan as acceptance / verification criteria.
3. If the goal changes, update both Goal Mode text/progress and the SSOT plan/status in the same coordination round.
4. If the goal conflicts with the SSOT, pause or report **Blocked** until PM/user resolves scope.

### Goal completion gate

Only mark a Codex goal complete when all applicable harness gates are satisfied:

- Required plan checkboxes are complete in `{PLAN_DIR}`.
- `status.json` reflects the current lifecycle state.
- Required commits exist on the authorized branch.
- Verification evidence is recorded.
- QC/QA authority has passed when the plan requires InReview / Done gates.

If the host asks to complete a goal but harness Done authority is missing, report **Blocked** and list the missing artifacts or gate decisions. Do not call a goal-completion tool as a substitute for PM/QC/QA evidence.

## Resume / compaction

Codex can resume threads and compact context. On resume, before editing product code:

1. Reload `mstar-harness-core` -> `mstar-host` -> `references/codex.md` -> this bridge.
2. If Goal Mode is active, read the current goal and compare it with `{HARNESS_DIR}/status.json` and the active SSOT plan.
3. Treat `.mstar/` as durable truth over chat summaries or UI todos.
4. If the active role or Assignment is missing, resume as PM for coordination and dispatch only.

## `/pm` under Codex Plan / Goal Mode

When `/pm` runs under Plan or Goal Mode:

- `/pm` is still the force entry into Morning Star PM behavior.
- Prepare phase (`specify -> clarify -> plan`) still applies unless the task qualifies for a documented hotfix path.
- Goal Mode can hold the high-level objective, but PM must still write Assignment with `Execute as`, `Delegation`, branch policy, SSOT `Plan Path`, and evidence requirements.
- Without an actual callable subagent/multi-agent tool, Assignment Markdown is coordination text only; execute serially in-session or report Blocked for rerouting.

## Anti-patterns

| Anti-pattern | Fix |
|--------------|-----|
| `/plan` output only, no `{HARNESS_DIR}` files | Write SSOT plan + `status.json` entry before implementation |
| `update_plan` todo done, no commit/evidence | Commit or record required evidence before completion |
| Goal objective treated as Done authority | Check harness plan/status/QC/QA gates first |
| Goal changed but `.mstar/` still has old scope | Update Goal Mode and SSOT in the same round |
| Resume starts coding from chat summary | Reload harness context and SSOT plan/status first |
| Assignment Plan Path points at Codex transcript/goal | Use `{PLAN_DIR}/...` path |

## Related skills

- `mstar-plan-conventions` - discover `{HARNESS_DIR}`, `{PLAN_DIR}`, legacy layouts
- `mstar-plan-artifacts` - `status.json`, plan checkboxes, reports, residuals
- `mstar-phase-gates` - Prepare / Execute and Done authority
- `mstar-dispatch-gates` - Assignment, Delegation, anti-recursion
