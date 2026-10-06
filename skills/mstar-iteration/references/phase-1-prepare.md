# Phase 1: start（启动迭代）— prepare detail

> Loaded by `mstar-iteration` SKILL.md on the **start** route（启动新迭代 / 重开方向锁定）。**Read `mstar-harness-core` first.** Per-plan gates → **`mstar-phase-gates`**；dispatch 机制 → **`mstar-dispatch-gates`**。Phase 1 在 PM lock 前不算完成（§1.6）。

PM 在新迭代启动时执行。

## 1.1 收集上下文

1. 查 catalog 了解历史迭代：`mstar catalog list`（按 kind 过滤，见 help；`{ITERATION_DIR}/README.md` 若存在只是散文导览，**不**是登记表；store 未初始化/未激活时查询拒绝 —— `store.not-initialized` / `store.not-active`，**不**读作「没有迭代」）
2. 读 `STRATEGY.md`（若存在），对齐战略方向（见 `mstar-strategy`）
3. 查 catalog 取 Research 候选：`mstar catalog list`（按 kind / document kind / lifecycle 过滤出 `active` knowledge；见 help；**不**要求阅读全部 knowledge 正文；README 表格不再是权威）
4. 如果有未完成的 roadmap 残余（上一迭代标记为 `next` 的 plan），纳入本次迭代范围候选

**Direct skill entry** uses interactive direction lock by default; explicit caller opt-in may select autonomous mode without a command. Command-only helpers are not runtime dependencies.

## 1.2 定义迭代范围

与用户/产品对齐后（或按下方 **autonomous** 模式锁定后），确定：

| 字段 | 说明 |
|------|------|
| **Iteration ID** | 唯一标识，推荐 `v<major>.<minor>` 或 `iter-<YYYY-QN>` |
| **范围** | 本迭代要锁定的 spec 点（问题陈述清单） |
| **Plans** | 预期在本迭代中完成的 plan 列表（允许中途增减） |
| **里程碑** | 关键节点与日期 |
| **验收标准** | 迭代级别的 Done 定义 |
| **非目标** | 明确排除在本次迭代外的事项 |
| **Roadmap 上下文** | 本迭代在整体 roadmap 中的位置（current iteration / next iteration） |
| **Delivery branch policy** | `iteration_base_branch`（integration 分支从何处分出）、`spec_integration_branch`、`target_branch`（最终 PR 目标） |
| **Scale budget**（可选） | 仅当 caller **显式**给出或选用 **autonomous** 时适用：`S` = 1 **业务** plan；`M` = 2–3；`L` = 3–4（上限 4）；`XL` = **>4**（5+）。**只计实际业务交付 plan**，不计 harness 流程性工作（Review 链 / QC / QA / compound / close / PR 等）。**interactive 默认不强制** S/M/L/XL。计数细则 → **`references/autonomous-direction-lock.md`** § Scale budget |

### Direction lock modes

compass/plans 初稿落盘前，必须锁定**单一**迭代方向、成功标准、非目标，并确认 delivery branch policy；决策写入 compass `## Scope` / `## Acceptance Criteria` / `## Non-Goals` 与 Delivery Branch Policy。**已决事项**另须落入 compass **`## Decisions`**（每条 = `decision` + `rationale` + `source`：user instruction / grill-me / autonomous ranking），**未决事项**落入 **`## Open Questions`**（每条带 owner —— `product-manager` / `architect` / `writing-specialist` / `PM` —— 与 blocking 标记；无未决项写 `None`）。两节形态 → **`references/iteration-compass-template.md`**；初稿深度与清除义务 → §1.3 **Draft contract**。

| Mode | 何时选用 | 行为 |
|------|----------|------|
| **`interactive`** | **默认**（未显式声明 mode 时一律用此） | 与用户/产品**逐问**收敛方向与 branch policy；不得静默默认 `main`/`master` |
| **`autonomous`** | **仅**当 caller / Assignment **显式**声明 `Direction lock mode: autonomous`（或等价书面 opt-in） | 代码优先调研 → 排序候选 → **锁定推荐方向并落盘 rationale**；不因「是否同意该方向」例行问用户。细则 → **`references/autonomous-direction-lock.md`** |

**宿主 Plan UX（interactive）**：若宿主提供 Plan 会话（先写 session plan、后点 Build 才执行 todos）：

- Where the host permits it, scaffold only the session-plan outline and todos, then update that same session plan from user feedback. Do not author the formal compass, guides, plans or specs before §1.2.5; an empty outline is not design approval.
- Branch policy：在 plan 中写推荐值 + rationale（不得静默 `main`/`master`）；用户可用反馈改正；仅在用户明确结束反馈后仍缺字段时再追问。
- 访谈式收敛 **仅**在反馈结束后仍有阻塞缺口时可选发起。
- **禁止**为更新内容再开第二份 session plan。

The prototype checkpoint in §1.2.5 applies with or without a Plan session. Obey the active host's Plan-mode write and approval limits: if the package path is not yet writable, prepare the preview in the permitted session-plan surface, obtain the host-required transition, then persist it in the package before formal authoring. Do not use another writer or a second session plan to bypass that restriction. User design confirmation is not authorization to implement or to enter Build.

**禁止**：在未显式 opt-in 时自行切换到 `autonomous`（例如仅因读了本 reference 或存在 roadmap next）。

**Branch policy gate（interactive — 默认路径）**：若用户、现有 roadmap、或项目约定未明确 `iteration_base_branch` / `target_branch`，PM 必须检查当前分支并向用户确认（**Plan 会话**走上方「推荐写入 plan + 反馈改正」；非 Plan 仍须确认）。**不得**因为存在 `main` / `master` 就默认从默认分支开 iteration 或向默认分支提 PR。

**Autonomous branch resolve**：仅 `autonomous` 模式；解析顺序与 STOP 规则见 **`references/autonomous-direction-lock.md`**（勿把该顺序套用到 interactive 以跳过向用户确认）。

<!-- host-hook: direction-lock -->
> Execute the active host reference's `## Host hooks` declaration for `direction-lock`; this file defines no host action.
>
> 本 anchor 在**方向已锁定**（interactive：与用户收敛 / autonomous：方向 rationale 落盘）之后、**compass 与 plans 初稿落盘之前**执行。此时 workflow 尚未登记、compass 尚不存在，属预期状态 —— anchor 动作由 active host reference 的声明决定；登记（§1.5）发生在本步之后。

### 1.2.5 Prototype checkpoint — before formal authoring

Use the collected opinions and preliminary direction from §1.1–§1.2 to make the design understandable before turning it into formal documents. The `direction-lock` hook above remains before any compass/plans draft. Create or reuse `{ITERATION_DIR}/<iteration-id>/` early and retain the design material under `prototypes/` (path authority → `mstar-conventions/references/artifact-storage-paths.md`).

**Interactive path**

1. Create a human-readable **HTML prototype** in the package. Explain the problem, proposed outcome, scope/non-goals and important trade-offs in plain language, with visuals that expose the design: screens/interactions for UI work, or flows, states, relationships and before/after views for non-UI work. Choose what helps this user decide; neither production code nor a fixed UI template is required.
2. Present the current HTML through a host-supported preview or accessible file link and explain the decisions it illustrates. Ask for feedback on this design, not routine approval of a document-writing task.
3. For each feedback round: discuss the meaning and trade-offs, update the **same prototype**, record the changes and unresolved decisions, then **present the updated HTML again**. Feedback, silence, approval of an older revision or “continue discussing” is not approval of the current design.
4. Continue until the user explicitly confirms the **current revision**. Retain its path, revision identifier, feedback/decision summary and the user's confirmation as the drafting baseline in the prototype or an adjacent record under `prototypes/`. Preserve enough history to distinguish the confirmed baseline from later changes; do not overwrite its approval evidence with a new design.

**Autonomous path (explicit opt-in only)**: retain a prototype under the same package path before §1.3, choosing **HTML, Markdown or JSON** to fit the work. Record the format rationale, design choices, assumptions and an **autonomous disposition**, not a fabricated user approval. Apply the ranking, branch and STOP rules in `autonomous-direction-lock.md`; do not solicit routine human confirmation or force HTML. Keep the direction-lock record separate from this design material.

PM may involve **product-manager** and/or **architect** to clarify product flows or technical feasibility while making/revising the prototype. This is optional, not a new mandatory role chain or permission for PM to perform specialist implementation in-thread. Give contributors the current prototype, feedback and decision context; shared-file edits are sequential. Reuse their contributions during formal authoring and role selection (§1.6), rather than repeating settled work.

**Checkpoint exit**: retained current design + explicit current-revision confirmation (interactive) or truthful autonomous rationale/disposition + resolved blocking design questions. Only then author the compass, guides, plans and specs (§1.3). Pass the prototype path/revision, confirmation or disposition, decisions and remaining owned questions to subsequent roles. A material design change during authoring or Review & Edit returns here: revise and re-present/reconfirm the interactive prototype (or record a revised autonomous disposition), then realign the affected formal documents. If the direction itself changes, reopen §1.2's decisions and semantically re-lock the direction before resuming drafts.

**Semantic re-lock is not a new host start**: within the same iteration/workflow, retain the already-executed `direction-lock` action and current binding. Do not repeat a host's one-shot start/arm or rebind merely because feedback changed the direction; follow the active host's recorded action/result and lifecycle rules. This changes neither the initial hook's position/obligation nor model-selection semantics, and never waives prototype confirmation or Prepare gates. If a genuinely new iteration/workflow is needed, resolve the current binding/ownership through the active host's documented lifecycle/recovery route before a new identity's initial hook is permitted. Do not invent manual state repair, preference changes or implicit authorization to clear/re-arm a binding.

The prototype is **design context**, not a frozen spec, code/API implementation, runnable acceptance evidence or a Prepare-gate waiver. Formal documents must translate the baseline into real acceptance criteria, constraints and interfaces; per-plan `specify → clarify → plan` and host execution authorization remain required.

## 1.3 Author the iteration package + compass

After §1.2.5, write **`delivery-compass.md`** into the existing `{ITERATION_DIR}/<iteration-id>/` package (canonical; never a new flat `<id>-delivery-compass.md`). Use the full `references/iteration-compass-template.md` structure (YAML frontmatter, `## Roadmap Position`, close sections). Fill `end_date` only at iteration-close; prose completion does not replace frontmatter `status`. Create `guides/`, `specs/` and an optional package `README.md` as needed. Link the retained prototype baseline from compass and affected plans; use existing `metadata.iteration_refs` through the normal producer path, not a new field or `primary_spec`/`spec_refs` for a prototype.

```markdown
---
iteration_id: <id>
start_date: YYYY-MM-DD
status: active
iteration_base_branch: <branch-or-ref>
target_branch: <branch>
plans: []
---

# <iteration-id> Delivery Compass

## Scope
<本迭代要锁定的 spec 点>

## Decisions

| # | Decision | Rationale | Source |
|---|----------|-----------|--------|
| D1 | <已决事项> | <依据> | user instruction / grill-me / autonomous ranking |

## Open Questions

| # | Question | Owner | Blocking? |
|---|----------|-------|-----------|
| Q1 | <未决事项> | product-manager / architect / writing-specialist / PM | Yes / No |

## Prototype baseline
- Retained prototype: <`prototypes/` path and revision>
- Disposition: <current-revision user confirmation or autonomous rationale; evidence link>

## Plans

| plan_id | Name | Status | Notes |
|---------|------|--------|-------|
| <id> | <name> | Todo | |
| ... | ... | ... | |

## Milestones
| Milestone | Target date | Status |
|-----------|-------------|--------|

## Acceptance Criteria
- <迭代级验收项>

## Non-Goals
- <明确排除的事项>

## Roadmap Position
- Current iteration: <what this iteration delivers>
- Next iteration: <what comes next, owner, trigger>

## Delivery Branch Policy

| Field | Value |
|-------|-------|
| iteration_base_branch | <branch-or-ref> |
| spec_integration_branch | iteration/<iteration-id> |
| target_branch | <PR target> |
```

> **Engine check (when available):** import `validateCompassFrontmatter` from `@mstar-harness/engine` in a host hook to validate the compass frontmatter above (no CLI form yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

### Draft contract（PM 初稿的深度契约）

PM 的初稿是**上下文载体**：被派发角色看不到 PM 的会话，只从磁盘读（`delivery-compass.md` + plans + `<iteration-id>/` package）。所以初稿按 **「骨架 + 完整上下文」** 交付，深度边界如下。

**(i) Draft inputs**: the locked direction; retained prototype path/revision and its confirmation or autonomous disposition; settled decisions (compass `## Decisions`); remaining owned questions (`## Open Questions`); non-goals and rationale; constraint sources (user instructions / existing specs / knowledge / roadmap); acceptance seed; branch policy; and the §1.6 role-selection rationale. Carry forward prototype-stage product/architecture contributions so the next role need not reconstruct them.

**(ii) Details may remain coarse**: candidate analysis, module/interface detail, per-task decomposition and plan-level technical design may be marked for an actual selected owner to complete. Do not invent detail or create markers for an omitted role. A remaining product/technical gap requires reassessing §1.6 selection, not treating the prototype as a finished spec.

**(iii) 标记形态（语法只在本节定义；其它文件按 path + 节号引用本处）**：

```text
<!-- TODO(owner: <role-id>): <what is missing and what must be decided> -->
```

Allowed owners are `product-manager`, `architect`, `writing-specialist` or `PM` (a decision requiring user involvement). Specialist-owned markers/questions must belong to a selected §1.6 role; do not manufacture work for an omitted role. Unowned `TBD` / `...` / `etc.` remain prohibited at every stage.

**(iv) Clearance deadline**: compass `status: locked`. Before lock, clear all specialist-owned markers. A genuinely unresolved non-blocking user decision may be explicitly reassigned to `PM` with rationale and disclosed to the user; never silently delete it. Reassignment is not a way to omit necessary product/technical editing or bypass a blocking decision. Clearance/reporting duties → §1.6.

**(v) Open Questions disposition**: resolve each row into `## Decisions`, convert it to an owned marker subject to (iv), or explicitly reassign a genuinely non-blocking user decision to `PM` and disclose it. Never silently delete a row. Any `Blocking? Yes` question must become a settled decision before lock regardless of owner or representation; otherwise `Gate decision: blocked` and compass cannot be locked. Only non-blocking `PM` rows may remain after lock. An omitted specialist's unresolved gap requires re-selection (§1.6), not a skipped round.

## 1.4 登记迭代 catalog 身份（DB 权威）

迭代 identity、compass 位置、description 与 project/iteration 归属是 **`{HARNESS_DIR}/store.db`** 的 catalog 行（contract §1）—— **不**在 `{ITERATION_DIR}/README.md` 维护「一行 = 一次迭代」的登记行（README 只作散文导览）。

- **登记/查询**：单行 `mstar catalog register`（或多个）与关系 `mstar catalog link`；批量走 reviewed 流程 `mstar catalog discover`（只读提案：配置根 tracked 正文 + legacy 索引行，带显式 `unknowns`）→ 人工 review mapping → `mstar catalog import`（冲突或 source 漂移整单拒绝，不创建 workflow session）。
- **执行注册**：ACTIVE 的 workflow / plan 行、DB 根 register 与 catalog delta 必须由**同一个 registration journal** 发布（contract §3）；pre-activation 才发布 snapshot + 文件根 entry。pending 状态 `catalog.registration-pending` 用 `mstar catalog reconcile` 收口（只读列出与 abort 形态见 help）。
- **限制**：`store.db` 本地且默认 gitignored —— tracked 正文（compass/README 散文）**无法**重建本地 catalog 历史；`discover` 从不假设文件名编码迭代归属或生命周期，未声明项以显式 `unknowns` 披露。

> **Engine check (when available):** import `readCatalogCompleteness` / `assertCatalogCompleteness` from `@mstar-harness/engine` (or read the rows with `mstar catalog list` / `mstar catalog show`) in a host hook to read the catalog rows above (no CLI form for the completeness report yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## 1.5 登记执行状态（formal iteration 必填）

iteration 正式全流程**必须**经 **`mstar iteration register`** 注册到当前权威：

- **ACTIVE**：registration journal 写 `{HARNESS_DIR}/store.db` 的 workflow / Todo plan 行、`execution_registry` 与 catalog delta；使用 `--expect <root-execution-token> --operation <id>`，token 经 `mstar status validate` 获取。注册不授权实现。仅 **pre-activation / engine-absent** 回退为 create-only `{WORKFLOW_DIR}/<id>/snapshot.json` + 根 `status.json` entry；文件路由重跑可补缺失 root entry，ACTIVE 不读写这两份文件。store-pinning / 写入顺序 / rollback 语义 → **`mstar-artifacts`** `references/plan-workflow-lifecycle-contract.md` §4a。输入与 flags 以 `mstar iteration register --help` 为准。
- 分支锚点在 ACTIVE workflow 执行行（pre-activation：snapshot 顶层 `branch`）：`base`（= `iteration_base_branch`，创建 integration 的祖先 ref，**不是**隐式 `main`）、`integration`（= `spec_integration_branch`）、`target`（= PR 目标分支）。
- 各 plan 行的 `file` 指针统一走**唯一**的注册 plan 解析器：落盘的是**规范绝对路径** `{PLAN_DIR}/<plan-id>.md`，不是调用方拼写的副本。可接受的输入只有规范绝对路径或**规范化 harness 相对路径**；仓库相对拼写 `.mstar/plans/<id>.md` 在第一条 journal 行、snapshot 或任何根写入之前即被拒绝（诊断给出收到的形式、base、期望的规范目标与允许的形式）。既有合法的 harness 相对行仍由同一解析器可读——这是声明的输入形式，不是回退搜索。
- 各 plan 行 `metadata.iteration_refs`、`spec_integration_branch`、`merge_target`（`merge_target` 通常为 `spec_integration_branch`）由 producer 从 compass / integration 输入**派生**——PM 无需也不应手工构造这些字段。

compass frontmatter 的 `iteration_base_branch` / `target_branch` **必须与**当前权威 workflow `branch` 一致；缺失处理见 Phase 2 §2.3。ACTIVE 不手工回填 snapshot，文件回填只属于 pre-activation。

ACTIVE 的中途增减范围先经 `mstar plan bind --execution --workflow <id> --coordinator --expect <root-execution-token> --operation <id>` 获取 coordinator 身份，再使用 `mstar workflow show-prepare` / `amend-prepare` 的 ACTIVE 传输（session reference、完整 scope token、operation id；形状见 help）。下面的文件会话 bootstrap 形态仅用于 **pre-activation**。

**中途增减范围（已存在且仍在 Prepare 的 workflow）**：用户/产品批准的范围扩张**不得**手改受保护状态。先以**显式获取的身份**建立该 workflow 的 coordinator 会话 —— 本地操作者用 `mstar plan bind --coordinator --workflow <id> --session-id <id>`（引擎从不生成 coordinator id，继承的 `MSTAR_HOST_SESSION_ID` 不再授权 coordinator bootstrap），托管宿主走其宿主自有入口而**不经** shell；再经受守卫入口 `mstar workflow show-prepare` 读取快照与 compass 两个字节版本，并以 `mstar workflow amend-prepare` 追加已批准的 Todo 行、登记已 review 的 integration checkout 与 `plan_parallelism`（仅 Prepare 且无执行所有权时可用；无 force/replace/init 通道）。既有行若 plan 指针已畸形，用同一次 `amend-prepare` 的 `correctPlanFiles`（每条恰为 `{id, expectedFile, file}`；`appendPlans` 仍在，仅做修正时传空数组）修正：只有该行 `file` 与常规 `updated_at` 变化，`expectedFile` 必须与行内 `file` **逐字相等**且指向同一 plan，新 `file` 走同一解析器。owner 席位丢失时另有受审计的 JSON Prepare 恢复（`mstar workflow recover-coordinator`），它**不是** active-store 的 session 恢复。守卫与字段权威 → **`mstar-artifacts`** `references/status-and-residuals.md`「Prepare workflow amendment」/「Prepare coordinator recovery」；forms / exit codes → **`mstar-use-cli`** `references/plan-and-workflow.md`。

## 1.5.5 产物边界（specs · iterations · knowledge）

Phase 1 与 §1.6 须遵守 **`references/iteration-artifact-boundaries.md`**（HARD）：

| 树 | Phase 1（start）主责 | 说明 |
|----|---------------------|------|
| **`{SPECS_DIR}/`** | **Phase 3 iteration-close** specs 提升流程 | **长期**规范性产出：锁定规格、ADR、契约；plan `primary_spec` / `spec_refs` 主要挂此处 |
| **`{ITERATION_DIR}/`** | PM; selected product-manager / architect; mandatory writer | **`<iteration-id>/` package** (`prototypes/`, `delivery-compass.md`, iteration specs/guides) |
| **`{KNOWLEDGE_DIR}/`** | **非** start/execute 直写；**`mstar-compound`** @ iteration-close（含 package **提升**） | 可复用实施 SSOT |

**写入边界**：Phase 1（含 §1.6）的规格落在 `<iteration-id>/specs/`；全局 `{SPECS_DIR}/` 在 Phase 3 iteration-close 提升时写入；`{KNOWLEDGE_DIR}/` 由 **`mstar-compound`** @ iteration-close 写入。

## 1.6 Review & Edit chain（integration 分支前强制）

**Phase 1 在 PM lock 前不算完成**——compass/plans 初稿落盘 ≠ Done。

**Assignment preflight（每次角色 invoke 前，HARD）**：自然语言 / skill 直接触发（非 command 路径）时，本 skill 不依赖 command 层 preflight——**每个** Phase 1 角色派发前，PM 必须运行 assignment preflight（`references/command-shared-invariants.md` 的 warn-only / `enforcement: hard` fail-fast 片段；`enforcement: hard` 时校验失败即阻断派发）。Command 层（`/iteration-start`）走其自身 preflight；本行确保 skill 触发路径门禁不缺失。

派发机制 → **`mstar-dispatch-gates`**（specialist review-and-edit dispatch，**顺序链**）。PM **不得**创建 integration worktree 或 push `spec_integration_branch`（Phase 1 的全部写入目标——compass / plans / `<iteration-id>/` package——均为默认 gitignored 的本地工件；全局 `{SPECS_DIR}` 在 Phase 3 iteration-close 提升时写入并随 close commit 进入 integration 分支。因此 §1.6 完成后的 §6 仅**新建并 push** integration 分支），直到：

1. The §1.2.5 prototype checkpoint has passed and formal documents reflect its current baseline.
2. PM has selected any needed **product-manager** and/or **architect** editing rounds and recorded include/omit rationale in compass `## Decisions`. Consider product complexity (new user journeys, priorities, ambiguous acceptance), technical complexity (cross-module/API/state/long-term contract changes), **remaining gaps after prototype contributions**, and what is already settled. Simple work with no such gaps may omit both; complexity/gaps may require one or both. Reassess at drafting and before lock whenever new questions or markers expose a missing product/technical decision.
3. Actual selected rounds have edited the compass, plans and relevant package guides/specs, in order **product-manager (if selected) → architect (if selected) → writing-specialist (always, last)**. Shared-document edits are sequential; wait for each selected round to finish before the next. Selection rationale is not an invocation receipt, and prototype contributions do not count as a formal editing round when that role is selected. Do not create fake skip receipts. No role adds to `{KNOWLEDGE_DIR}/` in this chain; Phase 1 specs stay in `<iteration-id>/specs/`.
4. **writing-specialist** has completed final **corpus hygiene** and marker/question closure for the current documents: only this iteration's affected package and directly related knowledge references, correcting misplacement back into the package. Details → `iteration-corpus-hygiene.md`, `iteration-artifact-boundaries.md`.
5. PM has set compass `status: locked` and confirmed each plan's Prepare gate (`specify / clarify / plan`). Role omission never waives a gate or permits unresolved blocking questions/specialist markers.

**Dispatch inputs and evidence**: for each selected role, provide draft/compass paths, the retained prototype baseline (path/revision, feedback and confirmation or autonomous disposition), prior contributors' conclusions, selection rationale, decisions, owned open questions, non-goal reasons and that role's marker list. Apply `mstar-dispatch-gates` to every actual invoke. An empty marker list is truthful; omitting a role is not permission to leave its work unowned.

**Marker clearance (§1.3)**: each invoked role clears its own markers, or explicitly reassigns a genuinely non-blocking user decision to `PM` with rationale; report cleared/reassigned counts in its Completion Report. The mandatory writer checks **all** markers and questions, including any accidentally left for an omitted specialist. If product/technical work is still needed, return it to PM for re-selection and the relevant editing round; the writer does not silently clear it or substitute for that specialist. After any reopened round, writer closes the revised documents again. Lock requires no specialist markers and no blocking questions, with only explicitly disclosed non-blocking `PM` items allowed.

**Ordering rationale**: selected product scope/priority edits precede selected architecture/contract edits; writing, placement and consistency close the resulting corpus. Reuse early exploration and prototype-stage contributions; do not re-scan the repository for each round. Role mention hygiene → active `mstar-host` reference.

**Completion evidence**: retained prototype baseline and its genuine confirmation/disposition; edited compass/plans/package specs/guides; include/omit decisions for optional roles; completion evidence for the actual ordered rounds ending in writer; package hygiene, catalog registration/metadata and compass `status: locked`. The edited documents are the review SSOT; no separate per-plan-QC-style iteration report is required.

Before compass lock, review the **local ignored per-edit attribution record** against the edits in the specialist chain: actual ISO time, editor seat, observable model or `unknown`, iteration identity and scope. Correct an omission now with the actual correction time and an explicit note that the earlier edit was unobserved; never backdate or infer a child model. Canonical fields and tracked-example prohibition → `mstar-artifacts/references/plan-files-and-reports.md` § Edit attribution. This is a review obligation, not a machine gate.

**Uncommitted-docs exception (bounded — Phase 1 only)**: prototype preparation and Review & Edit documents (`prototypes/`, compass, plans and the package) remain uncommitted local artifacts in the primary checkout/control root; its branch is not switched and no feature commit is created. This does not bypass host Plan-mode write limits. Global `{SPECS_DIR}` is written only by the Phase 3 promotion/close commit. The integration-worktree step (`phase-2-worktree-lease.md` §2.3 step 7) creates and pushes the integration branch itself; never carry primary-checkout documents or existing user changes into it.

**Anti-patterns**: authoring formal documents before the prototype checkpoint; treating an old approval as approval of changed design; using autonomous mode without opt-in; omitting a required specialist despite a remaining gap; fabricating skip receipts; PM replacing selected specialist edits/the mandatory writer without invoke; or parallelizing shared-document rounds.

**Phase 1 完成 anchor（`phase-1-lock`）不在本文件触发**：compass `status: locked` 只是它的前置之一 —— 它只在 integration worktree 已建立（并记录 `integration_worktree_path`）、新建的 `spec_integration_branch` 已 push（branch push；Phase 1 的写入目标均为 gitignored 本地工件，全局 `{SPECS_DIR}` 在 Phase 3 提升时写入）之后才执行，因此其 marker 由 **`phase-2-worktree-lease.md` §2.3**「Integration worktree (Phase 2 entry) + control root」checklist tail 承载（Phase 1 路线经 `iteration-start` §6 走到该 checklist）。
