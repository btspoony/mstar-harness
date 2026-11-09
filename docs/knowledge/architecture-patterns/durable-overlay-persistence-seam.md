---
module: packages/dsh
date: 2026-10-23
problem_type: architecture_pattern
category: architecture-patterns
last_updated: 2026-10-23
severity: high
tags:
  - durable-state
  - overlay
  - tombstone
  - storage-domain
  - cordis
  - dsh
related_components:
  - packages/dsh/src/gates/execution-binding-roots.ts
  - packages/dsh/src/gates/execution-binding-roots-domain.ts
  - packages/dsh/src/index.ts
  - '@deepseek-ai/dsh-storage-domain'
applies_when:
  - a module-level Map holds state that must survive a host restart
  - a synchronous consumer must read state that an asynchronous service provides
  - designing degradation for an optional host facility
  - reviewing a clear/delete path that races a queued durable write
---

# Durable persistence behind a synchronous seam — overlay first, back-fill on install

## Context

`gates/execution-binding-roots.ts` held the control root a native `mstar_plan_bind` adopted into
`(sessionId, cwd) → harnessRoot` in a module-level `Map`. Three consumers read it synchronously
(`workflow-ledger.ts`, `workflow-selection.ts`, `native-commands.ts`), so the map could not simply
become an `await`. After a dsh restart the map was empty and the ledger attributed to the workspace
root while the durable binding lived in another control root.

The fix routes the same `(sessionId, cwd)` key through the host's `ctx.storageDomain` KV facility.
Four behaviours only became correct after real defects surfaced in review:

1. **Read order must be overlay → durable → workspace, never durable-first.** `KvTable.put`/`delete`
   mutate the table's in-memory view only *after* the backend write lands. A durable-first read
   therefore resurrects a root that was just cleared but whose queued `delete` has not landed.
2. **A clear needs a synchronous tombstone.** The in-process overlay records `null` for the cleared
   key at call time; the durable `delete` is fire-and-forget behind it. Without the tombstone the
   window between `clear()` and the delete landing answers the stale root.
3. **Installing the store must back-fill the overlay.** The domain opens asynchronously, so an
   adoption that succeeded while `open` was in flight is in the overlay only. `install…` replays every
   observed entry into the table (roots as puts, `null` tombstones as deletes, never a tombstone as a
   root). Without the replay that adoption is readable in-process and gone after restart — a silent
   durability hole that no test caught until QC asked for the pre-install case.
4. **The containment chain ends at the logger.** Every durable read/write is wrapped so it can never
   throw into the ledger path; the `catch` blocks called `console.warn` unguarded, so a throwing
   exporter re-opened the hole. Route warnings through a settable sink (`set…Logger`) and wrap the
   sink call itself in `try/catch`.

## Guidance

- **Model the state as three layers with one key function.** Overlay (Map, synchronous, authoritative
  for the current process), durable table (survives restart, asynchronous to mutate), workspace
  fallback (the pre-existing behaviour). Reuse one `keyOf(sessionId, cwd)` for all three — a second
  spelling is how a tombstone misses its own entry.
- **Keep the seam injectable and degradable by construction.** Export
  `installExecutionBindingRootStore(store): () => void`; with nothing installed every path must be the
  old in-process path. Degradation is then the default state, not a `catch` branch nobody tests.
- **Open once from a `ctx.inject(['<service>'], cb)` child in `apply`; uninstall synchronously before
  `await domain.close()`.** A consumer must never meet a closing or closed domain. Handle
  `INACTIVE_EFFECT` when the fiber is torn down mid-`open`: close the late handle once and drop the
  seam, or the next apply meets `already-open`.
- **Write tombstones only when they can change an answer** (`overlay.has(key) || durable.get(key)`)
  — otherwise a long-lived host accumulates one permanent `null` per cleared session/cwd.
- **Name the domain spec with `[a-z][a-z0-9_]*` only.** `defineDomain` validates the name at module
  load, so a dashed name throws on import rather than at `open`.
- **Prove it with a restart shape, not a live restart:** clear the in-process receipts, keep the
  durable medium, install a fresh seam, assert both consumers resolve. Add the pre-install adoption
  case, a rejected `put`, a rejected `delete`, and a delete-in-flight read.
- **Declare what stays outside the seam.** A failed durable delete leaves the record behind, so a
  restart can resurrect a cleared root; the production journal-restoration path is untouched. Both
  belong in the plan's residuals, not in a "fixed" claim.

## Why This Matters

The two facts that are not guessable are (a) the KV table's memory updates *after* durability, which
inverts the intuitive read order, and (b) the install-time replay requirement, which only appears when
an async `open` overlaps a synchronous writer. Both are silent in the happy path and only bite after a
restart — the one moment nobody is watching in a test suite that models the restart in-process.

## When to Apply

- A module-level map/module-scoped cache must survive a process restart.
- A synchronous gate/consumer reads state owned by an asynchronous service.
- Any "clear/delete + cache" pair where the cache is consulted before the delete lands.
- Reviewing degradation for an optional host facility: ask whether absence is the default code path or
  a caught error.

## Examples

- Read seam: `executionBindingRootOf(sessionId, cwd)` → overlay → durable get (contained) → workspace
  resolver in the caller.
- Install: `ctx.inject(['storageDomain'], (storageCtx) => { void storageCtx.storageDomain.open(spec)
  .then((domain) => { const store = executionBindingRootStoreOf(domain); storageCtx.effect(() =>
  () => { uninstall(); void postTeardown(domain) }); install(store) }) })`.
- Regression: bind while `open` is gated by `Promise.withResolvers`, settle, then `restartSeam()` and
  assert the adopted root still resolves.

## What Didn't Work

- **Reading durable-first** "for correctness" — resurrects cleared roots until the queued delete lands.
- **Making an adoption durable only from `record()`** — anything adopted before the store installed is
  lost; install-time replay is the missing half.
- **Guarding the store calls but not the logger** — containment broke in the one branch that exists to
  report failures.
- **A 10 ms `setTimeout` barrier in the new tests** — violates the repository's no-wall-clock rule and
  hides ordering defects under load; replaced by a fixture-owned `Promise.withResolvers` gate plus the
  product's own install point as the observable signal.

Related: `cordis-inject-child-effect-ownership.md` (who owns an inject child's effects, HMR re-apply),
`testing-patterns/verification-redundancy-and-unholdable-gates.md` (no retry-as-fix, no
environment-derived pins).
