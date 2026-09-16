---
category: Harness
packages: root
---

- Added a named **`Rescheduling checkpoint`** to the authoritative Phase 2 procedure (`mstar-iteration/references/phase-2-worktree-lease.md` §2.4): five frozen reasons (`before-wait`, `result-settled`, `dependency-changed`, `ownership-changed`, `capacity-changed`) and a six-step decision procedure that starts every authorized independent ready task before waiting for an unrelated running child, keeps true dependencies blocked until reviewed commits are in the dependent's assigned base, and allows one reasoned native wait without polling or repeated reminders. Short pointers added in `mstar-sdd` § Ready-task scheduling and the PM role; no new scheduler, ready-state register or engine schema.
- Added the six `phase2-*` routing-eval cases (version 30, 62 cases) with their regression signals, and documented the before/after behavioural evidence for them plus the affected `plan-scope-duplicate` / `plan-scope-last-plan` / `plan-scope-leaf` cases.

<!-- CN -->
- 在权威 Phase 2 procedure（`mstar-iteration/references/phase-2-worktree-lease.md` §2.4）新增具名的 **`Rescheduling checkpoint`**：五个冻结 reason（`before-wait`、`result-settled`、`dependency-changed`、`ownership-changed`、`capacity-changed`）与六步决策程序 —— 在等待无关 running child 之前启动全部已授权独立 ready work，真依赖在已审 commit 进入 dependent 的 assigned base 前保持阻塞，并允许一次有理由的 native wait（无轮询、无重复提醒）。`mstar-sdd` § Ready-task scheduling 与 PM 角色新增短指针；不新增调度器、ready-state register 或 engine schema。
- 新增六个 `phase2-*` 路由回归场景（version 30 · 62 例）及其回归信号，并记录这些场景与受影响的 `plan-scope-duplicate` / `plan-scope-last-plan` / `plan-scope-leaf` 场景的 before/after 行为证据。
