---
category: Added
packages: root
---

- Added the **`decision_record` case spec field `forbidProse`**: a case-authored list of literal phrases that state the forbidden decision in prose. A reply whose machine-readable record is correct but whose sentence still says "The iteration is delivered" now grades `fail`; a missing record still grades `unverified`. Matching is a literal, case-insensitive phrase check on normalised whitespace — no proximity window and no judge call.
- Applied `forbidProse` to the four close cases that carry a decision record, with phrases drawn from each case's own forbidden decision. Each list is bilingual (the corpus prompts are Chinese) and each fixture now discloses its literals, so a reply must not reproduce them even to deny them — a refusal that avoids them passes, one that quotes them fails, and no negation heuristic is involved.
- `readDecisionRecord` now rejects a record that is not a flat object of string values, or that repeats a key (`JSON.parse` keeps only the last): such a record grades `unverified`, never `pass`. An empty record (`DECISION: {}`) is not rejected — it is a recorded decision carrying no field, so it grades `fail` with one missing-field violation per declared field rather than being masked as missing evidence. `scripts/skill-eval/runner.test.ts` is gated in CI so these assertions run.

<!-- CN -->
- 新增 **`decision_record` case spec 字段 `forbidProse`**：由 case 作者逐条列出的字面短语，用来捕捉散文里的禁止决定。机器可读记录正确、但正文仍写“迭代已交付”的回复现在判 `fail`；缺记录仍是 `unverified`。匹配是字面、大小写不敏感的短语检查，仅归一化空白——不做邻近窗口、不调用 judge。
- 对四个已带 decision record 的 close case 应用 `forbidProse`，短语取自该 case 自身声明的禁止决定。列表为双语（语料 prompt 是中文），且每个 fixture 现在会公开自己的字面短语：回复即使为了否认也不得复述，避免复述即通过、复述即失败，全程不涉及否定启发式。
- `readDecisionRecord` 现在拒绝非扁平、非纯字符串值的记录，以及重复键的记录（`JSON.parse` 只保留最后一个值）：这类记录判 `unverified`，绝不 `pass`。空记录（`DECISION: {}`）不被拒绝：它是“已记录但未带任何字段”的决定，因此判 `fail`，每个声明字段各记一条缺失，而不会被当作缺失证据掩盖。`scripts/skill-eval/runner.test.ts` 已纳入 CI 门禁，这些断言因此会真正执行。
