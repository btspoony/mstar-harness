---
name: amazing-pr-review
description: Deep, pre-merge review of a PR / branch / diff at three strengths — quick / default (default) / deep — one verdict, posted to GitHub when a PR number is given. Decides whether a change is safe to ship with evidence-backed findings, rather than a shallow "looks good" pass. Produces a `ship it` / `needs fixes` / `blocked` verdict. Do not use for self-checking a change you just authored.
agent: project-manager
input: "[pr|branch|scope] [quick|default|deep]"
---

# Deep PR Review

Run a read-only, evidence-first review of a PR / branch / diff and decide whether it is safe to ship. Output: one verdict — **computed from the finding tally**, never chosen（`score_pct` display-only）— plus findings presented to the user, and the posted GitHub Review URL when a PR number exists（posting is **mandatory** then）. Never auto-approve, never REQUEST_CHANGES, never merge. **Read-only advisory** — does not enter the plan state machine.

Procedure SSOT → **`mstar-audit` SKILL.md**（common core）+ **`references/pr-review.md`**（`pr` variant 全量：tier 解析、三阶段流水线、worktree isolation、posting、report archive、batch）. This command is a thin launcher — every contract lives in the reference.

## Boot

1. `mstar-harness-core`
2. `mstar-audit` → SKILL.md + `references/pr-review.md`
3. `mstar-coding-behavior` (evidence discipline)
4. `mstar-branch-worktree` (worktree isolation)
5. `mstar-host` → active host reference (invoke capability for parallel subagents)

## Execute

Execute **`mstar-audit` § `pr` variant end to end**（`references/pr-review.md`）：

1. **Tier first** — resolve `quick` / `default` / `deep` per **§ Review depth (tiers)**（显式 token > too-large > 敏感面 > large > small 推断阶梯；两 token 同现 → hard-stop 请用户二选一）→ 按 tier seat 计划执行（quick 1 席 / default 2 席 / deep 三阶段）。
2. **Isolate** — create the review worktree per **§ Worktree isolation**（real base，never assume `main`；empty changeset → stop；diff snapshot pinned at setup）→ fan out seats per **§ Review pipeline**（seats read-only，evidence/findings in result payload，never post；seat prompts get `--diff-file` via `mstar pr-review seat-prompt`）.
3. **Synthesize (main agent)** — dedupe + three-way vet → tally/verdict（**§ Tally and derived score**）→ persist the **`mstar.review/v1` envelope**（mandatory）→ report + GitHub Review POST per **§ Comment posting**（`posted: yes` / `n/a-no-pr` / `failed`；event fixed `COMMENT`）→ save local report + evidence files per **§ Local report archive**（all three posting branches）→ **then** worktree cleanup（`mstar pr-review worktree-cleanup`）.
4. **Batch** — one session = one PR per **§ Batch sibling PRs**；其余 PR → `mstar status backlog-register` 登记为 audit todos，建议各自独立 session.

Findings that need fixing → self-contained plans per **`mstar-audit` SKILL.md `## Plan output (all variants)`**（normal Prepare → Execute flow）. Report the verdict + findings + posted review URL; the `tier:` declaration and any downgrade/upgrade `- notes:` follow **§ Review depth (tiers)** report contract.
