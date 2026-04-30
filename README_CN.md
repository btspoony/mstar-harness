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
- 在 OpenCode / Cursor / Codex 下复用同一套核心流程

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

### Codex 安装方式

- Marketplace 安装（推荐）：
  - `codex plugin marketplace add https://github.com/btspoony/mstar-harness.git --sparse .codex/`
  - 从新增的 marketplace 中安装 **Morning Star Harness**。

完成以上两步即安装完成。

你可以在 `opencode.json` 里为不同 agent 指定 model，而不需要覆盖你现有配置。OpenCode 的详细安装与迁移说明见 `.opencode/INSTALL.md`。

## 使用方式

- **OpenCode**：以 `Project Manager` 角色开局（对应 `agents/project-manager.md`，通常是 `opencode.json` 里的 `agent.project-manager`）。
- **Cursor**：使用 `/pm` 强制以 `Project Manager` 角色启动。
- **Codex**：安装插件后，使用 `/pm` 强制以 `Project Manager` 角色启动。

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
| `pm` | Cursor 与 Codex 共享的 `/pm` 强制入口 |

## Harness Workflow（统一流程）

```mermaid
flowchart TD
    A["PM: 入口与意图澄清"] --> B{"PM: 规格与上下文是否就绪"}
    B -->|否| C["PM: 继续澄清并补齐需求约束"]
    C --> B
    B -->|是| D["PM: 初始化或加载 HARNESS_DIR 与 PLAN_DIR"]
    D --> E["PM: 创建或选择 active plan 并更新 status.json SSOT"]
    E --> F["PM: 任务路由与角色分派"]
    F --> G{"PM: 任务类型"}
    G -->|大型或高歧义| H["Explore、产品经理、架构师前置产出"]
    H --> I["开发团队: 开发轨实现"]
    G -->|中小型或常规 Bug| I
    I --> J["开发责任人与 PM: 持续记录 notes 与 findings"]
    J --> K["QC 审查员: QC 审查门禁 (默认: QC 三审并行)"]
    K --> L{"PM: 汇总后的 QC 结论"}
    L -->|Request Changes| M["PM: 分派给开发责任人修复"]
    M --> I
    L -->|Approve 或讨论已消解| N["QA 工程师: QA 验证"]
    N --> O{"PM 与 QA: 是否仍有 residual findings"}
    O -->|是| P["PM: 写入 status.json 并安排后续跟踪"]
    P --> Q["QA 或 PM: 基于可追溯证据完成签收"]
    O -->|否| Q
    Q --> R["PM: 标记 done 并归档上下文"]
```

## 许可

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。
