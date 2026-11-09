# ADR: Issue push to Linear is one-way, marker-identified, and never guesses

Status: implemented — push writes are explicit, identity comes from an application-owned marker, and an unconfirmed result stays ambiguous.

Date: 2026-11-03

Scope: the local-to-Linear push path in `packages/engine/src/issue-sync`, its ledger states, label ownership and the write adapter.

## Problem

A push must create remote issues without ever creating a duplicate, and a transport failure makes the outcome unknown: the write may have landed. Adopting a remote issue by matching title and description is not identity — the matching issue can belong to someone else. Replacing the full label set would delete human-added labels. Collapsing "this host cannot write" and "this item cannot be mapped" into one refusal leaves the operator with no actionable cause. A test fixture for the remote response is not an observation of every host's response.

## Decision

- Push is one-way and explicit. A local issue becomes a Linear issue; field and disposition changes follow. Nothing is written back from Linear. Push never deletes a remote issue, never creates a label or workflow state, and never runs as a side effect of a local write. Deletion and bidirectional merge stay out of scope because they need conflict and irreversibility semantics this contract does not provide.
- Writes require an issue-write scope on the stored credential. A read-only grant never authorizes a write, a refresh never widens a grant, and insufficient scope refuses before any store or provider call with a recovery that names a surface which requests the write scope.
- Identity is an application-owned correlation marker carrying the binding workspace/team and the local issue id — no paths, no secrets. A unique title/description match is never adoption evidence.
- An ambiguous create writes no ledger row and keeps the external id null. A later run sees unresolved residue, never a second create. A run with no pending residue issues zero listing calls.
- Recovery from an ambiguous create has exactly two supported outcomes: reconcile against the remote listing, adopting only on exact marker equality and only when exactly one candidate matches; or an explicit operator adoption of a named remote issue for a given local id, through the ordinary apply operation, composing only legal ledger transitions. Zero or several matches stay unresolved.
- The request hash is the skip rule, and it applies only to an applied item with an equal hash. An ambiguous update disables hash-based skipping until a corrective update is confirmed; otherwise a later pass could report `skipped` while the remote holds unconfirmed content.
- After an unconfirmed label change, ownership is the candidate set `{previous, attempted}`. Removing an absent label is idempotent, so a corrective update removes every recorded candidate except the desired one. A confirmed apply narrows ownership to the single label actually written. A full-replace `labels` argument is never used.
- A kind maps to a label name that must already exist. Resolution uses the real label list; an absent label is a named refusal, never a creation. The same rule applies to workflow states.
- The response envelope is parsed strictly. An unmappable write response is `ambiguous`, never success; an unmappable listing response refuses the run before any write. A host that differs from the fixture produces ambiguity, not a guessed field.
- Refusals distinguish three moments: before a write (unsupported verb, absent label/state, insufficient scope), during a write (transport or ambiguous), and after one (recoverable ledger state). Collapsing two of them into one code is a defect.

## Alternatives considered

- **Adopt by title and description equality.** Rejected: prose equality is not ownership, and the matching issue can belong to someone else.
- **Bidirectional sync or deletion.** Rejected: both need conflict and irreversibility semantics the ledger does not provide.
- **Full-label replacement.** Rejected: it deletes labels a human added.
- **Create missing labels or states.** Rejected: push would become a workspace administrator and could silently encode a typo as a new label.
- **Treat an unrecognized response as success, or retry an ambiguous create automatically.** Rejected: either can duplicate the remote issue.
- **Promote a fixture into an observation.** Rejected: a fixture proves the parser, not the host's answer.

## Consequences

- Duplicate risk is bounded by marker equality; an ambiguous item may remain pending until the operator reconciles or adopts it.
- Label ownership is recorded so a corrective update removes only what the application wrote.
- The ledger needs a durable hash, an item state, a next target and an ownership set; a single recorded label cannot express "either may be present".
- Push requires provider write scope and pre-existing labels/states. The refusal names the missing fact and a supported recovery.
- The listing is a recovery tool, not a routine read; a run without ambiguous residue makes no listing call.
