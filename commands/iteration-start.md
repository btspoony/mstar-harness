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

## PM invariants（Phase 1 review-chain — 本命令全程有效）

你是 **`project-manager` 编排者**，不是三专业角色的合并替身。

| 禁止（PM 线程） | 必须（宿主有 Task 时） |
|-----------------|------------------------|
| 自己 Edit compass/plans/specs 冒充 product-manager / architect / writing-specialist 的审查编辑 | §5.1 → §5.2 → §5.3 **顺序**各 **1 次 invoke**；上一角色返回后再派发下一角色 |
| 只写 `## Assignment` 或 checklist 就声称 review chain 完成 | **几条角色 ⇒ 几条 invoke**；零 invoke = `dispatch incomplete`（`mstar-dispatch-gates`） |
| §5 完成前 commit / 创建 integration 分支 | 5.4 PM lock 在 subagent 返回且磁盘产物已修订之后（`mstar-iteration` §1.6） |

派发细则 → **`mstar-dispatch-gates`**（specialist review-and-edit dispatch）+ **`mstar-host`**（宿主 invoke 能力）。**不得**在 PM 线程加载其他 role reference 代劳。

**Phase 1 完成定义**：compass `status: locked` + 三角色 invoke 已返回 + pre-commit checklist 全 `[x]` — 不是初稿落盘。**Command Done**（§7 auto-continue）= Phase 5 §5.5 exit checklist 全 `[x]`（同 `iteration-drive`）；`pause` 时 = Phase 1 完成。

**Phase 2–5 共享 invariants / preflight / todos / STOP** → **`mstar-iteration/references/command-shared-invariants.md`**（不在本命令重复）。

## Path split（HARD — 路由）

| 宿主上下文 | 走哪条 |
|------------|--------|
| **Cursor Plan mode**（CreatePlan / Plan 会话活跃） | §0 Boot → **§P** — **先**空白 CreatePlan，再 **feedback-driven** 自主改同一份 plan；grill-me **仅**在用户明确结束反馈后、仍有阻塞疑问时；**Build 前不执行** Review 链 / commit / integration 分支 |
| **其它**（Agent、OpenCode、非 Plan） | §0 Boot → §1–§6（Research → Explore → grill-me → Write → Review → branch） |

**Both paths converge at §6**（integration branch）。Default → §7 auto-continue Phase 2→5；`pause` → command ends at §6。

## 0. Boot

按 **`mstar-iteration`** Load order 加载（`mstar-harness-core` → `mstar-roles` → `references/project-manager.md` → `mstar-iteration` § Phase 1 + `mstar-phase-gates` + `mstar-dispatch-gates` + `mstar-plan-conventions/artifacts` + `mstar-host` → active host reference）。Cursor Plan mode 另读 **`cursor-plan-mode-bridge.md`**（`mstar-iteration` Phase 1 in Plan mode）。完整 load list → **`mstar-roles`**。

**若 Cursor Plan mode 活跃 → 进入 §P；否则继续 §1。**

## P. Cursor Plan mode（Phase 1 scaffold → feedback loop → deferred grill → Build）

Execute **`mstar-host/references/cursor-plan-mode-bridge.md`** § **"mstar-iteration Phase 1 in Plan mode"**（Detect / 语义 / Single CreatePlan URI（HARD）/ Research → Early CreatePlan → Feedback loop → Feedback-close deferred grill → Pre-Build / Build 全流程 SSOT）。

Command-unique 补充（bridge 未枚举）：

- **空白脚手架字段**：Direction / Scope / Acceptance Criteria / Non-Goals / Delivery Branch Policy（`iteration_base_branch` / `spec_integration_branch` / `target_branch`）/ Plans / Feedback log / Deferred grill log
- **Build 才勾的 todos**（顺序）：`harness-init` → `finalize-compass-plans`（同一 CreatePlan 落成 compass + plans + `status.json` 登记 + 索引）→ review-edit-product-manager → review-edit-architect → review-edit-writing-specialist → `pm-lock` → `integration-branch`

## 非 Plan 路径从这里继续 ↓

## 1. Research

Survey structured harness dirs（`{HARNESS_DIR}/status.json`、`{ITERATION_DIR}/`、`{KNOWLEDGE_DIR}/`、`{SPECS_DIR}/`）+ glob for planning artifacts（`**/roadmap*.md`、`**/deferred*.md`、`**/features*.md`、`**/backlog*.md`、`**/TODO*.md`、`**/*.plan.md`）；read `STRATEGY.md`（if exists）。Prioritize deferred / incomplete items from prior iterations。

## 2. Explore Directions

Scope **2–4** candidates targeting **product completeness**（default to deferred items from previous iterations；allow substantive refactoring where it accelerates product maturity）。**If `direction` arg given** — narrow candidates to that hint (still scope 2–4 unless explicitly singular)；record the hint in grill-me context。

## 3. Lock Direction — bundled `grill-me`

> **非 Plan 路径**。Cursor Plan mode 用 §P feedback loop + deferred grill（主路径不是 grill）。

**Direction lock mode: `interactive`**（`mstar-iteration` §1.2 默认；本命令不使用 `autonomous`）。This command bundles a **non-`mstar-*`** skill at `skills/grill-me/SKILL.md` — **only this command step** references it.

**Before this step:** Read `skills/grill-me/SKILL.md`. Run **grill-me** to stress-test candidate directions with the user: walk through trade-offs, converge on a **single iteration direction** with shared understanding, document locked direction + success criteria + non-goals。**If `direction` arg given** — seed grill-me with it (still interactive; the hint does **not** skip grill-me)。Confirm delivery branch policy（`iteration_base_branch` / `target_branch`）per **`mstar-iteration` §1.2** — **Do not default to `main`/`master` just because those names exist.**

## 4. Write Compass & Plans

Produce harness artifacts per **`mstar-iteration` §1.3–§1.5**（template: `mstar-iteration/references/iteration-compass-template.md`）：compass（frontmatter **must** include `iteration_base_branch`、`target_branch`、`status: active`）、plans、`status.json` 登记（§1.5）、`{ITERATION_DIR}/README.md` 索引（一行 = 一次迭代）、package dirs（`{ITERATION_DIR}/<iteration-id>/{guides,specs}/`）。

## 5. Review & Edit Chain（HARD GATE — do not commit before this）

Execute **`mstar-iteration` §1.6**（SSOT）：顺序 `product-manager` → `architect` → `writing-specialist` → PM lock（**禁止**并行三 roles；OpenCode plain role id — `mstar-host/references/opencode.md`）；**禁止** `{KNOWLEDGE_DIR}/` 新增；writing-specialist corpus hygiene（`iteration-artifact-boundaries.md` + `iteration-corpus-hygiene.md`）。Tool rule → **`mstar-dispatch-gates`** specialist review-and-edit（每 role 1 invoke，等磁盘修订返回）。Exception: user explicitly waives subagent dispatch ("PM-only review").

**Assignment preflight**：每次 invoke 前按 **`mstar-iteration/references/command-shared-invariants.md`** 执行（warn-only + `enforcement: hard` fail-fast；bin 缺失静默跳过）。

**Prepare gate (per plan in compass)**:

- [ ] specify / clarify / plan = done on each plan file
- [ ] `primary_spec` path exists (if declared)
- [ ] `blocked_by` / sequential deps documented

### iteration-start pre-commit checklist

PM must print this block before §6; all `[ ]` must be `[x]`:

- [ ] direction lock decisions recorded in compass（Plan 路径：Feedback log + deferred grill log；非 Plan：grill-me）
- [ ] Draft compass + plans + `status.json` registered
- [ ] product-manager / architect / writing-specialist invokes completed — 编辑 compass / plans / specs / **`<iteration-id>/` package**；**未**向 `{KNOWLEDGE_DIR}/` 新增
- [ ] PM final lock: compass `status: locked`; Prepare gates pass (blocked plans documented)
- [ ] Branch policy locked: `iteration_base_branch` / `spec_integration_branch` / `target_branch` recorded in compass / `status.json`
- [ ] **THEN**: commit + push `iteration/<iteration-id>`

## 6. Integration Branch

Per **`mstar-iteration` §2.3**：create `spec_integration_branch` from `iteration_base_branch`（`git fetch` → `git checkout -b <spec_integration_branch> <iteration_base_branch>`）；register `iteration_base_branch` / `spec_integration_branch` / `target_branch` in compass frontmatter **and** `status.json` metadata；commit docs；push。**STOP** if `iteration_base_branch` / `target_branch` missing — never default `main`/`master`.

---

## 7. Phase 2–5（auto-continue）

**`pause` arg → command ends here**（Phase 1 locked + integration pushed；run `/iteration-drive` later）。**Default（no `pause`）→ auto-continue**：execute **`iteration-drive`**（Phase 2 → **`mstar-iteration` §2**；Phase 3 → §3 + `references/phase-3-iteration-close.md`；Phase 4/5 → §4–§5 + `references/phase-4-5-pr-delivery.md`；Phase 5 helper discovery → `phase5-helper-discovery.md`）。Shared invariants / preflight / STOP → **`mstar-iteration/references/command-shared-invariants.md`**。

**Done = Phase 5 §5.5 exit checklist 全 `[x]`**（同 `iteration-drive`）。**Then** report: iteration id, direction lock summary, plans completed, compound summary, PR link, merge-ready evidence（CI snapshot + review resolution + Greptile if applicable）。

PR merge itself may remain manual unless user authorized auto-merge.
