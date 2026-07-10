---
name: iteration-loop
description: Autonomous full iteration loop for cloud agents — Phase 1 (code-first auto direction lock + compass/plans + Review & Edit chain) through Phase 2–5 (execute → close → PR → merge-ready). Optional args: direction, scale (S|M|L, default M). Not Done until Phase 5 exit checklist passes. Minimal human intervention; no grill-me.
agent: project-manager
---

# Iteration Loop

Run a **full** Morning Star iteration with minimal human intervention. **Done = Phase 5 §5.5 exit checklist 全 `[x]`** — not Phase 1 lock, not Phase 3 close, not Phase 4 PR open.

**vs other commands:**

| Command | Scope |
|---------|--------|
| `iteration-start` | Phase 1 only; **grill-me** with user |
| `iteration-drive` | Phase 2→5 on an already locked iteration |
| **`iteration-loop`** | Phase 1→5 end-to-end; **autonomous** direction lock |

Phase gate SSOT → **`mstar-iteration`** §1–§5. This command is a **consumer**; it does not redefine skill semantics.

## Args（最多 2 个）

```
/iteration-loop [direction] [scale]
```

| Arg | Meaning | Default |
|-----|---------|---------|
| `direction` | Iteration direction / feedback constraint (free text) | Code-first research → **auto-lock recommended** |
| `scale` | `S` \| `M` \| `L` | **`M`** |

**Scale budget**（写入 compass；约束 **业务** plan 数量）→ **`mstar-iteration`** §1.2 + `references/autonomous-direction-lock.md`：

- **S** → 1 business plan
- **M** → 2–3 business plans
- **L** → 3–4 business plans（默认上限 4，除非 `direction` 显式要求更大）

**HARD**：budget **只计**实际业务交付 plan；**不计** harness 流程（Review 链、QC/QA、compound、close、PR、merge-ready、compass/`status.json` 维护等）。流程门禁仍须执行，但不占 S/M/L 名额，也不得写成独立 process plan 来“凑数/占坑”。

Parse: if the last token is exactly `S`/`M`/`L` (case-insensitive), treat it as `scale`; remaining text is `direction`. If only one token and it is `S`/`M`/`L`, that is `scale` with empty `direction`.

## Phase state machine（禁止跳步）

```
Phase 1: Autonomous start  →  Phase 2: Autonomous Execute  →  Phase 3: close  →  Phase 4: PR  →  Phase 5: merge-ready
```

| 当前状态 | 允许 | 禁止 |
|----------|------|------|
| Phase 1 未 lock | Research → auto-lock → Review chain → integration | 进入 Phase 2 implement；grill-me |
| compass `locked` + plans registered | **立刻** Phase 2 | 问用户「是否开始 execute」 |
| 存在非 `Done` plan | Phase 2 dispatch | 进入 Phase 3 或开 PR |
| **全部** plan `Done` | **立刻** Phase 3 | 宣称 loop 完成、开 PR |
| Phase 3 exit 全 `[x]` + compass `completed` | Phase 4 | 跳过 compound |
| PR 已创建 | Phase 5 loop | 汇报结束 |
| Phase 5 exit 全 `[x]` | **iteration-loop Done** | — |

## Continuous execution（HARD — Phase 1 lock 后至 Phase 5 exit）

自 Phase 1 §6 integration 完成起，至 Phase 5 §5.5 全 `[x]` 前，PM **连续编排**。

| 禁止 | 必须 |
|------|------|
| 方向 / plan / phase 边界例行 yes/no（「是否同意该方向」「要不要继续」「是否开 PR」） | 进度摘要后**下一条** = dispatch 或下一 phase 步骤 |
| 用 Phase 汇报收束 turn 后等待用户 | Phase 1 lock → **立刻** Phase 2；plan Done → 下一 plan 或 Phase 3 |
| 跨 plan 并行 implement | Per-plan **串行** |

**合法 STOP（仅此升级用户）**：

- Branch metadata 按 **`mstar-iteration`** autonomous resolve 顺序仍无法确定（**禁止**静默默认 `main`/`master`）
- 代码/roadmap **无可信候选**且无 `direction` 参数
- **`Blocked`**：真冲突、secrets、不可逆范围缺口、Phase 5 多轮仍无法 merge-ready
- 用户本轮显式打断

**Turn 收束纪律**：最后一条内容必须是 **in-flight 动作**（invoke 已发出或下一 Assignment），**不得**以确认问句结尾。

## PM invariants

### Phase 1（Review & Edit）

| 禁止（PM 线程） | 必须 |
|-----------------|------|
| 自己 Edit 冒充 product-manager / architect / writing-specialist | §5.1 → §5.2 → §5.3 **顺序**各 **1 次 invoke** |
| 只写 Assignment 就声称 review 完成 | 几条角色 ⇒ 几条 invoke |
| §5 完成前 commit / 创建 integration | 5.4 PM lock 在 subagent 返回之后 |
| 加载 `grill-me` | **Autonomous** direction lock（`mstar-iteration` §1.2） |

### Phase 2–5

| 禁止（PM 线程） | 必须 |
|-----------------|------|
| Write/Edit/Shell 产品代码、写测试、跑 QC | 每条 implement/QC/QA Assignment ⇒ **1 次 `Task`** |
| 多 task plan inline 大包派发 | **SDD** per-task 循环 |
| 最后 plan `Done` 后直接开 PR | **Phase 3 → 4 → 5** |
| Phase 5 自己改产品代码 | dispatch `fullstack-dev` / `ops-engineer` |

派发细则 → **`mstar-dispatch-gates`** + **`mstar-host`**。

**Session todos**：

| Todo id | 何时追加 | 何时可勾掉 |
|---------|----------|------------|
| `phase-1-autonomous-start` | Boot | compass `locked` + integration committed |
| plan-wave todos | 进入 Phase 2 | 各 plan `Done` |
| `phase-3-iteration-close` | 仅剩 1 个非 `Done` plan | Phase 3 §3.5 exit 全 `[x]` |
| `phase-4-create-pr` | Phase 3 完成后 | PR 已创建 |
| `phase-5-pr-merge-ready` | Phase 4 完成后 | Phase 5 §5.5 exit 全 `[x]` |

## Boot

1. `mstar-harness-core`
2. `mstar-roles` → `references/project-manager.md`
3. `mstar-iteration` → **§ Phase 1**（含 **autonomous** direction lock / scale budget / branch resolve）+ **§ Phase 2–5**
4. `mstar-dispatch-gates`
5. `mstar-phase-gates` → Prepare
6. `mstar-plan-conventions`, `mstar-plan-artifacts`
7. `mstar-host` → active host reference
8. `mstar-compound` — before Phase 3 §3.2
9. **`mstar-sdd`** — before first implement dispatch in Phase 2
10. `mstar-review-qc` — before first QC dispatch in Phase 2
11. `mstar-branch-worktree` — when Git/write or QC checkout

**Do not** Read `skills/grill-me/SKILL.md` for this command.

---

## Phase 1: Autonomous start

### 1. Research

Survey structured and unstructured sources（code-first — **explore before guessing**）:

**Structured:**
- `{HARNESS_DIR}/status.json` → active plans, deferred, residuals
- `{ITERATION_DIR}/` → prior compasses, roadmap batches
- `{KNOWLEDGE_DIR}/` → design / architecture notes
- `{SPECS_DIR}/` → specs, gaps

**Unstructured — Glob then Read:**
- `**/roadmap*.md`, `**/ROADMAP*.md`, `**/*-roadmap.md`
- `**/deferred*.md`, `**/DEFERRED*.md`
- `**/features*.md`, `**/FEATURES*.md`
- `**/backlog*.md`, `**/TODO*.md`, `**/todo*.md`, `**/*.plan.md`

Prioritize deferred / incomplete items from prior iterations. Read `STRATEGY.md` if present.

### 2. Explore Directions

Scope **2–4** candidates targeting product completeness; each with goals + trade-offs. Prefer deferred / roadmap `next` items.

### 3. Lock Direction — autonomous（NOT grill-me）

**Direction lock mode: `autonomous`**（显式 opt-in → **`mstar-iteration` §1.2**）。

Execute **`mstar-iteration` §1.2 autonomous** direction lock（detail: `references/autonomous-direction-lock.md`）：

1. If `direction` arg present → constrain candidates to that intent; pick the best evidence-backed fit.
2. If absent → rank candidates（deferred/roadmap next > STRATEGY alignment > product completeness > risk）and **lock the recommended** direction.
3. Write to compass: locked direction, rationale, success criteria, non-goals, scale budget.
4. Resolve delivery branch policy via **autonomous branch resolve**（`references/autonomous-direction-lock.md`）— never silent `main`/`master`.

**Do not** ask the user to confirm the chosen direction. Record rationale on disk instead.

**STOP** if no credible candidate and no `direction` arg, or branch policy unresolved after resolve order.

### 4. Write Compass & Plans

Per **`mstar-iteration` §1.3–§1.5**（template: `iteration-compass-template.md`）:

- Compass with `iteration_base_branch`, `target_branch`, `status: active`, scale budget noted in Scope / Plans
- **Business** plan count within scale budget（exclude harness process from the count）
- Register plans in `status.json`; update `{ITERATION_DIR}/README.md`

### 5. Review & Edit Chain（HARD GATE）

**顺序（HARD）**：`product-manager` → `architect` → `writing-specialist` → PM lock。**禁止**并行三角色。OpenCode：plain role id — **`mstar-host/references/opencode.md`** § Role-mention hygiene.

| # | Role | Required action |
|---|------|-----------------|
| 5.1 | **product-manager** | invoke: **edit** compass, plans, `{SPECS_DIR}/`, `{ITERATION_DIR}/<iteration-id>/` — **禁止** `{KNOWLEDGE_DIR}/` 新增 |
| 5.2 | **architect** | invoke: **edit** compass, plans, specs / workspace（含 5.1 后版本）— **禁止** knowledge 新增 |
| 5.3 | **writing-specialist** | invoke: edit docs + **specs corpus hygiene** — `iteration-artifact-boundaries.md` + `iteration-corpus-hygiene.md` |
| 5.4 | **project-manager** | Merge; **lock** compass (`status: locked`); confirm Prepare gates |

Tool rule → **`mstar-dispatch-gates`** specialist review-and-edit（顺序链）。Exception: user waives ("PM-only review").

### iteration-loop Phase 1 pre-commit checklist

Print before §6; all must be `[x]`:

- [ ] Autonomous direction lock rationale recorded in compass（not grill-me）
- [ ] Scale budget applied; **business** plan count within S/M/L（harness process not counted）
- [ ] Draft compass + plans + `status.json` registered
- [ ] product-manager invoke completed；**未**向 `{KNOWLEDGE_DIR}/` 新增
- [ ] architect invoke completed；**未**向 `{KNOWLEDGE_DIR}/` 新增
- [ ] writing-specialist invoke completed；specs corpus hygiene done
- [ ] PM final lock: compass `status: locked`; Prepare gates pass
- [ ] Branch policy locked: `iteration_base_branch`, `spec_integration_branch`, `target_branch` in compass / `status.json`
- [ ] **THEN**: git commit + push `iteration/<iteration-id>`

### 6. Integration Branch

**Precondition**: §5 complete.

```bash
git fetch origin   # if needed
git checkout -b <spec_integration_branch> <iteration_base_branch>
# or: git checkout <spec_integration_branch>  if it already exists
```

Register branch fields in compass + `status.json`. Commit docs; push.

**STOP** if `iteration_base_branch` or `target_branch` still missing after autonomous resolve.

**Immediately** print `## Phase 2: Autonomous Execute` → continue below（勾掉 `phase-1-autonomous-start`）。

---

## Phase 2: Autonomous Execute

**Continuous execution applies.** Branch policy first（`mstar-iteration` §2.3）.

Execute **`mstar-iteration` § Phase 2** exactly. Summary:

1. Precondition gate §2.0（four checks）
2. Session todos §2.1
3. Read backlog §2.2
4. Integration branch §2.3
5. Per-plan loop §2.4 — **SDD** default; serial implementer → task reviewer; QC **full tri-review** N=3; QA gate; merge to integration; next plan
6. All plans `Done` → print `## Phase 3: iteration-close` → **`mstar-iteration` §3**（不得开 PR）

派发纪律 → **`mstar-dispatch-gates`** + **`mstar-iteration` §2.5**。

## Phase 3: iteration-close

当 every plan 为 `Done`：

1. STOP per-plan loop
2. Print `## Phase 3: iteration-close`
3. Execute **`mstar-iteration` §3.0→§3.5**（compound + workspace promotion）
4. Exit checklist `[x]` + compass `completed` → print `## Phase 4: Create PR`

```bash
git add {ITERATION_DIR}/ {KNOWLEDGE_DIR}/ CONCEPTS.md
git commit -m "chore(iteration): close <iteration-id> — compound round, roadmap update"
git push origin <spec_integration_branch>
```

## Phase 4: Create PR

Execute **`mstar-iteration` § Phase 4**：

1. Print `## Phase 4: Create PR`
2. Resolve `metadata.target_branch`（compass fallback）；missing → STOP；never default `main`
3. Create PR: `spec_integration_branch` → `target_branch`
4. Record URL/number；勾掉 `phase-4-create-pr`
5. **Immediately** print `## Phase 5: PR merge-ready` → Phase 5

## Phase 5: PR merge-ready

Execute **`mstar-iteration` § Phase 5**。**§5.5 exit 全 `[x]` = iteration-loop Done.**

### 5.0 Discover optional helper skills（non-`mstar-*`）

| Skill | Search paths（示例） |
|-------|----------------------|
| `greploop` | `skills/greploop/SKILL.md`；`~/.cursor/skills-cursor/greploop/SKILL.md`；`~/.agents/skills/greploop/SKILL.md` |
| `babysit` | `skills/babysit/SKILL.md`；`~/.cursor/skills-cursor/babysit/SKILL.md`；`~/.agents/skills/babysit/SKILL.md` |

| Priority | Condition | Primary done signal |
|----------|-----------|---------------------|
| 1 | `greploop` found | Greptile **5/5** |
| 2 | else `babysit` | Required CI green + reviews resolved |
| 3 | else neither | Same as babysit（本 command fallback） |

Both present: greploop to 5/5, then babysit（串行）.

### 5.1–5.4 Loop

Same hygiene as drive consumer pattern: status → conflicts → reviews → CI → mode pass → comment+resolve on addressed threads → repeat until §5.5.

Fixes push to `spec_integration_branch` only. PM does not rewrite product code in-thread.

### 5.5 Phase 5 exit checklist（iteration-loop Done）

与 **`mstar-iteration` §5.2** 对齐：

- [ ] PR mergeable
- [ ] All **required** CI checks green on latest head
- [ ] All review threads **resolved**（或用户书面 waive）
- [ ] Greptile **5/5**（若 greploop mode / repo 可见分数）
- [ ] Review comment + resolve 已覆盖本轮 addressed feedback
- [ ] Host todo `phase-5-pr-merge-ready` 可勾选

**Then** report: iteration id, locked direction + scale, plans completed, compound summary, PR link, merge-ready evidence.

PR merge itself may remain manual unless user authorized auto-merge.
