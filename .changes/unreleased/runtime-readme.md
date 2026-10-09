---
category: Harness
packages: root
---

- **Runtime-facing READMEs.** README.md and README_CN.md are rewritten for people running the harness with their own coding tools: plain-language positioning and use cases, a condensed install/verify surface covering all seven hosts, the three entry shapes (single task, iteration, audit/review/verification), the delivery workflow as one Mermaid diagram per language, and a help-driven CLI section (`--help` lists a command's inputs, including issue payload fields with requiredness and type; a usage refusal names the problem, the help route, and the recovery).
- **Product identity restored.** Both READMEs carry the original subtitle (`Harness Workflow Engine · Agent Plugin`) and the full badge set — CI, license, version, last commit, dshfind, Greptile, and the four npm download badges.
- **Role overview retained.** Both READMEs keep the original role table followed by a short explanation of how the PM dispatches work; the Markdown customization wording is removed.
- **Workflow diagram.** The numbered workflow list is replaced by one Mermaid diagram per README: plan → implementation → independent review → acceptance with rework loops → iteration repetition → PR checks and review corrections → merge-ready → explicitly authorized merge → verified merge and post-merge close, with scope notes for the hotfix/inline and report-only routes.
- **Dashboard and MCP sections.** Both READMEs gain dedicated Dashboard and MCP sections — what the user sees or does, plus a minimal startup example — which replace the duplicate dashboard/MCP bullets in the command-line section.
- **Reference split.** Component, storage, CLI-contract, report, and enforcement detail moved off the homepage into the new docs/runtime-reference.md — detailed role/skill references and MCP host-integration material live there too, while the role overview and a short user-facing MCP introduction stay on the README — and INSTALL.md's report link now points at its Offline report draft anchor.
- **Install facts corrected.** omp installs only when its CLI is present; `init` defaults to `--scope project` with host-specific surfaces (dsh's profile is machine-global; Codex's global scope skips the command skills); the runtime reference documents all seven host MCP launch configurations, including the shipped dsh Cordis row loaded through the `@deepseek-ai/dsh-mcp-client` bridge plugin, and iteration wording follows the Phase 2–6 lifecycle.

<!-- CN -->
- **面向 runtime 用户的 README。** README.md 与 README_CN.md 重写为给使用 AI 编程工具做开发的人阅读：直白的定位与适用场景、覆盖七个宿主的精简安装/校验说明、三种入口形态（单任务、迭代、审计/Review/验证）、以每语言一张 Mermaid 图呈现的交付流程，以及以 help 为主的 CLI 说明（`--help` 列出命令期望的输入，包括 issue payload 字段的必填性与类型；用法被拒绝时给出问题、help 路径与恢复方式）。
- **产品标识恢复。** 两份 README 恢复原副标题（`Harness Workflow Engine · Agent Plugin`）与完整 badge 组合 —— CI、license、version、last commit、dshfind、Greptile 以及四个 npm 下载徽章。
- **保留角色概览。** 两份 README 保留原角色表格，表后简要说明 PM 如何派发工作；移除关于修改 Markdown 来适配团队习惯的措辞。
- **工作流图。** 编号式流程清单替换为每份 README 一张 Mermaid 图：计划 → 实现 → 独立审查 → 含返工回路的验收 → 迭代重复 → PR 检查与审查修正 → merge-ready → 显式授权后合并 → 核实合并并收尾；另附 hotfix/inline 与 report-only 路线的范围说明。
- **Dashboard 与 MCP 小节。** 两份 README 新增独立的 Dashboard 与 MCP 小节 —— 用户能看到或能做什么，以及最小启动示例 —— 并以此取代命令行小节中重复的 dashboard/MCP 条目。
- **参考文档拆分。** 组件、存储、CLI 契约、report 与 enforcement 细节从首页迁入新增的 docs/runtime-reference.md —— 角色与技能的详细参考、MCP 宿主集成说明也在该页，首页保留角色概览与面向用户的简短 MCP 介绍 —— INSTALL.md 的 report 链接改指其 Offline report draft 锚点。
- **安装事实修正。** omp 需要先安装其 CLI；`init` 默认 `--scope project`，各宿主表现不同（dsh 的 profile 是机器全局的；Codex 的 global scope 不安装命令 skill）；runtime 参考文档记录七个宿主的 MCP 启动配置，含随包提供、经 `@deepseek-ai/dsh-mcp-client` 桥接插件加载的 dsh Cordis 行；迭代措辞改为 Phase 2–6 生命周期。
