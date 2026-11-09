---
module: @mstar-harness/dsh
date: 2026-08-10
last_updated: 2026-11-09
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: "<plan-id>, <plan-id>, <plan-id>"
tags:
  - "agent-flow"
  - "ledger"
  - "catalog"
  - "dispatch-gate"
  - "subagent"
  - "jsonl"
  - "subagent-link"
  - "child-identity"
---

# Agent-flow ledger: actual subagent dispatch evidence in the context catalog

## Context

The `mstar-engine-status` catalog row carried only *result* state (plan statuses, iteration gate, residuals, leases, branches, knowledge, direction) — nothing about the **actual subagent flow** (who was dispatched, when, for which plan/task, with what verdict/outcome). The panel's main graph therefore could not truthfully reflect "expected vs actual" workflow: expected stages existed as client-side schema constants, but actual dispatches had no evidence source. The user-facing requirement: the panel's main graph must reflect the real workflow state — expected and actual subagent flow during iteration/workflow.

A second consumer question arrived with the dsh GUI: **which subagent is this row?** The GUI's subagent list keys every row by the **child session id**, while the role (`Execute as`) is only knowable on the mstar dispatch side. The ledger therefore has to carry child-session identity, not just dispatch/settle counts.

> **Superseded storage (2026-10-13):** plan `<plan-id>` moved this ledger out of `agent-flow.jsonl` entirely. Dispatch/settle/link rows, accepted workflow-event identities and scan bounds now live in the native store (`appendDshLedgerRow` / `appendDshWorkflowEvent` / `readDshScanBound` in the engine host-state domain); the JSONL tail/index/archive/compaction file protocol and its per-workflow lockdir are deleted, and legacy files are retained read-only as import sources. The guidance below is the historical design; keep its identity/attribution invariants, not the file mechanics.

## Guidance

**The file mechanics quoted below are HISTORICAL** (the superseded-storage note above): there is no
`agent-flow.jsonl` writer, no line ceiling, and no `.ledger-write.lockdir` in the current code. What still
constrains a future implementation is the identity/attribution and record-point discipline; the storage
surface is `appendDshLedgerRow` / `appendDshWorkflowEvent` / `readDshLedgerWindow` /
`readDshScanBound` in `packages/engine/src/host-state-store.ts`, called from
`packages/dsh/src/gates/agent-flow.ts`.

**Ledger file (historical) — the ACTIVE workflow dir**: `{HARNESS_DIR}/workflows/<id>/agent-flow.jsonl` (JSON Lines, one event per line; the harness dir is gitignored by convention). The writer resolves the active lifecycle (`resolveActiveWorkflow`; active membership means non-terminal — `running` **and** `paused`) and appends only there: **never** the harness root and **never** a terminal snapshot dir. With NO active lifecycle the record is SKIPPED with ONE warn per apply (same once-per-binding discipline as the settle trace) — never a silent root v1 write.

**Event schema v1** — the row kinds: `dispatch`, `settle`, `subagent-link`, plus the four workflow/ralph kinds (`workflow-verdict`, `workflow-run`, `workflow-agent`, `workflow-run-end`):

- dispatch: `{ v:1, ts, kind:'dispatch', agent?, role, planId?, taskId?, taskCategory?, verdict:'ok'|'advisory'|'denied', hard }`
- settle: `{ v:1, ts, kind:'settle', agent?, outcome:'ok'|'error'|'denied', durationMs?, role?, planId?, taskId?, childId?, taskRef? }`
- subagent-link: `{ v:1, ts, kind:'subagent-link', agent?, childId, label, role, planId?, taskId?, taskRef? }`

Field semantics that must not be conflated:
- `taskId` is ALWAYS the Assignment body `Task N` tag (`taskIdOf`), never a registry id.
- `taskRef` is ALWAYS the jobs-registry id (`<kind>-N`, e.g. `subagent-1`) — carried by a background settle and by a link whose dispatch started a background job; a continuable link omits it.
- `childId` is the **child session id**: required on a link (a missing/empty/oversized value skips the whole row), optional on a settle (`optionalLedgerId`: an invalid value omits only the FIELD, so the real completion still records). IDs are never truncated or re-keyed — a capped id would be a different id.
- `role`/`planId`/`taskId` on a settle are the PAIRED dispatch's identity (same field names + semantics as the dispatch event; their presence is what the client's `paired` flag reads — a legacy unpaired settle omits them and stays unpaired, no owner+time guessing).
- Optional fields are OMITTED rather than emitted as `undefined` (the ledger's own read narrow treats a missing field and a malformed one identically).

**Single record point**: DshHostAdapter.dispatchGate — the shared core used by BOTH the tools/pre-execute listener and the host `beforeDispatch` hook, so no dispatch path can bypass recording (including hard-mode denies). Record unconditionally; never block the dispatch (catch + log under mstar/agent-flow). Derive `verdict` from the gate result (violations + hard flag); parse `planId`/`taskId` from the Assignment header region (shared grammar with the dispatch gate — `planIdOf`/`sessionIdOf`/`isAssignmentShaped` reused, never duplicated). Known accepted tradeoff: one logical dispatch crossing BOTH surfaces records two dispatch rows — the surfaces are mutually exclusive by design, documented, never deduplicated.

**Role normalization happens ONCE, at the write boundary**: `normalizeRoleId(value)` = `trim()`, then strip ONE leading `@`. So `@explore` and `explore` write the same `role`; case is preserved (role ids are host-defined strings and folding could merge ids a host keeps distinct), interior whitespace is untouched, and a missing `Execute as` stays `''`. The normalization is applied to the dispatch row and its pairing ref, and again at the direct `recordSettle` / `recordSubagentLink` entry points (callers may hand in a raw Assignment value), so all three row kinds are same-shaped for one `Execute as`. Rows already on disk are never rewritten or renormalized.

**Bounded (historical)**: after every append the file truncated to the most recent `AGENT_FLOW_MAX_EVENTS` (500) lines behind a per-workflow `.ledger-write.lockdir`. Both the line ceiling and the lockdir are deleted: dispatch/settle/link rows are now rows in the native store (`appendDshLedgerRow`, insert-only), so bounding is the store's concern and no dsh writer takes a file lock. The retained rule is the read bound: `readAgentFlow` asks the store for a window (`AGENT_FLOW_DEFAULT_LIMIT = 50`, latest first), malformed lines are skipped, and `undefined` is never cached.

**Read path (historical, file era)**: `AGENT_FLOW_TAIL_READ_THRESHOLD_BYTES = 64 * 1024` gated a latest-first tail window over the JSONL leaf. The current reader is `readDshLedgerWindow` (`packages/engine/src/host-state-store.ts`) over the store; the surviving rule is the single parse funnel and skip-malformed tolerance, not the byte gate.

**Settle = real completion pairing, never faked**: `tools/post-execute` IS part of the verified dsh-tools registry surface (`runPostExecute` dispatches the waterfall for every tool call — verified against upstream source + pinned by a real-call probe). The listener matches dispatch TOOLS (Config `dispatchTools`, default `['subagent', 'subagent_fork']`), looks up the exec's **agent-namespaced** call key (`${sessionId}\u0000${callId}` — a raw `callId` is not globally unique across concurrent sessions, so a bare key would let one session's settle land on another's dispatch ref), and branches on the verified result shapes:

- `{ kind:'background', jobId }` (the registry job id, `<kind>-N` — NOT a child session id) → store `jobId → dispatchRef` and the bounded job id as the ref's `taskRef`; the REAL settle arrives later via `ctx.inject(['jobs'])` → `jobs.onJobDone` (terminal mapping `completed`→`ok`, `killed`→`denied`, `failed`→`error`, `durationMs = finishedAt − startedAt` when available; a non-terminal snapshot records nothing and KEEPS the pairing). A background value without a valid `jobId` → nothing mappable: no settle, no identity.
- `{ kind:'continuable', subagentId }` → no terminal signal this round → no settle (documented limit — the child owns its turns); the value authorizes only the child-identity join below, for exactly the returned `subagentId`. Nothing is copied onto a settle.
- any other successful value (foreground included) → settle `ok`; a failed result (`isError` OR an `error` payload — fabrication guard) → settle `error`, and the identity candidate is retired. A returned foreground `runId` becomes the settle's `childId`, extracted INDEPENDENTLY of the outcome branch: a failed call whose value still carries a `runId` keeps that identity on its `error` settle without turning it into `ok`.

Pairing is apply-scoped: the `callId → dispatchRef` / `jobId → dispatchRef` maps live in the entry `apply`, so an HMR restart resets them and completions outside the window stay unpaired. Each `callId` pairs exactly once (the entry is deleted when the post-execute branch resolves it) and each consumed job entry is pruned — the maps hold only in-flight calls. Unpaired payloads (non-dispatch tools, calls outside the window) record NOTHING — the ledger stays dispatch-only, never a fabricated settle.

**Child identity (`subagent-link`, nonterminal)** — the call-window join. The child session id is published upstream as a PARENT-OWNED `subagent/catalog` session event (`{ version: 0, childId, childCreatedAt, mode, label }`; `label` = the delegation `description`), appended by the tool body — for the continuable path **necessarily BEFORE the tool returns**, hence before `tools/post-execute`. A post-only pending map plus a live-only listener would therefore miss that class entirely, so the join spans a per-dispatch CALL WINDOW:

1. **Reserve** — in the same pre-execute that recorded the dispatch, capture `exec.agent.session` + its current `seq` as the window start (`fromSeq`) and the RAW `exec.arguments.description` as the slot key, and reserve the FIRST slot for that label under the exact parent Session OBJECT (`catalogBySession: WeakMap<object, Map<string, AgentFlowCatalogJoin | null>>` — session-incarnation safe, no delimiter ambiguity). The candidate is reserved INERT: no catalog can match it until the result authorizes it. Admission is all-or-nothing (a missing/malformed Session, a missing/empty/sanitizing-to-nothing/oversized label, an already-owned label, or a Session at 500 slots admits no candidate and never affects the dispatch or its settle).
2. **Eligibility** — at successful post-execute: a valid `background` result (job stored, `taskRef` set) marks the candidate expecting a `one-shot` catalog; a valid `continuable` result marks it expecting a `continuable` catalog naming the exact returned `subagentId`. Every other outcome — other success / foreground, tool error, absent or malformed result, invalid background `jobId` — retires the candidate to its tombstone and releases its ref. A duplicate label is owned by the FIRST reserved dispatch and can never mark another one eligible.
3. **Catch-up** — immediately at eligibility, walk `eventAt(seq)` over `[fromSeq, session.seq)` in sequence order (no whole-log copy) through the SAME matcher, stopping at the first match. This is what recovers the catalog the continuable path necessarily appended before the tool returned. An unreadable position is skipped (the walk continues) with at most ONE warn carrying the skip count.
4. **Live** — ONE root-context `session/event` observer (`registerSubagentCatalogListener`, registered by the entry at apply, before execution can start) feeds the same matcher for the exact carrying Session, bounded by the live `session.seq` rather than the captured catch-up endpoint, so a catalog appended AFTER eligibility still joins.
5. **Consume once** — the slot becomes `null` BEFORE the append attempt, the observed child id is copied onto the retained dispatch ref first (the same object sits in `dispatchByJobId` while a background job is in flight, so its terminal settle then carries the id; a candidate whose terminal already consumed the job entry still owns the ref long enough to write the identity independently), then `recordSubagentLink` appends to the DISPATCH's `workflowDir` — never today's active workflow dir. Append/read failures stay contained and logged; nothing is retried and no existing row is rewritten.

The matcher validates every field of the verified v0 payload: event type, payload `version === 0`, finite envelope time, integer envelope `seq` with `fromSeq <= seq < session.seq` and `seq < 2^31`, non-negative integer `childCreatedAt`, non-empty bounded `childId`, RAW label equality (the join always compares the ORIGINAL label; display normalization/truncation applies only to the written row), the mode implied by the result kind, and for continuable the returned-child agreement.

A `subagent-link` row is an IDENTITY record, NOT a completion: it carries no `outcome`, no `verdict` and no `paired` marker, and its `ts` is the link OBSERVATION time — never a fabricated child-creation time (`childCreatedAt` is validated as a payload field, not used as a second ledger clock). Join degradation, all honest (zero rows, never a guess): missing/empty label; no valid background `jobId`; unpaired dispatch; unknown catalog version; mode not matching the result kind; a continuable catalog naming a different child than the tool returned; an already-consumed slot; the per-Session slot map at capacity (500 raw labels retained, new keys refused — a permanent per-Session degradation warned once per apply); an unreadable/missing live Session. **No cold scan and no `session/created` backfill ever runs**: a catalog written before apply has no surviving dispatch ref and must never label a future same-label dispatch, and constructor seeds precede every newly captured `fromSeq`. The join is therefore apply-scoped — resuming or reapplying loses pending correlations intentionally; cross-restart reconstruction would need a separate ownership contract. Duplicate labels are deterministic best-effort (first reservation + first matching catalog wins), NOT proof of unique ownership. Not every provider emits a catalog at all: a remote run without a `localAgent` produces none, so a dispatch may legitimately have no link row.

**Known limitation (registered residual) — RESOLVED.** The SIBLING consumer `gates/workflow-ledger.ts` used to run a cold scan and a `session/created` backfill that read `(session as SessionView).events`; a real dsh `Session` exposes `eventAt(seq)` / `snapshotEvents()` / `seq` and no `events`, so both halves silently recorded nothing after a plugin re-apply. That read now goes through `eventAt(seq)` (the module's own `session eventAt` binding) plus the `ctx.events.on('session/created' | 'session/event')` listeners, so the observation surface records again. The agent-flow join above always used this read; the residual id `<plan-id>` may be closed in `{PROJECT_DIR}/dsh-integration/residuals.json`.

**Catalog evidence**: `state.agentFlow: { events: AgentFlowEventView[] (≤50), summary } | null` — same TTL cycle as the rest of `state` (60 s), except that a ledger record (dispatch / settle / link) invalidates the affected workspace's TTL cache entry IMMEDIATELY (apply-scoped `harnessDir → cache key` reverse map + invalidation closure), so the next pre-step rebuilds and (digest text change) re-injects the row; the TTL still bounds non-ledger staleness. The summary buckets every event once: dispatch → verdict, settle → outcome, link → the literal `subagent-link` outcome under its DISPATCH's role (an identity signal that is neither a dispatch nor a settle), workflow kinds → a `workflow` pseudo-role. The model-facing text stays ONE compact line and only when events > 0 (`agent flow: N events (latest 50); by role: …; latest: …`), and the `by role` totals EXCLUDE `subagent-link` rows — identity is not activity; the full events live in the structured source for the panel.

**Panel consumer (historical)**: the retired client-side pipeline constants (`EXPECTED_ROLE_FLOW`, `projectFlowEvents`, `eventLogEntries`, `pairSettleIndexes`) lived in `packages/dsh/src/client/panel/graph/`, which no longer exists — the panel is now view-screen based (`packages/ui/src/screens/`) and reads `DashboardView` DTOs. The rules that still bind a future projection: client-side schema constants stay strictly separated from catalog evidence; a projection function is TOTAL (per-field degradation, never throws); settle pairing is EXACT identity `(agent, role, planId, taskId)` with no owner+time guessing, and an unpaired settle stays unpaired; a `subagent-link` is identity, not completion (no `outcome`, no `paired`), so `link-only` is never relabelled `settle-only`.

## Why This Matters

The ledger is the only durable record of what actually happened during an iteration (who was dispatched, to what, with what result, and — new — which child session that dispatch started). It feeds both the model (compact catalog line) and the panel (pipeline + event log), closing the "expected vs actual" loop the user asked for and letting the DSH GUI answer "which role is this subagent row" without waiting for a settle. Honest degradation (empty vs degraded vs garbage) and real-completion pairing (foreground post-execute + background `jobs.onJobDone`; unpaired → no settle; no catalog match → no link) keep the evidence trustworthy: an identity row is never fabricated, and an unknown identity is omitted rather than guessed.

## When to Apply

- Adding any new evidence channel to the engine-status catalog (same record-point/TTL/omit discipline).
- Extending dispatch gating (new verdicts, new Assignment fields — record alongside the gate core, never in one surface only).
- Any new host surface that dispatches subagents (wire through the same `dispatchGate` core to keep one record point).
- Any consumer that needs child-session identity, or that renders the ledger (panel projections, event log, model line) — check the identity/activity split above before counting a link as work.

## Examples

- `{HARNESS_DIR}/plans/<plan-id>.md` (locked D1–D6 contract: pairing re-key, identity fields, call-window join, role normalization, reference/panel cutover) and `{HARNESS_DIR}/sdd/<plan-id>/task-1-report.md` (T0 hard-seam runtime evidence: one root listener receiving two scoped parents' catalogs, the v0 payload, prepared post-execute arguments, and `eventAt` recovery of a catalog appended before the tool returned).
- `{HARNESS_DIR}/iterations/iter-<plan-id>/specs/agent-flow-catalog-graph.md` (original verified design), `packages/dsh/src/gates/agent-flow.ts`, `packages/dsh/tests/agent-flow.spec.ts` (write/read/truncate/limit/malformed/summary/verdict triples/hard-deny/settle branches + the catalog-join orders, caps, collisions and pre-apply exclusions), `{HARNESS_DIR}/iterations/iter-<plan-id>/guides/agentflow-pipeline-verification.md` (browser OVERALL PASS: 6 stages, unexpected ×2, lit ×1, five status colors, settled marker, 17 edges).
- `skills/mstar-host/references/dsh.md` § Agent-flow ledger — the host-facing summary of this contract (kept in step with the code by the same plan).
