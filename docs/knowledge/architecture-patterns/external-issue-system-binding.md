---
module: issue mirroring (store + MCP binding)
date: 2026-11-01
last_updated: 2026-11-19
problem_type: architecture_pattern
category: architecture-patterns
severity: high


# Binding a local store to an external issue system over MCP

Lessons from the first iteration that gave a repo a supported path to mirror its issue store into Linear over the
hosted Linear MCP server. Reusable whenever a local authority grows a projection into a system it does not own.

## Split the binding in two layers

A repository-level config file (`<repo-root>/.mstarc` in this repo) answers **how to connect** — its `[linear]` block is exactly five fields (`enabled`, `mode`, `workspace`, `team`, `repo`; `packages/engine/src/mstarc.ts`); `repo` is the marker identity override used when the checkout has no origin remote; the store's own
project row answers **what maps to what**. Putting the remote project name in the repo file freezes the binding at
"one repo, one remote project" — a store project is the natural owner of "which remote project do I mirror", and one
repo legitimately has several.

Corollary: the connection layer stays flat (five keys), which removes the pressure to change the config format. A
nested format migration is a worse risk than the nesting it enables when a parse failure does not raise but
silently falls back to a default path.

## The config file is not the identity authority

A config reader that walks **up** from the working directory will happily adopt a parent directory's configuration.
In a worktree layout that parent is another repo. The reader for connection identity must resolve to
`<repo-root>/.mstarc` and never walk; "absent" is a named answer, not an invitation to inherit (pinned by `dashboard-view.test.ts` "a parent directory's .mstarc is never inherited").

## One transaction per ledger verb, and say so

The ledger row and its operation receipt must commit together, or a crash between them turns an interruption into
a one-way door: the row is advanced, the retry is refused `illegal-transition`, and the ledger that exists to make
resumption safe is what blocks it. Each public verb owns exactly one `begin immediate … commit`; a caller needing a
wider unit calls verbs in sequence and relies on per-verb receipts.

Record the rule in the durable decision record, not only in the module header — the next consumer builds against the
contract (`docs/adr/implemented/architecture/2026-11-19-host-owned-linear-io.md` is the current owner).

## A cursor that advances past a failure strands it forever

"Cursor plus overlap window" has to mean something concrete: a run may advance its cursor only when the page it
processed left nothing stranded. If it advances anyway, the `failed → pending` retry branch is dead code for every
stranded item, and no supported verb moves the cursor backwards.

Two shapes that keep strictness without sealing the door:

- an item that cannot be mapped **at all** fails by identity and lets the rest of its page proceed (never silently
  skipped, never the whole page lost);
- the run stops before advancing the cursor, so the next run re-reads that page — the overlap window in one line.

The remaining cost is real and should be named: a permanently unmappable remote item caps the run at its page until
someone repairs it in the remote UI. That is a slow path only while the remote object is repairable.

## Compare timestamps as instants, never as strings

`"…T00:00:00.500Z"` sorts **below** `"…T00:00:00Z"` because `.` precedes `Z`. A string comparison of ISO-8601 with
mixed precision silently classifies a newer revision as older, so a change is never re-imported and the mirror goes
quietly stale. Parse both sides, refuse an unparseable value by name, and gate every freshness decision on the
parsed instant.

## Two layers for "the capability is not there"

A separate readiness vocabulary keeps the diagnosis honest, and the split has to survive contact with recovery
text: a configured-but-unreachable service, a host with no service entry, and a rejected credential are three
different situations with three different fixes. Collapsing them into one "disabled" code sends the operator to
edit a config file that is already correct.

A probe also needs a deadline **and** an error boundary: the deadline bounds a hang, but a transport that throws
escapes a four-state vocabulary unless the boundary maps a throw into it too. Both belong to the deps contract, and
both need a fixture that can actually fail — a credential fixture that cannot contain a credential proves nothing.

## Projections must stay invisible to local-only gates

An imported row carries a foreign `provider`; every gate that means "local work only" must say so explicitly rather
than assume the store holds nothing else. The test that shows this is a positive control: flip the same row's
provider to `local` and watch the gate fire.

## The host owns the external I/O; the local authority keeps only its half

The credential lesson generalizes: an application that stores its own OAuth credential for an external system ends
up owning a second authorization surface beside the agent's own tools, and the two carry different scope
vocabularies. The standing model is the opposite — the host's standard MCP server performs every external call with
credentials the host already manages, and the local authority only feeds plans and consumes results
(`docs/adr/implemented/architecture/2026-11-19-host-owned-linear-io.md`). No transport, token, or socket lives in
the local code, so the unverified-tool-inventory gap of the first write iteration cannot recur: the tool list is
discovered at runtime by the agent that holds the tools.

Correlation back to the local rows is identity, not prose: each pushed record carries a marker with the repository
identity (`repo`, the normalized `origin` remote or the `[linear] repo=` override), the local issue id, and the
pushing checkout's git author. Ingest associates on `(repo, local)` plus the author check, records the association
in the ledger only, and never adopts an unmarked or foreign record by title or description.
