---
name: mstar-engine-legacy
description: "Morning Star engine-absent safety and historical-field archive. Use only when the host has no CLI/engine capability and needs field history, checkout/atomic-safety guidance or dispatch/QC invariants. Engine-absent hosts have no file execution route — execution state is conversation tracking (no-plan mode); the archive never recreates removed plan identity, claim, Assignment seal or transfer protocols, and engine-present hosts use current domain operations."
---

# mstar-engine-legacy（条件契约档案 / Engine-absent archive）

## Load Order

- 先 Read **`mstar-harness-core`**（SKILL.md；冲突时以 core 为准）。
- **条件加载**：仅当宿主**无 engine 能力**时读取本 skill 及其 references —— 无 `mstar` CLI、无 engine import、engine 约束未激活。engine 约束激活（或宿主含 engine 能力）时**不加载**：此时运行时 skills 的 engine-check 指针 + 短契约文本为权威（见 core 索引行）。
- 本 skill 是**单一条件归档**：承接因 engine 校验而从运行时 skills 中移除的 contract 全文，engine-absent 宿主在此找回完整文本。归档只提供字段历史与安全/流程散文——**不**提供文件执行路径；engine-absent 宿主的执行状态走对话追踪（no-plan mode）。

## Scope

- 归档**被承接的完整契约散文**（Task 2 displaced prose 的单一收容处）：
  1. `status.json` v1→v2 字段历史表（字段、severity、lifecycle、jq/flock 示例）
  2. Concurrent-write and checkout safety without recreated claim/bind/transfer APIs
  3. 各宿主 QC 座次 N=3/N=1 重述（omp / opencode / cursor / codex / kimi / zcode / dsh）
  4. 反递归完整清单（leaf executor checklist、红线、NEVER 规则）
  5. Engine-check 样板含义（运行时 skills 中 `Engine check (when available)` blockquote 的语义与 standalone guarantee 规则）
- **执行状态边界**：engine-absent 宿主无文件执行路径——执行状态 = 对话追踪（no-plan mode），门禁（QC/QA）仍适用；本归档不重建任何文件执行面。
- 运行时 skills 只保留短指针 + engine-check 命令；完整全文一律在本 skill 的 `references/` 中（避免全仓重复）。

## Workflow

1. 确认触发条件：宿主**无 engine**（无 CLI / import；约束未激活）。满足才继续。
2. 按需打开对应 reference（见下表），把其中的历史/安全文本作为参考应用；**不**用它们重建文件执行路径——执行状态走对话追踪（no-plan mode）。
3. engine 恢复后回到运行时 skills 的指针契约，停止使用本文件作为权威。

| 需要 | 打开 |
|------|------|
| status 字段 / severity / lifecycle / 迁移 / jq-flock 示例 | `references/status-field-history.md` |
| Checkout/atomic safety; no supported writer means report capability, never edit protected state | `references/lease-protocol.md` |
| 各宿主 QC 座次 N=3/N=1 重述 | `references/qc-seat-n-restatements.md` |
| 反递归完整清单（leaf checklist + 红线） | `references/anti-recursion-checklists.md` |
| Engine-check 样板含义与 standalone guarantee 规则 | `references/engine-check-boilerplate.md` |

## Decision Rules

- **不加载条件**：engine 约束激活，或宿主含 engine 能力（`mstar` CLI / engine import 可用）→ 本 skill 不加载。
- **归档唯一性**：完整契约文本只存在于本文件；不得同时在运行时 skills 重复维护全文（运行时只放指针 + engine-check）。
- **权威性**：engine-absent 时，本文件的完整文本是字段历史与安全/流程参考；engine-present 时，运行时 skills + engine 校验是权威，本文件不是。
- **不改契约语义**：承接文本的字段名、severity 枚举、N 规则与反递归清单逐字保留；只做整理与归档（并移除文件执行路径的退役措辞），不重写规则。
- **无文件执行路径**：不得以 `status.json` / snapshot / lease 文件重建执行状态；engine-absent 宿主的执行状态 = 对话追踪（no-plan mode），门禁（QC/QA）仍适用。

## Evidence

- 正确结果 = references 中的历史/安全文本可独立支撑 engine-absent 宿主的字段查阅与安全判断（执行状态仍走对话追踪）；`bun run validation:drift` 绿（skill corpus lint 通过）；`mstar skill lint skills/mstar-engine-legacy` 绿。
- 回归 = grep 验证运行时 skills 已不再携带被承接的全文（原全文位置只剩指针 / engine-check）。

## References

- 本 skill 的 references（见 When Workflow 表）。
- 权威运行时契约（engine-present 时读）：`mstar-artifacts`（status v2 / register）、`mstar-iteration`、`mstar-dispatch-gates`、`mstar-host`。
