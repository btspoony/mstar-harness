# Changelog

Chinese summary: [CHANGELOG_CN.md](CHANGELOG_CN.md).

All notable changes to this repository are documented here. Published harness surfaces are at **0.6.3** unless noted:

| Surface | Package / manifest | Version |
| --- | --- | --- |
| Monorepo root | `morning-star` (`package.json`) | **0.6.3** |
| CLI | `@mstar-harness/cli` (`packages/cli`) | **0.4.0** |
| OpenCode plugin | `@mstar-harness/opencode` (`packages/opencode`) | **0.6.3** |
| Cursor plugin | `.cursor-plugin/plugin.json` | **0.6.3** |
| Codex plugin | `.codex-plugin/plugin.json` | **0.6.3** |

Package-specific histories: [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md), [`packages/opencode/CHANGELOG.md`](packages/opencode/CHANGELOG.md).

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
