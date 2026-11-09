# ADR: Ordinary intent is resolved through generic recovery, not per-issue workarounds

Status: implemented — derivable inputs are resolved, refusals name the real blocker, and no-op success is an outcome.

Date: 2026-09-28

Scope: engine and command entry points that accept lifecycle intent, their refusal shapes, and the provenance boundary for planning-document edits.

## Problem

Ordinary intents repeatedly dead-ended on selectors, revisions and CAS ceremony that were mechanically derivable, while the refusal named an internal cause rather than the fact the operator could act on. Each instance invited a per-issue exception or a new gate layer, which added another deadlock instead of removing the class. Missing authoring input was sometimes classified as an internal error. Provenance questions — which seat edited which document, with which model — either had no record or pressured tracked artifacts into carrying local process facts.

## Decision

Recovery is a generic resolution step over existing authorities, not a new subsystem.

- A small engine-owned `IntentContext` carries `cwd`, an optional trusted `controlRoot`, an optional identity and request id. It is not a coordinator credential and is never forwarded into a leaf.
- Existing public operation names stay. Redundant selectors, revisions, session projections and copied metadata may be omitted; the transaction-local resolved inputs stay strict. Every direct operation enters the same resolution path.
- Resolution order is explicit selection plus trusted invocation association, then authoritative records and referenced declarations. The sole or most-recent workflow is never selected without an association. DB versus supported pre-activation file behavior is chosen by the current authority, never by a failed read falling back.
- `RecoveryDetails` is a sidecar on existing results and errors: outcome (`applied`, `already-satisfied`, `partial`, `unresolved`), target, applied components, unresolved problems, resolution sources, warnings and commit state. `CommandEnvelope` remains the only transport envelope.
- A refusal names the smallest unresolved fact or decision, the competing facts, the withheld effect and the remaining available work — after discovery and recovery were attempted.
- A no-op or already-satisfied intent returns success. A partial compound result reports applied and unresolved components separately.
- No persistent recovery graph, registry, journal, scheduler or new store is introduced. A read may compute a derived view without writing; the first relevant normal mutation persists the repair.
- Compound amendments partition only at real dependency edges: connected path, ownership or policy changes commit together; independently requested components may land despite another component's conflict. One revision advance per committed connected action.
- Missing domain input is validation, never `internal-error`. Undecodable transport syntax is a usage failure; storage or capability failure is an error with the actual cause and known commit state.
- Contention is bounded to at most two internal fresh-state retries, then a scoped retryable conflict — never a busy loop.
- Provenance is split: actual attribution (seat, observed model or `unknown`, timestamp, iteration) lives in gitignored control-root records; tracked code and docs use synthetic examples and never disclose local plan or iteration identifiers, local SHAs or acceptance labels. A child's model is never inferred.
- A new optional machine check must itself be clearable and actionable; a gate with no paired recovery is not added.

## Alternatives considered

- **Patch each reported issue.** Rejected: the class returns with the next input combination and leaves a growing set of special cases.
- **A new recovery DSL, broker or state store.** Rejected: existing authorities, transactions and journals already hold the facts; a second authority would need reconciliation.
- **Stricter gates with better prose.** Rejected: prose does not remove a dead end, and another gate adds a second blocker.
- **A force flag or an auto-repair that guesses.** Rejected: it trades a visible refusal for an unrecoverable wrong write.
- **Recording actual provenance in tracked docs.** Rejected: it leaks local process facts and contradicts the repository's synthetic-only boundary.
- **Inferring a child model when unobserved.** Rejected: an inferred value would create a false authority; `unknown` is the honest value.

## Consequences

- Most ordinary calls no longer need copied revisions or ceremony, but a supplied comparison token still constrains its semantic read set.
- Whole-document replacement still requires an observed comparison basis; it never silently becomes a field merge.
- Refusal tests must assert the actionable cause and recovery, not merely a non-zero exit.
- Same-effect intents can recognize current success; event-like operations still need stable request or occurrence identity.
- Identity channels remain host-specific and are recorded separately in `2026-10-19-dsh-native-identity-channels.md`; absence of a native per-call channel is not itself a new gate.
