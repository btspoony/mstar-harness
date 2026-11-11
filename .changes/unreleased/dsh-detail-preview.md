---
category: Changed
packages: dsh
---

- **The dsh plugin gains its own plugin-detail page.** `locale/en.json` and `locale/zh.json` add `meta.detail` (`docs/DETAIL.md` / `docs/DETAIL.zh.md`), and each document renders a new product illustration (`docs/preview.svg` / `preview.zh.svg`) of the plugin inside a dsh session: the `mstar-engine` status row, a refused `mstar_plan_bind`, the `mstar_audit_validate` credential scan, and the Morning Star Workflow sidebar panel.
- The illustration names only shipped surfaces: the model-visible `mstar-engine` catalog row appended at `agent/pre-step`, the three native tools (`mstar_plan_bind`, `mstar_audit_validate`, `mstar_execution_clear`), and the sidebar panel transport.
- The four files ship through the package `files` list, so the installed plugin can serve the document and both images beside it.

<!-- CN -->
- **dsh 插件现在有自己的插件详情页。** `locale/en.json` 与 `locale/zh.json` 新增 `meta.detail`（`docs/DETAIL.md` / `docs/DETAIL.zh.md`），两份文档各自渲染一张新的产品介绍图（`docs/preview.svg` / `preview.zh.svg`），展示插件在 dsh 会话中的样子：`mstar-engine` 状态行、被拒绝的 `mstar_plan_bind`、`mstar_audit_validate` 凭据扫描，以及右侧栏「晨星工作流」面板。
- 插图只标注真实交付的面：`agent/pre-step` 注入的模型可见 `mstar-engine` 目录行、三个原生工具（`mstar_plan_bind`、`mstar_audit_validate`、`mstar_execution_clear`），以及侧栏面板的传输。
- 这四个文件通过包的 `files` 列表发布，安装后的插件可在文档旁提供两张图片。
