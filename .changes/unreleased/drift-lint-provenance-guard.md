---
category: Harness
packages: root
---

- Added a **provenance guard** to drift-lint: the repo text face (`.md` full text, `.ts` comment lines only) is scanned with the engine provenance finder, and any dated plan/iteration id or dated local-harness deeplink now fails CI with a `file:line` row. Assembled release surfaces (`.changes/archive/`, `CHANGELOG*.md`) are exempt as historical record.

<!-- CN -->
- drift-lint 新增**溯源门禁**：对仓库文本面（`.md` 全文、`.ts` 仅注释行）运行引擎溯源发现器，任何带日期的 plan/迭代 ID 或本地 harness 深链都会以 `file:line` 行形式使 CI 失败；已装配的发布面（`.changes/archive/`、`CHANGELOG*.md`）作为历史记录豁免。
