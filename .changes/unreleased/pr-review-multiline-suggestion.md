---
category: Added
packages: root, engine, commands, opencode
---

- PR-review inline comments may now anchor a finding to a contiguous `RIGHT` line range (`start_line` + `start_side` alongside `line`): the optional GitHub `suggestion` block replaces exactly that anchored range, and the repair stays limited to one file, one hunk, mechanically safe and only after reading the surrounding code. A single-line finding's payload is unchanged.
- `pr-review post` passes `start_line` / `start_side` through to the Reviews API and refuses a range that is not contiguous or whose sides differ; the at-most-once 422 fold still treats each inline body as one unit.

<!-- CN -->
- PR 审查 inline 评论现可把 finding 锚定到一段连续的 `RIGHT` 行区间（`line` 之外再加 `start_line` + `start_side`）：可选的 GitHub `suggestion` 块正好替换该区间，且仍限单文件、单 hunk、机械安全，并须先阅读周边代码；单行 finding 的 payload 不变。
- `pr-review post` 会把 `start_line` / `start_side` 传给 Reviews API，并拒绝不连续或两侧不一致的区间；最多一次的 422 折叠仍把每条 inline 正文当作一个整体处理。
