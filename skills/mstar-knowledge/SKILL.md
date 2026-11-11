---
name: mstar-knowledge
description: "Load for `{KNOWLEDGE_DIR}` capture, maintain/refresh/bootstrap, or iteration-close promotion（结晶/清理/显式 bootstrap）；skip with reasoned skipped when nothing to crystallize. Not for ordinary feature coding."
---

# mstar-knowledge（知识结晶与维护）

## Load order

**Read `mstar-harness-core` first.** Path symbols (`{KNOWLEDGE_DIR}`, `{HARNESS_DIR}`) → **`mstar-conventions`**. On conflict, **`mstar-harness-core` wins**.

## Purpose

One artifact family (`{KNOWLEDGE_DIR}` 文档 + `<repo-root>/CONCEPTS.md`), one document shape (**`mstar-doc-corpus`** → `references/knowledge-format.md`、`references/schema.yaml`、`assets/knowledge-skeleton.md`；本 skill 不维护第二份字段表或骨架), two workflows: **Capture** 把已解决的问题沉淀为结构化知识文档，供未来的 plan 研究、debug 与实现检索复用；**Maintain** 让既有文档对抗代码漂移重新可信。Knowledge that isn't captured evaporates when the session ends; knowledge that is captured but not discoverable is equally lost; documents that are captured also age — code changes, conventions evolve, patterns become obsolete — so capture and maintenance are one skill over one artifact.

**In the mstar lifecycle**, Capture is invoked by lifecycle flows — the iteration-close round or a standalone-development delivery tail — sharing one step sequence (see「Integration with mstar lifecycle」). It is never triggered at per-plan `Done`, and stays invocable standalone for ad-hoc captures. Maintain runs only from its own entries (`## When to use / Skip`), which include the Capture Phase 7 flag and the on-demand project-knowledge bootstrap.

**Storage SSOT**: `mstar-conventions/references/artifact-storage-paths.md`。本 skill 不重定义路径：知识文档 → `{HARNESS_DIR}/knowledge/<category>/<slug>.md`（`<category>` 取值见 **`mstar-doc-corpus`** `references/category-mapping.md`）；CONCEPTS.md → `<repo-root>/CONCEPTS.md`；Maintain 另可操作 `{HARNESS_DIR}/knowledge/README.md`（**散文**，见 Maintain Phase 4）。

**层级分工**：本 skill 产出的**工程经验与方法论**不是当前系统状态；三层语料的边界与更新义务 → **`mstar-doc-corpus`** SKILL.md § The three layers（当前状态属 `{SPECS_DIR}`，决策属 `{ADR_DIR}`）。

## When to use / Skip

**Capture — use**: 迭代收口（`mstar-iteration` § iteration-close）批量回顾；独立触发（非迭代或紧急，任何非平凡问题解决后）；重大 bug 修复后（`mstar-iteration` 未启用时手动）；独立 development plan 交付前的 disposition review（PR head 定稿前，见「Integration with mstar lifecycle」）。

**Capture — skip**: 自检 ≤2 Yes；Q5 高重叠（更新已有而非新建）；纯机械工作（格式化、依赖升级、typo）；问题未经验证。独立交付 plan 的 disposition 义务不因跳过结晶而消失——结晶跳过时以 reasoned `skipped` 记录结果（记录在 workflow，见「Integration with mstar lifecycle」）。

**Maintain — use**:

| Trigger | Example |
|---------|---------|
| Capture Phase 7 flag（本 skill，`## Workflow — Maintain`） | "Two docs cover N+1 queries — consider refresh" |
| Scheduled maintenance | "It's been a quarter, let's audit knowledge" |
| Domain refactored | After a major module rewrite |
| Explicit user request | `/pm` + "audit the knowledge docs" — Maintain runs as this skill `## Workflow — Maintain` |
| **Project knowledge bootstrap** | No/stale/partial `STRATEGY.md`, `CONCEPTS.md`, or `{KNOWLEDGE_DIR}` — see 「Bootstrap vs refresh」 |

**Landing here mid-iteration**: neither workflow's entry condition holds. Per-plan `Done` is **not** a capture trigger, and a mid-iteration moment is not a close, not a delivery tail, and carries no staleness signal — such a reader does nothing with this skill beyond continuing assigned work. One bounded exception: when current work hits the Capture Phase 2 overlap condition (an existing doc already covers the ground), **update that doc** (add `last_updated`) rather than deferring to a Maintain audit; that single-doc update is Capture-phase behaviour, not a licence to start a Maintain library sweep. A full Maintain audit (inventory → five outcomes → catalog reconcile) runs only from its own entries above.

## Workflow — Capture

**Inflow workflow**: a solved problem or an iteration package exists, and must be judged (Q1–Q8) and possibly written. Full step detail (Gather context / Overlap detection / Write incl. frontmatter schema + path + validate / Discoverability check / CONCEPTS.md synergy / Catalog registration / Refresh trigger) → **`references/compound-workflow.md`**。

### Integration with mstar lifecycle

Compound 是**被生命周期流程调用**的知识结晶流程：本 SKILL 只拥有**执行步骤**（下方 + `references/compound-workflow.md`）；**触发时机、cwd、写入面与结果记录面由调用方流程声明**。本 SKILL **不复述调用方细节，也不维护调用方清单** —— 调用方各自指向本技能的步骤文件。

`iteration-start → [plan lifecycle × N] → iteration-close → mstar-knowledge (Capture) → {KNOWLEDGE_DIR} → feeds next iteration's specify/plan`。per-plan `Done` **不是**触发点：迭代内 plan 行不各自运行（迭代整体收口时一次），独立交付 plan 走其交付尾段 disposition，**不强制新文档**（reasoned `skipped` 有效）。

### Iteration package promotion（package 盘点方法）

调用方声明需要盘点迭代 package 时，compound 的盘点方法如下。

**路径**：`{ITERATION_DIR}/<iteration-id>/**`（含 `guides/`、`specs/`、扁平 `.md`；**默认排除** `delivery-compass.md` 除非 PM 显式纳入。Legacy 根目录 `*-delivery-compass.md` 同理排除）。

| 步骤 | 动作 |
|------|------|
| 1. Inventory | 列出 package 下全部 `.md`（除默认排除 compass）；读各文件 + package `README.md`（若有） |
| 2. Triage | 每篇：**Promote** / **Keep snapshot** / **Skip**（理由写入 compound 摘要） |
| 3. Promote | 值得跨迭代复用 → 走 Q1–Q8（或轻量判定）→ Phase 2 重叠检测 → Phase 3–6 **结构化重写**进 `{KNOWLEDGE_DIR}/`（**禁止**无改写整文件复制） |
| 4. Trace | 源文件顶栏或 package README：`Promoted to: <knowledge-path>`；provenance 记在 catalog 关系（`mstar catalog link`，关系取 `derived-from`），**不**在 README 表格加列 |
| 5. Summary | 记录本轮提升篇数、保留快照、跳过及原因（记录面由调用方承载） |

**Promote 典型**：迭代 spec 已验证且指导未来实现；guide 含非显而易见过程知识或失败尝试。**Keep snapshot**：仅迭代史、已被 `{SPECS_DIR}/` 取代的草案、或自检 ≤2 Yes 的琐碎笔记。边界 SSOT → **`mstar-iteration/references/iteration-artifact-boundaries.md`**。

### 是否值得结晶（自检门禁）

调用本 skill 前，PM（或触发方）**必须**对候选问题逐条自检 Q1–Q8（诊断耗时 / 非显而易见性 / 可复用性 / 项目特异性 / 既有重叠 / 架构影响 / 失败尝试价值 / 跨模块）。完整问题表、决策矩阵（Yes≥4 强烈建议；Yes=3 Lightweight；Yes≤2 跳过；Q5=Yes 高重叠不新建）与示例判定 → **`references/compound-workflow.md`**「是否值得结晶」。

**快判**：Q5 高重叠 → 更新已有文档，**不新建**；其余按决策矩阵 Yes 数。

### Two tracks

| Track | What it captures |
|-------|-----------------|
| **Bug** | Incident-level fix — "X broke, here's why and how we fixed it" |
| **Knowledge** | Durable guidance — "this is how we do X, and why" |

Track 由 `problem_type` 决定（完整映射 → **`mstar-doc-corpus`** `references/category-mapping.md`）。每轨的正文小节结构在 **`mstar-doc-corpus`** `assets/knowledge-skeleton.md`；本 skill 只决定写哪一轨，不复述小节清单。

### Execution modes

| Mode | When | Behavior |
|------|------|----------|
| **Full** (default) | Most cases | Dispatches research subagents for context analysis, solution extraction, overlap detection |
| **Lightweight** | Simple fixes, context-tight sessions | Single-pass documentation, no subagents, faster |

Full mode dispatches research subagents through the host's task tool. PM selects mode.

### Workflow skeleton（Phase 1–7）

完整步骤细节（Gather context / Overlap detection / Write document 含 frontmatter schema + path + validate / Discoverability check / CONCEPTS.md synergy / Catalog registration / Refresh trigger）→ **`references/compound-workflow.md`**。每 Phase 一个关键决策：

1. **Gather** — 读对话史 + iteration package；分类 track/category（**`mstar-doc-corpus`** `references/category-mapping.md`）
2. **Overlap** — 高重叠 → 更新已有（加 `last_updated`）；中度 → 新建并标 consolidation review；低/无 → 正常新建
3. **Write** — path + frontmatter（SSOT **`mstar-doc-corpus`** `references/schema.yaml`）+ body（**`mstar-doc-corpus`** `assets/knowledge-skeleton.md`）+ YAML validate
4. **Discoverability** — 若 root `AGENTS.md`/`CLAUDE.md` 未提 `{KNOWLEDGE_DIR}`，提议最小补充（需用户同意；拒绝则仅跳过该编辑，doc 仍写）
5. **CONCEPTS.md** — 项目特定领域词满足 qualifying bar 时提议入 `CONCEPTS.md`（规则见 `references/concepts-vocabulary.md`）；全仓 bootstrap 归本 skill `## Workflow — Maintain`
6. **Catalog（仅 harness store active 时）** — 新文档在 `{HARNESS_DIR}/store.db` 的 catalog 中登记为 `kind=document`（`document_kind=knowledge`）：单行 `mstar catalog register`，或 reviewed `mstar catalog discover` + `mstar catalog import`；provenance/supersession 用 `mstar catalog link`（`derived-from` / `supersedes` 关系）；生命周期变更用 `mstar catalog update`（`active` / `archived` / `superseded`；revision 守卫见 help）。**不再**要求 `{KNOWLEDGE_DIR}/README.md` 索引行（README 是散文，不是登记表）。知识关联载体是 catalog relations（`mstar catalog link`）；snapshot `plans[].metadata.knowledge_refs` 仅 legacy 只读，不是写入面。**无 active store 时跳过本 Phase**（文档集自身即登记），并在结果记录 `catalog: n/a (no store)`；store 存在但未激活/未初始化不是跳过理由——按拒绝码报告
7. **Refresh trigger** — 新知识暗示旧 doc 过时 → 推荐本 skill 的 `## Workflow — Maintain`（经 `/pm` 并指明 scope；不自动跑，仅 flag）

> **Engine check:** run `mstar compound validate <doc-path> [--knowledge-dir <dir>]` (engine `validateSchemaYaml`, `assertKnowledgeCatalogCompleteness`) to validate the frontmatter against `mstar-doc-corpus` `references/schema.yaml` (Phase 3 Write); the `--knowledge-dir` branch additionally asserts that every knowledge body under `{KNOWLEDGE_DIR}` has a catalog row (Phase 6 Catalog, contract §4) and therefore applies only when the harness store is active. The `assertIndexRows` export refuses actionably (`compound.index.retired`) instead of passing, and the `mstar compound validate --knowledge-dir` index-row check fails for the same reason. On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.

## Workflow — Maintain

**Stock workflow**: existing `{KNOWLEDGE_DIR}` documents show staleness signals, and the store is audited against the current codebase until it is trustworthy again.

### 产物与操作路径

**SSOT**: `mstar-conventions/references/artifact-storage-paths.md`。本 skill 仅操作 `{HARNESS_DIR}/knowledge/**/*.md` + `{HARNESS_DIR}/knowledge/README.md`（**散文**，见 Phase 4）+ `<repo-root>/CONCEPTS.md`；知识关联经 catalog relations（`mstar catalog link`，仅 active store 时），不写 status/snapshot metadata。**禁止**操作 `docs/`、`{PLAN_DIR}/`、`{ITERATION_DIR}/`、`{SPECS_DIR}/`。

> **Engine check:** run `mstar compound validate <doc-path> --knowledge-dir <dir>` (engine `scopeGuard`, `compoundRefreshScope`) to resolve the allowed scope above (`{HARNESS_DIR}/knowledge/**`, `knowledge/README.md`, `<repo-root>/CONCEPTS.md`) and guard every write against it; this scope never authorizes ACTIVE status/snapshot writes. The same command's catalog-completeness branch needs an active harness store, so a storeless maintenance run uses scope resolution alone. On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.

### Bootstrap vs refresh

| Mode | When | Procedure |
|------|------|-----------|
| **Refresh** | `{KNOWLEDGE_DIR}` exists; audit accuracy, merge overlaps, delete stale docs | This skill `## Workflow — Maintain` (Phases 1–6) |
| **Bootstrap** | No knowledge scaffolding, or artifacts are absent/stale enough to warrant full distillation from codebase | **`references/project-knowledge-bootstrap.md`** (7-phase: survey → STRATEGY.md → CONCEPTS.md → baseline knowledge → indexing → harness init → commit) |

Read the bootstrap reference on demand; do not paste its body into this SKILL.md.

### Maintenance outcomes

For each candidate document, classify into one of five outcomes:

| Outcome | Meaning | Default action |
|---------|---------|----------------|
| **Keep** | Still accurate and useful | No edit; report reviewed |
| **Update** | Core solution correct, references drifted | In-place edits (paths, module names, code snippets) |
| **Consolidate** | Two+ docs overlap heavily, both correct | Merge unique content into canonical doc, delete subsumed |
| **Replace** | Old doc is misleading; known better replacement exists | Create trustworthy successor, then delete old |
| **Delete** | No longer useful, applicable, or distinct | Delete — git history preserves it |

**Future-decision-value criterion** — judge a document by the decision it still constrains, never by length or age: **delete** when that decision is closed and nothing in the body would guide a future change (git history preserves it, Core rule 6); **keep** when its rationale, negative guarantee or ownership boundary still constrains work, however long it is; **archive** only when the historical rationale warrants preservation, and only through the iteration-start §1.6 gate's existing archive tree. **Never archive a live proposal**; keep a rejected approach only while the losing idea remains a tempting mistake.

**Calibration:** 9 size-divergent docs (36–78 lines) under `{KNOWLEDGE_DIR}/architecture-patterns/` were all kept by future value; length proved not to be a criterion.

### Scope selection

**Default: user-guided**

1. Ask PM for scope: "All knowledge docs, a specific category, or a keyword?"
2. If category: narrow to `{KNOWLEDGE_DIR}/<category>/`.
3. If keyword: search frontmatter (`module:`, `tags:`, `problem_type:`) and filenames.

**PM-directed: specific scope**

PM provides a scope hint (directory name, filename, module name, or keyword). Match in this order:
1. Directory match under `{KNOWLEDGE_DIR}/`
2. Frontmatter field match
3. Filename match
4. Content search

### Process

Inventory → assess → classify/act → catalog reconcile（仅 active store；无 store 记 `catalog: n/a (no store)`）→ report → CONCEPTS.md reconciliation. Full Phase 1–6 procedure → **`references/maintain-workflow.md`**. CONCEPTS admission rules for Phase 6 → `references/concepts-vocabulary.md`.


## Decision Rules

### Core rules

1. **Evidence over opinion.** Signals are inputs, not a scorecard. Use engineering judgment.
2. **Prefer no-write Keep.** Do not update a doc just to leave a review breadcrumb.
3. **Match docs to reality.** When code differs from doc, update the doc — not ask whether the code change was "intentional."
4. **Be decisive.** When evidence is clear (file renamed, class moved), apply. Only ask PM when genuinely ambiguous.
5. **Avoid low-value churn.** Don't edit for typos, polish, or cosmetic changes that don't improve accuracy.
6. **Delete, don't archive** — **except** formal **iteration-start** §1.6 corpus hygiene (`mstar-iteration/references/iteration-corpus-hygiene.md`), which **moves** superseded/redundant knowledge/specs to `{HARNESS_DIR}/archived/knowledge|specs/`. Outside that gate, git history is the archive; `git log --diff-filter=D -- <path>` finds deleted docs. Durable decision *reason* — why an alternative lost, or what a choice cost — has its home in the ADR tree (`{ADR_DIR}`), not in a kept knowledge doc.
   > **Not adopted:** frozen-archive seal machinery, `Archived:` triplets, or a verifier — they contradict rule 6 (delete, don't archive; git history is the archive); do not reintroduce.
7. **Evaluate document-set design.** Check whether two+ docs overlap and should be consolidated. Redundant docs silently drift apart.

### Never

- Do not create a doc for trivial fixes (typos, formatting, dep bumps)
- Do not write the doc before the solution is verified
- Do not skip the overlap check — creating duplicates degrades the knowledge store
- Do not edit AGENTS.md without user consent
- Do not create CONCEPTS.md entries for general programming vocabulary
- Do not modify product code — this skill writes documentation only
- Do not delete docs without checking for inbound links
- Do not "archive" — delete instead
- Do not ask PM about mechanical updates (path fixes, renamed modules)
- Do not change code to match outdated docs — update docs to match code
- Do not run without PM approval for destructive actions (Delete, Replace)

## Evidence

**Capture** — 正确结果 = 一篇**可发现**的结晶文档：`{KNOWLEDGE_DIR}/<category>/<slug>.md` 通过 **`mstar-doc-corpus`** `references/schema.yaml` frontmatter 校验（Phase 3 Write）+ 达标领域词入 `CONCEPTS.md`（Phase 5）+ 源文件 / package README 标注 `Promoted to: <knowledge-path>`（Phase 4 Trace）+ catalog 登记为 `kind=document`（`document_kind=knowledge`，Phase 6 Catalog；`mstar catalog list` 可查到）——**仅当 harness store active**；无 store 时该义务不适用，结果记 `catalog: n/a (no store)`。

**Maintain** — 正确结果 = 每篇候选文档有明确 verdict（Keep / Update / Consolidate / Replace / Delete）并落到产物：文档改动 + 维护报告（Phase 5：reviewed / kept / updated / consolidated / replaced / deleted / flagged）+ `CONCEPTS.md` 对账（Phase 6）+ catalog 行对账（Phase 4：`mstar catalog update` / `register`，生命周期 `active` / `archived` / `superseded`）与 catalog relations 知识关联（`mstar catalog link`；status/snapshot `knowledge_refs` 仅 legacy 只读）——**仅当 harness store active**；无 store 时文档改动与报告即为完整证据，结果记 `catalog: n/a (no store)`。

## References

| 何时 | 打开 |
|------|------|
| Capture 步骤细节（Q1–Q8 完整表、决策矩阵、Phase 1–7、HEAD-resolvability 质量门与 mstar 泄漏分类） | `references/compound-workflow.md` |
| 知识文档形状（唯一 SSOT：frontmatter 字段、两轨骨架、`problem_type` → `<category>`） | **`mstar-doc-corpus`** → `references/knowledge-format.md`（索引）、`references/schema.yaml`（字段）、`assets/knowledge-skeleton.md`（正文骨架）、`references/category-mapping.md`（目录映射） |
| CONCEPTS.md 准入规则（Capture Phase 5、Maintain Phase 6） | `references/concepts-vocabulary.md` |
| Maintain Phase 1–6 详细步骤 | `references/maintain-workflow.md` |
| 项目知识 bootstrap（absent/stale `STRATEGY.md` / `CONCEPTS.md` / `{KNOWLEDGE_DIR}`），on demand | `references/project-knowledge-bootstrap.md` |

- **`mstar-conventions`** — path symbols（`{KNOWLEDGE_DIR}`、`{HARNESS_DIR}`）与产物存储 SSOT（`references/artifact-storage-paths.md`）
- **`mstar-artifacts`** — store.db catalog 登记与生命周期（snapshot 为迁移源；project register 仅迁移历史）
