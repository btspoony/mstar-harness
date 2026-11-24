---
category: Added
packages: root
---

- Added the **`decision_record` case spec field `forbidProse`**: a case-authored list of literal phrases that state the forbidden decision in prose. A reply whose machine-readable record is correct but whose sentence still says "The iteration is delivered" now grades `fail`; a missing record still grades `unverified`. Matching is a literal, case-insensitive phrase check on normalised whitespace — no proximity window and no judge call.
- Applied `forbidProse` to the four close cases that carry a decision record, with phrases drawn from each case's own forbidden decision.

<!-- CN -->
- 新增 **`decision_record` case spec 字段 `forbidProse`**：由 case 作者逐条列出的字面短语，用来捕捉散文里的禁止决定。机器可读记录正确、但正文仍写“迭代已交付”的回复现在判 `fail`；缺记录仍是 `unverified`。匹配是字面、大小写不敏感的短语检查，仅归一化空白——不做邻近窗口、不调用 judge。
- 对四个已带 decision record 的 close case 应用 `forbidProse`，短语取自该 case 自身声明的禁止决定。
