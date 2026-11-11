---
category: Harness
packages: root
---

- `mstar-knowledge` now completes capture, maintenance and project bootstrap in a repository with no `.mstar/` root, no store and no iteration: the Load Order names **`mstar-harness-core`** only for projects already running the harness, `mstar-conventions` stays a conditional pointer to the full path chain, and the skill states its own `{KNOWLEDGE_DIR}` default (`.agents/knowledge/`, `.mstarc` override).
- Bootstrap's harness-initialization phase is **opt-in**: the default standalone outcome is `STRATEGY.md` + `CONCEPTS.md` + baseline knowledge docs committed with no `.mstar/` and no store.

<!-- CN -->
- `mstar-knowledge` 现在可以在没有 `.mstar/` 根、没有 store、没有迭代的仓库里完成采集、维护与项目 bootstrap：Load Order 只在项目已运行 harness 时才点名 **`mstar-harness-core`**，`mstar-conventions` 退为完整路径链的条件指针，技能自身声明 `{KNOWLEDGE_DIR}` 默认值（`.agents/knowledge/`，`.mstarc` 可覆盖）。
- bootstrap 的 harness 初始化阶段改为**可选**：默认独立结果是 `STRATEGY.md` + `CONCEPTS.md` + 基线知识文档直接提交，无 `.mstar/`、无 store。
