# Deep PR Review Process

Read-only, evidence-first review of a pull request / branch / diff, producing exactly one verdict: `ship it` / `needs review` / `blocked`. Runs under `mstar-audit` § `pr` variant, reusing the Recon → Audit → Vet discipline (recon = PR scope + repo guidance; vet = three-way attack). The reviewer never edits the worktree, never merges, and never approves-as-merge.

## Worktree isolation

- **Resolve the real base first** — never assume `main`:
  - Reviewing a PR: `gh pr view N --json baseRefName --jq .baseRefName` → `<base>`.
  - Reviewing a bare branch/diff: resolve the remote default via `git symbolic-ref refs/remotes/origin/HEAD` (fall back to `origin/main` only when it genuinely is the default).
- Choose the local branch name **before any fetch** — `pr-<n>` may already exist (a stale review, another reviewer's branch, the user's own branch); the fallback must also be collision-free, so loop until the recorded name is provably fresh:
  ```
  review_branch=pr-<n>
  i=1
  while git rev-parse --verify --quiet refs/heads/$review_branch; do
    review_branch=pr-<n>-$(date +%Y%m%d)-$((i++))
  done
  ```
  Record the final name as `<review-branch>` — it did not exist before this review created it.
- Establish the refs **with explicit refspecs**, then create the dedicated worktree — never the primary repo cwd, never another harness worktree:
  ```
  git fetch origin +refs/heads/<base>:refs/remotes/origin/<base>
  git fetch origin pull/<n>/head:<review-branch>
  git worktree add <path> <review-branch>
  cd <path>   # review from here — a new linked worktree, cannot touch the primary checkout
  ```
  The explicit `+refs/heads/<base>:refs/remotes/origin/<base>` refspec updates the remote-tracking ref even on single-branch/narrowed `fetch` configs, so `origin/<base>` is never stale or missing. Do **not** use `gh pr checkout <n>` as an alternative: it switches to the PR-head branch name (not the recorded `<review-branch>`) and bypasses the ownership protocol. If you only have a PR ref, fetch it into the recorded name and `git worktree add` exactly as above.
- Compute the diff basis **inside the worktree, against the recorded refs — never the primary `HEAD`** (the primary checkout may sit on a different branch):
  ```
  cd <path>
  git diff origin/<base>...<review-branch>   # three-dot: changes on the reviewed branch since the merge-base
  ```
- **Bare branch input** (no PR number) — review the remote branch directly; no local ownership protocol needed:
  ```
  git fetch origin +refs/heads/<branch>:refs/remotes/origin/<branch>
  git worktree add --detach <path> origin/<branch>   # detached worktree; creates no local branch
  cd <path>
  git diff origin/<base>...origin/<branch>   # three-dot against the fetched remote-tracking ref
  ```
  Cleanup: `git worktree remove <path>` + `git worktree prune` only — there is no local branch to delete.
- **Arbitrary diff input** (a changeset handed to the review, no ref attached) — review the provided diff as-is:
  - Verify its provenance first (stated base/head SHAs when present); do not invent a checkout or substitute a different ref.
  - Read the changed files in the current directory for context; the diff itself is the isolated changeset under review.
  - No worktree, no branch, no fetch — nothing to clean up.
- Record before computing: review cwd, `<review-branch>`, HEAD sha, merge-base.
- Clean up after the review (and after the comment is posted): `git worktree remove <path>` + `git worktree prune`, then delete **exactly** the recorded `<review-branch>` — it was verified not to exist before the fetch created it, so it is provably this review's own branch; never delete a pre-existing branch. Never remove other harness worktrees.

## Scoping

- Review the diff basis vs base: changed files plus what the change touches.
- Read changed files **in full** — diffs hide context.
- Inspect adjacent behavior when risk leaks past the named diff (importers, callers, dependent contracts).

## Concern lenses

Generic lenses:

- `general` — repo guidance compliance, bugs, security, awkward complexity. Ignore lint-covered cosmetics.
- `technical-coverage` — behavior coverage, real-surface proof, mock-heavy seams. Ignore blanket coverage demands.
- `silent-failures` — swallowed errors, misleading fallbacks, unclassified failures, lossy logging.

Conditional lenses:

- `types` — invariants, escape hatches (`any` / `as` / `unknown`), schema drift, parse-don't-validate. Apply when types carry meaning (API / data layer / migration).
- `cleanup` — dead code, duplicate logic, indirection without value. Apply for refactors and added-then-removed surfaces.
- `comments` — comment rot, docstring truthfulness. Apply when docs changed.

**Selection by change shape** (UI / API / migration / refactor / doc / tiny mechanical). Default set = `general` + `technical-coverage` + `silent-failures`. Never spawn all lenses blindly; tiny mechanical diffs → `general` only.

## Evidence rules

- Static findings cite exact file references (`path/file.ts:123`).
- Run the **smallest runtime check that changes the verdict** (targeted command, not the full suite).
- Mark unverified explicitly — a claim without verification is a lead, not a finding.
- Mock-heavy tests around risky behavior = a finding (no real-surface proof), not proof of correctness.
- What disqualifies a finding (no evidence, by-design, secret values, ungrounded suggestions) → **`references/finding-format.md`** § What disqualifies a finding.

## Attack and vet

Before writing a finding, run the three-way attack from `mstar-audit`:

1. **Counter-example** — find a boundary case that makes the claim not hold.
2. **Simpler explanation** — does a simpler explanation cover the same evidence?
3. **Evidence verifiability** — open the cited lines and check they actually support the claim.

Then open cited code yourself and dispose by-design / mis-attributed / duplicate. Subagents over-report; vet before presenting.

## Verdict synthesis

- Order findings by impact-if-shipped.
- Cut to the top 1–3 unless `full` was requested.
- No padding, no invented requirements, no style grading.
- Choose exactly one verdict:
  - `ship it` — evidence-backed, safe to ship.
  - `needs review` — issues found; address before merge.
  - `blocked` — a must-fix issue stands in the way of shipping.

## Linked-issue hygiene

If the PR closes/fixes a tracked issue, score **every** acceptance criterion against the diff:

- Mark each: met / unmet / cut.
- Leftover criteria get a follow-up or a narrowed scope **before** merge, with reasoning on the review comment.
- Do not invent a follow-up when all criteria landed.

## CI attribution

Check base-vs-branch before blaming the diff for CI failures. A red build that predates the branch is not a finding against the PR.

## Comment triage

- Judge the validity of bot/peer review comments before acting on them.
- The reviewer seat is read-only — never edit the reviewed worktree. For valid comments, fold the minimal fix suggestion into the finding/plan (plan output) for the Prepare → Execute flow. For invalid comments, disagree on the PR comment with clear reasoning. Never gold-plate.

## Batch sibling PRs

- One worktree + one reviewer per PR.
- All worktrees created **first**; all reviewers dispatched in **one batch**.
- PM 按 PR 业务信息（业务域 / 变更面 / 技术栈）将 batch **平均**分配到四个席位（`code-reviewer` general、`fullstack-dev`、`fullstack-dev-2`、`frontend-dev`），每席位约 N/4 个 PR —— 摊薄同模型并发，降低 rate-limit。
- Implementer seats (`fullstack-dev` / `fullstack-dev-2` / `frontend-dev`) run under **Audit Mode** (shared contract → `mstar-roles` `references/_shared/leaf-executor-core.md`) — same read-only contract as `code-reviewer`.
- Each reviewer owns review + comment for that PR only.
- Sibling interactions are **noted, not fixed**, unless the ticket says so.

## Plan output（handoff to execution）

Review findings that need fixing can become plans for the normal Prepare → Execute flow — same contract as **`mstar-audit` SKILL.md** `## Plan output (all variants)`:

- Write the top findings as self-contained plans (numbered `001-<slug>.md` + `README.md` index — top findings only; the verdict is presented separately).
- The review itself stays read-only: plans are written only when the user selects findings to pursue.

## Comment posting

Posting the GitHub Review is a **mandatory deliverable** of the `pr` variant — chat-only output is incomplete when a PR exists. The review seat that owns the PR posts it; PM only reports the URL.

- **Before anything else:** synthesize the verdict first, then post **before** worktree cleanup (see § Worktree isolation — cleanup happens after the comment is posted).
- **No PR number** (bare branch / arbitrary diff): set `comments: n/a-no-pr` and skip the API. Chat output still required; this is not a Blocked review.
- **Auth / API failure:** deliver the chat verdict anyway; Completion Report status `Partial`/`Blocked` with the `gh` error. Do not claim `Done` — comments are mandatory when a PR exists.

### Procedure

1. Resolve the target — `owner/repo`, PR number, head SHA:
   ```
   gh pr view <n> --json url,headRefOid,headRepository
   ```
   `headRefOid` is the `commit_id`; `headRepository.owner.login` / `headRepository.name` give `owner/repo`.
2. Build one review payload:
   - `event`: `COMMENT` — **never** `APPROVE`, **never** `REQUEST_CHANGES`, never a merge.
   - `commit_id`: the PR head SHA.
   - `body`: verdict + ranked findings (short) + linked-issue leftover reasoning + optional folded plan index (below).
   - `comments[]`: one entry per finding whose `path` + `line` is in the three-dot diff, `side: RIGHT`. Finding body = title + evidence + impact + fix sketch — not the whole plan.
3. Post it:
   ```
   gh api --method POST repos/{owner}/{repo}/pulls/<n>/reviews --input -
   ```
   (payload on stdin).
4. **Line fallback:** if GitHub rejects some inline comments (e.g. 422 — line not in the diff), retry the review **without** those entries and fold them into the summary body. Do not loop more than once.
5. Record `html_url` / review id for `comments:`. Only now clean up the worktree (or after the n/a-no-PR skip).
6. **Batch:** each reviewer posts on **their own PRs** only. No second PM summary comment unless the Assignment says so.

### Folding plans into the summary

Fold follow-up plans into the review body **only if** this review wrote them. A short index — title, priority, effort, 1–3 sentence sketch, plan path — inside:

```
<details><summary>Follow-up plans</summary>

- <plan title> — P1, S: <1–3 sentence sketch> (`{PLAN_DIR}/audit-<date>/NNN-<slug>.md`)
</details>
```

Never dump full plan files.

## Output shape

Verbatim labels, in order:

- `- findings:` — list of evidence-backed findings (`none` when none).
- `- verdict:` — one of `ship it` / `needs review` / `blocked`.
- `- evidence:` — concise what-checks-proved summary.
- `- unverified:` — residual unverified claims, or `none`.
- `- next:` — one of `implementation` / `verify` / `docs`.
- `- comments:` — GitHub Review posting status (see § Comment posting):
  - `posted: yes` | `n/a-no-pr` | `failed`
  - `review_url: <url>` | `n/a`
  - `inline: <N> posted / <M> attempted (<K> summary-only fallback)`
  - `plans_folded: yes` | `no`
