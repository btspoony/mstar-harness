# Phase 1: start（启动迭代）— prepare detail

> Loaded by `mstar-iteration` SKILL.md on the **start** route（启动新迭代 / 重开方向锁定）。**Read `mstar-harness-core` first.** Per-plan gates → **`mstar-phase-gates`**；dispatch 机制 → **`mstar-dispatch-gates`**。Phase 1 在 PM lock 前不算完成（§1.6）。

PM 在新迭代启动时执行。

## 1.1 收集上下文

1. 查 catalog 了解历史迭代：`mstar catalog list`（按 kind 过滤，见 help；`{ITERATION_DIR}/README.md` 若存在只是散文导览，**不**是登记表；store 未初始化/未激活时查询拒绝 —— `store.not-initialized` / `store.not-active`，**不**读作「没有迭代」）
2. 读 `STRATEGY.md`（若存在），对齐战略方向（见 `mstar-strategy`）
3. 查 catalog 取 Research 候选：`mstar catalog list`（按 kind / document kind / lifecycle 过滤出 `active` knowledge；见 help；**不**要求阅读全部 knowledge 正文；README 表格不再是权威）
4. 如果有未完成的 roadmap 残余（上一迭代标记为 `next` 的 plan），纳入本次迭代范围候选

**非 command 触发**（如直接 skill 加载）时，Phase 1 方向锁定仍须 interactive（grill-me 在 command 层）。

## 1.2 定义迭代范围

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

### Direction lock modes

compass/plans 初稿落盘前，必须锁定**单一**迭代方向、成功标准、非目标，并确认 delivery branch policy；决策写入 compass `## Scope` / `## Acceptance Criteria` / `## Non-Goals` 与 Delivery Branch Policy。**已决事项**另须落入 compass **`## Decisions`**（每条 = `decision` + `rationale` + `source`：user instruction / grill-me / autonomous ranking），**未决事项**落入 **`## Open Questions`**（每条带 owner —— `product-manager` / `architect` / `writing-specialist` / `PM` —— 与 blocking 标记；无未决项写 `None`）。两节形态 → **`references/iteration-compass-template.md`**；初稿深度与清除义务 → §1.3 **Draft contract**。

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

**禁止**：在未显式 opt-in 时自行切换到 `autonomous`（例如仅因读了本 reference 或存在 roadmap next）。

**Branch policy gate（interactive — 默认路径）**：若用户、现有 roadmap、或项目约定未明确 `iteration_base_branch` / `target_branch`，PM 必须检查当前分支并向用户确认（**Plan 会话**走上方「推荐写入 plan + 反馈改正」；非 Plan 仍须确认）。**不得**因为存在 `main` / `master` 就默认从默认分支开 iteration 或向默认分支提 PR。

**Autonomous branch resolve**：仅 `autonomous` 模式；解析顺序与 STOP 规则见 **`references/autonomous-direction-lock.md`**（勿把该顺序套用到 interactive 以跳过向用户确认）。

<!-- host-hook: direction-lock -->
> Execute the active host reference's `## Host hooks` declaration for `direction-lock`; this file defines no host action.
>
> 本 anchor 在**方向已锁定**（interactive：与用户收敛 / autonomous：方向 rationale 落盘）之后、**compass 与 plans 初稿落盘之前**执行。此时 workflow 尚未登记、compass 尚不存在，属预期状态 —— anchor 动作由 active host reference 的声明决定；登记（§1.5）发生在本步之后。

## 1.3 创建迭代 package + compass

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

## Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| D1 | <已决事项> | <依据> | user instruction / grill-me / autonomous ranking |

## Open Questions

| # | Question | Owner | Blocking? |
|---|----------|-------|-----------|
| Q1 | <未决事项> | product-manager / architect / writing-specialist / PM | Yes / No |

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

### Draft contract（PM 初稿的深度契约）

PM 的初稿是**上下文载体**：被派发角色看不到 PM 的会话，只从磁盘读（`delivery-compass.md` + plans + `<iteration-id>/` package）。所以初稿按 **「骨架 + 完整上下文」** 交付，深度边界如下。

**(i) 初稿必须携带**：锁定方向；已决事项（→ compass `## Decisions`）；带 owner 的未决事项（→ `## Open Questions`）；**非目标及其理由**；约束来源（用户指令 / 既有 spec / knowledge / roadmap）；acceptance seed（可长成 `## Acceptance Criteria` 的条目）；branch policy。

**(ii) 初稿可以合法留粗**：候选方案分析、模块/接口细节、per-task 分解、plan 级技术设计。这些**标记**为待补，**不**编造。留粗是允许的；**不加标记**则不允许 —— 未标记的空洞无人认领，等于把上下文缺口丢给一个看不到会话的承接方。

**(iii) 标记形态（语法只在本节定义；其它文件按 path + 节号引用本处）**：

```text
<!-- TODO(owner: <role-id>): <what is missing and what must be decided> -->
```

owner 取值仅限 Phase 1 链：`product-manager` / `architect` / `writing-specialist` / `PM`（需回到用户决策时）。**无 owner 的 `TBD` / `...` / `etc.` 在任何阶段都仍然禁止** —— 没有 owner，就没有清除它的地方。

**(iv) 清除期限**：compass `status: locked` 是终线。lock 前，owner 属于链条三角色的 marker **必须**全部清除；无法清除的，在 lock 前**显式重新归属给 `PM`** 并上报用户（`PM` 归属项是 lock 之后唯一允许存在的 marker 形态）。**禁止**静默删除，也**禁止**让无 owner 的 placeholder 越过终线。各角色的清除义务与报数 → §1.6。

**(v) `## Open Questions` 行的处置**：§1.2 落盘的每一行在终线前必须落到三者之一：收敛为已决事项（撤出该行并计入 `## Decisions`）；或转入 (iii) 的 marker 形态（行的 owner 即 marker 的 owner，随 (iv) 一同清除或重新归属给 `PM`）；或**显式重新归属给 `PM`** 并上报用户。**禁止**静默删除行 —— 与 (iv) 共用同一终线。`Blocking?` 决定该行**能否**越过终线：标记 `Yes` 的行**必须**在 lock 前收敛为已决事项，**不论**它本会重新归属给谁；不能收敛即 Prepare 未通过（`Gate decision: blocked`），compass **不得**置 `status: locked`。lock 之后 `## Open Questions` 中唯一允许存在的行，即**非阻塞**且 owner 为 `PM` 的行。行转入 marker 形态后，其清除义务与报数按 §1.6 计。

## 1.4 登记迭代 catalog 身份（DB 权威）

迭代 identity、compass 位置、description 与 project/iteration 归属是 **`{HARNESS_DIR}/store.db`** 的 catalog 行（contract §1）—— **不**在 `{ITERATION_DIR}/README.md` 维护「一行 = 一次迭代」的登记行（README 只作散文导览）。

- **登记/查询**：单行 `mstar catalog register`（或多个）与关系 `mstar catalog link`；批量走 reviewed 流程 `mstar catalog discover`（只读提案：配置根 tracked 正文 + legacy 索引行，带显式 `unknowns`）→ 人工 review mapping → `mstar catalog import`（冲突或 source 漂移整单拒绝，不创建 workflow session）。
- **执行注册**：§1.5 的 snapshot + 根 entry 与 catalog delta 必须由**同一个 registration journal** 发布（contract §3）；中途崩溃留下 pending 状态 `catalog.registration-pending`，用 `mstar catalog reconcile` 收口（只读列出与 abort 形态见 help）。
- **限制**：`store.db` 本地且默认 gitignored —— tracked 正文（compass/README 散文）**无法**重建本地 catalog 历史；`discover` 从不假设文件名编码迭代归属或生命周期，未声明项以显式 `unknowns` 披露。

> **Engine check (when available):** import `readCatalogCompleteness` / `assertCatalogCompleteness` from `@mstar-harness/engine` (or read the rows with `mstar catalog list` / `mstar catalog show`) in a host hook to read the catalog rows above (no CLI form for the completeness report yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## 1.5 登记到 v2 状态面（formal iteration 必填）

iteration 正式全流程**必须**登记 `{HARNESS_DIR}/status.json`（v2 根）+ `{WORKFLOW_DIR}/<id>/snapshot.json`：

- 用 **`mstar iteration register`** 一次写入两份文档：create-only 的 `type: "iteration"` snapshot（`{WORKFLOW_DIR}/<id>/snapshot.json`）+ 根 `status.json` `workflows[]` active entry（`{ "id": "<iteration-id>", "type": "iteration", "started_at", "dir": "workflows/<iteration-id>" }`），二者在同一把根锁内完成。snapshot 已存在而 root entry 缺失（两次写入之间崩溃）时，重跑即恢复：保留既有 snapshot 字节，只补写缺失的 root entry。必填输入：workflow id、compass ref、三个 branch anchors、Todo plan 行（registration 从不授权实现）。store-pinning / 写入顺序 / rollback 语义 → **`mstar-artifacts`** `references/plan-workflow-lifecycle-contract.md` §4a。flag 集合与措辞以命令 help 为准（`mstar iteration register --help`），本文件不复述。
- snapshot 顶层 `branch` anchors：`base`（= `iteration_base_branch`，创建 `spec_integration_branch` 的祖先 ref——**不是**隐式 `main`）、`integration`（= `spec_integration_branch`）、`target`（= iteration-close 后 PR 的目标分支）。
- 各 plan 行 `metadata.iteration_refs`、`spec_integration_branch`、`merge_target`（`merge_target` 通常为 `spec_integration_branch`）由 producer 从 compass / integration 输入**派生**——PM 无需也不应手工构造这些字段。

compass frontmatter 的 `iteration_base_branch` / `target_branch` **必须与** snapshot `branch` 一致；若仅写在 compass 而 snapshot 缺失，Phase 2 §2.3 同轮 backfill。

**中途增减范围（已存在且仍在 Prepare 的 workflow）**：用户/产品批准的范围扩张**不得**手改受保护状态。先以 `mstar plan bind --coordinator --workflow <id>` 建立该 workflow 的 coordinator 会话，再经受守卫入口 `mstar workflow show-prepare` 读取快照与 compass 两个字节版本，并以 `mstar workflow amend-prepare` 追加已批准的 Todo 行、登记已 review 的 integration checkout 与 `plan_parallelism`（仅 Prepare 且无执行所有权时可用；无 force/replace/init 通道）。守卫与字段权威 → **`mstar-artifacts`** `references/status-and-residuals.md`「Prepare workflow amendment」；forms / exit codes → **`mstar-use-cli`** `references/plan-and-workflow.md`。

## 1.5.5 产物边界（specs · iterations · knowledge）

Phase 1 与 §1.6 须遵守 **`references/iteration-artifact-boundaries.md`**（HARD）：

| 树 | Phase 1（start）主责 | 说明 |
|----|---------------------|------|
| **`{SPECS_DIR}/`** | product-manager、architect | **长期**规范性产出：锁定规格、ADR、契约；plan `primary_spec` / `spec_refs` 主要挂此处 |
| **`{ITERATION_DIR}/`** | product-manager、architect、PM | **`<iteration-id>/` package**（`delivery-compass.md` + 迭代级 specs & guides） |
| **`{KNOWLEDGE_DIR}/`** | **非** start/execute 直写；**`mstar-compound`** @ iteration-close（含 package **提升**） | 可复用实施 SSOT |

**禁止**：product/architect 在 §1.6 向 `{KNOWLEDGE_DIR}/` **新增**；把迭代级草案写入 `{SPECS_DIR}/`（应进 `<iteration-id>/specs/` 或 guides）。

## 1.6 Review & Edit chain（integration 分支前强制）

**Phase 1 在 PM lock 前不算完成**——compass/plans 初稿落盘 ≠ Done。

**Assignment preflight（每次角色 invoke 前，HARD）**：自然语言 / skill 直接触发（非 command 路径）时，本 skill 不依赖 command 层 preflight——**每个** Phase 1 角色派发前，PM 必须运行 assignment preflight（`references/command-shared-invariants.md` 的 warn-only / `enforcement: hard` fail-fast 片段；`enforcement: hard` 时校验失败即阻断派发）。Command 层（`/iteration-start`）走其自身 preflight；本行确保 skill 触发路径门禁不缺失。

派发机制 → **`mstar-dispatch-gates`**（specialist review-and-edit dispatch，**顺序链**）。PM **不得**将迭代 harness 文档 commit 到 `spec_integration_branch`，直到：

1. **product-manager** → **architect** → **writing-specialist** 已按序 invoke 编辑 compass、plans、`{SPECS_DIR}/` 与 **`{ITERATION_DIR}/<iteration-id>/`** package（guides/specs，按需）；**不得**在 start 链向 `{KNOWLEDGE_DIR}/` 新增
2. **writing-specialist** 完成 **corpus hygiene**：仅本轮修改的 `{SPECS_DIR}/` / iteration package 与直接相关 knowledge 引用；错放迁回 **`<iteration-id>/`** package；细则 → **`iteration-corpus-hygiene.md`**、**`iteration-artifact-boundaries.md`**
3. PM 将 compass `status` 设为 `locked`，并确认各 plan 的 Prepare gate（specify / clarify / plan）

**Marker 清除义务（§1.3，每个被派发角色）**：角色在自己这一轮编辑中**必须**清除 owner 指向自己的 marker，无法清除的在完成前**重新归属给 `PM`** 并写明理由；两种情况都在 Completion Report 中报出**清除计数**（已清 N / 已重新归属 M）。**writing-specialist** 额外承担**收口核对**：除显式重新归属给 `PM` 的 marker 外，**无** marker 残留（语法的唯一 home 是 §1.3；本行不重述其形态）—— 该核对是 PM 置 `status: locked` 的前置。

**顺序理由**：产品范围与优先级 → 架构与长期契约（specs）→ 行文、规格库卫生与错放纠正（在 PM/architect 定稿后核对受影响文档）。本共享产物链存在真实依赖；独立文档可按 ownership 隔离并行。早期全局探索的既有结果复用，不因每次编辑重新扫全库。角色名写法（role id 提及 hygiene）→ active host reference（**`mstar-host`** → `references/<host>.md`）。

**完成证据** = 磁盘上的 compass / plans / specs / iteration 文档修订 + specs（与既有 knowledge）卫生/归档（如有）+ catalog 登记（store.db）与 metadata 更新 + compass `status: locked`。**不**要求单独的迭代审查报告——迭代审查的 SSOT 是被编辑的文档本身，无 per-plan QC 式审计链。

**Uncommitted-docs exception（bounded — Phase 1 only）**：Review & Edit 链的文档编辑（compass / plans / specs / `<iteration-id>/` package）可以**未提交**状态落在主 checkout（control root = 主 worktree）——这是 worktree 默认在 Phase 1 的唯一例外，主 checkout 分支**不**切换、不产生 feature commit。该例外在 **§6 的 integration-worktree 步骤**结束，其 transfer / commit / restore 序列的**唯一 home** 是 **`phase-2-worktree-lease.md` §2.3 checklist step 7**：只搬运**已 review 的本轮文档改动**，commit 落在 integration checkout，主 checkout 上对应的未提交改动随后恢复（不切分支）；**禁止**搬运主 checkout 上无关的既有用户改动。

**反模式**：PM 线程代替三角色完成全部编辑而不 invoke；或将本链三角色并行派发 —— 见 **`mstar-roles/references/_shared/leaf-executor-core.md`**「Shared anti-recursion NEVER」。

**Phase 1 完成 anchor（`phase-1-lock`）不在本文件触发**：compass `status: locked` 只是它的前置之一 —— 它只在 integration worktree 已建立（并记录 `integration_worktree_path`）、已 review 的改动在该 checkout 上 commit、且 `spec_integration_branch` 已 push 之后才执行，因此其 marker 由 **`phase-2-worktree-lease.md` §2.3**「Integration worktree (Phase 2 entry) + control root」checklist tail 承载（Phase 1 路线经 `iteration-start` §6 走到该 checklist）。
