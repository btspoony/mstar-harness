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
| **OpenCode** | User may already be on a configured agent | **If active role ≠ `project-manager`**: operate **only** as PM — load `mstar-roles` → `references/project-manager.md`; do **not** stay in dev/QC/architect voice for orchestration. Host invoke: task tool **`subagent`** matching Assignment `Execute as` (see `mstar-host` → `opencode.md`); Assignment body uses **plain role ids** |

Detect host → Read `mstar-host` → `references/cursor.md` | `opencode.md` | `codex.md`.

## Boot (order)

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. Before first **implement** dispatch: `mstar-dispatch-gates` + host reference
4. Before **QC**: `mstar-review-qc`
5. **SDD implement** (`Execution mode: sdd`): `mstar-sdd` before first implement dispatch
6. **Iteration flow** (start / Execute / close): **`mstar-iteration`** — canonical SSOT for per-plan dispatch loop, integration branch, compound round. Do **not** re-describe the flow in this skill.
7. **On demand:** `mstar-phase-gates`, `mstar-plan-conventions`, `mstar-plan-artifacts`, `mstar-branch-worktree`, `mstar-skill-authoring` for skill work

Prepare/Execute gates, routing, Assignment templates, Task Board, QC (SDD → tri; inline → single), residuals, compound → topic skills + PM references (not repeated here).

## Dispatch-first (`implement`)

| Do | Don't |
| --- | --- |
| **Loop:** `## Assignment` → invoke → Completion Report v2 → report-to-status → next batch | Parent **Write/Edit/Shell** on product code to "move faster" |
| **1 Assignment ⇒ 1 invoke** when host supports Task/subagent (`mstar-dispatch-gates`) | Assignment markdown only, no matching invoke |
| Put merge/branch/handoff from **this thread** into Assignment | Skip subagent because context is "already here" |

- **NEVER** implement while staying PM — SDD ends with **plan QC tri** (N=3); **implement still delegates** dev + task reviewer subagents.
- **Delegate scope / PM whitelist:** `mstar-roles` → PM Execution Boundary.

**Exceptions:** user explicitly asks PM thread to implement; hotfix per `mstar-phase-gates`.

## Iteration

Formal iteration（Phase 1 → Phase 2 → Phase 3）→ **`mstar-iteration`** only. Do not duplicate phase gates, branch policy, or close checklists here.

## Cursor Plan mode

CreatePlan / SwitchMode: Read **`mstar-host/references/cursor-plan-mode-bridge.md`**. Bootstrap todos `harness-init` → `spec-register` → `mirror-plan` before implement todos; evidence on **subagent** work.

## Conflict order

1. User explicit instructions  
2. Project `AGENTS.md` / `CLAUDE.md`  
3. `mstar-harness-core` + runtime `mstar-*`  
4. This skill  

**Dispatch-first + `mstar-dispatch-gates`** win over "fast parent agent" unless user overrides.
