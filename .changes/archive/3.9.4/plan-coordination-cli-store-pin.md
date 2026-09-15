---
category: Changed
packages: cli
---

- Fixed the plan-coordination CLI store pin: the `--workflow/--plan` bind form now pins the `--harness` override (only a top-level `--harness` was read, so the store pinned the cwd-resolved root and the bind was refused with `coordination.path-mismatch`), and coordinator transitions now pin the session root **before** the live-handoff pre-check reads the row — a linked checkout whose session envelope names the control root is no longer refused by an unpinned read.
- Added load-bearing cases for both: a bind run from a directory with no resolvable harness, and an accept run from a linked worktree whose stale-id variant proves the pre-check now reaches the pinned store.

<!-- CN -->
- 修复 plan-coordination CLI 的 store pin：`--workflow/--plan` 绑定形式现在会 pin 住 `--harness` 覆盖值（此前只读顶层 `--harness`，store 被 pin 到 cwd 解析出的根，绑定以 `coordination.path-mismatch` 被拒）；协调者 transition 现在在 live-handoff 预检读取行**之前** pin 会话根——会话信封指向控制根的 linked checkout 不再被未 pin 的读取拒绝。
- 为两者新增负载性用例：在无可解析 harness 的目录执行 bind，以及在 linked worktree 执行 accept（其 stale-id 变体证明预检已走 pin 后的 store）。
