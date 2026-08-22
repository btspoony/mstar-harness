---
name: iteration-start
description: "Start a new harness iteration — optional direction hint, research, grill-me, compass/plans, Review & Edit chain (long-lived {SPECS_DIR}/ + {ITERATION_DIR}/<id>/ package; compound promotes package at close only), PM lock, integration branch; then auto-continue Phase 2→5 (execute → close → PR → merge-ready) unless `pause` arg given."
agent: project-manager
input: "[direction] [pause]"
---

# Start Iteration

Start a new Morning Star harness iteration. **Phase 1 is not complete until the Review & Edit chain runs via dispatched roles and PM lock — not when compass files are first written.** By default, after Phase 1 lock + integration branch, **auto-continue into Phase 2→5** (execute → close → PR → merge-ready); pass **`pause`** to stop after Phase 1 and resume later with `/iteration-drive`.

## Args

```text
/iteration-start [direction] [pause]
```

| Arg | Meaning | Default |
|-----|---------|---------|
| `direction` | Iteration direction hint — constrains §2 candidates and seeds §3 grill-me; **not** a lock (start stays interactive) | Research → grill-me converges with user |
| `pause` | Stop after Phase 1 (lock + integration branch); run `/iteration-drive` later to resume | **Auto-continue** into Phase 2→5 |

**Parse**: if any token is exactly `pause` (case-insensitive), treat as the `pause` flag; the remaining tokens (joined) are the `direction` hint. `/iteration-start pause` = pause with empty direction.

## PM invariants（本命令全程有效 — 读完再动手）

你是 **`project-manager` 编排者**，不是三专业角色的合并替身。

| 禁止（PM 线程） | 必须（宿主有 Task 时） |
|-----------------|------------------------|
| 自己 Edit compass/plans/specs 冒充 product-manager / architect / writing-specialist 的审查编辑 | §5.1 → §5.2 → §5.3 **顺序**各 **1 次 invoke**；上一角色返回后再派发下一角色 |
| 只写 `## Assignment` 或 checklist 就声称 review chain 完成 | **几条角色 ⇒ 几条 invoke**；零 invoke = `dispatch incomplete`（`mstar-dispatch-gates`） |
| §5 完成前 commit / 创建 integration 分支 | 5.4 PM lock 在 subagent 返回且磁盘产物已修订之后（`mstar-iteration` §1.6） |

派发细则 → **`mstar-dispatch-gates`**（specialist review-and-edit dispatch）+ **`mstar-host`**（宿主 invoke 能力）。**不得**在 PM 线程加载其他 role reference 代劳。

**Phase 1 完成定义**：compass `status: locked` + 三角色 invoke 已返回 + pre-commit checklist 全 `[x]` — 不是初稿落盘。**Command Done**（§7 auto-continue）= Phase 5 §5.5 exit checklist 全 `[x]`（同 `iteration-drive`）；`pause` 时 = Phase 1 完成。

Detailed workflow → **`mstar-iteration` § Phase 1**；per-plan Prepare gates → **`mstar-phase-gates`**（specify → clarify → plan）。

**Phase 2–5 auto-continue（§7）invariants** → **`iteration-drive`**「PM invariants」表（不写产品代码 / 不 inline 大包 / 每 Assignment 1 invoke / Phase 3→4→5 顺序 / Phase 5 dispatch 改代码）。

## Path split（HARD — 路由）

| 宿主上下文 | 走哪条 |
|------------|--------|
| **Cursor Plan mode**（CreatePlan / Plan 会话活跃） | §0 Boot → **§P** — **先**空白 CreatePlan，再 **feedback-driven** 自主改同一份 plan；grill-me **仅**在用户明确结束反馈后、仍有阻塞疑问时；**Build 前不执行** Review 链 / commit / integration 分支 |
| **其它**（Agent、OpenCode、非 Plan） | §0 Boot → §1–§6（Research → Explore → grill-me → Write → Review → branch） |

**Both paths converge at §6**（integration branch）。Default → §7 auto-continue Phase 2→5；`pause` → command ends at §6。

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

Execute **`mstar-host/references/cursor-plan-mode-bridge.md`** § **"mstar-iteration Phase 1 in Plan mode"**（Detect / 语义 / Single CreatePlan URI（HARD）/ Research → Early CreatePlan → Feedback loop → Feedback-close deferred grill → Pre-Build / Build 全流程 SSOT）。

Command-unique 补充（bridge 未枚举）：

- **空白脚手架字段**：Direction / Scope / Acceptance Criteria / Non-Goals / Delivery Branch Policy（`iteration_base_branch` / `spec_integration_branch` / `target_branch`）/ Plans / Feedback log / Deferred grill log
- **Build 才勾的 todos**（顺序）：`harness-init` → `finalize-compass-plans`（**同一份** CreatePlan 落成 compass + plans + `status.json` 登记 + 索引）→ review-edit-product-manager → review-edit-architect → review-edit-writing-specialist → `pm-lock` → `integration-branch`

## 非 Plan 路径从这里继续 ↓

## 1. Research

Survey structured harness dirs（`{HARNESS_DIR}/status.json`、`{ITERATION_DIR}/`、`{KNOWLEDGE_DIR}/`、`{SPECS_DIR}/`）+ glob for planning artifacts（`**/roadmap*.md`、`**/deferred*.md`、`**/features*.md`、`**/backlog*.md`、`**/TODO*.md`、`**/*.plan.md`）；read matches with iteration-level / deferred-scope information；read `STRATEGY.md`（if exists）and `{KNOWLEDGE_DIR}/README.md`（if exists — Active index rows are Research candidates）。Prioritize deferred / incomplete items from prior iterations。

## 2. Explore Directions

Scope **2–4** candidates targeting **product completeness**（default to deferred items from previous iterations；allow substantive refactoring where it accelerates product maturity）。**If `direction` arg given** — narrow candidates to that hint (still scope 2–4 unless the hint is explicitly singular); record the hint in grill-me context。**非 Plan 路径**（Plan mode 已由 §P 处理）。

## 3. Lock Direction — bundled `grill-me`

> **非 Plan 路径**。Cursor Plan mode 用 §P.3 feedback loop + §P.3.5 deferred grill（主路径不是 grill）。

**Direction lock mode: `interactive`**（`mstar-iteration` §1.2 默认；本命令不使用 `autonomous`）。

This command bundles a **non-`mstar-*`** skill at `skills/grill-me/SKILL.md`. **Only this command step**（及 §P.3.5 deferred grill）references it — **do not** load it from `mstar-harness-core` or other `mstar-*` skills.

**Before this step:** Read `skills/grill-me/SKILL.md`. Run **grill-me** to stress-test candidate directions with the user: walk through trade-offs, converge on a **single iteration direction** with shared understanding, document locked direction + success criteria + non-goals。**If `direction` arg given** — seed grill-me with it as the recommended direction (still interactive: user may correct/refine; the hint does **not** skip grill-me)。Confirm delivery branch policy（`iteration_base_branch`、`target_branch`）per **`mstar-iteration` §1.2** — **Do not default to `main` / `master` just because those names exist.**

## 4. Write Compass & Plans

Produce harness artifacts per **`mstar-iteration` §1.3–§1.5**（template: `mstar-iteration/references/iteration-compass-template.md`）：compass（frontmatter **must** include `iteration_base_branch`、`target_branch`、`status: active`）、plans、`status.json` 登记（`mstar-iteration` §1.5）、`{ITERATION_DIR}/README.md` 索引（一行 = 一次迭代）、package dirs（`{ITERATION_DIR}/<iteration-id>/{guides,specs}/`）。**非 Plan 路径**。

## 5. Review & Edit Chain（HARD GATE — do not commit before this）

Execute **`mstar-iteration` §1.6**（SSOT）：顺序 `product-manager` → `architect` → `writing-specialist` → PM lock（**禁止**并行三角色；OpenCode plain role id — `mstar-host/references/opencode.md` § Role-mention hygiene）；**禁止** `{KNOWLEDGE_DIR}/` 新增；writing-specialist specs corpus hygiene（`iteration-artifact-boundaries.md` + `iteration-corpus-hygiene.md`）。Tool rule → **`mstar-dispatch-gates`** specialist review-and-edit（每角色 1 invoke，等磁盘修订返回）。Exception: user explicitly waives subagent dispatch ("PM-only review").

**Assignment preflight**（`mstar-harness` bin 未安装时静默跳过）: 在每次角色 invoke 前，若本机装有 CLI，校验最新落盘的 Assignment（临时写盘或既有 brief）。模式由迭代 compass frontmatter 的 `enforcement` 键决定（Slice 5）：

- **默认（compass 无 `enforcement: hard`）— 可选 warn-only**：exit 1 仅提示，不阻断派发（Slice 3 行为不变）：

```bash
command -v mstar-harness >/dev/null 2>&1 && mstar-harness dispatch validate "<latest-assignment-file>"
```

- **`enforcement: hard`（迭代 compass frontmatter 声明）— fail-fast**：校验失败即 `exit 1` 阻断派发（bin 缺失仍静默跳过）：

```bash
if command -v mstar-harness >/dev/null 2>&1; then mstar-harness dispatch validate "<latest-assignment-file>" || exit 1; fi
```

> 路径必须加引号且替换为具体文件（如最新 `{SDD_DIR}/task-N-brief.md`，勿留尖括号）——agent 代入的路径不得进入 shell 无引号展开。

**Prepare gate (per plan in compass)**:

- [ ] specify / clarify / plan = done on each plan file
- [ ] `primary_spec` path exists (if declared)
- [ ] `blocked_by` / sequential deps documented

### iteration-start pre-commit checklist

PM must print this block before §6; all `[ ]` must be `[x]`:

- [ ] direction lock decisions recorded in compass（Plan 路径：Feedback log + 可选 Deferred grill log；非 Plan：grill-me）
- [ ] Draft compass + plans + `status.json` registered
- [ ] product-manager / architect / writing-specialist invokes completed — 编辑 compass / plans / specs / **`<iteration-id>/` package**；**未**向 `{KNOWLEDGE_DIR}/` 新增；writing-specialist specs corpus hygiene done
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

---

## 7. Phase 2–5: Execute → close → PR → merge-ready（auto-continue）

**`pause` arg → command ends here.** Phase 1 locked + integration branch pushed；run `/iteration-drive` later to resume。

**Default（no `pause`）→ auto-continue** into Phase 2→5。

### Phase 2 boot（load before delegating）

1. `mstar-iteration` → **§ Phase 2–5**（§2 Autonomous Execute、§3 close、§4 PR、§5 merge-ready）
2. **`mstar-sdd`** — before first implement dispatch（per-task loop SSOT）
3. `mstar-review-qc` — before first QC dispatch
4. `mstar-compound` — before Phase 3 §3.2
5. `mstar-branch-worktree` + **`mstar-iteration/references/phase-2-worktree-lease.md`** — control worktree + lease（§2.0 #5 未 waive）

### Delegate to `iteration-drive` Phase 2→5

Execute **`iteration-drive`** Phase 2–5 exactly：Phase 2 → **`mstar-iteration` §2**（§2.0 五道闸 → §2.6 push 纪律；SDD per-task；QC tri N=3 + QA）、Phase 3 → **§3** + `references/phase-3-iteration-close.md`、Phase 4/5 → **§4–§5** + `references/phase-4-5-pr-delivery.md`、Phase 5 helper discovery → `mstar-iteration/references/phase5-helper-discovery.md`。

**Continuous execution（HARD）**：自 Phase 2 进入至 Phase 5 §5.5 exit，PM **连续编排**（**`mstar-iteration` §2.6**），进度汇报后下一条必须是 dispatch 或下一 phase 步骤，不向用户例行 yes/no check-in。合法 STOP 仅限：branch metadata 缺失、真冲突 / secrets / 不可逆范围缺口、Phase 5 多轮仍无法 merge-ready、用户本轮显式打断。

**Assignment preflight**：同 §5（每次 implement/QC/QA 派发前校验；`mstar-harness` bin 未安装时静默跳过）。

**Done = Phase 5 §5.5 exit checklist 全 `[x]`**（同 `iteration-drive`）。

**Then** report: iteration id, direction lock summary, plans completed, compound summary, PR link, merge-ready evidence（CI snapshot + review resolution + Greptile if applicable）。

PR merge itself may remain manual unless user authorized auto-merge.
