# ADR: One static store upgrade replaces the staged migration protocol

Status: implemented — `store upgrade` imports recognizable legacy state and activates authority in a single operator run; the staged verbs are gone.

Date: 2026-10-04

Scope: `mstar store` upgrade and initialization, legacy execution import, and the operator-visible recovery for skipped or conflicting sources.

## Problem

The staged upgrade protocol (`preview`, `apply`, `activate`, `retire`, `abort`) made the operator assemble a manifest and pass several attestation-like gates before ordinary state could be read. Failures frequently left a partially prepared workspace with no obvious continuation, and the heavy machinery existed mainly to protect against a migration that could instead refuse safely and leave every source byte in place. The reported failure class was a dead-end refusal, not a wrong import.

## Decision

- `mstar store upgrade --operator <name>` is the default and supported upgrade path. In one run it opens or creates the store, imports recognizable stopped-workspace state, activates execution authority, and returns one receipt that lists imported and skipped items.
- Unknown or unreadable sources are retained at their original paths. The upgrade never overwrites, deletes or silently omits an existing native workflow. A refusal names the source and the acknowledgement or correction that lets the operator continue; a re-run continues the same import.
- The staged execution verbs `preview`, `apply`, `activate`, `retire` and `abort`, and the `safe-upgrade` alias, are removed. There is no staged manifest or coverage gate between recognition and activation.
- `store init` is create-only. It refuses a workspace that already contains legacy execution or catalog state and names `store upgrade` as the preserving route.
- A v1 lift produces standalone plan rows. An active standalone plan fixes its delivery kind at registration, so the upgrade requires one explicit `--delivery` declaration per such lift (branch source/target for development, completion policy for report-only). An entry that addresses no active lift is refused, not ignored. Completed v1 rows and existing v2 rows need no declaration.
- DSH sources and iterations that cannot be imported are skipped only when the operator names them with the matching acknowledgement flag; the receipt records the loss. Skipping a compass converts its plans to standalone rows and is reported as such.
- Backups, restore and live-state export remain independent utilities. They are not coupled to upgrade and are the recovery evidence for an operational cutover.
- A held retired claim still requires stop evidence in an explicit activation attestation document; that is a state precondition, not the removed staged protocol.

## Alternatives considered

- **Keep the staged protocol and improve its messages.** Rejected: the protocol itself created the half-prepared states and the multi-step ceremony; better wording would not remove them.
- **Infer and import every legacy shape automatically.** Rejected: an unreadable or ambiguous source would be guessed, and a guessed identity or delivery kind is a wrong durable fact.
- **Overwrite conflicts with the native store.** Rejected: an upgrade must never destroy state that an active authority already holds.
- **Leave every source untouched and require a manual import command.** Rejected: it moves the same work to an undocumented surface and leaves the store unusable after upgrade.
- **A force flag.** Rejected: it trades a named refusal for an unrecoverable write. The supported continuation is a named acknowledgement or a correction, never force.

## Consequences

- Upgrade is resumable by re-running the same command; a lost create-only publication race is a continuation, not a terminal error.
- The operator may need to name skipped sources explicitly. That is the honest record of what was not imported, not a silent success.
- Import is lossy only where the operator acknowledged a loss, and the receipt states it.
- Ordinary reads work only against an active store; a staged or busy authority refuses with the upgrade action.
- An operational upgrade still needs quiesced consumers and an authorised backup. Development does not authorize a live cutover, and an old binary is not a safe rollback target after the store advances.
