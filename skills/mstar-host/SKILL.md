---
name: mstar-host
description: Morning Star host adapter for OpenCode, Cursor, Codex, Kimi, ZCode, omp, and dsh. Use after mstar-harness-core whenever host entry, clarify, dispatch, plan mode, or tool UX differs by platform - per-host subagent invoke, plan-mode bridge, parallel dispatch, and skill/command loading. Auto-detect the host from session tools, then Read references/<host>.md. Always load after mstar-harness-core.
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

On **dsh** only, read-only fan-out of **N ≥ 3** seats runs through the native **`workflow`** tool instead of N `subagent` invokes (1–2 delegations keep `subagent`; writable fan-out never uses it) — scripts + operator path: `references/dsh.md` § Read-only fan-out via the `workflow` tool.

## `/goal` directive (host-agnostic)

**Applicability is by capability, not host identity**: any host that exposes a `/goal` command (currently Codex Goal Mode and omp; other code agents may add it later) attaches a persistent objective to the thread. **Exception — dsh:** mstar **stops arming** a goal there and never uses a `/goal` objective or a goal round loop as the progression driver — dsh runs on the native workflow (workflow snapshot phases + dispatch gates + **subagent settle notifications**; each settle notification is a **`result-settled` Rescheduling checkpoint** — run that checkpoint and dispatch the ready independent work before any wait, never "one settle → one dispatch", per `mstar-iteration` `references/phase-2-worktree-lease.md` §2.4; a manually armed `/goal` stays outside mstar's flow). Full rule → `references/dsh.md`. Rule — **always set the goal to running the complete flow to the end**, never a sub-stage:

- **Advancing an iteration**: set the goal to **complete the entire iteration flow** (`iteration-start → per-plan cycles → iteration-close → PR delivery → PR merge-ready loop`). Do not set a sub-stage goal (e.g. "finish Phase 1 only").
- **Advancing non-iteration work** (single plan / hotfix / one-off task): set the goal to **complete the entire per-plan flow** (`specify → clarify → plan → tasks → implement → plan QC tri + QA gate → Done`; standalone development plans continue through the delivery tail to verified merge + terminal close — `mstar-harness-core`「最小交付循环」/ `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`). Do not set a sub-stage goal (e.g. "write the plan" or "implement one task").
- **Scoped primary route** (`/iteration-drive --assignment | --workflow <id> --plan <id> | --resume <session.json>`): the goal is the **active plan scope only** — `mstar plan bind` → constrain → tasks → per-task review → plan QC tri / QA → `mstar plan handoff`. Never set a goal that spans the iteration flow, sibling plans, or Phase 3–6: those stay in the coordinator's own primary session, not this plan-scoped one (`mstar-iteration` `references/plan-scoped-pm.md` §5). `--resume` here is the **pre-activation** file form (it refuses on a harness whose execution authority is active); the read-only continuation of the session's own binding is `mstar plan bind --execution --resume-ref <wire>`, and a stopped owner is replaced only by the explicit recovery verb.

Goal text is a session-level objective only: `{HARNESS_DIR}` / `{PLAN_DIR}` / `status.json` remain SSOT, and goal completion is **not** harness Done. Mirror goal success criteria into the SSOT plan; when the goal changes, update goal text and the SSOT in the same round.

## Phase-transition todo refresh (host-agnostic)

At **every phase transition** (Prepare → Execute → InReview waves → Phase 3 close → Phase 4 PR → Phase 5 merge-ready → Phase 6 post-merge; likewise per-plan gate crossings), the PM refreshes the host session `todo` list **before the next action or dispatch**: close only the finished phase's **completed** entries, preserve any still-pending gate or future-phase item, and append the next phase's entries. Scoped primary sessions project only their assigned plan through handoff — never global Phase 3–6 tasks (`mstar-iteration` `references/command-shared-invariants.md` § Session todos; `references/phase-2-worktree-lease.md` §2.1).

`todo` entries are a projection, not SSOT: they reflect existing snapshot phase / plan states and named plan/gate evidence, and cannot authorize or invent a state transition. Snapshot and plan artifacts remain the state authorities; this is freshness discipline, not a new host hook anchor, tool, or deterministic enforcement mechanism.

## Host hooks (anchor contract)

Shared lifecycle skills name **host-agnostic anchors** — named moments at which the active host obliges the PM to run a host-defined coordinator action. The anchor vocabulary is frozen and carries no host identity: tool names, exact parameters, prerequisites, refusal codes, native settings and auto-trigger scope live **only** in `references/<host>.md`.

| Anchor | Moment |
|--------|--------|
| `direction-lock` | direction lock completed and the iteration identified — before the compass/plans draft is written; the workflow is not registered yet |
| `phase-1-lock` | Phase 1 completion — once the integration worktree exists, the reviewed changes are committed there and that branch is pushed (the PM lock alone is not the moment) |
| `phase-2-entry` | the Phase 2 execute/resume entry — after the §2.0 gates, before the per-plan loop; **not** the Phase-1-reused integration-worktree step |
| `rescheduling-checkpoint` | each `Rescheduling checkpoint` re-evaluation |

**Execution rule.** At each anchor the PM executes whatever the **active host reference** declares under its own `## Host hooks` section for that anchor. A host reference that declares nothing for an anchor means **no-op**: never invent an action, never substitute another host's declaration, and never treat an absent declaration as permission to skip the anchor's shared step.

**Marker form.** A shared file that owns an anchor carries a comment marker plus a one-line pointer — neither names a host or a tool:

```markdown
<!-- host-hook: <anchor> -->
> Execute the active host reference's `## Host hooks` declaration for `<anchor>`; this file defines no host action.
```

Carrier locations — the four markers in the shared corpus (all four live under `skills/`, never in `commands/`):

| File | Location | Anchor |
|------|----------|--------|
| `mstar-iteration/references/phase-1-prepare.md` | §1.2 tail, after the direction is locked and before `## 1.3` writes the compass/plans draft | `direction-lock` |
| `mstar-iteration/references/phase-2-worktree-lease.md` | §2.3 「Integration worktree (Phase 2 entry) + control root」 checklist tail, after step 7 (transfer + commit + push) — the Phase 1 route reaches it through `iteration-start` §6, which carries a pointer only | `phase-1-lock` |
| `mstar-iteration/references/phase-2-worktree-lease.md` | immediately before the `## 2.4 Per-plan loop` heading (the Phase 2 execute/resume entry; §2.3 is the Phase-1-reused step and triggers nothing) | `phase-2-entry` |
| `mstar-iteration/references/phase-2-worktree-lease.md` | `### Rescheduling checkpoint` | `rescheduling-checkpoint` (the five frozen reason names are handed off verbatim) |

**Prohibition (shared text — incremental rule).** **New or modified** shared-layer text — everything under `skills/**` except `skills/mstar-host/**`, plus `commands/**` — MUST NOT introduce a host name (`omp`, `oh-my-pi`, `dsh`, `OpenCode`, `Cursor`, `Codex`, `Kimi`, `ZCode`), a host tool/field name (`subagent`, `subagent_type`, `tasks[]`, `ask`, `hub`), a native settings key (`modelHandoff`, `phase2PlanInstances`, `maxPlanInstances`), or an extension file name. Capability phrasing ("when the host exposes an invoke tool") is the only permitted form for new text; host names belong to this skill and `references/<host>.md`.

**Enforcement surface.** The check applies to **the files a change touches**, never to the whole corpus: shared text that already violates the rule and is not part of the current change is **out of scope of the rule's enforcement** and is cleared in batches under the `host-seam-corpus-cleanup` goal of the store-authoritative `_default` project roadmap (read rule → `mstar-project-governance`; legacy `{PROJECT_DIR}/_default/roadmap.md` is transport/history only). Until that cleanup completes, a whole-tree grep over shared text is **not** a valid assertion for this rule — judge a change on the shared-layer text it adds or edits.

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
