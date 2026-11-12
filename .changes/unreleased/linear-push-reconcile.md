---
packages: engine, commands
---

- **The skip rule answers before the workspace checks**: `pushItem` now computes the payload hash and
  returns `skipped` for an applied row that already proves the remote content, before the state and
  label preflights. An item whose kind label has since left the workspace used to report `failed` and
  rewrite a correctly `applied` row with an error it never earned; it now reports `skipped` and leaves
  the ledger untouched.

- **Adoption adopts the last marker, not the first**: `markerIn` takes the final
  `<!-- mstar-sync: … -->` occurrence in a description, so a marker quoted in operator text can no
  longer be the one a reconcile scan matches. The marker grammar is unchanged.

- **Reconcile scans are bounded at the import bound**: `reconcilePendingCreate` stops at the page
  bound its caller passes — `DEFAULT_MAX_PAGES`, the same number `import` stops at, which the engine
  no longer has to duplicate. A scan still holding a cursor names the bound on the report
  (`stoppedAtPageBound`), reports the residue's cause as a truncated scan rather than as proven
  absence, and refuses `--release` outright: a listing that was not read to its end proves nothing
  about what it did not see.

- **A malformed remote reference is invalid input, not a crash**: `externalIdOf("http://[")` throws the
  existing `[sync.invalid-input]` refusal instead of leaking the `TypeError` `new URL` raises, so
  `--adopt` reports a cause the operator can act on.

- **`linear.label-unresolved` names both of its causes**: the recovery text now separates a discovery
  walk that stopped at its page bound (the label may exist — re-run instead of creating it) from a
  completed walk that proved the label absent (create or redirect it). The code is unchanged.

<!-- CN -->
- **跳过规则先于工作区检查**：`pushItem` 先计算 payload 哈希，命中已应用行的哈希时在状态与标签预检
  之前返回 `skipped`。此前某条目的 kind 标签已从工作区消失时会被报成 `failed`，用一条它从未产生的
  错误覆盖本已 `applied` 的行；现在报 `skipped` 且不改动账本。

- **采纳取最后一个 marker**：`markerIn` 采用描述中最后一个 `<!-- mstar-sync: … -->`，操作者正文里
  引用的 marker 不再可能成为 reconcile 匹配到的那一个。marker 语法不变。

- **reconcile 扫描受 import 同一页上限约束**：`reconcilePendingCreate` 在调用方传入的页上限处停止
  —— 即 `DEFAULT_MAX_PAGES`，与 `import` 使用的同一个数字，engine 无需重复维护。仍持有游标的扫描会
  在报告上写明该上限（`stoppedAtPageBound`），把残留条目的原因写成扫描被截断而非已证不存，并直接
  拒绝 `--release`：没有读到末尾的列表对它没看到的内容不构成任何证明。

- **畸形远端引用属于无效输入而非崩溃**：`externalIdOf("http://[")` 抛出既有的
  `[sync.invalid-input]` 拒绝，而不是泄漏 `new URL` 的 `TypeError`，`--adopt` 报告的原因因此可被
  操作者处置。

- **`linear.label-unresolved` 同时指明两种成因**：恢复文本区分「发现遍历在页上限处停止」（标签可能
  存在，应重跑而不是新建）与「遍历走完且证明确实不存在」（新建或重定向）。错误码不变。
