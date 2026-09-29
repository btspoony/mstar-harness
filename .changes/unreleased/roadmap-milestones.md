---
category: Harness
packages: root, cli, commands, engine
---

- **Milestone mechanism** in the project store: `mstar milestone add|update|assign` write milestone metadata and the sole issue association under store-revision CAS; read-only `list`/`status` expose open/resolved/other-retired rollups. Delivery is an explicit status change that requires at least one linked issue and zero open ones.
- **Composed roadmap surfaces**: `mstar roadmap export` (JSON v2 / grouped Markdown) and the roadmap dashboard render milestones — target, status, linked issues and counts — alongside the retained Direction; they work without Markdown content and never modify milestone records.
- **Governance wording** now references milestones: the Durable Roadmap Gate accepts a milestone ID plus linked-issue acceptance/owner/dependency/trigger evidence, and retired `roadmap.md` stubs remain history/import transport only.

<!-- CN -->
- **里程碑机制**落进项目存储：`mstar milestone add|update|assign` 在 store revision CAS 下写 milestone 元数据与唯一的 issue 关联；只读 `list`/`status` 提供 open / resolved / other-retired rollup。交付是显式状态变更，要求至少一个关联 issue 且零 open。
- **组合式路线图面**：`mstar roadmap export`（JSON v2 / 分组 Markdown）与 roadmap 仪表盘在保留 Direction 的同时渲染 milestone（目标、状态、关联 issue、计数）；无 Markdown 正文也可用，且从不修改 milestone 记录。
- **治理措辞**改为引用 milestone：Durable Roadmap Gate 接受 milestone ID + 关联 issue 的 acceptance / owner / dependency / trigger 证据；退役的 `roadmap.md` stub 仅作历史 / 导入传输。
