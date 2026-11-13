---
category: Harness
packages: root
---

- Removed three unreferenced UI symbols: the `Breadcrumb` component (four screens render their own
  crumbs), the compiled-but-unreachable `styles/probe.ts` helper, and the public `NOT_DECLARED` string.
- Pointed the project board's milestone tone at the canonical view-model table, so an `active` milestone
  renders as an accent dot there too instead of the local table's neutral.
- Wired the iteration prepare step to `references/iteration-workspace-readme-template.md`, which had no
  inbound link while the step still asked for the document it describes.

<!-- CN -->
- **删除三个无引用 UI 符号**：`Breadcrumb` 组件（四个屏幕各自渲染面包屑）、编译但不可达的
  `styles/probe.ts`，以及公开的 `NOT_DECLARED` 字符串。
- **项目看板的里程碑配色改用 canonical 表**：`active` 里程碑不再被本地表画成中性灰，与总览一致。
- **迭代 prepare 步骤接上 `references/iteration-workspace-readme-template.md`**：该模板此前无入链，
  而步骤仍在要求产出它所描述的文档。
