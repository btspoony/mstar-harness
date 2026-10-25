---
category: Harness
packages: root
---

- Added **`mstar issue move`**: reassigns an issue to another registered project, recomputes its project-scoped identity key (an identity the target project already holds is refused, naming the colliding issue), clears its milestone, and advances the issue revision and the store revision exactly once under `--expect`.
- `milestone.project-mismatch` refusals now name the cause (issue and milestone must share a project) and both repairs: `mstar issue move` for an issue in the wrong project, a target-project milestone for the milestone.
- Updated `mstar-project-governance` and `mstar-use-cli`.

<!-- CN -->
- 新增 **`mstar issue move`**：把 issue 改挂到另一个已登记项目，重算 project-scoped identity key（目标项目已持有该 identity 时拒绝并点名冲突 issue），清空 milestone，并在 `--expect` 下让 issue revision 与 store revision 各前进一次。
- `milestone.project-mismatch` 拒绝现在写明原因（issue 与 milestone 必须同项目）及两条修复路径：issue 错了用 `mstar issue move`，milestone 错了改用目标项目的 milestone。
- 同步更新 `mstar-project-governance` 与 `mstar-use-cli`。
