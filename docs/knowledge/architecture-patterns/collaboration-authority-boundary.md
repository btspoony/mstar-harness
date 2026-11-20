---
module: collaboration store, execution store, repository identity, host write gates
date: 2026-11-21
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: 20261121-collab-identity-store
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
