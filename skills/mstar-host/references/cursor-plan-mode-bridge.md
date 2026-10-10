# Cursor Plan Mode × Harness Dual-Write Bridge

> **Load order**: Read **`mstar-harness-core`** first, then **`mstar-host`** and **`references/cursor.md`**, then **`references/_shared/plan-mode-bridge-core.md`** (shared contract) + this bridge. When plan management is required, also read **`mstar-conventions`** and **`mstar-artifacts`** before the first **CreatePlan** in Plan mode. Path symbols `{HARNESS_DIR}`, `{PLAN_DIR}`, `{SPECS_DIR}` are defined in `mstar-conventions`. On conflict, **`mstar-harness-core`** wins.

**Shared contract** (dual-write SSOT rule + priority, bootstrap init, Build resume contract, bootstrap todos, implement done-gate, Phase 1 gate, shared anti-patterns) → **`references/_shared/plan-mode-bridge-core.md`**. This bridge covers Cursor **CreatePlan** / **SwitchMode** / Plan-mode specifics only.

## When this applies

- Cursor **Plan mode** is active (system guidance to use **CreatePlan** / **SwitchMode**).
- Morning Star plugin or `/pm` is in use (`mstar-host`, `pm` skill, or `rules/mstar-cursor-plan-mode.mdc`).

**New-iteration exception**: the Phase 1 section below overrides early formal bootstrap/mirroring and the ordinary CreatePlan body template. Keep the single early carrier non-formal until current-prototype approval; actual Plan write restrictions apply even to initialization.

## Before the first CreatePlan

1. **Read** (minimum): `mstar-conventions`, `mstar-artifacts` (SKILL.md); Prepare gates from `mstar-phase-gates` if not hotfix.
2. **Discover** `{HARNESS_DIR}` / `{PLAN_DIR}` per `mstar-conventions` (prefer `.mstar/` + `.mstar/plans/`; reuse legacy `.agents/` only when already present and `.mstar/` is absent).
3. **Initialize** if absent — checklist in core; full PM checklist (incl. process-artifact gitignore set): `mstar-roles/references/project-manager/plan-management.md` (canonical gitignore snippet → `mstar-conventions` SKILL.md「Git 跟踪策略」).

## CreatePlan specifics

Bootstrap todos `harness-init` / `spec-register` / `mirror-plan` (emit first, in order, before any implement todos) → core.

### `spec-register` minimum fields

Use `mstar workflow register` to create store.db registry/workflow/plan rows and declare delivery kind; use `mstar plan prepare` for the prepared Assignment and frozen inputs. Read registration through `mstar status validate` / `mstar plan show`. Required fields and tokens follow the producer's `--help` and `mstar-artifacts`; do not hand-write JSON templates.

A control root with no ACTIVE store has no execution authority: create one with `mstar harness scaffold` + `mstar store init` (or `mstar store upgrade` to import historical file state), or track the work in conversation (no-plan mode). Commit tracked results when applicable (`AGENTS.md`, knowledge, specs); process artifacts remain gitignored per `mstar-conventions`.

### `mirror-plan` minimum content

- YAML or markdown frontmatter with `plan_id`, title, status (`Todo` / `InProgress` — not `Done` unless PM/QA authority).
- **Task list** as markdown checkboxes (`- [ ]` / `- [x]`) matching CreatePlan implement todos.
- **Roadmap / deferred scope** section when delivery is staged, partial, or uses a temporary workaround.
- Link: “Execution status: store.db registered workflow/plan rows (`mstar status validate` / `mstar plan show`); open findings: store.db issues (`mstar plan issue-add` / `mstar issue add`).”

After **CreatePlan**, keep CreatePlan body and mirror file **in sync** when scope changes (update both in the same coordination round).

### CreatePlan body template (copyable)

Use this structure in CreatePlan `plan` markdown; mirror the same sections into `{PLAN_DIR}/<plan-id>-<name>.md`.

```markdown
# Plan: <title>

**plan_id**: <plan-id>
**HARNESS_DIR**: .mstar/
**Plan file (SSOT)**: .mstar/plans/<plan-id>-<short-name>.md
**Execution authority**: .mstar/store.db (read through public status/plan verbs)

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

1. harness-init — initialize harness directories and process-artifact gitignore (`mstar harness scaffold`), then create/activate the store (`mstar store init`, or `mstar store upgrade` for historical file state)
2. spec-register — register workflow/plan rows through the authorized engine producer; spec stub if applicable
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

Commit → SSOT checkbox → PM public plan-state update in store.db → `git log -1 --oneline` evidence; NEVER list → core. Dev-role NEVER rules also apply when executing as implementer: `mstar-roles/references/fullstack-dev-shared.md` (Git NEVER).

## SwitchMode → Agent (pre-flight)

Before switching from Plan to Agent for implementation (or declaring Plan phase complete):

- [ ] `{PLAN_DIR}/<plan-id>-<name>.md` exists on disk
- [ ] `mstar status validate` / `mstar plan show` confirms the registered workflow/plan row with matching `id` and authored plan `file`; no ACTIVE file sync
- [ ] Bootstrap todos `harness-init`, `spec-register`, `mirror-plan` are **done**
- [ ] CreatePlan implement todos reference **task ids** traceable to SSOT plan checkboxes
- [ ] If staged/partial/temporary, CreatePlan and SSOT plan both contain `Roadmap / deferred scope`
- [ ] **Plan Path** for any Assignment uses the SSOT path, not the Cursor plan URI

If any item fails → **Blocked**; finish harness sync before implement.

## Build resume contract

→ core. Cursor delta: **Build** resumes the current plan in Agent mode; do not assume it replays `/pm` or re-enters a role skill automatically.

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
| Early CreatePlan | After read-only research, **CreatePlan once** with a blank session carrier and pending preparation / Build-bound todos; record the returned path | Treat the carrier as a formal iteration draft; call CreatePlan again later |
| Prototype feedback | Subject to actual write permissions, persist/present §1.2.5 package HTML; absorb opinions, communicate changes, revise the same prototype and re-present; update links/revision in the same CreatePlan file | Mandatory questionnaire; formal compass/guides/plans/specs before current-design approval; silent second plan |
| Feedback-close / approval | Deferred minimal clarification only for blocking gaps after feedback-close; require explicit approval of the presented **current prototype** before formal drafts | Equate feedback-close, direction lock or old-version approval with current-design approval |
| Pre-Build | Keep pending gated work in the carrier. If package writes/invoke are prohibited, use shared core permission recovery via normal **Build** / **SwitchMode** UX; resume prototype preparation, not product code | Bypass permission via shell/child; run formal Review chain or integration before Build |
| Build | Reload PM context and resume the same carrier; finish prototype checkpoint if pending, then formal drafts → selected product/architect invokes → mandatory writer last → PM lock → integration | Treat Build as approval of unseen design; repeat resolved feedback; finalize from another URI; implement in PM thread |

**Single CreatePlan URI (HARD)**: one CreatePlan per Phase 1 Plan session; updates use file edit tools on that returned path. The iteration-package HTML is a separate **prototype**, not a second plan. Consolidate accidental duplicate carriers into the original and remove duplicates only when permissions allow; keep View Plan on the original.

**Bootstrap relationship**: ordinary per-plan `harness-init` / `spec-register` / `mirror-plan` is unchanged. Phase 1 uses `harness-init` → `direction-lock-arm` → prototype preparation/confirmation → `finalize-compass-plans` → selected review-edit seats → mandatory writer → `pm-lock` → `integration-branch`. No formal snapshot plan rows before current-design approval; no writes beyond actual Plan permissions. Shared core defines supported recovery and design-vs-Build separation.

**Helpers**: third-party interview helpers are **not** named here; host **command** layer may use them only after feedback-close when gaps remain.

## Anti-patterns (Cursor-specific)

| Anti-pattern | Fix |
|--------------|-----|
| Follow-up only in chat / no roadmap section | Add `Roadmap / deferred scope` to CreatePlan and SSOT plan before implement |
| Phase 1 Plan mode: second CreatePlan / stale open plan | Edit the original plan file only; merge+delete duplicates |
| Phase 1 Plan mode: interview loop before feedback-close | Feedback-driven autonomous plan updates; deferred interview only after close signal if gaps remain |

## Related skills

- `mstar-conventions` — discovery, init, plan-writing path gate
- `mstar-artifacts` — `status.json`, review bundle summaries, checkboxes, residual
- `mstar-phase-gates` — Prepare / Execute order
- `mstar-roles/references/project-manager/dispatch-and-assignment.md` — Checkpoint: commit → Completion Report → Status Update
