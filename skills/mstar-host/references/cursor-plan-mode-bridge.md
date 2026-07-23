# Cursor Plan Mode × Harness Dual-Write Bridge

> **Load order**: Read **`mstar-harness-core`** first, then **`mstar-plan-conventions`** and **`mstar-plan-artifacts`** before the first **CreatePlan** in Plan mode. Path symbols `{HARNESS_DIR}`, `{PLAN_DIR}`, `{SPECS_DIR}` are defined in `mstar-plan-conventions`. On conflict, **`mstar-harness-core`** wins.

## Purpose

Cursor **Plan mode** uses **CreatePlan** and built-in plan todos for session UX. Morning Star **SSOT** lives on disk under **`{HARNESS_DIR}`** (default `.mstar/`, legacy `.agents/`). This reference defines **dual-write**: mirror every durable plan artifact to the repo; never treat the Cursor plan URI alone as the handoff surface.

## Priority (hard)

1. User explicit instructions (this turn)
2. Project `AGENTS.md` / `CLAUDE.md`
3. **`{HARNESS_DIR}` / `{PLAN_DIR}` / `status.json`** (harness SSOT)
4. Cursor CreatePlan body and plan todos (session UX mirror)

**NEVER** cite only a Cursor plan file path in Assignment **Plan Path**, **Context Loaded**, or Completion Report when `{PLAN_DIR}/<plan-id>-<name>.md` should exist.

## When this applies

- Cursor **Plan mode** is active (system guidance to use **CreatePlan** / **SwitchMode**).
- Morning Star plugin or `/pm` is in use (`mstar-host`, `pm` skill, or `rules/mstar-cursor-plan-mode.mdc`).

## Before the first CreatePlan

1. **Read** (minimum): `mstar-plan-conventions`, `mstar-plan-artifacts` (SKILL.md); Prepare gates from `mstar-phase-gates` if not hotfix.
2. **Discover** `{HARNESS_DIR}` / `{PLAN_DIR}` per `mstar-plan-conventions` (prefer `.mstar/` + `.mstar/plans/`; reuse legacy `.agents/` only when already present and `.mstar/` is absent).
3. **Initialize** if absent (see checklist below).

### Harness initialization checklist

When plan management is required and directories are missing:

1. Create `{HARNESS_DIR}` and `{PLAN_DIR}`.
2. Ensure Morning Star **process-artifact** gitignore set is present (canonical snippet → `mstar-plan-conventions` SKILL.md「Git 跟踪策略」): `{HARNESS_DIR}/archived/`, `iterations/`, `plans/`, `sdd/`, `notes.json`, `status.json` (legacy `.agents/` equivalents when applicable). Per-plan review bundles are created under `{SDD_DIR}/review/` when needed.
3. Create `{HARNESS_DIR}/archived/residuals/`.
4. Initialize `{HARNESS_DIR}/status.json` from `mstar-plan-artifacts/templates/status.empty.json` if missing.
5. Optional: `{HARNESS_DIR}/notes.json` from `templates/notes.empty.json`, `{HARNESS_DIR}/knowledge/README.md`.

Reuse legacy `.plans/` or `plans/` only when already present; do not duplicate structures.

Full PM checklist: `mstar-roles/references/project-manager/plan-management.md`.

## CreatePlan: fixed bootstrap todos (prefix)

**Emit these three todos first**, in order, **before** any implement / code todos. Do **not** mark implement todos in progress until all three are **done**.

| Todo ID (use in title) | Goal | On-disk outcome |
|------------------------|------|-----------------|
| **`harness-init`** | Bootstrap harness tree | `{HARNESS_DIR}/`, `{PLAN_DIR}/`, process-artifact gitignore set, `archived/residuals/`, `status.json` initialized |
| **`spec-register`** | Register plan in SSOT | New `plans[]` row in `status.json` (`id`, `status`, `file`, `metadata`); spec stub in `{SPECS_DIR}` or plan frontmatter |
| **`mirror-plan`** | SSOT main plan file | `{PLAN_DIR}/<plan-id>-<name>.md` with task checkboxes aligned to CreatePlan body |

### `spec-register` minimum fields

Add one object to `status.json` → `plans[]`:

```json
{
  "id": "<plan-id>",
  "status": "Todo",
        "file": ".mstar/plans/<plan-id>-<short-name>.md",
  "metadata": {
    "primary_spec": "<spec-id or path if known>",
    "description": "<one-line summary>"
  }
}
```

Set `updated_at` on `status.json` to today (`YYYY-MM-DD`). Commit **tracked results** in the business repo when applicable: `{HARNESS_DIR}/AGENTS.md`, `{KNOWLEDGE_DIR}/`, `{SPECS_DIR}/` (default git policy — see `mstar-plan-conventions`). Do **not** default `git add` for `status.json`, `plans/`, or `iterations/`.

### `mirror-plan` minimum content

- YAML or markdown frontmatter with `plan_id`, title, status (`Todo` / `InProgress` — not `Done` unless PM/QA authority).
- **Task list** as markdown checkboxes (`- [ ]` / `- [x]`) matching CreatePlan implement todos.
- **Roadmap / deferred scope** section when delivery is staged, partial, or uses a temporary workaround.
- Link: “SSOT status: `{HARNESS_DIR}/status.json` → `plans[]` / `residual_findings`.”

After **CreatePlan**, keep CreatePlan body and mirror file **in sync** when scope changes (update both in the same coordination round).

## CreatePlan body template (copyable)

Use this structure in CreatePlan `plan` markdown; mirror the same sections into `{PLAN_DIR}/<plan-id>-<name>.md`.

```markdown
# Plan: <title>

**plan_id**: <plan-id>
**HARNESS_DIR**: .mstar/
**Plan file (SSOT)**: .mstar/plans/<plan-id>-<short-name>.md
**status.json**: .mstar/status.json

## Prepare gates

- specify: [done|n/a]
- clarify: [done|n/a]
- plan: [done|in progress]

## Roadmap / deferred scope

- Target state: <complete outcome>
- Current slice: <what this plan/batch delivers>
- Later slices: <batch/order/owner or trigger>
- Deferred scope / temporary workaround removal: <tracking location or N/A>
- Final Done definition: <condition for full completion>

## Tasks (mirror as checkboxes in SSOT plan file)

### Bootstrap (fixed prefix — complete before implement)

1. harness-init — init .mstar/, status.json, process-artifact gitignore set, archived/residuals/
2. spec-register — register plan_id in status.json; spec stub if applicable
3. mirror-plan — write .mstar/plans/<plan-id>-<short-name>.md

### Implement

- [ ] <task-id-1>: <description>
  - Done when: git commit on Working branch + checkbox [x] in SSOT plan + evidence below
- [ ] <task-id-2>: ...

## Working branch

<branch-name or "PM to assign before implement">

## Verification

- Commands / tests required before InReview
```

## Implement todo completion gate (every code todo)

Embed this checklist **inside each implement todo description** in CreatePlan (and mirror the same text on the matching checkbox line in the SSOT plan file).

**Before marking the todo done:**

1. **Commit**: `git add` + `git commit` on the authorized **Working branch** for this **task id** (one commit per task unless PM explicitly allowed batched commits in Assignment).
2. **Plan checkbox**: Set `- [x]` on the matching line in `{PLAN_DIR}/<plan-id>-<name>.md`.
3. **status.json** (when PM round requires): bump `plans[].status` (e.g. `InProgress`) or append coordination notes per `mstar-plan-artifacts`.
4. **Evidence**: Record real `git log -1 --oneline` in Completion Report v2 **Git** (or Plan-mode status note if executing as PM in Plan mode).

**NEVER**

- Mark implement todos done without a commit when tracked files changed.
- Batch all work into one closing commit unless PM documented an exception.
- Mark plan-level `Done` in `status.json` without PM/QA authority and without recorded **`QA gate`** (`mandatory` fulfilled or `pm-acceptance` checklist per `qa-trigger-matrix.md`).

Dev-role NEVER rules also apply when executing as implementer: `mstar-roles/references/fullstack-dev-shared.md` (Git NEVER).

## SwitchMode → Agent (pre-flight)

Before switching from Plan to Agent for implementation (or declaring Plan phase complete):

- [ ] `{PLAN_DIR}/<plan-id>-<name>.md` exists on disk
- [ ] `status.json` contains `plans[]` entry with matching `id` and `file`
- [ ] Bootstrap todos `harness-init`, `spec-register`, `mirror-plan` are **done**
- [ ] CreatePlan implement todos reference **task ids** traceable to SSOT plan checkboxes
- [ ] If staged/partial/temporary, CreatePlan and SSOT plan both contain `Roadmap / deferred scope`
- [ ] **Plan Path** for any Assignment uses the SSOT path, not the Cursor plan URI

If any item fails → **Blocked**; finish harness sync before implement.

## Build resume contract

Cursor **Build** resumes the current plan in Agent mode. Do not assume it replays `/pm` or re-enters a role skill automatically.

First action after Build, before product-code edits:

1. Reload the harness entry: `mstar-harness-core` → `mstar-host` Cursor reference → this bridge.
2. If the plan is a Morning Star plan, resume as `project-manager` for coordination and dispatch only.
3. Read the SSOT plan and `status.json`; use them as the source of truth over the Cursor plan URI.
4. For each implement/code todo, require a PM Assignment with `Execute as`, `Delegation`, `Working branch` or `Branch policy`, and SSOT `Plan Path`.
5. If the Assignment or SSOT state is missing, report **Blocked** and repair the harness state before implementation.

Allowed in the parent Build session: plan/status maintenance, routing decisions, Assignment writing, and host Task dispatch.

Not allowed in the parent Build session by default: product implementation, test implementation, QC execution, QA execution, deployment, or ops changes. Those follow the normal PM dispatch rules unless the user explicitly overrides the harness.

## PM in Plan mode (`/pm`)

When `/pm` runs under Plan mode:

- Load this reference via **`mstar-host`** (Cursor detection) after `mstar-harness-core`.
- **CreatePlan** todos **must** include the three bootstrap prefix items.
- Prepare phase (`specify → clarify → plan`) still applies; `mirror-plan` is the harness **`plan`** artifact, not a substitute for clarify.
- Before QC dispatch, read **`mstar-review-qc`** (unchanged).

## `mstar-iteration` Phase 1 in Plan mode

When starting a **new iteration** under Cursor Plan mode (host command may orchestrate Phase 1):

| Phase | Behavior | Forbidden |
|-------|----------|-----------|
| Early CreatePlan | After read-only research, **CreatePlan once** with blank Phase 1 scaffold + Build-bound todos; **record the returned plan file path** | Wait until direction lock finishes; call CreatePlan again later |
| Feedback loop | User gives **direction / opinions only** (no questionnaire). Agent explores, recommends, and **edits that same plan file in place** (+ SSOT drafts). Absorb feedback → update again | Routine one-question-at-a-time interview; gate plan updates on user answers; write a second `*.plan.md`; open interview helpers before feedback-close |
| Feedback-close | When user signals feedback done (e.g. 反馈结束 / 总结 / 准备 Build): if blocking gaps remain → **minimal** deferred interview on gaps only, still editing the **same** plan file; else ready for Build | Start the interview helper as the main Plan-session loop |
| Pre-Build | Maintain documents only | Execute Review chain, commit, or create `spec_integration_branch` |
| Build | Finalize SSOT from the **same** CreatePlan body → sequential Review & Edit → PM lock → integration branch | Replay feedback/interview; finalize from a different plan URI than View Plan |

**Single CreatePlan URI (HARD)**: one CreatePlan per Phase 1 Plan session. Updates use file edit tools on that path. If a duplicate plan file was created by mistake: merge into the original, delete the duplicate, keep View Plan on the original.

**Plan mode ≠ executing todos.** Build = Phase 1 executable gate (Review chain, lock, branch).

**Branch policy in Plan session**: write **recommended** `iteration_base_branch` / `target_branch` (+ short rationale) into the plan — do **not** silently default to `main`/`master`. User may correct via feedback; ask only after feedback-close if still TBD/conflicting.

**Bootstrap relationship**: ordinary per-plan work still uses `harness-init` / `spec-register` / `mirror-plan`. Phase 1 CreatePlan uses Phase 1 todos (`harness-init` → `finalize-compass-plans` → review-edit seats → `pm-lock` → `integration-branch`). Business `plans[]` rows should exist as drafts before Build when direction has converged.

**Helpers**: third-party interview helpers are **not** named here; host **command** layer may use them only after feedback-close when gaps remain.

## Anti-patterns

| Anti-pattern | Fix |
|--------------|-----|
| CreatePlan only, no `{HARNESS_DIR}` files | Run bootstrap todos; Write mirror plan + status.json |
| Todo done, no commit | Commit per task; paste `git log -1` evidence |
| Drift between CreatePlan and SSOT plan | Update both in same round |
| Cursor plan URI as Plan Path | Use `{PLAN_DIR}/...` path |
| Skip `spec-register` | Add `plans[]` row before implement |
| Build starts coding in the parent session | Resume PM context; dispatch implement work or block on missing Assignment |
| Follow-up only in chat / no roadmap section | Add `Roadmap / deferred scope` to CreatePlan and SSOT plan before implement |
| Phase 1 Plan mode: second CreatePlan / stale open plan | Edit the original plan file only; merge+delete duplicates |
| Phase 1 Plan mode: interview loop before feedback-close | Feedback-driven autonomous plan updates; deferred interview only after close signal if gaps remain |
| Phase 1 Plan mode: Review / commit / branch before Build | Keep Pre-Build document-only; execute those todos after Build |

## Related skills

- `mstar-plan-conventions` — discovery, init, plan-writing path gate
- `mstar-plan-artifacts` — `status.json`, review bundle summaries, checkboxes, residual
- `mstar-phase-gates` — Prepare / Execute order
- `mstar-roles/references/project-manager/dispatch-and-assignment.md` — Checkpoint: commit → Completion Report → Status Update
