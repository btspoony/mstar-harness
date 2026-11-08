---
category: Harness
packages: root
---

- The corpus probe `rg -n "\bno longer\b|\bused to\b|\bformerly\b|\bretired\b|\bis gone\b|\bthe former\b" skills/` now returns 57 lines instead of 67, and every remaining line is accounted for in `{ITERATION_DIR}/<iteration-id>/guides/prose-sweep.md` as edited, already-clear or kept-with-reason.
- Fourteen paragraphs across eight files lost their change narration while keeping every proposition: `mstar-audit/references/pr-review.md` (the review `body` follows the report template; the per-PR concurrency model stands alone; posting is Stage 3 consistently; the backlog verbs refuse without a history framing), `mstar-host/references/omp.md` (the shell-route refusal and the terminal-workflow notice state present behavior, with the per-call env-revision and cross-host asides gone), `mstar-artifacts/SKILL.md` (the migration bullet is the read-only contract plus a pointer, not a second copy of the shapes reference), plus `plan-workflow-lifecycle-contract.md`, `opencode.md`, `mstar-knowledge/SKILL.md`, `checks-and-lints.md` and `status-and-registers.md`.
- Three of the six passages the plan named were already cleared by the host-reference extraction: `dsh.md`'s twelve-tool archaeology (`d0838b65`), its `engineStatus` read-method narration (`ac20583f`), and `mstar-engine-legacy/references/status-field-history.md` (`b008fdea`, merged into `mstar-project-governance/references/migration-source-shapes.md`). They are recorded with that evidence rather than re-edited.
- A `kept` verdict is the normal terminal state here, not a leftover: an engine refusal code (`migrate.verb-retired`, `persist.kind-retired`, `compound.index.retired`), a migration-surface lifecycle label, a runtime state a binding reports, and an audit category all stay, because deleting them would drop a guarantee the reader relies on at HEAD.

<!-- CN -->
- 语料探针 `rg -n "\bno longer\b|\bused to\b|\bformerly\b|\bretired\b|\bis gone\b|\bthe former\b" skills/` 从 67 行降到 57 行，剩余每一行都在 `{ITERATION_DIR}/<iteration-id>/guides/prose-sweep.md` 中登记为 edited / already-clear / kept-with-reason。
- 八个文件共十四个段落去掉了变更叙述而保留全部命题：`mstar-audit/references/pr-review.md`（review `body` 遵循报告模板；单 PR 并发模型自足；posting 归 Stage 3 且三处规则一致；backlog 动词直接拒绝）、`mstar-host/references/omp.md`（shell 路由拒绝与 terminal workflow 通知改为现在时，删去 per-call env revision 与跨宿主旁注）、`mstar-artifacts/SKILL.md`（迁移条目收敛为只读契约 + 指针，不再复述 shapes 参考），以及 `plan-workflow-lifecycle-contract.md`、`opencode.md`、`mstar-knowledge/SKILL.md`、`checks-and-lints.md`、`status-and-registers.md`。
- 计划点名的六处中有三处已被宿主参考抽取清除：`dsh.md` 的十二工具考古（`d0838b65`）、其 `engineStatus` 读方法叙述（`ac20583f`）、以及 `mstar-engine-legacy/references/status-field-history.md`（`b008fdea`，已并入 `mstar-project-governance/references/migration-source-shapes.md`）。这些以证据登记为 already-clear，而非重做一遍。
- 此处的 `kept` 是正常终态而非遗留：引擎拒绝码（`migrate.verb-retired`、`persist.kind-retired`、`compound.index.retired`）、迁移面生命周期标签、绑定在运行期报告的状态、以及审计类别都应保留，删掉它们等于丢掉读者在 HEAD 依赖的保证。
