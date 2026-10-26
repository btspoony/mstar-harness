---
category: Harness
packages: root, cli, dsh
---

- Fixed **every container query in the product being dead**. The CSS-module pass
  rewrites a named query's prelude into a per-module hash
  (`@container pane_8f31a`), while the single `container: pane / inline-size`
  declaration stays in the global sheet under the plain name, so nothing matched and
  the 400–900px pane rendered the wide layout squeezed. Component and screen queries
  are now **unnamed** (`@container (max-width: 619px)`); the collapse, the
  two-column fold and the chrome stacking all work again. `build-web.test.ts` asserts
  the emitted artifact carries no named container query, and the component-layer suite
  asserts no module writes one.
- Gave the **list tables declared column widths**. `table-layout: fixed` split an
  undeclared column set evenly, so eight columns of ~90px each rendered `I-…`, `d…`
  and `● runningplan…`; and the collapse rule's positional 20%/80% widths zeroed the
  *third* primary column on screens that have one. Each list now declares a px width
  for every column but the title (which takes the remainder), `DataTable` computes a
  floor of *declared + 120px*, the card body scrolls inside itself rather than
  squeezing a column below its identity, and the collapsed form hides secondary
  columns by rule with their facts on the row's second line. The `<colgroup>` is gone
  so a hidden column leaves no width behind it. Measured at a 400px container: narrowest
  cell 80–112px, zero truncated cells, no page overflow.
- Added the **pane frame** to the shared layer (`MS_PANE_HEAD_CLASS`,
  `MS_PANE_BODY_CLASS`): the prototype's surface band closed by a hairline, and the
  body's closing inset. The dsh seat mounts both inside its pane (the tab strip stays
  the pane's top edge), and the dashboard's window header is the same band — its
  `currentColor` border is now the shared hairline. `DESIGN.md` records the narrow-band
  decision: the prototype defines no narrow list, so the product chooses priority
  columns below 619px, declared widths above it, and a scroll floor as the net.
- Made the collapsed second line the **same activation target** as its record: it now carries
  the row's pointer handler, hover and cursor, while the tab stop and the key handler stay on
  the main row, so keyboard order is still one stop per record. `DESIGN.md` records what the
  extra `<tr>` costs (a screen reader hears two rows per record) and where it stops (list
  variant, below 620px, one spanned cell, facts non-interactive).
- Extended the **render gate** to the bands that were never tested: 760px and 420px
  for all five destinations, asserting no squeezed cell, a card that fills its
  container, a title that is not truncated, prose that wraps at 10+ characters per
  line, reachable and labelled header controls, no page overflow, and — the anchor that
  separates a real collapse from an overflow — no sideways scroll inside the table's
  card. One catalog iteration is seeded so the Iterations screen has a table to squeeze.

<!-- CN -->
- 修复**产品中所有容器查询失效**的问题。CSS Module 打包会把具名查询的前导改写成按模块哈希的名字（`@container pane_8f31a`），而唯一的 `container: pane / inline-size` 声明仍以原名留在全局样式表里，于是没有任何规则命中，400–900px 面板实际渲染的是被压扁的宽布局。组件与屏幕里的查询现在一律**不具名**（`@container (max-width: 619px)`），折叠、两栏折叠与 chrome 堆叠全部恢复。`build-web.test.ts` 断言产物中不存在具名容器查询，组件层套件断言没有模块写出具名查询。
- 为**列表表格声明列宽**。`table-layout: fixed` 会把未声明的列均分，八列各约 90px 于是渲染成 `I-…`、`d…` 与 `● runningplan…`；折叠规则里的 20%/80% 位置宽度还会让存在第三个主列的屏幕把该列压成零宽。现在每个列表为除标题外的列声明 px 宽度，标题列占剩余空间；`DataTable` 计算 *已声明宽度 + 120px* 的下限，卡片主体在自身内部横向滚动而不是把某列压到看不清身份，折叠态按规则隐藏次要列并把事实放到行的第二行。`<colgroup>` 已移除，被隐藏的列不再留下宽度。400px 容器实测：最窄单元格 80–112px，截断单元格为 0，页面无横向溢出。
- 在共享层新增**面板框架**（`MS_PANE_HEAD_CLASS`、`MS_PANE_BODY_CLASS`）：原型中以发丝线收口的表面带，以及主体底部的内边距。dsh 侧席在面板内同时挂载两者（标签条仍是面板的顶边），dashboard 的窗口头部就是同一个带 —— 它原来的 `currentColor` 边框改为共享发丝线。`DESIGN.md` 记录了窄带决策：原型没有定义窄列列表，因此产品选择在 619px 以下使用优先列、其上使用声明列宽，并以滚动下限作为兜底。
- 折叠行的第二行现在是该记录的**同一个激活目标**：它带上主行的指针处理器、悬停与光标，而 tab 停靠点与键盘处理器仍只在主行，键盘顺序依旧一条记录一站。`DESIGN.md` 记录了多出的 `<tr>` 的代价（读屏把每条记录读成两行）与边界（仅列表变体、仅 620px 以下、单个跨列格、事实本身非交互）。
- 把**渲染门**扩展到此前从未被测的宽度：五个目的地各测 760px 与 420px，断言没有单元格被压到不可读、卡片填满容器、标题不被截断、正文每行至少 10 个字符、头部控件可达且有可访问名称、页面无横向溢出，以及区分「真折叠」与「溢出」的关键锚点 —— 表格卡片内部不得横向滚动。同时播种一条 catalog iteration，使 Iterations 屏有真实表格可压。
