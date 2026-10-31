# Changelog

All notable changes to the `@mstar-harness/omp` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

## [4.1.4] - 2026-10-31

### Harness

- **Attestations are generated, not authored.** `mstar session recover`, `mstar store upgrade`, `mstar store activate`, `mstar workflow reopen` and `mstar workflow adopt-terminal` no longer require an operator-authored `--attestation <path>` document: each consuming verb now generates the operator attestation inside its own transaction from live, recorded facts — the invoking operator, the operation's durable record, the transaction clock, and exactly the session rows that transaction disposes (for the activation barrier, the executing consumer's own process facts; a Bun-driven run refuses and names the installed Node CLI as the recovery). `workflow adopt-terminal` records the generated settlement document (one stop per settled ACTIVE holder) on its receipt; `workflow reopen` generates an empty stop list because it revokes no row. `--attestation <absolute-json>` remains a 1:1 explicit override; the engine validators are unchanged and stay the acceptance authority. `store activate` gains a required `--operator`; the omp `recover` tool makes its attestation input optional.

- Version alignment with harness **4.1.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.1.4**.

## [4.1.3] - 2026-10-30

### Changed

- Version alignment with harness **4.1.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.1.3**.

## [4.1.2] - 2026-10-29

### Harness

- **Leaf-seat shell signal (#548):** a leaf/subagent session now carries its seat into the shell transport, closing the "leaf launches the CLI under the parent's ambient identity" gap for leafs that use their shell normally. The dsh plugin registers a `shellEnv` contributor exporting `DSH_MSTAR_LEAF_SEAT=1` on leaf executions (the shared `isLeafSeatHeader` predicate — one leaf rule), omp prefixes `export MSTAR_LEAF_SEAT=1;` onto a task session's bash calls, and the CLI reads either marker and attests `leafSeat: true` on every coordinator **registration** tuple it hands the engine (bind, recover, register, adopt, close, reopen and the seat-addressing reads — a leaf-permitted write such as `workflow-note.append` is deliberately left unstamped), so the engine's `coordination.leaf-seat` refusal fires on the CLI transport. Boundary: the marker is an environment channel — a leaf that deliberately strips it (`env -u`) before invoking the CLI is still indistinguishable, and non-`1` values are ignored, never a leaf claim.

- Version alignment with harness **4.1.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.1.2**.

## [4.1.1] - 2026-10-28

### Changed

- Version alignment with harness **4.1.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.1.1**.

## [4.1.0] - 2026-10-27

### Changed

- Version alignment with harness **4.1.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.1.0**.

## [4.0.9] - 2026-10-24

### Changed

- Version alignment with harness **4.0.9**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.9**.

## [4.0.8] - 2026-10-24

### Changed

- **A registered delivery-compass pointer is now admitted at registration and repairable afterwards (I-000863).** `mstar iteration register --compass-ref` and the new `mstar workflow compass-ref` resolve the named document against the harness root and store only its canonical harness-relative form; a repository-relative `.mstar/...` spelling, a pointer naming no document, an empty or unparseable compass, an invalid frontmatter field set, and a compass declaring another `iteration_id` are refused before the registration transaction opens, so no workflow row, plan row or catalog entity is published. `workflow compass-ref --workflow <id> --compass <ref> --reason <why>` repairs a pointer a wrong writer already stored: it preserves the workflow/session/plan identities, their rows and their history, replays an identical operation id and conflicts on a different reason.
- **The `phase-1-lock` readiness checkpoint names the pointer it refuses.** A row storing no pointer, a pointer resolving to another document (including the `.mstar/.mstar/...` double-join), and each authored anchor mirror that disagrees with the registered workflow now report their own diagnostic with the `mstar workflow compass-ref` repair, instead of one silent `binding-invalid`. The extension renders every distinct diagnostic and every distinct next step, not only the first.

- Version alignment with harness **4.0.8**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.8**.

## [4.0.7] - 2026-10-23

### Changed

- **A normal workflow close no longer reads as a Phase-2 authority failure.** The `mstar_phase2` extension now classifies a `coordination.workflow-not-found` probe refusal through the cleanup read: a retained terminal lifecycle returns the new `phase2.workflow-retired` code and stays silent on `agent_end`, while a genuinely unknown id, a foreign root, a stale epoch and an unreadable store keep their existing diagnostics. The retired code is the only one suppressed — the once-per-code-per-generation latch is unchanged.
- **Both refusals now name one executable action.** `checkpoint` against a retired binding says the workflow ended and points at `{operation:"export-history", workflowId}` instead of asking for a rebind that would refuse again; `bind` says the workflow ended and names `mstar status validate` for listing ACTIVE lifecycles, and the unknown-id refusal carries the same pointer.
- **Retired silence is a regression test, not a forwarding echo.** The new case drives the public route end to end — create, bind, record the report-only fulfilment, the ordinary `completed` close, then `agent_end` — and asserts no notice is sent; the unknown-id case appends a format-legal bind record and asserts the diagnostic and refusal text still appear.

- Version alignment with harness **4.0.7**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.7**.

## [4.0.6] - 2026-10-23

### Harness

- **The shipped dsh row opts in to caller session identity.** It now passes `mstar mcp --trust-caller-session-id` (omp's row already did), so the per-call `sessionId` selector is published on the dsh connection and an identity-bearing action — `plan progress`, `plan complete`, `workflow register/evidence/phase`, `session recover`, `workflow-note.append` — runs on the MCP surface instead of being pushed to the CLI. Before this, the dsh row did not pass the flag, so every such action refused with "requires an acquired runtime session identity" while the native surface covered only plan bind, audit report validation and execution clear. The flag stays the deployment's explicit statement that it owns the connection's trust boundary: a connection launched without it still publishes no selector and still refuses a supplied one.
- **On an opted-in connection the value is a bearer identity, and the docs say so.** `executionContextFor` turns `sessionId` into `context.caller`, the engine resolves the caller's OWN coordinator binding from it, and the optional `--expect` token is derived when omitted — so knowing a live session id is enough to act as that session. Authorization is that binding row plus the CAS token; no binding lookup, role check or CAS check is weakened. The ADR, both package READMEs, the bundle comment and the two host references state this instead of calling the value mere attribution.
- **Store-level commands are CLI-only.** Every `store.*` command (`init`, `upgrade`, `migrate`, `backup`, `activate`, `retire`, `execution.restore`, `execution.restore-preview`, `execution.export`) is no longer published on the MCP connection: they move or reshape the whole store, including `execution_sessions` rows whose `session_id` is a bearer identity on an opted-in connection, and that payload cannot be redacted without making a backup unrestorable. They are operator work against a checkout, not runtime work. MCP carries the runtime surface — plans, workflows, issues, ledger reads.
- **The identity-missing refusal and the `mstar schema` MCP requirement now name a route the caller can actually use**: `sessionId` on a `--trust-caller-session-id` connection (the shipped dsh and omp rows), `--session-id` or `MSTAR_HOST_SESSION_ID` on the CLI (dsh shells also export `DSH_SESSION_ID`, which the CLI reads), otherwise the native tool or the CLI. The shared sentence no longer claims `--expect` authorizes every command: `workflow-note.append` takes a `sessionRef` and has no `--expect` input.
- **A refusal no longer hands out a working identity.** `coordination.identity-mismatch` used to echo the ACTIVE holder's `sessionId` in its message, `current_facts`, `needed` and `details`; it now reports the holder's state and epoch only. Once the selector is published, that echo was a directly replayable input for a coordinator-scoped write.

- Version alignment with harness **4.0.6**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.6**.

## [4.0.5] - 2026-10-22

### Changed

- **Identity injection is decided per selected `action`, not per family tool.** A folded family publishes its `sessionId` selector ONCE for the whole tool, so the `omp` `mcp-identity` extension filled the host id into every call of a mixed family — and the CLI refuses a selector the selected action does not declare, so every non-identity action of such a family (`mstar_status` → `tech-debt`, `mstar_milestone` → `list`, …) was unusable on OMP, refused with a "drop `sessionId`" recovery the hook undid on the next call. The extension now reads the per-action answer from the published `x-mstar-selectors` index and passes a call whose action declares no selector through untouched; when the action DOES declare it, the host id still replaces any caller-supplied value. The CLI publishes that index on every family with a selector, stating exactly the accepting actions its own refusal names.
- **The `mcp-identity` extension makes the HOST session id authoritative.** It revises every eligible `mcp__morning_star_mstar_*` call to carry the calling session's native `sessionId` and REPLACES a caller-supplied value instead of deferring to it. On the opted-in connection (`mcp.json` passes `--trust-caller-session-id`) that wire value becomes the execution identity, so the former "an explicit caller-supplied id is never overridden" rule let any caller execute as another live coordinator session. The extension header, the package README and `skills/mstar-host/references/omp.md` state the new rule.

- Version alignment with harness **4.0.5**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.5**.

## [4.0.4] - 2026-10-20

### Changed

- Version alignment with harness **4.0.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.4**.

## [4.0.3] - 2026-10-18

### Changed

- Version alignment with harness **4.0.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.3**.

## [4.0.2] - 2026-10-18

### Changed

- Version alignment with harness **4.0.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.2**.

## [4.0.1] - 2026-10-16

### Changed

- `init` no longer reports success for a failed host install: a refused link, install, or build step ends with a non-zero exit that names the cause and a recovery.
- omp install is deterministic about a pre-existing plugin tree (removes a stale entry through a supported route before linking, verifies the installed version), and no longer passes a scope flag the install path ignores.
- The omp coordinator tool's session parameter uses the two-argument `record` form, so the tool schema constructs under every host shim probed.
- A dsh incompatibility refusal now names the runtime, the plugin spec, and dsh's own `allow-version` recovery instead of relaying the rejection alone.
- Version values come from `package.json` at runtime; the Bun-version gate and version-comparison tests are gone.
- `init` installs the published `@mstar-harness/cli` latest globally when a newer version than the one running is published, and warns with both versions when they differ: a cached `npx` resolution can otherwise run an older CLI, and every step of `init` — including the global install — used to follow that older version. The registry probe is bounded, skipped by `--dry-run`, and silent when offline, so it never blocks or fails an init.

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
- Added coordinator-only `mstar session run --workflow W --role coordinator [--harness H] -- <argv>`: child-local identity replaces spoofed/legacy inputs, inherits stdio and propagates exit/signal. Session recover replaces the explicitly stopped workflow coordinator under acquired identity and stop attestation.
- Plan file/ACTIVE transports remain disjoint. Current coordinator context may be derived for ordinary actions; explicit session reference/token/operation inputs remain constraints. Mixed authority or numeric ACTIVE expectations refuse before payload IO.
- `mstar workflow register` / `iteration register` publish through the atomic DB registration, `workflow evidence` records the delivery transition and `status workflow-close` performs the terminal lifecycle transition — no file close, no unregister step and no `--ended-at` rewrite survive on the active route. The closed `phase` / `lifecycle` / `execution-policy` / `integration-worktree` grammar joins the existing `mstar workflow` group.
- `store execution restore-preview` and `restore` use ordinary `store backup` images for disaster recovery; `export` reports live execution state. The staged execution migration faces (`preview`, `apply`, `activate`, `retire`, `abort`) were removed. `store activate` remains only the issue/catalog migration step.
- `status validate` reports the root and per-workflow execution tokens the active writes consume as their CAS, so a caller passes `--expect` from a read instead of inventing one.
- **A coordinator bind retry under an explicit operation id is now the recorded replay.** `bindExecutionSession` takes an OPTIONAL `expected` and resolves the workflow's current token from its own header inside the write transaction; the bind request fingerprint carries the freshness-omitted marker instead of a freshly derived token, so the unchanged retry of `{workflowId, operationId}` after the first commit's revision advance is served as the replay rather than `execution.operation-conflict`. A SUPPLIED token keeps its strict-CAS semantics: a stale value still refuses `execution.stale-token`, and the same operation id with a different supplied token stays an operation conflict.
- The host-owned `mstar_coordinator` ACTIVE `bind` forwards an omitted `expected` as omitted (the engine resolves it) and mints the operation id when the caller names none; its `recover` arm still reads the current token from the addressed authority because `recoverExecutionCoordinator` requires an explicit one. The registered tool description, parameter advertisement and the `mstar-host` OMP reference state the same contract.
- **Incompatible-store FILE recovery keeps its engine facts and loaded-module provenance.** The stored-target reader's §4.3 authority veto carries the original thrown `StoreError`, and the FILE recovery boundary projects it through the shared engine-refusal path, so a `store.schema-unsupported` refusal reaches the caller with its three schema-version facts, `loadedEntry` and the incompatible-loaded-build guidance — the same fidelity the bind / show-recovery / ACTIVE-recovery branches already provide.
- **Coordinator identity is acquired, never generated.** A fresh coordinator bind now requires an explicitly acquired session id: the engine refuses an omitted id with `coordination.identity-missing` before any write instead of minting a UUID, and `plan bind --coordinator` no longer accepts the inherited `MSTAR_HOST_SESSION_ID` as authorization. Plain local operators pass `--session-id`; managed host sessions use the new host-owned tool.
- **One adapter-only `ExecutionIdentity` type** (`packages/engine/src/session-identity.ts`): the `(canonical harness root, workflowId, role, planId, sessionId)` tuple plus `validateExecutionIdentity`, shared by engine, CLI and host adapters instead of a second per-consumer shape.
- **New host-owned `mstar_coordinator` tool** (`bind`): the extension derives the native session id from the host and the canonical control root from the host cwd, refuses leaf/scoped-plan callers, and accepts no session id, root, caller role, authority flag or credential path.
- **Retired the blanket bare-`bash` env revision.** A managed `plan bind --coordinator` attempted through `bash`/`functions.bash` is blocked before shell execution with a redirect to `mstar_coordinator`; unrelated shell calls are unchanged and an absent or unsupported `env` field no longer produces an input revision.
- Added the audited **JSON Prepare coordinator recovery** (`showPrepareCoordinatorRecovery` / `recoverPrepareCoordinator`, prerequisite contract §3.3): it replaces a workflow's recorded coordinator binding when the recorded owner can no longer authenticate — the state a cancelled host handoff leaves behind. It is deliberately NARROWER than the existing active-DB recovery (`execution-workflow.ts`), which keeps its full execution token and stop attestation: no prepared-plan takeover, no lease transfer, no raw session rewrite and no force flag.
- The write is admitted only under the snapshot write lock and requires: file authority (an active execution authority refuses and names the existing DB recovery verb), a registered RUNNING iteration in this canonical root, a committed registration, a prior envelope that still authenticates the **exact** recorded coordinator, a freshly acquired identity addressing this workflow's coordinator seat, an explicit reason + authorization reference + a stop assertion naming that holder, both fresh byte versions, and the **original** `prepareAdmission` over every row. Every semantic refusal happens before a file is created.
- The accepted effect is one role-scoped envelope through existing exclusive creation, the top-level coordinator binding replaced, one immutable `coordination.identity_recoveries` audit record appended (operation id, request digest, both public session ids, authorization reference, reason, stop assertion, both versions, time — never a credential or envelope body) and `updated_at` refreshed. Rows, branch anchors, evidence and sibling workflows stay byte-identical; the prior envelope's bytes remain as history and stop authorizing because the binding moved.
- The snapshot schema owner (`coordination-write.ts`) validates the audit strictly and the ordinary writers pin it (dropping, rewriting or forging an entry through a generic snapshot write refuses `coordination.direct-write-refused`). A crash between the exclusive envelope creation and the snapshot commit reports failure — never a success receipt — and reclaims only the exact envelope that operation created; an exact retry returns the recorded receipt without revision churn, while a changed request, a stale token or a superseded binding refuses.
- New transport: `mstar workflow recover-coordinator` (explicit operator route, exit 2 for usage, 1 for refusals) and the host-owned `mstar_coordinator` tool's `show-recovery` / `recover` operations, which derive the native session id, the canonical control root and the recorded prior holder from host/engine facts — never from the call. The public projection is §3.3's list only: the coordinator envelope/credential path stays in coordinator-owned transport, so the CLI's JSON and diagnostics never print it, and every stop-assertion entry must be a public session id (single safe path component, bounded length) before it is hashed, stored or echoed.
- Reviewed-token integrity is closed on all three seams: the recovery re-reads the compass immediately before its commit (a concurrent compass edit refuses `stale` and reclaims only this operation's envelope), crash cleanup unlinks a leftover envelope only while its bytes still equal the ones this operation wrote (a replaced path is left untouched), and a create-only generic snapshot write may not carry `coordination.identity_recoveries` at all — recovery history is provenance, not shape.
- **Identity-missing refusals name the supplies verbatim.** Every active route that refuses for a missing session identity — `plan bind` in all its forms (coordinator, identity session, sparse, resume), `plan show`, sparse plan operations, and workflow transitions/evidence/recovery — now states the exact supply paths in the refusal: CLI `--session-id` (or `MSTAR_HOST_SESSION_ID`), MCP: the host passes `sessionId` per call. The ACTIVE registration refusal was reshaped for the optional-creator contract: only `expect` and `operation` can be missing, and its text explains that an unset identity registers a NULL creator the first coordinator bind adopts.
- **`mstar doctor --target omp` now reports real plugin alignment.** The doctor's `pluginVersionNote` is fed by a new `detectPluginVersion` effect the CLI supplies from the existing per-host discovery (for omp: `omp plugin list`), so the stale-plugin guidance ("CLI X is newer than installed plugin Y — update the Morning Star plugin: omp plugin install @mstar-harness/omp") and the not-installed note reflect the actually detected version instead of always claiming no plugin was found.
- **ACTIVE registration no longer requires a session identity (issue #383c).** `workflow register` / `iteration.register` over the active DB route accept a caller with no session id and write a NULL `creator_session_id`; an explicit id is still recorded as attribution when the transport supplies one. The trust boundary is unchanged and now tested end to end from real unset-identity creation: the first coordinator bind adopts a NULL-creator workflow once, later adoption is refused once any coordinator record exists, and the creator fence plus duplicate-holder/holder-matching gates are untouched.
- `validateExecutionIdentity` gained one explicit registration-only relaxation (`allowUnsetSessionId`): the normalized empty string passes as "unset" for the create path, every other consumer keeps the acquired-identity rule.
- Reworded registration refusals to disclose state and the supported next action.
- **MCP session identity:** the `MSTAR_HOST_SESSION_ID` environment fallback has been removed from the MCP resolve path. Identity-consuming commands such as `session.recover` take the main-conversation session id solely via their explicit per-call `sessionId` input (the CLI `--session-id` flag / MCP schema field — parity that already existed); the existing fail-safe refusal when the parameter is absent is unchanged. MCP-invoked identity tests now pin the identity-gate-specific refusals, the wrong-session ownership refusal, and real CLI parse/routing.
- **Ambient environment identity no longer blocks legacy `mstar plan bind --resume`**; that route ignores ambient env and refuses declared identity (`--session-id` or host-supplied).
- Routed every registered-plan pointer through the ONE path resolver (prerequisite contract §4): `resolveRegisteredPlanFile` / `PlanPathError` are exported from the engine barrel beside `planDeclaredHeaders`, so registration, the Prepare append and later readiness share one parser instead of restating the `{PLAN_DIR}/<plan-id>.md` convention.
- `mstar iteration register` now persists the **canonical absolute** plan path in the snapshot instead of copying the caller's spelling, and the catalog registration preflight resolves and refuses an iteration row pointer **before** the first `prepared` journal row — a repository-relative `.mstar/plans/<id>.md` input is refused (received form, base, expected canonical target, permitted forms) with no root, snapshot or journal write; the normalized request is what gets hashed, stored and handed to the producer, and the shipped transport derives its default operation id from that same normalized workflow, so equivalent spellings of one target share one operation identity.
- The Prepare `appendPlans` pointer check consumes the same resolver (its private fence-aware parser is gone); the `invalid-plan` refusal vocabulary and codes are preserved and now carry the resolver's typed path detail, and a missing/non-string append pointer refuses with that code instead of escaping as a raw path `TypeError`. Standalone/audit catalog location schemas are unchanged.
- The resolver settles the pointer's **shape** before any path API sees it, so an exported-contract caller (a JavaScript caller or a decoded payload) supplying no `file`, `null`, a number or an object is refused with `plan-path.invalid-pointer` — naming the received type, never the rejected value — rather than a raw Node `TypeError` it cannot map onto its own domain refusal.
- Extended the guarded **Prepare workflow amendment** (`amendPrepareWorkflow` / `mstar workflow amend-prepare`) with the optional `correctPlanFiles` list (prerequisite contract §4.1): each entry names one existing Todo row by the **exact pointer it holds now** (`expectedFile`) and that row's own canonical plan file (`file`), repairing a malformed repository-relative pointer without a raw snapshot edit. `appendPlans` stays present — a correction-only call passes an empty append array.
- A correction moves only the addressed row's `file` (plus the ordinary `updated_at`); every other row field, the root register and the review documents survive by value. It refuses an unknown or ambiguous row, a mismatch between the row's pointer and `expectedFile`, an old pointer that does not identify that same plan, a no-op pointer, an id that collides with an append or repeats, and a corrected pointer the shared `resolveRegisteredPlanFile` refuses — all without writes, under the unchanged coordinator identity, Prepare/no-execution admission, double byte-version CAS, exact compass plan-id set and last-moment compass recheck.
- The old pointer is accepted in only two forms: one the shared resolver accepts (canonical absolute or normalized harness-relative), or the exact repository-relative spelling derived from this control root's configured plan directory and the repository root that owns it. A foreign absolute path, a same-basename guess, an unrelated directory prefix and a copied plan document with a matching header all refuse; normal registration and readiness still do not accept that spelling.
- The Phase-1 readiness checkpoint now consumes the **shared** prerequisite seams instead of its own path/base logic (prerequisite contract §4/§5): every registered plan row pointer is resolved through the ONE `resolveRegisteredPlanFile` resolver (the same one registration and the guarded Prepare correction use, including a `.mstarc`-declared or external `{PLAN_DIR}`), and the coordinator identity verdict is read through the engine's own read-only `showPrepareCoordinatorRecovery` view.
- Refusals keep the frozen broad codes callers depend on (`binding-invalid`, `prepare-not-locked`, …) and now carry a typed **diagnostic** that names the §5 subreason, the subject, the safe identity-source label, the public ids already in play, the canonical base/target of a plan pointer and the next supported operation. Identity detail distinguishes `identity-missing`, `identity-mismatch`, `foreign-owner`, `recovery-not-prepare`, `recovery-stale` and `recovery-unauthorized`; path detail distinguishes `plan-pointer-invalid`, `plan-identity-mismatch` and a genuinely `prepare-unlocked`.
- A stale stored pointer (the pre-contract `.mstar/plans/<id>.md` spelling) is therefore never rendered as an unlocked compass: it keeps its own path detail, and readiness never normalizes or repairs the row — the guarded Prepare plan-file correction remains the operation that repairs it.
- The registered model-handoff tool forwards those diagnostics verbatim into its `not-ready` details and names the typed reason and the next supported operation in the refusal text. Diagnostics render public ids, codes and canonical plan pointers only: never an envelope path, credential, session JSON or environment payload. A refused plan pointer is therefore classified by its **received form** (canonical absolute or harness-relative) instead of the value it held, and a receipt/row disagreement reports only the canonical expectations — a malformed stored row can no longer project an arbitrary absolute path.
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
- **Iteration registration now records `phase-1-prepare` and stores a harness-relative `compass_ref`**: the producer normalizes an absolute in-root spelling to the contract form and refuses pointers that escape the harness root (symlink-safe), so every newly registered workflow is amendable by construction.
- **Prepare commands recover legacy snapshots instead of dead-ending**: `workflow show-prepare` reports derivable state (`derived`) when the phase label is absent or the stored compass pointer is absolute-but-in-root, and the next `workflow amend-prepare` adopts both in its ordinary locked write — a present non-Prepare phase is still refused, never rewritten, and real execution facts (leases, non-`Todo` rows) keep refusing first.
- **Phase 1 writes land only in the gitignored iteration package**: the §2.3 integration-worktree checklist step 7 (reached through `iteration-start` §6) now pushes only the newly created `spec_integration_branch` (`git push -u`; the branch tip stays at the recorded base, satisfying the `phase-1-lock` readiness check that the pushed remote tip equal the live integration HEAD — enforced by the omp model-handoff runtime). Phase 1 roles write compass / plans / the `<iteration-id>/` package (specs in `<iteration-id>/specs/`) — all default-gitignored local artifacts; the global `{SPECS_DIR}` is written at Phase 3 iteration-close promotion — compound-rewritten **directly into the integration worktree's tracked `{SPECS_DIR}`** (`{KNOWLEDGE_DIR}` promotion follows the same integration-worktree write; the primary checkout carries only gitignored process artifacts) and committed into the integration branch by the §3.5 close commit — with the existing registration surfaces completed in the same step: package `Promoted to:` annotation, plan `primary_spec` / `spec_refs` + compass references, and catalog `register` / `link` (the registered path resolves against the integration worktree during close and PR review, and against every checkout after merge). Renamed the `iteration-start` / `iteration-loop` pre-commit checklists to pre-integration checklists (loop's `phase-1-autonomous-start` todo now completes on compass lock + integration-branch push), rescoped the §1.6 chain and writing-specialist corpus hygiene to the iteration package (`iteration-artifact-boundaries.md` / `iteration-corpus-hygiene.md` updated to the same boundary), and dropped the stale Phase-1 "commit" from the plan-mode bridges (`_shared/plan-mode-bridge-core.md` gate + anti-pattern row, `cursor.md` Phase-1 Plan-mode gate, `cursor-`/`omp-`/`kimi-`/`zcode-plan-mode-bridge.md`).
- **Prototype-first preparation:** interactive Phase 1 revises a retained plain-language visual HTML until the current design is explicitly approved before formal artifacts; autonomous opt-in retains an appropriate HTML/Markdown/JSON prototype for planning and traceability without routine human confirmation.
- **Selected specialist review:** PM reuses prototype contributions and selects product-manager/architect by remaining gaps; actual selected reviewers run sequentially with mandatory writing-specialist last, and OMP readiness accepts their ordered completion receipts.
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
- **L1 worktree ownership:** ignore a row claiming the recorded main-worktree branch when checking residency and identify the owning workflow and plan for real ownership conflicts.
- **Plan preparation:** refuse to use the control checkout's current branch for any plan row, including report-only workflows, and fail closed when that branch cannot be resolved.
- **L1 worktree checks** now derive workflow, plan, lease, and lifecycle-branch inputs from the ACTIVE execution authority graph instead of retired snapshots and sibling scans.
- **Sibling worktree root**: moved the default for feature/L2 worktrees and `pr-review worktree-setup` to `<parent>/<repo>.worktrees/`, outside the checkout. The repository root is the realpath of the Git top-level; in-repo `.worktrees/` remains a legal manual/override location. Removed the default setup's `.git/info/exclude` append, which is obsolete outside the repository.
- **Convention alignment**: updated the skills and `AGENTS.md` to teach the sibling-root convention, keeping linked checkouts out of the repository scan/edit surface and permission guidance independent of cwd or unverified glob semantics.
- Added an **executor-side worktree checkout gate**: when an Assignment carries `Worktree path`, leaf roles must `cd` there and verify the checkout root with `git rev-parse --show-toplevel` before the first repo write or commit, and disclose `Worktree path used` (absolute) in the Completion Report — closing the gap where subagents inherited the primary checkout and wrote product files into it.
- Updated `mstar-branch-worktree` (可写角色执行规则 + 回报要求), the shared `mstar-roles/references/_shared/leaf-executor-core.md` Git NEVER block, and the `frontend-dev` / `ops-engineer` role files to match the existing `fullstack-dev-shared.md` instruction.
- Fixed worktree cleanup attribution after stopped and failed (cancelled-terminal) registrations are superseded: the terminal owner no longer makes a shared worktree/branch appear foreign. The real-store dry-run now plans the merged worktree for removal; branch deletion remains deferred until the worktree is removed and cleanup is replanned.
- **Safer worktree cleanup ownership:** Completion retains the plan's exact branch and worktree path after lease release. Cleanup can also recover a claim from a valid completed Done-row handoff; degraded parseable snapshots preserve handoff resources as protective, nonterminal metadata but never authorize removal. Unreadable snapshots withhold removals unless explicitly ignored. Applying cleanup re-plans after deferred integration worktrees are removed before deleting newly-unchecked-out branches. Ambiguous ownership still refuses removal.
- **Ignored-content cleanup:** Ignored-only files no longer make a worktree dirty for cleanup. Applying an eligible removal deletes those ignored files without a Git recovery backstop; tracked changes and non-ignored untracked files still block removal, and cleanup never forces it.
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

- Version alignment with harness **4.0.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **4.0.0**.

## [3.11.2] - 2026-09-19

### Harness

- Moved the **coordinator model-handoff arm to the direction lock**: a new iteration now arms `@slow` once the direction is locked and **before** the Phase 1 draft is written, instead of after workflow registration — so the arm always takes the unregistered reservation path, which is the expected state for a new iteration (no register row, no snapshot, no compass) and never a reason to defer the call. No arm/fire logic, refusal code, authority derivation or tool schema changed.
- Renamed the shared new-iteration anchor `iteration-entry` → **`direction-lock`** and moved its carrier to the §1.2 tail: the anchor now fires once the direction is locked and before the compass/plans draft is written, and the three Phase 1 entry routes bind it at that boundary — the interactive route in its own step between the lock and the draft, the autonomous and host-Plan routes through their pre-commit checklists.

- Version alignment with harness **3.11.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.2**.

## [3.11.1] - 2026-09-18

### Harness

- **Host session identity now reaches the engine on OMP**: the `@mstar-harness/omp` model-handoff extension revises every `bash` tool call of its session to carry the host session id in `MSTAR_HOST_SESSION_ID` — overwriting any caller-supplied value under that name, `bash` only, nothing injected for a host session with no id, and no engine or harness write, notice or state — and a fresh `mstar plan bind` resolves its identity **`--session-id` → `MSTAR_HOST_SESSION_ID` → the engine-generated id** — the injected variable is the fallback (trimmed; empty or whitespace-only counts as absent) — so the engine session id and the host session id are one identifier for the readiness and start-authority comparisons. The generated default and every comparison are unchanged: an absent or foreign association still refuses (the readiness `binding-invalid` code, the existing start-authority codes), and `--resume` never re-identifies — it refuses `--session-id` as a usage error.
- **`bindPlanSession` adopts a caller-supplied `sessionId`** on both fresh-bind variants (coordinator and plan scope), keeping `randomUUID()` when none is supplied. The id names the session envelope's file, role-scoped at `{WORKFLOW_DIR}/<workflow-id>/sessions/<role>-<session-id>.json` (`<role>` ∈ `coordinator` / `plan-pm`) — so one host session may hold the coordinator envelope and a plan-pm envelope of one workflow under the same shared id — and is therefore validated as a single safe path component (non-empty, no separator, not `.`/`..`, at most 128 characters) and refused with the new, additive `coordination.invalid-session-id` before any write; a re-used id is still refused by the exclusive envelope creation with the existing `coordination.session-mismatch`.
- Updated `skills/mstar-host/references/omp.md` with the anchor-side session-identity association contract.

- Version alignment with harness **3.11.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.11.1**.

## [3.11.0] - 2026-09-18

### Changed

- Made `mstar_model_handoff {operation:"start"}` reachable for an already-registered, own, not-yet-armed workflow: the extension now selects the reservation or attachment branch from the validated root register itself, while coordinator authority stays derived solely from host/engine facts (`deriveStartAuthority`). A foreign coordinator of the named workflow now refuses with `already-bound` on the attach path; every other refusal code and the unregistered reservation path are byte-identical.
- Aligned all model-handoff coordinator notices with the shared Morning Star title shape: status-bearing titles state the observed workflow id and status from its own snapshot; snapshot-free sites (suspension, start refusal, in-flight navigation refusal) use a fallback title that asserts no workflow status. `mstar:model-handoff-notice` and `mstar:model-handoff` literals are unchanged.
- Documented the producer of the prepared Assignment in the OMP host reference: the `reserve-launch` admission clause and the optional transport section now name **`mstar plan prepare`** as the coordinator step that writes `coordination.prepared` and its pinned `coordination.prepared.assignment_path`, define the transport placeholder as that absolute path, add an ordered summary of the extra-primary route (registered `Todo` row → existing feature worktree → coordinator bound → prepare → `reserve-launch` → the journaled record-before-side-effect transitions and pane/start/submission sequence), and state the admission windows — row admission closes with Phase 1 (earlier once any row starts preparation or execution), while an already-registered eligible row may still be prepared during Phase 2.
- Added the host-agnostic precondition to the scoped-plan PM transport note: a conditional extra-primary launch is available only for a plan row the coordinator has already registered and prepared, and whose feature worktree exists — a row that does not yet exist cannot be launched, because row admission closes with Phase 1.
- Added the **six-item scoped-route dispatch checklist** to the OMP host reference's optional transport section: a fresh target session, a prepared (not merely registered) row, handover content frozen before preparation with only the Assignment hash re-checked at bind (`coordination.assignment-stale`), a single initial submission, readback-confirmed execution with single-key recovery only, and post-bind steering — bounding *exactly once* to the initial command. The trailing-Enter behavior stays a field observation of a transport CLI this repository does not own.
- Named the **supported cross-session dispatch path** in the shared dispatch gates: concurrency across separate primary sessions or terminals has exactly one supported form — the scoped route with a prepared Assignment as a fresh session's first instruction; a coordinator-authored leaf Assignment sent through a terminal prompt is unsupported because it bypasses scoped boot, lease ownership and handoff.
- Reshaped the **OMP diagnostic notices** onto one shared title shape (`packages/omp/src/notices.ts`): a status-bearing title states the observed workflow's `id` and `status` verbatim from a successfully read snapshot, and a fallback title names the observed condition while asserting no workflow status. The Phase-2 adapter now carries the typed observed id/status through its internal probe/sampling/diagnostic path instead of emitting the fixed `Phase-2 observation inactive` prefix, keeps the refusal code in the detail, and preserves the one-diagnostic-per-code-per-generation bound. The notice custom-type literals are declared only in the shared module.

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

- A reused coordinator session can arm `@slow` for a later workflow after the previous model-handoff binding is terminal; the post-await concurrent-arm check no longer treats every historic record as an active binding.
- The Phase-1 fire path re-reads the session ledger after every await and refuses to invoke `setModel` when an observation handler already terminalized the pending record.
- Phase-2 native-delivery suppression samples settled job ids at `agent_end` before marking them consumed, so a tool-using coordinator turn does not emit a duplicate `triggerTurn` follow-up after the host already delivered the completion.
- Added the opt-in **coordinator model handoff** to `@mstar-harness/omp`: a new extension entry (`extensions/model-handoff.js`, published through manifest `omp.extensions`, engine inlined, its single host import resolved by the running host) plus native plugin settings `modelHandoff` (off by default) and `handoffTarget` (`@default` \| `@smol`). A **new** Morning Star iteration start in the bound coordinator session arms `@slow` before substantive Prepare, and a complete Phase 1 — specialist returns, locked Prepare, distinct matching integration checkout, verified required push — switches that one session to the saved target once. Ordinary chat, leaf and plan-scoped sessions stay inert; no role mapping, goal objective or workflow state is written, and a manual model change while the switch waits cancels it for that session only.
- Pinned the package's OMP host contract: optional peer and development dependency `@oh-my-pi/pi-coding-agent@18.2.1`, Bun floor `>=1.3.14`, and a `bundle-smoke` case that unpacks the published tarball and drives it through the host's own plugin discovery, extension loader and custom-tool loader in a disposable host root with no engine package installed. It replaces the previous source-text bundle assertions (emitted symbol, no bare engine import) with that runtime behaviour.
- Documented the native `/settings` → Plugins path, persistence and its user-scope limitation (a project-only install has no native settings row), supported entries and modes, coordinator binding, full-Phase-1 readiness, cancellation, replay and failure semantics in the OMP host reference and the package README.
- **Phase-2 native-delivery silence**: the reminder pass now consumes exactly the terminal job ids the decision sampled, instead of re-reading the async-job snapshot after the decision. A job that settles while the settings read is awaited can no longer be marked consumed without ever taking part in native-delivery suppression, which previously allowed a redundant reminder for an already-delivered completion.
- Added a `phase2Seams.readSettings` test seam and regressions covering settlement inside the settings-await window (no double reminder, no silent swallow) and the unchanged bounded reminder for a non-delivered change.
- Added opt-in **Phase-2 plan instances** to `@mstar-harness/omp`: a new extension entry (`extensions/phase2-orchestration.js`, published through manifest `omp.extensions`, engine inlined, its one host import resolved by the running host) plus native plugin settings `phase2PlanInstances` (off by default; gates **extra primary launches only**) and user-configurable `maxPlanInstances` (positive safe integer, default 2, minimum 1, no ceiling of 2; a malformed present value fails visibly and authorizes no launch). A Phase-2-only coordinator session gets at most one bounded advisory per **changed** opportunity observation — the observation key is recorded before the message, identical unchanged state never re-fires, there is no timer or polling, and native completion delivery stays authoritative.
- Added the `mstar_phase2` bookkeeping tool with its local transport-intent journal (`<workflow dir>/omp-launches.json`, version 1): `bind` (the coordinator's first Phase-2 host action), `checkpoint` (acknowledges the shared rescheduling checkpoint against the sample taken then, with the frozen five reasons), and `reserve-launch` / `record-launch` — strict `reserved → starting → created → submitting → submitted` transitions, each persisted **before** its pane / OMP-start / prompt side effect, with occupancy counted once per plan id as owned pending intents ∪ active plan primaries against the latest cap, and `refused` / `uncertain` never blindly retried. Compiled code admits and records only: it never spawns, merges, rewrites workflow state or releases leases.
- Documented the native `/settings` → Plugins path (with its user-scope limitation — a project-only install has no native settings row), the launch-only opt-in, capacity semantics, the explicit bind/checkpoint/intent call sequence and the optional skill-driven Herdr/tmux transport in the OMP host reference, the package README and the scoped-plan PM transport note: prerequisite gating (skill actually present and read + CLI + matching managed environment; tmux stays unavailable while no tmux skill exists), non-focus pane creation at the prepared worktree, verbatim returned opaque targets, one absolute `/iteration-drive --assignment` submission with no coordinator credentials, and terminal handling of `agent_not_ready`, a timeout or a stalled submission. Transport evidence is explicitly marked simulated, not native E2E.

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

### Changed

- Unify active lifecycle branch checks across hosts, retain parallel track ownership, bound SDD Git probes, and preserve integration-cwd workflow selection.

- Version alignment with harness **3.9.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.9.0**.

## [3.8.3] - 2026-09-12

### Changed

- Version alignment with harness **3.8.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.3**.

## [3.8.2] - 2026-09-12

### Changed

- **dsh docs**: the package README now documents the recommended `workflowNames` allowlist for the native read-only fan-out path on dsh — `mstar-qc-tri` (plan QC tri), `mstar-audit-fanout` (large-repo `/codebase-audit`), `mstar-pr-seats` (`/amazing-pr-review deep`) — with the production-overlay note in the same place: with the shipped empty allowlist every name is *unknown*, which the default `workflowGate: 'warn'` turns into one survivable `workflow.name.unknown` advisory; a deployment that also wants unknown names vetoed sets `workflowGate: 'hard'` in the profile layer. No default changed — `workflowGate` stays `'warn'` and `workflowNames` stays unset (operator overlays, never mstar defaults).
- **dsh read-only fan-out (docs)**: `skills/mstar-host/references/dsh.md` gains the **Read-only fan-out via the `workflow` tool** section and `references/dsh-workflow-scripts.md` ships the copy-pasteable `script` + `meta` templates for the three names; `commands/codebase-audit.md` and `commands/amazing-pr-review.md` carry the dsh-conditional sentence (slash → native `workflow` tool → conversation `workflow-run` node, other hosts unchanged), and `skills/mstar-sdd/SKILL.md` notes the plan QC tri MAY run through the qc-tri script while per-task implementers stay serial `subagent`.

- Version alignment with harness **3.8.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.2**.

## [3.8.1] - 2026-09-11

### Changed

- Version alignment with harness **3.8.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.1**.

## [3.8.0] - 2026-09-10

### Changed

- Version alignment with harness **3.8.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.8.0**.

## [3.7.3] - 2026-09-10

### Changed

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

- **ZCode coordination-write gate**: new engine-backed PreToolUse (`Write|Edit`) process hook `hooks/mstar-write-gate.mjs` — hard-enforced repos block writes to harness coordination documents (status.json, workflow snapshots, project registers) with exit 2 plus an actionable stderr reason (stdout stays empty); soft-mode and non-harness writes pass silently; disable per session with `MSTAR_WRITE_GATE=off`.
- **Edits validate the reconstructed post-edit result (ZCode host)**: deterministic Edits (`old_string` + `new_string` with a unique match, or `replace_all`) are validated against the reconstructed content instead of the pre-edit on-disk state — a deterministic corrupting edit now blocks under hard enforcement; ambiguous or non-reconstructible edits keep the pre-edit fallback.
- **Oversized coordination docs are now a violation on the ZCode host**: content or on-disk targets beyond the 2 MiB validation budget yield `status.oversized` (hard-mode block naming the escape hatch instead of a silent pass; omp keeps the default silent pass).
- **omp hook lazy loaders removed (versioned divergence)**: the engine is inlined at build, so a stale engine dist now fails the omp build instead of silently degrading; Gate-1 block/pass decisions and reason strings are unchanged (golden fixture matrix).

- Version alignment with harness **3.7.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.1**.

## [3.7.0] - 2026-09-08

### Changed

- Version alignment with harness **3.7.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.7.0**.

## [3.6.3] - 2026-09-06

### Changed

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

### Changed

- Version alignment with harness **3.6.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0**.

## [3.6.0-alpha.4] - 2026-09-03

### Changed

- Initial `@mstar-harness/omp` package: the omp hook + six `mstar_*` tools (moved from the repo root) bundled with the engine **inlined**, plus `skills/`/`commands/`/`agents/` mirrors — `omp plugin install @mstar-harness/omp` works without any local build.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.4**.
