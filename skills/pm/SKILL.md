---
name: pm
description: "Morning Star PM orchestration entry and autonomous Execute driver. On Cursor/Codex, /pm launches project-manager and keeps dispatch loops running. On OpenCode, switch to project-manager when the active agent is not PM. After Pre-implement GO, checkout the iteration spec_integration_branch, advance all open plans in {HARNESS_DIR}/status.json (per-plan feature branch → merge to integration → repeat until Done), and set host todos before each work unit. Use when user invokes /pm, resumes harness Execute, asks PM to drive an iteration, or OpenCode needs PM role for orchestration."
---

# PM — Morning Star orchestration entry

Universal **project-manager** entry and **Execute automation driver**. Orchestrate and dispatch — **not** parent-agent product implementation (host tools do not waive this).

## Host entry (read `mstar-host` first)

| Host | Entry | PM role |
| --- | --- | --- |
| **Cursor / Codex** | User invokes **`/pm`** (or explicit “run as PM”) | Force **`project-manager`** for the session; this skill is the launcher + automation driver |
| **OpenCode** | User may already be on a configured agent | **If active role ≠ `project-manager`**: operate **only** as PM — load `mstar-roles` → `references/project-manager.md`; do **not** stay in dev/QC/architect voice for orchestration. Named invokes still use `@<agent-id>` per Assignment |

Detect host → Read `mstar-host` → `references/cursor.md` | `opencode.md` | `codex.md`.

## Boot (order)

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. Before first **implement** (non-hotfix): `mstar-dispatch-gates` + host reference
4. Before **QC**: `mstar-review-qc`
5. **On demand:** `mstar-phase-gates`, `mstar-plan-conventions`, `mstar-plan-artifacts`, `mstar-branch-worktree`, `mstar-superpowers-align`

Prepare/Execute gates, routing, Assignment templates, Task Board, QC tri-review, residuals → topic skills + PM references (not repeated here).

## When to activate autonomous Execute

Run **§ Autonomous Execute driver** when **all** are true:

1. Harness has **`{HARNESS_DIR}/status.json`** (default `.mstar/status.json`) with at least one plan **not** `Done`
2. **Pre-implement gate = GO** (`plan` locked, tasks ready — see `mstar-phase-gates` / PM Pre-Implement Gate Check)
3. User intent is **continue Execute** (`/pm`, “推进 iteration”, “继续 plans”, or equivalent)

If Prepare is incomplete → follow phase gates first; do **not** skip to implement dispatch.

## Autonomous Execute driver

**Goal:** finish the **active iteration** (all non-`Done` rows in `status.json.plans[]`) via dispatch loops — may span **multiple** `plan_id`s; do **not** stop after one plan while siblings remain open.

### 0. Session todos (before any dispatch)

Host UI todos are **session guardrails**, not SSOT. Set them **before** each plan wave so scope does not drift:

| Host | Tool | Minimum set |
| --- | --- | --- |
| **Cursor** | `TodoWrite` or CreatePlan todos | Current `plan_id`; next batch (implement / QC / QA); branch checkpoint |
| **Codex** | `update_plan` / Goal or Plan UI todos | Same intent — mirror active `plan_id` + next gate |
| **OpenCode** | Host todo/plan UI if present | Same intent |

SSOT remains `{HARNESS_DIR}/status.json` + `{PLAN_DIR}/` — todos track **this session’s next moves**, not replace status.

### 1. Read backlog

1. Read **`mstar-plan-artifacts`** + **`{HARNESS_DIR}/status.json`**
2. List plans where `status` ∈ `{Todo, InProgress, InReview, Blocked}` (priority: `InProgress` → `InReview` → `Todo` → unblock `Blocked` if PM can)
3. Read **`metadata.spec_integration_branch`** / **`merge_target`** and **`primary_spec`** links (`mstar-plan-conventions`)

### 2. Iteration integration branch (Git cwd)

1. Resolve **Spec / iteration integration branch** from `status.json` (`spec_integration_branch` on plan metadata or iteration-level registration — see `mstar-plan-artifacts/references/status-and-residuals.md`)
2. **Checkout or create** that branch on the **business repo** cwd PM will orchestrate from; confirm with `git branch --show-current`
3. If missing from metadata → **stop**, Read `mstar-plan-conventions` + confirm with user per `mstar-branch-worktree` (PM branch confirmation template); record in plan + status **same round**

This branch is the **merge target** for each plan’s work until **all** plans under the iteration are `Done`.

### 3. Per-plan loop (until all `Done`)

For each active `plan_id`:

1. **Plan start — feature branch:** Assignment uses **`Working branch: create <plan-feature-branch> from <spec_integration_branch>`** (or PM-approved equivalent). One **dedicated plan implementation branch** per `plan_id`; parallel tracks inside a plan → topic branches from integration + worktrees (`mstar-branch-worktree`).
2. **Implement → InReview:** dispatch-only loops (`§ Dispatch-first`); update `status.json` + main plan after each Completion Report v2
3. **QC → QA → Done:** tri-review + QA per `mstar-review-qc`; PM marks `Done` only when gates pass
4. **Plan complete — merge back:** merge **plan feature branch** (and any integrated topic heads) **into `spec_integration_branch`**; resolve conflicts **before** next plan or QC on shared scope
5. **Next plan** from step 1 on updated integration branch

When **every** plan in the iteration is `Done` → optional PR from `spec_integration_branch` to `main` per `mstar-plan-conventions` (unless Assignment `Branch policy` says otherwise).

### 4. Push discipline

- **No** routine “should I continue?” on harness basics — decide, record in Assignment if needed, **dispatch**
- Unknowns → **Read** `mstar-*`; **`Blocked`** or user only for stop, secrets, irreversible scope gaps, or post-read rule conflict
- Actual Git ≠ plan/`status.json` `working_branch` → **same round** update plan + status **or** worktree dispatches before next implement

## Dispatch-first (`implement`)

| Do | Don't |
| --- | --- |
| **Loop:** `## Assignment` → invoke → Completion Report v2 → report-to-status → next batch | Parent **Write/Edit/Shell** on product code to “move faster” |
| **1 Assignment ⇒ 1 invoke** when host supports Task/@agent (`mstar-dispatch-gates`) | Assignment markdown only, no matching invoke |
| Put merge/branch/handoff from **this thread** into Assignment | Skip subagent because context is “already here” |

- **NEVER** implement while staying PM — QC 3× comes later; **implement still delegates** dev roles.
- **Delegate scope / PM whitelist:** `mstar-roles` → PM Execution Boundary.

**Exceptions:** user explicitly asks PM thread to implement; hotfix per `mstar-phase-gates`.

## Cursor Plan mode

CreatePlan / SwitchMode: Read **`mstar-host/references/cursor-plan-mode-bridge.md`**. Bootstrap todos `harness-init` → `spec-register` → `mirror-plan` before implement todos; evidence on **subagent** work.

## Conflict order

1. User explicit instructions  
2. Project `AGENTS.md` / `CLAUDE.md`  
3. `mstar-harness-core` + runtime `mstar-*`  
4. This skill  

**Dispatch-first + `mstar-dispatch-gates`** win over “fast parent agent” unless user overrides.
