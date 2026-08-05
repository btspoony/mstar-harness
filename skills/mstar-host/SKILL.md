---
name: mstar-host
description: Morning Star host adapter (OpenCode, Cursor, Codex, Kimi, ZCode, omp). Use after mstar-harness-core whenever host entry, clarify, dispatch, or plan UX differs by platform - OpenCode question/task-tool subagent invoke, Cursor /pm and CreatePlan/SwitchMode dual-write and Task parallel QC, Codex plugin skills plus Plan/Goal Mode, Kimi Agent/AgentSwarm with built-in subagent types only (coder/explore/plan) and role-in-prompt binding, ZCode Agent/AskUserQuestion/EnterPlanMode with built-in subagent types and role-in-prompt binding, omp task/ask/hub preferring live-schema role agents (agents/*.md) with C5b skill-load binding (generic task/scout only as fallback), sandboxed tools, and tool discovery. Auto-detect host from session tools; then Read references/<host>.md. Always load after mstar-harness-core.
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

Detect from **session tool shapes and available commands** — not from plugin markers on disk. The `*-plugin/plugin.json` files **cannot** identify the host: they all coexist in this harness source repo and in any multi-host install.

| Signal | Host | Next read |
|--------|------|-----------|
| **`subagent_type`** param on the Task tool (plus **CreatePlan**/**SwitchMode** when Plan mode is active) | `cursor` | `references/cursor.md`; Plan mode also `references/cursor-plan-mode-bridge.md` |
| **`question`** tool, or **`task`** tool with **`subagent`** (singular) — no `tasks[]` batch | `opencode` | `references/opencode.md` |
| **`task`** tool with **`agent`** / **`tasks[]`** batch, **`ask`**, **`hub`** | `omp` | `references/omp.md`; Plan mode also `references/omp-plan-mode-bridge.md` |
| **`Agent`** / **`AskUserQuestion`** / **`EnterPlanMode`** + **`AgentSwarm`** (Kimi-only) | `kimi` | `references/kimi.md`; Plan mode also `references/kimi-plan-mode-bridge.md` |
| **`Agent`** / **`AskUserQuestion`** / **`EnterPlanMode`** / **`TodoWrite`**, **no `AgentSwarm`** | `zcode` | `references/zcode.md`; Plan mode also `references/zcode-plan-mode-bridge.md` |
| `/plan`, `/goal` slash commands; **Goal tools**; `functions.*` / `codex_app.*` tool namespaces; `tool_search`; Browser plugin tools | `codex` | `references/codex.md`; Plan/Goal mode also `references/codex-plan-goal-mode-bridge.md` |
| Still ambiguous | - | Read sections in **`cursor.md`**, **`opencode.md`**, **`codex.md`**, **`kimi.md`**, **`zcode.md`**, and **`omp.md`** that match tools you have; **`mstar-harness-core` wins** on conflict |

Order matters: check `cursor` → `opencode` → `omp` → `kimi` → `zcode` → `codex`. `subagent_type` (Cursor) vs `subagent` (OpenCode) vs `agent`/`tasks[]` (omp) is the sharpest split among the Task-based hosts.

## Parallel dispatch (invoke-capable hosts)

When PM dispatches **N >= 2** concurrent assignees (QC tri-review, dual-track implement, etc.) and the host exposes actual invoke / Task / subagent tools, read **`references/parallel-dispatch.md`** in the dispatch round (shared with `mstar-dispatch-gates`). Without a callable invoke tool when dispatch is required → **`Blocked`**; Assignment Markdown alone is not dispatch.

## Resolve loaded skill root

Docs name assets as skill **`<name>`** → `scripts/…` / `references/…`. **Resolve the loaded skill directory first** — do **not** open `skills/<name>/…` from a consumer app cwd (that layout exists in the harness source / plugin package only).

| Host | Prefer | Filesystem fallback (only if the host cannot load by name) |
|------|--------|--------------------------------------------------------------|
| **omp** | `skill://<name>` / `skill://<name>/<rel>` / `/skill:<name>` | Plugin package root `skills/<name>/` after install/link — not app cwd |
| **Cursor** | Skill **name** via plugin skills | Global `~/.cursor/plugins/local/morning-star-harness/skills/<name>/`; project `.cursor/plugins/morning-star-harness/skills/<name>/` |
| **Codex** | Skill **name** via plugin | Plugin-mounted `skills/<name>/`; project command skills under `.agents/skills/<name>/` |
| **OpenCode** | Skill **name** via `@mstar-harness/opencode` | Package-internal `harness-skills/<name>/` — never `process.cwd()/skills/` |
| **Kimi / ZCode** | Skill **name** / `/skill:<name>` | Plugin mount `./skills/<name>/` from the installed plugin root |

Authoring convention: **`mstar-skill-authoring`** § Skill-relative script and asset paths. Per-host URI / mount detail: `references/<host>.md`.

## Conflict order

1. User explicit instructions (this turn)
2. Project `AGENTS.md` / `CLAUDE.md`
3. `mstar-harness-core` and related `mstar-*` skills
4. This `mstar-host` skill and `references/*`
