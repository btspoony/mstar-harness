# Cursor host reference

Load when **`mstar-host`** detection resolves **cursor** (CreatePlan / SwitchMode, Task + `subagent_type`, or Cursor `/pm` flow).

Parallel PM dispatch: **`parallel-dispatch.md`** (Task tool uses same turn model).

## Cursor-only context

- Role prompts: `mstar-roles`; **`/pm`** → `project-manager` via `pm` skill + `mstar-roles`.
- Routing-eval: `.cursor/skills/mstar-routing-eval/` — maint only.

## Plan mode × harness dual-write

When **Plan mode** is active, **CreatePlan is session UX**; SSOT is **`{HARNESS_DIR}`** (default `.mstar/`, legacy `.agents/`) — `{PLAN_DIR}/<plan-id>-<name>.md`, `{HARNESS_DIR}/status.json`.

Before first **CreatePlan**: Read `mstar-plan-conventions`, `mstar-plan-artifacts`, Prepare gates from `mstar-phase-gates` when not hotfix. Full procedure: **`cursor-plan-mode-bridge.md`**.

**Bootstrap CreatePlan todos (prefix, before implement):**

| Todo ID | Purpose |
|---------|---------|
| `harness-init` | Init `{HARNESS_DIR}`, `{PLAN_DIR}`, `reports/`, `archived/residuals/`, `status.json` |
| `spec-register` | Register `plan_id` in `status.json.plans[]` + spec stub if applicable |
| `mirror-plan` | Write SSOT main plan under `{PLAN_DIR}/` |

Each **implement todo**: per–task-ID **git commit** on Working branch → SSOT `- [x]` → optional `status.json` sync → `git log -1 --oneline` evidence.

Before **SwitchMode → Agent**: mirror plan exists; `status.json` lists `plan_id`; bootstrap todos done. **Never** use only the Cursor plan URI as **Plan Path**.

After **Build**: treat the run as plan resume, not `/pm` replay. Reload `mstar-harness-core` + this Cursor reference, resume Morning Star plans as `project-manager` orchestration, and dispatch implementation through Task unless the user explicitly overrides the harness.

Enforcement: `rules/mstar-cursor-plan-mode.mdc` when plugin active.

## `/pm` precedence

1. User explicit instructions
2. Project `AGENTS.md` / `CLAUDE.md`
3. `mstar-harness-core` and `mstar-*` skills
4. `mstar-host` + this reference

## Task tool (QC tri-review)

- Apply **`parallel-dispatch.md`**: prerequisite message may prep only; dispatch message emits **all `N`** Tasks (**3** for tri-review) in **one** message when parallel is required.
- `subagent_type`: bare role ids — `qc-specialist`, `qc-specialist-2`, `qc-specialist-3` (same for implement roles: `fullstack-dev`, `frontend-dev`, etc.).
- Identical across three Tasks: **`plan_id`**, **`Review cwd`**, **`Review range` / Diff basis** (`mstar-branch-worktree`, `mstar-dispatch-gates`, `mstar-review-qc`).
- Parallel QC ≠ different review cwd per reviewer; one integrated HEAD for scope.
- Status Update may note QC ran via parallel Task subagents.

## Supplemental execution modes

**Mode A — Single session, multiple roles:** PM writes Assignment; executor states `Acting as role: …` and loads `mstar-roles` reference. QC/QA without Task: same field alignment rules.

**Mode B — Multi-window:** One Assignment per chat; first turn loads role via `mstar-roles`; PM consolidates in main thread.

**Mode C — Worktrees:** `mstar-branch-worktree` + `mstar-dispatch-gates` for concurrent writers; do not assign different tri-review cwd by default.

**No recursive Task in implement subagents:** Task recipient is already `Execute as`; must not re-spawn same dev role. Assignment wins over conflicting outer messages (`Delegation: forbidden`).

## Clarify

- No `question` tool: structured Markdown or Cursor UI.
- “Question asked” ≠ clarify done; high-impact ambiguity → `Blocked` or escalation.

## Execution Practices

Use `mstar-execution-practices` for RCA, test-first work, plan checkpoints, review feedback, and completion evidence. Do not require external skill plugins.

## Gotchas

- Tri-review needs identical `plan_id` and review scope fields.
- Task parallelism does not relax branch/worktree isolation.

## Project rules

Project `AGENTS.md` / `CLAUDE.md` upward from cwd override global harness defaults when they conflict with Cursor-side rules; user instructions win.
