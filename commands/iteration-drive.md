---
name: iteration-drive
description: Drive the active iteration to completion — run the Autonomous Execute loop (Phase 2 of mstar-iteration) until all plans are Done, then run iteration-close (Phase 3: compound + compass + roadmap update) on the integration branch, then create PR to the recorded target branch
agent: project-manager
---

# Drive Iteration

Drive the active Morning Star iteration forward. The canonical flow is in **`mstar-iteration`** — this command loads it and executes its phases.

## Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `skills/pm/SKILL.md` → **§ Host entry** + **§ Boot**（PM role identity + dispatch-first rules）
4. `mstar-iteration` → **§ Phase 2** + **§ Phase 3**（close 为独立 gate，§3.0–§3.5）
5. `mstar-compound` — Phase 3 §3.2 前加载（含 Phase 6 索引登记）
6. `mstar-dispatch-gates` + host reference
7. `mstar-plan-artifacts`, `mstar-plan-conventions`, `mstar-branch-worktree`

## Phase 2: Autonomous Execute

**Branch policy first** — before any plan dispatch（`mstar-iteration` §2.3）:

| Field | SSOT | If missing |
|-------|------|------------|
| `iteration_base_branch` | `status.json` `metadata` → compass frontmatter | **STOP** — ask user; **never** default `main` |
| `spec_integration_branch` | plan `metadata` | backfill from iteration-start / compass |
| `target_branch` | `status.json` `metadata` → compass frontmatter | **STOP** — ask user |

Execute **`mstar-iteration` § Phase 2** exactly. Summary:

1. **Precondition gate** (§ 2.0) — **four** checks（含 branch metadata #4）
2. **Session todos** (§ 2.1) — set host todos per plan wave
3. **Read backlog** (§ 2.2) — `status.json` + branch metadata
4. **Integration branch** (§ 2.3) — `git checkout -b <spec_integration_branch> <iteration_base_branch>` when creating（**not** implicit `main`）
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

当 **every** plan 为 `Done` 时，**STOP** per-plan loop，打印 `## Phase 3: iteration-close`，按 **`mstar-iteration` § Phase 3** 逐步执行。final plan 的 closure 只能提供输入，不能替代 close gate。

| Step | Section | 要点 |
|------|---------|------|
| 1 | §3.0 / §3.0.5 | Phase 边界；legacy compass 规范化（frontmatter + `## Roadmap Position`） |
| 2 | §3.1 | 打印 close entry checklist，全部 `[x]` |
| 3 | §3.2 | Compound；新增 doc 完成 `mstar-compound` Phase 6（`{KNOWLEDGE_DIR}/README.md`） |
| 4 | §3.3 | `## Roadmap Position` current iteration → `delivered`；STRATEGY/tracker 按需更新 |
| 5 | §3.4 | frontmatter `status: completed` + `end_date`；Compound Summary + Retrospective |
| 6 | §3.5 | 打印 close exit checklist → commit → push |

```bash
git add {ITERATION_DIR}/ {KNOWLEDGE_DIR}/ CONCEPTS.md
git commit -m "chore(iteration): close <iteration-id> — compound round, roadmap update"
git push origin <spec_integration_branch>
```

**Not Done until**: §3.5 checklist `[x]` + compass frontmatter `completed`.

## Completion: Create PR

All iteration-close changes committed to integration branch:

- Resolve PR target: `status.json` → `metadata.target_branch`（fallback：compass frontmatter `target_branch`）
- If missing → **stop and ask**; never default `main` / `master`
- Create PR: `spec_integration_branch` → `target_branch`
- Report summary: plans completed, compound round（结晶文档数）, target branch, PR link

PR 合并后（babysit loop 或手动），本次迭代完整结束。
