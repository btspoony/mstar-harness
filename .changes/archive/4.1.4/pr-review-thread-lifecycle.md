---
category: Harness
packages: root
---

- Added a **thread lifecycle** to the PR review contract: after a re-review POST, threads of findings revalidated as `fixed` are resolved and earlier review bodies from the flow are folded behind a pointer to the newest review; still-open findings keep their inline threads untouched.
- Updated `mstar-audit/references/pr-review.md` (new § Thread lifecycle, Procedure step, output counters) and `mstar-pr-loop/SKILL.md`.

<!-- CN -->
- PR review 合同新增**线程生命周期**：re-review POST 成功后，解决被复核为 `fixed` 的发现的 review thread，并把本流程此前的 review 正文折叠为指向最新 review 的一行指针；仍未解决的发现保持其 inline 线程原样可见。
- 更新 `mstar-audit/references/pr-review.md`（新增 § Thread lifecycle、Procedure 步骤、输出计数）与 `mstar-pr-loop/SKILL.md`。
