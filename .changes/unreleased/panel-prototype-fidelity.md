---
category: Harness
packages: cli,ui,dsh
---

- Gave every list table the **prototype's own column widths** and made the wide pane stop
  squeezing: the Issues table at 720px cut its last column at the pane edge and rendered
  `dsh-inte…` and `imp…`. The widths now follow `design-v1.html:1196-1198` (id 86, project 128,
  kind 112, severity 100, disposition 104, last activity 116, rounded to what the product's
  identifiers need), the title absorbs the remainder, and the floor for the flexible column is
  96px instead of 120px. Measured at 720: table 678px in a 678px card, seven whole columns, the
  title the widest at 146px. The milestone column became **wide-only** (`wide: true`): hidden
  below 900px of container, never restated on the second line, because the prototype's sidebar
  shows seven columns and the eighth is what pushed the table past its card.
- Made the Overview **one vertical run of full-width sections at every width**, in the
  prototype's sidebar order (active workflow, residuals, milestones, the latest iteration)
  instead of a two-column grid whose second card squeezed prose one glyph per line at 1900px.
- Inset the **pane's head band** through the shared shell: `.ms-pane-head` carries the
  prototype's `padding-inline: 12px` nav inset (`design-v1.html:487`) on its surface + hairline,
  so the dsh pane's nav no longer touches the pane's edges. The dashboard's window header mounts
  the same class and keeps its own 20px gutter, which is what the prototype's window header
  uses. The host's tab strip stays the pane's top edge.
- Extended the render gate with the anchors those deviations would have caught: every list's
  column count and the absence of table overflow at 720px, the Overview as one full-width run at
  720 and 1900, and the head band's horizontal inset.

<!-- CN -->

- 每个列表表格采用**原型自己的列宽**，宽面板不再挤压：720px 下 Issues 表的最后一列被切在面板边缘，project 显示 `dsh-inte…`、kind 显示 `imp…`。列宽现在按 `design-v1.html:1196-1198`（id 86、project 128、kind 112、severity 100、disposition 104、last activity 116，按产品标识符所需取整），标题列吸收余量，弹性列下限由 120px 降为 96px。720 下实测：678px 表格落在 678px 卡片内，七列完整，标题最宽 146px。里程碑列改为**宽屏专属**（`wide: true`）：容器窄于 900px 时隐藏且不在第二行重述，因为原型侧栏显示七列，第八列正是把表格挤出卡片的原因。
- Overview 在任意宽度下改为**单列满宽区块的垂直序列**，顺序取自原型侧栏（进行中的工作流、未关闭遗留、里程碑、最近迭代），替换掉在 1900px 下把第二张卡的文字挤成一字一行的两列网格。
- 通过共享外壳给**面板顶部带加上内缩**：`.ms-pane-head` 在表面色与细线之上携带原型的 `padding-inline: 12px` 导航内缩（`design-v1.html:487`），dsh 面板的导航不再贴着面板边缘。dashboard 的窗口头部挂同一个类并保留自己的 20px 外边距，与原型窗口头部一致。宿主标签条仍是面板的顶边。
- 渲染门新增这些偏差本应被抓住的锚点：720px 下每个列表的列数与表格无溢出、Overview 在 720 与 1900 都是满宽单列、顶部带的水平内缩。
