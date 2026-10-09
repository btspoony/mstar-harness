---
category: Harness
packages: root
---

- **Runtime-facing READMEs.** README.md and README_CN.md are rewritten for people running the harness with their own coding tools: plain-language positioning and use cases, a condensed install/verify surface covering all seven hosts, the three entry shapes (single task, iteration, audit/review/verification), the delivery workflow in prose, and a help-driven CLI section (`--help` lists a command's inputs, including issue payload fields with requiredness and type; a usage refusal names the problem, the help route, and the recovery).
- **Reference split.** Component, storage, role/skill, CLI-contract, report, MCP, and enforcement material moved off the homepage into the new docs/runtime-reference.md, and INSTALL.md's report link now points at its Offline report draft anchor.
- **Install facts corrected.** omp installs only when its CLI is present; `init` defaults to `--scope project` with host-specific surfaces (dsh's profile is machine-global; Codex's global scope skips the command skills); the MCP section documents all seven host launch configs, including the shipped dsh Cordis row loaded through the `@deepseek-ai/dsh-mcp-client` bridge plugin, and iteration wording follows the Phase 2–6 lifecycle.

<!-- CN -->
- **面向 runtime 用户的 README。** README.md 与 README_CN.md 重写为给使用 AI 编程工具做开发的人阅读：直白的定位与适用场景、覆盖七个宿主的精简安装/校验说明、三种入口形态（单任务、迭代、审计/Review/验证）、以文字描述的交付流程，以及以 help 为主的 CLI 说明（`--help` 列出命令期望的输入，包括 issue payload 字段的必填性与类型；用法被拒绝时给出问题、help 路径与恢复方式）。
- **参考文档拆分。** 组件、存储、角色与技能、CLI 契约、report、MCP 与 enforcement 内容从首页迁入新增的 docs/runtime-reference.md；INSTALL.md 的 report 链接改指其 Offline report draft 锚点。
- **安装事实修正。** omp 需要先安装其 CLI；`init` 默认 `--scope project`，各宿主表现不同（dsh 的 profile 是机器全局的；Codex 的 global scope 不安装命令 skill）；MCP 一节记录七个宿主的启动配置，含随包提供、经 `@deepseek-ai/dsh-mcp-client` 桥接插件加载的 dsh Cordis 行；迭代措辞改为 Phase 2–6 生命周期。
