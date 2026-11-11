# ADR: The three-layer document corpus is a standalone skill, not a lifecycle reference

Status: implemented — the corpus contract now lives in `mstar-doc-corpus`, which no lifecycle skill and no store gates.
Date: 2026-11-11

Scope: `skills/mstar-doc-corpus/`, `skills/mstar-knowledge/`, `skills/mstar-artifacts/references/knowledge-and-designs.md`, the load-order lint in `packages/engine/src/roles.ts`, and the inbound pointers across the `mstar-*` corpus.

## Problem

The three-layer corpus — engineering knowledge, current-state specs, decision records — was stated only inside lifecycle skills. The boundary between the layers sat in `mstar-artifacts`, a skill a documentation-only reader never loads; the knowledge document schema, its track skeleton and its category map sat in `mstar-knowledge` behind a mandatory core-first header; the ADR contract existed only as this repository's own `docs/adr/README.md`. A project that wants governed documentation without the harness could not adopt any of it, and the knowledge capture workflow made that worse: every new document had to complete catalog registration, which needs an active store, so a storeless project was told to do something it could not do.

## Decision

`mstar-doc-corpus` owns the corpus contract. It states the layer boundary, the specs skeleton and admission rules, the ADR record contract, and the knowledge document shape, and it is usable with no harness, no plan and no store.

- One canonical home per statement: the layer boundary table, the specs skeleton, the ADR contract and the knowledge shape exist only in the new skill. This repository keeps its own ADR tree and Guard 12 gate in `docs/adr/README.md`, as an instance of that contract rather than a second copy of it. `mstar-artifacts` keeps the process-artifact half of `knowledge-and-designs.md` and points at the corpus skill; `mstar-knowledge` keeps capture and maintenance (Q1–Q8, the decision matrix, overlap detection, the five maintenance outcomes) and points at the corpus skill for shape.
- Harness obligations inside the corpus skill are conditional. A project with no harness defaults to the tracked `.agents/{knowledge,specs,adr}`, which no ignore rule removes from the repository; a project whose harness is active resolves `.mstar/{knowledge,specs,adr}` instead, because the harness owns that process root and its ignore rules. Either default is overridable through `.mstarc`. Catalog registration and iteration-close promotion apply only when the harness is active, and with no store the document set is the registry.
- Corpus authoring must not require lifecycle loading, so `lintLoadOrder` exempts `mstar-doc-corpus` by exact name, next to the existing standalone `mstar-coding-behavior` exemption. Every other `mstar-*` topic keeps the core-first rule.
- The CLI verbs are unchanged and optional: `mstar lint --type adr`, `mstar lint --type specs` and `mstar compound validate <doc>` are documented as checks a user may run, not obligations. The `--knowledge-dir` catalog-completeness branch stays harness-only.

## Alternatives considered

- **Copy the corpus rules into a second lightweight skill.** Lost: two homes drift, and the cross-file HARD-rule guard already refuses duplicated rule text. A copy also makes every future correction a two-site edit with no owner.
- **Leave the contract in `mstar-artifacts` and package a subset of the existing skills.** Lost: a bundled subset keeps cross-skill references that resolve to skills the subset does not ship, so the standalone reader follows a pointer into a missing file — the load-order rule that requires core-first would also be violated by every such subset.
- **Ship a standalone npm package now.** Deferred, not rejected: the corpus text has to be self-contained first, and no second consumer has asked for the package. The package becomes worthwhile when one does, or when the full skill bundle becomes an adoption complaint; it would then bundle this skill plus a file-only validator entry point.

## Consequences

- A documentation-only adopter reads one skill and its three layer references, and owes no store, no iteration and no lifecycle load. Harness users lose nothing: the moved statements are pointed at, not paraphrased, so there is one place to correct.
- The validators stay store-free and optional; a corpus that skips them is complete, and a specs tree without a `README.md` index simply fails that one check rather than being incomplete.
- The cost is one more `mstar-*` skill and an exact-name exemption in the load-order lint. The exemption is name-keyed, so renaming the skill silently restores the core-first requirement and fails the corpus lint — the engine test pins that boundary deliberately.
- A future standalone distribution needs only this skill plus a validator entry point that imports no store code; nothing in the corpus text has to move again.
