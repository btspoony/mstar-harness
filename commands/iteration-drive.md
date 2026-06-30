---
name: iteration-drive
description: Drive the active iteration to completion — run the PM Autonomous Execute loop (implement → QC → QA → Done) until all plans are Done, run iteration-close (compound + compass + roadmap update) on the integration branch, then create PR to target branch (default main)
agent: project-manager
---

# Drive Iteration

Drive the active Morning Star iteration forward. Run the **Autonomous Execute driver** from `skills/pm/SKILL.md` (`§ Autonomous Execute driver`) to advance all non-`Done` plans to completion, then close the iteration.

## Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `skills/pm/SKILL.md` → focus on **§ When to activate autonomous Execute** and **§ Autonomous Execute driver**
4. `mstar-iteration` → **§ Phase 2: iteration-drive**（跨 plan 进度追踪）+ **§ Phase 3: iteration-close**（收口 compound）
5. `mstar-dispatch-gates` + host reference
6. `mstar-plan-artifacts`, `mstar-plan-conventions`, `mstar-branch-worktree`

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

## Phase: iteration-close（所有 plan Done 后、开 PR 前）

When every plan is `Done` in `status.json`, **stop** the per-plan loop. Do NOT create the PR yet. Execute `mstar-iteration` § Phase 3: iteration-close on the integration branch:

### 前置检查（per `mstar-iteration` § 3.1）

- [ ] 所有 compass 中登记的 plan 状态均为 `Done`
- [ ] 所有 plan 的 residual findings 已收口
- [ ] `{ITERATION_DIR}/<iteration-id>-delivery-compass.md` 各 plan 状态已同步
- [ ] 迭代验收标准已达成或显式豁免

### Compound 轮（per `mstar-iteration` § 3.2）

1. **收集素材**：回顾本迭代所有 plan 的实现、debug、review，识别可结晶知识
2. **逐条自检**：对每条候选，使用 `mstar-compound` § 是否值得结晶 自检清单（Q1-Q8）
3. **结晶**：Yes ≥ 3 的条目调用 `mstar-compound` 写入 `{KNOWLEDGE_DIR}/`
4. **CONCEPTS.md 协同**：若有新领域词汇，更新 `<repo-root>/CONCEPTS.md`

### 更新 iteration compass（per `mstar-iteration` § 3.3-3.4）

1. 更新 compass frontmatter：`status: active` → `completed`，添加 `end_date`
2. 填写 `## Roadmap Position`：本批 → `delivered`，下批 → 更新
3. 填写 `## Compound Round Summary`（结晶文档数 / CONCEPTS 条目 / refresh 触发）
4. 填写 `## Iteration Retrospective`（最小回顾）
5. 更新 `{ITERATION_DIR}/README.md` 索引中该迭代 Status → `completed`

### Commit 到 integration branch

iteration-close 产出的所有文件变更（compass、knowledge docs、CONCEPTS.md、README.md 更新等）必须 commit 到当前 integration branch：

```bash
git add {ITERATION_DIR}/ {KNOWLEDGE_DIR}/ CONCEPTS.md  # 精确路径按实际变更
git commit -m "chore(iteration): close <iteration-id> — compound round, roadmap update"
git push origin <spec_integration_branch>
```

### 状态管理 SSOT

| 状态 | 存储位置 |
|------|---------|
| 迭代状态 | `{ITERATION_DIR}/<id>-delivery-compass.md` frontmatter `status` + `{ITERATION_DIR}/README.md` 索引 |
| per-plan 状态 | `{HARNESS_DIR}/status.json`（不变，所有 plan 已是 Done） |
| 知识文档 | `{KNOWLEDGE_DIR}/<category>/<slug>.md`（索引在 `{KNOWLEDGE_DIR}/README.md`） |

## Completion: Create PR

iteration-close 完成且所有变更已 commit 到 integration branch 后：

- Resolve the PR target branch from iteration metadata: `status.json` → `target_branch`. Default to `main` if not set.
- Create a PR from `spec_integration_branch` to the resolved `target_branch`
- Report a summary: plans completed, compound round（结晶文档数）, target branch, PR link

PR 合并后（babysit loop 或手动），本次迭代完整结束。
