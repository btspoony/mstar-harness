---
name: iteration-start
description: "Start a new harness iteration — optional direction hint, research, design prototype confirmation, compass/plans, selected specialist Review & Edit and PM lock, integration branch; then auto-continue Phase 2→6 (execute → close → PR → merge-ready → post-merge close) unless `pause` arg given."
agent: project-manager
input: "[direction] [pause]"
---

# Start Iteration

Start a new Morning Star harness iteration. **Phase 1 is not complete until the current prototype design is confirmed, the selected Review & Edit roles return (writing-specialist last), and PM locks the package — not when files are first written.** By default, after Phase 1 lock + integration worktree, **auto-continue into Phase 2→6** (execute → close → PR → merge-ready → post-merge close); pass **`pause`** to stop after Phase 1 and resume later with `/iteration-drive`.

## Args

```text
/iteration-start [direction] [pause]
```

| Arg | Meaning | Default |
|-----|---------|---------|
| `direction` | Iteration direction hint — constrains §2 candidates and seeds §3 grill-me; **not** a lock (start stays interactive) | Research → grill-me converges with user |
| `pause` | Stop after Phase 1 (lock + integration worktree); run `/iteration-drive` later to resume | **Auto-continue** into Phase 2→6 |

**Parse**: if any token is exactly `pause` (case-insensitive), treat as the `pause` flag; the remaining tokens (joined) are the `direction` hint. `/iteration-start pause` = pause with empty direction.

## PM invariants（Phase 1 review-chain — 本命令全程有效）

You are the **`project-manager` orchestrator**, not a substitute for selected specialists.

| Forbidden in the PM thread | Required when the host permits invoke |
|----------------------------|--------------------------------------|
| Performing selected specialists' document edits yourself | Select product-manager / architect by complexity and remaining gaps; record include/skip reasons; invoke selected roles sequentially, then mandatory writing-specialist last |
| Claiming completion from Assignment prose or checklists alone | **One selected role ⇒ one actual invoke and return**; no fake receipts for skipped roles (`mstar-dispatch-gates`) |
| Creating integration worktree / pushing `spec_integration_branch` before §5 completes | PM lock follows the final writer return and on-disk revisions (`mstar-iteration/references/phase-1-prepare.md` §1.6) |

Dispatch details → **`mstar-dispatch-gates`** + active **`mstar-host`** reference. Do not load another role reference in the PM thread to impersonate that role.

**Phase 1 completion**: approved current prototype + compass `status: locked` + all selected invokes returned (writer last) + pre-integration checklist all `[x]`. **Command Done** (§7 auto-continue) remains Phase 6 post-merge close; with `pause`, stop after Phase 1.

**Phase 2–5 共享 invariants / preflight / todos / STOP** → **`mstar-iteration/references/command-shared-invariants.md`**（不在本命令重复）。

## Path split（HARD — 路由）

| 宿主上下文 | 走哪条 |
|------------|--------|
| **Host Plan mode** (active Plan session) | §0 Boot → **§P** — one session-plan carrier; prototype feedback loop before formal drafts; preserve actual host write/dispatch and Build permissions |
| **Other** (not a Plan session) | §0 Boot → §1–§6 (Research → Explore → direction → prototype confirmation → Write → selected Review → branch) |

**Both paths converge at §6**（integration worktree）。Default → §7 auto-continue Phase 2→6；`pause` → command ends at §6.

## 0. Boot

按 **`mstar-iteration`** Load order 加载（`mstar-harness-core` → `mstar-roles` → `references/project-manager.md` → `mstar-iteration`（route map：start → **`references/phase-1-prepare.md`**）+ `mstar-phase-gates` + `mstar-dispatch-gates` + `mstar-conventions/artifacts` + `mstar-host` → active host reference）。Plan 会话另读 **active host reference 的 plan-mode bridge**（`mstar-iteration` Phase 1 in Plan mode）。完整 load list → **`mstar-roles`**。

**若宿主 Plan mode 活跃 → 进入 §P；否则继续 §1。**

## P. Host Plan mode (single carrier → prototype feedback → approved design → permitted drafting / Build)

Execute **`mstar-host`** → active host **plan-mode bridge**, especially the shared "mstar-iteration Phase 1 in Plan mode" gate. A session-plan scaffold is UX, not an early compass/guide/plan/spec draft. Feedback is not a mandatory questionnaire, and feedback-close alone is not approval of the current prototype. **Design approval is not Build / implementation authorization.**

Command-only supplements:

- **Carrier fields**: Direction / prototype path and current revision / Feedback log / design approval disposition / recommended Delivery Branch Policy / pending preparation todos. Formal Scope / Decisions / Acceptance Criteria / Plans derive from the approved design, not before it.
- **Preparation todos**: `harness-init` → `direction-lock-arm` → `prototype-design` → `prototype-confirmation` → `finalize-compass-plans` → selected review-edit seats → mandatory `review-edit-writing-specialist` → `pm-lock` → `integration-branch`. Complete a todo only when its semantic gate **and** actual host permissions allow it. If Plan mode cannot persist/show the package prototype or invoke a needed role, use the bridge's documented permission-resume path; never bypass restrictions with another tool or silently create a second plan.

## 非 Plan 路径从这里继续 ↓

## 1. Research

Survey structured harness dirs（`{HARNESS_DIR}/status.json`、`{ITERATION_DIR}/`、`{KNOWLEDGE_DIR}/`、`{SPECS_DIR}/`）+ glob for planning artifacts（`**/roadmap*.md`、`**/deferred*.md`、`**/features*.md`、`**/backlog*.md`、`**/TODO*.md`、`**/*.plan.md`）；read `STRATEGY.md`（if exists）and `{KNOWLEDGE_DIR}/README.md`（if exists — Active index rows are Research candidates）。Prioritize deferred / incomplete items from prior iterations。

## 2. Explore Directions

Scope **2–4** candidates targeting **product completeness**（default to deferred items from previous iterations；allow substantive refactoring where it accelerates product maturity）。**If `direction` arg given** — narrow candidates to that hint (still scope 2–4 unless explicitly singular)；record the hint in grill-me context。

## 3. Lock Direction — bundled `grill-me`

> **非 Plan 路径**。Plan mode 用 §P feedback loop + deferred grill（主路径不是 grill）。

**Direction lock mode: `interactive`**（`mstar-iteration/references/phase-1-prepare.md` §1.2 默认；本命令不使用 `autonomous`）。This command bundles a **non-`mstar-*`** skill at `skills/grill-me/SKILL.md` — **only this command step** references it.

**Before this step:** Read `skills/grill-me/SKILL.md`. Run **grill-me** to stress-test candidate directions with the user: walk through trade-offs, converge on a **single iteration direction** with shared understanding, document locked direction + success criteria + non-goals。**If `direction` arg given** — seed grill-me with it (still interactive; the hint does **not** skip grill-me)。Confirm delivery branch policy（`iteration_base_branch` / `target_branch`）per **`mstar-iteration/references/phase-1-prepare.md` §1.2** — **Do not default to `main`/`master` just because those names exist.**

## 3.5 Arm the coordinator model handoff — `direction-lock`

The `direction-lock` anchor (`mstar-iteration/references/phase-1-prepare.md` §1.2 tail) fires **here**: the direction is locked and the compass/plans draft has **not** been written yet. Execute the active host reference's `## Host hooks` declaration for that anchor; this command declares no host action. Do **not** defer it into §4 — the draft is the context carrier the dispatched review roles read, so the anchor must precede it.

## 3.6 Prototype Design & Confirmation

Execute **`mstar-iteration/references/phase-1-prepare.md` §1.2.5** before §4: persist a plain-language visual **HTML prototype in `{ITERATION_DIR}/<iteration-id>/prototypes/`**, then present the current revision to the user. PM may invoke product-manager / architect for bounded prototype contributions when permitted. Absorb feedback → communicate the decision → update the same prototype → present it again, until the user explicitly approves **that current design**. A direction hint, direction lock, feedback-close, or approval of an earlier revision does not open §4. This checkpoint approves design, not implementation.

## 4. Write Compass & Plans

Only after current-design approval, produce formal artifacts per **`mstar-iteration/references/phase-1-prepare.md` §1.3–§1.5** (template: `references/iteration-compass-template.md`): compass, plans, package guides/specs and workflow registration. Compass `## Prototype baseline` records path/revision and genuine confirmation; plans reference the prototype through existing `metadata.iteration_refs`, without new schema fields. Global `{SPECS_DIR}` promotion remains at iteration-close.

## 5. Review & Edit Chain（HARD GATE — integration worktree only after this）

Execute **`mstar-iteration/references/phase-1-prepare.md` §1.6** (SSOT): PM records include/skip reasons for product-manager and architect, reusing prototype-stage contributions; invoke the selected subset in product-manager → architect order, then **always invoke writing-specialist last**, then PM lock. Shared-file editors remain sequential. Skipped roles leave no role-owned markers or unresolved blocking questions; newly discovered product/technical gaps require reassessment, and material design changes return to §3.6. No `{KNOWLEDGE_DIR}/` additions; writer corpus hygiene remains required. Tool rule → **`mstar-dispatch-gates`** (one selected role = one actual invoke and on-disk return). Exception remains a user's explicit dispatch waiver ("PM-only review").

**Assignment preflight**：每次 invoke 前按 **`mstar-iteration/references/command-shared-invariants.md`** 执行（warn-only + `enforcement: hard` fail-fast；bin 缺失静默跳过）。

**Prepare gate (per plan in compass)**:

- [ ] specify / clarify / plan = done on each plan file
- [ ] `primary_spec` path exists (if declared)
- [ ] `blocked_by` / sequential deps documented

### iteration-start pre-integration checklist

PM must print this block before §6; all `[ ]` must be `[x]`:

- [ ] direction lock decisions recorded in compass（Plan 路径：Feedback log + deferred grill log；非 Plan：grill-me）
- [ ] `direction-lock` anchor executed **before** the draft was written（§3.5；未登记/无 compass 属预期）
- [ ] Current HTML prototype persisted in the iteration package, presented, and explicitly approved; feedback revisions and approval disposition retained
- [ ] Draft compass + plans + `status.json` registered
- [ ] product-manager / architect include/skip reasons recorded; every selected invoke returned; mandatory writing-specialist returned last; no skipped-role markers / blocking questions or fake receipts; no `{KNOWLEDGE_DIR}/` additions
- [ ] PM final lock: compass `status: locked`; Prepare gates pass (blocked plans documented)
- [ ] Branch policy locked: `iteration_base_branch` / `spec_integration_branch` / `target_branch` recorded in compass / `status.json`
- [ ] **THEN**（§6 按 §2.3 checklist step 7 执行）：integration worktree 已建立，新建的 `iteration/<iteration-id>` 分支已 push —— Phase 1 的全部写入目标（compass / plans / `<iteration-id>/` package，specs 在 `<iteration-id>/specs/`）均为默认 gitignored 的本地 `.mstar/` 工件；全局 `{SPECS_DIR}` 在 Phase 3 iteration-close 提升时写入；never the primary checkout

## 6. Integration Branch

**Call site — do not restate the sequence.** Execute **`mstar-iteration/references/phase-2-worktree-lease.md` §2.3**「Integration worktree (Phase 2 entry) + control root」checklist **steps 1–7** —— 该 checklist 是该序列的**唯一 home**。本命令另记两件 command 层事实：register `iteration_base_branch` / `spec_integration_branch` / `target_branch` in compass frontmatter **and** `status.json` metadata；record the observed primary branch as **`Main worktree branch`** in the main plan header。**STOP** if `iteration_base_branch` / `target_branch` missing — never default `main`/`master`。

**Phase 1 完成 anchor（pointer only — 本命令不承载 marker）**：checklist **step 7** 走完后必须执行 `phase-1-lock` 的 host 动作 —— 其 marker 与触发条件由 **`mstar-iteration/references/phase-2-worktree-lease.md` §2.3**「Integration worktree (Phase 2 entry) + control root」checklist tail 承载。

**Parenthetical**：本处引用的 §2.3 是 **Phase 1** 步骤 —— 它**不**触发 `phase-2-entry` anchor（后者只在 Phase 2 execute/resume entry、即 §2.4 之前触发）；Phase 2 resume 再次走到 §2.3 时 `phase-1-lock` 已在 Phase 1 完成，不再重复调用。

---

## 7. Phase 2–6（auto-continue）

**`pause` arg → command ends here**（Phase 1 locked + integration pushed；run `/iteration-drive` later）。**Default（no `pause`）→ auto-continue**：execute **`iteration-drive`**（Phase 2 → **`mstar-iteration/references/phase-2-worktree-lease.md`**；Phase 3 → `references/phase-3-iteration-close.md`；Phase 4/5 → `references/phase-4-5-pr-delivery.md`；Phase 5 helper discovery → `phase5-helper-discovery.md`；Phase 6 post-merge close（PR merged 后）→ `references/phase-6-post-merge-close.md` §6.1–§6.4）。Shared invariants / preflight / STOP → **`mstar-iteration/references/command-shared-invariants.md`**。

**Done = Phase 6 post-merge close 完成**（同 `iteration-drive`：Phase 5 §5.5 exit checklist 全 `[x]` 且 PR merged 后 §6.1–§6.4 完成 — Phase 5 exit / PR merged 不是 Done）。**Then** report: iteration id, direction lock summary, plans completed, compound summary, PR link, merge-ready evidence（CI snapshot + review resolution + Greptile if applicable）, post-merge close evidence（snapshot `completed` + `ended_at`、根 `status.json` 注销、投影一致）。

PR merge itself may remain manual unless user authorized auto-merge.
