---
name: iteration-loop
description: "Autonomous full iteration loop for cloud agents — Phase 1 (code-first auto direction lock + compass/plans + Review & Edit chain) through Phase 2–5 (execute → close → PR → merge-ready). Optional args: direction, scale (S|M|L|XL, default M). Not Done until Phase 5 exit checklist passes. Minimal human intervention; no grill-me."
agent: project-manager
input: "[direction] [scale]"
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

Execute **`mstar-iteration` §2.6**（Continuous execution SSOT）+ **`mstar-iteration/references/command-shared-invariants.md`** STOP list（branch metadata 缺失 / **`Blocked`** / 用户显式打断 — 不在本命令重复）。**Loop 特有 STOP**：branch metadata 按 **`mstar-iteration`** autonomous resolve 顺序仍无法确定（**禁止**静默默认 `main`/`master`）；代码/roadmap **无可信候选**且无 `direction` 参数。**Turn 收束纪律**：最后一条内容必须是 **in-flight 动作**（invoke 已发出或下一 Assignment），**不得**以确认问句结尾。

**Do not** Read `skills/grill-me/SKILL.md` for this command.

## Boot

按 **`mstar-iteration`** Load order 加载（`mstar-harness-core` → `mstar-roles` → `references/project-manager.md` → `mstar-iteration` § Phase 1–5 + `command-shared-invariants.md` → `mstar-dispatch-gates` → `mstar-phase-gates` → `mstar-conventions` / `mstar-artifacts` → `mstar-host` → `mstar-compound`（Phase 3 前）→ **`mstar-sdd`**（first implement 前）→ `mstar-review-qc`（first QC 前）→ `mstar-branch-worktree` → **`mstar-iteration/references/phase-2-worktree-lease.md`**）。完整 load list → **`mstar-roles`**。

**Session todos（loop 专属；Phase 2–5 共享 rows → `command-shared-invariants.md`）**：

| Todo id | 何时追加 | 何时可勾掉 |
|---------|----------|------------|
| `phase-1-autonomous-start` | Boot | compass `locked` + integration committed |

## Phase 1: Autonomous start

Execute **`mstar-iteration` § Phase 1**（**autonomous** direction lock + scale budget + branch resolve SSOT → `references/autonomous-direction-lock.md`）：

### 1–4. Research → Explore → Lock → Write

Survey structured harness dirs（`{HARNESS_DIR}/status.json`、`{ITERATION_DIR}/`、`{KNOWLEDGE_DIR}/`、`{SPECS_DIR}/`）+ planning artifacts（`**/roadmap*.md`、`**/deferred*.md`、`**/features*.md`、`**/backlog*.md`、`**/TODO*.md`、`**/*.plan.md`）+ `STRATEGY.md`（if present）→ scope **2–4** candidates → **autonomous** lock（`direction` arg 约束；落盘 rationale + success criteria + non-goals + scale budget；branch resolve — never silent `main`/`master`；**STOP** if no credible candidate and no `direction` arg）→ write compass + plans per §1.3–§1.5（business plan count within scale budget）。

### 5. Review & Edit Chain（HARD GATE）

Execute **`mstar-iteration` §1.6**：`product-manager` → `architect` → `writing-specialist` 顺序 invoke（**禁止** `{KNOWLEDGE_DIR}/` 新增；corpus hygiene）→ PM lock。**Assignment preflight** per **`command-shared-invariants.md`**。

**Pre-commit checklist**（print before §6；all `[x]`）：

- [ ] Autonomous direction lock rationale recorded in compass（**not** grill-me）
- [ ] Scale budget applied（business plan 按 S/M/L/XL 名额）
- [ ] compass + plans + `status.json` registered
- [ ] product-manager / architect / writing-specialist invokes completed（**未**向 `{KNOWLEDGE_DIR}/` 新增）
- [ ] PM final lock：compass `status: locked` + Prepare gates pass
- [ ] Branch policy locked：`iteration_base_branch` / `spec_integration_branch` / `target_branch` recorded
- [ ] **THEN** commit + push `iteration/<iteration-id>`

### 6. Integration Branch

Per **`mstar-iteration` §2.3**（create from `iteration_base_branch`；register branch fields；commit docs；push）。**STOP** if base/target missing。**Immediately** print `## Phase 2: Autonomous Execute` → continue（勾掉 `phase-1-autonomous-start`）。

---

## Phase 2–5: Execute → close → PR → merge-ready

Delegate to **`iteration-drive`**（Phase 2 → §2、Phase 3 → §3 + `references/phase-3-iteration-close.md`、Phase 4/5 → §4–§5 + `references/phase-4-5-pr-delivery.md`、Phase 5 helper discovery → `phase5-helper-discovery.md`）。**Assignment preflight** per **`command-shared-invariants.md`**。

**Loop 特有**：Phase 5 push cadence（HARD）→ **`mstar-iteration` §5.1a**；exit checklist → §5.2（`references/phase-4-5-pr-delivery.md`）。

**Then** report: iteration id, locked direction + scale, plans completed, compound summary, PR link, merge-ready evidence。

PR merge itself may remain manual unless user authorized auto-merge.
