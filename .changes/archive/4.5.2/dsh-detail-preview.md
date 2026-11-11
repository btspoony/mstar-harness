---
category: Changed
packages: dsh
---

- **The dsh plugin gains its own plugin-detail page.** `locale/en.json` and `locale/zh.json` add `meta.detail` (`docs/DETAIL.md` / `docs/DETAIL.zh.md`), and each document renders a new product illustration (`docs/preview.svg` / `docs/preview.zh.svg`): the delivery process inside a session (PM plan, executor on a feature branch, three independent QC seats, PM Acceptance to merge-ready) beside the Morning Star Workflow sidebar panel with open items, issue flow and iteration progress.
- The illustration names only what ships: the session-side delivery roles, the sidebar panel, and the engine that records plans, reviews and acceptance. `package.json` ships the two documents and the two images and exposes them under `./docs/*`.
- No README change belongs to this part of the change set.

<!-- CN -->
- **dsh 插件现在有自己的插件详情页。** `locale/en.json` 与 `locale/zh.json` 新增 `meta.detail`（`docs/DETAIL.md` / `docs/DETAIL.zh.md`），两份文档各自渲染一张新的产品介绍图（`docs/preview.svg` / `docs/preview.zh.svg`）：会话内的交付流程（PM 计划、executor 在功能分支上实现、三个独立 QC 席位、PM Acceptance 到 merge-ready），旁边是列出未关闭项、问题走势与迭代进度的「晨星工作流」侧栏面板。
- 插图只标注真实交付的内容：会话侧的交付角色、侧栏面板，以及把计划、审查与验收留成记录的 engine。`package.json` 发布两份文档与两张图片，并通过 `./docs/*` 暴露它们。
- 本部分变更不涉及 README。
