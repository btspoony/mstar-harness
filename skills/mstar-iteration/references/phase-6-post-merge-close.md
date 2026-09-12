# Phase 6: post-merge close（terminal snapshot → unregister → reconcile → cleanup handoff）

> Loaded by `mstar-iteration` SKILL.md when entering Phase 6. **Read `mstar-harness-core` first.** 进入前置：§5.2 exit checklist 全 `[x]` **且 PR 已 merge**（verified merged）。mergeable ≠ merged；引擎无法探测远端 PR 状态 —— merged 与否由 PM 核实后再调用，close verb **不**充当 merge 验证器。

## Entry

1. 打印 **`## Phase 6: post-merge close`**
2. 追加 host todo `phase-6-post-merge-close`（session todos SSOT → `references/command-shared-invariants.md`）
3. 可恢复：Phase 6 允许在后续会话补跑；对已 terminal 的 lifecycle 幂等（fully closed retry 不改任何文件、不重写 `ended_at`）

Ordered pipeline（HARD —— 顺序固定，禁止跳步/倒置）：

**§6.1 terminal snapshot write → §6.2 unregister → §6.3 projection reconciliation → §6.4 cleanup handoff。**

## §6.1 Terminal snapshot write（先写终态）

```text
mstar status workflow-close --workflow <id> [--harness <path>] [--ended-at <date>]
```

- 引擎 `closeWorkflow`：在 snapshot 写锁内**重读最新快照** → identity/shape 校验 → 已 valid terminal 则 no-op；否则要求全部 plan 行 `Done` 且**无任何** `execution_lease` / `integration_merge_lease` → 写 `completed` + `ended_at`
- fail-loud：dangling lease / 非 `Done` 行 / snapshot 缺失或身份不符 → exit 1，**snapshot 字节不变**（无部分写）
- **禁止**为通过 close 释放 lease —— lease release 是独立的 owner 动作，close 从不释放（甚至 caller 自己的）
- `--ended-at` 省略时由 CLI 提供当天时间戳；引擎不接受自身时钟读数

## §6.2 Unregister（removal-at-terminal）

同一命令内、**仅在 §6.1 成功后**执行：从根 `{HARNESS_DIR}/status.json` 注销该 lifecycle（`unregisterWorkflow`，幂等）。

- 顺序固定：**snapshot 先 terminal，再注销根条目**；禁止反向
- unregister 失败 = exit 1 + **partial close** 显式报告；**禁止**回滚到 running —— 重试重读 terminal snapshot 后**只补 unregister**（不改 `ended_at`）
- fully closed retry：两个文件都不再改动，输出 already-closed 通知

## §6.3 Projection reconciliation（snapshot 权威）

把本地状态面对齐到 terminal snapshot（snapshot 行权威，投影跟随）：

1. `{PLAN_DIR}` plan 文件
2. compass `## Plans` + `{ITERATION_DIR}/README.md` 索引
3. project roadmap / register

- **禁止**伪造 `Done` 行、**禁止**为对齐而 close open residual —— 真实 remaining finding 阻塞 zero-residual 交付，而不是被静默关闭；reconciliation **不发明** Done/closed
- **禁止**把新 tracked 产品/文档 commit 夹带进 Phase 6 —— 新发现的产品修复另开授权 workflow

## §6.4 Cleanup handoff（最后一步；显式、不自动）

物理清理（integration worktree / 本地分支 / 远端分支删除）是 §6.1–§6.3 之后的**显式独立步骤**——即 **timing lane 2**：valid terminal close + PR verified merged 之后才清理 integration 面。Phase 6 只固定顺序与守卫，不在本 phase 内实现删除：

- cleanup **永不自动**、永不绕过 ownership / merge-evidence 守卫 —— 契约本体（ownership、合并证据、refusals、apply 顺序）唯一 home → **`mstar-branch-worktree`**「Worktree / branch cleanup」；本节只放 call site，不复制规则
- `mstar worktree cleanup --workflow <id> [--harness <path>] [--apply] [--remote] [--worktree <path>]` —— dry-run 默认，逐候选打印 `verdict | kind | ref | reason`；先 dry-run 核对受保护行全部 `keep`/`refuse`，再 `--apply`
- **lease 释放是手工 owner 动作、cleanup 范围外**：§6.1 close 已拒绝 dangling lease，但 cleanup 仍**从不**替 owner 释放——残留 lease 的候选只会得到 `cleanup.refuse.active-lease`；先手工释放，再重跑 dry-run/apply
- squash-merged 分支（tip 非 base 祖先）→ STOP → residual；禁止 `git branch -D`

Phase-6 gate 只查**本地 state**（valid terminal shape + 无 dangling lease + root 条目已注销），**不**验证远端 merged 证据，**不**检查物理清理是否完成。

> **Engine check (when available):** run `mstar iteration gate --phase 6 --workflow <id>` (or `import { evaluatePostMergeClose } from "@mstar-harness/engine"` in a host hook) to gate the local post-merge close state（valid terminal shape + 无 dangling lease + root 条目已注销；稳定码 `PHASE6_*`；invalid/unreadable root 不是条目已注销的证明）. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Standalone plans & abandonment

- `type: plan` 独立 lifecycle 在其 PR merge 后用**同一** completed-close 命令关闭（无第二 verb、无 `--outcome` / `--force`）
- abandoned lifecycle **不得**静默跑 completed close：已 terminal（`failed` / `stopped`）的 snapshot 保持原状态，CLI 如实报告实际 status；completed close 只属于 verified-merged 完成

## Evidence

Phase 6 完成 = `jq -r '.status, .ended_at'` `{HARNESS_DIR}/workflows/<id>/snapshot.json` → `completed` + 日期；根 `{HARNESS_DIR}/status.json` 不含该 id 且 `mstar status validate <root status.json>` exit 0；无 dangling lease；投影一致；host todo `phase-6-post-merge-close` 可勾掉。Phase-6 post-merge close gate（`mstar iteration gate --phase 6 --workflow <id>`，只查本地 close state）exit 0。

## References

- Route / transition-gate SSOT → `mstar-iteration` SKILL.md「Phase route map」+「Phase transition gates」
- 终态字段 / lease 语义 / `unregisterWorkflow` → `mstar-artifacts/references/status-and-residuals.md`
- cleanup ownership / guard 契约本体（两条时序车道）→ `mstar-branch-worktree`「Worktree / branch cleanup」
