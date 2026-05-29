---
name: mstar-host-cursor
description: Cursor host adapter for Morning Star harness. Use this skill whenever working in Cursor with `mstar-*` flows, especially when handling `/pm`, Cursor Plan mode (CreatePlan / SwitchMode dual-write to `.agents/`), Task-based parallel QC tri-review, host-specific clarify behavior (no `question` tool), or preventing recursive Task misuse inside implement sessions. Always load this after `mstar-harness-core` to align Cursor behavior with harness gates and routing.
---

# Morning Star × Cursor Host Adapter

This skill defines **entry points, load order, and host-specific behavior** for running Morning Star in **Cursor**.  
Process rules and gates remain authoritative in `mstar-*` skills; this file only explains Cursor-side adaptation.

## First Action: Load `mstar-harness-core`

At session start, the agent must **first** read `mstar-harness-core`, then load other `mstar-*` skills according to its index.

- After core, load topic skills **on demand** per `mstar-roles` (role file + hub matrix): e.g. `mstar-dispatch-gates`, `mstar-phase-gates`, `mstar-branch-worktree`, `mstar-plan-conventions`, `mstar-plan-artifacts`, `mstar-plan-artifacts`, `mstar-review-qc`, `mstar-coding-behavior`, `mstar-superpowers-align`. Do not read every topic skill by default.
- Routing-eval lives under `.cursor/skills/` for **Cursor maint** only (see `repo-maintenance.mdc`).
- Role prompts are centralized in `mstar-roles`; in Cursor, `/pm` routes the main agent to the `project-manager` role in `mstar-roles`.

## Default path (recommended)

Use this default sequence unless a project rule explicitly overrides it:

1. Read `mstar-harness-core`
2. Read current host adapter (`mstar-host-cursor`)
3. Load role via `mstar-roles`
4. Execute with evidence-first completion checks

## Cursor Plan mode × Harness dual-write (critical)

When Cursor **Plan mode** is active (CreatePlan / SwitchMode available), **CreatePlan is session UX only**; durable SSOT is **`{HARNESS_DIR}`** (default `.agents/`) — especially **`{PLAN_DIR}/<plan-id>-<name>.md`** and **`{HARNESS_DIR}/status.json`**.

**Before the first CreatePlan**, Read `mstar-plan-conventions` and `mstar-plan-artifacts` (and Prepare gates from `mstar-phase-gates` when not hotfix). Full procedure: **`references/cursor-plan-mode-bridge.md`**.

**CreatePlan todos — fixed prefix (complete before any implement todo):**

| Todo ID | Purpose |
|---------|---------|
| `harness-init` | Init `{HARNESS_DIR}`, `{PLAN_DIR}`, `reports/`, `archived/residuals/`, `status.json` |
| `spec-register` | Register `plan_id` in `status.json.plans[]` + spec stub if applicable |
| `mirror-plan` | Write SSOT main plan under `{PLAN_DIR}/` |

**Each implement todo** must embed: per–task-ID **git commit** on Working branch → SSOT plan checkbox `- [x]` → optional `status.json` sync → real `git log -1 --oneline` evidence. Do **not** mark implement todos done without commit when tracked files changed.

**Before SwitchMode → Agent**: mirror plan file exists; `status.json` lists `plan_id`; bootstrap todos done. **NEVER** use only the Cursor plan URI as **Plan Path**.

Enforcement also in `rules/mstar-cursor-plan-mode.mdc` when the plugin is active.

## Gotchas

- Cursor can parallelize QC via Task, but tri-review still requires identical `plan_id` and review scope fields across all three reviewers.
- Parallel QC does **not** imply different review cwd per reviewer.
- Task-based execution does **not** relax branch/worktree isolation requirements.
- Asking clarifying questions in Markdown is not equal to clarify completion; unresolved high-impact ambiguity is still `Blocked`.

## Cursor command simplification (`/pm`)

To reduce fragmented local command skills in Cursor, use this convention:

- **`/pm`**: Force the current session into Morning Star entry flow, load `mstar-harness-core` first, then load the `project-manager` role via `mstar-roles`.

Execution precedence:

1. User explicit instructions in this turn
2. Project-level `AGENTS.md` / `CLAUDE.md`
3. `mstar-harness-core` and related `mstar-*` skills
4. This `mstar-host` adapter

## Task Tool and Parallel Subagents (QC tri-review)

In Cursor, the main agent can use the **Task tool** to spawn subagents in parallel and implement the same **QC tri-review** structure used in OpenCode harness flows.

- **Prerequisite vs dispatch (same as OpenCode harness intent)**: one assistant message may run **`bash` / `read` / `glob`** only to pin `Review range`, merge-base, or cwd — **no** QC/dev Task dispatches for the batch in that message (unless `N = 1`). The **next** message that emits **any** Task for that batch must emit **all `N`** Tasks (**3** for tri-review) in **one** message. **Emit zero** Task dispatches until all `N` payloads are ready; **do not** send QC1 alone then QC2 after return.
- **Paste-only failure mode**: writing `## Assignment` in the main chat **without** issuing the matching **Task** calls means **dispatch did not happen**. **N** Assignments ⇒ **N** Task invocations in the dispatch turn (parallel QC ⇒ **3** Tasks in **one** assistant message when supported).
- Use `subagent_type`: `qc-specialist`, `qc-specialist-2`, `qc-specialist-3`, matching PM-issued **three independent Assignments**.
- Required alignment fields across all three QC Tasks: **`plan_id`**, **`Review cwd` / Worktree path**, **`Review range` / Diff basis`** must be text-identical (see `mstar-branch-worktree`, `mstar-dispatch-gates`, `mstar-review-qc`).
- If prior implementation used multiple worktrees in one repo: parallel QC solves reviewer concurrency only; it does **not** mean each reviewer should inspect a different dev worktree. Keep review fields identical, and review against one branch/HEAD that contains the full review scope. If multi-track commits are not integrated yet, integrate or split scope first.
- Cursor/OpenCode differences are host capability differences (tooling, clarify interaction, artifact/report conventions), not process downgrades.

PM may explicitly note in Status Update that QC tri-review was executed via parallel Task subagents for traceability.

## When to use single-session or multi-window modes (supplemental)

These modes can supplement or replace Task parallelism when needed (state chosen mode in Status Update).

### Mode A — Single session, multiple roles

In one conversation, the main agent can execute sequentially: PM plans and writes Assignment first, then switch execution role explicitly, for example:

- `Acting as role: fullstack-dev — executing Assignment …`
- Before execution, read the corresponding role reference from `mstar-roles` and follow that role’s outputs and gates strictly.

If QC/QA runs without Task subagents, load corresponding `qc-specialist*` / `qa-engineer` roles in rounds within the same session; field alignment requirements remain unchanged.

### Mode B — Multi-window / multi-session role execution

Put one Assignment into a new chat, paste the Assignment in the first turn, and require that agent to load the corresponding role via `mstar-roles`. Useful for long implementations and reducing single-session context pressure; PM consolidates evidence/status in the main thread.

### Mode C — Worktree and concurrent writes

Even with Task parallelism, follow **`mstar-branch-worktree`** and **`mstar-dispatch-gates`**: if **two or more writers** modify the same repo concurrently, use `git worktree` (or equivalent isolation) and explicit branch/path conventions in Assignment. Do not confuse parallel QC capability with shared writable cwd safety, and do not assign different review cwd values for tri-review by default.

### No recursive Task inside implement subagents (aligned with `Execute as`)

A subagent that received Assignment via Task **is already** the `Execute as` executor. It must not spawn the same dev role recursively in the same session. Keep `Execute as` as plain role id. If outer messages conflict with Assignment (`complete personally`, `Delegation: forbidden`), Assignment wins.

## Clarify interaction

- When no `question` tool is available, ask via structured Markdown (headings/options) or equivalent Cursor interaction.
- Do not treat “question asked” as “clarify done”: unresolved high-impact ambiguity must still result in `Blocked` or escalation.

## Superpowers and skills

If no built-in Skill invocation tool exists, follow `mstar-superpowers-align` guidance for “plugin not installed” and use `Read` to load upstream `SKILL.md` content before execution.

## Relationship with project rules

Project-level `AGENTS.md` / `CLAUDE.md` found upward from cwd take precedence over global harness defaults. If conflicts exist with Cursor-side rules, project rules and current user instructions win.

## Shared protocol: library documentation retrieval (Context7)

Context7 retrieval is a shared process rule maintained by `mstar-harness-core`.  
Follow: `mstar-harness-core` skill `references/library-docs-protocol.md`.
