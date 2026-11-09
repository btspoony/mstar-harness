---
module: engine + skills/mstar-audit (PR review envelope and body rendering)
date: 2026-11-03
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
applies_when:
  - adding or changing a consumer of the PR review body (GitHub Review comment, local report archive, host hook)
  - a consumer needs a fact the rendered review Markdown states in prose
  - deciding whether a new review presentation surface justifies a renderer variant
tags:
  - review-envelope
  - renderer-ownership
  - markdown-artifact
  - parseable-contract
  - pr-review
related_components:
  - packages/engine/src/prreview.ts
  - packages/engine/src/qcreview-schema.ts
  - skills/mstar-audit/references/pr-review.md
---

# A rendered Markdown artifact is a terminal output, not an input

The PR review flow has two representations of one review: the structured `mstar.review/v1`
envelope (`MstarReviewV1` in `packages/engine/src/prreview.ts`, payload schema
`MSTAR_REVIEW_V1_PAYLOAD_SCHEMA` in `packages/engine/src/qcreview-schema.ts`) and the Markdown body
published for a presentation surface. The envelope is the machine contract; the Markdown body is
what a human reads. Confusing the second for the first is the recurring defect.

## Context

`renderReviewMarkdown(review, { surface })` in `packages/engine/src/prreview.ts` turns an envelope
into the complete review body for one of two surfaces: `github-comment` and `local-report`
(`ReviewRenderSurface`). Both surfaces answer the same question with different layouts — GitHub gets
sections and per-class finding blocks, the local report gets a verdict heading with the score band, a
count table and one `####` block per finding.

Because both bodies are Markdown that demonstrably contains the verdict, the tally, the
`cause:` / `unscanned:` pair and every finding, a consumer is tempted to regex them back out. That
temptation is the failure this pattern forbids: the body's shape belongs to its producer, so a
consumer that parses it has adopted the producer's layout as its own interface.

## Guidance

### A rendered Markdown artifact is a terminal output, not an input

`renderReviewMarkdown` is the last step of the publication path; nothing downstream may treat its
string as structured data. Recovering facts by pattern-matching a summary line, a header, a table row
or a fenced block is *reconstruction*, not consumption: it silently depends on wording, ordering and
emphasis markers that the renderer is free to change, and it fails open when a slot is missing
(`incomplete` bodies legitimately drop the `cause:` / `unscanned:` lines; a settled body has none).

If a consumer needs a fact, it reads the envelope field that carries that fact — never the body's
rendering of it.

### The engine owns the body layout; consumers own only channel mechanics

Both surfaces are rendered by the engine, from the same envelope, so the two surfaces can never drift
apart in the facts they state. What remains outside the renderer is exactly what is *around* the body
and belongs to the channel:

- **Upsert markers** — the consumer's identity convention for finding and replacing its own previous
  comment; the engine has no notion of a comment id.
- **Round headers** — re-review framing (`report-r2.md`, the prior-head increment) that names the
  target of the publication, not the content of the review.
- **Byte-budget clamping** — the channel's size limit, applied to the assembled payload after the
  body is rendered.
- **Marker stripping** — removing the consumer's own markers when handing the body to a channel that
  must not see them (for example the local report copy).

None of those four may reach into the body's sections, and the renderer must not learn about them.
`skills/mstar-audit/references/pr-review.md` (§ Report template, § Local report archive) states the
same split from the consumer side.

### `summary_md` is an optional seat narrative, never an engine-authored header copy

`summary_md` is present only when a seat actually produced that prose; `validateMstarReviewV1`
accepts its absence and rejects an empty or whitespace-only string when the key is present, and
`synthesizeReview` omits the key entirely for a blank narrative. The renderer prints it as the seat's
own narrative (the `## 📋 Review` section on the local surface) and never reads it for facts.

A fabricated header summary — one built from the verdict and tally to fill the slot — republishes
facts the body already states structured, so the artifact says everything twice and the two copies
can disagree. When no seat produced a narrative, the section is absent; that is a correct body, not a
gap to be filled.

### The envelope carries verdict, findings, tally and incomplete — nothing else

`MstarReviewV1` is a closed contract: `ENVELOPE_KEYS` in `packages/engine/src/prreview.ts` fixes its
key set and `validateMstarReviewV1` refuses a document with a stray key rather than carrying it. A
surface that needs a fact the envelope does not carry — a stored score, an unscanned scope for a
settled run, a per-seat attribution — has a data gap, not a rendering gap. Adding a renderer variant,
a surface-specific prop or a second pass over the body does not create data the envelope lacks; the
fact must enter through the envelope's own contract (a validated field) or the consumer must derive
it from the durable report rather than from the rendered prose.

Note where the boundary already sits correctly: the `local-report` surface displays a score band, but
`scorePct` and the band are envelope/tally facts; the renderer formats them, and the report
frontmatter stores `score_pct` with the band explicitly *derived, never stored*.

### The failure mode this prevents

Without the ownership split, a consumer that mis-reads the body "fixes" it locally, and each fix moves
the defect one level rather than removing it:

1. **Strip by shape** — a consumer removes lines it believes are renderer decoration (a header it
   already displays elsewhere, a duplicated tally) by matching their shape.
2. **Caller-authored string** — the next consumer needs the same body without those lines, so the
   caller starts composing its own header or wrapper text instead of using the rendered one.
3. **Duplicated cause line** — the wrapper and the body each carry the `cause:` / `unscanned:` pair,
   so an `incomplete` review states its scope gap twice and the copies diverge on edit.

Each step is a local patch over a structural error: the consumer was consuming an artifact it does
not own. The repair is always the same — hand the envelope to `renderReviewMarkdown` for the
consumer's surface, and keep the consumer's work outside the returned body.

## Why This Matters

- **One layout owner means one place to change.** Fixing a wording or ordering defect in the review
  body is a renderer change with byte-exact unit tests behind it, not a search across consumers.
- **The two surfaces cannot disagree.** `github-comment` and `local-report` are two renderings of the
  same validated envelope; a consumer that composes its own body breaks that guarantee.
- **Facts stay checkable.** A reviewer of an `incomplete` review compares the envelope's `incomplete`
  object against the stated scope gap; a consumer-side parse of the prose has no equivalent check and
  degrades quietly.
- **The closed envelope surfaces data gaps early.** A missing field is a contract change with a
  validator behind it; a missing regex match is a silent empty value.

## When to Apply

- Adding any new consumer of a review body: a host hook, a dashboard panel, a second archive format.
- A consumer wants a value the review body shows in prose (verdict, score, tally, a finding's
  location) — read the envelope field instead.
- A proposed "small" renderer variant or post-processing pass over the returned Markdown.
- Reviewing a change that touches `renderReviewMarkdown`, `MstarReviewV1`,
  `validateMstarReviewV1` or `synthesizeReview`.
- Deciding where a new publication channel's marker / header / truncation logic lives.

## Examples

### Before — the consumer parses the body it just rendered

```ts
const body = renderReviewMarkdown(review, { surface: "github-comment" });

// Recovering facts by shape: depends on wording, ordering and emphasis the renderer owns.
const verdict = body.match(/\*\*Verdict: (.+?)\*\*/)?.[1];
const mustFix = body.match(/must-fix (\d+)/)?.[1];
const cause = body.match(/^cause: (.+)$/m)?.[1]; // absent on a settled body
```

### After — the consumer takes facts from the envelope and owns only channel mechanics

```ts
const { verdict, tally, incomplete } = review; // validated by validateMstarReviewV1
const body = renderReviewMarkdown(review, { surface: "github-comment" });

// Channel mechanics stay outside the returned body: framing first, then the limit.
const framed = [roundHeader, body, upsertMarker].join("\n\n");
const payload = framed.length > channelLimit ? clamp(framed, channelLimit) : framed;
```

A surface that needs a fact missing from `review` is a contract question, not a parsing question: add
it to `MstarReviewV1` with validator coverage, or read it from the durable local report.
