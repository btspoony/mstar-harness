# Deep PR Review Process

Read-only, evidence-first review of a pull request / branch / diff, producing exactly one verdict: `ship it` / `needs fixes` / `blocked`. Runs under `mstar-audit` § `pr` variant, reusing the Recon → Audit → Vet discipline (recon = PR scope + repo guidance; vet = three-way attack). The reviewer never edits the worktree, never merges, and never approves-as-merge.

## Review pipeline (three-stage)

Deep PR review is a **three-stage pipeline**: collect → domain review → synthesis. One PR gets multi-seat coverage (code + security, split by domain) but exactly **one verdict and one GitHub Review**, synthesized and published by the main agent. Every seat is a read-only audit seat; only the main agent posts.

- **Stage 1 — Collect**: PM fans out lightweight read-only agents by **domain** — business domain / change surface / tech stack; use the host's lightest read-only agent (`scout` / `explorer` / `general` — whatever the host offers). Each collect seat reads the changed files in its domain plus related context and returns **evidence in its result payload** (any seat may be **write-blocked** — read-only sandbox / EPERM; the main agent extracts the payload and writes the evidence file — § Local report archive / `references/pr-review-seat-evidence.md`): `file:line` observations, potential issue surfaces, and security-surface observations (the seat carries a security lens per `security-review.md` §2/§3 **research** discipline — trace origin, never invent an attacker, never record secret values — and still records MEDIUM / unverified items as **leads** in its evidence payload; the HIGH-only filter applies to formal findings, not leads). Collect seats produce **no** findings table, compute **no** verdict, and publish **nothing**.
- **Stage 2 — Domain review**: mstar built-in roles (`code-reviewer` / `fullstack-dev` / `frontend-dev`) split along the same domain framing, each reviewing code + security in its domain (security via the `security-review.md` lens) and producing findings with **Merge class** (§ Merge class). Each domain seat returns its findings in the **result payload** — any seat may be **write-blocked**; the main agent writes the Stage 2 evidence file (§ Local report archive / `references/pr-review-seat-evidence.md`). A large PR (>~300 changed lines, or spanning multiple change surfaces/domains) or a security-sensitive surface (auth, LLM, supply chain, data — `security-review.md` §9 extended surfaces) adds an **independent cross-domain security seat**.
- **Stage 3 — Synthesis (main agent)**: the main agent (the command's orchestrator) collects all domain findings + evidence files → **dedupe** → **three-way vet** (open each cited file yourself; `file:line` must genuinely support the claim) → **tally** (§ Tally and derived score — formula unchanged) → **verdict** → report + **publish GitHub Review** (§ Comment posting — publishing authority belongs to the main agent). The main agent does not backfill uncollected / unreviewed domains — a missing domain is declared in the report under `- unverified:` / `- notes:`.
- A domain whose seat returned **no evidence** (crashed / Blocked / empty output) is an **uncollected domain**, declared the same way under `- unverified:` / `- notes:`.

**Scale-driven fan-out** (reuses the existing sizing bands — no new thresholds): Stage 1 collect seats scale with PR size; the extra security seat stays in Stage 2:

| Size | Stage 1 collect seats | Extra Stage 2 |
| --- | --- | --- |
| Small (~≤300 / single surface) | 2 (code + security) | independent cross-domain security seat only if security-sensitive (`security-review.md` §9) |
| Large (>~300 / multi-domain) | 2–3 by domain | cross-domain security seat as needed |

- The ~1000 band of § Sizing & change shape is unchanged (too large → advise split); the pipeline fan-out threshold **is** the ~300 band — there is no second set of numbers.

**Fan-out discipline**: every collect / domain seat is a **read-only audit seat** (shared contract → `mstar-roles` `references/_shared/leaf-executor-core.md` Audit Mode). PM creates the worktree and resolves the diff basis **first** (§ Worktree isolation), then fans out. Domain-seat Assignments may carry `Delegation: allowed (scout/explore only, read-only)` (reusing the full-audit pattern). **For three-stage seats, never-post is the permanent contract** — posting is Stage 3 only, by the main agent: the main agent (the command's orchestrator) posts the review; review seats never post. Audit Mode, Hard Rule 2, and Mode C are aligned; no seat-level POST carve-out exists.

**Seat prompts** — every seat loads the **seat evidence contract** at `references/pr-review-seat-evidence.md` (return evidence / findings in the result payload — any seat may be **write-blocked**; the main agent writes the evidence files — § Local report archive). Stage 1 collect seats get: the absolute path to `references/pr-review.md` and the sections to read, the review worktree absolute path, recon facts (language / framework / directories / what was skipped), decided tradeoffs, and **Hard Rules 4/5 verbatim** — no findings table, no verdict. Stage 2 domain / security seats additionally load the **findings contract**: `references/finding-format.md`, `references/security-review.md` (security seats), and the instruction to produce findings with **Merge class** (§ Merge class), return them in the result payload (writable seats may **best-effort** write the Stage 2 evidence file directly — the main agent merges — § Local report archive), and return only findings — no fixes; never post.

> **Engine check (when available):** run `mstar pr-review seat-prompt --stage 1|2 --domain <d> --seat <id> --worktree <path> [--security] [--recon <fact> ...]` (or `import { prReviewSeatPrompt } from "@mstar-harness/engine"` in a host hook) to generate the prompt skeleton — Hard Rules 4/5 verbatim, payload-return contract, no-verdict/no-post clauses, slug `<domain>-<seat>`, Merge-class instruction on stage 2. Judgment stays with the PM/agent: domain selection, which tradeoffs are decided, and whether the surface warrants the security lens. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Review depth (tiers)

PR review runs at one of three tiers — `quick` / `default` / `deep` — chosen by an explicit keyword or inferred from the change shape (§ Inference ladder). `deep` is the current three-stage pipeline verbatim; `default` is the no-flag landing tier for small code PRs; `quick` serves explicit intent and tiny-mechanical diffs. Every tier keeps the same verdict contract: one verdict derived from the tally, one GitHub Review, posted by the main agent (§ Verdict synthesis / § Comment posting).

| Tier | Seats | Domain split | Security coverage | Synthesis | Relative seat-time | Boundary |
| --- | --- | --- | --- | --- | --- | --- |
| `deep` | 4–7 (2–3 collect + 2–3 domain + 0–1 independent security) | 2–3 by domain | in-domain lens **+ independent cross-domain security seat** | main agent, all three stages | longest (= current) | = current three-stage pipeline, verbatim |
| `default` | 2 (two domain seats; collection folded in = seat reuse) | 2 seats by dominant surface (code/tests, backend/frontend); single-surface PR → second seat = dedicated same-domain security-lens seat | both seats carry the in-domain security lens; **no independent cross-domain seat** (cross-domain boundary issues still go to `- notes:`; the main agent may announce an upgrade to deep) | main agent (kept) | medium (≈ ½ of deep) | typical ≤~300 changed lines; PM may announce an upgrade to deep by risk shape and declare it in the report (`- notes:`); downgraded cuts are declared likewise |
| `quick` | 1 (single domain seat; collect + review in one pass) | none (one seat, one pass) | in-domain security lens in the same seat (§2/§3 discipline); **no independent seat**; sensitive surface + explicit quick → lens still runs, report declares reduced coverage under `- notes:` | main agent (kept, smallest input) | shortest (≈ ¼) | recommended ≤~300 / mechanical shape; report must declare tier |

**Inference ladder** (no flag given — first hit wins):
1. **Explicit tier token** — matched **only** as a dedicated flag token (`--quick` / `--default` / `--deep`) or a trailing standalone tier word (the `[quick|default|deep]` argument position), **never** as a substring of the `[pr|branch|scope]` argument (a branch/PR title containing `quick` or `default` does not set a tier) → that tier; user intent beats every heuristic.
2. **Too large** (>~1000 changed lines) → advise a split (existing rule); if the user insists on reviewing anyway → `deep`.
3. **Sensitive surface** (`security-review.md` §9 extended surfaces — auth / LLM / supply chain / data — present in the diff) → `deep` at any size; security-sensitive surfaces are never thinned.
4. **Large** (>~300 changed lines, or spanning multiple change surfaces/domains) → `deep`; large PRs never silently fall back to reduced coverage.
5. **Small** (≤~300, single surface):
   - tiny-mechanical shape (docs-only / rename / formatting / pure deletion — the existing "tiny mechanical → general only" shape test) → `quick`;
   - anything else (real code change) → `default`.

The ladder reuses the existing ~100 / ~300 / ~1000 sizing bands — no second set of numbers: ~100 is quick's recommended domain, ~300 is default's upper bound (above = large → deep), ~1000 keeps its too-large meaning. Quick's typical lower band ~100 is operational guidance, not a separate trigger — small real-code PRs near that boundary still default to `default` to preserve evidence depth.

**Conflict rule**: at most **one** tier keyword may be given. Any two of `quick` / `default` / `deep` appearing together → **hard-stop conflict error** — report the conflict and ask the user to pick one; never silently take a priority. Explicit `quick` on a security-sensitive surface is respected (trust + transparency), but the seat must still run its in-domain security lens and the report must declare `- notes:` "quick tier — reduced coverage on a security-sensitive surface".

**Cuttable vs never-cut**:
- **Cuttable by tier**: seat count, stage-as-wave (Stage 1 as a separate wave), domain-split granularity, the independent security seat, the lens set, the seat-prompt ingredient set.
- **Never cut (any tier)**: the verdict-from-tally formula (one formula, all tiers), merge-class assignment + three-way vet, posting ownership (sole main agent), evidence discipline (`file:line` + self-check), Hard Rules 4/5, seats read-only, worktree isolation, the batch contract (first-only + backlog register), the local report archive contract incl. frontmatter, linked-issue AC counting.
- **Stage 3 is never skipped in any tier** — `quick` just feeds it the smallest input; one verdict / one Review / main-agent posting is the product contract.

**Report `tier` declaration**: report frontmatter gains an optional `tier: quick | default | deep` (absent = `default` semantics, valid — old reports stay valid). `quick` MUST declare its reduced coverage under `- notes:` (what did not run: independent security seat / Stage 1 wave / domain split); any announced upgrade or downgrade (e.g. PM announces deep-upgrade, or a downgraded cut happens) is declared the same way. Report template structure, tally counts, and the display contract are unchanged; tier never enters the report filename.

## Worktree isolation
- All git mechanics — real-base resolution (never assume `main`), collision-free branch naming (`pr-<n>` → `pr-<n>-<date>-<i>` loop before **any** fetch), explicit-refspec fetches (single-branch/narrowed fetch configs stay correct; do **not** substitute `gh pr checkout <n>` — it lands on the PR-head name instead of the recorded branch, bypassing the ownership protocol), worktree creation, changeset pre-flight (untracked-only working-tree changes count as non-empty), diff-basis computation, sidecar recording, removal + prune + exact-branch deletion — execute mechanically:

> **Engine check (when available):** run `mstar pr-review worktree-setup --pr <n> | --branch <b> | --diff | --working-tree | --commit <sha> [--path <dir>]` (or `import { pickReviewBranchName, preflightChangeset } from "@mstar-harness/engine"` in a host hook) to create the isolated review worktree, compute the diff basis inside it, record a sidecar json, and print `{reviewBranch, worktreePath, base, mergeBase, diffCmd}`; clean up with `mstar pr-review worktree-cleanup --path <dir> --branch <name> --report-saved` — removes the tree, prunes, deletes **exactly** the recorded branch (a foreign/unrecorded branch is refused) and refuses removal while the local report is unsaved. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

Discipline that stays with the agent (behavior, not git mechanics):

- Review from a dedicated linked worktree — **never the primary repo cwd, never another harness worktree** — and compute the diff basis inside it against the recorded refs, three-dot style: **never the primary `HEAD`** (the primary checkout may sit on a different branch).
- Input-mode shape: bare branch reviews use a detached worktree against the fetched remote-tracking ref (no local ownership protocol, no local branch to delete); arbitrary-diff inputs verify stated provenance and read changed files locally — no worktree, no branch, nothing to clean up; working-tree inputs take tracked + staged + untracked changes read in full (the review stays read-only — no fixes, no stash; `comments: n/a-no-pr`); single-commit inputs verify provenance but read file context **at that commit** (`git show <sha>:<path>`), which diverges from the current checkout whenever HEAD ≠ `<sha>` or the file changed since.
- **Pre-flight before fanning out lenses** (every mode): named refs resolve (in modes that have refs) and the changeset is non-empty — an empty changeset reports "no changes to review" and stops; never spawn lenses on an empty changeset.
- Record before computing: review cwd, `<review-branch>`, HEAD sha, merge-base.
- Clean up **once the local report is saved** — the save runs in all three posting branches (`posted: yes` / `n/a-no-pr` / `failed`; § Local report archive), so cleanup never waits on POST success — then delete **exactly** the recorded `<review-branch>` (provably this review's own branch); never delete a pre-existing branch. Never remove other harness worktrees.

## Scoping

- Review the diff basis vs base: changed files plus what the change touches.
- Read changed files **in full** — diffs hide context.
- Inspect adjacent behavior when risk leaks past the named diff (importers, callers, dependent contracts).
- When the diff touches tests, read the tests before the implementation — they carry intent.
- Verification claims in the PR description must be reproducible from the diff/CI; a claim that cannot be checked is an `unverified` lead, not evidence.
- **Domains** — review is split by domain (**business domain / change surface / tech stack**; § Review pipeline). Each domain seat concludes **only on its own domain**.
- Cross-domain boundary issues (importers / callers reaching outside the seat's domain) → record to the evidence file `- notes:`; the main agent decides whether an additional cross-domain seat is warranted.

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

> **Engine check (when available):** run `mstar pr-review size --base <ref> --head <ref>` (or `import { prReviewSizing, resolvePrReviewTier } from "@mstar-harness/engine"` in a host hook) to classify the changeset into the bands above — it prints the band, the inferred tier, the Stage-1 seat plan, split advice and the file-size watch, so band and fan-out decisions are never hand-derived. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

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
- **Scout / collector evidence = leads** — collect-seat evidence files and unchecked domain-seat notes are **leads, not findings**; a domain seat's Stage 2 output **after it opened the cited code itself** (`file:line`) is a formal finding, and the main agent (Stage 3) may still reject it during vet. A finding that cites a collector's relay without its own self-check is disqualified (same discipline as full-audit "excerpts come from your own reads").
- What disqualifies a finding (no evidence, by-design, secret values, ungrounded suggestions) → **`references/finding-format.md`** § What disqualifies a finding.

## Attack and vet

Before writing a finding, run the three-way attack from `mstar-audit`:

1. **Counter-example** — find a boundary case that makes the claim not hold.
2. **Simpler explanation** — does a simpler explanation cover the same evidence?
3. **Evidence verifiability** — open the cited lines and check they actually support the claim.

Each **domain seat** runs the three-way attack on its own findings, opens the cited code itself, and disposes by-design / mis-attributed / duplicate before presenting.

The **main agent** is the final vet layer: at synthesis it dedupes **all** findings across domains (cross-domain duplicates, mis-attribution), applies the same by-design / duplicate disposition with the `cited code yourself` discipline, and records every rejection in the report's **Considered & rejected** section. Subagents over-report; vet before presenting.

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

> **Engine check (when available):** run `mstar lint <file.md>` with `--type finding` (add `--pr-variant` for the PR Merge-class contract) — or `import { validateFindingDoc } from "@mstar-harness/engine"` in a host hook — to machine-check a findings document: `### [CATEGORY-NN]` numbering, category / effort / risk / confidence enums, evidence `path:line` shape, and the Merge-class presence/enum/placement rule. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

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

> **Engine check (when available):** the invariant is enforced structurally — `computePrTally` derives the verdict from the tally before the score is computed, and `mstar pr-review validate-report` flags a `verdict` that does not follow from the report's own tally (`prreview.report.verdict-mismatch`, severity high). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

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

`blocked · 60%` is still not shippable. `needs fixes · 85%` still means address findings. This table is mirrored row-for-row as the engine test fixture (`packages/engine/test/prreview.test.ts`) — the table text is kept here as the historical SSOT anchor.

> **Engine check (when available):** run `mstar pr-review tally --findings <file.json> [--unverified <n>] [--unmet-ac-unsafe <n>] [--unmet-ac-safe <n>]` (or `import { computePrTally } from "@mstar-harness/engine"` in a host hook) to compute this tally, verdict and score from the accepted findings JSON — the check table above is the SSOT the engine fixture mirrors (`packages/engine/test/prreview.test.ts`); never hand-compute when the CLI is available. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

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
- **Comment-triage replies are the main agent's job at Stage 3** — seats never post or reply. For valid comments, the main agent folds the minimal fix suggestion into the finding/plan (plan output) for the Prepare → Execute flow. For invalid comments, the main agent disagrees on the PR comment with clear reasoning. Never gold-plate.

## Batch sibling PRs

- **one session = one PR** (HARD): an `amazing-pr-review` session reviews exactly **one** PR. When multiple PRs are passed in, only the **first** — the first PR in the caller's argument / mention order, never sorted by PR number or recency — runs the review at its resolved tier (§ Review depth (tiers) for tier resolution → § Review pipeline for stage steps; `deep` = the full three-stage pipeline); the rest are **not** processed in this session.
- **Register the rest as audit todos** — before the review starts, register every unprocessed PR in `{PROJECT_DIR}/<project-id>/residuals.json` (project-less reviews use `_default`) via the engine-backed CLI, one `--entry` per deferred PR:
  ```
  mstar status backlog-register --project <project-id> --key <plan-key> --entry '<entry json>' ...
  ```
  - `--project` defaults to `_default`; `--key` is the **base** batch key, `pr-deep-review-<YYYY-MM-DD>` for the first same-day session — the CLI selects the first free same-day key (`pr-deep-review-<YYYY-MM-DD>`, then `-2`, `-3`, …) inside the engine's status write lock and prints the key actually used; never compute the bumped key yourself.
  - Each `--entry` is a JSON object with the nine residual fields for one deferred PR: `id` (unique within the batch, e.g. `pr-deep-review-<YYYY-MM-DD>-<n>`), `title: "pr-deep-review <owner>/<repo>#<n>"`, `severity: low`, `source: pr-deep-review batch input`, `scope: "deep review of <owner>/<repo>#<n> in a new amazing-pr-review session"`, `decision: defer`, `owner: project-manager`, `target: next session`, `tracking: pr-deep-review backlog`. The CLI fills the provenance fields (`source_plan` = the used key, `registered_at` = today).
  - Entry-id uniqueness is **enforced in code** (B-9 ②): the engine rejects a duplicate `id` within the key — fail-loud, register unchanged — so ids only need to stay distinct within the batch.
  - `<n>` is the GitHub PR number; `title`/`scope` carry the recoverable PR identity (`<owner>/<repo>#<n>` or the PR URL) so a later session can open the exact deferred PR from the register alone.
  - **Concurrency/crash safety is engine-tested** (`packages/engine/test/backlog-register.test.ts`): registration runs inside `withStatusWriteLock` with atomic temp+rename writes — never hand-edit the register with python/jq.
  - Lock-semantics delta vs. the old hand-rolled protocol: `withStatusWriteLock` has **no stale-lockdir auto-reclamation** — a crash-leaked lockdir ⇒ 30s timeout ⇒ `Blocked` with the `holder.pid` recovery hint (remove the lockdir only when no writer is alive).
- **Registration failure halts the session**: if the CLI exits non-zero (fail-loud validation, register unchanged), stop and report `Blocked` — never start the first-PR review while deferred PRs are unregistered (they would be neither reviewed nor tracked).
- **Backlog close**: when a session completes review of a PR that was previously deferred — at its resolved tier (`quick` / `default` / `deep` per § Review depth), it MUST look up the matching register entry (`tracking: pr-deep-review backlog`, identity `<owner>/<repo>#<n>` in `title`/`scope`) and close it in place at review completion:
  ```
  mstar status backlog-close --project <project-id> --key <used-key> --id <entry-id>
  ```
  (`--project` defaults to `_default`; `--key` is the key the entry was registered under — the one `backlog-register` printed; `--id` is the entry id; `--note` is optional, default `"closed by backlog close"`) — sets `lifecycle: resolved` + `closed_at: <YYYY-MM-DD>` + `closure_note` (no `closed` enum), per the register lifecycle contract in `mstar-project-governance`; never leave a stale open entry for a reviewed PR.
- **Suggest one session per PR**: the report's `- notes:` states that each remaining PR gets its own `amazing-pr-review` session and is tracked in the `_default` residuals backlog (`tracking: pr-deep-review backlog`).
- **Concurrency stays inside the single PR**: for the one PR under review, create the worktree first, then fan out per the resolved tier's seat plan (§ Review depth (tiers)) — `deep` fans out the Stage 1 collect seats in one batch (§ Review pipeline); `default` folds collection into the two domain seats; `quick` is a single pass. Deferred PRs get **no** review worktree and **no** review seats — backlog registration only. The old "all worktrees first, all reviewers in one batch" model no longer applies to N PRs.
- Sibling interactions are **noted, not fixed** — interactions with deferred sibling PRs go to the report's `- notes:`, unless the ticket says so.

## Plan output（handoff to execution）

Review findings that need fixing can become plans for the normal Prepare → Execute flow — same contract as **`mstar-audit` SKILL.md** `## Plan output (all variants)`:

- Write the top findings as self-contained plans (numbered `001-<slug>.md` + `README.md` index — top findings only; the verdict is presented separately).
- The review itself stays read-only: plans are written only when the user selects findings to pursue.

## Comment posting

Posting the GitHub Review is a **mandatory deliverable** of the `pr` variant — chat-only output is incomplete when a PR exists. The main agent (the command's orchestrator) posts the review; review seats never post — posting is Stage 3 only, by the main agent, and the seat-level carve-out is gone — Audit Mode, Hard Rule 2, and Mode C are aligned.

- **Before anything else:** synthesize the verdict first, then post **before** worktree cleanup (see § Worktree isolation — cleanup happens after the local report is saved).
- **No PR number** (bare branch / arbitrary diff): set `comments: n/a-no-pr` and skip the API. Chat output still required; this is not a Blocked review.
- **Auth / API failure:** deliver the chat verdict anyway; Completion Report status `Partial`/`Blocked` with the `gh` error. Do not claim `Done` — comments are mandatory when a PR exists. **The local report is still saved** (§ Local report archive — posting failure does not skip archival).

### Procedure

Executed by the main agent at Stage 3 — review seats never run this procedure. The following are the binding contracts, independent of who executes:

1. **Target resolution** — the **base** repo is `owner/repo` parsed from the PR `url` (`https://github.com/{owner}/{repo}/pull/{n}`); `commit_id` is `headRefOid`. **Never** derive the repo from `headRepository` (the fork view) — Reviews API paths are scoped to the repository that owns the PR number.
2. **Payload** — `event` is the fixed literal `COMMENT` (**never** `APPROVE`, **never** `REQUEST_CHANGES`, never a merge — the engine's literal type admits no other value); `body` follows **§ Report template (below)**; `comments[]`: one entry per finding whose `path` + `line` sits in the three-dot diff, `side: RIGHT` — finding body = title + evidence + impact + fix sketch, not the whole plan.
3. **Line fallback** — if GitHub rejects some inline comments (e.g. 422 — line outside the diff), retry the review **once**, without exactly the rejected entries and with them folded into the summary body; never loop a second time.
4. **Save the local report (§ Local report archive) — mandatory in all three branches**: POST succeeded (record `html_url` / review id for `comments:` first), POST failed, or `n/a-no-pr` (archive the chat display content). Only then clean up the worktree (§ Worktree isolation); bare branch/diff reviews have no worktree, but the save still happens.

> **Engine check (when available):** run `mstar pr-review post --pr <n> --body-file <path> [--findings <file.json>]` (or `import { planReviewPost } from "@mstar-harness/engine"` in a host hook) to execute these contracts mechanically — url-based repo resolution, the `COMMENT` literal, payload POST via stdin, and the at-most-once 422 fallback printing `review_url`; auth/API failure exits 1 (`comments: failed`). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

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

The posted PR comment is the deliverable; the local report is the durable reference copy — the PR thread may be buried, locked, or deleted, and bare-branch/diff reviews have no thread at all. The main agent saves **one markdown file per reviewed PR** (or branch/diff) at Stage 3 — the report it published — as part of the mandatory deliverable, before worktree cleanup:

- **Path**: `{PROJECT_DIR}/<project-id>/reports/pr-review/` — `<project-id>` from the Assignment / project context, `_default` when the review runs outside any project flow (same id convention as `projects/<id>/residuals.json`). Gitignored local SSOT, same posture as residuals; a finding that must survive across clones gets promoted to tracked `{KNOWLEDGE_DIR}` / `{SPECS_DIR}`, not by tracking this directory.
- **Write via the primary checkout, never the worktree**: harness discovery must not start from the review worktree — its root has no gitignored `.mstar/`, and anything written there is destroyed by `git worktree remove` (§ Worktree isolation). Record the primary repository's absolute path **before** creating the worktree and write the report under it. Never create a `.mstar/` inside the review worktree to "host" the report.
- **Filename**: `<YYYY-MM-DD>-pr<N>.md`; bare branch → `<YYYY-MM-DD>-<branch-slug>.md`; arbitrary diff → `<YYYY-MM-DD>-diff-<short-head-sha>.md`, or `<YYYY-MM-DD>-diff.md` when no head SHA was provided with the changeset (never invent one). Same target twice in one day → append `-r2`, `-r3`, … (never overwrite a prior report).
- **Evidence files**: the **main agent** writes each seat's (Stage 1 / Stage 2) evidence file in the same `reports/pr-review/` directory — `<YYYY-MM-DD>-pr<N>-stage1-<slug>.md` (Stage 1) / `<YYYY-MM-DD>-pr<N>-stage2-<slug>.md` (Stage 2 findings draft). Seats return evidence / findings in their result payload (contract → `references/pr-review-seat-evidence.md` — any seat may be **write-blocked**; seats are **never required to write**). Writable seats may **best-effort** write their evidence file directly; the contract does not depend on it. The **main agent writes / consolidates all evidence files** from the seat payloads. `<slug>` is **domain-derived and unique per seat** — `<domain>-<seat>` — and is mandated in the seat Assignment, so two seats in the same pipeline can never collide. Bare branch / diff mirror the main-report forms: `<YYYY-MM-DD>-<branch-slug>-stage{1,2}-<slug>.md`, `<YYYY-MM-DD>-diff-<short-head-sha>-stage{1,2}-<slug>.md`, or `-diff-` alone when no head SHA was provided (never invent one). Same target re-reviewed twice in one day → append `-r2`, `-r3`, … (never overwrite a prior evidence file). Same gitignored directory and same **write via primary checkout, never the worktree** discipline applies (an evidence file written in the review worktree is destroyed by `git worktree remove`, § Worktree isolation).
- **Frontmatter** (machine-readable metadata):
  ```yaml
  ---
  type: pr-review
  tier: quick | default | deep   # optional — absent = default semantics (§ Review depth)
  pr: <n>                # omit for bare branch / diff
  url: <pr url>          # omit for bare branch / diff
  head: <head sha>
  base: <base ref>
  verdict: ship it | needs fixes | blocked
  score_pct: <n>
  tally: { must-fix: <n>, should-fix: <n>, nit: <n>, unverified: <n> }
  comments: posted | n/a-no-pr | failed   # posting tri-state — never collapse failed into n/a-no-pr ("yes" = posted alias)
  review_url: <posted review html_url>   # n/a-no-pr when skipped; failed: <gh error summary> when POST failed
  generated_at: <YYYY-MM-DD>
  pipeline: {stages: 3, seats: [<seat ids>]}   # optional — omit when the review did not run the three-stage pipeline
  ---
  ```

`head:` / `base:` are omitted when genuinely unknown (arbitrary diff without stated provenance) — never fabricate identifiers.

**Posting failure does not skip archival.** The report is saved regardless of the POST outcome: on failure it archives the chat display content plus the `gh` error summary, so a failed POST still leaves the durable copy.

> **Engine check (when available):** run `mstar pr-review report-path --reports-dir <dir> --target pr:<n>|branch:<slug>|diff:<sha>|diff [--stage 1|2 --slug <domain-seat>] [--date <YYYY-MM-DD>]` (or `import { prReviewReportPath } from "@mstar-harness/engine"` in a host hook) to resolve the Filename / Evidence-file names above — including the same-day `-r2`/`-r3` escalation, which the resolver scans for instead of the agent eyeballing the directory. Pure resolution: it never writes; the main agent still writes the file content. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.
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

> **Engine check (when available):** run `mstar pr-review validate-report <file.md>` (or `import { validatePrReviewReport } from "@mstar-harness/engine"` in a host hook) to machine-check a saved local report against the Frontmatter + Output-shape contract above — verdict-from-tally consistency, the locked-formula `score_pct` recompute, the comments tri-state (a failed POST is `failed`, never `n/a-no-pr`), the required-field set (`type`, `verdict`, `score_pct`, `tally`, `comments`, `review_url`, `generated_at`) and `generated_at` format. Exit 1 with violations; run it before worktree cleanup. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

### Display contract (chat output)

Tone: matter-of-fact — no praise-padding, no flattery; state each severity together with the conditions that enable it.

First two lines of the **chat** display — verbatim:

```
{verdict} · {score_pct}%
must-fix=<n> should-fix=<n> nit=<n> unverified=<n>
```

Then ranked findings / leftover AC summary. Do not put `score_pct%` on the `- verdict:` token line.

The GitHub Review `body` no longer uses the two-line header — it follows § Report template, whose Verdict section carries the same facts structured (verdict token + Confidence + four-class emoji tally table).

