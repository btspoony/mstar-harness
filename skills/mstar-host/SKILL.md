---
name: mstar-host
description: Morning Star host adapter (OpenCode, Cursor, Codex, Kimi). Use after mstar-harness-core whenever host entry, clarify, dispatch, or plan UX differs by platform - OpenCode question/task-tool subagent invoke, Cursor /pm and CreatePlan/SwitchMode dual-write and Task parallel QC, Codex plugin skills plus Plan/Goal Mode, Kimi Agent/AgentSwarm with built-in subagent types only (coder/explore/plan) and role-in-prompt binding, sandboxed tools, and tool discovery. Auto-detect host from session tools; then Read references/<host>.md. Always load after mstar-harness-core.
---

# Morning Star Host Adapter

Host-specific **capabilities and entry behavior** for Morning Star. Process gates and invariants stay in `mstar-harness-core` and topic `mstar-*` skills.

## First action

Read **`mstar-harness-core`** before this skill (even when the host injects project `AGENTS.md`).

## Default path

1. Read `mstar-harness-core`
2. Read **`mstar-host`** (this skill) and detect host below
3. Read **`references/<host>.md`** for the active host
4. Load role via `mstar-roles`
5. Execute with evidence-first completion checks

Load topic skills **on demand** per `mstar-roles` (do not read every `mstar-*` skill by default). Cursor routing-eval (`.cursor/skills/mstar-routing-eval/`) is regression tooling only — not part of runtime load order.

## Detect active host

Use **capability signals** (not filesystem paths):

| Signal | Host | Next read |
|--------|------|-----------|
| **CreatePlan** / **SwitchMode** available | `cursor` | `references/cursor.md`; Plan mode also `references/cursor-plan-mode-bridge.md` |
| **`question`** tool or **`task`** tool (**subagent** invoke) | `opencode` | `references/opencode.md` |
| **Task** + `subagent_type`, no CreatePlan | `cursor` | `references/cursor.md` |
| **Codex app/CLI/plugin context**, `/plan`, `/goal`, Goal tools, `functions.*`, `codex_app.*`, `tool_search`, Browser plugin tools | `codex` | `references/codex.md`; Plan/Goal mode also `references/codex-plan-goal-mode-bridge.md` |
| **`Agent`** / **`AgentSwarm`** / **`AskUserQuestion`** / **`EnterPlanMode`**, Kimi plugin (`.kimi-plugin/plugin.json`), `/morning-star-harness:*` commands | `kimi` | `references/kimi.md`; Plan mode also `references/kimi-plan-mode-bridge.md` |
| Still ambiguous | - | Read sections in **`cursor.md`**, **`opencode.md`**, **`codex.md`**, and **`kimi.md`** that match tools you have; **`mstar-harness-core` wins** on conflict |

## Parallel dispatch (invoke-capable hosts)

When PM dispatches **N >= 2** concurrent assignees (QC tri-review, dual-track implement, etc.) and the host exposes actual invoke / Task / subagent tools, read **`references/parallel-dispatch.md`** in the dispatch round (shared with `mstar-dispatch-gates`). Without a callable invoke tool when dispatch is required → **`Blocked`**; Assignment Markdown alone is not dispatch.

## Conflict order

1. User explicit instructions (this turn)
2. Project `AGENTS.md` / `CLAUDE.md`
3. `mstar-harness-core` and related `mstar-*` skills
4. This `mstar-host` skill and `references/*`
