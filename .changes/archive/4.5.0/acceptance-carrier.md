---
category: Harness
packages: engine, commands, root
---

- **Acceptance carrier rename:** the completion payload member is now `acceptance: {gate, decision, report}` (was `qa`), the prepare flag is `--acceptance-gate` (was `--qa-gate`), and the emitted evidence label is `acceptance.report`. The gate value stays `pm-acceptance`. Stored completions written as `qa` still validate and read through one read-side acknowledgement; new submissions carrying `qa` are refused with a message naming `acceptance`. The prepared configuration's stored `qa_gate` key is unchanged, and no alias flag exists.
- **Touched surfaces:** the owning skill prose (`mstar-artifacts`, `mstar-roles` PM references, `mstar-use-cli`), the iteration and project-governance references (`mstar-iteration/references/phase-2-worktree-lease.md`, `mstar-project-governance/references/migration-source-shapes.md`), `docs/commands.md` / `docs/runtime-reference.md`, the regenerated ZCode hook bundles (`hooks/session-context.mjs`, `hooks/mstar-write-gate.mjs`, built with the pinned Bun 1.4.0), and a knowledge-corpus cleanup that leaves current practice only — historical `## Source` provenance and `QA gate` labels are gone from the affected pages.

<!-- CN -->
- **Acceptance 承载改名：** 完成载荷成员现为 `acceptance: {gate, decision, report}`（原 `qa`），prepare 参数为 `--acceptance-gate`（原 `--qa-gate`），发出的证据标签为 `acceptance.report`。gate 取值仍为 `pm-acceptance`。已存为 `qa` 的完成记录仍可通过读取侧的单一兼容点校验与读取；携带 `qa` 的新提交会被拒绝，并在消息中指明 `acceptance`。prepared 配置中存储的 `qa_gate` 键不变，且不提供别名参数。
- **受影响面：** 归属 skill 正文（`mstar-artifacts`、`mstar-roles` PM 参考、`mstar-use-cli`）、迭代与项目治理参考（`mstar-iteration/references/phase-2-worktree-lease.md`、`mstar-project-governance/references/migration-source-shapes.md`）、`docs/commands.md` / `docs/runtime-reference.md`、重新生成的 ZCode hook bundle（`hooks/session-context.mjs`、`hooks/mstar-write-gate.mjs`，以固定版本 Bun 1.4.0 构建），以及知识库清理：受影响页面只保留现行做法，历史的 `## Source` 溯源与 `QA gate` 标签已移除。
