---
category: Harness
packages: root, engine, cli, dsh
---

- The **issue detail screen now renders the six panels the prototype has and §8.1 had removed**: `Identity keys`, `Source`, `Occurrences`, `Disposition history`, `Relations` and `Provenance`. The data was never missing — `store-read.ts` already returned `occurrences`, `transitions`, `relations`, `provenance`, `provider` and `identityKey`; the view model forwarded sixteen fields and stopped. The screen is now the prototype's two columns (`detail-grid` at `1.15fr : 1fr`, measured identical at 1440 px and collapsing to one column at 720 and 375), and its nine blocks carry the prototype's `.sec` rhythm rather than a class name that appeared in no stylesheet.
- The **relation read joins the other end's title**, so the `Title` column is the joined issue's own title instead of a permanent dash, and an unknown project states `null` dates instead of empty strings that read as recorded blanks.
- **Four class names that no stylesheet defined are gone**: `fact-block` (the issue detail's nine blocks, which had therefore lost every separator), `detail-text` (four paragraphs), `screen-sub` (the overview subtitle) and `attribution` (the iteration list's note). A new `bun run --cwd packages/ui check:classes` scans every component for a `className` literal absent from `tokens.css`, `base.css` and `product.css` and fails on one.
- The **gate track names its five steps** (`Start · Execute · Close · PR delivery · Merge ready`) — `copy.gateStepLabels` existed in both dictionaries and was read by nothing, so the track printed `step 1 of 5 … step 5 of 5` — and the **milestone counts cell reads `retired of total · N open`** (`5/14 · 9 open`), where it had rendered `resolved of total` with no tail, understating progress on every milestone with retired-but-unresolved issues.

<!-- CN -->
- **问题详情页现在渲染原型有、而 §8.1 曾移除的六个面板**：`标识键`、`来源`、`出现记录`、`处置历史`、`关联`、`溯源`。数据从未缺失——`store-read.ts` 早已返回 `occurrences`、`transitions`、`relations`、`provenance`、`provider` 与 `identityKey`，是视图模型只转发了十六个字段就停住了。该页现在是原型的两栏（`detail-grid`，`1.15fr : 1fr`，1440 px 下实测一致，720 与 375 下折叠为单栏），九个区块改用原型自己的 `.sec` 节奏，而不是一个在任何样式表里都不存在的类名。
- **关联读取会 join 出另一端的标题**，因此 `标题` 列是该 issue 自己的标题，而不再是永久破折号；未知项目以 `null` 表示日期，而不是一个读起来像「记录了一个空白日期」的空串。
- **四个样式表里不存在的类名已移除**：`fact-block`（问题详情的九个区块，因此丢掉了全部分隔线）、`detail-text`（四处段落）、`screen-sub`（概览副标题）与 `attribution`（迭代列表的说明）。新增 `bun run --cwd packages/ui check:classes`，扫描每个组件里不在 `tokens.css`、`base.css`、`product.css` 中的 `className` 字面量并使其失败。
- **gate track 现在写出五个步骤名**（`Start · Execute · Close · PR delivery · Merge ready`）——`copy.gateStepLabels` 在两份字典里都存在却无人读取，因此轨道只打印 `step 1 of 5 … step 5 of 5`；**里程碑计数单元格改为 `已退休/总数 · N 未关闭`**（`5/14 · 9 open`），原先渲染的是 `已解决/总数` 且没有尾部，使每个存在「退役未解决」issue 的里程碑进度被低估。
