# ADR: The host owns all Linear mirror I/O; mstar keeps only the local half

Status: implemented — no Linear request, transport, or credential lives in mstar; the agent holding the host's Linear MCP tools performs every Linear call, and mstar feeds it plans and consumes its results.

Date: 2026-11-19

Supersedes: 2026-11-03-one-way-linear-push.md

Scope: the issue-sync surface in `packages/engine/src/issue-sync`, `packages/commands/src/families/issue-sync.ts`, the `[linear]` config block, and the dsh `linear-mcp` component row.

## Problem

The Linear mirror was built on two authorization surfaces at once: discovery went through the agent-facing MCP endpoint while writes went through the REST API, both authorized by an mstar-side OAuth credential. The two surfaces carry different scope vocabularies, so a credential with write access on one still could not write on the other — write access was unreachable (#776) — and when the two halves failed, they failed with unrelated codes, so a single incident surfaced as two unrelated defects (#777). Every fix inside that shape repaired one half while leaving the split itself in place.

## Decision

The host owns all Linear I/O through its standard Linear MCP server. mstar keeps only the local half: the sync ledger, the field mapping, a git-identity correlation marker, one identity reader, and three local verbs — `pending` (plan, no network), `apply` (record the caller's results), `ingest` (associate a listing the caller fetched). No Linear request and no credential lives in mstar. Association is the marker — `repo` (the normalized `origin` remote, or the `[linear] repo=` override when the checkout has no origin), `local` (the local issue id), `author` (the pushing checkout's git author) — decoded last-match-wins, and the association key `(repo, local)` plus the author check is recorded in the ledger only.

## Alternatives considered

- **Keep the transport behind a capability flag.** Rejected: the split authorization surface stays, and #776/#777 were both caused by the split, not by the flag state.
- **Make the sync a single REST/GraphQL surface.** Rejected: it keeps a credential and a transport inside mstar, and the API-key scope it needs still differs from what the agent's own tools already hold.
- **Keep the store-id marker (`workspace/team/storeId/localId`).** Rejected: a store id is machine-local, so it blocks cross-clone association — another clone of the same repository could never prove which local row a remote issue mirrors.
- **Adopt remote issues by title/description when no marker matches.** Rejected: prose is not identity; the matching issue can belong to someone else.

## Consequences

- Association is repo+local+author identity recorded in the ledger only; ingest never creates, updates or closes a local issue, and unmarked or foreign remote issues are reported, never adopted.
- Accepted limits, each also a `shortcut:` in the code that owns it:
  - (a) marker values containing `-->` truncate and values containing `;` or `=` mis-split; the record reads as unmanaged and the recovery is `issue-sync apply --adopt`.
  - (b) `recordResults` recomputes `requestHash` from current local content, so a local edit between `pending` and `apply` records a hash the remote never received.
  - (c) `remoteHash` derives priority through severity, so a remote issue with no priority reads back as medium.
  - (d) `openedByThisRun` is time evidence (claim timestamp versus run start), not ownership proof.
  - (e) association is repo+local+author, so two same-author stores of one repo can collide and surface as drift.
- Issues pushed by the deleted code carry the old marker shape and are reported as unmanaged; the recovery is `issue-sync apply --adopt`.
