# Changelog

Chinese summary: [CHANGELOG_CN.md](CHANGELOG_CN.md).

All notable changes to this repository are documented here. Published harness surfaces are at **0.6.23** unless noted:

| Surface | Package / manifest | Version |
| --- | --- | --- |
| Monorepo root | `morning-star` (`package.json`) | **0.6.23** |
| CLI | `@mstar-harness/cli` (`packages/cli`) | **0.5.3** |
| OpenCode plugin | `@mstar-harness/opencode` (`packages/opencode`) | **0.6.23** |
| Cursor plugin | `.cursor-plugin/plugin.json` | **0.6.23** |
| Codex plugin | `.codex-plugin/plugin.json` | **0.6.23** |

Package-specific histories: [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md), [`packages/opencode/CHANGELOG.md`](packages/opencode/CHANGELOG.md).

## [0.6.23] - 2026-06-30

### Harness (skills / iteration, compound, strategy, qc, commands)

- **New `mstar-compound` skill**: Knowledge crystallization with Bug/Knowledge dual-track templates, YAML frontmatter schema, 8-question self-diagnosis checklist, overlap detection (update existing docs rather than create duplicates), discoverability check (propose AGENTS.md edits), and CONCEPTS.md vocabulary synergy. Compound executes at **iteration-close**, not per-plan Done.
- **New `mstar-compound-refresh` skill**: Knowledge maintenance — audit/update/consolidate/replace/delete knowledge docs against current codebase, CONCEPTS.md reconciliation.
- **New `mstar-strategy` skill**: STRATEGY.md creation and maintenance as project upstream anchor (vision, technology direction, guiding principles, decision log).
- **New `mstar-iteration` skill**: Full iteration lifecycle management — Phase 1 iteration-start (scope/roadmap lock, compass creation), Phase 2 Autonomous Execute (per-plan dispatch loop: branch → implement → QC → QA → Done → merge, cross-plan progress sync), Phase 3 iteration-close (compound round, roadmap update, retrospective, commit). Autonomous Execute driver moved here from `skills/pm/SKILL.md`; PM skill thinned to role identity, host entry, and dispatch-first rules only.
- **New `/bootstrap` command**: Distills STRATEGY.md, CONCEPTS.md, and baseline knowledge docs from existing codebase for projects with no/stale knowledge infrastructure (7-phase flow).
- **New `artifact-storage-paths.md`**: Single SSOT for all harness artifact paths under `mstar-plan-conventions`, referenced by all producing skills to prevent path drift.
- **QC deep review lenses**: Replaced persona subagent dispatch with self-applied lens checklists (12 lenses, 6 trigger signals). No subagent dispatch — resolves anti-recursion violation with `mstar-dispatch-gates`.
- **Updated index**: `mstar-harness-core` split lifecycle into per-plan and iteration-level cycles; all skill index tables, `mstar-roles` dependency matrix, and `mstar-phase-gates` per-plan gates updated.

### Version alignment

- Bump monorepo root, `@mstar-harness/opencode`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`: **0.6.22 → 0.6.23**. **`@mstar-harness/cli` remains 0.5.3**.

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
