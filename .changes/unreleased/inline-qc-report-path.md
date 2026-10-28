---
category: Harness
packages: root
---

- QC seat Assignments now require a **concrete report path** (`QC report path`) regardless of `Execution mode`: the seat itself writes its report file (e.g. `{SDD_DIR}/review/qc.md`); `N/A` is legal only when the Assignment explicitly declares conversation-only review with no plan row.
- Updated `mstar-roles/references/project-manager/dispatch-and-assignment.md` (Assignment field contract) and `mstar-review-qc/SKILL.md` (inline mode line) so coordinators no longer transcribe seat reports into `qc-round*.md` evidence files.

<!-- CN -->
- QC 席位 Assignment 现在无论 `Execution mode` 如何都必须给出**具体报告路径**（`QC report path`）：由席位自己写入报告文件（如 `{SDD_DIR}/review/qc.md`）；仅当 Assignment 显式声明 conversation-only review 且无 plan row 时才允许 `N/A`。
- 更新 `mstar-roles/references/project-manager/dispatch-and-assignment.md`（Assignment 字段契约）与 `mstar-review-qc/SKILL.md`（inline 模式行），避免 coordinator 转录席位报告为 `qc-round*.md` 证据文件。
