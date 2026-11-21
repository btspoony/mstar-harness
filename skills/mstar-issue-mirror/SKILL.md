---
name: mstar-issue-mirror
description: "Use when asked to mirror this repository's local issues to Linear, or to pull Linear issue state back and associate it with local issues. Owns the mstar issue-sync pending/apply/ingest loop; every Linear call is made by the host's Linear MCP tools, never by mstar."
---

# Issue Mirror (Linear)

## Load Order

Read **`mstar-harness-core`** first (lifecycle/authorization authority), then this skill when the task is mirroring local issues to Linear or associating Linear issues back with them. Precondition: the host exposes Linear MCP tools (`mcp__linear__*`, discovered at runtime from your own tool list — never hardcode tool names or arguments; the upstream tool list is not versioned). No Linear tools → follow Decision Rules on host set-up.

## Workflow

1. `mstar issue-sync pending --project <id>` — plans the run with no network (a `local`-mode collaboration store refuses it `collaboration.mode-unavailable`; switching mode is a reviewed authority change, not an `.mstarc` edit on a bound checkout): each item carries `localId`, `operation`, `externalId`, the `payload`, and the `marker`; `skipped` items are unchanged (requestHash equal) and cost no tool call; `unresolved` items need reconciliation first.
2. Create/update each planned item through the host's Linear tools using its payload verbatim, keeping the `marker` as the LAST line of the description.
3. `mstar issue-sync apply --project <id> --results - --run <runId>` — pass the `runId` `pending` returned, then feed one entry per item: `{localId, outcome: confirmed|refused|ambiguous, externalId?, remoteUpdatedAt?, cause?}`. `confirmed` names the remote issue; `refused` is provably undelivered (retryable); `ambiguous` was sent but unconfirmed — a create keeps its pending residue and the next ingest associates it by marker, never a second create. The report echoes your `outcome` words in `items[]`; `counts` groups the ledger states (`applied`/`unconfirmed`/`refused`).
4. `mstar issue-sync ingest --project <id> --records -` — feed a listing your Linear tools returned (`[{externalId, url, title, description, state, priority, labels, updatedAt}]`); the marker in each description decides the bucket.

## Decision Rules

- mstar makes no Linear call, holds no Linear credential, opens no socket. You are the transport; tool names and arguments come from the live tool list.
- One run per binding: `pending` holds the run lease until `apply`; a second `pending` is refused `sync.run-held` — `--take-run` replaces a holder you confirmed dead (a live holder's in-flight call cannot be recalled). `--run <runId>` proves raw results continue the run `pending` returned: results naming an earlier or foreign run refuse `sync.run-held` and record nothing (`--run` contradicts `--take-run`).
- `ingest` buckets: `associated` (ledger now knows the remote issue), `drift` (remote content no longer matches the confirmed hash, or two remote issues claim one local issue — operator judgement, nothing rewritten), `foreign` (another git author's clone of this repo), `orphan` (local issue absent here), `unmanaged` (no marker / retired marker / another repo — never adopted by title or description). No local issue is ever created, updated or closed.
- `--release <localId>` clears a pending create without a remote id — safe only after an `ingest` showed no issue carrying its marker; the ledger refuses the release only when the row is not such a pending-without-id residue, so it cannot see whether you ran `ingest`; `--adopt <localId>=<issueUrl|externalId>` records an identity the operator confirmed; `--force-adopt <localId>` replaces an established one.
- No Linear tools → DSH: supply `MSTAR_LINEAR_TOKEN` through the credentials document (or the env fallback), then enable the `linear-mcp` row; other hosts: configure their Linear MCP server. Details → References.
- `linear.repo-unresolved` → add an `origin` remote or set `[linear] repo=` in `.mstarc`; `linear.author-unresolved` → set `git config user.name` / `user.email`.

## Evidence

A correct run ends with: every planned item either written through your Linear tools and recorded by `apply` (report outcomes match what you sent), and an `ingest` whose buckets name every remote issue in the listing; no local issue content changed by ingest; unresolved/ambiguous items left as residue with their named recovery, never duplicated by a second create.

## Non-Goals

No remote-to-local field write-back, no import of unmarked Linear issues, no remote deletion — mstar only plans, records, and associates.

## References

- Open when the host's Linear tool set must be configured or a mirror run reports no `mcp__linear__*` tools: the Linear MCP server, its auth and the DSH `linear-mcp` row → `mstar-issue-mirror` → `references/linear-mcp.md`
