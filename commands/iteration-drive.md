---
name: iteration-drive
description: Drive the active iteration to completion — run the Autonomous Execute loop (Phase 2 of mstar-iteration) until all plans are Done, then run iteration-close (Phase 3: compound + compass + roadmap update) on the integration branch, then create PR to the recorded target branch
agent: project-manager
---

# Drive Iteration

Drive the active Morning Star iteration forward. **Boot loads skills; this command sequences Phase 2 → Phase 3 → PR.** Domain SSOT → **`mstar-iteration`**.

## Phase state machine（禁止跳步）

```
Phase 2: Autonomous Execute  →  Phase 3: iteration-close  →  Completion: PR
   (per-plan dispatch loop)        (独立 gate，非 final plan)      (close 之后)
```

| 当前状态 | 允许 | 禁止 |
|----------|------|------|
| 存在非 `Done` plan | Phase 2：dispatch implement / QC / QA | 进入 Phase 3 或开 PR |
| **全部** plan `Done` | **立刻** `## Phase 3: iteration-close`（§3.0→§3.5） | 宣称 iteration 完成、写 PR、结束会话 |
| Phase 3 exit checklist 全 `[x]` + compass `status: completed` | `git commit` → push → PR | 跳过 compound / roadmap / frontmatter |

**常见误判**：final plan 的 closure notes、compound 草稿、roadmap 口头更新 **≠** iteration-close。必须打印 §3.1 entry + §3.5 exit checklist。

## PM invariants（Phase 2 全程有效）

| 禁止（PM 线程） | 必须 |
|-----------------|------|
| Write/Edit/Shell 产品代码、写测试、跑 QC 审查 | 每条 implement/QC/QA Assignment ⇒ **1 次 `Task`** |
| 只写 Assignment 就进入下一 gate | 同轮 dispatch：`Subagent invokes issued: N`（N = Assignment 条数） |
| 最后一个 plan `Done` 后直接 PR / 汇报结束 | **先** Phase 3（`mstar-iteration` §3），**再** PR（见 Completion） |

派发细则 → **`mstar-dispatch-gates`** + **`mstar-host`**。Phase 3 细则 → **`mstar-iteration` §3** + **`mstar-compound`**。

**Session todos**：进入 Phase 2 时设 plan-wave todos；当仅剩 1 个非 `Done` plan 时 **追加** `phase-3-iteration-close`（`mstar-iteration` §2.1）；§3.5 完成前不得勾掉。

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
6. Repeat until **all** plans `Done` → **STOP**（见 Phase state machine）→ 打印 `## Phase 3: iteration-close` → 执行 **`mstar-iteration` §3**；**不得**开 PR

派发回合纪律 → **`mstar-dispatch-gates`** + **`mstar-iteration` §2.5**。

## Phase 3: iteration-close

当 **every** plan 为 `Done` 时：

1. **STOP** per-plan loop — 不得合并 plan 分支、写 PR、或输出「迭代完成」摘要。
2. 打印标题 **`## Phase 3: iteration-close`**（用户可见的 phase 边界）。
3. 按 **`mstar-iteration` § Phase 3** 逐步执行 §3.0→§3.5。final plan 的 closure 只能提供输入，不能替代 close gate。
4. §3.5 exit checklist 全 `[x]` 且 compass frontmatter `status: completed` 后，才进入下方 **Completion: Create PR**。

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

**Precondition（HARD）**: Phase 3 complete — §3.5 exit checklist 全 `[x]`；compass YAML `status: completed` + `end_date`；compound Phase 6 索引已登记（或已记录无可结晶原因）。**不满足 → 禁止开 PR。**

All iteration-close changes committed to integration branch:

- Resolve PR target: `status.json` → `metadata.target_branch`（fallback：compass frontmatter `target_branch`）
- If missing → **stop and ask**; never default `main` / `master`
- Create PR: `spec_integration_branch` → `target_branch`
- Report summary: plans completed, compound round（结晶文档数）, target branch, PR link

PR 合并后（babysit loop 或手动），本次迭代完整结束。
