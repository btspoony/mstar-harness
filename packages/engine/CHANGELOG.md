# Changelog

All notable changes to the `@mstar-harness/engine` package are documented in this file.

The monorepo root [CHANGELOG.md](../../CHANGELOG.md) summarizes cross-surface releases.

## [Unreleased]

### Added

- `dispatch.parseAssignmentFields` exported (single Assignment header grammar, list-bullet acceptance folded in).
- `dispatch.parseAssignmentBranchForms` + `dispatch.parseBranchPolicyDirectOnBranch` — engine-owned branch-form grammar shared by CLI and host hooks (qc1 F-001).
- `dispatch.isReadOnlyAssignmentRole` — scout/explore read-only role detection (qc3 F-1).
- `worktree` git probes: bounded timeout (10s default, `MSTAR_GIT_PROBE_TIMEOUT_MS` env / per-call `timeoutMs`), fail-closed into `branch-probe-failed` on timeout (qc3 F-4).

### Changed

- `dispatch.validateAssignmentFields` keeps `assignment.presence.*` codes as aliases on the three core-field violations — one violation per missing field, single parser (qc1 F-002).
- `dispatch.validateAssignmentFields` flags dangling create-form typos (`create <new> from` / `create from <base>`) as `assignment.field.branch-missing-base` (qc2 S-1 / qc3 F-5).
- `dispatch.executionModeToN('targeted')` dedupes listed seats before counting — N = distinct seats (qc2 S-3).
- `worktree` L1 lease-equals-control, L2 track-path-collision and `assertControlVsFeaturePath` compare normalized paths (`path.resolve`) (qc2 S-4).
