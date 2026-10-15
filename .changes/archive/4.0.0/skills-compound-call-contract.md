---
category: Harness
packages: root
---

- Made `mstar-compound` the single owner of compound **steps** — and nothing else. A one-line interface boundary in `mstar-compound/references/compound-workflow.md` states that trigger timing, cwd, write surface and record surface belong to the **calling** flow, which declares them itself and cites the step file. The compound side no longer restates caller context (integration worktree, compass summary, workflow delivery record, PR-head timing), removing a reverse dependency and its second maintenance surface.
- `mstar-iteration` Phase 3 §3.2 now cites the step SSOT and keeps the iteration call surface as its own declaration; the standalone delivery tail cites the same step file from `mstar-roles/references/project-manager/plan-management.md`, with pointers added in `mstar-harness-core` and `mstar-conventions`.
- Removed the compound side's remaining caller registry: the interface-boundary line, the lifecycle-integration paragraph, the `description`, and the package-promotion preface no longer name the calling flows' files or their gate labels. The dependency stays one-way — callers cite the step file; the compound skill owns the steps and nothing about who calls it.

<!-- CN -->
- 让 `mstar-compound` **只拥有 compound 步骤**：`mstar-compound/references/compound-workflow.md` 顶部以一行接口边界声明"触发时机 / cwd / 写入面 / 记录面属**调用方**流程，由调用方自身声明并引用本步骤文件"。compound 侧不再复述调用方上下文（integration worktree、compass 摘要、workflow delivery 记录、PR head 时点），消除反向依赖及其第二维护面。
- `mstar-iteration` Phase 3 §3.2 改为引用步骤 SSOT，并把迭代调用面作为自身声明保留；单 plan 交付尾段在 `mstar-roles/references/project-manager/plan-management.md` 引用同一步骤文件，`mstar-harness-core` 与 `mstar-conventions` 补上指引。
- 移除 compound 侧残余的调用方注册表：接口边界句、生命周期集成段、`description` 与 package 盘点前言不再点名调用方文件或其 gate 标签。依赖保持单向 —— 调用方指向步骤文件，compound 只拥有步骤，不持有"谁调用我"的信息。
