---
module: committed host bundles (`hooks/*.mjs`) and generated dashboard assets
date: 2026-11-13
problem_type: tooling_decision
category: tooling-decisions
severity: medium
plan_id: "<plan-id>"
last_updated: 2026-11-13
applies_when:
  - "A source change removes or adds a symbol the committed host bundles inline"
  - "A local rebuild of a committed bundle produces a huge diff for a small source change"
  - "Deciding whether to commit a regenerated artifact or leave it to release"
tags:
  - generated-artifact
  - bundle
  - release
  - bun-version
  - freshness
---

# The committed bundle is refreshed by release preparation, not by the source change

## Context

Two tracked artifacts are build outputs that inline `packages/engine` sources: `hooks/mstar-write-gate.mjs` and `hooks/session-context.mjs`, plus the dashboard module `packages/commands/src/dashboard/assets.generated.ts`. Their contents depend on the bundler version as well as on the source.

During the audit-backlog iteration, three separate plans deleted engine exports that those bundles inline. Each plan ran the documented rebuild, and each produced a diff that rewrote tens of thousands of lines for a one-function deletion: this checkout's bun (1.4.4) and the CI-pinned bun (1.4.0) emit different bundle shapes, and neither matched the committed bytes. Reviewing or merging that diff would have buried the real change and moved the artifact to a byte form CI cannot reproduce.

## Decision

A source change does **not** regenerate the committed bundles. The plan records the stale-bundle fact and `release:prepare` rebuilds them, so a published package never ships the previous engine. Branch evidence for a deletion is a source-level zero-consumer grep; the committed bytes are not part of branch evidence, and the CI freshness diff that compares them is advisory (`continue-on-error`) because it reddened unrelated PRs for exactly this version drift.

## Consequences

- A branch can merge while the committed bundle still contains a deleted function. That is safe: the bundle's copy has no caller, and the release rebuild removes it.
- Anyone regenerating locally must expect a large diff and must not commit it unless the pinned bun produced it.
- If a future change makes the bundles' bytes reproducible across supported bun versions, this decision can be narrowed to "reproducible artifacts are committed"; until then the release boundary is the only place the artifact is re-taken.
