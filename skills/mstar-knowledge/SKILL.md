---
name: mstar-knowledge
description: Knowledge capture and maintenance for {KNOWLEDGE_DIR}：把已解决问题沉淀为结构化知识文档（双轨 Bug/Knowledge、重叠与可发现性检查、迭代收口提升），并审查/更新/合并/清理既有文档与 CONCEPTS.md 基线 bootstrap。触发：迭代收口结晶、值得沉淀的已解决问题、可合并/stale/需清理的知识文档、显式 bootstrap/refresh。无结晶时以 reasoned skipped 结束。
---

# mstar-knowledge（知识结晶与维护）

## Load order

**Read `mstar-harness-core` first.** Path symbols (`{KNOWLEDGE_DIR}`, `{HARNESS_DIR}`) → **`mstar-conventions`**. On conflict, **`mstar-harness-core` wins**.

## Purpose

One artifact family (`{KNOWLEDGE_DIR}` 文档 + `<repo-root>/CONCEPTS.md`), one field table (`references/schema.yaml`), two workflows: **Capture** 把已解决的问题沉淀为结构化知识文档，供未来的 plan 研究、debug 与实现检索复用；**Maintain** 让既有文档对抗代码漂移重新可信。Knowledge that isn't captured evaporates when the session ends; knowledge that is captured but not discoverable is equally lost; documents that are captured also age — code changes, conventions evolve, patterns become obsolete — so capture and maintenance are one skill over one artifact.

**In the mstar lifecycle**, Capture is invoked by lifecycle flows — the iteration-close round or a standalone-development delivery tail — sharing one step sequence (see「Integration with mstar lifecycle」). It is never triggered at per-plan `Done`, and stays invocable standalone for ad-hoc captures. Maintain runs only from its own entries (`## When to use / Skip`), which include the Capture Phase 7 flag and the on-demand project-knowledge bootstrap.

**Storage SSOT**: `mstar-conventions/references/artifact-storage-paths.md`。本 skill 不重定义路径：知识文档 → `{HARNESS_DIR}/knowledge/<category>/<slug>.md`（`<category>` 取值见 `references/category-mapping.md`）；CONCEPTS.md → `<repo-root>/CONCEPTS.md`；Maintain 另可操作 `{HARNESS_DIR}/knowledge/README.md`（**散文**，见 Maintain Phase 4）。

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

| Track | What it captures | Section structure |
|-------|-----------------|-------------------|
| **Bug** | Incident-level fix — "X broke, here's why and how we fixed it" | Problem, Symptoms, What Didn't Work, Solution, Why This Works, Prevention |
| **Knowledge** | Durable guidance — "this is how we do X, and why" | Context, Guidance, Why This Matters, When to Apply, Examples |

Track 由 `problem_type` 决定，完整映射见 `references/category-mapping.md`。

### Execution modes

| Mode | When | Behavior |
|------|------|----------|
| **Full** (default) | Most cases | Dispatches research subagents for context analysis, solution extraction, overlap detection |
| **Lightweight** | Simple fixes, context-tight sessions | Single-pass documentation, no subagents, faster |

Full mode dispatches research subagents through the host's task tool. PM selects mode.

### Workflow skeleton（Phase 1–7）

完整步骤细节（Gather context / Overlap detection / Write document 含 frontmatter schema + path + validate / Discoverability check / CONCEPTS.md synergy / Catalog registration / Refresh trigger）→ **`references/compound-workflow.md`**。每 Phase 一个关键决策：

1. **Gather** — 读对话史 + iteration package；分类 track/category（`references/category-mapping.md`）
2. **Overlap** — 高重叠 → 更新已有（加 `last_updated`）；中度 → 新建并标 consolidation review；低/无 → 正常新建
3. **Write** — path + frontmatter（SSOT `references/schema.yaml`）+ body（`assets/resolution-template.md`）+ YAML validate
4. **Discoverability** — 若 root `AGENTS.md`/`CLAUDE.md` 未提 `{KNOWLEDGE_DIR}`，提议最小补充（需用户同意；拒绝则仅跳过该编辑，doc 仍写）
5. **CONCEPTS.md** — 项目特定领域词满足 qualifying bar 时提议入 `CONCEPTS.md`（规则见 `references/concepts-vocabulary.md`）；全仓 bootstrap 归本 skill `## Workflow — Maintain`
6. **Catalog** — 新文档在 `{HARNESS_DIR}/store.db` 的 catalog 中登记为 `kind=document`（`document_kind=knowledge`）：单行 `mstar catalog register`，或 reviewed `mstar catalog discover` + `mstar catalog import`；provenance/supersession 用 `mstar catalog link`（`derived-from` / `supersedes` 关系）；生命周期变更用 `mstar catalog update`（`active` / `archived` / `superseded`；revision 守卫见 help）。**不再**要求 `{KNOWLEDGE_DIR}/README.md` 索引行（README 是散文，不是登记表）。知识关联载体是 catalog relations（`mstar catalog link`）；snapshot `plans[].metadata.knowledge_refs` 仅 legacy 只读，不是写入面。每篇新 doc 必须完成本 Phase
7. **Refresh trigger** — 新知识暗示旧 doc 过时 → 推荐本 skill 的 `## Workflow — Maintain`（经 `/pm` 并指明 scope；不自动跑，仅 flag）

> **Engine check:** run `mstar compound validate <doc-path> [--knowledge-dir <dir>]` (engine `validateSchemaYaml`, `assertKnowledgeCatalogCompleteness`) to validate the frontmatter against `references/schema.yaml` (Phase 3 Write) and assert that every knowledge body under `{KNOWLEDGE_DIR}` has a catalog row (Phase 6 Catalog, contract §4). The `assertIndexRows` export refuses actionably (`compound.index.retired`) instead of passing, and the `mstar compound validate --knowledge-dir` index-row check fails for the same reason. On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.

## Workflow — Maintain

**Stock workflow**: existing `{KNOWLEDGE_DIR}` documents show staleness signals, and the store is audited against the current codebase until it is trustworthy again.

### 产物与操作路径

**SSOT**: `mstar-conventions/references/artifact-storage-paths.md`。本 skill 仅操作 `{HARNESS_DIR}/knowledge/**/*.md` + `{HARNESS_DIR}/knowledge/README.md`（**散文**，见 Phase 4）+ `<repo-root>/CONCEPTS.md`；知识关联经 `mstar catalog link`，不写 status/snapshot metadata。**禁止**操作 `docs/`、`{PLAN_DIR}/`、`{ITERATION_DIR}/`、`{SPECS_DIR}/`。

> **Engine check:** run `mstar compound validate <doc-path> --knowledge-dir <dir>` (engine `scopeGuard`, `compoundRefreshScope`) to resolve the allowed scope above (`{HARNESS_DIR}/knowledge/**`, `knowledge/README.md`, `<repo-root>/CONCEPTS.md`) and guard every write against it; this scope never authorizes ACTIVE status/snapshot writes. On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.

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

> **Guardrail — rejected approaches:** a captured rejected approach stays only while the losing idea remains a tempting, meaningful mistake; delete it once obsolete or no longer plausible.
> **Calibration:** first real run of this axis — 9 size-divergent knowledge docs (36–78 lines) under `{KNOWLEDGE_DIR}/architecture-patterns/` classified at fold time, all kept by future value (evidence: the knowledge-prose-folds plan `## Review Gate Summary` → Task evidence); length proved not to be a criterion.

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

#### Phase 1: Inventory

1. List all `.md` files under `{KNOWLEDGE_DIR}/` (excluding `README.md` and index files).
2. Read frontmatter of each candidate.
3. Group by `category` / `module` for impact clustering.

#### Phase 2: Assess per doc

For each doc, check:

1. **Referenced code still exists?** — grep for file paths, class names, function names mentioned.
2. **Referenced conventions still match?** — check against current `AGENTS.md`, `CONCEPTS.md`, lint configs.
3. **Solution still the recommended approach?** — has a newer pattern superseded it?
4. **Overlap with other docs?** — search for same module/tags to find duplicates.
5. **Future decision value?** — rationale / alternatives considered / negative guarantees / reintroduction conditions that would still guide a future change → **Keep, regardless of length**. A completed decision whose body has no future leverage left (one-off fix detail, superseded mechanics) enters the Delete candidate pool. Word count and age remain discovery aids, never criteria.

#### Phase 3: Classify and act

Classify each doc → Keep / Update / Consolidate / Replace / Delete. Apply changes.

#### Phase 4: Reconcile the catalog

1. For every doc whose verdict changed its metadata or lifecycle (`Update` / `Consolidate` / `Replace` / `Delete`), update its catalog row: `mstar catalog update` for title/description/path/source hash and for the catalog lifecycle (`active` / `archived` / `superseded`), and `mstar catalog link` for provenance/supersession relations (identity is never patched; the revision guard is in `--help`). A doc deleted outside the iteration-start §1.6 archive gate leaves git history as its record — set/keep its catalog lifecycle so the row is not a silent dangling claim.
2. A knowledge body with **no** catalog row is a completeness gap, not a pass: register it (`mstar catalog register`, or reviewed `mstar catalog discover` + `mstar catalog import`) or report it. `{KNOWLEDGE_DIR}/README.md` index tables are **not** maintained as a register — README is prose.
3. The knowledge-association carrier is catalog relations (`mstar catalog link`). Snapshot `plans[].metadata.knowledge_refs` and root status knowledge metadata are legacy read-only, not write targets.

#### Phase 5: Report

Produce a maintenance report:
- Docs reviewed (count)
- Docs kept (count)
- Docs updated (list with what changed)
- Docs consolidated (list with which canonical doc merged into)
- Docs replaced (list with successor path)
- Docs deleted (list with reason)
- Docs flagged for PM review (ambiguous cases)

#### Phase 6: CONCEPTS.md reconciliation

If `CONCEPTS.md` exists, reconcile it with the refreshed knowledge:
- Terms mentioned in updated/replaced docs may need updating in CONCEPTS.md
- Terms no longer referenced may be candidates for removal

If `CONCEPTS.md` doesn't exist but knowledge docs contain qualifying domain terms, propose bootstrapping it (full repo-wide seed). Read `references/concepts-vocabulary.md` (same skill directory) before Phase 6 for the rules.

## Decision Rules

### Core rules

1. **Evidence over opinion.** Signals are inputs, not a scorecard. Use engineering judgment.
2. **Prefer no-write Keep.** Do not update a doc just to leave a review breadcrumb.
3. **Match docs to reality.** When code differs from doc, update the doc — not ask whether the code change was "intentional."
4. **Be decisive.** When evidence is clear (file renamed, class moved), apply. Only ask PM when genuinely ambiguous.
5. **Avoid low-value churn.** Don't edit for typos, polish, or cosmetic changes that don't improve accuracy.
6. **Delete, don't archive** — **except** formal **iteration-start** §1.6 corpus hygiene (`mstar-iteration/references/iteration-corpus-hygiene.md`), which **moves** superseded/redundant knowledge/specs to `{HARNESS_DIR}/archived/knowledge|specs/`. Outside that gate, git history is the archive; `git log --diff-filter=D -- <path>` finds deleted docs. Durable decision *reason* — why an alternative lost, or what a choice cost — has its home in the ADR tree (`docs/adr/`), not in a kept knowledge doc.
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

**Capture** — 正确结果 = 一篇**可发现**的结晶文档：`{KNOWLEDGE_DIR}/<category>/<slug>.md` 通过 `references/schema.yaml` frontmatter 校验（Phase 3 Write）+ catalog 登记为 `kind=document`（`document_kind=knowledge`，Phase 6 Catalog；`mstar catalog list` 可查到）+ 达标领域词入 `CONCEPTS.md`（Phase 5）+ 源文件 / package README 标注 `Promoted to: <knowledge-path>`（Phase 4 Trace）。

**Maintain** — 正确结果 = 每篇候选文档有明确 verdict（Keep / Update / Consolidate / Replace / Delete）并落到产物：文档改动 + catalog 行对账（Phase 4：`mstar catalog update` / `register`，生命周期 `active` / `archived` / `superseded`）+ catalog relations 知识关联（`mstar catalog link`；status/snapshot `knowledge_refs` 仅 legacy 只读）+ 维护报告（Phase 5：reviewed / kept / updated / consolidated / replaced / deleted / flagged）+ `CONCEPTS.md` 对账（Phase 6）。

## References

| 何时 | 打开 |
|------|------|
| Capture 步骤细节（Q1–Q8 完整表、决策矩阵、Phase 1–7、HEAD-resolvability 质量门与 mstar 泄漏分类） | `references/compound-workflow.md` |
| frontmatter 字段表（唯一 SSOT；本 skill 内没有第二处枚举） | `references/schema.yaml` |
| `problem_type` → `<category>` 目录映射 | `references/category-mapping.md` |
| CONCEPTS.md 准入规则（Capture Phase 5、Maintain Phase 6） | `references/concepts-vocabulary.md` |
| track 正文骨架 | `assets/resolution-template.md` |
| 项目知识 bootstrap（absent/stale `STRATEGY.md` / `CONCEPTS.md` / `{KNOWLEDGE_DIR}`），on demand | `references/project-knowledge-bootstrap.md` |

- **`mstar-conventions`** — path symbols（`{KNOWLEDGE_DIR}`、`{HARNESS_DIR}`）与产物存储 SSOT（`references/artifact-storage-paths.md`）
- **`mstar-artifacts`** — store.db catalog 登记与生命周期（snapshot 为迁移源；project register 仅迁移历史）
