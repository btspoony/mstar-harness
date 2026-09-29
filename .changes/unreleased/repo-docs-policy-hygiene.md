---
category: Harness
packages: root
---

- Recorded the repository's CLI-usage rule in `AGENTS.md`: run this checkout's own build (`bun run --cwd packages/cli build`, then `packages/cli/dist/mstar-harness.js`) rather than a globally installed `mstar`/`mstar-harness`. A global install is the released package for other projects — linking this checkout into it makes those projects run unreleased code, and invoking the global copy here runs a released CLI against unreleased engine behavior.
- Added two **prose-hygiene rules** to `mstar-compound`'s knowledge-document quality gate: durable bodies state the rule and the outcome, not the authoring date (timestamps belong to the frontmatter `date` / `last_updated` schema fields), and citations use repo-relative paths or `{HARNESS_DIR}`-style symbols rather than machine-local absolute paths.
- Reinforces the existing `CONCEPTS.md` rule (no status/date/owner fields) at the compound write path.
- **Guard 8** validates links and heading anchors across tracked Markdown, using the canonical `github-slugger` behavior to resolve heading fragments.
- Same-file fragments such as `#section-name` are checked against their source document.
- **`drift-lint` gate clean**: dashboard file-header comments rewritten to behaviour-only prose — tracked text carries no local plan/iteration ids (14 provenance citations cleared; the scan reports 0).
- Restored the product name in both README titles: the H1 pair reads `Morning Star` again instead of `Morning Star (晨星)`. The Chinese brand name stays in the Chinese page's lead line, and the two one-line edits keep the README pair size-mirrored.
- Ignored transient **Bun cache output** (`/Library/Caches/bun/`) at the repository root so session-environment cache dumps no longer dirty worktree `git status` or block clean-worktree gates.
- **`validate` gate repaired**: the engine builds and typechecks again — the duplicate root `Severity` re-export (core vs issue vocabularies) is resolved to the canonical core path, and the undefined-narrowing / matcher-overload errors in the engine tests and `initializeStore` are fixed with no runtime semantics change. `packages/cli` `typecheck:src` now regenerates the gitignored dashboard asset module first (`scripts/build-web.ts`; deterministic, round-trip-verified), so a fresh checkout typechecks without a full build.
- **Safer worktree cleanup ownership:** Completion retains the plan's exact branch and worktree path after lease release. Cleanup can also recover a claim from a valid completed Done-row handoff; degraded parseable snapshots preserve handoff resources as protective, nonterminal metadata but never authorize removal. Unreadable snapshots withhold removals unless explicitly ignored. Applying cleanup re-plans after deferred integration worktrees are removed before deleting newly-unchecked-out branches. Ambiguous ownership still refuses removal.
- **Ignored-content cleanup:** Ignored-only files no longer make a worktree dirty for cleanup. Applying an eligible removal deletes those ignored files without a Git recovery backstop; tracked changes and non-ignored untracked files still block removal, and cleanup never forces it.

<!-- CN -->
- 在 `AGENTS.md` 记录本仓库的 CLI 使用规则：运行本检出自己的构建（`bun run --cwd packages/cli build`，随后 `packages/cli/dist/mstar-harness.js`），而不是全局安装的 `mstar`/`mstar-harness`。全局安装是给其他项目用的已发布包——把本检出 link 进去会让那些项目跑到未发布代码，而在这里调用全局副本则是用已发布 CLI 去操作未发布的引擎行为。
- 在 `mstar-compound` 的知识文档质量门新增两条**正文卫生规则**：durable 正文陈述规则与结论，不写撰写日期（时间信息属于 frontmatter 的 `date` / `last_updated` schema 字段）；引用使用 repo-relative 路径或 `{HARNESS_DIR}` 等符号，不写机器专属绝对路径。
- 把 `CONCEPTS.md` 既有的「no status/date/owner fields」规则落到 compound 写入路径。
- 新增 **Guard 8**，校验已跟踪 Markdown 中的链接与标题锚点，并使用规范的 `github-slugger` 行为解析标题片段。
- 同文件片段链接（如 `#section-name`）会针对其源文档进行校验。
- **`drift-lint` 门禁清零**：dashboard 文件头注释改写为纯行为描述——跟踪文本不再包含本地 plan/iteration id（清除 14 处出处引用，扫描报告 0）。
- 两个 README 的大标题恢复为产品名 `Morning Star`（原为 `Morning Star (晨星)`）。中文品牌名保留在中文版首句，两处单行改动保持 README 双语对的尺寸镜像。
- 在仓库根忽略瞬时 **Bun 缓存输出**（`/Library/Caches/bun/`），会话环境落下的缓存目录不再弄脏 worktree `git status` 或阻塞干净工作树门禁。
- **`validate` 门禁修复**：engine 重新可构建、可类型检查——根导出 `Severity` 重复（core 与 issue 两套词表）收敛为规范的 core 路径，引擎测试与 `initializeStore` 中的 undefined 收窄 / 匹配器重载错误已修复，运行时语义不变。`packages/cli` 的 `typecheck:src` 现在先生成被 gitignore 的 dashboard 资产模块（`scripts/build-web.ts`；确定性、往返校验），全新检出无需完整构建即可通过类型检查。
- **更可靠的工作树回收归属：** 完成计划时，在释放租约后仍保留其准确的分支与工作树路径。回收也可从有效的已完成 Done 行交接记录恢复归属；可解析但无效的快照会将交接资源保留为保护性、非终态元数据，但绝不授权删除。除非显式忽略，否则无法读取的快照会阻止删除。执行回收时，在移除延后处理的集成工作树后重新规划，再删除因此解除检出的分支。归属冲突仍拒绝移除。
- **忽略文件的回收：** 仅有被忽略文件时，工作树不再被判为脏。执行符合条件的移除会删除这些文件，且 Git 不提供恢复保障；已跟踪改动和非忽略的未跟踪文件仍阻止移除，回收绝不强制执行。
