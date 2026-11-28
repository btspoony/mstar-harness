---
category: Changed
packages: root,engine,commands
---

- **An absent `[collaboration]` mode now selects `local`.** A repository needs no `.mstarc` declaration to use its local user-level authority; `mirror` and `remote` remain explicit, an empty `mode=` still refuses `collaboration.mode-required`, and a published remote selector refuses a checkout that defaulted to local instead of reading local rows. The refusal now names that recovery.

<!-- CN -->
- **`[collaboration]` 未声明 mode 时现默认 `local`。** 仓库无需在 `.mstarc` 写声明即可使用本地用户级权威；`mirror` 与 `remote` 仍需显式声明，空的 `mode=` 仍以 `collaboration.mode-required` 拒绝，而远端已发布的 selector 会拒绝默认落到 local 的 checkout，不会改读本地数据；该拒绝文案现给出声明对应 mode 的恢复方式。
