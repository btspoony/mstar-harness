# Plan-Mode Bridge Core (shared)

> **Load order**: Read **`mstar-harness-core`** first, then **`mstar-host`** and the host reference + this bridge. When plan management is required, also read **`mstar-conventions`** and **`mstar-artifacts`** before creating or claiming any durable plan state. Path symbols `{HARNESS_DIR}`, `{PLAN_DIR}`, `{SPECS_DIR}` are defined in `mstar-conventions`. On conflict, **`mstar-harness-core`** wins.

Each per-host bridge (`cursor-plan-mode-bridge.md`, `kimi-plan-mode-bridge.md`, `zcode-plan-mode-bridge.md`, `omp-plan-mode-bridge.md`) loads this core and adds its host-specific plan UX (plan tooling, approval gate, todo UI, command surfaces). Codex Plan Mode reads this core directly via `references/codex.md` (no per-host codex plan bridge; the `/goal` rule is host-agnostic in `mstar-host` SKILL.md).

## Dual-write SSOT rule

The host **Plan mode** (session plan file, todos, UI) is a **session UX mirror**. Morning Star **SSOT** lives on disk under **`{HARNESS_DIR}`** (default `.mstar/`, legacy `.agents/`): the main plan in `{PLAN_DIR}/<plan-id>-<name>.md`, the plan registry in `{HARNESS_DIR}/status.json` (v2 root `workflows[]`) + per-lifecycle `{WORKFLOW_DIR}/<id>/snapshot.json` (`plans[]` rows + leases), the iteration compass under `{ITERATION_DIR}/…` when in a formal iteration. Mirror every durable plan artifact to the repo; never treat the host plan file/URI/UI alone as the handoff surface.

**Iteration Phase 1 exception**: until the current-design prototype checkpoint passes, the session carrier is not a formal plan to mirror/register. Use § `mstar-iteration Phase 1 in Plan mode` below instead of the early formal dual-write/bootstrap sequence. Initialization and every package write still obey actual host permissions.

### Priority (hard)

1. User explicit instructions (this turn)
2. Project `AGENTS.md` / `CLAUDE.md`
3. **`{HARNESS_DIR}` / `{PLAN_DIR}` / `status.json` (v2) + workflow snapshot** (harness SSOT)
4. Host session plan / todos / UI (session UX mirror) — the host bridge names its surfaces

**NEVER** cite only a host plan path / session todo list / chat summary in Assignment **Plan Path**, **Context Loaded**, or Completion Report when `{PLAN_DIR}/<plan-id>-<name>.md` should exist.

## Before the first plan (bootstrap init)

1. **Read** (minimum): `mstar-conventions`, `mstar-artifacts` (SKILL.md); Prepare gates from `mstar-phase-gates` if not hotfix.
2. **Discover** `{HARNESS_DIR}` / `{PLAN_DIR}` per `mstar-conventions` (prefer `.mstar/` + `.mstar/plans/`; reuse legacy `.agents/` only when already present and `.mstar/` is absent).
3. **Initialize** if absent: `{HARNESS_DIR}/`, `{PLAN_DIR}/`, `status.json` from `mstar-artifacts/templates/status.empty.json` (v2 shape), Morning Star process-artifact gitignore set (canonical snippet → `mstar-conventions` SKILL.md「Git 跟踪策略」; `workflows/` / `projects/` subdirs are created on demand by engine writers, not pre-created). Full PM checklist: `mstar-roles/references/project-manager/plan-management.md`.

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

`spec-register` is an authorized domain operation (engine producer primitives), declares the workflow's delivery kind, and blocks implementation until complete — plan-mode resumes owe the same registration obligation. Semantics → `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`.

After the host plan is created, keep the host plan body and mirror file **in sync** when scope changes (update both in the same coordination round).

## Implement todo completion gate (every code todo)

**Before marking the todo done:**

1. **Commit**: `git add` + `git commit` on the authorized **Working branch** for this **task id** (one commit per task unless PM explicitly allowed batched commits in Assignment).
2. **Plan checkbox**: Set `- [x]` on the matching line in `{PLAN_DIR}/<plan-id>-<name>.md`.
3. **status.json / snapshot** (when PM round requires): bump the snapshot plan row `plans[].status` (e.g. `InProgress`) or append coordination notes to `{WORKFLOW_DIR}/<id>/notes.jsonl` per `mstar-artifacts`.
4. **Evidence**: Record real `git log -1 --oneline` in Completion Report **Git** (or the plan-mode status note if executing as PM in Plan mode).

**NEVER**

- Mark implement todos done without a commit when tracked files changed.
- Batch all work into one closing commit unless PM documented an exception.
- Mark plan-level `Done` in `status.json` without PM/QA authority and without recorded **`QA gate`** (`mandatory` fulfilled or `pm-acceptance` checklist per `qa-trigger-matrix.md`).

Dev-role NEVER rules also apply when executing as implementer: `mstar-roles/references/fullstack-dev-shared.md` (Git NEVER).

## `mstar-iteration` Phase 1 in Plan mode (shared gate)

- **Single session-plan carrier**: keep one host plan file/URI (or the same permitted draft carrier when no host file exists). Before prototype approval, it carries research, prototype links/revision, feedback, recommended branch policy and pending todos — not formal compass/guides/plans/specs. Update it in place; a package prototype is a design artifact, not a second executable plan. If a duplicate carrier exists, consolidate into the original and remove the duplicate only when file permissions allow it.
- **Prototype first**: follow **`mstar-iteration/references/phase-1-prepare.md` §1.2 → §1.2.5 → §1.3**. Preserve `direction-lock` before formal drafts. Interactive preparation persists and presents a plain-language visual HTML in the iteration package; feedback → communication → same-prototype update → re-presentation repeats until explicit approval of the **current revision**. Feedback-close and earlier-version approval do not authorize drafting. An explicit autonomous opt-in retains an appropriate HTML/Markdown/JSON prototype with rationale and autonomous disposition, without routine human sign-off.
- **Permissions are independent gates**: prototype design approval does not authorize Build / implementation. Obey the host's real Plan-mode write and invoke permissions; no shell, alternate tool, child or second plan may bypass them. Optional prototype specialist contributions occur only when invoke is allowed. Formal drafting follows the prototype checkpoint; Review & Edit / integration remain deferred until the host Build / `ExitPlanMode` / resolve gate permits them.
- **Supported permission recovery**: if Plan mode only permits its session-plan file, retain the pending prototype path, design intent and next steps there; explain that no package prototype has been persisted/presented and no design gate has passed. Ask the user to use the active host's normal Build / exit / resolve control to continue **prototype preparation only**, not to approve an unseen design or start product implementation. Resume the same carrier in PM context, persist/show the prototype, finish its design checkpoint, then draft and invoke selected reviewers. If invoke is still unavailable, resume through a host entry exposing the required role tools, retaining the existing artifact paths; report the exact missing capability rather than fake returns.
- **Selected Review & Edit**: follow §1.6 — record product-manager / architect include/skip reasons and reuse prototype contributions; invoke selected roles sequentially in that order, then mandatory writing-specialist last. No fake skip receipts, omitted-role markers or unresolved blocking questions. PM lock and integration follow actual returns.
- Prepare (`specify → clarify → plan`) still applies. Recommended `iteration_base_branch` / `target_branch` (+ rationale) goes into the carrier without silent `main`/`master` defaults. Formal plans reference the prototype through existing `metadata.iteration_refs`.
- Host plan approval is not Morning Star **Done**. Implementation still follows phase gates, per-task commits, QC and QA; this Phase 1 exception to early dual-write/bootstrap does not change ordinary per-plan behavior above.

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
| Phase 1 Plan mode: formal drafts before prototype approval, or Review / branch before Build | Finish the current-design checkpoint first; use supported host permission-resume for restricted writes/invoke; never infer implementation permission from design approval |
