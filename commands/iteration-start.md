---
name: iteration-start
description: Start a new harness iteration — research backlog, lock direction with grill-me, produce compass/plans, run mandatory Review & Edit chain via sequential Task dispatch (product-manager → architect → writing-specialist, each review-and-edit, then PM final lock), then create the integration branch from an explicit base. Not Done until review chain completes, compass is locked, and base/target branches are recorded.
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

Detailed workflow → **`mstar-iteration` § Phase 1: iteration-start**（含 §1.6 Review & Edit chain）；per-plan Prepare gates → **`mstar-phase-gates`**（specify → clarify → plan）。

## 0. Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `mstar-iteration` → **§ Phase 1: iteration-start**（迭代范围、compass 模板、§1.6 Review & Edit chain、状态初始化）
4. `mstar-dispatch-gates`
5. `mstar-phase-gates` → Prepare（specify → clarify → plan）
6. `mstar-plan-conventions`, `mstar-plan-artifacts`
7. `mstar-host` → active host reference（invoke 能力）

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

Explore candidate directions targeting **product completeness**:

- Default to completing deferred items from previous iterations
- Allow substantive refactoring where it accelerates product maturity
- Scope 2–4 candidates, each with clear product-completeness goals and trade-offs

## 3. Lock Direction — bundled `grill-me`

This command bundles a **non-`mstar-*`** skill at `skills/grill-me/SKILL.md`. **Only this command step** references it — **do not** load it from `mstar-harness-core` or other `mstar-*` skills.

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

Produce harness artifacts per **`mstar-iteration` § 1.3**（template: `mstar-iteration/references/iteration-compass-template.md`）：

- `{ITERATION_DIR}/<iteration-id>-delivery-compass.md` — YAML frontmatter **must** include `iteration_base_branch`, `target_branch`, `status: active`
- `{PLAN_DIR}/<plan-id>-<name>.md` for each plan in this iteration
- Register all plans in `{HARNESS_DIR}/status.json`（per `mstar-plan-artifacts` §1.5：root `metadata` + plan `spec_integration_branch`）
- Update `{ITERATION_DIR}/README.md` index（per `mstar-iteration` § 1.4）

## 5. Review & Edit Chain（HARD GATE — do not commit before this）

**STOP**: Do not run §6 Integration Branch until **all** rows below are true.

**顺序（HARD）**：`product-manager` → `architect` → `writing-specialist` → PM lock。后一角色基于前一角色已落盘的修订继续编辑；**禁止**三角色并行 invoke。OpenCode：正文用 plain role id — **`mstar-host/references/opencode.md`** § Role-mention hygiene。

Each role below **reviews and directly edits** the documents. Do not just flag issues — apply the fixes yourself. PM only steps in for the final lock.

| # | Role | Required action | Gate |
|---|------|-----------------|------|
| 5.1 | **product-manager** | invoke: **edit** compass, plans, `{SPECS_DIR}/`; scope, UX, priorities | 完成后方可 5.2 |
| 5.2 | **architect** | invoke: **edit** compass, plans, specs（含 5.1 修订后版本）; contracts, SQL, module boundaries | 5.1 返回后；完成后方可 5.3 |
| 5.3 | **writing-specialist** | invoke: **edit** all iteration docs（含 5.1–5.2 修订后版本）; terminology, structure, clarity | 5.2 返回后 |
| 5.4 | **project-manager** | Merge subagent edits; resolve conflicts; **lock** compass (`status: locked`); confirm Prepare gates | 5.3 返回后 |

**Evidence of done** = edited compass / plans / specs on disk + compass `status: locked`. **No** separate iteration review reports under `reports/` — unlike per-plan QC, there is no downstream audit chain to preserve.

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

- [ ] grill-me decisions recorded in compass
- [ ] Draft compass + plans + `status.json` registered
- [ ] product-manager invoke completed — compass / plans / specs edited
- [ ] architect invoke completed — compass / specs edited
- [ ] writing-specialist invoke completed — iteration docs edited
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
