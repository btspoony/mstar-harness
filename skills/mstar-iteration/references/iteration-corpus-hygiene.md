# iteration-start corpus hygiene（specs primary · knowledge read-only）

> **When**: Phase 1 §1.6 — **writing-specialist** only, after product/architect landed compass / plans / `{SPECS_DIR}/` / **`{ITERATION_DIR}/<iteration-id>/`** workspace.
> **Boundaries**: **`iteration-artifact-boundaries.md`** — no `{KNOWLEDGE_DIR}/` adds @ start; iteration drafts → **`<iteration-id>/guides/`** or **`specs/`**.

## Scope (HARD)

| Priority | Tree | Action |
|----------|------|--------|
| **Primary** | `{SPECS_DIR}/**` | Full active corpus review |
| **Included** | `{ITERATION_DIR}/<iteration-id>/**` | Workspace guides/specs + compass cross-links |
| **Secondary** | `{KNOWLEDGE_DIR}/**` (existing) | Archive / relocate only — **no** new docs |
| **Included** | `{PLAN_DIR}/` plans touched this iteration | Spec refs, terminology |

**Out of scope**: compound promotion (iteration-close); per-plan review bundles (`{SDD_DIR}/review/`); code.

## Misplaced content (relocate)

| Found in | Target |
|----------|--------|
| `{SPECS_DIR}/` | Iteration-only draft → `{ITERATION_DIR}/<iteration-id>/specs/` or `guides/` |
| `{SPECS_DIR}/` | Implementation/debug notes → workspace `guides/` (compound @ close) |
| `{KNOWLEDGE_DIR}/` | New exploration from start chain → `<iteration-id>/guides/` or archive |
| Flat `{ITERATION_DIR}/*-working-guide.md` | OK as entry; or merge into `<iteration-id>/guides/` when workspace exists |

## Classification

Same as before for specs + existing knowledge: Active / Superseded / Redundant / Obsolete / Unclear → archive under `archived/specs/` or `archived/knowledge/` with relative path preserved.

## Index and metadata

1. `{SPECS_DIR}/README.md` — update as needed
2. `{KNOWLEDGE_DIR}/README.md` — archive rows only; no new iteration exploration rows
3. `{ITERATION_DIR}/README.md` — compass + **`<iteration-id>/` workspace** directory row
4. `{ITERATION_DIR}/<iteration-id>/README.md` — list guides/specs (create if non-trivial)
5. `plans[].metadata` — `primary_spec` / `spec_refs` → `{SPECS_DIR}/`; `iteration_refs` → workspace paths

## Evidence of done

- No iteration scratch left in `{SPECS_DIR}/`
- Workspace used for iteration-level drafts (`<iteration-id>/guides|specs/`)
- No new `{KNOWLEDGE_DIR}/` from §1.6 chain
- Completion Report lists workspace paths + spec hygiene moves

## Distinction from compound @ iteration-close

| | §1.6 hygiene | compound workspace promotion |
|--|--------------|------------------------------|
| When | iteration-start | iteration-close §3.2 |
| `{ITERATION_DIR}/<id>/` | Create/edit drafts | **Inventory → promote** to `{KNOWLEDGE_DIR}/` |
| `{KNOWLEDGE_DIR}/` | No new writes | Structured new docs |
