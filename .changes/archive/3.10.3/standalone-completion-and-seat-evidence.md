---
category: Changed
packages: engine,cli
---

- Added a **route-specific standalone completion path**: a `type: plan` / `development` workflow now reaches row `Done` from its own registered `branch.source` / `branch.target` instead of requiring an integration branch, while the iteration route keeps its mandatory integration anchors and the delivery-evidence ordering gate is unchanged.
- Added the guarded, identity-only **`plan repair-delivery-source`** operation: it corrects a pre-existing snapshot whose registered delivery source is wrong, deriving the replacement only from that row's accepted handoff and changing nothing else — never `Done`, never delivery evidence, statuses or leases.
- Gave the **QA seat the same budget-stop and truncation contract as the QC seats** (`Truncated coverage:` emitted only when the bound actually stopped expansion) and one mandatory report-landing obligation that reads identically in the role reference and the review-bundle naming table.
- Bound the **L2 task-review output** to an always-on `${SDD_DIR}/task-N-review.md`, distinct from and never overwriting the implementer's `task-N-report.md`, and aligned every named producer and consumer on that basename.
- Published both completion routes and the legacy-only repair across the CLI reference, the runtime lifecycle contract, the state/residual reference and the PM plan-management reference.

<!-- CN -->
- 新增**按路由区分的 standalone 完成路径**：`type: plan` / `development` workflow 现在从自身登记的 `branch.source` / `branch.target` 到达 row `Done`，不再要求 integration 分支；迭代路由仍保留强制的 integration 锚点，投递证据顺序门禁不变。
- 新增受守卫、仅修正身份的 **`plan repair-delivery-source`** 操作：修正既存快照中登记错误的投递 source，替换值只取该行已接受的 handoff，其余一律不动——不产生 `Done`，不触碰投递证据、状态或 lease。
- 让 **QA 席位获得与 QC 席位相同的预算停止与截断契约**（`Truncated coverage:` 仅在预算真正中断扩展时出现），并统一唯一的强制报告落盘义务，使其在角色参考与 review bundle 命名表中读起来一致。
- 将 **L2 task-review 输出**绑定到常开的 `${SDD_DIR}/task-N-review.md`，与实现者的 `task-N-report.md` 区分且永不覆盖它，并让所有生产方与消费方对该 basename 达成一致。
- 在 CLI 参考、运行时生命周期契约、状态/residual 参考与 PM plan-management 参考中同步发布两条完成路由与 legacy-only 修复。

<!-- CN -->
