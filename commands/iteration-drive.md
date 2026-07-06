---
name: iteration-drive
description: Drive the active iteration to completion — Phase 2 Autonomous Execute, Phase 3 iteration-close, Phase 4 Create PR, Phase 5 PR merge-ready loop (greploop / babysit / CI fallback) until mergeable. Not Done until Phase 5 exit checklist passes.
agent: project-manager
---

# Drive Iteration

Drive the active Morning Star iteration forward. **Boot loads skills; this command sequences Phase 2 → 3 → 4 → 5.** Phase gate SSOT → **`mstar-iteration`** §2–§5；本 command 仅补充 **可选第三方 helper skill 发现**（Phase 5），不反向写入 `mstar-*`。

## Phase state machine（禁止跳步）

```
Phase 2: Autonomous Execute  →  Phase 3: iteration-close  →  Phase 4: Create PR  →  Phase 5: PR merge-ready
   (per-plan dispatch loop)        (独立 gate)                  (开 PR)              (loop 至 mergeable)
```

| 当前状态 | 允许 | 禁止 |
|----------|------|------|
| 存在非 `Done` plan | Phase 2：dispatch implement / QC / QA | 进入 Phase 3 或开 PR |
| **全部** plan `Done` | **立刻** `## Phase 3: iteration-close`（§3.0→§3.5） | 宣称 iteration-drive 完成、开 PR、结束会话 |
| Phase 3 exit checklist 全 `[x]` + compass `status: completed` | 进入 **Phase 4: Create PR** | 跳过 compound / roadmap / frontmatter |
| PR 已创建 | **Phase 5** merge-ready loop（§5） | 汇报「迭代结束」、停止 host todos |
| Phase 5 exit checklist 全 `[x]` | **iteration-drive Done**；报告 PR link + merge-ready 证据 | — |

**Done 定义**：**仅** Phase 5 §5.5 exit checklist 全 `[x]`。**Phase 3 close ≠ Done；Phase 4 开 PR ≠ Done。**

## PM invariants（Phase 2–5 全程有效）

| 禁止（PM 线程） | 必须 |
|-----------------|------|
| Write/Edit/Shell 产品代码、写测试、跑 QC 审查（Phase 2） | 每条 implement/QC/QA Assignment ⇒ **1 次 `Task`** |
| 只写 Assignment 就进入下一 gate | 同轮 dispatch：`Subagent invokes issued: N`（N = Assignment 条数） |
| 最后一个 plan `Done` 后直接开 PR / 汇报结束 | **Phase 3 → 4 → 5** 顺序执行 |
| Phase 4 开 PR 后停止 | Phase 5 loop 至 merge-ready；**禁止**未过 §5.5 就结束会话 |
| Phase 5 自己改产品代码 | 需改产品代码时 **dispatch** `@fullstack-dev` / `@ops-engineer` |

派发细则 → **`mstar-dispatch-gates`** + **`mstar-host`**。Phase 3 细则 → **`mstar-iteration` §3** + **`mstar-compound`**。

**Session todos**：

| Todo id | 何时追加 | 何时可勾掉 |
|---------|----------|------------|
| plan-wave todos | 进入 Phase 2 | 各 plan `Done` |
| `phase-3-iteration-close` | 仅剩 1 个非 `Done` plan | Phase 3 §3.5 exit 全 `[x]` |
| `phase-4-create-pr` | Phase 3 完成后 | PR 已创建并记录 URL/number |
| `phase-5-pr-merge-ready` | Phase 4 完成后 | Phase 5 §5.5 exit 全 `[x]` |

## Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `skills/pm/SKILL.md` → **§ Host entry** + **§ Boot**（PM role identity + dispatch-first rules）
4. `mstar-iteration` → **§ Phase 2–5**（§3 close gate；§4 PR delivery；§5 merge-ready loop）
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
6. Repeat until **all** plans `Done` → **STOP**（见 Phase state machine）→ 打印 `## Phase 3: iteration-close` → 执行 **`mstar-iteration` §3**；**不得**进入 Phase 4

派发回合纪律 → **`mstar-dispatch-gates`** + **`mstar-iteration` §2.5**。

## Phase 3: iteration-close

当 **every** plan 为 `Done` 时：

1. **STOP** per-plan loop — 不得开 PR、不得进入 Phase 4/5、不得输出「迭代完成」摘要。
2. 打印标题 **`## Phase 3: iteration-close`**（用户可见的 phase 边界）。
3. 按 **`mstar-iteration` § Phase 3** 逐步执行 §3.0→§3.5。final plan 的 closure 只能提供输入，不能替代 close gate。
4. §3.5 exit checklist 全 `[x]` 且 compass frontmatter `status: completed` 后 → 打印 **`## Phase 4: Create PR`** → 执行下方 Phase 4。

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

**Phase 3 exit（非 iteration-drive Done）**: §3.5 checklist `[x]` + compass frontmatter `completed`。

## Phase 4: Create PR

Execute **`mstar-iteration` § Phase 4**（PR delivery gate）。本 command 步骤摘要：

1. 打印 **`## Phase 4: Create PR`**
2. Resolve PR target: `status.json` → `metadata.target_branch`（fallback：compass frontmatter `target_branch`）
3. If missing → **stop and ask**; never default `main` / `master`
4. Create PR: `spec_integration_branch` → `target_branch`
5. Record PR URL + number（Phase 5 SSOT for this session）
6. 勾掉 host todo `phase-4-create-pr`
7. **Immediately** 打印 **`## Phase 5: PR merge-ready`** → 执行下方 Phase 5（**禁止**在此停止或汇报 Done）

**Phase 4 exit（非 iteration-drive Done）**: PR 已创建且 head = `spec_integration_branch`。

## Phase 5: PR merge-ready（babysit loop）

Execute **`mstar-iteration` § Phase 5**（merge-ready loop SSOT）。**§5.5 exit 全 `[x]` = iteration-drive Done.**

本 command **叠加**可选 helper skill 发现（**non-`mstar-*`**；不写入 `mstar-*` load order）：

### 5.0 Discover optional helper skills

Before the first loop pass, search for bundled/host skills（first readable `SKILL.md` wins per name）:

| Skill | Search paths（示例，按宿主扩展） |
|-------|----------------------------------|
| `greploop` | `skills/greploop/SKILL.md`；`~/.cursor/skills-cursor/greploop/SKILL.md`；`~/.agents/skills/greploop/SKILL.md`；Codex plugin `skills/greploop/` |
| `babysit` | `skills/babysit/SKILL.md`；`~/.cursor/skills-cursor/babysit/SKILL.md`；`~/.agents/skills/babysit/SKILL.md` |

**Mode selection**:

| Priority | Condition | Read before loop | Primary done signal |
|----------|-----------|------------------|---------------------|
| 1 | `greploop` found | `greploop` SKILL.md | Greptile score **5/5** on this PR |
| 2 | else `babysit` found | `babysit` SKILL.md | Required CI **all green** + **all** review threads **resolved** |
| 3 | else neither | —（本 command §5.2–§5.4） | Required CI **all green** + **all** review threads **resolved** |

**Both greploop and babysit present**: run greploop until **5/5**, then babysit until CI green + reviews resolved（串行；§5.5 仍须满足全部 exit 项）.

**All modes** share §5.5 exit checklist（CI + reviews + mergeable；Greptile 5/5 按 mode / repo 条件）.

### 5.1 PM invariants（Phase 5）

| 禁止 | 必须 |
|------|------|
| 改 CI workflow 只为「让检查变绿」 | 仅修 **本 PR 范围内** 引起的失败；workflow 变更需用户明确授权 |
| 未 comment + resolve 就宣称 review 已处理 | 每次 push 针对 review 的修复 → §5.3 |
| §5.5 未全 `[x]` 就结束会话 | 循环直至 merge-ready |

Fixes **push 到 `spec_integration_branch`**（PR head）；禁止另开分支替代。

### 5.2 Loop（all modes）

Repeat until §5.5 exit checklist passes:

1. **Status** — `gh pr view <number> --json mergeable,mergeStateStatus,statusCheckRollup,reviewDecision`（或宿主等价 API）
2. **Merge conflicts** — if blocking: resolve on integration branch（意图冲突 → **Blocked**，问用户）→ push
3. **Active reviews** — fetch **unresolved** review threads only；triage valid change requests
4. **CI** — list failing required checks；dispatch or fix in-scope → push
5. **Mode-specific pass**:
   - **greploop**: follow greploop SKILL until Greptile **5/5**
   - **babysit**: follow babysit SKILL（comments + CI loop）
   - **fallback**: triage unresolved review threads（§5.3）+ poll CI until all required checks green（no skill Read；**与 babysit 同级的 CI + reviews 门禁**）
6. After each push → §5.3 → return to step 1

**Stop looping only when** §5.5 全 `[x]`。若多轮仍 blocked → 升级用户（列出 failing checks / unresolved threads / Greptile score）。

### 5.3 Review fix hygiene（HARD — all modes）

Whenever a push addresses PR review feedback（human or bot, including Bugbot / Greptile）:

1. **Comment** on the **same review thread** — 简述改动与验证（链接 commit / 文件）
2. **Resolve** the thread when the fix is complete and you stand behind the response
3. Re-fetch thread list — unresolved count must trend to **zero** before §5.5

Do not bulk-resolve without a per-thread reply. Disagree or uncertain → reply explaining why; leave unresolved and escalate.

### 5.4 Fallback mode detail（no greploop / babysit）

When neither skill is found, **本 command 承担 babysit 同级职责**（无外部 SKILL，但 exit 标准相同）:

1. Fetch **unresolved** review threads；triage valid change requests → dispatch fix → push → §5.3 comment + resolve
2. Poll PR required checks until **all green**（reasonable backoff between polls）
3. On CI failure: diagnose → dispatch implement/ops if code fix needed → push → poll again
4. Do **not** exit until **both** CI green **and** all review threads resolved（或用户书面 waive）
5. Do **not** exit on first green if new commits or reviews reopened checks

### 5.5 Phase 5 exit checklist（iteration-drive Done）

与 **`mstar-iteration` §5.2** 对齐；打印 checklist 并全 `[x]` 后结束本 command：

- [ ] PR mergeable（无 blocking merge conflicts）
- [ ] All **required** CI checks green on latest head
- [ ] All review threads **resolved**（或用户书面 waive 特定 thread）
- [ ] Greptile **5/5**（若运行了 greploop mode，或 repo 启用 Greptile 且 PR 上可见分数）
- [ ] §5.3 comment + resolve 已完成于本轮所有 addressed reviews
- [ ] Host todo `phase-5-pr-merge-ready` 可勾选

**Then** report: iteration id, plans completed, compound summary, PR link, merge-ready evidence（CI snapshot + review resolution + Greptile if applicable）.

PR merge itself may still be manual or a separate host action unless user authorized auto-merge.
