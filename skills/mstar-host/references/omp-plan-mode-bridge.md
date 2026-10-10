# omp Plan mode bridge

Load with **`omp.md`** when omp Plan mode is active (`/plan`, plan-yolo / plan-model flows, or read-only-with-resolve plan UX). Shared contract → **`references/_shared/plan-mode-bridge-core.md`** (dual-write SSOT rule + priority, bootstrap init, Build resume contract, bootstrap todos, implement done-gate, Phase 1 gate, shared anti-patterns). This bridge covers omp plan-UX specifics only.

## Dual-write contract

omp session plans, composer todos, and plan-mode UI text are **session UX only**. Durable SSOT remains **`{HARNESS_DIR}`** (default `.mstar/`, legacy `.agents/`):

| Artifact | SSOT |
|----------|------|
| Main plan | `{PLAN_DIR}/<plan-id>-<name>.md` |
| Plan registry | ACTIVE store.db `execution_registry` / `execution_plans` |
| Iteration compass | `{ITERATION_DIR}/…` when in formal iteration |

Bootstrap before treating a plan as ready for Execute (read `mstar-conventions` + `mstar-artifacts`; ensure `{HARNESS_DIR}` / `{PLAN_DIR}` exist with process-artifact gitignore entries; mirror the active omp plan into the SSOT main plan path; register store-backed workflow/plan rows through `mstar workflow register` when required by Prepare gates) → core.

**Never** use only the omp session plan / UI todo list as **Plan Path**.

## `mstar-iteration` Phase 1 in Plan mode

When formal iteration Phase 1 runs under omp Plan UX, follow the shared core gate: **one session-plan carrier**, §1.2.5 package prototype feedback/approval before §1.3 formal drafting, selected product-manager / architect Review & Edit and mandatory writer last. Design approval is separate from host implementation approval; do not run formal Review & Edit or integration until the Plan resolve / Build-equivalent permits them. If read-only Plan UX cannot persist/show the prototype or invoke a needed role, retain pending work in the same carrier and use the normal Plan resolve / exit control to resume **prototype preparation only**; never claim an unseen design approved, bypass restrictions, or create a silent second plan. Explicit autonomous mode retains its prototype without routine human confirmation. Recommended branch policy still applies; no silent `main`/`master`.

## Clarify vs plan approval

- Use **`ask`** for high-impact product/tech choices while drafting.
- Plan sign-off is the host Plan resolve / approval path, not a casual chat question.
- After approval, resume as **`project-manager`**: reload `mstar-harness-core` + `omp.md`, then dispatch implementation through **`task`** (C5/C5b). Parent plan session must **not** implement product code unless the user explicitly overrides harness dispatch.

## Gotchas

- Plan-yolo / prewalk model switches are host UX — they do not waive Morning Star gates, Assignment, or evidence rules.
- Isolated task worktrees from omp are orthogonal to Morning Star L1 lease/worktree fields; when L1 is active, still record harness **Worktree path** / leases.
