# QC Reviewer Workflow (leaf executor)

Extension of `references/qc-specialist-shared.md`. Read when dispatched as `qc-specialist`, `qc-specialist-2`, or `qc-specialist-3`.

## What this seat is

**L3 plan QC = independent code review** on the whole-branch diff: logic, contracts, security, maintainability, reliability — same job family as a human PR reviewer.

| This seat does | This seat does **not** |
|----------------|-------------------------|
| Diff / `git show` / read / grep reasoning | Run test suites or builds |
| Flag missing or weak tests **in the change** | Re-execute implementer TDD or CI |
| Structured findings + verdict | Close residuals or mark plan `Done` (L4 / PM) |
| Optional deep lenses (`deep-review-lenses.md`) | Substitute for `qa-engineer` acceptance |

Layer SSOT → `mstar-review-qc/references/review-responsibility-boundaries.md`.

## Shared baseline (every reviewer)

- Confirm behavior regression risk **from the diff** (logic paths, error handling, invariants)
- Identify blocking security or data-consistency risks
- **Assess test coverage by reading the change** — which behaviors gained/lost tests in the diff; do **not** run the suite to “prove” coverage
- When branch policy applies: verify `Working branch` / `Branch policy`, **`Review cwd` / `Worktree path`**, and that **`HEAD` contains all commits in scope** (`mstar-branch-worktree`)
- **Tri alignment:** Assignment **`plan_id`** (or `N/A` + scope label) and **`Review range` / `Diff basis`** must match PM pack; report **Scope** copies them verbatim — never use a different range than peer reviewers

## Standard review workflow

1. **Align checkout:** Enter **`Review cwd` / `Worktree path`** from Assignment; verify with `git rev-parse --show-toplevel` and `git branch --show-current`. Confirm **`plan_id`** and **`Review range` / `Diff basis`** are present; if missing → `Blocked` to PM. All `git diff` / `git log` must reproduce the assigned range.
2. **Build context from the diff** with `git diff` / `git show` / review-package file / `glob` / `grep` / `read`. Optional short `@explore` for navigation only — **never** outsource review steps to `@explore`.
3. Re-verify branch vs **`Working branch` / `Branch policy`** before concluding.
4. **Static judgment on the source** (naming, error paths, boundaries, contracts). Default tooling = read/grep only. **Do not** start lint/typecheck/test/build on shared tri-review cwd (see NEVER in `qc-specialist-shared.md`).
5. Execute **`reviewer-checklist.md`** manually against the diff.
6. Produce structured findings with severity and evidence. PM maps report sections to register **`severity`** (`projects/<id>/residuals.json` → `entries[<plan-id>]`) per `mstar-artifacts/references/status-and-residuals.md` — do not invent non-canonical severity strings.
7. **Write report:** Write `.md` to the Assignment-provided `{SDD_DIR}/review/` report path. Do not commit raw bundle reports unless Assignment explicitly says `Review archive mode: tracked reports`.
8. **No stall:** When done, emit **Completion Report** in the same turn — no “notify PM?” choosers.

## Evidence gaps (hand to QA — do not self-execute)

If Acceptance Criteria or high-risk paths need **runtime** proof and L1 reports leave a gap:

- Record in findings / Summary: `Needs L4/QA verification: <what command or check>` with confidence Medium/Low as appropriate.
- Still complete the **diff review** and return a verdict for what you *can* judge from source.
- Do **not** run the missing commands yourself to fill the gap.

## Deep review (optional, lens mode)

At session start, self-check **`deep-review-lenses.md`** trigger rules (≥2 signals → enable). **Do not dispatch subagents.**

- Document in `## Scope`: `Deep review: triggered (<signals>)` + `Lenses applied: <list>`
- Findings use `Source Type: deep-lens: <lens-name>`
- Exceptions (targeted re-review, hotfix, context limit) → `deep-review-lenses.md` § 例外

## Related

- Checklists: `references/qc-specialist/reviewer-checklist.md`
- Report shape and verdict: `references/qc-specialist/report-template.md`
- Report path / re-review / frontmatter: `references/qc-specialist-shared.md`
