# Deep PR Review Process

Read-only, evidence-first review of a pull request / branch / diff, producing exactly one verdict: `ship it` / `needs fixes` / `blocked`. Runs under `mstar-audit` § `pr` variant, reusing the Recon → Audit → Vet discipline (recon = PR scope + repo guidance; vet = three-way attack). The reviewer never edits the worktree, never merges, and never approves-as-merge.

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
- **Uncommitted / working-tree input** ("review my changes", no ref): changeset = `git diff` + `git diff --cached`, plus untracked files via `git ls-files --others --exclude-standard`, in the current checkout (read new files in full — the diff cannot see them); no worktree, no fetch, no branch; the review is still read-only (no fixes, no stash); `comments: n/a-no-pr`.
- **Single-commit input** (commit SHA / short hash): changeset = `git show <sha>`; arbitrary-diff rules apply — verify provenance, read the changed files in the current directory for context, no worktree.
- **Pre-flight (all modes):** before fanning out lenses, confirm any named refs resolve (in modes that have refs) and the changeset is non-empty (in all modes) — an empty changeset reports "no changes to review" and stops; never spawn lenses on an empty diff.
- Record before computing: review cwd, `<review-branch>`, HEAD sha, merge-base.
- Clean up after the review (and after the comment is posted): `git worktree remove <path>` + `git worktree prune`, then delete **exactly** the recorded `<review-branch>` — it was verified not to exist before the fetch created it, so it is provably this review's own branch; never delete a pre-existing branch. Never remove other harness worktrees.

## Scoping

- Review the diff basis vs base: changed files plus what the change touches.
- Read changed files **in full** — diffs hide context.
- Inspect adjacent behavior when risk leaks past the named diff (importers, callers, dependent contracts).
- When the diff touches tests, read the tests before the implementation — they carry intent.
- Verification claims in the PR description must be reproducible from the diff/CI; a claim that cannot be checked is an `unverified` lead, not evidence.

## Sizing & change shape

- **Sizing bands:** ~100 changed lines → reviewable; ~300 → acceptable as one logical change; ~1000 → too large — advise a split (a `should-fix` finding with split advice, or a verdict note; never auto-`blocked`). Whole-file deletions and mechanical/automated refactors are exempt — verify intent, not every line.
- **File-size watch:** a small diff that materially grows a file past ~1000 *total* lines → advise extract/decompose first ("decompose, then add").
- **Split strategies:** stack · by file group · horizontal (shared code first) · vertical (full-stack slices); refactoring and feature work travel in separate changes.
- **Escalation by change shape:**

| Shape | Action |
| --- | --- |
| Database schema change | widen scrutiny |
| API contract change | widen scrutiny |
| New framework/library adoption | widen scrutiny |
| Performance-critical path | widen scrutiny — playbook §3 Performance depth |
| Security-sensitive surface | widen scrutiny — load `references/security-review.md` |

These shapes get deeper review, not automatic severity — name the escalation in the review body.

## Concern lenses

Generic lenses:

- `general` — repo guidance compliance, bugs, security, awkward complexity. Ignore lint-covered cosmetics.
- `technical-coverage` — behavior coverage, real-surface proof, mock-heavy seams. Ignore blanket coverage demands.
- `silent-failures` — swallowed errors, misleading fallbacks, unclassified failures, lossy logging.

Conditional lenses:

- `types` — invariants, escape hatches (`any` / `as` / `unknown`), schema drift, parse-don't-validate. Apply when types carry meaning (API / data layer / migration).
- `cleanup` — dead code, duplicate logic, indirection without value. Apply for refactors and added-then-removed surfaces.
- `comments` — comment rot, docstring truthfulness. Apply when docs changed.

**Smell baseline** (under `general`): twelve labelled smells — one line each, what it is → remedy direction:

- Mysterious Name — unclear what it does/why → rename to intent.
- Duplicated Code — same shape in ≥2 places → extract the shared form.
- Feature Envy — method works mostly on another class's data → move it there.
- Data Clumps — same field groups travel together → promote to a single object.
- Primitive Obsession — domain concepts as bare primitives → introduce a type.
- Repeated Switches — same condition re-branched → replace with a dispatcher.
- Shotgun Surgery — one logical change touches many files → consolidate the coupling.
- Divergent Change — one class changes for many reasons → split by reason.
- Speculative Generality — flexibility nothing uses → delete it.
- Message Chains — callers wade through a.getB().getC() → hide the walk behind one method.
- Middle Man — class mostly delegates → fold or inline the pass-through.
- Refused Bequest — subclass inherits more than it wants → replace with composition.

Three binding rules: repo-documented standards override the baseline — a standards finding cites the standard's file + rule; anything tooling already enforces is skipped (existing `general` rule); smells are judgement calls — a smell alone is never `must-fix`, and a LOW-confidence smell without evidence is not a finding (existing disqualify rule): it goes on `- unverified:` per the § Merge class rule, never `nit`; an **evidenced** judgement-call smell may surface as `nit` with the smell label. No new lens row: repo-guidance conformance stays the `general` lens's job.

**Selection by change shape** (UI / API / migration / refactor / doc / tiny mechanical). Default set = `general` + `technical-coverage` + `silent-failures`. Never spawn all lenses blindly; tiny mechanical diffs → `general` only.

## Evidence rules

- Static findings cite exact file references (`path/file.ts:123`).
- Run the **smallest runtime check that changes the verdict** (targeted command, not the full suite).
- Mark unverified explicitly — a claim without verification is a lead, not a finding.
- Mock-heavy tests around risky behavior = a finding (no real-surface proof), not proof of correctness.
- A "doesn't follow repo conventions / should use an existing abstraction" finding must cite the exemplar the diff should have followed (`file:line`); the simplest acceptable implementation is not a style finding (lint-covered cosmetics are already ignored by the `general` lens).
- What disqualifies a finding (no evidence, by-design, secret values, ungrounded suggestions) → **`references/finding-format.md`** § What disqualifies a finding.

## Attack and vet

Before writing a finding, run the three-way attack from `mstar-audit`:

1. **Counter-example** — find a boundary case that makes the claim not hold.
2. **Simpler explanation** — does a simpler explanation cover the same evidence?
3. **Evidence verifiability** — open the cited lines and check they actually support the claim.

Then open cited code yourself and dispose by-design / mis-attributed / duplicate. Subagents over-report; vet before presenting.

## Verdict synthesis

- Order findings by impact-if-shipped; no padding, no invented requirements, no style grading.
- List **every** accepted finding — `must-fix`, `should-fix`, and nits alike; nothing is truncated.
- The verdict is **derived from the tally, not chosen**: classify every accepted finding (§ Merge class) → apply leftover `unmet` AC increments if any (§ Linked-issue hygiene) → apply **Verdict-from-tally** (§ Tally and derived score) → emit that one token. The reviewer does not pick a verdict by vibe.
- Exactly one verdict:
  - `ship it` — evidence-backed, safe to ship.
  - `needs fixes` — issues found; address before merge.
  - `blocked` — a must-fix issue stands in the way of shipping.

## Merge class (PR findings only)

Classify each **accepted** finding (after three-way vet) as exactly one class. Do not invent a fourth class. Do not derive class from `Confidence`.

| Class | Use when | Verdict effect |
| --- | --- | --- |
| `must-fix` | Shipping this issue is unsafe: correctness bug, security hole, data loss, auth/authz bypass, or a broken public contract. Same meaning as today's `blocked` gloss ("a must-fix issue stands in the way of shipping"). | Any count ≥ 1 → `blocked` |
| `should-fix` | A real issue that should be addressed before merge but is not itself a ship-stopper. Same meaning as today's middle gloss ("issues found; address before merge"). | Else if count ≥ 1 → `needs fixes` |
| `nit` | Optional cleanup, naming, comment, or small suggestion that does **not** change merge-readiness. Lint-covered cosmetics stay ignored (existing lens rule) — they are not findings. | Does not change verdict |

Tie-break: unsafe to ship → `must-fix`; should be addressed before merge but ship-safe → `should-fix`; otherwise `nit`. A LOW-confidence smell that fails evidence rules is **not** a finding (existing disqualify rules) — put it on `- unverified:` if it must be mentioned.

Presumptive-structural classes: a refactor that relocates complexity instead of reducing it · a change pushing a file past the size boundary with no decomposition · feature logic added to a shared module · a near-duplicate of an existing canonical helper · a silent fallback hiding an unclear invariant → default `should-fix`; downgrade to `nit` only with a stated reason; never `must-fix` on shape alone without correctness/security evidence.

Field placement: on each finding, `- **Merge class**: must-fix | should-fix | nit`, immediately after `Confidence` (before `Fix sketch`). The shared finding template (`references/finding-format.md`) is unchanged — this field is PR-review-only.

## Tally and derived score

Verbatim, applied after the three-way vet to **accepted** findings, then leftover unmet ACs:

```
must_fix   = count of accepted findings with Merge class: must-fix
should_fix = count of accepted findings with Merge class: should-fix
nit        = count of accepted findings with Merge class: nit
unverified = count of residual items under `- unverified:` (0 when `none`)

# leftover unmet ACs (§ Linked-issue hygiene) — tally increment, not a fourth class, not a second finding:
for each leftover AC marked unmet (not met, not cut):
    if that leftover is itself unsafe-to-ship / a broken public contract:
        must_fix += 1
    else:
        should_fix += 1

if must_fix >= 1:
    verdict = blocked
else if should_fix >= 1:
    verdict = needs fixes
else:
    verdict = ship it
```

`score_pct` — integer arithmetic only. Floor at 0. No decimals. No second formula:

```
score_pct = max(0, 100 - 40*must_fix - 15*should_fix - 3*nit - 10*unverified)
```

### Override invariant

```
Score never overrides verdict.
blocked + any score_pct       → not shippable
needs fixes + any score_pct   → still address findings before merge
ship it + score_pct < 100    → allowed (nits and/or unverified deducted)
High score_pct never means APPROVE. Low score_pct never means REQUEST_CHANGES.
```

### Worked examples (check table)

| must / should / nit / unverified | score_pct | verdict | Display line |
| --- | --- | --- | --- |
| 0 / 0 / 0 / 0 + 1 leftover unmet AC | 85 | `needs fixes` | `needs fixes · 85%` |
| 0 / 0 / 0 / 0 + 1 leftover unmet AC (unsafe-to-ship) | 60 | `blocked` | `blocked · 60%` |
| 0 / 0 / 2 / 0 | 94 | `ship it` | `ship it · 94%` |
| 0 / 0 / 0 / 2 | 80 | `ship it` | `ship it · 80%` |
| 0 / 1 / 0 / 0 | 85 | `needs fixes` | `needs fixes · 85%` |
| 0 / 1 / 1 / 0 | 82 | `needs fixes` | `needs fixes · 82%` |
| 1 / 0 / 0 / 0 | 60 | `blocked` | `blocked · 60%` |
| 1 / 2 / 1 / 1 | 17 | `blocked` | `blocked · 17%` |
| 3 / 0 / 0 / 0 | 0 (floor) | `blocked` | `blocked · 0%` |

`blocked · 60%` is still not shippable. `needs fixes · 85%` still means address findings.

## Originating spec discovery

Find the originating spec — the acceptance criteria live there, not in the diff:

- Issue references in the PR body / commit messages (`#123`, `Closes`, `Fixes`).
- A spec path the user named in the request.
- Repo candidates: `{SPECS_DIR}`, `docs/specs` / ADR directories, `STRATEGY.md` / `PRODUCT.md`, roadmap.
- None → ask the user once; still none → note "no spec available", score nothing, never invent requirements (existing rule).

## Linked-issue hygiene

When an originating spec exists (§ Originating spec discovery — a tracked issue, spec file, or ADR), score **every** acceptance criterion against the diff:

- Mark each: met / unmet / cut.

Leftover `unmet` criteria count against the verdict: they are **tally increments**, not extra findings (do not also emit a Merge-class finding for the same leftover — that would double-count). Each leftover AC marked `unmet` (not `met`, not `cut`) increments `should_fix` by 1, or `must_fix` by 1 when that leftover is itself a broken public contract / unsafe-to-ship. The increment lives in the tally procedure (§ Tally and derived score); apply Verdict-from-tally **after** it, so leftover `unmet` ACs cannot yield `ship it`. Score uses the existing formula only (`should_fix` deducts 15, `must_fix` deducts 40 — no second formula, no new tally key). Leftovers are already mentioned in the review `body` (§ Comment posting) — no fourth merge class.
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
- **Auth / API failure:** deliver the chat verdict anyway; Completion Report status `Partial`/`Blocked` with the `gh` error. Do not claim `Done` — comments are mandatory when a PR exists. **The local report is still saved** (§ Local report archive — posting failure does not skip archival).

### Procedure

1. Resolve the target — the **base** `owner/repo` (the repository that owns the PR number), PR number, head SHA:
   ```
   gh pr view <n> --json url,headRefOid
   ```
   `headRefOid` is the `commit_id`. Parse `owner/repo` from `url` (`https://github.com/{owner}/{repo}/pull/{n}`) — that is the **base** repo. **Never** use `headRepository` (a fork's owner/name); Reviews API paths are scoped to the repo that owns the PR.
2. Build one review payload:
   - `event`: `COMMENT` — **never** `APPROVE`, **never** `REQUEST_CHANGES`, never a merge.
   - `commit_id`: the PR head SHA.
   - `body`: follow **§ Report template (below)** — three sections (Verdict → Review → Plan to fix). `event` stays `COMMENT` — **never** `APPROVE`, **never** `REQUEST_CHANGES`, never a merge.
   - `comments[]`: one entry per finding whose `path` + `line` is in the three-dot diff, `side: RIGHT`. Finding body = title + evidence + impact + fix sketch — not the whole plan.
3. Post it:
   ```
   gh api --method POST repos/{owner}/{repo}/pulls/<n>/reviews --input -
   ```
   (payload on stdin).
4. **Line fallback:** if GitHub rejects some inline comments (e.g. 422 — line not in the diff), retry the review **without** those entries and fold them into the summary body. Do not loop more than once.
5. Save the local report (§ Local report archive) — **mandatory in all three branches**: POST succeeded (record `html_url` / review id for `comments:` first), POST failed, or `n/a-no-pr` (archive the chat display content). Only then clean up the worktree; bare branch/diff reviews have no worktree, but the save still happens.
6. **Batch:** each reviewer posts on **their own PRs** only. No second PM summary comment unless the Assignment says so.

### Report template (GitHub Review `body`)

The posted review body is a three-section report. Section order fixed; omit a subsection only when its content is genuinely empty (write `none`, never delete the heading). The block below shows only **fill-in slots**: a `<...>` that wraps descriptive text (`<verdict>`, `<n>`, `<finding title>`, …) is a slot — replace the whole bracket pair with real content and never render those brackets. The literal HTML tags in the template (`<details>`, `<summary>`, `<br>`) are **structural** — keep them verbatim so the collapsible block survives. The Slot rules below the template are guidance — never copy them into the posted body.

**Section emoji map** — verdict: `ship it` ✅ · `needs fixes` ⚠️ · `blocked` ⛔. Finding classes: 🔴 must-fix · 🟠 should-fix · 🔵 nit · ❓ unverified.

````markdown
## <verdict-emoji> Verdict: `<verdict>` · Confidence <score_pct>%

| Findings | Count |
| --- | --- |
| 🔴 must-fix | <n> |
| 🟠 should-fix | <n> |
| 🔵 nit | <n> |
| ❓ unverified | <n> |

## 📋 Review

**What this PR does**: <2–3 sentence summary of the diff's intent and surface>

### Findings

#### <class-emoji> <finding title>

- **Evidence**: `file:line` — what the code does
- **Impact**: why it matters
- **Merge class**: must-fix | should-fix | nit
- **Confidence**: HIGH | MEDIUM | LOW
- **Fix sketch**: one-line suggestion

### Linked-issue AC

<per-criterion: met / unmet / cut — one-line reasoning, or `none`>

### ✅ Verified

- <check or command> → <what it showed>
- ❓ <unverified lead, if any>

### 🗑️ Considered & rejected

- **<short finding title>**: rejected — <one-line reason>

## 🛠️ Plan to fix

<details><summary>Expand fix plan</summary>
<br>

```md
<fix plan in markdown>
```

</details>
````

**Slot rules (guidance — not part of the posted body):**

- **What this PR does**: from the PR description plus your own read of the changed files, not copied marketing text.
- **Findings**: ranked by impact-if-shipped (§ Verdict synthesis); every accepted finding listed, nothing truncated; repeat the `#### <class-emoji> <title>` block per finding.
- **Linked-issue AC**: fill only when § Linked-issue hygiene applied; otherwise a bare `none`.
- **Verified**: the smallest runtime checks actually run and what they showed; unverified leads as `❓` lines here, never in the findings table.
- **Considered & rejected**: one bullet per rejected candidate from the three-way attack / vet pass (§ Attack and vet), so the next reviewer does not re-chase it; bare `none` when nothing was rejected.
- **Plan to fix**: fix plan in markdown (ordered steps per finding, files touched, verification gates); follow-up plan index folds in above the ```md block (§ Folding plans); when there is no fix plan, replace the whole `<details>` block with a single line `none`.

- The Verdict section replaces the old two-line tally header on GitHub: same facts (verdict token + `score_pct` as Confidence + four-class tally), structured. The chat display contract (§ Display contract) is unchanged.
- When the fix plan itself contains fenced code blocks, open the outer fence with four backticks so the inner fences survive.

### Folding plans into the summary

Fold follow-up plans into the review body **only if** this review wrote them. Put a short index — title, priority, effort, 1–3 sentence sketch, plan path — as the first content inside the § Report template **Plan to fix** `<details>` block, before the ```md fix-plan block:

```
- <plan title> — P1 / S — <1–3 sentence sketch> (`{PLAN_DIR}/audit-<date>/NNN-<slug>.md`)
```

Never dump full plan files.

### Local report archive

The posted PR comment is the deliverable; the local report is the durable reference copy — the PR thread may be buried, locked, or deleted, and bare-branch/diff reviews have no thread at all. The review seat saves **one markdown file per reviewed PR** (or branch/diff) as part of the mandatory deliverable, before worktree cleanup:

- **Path**: `{PROJECT_DIR}/<project-id>/reports/pr-review/` — `<project-id>` from the Assignment / project context, `_default` when the review runs outside any project flow (same id convention as `projects/<id>/residuals.json`). Gitignored local SSOT, same posture as residuals; a finding that must survive across clones gets promoted to tracked `{KNOWLEDGE_DIR}` / `{SPECS_DIR}`, not by tracking this directory.
- **Write via the primary checkout, never the worktree**: harness discovery must not start from the review worktree — its root has no gitignored `.mstar/`, and anything written there is destroyed by `git worktree remove` (§ Worktree isolation). Record the primary repository's absolute path **before** creating the worktree and write the report under it. Never create a `.mstar/` inside the review worktree to "host" the report.
- **Filename**: `<YYYY-MM-DD>-pr<N>.md`; bare branch → `<YYYY-MM-DD>-<branch-slug>.md`; arbitrary diff → `<YYYY-MM-DD>-diff-<short-head-sha>.md`, or `<YYYY-MM-DD>-diff.md` when no head SHA was provided with the changeset (never invent one). Same target twice in one day → append `-r2`, `-r3`, … (never overwrite a prior report).
- **Frontmatter** (machine-readable metadata):
  ```yaml
  ---
  type: pr-review
  pr: <n>                # omit for bare branch / diff
  url: <pr url>          # omit for bare branch / diff
  head: <head sha>
  base: <base ref>
  verdict: ship it | needs fixes | blocked
  score_pct: <n>
  tally: { must-fix: <n>, should-fix: <n>, nit: <n>, unverified: <n> }
  review_url: <posted review html_url>   # n/a-no-pr when skipped; failed: <gh error summary> when POST failed
  generated_at: <YYYY-MM-DD>
  ---
  ```

`head:` / `base:` are omitted when genuinely unknown (arbitrary diff without stated provenance) — never fabricate identifiers.

**Posting failure does not skip archival.** The report is saved regardless of the POST outcome: on failure it archives the chat display content plus the `gh` error summary, so a failed POST still leaves the durable copy.
- **Body**: the exact text posted as the GitHub Review body — verbatim, not a paraphrase. When `comments: n/a-no-pr` or posting failed, the body is the chat display content instead (§ Display contract two lines + ranked findings + leftover AC), so the local copy is still complete.
- Fix plans referenced by the Plan-to-fix section keep living in `{PLAN_DIR}/audit-<date>/` when written — the report links them, never duplicates them.

## Output shape

- `- findings:` — list of evidence-backed findings (`none` when none). Each accepted finding includes **Merge class** (§ Merge class).
- `- verdict:` — exactly one of `ship it` / `needs fixes` / `blocked` (§ Verdict synthesis).
- `- score_pct:` — integer 0–100 from the locked formula (§ Tally and derived score).
- `- tally:`
  - `- must-fix: <n>`
  - `- should-fix: <n>`
  - `- nit: <n>`
  - `- unverified: <n>`
- `- evidence:` — concise what-checks-proved summary.
- `- unverified:` — residual unverified claims, or `none`.
- `- next:` — one of `implementation` / `verify` / `docs`.
- `- notes:` — only out-of-scope state the user must act on.
- `- comments:` — GitHub Review posting status (see § Comment posting):
  - `posted: yes` | `n/a-no-pr` | `failed` — these three are distinct; a failed POST is **`failed`**, never `n/a-no-pr`
  - `review_url: <url>` when `posted: yes`; `n/a` when `n/a-no-pr` or `failed`
  - `inline: <N> posted / <M> attempted (<K> summary-only fallback)`
  - `plans_folded: yes` | `no`

- `- report:` — local archive path (§ Local report archive), e.g. `{PROJECT_DIR}/<project-id>/reports/pr-review/2026-08-24-pr134.md` (`_default` when project-less); `n/a` only when the harness dir is undiscoverable.

### Display contract (chat output)

Tone: matter-of-fact — no praise-padding, no flattery; state each severity together with the conditions that enable it.

First two lines of the **chat** display — verbatim:

```
{verdict} · {score_pct}%
must-fix=<n> should-fix=<n> nit=<n> unverified=<n>
```

Then ranked findings / leftover AC summary. Do not put `score_pct%` on the `- verdict:` token line.

The GitHub Review `body` no longer uses the two-line header — it follows § Report template, whose Verdict section carries the same facts structured (verdict token + Confidence + four-class emoji tally table).

