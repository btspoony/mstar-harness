---
module: skills/mstar-audit/references/pr-review.md
date: 2026-09-05
problem_type: workflow_issue
category: workflow-patterns
severity: medium
applies_when:
  - "Designing or tuning any multi-subagent pipeline (review/audit/QC) whose wall-clock duration must be predictable rather than input-shape-dependent"
  - "Adding per-seat output/read caps that cannot be mechanically enforced because seats are host-managed subagent sessions"
  - "Instrumenting an orchestrated workflow so its duration targets become falsifiable instead of aspirational"
plan_id: 20260905-prreview-tier-budget
tags:
  - pr-review
  - time-budget
  - degradation-ladder
  - seat-prompts
  - instrumentation
---

# Multi-agent pipeline time budgeting: wall-clock targets + engine-owned caps + declared degradation

## Context

`amazing-pr-review` (three-tier review pipeline) had no duration contract: seat waves were serial, per-seat reads/outputs were uncapped, synthesis vetted every finding at full depth, and nothing measured elapsed time — so wall-clock scaled randomly with PR shape (external research point: multi-agent systems cost ~15x chat tokens; latency is the first metric to move — Anthropic multi-agent research system, CodeRabbit rollout guidance).

## Guidance

The landed pattern has four separable layers — keep them separate when porting:

1. **Wall-clock targets are a product contract; per-seat caps are an engine contract.** One constant table (`PR_REVIEW_TIER_BUDGETS`: tier → wall-clock minutes / maxSeats / perSeatFindingsCap / evidenceTokensCap / fileOpenCap) is the SSOT; seat prompts render their caps from it (single rendering point, source-hygiene test guards against literals), prose tables carry only the wall-clock minutes. Never dual-home cap numbers.
2. **Enforcement = prompt discipline + falsification, not host kills.** Hosts own subagent sessions; the engine cannot terminate them. Budgets ride in the seat prompt ("when a cap is reached, stop expanding and return what you have — declare truncated coverage in the payload tail") and every report declares measured wall-clock (`elapsed` frontmatter, validator-checked) so targets are falsifiable next iteration. Do not build kill switches you cannot own.
3. **Predefine the degradation ladder before it is needed, and split it from the never-degrade list.** Order: read-depth first (adjacent-context follow-ups), then seat topology (fold waves; never on security-sensitive surfaces), then display (nit folding). Verdict-from-tally, posting ownership, evidence `file:line` + self-check, and report archival are never tradeable — enumerate both lists verbatim or seats will improvise.
4. **Collapse coordination waves when the artifact already carries the payload.** A pinned diff pack (commits + stat + diff) makes a separate collect wave redundant: fold collection into domain seats (`collectFolded` prompt option; stage-1 + collectFolded is a TypeError; missing pack fails loud). Simple parallel beats over-coordination.

Plus one iteration-process lesson: **when a later plan changes a shared-file default, sweep every earlier plan's surface for glosses that restate the old default** — the deep-tier table row and two stale glosses contradicted the fold default after SP2 landed, and only the QC tri caught it (task reviews each saw only their own sections). Budget a grep sweep per plan QC for any N-plan iteration sharing one SSOT file.

## Why This Matters

Without the four-layer split, budget tuning degenerates: numbers drift between prose and code, seats overrun silently, degradation happens ad hoc (cutting evidence or verdict discipline instead of reads), and targets stay unfalsifiable so no iteration can calibrate them.

## When to Apply

Any mstar workflow with host-dispatched seats and a duration expectation: PR review tiers now; the same shape ports to SDD QC waves, audit fan-outs, or any orchestrator that must promise "done in N minutes at ~100 tok/s".

## Examples

- Tier budget table + seat-prompt `## Budget` block + degradation ladder: `skills/mstar-audit/references/pr-review.md` § Review depth / § Time budget & degradation ladder; `packages/engine/src/prreview.ts` `PR_REVIEW_TIER_BUDGETS` / `prReviewSeatPrompt`.
- Fail-loud contradiction guards: `collectFolded` requires stage 2 + a pinned diff pack and refuses security seats — the engine refuses semantically impossible dispatches instead of rendering self-contradictory prompts.
- `elapsed` instrumentation: report frontmatter validated by `validatePrReviewReport`; measurement duty lives in `commands/amazing-pr-review.md` (setup → archive).

## Source

Iteration `iter-20260905-pr-review-time-budget` (plans 20260905-prreview-tier-budget / -context-pack / -synthesis-slim); design rationale and external research: iteration package `guides/research-notes.md`.
