# Plan-Mode Bridge Core (shared)

> **Load order**: Read **`mstar-harness-core`** first, then **`mstar-host`** and the host reference + this bridge. When plan management is required, also read **`mstar-plan-conventions`** and **`mstar-plan-artifacts`** before creating or claiming any durable plan state. Path symbols `{HARNESS_DIR}`, `{PLAN_DIR}`, `{SPECS_DIR}` are defined in `mstar-plan-conventions`. On conflict, **`mstar-harness-core`** wins.

Each per-host bridge (`cursor-plan-mode-bridge.md`, `kimi-plan-mode-bridge.md`, `zcode-plan-mode-bridge.md`, `omp-plan-mode-bridge.md`) loads this core and adds its host-specific plan UX (plan tooling, approval gate, todo UI, command surfaces). Codex Plan Mode reads this core directly via `references/codex.md` (no per-host codex plan bridge; the `/goal` rule is host-agnostic in `mstar-host` SKILL.md).

## Dual-write SSOT rule

The host **Plan mode** (session plan file, todos, UI) is a **session UX mirror**. Morning Star **SSOT** lives on disk under **`{HARNESS_DIR}`** (default `.mstar/`, legacy `.agents/`): the main plan in `{PLAN_DIR}/<plan-id>-<name>.md`, the plan registry in `{HARNESS_DIR}/status.json` (v2 root `workflows[]`) + per-lifecycle `{WORKFLOW_DIR}/<id>/snapshot.json` (`plans[]` rows + leases), the iteration compass under `{ITERATION_DIR}/…` when in a formal iteration. Mirror every durable plan artifact to the repo; never treat the host plan file/URI/UI alone as the handoff surface.

### Priority (hard)

1. User explicit instructions (this turn)
2. Project `AGENTS.md` / `CLAUDE.md`
3. **`{HARNESS_DIR}` / `{PLAN_DIR}` / `status.json` (v2) + workflow snapshot** (harness SSOT)
4. Host session plan / todos / UI (session UX mirror) — the host bridge names its surfaces

**NEVER** cite only a host plan path / session todo list / chat summary in Assignment **Plan Path**, **Context Loaded**, or Completion Report when `{PLAN_DIR}/<plan-id>-<name>.md` should exist.

## Before the first plan (bootstrap init)

1. **Read** (minimum): `mstar-plan-conventions`, `mstar-plan-artifacts` (SKILL.md); Prepare gates from `mstar-phase-gates` if not hotfix.
2. **Discover** `{HARNESS_DIR}` / `{PLAN_DIR}` per `mstar-plan-conventions` (prefer `.mstar/` + `.mstar/plans/`; reuse legacy `.agents/` only when already present and `.mstar/` is absent).
3. **Initialize** if absent: `{HARNESS_DIR}/`, `{PLAN_DIR}/`, `status.json` from `mstar-plan-artifacts/templates/status.empty.json` (v2 shape), Morning Star process-artifact gitignore set (canonical snippet → `mstar-plan-conventions` SKILL.md「Git 跟踪策略」; `workflows/` / `projects/` subdirs are created on demand by engine writers, not pre-created). Full PM checklist: `mstar-roles/references/project-manager/plan-management.md`.

## Build resume contract

Host **Build** / plan approval resumes the current plan in Agent mode. Do **not** assume it replays `/pm` or re-enters a role skill automatically.

First action after Build, before product-code edits:

1. Reload the harness entry: `mstar-harness-core` → `mstar-host` host reference → this bridge.
2. If the plan is a Morning Star plan, resume as `project-manager` for coordination and dispatch only.
3. Read the SSOT plan and `status.json`; use them as the source of truth over the host plan URI/UI.
4. For each implement/code todo, require a PM Assignment with `Execute as`, `Delegation`, `Working branch` or `Branch policy`, and SSOT `Plan Path`.
5. If the Assignment or SSOT state is missing, report **Blocked** and repair the harness state before implementation.

Allowed in the parent Build session: plan/status maintenance, routing decisions, Assignment writing, and host task dispatch.

Not allowed in the parent Build session by default: product implementation, test implementation, QC execution, QA execution, deployment, or ops changes. Those follow the normal PM dispatch rules unless the user explicitly overrides the harness.

## CreatePlan: fixed bootstrap todos (prefix)

**Emit these three todos first**, in order, **before** any implement / code todos. Do **not** mark implement todos in progress until all three are **done**.

| Todo ID (use in title) | Goal | On-disk outcome |
|------------------------|------|-----------------|
| **`harness-init`** | Bootstrap harness tree | `{HARNESS_DIR}/`, `{PLAN_DIR}/`, process-artifact gitignore set, `status.json` (v2) initialized (`workflows/` / `projects/` created on demand by engine writers) |
| **`spec-register`** | Register plan in SSOT | New root `workflows[]` entry (`{HARNESS_DIR}/status.json` v2) + `plans[]` row in `{WORKFLOW_DIR}/<id>/snapshot.json` (`id`, `status`, `file`, `metadata`); spec stub in `{SPECS_DIR}` or plan frontmatter |
| **`mirror-plan`** | SSOT main plan file | `{PLAN_DIR}/<plan-id>-<name>.md` with task checkboxes aligned to the host plan body |

After the host plan is created, keep the host plan body and mirror file **in sync** when scope changes (update both in the same coordination round).

## Implement todo completion gate (every code todo)

**Before marking the todo done:**

1. **Commit**: `git add` + `git commit` on the authorized **Working branch** for this **task id** (one commit per task unless PM explicitly allowed batched commits in Assignment).
2. **Plan checkbox**: Set `- [x]` on the matching line in `{PLAN_DIR}/<plan-id>-<name>.md`.
3. **status.json / snapshot** (when PM round requires): bump the snapshot plan row `plans[].status` (e.g. `InProgress`) or append coordination notes to `{WORKFLOW_DIR}/<id>/notes.jsonl` per `mstar-plan-artifacts`.
4. **Evidence**: Record real `git log -1 --oneline` in Completion Report **Git** (or the plan-mode status note if executing as PM in Plan mode).

**NEVER**

- Mark implement todos done without a commit when tracked files changed.
- Batch all work into one closing commit unless PM documented an exception.
- Mark plan-level `Done` in `status.json` without PM/QA authority and without recorded **`QA gate`** (`mandatory` fulfilled or `pm-acceptance` checklist per `qa-trigger-matrix.md`).

Dev-role NEVER rules also apply when executing as implementer: `mstar-roles/references/fullstack-dev-shared.md` (Git NEVER).

## `mstar-iteration` Phase 1 in Plan mode (shared gate)

- **Single plan session**: use **one** plan file (host or SSOT draft); iterate the **same** file in place with feedback-driven edits. If a duplicate plan file was created by mistake: merge into the original, delete the duplicate.
- **Do not** run Review & Edit, commit, or create the integration branch until the user approves implementation (host approval gate: **Build** / **`ExitPlanMode`** / plan resolve). Plan mode ≠ executing todos — approval is the Phase 1 executable gate (Review chain, lock, branch).
- Prepare phase (`specify → clarify → plan`) still applies; the mirrored plan is the harness **`plan`** artifact, not a substitute for clarify.
- Branch policy in the plan session: write **recommended** `iteration_base_branch` / `target_branch` (+ short rationale) into the plan — do **not** silently default to `main`/`master`.
- Host plan approval is **not** Morning Star **Done**. Implementation still follows phase gates, per-task commits, QC, and QA per the SSOT plan.

## Anti-patterns (shared)

| Anti-pattern | Fix |
|--------------|-----|
| Host plan only, no `{HARNESS_DIR}` files | Run bootstrap todos; write mirror plan + status.json/snapshot |
| Todo done, no commit | Commit per task; paste `git log -1` evidence |
| Drift between host plan and SSOT plan | Update both in same round |
| Host plan URI as Plan Path | Use `{PLAN_DIR}/...` path |
| Skip `spec-register` | Add the snapshot `plans[]` row + root `workflows[]` entry before implement |
| Build starts coding in the parent session | Resume PM context; dispatch implement work or block on missing Assignment |
| Host plan approval treated as Done authority | Check harness plan/status/QC/QA gates first |
| Resume starts coding from host chat summary | Reload harness context and SSOT plan/status first |
| Phase 1 Plan mode: Review / commit / branch before Build | Keep Pre-Build document-only; execute those todos after approval |
