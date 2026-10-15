---
category: Harness
packages: root, opencode, engine, dsh, omp
---

- Renamed the Chinese brand copy to **晨星** across the docs, skill descriptions, host reference, marketplace `zh-CN` display names and the dsh panel locale value.
- Dropped the parenthetical Chinese gloss from the English plugin `longDescription` fields and the package READMEs — `Morning Star …` now reads directly, with no `(晨星)` substitute. The root README pair keeps the bilingual brand line (`Morning Star (晨星)`), so both languages change in the same set.
- **Runtime-facing READMEs.** README.md and README_CN.md are rewritten for people running the harness with their own coding tools: plain-language positioning and use cases, a condensed install/verify surface covering all seven hosts, the three entry shapes (single task, iteration, audit/review/verification), the delivery workflow as one Mermaid diagram per language, and a help-driven CLI section (`--help` lists a command's inputs, including issue payload fields with requiredness and type; a usage refusal names the problem, the help route, and the recovery).
- **Product identity restored.** Both READMEs carry the original subtitle (`Harness Workflow Engine · Agent Plugin`) and the full badge set — CI, license, version, last commit, dshfind, Greptile, and the four npm download badges.
- **Role overview retained.** Both READMEs keep the original role table followed by a short explanation of how the PM dispatches work; the Markdown customization wording is removed.
- **Workflow diagram.** The numbered workflow list is replaced by one Mermaid diagram per README: plan → implementation → independent review → acceptance with rework loops → iteration repetition → PR checks and review corrections → merge-ready → explicitly authorized merge → verified merge and post-merge close, with scope notes for the hotfix/inline and report-only routes.
- **Dashboard and MCP sections.** Both READMEs gain dedicated Dashboard and MCP sections — what the user sees or does, plus a minimal startup example — which replace the duplicate dashboard/MCP bullets in the command-line section.
- **Reference split.** Component, storage, CLI-contract, report, and enforcement detail moved off the homepage into the new docs/runtime-reference.md — detailed role/skill references and MCP host-integration material live there too, while the role overview and a short user-facing MCP introduction stay on the README — and INSTALL.md's report link now points at its Offline report draft anchor.
- **Install facts corrected.** omp installs only when its CLI is present; `init` defaults to `--scope project` with host-specific surfaces (dsh's profile is machine-global; Codex's global scope skips the command skills); the runtime reference documents all seven host MCP launch configurations, including the shipped dsh Cordis row loaded through the `@deepseek-ai/dsh-mcp-client` bridge plugin, and iteration wording follows the Phase 2–6 lifecycle.
- **Simpler README installation entry.** The English and Chinese installation sections now start directly with the host table. A **Node.js 24+** badge links to the full prerequisites in `INSTALL.md`; existing badges are retained, and MCP prerequisite links point to the same reference. Runtime requirements are unchanged.
- Recorded the repository's CLI-usage rule in `AGENTS.md`: run this checkout's own build (`bun run --cwd packages/cli build`, then `packages/cli/dist/mstar-harness.js`) rather than a globally installed `mstar`/`mstar-harness`. A global install is the released package for other projects — linking this checkout into it makes those projects run unreleased code, and invoking the global copy here runs a released CLI against unreleased engine behavior.
- Added two **prose-hygiene rules** to `mstar-compound`'s knowledge-document quality gate: durable bodies state the rule and the outcome, not the authoring date (timestamps belong to the frontmatter `date` / `last_updated` schema fields), and citations use repo-relative paths or `{HARNESS_DIR}`-style symbols rather than machine-local absolute paths.
- Reinforces the existing `CONCEPTS.md` rule (no status/date/owner fields) at the compound write path.
- **Guard 8** validates links and heading anchors across tracked Markdown, using the canonical `github-slugger` behavior to resolve heading fragments.
- Same-file fragments such as `#section-name` are checked against their source document.
- **`drift-lint` gate clean**: dashboard file-header comments rewritten to behaviour-only prose — tracked text carries no local plan/iteration ids (14 provenance citations cleared; the scan reports 0).
- Restored the product name in both README titles: the H1 pair reads `Morning Star` again instead of `Morning Star (晨星)`. The Chinese brand name stays in the Chinese page's lead line, and the two one-line edits keep the README pair size-mirrored.
- Ignored transient **Bun cache output** (`/Library/Caches/bun/`) at the repository root so session-environment cache dumps no longer dirty worktree `git status` or block clean-worktree gates.
- **`validate` gate repaired**: the engine builds and typechecks again — the duplicate root `Severity` re-export (core vs issue vocabularies) is resolved to the canonical core path, and the undefined-narrowing / matcher-overload errors in the engine tests and `initializeStore` are fixed with no runtime semantics change. `packages/cli` `typecheck:src` now regenerates the gitignored dashboard asset module first (`scripts/build-web.ts`; deterministic, round-trip-verified), so a fresh checkout typechecks without a full build.
- Removed the unused tracked root `specs/` directory: `{SPECS_DIR}` resolution picks `{HARNESS_DIR}/specs/` first, so the root copy was shadowed, shipped in no package, and referenced nowhere.

<!-- CN -->
- 中文品牌文案统一重命名为 **晨星**（文档、skill description、宿主参考、marketplace `zh-CN` 显示名与 dsh 面板 locale 值）。
- 移除英文语境中的中文括注：插件 `longDescription` 与各包 README 直接写 `Morning Star …`，不替换为 `（晨星）`。根 README 双语对保留品牌行 `Morning Star (晨星)`，使两种语言在同一变更集内同步。
- **面向 runtime 用户的 README。** README.md 与 README_CN.md 重写为给使用 AI 编程工具做开发的人阅读：直白的定位与适用场景、覆盖七个宿主的精简安装/校验说明、三种入口形态（单任务、迭代、审计/Review/验证）、以每语言一张 Mermaid 图呈现的交付流程，以及以 help 为主的 CLI 说明（`--help` 列出命令期望的输入，包括 issue payload 字段的必填性与类型；用法被拒绝时给出问题、help 路径与恢复方式）。
- **产品标识恢复。** 两份 README 恢复原副标题（`Harness Workflow Engine · Agent Plugin`）与完整 badge 组合 —— CI、license、version、last commit、dshfind、Greptile 以及四个 npm 下载徽章。
- **保留角色概览。** 两份 README 保留原角色表格，表后简要说明 PM 如何派发工作；移除关于修改 Markdown 来适配团队习惯的措辞。
- **工作流图。** 编号式流程清单替换为每份 README 一张 Mermaid 图：计划 → 实现 → 独立审查 → 含返工回路的验收 → 迭代重复 → PR 检查与审查修正 → merge-ready → 显式授权后合并 → 核实合并并收尾；另附 hotfix/inline 与 report-only 路线的范围说明。
- **Dashboard 与 MCP 小节。** 两份 README 新增独立的 Dashboard 与 MCP 小节 —— 用户能看到或能做什么，以及最小启动示例 —— 并以此取代命令行小节中重复的 dashboard/MCP 条目。
- **参考文档拆分。** 组件、存储、CLI 契约、report 与 enforcement 细节从首页迁入新增的 docs/runtime-reference.md —— 角色与技能的详细参考、MCP 宿主集成说明也在该页，首页保留角色概览与面向用户的简短 MCP 介绍 —— INSTALL.md 的 report 链接改指其 Offline report draft 锚点。
- **安装事实修正。** omp 需要先安装其 CLI；`init` 默认 `--scope project`，各宿主表现不同（dsh 的 profile 是机器全局的；Codex 的 global scope 不安装命令 skill）；runtime 参考文档记录七个宿主的 MCP 启动配置，含随包提供、经 `@deepseek-ai/dsh-mcp-client` 桥接插件加载的 dsh Cordis 行；迭代措辞改为 Phase 2–6 生命周期。
- **精简 README 安装入口。** 中英文安装章节直接从宿主表格开始；新增 **Node.js 24+** badge，链接到 `INSTALL.md` 中的完整前置要求。保留现有 badges，并将 MCP 的前置要求链接指向同一参考。运行时要求不变。
- 在 `AGENTS.md` 记录本仓库的 CLI 使用规则：运行本检出自己的构建（`bun run --cwd packages/cli build`，随后 `packages/cli/dist/mstar-harness.js`），而不是全局安装的 `mstar`/`mstar-harness`。全局安装是给其他项目用的已发布包——把本检出 link 进去会让那些项目跑到未发布代码，而在这里调用全局副本则是用已发布 CLI 去操作未发布的引擎行为。
- 在 `mstar-compound` 的知识文档质量门新增两条**正文卫生规则**：durable 正文陈述规则与结论，不写撰写日期（时间信息属于 frontmatter 的 `date` / `last_updated` schema 字段）；引用使用 repo-relative 路径或 `{HARNESS_DIR}` 等符号，不写机器专属绝对路径。
- 把 `CONCEPTS.md` 既有的「no status/date/owner fields」规则落到 compound 写入路径。
- 新增 **Guard 8**，校验已跟踪 Markdown 中的链接与标题锚点，并使用规范的 `github-slugger` 行为解析标题片段。
- 同文件片段链接（如 `#section-name`）会针对其源文档进行校验。
- **`drift-lint` 门禁清零**：dashboard 文件头注释改写为纯行为描述——跟踪文本不再包含本地 plan/iteration id（清除 14 处出处引用，扫描报告 0）。
- 两个 README 的大标题恢复为产品名 `Morning Star`（原为 `Morning Star (晨星)`）。中文品牌名保留在中文版首句，两处单行改动保持 README 双语对的尺寸镜像。
- 在仓库根忽略瞬时 **Bun 缓存输出**（`/Library/Caches/bun/`），会话环境落下的缓存目录不再弄脏 worktree `git status` 或阻塞干净工作树门禁。
- **`validate` 门禁修复**：engine 重新可构建、可类型检查——根导出 `Severity` 重复（core 与 issue 两套词表）收敛为规范的 core 路径，引擎测试与 `initializeStore` 中的 undefined 收窄 / 匹配器重载错误已修复，运行时语义不变。`packages/cli` 的 `typecheck:src` 现在先生成被 gitignore 的 dashboard 资产模块（`scripts/build-web.ts`；确定性、往返校验），全新检出无需完整构建即可通过类型检查。
- 移除未被使用的根 `specs/` 跟踪目录：`{SPECS_DIR}` 解析始终优先选中 `{HARNESS_DIR}/specs/`，该根目录副本从未被解析、不随任何包发布、亦无任何引用。
