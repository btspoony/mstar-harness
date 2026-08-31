# Changelog

All notable changes to the `@mstar-harness/opencode` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

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

- `beforeDispatch` Assignment lint is engine-only: local `validateAssignmentPresence` parser removed (qc1 F-002); branch-form parsing via engine `parseAssignmentBranchForms` / `parseBranchPolicyDirectOnBranch` (qc1 F-001); read-only roles (scout/explore) skip the branch-form + default-branch gates (qc3 F-1 / qc2 S-5).
- `antiRecursionPrecheck` wired into the hook: task dispatch whose role binding (`args.subagent` / `args.subagent_type`) equals the Assignment's `Execute as` warns at critical severity, warn-only (qc1 F-004 / qc2 S-2).

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
