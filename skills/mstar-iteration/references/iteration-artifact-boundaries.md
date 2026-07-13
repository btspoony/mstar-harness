# iteration-start 产物边界（specs · iterations · knowledge）

> **When**: Phase 1 — PM 初稿落盘、§1.6 Review & Edit chain；Phase 2 迭代执行期可继续写入 iteration package；Phase 3 iteration-close 经 **`mstar-compound`** 提升。
> **Conflict**: 与 `mstar-plan-artifacts/references/knowledge-and-designs.md` 一致；冲突以 **`mstar-harness-core`** 为准。

## 三棵树分工（HARD）

| 树 | 路径 | 长期价值 | 谁写（何时） | 典型内容 |
|----|------|----------|--------------|----------|
| **Specs（仓库级）** | `{SPECS_DIR}/` | **是** — 跨迭代规范性权威 | product / architect @ **iteration-start** | 已锁定产品/API 规格、ADR、契约 |
| **Iterations** | `{ITERATION_DIR}/` | **迭代级** — 历史快照；可提升 | product / architect / PM @ start & execute | **`<iteration-id>/` package**（compass + specs/guides） |
| **Knowledge** | `{KNOWLEDGE_DIR}/` | **是** — 可复用实施 SSOT | **`mstar-compound`** @ **iteration-close**（含 package 提升） | 结晶、提升后的长期实施知识 |

```text
iteration-start / execute
  product / architect  ──►  {SPECS_DIR}/                    已锁定的长期规格
                         ──►  {ITERATION_DIR}/<id>/         迭代 package（compass + specs + guides）
                         ✗   {KNOWLEDGE_DIR}/                不直接新增

iteration-close (§3.2)
  mstar-compound       ──►  读 plan 素材 + {ITERATION_DIR}/<id>/**
                         ──►  {KNOWLEDGE_DIR}/                提升值得保留的 specs/guides
```

## `{ITERATION_DIR}/<iteration-id>/` 迭代 package（目录优先）

**Canonical layout**（新 iteration-start **只写**此形态）：

```text
{ITERATION_DIR}/
  README.md                         # 根索引：每迭代一行 → 指向 <iteration-id>/
  <iteration-id>/
    delivery-compass.md             # 迭代状态 SSOT（frontmatter status）
    README.md                       # 本迭代文档索引（有 guides/specs 时推荐）
    guides/                         # 探索笔记、过程指南、未锁定权衡
    specs/                          # 迭代级规格草案
```

| 子路径 | 放什么 | 不放什么 |
|--------|--------|----------|
| **`delivery-compass.md`** | 范围、plans 表、验收、分支策略、close 摘要 | 长文探索正文（链到 `guides/` / `specs/`） |
| **`guides/`** | 候选方案、调研、会议记录、实施过程说明 | 已锁定的仓库级规范 |
| **`specs/`** | 本迭代演进中的规格、迭代内契约草稿 | 已锁定、跨迭代 `{SPECS_DIR}/` 级权威（应升格或已在 `{SPECS_DIR}/`） |
| **`README.md`** | 本 package 内 documents 索引（单表即可） | 替代根 `{ITERATION_DIR}/README.md` |

**索引**：

- **`{ITERATION_DIR}/README.md`**：**一行 = 一次迭代**（指向 `<iteration-id>/` 目录，**不**再拆 compass 行 + workspace 行）。
- **`<iteration-id>/README.md`**：列出本目录下 `guides/`、`specs/`（及其它文档）；模板 → **`iteration-workspace-readme-template.md`**。

**Compass 解析顺序**（读）：

1. `{ITERATION_DIR}/<iteration-id>/delivery-compass.md`（canonical）
2. Legacy flat：`{ITERATION_DIR}/<iteration-id>-delivery-compass.md`（仅兼容读；新写禁止）

**禁止（新写）**：根目录 `<iteration-id>-delivery-compass.md`、根目录 `<iteration-id>-working-guide.md`。轻量入口一律进 `<iteration-id>/guides/`。

## `{SPECS_DIR}/` 准入（仓库级长期）

写入 `{SPECS_DIR}/` 前须满足 **至少一条**（与 iteration package 区分）：

- 决策**已锁定**，变更需显式评审
- 跨 plan、跨迭代仍成立
- 本迭代及后续 plan 的 **`primary_spec` / `spec_refs`** 权威来源

**不应**进 `{SPECS_DIR}/`：

- 仍在迭代内演进的草案 → **`<iteration-id>/specs/`**
- 探索 scratch → **`<iteration-id>/guides/`**
- 实施踩坑（未整理）→ 留 package 或 plan 素材，**close 时 compound 提升**

## Knowledge 与 compound 提升

- **`{KNOWLEDGE_DIR}/` 新增**：默认仅在 **iteration-close** §3.2 **`mstar-compound`**。
- **提升来源（iteration-close）**：除 plan 实现/debug/review 素材外，**必须盘点** `{ITERATION_DIR}/<iteration-id>/**`（`guides/`、`specs/`、扁平文件；**默认排除** `delivery-compass.md` 除非 PM 显式纳入）。值得跨迭代复用的内容 → 按 compound 双轨模板**重写**进 `{KNOWLEDGE_DIR}/`（非整文件复制）；细则 → **`mstar-compound`**「Iteration package promotion」。
- **提升后**：在源文件顶部或 package `README.md` 标注 `Promoted to: {KNOWLEDGE_DIR}/...`；源文件**保留**为迭代历史（或迁入 `<iteration-id>/archived/` 若团队约定）。
- **iteration-start §1.6**：product / architect **不得**向 `{KNOWLEDGE_DIR}/` **新增**；误写由 writing-specialist 迁回 **package**。

## §1.6 各角色编辑范围

| 角色 | 必须编辑 | 禁止 |
|------|----------|------|
| **product-manager** | compass、plans、`{SPECS_DIR}/`、`{ITERATION_DIR}/<iteration-id>/`（guides/specs） | `{KNOWLEDGE_DIR}/` **新增**；迭代草案写入 `{SPECS_DIR}/` |
| **architect** | 同上 + package `specs/` 技术向 | 同上；在 `{SPECS_DIR}/` 堆实施踩坑 |
| **writing-specialist** | 当轮文档 + `{SPECS_DIR}/` corpus hygiene + 既有 knowledge 卫生 | 代替 compound **提升**；跳过 specs 全库审查 |

Phase 2 执行期：各角色可继续向 **`<iteration-id>/`** 追加 guides/specs；**仍不**直写 `{KNOWLEDGE_DIR}/`。

## plans[].metadata 挂接

| 内容 | 挂接键 | 路径 |
|------|--------|------|
| 仓库级锁定规格 | `primary_spec` / `spec_refs` | `{SPECS_DIR}/` |
| 迭代上下文 | `iteration_compass` / `iteration_refs` | `{ITERATION_DIR}/<iteration-id>/delivery-compass.md` + 同目录下 docs |
| 知识库（已有） | 仅历史链接 | `{KNOWLEDGE_DIR}/` — **start 不新增** |

## 反模式

- 用 `{KNOWLEDGE_DIR}/` 存迭代探索（应进 `<iteration-id>/guides/`）
- 把迭代 package 草案直接复制进 `{SPECS_DIR}/` 而不锁定评审
- iteration-close **只做** plan 素材 compound、**不**盘点 `<iteration-id>/` package
- 提升时整文件复制到 knowledge（应 compound 结构化重写）
- 新写仍把 compass 放在 `{ITERATION_DIR}/` 根目录（应用 `<iteration-id>/delivery-compass.md`）
