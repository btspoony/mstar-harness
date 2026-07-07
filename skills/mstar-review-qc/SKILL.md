---
name: mstar-review-qc
description: Morning Star QC orchestration — **SDD mandatory plan QC tri-review** (`qc1`…`qc3` + consolidated); inline/hotfix single-seat (`qc.md`); PM dispatch timing, tri identity gate, residual registration contract, layer boundaries. Leaf QC execution → **`mstar-roles/references/qc-specialist/`**. Per-task review is **`mstar-sdd`** (L2). Primary reader: **`project-manager`** when dispatching or consolidating QC.
---

## Load order（必读顺序）

**首次 Read 本 skill 时：必须先 Read `mstar-harness-core`。** 同仓检出与派发 → **`mstar-branch-worktree`** · **`mstar-dispatch-gates`**。冲突时 **以 `mstar-harness-core` 为准**。

**摘要**：职责分层 → **`references/review-responsibility-boundaries.md`**。Leaf QC 执行 → **`mstar-roles/references/qc-specialist/`**。L4 验收 → **`mstar-roles/references/qa-engineer/`**。

# Morning Star QC Orchestration（PM · 编排层）

## 分派时机（与 plan / batch 对齐）

- **`Execution mode: sdd`**：全部 task + L2 task reviewers 完成后 → **强制 tri-review**（`QC mode: full tri-review`，**N=3**）。Assignment 须含 **branch review-package** 路径。PM 汇总 `qc-consolidated.md`。
- **`Execution mode: inline`**：单席 `qc-specialist` → `qc.md`（**N=1**），或按 hotfix 路由跳过。
- **After `Request Changes` (default)**：**Targeted re-review** — PM dispatches only seats that **raised** blocking findings; each updates **the same** `{PLAN_DIR}/reports/<plan-id>/qcN.md` (`## Revalidation`, update verdict). **Do not** spawn `qcN-rev2.md` on this path. Naming → **`mstar-plan-artifacts/references/plan-files-and-reports.md`** § QC 三审触发时机.
- **Full tri re-review (exception)**：Assignment **`QC re-review: full tri-review`** → new basenames (`qc1-rev2.md` …); PM marks **active wave** in consolidated decision.

## 三审身份与模型独立性门禁（PM 强制）

在 PM 发出 **initial** QC 三审后、进入汇总前：

- **Initial wave**：三个角色 ID 须为 `qc-specialist`、`qc-specialist-2`、`qc-specialist-3`；模型与宿主配置一致。
- **Targeted re-review**：仅校验 Assignment 列出的席位；映射错误 → `dispatch invalid`，重派。
- 并行 QC 退化为同模型且无法修复 → Status Update 标记 `degraded tri-review`；默认不放行。

## Residual Findings 留档门禁（PM）

- 阻断项修复后仍有 **Warning / Suggestion** 或技术债 → 必须留档；**`severity`** 仅允许 `mstar-plan-artifacts/references/status-and-residuals.md` 枚举。
- **Open SSOT**：`{HARNESS_DIR}/status.json` 根级 **`residual_findings[<plan-id>]`**；PM 在 consolidated 决策分配 **R1…** 并写入。关闭 → **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`**。
- 主 plan 仅作人类索引；不得作为唯一 SSOT。
- **`Approve with residuals`**：仅当无 open **Critical**；PM 汇总结论须含 residual 清单与跟踪位置。
- 未完成 residual 留档 → 不得进入 plan **Done**。

### Residual 关闭与验证

- R# 修复后：审查/QA 结论指向可复核证据；**`project-manager`** 或 **`qa-engineer`**（`QA gate: mandatory`）补全关闭字段后归档并从 open 列表移除。
- **`waived` / `superseded` / `duplicate`** 须在 `closure_note` 写清依据。

## PM consolidated 门禁（摘要）

Leaf reviewers apply verdict per **`mstar-roles/references/qc-specialist/report-template.md`**. PM **`qc-consolidated.md`** synthesizes tri (or single-seat `qc.md`) into one gate decision for implement fix waves and QA gate.

## 证据规则（PM · consolidated 输入）

- Critical 发现须含触发条件、影响范围、修复建议。
- 低置信度发现须含后续验证步骤。
- 跨任务重复模式应标记。
