---
name: mstar-compound-refresh
description: Morning Star 知识维护与项目知识 bootstrap —— 审查 `{KNOWLEDGE_DIR}` 文档是否仍准确、去重叠合并、清理过期知识；或从代码库提炼 STRATEGY.md、CONCEPTS.md、基线 knowledge 脚手架（无/残旧/空白 knowledge）。触发：`mstar-compound` 发现可合并文档、定期维护、项目缺 STRATEGY.md/CONCEPTS.md/{KNOWLEDGE_DIR}、stale knowledge scaffolding、显式 bootstrap 请求、或显式 refresh。产出：更新/合并/删除知识文档 + 维护报告；或 bootstrap 产物（STRATEGY.md、CONCEPTS.md、基线 knowledge）。
---

# mstar-compound-refresh（知识维护）

## Load order

**Read `mstar-harness-core` first.** Path symbols → **`mstar-plan-conventions`**. On conflict, **`mstar-harness-core` wins**.

## Purpose

Knowledge documents in `{KNOWLEDGE_DIR}` age. Code changes, conventions evolve, patterns become obsolete. `mstar-compound-refresh` audits the knowledge store against the current codebase and makes it trustworthy again.

## 产物与操作路径

**SSOT**: `mstar-plan-conventions/references/artifact-storage-paths.md`。本 skill 仅操作 `{HARNESS_DIR}/knowledge/**/*.md` + `{HARNESS_DIR}/knowledge/README.md` + `<repo-root>/CONCEPTS.md` + `{HARNESS_DIR}/status.json`（引用更新）。**禁止**操作 `docs/`、`{PLAN_DIR}/`、`{ITERATION_DIR}/`、`{SPECS_DIR}/`。

## When to use

| Trigger | Example |
|---------|---------|
| `mstar-compound` detected overlapping docs | "Two docs cover N+1 queries — consider refresh" |
| Scheduled maintenance | "It's been a quarter, let's audit knowledge" |
| Domain refactored | After a major module rewrite |
| Explicit user request | `/pm compound-refresh performance-issues` |
| **Project knowledge bootstrap** | No/stale/partial `STRATEGY.md`, `CONCEPTS.md`, or `{KNOWLEDGE_DIR}` — see below |

## Bootstrap vs refresh

| Mode | When | Procedure |
|------|------|-----------|
| **Refresh** | `{KNOWLEDGE_DIR}` exists; audit accuracy, merge overlaps, delete stale docs | This skill § Process (Phases 1–6) |
| **Bootstrap** | No knowledge scaffolding, or artifacts are absent/stale enough to warrant full distillation from codebase | **`references/project-knowledge-bootstrap.md`** (7-phase: survey → STRATEGY.md → CONCEPTS.md → baseline knowledge → indexing → harness init → commit) |

Read the bootstrap reference on demand; do not paste its body into this SKILL.md.

## Maintenance outcomes

For each candidate document, classify into one of five outcomes:

| Outcome | Meaning | Default action |
|---------|---------|----------------|
| **Keep** | Still accurate and useful | No edit; report reviewed |
| **Update** | Core solution correct, references drifted | In-place edits (paths, module names, code snippets) |
| **Consolidate** | Two+ docs overlap heavily, both correct | Merge unique content into canonical doc, delete subsumed |
| **Replace** | Old doc is misleading; known better replacement exists | Create trustworthy successor, then delete old |
| **Delete** | No longer useful, applicable, or distinct | Delete — git history preserves it |

## Core rules

1. **Evidence over opinion.** Signals are inputs, not a scorecard. Use engineering judgment.
2. **Prefer no-write Keep.** Do not update a doc just to leave a review breadcrumb.
3. **Match docs to reality.** When code differs from doc, update the doc — not ask whether the code change was "intentional."
4. **Be decisive.** When evidence is clear (file renamed, class moved), apply. Only ask PM when genuinely ambiguous.
5. **Avoid low-value churn.** Don't edit for typos, polish, or cosmetic changes that don't improve accuracy.
6. **Delete, don't archive** — **except** formal **iteration-start** §1.6 corpus hygiene (`mstar-iteration/references/iteration-corpus-hygiene.md`), which **moves** superseded/redundant knowledge/specs to `{HARNESS_DIR}/archived/knowledge|specs/`. Outside that gate, git history is the archive; `git log --diff-filter=D -- <path>` finds deleted docs.
7. **Evaluate document-set design.** Check whether two+ docs overlap and should be consolidated. Redundant docs silently drift apart.

## Scope selection

### Default: user-guided

1. Ask PM for scope: "All knowledge docs, a specific category, or a keyword?"
2. If category: narrow to `{KNOWLEDGE_DIR}/<category>/`.
3. If keyword: search frontmatter (`module:`, `tags:`, `problem_type:`) and filenames.

### PM-directed: specific scope

PM provides a scope hint (directory name, filename, module name, or keyword). Match in this order:
1. Directory match under `{KNOWLEDGE_DIR}/`
2. Frontmatter field match
3. Filename match
4. Content search

## Process

### Phase 1: Inventory

1. List all `.md` files under `{KNOWLEDGE_DIR}/` (excluding `README.md` and index files).
2. Read frontmatter of each candidate.
3. Group by `category` / `module` for impact clustering.

### Phase 2: Assess per doc

For each doc, check:

1. **Referenced code still exists?** — grep for file paths, class names, function names mentioned.
2. **Referenced conventions still match?** — check against current `AGENTS.md`, `CONCEPTS.md`, lint configs.
3. **Solution still the recommended approach?** — has a newer pattern superseded it?
4. **Overlap with other docs?** — search for same module/tags to find duplicates.

### Phase 3: Classify and act

Classify each doc → Keep / Update / Consolidate / Replace / Delete. Apply changes.

### Phase 4: Update indexes

1. Update `{KNOWLEDGE_DIR}/README.md` index table — update Status column, add/remove rows.
2. If doc was linked from `status.json` metadata, update references.

### Phase 5: Report

Produce a maintenance report:
- Docs reviewed (count)
- Docs kept (count)
- Docs updated (list with what changed)
- Docs consolidated (list with which canonical doc merged into)
- Docs replaced (list with successor path)
- Docs deleted (list with reason)
- Docs flagged for PM review (ambiguous cases)

### Phase 6: CONCEPTS.md reconciliation

If `CONCEPTS.md` exists, reconcile it with the refreshed knowledge:
- Terms mentioned in updated/replaced docs may need updating in CONCEPTS.md
- Terms no longer referenced may be candidates for removal

If `CONCEPTS.md` doesn't exist but knowledge docs contain qualifying domain terms, propose bootstrapping it (full repo-wide seed). Use `references/concepts-vocabulary.md` from `mstar-compound` for rules (read on demand — cross-skill path resolution via skill directory).

## Cross-skill coordination

`mstar-compound-refresh` reads vocabulary rules from `mstar-compound`'s references. At runtime, resolve the path from the loaded skill directory:

```
The CONCEPTS.md vocabulary rules are in the mstar-compound skill at:
references/concepts-vocabulary.md
Read that file from the mstar-compound skill directory before Phase 6.
```

## NOT to do

- Do not delete docs without checking for inbound links
- Do not "archive" — delete instead
- Do not ask PM about mechanical updates (path fixes, renamed modules)
- Do not change code to match outdated docs — update docs to match code
- Do not run without PM approval for destructive actions (Delete, Replace)
