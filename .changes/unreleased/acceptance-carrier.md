---
category: Harness
packages: engine, commands, root
---

- **Acceptance carrier rename:** the completion payload member is now `acceptance: {gate, decision, report}` (was `qa`), the prepare flag is `--acceptance-gate` (was `--qa-gate`), and the emitted evidence label is `acceptance.report`. The gate value stays `pm-acceptance`. Stored completions written as `qa` still validate and read through one read-side acknowledgement; new submissions carrying `qa` are refused with a message naming `acceptance`. The prepared configuration's stored `qa_gate` key is unchanged, and no alias flag exists.
- Updated the owning skill prose (`mstar-artifacts`, `mstar-roles` PM references, `mstar-use-cli`) and `docs/commands.md` / `docs/runtime-reference.md`.

<!-- CN -->
- **Acceptance 承载改名：** 完成载荷成员现为 `acceptance: {gate, decision, report}`（原 `qa`），prepare 参数为 `--acceptance-gate`（原 `--qa-gate`），发出的证据标签为 `acceptance.report`。gate 取值仍为 `pm-acceptance`。已存为 `qa` 的完成记录仍可通过读取侧的单一兼容点校验与读取；携带 `qa` 的新提交会被拒绝，并在消息中指明 `acceptance`。prepared 配置中存储的 `qa_gate` 键不变，且不提供别名参数。
- 同步更新归属 skill 正文（`mstar-artifacts`、`mstar-roles` PM 参考、`mstar-use-cli`）以及 `docs/commands.md` / `docs/runtime-reference.md`。
