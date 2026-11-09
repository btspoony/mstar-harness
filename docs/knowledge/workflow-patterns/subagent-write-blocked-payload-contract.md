---
module: skills/mstar-audit/references/pr-review-seat-evidence.md
date: 2026-08-26
problem_type: workflow_issue
category: workflow-patterns
severity: high
applies_when:
  - "Dispatching any subagent fan-out (audit, review, research) whose seats must produce evidence or findings"
  - "Designing a contract that assumes a subagent can write files"
  - "Running the amazing-pr-review pipeline (quick/default/deep tiers)"
plan_id: 20260826-pr-review-skill-sync
tags:
  - subagent
  - write-blocked
  - evidence
  - payload
  - sandbox
  - audit
  - eperm
---

# Subagent seats may be write-blocked: return evidence in the result payload, main agent writes files

## Context

During a real deep-tier `/amazing-pr-review` run, all three Stage-1 collect seats (dispatched as `scout`-type agents) were **write-blocked**: the scout sandbox is read-only and every attempt to write an evidence file failed with `EPERM`. The evidence directory came back EMPTY; the seats had delivered their content in their result payloads instead, and the orchestrator had to extract each seat's artifact and write the files itself. The same can happen to ANY subagent seat during an audit — not just `scout`/`explorer`/`general`.

## Guidance

1. **Never make a contract depend on a seat's ability to write.** Any subagent may run in a read-only sandbox (EPERM on file writes). A pipeline that requires seats to write evidence files fails silently — the files never land and the orchestrator only discovers the loss post-hoc as a "missing domain".
2. **Seats return evidence/findings in their result payload.** The seat's deliverable is its structured output: `file:line` observations, issue surfaces, security observations (per `security-review.md` §2/§3 research discipline), MEDIUM/unverified items as leads. No verdict, no findings table, no posting.
3. **The main agent writes/consolidates all files.** The orchestrator extracts each seat's payload and writes the evidence files (naming per `pr-review.md` § Local report archive: `<YYYY-MM-DD>-pr<N>-stage{1,2}-<slug>.md`, bare-branch/diff variants, same-day `-r2` collision rule). Writable seats may best-effort write files in addition, but the contract never requires it.
4. **Seat prompts must say so.** Every seat prompt carries the seat-evidence contract (`references/pr-review-seat-evidence.md`): "you may be write-blocked; return evidence in your result payload; never attempt to write files". Stage 1 (collect) and Stage 2 (domain findings) prompts differ — do not load the collect contract onto findings seats.
5. **Failure detection is mechanical.** A domain whose seat returned no evidence (crashed / Blocked / empty output) is an uncollected domain, declared under `- unverified:` / `- notes:`.

## Why This Matters

Write-blocked seats are the norm for lightweight read-only agents, not the exception. A contract that assumes seat writes produces silent evidence loss and a degraded synthesis. The payload-return contract is uniform, write-blocked-safe, and keeps a single write owner (the main agent) with one write discipline (primary checkout, never the review worktree).

## When to Apply

- Any subagent fan-out whose seats produce evidence or findings (amazing-pr-review, full-audit category clusters, research scouts).
- Any new skill/command that dispatches subagents and expects file outputs.

## Examples

- `skills/mstar-audit/references/pr-review-seat-evidence.md` — the seat evidence contract (renamed from `pr-review-scout-evidence.md` when the finding was generalized to all seats).
- `skills/mstar-audit/references/pr-review.md` § Review pipeline / § Local report archive — the SSOT for evidence-file ownership.

## Result

Contract generalized across `pr-review.md`, `leaf-executor-core.md` Audit Mode, `code-reviewer.md` Mode C, and `commands/amazing-pr-review.md`; zero residual `scout-evidence` references; QC tri round-2 all Approve.
