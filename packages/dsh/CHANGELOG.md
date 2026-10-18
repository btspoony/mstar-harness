# Changelog

All notable changes to the `@mstar-harness/dsh` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

## [4.0.3] - 2026-10-18

### Harness

- **dsh engine-status row**: the model-facing `<mstar_engine_status>` block no longer repeats the **watermark trio** — it renders only the iteration phase gate and the workspace-state digest. `mstar version:` / `harness dir:` / `enforcement:` stay in the persisted payload (the panel meta dock renders version + harness dir; enforcement stays in the state section) and stay model-visible once in the always-on system prompt (`mstar:engine-status` digest + `mstar:harness-rules`), so the row is now a projection of the payload rather than a byte-identical render.
- Emission is **change-driven instead of per-turn**: the row is appended on the first emission for a session+workspace and then only when its rendered text or the panel-relevant payload projection changes, so an unchanged session no longer accumulates an identical copy on every turn's first step. The projection excludes the store revision, which the emission's own write advances.
- A workspace with **no resolved `{HARNESS_DIR}` composes no row** (after the watermark removal it would be an empty wrapper).
- **Watermark fallback:** a host composition without `dsh-system-prompt` registers neither prompt section, so the row re-renders the watermark trio (`mstar version:` / `harness dir:` / `enforcement:`) there — the version, harness dir and enforcement facts stay in the model's context in that composition too. The default composition (a system prompt is present) keeps the watermark in the prompt only.
- The no-active-lifecycle message no longer points at the retired `status.json` root: it names the cause and the real recovery commands (`mstar workflow register` for a plan, `mstar iteration register` for an iteration), and the row's `leases` line became `row scope` — each plan row's own recorded worktree + branch, a scope rather than an ownership claim.
- Documented the resulting panel semantics: the stored emission is the last payload the model saw, so its freshness footer `turn` / `at` mean *last emission*; after host-side context compaction the row is not periodically re-anchored until the next change (the system-prompt digest still carries the version, the active workflow and its plans).
- **`dsh-llm-fallbacks` pin bumped `0.6.6` → `0.6.7`**: the two hand-written literals move together — the `@mstar-harness/dsh` devDependency (`packages/dsh/package.json`) and the CLI install-spec constant (`packages/cli/package.json` → `mstar.dshLlmFallbacks`, read by `init` / `doctor --target dsh`) — and the lock re-resolves the row to `0.6.7` with the registry integrity for that version. `0.6.7` keeps the same peer set as `0.6.6` (the `^0.2.1-rc.2` dsh cohort, `@deepseek-ai/cordis` `^4.0.5`, `@deepseek-ai/schemastery` `^3.18.5`, `react` `^18.2.0`), so the workspace peer line already matches it; its only service-surface change is additive (a dispatch-role getter plus role-projection exports), none of it consumed by mstar — the structural mirror and its real → view type gate need no change. Nothing upgrades an already-installed host: `doctor --target dsh` reports an older row `drifted` until `init --target dsh` re-adds the pinned spec. Workspace verification: `tests/peer-deps.spec.ts` 7 pass, the `fallbacks-*` suites 53 pass (60 tests across the scoped 7-file set, zero skips), and both type gates (`typecheck:src` and `typecheck:tests`) exit clean.
- `@mstar-harness/dsh` now ships a package-root **plugin icon** (`icon.svg`: the Morning Star brand star, tile dropped, on dsh's 36px artwork canvas), so the dsh **Plugins page** renders the Morning Star mark on the package card and its component rows instead of the generic plugin glyph.
- Declared `icon` in the package manifest and added `icon.svg` to the published `files` list; the icon is faceted gold so one asset reads on both the light and dark plugin surfaces.
- `@mstar-harness/dsh` now ships `locale/en.json` + `locale/zh.json`, so the dsh **Plugins page** shows the plugin's localized title and description instead of the raw package name and the long npm description.
- Declared the `./locale/*.json` subpath export and added `locale` to the published `files` list (the same shape as `dsh-advisor` and `dsh-llm-fallbacks`).
- **dsh plugin**: the engine-status catalog row now emits the producer-owned `{ kind: 'mstar-engine', form: 'catalog' }` source instead of the retired `{ kind: 'plugin', plugin: 'mstar-engine' }` wrapper. dsh session-format V4 refuses that wrapper at message admission (`format v4 message requires a producer-owned source kind`), so every composed step failed to persist; the panel anchor reader now accepts the V3→V4-migrated legacy kinds (`plugin:mstar-engine` and `plugin:mstar-engine-status`), keeping existing sessions anchored.
- Added a regression test that runs the real composed row through dsh's V4 row admission, and proves that admission refuses the retired wrapper.

- Version alignment with harness **4.0.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.3**.

## [4.0.2] - 2026-10-18

### Changed

- **`dsh-llm-fallbacks` pin bumped `0.6.5` → `0.6.6`**: the two hand-written literals move together — the `@mstar-harness/dsh` devDependency (`packages/dsh/package.json`) and the CLI install-spec constant (`packages/cli/package.json` → `mstar.dshLlmFallbacks`, read by `init` / `doctor --target dsh`) — and the lock re-resolves the row to `0.6.6`. `0.6.6` requires a `^0.2.1-rc.2` host, so the pin completes only on that cohort line: the lock still carries the older transitive `@deepseek-ai/dsh-client-ui-plugin-manager@0.2.0-rc.2` copy (with nested `dsh-timeout` / `dsh-typert-protocol` / `dsh-brand` at `0.2.0-rc.2`), because `packages/dsh` declares no direct peer for that name. Nothing upgrades an already-installed host: `doctor --target dsh` reports the older row `drifted` until `init --target dsh` re-adds the pinned spec. Workspace verification covers the direct pinned row and the peer/type gates: `tests/peer-deps.spec.ts` 7 pass, the `fallbacks-*` suites 53 pass, and both `typecheck` gates (`typecheck:src` and `typecheck:tests`) exit clean.
- Upgraded the `@deepseek-ai/dsh-*` peer cohort to `^0.2.1-rc.1` (corridor `dsh-v0.2.0-rc.2` → `dsh-v0.2.1-rc.1`, rolling up alpha.1–alpha.5: custom plugin index, Agent-create-plugin entry, on-demand official bundles, experimental Mods/DevTools/COT-translation/worktrees, secret masking, Web DeepSeek login, `engines.dsh` compatibility preference, Slot `conversation.input.model.label`; dropped the peer on the removed `@deepseek-ai/dsh-invariants`, added `@deepseek-ai/dsh-agent-preset-registry`). Session format v4 unchanged.
- **dsh plugin — role identity now rides agent presets**: dsh 0.2.1 removed `SubagentStartRequest.persona` and the `start`/`startContinuable` pair (`startActivation` is the one start surface; `tool-subagent` rejects a `persona` config and points at a preset). A role-matched delegation therefore SELECTS a deployed agent preset (`SubagentStartRequest.agentPreset`) — `Config.rolePersonas` (role → persona text) is replaced by `Config.rolePresets` (role → preset id), and the deployment declares one complete preset per role (mounting `@deepseek-ai/dsh-persona` for its identity) since a preset owns the child's whole composition. Selection is capability-gated (independent-selection providers only) and skipped, with one debug log, when the composition mounts no `agentPresets` registry; configured ids are validated once per apply.
- The `@mstar-harness/dsh/invariant` companion stays a documented no-op: upstream removed the `invariants` service and the `./invariant` convention, so the entry is now a loadable no-op that requires no host service.
- Upgraded the `@deepseek-ai/dsh-*` peer cohort to `^0.2.1-rc.2` (corridor `dsh-v0.2.1-rc.1` → `dsh-v0.2.1-rc.2`: DeepSeek Search/Fetch web-search settings UI; Flash-1017 temporary model-label badge package; cohort pin). Session format v4 unchanged.
- Review output now lives in a dedicated **`{REVIEW_DIR}`** tree (default `{HARNESS_DIR}/reviews/`, `.mstarc` `review_dir` aware) with run-scoped directory names — `<date>-codebase-<level>-<round>`, `<date>-pr<N>`, `<date>-branch-<slug>`, `<date>-diff-<short-sha>`; `reviewRunDirName` / `resolveReviewRunDir` / `resolveReviewDir` are exported and `harness scaffold` creates `reviews/`.
- **The codebase audit writes a review report, not plans**: `scaffoldAuditReport` writes `<reviewsDir>/<date>-codebase-<level>-<round>/README.md` (same finding gates; the README drops the plan execution-order block). `mstar audit scaffold` gains `--level` / `--round` / `--reviews-dir` / `--dir`, and the `promote` verb of the `mstar audit` family — with `scaffoldAuditPlan`, the plan-Status-block validators and the plan-list helper — is **removed**. The audit seam now scans markdown under `{REVIEW_DIR}` with the credential scan as its only validator.
- **PR review reports and evidence move to `{REVIEW_DIR}/<date>-pr<N>/`**: `prReviewReportPath` takes `reviewsDir` instead of `reportsDir`, and `mstar pr-review report-path` takes an optional `--reviews-dir` defaulting to the resolved `{REVIEW_DIR}`; the dsh `mstar-pr-seats` `reportsDir` argument is that same review run directory.
- Updated the audit/review skills, the slash commands, `docs/commands.md` + `docs/runtime-reference.md` and the plan-lifecycle references: no plan files, no promotion producer, no plan-quality-bar citation on the review surface.
- `mstar path resolve` also reports `reviewDir`, and the conventions skill records that a directory key declared outside `{HARNESS_DIR}` (e.g. `review_dir=process/reviews`) is not covered by the canonical ignore snippet.

- Version alignment with harness **4.0.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.2**.

## [4.0.1] - 2026-10-16

### Changed

- Version alignment with harness **4.0.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.1**.

## [4.0.0] - 2026-10-15

### Harness

- The **omp gate hook now fails closed**: an unexpected error inside a gate returns an explicit deny envelope (gate name + error summary) instead of `undefined`, which the host read as allow; envelope-construction failures rethrow (#443).
- **dsh `workflow-policy` gains direct decision tests**: allowlist normalization/boundaries, mode behaviors, unknown-name handling, ask-cache hit/miss and key normalization, and uncovered-plan precedence, with mutation-bite proof (#444).
- The **codex agent installer caps retained backups** at the 3 newest per target (mtime-ordered, best-effort pruning that cannot fail an install) (#448, partial — engine receipts/ledger retention remains open).
- **Projection reads skip the rewrite when nothing changed**: an unchanged generation fingerprint with intact published rows performs no SQL write; changed inputs render byte-identical legacy output; deleted/corrupt published rows are rebuilt (#449).
- The **loopback dashboard now requires a per-launch random token**: the CLI prints the tokenized URL once, valid tokens set an HttpOnly SameSite=Strict cookie for in-page requests, missing/wrong tokens get a state-free 403; Host/Origin checks unchanged (#450).
- **Removed the dead `judgment review-advice` command** end to end (registration, family, CLI adapter/tests, docs, skill routing). It could never succeed — its only production call passed a null evaluator channel, which the runtime refuses before reading any input. The shadow evaluation path in `packages/judgment` is unchanged. The sandbox calibration worker (`scripts/evaluate.ts`) was migrated off the removed CLI spawn: it now imports the built judgment API bundle and submits via `connectEvaluatorChannel` in the same sandbox/supervisor flow (#440).
- **`hooks/session-context.mjs` is now a bundled artifact**: its source moved to `hooks/src/session-context.ts` and is built through the ZCode hooks builder (engine inlined), so the SessionStart hook runs standalone without `node_modules`; the fail-soft unavailable-authority diagnostic is preserved and covered by a bare-copy smoke test (#446).
- **Gate path resolution is single-sourced in the engine** (`host-gate-paths.ts`) and adopted by all five enforcement sites (opencode v1, opencode-v2, omp, dsh, ZCode write gate): symlink chains are followed to the real landing path with an 8-hop fail-close bound — v1/omp/dsh/ZCode upgrade from one-hop resolution, closing the alias-bypass class fixed in opencode-v2 during batch 1. Each host keeps its own refusal envelope (#442).
- Added the `/amazing-test-audit` entry (Codex/dsh project command installation included) and the `mstar-audit` test-suite deep method `references/test-audit.md` — value bar, authoring gate, junk-pattern sweep, retention bar, per-candidate evidence, discovery lanes, and whole-subsystem campaign (per-test R/F/C/D ledger); wired into SKILL.md variant dispatch, playbook § 4, and the full-audit scope variants.
- Added the four canonical audit command definitions with bounded scaffold/promotion writes and the existing secret and supply-chain scanners.
- Routed the audit CLI identities through the shared command definitions and added fixture-backed family coverage.
- **Test-authoring audit check:** codebase, test-suite and PR reviews now report incidental, source-shape, wiring or environment-constant assertions with the conclusion “delete, or replace with a product-behaviour assertion”. Aligned implementer and reviewer contracts include the four PR #280 counter-examples while preserving product-behaviour assertions and fails-first regression defences; rejected assertions are never renamed or re-pinned.
- **PR-review score is now a diminishing-deduction score with bands.** `computePrTally` deducts per finding within a class — must-fix 45 then 15 each additional; should-fix `max(12 − 3·(n−1), 2)` → 12,9,6,3,2,2…; nit 2 then 1 each (class cap 8); unverified 5 each (class cap 15) — floors `score_pct` at 0, and annotates the result with a **score band**: `mergeable` ≥ 90 · `good` 80–89 · `pass` 60–79 · `fail` < 60. Verdict derivation is unchanged (count-driven, 3 tokens) and score/band never override it. New engine exports `PrScoreBand` / `PR_SCORE_BANDS` / `scoreBand()`; `PrTallyResult` gains `band`.
- The chat display header is now `{verdict} · {score_pct}% ({band})`, and the posted report's Verdict heading reads `· Score <score_pct>% (<band>)` — the derived number is labeled **Score** (the per-finding `- **Confidence**:` evidence field is a different concept and stays unchanged).
- `mstar pr-review validate-report` recomputes `score_pct` from the same locked schedule (no second formula), and `mstar.review/v1` envelopes accept an optional `tally.band` — absent stays valid, present must be a valid band token. The envelope payload schema/help advertises those tokens, and `MstarReviewV1.tally` uses a band-optional envelope tally shape (`MstarReviewTally`) so legacy band-less envelopes still typecheck.
- Updated `mstar-audit/references/pr-review.md` (deduction schedule table, band definition, worked-example check table, display contract), `commands/amazing-pr-review.md` and `docs/commands.md`.
- Bulk dev-dependency refresh merging dependabot PRs #455–#460 into one change: GitHub Actions version bumps, @types/node 26, js-yaml 5, vitest 5, katex 0.19, shiki/@shikijs/langs 4.5, `@modelcontextprotocol/client` 2.3.1, simple-icons 16.34, `use-sync-external-store` 1.7, and the `dsh-llm-fallbacks` 0.6.5 pin synced into the engine constant.
- Type checking and declaration emit now run on TypeScript 7 (tsgo); the four AST-based lint scanners keep parsing with TypeScript 5 through the new `typescript5` alias until tsgo ships a `createSourceFile`-style parsing API.
- Renamed the Chinese brand copy to **晨星** across the docs, skill descriptions, host reference, marketplace `zh-CN` display names and the dsh panel locale value.
- Dropped the parenthetical Chinese gloss from the English plugin `longDescription` fields and the package READMEs — `Morning Star …` now reads directly, with no `(晨星)` substitute. The root README pair keeps the bilingual brand line (`Morning Star (晨星)`), so both languages change in the same set.
- **Runtime-facing READMEs.** README.md and README_CN.md are rewritten for people running the harness with their own coding tools: plain-language positioning and use cases, a condensed install/verify surface covering all seven hosts, the three entry shapes (single task, iteration, audit/review/verification), the delivery workflow as one Mermaid diagram per language, and a help-driven CLI section (`--help` lists a command's inputs, including issue payload fields with requiredness and type; a usage refusal names the problem, the help route, and the recovery).
- **Product identity restored.** Both READMEs carry the original subtitle (`Harness Workflow Engine · Agent Plugin`) and the full badge set — CI, license, version, last commit, dshfind, Greptile, and the four npm download badges.
- **Role overview retained.** Both READMEs keep the original role table followed by a short explanation of how the PM dispatches work; the Markdown customization wording is removed.
- **Workflow diagram.** The numbered workflow list is replaced by one Mermaid diagram per README: plan → implementation → independent review → acceptance with rework loops → iteration repetition → PR checks and review corrections → merge-ready → explicitly authorized merge → verified merge and post-merge close, with scope notes for the hotfix/inline and report-only routes.
- **Dashboard and MCP sections.** Both READMEs gain dedicated Dashboard and MCP sections — what the user sees or does, plus a minimal startup example — which replace the duplicate dashboard/MCP bullets in the command-line section.
- **Reference split.** Component, storage, CLI-contract, report, and enforcement detail moved off the homepage into the new docs/runtime-reference.md — detailed role/skill references and MCP host-integration material live there too, while the role overview and a short user-facing MCP introduction stay on the README — and INSTALL.md's report link now points at its Offline report draft anchor.
- **Install facts corrected.** omp installs only when its CLI is present; `init` defaults to `--scope project` with host-specific surfaces (dsh's profile is machine-global; Codex's global scope skips the command skills); the runtime reference documents all seven host MCP launch configurations, including the shipped dsh Cordis row loaded through the `@deepseek-ai/dsh-mcp-client` bridge plugin, and iteration wording follows the Phase 2–6 lifecycle.
- **Simpler README installation entry.** The English and Chinese installation sections now start directly with the host table. A **Node.js 24+** badge links to the full prerequisites in `INSTALL.md`; existing badges are retained, and MCP prerequisite links point to the same reference. Runtime requirements are unchanged.
- Recorded the repository's CLI-usage rule in `AGENTS.md`: run this checkout's own build (`bun run --cwd packages/cli build`, then `packages/cli/dist/mstar-harness.js`) rather than a globally installed `mstar`/`mstar-harness`. A global install is the released package for other projects — linking this checkout into it makes those projects run unreleased code, and invoking the global copy here runs a released CLI against unreleased engine behavior.
- Added two **prose-hygiene rules** to `mstar-compound`'s knowledge-document quality gate: durable bodies state the rule and the outcome, not the authoring date (timestamps belong to the frontmatter `date` / `last_updated` schema fields), and citations use repo-relative paths or `{HARNESS_DIR}`-style symbols rather than machine-local absolute paths.
- Reinforces the existing `CONCEPTS.md` rule (no status/date/owner fields) at the compound write path.
- **Guard 8** validates links and heading anchors across tracked Markdown, using the canonical `github-slugger` behavior to resolve heading fragments.
- Same-file fragments such as `#section-name` are checked against their source document.
- **`drift-lint` gate clean**: dashboard file-header comments rewritten to behaviour-only prose — tracked text carries no local plan/iteration ids (14 provenance citations cleared; the scan reports 0).
- Restored the product name in both README titles: the H1 pair reads `Morning Star` again instead of `Morning Star (晨星)`. The Chinese brand name stays in the Chinese page's lead line, and the two one-line edits keep the README pair size-mirrored.
- Ignored transient **Bun cache output** (`/Library/Caches/bun/`) at the repository root so session-environment cache dumps no longer dirty worktree `git status` or block clean-worktree gates.
- **`validate` gate repaired**: the engine builds and typechecks again — the duplicate root `Severity` re-export (core vs issue vocabularies) is resolved to the canonical core path, and the undefined-narrowing / matcher-overload errors in the engine tests and `initializeStore` are fixed with no runtime semantics change. `packages/cli` `typecheck:src` now regenerates the gitignored dashboard asset module first (`scripts/build-web.ts`; deterministic, round-trip-verified), so a fresh checkout typechecks without a full build.
- Removed the unused tracked root `specs/` directory: `{SPECS_DIR}` resolution picks `{HARNESS_DIR}/specs/` first, so the root copy was shadowed, shipped in no package, and referenced nowhere.
- Removed the `MSTAR_STORE_TEST_RUNNER` environment gate from the workflow-ledger test drain; tests now invoke the explicit drain without production behavior being selectable through the process environment.
- Rebound background job settlement to the pinned `@deepseek-ai/dsh-jobs` `JobRegistry.events.subscribe` lifecycle API. Terminal `settled` events carry the job projection used to pair background dispatches; the obsolete `onJobDone` call was removed.
- **Hashes are provenance, not gates.** Remove content-hash and canonical-serialized equality refusals across prepared documents, submitted evidence, workflow/catalog/roadmap operations, migration/coverage/activation, recovery and stored schema records. Ordinary document edits no longer require restoration, adoption, resealing or re-signing; recorded digests remain historical information.
- **Keep real constraints.** Same-operation-id/different-request replay conflicts, current semantic scope/owner/QA/state/path requirements, numeric revision and execution-token constraints, and actual Git delivery facts remain. Remove obsolete byte-version, manifest/coverage hash and restore-loss digest admission inputs without adding bypass or replacement-seal protocols.
- Align canonical CLI/workflow/evidence guidance and add four targeted routing scenarios with semantic negative controls; generated host assets continue to derive from canonical sources.
- Accept equivalent session-reference and execution-token key JSON without byte canonicalization. Preserve interrupted ledger tails instead of truncating or refusing them, and retire only reviewed index rows while preserving added rows and narrative content.
- Add a bounded architecture check for hash, raw-byte and canonical-equality refusals/assertions, with operation-id lookup evidence required for each replay exception.
- Remove persist --expect-version, Prepare recovery/amendment byte-version inputs and store execution restore --accept-loss-digest. Removed extra-primary launch admission is not replaced by another seal.
- Restore compares authorized loss row identities/revisions and operation IDs, inventories and installs one private backup image, and retains fresh pre-restore safety backups. Re-preview is needed only for newly endangered work or authority generations, never for a changed digest.
- Legacy migration derives current source data under its root lock, preserving workflow/plan membership and current coordinator ownership. Deleted launch reservations have no replay/repair successor.
- State `persist write` replacement semantics in help, update obsolete hash/CAS expectations in consumer tests, and escape non-ASCII code literals for bundled CLI execution.
- Validate recovery-point paths before staging the image so missing/unreadable points return typed refusals with public backup/preview recovery. Rebuild the committed ZCode hook bundle from the current engine.
- Keep the retained ledger descriptor open through commit so inode reuse cannot mask a replaced destination; clear stale migration `ended_at` fields while preserving authored notes. Keep actor-only mutation scenarios independently isolated instead of grouping thirteen CLI processes under one timeout.
- Execution authority lives in store.db: ordinary primary-coordinator prepare/progress/complete and workflow transitions use atomic SQLite transactions, CAS and receipts; per-row PM identity/transfer/execution-lease admission is removed.
- Registration atomically publishes catalog delta, ordinary workflow/row metadata, root membership and receipt. Catalog edits do not silently relocate registered plan pointers; no sealed Assignment is required.
- Added the authoritative execution read route: workflow/plan state is read from the store in one read transaction, and a missing, staged, corrupt or busy authority refuses (`execution.consumer-not-ready`) instead of degrading to leftover root/snapshot JSON, newest-workflow guessing or dashboard projections. While the authority is active the retired file writes are refused at every entry boundary.
- Replaced the staged execution migration preview/apply/activate/retire/abort protocol with the single static `mstar store upgrade --operator <name>` path: it opens or creates the store, imports recognizable stopped-workspace state and activates authority in one run, leaving skipped source bytes in place. Standalone backups freeze the file-native bodies a SQLite copy does not carry (ledgers, identity index, cursors, history chunks, selection body) together with their accepted-record identities.
- Completion is witnessed by a sealed Git proof instead of refs alone (checkout/git/common-dir identity, `HEAD` and its refs, the index, every tracked path's content and mode, the directory listings a new untracked path changes, merge/rebase sentinels, the object inventory). It is re-read from the filesystem with no child process and no await immediately before the completion transaction, so a worktree, index, untracked or object-store change inside that window refuses without a `Done`, a receipt or a released lease.
- Added the execution coverage substrate: a closed 18-surface inventory with a byte codec per surface, and a validator that recomputes coverage from the retained bytes — hashing every named witness and deriving each result hash from what the bytes say — so an invented result, a changed byte, a borrowed or unpinned witness, a foreign workflow identity or a mislabelled capability refuses as `execution.coverage-incomplete`.
- An injected `ArtifactStore` (`setArtifactStore` / `--store` / `MSTAR_STORE_MODULE`) is served behind a guard that refuses the root register, a workflow snapshot and their `json` aliases while the canonical control root's authority is active; the control root is resolved from the process, never from the injector's own claim.
- Updated `mstar-artifacts` `references/status-and-residuals.md`: the transport split (active DB authority vs pre-activation file route) is now stated where the v2 file shapes, lease fields and lockdir prose are introduced, instead of only in the later coordination section — remaining snapshot-as-SSOT references are scoped to the pre-activation transport or legacy history.
- Canonicalize active workflow registration's catalog plan path relative to the plans root, accepting canonical absolute plan paths without changing the execution resolver input.
- Coordinator recovery is an explicit attested bootstrap: it names the prior holder, adopts only the ownership that revocation orphaned, and never revives an old-epoch lease.
- Source readiness does not switch installed consumers, bump version surfaces or claim live activation or release. The committed ZCode hook bundle `hooks/mstar-write-gate.mjs` is rebuilt from the current engine; installed fencing and consumer refresh remain separate operational work.
- Kept standalone backup recovery (`store backup`, `store execution restore-preview`, `store execution restore`) and live-state export (`store execution export`) independent from upgrade.
- Added whole-store recovery (`previewExecutionRestore` / `restoreExecutionBackup` / `exportExecutionState`): the backup carries committed WAL-visible work, restore internally checks authorized loss row identities/revisions and operation IDs and retains a fresh safety backup, and the diagnostic export is inert and credential-free. No caller-supplied CLI loss-digest flag is required.
- CLI/session/host writes use independently acquired workflow coordinator identity with explicit plan addresses and checked or derived current transport context. No per-plan PM identity or child transfer survives.
- Kept the file forms only in explicitly labelled pre-activation sections that also state an active authority refuses them; no active instruction tells a reader to hand-edit a snapshot or to treat a legacy envelope as the live route.
- Made the session reference a lookup rather than a bearer credential: it names a stored row and grants nothing without the caller the engine compares inside its own transaction, and a reference, an expectation value or an operation id is never forwarded into a child assignment. Resume is not recovery — a stopped owner is replaced only by the explicit recovery verb on an active authority, or by the guarded Prepare recovery on the file route.
- Host specifics moved to their owning host references and were sourced from the reviewed implementations; the DSh README pair was realigned on the ledger identity/dedup authority, the durable cursor and the archived display tail.
- Added two vocabulary entries to `CONCEPTS.md`: **Consulted header set** (a label-keyed plan parser consults a closed, exactly-matched label set — never a prefix, so a descriptive sibling such as `Working branch policy` cannot alias a consulted field) and **Maintenance exclusion** (the single outermost lock an engine lifecycle operation holds so no cooperative writer in any package can append into its window; a coordination discipline, not an authority).
- Documented the shipped coordinator identity routes in the skill corpus: the host-owned `mstar_coordinator` entry (`bind`, `show-recovery`, `recover`), the local `plan bind --coordinator --session-id` form, the `mstar workflow recover-coordinator` verb, and the registered-plan pointer forms. The corpus separates pre-activation routes from active-store DB recovery (full execution token + stop attestation) and native one-shot model handoff (`mstar-host/references/omp.md`, `mstar-use-cli/references/plan-and-workflow.md`, `mstar-use-cli/references/preconditions.md`).
- Registered plan pointers are documented as the **canonical absolute** `{PLAN_DIR}/<plan-id>.md` — a canonical absolute or normalized harness-relative input is accepted, the repository-relative `.mstar/plans/<id>.md` spelling is refused before the first journal/snapshot/root write — and the guarded `correctPlanFiles` correction is the same-row repair, changing only `row.file` plus `updated_at` under the existing Prepare admission and current semantic/revision constraints, not obsolete byte-version inputs (`mstar-artifacts/references/status-and-residuals.md`, `mstar-iteration/references/phase-1-prepare.md`).
- Workflow coordinator identity is explicitly acquired; public recovery output contains safe facts, never envelope paths/body. No Assignment or row identity is a binding input.
- Documentation alignment itself changes no source behaviour, flag or refusal code and claims no installed generation, released verb availability or operational handoff.
- Removed `status.json` from the engine `compoundRefreshScope` allow-list (its ACTIVE file-route guard refuses that path); regression coverage asserts the narrowed scope and the ACTIVE refusal through the real write port.
- Appended the `Amendment 2026-10-06 — ACTIVE store execution authority` to the frozen plan-workflow lifecycle contract: store registration/close seams primary, file routes as pre-activation/engine-absent fallback.
- Closed the knowledge_refs carrier decision on catalog relations (`mstar catalog link`); snapshot `plans[].metadata.knowledge_refs` labeled legacy read-only across artifacts/compound/compound-refresh.
- Added execution-authority state and the supported upgrade entry to `status validate`; clarified route-scoped tokens and plan-file addressing.
- `mstar store upgrade --operator <name>` is the sole default execution-state upgrade: it opens or creates the store, imports recognizable records in one run, activates authority, and returns one result with skipped items. Unknown and unresolved sources remain at their original paths; no attestation, inventory, staged manifest, coverage gate, activation barrier, or command-owned recovery point is required.
- Removed `store safe-upgrade` and the staged execution `preview`, `apply`, `activate`, `retire`, and `abort` verbs. Standalone `store backup` remains; execution `restore-preview`, `restore`, and `export` remain as independent backup/disaster-recovery and live-state reporting utilities.
- **Canonical store administration:** CLI and MCP store operations now accept the project's canonical control root through explicit `--harness` selection or normal project discovery. Backup verification, maintenance locks and migration/activation attestation guards remain in force; command help documents the supported target.
- Store-upgrade migration retirement now requires current snapshot or root execution evidence; stale journal history alone no longer qualifies.
- Added `workflow adopt-terminal` to record an adoption receipt for an unregistered workflow header, with a revision CAS and truthful status reporting.
- Restrict the `mstar persist` family to `review` and `json`; engine `status` and `snapshot` kinds remain internal to the migration path, whose permanent consumer is `migrate.ts`.
- Retire the coordinated artifact read/replace chain and its public exports. The coordinated purge-entry veto remains deferred to the T21 terminal sweep.
- Registration replay no longer answers over a **terminal lifecycle snapshot**: during the close window (terminal snapshot on disk, root entry still present) a committed registration refuses with `catalog.registration-terminal-lifecycle`; committed reconcile replays apply the same guard. Let an in-flight close finish; if it was interrupted, run `mstar status workflow-close --workflow <workflow-id> --harness '<harness-root>'` to finish unregistering, then retry the registration. Ordinary plan-row progress replays still replay the committed receipt (#323).
- **Dashboard views:** Workflow and iteration views now read from the execution authority on ACTIVE harnesses instead of refusing the request. Fixes #354.
- **ACTIVE projection:** Removed an unreachable synthetic plan validator and redundant lease queries; completed plans with retained released leases remain visible without historical ownership.
- Added the file-native workflow notes ledger (`appendWorkflowNote`): one canonical line per note, appended under the execution-maintenance exclusion and the per-workflow status lock, with the synchronous current-session assertion as the last step before the fsynced byte write. Migrated legacy lines and the inline plan notes stay byte-for-byte preserved — nothing rewrites, reorders or compacts a retained ledger, and no note becomes a DB event.
- A note's identity is the caller's stable id: the same id with the same body replays without appending, the same id with a changed body refuses, and an id already recorded elsewhere refuses instead of picking a winner. A crash-cut partial line of the record being written is reconciled into exactly one accepted line; an unaccepted prefix that follows the record's own accepted line is healed by removing that prefix only; an unterminated tail that is not that record's partial refuses with every retained byte left in place.
- The retained leaf's trust decision is its open: `O_NOFOLLOW` plus a re-verification of that same descriptor's device/inode **and its bytes**, so a leaf swapped for a symlink, replaced or removed between the read and the commit refuses instead of being followed, truncated or written through.
- Durable writes complete a short write (a capacity-limited descriptor can accept fewer bytes than it was given) and refuse a write that accepts nothing, in both the ledger append and the atomic-replace helper.
- The DSh agent-flow ledger now derives every new row's identity from verified native facts — the log's verified incarnation plus the carrying session and call id — makes the accepted-identity index the dedup authority and the cursor sidecar a per-incarnation scan bound, and keeps the append, the identity commit and the scan-bound advance inside one shared-lock critical section. Display compaction is a single transaction recorded in a transient journal (before/after tail hashes plus the exact archive range), and evicted lines are archived byte-exact into sealed history chunks before the display tail is rewritten.
- Both agent-flow write paths take the same execution-maintenance exclusion as the engine's activation, restore and migration before their own lock, so a plugin write inside that window is refused with a bounded advisory instead of landing in a directory that is being rewritten.
- Exported the lifecycle-branch fact type from the engine package entry point for the commands consumer.
- Removed the retired file-route Prepare recovery suite and `lease.verify-integration` setup-verb test cases; surviving L1 lease coverage remains in `worktree check`.
- ACTIVE iteration registration now canonicalizes compass references to harness-relative paths and refuses paths that escape the harness, including through symlinks.
- Replaced retired recovery instructions with ACTIVE status/token reads, coordinator recovery, and an actionable failed-close/re-register route for a missing delivery kind.
- `mstar worktree check --entry` admission is now workflow-type specific: a standalone plan workflow requires only the source/target anchors its registration records (and uses `target` for main-worktree residency), while iteration workflows keep the required base/target/integration anchors plus the integration-checkout validation. Missing-anchor refusals now give per-type, achievable recovery instructions.
- Audit-promote CLI fixtures assert the ACTIVE execution graph (single store initialization, activated token) instead of the retired snapshot/`status.json` projections.
- Made the status-write gate execution-authority-only and regenerated its bundled hook.
- Removed retired lease verify-integration assertions from the MCP identity test and retained the active worktree check surface.
- Inject acquired session identity into `milestone.assign` while preserving the optional checked session reference.
- Removed the retired empty status template fixture and its validation case.
- **OMP**: `mstar_coordinator` gained the active `bind` / `recover` forms that call the DB verbs directly under the host-derived execution identity, with `show-recovery` answering from the DB on an active root and keeping the unchanged Prepare view on the file route. The route is read from the addressed control root, never selected by a tool argument: a mixed or partial key set, an active form on a pre-activation root and a Prepare form on an active root all refuse before any IO.
- **OMP**: `mstar_phase2 {operation:"bind"}` takes no caller-supplied session path and adopts what the addressed root's own authority holds (the DB coordinator binding on the active route, the workflow's own recorded envelope on the file route). The durable record is version 2; earlier records stay readable as legacy history and are never upgraded into a DB binding, and an active binding always supersedes one.
- **OMP**: added a read-only hidden-history reader/exporter that classifies one session ledger by its exact hidden entry types, preserves every payload verbatim with its digest, and decodes only what a verified producer schema admits. An entry whose producer is unknown or whose payload cannot be admitted is retained in full and diagnosed rather than guessed into a session or another type, and the exporter refuses instead of exporting with evidence missing.
- **DSh**: session selection and exclusion floors persist separately from rebuildable engine-status emissions; only canonical execution-binding witnesses are stored, and a stale, revoked, missing, corrupt or scope-mismatched authority is refused without falling back to the root register or the newest workflow. The legacy target route survives only when no active authority exists.
- **DSh**: added the plugin-owned `/mstar-execution` human command (closed JSON `adopt | clear | run`) — identity comes from the carrying native session, known leaf/subagent seats are refused before any parse or harness probe, and `run` launches a shell-free child whose execution-identity transport is overwritten while every spoof and legacy key is removed.
- **OpenCode**: the execution identity is derived from the native hook session id plus an independently acquired scope, the session's own reference is learned from its CLI traffic and carried into a real shared-CLI invocation, and both legacy keys are removed while the root comes only from an explicit flag or the child's working directory.
- Inject the omp session's native identity into eligible Morning Star MCP calls and diagnose a missing ACTIVE-workflow identity injection path.
- **omp now supplies the Morning Star MCP `sessionId` per call (issue #383a).** The new `mcp-identity` extension (registered in `omp.extensions`) revises eligible `mcp__morning_star_mstar_*` `tool_call` inputs to `{ ...input, sessionId: <native id> }`, so a standalone plan workflow chain — `workflow register -> coordinator bind -> plan prepare -> progress` — carries the calling session's identity without the agent passing ids by hand. Eligibility is schema-aware: a tool qualifies only when its declared `ToolInfo.parameters` schema declares `sessionId` (the host revalidates revised inputs, so an undeclared key would be rejected host-side); the name prefix is a prefilter only. Injection is additive-only: an explicit caller id is never overridden, `block` is never set, and the id is read per event from `ctx.sessionManager.getSessionId()`, so leaf sessions carry their own id.
- Restored host session identity injection for shell commands with an idempotency guard, keeping repeated revisions from stacking `MSTAR_HOST_SESSION_ID` exports without touching the `env` input.
- Changed the coordinator-visible OMP notice **bar titles** to the shared types: the phase-2 diagnostic notice and the model-handoff notice now send `customType` `mstar:notice`, and the bounded phase-2 advisory sends `mstar:advisory` (previously `mstar:phase2-notice` / `mstar:model-handoff-notice` / `mstar:phase2-advisory`). The bar header prints the sent type, so the visible title now matches the shared Morning Star notice family.
- Unchanged: the hidden durable ledger identities `mstar:phase2` / `mstar:model-handoff`, their restore and dedup identity, the observed body workflow id/status/fallback, the delivery/continuation options and every machine refusal code (`phase2.workflow-terminal` included). A visible title rename is not a ledger or refusal-code change.
- Source-level change to the emitted values plus the matching host-reference paragraph; the emitted body states its own workflow status once. No installed UI, renderer registration, bundled host copy or publication is claimed by this entry.
- Removed the dead omp validator tool sources (`src/tools/`: `mstar_iteration_gate`, `mstar_worktree_check`, `mstar_status_validate`, `mstar_lease_verify`, `mstar_path_resolve`, `mstar_dispatch_validate`). The build stopped compiling and shipping them when the MCP stdio server moved into the CLI; the same capabilities are served by `npx @mstar-harness/cli mcp` through the packaged `mcp.json` (`iteration.gate`, `worktree.check`, `status.validate`, `lease.verify`, `path.resolve`, `dispatch.validate`). One scope note: the CLI `path.resolve` command resolves the four top-level directory symbols (`{HARNESS_DIR}` / `{SPECS_DIR}` / `{WORKFLOW_DIR}` / `{PROJECT_DIR}`); the per-plan `{PLAN_DIR}` / `{SDD_DIR}` and the `{ITERATION_DIR}` / `{KNOWLEDGE_DIR}` symbols follow the documented resolution conventions from `{HARNESS_DIR}` (engine `resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir`; SSOT `mstar-conventions`). Deleted the omp-side test arms that pinned them (`execution-read` validator suite, `worktree-check`, the `store-cutover` tool route, the bundle-smoke custom-tool probe) and the cross-package arms in `packages/cli/test/tools-v2-smoke.test.ts`; the omp `tool_call` pre-hook coverage is unchanged.
- Widened the optional host peer to `@oh-my-pi/pi-coding-agent@^18.3.0` (any 18.x host) and moved the development baseline in `devDependencies` to `18.3.0`, so the suite validates against the host users actually run. The exact `18.2.1` pin had already drifted from reality: hosts in the omp 18.3.0 line refuse any `bash` tool call whose input carries `env` without a service `name` (`ready and env require a service name.`), a parameter-surface contract this package's shell-transport code must respect.
- Upgraded the `@deepseek-ai/dsh-*` peer cohort to `^0.2.0-rc.2` (corridor `dsh-v0.2.0-rc.1` → `dsh-v0.2.0-rc.2`: desktop menu-bar bundled dsh install, experimental async Q&A, model-picker fuzzy search, UX/desktop fixes, pi-ai → 0.87.1; deferred until npm published 0.2.0-rc.2). Session format v4 unchanged.
- Renamed the `@deepseek-ai/dsh-*` peers `dsh-agent-presets` → `dsh-agent-preset` and `dsh-code-runtime` → `dsh-ptc-runtime`.
- Migrated the planMode bridge from `agent/session-start` to serial `agent/created`.
- Bumped the `dsh-llm-fallbacks` devDependency `0.5.2` → `0.6.4` (first fallbacks generation matching the `0.2.0-rc.1` peer cohort); the engine `DSH_LLM_FALLBACKS_VERSION` pin moves with it.
Route the live workflow picker through ACTIVE execution state, fail closed when dispatch-ledger targets are omitted, preserve alternate branch-form lease matching, and reuse one ACTIVE workflow-source read across dispatch gates and recording.
- Corrected package release surfaces, hosted-install dependency specs, CLI option decoding, installed-host MCP doctor paths, request-scoped store selection, child stdin policy, and dashboard lifecycle cleanup; aligned CI consumers with the canonical command definitions.
- Integrated the stdio MCP server into `@mstar-harness/cli` as `mstar mcp`; host configs now launch `npx @mstar-harness/cli mcp`. The standalone MCP package, per-host bundles, and native bridges are removed.
- **MCP health checks host configs, not per-host bundles.** `mstar doctor` MCP inspection now validates each host's real MCP configuration file and its `npx @mstar-harness/cli mcp` launch entry (server entry resolved from `command`/`args` arrays), replacing the retired `build-info.json`/`stdio.js` bundle probes, and refuses runtimes below each packaged target's native floor. `evidence.verify` reports a failed assessment as `ok` data with an `assessmentPassed` flag instead of a `refused` envelope.
- **DSH gains its Cordis MCP client row.** The shipped dsh bundle patch inserts an `mstar-mcp` row (`@deepseek-ai/dsh-mcp-client`, stdio `npx @mstar-harness/cli mcp`, server name `mstar`) next to the plugin row; `mstar-harness doctor --target dsh` parses the profile's Cordis sources structurally (comment-proof) and reports aligned only with the bridge plugin installed. `spawnProcess` normalizes ENOENT to a deterministic `executable not found in $PATH` error, and relative dev-command args resolve against `MSTAR_CLI_PROJECT_ROOT`.
- Documented CLI-based MCP launch paths for the six JSON-backed hosts and OpenCode's plugin-injected config, plus the DSH Cordis YAML follow-up; recorded runtime prerequisites, doctor status meanings, host/session boundaries, and separate installed-host verification.
- Recorded the OpenCode V1 `@opencode-ai/plugin` 1.4.8 pin and removal of the global CLI fallback.
- Added the `consumer-v1` source/package inventory producer (`scripts/execution-consumer-manifest.ts`): per consumer (engine, CLI, DSh, OMP, OpenCode, ZCode) it records the canonical build-input closure, the generated output closure, the entrypoint, the exact runtime target and floor, the declared capability and the copied-instruction trees each package bundles from the repo-root `skills/`, `commands/`, `agents/` and `assets/` corpus — reusing the existing build layouts instead of introducing a second build system. `--write` emits the manifests; `--check` re-verifies every written manifest against the bytes on disk without writing anything.
- The producer also publishes one per-consumer evidence document derived from the aggregate, so the handoff form cannot disagree with the operator-facing artifact.
- Assembled-package Node regression drives the built CLI's coordinator registration, binding, ordinary source/configuration/progress and exact retry; it compares public/store facts, current consumer manifests and committed ZCode hook stdin/exit behavior. It never launches a per-row PM.
- The regression states explicitly what it is not: no native host process, no installed binary and no TypeScript source import. Host entrypoints are covered by generated-manifest parity plus a populated OMP-shaped database fixture executed against the built engine generation.
- A `.gitignore` that already states any harness-root rule (`.mstar` or `.agents`, including a leading slash, a negation or a partial rule) is **author-owned**: scaffold, the install fence and `doctor` make no change at all — no append, reorder, dedupe or normalization, and the file bytes stay exactly as written. Unrelated paths and a lone `.mstarc` entry do not declare, and the custom-layout skip is unchanged.
- Added the exported `hasHarnessRootDeclaration(content)` predicate to the engine path module: a mechanical, read-only line scan that recognizes either layout's root rule, including a leading slash, a negation and a partial declaration, and introduces no glob, escaping or precedence semantics.
- `validateGitignore` now returns `gitignore.author-declared` for a declared file before any missing-entry computation and proposes no rewrite. A missing file stays `gitignore.missing`, and an undeclared file still reports the canonical entries it lacks. The canonical-completeness success branch was retired as unreachable, because canonical content is itself a declaration.
- **Removed application file/directory mutexes** without a replacement mutex protocol. Native SQLite transactions/CAS, authorization and genuine workflow integration ownership remain; ordinary notes and documents are not authority.
- **Workflow notes are a plain append log**: repeated IDs/submissions append again, one LF-framed `O_APPEND` write preserves peer bytes on failure, tolerant readers continue past partial records, and receipts return the note ID without an accepted-operation replay promise. An admitted append may finish after later session revocation; its record is not current execution authority. Native device/inode observations reject a detected replacement during append; they are not a mutex and do not prevent subsequent external rotation.
- **Production note, catalog-purge and execution-restore operations ignore removed test-control environment values**: a working-directory `.env` cannot execute test scripts, truncate unrelated files, park production work or select recovery fault injection. Failure and interleaving instrumentation lives only in the test suite.
- **Dsh host state uses the existing control-root database** for events, accepted source identities, scan bounds, bindings and newest status emissions, without JSONL tail/index/cursor/cache authority or file compaction. Dispatch, settle and workflow-verdict evidence follows the selected logical workflow ID, never a destination directory basename. Native session logging continues before ACTIVE authority; unavailable persistence reports supported init/upgrade recovery. Engine-status reads preserve native refusal causes and distinguish a true addressed no-row answer from absent, staged, corrupt and schema-refused authority. Legacy binding imports reject a session already bound at another cwd while preserving same-pair replay and the existing explicit skip recovery.
- **Legacy Dsh import preserves tail-only replay identities** and reads source leaves through no-follow file descriptors; identical native replay preserves the original event, conflicting identity bytes refuse, and a replaced symlink leaf is not followed.
- **Legacy execution recovery imports directly** through `store upgrade`, retaining original v1/v2 source bytes; standalone `mstar migrate` staging and internal status/snapshot writers are retired, and engine `ArtifactKind` is `review | json` only. Active standalone v1 lifts require one addressed `--delivery` JSON object per original workflow ID, supporting different delivery intents in one same-source retry before execution registration; kind is never inferred, and inapplicable declarations refuse. Store initialization may already have committed when declarations refuse. Existing Dsh skip acknowledgements recover an unregistered symlinked Dsh source, including the whole `workflows/` root with `--ack-skip-dsh dsh-workflows`, without following it or changing link/target bytes; registered execution sources retain containment/no-follow checks and cannot be discarded by a Dsh acknowledgement. Database backup captures a consistent native image; restore replaces all authority domains transactionally on the same live database with a new epoch, without freezing or rolling back ordinary files. A committed restore remains successful if its optional filesystem receipt copy fails, returning `recoveryReceiptPath: null`; pre-commit cleanup reclaims only the attempt's own safety image when the native store generation proves it did not commit, and preserves images on changed or unreadable authority. Fresh-store failures distinguish unpublished filesystem failure from an already-published store whose handle could not open, with phase-specific public recovery.
- **Unsafe registered sources and native-ID collisions have explicit import recovery**: optional `--ack-skip-workflow <id...>` skips only named refused execution imports, independently of Dsh disposal, while preserving source/link/target bytes and existing native rows. Unknown/noncolliding acknowledgements report a usage error before registered unsafe-source refusals. Receipts disclose lost imports; default no-follow and ordinary physical containment remain, with no fabricated resumption.
- **Nested execution-source refusals use the same workflow acknowledgement**, including symlink/non-regular snapshots. Legacy status, snapshots and session bytes use no-follow, identity-checked descriptors; session validation consumes those bytes without reopening the path. The checkpointed-authority regression no longer waits for garbage collection or asserts SQLite cleanup timing.
- **Legacy source leaves are opened non-blocking**, so a FIFO or other special file at a registered leaf refuses by type and names its recovery instead of hanging the command; a decidable sibling source in the same run still imports. The same bounded, type-checked, no-follow read covers the v1 `iterations/<id>/delivery-compass.md` leaf, which a special file at that path would otherwise have blocked.
- **The v1 conversion consumes the already-verified register bytes** rather than re-acquiring `status.json` by path, so classification and the converted rows come from one descriptor-verified read on the supported v1 route.
- **A store-upgrade receipt is bound to the imported source**: the source digest participates in the request identity, so reusing one `operationId` over changed legacy bytes conflicts instead of answering with a receipt that describes bytes the run never imported. Unchanged input still replays its retained receipt.
- **The upgrade retry survives a publication race**: an upgrade that loses `initializeStore`'s create-only publication race is pointed back at `store upgrade` (its legacy import may be unfinished) instead of at the "do not initialize or migrate an existing store" instruction meant for `store init`.
- **A history chunk that vanishes after enumeration refuses**: the DSH import no longer reads that `ENOENT` as "this workflow kept no retained history", so the identities in a vanished chunk cannot be skipped silently; a genuinely missing history directory keeps its previous treatment.
- **A v1 compass that changes under the probe is refused**: once the type probe has observed a compass, a leaf that vanishes or becomes a link before its read refuses by name instead of being treated as absent (which would silently regroup that iteration's plans); the non-regular-compass refusal names both supported repairs — replace it with a regular file, or remove it to convert those plans as standalone rows.
- **A malformed v1 plan row is skippable**: a converted v1 lifecycle whose rows cannot be imported refuses as that lifecycle's own source and is addressable by `--ack-skip-workflow <original id>`, exactly like a malformed v2 snapshot, so one agent-authored row no longer blocks every valid workflow.
- **Root `status.json` `residual_findings` are reported rather than dropped**: the v1 conversion states the exact count and the supported route (a project register document at `projects/<id>/residuals.json`, or the issue verbs), leaving the legacy field untouched.
- **The upgrade recovery and help name the complete skip vocabulary**: the machine-facing DSH recovery also names `--ack-skip-workflow` for ids this run already committed, and the command description lists every source class the acknowledgement accepts.
- **A refused legacy source is always skippable by its id**: a registered snapshot whose plan rows are missing, duplicated or unconvertible now refuses as that workflow's own source (the default refusal names `--ack-skip-workflow`), so one malformed row no longer aborts the upgrade or blocks every healthy sibling import.
- **The acknowledged-skip disposition names the refused source, not a presumed cause**: a nested-source skip no longer asserts that its (real, in-root) containing directory is unsafe; the per-item reason carries the exact cause.
- **Both source digests are ordered by code unit, never by the process locale**: the same legacy bytes keep one identity across machines, locales and ICU versions, so a same-input retry is never falsely refused as `execution.operation-conflict`.
- **The v1 compass refusal names three supported exits**, and a link raced into the open window refuses exactly like a static one: replace the compass with a regular file (keeping the iteration grouping), remove it (converting those plans as standalone rows), or explicitly start without importing any legacy source (`store init --harness <new-empty-control-root>`, existing data untouched). The descriptor is also identity-checked against the probe, so a swapped-in regular file cannot contribute its bytes.
- **A `workflows/` entry that sources nothing is treated as absent**, not as a conflict: a regular file (or other non-directory) with no registration under it no longer aborts the upgrade, while a registration under it keeps the existing per-source refusal.
- **The upgrade receipt binds the bytes it consumed**: each source hash is taken from the single descriptor read that produced the rows (and the v1 compass reads record theirs), so the digest no longer re-acquires the same paths; a DSH refusal that follows a committed execution import names both acknowledgements its advertised retry needs.
- **Catalog purge-registration settles the native execution journal only**, without reading, hashing or rewriting the recorded snapshot: the failed producer's source bytes are retained exactly, and an edited document no longer blocks journal cleanup. The recorded digest remains historical failure evidence on the receipt, never a re-certification of the live file; identity, generation, catalog-revision, ACTIVE and recorded-receipt replay guards remain.
- **New store publication synchronizes its parent directory** before removing the fallback image. A failed barrier reports the published partial outcome, retains readable data and the fallback, and supports recovery through the same public upgrade entry.
- Retired `mstar migrate` now recognizes its former delivery and branch flags before returning the explicit no-writer refusal. Legacy-status and Dsh workflow-selection diagnostics direct operators to `mstar store upgrade --operator <name> --harness <control-root>`.
- **Milestone mechanism** in the project store: `mstar milestone add|update|assign` write milestone metadata and the sole issue association under store-revision CAS; read-only `list`/`status` expose open/resolved/other-retired rollups. Delivery is an explicit status change that requires at least one linked issue and zero open ones.
- **Composed roadmap surfaces**: `mstar roadmap export` (JSON v2 / grouped Markdown) and the roadmap dashboard render milestones — target, status, linked issues and counts — alongside the retained Direction; they work without Markdown content and never modify milestone records.
- **Governance wording** now references milestones: the Durable Roadmap Gate accepts a milestone ID plus linked-issue acceptance/owner/dependency/trigger evidence, and retired `roadmap.md` stubs remain history/import transport only.
- **Project roadmap authority** now lives in the project store record, not a live `roadmap.md`: CLI, dashboard and dsh read the same content; a known project with no roadmap is reported explicitly.
- **Roadmap authoring** uses read-only import preview and reviewed apply, revision-guarded replacement, and Markdown/JSON transport export. Harness scaffold registers `_default` without writing roadmap Markdown; legacy files remain import candidates or history.
- **Iteration close** reads the stored roadmap, exports an independent candidate and replaces it against observed revisions instead of editing a live project roadmap file. Runtime guidance now points to one governance rule home.
- Fixed roadmap CLI discovery, import-preview round-tripping, dashboard absence handling, and legacy roadmap migration disclosure without creating a second authority.
- Refused worktree cleanup when ignored files would be lost; refreshed the committed hook bundle and migration/scaffold expectations.
- Corrected roadmap dashboard and project-rollup absence messages, and updated migration-6 test expectations.
- Read dsh project roadmap milestones from the store authority and disclose absent, partial, and unavailable roadmap coverage in the panel.
- Restored catalog facts in roadmap views, clarified the empty project rollup message, and retained migration steps in successful JSON output.
- Added the read-only local dashboard: `mstar dashboard` serves the issue list/detail with recorded history, the workflow / iteration / roadmap views and one cumulative captured-vs-retired issue-flow chart on `127.0.0.1` (loopback only, no bind option), from the issue store and the lazy execution/roadmap projections. The dashboard never mutates; unknown historical dates are disclosed and counted separately, pre-store buckets are labelled register history, and the issue-flow chart is paired with an accessible data table.
- **Dashboard roadmap is now a milestone board**: the roadmap page lays each project's milestones out as columns (one column per milestone, in store ordinal order) with that milestone's assigned issues as the items inside it — mono id, disposition badge and stored title — instead of the previous vertical card list. The project's unassigned issues appear as an explicit, named trailing column; the count is named on the no-milestones branch too, so it is never silently dropped.
- **Direction demoted below the board**: the content authority's Direction and the stored historical document now render as collapsed sections under the board, each keeping its own heading and its existing "content authority ≠ milestone data" wording. Catalog facts and the store/projection freshness block are unchanged, and a refused roadmap read still renders its notice — never an empty board, never the empty-milestones state.
- **Dashboard roadmap entry is projects-first**: opening `#roadmap` without a `?project=` now lists every catalog project (title, id, lifecycle, open-issue count) and each entry links into that project's read-only roadmap, replacing the "add the project to the URL" dead end.
- **New `projects` dashboard read view** end to end: engine `DashboardView` + `ProjectListDTO`/`ProjectListItem` (complete, deliberately unpaged read over the catalog table with an open-issue count), the param-free `/api/projects` transport route, and the regenerated offline dashboard bundle.
- **Gate path resolution is single-sourced in the engine**: `@mstar-harness/engine` now owns the landing-path resolver (`landedPathOf`, the chained form) and the case-folded authority naming/classification, and the OpenCode v1, OpenCode v2, omp, dsh and ZCode write gates import it instead of keeping hand copies. The copies had drifted — four of them followed a single symlink hop while v2 followed the chain — so a two-link alias chain to a harness authority file (`store.db` / `-wal` / `-shm`) bypassed the gate. Every gate now resolves the chain (8-hop bound, cycle/overflow refuses fail-closed with `write.symlink-resolution-refused`) and classifies case-variant authority names identically; each host keeps its own refusal envelope (#442).
- **BREAKING — remove the entire plan-PM product route.** One workflow primary coordinator now drives every row through ordinary `prepare`, `progress`, `issue-add`, `issue-close` and direct `complete`. Per-plan sessions/roles/claims/binding, sealed Assignment admission and handoff/accept/return/integration-start/integration-accept/reconcile/repair/release protocols are removed, without aliases or a relocated transfer sequence. Coordinator bootstrap/resume and explicit stopped workflow-coordinator recovery remain.
- **No-argument iteration drive only.** `/iteration-drive` rejects all nonempty input before boot; old scoped flags never silently become whole-iteration authorization. OMP removes extra-primary preferences, capacity/terminal transports and launch journals; native leaf dispatch and the bounded bind/checkpoint/read-only-history scheduling observer remain. Model-handoff behavior is unchanged.
- **Ordinary revisable configuration.** Source branch/worktree metadata and QA/cleanup are configured through prepare, including while active. Defaults are mandatory QA and allow-residual cleanup. Valid metadata/defaults require no ceremonial prepare record or immutable plan/Assignment bytes. Transactions, CAS, exact-request receipts, explicit authorization, L1/L2 checkout isolation, SDD, QC tri and QA remain.
- **Three distinct completion obligations remain.** Iteration completion verifies the actual already-performed serial two-parent merge in the clean recorded integration checkout and leaves parent compound/PR/verified-merge/close intact, with no child PR. Standalone development verifies its registered source without iteration integration and retains its own delivery tail. Standalone report-only consumes explicit matching policy fulfilment recorded before Done and retains evidence-backed close, without fabricated Git/integration/compound-before-PR/PR. Complete releases only applicable integration exclusion, retains ownership and preserves timestamps on exact replay; it never performs or repeats Git merge.
- **Explicit authority and historical cutover.** An already-selected store root is never rediscovered: missing or empty `--harness` targets refuse without opening another ACTIVE store and remain recoverable through public store upgrade. Schema-8 retirement requires full operator-stop attestation and preserves business provenance; imported completed ownership uses current metadata/completion, never a retained plan-PM handoff reader.
- **Authority, phase and retained-track corrections.** ACTIVE authority veto precedes malformed plan-read payload validation; recorded numeric progress contributes to iteration phase derivation. FILE worktree checks retain the selected row's track ownership and expose ordinary observed-revision progress recovery with the explicit control root, without clearing live tracks or weakening checkout/identity guards.
- **Policy/host parity.** Canonical skills, command text, templates, routing pressure data, bounded-resolution dispositions and README pairs use the same direct route across hosts. DSh keeps real writable scope checks against row metadata and their existing public refusal codes, not a per-row holder. Superseded unreleased seal/admission/stopped-plan-owner fragments are retired, while unrelated issue/transport/model-handoff behavior is preserved.
- **Reviewer least privilege.** Remove the deleted plan-lease verifier's exact/wildcard Bash permissions from QC tri and code-reviewer thin shells. Do not replace them with integration/business mutation or build/test grants; role prompts remain thin and existing review boundaries remain unchanged.
- **Report-only policy-evidence idempotency.** The recorded fulfilment remains the basis that authorized `Done` on both transports: re-pointing its evidence reference after completion refuses with the same stable code, while identical re-recording is an idempotent no-op. The development tail remains write-time-only.
- **Completed-row coherence stays positive under direct completion.** A `Done` standalone row must satisfy its declared completion kind and applicable integration/no-lease constraints, not bypass them through another state label. The former `validateStandaloneCompletedCoherence` handoff-state bug let a one-word rewrite bypass integration contamination, `integration_worktree_path` / `branch.integration` and no-lease checks, allowing close to stamp `completed`/`ended_at`, unregister the root and pass phase 6 while a handoff was still `accepted`; the direct route retains completion coherence without reinstating that retired handoff reader.
- **One severity vocabulary: `critical | high | medium | low | nit`.** The wrong `info` value had spread into the residual/issue severity axis — the engine SSOT, residual validation, CLI payloads and rollups, the dsh view/schema, and the `mstar-artifacts` reference — so every severity site names `nit` again and `info` is refused as an out-of-enum value.
- **Stored severities are converted by a new schema migration**, never by hand-edited rows: it rebuilds the `issues` table with the `nit` CHECK and rewrites the stored `info` values to `nit` while copying, preserving every row. Earlier migration statements and the `warning → low` legacy read normalization are unchanged.

- Version alignment with harness **4.0.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.0**.

## [3.11.2] - 2026-09-19

### Changed

- Version alignment with harness **3.11.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.2**.

## [3.11.1] - 2026-09-18

### Changed

- Version alignment with harness **3.11.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.1**.

## [3.11.0] - 2026-09-18

### Changed

- Version alignment with harness **3.11.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.0**.

## [3.10.3] - 2026-09-17

### Changed

- Version alignment with harness **3.10.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.3**.

## [3.10.2] - 2026-09-17

### Changed

- Version alignment with harness **3.10.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.2**.

## [3.10.1] - 2026-09-17

### Changed

- Version alignment with harness **3.10.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.1**.

## [3.10.0] - 2026-09-16

### Changed

- Version alignment with harness **3.10.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.0**.

## [3.9.4] - 2026-09-15

### Changed

- Version alignment with harness **3.9.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.4**.

## [3.9.3] - 2026-09-15

### Changed

- Version alignment with harness **3.9.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.3**.

## [3.9.2] - 2026-09-14

### Changed

- Version alignment with harness **3.9.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.2**.

## [3.9.1] - 2026-09-14

### Changed

- Version alignment with harness **3.9.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.1**.

## [3.9.0] - 2026-09-13

### Testing

- Generated the synthetic audit password before interpolating the test document, preserving random secret-detection coverage while preventing a source scanner from mistaking the nested expression for a hardcoded credential.
- Updated **dsh headless guidance** to retain restricted permissions for unattended work, verify effective session permissions, and move operations requiring approval to the web profile instead of removing sandbox restrictions.
- Unify active lifecycle branch checks across hosts, retain parallel track ownership, bound SDD Git probes, and preserve integration-cwd workflow selection.

- Version alignment with harness **3.9.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.0**.

## [3.8.3] - 2026-09-12

### Changed

- Version alignment with harness **3.8.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.3**.

## [3.8.2] - 2026-09-12

### Changed

- **dsh plugin**: background subagent dispatches now pair their settle on the registry **`jobId`** carried by the `{ kind: 'background', jobId }` tool result (the upstream rename away from `taskId`) — the terminal arrives via `ctx.inject(['jobs'])` → `jobs.onJobDone` (`completed → ok` / `killed → denied` / `failed → error`), so a background dispatch no longer stays `running` with no paired settle.
- **dsh plugin**: the ledger now carries child-session identity — a settle row carries an optional `childId` (a foreground `runId`, or a background child id the catalog join already supplied) and `taskRef` (the registry job id, distinct from the Assignment `Task N` tag `taskId`), and a new **nonterminal `subagent-link` row** correlates the parent-owned `subagent/catalog` child id back to the dispatch identity (`role` / `planId` / `taskId`, plus `taskRef` for a background one-shot) through a per-dispatch call-window join — an IDENTITY record, never a completion, so a running child is labellable.
- **dsh plugin**: role text is normalized at the write boundary (trimmed, ONE leading `@` stripped), so `@explore` and `explore` are one actor across the dispatch, settle and link rows.
- **dsh plugin**: the event log's detail rows show the **child session id** (missing → 「—」, never a guessed value), and an agents window holding only link rows is classified link-only rather than settle-only.
- **dsh plugin**: the compact model-facing agent-flow line now reports dispatch/settle **activity** only — `subagent-link` identity rows share their dispatch's role but no longer inflate the `by role` totals (they remain in the structured `source.agentFlow` summary).
- **dsh plugin**: a saturated per-Session call-window slot map now announces itself — the capacity refusal logs ONE bounded warn per apply (parent session identity + cap) instead of degrading child-identity linking silently for the rest of the session.
- **dsh plugin**: the goal bridge is now **advisory-only** — mstar writes **zero goal state** (no `create`, `edit`, `complete`, `pause` or `resume`), so the plugin can no longer re-arm a goal an operator paused: a human `/goal pause` stays paused across mstar's own dispatch and session edges (the mirrored-iteration-objective writer, its drift rebuild and its registration edges are removed, not gated).
- **dsh plugin**: the retained bridge is ONE `session/event` listener that reports a **blocked goal** — one `mstar/goal-bridge` warn per qualifying envelope, carrying the `blockedReason.code`, a bounded objective summary and the project-register residual pointer — and it reads envelope/workspace attribution only, calling neither the goals service nor any harness write.
- **dsh plugin**: `Config.maxGoalRounds` is removed from the plugin schema — its only consumer was the removed mirror writer. A legacy raw key stays an inert unknown option, never an arming path, and the plugin adds no compatibility parser and no flag that re-enables the removed behavior.
- **dsh plugin**: the shared steering helpers (`isRootLikeAgent`, `rootAgentOf`, `steeringCompass`) now live in `gates/steering.ts`, consumed by the planMode bridge; the advisory imports none of them.
- **`dsh-llm-fallbacks` upgraded `0.4.1` → `0.5.2`** (the line adapted to `@deepseek-ai/dsh-*` `^0.1.5-rc.2`): the dsh devDependency, the new `@mstar-harness/engine` `DSH_LLM_FALLBACKS_VERSION` export, and the CLI `init --target dsh` install spec are the EXACT `0.5.2`. Two hand-written literals only (`packages/dsh/package.json` + the engine export); the CLI adapter and the dsh tests import the export, and a lockstep test fails if the two ever drift.
- **The 0.5.x role-identity delivery composes with mstar's own persona channel.** The plugin resolves the Assignment `**Execute as**:` role and delivers that role's persona on the child's start; mstar already delivers its native `SubagentStartRequest.persona`, and an explicit caller-set `request.persona` WINS in both (each side returns early when a persona is already present) — an Assignment-header persona is never replaced after the bump.
- **Upstream preset roles shrank on this line.** `presetRoles` no longer bundles `designer` / `librarian`: 5 preset ids, so the seeded taxonomy union is 13 mstar ids + 5 presets = 18 (was 20). The coexistence and boot-order drift anchors follow the installed upstream value, so the next preset change fails those suites instead of drifting silently.
- 0.5.2 provides its `llm-fallbacks` service INSIDE `ctx.inject(['settings'], …)` — a composition without a `settings` service applies the plugin but registers no service (the real dsh app always composes `dsh-settings-file`). The consumed nine-key service surface is unchanged.
- **The dsh `init` / `doctor` install surface is version-aware for the fallbacks row.** A profile whose `dsh-llm-fallbacks` install is not the pinned version (an operator `link:` checkout from the previous line included) is reported `drifted` by `doctor --target dsh` (exit 1, both versions named) instead of `mounted` + healthy, and `init --target dsh` re-adds the pinned spec instead of reporting `skipped-existing` — the upgrade path from the previous pin, documented in `INSTALL.md` / `docs/cli.md`.
- **dsh docs**: the package README now documents the recommended `workflowNames` allowlist for the native read-only fan-out path on dsh — `mstar-qc-tri` (plan QC tri), `mstar-audit-fanout` (large-repo `/codebase-audit`), `mstar-pr-seats` (`/amazing-pr-review deep`) — with the production-overlay note in the same place: with the shipped empty allowlist every name is *unknown*, which the default `workflowGate: 'warn'` turns into one survivable `workflow.name.unknown` advisory; a deployment that also wants unknown names vetoed sets `workflowGate: 'hard'` in the profile layer. No default changed — `workflowGate` stays `'warn'` and `workflowNames` stays unset (operator overlays, never mstar defaults).
- **dsh read-only fan-out (docs)**: `skills/mstar-host/references/dsh.md` gains the **Read-only fan-out via the `workflow` tool** section and `references/dsh-workflow-scripts.md` ships the copy-pasteable `script` + `meta` templates for the three names; `commands/codebase-audit.md` and `commands/amazing-pr-review.md` carry the dsh-conditional sentence (slash → native `workflow` tool → conversation `workflow-run` node, other hosts unchanged), and `skills/mstar-sdd/SKILL.md` notes the plan QC tri MAY run through the qc-tri script while per-task implementers stay serial `subagent`.
- Session-scoped **multi-active workflow selection**: catalog cache keys include `session.header.id`, the panel `selectWorkflow` control durably binds one active lifecycle per session, and the engine-status response carries a live `binding` separate from the last model emission. Unbound N>1 is a picker error (`workflow.selection.unbound-multi-active`) — never `workflows[0]`.
- **dsh plugin**: the workflow-ledger **cold scan** and `session/created` backfill now enumerate the installed Session's log through its real `seq` + `eventAt(index)` surface instead of the nonexistent `.events` array — on a real Session the old read never matched, so the scan returned immediately and, after a plugin re-apply / restart, the **bound** workflow's Event Log stayed empty for the `tool-workflow/run-start` rows already sitting in that session's log (constructor-seeded replay/resume/fork events never publish on the `session/event` firehose, so the scan was their only route). The scan captures the end seq once from `session.seq` and walks `eventAt(i)` from `max(success cursor, exclusion floor, fork-lineage cut)` up to it — no whole-log copy (`snapshotEvents()` is deliberately not used), and events appended after the capture remain the live firehose's job. The log-rebuild guard now compares the recorded cursor against `session.seq` rather than `.events.length`, and there is no `.events` compatibility path. Durable record-then-advance watermarking, `withWorkflowDirLock`, and the carrying-session binding hint + durable `excludedBeforeSeq` exclusion floor are unchanged.
- **dsh plugin**: two containment repairs on the same scan — the per-session `header.id` read now runs inside the per-session `try`, so one hostile getter can no longer abort the apply-time scan of the remaining sessions (the warn falls back to an `unknown` placeholder instead of re-reading), and an `excludedBeforeSeq` floor recorded past a session's captured log end is reported as identity / log-rebuild drift (one warn, scan skipped) even when the log is empty, instead of being silently swallowed — the intentional exclusion record is never reset.
- **dsh plugin**: the scan now also bounds its walk by the **fork-lineage cut** (`Session.inheritedEventCount`) — a forked child session no longer re-records its parent's inherited `tool-workflow/*` prefix into the same workflow dir: the `session/created` backfill of a fork (the child has no cursor of its own) starts at `max(success cursor, exclusion floor, inheritedEventCount)` and records only the child's OWN events, instead of appending the parent's rows a second time (attributed to the child and breaking the one-row-per-(runId, kind, envelope seq) invariant).

- Version alignment with harness **3.8.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.2**.

## [3.8.1] - 2026-09-11

### Changed

- Version alignment with harness **3.8.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.1**.

- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.5-rc.2` and refresh the lock against the `0.1.5-rc.2` line (badge `0.1.5-rc.2`). Corridor `0.1.5-rc.1 → 0.1.5-rc.2` is cohort bump + web feedback/deliverables polish; no adapter-code changes; no `dsh-session-persistence-sqlite` / `dsh-client-runtime` pin.

## [3.8.0] - 2026-09-10

### Changed

- Version alignment with harness **3.8.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.0**.

## [3.7.3] - 2026-09-10

### dsh

- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.5-rc.1` and refresh the lock against the `0.1.5-rc.1` line (badge `0.1.5-rc.1`). Corridor rollup from `dsh-v0.1.2-rc.1` through alphas (`0.1.3-alpha.1/2`, `0.1.5-alpha.1/2`) to this RC. No `dsh-session-persistence-sqlite` / `dsh-client-runtime` pin is added (neither is published at `0.1.5-rc.1`). Remote / `dsh-api-remotes` stays; `host-apiproxy` stays out of the client-bundle INLINE_SAFE allowlist; `SessionEvent.ignorable` usage is kept. The fallbacks-only / transitive dsh packages are declared as `@mstar-harness/dsh` peers at the same caret so those packages resolve into the checked graph and the `peer-deps.spec.ts` single-line guard covers the whole family.
- Lock converges to a single `0.1.5-rc.1` dsh line. No root `package.json` overrides.
- Compensate for `@deepseek-ai/dsh-client-store` / `dsh-client-ui-primitives` / `dsh-client-ui-renderer` publishing without their former runtime dependencies: add `zustand`/`immer`, the previous primitives markdown/shiki stack, and `use-sync-external-store` as `@mstar-harness/dsh` **devDependencies** so client-seam tests and typecheck can load the registry packages.

- Version alignment with harness **3.7.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.3**.

## [3.7.2] - 2026-09-09

### Changed

- Moved the `mode: primary` **`project-manager`** agent shell out of the shared `agents/` subagent surface into `packages/opencode/agents/` (OpenCode-only). Host plugin surfaces (ZCode / omp / Claude-plugin manifests) no longer register PM as a subagent — PM entry stays via the `pm` skill; OpenCode bundling merges the shell into `harness-agents/`.
- Updated omp/dsh mirror contracts and host docs to match.

- Version alignment with harness **3.7.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.2**.

## [3.7.1] - 2026-09-09

### Changed

- **dsh fallbacks seeds now converge on boot.** The mstar role-seed declaration survives the provider's apply window: a transient `seeds: settings service is unavailable` reject is retried (3 attempts across the provider's apply window) instead of failing the boot declaration, an ultimately-failed declaration logs exactly one terminal error while the decision-point retry stays available, and the adoption advisory arms only after a converged re-declare — no manual `roles.list` edit is needed for the 13 seeded mstar roles.
- **Persona seam probe with fail-loud warn.** The native persona channel's cordis `internal/get` seam is probed once per apply (temporary canary listener + one controlled proxied `ctx.subagents` read, never `ctx.get`; fully try/catch-wrapped): a missing or unrecognized seam logs ONE warn (`role persona channel not installed — cordis 'internal/get' seam missing or unrecognized (rolePersonas will not be merged into subagent starts)` + reason) instead of failing silently; a healthy boot produces NO warn (on today's composition the apply ctx does not resolve `subagents`, so each apply emits one no-warn `service-absent` debug — cordis resolves the service in dispatch scopes, where reads are intercepted per read; `wrap-skipped` is pinned but not reachable from the shipped apply wiring; probe-internal errors degrade fail-open); merge/delegation semantics unchanged. A dedicated probe family (`tests/persona-seam-probe.spec.ts`, 10 cases) pins the seam name (via the exported `PERSONA_SEAM_EVENT` constant), the outcome table, and the warn text verbatim; the installed-artifact assertion arms once the release carrying the probe publishes (surface-vintage guard in `tests/install-e2e.spec.ts`).
- **`rolePersonas` docs now state the merge semantics explicitly.** The Config JSDoc and the README config table spell out all three cases unambiguously: the request's own `persona` wins as-is (caller intent is never overridden — no role merge), a non-empty entry beats the bundled `harness-agents/` mirror default, and an **empty-string** entry is treated as unset and falls through to the mirror default — documentation only, persona resolution behavior unchanged.
- **Seed mirror views are compile-tied to the real fallbacks types.** A dedicated typegate spec (run by `typecheck:tests`, the same channel as the existing service-view gate) asserts the mstar seed mirror views stay assignable from the real `dsh-llm-fallbacks` module shapes — drift fails the typecheck, not a runtime dispatch; `packages/dsh/src/` keeps zero runtime and zero type imports of the fallbacks package.
- **Skill-lint runtime-mode parity is pinned by tests** on the canonical fixture rows (`classifySkillLint` routes `mstar-*` ids to the runtime profile; `lintFiveQuestion` receives `profile.mode`), closing the stale roadmap observation; the `fallbacks-decoration` fixture-flake observation is closed as obsolete (the spec no longer exists).
- **The `rolePersonaAgentsDir` module sink lifetime is documented and pinned by a re-bind test** (one plugin row per process; the per-apply `setRolePersonaAgentsDir` call is the re-bind/reset and also resets the mirror-absent latch) — no refactor, persona delivery semantics unchanged.

- Version alignment with harness **3.7.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.1**.

## [3.7.0] - 2026-09-08

### Changed

- **One skill-lint classification policy across hosts**: CLI `mstar skill lint`, dsh skill-lint gate and drift Guard 5 now consume the shared Engine classifier `classifySkillLint` (exact `mstar-harness-core` → five-question exempt, `mstar-skill-authoring` → strict authoring, other `mstar-*` → runtime aliases, everything else → strict authoring). Identity is the resolved skill-directory basename — never the YAML `name` — so shipped runtime skills no longer receive conflicting dsh/CLI judgments; frontmatter and ephemeral-citation checks stay active in every profile and dsh content-blind repair behavior is unchanged.
- **Real-corpus parity + drift sensitivity evidence**: before/after lint decisions recorded on the shipped corpus (pre-fix dsh failed 15/20 `mstar-*` skills in authoring mode; candidate dsh, CLI and Guard 5 all pass the 18 runtime skills with 0 violations), plus red probes proving an intentionally mismatched classification or a removed real heading fails the corpus guard.

- Version alignment with harness **3.7.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.0**.

## [3.6.3] - 2026-09-06

### Changed

- Replaced static synthetic credentials in security tests with locally generated disposable values (random tokens, locally signed JWTs, in-memory RSA and OpenSSH keys), preserving every detection and redaction assertion without requiring an OpenSSH executable. CLI coverage now also asserts a tracked token is found and its value never printed.
- Reworded the placeholder-masking comment in the engine audit source and the mstar-audit prompt-injection rules to state the invariant without quoting attack phrasing; paired before/after classification checks keep the defensive behavior identical.
- Added an advisory HOL Plugin Security Scan workflow for pull requests, main-branch pushes, and manual runs, with a pinned Action, explicit Cisco skill analysis, an 80-point/high-severity target, and reports preserved on threshold failure. Repository-owned suppressions remain untrusted.
- Included the MIT license and a link to the shared security disclosure policy in the dsh package distribution.

- Version alignment with harness **3.6.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.3**.

## [3.6.2] - 2026-09-05

### Changed

- Version alignment with harness **3.6.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.2**.

## [3.6.1] - 2026-09-03

### Changed

- Version alignment with harness **3.6.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.1**.

## [3.6.0] - 2026-09-03

### dsh

- **`dsh-llm-fallbacks` upgraded to `0.4.1`** (the line adapted to `@deepseek-ai/dsh-*` `^0.1.2-rc.1`): the repo's devDependency and the dsh adapter's install spec are now the EXACT `0.4.1` (no caret). The unpinned add previously forwarded the dsh CLI's own manifest spec (`^0.3.5`), whose dist re-exports `installSettingsSection` from `@deepseek-ai/dsh-settings` — an export the rc.1 line removed — breaking the installed-artifact boot; the installed dsh e2e specs now also pin the fallbacks add and extend the shipped-surface probe to the native persona channel (`internal/get` + `request.persona`), so a published dist built on the superseded additive-section path is re-added pinned to the repo version instead of silently booting stale.
- Both dsh install e2e specs run green end to end against the real registry (previously failing on the `^0.3.5` re-export break).
- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.2-rc.1` and refresh the lock against the `0.1.2-rc.1` line (badge `0.1.2-rc.1`). Alpha.3 already removed the optional SQLite session persistence upstream — nothing to migrate, and no `dsh-session-persistence-sqlite` / `dsh-client-runtime` pin is added (neither is published at `0.1.2-rc.1`). Remote / `dsh-api-remotes` stays; `host-apiproxy` stays out of the client-bundle INLINE_SAFE allowlist; `SessionEvent.ignorable` usage is kept.
- Lock converges to a single `0.1.2-rc.1` dsh line. `dsh-llm-fallbacks@0.4.0-alpha.1` (dev-time-only) still peers `^0.1.2-alpha.3`, and bun pins a prerelease range to the exact published version, so the three fallbacks-only peer-resident packages (`@deepseek-ai/dsh-api-session-controller`, `dsh-util-time`, `dsh-util-workspace-path`) are declared as `@mstar-harness/dsh` peers at `^0.1.2-rc.1` — all three are published at that tag and carry zero mstar imports, keeping the resolved graph on one line (the `peer-deps.spec.ts` single-line guard).

- Version alignment with harness **3.6.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0**.

## [3.6.0-alpha.4] - 2026-09-03

### Changed

- Documented **headless profile support**: the plugin mounts unchanged in the dsh headless profile (`dsh plugin --profile headless add @mstar-harness/dsh`) — all gates, the skill mount, the engine-status catalog, the harness-rules injection, and the 7 `mstar_*` tools ride `dsh-base` seams that headless inherits; verified on dsh 0.1.0-rc.6 (catalog row, harness-dir probe from the session cwd, dispatch-gate hard deny/pass, child dispatch).
- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.2-alpha.3` and refresh the lock against the `0.1.2-alpha.3` line (badge `0.1.2-alpha.3`). Alpha.3 removed the optional SQLite session persistence upstream — nothing to migrate, and no `dsh-session-persistence-sqlite` / `dsh-client-runtime` pin is added (neither is published at `0.1.2-alpha.3`). Remote / `dsh-api-remotes` stays; `host-apiproxy` stays out of the client-bundle INLINE_SAFE allowlist; `SessionEvent.ignorable` usage is kept.
- Lock converges to a single `0.1.2-alpha.3` dsh line. `dsh-llm-fallbacks@0.4.0-alpha.1` (dev-time-only) still peers `^0.1.2-alpha.2`, and bun pins a prerelease range to the exact published version, so the three fallbacks-only peer-resident packages (`@deepseek-ai/dsh-api-session-controller`, `dsh-util-time`, `dsh-util-workspace-path`) are declared as `@mstar-harness/dsh` peers at `^0.1.2-alpha.3` — all three are published at that tag and carry zero mstar imports, keeping the resolved graph on one line (the `peer-deps.spec.ts` single-line guard).
- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.2-alpha.4` and refresh the lock against the `0.1.2-alpha.4` line (badge `0.1.2-alpha.4`). Alpha.3 removed the optional SQLite session persistence upstream — nothing to migrate, and no `dsh-session-persistence-sqlite` / `dsh-client-runtime` pin is added (neither is published at `0.1.2-alpha.4`). Remote / `dsh-api-remotes` stays; `host-apiproxy` stays out of the client-bundle INLINE_SAFE allowlist; `SessionEvent.ignorable` usage is kept.
- Lock converges to a single `0.1.2-alpha.4` dsh line. `dsh-llm-fallbacks@0.4.0-alpha.1` (dev-time-only) still peers `^0.1.2-alpha.3`, and bun pins a prerelease range to the exact published version, so the three fallbacks-only peer-resident packages (`@deepseek-ai/dsh-api-session-controller`, `dsh-util-time`, `dsh-util-workspace-path`) are declared as `@mstar-harness/dsh` peers at `^0.1.2-alpha.4` — all three are published at that tag and carry zero mstar imports, keeping the resolved graph on one line (the `peer-deps.spec.ts` single-line guard).
- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.2-alpha.5` and refresh the lock against the `0.1.2-alpha.5` line (badge `0.1.2-alpha.5`). Alpha.3 already removed the optional SQLite session persistence upstream — nothing to migrate, and no `dsh-session-persistence-sqlite` / `dsh-client-runtime` pin is added (neither is published at `0.1.2-alpha.5`). Remote / `dsh-api-remotes` stays; `host-apiproxy` stays out of the client-bundle INLINE_SAFE allowlist; `SessionEvent.ignorable` usage is kept.
- Lock converges to a single `0.1.2-alpha.5` dsh line. `dsh-llm-fallbacks@0.4.0-alpha.1` (dev-time-only) still peers `^0.1.2-alpha.3`, and bun pins a prerelease range to the exact published version, so the three fallbacks-only peer-resident packages (`@deepseek-ai/dsh-api-session-controller`, `dsh-util-time`, `dsh-util-workspace-path`) are declared as `@mstar-harness/dsh` peers at `^0.1.2-alpha.5` — all three are published at that tag and carry zero mstar imports, keeping the resolved graph on one line (the `peer-deps.spec.ts` single-line guard).

- Version alignment with harness **3.6.0-alpha.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.4**.

## [3.6.0-alpha.3] - 2026-08-31

### Changed

- Version alignment with harness **3.6.0-alpha.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.3**.

## [3.6.0-alpha.2] - 2026-08-31

### Changed

- Version alignment with harness **3.6.0-alpha.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.2**.

## [3.6.0-alpha.1] - 2026-08-31

### dsh

- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.2-alpha.2` and migrate the client half off the removed `dsh-client-runtime` onto `dsh-client-store` / `dsh-client-ui-conversation` / `dsh-client-ui-renderer` / `dsh-client-ui-chat` (alpha.2 Remote/store seams). Drop `host-apiproxy` from the client-bundle INLINE_SAFE allowlist. Badge `0.1.2-alpha.2`.
- Bump `dsh-llm-fallbacks` to `^0.4.0-alpha.1`: its 25 peers re-anchor to `^0.1.2-alpha.2` (and `dsh-client-runtime` is dropped upstream), so the lock collapses to a single `0.1.2-alpha.2` dsh line.
- Demote `dsh-llm-fallbacks` to a dev-time-only dependency: dsh `0.1.2-alpha.2` natively covers subagent customization, so the fallbacks capability is strictly optional. `src/` carries zero imports of the package (runtime and type — the consumed surface is mirrored by local structural types kept in sync by the probe's exact-keys gate), `package.json` keeps it only under `devDependencies`, and `dist/` carries no import and no type reference. The activation contract is unchanged (separate second-command install).
- Refresh `@deepseek-ai/cordis` to `4.0.2` in the lock (host peers `^4.0.2`; the stale `4.0.1` pin predated the alpha.2 graph).
- Deliver role persona through dsh's NATIVE subagent persona channel: a role-matched start — the one-shot `start` AND the opt-in continuable `startContinuable` (`backgroundMode: 'continuable'`) — now merges the persona into `SubagentStartRequest.persona` (intercepted via the cordis `internal/get` service-read waterfall — the runtime object is never mutated), so dsh composes it as the scoped `deployment:persona` section that SHADOWS the deployment persona for role-matched children — the child embodies the role persona instead of coexisting with it — and persists + reapplies it on resume. The additive `mstar:role-persona` system-prompt section is removed. Capability-gated per surface: one-shot starts for providers without the native `persona` capability (out-of-process) skip the persona with one contained debug log; continuable starts gate on the native `prepareContinuable` contract instead; the start is never failed. Fallbacks stays enhancement-only (seeds + advisory); persona delivery is fallbacks-independent.

- Version alignment with harness **3.6.0-alpha.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.1**.

### Changed

- **Catalog state plans/leases join cap**: the `<mstar_engine_status>` catalog state section (`renderEngineStatusCatalog`, `packages/dsh/src/gates/catalog.ts`) now caps the `plans:` / `leases:` joined rendering at `CATALOG_STATE_JOIN_LIMIT = 8` (exported from `packages/dsh/src/gates/_shared.ts` and shared by both joins via `joinCapped`), appending a final `+N more` overflow marker when a list is longer. At or under the cap the rendering is byte-identical to the previous unbounded output, and the empty `none registered` / `none active` copy is unchanged. Sparse-lease visibility: plans hidden behind the `plans:` overflow marker may still appear in the `leases:` line when the lease count is at or under the cap.

## [3.5.1] - 2026-08-28

### Changed

- Version alignment with harness **3.5.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.5.1**.

## [3.5.0] - 2026-08-28

### Changed

- Version alignment with harness **3.5.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.5.0**.

## [3.4.1] - 2026-08-27

### Changed

- **Anti-recursion precheck re-scoped to CALLER semantics (fixes #156)**: `composeDispatchGate` no longer feeds the host role-binding field into `antiRecursionPrecheck` as if it were the dispatching agent — on omp/OpenCode/Cursor that field (`agent` / `subagent` / `subagent_type`) carries the spawn TARGET, and target == `Execute as` is the documented compliant C5 dispatch pattern, so under `Enforcement: hard` every correct dispatch hard-blocked on `dispatch.anti-recursion.self-type`, while omitting the field hard-blocked on `dispatch.anti-recursion.empty-binding` (no spec-compliant binding existed). The composition now takes `caller` (the dispatching agent's OWN role) + `callerRequired`; the precheck runs only when a caller binding exists, and fails closed on an empty one only where the host contract mandates the binding (dsh). The `agent` option is removed — migrate callers to `caller`.
- **omp plugin**: Gate 2 (task dispatch) no longer runs the anti-recursion leg (omp's `tool_call` event carries no caller identity; the NEVER red line stays prompt-level via `mstar-dispatch-gates`), so the documented `agent: "<Execute as role-id>"` pattern passes under hard. The dispatch gate now ALSO honors the repo-level `.mstarc` / compass `enforcement: hard` (previously header-flag-only — a hard compass left Gate 2 unhardened, diverging from Gate 1 and dsh `resolveDispatchHard`), and soft-mode dispatch violations are warn-logged through the extension logger instead of silently dropped (opencode parity; the silent drop is why the #156 pincer stayed latent for five iterations).
- **OpenCode surface**: `validateDispatchAssignment` drops the `subagentType` plumbing (the spawn target is not an anti-recursion signal) and composes the repo-level `.mstarc`/compass hard setting below the Assignment header flag, matching the status-write gate and dsh. Compliant dispatches no longer warn `self-type` / `empty-binding`; a hard repo now escalates flag-less dispatch violations to error-level + `hardBlocked`.
- **dsh surface**: `dispatchGateCore` passes `caller: config.dispatchBinding ?? ''` with `callerRequired: true` — behavior unchanged (self-recursion critical; unset binding fails closed under hard). `mstar_dispatch_validate`'s `agent` param is now `caller` (the DISPATCHING agent's own role; omit when unknown).
- **Docs**: `mstar-dispatch-gates` records the caller-vs-target engine scope; `mstar-host/references/omp.md` gains the Gate 2 anti-recursion scope note; stale dsh `dispatchBinding` "precheck skipped" rows corrected to the fail-closed contract.

- Version alignment with harness **3.4.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.4.1**.

## [3.4.0] - 2026-08-27

### Changed

- Version alignment with harness **3.4.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.4.0**.

## [3.3.0] - 2026-08-25

### Harness

- `mstar-roles` role references are now **identity-first**: mission, scope, and NEVER rules lead each leaf role file; topic `mstar-*` skills moved from top-of-file "Required Skill Dependencies" into a trailing **Skill Preset (PM-Activated)** section. Skills are presets the PM controls via a new canonical Assignment `Skill presets:` field — omitted on an implementation / QC / QA round defaults to the role's `standard` preset; explicit `none` (or a trivial route) runs identity-only without topic skills. QC/QA role-owned procedure files (`references/qc-specialist/*`, `acceptance-gate.md`) are never preset-gated. `project-manager` keeps its required-reading list unchanged as core orchestrator.
- **dsh plugin**: the fallbacks seed mandatory-load line now matches the preset model — `Load mstar-roles (references/<role-id>.md) first — identity comes before skills; load topic skills only when the Assignment activates them via its Skill presets field.` (mirrored in `tests/fallbacks-seeds.spec.ts` and both READMEs; pairing hashes re-recorded).

- Version alignment with harness **3.3.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.3.0**.

## [3.2.6] - 2026-08-24

### Changed

- Version alignment with harness **3.2.6**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.6**.

## [3.2.5] - 2026-08-24

### Changed

- Version alignment with harness **3.2.5**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.5**.

## [3.2.4] - 2026-08-24

### Changed

- Version alignment with harness **3.2.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.4**.

## [3.2.3] - 2026-08-24

### Changed

- Version alignment with harness **3.2.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.3**.

## [3.2.2] - 2026-08-24

### Changed

- Version alignment with harness **3.2.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.2**.

## [3.2.1] - 2026-08-24

### Changed

- Version alignment with harness **3.2.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.1**.

## [3.2.0] - 2026-08-23

### Harness

- Renamed `mstar-plan-conventions` → **`mstar-conventions`** and `mstar-plan-artifacts` → **`mstar-artifacts`**: the two skills are general harness conventions (paths, artifacts), not plan-specific, so the `plan-` prefix was dropped. All live surfaces swept (`skills/**` load orders, index rows and cross-cites, `commands/**`, `AGENTS.md`, `README.md` + `README_CN.md` skill tables, `docs/cli.md`, `.cursor/` routing-eval fixtures + local validation, `scripts/` guards, engine/dsh/cli source comments and path literals, dsh test expectations). Historical changelogs and engine test-fixture prose are untouched — old names there are correct as historical record.

- Version alignment with harness **3.2.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.0**.

## [3.1.3] - 2026-08-23

### Harness

- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.1-rc.2` line (`^0.1.1-rc.2`; `@deepseek-ai/cordis` stays `^4.0.1`; `dsh-llm-fallbacks` stays `^0.3.0` — its 0.3.3 peers are `^0.1.1-rc.1`, satisfied by the rc.2 line). Verified against the `0.1.1-rc.1 → 0.1.1-rc.2` diff (deepseek-harness @ `b150a55`): the change is the unified image/Files request pipeline plus the permission-preset copy-and-default revert — the plugin consumes none of those surfaces (no image region reads, no attachment request payloads, no permission-preset default-copy helpers; the only `preset`/`permission` references are the `dsh-llm-fallbacks` role-seed registry and a dsh-core `/permission` command precedent), so zero adapter-code changes. Lock re-resolved to a single `0.1.1-rc.2` line — zero `0.1.1-rc.1` (and older) copies anywhere, no `dsh-client-web-react` holdover.
- **Engine public surface**: `redactSecrets` is no longer re-exported from the `@mstar-harness/engine` barrel (breaking for downstream imports of the bare package); the audit-module utility is now reachable via the new `@mstar-harness/engine/src/audit` subpath, and the `RedactResult` / `SecretFinding` types stay in the barrel. Barrel importers must migrate to the subpath.
- **dsh**: the audit seam (`packages/dsh/src/gates/seams.ts`) now imports `redactSecrets` from the `./src/audit` subpath instead of the barrel.

- Version alignment with harness **3.1.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.3**.

## [3.1.2] - 2026-08-21

### Harness

- **Anti-recursion fails closed on an empty host binding**: `dispatch.antiRecursionPrecheck` now returns a **critical** `dispatch.anti-recursion.empty-binding` violation when the host role-binding field (`omp task entry agent` / opencode `subagent` / cursor `subagent_type` / dsh `dispatchBinding`) is empty, omitted, or whitespace-only — the host cannot prove the dispatching agent is not recursing, so the dispatch must not proceed as if the NEVER red line held. `composeDispatchGate` no longer skips the precheck for empty bindings (the `if (agent !== "")` skip is removed); the precheck is the single decision point and runs for every Assignment-shaped text, including read-only (scout/explore) Assignments (no carve-out). A set binding equal to `Execute as` keeps the existing critical `dispatch.anti-recursion.self-type`; a set binding with an empty `Execute as` stays ok on the anti-recursion leg (field presence remains `validateAssignmentFields`' job).
- **OpenCode surface**: `validateDispatchAssignment` (via `composeDispatchGate`) now warns `dispatch.anti-recursion.empty-binding` at critical severity when the task tool carries no `subagent` / `subagent_type` key; under the Assignment's own `**Enforcement**: hard` the empty binding hard-blocks (`hardBlocked: true`). No `src` change — the hook already flows the default `""` binding through the engine composition.
- **dsh surface**: `dispatchGateCore` passes `config.dispatchBinding ?? ''` into the engine composition, so an unset binding now emits `dispatch.anti-recursion.empty-binding` (critical) on every Assignment-shaped dispatch — advisory in warn mode, `PreToolDecision { kind: 'deny' }` under hard. The boot-time warn string no longer claims the precheck is "skipped": an unset `dispatchBinding` under hard enforcement now fails closed until the binding is set. The Zod `dispatchBinding` schema is untouched.
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.1-rc.1` line (`^0.1.1-rc.1`; `@deepseek-ai/cordis` stays `^4.0.1`; `dsh-llm-fallbacks` re-aligned `^0.2.0` → `^0.3.0` so its peers land on `^0.1.1-rc.1`). Verified against the `0.1.0-rc.8 → 0.1.1-rc.1` diff (deepseek-harness @ `528c682e06`): every consumed server-side package changed docs/package.json only, client-side consumed surface changed additively, and the `__ModuleLoader__` handoff survives — zero adapter-code changes. No checklist seam (credentials records, pi-ai auth, index-inject, session-projection) is consumed. Lock re-resolved to a single `0.1.1-rc.1` line — zero `0.1.0-rc.8` copies anywhere, and the `dsh-client-web-react` rc.7 holdover is eliminated (fallbacks 0.3.3 dropped that peer); `@oh-my-pi/*` / `@bufbuild/protobuf` resolutions are unchanged from the previous lock. No previously blocked mstar-dsh goals were unblocked by this line.

- Version alignment with harness **3.1.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.2**.

## [3.1.1] - 2026-08-20

### Harness

- **Slim `mstar:engine-status` digest**: the GLOBAL runtime-context digest (`engineStatusSummary` in `packages/dsh/src/gates/system-prompt.ts`) now injects the version watermark alone — `mstar engine status: v<version>` — plus, only when the session's workspace has an **active** workflow (`state.selection.kind === 'active'`), one compact `workflow <id> (<type>) <status> | plans: <id>(<status>) …` line. Idle sessions (no harness dir, empty/absent `workflows[]`, or a terminal/error selection) render the version line exactly; the catalog's terminal-mtime history fallback is structurally unreachable from this surface. The plans join is the selected snapshot's non-`Done` rows in catalog order, capped at 8 with a `+N more` overflow marker (`plans: none` when empty). Harness dir / enforcement / residuals / leases / direction / iteration-gate detail are dropped from this context — harness dir and enforcement remain in `mstar:harness-rules`, the rest in the pre-step catalog row.
- **`workflowType` / `workflowStatus` state fields**: `MstarHarnessState` gains two ALWAYS-present nullable fields carrying the selected snapshot's top-level `type` / `status` (populated from the snapshot the engine-status source already reads; `null` on selection error). The digest trusts `workflows[]` membership and renders the snapshot's **own** status word — a stale-but-registered terminal entry honestly shows e.g. `completed` — and a missing/unreadable snapshot degrades to the version-only line without throwing.
- **Lease-cap retirement**: `DIGEST_LEASE_CAP` and the leases join are removed from the digest (the leases `→` glyph leaves with them); `DIGEST_PLAN_CAP` is retained. The sibling `<mstar_engine_status>` pre-step catalog row (`renderEngineStatusCatalog`) is unchanged and stays uncapped.

- Version alignment with harness **3.1.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.1**.

## [3.1.0] - 2026-08-20

### Harness

- **Engine-status digest join caps**: the `mstar:engine-status` runtime-context digest (`engineStatusSummary` in `packages/dsh/src/gates/system-prompt.ts`) now renders at most 8 plan rows and 4 lease rows in catalog-array order, appending a final `+N more` overflow marker when the list is longer — the digest stays a bounded snapshot and truncation stays visible. At-or-under-cap output and the empty `none` / `none active` copy are unchanged; per-item `stripInterpolationHazard` screening and the compact residuals counts are untouched. The caps are module-level constants, deliberately not re-exported. The sibling `<mstar_engine_status>` pre-step catalog row (`renderEngineStatusCatalog`, `packages/dsh/src/gates/catalog.ts:288` plans join / `:300` leases join) stays uncapped by design: sharing the constants would close a `system-prompt.ts ↔ catalog.ts` import cycle, and duplicating them would fork the values — the sibling follow-up is registered on the v3.1.0 roadmap.
- **Agent-flow ledger tail read**: `readAgentFlow` now reads large ledgers (above the 64 KiB read gate) as a bounded latest-first tail — seek from EOF, align the window start to a line boundary, and double the window backward until it holds `limit` complete lines — so the catalog pays O(window) at the byte layer instead of parsing every historical line. Small ledgers keep the existing full-read path verbatim; both paths feed the same parse funnel, so tail/full parity is structural. Write path (append + 500-line truncation under the per-workflow lock) is untouched.

- Version alignment with harness **3.1.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.0**.

## [3.0.1] - 2026-08-20

### Harness

- **CI runs dsh test + typecheck again**: the link-farm era `dsh:link` call and the source-tree availability gate (`DSH_SOURCE_DIR` / `~/.dsh/source/current`) are gone — the rc.8 seam packages resolve from the public npm registry, so the dsh suite runs unconditionally in CI. The install e2e specs keep their self-skip when no `dsh` bin is on PATH. Test fixtures updated for the v3.0.0 `MstarHarnessState.project` field (5 sites across 4 specs), which had left `typecheck:tests` red on main.

- Version alignment with harness **3.0.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.0.1**.

## [3.0.0] - 2026-08-20

### Harness

- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.8` line (`^0.1.0-rc.8`; `@deepseek-ai/cordis` stays `^4.0.1`). Local rc.7→rc.8 source review of consumed seams found no adapter-code break: the only consumed-surface change is `dsh-commands` `CommandRuntime.execute` gaining a required `images` argument (plugin registrations unaffected; test call sites updated) and an additive `CommandInvocation.attachments` field. Lock freshly resolved to a single rc.8 hoist (`dsh-client-web-react` stays at rc.7 — the latest published); `dsh-llm-fallbacks` moved 0.2.0 → 0.2.2 with the 9-key service-surface drift STOP gate updated in kind.
- Harness dir is uniformly `.mstar/` across the repo: maintenance docs moved under `.mstar/docs/`, the legacy maintenance root is gone, and probe/override docs no longer reference a legacy root name. `harnessDir` / `MSTAR_HARNESS_DIR` semantics unchanged — explicit override wins; probe order stays `.mstar/` → `.agents/` → `.plans/`/`plans/`.
- `drift-lint` roadmap-citation exemption now recognizes `.mstar/`-prefixed citations (gitignored roadmap/ADR docs); engine/dsh/opencode source citations updated to the new path.
- `.mstarc` now supports every harness directory symbol under `[config]`: `plan_dir`, `sdd_dir` (per-plan base), `iteration_dir`, `knowledge_dir`, `specs_dir` (authoritative — skips the candidate chain) alongside `harness_dir`. The engine resolvers (`resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir`) honor them from the nearest `.mstarc` at the harness dir or its parent; `mstar_path_resolve` reports the knowledge dir too.
- `.mstarc` `[config] enforcement=hard|soft` declares the repo hard-gate policy (invalid values ignored). Precedence: explicit Config > Assignment `Enforcement: hard` header flag (dispatch only) > `.mstarc` > iteration compass > warn-only — `.mstarc` `soft` is a local rollback against a hard compass, `hard` hardens flag-less dispatches and gates. New engine `resolveMstarcEnforcement` / `resolveRepoEnforcement`; dsh gates, opencode hook and omp hook now compose the repo policy.
- New gitignored repo-local config **`.mstarc`** (`[config] harness_dir=<dir>`) lets repos with a non-default harness root declare it programmatically — `resolveHarnessDir` honors it above probing (explicit `opts.harnessDir` / `MSTAR_HARNESS_DIR` still win), `sddWorkspace` follows, and the canonical `.gitignore` snippets (engine / CLI init fence / plan-conventions) ignore `.mstarc` by default. Resolution order SSOT updated in `mstar-plan-conventions` § {HARNESS_DIR} 解析顺序.
- Tracked `*.ts` / `*.md` files no longer cite gitignored harness artifacts (paths under `.mstar/` — status.json, plans/, sdd/, iterations/, knowledge/, references/, archived/, docs/): engine/host/test comments and docs now reference `{HARNESS_DIR}` / the consumer default or drop the local path; the drift-lint `.mstar/`-citation exemption is removed (the guard now enforces the rule), and AGENTS.md codifies it.

- Version alignment with harness **3.0.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.0.0**.

## [2.4.1] - 2026-08-17

### Harness

- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.7` line (`^0.1.0-rc.7`; `@deepseek-ai/cordis` stays `^4.0.1`). Local rc.6→rc.7 source review of consumed seams found no adapter-code break (`createUserMessage` / `ToolExecution` / `PreToolDecision` / `PreStepDecision` / `FsWriteIntent` / dump-config `disabled: true` unchanged; `apps/cli/src` version-only). Lock purged every entry below `0.1.0-rc.7` — 62 unique `@deepseek-ai/dsh-*` packages, single hoisted copy each, 0 nested copies. Root `dependencies` stays engine-only.

- Version alignment with harness **2.4.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.4.1**.

## [2.4.0] - 2026-08-17

### Changed

- **dsh full support (docs)**: the `packages/dsh` README triple's Install section now documents the one-command CLI entry (`init --target dsh` — the two `dsh plugin --profile web add` installs, orchestrated) and what a user gets zero-config once both rows are installed: the 13 `mode: subagent` mstar role seeds with mirror-default personas (revertible in settings; runtime advisory reports overrides), plus a fresh-publish `minimumReleaseAge` window note (re-run init or pin the version). The installed-deployment e2e closes the loop: a real CLI install into a temp `DSH_HOME`, booted from the installed artifacts, asserts all 13 roles seeded with non-empty personas. Root README pair adds the dsh full-support one-liner.

- Version alignment with harness **2.4.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.4.0**.

## [2.3.0] - 2026-08-16

### Harness

- **dsh plugin**: pinned `dsh-llm-fallbacks` to `^0.2.0` (seed methods + the TUI client surface available at install; the 0.1.7→0.2.0 delta touches only the upstream TUI client — service/seeds/presets surface verified unchanged) and **zero-config mstar role seeds** — on fallbacks mount, the plugin declares the 13 `mode: subagent` mstar role seeds into the fallbacks seed registry (persona = the `harness-agents/` mirror `description` + one mandatory-load guide line; `{{...}}` interpolation-hazard personas skipped + warned, never declared). The declaration merge-preserves the currently-seeded non-mstar ids from the readback (e.g. the upstream bundled preset roles) — upstream `declare` replaces the whole registry, so preservation keeps preset ids seeded; it re-fires idempotently per fallbacks (re-)apply (HMR/fiber swap), never from a one-shot latch. The 7 preset ids and the mirror-derived 13 mstar ids are **test-enforced disjoint** (the coexistence suite asserts `Set(union).size === 20`) — both boot orders converge to the same 20-id fully-seeded registry.
- **dsh plugin**: the fallbacks adoption advisory is now **seeds-aware** — with the service present, the decision point first awaits the idempotent re-declare (closing the boot race) then reads the EFFECTIVE state and reports per mstar id: missing row (warn), seeded at default (silent, one debug), persona-overridden (warn + the revert entry: the `fallbacks/revert-seed` gateway / the settings-card rollback button); empty-persona warns fire only for non-seeded or overridden-empty rows; declare skips/conflicts (upstream code `persona-source`) merge into one warn. The structural `roles.list` read is preserved on the loader-fallback path (no service). Logger `mstar/fallbacks-advisory`. **Entry-surface note**: `runFallbacksAdvisory` (re-exported from the package entry) is now **async** — it returns `Promise<boolean>` instead of `boolean` (the service-present path awaits the idempotent re-declare before the effective-state readback); external consumers must await it.
- **dsh plugin**: `dsh-llm-fallbacks` registry dependency re-anchored to `^0.1.3` (was `^0.1.0-alpha.4`); the fallbacks-probe version-gate test re-anchored to the resolved `0.1.3` (the exact 6-key `FallbacksService` surface assertion is unchanged and remains the executable drift STOP gate). Dist keeps the type-only import — zero runtime imports of the package.
- **dsh plugin**: role-based subagent configuration via the optional `dsh-llm-fallbacks` plugin — two-command install contract (`dsh plugin --profile web add @mstar-harness/dsh` + `add dsh-llm-fallbacks`; fold-into-patch explicitly rejected — duplicate loader entry id boot failure / dual plugin instance). A role-matched `subagent/start` registers the configured `rolePersonas[executeAs]` persona as the child's agent-scoped `mstar:role-persona` system-prompt section; fallbacks unmounted degrades to the same Config-sourced injection with one debug log; `roleMap` is documented as a taxonomy bridge (logging + future rule-driven interop only). `subagent_fork` joins the default gated dispatch tools (`['subagent', 'subagent_fork']`) with settle pairing. `dsh-llm-fallbacks@^0.1.0-alpha.4` is a registry dependency with type-only imports — `dist/` carries no bundled runtime import (`--external` stays the guard). Persona values containing `{{...}}` are rejected at config validation (dsh strict interpolation hazard). Role→model override deferred to upstream `fallbacks-explicit-role-tool` / N-B1.
- **dsh plugin**: session-start harness context without copy-paste — a GLOBAL `mstar:harness-rules` system-prompt pointer section (order 2: after the deployment persona 0 / child role persona 1, before `plan:policy` 50) carrying presence / enforcement word / resolved `{HARNESS_DIR}` / one "read `skill://mstar-harness-core` first" directive, plus an `mstar:engine-status` runtime-context snapshot (watermark + iteration gate + one compact state line — a bounded projection over the catalog source, never the full status.json). Both register on the GLOBAL prompt layer (root session AND every dispatched child), resolve `{HARNESS_DIR}` **per assembly from the session workspace** (the zero-config default — no explicit `harnessDir` needed), carry zero complete `{{...}}` groups (every operator-controlled value is `{{…}}`-screened before embedding, STRICT interpolation safe even against hostile plan/iteration ids or compass prose), and the child-scoped `mstar:role-persona` section stays byte-stable (regression-loc…
- **dsh plugin**: the section's enforcement word is **live per assembly** — the section text is a provider that re-reads the compass (`resolveCompassEnforcement`, the same existing read the gates and the catalog use; no new config key), so a mid-session compass `soft`/`hard` flip appears in the next prompt assembly without re-registration — in zero-config and explicit-config deployments alike. The registrations' exact disposers are collected on the injection child, so an HMR re-apply disposes the old registrations before registering fresh ones (no duplicate-name throw, no stale closure). Injection degrades contained (service absent → one debug log; registration failure → warn; boot never affected).
- **dsh plugin**: new **goal bridge** (one-way mirror) — during an active iteration (steering compass `status: active|locked`), the root session goal now carries the COMPLETE flow objective (iteration id + `iteration-start → per-plan cycles → iteration-close → PR delivery → merge-ready` + the exit definition; never a sub-stage goal), so an operator driving autonomous Phase 2 sees the full exit contract in the goal UI. `maxGoalRounds` (flat Config key; absent → 256, aligned with the GoalService and ralph defaults; invalid values warn and fall back to 256) bounds the autonomous loop. The mirror is idempotent (get-first create; on objective drift the goal is REPLACED with a fresh one for the new iteration — a completed goal is `create`d directly, a live goal is `complete`d first then `create`d, so each iteration starts with a clean round budget — with a single stale re-read retry), root-filtered (`session.header.parentSession === undefined`; conversation forks conservatively excluded), and unidirectional: it only reads harness state and writes the goal — `{HARNESS_DIR}` / `status.json` stay SSOT. The goals service is an optional seam (`ctx.get('goals')` structural read — no new peer dependency): absent → boot unaffected + one debug log.
- **dsh plugin**: **blocked-goal advisory** — a `session/event` firehose consumer (workflow-ledger precedent) structurally filters the durable `goal/change` events (wire version 1; unknown versions silently skipped) and, when the goal is blocked (`operation: 'block'` or `goal.phase === 'blocked'`), logs ONE `mstar/goal-bridge` warn with the `blockedReason.code`, a bounded objective summary, and the `{HARNESS_DIR}/status.json` residual pointer (`residual_findings`) — the operator acts without reverse-engineering the host. Advisory-only: ZERO harness writes (the one-way mirror holds; status.json remains SSOT).
- **dsh plugin**: **planMode bridge** (one-way mirror) — during a Prepare window (an active steering iteration `status: active|locked` AND ≥1 plan row `Todo` in `{HARNESS_DIR}/status.json` — a registered plan not yet started), the root session is switched into plan mode (`ctx.get('planMode')` structural view — no peer dependency; `set` idempotent, `'noop'` when already in target — repeated evaluation at the `agent/session-start` + `subagent/start` decision points never churns `plan/mode` events); no active iteration or no Prepare window → plan mode OFF (the host default). Root-filtered (`session.header.parentSession === undefined`; conversation forks conservatively excluded), one-way: reads harness state, writes host session state only — `{HARNESS_DIR}` / `status.json` stay SSOT. A user's manual plan-mode selection (e.g. a host `/plan` toggle) is NOT special-cased — the bridge overrides it at the next evaluation point when it disagrees with the harness state (`'noop'` only avoids churn when the target already matches). The planMode service absent → boot unaffected + ONE debug log.
- **dsh plugin**: zero-config role personas — `subagent/start` decoration now falls back to the bundled `harness-agents/` mirror for role shells without a configured `rolePersonas` entry (shell file stem = role id; frontmatter `description` block scalar; `mode: primary` shells like project-manager excluded; interpolation-hazard defaults warned + skipped). Mirror shipped in the published tarball (`files` += `harness-agents`), cached per (path, mtime) with decision-point reads. Interop-log version assertion re-anchored version-agnostic (was hardcoded `0.1.0-alpha.4`).
- **dsh plugin**: warn-only fallbacks adoption advisory — when the optional `dsh-llm-fallbacks` capability is mounted, ONE bounded pass per apply reads the deployment's fallbacks row config (loader entry `options.config`, never the fallbacks plugin's module internals) and warns on taxonomy gaps: mstar roles missing from `roles.list` (id set mirror-derived, not hardcoded), declared roles with an empty persona, and legacy keys (`detectLegacyKeys` semantics via the applied service; skipped on the loader-fallback path). Unreadable row config → skip + one debug; never writes the fallbacks config; unmounted → not invoked. Logger `mstar/fallbacks-advisory`.
- **dsh plugin**: `/codebase-audit` now advertises the `simplify` input hint — the command frontmatter `input:` is `[simplify]` (was `[no args]`), so the dsh web client's claim UX invites the follow-up arg as ghost text instead of executing bare; docs/cli.md documents the variant (usage line + keyword table + examples).
- **dsh plugin**: the skill-lint gate now flags ephemeral citations — `lintSkillDoc` runs the engine `findEphemeralCitations` and reports each hit as a `skill.ephemeral.task-artifact` / `skill.ephemeral.sdd-deeplink` violation (severity `medium`) with the existing warn/hard gate semantics (advisory under warn, veto under hard); placeholder forms pass and the current `skills/` corpus stays zero-hit.
- **dsh plugin**: new **workflow / ralph gate** — a `tools/pre-execute` branch (before the subagent prompt branch, fixed `workflow`/`ralph` tool names) gates the remaining model-reachable fan-out that carries no Assignment text. Four-tier Config mode `workflowGate: off | warn | ask | hard` (default `warn` — advisory-only, never a surprise hard-block): P-a name allowlist (`workflowNames`; empty/absent ⇒ **every** name unknown, never "allow all"), P-b lease attribution (an `InProgress` plan without `execution_lease` coverage in the calling workspace is a workspace red line that preempts P-a/P-c and applies to ralph too — deny under `hard`, advisory under `warn`/`ask`), P-c first-seen ask (unknown name under `ask` → `{kind:'ask'}` through dsh's approval waterfall, fail-closed upstream; the cached allow/deny decision is reused, never a re-ask for a resolved name). The mode is the gate's OWN knob — the cross-cutting `Enforcement: hard` resolution does NOT escalate `workflowGate`. Fail-open edges are documented and never crash a compliant call: malformed args (workflow without `meta.name`, ralph without `objective`) → pass + ONE warn under every mode, no verdict row; unreadable `status.json` → P-b degraded + ONE warn, P-a/P-c still run.
- **dsh plugin**: every gated workflow/ralph call records ONE durable `workflow-verdict` ledger row (verdict vocabulary extended with `ask`: `ok` / `advisory` / `denied` / `ask` — "one ledger row per gated call"; `tool`, `workflow`/`objective`, `mode`, violation `code` never guessed). The P-c answer-observation seam: the gate cannot observe the ask outcome, so the workflow-ledger consumer's run-start observation IS the answer — an ALLOWED ask runs, the durable `tool-workflow/run-start` lands, and the consumer records the W-B2 `workflow-run` row AND caches `allow` for the run name; a DENIED answer produces no run → the next same-name call re-asks (fail-closed, no grant evidence, never an invented allow). Cache keys are the normalized (ASCII control chars stripped) UNCAPPED name at BOTH seams through one shared `normalizeWorkflowName` — a control-char name (`au<NUL>dit`) can never wedge the cache (asks once, observes under the same key), and >1024-char names still key on the full name (the ledger row display name is capped separately). Cache is apply-scoped (dies with the fiber / HMR reload).
- **dsh plugin**: workflow / ralph fan-out runs now land in the agent-flow ledger — a session-event consumer (logger `mstar/workflow-ledger`, registered at apply) maps the durable `tool-workflow/run-start|agent-start|run-end` session events into three new ledger kinds (`workflow-run` / `workflow-agent` / `workflow-run-end`; `childId` preserved, run name + member count + stopReason surfaced in the Event Log tab). Source of record is the session log (cold scan at apply + live `session/event` firehose, one delta cursor per session id — one row per `(runId, kind, seq)`), NOT the in-memory `workflow/*` emits. Observe-only (zero gating): a failing ledger write never crashes or alters a run; the `sessions` service absent (dsh-session mounting after the mstar row, or missing) degrades silently to one debug log with the consumer disabled. On `agent-start`, a once-per-run depth advisory warns when the child session's `delegationDepth` is ≥ 2 — observe-time only, never a refusal path.
- Internal `@mstar-harness/engine` devDependencies in cli/opencode/dsh now use the `workspace:*` protocol; the release-prep engine-spec sync step was removed.

- Version alignment with harness **2.3.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.3.0**.

## [2.2.0] - 2026-08-13

### Changed

- **dsh public release prep**: removed the `prepare` script from `@mstar-harness/dsh` (fresh-checkout `bun install` no longer fails on the gitignored engine `dist/`; the monorepo builds packages explicitly, matching cli/opencode), wired dsh into the release pipeline (`release-surfaces.ts` version surface + changelog, `release.yml` build/publish), and made the READMEs public — the private dsh-provider block and the private-mirror repo-URL install (`dsh-external/mstar-workflow`) are gone, replaced by the registry form `dsh plugin --profile web add @mstar-harness/dsh` (plus local-checkout dev install). Dropped a stray committed `.pnpm-store/` (gitignored now).

- Version alignment with harness **2.2.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.2.0**.

