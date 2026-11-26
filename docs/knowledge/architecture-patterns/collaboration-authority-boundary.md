---
module: collaboration store, execution store, repository identity, host write gates
date: 2026-11-21
last_updated: 2026-11-26
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: <plan-id>
applies_when:
  - "adding or changing the collaboration database, its repository identity, or its authority lifecycle"
  - "routing issue, project, milestone, roadmap, catalog, or mirror reads and writes out of the execution store"
  - "changing host write gates that protect SQLite authority bytes"
tags:
  - collaboration-store
  - execution-authority
  - repository-identity
  - sqlite
  - host-gate
  - cutover
related_components:
  - packages/engine/src/collaboration-identity.ts
  - packages/engine/src/collaboration-store.ts
  - packages/engine/src/host-gate-paths.ts
  - packages/commands/src/families/local.ts
---

# Collaboration authority: a separate repository-scoped store, not a second execution store

## Context

Execution state is fixed at `{HARNESS_DIR}/store.db` under the Git control checkout. Collaboration records
(issues, projects, milestones, roadmaps, catalog identity and mirror ledger) must survive a replaced checkout,
so they move to one user-level SQLite database per canonical repository. The split cannot be a second writable
copy of the same authority, and a host write gate cannot protect only the execution filename.

## Guidance

- **Repository identity comes from Git origin, not from the checkout.** Normalize the origin to
  `host/owner/repository`; preserve nested owners, strip one terminal `.git`, elide scheme-default ports, and
  keep non-default ports as `host~port`. An origin-less repository may select an explicit `[collaboration]
  repo_id`; a path, Git author, `store_id`, or project name is never storage identity. Different origins and
  forks must not converge.
- **The mode is explicit and fail-closed.** `[collaboration] mode=local|mirror|remote` selects the authority.
  A missing, invalid, or unsupported mode refuses; it never defaults to local. Remote is not approximated by a
  local read.
- **The collaboration store has its own schema and staged/active lifecycle.** It contains no `execution_*`
  tables, workflow plans, sessions, leases, or coordinator rows. Creation is staged, verified, and only then
  active. A newer schema must be reported as an unsupported version, not as corruption: read the migration
  ledger before applying this version's inventory.
- **Admission is private and non-redirecting.** Validate every component beneath the trusted home anchor with
  `lstat` and refuse symlinked parents. Require private directories/files for existing storage. This store uses
  DELETE-journal mode; refuse a WAL layout before opening so a read probe cannot create `-wal`/`-shm` or change
  the journal mode of a refused store.
- **A host write gate must see the reserved filename everywhere.** `collaboration.db` and its
  `-wal`/`-shm`/`-journal` sidecars are reserved basenames at any path. Do not depend on a mutable marker file
  or an unbounded reverse scan: a marker can be removed or raced, and a scan cannot simultaneously prove a
  physical alias and allow an unrelated same-named file. The accepted trade-off is a fail-closed denial of any
  unrelated file with that reserved basename.
- **Publication must not leave an unprotected alias.** Stage under a private staging directory using the
  reserved database basename, publish the canonical entry, remove the staging alias on success and on failure,
  and fsync every new directory ancestor and parent entry before reporting success. A retry must re-run the
  complete ancestor barrier chain, not only the final directory.
- **The guarded write callback cannot own the transaction.** `withCollaborationWrite` opens `BEGIN IMMEDIATE`,
  revalidates the current authority/stamp, and commits or rolls back. The callback sees no `exec`; its `prepare`
  path rejects transaction control even after leading whitespace, comments, or empty statements. A refused
  callback must leave no effect and no side effect on the filesystem.
- **Reads and gates carry source evidence.** A collaboration observation records scope, authority stamp,
  revision, `asOf`, and completeness. Missing or incomplete collaboration data never becomes zero or success.
  A cross-domain completion gate records the observed facts and refuses known drift; it does not claim an
  atomic predicate across two SQLite files.
- **Cross-domain effects use recoverable intents and receipts.** A provider or second SQLite file cannot join
  the execution transaction. Persist intent and expected effects, apply one side, record a receipt, then
  finalize the other; a partial result is not success. This document covers the local authority foundation;
  remote authority and outbox semantics are separate decisions.

## Cutover, operations and recovery

- **Cut over as one authority switch.** Stage a transactionally consistent snapshot, verify stable IDs, foreign-key
  closure, revisions and catalog/history closure through the copied image, and keep the reviewed manifest bytes as
  the activation identity. Serialize plan/apply/activate/adopt/restore through one local lock; a stale same-host
  lock is recoverable only from a dead PID, never by an elapsed-time takeover.
- **Fence the source before publishing.** A reviewed activation requires an operator attestation bound to the exact
  repository, mode, control root, source store/epoch and stopped handles, plus an explicit `allHandlesStopped`
  assertion. The fence transaction moves collaboration tables out of the live schema so an old reader cannot reopen
  what it removed. It does NOT advance the source schema: extraction copies the collaboration tables' exact current
  columns, so the source floor IS this build's current schema, a source at it enters and leaves unchanged, and an
  older one is refused with the `store upgrade` recovery instead of being silently brought forward inside the fence.
  A rollback or commit whose outcome is unprovable reports `collaboration.cutover-unconfirmed`; it never claims the
  source is unchanged or retries blindly.
- **A shipped lane generation is immutable; a new one appends.** Each collaboration generation body is recorded in the
  lane with its compiled checksum, and a mismatch refuses `store.corrupt` rather than re-running the body. So a new
  generation is appended and the ladder proves the predecessor's shape before applying it — and a replacement of a
  derived cache carries the settled ledgers forward (confined outbox rows with their receipts, and the cross-authority
  move rows) instead of re-deriving them, with its own final comparison aborting the swap when the carried ledger
  differs.
- **A derived cache is replaced only when it holds nothing unsettled.** A pre-current cache whose outbox still holds an
  `enqueued`, `unconfirmed` or `conflict` intent refuses `remote.effect-pending` and is left untouched: replacing those
  bytes would leave the only copy of an effect that may already have landed at the provider. The recovery is to settle
  the listed states through the one write lane that still admits a below-current cache, each by the verb its own state
  names, and to rerun the same bind; only a row whose recorded state contradicts its recorded evidence, or a damaged
  repair link, takes the retained-predecessor rebuild.
- **Cross-domain effects use intents and receipts, not one transaction.** Reserve the execution facts and frozen
  payload first, commit the collaboration effect with one durable receipt, then finalize/release execution. Replay
  reads receipts before CAS. A failed acknowledgement or decline settlement is an explicit `operation-partial` with
  the original cause and a same-identity recovery; it is never a clean terminal result. Keep operation-id namespaces
  and revision/CAS lanes separate; a shared `store_meta.revision` is not a cross-domain token.
- **Backups are verified pairs.** Publish an execution image and a collaboration image with a manifest only after
  each image is re-verified against its own bytes and the causal boundary is quiescent (no prepared intent, no
  unacknowledged effect, no lane mutation during copy). Attempt-owned create-only credentials and private images
  prevent a failed attempt from deleting or adopting a winner's files; resume reuses a verified private image and
  never re-copies an unpublished side from the live authority. A missing original refuses rather than inventing a
  pair.
- **Restore is scoped and create-only.** Restore only into an absent target, verify the runtime's exact schema,
  migration inventory and lineage before staging, run the target checkout/canonical private-path guard first, and
  publish with a fresh authority identity/epoch. A post-publication binding/sync failure returns a named partial
  with the published authority and a resumable instruction. The same request repairs it without issuing a second
  generation.
- **Replacement clones adopt explicitly.** A checkout with no binding does not silently adopt an active lane. The
  supported `store collaboration adopt` verb verifies canonical repository/mode, lane metadata, an ordinary-init
  creation receipt, reviewed-cutover activation or restore lineage, and the exact live store/epoch; only a unique
  match writes the active binding. Missing, mismatched, ambiguous or foreign lineage refuses. Ordinary reads and
  writes remain `collaboration.stale-binding` until adoption; a claim file is never a binding and never promotes
  without a recorded publication.
- **Read from the source that owns the fact.** Execute and collaboration reads use separate source-local snapshots
  and keyed composition; required sources refuse, optional sources disclose absence, and neither null revision nor
  stale projection becomes zero or success. Timestamp each source at its own snapshot, not before either open.

## Consumer and host integrity

- **Expose the source that produced the data.** A successful domain read attaches its collaboration observation;
  a refusal carries the same causes, scope and supported recovery in `details`, never a fake empty object or a
  second probe. Execution-only status must not read collaboration.
- **Dashboard/HTTP:** a missing required source is a typed service-unavailable response, not 404 or zero. An
  optional catalog gap keeps usable execution data but renders a warning, never healthy collaboration. Error bodies
  scrub credentials case-insensitively, including unlabelled and mixed-case Bearer/Basic/Token/Digest values.
  Multi-page assembly compares source identity/epoch/revision plus projection freshness, excluding page offset;
  it restarts/refuses on an incompatible observation and reports the assembled bounds honestly.
- **Findings and aggregates:** a completion gate re-reads a complete plan-scoped observation, rejects incomplete or
  stale evidence, and keeps policy thresholds unchanged. An open-issue rollup is one source-local aggregate with
  distinct repository vs project scope proofs; the preview is a bounded row set, not the count source. A milestone
  with a complete zero-issue observation may deliver; an unavailable/staged observation must refuse, not treat zero
  as success.
- **Host authority is an independent probe.** Missing, staged or unreadable collaboration never authorizes a legacy
  register write and never makes a path check depend on a business read. The probe distinguishes a genuinely absent
  store from a rejected storage path (symlink/permission/canonical-private failure) and gives the correct recovery.
  dsh and the host gates consume the same probe; dsh aggregate facts disclose completeness and `asOf`, not
  projection health as authority.
- **Explicit mode is part of the install.** A repository's own `.mstarc` must declare `[collaboration] mode=...`;
  without it the repository's store verbs refuse `collaboration.mode-required`. Test fixtures must isolate
  `homedir`/HOME and restore spies before deleting their temp roots; never write test lanes under a real user HOME.

## Why This Matters

The failure modes are silent: a second writable copy, a stale sandbox writing after cutover, a physical alias
that bypasses a basename-only host gate, a schema upgrade reported as corruption, a refused write that changes
journal state, or a callback that commits before the wrapper decides. Each looks healthy on the happy path.
The rules above make the authority boundary observable and fail-closed instead of relying on an implicit
single-file assumption.

## When to Apply

Any change to the collaboration store, identity resolver, host write classifier, collaboration command family,
or a consumer that reads issues/projects/milestones/roadmaps/catalog/mirror state. Use the rules when planning a
cutover from the combined store or adding a new domain to the collaboration side.

## Examples

```ini
# .mstarc
[collaboration]
mode = local
# Required only when the checkout has no usable origin:
# repo_id = example-repository
```

```ts
const location = resolveCollaborationLocation({ harnessDir });
// { repoKey: "github.com/acme/repo", mode: "local", dbPath: ".../collaboration.db" }
```

## Related

- `architecture-patterns/store-authority-staged-lifecycle.md` — apply, activate and retire are separate acts;
  this document adds the repository-scoped split and the host-gate/publication rules that follow from it.
- `testing-patterns/store-bytes-are-not-a-write-proof.md` — do not assert a refusal by hashing a live WAL
  store; use the store's own state and receipts.
