---
name: amazing-pr-review
description: Deep, pre-merge review of a PR / branch / diff at three strengths — quick / default (default) / deep — one verdict, posted to GitHub when a PR number is given. Decides whether a change is safe to ship with evidence-backed findings, rather than a shallow "looks good" pass. Produces a `ship it` / `needs fixes` / `blocked` verdict. Do not use for self-checking a change you just authored.
agent: project-manager
input: "[pr|branch|scope] [quick|default|deep]"
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

**档位解析** — 显式关键字优先；无 flag 时按推断阶梯（自上而下，首个命中即定档）：

1. **显式关键字**（`quick` / `default` / `deep`，亦认 `--quick` / `--deep` 拼写）→ 直接定档（用户意图 > 一切启发式）。`quick` 与 `deep` 同现 → **硬停止冲突**：报告冲突，请用户二选一，不静默取优先级。
2. **too-large**（> ~1000 变更行）→ advise split（既有规则不变）；坚持审 → `deep`。
3. **敏感面**（`security-review.md` §9 扩展面出现在 diff：auth / LLM / 供应链 / 数据面）→ `deep`（任何尺寸；安全敏感不打薄）。
4. **large**（> ~300 变更行 / 跨多变更面）→ `deep`（大 PR 不静默降档）。
5. **small**（≤ ~300 单面）：tiny-mechanical 形状（docs-only / 重命名 / 格式化 / 纯删除）→ `quick`；其余真实代码变更 → `default`。

复用既有 100 / 300 / 1000 sizing bands（`pr-review.md` § Sizing & change shape），不引入第二套数字：`~100`（tiny-mechanical 带）≈ `quick` 推荐域；`~300`（one logical change 上沿 = 扇出阈值）为 `default` 上界；`~1000`（too-large → advise split）语义不变。显式 `quick` + 敏感面 → 尊重用户，但该席仍须执行领域内 security lens，且报告 `- notes:` 声明「quick tier — reduced coverage on a security-sensitive surface」。

| Context | Who runs the review |
|---------|-------------------|
| **Single PR — `quick`**（1 席，≈ ¼ deep 席位时间） | 收集 + review 合入**同一席**一趟（不切领域）；席内带领域内 security lens；**无独立 security 席**；报告 `tier: quick` + `- notes:` 降档覆盖声明 |
| **Single PR — `default`**（2 席 ≈ ½ deep 席位时间） | 2 个领域席：收集合入领域席 = **席位复用**（Stage 1 不单独成波）；两席均带领域内 security lens；**无独立 cross-domain 席**（跨域边界问题记 `- notes:`，主代理可宣布升级 `deep`）；报告 `tier: default` |
| **Single PR — `deep`**（4–7 席） | 三阶段全走（= 现状逐字）：**Stage 1** 按领域扇出 2–3 轻量只读收集 agents（host scout/explorer/general）→ **Stage 2** 按同一领域派 2–3 mstar 内置角色（`code-reviewer` / `fullstack-dev` / `frontend-dev`）+ 大 PR/安全敏感面 0–1 独立 cross-domain security 席 → **Stage 3** 主代理合成：dedupe + three-way vet → tally/verdict → 报告 + 发布 GitHub Review；报告 `tier: deep` |
| **Multiple PRs** | 只对**第一个** PR 按档位路由走 review（同 Single PR）；其余 PR 登记为 audit todos（`{PROJECT_DIR}/_default/residuals.json`，`decision: defer`、`target: next session`、`tracking: pr-deep-review backlog`），并建议每个 PR 开独立 session |

All review seats are **read-only** in this flow: never edit the reviewed worktree, never merge, never approve-as-merge. **Stage 1** collect seats are the host's lightweight read-only agents (`scout` / `explorer` / `general`); **Stage 2** domain seats are mstar built-in roles (`code-reviewer` / `fullstack-dev` / `frontend-dev`). All seats run in **Audit Mode** (shared contract → `mstar-roles` `references/_shared/leaf-executor-core.md`). PM dispatches; every seat returns evidence / findings in its **result payload** (any seat may be **write-blocked**; writable seats may **best-effort** write their evidence file directly — the main agent writes / consolidates) — no verdict token, no posting; the main agent (PM / command thread) synthesizes and publishes.

## Execute

Execute **`mstar-audit`** § `pr` variant end to end（SKILL.md common core：recon + three-way attack & vet；variant detail：**`references/pr-review.md`** —— resolve the review **tier** first → **§ Review depth (tiers)**（档位表 + 推断阶梯 + seat 计划 + 报告 `tier` 声明）; the linear `scope → guidance load → concern lenses → evidence → verdict → output` path is **Stage 3's** read of the variant; seats run per the tier's seat plan and **§ Review pipeline**）. Review is run in a dedicated worktree against a diff from the PR's **real base** — resolve the base per `references/pr-review.md` § Worktree isolation (never assume `main`).
**Tiered execution** — the resolved tier（§ Review depth (tiers)）shapes the run: `deep` = 三阶段全走（现状逐字）；`default` = 2 领域席、收集合入领域席（Stage 1 不单独成波）；`quick` = 1 席、收集 + review 同席。The deep tier runs the pipeline in **`references/pr-review.md`** § Review pipeline: **Stage 1** collect seats fan out by domain and return evidence in their result payload; **Stage 2** domain seats review code + security and return findings; **Stage 3** the main agent (PM / command thread) synthesizes. **Any seat may be write-blocked** (read-only sandbox / EPERM) — seats return evidence / findings in their **result payload** and are **never required to write files**; writable seats may **best-effort** write their evidence file directly; the main agent **writes / consolidates all evidence files** from seat payloads → dedupe + three-way vet → tally/verdict → report + GitHub Review POST. Posting has three branches (§ Comment posting): `posted: yes` / `n/a-no-pr` / `failed` — chat output and the local report are delivered in all three. Worktree cleanup is done by the main agent once the local report is saved — the save runs in all three posting branches (`posted: yes` / `n/a-no-pr` / `failed`), so cleanup does not wait on POST success (§ Worktree isolation / § Local report archive).

Review findings that need fixing can be turned into self-contained plans for the normal Prepare → Execute flow (reusing `mstar-audit` SKILL.md **`## Plan output (all variants)`** — same contract as the `pr` variant).

Output verdict + findings to the user, with the posted GitHub Review URL. Posting procedure (when a PR number exists) → **`references/pr-review.md`** § Comment posting; the main agent saves the Stage 3 report and writes/consolidates the evidence files — every seat returns evidence / findings in its **result payload** (any seat may be write-blocked); writable seats may **best-effort** write files in addition → **`references/pr-review.md`** § Local report archive. Never auto-approve or merge.
