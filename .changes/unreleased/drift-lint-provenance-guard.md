---
category: Harness
packages: root
---

- Added a **provenance guard** to drift-lint: the repo text face (`.md` full text, `.ts` comment lines only) is scanned with the engine provenance finder, and dated plan/iteration ids or dated local-harness paths on it now fail CI with a `file:line` row (`.mstar/sdd/…` deeplinks remain under the skill-lint ephemeral check, which covers the skills corpus). Assembled release surfaces (`.changes/archive/`, `CHANGELOG*.md`) are exempt as historical record.

<!-- CN -->
- drift-lint 新增**溯源门禁**：对仓库文本面（`.md` 全文、`.ts` 仅注释行）运行引擎溯源发现器，文本面上的带日期 plan/迭代 ID 或本地 harness 路径都会以 `file:line` 行形式使 CI 失败（`.mstar/sdd/…` 深链仍归 skill 语料的临时引用检查管辖）；已装配的发布面（`.changes/archive/`、`CHANGELOG*.md`）作为历史记录豁免。
