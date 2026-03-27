# OpenCode Agents 配置

本仓库是一套面向 **OpenCode** 的多智能体（Agents）配置，可复用于日常开发与协作。配置以「虚拟团队」方式组织：一名主代理协调多个子角色，按职责分工完成任务。

## Harness Engineering 结构

为支持可持续迭代，本仓库采用“短入口 + 结构化知识库”：

> **注意**: 以下路径均相对于本全局配置目录 `~/.config/opencode/`。
> Agent 运行时 cwd 是项目目录，agent prompt 中引用这些文件需使用**绝对路径**。
> 全局配置（`~/.config/opencode/`）对 agent 只读：agent 只能读取和提出建议，实际写入由用户本人维护。

- `AGENTS.md`：本配置仓库维护入口（边界与变更原则）
- `agents/*.md`：各角色 OpenCode agent 提示词（frontmatter + 正文），由 `opencode.json` 的 `agent` 引用加载
- `docs/agents/AGENTS.md`：共享规则入口（跨角色/跨项目复用）
- `docs/agents/index.md`：agents 知识库索引与维护规则
- `docs/agents/harness-loop.md`：任务生命周期与门禁流转（含 RCA、Git 功能分支门禁）
- `docs/agents/branch-collaboration.md`：分支协作契约（仅 PM 决策开枝、Assignment 话术）
- `docs/agents/evaluation-harness.md`：prompt / 流程迭代评估方法
- `docs/agents/review-harness.md`：QC 三审共享基线与报告模板
- `docs/agents/routing-harness.md` + `docs/agents/routing-evals.json`：路由回归评估集
- `docs/agents/plan-convention.md`：计划目录发现、初始化与 status.json 约定
- `docs/agents/superpowers-skills.md`：Superpowers 与角色映射、与 harness 的对齐说明；未装插件时的上游安装指引

建议优先阅读 `AGENTS.md`（仓库维护入口），再读 `docs/agents/AGENTS.md`（共享规则入口），最后按需进入 `docs/agents/` 专题文档。

本仓库根目录还有 `opencode.json`（主配置）、`plugins/`（可选插件，如 OpenViking）、`package.json`（`@opencode-ai/plugin` 等本地依赖，按需安装）。

### 计划管理模式（兼容无 `plans/` 项目）

当前体系支持“有 plan 目录”和“无 plan 目录”两种项目形态：

- **目录发现优先级**：`.agents/plans/` > `.plans/` > `plans/`
- **默认低侵入**：若需主动启用，优先创建 `.agents/plans/`
- **Git 忽略建议**：若由体系主动创建 `.agents/plans/`，应在项目 `.gitignore` 中加入 `.agents/plans/`
- **无 plan 目录时**：不强制创建；@project-manager 通过对话与 Completion Report 维护进度，门禁（QC/QA）照常执行

完整规则见 `docs/agents/plan-convention.md`。

## 概述

- **配置规范**：遵循 [OpenCode](https://opencode.ai) 的 `opencode.json` 结构。
- **角色提示词**：`agents/<agent-id>.md` 与 `opencode.json` 中的 `agent` 键一一对应（如 `project-manager.md`）。
- **默认主代理**：`project-manager`（项目经理），负责协调与进度管理。
- **子代理**：产品、架构、前后端开发、测试、质量、运维、市场、提示词工程等角色，按需被主代理调度。
- **计划管理**：统一遵循 `docs/agents/plan-convention.md`，支持 `{PLAN_DIR}` 动态解析，而非仅绑定 `plans/`。

## Agent 角色说明

| Agent ID           | 角色           | 模式     | 说明                         |
|--------------------|----------------|----------|------------------------------|
| `project-manager`  | 项目经理       | primary  | 协调团队、管理进度           |
| `product-manager`  | 产品经理       | subagent | 需求分析、产品规划           |
| `architect`        | 技术架构师     | subagent | 架构设计、技术决策           |
| `fullstack-dev`    | 全栈开发       | subagent | 前后端功能实现               |
| `fullstack-dev-2`  | 全栈开发（协作）| subagent | 协作实现                     |
| `frontend-dev`     | 前端开发       | subagent | UI、前端架构与体验优化       |
| `qa-engineer`      | 测试工程师     | subagent | 测试用例与自动化测试         |
| `qc-specialist`    | 质量控制专家 #1 | subagent | 代码审查，主审架构/可维护性  |
| `qc-specialist-2`  | 质量控制专家 #2 | subagent | 代码审查，主审安全/正确性    |
| `qc-specialist-3`  | 质量控制专家 #3 | subagent | 代码审查，主审性能/可靠性    |
| `ops-engineer`     | 运维工程师     | subagent | 部署、监控与基础设施         |
| `market-expert`    | 市场专家       | subagent | 市场分析与用户研究           |
| `prompt-engineer`  | 提示词工程师   | subagent | 提示词/Agents/规则/技能整理  |

各子代理绑定不同模型（如 GLM-5、Qwen、Kimi、MiniMax 等），可在 `opencode.json` 的 `agent` 与 `provider` 中按需修改。

### 质量审查（QC 三审）

默认代码变更走 **QC 三审并行**：`@qc-specialist`、`@qc-specialist-2`、`@qc-specialist-3` 从不同视角审查（架构/可维护性、安全/正确性、性能/可靠性），同时遵守统一的 **Shared Baseline**（功能回归、阻塞级安全与数据一致性、测试充分性）。仅 Hotfix 可走单审快速通道（`@qc-specialist`）。

- **汇总**：三审完成后由 **@project-manager** 做轻量汇总（去重、冲突按证据裁决），产出单一 gate 结论（Approve / Request Changes / Needs Discussion）。
- **修复归属**：QC 只负责发现问题与建议；**修复工作默认分派给开发团队**（@fullstack-dev / @frontend-dev / @fullstack-dev-2），修复后再回流 QC/QA 复验。

### Superpowers 插件（可选）

在 `opencode.json` 的 `plugin` 中加入官方 Git 源即可（重启后由 OpenCode 安装并注册技能），例如：

```json
"plugin": ["superpowers@git+https://github.com/obra/superpowers.git"]
```

与虚拟团队流程的对齐、各角色建议加载的技能、以及与分支门禁等的**张力消解**，见 `docs/agents/superpowers-skills.md`。若当前未安装，可按该文档 **「未安装插件时」** 拉取上游 `INSTALL.md` 逐步操作（修改全局 `opencode.json` 前须用户同意）。

### OpenViking 记忆插件

若在 `~/.config/opencode/plugins/` 中启用 **OpenViking Memory** 插件（`openviking-memory.ts`），各 agent 将具备需**主动调用**的语义记忆工具：`memsearch`（搜索记忆/资源）、`memread`（按 viking:// URI 读取）、`membrowse`（浏览目录）。各 agent 说明中均有「OpenViking 记忆工具」小节描述何时使用这三者。`memcommit`（会话沉淀）由插件按配置定时自动执行（见 `plugins/openviking-config.json` 的 `autoCommit.enabled` 与 `intervalMinutes`），agent 无需也不应主动调用。使用前请确保 OpenViking 服务已运行且配置中 `enabled: true`。

## 如何设置 Agents（opencode.json 示例）

在 OpenCode 中，Agents 通过 `opencode.json` 的 `agent` 字段定义。每个 agent 需指定 `description`、`mode`（`primary` 主代理或 `subagent` 子代理）和 `model`（对应 `provider` 中配置的模型引用）。

```json
{
    "$schema": "https://opencode.ai/config.json",
    "permission": {
        "external_directory": {
            "~/.config/opencode/docs/agents/**": "allow"
        },
        "read": "allow",
        "grep": "allow",
        "glob": "allow"
    },
    "model": "provider-id/default-model-id",
    "small_model": "provider-id/light-model-id",
    "default_agent": "project-manager",
    "plugin": ["superpowers@git+https://github.com/obra/superpowers.git"],
    "mcp": {},
    "provider": {},
    "agent": {
        "project-manager": {
            "description": "项目经理 - 协调开发团队，管理项目进度",
            "mode": "primary",
            "model": "provider-id/model-id"
        },
        "product-manager": {
            "description": "产品经理 - 需求分析和产品规划",
            "mode": "subagent",
            "model": "provider-id/model-id"
        },
        "architect": {
            "description": "技术架构师 - 系统架构设计和技术决策",
            "mode": "subagent",
            "model": "provider-id/model-id"
        },
        "fullstack-dev": {
            "description": "全栈开发工程师 - 实现前后端功能",
            "mode": "subagent",
            "model": "provider-id/model-id"
        },
        "fullstack-dev-2": {
            "description": "全栈开发工程师 - 实现前后端功能（协作）",
            "mode": "subagent",
            "model": "provider-id/model-id"
        },
        "frontend-dev": {
            "description": "前端开发工程师 - UI/前端架构与体验优化",
            "mode": "subagent",
            "model": "provider-id/model-id"
        },
        "qa-engineer": {
            "description": "测试工程师 - 编写测试用例和自动化测试",
            "mode": "subagent",
            "model": "provider-id/model-id"
        },
        "qc-specialist": {
            "description": "质量控制专家 - 代码审查，主审架构/可维护性",
            "mode": "subagent",
            "model": "provider-id/model-id"
        },
        "qc-specialist-2": {
            "description": "质量控制专家（Reviewer #2）- 主审安全/正确性",
            "mode": "subagent",
            "model": "provider-id/model-id"
        },
        "qc-specialist-3": {
            "description": "质量控制专家（Reviewer #3）- 主审性能/可靠性",
            "mode": "subagent",
            "model": "provider-id/model-id"
        },
        "ops-engineer": {
            "description": "运维工程师 - 部署、监控和基础设施",
            "mode": "subagent",
            "model": "provider-id/model-id"
        },
        "market-expert": {
            "description": "市场专家 - 市场分析和用户研究",
            "mode": "subagent",
            "model": "provider-id/model-id"
        },
        "prompt-engineer": {
            "description": "提示词工程师 - 设计与优化 Agent 提示词与技能",
            "mode": "subagent",
            "model": "provider-id/model-id"
        }
    }
}
```

### Agent 配置要点

- **`default_agent`**：入口主代理 ID，此处为 `project-manager`。
- **`model` / `small_model`**（可选）：全局默认与轻量模型；也可仅在各 `agent` 上指定 `model`。
- **`plugin`**：OpenCode 插件列表；不需要 Superpowers 时可设为 `[]`。
- **`agent`**：每个键为 agent ID（通常对应 `agents/<id>.md`），值为 `description`、`mode`、`model`。
  - `mode: "primary"`：主代理，负责协调与派发任务。
  - `mode: "subagent"`：子代理，被主代理调度执行具体角色。
- **`model`**：格式为 `provider-id/model-id`，需在 `provider` 中已配置对应服务与模型。

## 配置结构简介

- **permission**：读写、grep、glob 及外部目录（如 `~/workspace/**`、是否允许读取本仓库 `docs/agents/**`）的访问权限。
- **model / small_model**：默认推理模型与轻量模型。
- **plugin**：第三方技能包（如 Superpowers）；空数组表示不加载插件。
- **mcp**：MCP 服务（如 GitNexus、网页搜索、阅读等），可按需启用或改为自己的端点与密钥。
- **provider**：各模型服务商与 API 配置（需自行填入 API Key 等）。
- **agent**：上述角色与 `mode`、`model` 的映射；详细行为以 `agents/*.md` 为准。

## 许可与使用

本配置以开源形式分享，便于他人复用与二次定制。使用 OpenCode 时请遵守其官方条款及各模型/MCP 服务商的使用政策。
