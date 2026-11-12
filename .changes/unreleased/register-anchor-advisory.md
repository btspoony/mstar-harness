---
category: Changed
packages: commands
---

- **`workflow register` advises when the creation base is the delivery branch.** The `deliveryAnchorWarnings` advisory fired only when `--branch-work` equalled `--branch-target`, so a `development` registration whose `--branch-base` and `--branch-work` recorded the same branch passed silently — and that pair means the delivery branch is the source of its own change. The advisory now covers `base === work` too, names `branch.base` and `branch.work`, and points at `mstar workflow delivery-anchors --branch-base` for the repair. Registration still succeeds.

<!-- CN -->
- **`workflow register` 在创建基线即交付分支时给出提示。** `deliveryAnchorWarnings` 此前仅在 `--branch-work` 与 `--branch-target` 相同时告警，因此 `--branch-base` 与 `--branch-work` 记录同一分支的 `development` 注册会静默通过——而这种组合意味着交付分支就是自身变更的来源。提示现在同样覆盖 `base === work`，点名 `branch.base` 与 `branch.work`，并指向 `mstar workflow delivery-anchors --branch-base` 以修复。注册仍然成功。
