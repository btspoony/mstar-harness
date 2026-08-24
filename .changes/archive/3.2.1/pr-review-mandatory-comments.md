---
packages: root, opencode
---

- `/pr-deep-review` now **requires** posting a GitHub Review when a PR number exists: the `pr` variant always leaves `COMMENT`-event comments on the PR (inline comments on diff-line findings, summary body folds any already-written follow-up plans into a `<details>` section), and the output shape gains a `- comments:` field with the review URL. Posting procedure is SSOT'd in `skills/mstar-audit/references/pr-review.md` § Comment posting; `mstar-audit` Hard Rule 2 and the Audit-Mode contract now carve out only this required GitHub Review POST (Git stays read-only, no commits). `code-reviewer` gains Mode C (PR review) loading `pr-review.md`. `commands/pr-deep-review.md` drops the "optional / separate explicit step" wording. Chat-only verdict is no longer complete for PR seats.

<!-- CN -->
- `/pr-deep-review` 现在在有 PR 编号时**强制发布** GitHub Review：在 PR 上留下 `COMMENT` 事件的评论（可定位到 diff 行的发现发为行内评论，已写好的后续 plan 以 `<details>` 折叠索引并入摘要正文），输出形状新增 `comments:` 字段。发布流程 SSOT 在 `skills/mstar-audit/references/pr-review.md` § Comment posting；`mstar-audit` Hard Rule 2 与 Audit Mode 角色契约仅为此 GitHub Review POST 开例外（Git 仍只读、不提交）。`code-reviewer` 新增 Mode C（PR review，加载 `pr` 变体）。`commands/pr-deep-review.md` 删除「可选 / 单独显式步骤」措辞。仅聊天输出的结论对 PR 席位不再视为完成。
