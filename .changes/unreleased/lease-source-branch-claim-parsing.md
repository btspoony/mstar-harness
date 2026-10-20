---
category: Harness
packages: root
---

- **A `create <branch> from <base>` claim records its branch, not the claim.** `plan prepare` resolved `workingBranch` by storing the Assignment's value verbatim, so a row prepared from `Working branch: create feature/x from main` recorded `create feature/x from main` as `metadata.working_branch`; every `source_branch` derived from it then failed the delivery-source comparison and the workflow wedged at completion (`I-000280`). `prepare` now resolves the claim through the engine's single Assignment branch grammar: the documented `create <branch> from <base>` form records `<branch>`, a plain branch name is stored unchanged, and any other multi-word value is refused with `coordination.invalid-input` (field `workingBranch`, the value, and the accepted forms) instead of being recorded as a scope. Already-persisted leases are untouched — a wedged row is recovered by re-running `plan prepare`.
- **Regression coverage.** `packages/engine/src/execution-workflow.test.ts` drives a create-from claim through `prepare` → `progress` → `complete`, asserting the recorded `source_branch` and `Done`, plus the plain-branch and refused-claim cases.

<!-- CN -->
- **`create <branch> from <base>` 声明现在记录分支本身，而不是声明字符串。** `plan prepare` 之前将 `workingBranch` 原样存储，因此以 `Working branch: create feature/x from main` 准备的行走 `metadata.working_branch` 里记的是 `create feature/x from main`；由此派生的每个 `source_branch` 都通不过交付源比较，workflow 卡在完成阶段（`I-000280`）。`prepare` 现在通过引擎唯一的 Assignment 分支文法解析声明：文档化的 `create <branch> from <base>` 形式记录 `<branch>`，纯分支名原样保存，其他多词值以 `coordination.invalid-input` 拒绝（details 给出 `workingBranch` 字段、该值与接受的形式），不再被当作 scope 记录。已持久化的 lease 不改写——卡住的行通过重新执行 `plan prepare` 恢复。
- **回归覆盖。** `packages/engine/src/execution-workflow.test.ts` 让 create-from 声明走完 `prepare` → `progress` → `complete`，断言记录的 `source_branch` 与 `Done`，并覆盖纯分支名与拒绝声明两种情形。
