---
name: amazing-pr-review
description: "Deep pre-merge review of a PR / branch / diff at quick / default / deep strength: one tally-derived verdict, findings, and the posted GitHub review when a PR number exists. Read-only advisory — never approves, requests changes, or merges. Not for self-reviewing your own change."
agent: project-manager
input: "[pr|branch|scope] [quick|default|deep]"
---

# Deep PR Review

A read-only, evidence-first review that decides whether a change is safe to ship. Output: the verdict computed from the finding tally (`ship it` / `needs fixes` / `blocked` on a settled run, or the derived `incomplete` override with its cause and unscanned scope), a display-only score band, the findings, and the GitHub Review URL when a PR number exists — posting is then mandatory, and the review never APPROVE / REQUEST_CHANGES / merges. **Advisory** — it does not enter the plan state machine.

**Procedure SSOT** → `mstar-audit` SKILL.md (common core) + `references/pr-review.md` (`pr` variant: target resolution and re-review, tier ladder and budgets, three-stage pipeline, worktree isolation, synthesis, posting, report archive, batch).

## Boot

1. `mstar-harness-core`
2. `mstar-audit` → SKILL.md + `references/pr-review.md`
3. `mstar-coding-behavior` (evidence discipline) · `mstar-branch-worktree` (worktree isolation)
4. `mstar-host` → active host reference (invoke capability; on dsh the `deep` tier's seats run the native `workflow` script `mstar-pr-seats` → `references/dsh-workflow-scripts.md` §3)

## Execute

Execute **`mstar-audit` § `pr` variant end to end** (`references/pr-review.md`): resolve the target first and follow § Re-review when a prior report covers it, then resolve the tier per § Review depth (tiers) against that resolved scope and run the tier's seat plan under its wall-clock budget. One session reviews one PR; deferred sibling PRs are captured as issues (§ Batch sibling PRs), and a capture failure is `Blocked`.

## Report

Verdict + findings + posted review URL, the `tier:` declaration with any degradation `- notes:` (§ Review depth), and the archived local report plus evidence under `{REVIEW_DIR}/<date>-pr<N>/`.
