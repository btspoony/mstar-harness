---
category: Harness
packages: root,commands,engine
---

- **`mstar status validate` answers with current state, not history.** The two top-level terminal mirrors are gone (they duplicated `data.authority` byte for byte), and a closed lifecycle is published as an identity row `{ id, status, revision }` in `data.authority.terminalUnregistered[]` / `data.authority.terminalAdoptions[]`. The root token (`data.token`), workflow tokens (`data.workflows[].token`) and plan tokens (`data.authority.workflows[].planTokens[<planId>]`) are unchanged. On the reference control root the output fell from 172,762 B to 20,604 B and now grows with the terminal count instead of the recorded history.
- **`mstar catalog list` stops disclosing the filesystem per row.** `absolutePath` and `sourceHash` are projected out of a page (50 rows: 41,429 B → 32,213 B on the reference control root); `catalog show`, `catalog export` and the dashboard keep the full entity.
- **A terminal CAS expectation is derived, never published.** `mstar session recover --expect` is optional like `workflow reopen` and `workflow adopt-terminal`: an omitted expectation resolves the addressed header's current token inside the guarded transaction, so the Phase-6 held-lease release no longer needs a published token. The `workflow.reopen` contract text and the `PHASE6_DANGLING_LEASE` recovery name the identity row and the derived path.
- Updated the `mstar-use-cli` references (`status-and-registers.md`, `plan-and-workflow.md`) to the new token locations and the derived expectation.

<!-- CN -->
- **`mstar status validate` 改为返回当前状态而非历史。** 顶层两个 terminal 镜像已删除（与 `data.authority` 逐字节重复），关闭的 lifecycle 仅以身份行 `{ id, status, revision }` 发布在 `data.authority.terminalUnregistered[]` / `data.authority.terminalAdoptions[]`。root token（`data.token`）、workflow token（`data.workflows[].token`）与 plan token（`data.authority.workflows[].planTokens[<planId>]`）保持不变。参考控制根输出由 172,762 B 降至 20,604 B，且随 terminal 数量而非记录历史增长。
- **`mstar catalog list` 不再逐行泄露文件系统信息。** `absolutePath` 与 `sourceHash` 已从分页结果中移除（参考控制根 50 行：41,429 B → 32,213 B）；`catalog show`、`catalog export` 与 dashboard 仍返回完整条目。
- **terminal 的 CAS 期望改为自行推导。** `mstar session recover --expect` 与 `workflow reopen`、`workflow adopt-terminal` 一致改为可选：省略时在受保护事务内推导目标 header 的当前 token，Phase-6 held-lease 释放不再需要已发布的 token。`workflow.reopen` 契约文本与 `PHASE6_DANGLING_LEASE` 修复指引同步改为身份行 + 推导路径。
- 更新 `mstar-use-cli` 参考文档（`status-and-registers.md`、`plan-and-workflow.md`）的 token 位置与推导规则。
