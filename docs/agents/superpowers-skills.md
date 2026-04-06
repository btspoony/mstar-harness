# Superpowers 技能与 Agent 角色映射

本文件将 **Superpowers** 插件中的技能（`~/.config/opencode/opencode.json` 中 `plugin` 已启用时）映射到 `~/.config/opencode/agents/*.md` 业务流程。

## 未安装插件时

若当前环境没有 Superpowers（`skill` 里看不到、`plugin` 未配置）：拉取并按官方说明操作即可。

- **安装说明（英文）**: `https://raw.githubusercontent.com/obra/superpowers/refs/heads/main/.opencode/INSTALL.md`  
- **改 `~/.config/opencode/opencode.json` 须先征得用户同意**（见 `~/.config/opencode/AGENTS.md`）；不同意就只口述步骤，不代写。

**Agent 可照做的英文一句**：

`Fetch and follow https://raw.githubusercontent.com/obra/superpowers/refs/heads/main/.opencode/INSTALL.md for OpenCode; get user approval before editing ~/.config/opencode/opencode.json.`

## 如何“使用”技能

- 各角色在对应任务阶段应 **显式加载并遵循** 相应技能的完整内容（在支持 `/skill-name` 或少样本名称的环境中，通过技能名调用；以 OpenCode / 宿主客户端实际能力为准）。
- **优先级**：用户显式指令（含项目 `AGENTS.md` / `CLAUDE.md`）> Superpowers 技能中的流程要求 > 一般惯例。若用户禁止 TDD，则不得强制 `test-driven-development`。
- **`writing-plans` 保存路径（门限）**：**`plan-convention.md`** 中的 **`{PLAN_DIR}`** 优先于上游技能正文中的 `docs/superpowers/plans/`；执行该技能时仍须将计划落在 **`{PLAN_DIR}`**（见 `plan-convention.md`「与 Superpowers writing-plans」及 PM / product-manager / architect 提示词中的短门限）。
- **与 harness 的关系**：不改变 `harness-loop.md` 的阶段顺序；技能规定的是**每个阶段内的做法**（例如排障前先走系统化调试、宣称完成前先有验证证据）。

## 最小技能声明契约（减少歧义）

为降低“技能已提及但执行动作不一致”的情况，`@project-manager` 在 Assignment 中应按下列最小结构声明（可简写）：

```markdown
Superpowers:
- <skill-id> — Trigger: <why now>; Expected evidence: <what output proves it ran>
```

语言约定（与 `agents/project-manager.md` 对齐）：

- 字段名（如 `Task`、`Scope`、`Acceptance Criteria`、`Report Format`）保持英文键名。
- 字段值中的任务描述正文可优先使用中文（便于编排与减少歧义）。
- `Expected evidence` 及最终执行回报保持英文，确保跨角色可读性一致。

示例：

```markdown
Superpowers:
- systematic-debugging — Trigger: intermittent 500s with unknown root cause; Expected evidence: repro steps + narrowed hypothesis + log slice
- verification-before-completion — Trigger: before sign-off; Expected evidence: command/output or reproducible QA proof
```

约束：

- 不写“泛口号式”技能名（例如只写 `use superpowers`）。
- `Expected evidence` 必须可核对；不能是“done”“looks good”这类不可验证描述。
- 若同一任务包含多个技能，按“流程技能 → 实现技能”排序，避免承接方误判先后。

## 编排触发短语表（PM Assignment / Status Update）

`@project-manager` 在 **对用户说明**、**Status Update**、**Assignment** 中应混用下列**英文短语或技能 ID**（可与中文并列），与 Superpowers 技能描述用语一致，便于宿主/插件匹配。其他角色只需按 Assignment 中的 `Superpowers` 行执行。

| 意图 | 建议写入的自然语言 / 技能 ID（示例） | 对应技能 |
|------|----------------------------------------|----------|
| 编排总览、技能先后顺序 | `using superpowers`；`load skills in order`；先流程再实现 | using-superpowers |
| 0→1、目标含糊、多方案取舍 | `brainstorming`；`brainstorm before we build`；脑暴后再定范围 | brainstorming |
| 多阶段、动代码前先书面拆解 | `writing-plans`；`write the plan first`；里程碑与依赖写清再开发 | writing-plans |
| 下次会话按书面计划继续 | `executing-plans`；`execute plan`；`checkpoints`；跨会话按计划推进 | executing-plans |
| 本会话内多 subagent 按步跑 | `subagent-driven-development`；`subagent-driven`；本会话内子代理编排 | subagent-driven-development |
| 多独立任务并行分派 | `dispatching parallel agents`；`dispatch parallel agents`；并行分派、无依赖任务并行 | dispatching-parallel-agents |
| Bug/间歇性/排障 | `systematic debugging`；`no fix before root cause`；RCA 与证据链；先调查再修复 | systematic-debugging |
| 未禁止 TDD 时的实现方式 | `test-driven development`；`TDD`；先写失败测试再过绿 | test-driven-development |
| 大块合并前作者侧 | `requesting code review` | requesting-code-review |
| 按 QC 结论改代码 | `receiving code review`；对照 review 结论逐项核实再改 | receiving-code-review |
| Gate 前必须有证据 | `verification before completion`；`verify before claiming done`；须附命令与输出/复现步骤 | verification-before-completion |
| 合并/删分支/发布收口 | `finishing a development branch`；merge / cleanup 选项与风险 | finishing-a-development-branch |
| 并行实验、隔离工作树 | `git worktree`；`using git worktrees` | using-git-worktrees（**仍须** Assignment 已批准的 **`Working branch`**；不得在 worktree 内擅自新建/切换未授权分支；见「张力与消解」表） |
| 技能/Prompt 工程 | `writing-skills`（通常随 @prompt-engineer 任务写出） | writing-skills |

## 技能清单（简称）

| 技能名 | 用途摘要 |
|--------|----------|
| `using-superpowers` | 何时加载技能、流程类与实现类技能顺序 |
| `brainstorming` | 创造性工作之前澄清意图、范围与设计 |
| `writing-plans` | 多步任务在动代码前先写可执行计划 |
| `executing-plans` | 在**另一次会话**按书面计划执行并设检查点 |
| `subagent-driven-development` | **本会话**内用子代理执行计划中的独立任务 |
| `dispatching-parallel-agents` | 多个互不依赖任务并行分派 |
| `test-driven-development` | 实现前先写/tests 失败再过绿（若适用） |
| `systematic-debugging` | Bug / 异常行为：先调查再修 |
| `using-git-worktrees` | 需要隔离环境时用 worktree 开枝 |
| `requesting-code-review` | 重大改动或合并请求前发起规范审查 |
| `receiving-code-review` | 处理审查意见时先核实再改 |
| `finishing-a-development-branch` | 实现完毕后的合并 / 清理选项 |
| `verification-before-completion` | 宣称完成、通过 gate、合并前必须有可核对证据 |
| `writing-skills` | 编写、编辑、验证 Agent 技能文档 |

## 按角色：必用 / 宜用 / 可选

下列“必用”表示：**只要任务落在该列场景，且用户未禁止，即应先加载对应技能再动手**。

### @project-manager（primary）

| 场景 | 技能 |
|------|------|
| 必用（协调） | `using-superpowers` |
| 必用（并行拆分） | `dispatching-parallel-agents`（多独立子任务）；复杂本会话编排 `subagent-driven-development` |
| 必用（书面计划跨会话） | `executing-plans`（当存在书面实现计划且约定下次继续时） |
| 必用（登记/拆 plan） | `writing-plans`（非平凡任务、多阶段交付） |
| 必用（收口） | `verification-before-completion`（汇总 Done、sign-off、merge 前须有 QA/命令证据）；`finishing-a-development-branch`（分支收尾策略） |
| 宜（意图不清） | 推动或分派前由相关角色做 `brainstorming`（PM 可直接与用户澄清，或分派 @product-manager / @architect） |

补充执行约束（PM）：

- 当任务是 **Bug/异常**，若 Assignment 的 `Superpowers` 未出现 `systematic-debugging`（且非 Hotfix），视为分派不完整。
- 当任务进入 **gate / sign-off / merge decision**，若未出现 `verification-before-completion` 或等价证据要求，视为门禁不完整。
- 当任务声明 **并行分派**，`Superpowers` 中应显式包含 `dispatching-parallel-agents`（或同义触发短语），并为每个可写承接方写清 `Working branch`。

### @product-manager

| 场景 | 技能 |
|------|------|
| 必用 | `brainstorming`（新产品/大范围需求澄清） |
| 宜用 | `writing-plans`（把 PRD/验收拆成可执行里程碑，与 `plan-convention.md` 对齐） |

### @architect

| 场景 | 技能 |
|------|------|
| 必用 | `brainstorming`（重大架构取舍、多方案比选） |
| 宜用 | `writing-plans`（技术方案、迁移、分阶段落地计划） |

### @fullstack-dev / @fullstack-dev-2 / @frontend-dev

| 场景 | 技能 |
|------|------|
| 必用（缺陷） | `systematic-debugging` |
| 宜用（功能/修复） | `test-driven-development`（项目允许 TDD 时） |
| 必用（合并/宣称开发完成） | `verification-before-completion` |
| 宜用（重大变更） | `requesting-code-review`（与 QC 三审互补：作者侧自检与说明） |
| 宜用（按 QC 改代码） | `receiving-code-review` |
| 可选 | `using-git-worktrees`（并行实验或隔离大重构） |

### @qa-engineer

| 场景 | 技能 |
|------|------|
| 必用 | `verification-before-completion`（报告通过/阻塞、Done sign-off 前须有可复现命令与输出） |
| 宜用 | `systematic-debugging`（flaky、环境、不可稳定复现） |
| 宜用 | `test-driven-development`（先定义失败用例再补实现协作时） |

### @qc-specialist / @qc-specialist-2 / @qc-specialist-3

| 场景 | 技能 |
|------|------|
| 必用 | `verification-before-completion`（审查结论须指向证据：diff、lint、日志） |
| 宜用 | `systematic-debugging`（对“疑似缺陷但证据不足”的条目追根） |

### @ops-engineer

| 场景 | 技能 |
|------|------|
| 必用 | `verification-before-completion`（部署/变更验证命令与结果） |
| 宜用 | `systematic-debugging`（流水线失败、线上异常） |
| 宜用 | `finishing-a-development-branch`（发布与分支/tag 策略收口） |

### @market-expert

| 场景 | 技能 |
|------|------|
| 宜用 | `brainstorming`（课题开放、策略与假设需对齐） |

### @prompt-engineer

| 场景 | 技能 |
|------|------|
| 必用 | `writing-skills`（新建/大改技能时） |
| 宜用 | `brainstorming`（新行为、新触发条件设计） |
| 必用 | `verification-before-completion`（宣称技能可用、eval 通过前） |

## 与 OpenCode 内置 @explore 的关系

- **摸底**仍优先由 Assignment 与 `@explore` 承担；Superpowers 不改变路由表。
- `dispatching-parallel-agents` / `subagent-driven-development` 用于 **PM 拆分子任务** 或 **多代理并行**，与 `@explore` 可并列使用。

## 与 `docs/agents` 流程：张力与消解

下列对照用于避免「harness 一套、Superpowers 一套」在执行时打架。**若仍不可裁决**：**用户显式指令** > **项目级 `AGENTS.md` / `CLAUDE.md`** > **根目录 `~/.config/opencode/AGENTS.md` 与 `docs/agents` 专题中的不变量（状态机、门禁、路由）** > **Superpowers 技能的默认做法**。

| 主题 | `docs/agents` 约定 | Superpowers 相关技能 | 结论 |
|------|-------------------|---------------------|------|
| 缺陷与 RCA | `harness-loop.md`：非热修在进入**实质性代码修改**前须有可检验**根因结论或带证据的假设** | `systematic-debugging` | **一致**：技能是 RCA 门禁下的**调查方法**；承接方交付仍须满足 harness 的 RCA/证据要求。 |
| 热修 | 热修以恢复服务为先，可事后补 RCA；Assignment 须标明 Hotfix / `Branch policy` | `systematic-debugging` 可能强调「查透再改」 | **消解**：热修路径以 **Assignment + `harness-loop`** 为准；技能用于**最小变更**与**事后根因**，不要求在长调查完成前强行停改。 |
| 完成与证据 | `harness-loop.md` 反模式：无测试或行为证据即宣称完成 | `verification-before-completion` | **一致**：表述不同，目标相同（gate 前可核对证据）。 |
| Plan 形态 | `plan-convention.md`：`{PLAN_DIR}`、`status.json` SSOT（含 `metadata.residual_findings`）、`reports/<plan-id>/` | `writing-plans` | **互补**：convention 管**存放位置与结构**；writing-plans 管**多步任务如何写成可执行计划**；PM 维护时两者同时满足。**路径门限**：提示词 + **`plan-convention.md`** 约束 **`{PLAN_DIR}`** 优先于技能默认的 `docs/superpowers/plans/`（无本地同名技能覆盖）。 |
| 并行开发 | `harness-loop.md`：独立模块可并行；**先锁接口契约**再并行编码 | `dispatching-parallel-agents`、`subagent-driven-development` | **叠加约束**：并行**不免除** `branch-collaboration.md` 分支门禁——每个**可写**承接方 Assignment 仍须含 PM 批准的 **`Working branch`** / **`Branch policy`**，禁止多人各自假设 base。 |
| TDD | 全局流程**未**强制 TDD | `test-driven-development` | **项目/用户优先**：项目或用户禁止 TDD 时，不得因技能强行 TDD。 |
| `git worktree` / 多工作目录 | `branch-collaboration.md`：仅 `@project-manager` 决定开枝、`Assignment` 须写明 **`Working branch`** / **`Branch policy`**；实现方不得擅自决定分支 | `using-git-worktrees` | **不冲突，但须叠同一门禁**：worktree 只是「同一仓库多个检出目录」；**检出哪条分支、是否新建分支**仍须与 PM 已写明的策略一致。若在 worktree 里 `checkout -b`、或使用的分支与 Assignment 不一致，即违反现有约定（与是否用 worktree 无关）。 |
| 升级与重复失败 | `AGENTS.md` / `harness-loop.md`：多次失败升级人工等 | `systematic-debugging`、`verification-before-completion` | **一致**：技能减少「无根因重复改」；**达不到 harness 升级条件**时仍以文档为准。 |

**小结**：Superpowers 主要填充各阶段**如何做**的细节；**阶段顺序、Done 权限、QC/QA 路由、分支唯一决策人**仍以 `docs/agents` 与 `@project-manager` 路由表为准。

## 快速去歧义规则（建议直接复用到 Assignment）

- `QA mode: report-only` 与 `QA: skipped` 互斥，不能同时出现。
- `Hotfix` 与 `RCA complete before code changes` 互斥：热修可先最小修复，但必须补“事后 RCA”项。
- `QC: skipped` 只用于已定义例外（product-docs only / tech-spec only）；否则默认进入 QC 路径。
- `Working branch` 与 `Branch policy` 只能二选一；两者同写时，以 PM 明确改写为准后再执行。
