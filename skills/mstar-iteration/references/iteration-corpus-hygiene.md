# Iteration corpus hygiene（writing-specialist · §1.6）

> **When**: Phase 1 §1.6 — **writing-specialist** only, after product/architect landed compass / plans / `{SPECS_DIR}/` / **`{ITERATION_DIR}/<iteration-id>/`** package.
> **Boundaries**: **`iteration-artifact-boundaries.md`** — no `{KNOWLEDGE_DIR}/` adds @ start; iteration drafts → **`<iteration-id>/guides/`** or **`specs/`**.

## Scope

| | Path | Notes |
|--|------|-------|
| **Primary** | `{SPECS_DIR}/**` | Full-tree hygiene (lock vs draft, naming, index) |
| **Included** | `{ITERATION_DIR}/<iteration-id>/**` | Package guides/specs + compass cross-links |
| **Existing only** | `{KNOWLEDGE_DIR}/**` | Archive / misplaced correction — **no** new knowledge docs |
| **Out of scope** | New `{KNOWLEDGE_DIR}/` writes | → **`mstar-compound`** @ iteration-close |

## Placement corrections

| Found in | Misplaced as | Move to |
|----------|--------------|---------|
| `{SPECS_DIR}/` | Iteration-only draft → `{ITERATION_DIR}/<iteration-id>/specs/` or `guides/` |
| `{SPECS_DIR}/` | Implementation pitfall prose → package `guides/` or leave for compound |
| `{KNOWLEDGE_DIR}/` | New exploration from start chain → `<iteration-id>/guides/` or archive |
| Flat `{ITERATION_DIR}/*-working-guide.md`（legacy） | → `<iteration-id>/guides/` |
| Flat `{ITERATION_DIR}/*-delivery-compass.md`（legacy） | Prefer migrate to `<iteration-id>/delivery-compass.md` when touching that iteration |

## Index updates（after edits）

1. `{SPECS_DIR}/README.md`（若存在）— 规格索引
2. `{KNOWLEDGE_DIR}/README.md` — Status / archive only（无新增行来自 start 链）
3. `{ITERATION_DIR}/README.md` — **一行 = 一次迭代**（目录链接，非 compass+workspace 双行）
4. `{ITERATION_DIR}/<iteration-id>/README.md` — Documents 单表列出 guides/specs（非 trivial 时创建）

## Done signals

- Specs tree hygiene complete（draft vs locked clear）
- Package used for iteration-level drafts (`<iteration-id>/guides|specs/`)
- Misplaced knowledge / specs moved or archived with index Status updated
- No new `{KNOWLEDGE_DIR}/` documents from this chain

## Close vs start

| Tree | Start (§1.6) | Close (§3.2 compound） |
|------|--------------|------------------------|
| `{SPECS_DIR}/` | Hygiene + lock clarity | Usually unchanged |
| `{ITERATION_DIR}/<id>/` | Create/edit drafts | **Inventory → promote** to `{KNOWLEDGE_DIR}/` |
| `{KNOWLEDGE_DIR}/` | Hygiene / archive only | **Primary write path** |
