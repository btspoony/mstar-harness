---
name: mstar-host-opencode
description: Morning Star (启明星) harness 在 OpenCode 宿主上的加载方式与专属能力 —— 全局 Rules 自动注入 AGENTS.md、`~/.config/opencode/agents/*.md` 角色加载、内置 `question` 工具（结构化澄清）、内置 `@explore` 只读导航与 `@general` subagent、具名角色需 PM 经宿主入口实际拉起（仅打印 Assignment Markdown 不会自动创建子代理）、按角色模型（`opencode.json` 中 `agent.<id>.model`）。也包含 **OpenCode-relevant** 的库文档检索协议（Context7 MCP vs ctx7 CLI；禁双跑）、按能力选配 MCP（现行文档 / Web 检索 / 代码模式 / 仓库图谱 / 浏览器 E2E / Git 工作流 / 系统化排障）、`opencode.json` 的密钥占位 `{env:…}` / `{file:…}` 与本仓库示例环境变量。OpenCode 使用者在会话开始前必读；`@project-manager` 编排前必读，以决定是否用 `question` 工具做结构化澄清；任何角色读取或建议修改 `opencode.json` / 密钥文件前必读（修改仅由用户本人执行）。Cursor 宿主请读 `.cursor/skills/mstar-host/SKILL.md`。
---

# Morning Star × OpenCode Host Adapter

本 skill 合并取代旧文档 `docs/agents/host-opencode.md` + `docs/agents/library-docs-and-hosts.md`（OpenCode 视角） + `docs/agents/optional-tooling-by-capability.md` + `docs/agents/opencode-config-secrets.md`，描述 **Morning Star harness 在 OpenCode 上运行时**的加载方式与专属能力。**中性流程与不变量**仍以 `mstar-harness-core` 为准。

## 规则与角色如何加载

- **全局规则**：OpenCode 会将 `~/.config/opencode/AGENTS.md` 作为 [Global Rules](https://opencode.ai/docs/rules/#global) 在每会话注入。
- **角色提示词**：`~/.config/opencode/agents/*.md` 由 `opencode.json` 的 `agent` 配置引用；`agent.<id>` 与文件名 `agents/<id>.md` 对齐。
- **密钥与插件**：`opencode.json`、凭据约定见下文「密钥与 `opencode.json`」；Superpowers 等插件的消解见 `mstar-superpowers-align`。

## OpenCode 专属能力（其他宿主可能没有）

- **结构化澄清**：优先使用内置 **`question`** 工具（标题、题干、选项；可自定义文本回答）。须在配置中允许 `permission.question`（由用户维护；agent 不得擅自改全局配置）。
- **内置子代理**：如 **`@explore`**（只读导航）、**`@general`** 等，由 OpenCode 调度；语义上仍须遵守 `mstar-harness-core` SKILL.md 中对 `@explore` 边界等的约定。
- **具名角色（`@<agent-id>`）**：配置在 `opencode.json` 的 `agent.<id>`（与 `agents/<id>.md` 同名）的角色，须由 **PM 通过宿主提供的入口实际拉起**（例如对 `@fullstack-dev` 发起一轮子代理 / Task，以 Assignment 为消息体）。**仅**在主会话里打印 `## Assignment` Markdown **不会**自动创建子代理会话；若未见子代理启动，属于**未分派**，见 `agents/project-manager.md` **§2** 与 **Q13**。
- **按角色模型**：可在 `opencode.json` 为不同 subagent 配置不同 `model`。

## 与 Cursor 的差异摘要

需要对比 Cursor 下的用法时，见 `.cursor/skills/mstar-host/SKILL.md`。**入口级差异**（文件谁注入、有无 subagent）以本 skill 与 Cursor 专属 skill 为准；**流程与门禁**仍以 `mstar-harness-core` 等流程类 skill 为权威。

---

## 库文档检索（Context7；单一协议）

**目标**：回答涉及具体框架、SDK、CLI、云服务的 API 与配置问题时，用现行文档而非训练数据；优先 Context7，再考虑 Web 检索。

**不适用**：纯重构、从零写脚本、业务逻辑排错、代码评审、泛化编程概念（与 `find-docs` / Context7 技能边界一致）。

### 优先级（选一种路径，不要双跑）

1. **主路径 — Context7 MCP（可用时）**  
   若当前宿主已启用 Context7 MCP（例如 OpenCode 内 `user-context7` 或等价名）：
   - 先读 MCP 工具 schema，再调用（工具名以实际 MCP 为准，常见为 `resolve-library-id` / `query-docs` 或等价）。
   - 用用户**完整问题**作为查询句；版本相关时选用带版本后缀的 library ID。

2. **备用路径 — ctx7 CLI（无 MCP 或 MCP 不可用时）**  
   在可执行 shell 的环境中：
   - `npx ctx7@latest library <name> "<user's question>"`
   - `npx ctx7@latest docs <libraryId> "<user's question>"`  
   每问最多 3 次命令；查询中不得含密钥。配额失败时提示 `npx ctx7@latest login` 或 `CONTEXT7_API_KEY`。

**禁止**：同一问题内对同一库交替 MCP 与 CLI 重复全量拉取（浪费 token 与配额）。选一径到底；仅在第一条路径失败时再切换备用路径。

---

## 会话上下文与插件注入（降噪）

- **大型平台注入**（例如 Vercel 生态长文、SessionStart hook）：与当前任务栈无关时，占用上下文且易与项目技术选型冲突。建议在**非 Vercel 项目**关闭对应规则/插件，或改为按需规则（`alwaysApply: false` + 描述触发条件）。
- **多个搜索/文档 MCP**：同类能力只保留一个默认主通道。

---

## 按能力选配的 MCP / Skills

本节按**能力维度**列出可选增强项，与 `mstar-harness-core` `references/open-harness-principles.md` 中的「文档检索、可观察验证、结构化探索」等理念对应。是否接入由用户决定；**修改全局 `opencode.json` 须用户明确同意**。

| 能力 | 用途 | 说明 |
|------|------|------|
| **现行文档** | 库/API 随版本变化，减少幻觉 | Context7 类 MCP，或宿主已配置的等价文档工具（见上节） |
| **Web 检索** | 时效信息、issue、迁移说明 | 本仓库若已配置搜索类 MCP，避免重复堆多个同类 |
| **代码模式检索** | 跨仓库参考实现 | 例如 `https://mcp.grep.app`；本配置若已有 `grep` MCP 则已覆盖 |
| **仓库图谱 / 影响分析** | 依赖与调用关系、PR 风险 | 例如 GitNexus（本仓库 `opencode.json` 已示例时即用） |
| **浏览器 / E2E 验证** | 用户可见流程、取证 | agent-browser、Playwright 等 skill；与 QA「可观察证据」一致 |
| **Git 工作流** | 原子提交、分支收口 | `git-commit`、`finishing-a-development-branch` 等 |
| **系统化排障** | RCA 再修复 | Superpowers `systematic-debugging`（见 `mstar-superpowers-align`） |

### 不建议

- 多个功能重叠的「搜索 MCP」同时常开，浪费上下文与配额。
- 在未跑通本 harness Phase Gate 的情况下，用更多工具掩盖流程缺口。

---

## 密钥与 `opencode.json`

`opencode.json` 支持占位替换（见 [OpenCode Config — Variables](https://opencode.ai/docs/en/config)）：

- `{env:VARIABLE_NAME}` — 从环境变量读取  
- `{file:path}` — 从文件读取（路径可为 `~/.config/opencode/.secrets/...`）

### 本仓库示例所用的环境变量

当使用仓库内的 `opencode.json` 模板时，请在启动 OpenCode **之前**导出下列变量（名称与 `opencode.json` 中 `{env:...}` 一致）：

| 变量 | 用途 |
|------|------|
| `MINIMAX_API_KEY` | MiniMax API Key |
| `Z_AI_API_KEY` | 智谱 BigModel API Key |
| `MOONSHOT_API_KEY` | MoonShot(Kimi) API Key |
| `DASHSCOPE_API_KEY` | 阿里云百炼 / DashScope（`bailian-coding-plan` 的 `apiKey`） |
| `CONTEXT7_API_KEY` | Context7 API Key |

可复制 `secrets.env.example` 为本地 `secrets.env`（勿提交），执行 `set -a && source secrets.env && set +a` 后再启动 CLI/TUI。

若 `{env:...}` 在某字段未生效（已知部分版本对个别嵌套字段有问题），可改用 `{file:~/.config/opencode/.secrets/<name>}`，文件内容为**单行**密钥，`chmod 600`。

### 安全建议

- 不要将含真实密钥的 `opencode.json` 提交到 Git。  
- 本仓库 `.gitignore` 已忽略 `secrets.env` 与 `.secrets/`；若你自行取消对 `opencode.json` 的忽略，务必改用 env 或 file 占位。
- **agent 不得擅自改** `opencode.json` 或 `secrets.env` / `.secrets/*`：如需变更，提建议交由用户本人落盘。
