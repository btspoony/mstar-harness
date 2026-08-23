---
name: mstar-engine-legacy
description: Morning Star 条件契约档案（engine-absent fallback）。宿主无 engine 能力（无 `mstar` CLI、无 engine import、engine 约束未激活）时需要被 engine 校验接管的 contract 全文时使用：status v1→v2 字段历史、lease claim 协议全文、各宿主 QC 座次 N=3/N=1 重述、反递归完整清单、Engine-check 样板说明。engine 约束激活（或宿主含 engine 能力）时不加载；运行时 skills 的 engine-check 指针为权威契约。
---

# mstar-engine-legacy（条件契约档案 / Engine-absent fallback）

## Load Order

- 先 Read **`mstar-harness-core`**（SKILL.md；冲突时以 core 为准）。
- **条件加载**：仅当宿主**无 engine 能力**时读取本 skill 及其 references —— 无 `mstar` CLI、无 engine import、engine 约束未激活。engine 约束激活（或宿主含 engine 能力）时**不加载**：此时运行时 skills 的 engine-check 指针 + 短契约文本为权威（见 core 索引行）。
- 本 skill 是**单一条件归档**：承接因 engine 校验而从运行时 skills 中移除的 contract 全文，engine-absent 宿主在此找回完整文本。

## Scope

- 归档**被承接的完整契约散文**（Task 2 displaced prose 的单一收容处）：
  1. `status.json` v1→v2 字段历史表（字段、severity、lifecycle、jq/flock 示例）
  2. lease claim 协议全文（claim-before-InProgress、hold/release/override、integration merge、orphan recovery、waiver）
  3. 各宿主 QC 座次 N=3/N=1 重述（omp / opencode / cursor / codex / kimi / zcode / dsh）
  4. 反递归完整清单（leaf executor checklist、红线、NEVER 规则）
  5. Engine-check 样板含义（运行时 skills 中 `Engine check (when available)` blockquote 的语义与 fallback 规则）
- 运行时 skills 只保留短指针 + engine-check 命令；完整全文一律在本 skill 的 `references/` 中（避免全仓重复）。

## Workflow

1. 确认触发条件：宿主**无 engine**（无 CLI / import；约束未激活）。满足才继续。
2. 按需打开对应 reference（见下表），把其中的完整契约文本作为 fallback 应用。
3. engine 恢复后回到运行时 skills 的指针契约，停止使用本文件作为权威。

| 需要 | 打开 |
|------|------|
| status 字段 / severity / lifecycle / 迁移 / jq-flock 示例 | `references/status-field-history.md` |
| lease claim 协议全文（claim / hold / merge / orphan / waiver） | `references/lease-protocol.md` |
| 各宿主 QC 座次 N=3/N=1 重述 | `references/qc-seat-n-restatements.md` |
| 反递归完整清单（leaf checklist + 红线） | `references/anti-recursion-checklists.md` |
| Engine-check 样板含义与 fallback 规则 | `references/engine-check-boilerplate.md` |

## Decision Rules

- **不加载条件**：engine 约束激活，或宿主含 engine 能力（`mstar` CLI / engine import 可用）→ 本 skill 不加载。
- **归档唯一性**：完整契约文本只存在于本文件；不得同时在运行时 skills 重复维护全文（运行时只放指针 + engine-check）。
- **权威性**：engine-absent 时，本文件的完整文本是行为权威；engine-present 时，运行时 skills + engine 校验是权威，本文件不是。
- **不改契约语义**：承接文本必须逐字保留（字段名、severity 枚举、lease 规则、N 规则、反递归清单）；只做整理与归档，不重写规则。

## Evidence

- 正确结果 = references 中的完整文本可独立支撑 engine-absent 宿主操作；`bun run validation:drift` 绿（skill corpus lint 通过）；`mstar skill lint skills/mstar-engine-legacy` 绿。
- 回归 = grep 验证运行时 skills 已不再携带被承接的全文（原全文位置只剩指针 / engine-check）。

## References

- 本 skill 的 references（见 When Workflow 表）。
- 权威运行时契约（engine-present 时读）：`mstar-artifacts`（status v2 / register）、`mstar-iteration`、`mstar-dispatch-gates`、`mstar-host`。
