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

### CLI Install

- 使用 `mstar-harness` CLI（npm 包名 `@mstar-harness/cli`）：
  - `npx @mstar-harness/cli init`
  - 或 `bunx @mstar-harness/cli init`
- `init` 提供按 target 的引导式安装流程，将安装与基础配置一步完成。
- CLI 当前支持的 target：
  - OpenCode：`npx @mstar-harness/cli init --target opencode`
  - Cursor：`npx @mstar-harness/cli init --target cursor`
  - Codex：
    - `npx @mstar-harness/cli init --target codex`
    - `codex plugin add morning-star-harness --marketplace personal`
- Cursor 与 Codex 安装共享长期维护的本地 checkout：`~/.mstar/harness`；各宿主的 plugin / agent 入口通过软链接指向该目录。

完整 CLI 用法和高级参数（`--yes`、`--dry-run`、`--output`、`doctor`），以及 Cursor / Codex target 的安装模式说明，见 [`docs/cli.md`](docs/cli.md)。

### Manual Install

当前支持手动安装的 target：

- `opencode`
- `cursor`
- `codex`

#### OpenCode

- 推荐使用 plugin 安装：
  - 在 `opencode.json` 增加插件配置：
    ```json
    {
      "$schema": "https://opencode.ai/config.json",
      "plugin": [
        "superpowers@git+https://github.com/obra/superpowers.git",
        "@mstar-harness/opencode@latest"
      ]
    }
    ```
  - 重启 OpenCode
- OpenCode 插件**只从 `@mstar-harness/opencode` 包内路径**解析 skills/agents（**不**依赖 `process.cwd()`）。发布包内含 `harness-skills/`、`harness-agents/`。若在本仓库 **git 工作区**开发，请在**仓库根**执行 **`bun install` / `npm install`**，以便 `postinstall` 执行 `opencode:bundle-assets`，在 `packages/opencode/` 下生成上述目录。

OpenCode 的详细安装与迁移说明见 `packages/opencode/INSTALL.md`。

#### Cursor

- 推荐：
  - `npx @mstar-harness/cli init --target cursor --scope global`
  - 重启 Cursor 或运行 `Developer: Reload Window`
- 手动安装（与 CLI 使用相同路径）：
  - `git clone https://github.com/btspoony/mstar-harness.git ~/.mstar/harness`
  - `mkdir -p ~/.cursor/plugins/local`
  - `ln -s ~/.mstar/harness ~/.cursor/plugins/local/morning-star-harness`
  - 重启 Cursor 或运行 `Developer: Reload Window`

#### Codex

- Personal marketplace 安装（不使用 CLI）：
  - clone 或更新长期本地 checkout：
    - `git clone https://github.com/btspoony/mstar-harness.git ~/.mstar/harness`
  - 创建或更新 `~/.agents/plugins/marketplace.json`：
    ```json
    {
      "name": "personal",
      "interface": {
        "displayName": "Personal"
      },
      "plugins": [
        {
          "name": "morning-star-harness",
          "source": {
            "source": "local",
            "path": "./.mstar/harness"
          },
          "policy": {
            "installation": "AVAILABLE",
            "authentication": "ON_INSTALL"
          },
          "category": "Productivity"
        }
      ]
    }
    ```
  - 安装插件：
    - `codex plugin add morning-star-harness --marketplace personal`
  - 链接 Codex custom agents：
    - `mkdir -p ~/.codex/agents`
    - `ln -s ~/.mstar/harness/codex/agents/*.toml ~/.codex/agents/`
- 本仓库也是 **Morning Star Harness Codex 插件源码**：
  - 插件 manifest：`.codex-plugin/plugin.json`
  - 运行时 skills：`skills/`
  - Codex custom agents：`codex/agents/`
  - Codex 运行时适配：`skills/mstar-host/references/codex.md`

## 使用方式

- **OpenCode**：以 `Project Manager` 角色开局（对应 `agents/project-manager.md`，通常是 `opencode.json` 里的 `agent.project-manager`）。
- **Cursor**：使用 `/pm` 强制以 `Project Manager` 角色启动。
- **Codex**：安装插件后，使用 `/pm` 强制以 `Project Manager` 角色启动。
  CLI / 手动安装链接 `codex/agents/` 后，Codex 可通过 custom agents 执行 Morning Star 角色派发。

## 角色与技能总览

### 角色分工（Who does what）

| Agent ID | 角色 | 主要职责 |
|----------|------|---------|
| `project-manager` | 项目经理 | 路由、分派、阶段推进 |
| `product-manager` | 产品经理 | 需求、产品规划与市场/用户研究 |
| `architect` | 架构师 | 架构与技术契约 |
| `fullstack-dev` / `fullstack-dev-2` | 全栈开发 | 后端主导实现 / 第二并行轨 |
| `frontend-dev` | 前端开发 | UI、交互、前端性能 |
| `qa-engineer` | QA | 测试与验收验证 |
| `qc-specialist` / `qc-specialist-2` / `qc-specialist-3` | QC 三审 | 代码质量门禁（架构/安全/性能） |
| `ops-engineer` | 运维 | 部署、监控、基础设施 |
| `writing-specialist` | 写作专家 | 文档写作、小说写作、文案写作与脚本写作 |
| `prompt-engineer` | 提示词工程师 | prompt / skill / rule 优化 |

你可以在 `opencode.json` 中为每个角色指定不同的模型（以及模型供应商）。

### 核心技能（What drives behavior）

先读 **`mstar-harness-core`**，再按角色与任务 **按需** 加载专题 skill（详见 `mstar-roles` 各角色必读清单）。

| Skill | 作用 |
|-------|------|
| `mstar-harness-core` | 全局入口、状态机、Task category、skill 索引 |
| `mstar-phase-gates` | Prepare/Execute 门禁、clarify、hotfix |
| `mstar-dispatch-gates` | PM 派发、Delegation、反递归、并行 invoke |
| `mstar-branch-worktree` | 功能分支、worktree、QC/QA 检出对齐 |
| `mstar-plan-conventions` | `{HARNESS_DIR}` 发现、初始化、Spec 分支摘要 |
| `mstar-plan-artifacts` | 主 plan、`reports/`、`status.json`、residual、knowledge、Done 归档 |
| `mstar-review-qc` | QC 审查标准与报告模板 |
| `mstar-coding-behavior` | 通用编码行为基线 |
| `mstar-superpowers-align` | 与 Superpowers 的对齐与冲突消解 |
| `mstar-roles` | 角色提示词总线 + 各角色 skill 加载清单 |
| `mstar-host` | 宿主适配（OpenCode / Cursor / Codex）；自动识别 + `references/` |
| `pm` | Cursor 与 Codex 共享的 `/pm` 强制入口 |

维护者：进行中的 spec/plan 可放在 **`.harness/`**（gitignore，非发布 skill 树）。

项目计划工件默认使用 **`.mstar/`**（`{HARNESS_DIR}`），同时继续识别既有 `.agents/` / `.plans/` / `plans/` 布局。

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
