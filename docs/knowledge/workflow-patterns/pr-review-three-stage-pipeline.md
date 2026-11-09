---
module: skills/mstar-audit/references/pr-review.md
date: 2026-08-26
problem_type: workflow_issue
category: workflow-patterns
severity: medium
applies_when:
  - "Running /amazing-pr-review on a single PR and needing multi-seat coverage with one verdict"
  - "Designing any multi-subagent review/audit pipeline that must not depend on seat write access"
  - "Handling a batch of PR numbers in one session"
plan_id: <plan-id>
last_updated: 2026-11-09
tags:
  - pr-review
  - audit
  - pipeline
  - subagent
  - evidence
  - posting-ownership
---

# amazing-pr-review three-tier pipeline: collect → domain review → main-agent synthesis

## Context

`/pr-deep-review` (now `/amazing-pr-review`) originally dispatched a single `code-reviewer` to review a PR end-to-end. Practice showed one seat cannot hold both code and security depth on a real PR, and a batch of PR numbers in one session diluted depth and multiplied concurrency cost. `iter-<plan-id>` rebuilt the flow as a three-stage pipeline with a one-session-one-PR policy.

## Guidance

1. **Three stages, one verdict, one GitHub Review.** Stage 1 — PM fans out lightweight read-only agents (`scout` / `explorer` / `general`, whatever the host offers) by **domain** (business domain / change surface / tech stack) to collect evidence. Stage 2 — mstar built-in roles (`code-reviewer` / `fullstack-dev` / `frontend-dev`) review each domain for code + security (security via `security-review.md` lens; large PR >~300 lines or security-sensitive surfaces add an independent cross-domain security seat). Stage 3 — the main agent (command orchestrator) synthesizes: dedupe → three-way vet (open each cited file itself) → tally → verdict → report + GitHub Review POST. Only the main agent posts; seats never post, never merge, never approve.
2. **Size-driven fan-out.** Small PR (~≤300 changed lines / single surface) → 2 collect seats baseline (code + security). Large PR → 2–3 collect seats by domain + cross-domain security seat. Reuse the existing `~300` / `~1000` sizing bands — never introduce a second set of numbers.
3. **Evidence = leads, not findings.** Collect-seat output and unchecked domain-seat notes are leads; a domain seat's Stage 2 output after it opened the cited code itself (`file:line`) is a formal finding; the main agent may still reject it during vet. A finding citing a collector's relay without its own self-check is disqualified.
4. **One session = one PR.** Multiple PR numbers in the argument → only the FIRST (caller mention order) gets the deep review; the rest are captured as open issues in `{HARNESS_DIR}/store.db` (`mstar issue add`, or `mstar plan issue-add` when a plan session owns the batch) with the recoverable `owner/repo#n` identity in the title, and the output suggests one session per PR (`skills/mstar-audit/references/pr-review.md` § Batch sibling PRs). The old `residuals.json` backlog register and `mstar status backlog-register` are retired.
5. **Posting ownership is the main agent's.** The GitHub Review POST (`event: COMMENT`, never APPROVE/REQUEST_CHANGES) is a command-level deliverable; the shared seat contracts (Audit Mode, Mode C) must not carry a seat-level POST carve-out.

## Why This Matters

A single-seat review under-covers security on real PRs; a batch session over-commits and loses track of un-reviewed PRs. The pipeline gives multi-seat coverage with exactly one verdict and one posted review, and turns un-reviewed PRs into a machine-checkable backlog instead of silent drops.

## When to Apply

- Any `/amazing-pr-review` invocation (single PR or multi-PR argument; quick/default/deep per § Review depth).
- Designing future multi-subagent review/audit pipelines: keep the collect → review → synthesize layering and the single-owner posting rule.

## Examples

- `skills/mstar-audit/references/pr-review.md` § Review pipeline (three-stage) — the SSOT.
- `skills/mstar-audit/references/pr-review-seat-evidence.md` — the seat evidence contract.
- `commands/amazing-pr-review.md` — Routing / tier routing / Three-stage execution.

## Result

Three plans (`<plan-id>`, `<plan-id>`, `<plan-id>`) — QC tri + QA Pass each; residuals R-W001/R-W002 closed in place; fragments under `.changes/unreleased/pr-review-*.md`.
