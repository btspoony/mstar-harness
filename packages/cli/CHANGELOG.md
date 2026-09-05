# Changelog

All notable changes to the `@mstar-harness/cli` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

## [3.6.2] - 2026-09-05

### Changed

- Added a **PR review time-budget system**: engine constant table `PR_REVIEW_TIER_BUDGETS` (wall-clock target + per-seat caps per tier) is the numeric SSOT, rendered as a budget block in `prReviewSeatPrompt` seat prompts.
- Added a **`mstar pr-review budget`** CLI command printing the per-tier budget table (`quick`/`default`/`deep`) for humans and drift checks.
- Added a **Budget column and a time-budget degradation ladder** (①read-depth ②seat topology ③display, with a never-degrade list) to `mstar-audit` PR-review prose and the `/amazing-pr-review` command.

- Version alignment with harness **3.6.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.2**.

## [3.6.1] - 2026-09-03

### Changed

- Shipped repo-side ZCode marketplace manifests (`.claude-plugin/marketplace.json`, with root `marketplace.json` as fallback) so ZCode's `github`-source marketplace refresh can discover the catalog in-repo — previously refresh failed with `Marketplace manifest not found in GitHub repo`. Plugin entries use the `github` source with no pinned version; install-time versions come from `.zcode-plugin/plugin.json`.
- Aligned the `zcode` adapter: the local marketplace snapshot written by `init` no longer pins a plugin version, and `doctor` accepts version-less plugin entries (a successful ZCode refresh overwrites the snapshot with the repo manifest).

- Version alignment with harness **3.6.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.1**.

## [3.6.0] - 2026-09-03

### dsh

- **`dsh-llm-fallbacks` upgraded to `0.4.1`** (the line adapted to `@deepseek-ai/dsh-*` `^0.1.2-rc.1`): the repo's devDependency and the dsh adapter's install spec are now the EXACT `0.4.1` (no caret). The unpinned add previously forwarded the dsh CLI's own manifest spec (`^0.3.5`), whose dist re-exports `installSettingsSection` from `@deepseek-ai/dsh-settings` — an export the rc.1 line removed — breaking the installed-artifact boot; the installed dsh e2e specs now also pin the fallbacks add and extend the shipped-surface probe to the native persona channel (`internal/get` + `request.persona`), so a published dist built on the superseded additive-section path is re-added pinned to the repo version instead of silently booting stale.
- Both dsh install e2e specs run green end to end against the real registry (previously failing on the `^0.3.5` re-export break).
- **New `@mstar-harness/omp` npm package**: `omp plugin install @mstar-harness/omp` now works without any local build — the omp hook + six `mstar_*` tools are bundled with the engine **inlined** (zero runtime `@mstar-harness/engine` resolution), fixing `Cannot find package '@mstar-harness/engine'` on third-party installs. Docs (`INSTALL.md`, `README.md`/`README_CN.md`, `mstar-host` omp reference) and the CLI omp adapter now prefer the npm install path; the maintainer `omp plugin link` path is `<repo>/packages/omp` (needs `bun install && bun run engine:build && bun run --cwd packages/omp build` in the checkout).
- **BREAKING (intended)**: repo-root `hooks/` and `tools/` moved into `packages/omp/src/` — the omp hook/tools are now omp-only package surfaces. Anyone relying on repo-root `hooks/pre/mstar-gates.ts` / `tools/mstar_*` paths must use the package (`packages/omp/src/…` sources, `<pkg>/hooks/` + `<pkg>/tools/` in the installed npm tree). The maintainer `omp plugin link` path is now `<repo>/packages/omp` (built) — linking the repo root no longer provides the runtime gates.

- Version alignment with harness **3.6.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0**.

## [3.6.0-alpha.4] - 2026-09-03

### Changed

- **PR review diff snapshot**: `mstar pr-review worktree-setup` now pins the review diff basis to a snapshot file beside the sidecar (`<parent-of-worktree>/.<wt-dirname>.prreview.diff`, printed as `diffFile` in setup output; `null` for `--diff` / `--working-tree` modes) so every Stage 1/2 seat reads one pinned diff instead of re-running git — `mstar pr-review seat-prompt` passes it through as `--diff-file` and the prompt gains a "read the pinned diff snapshot FIRST" ingredient; cleanup removes the snapshot with the sidecar, and snapshot capture is wrapped in the worktree rollback so a failed setup never orphans a worktree.
- **Worktree convention + ownership**: review worktrees now default under `<repoRoot>/.worktrees/review-…` (the `mstar-branch-worktree` convention; `.worktrees/` is added to `.git/info/exclude` when the target repo does not ignore it) instead of a sibling directory beside the repo, and `worktree-cleanup` only deletes files whose identity (dev/ino/mtime, link count) matches the snapshot recorded at setup — a replaced or foreign file at the snapshot path is left in place, and a pre-existing sidecar makes setup refuse with a `worktree-cleanup` hint instead of deleting it.

- Version alignment with harness **3.6.0-alpha.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.4**.

## [3.6.0-alpha.3] - 2026-08-31

### CLI

- Codex installs now use a repo-bundled marketplace: the harness repo ships `.agents/plugins/marketplace.json` (name `mstar-repo`, plugin root = repo root), and `npx @mstar-harness/cli init --target codex` registers it via `codex plugin marketplace add btspoony/mstar-harness --ref main`. Install with `codex plugin add morning-star-harness@mstar-repo`; refresh snapshots with `codex plugin marketplace upgrade`. `doctor --target codex` validates the marketplace registration via the codex CLI and reports legacy `personal` marketplace entries as a migration note; Codex custom-agent `.toml` symlinks continue to come from the shared `~/.mstar/harness` checkout.

- Version alignment with harness **3.6.0-alpha.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.3**.

## [3.6.0-alpha.2] - 2026-08-31

### Changed

- Version alignment with harness **3.6.0-alpha.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.2**.

## [3.6.0-alpha.1] - 2026-08-31

### Changed

- Version alignment with harness **3.6.0-alpha.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.6.0-alpha.1**.

## [3.5.1] - 2026-08-28

### Changed

- Version alignment with harness **3.5.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.5.1**.

## [3.5.0] - 2026-08-28

### Harness

- Added a pluggable **ArtifactStore** for JSON coordination docs: `status.json`, workflow snapshots, and project residuals now persist through `ArtifactStore.put` / `get` (default `FsStore` keeps the existing `{HARNESS_DIR}` paths and atomic-write semantics). Integrations can mount their own store in-process via `setArtifactStore` or per-command via `MSTAR_STORE_MODULE` / `--store` — filesystem paths only, URI schemes are rejected before `import()`.
- Added `mstar-harness persist <kind> --key <key> [--file <path>|--stdin] [--store <module>] [--schema <id>]` and `mstar-harness persist get <kind> --key <key> [--store <module>]` for `status` / `snapshot` / `residuals` / `review` / `json`, running the existing kind validators before put.
- `mstar-harness init` now auto-installs the **matching-version** `@mstar-harness/cli` globally after a successful run, so the `mstar-harness` binary lands on PATH for engine-check commands. The install is skipped when the PATH version already matches, is fail-soft on npm errors (init still exits 0), and can be opted out with `--no-global-cli`; `--dry-run` prints the would-run `npm i -g` command without executing it.
- `mstar-harness doctor` now prints a non-fatal CLI-on-PATH note (missing / mismatch / match) for every target.
- Added a first-class **review JSON kind** (`mstar.review/v1`): `synthesizeReview` folds vetted findings into a validated envelope (verdict/tally from `computePrTally`), `mstar-harness persist review` validates the envelope before put (inspector M1 vocab rejected), and `pr-deep-review` / `amazing-pr-review` Stage 3 must persist the envelope — the Markdown report is the optional human copy.
- Made `FsStore.put` **fail loud on unpersistable envelope schemas**: a doc carrying an envelope `schema` id is now rejected with a canonical error instead of being silently dropped (FsStore persists `doc.payload` only); payload-internal `schema` fields are unaffected.
- Added optional **`ArtifactStore.list?(kind)`** enumeration: stores that cannot enumerate decline by omitting the member (callers probe `typeof store.list === "function"`, same pattern as `delete?`); `FsStore` implements it via the single kind→path table (missing backing file → `[]`, keys sorted ascending, every listed key round-trips through `get`, `json` kind throws the canonical usage error).
- Added the **`persist list <kind>`** CLI face: prints stored keys only (one per line, ascending, no header); `json` is rejected as a usage error before enumeration, and an injected store without `list` exits 2 (probed, never a TypeError).
- Added **`persist get --validate`**: reuses the put-gate validators on the fetched payload — stdout stays payload JSON only; notes (`validation: ok` / `json: parse-only`) and violations go to stderr; a miss or an invalid document exits 1.
- Added the **`persist delete <kind> --key <key>`** CLI face: idempotent (absent key is a no-op, exit 0, prints `deleted <kind>/<key>`), no confirmation prompt; an injected store without `delete` exits 2.

- Version alignment with harness **3.5.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.5.0**.

## [3.4.1] - 2026-08-27

### Changed

- Version alignment with harness **3.4.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.4.1**.

## [3.4.0] - 2026-08-27

### Harness

- Deterministic static checks from the audit security review are now mechanical engine code with CLI entry points: `mstar audit secret-scan [path]` walks git-tracked files read-only through `scanSecrets` and prints `{file, line, type}` findings (never values), exiting 1 on any hit; patterns cover provider key shapes (AKIA/ASIA, sk-ant-, ghp_/github_pat_, sk_live_, sk-, xox[baprs]-, JWT, private-key blocks), never-commit filenames (`.env*`, `*.pem`, `*.key`, `id_rsa`, credentials/service-account JSON, git-credentials), CI/IaC leak shapes (Actions plaintext `env:` map entries and same-line assignments, Docker `ENV`/`ARG`, Terraform `password =`), while safe placeholders (`${ENV_VAR}`, `process.env.X`) are excluded. `mstar audit supply-chain [path]` runs `supplyChainChecks`: lockfile-missing / lockfile-duplicate across the known lockfile set, `action-unpinned` (`@main`/`@latest`, trailing-comment tolerant, SHA pins clean), and `pull_request_target-head` PR-head checkout; reachability triage stays with the reviewer.
- Credential patterns now have a single source of truth: `WHOLE_MATCH_PATTERNS` / `VALUE_PATTERNS` in `packages/engine/src/audit.ts` back both `redactSecrets` and `scanSecrets`, reconciling the engine-vs-prose drift — the engine table gained fine-grained GitHub PATs (`github_pat_`) and Stripe live keys (`sk_live_`). `scaffoldAuditPlan` wires `redactSecrets` over finding evidence/description so scaffolded plans honor the redaction promise, and `security-review.md` §6 collapses its duplicated pattern list to an engine-check pointer at `mstar audit secret-scan`, keeping only discipline prose.
- Programmatic deferred-PR backlog registration: `mstar status backlog-register` / `mstar status backlog-close` replace the hand-rolled python lock protocol in `skills/mstar-audit/references/pr-review.md`. The engine `appendProjectRegisterEntries` / `closeProjectRegisterEntry` run inside `withStatusWriteLock` with atomic temp+rename writes (crash-safe, fail-loud validation); same-day key bump (`-2`, `-3`, …) and entry-id uniqueness are enforced inside the lock (B-9).
- PR-review deterministic arithmetic and naming contracts moved from LLM hand-computation into tested engine code, exposed as the new `mstar pr-review` command group: `tally` (locked-formula tally/verdict/score + verbatim two-line chat header from accepted findings JSON), `report-path` (local-report/evidence filename resolver with same-day `-r2`/`-r3` collision escalation and never-fabricated SHAs), and `validate-report` (saved-report frontmatter validation: verdict-from-tally, score recompute, comments tri-state). `mstar-audit/references/pr-review.md` § Tally / § Local report archive naming / § Output shape now carry engine-check callouts pointing at these commands.
- PR-review external side effects became tested engine code behind new `mstar pr-review` commands: `post` (builds the GitHub Review plan via `planReviewPost` — owner/repo parsed from the PR url only, never `headRepository`; `event` locked to the literal `COMMENT`; `commit_id = headRefOid`; at-most-once 422 fallback folding exactly the rejected inline comments into the body), `worktree-setup` / `worktree-cleanup` (collision-free branch naming via `pickReviewBranchName`, explicit-refspec fetches, `preflightChangeset` gates where untracked-only changesets count, sidecar-guarded cleanup that removes the tree, prunes and deletes exactly the recorded review branch behind the report-saved gate), `size` (`prReviewSizing` ~100/~300/~1000 bands + Stage-1 seat plan, split advice, file-size watch) and `seat-prompt` (`prReviewSeatPrompt` skeletons: Hard Rules 4/5 verbatim, payload-return contract, no-verdict/no-post clauses, `<domain>-<seat>` slugs). Finding docs gained a programmatic hook: `mstar lint --type finding` backed by `validateFindingDoc` (`### [CATEGORY-NN]` numbering, category/effort/risk/confidence enums, evidence `path:line` shape; Merge-class presence/enum/placement with `--pr-variant`).

- Version alignment with harness **3.4.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.4.0**.

## [3.3.0] - 2026-08-25

### Changed

<!-- CN block intentionally omitted — engine/cli changelogs are EN-only; root bullets reused per .changes/README.md -->
- **Audit index security dispositions in `scaffoldAuditPlan`** (engine): the README index renderer now emits the documented **Needs verification** and **Hardening & checked notes** sections (new `needsVerification` / `hardeningChecked` options). On re-runs without those options, previously rendered entries are carried over from the existing README, so hand-added or earlier-run security leads, hardening notes, and checked-and-clean records survive the index rebuild instead of being silently dropped.
- **`mstar audit scaffold` accepts security dispositions** (cli): the findings file now also accepts an object form `{findings: [...], needsVerification?: [{lead, how, evidence?}], hardeningChecked?: [{kind, text}]}` (bare array still supported) and passes the dispositions through to the engine renderer, so CLI-scaffolded audit indexes include the security sections exactly as documented in `mstar-audit/references/security-review.md`.
- Added **`mstar harness scaffold [path]`** (default cwd): one-shot harness bootstrap — engine `scaffoldHarness` now also prebuilds `projects/_default/` (`roadmap.md` with valid `validateRoadmap` frontmatter + `## Direction` placeholder, and an empty `residuals.json` passing `validateProjectRegister`); the CLI appends the canonical `.gitignore` snippet when absent, writes a minimal `.mstar/AGENTS.md` when absent, and prints a created/skipped summary. Idempotent — re-running on an initialized tree only creates missing pieces.
- `mstar harness scaffold` is now `.mstarc`-aware: it scaffolds into the `.mstarc`-declared `harness_dir` (or the `MSTAR_HARNESS_DIR` override), lands `projects/_default/` under the resolved `project_dir`, and prints the resolved harness/project dirs. The canonical `.gitignore` snippet is appended only for the default `.mstar/` layout — custom harness layouts skip it. The fence now splices `.mstar/**` BEFORE existing `!.mstar/…` re-includes when the broad rule is missing (gitignore last-match-wins), keeping the re-includes effective.
- `mstar path resolve` failure guidance now points to `mstar harness scaffold` instead of `mstar init`.

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

### Changed

- Version alignment with harness **3.2.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.2.0**.

## [3.1.3] - 2026-08-23

### Harness

- **`mstar audit promote` (CLI)**: selected audit plans can now enter the v2 workflow lifecycle as `type: plan` — `promoteAuditPlans` writes the workflow snapshot (`{HARNESS_DIR}/workflows/<id>/snapshot.json`, one Todo `PlanRow` per selected plan, `id` + `title` + `file`) **before** registering the workflow in root `status.json`, so the snapshot-before-register invariant holds. `--plans` accepts the README Plan column id, stem, or basename; `--workflow` defaults to the `audit-<date>` dir basename; `--harness` defaults to the resolved `{HARNESS_DIR}`. Promote stays an explicit post-selection action — the audit itself never registers (advisory contract preserved).
- **Engine**: `promoteAuditPlans` exported from `@mstar-harness/engine` (titles come from the audit README index, falling back to `readPlanFileSummary`).
- **Harness skills**: `mstar-audit` Handoff step 1 now names `mstar audit promote <audit-dir> --plans <ids>` as the first-class v2 path (manual `mstar-plan-artifacts` wording kept as fallback).
- **Unified the three CLI `execFileSync` wrappers** into a single `runCliCommand` helper (`packages/cli/src/exec.ts`): `runCommand` (shared-install), `runOmp` (omp), and `runDsh` (dsh) are now thin calls with today's defaults — no public signature or behavior change. Timeout / env / dry-run can no longer drift independently across the wrappers; `runDsh` keeps its `env: process.env` + `timeout` contract (dsh PATH injection in tests).
- **Engine git env-pin regression test (test-only)**: `packages/engine/test/exec-env.test.ts` now detects any git `execFileSync` call whose options carry an empty env (`env: {}` / `env: { PATH: "" }`) across `path.ts` / `sdd.ts` / `worktree.ts` — production env handling is untouched.
- **audit-004 validator CLI surface closure verification**: the five validator commands (`mstar status tech-debt`, `mstar status findings-cleanup <plan-id>`, `mstar lease verify-integration`, `mstar worktree qc-alignment`, `mstar host skill-root`) were smoke-verified runnable against the repo fixtures from the dist build (`node packages/cli/dist/mstar-harness.js`), each exiting per its documented semantics; no command code changed. Residual `20260816-audit-004-validator-cli-surface` moves to in-place `lifecycle: resolved` with the smoke evidence referenced.

- Version alignment with harness **3.1.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.3**.

## [3.1.2] - 2026-08-21

### Changed

- Version alignment with harness **3.1.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.2**.

## [3.1.1] - 2026-08-20

### Changed

- Version alignment with harness **3.1.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.1**.

## [3.1.0] - 2026-08-20

### Changed

- Version alignment with harness **3.1.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.1.0**.

## [3.0.1] - 2026-08-20

### Changed

- Version alignment with harness **3.0.1**.

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

- Version alignment with harness **3.0.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **3.0.0**.

## [2.4.1] - 2026-08-17

### Changed

- Version alignment with harness **2.4.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.4.1**.

## [2.4.0] - 2026-08-17

### Changed

- **dsh install target**: `npx @mstar-harness/cli init --target dsh` now installs the full dsh capability in one command — it runs **two independent** `dsh plugin --profile web add` calls (`@mstar-harness/dsh` first, then `dsh-llm-fallbacks`; never folded into a patch file). `doctor --target dsh` reports each plugin row as `uninstalled` / `disabled` / `mounted` and exits non-zero on any uninstalled or disabled row. `--no-fallbacks` (dsh target only) skips the `dsh-llm-fallbacks` row; `--dry-run` previews without probing or executing; re-runs are idempotent (already-installed rows skipped). README pair, `INSTALL.md`, and `docs/cli.md` updated.
- **CLI `mstar` bin alias**: `@mstar-harness/cli` now installs a second executable, `mstar`, alongside the canonical `mstar-harness` — both map to the same `dist/mstar-harness.js` entry, so the two names are interchangeable (pinned by a new manifest test). `commands/` citations now use `mstar-harness` (version-proof: the long name exists in every released version; the short alias ships with this release), and `docs/cli.md` plus the README pair note the alias. **Caution**: `mstar` is a shared bin namespace — an unrelated third-party npm package named `mstar` claims the same command name, so bare `npx mstar …` only resolves to this CLI where `@mstar-harness/cli` is installed; keep the canonical `mstar-harness` in scripts and use the long name on any collision. Existing global installs obtain the `mstar` shim on their next upgrade: `npm i -g @mstar-harness/cli@latest` (or the bun equivalent) re-links all declared bins.
- **Drift-lint bin-prefix guard**: `validation:drift` now checks the binary prefix of every backticked CLI citation in Engine-check callouts against the declared `bin` names from `packages/cli/package.json` (the manifest is SSOT), so citing a nonexistent executable (e.g. a typo like `mstarr`) fails drift-lint instead of silently passing while the subcommand paths validate.
- **CLI path resolution**: relative path args on the six dev commands (`skill lint`, `lint`, `dispatch validate`, `compound validate`, `design-md validate`, `audit scaffold`) now resolve against the workspace/project root instead of the process cwd — `MSTAR_CLI_PROJECT_ROOT` env override (set by the root `cli:dev` wrapper), else the nearest ancestor `package.json` declaring `workspaces` (monorepo root; array, npm single-glob string like `"./packages/*"`, or object form), else the nearest `package.json` (single-package project root), else cwd-relative terminal fallback. Documented invocations like `bun run cli:dev skill lint skills/mstar-audit` (or `bun run --cwd packages/cli dev skill lint skills/mstar-audit`) now find repo-root skills from any cwd; absolute paths are unchanged.
- **Five-question lint runtime mode**: `lintFiveQuestion(body, mode?)` now supports `mode: "runtime"` (default `"authoring"`, non-breaking) with a locked `RUNTIME_HEADING_ALIASES` table — heading synonyms (e.g. `process`/`playbook` for Workflow, `hard rules`/`门禁` for Decision Rules, `output format`/`证据` for Evidence, `dependencies`/`关系` for References) that count as the canonical sections for shipped topic skills. `mstar skill lint` selects runtime mode for `mstar-*` skill dirs except `mstar-skill-authoring` (always authoring/strict); `mstar-harness-core` prints an explicit **exempt** row for the five-question checklist. Greenfield (authoring) lint still demands canonical headings.
- **Runtime corpus alignment**: 15 shipped `mstar-*` topic skills gained minimal annotations/thin sections (Evidence ×13, Workflow ×9, References ×6, plus `mstar-host`'s load-order/decision-rules gaps) derived from existing material — every runtime skill now passes runtime-mode five-question lint; `mstar-audit` needed zero edits. `skills/mstar-skill-authoring/SKILL.md` documents the alias map (runtime-mode semantics stay SSOT: aliases exempt mechanical lint, not content).
- **drift-lint Guard 5 (five-question corpus smoke)**: `bun run validation:drift` now loads every shipped runtime `skills/mstar-*/SKILL.md` (excluding `mstar-harness-core` and `mstar-skill-authoring`), strips frontmatter, and runs `lintFiveQuestion` in runtime mode — deleting a Step-3 aligned heading or losing runtime alias coverage fails CI (audit finding 5).
- **`mstar-skill-authoring` strict self-lint**: the fence-aware heading scan exposed the standard's own `SKILL.md` as a fence false-green (five-question coverage came only from the `## 默认 Body 结构` template code fence), so real `## Workflow` / `## 6 条作者原则（Decision Rules，必须遵守）` / `## 验证门控（Evidence，原则 4 + 6）` sections now answer the five questions honestly and `mstar skill lint skills/mstar-skill-authoring` passes strict (authoring) mode.
- **`mstar roles validate`**: new CLI command exposing the mstar-roles skill-dir checks — a thin mirror of the dsh seam `validateRolesState`: `validateRoleMapping` on the roles dir plus `lintLoadOrder` over every sibling `mstar-*` skill, with unreadable siblings skipped best-effort. Defaults resolve through the project-root path resolution (`--roles-dir` → `skills/mstar-roles`, `--skills-dir` → its parent); exit 0 prints OK + counts, violations exit 1 with one row each. `skills/mstar-roles/SKILL.md` engine-check callout now cites the CLI command.
- **drift-lint Guard 4**: roles/load-order corpus guard in `scripts/drift-lint.ts` (plan 003 Task 2) — `lintLoadOrder` over every `skills/mstar-*/SKILL.md` text (each must declare `mstar-harness-core` in a Load Order / First action section) plus `validateRoleMapping` on `skills/mstar-roles` (mapping / parameter tables must resolve against the on-disk `references/*.md` layout); CI drift-lint now fails on role-table or load-order regressions.
- **Import-only validator CLI surface**: five new maintainer commands exposing engine validators that skill callouts previously cited as import-only — `mstar status tech-debt [path]` (`techDebtRollup`; prints the rollup and PASS/DRIFT vs stored `metadata.tech_debt_summary`, exit 1 on DRIFT), `mstar status findings-cleanup <plan-id>` (`findingsCleanupGate`; mode resolution via Assignment/metadata `zero-residual`, else `allow-residual`), `mstar lease verify-integration` (`validateIntegrationMergeLease`; unclaimed lease = OK, distinct from `lease verify`), `mstar worktree qc-alignment <assignment-file>...` (`assertQcAlignment`; byte-identical `plan_id` / `Review range` / `Diff basis` across QC tri + QA Assignments), and `mstar host skill-root --host <id> --skill <name> [--rel <path>]` (`resolveSkillRoot`). Engine-check callouts in `mstar-plan-artifacts` (incl. `references/status-and-residuals.md`), `mstar-iteration`, `mstar-branch-worktree`, and `mstar-host` now cite the CLI forms.
- **Fix wave (QC F-001/F-002/F-003/F-005)**: `worktree qc-alignment` now also parses the canonical combined `**Review range / Diff basis**:` label (one value fills both range fields; separate labels still win per-field), `host skill-root` rejects an empty `--skill` value as usage (exit 2), the `pi`/`dsh` skill-root shapes and null/tombstone lease fail path now have regression tests, and the help/docs exit tables align commander missing-option (exit 1) vs unknown-host (exit 2).

- Version alignment with harness **2.4.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.4.0**.

## [2.3.0] - 2026-08-16

### Harness

- **SDD fix-round mechanics**: `mstar-sdd` gains four mechanical rules for PM fix-wave dispatch and close-out — an **unverified round counts** (a fix round without verification evidence — reviewer not confirmed / report not on disk — is not clean; re-check and count the round, never enter the convergence branch), **full re-entry** (the next fix dispatch carries all open findings, including last round's unverified items; never slice a subset), **capped cross-round excerpt** (from round ≥2 the dispatch brief carries an excerpt of prior rounds' findings and dispositions — advisory ~500 words/round, ~1500 total, suggested values not hard limits), and **honest non-convergence** (open findings at wave close are listed in detail with an explicit re-feed-to-next-round or transfer-to-residual disposition — never silently closed). Folds Candidate C5 into `mstar-sdd` SKILL.md "After all tasks" + `references/file-handoffs.md` cross-reference (the per-task fix loop applies the same mechanics).
- **Residual fail-loud handoff contract**: `mstar-plan-artifacts` `status-and-residuals.md` now requires findings to pass engine validation before R# registration — `validateResidual` per entry and `validateStatus` for the whole file; malformed entries (non-object, missing any of the nine required fields id/title/severity/source/scope/decision/owner/target/tracking, or severity outside the enum) are **rejected** — fix and rewrite, never silent pass-through, downgrade-write, or write-then-patch. Folds Candidate C6; the architect-verified D-3 branch (covered-but-untested) is closed by backfilled non-object rejection regression tests in `packages/engine` at both the `validateResidual` level and the `validateStatus` aggregate level (engine suite 658 pass / 0 fail) — zero source diff, no new public API.
- **CLI `dispatch validate` non-ASCII literal fix**: bun-executed CLI bundles misdecode raw multi-byte UTF-8 in regex/string literals, so a legal `Branch policy: direct on main — <reason>` (em-dash) was reported as two false violations. Source literals across 20 `packages/engine` + `packages/cli` src files are escaped to `\uXXXX`, a post-build dist escaper guarantees bundle-level ASCII (bun build re-normalizes string escapes), a bundle-smoke regression test covers em-dash + ASCII separators, and `bun run lint:ascii-literals` plus a CI step guard against recurrence. The guard covers `packages/engine` + `packages/cli` source and the CLI dist bundle; the opencode dist bundle is not wired to the escaper — it is not run as a large bun bundle.
- **Regression-fixation paired-evidence reference**: new `mstar-skill-authoring/references/regression-fixation.md` — real artifact as test subject (built bundle / command sequences, not a source import), mock host hooks, dual-path assertion consistency, and fix solidification (reproduce → FAIL → fix → PASS → into the regression set); zero external dependencies, explicitly an optional heavy weapon (default stays P6 before/after + application case). SKILL.md gains the References pointer and syncs its verdict enum to the 4-value SSOT (Approve | Request Changes | Needs Discussion | Unconfirmed).
- **Ephemeral-citation lint (engine)**: new `findEphemeralCitations` scans skill text for short-lived citations — concrete task artifacts (`task-<digits>-(brief|report|fix-report|diff)`, incl. dot form `task-N.diff`) and SDD deeplinks (`.mstar/sdd/` / `.agents/sdd/` + concrete first segment) — while discriminating placeholder forms (`task-N-report`, `<plan-id>`, `{SDD_DIR}/…`, `.mstar/sdd/**` path globs): zero false positives on the current `skills/` corpus.
- **CLI `skill lint`**: third checklist `skill lint (ephemeral citations)` wired into `mstar skill lint` after the five-question checklist; each citation reports as a `skill.ephemeral.<kind>` violation (line + match + placeholder rewrite fix) and sets exit 1.
- **drift-lint guards**: docs audit-enum set-equality (docs/cli.md `<category>` row and README category-focus lists vs the engine `AUDIT_CATEGORIES` — catches fabricated tokens like `deps` and omissions like `bug` / `direction`), README.md / README_CN.md same-commit bilingual pairing over the push range, and a skills-corpus ephemeral guard reusing `findEphemeralCitations`; plus a `citesKnowledgeConventions` exemption for harness-local knowledge citations.
- Internal `@mstar-harness/engine` devDependencies in cli/opencode/dsh now use the `workspace:*` protocol; the release-prep engine-spec sync step was removed.

- Version alignment with harness **2.3.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.3.0**.

## [2.2.0] - 2026-08-13

### Changed

- **engine**: `resolveHarnessDir` now stops at the workspace root (roadmap §7c defect fix) — the upward probe keeps walking only while `dir` is at or below `opts.workspaceRoot`, so a harness dir above the workspace (e.g. the global `~/.mstar` CLI-install root) is never returned. The default boundary is the git top-level of the start dir (sync `git rev-parse --show-cdup`; non-git start falls back to the start dir itself — probes only itself, never upward; deliberate tightening). Explicit overrides (`opts.harnessDir` / `MSTAR_HARNESS_DIR`) short-circuit before the boundary and keep their authority.
- **Sync upstream v2.1.1**: merged the upstream `mstar-harness` v2.1.1 line into the dev-dsh branch — adds the `code-reviewer` role (read-only L2 SDD task reviewer / audit executor; replaces `generalPurpose` as the SDD per-task review seat, with generic fallback only when the role agent is absent on the host), ships the canonical default-ignore harness `.gitignore` format (`.mstar/**` + tracked re-includes `AGENTS.md` / `knowledge/` / `specs/`) across the engine, CLI `init` fence and bundled skills, and aligns all 11 version surfaces to 2.1.1.
- **engine**: `emitGitignoreSnippet` / `validateGitignore` / `HARNESS_PROCESS_GITIGNORE` now emit the default-ignore + re-include format instead of the flat per-directory ignore list; `ROLE_MAPPING` grows to 14 ids with `code-reviewer`.
- **bundle-assets**: re-synced `packages/dsh/harness-skills` / `harness-commands` from the merged `skills/` tree — the 6+ upstream-touched bundled skills and all `mstar-host/references/*.md` host adapters (cursor/kimi/omp/opencode/zcode) now carry the v2.1.1 wording (SDD task reviewer → `code-reviewer`).

- Version alignment with harness **2.2.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.2.0**.

## [2.1.1] - 2026-08-12

### Harness

- Canonical `.gitignore` snippet now default-ignores the whole harness dir (`<dir>/**`) and re-includes only the tracked results (AGENTS.md, knowledge/, specs/) — new process subdirectories are ignored automatically.

- Version alignment with harness **2.1.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.1.1**.

## [2.1.0] - 2026-08-12

### Changed

- Version alignment with harness **2.1.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.1.0**.

## [2.0.6] - 2026-08-10

### Changed

- Version alignment with harness **2.0.6**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.6**.

## [2.0.5] - 2026-08-10

### Changed

- Version alignment with harness **2.0.5**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.5**.

## [2.0.4] - 2026-08-09

### Changed

- Version alignment with harness **2.0.4**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.4**.

## [2.0.3] - 2026-08-09

### Changed

- Version alignment with harness **2.0.3**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.3**.

## [2.0.2] - 2026-08-08

### Changed

- Version alignment with harness **2.0.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.2**.

## [2.0.1] - 2026-08-08

### Changed

- Version alignment with harness **2.0.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.1**.

## [2.0.0] - 2026-08-08

### Changed

- Added the **`@mstar-harness/engine`** package scaffold: a version-aligned workspace library (`zod` + `ajv`, `node:*` only, no `bin`) with a typed `ValidationResult` + `readHarnessVersion()` placeholder core, wired into the release surface list (10 → 11), changelog assembly, and root workspaces.
- **Engine hardening (QC fix wave, slice 1)**: lease location/orphan/dual-write verify (`lease.verify.*`) moved into `@mstar-harness/engine` (CLI `mstar lease verify` is now a thin wrapper); `archiveResiduals` gained a plan-id path-traversal guard, the status write lock, and append dedup; `withStatusWriteLock` gained an ownership guard (never removes another writer's lockdir), a `holder.pid` crash-diagnosis file, and fast-fail reentrancy detection; `readHarnessVersion` reads the module's own manifest first (published installs no longer regress to `0.0.0`); `tech-debt-rollup` parity now mirrors jq `//` exactly (`false`/`0` edges tested against the bash oracle); residual closed-lifecycle completeness (`closed_at` + `closure_note`) and plan-row `Done` ⇒ no-lease invariants added. Release prep now ensures the `@mstar-harness/engine` registry row + package-history link in root changelog heads.
- **Harness Workflow Engine positioning (iteration v2.0.0)**: unified engine-first descriptions across the 7 plugin manifests and the 4 package manifests; added `workflow-engine` / `workflow-enforcement` / `deterministic-workflow` / `harness-workflow` keywords to the root plugin manifest; re-framed README.md / README_CN.md around deterministic workflow gates enforced by a TS engine (not prompts alone) with judgment staying in `mstar-*` skills, plus a What-ships table (Harness Workflow Engine / mstar CLI / `mstar-*` skills / host adapters).

- Version alignment with harness **2.0.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **2.0.0**.

### Changed

- `mstar dispatch validate` derives the default-branch gate branch FROM the Assignment's own branch forms (create-form name / Working branch / Branch policy branch), with `--branch` / `$MSTAR_WORKING_BRANCH` as context fallbacks (qc2 W-1 / qc3 F-2); read-only roles (scout/explore) skip both branch gates (qc3 F-1).
- Local `parseBranchPolicyDirectOnBranch` removed — CLI consumes the engine's single branch-form grammar (`parseAssignmentBranchForms` / `parseBranchPolicyDirectOnBranch`) (qc1 F-001).

## [1.8.9] - 2026-08-07

### Changed

- Added a portable **Agent Plugins v1.0.0** manifest (`plugin.json`) at the repo root, aligned with the CLI release surface (`skills/` is the Agent Skills component), plus `mstar-harness plugin validate` to check the package (including `mcp.json` / `skills/`) against the Agent Plugins v1.0.0 spec.

- Version alignment with harness **1.8.9**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.9**.

## [1.8.8] - 2026-08-06

### Changed

- Version alignment with harness **1.8.8**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.8**.

## [1.8.7] - 2026-08-06

### Changed

- Version alignment with harness **1.8.7**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.7**.

## [1.8.6] - 2026-08-06

### Changed

- Version alignment with harness **1.8.6** (no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.6**.

## [1.8.5] - 2026-08-06

### Changed

- omp `init` post-install note: Host adapter now `mstar-host → references/omp.md` (`skill://…`) instead of consumer-cwd `skills/mstar-host/…`.
- Version alignment with harness **1.8.5**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.5**.

## [1.8.4] - 2026-08-06

- Version alignment with harness **1.8.4** (skill-relative script path docs; no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.4**.

## [1.8.3] - 2026-08-05

- Version alignment with harness **1.8.3** (omp host docs prefer live-schema role `task.agent`; no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.3**.

## [1.8.2] - 2026-08-05

- Derive ZCode marketplace/`doctor` version from `packages/cli/package.json` via shared `readHarnessVersion()` (remove drifted hardcoded `PLUGIN_VERSION`).
- Version alignment with harness **1.8.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.2**.

## [1.8.1] - 2026-08-05

- Version alignment with harness **1.8.1** (no CLI API change; bundled skills/commands optimization landed at the harness layer).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.8.1**.

## [1.8.0] - 2026-08-05

- **Codex adapter**: `CODEX_PROJECT_COMMAND_NAMES` (renamed from `CODEX_ITERATION_SKILL_NAMES`) now includes `codebase-audit`; project-scoped install materializes it alongside iteration commands. Global-scoped install warning updated.
- **omp adapter**: smoke test (`COMMAND_SMOKE`) and install notes include `codebase-audit`.

## [1.7.1] - 2026-08-05

- Fix omp doctor plugin detection for `omp plugin list --json` `{ npm, marketplace }` shape.
- Version alignment with harness **1.7.1**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.7.1**.

## [1.7.0] - 2026-08-05

- Add **`omp`** install target (`packages/cli/src/adapters/omp.ts`): link/install Morning Star into omp plugins; doctor validates markers + `omp plugin list`.
- Version alignment with harness **1.7.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.7.0**.


## 1.6.1

- Version alignment with harness **1.6.1** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.6.1**.

## 1.6.0

- **New `zcode` install target**: `init --target zcode` registers a `mstar-local` marketplace (github source) in `~/.zcode/cli/plugins/{known_marketplaces.json, marketplaces/mstar-local/marketplace.json}`; `doctor --target zcode` validates both JSON files + checkout + gitignore. Project scope keeps a local `.zcode/plugin-checkout` for smoke checks. `SUPPORTED_TARGETS` now includes `zcode`; `shared-install` `HARNESS_MARKERS` also accepts `.zcode-plugin/plugin.json`.
- Version alignment with harness **1.6.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.6.0**.

## 1.5.6

- Version alignment with harness **1.5.6** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.6**.

## 1.5.5

- Version alignment with harness **1.5.5** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.5**.

## 1.5.4

- Version alignment with harness **1.5.4** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.4**.

## 1.5.3

- Version alignment with harness **1.5.3** (no CLI API change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.3**.

## 1.5.2

- Project `init`/`doctor` (Cursor/Codex project scope): append/check full harness **process** gitignore set under `.mstar/` and legacy `.agents/` (`archived/`, `iterations/`, `plans/`, `sdd/`, `notes.json`, `status.json`). Results paths (`knowledge/`, `specs/`, `AGENTS.md`) are not forced gitignored.
- Version alignment with harness **1.5.2**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.2**.

## 1.5.1

- Version alignment with harness **1.5.1** (Phase 5 push cadence; no CLI API change).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.1**.

## 1.5.0

- Version alignment with harness **1.5.0** (iteration Phase 2 worktree/lease + Phase 5 babysit-first helpers; no CLI API change in this bump).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.5.0**.

## 1.4.0

- Version alignment with harness **1.4.0** (Kimi host installs via Kimi TUI `/plugins install`; no CLI `--target kimi`).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.4.0**.

## 1.3.2

- Version alignment with harness **1.3.2** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.2**.

## 1.3.1

- Version alignment with harness **1.3.1** (iteration package layout; no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.1**.

## 1.3.0

- Codex project install: materialize `iteration-start`, `iteration-drive`, and `iteration-loop` as `.agents/skills/*/SKILL.md` symlinks; `doctor` validates links; global install skips with warning.
- Version alignment with harness **1.3.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.3.0**.

## 1.2.1

- Version alignment with harness **1.2.1** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.2.1**.

## 1.2.0

- OpenCode `init` fast path: schema + plugin only; no interactive model picking / no `opencode models` discovery (avoids silent hangs). Optional `--*-model` flags remain as advanced overrides.
- Version alignment with harness **1.2.0**.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.2.0**.

## 1.1.0

- Version alignment with harness **1.1.0** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.1.0**.

## 1.0.6

- Version alignment with harness **1.0.6** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.6**.

## 1.0.5

- Version alignment with harness **1.0.5** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.5**.

## 1.0.4

- Version alignment with harness **1.0.4** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.4**.

## 1.0.3

- Version alignment with harness **1.0.2** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.2**.

## 1.0.1

- Version alignment with harness **1.0.1** (no CLI behavior change in this release).

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.1**.

## 1.0.0

- Project `init`/`doctor`: append/check `.mstar/sdd/` and `.agents/sdd/` gitignore entries for SDD scratch.

See root [CHANGELOG.md](../../CHANGELOG.md) **1.0.0**.

## 0.5.4

- **Layout fix**: Cursor global/project plugin paths are **real git checkouts** (`git clone` / `git pull`), not symlinks to `~/.mstar/harness`. Cursor does not discover symlinked plugin directories.
- `doctor --target cursor` fails if the plugin path is a symlink; `init` removes an existing symlink and clones.
- `~/.mstar/harness` remains the shared checkout for Codex marketplace local source and agent symlinks.

See root [CHANGELOG.md](../../CHANGELOG.md) **0.7.2**.

## 0.5.1

- align Cursor global/project plugin symlinks to `morning-star-harness` (matching plugin manifest `name`)
- validate plugin `agents/*.md` use Cursor-first frontmatter in `doctor --target cursor`

See root [CHANGELOG.md](../../CHANGELOG.md) **0.6.11**.

## 0.5.0

- maintain a shared local harness checkout at `~/.mstar/harness` for Cursor and Codex install flows
- change Cursor global/project installs to symlink host plugin paths to `~/.mstar/harness`
- change Codex installs to local-source marketplace entries and symlink `codex/agents/*.toml` into global/project Codex agent directories
- validate the local repo, marketplace entry, and Codex agent symlinks in `doctor --target codex`

## 0.4.0

- add `codex` target support in `init` and `doctor`
- write/update `~/.agents/plugins/marketplace.json` with a `"source": "url"` personal marketplace entry for Codex
- validate Codex personal marketplace metadata in `doctor --target codex`

## 0.3.1

- Version alignment with monorepo **0.3.1** (no CLI API change in this bump; see root changelog for harness/docs).

## 0.3.0

- Version alignment with monorepo **0.3.0** (no CLI API change in this bump; see root changelog for harness/docs).

## 0.2.0

- add target adapter architecture for CLI flows
- add `cursor` target support in `init` and `doctor`
  - `global`: install plugin via symlink at `~/.cursor/plugins/local/morning-star-harness`
  - `project`: install plugin via symlink at `.cursor/plugins/morning-star-harness`
- keep `opencode` model-driven init flow with schema/plugin/model validation
- default `--scope` behavior to `project` when not provided
- add standalone CLI docs at `docs/cli.md` and document target-based usage
