# Architecture: the store as single state authority

## Scope

This page describes where the harness keeps durable registry-shaped state, how that location resolves, what each table domain owns, how execution state is modeled, and how the store refuses work it cannot do safely. Document corpora and their registration are in [document-corpus.md](document-corpus.md); how calls reach the store is in [overview.md](overview.md).

## Current state

### Location and resolution

`{HARNESS_DIR}/store.db` is a single SQLite database holding every durable registry-shaped fact the harness keeps. The harness root resolves through `packages/engine/src/path.ts` (`resolveHarnessDir`): explicit override (`opts.harnessDir` / `MSTAR_HARNESS_DIR`) → `.mstarc` `[config] harness_dir` → conventional probes (`.mstar`, `.agents/`, `plans/`), never crossing the workspace root. The store lives on the **control checkout** — the main worktree reported by `git worktree list --porcelain`; feature worktrees never resolve or create a store of their own. `mstar path resolve` prints the resolved `controlRoot`, `controlHarnessDir`, and linked-worktree facts.

Schema creation and migration are owned by `packages/engine/src/store-db.ts` (versioned migrations plus `schema_version`); `store.ts`, `store-read.ts`, and `store-migrate.ts` layer the read and migration surfaces on it.

### Table domains

The current schema (from `store-db.ts` migrations; the dropped intermediates `execution_leases` and `execution_sessions_coordinator` exist only inside migration history):

- **Execution authority** (`EXECUTION_TABLE_NAMES`): `execution_meta`, `execution_workflows`, `execution_registry`, `execution_plans`, `execution_sessions`, `execution_integration_leases`, `execution_inputs`, `execution_operations`, `execution_migrations`. These are the only execution authority; ACTIVE execution reads never fall back to leftover root/snapshot/session files.
- **Catalog**: `catalog_entities`, `catalog_links`, `catalog_operations`, `catalog_execution_bindings` — identity, path, kind, description, project/iteration membership, spec/knowledge relations, and lifecycle (`active` / `archived` / `superseded`) for plans, iterations, projects, and documents.
- **Issues**: `issues`, `issue_counter`, `occurrences`, `issue_transitions`, `issue_project_moves`, `issue_sync_state` — open findings are issues with severity and lifecycle provenance (the v1 root `residual_findings` array is retired; the project register is migration history only).
- **Project governance**: `project_bindings`, `project_roadmaps`, `project_milestones` — project identity and roadmap/milestone content; flows without an explicit project fall back to `_default`.
- **Projections**: `projection_meta`, `projection_sources`, `projection_workflows`, `projection_plans`, `projection_compasses`, `projection_roadmaps`, `projection_leases` — read-side projections (e.g. dashboard views) rebuilt from sources; projections never reset runtime state.
- **dsh host state**: `dsh_session_bindings`, `dsh_accepted_identities`, `dsh_ledger_events`, `dsh_scan_bounds`, `dsh_status_emissions`.
- **Store meta**: `store_meta`, `store_operations`, `migration_receipts`, plus sync bookkeeping (`sync_runs`, `sync_cursor`).

### Execution lifecycle model

A registered workflow is one row in `execution_workflows` with its phase/status, branch anchors (`branch.base` / `branch.target` / `branch.integration`), delivery kind, and completion state. Plans are rows in `execution_plans` (state, progress, task list, QC/PM Acceptance, done timestamps, source branch/worktree, revision counter) keyed to their workflow. `execution_sessions` tracks the active coordinator binding per workflow (one active coordinator row enforced by a partial unique index). Registered inputs — e.g. a plan's frozen `primary_spec` / `spec_refs` / iteration compass references — live in `execution_inputs`. Integration is serialized by `execution_integration_leases`; the append-only operation record is `execution_operations`. Workflow notes remain file-native under `{WORKFLOW_DIR}` (`workflows/<id>/notes.jsonl`) — notes are not DB events.

### Bootstrap and pre-activation state

Bootstrap is `mstar harness scaffold` (authored directories; no store) followed by `mstar store init` (creates and activates the store). Legacy harnesses use `mstar store upgrade --operator <name>` to import recognized file-era state; a reviewed migration apply that has not been activated leaves a **staged store** (`store activate` is the separate activation step). File-era execution state — `status.json`, `workflows/<id>/snapshot.json`, session envelopes — is pre-activation transport or an engine-absent fallback only; historical files are read-only direct inputs to `store upgrade`, with no staging writer or live file-state fallback on the ACTIVE route (`CONCEPTS.md` "Workflow lifecycle", "Staged store").

### Read/write refusal surface

The store refuses rather than guessing; the stable codes are declared in `packages/engine/src/execution-store.ts`, `catalog.ts`, `issue.ts`, and `host-state-store.ts`:

- `store.not-initialized` — no store exists where one is required; queries refuse instead of answering an empty catalog.
- `store.not-active` — a staged or not-yet-activated store: read-only catalog `list`/`show` is allowed, ordinary issue/catalog mutations and authority-shaped reads refuse.
- `store.direct-write-refused` — a host write gate vetoed a direct write to the store (or its `-wal`/`-shm` sidecars). Every host imports the single-sourced path glue in `packages/engine/src/host-gate-paths.ts`: the landed-path resolver (chained realpath, case-folded, ancestor-walked) classifies a write target as store / retired project register (`project.register.retired`) / legacy fall-through before any document judgment. Enforcing hosts (`dsh`, `omp`, the ZCode hook) veto in both enforcement modes; the OpenCode `tool.execute.before` surface is warn-only by documented contract. A symlink chain that cannot resolve refuses as `write.symlink-resolution-refused`.

## Invariants

- **One store per workspace, on the control checkout.** No feature worktree resolves, creates, or writes its own store; a linked worktree is never a second process SSOT.
- **ACTIVE means the store only.** Once a store is active, execution authority reads come from the `execution_*` tables; no root file, snapshot, or session envelope becomes a live fallback.
- **Refusal over guessing.** A missing, inactive, or unreachable store produces a named refusal code, never an empty result or a silent write.
- **File-era state is transport or history.** `status.json` and snapshots are read-only migration inputs, not a writable mirror.
- **Staged is not active.** An applied but unactivated migration is readable for catalog inspection only; ordinary mutations require activation.
- **Schema changes are versioned migrations.** `schema_version` and `migration_receipts` record what ran; there is no ad-hoc DDL path.

## Where it lives

- Schema, migrations, and table constants: `packages/engine/src/store-db.ts`; read and migration surfaces in `store.ts`, `store-read.ts`, `store-migrate.ts`.
- Root resolution: `resolveHarnessDir` in `packages/engine/src/path.ts`; `.mstarc` `[config] harness_dir` is this repository's pin (`.mstar`).
- Refusal codes: declared in `execution-store.ts`, `catalog.ts`, `issue.ts`, `host-state-store.ts`.
- Host write classification: `packages/engine/src/host-gate-paths.ts`, imported by every host gate.
- Lifecycle commands: `mstar harness scaffold`, `mstar store init`, `mstar store upgrade --operator <name>`, `mstar store activate`, `mstar path resolve`.

## Change obligations

- **A migration that adds, renames, or drops a table** → update the table domains here in the same PR.
- **A new refusal code** → add it to the refusal surface with its trigger and scope.
- **A change to override precedence or probe order** → update location and resolution; a change that affects corpora also updates [document-corpus.md](document-corpus.md).
- **A new execution concept or column group** → describe it in the execution lifecycle model and keep the model consistent with `EXECUTION_TABLE_NAMES`.
- **Reasons behind a schema or authority decision** → an ADR under `docs/adr/`; this page states the resulting behavior only.
