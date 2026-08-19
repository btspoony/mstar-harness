# Changelog

Chinese summary: [CHANGELOG_CN.md](CHANGELOG_CN.md).

All notable changes to this repository are documented here. Published harness surfaces are at **2.4.1** unless noted:

| Surface | Package / manifest | Version |
| --- | --- | --- |
| Monorepo root | `morning-star` (`package.json`) | **2.4.1** |
| CLI | `@mstar-harness/cli` (`packages/cli`) | **2.4.1** |
| Engine | `@mstar-harness/engine` (`packages/engine`) | **2.4.1** |
| OpenCode plugin | `@mstar-harness/opencode` (`packages/opencode`) | **2.4.1** |
| Cursor plugin | `.cursor-plugin/plugin.json` | **2.4.1** |
| Codex plugin | `.codex-plugin/plugin.json` | **2.4.1** |
| Kimi plugin | `.kimi-plugin/plugin.json` | **2.4.1** |
| ZCode plugin | `.zcode-plugin/plugin.json` | **2.4.1** |
| omp plugin | `.omp-plugin/plugin.json` / `.claude-plugin/plugin.json` | **2.4.1** |
| Agent Plugins manifest | `plugin.json` | **2.4.1** |

Package-specific histories: [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md), [`packages/opencode/CHANGELOG.md`](packages/opencode/CHANGELOG.md), [`packages/engine/CHANGELOG.md`](packages/engine/CHANGELOG.md).

## [Unreleased]

## [2.4.1] - 2026-08-17

### Harness

- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.7` line (`^0.1.0-rc.7`; `@deepseek-ai/cordis` stays `^4.0.1`). Local rc.6→rc.7 source review of consumed seams found no adapter-code break (`createUserMessage` / `ToolExecution` / `PreToolDecision` / `PreStepDecision` / `FsWriteIntent` / dump-config `disabled: true` unchanged; `apps/cli/src` version-only). Lock purged every entry below `0.1.0-rc.7` — 62 unique `@deepseek-ai/dsh-*` packages, single hoisted copy each, 0 nested copies. Root `dependencies` stays engine-only.
- **README readability**: Install Command cells wrap with `<br>`; `npm i -g @mstar-harness/cli` is a standalone fenced command; Iteration / Codebase audit tables use **Command** (full signatures) and wrap **When**.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.4.1**.

## [2.4.0] - 2026-08-17

### Changed

- **dsh install target**: `npx @mstar-harness/cli init --target dsh` now installs the full dsh capability in one command — it runs **two independent** `dsh plugin --profile web add` calls (`@mstar-harness/dsh` first, then `dsh-llm-fallbacks`; never folded into a patch file). `doctor --target dsh` reports each plugin row as `uninstalled` / `disabled` / `mounted` and exits non-zero on any uninstalled or disabled row. `--no-fallbacks` (dsh target only) skips the `dsh-llm-fallbacks` row; `--dry-run` previews without probing or executing; re-runs are idempotent (already-installed rows skipped). README pair, `INSTALL.md`, and `docs/cli.md` updated.
- **CLI `mstar` bin alias**: `@mstar-harness/cli` now installs a second executable, `mstar`, alongside the canonical `mstar-harness` — both map to the same `dist/mstar-harness.js` entry, so the two names are interchangeable (pinned by a new manifest test). `commands/` citations now use `mstar-harness` (version-proof: the long name exists in every released version; the short alias ships with this release), and `docs/cli.md` plus the README pair note the alias. **Caution**: `mstar` is a shared bin namespace — an unrelated third-party npm package named `mstar` claims the same command name, so bare `npx mstar …` only resolves to this CLI where `@mstar-harness/cli` is installed; keep the canonical `mstar-harness` in scripts and use the long name on any collision. Existing global installs obtain the `mstar` shim on their next upgrade: `npm i -g @mstar-harness/cli@latest` (or the bun equivalent) re-links all declared bins.
- **Drift-lint bin-prefix guard**: `validation:drift` now checks the binary prefix of every backticked CLI citation in Engine-check callouts against the declared `bin` names from `packages/cli/package.json` (the manifest is SSOT), so citing a nonexistent executable (e.g. a typo like `mstarr`) fails drift-lint instead of silently passing while the subcommand paths validate.

### Harness

- **dsh full support (docs)**: the `packages/dsh` README triple's Install section now documents the one-command CLI entry (`init --target dsh` — the two `dsh plugin --profile web add` installs, orchestrated) and what a user gets zero-config once both rows are installed: the 13 `mode: subagent` mstar role seeds with mirror-default personas (revertible in settings; runtime advisory reports overrides), plus a fresh-publish `minimumReleaseAge` window note (re-run init or pin the version). The installed-deployment e2e closes the loop: a real CLI install into a temp `DSH_HOME`, booted from the installed artifacts, asserts all 13 roles seeded with non-empty personas. Root README pair adds the dsh full-support one-liner.
- **Five-question lint runtime mode**: `lintFiveQuestion(body, mode?)` now supports `mode: "runtime"` (default `"authoring"`, non-breaking) with a locked `RUNTIME_HEADING_ALIASES` table — heading synonyms (e.g. `process`/`playbook` for Workflow, `hard rules`/`门禁` for Decision Rules, `output format`/`证据` for Evidence, `dependencies`/`关系` for References) that count as the canonical sections for shipped topic skills. `mstar skill lint` selects runtime mode for `mstar-*` skill dirs except `mstar-skill-authoring` (always authoring/strict); `mstar-harness-core` prints an explicit **exempt** row for the five-question checklist. Greenfield (authoring) lint still demands canonical headings.
- **Runtime corpus alignment**: 15 shipped `mstar-*` topic skills gained minimal annotations/thin sections (Evidence ×13, Workflow ×9, References ×6, plus `mstar-host`'s load-order/decision-rules gaps) derived from existing material — every runtime skill now passes runtime-mode five-question lint; `mstar-audit` needed zero edits. `skills/mstar-skill-authoring/SKILL.md` documents the alias map (runtime-mode semantics stay SSOT: aliases exempt mechanical lint, not content).
- **drift-lint Guard 5 (five-question corpus smoke)**: `bun run validation:drift` now loads every shipped runtime `skills/mstar-*/SKILL.md` (excluding `mstar-harness-core` and `mstar-skill-authoring`), strips frontmatter, and runs `lintFiveQuestion` in runtime mode — deleting a Step-3 aligned heading or losing runtime alias coverage fails CI (audit finding 5).
- **`mstar-skill-authoring` strict self-lint**: the fence-aware heading scan exposed the standard's own `SKILL.md` as a fence false-green (five-question coverage came only from the `## 默认 Body 结构` template code fence), so real `## Workflow` / `## 6 条作者原则（Decision Rules，必须遵守）` / `## 验证门控（Evidence，原则 4 + 6）` sections now answer the five questions honestly and `mstar skill lint skills/mstar-skill-authoring` passes strict (authoring) mode.
- **Fail-loud fragment validation**: `scripts/prepare-release.ts` now validates each changelog fragment's `packages:` tokens against the release-surface enum (`root | cli | opencode | engine | dsh`). A typo'd or unknown token (e.g. `clii`, `scripts`) previously matched no changelog target and silently dropped the fragment's bullets from every changelog; release prep now prints one error line per bad token to stderr and exits 1 before any changelog mutation or fragment archival. `validateFragmentPackages` is exported for tests.
- **`mstar roles validate`**: new CLI command exposing the mstar-roles skill-dir checks — a thin mirror of the dsh seam `validateRolesState`: `validateRoleMapping` on the roles dir plus `lintLoadOrder` over every sibling `mstar-*` skill, with unreadable siblings skipped best-effort. Defaults resolve through the project-root path resolution (`--roles-dir` → `skills/mstar-roles`, `--skills-dir` → its parent); exit 0 prints OK + counts, violations exit 1 with one row each. `skills/mstar-roles/SKILL.md` engine-check callout now cites the CLI command.
- **drift-lint Guard 4**: roles/load-order corpus guard in `scripts/drift-lint.ts` (plan 003 Task 2) — `lintLoadOrder` over every `skills/mstar-*/SKILL.md` text (each must declare `mstar-harness-core` in a Load Order / First action section) plus `validateRoleMapping` on `skills/mstar-roles` (mapping / parameter tables must resolve against the on-disk `references/*.md` layout); CI drift-lint now fails on role-table or load-order regressions.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.4.0**.

## [2.3.0] - 2026-08-16

### Harness

- **SDD fix-round mechanics**: `mstar-sdd` gains four mechanical rules for PM fix-wave dispatch and close-out — an **unverified round counts** (a fix round without verification evidence — reviewer not confirmed / report not on disk — is not clean; re-check and count the round, never enter the convergence branch), **full re-entry** (the next fix dispatch carries all open findings, including last round's unverified items; never slice a subset), **capped cross-round excerpt** (from round ≥2 the dispatch brief carries an excerpt of prior rounds' findings and dispositions — advisory ~500 words/round, ~1500 total, suggested values not hard limits), and **honest non-convergence** (open findings at wave close are listed in detail with an explicit re-feed-to-next-round or transfer-to-residual disposition — never silently closed). Folds Candidate C5 into `mstar-sdd` SKILL.md "After all tasks" + `references/file-handoffs.md` cross-reference (the per-task fix loop applies the same mechanics).
- **Residual fail-loud handoff contract**: `mstar-plan-artifacts` `status-and-residuals.md` now requires findings to pass engine validation before R# registration — `validateResidual` per entry and `validateStatus` for the whole file; malformed entries (non-object, missing any of the nine required fields id/title/severity/source/scope/decision/owner/target/tracking, or severity outside the enum) are **rejected** — fix and rewrite, never silent pass-through, downgrade-write, or write-then-patch. Folds Candidate C6; the architect-verified D-3 branch (covered-but-untested) is closed by backfilled non-object rejection regression tests in `packages/engine` at both the `validateResidual` level and the `validateStatus` aggregate level (engine suite 658 pass / 0 fail) — zero source diff, no new public API.
- **CLI `dispatch validate` non-ASCII literal fix**: bun-executed CLI bundles misdecode raw multi-byte UTF-8 in regex/string literals, so a legal `Branch policy: direct on main — <reason>` (em-dash) was reported as two false violations. Source literals across 20 `packages/engine` + `packages/cli` src files are escaped to `\uXXXX`, a post-build dist escaper guarantees bundle-level ASCII (bun build re-normalizes string escapes), a bundle-smoke regression test covers em-dash + ASCII separators, and `bun run lint:ascii-literals` plus a CI step guard against recurrence. The guard covers `packages/engine` + `packages/cli` source and the CLI dist bundle; the opencode dist bundle is not wired to the escaper — it is not run as a large bun bundle.
- **Regression-fixation paired-evidence reference**: new `mstar-skill-authoring/references/regression-fixation.md` — real artifact as test subject (built bundle / command sequences, not a source import), mock host hooks, dual-path assertion consistency, and fix solidification (reproduce → FAIL → fix → PASS → into the regression set); zero external dependencies, explicitly an optional heavy weapon (default stays P6 before/after + application case). SKILL.md gains the References pointer and syncs its verdict enum to the 4-value SSOT (Approve | Request Changes | Needs Discussion | Unconfirmed).
- **Dataflow-directed debugging protocol**: `mstar-coding-behavior` §4 Debugging gains a compact diagnosis procedure — map the data flow before judging (input → processing → storage → output, who writes/reads at each step; a bug is a state deviation from expectation at a flow point), four verifiable cross-checks (re-run the repro / log comparison / input-output comparison / dual-path comparison — a hypothesis that cannot be verified on the spot is not a conclusion), and falsify the fix (after fixing, re-run the original repro and compare with expectation; report "verification failed" explicitly instead of pretending success) — cross-referencing, not restating, the existing root-cause and repro-test bullets.
- **QC report evidence contract + `Unconfirmed` verdict**: `qc-specialist` report-template findings entries now require `Verification` + `Expected vs observed` on every severity class — Critical/Warning may use the four cross-checks (or a `diff/read/grep` anchor), Suggestion is `diff/read/grep` anchor only — backed by two hard rules (no verifiable cross-check → do not report the finding; a failed evidence channel is not "no problem" — mark the affected scope **Unconfirmed**); the verdict enum gains `Unconfirmed` for evidence-channel failure; `deep-review-lenses.md` now requires every lens finding to carry a diff/read/grep anchor + expected vs observed (no anchor, no report).
- **Audit red-team attack pass before vet**: `mstar-audit` Phase 3 gains an attack sub-step before the human vet — take the top candidate findings (by leverage; count scales to finding volume) and run a three-way attack on each (counter-example / simpler explanation / evidence verifiability); survivors pass to vet unchanged, refuted findings are dropped and recorded in the index's "considered and rejected" section (`- <finding>: not worth doing because <one line>`), hallucinated claims surfaced by the attack are discarded and logged as red-team record lines (never into the findings table, and they do not occupy a "considered and rejected" slot), and findings the attack did not reach are treated as unreviewed and kept for vet — with a one-line boundary reference to the vet step (the attack decides whether a claim stands on its face; vet keeps open-cited-code confirmation and by-design / mis-attribution / duplicate disposition).
- **QC consolidated coverage semantics + `Unconfirmed` propagation**: `mstar-review-qc`'s PM consolidated section now requires — unmentioned = unreviewed (a finding / severity item / claim not raised by any seat must be marked `unreviewed` and routed to targeted re-review, never silently treated as covered); zero injection at the consolidation layer (every consolidated entry must trace to a `qcN.md`; the PM's own observations go to a separate Status Update); and any seat verdict `Unconfirmed` → the gate decision must not be `Approve` until the evidence gap is closed (existing targeted re-review path — same `qcN.md` `## Revalidation` in-place verdict update; no new re-review form, N rules unchanged). The PM `Consolidated Decision Template` verdict enum is synced to the 4-value set (Approve | Request Changes | Needs Discussion | Unconfirmed).
- Added a **DSHFIND** badge to the README header linking to the plugin directory listing.
- **Ephemeral-citation lint (engine)**: new `findEphemeralCitations` scans skill text for short-lived citations — concrete task artifacts (`task-<digits>-(brief|report|fix-report|diff)`, incl. dot form `task-N.diff`) and SDD deeplinks (`.mstar/sdd/` / `.agents/sdd/` + concrete first segment) — while discriminating placeholder forms (`task-N-report`, `<plan-id>`, `{SDD_DIR}/…`, `.mstar/sdd/**` path globs): zero false positives on the current `skills/` corpus.
- **CLI `skill lint`**: third checklist `skill lint (ephemeral citations)` wired into `mstar skill lint` after the five-question checklist; each citation reports as a `skill.ephemeral.<kind>` violation (line + match + placeholder rewrite fix) and sets exit 1.
- **drift-lint guards**: docs audit-enum set-equality (docs/cli.md `<category>` row and README category-focus lists vs the engine `AUDIT_CATEGORIES` — catches fabricated tokens like `deps` and omissions like `bug` / `direction`), README.md / README_CN.md same-commit bilingual pairing over the push range, and a skills-corpus ephemeral guard reusing `findEphemeralCitations`; plus a `citesKnowledgeConventions` exemption for harness-local knowledge citations.
- **History-rewrite push safety**: `mstar-branch-worktree` gains a "History rewrite 与推送安全" section — any history rewrite of an already-pushed branch must first `git fetch` and record the remote **exact OID**, then publish with `--force-with-lease=<branch>:<observed-oid>` (bare `--force` prohibited); after the rewrite, prior review threads / approvals / check results are no longer current evidence and must be re-reviewed before merging; `mstar-iteration`'s phase-4-5 reference now points at that section as the SSOT for rewrite / force-with-lease / evidence-invalidation rules.
- **Authoring devices library**: `skillsbench-authoring.md` gains 6 small composable authoring techniques (calibrated examples file, recall batteries, overcorrection traps, required-explicit-input, questions ≠ write authority, invocation boundary), each mapped onto one or two SkillsBench principles with in-harness instances.
- **Bilingual minimal-update rule**: `AGENTS.md` Core Rules now require the minimal counterpart edit for paired docs (README.md/README_CN.md, packages/dsh README triplets) — never re-translate a document to apply an update — with pairing hashes re-recorded (`git hash-object`) in the same change set.
- **Knowledge-doc prose hygiene**: `mstar-compound` workflow gains §3.5 — a HEAD-resolvability quality gate (a reader at HEAD — no chat transcripts, dispatch prompts, or unmerged drafts — can resolve every reference and verify every claim) with an mstar-adapted leakage taxonomy (dead session citations, change narration, review choreography, hedges without `simplify:`/`temporary` markers, authoring-language slips) and sanctioned keep rules (R#/finding ids in review bundles, issue references, measured bounds, iteration/plan ids); `writing-specialist` Output Guidance points to the SSOT without duplicating it.
- **Future-decision-value classification**: `mstar-compound-refresh` Phase 2 gains a second axis — docs whose rationale / alternatives considered / negative guarantees / reintroduction conditions still guide a future change are **kept regardless of length** — plus a guardrail (a captured rejected approach stays only while the losing idea remains a tempting, meaningful mistake) and an explicit exclusion of frozen-archive seal machinery (rule 6 delete-don't-archive intact).
- **Editorial rubric for writing-specialist**: Output Guidance adds the complete-proposition rule (enumerate actor+action / condition / modality / negative guarantee / ownership before trimming; trim only when every factual clause survives), a coverage-by-artifact table over the six mstar surfaces (knowledge docs / plans / review bundles / SKILL.md / README / completion reports), and doc standards (atomic-move rule, tutorial-vs-reference classification).
- **QC deep-review lenses**: `deep-review-lenses.md` gains 5 new lenses — Lifecycle & Concurrency, Ownership / Derived-State, Bounds, Enforcement-Path, Real-Entry-Path — each with 2–4 structured questions answerable via diff/read/grep, plus deepened Testing / Contract lenses and signal-map seats (QC3 default += Enforcement-Path / Ownership; QC2 default += Bounds / Real-Entry-Path).
- **Audit playbook probes**: `mstar-audit` playbook §1/§2/§4/§5 gain 8 codebase-level probes (derived-state drift, bounds covering the final operation, enforcement bypass, real entry path, externally observable state, user-visible output is behavior, public-but-one-caller, unjustified defaults/public options); §5 adds the prove-or-reject methodology for DEBT findings (consumer three-way classification, hand-rolled vs dependency swap bar, mirrored-fact test, strong-candidate families, guards).
- **`/codebase-audit simplify`**: new `simplify` scope variant routes through the existing command — a DEBT-focused deep pass whose findings use Category DEBT and never inline TODOs.
- Documented `/codebase-audit` usage and keyword parameters (effort levels, category focus, `branch`, `next`/`roadmap`, `simplify`) in README.md/README_CN.md and docs/cli.md.
- Internal `@mstar-harness/engine` devDependencies in cli/opencode/dsh now use the `workspace:*` protocol; the release-prep engine-spec sync step was removed.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.3.0**.

## [2.2.0] - 2026-08-13

### Harness

- **dsh plugin**: the context catalog now carries an **`agentFlow`** evidence row — the actual subagent dispatch/settle ledger (`{HARNESS_DIR}/agent-flow.jsonl`, bounded JSONL truncated to ~500 events; single recording core `DshHostAdapter.dispatchGate` behind both the `tools/pre-execute` listener and the `beforeDispatch` host hook; real settle recording — `tools/post-execute` is a VERIFIED registry seam (dispatched for every tool call) settling foreground dispatch calls, background tasks settle via `ctx.tasks.onTaskDone` terminals, paired by exact dispatch identity — settlement is never fabricated, unpaired calls record nothing). The workflow panel's main graph adds the expected-vs-actual subagent flow pipeline: a third column of stage boxes lit by dispatch evidence, a collapsible event-detail footer strip (role → planId#taskId, all five status colors, settled ✓), and the flow-expected / flow-actual / flow-unexpected legend.
- **dsh plugin**: the ledger's missing-file state now reads as an EMPTY view (the panel shows the "no actual dispatches yet" empty state from plan merge — not an evidence-missing degrade); the ledger append path is documented single-writer and size-gated with an atomic truncation replace.
- **dsh plugin**: fix the unified `mstar-engine-status` catalog row breaking the session round (`session event "user/message" carries non-JSON-serializable data`) when the iteration-gate section cannot be built — no `status.json`, no active steering compass, or an unreadable control doc. The optional `iteration` key is now omitted instead of present-as-`undefined`, keeping the appended message losslessly JSON-serializable at the `Session.append` boundary.
- **dsh plugin**: fixed the broken `@mstar-harness/dsh` build gate — the web client bundle (`dist/client.js`) is now emitted by the full build. Root causes: `tsconfig.json` `types` omitted `react` (TS7026: no `JSX.IntrinsicElements` for the panel `.tsx` sources) and the `@deepseek-ai/dsh-client-*` peer-stub workspace links were missing from `node_modules` (TS2307), which failed the build's final `bunx tsc` step and left the client bundle absent. The typecheck gate is green again; `dsh --profile web` boots with the plugin's `/plugins/@mstar-harness/dsh/client.js` registered and served.
- **dsh plugin**: mstar slash commands (`/iteration-start`, `/iteration-drive`, `/iteration-loop`, `/codebase-audit`) now declare an `input` hint (new frontmatter `input:` in `commands/*.md`), so the dsh web client **claims** them on menu pick instead of executing immediately: `/name ` is inserted into the composer with the command highlight, the arg hint shows as ghost text, and the line submits only on Enter — the same interaction as `/plan` / `/goal` / `/advisor`. User-typed args are appended to the steered command message as a `## User input` section; quoted frontmatter values (description/input) now register unquoted. Updated `mstar-host/references/dsh.md`.
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.3` line (`^0.1.0-rc.3`; `@deepseek-ai/cordis` `^4.0.1` — same-class alignment with the dsh-advisor upstream bump, `dsh-external/dsh-advisor#14`); every installed version below `0.1.0-rc.3` (old `0.0.1-rc.x` / `0.1.0-rc.2` lock entries and nested copies) was purged from `bun.lock` + `node_modules`. The monorepo root gains a `bun` `overrides` entry pinning `@deepseek-ai/dsh-llm` to `^0.1.0-rc.3`: bun otherwise installs same-version nested peer copies for each dependent dsh package, and TS 5.9 package-id resolution treats the copies as distinct modules — the plugin's `MessageSourceMap` augmentation (`mstar-engine-status` catalog kind) no longer merges into the union dsh-agent/dsh-session see, breaking `createUserMessage` typing at the `agent/pre-step` catalog push. `tests/peer-deps.spec.ts` pins `^0.1.0-rc.3`.
- **dsh plugin**: dev-time `@deepseek-ai/dsh-*` seam resolution switched from the local **link farm** to the **npm registry** at `0.0.1-rc.5` (bun auto-installs peers via the monorepo-root `.npmrc` `${NPM_TOKEN}`). Removed `scripts/setup-dsh-links.ts` + `dsh:link`/`dsh:link:check` (`prepare` is now build-only); dropped `peerDependenciesMeta.optional` (the old skip-unpublished-peers workaround) and completed the peer set — `dsh-client-runtime`/`dsh-client-locale`/`dsh-client-ui-conversation`/`dsh-client-ui-slots`/`dsh-invariants`/`dsh-jobs` joined the existing peers (all `^0.0.1-rc.5`); added `keywords: ["dsh", "dsh-plugin"]` and `tests/peer-deps.spec.ts` (registry peer contract, peers-not-optional regression).
- **dsh plugin**: `@deepseek-ai/dsh-*` peers upgraded to the `0.1.0-rc.6` line (`^0.1.0-rc.6`; `@deepseek-ai/cordis` stays `^4.0.1`) — every lock entry below `0.1.0-rc.6` (`0.1.0-rc.3` pins and any `0.0.1-rc.x` leftovers) was purged from `bun.lock`; the whole dsh tree now resolves at `0.1.0-rc.6` (60 lock entries, single hoisted copy per package). The monorepo-root `bun` `overrides` entry for `@deepseek-ai/dsh-llm` is **removed**: with every dsh package on the same `^0.1.0-rc.6` range bun dedupes to one copy, so the rc.3-era nested-copy workaround is no longer needed (verified: 1 lock entry, 0 nested `dsh-llm` copies; the `MessageSourceMap` augmentation typecheck passes). Root `dependencies` stays engine-only. Seam-resolution docs updated for the public-registry reality (the root `.npmrc` auth token was dropped in 0c884d47): `packages/dsh` README (EN/zh) and `tests/peer-deps.spec.ts` no longer claim a root `.npmrc`/`${NPM_TOKEN}` — the spec now asserts no scoped-registry mapping comes back and the installed `dsh-llm` resolves to exactly `0.1.0-rc.6`. Caveat: `@deepseek-ai/*` publishes `dist-tags.latest = 0.0.1-rc.1` (an ancient line whose packages reference never-published peers like `dsh-user-interaction`), so `bun update @deepseek-ai/...` must not be used — it downgrades to that line and 404s; the lock-purge + `bun install` path is the supported upgrade route.
- **dsh plugin**: dev-time dependency strategy for the `@deepseek-ai/dsh-*` seams switched from committed `peer-stubs/` stand-ins to a **link farm** (`packages/dsh/scripts/setup-dsh-links.ts`, dsh-advisor pattern): the REAL packages from a local dsh source tree (`$DSH_SOURCE_DIR` → `$DSH_HOME/source/current` → `~/.dsh/source/current`) are symlinked into the repo-root `node_modules/@deepseek-ai/` (idempotent; `bun run dsh:link` / `dsh:link:check`; wired into `prepare` before the build). `peerDependencies` stay declared (the host provides them at runtime; marked optional so bun 1.2 does not 404 on the private registry); the `peer-stubs/` workspace was removed.
- **dsh plugin**: CI (validate job) now detects dsh source-tree availability (`$DSH_SOURCE_DIR` / `~/.dsh/source/current`) and skips the dsh test/typecheck steps when absent — dsh is not run in CI.
- **dsh plugin**: `src/index.ts` slimmed from a 3184-line monolith to a module index over `src/gates/*` (pure refactor, zero behavior change — the 27-name export surface is frozen identical by `tests/export-surface.spec.ts`, and the export-surface type layer now runs in CI via `typecheck:tests` (`bunx tsc --noEmit -p tests/tsconfig.json`)).
- **dsh plugin**: `HarnessResolver.forWorkspace` now passes `workspaceRoot = the session cwd` (the probe start) — the `{HARNESS_DIR}` probe stops AT the session workspace and never walks up beyond it, so a harness dir above the workspace (e.g. the global `~/.mstar` CLI-install root) is never adopted. The dsh boundary deliberately diverges from the CLI's git-top-level boundary. Explicit `config.harnessDir` still wins outright.
- **dsh plugin**: the pre-step catalog is now ONE unified `mstar-engine-status` message — watermark (version, harness dir, enforcement) + iteration phase-gate section (when a steering compass resolves) + workspace-state digest section (plan registry, open residuals, branch/policy anchors, active leases, knowledge summary, compass direction — when the workspace has a `status.json`) — all from one cached `status.json`/compass/knowledge read.
- **dsh plugin**: the catalog row is TTL-refreshed per workspace (Config `catalogTtlMs`, default 60000 ms — mid-session plan/compass/residual changes land within one interval while the hot path stays a timestamp compare + cache hit) and digest-gated (injected once per turn, re-injected only when it changed — a long turn shows the catalog once, not per step).
- Unify local scratch layout: temp files → `.tmp/*`, git worktrees → `.worktrees/*` (both gitignored); documented in AGENTS.md.
- **dsh plugin**: the web client workflow panel is now **"MStar 工作流" / "MStar Workflow"** — a reworked layout (header with version / harness dir / enforcement evenly spread; fixed right sidebar for plans / residuals / knowledge / leases / branches+policy / direction; main body = a **react-flow cyclic workflow graph**) with an upgraded visual system (dsw-token spacing ramp, type hierarchy, dark mode, motion). The graph projects the `mstar-engine-status` catalog through a pure `projectGraph` function (schema constants strictly separated from catalog evidence; never throws; explicit degraded states): a phase ring (iteration-start → autonomous-execute → iteration-close → pr-delivery → merge-ready, loop edge) + plan state machine (Todo → InProgress → InReview → Done / InProgress ⇄ Blocked / unknown bucket), with current-phase highlight, legend, zoom/pan and fitView. `@xyflow/react@^12.11.2` is inlined into `dist/client.js` (MIT; license/size reviewed in guides); the build script now asserts the bundle carries no `import.meta` / ESM statements — the web loader executes plugin bundles as classic `<script>`s, so a zustand v4 `import.meta.env` read (which would break the panel at parse time) is defined away. Local install re-verified: profile add → web boot → client.js route serves the built bundle byte-identical (sha1).
- **dsh plugin**: fixed the unstyled MStar workflow panel — CSS Modules hash class names in the web client bundle could start with a digit (FNV-1a → 8-hex, ~62.5% digit-leading), producing illegal selectors (`.20fd0e45_root`) that browsers silently drop (the whole rule is discarded). The client bundle build now escapes digit-leading class selectors at the CSS text layer (WHATWG `CSS.escape`, e.g. `.20fd0e45_root` → `.\32 0fd0e45_root`; DOM class names unchanged) and adds a build-time two-layer assertion (transform + emitted artifact) that no unescaped digit-leading hash selector remains — a regression guard so silent style loss cannot slip through again.
- **dsh public release prep**: removed the `prepare` script from `@mstar-harness/dsh` (fresh-checkout `bun install` no longer fails on the gitignored engine `dist/`; the monorepo builds packages explicitly, matching cli/opencode), wired dsh into the release pipeline (`release-surfaces.ts` version surface + changelog, `release.yml` build/publish), and made the READMEs public — the private dsh-provider block and the private-mirror repo-URL install (`dsh-external/mstar-workflow`) are gone, replaced by the registry form `dsh plugin --profile web add @mstar-harness/dsh` (plus local-checkout dev install). Dropped a stray committed `.pnpm-store/` (gitignored now).
- **dsh plugin**: fixed ReactFlow v12 silently dropping every edge whose endpoint node exposes no connection-point `<Handle>` — all 17 graph edges (phase ring 5 + state machine 5 + connector 1 + pipeline 6) render again in the real browser.
- **dsh plugin**: synced `packages/dsh` to the dsh `0.0.1-rc.2` rename wave — seam package renames consumed (`@deepseek-ai/dsh-skill-local` → `@deepseek-ai/dsh-skill-filesystem`; test-only `dsh-tasks`/`dsh-tasks-fake` → `dsh-jobs`/`dsh-jobs-fake`), peerDependencies bumped `^0.0.1-rc.1` → `^0.0.1-rc.2`, and renamed API symbols (`SkillService` → `SkillRegistry`; the optional background-seam surface `ctx.tasks`/`onTaskDone`/`TaskId`/`TaskDoneListener`/`TaskSnapshot` → `ctx.jobs`/`onJobDone`/`JobId`/`JobDoneListener`/`JobSnapshot`; client `LocaleService` → `LocaleRuntime`, `SlotsService` → `SlotRegistry`). Docs/README `skill-local` prose renamed to `skill-filesystem`.
- **dsh plugin**: the `<mstar_engine_status>` watermark now shows one unified `mstar version` line instead of separate engine/plugin versions (single-version invariant — the bundled engine and the plugin share one version).
- Removed local-maintenance path references from user-facing skills: `mstar-host/references/dsh.md` and `mstar-iteration/references/phase-2-worktree-lease.md` now reference only runtime consumer contracts (verified zero residual paths).
- Aligned `mstar-branch-worktree` feature-worktree naming to the workspace root `.worktrees/<plan-id>-<slug>` convention (AGENTS.md「Local scratch layout」), gitignored by repo convention.
- **dsh plugin**: the web client module manifest moved from the top-level `dshClient` field to the nested `dsh.client` (`platform: 'web'` + declared inject faces), matching upstream `client-modules` discovery (`dsh.client` + `exports["./client"]`). The legacy top-level key is removed — upstream has no compatibility fallback, so the old field silently un-discovered the client half and dropped the workflow panel from the web boot manifest (`window.__DSH_BOOT__.entries`). A manifest-contract regression test now freezes the new contract and fails first if upstream renames the field again.
- **dsh plugin**: version aligned to `2.0.5` (single-version invariant — the `@mstar-harness/engine` devDependency is pinned exact `2.0.5` and the engine version assertions in the dsh suites now expect `2.0.5`), restoring the unified `mstar version` watermark after the upstream v2.0.5 merge.
- **dsh plugin**: version bumped to `2.1.1` (single-version invariant — the `@mstar-harness/engine` devDependency is pinned exact `2.1.1` and the engine version assertions in the dsh suites now expect `2.1.1`), restoring the unified `mstar version` watermark after the upstream v2.1.1 sync (QC F-001: the shipped bundle and the workspace source now report the same version).
- **dsh plugin**: the `@mstar-harness/dsh` package now ships a **web client plugin** (workflow panel) on the same `mstar` bundle row — `dsh.client` + `exports["./client"]` discover the client half automatically (no separate profile layer or install step). The plugin registers a `conversation.view` view-ring tab (`id: 'mstar-workflow'`, `order: 20`) rendering the latest `mstar-engine-status` catalog row as a structured panel: watermark (version / harness dir / enforcement), iteration phase-gate section (transition, all-plans-done, gate verdict + violations, status/compass anchors), workspace-state section (plan board, residuals, branch/policy anchors, leases, knowledge, direction) and a freshness marker; refresh follows the session snapshot (no polling). Bundle ships as a closure-factory CJS artifact (`dist/client.js`) served at `/plugins/@mstar-harness/dsh/client.js`; local install into the `web` profile is verified.
- **dsh plugin**: **Known limitations** — the panel is a structured segmented presentation this iteration; the graphical workflow canvas (react-flow DAG) is the NEXT iteration scope (compass Roadmap Position). No react-flow dependency or panel render-shape change lands here.
- **dsh plugin**: `{HARNESS_DIR}` now resolves per session workspace — the probe starts from the session cwd (never the launch/process cwd), so the engine-status watermark and the gates follow the workspace the session actually works in; an explicit `harnessDir` config still wins outright.
- **dsh host**: concurrent subagent dispatch now **requires** background mode — any N≥2 dispatch that needs parallel execution (QC tri-review, dual-track) MUST invoke every `subagent` call with `run_in_background: true` in one message; foreground N≥2 invokes run serially (fail-closed `exclusive` tool classification) and do not satisfy an N-parallel requirement (dispatch-incomplete / `Blocked`). Updated `mstar-host/references/dsh.md` (PM dispatch + QC default).
- **dsh plugin**: agent-canvas legend + Phase layout simplification (plan `20260813-panel-agent-canvas-legend-layout`) — (1) the canvas **legend is simplified to the 3 role-card status entries** (`agent-running` running glow / `agent-settled` settled — the standalone GREEN done frame + ✓, never on off-tier roles / `agent-idle` idle dashed); the 7 collaboration-edge / layout entries (`flow-actual` / `port` / `group` / `sub-bucket` / `supervise` / `on-demand` / `unknown`) are removed from the legend copy (the canvas itself keeps the edges / ports / partitions — only the legend copy drops them); (2) the **Phase 1 / Phase 2 groups now sit SIDE BY SIDE** — Phase 1 (review-edit-chain) on the LEFT, Phase 2 (sdd-implement → qc-tri → qa-gate) on the RIGHT, top-aligned — instead of stacked top/bottom, saving vertical canvas space. Docs synced: dsh.md SSOT + bundle mirrors + README.md / README.zh.md / bundle/README.md.
- **dsh plugin**: the 代理执行 tab (spec F1.4) is now a **draggable agent canvas** (replacing the stage-column AgentFlowZone, which is deleted): a native pointer-event **pan** surface (pointerdown/move/up + `setPointerCapture`, translate-only — no zoom, no third-party deps, `touch-action: none`) with the coordinate-space content layer exposing the pan state as `data-canvas-pan` (`transform: translate(xpx, ypx)`; the grid background moves with the content). Every **KNOWN_AGENTS** roster member renders an entity card — **title = the agent name** (session id / task tag are auxiliary record fields); un-evidenced agents show the muted **idle** card (dashed frame, `data-agent-idle`), evidenced agents light by the honest status priority (running business glow ring / settled ✓ / error / denied / advisory). Collaboration edges reuse the `AgentEdge` model: dim dashed expected stage skeleton, business actual handoffs, and the **animated "next" edge** (`@keyframes canvas-dash-flow`, disabled under `prefers-reduced-motion` — engine-verified). The **Legend** re-mounts on the canvas with the idle swatch (`data-mstar-legend-item="agent-idle"`) + the collaboration-edge swatches; the canvas degradation note now distinguishes the settle-only ledger (`data-canvas-note="settle-only"`) from empty/degraded, and the dead AgentFlowZone styles were removed from `zones.module.css`.
- **dsh plugin**: the agent canvas was verified in the browser harness on **light + dark** themes — entity cards (idle dashed / running glow / settled ✓), legend swatches (incl. the idle swatch), and the next-edge stroke were probed for computed styles in both themes (host token flip observable, zero bare colors of any form across the panel/zones/canvas css, `prefers-reduced-motion` run asserts the next-edge and running-card animations compute to `none`); a **real pointer-drag** sequence (CDP `Input.dispatchMouseEvent`) moved the `data-canvas-pan` transform from `translate(0px, 0px)` to `translate(60px, 30px)` with pointer capture released — the drag contract verified end to end; evidence in `{SDD_DIR}/review/harness/` (browser-checklist.md + browser-results.txt).
- **dsh plugin**: the MStar workflow panel's agent-execution zone now renders the real subagent flow — the six EXPECTED_ROLE_FLOW stage/phase columns with **entity cards** aggregated from actual dispatch evidence (agent display name / role chip / task tag `planId#taskId` / status point / ×N count; running entities get a business glow-pulse highlight, un-evidenced stages show a dashed "pending" placeholder with their expected role chips, and the header carries the `N executing · M pending` summary). Flow arrows: dim expected skeleton arrows between consecutive columns, small in-column handoff arrows between same-column cards, and an **animated "next" edge** — a business dash-flow arrow (`@keyframes agent-dash-flow`, disabled under `prefers-reduced-motion`) from the latest running entity's stage to the next constant-order column, drawn only while a running entity exists. The zone degrades to muted empty states (never orange warn boxes) when the ledger is missing/empty/settle-only.
- **dsh plugin**: the agent zone and the agent-flow event dock were verified in the browser harness on **light + dark** themes — entity cards, status points, pending placeholders, the next-edge dash animation (declaration + computed `animation-name`) and the dock's event-row status colors were probed for computed styles in both themes, including a `prefers-reduced-motion` run asserting the animations are disabled; evidence in the iteration guide `iter-20260810-panel-zones/guides/agent-flow-zone-dual-theme-verification.md`.
- **dsh plugin**: the MStar workflow panel canvas was rebuilt as an **HTML/CSS zone dashboard** — the react-flow cyclic graph (the `@xyflow/react` rendering layer, its plain-`.css` text loader, and the devDependency) is removed, and the build now asserts the emitted `dist/client.js` carries **no `xyflow`/`reactflow` markers** (the bundle dropped from ~468 KB to ~85 KB raw). The canvas fills the Tab (no page-level scroll): an **iteration zone** (Step 1–5 stepper + `Step N/5` badge, active-highlight / inactive dimmed states, branch panel: iteration base / target / spec integration — rendered only while active), a **tasks zone** (6-column kanban: Todo / InProgress / InReview / Done / Blocked / unknown with count badges, Done ≤5 + `+N more`), an **agent-execution zone** (pending skeleton — entities + flow arrows land in plan `20260810-panel-agent-flow-zone`), a bottom **fixed footer bar** (zone legend + gate summary with collapsible violations) and a canvas-corner **AgentEventDock** (agent-flow event strip, mounted only when events exist — hidden entirely at 0 events). The three orange warn frames are gone — degraded states render as muted empty states, never orange boxes.
- **dsh plugin**: the zone dashboard is fully token-driven (zero bare colors of any form) and verified in the browser harness on **light + dark** themes — zone backgrounds / borders, status colors and the muted empty states were probed for computed styles in both themes (`prefers-reduced-motion` respected, motion ≤200ms); evidence in the iteration guide `iter-20260810-panel-zones/guides/canvas-zones-dual-theme-verification.md`.
- **dsh plugin**: the 事件记录 tab (spec F1.5) is now a **non-canvas log page** — `EventLogPage` renders two partitions from the projected `ZoneView` slices (consumed unchanged, zero projection changes): **Agent 流转事件** (`view.events` ≤50 latest-first; off-pipeline unexpected dispatches fold in once via `expected: false` — never double-appended) and **违规记录** (`view.violations`, gate violations with severity/code/message). **Every row is an expandable native `<details>`** (no-JS, keyboard-accessible): the summary IS the toggle (role/agent, stage, `planId#taskId` tag, HH:MM time, token-colored status chip, settled ✓, duration, unexpected badge) and the expanded body shows the **full catalog fields** (role/agent/stage/plan/task/category/time/kind/status/expected/settled/duration; violations: severity/code/message) — a missing field renders muted **「—」**, never a fabricated value. Empty/degraded states are muted (both-empty → one「暂无记录」note; mixed empty degrades each partition independently) — never an orange warn frame. The canvas-corner **`AgentEventDock`** is **removed** (无双份日志, spec §5): its row layout + status colors migrated into this page, and the header TabNav already is the jump to the tab — zero `data-agent-event-dock` anchors remain. New `data-event-log-*` test anchors (section/row/details/field/missing/empty), 23 new `event-log.*` locale keys (zh/en symmetric) in the `PanelKey` union, and a new token-driven `event-log.module.css` (zero bare colors — dark mode is the host token flip; the `<details>` disclosure chevron is a token-colored `::before` that rotates 90° on expand; 150ms hover/rotation sits in the 120–150ms window; motion killed by the panel root `prefers-reduced-motion` rule).
- **dsh plugin**: the event-log page was verified in the browser harness on **light + dark** themes with a **real `<summary>` click** expanding a row's `<details>` (open state + detail-body computed styles asserted): partition frames (bg/border), log-row summaries, status chips (business/warn/error/success), severity chips (error/warn), the disclosure chevron (caption token, rotates on open), and the muted empty state were probed in both themes (host token flip observable, zero bare colors of any form across the panel/zones/canvas/event-log css, no panel-side dark overrides); a `prefers-reduced-motion` run asserts the row hover transition computes to `0s`; evidence in `{SDD_DIR}/review/harness/` (browser-checklist.md + browser-results.txt + dual-theme screenshots with one row expanded).
- **dsh plugin**: QC fix wave (plan `20260811-panel-event-log` re-review): the unexpected-role badge is now dispatch-only — settle rows (completion records) never flag as unexpected and render「—」in the detail expected-role seat; `formatEventTime`/`formatEventTimeFull` no longer throw RangeError on a finite-but-out-of-Date-range `ts` (it degrades to「—」like any missing value); the events partition title moved to the symmetric `event-log.section.events` locale key; the READMEs/dsh guide now attribute the fixed footer bar's removal to the tabs-shell plan (this plan removed only the `AgentEventDock`).
- **dsh plugin**: panel F2 quickfix (plan `20260811-panel-f2-quickfix`) — (1) the 任务迭代 tab's step row now renders 5 equal full-width unit blocks (flex `1 1 0`, centered content, `--mstar-space-*` gap) with pure-number badges and `n/total` summary — the connector bars (`data-step-connector*`) are removed and zh/en carry no 步骤/Step wording; (2) `KNOWN_AGENTS` is now exactly 14 roles — `project-manager` (the primary orchestration agent, never an assignable subagent) is removed from the 代理执行 roster; (3) the agent canvas drops the `ops-on-demand` pipeline stage (5 stages, `qa-gate` terminal), moves `ops-engineer` / `prompt-engineer` into a separate **on-demand column** (projection-owned `zone`, no expected/next arrows into it, localized label + legend entry), and renders the SDD implement ↔ task-review **loop back-edge** (`sdd-task-review → sdd-implement`) as a visually distinct curved double-arrow with its own `data-agent-edge-loop` anchor — `pending` semantics follow (11 in-flow roles).
- **dsh plugin**: panel F3 agent-general model (plan `20260811-panel-f3-agent-general`) — (1) the 代理执行 canvas pipeline drops from 5 to **4 stages** (`review-edit-chain → sdd-implement → qc-tri → qa-gate`, `qa-gate` terminal; the `sdd-task-review` stage is removed and its SDD L2 reviewer moves off-pipeline); (2) `KNOWN_AGENTS` is now exactly **13 roles** — `generalPurpose` becomes the **`general` bucket** (its own trailing column, `stage: null`), `explore` is removed (no card, no column — a stray `explore` dispatch folds into `general`), `ops-engineer` / `prompt-engineer` keep the on-demand column, `project-manager` stays out of the roster; (3) entity cards now aggregate **by role** instead of by session — the same role across sessions folds into one card ×N, and every off-roster dispatch (former `generalPurpose` reviewer, `scout`, anonymous `role === ''`) folds into the single `general` entity (`agent` / `task` become record fields); (4) the SDD loop back-edge is redrawn as `sdd-implement` ↔ `general` — a curved double-arrow **below the column band** (anchored at the column bottoms, true bezier extremum 16px below the lowest column bottom, `data-agent-edge-loop="autonomous-execute:sdd-implement->general"`); (5) `AgentZone` is `'flow' | 'on-demand' | 'general'` (the `unexpected` track is removed; columns = 4 stages + on-demand + general); (6) the 事件记录 (Event Log) page now renders its two partitions **side by side** in a locked-height two-column grid (`repeat(2, minmax(0, 1fr))` — no whole-page scroll; each partition pins its title and scrolls internally), falling back to stacked rows below 1200px, with all `data-event-log-*` anchors preserved (event-log `unexpected` badge semantics unchanged — `expected` ⟺ role ∈ EXPECTED_ROLE_FLOW union).
- **dsh plugin**: panel F4.2 agent-view layout (plan `20260811-panel-f4-agent-view`) — the 代理执行 canvas drops the standalone **general bucket column** (5 columns now: 4 stages + on-demand; `data-canvas-column` never emits `general`): the single `general` bucket card renders at the **bottom INSIDE the `sdd-implement` column** (stable partition — dev cards first, general card below — with a dashed separator + small in-bucket `general` label, idle placeholder preserved, `data-agent-bucket="general"`); the `sdd-implement` ↔ `general` **SDD loop back-edge is removed** — no more curved double-arrow below the column band and no `data-agent-edge-loop` anchor (`AgentEdge.loop` / `solveLoopBow` / `LOOP_BOW_MARGIN` / `GENERAL_COLUMN` dead code cleaned); the 3 forward skeleton arrows, in-column handoff arrows and the animated next edge are unchanged, and the on-demand column (ops-engineer / prompt-engineer) is untouched. Evidence-driven "dynamic lines" for the review cycle are a later roadmap iteration.
- **dsh plugin**: panel F4.3 iteration-zone (plan `20260811-panel-f4-iteration-zone`) — the 任务迭代页 expanded head is now a LEFT-RIGHT SPLIT: the branch panel (`data-iteration-head-branches`) sits in the small left half and the Steps row (`data-iteration-head-steps`) in the large right half (`data-iteration-head-split`, DOM order branches-before-steps; narrow widths stack at the existing 860px breakpoint; no branch panel when there is no active iteration). The current step is now compass-driven: while the steering compass is `status: active` (Phase 1 in flight — catalog `compassStatus` field), Step 1 (iteration-start) renders CURRENT with verdict `unknown` and NO PASS/FAIL badge (Phase 1 has no gate verdict), next = Step 2; `locked` / missing `compassStatus` keeps the existing gate-transition-driven Step 2→4 + gate badge. Every step reserves a fixed-height verdict seat (`data-step-verdict-seat`) so centered content groups align — the PASS/FAIL badge no longer skews the step blocks. Docs synced (dsh.md SSOT + bundle mirror + READMEs + knowledge update-only).
- **dsh plugin**: panel F4.1 timeliness (plan `20260811-panel-f4-timeliness`) — the 代理执行 canvas now reflects REAL subagent completion: settles are recorded only from verified completion signals — `tools/post-execute` (the dsh-tools registry dispatches it for every tool call, verified against the upstream source) settles foreground dispatch-tool calls, and `ctx.tasks.onTaskDone` terminals settle background subagents (`completed → ok` / `killed → denied` / `failed → error`); every paired settle carries its dispatch's identity (`role`/`planId`/`taskId`, same fields + semantics as the dispatch event), so under QC-tri N=3 concurrency each card settles on its own, the `N 执行中` count derives from the ledger, and unpaired/non-dispatch calls record nothing (never fabricated). A ledger record (dispatch/settle) now invalidates the workspace's TTL-cached catalog row immediately, so the panel refreshes per step during active orchestration instead of waiting up to the 60 s TTL (idle gaps keep the last snapshot — documented limit).
- **dsh plugin**: panel F5 agent-layout rework (plan `20260812-panel-f5-agent-layout`) — the 代理执行 canvas now renders **4 stage columns + a rightmost `unknown` column** (the `general` bucket gets its OWN rightmost column, user 2026-08-12 decision — the former F4.2 "bottom inside `sdd-implement`" placement is superseded); the `sdd-implement` column splits into **sub-buckets** by the projected `entity.bucket` — **implementor** above (flow roles in stage order, then the on-demand roles ops-engineer / prompt-engineer carrying an **on-demand badge**; the standalone on-demand column is removed) and **sdd-reviewer** below (code-reviewer, the SDD L2 task reviewer — v2.1.1, the former `generalPurpose` seat), with implementor / sdd-reviewer caption labels; a **bidirectional supervise line** (implementor ↔ sdd-reviewer — the mstar-sdd mutual-supervision contract) runs inside the `sdd-implement` column, dim dashed by default and lit business only when the projected `evidenced` flag is true (evidence-driven lighting, never a fabricated activation); `KNOWN_AGENTS` grows **13 → 14 roles** (`code-reviewer` joins the pipeline roster); the no-harness branch renders a **centered inactive-state card** (folder icon + 「No Morning Star harness detected」 title + hint — no tabs, no sidebar, activates automatically once a harness is detected). Docs synced: dsh.md SSOT + bundle mirror + README.md / README.zh.md / bundle/README.md.
- **dsh plugin**: panel F5 design system (plan `20260812-panel-f5-design-system`) — the 代理执行 canvas now implements the user-approved design system (design doc v3, two 2026-08-12 review rounds): **(1) emphasis opacity tiers** — every entity card carries a projected `emphasis: 'current' | 'next' | 'off' | null` tier derived from the iteration's current phase (current-phase roles **100%** chrome, later-phase expected roles **75%**, already-passed / stage-less on-demand + general roles **45%**, `null` = no iteration → NO override); the tier is always a chrome **alpha mix** (`--mstar-canvas-emphasis-*` tokens), never a whole-card `opacity`, so the status point + running glow stay fully opaque. **(2) edge rework** — a strict **4-column layout** with NO standalone unknown column (the `general` bucket sinks into an unknown sub-partition at the bottom of the `qa-gate` column); the `expected` stage skeleton arrows and the ANIMATED `next` edge are **REMOVED** (flow order implied by the fixed column order + labels, current position by the running glow + status point), leaving TWO semantic kinds: evidence-driven **`actual` handoff** edges drawn as **bezier `C` curves** anchored to card **ports** (4 edge-midpoint ports — north/south/east/west, static-invisible, hover-revealed) with the arrow tip pulled back to a **10px standoff** off the port, plus the **bidirectional supervise line** re-anchored to the **side-gap vertical anchor** (`x = card right edge + 18px`, vertical bezier flow); two line RULES — **H1** arrow follows the line's local tangent, **H2** no line crosses any text. Cards are a single rounded element (glow on the rounded `.card-body`, no square outline). Docs synced: dsh.md SSOT (incl. leaf report-tool discipline — leaf completion goes in the closing message, not the `report` tool, whose default quiet delivery strands in the parent's next-step queue) + bundle mirror + README.md / README.zh.md / bundle/README.md.
- **dsh plugin (v4, user round 4)**: the agent canvas lands the round-4 design revisions (plan Task 8, design doc v4): **(1) Phase 1/2 groups + current-plan annotation** — the 4 columns split into TWO stacked bands (Phase 1 review-edit-chain ABOVE — the sequential Review & Edit chain; Phase 2 sdd-implement → qc-tri → qa-gate BELOW — the iterative plan loop), each with a group label row, and the Phase-2 label annotates the CURRENT plan (projected `activePlanId` = the first InProgress `state.plans[]` row; `+N more` when several run in parallel, muted「无进行中 plan」when none). **(2) settled green done frame + ✓ with the off-tier exclusion** — a settled entity with `emphasis ≠ 'off'` gets a standalone full-strength green frame (success border + 1px ring on the rounded card body) + the green ✓; an off-tier role (already-passed / stage-less on-demand + general) renders a muted dot and NEVER the completion marker (the v3 leak — the ✓ survived the off-tier low transparency — is fixed). **(3) shared iteration info section** — the tasks and agents tabs render the SAME `IterationInfoSection` component from the same `view.iteration` data (one implementation, two mounts). Inter-band handoff edges (Phase 1 ↔ Phase 2) reroute via the side-gap vertical anchor so no line crosses the group label rows (H2). Docs synced: DESIGN.md / DESIGN.dark.md v4 (Phase groups, done-frame token, plan annotation, shared section) + dsh.md SSOT + README.md / README.zh.md / bundle/README.md.
- **dsh plugin**: panel F5 iteration-zone fixes (plan `20260812-panel-f5-iteration-zone-fix`) — (1) the iteration Steps now carry a **four-state machine** (`current` / `next` / `done` / `idle`): every step BEFORE the current one projects `done`「已完成」 (completed — a finished Step 1 no longer reads as idle「待命」 while Step 2 is current; `next` stays the single forward target, `idle` is schema-only), with a quiet passed treatment — success-tinted badge border + muted chip text with a leading ✓ (`data-step-state="done"`, projection-derived, never UI-guessed); (2) the branch panel in the expanded split head is **width-capped** (`flex: 0 1 260px` + `max-width: 280px` — it no longer stretches with the container; the Steps row absorbs the remaining width, and the <860px column stack resets to content height). `current`/`next`/verdict semantics, the Phase-1 no-badge rule and the Step-5-never-current limitation are all preserved (Step 5 renders `next` only while Step 4 (pr-delivery) is current — docs corrected to match). Docs synced: dsh.md SSOT + bundle mirror + README.md / README.zh.md / bundle/README.md.
- **dsh plugin — panel quick fixes (plan `20260813-panel-quick-fixes`)**: the workflow panel's three tabs land the 2026-08-13 quick fixes. **(1) 任务迭代 tab** — the kanban is now **5 columns** (Todo / InProgress / InReview / Done / **`blocked-unknown`** — the Blocked state and the former unknown catch-all fold into ONE merged column titled「受阻/未知」/「Blocked / Unknown」); every column caps its rendered rows at `PLAN_CAP` and shows a clickable **「更多」/「收起」 expand button** (`data-kanban-more` anchor) that unfolds the full column — the projection keeps ALL plan rows (the cap is a render concern, never a discard). **(2) 代理执行 tab** — the canvas filters dispatch evidence to the **current iteration's plans only** (the steering compass `iterationId`, else the nearest iteration via the catalog `plans[].iterationRefs` — most-recent plan by 8-digit id date prefix + doneAt); provably cross-iteration events produce no entity/edge while the roster keeps its idle cards, and plan-less / unknown-plan / standalone dispatches are never hidden; **`advisory` is no longer terminal** — a soft-enforcement dispatch falls through to its paired settle (green ✓ completed when a settle exists, `running` when none), `denied` stays terminal, and the advisory verdict still renders in the event log; edge routing is tightened (**H1/H2** — same-column vertical flows reroute into the LEFT side gap when the center-x line would cross an in-between card body, forward AND reverse; reverse horizontal beziers keep direction-aware control points BETWEEN the endpoints, no card/seat hits) and the **legend moved below the canvas viewport**. **(3) 事件记录 tab** — the row list now scrolls INSIDE the panel partition: the panel root opts into the host `data-conversation-composer-overlay` (full-height opt-in) so `.rowList`'s `overflow-y: auto` engages and the host page no longer scrolls, with bottom clearance reserving the floating composer via the host-published `--dsh-composer-height`.
- Updated `skills/mstar-host/references/dsh.md` + `packages/dsh/README.md` / `README.zh.md` / `bundle/README.md`. The `harness-skills/` mirrors are gitignored and regenerated by `bun run bundle-assets` (not hand-committed).
- **dsh plugin**: the MStar workflow panel sidebar was reworked (info-layout direction #1) — the header row is gone, version + harness dir now live in a bottom **fixed meta dock** (small muted, does not scroll with the sidebar digest); the sidebar is capped and reordered (plans ≤5 in time-desc order + `+N more`, open residual findings ≤10 with severity chips + overflow hint, policy with **enforcement first** then push / worktree / control worktree, leases, knowledge, direction); the branches block moved out of the sidebar to the iteration zone (plan `20260810-panel-canvas-zones`). Catalog evidence: `HarnessPlanView.doneAt` (from `done_at`) and `MstarHarnessState.residualFindings` (open-lifecycle filtered, severity-ordered, capped at 10) — model-visible text stays compact.
- **dsh plugin**: the sidebar / bottom meta dock theme audit is locked in — every color-family declaration in `panel.module.css` resolves through a `--dsw-*` token (zero bare colors of any form, including CSS Color 4 `color()`), spacing rides the `--mstar-space-*` ramp, motion 120–200ms with `prefers-reduced-motion` off-switch; dark mode is the host's `body[data-ds-dark-theme]` token flip (no panel-side theme overrides). Verified by a browser harness run (light + dark computed-style probes on sidebar / bottom meta dock background, text, border and status colors — 46 PASS / 0 FAIL, evidence in the iteration guide).
- **dsh plugin**: the MStar workflow panel moved from the single-page zone dashboard to a **Tabs + Content** layout — a resident right **sidebar** (shared by all tabs: plans / residuals / policy / leases / knowledge / direction + the bottom version/harness meta dock) and a fixed header nav with the 3 MenuTabs **任务迭代 / 代理执行 / 事件记录** (default = 任务迭代, D1) switching the main content. The 任务迭代 tab is a full re-org (spec F1.3): a **Content Head** carries the iteration info (iterationId / gate verdict / branches) with the 5 iteration **Steps laid out horizontally** (current step highlighted, the connector into it lit — no "completed" checkmarks, honest to the schema's current/next/idle states); **未启动（`active === false`）时整体收拢为一行摘要（可展开）**，启动后展开完整 Steps，且同一挂载实例在实时 catalog 更新把 `active` 从 false 翻转为 true 时会自动展开（用户已激活后手动收拢不被覆盖）。下方任务区为**全宽标准 Kanban**（6 列 Todo/InProgress/InReview/Done/Blocked/unknown，Done 溢出沿用 PLAN_CAP，content 区内独立滚动——不再被 canvas 高度压成小坨）；代理执行 / 事件记录两 tab 落 muted 占位页（真实页面由 `agent-canvas` / `event-log` plan 交付）。zone dashboard 布局随之收敛：`WorkflowCanvas` / `IterationZone` 删除，其 zone 级图例项与 footer/gate-summary 样式一并移除，bundle 负向 xyflow 断言保持。
- **dsh plugin**: the Tabs+Content panel was verified in the browser harness on **light + dark** themes — iteration head / horizontal steps / full-width kanban / resident sidebar / tab nav / muted placeholder pages were probed for computed styles in both themes (token flip observable, zero bare colors, `prefers-reduced-motion` run asserts the root kill rule zeroes every transition); the layout invariants were pinned in-browser: page never scrolls, the content area is the only vertical scroll body, the sidebar stays resident across tab switches, and the kanban columns spread the content width (a real layout finding — the kanban column `min-width` is now border-box so the six columns fit at desktop widths instead of overflowing behind the internal scrollbar); evidence in the harness under `{SDD_DIR}/review/harness/` (browser-checklist.md + browser-results.txt).
- **Sync upstream v2.1.1**: merged the upstream `mstar-harness` v2.1.1 line into the dev-dsh branch — adds the `code-reviewer` role (read-only L2 SDD task reviewer / audit executor; replaces `generalPurpose` as the SDD per-task review seat, with generic fallback only when the role agent is absent on the host), ships the canonical default-ignore harness `.gitignore` format (`.mstar/**` + tracked re-includes `AGENTS.md` / `knowledge/` / `specs/`) across the engine, CLI `init` fence and bundled skills, and aligns all 11 version surfaces to 2.1.1.
- **engine**: `emitGitignoreSnippet` / `validateGitignore` / `HARNESS_PROCESS_GITIGNORE` now emit the default-ignore + re-include format instead of the flat per-directory ignore list; `ROLE_MAPPING` grows to 14 ids with `code-reviewer`.
- **bundle-assets**: re-synced `packages/dsh/harness-skills` / `harness-commands` from the merged `skills/` tree — the 6+ upstream-touched bundled skills and all `mstar-host/references/*.md` host adapters (cursor/kimi/omp/opencode/zcode) now carry the v2.1.1 wording (SDD task reviewer → `code-reviewer`).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, `@mstar-harness/dsh`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.2.0**.

## [2.1.1] - 2026-08-12

### Harness

- Canonical `.gitignore` snippet now default-ignores the whole harness dir (`<dir>/**`) and re-includes only the tracked results (AGENTS.md, knowledge/, specs/) — new process subdirectories are ignored automatically.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.1.1**.

## [2.1.0] - 2026-08-12

### Harness

- Added a **`code-reviewer` role** (L2): a read-only seat for SDD per-task review and `Task category: audit` / `mstar-audit` execution. PM entry stays `/codebase-audit`; large-repo fan-out uses read-only `scout` / `explore` via Assignment `Delegation: allowed (scout/explore only, read-only)`.
- Wired `code-reviewer` into SDD per-task dispatch (named L2 reviewer id, `generic` fallback), audit routing (`mstar-harness-core`, `commands/codebase-audit.md`), engine `ROLE_MAPPING` (13→14), and the bilingual README role tables; `qc-specialist*` (L3) / QA (L4) semantics unchanged.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.1.0**.

## [2.0.6] - 2026-08-10

### Harness

- Added a **host-agnostic full-flow goal rule** in `mstar-host`: any host exposing a `/goal` command (Codex Goal Mode, omp, future code agents) must set the goal to running the **complete flow to its end** — whether advancing an iteration (start → per-plan cycles → close → PR delivery → merge-ready loop) or non-iteration work (specify → clarify → plan → tasks → implement → plan QC tri + QA gate → Done) — never a sub-stage goal.
- Removed the Codex-specific `references/codex-plan-goal-mode-bridge.md`; goal text rules now live host-agnostically in `mstar-host` SKILL.md, and Codex Plan Mode reads `references/_shared/plan-mode-bridge-core.md` directly.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.6**.

## [2.0.5] - 2026-08-10

### Harness

- `/iteration-start`: accepts an optional `direction` hint (constrains §2 candidates, seeds §3 grill-me — start stays interactive) and a `pause` flag; auto-continues into Phase 2→5 (execute → close → PR → merge-ready) after Phase 1 lock + integration branch, by default. `/iteration-drive` remains standalone for re-entry/resume on an already-locked iteration. Updated `iteration-loop` vs-commands table, README/README_CN command tables + workflow diagrams, OpenCode package quick start; added routing eval `iteration-start-auto-continue-phase2`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.5**.

## [2.0.4] - 2026-08-09

### Harness

- omp plugin: engine-version compatibility — the blocking hook and `mstar_dispatch_validate` no longer statically import `composeDispatchGate`; on engines predating the export the task dispatch gate (Gate 2) is skipped with a one-time warning while the status gate stays active, and the dispatch tool reports an explicit upgrade error instead of silently vanishing (parity with `mstar_iteration_gate`).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.4**.

## [2.0.3] - 2026-08-09

### Harness

- omp plugin: in-process engine binding — model-callable mstar_* validator tools + blocking tool_call gate hook (Enforcement: hard only; commands shell-out stays as fallback).
- engine: `iteration.parseCompassFrontmatter` moved from CLI (shared single parser; CLI re-imports from engine).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.3**.

## [2.0.2] - 2026-08-08

### Fixed

- OpenCode plugin entry now default-exports `{ server: MorningStarHarnessPlugin }` so helper function exports are not registered as plugins (fixes `plugin config hook failed: N.config` / `N.dispose` on startup).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.2**.

## [2.0.1] - 2026-08-08

### Fixed

- OpenCode plugin hooks no longer abort-log on non-string `task`/`write` args: Assignment and `status.json` validators refuse non-string input before `.match` / `path.resolve`, and the `tool.execute.before` hook snapshots `prompt`/`filePath` once (avoids getter/Proxy type flips).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.1**.

## [2.0.0] - 2026-08-08

### Harness

- **Bash SDD/rollup scripts removed (engine CLI is the documented path)**: `skills/mstar-sdd/scripts/{sdd-workspace,task-brief,review-package}` and `skills/mstar-plan-artifacts/scripts/tech-debt-rollup.sh` are deleted. Skill text now documents `mstar sdd workspace|task-brief|review-package` and the engine `techDebtRollup` import (`mstar status validate` remains the schema gate); parity tests compare engine output against stored golden fixtures captured from the byte-proven ports (slice 2).
- Added the **`@mstar-harness/engine`** package scaffold: a version-aligned workspace library (`zod` + `ajv`, `node:*` only, no `bin`) with a typed `ValidationResult` + `readHarnessVersion()` placeholder core, wired into the release surface list (10 → 11), changelog assembly, and root workspaces.
- **Engine hardening (QC fix wave, slice 1)**: lease location/orphan/dual-write verify (`lease.verify.*`) moved into `@mstar-harness/engine` (CLI `mstar lease verify` is now a thin wrapper); `archiveResiduals` gained a plan-id path-traversal guard, the status write lock, and append dedup; `withStatusWriteLock` gained an ownership guard (never removes another writer's lockdir), a `holder.pid` crash-diagnosis file, and fast-fail reentrancy detection; `readHarnessVersion` reads the module's own manifest first (published installs no longer regress to `0.0.0`); `tech-debt-rollup` parity now mirrors jq `//` exactly (`false`/`0` edges tested against the bash oracle); residual closed-lifecycle completeness (`closed_at` + `closure_note`) and plan-row `Done` ⇒ no-lease invariants added. Release prep now ensures the `@mstar-harness/engine` registry row + package-history link in root changelog heads.
- **Harness Workflow Engine positioning (iteration v2.0.0)**: unified engine-first descriptions across the 7 plugin manifests and the 4 package manifests; added `workflow-engine` / `workflow-enforcement` / `deterministic-workflow` / `harness-workflow` keywords to the root plugin manifest; re-framed README.md / README_CN.md around deterministic workflow gates enforced by a TS engine (not prompts alone) with judgment staying in `mstar-*` skills, plus a What-ships table (Harness Workflow Engine / mstar CLI / `mstar-*` skills / host adapters).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, `@mstar-harness/engine`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 2.0.0**.

## [1.8.9] - 2026-08-07

### Harness

- Added a portable **Agent Plugins v1.0.0** manifest (`plugin.json`) at the repo root, aligned with the CLI release surface (`skills/` is the Agent Skills component), plus `mstar-harness plugin validate` to check the package (including `mcp.json` / `skills/`) against the Agent Plugins v1.0.0 spec.
- **Phase 5 checkout**: merge-ready product fixes edit **directly** on the control / `spec_integration_branch` checkout; **forbid** opening a separate Phase 5 feature/fix worktree or applying Phase 2's "no product edits on control" rule. SSOT stays in `mstar-iteration` (`phase-4-5-pr-delivery` §5.0); **not** in the general `mstar-branch-worktree` skill.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ 1.8.9**.

## [1.8.8] - 2026-08-06

### Harness

- **`mstar-skill-authoring`**: fold the skill-writer 6 principles into the runtime authoring skill — expert process first, compact 5-question body, 1–3 skill routing, per model+harness validation, encode only model gaps, every edit as paired experiment. Body stays the executable gate; full writer loop / output template / anti-patterns → `references/skillsbench-authoring.md` (progressive disclosure).
- Tightened `description` trigger contract with exclusions; keep purpose test / frontmatter / progressive disclosure / review template as reusable SSOT.
- Reframe as **general** skill-authoring guidance (any domain/repo): drop Morning Star / `mstar-*`-only branding from body; keep minimal harness hooks (Load Order + `mstar-host` path resolve) only when working in this repo.
- Restored `## Skill-relative script and asset paths` heading so `mstar-host` § cross-reference stays valid (Post-Skill-Change stale-ref checklist).
- Keep changelog SSOT tight in `AGENTS.md`: §1 owns the fragment rule (including no hand-edit of assembled `CHANGELOG*`); Quality Gate #6 stays the executable check; remove copy-paste repeats elsewhere.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests: **→ 1.8.8**.

## [1.8.7] - 2026-08-06

### Harness

- Made the SDD dispatch templates **host-neutral** so they no longer prime a single host's tool schema: `implementer-prompt.md`, `task-reviewer-prompt.md`, and `implementer-continuation-prompt.md` now use `Dispatch:` / `Role:` / `Name:` / `Prompt body:` labels with an inline host-field map (`omp agent / Cursor subagent_type / OpenCode subagent → mstar-host C5`) instead of Cursor-only fields (`subagent_type`, `description`, `prompt`). The L2 task reviewer template now states the omp `agent` value directly (`reviewer` or `task` + C5b), closing the mapping confusion that produced generic-worker fallbacks under SDD.
- Trimmed the **envelope-first** rationale repeated across `mstar-host/references/omp.md` and `parallel-dispatch.md` to a one-line mechanical rule + SSOT pointer (the long-body prose was itself contributing to attention crowding), and added the L2 reviewer `agent` mapping to the omp SDD section.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests: **→ 1.8.7**.

## [1.8.6] - 2026-08-06

### Harness (dispatch fidelity — invoke field-completeness gate)

- Added a per-item **field-completeness gate** at the dispatch self-check: every Task/subagent invoke must carry the role-binding field matching `Execute as` (omp `agent` / Cursor `subagent_type` / OpenCode `subagent` / Kimi·ZCode `subagent_type`). A missing field (e.g. omp omitting `agent` ⇒ silent generic `task` fallback) is now **dispatch incomplete** — same severity as paste-only zero-invoke — so a bare `tasks:[{task:"…"}]` no longer passes just because invoke count = N. N=1 sequential Review-&-Edit chains are explicitly covered (count gate is vacuous there).
- `mstar-dispatch-gates`: pre-send self-check line + anti-pattern bullet; `mstar-host/references/parallel-dispatch.md`: hard rule + self-check step; `mstar-host/references/omp.md`: Review-&-Edit example now shows a full `task(...)` block per pass (architect / writing-specialist) with `agent` set, plus an N=1 gotcha.
- `.cursor/skills/mstar-routing-eval`: regression signal for "invoke role field missing ⇒ silent generic fallback".

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.6**.

## [1.8.5] - 2026-08-06

### Harness (skill path discovery — runtime surfaces)

- Closed remaining cwd-looking `skills/mstar-*` traps on **shipped runtime surfaces**: Cursor `rules/mstar-entry.mdc` and `rules/mstar-cursor-plan-mode.mdc`, plus omp CLI post-install note in `packages/cli/src/adapters/omp.ts` (now `mstar-host → references/omp.md` / `skill://…`).
- **`mstar-host`**: new § Resolve loaded skill root (per-host prefer + filesystem fallback: omp `skill://`, Cursor plugin checkouts, OpenCode `harness-skills/`, Codex/Kimi/ZCode plugin mounts). Host references point at the table; `mstar-skill-authoring` documents the same anti-pattern for rules/CLI notes.
- INSTALL / `docs/cli.md` Host adapter bullets use the same skill-relative form (not consumer-cwd `skills/mstar-host/references/…`).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.5**.

## [1.8.4] - 2026-08-06

### Harness (skill script path discovery)

- **Skill-relative script naming**: runtime docs now reference executables as skill **`mstar-sdd`** → `scripts/<name>` (or `<mstar-sdd>/scripts/…`), not as consumer-cwd paths like `skills/mstar-sdd/scripts/…`. Agents were searching the literal repo-relative path under app checkouts and missing the loaded skill / plugin install location.
- Updated `mstar-sdd` (SKILL + `file-handoffs`), `mstar-plan-artifacts` (`tech-debt-rollup`), `mstar-plan-conventions`, `mstar-iteration`, PM Assignment `SDD dir` cue, and `mstar-skill-authoring` (new “Skill-relative script and asset paths” convention).
- Maintainer `.cursor/LOCAL-VALIDATION.md` keeps `skills/…` smoke commands only for this harness repo root, with an explicit note.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.4**.

## [1.8.3] - 2026-08-05

### Harness (omp role-agent dispatch)

- **omp C5 corrected**: after plugin install/link, discovered `agents/*.md` role ids (`product-manager`, `architect`, `fullstack-dev`, `qc-specialist*`, …) are valid live `task.agent` values. Prefer **`agent: "<Execute as role-id>"`**; use generic `task` / `scout` / … only as fallback when the role is absent from the live schema. Using `agent: "task"` while the matching role agent is listed is an anti-pattern.
- **C5b retained**: even when `agent` already matches the role id, Assignment still requires **Act as + skill load** (agent shell ≠ full Morning Star role prompt).
- Updated `skills/mstar-host/references/omp.md` (self-contained C5 + C5b); `_shared/host-role-binding-core.md` is **Kimi/ZCode only** (no omp rows/mentions — other hosts use their own references), plus `parallel-dispatch.md` and `mstar-host` skill description; aligned INSTALL / `docs/cli.md`. Dropped the README “Host notes / 宿主说明” aside so the Use section stays entry-only.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.3**.

## [1.8.2] - 2026-08-05

### Docs (README + host detection)

- **README** (`README.md` + `README_CN.md`): reorder all host tables to the recommended host order (`omp > OpenCode > Cursor > Kimi = ZCode > Codex`); reorganize **Use** section into General (without iteration) → Iteration → Codebase audit.
- **`mstar-host`**: rewrite the host detection table to use **session tool shapes / available commands only** — `*-plugin/plugin.json` files cannot identify the host (they coexist in this source repo and in any multi-host install). Merge the duplicate Cursor detection rows into one keyed on `subagent_type`.
- **Host references**: strip the same plugin-marker clauses from the `Load when` trigger lines of `codex.md` / `kimi.md` / `zcode.md` / `omp.md`; keep tool-shape / observable-command signals only. Path-reference context lines and bridge `plugin is installed` prerequisites are left as documentation (not detection triggers).
- **omp**: document native internal URL schemes (`skill://`, `local://`, `agent://`, `artifact://`, `history://`) in `references/omp.md`.

### CLI

- `zcode` adapter no longer hardcodes a `PLUGIN_VERSION` constant (it had drifted to `1.6.0`). Marketplace entry generation and `doctor`'s ZCode version check now derive the version from `packages/cli/package.json` via a shared `readHarnessVersion()` helper in `utils.ts` (same helper `index.ts` now uses for `--version`). Fixed stale `1.5.6`/`1.6.0` version strings in `INSTALL.md` and the ZCode adapter.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.2**.

## [1.8.1] - 2026-08-05

### Harness (skills + commands optimization)

- **Lossless optimization** of `skills/` and `commands/` per SkillsBench principles (compact bodies, progressive disclosure, dedup to SSOT). No rule, gate, field name, or NEVER bullet altered or dropped — rules move or compress, never disappear.
- **Extract to `references/`**: `mstar-iteration` Phase 3 → `phase-3-iteration-close.md`, Phase 4/5 → `phase-4-5-pr-delivery.md` (body 574 → 384 lines); `mstar-compound` Q1–Q8 + Phase 1–7 → `compound-workflow.md` (275 → 103).
- **Compress**: `mstar-coding-behavior` 216 → 142 (kept The Ladder, `simplify:` marker, minimal-check); `qc-specialist/deep-review-lenses.md` 11 lens checklists → one-liners (155 → 94).
- **Dedup**: anti-pattern lists → `mstar-harness-core` index; new `_shared/leaf-executor-core.md` (Completion Report + Git NEVER across 9 leaf roles); new `_shared/host-role-binding-core.md` + `_shared/plan-mode-bridge-core.md` (de-clone kimi/zcode/omp host files + 5 plan-mode bridges).
- **Commands → thin orchestrators**: 4 commands 943 → 388 lines (−59%); new `mstar-iteration/references/phase5-helper-discovery.md`.
- **Descriptions**: tightened `coding-behavior`, `branch-worktree`, `phase-gates` frontmatter to trigger contracts.
- **Docs**: recommended host order added to `README.md` + `README_CN.md` (`omp ≥ OpenCode ≥ Cursor > Kimi = ZCode > Codex`).
- **Naming**: `Completion Report v2` → `Completion Report` (template unified; version suffix dropped).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.1**.
## [1.8.0] - 2026-08-05

### Harness (codebase audit skill)

- **New `mstar-audit` skill**: read-only advisory workflow adapted from the [improve](https://github.com/shadcn/improve) skill (MIT, © shadcn). Surveys a repo across 9 categories (correctness, security, performance, tests, tech debt, dependencies, DX, docs, direction), vets findings, prioritizes by leverage, and writes self-contained improvement plans to `{PLAN_DIR}/audit-<date>/`. The `improve` `execute`/`reconcile`/`--issues` variants are not imported — mstar's SDD, `status.json`, and residual tracking replace them.
- **New `plan-quality-bar` reference** (`mstar-plan-artifacts/references/plan-quality-bar.md`): shared standard for self-contained plans — verification gates, STOP conditions, drift check, machine-checkable done criteria. Applies to SDD task-briefs, Prepare plans, and audit plans.
- **New `/codebase-audit` command** (`commands/codebase-audit.md`): standalone entry point. Named with `codebase-` prefix to avoid host command conflicts (follows the `iteration-*` convention). Wiring: `mstar-harness-core` Task category `audit` + skill index; `mstar-phase-gates` Plan quality gate; `mstar-sdd` references; `mstar-roles` architect load entry; `pm` skill entry; `iteration-start` §1 Research optional source.
- **Attribution**: improve (MIT, © shadcn) credited in `mstar-audit/SKILL.md` and `plan-quality-bar.md`.

### CLI (`@mstar-harness/cli`)

- **Codex adapter**: `CODEX_PROJECT_COMMAND_NAMES` (renamed from `CODEX_ITERATION_SKILL_NAMES`) now includes `codebase-audit`; project-scoped install materializes it as `.agents/skills/codebase-audit/SKILL.md`.
- **omp adapter**: smoke test and install notes include `codebase-audit`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.0**.

## [1.7.1] - 2026-08-05

### CLI (`@mstar-harness/cli`)

- **omp doctor**: parse `omp plugin list --json` shape `{ npm, marketplace }` (omp 17.x) instead of only array/`plugins`, and match `manifest.name`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.7.1**.

## [1.7.0] - 2026-08-05

### Harness (omp host surface)

- **omp as sixth host surface**: markers `.omp-plugin/plugin.json` + `.claude-plugin/plugin.json` (plugin root = repo root; mounts `./skills/`, `./commands/`, `./agents/`). New `skills/mstar-host/references/omp.md` covering `task`/`ask`/`hub`, filename slash commands (`/iteration-*`), and C5/C5b built-in `task.agent` + role-in-prompt binding. `omp-plan-mode-bridge.md` for `/plan` dual-write. `mstar-host` detect table + `pm` entry + `parallel-dispatch` updated.
- Install: `omp plugin install github:btspoony/mstar-harness` or `omp plugin link` of the local harness checkout; package list name is root `morning-star`.

### CLI (`@mstar-harness/cli`)

- **`omp` install target**: `npx @mstar-harness/cli init --target omp` ensures `~/.mstar/harness` and runs `omp plugin link` (falls back to `omp plugin install github:btspoony/mstar-harness`). `doctor --target omp` checks markers, smoke skills/commands, and `omp plugin list`. `shared-install` `HARNESS_MARKERS` accepts `.omp-plugin/plugin.json`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.7.0**.

## [1.6.1] - 2026-08-04

### Harness (QC = code reviewer, not test runner)

- **L3 Plan QC clarified as diff/logic review**: `mstar-review-qc` boundaries + `qc-specialist*` workflow/shared NEVER — parallel tri-review on a shared `Review cwd` must **not** run test/build/install/lint/typecheck (peer QC `Blocked` from toolchain contention). Coverage is judged from the **diff**, not by re-running suites.
- **L1 / L4 own runtime evidence**: QA `acceptance-only` reuses implementer/CI/prior-QA logs; QC reports are findings, not the test log. PM Assignment anti-patterns and `qa-trigger-matrix` updated accordingly.
- **OpenCode `qc-specialist*` agents**: bash allowlist trimmed to git + lightweight read-only analysis (removed eslint/tsc/ruff/clippy/etc.).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode plugin manifests: **→ 1.6.1**.

## [1.6.0] - 2026-08-03

### Harness (ZCode host surface)

- **ZCode as fifth host surface**: plugin root = repo root via `.zcode-plugin/plugin.json` (mounts `./skills/`, `./commands/`, `./agents/`); no `sessionStart` (ZCode lacks it — PM entry is manual `/morning-star-harness:pm`). New `skills/mstar-host/references/zcode.md` with tool map written against the real ZCode session tools (`Agent` / `AskUserQuestion` / `EnterPlanMode`·`ExitPlanMode` / `TodoWrite` / `Bash` / `Read` / `Edit` / `Write` / `WebSearch` / `WebFetch` / `TaskOutput`·`TaskStop`), reusing Kimi **C5b role-in-prompt binding** (ZCode ships built-in `subagent_type` profiles only). `zcode-plan-mode-bridge.md` for Enter/Exit dual-write.
- **`mstar-host` SKILL.md**: description, detect-host table, and fallback row now include ZCode.

### CLI (`@mstar-harness/cli`)

- **`zcode` install target**: `npx @mstar-harness/cli init --target zcode` registers a `mstar-local` marketplace in `~/.zcode/cli/plugins/known_marketplaces.json` + `marketplaces/mstar-local/marketplace.json`, both pointing at the **`github:btspoony/mstar-harness`** repo source (matches ZCode's built-in marketplace source shape). Project scope also keeps a local `.zcode/plugin-checkout` for agent-file smoke checks. `doctor --target zcode` validates both JSON files + checkout + gitignore. `shared-install` `HARNESS_MARKERS` now also accepts `.zcode-plugin/plugin.json`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode plugin manifests: **→ 1.6.0**.

## [1.5.6] - 2026-07-28

### Harness (residuals)

- **`Findings cleanup: zero-residual | allow-residual`**: plan-level mode to clear QC/QA findings in-session when possible. Formal **iteration Phase 2** defaults to **`zero-residual`** (fix-now + re-review; open R# only for true blocker-defer + Durable Roadmap). Standalone `/pm`, hotfix, and `inline` keep **`allow-residual`**.
- Assignment field + optional `plans[].metadata.findings_cleanup`; SSOT in `mstar-plan-artifacts` Findings cleanup modes; wired through `mstar-review-qc`, PM NEVER / Assignment template, iteration close checklist, QA trigger note, and routing-eval cases.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.6**.

## [1.5.5] - 2026-07-27

### Harness (worktree / L1)

- **Control-path harness under default gitignore**: process artifacts (`plans/`, `iterations/`, `status.json`, `sdd/`, …) stay local; read/write them via absolute **control worktree** paths. Feature worktrees keep product/source edits only — do **not** waive worktree because feature checkouts lack plans, and do **not** treat “no flock” as a worktree waiver (serial plan parallelism only).
- Assignment fields: absolute **`Control harness root`**, control **`Plan Path`** / **`SDD dir`**, feature **`Worktree path`**.
- **`sdd-workspace`**: `MSTAR_CONTROL_ROOT` / optional control-root arg; fail-closed on linked worktrees without `status.json`.
- Routing-eval cases for no-flock serial + gitignore control-path harness.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.5**.

## [1.5.4] - 2026-07-27

### Harness (Cursor host)

- **`mstar-host` Cursor Task invoke schema**: document flat sibling fields (`prompt` + `subagent_type` + `description`) with examples, anti-patterns (nested/stringified JSON, OpenCode `subagent`, MCP wrap, missing `subagent_type`), and a send-time self-check — reduces first-attempt Task parameter-format failures. Pointer from `parallel-dispatch.md`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.4**.

## [1.5.3] - 2026-07-25

### Harness (commands / frontmatter)

- **Frontmatter YAML**: quote `description` fields that contain `: ` so Cursor/plugin discovery does not drop commands/skills (`iteration-loop`, `mstar-branch-worktree`, `mstar-phase-gates`, `mstar-plan-artifacts`, `mstar-review-qc`, `mstar-sdd`).
- **`/iteration-loop` scale**: add **`XL`** = **>4** business plans (`S`/`M`/`L`/`XL`; default still `M`). SSOT: `mstar-iteration` §1.2 + `references/autonomous-direction-lock.md`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.3**.

## [1.5.2] - 2026-07-23

### Harness (git policy + SPECS_DIR)

- **Process vs results git policy**: default tracked under `{HARNESS_DIR}` — `AGENTS.md`, `knowledge/`, `specs/`; default gitignored — `plans/`, `iterations/`, `status.json`, `sdd/`, `archived/`, `notes.json`. Cross-clone handoff = tracked results + root `CONCEPTS.md` / `STRATEGY.md`; promote residuals via compound instead of default `git add` for `status.json` / `plans/`.
- **`{SPECS_DIR}` resolve order**: `{HARNESS_DIR}/specs/` → `docs/specs/` → repo-root `specs/` (skip empty dirs; greenfield creates `{HARNESS_DIR}/specs/`). Legacy read-compat: non-empty `designs/` paths.
- Aligned: `mstar-plan-conventions`, `mstar-plan-artifacts`, `mstar-sdd` file-handoffs, host Plan-mode bridges, bilingual README, `.cursor/LOCAL-VALIDATION.md`.
- **CLI**: `init`/`doctor` append/check the full process gitignore set (see `packages/cli/CHANGELOG.md`).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.2**.

## [1.5.1] - 2026-07-22

### Harness (Phase 5 push cadence)

- **Phase 5 push cadence (HARD)**: CI/review findings may be fixed **locally early**, but **`git push` only after** the previous CI **and** review wave on the current head have **fully completed**. After CI settles, new reviews may continue to be fixed locally; **never push while CI is still running** (cancels/orphans AI reviews — wasted tokens, incomplete results). SSOT: `mstar-iteration` §5.1a; aligned `iteration-drive` / `iteration-loop`; core anti-pattern row.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.1**.

## [1.5.0] - 2026-07-22

### Harness (iteration Phase 2 worktree + lease)

- **Phase 2 control worktree** on `spec_integration_branch` plus per-plan **feature worktree** with `execution_lease` / `integration_merge_lease` (same-host exclusive write lock; serial integration merge; `Done` only after successful merge).
- Multi-session cross-plan parallel implement under leases; `Worktree mode: waived` does **not** bypass the cross-plan parallel safety gate; `Plan parallelism: serial` is scheduling-only.
- Routing-eval updates for lease-gated multi-plan parallel and failure modes; bilingual README Phase 2 defaults.

### Harness (Phase 5 helpers)

- **Phase 5 merge-ready helpers**: prefer `babysit` or any `*-babysit` skill; `greploop` is **optional** only when the repo has Greptile/`greploop`. When both apply, run babysit/`*-babysit` first, then optional greploop. Updated `mstar-iteration` §5 pointer + `commands/iteration-drive` / `iteration-loop`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.0**.

## [1.4.0] - 2026-07-17

### Harness (Kimi Code host)

- **Kimi host support**: `.kimi-plugin/plugin.json` (host-folder layout aligned with Cursor/Codex; `sessionStart.skill: pm`); `mstar-host` Kimi reference / Plan-mode bridge; role binding in Agent prompts (built-in `coder` / `explore` / `plan` only).
- **Install**: primary path is Kimi TUI `/plugins install https://github.com/btspoony/mstar-harness` then `/plugins reload` (no CLI `--target kimi`).
- Plugin commands: `/morning-star-harness:iteration-start` · `iteration-drive` · `iteration-loop`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.4.0**.

## [1.3.2] - 2026-07-15

### Harness (Cursor Plan Phase 1 feedback-driven)

- **`/iteration-start` Cursor Plan path**: feedback-driven loop — user gives direction/opinions only; agent explores, recommends, and updates the plan. `grill-me` is deferred until feedback-close and only if blocking gaps remain.
- **Single CreatePlan URI (HARD)**: CreatePlan once per Phase 1 Plan session; subsequent updates edit that same file in place; merge and delete accidental duplicates.
- **`mstar-host` / rule / `mstar-iteration` §1.2**: Phase 1 Plan UX documents feedback-driven updates and recommended branch policy (no silent `main`/`master`).
- **Routing eval v20**: `iteration-phase1-cursor-plan-feedback-driven`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.3.2**.

## [1.3.1] - 2026-07-13

### Harness (iteration package layout)

- **`iterations/<id>/` directory-first**: compass moves to `{ITERATION_DIR}/<iteration-id>/delivery-compass.md` with sibling `guides/` / `specs/` / optional package `README.md`. Root `{ITERATION_DIR}/README.md` indexes **one row per iteration** (no compass + workspace double entries).
- **Legacy read compat**: flat `{ITERATION_DIR}/<id>-delivery-compass.md` remains readable; new writes must use the package path.
- Touches: `mstar-iteration` (+ references), `mstar-compound` package promotion, `mstar-plan-conventions` / `mstar-plan-artifacts` path docs, role shells, `/iteration-start` · `/iteration-drive` · `/iteration-loop`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.3.1**.

## [1.3.0] - 2026-07-11

### Harness (bootstrap absorb)

- **Retire `/mstar-bootstrap` command**: the 7-phase project knowledge bootstrap procedure moves to `mstar-compound-refresh/references/project-knowledge-bootstrap.md`; `mstar-compound-refresh` and `mstar-harness-core` carry short pointers.

### CLI (Codex iteration skills)

- **Project-scoped Codex install**: materializes `iteration-start`, `iteration-drive`, and `iteration-loop` as `.agents/skills/*/SKILL.md` symlinks from bundled harness commands; `doctor` validates links; global install skips with an explicit warning.

### Docs

- **Root `INSTALL.md`**: machine-readable install steps extracted from READMEs.
- **Slim bilingual READMEs**: CLI-first Quick Start; clarify `/iteration-start` → `/iteration-drive` vs `/iteration-loop` usage paths.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.3.0**.

## [1.2.1] - 2026-07-10

### Harness (Cursor Plan mode × Phase 1 staged direction lock)

- **`/iteration-start` Cursor Plan path**: after Boot, Plan mode creates a blank Phase 1 CreatePlan scaffold first, then runs dynamic staged `grill-me` that updates the plan each stage; Review & Edit / lock / integration branch run only after **Build**. Agent / OpenCode keep Research → Explore → grill-me → Write → Review.
- **`mstar-host` Cursor bridge / rule**: document `mstar-iteration` Phase 1 in Plan mode (no command-name reverse refs in skills).
- **`mstar-iteration` §1.2**: host Plan UX may scaffold then converge interactively; non-Plan hosts unchanged.
- **Routing eval v19**: `iteration-phase1-cursor-plan-staged-grill`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.2.1**.

## [1.2.0] - 2026-07-10

### Harness (`/iteration-loop` + autonomous direction lock)

- **`/iteration-loop`**: new PM command for autonomous full Phase 1→5 (cloud-agent friendly). Optional args `direction` + `scale` (`S`\|`M`\|`L`, default `M`); code-first auto direction lock (no grill-me); sequential Review & Edit chain retained; Continuous execution through Phase 5 merge-ready. Distinct from `/iteration-start` (Phase 1 + grill-me) and `/iteration-drive` (Phase 2→5 only).
- **`mstar-iteration` §1.2**: direction lock modes `interactive` | `autonomous`; scale budget counts **business plans only** (harness process excluded); autonomous branch resolve order. Detail → `references/autonomous-direction-lock.md` (skills remain capability providers — no command-name reverse refs).
- **Docs**: README / README_CN / OpenCode package README command tables distinguish start / drive / loop.
- **Routing eval v18**: `iteration-loop-autonomous-direction-lock` — no routine direction yes/no; no grill-me; no silent `main` default; no process plans in scale budget.

### CLI / CI / release

- **OpenCode `init` fast path**: no interactive model picking and no `opencode models` discovery (that call could hang with no feedback). Default writes `$schema` + `@mstar-harness/opencode@latest` only; OpenCode default models apply. Optional `--*-model` flags remain as advanced overrides.
- **CI**: path-filtered builds for `packages/cli`, `packages/opencode`, and bundled `skills`/`agents`/`commands`; includes CLI smoke check + pack.
- **Release**: use Node 24 bundled npm for Trusted Publishing; remove broken `npm install -g npm@latest` on Node 22 (fixes `MODULE_NOT_FOUND: sigstore`); build packages before publish.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.2.0**.

## [1.1.0] - 2026-07-08

### Harness (ephemeral review bundles)

- **Review bundle default**: raw QC/QA process reports now live under `{SDD_DIR}/review/` (gitignored), while tracked handoff artifacts are durable main-plan gate summaries and `{HARNESS_DIR}/status.json` residual findings.
- **Legacy tracked reports**: `{PLAN_DIR}/reports/` is now legacy / explicit audit mode only, not the default QC/QA report target.
- **Iteration compass**: add a `Quality Gate Summary` section for iteration-level QC/QA verdict and residual rollups without replacing per-plan summaries or `status.json`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.1.0**.

## [1.0.6] - 2026-07-08

### Harness (SDD per-task reviewer dispatch)

- **`mstar-sdd`**: pin L2 per-task reviewer to **`subagent_type: generalPurpose`**; forbid `qc-specialist*` at task scope (plan QC tri remains L3 after all tasks).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.6**.

## [1.0.5] - 2026-07-07

### Harness (tiered QA gate + role-scoped QC/QA refs)

- **Tiered QA gate** (`mandatory` | `pm-acceptance` | `report-only`) with PM dispatch matrix (`qa-trigger-matrix.md`); hotfix/small clean backend defaults to `pm-acceptance`; medium+, UI, and residual work still requires mandatory QA.
- **L4 acceptance narrowing** (`qa-engineer/acceptance-gate.md`): evidence reuse from QC consolidated output; no default full test re-run when `QA mode: acceptance-only`.
- **Role-scoped execution refs**: leaf QC → `mstar-roles/references/qc-specialist/`; L4 QA → `qa-engineer/`; **`mstar-review-qc`** slimmed to PM orchestration only.
- **Positive-only skill load lists** per role (what to read) — avoid priming leaf agents to load `mstar-review-qc`.
- **Routing eval v17**: hotfix/small-backend `pm-acceptance`; UI remains `mandatory`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.5**.

## [1.0.4] - 2026-07-07

### Harness (parallel implement worktree gate)

- **New `mstar-branch-worktree/references/parallel-writable-pre-dispatch.md`**: SSOT pre-dispatch checklist for same-repo **≥2 concurrent writable implement** tracks — `git worktree add`, absolute **`Worktree path`**, PM stays on integration branch, emit-zero until ready.
- **`mstar-dispatch-gates`**: **Dual-gate table** — tool concurrency (N invokes in one message) vs same-repo write isolation; clarifies **N invoke ≠ worktree compliance**.
- **`mstar-branch-worktree`**, **`mstar-iteration`**, **`mstar-phase-gates`**, **`project-manager`**, **`dispatch-and-assignment`**, **`fullstack-dev-shared`**: thin pointers to the reference; deduped repeated checklist prose.
- **`mstar-harness-core`**: anti-pattern index entry for parallel implement without worktree.
- **Routing eval v16**: hard-fail parallel implement batches missing per-track **`Worktree path`**; strengthen worktree assertions on parallel dev cases.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.4**.

## [1.0.3] - 2026-07-07

### Harness (iteration continuous execution)

- **`iteration-drive`**: Add **Continuous execution (HARD)** for Phase 2–5 — no routine yes/no check-ins after progress reports; turn must end with in-flight dispatch; per-plan serial implement loop; explicit legal STOP boundaries.
- **`mstar-iteration` §2.6**: Expand **Push discipline (Autonomous Execute)** — continuous execution through Phase 5 merge-ready exit; no confirmation questions between tasks, plans, or phases.
- **`pm` skill**: Restore **Autonomous Execute push** as rule 4; iteration semantics SSOT → **`mstar-iteration`** only (no command names in runtime skills).
- **Skills command-agnostic cleanup**: Remove `iteration-drive` references from runtime `mstar-*` skills (host refs, project-manager, sticky implementer, dispatch-and-assignment).
- **Routing eval v15**: Hard-fail mid-execute user check-ins; new `iteration-drive-continuous-after-plan-wave` case.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.3**.

## [1.0.2] - 2026-07-07

### Harness (iteration artifact boundaries)

- **`mstar-iteration` §1.5.5 / §1.6**: Tighten Phase 1 boundaries — `{SPECS_DIR}/` for locked long-lived specs; `{ITERATION_DIR}/<iteration-id>/` workspace (`guides/`, `specs/`) for iteration-scoped drafts; **no** `{KNOWLEDGE_DIR}/` writes during iteration-start.
- **`iteration-start` / `mstar-dispatch-gates`**: Review & Edit chain — product-manager / architect edit specs + workspace; writing-specialist **specs corpus hygiene** and existing-knowledge archive only.
- **`mstar-compound`**: Mandatory **iteration workspace promotion** at iteration-close — inventory `<iteration-id>/` workspace; promote worthy specs/guides to `{KNOWLEDGE_DIR}/` (structured rewrite, not raw copy).
- **New references**: `iteration-artifact-boundaries.md`, `iteration-corpus-hygiene.md`, `iteration-workspace-readme-template.md`; `knowledge-and-designs.md`, role refs, and `artifact-storage-paths.md` aligned.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.2**.

## [1.0.1] - 2026-07-07

### Harness (SDD iteration-drive + sticky implementer + pm shim)

- **`iteration-drive` / `mstar-iteration`**: Phase 2 explicitly mandates per-task SDD loop (`mstar-sdd` in Boot, `task-brief` → implementer → `review-package` → task reviewer); forbids bulk inline implement Assignments for multi-task plans.
- **Sticky implementer session** (`SDD implementer session: sticky`): optional same dev subagent across tasks via host resume (Cursor Task `resume`); `implementer-session.json` ledger; **task reviewers stay fresh** per task. Docs: `mstar-sdd/references/sticky-implementer-session.md`, `implementer-continuation-prompt.md`.
- **`pm` skill**: thinned to cross-host entry shim (Codex/Cursor `/pm`); iteration lifecycle Boot lives in **`commands/`**; SSOT → `project-manager.md` + topic skills.
- **Assignment / dispatch**: `dispatch-and-assignment.md` SDD vs inline table; `SDD implementer session` field on template.
- **Routing eval v14**: iteration Phase 2 SDD hard-fails; new `sdd-sticky-implementer-multi-task` case.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.1**.

## [1.0.0] - 2026-07-07

### Harness (SDD + plan QC tri-review)

- **New `mstar-sdd` skill**: file handoff, per-task implementer + **task reviewer** (L2), progress ledger under `{SDD_DIR}`.
- **Plan QC with SDD**: **mandatory tri-review** (QC#1/#2/#3 cross-review on branch diff, **N=3**) when **`Execution mode: sdd`** — single-plan **and** iteration. **Not** a lone final single-seat review.
- **Single-seat `qc.md`**: only `Execution mode: inline` / hotfix or explicit user override.
- **Plan template**: `plan.main.md` with Global Constraints, per-task Interfaces, self-review gate; `status.json` optional `sdd_dir`, `task_commits[]` metadata.
- **PM Assignment**: `Execution mode`, `SDD dir`, `Model tier`; implement default SDD for multi-task plans.
- **CLI**: project `init`/`doctor` append/check `.mstar/sdd/` gitignore entries.
- **Routing eval v11**: SDD + mandatory tri-review; inline/hotfix single-seat.

### Breaking changes

1. Multi-task implement defaults to **`Execution mode: sdd`** (single-plan and iteration).
2. **With SDD**: plan QC is **mandatory tri-review** (QC#1/#2/#3); per-task review is **task reviewer**, not QC.
3. **Single-seat `qc.md`** only for `inline` / hotfix or explicit override.
4. New plans: **Global Constraints** + per-task **Interfaces**.
5. `.mstar/sdd/` ephemeral scratch — gitignore required.

### Superpowers v6 note

Mstar adds L2 **task reviewer** per task; L3 **tri cross-review** retained (not v6's single final reviewer only). See `.harness/specs/sdd-1.0.0-design.md`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.0.0**.

## [0.7.9] - 2026-07-06

### Harness (Assignment plain role ids / OpenCode `@` hygiene)

- **Assignment SSOT**: `dispatch-and-assignment.md` template, PM routing table, and `project-manager.md` Language rule — all role references in Assignment **body** use **plain role ids** (no `@`); host invoke uses task tool **`subagent`** matching `Execute as`.
- **`mstar-dispatch-gates`** and **leaf-executor checklist**: anti-recursion NEVER rules reworded to `role-id` mentions (not `@<role>` literals).
- **`mstar-host/references/opencode.md`**: Role-mention hygiene — Assignment prose vs task-tool dispatch; warnings avoid `@` literals that trigger OpenCode auto-dispatch.
- **Iteration commands**, **`mstar-branch-worktree`**, **`mstar-plan-artifacts`** (plan checkbox duties), **`pm` skill**, and **role NEVER** references aligned on plain ids.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.8 → 0.7.9**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.8] - 2026-07-06

### Harness (iteration Phase 4–5 / PR merge-ready loop)

- **`mstar-iteration` Phase 4–5**: Extend lifecycle to **PR delivery** (Phase 4) and **PR merge-ready loop** (Phase 5) — verify/fix/re-verify until mergeable, required CI green, and review threads resolved (with per-thread comment + resolve after fixes). Loop SSOT stays in `mstar-*`; no back-reference to host commands.
- **`iteration-drive`**: Sequences Phase 2 → 3 → 4 → 5; **Done** only after Phase 5 exit checklist. Optionally discovers **non-`mstar-*`** helper skills (`greploop`, `babysit`) for Phase 5; fallback mode matches babysit gates (CI + reviews).
- **`mstar-harness-core`**: Iteration lifecycle index and anti-pattern for skipping Phase 5 after PR creation; PM load contract covers `mstar-iteration` Phase 1–5.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.7 → 0.7.8**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.7] - 2026-07-04

### Harness (standalone `mstar-*` / decouple third-party runtime)

- **Standalone harness invariant** (`mstar-harness-core`): `mstar-*` skills must not require external skills, CLIs, or MCPs in load order; library/API questions use in-repo Read/Grep first.
- **Bundled `grill-me` for `/iteration-start` only**: added `skills/grill-me/SKILL.md`; command §3 is the sole reference — not in `mstar-*` index or load matrix. `mstar-iteration` §1.2 adds generic **Direction lock** without naming grill-me.
- **Removed third-party coupling from runtime paths**: deleted `library-docs-protocol.md` (Context7), `openviking-memory-plugin.md` (OpenViking); removed Context7 section from `mstar-host`; Open Design integration from `mstar-design-md`; optional MCP table from `mstar-host/references/opencode.md`.
- **`open-harness-principles.md` distilled**: harness terminology table moved into `mstar-harness-core`; AGENTS.md layering → `mstar-plan-conventions/references/harness-bootstrap-and-agents-layering.md`; file removed.
- **`mstar-roles`**: keep **Role → typical topic skills** cross-role matrix; topic index remains in `mstar-harness-core`. **`prompt-engineer`** retains **`skill-creator`** requirement for new/major skill work (`AGENTS.md` documents standalone exception).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.6 → 0.7.7**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.6] - 2026-07-01

### Harness (iteration dispatch / commands–skills layering)

- **Commands vs skills layering**: `iteration-start` and `iteration-drive` own orchestration (boot order, phase state machine, step checklists); `mstar-iteration` and `mstar-dispatch-gates` stay command-agnostic. Removed circular skill ↔ command references.
- **`iteration-start` / `iteration-drive`**: PM invariants, Phase 2→3→PR transition gates, dispatch-turn discipline, Phase 3 PR precondition; `phase-3-iteration-close` host todo when one plan remains.
- **`mstar-iteration`**: Phase transition gates table; §2.5 dispatch-turn rules; compass template fields keyed by Phase 1–3 (not command names).
- **`mstar-dispatch-gates`**: **Specialist review-and-edit dispatch** (generic); Phase 1 chain is **sequential**; anti-patterns for paste-only dispatch and skipped Phase 3.
- **`mstar-host`**: Removed Mode A/B/C supplemental execution paths; canonical invoke dispatch with **`Blocked`** when no callable tool; `codex.md` and `parallel-dispatch.md` aligned.
- **`pm` skill**: Iteration sections deduplicated — single pointer to `mstar-iteration`.
- **Phase 1 Review & Edit chain**: **Sequential** `product-manager` → `architect` → `writing-specialist` (each invoke after prior role’s disk revisions); parallel batch forbidden for this chain.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.5 → 0.7.6**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.5] - 2026-07-01

### Harness (iteration / branch policy)

- **Explicit iteration branch policy**: Formal iterations require recorded `iteration_base_branch`, `spec_integration_branch`, and `target_branch` in compass frontmatter and `status.json` metadata. Agents must not silently default to `main` / `master` for integration branch creation or final PR targets.
- **`iteration-start` / `iteration-drive`**: Grill-me branch confirmation, pre-commit checklist branch fields, §2.0 branch metadata gate, and explicit `git checkout -b <spec_integration_branch> <iteration_base_branch>` when creating the integration branch.
- **`mstar-iteration` §2.3**: Metadata resolution chain (`status.json` → compass frontmatter → ask user); QC `Review range` merge-base uses `target_branch` or PM-specified ref.
- **Compass template**: Add `## Delivery Branch Policy` section; `status-and-residuals.md` documents example metadata JSON.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.4 → 0.7.5**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.4] - 2026-07-01

### Harness (skills / docs)

- **Remove Superpowers dependency from Morning Star runtime**: removed Superpowers install guidance and alignment wording; Morning Star assignments now rely on native dispatch, worktree, plan, review, and evidence contracts.
- **Consolidate execution practices into `mstar-coding-behavior`**: deleted `mstar-execution-practices`; moved review feedback handling into `mstar-coding-behavior`; RCA, test-first checks, and completion evidence now stay in coding behavior while PM gate evidence remains in `mstar-phase-gates` / `mstar-review-qc`.
- **Add `mstar-skill-authoring`**: new Morning Star-native skill authoring guidance for trigger contracts, progressive disclosure, pressure scenarios, and behavior-change evidence. The prompt-engineer role must read it before creating skills, major rewrites, or trigger-description changes.
- **Docs and host adapters**: README / README_CN, OpenCode install docs, role references, and host references no longer require external skill plugins.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.3 → 0.7.4**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.3] - 2026-06-30

### Harness (iteration-close / commands / docs)

- **`mstar-iteration` Phase 3 close gate**: iteration-close is now an explicit independent phase after all plans are `Done`; final plan closure can provide input but does not satisfy close. Close requires compass shape normalization when needed, close entry/exit checklists, compound round, roadmap update, compass frontmatter `status: completed` + `end_date`, and integration-branch commit before PR.
- **Compass template hardening**: New compass templates no longer prefill `end_date`; `## Roadmap Position`, `## Compound Round Summary`, and `## Iteration Retrospective (minimal)` are the expected close-write targets. Legacy prose completion status must be normalized into YAML frontmatter during close.
- **Compound indexing gate**: Each new knowledge doc created in an iteration-close compound round must complete `mstar-compound` Phase 6 and be registered in `{KNOWLEDGE_DIR}/README.md`, including lightweight captures.
- **README / README_CN**: Harness Commands now list `/mstar-bootstrap`, `/iteration-start`, and `/iteration-drive`; Harness Workflow now reflects `iteration-start → per-plan execute loop → iteration-close → PR`; Core Skills table now includes iteration, design, compound, compound-refresh, and strategy skills.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.2 → 0.7.3**. **`@mstar-harness/cli` remains 0.5.4**.

## [0.7.2] - 2026-06-30

### CLI / Cursor install

- **Cursor plugin path layout**: `mstar-harness init --target cursor` now installs a **real git checkout** at the Cursor plugin path (`git clone` / `git pull`), not a symlink to `~/.mstar/harness`. Cursor does not discover symlinked plugin directories.
- **`doctor --target cursor`**: fails if the plugin path is a symlink; `init` removes an existing symlink and clones.
- **Docs**: `docs/cli.md` § Install path layout; README/CN manual install and maintainer refresh notes updated.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.1 → 0.7.2**. **`@mstar-harness/cli`**: **0.5.3 → 0.5.4**.

## [0.7.1] - 2026-06-30

### Harness (skills / iteration-start)

- **`/iteration-start` Review & Edit chain hard gate**: Step 5 is mandatory before integration branch commit — dispatch `@product-manager`, `@architect`, and `@writing-specialist` via Task (parallel when independent); PM thread must not substitute by performing all specialist edits itself. Done = edited compass/plans/specs + compass `status: locked`, not draft artifacts on disk.
- **`mstar-iteration` §1.6**: Documents the review chain as an integration-branch precondition (skill SSOT); no separate `reports/<iteration-id>/` review files — unlike per-plan QC, iteration review has no downstream audit chain.
- **`skills/pm`**, **`mstar-dispatch-gates`**, **`mstar-harness-core`**: iteration-start dispatch-first rules, anti-patterns, and pre-commit checklist aligned with command §5.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.7.0 → 0.7.1**. **`@mstar-harness/cli` remains 0.5.3**.

## [0.7.0] - 2026-06-30

### Harness (skills / iteration, compound, strategy, qc, commands)

- **New `mstar-compound` skill**: Knowledge crystallization with Bug/Knowledge dual-track templates, YAML frontmatter schema, 8-question self-diagnosis checklist, overlap detection (update existing docs rather than create duplicates), discoverability check (propose AGENTS.md edits), and CONCEPTS.md vocabulary synergy. Compound executes at **iteration-close**, not per-plan Done.
- **New `mstar-compound-refresh` skill**: Knowledge maintenance — audit/update/consolidate/replace/delete knowledge docs against current codebase, CONCEPTS.md reconciliation.
- **New `mstar-strategy` skill**: STRATEGY.md creation and maintenance as project upstream anchor (vision, technology direction, guiding principles, decision log).
- **New `mstar-iteration` skill**: Full iteration lifecycle management — Phase 1 iteration-start (scope/roadmap lock, compass creation), Phase 2 Autonomous Execute (per-plan dispatch loop: branch → implement → QC → QA → Done → merge, cross-plan progress sync), Phase 3 iteration-close (compound round, roadmap update, retrospective, commit). Autonomous Execute driver moved here from `skills/pm/SKILL.md`; PM skill thinned to role identity, host entry, and dispatch-first rules only.
- **New `/mstar-bootstrap` command**: Distills STRATEGY.md, CONCEPTS.md, and baseline knowledge docs from existing codebase for projects with no/stale knowledge infrastructure (7-phase flow).
- **New `artifact-storage-paths.md`**: Single SSOT for all harness artifact paths under `mstar-plan-conventions`, referenced by all producing skills to prevent path drift.
- **QC deep review lenses**: Replaced persona subagent dispatch with self-applied lens checklists (12 lenses, 6 trigger signals). No subagent dispatch — resolves anti-recursion violation with `mstar-dispatch-gates`.
- **Updated index**: `mstar-harness-core` split lifecycle into per-plan and iteration-level cycles; all skill index tables, `mstar-roles` dependency matrix, and `mstar-phase-gates` per-plan gates updated.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.6.22 → 0.7.0**. **`@mstar-harness/cli` remains 0.5.3**.

## [0.6.22] - 2026-06-27

### Harness (skills / dispatch-gates, roles)

- **Anti-recursion: identity-deprivation framework replaces prohibition-only rules**: Leaf executors (QC reviewers, devs, QA) were still entering a "consider dispatch" intent window because `NEVER` / `MUST NOT` prohibitions require the model to first activate the forbidden action before suppressing it. Fix shifts semantics from "you must NOT use Task" (prohibition) to "you ARE a leaf executor; Task is NOT your tool" (identity + capability deprivation).
  - Assignment template (`dispatch-and-assignment.md`): new **IDENTITY** + **CAPABILITY BOUNDARY** blocks before the `**You MUST NOT:**` list. `Delegation` field moved immediately after `Execute as` for earlier visibility.
  - `mstar-dispatch-gates/SKILL.md`: leaf-executor identity preamble placed between Load order and NEVER list, with explicit cross-reference back to the Assignment's IDENTITY block.
  - `qc-specialist-shared`: `Non-Recursive Dispatch Rule` rewritten as a first-person identity assertion with recursive-dispatch trap recognition ("If you ever think 'this would be more efficient if I dispatched X' — stop").
  - `leaf-executor-checklist`: first-person preamble before checklist items.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`: **0.6.21 → 0.6.22**. **`@mstar-harness/cli` remains 0.5.3**, Cursor / Codex plugin manifests remain **0.6.21**.

## [0.6.21] - 2026-06-26

### Harness (skills / design-md)

- **DESIGN.md YAML frontmatter as SSOT**: `mstar-design-md` templates and spec now use YAML frontmatter as the single source of truth for token values. Template format bumped to 0.1.0. Both light (`DESIGN.md.template`) and dark (`DESIGN.dark.md.template`) templates, the spec reference, completeness checklist, and the Vercel example updated.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, and Cursor / Codex plugin manifests: **0.6.20 → 0.6.21**. CLI: **0.5.2 → 0.5.3**.

## [0.6.20] - 2026-06-26

### Harness (commands)

- **`/iteration-start` Review & Edit Chain**: Changed §5 from "Review Chain" to "Review & Edit Chain". Each role (product-manager, architect, writing-specialist) now reviews AND directly edits the documents rather than only flagging issues. PM only steps in for the final review and lock, no longer burdened with aggregating edits from other reviewers.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.19 → 0.6.20**. **`@mstar-harness/cli` remains 0.5.2**.

## [0.6.19] - 2026-06-26

### Harness (skills / coding-behavior)

- **Distill Ponytail principles into `mstar-coding-behavior`**: Strengthened all four sections with distilled concepts from the Ponytail coding discipline:
  - **§1 Think Before Coding**: Added "Never lazy about understanding" — read the full task and every touched file before editing; a small diff in the wrong place is a second bug, not efficiency.
  - **§2 Simplicity First**: Added YAGNI gate ("does this need code at all?"), The Ladder (7-level decision hierarchy: YAGNI → reuse existing → stdlib → native platform → installed dep → one line → minimal code), "Deletion over addition / Boring over clever", and `simplify:` marker discipline (name the ceiling and upgrade path for deliberate shortcuts).
  - **§3 Surgical Changes**: Added "Bug fix = root cause, not symptom" — before editing, grep every caller; fix once at the narrowest shared point, not only the path the ticket names.
  - **§4 Goal-Driven Execution**: Added "Minimal check for non-trivial logic" — any non-trivial change must leave behind ONE runnable check (assert, minimal demo, or single test); YAGNI applies to tests too.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.18 → 0.6.19**. **`@mstar-harness/cli` remains 0.5.2**.

## [0.6.18] - 2026-06-26

### Harness (commands)

- **`/iteration-start` Boot section**: Add explicit `## 0. Boot` section aligned with `/iteration-drive`. Loads `mstar-harness-core`, `mstar-roles` → `references/project-manager.md`, `skills/pm/SKILL.md` (Host entry + Boot), `mstar-phase-gates` (Prepare), and `mstar-plan-conventions` / `mstar-plan-artifacts` before starting research.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.17 → 0.6.18**. **`@mstar-harness/cli` remains 0.5.2**.

## [0.6.17] - 2026-06-26

### Harness (commands)

- **`/iteration-drive` PR target fix**: Resolve the final PR target branch from iteration metadata (`status.json` → `target_branch`) instead of hardcoding `main`. Defaults to `main` when `target_branch` is not set.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.16 → 0.6.17**. **`@mstar-harness/cli` remains 0.5.2**.

## [0.6.16] - 2026-06-25

### Harness (commands)

- **New `/iteration-drive` command**: Add a command that invokes the PM Autonomous Execute driver (`skills/pm/SKILL.md` § Autonomous Execute driver) to drive all non-`Done` plans to completion. The command checks the three precondition gates first; if Prepare is incomplete, it directs the user to `/iteration-start`. Otherwise, it runs the full implement → QC → QA → Done per-plan loop until every plan is `Done`, then optionally creates a PR from the integration branch to `main`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.15 → 0.6.16**. **`@mstar-harness/cli` remains 0.5.1**.

## [0.6.15] - 2026-06-24

### Harness (commands)

- **New `iteration-start` command**: Add a reusable command (`/iteration-start`) to bootstrap a new harness iteration. The command guides PM through six checkpointed steps: research (structured harness dirs + unstructured glob for `roadmap*.md`, `deferred*.md`, `features*.md` etc.), explore candidate directions for product completeness, lock direction with `grill-me`, write iteration compass and plans, run the review chain (`@product-manager` → `@architect` → `@writing-specialist` → PM lock), and create the iteration integration branch from `main`. Registered for both Cursor (`commands/` auto-discovery) and OpenCode (`harness-commands/` bundled via plugin code).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.14 → 0.6.15**. **`@mstar-harness/cli` remains 0.5.1**.

## [0.6.14] - 2026-06-24

### Harness (skills / design-md)

- **New `mstar-design-md` skill**: Add a specialized skill for creating, auditing, and maintaining project-level `DESIGN.md` design system specifications. Three-level completeness checklist (MVP/Standard/Production) defines progressively what an agent needs from a design system to generate consistent UI without guessing tokens. Includes Vercel Geist as annotated reference, light/dark dual-theme support (`DESIGN.md` + `DESIGN.dark.md` with same token names, different values), and built-in `LEVEL*_PLACEHOLDER` markers for iterative maturity upgrades. Skill ships with full references (`design-md-spec.md` norm, `completeness-checklist.md`, `vercel-example.md`) and templates (`DESIGN.md.template`, `DESIGN.dark.md.template`).
- **Phase gate: DESIGN.md check**: PM Prepare quick-check adds "if plan involves UI work, does DESIGN.md exist and meet the declared completeness level."
- **Role integration**: `mstar-design-md` registered in all relevant role dependencies — architect as primary creator, product-manager for design intent/requirements, frontend-dev and fullstack-dev as consumers (read tokens before implementing styled UI), qc-specialist as verifier (check UI alignment with DESIGN.md), qa-engineer for visual output verification.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.13 → 0.6.14**. **`@mstar-harness/cli` remains 0.5.1**.

## [0.6.13] - 2026-06-20

### Harness (agents)

- **Drop `model: inherit` from role frontmatter**: Remove the `model: inherit` line from all 13 `agents/*.md` files. These agents inherit the default model via the plugin manifest rather than an explicit per-agent override, reducing frontmatter noise and avoiding confusion with model pinning. (Cursor-only frontmatter cleanup.)

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.12 → 0.6.13**. **`@mstar-harness/cli` remains 0.5.1**.

## [0.6.12] - 2026-06-20

### Harness (skills / dispatch gates)

- **Assignment anti-pattern header**: Every PM Assignment now opens with a `**You are a leaf executor. You MUST NOT:**` block containing the most likely dispatch violations for the assignment's situation. PM fills it with context-specific anti-patterns on top of the universal floor (no recursive dispatch, no interpreting routing text as invoke, available ≠ authorized). The `Orchestration Guard` section references this new top block. (`mstar-roles/references/project-manager/dispatch-and-assignment.md`)
- **Leaf executor checklist**: Updated to require reading the `**You are a leaf executor. You MUST NOT:**` block first on every assignment. (`mstar-dispatch-gates/references/leaf-executor-checklist.md`)
- **Dispatch gates**: Added a reference to the new assignment-level anti-pattern block in the anti-recursion section. (`mstar-dispatch-gates/SKILL.md`)

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.11 → 0.6.12**. **`@mstar-harness/cli` remains 0.5.1**.

## [0.6.11] - 2026-06-16

### Cursor plugin / agents

- **Subagent registration**: Reorder all `agents/*.md` frontmatter to Cursor-first schema (`name`, `description`, `model: inherit` before OpenCode `mode`/`tools`/`permission`) so plugin manifest `agents/` are discovered as Task subagents without a separate `~/.cursor/agents/` install step.
- **CLI Cursor install path**: Align global/project plugin symlinks to `morning-star-harness` (matching `.cursor-plugin/plugin.json` `name`).
- **CLI doctor**: Validate plugin agent files exist and use Cursor-first frontmatter.
- **Docs**: Update README (EN/CN), CLI guide, plugin README, LOCAL-VALIDATION subagent smoke test, and `mstar-host` Cursor reference.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.10 → 0.6.11**.
- Bump `@mstar-harness/cli`: **0.5.0 → 0.5.1**.

## [0.6.10] - 2026-06-11

### Harness (skills / agents)

- **Profile B Done compaction (`plans-done.json`)**: Canonical schema is now **`{ "plans": [<plan-id>, ...] }` only** — no rich catalog objects (`title`, `done_at`, `plan_file`, `archived_record`, etc.). Per-plan detail stays in `archived/plans/<plan-id>.json` (a single `plans[]` row snapshot). SSOT: `mstar-plan-artifacts/references/done-compaction.md`.
- **Templates & bootstrap**: Add `templates/plans-done.empty.json`; document Profile B init in `mstar-plan-conventions` harness bootstrap and PM `plan-management.md`.
- **Profile B constraints**: Disallow parallel indexes (`_index.json`, object-array catalogs); migrate legacy `plans-done.json` by rewriting to id list only.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.9 → 0.6.10**. **`@mstar-harness/cli` remains 0.5.0**.

## [0.6.9] - 2026-06-09

### Harness (skills / agents)

- **`pm` (PM orchestration entry)**: Generalize beyond Cursor/Codex `/pm` only — **Cursor/Codex** use `/pm` as `project-manager` launcher and autonomous Execute driver; **OpenCode** switches to PM orchestration when the active agent is not `project-manager`.
- **Autonomous Execute driver**: After Pre-implement **GO**, read `{HARNESS_DIR}/status.json` backlog, checkout the iteration **`spec_integration_branch`**, run per-plan **`create <plan-feature> from integration` → implement → QC/QA → merge back to integration** until all plans are `Done`; set host todos (Cursor `TodoWrite`, Codex `update_plan`, OpenCode UI) before each wave so session scope does not drift.
- **`mstar-roles` (PM shell)**: Cross-reference updated to point at the new `pm` skill sections (host entry, Execute driver, dispatch-first).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.8 → 0.6.9**. **`@mstar-harness/cli` remains 0.5.0**.

## [0.6.8] - 2026-06-04

### Harness (skills / agents)

- **QC fix-round revalidation (default)**: After dev fixes blocking findings, PM dispatches only the QC seat(s) that raised each item (**targeted re-review**), not a blind full tri-review. Reviewers update the **same** report file in place (`## Revalidation`); PM updates the same `qc-consolidated.md`. Full tri re-review requires explicit Assignment `QC re-review: full tri-review` and new `qcN-rev2.md` basenames.
- **QC report naming**: Under `{PLAN_DIR}/reports/<plan-id>/`, use short basenames `qc1.md`, `qc2.md`, `qc3.md`, and `qc-consolidated.md` (no `<plan-id>` prefix in filenames; `plan_id` stays in frontmatter and the directory). SSOT: `mstar-plan-artifacts/references/plan-files-and-reports.md`.
- **Dispatch**: `mstar-dispatch-gates` and `mstar-host` parallel-dispatch allow **N = 1–3** invokes for targeted re-review in one message; initial tri-review remains **N = 3**.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.7 → 0.6.8**. **`@mstar-harness/cli` remains 0.5.0**.

## [0.6.7] - 2026-06-03

### Harness (skills / agents)

- Add a Codex Plan / Goal Mode bridge reference so `/plan`, `update_plan`, `/goal`, goal progress, and thread summaries cannot replace `.mstar/` SSOT or Morning Star Done authority.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.6 → 0.6.7**. **`@mstar-harness/cli` remains 0.5.0**.

## [0.6.6] - 2026-06-03

### Harness (skills / agents)

- Add Codex custom-agent source files under `codex/agents/` so dispatchable Morning Star roles can be installed into Codex's `agents/*.toml` subagent surface; `project-manager` remains entered through `/pm`.
- Change the recommended project `{HARNESS_DIR}` default to `.mstar/` while continuing to recognize `.agents/`, `.plans/`, and `plans/` legacy layouts.

### CLI

- Change Cursor and Codex install flows to maintain a shared local repo at `~/.mstar/harness` and create host-specific symlinks instead of Cursor project submodules or Codex URL-source marketplace entries.
- Link Codex custom agents from `codex/agents/*.toml` into global or project Codex agent directories during `init`, and validate them in `doctor`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.5 → 0.6.6**.
- Bump `@mstar-harness/cli`: **0.4.0 → 0.5.0**.

## [0.6.5] - 2026-06-03

### Harness (skills / agents)

- **Durable Roadmap Gate**: Strengthen `mstar-harness-core`, `mstar-phase-gates`, PM gates, Cursor Plan mode bridge, and product/architecture templates so staged, partial, or temporary work must record a target state and roadmap before implement GO / Done.
- **Coding behavior**: Redefine `Simplicity First` as the smallest durable slice, not a temporary workaround; deferred items must be tracked in plan/status artifacts rather than only in chat.
- **Cursor routing-eval**: Bump routing evals to v8 with `durable-roadmap-required-for-staged-work`, guarding against “do half now, later plan” failures.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.4 → 0.6.5**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.6.4] - 2026-06-03

### Cursor Plan mode × Harness

- **Build resume contract**: Cursor Build is treated as plan resume, not `/pm` replay. Morning Star plans must reload harness context, resume PM orchestration, and dispatch implementation instead of letting the parent Build session edit product code.
- **Cursor routing-eval**: Add `cursor-plan-build-resume` to guard against parent-session implementation before SSOT plan registration, PM Assignment, and host Task dispatch.
- **Cursor plugin manifest**: Register `agents/` in `.cursor-plugin/plugin.json`, matching plugin docs and validation checks.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.3 → 0.6.4**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.6.3] - 2026-06-03

### Harness (skills / agents)

- **`pm` (`/pm`)**: Slim entry skill (~60 lines) with **`/pm`-only rules** — **dispatch-first** (Assignment + invoke per implement batch; parent agent must not write product code; no Task skip for in-thread context), **Autonomous Execute push** as dispatch loops across one iteration (multi-plan), **branch truth** (no silent cwd vs plan/`status.json`). Detailed gates/routing defer to `mstar-dispatch-gates`, `mstar-host`, and `project-manager` references.
- **`mstar-roles` (PM shell)**: `/pm` sessions point at `skills/pm` § `/pm`-only rules` instead of duplicating long prose.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.2 → 0.6.3**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.6.2] - 2026-06-02

### Harness (skills / agents)

- **`pm` (`/pm`)**: **Autonomous Execute push** — after Execute starts (`plan` locked, Pre-implement **GO**), continuously drive the active **iteration** backlog (possibly **multiple** `plan_id`s) through implement → InReview → Done without routine basic yes/no prompts; use PM-recommended defaults; resolve process gates from `mstar-*` skills (`Blocked` only on true conflicts or irreversible scope gaps).
- **`mstar-roles` (PM shell)**: Pointer to `skills/pm` § Autonomous Execute for sessions entered via `/pm`.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.1 → 0.6.2**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.6.1] - 2026-06-01

### Harness (skills / agents)

- **`mstar-plan-artifacts`**: Add read-only `scripts/tech-debt-rollup.sh` (jq) to compute `metadata.tech_debt_summary` from open `residual_findings` with PASS/DRIFT check; document as canonical rollup path in `references/status-and-residuals.md` (English).
- **`mstar-roles` (PM)**: Default spread across `fullstack-dev` and `fullstack-dev-2` when **>=2 independent** backend/fullstack units (parallel dual-track or sequential round-robin); single-id collapse requires `single_stream_justified` and documented override.
- **Cursor routing-eval**: New `sequential-backend-batches-rotation` case; tighten `two-parallel-backend-modules` hard_fail for single-dev without justification.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.6.0 → 0.6.1**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.6.0] - 2026-05-30

### Unified host skill

- **Breaking**: Merge `mstar-host-opencode` and `mstar-host-cursor` into single **`mstar-host`** at `skills/mstar-host/` (platform auto-detect + `references/opencode.md`, `cursor.md`, `codex.md`, `parallel-dispatch.md`, `cursor-plan-mode-bridge.md`).
- Add `references/codex.md` with Codex-specific runtime adaptation for plugin skills, clarify behavior, sandboxed file/shell work, tool discovery, and dispatch limits when no callable multi-agent tool exists.
- Remove `skills-cursor/` and `packages/opencode/skills/`; OpenCode plugin registers only `harness-skills/`. Cursor plugin `skills` array is `./skills/` only.
- Update role/topic references and `rules/mstar-cursor-plan-mode.mdc` paths.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.5.1 → 0.6.0**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.5.1] - 2026-05-29

### Cursor Plan mode × Harness (Cursor plugin)

- **Dual-write bridge**: CreatePlan mirrors to `{HARNESS_DIR}` / `{PLAN_DIR}` SSOT (`.agents/plans/`, `status.json`); fixed bootstrap todos `harness-init`, `spec-register`, `mirror-plan`; per–task-ID commit gate on implement todos. See `skills-cursor/mstar-host/references/cursor-plan-mode-bridge.md`, updates to `mstar-host-cursor`, `pm`, and `mstar-harness-core`.
- **Rules**: Add `rules/mstar-cursor-plan-mode.mdc` (`alwaysApply`); register `"rules": ["rules/"]` in `.cursor-plugin/plugin.json` so plugin rules (including `mstar-entry`) load reliably.
- **Maintainers**: Move pre-release checklist to `.cursor/LOCAL-VALIDATION.md` (removed from `.cursor-plugin/`).

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.5.0 → 0.5.1**. **`@mstar-harness/cli` remains 0.4.0**.

## [0.5.0] - 2026-05-26

### Codex integration

- Replace the obsolete checked-in `.codex/marketplace.json` path with the supported personal marketplace flow: `~/.agents/plugins/marketplace.json` using a `"source": "url"` entry for this repository.
- Add Codex support to `@mstar-harness/cli`: `init --target codex` writes the personal marketplace entry and `doctor --target codex` validates it.
- Update English and Chinese install docs for Codex CLI install and manual personal-marketplace setup.

### Harness (skills / agents)

- Fix the `/pm` skill frontmatter so the Codex plugin validates cleanly from the repository root.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests: **0.4.1 -> 0.5.0**.
- Bump `@mstar-harness/cli`: **0.3.1 -> 0.4.0**.

## [0.4.1] - 2026-05-19

### Harness (skills / agents)

- **`mstar-plan-artifacts`**: Move `templates/` (`status.empty.json`, `notes.empty.json`) from `mstar-plan-conventions` so artifact SSOT and empty-file templates live in one skill; `mstar-plan-conventions` keeps path discovery and init steps with pointers to `mstar-plan-artifacts/templates/`.

### Version alignment

- Bump **0.4.0 → 0.4.1** for monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests. **`@mstar-harness/cli` remains 0.3.1**.

## [0.4.0] - 2026-05-19

### Harness (skills / agents)

- **Topic skill split** (on-demand loading): Add `mstar-phase-gates`, `mstar-dispatch-gates`, `mstar-branch-worktree`, and `mstar-plan-artifacts` (includes `status.json` / residual SSOT; no separate `mstar-status-residuals`); slim `mstar-harness-core` and `mstar-plan-conventions` to entry + pointers; `mstar-phase-gates` and `mstar-branch-worktree` keep full rules in `SKILL.md` (no extra reference layer).
- **Roles** (`mstar-roles`): Per-role **Required Skill Dependencies** in every `references/<role>.md`; hub matrix in `mstar-roles` SKILL.md; PM sub-refs use `mstar-plan-artifacts` for severity SSOT.
- **Hosts** (`mstar-host-cursor`, `mstar-host-opencode`): Load-order wording and QC/worktree pointers aligned with topic skills.
- **Plan directories** (`mstar-plan-conventions`): Formalize `{ITERATION_DIR}` (`{HARNESS_DIR}/iterations/`) and `{KNOWLEDGE_DIR}` (`{HARNESS_DIR}/knowledge/`); document `docs/` vs harness subtree content boundaries (Nexus-aligned); optional `iteration_compass` / `iteration_refs` in `status.json` metadata.
- **Prepare clarify** (now primarily `mstar-phase-gates`; summary in `mstar-harness-core`): `clarify` discipline — shared understanding, explore before asking, recommended answer per question.

### Docs

- **README.md** / **README_CN.md**: Expanded core skill table; note `.harness/` as gitignored maint workspace for specs/plans (not published skills).
- **AGENTS.md**: `.harness/` maint workspace; topic skill routing table; post-change cross-reference check.

### Version alignment

- Bump **0.3.2 → 0.4.0** for monorepo root, `@mstar-harness/opencode`, and Cursor / Codex plugin manifests. **`@mstar-harness/cli` remains 0.3.1**.

## [0.3.1] - 2026-05-15

### Harness (skills / agents)

- **Plan / Git alignment** (`mstar-plan-conventions`, `mstar-harness-core`): When multiple plans share one **Spec** (`primary_spec`), document a **Spec integration branch** plus per-**plan_id** implementation branches; merge each plan’s work back to the Spec line; **require a PR** (or equivalent controlled merge) before landing that integration line on `main` / the default protected branch (narrow `Branch policy` exceptions unchanged). Adds `spec_integration_branch` and clarified `merge_target` metadata in `references/status-and-residuals.md`, QC/worktree notes in `references/plan-files-and-reports.md`, and a cross-reference in `references/branch-and-worktree.md`.

### Version alignment

- Bump **0.3.0 → 0.3.1** for npm workspaces (`morning-star`, `@mstar-harness/cli`, `@mstar-harness/opencode`) and Cursor / Codex plugin manifests.

## [0.3.0] - 2026-05-14

### Harness (skills / agents)

- **PM role**: Split `project-manager` detail into `skills/mstar-roles/references/project-manager/*.md`; keep a compact orchestrator shell in `references/project-manager.md`.
- **Roles**: Translate `mstar-roles` role references and skill hub to English; reference host adapters by skill name (`mstar-host-opencode`, `mstar-host-cursor`) instead of filesystem paths in role text.
- **AGENTS.md**: Host adapter routing documents skill names and in-repo layout (`skills-cursor/mstar-host` for Cursor).
- **PM routing**: Phase routing pre-flight (short go/no-go) and OpenCode **prerequisite vs dispatch** turn model in `mstar-host-opencode` (paste-only dispatch failure mode).
- **OpenViking (optional)**: Add `mstar-harness-core/references/openviking-memory-plugin.md` — rules when the `memsearch` tool is present; entry from `mstar-harness-core` SKILL.
- **Load contract**: Clarify `mstar-coding-behavior` is required for implement / review / QA / ops roles, not for `project-manager` orchestration-only work (`mstar-harness-core`, `mstar-roles`).

### Docs

- Trim plan bootstrap template sections from `README.md` / `README_CN.md` where superseded by current flows.

### Version alignment

- Bump **0.2.0 → 0.3.0** for npm workspaces (`morning-star`, `@mstar-harness/cli`, `@mstar-harness/opencode`).
- Bump **0.1.0 → 0.3.0** for Cursor and Codex plugin manifests to match the monorepo release line.

## [0.2.0] - earlier

See [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md) for `@mstar-harness/cli` 0.2.0 notes. OpenCode packaging, postinstall bundle of `skills/` + `agents/`, and related fixes landed in the same era as the 0.2.0 CLI release.
