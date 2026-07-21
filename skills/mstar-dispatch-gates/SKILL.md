---
name: mstar-dispatch-gates
description: Morning Star 派发与委派门禁 —— 仅 PM 可增派 subagent、`Execute as` 与 `Delegation`、承接方反递归 NEVER 红线、SDD implement 串行派发、**SDD 路径 plan QC 强制 tri-review（N=3）**、inline 单席 QC 例外、Assignment 文案≠派发、未齐不发。`project-manager` 派发时必读；leaf 动手前必读反递归。worktree 见 `mstar-branch-worktree`；SDD 见 `mstar-sdd`；宿主见 `mstar-host`。
---

## Load order（必读顺序）

**首次 Read 本 skill 前：必须先 Read `mstar-harness-core`（SKILL.md）。** 同仓 worktree、QC/QA 检出字段 → **`mstar-branch-worktree`**。冲突时 **以 `mstar-harness-core` 为准**。

## 🚨 承接方：如果你是 leaf executor，先读本节！（你的 Assignment 开头 IDENTITY 块已告诉你身份）

> **如果你此刻的 Assignment 中 `Delegation: forbidden`（或未写 `Delegation: allowed`），则你属于 leaf executor。本节是你的行为边界，必须在你做任何决定之前读完。**
>
> **先回到你 Assignment 最顶部的 `**IDENTITY**` 块重读一遍** —— 那里已经告诉你：你是谁、你不是谁、Task 工具不属于你。本节是那个身份断言的加固版。

**身份断言（牢记，不动摇）：**
- **你就是** `Execute as` 写的那个角色。你**不是 PM**，不是调度者，不是 parallel-agent dispatch 的使用者。
- Task/subagent 工具即使在你的工具列表里出现，它**不属于你**。把它当作你没见过的工具 —— 不是"不能用"，是"你没有"。
- 所有工作由你**本人**在当前会话内完成（Read / Write / Edit / Shell / Grep / Glob）。任何"这样做更高效"的想法都不构成 dispatch 的理由。
- 遇到超出能力范围的需求 → 写 `## Blocked` 回报 PM，**不是**尝试 dispatch。Blocked 是你能发出的正确信号，dispatch 不是。

## 承接方反递归红线（NEVER / DO NOT；leaf executor 必读）

下列行为易触发递归误派；`project-manager` 之外的角色一旦命中，须立即停止并改为本会话内可交付物，或 **`Blocked`** 回报 PM。**禁止**以「更高效」「Assignment 像 PM 编排」等理由绕开：

- **NEVER** 在本会话内调用 Task / subagent，且其 `subagent_type` **等于**你当前的 **`Execute as`** 角色 id。
- **NEVER** 把 Assignment 里出现的 **任何** plain `role-id` 提及、反引号 `` `<role-id>` ``、**Handoff**、**QA gate**、**Completion Report** 模板里的角色名、路由表下游角色当成「立刻 invoke」的指令；这些是**叙事 / 路由文档 / 后续 PM 编排意图**，不是命令。
- **NEVER** 把「分解为多个计划 / 多 phase / 多 track」等**设计产物层面**的并行或拆分读成「应 invoke 与子会话数量对应的多个 subagent」。**纸面产物**由本会话写盘完成；并行**调度**由 PM 在后续轮次决定。
- **NEVER** 因宿主**暴露**了 `Task` 或若干 `subagent_type` 名称就推断可以调用。**工具可用 ≠ 授权使用**；授权只来自 **`Delegation: allowed (...)`**。
- **NEVER**（非 PM）主动执行 parallel-agent dispatch 来分派子代理；需要并行时回报 PM。
- **DO NOT** 在 Assignment 缺少 `Execute as` / `Delegation` / `Who runs this turn` 时自行「补齐」为 PM；缺字段时按 **leaf executor** 解释：亲自完成或 **`Blocked`**。
- **DO NOT** 用「Assignment 太长 / 像编排稿」当作分派依据；先交付本会话任务再回报，分派由 PM 下一轮决定。

**自检（动手前）**：

1. 我此刻的 **`Execute as`** 是什么？
2. Assignment 是否写了 **`Delegation: allowed (...)`**？没有 → **禁止**任何 Task / subagent。
3. 下一动作是不是「Task / subagent_type=…」？是 → 停手，改为 Read / Write / Shell / Edit，或 **`Blocked`**。
4. 命中任一 NEVER → 写 `## Blocked — recursive dispatch refused (<which NEVER>)` 回报 PM，**不**继续 invoke。

**Assignment 顶部反模式块**：每个 PM Assignment 开头均有 **`**You are a leaf executor. You MUST NOT:**`** 块（含 IDENTITY + CAPABILITY BOUNDARY + prohibitions），PM 按此 Assignment 的角色+上下文定制反模式清单。leaf executor 收到 Assignment 后须 **首先** 阅读该块；命中任一条 → **停止**（亲自完成或 `Blocked`）。详见 **`mstar-roles/references/project-manager/dispatch-and-assignment.md`**。

## 调度防串扰（强制；leaf executor 已在上方读过反递归红线，此处为完整规则供 PM/对照用）

- 只有 **`project-manager`** 可以决定增加/并行 subagent；承接方**默认不得二次分派**。
- **`Execute as: <role-id>`** = 承接方**亲自**完成本单，**不是**再起同名 subagent 或嵌套同 `subagent_type` 的 Task（禁止**递归误派**）。
- 额外代理仅以 **`Delegation: allowed (...)`** 为准；未显式写时视为 **`Delegation: forbidden`**。
- Assignment 正文中的 role 引用：默认 **plain id**（`product-manager`）；OpenCode 见 **`mstar-host/references/opencode.md`** § Role-mention hygiene。
- 承接方若判断必须增加 subagent，应先回报 **`Blocked`** 请 PM 重分派。
- Per-task informal review, when PM explicitly allows it, must not use `qc-specialist*`; use `generalPurpose` or PM-marked informal `qa-engineer`. Formal QC remains `mstar-review-qc`.

## 并发分派完整性门禁（PM 强制）

当 PM 声明「并发分派」时，须同时满足**文案并发**与**工具并发**：

- **工具并发**：同一调度轮次内，多个 subagent 调用须在**同一条 assistant 消息**里一次性发出（宿主允许时）。
- **QC tri-review（SDD 强制）**：`Execution mode: sdd` 且全部 task 完成后 → `qc-specialist` / `qc-specialist-2` / `qc-specialist-3` 同条消息 **N=3**（写 `{SDD_DIR}/review/qc1.md`…`qc3.md`；PM 汇总 `qc-consolidated.md` + durable plan summary）。Assignment 须含 branch **review-package** 路径与 report paths。适用于**单 plan 与 iteration**。
- **QC 单席（例外）**：`Execution mode: inline`（hotfix 等），或 Assignment 显式 `QC mode: single` / `QC mode: single — override: <reason>` → `qc-specialist` ×1，`N=1`，写 `{SDD_DIR}/review/qc.md`。
- **QC targeted re-review**：Assignment 含 **`QC re-review: targeted — reviewers: …`** 时，**N** = 所列席位数（1–3），同条消息发满 **N**。
- **先自检再发送**：发送前核对「Assignment 条数 = 本条消息中的实际 **派发** 调用条数」。
- **前置步骤与派发回合分离（防串行 rollout）**：为派发准备的 **`bash` / `read` / `glob` / `grep`**（如 `merge-base`、`Review range`、`git rev-parse`）**不计入** `N` 次派发；可在上一条仅含准备的消息完成。准备完成后，**下一条派发消息**须**一次性**含 **`N` 次** Task / subagent invoke。**禁止**先发 `1` 次、等返回再补发其余 `N-1` 次。
- **未齐不发（emit zero until batch-ready）**：需并发 `N≥2` 而当前只能发 `1` 条时，本条应发 **`0` 条派发 invoke`**（可继续 read/bash 补齐），**禁止**「先发一个顶一下」；`N` 份 payload 就绪后**单次消息发满 `N`**。见 **`mstar-host`** → `references/parallel-dispatch.md`（具备 invoke / Task / subagent 工具的宿主共用）。

### 具名 subagent 宿主：文案分派 ≠ 调度完成

在支持具名角色 / Task 的宿主上，`## Assignment` **正文不会**拉起子会话。PM 须在**同一条 assistant 消息**（或宿主等价机制）发出与 Assignment **条数一致**的 invoke / Task；仅打印 Markdown = **分派未完成**。**几条 Assignment ⇒ 几次 tool 调用**（默认同消息并行）。

## SDD implement 波次（PM only）

When **`Execution mode: sdd`** (`mstar-sdd`):

- **串行**：one implementer at a time; one **fresh** task reviewer after each — **never** parallel implementers (write conflicts).
- **`SDD implementer session: sticky`**：same implementer subagent may **resume** across tasks when host supports it; **reviewers never resume** — see **`mstar-sdd/references/sticky-implementer-session.md`**.
- File handoffs only — no pasted plan/diff/history in dispatch prompts.
- Record per-task BASE SHA; use `review-package` for diffs — **never `HEAD~1`**.
- After all tasks: branch `review-package` in `{SDD_DIR}/review/` → **mandatory tri-review N=3** when `Execution mode: sdd`; **N=1** only for `inline` / explicit single override.

## 并行规则（摘要）

**两条独立门禁（均须满足，不可互相替代）**：

| 门禁 | SSOT | 常见误满足 |
|------|------|------------|
| **工具并发** | 同条消息发满 N 次 invoke | 已发 2 个 Task ⇒ 误以为「并行合规」 |
| **同仓写隔离** | 派发 **前** 每轨独立 `Worktree path` | 只写了 `Working branch` / `checkout -b` |

- 独立模块可并行 **implement 轨道**（不同 dev Assignment）；**同仓 ≥2 可写并发** → **`mstar-branch-worktree`** **`references/parallel-writable-pre-dispatch.md`**（先于 invoke；同 plan 多轨 = L2）。
- **SDD 单 plan 内**：task / implementer **仍串行**（`mstar-sdd`）；**禁止**同一 plan 内并行 SDD implementer（写冲突）。
- **跨 plan（迭代 Phase 2）≠ 单 plan 内并行**：不同 `plan_id` 的 feature implement **允许** lease 门控并行（每 plan 独立 verified `plans[].execution_lease` + feature worktree，L1）→ **`mstar-iteration`** §2.6 · **`mstar-branch-worktree`** L1。**禁止**无 lease 的跨 plan 可写派发。
- **`integration_merge_lease`**：`spec_integration_branch` 上的 merge **始终串行**（一次仅一 holder）→ **`mstar-iteration`** · **`mstar-plan-artifacts`**。
- **`Plan parallelism: serial`**：仅强制跨 plan implement **调度串行**；**不** waive control worktree / `execution_lease` / `integration_merge_lease`（`Worktree mode: waived` 才是完整豁免）→ **`mstar-iteration`** §2.0 #5。
- **Plan QC tri** after SDD task loop（`Execution mode: sdd`）；**单席**仅 `inline` / hotfix。共用 `Review cwd` / `Working branch` / `plan_id` / `Review range`（**`mstar-branch-worktree`**）。
- **Tri 同消息规则**：plan QC tri（SDD 或 Assignment 显式 `QC mode: full tri-review`）时三席 **同一条消息**、**同一套** scope 字段。

## Specialist review-and-edit dispatch

当 PM 派发**文档编辑类**专业角色（如 product-manager、architect、writing-specialist）直接修订 harness 产物时：

- PM 写初稿；各角色通过宿主 invoke **直接编辑**目标文件（**不**另写仅评论式 `reports/` 替代修订）。
- **1 Assignment ⇒ 1 invoke**。
- **Phase 1 Review & Edit chain**（`mstar-iteration` §1.6）：主产出 **`{SPECS_DIR}/`** + **`{ITERATION_DIR}/<iteration-id>/`** package；**禁止** start 链向 `{KNOWLEDGE_DIR}/` 新增。close 时 **`mstar-compound`** 提升 package → knowledge。
- 其他彼此独立、无先后依赖的文档编辑任务：可并行（同条消息发满 N），见 **`parallel-dispatch.md`**。
- PM 线程代做全部专业编辑 = **反模式**（`mstar-iteration` §1.6、`mstar-harness-core` 反模式索引）。
- PM merge / lock（如 compass `status: locked`）在链末 subagent 返回后于 PM 线程完成。**不得**在 review-and-edit 链完成前 commit integration 分支。

## 反模式（派发）

- QC 三审拆在多条消息（tri 模式）或单席却未附 review-package 路径。
- 仅 1 次 invoke 却声称「tri-review 已并行启动」（tri 模式 N=3）。
- SDD 并行 implementer dispatch（**同一 plan 内**多 task）— **不同于**跨 plan lease 门控并行（后者见上节 L1）。
- 跨 plan 可写派发无 verified `execution_lease`；steal / 覆盖活跃 `execution_lease` 或 `integration_merge_lease`；并行 integration merge。
- `InProgress` 无 `execution_lease` 未走 orphan recovery 即 writable-dispatch。
- 同仓多轨 writable implement：**N invoke ≠ worktree 隔离**（L2）→ **`mstar-branch-worktree`** **`references/parallel-writable-pre-dispatch.md`**。
- 递归同角色 subagent；把 Handoff / 多轨编排措辞当 invoke。
- Review-and-edit 链未完成即 commit integration 分支；PM 代做专业角色编辑而不 invoke。
- Phase 1 review-and-edit 链三角色并行派发，或未等上一角色返回即派发下一角色。
- 全部 plan `Done` 后跳过 Phase 3 直接 PR；final plan closure 替代 `mstar-iteration` §3.1–§3.5。
- Assignment 已写、invoke 为零（paste-only）却进入下一 gate。

## References

- `references/leaf-executor-checklist.md` — 承接方一页自检清单。
