# 更新日志

本仓库 harness 发布面版本以 [CHANGELOG.md](CHANGELOG.md) 为准：**0.3.2**（CLI 包除外，见下表）。

| 发布面 | 位置 | 版本 |
| --- | --- | --- |
| monorepo 根 | `morning-star`（`package.json`） | **0.3.2** |
| CLI | `@mstar-harness/cli`（`packages/cli`） | **0.3.1**（本轮不发布 npm） |
| OpenCode 插件 | `@mstar-harness/opencode`（`packages/opencode`） | **0.3.2** |
| Cursor 插件 | `.cursor-plugin/plugin.json` | **0.3.2** |
| Codex 插件 | `.codex-plugin/plugin.json` | **0.3.2** |

各包独立日志：[packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)、[packages/opencode/CHANGELOG.md](packages/opencode/CHANGELOG.md)。

## [0.3.2] - 2026-05-19

### Harness（skills / agents）

- **计划目录**（`mstar-plan-conventions`）：正式约定 `{ITERATION_DIR}`（`{HARNESS_DIR}/iterations/`）与 `{KNOWLEDGE_DIR}`（`{HARNESS_DIR}/knowledge/`）；补充 `docs/` 与 harness 子树内容边界（对齐 Nexus）；`status.json` 可选 `iteration_compass` / `iteration_refs`。
- **Prepare · clarify**（`mstar-harness-core`）：`clarify` 核心纪律 — 沿设计决策树达成共享理解、能查代码库先探索、每问附推荐答案。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.3.1 → 0.3.2**。**`@mstar-harness/cli` 保持 0.3.1**（本轮不发布 CLI npm 包）。

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
