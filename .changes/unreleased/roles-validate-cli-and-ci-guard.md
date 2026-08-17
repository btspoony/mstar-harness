---
packages: cli, root
---

- **`mstar roles validate`**: new CLI command exposing the mstar-roles skill-dir checks — a thin mirror of the dsh seam `validateRolesState`: `validateRoleMapping` on the roles dir plus `lintLoadOrder` over every sibling `mstar-*` skill, with unreadable siblings skipped best-effort. Defaults resolve through the project-root path resolution (`--roles-dir` → `skills/mstar-roles`, `--skills-dir` → its parent); exit 0 prints OK + counts, violations exit 1 with one row each. `skills/mstar-roles/SKILL.md` engine-check callout now cites the CLI command.
- **drift-lint Guard 4**: roles/load-order corpus guard in `scripts/drift-lint.ts` (plan 003 Task 2) — `lintLoadOrder` over every `skills/mstar-*/SKILL.md` text (each must declare `mstar-harness-core` in a Load Order / First action section) plus `validateRoleMapping` on `skills/mstar-roles` (mapping / parameter tables must resolve against the on-disk `references/*.md` layout); CI drift-lint now fails on role-table or load-order regressions.

<!-- CN -->
- **`mstar roles validate`**：新增 CLI 命令，暴露 mstar-roles skill 目录检查 —— dsh seam `validateRolesState` 的薄镜像：对 roles 目录运行 `validateRoleMapping`，并对每个同级 `mstar-*` skill 运行 `lintLoadOrder`，不可读的同级 skill 尽力跳过。默认路径走项目根解析（`--roles-dir` → `skills/mstar-roles`，`--skills-dir` → 其父目录）；exit 0 打印 OK 与计数，违规 exit 1 且每行一条。`skills/mstar-roles/SKILL.md` 的 engine-check callout 现改为引用 CLI 命令。
- **drift-lint Guard 4**：`scripts/drift-lint.ts` 中的 roles/load-order corpus 护栏（plan 003 Task 2）—— 对每个 `skills/mstar-*/SKILL.md` 文本运行 `lintLoadOrder`（每个都必须在 Load Order / First action 章节声明 `mstar-harness-core`），并对 `skills/mstar-roles` 运行 `validateRoleMapping`（映射/参数表必须与磁盘上的 `references/*.md` 布局一致）；CI drift-lint 现会在角色表或 load-order 回归时失败。
