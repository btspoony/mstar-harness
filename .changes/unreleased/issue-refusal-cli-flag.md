---
category: Changed
packages: root, commands
---

- **Issue revision conflicts** now include recovery instructions that preserve the original invocation's `--operation-id`, `--actor`, and payload while replacing `--expect <current-revision>`; CAS help is available only for the issue verbs whose engine path enforces the revision CAS (triage, close, waive, duplicate, supersede, reopen, link).

<!-- CN -->
- **Issue revision 冲突**现在会提供保留原命令的 `--operation-id`、`--actor` 与 payload、仅替换 `--expect <current-revision>` 的恢复说明；CAS 帮助仅对引擎实际执行 revision CAS 的 issue 动词显示（triage、close、waive、duplicate、supersede、reopen、link）。
