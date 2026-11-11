---
category: Changed
packages: dsh
---

- **The dsh plugin gains its own plugin-detail page.** `locale/en.json` and `locale/zh.json` add `meta.detail` (`docs/DETAIL.md` / `docs/DETAIL.zh.md`), and each document renders a new product illustration (`docs/preview.svg` / `docs/preview.zh.svg`) of the plugin's core: the Morning Star delivery process in the session (PM plan, three independent QC seats, executor, PM Acceptance to merge-ready) and the Morning Star Workflow sidebar panel with open items and issue flow.
- The illustration names only shipped surfaces: the model-visible `mstar-engine` catalog row appended at `agent/pre-step`, the three native tools, and the sidebar panel reading the same workspace state the CLI writes.
- The four files ship through the package `files` list, so the installed plugin can serve the document and both images beside it.

<!-- CN -->
- **dsh 插件现在有自己的插件详情页。** `locale/en.json` 与 `locale/zh.json` 新增 `meta.detail`（`docs/DETAIL.md` / `docs/DETAIL.zh.md`），两份文档各自渲染一张新的产品介绍图（`docs/preview.svg` / `docs/preview.zh.svg`），介绍插件的核心：会话中的 Morning Star 交付流程（PM 计划、三个独立 QC 席位、executor、PM Acceptance 到 merge-ready），以及列出未关闭项与问题走势的「晨星工作流」侧栏面板。
- 插图只标注真实交付的面：`agent/pre-step` 注入的模型可见 `mstar-engine` 目录行、三个原生工具，以及读取同一份 CLI 写入的工作区状态的侧栏面板。
- 这四个文件通过包的 `files` 列表发布，安装后的插件可在文档旁提供两张图片。
