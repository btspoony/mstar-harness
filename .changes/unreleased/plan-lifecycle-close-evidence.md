---
packages: engine, cli
---

- Close now **consults the registered delivery kind's evidence before writing the terminal snapshot** (seam S3): a `development` workflow without its compound disposition, PR identity or PM-recorded verified-merge evidence, and a `verification/report-only` workflow without the fulfilment of its registered completion policy, refuse the close with zero writes — the workflow stays `running`, registered and resumable. The read-only Phase-6 gate runs the same consultation, so gate and close never disagree.
- Added the authorized recording seam `mstar workflow evidence --workflow <id> --file <payload.json> [--session <path>]` plus the snapshot `delivery` evidence block: stage-by-stage recording under the snapshot lock, coordinator-gated exactly like the close (a coordinated workflow is written only for its own bound envelope) and idempotent — re-recording identical evidence rewrites nothing.
- SDD admission accepts only an **active registered row** as registration evidence: a plan id retained solely in a terminal snapshot is now refused with `sdd.context.plan-not-registered` like an unregistered one, so a completed plan id can no longer be reused by riding its own history. Roots without a v2 register keep the legacy standalone policy.
- `mstar workflow register --branch-source` now records **`branch.source`** instead of `branch.base`; `branch.base` keeps its protected-base semantics (cleanup Rule 2 protected refs, L1 main-worktree residency fallback), so a standalone plan's delivery branch is no longer pinned as an undeletable protected ref.

<!-- CN -->
- 关闭现在**在写终态快照前咨询已注册交付类型的证据**（seam S3）：`development` 工作流缺少 compound 处置、PR 身份或 PM 记录的核实合并证据，`verification/report-only` 工作流缺少其注册完成策略的履行记录时，关闭会被拒绝且**零写入**——工作流保持 `running`、已注册、可恢复。只读的 Phase-6 门禁运行同一份咨询逻辑，门禁与关闭判定不会分叉。
- 新增授权写入 seam `mstar workflow evidence --workflow <id> --file <payload.json> [--session <path>]` 及快照 `delivery` 证据块：在快照锁内分阶段记录，授权与 close 完全一致（协作式工作流仅其绑定协调者可写），且幂等——重复记录相同证据不产生任何写入。
- SDD 准入只承认**活动注册行**为注册证据：仅残留在终态快照中的 plan id 现与未注册者同样以 `sdd.context.plan-not-registered` 拒绝，已完成的 plan id 不能靠自身历史复用。无 v2 register 的根保持旧有 standalone 策略。
- `mstar workflow register --branch-source` 现写入 **`branch.source`** 而非 `branch.base`；`branch.base` 保持受保护 base 锚语义（cleanup Rule 2 保护 ref、L1 main worktree residency 回退），独立 plan 的交付分支不再被固化为不可删除的保护 ref。
