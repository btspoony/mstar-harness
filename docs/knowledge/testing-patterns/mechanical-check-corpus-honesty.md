---
module: engine-lint + drift-lint guards + CLI parsers
date: 2026-08-16
last_updated: 2026-11-09
problem_type: testing_pattern
category: testing-patterns
severity: medium
plan_id: <plan-id>
tags:
  - fence-aware-lint
  - false-green
  - canonical-fixtures
  - corpus-guard
  - load-bearing-proof
related_components:
  - packages/engine/src/skill-authoring.ts
  - scripts/drift-lint.ts
  - packages/cli/src/index.ts
applies_when:
  - Writing or extending a lint/guard that asserts "section/field present" over markdown or template-shaped text
  - Writing fixtures for parsers that consume Assignment/Scope blocks defined by a PM template
  - Adding a CI corpus guard over a shipped corpus
---

# Mechanical-check corpus honesty: fences are not coverage; canonical forms are not optional

## Context

During iter-<plan-id>, two independent false-confidence mechanisms surfaced in freshly-shipped mechanical checks — both caught only by adversarial QC, both invisible to green test suites:

1. **Fence false-green (plan 001, F-001a/b/c).** `lintFiveQuestion` passed `mstar-skill-authoring` (the standard's own skill) and `mstar-plan-conventions`'s Workflow question — but the "covering" headings lived inside ` ``` ` fenced template/example blocks (the `## 默认 Body 结构` template body; a gitignore comment line). The heading regex matched template *examples of headings*, not the document's own sections. Making the scanner fence-aware flipped both to RED — proving the corpus had never honestly satisfied the check.
2. **Non-canonical fixture form (plan 004, F-001).** `worktree qc-alignment` parsed `**Review range**:` / `**Diff basis**:` as *separate* labels and its fixtures used that form — all green. The PM Assignment template's canonical label is the *combined* `**Review range / Diff basis**:`; real tri packs (the tool's entire purpose) false-FAILed with `qc.alignment.field.missing` ×2. Tests passed while the primary real-world input shape failed.

## Guidance

- **Heading/section presence checks must be fence-aware.** Lines inside ` ``` `/`~~~` blocks are never headings (toggle-state line scan, both lint modes). A template that *documents* a section does not *answer* the question the lint asks.
- **Fixtures must use the canonical producer form.** When a parser consumes text authored from a template (Assignments, Scope blocks, compass frontmatter), the fixture is the template's canonical label — plus one regression case per accepted variant. A green suite against a variant shape is a false green against the real input.
- **Self-referential checks get extra suspicion.** A standard-bearing document passing its own stricter linter is a red flag, not a comfort: verify the pass comes from real sections, not from the document quoting its own template.
- **Corpus guards must prove load-bearing-ness.** Every new CI guard ships with a red-probe test (delete one alias/heading/field → guard fails). Guard 5's live probe (sed-delete a heading → `validation:drift` exit 1 → restore) is the pattern.
- **When a fence-aware fix exposes a corpus gap, close it honestly**: annotate the heading that genuinely answers the question, or add a thin real section derived from existing material — never widen aliases/regex to re-green the fence.
- **A gate that restates a runtime parser must not re-derive the parser's boundaries.** A checker that closed an Assignment header at the first blank line, while the engine closed it at a body marker, let a seat after the blank escape the gate and still be refused at dispatch (`dsh-contract-lint` round 1, W1/W1). Hand the whole segment to the owning parser and report its codes; the boundary, the role list and the trigger then cannot disagree.
- **Extract citations before consulting the authority, never through its keys.** A carrier-citation scan anchored on the map's own keys silently stopped matching a tool the map dropped, so a stale citation passed (all three seats, round 1 W2). Extract every `<tool>.<field>` mention by shape first, then assert membership — the authority answers "is this valid", it must not answer "what should I look for".
- **A partially parsed authority is a failure, not a smaller authority.** Skipping entry lines the regex does not understand returned a usable-looking map and quietly dropped one tool (round 1 W2). Fail with the line number; never continue on a partial corpus.
- **Structural scanners need parity guards on their own syntax.** An odd number of ``` fences drops the rest of the document from every block scan and can exit 0 (round 1 W1, qc3). Count the toggle lines per document and row on imbalance.

## Fail-open seams, measured once

A freshly shipped three-check gate over the dsh host documents shipped with five fail-open seams and one overclaimed parity comment; three independent read-only seats found every one, and none was visible from the green suite or the passing script run. The seam classes, in the order they cost least to fix:

| Seam | What made it fail-open | Fix shape |
|---|---|---|
| Local boundary vs runtime boundary | checker truncated a block earlier than the parser it claimed to mirror | delegate to the parser over the whole segment |
| Authority-driven search | citation regex built from the authority's keys | search by shape, then check membership |
| Partial parse treated as valid | unmatched lines skipped, map still returned | named row per unparsed line, no continuation |
| Unbalanced structural toggle | odd fence count hid the document tail | parity row per document |
| Duplicate recorder entry | last record wins, stale duplicate never compared | row naming the duplicate |
| Overclaimed parity | comment asserted "the shape dispatch enforces" while gating a narrower set | gate the parser's full trigger, or narrow the claim |

The cheapest detector was reading each check's own sentence against the code that implements it: every seam was a gap between the prose claim and the boundary the code used.

## Why This Matters

Guards that pass on template echoes or variant fixtures don't just miss defects — they *certify* them. Downstream consumers (maintainers running `mstar skill lint`, PMs running `qc-alignment` before dispatch) make gate decisions on the output; a false green here propagates as a false "safe to proceed" into the delivery flow.

## When to Apply

- New lint/guard over markdown corpora (drift-lint Guards 3/4/5 family) — fence-awareness + canonical fixtures + red-probe test.
- New CLI parser over harness-generated text — derive the accepted label set from the *template SSOT* (e.g. PM Assignment template), not from what the parser was first developed against.
- Any "validator ↔ corpus ↔ prose" alignment work (audit 2026-08-16 theme): measure coverage against the real corpus before trusting either side.

## Examples

- `packages/engine/src/skill-authoring.ts` `collectHeadings` — fence toggle scan shared by both lint modes; unit tests pin the gitignore-comment false-positive shape.
- `packages/commands/src/families/validation.ts` `parseHeaderField` over the combined `**Review range / Diff basis**:` label (the parser moved out of the retired monolithic `packages/cli/src/index.ts`) — the combined label fills both `reviewRange` and `diffBasis`, separate labels win per-field, and the fixture set is the canonical tri-pack (3 assignments, combined label) + separate-form pass + missing-field fail (`qc.alignment.field.missing`).
- Fence-aware fix that exposed `mstar-skill-authoring`'s own missing sections (fixed with real `## Workflow` + annotated Decision Rules/Evidence — commit `04a4f97`).
- `scripts/dsh-contract-lint.ts` (plan `<plan-id>`) — the whole gate after its fix wave: each `## Assignment` segment goes to the engine's `validateAssignmentFields`, carrier citations are matched by snake_case tool shape and then checked against the map, an unparsed map line is a named row, `checkFenceParity` rows on an odd fence count, and a duplicate `README.i18n.yaml` record is named. Six seeded cases pin one seam each.
