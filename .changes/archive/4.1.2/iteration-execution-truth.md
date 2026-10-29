---
packages: engine,cli
---

- Iteration dashboard reads now tell the execution truth: `IterationDTO` carries `executionLifecycle` (`active` / `completed` / `stopped` / `failed` / `none`), derived from the iteration workflow instead of the catalog row, and `projects` lists every linked project.
- Iteration plan membership is the union of the compass frontmatter `plans:` ids and the catalog `plan belongs-to iteration` links, de-duplicated and sorted; a declared plan missing from the catalog stays visible with its `catalog-missing` badge. No link-backfill migration ships — the read union is the membership record, and `mstar catalog reconcile` is unchanged.
- The projection now also covers terminal **iteration** workflows, so finished iterations answer their execution state instead of "no execution"; terminal plan workflows do not widen the projection and the workflows list keeps its active-registration membership. A projection format bump rebuilds the published generation on the next read (store schema gains migration 14, `compass-plan-membership`).
- `mstar iteration register --project` is repeatable: each occurrence publishes one `iteration belongs-to project` catalog link (the project must already be registered — the catalog refuses dangling relations), and the first value stays the snapshot's project record. Later add/remove uses the existing `mstar catalog link` family. Iteration registration now also registers its plan rows as catalog plan entities, because the membership links may not dangle.
- New engine writer `removeMilestone` removes an empty milestone and refuses `milestone.not-empty` (naming the reassignment recovery) while issues remain. No new CLI verb family.

<!-- CN -->
- 迭代仪表盘读取现在如实反映执行状态：`IterationDTO` 新增 `executionLifecycle`（`active` / `completed` / `stopped` / `failed` / `none`，由迭代工作流而非 catalog 行派生）与 `projects`（全部已关联项目）。
- 迭代计划成员关系取 compass frontmatter `plans:` 与 catalog `plan belongs-to iteration` 链接的去重并集；compass 声明但 catalog 缺失的计划以 `catalog-missing` 徽标显式呈现。不提供链接回填迁移——读取并集即成员关系记录，`mstar catalog reconcile` 不变。
- 投影现在覆盖终态的**迭代**工作流，已结束迭代能回答其执行状态；终态 plan 工作流不扩宽投影，workflows 列表保持 active 注册成员语义。投影格式版本升级会在下次读取时重建发布代（store schema 新增 migration 14 `compass-plan-membership`）。
- `mstar iteration register --project` 支持重复传参：每个取值发布一条 `iteration belongs-to project` catalog 链接（项目须已注册——catalog 拒绝悬空关系），首个取值仍写入快照的 project 记录。后续增删使用既有 `mstar catalog link` 命令族。迭代注册同时会把 plan 行注册为 catalog plan 实体（成员链接不得悬空）。
- 引擎新增 `removeMilestone` 写入器：删除空里程碑；里程碑仍有 issue 时拒绝 `milestone.not-empty` 并给出改派恢复路径。不新增 CLI 命令族。
