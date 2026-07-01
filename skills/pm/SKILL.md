---
name: pm
description: "Morning Star PM orchestration entry. On Cursor/Codex, /pm launches project-manager. On OpenCode, switch to project-manager when the active agent is not PM. The autonomous Execute flow (per-plan dispatch, iteration management, compound) lives in mstar-iteration — this skill covers PM role identity, host entry, dispatch-first rules, and host-specific concerns."
---

# PM — Morning Star orchestration entry

**PM role launcher and host adapter.** Iteration flow (start → Execute → close) → **`mstar-iteration`** (canonical SSOT). This skill handles: PM role identity per host, boot order, dispatch-first rules, Cursor Plan mode.

## Host entry (read `mstar-host` first)

| Host | Entry | PM role |
| --- | --- | --- |
| **Cursor / Codex** | User invokes **`/pm`** (or explicit "run as PM") | Force **`project-manager`** for the session |
| **OpenCode** | User may already be on a configured agent | **If active role ≠ `project-manager`**: operate **only** as PM — load `mstar-roles` → `references/project-manager.md`; do **not** stay in dev/QC/architect voice for orchestration. Named invokes still use `@<agent-id>` per Assignment |

Detect host → Read `mstar-host` → `references/cursor.md` | `opencode.md` | `codex.md`.

## Boot (order)

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. Before first **implement** dispatch: `mstar-dispatch-gates` + host reference
4. Before **QC**: `mstar-review-qc`
5. **Iteration flow** (start / Execute / close): **`mstar-iteration`** — canonical SSOT for per-plan dispatch loop, integration branch, compound round. Do **not** re-describe the flow in this skill.
6. **On demand:** `mstar-phase-gates`, `mstar-plan-conventions`, `mstar-plan-artifacts`, `mstar-branch-worktree`, `mstar-execution-practices`, `mstar-skill-authoring` for skill work

Prepare/Execute gates, routing, Assignment templates, Task Board, QC tri-review, residuals, compound → topic skills + PM references (not repeated here).

## Dispatch-first (`implement`)

| Do | Don't |
| --- | --- |
| **Loop:** `## Assignment` → invoke → Completion Report v2 → report-to-status → next batch | Parent **Write/Edit/Shell** on product code to "move faster" |
| **1 Assignment ⇒ 1 invoke** when host supports Task/@agent (`mstar-dispatch-gates`) | Assignment markdown only, no matching invoke |
| Put merge/branch/handoff from **this thread** into Assignment | Skip subagent because context is "already here" |

- **NEVER** implement while staying PM — QC 3× comes later; **implement still delegates** dev roles.
- **Delegate scope / PM whitelist:** `mstar-roles` → PM Execution Boundary.

**Exceptions:** user explicitly asks PM thread to implement; hotfix per `mstar-phase-gates`.

## iteration-start dispatch

After grill-me + draft compass/plans（**`mstar-iteration` § Phase 1**）:

- **Do not** commit to `iteration/<iteration-id>` until Review & Edit chain completes（§1.6）。
- Dispatch **@product-manager**, **@architect**, **@writing-specialist** via host Task — **one invoke per role minimum**（parallel when independent）。
- PM final lock is PM-whitelist work（compass `status: locked`, merge conflicts, Prepare gate confirmation）。
- **Not** PM-whitelist: performing all three specialist document edits without subagent Task.

Before §6 Integration Branch, print **`iteration-start` pre-commit checklist**（command §5）; all items must be `[x]`。

## iteration-close（drive / 全部 plan Done 后）

**`mstar-iteration` § Phase 3** 为独立 Phase；final plan closure 只能作为输入。

- 全部 plan `Done` 后 **STOP** loop，打印 Phase 3 入场，从 §3.0 执行至 §3.5。
- §3.1 close entry checklist 与 §3.5 close exit checklist 必须在对话中打印；全部为 `[x]` 方可 commit / PR。
- 每篇新增 compound doc 必须完成 `mstar-compound` Phase 6（`{KNOWLEDGE_DIR}/README.md`）。
- compass 完成形式：frontmatter `status: completed` + `end_date` + `## Roadmap Position` current iteration `delivered`——prose completion status 不算。

## Cursor Plan mode

CreatePlan / SwitchMode: Read **`mstar-host/references/cursor-plan-mode-bridge.md`**. Bootstrap todos `harness-init` → `spec-register` → `mirror-plan` before implement todos; evidence on **subagent** work.

## Conflict order

1. User explicit instructions  
2. Project `AGENTS.md` / `CLAUDE.md`  
3. `mstar-harness-core` + runtime `mstar-*`  
4. This skill  

**Dispatch-first + `mstar-dispatch-gates`** win over "fast parent agent" unless user overrides.
