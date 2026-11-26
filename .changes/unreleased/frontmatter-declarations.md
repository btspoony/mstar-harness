---
category: Breaking
packages: root, engine, commands
---

- **One declaration layer**: a plan, an Assignment, a task brief and a PM acceptance report declare their machine-read fields in a `---`-fenced front matter block read by the shared document schema — never a private field list per surface, and never a scan of the body.
- **Assignment write homes**: an `Assignment file:` pointer resolves by identity — plan → `{SDD_DIR}/assignments/`, iteration → `{ITERATION_DIR}/<id>/assignments/`, workflow → `{WORKFLOW_DIR}/<id>/assignments/` (precedence plan → iteration → workflow) — and `{HARNESS_DIR}/assignments/` stays a read-only fourth source the resolver accepts while no engine path creates a file there.
- **No fallback**: a document carrying its fields as `**Label**:` body lines declares nothing. An inline one is refused `dispatch.assignment.legacy-format` terminally (independent of the `soft` / `hard` setting, advisory only on a host with no refusal channel), and a pointer at one resolves the file and refuses the same code. Migrate by rewriting the document as front matter with the snake_case keys (`execute_as`, `working_branch`, `plan_id`, …) or by pointing `Assignment file: <absolute path>` at the rewritten document — appending a fence to the old labels does not help.
- **Self-declaring briefs**: `mstar sdd` now writes each task brief with `plan_id`, `task` and `files` front matter; the sliced body is byte-identical.
- **`--type acceptance`**: `mstar lint <report.md> --type acceptance` validates `plan_id`, `gate`, `verdict` and `generated_at` through the shared schema (`gate: pm-acceptance`; `verdict` one of the four PM verdict values), and the acceptance template opens with that block.
- **Corpus**: the skills and host documents name the front matter shape once per owning topic and point at `mstar-roles/references/project-manager/dispatch-and-assignment.md` § Assignment Template (Canonical) instead of restating a field list.

<!-- CN -->
- **只有一层声明**：plan、Assignment、task brief 与 PM acceptance report 的机器读取字段一律写在 `---` 包围的 front matter 中，由共享文档 schema 读取——不允许每个 surface 自带字段表，也不再扫描正文。
- **Assignment 写入位置**：`Assignment file:` 指针按 identity 解析——plan → `{SDD_DIR}/assignments/`，iteration → `{ITERATION_DIR}/<id>/assignments/`，workflow → `{WORKFLOW_DIR}/<id>/assignments/`（precedence plan → iteration → workflow）——`{HARNESS_DIR}/assignments/` 仍为 resolver 接受的第四来源且**只读**，任何引擎路径都不在此新建文件。
- **不再回退**：把字段写成 `**Label**:` 正文行的文档不再声明任何字段。内联的此类文档以 `dispatch.assignment.legacy-format` 被终局拒绝（与 `soft` / `hard` 设置无关，仅在完全没有拒绝通道的宿主上降为 advisory）；指针指向此类文件时同样解析该文件并以同一错误码拒绝。迁移方式是改写为 front matter 的 snake_case 键（`execute_as`、`working_branch`、`plan_id` 等），或让 `Assignment file: <绝对路径>` 指向改写后的文档——给旧标签补一个围栏没有用。
- **brief 自带声明**：`mstar sdd` 现在为每份 task brief 写入 `plan_id`、`task`、`files` front matter；切出的正文逐字不变。
- **`--type acceptance`**：`mstar lint <report.md> --type acceptance` 经共享 schema 校验 `plan_id`、`gate`、`verdict`、`generated_at`（`gate: pm-acceptance`；`verdict` 取四个 PM verdict 值之一），acceptance 模板以其开头。
- **语料**：skills 与宿主文档在各自的 owning topic 只陈述一次 front matter 形状，其余改为指向 `mstar-roles/references/project-manager/dispatch-and-assignment.md` § Assignment Template (Canonical)，不再复述字段表。
