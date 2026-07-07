# QC Reviewer Workflow (leaf executor)

Extension of `references/qc-specialist-shared.md`. Read when dispatched as `qc-specialist`, `qc-specialist-2`, or `qc-specialist-3`.

## Shared baseline (every reviewer)

- Confirm behavior regression explicitly
- Identify blocking security or data-consistency risks
- Assess test coverage for changed behavior
- When branch policy applies: verify `Working branch` / `Branch policy`, **`Review cwd` / `Worktree path`**, and that **`HEAD` contains all commits in scope** (`mstar-branch-worktree`)
- **Tri alignment:** Assignment **`plan_id`** (or `N/A` + scope label) and **`Review range` / `Diff basis`** must match PM pack; report **Scope** copies them verbatim — never use a different range than peer reviewers

## Standard review workflow

1. **Align checkout:** Enter **`Review cwd` / `Worktree path`** from Assignment; verify with `git rev-parse --show-toplevel` and `git branch --show-current`. Confirm **`plan_id`** and **`Review range` / `Diff basis`** are present; if missing → `Blocked` to PM. All `git diff` / `git log` must reproduce the assigned range.
2. Build context with `git diff` / `git show` / `glob` / `grep` / `read`. Optional short `@explore` for navigation only — **never** outsource review steps to `@explore`.
3. Re-verify branch vs **`Working branch` / `Branch policy`** before concluding.
4. Run project lint and static analysis for the change.
5. Execute **`reviewer-checklist.md`** manually.
6. Produce structured findings with severity and evidence. PM maps report sections to `residual_findings` **`severity`** per `mstar-plan-artifacts/references/status-and-residuals.md` — do not invent non-canonical severity strings.
7. **Commit report:** Write `.md` under `{PLAN_DIR}/reports/<plan-id>/`; `git add` **only** report paths; `git commit`; real `git log -1 --oneline` in Completion Report.
8. **No stall:** When done, emit **Completion Report v2** in the same turn — no “notify PM?” choosers.

## Deep review (optional, lens mode)

At session start, self-check **`deep-review-lenses.md`** trigger rules (≥2 signals → enable). **Do not dispatch subagents.**

- Document in `## Scope`: `Deep review: triggered (<signals>)` + `Lenses applied: <list>`
- Findings use `Source Type: deep-lens: <lens-name>`
- Exceptions (targeted re-review, hotfix, context limit) → `deep-review-lenses.md` § 例外

## Related

- Checklists: `references/qc-specialist/reviewer-checklist.md`
- Report shape and verdict: `references/qc-specialist/report-template.md`
- Report path / re-review / frontmatter: `references/qc-specialist-shared.md`
