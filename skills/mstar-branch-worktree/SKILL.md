---
name: mstar-branch-worktree
description: "Morning Star 业务仓 Git 功能分支、worktree 隔离与三写域模型（L1 跨 plan：主 checkout control root + iteration integration worktree + 每 plan feature worktree + `execution_lease`，默认 gitignore 下经 control 绝对路径读写进程产物；L2 同 plan：`references/parallel-writable-pre-dispatch.md`，N 次 invoke ≠ 隔离）、Spec 集成分支、QC/QA 检出对齐（`Review cwd` / `Working branch` / `plan_id` / `Review range` / `Diff basis` 三审 + QA 逐字相同）。Read when PM writes `Working branch` / `Branch policy`, iteration/parallel writable dispatch, QC/QA checkout alignment, or guarded post-merge worktree/branch cleanup (`mstar worktree cleanup`) is needed."
---

## Load order（必读顺序）

**首次 Read 本 skill 前：必须先 Read `mstar-harness-core`（SKILL.md）。** 冲突时 **以 `mstar-harness-core` 为准**。

**Spec 多 plan 命名**（`iteration_base_branch`、`spec_integration_branch`、`target_branch` PR 门禁）→ **`mstar-conventions`**。**L1/L2 worktree 分层**（迭代 integration worktree vs feature、plan 内并行轨）→ 下文 **「Worktree isolation layers」**；**L2** 同仓并行可写派发前清单 → **`references/parallel-writable-pre-dispatch.md`**；迭代 lease claim/merge 细则 → **`mstar-iteration`** `references/phase-2-worktree-lease.md`（勿在本 skill 重复完整协议表）。merge 后 worktree/分支回收（cleanup）守卫契约 → 下文 **「Worktree / branch cleanup」**。下文为分支、三写域、QC/QA 检出对齐与 merge 后 cleanup 主文。

## Scope（摘要）

- **仅 PM 决定分支**；其他可写角色不得自行新开分支或切回 `main`。
- **Assignment 须含其一**：`Working branch: <existing>` | `create <new> from <base>` | `Branch policy: direct on <branch> — <reason>`。
- **L1（跨 plan / 迭代 Phase 2）**：control root（= **主 checkout / main worktree**，进程 SSOT，Git 派生）+ integration worktree（snapshot `integration_worktree_path`，检出 `spec_integration_branch`，唯一 merge cwd）+ 每 plan 独立 feature worktree（`execution_lease.worktree_path`）+ lease；见 **「Worktree isolation layers」**。
- **L2（同 plan 内 ≥2 可写并发）**：派发 **前** 完成 **`references/parallel-writable-pre-dispatch.md`**（含 `git worktree`、绝对 **`Worktree path`**；**N 次并行 invoke ≠ 已隔离**）。单 plan 多轨时 **L1 不替代 L2**。
- **QC/QA 前**：待审提交归并到 **单一 `Working branch` `HEAD`**；三审 + QA 共用一套 **`Review cwd` + `plan_id` + `Review range` / `Diff basis`**（逐字相同）。

## Git 功能分支、同仓并发与 Worktree 对齐

## Git 功能分支门禁（业务仓库）

适用于 cwd 为 **Git 托管的业务/应用仓库** 且本轮会产生**仓库内可合并 diff** 的任务（代码、业务向测试与 fixture、影响构建或运行时的配置等）。**不**用于约束 `~/.config/opencode/` 全局配置目录（该目录对 agent 只读；落盘仅由用户执行）。

### 默认规则

- 不得在**默认保护分支**（常见名：`main`、`master`；以项目约定为准）上直接实现功能改动，除非 Assignment 含显式例外。
- 例外须在 Assignment 中写明一行：**`Branch policy: direct on <branch> — <reason>`**（典型：团队约定的热修直接打默认分支）。

### `<base>` 与叠分支（stacked branches）

- 门禁的目标是**不在未授权的默认分支上直接提交**，不是「只能从 `main` 开新分支」。
- 当需要**从已有功能分支继续拆新分支**时，Assignment 应写清**祖先分支** `<base>`，例如：`create feature/foo-part2 from feature/foo`。
- **`<base>` 可取**：`main` / `master`（或项目默认分支名）、任意已存在的 `feature/*` / `fix/*`、远程跟踪分支名、或 **`current`**（表示以执行者检出时的 `HEAD` 为祖先，用于「就在当前分支上再拉一枝」）。
- 若只写 **`Working branch`: `feature/foo`且无「create … from …」**：表示**沿用 / 切到**该已存在分支上开发，不要求新建。
- 若写新建但未写 `<base>`：实现侧应**停下问** `project-manager`（或按项目 `AGENTS.md` 的默认 base）；**禁止**擅自假设「一定是 `main`」。

### 角色职责

- **`project-manager`（唯一分支决策入口）**：向 `product-manager`（向项目仓库提交产品文档时）、`architect`（向项目仓库提交技术/架构/契约类文档时）、`fullstack-dev` / `frontend-dev` / `fullstack-dev-2`、以及会向仓库提交工件的 `qa-engineer`、会改仓库内文件的 `ops-engineer`、对**项目仓库**落盘的 `prompt-engineer` 分派前，核对分支策略；在 Assignment 中写明 **`Working branch`**（沿用已有分支名，或 `create <new-branch> from <base>`，其中 `<base>` 遵守上一节）。若用户已指定分支/祖先，照抄进 Assignment。**只有 `project-manager` 可以决定是否新开分支、从哪个 `<base>` 开分支。**
- **实现 / QA / 运维 / prompt / product-manager / architect（项目侧）**：在**首次**编辑仓库内文件或执行 `git commit` 前，核对当前分支与 Assignment，并在回报中明确"正在哪个分支上工作"。**禁止自行决定新开分支、禁止自行切回 `main`/`master` 重开分支。**若未授权 `Branch policy` 且当前在默认分支，则仅可按 PM 已写明的 `Working branch` 执行切换/开枝；若 Assignment 未写清或与现场分支不一致，先回报 `project-manager`，不得擅自处理。

## 分支协作契约（Branch Collaboration Contract）

### 适用范围

- 当任务会在项目 Git 仓库产生可合并 diff 时适用。
- 适用于 `project-manager`、`product-manager`、`architect`、`fullstack-dev`、`frontend-dev`、`fullstack-dev-2`、`qa-engineer`、`ops-engineer`、`prompt-engineer`（项目侧写入）。

### 唯一分支决策者

- 只有 `project-manager` 可以决定分支策略：
  - 继续在现有分支开发，或
  - 使用 `create <new-branch> from <base>` 新开分支，或
  - 使用 `Branch policy: direct on <branch> — <reason>`。
- 其他可写角色不得自行决定开分支。

### PM 必须先与用户确认

在派发实现任务前，PM 必须先检查当前分支；若已在非默认开发分支（如 `feature/*`、`fix/*`），必须先与用户确认。

未获得用户明确确认前，PM 不得切回 `main`/`master` 并新开分支。

#### PM 确认话术模板

面向用户沟通时，使用以下结构：

```markdown
当前检测到在分支：`<current-branch>`。
请确认本次任务是：
1) 继续在 `<<current-branch>>` 上开发
2) 新开分支：`<new-branch>`，基于 `<base-branch>`

未确认前，我不会切回 `main`/`master` 或新开分支。
```

### Assignment 要求（PM）

每个可写 Assignment 必须且只能包含以下之一：

- `Working branch: <existing-branch>`
- `Working branch: create <new-branch> from <base>`
- `Branch policy: direct on <branch> — <reason>`

若是新开分支但缺少 `<base>`，必须暂停并向用户澄清，不能猜测。

### 可写角色执行规则

在首次写仓库或 `commit` 之前：

1. 校验当前分支与 Assignment 是否一致。
2. 只能执行 PM 在 Assignment 中定义的分支策略。
3. 禁止自行切回 `main`/`master` 再重开分支流程。
4. 若 Assignment 含糊或与本地分支状态冲突，先停下并回报 PM。

### 回报要求

可写角色在 Completion Report 中必须明确当前工作分支，例如：

- `Working branch used: <branch-name>`

## Worktree isolation layers (L1 vs L2)

Two complementary **worktree** isolation layers coexist. Do **not** conflate them with SDD **review** layers (L1–L4 in `mstar-review-qc/references/review-responsibility-boundaries.md`).

| Layer | Scope | When | Mechanism |
|-------|-------|------|-----------|
| **L1** | Cross-plan (iteration Phase 2) | Multiple plans may implement concurrently in one iteration | **Main-worktree control root** (process SSOT) + **integration worktree** (`integration_worktree_path`) + per-plan **feature worktrees** + `plans[].execution_lease` (workflow snapshot `workflows/<id>/snapshot.json`) |
| **L2** | Within-plan | Same `plan_id`, same business repo, **≥2 concurrent writable implement tracks** | **`references/parallel-writable-pre-dispatch.md`** — distinct absolute **`Worktree path`** per track |

**Stacking rules**

- Default **L1** capacity is **one writable track per plan**. If one plan runs **≥2** concurrent writable tracks, each track **also** satisfies **L2**; L1 does **not** replace L2.
- **L1** applies under iteration commands with Phase 2 worktree/lease defaults (unless explicit `Worktree mode: waived` this turn). Single-plan waves without iteration leases still require **L2** when **≥2** parallel writable tracks share one repo.
- Cross-plan **integration merge** into `spec_integration_branch` remains **serial** (snapshot top-level `integration_merge_lease`) even when L1 feature implementation runs in parallel.

### Main-worktree control root, integration worktree, feature worktree (iteration / L1)

The integration worktree is established at iteration **Phase 2 entry** (Phase 1 Review & Edit may edit uncommitted docs on the primary checkout under the Prepare policy — the bounded exception; the main worktree never switches branch). Normative field names and claim/release/merge protocol → **`mstar-iteration`** `references/phase-2-worktree-lease.md` and maintenance ADR `2026-07-22-iteration-worktree-plan-lease.md`. **Do not invent alternate lease field names in this skill.**

| Checkout | Checked-out branch | Path recorded | Writable role |
|----------|-------------------|---------------|---------------|
| **Control root** = the **primary checkout** (main worktree) | the recorded **`Main worktree branch`** from the main plan header (never a lifecycle-owned branch; never switched) | **not in the snapshot** — derived from Git (`readMainWorktree`); the branch is recorded once as `Main worktree branch: <branch>` in the main plan | **Forbidden** for product edits — process-SSOT holder + Git-control cwd only |
| **Integration worktree** | Resolved `spec_integration_branch` (same across active plans) | `integration_worktree_path` (snapshot top-level) — canonical **repository root** (not `{HARNESS_DIR}`) | Sole merge cwd for serial integration merges (`integration_merge_lease`) + tracked-result close commits (Phase 3 compound); **no product-source edits** — Phase-5 fixes use a feature worktree |
| **Feature worktree** (per plan) | Plan `Working branch` / feature branch from integration | `plans[].execution_lease.worktree_path` (snapshot plan row) | **Required cwd** for that plan's product/source edits |

### Harness path SSOT under default gitignore (L1) — the three-domain table

Default process artifacts are **gitignored** (`mstar-conventions`「Git 跟踪策略」); `git worktree add` does **not** copy them into a new checkout. A worktree's `.mstar/` is **not categorically non-writable** — writability is decided per domain. This is the **sole** three-domain table in the skill corpus; other skills point here instead of restating it.

| Domain | Contents | Home | Writable from a worktree? |
|---|---|---|---|
| **Process SSOT** (gitignored) | `status.json`, `workflows/`, `projects/`, `plans/`, `sdd/`, `iterations/`, `archived/` | control root = the **primary checkout** (main worktree) | **No.** Always addressed via absolute control-root paths; a second process-SSOT copy must never be bootstrapped under any worktree. |
| **Tracked results** (Git-following) | `{KNOWLEDGE_DIR}`, `{SPECS_DIR}`, `{HARNESS_DIR}/AGENTS.md`, `CONCEPTS.md` | whichever checkout holds the target branch | **Yes.** Readable from any worktree; written where the target branch is checked out (iteration Phase 3 compound → the integration worktree), then committed on that branch. |
| **Product source** | repository code | feature worktree on `Working branch` | feature worktree only. |

**Control harness root** = `<main-repo-root>/{HARNESS_DIR}/` — resolved from Git (the main worktree), never from a snapshot field.

**Hard rules**

- Snapshot `integration_worktree_path` **MUST** differ from the main worktree (control root) and from `execution_lease.worktree_path` — never merge from the main checkout, never product-edit the integration checkout.
- Main-worktree residency: the main worktree's attached branch must equal the recorded **`Main worktree branch`** from the plan header (recorded before the lifecycle writes; never invented from the current branch at check time) and must not be owned by any non-terminal workflow (integration, plan or track). Never create a branch or switch main to make a residency check pass; `branch.base` is a creation/merge anchor, never a residency fact.
- A feature worktree's same-looking `{HARNESS_DIR}` path is **not** the SSOT — **never** treat it as the source of plans/status/SDD, and **never** bootstrap a second process-SSOT copy there.
- Absolute **`Worktree path`** (feature) MUST appear in the writable Assignment and in `execution_lease.worktree_path` before first writable implement dispatch for that plan.
- When L1 lease gate is active (not `Worktree mode: waived`), Assignment **`Plan Path`** and **`SDD dir`** MUST be **absolute paths under the control harness root** (not relative `.mstar/...` resolved from the feature cwd). Prefer also writing **`Control harness root: <main-repo-root>/{HARNESS_DIR}`**.
- Writable dispatch for a plan requires a **verified** `execution_lease` (same read-check-replace-verify discipline as the iteration reference). Full claim tables are **not** duplicated here.

**Anti-pattern (forbidden)**

- Inferring `Worktree mode: waived` because “feature worktree has no plans” under default gitignore. Correct response: keep feature worktrees; route harness I/O through control absolute paths. Missing same-host write lock → **`Plan parallelism: serial`** only — that is a **separate** gate and does **not** waive worktree/lease.

**Naming conventions (PM / ops; examples only — paths MUST be canonical absolute)**

1. **Control root** — always the **primary checkout** (main worktree), derived from Git (`readMainWorktree`); never a PM-designated alternative checkout, never recorded in the snapshot. Its attached branch is recorded once as **`Main worktree branch: <branch>`** in the main plan header before the lifecycle writes, and PM passes it unchanged in writable Assignments. `branch.base` is the creation/merge anchor — not a residency fact.
2. **Integration worktree** — one dedicated linked checkout on `spec_integration_branch`, distinct from the main worktree, recorded once in snapshot `integration_worktree_path`; sole merge cwd for the iteration.
3. **Feature worktree (per plan)** — one distinct subdirectory under the workspace root **`.worktrees/`** per active `plan_id` (e.g. `.worktrees/<plan-id>-<slug>`; AGENTS.md「Local scratch layout」), gitignored by the repo convention; Assignment **`Worktree path`** must match lease `worktree_path`.
4. **L2 track worktrees (within-plan)** — additional distinct directories per parallel implement track under the **same** plan (see **`references/parallel-writable-pre-dispatch.md`**), each with its own PM-approved **`Working branch`**.

> **Engine check (when available):** run `mstar worktree check <plan-id> --workflow <id>` (L1) / `mstar worktree check --l2 --tracks <json>` (L2) (or `import { l1PreDispatchCheck, l2PreDispatchCheck, readMainWorktree, assertMainWorktreeResidency, assertControlVsFeaturePath, assertBranchAlignment } from "@mstar-harness/engine"` in a host hook) to verify the L1/L2 isolation rules above (main residency vs recorded `Main worktree branch`; main/integration/feature pairwise checkout distinctness — lease worktree ≠ main control root ≠ integration; checked-out branch matches `Working branch`). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## 同仓并发写入与 Git worktree（强制）

**首要场景是开发阶段（L2；迭代多 plan 时另见上文 L1）**：多条可写流 **并发** 改 **同一仓库** 时，用 worktree 做 **写入侧目录隔离**。派发前清单 → **`references/parallel-writable-pre-dispatch.md`**。下列规则针对该类开发并发；**QC / QA 阶段的检出约定**见下一小节。

当 **`project-manager` 在同一调度轮次内并发启动多个** subagent（含宿主侧「并行 Task / 并行 subagent」），且 **≥2 个承接方**可能对 **同一 Git 仓库的同一工作区（同一 cwd 检出目录）**产生写文件或 `git commit` 级改动时：

- **必须**为每条并发写流使用 **独立检出目录**：优先使用宿主原生 worktree/checkout 隔离能力；没有原生能力时使用 `git worktree`，并按本 skill 的目录、分支和 QC/QA 对齐规则执行。
- **必须**与既有分支门禁一致：每个可写承接方的 Assignment 仍须含 PM 已批准的 **`Working branch`** / **`Branch policy`**；在某一 worktree 内 **不得**擅自 `checkout` 到未授权分支或私自新建分支。
- **PM 须在 Assignment 中写清**各并发写流的 **检出约定**（例如预期 **`Worktree path`** / 命名规则，或「由承接方创建/使用隔离 worktree 并在 Completion Report 回报路径」），避免多代理默认共享同一目录导致互相覆盖、冲突或半写入状态。
- **同仓、同一 plan、≥2 可写并行轨**：派发各轨实现 Assignment **之前** 确认 **`Branch policy`** 与 plan 集成分支 / topic 分支关系（见下节 **「默认编排」**），并完成 reference 清单中的 worktree 步骤。

**串行不豁免**：并发流全部为只读、或各写入者针对**不同 Git 仓库根**时不存在共享写入面；但**写入串行**（同一时刻仅一个代理持有该仓工作区）**不**豁免隔离——只要本轮存在对同一仓库工作区的可写改动，每条写流都使用独立检出目录（主 checkout 可能被链接的技能/命令消费者读取，任何生命周期分支都不得落到主 worktree）。worktree 默认的唯一豁免通道：本轮显式 **`Worktree mode: waived`** 与 Phase 1 Review & Edit 链的未提交文档例外（`mstar-iteration` §1.6 / §6）。

### 并发 subagent 与同仓工作树（对齐）

当多个可写 subagent **并发**修改 **同一仓库** 时，**不得**共用同一检出目录作为写入 cwd。PM 在分派前应规划 worktree/checkout 隔离，并在各承接方 Assignment 中写明 **`Working branch`** / **`Branch policy`** 及 **检出路径约定**（或要求回报实际 worktree 路径）。单分支决策权仍仅属 PM；worktree 只解决「目录与工作区隔离」，不替代分支授权。

**同仓、同一 plan、多可写并行轨**：挂齐各轨 worktree **之前** 先确认 plan 集成分支与各轨 topic 分支及 merge 靶；QC 前归并到单一 **`Working branch` `HEAD`**。分步见下节 **「默认编排」**。

**QC / QA 与 feature**：开发常在 **feature 分支的 worktree** 中完成；进入 **QC 三审**与随后的 **QA 验证**时，PM 须在 Assignment 中写明 **`Review cwd` / `Worktree path`**、**`Working branch`**、**`plan_id`**（无 plan 流程时 `N/A` + 不可歧义 **Feature / scope label**）与 **`Review range` / `Diff basis`**；**三份 QC Assignment 与 QA Assignment 中 `plan_id` 与 `Review range` / `Diff basis` 须逐字相同**，保证三票审 **同一 plan/feature 与同一 diff 范围**。

## QC / QA 检出对齐与多 worktree 门禁衔接（强制；避免误派）

### 对齐字段契约（canonical · Evidence）

分派 **QC 三审** 与对齐的 **QA 验证** 时，PM **必须**在 Assignment 写明与待审实现一致的 **`Review cwd` / `Worktree path`**、**`Working branch`**、**`plan_id`**、**`Review range` / `Diff basis`**。开发在 **feature 分支**（往往在独立 worktree 中）完成后，QC/QA 针对的都是这份 feature，不是 `main` 或任意未对齐默认 cwd。

- **`Review cwd` / `Worktree path`**：**优先**沿用开发 Completion Report 回报的业务仓实现检出路径（该 feature 的 worktree）**当且仅当**该路径检出分支 `HEAD` 已含本轮待审全部提交（含曾发生在其他并行 worktree、现已归并到该分支的变更）。否则**必须**改用集成完成后的 `Working branch` 与对应检出路径（或在该分支上**另开**只读审查 worktree）。开发未用 worktree → 写明单一业务仓根路径。
- **`Working branch`**：含全部待审提交的那条分支（常见 plan 集成分支）。
- **`plan_id`**：与 `{SDD_DIR}` `<plan-id>` 段、主 Plan Path、workflow snapshot `plans[].id` 一致；无 `{PLAN_DIR}` 流程时写 **`plan_id: N/A`** + 一行 **`Feature / scope label`**（不可歧义，足以与并行其它 feature 区分）。
- **`Review range` / `Diff basis`**：审查的 diff/提交范围（例如 `merge-base: <target_branch-or-base-ref>` + `tip: HEAD`；或 `rev-range: <full-40>..<full-40>`；或一句 `equivalent to: git diff <merge-base>...HEAD`，以团队可复现为准）。
- **逐字对齐（强制）**：三份 QC Assignment 与 QA Assignment 间 **`plan_id`** 与 **`Review range` / `Diff basis`**（连同 `Review cwd` / `Working branch`）**必须完全相同**；**`qa-engineer`** 验证同一 feature 时**复用同一组字段**。**热修 / QC 单审**路径也须含**同一组字段**，仅承接方份数为 1。
- 三审并行时三名 reviewer **共用同一组**字段（对业务仓**只读 diff 审查**）；一般不必为每位 reviewer 各开 worktree，除非宿主/环境要求进程级隔离。

> **Engine check (when available):** run `mstar worktree qc-alignment <assignment-file>...`（或 import `assertQcAlignment` / `singleReviewSnapshot` from `@mstar-harness/engine` in a host hook）以断言上述 QC/QA 对齐字段（tri + QA 间 `plan_id` 与 `Review range` / `Diff basis` 逐字相同；派发前 single review snapshot）。On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

### 多 worktree 并行 → 单一待审快照（派 QC 前置）

**语义区分（必须理解）**：开发阶段可存在 **多个** `Worktree path`（每条流一条检出目录）；**一轮**正式 QC 三审 + 对齐 QA 只对应 **一套**对齐字段（上文）。**不要**把「多个开发 worktree」误解成「QC 应轮流进多个目录各审一半」。

**单一待审 Git 快照（派 QC 前置条件）**：若本 plan 下多条**可写**并行轨落在**同一业务仓**且成果分布在**不同分支**、或**未合并进同一条分支 `HEAD`**，则派发 QC 三审（及同范围 QA）**之前**，**必须**先在 Git 完成**归并**（merge / rebase / 按团队集成方式），使**全部**待审提交出现在同一条 PM 指定的 **`Working branch`** `HEAD` 上；然后填 **一个** `Review cwd`（可为该分支上新开的只读审查 worktree）+ **一个**可复现的 **`Review range` / `Diff basis`**。**禁止**仅填并行轨 **A** 的开发用 `Worktree path` 作 `Review cwd`，却期望审查覆盖仍只存在于并行轨 **B** 分支或提交上的变更（该变更**未进入**轨 A 所检出分支 `HEAD` 时，Git 上不可复现，属 **Assignment 错误**）。

**推荐默认编排（plan 集成分支先行）**——同仓、同一 plan、**≥2 条可写并行轨**时降低 QC/QA 误用单一开发目录风险。**不是唯一合法 Git 拓扑**；其它拓扑仍须满足上文对齐字段 + 本节**强制**条款（派发前 worktree 隔离 + 派 QC 前**单一**待审 `HEAD` + 一套对齐字段）：

1. **先起集成分支（再挂 worktree）**：派发各轨**实现** Assignment 前，PM 与用户确认 **`Branch policy`**，建立 **plan 集成分支**（Assignment 用 **`Working branch: create <plan-integration-branch> from <base>`** 或等价明确写法；`<base>` 必须 PM 明确记录，例如 snapshot `branch.base`（`iteration_base_branch`）、现有 feature 分支、远程跟踪分支或团队既定主线，**不得**未授权假设）。**分支名由 PM 指定**（`feature/<plan-id>-integrate`、`integrate/<plan-id>` 仅为命名示例，**非强制**）。**多 `plan_id` 同源一条 `primary_spec`（Spec 文档）时**：该集成分支语义即 **Spec 集成分支**；各 Plan feature 线 merge 回此线，**全部 Plans 完成后**向显式 `target_branch` **走 PR**（见 `mstar-conventions` SKILL.md「Spec 驱动的分支模型」）。
2. **再挂各轨 worktree**：每条并行轨分配**独立** `git worktree` + **`Worktree path`**；各轨 `Working branch` 一般为**从集成分支出**的 topic 分支（`create <topic-i> from <plan-integration-branch>`）或 PM 书面约定等价结构（例如从同一 `<base>` 出 topic、但**书面指定**合并时**以集成分支为靶**）。**禁止**承接方擅自把未授权功能提交直接堆在 `main`/`master`。
3. **进 QC 之前**：将全部**须同一轮三审覆盖**的提交**归并**（merge / rebase / cherry-pick，以 PM 指定团队方式）到同一条将作 QC **`Working branch`** 的分支 **`HEAD`**（**通常即 plan 集成分支**；PM 已重命名/快进为最终 `feature/*` 则以 Assignment 为准）。**在此**解决冲突；**勿**在 QC Assignment 仍指向「只含部分轨」旧 `HEAD` 时派三审。
4. **QC/QA 的 `Working branch` 与合并主线**：`Working branch` 即上一步**已含全部待审提交**的那条分支（常见 plan 集成分支）。`Review range` / `Diff basis` 通常相对**尚未合并 feature 的**显式目标/base 参照（例如 `merge-base: <target_branch-or-base-ref>` + `tip: HEAD`），审的是 **「feature 线 vs 目标线」** 差异；**默认不要求** QC **通过前**已把该分支 merge 进目标分支（除非 **`Branch policy`** 或用户明确 trunk 式例外）。
5. **本推荐不适用时**：单轨、多仓库、或 plan 已**拆 scope / 多轮增量三审**（见 `mstar-conventions`）— 仍须**逐轮**满足**强制**条款：每轮 QC 对应**一条**快照、**一套**逐字相同的 `plan_id` + `Review range` / `Diff basis`。

**不应合并为一次审时**：若两轨**有意**保持独立可合并单元（例如两条独立 PR），**不得**共用**同一套** `plan_id` + `Review range` / `Diff basis` 假装「一轮三审覆盖全部」。应**拆分 scope**：分轮次审查、不同 **`Feature / scope label`**、不同 `plan_id`、或按 `mstar-conventions` 写明的**显式增量三审**例外，使每轮 QC 各对应**一条**分支快照与**一套**对齐字段。

**同分支多目录例外**：若所有并行轨**始终**在同一条已授权 **`Working branch`** 上协作（每流仅目录不同、提交已互相 `pull`/推送收敛），则任一该分支检出目录在**更新到含全部提交 `HEAD`** 后均可作 `Review cwd`；**不得**使用仍停留在旧提交的 worktree 路径。

### QC / QA 执行约束

- **并行 QC 禁止**在共享检出跑 **test / build / install / lint / typecheck** 等争用缓存或锁的命令（否则 peer QC 易 `Blocked`）。L3 默认手段：`git diff` / `git log` / `git show` / Read / Grep。运行时验证留给 **L1 证据**与 **`qa-engineer`（L4）** — 见 `mstar-review-qc/references/review-responsibility-boundaries.md`。
- QC **报告落盘**默认仅限 Assignment 指定的 `{SDD_DIR}/review/`；上述约定保证 `git diff`、`git log` 与所读文件与**待合并 feature** 一致。PM 另行提交主 plan gate summary / project-register residual changes as durable artifacts。
- **`qa-engineer`**（仅 **`QA gate: mandatory`**）Assignment 用 QC 逐字相同的对齐字段（QC 已写清则 QA 照抄）；执行业务仓命令前须核对检出与分支；Report-only 且无路径依赖时回报须说明验证环境，否则 `Blocked`。
- 若 **QA 与同仓其他可写角色并发**提交测试代码，仍须遵守上文「同仓并发写入」**worktree** 规则（可为 QA 单开一条写入 worktree，**同一 `Working branch`**，由 PM 在 Assignment 写明）。

派发前清单与常见反模式 → **`references/parallel-writable-pre-dispatch.md`**。

## History rewrite 与推送安全

- 已推送分支的任何 history rewrite：先 `git fetch` 记录远端**精确 OID**，发布用 `--force-with-lease=<branch>:<observed-oid>`；**禁止**裸 `--force`。
- Rewrite 推送后：重新 fetch heads；rewrite 前的 review threads / approvals / check 结果**不再是当前证据** — merge 结论前须重审（commit hash 与 inline-comment anchor 已失效）。
- 证据最窄原则（audit / QA Assignment 场景）：选择会在目标回归上失败的**最窄**检查；不因「push 在即」重跑已通过的检查。
- 本节只管 rewrite / lease / 证据失效面；CI / review 波次 push 门禁（时序）SSOT → `mstar-iteration` §5.1a。

## Worktree / branch cleanup（merge 后回收；唯一契约本体）

生命周期末端的物理回收（feature/integration worktree、本地/远端分支删除）的 ownership 与守卫规则**只在本节**；两条时序车道的 call site（Phase-2 同轮 / Phase-6 收尾）只引用本节，不复制规则。命令（**dry-run 默认**；无 fetch / prune / 任何写入）：

```text
mstar worktree cleanup --workflow <id> [--harness <path>] [--apply] [--remote] [--worktree <path>]
```

- dry-run 逐候选打印 `verdict | kind | ref | reason` 后结束；`--apply` 只执行当前 `remove` 行。Exit：0 = 合法 dry-run / eligible 移除全部成功；1 = 探测/变更失败；2 = usage。失败行**永不扩大范围**；受保护/拒绝行保持可见。
- `--worktree <path>` 可重复：既收窄 worktree 候选集，也是**操作者所有权断言**——必须匹配记录的生命周期分支与同仓 checkout 身份，不能认领其他 lifecycle 的 worktree。`--remote` 只决定是否纳入 `origin/*` 删除候选；安全探测（integration 证据）无论是否 `--remote` 都会收集。

**Ownership（禁止命名推断）**：候选归属只来自 snapshot 行元数据（`plans[].execution_lease`；lease 释放后为保留的行 `metadata.working_branch` / `metadata.worktree_path` 与 retained track Assignments）或已验证的显式 `--worktree` 断言。归属缺失 / 歧义 / 他属 → `cleanup.refuse.foreign-worktree` / `cleanup.refuse.foreign-branch`。

**合并证据硬前置**：本地资格 = `git branch --merged <base>` 成员资格，base 取候选自己的锚（plan/track → `branch.integration`；standalone plan / integration 分支 → `branch.target`）。远端证据绑定 {branch, tip, base} **同一分支化身**；当前 harness 无 PR-merged 记录源（`prMerged` 恒为 null）→ 远端仅走 tip-ancestor 历史残留路线。squash-only（tip 非 base 祖先）**保留并报告，绝不 `git branch -D`**；旧 merged PR 不能授权已复用分支的新化身。

**Refusals（refuse 行可见、可审计，不是 apply 失败）**：active `execution_lease` / `integration_merge_lease`（按 path 与 branch 匹配，跨**全部**已知 snapshot）→ `cleanup.refuse.active-lease`；分支在**任何** checkout 检出 → `cleanup.refuse.checked-out`；foreign worktree；dirty / locked worktree；protected refs（默认分支、每个 `branch.base`、非终结 integration 分支、非 Done plan/track 行）→ `cleanup.keep.protected-ref` / `cleanup.refuse.non-terminal`。

**Done child ≠ active parent**：已 merge 的 Done plan/track 行**即使父迭代仍在运行也 eligible**（时序车道 1）——不存在「父必须终结」的一刀切；反之，非终结 integration 与非 Done 行跨**所有** lifecycle 受保护。standalone plan 即整个 lifecycle：以 `branch.target` 为证据 base，且**先 terminal close** 才清理。

**顺序（--apply；worktree 移除 ≠ 分支删除）**：普通 `git worktree remove`（**永不 force**）移除 eligible attached worktree → **重新探测 + 重新规划** → 删除**现已**未检出的分支（`git branch -d`，**永不 `-D`**）→ 远端 expected-OID compare-and-delete（`git push --force-with-lease=refs/heads/<branch>:<observed-oid> origin :refs/heads/<branch>`；ref 已移动 → `cleanup.refuse.facts-changed`，**不**自动用新 OID 重试）。dry-run 打印 worktree `remove` + 其分支 `refuse(checked-out)` 是合法状态。**禁止**全局 `git worktree prune`（会动 foreign 注册）；Git 调用 cwd 固定在 main worktree root（永不位于移除候选内）。

**Lease 释放是手工 owner 动作、cleanup 范围外**：cleanup（与 close）**从不**释放 lease；owner 先手工释放再清理，释放后归属靠保留的行元数据 / Assignments 维持。

**两条时序车道（唯一合法时机）**：

1. **Phase-2 同轮**（per-plan）：integration merge 成功的**同一轮**回收该 Done plan/track 的 feature worktree + 已合并分支（call site → `mstar-iteration` `references/phase-2-worktree-lease.md`「Same-round plan cleanup」）。
2. **Phase-6 收尾**（integration 面）：只在 valid terminal close（§6.1–§6.3 完成）+ PR **verified merged** 之后回收 integration worktree / 分支 / 远端残留（call site → `mstar-iteration` `references/phase-6-post-merge-close.md` §6.4）。Phase-6 gate 只查本地 state，**不**验证 merged、**不**检查物理清理是否完成。

> **Engine check (when available):** dry-run 即机器检查 —— `mstar worktree cleanup --workflow <id>`（或 import `planWorktreeCleanup` from `@mstar-harness/engine`）对当前 facts 输出 remove/keep/refuse 计划，每行带稳定 `cleanup.*` 码。若已知受保护目标（active lease / 非 Done / 非终结 owner）出现 `remove` → STOP：守卫有错，**任何 `--apply` 前先修**。Skill text above remains authoritative when the runtime is absent.

## Workflow

主链：**PM 唯一分支决策**（`Working branch` / `Branch policy`，写进 Assignment）→ 实现者在 feature worktree 写产品编辑（L1：control root（主 checkout）管进程 SSOT、integration worktree 管 merge、feature 管源码）→ **QC 前**全部待审提交归并到**单一 `Working branch` `HEAD`** → 派 QC 三审 / QA 时共用**同一套对齐字段**（`Review cwd` / `Working branch` / `plan_id` / `Review range` / `Diff basis`，逐字相同）→ 集成分支 merge 串行（`integration_merge_lease`，在 integration worktree 执行）。并发写流在派发**前**完成 worktree 隔离（L1 跨 plan / L2 同 plan）；主 worktree 驻留分支 = 计划头记录的 **`Main worktree branch`**，全程不切换。

## References

- 派发与反递归红线 → **`mstar-dispatch-gates`**
- SDD implement 波次（file handoff / reviewer）→ **`mstar-sdd`**
- 迭代 Phase 2 integration worktree + lease 细则 → **`mstar-iteration`** §2（`references/phase-2-worktree-lease.md`）

### L1 refusal diagnostics across hosts

CLI, dsh, and omp share `worktree.l1.lifecycle-register-unreadable` when the active register cannot be enumerated and `worktree.l1.lifecycle-snapshot-unreadable` when a registered sibling cannot be read/validated. They fail closed; an absent register contributes no siblings. Engine SDD governing-row discovery remains lenient for unreadable siblings (only readable active snapshots contribute), but a governing active snapshot carrying both integration/control path keys refuses instead of becoming standalone. This is an intentional engine-versus-host seam distinction, not equivalent evidence coverage.

`worktree.l1.integration-missing` covers required integration inputs not supplied and a supplied integration path absent on disk; an existing unusable checkout is reported by branch/checkout probe failures. A standalone plan with both integration fields omitted has no integration requirement and does not emit this code.
