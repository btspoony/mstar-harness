---
category: Harness
packages: root
---

- Added **`mstar workflow delivery-anchors`** — a guarded, revisable way to correct the delivery anchors a registered workflow records (`branch.source` / `branch.target`), under the workflow CAS token. `--branch-source` / `--branch-target` are independently optional (an omitted one keeps its registered value) and `--reason` is required and recorded in the operation's intent fingerprint; the write **merges into** the stored `branch` object, so members it does not name — an iteration workflow's `base` / `integration` — are preserved. This closes the gap where a mistyped anchor at registration left a plan un-completable with no supported repair.
- `mstar workflow register` now raises a **non-blocking advisory** (an ok envelope's `data.warnings`) when a `development` registration records the same value for `--branch-source` and `--branch-target`, and its `--branch-source` / `--branch-target` option help now states what those anchors mean.
- **Refusals now name their cause and their recovery** where they previously stopped at a generic message: `plan complete`'s delivery-anchor mismatch names both branch values and carries the repair path as the envelope's `recovery`; `store execution export`'s control-root refusal names the resolved target and the admitted invocations; `plan progress`'s recovery no longer misdescribes its payload as a bare status.
- **`mstar lint --type plan` no longer flags a plan's own YAML frontmatter**: a leading `---` block is skipped, so `status: Todo` is not reported as a placeholder token, while placeholder tokens in the body still are.
- **`mstar schema --command plan.progress` now publishes the `PlanProgress` payload shape** (`status` / `summary` / `evidence_paths` / optional `track_branches`) instead of an open object.

<!-- CN -->
- 新增 **`mstar workflow delivery-anchors`**：在 workflow CAS token 之下，受守卫、可重复地修正 workflow 已登记的投递锚点（`branch.source` / `branch.target`）。`--branch-source` / `--branch-target` 各自可选（未提供的保留已登记值），`--reason` 必填并进入该操作的意图指纹；写入**合并**进已存 `branch` 对象，因此未被点名的成员（例如 iteration workflow 的 `base` / `integration`）会被保留。这补上了「注册时锚点写错即导致 plan 永远无法完成、且没有任何受支持修复路径」的缺口。
- `mstar workflow register` 现在会在 `development` 注册的 `--branch-source` 与 `--branch-target` 取值相同时给出**非阻断提示**（ok envelope 的 `data.warnings`）；其 `--branch-source` / `--branch-target` 选项帮助也说明了这两个锚点的含义。
- **拒绝信息现在说明原因与恢复路径**（此前止于通用文案）：`plan complete` 的投递锚点不匹配会列出两个分支值，并由 envelope 的 `recovery` 给出修复路径；`store execution export` 的 control-root 拒绝会说明解析到的目标与被准入的调用方式；`plan progress` 的恢复文案不再把 payload 误述为裸状态。
- **`mstar lint --type plan` 不再误报 plan 自身的 YAML frontmatter**：跳过前导 `---` 块，因此 `status: Todo` 不再被判为占位符，正文中的占位符仍照常报告。
- **`mstar schema --command plan.progress` 现在发布 `PlanProgress` payload 形状**（`status` / `summary` / `evidence_paths` / 可选 `track_branches`），不再是开放对象。
