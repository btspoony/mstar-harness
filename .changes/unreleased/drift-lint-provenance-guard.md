---
category: Harness
packages: root
---

- Added a **provenance guard** to drift-lint: the tracked repo text face (`.md` full text, `.ts` comment lines — leading comment lines plus trailing `//` comments, detected after masking string and template literals via the shared comment mask and with no whitespace requirement, with `://` URL sequences excluded) is scanned with the engine provenance finder, and dated plan/iteration ids or dated local-harness paths on it now fail CI with a `file:line` row. The walk intersects with `git ls-files`, so untracked local files never fail the guard (`.mstar/sdd/…` deeplinks remain under the skill-lint ephemeral check, which covers the skills corpus). Assembled release surfaces (`.changes/archive/`, `CHANGELOG*.md`) are exempt as historical record.

<!-- CN -->
- drift-lint 新增**溯源门禁**：对仓库已跟踪文本面（`.md` 全文、`.ts` 注释行——行首注释行加行尾 `//` 注释，先经共享注释掩蔽器掩蔽字符串与模板字面量再检测且不要求前置空白，`://` URL 序列除外）运行引擎溯源发现器，文本面上的带日期 plan/迭代 ID 或本地 harness 路径都会以 `file:line` 行形式使 CI 失败。遍历与 `git ls-files` 求交集，未跟踪的本地文件不会使门禁失败（`.mstar/sdd/…` 深链仍归 skill 语料的临时引用检查管辖）；已装配的发布面（`.changes/archive/`、`CHANGELOG*.md`）作为历史记录豁免。
