# OpenCode Agents 配置

本仓库是一套面向 **OpenCode** 的多智能体（Agents）配置，可复用于日常开发与协作。配置以「虚拟团队」方式组织：一名主代理协调多个子角色，按职责分工完成任务。

## Harness Engineering 结构

为支持可持续迭代，本仓库采用「**全局单一入口**（根目录 `AGENTS.md`，OpenCode 每会话加载）+ **`docs/agents/` 结构化专题知识库**」：

> **注意**: 以下路径均相对于本全局配置目录 `~/.config/opencode/`。
> Agent 运行时 cwd 是项目目录，agent prompt 中引用这些文件需使用**绝对路径**。
> 全局配置（`~/.config/opencode/`）对 agent 只读：agent 只能读取和提出建议，实际写入由用户本人执行。

- `AGENTS.md`：OpenCode **全局 Rules**（每会话加载；含 harness 优先级、不变量、专题文档与角色索引）；**本仓库**的结构说明、变更约定与审查清单仅见 `.cursor/rules/opencode-config-repo-maintenance.mdc`（不在 `AGENTS.md` 重复）
- `agents/*.md`：各角色 OpenCode agent 提示词（frontmatter + 正文），由 `opencode.json` 的 `agent` 引用加载
- `docs/agents/harness-loop.md`：任务生命周期与门禁流转（含 RCA、Git 功能分支门禁）
- `docs/agents/branch-collaboration.md`：分支协作契约（仅 PM 决策开枝、Assignment 话术）
- `docs/agents/evaluation-harness.md`：prompt / 流程迭代评估方法
- `docs/agents/review-harness.md`：QC 三审共享基线与报告模板
- `docs/agents/routing-harness.md` + `docs/agents/routing-evals.json`：路由回归评估集
- `docs/agents/plan-convention.md`：计划目录发现、初始化、`status.json`（open residual、可选 `tech_debt_summary`）、`archived/residuals/`、`reports/<plan-id>/`、`knowledge/` 与公开文档分工
- `docs/agents/phase-gate-playbook.md`：Phase Gate 执行手册（Prepare/Execute 的最小动作与证据）
- `docs/agents/superpowers-skills.md`：Superpowers 与角色映射、与 harness 的对齐说明；未装插件时的上游安装指引
- `docs/agents/library-docs-and-hosts.md`：库文档检索单一协议（Context7 MCP / ctx7 CLI、禁止双跑）、OpenCode 与 Cursor 宿主差异、大型插件注入降噪
- `docs/agents/opencode-config-secrets.md`：`opencode.json` 密钥占位 `{env:}` / `{file:}` 说明；配合根目录 `secrets.env.example`

建议：根目录 `AGENTS.md` 已在每会话加载（含入口与索引）；需要深度细节时再读 `docs/agents/` 下专题文档。Cursor 工作区会加载 `.cursor/rules/` 下与本仓库相关的约定（见上条路径）。

本仓库根目录还有 `opencode.json`（主配置；**密钥请用环境变量**，见 `opencode-config-secrets.md`）、`secrets.env.example`、`plugins/`（可选插件，如 OpenViking）、`package.json`（`@opencode-ai/plugin` 等本地依赖，按需安装）。

### 计划管理模式（兼容无 `plans/` 项目）

当前体系支持“有 plan 目录”和“无 plan 目录”两种项目形态：

- **目录发现优先级**：`.agents/plans/` > `.plans/` > `plans/`
- **默认低侵入**：若需主动启用，优先创建 `.agents/plans/`，并配套 `reports/README.md` 与按 `plan-id` 分目录的审查留档
- **Git**：默认**跟踪** `{PLAN_DIR}` 以便 clone 后可达；仅本地私密场景再整体 ignore，且已提交文档勿引用被 ignore 的路径（与项目 `AGENTS.md` 可到达性要求对齐）
- **无 plan 目录时**：不强制创建；@project-manager 通过对话与 Completion Report 维护进度，门禁（QC/QA）照常执行

完整规则见 `docs/agents/plan-convention.md`。

## 概述

- **配置规范**：遵循 [OpenCode](https://opencode.ai) 的 `opencode.json` 结构。
- **角色提示词**：`agents/<agent-id>.md` 与 `opencode.json` 中的 `agent` 键一一对应（如 `project-manager.md`）。
- **默认主代理**：`project-manager`（项目经理），负责协调与进度管理。
- **子代理**：产品、架构、前后端开发、测试、质量、运维、市场、提示词工程等角色，按需被主代理调度。
- **计划管理**：统一遵循 `docs/agents/plan-convention.md`，支持 `{PLAN_DIR}` 动态解析，而非仅绑定 `plans/`。
- **Phase Gate 工作流**：默认采用 `specify -> clarify -> plan -> tasks -> implement`，并通过 PM 路由评估与回归场景检测“跳 gate”行为。

## 能力概览（Spec-Driven 对齐）

当前 harness engineering 已补齐以下能力：

- **Prepare 阶段门禁**：`specify -> clarify -> plan`，避免“需求未收敛即开工”。
- **Execute 阶段门禁**：`plan locked -> tasks -> implement`，避免“有 plan 无 tasks 直接开发”。
- **角色级输入契约**：
  - `@product-manager`、`@architect` 提供 Prepare/Plan 结构化产物模板；
  - `@fullstack-dev`、`@fullstack-dev-2`、`@frontend-dev` 在缺失 gate 输入时必须 `Blocked`；
  - `@qa-engineer` 在 sign-off 前强制核验 gate 完整性；
  - `@qc-specialist`、`@ops-engineer` 将 gate 合规纳入审查/发布前置检查。
- **可评估回归体系**：
  - `docs/agents/routing-evals.json` 已覆盖 `skip clarify`、`skip tasks`、`plan drift`、`hotfix post-RCA` 等场景；
  - `docs/agents/routing-harness.md` 提供 Phase Gate 评分细则与执行步骤；
  - `docs/agents/evaluation-harness.md` 提供统一 `Routing Eval Report` 输出模板。

## Agent 角色说明

| Agent ID           | 角色           | 模式     | 说明                         |
|--------------------|----------------|----------|------------------------------|
| `project-manager`  | 项目经理       | primary  | 协调团队、管理进度           |
| `product-manager`  | 产品经理       | subagent | 需求分析、产品规划、产品向文档落盘 |
| `architect`        | 技术架构师     | subagent | 架构设计、技术决策、技术向文档落盘 |
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

- **角色提示词维护**：`agents/qc-specialist.md` 为 QC 共用正文模板；`qc-specialist-2.md` / `qc-specialist-3.md` 与其保持同步，仅差异为 Reviewer 编号、`## 并行审查时本 reviewer 的侧重` 与 Completion Report 中的 **Agent** 字段。共享基线与报告模板见 `docs/agents/review-harness.md`。
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

## 快速使用示例配置

仓库已提供可直接复制的示例文件：`opencode.example.json`（来源于当前可用配置，保留 `{env:...}` 占位，便于安全注入密钥）。

在 `~/.config/opencode/` 下可直接执行：

```bash
cp opencode.example.json opencode.json
```

然后按需修改 `opencode.json`（至少确认 `provider` 下 API Key 对应的环境变量已配置）。

### Agent 配置要点

- **`default_agent`**：入口主代理 ID，此处为 `project-manager`。
- **`model` / `small_model`**（可选）：全局默认与轻量模型；也可仅在各 `agent` 上指定 `model`。
- **`plugin`**：OpenCode 插件列表；不需要 Superpowers 时可设为 `[]`。
- **`agent`**：每个键为 agent ID（通常对应 `agents/<id>.md`），值为 `description`、`mode`、`model`。
  - `mode: "primary"`：主代理，负责协调与派发任务。
  - `mode: "subagent"`：子代理，被主代理调度执行具体角色。
- **`model`**：格式为 `provider-id/model-id`，需在 `provider` 中已配置对应服务与模型。

## 配置结构简介

本仓库不再重复维护字段级说明，以避免与上游文档漂移。请直接参考 OpenCode 官方配置文档：[`https://opencode.ai/docs/config/`](https://opencode.ai/docs/config/)。

## Markdown Lint（Baseline + 渐进收敛）

本仓库已提供 `.markdownlint-cli2.jsonc` 作为当前基线，先覆盖核心维护范围：

- `README.md`
- `agents/*.md`
- `docs/agents/*.md`

执行命令：

- `npx -y markdownlint-cli2`

基线策略说明：

- 先对历史噪音较大的规则做豁免（当前：`MD041`、`MD013`、`MD060`），保证流程文档改动可持续落地；
- 后续按目录逐步收紧规则（建议先 `docs/agents/`，再 `agents/`）；
- 每次收紧前，先在变更说明中写明“本次启用的规则”和“受影响文件范围”。

## 安装到 OpenCode

将本配置安装到 OpenCode 的推荐方式如下：

仓库地址：[`https://github.com/btspoony/harness-opencode-team`](https://github.com/btspoony/harness-opencode-team)

1. 备份你现有配置（可选但推荐）：
   - `mv ~/.config/opencode ~/.config/opencode.backup.$(date +%Y%m%d-%H%M%S)`
2. 克隆仓库到默认目录：
   - `git clone https://github.com/btspoony/harness-opencode-team.git ~/.config/opencode`
3. 进入目录并安装依赖（如需本地插件）：
   - `cd ~/.config/opencode && npm install`
4. 用示例配置快速生成本地配置文件：
   - `cp opencode.example.json opencode.json`
5. 配置你的密钥（推荐环境变量，不要写死）：
   - 参考 `secrets.env.example` 创建你自己的本地密钥文件（例如 `.env.local`，并确保已加入忽略）
   - 确认 `opencode.json` 中继续使用 `{env:...}` / `{file:...}` 占位
6. 重启 OpenCode（或重载配置）使配置生效。

如果你不想覆盖现有目录，也可以只拷贝关键文件（如 `opencode.example.json`、`agents/`、`docs/agents/`）到你当前的 `~/.config/opencode/` 中再手动合并。

### 隐私与密钥安全（必读）

- 不要把真实 API Key 直接写入 `opencode.json`，始终使用 `{env:...}` 或 `{file:...}` 占位。
- 不要提交任何包含明文密钥的文件（如 `.env`、`.env.local`、私有凭据文件）。
- 分享配置时仅分享 `opencode.example.json`，不要分享你本地的 `opencode.json`（若已写入私有信息）。
- 若怀疑泄露，立即轮换对应 provider/MCP 的密钥并更新本地环境变量。

## 许可与使用

本项目采用 **MIT License**，详见根目录 `LICENSE` 文件。  
使用 OpenCode 时请遵守其官方条款及各模型/MCP 服务商的使用政策。
