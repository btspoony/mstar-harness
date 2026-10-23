# Changelog

All notable changes to the `@mstar-harness/opencode` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

## [4.0.7] - 2026-10-23

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **4.0.7** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.7**.

## [4.0.6] - 2026-10-23

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **4.0.6** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.6**.

## [4.0.5] - 2026-10-22

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **4.0.5** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.5**.

## [4.0.4] - 2026-10-20

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **4.0.4** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.4**.

## [4.0.3] - 2026-10-18

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **4.0.3** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.3**.

## [4.0.2] - 2026-10-18

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **4.0.2** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.2**.

## [4.0.1] - 2026-10-16

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **4.0.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.1**.

## [4.0.0] - 2026-10-15

### Harness

- **Removed the dead `judgment review-advice` command** end to end (registration, family, CLI adapter/tests, docs, skill routing). It could never succeed — its only production call passed a null evaluator channel, which the runtime refuses before reading any input. The shadow evaluation path in `packages/judgment` is unchanged. The sandbox calibration worker (`scripts/evaluate.ts`) was migrated off the removed CLI spawn: it now imports the built judgment API bundle and submits via `connectEvaluatorChannel` in the same sandbox/supervisor flow (#440).
- **`hooks/session-context.mjs` is now a bundled artifact**: its source moved to `hooks/src/session-context.ts` and is built through the ZCode hooks builder (engine inlined), so the SessionStart hook runs standalone without `node_modules`; the fail-soft unavailable-authority diagnostic is preserved and covered by a bare-copy smoke test (#446).
- **Gate path resolution is single-sourced in the engine** (`host-gate-paths.ts`) and adopted by all five enforcement sites (opencode v1, opencode-v2, omp, dsh, ZCode write gate): symlink chains are followed to the real landing path with an 8-hop fail-close bound — v1/omp/dsh/ZCode upgrade from one-hop resolution, closing the alias-bypass class fixed in opencode-v2 during batch 1. Each host keeps its own refusal envelope (#442).
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
- **Gate path resolution is single-sourced in the engine**: `@mstar-harness/engine` now owns the landing-path resolver (`landedPathOf`, the chained form) and the case-folded authority naming/classification, and the OpenCode v1, OpenCode v2, omp, dsh and ZCode write gates import it instead of keeping hand copies. The copies had drifted — four of them followed a single symlink hop while v2 followed the chain — so a two-link alias chain to a harness authority file (`store.db` / `-wal` / `-shm`) bypassed the gate. Every gate now resolves the chain (8-hop bound, cycle/overflow refuses fail-closed with `write.symlink-resolution-refused`) and classifies case-variant authority names identically; each host keeps its own refusal envelope (#442).
- Added **`@mstar-harness/opencode-v2`** — the OpenCode **2.x** native plugin package, authored on the pinned `@opencode/plugin` **2.0.26** SDK. It registers the same bundled `mstar-*` skills, role agents, and iteration commands through the V2 native editor surface, and its `write`/`edit`/`subagent` gates **refuse for real** through the typed `Tool.Error` channel (the V1 package's warn-only no-refusal-channel limitation does not apply here). `patch`, `shell`, and Code Mode stay explicit non-claims; installed-host behavior is unverified.
- Made `mstar init --target opencode` / `doctor --target opencode` **generation-aware**: `--opencode-generation <v1|v2>` always wins; a real install otherwise probes `opencode --version` (major ≥ 2 → `@mstar-harness/opencode-v2`, 1.x → `@mstar-harness/opencode`); probe failure refuses with the flag recovery — no silent v1 fallback — and `--dry-run` previews with probes skipped (an unresolved generation is annotated, never guessed). Config markers are a consistency guard only.
- The V2 config write set keeps the V1 key untouched and preserves user values: plural `plugins` with owned-slot dedupe, `agents.<role>.model` only when supplied, a non-destructive `mcp.servers["morning-star"]` merge, and `$schema` preserved — never invented.
- Docs: new `packages/opencode-v2/README.md` + `INSTALL.md`, dual-generation pointers in the OpenCode (V1) package docs, the V2 section in the `mstar-host` OpenCode reference, and the root README install row.
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

- Version alignment with harness **4.0.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.0**.

## [3.11.2] - 2026-09-19

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.11.2** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.2**.

## [3.11.1] - 2026-09-18

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.11.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.1**.

## [3.11.0] - 2026-09-18

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.11.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.0**.

## [3.10.3] - 2026-09-17

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.10.3** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.3**.

## [3.10.2] - 2026-09-17

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.10.2** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.2**.

## [3.10.1] - 2026-09-17

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.10.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.1**.

## [3.10.0] - 2026-09-16

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.10.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.10.0**.

## [3.9.4] - 2026-09-15

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.9.4** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.4**.

## [3.9.3] - 2026-09-15

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.9.3** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.3**.

## [3.9.2] - 2026-09-14

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.9.2** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.2**.

## [3.9.1] - 2026-09-14

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.9.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.1**.

## [3.9.0] - 2026-09-13

### Bundled harness skills (`harness-skills/` at publish)

- Added a **pure SDD test-evidence contract** in the engine: record schema + validation (`validateSddEvidenceRecord`), artifact verification (`verifySddEvidence`), deterministic two-pass input snapshot digests (`evidenceInputDigest`) and first-match reuse applicability (`assessSddEvidenceReuse`) that keeps integrity, process outcome, input applicability and coverage as four separate outputs — unknown dependency/runtime/environment scope stays uncertain and is never silently a reuse candidate.
- Added scoped **`mstar sdd evidence capture|verify`** CLI commands: one recorded execution of an already-authorized check retains literal argv (no shell), separate raw stdout/stderr logs, the tagged outcome and bounded input/tool/environment fingerprints under `{SDD_DIR}/evidence/<run-uuid>`; every retry gets a new run id. Read-only verify never re-runs the recorded child, reports integrity-only without `--target`, and emits a candidate/changed/uncertain verdict with `--target`. Capture supports POSIX linux/darwin in v1 with bounded logs, inputs, snapshots and timeout; the old `sdd exec` and manual scoped-check reports are unchanged.
- Wired the handoff into the skill corpus: PM publishes the fixed capture request, developers capture authorized checks, QC reviews code/coverage without executing, and QA maps acceptance criteria to the retained record (with an explicit AC/run/integrity/outcome/applicability/coverage/gap table) instead of repeating child commands.

- Version alignment with harness **3.9.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.0**.

## [3.8.3] - 2026-09-12

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.8.3** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.3**.

## [3.8.2] - 2026-09-12

### Changed

- **dsh docs**: the package README now documents the recommended `workflowNames` allowlist for the native read-only fan-out path on dsh — `mstar-qc-tri` (plan QC tri), `mstar-audit-fanout` (large-repo `/codebase-audit`), `mstar-pr-seats` (`/amazing-pr-review deep`) — with the production-overlay note in the same place: with the shipped empty allowlist every name is *unknown*, which the default `workflowGate: 'warn'` turns into one survivable `workflow.name.unknown` advisory; a deployment that also wants unknown names vetoed sets `workflowGate: 'hard'` in the profile layer. No default changed — `workflowGate` stays `'warn'` and `workflowNames` stays unset (operator overlays, never mstar defaults).
- **dsh read-only fan-out (docs)**: `skills/mstar-host/references/dsh.md` gains the **Read-only fan-out via the `workflow` tool** section and `references/dsh-workflow-scripts.md` ships the copy-pasteable `script` + `meta` templates for the three names; `commands/codebase-audit.md` and `commands/amazing-pr-review.md` carry the dsh-conditional sentence (slash → native `workflow` tool → conversation `workflow-run` node, other hosts unchanged), and `skills/mstar-sdd/SKILL.md` notes the plan QC tri MAY run through the qc-tri script while per-task implementers stay serial `subagent`.

- Version alignment with harness **3.8.2** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.2**.

## [3.8.1] - 2026-09-11

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.8.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.1**.

## [3.8.0] - 2026-09-10

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.8.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.0**.

## [3.7.3] - 2026-09-10

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.7.3** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.3**.

## [3.7.2] - 2026-09-09

### Bundled harness skills (`harness-skills/` at publish)

- Moved the `mode: primary` **`project-manager`** agent shell out of the shared `agents/` subagent surface into `packages/opencode/agents/` (OpenCode-only). Host plugin surfaces (ZCode / omp / Claude-plugin manifests) no longer register PM as a subagent — PM entry stays via the `pm` skill; OpenCode bundling merges the shell into `harness-agents/`.
- Updated omp/dsh mirror contracts and host docs to match.

- Version alignment with harness **3.7.2** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.2**.

## [3.7.1] - 2026-09-09

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.7.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.1**.

## [3.7.0] - 2026-09-08

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.7.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.0**.

## [3.6.3] - 2026-09-06

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.6.3** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.3**.

## [3.6.2] - 2026-09-05

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.6.2** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.2**.

## [3.6.1] - 2026-09-03

### Bundled harness skills (`harness-skills/` at publish)

- Converted all 14 repo-root agent shells (`agents/*.md`) to **single-line quoted English `description` frontmatter**. ZCode's flat agent frontmatter parser does not support `|-` block scalars — it parsed the literal string `|-` as the description and silently dropped the nested `tools`/`permission` maps, leaving plugin agent entries with a broken trigger description. Wording is unchanged (the existing English line is reused verbatim); `mode`/`tools`/`permission` are preserved for OpenCode semantics.
- Corrected the ZCode host contract (`mstar-host`): current ZCode **does** register Morning Star role agents (`agents/*.md`) as callable `subagent_type` values — dispatch now prefers the **bare role id** (e.g. `fullstack-dev`), keeps `general-purpose` as the universal fallback, keeps C5b prompt + skill-load binding required because the role shells are thin, and carries its own C5/C5b SSOT (the shared role-binding doc is re-scoped to Kimi-only; `zcode.md` no longer loads it). Documents the ZCode frontmatter constraint (single-line quoted English `description`; `|-` blocks and nested `tools`/`permission` are silently mangled/dropped) and that direct marketplace add works now that the repo ships `.claude-plugin/marketplace.json`.

- Version alignment with harness **3.6.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.1**.

## [3.6.0] - 2026-09-03

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.6.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0**.

## [3.6.0-alpha.4] - 2026-09-03

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.6.0-alpha.4** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.4**.

## [3.6.0-alpha.3] - 2026-08-31

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.6.0-alpha.3** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.3**.

## [3.6.0-alpha.2] - 2026-08-31

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.6.0-alpha.2** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.2**.

## [3.6.0-alpha.1] - 2026-08-31

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.6.0-alpha.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.1**.

## [3.5.1] - 2026-08-28

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.5.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.5.1**.

## [3.5.0] - 2026-08-28

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.5.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.5.0**.

## [3.4.1] - 2026-08-27

### Bundled harness skills (`harness-skills/` at publish)

- **Anti-recursion precheck re-scoped to CALLER semantics (fixes #156)**: `composeDispatchGate` no longer feeds the host role-binding field into `antiRecursionPrecheck` as if it were the dispatching agent — on omp/OpenCode/Cursor that field (`agent` / `subagent` / `subagent_type`) carries the spawn TARGET, and target == `Execute as` is the documented compliant C5 dispatch pattern, so under `Enforcement: hard` every correct dispatch hard-blocked on `dispatch.anti-recursion.self-type`, while omitting the field hard-blocked on `dispatch.anti-recursion.empty-binding` (no spec-compliant binding existed). The composition now takes `caller` (the dispatching agent's OWN role) + `callerRequired`; the precheck runs only when a caller binding exists, and fails closed on an empty one only where the host contract mandates the binding (dsh). The `agent` option is removed — migrate callers to `caller`.
- **omp plugin**: Gate 2 (task dispatch) no longer runs the anti-recursion leg (omp's `tool_call` event carries no caller identity; the NEVER red line stays prompt-level via `mstar-dispatch-gates`), so the documented `agent: "<Execute as role-id>"` pattern passes under hard. The dispatch gate now ALSO honors the repo-level `.mstarc` / compass `enforcement: hard` (previously header-flag-only — a hard compass left Gate 2 unhardened, diverging from Gate 1 and dsh `resolveDispatchHard`), and soft-mode dispatch violations are warn-logged through the extension logger instead of silently dropped (opencode parity; the silent drop is why the #156 pincer stayed latent for five iterations).
- **OpenCode surface**: `validateDispatchAssignment` drops the `subagentType` plumbing (the spawn target is not an anti-recursion signal) and composes the repo-level `.mstarc`/compass hard setting below the Assignment header flag, matching the status-write gate and dsh. Compliant dispatches no longer warn `self-type` / `empty-binding`; a hard repo now escalates flag-less dispatch violations to error-level + `hardBlocked`.
- **dsh surface**: `dispatchGateCore` passes `caller: config.dispatchBinding ?? ''` with `callerRequired: true` — behavior unchanged (self-recursion critical; unset binding fails closed under hard). `mstar_dispatch_validate`'s `agent` param is now `caller` (the DISPATCHING agent's own role; omit when unknown).
- **Docs**: `mstar-dispatch-gates` records the caller-vs-target engine scope; `mstar-host/references/omp.md` gains the Gate 2 anti-recursion scope note; stale dsh `dispatchBinding` "precheck skipped" rows corrected to the fail-closed contract.

- Version alignment with harness **3.4.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.4.1**.

## [3.4.0] - 2026-08-27

### Harness

- Renamed `/pr-deep-review` → `/amazing-pr-review` with a clean cutover (no alias) and added three review strengths: `quick` (single-pass, 1 seat, collect + review in one pass) / `default` (the no-flag landing tier — 2 domain seats, collection folded in, reduced seats) / `deep` (the former full three-stage pipeline: collect → domain review → main-agent synthesis, 4–7 seats). The tier is chosen by an explicit keyword or inferred from the change shape; the default tier no longer fans out the full seat plan.
- Reworked `amazing-pr-review` batch semantics to **one session = one PR**: when multiple PRs are passed in, only the **first** runs the full three-stage deep review; the rest are registered as audit todos in `{PROJECT_DIR}/_default/residuals.json` (`decision: defer`, `target: next session`, `tracking: pr-deep-review backlog`) and the report suggests opening one session per remaining PR. The old four-seat N/4 batch fan-out is removed.
- Reworked single-PR deep review into a **three-stage pipeline** (collect → domain review → synthesis): lightweight read-only collect seats fan out by domain, mstar built-in roles review code + security per domain, and the main agent dedupes, three-way vets, and publishes the single GitHub Review. Posting ownership moved to the main agent — review seats never post. Fan-out is scale-driven, reusing the existing ~300-line sizing band.
- Synced the **three-stage pipeline** and **one session = one PR** semantics across skill core, roles, and user-facing docs: `mstar-audit` SKILL.md (`pr` variant dispatch + Hard Rule 2), `mstar-roles` shared Audit Mode and `code-reviewer.md` Mode C (every seat — collect or domain — returns evidence / findings in its result payload: any seat may be write-blocked, and the main agent writes / consolidates the evidence files; seats produce no verdict, never post), and README.md / README_CN.md / docs/cli.md. Posting ownership is unified on the **main agent** across all surfaces — review seats never post.
- **Role references:** Add a shared coding-philosophy line to dev-role Role Missions (`fullstack-dev`, `fullstack-dev-2`, `frontend-dev`): "YAGNI is your coding philosophy; PDCA is your behavioral discipline."
- **Role references:** Unify executor Role Mission phrasing to the second-person "You are …" convention (`qa-engineer`, `prompt-engineer`, `ops-engineer`, `fullstack-dev-shared`); `project-manager` keeps its Identity section as orchestrator exception.

- Version alignment with harness **3.4.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.4.0**.

## [3.3.0] - 2026-08-25

### Harness

- `mstar-audit` review-process hardening: `pr-review.md` gains **input modes** for uncommitted working-tree and single-commit reviews, **sizing bands** with change-shape **escalation** (schema/API/framework/performance/security surfaces), **originating-spec discovery** (score every acceptance criterion against the diff), a **standards precedence** and twelve-smell **baseline** with binding rules, **presumptive-structural** merge classes, and a matter-of-fact tone contract; `audit-playbook.md` gains **Chesterton's Fence** / over-simplification guards and **dependency add/upgrade discipline**; `codebase-audit.md` requires **behavior-preservation gates** on simplification plans; `finding-format.md` gains **remedy-named** Fix sketches (structural remedies).
- `mstar-roles` role references are now **identity-first**: mission, scope, and NEVER rules lead each leaf role file; topic `mstar-*` skills moved from top-of-file "Required Skill Dependencies" into a trailing **Skill Preset (PM-Activated)** section. Skills are presets the PM controls via a new canonical Assignment `Skill presets:` field — omitted on an implementation / QC / QA round defaults to the role's `standard` preset; explicit `none` (or a trivial route) runs identity-only without topic skills. QC/QA role-owned procedure files (`references/qc-specialist/*`, `acceptance-gate.md`) are never preset-gated. `project-manager` keeps its required-reading list unchanged as core orchestrator.
- **dsh plugin**: the fallbacks seed mandatory-load line now matches the preset model — `Load mstar-roles (references/<role-id>.md) first — identity comes before skills; load topic skills only when the Assignment activates them via its Skill presets field.` (mirrored in `tests/fallbacks-seeds.spec.ts` and both READMEs; pairing hashes re-recorded).

- Version alignment with harness **3.3.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.3.0**.

## [3.2.6] - 2026-08-24

### Bundled harness skills (`harness-skills/` at publish)

- **PR deep-review report template hardening**: the `Considered & rejected` placeholder no longer embeds the bullet dash inside angle brackets (a posted review rendered literal `<finding>` wrappers verbatim); rejected entries now use `- **<short title>**: rejected — <reason>` with an explicit "never render brackets" rule stated at the template top; empty Plan-to-fix sections collapse to a bare `none` instead of prose.

- Version alignment with harness **3.2.6** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.6**.

## [3.2.5] - 2026-08-24

### Bundled harness skills (`harness-skills/` at publish)

- **PR deep-review lists every finding by default**: the `[full]` flag is removed from `/pr-deep-review` — complete findings (all merge classes, nits included) are now always listed in the chat output and GitHub Review; nothing is truncated. README command signature updated.

- Version alignment with harness **3.2.5** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.5**.

## [3.2.4] - 2026-08-24

### Bundled harness skills (`harness-skills/` at publish)

- **PR deep-review local report archive**: each `pr`-variant review now saves a durable markdown report under `{PROJECT_DIR}/<project-id>/reports/pr-review/` (`_default` when project-less) — YAML frontmatter metadata (PR, head SHA, verdict, score, tally, review URL) plus the posted GitHub Review body verbatim; bare branch/diff reviews archive the chat display instead. Written via the primary checkout (never inside the review worktree), saved before worktree cleanup regardless of POST outcome; new `- report:` field in the Completion Report output shape.
- **Docs describe current state only**: removed truly retired-path prose from runtime skills — `{PLAN_DIR}/reports/` (legacy report location; no code or migration path references it) and the retired `{HARNESS_DIR}/notes.json` (no code creates or reads it; runtime notes live in `workflows/<id>/notes.jsonl`). Compat behaviors verified against shipped code and kept: `designs/` read-only `{SPECS_DIR}` fallback (`resolveSpecsDir`), legacy flat delivery-compass read/migrate directives, `.agents/` discovery chain, and all v1→v2 migration guards.

- Version alignment with harness **3.2.4** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.4**.

## [3.2.3] - 2026-08-24

### Bundled harness skills (`harness-skills/` at publish)

- **PR deep-review report template**: the GitHub Review body now follows a fixed three-section report — Verdict (verdict token + confidence score + four-class emoji findings table), Review (PR summary, ranked findings with merge class, linked-issue AC, verified checks, considered & rejected), and a collapsible **Plan to fix** section holding the fix plan in a fenced ```md block. Chat display contract unchanged.

- Version alignment with harness **3.2.3** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.3**.

## [3.2.2] - 2026-08-24

### Bundled harness skills (`harness-skills/` at publish)

- `/pr-deep-review` now emits a merge signal computed from the finding tally: the middle verdict token is renamed `needs review` → `needs fixes`, each accepted PR finding carries a `Merge class` (`must-fix` | `should-fix` | `nit`), and the output shape gains `- score_pct:` (derived, `max(0, 100 - 40*must_fix - 15*should_fix - 3*nit - 10*unverified)`, floor 0) and `- tally:` with four counts. The verdict is derived from the tally (`must-fix ≥ 1` → `blocked`, else `should-fix ≥ 1` → `needs fixes`, else `ship it`); leftover linked-issue `unmet` ACs increment `should_fix` (or `must_fix` when unsafe-to-ship) before that mapping and are not extra findings. `score_pct` is display-only and never overrides it. Chat and the GitHub Review `body` open with `{verdict} · {score_pct}%` plus the tally line; `event` remains `COMMENT`. The list cut now applies to nits only — every `must-fix` / `should-fix` is listed. Formula and rules are SSOT'd in `skills/mstar-audit/references/pr-review.md` § Verdict synthesis / Tally and derived score.

- Version alignment with harness **3.2.2** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.2**.

## [3.2.1] - 2026-08-24

### Bundled harness skills (`harness-skills/` at publish)

- `/pr-deep-review` now **requires** posting a GitHub Review when a PR number exists: the `pr` variant always leaves `COMMENT`-event comments on the PR (inline comments on diff-line findings, summary body folds any already-written follow-up plans into a `<details>` section), and the output shape gains a `- comments:` field with the review URL. Posting procedure is SSOT'd in `skills/mstar-audit/references/pr-review.md` § Comment posting; `mstar-audit` Hard Rule 2 and the Audit-Mode contract now carve out only this required GitHub Review POST (Git stays read-only, no commits). `code-reviewer` gains Mode C (PR review) loading `pr-review.md`. `commands/pr-deep-review.md` drops the "optional / separate explicit step" wording. Chat-only verdict is no longer complete for PR seats.

- Version alignment with harness **3.2.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.1**.

## [3.2.0] - 2026-08-23

### Harness

- Hoisted the shared plan-output contract out of `references/codebase-audit.md` into the `mstar-audit` SKILL.md core as **`## Plan output (all variants)`**: write-only-on-selection boundary, `{PLAN_DIR}/audit-<date>/` layout (README index + numbered plan files), `plan.main.md` + plan-quality-bar enrichment, Status-block fields + status values, `git rev-parse --short HEAD` commit stamp, and the four handoff steps (promote / state machine / fast-track Prepare / SDD or inline dispatch). Both variants (`codebase-audit`, `pr-review`) and both commands (`/codebase-audit`, `/pr-deep-review`) now cite the core section; `pr-review.md` § Plan output carries no `codebase-audit.md` cites. Engine audit Status-block and scaffold validators repoint their spec cites to `mstar-audit SKILL.md § Plan output`, and `pr-review.md` § Evidence rules now cites `finding-format.md` § What disqualifies a finding. Closes residual R1 (hoist when a third variant arrives — that condition is now met by the `pr` variant) early.
- Restructured `mstar-audit` into a **variant carrier**: SKILL.md now holds the common core (hard rules, recon, attack-and-vet discipline, variant dispatch table, output-format contract), with full codebase-audit detail moved verbatim to `references/codebase-audit.md` (Phase 2 category fan-out + subagent-prompt requirements, effort table, scope variants, Phase 4 plan writing, audit index / plan-file output templates, `mstar audit scaffold` callout, handoff to execution). `pr-deep-review` no longer loads full-audit-only content; pointer surfaces (`references/pr-review.md`, both commands, `code-reviewer` role, `mstar-harness-core` index) cite the common core + the correct variant reference.
- Added a **generic deep PR review** command (`pr-deep-review`) + `mstar-audit` `pr` scope variant: worktree-isolated, evidence-first, verdict-producing review with concern lenses, linked-issue hygiene, and batch sibling-PR support.
- Renamed `mstar-plan-conventions` → **`mstar-conventions`** and `mstar-plan-artifacts` → **`mstar-artifacts`**: the two skills are general harness conventions (paths, artifacts), not plan-specific, so the `plan-` prefix was dropped. All live surfaces swept (`skills/**` load orders, index rows and cross-cites, `commands/**`, `AGENTS.md`, `README.md` + `README_CN.md` skill tables, `docs/cli.md`, `.cursor/` routing-eval fixtures + local validation, `scripts/` guards, engine/dsh/cli source comments and path literals, dsh test expectations). Historical changelogs and engine test-fixture prose are untouched — old names there are correct as historical record.

- Version alignment with harness **3.2.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.0**.

## [3.1.3] - 2026-08-23

### Harness

- **`mstar audit promote` (CLI)**: selected audit plans can now enter the v2 workflow lifecycle as `type: plan` — `promoteAuditPlans` writes the workflow snapshot (`{HARNESS_DIR}/workflows/<id>/snapshot.json`, one Todo `PlanRow` per selected plan, `id` + `title` + `file`) **before** registering the workflow in root `status.json`, so the snapshot-before-register invariant holds. `--plans` accepts the README Plan column id, stem, or basename; `--workflow` defaults to the `audit-<date>` dir basename; `--harness` defaults to the resolved `{HARNESS_DIR}`. Promote stays an explicit post-selection action — the audit itself never registers (advisory contract preserved).
- **Engine**: `promoteAuditPlans` exported from `@mstar-harness/engine` (titles come from the audit README index, falling back to `readPlanFileSummary`).
- **Harness skills**: `mstar-audit` Handoff step 1 now names `mstar audit promote <audit-dir> --plans <ids>` as the first-class v2 path (manual `mstar-plan-artifacts` wording kept as fallback).
- **Thinned the iteration slash commands** (`/iteration-start`, `/iteration-drive`, `/iteration-loop`) into wrappers: shared PM invariants, session todos, the continuous-execution STOP list, and the assignment-preflight bash (warn-only + `enforcement: hard` fail-fast) now live once in `skills/mstar-iteration/references/command-shared-invariants.md`, and `mstar-iteration` points at it. Frontmatter (`name` / `description` / `agent` / `input`) and each command's unique bits (start grill-me, drive helper discovery, loop do-not-load-grill-me) are unchanged.
- **Trigger-strong `mstar-iteration` description**: the skill now loads for "start an iteration" / "drive the iteration" / "run an autonomous loop" even when no `/iteration-*` slash command fires; phase labels no longer treat command names as phase names.

- Version alignment with harness **3.1.3** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.3**.

## [3.1.2] - 2026-08-21

### Harness

- **Anti-recursion fails closed on an empty host binding**: `dispatch.antiRecursionPrecheck` now returns a **critical** `dispatch.anti-recursion.empty-binding` violation when the host role-binding field (`omp task entry agent` / opencode `subagent` / cursor `subagent_type` / dsh `dispatchBinding`) is empty, omitted, or whitespace-only — the host cannot prove the dispatching agent is not recursing, so the dispatch must not proceed as if the NEVER red line held. `composeDispatchGate` no longer skips the precheck for empty bindings (the `if (agent !== "")` skip is removed); the precheck is the single decision point and runs for every Assignment-shaped text, including read-only (scout/explore) Assignments (no carve-out). A set binding equal to `Execute as` keeps the existing critical `dispatch.anti-recursion.self-type`; a set binding with an empty `Execute as` stays ok on the anti-recursion leg (field presence remains `validateAssignmentFields`' job).
- **OpenCode surface**: `validateDispatchAssignment` (via `composeDispatchGate`) now warns `dispatch.anti-recursion.empty-binding` at critical severity when the task tool carries no `subagent` / `subagent_type` key; under the Assignment's own `**Enforcement**: hard` the empty binding hard-blocks (`hardBlocked: true`). No `src` change — the hook already flows the default `""` binding through the engine composition.
- **dsh surface**: `dispatchGateCore` passes `config.dispatchBinding ?? ''` into the engine composition, so an unset binding now emits `dispatch.anti-recursion.empty-binding` (critical) on every Assignment-shaped dispatch — advisory in warn mode, `PreToolDecision { kind: 'deny' }` under hard. The boot-time warn string no longer claims the precheck is "skipped": an unset `dispatchBinding` under hard enforcement now fails closed until the binding is set. The Zod `dispatchBinding` schema is untouched.

- Version alignment with harness **3.1.2** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.2**.

## [3.1.1] - 2026-08-20

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.1.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.1**.

## [3.1.0] - 2026-08-20

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.1.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.0**.

## [3.0.1] - 2026-08-20

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **3.0.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.0.1**.

## [3.0.0] - 2026-08-20

### Harness

- Harness dir is uniformly `.mstar/` across the repo: maintenance docs moved under `.mstar/docs/`, the legacy maintenance root is gone, and probe/override docs no longer reference a legacy root name. `harnessDir` / `MSTAR_HARNESS_DIR` semantics unchanged — explicit override wins; probe order stays `.mstar/` → `.agents/` → `.plans/`/`plans/`.
- `drift-lint` roadmap-citation exemption now recognizes `.mstar/`-prefixed citations (gitignored roadmap/ADR docs); engine/dsh/opencode source citations updated to the new path.
- `.mstarc` now supports every harness directory symbol under `[config]`: `plan_dir`, `sdd_dir` (per-plan base), `iteration_dir`, `knowledge_dir`, `specs_dir` (authoritative — skips the candidate chain) alongside `harness_dir`. The engine resolvers (`resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir`) honor them from the nearest `.mstarc` at the harness dir or its parent; `mstar_path_resolve` reports the knowledge dir too.
- `.mstarc` `[config] enforcement=hard|soft` declares the repo hard-gate policy (invalid values ignored). Precedence: explicit Config > Assignment `Enforcement: hard` header flag (dispatch only) > `.mstarc` > iteration compass > warn-only — `.mstarc` `soft` is a local rollback against a hard compass, `hard` hardens flag-less dispatches and gates. New engine `resolveMstarcEnforcement` / `resolveRepoEnforcement`; dsh gates, opencode hook and omp hook now compose the repo policy.
- New gitignored repo-local config **`.mstarc`** (`[config] harness_dir=<dir>`) lets repos with a non-default harness root declare it programmatically — `resolveHarnessDir` honors it above probing (explicit `opts.harnessDir` / `MSTAR_HARNESS_DIR` still win), `sddWorkspace` follows, and the canonical `.gitignore` snippets (engine / CLI init fence / plan-conventions) ignore `.mstarc` by default. Resolution order SSOT updated in `mstar-plan-conventions` § {HARNESS_DIR} 解析顺序.
- Tracked `*.ts` / `*.md` files no longer cite gitignored harness artifacts (paths under `.mstar/` — status.json, plans/, sdd/, iterations/, knowledge/, references/, archived/, docs/): engine/host/test comments and docs now reference `{HARNESS_DIR}` / the consumer default or drop the local path; the drift-lint `.mstar/`-citation exemption is removed (the guard now enforces the rule), and AGENTS.md codifies it.
- **v3 workflow lifecycle schema (engine)**: lifecycle state moved from root `status.json` `plans[]`/`residual_findings` into per-workflow snapshots (`{HARNESS_DIR}/workflows/<id>/snapshot.json`, `validateWorkflowSnapshot`) and project registers (`{HARNESS_DIR}/projects/<id>/residuals.json`, `validateProjectRegister`); the v2 root keeps only `version` / `updated_at` / active `workflows[]`. New dir resolvers `resolveWorkflowDir` / `resolveProjectDir`.
- **`mstar migrate` (CLI)**: one-shot v1→v2 tree migration (`migrateHarnessTree` / `applyMigratePlan`) — archives the v1 root to `archived/status.v1.json`, lifts every lifecycle into `workflows/<id>/snapshot.json`, seeds the project register + roadmap, replaces the root with the v2 commit point; idempotent re-run no-op; `--dry-run` prints the step plan and surfaces apply-time validator violations as warnings; exit codes 0/1/2; `--path` defaults to the resolved `{HARNESS_DIR}`.
- **CLI/tools/hook hard cutover to v2 inputs**: `status validate` (v2 root or snapshot), `status tech-debt` / `status findings-cleanup` (project register), `lease verify` / `lease verify-integration` / `iteration gate` / `worktree check` (workflow snapshot via `--workflow <id>`), `path resolve` (+ workflow/project dirs); `status archive-residuals` removed (error stub names the register close flow); `tools/mstar_*` and the omp/opencode Gate 1 hooks validate the three v3 coordination documents, with lazy-loaded P1-only engine exports so a stale published engine degrades to a warning instead of dropping the hook/tool.
- **Skills v2 surfaces**: retired `done-compaction` / `plans-done` / `notes.empty` artifacts and scrubbed all references; rewrote status/residual/lease/convention surfaces across `mstar-*` skills to v2 addresses (`workflows/<id>/snapshot.json`, `projects/<id>/residuals.json`, `mstar status validate` / `findings-cleanup` / `tech-debt`, `mstar lease verify --workflow <id>`, `mstar iteration gate --workflow <id>`).
- **`mstar-engine-legacy`** (new): conditional contract archive for engine-absent hosts — status v1→v2 field history, lease protocol, per-host QC seat N=3/N=1 restatements, anti-recursion checklists, engine-check boilerplate; not loaded when engine constraints are active.
- **`mstar-project-governance`** (new): `projects/<id>/roadmap.md` authoring conventions (frontmatter schema + body conventions, warnings-only) and `residuals.json` register lifecycle (open → verified close in place, severity enum, provenance fields, `_default` fallback); schema verbatim with the engine `project.ts` validators.
- **Docs sync**: README.md / README_CN.md layout description and workflow diagram updated to v2 state surfaces (workflow snapshot / project register; `workflow_dir` / `project_dir` `.mstarc` keys); routing-eval scenario set re-pointed to v2 artifact addresses.

- Version alignment with harness **3.0.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **3.0.0**.

## [2.4.1] - 2026-08-17

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **2.4.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.4.1**.

## [2.4.0] - 2026-08-17

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **2.4.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.4.0**.

## [2.3.0] - 2026-08-16

### Harness

- Internal `@mstar-harness/engine` devDependencies in cli/opencode/dsh now use the `workspace:*` protocol; the release-prep engine-spec sync step was removed.

- Version alignment with harness **2.3.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.3.0**.

## [2.2.0] - 2026-08-13

### Bundled harness skills (`harness-skills/` at publish)

- Added the **dsh host reference** to `mstar-host`: a detect-table row for dsh's `subagent` delegation tool and `references/dsh.md` (tool map, in-process gates/enforcement, bundled commands, PM dispatch, gotchas).
- **Sync upstream v2.1.1**: merged the upstream `mstar-harness` v2.1.1 line into the dev-dsh branch — adds the `code-reviewer` role (read-only L2 SDD task reviewer / audit executor; replaces `generalPurpose` as the SDD per-task review seat, with generic fallback only when the role agent is absent on the host), ships the canonical default-ignore harness `.gitignore` format (`.mstar/**` + tracked re-includes `AGENTS.md` / `knowledge/` / `specs/`) across the engine, CLI `init` fence and bundled skills, and aligns all 11 version surfaces to 2.1.1.
- **engine**: `emitGitignoreSnippet` / `validateGitignore` / `HARNESS_PROCESS_GITIGNORE` now emit the default-ignore + re-include format instead of the flat per-directory ignore list; `ROLE_MAPPING` grows to 14 ids with `code-reviewer`.
- **bundle-assets**: re-synced `packages/dsh/harness-skills` / `harness-commands` from the merged `skills/` tree — the 6+ upstream-touched bundled skills and all `mstar-host/references/*.md` host adapters (cursor/kimi/omp/opencode/zcode) now carry the v2.1.1 wording (SDD task reviewer → `code-reviewer`).

- Version alignment with harness **2.2.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.2.0**.

## [2.1.1] - 2026-08-12

### Harness

- Canonical `.gitignore` snippet now default-ignores the whole harness dir (`<dir>/**`) and re-includes only the tracked results (AGENTS.md, knowledge/, specs/) — new process subdirectories are ignored automatically.

- Version alignment with harness **2.1.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.1.1**.

## [2.1.0] - 2026-08-12

### Harness

- Added a **`code-reviewer` role** (L2): a read-only seat for SDD per-task review and `Task category: audit` / `mstar-audit` execution. PM entry stays `/codebase-audit`; large-repo fan-out uses read-only `scout` / `explore` via Assignment `Delegation: allowed (scout/explore only, read-only)`.
- Wired `code-reviewer` into SDD per-task dispatch (named L2 reviewer id, `generic` fallback), audit routing (`mstar-harness-core`, `commands/codebase-audit.md`), engine `ROLE_MAPPING` (13→14), and the bilingual README role tables; `qc-specialist*` (L3) / QA (L4) semantics unchanged.

- Version alignment with harness **2.1.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.1.0**.

## [2.0.6] - 2026-08-10

### Harness

- Added a **host-agnostic full-flow goal rule** in `mstar-host`: any host exposing a `/goal` command (Codex Goal Mode, omp, future code agents) must set the goal to running the **complete flow to its end** — whether advancing an iteration (start → per-plan cycles → close → PR delivery → merge-ready loop) or non-iteration work (specify → clarify → plan → tasks → implement → plan QC tri + QA gate → Done) — never a sub-stage goal.
- Removed the Codex-specific `references/codex-plan-goal-mode-bridge.md`; goal text rules now live host-agnostically in `mstar-host` SKILL.md, and Codex Plan Mode reads `references/_shared/plan-mode-bridge-core.md` directly.

- Version alignment with harness **2.0.6** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.6**.

## [2.0.5] - 2026-08-10

### Harness

- `/iteration-start`: accepts an optional `direction` hint (constrains §2 candidates, seeds §3 grill-me — start stays interactive) and a `pause` flag; auto-continues into Phase 2→5 (execute → close → PR → merge-ready) after Phase 1 lock + integration branch, by default. `/iteration-drive` remains standalone for re-entry/resume on an already-locked iteration. Updated `iteration-loop` vs-commands table, README/README_CN command tables + workflow diagrams, OpenCode package quick start; added routing eval `iteration-start-auto-continue-phase2`.

- Version alignment with harness **2.0.5** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.5**.

## [2.0.4] - 2026-08-09

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **2.0.4** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.4**.

## [2.0.3] - 2026-08-09

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **2.0.3** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.3**.

## [2.0.2] - 2026-08-08

### Fixed

- OpenCode plugin entry now default-exports `{ server: MorningStarHarnessPlugin }` so helper function exports are not registered as plugins (fixes `plugin config hook failed: N.config` / `N.dispose` on startup).

- Version alignment with harness **2.0.2** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.2**.

## [2.0.1] - 2026-08-08

### Fixed

- OpenCode plugin hooks no longer abort-log on non-string `task`/`write` args: Assignment and `status.json` validators refuse non-string input before `.match` / `path.resolve`, and the `tool.execute.before` hook snapshots `prompt`/`filePath` once (avoids getter/Proxy type flips).

- Version alignment with harness **2.0.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.1**.

## [2.0.0] - 2026-08-08

### Bundled harness skills (`harness-skills/` at publish)

- **Bash SDD/rollup scripts removed (engine CLI is the documented path)**: `skills/mstar-sdd/scripts/{sdd-workspace,task-brief,review-package}` and `skills/mstar-plan-artifacts/scripts/tech-debt-rollup.sh` are deleted. Skill text now documents `mstar sdd workspace|task-brief|review-package` and the engine `techDebtRollup` import (`mstar status validate` remains the schema gate); parity tests compare engine output against stored golden fixtures captured from the byte-proven ports (slice 2).
- Added the **`@mstar-harness/engine`** package scaffold: a version-aligned workspace library (`zod` + `ajv`, `node:*` only, no `bin`) with a typed `ValidationResult` + `readHarnessVersion()` placeholder core, wired into the release surface list (10 → 11), changelog assembly, and root workspaces.
- **Engine hardening (QC fix wave, slice 1)**: lease location/orphan/dual-write verify (`lease.verify.*`) moved into `@mstar-harness/engine` (CLI `mstar lease verify` is now a thin wrapper); `archiveResiduals` gained a plan-id path-traversal guard, the status write lock, and append dedup; `withStatusWriteLock` gained an ownership guard (never removes another writer's lockdir), a `holder.pid` crash-diagnosis file, and fast-fail reentrancy detection; `readHarnessVersion` reads the module's own manifest first (published installs no longer regress to `0.0.0`); `tech-debt-rollup` parity now mirrors jq `//` exactly (`false`/`0` edges tested against the bash oracle); residual closed-lifecycle completeness (`closed_at` + `closure_note`) and plan-row `Done` ⇒ no-lease invariants added. Release prep now ensures the `@mstar-harness/engine` registry row + package-history link in root changelog heads.
- **Harness Workflow Engine positioning (iteration v2.0.0)**: unified engine-first descriptions across the 7 plugin manifests and the 4 package manifests; added `workflow-engine` / `workflow-enforcement` / `deterministic-workflow` / `harness-workflow` keywords to the root plugin manifest; re-framed README.md / README_CN.md around deterministic workflow gates enforced by a TS engine (not prompts alone) with judgment staying in `mstar-*` skills, plus a What-ships table (Harness Workflow Engine / mstar CLI / `mstar-*` skills / host adapters).

- Version alignment with harness **2.0.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.0**.

### Changed

- `beforeDispatch` Assignment lint is engine-only: local `validateAssignmentPresence` parser removed ; branch-form parsing via engine `parseAssignmentBranchForms` / `parseBranchPolicyDirectOnBranch` ; read-only roles (scout/explore) skip the branch-form + default-branch gates (qc3 F-1 / ).
- `antiRecursionPrecheck` wired into the hook: task dispatch whose role binding (`args.subagent` / `args.subagent_type`) equals the Assignment's `Execute as` warns at critical severity, warn-only (qc1 F-004 / ).

## [1.8.9] - 2026-08-07

### Harness

- **Phase 5 checkout**: merge-ready product fixes edit **directly** on the control / `spec_integration_branch` checkout; **forbid** opening a separate Phase 5 feature/fix worktree or applying Phase 2's "no product edits on control" rule. SSOT stays in `mstar-iteration` (`phase-4-5-pr-delivery` §5.0); **not** in the general `mstar-branch-worktree` skill.

- Version alignment with harness **1.8.9** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.9**.

## [1.8.8] - 2026-08-06

### Bundled harness skills (`harness-skills/` at publish)

- **`mstar-skill-authoring`**: fold the skill-writer 6 principles into the runtime authoring skill — expert process first, compact 5-question body, 1–3 skill routing, per model+harness validation, encode only model gaps, every edit as paired experiment. Body stays the executable gate; full writer loop / output template / anti-patterns → `references/skillsbench-authoring.md` (progressive disclosure).
- Tightened `description` trigger contract with exclusions; keep purpose test / frontmatter / progressive disclosure / review template as reusable SSOT.
- Reframe as **general** skill-authoring guidance (any domain/repo): drop Morning Star / `mstar-*`-only branding from body; keep minimal harness hooks (Load Order + `mstar-host` path resolve) only when working in this repo.
- Restored `## Skill-relative script and asset paths` heading so `mstar-host` § cross-reference stays valid (Post-Skill-Change stale-ref checklist).
- Keep changelog SSOT tight in `AGENTS.md`: §1 owns the fragment rule (including no hand-edit of assembled `CHANGELOG*`); Quality Gate #6 stays the executable check; remove copy-paste repeats elsewhere.

- Version alignment with harness **1.8.8** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.8**.

## [1.8.7] - 2026-08-06

### Bundled harness skills (`harness-skills/` at publish)

- Version alignment with harness **1.8.7** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.7**.

## [1.8.6] - 2026-08-06

### Bundled harness skills (`harness-skills/` at publish)

- Sync dispatch field-completeness gate: `mstar-dispatch-gates` self-check + anti-pattern, `mstar-host/references/parallel-dispatch.md` hard rule + self-check, `mstar-host/references/omp.md` Review-&-Edit example + N=1 gotcha.
- Version alignment with harness **1.8.6** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.6**.

## [1.8.5] - 2026-08-06

### Bundled harness skills (`harness-skills/` at publish)

- Sync `mstar-host` § Resolve loaded skill root + host-reference skill-root cues; `mstar-skill-authoring` anti-pattern for rules/CLI cwd paths.
- Version alignment with harness **1.8.5** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.5**.

## [1.8.4] - 2026-08-06

- **Bundled skills**: skill-relative script path naming (`mstar-sdd` → `scripts/…`) so agents resolve scripts from the loaded skill directory instead of consumer-cwd `skills/…` paths.
- Version alignment with harness **1.8.4** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.4**.

## [1.8.3] - 2026-08-05

- **Bundled skills**: omp host C5 corrected — prefer live-schema Morning Star role `task.agent` values from discovered `agents/*.md`; keep C5b skill load; update shared host-role-binding + parallel-dispatch docs.
- Version alignment with harness **1.8.3** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.3**.

## [1.8.2] - 2026-08-05

- Version alignment with harness **1.8.2** (README/host-detection docs; no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.2**.

## [1.8.1] - 2026-08-05

- **Bundled skills/commands lossless optimization** (SkillsBench principles): compact `SKILL.md` bodies + progressive disclosure — extracted Phase 3/4/5 and compound workflow to `references/`; compressed `mstar-coding-behavior` and QC review lenses; deduped anti-pattern lists, leaf-role Completion Report/Git NEVER (new `_shared/leaf-executor-core.md`), host role-binding (new `_shared/host-role-binding-core.md`) and plan-mode bridges (new `_shared/plan-mode-bridge-core.md`); slimmed 4 commands to thin boot+route+delegate orchestrators (943 → 388 lines); tightened frontmatter descriptions; `Completion Report v2` → `Completion Report`. No rule, gate, or field name altered or dropped.
- Version alignment with harness **1.8.1** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.1**.

## [1.8.0] - 2026-08-05

- **Bundled skills**: new `mstar-audit` skill + `plan-quality-bar` reference + `/codebase-audit` command (read-only advisory workflow adapted from improve).
- Version alignment with harness **1.8.0** (no OpenCode package API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.0**.

## [1.7.1] - 2026-08-05

- Version alignment with harness **1.7.1** (no OpenCode package API change; CLI omp doctor fix).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.7.1**.

## [1.7.0] - 2026-08-05

- Version alignment with harness **1.7.0** (omp host surface is added at the harness/CLI layer; OpenCode package unchanged beyond version bump / bundled skills sync).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.7.0**.


## 1.6.1

- Bundled skills/agents: **QC = code reviewer** — L3 must not run test/build/lint on shared tri-review cwd; L1/L4 own runtime evidence; `qc-specialist*` bash allowlist git-only (+ lightweight analysis).
- Version alignment with harness **1.6.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.6.1**.

## 1.6.0

- Version alignment with harness **1.6.0** (no OpenCode plugin change in this release; ZCode host surface is added at the harness/CLI layer, not bundled into the OpenCode package).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.6.0**.

## 1.5.6

- Version alignment with harness **1.5.6** (bundled skills: `Findings cleanup: zero-residual` mode).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.6**.

## 1.5.5

- Version alignment with harness **1.5.5** (bundled skills: control-path harness under default gitignore + SDD workspace `MSTAR_CONTROL_ROOT` resolution).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.5**.

## 1.5.4

- Version alignment with harness **1.5.4** (bundled skills/commands: Cursor Task flat invoke schema in `mstar-host`).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.4**.

## 1.5.3

- Version alignment with harness **1.5.3** (bundled skills/commands: frontmatter YAML quotes + `/iteration-loop` scale `XL`).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.3**.

## 1.5.2

- Version alignment with harness **1.5.2** (bundled skills/commands: process-vs-results git policy + `{SPECS_DIR}` resolve order).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.2**.

## 1.5.1

- Version alignment with harness **1.5.1** (bundled skills/commands: Phase 5 push cadence — local early fix, push only when CI/review wave idle).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.1**.

## 1.5.0

- Version alignment with harness **1.5.0** (bundled skills/commands: iteration Phase 2 worktree/lease + Phase 5 babysit-first helpers).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.0**.

## 1.4.0

- Version alignment with harness **1.4.0** (Kimi Code host support lives in shared skills / `.kimi-plugin`; OpenCode package unchanged beyond version bump).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.4.0**.

## 1.3.2

- Bundled commands: `/iteration-start` Cursor Plan path — feedback-driven plan updates; deferred grill after feedback-close; single CreatePlan URI (in-place edits only).
- Bundled skills: `mstar-iteration` §1.2 Plan UX feedback-driven + recommended branch policy; `mstar-host` Cursor Phase 1 bridge/rule.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.2**.

## 1.3.1

- Bundled skills/commands: iteration package layout — `{ITERATION_DIR}/<id>/delivery-compass.md` + sibling `guides/` / `specs/`; one-row root iteration index; legacy flat compass read-compat.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.1**.

## 1.3.0

- Bundled commands: retire `/mstar-bootstrap`; bootstrap procedure → `mstar-compound-refresh/references/project-knowledge-bootstrap.md`.
- Bundled skills: `mstar-compound-refresh` and `mstar-harness-core` short pointers for project knowledge bootstrap.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.0**.

## 1.2.1

- Bundled commands: `/iteration-start` Cursor Plan mode path — blank Phase 1 CreatePlan scaffold, staged grill-me plan updates, Build-gated Review chain.
- Bundled skills: `mstar-iteration` §1.2 host Plan UX scaffold-then-converge; `mstar-host` Cursor Phase 1 Plan mode bridge (no command-name reverse refs).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.2.1**.

## 1.2.0

- Bundled commands: add `/iteration-loop` (autonomous Phase 1→5; optional `direction` + `scale`).
- Bundled skills: `mstar-iteration` autonomous direction lock / scale budget / branch resolve + `references/autonomous-direction-lock.md`.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.2.0**.

## 1.1.0

- Bundled skills: raw QC/QA process reports default to gitignored `{SDD_DIR}/review/`; durable gate summaries and `status.json` residual findings are the tracked handoff surface. `{PLAN_DIR}/reports/` is legacy / explicit audit mode only.
- Bundled skills: iteration compass template adds `Quality Gate Summary` for iteration-level QC/QA and residual rollups.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.1.0**.

## 1.0.6

- Bundled skills: `mstar-sdd` pins L2 per-task reviewer to `generalPurpose`; forbids `qc-specialist*` at task scope.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.6**.

## 1.0.5

- Bundled skills: tiered QA gate (`qa-trigger-matrix.md`, `acceptance-gate.md`); QC/QA leaf refs under `mstar-roles/references/`; `mstar-review-qc` PM orchestration only; positive-only load lists; routing-eval v17.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.5**.

## 1.0.4

- Bundled skills: parallel writable pre-dispatch SSOT (`parallel-writable-pre-dispatch.md`); dispatch-gates dual-gate table (N invoke vs worktree); deduped skill pointers; routing-eval v16.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.4**.

## 1.0.3

- Bundled skills/commands: iteration artifact boundaries (`{ITERATION_DIR}/<id>/` workspace, specs-first start, compound workspace promotion at close); new iteration references; corpus hygiene aligned.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.2**.

## 1.0.1

- Bundled skills/commands: `iteration-drive` + `mstar-iteration` Phase 2 per-task SDD mandate; optional sticky implementer session (`resume` + ledger); thin `pm` skill shim; routing-eval v14.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.1**.

## 1.0.0

- Bundle `mstar-sdd` skill + scripts; SDD mandatory plan QC tri-review (`Execution mode: sdd`); inline/hotfix single-seat; plan template and SDD metadata fields.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.0**.

## 0.7.9

- Bundled commands/skills: Assignment plain role ids across PM templates, dispatch gates, branch-worktree, iteration commands, opencode host hygiene, and role NEVER rules — avoids OpenCode `@` auto-dispatch in harness prose.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.9**.

## 0.7.8

- Bundled commands/skills: `mstar-iteration` Phase 4–5 (PR delivery + merge-ready loop); `iteration-drive` sequences through Phase 5 with optional greploop/babysit helpers; core index and anti-patterns updated.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.8**.

## 0.7.7

- Bundled commands/skills: standalone `mstar-*` invariant; bundle `grill-me` for `/iteration-start` only; remove Context7/OpenViking/Open Design from runtime load paths; distill `open-harness-principles.md` into core and plan-conventions references; keep Role → typical topic skills matrix in `mstar-roles`.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.7**.

## 0.7.6

- Bundled commands/skills: commands–skills layering for iteration (`iteration-start` / `iteration-drive` orchestration vs `mstar-iteration` / `mstar-dispatch-gates` SSOT); hardened dispatch gates, Phase 2→3→PR transitions, canonical host dispatch (no Mode A/B/C fallbacks); Phase 1 Review & Edit chain is **sequential** product-manager → architect → writing-specialist.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.6**.

## 0.7.5

- Bundled commands/skills: explicit iteration branch policy — `iteration_base_branch`, `spec_integration_branch`, and `target_branch` required in compass/status metadata; no silent default to `main` for integration branch or PR target. Hardened `iteration-start` / `iteration-drive` gates and QC merge-base rules.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.5**.

## 0.7.4

- Bundled skills/docs: remove Superpowers runtime dependency from Morning Star guidance and host docs; assignments now rely on native mstar dispatch, worktree, plan, review, and evidence contracts.
- Bundled skills: add `mstar-skill-authoring`, delete `mstar-execution-practices`, and fold review feedback handling into `mstar-coding-behavior`.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.4**.

## 0.7.3

- Bundled commands/skills: `mstar-iteration` Phase 3 close is now an explicit gate after all plans are `Done`; close requires compass normalization when needed, compound Phase 6 knowledge indexing, roadmap update, completed frontmatter, and close checklists before PR.
- Bundled docs: README command table now includes `/mstar-bootstrap`; workflow and skill overview now match the iteration lifecycle.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.3**.

## 0.7.2

- Docs only at package level: root **0.7.2** documents CLI Cursor install layout (real git checkout at plugin path, not symlink). Re-bundle on publish if CLI dist changed.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.2**.

## 0.7.1

- Bundled commands/skills: `/iteration-start` §5 Review & Edit chain is a hard gate before integration branch commit — Task dispatch for product-manager, architect, writing-specialist; evidence is edited docs + locked compass (no iteration `reports/` artifacts). Synced in `mstar-iteration` §1.6, `pm`, `mstar-dispatch-gates`, `mstar-harness-core`.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.1**.

## 0.6.22

- Bundled skills: `mstar-dispatch-gates`, `mstar-roles` (qc-specialist-shared, dispatch-and-assignment) — replace prohibition-based anti-recursion with identity-deprivation framework. Assignment template gains IDENTITY + CAPABILITY BOUNDARY blocks before prohibitions, shifting from "I must not dispatch" (negation) to "I am a leaf executor; Task is not my tool" (capability deprivation).

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.22**.

## 0.6.21

- Bundled skills: `mstar-design-md` — add YAML frontmatter as SSOT for token values in templates and spec. Bump template format version to 0.1.0.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.21**.

## 0.6.20

- Bundled commands: `/iteration-start` §5 changed to "Review & Edit Chain" — each reviewer now directly edits documents rather than only flagging issues. PM only does the final lock.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.20**.

## 0.6.19

- Bundled skills: `mstar-coding-behavior` strengthened with distilled Ponytail principles — YAGNI gate, The Ladder (7-level decision hierarchy), "deletion over addition / boring over clever", `simplify:` marker discipline, "bug fix = root cause", and "minimal check for non-trivial logic".

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.19**.

## 0.6.18

- Bundled commands: `/iteration-start` now includes explicit `## 0. Boot` section aligned with `/iteration-drive`, loading core harness entry and PM role identity before research.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.18**.

## 0.6.17

- Bundled commands: `/iteration-drive` PR target now resolved from iteration metadata (`target_branch` in `status.json`), defaulting to `main` when not set.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.17**.

## 0.6.16

- Bundled commands: Add `/iteration-drive` command that invokes the PM Autonomous Execute driver to push all non-`Done` plans to completion (implement → QC → QA → Done loop, then optional PR to `main`).

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.16**.

## 0.6.15

- Bundled commands: New `harness-commands/` directory bundle and `loadBundledCommands()` registration in the config hook. Adds `/iteration-start` command that guides PM through iteration bootstrap (research, explore, lock, compass/plans, review chain, integration branch).

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.15**.

## 0.6.11

- Bundled agents: Cursor-first frontmatter on all role shells so hosts that share `agents/*.md` parse `name`/`description`/`model` before OpenCode fields.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.11**.

## 0.6.10

- Bundled skills: Profile B `archived/plans-done.json` schema is `{ "plans": [<plan-id>, ...] }` only; add `plans-done.empty.json` template and bootstrap/PM init notes.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.10**.

## 0.6.9

- Bundled skills: universal `pm` orchestration entry (Cursor/Codex `/pm`, OpenCode PM role switch) and Autonomous Execute driver (`status.json` backlog, `spec_integration_branch`, per-plan feature branches, host todos).

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.9**.

## 0.6.8

- Bundled skills: targeted QC re-review after fixes (owner seat only, in-place reports), short QC report basenames under `reports/<plan-id>/` (`qc1.md` …).

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.8**.

## 0.6.7

- Bundled skills: Codex Plan / Goal Mode bridge for keeping `/plan`, `update_plan`, `/goal`, and goal progress aligned with `.mstar/` SSOT.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.7**.

## 0.6.6

- Bundled skills/agents: Codex custom-agent source files, `.mstar/` harness defaults, and updated host install docs.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.6**.

## 0.6.5

- Bundled skills: Durable Roadmap Gate for staged/partial/temporary work, plus routing-eval v8.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.5**.

## 0.6.4

- Bundled skills: Cursor Plan Build resume contract and routing-eval v7.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.4**.

## 0.6.3

- Bundled skills: slim `/pm` with dispatch-first + `/pm`-only rules; PM shell pointer.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.3**.

## 0.6.2

- Bundled skills: `/pm` Autonomous Execute push (iteration driver, multi-plan); PM shell cross-reference.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.2**.

## 0.6.1

- Bundled skills: tech-debt rollup script, PM dual fullstack spread defaults, routing-eval v6.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.1**.

## 0.6.0

- Unified **`mstar-host`** in bundled `harness-skills/`; removed separate package `skills/` host path.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.0**.

## 0.5.1

### Bundled harness skills (`harness-skills/` at publish)

- Cursor Plan mode dual-write bridge (`mstar-host`, `cursor-plan-mode-bridge`, `pm`, `mstar-harness-core`); `rules/mstar-cursor-plan-mode.mdc`.

See root [CHANGELOG.md](../../CHANGELOG.md).

## 0.5.0

### Bundled harness skills (`harness-skills/` at publish)

- Align bundled assets with the 0.5.0 harness release, including Codex plugin validation fixes in shared skill metadata.

See root [CHANGELOG.md](../../CHANGELOG.md).

## 0.4.1

### Bundled harness skills (`harness-skills/` at publish)

- **`mstar-plan-artifacts/templates/`**: `status.empty.json` and `notes.empty.json` moved from `mstar-plan-conventions` (paths in skill text updated).

See root [CHANGELOG.md](../../CHANGELOG.md).

## 0.4.0

### Bundled harness skills (`harness-skills/` at publish)

- **Topic skill split**: `mstar-phase-gates`, `mstar-dispatch-gates`, `mstar-branch-worktree`, `mstar-plan-artifacts` (status/residual included); slimmer `mstar-harness-core` and `mstar-plan-conventions`.
- **`mstar-roles`**: Per-role required skill lists; host adapters updated for on-demand topic loading.
- **`mstar-plan-conventions`**: `{ITERATION_DIR}`, `{KNOWLEDGE_DIR}`, content boundaries; optional `iteration_compass` / `iteration_refs`.
- **`mstar-phase-gates`**: Prepare **`clarify` core discipline** (shared understanding, explore before asking, recommended answers).

See root [CHANGELOG.md](../../CHANGELOG.md) for full release notes.

## 0.3.2

### Bundled harness skills (`harness-skills/` at publish)

- **`mstar-plan-conventions`**: Formalize `{ITERATION_DIR}` (`{HARNESS_DIR}/iterations/`) and `{KNOWLEDGE_DIR}` (`{HARNESS_DIR}/knowledge/`); add `docs/` vs harness subtree content boundaries; optional `iteration_compass` / `iteration_refs` in `status.json` metadata.
- **`mstar-harness-core`**: Embed Prepare **`clarify` core discipline** — walk the design decision tree to shared understanding, explore the codebase before asking the user, provide a recommended answer per question.

## 0.3.1

- Align package version with monorepo **0.3.1** (see root `CHANGELOG.md` for harness and host-adapter notes bundled via `harness-skills/` / `harness-agents/`).

## 0.3.0

- Align package version with monorepo **0.3.0** (see root `CHANGELOG.md` for harness and host-adapter notes bundled via `harness-skills/` / `harness-agents/`).

## 0.2.0

- Publish OpenCode plugin with bundled repo `skills/` and `agents/` (`bundle-assets` / root `postinstall`).
- Remove cwd-based harness path resolution; consume bundled assets only.
