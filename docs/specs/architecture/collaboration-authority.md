# Architecture: collaboration authority

## Scope

This page describes the collaboration domain — issues and findings, their occurrences, transitions, relations and provenance, projects and their provider bindings, roadmaps, milestones, and portable catalog identity — and the one user-level SQLite database per canonical repository that owns it. It covers identity and mode selection, the staged-to-active lifecycle, the cutover that moves a legacy combined store out, read completeness and consumer evidence, the two receipts of a cross-domain operation, and backup/restore boundaries.

Execution state (workflows, plans, sessions, leases, coordinator bindings, projections, host state) stays in the control checkout's `{HARNESS_DIR}/store.db` and is described in [store-authority.md](store-authority.md). Tracked document bodies and catalog registration are described in [document-corpus.md](document-corpus.md). Why the domains were split — and the unimplemented `remote` mode — is an ADR under `docs/adr/`; this page states only the implemented behavior.

## Current state

### Identity, mode and location

`resolveCollaborationLocation` derives a canonical repository key, the configured mode, and the database path. It reads Git and `.mstarc` only: it opens no database and creates no directory, so an uninitialized scope is still disclosed.

- **Configuration.** `.mstarc` carries a `[collaboration]` section: the header alone on its line, then `mode=local` or `mode=mirror`, and `repo_id` only for a genuinely origin-less repository. A minimal declaration is:

  ```ini
  [collaboration]
  mode=local
  ```

  The parser reads `key=value` lines inside the section, so an inline `[collaboration] mode=local` written on one line leaves the mode unset and refuses `collaboration.mode-required`. The main checkout supplies both the origin and the `.mstarc` value; a linked worktree cannot answer as its own repository. The legacy normalized repo/author marker is not a storage key and is not re-encoded. Per-project provider identity keeps its existing `project_bindings` rows and `[linear]` semantics.
- **Origin canonicalization.** Portable `https://`, `http://`, `ssh://` and SCP SSH (`[user@]host:path`) origins are accepted. Userinfo is discarded, the DNS host lowercased with one terminal dot stripped, a scheme-default port elided and any other port retained as `host~port`. One terminal `.git` and trailing slashes are stripped; GitHub owner/repository path segments are lowercased while other hosts keep their case; nested owner segments are preserved. A query or fragment, a literal or percent-encoded dot segment, a backslash, an ASCII control character, an unsafe path segment, a non-portable transport, or several disagreeing fetch origins refuse `collaboration.repo-identity-unresolved`. Git unreadable is a refusal, never an origin-less checkout.
- **Key and path.** With an origin the key is `host/owner/repo` and the database is `<user home>/.mstar/repos/<host>/<owner>/<repo>/collaboration.db`. Without an origin the logical key is `id:<repo_id>` (`[a-z0-9][a-z0-9._-]*`, at most 128 characters) but the storage directory is the reserved `_id` rung: `<user home>/.mstar/repos/_id/<repo_id>/collaboration.db`, never an `id:` directory. Directory segments carry the same filesystem spelling rules: uppercase ASCII is percent-encoded so case-insensitive filesystems keep distinct repositories apart, and a segment spelling a reserved authority basename (`collaboration.db`, `-wal`, `-shm`, `-journal`) is escaped. Every existing component of that tree is inspected without following a link and must carry no group/other permission bits; a symlinked or redirected component, or a target outside the private root, is `collaboration.unreadable`.
- **Modes.** `local` and `mirror` select the same user-level database as the authority. `mirror` adds only the pre-existing one-way host-owned Linear delivery: the local database remains authoritative, a local commit and a confirmed delivery are separate outcomes, and importing remote observations never mutates local authority. `remote` is recognized and refused with `collaboration.mode-unavailable` before any store access; provider fallback, a second writable copy, and any remote round-trip are not implemented. A missing mode is `collaboration.mode-required`, an unknown one `collaboration.mode-invalid`, an unreadable `.mstarc` (symlink, directory, unreadable file) `collaboration.config-unreadable`. Editing mode never relocates or rebinds a live authority.

### Database and lifecycle

The lane is an independent SQLite database with its own `schema_version` ledger and one immutable migration (`collaboration-core`, version 1). Admission is strict: the closed table inventory and each table's required columns must match this build exactly, and the single `collaboration_meta` row must be well formed. A missing table, an unexpected table, a lost column, a corrupt header, or an unsupported schema refuses `collaboration.unreadable` instead of admitting a handle whose queries would fail later. Bounded contention is the shared `store.busy`; an unsupported runtime or schema passes through as `store.runtime-unsupported` / `store.schema-unsupported`.

`collaboration_meta` carries `repository_key`, `mode`, `store_id`, `authority_state`, `authority_epoch`, `revision` and `catalog_revision`. The domain tables are `issues`, `issue_counter`, `occurrences`, `issue_transitions`, `relations`, `provenance`, `issue_project_moves`, `project_bindings`, `project_roadmaps`, `project_milestones`, `issue_sync_state`, `sync_cursor`, `sync_runs`, `catalog_entities`, `catalog_links`, `catalog_operations`, the effect ledger `collaboration_operations`, and the publication ledger `cutover_publications`. Execution-side catalog pins stay in the execution store's `catalog_execution_bindings`.

States and their codes:

- **Missing** — no database at the resolved path: `collaboration.not-initialized`. Nothing is created by a read.
- **Staged** — a complete, verified database whose `authority_state` is `staged`: `collaboration.not-active`. Only the cutover's stage inspection, adoption's lineage check, and the backup/restore validators open it; it is never runtime business data.
- **Active** — the published generation the runtime reads and writes.
- **Unreadable** — present but invalid, corrupt, inaccessible, or foreign: `collaboration.unreadable`.
- **Stale binding** — the checkout's recorded binding, the database's recorded key/mode, or an expected `store_id`/`epoch` disagrees: `collaboration.stale-binding`.

`initializeCollaborationStore` is create-only. A missing database is built complete in a private staging directory whose file carries the reserved basename, verified as this build's own store, folded into one self-contained file, and published with one create-only hard link; a matching record already on disk is reused without clearing it, and a record for another repository, mode, state, store id or schema refuses. Two initializers racing on one scope settle on the first published record.

### Bootstrap, binding and adoption

`store init` and `store upgrade` establish the repository's collaboration authority **before** the execution half reports anything: the lane is created or reused (never cleared), and a freshly created empty staged lane becomes this scope's first active generation. A combined store that still holds collaboration rows is not a fresh scope and refuses with `collaboration.cutover-required`.

Each control checkout's ownership of one generation is recorded in `{HARNESS_DIR}/collaboration-binding.json` (key, mode, store id, epoch, state). A `claim` row is attempt-scoped evidence that readers ignore; `active` is the finalized binding. Consequences:

- A checkout that resolves a different repository key or mode than its active binding refuses `collaboration.stale-binding`; an origin or `.mstarc` change never re-points a bound checkout.
- An **active** authority with no finalized binding in this checkout is not a fresh clone: `store init` never adopts it, and a read refuses with the adoption route. `mstar store collaboration adopt --harness <abs> [--expect-store <store-id>]` is the only supported acquisition: it verifies the canonical scope, the lane metadata and the recorded publication lineage (cutover publication, restore or file-era activation row) for the exact live store **and** epoch, writes nothing but this checkout's binding, is idempotent for the same binding, and refuses a staged authority, a foreign checkout, a missing/ambiguous/mismatched lineage, or a claim naming another generation.

### Cutover from a combined store

An unfenced execution store that still holds collaboration rows is a legacy owner. Runtime reads, `store init`, `store upgrade` and a restore all refuse it with `collaboration.cutover-required`; the reviewed cutover hands that authority on.

`mstar store collaboration plan --harness <abs> --out <abs>` inspects the source read-only and writes a manifest: `version`, `manifestId` (a digest of the body), the frozen source stamp (`storeId`, `epoch`, `schemaVersion`, `revision`, `catalogRevision`), the source digest and row counts, the resolved `repoKey`/`mode`, and `blockers`. Blockers are an open mirror run (`sync_runs` row) or a catalog journal entry not yet `committed`; they are reported as `collaboration.cutover-not-quiescent` and never guessed away. The verb creates nothing else.

`mstar store collaboration apply --harness <abs> --manifest <abs>` re-derives the manifest digest (a hand-edited manifest is refused), re-checks the scope, refuses a non-empty blocker list, and stages a verified copy of the frozen rows into the canonical target under the source write lock. An identical staged receipt is reused; a target that progressed past verification, or a source already fenced, is never restaged.

`mstar store collaboration activate --harness <abs> --manifest <abs> --operator <name> --attestation <abs>` is the only publication step. It validates the operator's full `ActivationAttestation` — including its `cutover` block naming the exact `repoKey`, `mode`, control root, source store/epoch/schema, the stopped handles and `allHandlesStopped`, bound to the running build, with no generated self-attestation — then, in one source transaction under SQLite write exclusion: re-reads the snapshot and blockers, takes or verifies the retained pre-fence image, commits the fence ledger row in the execution store's `collaboration_cutover`, drops the moved collaboration tables from the source (their rows survive only in the verified pre-fence image), and advances the execution schema. After that it makes the target active and commits its `cutover_publications` row and this checkout's binding together.

- **Lock.** `plan`, `apply`, `activate` and the durable fence step hold one local OS lock at `{HARNESS_DIR}/collaboration-cutover.lock` for the whole critical section. Exclusive create carries `{pid, host, startedAt, token}`; a same-host dead pid is recoverable through a serialized recovery slot, and a live or foreign-host holder refuses with a named recovery. There is no elapsed-time takeover.
- **Crash and replay.** A crash before the fence leaves a restageable attempt. A crash after the fence but before publication is finished by re-running the same `activate`, which reuses the persisted fence and commits only the missing publication. A staged slot and the publication serialize on the canonical target, so two clones cannot both fence under competing manifests (`collaboration.cutover-conflict`). An uncertain fence outcome is `collaboration.cutover-unconfirmed`: inspect the persisted fence record, the pre-fence image and the source's schema, and never retry blindly or claim the source is unchanged. There is no auto-rollback and no guessed merge.

### Read completeness and consumer evidence

Every view returns a `ReadEnvelope<T>` whose `collaboration` member is a scoped `CollaborationObservation`: `scope` (repository/project/plan/milestone/query key, including page bounds for a page), `completeness` (`complete` | `partial` | `unavailable`), `asOf` and, when a generation was observed, the authority stamp plus collaboration and catalog revisions. `asOf` is when the local snapshot was established — never file mtime, provider freshness, or a cross-file lock; `unavailable` carries `asOf: null` and `authority: null` with a code. `storeRevision`/`catalogRevision` in the envelope refer only to collaboration and are `null` when not observed.

Source requirements are declared per view, and a required source that cannot be read refuses rather than answering placeholder data:

- `issues`, `issue-detail`, `projects`, `roadmap` and `issue-flow` require collaboration only.
- `workflows` and `workflow-detail` require execution and disclose an optional catalog association; a project filter makes that association required.
- `iterations` and `iteration-detail` require execution and collaboration.
- `overview` requires both of its combined counts.
- Execution-only status and authority probes never open collaboration.

A known content gap is reported as `partial` with its original code. Findings evidence (`status findings-cleanup`, plan completion) must be one complete scoped observation of local open issues through `provenance(kind=plan, origin=scoped, target=<plan>)`; missing scope is `collaboration.observation-incomplete`, and a preflight observation that no longer applies is `collaboration.observation-stale`. Milestone delivery checks zero open issues inside its own collaboration mutation. Host authority gates probe this lane independently of execution through `probeCollaborationAuthority`: `active` retires the register file route, while `staged`, `absent` and `unavailable` never authorize a raw register write and are never inferred from the execution lane.

### Cross-domain operations and their receipts

Four composite actions span both domains — residual add, residual close, execution registration, and minimal import (including its upgrade caller). Each keeps a durable intent in the execution store's `execution_collaboration_intents` (`prepared`, `declined` with its deterministic cause, or `confirmed`) and its effect plus receipt in the collaboration lane's `collaboration_operations`; a standalone collaboration write is one-domain. The execution delta and the collaboration effect commit in separate `BEGIN IMMEDIATE` transactions with no nested write transaction and no `ATTACH`; each reservation excludes only the facts its operation will finalize.

An accepted operation whose work is outstanding refuses `collaboration.operation-partial` with the operation id, its phase (`prepared` or `collaboration-confirmed`) and the confirmed components; it is never success and the same id resumes it. A committed effect whose acknowledgement never landed keeps the business result and discloses `collaboration.acknowledgement-pending`: replaying the same operation repairs only the acknowledgement, while a missing or unreadable effect row is not repairable by replay and must be reconciled under the admitted authority.

### Mirror delivery and replay

Mirror delivery is split by design: the engine records run leases and results (`sync_runs`, `sync_cursor`, `issue_sync_state`) in the collaboration database; the host performs the Linear calls. `mstar issue-sync pending --project <id>` returns the `runId` it holds; `mstar issue-sync apply --project <id> --results <file|-> --run <runId>` continues exactly that run; results that name no run are refused (`sync.run-held`) and are reconciled with `mstar issue-sync ingest --project <id> --records <file|->` or named with `--adopt <localId>=<issueUrl|externalId>`. `--take-run` replaces a holder the operator confirmed dead and records no results. No credential, provider transport, or provider retry exists in the CLI or engine, and importing remote observations stays ledger-only and one-way.

### Backup and restore

`mstar store backup --out <abs-manifest>` publishes a **verified pair**, never one image sold as a backup: an execution image and a collaboration image are copied with their own SQLite snapshots into private, uniquely owned files beside the manifest, each re-opened and verified against its own bytes and row counts. Each domain must then hold still across its own snapshot window and match its own image: the execution generation (store id, epoch, revision, catalog revision) is compared before and after the copy, and the collaboration generation (its own store id, epoch, revision, catalog revision) is compared against both the live re-read and the verified image. The two are **separate generations**: the receipt records distinct execution and collaboration store ids, epochs and revisions, and never requires them to be equal. On top of that per-domain stability the pair needs a causal boundary — the execution root holds no prepared composite (live or in the frozen image), the lane is ACTIVE with no pending cutover claim and no unacknowledged or unreadable composite effect (a recorded decline is settled history), and no composite effect naming the paired execution store comes from an execution epoch ahead of the paired image. The two images are linked into their canonical names and the manifest published, all create-only. Every failure is `collaboration.backup-incomplete`; an image without a manifest is an interrupted attempt, not a backup. A repository backup covers this checkout's execution store plus the repository's collaboration image; it promises nothing about other clones' execution stores.

`mstar store collaboration restore --harness <abs> --backup <abs-manifest> --operator <name> --attestation <abs>` treats the operator-supplied manifest as the pair's authority: the supplied receipt must equal it, each image must still describe its own recorded generation (execution store id, epoch, schema, revisions and counts; collaboration store id, epoch, state, revisions and counts), the same causal and quiescence boundary must hold, and the addressed checkout must be able to own the authority. It then stages a private copy, bumps the restored collaboration epoch, records the restore receipt in the same transaction, and publishes create-only. An absent target is the only admitted destination: a live, corrupt or foreign collaboration authority is never overwritten, quarantined or deleted, and execution sessions, leases and rows are neither copied nor changed. Execution disaster recovery keeps its own explicit route — `mstar store execution export`, `restore-preview` and `restore` — which never writes, replaces or quarantines collaboration. There is no claim of atomic restoration across the two files; a single-domain restore leaves the other domain exactly as it was.

## Invariants

- **One collaboration database per canonical repository per user.** Clones and worktrees of one origin resolve the same database; forks, other repositories, and origin-less repositories without an explicit id do not.
- **Identity is the origin (or an explicit id).** Checkout paths, Git authors, branches, and provider markers never select authority.
- **Mode is explicit and single.** `local` and `mirror` share one local authority; `remote` is refused, and no unavailable mode selects a local fallback or a second writable copy.
- **Staged is not active.** Only an activation (fresh bootstrap, cutover, or restore) publishes a generation; staged bytes are never runtime business data.
- **A bound checkout is never retargeted.** A different resolved key/mode, store id or epoch refuses `collaboration.stale-binding` instead of drifting onto another repository's data.
- **Missing or partial evidence is a named refusal.** No consumer turns an unavailable, incomplete or stale collaboration source into zero, an empty list, or a successful gate.
- **Evidence carries its scope and time.** Every observation names what was observed, its completeness, and `asOf`; it never claims a provider lock or an atomic cross-domain predicate.
- **Two domains, separate receipts.** A composite operation's intent, effect and acknowledgement live in their owning domain, and a partial outcome is never reported as success.
- **Backup is a verified pair; restore is create-only.** Each domain is checked against its own before/after generation and its own image — the pair records distinct execution and collaboration store ids, epochs and revisions — and a restore never overwrites an existing authority.
- **Provider I/O stays in the host.** The CLI and engine hold no Linear credentials, transport, or client, and no remote round-trip is implemented.

## Where it lives

- Identity, mode and path: `resolveCollaborationLocation` in `packages/engine/src/collaboration-identity.ts`; `.mstarc` parsing (`[collaboration]`) in `packages/engine/src/mstarc.ts`.
- Schema, admission, probe and binding: `packages/engine/src/collaboration-store.ts`; binding file `{HARNESS_DIR}/collaboration-binding.json`.
- Cutover plan/apply/activate/fence and the local lock: `packages/engine/src/collaboration-cutover.ts`; fence ledger `collaboration_cutover` in the execution store.
- Composite intents and effects: `packages/engine/src/collaboration-operations.ts` with `execution-coordination.ts`, `execution-registration.ts`, `execution-minimal-import.ts`.
- Reads and evidence: `packages/engine/src/store-read.ts` (`ReadEnvelope`, view source declarations), `project.ts` (`CollaborationObservation`, findings evidence), `dashboard-view.ts`.
- Backup pair and restore: `packages/engine/src/store-activation.ts` (`backupRepositoryStores`, `restoreCollaborationBackup`).
- Host gates: `packages/dsh/src/gates/store-authority.ts`, `packages/dsh/src/gates/status.ts`, `packages/opencode/src/mstar.ts`, `packages/opencode-v2/src/gates/write.ts`, `packages/omp/src/hooks/pre/mstar-gates.ts`, `hooks/src/mstar-write-gate.ts`.
- Commands: `mstar path resolve`, `mstar store init`, `mstar store upgrade --operator <name>`, `mstar store backup --out <abs-manifest>`, `mstar store collaboration plan|apply|activate|adopt|restore`, `mstar store execution export|restore-preview|restore`, `mstar issue-sync pending|apply|ingest`.
- Refusal codes: `collaboration.repo-identity-unresolved`, `collaboration.config-unreadable`, `collaboration.mode-required`, `collaboration.mode-invalid`, `collaboration.mode-unavailable`, `collaboration.not-initialized`, `collaboration.not-active`, `collaboration.unreadable`, `collaboration.stale-binding`, `collaboration.cutover-required`, `collaboration.cutover-conflict`, `collaboration.cutover-not-quiescent`, `collaboration.cutover-unconfirmed`, `collaboration.operation-partial`, `collaboration.observation-incomplete`, `collaboration.observation-stale`, `collaboration.backup-incomplete`; the warning `collaboration.acknowledgement-pending`.

## Change obligations

- **A collaboration schema change** (table, column, migration) → update the table inventory, the admission rules, and [store-authority.md](store-authority.md) when the execution-side pin or fence ledger changes.
- **A new or renamed refusal code** → add it to the code list with its trigger and supported recovery, and update the shared command recovery text.
- **A change to identity, mode, path composition or binding** → update identity/location, the mode table and the Breaking changelog fragment; a behavior change also updates the operator commands here.
- **A new consumer or a changed source requirement** → update read completeness and the view declarations in `store-read.ts` in the same change.
- **A change to the cutover, fence or lock protocol** → update the cutover section and [store-authority.md](store-authority.md) (fence ledger, execution schema advance).
- **A change to the backup pair, restore boundary, or composite receipts** → update that section and the command list.
- **Provider work, `remote` mode, or cross-authority moves** → an ADR first; this page states only implemented, locally verified behavior and never promises a provider round-trip.
