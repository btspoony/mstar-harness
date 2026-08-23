# omp Plan mode bridge

Load with **`omp.md`** when omp Plan mode is active (`/plan`, plan-yolo / plan-model flows, or read-only-with-resolve plan UX). Shared contract → **`references/_shared/plan-mode-bridge-core.md`** (dual-write SSOT rule + priority, bootstrap init, Build resume contract, bootstrap todos, implement done-gate, Phase 1 gate, shared anti-patterns). This bridge covers omp plan-UX specifics only.

## Dual-write contract

omp session plans, composer todos, and plan-mode UI text are **session UX only**. Durable SSOT remains **`{HARNESS_DIR}`** (default `.mstar/`, legacy `.agents/`):

| Artifact | SSOT |
|----------|------|
| Main plan | `{PLAN_DIR}/<plan-id>-<name>.md` |
| Plan registry | `{HARNESS_DIR}/status.json` (v2 root `workflows[]`) + `{WORKFLOW_DIR}/<id>/snapshot.json` (`plans[]` rows) |
| Iteration compass | `{ITERATION_DIR}/…` when in formal iteration |

Bootstrap before treating a plan as ready for Execute (read `mstar-conventions` + `mstar-artifacts`; ensure `{HARNESS_DIR}` / `{PLAN_DIR}` exist with process-artifact gitignore entries; mirror the active omp plan into the SSOT main plan path; register the root `workflows[]` entry + snapshot plan row when required by Prepare gates) → core.

**Never** use only the omp session plan / UI todo list as **Plan Path**.

## `mstar-iteration` Phase 1 in Plan mode

When formal iteration Phase 1 runs under omp Plan UX, the shared gate → core: single SSOT draft plan path (no silent second plan file); feedback-driven in-place edits; **do not** run Review & Edit chain, commit, or create integration branch until the user leaves Plan mode / approves implementation (Build-equivalent). Recommended branch policy still applies — no silent work on `main`/`master` (`mstar-iteration` §1.2).

## Clarify vs plan approval

- Use **`ask`** for high-impact product/tech choices while drafting.
- Plan sign-off is the host Plan resolve / approval path, not a casual chat question.
- After approval, resume as **`project-manager`**: reload `mstar-harness-core` + `omp.md`, then dispatch implementation through **`task`** (C5/C5b). Parent plan session must **not** implement product code unless the user explicitly overrides harness dispatch.

## Gotchas

- Plan-yolo / prewalk model switches are host UX — they do not waive Morning Star gates, Assignment, or evidence rules.
- Isolated task worktrees from omp are orthogonal to Morning Star L1 lease/worktree fields; when L1 is active, still record harness **Worktree path** / leases.
