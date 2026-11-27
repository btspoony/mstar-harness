# Architecture governance

A governance round targets the codebase's **shape**, not one feature: many small sites share one wrong structure, and each feature change either copies it or pays for it. The rules in `SKILL.md` still apply — a governance batch is a change like any other, and "the architecture needs it" is not a license to widen one batch into a rewrite.

## Target state

Assume the product launched on its first day today, with today's real requirements, constraints and product shape already known. Describe the codebase that state would have produced, then converge on it in safe, verifiable batches. The description is a direction, not a license to rewrite: a batch that cannot preserve the shipped behaviour is not a batch, it is a migration project needing its own plan and authority.

## The seven properties

Each property has a question that decides it and an owner file that answers it; do not restate an owner's method here.

| Property | The deciding question | Owner |
|---|---|---|
| Single source of truth | For this rule, definition, config or state, is there one authority, or does every caller restate it? | `SKILL.md` § Requirement-first simplicity (centralize sources of truth) |
| Canonical implementation | Does one semantic responsibility have exactly one implementation, or do a legacy path and its replacement both serve live callers? | `mstar-harness-core` § 核心研发守则 (remove obsolete paths, no compatibility layers) |
| Deep modules | Does this layer hide complexity behind a small interface, or forward calls and leak internals? | `mstar-roles/references/qc-specialist/deep-module-vocabulary.md` § The four tests |
| High cohesion, low coupling | Does each module own one responsibility, with dependencies pointing one way? | Same file — Depth Lens and Modularity Lens stay complementary |
| Locality of change | Does one business concept live in one place, or does changing it force edits across unrelated files? | `mstar-roles/references/qc-specialist/deep-review-lenses.md` |
| Deletion over accumulation | Can the batch delete the replaced path, or does it leave both live? | `deep-module-vocabulary.md` § Deletion test |
| Enforceable architecture | Is the settled rule held by a constraint a machine can see, or only by prose? | `constraint-ladder.md` |

**Deletion test.** Run `deep-module-vocabulary.md` § Deletion test on the batch's largest layer; its result is the batch's leverage, reported as a number rather than as lines removed.

## A batch is closed only when

- **A behaviour baseline exists before the move.** Existing tests pass unmodified; where coverage is thin, a characterization test lands first and is the evidence the migration preserves behaviour.
- **Every old implementation is migrated and deleted in the same batch.** Adding a new abstraction, directory or interface without migrating its callers is an open parallel path, not a batch. A caller the batch cannot reach stops that batch instead of licensing a dual-path period: name it, capture it per `mstar-project-governance` § Issue capture, and leave the old path as the only path until a batch can carry the caller too.
- **The batch reports its own complexity, not its line count.** State what the move removed (call sites, parallel paths, layers) and what it added (interface surface, indirection). A net deletion with a wider interface is usually a regression wearing a smaller diff.
- **The settled rule lands on the strongest available constraint** (`constraint-ladder.md`) or is recorded as a residual. Prose in this file is the weakest level and never counts as enforcement.

## Choosing the batch

Generate candidate moves, then take the one with the **lowest total complexity**: the post-move code, the caller churn it forces, and the prose that must remain to cover what no constraint can see. A move that simplifies one module while scattering work across twelve callers is not the cheapest move, it is the cheapest local diff.

Prefer a batch that removes a parallel path over one that renames, re-wraps, re-prefixes or moves a directory while keeping both paths alive. A directory move alone changes no ownership, dependency direction or behaviour, so it earns nothing until it changes one of those.

## Not a finding

Reject a governance candidate whose only justification is one of these:

- An abstraction, base class or interface introduced for one or two call sites with no stated varying axis — that is the `Speculative` label in `deep-module-vocabulary.md`, never a blocking move.
- A directory or file move with no ownership, dependency-direction or responsibility change.
- Merging semantically different concepts because they now look alike — form symmetry is not a property above.
- Condensed code that trades readability for a smaller line count.
- A compatibility shim, deprecation alias or dual-path period offered as the safe option: it is the accumulation the round exists to remove.
- A full test-suite rerun or repository-wide scan used as evidence for a local move (`mstar-harness-core` § 定向执行与验证边界).

## Stop conditions

End the round — and say which one fired — when any holds:

- No candidate survives the rejection list with an evidence-backed net complexity reduction.
- The run budget is reached; report the completed batches and the remaining pool, not a partial batch.
- The next move needs a product decision, an architecture decision, or a destructive migration. Capture it as an issue per `mstar-project-governance` § Issue capture, mark it as needing a decision, and continue independent work. A captured decision is not authority to act on it.
- No behaviour baseline can be established for the affected surface. That batch is blocked with the missing evidence named; continue with the other candidates.

## Progress carriers

Do not invent a new ledger. A batch is a normal plan row: the main plan carries the batch list and status, `{ADR_DIR}` carries each accepted structural decision (`mstar-doc-corpus/references/adr.md`), the issue store is the optimisation pool, and the branch/worktree rules for each batch are `mstar-branch-worktree`. When the round runs under an iteration, batch plans are its business plans and its normal close applies.
