---
name: pr-deep-review
description: Use when asked to deeply review a pull request, branch, or diff before merge — deciding whether a change is safe to ship with evidence-backed findings, rather than a shallow "looks good" pass. Produces a `ship it` / `needs review` / `blocked` verdict. Also for a batch of sibling PRs. Do not use for self-checking a change you just authored.
agent: project-manager
input: "[pr|branch|scope] [full]"
---

# Deep PR Review

Run a read-only, evidence-first deep review of a pull request, branch, or diff and decide whether it is safe to ship. Output: verdict + findings presented to the user; optional `gh pr comment` is a separate explicit step — never auto-approve or merge.

**Read-only advisory.** The review does not enter the harness plan state machine (`Todo → InProgress → InReview → Done`). Reviewers never edit the worktree, never merge, and never approve-as-merge.

## Boot

1. `mstar-harness-core`
2. `mstar-audit` → SKILL.md（`pr` scope variant + references）
3. `mstar-coding-behavior` (evidence discipline)
4. `mstar-branch-worktree` (worktree isolation)
5. `mstar-host` → active host reference (invoke capability for parallel subagents)

## Routing（谁执行 review）

| Context | Who runs the review |
|---------|-------------------|
| **Small PR / single pass** | PM dispatches a single `@code-reviewer` — review, then vet and synthesize the verdict |
| **Batch of sibling PRs** | One `@code-reviewer` per PR: all worktrees created first, then all reviewers dispatched in one batch; each reviewer owns review + comment for that PR only |

The `code-reviewer` seat is **read-only**: never edits the reviewed worktree, never merges, never approves-as-merge. PM dispatches; the reviewer executes the `pr` variant and returns findings + verdict to PM for presentation.

## Execute

Execute **`mstar-audit`** § `pr` variant end to end（scope → guidance load → concern lenses → evidence → three-way attack & vet → verdict → output）. Review is run in a dedicated worktree against `git diff origin/main...HEAD` — see `references/pr-review.md` for the full process.

Review findings that need fixing can be turned into self-contained plans for the normal Prepare → Execute flow (reusing **`mstar-audit`** Phase 4 + Handoff).

Output verdict + findings to the user; `gh pr comment` is a separate explicit step — never auto-approve or merge.
