---
name: mstar-engine-legacy
description: "Engine-absent execution-state boundary: without a CLI/engine, execution state is conversation tracking (no-plan mode) and no file execution route is recreated. Use only when the host has no engine capability."
---

# mstar-engine-legacy（engine-absent 执行状态边界档案）

## Load Order

- Follow the host-selected lifecycle authority first; this archive never overrides runtime authorization and names no other `mstar-*` skill (inbound-only).
- **条件加载**：仅当宿主**无 engine 能力**时读取本 skill —— 无 `mstar` CLI、无 engine import、engine 约束未激活。engine 约束激活（或宿主含 engine 能力）时**不加载**：engine-present 宿主以运行时 skills 的指针 + engine 校验为权威。

## Scope

- 本 skill 只承接**一件事**：engine-absent 宿主的**执行状态边界**。字段历史与迁移形状随 engine 留在运行时侧，不在本归档。
- engine-absent 宿主没有文件执行路径：执行状态走对话追踪（no-plan mode），门禁（QC/QA）仍适用；本归档不重建任何文件执行面。
- 本归档**不**承载字段表、迁移映射、派发座次或反递归清单——这些契约的当前 owner 是运行时 skills。

## Workflow

1. 确认触发条件：宿主**无 engine**（无 CLI / import；约束未激活）。满足才继续。
2. 在会话内追踪执行状态：plan / task 进度、门禁结论与证据以对话持有（必要时落在 authored plan 文件里），**不**写 `status.json` / snapshot / lease 之类的执行面。
3. engine 恢复后停止使用本文件作为权威，回到运行时 skills 的指针契约。

## Decision Rules

- **不加载条件**：engine 约束激活，或宿主含 engine 能力（`mstar` CLI / engine import 可用）→ 本 skill 不加载。
- **无文件执行路径**：不得以 `status.json` / snapshot / lease 文件重建执行状态；「先建一个文件承载状态」本身就是重建已退役的执行面。
- **Inbound-only**：运行时 skills 可指向本归档；本归档**永不点名其它 `mstar-*` skill**——需要指代运行时契约时用中性描述（the runtime dispatch rules / the current field reference / the host references）。
- **缺契约照实报**：需要本归档不承载的字段、迁移或派发细节时，报告缺的是哪一份运行时契约，不凭记忆重建。

## Evidence

- 正确结果 = engine-absent 会话按对话追踪推进，且没有新建文件执行面；`bun run validation:drift` 绿（archive 引用 lint 通过）；`mstar skill lint skills/mstar-engine-legacy` 绿。

## References

- 本 skill 无本地 `references/`：只有这份 SKILL.md。
- Current execution, issue and lifecycle authority belongs to the runtime field reference and domain operations; this archive supplies the engine-absent execution-state boundary only.
