---
category: Harness
packages: root
---

- Added the **Task budget (implement / ops rounds)** field to the canonical Assignment contract: SDD fresh/continuation prompts require the header before task-body markers and repeat the overrun escalation with the mandatory no-shortened-verification rule from `plan-quality-bar.md` item 7; a previous task's budget is not inherited.
- Budget overrun on `NEEDS_CONTEXT` / `BLOCKED` now routes to PM split/re-dispatch under plan-quality-bar item 7 in `mstar-sdd`; `mstar-review-qc` and `mstar-dispatch-gates` engine-check notes point to the same presence-only requirement.

<!-- CN -->
- 规范 Assignment 契约新增 **Task budget (implement / ops rounds)** 字段：SDD fresh/continuation 提示要求在任务正文标记前携带该 header，并重复超支升级指令与 `plan-quality-bar.md` 第 7 条的强制「不得缩短已指派验证」规则；上一任务的预算不得被继承。
- `NEEDS_CONTEXT` / `BLOCKED` 上的预算超支现按 plan-quality-bar 第 7 条路由至 PM 拆单重派（`mstar-sdd`）；`mstar-review-qc` 与 `mstar-dispatch-gates` 的 engine-check 注记指向同一 presence-only 要求。
