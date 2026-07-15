# Cursor host reference

Load when **`mstar-host`** detection resolves **cursor** (CreatePlan / SwitchMode, Task + `subagent_type`, or Cursor `/pm` flow).

Parallel PM dispatch: **`parallel-dispatch.md`** (Task tool uses same turn model).

## Cursor-only context

- Role prompts: `mstar-roles`; **`/pm`** or **`pm` skill** → general PM orchestration (per-plan dispatch, gates, QC) without an iteration command. Host **`commands/`** for formal iteration Phase 1–5 (semantics → **`mstar-iteration`**).
- Routing-eval: `.cursor/skills/mstar-routing-eval/` — regression tooling only; not runtime load order.

## Plan mode × harness dual-write

When **Plan mode** is active, **CreatePlan is session UX**; SSOT is **`{HARNESS_DIR}`** (default `.mstar/`, legacy `.agents/`) — `{PLAN_DIR}/<plan-id>-<name>.md`, `{HARNESS_DIR}/status.json`.

Before first **CreatePlan**: Read `mstar-plan-conventions`, `mstar-plan-artifacts`, Prepare gates from `mstar-phase-gates` when not hotfix. Full procedure: **`cursor-plan-mode-bridge.md`**.

**Bootstrap CreatePlan todos (prefix, before implement):**

| Todo ID | Purpose |
|---------|---------|
| `harness-init` | Init `{HARNESS_DIR}`, `{PLAN_DIR}`, `sdd/` gitignore, `archived/residuals/`, `status.json` |
| `spec-register` | Register `plan_id` in `status.json.plans[]` + spec stub if applicable |
| `mirror-plan` | Write SSOT main plan under `{PLAN_DIR}/` |

Each **implement todo**: per–task-ID **git commit** on Working branch → SSOT `- [x]` → optional `status.json` sync → `git log -1 --oneline` evidence.

Before **SwitchMode → Agent**: mirror plan exists; `status.json` lists `plan_id`; bootstrap todos done. **Never** use only the Cursor plan URI as **Plan Path**.

After **Build**: treat the run as plan resume, not `/pm` replay. Reload `mstar-harness-core` + this Cursor reference, resume Morning Star plans as `project-manager` orchestration, and dispatch implementation through Task unless the user explicitly overrides the harness.

**`mstar-iteration` Phase 1 in Plan mode**: CreatePlan **once** (blank scaffold); then **feedback-driven** in-place updates on that same plan file; deferred interview only after user signals feedback-close **and** gaps remain; **do not** run Review & Edit / commit / integration branch until **Build**. Detail → **`cursor-plan-mode-bridge.md`** § `mstar-iteration` Phase 1 in Plan mode.

Enforcement: `rules/mstar-cursor-plan-mode.mdc` when plugin active.

## `/pm` precedence

1. User explicit instructions
2. Project `AGENTS.md` / `CLAUDE.md`
3. `mstar-harness-core` and `mstar-*` skills
4. `mstar-host` + this reference

## Task tool (QC: SDD → N=3)

- **`Execution mode: sdd`**: **N=3** Tasks (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`) + branch review-package path.
- **`inline`**: **N=1** per `parallel-dispatch.md`.
- SDD implement/reviewer: **serial** — see **`mstar-sdd`**.

## SDD sticky implementer (Cursor Task resume)

When Assignment has **`SDD implementer session: sticky`** (`mstar-sdd/references/sticky-implementer-session.md`):

| Turn | Task tool |
|------|-----------|
| **First task** (or after `fresh` reset) | `subagent_type: <Execute as>` + `implementer-prompt.md` body; capture returned **agent id** → `{SDD_DIR}/implementer-session.json` → `host_agent_id` |
| **Task 2+** | `resume: <host_agent_id>` + `implementer-continuation-prompt.md` body (new brief path + report path only) |

**Rules:**

- **1 implement dispatch ⇒ 1 Task** per task id (resume counts as the implement dispatch for that task).
- **Task reviewer**: always **new** Task — **no** `resume` for reviewers.
- After each task reviewer passes, PM updates `progress.md` and `implementer-session.json` `last_task`.
- If `resume` fails or agent id missing → reset to **`fresh`** for that task; log reason in Status Update.

## Dispatch execution（canonical）

Cursor PM dispatch = **`Task`** with `subagent_type` matching the Assignment `Execute as` role.

- **1 Assignment ⇒ 1 Task**; parallel batches ⇒ **N Tasks in one message** (`parallel-dispatch.md`, `mstar-dispatch-gates`).
- Assignment Markdown **does not** start work. PM thread **must not** implement, review, or edit specialist deliverables by loading another role reference in the same session (`Acting as role: …` is **not** dispatch).
- No callable `Task` / subagent for required work → **`Blocked`** — report to user; do not substitute in-thread execution.
- **Only exception:** user explicitly overrides harness dispatch for this turn (document the override).
- Concurrent writers / QC cwd alignment → **`mstar-branch-worktree`** (not a separate “mode”).
- Implement subagents: recipient is already `Execute as`; **no** recursive Task with same `subagent_type`. Assignment wins (`Delegation: forbidden` unless stated).

## Clarify

- No `question` tool: structured Markdown or Cursor UI.
- “Question asked” ≠ clarify done; high-impact ambiguity → `Blocked` or escalation.

## Execution Discipline

Implementation roles use `mstar-coding-behavior` for RCA, test-first checks, review feedback, and completion evidence. Plan checkpoints remain in `mstar-phase-gates`; external skill plugins are not required.

## Gotchas

- Single-seat and tri-review need identical `plan_id` and review scope fields.
- Task parallelism does not relax branch/worktree isolation.

## Model tier (SDD + QC)

Map Assignment **`Model tier`** to Task `model` (host-specific slugs):

| Tier | Typical use |
|------|-------------|
| `fast` | Transcription tasks; 1–2 file mechanical edits |
| `standard` | SDD prose implementer; task reviewer floor; plan QC tri seats |
| `capable` | Large branch QC diff; integration judgment |

**Turn count beats token price** — reviewers and prose implementers use `standard` floor minimum. See `mstar-sdd` SKILL.

## Project rules

Project `AGENTS.md` / `CLAUDE.md` upward from cwd override global harness defaults when they conflict with Cursor-side rules; user instructions win.
