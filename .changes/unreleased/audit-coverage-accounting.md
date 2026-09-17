---
category: Harness
packages: root
---

- Full codebase audit reports now close with a Coverage table: one row per material review question (surface × boundary/invariant × subsystem × category), with exactly five final statuses — `covered` requires a reviewed `file:line` plus the invariant checked and the observed result; every non-covered row requires a concrete reason, and blocked-before-read or prior-evidence-only rows are represented honestly instead of forced into false evidence. Statuses are `covered` (examined, not clean), `blocked`, `deferred`, `out_of_scope`, and `not_applicable`; the closing summary names gaps already in the table with no numeric tallies or aggregate path ledgers. Coverage is reviewer-checked markdown: the `mstar audit scaffold` command rebuilds the index without preserving or validating it, so prior coverage must be read and re-reconciled after each scaffold, and no engine shape validation is claimed.

<!-- CN -->
- 全代码库审计报告现以 Coverage 表收尾：每个实质审查问题一行（表面 × 边界/不变量 × 子系统 × 类别），恰好五个最终状态——`covered` 要求给出实际读过的 `file:line`、所检查的不变量与观察结果；每个非 covered 行都必须给出具体理由，读前被阻塞或仅有先前证据的行如实呈现，而非编造证据。五个状态为 `covered`（已检查，不等于干净）、`blocked`、`deferred`、`out_of_scope`、`not_applicable`；收尾摘要只点名表中已有的缺口，不出现数字统计或聚合路径账本。Coverage 是由审查者核对的内容：`mstar audit scaffold` 重建索引时既不保留也不校验它，因此每次脚手架后须先读出先前 Coverage 再重新对账，且不得宣称存在引擎级形状校验。
