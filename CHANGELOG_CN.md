# 更新日志

本仓库 harness 发布面版本以 [CHANGELOG.md](CHANGELOG.md) 为准：**2.0.1**。

| 发布面 | 位置 | 版本 |
| --- | --- | --- |
| monorepo 根 | `morning-star`（`package.json`） | **2.0.1** |
| CLI | `@mstar-harness/cli`（`packages/cli`） | **2.0.1** |
| Engine | `@mstar-harness/engine`（`packages/engine`） | **2.0.1** |
| OpenCode 插件 | `@mstar-harness/opencode`（`packages/opencode`） | **2.0.1** |
| Cursor 插件 | `.cursor-plugin/plugin.json` | **2.0.1** |
| Codex 插件 | `.codex-plugin/plugin.json` | **2.0.1** |
| Kimi 插件 | `.kimi-plugin/plugin.json` | **2.0.1** |
| ZCode 插件 | `.zcode-plugin/plugin.json` | **2.0.1** |
| omp 插件 | `.omp-plugin/plugin.json` / `.claude-plugin/plugin.json` | **2.0.1** |
| Agent Plugins 清单 | `plugin.json` | **2.0.1** |

各包独立日志：[packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)、[packages/opencode/CHANGELOG.md](packages/opencode/CHANGELOG.md)、[packages/engine/CHANGELOG.md](packages/engine/CHANGELOG.md)。

## [Unreleased]

## [2.0.1] - 2026-08-08

### Fixed

- OpenCode 插件钩子不再因非 string 的 `task`/`write` 参数刷 abort 日志：Assignment 与 `status.json` 校验在 `.match` / `path.resolve` 前拒绝非 string 输入，且 `tool.execute.before` 对 `prompt`/`filePath` 只读取一次（避免 getter/Proxy 类型翻转）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.0.1**。

## [2.0.0] - 2026-08-08

### Harness

- **移除 Bash SDD/rollup 脚本（引擎 CLI 成为文档化路径）**：删除 `skills/mstar-sdd/scripts/{sdd-workspace,task-brief,review-package}` 与 `skills/mstar-plan-artifacts/scripts/tech-debt-rollup.sh`。技能正文改为文档化 `mstar sdd workspace|task-brief|review-package` 与引擎 `techDebtRollup` import（schema 门禁仍为 `mstar status validate`）；奇偶校验测试改为对照由已证明 byte-parity 的移植产物（slice 2）捕获的 golden fixtures。
- 新增 **`@mstar-harness/engine`** 包脚手架：版本对齐的工作区库（仅 `zod` + `ajv` + `node:*`，无 `bin`），提供类型化 `ValidationResult` 与 `readHarnessVersion()` 占位 core，并纳入发布面清单（10 → 11）、changelog 组装与根 workspaces。
- **Engine 加固（slice 1 QC 修复波）**：lease 位置/孤儿/双写校验（`lease.verify.*`）移入 `@mstar-harness/engine`（CLI `mstar lease verify` 改为薄包装）；`archiveResiduals` 增加 plan-id 路径穿越防护、状态写锁与追加去重；`withStatusWriteLock` 增加所有权防护（绝不删除其他 writer 的 lockdir）、`holder.pid` 崩溃诊断文件与快速失败的重入检测；`readHarnessVersion` 优先读取模块自身 manifest（发布安装不再回退为 `0.0.0`）；`tech-debt-rollup` 奇偶校验精确镜像 jq `//`（`false`/`0` 边界用例对照 bash oracle）；新增残项关闭完整性（`closed_at` + `closure_note`）与 plan 行 `Done` ⇒ 无 lease 不变量。发布脚本在根 changelog 头部确保 `@mstar-harness/engine` 注册表行与包历史链接。
- **Harness Workflow Engine 定位（iteration v2.0.0）**：统一 7 个插件 manifest 与 4 个包 manifest 的引擎优先描述；根 plugin.json 新增 `workflow-engine` / `workflow-enforcement` / `deterministic-workflow` / `harness-workflow` 关键词；README.md / README_CN.md 围绕「确定性工作流门禁由 TS 引擎强制执行（而非仅靠 prompt）、判断留在 `mstar-*` skills」重新表述，并新增交付内容表（Harness Workflow Engine / mstar CLI / `mstar-*` skills / 宿主适配）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.0.0**。

## [1.8.9] - 2026-08-07

### Harness

- 在仓库根新增便携式 **Agent Plugins v1.0.0** manifest（`plugin.json`），与 CLI 发布面保持一致（`skills/` 为 Agent Skills 组件），并新增 `mstar-harness plugin validate` 按 Agent Plugins v1.0.0 规范校验插件包（含 `mcp.json` / `skills/`）。
- **Phase 5 checkout**：merge-ready 产品修复直接在 control / `spec_integration_branch` checkout 上改；**禁止**另开 Phase 5 feature/fix worktree，也**禁止**套用 Phase 2「control 禁止产品编辑」。SSOT 在 `mstar-iteration`（`phase-4-5-pr-delivery` §5.0）；**不**写入通用 `mstar-branch-worktree` skill。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 1.8.9**。

## [1.8.8] - 2026-08-06

### Harness

- **`mstar-skill-authoring`**：将 skill-writer 六原则并入运行时撰写技能——专家流程优先、紧凑 5 问 body、1–3 skill 路由、按 model+harness 实测、只补模型缺口、每次改动做 paired 实验。Body 保留可执行门控；完整 writer 流程 / 输出模板 / 反模式 → `references/skillsbench-authoring.md`（渐进披露）。
- 收紧 `description` 触发契约（含排除条件）；保留 purpose test / frontmatter / 渐进披露 / review 模板作为可复用 SSOT。
- 重写为**通用** skill 撰写规范（任意领域/仓库）：去掉 body 中 Morning Star / 仅 `mstar-*` 品牌化表述；本仓工作仅保留最短 harness 挂钩（Load Order + `mstar-host` 路径解析）。
- 恢复 `## Skill-relative script and asset paths` 小节标题，使 `mstar-host` 的 § 交叉引用继续有效（Post-Skill-Change stale-ref 清单）。
- 收敛 `AGENTS.md` changelog 规则：§1 为唯一权威（含开发期禁止手改 assembled `CHANGELOG*`）；Quality Gate #6 保留为可执行检查；删除其余 copy-paste 重复。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单：**→ 1.8.8**。

## [1.8.7] - 2026-08-06

### Harness

- 将 SDD 派发模板改为**宿主中立**，不再固定引发单一宿主工具 schema：`implementer-prompt.md`、`task-reviewer-prompt.md`、`implementer-continuation-prompt.md` 改用 `Dispatch:` / `Role:` / `Name:` / `Prompt body:` 标签 + 内联宿主字段映射（`omp agent / Cursor subagent_type / OpenCode subagent → mstar-host C5`），替代 Cursor 专有字段（`subagent_type`、`description`、`prompt`）。L2 任务 reviewer 模板现直接给出 omp `agent` 取值（`reviewer` 或 `task` + C5b），消除 SDD 下导致 generic worker 回退的映射困惑。
- 精简 `mstar-host/references/omp.md` 与 `parallel-dispatch.md` 中**envelope-first** 的重复论述为单行机械规则 + SSOT 指针（长段散文本身会加剧注意力挤占），并在 omp SDD 段补充 L2 reviewer `agent` 映射。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单：**→ 1.8.7**。

## [1.8.6] - 2026-08-06

### Harness（派发保真 — invoke 字段完整性门禁）

- 在派发自检处新增**逐项字段完整性门禁**：每条 Task/subagent invoke 必须携带与 `Execute as` 匹配的角色绑定字段（omp `agent` / Cursor `subagent_type` / OpenCode `subagent` / Kimi·ZCode `subagent_type`）。漏写字段（如 omp 漏 `agent` ⇒ 静默回退 generic `task`）现为**派发未完成**——与 paste-only（零 invoke）同级——避免裸 `tasks:[{task:"…"}]` 仅因 invoke 计数 = N 而蒙混过关。N=1 顺序 Review-&-Edit 链显式覆盖（count 门在该处恒过）。
- `mstar-dispatch-gates`：发送前自检 + 反模式条目；`mstar-host/references/parallel-dispatch.md`：硬规则 + 自检步骤；`mstar-host/references/omp.md`：Review-&-Edit 示例为每轮（architect / writing-specialist）展示完整 `task(...)` 块并显式 `agent`，并加 N=1 gotcha。
- `.cursor/skills/mstar-routing-eval`：新增回归信号「invoke 角色字段缺失 ⇒ 静默 generic 回退」。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.6**。

## [1.8.5] - 2026-08-06

### Harness（技能路径发现 — 运行时表面）

- 关闭仍留在**已发布运行时表面**上的 cwd 型 `skills/mstar-*` 陷阱：Cursor `rules/mstar-entry.mdc`、`rules/mstar-cursor-plan-mode.mdc`，以及 omp CLI 安装后提示 `packages/cli/src/adapters/omp.ts`（改为 `mstar-host → references/omp.md` / `skill://…`）。
- **`mstar-host`**：新增 § Resolve loaded skill root（按宿主 prefer + 文件系统回退：omp `skill://`、Cursor 插件 checkout、OpenCode `harness-skills/`、Codex/Kimi/ZCode 插件挂载）。各宿主 reference 指向该表；`mstar-skill-authoring` 同步 rules/CLI note 反模式。
- INSTALL / `docs/cli.md` 的 Host adapter 条目改为同一套技能相对写法（不再用 consumer cwd 的 `skills/mstar-host/references/…`）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.5**。

## [1.8.4] - 2026-08-06

### Harness（技能脚本路径发现）

- **技能相对脚本命名**：运行时文档改为 skill **`mstar-sdd`** → `scripts/<name>`（或 `<mstar-sdd>/scripts/…`），不再写成 consumer cwd 路径 `skills/mstar-sdd/scripts/…`。Agent 会按字面路径在应用仓库下搜索，从而找不到已加载 skill / 插件安装位置。
- 更新 `mstar-sdd`（SKILL + `file-handoffs`）、`mstar-plan-artifacts`（`tech-debt-rollup`）、`mstar-plan-conventions`、`mstar-iteration`、PM Assignment `SDD dir` cue，以及 `mstar-skill-authoring`（新增「Skill-relative script and asset paths」约定）。
- 维护者 `.cursor/LOCAL-VALIDATION.md` 仅在本 harness 仓根保留 `skills/…` smoke 命令，并加明确说明。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.4**。

## [1.8.3] - 2026-08-05

### Harness（omp 角色 agent 派发）

- **修正 omp C5**：插件 install/link 后，由 `agents/*.md` 发现的角色 id（`product-manager`、`architect`、`fullstack-dev`、`qc-specialist*` 等）是合法的 live `task.agent`。优先 **`agent: "<Execute as role-id>"`**；仅当 live schema 未列出该角色时才回退 `task` / `scout` / …。schema 已有对应角色却仍写 `agent: "task"` 为反模式。
- **保留 C5b**：即使 `agent` 已等于角色 id，Assignment 仍需 **Act as + skill load**（agent shell ≠ 完整 Morning Star 角色提示）。
- 更新 `skills/mstar-host/references/omp.md`（C5 + C5b 自包含）；`_shared/host-role-binding-core.md` 为 **仅 Kimi/ZCode**（文件内不再出现 omp 行/说明——其他宿主走各自 references）；并更新 `parallel-dispatch.md`、`mstar-host` skill description；同步 INSTALL / `docs/cli.md`。删除 README「宿主说明 / Host notes」旁注，Use 区只保留入口。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.3**。

## [1.8.2] - 2026-08-05

### 文档（README + 宿主识别）

- **README**（`README.md` + `README_CN.md`）：所有宿主表格按推荐宿主顺序重排（`omp > OpenCode > Cursor > Kimi = ZCode > Codex`）；**使用**一节重组为 通用（不跑迭代） → 迭代 → 代码库审计。
- **`mstar-host`**：重写宿主识别表，**仅用会话工具形态 / 可见命令**——`*-plugin/plugin.json` 文件无法识别宿主（在本源仓与任何多宿主安装里它们都同时存在）。合并重复的 Cursor 两行为一行，以 `subagent_type` 为关键信号。
- **宿主参考**：移除 `codex.md` / `kimi.md` / `zcode.md` / `omp.md` 各自 `Load when` 触发行里的插件标记子句，只保留工具形态 / 可见命令信号。路径参考上下文行与 plan-mode bridge 的 `plugin is installed` 前提留作文档（非识别触发）。
- **omp**：在 `references/omp.md` 记录原生 internal URL 方案（`skill://`、`local://`、`agent://`、`artifact://`、`history://`）。

### CLI

- `zcode` adapter 不再硬编码 `PLUGIN_VERSION` 常量（此前已漂移到 `1.6.0`）。marketplace 条目生成与 `doctor` 的 ZCode 版本校验改为通过 `utils.ts` 新增的共享 `readHarnessVersion()` 从 `packages/cli/package.json` 派生（`index.ts` 的 `--version` 也改用同一 helper）。修正 `INSTALL.md` 与 ZCode adapter 中陈旧的 `1.5.6` / `1.6.0` 版本字符串。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.2**。

## [1.8.1] - 2026-08-05

### Harness（skills + commands 优化）

- **无损优化** `skills/` 与 `commands/`，按 SkillsBench 原则（紧凑 body、progressive disclosure、dedup 到 SSOT）。无任何规则、门禁、字段名或 NEVER 条目被改动或删除——规则只移动或压缩，绝不消失。
- **提取到 `references/`**：`mstar-iteration` Phase 3 → `phase-3-iteration-close.md`、Phase 4/5 → `phase-4-5-pr-delivery.md`（body 574 → 384 行）；`mstar-compound` Q1–Q8 + Phase 1–7 → `compound-workflow.md`（275 → 103）。
- **压缩**：`mstar-coding-behavior` 216 → 142（保留 The Ladder、`simplify:` 标记、minimal-check）；`qc-specialist/deep-review-lenses.md` 11 个透镜清单 → 每透镜一行（155 → 94）。
- **去重**：反模式清单 → `mstar-harness-core` 索引；新增 `_shared/leaf-executor-core.md`（9 个 leaf 角色的 Completion Report + Git NEVER 去重）；新增 `_shared/host-role-binding-core.md` + `_shared/plan-mode-bridge-core.md`（kimi/zcode/omp 宿主文件 + 5 个 plan-mode bridge 去重）。
- **命令 → 薄编排器**：4 个命令 943 → 388 行（−59%）；新增 `mstar-iteration/references/phase5-helper-discovery.md`。
- **描述**：收紧 `coding-behavior`、`branch-worktree`、`phase-gates` 的 frontmatter 为触发契约。
- **文档**：`README.md` + `README_CN.md` 增加推荐宿主顺序（`omp ≥ OpenCode ≥ Cursor > Kimi = ZCode > Codex`）。
- **命名**：`Completion Report v2` → `Completion Report`（模板已统一，去掉版本后缀）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.1**。
## [1.8.0] - 2026-08-05

### Harness（代码库审计 skill）

- **新增 `mstar-audit` skill**：只读顾问式工作流，改编自 [improve](https://github.com/shadcn/improve) skill（MIT，© shadcn）。跨 9 个类别审查代码库（正确性/安全/性能/测试/技术债/依赖/DX/文档/方向），vet findings，按 leverage 排序，向 `{PLAN_DIR}/audit-<date>/` 写入自包含的改进计划。**不**引入 improve 的 `execute`/`reconcile`/`--issues` 变体——mstar 的 SDD、`status.json` 与 residual 追踪已替代它们。
- **新增 `plan-quality-bar` 参考**（`mstar-plan-artifacts/references/plan-quality-bar.md`）：计划自包含标准——验证门、STOP 条件、drift check、机器可检查的 done criteria。适用于 SDD task-brief、Prepare plan 与 audit plan。
- **新增 `/codebase-audit` 命令**（`commands/codebase-audit.md`）：独立入口。以 `codebase-` 前缀命名避免宿主命令冲突（沿用 `iteration-*` 约定）。接线：`mstar-harness-core` Task category `audit` + skill 索引；`mstar-phase-gates` Plan 质量门；`mstar-sdd` 引用；`mstar-roles` architect 加载项；`pm` skill 入口；`iteration-start` §1 Research 可选来源。
- **致谢**：improve（MIT，© shadcn），在 `mstar-audit/SKILL.md` 与 `plan-quality-bar.md` 中标注。

### CLI（`@mstar-harness/cli`）

- **Codex adapter**：`CODEX_PROJECT_COMMAND_NAMES`（从 `CODEX_ITERATION_SKILL_NAMES` 重命名）现包含 `codebase-audit`；project-scoped 安装将其物化为 `.agents/skills/codebase-audit/SKILL.md`。
- **omp adapter**：smoke 测试与安装说明包含 `codebase-audit`。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.0**。

## [1.7.1] - 2026-08-05

### CLI（`@mstar-harness/cli`）

- **omp doctor**：解析 omp 17.x 的 `omp plugin list --json` 形状 `{ npm, marketplace }`（不再只认数组/`plugins`），并匹配 `manifest.name`。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.7.1**。

## [1.7.0] - 2026-08-05

### Harness（omp 宿主面）

- **omp 作为第六宿主面**：标记 `.omp-plugin/plugin.json` + `.claude-plugin/plugin.json`（插件根 = 仓库根；挂载 `./skills/`、`./commands/`、`./agents/`）。新增 `skills/mstar-host/references/omp.md`，覆盖 `task`/`ask`/`hub`、文件名 slash 命令（`/iteration-*`）、以及 C5/C5b 内置 `task.agent` + prompt 角色绑定。`omp-plan-mode-bridge.md` 用于 `/plan` 双写。`mstar-host` detect 表、`pm` 入口、`parallel-dispatch` 已同步。
- 安装：`omp plugin install github:btspoony/mstar-harness` 或对本地 harness checkout 执行 `omp plugin link`；`omp plugin list` 中的包名为根 `morning-star`。

### CLI（`@mstar-harness/cli`）

- **`omp` 安装目标**：`npx @mstar-harness/cli init --target omp` 确保 `~/.mstar/harness` 并执行 `omp plugin link`（失败则回退 `omp plugin install github:btspoony/mstar-harness`）。`doctor --target omp` 校验标记、skills/commands 冒烟与 `omp plugin list`。`shared-install` 的 `HARNESS_MARKERS` 接受 `.omp-plugin/plugin.json`。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.7.0**。

## [1.6.1] - 2026-08-04

### Harness（QC = 代码审查席，非测试执行席）

- **L3 Plan QC 明确为 diff/逻辑审查**：`mstar-review-qc` 边界 + `qc-specialist*` workflow/shared NEVER——共享 `Review cwd` 上的并行三审 **不得**跑 test/build/install/lint/typecheck（工具链争用导致 peer QC `Blocked`）。覆盖率从 **diff** 判断，不靠重跑 suite。
- **运行时证据归 L1 / L4**：QA `acceptance-only` 复用 implementer/CI/既有 QA 日志；QC 报告是 findings，不是测试日志。PM Assignment 反模式与 `qa-trigger-matrix` 同步。
- **OpenCode `qc-specialist*` agents**：bash 白名单收束为 git + 轻量只读分析（移除 eslint/tsc/ruff/clippy 等）。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi/ZCode 插件：**→ 1.6.1**。

## [1.6.0] - 2026-08-03

### Harness（ZCode 宿主面）

- **ZCode 作为第五宿主面**：插件根 = 仓库根，经 `.zcode-plugin/plugin.json` 挂载（`./skills/`、`./commands/`、`./agents/`）；无 `sessionStart`（ZCode 不支持——PM 入口手动 `/morning-star-harness:pm`）。新增 `skills/mstar-host/references/zcode.md`，tool map 按真实 ZCode 会话工具编写（`Agent` / `AskUserQuestion` / `EnterPlanMode`·`ExitPlanMode` / `TodoWrite` / `Bash` / `Read` / `Edit` / `Write` / `WebSearch` / `WebFetch` / `TaskOutput`·`TaskStop`），复用 Kimi **C5b role-in-prompt binding**（ZCode 仅内置 `subagent_type` profile）。`zcode-plan-mode-bridge.md` 处理 Enter/Exit 双写。
- **`mstar-host` SKILL.md**：description、detect-host 表、兜底行加入 ZCode。

### CLI（`@mstar-harness/cli`）

- **`zcode` 安装 target**：`npx @mstar-harness/cli init --target zcode` 注册 `mstar-local` marketplace 到 `~/.zcode/cli/plugins/known_marketplaces.json` + `marketplaces/mstar-local/marketplace.json`，两者均指向 **`github:btspoony/mstar-harness`** 仓库 source（与 ZCode 内建 marketplace source 形状一致）。Project scope 另在 `.zcode/plugin-checkout` 保留本地 checkout 做 agent 文件 smoke 校验。`doctor --target zcode` 校验两个 JSON + checkout + gitignore。`shared-install` 的 `HARNESS_MARKERS` 新增接受 `.zcode-plugin/plugin.json`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi/ZCode 插件：**→ 1.6.0**。

## [1.5.6] - 2026-07-28

### Harness（residuals）

- **`Findings cleanup: zero-residual | allow-residual`**：计划级「不残留」模式——可修 findings 尽量在当轮 fix→re-review 清干净。正式 **iteration Phase 2** 默认 **`zero-residual`**（仅真 blocker-defer + Durable Roadmap 可留 open R#）。独立 `/pm`、hotfix、`inline` 仍默认 **`allow-residual`**。
- Assignment 字段 + 可选 `plans[].metadata.findings_cleanup`；SSOT 在 `mstar-plan-artifacts`；贯通 `mstar-review-qc`、PM NEVER / Assignment、iteration close、QA 矩阵说明与 routing-eval。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.6**。

## [1.5.5] - 2026-07-27

### Harness（worktree / L1）

- **默认 gitignore 下的 control-path harness**：进程产物（`plans/`、`iterations/`、`status.json`、`sdd/` 等）仍本地；经 **control worktree** 绝对路径读写。Feature worktree 只改产品代码——**禁止**因 feature 缺 plans 而 waive worktree；**禁止**把「无 flock」当成 worktree 豁免（仅 `Plan parallelism: serial`）。
- Assignment：绝对 **`Control harness root`**、control 系 **`Plan Path`** / **`SDD dir`**、feature **`Worktree path`**。
- **`sdd-workspace`**：支持 `MSTAR_CONTROL_ROOT` / control-root 参数；linked worktree 无 `status.json` 时 fail closed。
- routing-eval：无 flock 串行保留 worktree、gitignore control-path 场景。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.5**。

## [1.5.4] - 2026-07-27

### Harness（Cursor 宿主）

- **`mstar-host` Cursor Task invoke schema**：文档化扁平并列字段（`prompt` + `subagent_type` + `description`）、范例、反模式（嵌套/字符串化 JSON、OpenCode `subagent`、MCP 包装、漏传 `subagent_type`）与发送前自检，降低 Task 首次参数格式失败。`parallel-dispatch.md` 增加指针。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.4**。

## [1.5.3] - 2026-07-25

### Harness（commands / frontmatter）

- **Frontmatter YAML**：对含 `: ` 的 `description` 加引号，避免 Cursor/插件发现不到 command/skill（`iteration-loop`、`mstar-branch-worktree`、`mstar-phase-gates`、`mstar-plan-artifacts`、`mstar-review-qc`、`mstar-sdd`）。
- **`/iteration-loop` scale**：新增 **`XL`** = **>4** 个业务 plan（`S`/`M`/`L`/`XL`；默认仍为 `M`）。SSOT：`mstar-iteration` §1.2 + `references/autonomous-direction-lock.md`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.3**。

## [1.5.2] - 2026-07-23

### Harness（git 策略 + SPECS_DIR）

- **进程 vs 结果 Git 策略**：`{HARNESS_DIR}` 下默认 tracked — `AGENTS.md`、`knowledge/`、`specs/`；默认 gitignored — `plans/`、`iterations/`、`status.json`、`sdd/`、`archived/`、`notes.json`。跨 clone handoff = tracked 结果 + 根目录 `CONCEPTS.md` / `STRATEGY.md`；residual 经 compound 提升，**勿**默认 `git add` `status.json` / `plans/`。
- **`{SPECS_DIR}` 解析顺序**：`{HARNESS_DIR}/specs/` → `docs/specs/` → 仓库根 `specs/`（空目录跳过；greenfield 创建 `{HARNESS_DIR}/specs/`）。Legacy 只读：非空 `designs/` 路径。
- 已对齐：`mstar-plan-conventions`、`mstar-plan-artifacts`、`mstar-sdd` file-handoffs、宿主 Plan 模式桥接、双语 README、`.cursor/LOCAL-VALIDATION.md`。
- **CLI**：`init`/`doctor` 追加/检查完整 process gitignore 集（见 `packages/cli/CHANGELOG.md`）。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.2**。

## [1.5.1] - 2026-07-22

### Harness（Phase 5 push cadence）

- **Phase 5 push cadence（HARD）**：发现 CI/review 问题可**本地提前修**，但 **`git push` 必须等**当前 head 上一波 CI **与** review 全部跑完。CI 结束后若出现新 reviews，可继续本地修；**禁止在 CI 仍在跑时 push**（会打断 AI reviews，浪费 token 且无完整结果）。SSOT：`mstar-iteration` §5.1a；已对齐 `iteration-drive` / `iteration-loop` 与 core 反模式。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.1**。

## [1.5.0] - 2026-07-22

### Harness（迭代 Phase 2 worktree + lease）

- **Phase 2 control worktree**（`spec_integration_branch`）+ 每 plan **feature worktree**，配合 `execution_lease` / `integration_merge_lease`（同机独占写锁；合入 integration 串行；`Done` 仅在 merge 成功后）。
- 多会话跨 plan 并行 implement（lease 门控）；`Worktree mode: waived` **不**豁免跨 plan 并行安全闸；`Plan parallelism: serial` 仅调度串行。
- routing-eval 与双语 README Phase 2 默认说明已更新。

### Harness（Phase 5 helpers）

- **Phase 5 merge-ready helpers**：优先 `babysit` 或任意 `*-babysit`；`greploop` **仅当**仓库具备 Greptile/`greploop` 时可选。两者都适用时先 babysit/`*-babysit`，再可选 greploop。已更新 `mstar-iteration` §5 指针与 `commands/iteration-drive` / `iteration-loop`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.0**。

## [1.4.0] - 2026-07-17

### Harness（Kimi Code 宿主）

- **Kimi 宿主支持**：`.kimi-plugin/plugin.json`（与 Cursor/Codex 同构的 host 目录布局；`sessionStart.skill: pm`）；`mstar-host` Kimi 参考 / Plan 模式桥；角色绑定写在 Agent prompt（内置子 agent 仅 `coder` / `explore` / `plan`）。
- **安装**：主路径为 Kimi TUI `/plugins install https://github.com/btspoony/mstar-harness` 后 `/plugins reload`（无 CLI `--target kimi`）。
- 插件命令：`/morning-star-harness:iteration-start` · `iteration-drive` · `iteration-loop`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.4.0**。

## [1.3.2] - 2026-07-15

### Harness（Cursor Plan Phase 1 反馈驱动）

- **`/iteration-start` Cursor Plan 路径**：feedback-driven — 用户只提方向/意见；Agent 探索、推荐并改 plan。`grill-me` 仅在反馈结束后、仍有阻塞缺口时发起。
- **Single CreatePlan URI（HARD）**：Phase 1 Plan 会话只 CreatePlan 一次；后续原地改同一文件；误开第二份则合并并删除。
- **`mstar-host` / rule / `mstar-iteration` §1.2**：Phase 1 Plan UX 写明反馈驱动与推荐 branch policy（禁止静默 `main`/`master`）。
- **Routing eval v20**：`iteration-phase1-cursor-plan-feedback-driven`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.3.2**。

## [1.3.1] - 2026-07-13

### Harness（迭代 package 目录化）

- **`iterations/<id>/` 目录优先**：compass 迁至 `{ITERATION_DIR}/<iteration-id>/delivery-compass.md`，同目录含 `guides/`、`specs/`、可选 package `README.md`。根 `{ITERATION_DIR}/README.md` **一行 = 一次迭代**（不再 compass + workspace 双行）。
- **Legacy 只读兼容**：根目录 flat `{ITERATION_DIR}/<id>-delivery-compass.md` 仍可读；新写必须走 package 路径。
- 涉及：`mstar-iteration`（及 references）、`mstar-compound` package 提升、`mstar-plan-conventions` / `mstar-plan-artifacts` 路径文档、角色壳、`/iteration-start` · `/iteration-drive` · `/iteration-loop`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.3.1**。

## [1.3.0] - 2026-07-11

### Harness（bootstrap 吸收）

- **退役 `/mstar-bootstrap` 命令**：7 阶段项目知识 bootstrap 流程迁入 `mstar-compound-refresh/references/project-knowledge-bootstrap.md`；`mstar-compound-refresh` 与 `mstar-harness-core` 保留简短指针。

### CLI（Codex iteration skills）

- **项目级 Codex 安装**：将 `iteration-start`、`iteration-drive`、`iteration-loop` 物化为 `.agents/skills/*/SKILL.md` 符号链接（源自 harness commands）；`doctor` 校验链接；全局安装跳过并给出明确警告。

### 文档

- **根目录 `INSTALL.md`**：从 README 抽离的可机读安装步骤。
- **精简双语 README**：CLI 优先 Quick Start；厘清 `/iteration-start` → `/iteration-drive` 与 `/iteration-loop` 使用路径。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.3.0**。

## [1.2.1] - 2026-07-10

### Harness（Cursor Plan 模式 × Phase 1 分阶段方向锁）

- **`/iteration-start` Cursor Plan 路径**：Boot 后先 CreatePlan 空白 Phase 1 脚手架，再动态分阶段 `grill-me` 并每段更新 plan；Review & Edit / lock / integration 分支仅在 **Build** 后执行。Agent / OpenCode 仍为 Research → Explore → grill-me → Write → Review。
- **`mstar-host` Cursor bridge / rule**：补充 `mstar-iteration` Phase 1 in Plan mode（skills 不反向引用 command 名）。
- **`mstar-iteration` §1.2**：宿主 Plan UX 可先 scaffold 再分阶段收敛；非 Plan 宿主不变。
- **Routing eval v19**：`iteration-phase1-cursor-plan-staged-grill`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.2.1**。

## [1.2.0] - 2026-07-10

### Harness（`/iteration-loop` + autonomous direction lock）

- **`/iteration-loop`**：新 PM 命令，自动化完整 Phase 1→5（适合 cloud agent）。可选参数 `direction` + `scale`（`S`\|`M`\|`L`，默认 `M`）；代码优先自动锁方向（不跑 grill-me）；保留顺序 Review & Edit 链；Continuous execution 直至 Phase 5 merge-ready。与 `/iteration-start`（仅 Phase 1 + grill-me）、`/iteration-drive`（仅 Phase 2→5）区分。
- **`mstar-iteration` §1.2**：direction lock 模式 `interactive` | `autonomous`；scale budget **只计业务 plan**（不计 harness 流程）；autonomous branch resolve。细则 → `references/autonomous-direction-lock.md`（skill 为能力提供者，不反向引用 command 名）。
- **文档**：README / README_CN / OpenCode 包 README 命令表区分 start / drive / loop。
- **Routing eval v18**：`iteration-loop-autonomous-direction-lock` — 禁止例行方向确认、禁止 grill-me、禁止静默默认 `main`、禁止把流程 plan 计入 scale。

### CLI / CI / 发布

- **OpenCode `init` 快路径**：不再交互选模型，也不再调用 `opencode models`（该命令可能无输出卡住）。默认只写 `$schema` + `@mstar-harness/opencode@latest`，角色模型用 OpenCode 默认；可选 `--*-model` 仍作高级覆盖。
- **CI**：对 `packages/cli`、`packages/opencode` 及 bundled `skills`/`agents`/`commands` 做 path 过滤构建；含 CLI smoke + pack。
- **Release**：改用 Node 24 自带 npm 做 Trusted Publishing；去掉 Node 22 上损坏的 `npm install -g npm@latest`（修复 `MODULE_NOT_FOUND: sigstore`）；发布前先 build。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.2.0**。

## [1.1.0] - 2026-07-08

### Harness（临时 review bundle）

- **Review bundle 默认策略**：QC/QA 原始过程报告现在进入 `{SDD_DIR}/review/`（gitignored）；进入 git 的 handoff 产物是主 plan gate summary 与 `{HARNESS_DIR}/status.json` residual findings。
- **Legacy tracked reports**：`{PLAN_DIR}/reports/` 仅作为 legacy / 显式 audit mode，不再是默认 QC/QA 报告目标。
- **Iteration compass**：新增 `Quality Gate Summary` 区块，用于迭代级 QC/QA verdict 与 residual 汇总，不替代 per-plan summary 或 `status.json`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.1.0**。

## [1.0.6] - 2026-07-08

### Harness（SDD per-task reviewer 派发）

- **`mstar-sdd`**：L2 per-task reviewer 固定为 **`subagent_type: generalPurpose`**；task 级禁止 `qc-specialist*`（全部 task 完成后的 plan QC tri 仍为 L3）。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.6**。

## [1.0.5] - 2026-07-07

### Harness（分层 QA gate + 角色域 QC/QA 引用）

- **分层 QA gate**（`mandatory` | `pm-acceptance` | `report-only`）与 PM 派发矩阵（`qa-trigger-matrix.md`）；hotfix/小型干净后端默认 `pm-acceptance`；中型+、UI、residual 仍须 mandatory QA。
- **L4 验收收窄**（`qa-engineer/acceptance-gate.md`）：复用 QC consolidated 证据；`QA mode: acceptance-only` 时默认不全量重跑测试。
- **角色域执行引用**：leaf QC → `mstar-roles/references/qc-specialist/`；L4 QA → `qa-engineer/`；**`mstar-review-qc`** 收窄为 PM 编排层。
- **正面加载列表**：各角色只写「该读什么」，避免 leaf agent 被反向引导去读 `mstar-review-qc`。
- **Routing eval v17**：hotfix/small-backend → `pm-acceptance`；UI 仍 `mandatory`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.5**。

## [1.0.4] - 2026-07-07

### Harness（并行 implement worktree 门禁）

- **新增 `mstar-branch-worktree/references/parallel-writable-pre-dispatch.md`**：同仓 **≥2 可写 implement 并发** 的派发前 SSOT 清单 — `git worktree add`、绝对路径 **`Worktree path`**、PM 留在集成分支、未就绪则 emit-zero。
- **`mstar-dispatch-gates`**：**双门禁表** — 工具并发（同条消息 N 次 invoke）与同仓写隔离；明确 **N invoke ≠ worktree 合规**。
- **`mstar-branch-worktree`**、`mstar-iteration`、`mstar-phase-gates`、`project-manager`、`dispatch-and-assignment`、`fullstack-dev-shared`：瘦身为指向 reference 的短链；去除重复清单正文。
- **`mstar-harness-core`**：反模式索引新增「并行 implement 无 worktree」。
- **Routing eval v16**：并行 implement 缺 per-track **`Worktree path`** 硬失败；强化并行开发场景的 worktree 断言。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.4**。

## [1.0.3] - 2026-07-07

### Harness（iteration 连续推进）

- **`iteration-drive`**：新增 Phase 2–5 **Continuous execution（HARD）** — 进度汇报后禁止例行 yes/no；turn 须以 in-flight dispatch 收束；per-plan 串行 implement；明确合法 STOP 边界。
- **`mstar-iteration` §2.6**：扩展 **Push 纪律（Autonomous Execute）** — Phase 5 merge-ready exit 前连续编排；task/plan/phase 间禁止确认问句。
- **`pm` skill**：恢复 **Autonomous Execute push** 为第 4 条规则；迭代语义 SSOT 仅 **`mstar-iteration`**（runtime skills 不引用 command 名）。
- **Skills 与 command 分层**：自 runtime `mstar-*` skills 移除 `iteration-drive` 反向引用（host、project-manager、sticky implementer、dispatch-and-assignment）。
- **Routing eval v15**：mid-execute 向用户 check-in 硬失败；新增 `iteration-drive-continuous-after-plan-wave` 场景。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.3**。

## [1.0.2] - 2026-07-07

### Harness（iteration 产物边界收紧）

- **`mstar-iteration` §1.5.5 / §1.6**：Phase 1 边界 — `{SPECS_DIR}/` 为已锁定长期规格；`{ITERATION_DIR}/<iteration-id>/` 工作区（`guides/`、`specs/`）存迭代级草案；**iteration-start 禁止**向 `{KNOWLEDGE_DIR}/` 新增。
- **`iteration-start` / `mstar-dispatch-gates`**：Review & Edit 链 — product/architect 改 specs + workspace；writing-specialist 做 **specs corpus hygiene** 与既有 knowledge 归档。
- **`mstar-compound`**：iteration-close **强制盘点** `<iteration-id>/` workspace，将值得保留的 specs/guides **提升**至 `{KNOWLEDGE_DIR}/`（结构化重写，非整文件复制）。
- **新增 reference**：`iteration-artifact-boundaries.md`、`iteration-corpus-hygiene.md`、`iteration-workspace-readme-template.md`；`knowledge-and-designs.md`、角色引用、`artifact-storage-paths.md` 已对齐。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.2**。

## [1.0.1] - 2026-07-07

### Harness（SDD iteration-drive + sticky implementer + pm shim）

- **`iteration-drive` / `mstar-iteration`**：Phase 2 显式强制 per-task SDD 循环（Boot 载入 `mstar-sdd`）；禁止多 task plan 用 inline 大包派发。
- **Sticky implementer**（`SDD implementer session: sticky`）：可选同一 dev subagent 跨 task 续会话（Cursor Task `resume`）；`implementer-session.json` 账本；**task reviewer 仍每 task fresh**。
- **`pm` skill**：精简为跨宿主入口 shim；iteration 编排 Boot 在 **`commands/`**；SSOT → `project-manager.md`。
- **派发模板**：`SDD implementer session` 字段；SDD vs inline Assignment 对照表。
- **Routing eval v14**：iteration Phase 2 SDD 硬失败项；新增 `sdd-sticky-implementer-multi-task`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.1**。

## [1.0.0] - 2026-07-07

### Harness（SDD + plan QC 三审）

- **新增 `mstar-sdd`**：文件交接、per-task implementer + **task reviewer**（L2）、`progress.md` 账本。
- **SDD 路径 plan QC**：**强制 tri-review**（QC#1/#2/#3 交叉审整分支，**N=3**）— 单 plan 与 iteration 均适用；**不是**仅一次单席 final review。
- **单席 `qc.md`**：仅 `Execution mode: inline` / hotfix 或用户 override。
- **Plan 模板**：Global Constraints、Interfaces、自检门；`status.json` 可选 `sdd_dir`、`task_commits[]`。
- **PM Assignment**：`Execution mode`、`SDD dir`、`Model tier`；多 task 默认 SDD。
- **CLI**：`init`/`doctor` 追加/检查 `.mstar/sdd/` gitignore。
- **Routing eval v11**：SDD + 强制 tri-review；inline/hotfix 单席。

### Breaking changes

1. 多 task 实现默认 **`Execution mode: sdd`**。
2. **SDD 下 plan QC 强制三审**；per-task 由 **task reviewer** 负责，不是单席 QC 代替。
3. **单席 `qc.md`** 仅 inline/hotfix 或 override。
4. 新 plan 须含 Global Constraints + Interfaces。
5. `.mstar/sdd/` 须 gitignore。

### 与 Superpowers v6

L2 task reviewer + L3 **tri 交叉审**（非 v6 仅 single final reviewer）。详见 `.harness/specs/sdd-1.0.0-design.md`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.0**。

## [0.7.9] - 2026-07-06

### Harness（Assignment plain role id / OpenCode `@` 卫生）

- **Assignment SSOT**：`dispatch-and-assignment.md` 模板、PM 路由表、`project-manager.md` Language 规则 — Assignment **正文**角色引用一律 **plain role id**（无 `@`）；宿主派发用 task tool **`subagent`** 对齐 `Execute as`。
- **`mstar-dispatch-gates`** 与 **leaf-executor checklist**：反递归 NEVER 改为 `role-id` 提及表述（避免 `@<role>` 字面量）。
- **`mstar-host/references/opencode.md`**：Role-mention hygiene — Assignment 正文 vs task-tool 派发；警告文案不含会触发 OpenCode 自动派发的 `@` 字面量。
- **iteration commands**、**`mstar-branch-worktree`**、**`mstar-plan-artifacts`**（plan 勾选职责）、**`pm` skill**、各 **role NEVER** 引用已对齐 plain id。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.8 → 0.7.9**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.8] - 2026-07-06

### Harness（iteration Phase 4–5 / PR merge-ready loop）

- **`mstar-iteration` Phase 4–5**：生命周期扩展为 **PR 交付**（Phase 4）与 **PR merge-ready loop**（Phase 5）——验证—修复—再验证，直至 mergeable、required CI 全绿、review threads resolved（修复后须 per-thread comment + resolve）。Loop SSOT 留在 `mstar-*`；不反向引用 host command。
- **`iteration-drive`**：编排 Phase 2 → 3 → 4 → 5；**Done** 仅以 Phase 5 exit checklist 为准。Phase 5 可按环境发现 **non-`mstar-*`** helper（`greploop`、`babysit`）；fallback 与 babysit 同级（CI + reviews）。
- **`mstar-harness-core`**：迭代 lifecycle 索引与「开 PR 后跳过 Phase 5」反模式；PM load contract 覆盖 `mstar-iteration` Phase 1–5。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.7 → 0.7.8**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.7] - 2026-07-04

### Harness（`mstar-*` 自洽 / 解耦第三方 runtime）

- **Standalone harness 护栏**（`mstar-harness-core`）：`mstar-*` load order 不得依赖仓库外 skills、CLI、MCP；库文档/API 问题优先 Read/Grep 项目内文档与源码。
- **bundled `grill-me` 仅 `/iteration-start`**：新增 `skills/grill-me/SKILL.md`；仅 command §3 引用，不进入 `mstar-*` 索引或 load matrix。`mstar-iteration` §1.2 增加通用 **Direction lock**（不点名 grill-me）。
- **移除 runtime 路径中的第三方耦合**：删除 `library-docs-protocol.md`（Context7）、`openviking-memory-plugin.md`（OpenViking）；`mstar-host` 去掉 Context7 节；`mstar-design-md` 去掉 Open Design 集成；`mstar-host/references/opencode.md` 去掉 Optional MCPs 表。
- **`open-harness-principles.md` 蒸馏**：harness 术语对照并入 `mstar-harness-core`；`AGENTS.md` 分层 → `mstar-plan-conventions/references/harness-bootstrap-and-agents-layering.md`；原文件删除。
- **`mstar-roles`**：保留 **Role → typical topic skills** 跨角色矩阵；专题索引仍在 `mstar-harness-core`。**`prompt-engineer`** 保留新建/大改 skill 时的 **`skill-creator`** 要求（`AGENTS.md` 记录 standalone 例外）。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.6 → 0.7.7**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.6] - 2026-07-01

### Harness（iteration 派发 / commands–skills 分层）

- **Commands 与 skills 分层**：`iteration-start`、`iteration-drive` 负责编排（Boot、phase 状态机、步骤 checklist）；`mstar-iteration`、`mstar-dispatch-gates` 保持与 command 名无关的 SSOT。移除 skill ↔ command 循环引用。
- **`iteration-start` / `iteration-drive`**：PM invariants、Phase 2→3→PR 过渡门禁、派发回合纪律、Phase 3 开 PR 前置条件；仅剩 1 个非 Done plan 时追加 `phase-3-iteration-close` host todo。
- **`mstar-iteration`**：Phase transition gates 表；§2.5 派发回合规则；compass 模板字段按 Phase 1–3 标注（不再用 command 名）。
- **`mstar-dispatch-gates`**：**Specialist review-and-edit dispatch**（通用）；Phase 1 链为**顺序**派发；paste-only 与跳过 Phase 3 反模式。
- **`mstar-host`**：删除 Mode A/B/C 补充执行路径；统一 canonical invoke 派发；无可用工具时 **`Blocked`**；`codex.md`、`parallel-dispatch.md` 对齐。
- **`pm` skill**：迭代段落去重，仅指向 `mstar-iteration`。
- **Phase 1 Review & Edit chain**：改为**顺序** `product-manager` → `architect` → `writing-specialist`（上一角色落盘后再 invoke 下一角色）；本链禁止并行 batch。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.5 → 0.7.6**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.5] - 2026-07-01

### Harness（iteration / 分支策略）

- **显式迭代分支策略**：正式 iteration 必须在 compass frontmatter 与 `status.json` metadata 中登记 `iteration_base_branch`、`spec_integration_branch`、`target_branch`。禁止静默默认 `main` / `master` 作为集成分支起点或最终 PR 目标。
- **`iteration-start` / `iteration-drive`**：grill-me 分支确认、pre-commit checklist 分支项、§2.0 branch metadata 门禁、创建 integration 分支时显式 `git checkout -b <spec_integration_branch> <iteration_base_branch>`。
- **`mstar-iteration` §2.3**：metadata 解析链（`status.json` → compass frontmatter → 询问用户）；QC `Review range` merge-base 使用 `target_branch` 或 PM 指定 ref。
- **Compass 模板**：新增 `## Delivery Branch Policy`；`status-and-residuals.md` 补充 metadata 示例 JSON。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.4 → 0.7.5**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.4] - 2026-07-01

### Harness（skills / docs）

- **移除 Morning Star 运行时对 Superpowers 的依赖**：删除 Superpowers 安装引导与对齐表述；Morning Star assignment 改为依赖 mstar-native 的 dispatch、worktree、plan、review 与 evidence 契约。
- **将 execution practices 并回 `mstar-coding-behavior`**：删除 `mstar-execution-practices`；将 review feedback handling 并入 `mstar-coding-behavior`；RCA、测试优先检查、完成证据留在编码行为基线，PM 门禁证据仍由 `mstar-phase-gates` / `mstar-review-qc` 承担。
- **新增 `mstar-skill-authoring`**：提供 Morning Star-native 的 skill 编写指导，覆盖 trigger contract、渐进披露、pressure scenarios 与行为变更证据。`prompt-engineer` 在新建 skill、重大重写或修改触发描述前必须读取该技能。
- **文档与宿主适配同步**：README / README_CN、OpenCode 安装说明、角色引用与 host references 不再要求外部 skill 插件。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.3 → 0.7.4**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.3] - 2026-06-30

### Harness（iteration-close / commands / docs）

- **`mstar-iteration` Phase 3 收口门禁**：iteration-close 明确为所有 plan `Done` 后的独立 phase；final plan closure 只能提供输入，不能替代 close。收口要求按需规范化 compass 结构，打印 close entry / close exit checklist，执行 compound round，更新 roadmap，写入 compass frontmatter `status: completed` + `end_date`，并在 PR 前 commit 到 integration 分支。
- **Compass 模板加固**：新 compass 模板不再预填 `end_date`；`## Roadmap Position`、`## Compound Round Summary`、`## Iteration Retrospective (minimal)` 是 close 阶段的预期写入位置。历史正文 completion status 必须在 close 时规范化为 YAML frontmatter。
- **Compound 索引门禁**：iteration-close compound round 中每篇新增 knowledge doc 都必须完成 `mstar-compound` Phase 6，并登记到 `{KNOWLEDGE_DIR}/README.md`；lightweight capture 不豁免。
- **README / README_CN**：Harness Commands 列出 `/mstar-bootstrap`、`/iteration-start`、`/iteration-drive`；Harness Workflow 更新为 `iteration-start → per-plan execute loop → iteration-close → PR`；Core Skills 表补齐 iteration、design、compound、compound-refresh、strategy 等专题技能。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.2 → 0.7.3**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.2] - 2026-06-30

### CLI / Cursor 安装

- **Cursor 插件路径布局**：`mstar-harness init --target cursor` 在 Cursor 插件路径安装**真实 git checkout**（`git clone` / `git pull`），不再软链接到 `~/.mstar/harness`。Cursor **无法发现**软链接形式的插件目录。
- **`doctor --target cursor`**：插件路径为 symlink 时报错；`init` 会删除已有 symlink 并 clone。
- **文档**：`docs/cli.md` § Install path layout；README/CN 手动安装与维护者刷新说明已更新。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.1 → 0.7.2**。**`@mstar-harness/cli`**：**0.5.3 → 0.5.4**。

## [0.7.1] - 2026-06-30

### Harness（skills / iteration-start）

- **`/iteration-start` Review & Edit chain 硬门禁**：§5 在 integration 分支 commit 前强制完成——通过 Task 派发 `@product-manager`、`@architect`、`@writing-specialist`（可并行）；PM 线程不得代做全部专业角色编辑。Done = 已修订的 compass/plans/specs + compass `status: locked`，而非初稿落盘即完成。
- **`mstar-iteration` §1.6**：将 review chain 记为 integration 分支前置条件（skill SSOT）；**不**要求 `reports/<iteration-id>/` 审查报告——与 per-plan QC 不同，迭代审查无后续审计链，SSOT 为被编辑的文档本身。
- **`skills/pm`**、**`mstar-dispatch-gates`**、**`mstar-harness-core`**：iteration-start dispatch-first 规则、反模式与 pre-commit checklist 与命令 §5 对齐。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.0 → 0.7.1**。**`@mstar-harness/cli` 保持 0.5.3**。

## [0.7.0] - 2026-06-30

### Harness（skills / iteration, compound, strategy, qc, commands）

- **新增 `mstar-compound` 技能**：知识结晶，含 Bug/Knowledge 双轨模板、YAML frontmatter schema、8 题自检清单、重叠检测（更新已有文档而非创建重复）、可发现性检查（提议 AGENTS.md 更新）、CONCEPTS.md 词汇协同。在**迭代收口**时执行，非 per-plan Done 后。
- **新增 `mstar-compound-refresh` 技能**：知识维护——对照当前代码库审查/更新/合并/替换/删除知识文档，CONCEPTS.md reconciliation。
- **新增 `mstar-strategy` 技能**：STRATEGY.md 创建与维护，作为项目上游锚点（愿景、技术方向、指导原则、决策日志）。
- **新增 `mstar-iteration` 技能**：完整迭代生命周期管理——Phase 1 iteration-start（范围/Roadmap 锁定、compass 创建），Phase 2 Autonomous Execute（per-plan 派发循环：分支→实现→QC→QA→Done→合并，跨 plan 进度同步），Phase 3 iteration-close（compound 轮、roadmap 更新、回顾、commit）。Autonomous Execute driver 从 `skills/pm/SKILL.md` 移入此处；PM skill 精简为角色身份、host 入口与 dispatch-first 规则。
- **新增 `/mstar-bootstrap` 命令**：为空白/残旧知识项目从代码库提炼 STRATEGY.md、CONCEPTS.md 与基线知识文档（7 阶段流程）。
- **新增 `artifact-storage-paths.md`**：产物路径集中 SSOT，位于 `mstar-plan-conventions` 下，所有产出技能引用此表，防止路径漂移。
- **QC deep review 透镜**：以自检透镜清单（12 个透镜、6 个触发信号）替代 persona subagent 派发。不派发子代理，解决与 `mstar-dispatch-gates` 的反递归冲突。
- **索引更新**：`mstar-harness-core` 拆分为 per-plan 与迭代级周期；全部 skill 索引表、`mstar-roles` 依赖矩阵、`mstar-phase-gates` per-plan 门禁均已更新。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.6.22 → 0.7.0**。**`@mstar-harness/cli` 保持 0.5.3**。

## [0.6.22] - 2026-06-27

### Harness（skills / dispatch-gates, roles）

- **反递归：身份剥夺框架替代纯禁止规则**：leaf executor（QC reviewer、dev、QA）仍然进入"考虑 dispatch"的意图窗口，因为 `NEVER` / `MUST NOT` 禁止规则要求模型先激活被禁止行为再抑制。本次修复将语义从"你不能用 Task"（禁止）转为"你就是 leaf executor，Task 不是你的工具"（身份 + 能力剥夺）。
  - Assignment 模板（`dispatch-and-assignment.md`）：在 `**You MUST NOT:**` 列表之前新增 **IDENTITY** + **CAPABILITY BOUNDARY** 块。`Delegation` 字段移至 `Execute as` 之后，提升可见性。
  - `mstar-dispatch-gates/SKILL.md`：在 Load order 与 NEVER 列表之间插入 leaf-executor 身份前言，并显式回指 Assignment 的 IDENTITY 块。
  - `qc-specialist-shared`：`Non-Recursive Dispatch Rule` 改为第一人称身份断言，附带递归 dispatch 陷阱识别（"If you ever think 'this would be more efficient if I dispatched X' — stop"）。
  - `leaf-executor-checklist`：checklist 项之前增加第一人称前言。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`：**0.6.21 → 0.6.22**。**`@mstar-harness/cli` 保持 0.5.3**，Cursor / Codex 插件 manifest 保持 **0.6.21**。

## [0.6.21] - 2026-06-26

### Harness（skills / design-md）

- **DESIGN.md YAML frontmatter 作为 SSOT**：`mstar-design-md` 模板和规范现在使用 YAML frontmatter 作为 token 值的唯一数据源。模板格式版本升至 0.1.0。明暗双主题模板（`DESIGN.md.template`、`DESIGN.dark.md.template`）、规范参考、完整性检查清单以及 Vercel 示例均已更新。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor / Codex 插件 manifest：**0.6.20 → 0.6.21**。CLI：**0.5.2 → 0.5.3**。

## [0.6.20] - 2026-06-26

### Harness（commands）

- **`/iteration-start` Review & Edit 链**：§5 从"Review Chain"改为"Review & Edit Chain"。product-manager、architect、writing-specialist 三个角色现在 review 后直接编辑文档，而非仅标记问题。PM 只做最终 review 和 lock，不再承担汇总其他 reviewer 修订的工作。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.19 → 0.6.20**。**`@mstar-harness/cli` 保持 0.5.2**。

## [0.6.19] - 2026-06-26

### Harness（skills / coding-behavior）

- **将 Ponytail 编程守则蒸馏入 `mstar-coding-behavior`**：四节均加强：
  - **§1 Think Before Coding**: 新增"先读懂再偷懒"——先完整阅读任务和每个涉及文件再动手；小 diff 改错地方是第二个 bug，不是效率。
  - **§2 Simplicity First**: 新增 YAGNI 门禁（"是否需要写代码？"）、The Ladder（7 级决策层级：不写→复用已有→stdlib→原生平台→已安装依赖→一行→最少代码）、"删除优于添加 / 简洁优于聪明"、`simplify:` 标记规范（有意简化时标注天花板和升级路径）。
  - **§3 Surgical Changes**: 新增"Bug 修根因，不休症状"——编辑前 grep 所有调用点；在共享入口修一次，不只修 ticket 提到的那条路径。
  - **§4 Goal-Driven Execution**: 新增"非平凡逻辑的最小检查"——任何非平凡改动须留下一个可运行检查（assert/最小 demo/单个 test）；YAGNI 同样适用于测试。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.18 → 0.6.19**。**`@mstar-harness/cli` 保持 0.5.2**。

## [0.6.18] - 2026-06-26

### Harness（commands）

- **`/iteration-start` Boot 节**：新增显式 `## 0. Boot` 节，与 `/iteration-drive` 对齐。在开始调研前加载 `mstar-harness-core`、`mstar-roles` → `references/project-manager.md`、`skills/pm/SKILL.md`（Host entry + Boot）、`mstar-phase-gates`（Prepare）以及 `mstar-plan-conventions` / `mstar-plan-artifacts`。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.17 → 0.6.18**。**`@mstar-harness/cli` 保持 0.5.2**。

## [0.6.17] - 2026-06-26

### Harness（commands）

- **`/iteration-drive` PR 目标修复**：最终 PR 的目标分支改为从迭代元数据（`status.json` → `target_branch`）解析，而非硬编码 `main`。未设置 `target_branch` 时默认 `main`。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.16 → 0.6.17**。**`@mstar-harness/cli` 保持 0.5.2**。

## [0.6.16] - 2026-06-25

### Harness（commands）

- **新增 `/iteration-drive` 命令**：添加调用 PM Autonomous Execute driver（`skills/pm/SKILL.md` § Autonomous Execute driver）的命令，将全部非 `Done` plans 推进至完成。命令首先检查三个前置条件门禁；若 Prepare 未完成，则引导用户使用 `/iteration-start`。否则执行完整的 implement → QC → QA → Done 逐 plan 循环，直到所有 plans 完成，最后可选从集成分支向 `main` 提交 PR。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.15 → 0.6.16**。**`@mstar-harness/cli` 保持 0.5.1**。

## [0.6.15] - 2026-06-24

### Harness（commands）

- **新增 `iteration-start` 命令**：添加可复用的命令（`/iteration-start`）用于启动新一轮 harness 迭代。命令引导 PM 完成六个检查站步骤：调研（结构化 harness 目录 + 非结构化 glob 搜索 `roadmap*.md`、`deferred*.md`、`features*.md` 等）、探索产品完备性候选方向、使用 `grill-me` 锁定方向、编写迭代 compass 与 plans、运行审查链（`@product-manager` → `@architect` → `@writing-specialist` → PM 锁定）、从 `main` 创建迭代集成分支。同时注册到 Cursor（`commands/` 自动发现）和 OpenCode（通过插件代码捆绑 `harness-commands/`）。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.14 → 0.6.15**。**`@mstar-harness/cli` 保持 0.5.1**。

## [0.6.14] - 2026-06-24

### Harness（skills / design-md）

- **新增 `mstar-design-md` 技能**：用于创建、审计和维护项目级 `DESIGN.md` 设计系统规范的专用技能。三级完整性检查清单（MVP/标准/生产）渐进定义了 agent 从设计系统生成一致 UI 所需的内容，避免猜测 token。包含 Vercel Geist 作为带注释参考范本、light/dark 双主题支持（`DESIGN.md` + `DESIGN.dark.md`，相同 token 名、不同值）以及内置 `LEVEL*_PLACEHOLDER` 标记用于迭代成熟度升级。技能包含完整 references（`design-md-spec.md` 规范、`completeness-checklist.md`、`vercel-example.md`）和 templates（`DESIGN.md.template`、`DESIGN.dark.md.template`）。
- **Phase gate：DESIGN.md 检查**：PM Prepare 快速判定新增"若 plan 涉及 UI 工作，DESIGN.md 是否存在且满足声明的 completeness level"。
- **角色集成**：`mstar-design-md` 在所有相关角色依赖中注册 —— architect 为主创建者，product-manager 提供设计意图/需求，frontend-dev 和 fullstack-dev 为消费方（实现 styled UI 前读取 token），qc-specialist 为验证方（检查 UI 与 DESIGN.md 对齐），qa-engineer 验证视觉输出。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.13 → 0.6.14**。**`@mstar-harness/cli` 保持 0.5.1**。

## [0.6.13] - 2026-06-20

### Harness（agents）

- **移除 `model: inherit`**：清除全部 13 个 `agents/*.md` 文件中的 `model: inherit` 行。这些 agent 通过插件 manifest 继承默认模型，无需逐个显式覆盖，减少 frontmatter 噪音并避免与模型固定混淆。（Cursor frontmatter 清理。）

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.12 → 0.6.13**。**`@mstar-harness/cli` 保持 0.5.1**。

## [0.6.12] - 2026-06-20

### Harness（skills / dispatch gates）

- **Assignment 反模式头部**：每个 PM Assignment 开头新增 `**You are a leaf executor. You MUST NOT:**` 块，针对该分配的角色+上下文列出最易发生的派发违规。PM 在通用底线（禁止递归派发、禁止将路由叙事当 invoke、工具可用≠授权）之上追加具体反模式。`Orchestration Guard` 节引用此新顶部块。（`mstar-roles/references/project-manager/dispatch-and-assignment.md`）
- **Leaf executor 自检清单**：更新为要求每次收到 Assignment 时首先阅读 `**You are a leaf executor. You MUST NOT:**` 块。（`mstar-dispatch-gates/references/leaf-executor-checklist.md`）
- **派发门禁**：在反递归红线节追加了对新 Assignment 级反模式块的引用。（`mstar-dispatch-gates/SKILL.md`）

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.11 → 0.6.12**。**`@mstar-harness/cli` 保持 0.5.1**。

## [0.6.11] - 2026-06-16

### Cursor 插件 / agents

- **Subagent 注册**：全部 `agents/*.md` frontmatter 改为 Cursor 优先（`name`、`description`、`model: inherit` 置于 OpenCode `mode`/`tools`/`permission` 之前），使插件 manifest 中的 `agents/` 可被 Task 识别，**无需**额外安装到 `~/.cursor/agents/`。
- **CLI Cursor 安装路径**：global/project 插件软链统一为 `morning-star-harness`（与 `.cursor-plugin/plugin.json` 的 `name` 一致）。
- **CLI doctor**：校验 plugin agent 文件存在且使用 Cursor 优先 frontmatter。
- **文档**：更新 README（中英）、CLI 指南、插件 README、LOCAL-VALIDATION subagent 冒烟测试及 `mstar-host` Cursor 参考。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.10 → 0.6.11**。
- `@mstar-harness/cli`：**0.5.0 → 0.5.1**。

## [0.6.10] - 2026-06-11

### Harness（skills / agents）

- **Profile B Done 压缩（`plans-done.json`）**：权威 schema 收紧为**仅** `{ "plans": [<plan-id>, ...] }`，不再使用富字段目录对象（`title`、`done_at`、`plan_file`、`archived_record` 等）。单条详情以 `archived/plans/<plan-id>.json`（单个 `plans[]` 行快照）为准。SSOT：`mstar-plan-artifacts/references/done-compaction.md`。
- **模板与初始化**：新增 `templates/plans-done.empty.json`；在 `mstar-plan-conventions` harness bootstrap 与 PM `plan-management.md` 中补充 Profile B 初始化说明。
- **Profile B 约束**：禁止并行索引（`_index.json`、对象数组目录）；旧版 `plans-done.json` 须整文件改写为 id 列表。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.9 → 0.6.10**。**`@mstar-harness/cli` 保持 0.5.0**。

## [0.6.9] - 2026-06-09

### Harness（skills / agents）

- **`pm`（PM 编排入口）**：从仅 Cursor/Codex `/pm` 扩展为跨宿主通用入口 — **Cursor/Codex** 以 `/pm` 启动 `project-manager` 并驱动 Execute 自动化；**OpenCode** 在当前 agent 非 PM 时切换为 PM 编排身份。
- **Autonomous Execute driver**：Pre-implement **GO** 后读取 `{HARNESS_DIR}/status.json` 待办，检出 iteration **`spec_integration_branch`**，按 plan 执行 **`create <plan-feature> from integration` → implement → QC/QA → merge 回 integration**，直至全部 plan `Done`；每波工作前设置宿主 todos（Cursor `TodoWrite`、Codex `update_plan`、OpenCode UI），避免会话目标漂移。
- **`mstar-roles`（PM 壳）**：交叉引用更新，指向 `pm` skill 新章节（宿主入口、Execute driver、dispatch-first）。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.8 → 0.6.9**。**`@mstar-harness/cli` 保持 0.5.0**。

## [0.6.8] - 2026-06-04

### Harness（skills / agents）

- **QC 修复后复验（默认）**：dev 修完 blocking 项后，PM **只派**提出该问题的 QC 席（**targeted re-review**），不再默认无脑重派三审。各 QC **原位更新**同一份报告（`## Revalidation`）；PM 原位更新 `qc-consolidated.md`。仅当 Assignment 写明 **`QC re-review: full tri-review`** 时才复跑三审并使用 `qcN-rev2.md` 新文件名。
- **QC 报告命名**：`{PLAN_DIR}/reports/<plan-id>/` 下使用 `qc1.md`、`qc2.md`、`qc3.md`、`qc-consolidated.md`（文件名**不再**带 `<plan-id>` 前缀；`plan_id` 在 frontmatter 与目录中体现）。SSOT：`mstar-plan-artifacts/references/plan-files-and-reports.md`。
- **派发**：`mstar-dispatch-gates` 与 `mstar-host` 并行派发支持 targeted 复验 **N=1–3** 同条消息；首轮三审仍为 **N=3**。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.7 → 0.6.8**。**`@mstar-harness/cli` 保持 0.5.0**。

## [0.6.7] - 2026-06-03

### Harness（skills / agents）

- 新增 Codex Plan / Goal Mode bridge reference，明确 `/plan`、`update_plan`、`/goal`、goal progress 与 thread summary 不能替代 `.mstar/` SSOT 或 Morning Star Done 权限。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.6 → 0.6.7**。**`@mstar-harness/cli` 保持 0.5.0**。

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
