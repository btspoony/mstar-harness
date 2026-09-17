---
category: Changed
packages: root, omp
---

- Documented the producer of the prepared Assignment in the OMP host reference: the `reserve-launch` admission clause and the optional transport section now name **`mstar plan prepare`** as the coordinator step that writes `coordination.prepared` and its pinned `coordination.prepared.assignment_path`, define the transport placeholder as that absolute path, add an ordered summary of the extra-primary route (registered `Todo` row → existing feature worktree → coordinator bound → prepare → `reserve-launch` → the journaled record-before-side-effect transitions and pane/start/submission sequence), and state the admission windows — row admission closes with Phase 1 (earlier once any row starts preparation or execution), while an already-registered eligible row may still be prepared during Phase 2.
- Added the host-agnostic precondition to the scoped-plan PM transport note: a conditional extra-primary launch is available only for a plan row the coordinator has already registered and prepared, and whose feature worktree exists — a row that does not yet exist cannot be launched, because row admission closes with Phase 1.

<!-- CN -->
- 在 OMP 宿主参考中写明 prepared Assignment 的生产者：`reserve-launch` 准入子句与可选传输小节现命名 **`mstar plan prepare`** 为写入 `coordination.prepared` 及其固定 `coordination.prepared.assignment_path` 的协调者步骤，把传输占位符定义为该绝对路径，补充额外 primary 路线的有序摘要（已注册的 `Todo` 行 → 存在的 feature worktree → 协调者已绑定 → prepare → `reserve-launch` → 既有先记账后副作用的迁移与 pane/启动/提交序列），并写明准入窗口——行准入随 Phase 1 关闭（任何行开始准备或执行时更早关闭），而已注册的合格行仍可在 Phase 2 期间被准备。
- 在 scoped-plan PM 传输小节补充宿主无关前置条件：条件性额外 primary 启动仅适用于协调者已注册且已准备、feature worktree 已存在的 plan 行；尚不存在的行无法被启动，因为行准入随 Phase 1 关闭。
