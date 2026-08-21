---
category: Harness
packages: root, engine
---

- **Plan-Writing Path Gate closes the symlink-escape gap**: `assertPlanWritingPath` now compares the canonical path of an **existing** plan file against the canonical `{PLAN_DIR}` (the plans dir itself may legitimately be a symlink). A plan path that lexically sits under `{PLAN_DIR}` but `realpath`s outside it now returns a **high** `plan-path.symlink-escape` violation instead of `plan-path.ok`; internal aliases (`plans/alias.md` → `plans/real.md`) and whole-dir `plans/` symlink layouts still pass. Missing files (first write) stay lexical-only, and unexpected fs errors (EACCES etc.) degrade to the lexical verdict — the gate never throws. `plan-path.outside-plan-dir` and `plan-path.no-harness` semantics are unchanged.

<!-- CN -->
- **Plan 写入路径门禁补上符号链接逃逸缺口**：`assertPlanWritingPath` 现对**已存在**的 plan 文件做 canonical 路径与 canonical `{PLAN_DIR}` 的对比（plans 目录本身可以是符号链接的合法布局）。词法上位于 `{PLAN_DIR}` 之下、但 `realpath` 指向其外的 plan 路径，现返回 **high** 级 `plan-path.symlink-escape` 违规，不再返回 `plan-path.ok`；内部别名（`plans/alias.md` → `plans/real.md`）与整目录 `plans/` 符号链接布局仍通过。文件不存在（首次写入）仅做词法检查；意外 fs 错误（EACCES 等）降级为词法判定——门禁绝不抛异常。`plan-path.outside-plan-dir` 与 `plan-path.no-harness` 语义保持不变。
