---
name: pm
description: "Force Morning Star PM mode (`/pm`): load mstar-harness-core and project-manager; dispatch-only in Execute (Task per implement batch—no parent product code); continuous iteration push without basic yes/no prompts. Use when user invokes /pm or wants harness-only PM orchestration."
---

# `/pm` — Morning Star PM force entry

Hard switch: **`mstar-*` only**, execute as **`project-manager`**.

**One line:** `/pm` = **orchestrate and dispatch** — not parent-agent product implementation (full Cursor/Shell tools **do not** waive this).

## Boot (order)

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. Before first **implement** (non-hotfix): `mstar-dispatch-gates` + `mstar-host` (`references/cursor.md` | `opencode.md` | `codex.md`)
4. Before **QC**: `mstar-review-qc`
5. **On demand:** `mstar-phase-gates`, `mstar-plan-conventions`, `mstar-plan-artifacts`, `mstar-branch-worktree`, `mstar-superpowers-align`

Prepare/Execute gates, routing, Assignment templates, Task Board, QC tri-review, residuals → **topic skills + `project-manager` references** (not repeated here).

## `/pm`-only rules (SSOT for this entry)

Everything else defers to `mstar-harness-core` and the table above.

### 1. Dispatch-first (`implement`)

| Do | Don't |
| --- | --- |
| **Loop:** `## Assignment` → invoke → Completion Report v2 → report-to-status → next batch | Parent **Write/Edit/Shell** on product code to “move faster” |
| **1 Assignment ⇒ 1 invoke** in the dispatch message when host supports Task/@agent (`mstar-dispatch-gates`) | Assignment markdown only, no matching invoke |
| Put merge/branch/handoff from **this thread** into Assignment | Skip subagent because context is “already here” (cold start ≠ excuse) |

- **NEVER** implement while staying PM — including “not QC turn yet” (QC 3× is later; **implement still delegates** `fullstack-dev` / `frontend-dev` / …).
- **Delegate scope / PM whitelist:** `mstar-roles` → PM Execution Boundary.

### 2. Autonomous Execute push (after Pre-implement **GO**)

- Drive the **active iteration** to done via **dispatch loops** (may span **multiple** `plan_id`s — don’t stop after one plan if siblings are open).
- **No** routine “should I continue?” on harness basics — decide, record in Assignment if needed, **dispatch**.
- Process unknowns → **Read** `mstar-*`; **`Blocked`** or user only for stop, secrets, irreversible scope gaps, or post-read rule conflict (`mstar-phase-gates` clarify spirit).

### 3. Branch truth (no silent cwd)

Actual Git strategy ≠ plan/`status.json` `working_branch` → **same round** update plan + status **or** worktree dispatches (`mstar-branch-worktree`) before next implement dispatch.

**Exceptions:** user explicitly asks PM thread to implement; hotfix per `mstar-phase-gates` (still prefer invoke when available).

## Cursor Plan mode

If CreatePlan / SwitchMode: Read **`mstar-host/references/cursor-plan-mode-bridge.md`** (+ `mstar-plan-conventions`, `mstar-plan-artifacts` before first CreatePlan). Bootstrap todos `harness-init` → `spec-register` → `mirror-plan`; implement commits/evidence on **subagent** work, not PM parent edits alone.

## Conflict order

1. User explicit instructions  
2. Project `AGENTS.md` / `CLAUDE.md`  
3. `mstar-harness-core` + runtime `mstar-*` (routing-eval: maint-only `.cursor/skills/mstar-routing-eval/`)  
4. This skill  

**Dispatch-first + `mstar-dispatch-gates` win** over “fast parent agent” unless user overrides.
