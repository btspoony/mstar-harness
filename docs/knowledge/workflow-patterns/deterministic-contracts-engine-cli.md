---
module: skills/mstar-audit/ + packages/engine/src/prreview.ts
date: 2026-08-26
last_updated: 2026-11-09
problem_type: workflow_issue
category: workflow-patterns
severity: medium
applies_when:
  - "Deciding whether a skill-document rule belongs in engine/CLI code"
  - "Reviewing a skill (or PR against one) where deterministic arithmetic, naming, validation or external-effect guards live in prose"
plan_id: 20260826-prreview-core
tags:
  - engine-cli-boundary
  - determinism
  - computePrTally
  - report-path
  - posting-wrapper
  - review-methodology
---

# Deterministic contracts belong in engine & CLI, not skill prose

## Context

An architect-led programmatic review of `skills/mstar-audit/` classified every deterministic contract as A (already carried by engine/CLI), B (programmatizable but prose-only), or C (genuinely judgmental). Twelve B-class items surfaced: tally/score arithmetic computed by an LLM each run, report filenames invented by eyeball, GitHub posting rules repeated three times in prose without mechanical enforcement, seat-prompt ingredient checklists verified only by reviewers, secret patterns maintained in two drifting lists. The follow-up plans (SP5–SP7) landed B-1 through B-11 as tested engine functions and thin CLI wrappers.

## Guidance

Apply this test when writing or reviewing a skill rule:

| Signal | Verdict |
|---|---|
| Two agents executing the same rule must produce byte-identical output | Engine function |
| The rule computes numbers (formulas, counts, percentages) | Engine function |
| The rule names things (files, keys, branches) with collision rules | Engine resolver |
| The rule validates a shape/doc (enums, field placement, tri-states) | Engine validator + lint hook |
| The rule guards an irreversible external effect (posting events, target repo selection) | Engine builder that makes violation unrepresentable |
| The rule needs human/context judgment (exploitability, priority trade-offs, "is this smell must-fix") | Skill prose, possibly feeding inputs to an engine calculator |

When in doubt: if a reviewer could plausibly ask "prove the LLM did this exactly right every time," it is deterministic and belongs behind a function signature with tests.

Landing pattern (proven across three plans):
1. New engine module exports pure functions/constants with fixture tests transcribed from the current skill examples.
2. Thin CLI command per consumption point.
3. Skill text keeps the *contract* semantics and gains one `engine-check` callout pointing at the command; duplicated tables/prose shrink to pointers.

## Why This Matters

Prose-only deterministic contracts drift silently, are expensive to re-execute correctly (LLM arithmetic runs), and attract endless review cycles disputing theoretical edge cases. Code versions get written once, tested once, and audited mechanically.

## When NOT To Apply

Genuinely judgmental content stays in skills: exploitability reasoning, severity weighting, prioritization leverage, attack-surface narrative, disposition calls ("survived/refuted"), tone/discipline. The boundary statement: *the model judges; the engine computes and checks.*

## Examples

- SP5 landed `computePrTally` — the pr-review score formula is now a tested pure function instead of LLM arithmetic executed per review.
- SP6 made posting invariant at the type level: `event: "COMMENT"` literal so APPROVE/REQUEST_CHANGES leakage is unrepresentable.
- Greptile spent thirteen review rounds discovering races in a markdown-embedded lock protocol; moving the protocol into an engine function inside the store's `BEGIN IMMEDIATE` transaction (the retired `withStatusWriteLock` lockdir was the interim form) ended the cycle immediately.
