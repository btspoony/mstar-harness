# Iteration corpus hygiene（writing-specialist · §1.6）

> **When**: Phase 1 §1.6 — mandatory **writing-specialist**, after PM drafts and any selected product/architect edits have landed. If a specialist round reopens, writer closes the revised corpus again.
> **Boundaries**: `iteration-artifact-boundaries.md` — no new knowledge at start; prototypes remain design context under `prototypes/`, formal iteration drafts under `guides/` or `specs/`.

## Scope

| | Path | Notes |
|--|------|-------|
| **Primary** | `{ITERATION_DIR}/<iteration-id>/**` | Only this round's affected prototypes/guides/specs, compass/plan links, draft-vs-locked status and current design baseline |
| **Existing only** | Directly related `{KNOWLEDGE_DIR}/` references | Archive / misplaced correction as needed — no new knowledge or whole-corpus scan |
| **Out of scope** | `{SPECS_DIR}/**` writes | 全局 specs 在 **Phase 3 iteration-close** 提升时写入 |
| **Out of scope** | New `{KNOWLEDGE_DIR}/` writes | → **`mstar-compound`** @ iteration-close |

## Placement corrections

| Found in | Misplaced as | Move to |
|----------|--------------|---------|
| `{SPECS_DIR}/` | 迭代期草案等历史误入文件 | 登记到 package `README.md`（`Promotion candidate:`），Phase 3 提升流程统一处置 |
| Package `specs/` or `{KNOWLEDGE_DIR}/` | Prototype/feedback mislabeled as a spec or implementation knowledge | `<iteration-id>/prototypes/`; restore design-context links |
| `{KNOWLEDGE_DIR}/` | New exploration from start chain → `<iteration-id>/guides/` or archive |
| Flat `{ITERATION_DIR}/*-working-guide.md`（legacy） | → `<iteration-id>/guides/` |
| Flat `{ITERATION_DIR}/*-delivery-compass.md`（legacy） | Prefer migrate to `<iteration-id>/delivery-compass.md` when touching that iteration |

## Cross-links after edits

1. Check that compass and affected plans point to the retained prototype revision and genuine confirmation/autonomous disposition, and that formal criteria/constraints do not contradict it. Material design changes return to `phase-1-prepare.md` §1.2.5; stale approval cannot close the corpus.
2. Apply existing catalog/metadata rules; README files are optional prose, not required registration tables (`mstar-conventions` § Catalog fields / Markdown index retirement). Prototype traceability uses existing `iteration_refs`; never `primary_spec`/`spec_refs`.
3. Check all §1.3 markers and Open Questions, not only writing-owned ones. An omitted specialist's product/technical gap returns to PM for re-selection, never silent deletion or reassignment to evade a round. §1.6 owns reporting and lock criteria.

## Done signals

- Package prototype retained separately from specs, with current revision/disposition and aligned compass/plan links
- Package specs hygiene complete (`<iteration-id>/specs/` draft vs locked clear); no specialist markers or blocking questions at lock
- Misplaced material corrected under the existing package/knowledge boundaries
- No new `{KNOWLEDGE_DIR}/` documents from this chain

## Close vs start

| Tree | Start (§1.6) | Close (§3.2 compound + specs 提升） |
|------|--------------|------------------------|
| `{SPECS_DIR}/` | Git-tracked shared specs；写入发生在 close 提升 | **specs 提升**写入 |
| `{ITERATION_DIR}/<id>/` | Create/edit drafts（specs 在 `<id>/specs/`） | **Inventory → promote** to `{KNOWLEDGE_DIR}/` |
| `{KNOWLEDGE_DIR}/` | Hygiene / archive only | **Primary write path** |
