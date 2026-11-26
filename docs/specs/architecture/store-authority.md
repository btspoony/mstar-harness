# Architecture: execution state authority

## Scope

This page describes the execution half of durable harness state: where `{HARNESS_DIR}/store.db` lives, how that location resolves, what each remaining table domain owns, how execution state is modeled, and how the store refuses work it cannot do safely. Collaboration facts — issues and findings, projects, milestones, portable catalog identity, and mirror ledgers — live in a separate user-level database per canonical repository, described in [collaboration-authority.md](collaboration-authority.md). Document corpora and their registration are in [document-corpus.md](document-corpus.md); how calls reach each authority is in [overview.md](overview.md).

## Current state

### Location and resolution

`{HARNESS_DIR}/store.db` is the control checkout's SQLite database for execution state, projections, host state, store meta, and the cross-domain bookkeeping beside them. It is not the collaboration authority: issues, findings, catalog identity, projects, milestones, and mirror/sync ledgers belong to the user-level repository database described in [collaboration-authority.md](collaboration-authority.md), and no execution read may serve them after cutover. The harness root is fixed: `packages/engine/src/path.ts` (`resolveHarnessDir`) derives `<git main worktree root>/.mstar/` from Git and nothing else. `harness_dir`, `MSTAR_HARNESS_DIR` and the legacy `.agents/` / `.plans/` / `plans/` candidates are retired as selectors (ADR 2026-11-20): the declared key and the environment variable are read and ignored, the legacy directories are never probed, and a checkout without `.mstar` therefore resolves no harness root — no error, no recovery edit. A CLI outside Git names the root with `--harness`. The execution store lives on the **control checkout** — the main worktree reported by `git worktree list --porcelain`; feature worktrees never resolve or create a store of their own. `mstar path resolve` prints the resolved `controlRoot`, `controlHarnessDir`, and linked-worktree facts, plus the resolved collaboration key, mode, and database path (or the code and reason it cannot be resolved).

Schema creation and migration are owned by `packages/engine/src/store-db.ts` (versioned migrations plus `schema_version`); `store.ts`, `store-read.ts`, and `store-migrate.ts` layer the read and migration surfaces on it.

### Table domains

The current schema (from `store-db.ts` migrations; the dropped intermediates `execution_leases` and `execution_sessions_coordinator` exist only inside migration history):

- **Execution authority** (`EXECUTION_TABLE_NAMES`): `execution_meta`, `execution_workflows`, `execution_registry`, `execution_plans`, `execution_sessions`, `execution_integration_leases`, `execution_inputs`, `execution_operations`, `execution_migrations`. These are the only execution authority; ACTIVE execution reads never fall back to leftover root/snapshot/session files.
- **Execution-side catalog pins**: `catalog_execution_bindings` — the workflow→catalog pin (kind, id, root kind, relative path, catalog revision, input hash, pin JSON, operation id). Pins stay in execution and resolve their `(kind, id)` against the collaboration catalog by logical reference; the cross-file foreign key that cannot hold after the split is gone.
- **Cross-domain bookkeeping**: `execution_collaboration_intents` (the `prepared` / `declined` / `confirmed` reservations of the four composite operations plus the per-phase `issue-move` ones) and `collaboration_cutover` (the single-row fence ledger recording manifest identity, the exact source generation, the target stamp and the retained pre-fence image). Collaboration-owned tables — `issues`, `occurrences`, `issue_transitions`, `relations`, `provenance`, `issue_project_moves`, `project_bindings`, `project_milestones`, `issue_sync_state`, `sync_cursor`, `sync_runs`, `catalog_entities`, `catalog_links`, `catalog_operations`, `issue_counter` — are created by earlier migrations but hold no authority in this file: a fresh store leaves them empty, and a cutover fence drops them from a combined source. Rows surviving before that fence make this checkout the legacy owner and refuse collaboration reads.
- **Projections**: `projection_meta`, `projection_sources`, `projection_workflows`, `projection_plans`, `projection_compasses`, `projection_leases` — read-side projections (e.g. dashboard views) rebuilt from sources; projections never reset runtime state. `projection_roadmaps` is migration history only; no projection table carries collaboration content.
- **dsh host state**: `dsh_session_bindings`, `dsh_accepted_identities`, `dsh_ledger_events`, `dsh_scan_bounds`, `dsh_status_emissions`.
- **Store meta**: `store_meta`, `store_operations`, `migration_receipts`. Mirror run leases and cursors (`sync_runs`, `sync_cursor`) belong to the collaboration authority, not this file.

### Execution lifecycle model

A registered workflow is one row in `execution_workflows` with its phase/status, branch anchors (`branch.base` / `branch.target` / `branch.integration`), delivery kind, and completion state. Plans are rows in `execution_plans` (state, progress, task list, QC/PM Acceptance, done timestamps, source branch/worktree, revision counter) keyed to their workflow. `execution_sessions` tracks the active coordinator binding per workflow (one active coordinator row enforced by a partial unique index). Registered inputs — e.g. a plan's frozen `primary_spec` / `spec_refs` / iteration compass references — live in `execution_inputs`. Integration is serialized by `execution_integration_leases`; the append-only operation record is `execution_operations`. An operation that also changes collaboration facts first reserves them here in `execution_collaboration_intents` (one pending reservation per addressed plan row), then commits its collaboration effect in the other database, then finalizes here; an outstanding reservation is execution state, not a collaboration read. Workflow notes remain file-native under `{WORKFLOW_DIR}` (`workflows/<id>/notes.jsonl`) — notes are not DB events.

### Bootstrap and pre-activation state

Bootstrap is `mstar harness scaffold` (authored directories; no store) followed by `mstar store init` (creates and activates the execution store). Legacy harnesses use `mstar store upgrade --operator <name>` to import recognized file-era state; a reviewed migration apply that has not been activated leaves a **staged store** (`store activate` is the separate activation step). Both verbs establish the repository's collaboration authority first — created or reused, never cleared — so a checkout always names the repository lane before its execution half reports state; a combined store still holding collaboration rows refuses with the cutover route instead. File-era execution state — `status.json`, `workflows/<id>/snapshot.json`, session envelopes — is pre-activation transport or an engine-absent fallback only; historical files are read-only direct inputs to `store upgrade`, with no staging writer or live file-state fallback on the ACTIVE route (`CONCEPTS.md` "Workflow lifecycle", "Staged store").

### Read/write refusal surface

The store refuses rather than guessing; its stable codes are declared in `packages/engine/src/execution-store.ts` and `packages/engine/src/host-state-store.ts`:

- `store.not-initialized` — no execution store exists where one is required; execution queries refuse instead of answering an empty result.
- `store.not-active` — a staged or not-yet-activated execution store: ordinary mutations and authority-shaped reads refuse.
- `collaboration.cutover-required` — this checkout still owns a combined source that holds collaboration rows, so neither runtime collaboration traffic nor the store bootstrap verbs proceed; hand that authority on with `mstar store collaboration plan`, then `apply`, then `activate` (see [collaboration-authority.md](collaboration-authority.md)). The collaboration lane's own codes (`not-initialized`, `not-active`, `unreadable`, `stale-binding`, `cutover-*`, `operation-partial`, `observation-*`, `backup-incomplete`) are declared in `collaboration-store.ts` and `collaboration-cutover.ts` and described there.
- `store.direct-write-refused` — a host write gate vetoed a direct write to the store (or its `-wal`/`-shm` sidecars). Every host imports the single-sourced path glue in `packages/engine/src/host-gate-paths.ts`: the landed-path resolver (chained realpath, case-folded, ancestor-walked) classifies a write target as store / retired project register (`project.register.retired`) / legacy fall-through before any document judgment; the same glue protects any path carrying the reserved `collaboration.db` basename. Enforcing hosts (`dsh`, `omp`, the ZCode hook, and `opencode-v2`) veto in both enforcement modes; the OpenCode v1 `tool.execute.before` surface is warn-only by documented contract. A symlink chain that cannot resolve refuses as `write.symlink-resolution-refused`.

## Invariants

- **One execution store per workspace, on the control checkout.** No feature worktree resolves, creates, or writes its own store; a linked worktree is never a second process SSOT.
- **Two domains, two owners.** Execution state is this store; collaboration state is the repository's user-level database. Neither authority serves the other's facts, and no execution handle reads collaboration tables after cutover.
- **ACTIVE means the store only.** Once a store is active, execution authority reads come from the `execution_*` tables; no root file, snapshot, or session envelope becomes a live fallback.
- **Refusal over guessing.** A missing, inactive, unreachable, or legacy-combined store produces a named refusal code, never an empty result or a silent write.
- **File-era state is transport or history.** `status.json` and snapshots are read-only migration inputs, not a writable mirror.
- **Staged is not active.** An applied but unactivated execution store refuses ordinary mutations until activation; the collaboration lane has its own staged-to-active lifecycle.
- **Schema changes are versioned migrations.** `schema_version` and `migration_receipts` record what ran; there is no ad-hoc DDL path, and the cutover's fence commits its own durable schema advance.

## Where it lives

- Schema, migrations, and table constants: `packages/engine/src/store-db.ts`; read and migration surfaces in `store.ts`, `store-read.ts`, `store-migrate.ts`.
- Root resolution: `resolveHarnessDir` in `packages/engine/src/path.ts`; the root is fixed at `<main worktree>/.mstar`, and `.mstarc` no longer declares it.
- Collaboration authority: identity, lane, binding, cutover and backup pair in `collaboration-identity.ts`, `collaboration-store.ts`, `collaboration-cutover.ts`, and `store-activation.ts`; current state in [collaboration-authority.md](collaboration-authority.md).
- Refusal codes: declared in `execution-store.ts`, `host-state-store.ts`, and the collaboration lane modules.
- Host write classification: `packages/engine/src/host-gate-paths.ts`, imported by every host gate.
- Lifecycle commands: `mstar harness scaffold`, `mstar store init`, `mstar store upgrade --operator <name>`, `mstar store activate`, `mstar store backup --out <abs-manifest>`, `mstar path resolve`.

## Change obligations

- **A migration that adds, renames, or drops a table** → update the table domains here in the same PR, and [collaboration-authority.md](collaboration-authority.md) when the change touches the collaboration lane's tables, the fence ledger, or the execution-side pins.
- **A new refusal code** → add it to the refusal surface with its trigger and scope; a collaboration-lane code is documented in [collaboration-authority.md](collaboration-authority.md).
- **A change to override precedence or probe order** → update location and resolution; a change that affects corpora also updates [document-corpus.md](document-corpus.md).
- **A new execution concept or column group** → describe it in the execution lifecycle model and keep the model consistent with `EXECUTION_TABLE_NAMES`.
- **A change to the execution side of the backup pair or the fence** → update Bootstrap, the table domains, and the cutover description in [collaboration-authority.md](collaboration-authority.md).
- **Reasons behind a schema or authority decision** → an ADR under `docs/adr/`; this page states the resulting behavior only.
