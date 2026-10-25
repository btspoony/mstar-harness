---
category: Harness
packages: root
---

- Added **`mstar issue move`**: reassigns an issue to another registered project under an issue-revision and store-revision CAS (`--expect` and `--expect-store`), recomputes its project-scoped identity key (an identity the target project already holds is refused, naming the colliding issue and offering to retire the moving issue in its favour), and clears its milestone — including one already delivered or dropped — in the same update. Each real move is recorded once in the new append-only `issue_project_moves` ledger (migration 13) with its actor and reason, readable from `issue show` / `issue export` as `projectMoves`; the same-project no-op records only the operation receipt.
- `milestone.project-mismatch` refusals now name the cause (issue and milestone must share a project) and both repairs: `mstar issue move` for an issue in the wrong project, a target-project milestone for the milestone. An unregistered target project names `mstar catalog register` as the route.
- Updated `mstar-project-governance` and `mstar-use-cli`.

<!-- CN -->
- 新增 **`mstar issue move`**：在 issue revision 与 store revision 双重 CAS（`--expect` 与 `--expect-store`）下把 issue 改挂到另一个已登记项目，重算 project-scoped identity key（目标项目已持有该 identity 时拒绝、点名冲突 issue，并给出“退役被移动 issue”的路径），并在同一次更新里清空 milestone（含已 delivered / dropped 的）。每次真实移动以 actor 与 reason 记入新的追加式 `issue_project_moves` 账本（migration 13），可通过 `issue show` / `issue export` 的 `projectMoves` 读取；同项目 no-op 只记录 operation 收据。
- `milestone.project-mismatch` 拒绝现在写明原因（issue 与 milestone 必须同项目）及两条修复路径：issue 错了用 `mstar issue move`，milestone 错了改用目标项目的 milestone。目标项目未登记时点名 `mstar catalog register` 作为修复入口。
- 同步更新 `mstar-project-governance` 与 `mstar-use-cli`。
