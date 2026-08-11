---
category: Harness
packages: root
---

- **dsh plugin**: panel F4.3 iteration-zone (plan `20260811-panel-f4-iteration-zone`) — the 任务迭代页 expanded head is now a LEFT-RIGHT SPLIT: the branch panel (`data-iteration-head-branches`) sits in the small left half and the Steps row (`data-iteration-head-steps`) in the large right half (`data-iteration-head-split`, DOM order branches-before-steps; narrow widths stack at the existing 860px breakpoint; no branch panel when there is no active iteration). The current step is now compass-driven: while the steering compass is `status: active` (Phase 1 in flight — catalog `compassStatus` field), Step 1 (iteration-start) renders CURRENT with verdict `unknown` and NO PASS/FAIL badge (Phase 1 has no gate verdict), next = Step 2; `locked` / missing `compassStatus` keeps the existing gate-transition-driven Step 2→4 + gate badge. Every step reserves a fixed-height verdict seat (`data-step-verdict-seat`) so centered content groups align — the PASS/FAIL badge no longer skews the step blocks. Docs synced (dsh.md SSOT + bundle mirror + READMEs + knowledge update-only).

<!-- CN -->
- **dsh 插件**：面板 F4.3 迭代区（plan `20260811-panel-f4-iteration-zone`）——「任务迭代」页展开态头部改为**左右分栏**：分支面板（`data-iteration-head-branches`）居左小半、Steps 区（`data-iteration-head-steps`）居右大半（`data-iteration-head-split`，DOM 序 branches 在前；窄宽于既有 860px 断点回退堆叠；无激活迭代时不渲染分支面板）。当前步改为 compass 驱动：steering compass `status: active`（Phase 1 进行中——catalog `compassStatus` 字段）时 Step 1（iteration-start）渲染为**当前步**且 verdict 为 `unknown`、**无 PASS/FAIL 徽标**（Phase 1 无 gate 判定），next = Step 2；`locked` / 缺失 `compassStatus` 保持既有 gate transition 驱动的 Step 2→4 + 徽标；每一步预留固定高度 verdict 座（`data-step-verdict-seat`）使居中内容组对齐——PASS/FAIL 徽标不再歪斜、不再推挤 Step 块对齐。文档已同步（dsh.md SSOT + bundle 镜像 + READMEs + 知识库仅更新）。
