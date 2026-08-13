---
category: Harness
packages: root
---

- **dsh plugin**: panel F5 iteration-zone fixes (plan `20260812-panel-f5-iteration-zone-fix`) — (1) the iteration Steps now carry a **four-state machine** (`current` / `next` / `done` / `idle`): every step BEFORE the current one projects `done`「已完成」 (completed — a finished Step 1 no longer reads as idle「待命」 while Step 2 is current; `next` stays the single forward target, `idle` is schema-only), with a quiet passed treatment — success-tinted badge border + muted chip text with a leading ✓ (`data-step-state="done"`, projection-derived, never UI-guessed); (2) the branch panel in the expanded split head is **width-capped** (`flex: 0 1 260px` + `max-width: 280px` — it no longer stretches with the container; the Steps row absorbs the remaining width, and the <860px column stack resets to content height). `current`/`next`/verdict semantics, the Phase-1 no-badge rule and the Step-5-never-current limitation are all preserved (Step 5 renders `next` only while Step 4 (pr-delivery) is current — docs corrected to match). Docs synced: dsh.md SSOT + bundle mirror + README.md / README.zh.md / bundle/README.md.

<!-- CN -->
- **dsh 插件**：面板 F5 迭代区补丁（plan `20260812-panel-f5-iteration-zone-fix`）——(1) 迭代 Steps 升级为**四态状态机**（`current` / `next` / `done` / `idle`）：current 之前的步骤投影为 `done`「已完成」（已完成的 Step 1 不再在 Step 2 current 时显示为待命 idle；`next` 仍为唯一前向目标，`idle` 仅为 schema 余项），配低调「已完成」样式——徽标成功色描边 + 淡化 chip 文案加前导 ✓（`data-step-state="done"`，投影推导、非 UI 猜测）；(2) 展开态分栏中的分支面板**宽度受约束**（`flex: 0 1 260px` + `max-width: 280px`——不再随容器撑宽；Steps 行吸收剩余宽度，<860px 竖排时重置为内容高度）。`current`/`next`/verdict 语义、Phase-1 无徽标规则与 Step-5 永不为当前的限制均保留（Step 5 仅当 Step 4（pr-delivery）为当前步时渲染 `next`——文档已校正对齐）。文档同步：dsh.md SSOT + bundle 镜像 + README.md / README.zh.md / bundle/README.md。
