# Agent 知识库索引

本目录（`~/.config/opencode/docs/agents/`）是 agent 系统的结构化知识库。
全局入口文件 `~/.config/opencode/AGENTS.md` 指向此处提供深层指引。

**重要**：本目录中所有文件均在**全局配置**中，不在项目仓库里。
Agent 运行时 cwd 是项目工作目录，因此必须使用绝对路径（`~/.config/opencode/docs/agents/...`）来读取这些文件。

## 目标

- 保持角色提示词聚焦且稳定。
- 将可复用的流程知识从角色文件中抽离。
- 使行为可审计、易演进。

## 文档映射

以下路径均相对于 `~/.config/opencode/`：

- `docs/agents/harness-loop.md`
  - 端到端任务生命周期、归属与门禁流转。
- `docs/agents/evaluation-harness.md`
  - 如何评估和调优 agent 提示词与工作流。
- `docs/agents/review-harness.md`
  - QC 共享审查清单、报告模板与门禁规则。
- `docs/agents/routing-harness.md`
  - 如何验证 project-manager 的路由行为。
- `docs/agents/routing-evals.json`
  - 路由评估使用的场景集。

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

## Agent 设计变更审查清单

- 入口文件（`~/.config/opencode/AGENTS.md`）是否仍然简短清晰？
- 角色职责是否与工作流细节分离？
- 每个阶段是否有可观察的具体产出？
- 反复出现的失败是否已转化为可复用指引？
