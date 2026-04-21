# 按角色的 Superpowers 必用 / 宜用矩阵（Morning Star）

下列"必用"表示：**只要任务落在该列场景，且用户未禁止，即应先加载对应技能再动手**。

## @project-manager（primary）

| 场景 | 技能 |
|------|------|
| 必用（协调） | `using-superpowers` |
| 必用（并行拆分） | `dispatching-parallel-agents`（**仅当** ≥2 条实现轨**同时**并行；**不含**「串行交替 `fullstack-dev` / `fullstack-dev-2`」——见 `project-manager.md` Dev 三角 §6）；叠用下项；会话内**由 PM 顺序**多代理时用 `subagent-driven-development`（**勿**顶替并行轨；**勿**与默认 `Delegation: forbidden` 同条 Superpowers — 见 SKILL.md「Delegation 与 Superpowers 清单一致」） |
| 必用（同仓多可写并发） | **`using-git-worktrees`**（仅当与上项同时成立且 ≥2 可写流改**同一仓库**时叠用）：禁止共用同一 cwd 检出；Assignment 须含各流 **`Working branch`** + **worktree/检出约定** |
| 必用（书面计划跨会话） | `executing-plans`（当存在书面实现计划且约定下次继续时） |
| 必用（登记/拆 plan） | `writing-plans`（非平凡任务、多阶段交付） |
| 必用（收口） | `verification-before-completion`（汇总 Done、sign-off、merge 前须有 QA/命令证据）；`finishing-a-development-branch`（分支收尾策略） |
| 宜（意图不清） | 推动或分派前由相关角色做 `brainstorming`（PM 可直接与用户澄清，或分派 @product-manager / @architect） |

**补充执行约束（PM）**：

- 当任务是 **Bug/异常**，若 Assignment 的 `Superpowers` 未出现 `systematic-debugging`（且非 Hotfix），视为分派不完整。
- 当任务进入 **gate / sign-off / merge decision**，若未出现 `verification-before-completion` 或等价证据要求，视为门禁不完整。
- 当任务声明 **并行分派**，`Superpowers` 中应显式包含 `dispatching-parallel-agents`（或同义触发短语），并为每个可写承接方写清 `Working branch`。
- 当 **并行分派** 且 **≥2 个可写承接方** 针对 **同一 Git 仓库** 可能并发落盘时，`Superpowers` 中还 **必须** 显式包含 **`using-git-worktrees`**（或同义触发短语），并在 Assignment 中写清各流 **检出路径约定**（或要求 Completion Report 回报实际 worktree 路径）；**禁止**依赖「多 subagent 共享同一工作目录」完成并发写入。
- **QC 三审**：三份 Assignment 除 `Review cwd`、`Working branch` 外，**必须**含 **相同**的 **`plan_id`** 与 **`Review range` / `Diff basis`**（可复制粘贴）；**@qa-engineer** 同 feature 验证时 **照抄**同一组字符串。缺任一项视为 PM 分派不完整（`mstar-harness-core` `references/branch-and-worktree.md`）。**同仓、同一 plan、多 worktree 并行**：PM **推荐**先建 **plan 集成分支** 再挂各轨 worktree，QC 前再归并到单一 `HEAD`（见同 reference **「推荐默认编排：先建 plan 集成分支，再挂各 worktree」**）。**同一 plan 多 batch**：**默认仅在整 plan dev 完成后**派一轮完整三审；复验波次用新文件名；增量例外须 Assignment 写明（`mstar-plan-conventions`）。

## @product-manager

| 场景 | 技能 |
|------|------|
| 必用 | `brainstorming`（新产品/大范围需求澄清） |
| 必用（与同仓其他可写 subagent 并发落盘项目仓库时） | `using-git-worktrees`（独立 worktree + Assignment 已批准分支；见 `mstar-harness-core`） |
| 宜用 | `writing-plans`（把 PRD/验收拆成可执行里程碑，与 `mstar-plan-conventions` 对齐） |

## @architect

| 场景 | 技能 |
|------|------|
| 必用 | `brainstorming`（重大架构取舍、多方案比选） |
| 必用（与同仓其他可写 subagent 并发落盘项目仓库时） | `using-git-worktrees`（见 `mstar-harness-core`） |
| 宜用 | `writing-plans`（技术方案、迁移、分阶段落地计划） |

## @fullstack-dev / @fullstack-dev-2 / @frontend-dev

| 场景 | 技能 |
|------|------|
| 必用（缺陷） | `systematic-debugging` |
| 宜用（功能/修复） | `test-driven-development`（项目允许 TDD 时） |
| 必用（合并/宣称开发完成） | `verification-before-completion` |
| 宜用（重大变更） | `requesting-code-review`（与 QC 三审互补：作者侧自检与说明） |
| 宜用（按 QC 改代码） | `receiving-code-review` |
| 必用（与同仓其他可写 subagent 并发执行时） | `using-git-worktrees` |
| 宜用（仅单写入者时的隔离大重构/实验分支） | `using-git-worktrees` |

## @qa-engineer

| 场景 | 技能 |
|------|------|
| 必用 | `verification-before-completion`（报告通过/阻塞、Done sign-off 前须有可复现命令与输出） |
| 必用（验证 feature / 跑业务仓测试或提交测试工件时） | 在 PM 写明的 **`Review cwd` / `Worktree path`**、**`Working branch`**、**`plan_id`**、**`Review range` / `Diff basis`** 下执行（与 QC **逐字相同**）；先核对路径、分支与审查范围（见 `mstar-harness-core` `references/branch-and-worktree.md`「QC 三审、QA 验证与 feature 检出上下文」） |
| 必用（与同仓其他可写 subagent 并发写仓库时） | `using-git-worktrees` |
| 宜用 | `using-git-worktrees`（需与既有目录分离、但在**同一 `Working branch`** 上另开检出专供 QA 写入时） |
| 宜用 | `systematic-debugging`（flaky、环境、不可稳定复现） |
| 宜用 | `test-driven-development`（先定义失败用例再补实现协作时） |

## @qc-specialist / @qc-specialist-2 / @qc-specialist-3

| 场景 | 技能 |
|------|------|
| 必用 | `verification-before-completion`（审查结论须指向证据：diff、lint、日志） |
| 必用（审查 feature 实现时） | 在 PM 写明的 **`Review cwd` / `Worktree path`**、**`Working branch`**、**`plan_id`**、**`Review range` / `Diff basis`** 下执行审查（**`plan_id` 与 `Review range` 三份 QC Assignment 须一致**）；先核对再按 **`Review range` / `Diff basis`** 跑 diff/lint（见 `mstar-harness-core` `references/branch-and-worktree.md`、`mstar-review-qc`） |
| 宜用 | `using-git-worktrees`（需与开发目录分离、但在**同一待审分支**上另开检出专供审查时） |
| 宜用 | `systematic-debugging`（对"疑似缺陷但证据不足"的条目追根） |

## @ops-engineer

| 场景 | 技能 |
|------|------|
| 必用 | `verification-before-completion`（部署/变更验证命令与结果） |
| 必用（与同仓其他可写 subagent 并发改仓库时） | `using-git-worktrees` |
| 宜用 | `systematic-debugging`（流水线失败、线上异常） |
| 宜用 | `finishing-a-development-branch`（发布与分支/tag 策略收口） |

## @market-expert

| 场景 | 技能 |
|------|------|
| 宜用 | `brainstorming`（课题开放、策略与假设需对齐） |

## @prompt-engineer

| 场景 | 技能 |
|------|------|
| 必用 | `writing-skills`（新建/大改技能时） |
| 宜用 | `brainstorming`（新行为、新触发条件设计） |
| 必用（与同仓其他可写 subagent 并发落盘项目仓库时） | `using-git-worktrees` |
| 必用 | `verification-before-completion`（宣称技能可用、eval 通过前） |
