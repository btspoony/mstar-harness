# Agent 共享规则入口

本文件是 `~/.config/opencode/docs/agents/` 共享文档的总入口，提供可复用于不同项目/角色的通用约束与流程。

## 适用范围

- 适用于使用 `~/.config/opencode/agents/*.md` 角色提示词的执行场景。
- 与具体业务仓库无关的流程规则，优先写在本目录。
- 项目级规则冲突时，按“用户指令 > 项目 `AGENTS.md` / `CLAUDE.md` > 全局共享规则”处理。

## 信息源优先级

1. 当前任务中的用户指令
2. 项目级 `AGENTS.md`（项目 cwd 下）
3. 本共享入口 `~/.config/opencode/docs/agents/AGENTS.md`
4. 本目录下的专题文档（`harness-loop.md`、`review-harness.md` 等）
5. 角色提示词（`~/.config/opencode/agents/*.md`）

## 渐进式读取

按需读取（均为绝对路径）：

1. `~/.config/opencode/docs/agents/index.md` — 知识库索引与归属
2. `~/.config/opencode/docs/agents/harness-loop.md` — 生命周期与阶段门禁
3. `~/.config/opencode/docs/agents/evaluation-harness.md` — 评估与基准
4. `~/.config/opencode/docs/agents/review-harness.md` — QC 共享基线
5. `~/.config/opencode/docs/agents/routing-harness.md` — PM 路由评估
6. `~/.config/opencode/docs/agents/plan-convention.md` — plan 目录约定
7. `~/.config/opencode/docs/agents/phase-gate-playbook.md` — Phase Gate 执行手册（Prepare/Execute）
8. `~/.config/opencode/docs/agents/branch-collaboration.md` — 可写角色分支协作契约与 PM 确认话术
9. `~/.config/opencode/docs/agents/superpowers-skills.md` — Superpowers 技能与角色映射；未装 Superpowers 插件时见文内「未安装插件时」（改全局 `opencode.json` 须用户同意）
10. `~/.config/opencode/docs/agents/open-harness-principles.md` — 开源 harness 理念在本仓库的落点索引（意图门禁、Task category、可验证编辑等）
11. `~/.config/opencode/docs/agents/optional-tooling-by-capability.md` — 按能力可选的 MCP/skills（与 harness 理念对齐，非插件依赖）

## 最小交付循环（非平凡任务）

1. 准备阶段：`specify -> clarify -> plan`
2. 执行准备：`plan` 锁定后执行 `tasks` 拆解
3. 分派到最匹配角色并 `implement`
4. 审查与验证门禁（QC + QA）
5. 复盘沉淀为可复用规则

## 不变量

- 保持边界显式，避免跨层隐式耦合。
- 行为变更必须有对应验证证据。
- 拒绝未记录的破坏性变更。
- 对业务 Git 仓库的可合并改动，默认在功能分支上完成；默认分支直改需在 Assignment 显式写 `Branch policy` 例外。新开分支的**祖先**由 Assignment 写明（可从 `main`、已有 `feature/*`、或 `current` 叠分支；细则见 `harness-loop.md`）。
- 语言约定（PM 编排场景）：Assignment 字段名保持既定英文键名；字段值中的任务描述正文默认可用中文。所有执行产出与报告默认英文，除非用户明确要求其他语言。

## 升级触发

以下情况应升级到人工决策：

- 验收标准与系统约束冲突
- 方案取舍存在重大风险或产品分歧
- 两次完整实现尝试后仍失败
