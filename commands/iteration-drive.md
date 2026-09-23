---
name: iteration-drive
description: Drive the active iteration to completion — Phase 2 Autonomous Execute, Phase 3 iteration-close, Phase 4 Create PR, Phase 5 PR merge-ready loop (prefer babysit/*-babysit; optional greploop when repo has it; else CI fallback) until mergeable, then Phase 6 post-merge close once the PR is verified merged. Not Done until Phase 6 close completes.
agent: project-manager
input: "[no args] | --assignment <absolute-md-path> | --workflow <id> --plan <id> | --resume <absolute-session-json-path>"
---

# Drive Iteration

Drive the active Morning Star iteration forward. **Boot loads skills; this command sequences Phase 2 → 3 → 4 → 5 → 6.** Phase route + gate SSOT → **`mstar-iteration`** Phase route map + **Phase transition gates** table（§2 detail → `references/phase-2-worktree-lease.md`；§3 → `references/phase-3-iteration-close.md`；§4–§5 → `references/phase-4-5-pr-delivery.md`；§6 → `references/phase-6-post-merge-close.md`）；本 command 仅补充 **可选第三方 helper skill 发现**（Phase 5），不反向写入 `mstar-*`。

## Phase flow（禁止跳步）

`Phase 2: Autonomous Execute → Phase 3: iteration-close → Phase 4: Create PR → Phase 5: PR merge-ready → Phase 6: post-merge close`。Transition gates（HARD）→ **`mstar-iteration`** **Phase transition gates** table。

**Done 定义**：Phase 5 §5.5 exit checklist 全 `[x]` **且** PR merged 后 Phase 6 §6.1–§6.4 完成。**Phase 3 close ≠ Done；Phase 4 开 PR ≠ Done；§5.5 exit / PR merged ≠ Done。**

**Scoped route 的 Done 边界**：plan 会话的 finish 是 **durable handoff**（plan 保持 `InReview`、保留 `execution_lease`）；`status: Done` 与两个 lease 的删除由 **coordinator** 在验证 Git 合并后**同一次** snapshot 写入中完成。Phase 3–6 与 PR 仍归 coordinator → **`references/plan-scoped-pm.md`** §5–§6。

## 共享 invariants / preflight / todos / STOP

Phase 2–5 共享内容（PM invariants、assignment preflight、session todos、continuous-execution STOP）→ **`mstar-iteration/references/command-shared-invariants.md`**（SSOT；不在本命令重复）。**Scoped route（下节）例外**：其 session todos / STOP 为 plan-local，不 seed 全局 phase 条目 → **`references/plan-scoped-pm.md`**。

## Route（先于 Boot 判定）

| 调用形态 | 走向 |
|---|---|
| **无参数** | 下方 Boot → Phase 2 → 3 → 4 → 5 → 6（**语义不变**） |
| `--assignment <绝对 md 路径>` / `--workflow <id> --plan <id>` / `--resume <绝对 session json 路径>` | **scoped route** → **`mstar-iteration/references/plan-scoped-pm.md`**（scoped boot 先于全局 boot；不加载 compound / Phase 3–6 detail）。`--resume` 是 **pre-activation** 文件形态：执行 authority 为 active 的 harness 上它以 `execution.consumer-not-ready` 拒绝，本会话的只读续接改走 `mstar plan bind --execution --resume-ref <wire>` |
| 其他任何非空参数形态（重复 flag、未知 flag、位置参数、缺值/空值、混用形态、半对 `--workflow`/`--plan`） | **fail closed**：在 bind 与 boot 之前停止并报告接受的形态；**禁止**回落为整迭代路线 |

**Leaf 边界**：leaf executor 收到本命令 → 角色边界拒绝（`mstar-dispatch-gates`），**不得**晋升为 PM 或递归分派。

## Boot

按 **`mstar-iteration`** Load order 加载（`mstar-harness-core` → `mstar-roles` → `references/project-manager.md` → `mstar-iteration`（按当前 Phase 查 route map，只加载一行 detail）+ `command-shared-invariants.md` → `mstar-compound` → `mstar-dispatch-gates` + host reference → **`mstar-sdd`**（first implement dispatch 前）→ `mstar-review-qc`（first QC 前）→ `mstar-artifacts` / `mstar-conventions` / `mstar-branch-worktree` → **`mstar-iteration/references/phase-2-worktree-lease.md`**）。完整 load list → **`mstar-roles`**。

**Scoped route 例外**：先按 **`references/plan-scoped-pm.md`** §2 建立 primary PM identity → 一次 `mstar plan bind` → `show` 并把会话约束到返回的 scope，再按本条加载；**不**加载 `mstar-compound`，也**不**加载 Phase 3–6 detail（scoped boot ≠ 整迭代 boot）。

## Phase 2: Autonomous Execute

Execute **`mstar-iteration/references/phase-2-worktree-lease.md`** §2.0–§2.5 exactly（§2.0 五道闸 → §2.1 session todos → §2.2 backlog → §2.3 integration branch + control worktree → §2.4 per-plan loop（lease-gated；SDD independent ready tasks parallel with isolation；changed-scope QC tri N=3 + unit-only QA；serial merge）→ §2.5 dispatch-first；§2.6 push 纪律 → main skill `## 2.6`）。全部 plan `Done` → **STOP** → 打印 `## Phase 3: iteration-close`。

**Assignment preflight**：每次 implement/QC/QA 派发前按 **`mstar-iteration/references/command-shared-invariants.md`** 执行。

## Phase 3: iteration-close

当 **every** plan 为 `Done`：**STOP** per-plan loop → 打印 **`## Phase 3: iteration-close`** → execute **`mstar-iteration/references/phase-3-iteration-close.md`** §3.0→§3.5（§3.1 entry checklist HARD GATE；§3.2 compound + package promotion；§3.4 `status: completed` + `end_date`）→ §3.5 exit 全 `[x]` 后打印 **`## Phase 4: Create PR`**。

## Phase 4: Create PR

Execute **`mstar-iteration/references/phase-4-5-pr-delivery.md`** §4：打印 `## Phase 4: Create PR` → resolve `metadata.target_branch`（缺失 → **STOP**，never default `main`/`master`）→ 创建 PR `spec_integration_branch` → `target_branch` → 记录 PR URL + number → 勾掉 `phase-4-create-pr` → **Immediately** 打印 **`## Phase 5: PR merge-ready`**（**禁止**在此停止或汇报 Done）。

## Phase 5: PR merge-ready（babysit loop）

Execute **`mstar-iteration/references/phase-4-5-pr-delivery.md`** §5.0–§5.2（**§5.1a push cadence HARD**）。**§5.5 exit checklist 前 5 项全 `[x]` = merge-ready → 进入 Phase 6.**

本 command **叠加**可选 helper skill 发现（**non-`mstar-*`**；不写入 `mstar-*` load order）→ **`mstar-iteration/references/phase5-helper-discovery.md`**（babysit / `*-babysit` / greploop / fallback 路径清单；first readable `SKILL.md` wins）。Loop + review fix hygiene + exit checklist → §5.1–§5.2（同上 reference）。

**Then** report: iteration id, plans completed, compound summary, PR link, merge-ready evidence（CI snapshot + review resolution + Greptile if applicable）。

PR merge itself may still be manual or a separate host action unless user authorized auto-merge. Merge 完成（手动或授权 auto-merge）→ **立即**进入 Phase 6（下节）。

## Phase 6: post-merge close（PR merged 后）

PR **已 merge**（verified merged；mergeable ≠ merged）→ 追加 todo `phase-6-post-merge-close` → 打印 **`## Phase 6: post-merge close`** → execute **`mstar-iteration/references/phase-6-post-merge-close.md`** §6.1→§6.4（`mstar status workflow-close --workflow <id>` terminal write → unregister → projections reconcile → cleanup handoff）。**§6.1–§6.4 完成 = 本 command Done**（勾掉 `phase-6-post-merge-close`）。可在后续会话补跑；对已关闭 lifecycle 幂等。

**Then** report adds: post-merge close evidence（snapshot `completed` + `ended_at`、根 `status.json` 注销、投影一致）。
