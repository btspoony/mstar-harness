---
category: Harness
packages: root, cli, engine, commands, dsh
---

- **Milestone mechanism** in the project store: `mstar milestone add|update|assign` write milestone metadata and the sole issue association under store-revision CAS; read-only `list`/`status` expose open/resolved/other-retired rollups. Delivery is an explicit status change that requires at least one linked issue and zero open ones.
- **Composed roadmap surfaces**: `mstar roadmap export` (JSON v2 / grouped Markdown) and the roadmap dashboard render milestones — target, status, linked issues and counts — alongside the retained Direction; they work without Markdown content and never modify milestone records.
- **Governance wording** now references milestones: the Durable Roadmap Gate accepts a milestone ID plus linked-issue acceptance/owner/dependency/trigger evidence, and retired `roadmap.md` stubs remain history/import transport only.
- **Project roadmap authority** now lives in the project store record, not a live `roadmap.md`: CLI, dashboard and dsh read the same content; a known project with no roadmap is reported explicitly.
- **Roadmap authoring** uses read-only import preview and reviewed apply, revision-guarded replacement, and Markdown/JSON transport export. Harness scaffold registers `_default` without writing roadmap Markdown; legacy files remain import candidates or history.
- **Iteration close** reads the stored roadmap, exports an independent candidate and replaces it against observed revisions instead of editing a live project roadmap file. Runtime guidance now points to one governance rule home.
- Fixed roadmap CLI discovery, import-preview round-tripping, dashboard absence handling, and legacy roadmap migration disclosure without creating a second authority.
- Refused worktree cleanup when ignored files would be lost; refreshed the committed hook bundle and migration/scaffold expectations.
- Corrected roadmap dashboard and project-rollup absence messages, and updated migration-6 test expectations.
- Read dsh project roadmap milestones from the store authority and disclose absent, partial, and unavailable roadmap coverage in the panel.
- Restored catalog facts in roadmap views, clarified the empty project rollup message, and retained migration steps in successful JSON output.
- Added the read-only local dashboard: `mstar dashboard` serves the issue list/detail with recorded history, the workflow / iteration / roadmap views and one cumulative captured-vs-retired issue-flow chart on `127.0.0.1` (loopback only, no bind option), from the issue store and the lazy execution/roadmap projections. The dashboard never mutates; unknown historical dates are disclosed and counted separately, pre-store buckets are labelled register history, and the issue-flow chart is paired with an accessible data table.
- **Dashboard roadmap is now a milestone board**: the roadmap page lays each project's milestones out as columns (one column per milestone, in store ordinal order) with that milestone's assigned issues as the items inside it — mono id, disposition badge and stored title — instead of the previous vertical card list. The project's unassigned issues appear as an explicit, named trailing column; the count is named on the no-milestones branch too, so it is never silently dropped.
- **Direction demoted below the board**: the content authority's Direction and the stored historical document now render as collapsed sections under the board, each keeping its own heading and its existing "content authority ≠ milestone data" wording. Catalog facts and the store/projection freshness block are unchanged, and a refused roadmap read still renders its notice — never an empty board, never the empty-milestones state.
- **Dashboard roadmap entry is projects-first**: opening `#roadmap` without a `?project=` now lists every catalog project (title, id, lifecycle, open-issue count) and each entry links into that project's read-only roadmap, replacing the "add the project to the URL" dead end.
- **New `projects` dashboard read view** end to end: engine `DashboardView` + `ProjectListDTO`/`ProjectListItem` (complete, deliberately unpaged read over the catalog table with an open-issue count), the param-free `/api/projects` transport route, and the regenerated offline dashboard bundle.

<!-- CN -->
- **里程碑机制**落进项目存储：`mstar milestone add|update|assign` 在 store revision CAS 下写 milestone 元数据与唯一的 issue 关联；只读 `list`/`status` 提供 open / resolved / other-retired rollup。交付是显式状态变更，要求至少一个关联 issue 且零 open。
- **组合式路线图面**：`mstar roadmap export`（JSON v2 / 分组 Markdown）与 roadmap 仪表盘在保留 Direction 的同时渲染 milestone（目标、状态、关联 issue、计数）；无 Markdown 正文也可用，且从不修改 milestone 记录。
- **治理措辞**改为引用 milestone：Durable Roadmap Gate 接受 milestone ID + 关联 issue 的 acceptance / owner / dependency / trigger 证据；退役的 `roadmap.md` stub 仅作历史 / 导入传输。
- **项目路线图权威**现为项目存储记录，而非实时 `roadmap.md`：CLI、仪表盘和 dsh 读取同一正文；已知项目无路线图时明确报告缺失。
- **路线图编写**采用只读导入预览与审核后应用、受版本保护的整份替换，以及 Markdown/JSON 传输导出。初始化仅登记 `_default`，不写路线图 Markdown；遗留文件仅作导入候选或历史。
- **迭代收口**读取存储中的路线图，导出独立候选并按已观察版本替换，不再编辑实时项目路线图文件。运行时指引统一指向项目治理规则。
- 修复路线图 CLI 发现、导入预览往返、仪表板缺失状态处理及旧版路线图迁移披露，且未创建第二内容权威。
- 当忽略文件可能丢失时拒绝清理 worktree；刷新已提交的 hook bundle 及迁移/脚手架预期。
- 修正路线图仪表板与项目汇总的缺失提示，并更新迁移 6 的测试预期。
- dsh 从 store 权威读取项目路线图里程碑，并在面板中披露缺失、部分与不可用的路线图覆盖。
- 恢复路线图视图中的目录事实，修正空项目汇总提示，并在成功的 JSON 迁移输出中保留步骤列表。
- 新增只读本地看板：`mstar dashboard` 仅在 `127.0.0.1` 上（仅回环绑定，无 bind 选项）提供 issue 列表/详情（含真实记录历史）、workflow / iteration / roadmap 视图，以及一张累计捕获 vs 退役的 issue-flow 图表；数据源为 issue store 与惰性刷新的执行/roadmap 投影。看板不做任何变更；未知历史日期会被披露并单独计数，store 之前的桶标记为 register history，issue-flow 图表附带可访问的数据表格。
- **Dashboard roadmap 改为里程碑看板**：roadmap 页面按 store 的 ordinal 顺序为每个里程碑渲染一列，列内即该里程碑已关联的 issue 条目（mono id、disposition 徽标、存储标题），取代原先的纵向卡片列表。项目的未分配 issue 以显式命名的尾列呈现；在没有里程碑的分支上也会写出计数，不会静默丢弃。
- **Direction 降级到看板下方**：内容权威的 Direction 与存储的历史文档改为看板下方的折叠区块，各自保留标题与原有“内容权威 ≠ 里程碑数据”的措辞。Catalog 事实与 store/projection 新鲜度区块保持不变；roadmap 读取被拒绝时仍渲染其通知——既不渲染空看板，也不进入"无里程碑"状态。
- **Dashboard roadmap 入口改为 projects-first**：不带 `?project=` 打开 `#roadmap` 时列出全部 catalog 项目（标题、id、生命周期、open issue 数），每项链接进入该项目的只读 roadmap，取代原先"手动改 URL"的死路。
- **新增 `projects` dashboard 读视图**（端到端）：engine `DashboardView` + `ProjectListDTO`/`ProjectListItem`（对 catalog 表的完整、刻意不分页读取，含 open issue 计数）、零查询参数的 `/api/projects` 传输路由，以及重新生成的离线 dashboard 资产包。
