# Maintain workflow (Phases 1–6)

> **Load when:** running `Workflow — Maintain` after scope selection and outcome vocabulary are clear, or reconciling catalog/`CONCEPTS.md` after Keep/Update/Consolidate/Replace/Delete actions.

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
5. **Future decision value?** — the Maintain criterion above decides Keep versus the Delete candidate pool; apply it to the decision in the body, not to age or word count.

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
