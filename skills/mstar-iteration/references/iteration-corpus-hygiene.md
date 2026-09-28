# Iteration corpus hygiene（writing-specialist · §1.6）

> **When**: Phase 1 §1.6 — **writing-specialist** only, after product/architect landed compass / plans / **`{ITERATION_DIR}/<iteration-id>/`** package（specs 在 `<iteration-id>/specs/`）.
> **Boundaries**: **`iteration-artifact-boundaries.md`** — no `{KNOWLEDGE_DIR}/` adds @ start; iteration drafts → **`<iteration-id>/guides/`** or **`specs/`**.

## Scope

| | Path | Notes |
|--|------|-------|
| **Primary** | `{ITERATION_DIR}/<iteration-id>/**` | Package guides/specs hygiene (lock vs draft, naming, index) + compass cross-links |
| **Existing only** | `{KNOWLEDGE_DIR}/**` | Archive / misplaced correction — **no** new knowledge docs |
| **Out of scope** | `{SPECS_DIR}/**` writes | 全局 specs 在 **Phase 3 iteration-close** 提升时写入 |
| **Out of scope** | New `{KNOWLEDGE_DIR}/` writes | → **`mstar-compound`** @ iteration-close |

## Placement corrections

| Found in | Misplaced as | Move to |
|----------|--------------|---------|
| `{SPECS_DIR}/` | 迭代期草案等历史误入文件 | 登记到 package `README.md`（`Promotion candidate:`），Phase 3 提升流程统一处置 |
| `{KNOWLEDGE_DIR}/` | New exploration from start chain → `<iteration-id>/guides/` or archive |
| Flat `{ITERATION_DIR}/*-working-guide.md`（legacy） | → `<iteration-id>/guides/` |
| Flat `{ITERATION_DIR}/*-delivery-compass.md`（legacy） | Prefer migrate to `<iteration-id>/delivery-compass.md` when touching that iteration |

## Index updates（after edits）

1. `{ITERATION_DIR}/<iteration-id>/README.md` — package 索引（guides/specs 归属；非 trivial 时创建）
2. `{KNOWLEDGE_DIR}/README.md` — Status / archive only（无新增行来自 start 链）
3. `{ITERATION_DIR}/README.md` — **一行 = 一次迭代**（目录链接，非 compass+workspace 双行）

## Done signals

- Package specs hygiene complete（`<iteration-id>/specs/` draft vs locked clear）
- Package used for iteration-level drafts (`<iteration-id>/guides|specs/`)
- Misplaced knowledge moved or archived with index Status updated
- No new `{KNOWLEDGE_DIR}/` documents from this chain

## Close vs start

| Tree | Start (§1.6) | Close (§3.2 compound + specs 提升） |
|------|--------------|------------------------|
| `{SPECS_DIR}/` | Git-tracked shared specs；写入发生在 close 提升 | **specs 提升**写入 |
| `{ITERATION_DIR}/<id>/` | Create/edit drafts（specs 在 `<id>/specs/`） | **Inventory → promote** to `{KNOWLEDGE_DIR}/` |
| `{KNOWLEDGE_DIR}/` | Hygiene / archive only | **Primary write path** |
