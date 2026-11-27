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
- Discovery rubric: `mstar-audit` → `references/codebase-audit.md` § scope variants (`simplify`) — read it as the method for ranking candidates, not as a dispatched seat.
- Execution and QC seats: `mstar-coding-behavior` → `references/architecture-governance.md`; `mstar-sdd` when the batch is multi-task; `mstar-coding-behavior` → `references/constraint-ladder.md` when a settled rule needs enforcing; `mstar-doc-corpus` → `references/adr.md` when a structural decision is promoted.

## Execute

1. **Discover.** Rank candidate moves by the `simplify` rubric (`mstar-audit` → `references/codebase-audit.md`), keeping only evidence the reads produced and only candidates inside the `path|subsystem` scope when that token is given. `dry-run` exits here: read and rank in this session, return the ranked candidates with the baseline already observed in the response, and write nothing — no audit run directory, report or evidence files, scout dispatch, issue capture, ADR write, edit, or claimed net-complexity figure. Without `dry-run`, run the same pass as a read-only audit and keep its evidence.
2. **Select one batch.** Take the candidate with the lowest total complexity per `mstar-coding-behavior` → `references/architecture-governance.md` § Choosing the batch, and drop every candidate its § Not a finding list rejects. One batch per plan row.
3. **Prepare.** The batch is a normal plan: `specify → clarify → plan` per `mstar-phase-gates`, with the behaviour baseline landed before the move (`mstar-audit/references/codebase-audit.md` § Write the report states the behavior-preservation gates) and its AC carrying the closed-batch conditions as acceptance evidence — every live caller accounted for, the replaced path absent, the baseline observed, the rule landed on a constraint or recorded as an authorized residual. A caller the batch cannot migrate rejects the whole move; the old path is never kept alive beside the new one.
4. **Execute, lock, then review.** PM dispatches a development seat (SDD for multi-task); the batch lands the settled rule on the strongest available constraint (`constraint-ladder.md`) or records an authorized residual, then independent QC and PM Acceptance judge that complete move (`mstar-roles/references/project-manager/acceptance.md`).
5. **Next batch.** Record the batch's net complexity, re-run discovery over the current tree so the next ranking reflects the accepted batch, then repeat steps 2–4 until a stop condition fires. Invoking this command is the opt-in for running successive batches without a confirmation prompt between them; it is not approval for a merge (that authorization belongs to the delivery path), a destructive migration, or a product or architecture decision. A destructive migration or a required product or architecture decision captures an issue and ends the round per that reference's § Stop conditions.

## Close-out

Report each batch as: the move; the parallel path, scatter or layer it removed; the caller churn; the behaviour baseline that proved preservation; the constraint now holding the rule or the residual it left; and the stop condition that ended the round. The remaining pool lives in the issue store, accepted structural decisions in `{ADR_DIR}`, and the plan rows remain the delivery record.
