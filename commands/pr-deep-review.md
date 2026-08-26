---
name: pr-deep-review
description: Use when asked to deeply review a pull request, branch, or diff before merge — deciding whether a change is safe to ship with evidence-backed findings, rather than a shallow "looks good" pass. Produces a `ship it` / `needs fixes` / `blocked` verdict. Also for a batch of sibling PRs. Do not use for self-checking a change you just authored.
agent: project-manager
input: "[pr|branch|scope]"
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
6. 多 PR 输入的 batch 语义 → `references/pr-review.md` § Batch（one session = one PR；first-only + audit todos）

## Routing（谁执行 review）

| Context | Who runs the review |
|---------|-------------------|
| **Single PR** | PM 解析 base/diff（§ Worktree isolation）→ **Stage 1** 按领域扇出轻量只读收集 agents（host scout/explorer/general）→ **Stage 2** 按同一领域派 mstar 内置角色（`code-reviewer` / `fullstack-dev` / `frontend-dev`）做 code+security review（大 PR/安全敏感面加独立 security 席）→ **Stage 3** 主代理合成：dedupe + three-way vet → tally/verdict → 报告 + 发布 GitHub Review |
| **Multiple PRs** | 只对**第一个** PR 走三阶段 deep review（同 Single PR 行）；其余 PR 登记为 audit todos（`{PROJECT_DIR}/_default/residuals.json`，`decision: defer`、`target: next session`、`tracking: pr-deep-review backlog`），并建议每个 PR 开独立 session |

All review seats are **read-only** in this flow: never edit the reviewed worktree, never merge, never approve-as-merge. **Stage 1** collect seats are the host's lightweight read-only agents (`scout` / `explorer` / `general`); **Stage 2** domain seats are mstar built-in roles (`code-reviewer` / `fullstack-dev` / `frontend-dev`). Implementer seats run in **Audit Mode** (shared contract → `mstar-roles` `references/_shared/leaf-executor-core.md`). PM dispatches; domain seats run **Stage 2** of § Review pipeline and return findings + evidence-file paths — no verdict token, no posting; the main agent (PM / command thread) synthesizes and publishes.

## Execute

Execute **`mstar-audit`** § `pr` variant end to end（SKILL.md common core：recon + three-way attack & vet；variant detail：**`references/pr-review.md`** —— the linear `scope → guidance load → concern lenses → evidence → verdict → output` path is **Stage 3's** read of the variant; seats run Stage 1 / Stage 2 per § Review pipeline）. Review is run in a dedicated worktree against a diff from the PR's **real base** — resolve the base per `references/pr-review.md` § Worktree isolation (never assume `main`).
**Three-stage execution** — single-PR deep review runs the pipeline in **`references/pr-review.md`** § Review pipeline: **Stage 1** collect seats fan out by domain and write evidence files; **Stage 2** domain seats review code + security and return findings; **Stage 3** the main agent (PM / command thread) synthesizes. The main agent owns Stage 3: collect the evidence files → dedupe + three-way vet → tally/verdict → report + GitHub Review POST. Posting has three branches (§ Comment posting): `posted: yes` / `n/a-no-pr` / `failed` — chat output and the local report are delivered in all three. Worktree cleanup is done by the main agent once the local report is saved — the save runs in all three posting branches (`posted: yes` / `n/a-no-pr` / `failed`), so cleanup does not wait on POST success (§ Worktree isolation / § Local report archive).

Review findings that need fixing can be turned into self-contained plans for the normal Prepare → Execute flow (reusing `mstar-audit` SKILL.md **`## Plan output (all variants)`** — same contract as the `pr` variant).

Output verdict + findings to the user, with the posted GitHub Review URL. Posting procedure (when a PR number exists) → **`references/pr-review.md`** § Comment posting; the main agent saves the Stage 3 report and writes/consolidates the evidence files — collect seats return evidence in their result payload (write-blocked), writable domain seats may write files or return payload → **`references/pr-review.md`** § Local report archive. Never auto-approve or merge.
