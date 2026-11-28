# ADR: Separate execution state from collaboration authority
Status: implemented — the execution and collaboration authorities are split, the per-repository user-level collaboration store and the local, mirror and remote authority selection are implemented, and live provider behaviour stays unverified.
Date: 2026-11-21
Scope: execution/collaboration separation, per-repository user-level storage, and local, mirror, and remote collaboration authority.

## Problem

The [control-checkout store](../../../specs/architecture/store-authority.md) ties collaboration records to the lifetime of one clone even though a project and its unresolved findings may outlive that clone. Fixing root discovery gives linked worktrees one place to find execution state; it does not preserve collaboration across replacement clones or isolated sandboxes. A one-way Linear mirror can expose issues to a team, but it cannot serve as the complete source for another sandbox. Treating a mirror or a stale cache as authority could hide unresolved findings and allow a gate to pass without evidence. Conversely, moving execution state to Linear would put coordinator ownership and leases behind a provider that does not share their transaction boundary.

## Decision

**Separate the domains.** Execution state, including sessions, workflows, plans, leases, and coordinator bindings, stays under the fixed [Git-derived control checkout](../../implemented/architecture/2026-11-20-fixed-harness-root.md), never in a user-level collaboration database or Linear. Collaboration owns issues and findings (including occurrences, transitions, relations, and provenance), projects, milestones, and portable project and binding identity. The catalog separates portable identity and relationships from local checkout paths and execution bindings; moving the former does not rebind an active plan. Specs, knowledge, and ADRs remain tracked in Git. Research is independent of the Projects hierarchy and does not determine project placement or justify a global authority database.

**Keep one user-level store per canonical repository.** Each repository has one `collaboration.db` in user-level storage, namespaced by canonical Git origin host and owner/repository. When origin cannot supply that identity, an explicit stable repository ID is required; checkout paths and Git authors are not identity. Clones and worktrees of the same repository for the same user resolve the same database; distinct repositories and forks do not. There is no global authoritative user database. Any future cross-repository index is rebuildable from the individual authorities and owns no data.

**Select exactly one collaboration authority per project.** An absent `[collaboration]` mode selects `local`, the default authority; `mirror` and `remote` are declared, and each applicable project's provider binding is explicit. The published selector still refuses a checkout that omitted its mode, so the default never stands in for a remote authority. A change of mode or binding is a reviewed authority change, not a fallback or a merge of two writable copies.

| Mode | Authority | Non-authoritative storage and delivery |
| --- | --- | --- |
| `local` | The per-repository user-level SQLite database | None. |
| `mirror` | The same local database | The existing explicit one-way push; Linear does not write collaboration state back. A local commit and a confirmed mirror delivery are separate outcomes. |
| `remote` | The bound Linear workspace and project are the complete collaboration authority | The local collaboration database holds only read cache and durable outbox/unconfirmed records, including reconciliation evidence. It is not a second source of truth. |

Before admitting a write, resolve the current mode and binding through a trusted entry independent of the old per-repository database or the sandbox's cached binding. Cutover must refuse unless old write paths are demonstrably stopped and in-flight operations are reconciled against their original binding. After cutover, reject writes using the old mode or binding rather than redirecting them to the new authority.

In `remote`, Linear must preserve or allow reconstruction of MStar extension semantics, not just title and status. A fresh sandbox must be able to recover portable identities, relationships, finding history, provenance, and milestones without the original database. Unmarked issues in the bound project are visible. Linking one to an MStar finding requires explicit adoption of the named provider issue, never a title match. A Linear issue moving to `Done` does not establish MStar finding closure or PM Acceptance.

**Keep Linear I/O in the host.** The Host Agent performs all provider operations through the official Linear MCP. The CLI and MStar engine do not own credentials, provider transport, or REST, GraphQL, or MCP client operations. The engine owns domain validation, operation intents, frozen payload snapshots, receipts, cache and outbox state, and recovery. This decision preserves the [host-owned Linear I/O decision](../../implemented/architecture/2026-11-19-host-owned-linear-io.md) — the implemented, live authority whose ledger, skip-rule and marker-equality rules carry forward the one-way mirror's recovery principles; those principles originate in the archived [2026-11-03-one-way-linear-push](../../archived/architecture/2026-11-03-one-way-linear-push.md), cited here as history only, not as authority. This decision adds remote authority without retiring the mirror or superseding the host-owned decision wholesale.

**Use explicit identity and outcomes.** A stable `IssueRef` is the collaboration-domain identity across clones and mode changes, independent of local sequence or Git author; author remains audit metadata in that domain. Provider identity identifies the specific Linear record in its binding, and `operationId` correlates one logical write and its recovery. The existing local-authoritative mirror keeps its repo + local sequence + Git author correlation and recovery marker unless a separate, effective decision explicitly supersedes that scope. `operationId` does not guarantee exactly-once provider effects, and `updatedAt` is observation evidence, not general compare-and-swap. Conflicting writes must be surfaced rather than silently resolved by last-write-wins; a mutation must refuse when it cannot protect the relevant fields from silent overwrite.

For a move between projects with different authorities, apply the same cutover rule: stop old write paths and reconcile in-flight operations before verifying the destination has the same `IssueRef` and complete history. The received data is non-authoritative staging until membership switches. If verification fails, refuse the move and preserve the source record. If interrupted before the switch, resume with only the source authoritative until cutover completes. A relation whose target cannot be resolved across authorities remains visible as unresolved, never absent.

**Make uncertainty visible at the boundary.** Every collaboration consumer, gate, and read model uses the selected collaboration boundary. Remote unavailability does not select local authority. Stale reads carry `asOf` and completeness for the requested scope; unknown or incomplete results never count as zero. A gate requiring stronger evidence must defer when it cannot obtain it. Pending or uncertain writes are not successful writes, and an enqueue may be reported only after persistence to a durable outbox. Provider-persisted data and pushed Git commits can survive loss of both the workspace and `HOME`, even if the caller lost the provider response. An unconfirmed write is not a successful handoff: require a unique, exact match by identity or operation evidence to reconcile it; without that evidence, leave it unconfirmed rather than replaying it blindly. An end-of-session flush is not a correctness mechanism. With no remote service and neither local volume surviving, durability is impossible.

Operations that span execution and collaboration use idempotent, recoverable orchestration with durable intent and separately confirmed effects. A provider call does not join a SQLite transaction. An interruption between effects must leave recoverable partial progress, not a successful composite operation; a replay must resume from recorded evidence rather than redo a confirmed effect.

This decision authorizes no cloud coordinator, distributed workflow leases, a generic queue or CRDT, a self-hosted service, or moving execution state.

## Alternatives considered

- **Local authority with a stronger bidirectional mirror.** This preserves offline writes and brings human Linear edits into local views. It still cannot make a clean sandbox authoritative without restoring the local state, or else it makes offline SQLite and Linear competing writers. Paying for merge and conflict semantics on both sides does not yield the single shared authority needed for remote handoff. Keep the one-way mirror for teams that want local authority.
- **One global user database.** This simplifies cross-repository queries, backups, and shared project views. It couples unrelated repositories' access, migrations, and recovery and still disappears with an ephemeral `HOME`. Per-repository storage trades global transactions and queries for repository-scoped ownership and recovery; a cross-repository view does not need to be authoritative.
- **MStar Cloud as authority.** An owned service could provide native rich records, idempotency, and conditional writes. It adds hosting, authentication, tenancy, and operations and would require teams already collaborating in Linear to operate a second service or mirror again. It is not needed for this authority model; if Linear cannot meet the fidelity or consistency requirements, remote mode must not be offered as complete.
- **Git-only issue storage.** Git provides portable history and reviewable changes without a second authority service. It would tie routine issue edits to commits and branch merges, expose issue content to the repository's readers, and require a separate workflow for native Linear collaboration. Keep Git as the authority for tracked documents and source instead.

## Consequences

This record is implemented; the following hold.

Each criterion below is proven by the owning scenarios that `docs/specs/architecture/collaboration-authority.md`, section "Verified acceptance", maps to it.

- **Local persistence and isolation.** The checkout is removed and a replacement clone reads the seeded records from the retained user-level store.
- **Remote sandbox handoff.** Proven against the controlled host fixture; the two sandboxes share neither workspace nor `HOME`.
- **Full round trip and adoption.** Proven against the controlled host fixture; an unmarked issue is never adopted by a title match or by provider `Done`.
- **Honest failures and recovery.** Proven against the controlled host fixture; no false success, no silent local fallback and no duplicate create on replay.
- **All read models and gates.** Unknown never counts as zero, and evidence carries its scope and time without claiming a remote lock.
- **Migration and rebinding.** Stage, resume and one-time activation are proven on a combined source.
- **Cross-authority moves and relations.** Proven on one checkout inside the controlled-host boundary (`I-001235`, PR #834).
- **Provider isolation.** The CLI and engine hold and use no provider credential, client or transport at rest or during operation.

All eight are proven within local SQLite, real local Git and the controlled host fixture only; live Linear permissions, field fidelity, the exact event round-trip, Git server protection policy and operational sender exclusion remain unverified until a separately authorized release or operational acceptance, and this record claims no provider round-trip.

### Accepted risks

- **No general Linear idempotency or CAS.** A lost create response can be indistinguishable from rejection until exact evidence is visible, and a concurrent edit may race a preflight read. Keep uncertainty visible, reconcile before retry, and refuse writes whose conflict policy cannot be enforced. This favors correctness over write availability.
- **Remote observation is not a linearizable gate.** Even a complete fresh read can change before a local execution transition. Gates that accept a remote observation must record its scope and time; a gate that requires an atomic predicate across the two domains cannot claim this guarantee and must defer.
- **Rich-field fidelity and privacy.** Provider field limits, edits, or visibility rules can lose extension meaning or expose evidence to a wider audience. Refuse remote mode for a project if it cannot preserve the required data within the authorized audience; do not silently drop content or store authoritative fields only in the cache.
- **Migration and rebind can split history.** Legacy marker collisions, changed repository identity, and writes still in flight can misattach or omit records. Keep the source recoverable until the target is verified, require explicit reconciliation of ambiguous mappings, and never replay an operation into a different binding implicitly.
- **Per-repository isolation costs cross-repository convenience.** Queries and backups must cover the relevant repository stores, and provider projects shared across repositories need explicit repository scoping. A missing or partial repository result must stay visible; no global index may resolve it by assuming zero.
