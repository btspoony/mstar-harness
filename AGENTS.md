# Agent 运作总览

本文件位于 `~/.config/opencode/AGENTS.md`，属于**全局配置目录**。
OpenCode **不会**自动加载本文件；agent 需在被指示时显式读取。

## 路径约定

本目录（`~/.config/opencode/`）是**全局 agent 配置**，不是项目仓库。

| 范围 | 位置 | 引用方式 |
|------|------|----------|
| Agent 提示词 | `~/.config/opencode/agents/*.md` | OpenCode 启动时自动加载 |
| Agent 系统文档 | `~/.config/opencode/docs/agents/*.md` | 绝对路径 `~/.config/opencode/docs/agents/...` |
| 本文件 | `~/.config/opencode/AGENTS.md` | 绝对路径 `~/.config/opencode/AGENTS.md` |
| 项目计划 | 项目 cwd 下的 `plans/` | 相对路径 `plans/status.json` |
| 项目规则 | 项目 cwd 下的 `AGENTS.md` | 相对路径 `AGENTS.md` |

Agent 运行时 cwd 是**项目工作目录**。相对路径解析到项目目录，而非本配置目录。

## 核心原则

- **全局配置对 agent 只读。** `~/.config/opencode/` 下的文件仅由用户本人维护。Agent 可以读取，但绝不可写入。
- 人类把控方向与决策；agent 负责执行实现细节。
- 入口保持简短，详细内容放在链接的文档中。
- 优先面向未来 agent 运行时的可读性，而非仅面向当前人类。
- 尽可能用机械化方式强制执行不变量。
- 将计划和决策视为可版本化的活文档。

## 信息源优先级

- 角色提示词：`~/.config/opencode/agents/*.md`（自动加载）
- Agent 系统文档：`~/.config/opencode/docs/agents/*.md`（按需读取）
- 项目状态与计划：`plans/status.json`（项目 cwd）
- 计划详情与决策日志：`plans/*.md`（项目 cwd）

若指引发生冲突，按以下优先级：

1. 当前任务中的用户指令
2. 项目级 `AGENTS.md`（项目 cwd 下）
3. 本全局 `~/.config/opencode/AGENTS.md`
4. `~/.config/opencode/docs/agents/*.md`
5. `~/.config/opencode/agents/*.md` 中的角色提示词

## 渐进式披露

从本文件开始，按需读取（均为绝对路径）：

1. `~/.config/opencode/docs/agents/index.md` — 角色映射与归属
2. `~/.config/opencode/docs/agents/harness-loop.md` — 执行生命周期
3. `~/.config/opencode/docs/agents/evaluation-harness.md` — 质量评估与基准
4. `~/.config/opencode/docs/agents/review-harness.md` — QC 共享基线
5. `~/.config/opencode/docs/agents/routing-harness.md` — 路由检查

除非任务复杂度要求，否则不要预加载全部文档。

## 最小交付循环

对于任何非平凡变更，遵循以下流程：

1. 澄清意图和验收标准。
2. 在项目 `plans/` 中创建或更新计划条目。
3. 将实现委派给最合适的角色 agent。
4. 签收前运行审查门禁（QC + QA）。
5. 捕获发现并更新可复用指引。

## 每个任务的必需产出

- 明确的负责人（plan status 中的 `owner` + `agents`）
- 具有可观察行为的验收标准
- 验证证据（测试、检查或复现步骤）
- 交接说明

## 架构与质量不变量

- 保持边界显式；避免隐藏的跨层耦合。
- 优先使用稳定、易理解的抽象。
- 行为变更必须同步更新测试。
- 拒绝未记录的破坏性变更。
- 将反复出现的失败编码为规则或检查。

## 文档维护

- 本全局配置（`~/.config/opencode/`）**仅由用户本人维护**。
- Agent **绝不可写入** `~/.config/opencode/` 下的文件。Agent 可以：
  - **读取**全局配置文件获取指引。
  - 在完成报告中**提议**对全局规则的修改。
- 当角色行为需要更新时，agent 应在报告中给出具体建议；由用户执行变更。
- 如果某条规则反复造成摩擦而无质量收益，请标记出来建议用户修订。

## 升级决策

以下情况升级到人工决策：

- 验收标准与系统约束冲突
- 两个可行方案有重大产品或风险取舍
- 经过两次完整实现尝试后仍然失败

升级时需包含：可选方案、权衡分析和推荐路径。
