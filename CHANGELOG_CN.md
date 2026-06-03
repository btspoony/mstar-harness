# 更新日志

本仓库 harness 发布面版本以 [CHANGELOG.md](CHANGELOG.md) 为准：**0.6.6**（CLI 包除外，见下表）。

| 发布面 | 位置 | 版本 |
| --- | --- | --- |
| monorepo 根 | `morning-star`（`package.json`） | **0.6.6** |
| CLI | `@mstar-harness/cli`（`packages/cli`） | **0.5.0** |
| OpenCode 插件 | `@mstar-harness/opencode`（`packages/opencode`） | **0.6.6** |
| Cursor 插件 | `.cursor-plugin/plugin.json` | **0.6.6** |
| Codex 插件 | `.codex-plugin/plugin.json` | **0.6.6** |

各包独立日志：[packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)、[packages/opencode/CHANGELOG.md](packages/opencode/CHANGELOG.md)。

## [0.6.6] - 2026-06-03

### Harness（skills / agents）

- 新增 `codex/agents/` 下的 Codex custom-agent 源文件，使可派发的 Morning Star 角色可安装到 Codex 的 `agents/*.toml` 子代理配置面；`project-manager` 仍通过 `/pm` 进入。
- 将项目 `{HARNESS_DIR}` 主推荐默认值改为 `.mstar/`，同时继续识别 `.agents/`、`.plans/`、`plans/` 等 legacy 布局。

### CLI

- Cursor 与 Codex 安装流程改为维护共享本地仓库 `~/.mstar/harness`，再创建宿主侧软链接；不再默认使用 Cursor project submodule 或 Codex URL-source marketplace 条目。
- `init` 会将 `codex/agents/*.toml` 链接到全局或项目 Codex agents 目录，`doctor` 同步校验这些链接。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.5 → 0.6.6**。
- `@mstar-harness/cli`：**0.4.0 → 0.5.0**。

## [0.6.5] - 2026-06-03

### Harness（skills / agents）

- **Durable Roadmap Gate**：强化 `mstar-harness-core`、`mstar-phase-gates`、PM 门禁、Cursor Plan 模式桥接，以及产品/架构模板；凡分批、部分交付或临时 workaround，都必须在 implement GO / Done 前写清目标状态与 roadmap。
- **编码行为**：将 `Simplicity First` 明确定义为“最小耐久切片”，不是临时补丁；暂缓项必须进入 plan/status 工件，不能只写在对话里。
- **Cursor routing-eval**：路由评估升至 v8，新增 `durable-roadmap-required-for-staged-work`，防止“先做一半，后续 plan 再说”的失败模式。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.4 → 0.6.5**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.6.4] - 2026-06-03

### Cursor Plan 模式 × Harness

- **Build resume contract**：Cursor Build 视为 plan resume，而不是 `/pm` replay。Morning Star plan 必须重新加载 harness 上下文，恢复 PM 编排，并通过 dispatch 执行实现，禁止父 Build 会话直接改产品代码。
- **Cursor routing-eval**：新增 `cursor-plan-build-resume`，防止在 SSOT plan 注册、PM Assignment 与 host Task dispatch 之前由父会话直接实现。
- **Cursor 插件 manifest**：`.cursor-plugin/plugin.json` 注册 `agents/`，与插件文档和本地校验清单对齐。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.3 → 0.6.4**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.6.3] - 2026-06-03

### Harness（skills / agents）

- **`pm`（`/pm`）**：精简入口（约 60 行），以 **`/pm`-only rules** 为 SSOT — **dispatch-first**（implement 须 Assignment + invoke，禁止父代理写产品代码、禁止以会话上下文跳过 Task）、**Autonomous Execute push** 定义为派发循环（单迭代可多 plan）、**branch truth**（禁止 plan/`status.json` 与 cwd 静默不一致）。细则指向 `mstar-dispatch-gates`、`mstar-host` 与 `project-manager` 引用。
- **`mstar-roles`（PM 壳）**：`/pm` 会话改为指向 `skills/pm` § `/pm`-only rules`，避免重复长文。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.2 → 0.6.3**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.6.2] - 2026-06-02

### Harness（skills / agents）

- **`pm`（`/pm`）**：新增 **Autonomous Execute push** — Execute 阶段启动后（`plan` 锁定、Pre-implement **GO**），按**当前迭代**连续推进全部待办（可跨**多个** `plan_id`），直至 implement → InReview → Done 收尾；不向用户追问基础性 yes/no，按 PM 推荐默认执行；流程与门禁以 **`mstar-*`** 技能为准（仅真冲突或 plan/spec 未覆盖的不可逆范围取舍时 **Blocked** / 升级用户）。
- **`mstar-roles`（PM 壳）**：补充指向 `skills/pm` § Autonomous Execute 的说明，供 `/pm` 会话对齐。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.1 → 0.6.2**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.6.1] - 2026-06-01

### Harness（skills / agents）

- **`mstar-plan-artifacts`**：新增只读 `scripts/tech-debt-rollup.sh`（jq），从 open `residual_findings` 计算 `metadata.tech_debt_summary` 并输出 PASS/DRIFT；在 `references/status-and-residuals.md`（英文）中作为 canonical 汇总路径。
- **`mstar-roles`（PM）**：当存在 **>=2 个独立** 后端/全栈任务单元时，默认在 `fullstack-dev` 与 `fullstack-dev-2` 间并行双轨或串行轮换；合并到单一 dev id 须 `single_stream_justified` 与书面 override。
- **Cursor routing-eval**：新增 `sequential-backend-batches-rotation`；收紧 `two-parallel-backend-modules` 对无 justification 单 dev 的 hard_fail。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.0 → 0.6.1**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.6.0] - 2026-05-30

### 统一宿主 skill

- **破坏性变更**：将 `mstar-host-opencode` 与 `mstar-host-cursor` 合并为 **`mstar-host`**（`skills/mstar-host/`，自动识别宿主 + `references/opencode.md`、`cursor.md`、`codex.md`、`parallel-dispatch.md`、`cursor-plan-mode-bridge.md`）。
- 新增 `references/codex.md`，覆盖 Codex 插件 skills、clarify 行为、沙箱文件/命令、工具发现，以及没有真实 multi-agent invoke 工具时的派发边界。
- 删除 `skills-cursor/` 与 `packages/opencode/skills/`；OpenCode 仅注册 `harness-skills/`；Cursor 插件仅挂载 `./skills/`。
- 同步角色/专题引用与 Plan 规则路径。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.5.1 → 0.6.0**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.5.1] - 2026-05-29

### Cursor Plan 模式 × Harness（Cursor 插件）

- **双写桥接**：CreatePlan 须同步落盘至 `{HARNESS_DIR}` / `{PLAN_DIR}` SSOT（`.agents/plans/`、`status.json`）；固定前缀 todo：`harness-init`、`spec-register`、`mirror-plan`；implement todo 完成前须 per–task-ID commit。详见 `skills-cursor/mstar-host/references/cursor-plan-mode-bridge.md`，及 `mstar-host-cursor`、`pm`、`mstar-harness-core` 更新。
- **Rules**：新增 `rules/mstar-cursor-plan-mode.mdc`（`alwaysApply`）；`.cursor-plugin/plugin.json` 注册 `"rules": ["rules/"]`，确保插件 rules（含 `mstar-entry`）可被加载。
- **维护者**：发版前自检清单迁至 `.cursor/LOCAL-VALIDATION.md`（自 `.cursor-plugin/` 移除）。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.5.0 → 0.5.1**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.5.0] - 2026-05-26

### Codex 集成

- 将已过时的仓库内 `.codex/marketplace.json` 路径替换为当前支持的个人 marketplace：`~/.agents/plugins/marketplace.json`，并使用指向本仓库的 `"source": "url"` 条目。
- `@mstar-harness/cli` 增加 Codex 支持：`init --target codex` 写入个人 marketplace 条目，`doctor --target codex` 校验该配置。
- 更新英文 / 中文安装文档，覆盖 Codex CLI 安装与手工 personal marketplace 配置。

### Harness（skills / agents）

- 修复 `/pm` skill frontmatter，使 Codex 插件可从仓库根目录通过校验。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.4.1 -> 0.5.0**。
- `@mstar-harness/cli`：**0.3.1 -> 0.4.0**。

## [0.4.1] - 2026-05-19

### Harness（skills / agents）

- **`mstar-plan-artifacts`**：将 `templates/`（`status.empty.json`、`notes.empty.json`）从 `mstar-plan-conventions` 迁入，与 `status.json` / residual SSOT 同 skill；`mstar-plan-conventions` 仍负责路径发现与初始化步骤，模板路径指向 `mstar-plan-artifacts/templates/`。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.4.0 → 0.4.1**。**`@mstar-harness/cli` 保持 0.3.1**。

## [0.4.0] - 2026-05-19

### Harness（skills / agents）

- **专题 skill 拆分**（按需加载）：新增 `mstar-phase-gates`、`mstar-dispatch-gates`、`mstar-branch-worktree`、`mstar-plan-artifacts`（含 `status.json` / residual SSOT，不再单独 `mstar-status-residuals`）；瘦身 `mstar-harness-core` 与 `mstar-plan-conventions`；`mstar-phase-gates` / `mstar-branch-worktree` 规则内联于 `SKILL.md`。
- **角色**（`mstar-roles`）：各 `references/<role>.md` 增加 **Required Skill Dependencies**；hub 矩阵在 `mstar-roles` SKILL.md；PM 子文档 severity SSOT 指向 `mstar-plan-artifacts`。
- **宿主**（`mstar-host-cursor`、`mstar-host-opencode`）：加载顺序与 QC/worktree 引用对齐专题 skill。
- **计划目录**（`mstar-plan-conventions`）：正式约定 `{ITERATION_DIR}` 与 `{KNOWLEDGE_DIR}`；`docs/` 与 harness 子树边界；`status.json` 可选 `iteration_compass` / `iteration_refs`。
- **Prepare · clarify**（主文 **`mstar-phase-gates` SKILL.md**）：`clarify` 核心纪律 — 共享理解、设计决策树逐枝、先探索、每问推荐答案、收口摘要。

### 文档

- **README.md** / **README_CN.md**：扩展核心 skill 表；说明 `.harness/` 为 gitignore 的维护工作区（spec/plan，非发布用 skill 树）。
- **AGENTS.md**：`.harness/` 维护约定；专题 skill 路由表。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.3.2 → 0.4.0**。**`@mstar-harness/cli` 保持 0.3.1**。

## [0.3.1] - 2026-05-15

### Harness（skills / agents）

- **Plan / Git 对齐**（`mstar-plan-conventions`、`mstar-harness-core`）：多 Plan 共用一条 **Spec**（`primary_spec`）时，约定 **Spec 集成分支** 与各 **Plan 实现分支**；各 Plan 完成后将变更 **merge 回 Spec 集成分支**；再合入 `main` / 默认保护分支时 **必须走 PR**（或等价受控合入；`Branch policy` 窄例外不变）。补充 `spec_integration_branch`、澄清 `merge_target`（`references/status-and-residuals.md`），在 `references/plan-files-and-reports.md` 中衔接 worktree/QC 叙述，并在 `references/branch-and-worktree.md` 增加交叉引用。

### 版本对齐

- npm workspace（`morning-star`、`@mstar-harness/cli`、`@mstar-harness/opencode`）与 Cursor / Codex 插件 manifest：**0.3.0 → 0.3.1**。

## [0.3.0] - 2026-05-14

### Harness（skills / agents）

- **PM 角色**：将 `project-manager` 细则拆到 `skills/mstar-roles/references/project-manager/*.md`，壳文件保持精简编排入口。
- **角色正文**：`mstar-roles` 角色 reference 与总线英文化；宿主适配器用技能名（`mstar-host-opencode`、`mstar-host-cursor`）引用，避免在角色文中写包内路径。
- **AGENTS.md**：宿主适配器说明改为技能名 + 仓库内源路径（Cursor：`skills-cursor/mstar-host`）。
- **PM 路由**：阶段切换前短 pre-flight；OpenCode 上 **前提回合 vs 派发回合** 与防「只粘贴 Assignment、无 invoke」说明写入 `mstar-harness-opencode`。
- **OpenViking（可选）**：新增 `mstar-harness-core/references/openviking-memory-plugin.md`，仅在存在 **`memsearch`** 工具时适用；在 `mstar-harness-core` SKILL 中设入口。
- **加载契约**：明确 `mstar-coding-behavior` 面向实现/审查/QA/运维等承接方，**不要求**纯编排的 `project-manager` 必读。

### 文档

- 从 `README.md` / `README_CN.md` 中删减已被当前流程替代的 plan 引导模板段落。

### 版本对齐

- npm workspace（`morning-star`、`@mstar-harness/cli`、`@mstar-harness/opencode`）**0.2.0 → 0.3.0**。
- Cursor / Codex 插件 manifest **0.1.0 → 0.3.0**，与 monorepo 发布线一致。

## [0.2.0] - 此前

`@mstar-harness/cli` 的 0.2.0 说明见 [packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)。OpenCode 打包、`skills/` + `agents/` 随 postinstall 同步等与 0.2.0 同期变更见根目录英文 CHANGELOG 中 0.2.0 一节。
