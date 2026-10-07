---
category: Harness
packages: root
---

- **Dashboard roadmap entry is projects-first**: opening `#roadmap` without a `?project=` now lists every catalog project (title, id, lifecycle, open-issue count) and each entry links into that project's read-only roadmap, replacing the "add the project to the URL" dead end.
- **New `projects` dashboard read view** end to end: engine `DashboardView` + `ProjectListDTO`/`ProjectListItem` (complete, deliberately unpaged read over the catalog table with an open-issue count), the param-free `/api/projects` transport route, and the regenerated offline dashboard bundle.

<!-- CN -->
- **Dashboard roadmap 入口改为 projects-first**：不带 `?project=` 打开 `#roadmap` 时列出全部 catalog 项目（标题、id、生命周期、open issue 数），每项链接进入该项目的只读 roadmap，取代原先"手动改 URL"的死路。
- **新增 `projects` dashboard 读视图**（端到端）：engine `DashboardView` + `ProjectListDTO`/`ProjectListItem`（对 catalog 表的完整、刻意不分页读取，含 open issue 计数）、零查询参数的 `/api/projects` 传输路由，以及重新生成的离线 dashboard 资产包。
