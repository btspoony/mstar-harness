---
category: Changed
packages: commands
---

- **`workflow register` advises when the creation base is the delivery branch.** The `deliveryAnchorWarnings` advisory fired only when `--branch-work` equalled `--branch-target`, so a `development` registration whose `--branch-base` and `--branch-work` recorded the same branch passed silently — and that pair means the delivery branch is the source of its own change. The advisory now covers `base === work` too. Registration still succeeds, but such a registration no longer prints a warning-free `ok` envelope: it now carries a non-empty `data.warnings`, the same field the `work === target` advisory already uses. Both collision arms are symmetric in what they detect, so each now names both corrections — re-record the base, or re-record the work branch — because `mstar workflow delivery-anchors` accepts a re-recorded anchor that is already correct, and repairing only the one the text used to name would leave the collision in place with no further signal. `--branch-base`'s help text says recording it as `--branch-work` is advised against.

<!-- CN -->
- **`workflow register` 在创建基线即交付分支时给出提示。** `deliveryAnchorWarnings` 此前仅在 `--branch-work` 与 `--branch-target` 相同时告警，因此 `--branch-base` 与 `--branch-work` 记录同一分支的 `development` 注册会静默通过——而这种组合意味着交付分支就是自身变更的来源。提示现在同样覆盖 `base === work`。注册仍然成功，但这类注册不再返回无告警的 `ok` 信封：它会携带非空的 `data.warnings`，即 `work === target` 提示已经使用的同一字段。两类冲突条件对称，因此每条提示现在同时给出两种修复——重记基线，或重记交付分支——因为 `mstar workflow delivery-anchors` 会接受一个本就正确的锚点重写；若只按旧文案给出的那一侧修复，冲突会原样保留且不再有任何提示。`--branch-base` 的帮助文本现已说明不建议它与 `--branch-work` 记录同一分支。
