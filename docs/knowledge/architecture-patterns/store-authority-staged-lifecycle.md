---
module: engine issue/catalog store (store.db): migration, staged/active lifecycle, authority gating
date: 2026-09-19
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: 20260918-issue-governance-cutover
applies_when:
  - "adding a store verb, migration source family, or activation/retirement step for the harness governance store"
  - "building v4 phase 2 (execution write authority) or phase 3 (roadmap authority) on the same store"
  - "reviewing any change that could make a retired JSON surface readable or writable again"
tags:
  - store-authority
  - staged-store
  - migration
  - activation
  - single-writer
---

# Store authority: apply ≠ activate ≠ retire, and a staged store is not authority

## Context

Iteration `iter-20260918-issue-store-dashboard` (plans `20260918-issue-store-core`, `20260918-state-projection`, `20260918-issue-governance-cutover`) replaced the per-project JSON registers with one local SQLite store (`{HARNESS_DIR}/store.db`) as the sole issue/catalog write authority, plus a read-only execution-state projection that stays JSON. The lifecycle has three distinct irreversible-in-scope acts — **apply** (staged import), **activate** (authority flip), **retire** (archive the exact legacy sources) — and the QC round of the cutover plan surfaced four independent ways the code initially violated the invariants around them.

## Guidance

- **The three acts are separate.** A staged apply never supersedes live authority; merely leaving files present, updating an in-repo reader, or documenting an upgrade requirement is not cutover. Activation is an epoch flip gated on consumer/coordinator attestation; retirement is a receipt-backed archive of exact verified inputs.
- **A staged store refuses authority-shaped reads, not just writes.** `listIssues` / `getIssue` must `assertActive` like the mutation verbs — otherwise a staged import is queryable as if it were the live issue list. Read-only displays of *authority state* (e.g. the dashboard's `authority_state`) are the legitimate exception: showing "staged" is their job.
- **No capture window exists between cutover and activation.** Retired register writers are gone and a staged store refuses ordinary mutations, so a finding confirmed in that window is carried by the plan/QC reporting surface and captured into the store only after activation, with its occurrence recorded at capture time — never back-dated into the staged import, so it cannot appear in the migration manifest.
- **Every reviewed disposition class needs an engine home.** The mapping enum must cover all outcomes a human review can produce — `issue | history | excluded`, each with a per-row rationale. A reviewed "history-only" row with no mapping home makes the user's decision unrepresentable, and "drop the mapping" is not a representation. History rows persist **verbatim** on the receipt (`wont-fix` stays `waived`, never relabelled), are never imported as open issues, and never get synthesized author/date/impact/acceptance/proof. An already-imported issue tuple is never silently demoted on replay; re-reviewed re-allocations reconcile through the receipt.
- **One findings authority — no second register-walking reader.** After the cutover, a JSON aggregator that still walks live registers and returns `total_open: 0` for a missing one (`techDebtRollup`) is an empty-success lie, strictly worse than the fail-closed gate next to it. Delete/unexport retired readers (and their doc landing points in the same stroke) instead of converting them.
- **Receipts over claims.** Manifests/receipts carry byte digests, source-set digests, verbatim history rows and retirement sections; activation revalidates exact bytes and refuses drift rather than inventing a capture verb; `initializeStore` refuses legacy workspaces at the CLI wrapper boundary.

## Why This Matters

Each violation is a silent dual-authority or silent-empty failure mode that no test of the happy path catches: a hand write to `store.db` bypassing the gate, a staged row served as authoritative, a user decision with no representable form, a rollup that reports success over a retired authority. All four were caught only by a full QC tri over the whole branch — the patterns, not the features, were the risk.

## When to Apply

Any change to `packages/engine/src/store-*.ts`, the issue/catalog verbs, the migration/activation surface, or any consumer that reads issue/catalog data; any future "phase" that moves another authority (execution writes in v4 phase 2, roadmap content in phase 3) into the same store.

## Examples

- FW-2 (`be5807ce`): `MigrationEntryMapping.classification` extended to `issue|history|excluded` with rationale — the executable form of the settled "67 unresolved rows → history-only" decision.
- FW-5 (`7163c0ba`): `techDebtRollup` export deleted; CLI computes from the store via `readIssueRollup` (single findings authority).
- FW-6 (`6068e70a`): `assertActive` wired into both read verbs with a data-present staged-store regression test.
- G5a: activation epoch + attestation fence + exact-byte retirement receipts (`store-activation.ts`), with the in-flip revalidation I/O trade documented at the fence.
