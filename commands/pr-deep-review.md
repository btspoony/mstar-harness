---
name: pr-deep-review
description: Use when asked to deeply review a pull request, branch, or diff before merge — deciding whether a change is safe to ship with evidence-backed findings, rather than a shallow "looks good" pass. Produces a `ship it` / `needs fixes` / `blocked` verdict. Also for a batch of sibling PRs. Do not use for self-checking a change you just authored.
agent: project-manager
input: "[pr|branch|scope] [full]"
---

# Deep PR Review

Run a read-only, evidence-first deep review of a pull request, branch, or diff and decide whether it is safe to ship. When a PR number exists, posting the GitHub Review is **mandatory** — the review is not complete until comments land on the PR. Output: verdict + findings presented to the user, plus the posted review URL. Never auto-approve, never REQUEST_CHANGES, never merge.

The verdict is **computed from the finding tally** (`must-fix` / `should-fix` / `nit` + `unverified`); `score_pct` is display-only feedback and never overrides it. Procedure and formula → **`references/pr-review.md`** § Verdict synthesis / Tally and derived score.

**Read-only advisory.** The review does not enter the harness plan state machine (`Todo → InProgress → InReview → Done`). Reviewers never edit the worktree, never merge, and never approve-as-merge.

## Boot

1. `mstar-harness-core`
2. `mstar-audit` → SKILL.md（common core）+ `references/pr-review.md`（`pr` variant 全量）
3. `mstar-coding-behavior` (evidence discipline)
4. `mstar-branch-worktree` (worktree isolation)
5. `mstar-host` → active host reference (invoke capability for parallel subagents)

## Routing（谁执行 review）

| Context | Who runs the review |
|---------|-------------------|
| **Small PR / single pass** | PM dispatches a single `@code-reviewer` — review, then vet and synthesize the verdict |
| **Batch of sibling PRs** | PM 按 PR 业务信息（业务域 / 变更面 / 技术栈）**平均分配**到四个席位：`@code-reviewer`（general）、`@fullstack-dev`、`@fullstack-dev-2`、`@frontend-dev` — 每个席位承载约 N/4 个 PR，摊薄同模型并发，降低 rate-limit。All worktrees created first, then all reviewers dispatched in one batch; each reviewer owns review + comment for its PRs only |

All review seats (`code-reviewer` / `fullstack-dev` / `fullstack-dev-2` / `frontend-dev`) are **read-only** in this flow: never edit the reviewed worktree, never merge, never approve-as-merge. Implementer seats run in **Audit Mode** (shared contract → `mstar-roles` `references/_shared/leaf-executor-core.md`). PM dispatches; each reviewer executes the `pr` variant and returns findings + verdict to PM for consolidation.

## Execute

Execute **`mstar-audit`** § `pr` variant end to end（SKILL.md common core：recon + three-way attack & vet；variant detail：**`references/pr-review.md`** —— scope → guidance load → concern lenses → evidence → verdict → output）. Review is run in a dedicated worktree against a diff from the PR's **real base** — resolve the base per `references/pr-review.md` § Worktree isolation (never assume `main`).

Review findings that need fixing can be turned into self-contained plans for the normal Prepare → Execute flow (reusing `mstar-audit` SKILL.md **`## Plan output (all variants)`** — same contract as the `pr` variant).

Output verdict + findings to the user, with the posted GitHub Review URL. Posting procedure (when a PR number exists) → **`references/pr-review.md`** § Comment posting. Never auto-approve or merge.
