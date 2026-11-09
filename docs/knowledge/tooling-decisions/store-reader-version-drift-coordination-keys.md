---
module: store authority, engine schema, concurrent sessions
date: 2026-10-06
last_updated: 2026-11-09
problem_type: tooling_decision
category: tooling-decisions
severity: medium
applies_when:
  - status validate refuses store.corrupt on an unexpected coordination key
  - Two sessions drive the same control-root store from different engine builds
tags:
  - store-authority
  - version-drift
  - coordination-json
  - schema
related_components:
  - mstar-use-cli
  - mstar-artifacts
---

# An older build calls the shared store corrupt after a newer build writes new coordination keys

## Context

Two sessions shared one control-root store (`{HARNESS_DIR}/store.db`) while running **different
engine builds**. One build (from a feature branch) wrote a new coordination audit key
(`binding_releases`, introduced by the since-retired "ACTIVE release-binding for undriveable plan
bindings"; both the key and the `plan release-binding` verb are gone) into
`execution_plans(...).coordination_json`. Every older build — the main-checkout dist, the installed
plugin — then refused **every** store operation:

```text
store.corrupt: execution_plans(<wf>,<plan>).coordination_json does not validate
(coordination.row.progress-field: ... has unexpected key(s): <new-key>)
```

The class is live regardless of that one key: `validatePlanProgress` /
`validatePreparedCoordination` / `validateBinding` reject any member their build does not know
(`packages/engine/src/coordination-write.ts:350/369/388/417`) and
`execution-store.ts:851` turns the violation into `store.corrupt`.

`state: unreadable`. Because every lifecycle verb needs a `status validate` token, the failure
cascades: bind/progress/handoff/accept/integration/complete and catalog/completeness probes all stop,
in **both** sessions.

## Guidance

- Treat it as a **schema mismatch, not data corruption**: the row validates against the writer's
  schema. Establish which build understands it before concluding anything about the data.
- Diagnose read-only: `git log --all -S '<key>'` finds the commit/branch that introduces the field;
  a plain `sqlite3` read of the row shows the key. Branch evidence proves **what schema** wrote it,
  never **which process** wrote it — say "writer unidentified" unless you have a receipt.
- Interim unblock: run the affected reader with the **matching build** (the worktree that contains
  the commit, e.g. `<worktree>/packages/cli/dist/mstar-harness.js`) after a read-only
  `status validate` proves it can read the store. Keep writes to public verbs only.
- Root fix: land the introducing change on the default branch and rebuild every reader's dist (main
  checkout + installed plugin). Until then, old builds keep reporting `store.corrupt`.
- Do **not** hand-edit `coordination_json`, "repair" the row, or force-add ignored state: the
  authority is written through domain verbs, and an unreadable live store cannot be recovered by
  online restore-preview.

## Why This Matters

The store is the shared process SSOT for concurrent sessions. Schema drift between readers turns a
healthy store into an unreadable one for everyone, and the failure text ("corrupt") points at the
data rather than at the reader — which invites destructive "repairs" of intact state.

## When to Apply

- `status validate` returns `store.corrupt` naming an unexpected key in a coordination/execution row.
- More than one session or build may be writing the same control-root store.
