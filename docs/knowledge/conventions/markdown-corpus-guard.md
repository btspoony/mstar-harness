---
module: scripts/drift-lint.ts guard family + scripts/markdown-links.ts (tracked Markdown corpus guard) and its CI job
date: 2026-09-25
problem_type: convention
category: conventions
severity: high
plan_id: "<plan-id>"
applies_when:
  - "Adding a guard that checks the repository's own document corpus rather than one producer/consumer pair"
  - "Reviewing a proposal to exclude a file or directory from a corpus check, or to narrow its input set"
  - "Wiring such a guard into CI (event filters, install step, full-history checkout)"
  - "Triaging the first full-corpus run of a newly landed guard"
tags:
  - corpus-guard
  - markdown-links
  - canonical-slugger
  - input-scope
  - ci-wiring
  - false-positive-triage
---

# Corpus guards over tracked Markdown: exhaustive scope, canonical semantics, corpus last

## Context

The drift entry (`bun run validation:drift` → `scripts/drift-lint.ts`) carries a family of guards over the repository's own documents. Most of them check a producer/consumer contract (a skill's callout names a real export). A **corpus guard** asks a different question: it validates every tracked canonical document against a semantic rule whose inputs are the documents themselves. Guard 8 — the Markdown link and anchor scanner in `scripts/markdown-links.ts` — is the worked example, and its remaining decisions are durable: which files are inputs, what counts as a real link, how a target resolves, and what a diagnostic means before anyone edits a document.

## Guidance

1. **The input set is every tracked canonical document.** Enumerate with Git (`git ls-files -z`, NUL-split) so spaces, quotes, Unicode and newlines survive, and read only the enumerated files instead of walking directories — this is also what keeps gitignored trees out by construction. Case-insensitive extensions, repository-root-relative reporting.

2. **Exclusions are generated artifacts with an identified producer, and nothing else.** A bundled or assembled copy (`packages/*/harness-*/**` produced by a named bundler script, an assembled `CHANGELOG.md`) is excluded **as a copy** while its canonical source stays in scope; a generated file may still be a valid link *target*. There is no exclusion for a file that currently fails, no blanket exemption for a fragment directory, and no changed-files-only mode: a relative link breaks when its arbitrary target is renamed, with no Markdown edit at all.

3. **The CI job must match that scope.** Because validity is not a function of the changed files, event path filters are removed rather than narrowed — `**/*.md` alone still leaves the target-deletion hole. Install whatever the guard's dependencies are, including by replacing an existing no-install job with an install step; a job that currently skips install is current status, not a constraint. Keep the full-history checkout when another guard needs it.

4. **Classify links semantically, from a real parser.** Markdown and HTML nodes only: fenced, indented and inline code never contribute outgoing links (inline code *inside* a heading still contributes its visible text to that heading's id); placeholder destinations (`{NAME}`, `{}`, `<angle>` forms) are skipped and counted with a reason; explicit URI schemes and protocol-relative URLs are never fetched; a leading `/` is repository-root-relative, not an OS-absolute probe; a query string is separated from the fragment before decoding and does not change file identity; percent-decoding happens once, strictly, with `%23` in a path treated as a literal filename character; and a target is resolved against the **tracked** path set so untracked build output cannot make CI pass.

5. **Resolution semantics are part of the contract, not implementation detail.** The one that is easiest to get wrong: a **link with an empty path component resolves to the source document itself** — a same-file fragment is matched case-sensitively against that document's canonical heading ids and explicit anchors, never re-slugified or lower-cased by the guard. Directory targets resolve when a tracked descendant establishes the directory (trailing slash irrelevant) or through that directory's tracked `README.md` for a fragment; decoded lexical traversal and symlink realpaths outside the repository are refused; a fragment on an unsupported document kind fails explicitly instead of silently counting as valid.

6. **Canonical semantics come from a canonical implementation.** Use the established GitHub slugger with a real Markdown (and HTML) parser — never a private slugifier, a regex preprocessor, or a snapshot of the slugger's character rules. Otherwise the guard's greens describe the private implementation rather than the platform readers use. Keep its exact behavior: one slugger instance per document, headings in source order, duplicate-heading suffixes and Unicode/punctuation rules inside the implementation, explicit HTML ids adding anchors without consuming the duplicate counter, and a heading's explicit id winning over a generated one.

7. **The guard is an importable seam consumed by the existing entry point** — not a second autonomous tool, and not a second convention/job in CI. Enumeration and read errors are failures, never an empty-success scan; every diagnostic carries source path, line, raw target and kind; any real diagnostic means a non-zero exit; the footer's counts say what they count (a "resolved" counter is not a "checked" counter).

8. **Fixtures specify valid and invalid links independently of the implementation**, and the integration round runs the guard over the whole corpus. A fixture built to match what the scanner already does passes while the real corpus fails — the suite proves nothing about the corpus it exists to guard.

9. **Triage a first full-corpus run as a hypothesis about the corpus, and check the resolution rules before editing anything.** A resolution defect in the guard presents exactly like corpus damage: a valid same-file fragment is reported as a missing target. The tempting repair — rewriting the documents to silence the guard — destroys the evidence and leaves the defect in place. Observed: a same-file-fragment path-resolution defect reported six valid fragments in `docs/commands.md` as `missing-target`; resolving fragment-only targets against the source document cleared all six with no corpus edit, and only genuinely broken links remained.

## Why This Matters

A corpus guard's green is only as meaningful as its scope. Narrow the input set to the changed files, exclude a file because it fails, or substitute a private implementation of the rule, and the guard keeps reporting success while link rot spreads exactly where nobody looks — and a link's target can be deleted by a commit that touches no Markdown at all. The classification and resolution rules are the difference between a guard that certifies the corpus and one that certifies whatever it happened to parse.

The diagnosis order protects the other direction. A guard that lands against a real corpus is new code reading old documents, so its first diagnostics are a claim to be tested, not a verdict: treating them as corpus defects converts a guard bug into permanent edits to valid documents, and the guard then reports green because the evidence was changed rather than the defect fixed.

## When to Apply

- Adding or extending a guard that validates the repository's own documents (the drift-lint guard family), including a new guard over a corpus nobody has scanned yet.
- Reviewing any proposal to add an exclusion, a baseline, a blanket directory exemption, or a changed-files-only mode to such a guard.
- Wiring a corpus guard into CI: decide which event's checkout it describes, whether path filters can let a target-only change skip it, and what it must install.
- Choosing a dependency for a "canonical" behavior (slugging, parsing, encoding) rather than hand-rolling it.
- Triaging the first production run of a newly landed guard, or any diagnostic that attributes failure to a corpus.

## Examples

### Before

A scanner resolves a fragment-only link (`#some-heading`) as a path relative to the source **directory**. Every same-file fragment in the corpus is reported `missing-target`; six diagnostics appear in one tracked document; the visible repair is to rewrite six valid links into a different form.

### After

Fragment-only targets resolve to the source **document**; the six diagnostics disappear untouched, corpus byte-identical across the guard's landing range, and the production entry reports zero diagnostics over the full tracked corpus.

### Also avoid

Excluding the failing document, narrowing the corpus to changed files, or writing a private slugger to keep the CI job dependency-free. Each turns a specific, checkable claim ("every tracked relative link resolves") into an unfalsifiable one.

## Source

Iteration `iter-<plan-id>`, plan `<plan-id>`; the frozen implementation contract is `{ITERATION_DIR}/iter-<plan-id>/specs/markdown-anchor-contract.md`, and the production wiring is `scripts/markdown-links.ts` plus Guard 8 in `scripts/drift-lint.ts` with its CI job. Evidence: that plan's task reports and its review bundle (scanner diagnostics, the red/green fragment-resolution fix, and the unchanged-corpus proof) under `{SDD_DIR}/<plan-id>/`. Related: `testing-patterns/mechanical-check-corpus-honesty.md` (fence-aware checks, canonical fixtures, load-bearing proof), `tooling-decisions/generated-artifact-engine-resolution-identity.md` (generated copies and their canonical sources), `conventions/document-label-exact-match.md` (mechanical recognition instead of interpretation).
