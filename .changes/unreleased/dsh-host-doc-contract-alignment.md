---
category: Harness
packages: root, dsh
---

- **The dsh delegation contract now states channel once, in one place.** `skills/mstar-host/references/dsh.md` defers its PM-dispatch, SDD-implement and 1–2 read-only rows to the Delegation channels contract instead of mandating one `subagent` call per Assignment, and its lifecycle-selection rule lists all five resolver rungs (plan-row worktree, integration worktree, session pick, named plan row, only active entry) with the exactly-one-match rule for every automatic rung.
- **The board scope and the prompt path are two different channels.** `dsh-agent-teams.md` states the sibling-worktree case explicitly: a checkout outside the workspace (the normal `…/{repo}.worktrees/<track>` shape) cannot be expressed as a `write_scopes` value, so the prompt carries its absolute path plus the workspace-relative portion of the track's files, and the field is omitted when no portion resolves inside the workspace.
- **One shared `On dsh:` pointer block** replaces the five divergent ones (`mstar-roles/references/project-manager.md`, `mstar-dispatch-gates`, `mstar-review-qc`, `mstar-iteration`, `mstar-sdd` — the last one merged from two adjacent blocks): channel decision, then a pointer to `dsh.md` § Delegation channels + `dsh-agent-teams.md`, with no numeric limits restated.
- **Sticky implementer SSOT carries its dsh row** (`skills/mstar-sdd/references/sticky-implementer-session.md`): Agent Teams resumes the durable teammate by name via `send_message`, the direct-`subagent` profile uses continuation resume through the recorded id, and the session ledger's `host_agent_id` is defined for both.
- **The dsh README states the leaf-seat refused CLASSES** instead of naming individual commands, pointing at the shared derivation the CLI `--seat` help reads (`packages/commands/src/coordinator-seat.ts`, mirrored by `packages/dsh/src/gates/coordinator-seat.ts`), so the documented set follows the command layer.

<!-- CN -->
- **dsh 委派契约现在只在一处陈述通道选择。** `skills/mstar-host/references/dsh.md` 的 PM dispatch、SDD implement 与 1–2 只读席位段落改为指向 Delegation channels 契约，不再强制「每个 Assignment 一次 `subagent` 调用」；生命周期选择规则列全五个解析层（plan 行工作区、集成分支工作区、会话显式选择、被点名的 plan 行、唯一活跃项），并说明每个自动层都要求恰好一个匹配。
- **board scope 与 prompt 路径是两条不同通道。** `dsh-agent-teams.md` 显式写明兄弟工作区的情形：工作区之外的检出（`…/{repo}.worktrees/<track>` 这一常规形态）无法表达为 `write_scopes` 值，因此由 prompt 承载其绝对路径加上该 track 文件的工作区相对部分；当没有任何部分落在工作区内时省略该字段。
- **统一的 `On dsh:` 指针块**取代原先五种不同形态（`mstar-roles/references/project-manager.md`、`mstar-dispatch-gates`、`mstar-review-qc`、`mstar-iteration`、`mstar-sdd` —— 最后一个由相邻两块合并）：先给通道决策，再指向 `dsh.md` § Delegation channels + `dsh-agent-teams.md`，不重述任何数量上限。
- **sticky implementer SSOT 补上 dsh 行**（`skills/mstar-sdd/references/sticky-implementer-session.md`）：Agent Teams 以 `send_message` 按名恢复持久 teammate，direct-`subagent` 档经记录 id 做 continuation resume，会话台账的 `host_agent_id` 对两种模式都有定义。
- **dsh README 改为陈述叶席位拒绝的「类」**而非逐个命令，并指向 CLI `--seat` 帮助所读取的共享派生（`packages/commands/src/coordinator-seat.ts`，由 `packages/dsh/src/gates/coordinator-seat.ts` 镜像），使文档中的集合跟随命令层。
