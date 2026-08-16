---
name: mstar-iteration
description: Morning Star 迭代管理 —— Phase 1（默认 interactive direction lock；opt-in autonomous；specs + `<iteration-id>/` package；禁止直写 knowledge）、Autonomous Execute、iteration-close（compound 提升 package → knowledge）、PR 交付、PR merge-ready loop。分支 SSOT：`status.json` + compass frontmatter。
---

# mstar-iteration（迭代管理）

## Load order

**Read `mstar-harness-core` first.** Path symbols → **`mstar-plan-conventions`**. Per-plan gates → **`mstar-phase-gates`**. Knowledge crystallization → **`mstar-compound`**. **Phase 2 entry**（control worktree + lease）→ **`references/phase-2-worktree-lease.md`** + **`mstar-branch-worktree`**。**Phase 2 implement 波次**（进入 per-plan implement 前）→ **`mstar-sdd`** + **`mstar-dispatch-gates`**。Phase 2 QC 前 → **`mstar-review-qc`**。On conflict, **`mstar-harness-core` wins**.

## 设计思路

mstar 实践模式通常是：一次迭代锁定几个 spec 点（`specify + clarify`），产生多个 `plan`，每个 plan 含多个 tasks。**per-plan 生命周期有完整的闭环**（Prepare → Execute → QC → Done）。Compound 不是 per-plan 活动——它是**迭代级收口**，在迭代内所有 plan Done 后，沉淀一轮知识。

本 skill 管理迭代 **Phase 1–5**（command 层可聚合编排，但 **不得**反向引用 command 名；第三方 helper 仅由 command 按需发现）：

```
Phase 1: iteration-start
     ↓
Phase 2: Autonomous Execute  —— [per-plan lifecycle × N]
     ↓
Phase 3: iteration-close
     ↓
Phase 4: PR delivery（开 PR）
     ↓
Phase 5: PR merge-ready loop —— 至 mergeable + CI 全绿 + reviews resolved
     ↓
迭代交付完成
```

**关键定位**：

- **Phase 3** 在 integration 分支收口 compound / roadmap；**开 PR（Phase 4）≠ 迭代交付完成**。
- **Phase 5** 是 **merge-ready loop**：修复 →（等 CI/review 波次结束再）push → 再验证，直至 §5.5 exit。**Loop 理念与 push cadence SSOT 在本 skill**（§5.1a）；宿主 command 可叠加额外 **non-`mstar-*`** helper（**优先** `babysit` / `*-babysit`；**`greploop` 可选** — 仅当仓库具备 Greptile/`greploop` 时采用），但不写入 `mstar-*` load order。
- 一次迭代 = 一个 PR；compound 产物随 PR 合入 `metadata.target_branch`。

## Phase transition gates（HARD — 防跳步）

| 边界 | 触发 | 必须 | 禁止 |
|------|------|------|------|
| **→ Phase 3** | `status.json` 中 compass 登记的全部 plan 均为 `Done` | 打印 `## Phase 3: iteration-close`；执行 §3.0→§3.5；host todo `phase-3-iteration-close` 保持 open 直至 §3.5 | 开 PR；宣称迭代交付完成；仅依赖 final plan closure |
| **→ Phase 4** | §3.5 exit checklist 全 `[x]`；frontmatter `status: completed` + `end_date` | 打印 `## Phase 4: PR delivery`；开 PR 到 `metadata.target_branch`（§4） | 跳过 §3.1 entry checklist 或 compound Phase 6 |
| **→ Phase 5** | Phase 4 PR 已创建 | 打印 `## Phase 5: PR merge-ready`；执行 §5 loop 至 §5.5 exit（含 §5.1a push cadence） | 开 PR 后停止；跳过 review resolve / CI loop；**CI/AI review 仍在跑时 push** |
| **→ 迭代交付完成** | §5.5 exit checklist 全 `[x]` | PR mergeable；required CI 全绿；reviews resolved | Phase 4 开 PR 即宣称完成 |
| **iteration-start → integration branch** | §1.6 Review & Edit chain | 三角色按序 invoke；**specs** 为主产出；**禁止** start 链向 `{KNOWLEDGE_DIR}/` 新增；writing-specialist corpus hygiene + compass `status: locked` | PM 代做专业编辑；并行三角色；product/architect 写 knowledge；临时笔记进 specs |

> **Engine check (when available):** run `mstar iteration gate --status <status.json> --compass <delivery-compass.md>` (or `import { evaluatePhaseGate } from "@mstar-harness/engine"` in a host hook) to evaluate the transition gate above. On `fail` (gate-blocking violations) -> do not proceed; fix and re-run. Note: during the Phase-3 window (`transition: phase-3-close`) the gate exits 1 until the §3.4 close items (`status: completed` + `end_date`) are written — that exit-1 is the expected "close work pending" signal (the exit checklist gates Phase 4, not the Phase-3 entry), so proceed with Phase 3 per the table below. Skill text below remains authoritative when the runtime is absent.

**误判信号**：对话里出现 compound 摘要、roadmap 更新、或「所有 plan 已完成」但 **未** 打印 §3.1 / §3.5 checklist → 视为 **Phase 3 未执行**，回到 §3.0。

**per-plan 状态 SSOT**：`{HARNESS_DIR}/status.json`（per-plan Todo/InProgress/InReview/Done）。
**迭代状态 SSOT**：`{ITERATION_DIR}/<id>/delivery-compass.md` frontmatter `status` + `{ITERATION_DIR}/README.md` 索引（一行 = 一次迭代）。
**迭代分支 SSOT**：root `metadata.iteration_base_branch` + `metadata.target_branch`（`status.json`）；compass frontmatter 镜像同名字段。解析顺序见 §2.3。**禁止**因仓库存在 `main`/`master` 就假定 base 或 PR 目标。

## 产物存储位置

**SSOT**: `mstar-plan-conventions/references/artifact-storage-paths.md`。迭代 package → `{ITERATION_DIR}/<iteration-id>/`（含 `delivery-compass.md`、`guides/`、`specs/`）；根索引 → `{ITERATION_DIR}/README.md`。Legacy flat `{ITERATION_DIR}/<id>-delivery-compass.md` 仅兼容读。

---

## Phase 1: iteration-start（启动迭代）

PM 在新迭代启动时执行。

### 1.1 收集上下文

1. 读 `{ITERATION_DIR}/README.md`（若存在），了解历史迭代
2. 读 `STRATEGY.md`（若存在），对齐战略方向（见 `mstar-strategy`）
3. 如果有未完成的 roadmap 残余（上一迭代标记为 `next` 的 plan），纳入本次迭代范围候选

### 1.2 定义迭代范围

与用户/产品对齐后（或按下方 **autonomous** 模式锁定后），确定：

| 字段 | 说明 |
|------|------|
| **Iteration ID** | 唯一标识，推荐 `v<major>.<minor>` 或 `iter-<YYYY-QN>` |
| **范围** | 本迭代要锁定的 spec 点（问题陈述清单） |
| **Plans** | 预期在本迭代中完成的 plan 列表（允许中途增减） |
| **里程碑** | 关键节点与日期 |
| **验收标准** | 迭代级别的 Done 定义 |
| **非目标** | 明确排除在本次迭代外的事项 |
| **Roadmap 上下文** | 本迭代在整体 roadmap 中的位置（current iteration / next iteration） |
| **Delivery branch policy** | `iteration_base_branch`（integration 分支从何处分出）、`spec_integration_branch`、`target_branch`（最终 PR 目标） |
| **Scale budget**（可选） | 仅当 caller **显式**给出或选用 **autonomous** 时适用：`S` = 1 **业务** plan；`M` = 2–3；`L` = 3–4（上限 4）；`XL` = **>4**（5+）。**只计实际业务交付 plan**，不计 harness 流程性工作（Review 链 / QC / QA / compound / close / PR 等）。**interactive 默认不强制** S/M/L/XL。计数细则 → **`references/autonomous-direction-lock.md`** § Scale budget |

#### Direction lock modes

compass/plans 初稿落盘前，必须锁定**单一**迭代方向、成功标准、非目标，并确认 delivery branch policy；决策写入 compass `## Scope` / `## Acceptance Criteria` / `## Non-Goals` 与 Delivery Branch Policy。

| Mode | 何时选用 | 行为 |
|------|----------|------|
| **`interactive`** | **默认**（未显式声明 mode 时一律用此） | 与用户/产品**逐问**收敛方向与 branch policy；不得静默默认 `main`/`master` |
| **`autonomous`** | **仅**当 caller / Assignment **显式**声明 `Direction lock mode: autonomous`（或等价书面 opt-in） | 代码优先调研 → 排序候选 → **锁定推荐方向并落盘 rationale**；不因「是否同意该方向」例行问用户。细则 → **`references/autonomous-direction-lock.md`** |

**宿主 Plan UX（interactive）**：若宿主提供 Plan 会话（先写 session plan、后点 Build 才执行 todos）：

- 允许 **先 scaffold 空白 Phase 1 文档/todos**，再以 **用户反馈驱动** 收敛：Agent 探索并写入推荐，**原地更新同一份** session plan；用户提方向/意见，**不以**例行问卷为主路径。
- Branch policy：在 plan 中写推荐值 + rationale（不得静默 `main`/`master`）；用户可用反馈改正；仅在用户明确结束反馈后仍缺字段时再追问。
- 访谈式收敛 **仅**在反馈结束后仍有阻塞缺口时可选发起。
- **禁止**为更新内容再开第二份 session plan。

**非** Plan 会话仍按「收敛后再写 compass/plans 初稿」的默认顺序。此条 **不**改变 autonomous 路径，也 **不**要求非 Plan 宿主先写空文件。

**禁止**：在未显式 opt-in 时自行切换到 `autonomous`（例如仅因读了本 skill 或存在 roadmap next）。

**Branch policy gate（interactive — 默认路径）**：若用户、现有 roadmap、或项目约定未明确 `iteration_base_branch` / `target_branch`，PM 必须检查当前分支并向用户确认（**Plan 会话**走上方「推荐写入 plan + 反馈改正」；非 Plan 仍须确认）。**不得**因为存在 `main` / `master` 就默认从默认分支开 iteration 或向默认分支提 PR。

**Autonomous branch resolve**：仅 `autonomous` 模式；解析顺序与 STOP 规则见 **`references/autonomous-direction-lock.md`**（勿把该顺序套用到 interactive 以跳过向用户确认）。

### 1.3 创建迭代 package + compass

创建 `{ITERATION_DIR}/<iteration-id>/`，写入 **`delivery-compass.md`**（canonical；**禁止**新写根目录 `<id>-delivery-compass.md`）。**必须**使用 `references/iteration-compass-template.md` 完整结构（YAML frontmatter + `## Roadmap Position` + close 占位节）。`end_date` 仅在 iteration-close 填入；禁止用正文 completion prose 替代 frontmatter `status`。按需创建 `guides/`、`specs/` 与 package `README.md`。

```markdown
---
iteration_id: <id>
start_date: YYYY-MM-DD
status: active
iteration_base_branch: <branch-or-ref>
target_branch: <branch>
plans: []
---

# <iteration-id> Delivery Compass

## Scope
<本迭代要锁定的 spec 点>

## Plans

| plan_id | Name | Status | Notes |
|---------|------|--------|-------|
| <id> | <name> | Todo | |
| ... | ... | ... | |

## Milestones
| Milestone | Target date | Status |
|-----------|-------------|--------|

## Acceptance Criteria
- <迭代级验收项>

## Non-Goals
- <明确排除的事项>

## Roadmap Position
- Current iteration: <what this iteration delivers>
- Next iteration: <what comes next, owner, trigger>

## Delivery Branch Policy

| Field | Value |
|-------|-------|
| iteration_base_branch | <branch-or-ref> |
| spec_integration_branch | iteration/<iteration-id> |
| target_branch | <PR target> |
```

> **Engine check (when available):** import `validateCompassFrontmatter` from `@mstar-harness/engine` in a host hook to validate the compass frontmatter above (no CLI form yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

### 1.4 更新索引

在 `{ITERATION_DIR}/README.md` 中添加**一行**（首次创建时建立表头；**一行 = 一次迭代**，不拆 compass/workspace 双行）：

| Iteration | Path | Description | Status |
|-----------|------|-------------|--------|
| `<iteration-id>` | [`<iteration-id>/`](<iteration-id>/) | `<简短描述>` | `active` |

> **Engine check (when available):** import `assertIndexRowObligations` from `@mstar-harness/engine` in a host hook to assert the index-row obligations above (no CLI form yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

### 1.5 登记到 status.json（formal iteration 必填）

iteration 正式全流程**必须**写入 `{HARNESS_DIR}/status.json`：

- root `metadata.iteration_base_branch` — 创建 `spec_integration_branch` 的祖先 ref（**不是**隐式 `main`）
- root `metadata.target_branch` — iteration-close 后 PR 的目标分支
- 各 plan `metadata.iteration_refs`、`spec_integration_branch`、`merge_target`（`merge_target` 通常为 `spec_integration_branch`）

compass frontmatter 的 `iteration_base_branch` / `target_branch` **必须与** `status.json` 一致；若仅写在 compass 而 status 缺失，§2.3 同轮 backfill。

### 1.5.5 产物边界（specs · iterations · knowledge）

Phase 1 与 §1.6 须遵守 **`references/iteration-artifact-boundaries.md`**（HARD）：

| 树 | iteration-start 主责 | 说明 |
|----|---------------------|------|
| **`{SPECS_DIR}/`** | product-manager、architect | **长期**规范性产出：锁定规格、ADR、契约；plan `primary_spec` / `spec_refs` 主要挂此处 |
| **`{ITERATION_DIR}/`** | product-manager、architect、PM | **`<iteration-id>/` package**（`delivery-compass.md` + 迭代级 specs & guides） |
| **`{KNOWLEDGE_DIR}/`** | **非** start/execute 直写；**`mstar-compound`** @ iteration-close（含 package **提升**） | 可复用实施 SSOT |

**禁止**：product/architect 在 §1.6 向 `{KNOWLEDGE_DIR}/` **新增**；把迭代级草案写入 `{SPECS_DIR}/`（应进 `<iteration-id>/specs/` 或 guides）。

### 1.6 Review & Edit chain（integration 分支前强制）

**Phase 1 在 PM lock 前不算完成**——compass/plans 初稿落盘 ≠ Done。

派发机制 → **`mstar-dispatch-gates`**（specialist review-and-edit dispatch，**顺序链**）。PM **不得**将迭代 harness 文档 commit 到 `spec_integration_branch`，直到：

1. **product-manager** → **architect** → **writing-specialist** 已按序 invoke 编辑 compass、plans、`{SPECS_DIR}/` 与 **`{ITERATION_DIR}/<iteration-id>/`** package（guides/specs，按需）；**不得**在 start 链向 `{KNOWLEDGE_DIR}/` 新增
2. **writing-specialist** 完成 **corpus hygiene**：全库 `{SPECS_DIR}/` + 既有 `{KNOWLEDGE_DIR}/` 卫生；错放迁回 **`<iteration-id>/`** package；细则 → **`iteration-corpus-hygiene.md`**、**`iteration-artifact-boundaries.md`**
3. PM 将 compass `status` 设为 `locked`，并确认各 plan 的 Prepare gate（specify / clarify / plan）

**顺序理由**：产品范围与优先级 → 架构与长期契约（specs）→ 行文、规格库卫生与错放纠正（须在 PM/architect 定稿后扫全库 specs）。并行会导致后手重复劳动或覆盖前手未定稿内容。OpenCode：plain role id — **`mstar-host/references/opencode.md`** § Role-mention hygiene。

**完成证据** = 磁盘上的 compass / plans / specs / iteration 文档修订 + specs（与既有 knowledge）卫生/归档（如有）+ 索引与 metadata 更新 + compass `status: locked`。**不**要求单独的迭代审查报告——迭代审查的 SSOT 是被编辑的文档本身，无 per-plan QC 式审计链。

**反模式**：PM 线程代替三角色完成全部编辑而不 invoke；或将本链三角色并行派发 —— 见 **`mstar-harness-core`** 反模式索引。

---

## Phase 2: Autonomous Execute（per-plan 派发驱动）

**本 Phase 是本 skill 的核心**——定义 per-plan 派发循环的完整流程：前置条件检查、session todos、backlog 读取、integration 分支管理、per-plan dispatch 循环（分支→实现→QC→**QA gate**→Done→合并）、dispatch-first 约束、push 纪律。PM 读取本 Phase 即可执行迭代。

**Findings cleanup（默认）**：Phase 2 每个 plan Assignment 默认 **`Findings cleanup: zero-residual`**（可修 findings 当轮 fix→re-review 清干净；仅真 blocker-defer + Durable Roadmap 可留 open R#）。compass 或 Assignment 可显式覆写为 `allow-residual`。SSOT → **`mstar-plan-artifacts`**「Findings cleanup modes」。

### 2.0 前置条件（五道闸）

进入 Autonomous Execute 前必须满足：

1. `{HARNESS_DIR}/status.json` 中至少一条 plan `status` ≠ `Done`
2. **Pre-implement gate = GO**：plan 已 locked、tasks ready（见 `mstar-phase-gates`）
3. 用户意图为 **continue Autonomous Execute**（推进迭代 Execute、继续 per-plan 循环等）
4. **Branch metadata gate**：root `metadata.iteration_base_branch`、`metadata.target_branch` 已登记，且至少一条 active plan 有 `metadata.spec_integration_branch`（或可从 compass 同轮 backfill）。**缺失 → STOP**，不得用 `main`/`master` 补位。
5. **Control-worktree + lease defaults**（iteration 命令；可被 `Worktree mode: waived` 豁免）：除非本轮 Assignment 显式 `Worktree mode: waived`（或等价用户指令），Phase 2 **必须**在入口建立 control worktree、经 control 路径读写默认 gitignored 的 harness 进程产物（`status.json`、`{PLAN_DIR}`、`{ITERATION_DIR}`、`{SDD_DIR}` 等），并在可写派发前 claim `plans[].execution_lease` / `integration_merge_lease`。可写 Assignment 须含绝对 feature **`Worktree path`** + 绝对 control 系 **`Plan Path`** / **`SDD dir`**（见 **`mstar-branch-worktree`**「Harness path SSOT under default gitignore」）。**禁止**因 feature worktree 在默认 gitignore 下看不到 plans 而推断 `Worktree mode: waived`。`Plan parallelism: serial` **不** waive 本闸——仅强制跨 plan **implement** 串行调度；control worktree + lease 仍须满足。**跨 plan 并行安全闸**（**不可**被 `Worktree mode: waived` 豁免）：跨 plan **并行可写 implement** 须满足下列之一——(a) coordination 路径（control 或 waived 时主 checkout `{HARNESS_DIR}/status.json`）上 **same-host 独占写锁可用且每次 status/协调变更持锁**；(b) 默认 **`Plan parallelism: serial`**（**waived 时尤其优先默认串行**；**无 flock / 无共享锁时只触发本条，不豁免 worktree**）；(c) 用户本轮显式 `Cross-host lease race: accepted`（或等价）+ `plans[].notes` 审计。**禁止**将 `Worktree mode: waived` 当作跨主机无锁并行的授权。细则 → **`references/phase-2-worktree-lease.md`**。

> **Engine check (when available):** run `mstar lease verify <plan-id>` (or `import { validateExecutionLease } from "@mstar-harness/engine"` in a host hook — `validateIntegrationMergeLease` is import-only; no CLI form yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

任一 false → **stop**。Phase 1 / Prepare 未完成 → 先完成 Phase 1 或 per-plan Prepare，再进入本 Phase。

### 2.1 Session todos（派发前设护栏）

每个 plan wave 启动前设定 host todos，防止范围漂移：

| Host | 工具 | 最小集合 |
|------|------|---------|
| **Cursor** | `TodoWrite` / CreatePlan todos | 当前 `plan_id`；下一批 gates（implement/QC/**QA gate**）；分支 checkpoint；**仅剩 1 个非 Done plan 时追加 `phase-3-iteration-close`**（open 直至 §3.5）；Phase 4 后 **`phase-5-pr-merge-ready`**（open 直至 §5.5） |
| **Codex** | `update_plan` / Goal UI | 同上 |
| **OpenCode** | host todo/plan UI（如有） | 同上 |

SSOT = `{HARNESS_DIR}/status.json` + `{PLAN_DIR}/`。todos 只追踪本轮下一步。

### 2.2 Read backlog

1. 读 `mstar-plan-artifacts` + `{HARNESS_DIR}/status.json`
2. 列出 `status` ∈ `{Todo, InProgress, InReview, Blocked}` 的 plan（优先级：`InProgress` → `InReview` → `Todo` → unblock `Blocked`）
3. 读 root `metadata.iteration_base_branch` / `metadata.target_branch`，以及 plan `metadata.spec_integration_branch` / `merge_target` / `primary_spec` 链接

### 2.3 Integration branch + control worktree（Phase 2 入口）

**Metadata 解析顺序**（任一环节缺失则 STOP，**禁止**默认 `main`/`master`）：

1. `{HARNESS_DIR}/status.json` → `metadata.iteration_base_branch`、`metadata.target_branch`；plan → `metadata.spec_integration_branch`
2. 若 (1) 缺字段 → 读当前迭代 compass frontmatter 同名键：优先 `{ITERATION_DIR}/<iteration-id>/delivery-compass.md`；若无则 legacy `{ITERATION_DIR}/<iteration-id>-delivery-compass.md`
3. 若 compass 有值而 `status.json` 无 → **同轮 backfill** `status.json`
4. 仍缺 → 向用户确认 base / PR target；**不得**因 `git symbolic-ref refs/remotes/origin/HEAD` 指向 `main` 就自动采用
5. 所有参与本轮迭代的 active plan **必须**解析到**同一** `spec_integration_branch`；不一致 → **STOP**

**Control worktree（§2.0 #5 未 waive 时 — HARD）**：

1. 解析或创建 **control worktree**（通常 primary checkout 或 PM 指定路径），检出到上一步的 `spec_integration_branch`
2. `git fetch`（按需）；`git branch --show-current` 确认在 `spec_integration_branch`
3. 将规范绝对仓库根路径写入 control 副本 `metadata.control_worktree_path`（仓库根，非 `{HARNESS_DIR}` 子路径）
4. 此后 **harness 进程产物 SSOT**（默认 gitignored）均经 control 绝对路径解析：
   - `<control_worktree_path>/{HARNESS_DIR}/status.json`
   - `<control_worktree_path>/{PLAN_DIR}/`（主 plan）
   - `<control_worktree_path>/{ITERATION_DIR}/`（compass / iteration package）
   - `<control_worktree_path>/{HARNESS_DIR}/sdd/<plan-id>/`
   - 同树：`notes.json`、`archived/`（若使用）
   Feature worktree 只承载产品/源码编辑；其同名 `{HARNESS_DIR}` **不是** SSOT。Assignment **`Plan Path`** / **`SDD dir`** 须写 control 绝对路径。
5. 若 integration 分支尚不存在：在 control worktree 内 `git checkout -b <spec_integration_branch> <iteration_base_branch>`（**必须**从记录的 base 创建）

**Git 操作（无 control worktree 时 — 仅 `Worktree mode: waived`）**：

1. `git fetch`（按需）确认 `iteration_base_branch` 存在
2. **checkout 或创建** `spec_integration_branch`（同上）
3. `git branch --show-current` 确认在 `spec_integration_branch`

`spec_integration_branch` 是本迭代内所有 plan feature branch 的 merge target。QC **`Review range` / `Diff basis`** 的 merge-base 参照优先用 `metadata.target_branch`（或 PM 书面指定的 base ref），**禁止**无 Assignment 依据写死 `origin/main`。

### 2.4 Per-plan loop（直到全部 Done）

**跨 plan 默认**（**无论** `Worktree mode: waived`）：**不同 `plan_id` 可并行 implement** 须满足 §2.0 #5 跨 plan 并行安全闸——(a) coordination 路径 same-host 独占写锁可用且每次 status/协调变更持锁，或 (b) **`Plan parallelism: serial`**（waived 时默认），或 (c) 用户本轮 `Cross-host lease race: accepted` + audit `notes`；否则 Assignment 仍写并行 → **Blocked**。**merge 入 `spec_integration_branch` 仍串行**（`metadata.integration_merge_lease`；waived 时无 merge lease 仍须串行 merge）。未 waive 时 **禁止**无 verified `execution_lease` 的跨 plan 可写派发。

对每个本轮要推进的 active `plan_id`（可交错/并行，非强制 plan A 全 Done 再 plan B）：

1. **Claim / resume — execution lease**（§2.0 #5 未 waive）：
   - 自 control 路径 **重读** `status.json` 定位 plan 行
   - 若已有 `execution_lease` 且 `holder` **等于本 session** → **resume**：校验 `worktree_path` / `working_branch` 与 Assignment 一致后继续（**不是** steal / Blocked）
   - 若 `execution_lease` 存在且 `holder` **不同** → **Blocked**
   - 若 `status: InProgress` 但 **无** `execution_lease` → **STOP** 升级（孤儿状态恢复 → **`mstar-plan-artifacts`**；本 skill 不自行补 lease）
   - 否则按 **`references/phase-2-worktree-lease.md`** claim：`Todo`/`Blocked` → `InProgress` + 写入完整 `execution_lease`；verify 通过前 **禁止**可写派发
2. **Plan start — feature worktree + branch**：创建/校验 dedicated feature worktree；Assignment 须含绝对 `Worktree path` + `Working branch`（与 lease 一致）。plan 内多可写并行轨 → **`mstar-branch-worktree`** **`references/parallel-writable-pre-dispatch.md`**
3. **Implement → InReview**（`§ 2.5`；产品编辑在 feature worktree；plans / status / iterations / SDD 经 control 绝对路径）：
   - **默认 `Execution mode: sdd`**（多 task plan；hotfix 可 `inline`）。
   - PM 载入 **`mstar-sdd`** 后，按 plan task 顺序 **串行** per-task 循环（**不是**一次派发 dev 做全部 tasks）：
     1. `mstar sdd workspace <plan-id>` → `{SDD_DIR}`
     2. `mstar sdd task-brief <plan-file> N` → `{SDD_DIR}/task-N-brief.md`；记录 `BASE_SHA`
     3. Dispatch **one** implementer subagent（`references/implementer-prompt.md`：brief 路径 + report 路径 + `Model tier`；**禁止**贴整份 plan）
     4. Implementer `DONE` → `mstar sdd review-package BASE HEAD` → task diff 文件
     5. Dispatch **one** task reviewer subagent（brief + report + diff + Global Constraints）
     6. Fix loop 直至 review clean；append `{SDD_DIR}/progress.md`；更新 `status.json` / plan checkbox
     7. Next task
   - 每次 Completion Report 后更新 `status.json` + 主 plan
4. **QC → QA gate**（plan 保持 **`InReview`**；**保留** `execution_lease`）：per-plan 审查链 → **`mstar-sdd`**（L1–L2）+ **`mstar-review-qc/references/review-responsibility-boundaries.md`**（L3 tri / inline 单席；raw reports in `{SDD_DIR}/review/`，durable summary in main plan/status）+ **`QA gate`**（`mandatory` → `qa-engineer`；`pm-acceptance` → PM checklist）。**禁止**在 integration merge 成功前设 `Done` 或删除 `execution_lease`。
5. **Plan complete — serial merge back**（§2.0 #5 未 waive）：自 **control worktree** claim/resume `metadata.integration_merge_lease` → 将 plan feature branch 合并入 `spec_integration_branch`（仅 merge-lease holder；细则 → **`references/phase-2-worktree-lease.md`**）→ 记录 merge commit 证据 → 释放 merge lease；**同轮**设 `Done` 并删除 `execution_lease`。merge 失败：保持 `InReview` + 保留 lease，不得标 `Done`。
6. **Cross-plan 进度同步**：更新 `{ITERATION_DIR}/<iteration-id>/delivery-compass.md` 的 `## Plans` 表状态列
7. **Next plan / parallel wave** 从步骤 1 继续（可并行推进其他已 claim 的 plan；merge 仍排队串行）

全部 plan `Done` → **Phase transition gate**（见上文 **Phase transition gates**）：

1. **STOP** per-plan loop — 禁止 merge 后继续下一 plan、禁止开 PR、禁止会话结束语。
2. 打印 **`## Phase 3: iteration-close`**。
3. 按 §3.0 起独立执行至 §3.5。final plan 的 Assignment / closure 仅作输入，**不能**替代 Phase 3 gate。

### 2.5 Dispatch-first（implement 派发约束）

派发纪律 SSOT → **`mstar-dispatch-gates`** · **`mstar-sdd`** · **`mstar-host/references/parallel-dispatch.md`**。

**SDD implement（Phase 2 默认）** — PM **已载入 `mstar-sdd`** 后执行：

| 规则 | 说明 |
|------|------|
| 串行 | 同一 plan 内 **one implementer at a time**；每 task 后 **one fresh task reviewer** |
| Sticky（可选） | Assignment **`SDD implementer session: sticky`** + `implementer-session.json`；implementer **resume**，reviewer **fresh** — `mstar-sdd/references/sticky-implementer-session.md` |
| 文件交接 | brief / report / diff / `progress.md` 在 `{SDD_DIR}`；dispatch prompt **只给路径**，不贴 plan 全文或 task 历史 |
| Assignment 字段 | 每个 implement dispatch 须含 `Execution mode: sdd`、`SDD dir`、`Model tier`；§2.0 #5 未 waive 时还须含绝对 `Worktree path` + verified `execution_lease`；**禁止**省略 `Model tier` |
| 大包 inline | **禁止**把 T1–Tn 或整份 plan 写进 **一个** `fullstack-dev` leaf Assignment 冒充 SDD |
| 分支 diff | 全部 task 完成后 `mstar sdd review-package MERGE_BASE HEAD` → `{SDD_DIR}/review/` branch diff → plan QC tri（N=3） |

Iteration Phase 2 附加：

- PM **NEVER** 在 PM 线程实现产品代码（delegate dev；hotfix 例外见 **`mstar-phase-gates`**）
- `Subagent invokes issued: 0` 而 Assignment 已写出 → **`dispatch incomplete`**；下一条补发 invoke，禁止 PM 顶替
- QC 初轮：**SDD → N=3**；**inline → N=1**；plan QC tri 三席 **同条消息 N=3**（非 implement 轨数）
- **`Findings cleanup: zero-residual`（默认）**：QC 后可修 Warning/Suggestion → 继续 fix→targeted re-review，直至 clean `Approve` 或仅剩真 blocker-defer；**禁止**把可修项登记为 open residual 草草 `Approve with residuals`

### 2.6 Push 纪律（Autonomous Execute）

**Continuous execution（HARD）**：Phase 2 Autonomous Execute 经 Phase 5 merge-ready exit 全程 — 不向用户做例行 yes/no check-in。

- 不因 harness 流程问题常问「是否继续」「要不要现在启动」—— **决策、记录、dispatch**
- 进度汇报 / subagent Completion Report 后，下一条必须是 **dispatch 或下一 gate 动作**，不得以确认问句收束 turn
- 未知 → 读 `mstar-*`；仅 **`Blocked`**、secrets、不可逆范围缺口、branch metadata 缺失、或 Phase 5 多轮仍 blocked 时升级用户
- 实际 Git ≠ `working_branch` → **同轮**更新 plan + status + `execution_lease.working_branch`（如适用）
- **跨 plan implement**（**无论** `Worktree mode: waived`）：并行可写 implement 须满足 §2.0 #5 跨 plan 并行安全闸——same-host 独占写锁 + 每次协调变更持锁，或默认 **`Plan parallelism: serial`**（waived 时尤其优先），或用户本轮 `Cross-host lease race: accepted` + audit `notes`；**禁止**将 waived 当作无锁跨主机并行授权；未 waive 时另须 verified `execution_lease` + feature worktree。**integration merge 串行**（`integration_merge_lease` 或 waived 下无 lease 仍须串行 merge）
- plan 内 SDD task **串行** — 见 §2.4、§2.5、`mstar-sdd` Continuous execution
- **zero-residual（默认）**：单 plan QC findings 尽量在当轮清干净；仅真 blocker 才 defer 到后续迭代（须 Durable Roadmap）— 见 **`mstar-plan-artifacts`** Findings cleanup modes

## Phase 3: iteration-close（收口迭代）

**入口**：Phase 2 全部 plan `Done` 后按 **Phase transition gates** 进入。本 Phase 在 **integration 分支**上运行；产出物 commit 到该分支，随迭代 PR 合入 `metadata.target_branch`。

完整流程（§3.0 phase boundary、§3.0.5 compass 规范化、§3.1 entry checklist **HARD GATE**、§3.2 compound、§3.3 roadmap、§3.4 标记完成、§3.5 exit checklist + commit、§3.6 可选 compound-refresh）→ **`references/phase-3-iteration-close.md`**。

**Close Done 定义**：§3.1→§3.5 全部完成；compass frontmatter 写入 `status: completed` + `end_date`；每篇新增 knowledge doc 已登记 `{KNOWLEDGE_DIR}/README.md`。只在 final plan 中写了 compound / roadmap / PR 说明，不算 iteration-close 完成。

---

## Phase 4 & 5: PR delivery + merge-ready loop

**Phase 4**（开 PR）与 **Phase 5**（merge-ready loop）完整流程（§4、§5.0、§5.1a push cadence、§5.1 loop、§5.2 exit checklist）→ **`references/phase-4-5-pr-delivery.md`**。

**关键定位（hard）**：Phase 4 开 PR **≠** 迭代交付完成；必须完成 Phase 5 §5.2 merge-ready exit。**Push cadence（§5.1a HARD）**：本地可提前修，**禁止**在 CI / AI review 波次未结束时 `git push`。**Checkout（HARD）**：Phase 5 修复直接在 control / `spec_integration_branch` 上做；**禁止**另开 Phase 5 fix worktree，**禁止**套用 Phase 2「control 禁止产品编辑」（细则 → **`references/phase-4-5-pr-delivery.md`** §5.0）。

---

## 迭代 compass 模板

完整模板见 `references/iteration-compass-template.md`。

## 与其它技能的关系

完整 topic-skill 索引见 **`mstar-harness-core`**。本 skill 迭代级关键引用：

- **`mstar-compound`** — iteration-close 中触发知识结晶（**唯一**默认 knowledge 新增路径）
- **`references/phase-2-worktree-lease.md`** — Phase 2 control worktree、`execution_lease`、`integration_merge_lease`
- **`references/autonomous-direction-lock.md`** — §1.2 autonomous direction lock、scale budget、branch resolve
- **`references/iteration-artifact-boundaries.md`** — Phase 1 specs / iteration package / knowledge 分工
- **`references/iteration-corpus-hygiene.md`** — §1.6 writing-specialist specs 卫生细则

## NOT to do

完整反模式索引见 **`mstar-harness-core`**。迭代级高频陷阱（其余各 Phase 内已含对应 hard rule）：

- **不要将 Phase 4 开 PR 等同于迭代交付完成** — 必须完成 Phase 5 §5.2 merge-ready loop
- **不要在 Phase 5 CI 仍跑或 AI review 波次未结束时 push**（§5.1a）— 本地可提前修，push 等 idle
- **不要为 Phase 5 另开 feature/fix worktree**，也不要把 Phase 2 control 产品编辑禁令套到 Phase 5 — 直接在集成分支 checkout 上修
- **不要在缺 `iteration_base_branch` / `target_branch` 时默认 `main` / `master`**
- **不要在 iteration-start §1.6 由 product/architect 向 `{KNOWLEDGE_DIR}/` 新增**（知识 → iteration-close **`mstar-compound`**）
- **不要在 per-plan Done 后立即 compound** — 等 iteration-close 统一做

## Workflow

Phase 1–5 总览见上文 **`## 设计思路`** 图：`iteration-start`（范围 + compass + §1.6 Review & Edit 链）→ `Autonomous Execute`（§2.4 per-plan 循环：分支 → 实现 → QC → QA gate → Done → 串行 merge）→ `iteration-close`（§3.1–§3.5 + `mstar-compound`）→ `PR delivery`（Phase 4）→ `PR merge-ready loop`（Phase 5 至 §5.5 exit）。每波用 §2.1 session todos 设护栏防范围漂移。

## Evidence

迭代交付完成 = Phase 5 §5.5 exit checklist 全 `[x]` + PR mergeable + required CI 全绿 + reviews resolved。Phase 3 完成标志 = compass frontmatter `status: completed` + `end_date`（§3.4）+ §3.5 exit checklist。close 证据在磁盘产物（compass / plans / specs 修订 + 索引 + metadata），不要求单独迭代审查报告（§1.6）。
