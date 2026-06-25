---
name: iteration-drive
description: Drive the active iteration to completion — run the PM Autonomous Execute loop (implement → QC → QA → Done) until all plans are Done, then optionally create PR to main
agent: project-manager
---

# Drive Iteration

Drive the active Morning Star iteration forward. Run the **Autonomous Execute driver** from `skills/pm/SKILL.md` (`§ Autonomous Execute driver`) to advance all non-`Done` plans to completion.

## Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `skills/pm/SKILL.md` → focus on **§ When to activate autonomous Execute** and **§ Autonomous Execute driver**
4. `mstar-dispatch-gates` + host reference
5. `mstar-plan-artifacts`, `mstar-plan-conventions`, `mstar-branch-worktree`

## Precondition Gate

Check the three conditions from **§ When to activate autonomous Execute**:

1. `{HARNESS_DIR}/status.json` exists with at least one plan **not** `Done`
2. **Pre-implement gate = GO** (`plan` locked, tasks ready)
3. User intent is **continue Execute**

If any is **false** → stop. If Prepare is incomplete → tell the user to run `/iteration-start` first.

## Execute Loop

Follow **§ Autonomous Execute driver** from the PM skill exactly:

1. **Session todos** — set host todos for current `plan_id` + next gates
2. **Read backlog** — `status.json`, active plans, `primary_spec` / `spec_integration_branch`
3. **Checkout integration branch** — resolve or create from `status.json` metadata
4. **Per-plan loop** — for each non-`Done` plan:
   - Create plan feature branch from integration branch
   - Dispatch implement subagents (dispatch-first, no parent agent implementation)
   - Update `status.json` + main plan after each Completion Report
   - QC tri-review + QA per `mstar-review-qc`
   - Merge plan branch → integration branch
   - Move to next plan
5. Repeat until **all** plans in the iteration are `Done`

## Completion

When every plan is `Done` in `status.json`:

- Create a PR from `spec_integration_branch` to `main`
- Report a summary: plans completed, branch names, PR link
