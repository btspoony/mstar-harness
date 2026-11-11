---
category: Changed
packages: dsh
---

- **The dsh plugin gains its own plugin-detail page.** `locale/en.json` and `locale/zh.json` add `meta.detail` (`docs/DETAIL.md` / `docs/DETAIL.zh.md`), and each document renders a new Archify illustration (`docs/preview.svg` / `docs/preview.zh.svg`) — theme-aware through `prefers-color-scheme`, script-free, no external references.
- The illustration names only shipped surfaces: the model-visible `mstar-engine` catalog row appended at `agent/pre-step`, the three native tools (`mstar_plan_bind`, `mstar_audit_validate`, `mstar_execution_clear`), the Morning Star Workflow right-sidebar tab, and the workspace harness state under `{HARNESS_DIR}` they read and write.
- The four files ship through the package `files` list, so the installed plugin can serve the document and both images beside it.

<!-- CN -->
- **dsh 插件现在有自己的插件详情页。** `locale/en.json` 与 `locale/zh.json` 新增 `meta.detail`（`docs/DETAIL.md` / `docs/DETAIL.zh.md`），两份文档各自渲染一张新的 Archify 插图（`docs/preview.svg` / `docs/preview.zh.svg`）——通过 `prefers-color-scheme` 适配明暗主题，无脚本、无外部引用。
- 插图只标注真实交付的面：`agent/pre-step` 注入的模型可见 `mstar-engine` 目录行、三个原生工具（`mstar_plan_bind`、`mstar_audit_validate`、`mstar_execution_clear`）、右侧栏「晨星工作流」标签页，以及它们读写、位于 `{HARNESS_DIR}` 下的工作区 harness 状态。
- 这四个文件通过包的 `files` 列表发布，安装后的插件可在文档旁提供两张图片。

