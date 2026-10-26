---
category: Harness
packages: root, cli
---

- Added the **card primitive** to `@mstar-harness/ui` (`Panel`, `PanelHead`, `PanelBody`, `PanelFoot`) and put every list screen inside it: the dashboard's Issues screen is now the filter card **and** the table card, and Overview, Workflows, Iterations and Projects are cards instead of bare sections. The surface, the hairline border, `--ms-radius-md` and the head/body/foot insets come from the prototype's own rules rather than from each screen. The frame around the screens (max width, gutter, title scale) lives in the shared base layer, and **both** hosts that mount these screens now anchor it: the dashboard on its root and the dsh panel on its product scroller — the dsh seat had none, so its screens rendered unframed.
- Added the **summary line** above the table — result count, the **selected** disposition with its project scope, and the ordering, in one sentence — and the short list-cell date (`10-24 09:06`) from one formatter, `formatShortDate`. The project span is stated only when the page holds the whole result set: a partial page cannot count projects it never saw.
- Replaced the shell's two native `<select>`s with the prototype's **segmented language group** and **theme icon button**: real buttons, labelled from the dictionary, `aria-pressed` for state, and two icon shapes instead of a colour swatch, so the choice survives forced colours. Both wrap at narrow widths instead of disappearing.
- Unified the timestamp form: one formatter (`formatDate`) prints `2026-10-23 09:14` everywhere a timestamp appears — detail lines included — while list cells drop the year and the seconds.
- Added the **render gate** (`packages/cli/test/render-gate.test.ts`): it starts the dashboard on an ephemeral port, drives a real browser over the five destinations and a detail screen at a fixed viewport, writes the PNGs under `.tmp/render-gate/`, and asserts the cards, the summary line, the dot-only tone rule, the header control pair and the date form. It skips cleanly when no browser is on `PATH` (`Bun.which("agent-browser")`), so no CI job depends on one.

<!-- CN -->
- 在 `@mstar-harness/ui` 中新增**卡片原语**（`Panel`、`PanelHead`、`PanelBody`、`PanelFoot`），并把每个列表屏放进卡片：dashboard 的 Issues 屏现在是筛选卡片**加**表格卡片，Overview、Workflows、Iterations、Projects 也从裸 section 变成卡片。表面、发丝边框、`--ms-radius-md` 以及头部/主体/底栏的内边距都取自原型自身的规则，而不是各屏各写一套。屏幕外围的框架（最大宽度、内边距、标题字号）位于共享基础层，**两个**挂载这些屏幕的宿主现在都提供它的锚点：dashboard 在根元素上，dsh 面板在产品滚动区上 —— 此前 dsh 侧席没有该锚点，屏幕因此完全没有框架。
- 在表格上方新增**摘要行**：结果数、**当前选中的处置状态**及其项目范围、排序合成一句；列表单元格改用同一个格式化器 `formatShortDate` 输出短日期（`10-24 09:06`）。只有在整页持有完整结果集时才声明项目跨度 —— 部分结果页不能统计它从未见到的项目。
- 用原型的分段式**语言组**与**主题图标按钮**替换外壳里的两个原生 `<select>`：都是真正的按钮，文案来自词典，用 `aria-pressed` 表达状态，并靠两种图标形状而非色块区分，因此在强制颜色模式下仍然可用。窄宽度下换行而不是消失。
- 统一时间戳形式：同一个格式化器（`formatDate`）在所有出现时间戳的地方输出 `2026-10-23 09:14`，详情行同样如此；列表单元格则省略年份与秒。
- 新增**渲染门**（`packages/cli/test/render-gate.test.ts`）：在临时端口启动 dashboard，用真实浏览器以固定视口走完五个目的地与一个详情屏，把 PNG 写入 `.tmp/render-gate/`，并断言卡片、摘要行、状态只用色点表达、头部控件成对存在以及日期形式。当 `PATH` 上没有浏览器时（`Bun.which("agent-browser")`）干净跳过，因此没有任何 CI 作业依赖浏览器。
