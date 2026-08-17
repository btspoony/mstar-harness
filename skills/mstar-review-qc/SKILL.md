---
name: mstar-review-qc
description: "Morning Star QC orchestration — **SDD mandatory plan QC tri-review** (`{SDD_DIR}/review/qc1.md`…`qc3.md` + consolidated); inline/hotfix single-seat (`qc.md` in review bundle); PM dispatch timing, tri identity gate, residual registration contract, layer boundaries, durable plan summary. Leaf QC execution → **`mstar-roles/references/qc-specialist/`**. Per-task review is **`mstar-sdd`** (L2). Primary reader: **`project-manager`** when dispatching or consolidating QC."
---

## Load order（必读顺序）

**首次 Read 本 skill 时：必须先 Read `mstar-harness-core`。** 同仓检出与派发 → **`mstar-branch-worktree`** · **`mstar-dispatch-gates`**。冲突时 **以 `mstar-harness-core` 为准**。

**摘要**：职责分层 → **`references/review-responsibility-boundaries.md`**（**L3 = code reviewer / diff+logic；不跑 test/build**；运行时验证归 L1/L4）。Leaf QC 执行 → **`mstar-roles/references/qc-specialist/`**。L4 验收 → **`mstar-roles/references/qa-engineer/`**。

# Morning Star QC Orchestration（PM · 编排层）

## L3 是什么（派发前对齐）

- Plan QC seats are **reviewers**: whole-branch **diff / logic / risk** lenses — same family as PR review, not a parallel QA test lane.
- **Do not** instruct QC in Assignment to “run the suite / build / lint to confirm” on shared tri cwd; that causes peer `Blocked` and collapses L3 into L4.
- Runtime proof stays with **implementer evidence** and **`QA gate`** (`qa-engineer` or PM acceptance).

## 分派时机（与 plan / batch 对齐）

- **`Execution mode: sdd`**：全部 task + L2 task reviewers 完成后 → **强制 tri-review**（`QC mode: full tri-review`，**N=3**）。Assignment 须含 **branch review-package** 路径与 `{SDD_DIR}/review/qcN.md` report paths。PM 汇总 `{SDD_DIR}/review/qc-consolidated.md` 并回写主 plan durable summary。
- **`Execution mode: inline`**：单席 `qc-specialist` → `{SDD_DIR}/review/qc.md`（**N=1**），或按 hotfix 路由跳过。
- **After `Request Changes` (default)**：**Targeted re-review** — PM dispatches only seats that **raised** blocking findings; each updates **the same** `{SDD_DIR}/review/qcN.md` (`## Revalidation`, update verdict). **Do not** spawn `qcN-rev2.md` for targeted re-review. Naming → **`mstar-plan-artifacts/references/plan-files-and-reports.md`** § QC 三审触发时机.
- **Full tri re-review (exception)**：Assignment **`QC re-review: full tri-review`** → new basenames (`qc1-rev2.md` …); PM marks **active wave** in consolidated decision.

> **Engine check (when available):** run `mstar review seats <assignment-file> [--mode sdd|inline|targeted] [--reviewers <role1,role2,...>]` (or `import { executionModeToN, assertTriIdentity } from "@mstar-harness/engine"` in a host hook) to map `Execution mode` to its QC seat count N above and assert tri identity. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## 三审身份与模型独立性门禁（PM 强制）

在 PM 发出 **initial** QC 三审后、进入汇总前：

- **Initial wave**：三个角色 ID 须为 `qc-specialist`、`qc-specialist-2`、`qc-specialist-3`；模型与宿主配置一致。
- **Targeted re-review**：仅校验 Assignment 列出的席位；映射错误 → `dispatch invalid`，重派。
- 并行 QC 退化为同模型且无法修复 → Status Update 标记 `degraded tri-review`；默认不放行。

## Residual Findings 留档门禁（PM）

- 先读 Assignment **`Findings cleanup`**（及可选 `plans[].metadata.findings_cleanup`）→ **`mstar-plan-artifacts/references/status-and-residuals.md`**「Findings cleanup modes」。
- **`Findings cleanup: zero-residual`**（iteration Phase 2 默认）：可修 **Warning / Suggestion / Critical** → **fix-now + targeted re-review**，**禁止**把可修项登记为 open R# 或用 `Approve with residuals` 收口；**`nit`** 当场修或丢弃（无 R#）。仅 **真 blocker-defer**（外部依赖 / 须下轮产品决策 / 用户本轮显式 defer + Durable Roadmap）可登记 open R#（`decision: defer`）。此时 `Approve with residuals` **仅**允许剩余项全是该类 defer。
- **`Findings cleanup: allow-residual`**（standalone / hotfix / inline 默认）：阻断项修复后仍有 **Warning / Suggestion** 或技术债 → 必须留档；**`Approve with residuals`** 仅当无 open **Critical**；PM 汇总结论须含 residual 清单与跟踪位置。
- **`severity`** 仅允许 `mstar-plan-artifacts/references/status-and-residuals.md` 枚举。
- **Open SSOT**：`{HARNESS_DIR}/status.json` 根级 **`residual_findings[<plan-id>]`**；PM 在 consolidated 决策分配 **R1…** 并写入。关闭 → **`{HARNESS_DIR}/archived/residuals/<plan-id>.json`**。
- 主 plan 仅作人类索引；不得作为唯一 SSOT。
- 未完成 residual 留档（`allow-residual`）或未清干净可修 findings（`zero-residual`）→ 不得进入 plan **Done**。

### Residual 关闭与验证

- R# 修复后：审查/QA 结论指向可复核证据；**`project-manager`** 或 **`qa-engineer`**（`QA gate: mandatory`）补全关闭字段后归档并从 open 列表移除。
- **`waived` / `superseded` / `duplicate`** 须在 `closure_note` 写清依据。

## PM consolidated 门禁（摘要）

Leaf reviewers apply verdict per **`mstar-roles/references/qc-specialist/report-template.md`**. PM **`{SDD_DIR}/review/qc-consolidated.md`** synthesizes tri (or single-seat `qc.md`) into one gate decision for implement fix waves and QA gate, then records the durable summary in the main plan/status artifacts.

### 覆盖语义（未提及 = 未审查）

- **未提及 = 未审查**：某 finding / severity 项 / 声明未被任何席位报告提及 → 不得在汇总中标记为已解决或通过；如实标注 `unreviewed`，按需转 targeted re-review 或补充席位。
- **汇总层零注入**：consolidated 中每条发现可溯源到某 `qcN.md`；PM 不得在汇总层引入席位报告之外的新声明（PM 自身观察走独立 Status Update，不混入 gate 决策输入）。
- **Unconfirmed 传导**：任一席位 verdict = `Unconfirmed`（`report-template.md` 定义的证据通道失败态）→ gate 决策不得为 `Approve`——先补证据（重发 review-package / 修 diff 基线）再收敛；受影响席位走既有 targeted re-review 机制（同 `qcN.md` `## Revalidation` 原位更新 verdict），不新增 re-review 形态、不改 N 规则。

## 证据规则（PM · consolidated 输入）

- Critical 发现须含触发条件、影响范围、修复建议。
- 低置信度发现须含后续验证步骤。
- 跨任务重复模式应标记。

## Workflow

QC 编排主链：plan 全部 task + L2 完成后 → PM 按 `Execution mode` 定座次（sdd 强制 tri **N=3** / inline 单席 **N=1**）→ 同一条消息发满 N 个 QC Assignment（含 branch review-package + `{SDD_DIR}/review/qcN.md` report paths）→ 席位按 `references/qc-specialist/report-template.md` 落盘 verdict → PM 汇总 `{SDD_DIR}/review/qc-consolidated.md`（覆盖语义：**未提及 = 未审查**；汇总层零注入）→ `Request Changes` 走 targeted re-review（同 `qcN.md` `## Revalidation` 原位更新 verdict）→ residual 按 `Findings cleanup` 留档 / 关闭 → durable summary 回写主 plan。

## References

- Leaf QC 执行（checklist / 报告模板 / 透镜）→ **`mstar-roles/references/qc-specialist/`**
- Per-task review（L2，implement 波次内）→ **`mstar-sdd`**
- Review bundle 命名与 QC 触发时机 → **`mstar-plan-artifacts/references/plan-files-and-reports.md`**
