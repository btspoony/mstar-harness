---
name: codebase-arch-governance
description: "Converge a codebase toward the shape its current requirements would have produced, in closed batches: audit, take the lowest-total-complexity move, migrate every caller, delete the replaced path, lock the rule. Never half-migrates."
agent: project-manager
input: "[path|subsystem] [dry-run]"
---

# Architecture Governance

Governance, not a rewrite: the codebase is converged batch by batch, and every batch leaves the product working with one path per semantic. A batch that adds an abstraction, directory or interface without migrating its callers, or that leaves the replaced implementation alive beside the new one, is not progress and is rejected at Acceptance.

**Procedure SSOT** → `mstar-coding-behavior` → `references/architecture-governance.md` (target state, the seven properties and their owners, closed-batch conditions, batch selection by total complexity, rejected moves, stop conditions).

## Boot

- PM: `mstar-harness-core` + this entry's routing; `mstar-phase-gates` + `mstar-dispatch-gates` before the first implement dispatch; `mstar-conventions` (path symbols) and `mstar-host` (invoke capability).
- Discovery seat: `mstar-audit` → `references/codebase-audit.md` § scope variants (`simplify`).
- Execution and QC seats: `mstar-coding-behavior` → `references/architecture-governance.md`; `mstar-sdd` when the batch is multi-task; `mstar-coding-behavior` → `references/constraint-ladder.md` when a settled rule needs enforcing; `mstar-doc-corpus` → `references/adr.md` when a structural decision is promoted.

## Execute

1. **Discover.** Run the `simplify` audit pass (`mstar-audit` → `references/codebase-audit.md`) over the scope, read-only, and keep its evidence. `dry-run` ends here: publish the prioritised batches with their measured baseline and stop — no edits, no development dispatch, no issue or ADR writes, and no claimed net-complexity figure.
2. **Select one batch.** Take the candidate with the lowest total complexity per that reference's § Choosing the batch, and drop every candidate its § Not a finding list rejects. One batch per plan row.
3. **Prepare.** The batch is a normal plan: `specify → clarify → plan` per `mstar-phase-gates`, with the behaviour baseline landed before the move and a characterization test first where coverage is thin.
4. **Execute.** PM dispatches a development seat (SDD for multi-task), then independent QC, then PM Acceptance (`mstar-roles/references/project-manager/acceptance.md`). Every caller the batch touches is migrated inside that batch.
5. **Lock the rule.** Land the settled rule on the strongest available constraint, or record it as a residual; a residual that repeats moves up the ladder in a later batch.
6. **Next batch.** Record the batch's net complexity, then repeat steps 2–5 until a stop condition fires. Invoking this command is the opt-in for running successive batches without a confirmation prompt between them; it is not approval for a merge, a destructive migration, or a product or architecture decision — those still stop the round.

## Close-out

Report each batch as: the move; the parallel path, scatter or layer it removed; the caller churn; the behaviour baseline that proved preservation; the constraint now holding the rule or the residual it left; and the stop condition that ended the round. The remaining pool lives in the issue store, accepted structural decisions in `{ADR_DIR}`, and the plan rows remain the delivery record.
