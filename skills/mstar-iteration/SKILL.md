---
name: mstar-iteration
description: "Start, drive, resume or close an iteration (also without a slash command): direction lock, autonomous execution with stacked layer PRs, iteration-close, whole-chain proof and Workflow Close Out."
---

# mstar-iteration（迭代管理）

## Load order

**Read `mstar-harness-core` first.** Path symbols → **`mstar-conventions`**. Per-plan gates → **`mstar-phase-gates`**. Knowledge crystallization → **`mstar-knowledge`**. Phase 2 implement 波次（进入 per-plan implement 前）→ **`mstar-sdd`** + **`mstar-dispatch-gates`**；Phase 2 QC 前 → **`mstar-review-qc`**。Git/worktree 载体（有 git 写或 lease 时）→ **`mstar-branch-worktree`**。**Phase 1 角色派发 preflight**（每次 invoke 前的 assignment preflight；`enforcement: hard` fail-fast）→ **`references/command-shared-invariants.md`**（本 skill 直接触发时不依赖 command 层）。On conflict, **`mstar-harness-core` wins**.

Phase 1 roadmap/milestone reads and the post-proof delivery projection → **`mstar-project-governance`**, the sole owner of project roadmap/milestone read/write rules.

**Phase detail 不在本 skill 正文**：按下方 **Phase route map** 只加载当前动作对应的一行 detail——**禁止**无条件通读全部 phase references。

The primary coordinator owns all rows of the selected iteration and dispatches ordinary leaf tasks. Row configuration remains revisable during active execution; `progress` records the start and review states, and direct `complete` verifies QC/PM Acceptance and the actual serial merge before writing `Done`. No row-specific PM launch or binding is required. Command entry accepts no arguments; reject nonempty arguments instead of broadening their scope.

## 设计思路

mstar 实践模式通常是：一次迭代锁定几个 spec 点（`specify + clarify`），产生多个 `plan`，每个 plan 含多个 tasks。**per-plan 生命周期有完整的闭环**（Prepare → Execute → QC → Done → **compound**）。Compound 是每个迭代 plan `Done` 后的交付尾义务——迭代行与独立 development plan 相同；iteration-close 只做 specs/ADR 提升与迭代收口。

本 skill 管理迭代 lifecycle：direction lock → autonomous execute → iteration-close → whole-chain proof → Workflow Close Out（command 层可聚合编排，但 **不得**反向引用 command 名；第三方 helper 仅由 command 按需发现）：

```
Phase 1: start
     ↓
Autonomous Execute —— [per-plan lifecycle × N: … → Done → compound]
     ├─ layer publication → review-ready layer PR（layer ref）
     ├─ PR tracker：观察 CI / review，返回可执行 finding
     └─ prefix landing：可安全单独落到 `branch.target` 的连续 ready prefix
     ↓
iteration-close (specs/ADR promotion)
     ↓
whole-chain proof（每项 merge 证据 + final accepted content 在 `branch.target`）
     ↓
Workflow Close Out (Terminal write → Unregister → Projection reconciliation → Cleanup handoff)
     ↓
迭代交付完成
```

**关键定位**：

- **PR delivery 是与执行并行的职责，不是 close 之后的编号阶段**：每个 review-ready layer 在 execute 期间发布 PR；发布、push cadence、review 面、merge-ready、merge 授权与 merge 核实 → `mstar-roles/references/project-manager/pr-delivery.md`（逐 PR 适用）。
- **stack**：层级切分与 `iteration-stack/<iteration-id>/sNN` 命名、tracker、landing/propagation、compass `PR stack` 记录与整链证明 → `references/pr-stack.md`。
- **iteration-close** 在 integration 分支收口 specs/ADR 并记录交付投影候选；per-plan knowledge compound 已在各 plan `Done` 后完成；`delivered` 投影只在整链证明之后由 Workflow Close Out 的投影对齐写入。**开 layer PR ≠ 迭代交付完成，merge-ready ≠ 生命周期已关闭**。
- **Workflow Close Out** 在整链证明之后（terminal execution transition → DB root unregister → 投影对齐 → 显式 cleanup；细则 → `mstar-roles/references/project-manager/workflow-close.md`，cleanup 契约 → `mstar-branch-worktree`）。
- 一次迭代 = 一条有序 PR 链；per-plan compound 与 iteration-close 的 specs/ADR 产物随各层 PR 合入 workflow `branch.target`（ACTIVE：执行行）；final close-delta layer 仅在有非空 delta 时开。

## Phase route map（唯一路由表 — 按当前动作加载）

| 当前动作 | 必读 detail（按需加载，勿通读） |
|---------|--------------------------------|
| **start** (new iteration / reopen direction lock) | **`references/phase-1-prepare.md`** (§1.1–§1.6: context → direction lock/hook → §1.2.5 retained prototype and feedback loop → formal compass/plans/specs → registration → selected Review & Edit rounds with mandatory final writer). Interactive requires current-design HTML confirmation before authoring; explicit autonomous opt-in retains an appropriate prototype without routine human approval. |
| **execute / resume**（推进或恢复 per-plan 循环） | **`references/phase-2-worktree-lease.md`**（§2.0 五道闸、§2.1–§2.5 loop/dispatch、control root + integration worktree checklist）；execute 期可按层发布；全部 row `Done` 但仍有未发布的 reviewed range 时，先按 §2.0「Resume with every row Done」做 delivery-only 恢复再进 iteration-close |
| **close**（全部 plan Done 后收口迭代） | **`references/phase-3-iteration-close.md`**（§3.0–§3.5：entry checklist、specs/ADR promotion、roadmap、完成标记、exit checklist + commit） |
| **PR delivery**（每层 PR 的发布、push cadence、review 面、merge-ready、merge 授权与核实） | **`mstar-roles/references/project-manager/pr-delivery.md`**（`## Publish the PR`、`## Push cadence`、`## Review paths and surfaces`、`## Merge-ready loop`、`## Merge-ready checklist`、`## Merge authorization`、`## Unresolved conversation gate`） |
| **stack**（层级切分与命名、tracker、landing/propagation、整链证明） | **`references/pr-stack.md`**（`iteration-stack/<iteration-id>/sNN` 命名、sizing、opening、tracking、landing、propagation、compass `PR stack` 记录与整链证明） |
| **Workflow Close Out**（整链证明后关闭 lifecycle） | **`mstar-roles/references/project-manager/workflow-close.md`**（Entry（whole-chain proof）→ Terminal write → Unregister → Projection reconciliation → Cleanup handoff：`mstar worktree cleanup`，dry-run 默认，`--apply` 才变更） |
| **PR helper discovery**（仅 command 层按需） | **`references/pr-helper-discovery.md`**（babysit / greploop 发现） |

一次只加载当前 route 一行；phase 切换按下方 **Phase transition gates** 走。

## Phase transition gates（HARD — 防跳步）

| 边界 | 触发 | 必须 | 禁止 |
|------|------|------|------|
| **→ Phase 2**（entry / resume） | §2.0 五道闸全过（细则 → `references/phase-2-worktree-lease.md`） | 继续 Autonomous Execute per-plan loop（phase-2 reference §2.4）；主 worktree 驻留 = 记录的 **`Main worktree branch`**，integration 分支检出在专属 integration worktree | 五道闸任一 false 仍派发；branch metadata 缺失用 `main`/`master` 补位；把生命周期分支切到主 checkout |
| **→ Phase 3** | `mstar status validate` / `mstar plan show` 所读 ACTIVE `execution_plans` 中 compass 登记的全部 plan 均为 `Done`，且 pending publication 已对账（全部 row `Done` 时不得留下未发布的 reviewed range；先按 execute/resume detail §2.0「Resume with every row Done」做 delivery-only 恢复） | 打印 `## Phase 3: iteration-close`；执行 §3.0→§3.5（`references/phase-3-iteration-close.md`）；host todo `phase-3-iteration-close` 保持 open 直至 §3.5；close commit 在 **integration worktree** 执行 | 以开 PR 替代 iteration-close；宣称迭代交付完成；仅依赖 final plan closure；在主 checkout 上 commit close 产物 |
| **close → delivery chain** | 仅约束 **close-delta layer**：§3.5 exit checklist 全 `[x]` 且 frontmatter `status: completed` + `end_date`（执行期间开启的 layer PR 走 `references/pr-stack.md`，不受本行门控） | 每层 PR 依「Publish the PR」→「Merge-ready checklist」→「Merge authorization」逐层推进（→ `mstar-roles/references/project-manager/pr-delivery.md`）；层级顺序、tracker、landing/propagation 与整链证明 → `references/pr-stack.md`；final close-delta layer 仅在有非空 delta 时开 | 跳过 §3.1 entry checklist 或 specs/ADR catalog 登记；以单层「Merge-ready checklist」exit 或单层 merge 宣称交付完成 |
| **→ Workflow Close Out** | 整链证明已记录（compass `PR stack` 表：每项 merge 证据 + final accepted content 在 `branch.target`）；engine 在 terminal close 校验 `branch.integration` tip 是否在 `branch.target` 上，未落地即 `PHASE6_DELIVERY_MERGE_UNPROVEN` 拒绝 | 按 `mstar-roles/references/project-manager/workflow-close.md` 执行 Terminal write → Unregister → Projection reconciliation → Cleanup handoff；todo `workflow-close` 保持 open 直至 Cleanup handoff | 整链未证明即调用 close；interrupted / partially merged 的迭代被当作已交付；为通过 close 释放 lease 或伪造 Done/关闭 residual |
| **→ 迭代交付完成** | Workflow Close Out 完成（`mstar-roles/references/project-manager/workflow-close.md`：Terminal write → Unregister → Projection reconciliation → Cleanup handoff） | store workflow `completed` + `ended_at`；DB 根 register（`execution_registry`）条目注销（`mstar status workflow-close --workflow <id>` 的所属 authority 形态 exit 0）；投影一致 | 「Merge-ready checklist」exit 或单层 PR merge 即宣称交付完成；为 close 释放 lease 或伪造 Done/关闭 residual |
| **start → integration branch** | §1.2.5 prototype checkpoint + §1.6 Review & Edit (`references/phase-1-prepare.md`) | Retained confirmed interactive HTML or reasoned autonomous prototype; formal documents aligned to that baseline; PM records product/architect include/omit rationale; actual selected roles edit sequentially, mandatory writer last; package specs/hygiene, marker closure, per-plan Prepare gates, `pr_merge_policy` recorded and user-confirmed, and compass `status: locked` | Formal authoring before prototype disposition; stale design approval; fake skip receipts; unresolved gaps hidden by omission; PM replacing specialist edits/writer; parallel shared-document editing; new knowledge or prototype-as-spec/acceptance evidence |

> **Engine check:** `mstar iteration gate` is the close-boundary probe (plans Done, compass completed, close commit on the integration branch); run `mstar iteration gate --workflow <id> --compass <delivery-compass.md> --branch "$(git branch --show-current)" --integration <spec_integration_branch> --target <target_branch>` (engine `evaluatePhaseGate`) against the ACTIVE execution authority (DB). Command, flags and the two transition names are unchanged — `phase-2-execute` while a registered plan is not Done, `phase-3-close` from the moment every plan is Done. `transition` names the window; `ok` is the gate's pass signal inside the `phase-3-close` window — it becomes `true` only after the close write (`status: completed` + `end_date`) already landed, and it is also `true` under `phase-2-execute`, when the gate has nothing to check — so `ok` is a close-complete signal to reach through the §3.0→§3.5 checklist, never a precondition waited on before starting the close work that produces it. Verify branch probes **before** §3.5 commit; `EXIT_BRANCH_MISMATCH` / `EXIT_PR_BASE_MISMATCH` block it. During `transition: phase-3-close`, exit 1 pending §3.4 `completed` + `end_date` is expected close work pending, not permission to skip iteration-close; the exit checklist gates the delivery chain. On `fail`, do not proceed — fix and re-run. Contract → `mstar-use-cli/references/checks-and-lints.md` § Engine check callouts.

**误判信号**：对话里出现 specs/ADR 提升摘要、roadmap 投影候选记录、或「所有 plan 已完成」但 **未** 打印 §3.1 / §3.5 checklist → 视为 **Phase 3 未执行**，回到 `references/phase-3-iteration-close.md` §3.0。

**per-plan 状态 SSOT**：ACTIVE 为 `{HARNESS_DIR}/store.db` 的 `execution_plans` 行（Todo/InProgress/InReview/Done）；`execution_registry` 登记活跃 lifecycle。读取经 `mstar status validate` / `mstar plan show`，写入只经公共 `mstar workflow …` / `mstar plan …` 动词。Workflow Close Out 保留 workflow 终态（`completed` + `ended_at`），注销 DB 根 register 条目。`{WORKFLOW_DIR}/<id>/snapshot.json` 与根 `status.json` 仅为迁移源（由保留的 `mstar` 迁移工具 engine 内部写入），不是读写路线；这些文件（含 `sessions/*.json`）在 runtime consumer 下的读写分别被 `execution.consumer-not-ready` / `execution.direct-write-refused` 拒绝。
**迭代状态**：执行状态权威在 store.db；`{ITERATION_DIR}/<id>/delivery-compass.md` frontmatter 是 authored 叙事镜像，catalog 登记身份与关系。`{ITERATION_DIR}/README.md` 仅作散文，不维护登记行。
**迭代分支 SSOT**：ACTIVE workflow 执行行的 `branch.base`（= `iteration_base_branch`）、`branch.target`（= `target_branch`）、`branch.integration`（= `spec_integration_branch`）与 `integration_worktree_path`。compass frontmatter 镜像同名锚点。解析顺序见 phase-2 reference §2.3；默认分支门禁、例外写法与「禁止默认 `main`/`master`」→ **`mstar-branch-worktree`** § Git 功能分支门禁（业务仓库）。**`branch.base` 不是驻留事实**——主 worktree（control root）驻留分支由 PM 记录为主 plan 头的 **`Main worktree branch`**，全程不切换；integration 分支检出在专属 integration worktree。

## 产物存储位置

**SSOT**: `mstar-conventions/references/artifact-storage-paths.md`. Iteration package → `{ITERATION_DIR}/<iteration-id>/`: `prototypes/` is retained design context created before formal `delivery-compass.md`, `guides/` and `specs/`; optional package/root README prose. Legacy flat `{ITERATION_DIR}/<id>-delivery-compass.md` is read-only compatibility.

## 2.6 Continuous execution + push 纪律（execute → whole-chain close 通用 SSOT）

**Continuous execution（HARD）**：execute 入口经 whole-chain proof 与 Workflow Close Out 全程 — 不向用户做例行 yes/no check-in。

- **Autonomous stop point（每层 merge 授权）**：autonomous 段在每层 PR 的 **「Merge authorization」授权之后的 merge** 处交接——`owner-gated` 下该层停在 **merge-ready**（「Merge-ready checklist」第 1–5 项），等**人类 owner** 书面批准（可一次命名当前 ready prefix，条件 → `references/pr-stack.md`「Landing」）；`reviewed-auto` 与 `reviewed-bot` 下继续至「Merge authorization」谓词成立后由 PM 执行该层 merge（前者等本地 `ship it`，后者等挂载 bot 的最新 review 达门）。三种情况下授权都来自记录的 policy 与「Merge authorization」，**不是** agent 自行判断「流程已走完」
- 不因 harness 流程问题常问「是否继续」「要不要现在启动」—— **决策、记录、dispatch**
- 进度汇报 / subagent Completion Report 后，下一条必须是 **dispatch 或下一 gate 动作**，不得以确认问句收束 turn
- **On dsh（HARD）— wake discipline:** Agent Teams is the default on dsh for a root session with Team mode on (the `team_task_*` tools exist only then); readiness never starts the owner — completing a blocker does not start it, the Lead must `send_message` (or `reassign` + one message) to start the next seat, and inactive is not completion (read plan-row evidence before recording done). Board protocol, seat budget and wake discipline are not restated here → **`mstar-host`** → `mstar-host/references/dsh.md` § Delegation channels + `mstar-host/references/dsh-agent-teams.md`.
- 未知 → 读 `mstar-*`；仅 **`Blocked`**、secrets、不可逆范围缺口、branch metadata 缺失、或某层多轮仍无法 merge-ready 时升级用户
- 一个 tracker 报告它无法解决的 blocker → 收回该 PR 的观测与 triage，由 coordinator 按 `references/pr-stack.md`「Tracking」处置并记录
- Actual Git differs from recorded source scope → same-round ordinary correction through `mstar plan prepare` / `mstar plan progress` with real facts, updating the current authoritative row, applicable working-branch information and plan projections; never hand-edit state or recreate a per-row claim.
- **跨 plan implement 并行安全闸**与 **integration merge 串行** → `references/phase-2-worktree-lease.md` §2.0 #5 /「Multi-plan parallelism」（**无论** `Worktree mode: waived`）
- plan 内 SDD 独立 ready tasks **并行**，真实依赖与共享写目标串行 — phase-2 reference §2.4、§2.5、`mstar-sdd` Ready-task scheduling
- **allow-residual（默认）**：open finding 先经 `mstar plan issue-add`（计划外 `mstar issue add`）捕获为 store issue，且各决策面披露（id + issue severity + 跟踪位置；close 面另含 blocker-defer 标记）；unresolved `critical` 仍阻断 Approve；`zero-residual` 为显式 opt-in（可修当轮清干净，仅真 blocker-defer + Durable Roadmap）— 捕获与披露职责 → **`mstar-artifacts`** Findings cleanup modes
- iteration 命令共享的 PM invariants / preflight / todos / STOP → **`references/command-shared-invariants.md`**

**Push cadence（HARD）**：逐层 PR 各自适用——本地可提前修，**禁止**在该 PR 的 CI / AI review 波次未结束时 `git push` — 细则 → `mstar-roles/references/project-manager/pr-delivery.md`「Push cadence」。

## 迭代 compass 模板

完整模板见 `references/iteration-compass-template.md`。

## 与其它技能的关系

完整 topic-skill 索引见 **`mstar-harness-core`**。本 skill 迭代级关键引用：

- **`mstar-knowledge`** — 每个迭代 plan `Done` 后触发知识结晶（**唯一**默认 knowledge 新增路径）
- **`references/phase-1-prepare.md`** — start route detail（§1.1–§1.6）
- references/phase-2-worktree-lease.md — direct coordinator execution, isolated feature/integration checkouts, atomic writes and real serial merge proof
- **`references/autonomous-direction-lock.md`** — §1.2 autonomous direction lock、scale budget、branch resolve
- **`references/iteration-artifact-boundaries.md`** — Phase 1 specs / iteration package / knowledge 分工
- **`references/iteration-corpus-hygiene.md`** — §1.6 writing-specialist specs 卫生细则

## NOT to do

共享反递归红线全清单见 **`mstar-roles/references/_shared/leaf-executor-core.md`**「Shared anti-recursion NEVER」。迭代级高频陷阱（其余各 Phase 内已含对应 hard rule）：

- **不要把开 layer PR 或单层 merge-ready 等同于迭代交付完成** — 每层须按 `mstar-roles/references/project-manager/pr-delivery.md`「Merge-ready checklist」走到「Merge authorization」并核实 merge
- **不要把单层「Merge-ready checklist」exit 或单层 merge 当作生命周期终点** — 整链证明后必须 Workflow Close Out（`mstar-roles/references/project-manager/workflow-close.md`：Terminal write → Unregister → Projection reconciliation → Cleanup handoff）；禁止为通过 close 释放 lease 或伪造 Done/关闭 residual
- **不要在该 PR 的 CI 仍跑或 AI review 波次未结束时 push**（「Push cadence」）— 本地可提前修，push 等 idle
- **不要在缺「Merge authorization」时 merge PR** — merge-ready / CI 绿 / QC Approve / review `ship it` 各自都不构成 merge 授权；三分支完整谓词、外部 bot 的 P1/未达标分数与 `pr_merge_policy` 缺失时的 STOP → **`mstar-roles/references/project-manager/pr-delivery.md`**「Merge authorization」；**merge 前还必须过「Unresolved conversation gate」**——未解决的 review thread（任何 merge class）须先清零，或逐条 waive 并经两次确认
- **不要在 integration worktree 或主 checkout（control root）上直接编辑产品代码** — PR 修复走 fix feature worktree，review 后 merge 回该 PR 的 layer ref（`mstar-roles/references/project-manager/pr-delivery.md`「Fix boundary」）
- **不要在缺 `iteration_base_branch` / `target_branch` 时默认 `main` / `master`**（门禁、例外写法与 base 解析 → **`mstar-branch-worktree`** § Git 功能分支门禁（业务仓库））
- **不要在 plan Done 后跳过 compound disposition** — 迭代行在 integration worktree 执行（有 tracked 变更才提交），独立 plan 写 delivery branch；无可结晶时记录 reasoned `skipped`（→ **`mstar-knowledge`**）

## Workflow

lifecycle 总览见上文 **`## 设计思路`** 图。执行时按 **`## Phase route map`** 选当前动作的一行 detail：`start`（范围 + compass + §1.6 Review & Edit 链）→ `Autonomous Execute`（五道闸 → §2.4 per-plan 循环：分支 → 实现 → QC → PM Acceptance → 串行 merge → Done → compound；其间按层发布 PR、跟踪并落地 ready prefix）→ `iteration-close`（§3.1–§3.5 specs/ADR promotion）→ `whole-chain proof`（`references/pr-stack.md`）→ `Workflow Close Out`（Terminal write → Unregister → Projection reconciliation → Cleanup handoff）。每波用 §2.1 session todos 设护栏防范围漂移；action 切换以上方 **Phase transition gates** 为准。

## Evidence

迭代交付完成 = 整链证明（compass `PR stack` 表逐项 merge 证据 + final accepted content 在 `branch.target`）**且 Workflow Close Out 完成**（store workflow `completed` + `ended_at`、DB 根 register 条目注销、投影一致；`mstar-roles/references/project-manager/workflow-close.md`）。Phase 3 完成标志 = compass frontmatter `status: completed` + `end_date`（§3.4）+ §3.5 exit checklist。authored close 证据保留在 compass / plans / specs；catalog 与执行 metadata 在 store.db，不要求单独迭代审查报告。
