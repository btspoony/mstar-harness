---
category: Harness
packages: root
---

- QC seat Assignments now require a **concrete report path** (`QC report path`) regardless of `Execution mode`: the seat itself writes its report file (e.g. `{SDD_DIR}/review/qc.md`); `N/A` is legal only when the Assignment explicitly declares conversation-only review with no plan row.
- Updated `mstar-roles/references/project-manager/dispatch-and-assignment.md` (Assignment field contract) and `mstar-review-qc/SKILL.md` (inline mode line) so coordinators no longer transcribe seat reports into `qc-round*.md` evidence files.
- Routed the dsh QC channels by the field (`mstar-host/references/dsh.md` § QC default, `dsh-workflow-scripts.md` § `mstar-qc-tri`): plan-backed QC seats that must write their report use a writable channel; the read-only `workflow` fan-out carries the tri only when the Assignment declares conversation-only review, with the caller persisting the returned envelopes.

<!-- CN -->
- QC 席位 Assignment 现在无论 `Execution mode` 如何都必须给出**具体报告路径**（`QC report path`）：由席位自己写入报告文件（如 `{SDD_DIR}/review/qc.md`）；仅当 Assignment 显式声明 conversation-only review 且无 plan row 时才允许 `N/A`。
- 更新 `mstar-roles/references/project-manager/dispatch-and-assignment.md`（Assignment 字段契约）与 `mstar-review-qc/SKILL.md`（inline 模式行），避免 coordinator 转录席位报告为 `qc-round*.md` 证据文件。
- 按 `QC report path` 字段路由 dsh QC 通道（`mstar-host/references/dsh.md` § QC default、`dsh-workflow-scripts.md` § `mstar-qc-tri`）：需自写报告的 plan-backed QC 席位走可写通道；只读 `workflow` fan-out 仅在 Assignment 显式声明 conversation-only review 时承载 tri，由调用方持久化返回的 envelope。
