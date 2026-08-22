---
name: iteration-drive
description: Drive the active iteration to completion — Phase 2 Autonomous Execute, Phase 3 iteration-close, Phase 4 Create PR, Phase 5 PR merge-ready loop (prefer babysit/*-babysit; optional greploop when repo has it; else CI fallback) until mergeable. Not Done until Phase 5 exit checklist passes.
agent: project-manager
input: "[no args]"
---

# Drive Iteration

Drive the active Morning Star iteration forward. **Boot loads skills; this command sequences Phase 2 → 3 → 4 → 5.** Phase gate SSOT → **`mstar-iteration`** §2–§5；本 command 仅补充 **可选第三方 helper skill 发现**（Phase 5），不反向写入 `mstar-*`。

## Phase flow（禁止跳步）

`Phase 2: Autonomous Execute → Phase 3: iteration-close → Phase 4: Create PR → Phase 5: PR merge-ready`。Transition gates（HARD）→ **`mstar-iteration`** **Phase transition gates** table。

**Done 定义**：**仅** Phase 5 §5.5 exit checklist 全 `[x]`。**Phase 3 close ≠ Done；Phase 4 开 PR ≠ Done。**

## 共享 invariants / preflight / todos / STOP

Phase 2–5 共享内容（PM invariants、assignment preflight、session todos、continuous-execution STOP）→ **`mstar-iteration/references/command-shared-invariants.md`**（SSOT；不在本命令重复）。

## Boot

按 **`mstar-iteration`** Load order 加载（`mstar-harness-core` → `mstar-roles` → `references/project-manager.md` → `mstar-iteration` § Phase 2–5 + `command-shared-invariants.md` → `mstar-compound` → `mstar-dispatch-gates` + host reference → **`mstar-sdd`**（first implement dispatch 前）→ `mstar-review-qc`（first QC 前）→ `mstar-plan-artifacts` / `mstar-plan-conventions` / `mstar-branch-worktree` → **`mstar-iteration/references/phase-2-worktree-lease.md`**）。完整 load list → **`mstar-roles`**。

## Phase 2: Autonomous Execute

Execute **`mstar-iteration` § Phase 2** exactly（§2.0 五道闸 → §2.1 session todos → §2.2 backlog → §2.3 integration branch + control worktree → §2.4 per-plan loop（lease-gated；SDD per-task；QC tri N=3 + QA；serial merge）→ §2.5 dispatch-first → §2.6 push 纪律）。全部 plan `Done` → **STOP** → 打印 `## Phase 3: iteration-close`。

**Assignment preflight**：每次 implement/QC/QA 派发前按 **`mstar-iteration/references/command-shared-invariants.md`** 执行。

## Phase 3: iteration-close

当 **every** plan 为 `Done`：**STOP** per-plan loop → 打印 **`## Phase 3: iteration-close`** → execute **`mstar-iteration` § Phase 3**（→ **`references/phase-3-iteration-close.md`** §3.0→§3.5；§3.1 entry checklist HARD GATE；§3.2 compound + package promotion；§3.4 `status: completed` + `end_date`）→ §3.5 exit 全 `[x]` 后打印 **`## Phase 4: Create PR`**。

## Phase 4: Create PR

Execute **`mstar-iteration` § Phase 4**（→ **`references/phase-4-5-pr-delivery.md`**）：打印 `## Phase 4: Create PR` → resolve `metadata.target_branch`（缺失 → **STOP**，never default `main`/`master`）→ 创建 PR `spec_integration_branch` → `target_branch` → 记录 PR URL + number → 勾掉 `phase-4-create-pr` → **Immediately** 打印 **`## Phase 5: PR merge-ready`**（**禁止**在此停止或汇报 Done）。

## Phase 5: PR merge-ready（babysit loop）

Execute **`mstar-iteration` § Phase 5**（→ **`references/phase-4-5-pr-delivery.md`** §5.0–§5.2；**§5.1a push cadence HARD**）。**§5.5 exit checklist 全 `[x]` = 本 command Done.**

本 command **叠加**可选 helper skill 发现（**non-`mstar-*`**；不写入 `mstar-*` load order）→ **`mstar-iteration/references/phase5-helper-discovery.md`**（babysit / `*-babysit` / greploop / fallback 路径清单；first readable `SKILL.md` wins）。Loop + review fix hygiene + exit checklist → §5.1–§5.2（同上 reference）。

**Then** report: iteration id, plans completed, compound summary, PR link, merge-ready evidence（CI snapshot + review resolution + Greptile if applicable）。

PR merge itself may still be manual or a separate host action unless user authorized auto-merge.
