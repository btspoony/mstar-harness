---
category: Harness
packages: root, opencode, engine
---

- Hoisted the shared plan-output contract out of `references/codebase-audit.md` into the `mstar-audit` SKILL.md core as **`## Plan output (all variants)`**: write-only-on-selection boundary, `{PLAN_DIR}/audit-<date>/` layout (README index + numbered plan files), `plan.main.md` + plan-quality-bar enrichment, Status-block fields + status values, `git rev-parse --short HEAD` commit stamp, and the four handoff steps (promote / state machine / fast-track Prepare / SDD or inline dispatch). Both variants (`codebase-audit`, `pr-review`) and both commands (`/codebase-audit`, `/pr-deep-review`) now cite the core section; `pr-review.md` § Plan output carries no `codebase-audit.md` cites. Engine audit Status-block and scaffold validators repoint their spec cites to `mstar-audit SKILL.md § Plan output`, and `pr-review.md` § Evidence rules now cites `finding-format.md` § What disqualifies a finding. Closes residual R1 (hoist when a third variant arrives — that condition is now met by the `pr` variant) early.

<!-- CN -->
- 将共享的 plan-output 契约从 `references/codebase-audit.md` 上提至 `mstar-audit` SKILL.md 核心，新增 **`## Plan output (all variants)`** 章节：仅用户选定后才写入的边界、`{PLAN_DIR}/audit-<date>/` 目录布局（README 索引 + 编号 plan 文件）、`plan.main.md` + plan-quality-bar 增强、Status 块字段与状态值、`git rev-parse --short HEAD` 提交戳、以及四步 handoff（promote / 状态机 / fast-track Prepare / SDD 或 inline 派发）。两个变体（`codebase-audit`、`pr-review`）与两个命令（`/codebase-audit`、`/pr-deep-review`）均改引核心章节；`pr-review.md` § Plan output 不再引用 `codebase-audit.md`。Engine audit Status-block 与 scaffold 校验器的 spec 引用同步指向 `mstar-audit SKILL.md § Plan output`；`pr-review.md` § Evidence rules 新增 `finding-format.md` § What disqualifies a finding 引用。提前关闭 residual R1（第三个变体到来时上提——现由 `pr` 变体满足）。
