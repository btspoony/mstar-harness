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

- **Reconcile scans are bounded, and a truncated one decides nothing**: `reconcilePendingCreate` stops
  at the page bound its caller passes — `DEFAULT_MAX_PAGES`, the same number `import` stops at, which
  the engine no longer has to duplicate — and rejects a bound below one. A scan still holding a cursor
  is reported as truncated (`stoppedAtPageBound`, carried through to the `push` run report), and one
  standard follows: neither absence nor uniqueness is proved over a listing read only in part. No
  `--release` and, unlike before, **no adoption** — every residue stays `unresolved` with the bound in
  its cause, so `--adopt` or a listing that fits the bound is the way out. Adopting the single match
  read so far would bind the row to one of several remote issues carrying its marker, where no later
  scan could surface the other.

- **A malformed remote reference is invalid input, not a crash**: `externalIdOf("http://[")` throws the
  existing `[sync.invalid-input]` refusal instead of leaking the `TypeError` `new URL` raises, so
  `--adopt` reports a cause the operator can act on.

- **`linear.label-unresolved` names both of its causes**: the recovery text now separates a discovery
  walk that stopped at its page bound — a fixed bound the walk restarts from every run, so retrying
  cannot change the outcome and the action is to bring the workspace's label set within what mstar
  enumerates — from a completed walk that proved the label absent (create or redirect it). The code is
  unchanged, and `sync.illegal-transition`'s recovery now also covers the truncated-scan branch instead
  of describing only a wrong `--release` target.

<!-- CN -->
- **跳过规则先于工作区检查**：`pushItem` 先计算 payload 哈希，命中已应用行的哈希时在状态与标签预检
  之前返回 `skipped`。此前某条目的 kind 标签已从工作区消失时会被报成 `failed`，用一条它从未产生的
  错误覆盖本已 `applied` 的行；现在报 `skipped` 且不改动账本。

- **采纳取最后一个 marker**：`markerIn` 采用描述中最后一个 `<!-- mstar-sync: … -->`，操作者正文里
  引用的 marker 不再可能成为 reconcile 匹配到的那一个。marker 语法不变。

- **reconcile 扫描有上限，且被截断的扫描不作任何判定**：`reconcilePendingCreate` 在调用方传入的页
  上限处停止 —— 即 `DEFAULT_MAX_PAGES`，与 `import` 使用的同一个数字，engine 无需重复维护 —— 并
  拒绝小于 1 的上限。仍持有游标的扫描会在报告上标记为被截断（`stoppedAtPageBound`，并透传到
  `push` 的运行报告），随后只适用一条标准：没有读到末尾的列表既不证明不存在，也不证明唯一。既不
  允许 `--release`，与此前不同也**不再采纳** —— 每个残留条目保持 `unresolved`，原因中含该上限，
  出路是 `--adopt` 或让列表适配上限。采纳"目前唯一读到的那一个"会让该行绑定到多个携带同一 marker
  的远端条目之一，而后续扫描再也无法发现其余条目。

- **畸形远端引用属于无效输入而非崩溃**：`externalIdOf("http://[")` 抛出既有的
  `[sync.invalid-input]` 拒绝，而不是泄漏 `new URL` 的 `TypeError`，`--adopt` 报告的原因因此可被
  操作者处置。

- **`linear.label-unresolved` 同时指明两种成因**：恢复文本区分「发现遍历在页上限处停止」（该上限
  固定且每次运行都从头重走，重试无法改变结果，应把工作区标签数收敛到 mstar 可枚举的范围内）与
  「遍历走完且证明确实不存在」（新建或重定向）。错误码不变；`sync.illegal-transition` 的恢复文本
  也不再只描述"`--release` 目标错误"，而覆盖截断扫描这一分支。
