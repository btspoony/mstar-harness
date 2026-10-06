# Phase 6: post-merge close（terminal execution state → unregister → reconcile → cleanup handoff）

> Loaded by `mstar-iteration` SKILL.md when entering Phase 6. **Read `mstar-harness-core` first.** 进入前置：§5.2 exit checklist 全 `[x]` **且 PR 已 merge**（verified merged）。mergeable ≠ merged；引擎无法探测远端 PR 状态 —— merged 与否由 PM 核实后再调用，close verb **不**充当 merge 验证器。

## Entry

1. 打印 **`## Phase 6: post-merge close`**
2. 追加 host todo `phase-6-post-merge-close`（session todos SSOT → `references/command-shared-invariants.md`）
3. 可恢复：Phase 6 允许在后续会话补跑；对已 terminal 的 lifecycle 幂等（fully closed retry 不改任何文件、不重写 `ended_at`）

Ordered pipeline（HARD —— 顺序固定，禁止跳步/倒置）：

**§6.1 terminal execution transition → §6.2 unregister → §6.3 projection reconciliation → §6.4 cleanup handoff。**

## §6.1 Terminal execution transition（先写终态）

```text
mstar status workflow-close --workflow <id> --session-ref <wire> --expect <full-execution-token> \
  --operation <id> --reason <text> [--harness <absolute-path>] [--json]      # active (canonical)
mstar status workflow-close --workflow <id> [--harness <path>] [--ended-at <date>] [--session <path>]   # pre-activation only
```

- ACTIVE 在 `withExecutionTransaction` 中重读执行行，按已记录证据组合其拥有行的合法 completion bookkeeping，再判定全部 plan Done、无 dangling lease、交付证据完整；terminal state 与 DB 根 unregister **同事务提交**，失败整单回滚。不得手工删 lease 或伪造 Done 来满足条件。仅 pre-activation 文件路由才在 snapshot 写锁内重读 / atomic replace。
- dangling lease / 非 Done 行 / 缺失或身份不符则拒绝；不提交失败 transition。pre-activation 的相应失败保持 snapshot 字节不变。
- **`type: plan` 交付证据 consult**：completed close 与只读 Phase-6 gate 共享 `consultDeliveryEvidence`；development 缺 compound disposition / PR 身份 / verified merge，或 report-only 缺完成策略履行，均以 `PHASE6_DELIVERY_*` 拒绝，当前权威保持 running + registered。补齐只经 `mstar workflow evidence`（ACTIVE：session reference + scope token + operation id；pre-activation：session envelope；flags 见 help），不手写状态。PR 身份一次写入，compound / merge 可覆写；failed / stopped 不要求 successful-delivery 证据。
- **delivery kind 在注册期显式声明**：DB 创建路线注册时声明，不发明 ACTIVE 的补 kind 通道；历史 pre-activation 无 kind snapshot 才用 `mstar workflow evidence --declare-kind` 一次性声明。注册与声明的完整约束 → 冻结契约 `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`，命令形状见 help。
- **禁止**为通过 close 手工释放 lease 或伪造 Done；ACTIVE 只组合当前权威已记录证据所蕴含的合法 bookkeeping，不夺取外来所有权；pre-activation close 不释放 lease。
- `--ended-at` 只属于 **pre-activation** 形态（省略时由 CLI 提供当天时间戳；引擎不接受自身时钟读数）；active 形态记录其自身时间戳，带 `--ended-at` 是 usage 拒绝

## §6.2 Unregister（removal-at-terminal）

同一命令按先 terminal、再 unregister 的语义关闭 lifecycle：ACTIVE 从 DB 根 register（`execution_registry`）注销，pre-activation 才是根 `status.json`。

- **顺序固定**：先有效终态，后注销；ACTIVE 由 DB 事务执行，不手写文件
- pre-activation unregister 失败显式报告 partial close，重试只补 unregister，不回滚 running / 重写 `ended_at`
- fully closed retry 不再变更权威目标（ACTIVE：DB 行；pre-activation：两文件），输出 already-closed

## §6.3 Projection reconciliation（当前执行权威）

把本地叙事面对齐到 ACTIVE DB 终态与 store issue rollup（pre-activation：terminal snapshot 执行状态）：

1. `{PLAN_DIR}` authored plan
2. compass `## Plans`；迭代 README 仅散文，无状态登记行
3. store project roadmap 内容与 issue rollup；project register 仅迁移历史，不更新

- **禁止**伪造 `Done` 行、**禁止**为对齐而 close open residual —— reconciliation **不发明** Done/closed，也不为对齐关闭条目或放宽 `zero-residual` 规则；`allow-residual` 下已登记且披露的非阻断 open R# **保持 open**，不随 lifecycle 终结而“随之关闭”（真实 remaining finding 阻塞 `zero-residual` 交付，而不是被静默关闭）
- **禁止**把新 tracked 产品/文档 commit 夹带进 Phase 6 —— 新发现的产品修复另开授权 workflow

## §6.4 Cleanup handoff（最后一步；显式、不自动）

物理清理（integration worktree / 本地分支 / 远端分支删除）是 §6.1–§6.3 之后的**显式独立步骤**——即 **timing lane 2**：valid terminal close + PR verified merged 之后才清理 integration 面。Phase 6 只固定顺序与守卫，不在本 phase 内实现删除：

- cleanup **永不自动**、永不绕过 ownership / merge-evidence 守卫 —— 契约本体（ownership、合并证据、refusals、apply 顺序）唯一 home → **`mstar-branch-worktree`**「Worktree / branch cleanup」；本节只放 call site，不复制规则
- `mstar worktree cleanup --workflow <id> [--harness <path>] [--apply] [--remote] [--worktree <path>] [--all-workflows] [--verbose] [--ignore-unreadable-snapshots]` —— dry-run 默认，逐候选打印 `verdict | kind | ref | reason`（标志语义、默认候选范围与守卫本体见上方 owning-contract 指针）；先 dry-run 核对受保护行全部 `keep`/`refuse`，再 `--apply`
- **lease 释放是 owner 动作、cleanup 范围外**：先由 owner 经所属 authority 的公共动词处理（ACTIVE `mstar plan release` 或 coordinator integration / complete 序列；pre-activation 见其协议）；不得为了 close / cleanup 释放外来 lease，不手写 snapshot。守卫不通过则保留受保护候选。
- squash-merged 分支（tip 非 base 祖先）→ STOP → residual；禁止 `git branch -D`

Phase-6 gate 只查**本地 state**（valid terminal shape + 无 dangling lease + root 条目已注销 + `type: plan` 交付证据，§6.1），**不**验证远端 merged 证据，**不**检查物理清理是否完成。

> **Engine check (when available):** run `mstar iteration gate --phase 6 --workflow <id>` (or `import { evaluatePostMergeClose } from "@mstar-harness/engine"` in a host hook) to gate the local post-merge close state（valid terminal shape + 无 dangling lease + root 条目已注销；稳定码 `PHASE6_*`；invalid/unreadable root 不是条目已注销的证明）. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Standalone plans & abandonment

- 独立 plan 交付生命周期的语义权威（注册 → 交付尾段 → verified merge → terminal close）→ 冻结契约 `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`；本节仅固定 close 侧契约（同一命令 close、本地 gate 不验证远端 merged 证据）
- `type: plan` 独立 lifecycle 在其 PR merge 后用**同一** completed-close 命令关闭（无第二 verb、无 `--outcome` / `--force`）
- abandoned lifecycle **不得**静默跑 completed close：已 terminal（`failed` / `stopped`）的 snapshot 保持原状态，CLI 如实报告实际 status；completed close 只属于 verified-merged 完成

## Evidence

Phase 6 完成 = 保留 ACTIVE `mstar status workflow-close` 的实际 applied / replay 收据，确认 terminal `completed` + `ended_at` 与同事务 unregister；`mstar status validate`（不传显式文件路径）核对当前 DB 根 register 不含该 id；`mstar iteration gate --phase 6 --workflow <id>` exit 0、无 dangling lease、叙事投影一致。当前 ACTIVE read 不返回已注销 workflow 历史，不能把 root absence 单独当终态证明。仅 pre-activation / engine-absent 核对 snapshot / `status.json`；完成后勾 host todo。

## References

- Route / transition-gate SSOT → `mstar-iteration` SKILL.md「Phase route map」+「Phase transition gates」
- 终态字段 / lease 语义 / `unregisterWorkflow` → `mstar-artifacts/references/status-and-residuals.md`
- cleanup ownership / guard 契约本体（两条时序车道）→ `mstar-branch-worktree`「Worktree / branch cleanup」
