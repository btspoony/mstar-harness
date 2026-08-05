# omp Plan mode bridge

Load with **`omp.md`** when omp Plan mode is active (`/plan`, plan-yolo / plan-model flows, or read-only-with-resolve plan UX).

## Dual-write contract

omp session plans, composer todos, and plan-mode UI text are **session UX only**. Durable SSOT remains **`{HARNESS_DIR}`** (default `.mstar/`, legacy `.agents/`):

| Artifact | SSOT |
|----------|------|
| Main plan | `{PLAN_DIR}/<plan-id>-<name>.md` |
| Plan registry | `{HARNESS_DIR}/status.json` |
| Iteration compass | `{ITERATION_DIR}/…` when in formal iteration |

Before treating a plan as ready for Execute:

1. Read `mstar-plan-conventions` + `mstar-plan-artifacts`.
2. Ensure `{HARNESS_DIR}` / `{PLAN_DIR}` exist and process-artifact gitignore entries are present.
3. Mirror the active omp plan content into the SSOT main plan path.
4. Register `plan_id` in `status.json.plans[]` when required by Prepare gates.

**Never** use only the omp session plan / UI todo list as **Plan Path**.

## `mstar-iteration` Phase 1 in Plan mode

When formal iteration Phase 1 runs under omp Plan UX:

1. Keep a **single** SSOT draft plan path (no silent second plan file).
2. Converge by **feedback-driven in-place edits** on that SSOT plan (and mirror into omp plan UI if helpful).
3. **Do not** run Review & Edit chain, commit, or create integration branch until the user leaves Plan mode / approves implementation (Build-equivalent).
4. Recommended branch policy still applies — no silent work on `main`/`master` (`mstar-iteration` §1.2).

## Clarify vs plan approval

- Use **`ask`** for high-impact product/tech choices while drafting.
- Plan sign-off is the host Plan resolve / approval path, not a casual chat question.
- After approval, resume as **`project-manager`**: reload `mstar-harness-core` + `omp.md`, then dispatch implementation through **`task`** (C5/C5b). Parent plan session must **not** implement product code unless the user explicitly overrides harness dispatch.

## Gotchas

- Plan-yolo / prewalk model switches are host UX — they do not waive Morning Star gates, Assignment, or evidence rules.
- Isolated task worktrees from omp are orthogonal to Morning Star L1 lease/worktree fields; when L1 is active, still record harness **Worktree path** / leases.
