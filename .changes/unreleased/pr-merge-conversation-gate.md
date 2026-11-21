---
category: Fixed
packages: root
---

- Added a hard pre-merge review-thread gate (§5.3a): every unresolved thread on the current head — human or bot, any merge class — blocks the merge regardless of policy or an owner merge instruction. The PM must list each unresolved thread with its author and location, then obtain a second explicit confirmation before merging; a generic "merge it" is not a per-thread waiver.
- Wired the gate into the merge authorization predicate, the Phase 5 checklist item, the merge executor, and the project-manager NEVER rules, so a checklist-only reading of "threads resolved" no longer leaves merging possible.
- Added `mstar pr-review thread-gate --pr <n>`: it enumerates every review thread on the current head and refuses the merge while any stays unresolved; `--confirm` verifies a `{head, confirmations: 2, threads: [...]}` record against that same head, so a merge after a push or a new thread loses its authority.

<!-- CN -->
- 新增 merge 前 review thread 硬门禁（§5.3a）：当前 head 上任何未解决 thread——人类或 bot、任何 merge class——都阻断合并，policy 与 owner 的合并指令都不能替代。PM 必须逐条列出作者与位置，取得第二次明确确认后才可合并；笼统的「合并」不构成逐条 waive。
- 该门禁同时接入合并授权谓词、Phase 5 checklist 项、merge 执行者与 project-manager 的 NEVER 规则，避免「threads resolved」仅作为 checklist 项而留下合并口子。
- 新增 `mstar pr-review thread-gate --pr <n>`：枚举当前 head 上全部 review thread，仍有未解决项时拒绝合并；`--confirm` 校验 `{head, confirmations: 2, threads: [...]}` 记录是否绑定同一 head，push 或新 thread 出现后原确认自动失效。
