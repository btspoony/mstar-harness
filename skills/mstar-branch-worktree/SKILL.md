---
name: mstar-branch-worktree
description: Morning Star business-repo Git feature branches, same-repo concurrent `git worktree` isolation, plan/Spec integration branches, and QC/QA checkout alignment (`Review cwd`, `Working branch`, `plan_id`, `Review range` / `Diff basis` must match verbatim across three QC reviewers and QA). Read when PM writes `Working branch` / `Branch policy`, two or more writable streams touch one repo, dispatching QC tri-review or QA after merging to a single `HEAD`, dev/QA/ops before first `git commit`, or explaining worktree paths. Required for `@project-manager` parallel implement or pre-QC orchestration; `@fullstack-dev*` / `@frontend-dev` / `@qa-engineer` / `@ops-engineer` on repo writes; `@qc-specialist*` before review. Does not replace the state machine (`mstar-harness-core`).
---

## Load order

**Before this skill:** Read `mstar-harness-core` (SKILL.md). On conflict, **`mstar-harness-core` wins**.

## Scope (summary)

- **Only PM decides branches**; other writable roles must not create branches or switch to `main` on their own.
- **Assignment must include one of**: `Working branch: <existing>` | `create <new> from <base>` | `Branch policy: direct on <branch> — <reason>`.
- **Same repo, ≥2 concurrent writable streams**: require `git worktree` (or equivalent isolation); PM documents **Worktree path** per stream.
- **Before QC/QA**: merge all in-scope commits to **one `Working branch` `HEAD`**; three QC assignments + QA share one **`Review cwd` + `plan_id` + `Review range` / `Diff basis`** (verbatim).

**Spec multi-plan naming** (`spec_integration_branch`, PR to `main`) → **`mstar-plan-conventions`**. This skill covers Git operations and checkout alignment.

Details, PM confirmation script, and “integration branch first, then worktrees” → **`references/branch-and-worktree.md`**.

## References

- `references/branch-and-worktree.md` — full branch gates, worktree rules, QC/QA handoff.
