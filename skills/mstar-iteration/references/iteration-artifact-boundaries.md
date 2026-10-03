# iteration-start 产物边界（specs · iterations · knowledge）

> **When**: Phase 1 prototype checkpoint (§1.2.5), formal drafting (§1.3) and Review & Edit (§1.6). Design context stays under `prototypes/`; iteration specs under `<iteration-id>/specs/`. Existing execute/close boundaries below remain unchanged.
> **Conflict**: 与 `mstar-artifacts/references/knowledge-and-designs.md` 一致；冲突以 **`mstar-harness-core`** 为准。

## 三棵树分工（HARD）

| 树 | 路径 | 长期价值 | 谁写（何时） | 典型内容 |
|----|------|----------|--------------|----------|
| **Specs（仓库级）** | `{SPECS_DIR}/` | **是** — 跨迭代规范性权威 | **Phase 3 iteration-close** specs 提升流程 | 已锁定产品/API 规格、ADR、契约 |
| **Iterations** | `{ITERATION_DIR}/` | Iteration-level history/design context; eligible material may be promoted | PM + selected product/architect contributors + final writer | **`<iteration-id>/` package** (prototypes + compass + specs/guides) |
| **Knowledge** | `{KNOWLEDGE_DIR}/` | **是** — 可复用实施 SSOT | **`mstar-compound`** @ **iteration-close**（含 package 提升） | 结晶、提升后的长期实施知识 |

```text
iteration-start / execute
  product / architect  ──►  {ITERATION_DIR}/<id>/specs/       迭代级规格（gitignored）
                         ──►  {ITERATION_DIR}/<id>/guides/    过程指南
                         ──►  compass + plans                 迭代过程产物（gitignored）
                         ✗   {KNOWLEDGE_DIR}/                 不直接新增

iteration-close (§3.2 + specs 提升，写入 integration worktree)
  specs 提升流程        ──►  {SPECS_DIR}/                    已锁定的仓库级规格
  mstar-compound       ──►  读 plan 素材 + {ITERATION_DIR}/<id>/**
                         ──►  {KNOWLEDGE_DIR}/                提升值得保留的实施知识
```

## `{ITERATION_DIR}/<iteration-id>/` 迭代 package（目录优先）

**Canonical layout** (new starts): create the package early for the §1.2.5 prototype. Autonomous lock first retains root `direction-lock.md`, then executes the direction hook and makes the prototype; interactive follows its direction hook with the HTML feedback loop. Only after the checkpoint disposition does §1.3 author compass/guides/specs.

```text
{ITERATION_DIR}/
  README.md                         # 散文导览（可选；不再作迭代登记表）
  <iteration-id>/
    direction-lock.md               # Autonomous lock-time rationale; retained after drafting
    prototypes/                     # Design preview, revision/feedback and confirmation or autonomous disposition
    delivery-compass.md             # 迭代状态 SSOT（frontmatter status）
    README.md                       # 散文导览（可选；文档归属登记在 catalog）
    guides/                         # 探索笔记、过程指南、未锁定权衡
    specs/                          # 迭代级规格草案
```

| 子路径 | 放什么 | 不放什么 |
|--------|--------|----------|
| **`delivery-compass.md`** | 范围、plans 表、验收、分支策略、close 摘要 | 长文探索正文（链到 `guides/` / `specs/`） |
| **`prototypes/`** | Plain-language visual HTML for interactive review; HTML/Markdown/JSON with rationale for autonomous mode; retained revision/feedback/disposition context | Frozen specs, production code/API or runnable acceptance evidence |
| **`guides/`** | 候选方案、调研、会议记录、实施过程说明 | 已锁定的仓库级规范 |
| **`specs/`** | 本迭代演进中的规格、迭代内契约草稿 | 已锁定、跨迭代的仓库级权威（Phase 3 提升时写入 `{SPECS_DIR}/`） |
| **`README.md`** | 散文导览（可选；可留 package 说明、`Promoted to:` 标注） | 作为 documents 登记表（归属登记在 catalog，见下） |

**登记（DB 权威，contract §1/§4）**：

- 迭代 identity、compass 位置、description、project 归属，以及 package 内文档的 `documents` 关系 = `{HARNESS_DIR}/store.db` 的 catalog 行；读法 `mstar catalog show` / `mstar catalog list`，登记走 reviewed `mstar catalog discover` + `mstar catalog import`，或单行 `mstar catalog register` / `mstar catalog link`。
- `{ITERATION_DIR}/README.md` 与 `<iteration-id>/README.md` 保留为**散文**（导览、`Promoted to:` 标注）；**不再**维护「一行 = 一次迭代」登记行或 package Documents 登记表。tracked 正文可从新 clone 用 `mstar catalog discover` 提议（含显式 `unknowns`），但 `store.db` 本地且默认 gitignored —— 完整 catalog 恢复需显式 `mstar catalog export` + reviewed import。

**Compass 解析顺序**（读）：

1. `{ITERATION_DIR}/<iteration-id>/delivery-compass.md`（canonical）
2. Legacy flat：`{ITERATION_DIR}/<iteration-id>-delivery-compass.md`（仅兼容读；新写禁止）

**禁止（新写）**：根目录 `<iteration-id>-delivery-compass.md`、根目录 `<iteration-id>-working-guide.md`。轻量入口一律进 `<iteration-id>/guides/`。

## `{SPECS_DIR}/` 准入（仓库级长期）

**Phase 1 角色写入 `<iteration-id>/specs/`；全局 `{SPECS_DIR}/` 在 Phase 3 iteration-close 提升时写入。** 进入 `{SPECS_DIR}/` 的内容须满足**至少一条**：

- 决策**已锁定**，变更需显式评审
- 跨 plan、跨迭代仍成立
- 本迭代及后续 plan 的 **`primary_spec` / `spec_refs`** 权威来源

**迭代期产物的去向**（均落在 `<iteration-id>/` package）：

- 迭代内演进的规格草案 → **`<iteration-id>/specs/`**
- 探索 scratch → **`<iteration-id>/guides/`**
- 实施踩坑（未整理）→ 留 package 或 plan 素材，**close 时 compound 提升**

## Knowledge 与 compound 提升

- **`{KNOWLEDGE_DIR}/` 新增**：默认仅在 **iteration-close** §3.2 **`mstar-compound`**；写入发生在 **integration worktree** 中 tracked 的 `{KNOWLEDGE_DIR}/`，随 close commit 进入 integration 分支。
- **`{SPECS_DIR}/` 提升（iteration-close）**：满足准入的已审 package specs 由 §3.2 的 specs 提升流程写入 integration worktree 中 tracked 的 `{SPECS_DIR}/`。
- **提升来源（iteration-close）**：除 plan 实现/debug/review 素材外，**必须盘点** `{ITERATION_DIR}/<iteration-id>/**`（`guides/`、`specs/`、扁平文件；**默认排除** `delivery-compass.md` 除非 PM 显式纳入）。值得跨迭代复用的内容 → 按 compound 双轨模板**重写**进 integration worktree 中 tracked 的 `{KNOWLEDGE_DIR}/`（非整文件复制）；细则 → **`mstar-compound`**「Iteration package promotion」。
- **提升后**：在源文件顶部或 package `README.md` 标注 `Promoted to: {KNOWLEDGE_DIR}/...`；源文件**保留**为迭代历史（或迁入 `<iteration-id>/archived/` 若团队约定）。
- **iteration-start §1.6**：product / architect **不得**向 `{KNOWLEDGE_DIR}/` **新增**；误写由 writing-specialist 迁回 **package**。

## §1.6 selected-role editing scope

Selection/reassessment and include/omit rationale → `phase-1-prepare.md` §1.6. Prototype-stage participation is optional and its contributions are reused; it does not force a formal product/architect round or replace one when selected.

| Role | Edit scope when invoked | Prohibited | Marker duty |
|------|-------------------------|------------|-------------|
| **product-manager (selected as needed)** | Compass, plans and relevant package guides/specs; align product criteria with the retained prototype | New `{KNOWLEDGE_DIR}/` documents | Clear owned product scope/priority/acceptance markers |
| **architect (selected as needed)** | Same package/documents, technical specs/contracts in particular; consume prototype feasibility decisions | New `{KNOWLEDGE_DIR}/` documents | Clear owned architecture/contract/design markers |
| **writing-specialist (mandatory, last)** | Current edited documents, package corpus hygiene and directly related existing knowledge references | Compound promotion or replacing unresolved specialist design work | Clear owned writing/hygiene markers; check all markers/questions, return missing specialist work for PM re-selection |

Marker syntax/owners → `phase-1-prepare.md` §1.3; clearance, reports and lock obligations → §1.6. Omitted roles have no fake receipts and leave no specialist markers or blocking questions.

Phase 2 执行期：各角色可继续向 **`<iteration-id>/`** 追加 guides/specs；**仍不**直写 `{KNOWLEDGE_DIR}/`。

## plans[].metadata 挂接

| 内容 | 挂接键 | 路径 |
|------|--------|------|
| 仓库级锁定规格 | `primary_spec` / `spec_refs` | `{SPECS_DIR}/` |
| 迭代上下文 | `iteration_compass` / `iteration_refs` | `{ITERATION_DIR}/<iteration-id>/delivery-compass.md` + 同目录下 docs |
| Retained prototype baseline | Existing `iteration_refs` (normal producer path) + compass/plan links | `{ITERATION_DIR}/<iteration-id>/prototypes/`; path/revision and genuine confirmation or autonomous disposition; design context only |
| 知识库（已有） | 仅历史链接 | `{KNOWLEDGE_DIR}/` — **start 不新增** |

## 反模式

- 用 `{KNOWLEDGE_DIR}/` 存迭代探索（应进 `<iteration-id>/guides/`）
- Putting a prototype in specs/knowledge, using it as runnable acceptance evidence, or losing its approved revision when revising the design
- 把迭代 package 草案直接复制进 `{SPECS_DIR}/` 而不锁定评审
- iteration-close **只做** plan 素材 compound、**不**盘点 `<iteration-id>/` package
- 提升时整文件复制到 knowledge（应 compound 结构化重写）
- 新写仍把 compass 放在 `{ITERATION_DIR}/` 根目录（应用 `<iteration-id>/delivery-compass.md`）
