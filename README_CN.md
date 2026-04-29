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

1. 克隆仓库到固定源码目录：
   - `git clone https://github.com/btspoony/mstar-harness.git ~/.mstar-harness`
2. 安装到目标 code agent：
   - **Cursor（本地插件目录）**
     - `mkdir -p ~/.cursor/plugins/local`
     - `ln -sfn ~/.mstar-harness ~/.cursor/plugins/local/mstar-harness`
   - **OpenCode（软链接内容，不软链接整个目录）**
     - `mkdir -p ~/.config/opencode/agents ~/.config/opencode/skills`
     - `ln -sfn ~/.mstar-harness/agents/*.md ~/.config/opencode/agents/`
     - `ln -sfn ~/.mstar-harness/skills ~/.config/opencode/skills`
     - `ln -sfn ~/.mstar-harness/.opencode/skills/* ~/.config/opencode/skills/`

完成以上两步即安装完成。

你可以在 `opencode.json` 里为不同 agent 指定 model。配置结构可参考 `opencode.example.json`，仅作为参考，不需要覆盖你现有的 `opencode.json`。

## 宿主入口（OpenCode vs Cursor）

| 宿主 | 你要先做什么 |
|------|-------------|
| **OpenCode** | 通常自动注入根目录 `AGENTS.md`；再由 `.opencode/skills/mstar-host/SKILL.md` 补齐宿主差异 |
| **Cursor** | 先手动 Read 根目录 `AGENTS.md`，再 Read `.cursor-plugin/skills/mstar-host/SKILL.md` |

无论哪个宿主，推荐统一顺序：

1. `AGENTS.md`
2. 当前宿主的 `mstar-host` skill
3. `skills/mstar-roles/SKILL.md`
4. 对应角色 `Role reference`

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

**仅 Cursor 维护：** PM 路由场景回归与 `Routing Eval Report` 在 **`.cursor/skills/mstar-routing-eval/`**（维护专用）；运行时宿主技能在 **`.cursor-plugin/skills/`**。见 `.cursor/rules/repo-maintenance.mdc`。

## 常见使用流（最短）

### 我想马上开工

1. 先读 `AGENTS.md`
2. 由 `project-manager` 建立任务上下文并分派
3. 执行角色按 `mstar-roles` + 对应 skills 工作
4. 经 QC / QA 门禁后收口

### 我只想快速定位规则入口

- 全局入口：`AGENTS.md`
- 核心流程：`skills/mstar-harness-core/SKILL.md`
- 角色总线：`skills/mstar-roles/SKILL.md`

## 深入文档

- `AGENTS.md`：全局入口与索引
- `skills/mstar-harness-core/`：核心执行规则
- `skills/mstar-roles/`：角色正文与参数化
- `skills/mstar-plan-conventions/`：plan 与状态约定

> 维护者流程、跨文件同步规则、lint/维护清单等内容，统一放在维护规则文档中，不在面向使用者的 README 展开。

## 许可

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。
