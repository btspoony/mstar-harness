---
name: iteration-drive
description: Drive the active iteration to completion — Phase 2 Autonomous Execute, Phase 3 iteration-close, Phase 4 Create PR, Phase 5 PR merge-ready loop (prefer babysit/*-babysit; optional greploop when repo has it; else CI fallback) until mergeable. Not Done until Phase 5 exit checklist passes.
agent: project-manager
---

# Drive Iteration

Drive the active Morning Star iteration forward. **Boot loads skills; this command sequences Phase 2 → 3 → 4 → 5.** Phase gate SSOT → **`mstar-iteration`** §2–§5；本 command 仅补充 **可选第三方 helper skill 发现**（Phase 5），不反向写入 `mstar-*`。

## Phase flow（禁止跳步）

`Phase 2: Autonomous Execute → Phase 3: iteration-close → Phase 4: Create PR → Phase 5: PR merge-ready`。Transition gates（HARD）→ **`mstar-iteration`** **Phase transition gates** table。

**Done 定义**：**仅** Phase 5 §5.5 exit checklist 全 `[x]`。**Phase 3 close ≠ Done；Phase 4 开 PR ≠ Done。**

## Continuous execution（HARD — Phase 2–5）

Execute **`mstar-iteration` §2.6**（Continuous execution SSOT：自 Phase 2 进入至 Phase 5 §5.5 exit 前 PM **连续编排**，进度汇报后下一条必须是 dispatch 或下一 phase 步骤，不向用户例行 yes/no check-in）。

**合法 STOP（仅此升级用户）**：

- §2.0 / Phase 4 branch metadata 缺失（`iteration_base_branch` / `target_branch`）
- **`Blocked`**：真冲突、secrets、不可逆范围缺口、Phase 5 多轮仍无法 merge-ready
- 用户本轮显式打断

**Turn 收束纪律**：若 host 即将结束本轮，最后一条 assistant 内容必须是 **in-flight 动作**（invoke 已发出、或写明下一 dispatch 的 Assignment 字段），**不得**以对用户的确认问句结尾。

## PM invariants（Phase 2–5 全程有效）

| 禁止（PM 线程） | 必须 |
|-----------------|------|
| Write/Edit/Shell 产品代码、写测试、跑 QC 审查（Phase 2） | 每条 implement/QC/QA Assignment ⇒ **1 次 `Task`** |
| **多 task plan 用 inline 大包派发**（整份 plan / T1–Tn 贴进一个 dev Assignment） | **SDD**：`mstar-sdd` per-task 循环 — `task-brief` → implementer → `review-package` → task reviewer → `progress.md` |
| 只写 Assignment 就进入下一 gate | 同轮 dispatch：`Subagent invokes issued: N`（N = Assignment 条数） |
| 最后一个 plan `Done` 后直接开 PR / 汇报结束 | **Phase 3 → 4 → 5** 顺序执行 |
| Phase 4 开 PR 后停止 | Phase 5 loop 至 merge-ready；**禁止**未过 §5.5 就结束会话 |
| Phase 5 自己改产品代码 | 需改产品代码时 **dispatch** `fullstack-dev` / `ops-engineer` |

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
3. `mstar-iteration` → **§ Phase 2–5**（§3 close gate；§4 PR delivery；§5 merge-ready loop）
4. `mstar-compound` — Phase 3 §3.2 前加载（含 Phase 6 索引登记）
5. `mstar-dispatch-gates` + host reference
6. **`mstar-sdd`** — **before first implement dispatch** in Phase 2（per-task loop SSOT；多 task plan 默认 `Execution mode: sdd`）
7. `mstar-review-qc` — before first QC dispatch in Phase 2
8. `mstar-plan-artifacts`, `mstar-plan-conventions`, `mstar-branch-worktree`
9. **`mstar-iteration/references/phase-2-worktree-lease.md`** — Phase 2 control worktree、`execution_lease`、serial `integration_merge_lease`（§2.0 #5 未 waive）

## Phase 2: Autonomous Execute

**Continuous execution applies**（上节）。Execute **`mstar-iteration` § Phase 2** exactly：§2.0 前置五道闸（含 branch metadata #4 + control-worktree/lease #5）→ §2.1 session todos → §2.2 read backlog（`status.json` + branch metadata）→ §2.3 integration branch + control worktree（record `metadata.control_worktree_path`；status/SDD via control path）→ §2.4 per-plan loop（**lease-gated parallel** across plan IDs unless `Plan parallelism: serial`；claim/resume `execution_lease`；feature worktree；**SDD** per-task 串行；QC full tri-review **N=3** + QA；serial merge via `integration_merge_lease`；cross-plan sync → compass）→ §2.5 dispatch-first → §2.6 push 纪律。全部 plan `Done` → **STOP**（Phase flow）→ 打印 `## Phase 3: iteration-close`；**不得**进入 Phase 4。

**Assignment preflight**（`mstar-harness` bin 未安装时静默跳过）: 在每次 implement/QC/QA 派发前（**SDD** 下为最新 `{SDD_DIR}/task-N-brief.md` 或临时写盘的 Assignment），若本机装有 CLI，校验最新 Assignment。模式由迭代 compass frontmatter 的 `enforcement` 键决定（Slice 5）：

- **默认（compass 无 `enforcement: hard`）— 可选 warn-only**：exit 1 仅提示，不阻断派发（Slice 3 行为不变）：

```bash
command -v mstar-harness >/dev/null 2>&1 && mstar-harness dispatch validate "<latest-assignment-file>"
```

- **`enforcement: hard`（迭代 compass frontmatter 声明）— fail-fast**：校验失败即 `exit 1` 阻断派发（bin 缺失仍静默跳过）：

```bash
if command -v mstar-harness >/dev/null 2>&1; then mstar-harness dispatch validate "<latest-assignment-file>" || exit 1; fi
```

> 路径必须加引号且替换为具体文件（如最新 `{SDD_DIR}/task-N-brief.md`，勿留尖括号）——agent 代入的路径不得进入 shell 无引号展开（qc2 W-2）。

## Phase 3: iteration-close

当 **every** plan 为 `Done`：

1. **STOP** per-plan loop — 不得开 PR、不得进入 Phase 4/5、不得输出「迭代完成」摘要。
2. 打印标题 **`## Phase 3: iteration-close`**（用户可见的 phase 边界）。
3. Execute **`mstar-iteration` § Phase 3**（→ **`references/phase-3-iteration-close.md`** §3.0→§3.5）：§3.0.5 compass 规范化 → §3.1 close entry checklist（**HARD GATE**，必须打印）→ §3.2 compound + **`<iteration-id>/` package promotion**（`mstar-compound` Phase 6 索引登记）→ §3.3 roadmap → §3.4 frontmatter `status: completed` + `end_date` → §3.5 close exit checklist + commit → push。
4. §3.5 exit 全 `[x]` 且 compass `status: completed` 后 → 打印 **`## Phase 4: Create PR`**。

**Phase 3 exit（非 iteration-drive Done）**: §3.5 checklist `[x]` + compass frontmatter `completed`。

## Phase 4: Create PR

Execute **`mstar-iteration` § Phase 4**（→ **`references/phase-4-5-pr-delivery.md`**）：打印 `## Phase 4: Create PR` → resolve `metadata.target_branch`（compass fallback；缺失 → **STOP**，never default `main`/`master`）→ 创建 PR `spec_integration_branch` → `target_branch` → 记录 PR URL + number（Phase 5 SSOT）→ 勾掉 host todo `phase-4-create-pr` → **Immediately** 打印 **`## Phase 5: PR merge-ready`**（**禁止**在此停止或汇报 Done）。

**Phase 4 exit（非 iteration-drive Done）**: PR 已创建且 head = `spec_integration_branch`。

## Phase 5: PR merge-ready（babysit loop）

Execute **`mstar-iteration` § Phase 5**（→ **`references/phase-4-5-pr-delivery.md`** §5.0–§5.2；**§5.1a push cadence HARD**）。**§5.5 exit 全 `[x]` = iteration-drive Done.**

本 command **叠加**可选 helper skill 发现（**non-`mstar-*`**；不写入 `mstar-*` load order）：

### 5.0 Discover optional helper skills

Helper 搜索路径 → **`mstar-iteration/references/phase5-helper-discovery.md`**（babysit / `*-babysit` / greploop 路径清单；first readable `SKILL.md` wins per name）。

| Priority | Condition | Read before loop | Primary done signal |
|----------|-----------|------------------|---------------------|
| 1 | `babysit` **or** any `*-babysit` found | that skill’s `SKILL.md`（prefer exact `babysit`, else first matching `*-babysit`） | Required CI **all green** + **all** review threads **resolved** |
| 2 | `greploop` found **and** repo has Greptile/greploop | `greploop` SKILL.md | Greptile score **5/5** on this PR（**additive** — does not replace priority-1 gates） |
| 3 | else neither babysit/`*-babysit` | —（fallback = babysit 同级 CI + reviews 门禁） | Required CI **all green** + **all** review threads **resolved** |

**Both babysit/`*-babysit` and greploop apply**: run **babysit/`*-babysit` first**（CI + reviews），then optional greploop until Greptile **5/5**（串行；§5.5 仍须满足全部 exit 项）。Do **not** prefer greploop over babysit。**No greploop / repo without Greptile**: skip greploop entirely。**All modes** share §5.5 exit checklist（Greptile 5/5 only when greploop mode ran or repo shows a Greptile score）。

### 5.1 Loop + review fix hygiene（all modes）

Execute **`mstar-iteration` §5.1 loop**（`references/phase-4-5-pr-delivery.md` §5.1）：status（`gh pr view <number> --json mergeable,mergeStateStatus,statusCheckRollup,reviewDecision` 或宿主等价 API）→ merge conflicts → unresolved reviews → CI → **§5.1a idle push**（一批修复一次 push）→ mode-specific pass（babysit SKILL / greploop / fallback）→ §5.1 review fix hygiene（**comment on same thread + resolve**）→ repeat until §5.5。Fixes **push 到 `spec_integration_branch`**（PR head）；禁止另开分支替代。**Checkout（HARD，§5.0）**：直接在 control / 集成分支 checkout 上修；**禁止**另开 Phase 5 fix worktree，**禁止**套用 Phase 2 control 产品编辑禁令。产品代码修复 → **dispatch** dev/ops（Assignment cwd = control）；PM 线程不代写。**禁止**为「让 CI 变绿」而改 workflow，除非用户明确授权。多轮仍 blocked → 升级用户。

### 5.2 Phase 5 exit checklist（iteration-drive Done）

Print **`## Phase 5 exit checklist`** per **`mstar-iteration` §5.2**（`references/phase-4-5-pr-delivery.md` §5.2：PR mergeable、required CI green、review threads resolved（或用户书面 waive）、§5.1 comment + resolve、todo `phase-5-pr-merge-ready`；Greptile 5/5 仅当 greploop mode / repo 可见分数）→ 全 `[x]` 后结束本 command。

**Then** report: iteration id, plans completed, compound summary, PR link, merge-ready evidence（CI snapshot + review resolution + Greptile if applicable）。

PR merge itself may still be manual or a separate host action unless user authorized auto-merge.
