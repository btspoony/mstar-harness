---
packages: root, opencode
---

- **Skills v2 surfaces**: retired `done-compaction` / `plans-done` / `notes.empty` artifacts and scrubbed all references; rewrote status/residual/lease/convention surfaces across `mstar-*` skills to v2 addresses (`workflows/<id>/snapshot.json`, `projects/<id>/residuals.json`, `mstar status validate` / `findings-cleanup` / `tech-debt`, `mstar lease verify --workflow <id>`, `mstar iteration gate --workflow <id>`).
- **`mstar-engine-legacy`** (new): conditional contract archive for engine-absent hosts — status v1→v2 field history, lease protocol, per-host QC seat N=3/N=1 restatements, anti-recursion checklists, engine-check boilerplate; not loaded when engine constraints are active.
- **`mstar-project-governance`** (new): `projects/<id>/roadmap.md` authoring conventions (frontmatter schema + body conventions, warnings-only) and `residuals.json` register lifecycle (open → verified close in place, severity enum, provenance fields, `_default` fallback); schema verbatim with the engine `project.ts` validators.
- **Docs sync**: README.md / README_CN.md layout description and workflow diagram updated to v2 state surfaces (workflow snapshot / project register; `workflow_dir` / `project_dir` `.mstarc` keys); routing-eval scenario set re-pointed to v2 artifact addresses.

<!-- CN -->
- **Skills v2 表面**：退役 `done-compaction` / `plans-done` / `notes.empty` 产物并清除全部引用；将 `mstar-*` skills 的 status/residual/lease/convention 表面改写为 v2 地址（`workflows/<id>/snapshot.json`、`projects/<id>/residuals.json`、`mstar status validate` / `findings-cleanup` / `tech-debt`、`mstar lease verify --workflow <id>`、`mstar iteration gate --workflow <id>`）。
- **`mstar-engine-legacy`**（新增）：engine-absent 宿主条件契约档案——status v1→v2 字段历史、lease 协议、各宿主 QC 座次 N=3/N=1 重述、反递归清单、Engine-check 样板；engine 约束激活时不加载。
- **`mstar-project-governance`**（新增）：`projects/<id>/roadmap.md` 编写约定（frontmatter schema + body 约定，warnings-only）与 `residuals.json` register 生命周期（open → verified close in place、severity 枚举、provenance 字段、`_default` 回退）；schema 与 engine `project.ts` 校验器逐字一致。
- **文档同步**：README.md / README_CN.md 布局描述与工作流图更新为 v2 状态面（workflow snapshot / project register；`.mstarc` 新增 `workflow_dir` / `project_dir` 键）；routing-eval 场景集重指向 v2 产物地址。
