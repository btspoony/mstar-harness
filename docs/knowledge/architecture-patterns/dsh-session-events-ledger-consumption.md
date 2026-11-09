---
module: dsh-session-events
date: 2026-08-15
problem_type: architecture_pattern
category: architecture-patterns
last_updated: 2026-11-09
severity: high
tags:
  - dsh
  - session-events
  - tool-workflow
  - ledger
  - watermark
  - dedupe
related_components:
  - packages/dsh/src/gates/workflow-ledger.ts
  - packages/dsh/src/gates/agent-flow.ts
  - deepseek-harness packages/core/session
  - deepseek-harness packages/workflow/tool-workflow
applies_when:
  - consuming durable dsh session events from an in-process plugin
  - building a durable ledger/projection over tool-workflow runs
  - deduplicating cold-scan vs live-firehose event streams
  - writing a plugin that needs sessions under bun test
---

## Context

W-B2 (iter-<plan-id>, plan `<plan-id>`) built the workflow ledger over durable `tool-workflow/*` session events. The seam has four non-obvious properties, each of which cost debugging or a QC finding to discover; the durable-watermark dedupe also produced one real data-loss regression (R-401) during review. Companion capability doc: `architecture-patterns/dsh-workflow-composition-gate-coverage.md` (WHAT exists); this doc captures HOW to consume it correctly.

## Guidance

1. **Session access is a named cordis service, consumed structurally.** `ctx.get('sessions')` (`SessionStore`, `packages/core/session/src/index.ts:792,797`) exposes `get(id)` / `list()`; `session.events` is an immutable deep-frozen full-log snapshot (`:559-562`). Structural views (no plugin dep) follow the agents/loader seam pattern already used in this package.

2. **The live firehose emit is CARRIER-FIRST.** `session/event` (and `session/created`) dispatch as `[{}, 'session/event', session, event]` — cordis shifts the leading carrier object into `this`, so listeners receive `(session, event)`. Emitting name-first (`emit('session/event', session, event)`) silently mis-routes; the fake-registry tests proved it. Both events use a scope-null resolver (`scoped-events.generated.ts:25/27`), so a root-context untagged listener receives ALL sessions.

3. **Cold-scan BEFORE live, always.** Constructor-seeded events never publish on the firehose (`firstLiveSeq`, `:450-472`): events present when a session object is constructed (replay/resume/restore) are only visible via the `events` snapshot. Wiring order: (a) register `session/created` listener, (b) cold-scan `sessions.list()` snapshots, (c) attach `session/event` listener; per-session envelope-seq cursor advances monotonically.

4. **`session/created` is the late-seed backfill seam.** `create()` = prepare → enter → announce; the seed is loaded in the constructor BEFORE announce, and the created listener sees the seeded snapshot (`:830-841`, `:482-484`, `:516-539`). A synchronous listener throw VETOES session publication upstream — the listener must be try/catch-contained.

5. **Durable dedupe watermark: record THEN advance, gated on success.** The cursor is NOT a plugin-owned sidecar: the native store keeps one per-workflow/session bound keyed by the verified stream incarnation, read/written through engine `readDshScanBound` / `advanceDshScanBound` (`packages/engine/src/host-state-store.ts:260,292`). `recordWorkflowEvent` owns the append+cursor critical section, so "record first" is structural rather than a caller convention. The ordering rule that QC caught (R-401): `recordWorkflowEvent` first; advance the watermark ONLY when the append succeeded (boolean return). Advance-then-record turns a transient append failure into PERMANENT row loss — the persisted cursor durably claims coverage and neither re-apply nor restart re-attempts. The failure mode is invisible until a crash-between.

6. **Bounds and validation at the consumer boundary.** Envelope seq: integer `[0, 2^31)` (upstream `seq = log.length`, 0-based); member seq: integer `[1, 2^31)` (upstream positive safe integer). Fractional or out-of-bounds → contained skip, never cursor corruption. Id-sized fields (runId/childId) SKIP when oversized (never truncate into collisions); display fields truncate with a marker; strip C0+DEL control characters (log forging). Cap lengths defeat the line-count-based ledger truncation.

7. **Registry `dsh-session` cannot construct sessions under Bun/JSC** (`hasIntrinsicConstructor` requires single-line `Function.prototype.toString.call(Object)`; JSC renders multi-line). Tests use structural fakes (plain-object sessions + envelopes; `FakeSessionsRegistry extends Service` in `packages/dsh/tests/harness.ts`) — and because the fake extends the REAL Service class, emit-shape contracts (carrier-first) proven there hold for production.

## Why This Matters

Every one of these five seam facts is silent when violated: mis-routed listeners, never-observed seeded events, permanently-lost rows, or silently-corrupted cursors all pass happy-path tests. The watermark ordering lesson generalizes to ANY durable-consumer design: a persisted coverage claim must never outrun the record it claims to cover.

## When to Apply

- Any plugin consuming `session/event` / `session/created` or reading `session.events`.
- Any cold-scan + live-stream dedupe with a persisted cursor (adapt rule 5 verbatim).
- Test design for session-dependent plugins under Bun (rule 7).

## Examples

- `packages/dsh/src/gates/workflow-ledger.ts` (consumer; `registerWorkflowLedger` wiring, `readDshScanBound`/`advanceDshScanBound` cursor, `sessionForkCutOf`, contained hooks).
- `packages/dsh/tests/agent-flow-workflow.spec.ts` (FakeSessionRegistry, EISDIR failing-append regression, re-apply dedupe, created-backfill).
- Evidence SSOT: `{HARNESS_DIR}/sdd/<plan-id>/notes/session-events-seam.md` (file:line index).
