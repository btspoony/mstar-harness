# Playbook vs hotfix（phase gates）

> **Load when:** choosing the Spec-Driven playbook path versus the Hotfix exception, or reading Execute-only playbook supplements.

## Hotfix exception (under Spec-Driven)

压缩路径与事后补记见下文 **§ Hotfix 例外**（Playbook 末尾）。

## Phase Gate Playbook

执行动作与最小产物见上文 **§ Spec-Driven 双阶段门禁**。本节仅 **Playbook 补充**（不重复 Prepare/Execute 长文）。

### Execute 补充（Playbook 专有）

- **`plan locked`**
  - 最小动作：在 plan 或 notes 记录当前锁定版本（日期或 hash）。
  - **Plan 质量门**（新 plan / 大改）：无 placeholder（`...`、`TBD`、`etc.`）—— 该判定在 **`plan(locked)`** 时点执行。Prepare 期间**唯一**被认可的未完成形态是带 owner 的 `TODO(owner: …)` marker（语法、owner 词汇与清除口径 → **`mstar-iteration/references/phase-1-prepare.md`** §1.3；清除期限按路线取：迭代初稿 = compass `status: locked`（**不是**该 plan 的 `plan(locked)` 时点）；独立 plan（无 compass）= 本节 `plan(locked)` 时点）；无 owner 的 placeholder 在任何阶段都不被接受。含 **Global Constraints** 与 per-task **Interfaces**；PM self-review 四问（每 task 可独立验证？依赖顺序清晰？无隐含假设？每 task 可单轮闭合其 Files 与验证门 — Task shape / session fit？→ **`mstar-artifacts/references/plan-quality-bar.md`** item 7）— 见 `mstar-artifacts/templates/plan.main.md` + **`mstar-artifacts/references/plan-quality-bar.md`**（自包含/验证门/STOP 条件/drift check/done criteria）。
- **`implement`**
  - 最小产物：实现 diff、自检证据、回报与 handoff；行为准则 → **`mstar-coding-behavior`**；编辑纪律 → 上文「可验证编辑与上下文纪律」。
  - **知识库 / 迭代 compass**：**默认**开工前扫 `{KNOWLEDGE_DIR}/README.md` 索引（若存在）并阅读与当轮相关的 **Active** 行（**即使 metadata 无 knowledge 链接**）；若 `plans[].metadata` 登记了 `primary_spec` / `spec_refs` / `iteration_compass` / `iteration_refs`，所链接文档**仍须**阅读；两类阅读均须在回报中说明已对齐 → **`mstar-conventions`** · **`mstar-artifacts/references/knowledge-and-designs.md`**。该 implement 时阅读是输入变化时的 re-alignment，不替代 Prepare 的锁前 recall receipt（见上文 Prepare `plan` 节）。

## Hotfix 例外（full）

- 允许路径：`specify(min) -> plan(min) -> implement`
- 必须补记：
  - 事后 `clarify/RCA`
  - 触发条件、影响范围、修复与回滚摘要

