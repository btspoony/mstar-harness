---
module: packages/engine roadmap authority store + CLI roadmap authoring verbs (source decode, content/provenance hashing)
date: 2026-09-25
problem_type: logic_error
category: logic-errors
severity: high
symptoms:
  - "A reviewed import of a BOM-prefixed roadmap stores content without the leading U+FEFF"
  - "The stored `contentHash` disagrees with the receipt's provenance `sourceHash` for a source that never drifted"
  - "Markdown export from the store differs from the reviewed source file, and two authoring verbs store different bytes for the same file"
root_cause: "The store hashes raw source bytes for provenance but stores decoded text as content, and the domain decoded the same file at more than one site: the import site used a default `TextDecoder`, whose `ignoreBOM: false` silently consumes a leading U+FEFF, while the other sites already preserved it."
resolution_type: code_fix
plan_id: "20260925-roadmap-store-authority"
tags:
  - bom
  - utf-8-decode
  - content-hash
  - source-hash
  - duplicate-logic
  - store-authority
---

# Text stored as authority must be decoded byte-preserving at every site

## Problem

When a store keeps **both** a provenance hash over a candidate file's raw bytes and the **decoded text** as its stored content, every decode site in that domain must use one byte-preserving mode. Any site that decodes with a plain `new TextDecoder("utf-8", { fatal: true })` silently consumes a leading UTF-8 BOM (`EF BB BF`), so the stored string is no longer a faithful encoding of the source: `sha256(storedContent)` and `sha256(sourceBytes)` disagree for a source nobody edited, and export no longer round-trips the reviewed file.

The defect is not the missing flag. It is that the same decode was written twice, in two layers, with different flags — a "fix" applied to one site leaves the domain inconsistent, and the second site keeps reproducing the disagreement.

## Symptoms

- A reviewed import of a BOM-prefixed roadmap publishes BOM-less content, so the stored document is not the reviewed bytes.
- The stored record's `contentHash` permanently disagrees with the provenance `sourceHash` recorded on the import receipt, for a source that has not drifted.
- Markdown export and the stored `contentMarkdown` differ from the reviewed file by exactly the leading `U+FEFF`.
- Two authoring verbs over the same file store different bytes: one preserves the BOM, the other strips it.
- No refusal fires. The drift check compares a freshly re-read source's raw bytes with the receipt's `sourceHash`, so it still passes; the divergence appears only as a stored-content/hash disagreement.

## What Didn't Work

1. **Fixing only the site the finding named.** The replace path was corrected first, and its regression exercised replace only. The import path decoded the same file with the default `TextDecoder` and kept the defect, so plan QC re-found it one layer down as an incomplete fix of an accepted L2 finding. A fix diff proves the sites it touched, not that the domain is consistent — completeness here is established by finding every site that decodes the file, not by reading the diff.
2. **Treating the mismatch as source drift.** The provenance hash is review evidence over bytes, not the stored content's identity. Because the drift check re-hashes raw bytes, a decode discrepancy cannot present as a drift refusal, and looking for a drift explanation in the receipt leads away from the decode site.
3. **Relying on a per-verb regression.** One regression per authoring verb certifies the verb it exercises; with the decode duplicated across layers, each verb needs its case (or the sites must be collapsed onto one seam) before "the domain preserves bytes" is a supportable claim.

## Solution

One byte-preserving decode mode, used by every site in the domain — the reviewed import (preview and apply), the replacement verb, and the round-trip validator:

```ts
// Before — the default mode consumes a leading U+FEFF
const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

// After — U+FEFF stays in the decoded string, so it re-encodes to the original bytes
const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
```

- Keep `fatal: true`: invalid UTF-8 is still refused rather than replaced.
- Change the round-trip validator too. A validator that rewrites or strips the BOM rejects the content the import now legitimately preserves.
- Add a regression that imports a BOM-prefixed candidate and asserts, in one case, byte-equality of the stored Markdown, `contentHash === sourceHash`, and byte-equal Markdown export.

## Why This Works

`ignoreBOM: true` keeps the leading `EF BB BF` as `U+FEFF` inside the decoded string, and re-encoding that string with UTF-8 reproduces the original bytes, so the hash of the decoded string and the hash of the raw bytes agree for BOM-prefixed and BOM-less files alike. Because the decoded string is now a faithful encoding of the source, the stored content is the reviewed content: export round-trips, and the provenance hash is meaningful as a provenance hash. Sharing one mode across the domain removes the possibility that two verbs disagree about the same file — the duplicated decode was the only thing making that possible.

## Prevention

- **Name the decode mode once per domain and share it.** Before fixing a decode/hash defect, ask how many sites decode this artifact; a store that both hashes bytes and stores text must state its decode mode in exactly one place.
- **Treat a duplicated decode as the defect, not the flag.** The durable repair is to reduce the domain to one byte-preserving seam; a second copy of the same expression is a second chance to diverge, in a file where divergence is invisible to every refusal.
- **Assert the stored content, not only the provenance.** A test that checks `sourceHash === sha256(sourceBytes)` passes while the store publishes rewritten content; `contentHash` equality is what binds the stored string to the reviewed bytes.
- **Cover each authoring path for byte-fidelity claims.** Import and replace are separate entry points to the same write; a BOM (or any encoding-edge) case for one of them says nothing about the other.

## Source

Iteration `iter-20260925-v4-phase4`, plan `20260925-roadmap-store-authority`. The decode sites are the roadmap-authority store's `sourceBytes` helper (import preview/apply) and its round-trip content validator, plus the CLI replacement verb that already preserved the BOM; evidence for the defect, the fix, and the BOM round-trip regression is in the plan's QC reports and consolidated decision under `{SDD_DIR}/20260925-roadmap-store-authority/review/` and in its task reports. Related: `architecture-patterns/store-authority-staged-lifecycle.md` (what a store authority owns and what its receipts must carry), `testing-patterns/store-bytes-are-not-a-write-proof.md` (choosing the observable for a store claim), `conventions/authored-harness-ignore-preservation.md` (one shared predicate instead of per-caller copies of the same rule).
