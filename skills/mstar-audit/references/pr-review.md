# Deep PR Review Process

Read-only, evidence-first review of a pull request / branch / diff, producing exactly one verdict: `ship it` / `needs fixes` / `blocked` / `incomplete`. Runs under `mstar-audit` § `pr` variant, reusing the Recon → Audit → Vet discipline (recon = PR scope + repo guidance; vet = three-way attack). The reviewer never edits the worktree, never merges, and never approves-as-merge.

**Test review (every tier, within the assigned diff and directly affected contracts):** keep product-behaviour assertions and fails-first regression defences; delete incidental / source-shape / wiring / environment-constant assertions — deleted, never renamed or re-pinned. For a confirmed non-product assertion, domain findings and the synthesized report must name its non-product-assertion class and conclude **"delete, or replace with a product-behaviour assertion"**. Calibrate against the PR #280 counter-examples: manifest parity guard, platform build-byte pins, raw-SQLite fixture, test-only header regression. Inspect assertions and production-owner contracts rather than deleting by example name; use `references/test-audit.md` §§ 2–7 for retention and candidate evidence. This is a read-only review obligation, not permission to edit tests or run suites.

## Review pipeline (three-stage)

Deep PR review is a **three-stage pipeline**: collect → domain review → synthesis. One PR gets multi-seat coverage (code + security, split by domain) but exactly **one verdict and one GitHub Review**, synthesized and published by the main agent. Every seat is a read-only audit seat; only the main agent posts. At the `deep` tier the pipeline runs **two waves by default when the pinned diff pack exists** (the `worktree-setup` `diffFile` snapshot — § Worktree isolation): the Stage 1 collect wave **folds into the Stage 2 domain seats** (`collectFolded` seat prompts — each domain seat collects its own domain, then reviews it), leaving the domain-seat wave and main-agent synthesis. The collect wave runs as its own wave only in the kept-wave exceptions (Stage 1 below).

- **Stage 1 — Collect**: PM fans out lightweight read-only agents by **domain** — business domain / change surface / tech stack; use the host's lightest read-only agent (`scout` / `explorer` / `general` — whatever the host offers). Each collect seat reads the changed files in its domain plus related context and returns **evidence in its result payload** (any seat may be **write-blocked** — read-only sandbox / EPERM; the main agent extracts the payload and writes the evidence file — § Local report archive / `references/pr-review-seat-evidence.md`): `file:line` observations, potential issue surfaces, and security-surface observations (the seat carries a security lens per `security-review.md` §2/§3 **research** discipline — trace origin, never invent an attacker, never record secret values — and still records MEDIUM / unverified items as **leads** in its evidence payload; the HIGH-only filter applies to formal findings, not leads). Collect seats produce **no** findings table, compute **no** verdict, and publish **nothing**. **Kept-wave only**: by default (pack exists) this wave folds into Stage 2 and **no collect seats are dispatched**; it runs as its own wave only when kept — **no snapshot** (`--diff` / `--working-tree` modes write no diff snapshot; `worktree-setup` prints `diffFile: null` there) or **PM judgment** (unfamiliar sprawling surface). Either way is declared in the report `- notes:` — `collect wave folded (pack)` / `collect wave kept (no pack / PM judgment: <reason>)`.
- **Stage 2 — Domain review**: mstar built-in roles (`code-reviewer` / `fullstack-dev` / `frontend-dev`) split along the same domain framing, each reviewing code + security in its domain (security via the `security-review.md` lens) and producing findings with **Merge class** (§ Merge class). By default (pack exists) these seats are dispatched with the **`collectFolded`** option (CLI: `mstar pr-review seat-prompt --collect-folded`) — a fold bullet after the `## Budget` block tells each seat to do its own collection: pinned diff pack first, then changed files in its domain (§ Seat prompts) — so no separate collect wave precedes them. Each domain seat returns its findings in the **result payload** — any seat may be **write-blocked**; the main agent writes the Stage 2 evidence file (§ Local report archive / `references/pr-review-seat-evidence.md`). A large PR (>~300 changed lines, or spanning multiple change surfaces/domains) or a security-sensitive surface (auth, LLM, supply chain, data — `security-review.md` §9 extended surfaces) adds an **independent cross-domain security seat**. The fold removes only the collect wave — the **independent cross-domain security seat is never folded**.
- **Stage 3 — Synthesis (main agent)**: the main agent (the command's orchestrator) collects all domain findings + evidence files → **dedupe** → **tiered three-way vet** (full for must-fix/should-fix; evidence-verify for nits — open the cited file; `file:line` must genuinely support the claim) → **tally** (§ Tally and derived score — locked deduction schedule + bands) → **verdict** → report + **publish GitHub Review** (§ Comment posting — publishing authority belongs to the main agent). The main agent does not backfill uncollected / unreviewed domains: an unopened **required** domain leaves the run unsettled and derives the single `incomplete` fact through § Verdict synthesis's trigger list — a per-item residual the vet could not verify is not that case and stays a settled run's `- unverified:` entry. **The envelope is mandatory**: after the tally, the main agent **must** fold the accepted findings into a `mstar.review/v1` envelope (`synthesizeReview` — or the equivalent engine call) and persist it via `mstar-harness persist review --key <pr-or-review-id> --stdin` (or `getArtifactStore().put`); the Markdown archive is an optional human copy, **not** a substitute for the envelope.
- A domain whose seat returned **no evidence** (crashed / Blocked / empty output) is an **uncollected domain**: the run is not settled, so the report carries the single override `incomplete`, derived from the run facts with its cause and unscanned scope (§ Verdict synthesis). Per-item unverifiability is a different case — a settled run keeps that residual under `- unverified:`.
- **Capture duty (Stage 3, main agent)**: every seat — collect, domain, security — **returns findings as evidence and never writes the store**; at synthesis the **main agent captures the confirmed findings** as issues in `{HARNESS_DIR}/store.db` per the single-authority contract in **`mstar-project-governance`「Issue capture」** (plan-scoped `mstar plan issue-add`, unscoped `mstar issue add`; a recurrence of the same finding **appends an occurrence** to the existing issue — never a second issue). Capture records evidence only; a disposition is a **separate authorized act** (§4 closure authority). The canonical duty is not restated here.

> **Engine check (when available):** run `mstar-harness persist write review --key <pr-or-review-id> --file <review.json>` (or `import { synthesizeReview, validateMstarReviewV1 } from "@mstar-harness/engine"` in a host hook) to fold the accepted findings into the `mstar.review/v1` envelope and persist it — `synthesizeReview` derives verdict/tally from `computePrTally` (pure, no I/O), and `kind: review` runs `validateMstarReviewV1` before put, refusing invalid envelopes (exit 1, nothing written). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

When the loop dispatches this round to an external review-seat channel, that channel's session is the round's main agent for every rule in this reference — synthesis, posting, capture, archive and § Seat supervision stay with it; the dispatching loop session does not supervise that session's seats.

### Optional finite A05 shadow step (Stage 3 only)

This is an **opt-in, documented synthesis step**, not an automatic `mstar pr-review` engine callback. The main agent remains the Stage 3 owner. First preserve the entire ordinary review: collect every assigned domain, open and vet the cited code, dedupe by actual underlying cause, record every considered/rejected candidate, check linked-issue AC, capture confirmed findings, and derive the unchanged tally/verdict. Freeze the original inventory, seat outputs, consumed original work and final report before any optional answer can be exposed. The original seats and required work run regardless of whether the shadow lane is off, unavailable, late, cancelled or wrong; never rerun them to manufacture a clean baseline.

Where **separate source/egress authorization** exists for the exact scoped material, the main agent may prepare a finite shadow candidate *after* its own source check: map two structured finding records to `StructuredFinding` with stable IDs, literal claim and evidence, validated `FindingSource` references (path, line range, excerpt, content hash, observation run/revision). `buildCandidatePairs(findings, scope)` uses equal fingerprints or explicit `relatedFindingIds` only as deterministic candidate hints. It does **not** establish semantic equality, transitively group findings, or decide the dedupe. Bind exactly one candidate and the complete pre-existing `WorkUnit[]` inventory in `buildShadowPack([pair], units, scope)`; scope includes frozen review/diff/snapshot identities, tier, recipient, rubric and builder versions. Missing/stale evidence or incomplete inventory is input abstention, not a request to invent excerpts. The main agent still determines cause identity from the cited code and logs any rejection in **Considered & rejected**. Finding format and fingerprint rules remain `references/finding-format.md`; the adapter is `packages/judgment/src/audit-shadow.ts`.

For a *synthetic-only*, expressly approved run, follow the restored [`docs/judgment.md`](../../../docs/judgment.md) guide to pin the pilot/pack, approved child and isolated mounts; invoke the finite `packages/judgment/scripts/shadow.ts` `exercise`/`study` and `assess` paths through the supervisor. The unprivileged child gets only a request mailbox and bounded public status via `connectEvaluatorChannel`; the trusted supervisor uses `createEvaluatorMailbox`, freezes baseline, runs the approved child, seals evaluator data and records original-owner receipts. A public `recorded` status is **not** an answer or an endorsement: no raw response, score, confidence, probability, model reasoning or result locator enters the reviewer context. A genuine evaluator-owned comparison, if separately authorized, happens only after immutable freeze and cannot replace the main agent's evidence check.

Set a latest-useful point within the finite review budget. When opt-in is absent, permission is missing, input abstains, setup/child/evaluator fails, the deadline expires or the whole review cancels: do not wait past that point, do not expose late results, do not suppress a finding, and finish/report the ordinary review by its existing gates. Preserve the off/unavailable/cancelled reason and sealed baseline/receipt artifacts if a run started; `recordWorkUnitDisposition` and `assessShadowRun` keep every required unit original-owned and Jev-attributed completed work at **zero** (including an apparently correct optional answer). An incomplete original unit remains incomplete/blocked/cancelled, never credited to Jev. The optional path adds no finding, tally, Coverage, seat reduction, merge action, hint, source omission, review verdict or savings claim.

**Evidence boundary:** a component exercise (`evidenceClass: component`) and later synthetic offline exercise (`synthetic-offline`) prove mechanics only, never named-host/W5 or actual TypeSafe quality. Real-source egress is not authorized by this step; current runnable material is synthetic. Authenticated host identity, permitted real source, the host's actual tool path and real W5 assessment remain an open separately tracked verification obligation, not a prerequisite for the account-free component path and not an invitation to search for or copy credentials. Do not label a component assessment as named-host or close that obligation on synthetic evidence.

**Scale-driven fan-out** (reuses the existing sizing bands — no new thresholds): this is the **kept-collect-wave guidance** — collect seats exist only when the collect wave is kept (§ Stage 1; the default fold dispatches none; `prReviewSizing.collectSeats` semantics unchanged). When kept, Stage 1 collect seats scale with PR size; the extra security seat stays in Stage 2:

| Size | Stage 1 collect seats (kept wave only) | Extra Stage 2 |
| --- | --- | --- |
| Small (~≤300 / single surface) | 2 (code + security) | independent cross-domain security seat only if security-sensitive (`security-review.md` §9) |
| Large (>~300 / multi-domain) | 2–3 by domain | cross-domain security seat as needed |

- The ~1000 band of § Sizing & change shape is unchanged (too large → advise split); the pipeline fan-out threshold **is** the ~300 band — there is no second set of numbers. The default (pack exists) dispatches **no collect seats** — the domain seats collect themselves (`collectFolded`).

**Fan-out discipline**: every collect / domain seat is a **read-only audit seat** (shared contract → `mstar-roles` `references/_shared/leaf-executor-core.md` Audit Mode). PM creates the worktree and resolves the diff basis **first** (§ Worktree isolation), then fans out. Domain-seat Assignments may carry `Delegation: allowed (scout/explore only, read-only)` (reusing the full-audit pattern). **For three-stage seats, never-post is the permanent contract** — posting is Stage 3 only, by the main agent: the main agent (the command's orchestrator) posts the review; review seats never post. Audit Mode, Hard Rule 2, and Mode C are aligned; no seat-level POST carve-out exists.

**Seat prompts** — every seat loads the **seat evidence contract** at `references/pr-review-seat-evidence.md` (return evidence / findings in the result payload — any seat may be **write-blocked**; the main agent writes the evidence files — § Local report archive). Stage 1 collect seats get: the absolute path to `references/pr-review.md` and the sections to read, the review worktree absolute path, the absolute path to the pinned diff snapshot (when `worktree-setup` produced it — passed as `--diff-file`), recon facts (language / framework / directories / what was skipped), decided tradeoffs, and **Hard Rules 4/5 verbatim** — no findings table, no verdict. Stage 2 domain / security seats additionally load the **findings contract**: `references/finding-format.md`, `references/security-review.md` (security seats), and the instruction to produce findings with **Merge class** (§ Merge class), return them in the result payload (writable seats may **best-effort** write the Stage 2 evidence file directly — the main agent merges — § Local report archive), and return only findings — no fixes; never post. Every seat's reads are **pack-first and bounded**: the pinned diff pack is read **FIRST**, then targeted opens of changed files **in the seat's domain** (within the `fileOpenCap` the seat's `## Budget` block states); adjacent-context follow-ups only on a must-fix trail — and degradation ladder ① is consulted first (§ Time budget & degradation ladder). A deep-tier domain seat dispatched with `collectFolded` (CLI: `mstar pr-review seat-prompt --collect-folded`) receives this order as the fold bullet after its `## Budget` block. Every seat prompt opens that block with the resolved **tier** and the **whole-review soft wall-clock cap** plus the minutes left of it at dispatch (`--remaining-minutes <n>`) — one shared clock, never a fresh per-seat allowance (**§ Seat supervision**).

> **Engine check (when available):** run `mstar pr-review seat-prompt --stage 1|2 --domain <d> --seat <id> --worktree <path> [--security] [--recon <fact> ...] [--diff-file <path>] [--collect-folded] [--remaining-minutes <n>]` (or `import { prReviewSeatPrompt } from "@mstar-harness/engine"` in a host hook) to generate the prompt skeleton — tier + shared soft-cap/remaining-budget head on the `## Budget` block, Hard Rules 4/5 verbatim, payload-return contract, no-verdict/no-post clauses, slug `<domain>-<seat>`, Merge-class instruction on stage 2. Judgment stays with the PM/agent: domain selection, which tradeoffs are decided, and whether the surface warrants the security lens. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Re-review (same target, later head)

A re-review is the same target reviewed again after its head moved: the run directory already holds a prior report for that PR / branch / diff. The prior report is an **input**, not the scope. When that report is settled and its head is still an ancestor of the new head — the **covering path** — the work is (1) revalidate what it reported, then (2) review only the increment. Every other case (prior `incomplete`, rewritten history, unprovable coverage) is a **full review** of `base...<new-head>` that still revalidates the prior findings. Re-reading hunks a covering prior report already covered burns the tier budget and buys nothing.

- **Locate the prior report first.** Same-day rounds share the run directory and escalate `report.md` → `report-r2.md` → … ; a later date starts its own run directory (§ Local report archive). Take the target's newest report by `generated_at` — a report whose frontmatter carries `supersedes:` names its predecessor directly, so follow that chain where present. Its `head:` is the re-review base. A prior report without `head:` (arbitrary diff, unknown provenance) cannot anchor an increment: run a fresh review and state why.
- **Arbitrary-diff targets have no stable identity.** A `<date>-diff-<short-head-sha>` directory embeds the reviewed head, so advancing the head creates a new directory, no name match identifies the predecessor, and unrelated diffs can coexist. `pr` / `branch` targets use the newest-report rule above; for an arbitrary diff a re-review runs only when the operator names the prior report (or its head) explicitly — otherwise it is a fresh review, stated as such.
- **Diff basis — the two-endpoint increment, never three-dot.** The increment is `git diff <prior-head>..<new-head>` (two endpoints; identical to the three-dot form only while the prior head is still an ancestor), and it is computable **only when** `git merge-base --is-ancestor <prior-head> <new-head>` holds. Read that increment in full plus each revalidated finding's fix site; hunks the prior report already covered stay covered. Coverage additionally requires a **settled** prior report: under `verdict: incomplete` an unread diff basis or an unopened seat left part of the original change unreviewed, so no hunk is prior-covered and the run reviews `base...<new-head>` in full instead (§ A rewritten history). The review worktree and its recorded base are unchanged (§ Worktree isolation) — the increment is a second diff computed inside it, never a new base.
- **Seat input — the increment pack on a covering re-review, the full diff otherwise.** A covering re-review never hands seats the setup `diffFile`: that snapshot is the full `base...<new-head>` diff and would put every prior hunk back in front of them. Write the increment once, from the primary checkout (§ Local report archive — never the worktree), as `{REVIEW_DIR}/<run-dir>/increment-<prior-head7>-<new-head7>.diff` — an evidence file of this run (§ Local report archive — Evidence files), one per re-review and never overwritten — and pass that path to every seat as `--diff-file` (§ Seat prompts) — the same argument the setup snapshot fills on a first review. Everywhere else (rewritten history, prior `incomplete`, unprovable coverage) the reviewed scope **is** the full `base...<new-head>` diff, so that full diff is the pack (the setup snapshot, or a full snapshot written into the run directory); never pass an increment pack for a scope it does not cover. Seats also get the prior report's path and their assigned findings for revalidation: no pack contains code the prior report already covered.
- **A rewritten history is not an increment.** When the ancestry test fails (rebase / force-push), the prior head is not on the new line of descent: `<prior-head>..<new-head>` is a replacement diff, and no hunk may be claimed as prior-covered. Review the resolved `base...<new-head>` in full and revalidate every prior finding; the report states the fallback under `- notes:`. Patch equivalence (`git range-diff` / `git cherry`) does not prove the final hunks, or a conflict resolution, came out unchanged, so it never stands in for that review. There is no partial-coverage shortcut: `- notes:` cannot qualify a verdict, and no other carrier expresses a reduced scope (§ Verdict synthesis — one settled precondition, three override conditions).
- **Revalidate before hunting** — for every accepted finding in the prior report and every `- unverified:` item, decide exactly one of `fixed` / `still present` / `regressed` / `not verifiable`, by opening the cited site. `fixed` means the reported outcome is gone, not merely that the cited line moved. Carry the prior `Considered & rejected` list forward: a rejected candidate is not re-chased without new evidence, and a prior `not verifiable` lead that a minimal check now settles becomes a finding or disappears.
- **The tally describes the current state** — `fixed` findings leave the tally; carrying them would penalize one defect twice and keep the verdict from ever improving. `still present` and `regressed` are re-classed by the current merge-class criteria (§ Merge class), with the prior class as a reference point only — a defect that now reaches data loss or an auth bypass is `must-fix` whatever it was before. New findings come only from the reviewed scope (the increment on the covering path, the full diff otherwise) and the fix sites. Both groups are listed separately (§ Report template). Linked-issue AC is re-scored against the new head: a prior `unmet` criterion the reviewed scope now satisfies stops incrementing the tally (§ Linked-issue hygiene).
- **Scope widens only for a stated reason** — new files or hunks the reviewed scope introduces; a prior cross-domain `- notes:` it now touches. A prior `incomplete` never narrows scope — it takes the full `base...<new-head>` review — and a rewritten history follows the rewritten-history rule.
- **Seats and tier follow the reviewed scope** — a covering re-review derives them from the increment; a full review derives them from the full `base...<new-head>` diff. Same bands either way (§ Inference ladder); a security-sensitive increment stays `deep` at any size. A domain that neither the reviewed scope nor any revalidated finding touches needs no seat, and every seat that raised a prior finding takes that finding's revalidation. The verdict contract is unchanged: one verdict from the current tally, one GitHub Review, posted by the main agent.
- **Post a new Review, then close out the prior one** — `event: COMMENT` as always (§ Comment posting), with the `### Revalidated findings` subsection in the body; the new review is posted once and never edited afterwards, while earlier material from this flow is closed out after the POST by **Thread lifecycle** (§ Comment posting — resolve the threads of `fixed` findings, fold earlier review bodies behind a pointer to the new one). Still binding: never reopen a thread, never edit an inline comment body, never rewrite a human/third-party review. The reviewed scope bounds what you read, not the posting coordinates: inline `path` + `line` resolve against the PR's `base...<new-head>` diff, and the line fallback is unchanged.
- **Issue store — disclose the disposition, never close.** A prior finding already captured as an issue is reported with its revalidated state (issue id + state). A recurrence appends an occurrence through the capture contract; a finding that is now `fixed` is reported as `fixed` for the closure authority to act on — the review never closes an issue, because closure is a separate authorized act (§4 of the capture contract in **`mstar-project-governance`「Issue capture」**).

## Review depth (tiers)

PR review runs at one of three tiers — `quick` / `default` / `deep` — chosen by an explicit keyword or inferred from the change shape (§ Inference ladder). `deep` follows § Review pipeline: two waves by default when the pinned diff pack exists (collect folded into the domain seats — `collectFolded`), with the full three-stage pipeline as the kept-wave exception; `default` is the no-flag landing tier for small code PRs; `quick` serves explicit intent and tiny-mechanical diffs. Every tier keeps the same verdict contract: one verdict derived from the tally, one GitHub Review, posted by the main agent (§ Verdict synthesis / § Comment posting).

| Tier | Seats | Domain split | Security coverage | Synthesis | Relative seat-time | Budget | Boundary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `deep` | 2–4 (2–3 domain + 0–1 independent security; collect folded — kept-wave exceptions add 2–3 collect → 4–7) | 2–3 by domain | in-domain lens **+ independent cross-domain security seat** | main agent, all stages (two waves by default; three in kept-wave exceptions) | longest (longer still in kept-wave exceptions) | 15 min | § Review pipeline fold default — two waves when the pack exists, three-stage kept-wave exceptions |
| `default` | 2 (two domain seats; collection folded in = seat reuse) | 2 seats by dominant surface (code/tests, backend/frontend); single-surface PR → second seat = dedicated same-domain security-lens seat | both seats carry the in-domain security lens; **no independent cross-domain seat** (cross-domain boundary issues still go to `- notes:`; the main agent may announce an upgrade to deep) | main agent (kept) | medium (≈ ½ of deep) | 10 min | typical ≤~300 changed lines; PM may announce an upgrade to deep by risk shape and declare it in the report (`- notes:`); downgraded cuts are declared likewise |
| `quick` | 1 (single domain seat; collect + review in one pass) | none (one seat, one pass) | in-domain security lens in the same seat (§2/§3 discipline); **no independent seat**; sensitive surface + explicit quick → lens still runs, report declares reduced coverage under `- notes:` | main agent (kept, smallest input) | shortest (≈ ¼) | 5 min | recommended ≤~300 / mechanical shape; report must declare tier |

**Budget column** — wall-clock minutes only; the per-seat caps live in the engine constant table (`PR_REVIEW_TIER_BUDGETS`) and are never restated in prose. Baseline: 100 tok/s output assumption; wall-clock measured worktree-setup → report saved by the main agent; budgets are prompt-discipline targets with report-declared overruns (`- notes:`), not host-level kills — an overrun is never a settlement fact, so it cannot select the `incomplete` token (§ Verdict synthesis). The cap is **one shared clock for the whole review**: every seat prompt carries the tier and the minutes left of it at dispatch, and the main agent nudges running seats with the remaining budget while they run (**§ Seat supervision**). When a budget runs tight, degrade per **§ Time budget & degradation ladder**.

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
- **Never cut (any tier)**: the verdict-from-tally formula (one formula, all tiers), merge-class assignment + tiered three-way vet (full for must-fix/should-fix; evidence-verify for nits), posting ownership (sole main agent), evidence discipline (`file:line` + self-check), Hard Rules 4/5, seats read-only, worktree isolation, the batch contract (first-only + deferred-PR issue tracking), the capture duty (seats return evidence, main agent captures), the local report archive contract incl. frontmatter, linked-issue AC counting.
- **Stage 3 is never skipped in any tier** — `quick` just feeds it the smallest input; one verdict / one Review / main-agent posting is the product contract.

**Report `tier` declaration**: report frontmatter gains an optional `tier: quick | default | deep` (absent = `default` semantics, valid — old reports stay valid). `quick` MUST declare its reduced coverage under `- notes:` (what did not run: independent security seat / Stage 1 wave / domain split); any announced upgrade or downgrade (e.g. PM announces deep-upgrade, or a downgraded cut happens) is declared the same way. Report template structure, tally counts, and the display contract are unchanged; tier never enters the report filename.

## Time budget & degradation ladder

Each tier carries a wall-clock budget (§ Review depth (tiers) **Budget** column; the engine constant table `PR_REVIEW_TIER_BUDGETS` is the numeric SSOT — per-seat caps are never restated in prose). When a budget runs tight, degrade **in ladder order** — each rung trades review depth, never the verdict contract:

1. **① Read-depth** — cut adjacent-context follow-up reads first (§ Scoping: the changed files are still read in full; only how far past the named diff you trace shrinks).
2. **② Seat topology** — collect fold (Stage 1 folds into the domain seats — the default shape for `default`, and for `deep` when the pack exists; kept-wave `deep` folds here under budget pressure) and/or merge the independent cross-domain security seat into the domain seats. **NEVER on a security-sensitive surface** (`security-review.md` §9 extended surfaces — Inference ladder step 3: sensitive surfaces are never thinned; there the overrun is declared instead).
3. **③ Display** — nits fold into the review summary body (display only — every accepted finding stays listed; § Verdict synthesis).

**Never degradable** (any tier, any rung): verdict-from-tally, posting ownership (sole main agent), evidence `file:line` + self-check, local report archival, the batch contract — the ladder-relevant core of the § Review depth (tiers) never-cut list. **Every degradation taken is declared** in the report under `- notes:` (rung + what was cut). Verdict-from-tally governs every **settled** run (§ Verdict synthesis defines one — completed without a stop, every required domain opened and the resolved diff basis readable and complete); a run that cannot meet that precondition publishes the one derived override `incomplete` instead (§ Verdict synthesis owns the single trigger list and the cause/scope facts); the clock alone never selects it — an overrun with complete coverage is a settled run that declares the overrun under `- notes:`. The override remains a derived state, not a degraded verdict, and never a pass that authorizes merge.

> **Engine check (when available):** run `mstar pr-review budget` (or `import { PR_REVIEW_TIER_BUDGETS, PR_REVIEW_NUDGE_CADENCE } from "@mstar-harness/engine"` in a host hook) to print the per-tier time-budget table (wall-clock target + per-seat caps) and the nudge cadence — seat prompts interpolate their budget block from the same constant table; never hand-copy per-seat cap numbers or cadence seconds. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Seat supervision (progress nudges)

The tier budget is **one clock for the whole review**, started at worktree-setup (§ Review depth **Budget column**). While seats run, the main agent keeps each one moving on the remaining budget instead of waiting blind:

1. **Dispatch with the figure** — compute the shared clock's remaining minutes (cap minus elapsed since worktree-setup) and pass them to every seat: `mstar pr-review seat-prompt … --tier <tier> --remaining-minutes <n>`; the prompt's `## Budget` head carries the tier and the shared cap. Recompute per wave — a Stage 2 seat never inherits Stage 1's starting figure.
2. **Nudge on cadence** — while any seat is unresolved, message each *running* seat its remaining budget: every `normalSeconds` while the review is inside its cap, and every `overrunSeconds` once the cap is passed (engine `PR_REVIEW_NUDGE_CADENCE`, printed by `mstar pr-review budget`; the numbers are never restated in prose). Recompute that remainder from the worktree-setup start on **every** tick — never reuse the figure the previous nudge displayed, or rounding drifts. A nudge states remaining-or-over minutes and asks for convergence to the output contract with truncated coverage declared — it never adds scope, never restarts a seat, and never re-asks for work already returned.
3. **Tick only what is still unresolved** — a seat whose payload arrived is resolved: it leaves the tick set and is never messaged again. Read that from the host's own signal (omp: the seat's card / `read agent://<id>`; a result that already reached the main agent is a completion whatever the card says). Time the tick with the host's own wait — a bounded `sleep <seconds>` between messages, never a blocking wait on the whole wave, which is how ticks get missed. A host that cannot report liveness mid-run is the **§ Host difference** case below, not a licence to guess.
4. **Record elapsed at receipt** — `elapsed` is measured worktree-setup → last seat's return (or the synthesis decision, § Local report archive), so the PM stamps each seat's return against that same start; a seat's own payload tail cannot establish when it finished.
5. **Overrun is not a kill** — nudges are prompt discipline: a late seat still returns what it has, the main agent degrades per **§ Time budget & degradation ladder**, and the report declares the overrun plus every degradation under `- notes:`; the clock never settles the run, so an overrun with every required domain opened and the diff basis read still publishes its tally-derived verdict (§ Verdict synthesis).

**Host difference** — nudging needs a host that can message a seat *while it runs* (the omp Task/subagent card path: `write agent://<id>`). Where seats are fire-and-forget (the dsh native `workflow` tool's `agent()` children), the seat-side contract is the only lever: keep the tier + shared-cap + remaining-minutes head of the prompt accurate, and read overrun declarations from the seats' own payload tails. Never fake a tick the host cannot deliver.

## Worktree isolation
- All git mechanics — real-base resolution (never assume `main`), collision-free branch naming (`pr-<n>` → `pr-<n>-<date>-<i>` loop before **any** fetch), explicit-refspec fetches (single-branch/narrowed fetch configs stay correct; do **not** substitute `gh pr checkout <n>` — it lands on the PR-head name instead of the recorded branch, bypassing the ownership protocol), worktree creation, changeset pre-flight (untracked-only working-tree changes count as non-empty), diff-basis computation, sidecar recording, removal + prune + exact-branch deletion — execute mechanically:

> **Engine check (when available):** run `mstar pr-review worktree-setup --pr <n> | --branch <b> | --diff | --working-tree | --commit <sha> [--path <dir>]` (or `import { pickReviewBranchName, preflightChangeset } from "@mstar-harness/engine"` in a host hook) to create the isolated review worktree (default location `<parent-of-repo>/{repo}.worktrees/review-…` per the mstar-branch-worktree convention, override with `--path <dir>`), compute the diff basis inside it, record a sidecar json, and print `{reviewBranch, worktreePath, base, mergeBase, diffCmd, diffFile}` — `diffFile` is the pinned diff snapshot written beside the sidecar at `<parent-of-worktree>/.<wt-dirname>.prreview.diff` (`null` for `--diff` / `--working-tree` modes, which write no snapshot); clean up with `mstar pr-review worktree-cleanup --path <dir> --branch <name> --report-saved` — removes the tree, prunes, deletes **exactly** the recorded branch (a foreign/unrecorded branch is refused), removes the snapshot file, and refuses removal while the local report is unsaved. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

The diff snapshot is a review artifact beside the sidecar (`.‹wt-dirname›.prreview.diff` in the worktree's parent dir): setup writes it, cleanup removes it together with the worktree + sidecar, and a failed setup's rollback removes it too — it is never an orphan. Ownership is fd-bound identity: setup records the snapshot's `dev`/`ino`/`mtime` in the sidecar, and cleanup opens the path, verifies the open fd against the recorded identity, and unlinks only after a rename proves the fd's inode is the one it verified — a replaced file (even with identical bytes, or with a reused inode number on ext4) or a sidecar without the recorded identity is left in place with a note; a replacement swapped in mid-cleanup is restored via hard link — never overwriting a concurrent occupant of the path (EEXIST leaves both files in place, nothing deleted). An interrupted setup (sidecar written, snapshot never recorded) is refused by the next `worktree-setup` with a cleanup hint — the operator runs `mstar pr-review worktree-cleanup --path <dir> --branch <name|""> --report-saved` to remove the stale sidecar, then retries. Its range semantics: `## Commits` is the two-dot `base..head` form (commits reachable from head but not base), while `## Files changed` / `## Diff` use the three-dot merge-base pair — the same split the seat reads.

Discipline that stays with the agent (behavior, not git mechanics):

- Review from a dedicated linked worktree — **never the primary repo cwd, never another harness worktree** — and compute the diff basis inside it against the recorded refs, three-dot style: **never the primary `HEAD`** (the primary checkout may sit on a different branch).
- Input-mode shape: bare branch reviews use a detached worktree against the fetched remote-tracking ref (no local ownership protocol, no local branch to delete); arbitrary-diff inputs verify stated provenance and read changed files locally — no worktree, no branch, nothing to clean up; working-tree inputs take tracked + staged + untracked changes read in full (the review stays read-only — no fixes, no stash; `comments: n/a-no-pr`); single-commit inputs verify provenance but read file context **at that commit** (`git show <sha>:<path>`), which diverges from the current checkout whenever HEAD ≠ `<sha>` or the file changed since.
- **Pre-flight before fanning out lenses** (every mode): named refs resolve (in modes that have refs) and the changeset is non-empty — an empty changeset reports "no changes to review" and stops; never spawn lenses on an empty changeset.
- Record before computing: review cwd, `<review-branch>`, HEAD sha, merge-base.
- Clean up **once the local report is saved** — the save runs in all three posting branches (`posted: yes` / `n/a-no-pr` / `failed`; § Local report archive), so cleanup never waits on POST success — then delete **exactly** the recorded `<review-branch>` (provably this review's own branch); never delete a pre-existing branch. Never remove other harness worktrees.

## Scoping

- Review the diff basis vs base: changed files plus what the change touches.
- Read changed files **in full** — diffs hide context — **scoped to the seat's domain files** (§ Review pipeline domain split); full-repo reading is not the contract — the pack is (pinned diff pack first, bounded follow-ups — § Seat prompts).
- Apply **`mstar-audit` SKILL.md** § Phase 1's real-flow, affected-consumer, and expected-load judgments to adjacent behavior (importers, callers, dependent contracts), within the pinned pack's domain and bounded follow-ups.
- When the diff touches tests, read the tests before the implementation — they carry intent.
- Verification claims in the PR description must be reproducible from the diff/CI; a claim that cannot be checked is an `unverified` lead, not evidence.
- **Domains** — review is split by domain (**business domain / change surface / tech stack**; § Review pipeline). Each domain seat concludes **only on its own domain**.
- Cross-domain boundary issues (importers / callers reaching outside the seat's domain) → record to the evidence file `- notes:`; the main agent decides whether an additional cross-domain seat is warranted.

## Sizing & change shape

- **Sizing bands:** ~100 changed lines → reviewable; ~300 → acceptable as one logical change; ~1000 → too large — advise a split (a `should-fix` finding with split advice, or a verdict note; never auto-`blocked`). Whole-file deletions and mechanical/automated refactors are exempt — verify intent, not every line.
- **File-size watch:** a small diff that materially grows a file past ~1000 *total* lines → advise extract/decompose first ("decompose, then add"). This remains a review trigger; choose the actual decomposition by responsibility per `references/finding-format.md` § Structural remedies, not line-count-only helpers.
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

Apply the shared investigation order in **`mstar-audit` SKILL.md** § Phase 2; use **`references/audit-playbook.md`** §§ 1, 4, 5 for concurrency/lifetime, meaningful missing-test, and simplification judgments as relevant. All follow-ups remain scoped by § Scoping and the seat budget.

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

Smell remedies are candidates, not automatic demands for new abstractions; select the smallest evidenced repair per **`references/finding-format.md`** § Structural remedies.

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

The **main agent** is the final vet layer, and the synthesis vet is **tiered**: must-fix / should-fix findings run the full three-way attack (counter-example, simpler explanation, evidence verifiability); nits run **evidence-verify** only — open the cited file and confirm `file:line` genuinely supports the claim. At synthesis the main agent dedupes **all** findings across domains (cross-domain duplicates, mis-attribution), applies the same by-design / duplicate disposition with the `cited code yourself` discipline, and records every rejection in the report's **Considered & rejected** section. Tiering applies to the main-agent synthesis pass only — the domain seats' three-way attack above stays full (it is cheap per-finding at the seat). Subagents over-report; vet before presenting.

## Verdict synthesis

- Order findings by impact-if-shipped; no padding, no invented requirements, no style grading.
- List **every** accepted finding — `must-fix`, `should-fix`, and nits alike; nothing is truncated.
- The verdict is **derived from the tally, not chosen**: classify every accepted finding (§ Merge class) → apply leftover `unmet` AC increments if any (§ Linked-issue hygiene) → apply **Verdict-from-tally** (§ Tally and derived score) → emit that one token. The reviewer does not pick a verdict by vibe. That derived token is what a **settled** run publishes; the one derived override below replaces the token without re-deriving it.
- Exactly one verdict:
  - `ship it` — evidence-backed, safe to ship.
  - `needs fixes` — issues found; address before merge.
  - `blocked` — a must-fix issue stands in the way of shipping.
  - `incomplete` — **the one derived override, and the single trigger list for it**: a **settled** run — **completed without a stop**, every required domain opened and the resolved diff basis readable and complete (the pinned snapshot when the mode produces one, otherwise the resolved `--diff` / `--working-tree` input) — publishes the tally-derived token above; a run that cannot meet that precondition publishes this token instead, with the two facts a bare token cannot carry. It fires on **exactly three conditions**: the run stopped before synthesis (cancelled / interrupted), a **required** domain seat never opened, or the resolved diff basis could not be read. **Wall-clock overrun is not one of them** — the tier budget is prompt discipline (§ Time budget & degradation ladder): a run that exceeded it but opened every required domain and read the diff basis stays settled, publishes its tally-derived token, and declares the overrun under `- notes:`. `incomplete` is the last-resort fallback for a run that cannot describe its own scope, never a routine outcome. Per-item unverifiability is **not** this case: a residual the vet could not verify belongs to a settled run and is recorded under `- unverified:` (§ Tally and derived score). **Derived, not declared** — `resolvePrReviewSettlement` (engine, exported) is the rule's one implementation: it reads the three run facts above and returns either `{ settled: true }` or the **cause** (why the run is not whole) plus the **unscanned** scope (what it never reached), both single-line. `mstar pr-review tally` feeds exactly those facts — the required `--required-domains`, `--opened-domains` and `--diff-basis`, plus the optional `--stopped` and `--partial-scope` — and the derived pair travels in the unchanged `incomplete` field; omitting a required fact is a usage refusal, never a defaulted settled run. Both domain lists are **seat occurrences, not domain memberships**: one entry per required seat, so a domain with two seats (the `default` tier's normal seat plus a same-domain security-lens seat) needs two entries, and two opened entries when both returned — one seat's evidence never satisfies its sibling. `--partial-scope` repeats once per scope a seat declared as truncated coverage in its payload tail; those entries join the derived `unscanned` list of a stopped or missing-seat run (deduplicated, after the missing seats and an unreadable basis), so a seat that named work it never reached is never reported as `unscanned: none`. The score, band and four counts stay the count-derived ones, marked `partial`. It is **neither a pass nor a failure**: a consumer must never read it as `ship it`, never record it as an approval, and it **never authorizes merge**. Carriers → § Tally and derived score › Override invariant (envelope fact), § Display contract (header), § Local report archive (report frontmatter).

## Merge class (PR findings only)

Classify each **accepted** finding (after vet) as exactly one class. Do not invent a fourth class. Do not derive class from `Confidence`.

| Class | Use when | Verdict effect |
| --- | --- | --- |
| `must-fix` | Shipping this issue is unsafe **and** the unsafe outcome is reachable in the reviewed change: correctness bug, security hole, data loss, auth/authz bypass, or a broken public contract. This is the same class the store.db issue severity vocabulary records as `critical` (class pointer below). Same meaning as today's `blocked` gloss ("a must-fix issue stands in the way of shipping"). | Any count ≥ 1 → `blocked` |
| `should-fix` | A real issue that should be addressed before merge but is not itself a ship-stopper: unsafe but **not** reachable in this change, significant tech debt, or otherwise substantive non-blocking — the issue severity vocabulary's `high` / `medium` bands. Same meaning as today's middle gloss ("issues found; address before merge"). | Else if count ≥ 1 → `needs fixes` |
| `nit` | Optional cleanup, naming, comment, or small suggestion that does **not** change merge-readiness. Lint-covered cosmetics stay ignored (existing lens rule) — they are not findings. | Does not change verdict |

**Class ↔ issue severity:** these three classes are this chain's projection of the one blocking judgement — the store.db issue `severity` value, plan-QC report section, and L2 task-review label sitting at each band are tabulated in `mstar-artifacts` `references/status-and-residuals.md` § Residual findings: `severity` → §5 Cross-chain vocabulary. Translate by band; never re-grade on translation.

Tie-break: unsafe to ship **and reachable in this change** → `must-fix`; should be addressed before merge but ship-safe → `should-fix`; otherwise `nit`. A LOW-confidence smell that fails evidence rules is **not** a finding (existing disqualify rules) — put it on `- unverified:` if it must be mentioned.

Presumptive-structural classes: a refactor that relocates complexity instead of reducing it · a change pushing a file past the size boundary with no decomposition · feature logic added to a shared module · a near-duplicate of an existing canonical helper · a silent fallback hiding an unclear invariant → default `should-fix`; downgrade to `nit` only with a stated reason; never `must-fix` on shape alone without correctness/security evidence.

Field placement: on each finding, `- **Merge class**: must-fix | should-fix | nit`, immediately after `Confidence` (before `Fix sketch`). The shared finding template (`references/finding-format.md`) is unchanged — this field is PR-review-only.

> **Engine check (when available):** run `mstar lint <file.md>` with `--type finding` (add `--pr-variant` for the PR Merge-class contract) — or `import { validateFindingDoc } from "@mstar-harness/engine"` in a host hook — to machine-check a findings document: `### [CATEGORY-NN]` numbering, category / effort / risk / confidence enums, evidence `path:line` shape, and the Merge-class presence/enum/placement rule. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Tally and derived score

Verbatim, applied after the vet pass to **accepted** findings, then leftover unmet ACs:

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

`score_pct` — integer arithmetic only. Floor at 0. No decimals. No second formula. Deductions diminish per finding within a class, and two classes carry a cap:

| class      | nth-finding deduction                | class cap |
| ---------- | ------------------------------------ | --------- |
| must-fix   | 45, then 15 each additional          | none      |
| should-fix | max(12 − 3·(n−1), 2) → 12,9,6,3,2,2… | none      |
| nit        | 2 first, then 1 each                 | 8         |
| unverified | 5 each                               | 15        |

```
score_pct = max(0, 100 - Σ class deductions)
```

Property: nits and unverified alone can never drop the score below 77, so a PR with no must-fix/should-fix can never enter the `fail` band.

**Score bands** — a display annotation derived from `score_pct` (never stored in the report frontmatter; `score_pct` is the only score key):

| band | score_pct |
| --- | --- |
| `mergeable` | ≥ 90 |
| `good` | 80–89 |
| `pass` | 60–79 |
| `fail` | < 60 |

### Override invariant

```
Score and band never override verdict.
blocked + any score_pct       → not shippable
needs fixes + any score_pct   → still address findings before merge
ship it + score_pct < 100    → allowed (nits and/or unverified deducted)
incomplete + any score_pct   → still not a pass and still not mergeable; the grade is a partial one
High score_pct never means APPROVE. Low score_pct never means REQUEST_CHANGES.
A band grades the finding load only — `ship it` + `good` (e.g. 3 unverified) is legal.
```

**An unsettled run derives the override; it is the only one.** The tally cannot express "the review is not whole" — that is a fact about the run, not about the change — so the declaration replaces the emitted verdict token and nothing else: `computePrTally` keeps the count-derived `scorePct`, `band` and four counts, and the band renders as `partial` (§ Display contract). What makes a run unsettled is § Verdict synthesis's three run facts — derived once by `resolvePrReviewSettlement` and supplied to `mstar pr-review tally` as `--required-domains`, `--opened-domains` and `--diff-basis` (all three required; omitting one is refused, never inferred) plus the optional `--stopped` and `--partial-scope` — never its clock: a maxed wall clock with complete coverage keeps the tally-derived verdict and declares the overrun under `- notes:`. The fact is rejected on every other verdict, so the token is never published bare and a settled report never carries it: the `mstar.review/v1` envelope requires `incomplete: { reason, unscanned }` on that verdict (its own `synthesizeReview` echoes the same facts onto `tally.incomplete`), and the local report frontmatter requires `incomplete_reason` plus `unscanned` (§ Local report archive).

> **Engine check (when available):** the invariant is enforced structurally — `computePrTally` derives the verdict from the tally before the score is computed, and `mstar pr-review validate-report` flags a `verdict` that does not follow from the report's own tally (`prreview.report.verdict-mismatch`, severity high); that check is skipped for the derived `incomplete` token alone, while its `score_pct` recompute still runs. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

### Worked examples (check table)

| must / should / nit / unverified | score_pct | band | verdict | Display line |
| --- | --- | --- | --- | --- |
| 0 / 0 / 0 / 0 (clean) | 100 | `mergeable` | `ship it` | `ship it · 100% (mergeable)` |
| 0 / 0 / 0 / 0 + 1 leftover unmet AC | 88 | `good` | `needs fixes` | `needs fixes · 88% (good)` |
| 0 / 0 / 0 / 0 + 1 leftover unmet AC (unsafe-to-ship) | 55 | `fail` | `blocked` | `blocked · 55% (fail)` |
| 0 / 0 / 2 / 0 | 97 | `mergeable` | `ship it` | `ship it · 97% (mergeable)` |
| 0 / 0 / 0 / 2 | 90 | `mergeable` | `ship it` | `ship it · 90% (mergeable)` |
| 0 / 1 / 0 / 0 | 88 | `good` | `needs fixes` | `needs fixes · 88% (good)` |
| 0 / 1 / 1 / 0 | 86 | `good` | `needs fixes` | `needs fixes · 86% (good)` |
| 1 / 0 / 0 / 0 | 55 | `fail` | `blocked` | `blocked · 55% (fail)` |
| 1 / 2 / 1 / 1 | 27 | `fail` | `blocked` | `blocked · 27% (fail)` |
| 3 / 0 / 0 / 0 | 25 | `fail` | `blocked` | `blocked · 25% (fail)` |
| 0 / 0 / 10 / 0 (nit class cap) | 92 | `mergeable` | `ship it` | `ship it · 92% (mergeable)` |
| 0 / 0 / 0 / 3 (unverified cap boundary) | 85 | `good` | `ship it` | `ship it · 85% (good)` |
| 7 / 0 / 0 / 0 (floor) | 0 | `fail` | `blocked` | `blocked · 0% (fail)` |
| 0 / 0 / 0 / 100 (unverified class cap) | 85 | `good` | `ship it` | `ship it · 85% (good)` |
| 1 / 0 / 1 / 0 + derived `incomplete` (run-fact override) | 53 | `fail` | `incomplete` | `incomplete · 53% (fail, partial)` |

`blocked · 55%` is still not shippable. `needs fixes · 88%` still means address findings. `ship it · 85% (good)` is legal — the band grades the finding load, the verdict governs mergeability. This table is mirrored row-for-row as the engine test fixture (`packages/engine/test/prreview.test.ts`) — the table text is the SSOT anchor. Rows 1–14 are the **count-derived** rows and mirror the fixture's check-table array; the `incomplete` row is the one **run-fact override** — identical counts and identical 53 / `fail` grade, token derived from the run facts by `resolvePrReviewSettlement` — and the fixture covers that case in its own `computePrTally — incomplete verdict` block plus the `resolvePrReviewSettlement` block above it. An override display continues past its first line with the `cause:` and `unscanned:` lines (§ Display contract).

> **Engine check (when available):** run `mstar pr-review tally --findings <file.json> [--unverified <n>] [--unmet-ac-unsafe <n>] [--unmet-ac-safe <n>] [--stopped <text>] --required-domains <d,d,...> --opened-domains <d,d,...> --diff-basis <readable|unreadable> [--partial-scope <scope...>]` (or `import { computePrTally, resolvePrReviewSettlement } from "@mstar-harness/engine"` in a host hook) to compute this tally, verdict and score from the accepted findings JSON — the run facts are fed to `resolvePrReviewSettlement`, which derives the `incomplete` fact (there is no time input, so an overrun cannot select the token). Both domain lists are **seat occurrences**: `--required-domains` / `--opened-domains` take one entry per required seat, so a domain with two seats appears twice and needs two matching `--opened-domains` entries when both returned. A **settled** run carries no `unscanned`, so a declared truncated seat scope is recorded by the report under `- unverified:` / `- notes:` and the `tally` output echoes it as `declaredScopes` (an unsettled run keeps it in `incomplete.unscanned`). `declaredScopes` is a **tally-output fact** feeding the report's `- unverified:` / `- notes:`; it is **not part of `mstar.review/v1`** and is not a declared report-frontmatter field, so copying it into either surface is **outside the contract** — the envelope tolerates unknown keys silently and the frontmatter parser accepts arbitrary scalar keys, but **tolerance is not permission**. The three coverage/basis facts are **required** on both surfaces: omitting `--required-domains`, `--opened-domains` or `--diff-basis` (or the matching `PrReviewRunFacts` member) is refused rather than defaulted, because the CLI never infers coverage — an unreported fact is never read as complete coverage; the check table above is the SSOT the engine fixture mirrors (`packages/engine/test/prreview.test.ts`); never hand-compute when the CLI is available. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Originating spec discovery

Find the originating spec — the acceptance criteria live there, not in the diff:

- Issue references in the PR body / commit messages (`#123`, `Closes`, `Fixes`).
- A spec path the user named in the request.
- Repo candidates: `{SPECS_DIR}`, `docs/specs` / ADR directories, `STRATEGY.md` / `PRODUCT.md`, roadmap.
- None → ask the user once; still none → note "no spec available", score nothing, never invent requirements (existing rule).

## Linked-issue hygiene

When an originating spec exists (§ Originating spec discovery — a tracked issue, spec file, or ADR), score **every** acceptance criterion against the diff:

- Mark each: met / unmet / cut.

Leftover `unmet` criteria count against the verdict: they are **tally increments**, not extra findings (do not also emit a Merge-class finding for the same leftover — that would double-count). Each leftover AC marked `unmet` (not `met`, not `cut`) increments `should_fix` by 1, or `must_fix` by 1 when that leftover is itself a broken public contract / unsafe-to-ship. The increment lives in the tally procedure (§ Tally and derived score); apply Verdict-from-tally **after** it, so leftover `unmet` ACs cannot yield `ship it`. Score uses the locked deduction schedule only (`should_fix` deducts 12 on the first finding and less thereafter, `must_fix` deducts 45 on the first — no second formula, no new tally key). Leftovers are already mentioned in the review `body` (§ Comment posting) — no fourth merge class.
- Do not invent a follow-up when all criteria landed.

## CI attribution

Check base-vs-branch before blaming the diff for CI failures. A red build that predates the branch is not a finding against the PR.

## Comment triage

- Judge the validity of bot/peer review comments before acting on them.
- **Comment-triage replies are the main agent's job at Stage 3** — seats never post or reply. For valid comments, the main agent folds the minimal fix suggestion into the finding's Fix sketch. For invalid comments, the main agent disagrees on the PR comment with clear reasoning. Never gold-plate.

## Batch sibling PRs

- **one session = one PR** (HARD): an `amazing-pr-review` session reviews exactly **one** PR. When multiple PRs are passed in, only the **first** — the first PR in the caller's argument / mention order, never sorted by PR number or recency — runs the review at its resolved tier (§ Review depth (tiers) for tier resolution → § Review pipeline for stage steps; `deep` = the three-stage pipeline with the collect wave folded by default when the pack exists — § Review pipeline); the rest are **not** processed in this session.
- **Track the rest as open issues** — before the review starts, capture every unprocessed PR as an **open issue** in `{HARNESS_DIR}/store.db`, one issue per deferred PR, through the capture contract in **`mstar-project-governance`「Issue capture」** (unscoped `mstar issue add`; `mstar plan issue-add` when a plan session owns the batch). The former `mstar status backlog-register` / `backlog-close` are **retired** and refuse, naming the issue verbs; flags and the capture payload shape live in `--help` and are not restated here.
  - The issue's `title` (with its scope/impact text) carries the recoverable PR identity — `<owner>/<repo>#<n>` or the PR URL — so a later session can open the exact deferred PR from the store alone.
  - Capture is idempotent by identity (project + source identity + root cause + acceptance key): re-running a same-day batch returns the existing issue instead of opening a second one for the same PR; a distinct later observation **appends an occurrence**.
  - **Capture failure halts the session**: if the capture refuses (fail-loud, nothing written), stop and report `Blocked` — never start the first-PR review while deferred PRs are untracked (they would be neither reviewed nor tracked).
- **Backlog close**: when a session completes review of a PR that was previously deferred — at its resolved tier (`quick` / `default` / `deep` per § Review depth) — it MUST find that PR's tracking issue (identity `<owner>/<repo>#<n>`) and close it with the §4 closure authority at review completion (`mstar issue close`, or plan-scoped `mstar plan issue-close`); never leave a stale open issue for a reviewed PR.
- **Suggest one session per PR**: the report's `- notes:` states that each remaining PR gets its own `amazing-pr-review` session and is tracked in the issue store.
- **Concurrency stays inside the single PR**: for the one PR under review, create the worktree first, then fan out per the resolved tier's seat plan (§ Review depth (tiers)) — `deep` fans out per **§ Review pipeline** (collect wave folded into the domain seats by default when the pack exists — `collectFolded`; the kept-wave exception fans the Stage 1 collect seats out in one batch); `default` folds collection into the two domain seats; `quick` is a single pass. Deferred PRs get **no** review worktree, **no** review seats and **no** capture seats — the main agent captures them. The old "all worktrees first, all reviewers in one batch" model no longer applies to N PRs.
- Sibling interactions are **noted, not fixed** — interactions with deferred sibling PRs go to the report's `- notes:`, unless the ticket says so.

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
4. **Thread lifecycle** — only when the POST succeeded (`comments: posted`) and the target is a PR: run **Thread lifecycle** (below) — resolve the threads of findings revalidated as `fixed`, then fold superseded review bodies.
5. **Save the local report (§ Local report archive) — mandatory in all three branches**: POST succeeded (record `html_url` / review id for `comments:` first), POST failed, or `n/a-no-pr` (archive the chat display content). Only then clean up the worktree (§ Worktree isolation); bare branch/diff reviews have no worktree, but the save still happens.

> **Engine check (when available):** run `mstar pr-review post --pr <n> --body-file <path> [--findings <file.json>]` (or `import { planReviewPost } from "@mstar-harness/engine"` in a host hook) to execute these contracts mechanically — url-based repo resolution, the `COMMENT` literal, payload POST via stdin, and the at-most-once 422 fallback printing `review_url`; auth/API failure exits 1 (`comments: failed`). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

### Thread lifecycle

Runs only for a PR target whose review POST succeeded this run (`comments: posted`), at Stage 3 in the main agent, between the POST and the local report save; review seats never post and never call GitHub. The lifecycle has two passes, in order: resolve, then fold. Inline comment bodies are never edited or deleted, threads are never reopened, and unresolved findings keep their inline threads open and visible — that is the point of the contract, not a side condition.

**This flow's reviews — the shared candidate set.** One definition feeds both passes: the PR's reviews authored by the authenticated `gh` account whose body starts with this flow's verdict heading (`## <emoji> Verdict: \`<token>\``) **or** with the fold pointer line (`> **Superseded** — latest review:` — an already-folded earlier round). Human and third-party reviews are never in this set and are never touched by either pass.

**Resolve — threads of findings revalidated as `fixed`.** Input is this run's `### Revalidated findings` table; only state `fixed` is eligible — `still present` / `regressed` / `not verifiable` are never resolved. Read threads with `gh api graphql` over `repository.pullRequest.reviewThreads(first: 100, after: $cursor)` selecting `id`, `isResolved`, `isOutdated`, `path`, `line`, `comments(first: 20) { nodes { databaseId body pullRequestReview { databaseId } } }`, paging through `pageInfo { hasNextPage endCursor }`. A thread is a candidate **only when its opening comment's `pullRequestReview.databaseId` is one of this flow's reviews** (the shared candidate set above) — a foreign reviewer/bot thread with the same title on the same path is never a candidate. Match a `fixed` prior finding to a candidate by `path` equality plus an inline comment body whose first line equals the prior finding title verbatim (trimmed); `line` and `isOutdated` never gate the match — a thread moves or goes stale while the finding identity does not. Threads already resolved are skipped. Zero matches (the finding was summary-only after the 422 line fallback, an earlier round posted no inline, or its only same-title thread is foreign) are not an error: record it and move on. An ambiguous match — two or more candidate threads for one finding — is never guessed: leave all candidates open and record it; ambiguous candidates are excluded from `<matched>` and named under `- notes:`, so the counter measures determinate matches only. Resolve each matched thread with the GraphQL mutation `resolveReviewThread(input: {threadId: "<id>"})`.

**Fold — superseded review bodies from this flow.** Candidates are the **earlier** members of this flow's reviews (the shared candidate set above); reviews are never deleted. Each candidate body becomes the pointer line `> **Superseded** — latest review: <new review url>` followed by the original body wrapped in `<details><summary>Original review (superseded)</summary>` … `</details>`. Idempotent across rounds: a body already carrying the pointer line has only that line replaced (repointed at the newest review); it is never nested a second time. Write with `gh api --method PUT repos/<owner>/<repo>/pulls/<n>/reviews/<id> -F body=@-` — `-F/--field` is the flag that expands `@-`, so the body comes from stdin, never interpolated into a shell argument:

```bash
# Same `gh api graphql` channel as the thread read above.
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<thread-id>"}) { thread { id } } }'

gh api --method PUT repos/example-owner/example-repo/pulls/42/reviews/1234567 -F body=@- <<'EOF'
> **Superseded** — latest review: https://github.com/example-owner/example-repo/pull/42#pullrequestreview-7654321

<details><summary>Original review (superseded)</summary>

<original body>

</details>
EOF
```

**Failure and reporting.** A failed resolve or fold never downgrades a successful POST: the run stays `comments: posted`, the failure is named under `- notes:` with the API error and the unattempted scope, and the reported counts are what actually succeeded (`threads:` and `superseded:`, § Output shape). Non-goals, all binding: no review deletion, no thread reopen, no inline comment edit, no `APPROVE` / `REQUEST_CHANGES`, no merge.

### Report template (GitHub Review `body`)

The posted review body is a three-section report. Section order fixed; omit a subsection only when its content is genuinely empty (write `none`, never delete the heading). The block below shows only **fill-in slots**: a `<...>` that wraps descriptive text (`<verdict>`, `<n>`, `<finding title>`, …) is a slot — replace the whole bracket pair with real content and never render those brackets. The literal HTML tags in the template (`<details>`, `<summary>`, `<br>`) are **structural** — keep them verbatim so the collapsible block survives. The Slot rules below the template are guidance — never copy them into the posted body.

**Section emoji map** — verdict: `ship it` ✅ · `needs fixes` ⚠️ · `blocked` ⛔ · `incomplete` ⏸️. Finding classes: 🔴 must-fix · 🟠 should-fix · 🔵 nit · ❓ unverified.

````markdown
## <verdict-emoji> Verdict: `<verdict>` · Score <score_pct>% (<band>)

cause: <reason>
unscanned: <csv | none>

| Findings | Count |
| --- | --- |
| 🔴 must-fix | <n> |
| 🟠 should-fix | <n> |
| 🔵 nit | <n> |
| ❓ unverified | <n> |

## 📋 Review

**What this PR does**: <2–3 sentence summary of the diff's intent and surface>

### Revalidated findings

| Prior finding | State | Evidence |
| --- | --- | --- |
| <prior finding title> | <state> | `file:line` — what the code shows now |

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

- **Verdict**: render the band bare (`mergeable` | `good` | `pass` | `fail`). For `incomplete` only, render it as `<band>, partial` and keep the `cause:` / `unscanned:` lines under the heading — `cause` is why the run stopped, `unscanned` the comma-joined scope it never reached (`none` when nothing was left unscanned). Every other verdict deletes both lines, so a settled body keeps its exact shape.
- **What this PR does**: from the PR description plus your own read of the changed files, not copied marketing text.
- **Revalidated findings**: the § Re-review pass — one row per prior accepted finding and prior `- unverified:` item, `<state>` being exactly one of `fixed` / `still present` / `regressed` / `not verifiable`, with the evidence that decided it; a prior `not verifiable` item counts in the `unverified` tally. A first review (no prior report) writes `none` here, and a re-review does not repeat these states inside `✅ Verified`.
- **Findings**: ranked by impact-if-shipped (§ Verdict synthesis); every accepted finding listed, nothing truncated; repeat the `#### <class-emoji> <title>` block per finding. **Body soft cap ~150 lines**: past the cap, take degradation ③ (§ Time budget & degradation ladder) — nits fold into the summary body (display only: findings are never dropped — every accepted finding stays listed in some form), and the fold is declared in the report under `- notes:`.
- **Linked-issue AC**: fill only when § Linked-issue hygiene applied; otherwise a bare `none`.
- **Verified**: the smallest runtime checks actually run and what they showed; unverified leads as `❓` lines here, never in the findings table.
- **Considered & rejected**: one bullet per rejected candidate from the three-way attack / vet pass (§ Attack and vet), so the next reviewer does not re-chase it; bare `none` when nothing was rejected.
- **Plan to fix**: fix plan in markdown (ordered steps per finding, files touched, verification gates); when there is no fix plan, replace the whole `<details>` block with a single line `none`.

- The Verdict section replaces the old two-line tally header on GitHub: the same facts (verdict token + `score_pct` as Score with its band + four-class tally), structured — plus, for `incomplete`, the `partial` mark and its `cause:` / `unscanned:` lines. The chat display contract (§ Display contract) is unchanged.
- When the fix plan itself contains fenced code blocks, open the outer fence with four backticks so the inner fences survive.

### Local report archive

The posted PR comment is the deliverable; the local report is the durable reference copy — the PR thread may be buried, locked, or deleted, and bare-branch/diff reviews have no thread at all. The main agent saves the run's report at Stage 3 — the report it published — as part of the mandatory deliverable, before worktree cleanup:

- **Path**: `{REVIEW_DIR}/<run-dir>/` — the run's own directory under `{REVIEW_DIR}` (`{HARNESS_DIR}/reviews/`; `.mstarc` `review_dir` overrides it), created on write. Gitignored local SSOT, same posture as the issue store's migrated registers; a finding that must survive across clones gets promoted to tracked `{KNOWLEDGE_DIR}` / `{SPECS_DIR}`, not by tracking this directory.
- **Write via the primary checkout, never the worktree**: harness discovery must not start from the review worktree — its root has no gitignored `.mstar/`, and anything written there is destroyed by `git worktree remove` (§ Worktree isolation). Record the primary repository's absolute path **before** creating the worktree and write the report under it. Never create a `.mstar/` inside the review worktree to "host" the report.
- **Run directory**: `<YYYY-MM-DD>-pr<N>`; bare branch → `<YYYY-MM-DD>-branch-<slug>`; arbitrary diff → `<YYYY-MM-DD>-diff-<short-head-sha>`, or `<YYYY-MM-DD>-diff` when no head SHA was provided with the changeset (never invent one). The name is deterministic and idempotent: the same target reuses the same directory (a same-day re-review included); a later date gets its own directory, and § Re-review reads the newest report across them.
- **Report file**: `report.md` inside that run directory; a second report for the same target in that directory → `report-r2.md`, then `report-r3.md`, … (never overwrite a prior report) — every re-review writes the next revision (§ Re-review).
- **Evidence files**: the **main agent** writes each seat's (Stage 1 / Stage 2) evidence file in the same run directory — `stage1-<slug>.md` (Stage 1) / `stage2-<slug>.md` (Stage 2 findings draft). A re-review's increment snapshot (`increment-<prior-head7>-<new-head7>.diff`) belongs to this same evidence set: the main agent writes it into the run directory under the report/evidence authorization (Hard Rule 1), never as a third output class (§ Re-review). Seats return evidence / findings in their result payload (contract → `references/pr-review-seat-evidence.md` — any seat may be **write-blocked**; seats are **never required to write**). Writable seats may **best-effort** write their evidence file directly; the contract does not depend on it. The **main agent writes / consolidates all evidence files** from the seat payloads. `<slug>` is **domain-derived and unique per seat** — `<domain>-<seat>` — and is mandated in the seat Assignment, so two seats in the same pipeline can never collide. The same gitignored run directory and the same **write via primary checkout, never the worktree** discipline apply (an evidence file written in the review worktree is destroyed by `git worktree remove`, § Worktree isolation).
- **Frontmatter** (machine-readable metadata):
  ```yaml
  ---
  type: pr-review
  tier: quick | default | deep   # optional — absent = default semantics (§ Review depth)
  elapsed: <minutes>     # optional — non-negative integer minutes; wall-clock measured worktree-setup → report saved by the main agent; absent = valid
  pr: <n>                # omit for bare branch / diff
  url: <pr url>          # omit for bare branch / diff
  head: <head sha>
  base: <base ref>
  verdict: ship it | needs fixes | blocked | incomplete
  score_pct: <n>         # band is derived from this (mergeable | good | pass | fail) — never stored
  tally: { must-fix: <n>, should-fix: <n>, nit: <n>, unverified: <n> }
  incomplete_reason: <why the run stopped>   # required exactly when verdict: incomplete (non-empty); rejected for every other verdict
  unscanned: <csv>                          # required exactly when verdict: incomplete — comma-separated scope the run never reached, or none; rejected for every other verdict
  comments: posted | n/a-no-pr | failed   # posting tri-state — never collapse failed into n/a-no-pr ("yes" = posted alias)
  review_url: <posted review html_url>   # n/a-no-pr when skipped; failed: <gh error summary> when POST failed
  generated_at: <YYYY-MM-DD>
  pipeline: {stages: 3, seats: [<seat ids>]}   # optional — omit when the review did not run the three-stage pipeline; a folded deep review still declares stages: 3 (the fold merges waves, not stages — § Review pipeline)
  supersedes: <prior report path>   # optional — a re-review names the report it succeeds (§ Re-review)
  ---
  ```

`head:` / `base:` are omitted when genuinely unknown (arbitrary diff without stated provenance) — never fabricate identifiers.

**Posting failure does not skip archival.** The report is saved regardless of the POST outcome: on failure it archives the chat display content plus the `gh` error summary, so a failed POST still leaves the durable copy.

> **Engine check (when available):** run `mstar pr-review report-path [--reviews-dir <dir>] --target pr:<n>|branch:<slug>|diff:<sha>|diff [--stage 1|2 --slug <domain-seat>] [--date <YYYY-MM-DD>]` (`--reviews-dir` defaults to the resolved `{REVIEW_DIR}`) (or `import { prReviewReportPath } from "@mstar-harness/engine"` in a host hook) to resolve the run directory, the report file, and the Evidence-file names above — including the same-day `report-r2`/`report-r3` escalation, which the resolver scans for instead of the agent eyeballing the directory. Pure resolution: it never writes; the main agent still writes the file content. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.
- **Body**: the exact text posted as the GitHub Review body — verbatim, not a paraphrase. When `comments: n/a-no-pr` or posting failed, the body is the chat display content instead (§ Display contract header lines + ranked findings + leftover AC), so the local copy is still complete.

## Output shape

- `- findings:` — list of evidence-backed findings (`none` when none). Each accepted finding includes **Merge class** (§ Merge class). On a re-review (§ Re-review) the prior findings' revalidated states are reported here first and a `fixed` prior finding is not re-listed as a finding.
- `- verdict:` — exactly one of `ship it` / `needs fixes` / `blocked` / `incomplete` (§ Verdict synthesis); an `incomplete` report's display header also carries its `cause:` and `unscanned:` lines (§ Display contract).
- `- score_pct:` — integer 0–100 from the locked deduction schedule (§ Tally and derived score), annotated with its band on the report's Verdict heading.
- `- tally:`
  - `- must-fix: <n>`
  - `- should-fix: <n>`
  - `- nit: <n>`
  - `- unverified: <n>`
- `- evidence:` — concise what-checks-proved summary.
- `- unverified:` — residual unverified claims, or `none`.
- `- elapsed:` — measured wall-clock minutes, worktree-setup → report saved by the main agent; mirrors the report frontmatter `elapsed` (§ Local report archive).
- `- next:` — one of `implementation` / `verify` / `docs`.
- `- notes:` — only out-of-scope state the user must act on.
- `- comments:` — GitHub Review posting status (see § Comment posting):
  - `posted: yes` | `n/a-no-pr` | `failed` — these three are distinct; a failed POST is **`failed`**, never `n/a-no-pr`
  - `review_url: <url>` when `posted: yes`; `n/a` when `n/a-no-pr` or `failed`
  - `inline: <N> posted / <M> attempted (<K> summary-only fallback)`
  - `threads: <resolved>/<matched> resolved` — thread lifecycle result (§ Comment posting — Thread lifecycle); `n/a` when there was no PR target or no eligible prior finding
  - `superseded: <n> review(s) folded` — fold result; `n/a` when there was no PR target or no earlier review from this flow

- `- report:` — local archive path (§ Local report archive), e.g. `{REVIEW_DIR}/2026-08-24-pr134/report.md`; `n/a` only when the harness dir is undiscoverable.

> **Engine check (when available):** run `mstar pr-review validate-report <file.md>` (or `import { validatePrReviewReport } from "@mstar-harness/engine"` in a host hook) to machine-check a saved local report against the Frontmatter + Output-shape contract above — verdict-from-tally consistency (skipped for `verdict: incomplete`, whose token comes from the run facts, not the tally; a drifted `score_pct` is still flagged), the locked-schedule `score_pct` recompute, the comments tri-state (a failed POST is `failed`, never `n/a-no-pr`), the required-field set (`type`, `verdict`, `score_pct`, `tally`, `comments`, `review_url`, `generated_at`, plus `incomplete_reason` and `unscanned` when `verdict: incomplete` — rejected on every other verdict) and `generated_at` format. Exit 1 with violations; run it before worktree cleanup. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

### Display contract (chat output)

Tone: matter-of-fact — no praise-padding, no flattery; state each severity together with the conditions that enable it.

First two lines of the **chat** display — verbatim, for a settled run:

```
{verdict} · {score_pct}% ({band})
must-fix=<n> should-fix=<n> nit=<n> unverified=<n>
```

A run that stopped short prints **four** lines instead — the same facts plus the `partial` mark and the two facts the token cannot carry:

```
incomplete · {score_pct}% ({band}, partial)
must-fix=<n> should-fix=<n> nit=<n> unverified=<n>
cause: {reason}
unscanned: {csv | none}
```

`partial` marks the grade as earned by the collected findings only; `cause` is why the run stopped and `unscanned` is the comma-joined scope it never reached (`none` when nothing was left unscanned). A settled run prints its two-line header byte-for-byte — no `partial`, no extra lines — and the `incomplete` header never appears under any other token.

Then ranked findings / leftover AC summary. Do not put `score_pct%` on the `- verdict:` token line.

The GitHub Review `body` no longer uses the two-line header — it follows § Report template, whose Verdict section carries the same facts structured (verdict token + Score with its band + four-class emoji tally table) and, for `incomplete`, the partial mark plus the `cause:` / `unscanned:` lines.

