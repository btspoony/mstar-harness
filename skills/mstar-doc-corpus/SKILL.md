---
name: mstar-doc-corpus
description: "Use for writing, auditing or maintaining the three-layer document corpus — `{KNOWLEDGE_DIR}` engineering knowledge, `{SPECS_DIR}` current-state specs and `{ADR_DIR}` decision records — covering layer boundaries, section skeletons, naming, lifecycle and the optional validator. No harness lifecycle or store is required."
---

# mstar-doc-corpus（三层文档语料契约）

One contract for three document layers: what each layer holds, the fixed shape of a document inside it, how documents are named, promoted, revised and retired. A project that only wants governed documentation reads this skill and the one layer reference it needs; nothing here assumes a harness, a plan, an iteration or a database.

## Purpose

Three layers, three jobs, one boundary: knowledge (`{KNOWLEDGE_DIR}`) carries what was learned, specs (`{SPECS_DIR}`) carry what is true now, ADRs (`{ADR_DIR}`) carry why a route was chosen and what it cost. This skill owns the boundary, the document shape inside each layer, and the lifecycle moves over them. The workflows that decide *what* to write (capture judgement, maintenance verdicts) belong to their own owners and are cited, never restated here.

## Standalone use

- **Required**: the three directories (defaults in「Layout defaults」) and these rules. Nothing else — no lifecycle state, no plan, no store.
- **Not required**: `{HARNESS_DIR}/store.db`, catalog rows, iteration close, plan registration, any gate. None of them gates a corpus write.
- **With no store the document set is the registry**: the directory tree and each file's own header carry identity, so no catalog row is owed and nothing blocks for want of one.
- Harness obligations below are stated conditionally ("when the harness is active"); a project without the harness reads only the unconditional half of each rule.

## Load order

Harness loading is optional and matters only when the harness already runs in this project:

- **No harness**: this skill plus the one layer reference you need — that is the whole load order.
- **Harness already running**: `mstar-harness-core` is then the first step and the lifecycle/authorization authority; directory resolution chains live in `mstar-conventions`, and process-artifact boundaries in `mstar-artifacts/references/knowledge-and-designs.md`. This skill never requires those reads, and they never change the document shape below.

## The three layers

| Layer | Job (one line) | Holds | Never holds | Update duty |
|-------|----------------|-------|-------------|-------------|
| **`{KNOWLEDGE_DIR}`** | Engineering experience and method distilled from work, reusable across plans | Patterns, lessons, how-to, analysis technique, validated trade-off experience | Current-state description, decision process, implementation plans | Written through `mstar-knowledge` capture at iteration close when the harness is active, otherwise by direct authoring; delete when stale; keep an old copy as `-v<N>` only for comparison (with an active store its catalog row is `superseded`; without one the newer page states it supersedes the old) |
| **`{SPECS_DIR}`** | Normative description of the project's currently valid state | Layering, boundaries, contracts, data flow, current paths and commands | Plan text, acceptance checklists, local plan/iteration ids, decision process | Updated in the same change as the code; delete when invalid; latest-only, no version suffix |
| **`{ADR_DIR}`** | One decision with its real alternatives and its cost | Problem, decision, alternatives, consequences | Current-state description, implementation plans, acceptance checklists | An implemented record stays true as facts drift; a changed decision gets a new record with both-way `Supersedes:`; a record that no longer guides future work is archived frozen, or deleted |

Specs say what is now, knowledge says how to work and what was learned, ADRs say why this route was chosen and what was given up. The only crossing rule: a spec may cite an ADR; an ADR never restates the current state; knowledge never describes it.

## Layout defaults

- **Standalone (no harness)**: `.agents/knowledge/`, `.agents/specs/`, `.agents/adr/` — tracked by default, with no ignore rule that would drop the corpus.
- **Harness active, no `.mstarc` declaration**: `.mstar/knowledge/`, `.mstar/specs/`, `.mstar/adr/` — the harness process root, whose ignore rules the harness owns.
- `.mstarc` keys `knowledge_dir` / `specs_dir` / `adr_dir` override either default; the value resolves relative to the `.mstarc` file's directory (an absolute path is used as given).
- The long discovery chains (`.agents/`, `docs/specs/`, `docs/adr/`, legacy candidates) exist for projects that already ran the harness; they are only reachable through `mstar-conventions` when the harness is active, and this contract needs none of them.

## Layer references

| Layer | Shape contract | Supporting assets |
|-------|----------------|-------------------|
| Specs | `references/specs.md` — admission, five-section skeleton, naming, degradation, validator behaviour | — |
| ADRs | `references/adr.md` — directory shape, classes, header lines, skeletons, lifecycle, archive freeze | — |
| Knowledge | `references/knowledge-format.md` — path, two tracks, section structures, frontmatter fields | `references/schema.yaml` (field SSOT), `references/category-mapping.md` (`problem_type` → directory), `assets/knowledge-skeleton.md` (both track skeletons) |

## Workflow and rules — new / revise / archive / capture

1. **New** — place the document by layer: `{SPECS_DIR}/<class>/<topic>.md`, `{ADR_DIR}/{bucket}/{class}/yyyy-mm-dd-topic.md`, `{KNOWLEDGE_DIR}/<category>/<slug>.md`. When the harness is active, also register a catalog `document` row and set the plan's `primary_spec` / `spec_refs`; with no store, the file is the registration.
2. **Revise** — knowledge and specs are edited in place (`last_updated` on a knowledge doc); an implemented ADR is edited in place while the facts drift. When the harness is active, a knowledge content change updates its catalog row in the same batch; identity is never changed.
3. **Archive** — an ADR that still has historical value moves to `archived/<class>/` with an `Archived:` line and freezes; a spec or knowledge doc that is merely stale is deleted, since history lives in Git. An iteration-start hygiene pass, when an iteration runs, owns bulk corpus archiving (`mstar-iteration/references/iteration-corpus-hygiene.md`).
4. **Capture** — when the harness is active, iteration close invokes `mstar-knowledge` capture, which judges candidates (Q1–Q8), detects overlap and promotes eligible documents into `{KNOWLEDGE_DIR}`. Without the harness, capture is the author's own decision: a solved problem that fits the knowledge format is written directly. Capture judgement and maintenance verdicts are `mstar-knowledge`'s, not this skill's.

## Optional validators (evidence checks)

Three checks exist; each is optional, works with no store, and skipping all three owes nothing.

- `mstar lint <dir> --type adr` — an ADR tree: bucket and class membership, `Status` agreeing with the directory, the `Archived:` line, required and banned sections per bucket, filename shape, fence closure, no `INDEX.md`.
- `mstar lint <dir> --type specs` — a specs tree: each spec in a `<class>/` directory, no history directory, the five-section skeleton, no ADR-only section, no version suffix or date prefix, balanced fences, no local harness path. It also expects a `README.md` index linking every spec — that is what the validator looks for, not a writing obligation this contract imposes; a corpus without the index is complete, it simply fails that check.
- `mstar compound validate <doc>` — one knowledge document's frontmatter against `references/schema.yaml`. The `--knowledge-dir` variant adds the catalog-completeness query, which needs an active store and is therefore harness-only.

## Process artifacts are not corpus

Plans, review bundles, QC reports, iteration compasses and drafts never belong in the three layers, and layer content never migrates into them. When the harness is running, their boundaries and storage paths are `mstar-artifacts/references/knowledge-and-designs.md`.
