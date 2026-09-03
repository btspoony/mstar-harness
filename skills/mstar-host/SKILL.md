---
name: mstar-host
description: Morning Star host adapter (OpenCode, Cursor, Codex, Kimi, ZCode, omp, dsh). Use after mstar-harness-core whenever host entry, clarify, dispatch, or plan UX differs by platform - OpenCode question/task-tool subagent invoke, Cursor /pm and CreatePlan/SwitchMode dual-write and Task parallel QC, Codex plugin skills plus Plan/Goal Mode, Kimi Agent/AgentSwarm with built-in subagent types only (coder/explore/plan) and role-in-prompt binding, ZCode Agent/AskUserQuestion/EnterPlanMode with registered role agents (bare role-id subagent_type, generic fallback) plus role-in-prompt binding, omp task/ask/hub preferring live-schema role agents (agents/*.md) with C5b skill-load binding (generic task/scout only as fallback), dsh (DeepSeek Harness) subagent tool with in-process engine gates and bundled mstar commands, sandboxed tools, and tool discovery. Auto-detect host from session tools; then Read references/<host>.md. Always load after mstar-harness-core.
---

# Morning Star Host Adapter

Host-specific **capabilities and entry behavior** for Morning Star. Process gates and invariants stay in `mstar-harness-core` and topic `mstar-*` skills.

## Load order

**本 skill 总是在 `mstar-harness-core` 之后加载**（先 Read `mstar-harness-core` SKILL.md；宿主注入项目 `AGENTS.md` 也不跳过，见下 `## First action`）。本 skill 只适配宿主入口 / 检测 / 计划 UX；状态机与门禁以 `mstar-harness-core` 为准。

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
| **`task`** tool with **`agent`** / **`tasks[]`** batch, **`ask`**, **`hub`** (omp also exposes `/goal`; goal rule is host-agnostic per below) | `omp` | `references/omp.md`; Plan mode also `references/omp-plan-mode-bridge.md` |
| **`subagent`** tool (dsh's model-facing delegation tool — `@deepseek-ai/dsh-tool-subagent` default `toolName`) | `dsh` | `references/dsh.md` |
| **`Agent`** / **`AskUserQuestion`** / **`EnterPlanMode`** + **`AgentSwarm`** (Kimi-only) | `kimi` | `references/kimi.md`; Plan mode also `references/kimi-plan-mode-bridge.md` |
| **`Agent`** / **`AskUserQuestion`** / **`EnterPlanMode`** / **`TodoWrite`**, **no `AgentSwarm`** | `zcode` | `references/zcode.md`; Plan mode also `references/zcode-plan-mode-bridge.md` |
| `/plan`, `/goal` slash commands; **Goal tools**; `functions.*` / `codex_app.*` tool namespaces; `tool_search`; Browser plugin tools | `codex` | `references/codex.md`; Plan mode also `references/_shared/plan-mode-bridge-core.md` |
| Still ambiguous | - | Read sections in **`cursor.md`**, **`opencode.md`**, **`codex.md`**, **`kimi.md`**, **`zcode.md`**, **`omp.md`**, and **`dsh.md`** that match tools you have; **`mstar-harness-core` wins** on conflict |

Order matters: check `cursor` → `opencode` → `omp` → `dsh` → `kimi` → `zcode` → `codex`. `subagent_type` (Cursor) vs `subagent` (OpenCode) vs `agent`/`tasks[]` (omp) is the sharpest split among the Task-based hosts; dsh's `subagent` tool collides with no other row, so it sits with the agent-tool hosts.

> **Engine check (when available):** run `mstar host detect --signals <comma-list>` (or `import { detectHost } from "@mstar-harness/engine"` in a host hook) to resolve the detection table above from session tool shapes (prints the host id, or `ambiguous` to fall back on the table + judgment). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Parallel dispatch (invoke-capable hosts)

When PM dispatches **N >= 2** concurrent assignees (QC tri-review, dual-track implement, etc.) and the host exposes actual invoke / Task / subagent tools, read **`references/parallel-dispatch.md`** in the dispatch round (shared with `mstar-dispatch-gates`). Without a callable invoke tool when dispatch is required → **`Blocked`**; Assignment Markdown alone is not dispatch.

## `/goal` directive (host-agnostic)

**Applicability is by capability, not host identity**: any host that exposes a `/goal` command (currently Codex Goal Mode and omp; other code agents may add it later) attaches a persistent objective to the thread. Rule — **always set the goal to running the complete flow to the end**, never a sub-stage:

- **Advancing an iteration**: set the goal to **complete the entire iteration flow** (`iteration-start → per-plan cycles → iteration-close → PR delivery → PR merge-ready loop`). Do not set a sub-stage goal (e.g. "finish Phase 1 only").
- **Advancing non-iteration work** (single plan / hotfix / one-off task): set the goal to **complete the entire per-plan flow** (`specify → clarify → plan → tasks → implement → plan QC tri + QA gate → Done`). Do not set a sub-stage goal (e.g. "write the plan" or "implement one task").

Goal text is a session-level objective only: `{HARNESS_DIR}` / `{PLAN_DIR}` / `status.json` remain SSOT, and goal completion is **not** harness Done. Mirror goal success criteria into the SSOT plan; when the goal changes, update goal text and the SSOT in the same round.

## Resolve loaded skill root

Docs name assets as skill **`<name>`** → `scripts/…` / `references/…`. **Resolve the loaded skill directory first** — do **not** open `skills/<name>/…` from a consumer app cwd (that layout exists in the harness source / plugin package only).

| Host | Prefer | Filesystem fallback (only if the host cannot load by name) |
|------|--------|--------------------------------------------------------------|
| **omp** | `skill://<name>` / `skill://<name>/<rel>` / `/skill:<name>` | Plugin package root `skills/<name>/` after install/link — not app cwd |
| **Cursor** | Skill **name** via plugin skills | Global `~/.cursor/plugins/local/morning-star-harness/skills/<name>/`; project `.cursor/plugins/morning-star-harness/skills/<name>/` |
| **Codex** | Skill **name** via plugin | Plugin-mounted `skills/<name>/`; project command skills under `.agents/skills/<name>/` |
| **OpenCode** | Skill **name** via `@mstar-harness/opencode` | Package-internal `harness-skills/<name>/` — never `process.cwd()/skills/` |
| **dsh** | Skill **name** via the mstar skill-local provider (`providerName: mstar`) | `$DSH_BUNDLED_SKILL_DIR/<name>[/<rel>]` — the packaged `harness-skills/` mirror mounted package-relative by `@mstar-harness/dsh`; never app cwd |
| **Kimi / ZCode** | Skill **name** / `/skill:<name>` | Plugin mount `./skills/<name>/` from the installed plugin root |

Authoring convention: **`mstar-skill-authoring`** § Skill-relative script and asset paths. Per-host URI / mount detail: `references/<host>.md`.

> **Engine check (when available):** run `mstar host skill-root --host <id> --skill <name>` (or import `resolveSkillRoot` from `@mstar-harness/engine` in a host hook) to resolve the loaded skill root per the table above. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Conflict order（Decision Rules）

1. User explicit instructions (this turn)
2. Project `AGENTS.md` / `CLAUDE.md`
3. `mstar-harness-core` and related `mstar-*` skills
4. This `mstar-host` skill and `references/*`

## Workflow

按 `## Default path` 执行：Read `mstar-harness-core` → 读本 skill 并按 `## Detect active host` 检测宿主（`cursor` → `opencode` → `omp` → `dsh` → `kimi` → `zcode` → `codex`）→ 读 `references/<host>.md`（计划模式另读对应 plan-mode bridge）→ 经 `mstar-roles` 加载角色 → 执行并以证据收尾。topic skill 按需加载，不默认通读。

## Evidence

正确结果 = 检测输出：`mstar host detect --signals <comma-list>` 打印 `host: <id>`（或 `ambiguous` → 按检测表 + 判断降级）；已加载的是**对应当前宿主工具形状**的 `references/<host>.md`。计划模式按宿主 plan-mode bridge 完成双写 / 对齐。

## References

- 各宿主适配细则 → `references/<host>.md`（cursor / opencode / omp / dsh / kimi / zcode / codex；计划模式另见 plan-mode bridge references）
- invoke-capable 宿主并行派发 → `references/parallel-dispatch.md`
- 角色加载与参数 → **`mstar-roles`**
