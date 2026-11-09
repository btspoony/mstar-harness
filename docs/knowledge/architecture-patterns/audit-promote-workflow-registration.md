---
module: harness engine + cli
date: 2026-08-22
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: <plan-id>
last_updated: 2026-11-09
tags:
  - audit
  - promote
  - workflow-registration
  - snapshot-before-register
  - active-authority
applies_when:
  - 把 audit plan 候选推进到 v2 状态机
  - 新增 engine workflow 注册路径或写新的注册 composer 分支
---

# Audit 候选 → v2 workflow 注册：snapshot-before-register 与其后续形态

## Context

`mstar-audit` 输出是 advisory 计划候选（`{PLAN_DIR}/audit-<date>/`），不进状态机。但 v2 状态面（root `status.json` = workflows 注册表 + `{WORKFLOW_DIR}/<id>/snapshot.json` 运行态）提供 `type: 'plan'` 生命周期。缺口：CLI 只有 `audit scaffold`，无「把选中的 audit plans 注册为 workflow」路径；PM 要手写 snapshot + `registerWorkflow`。

~~`mstar audit promote`（engine `promoteAuditPlans`）填补该缺口~~ — **该动词与 `promoteAuditPlans` 已在 ACTIVE store cutover（`cb8e5bb9`，Closes #428）中删除**，`mstar audit --help` 只剩 `scaffold` / `secret-scan`。选中的 audit plan 现在走通用注册动词 `mstar workflow register`（`commitExecutionRegistration`，`packages/engine/src/execution-registration.ts`）：它把 workflow snapshot 与 catalog delta 写进同一个 ACTIVE 事务，`status.json` 的文件写入已退役。**下面的不变量仍然有效**（它们是 `registerWorkflow` 家族的唯一准入语义），只是执行者从 `promoteAuditPlans` 换成了注册 composer；`promoteAuditPlans` 专有的 re-promote 守卫与文件回滚随之退役，由 `catalog.registration-pending` / `catalog purge-registration` 的 journal 收敛替代。

## Guidance

**核心不变量：snapshot-before-register**

- `validateWorkflowEntry`（`packages/engine/src/status.ts:412`）校验 entry 形状；注册 composer 先在内存派生 snapshot（`planWorkflowSnapshot` / `iterationWorkflowSnapshot`），再在**同一个事务**里写执行图与 root entry——**先有合法 snapshot，再有 root 可见性**，否则注册被拒且无副作用。`status.ts` 的 `registerWorkflow` 文件动词与 `withStatusWriteLock` 已删除。
- （历史）`promoteAuditPlans` 签名：`(outDir, selected, { harnessDir, workflowId? }) → { workflowId, snapshotPath }`；`selected` 为空或 id 未知 → 抛错。
- `workflowId` 默认 = audit-<date> 目录 basename，经 `assertSafePathComponent` 守卫。
- snapshot `plans[]` 行 = legacy `PlanRow` 形状（`id`/`title`/`file`/`status: 'Todo'`）；root entry `started_at` 与 snapshot 字节相等。

**advisory 契约保留**：promote 是显式 PM 动作，audit 本身不注册；user-selection gate + Hard Rule 6 + Prepare（specify/clarify/plan）不变。**先选再 promote**。

**防重与回滚**（QC 加固；执行者已随 cutover 换成 journal）：

- **拒绝先于两条分支**：同一 workflow id 已有 pending journal → `catalog.registration-pending`，在任何写入之前拒绝；恢复路径由拒绝本身点名（`reconcile --abort` / `purge-registration`），两条都保留源字节。
- **失败不留半成品**：snapshot 与 root entry 在同一事务内提交，事务回滚即无残留，retry 可收敛；不再有「孤儿 snapshot 阻塞 re-promote」这一形态。

## Why This Matters

- 消除「手写 snapshot + register」的脆性路径（字段漂移、顺序错误、并发写冲突）。
- 让 audit plan 能进入**正常 SDD/QC/QA 生命周期**，而不只是 advisory 文件。
- 守卫机制保护了「promote 是可重入动作」的可靠性：失败不留残留，重试可收敛。

## When to Apply

- 任何「把 audit/候选/backlog 计划转成执行 workflow」的需求 → 用 `mstar workflow register`；audit 本身仍然不注册（advisory 契约）。
- 写新的 engine workflow 注册分支时，复用 snapshot-before-register + refuse-before-both-branches + derived-row-metadata 三件套（见下一节）。

## Examples

- （历史）`mstar audit promote audit-2026-08-22 --plans 001,002 --harness <dir>` → 写 snapshot + 注册 `type: plan`。当前等价动作是 `mstar workflow register`，snapshot 由 composer 派生。
- （历史）re-promote 同一 audit 目录 → exit 1，命名已有 snapshot 路径；行未丢。
- （历史）register 失败（如 root 冲突）→ snapshot 被回滚，修 root 后 retry 成功。

## The second lifecycle type (current shape)

Since the ACTIVE cutover the two lifecycle types are ONE composer parameterized by kind, not two
sibling producers: `CatalogExecutionWorkflow` is `{ kind: "plan", … } | { kind: "iteration", … }`
(`packages/engine/src/catalog-registration.ts`), and `resolveCatalogExecutionPlan` derives the snapshot
through `planWorkflowSnapshot` / `iterationWorkflowSnapshot` in memory. No file snapshot is written, no
`withStatusWriteLock` section exists, and `registerPlanWorkflow` / `registerIterationWorkflow` /
`writeWorkflowSnapshot` / `registerWorkflowEntryLocked` are all gone. What still holds:

- **Refuse before both branches.** `assertCatalogExecutionCommittedOn` reads the pending journal and
  refuses `catalog.registration-pending` before anything is written, so a multi-row producer is never
  repurposed as an upsert/repair route. The two recovery routes are named in the refusal itself
  (`mstar catalog reconcile --abort`, `mstar catalog purge-registration`) and retain source bytes.
- **Row `metadata` is derived, never accepted.** `iterationWorkflowSnapshot` fills
  `iteration_refs` / `spec_integration_branch` / `merge_target` from `compassRef` + `branch.integration`
  and writes every row `Todo` — registration never authorizes execution.
- **`compass_ref` is normalized to the canonical existing pointer** (`normalizeIterationCompassRef`), and
  a pointer naming no file, or one resolving outside the root, refuses before any row is published.
- **Replay identity is the caller's own spelling, not the normalized pointer** — a committed registration
  still replays when the alias now dangles (`I-000868`, PR #578).

What stays out of a registration producer of either type: delivery kind, execution policy,
coordination/leases, worktree evidence — those have their own authorized seams (coordinator bind,
reviewed Prepare amendment, lifecycle verbs).

## Related

- `mstar-plan-artifacts/references/status-and-residuals.md`（v2 形状、snapshot 字段语义）
- `packages/engine/src/catalog-registration.ts`（`resolveCatalogExecutionPlan`、`assertCatalogExecutionCommittedOn`）
- `packages/engine/src/execution-registration.ts` `commitExecutionRegistration`；CLI 动词 `mstar workflow register`
