---
title: Host-owned provider I/O — keep only the local half
category: architecture-patterns
module: issue-sync
problem_type: architecture_pattern
severity: medium
date: 2026-11-19
last_updated: 2026-11-19
plan_id: <plan-id>
tags:
  - mcp
  - issue-sync
  - linear
  - correlation-marker
  - ownership-boundary
applies_when:
  - a local authority must mirror or project into an external system the agent's host can already reach through MCP tools
---

# Host-owned provider I/O — keep only the local half

## Context

The Linear mirror originally carried two authorization surfaces at once (agent-facing MCP discovery plus mstar-side
REST writes with an mstar-owned OAuth credential). The two surfaces hold different scope vocabularies, so write
access was structurally unreachable, and the two halves failed with unrelated codes, so one incident surfaced as two
defects. The durable fix (ADR [2026-11-19-host-owned-linear-io.md](../../adr/implemented/architecture/2026-11-19-host-owned-linear-io.md))
deleted the transport entirely; the pattern below is what remains, and it generalizes beyond Linear.

## Guidance

When an external system is reachable through the host's standard MCP tools, the local authority owns **only the
local half** and the host owns everything external:

- **mstar keeps**: the sync ledger, the field mapping, the git-identity correlation marker, and the verbs that hand
  payloads in and out — `pending` (build a plan, no network), `apply` (record the caller's results), `ingest`
  (associate a listing the caller fetched).
- **The host keeps**: transport, authentication, and tool discovery. No request, token, or socket lives in the local
  code; the tool list is discovered at runtime by the agent that holds the tools, so an unverified-tool-inventory
  gap cannot recur by construction.

The marker contract — correlation back to local rows is **identity, never prose**. Each pushed record carries:

- `repo` — the normalized `origin` remote, or the `[linear] repo=` override when the checkout has no origin;
- `local` — the local issue id;
- `author` — the pushing checkout's git author.

Ingest associates on `(repo, local)` plus the author check, decodes last-match-wins, records the association in
the ledger only, and never adopts an unmarked or foreign record by title or description. Store-id markers
(`workspace/team/storeId/localId`) were rejected because a store id is machine-local and blocks cross-clone
association.

The five accepted limits from the ADR, each a `shortcut:` in the code that owns it:

1. marker values containing `-->` truncate and values containing `;` or `=` mis-split; the record reads as
   unmanaged and the recovery is `issue-sync apply --adopt`;
2. `recordResults` recomputes `requestHash` from current local content, so a local edit between `pending` and
   `apply` records a hash the remote never received;
3. `remoteHash` derives priority through severity, so a remote issue with no priority reads back as medium;
4. `openedByThisRun` is time evidence (claim timestamp versus run start), not ownership proof;
5. association is repo+local+author, so two same-author stores of one repo can collide and surface as drift.

Issues pushed by the deleted transport carry the old marker shape and are reported as unmanaged; the recovery is
`issue-sync apply --adopt`.

## Why This Matters

Owning a credential for an external system means owning a second authorization surface beside the agent's own
tools, with a different scope vocabulary — reachability gaps and split-brain failure codes are structural, not
bugs. Deleting the local transport removes the surface instead of flag-gating it, and one incident stops masquerading
as two defects. Keeping the verbs payload-shaped (plan in, results out) also keeps the ledger honest: the ledger
never claims a write that the local code cannot have performed.

## When to Apply

- A local authority needs a one-way projection (push/import) into an external system, and the agent's host already
  exposes that system through its MCP tools.
- Cross-checkout correlation must survive clones, so association must rest on repository + local identity, not
  machine-local ids or prose matching.

This pattern is **NOT** right when:

- the host has no MCP tool for the system — there is no external half to delegate to;
- local write-back is required (the local store itself must be updated from the remote automatically) — `ingest`
  deliberately never creates, updates, or closes a local issue;
- a genuine bidirectional merge is needed — the pattern is projection-only; two-way merge needs one authority, and
  this shape deliberately has none on the remote side.

See also the sibling lessons in
[external-issue-system-binding.md](external-issue-system-binding.md) (connection/what-to-map layering, cursor
strictness, timestamp parsing, readiness vocabulary, gate visibility of foreign rows).
