# Agent 知识库索引

本目录（`~/.config/opencode/docs/agents/`）是 agent 系统的结构化知识库。
共享入口文件 `~/.config/opencode/docs/agents/AGENTS.md` 提供通用规则与读取顺序；
`~/.config/opencode/AGENTS.md` 仅负责本配置仓库维护入口。

**重要**：本目录中所有文件均在**全局配置**中，不在项目仓库里。
Agent 运行时 cwd 是项目工作目录，因此必须使用绝对路径（`~/.config/opencode/docs/agents/...`）来读取这些文件。

## 目标

- 保持角色提示词聚焦且稳定。
- 将可复用的流程知识从角色文件中抽离。
- 使行为可审计、易演进。

## 文档映射

以下路径均相对于 `~/.config/opencode/`：

- `docs/agents/harness-loop.md`
  - 端到端任务生命周期、归属与门禁流转；含 RCA 约定、**Spec-Driven 双阶段门禁**（`specify -> clarify -> plan` / `plan locked -> tasks -> implement`）、**Git 功能分支门禁**、可选前置门、与常见阶段化工作流的概念对照。
- `docs/agents/evaluation-harness.md`
  - 如何评估和调优 agent 提示词与工作流。
- `docs/agents/review-harness.md`
  - QC 共享审查清单、报告模板与门禁规则。
- `docs/agents/routing-harness.md`
  - 如何验证 project-manager 的路由行为。
- `docs/agents/routing-evals.json`
  - 路由评估使用的场景集。
- `docs/agents/plan-convention.md`
  - 计划目录发现、初始化、status.json 结构与状态规则。
- `docs/agents/phase-gate-playbook.md`
  - Phase Gate 执行手册：`specify -> clarify -> plan -> tasks -> implement` 的角色动作与最小证据要求。
- `docs/agents/branch-collaboration.md`
  - 可写角色的分支协作契约：仅 PM 决策开分支、feature 分支上的用户确认、以及统一确认话术模板。
- `docs/agents/superpowers-skills.md`
  - Superpowers 与角色映射、与 harness 的**对齐与消解**；**未安装插件时**见文内「未安装插件时」（上游 `INSTALL.md`；改全局 `opencode.json` 须用户同意）。
- `docs/agents/open-harness-principles.md`
  - 从公开 harness 实践提炼、且已写入 `harness-loop` / PM 的理念索引：意图门禁、Task category、可验证编辑、长任务纪律、可选分层 `AGENTS.md`。
- `docs/agents/optional-tooling-by-capability.md`
  - 按能力维度可选的 MCP/skills（文档检索、搜索、浏览器验证、Git 工作流等）；与理念对齐，避免重复堆叠。

## 归属

- 系统编排行为：`~/.config/opencode/agents/project-manager.md`
- 提示词与规则迭代行为：`~/.config/opencode/agents/prompt-engineer.md`
- 角色执行行为：`~/.config/opencode/agents/{role}.md`

跨角色工作流变更应先反映在本目录中，再同步到角色提示词。
**所有全局配置变更仅由用户本人执行**；agent 应在报告中提议变更，不得直接写入本目录。

## 更新规则（供维护全局配置的用户参考）

- 角色路由变更时，在同一次提交中更新本目录。
- 质量门禁变更时，优先更新 `harness-loop.md`。
- 评审策略变更时，优先更新 `review-harness.md`。
- 提示词调优流程变更时，优先更新 `evaluation-harness.md`。
- 计划管理约定变更时，优先更新 `plan-convention.md`。
- 编排理念（意图门禁、Task category、可验证编辑等）变更时，同步 `harness-loop.md`、`open-harness-principles.md`、`agents/project-manager.md`（含 Assignment 模板）、`phase-gate-playbook.md` 与 `routing-harness.md`（回归信号）。

## Agent 设计变更审查清单

- 共享入口（`~/.config/opencode/docs/agents/AGENTS.md`）是否仍然简短清晰？
- 角色职责是否与工作流细节分离？
- 每个阶段是否有可观察的具体产出？
- 反复出现的失败是否已转化为可复用指引？
