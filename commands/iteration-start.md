---
name: iteration-start
description: Start a new harness iteration — research, grill-me, compass/plans, Review & Edit chain (long-lived {SPECS_DIR}/ + {ITERATION_DIR}/<id>/ package; compound promotes package at close only), PM lock, integration branch.
agent: project-manager
---

# Start Iteration

Start a new Morning Star harness iteration. **Not Done until the Review & Edit chain runs via dispatched roles and PM lock — not when compass files are first written.**

## PM invariants（本命令全程有效 — 读完再动手）

你是 **`project-manager` 编排者**，不是三专业角色的合并替身。

| 禁止（PM 线程） | 必须（宿主有 Task 时） |
|-----------------|------------------------|
| 自己 Edit compass/plans/specs 冒充 product-manager / architect / writing-specialist 的审查编辑 | §5.1 → §5.2 → §5.3 **顺序**各 **1 次 invoke**；上一角色返回后再派发下一角色 |
| 只写 `## Assignment` 或 checklist 就声称 review chain 完成 | **几条角色 ⇒ 几条 invoke**；零 invoke = `dispatch incomplete`（`mstar-dispatch-gates`） |
| §5 完成前 commit / 创建 integration 分支 | 5.4 PM lock 在 subagent 返回且磁盘产物已修订之后（`mstar-iteration` §1.6） |

派发细则 → **`mstar-dispatch-gates`**（specialist review-and-edit dispatch）+ **`mstar-host`**（宿主 invoke 能力）。**不得**在 PM 线程加载其他 role reference 代劳。

**完成定义**：compass `status: locked` + 三角色 invoke 已返回 + pre-commit checklist 全 `[x]` — 不是初稿落盘。

Detailed workflow → **`mstar-iteration` § Phase 1**（含 §1.6 Review & Edit chain）；per-plan Prepare gates → **`mstar-phase-gates`**（specify → clarify → plan）。

**Path split（HARD）**：

| 宿主上下文 | 走哪条 |
|------------|--------|
| **Cursor Plan mode**（CreatePlan / Plan 会话活跃） | §0 Boot → §P — **先**空白 CreatePlan，再 **feedback-driven** 自主改同一份 plan；grill-me **仅**在用户明确结束反馈后、仍有阻塞疑问时；**Build 前不执行** Review 链 / commit / integration 分支 |
| **其它**（Agent、OpenCode、非 Plan） | §0 Boot → §1–§6（Research → Explore → grill-me → Write → Review → branch） |

## 0. Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `mstar-iteration` → **§ Phase 1**（迭代范围、compass 模板、**§1.5.5 产物边界**、§1.6 Review & Edit chain、状态初始化）
4. `mstar-dispatch-gates`
5. `mstar-phase-gates` → Prepare（specify → clarify → plan）
6. `mstar-plan-conventions`, `mstar-plan-artifacts`
7. `mstar-host` → active host reference（invoke 能力）；若 Cursor Plan mode → 另读 **`cursor-plan-mode-bridge.md`**（`mstar-iteration` Phase 1 in Plan mode）

**若 Cursor Plan mode 活跃 → 进入 §P；否则继续 §1。**

## P. Cursor Plan mode（Phase 1 scaffold → feedback loop → deferred grill → Build）

**Detect**：会话处于 Cursor Plan mode（系统要求 CreatePlan / SwitchMode，或 Plan 工具可用且当前为 Plan 会话）。

**语义**：Plan 模式期间 **只维护 CreatePlan + SSOT 草稿**；用户侧是 **纯反馈**（提方向 / 提意见），**不是**答问卷。Agent **探索 + 推荐并直接改 plan**。**不**派发 Review 链；**不** commit；**不**建 integration 分支。点 **Build** 后才执行下方 Build todos（对齐 `mstar-host/references/cursor-plan-mode-bridge.md` · Phase 1 in Plan mode）。

### P.0 Single CreatePlan URI（HARD — 防双 plan）

| 规则 | 说明 |
|------|------|
| **CreatePlan 只调用一次** | §P.2 空白脚手架是本会话 **唯一** 一次 CreatePlan |
| **记录路径** | 记下工具返回的 plan 文件路径（常在 `~/.cursor/plans/*.plan.md`）；后续所有修订都写 **这一份** |
| **更新方式** | Feedback / deferred grill 后用 **Read + Write/StrReplace 原地改** 该文件；**禁止**再调 CreatePlan 开第二份 |
| **发现重复** | 若已误开第二份：把有效内容 **合并进第一份**，删除重复文件，并确保用户 View Plan 指向第一份 |

### P.1 Research（只读）

执行与 §1 相同的调研（structured + unstructured + `STRATEGY.md`）。**不要**在本步写 compass/plans 终稿。

### P.2 Early CreatePlan（空白脚手架 — 本会话唯一一次）

Research 后 **立刻** CreatePlan **一次**（**禁止**等方向锁定完成再 CreatePlan；**禁止**之后再 CreatePlan）。

**CreatePlan 最小结构**（session mirror；dual-write 草稿见 P.3）：

```markdown
# Phase 1: <iteration-id-or-TBD>

## Direction
TBD

## Scope
TBD

## Acceptance Criteria
TBD

## Non-Goals
TBD

## Delivery Branch Policy
| Field | Value |
|-------|-------|
| iteration_base_branch | TBD |
| spec_integration_branch | TBD |
| target_branch | TBD |

## Plans
| plan_id | Name | Status | Notes |
|---------|------|--------|-------|
| TBD | | Todo | |

## Feedback log
（吸收用户反馈 / agent 推荐决议后追加）

## Deferred grill log
（仅 P.3.5 若发起 grill 时追加；可空）
```

**Build 才勾的 todos**（顺序；**不要**把 feedback / grill 写成 Build todo）：

1. `harness-init` — 若 `{HARNESS_DIR}` / `status.json` 缺失则初始化
2. `finalize-compass-plans` — 将 **同一份** CreatePlan 正文落成 compass + `{PLAN_DIR}/` plans + `status.json` 登记 + `{ITERATION_DIR}` 索引
3. `review-edit-product-manager` — §5.1 invoke
4. `review-edit-architect` — §5.2 invoke
5. `review-edit-writing-specialist` — §5.3 invoke
6. `pm-lock` — §5.4 compass `status: locked` + Prepare gates
7. `integration-branch` — §6

### P.3 Feedback loop（主路径 — 直到用户明确结束反馈）

**用户模式**：提方向、提意见、纠正推荐 — **纯反馈**。**不要**把用户当成问卷答题人；**禁止**例行一问一答卡更新。

**Agent 每轮**（可多轮，直到用户喊停）：

1. 探索代码 / harness / roadmap（能靠读回答的先读）
2. 形成推荐（Direction / Scope / Acceptance / Non-Goals / Branch policy / Plans）
3. **立刻**原地更新 **§P.2 那一份** CreatePlan（含 `## Feedback log`）+ 推荐 dual-write SSOT 草稿
4. 吸收用户新反馈 → 再探索/再改 **同一份** plan

**Branch policy**：在 plan 中写入 **推荐值 + 简短 rationale**（不得静默默认 `main`/`master`）；用户可用反馈改掉。**不要**在本阶段为 branch 开 grill。

**禁止**：

- 再调 CreatePlan / 写到另一份 plan 文件
- 把「等用户回答问题」当作更新 plan 的门禁
- 在用户结束反馈前加载 / 运行 `grill-me`
- 固定死反馈轮数；Plan 模式内派发 §5 / commit / §6

### P.3.5 Feedback-close → deferred grill（可选）

**触发**：用户明确表示反馈结束（例如：反馈结束、总结、分析反馈、可以了、准备 Build）。

然后 Agent 自检 CreatePlan：Direction / Scope / Acceptance / Non-Goals / Branch policy / Plans 是否仍有 **阻塞缺口**。

| 结果 | 动作 |
|------|------|
| **无阻塞缺口** | **不**开 grill-me；宣布可 Build；确认同一份 CreatePlan + 草稿 SSOT 已反映锁定内容 |
| **仍有阻塞缺口** | Read `skills/grill-me/SKILL.md`（**仅本命令**）；对 **剩余缺口** 做最小 grill（一段一问）；每段收敛后仍 **原地改同一份** CreatePlan，并追加 `## Deferred grill log` |

**Direction lock mode** 仍为 interactive 语义，但 Plan 会话的 **主路径是 feedback-driven**；grill 是 close 后门禁，不是主循环。

### P.4 Build（执行 Phase 1 可执行门禁）

用户点击 **Build**（或 Plan → Agent）后：

1. 按 Build todos 顺序执行：`harness-init` → `finalize-compass-plans`（以 **View Plan 打开的那一份** CreatePlan 为准）→ §5 Review 链（5.1→5.2→5.3）→ `pm-lock` → §6
2. **禁止**把 Build 当成重新跑 feedback / grill
3. pre-commit checklist（见 §5）全 `[x]` 后再 commit / push integration 分支

**非 Plan 路径从这里继续 ↓**

## 1. Research

Load harness entry, then survey structured and unstructured sources:

**Structured harness dirs:**
- `{HARNESS_DIR}/status.json` → active plans, deferred features, residuals
- `{ITERATION_DIR}/` → previous iteration compasses, roadmap batches
- `{KNOWLEDGE_DIR}/` → design knowledge, architecture notes
- `{SPECS_DIR}/` → existing specs, gaps

**Unstructured discovery — search the repo for planning artifacts by name:**
- Glob for `**/roadmap*.md`, `**/ROADMAP*.md`, `**/*-roadmap.md`
- Glob for `**/deferred*.md`, `**/DEFERRED*.md`
- Glob for `**/features*.md`, `**/FEATURES*.md`
- Also search for `**/backlog*.md`, `**/TODO*.md`, `**/todo*.md`, `**/*.plan.md`
- Open and read any matches that carry iteration-level or deferred-scope information

Identify deferred or incomplete items from prior iterations as priority candidates for this iteration.

Also read `STRATEGY.md`（if exists）for strategic alignment.

## 2. Explore Directions

> **非 Plan 路径**。Cursor Plan mode 已在 §P 处理；勿与 §P 并行再跑一遍。

Explore candidate directions targeting **product completeness**:

- Default to completing deferred items from previous iterations
- Allow substantive refactoring where it accelerates product maturity
- Scope 2–4 candidates, each with clear product-completeness goals and trade-offs

## 3. Lock Direction — bundled `grill-me`

> **非 Plan 路径**。Cursor Plan mode 用 §P.3 feedback loop + §P.3.5 deferred grill（主路径不是 grill）。

**Direction lock mode: `interactive`**（`mstar-iteration` §1.2 默认；本命令不使用 `autonomous`）。

This command bundles a **non-`mstar-*`** skill at `skills/grill-me/SKILL.md`. **Only this command step**（及 §P.3.5 deferred grill）references it — **do not** load it from `mstar-harness-core` or other `mstar-*` skills.

**Before this step:** Read `skills/grill-me/SKILL.md`.

Run **grill-me** to stress-test candidate directions with the user:

- Walk through trade-offs for each candidate
- Converge on a **single iteration direction** with shared understanding
- Document: locked direction, success criteria, non-goals
- Confirm delivery branch policy:
  - `iteration_base_branch`: branch/ref used to create `spec_integration_branch`
  - `target_branch`: PR target after iteration-close
  - If either is not explicit, inspect the current branch and ask. **Do not default to `main` / `master` just because those names exist.**

## 4. Write Compass & Plans

> **非 Plan 路径**。Plan mode 在 §P.2–P.3.5 维护 **同一份** CreatePlan 草稿，Build 时由 `finalize-compass-plans` 落盘终稿。

Produce harness artifacts per **`mstar-iteration` § 1.3**（template: `mstar-iteration/references/iteration-compass-template.md`）：

- `{ITERATION_DIR}/<iteration-id>/delivery-compass.md` — YAML frontmatter **must** include `iteration_base_branch`, `target_branch`, `status: active`
- `{PLAN_DIR}/<plan-id>-<name>.md` for each plan in this iteration
- Register all plans in `{HARNESS_DIR}/status.json`（per `mstar-plan-artifacts` §1.5：root `metadata` + plan `spec_integration_branch`）
- Update `{ITERATION_DIR}/README.md` index（**一行 = 一次迭代**；per `mstar-iteration` § 1.4）
- Create package dirs as needed: `{ITERATION_DIR}/<iteration-id>/{guides,specs}/` + optional package `README.md`

## 5. Review & Edit Chain（HARD GATE — do not commit before this）

**STOP**: Do not run §6 Integration Branch until **all** rows below are true.

**顺序（HARD）**：`product-manager` → `architect` → `writing-specialist` → PM lock。后一角色基于前一角色已落盘的修订继续编辑；**禁止**三角色并行 invoke。OpenCode：正文用 plain role id — **`mstar-host/references/opencode.md`** § Role-mention hygiene。

Each role below **reviews and directly edits** the documents. Do not just flag issues — apply the fixes yourself. PM only steps in for the final lock.

| # | Role | Required action | Gate |
|---|------|-----------------|------|
| 5.1 | **product-manager** | invoke: **edit** compass, plans, **`{SPECS_DIR}/`**, **`{ITERATION_DIR}/<iteration-id>/`**（`guides/`、`specs/` 按需）— **禁止** `{KNOWLEDGE_DIR}/` 新增 | 完成后方可 5.2 |
| 5.2 | **architect** | invoke: **edit** compass, plans, **`{SPECS_DIR}/`**, package `specs/`（含 5.1 后版本）— **禁止** `{KNOWLEDGE_DIR}/` 新增 | 5.1 返回后；完成后方可 5.3 |
| 5.3 | **writing-specialist** | invoke: **edit** compass / plans / specs / iteration 文档; **specs corpus hygiene**（全库 `{SPECS_DIR}/` + 既有 `{KNOWLEDGE_DIR}/` 卫生与错放纠正，**不**新增 knowledge）— `mstar-iteration/references/iteration-artifact-boundaries.md` + `iteration-corpus-hygiene.md` | 5.2 返回后 |
| 5.4 | **project-manager** | Merge subagent edits; resolve conflicts; **lock** compass (`status: locked`); confirm Prepare gates | 5.3 返回后 |

**Evidence of done** = edited compass / plans / **specs** / iteration docs on disk + specs corpus hygiene（及既有 knowledge 归档/错放纠正，如有）+ compass `status: locked`. **No** new `{KNOWLEDGE_DIR}/` from this chain — knowledge → **`mstar-compound`** @ iteration-close. **No** separate iteration review reports under `reports/`.

**Tool rule (hosts with invoke)** — per **`mstar-dispatch-gates`** · specialist review-and-edit dispatch（**顺序链**，非 parallel batch）：

1. 为当前角色写好 Assignment（含须直接编辑的文件路径；5.2/5.3 注明基于上一角色已落盘修订）。
2. **派发 1 次 invoke** → 等待 Completion Report / 磁盘修订完成。
3. 按序重复下一角色：**5.1 → 5.2 → 5.3**（每步一条派发消息、一次 invoke）。
4. 本条链 **禁止** PM 线程代做专业编辑；**禁止** 同条消息并行三角色；**禁止** 未等 5.1 返回就发 5.2/5.3。
5. 5.3 返回后，PM 线程再做 5.4 merge + lock。

- Exception: user explicitly waives subagent dispatch ("PM-only review").

**Prepare gate (per plan in compass)**:
- [ ] specify / clarify / plan = done on each plan file
- [ ] `primary_spec` path exists (if declared)
- [ ] `blocked_by` / sequential deps documented

Only after 5.4 → proceed to §6.

### iteration-start pre-commit checklist

PM must print this block before §6; all `[ ]` must be `[x]`:

- [ ] direction lock decisions recorded in compass（Plan 路径：Feedback log + 可选 Deferred grill log；非 Plan：grill-me）
- [ ] Draft compass + plans + `status.json` registered
- [ ] product-manager invoke completed — compass / plans / specs / **`<iteration-id>/` package**（按需）；**未**向 `{KNOWLEDGE_DIR}/` 新增
- [ ] architect invoke completed — compass / **specs** edited；**未**向 `{KNOWLEDGE_DIR}/` 新增
- [ ] writing-specialist invoke completed — specs + iteration docs edited；**specs corpus hygiene** done（全库 `{SPECS_DIR}/`；既有 knowledge 仅卫生/归档；错放已迁回 `iterations/` 或 archive）
- [ ] PM final lock: compass `status: locked`; Prepare gates pass (blocked plans documented)
- [ ] Branch policy locked: `iteration_base_branch`, `spec_integration_branch`, and `target_branch` recorded in compass / `status.json`
- [ ] **THEN**: git commit + push `iteration/<iteration-id>`

## 6. Integration Branch

**Precondition**: §5 complete — compass `status: locked`; specialist Tasks returned; Prepare gates confirmed.

- Create `spec_integration_branch` (e.g. `iteration/<iteration-id>`) **from** the locked `iteration_base_branch`:

```bash
git fetch origin   # if needed
git checkout -b <spec_integration_branch> <iteration_base_branch>
# or: git checkout <spec_integration_branch>  if it already exists
```

- Register `iteration_base_branch`, `spec_integration_branch`, and `target_branch` in compass frontmatter **and** `{HARNESS_DIR}/status.json` root `metadata`
- Commit all documents to the integration branch and push to remote

**STOP** if `iteration_base_branch` or `target_branch` is missing. Ask the user or derive only from an already documented project/iteration policy; never silently substitute `main`.
