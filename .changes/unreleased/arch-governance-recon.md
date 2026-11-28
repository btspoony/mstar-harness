---
category: Added
packages: root
---

- Added a **recon gate** before a governance batch: `/codebase-arch-governance` now reads the codebase into six inventories — architecture map, dependency graph, state-ownership map, duplicate implementations, technology options, spec deviations — and a recon that cannot be completed names its missing evidence instead of selecting a batch.
- Named those inventories in `mstar-coding-behavior` → `references/architecture-governance.md` § Recon, with `file:line` (or `spec:line ↔ code:line`) evidence, recorded in the round's plan or the reused audit report.
- `dry-run` now performs the read-only recon and returns the six inventories plus the ranked candidates, still writing nothing.

<!-- CN -->
- 新增治理批次前的**侦察门禁**：`/codebase-arch-governance` 先把代码库读成六项清单——架构图、依赖图、状态归属图、重复实现清单、技术选型清单、规格偏差清单；侦察无法完成时列出缺失证据，而不是挑一个候选批次。
- 六项清单写入 `mstar-coding-behavior` → `references/architecture-governance.md` § Recon，证据形式为 `file:line`（偏差为 `spec:line ↔ code:line`），落在本轮计划或被复用的审计报告里。
- `dry-run` 现在执行只读侦察，在回复中返回六项清单与排序后的候选，仍然不写任何文件。
