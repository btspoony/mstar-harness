<div align="center">

### Morning Star (启明星) — 编码智能体 Harness 框架

[English](README.md) / 中文

<a href="https://github.com/btspoony/mstar-harness">GitHub</a> · <a href="https://github.com/btspoony/mstar-harness/issues">Issues</a>

[![](https://img.shields.io/badge/license-MIT-white?labelColor=black\&style=flat-square)](https://github.com/btspoony/mstar-harness/blob/main/LICENSE)
[![](https://img.shields.io/github/last-commit/btspoony/mstar-harness?color=c4f042\&labelColor=black\&style=flat-square)](https://github.com/btspoony/mstar-harness/commits/main)

</div>

本项目为 **Morning Star / 启明星** 的多角色 code agent harness框架。

你能获得的核心价值：

- 快速启动一套可用的多角色协作流
- 通过统一的 `mstar-*` skills 执行，而不是散落规则
- 在 OpenCode / Cursor 下复用同一套核心流程

## 快速开始（推荐方式）

### Cursor 安装方式

- 本地插件安装（直接 clone）：
  - `mkdir -p ~/.cursor/plugins/local`
  - `git clone https://github.com/btspoony/mstar-harness.git ~/.cursor/plugins/local/mstar-harness`
  - 重启 Cursor or 运行 `Developer: Reload Window`

### OpenCode 安装方式

- 推荐使用 plugin 安装：
  - 在 `opencode.json` 增加插件配置：
    ```json
    {
      "plugin": [
        "superpowers@git+https://github.com/obra/superpowers.git",
        "morning-star@git+https://github.com/btspoony/mstar-harness.git"
      ]
    }
    ```
  - 重启 OpenCode

完成以上两步即安装完成。

你可以在 `opencode.json` 里为不同 agent 指定 model，而不需要覆盖你现有配置。OpenCode 的详细安装与迁移说明见 `.opencode/INSTALL.md`。

## 宿主入口（OpenCode vs Cursor）

| 宿主 | 你要先做什么 |
|------|-------------|
| **Cursor** | 由插件强制规则 `rules/mstar-entry.mdc` 先加载 core |
| **OpenCode** | 由插件 `.opencode/plugins/mstar.ts` 注入 `.opencode/AGENTS.md`，强制进入 core |

进入 core 后，会自动加载对应宿主的 `mstar-host` 适配层。

对用户来说，流程可以理解为：

1. 安装对应宿主的插件。
2. 重启宿主会话。
3. 让 Morning Star 自动完成 core + host adapter 加载。
4. 按正常角色协作方式工作。

建议从 PM 角色启动：

- **OpenCode**：以 `agents/project-manager.md` 对应的 PM 角色开始聊天（即 `opencode.json` 配置的 `agent.project-manager`）。
- **Cursor**：优先使用 `/pm`，强制启用 PM 角色后再做任务编排。

## 角色与技能总览

### 角色分工（Who does what）

| Agent ID | 角色 | 主要职责 |
|----------|------|---------|
| `project-manager` | 项目经理 | 路由、分派、阶段推进 |
| `product-manager` | 产品经理 | 需求与产品向文档 |
| `architect` | 架构师 | 架构与技术契约 |
| `fullstack-dev` / `fullstack-dev-2` | 全栈开发 | 后端主导实现 / 第二并行轨 |
| `frontend-dev` | 前端开发 | UI、交互、前端性能 |
| `qa-engineer` | QA | 测试与验收验证 |
| `qc-specialist*` | QC 三审 | 代码质量门禁（架构/安全/性能） |
| `ops-engineer` | 运维 | 部署、监控、基础设施 |
| `market-expert` | 市场专家 | 市场与用户研究 |
| `prompt-engineer` | 提示词工程师 | prompt / skill / rule 优化 |

### 核心技能（What drives behavior）

| Skill | 作用 |
|-------|------|
| `mstar-harness-core` | 全局入口、状态机、门禁与不变量 |
| `mstar-plan-conventions` | plan / status / residual 的统一约定 |
| `mstar-review-qc` | QC 审查标准与报告模板 |
| `mstar-coding-behavior` | 通用编码行为基线 |
| `mstar-superpowers-align` | 与 Superpowers 的对齐与冲突消解 |
| `mstar-roles` | 角色提示词总线（角色正文在 `references/`） |
| `mstar-host`（按宿主） | 宿主能力差异（OpenCode / Cursor） |

**Morning Star 加载顺序：** 任意会话或任务中，**须先 Read `skills/mstar-harness-core/SKILL.md`**，再读其它 `skills/mstar-*/SKILL.md`。各非核心 skill 正文开头的 **「Load order」** 小节重复此要求；冲突以 **`mstar-harness-core`** 为准。详见该文件「与其它 `mstar-*` skill 的加载契约」。

## 许可

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。
