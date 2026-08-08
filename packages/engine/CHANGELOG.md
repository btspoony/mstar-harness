# Changelog

All notable changes to the `@mstar-harness/engine` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

### Added

- `design-md` module — `validateDesignTokenFrontmatter` (token-group/type checks per design-md-spec §1.5, `{path}` ref resolution), `assertLightDarkParity` (same key sets across light/dark), `completenessLevel` (MVP/Standard/Production with placeholder-driven upgrade suggestions).
- `audit` module — `validateAuditStatusBlocks` (Priority/Effort/Risk/Category/Depends on/Planned at enums), `redactSecrets` (conservative credential-pattern scan → `[REDACTED type@line in file]`, mstar-audit Hard Rule 4), `scaffoldAuditPlan` (audit-<date>/ README index + numbered plan files, monotonic numbering across re-runs).
- `compound` module — `validateSchemaYaml` (knowledge frontmatter vs schema.yaml rules embedded as constants, incl. category-mapping consistency), `referenceExists` (file-path existence + module-file heuristic for symbol refs), `assertIndexRows` (README.md index obligations), `scopeGuard` + `compoundRefreshScope` (compound-refresh scope SSOT).
- `roles` module — `validateRoleMapping` (13 role ids → `references/<role>.md` existence, shared-family contract for `fullstack-dev*` / `qc-specialist*`, parameter-table contract: reviewer_index exactly {1,2,3} with matching focus / `qc<index>` report_suffix), `lintLoadOrder` (every `mstar-*` topic skill declares `mstar-harness-core` in its Load Order / First action section).
- `host` module — `detectHost` (mstar-host ordered table cursor → opencode → omp → kimi → zcode → codex from tool-shape signals, `ambiguous` fallback), `resolveSkillRoot` (per-host skill-root resolution strings), type-only `HostAdapter` contract (optional `beforeStatusWrite` / `beforeDispatch` / `beforeMerge` + required `log`; no concrete adapters — pi/dsh deferred).
- `skill-authoring` module — `lintFrontmatter` (alias of `lint.lintSkillFrontmatter`, single parser), `lintFiveQuestion` (5-question body sections: Load Order / Workflow / Decision Rules / Evidence / References), `resolveAssetPath` (skill-relative asset-path instruction per host).
- `dispatch.parseAssignmentFields` exported (single Assignment header grammar, list-bullet acceptance folded in).
- `dispatch.parseAssignmentBranchForms` + `dispatch.parseBranchPolicyDirectOnBranch` — engine-owned branch-form grammar shared by CLI and host hooks (qc1 F-001).
- `dispatch.isReadOnlyAssignmentRole` — scout/explore read-only role detection (qc3 F-1).
- `worktree` git probes: bounded timeout (10s default, `MSTAR_GIT_PROBE_TIMEOUT_MS` env / per-call `timeoutMs`), fail-closed into `branch-probe-failed` on timeout (qc3 F-4).

### Changed

- `dispatch.validateAssignmentFields` keeps `assignment.presence.*` codes as aliases on the three core-field violations — one violation per missing field, single parser (qc1 F-002).
- `dispatch.validateAssignmentFields` flags dangling create-form typos (`create <new> from` / `create from <base>`) as `assignment.field.branch-missing-base` (qc2 S-1 / qc3 F-5).
- `dispatch.executionModeToN('targeted')` dedupes listed seats before counting — N = distinct seats (qc2 S-3).
- `worktree` L1 lease-equals-control, L2 track-path-collision and `assertControlVsFeaturePath` compare normalized paths (`path.resolve`) (qc2 S-4).
