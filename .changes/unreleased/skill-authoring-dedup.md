---
category: Harness
packages: root
---

- **`mstar-skill-authoring` de-duplicated**: the six principles and the five-question body contract have one home (`SKILL.md`), and `references/skillsbench-authoring.md` keeps only the writer workflow, the authoring devices and the anti-patterns — it points at the parent instead of restating a principle or the body skeleton.
- The 13-line runtime alias table is now one sentence naming `lintFiveQuestion(body, "runtime")` as the owner, so no copy of the engine constant lives under `skills/`; the ship-note contract, the body-heading order and the review template each have one home, the review template shrinking to three verdict-bearing lines with the `Unconfirmed` verdict kept.
- `## Workflow` is three bullets instead of one eight-arrow line, the `## 默认 Body 结构` fence is one line naming the heading order, and the two engine-check blocks merge into one `## Engine checks` section. The skill drops from 189 to 137 lines and the reference from 154 to 75.
- `skills/mstar-roles/references/writing-specialist.md` gains the `mstar-prose` and `mstar-skill-authoring` preset members, matching the writer row the `mstar-roles` hub already lists.

<!-- CN -->
- **`mstar-skill-authoring` 去重**：六条原则与 5 问 body 契约只有一处（`SKILL.md`）；`references/skillsbench-authoring.md` 只保留 writer 流程、撰写装置与反模式——重复处改为指向父文件，不再复述原则或 body 骨架。
- 13 行的运行时别名表压缩为一句，指明引擎的 `lintFiveQuestion(body, "runtime")` 才是归属，`skills/` 下不再有引擎常量的副本；ship-note 契约、body heading 顺序与 review 模板各有一处归属，模板压到三行且保留 `Unconfirmed` verdict。
- `## Workflow` 由一条 8 箭头长句改为三条 bullet，`## 默认 Body 结构` 代码块改为一行 heading 顺序，两个 engine-check 块合并为一个 `## Engine checks` 章节。该 skill 由 189 行降至 137 行，参考文件由 154 行降至 88 行。
- `skills/mstar-roles/references/writing-specialist.md` 的 preset 成员补上 `mstar-prose` 与 `mstar-skill-authoring`，与 `mstar-roles` hub 中已有的 writer 行一致。
