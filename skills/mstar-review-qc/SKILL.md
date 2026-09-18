---
name: mstar-review-qc
description: "Morning Star QC orchestration — **SDD mandatory plan QC tri-review** (`{SDD_DIR}/review/qc1.md`…`qc3.md` + consolidated); inline/hotfix single-seat (`qc.md` in review bundle); PM dispatch timing, tri identity gate, residual registration contract, layer boundaries, durable plan summary. Leaf QC execution → **`mstar-roles/references/qc-specialist/`**. Per-task review is **`mstar-sdd`** (L2). Primary reader: **`project-manager`** when dispatching or consolidating QC."
---

## Load order（必读顺序）

**首次 Read 本 skill 时：必须先 Read `mstar-harness-core`。** 同仓检出与派发 → **`mstar-branch-worktree`** · **`mstar-dispatch-gates`**。冲突时 **以 `mstar-harness-core` 为准**。

**摘要**：职责分层 → **`references/review-responsibility-boundaries.md`**（**L3 = code reviewer / diff+logic；不跑 test/build**；运行时验证归 L1/L4）。Leaf QC 执行 → **`mstar-roles/references/qc-specialist/`**。L4 验收 → **`mstar-roles/references/qa-engineer/`**。

# Morning Star QC Orchestration（PM · 编排层）

## L3 是什么（派发前对齐）

- Plan QC seats are **reviewers**: assigned changed **diff / logic / risk** lenses and directly affected interfaces — same family as PR review, not a parallel QA test lane.
- **Do not** instruct QC in Assignment to “run the suite / build / lint to confirm” on shared tri cwd; that causes peer `Blocked` and collapses L3 into L4.
- Runtime proof stays with scoped **implementer evidence** and **`QA gate`** (targeted unit evidence only). `full tri-review` describes seats, not full-repository review. Scope SSOT → **`mstar-harness-core`** § 定向执行与验证边界; QC never broadens exploration or repeats unchanged L2 evidence.
- Retained `sdd evidence` bundles are review **inputs, not something QC executes**: QC reviews the code and the declared coverage rationale; it never runs `sdd evidence capture`, never repeats the recorded child, and a record's integrity/outcome is not acceptance — coverage stays `review-required` (command semantics → **`mstar-sdd`** `references/file-handoffs.md` § Verification evidence).

## 分派时机（与 plan / batch 对齐）

- **`Execution mode: sdd`**：全部 task + L2 task reviewers 完成后 → **强制 tri-review**（`QC mode: full tri-review`，**N=3**）。Assignment 须含 **branch review-package** 路径与 `{SDD_DIR}/review/qcN.md` report paths。PM 汇总 `{SDD_DIR}/review/qc-consolidated.md` 并回写主 plan durable summary。
- **`Execution mode: inline`**：单席 `qc-specialist` → `{SDD_DIR}/review/qc.md`（**N=1**），或按 hotfix 路由跳过。
- **After `Request Changes` (default)**：**Targeted re-review** — PM dispatches only seats that **raised** blocking findings; each updates **the same** `{SDD_DIR}/review/qcN.md` (`## Revalidation`, update verdict). **Do not** spawn `qcN-rev2.md` for targeted re-review. Naming → **`mstar-artifacts/references/plan-files-and-reports.md`** § QC 三审触发时机.
- **Three-seat re-review**：only when all three seats have affected findings. `QC re-review: full tri-review` denotes seat count, never broader scope; each seat still checks its findings and fix delta. New wave basenames may distinguish reports, but do not reopen unchanged review coverage.

> **Engine check (when available):** run `mstar review seats <assignment-file> [--mode sdd|inline|targeted] [--reviewers <role1,role2,...>]` (or `import { executionModeToN, assertTriIdentity } from "@mstar-harness/engine"` in a host hook) to map `Execution mode` to its QC seat count N above and assert tri identity. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## 三审身份与模型独立性门禁（PM 强制）

在 PM 发出 **initial** QC 三审后、进入汇总前：

- **Initial wave**：三个角色 ID 须为 `qc-specialist`、`qc-specialist-2`、`qc-specialist-3`；模型与宿主配置一致。
- **Targeted re-review**：仅校验 Assignment 列出的席位；映射错误 → `dispatch invalid`，重派。
- 并行 QC 退化为同模型且无法修复 → Status Update 标记 `degraded tri-review`；默认不放行。

## Findings 留档门禁（PM）

- 先读 Assignment **`Findings cleanup`**（`plans[].metadata.findings_cleanup` mirror 已删——Assignment 是唯一 mode 来源）→ **`mstar-artifacts/references/status-and-residuals.md`**「Findings cleanup modes」。
- **捕获契约（唯一权威）→ `mstar-project-governance`「Issue capture」**：QC 的 must-fix / 保留 findings 由**确认其结论的席位**落为 `{HARNESS_DIR}/store.db` 的 issue —— 计划内 `mstar plan issue-add`，计划外 `mstar issue add`；同一 finding 再次出现用 `mstar issue occurrence` 追加 occurrence，**不**新开第二个 issue。PM 席位在 consolidated 决策后捕获；leaf QC 席位**只回证据，不写 store**（本 skill 不复述捕获契约）。
- **`Findings cleanup: zero-residual`**（显式 opt-in）：可修的 **Warning / Suggestion / Critical** → **fix-now + targeted re-review**，**禁止**把可修项留为 open issue 后用 `Approve with residuals` 收口；**`nit`** 当场修或丢弃（不捕获）。仅**真 blocker-defer**（外部依赖 / 须下轮产品决策 / 用户本轮显式 defer + Durable Roadmap）可留 open，且**不含 `critical`**（不安全后果本次 merge 可达，见「Findings cleanup modes」）；`critical` 当场修复，或走显式 risk acceptance 并按 §4 关闭，**不得**作为批准遗留项。
- **`Findings cleanup: allow-residual`**（iteration Phase 2 / standalone / hotfix / inline 默认）：阻断项修复后仍有 **Warning / Suggestion** 或技术债 → 必须在离 InReview 前捕获为该 plan 的 **linked open issues**；**`Approve with residuals`** 仅当无 open **Critical**；PM 汇总结论与各报告面须披露 open 清单 —— 每条含 issue id + severity + 跟踪位置（close 面另含 blocker-defer 标记；无 open 时 `N/A — none open`）。
- **`severity`** 仅允许 `mstar-artifacts/references/status-and-residuals.md` 枚举。
- **关闭是独立授权动作**：只由 issue-store contract §4 的关闭权威执行（`resolved` / `waived` / `duplicate` / `superseded`；计划内 `mstar plan issue-close`）——捕获席位**不**自授关闭权，PM 不得把「已捕获」当作「已关闭」。
- 主 plan 仅作人类索引；不得作为唯一 SSOT。
- 未捕获确认 findings（`allow-residual`）或未清干净可修 findings（`zero-residual`）→ 不得进入 plan **Done**。

### Finding 关闭与验证

- 修复后：审查/QA 结论指向可复核证据；**`project-manager`** 或 **`qa-engineer`**（`QA gate: mandatory`）按 §4 关闭权威带上关闭证据关闭该 issue。
- **`waived` / `duplicate` / `superseded`** 须在关闭证据里写清依据（`waived` 另需 PM + user/architect alignment）。

## PM consolidated 门禁（摘要）

Leaf reviewers apply verdict per **`mstar-roles/references/qc-specialist/report-template.md`**. PM **`{SDD_DIR}/review/qc-consolidated.md`** synthesizes tri (or single-seat `qc.md`) into one gate decision for implement fix waves and QA gate, then records the durable summary in the main plan / workflow snapshot artifacts. The consolidated decision also discloses the open-findings situation — the issue list + each severity + tracking location (`N/A — none open` when none) — per the **`Findings cleanup`** duties (`mstar-artifacts`「Findings cleanup modes」); capture itself follows **`mstar-project-governance`「Issue capture」**.

### 覆盖语义（未提及 = 未审查）

- **未提及 = 未审查**：某 finding / severity 项 / 声明未被任何席位报告提及 → 不得在汇总中标记为已解决或通过；如实标注 `unreviewed`，仅对受影响项按需转 targeted re-review 或补充席位；不据此重审无关内容。
- **汇总层零注入**：consolidated 中每条发现可溯源到某 `qcN.md`；PM 不得在汇总层引入席位报告之外的新声明（PM 自身观察走独立 Status Update，不混入 gate 决策输入）。
- **Unconfirmed 传导**：任一席位 verdict = `Unconfirmed`（`report-template.md` 定义的证据通道失败态）→ gate 决策不得为 `Approve`——先补证据（重发 review-package / 修 diff 基线）再收敛；受影响席位走既有 targeted re-review 机制（同 `qcN.md` `## Revalidation` 原位更新 verdict），不新增 re-review 形态、不改 N 规则。

### 席位预算与截断（PM）

- **座次不放宽范围。** N=3 只增加视角：每个席位仍只审其 diff pack 与直接影响接口，预算也不因席位增加而变宽。PM 用 Assignment `Budget` 收紧；默认与数字 SSOT → **`mstar-harness-core`** § 定向执行与验证边界。
- **截断报告保留 verdict。** 席位因触达预算而声明 `Truncated coverage:` 时，其 verdict 有效，PM **不得**因此升级为 `Unconfirmed`——`Unconfirmed` 仍是证据通道失败态（见上条传导规则）。
- **未覆盖范围不改写门禁。** 席位 verdict 只涵盖其已审范围：当 Assignment 范围未被完整覆盖时，**gate decision 不得为 `Approve`**。PM 二选一——把未覆盖范围按 targeted re-review 重新派发（席位在预算内补完），或显式收窄 `Review range` 并把收窄依据记入 `qc-consolidated.md` 后再收敛。截断范围仍按「未提及 = 未审查」在 `qc-consolidated.md` 中如实标注 `unreviewed`，PM 不重审无关内容来补全它。

> **Engine check (when available):** run `mstar qc validate-report <report.md>` on each seat report (and `mstar dispatch validate <assignment-file>` for the Assignment-side round-bounding gate — `Budget` + `Return shape` on review / audit rounds, plus the canonical **`Task budget (implement / ops rounds)`** capacity field on non-review / non-audit rounds; field guidance → `mstar-roles/references/project-manager/dispatch-and-assignment.md`; the review caps above are unchanged; or `import { validateQcReport } from "@mstar-harness/engine"` in a host hook). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## 证据规则（PM · consolidated 输入）

- Critical 发现须含触发条件、影响范围、修复建议。
- 低置信度发现须含后续验证步骤。
- 跨任务重复模式应标记。

## Workflow

QC 编排主链：plan 全部 task + L2 完成后 → PM 按 `Execution mode` 定座次（sdd 强制 tri **N=3** / inline 单席 **N=1**）→ 同一条消息发满 N 个 QC Assignment（含 branch review-package + `{SDD_DIR}/review/qcN.md` report paths）→ 席位按 `references/qc-specialist/report-template.md` 落盘 verdict → PM 汇总 `{SDD_DIR}/review/qc-consolidated.md`（覆盖语义：**未提及 = 未审查**；汇总层零注入）→ `Request Changes` 走 targeted re-review（同 `qcN.md` `## Revalidation` 原位更新 verdict）→ findings 按 `Findings cleanup` 捕获为 issue / 按 §4 关闭 → durable summary 回写主 plan。

## References

- Leaf QC 执行（checklist / 报告模板 / 透镜）→ **`mstar-roles/references/qc-specialist/`**
- 捕获契约（唯一权威）→ **`mstar-project-governance`「Issue capture」**
- Per-task review（L2，implement 波次内）→ **`mstar-sdd`**
- Review bundle 命名与 QC 触发时机 → **`mstar-artifacts/references/plan-files-and-reports.md`**
