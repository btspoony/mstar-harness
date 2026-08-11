---
category: Harness
packages: root, opencode, engine
---

- Added a **`code-reviewer` role** (L2): a read-only seat for SDD per-task review and `Task category: audit` / `mstar-audit` execution. PM entry stays `/codebase-audit`; large-repo fan-out uses read-only `scout` / `explore` via Assignment `Delegation: allowed (scout/explore only, read-only)`.
- Wired `code-reviewer` into SDD per-task dispatch (named L2 reviewer id, `generic` fallback), audit routing (`mstar-harness-core`, `commands/codebase-audit.md`), engine `ROLE_MAPPING` (13→14), and the bilingual README role tables; `qc-specialist*` (L3) / QA (L4) semantics unchanged.

<!-- CN -->
- 新增 **`code-reviewer` 角色（L2）**：只读席位，承担 SDD per-task 审查与 `Task category: audit` / `mstar-audit` 执行。PM 入口仍为 `/codebase-audit`；大型仓库经 Assignment `Delegation: allowed (scout/explore only, read-only)` 扇出只读 `scout` / `explore`。
- 将 `code-reviewer` 接入 SDD per-task 派发（具名 L2 reviewer id，`generic` 回退）、audit 路由（`mstar-harness-core`、`commands/codebase-audit.md`）、engine `ROLE_MAPPING`（13→14）与双语 README 角色表；`qc-specialist*`（L3）/ QA（L4）语义不变。
