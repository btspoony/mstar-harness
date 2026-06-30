---
name: iteration-drive
description: Drive the active iteration to completion — run the Autonomous Execute loop (Phase 2 of mstar-iteration) until all plans are Done, then run iteration-close (Phase 3: compound + compass + roadmap update) on the integration branch, then create PR to target branch (default main)
agent: project-manager
---

# Drive Iteration

Drive the active Morning Star iteration forward. The canonical flow is in **`mstar-iteration`** — this command loads it and executes its phases.

## Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `skills/pm/SKILL.md` → **§ Host entry** + **§ Boot**（PM role identity + dispatch-first rules）
4. `mstar-iteration` → **§ Phase 2: Autonomous Execute**（per-plan dispatch loop）+ **§ Phase 3: iteration-close**（compound + compass）
5. `mstar-dispatch-gates` + host reference
6. `mstar-plan-artifacts`, `mstar-plan-conventions`, `mstar-branch-worktree`

## Phase 2: Autonomous Execute

Execute **`mstar-iteration` § Phase 2** exactly. Summary:

1. **Precondition gate** (§ 2.0) — three checks before entering
2. **Session todos** (§ 2.1) — set host todos per plan wave
3. **Read backlog** (§ 2.2) — `status.json` + `spec_integration_branch`
4. **Integration branch** (§ 2.3) — checkout/create
5. **Per-plan loop** (§ 2.4) — for each non-`Done` plan:
   - Create plan feature branch from integration
   - Dispatch implement subagents (dispatch-first)
   - Update `status.json` + main plan after each Completion Report v2
   - QC tri-review + QA per `mstar-review-qc`
   - Merge plan branch → integration branch
   - Cross-plan progress sync → compass
   - Next plan
6. Repeat until **all** plans `Done` → exit loop, enter Phase 3

**Dispatch-first constraint** (§ 2.5): PM never implements directly; `1 Assignment ⇒ 1 invoke`.

## Phase 3: iteration-close

When every plan is `Done`, execute **`mstar-iteration` § Phase 3**:

1. **前置检查** (§ 3.1) — all plans Done, residuals closed, compass synced
2. **Compound 轮** (§ 3.2) — 收集素材 → 自检清单（Q1-Q8）→ `mstar-compound` → CONCEPTS.md
3. **更新 compass** (§ 3.3-3.4) — status → completed, roadmap, compound summary, retrospective, index
4. **Commit** to integration branch:

```bash
git add {ITERATION_DIR}/ {KNOWLEDGE_DIR}/ CONCEPTS.md
git commit -m "chore(iteration): close <iteration-id> — compound round, roadmap update"
git push origin <spec_integration_branch>
```

## Completion: Create PR

All iteration-close changes committed to integration branch:

- Resolve PR target branch from `status.json` → `target_branch`（default `main`）
- Create PR from `spec_integration_branch` to target
- Report summary: plans completed, compound round（结晶文档数）, target branch, PR link

PR 合并后（babysit loop 或手动），本次迭代完整结束。
