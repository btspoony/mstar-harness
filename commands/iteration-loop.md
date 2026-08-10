---
name: iteration-loop
description: "Autonomous full iteration loop for cloud agents — Phase 1 (code-first auto direction lock + compass/plans + Review & Edit chain) through Phase 2–5 (execute → close → PR → merge-ready). Optional args: direction, scale (S|M|L|XL, default M). Not Done until Phase 5 exit checklist passes. Minimal human intervention; no grill-me."
agent: project-manager
---

# Iteration Loop

Run a **full** Morning Star iteration with minimal human intervention. **Done = Phase 5 §5.5 exit checklist 全 `[x]`** — not Phase 1 lock, not Phase 3 close, not Phase 4 PR open.

**vs other commands:**

| Command | Scope |
| `iteration-start` | Phase 1 (**grill-me** with user) → **auto-continue** Phase 2→5（`pause` 止于 Phase 1） |
| `iteration-drive` | Phase 2→5 re-entry / resume on an already locked iteration |
| **`iteration-loop`** | Phase 1→5 end-to-end; **autonomous** direction lock |

Phase gate SSOT → **`mstar-iteration`** §1–§5. This command is a **consumer**; it does not redefine skill semantics.

## Args（最多 2 个）

```text
/iteration-loop [direction] [scale]
```

| Arg | Meaning | Default |
|-----|---------|---------|
| `direction` | Iteration direction / feedback constraint (free text) | Code-first research → **auto-lock recommended** |
| `scale` | `S` \| `M` \| `L` \| `XL` | **`M`** |

**Scale budget**（写入 compass；约束 **业务** plan 数量）→ **`mstar-iteration`** §1.2 + `references/autonomous-direction-lock.md`：

- **S** → 1 business plan
- **M** → 2–3 business plans
- **L** → 3–4 business plans（上限 4）
- **XL** → **>4** business plans（5+；适合大范围 autonomous 迭代）

**HARD**：budget **只计**实际业务交付 plan；**不计** harness 流程（Review 链、QC/QA、compound、close、PR、merge-ready、compass/`status.json` 维护等）。流程门禁仍须执行，但不占 S/M/L/XL 名额，也不得写成独立 process plan 来“凑数/占坑”。

Parse: if the last token is exactly `S`/`M`/`L`/`XL` (case-insensitive), treat it as `scale`; remaining text is `direction`. If only one token and it is `S`/`M`/`L`/`XL`, that is `scale` with empty `direction`.

## Phase flow（禁止跳步）

`Phase 1: Autonomous start → Phase 2: Autonomous Execute → Phase 3: close → Phase 4: PR → Phase 5: merge-ready`。Transition gates（HARD）→ **`mstar-iteration`** **Phase transition gates** table。

## Continuous execution（HARD — Phase 1 lock 后至 Phase 5 exit）

Execute **`mstar-iteration` §2.6**（Continuous execution SSOT）。**合法 STOP（仅此升级用户）**：branch metadata 按 **`mstar-iteration`** autonomous resolve 顺序仍无法确定（**禁止**静默默认 `main`/`master`）；代码/roadmap **无可信候选**且无 `direction` 参数；**`Blocked`**（真冲突、secrets、不可逆范围缺口、Phase 5 多轮仍无法 merge-ready）；用户本轮显式打断。**Turn 收束纪律**：最后一条内容必须是 **in-flight 动作**（invoke 已发出或下一 Assignment），**不得**以确认问句结尾。

## PM invariants

| 禁止（PM 线程） | 必须 |
|-----------------|------|
| 自己 Edit 冒充 product-manager / architect / writing-specialist；只写 Assignment 就声称 review 完成 | §5.1 → §5.2 → §5.3 **顺序**各 **1 次 invoke**；5.4 PM lock 在 subagent 返回之后（**`mstar-iteration` §1.6**） |
| 加载 `grill-me` | **Autonomous** direction lock（`mstar-iteration` §1.2） |
| Write/Edit/Shell 产品代码、写测试、跑 QC；多 task plan inline 大包派发 | 每条 implement/QC/QA Assignment ⇒ **1 次 `Task`**；**SDD** per-task 循环 |
| 最后 plan `Done` 后直接开 PR；Phase 5 自己改产品代码 | **Phase 3 → 4 → 5**；dispatch `fullstack-dev` / `ops-engineer` |

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
12. **`mstar-iteration/references/phase-2-worktree-lease.md`** — Phase 2 control worktree + lease（§2.0 #5 未 waive）

**Do not** Read `skills/grill-me/SKILL.md` for this command.

---

## Phase 1: Autonomous start

### 1. Research

Survey structured harness dirs（`{HARNESS_DIR}/status.json`、`{ITERATION_DIR}/`、`{KNOWLEDGE_DIR}/`、`{SPECS_DIR}/`）+ glob for planning artifacts（`**/roadmap*.md`、`**/deferred*.md`、`**/features*.md`、`**/backlog*.md`、`**/TODO*.md`、`**/*.plan.md`）；read `STRATEGY.md` if present。Prioritize deferred / roadmap `next` items（code-first — **explore before guessing**）。

### 2–4. Explore → Lock → Write

Scope **2–4** candidates targeting product completeness（prefer deferred / roadmap `next`）→ **autonomous** direction lock（**`mstar-iteration` §1.2** + `references/autonomous-direction-lock.md`：`direction` arg 约束候选或 rank 后 **lock recommended**；落盘 rationale + success criteria + non-goals + scale budget；autonomous branch resolve — never silent `main`/`master`；**STOP** if no credible candidate and no `direction` arg；**do not** ask user to confirm）→ write compass + plans per **`mstar-iteration` §1.3–§1.5**（template `references/iteration-compass-template.md`；**business** plan count within scale budget）。

### 5. Review & Edit Chain（HARD GATE）

Execute **`mstar-iteration` §1.6**：`product-manager` → `architect` → `writing-specialist` **顺序** invoke（编辑 compass / plans / specs / `<iteration-id>/` package；**禁止** `{KNOWLEDGE_DIR}/` 新增；writing-specialist corpus hygiene → `iteration-artifact-boundaries.md` + `iteration-corpus-hygiene.md`）→ PM lock（compass `status: locked` + Prepare gates）。Tool rule → **`mstar-dispatch-gates`**。Exception: user waives ("PM-only review").

**Pre-commit checklist**（print before §6; all `[x]`）：autonomous direction lock rationale in compass（not grill-me）；scale budget applied；compass + plans + `status.json` registered；三角色 invokes completed（**未**向 `{KNOWLEDGE_DIR}/` 新增）；PM final lock + Prepare gates；branch policy locked（`iteration_base_branch` / `spec_integration_branch` / `target_branch`）。**THEN** commit + push `iteration/<iteration-id>`.

### 6. Integration Branch

Per **`mstar-iteration` §2.3**（`git fetch` → `git checkout -b <spec_integration_branch> <iteration_base_branch>`；register branch fields in compass + `status.json`；commit docs；push）。**STOP** if `iteration_base_branch` / `target_branch` still missing after autonomous resolve.

**Immediately** print `## Phase 2: Autonomous Execute` → continue below（勾掉 `phase-1-autonomous-start`）。

---

## Phase 2–5: Execute → close → PR → merge-ready

Delegate to **`iteration-drive`**（Phase 2 → **`mstar-iteration` §2**、Phase 3 → **§3** + `references/phase-3-iteration-close.md`、Phase 4/5 → **§4–§5** + `references/phase-4-5-pr-delivery.md`、Phase 5 helper discovery → `mstar-iteration/references/phase5-helper-discovery.md`）。

**Assignment preflight**（`mstar-harness` bin 未安装时静默跳过）: 每次 implement/QC/QA 派发前校验最新 Assignment（**SDD** 下为最新 `{SDD_DIR}/task-N-brief.md` 或临时写盘的 Assignment），同 `iteration-drive`。模式由迭代 compass frontmatter 的 `enforcement` 键决定（Slice 5）：

- **默认（compass 无 `enforcement: hard`）— 可选 warn-only**：exit 1 仅提示，不阻断派发（Slice 3 行为不变）：

```bash
command -v mstar-harness >/dev/null 2>&1 && mstar-harness dispatch validate "<latest-assignment-file>"
```

- **`enforcement: hard`（迭代 compass frontmatter 声明）— fail-fast**：校验失败即 `exit 1` 阻断派发（bin 缺失仍静默跳过）：

```bash
if command -v mstar-harness >/dev/null 2>&1; then mstar-harness dispatch validate "<latest-assignment-file>" || exit 1; fi
```

> 路径必须加引号且替换为具体文件（如最新 `{SDD_DIR}/task-N-brief.md`，勿留尖括号）——agent 代入的路径不得进入 shell 无引号展开。

**Loop 特有**：Phase 5 push cadence（HARD）→ **`mstar-iteration` §5.1a**；exit checklist → **`mstar-iteration` §5.2**（`references/phase-4-5-pr-delivery.md` §5.2）。

**Then** report: iteration id, locked direction + scale, plans completed, compound summary, PR link, merge-ready evidence.

PR merge itself may remain manual unless user authorized auto-merge.
