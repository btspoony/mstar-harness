/**
 * Agent-flow event projection for actual Dsh dispatch, settle, workflow-event,
 * and subagent-link activity. SQLite execution authority owns event identity,
 * append ordering, cursor advancement, and concurrent-write serialization.
 *
 * Selection-bound writes receive the exact `{ storeId, epoch }` selected by
 * their asynchronous caller. They never probe for a replacement generation
 * at commit time. `recordWorkflowEvent` accepts one verified native event in
 * a single store transaction that appends the display row, records its stable
 * identity/digest, and advances the matching stream-incarnation scan bound.
 * Live tool-call rows use native ledger append with the same selected store
 * generation. A stale selection, identity conflict, or unavailable store is
 * reported as the original engine refusal; logging remains advisory and does
 * not block dispatch.
 *
 * `readAgentFlow` reads the latest native ledger window and returns `null`
 * when the authoritative store cannot be read. Malformed rows remain skipped
 * at the projection boundary. No JSONL, cursor, index, archive, compaction,
 * file-lock, or runtime file-fallback state participates in event processing.
 *
 * Real settle pairing is apply-scoped. `tools/post-execute` pairs a dispatch
 * only to its verified completion result; the installed dsh `subagent` /
 * `subagent_fork` activation (which returns `{ kind: 'activation', name }` —
 * started, not settled) is paired to the child that name resolves to and
 * settles only on that child's `subagent/end`. Both rc.3 delegation tools
 * return `activation` only, so no other success shape reaches this seam from
 * them: unpaired calls and malformed results are never fabricated as
 * settlements.
 * The job-settle pairing and the call-window catalog join are retained with
 * their entry wiring (`jobs.events`, `session/event`) but are unreachable
 * from rc.3's delegation tools — no background or continuable result ever
 * authorizes them.
 *
 * Module boundary: the entry and adapter import this module explicitly; its
 * public event APIs are re-exported by the entry.
 */
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import { assignmentHeaderRegion, parseAssignmentFields } from '@mstar-harness/engine'
import { appendDshLedgerRow, appendDshWorkflowEvent, readDshLedgerWindow } from '@mstar-harness/engine'
import type { DshSelectedGeneration } from '@mstar-harness/engine'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AgentFlowContinuationEventView, AgentFlowEventView, AgentFlowSummaryRow, AgentFlowView } from '../types.ts'

/** The projected continuation view lives in the shared types module (it is a member of the exported {@link AgentFlowView} union) — re-exported here for the module's existing import surface. */
export type { AgentFlowContinuationEventView }
import { asRecord } from './_shared.ts'
import type { Config } from './_shared.ts'
import { isNaValue, planIdOf, sessionIdOf, DEFAULT_DISPATCH_TOOLS, TEAM_DISPATCH_TOOLS } from './dispatch.ts'
import {
  isTeamDispatchToolName,
  resolveMemberId,
  settleOutcomeOfStopReason,
  subagentSurfaceOf,
  type SubagentSurface,
  type TeamServiceContext,
} from './team-identity.ts'
// The SHARED ASCII-control-char strip : the ralph
// `objective` — model-controlled display text, like the workflow name —
// is routed through the same normalization at the verdict-row WRITE
// boundary (parity with the W-B2 name/label/phase discipline), so a
// hostile objective (ESC/ANSI/NEL embedded) never reaches the ledger view.
// workflow-policy imports dispatch.ts type-only — no runtime cycle.
import { normalizeWorkflowName } from './workflow-policy.ts'

/** Default native-ledger read window. */
export const AGENT_FLOW_DEFAULT_LIMIT = 50
/** Bounded in-memory call-window candidate slots per parent Session. */
export const AGENT_FLOW_CATALOG_SLOT_CAPACITY = 500
/**
 * Bounded in-memory child pairing slots (apply-scoped, like the call/job
 * pairing maps) — keyed by the child `SessionId` and written only by the
 * subagent activation pairing. An activation dispatch is paired to its
 * resolved child `SessionId` and consumed by the child's `subagent/end`
 * settlement; a child whose settlement never arrives (service disposal, HMR,
 * an upstream shape change) must not grow the map forever. At capacity the
 * OLDEST entry is evicted with an explicit unresolved-continuation row for
 * that dispatch, so the bound never silently drops a pairing.
 */
export const AGENT_FLOW_TEAM_CHILD_CAPACITY = 1024
/**
 * Bounded in-memory early-end records per accounting scope (a direct parent
 * Session, or the unparented bucket — the only cross-parent scope). The record
 * count is deliberately NOT bounded by the scope's in-flight dispatch count: a
 * record no in-flight ref can ever claim is a legitimate leftover (a re-woken
 * child, a non-Assignment `subagent` child, a `workflow agent()` child), and
 * refusing it would let it spend the chance of a genuine early end whose ref is
 * still waiting. Capacity is a memory bound only, so overflow replaces the
 * OLDEST record of the scope with an eviction marker: the dispatch that would
 * have claimed it records an explicit unresolved continuation instead of
 * silently losing its settle.
 * Exact invariant: LIVE records <= capacity; markers <= overflow insertions
 * within one open window (each overflow insert adds one marker and one live
 * key, so a window held open by a storm grows markers without bound).
 * shortcut: markers are not capacity-counted; count them too (oldest-marker
 * eviction) if a producer can storm one parent's window past this capacity.
 */
export const AGENT_FLOW_ACTIVATION_END_CAPACITY = 1024
/** Stable identity namespace for verified native workflow events. */
export const WORKFLOW_EVENT_ID_PREFIX = 'wfe1'
/** Stable identity namespace for live tool-call rows. */
export const CALL_EVENT_ID_PREFIX = 'wfc1'
/**
 * Workflow field length caps are enforced at the producer boundary and again
 * when native rows are projected. Oversized IDs skip the row rather than
 * being truncated into a collision; oversized display fields are truncated
 * deterministically with a visible marker. Invalid optional settle identities
 * are omitted while the real completion remains recorded. Sequence numbers
 * stay within the exact range supported by the native scan-bound API.
 */
export const WORKFLOW_LEDGER_MAX_ID_LENGTH = 512
/** Cap for label-sized display fields (`label`, `phase`). */
export const WORKFLOW_LEDGER_MAX_LABEL_LENGTH = 512
/** Cap for the run display `name`. */
export const WORKFLOW_LEDGER_MAX_NAME_LENGTH = 1024
/** The deterministic suffix marker appended to capped display fields. */
export const WORKFLOW_LEDGER_TRUNCATION_MARKER = '…'
/** Upper bound (exclusive) for envelope + member sequence numbers. */
export const WORKFLOW_LEDGER_MAX_SEQ = 2 ** 31

/**
 * Deterministically cap one display field: values at or under the cap pass
 * through unchanged; longer values are truncated to `cap − marker` chars
 * plus the {@link WORKFLOW_LEDGER_TRUNCATION_MARKER} suffix (the marker
 * guarantees the truncation is visible in the panel — never a silent cut).
 * CODE-POINT gated AND sliced : `String.prototype.slice` operates on UTF-16 code units and can split
 * a surrogate pair at the cap boundary (a lone surrogate renders as U+FFFD
 * in the log line), and a UTF-16 `.length` gate would false-positive
 * truncate astral-dense values (≤ cap code points but > cap UTF-16 units)
 * then re-inflate the result to cap code points — up to ~2× the cap in the
 * unit the gate measured. ONE `Array.from` drives both the gate and the
 * slice, so the bound is measured and enforced in the same unit; a
 * multi-byte character at the boundary is kept whole, at the cost of at
 * most one code point of slack. Pure — NEVER throws.
 */
export function truncateLedgerField(value: string, cap: number): string {
  const cps = Array.from(value)
  if (cps.length <= cap) return value
  const keep = cap - WORKFLOW_LEDGER_TRUNCATION_MARKER.length
  const prefix = keep > 0 ? cps.slice(0, keep).join('') : ''
  return prefix + WORKFLOW_LEDGER_TRUNCATION_MARKER
}

/**
 * Canonicalize one Assignment `Execute as` value for the ledger's `role`
 * field: `trim()`, then strip ONE leading `@`. The `role` column is what
 * every consumer groups by, so `@explore` and `explore` must be the SAME
 * role — normalization happens ONCE, at the write boundary (the dispatch row
 * and its pairing ref, plus the direct `recordSettle` /
 * `recordSubagentLink` entry points, whose callers may hand in a raw
 * Assignment value). NO case folding: role ids are host-defined strings, and
 * folding could merge ids a host intends to keep distinct. No interior
 * rewrite either — only the edges are trimmed. A missing role stays `''`,
 * and rows already on disk are never rewritten or renormalized. Pure —
 * NEVER throws.
 */
export function normalizeRoleId(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
}

/**
 * The OPTIONAL identity-field gate (the settle `childId` / `taskRef`): a
 * non-empty string of at most {@link WORKFLOW_LEDGER_MAX_ID_LENGTH} UTF-16
 * units (inclusive) passes through; every other value — absent, empty,
 * non-string, oversized — yields `undefined` so the caller OMITS the field.
 * Contrast the REQUIRED workflow-row ids, where an oversized value skips the
 * whole row: an optional identity never suppresses the real completion, and
 * an id is never truncated or re-keyed (a capped id is a different id).
 * Structural on both boundaries: a malformed persisted value is treated
 * exactly like an absent one.
 */
function optionalLedgerId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= WORKFLOW_LEDGER_MAX_ID_LENGTH ? value : undefined
}
/** Logger label for the agent-flow ledger (dsh logger naming: `<scope>/<subject>`). */
export const AGENT_FLOW_LOGGER = 'mstar/agent-flow'
/**
 * The settle seam name — the dsh-tools registry's `tools/post-execute`
 * waterfall. VERIFIED to be dispatched by the real registry for every tool
 * call (`runPostExecute` → `postExecute`, upstream source; pinned by the
 * real-call probe in `tests/agent-flow.spec.ts`), so settles are no longer
 * host-emission-dependent (the
 * old "not part of the verified surface" assumption is obsolete).
 */
export const SETTLE_SEAM = 'tools/post-execute'
/**
 * The once-per-apply settle-pairing trace. A delegation carrier PAIRS through
 * the tool seam and settles on its own completion edge — the child
 * `subagent/end` its `activation` name resolves to, never the tool return.
 * No rc.3 delegation tool produces a background or continuable result, so the
 * jobs-lifecycle channel stays wired but unused.
 */
export const SETTLE_SEAM_PAIRING_NOTE =
  `settle seam "${SETTLE_SEAM}" IS part of the verified dsh-tools registry surface (runPostExecute dispatches it for every tool call) — a delegation carrier pairs here and settles on its own completion edge (the child \`subagent/end\` its rc.3 \`activation\` name resolves to, never the tool return); only UNPAIRED payloads (non-dispatch tools, calls outside the apply-scoped pairing window) stay dispatch-only — never a fabricated settle`

/** Dispatch verdict vocabulary (spec §2.1.3). */
export type DispatchVerdict = 'ok' | 'advisory' | 'denied'
/** Settle outcome vocabulary (spec §2.1.3). */
export type SettleOutcome = 'ok' | 'error' | 'denied'
/** Workflow run terminal reason (`tool-workflow` vocabulary — `workflow/src/types.ts:63`). */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'
/**
 * Workflow/ralph gate verdict vocabulary : the RESOLVED outcomes reuse the dispatch verdict vocabulary
 * (`ok`/`advisory`/`denied` — the plan interface "the workflow verdict
 * vocabulary"); `ask` is the PENDING-decision member — the first-seen ask
 * itself is a gated call, so its row carries `ask` until the approval
 * waterfall resolves it ("one ledger row per gated call").
 */
export type WorkflowVerdict = DispatchVerdict | 'ask'
/**
 * The workflow/ralph gate mode (Config `workflowGate` — plan
 * verdict rows), recorded on every verdict row.
 * `off` rows never exist: the gate short-circuits `off` BEFORE the policy,
 * so no verdict is produced.
 */
export type WorkflowGateMode = 'off' | 'warn' | 'ask' | 'hard'

/**
 * One v1 workflow ledger event (the native SQLite row). Produced from the
 * durable `tool-workflow/*` session events by the session-event consumer:
 * `run-start` → `workflow-run`, `agent-start` → `workflow-agent`, and
 * `run-end` → `workflow-run-end`; upstream `agent-end` has no ledger kind.
 * Optional fields (`agent` / `phase`) are omitted when absent.
 */
export type AgentFlowWorkflowEvent =
  | {
      v: 1
      ts: number
      kind: 'workflow-run'
      /** The workflow run's stable id (upstream `runId`). */
      runId: string
      /** The run's display name (upstream `name`). */
      name: string
      /** The calling session's stable id, when carried. */
      agent?: string
    }
  | {
      v: 1
      ts: number
      kind: 'workflow-agent'
      /** The workflow run's stable id (upstream `runId`). */
      runId: string
      /** 1-based `agent()` call sequence within the run (upstream `seq`). */
      seq: number
      /** The published member's display label (upstream `label`). */
      label: string
      /** The member's phase, when carried (upstream `phase?`). */
      phase?: string
      /** The published child session's stable id (upstream `childId`). */
      childId: string
    }
  | {
      v: 1
      ts: number
      kind: 'workflow-run-end'
      /** The workflow run's stable id (upstream `runId`). */
      runId: string
      /** Terminal run reason (upstream `stopReason`). */
      stopReason: WorkflowStopReason
    }

/**
 * One v1 event (spec §2.1.3 + native row). Optional fields are omitted when
 * absent. The three `workflow-*` variants are the W-B2 addition; see
 * {@link AgentFlowWorkflowEvent}.
 */
export type AgentFlowEvent =
  | {
      v: 1
      ts: number
      kind: 'dispatch'
      /** The dispatching session's stable id (exec.agent.id; host-hook path has no exec → absent). */
      agent?: string
      /** Assignment `Execute as` ('' when missing). */
      role: string
      /** planIdOf(header): `Plan Path` / `SDD dir` / `plan_id` basename. */
      planId?: string
      /** Body `Task N` best-effort extraction (taskIdOf). */
      taskId?: string
      /** Assignment `Task category`. */
      taskCategory?: string
      /** Gate verdict derivation: no violations → ok; hard + violations → denied; else advisory. */
      verdict: DispatchVerdict
      /** resolveDispatchHard result (recorded unconditionally, incl. hard denies). */
      hard: boolean
      /**
       * The live tool-call id the dispatch seam observed (the SAME id the
       * settle / continuation row carries), when the exec supplied one — the
       * call-scoped pairing identity that keeps two concurrent same-identity
       * dispatches distinct. Omitted when the seam supplied none — never
       * fabricated.
       */
      callId?: string
    }
  | {
      v: 1
      ts: number
      kind: 'settle'
      /** The settled session's stable id (the paired dispatch's agent). */
      agent?: string
      outcome: SettleOutcome
      durationMs?: number
      /**
       * The PAIRED dispatch's identity (plan  same field names + semantics as the dispatch event:
       * `role` is the Assignment `Execute as` ('' when missing), `planId` /
       * `taskId` the plan + `Task N` tags. Written for every paired settle;
       * ABSENT on unpaired (legacy) settles — the client pairs on identity
       * presence (`paired` in the view never depends on `childId`).
       */
      role?: string
      planId?: string
      taskId?: string
      /**
       * The settled child session's stable id, when a seam actually supplied
       * one: a child `subagent/end` settlement's id, or a background job's
       * child id once the catalog join copied it onto the dispatch ref.
       * OMITTED otherwise — never fabricated, never a registry job id.
       */
      childId?: string
      /**
       * The registry background-job id a background settle pairs on
       * (`jobs.events` settled notification → `recordJobSettle`). A jobs-registry key
       * (`<kind>-N`), NEVER a child session id and never the Assignment
       * `Task N` tag (`taskId`).
       */
      taskRef?: string
      /**
       * The paired dispatch's live tool-call id — the settle row's call-scoped
       * pairing identity (the SAME id the dispatch row carries). Omitted when
       * the pairing ref carried none — never fabricated.
       */
      callId?: string
    }
  | {
      v: 1
      ts: number
      kind: 'subagent-link'
      /** The dispatching session's stable id (the paired dispatch ref's agent; absent when it carried none). */
      agent?: string
      /**
       * The catalog `childId` — the child session the dispatch actually
       * started. REQUIRED: a row whose identity is missing, empty, or
       * oversized is skipped (never truncated, never fabricated).
       */
      childId: string
      /**
       * The delegation `description` the join correlated on, DISPLAY-
       * normalized and capped at this write boundary (the matcher always
       * compares the RAW label, never this value).
       */
      label: string
      /** The paired dispatch's Assignment `Execute as` — written even when `''`. */
      role: string
      /** The paired dispatch's `planIdOf(header)`. */
      planId?: string
      /** The paired dispatch's Assignment `Task N` tag. */
      taskId?: string
      /**
       * The registry background-job id, on a link whose dispatch started a
       * background job (`<kind>-N`). A continuable link omits it — that path
       * starts no registry job. Never a child session id.
       */
      taskRef?: string
    }
  | {
      v: 1
      ts: number
      kind: 'workflow-verdict'
      /** The calling session's stable id, when carried. */
      agent?: string
      /** The matched tool name (`'workflow'` | `'ralph'`). */
      tool: 'workflow' | 'ralph'
      /** `meta.name` for workflow calls — the P-a/P-c allowlist identity. */
      workflow?: string
      /** `objective` for ralph calls — the ralph identity. */
      objective?: string
      /** The effective `workflowGate` mode at decision time (never `off` — off records nothing). */
      mode: WorkflowGateMode
      /** The gate verdict (ok/advisory/denied/ask). */
      verdict: WorkflowVerdict
      /** The policy violation code (advisory/ask/denied rows only). */
      code?: string
    }
  | AgentFlowWorkflowEvent

/**
 * The explicit UNRESOLVED-CONTINUATION marker of one team dispatch. It is
 * written through the same native ledger append and carries the paired
 * dispatch identity, but it is deliberately NOT a settle: it is written ONLY
 * instead of a settle when a team dispatch's continuation cannot be paired —
 * never an `ok` settle, never a fabricated outcome. Projected — the
 * unresolved-continuation projection: {@link eventFromUnknown} accepts the kind and the catalog view
 * lists the row (its state + reason) instead of dropping it, so the panel
 * derives a DISTINCT non-running entity state from it. Additive only — every
 * existing event kind keeps its projected rendering.
 */
export interface AgentFlowContinuationEvent {
  v: 1
  ts: number
  kind: 'continuation'
  /** The dispatching session's stable id (the paired dispatch ref's agent; absent when it carried none). */
  agent?: string
  /** The paired dispatch's Assignment `Execute as` ('' allowed — the dispatch row's grammar). */
  role: string
  /** The paired dispatch's `planIdOf(header)`. */
  planId?: string
  /** The paired dispatch's Assignment `Task N` tag. */
  taskId?: string
  /**
   * The continuation state. `unresolved` is the ONLY value: the dispatch was
   * observed but its continuation cannot be paired (member/child identity
   * unresolvable, no attributable member turn, pairing window ended).
   */
  state: 'unresolved'
  /** Bounded display reason (normalized; why the continuation could not be paired). */
  reason: string
  /**
   * The paired dispatch's live tool-call id, when the dispatch seam supplied
   * one — the call-scoped pairing identity a reader pairs this row with
   * (two concurrent same-identity dispatches stay distinct). Omitted when the
   * ref carried none — never fabricated.
   */
  callId?: string
}

/** One durable ledger row this module appends and the reader projects (the continuation marker is projected, not dropped). */
type AgentFlowLedgerEvent = AgentFlowEvent | AgentFlowContinuationEvent

/**
 * The identity of one recorded dispatch, carried by the pairing store so a
 * later completion (post-execute settle / settled jobs event) can record a
 * settle carrying the SAME identity fields as its dispatch event.
 */
export interface AgentFlowDispatchRef {
  /** The resolved `{HARNESS_DIR}` the dispatch was attributed to. */
  harnessDir: string
  workflowId: string
  /** The ACTIVE workflow directory; process target only, not machine identity. */
  workflowDir: string
  selectedGeneration: DshSelectedGeneration
  /** The dispatching session's stable id ('' when the exec carried none). */
  agent?: string
  /**
   * The tool-call id observed at the dispatch seam (the SAME id the settle
   * seam looks the pairing up by). It is the record identity namespace of
   * the live call rows (`wfc1:<sessionId>:<callId>:<kind>`), so a settle /
   * link row can carry the identity of the call that produced it. Omitted
   * when the seam supplied none — never fabricated.
   */
  callId?: string
  /** Assignment `Execute as`, canonicalized by `normalizeRoleId` ('' when missing — the dispatch event's grammar). */
  role: string
  /** `planIdOf(header)` — the dispatch event's grammar. */
  planId?: string
  /** `taskIdOf(prompt)` — the Assignment `Task N` tag, NOT a registry task id. */
  taskId?: string
  /**
   * The child session's stable id, once an upstream seam actually supplied
   * one: the activation child end passes it to the settle; the catalog join
   * would copy an observed catalog `childId` here, but it is unreachable
   * from rc.3's delegation tools. Omitted until known — never a synthetic id
   * and never a registry job id.
   */
  childId?: string
  /**
   * The registry job id of a background call this dispatch started — written
   * only by the `{ kind: 'background', jobId }` result branch, which no
   * rc.3 delegation tool produces (both return `activation`). A
   * jobs-registry key (`<kind>-N`) — NEVER a child session id and never the
   * `Task N` tag.
   */
  taskRef?: string
  /**
   * The admitted call-window catalog CANDIDATE of this dispatch: the live
   * parent Session it runs on plus the RAW delegation label that names its
   * slot. Present only while a reservation is live — `recordDispatch`
   * installs it and every result shape retires it; no rc.3 result can advance
   * it to eligible, so the join never matches. Its presence is what lets the
   * post-execute path find the join without re-deriving the session.
   */
  catalog?: { session: AgentFlowSessionView; label: string }
}

/**
 * The structural view of one live dsh `Session` the call-window join needs:
 * the VERIFIED upstream surface (`id` / `seq` / `eventAt`). A real Session
 * exposes no `events` member — that read is why the join uses `eventAt(seq)`
 * over a bounded window instead of copying a log. Structural by design (no
 * session package dependency); `seq` is read LIVE at every use, so the
 * captured view is also the catch-up bound source while `fromSeq` (stored on
 * the join) keeps the capture moment.
 */
export interface AgentFlowSessionView {
  readonly id: string
  readonly seq: number
  eventAt(seq: number): unknown
}

/**
 * One pending call-window catalog candidate: the recorded dispatch ref and
 * the `fromSeq` window start. `result` marks ELIGIBILITY — an inert
 * candidate (no `result` yet) can never be matched by a catalog, and the
 * slot's `null` tombstone is a consumed/rejected candidate, never a second
 * one. In rc.3 NOTHING sets `result`: eligibility came only from the
 * `background` / `continuable` result branches, and both delegation tools
 * return `activation`.
 */
export interface AgentFlowCatalogJoin {
  ref: AgentFlowDispatchRef
  fromSeq: number
  result?: { kind: 'background'; jobId: string } | { kind: 'continuable'; subagentId: string }
}

/**
 * One buffered child `subagent/end` awaiting its activation pairing.
 * `parentSessionId` is the payload's DIRECT parent — the accounting scope of
 * admission and eviction, so a record occupies only the budget of the parent
 * whose dispatch can claim it. Absent only when the payload carried none: the
 * record is then accounted against the whole pairing's in-flight dispatches
 * (never dropped silently on the strength of a missing field).
 */
export interface ActivationChildEndRecord {
  parentSessionId?: string
  stopReason: unknown
  /**
   * The record was evicted at {@link AGENT_FLOW_ACTIVATION_END_CAPACITY}: the
   * end it carried is gone, so the ref that would claim it records the explicit
   * unresolved continuation instead of keying a pairing that can never settle.
   * A marker holds no capacity; it is dropped with its scope (the window
   * close), so the marker set is bounded by the window, not by the capacity.
   */
  evicted?: true
}

/**
 * The apply-scoped pairing store (
 * decision D1 — created in the entry `apply`, same lifetime as the catalog
 * cache; an HMR restart resets it, and completions outside the window stay
 * unpaired → no settle, the documented honest degrade). Maps are keyed by
 * the TWO verified pairing keys: the tool-call `callId` (pre → post-execute)
 * and the registry background-job id (post-execute background shape →
 * `jobs.events` settled lifecycle notification).
 */
export interface AgentFlowPairing {
  /**
   * The agent-namespaced call key → the dispatch it recorded (populated by
   * `recordDispatch` when an exec is present). Key = `${sessionId}\u0000${toolName}\u0000${callId}`
   * : a raw `ToolExecution.callId` is NOT globally unique
   * in one process — dsh runs many sessions concurrently and upstream mints
   * per-message ids (`call-${index}`), so the dispatching session id must
   * namespace the key or session B's same-id call could overwrite session A's
   * pairing and mis-pair A's settle into B's dispatchRef. Consumed (deleted)
   * by the post-execute branch — the map holds only in-flight calls.
   */
  dispatchByCallId: Map<string, AgentFlowDispatchRef>
  /**
   * Registry background-job id (`JobSnapshot.id`) → the dispatch that started
   * it. NO rc.3 writer: only the post-execute `{ kind: 'background', jobId }`
   * branch populated it, and both rc.3 delegation tools return `activation`.
   * Consumed by `recordJobSettle` from the entry's jobs listener, so the map
   * and its consumer stay wired while recording nothing for rc.3 tools.
   */
  dispatchByJobId: Map<string, AgentFlowDispatchRef>
  /**
   * Child `SessionId` → the dispatch that started it. Populated by the
   * subagent activation branch: the tool returns `{ kind: 'activation',
   * name }` and the subagent surface resolves that name to the child
   * `SessionId` (started, not settled); consumed by the child's
   * `subagent/end` settlement, or evicted at
   * {@link AGENT_FLOW_TEAM_CHILD_CAPACITY}. Optional so existing pairing
   * constructors stay valid; the activation branch creates it lazily.
   */
  teamDispatchByChildId?: Map<string, AgentFlowDispatchRef>
  /**
   * The activation PAIRING WINDOW: the recorded activation dispatches whose
   * created child id is not known yet because the returned name is still
   * being resolved to a child `SessionId` (an asynchronous surface read).
   * The window is entered BEFORE that read starts and left exactly once —
   * resolution landed, name unresolvable, or resolution failed — so the set
   * is bounded by the in-flight activation dispatches of the apply.
   */
  activationResolutions?: Set<AgentFlowDispatchRef>
  /**
   * Child `SessionId` → the record of a child `subagent/end` that arrived
   * BEFORE its activation pairing was keyed. The child is published inside the
   * tool call, so its end can precede even the tool's `tools/post-execute`.
   * Admission is PER DIRECT PARENT ({@link ActivationChildEndRecord}): a record
   * is kept only while its parent has a recorded dispatch in flight (a call not
   * yet post-executed, or a ref in {@link activationResolutions}), so two
   * parents can never consume each other's budget. The COUNT is not bounded by
   * the parent's in-flight refs — a record no ref can ever claim is a
   * legitimate leftover — only the per-scope capacity
   * ({@link AGENT_FLOW_ACTIVATION_END_CAPACITY}, whose overflow evicts the
   * oldest record with a marker). Once a parent has no in-flight dispatch left
   * nothing can claim its records, so they are dropped at that point
   * ({@link sweepUnclaimableChildEnds}) rather than occupying capacity for the
   * apply's lifetime; that release is what keeps a LATER genuine early end
   * admissible. Reconciliation consumes the entry (a child end settles a
   * dispatch at most once).
   */
  endsAwaitingActivation?: Map<string, ActivationChildEndRecord>
  /**
   * The call-window catalog join's slots: the EXACT parent Session object →
   * (RAW delegation label → candidate). A `null` slot is a consumed or
   * rejected tombstone, never a second candidate — reuse is what would let a
   * delayed duplicate label or a pre-existing catalog acquire a new owner.
   * Keying on the session OBJECT (not its id) is what makes the namespace
   * session-incarnation safe and delimiter-free; per Session the map holds at
   * most `AGENT_FLOW_CATALOG_SLOT_CAPACITY` slots (new keys are refused at capacity —
   * existing pending entries and tombstones are retained). Every candidate
   * stays inert (see {@link AgentFlowCatalogJoin}), so no `subagent-link` row
   * is emitted for an rc.3 delegation call; the observer registration stays
   * wired from the entry.
   */
  catalogBySession: WeakMap<object, Map<string, AgentFlowCatalogJoin | null>>
}

/** Module-scoped log sink (bound to `mstar/agent-flow` by the entry at apply). */
type AgentFlowLogSink = (level: 'info' | 'warn' | 'error', message: string) => void
let logSink: AgentFlowLogSink | undefined
/**
 * Whether the settle-unavailable trace has been logged for the CURRENT sink
 * binding (the ~300-char note is emitted at most once per apply,
 * not on every registration).
 */
let settleNoteLogged = false
/**
 * Whether the catalog slot-map capacity refusal has been reported for the
 * CURRENT sink binding (ONE bounded warn per apply, not per refused dispatch
 * — same once-per-binding discipline as `settleNoteLogged`).
 * A saturated per-Session slot map silently stops admitting candidates, so
 * the degradation must announce itself at least once.
 */
let catalogCapacityWarned = false
/**
 * Module-scoped catalog-invalidation hook : called with
 * the affected `{HARNESS_DIR}` after every SUCCESSFUL ledger record
 * (`recordDispatch` / `recordSettle`). The entry binds the real invalidation
 * closure at apply (the apply-scoped harnessDir → cache-key
 * reverse-map closure in `index.ts` — see `createCatalogInvalidation`);
 * unbound → no-op. Never throws into the record path.
 */
type AgentFlowInvalidator = (harnessDir: string) => void
let invalidator: AgentFlowInvalidator | undefined

/**
 * Bind the module's catalog-invalidation hook (plan
 * the settle-pairing upgrade — same pattern as
 * {@link setAgentFlowLogger}; the entry binds at apply; the apply-scoped
 * real binding — the apply-scoped harnessDir → cache-key reverse-map
 * closure in `index.ts`).
 * @param invalidate - the hook (`undefined` clears the binding).
 * @returns the PREVIOUS hook (tests restore it in a `finally`).
 */
export function setAgentFlowInvalidator(invalidate: AgentFlowInvalidator | undefined): AgentFlowInvalidator | undefined {
  const prior = invalidator
  invalidator = invalidate
  return prior
}

/**
 * Bind the module's log sink (called once at apply; tests may rebind to
 * capture ledger logs). Rebinding RESETS the once-per-apply trace latches
 * — each binding is a fresh "apply" (production binds once; tests bind
 * per case for deterministic capture).
 * @param sink - the sink (entry binds `ctx.logger('mstar/agent-flow')`);
 * `undefined` clears the binding (restores the pre-bind no-op state).
 * @returns the PREVIOUS sink (tests restore it in a `finally`).
 */
export function setAgentFlowLogger(sink: AgentFlowLogSink | undefined): AgentFlowLogSink | undefined {
  const prior = logSink
  logSink = sink
  settleNoteLogged = false
  catalogCapacityWarned = false
  return prior
}

/** Log one ledger message through the bound sink (no-op before bind). */
function log(level: 'info' | 'warn' | 'error', message: string): void {
  logSink?.(level, message)
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Best-effort extraction of the targeted `Task N` from the Assignment BODY
 * (spec §2.1.1 — `taskIdOf`). The engine `assignmentHeaderRegion` boundary is
 * reused: only text AFTER the header region is scanned, so a `## Task N`
 * example quoted in the header never resolves a task id. Only a LEVEL-2
 * heading (`^## Task N`) matches (an example or sub-heading at
 * another depth before the real task must not resolve — lower false-hit
 * surface); normalized to `T<n>` (matches the panel render `planId#taskId`,
 * e.g.  #T2`).
 * @param prompt - the full Assignment text.
 */
export function taskIdOf(prompt: string): string | undefined {
  const header = assignmentHeaderRegion(prompt)
  const body = prompt.slice(header.length)
  const match = body.match(/^##[ \t]+Task[ \t]+(\d+)\b[^\n]*$/m)
  if (match === null) return undefined
  return `T${match[1]!}`
}

/**
 * The live-call row's CARRYING NATIVE SESSION id, read from the exec's agent.
 * SDK evidence (`@deepseek-ai/dsh-agent` `types.ts`): `Agent.id` is declared as
 * `SessionId` — "Session-backed Agent identity" — and the typert context map
 * keys the agent context by `SessionId`, so `exec.agent.id` IS the carrying
 * session id (one Agent per session), not an opaque handle. `ToolExecution.agent`
 * is OPTIONAL (set by the agent loop), so an exec-less host-hook call carries
 * no session identity at all: `undefined` here means "no verified carrying
 * session", and every identity-bearing write then omits its id rather than
 * substituting an empty string.
 */
function agentOfExec(exec: unknown): string | undefined {
  if (exec === undefined) return undefined
  return sessionIdOf(exec as ToolExecution)
}

/** Derive the gate verdict (spec §2.1.3): no violations → ok; hard + violations → denied; else advisory. */
function verdictOf(violations: readonly unknown[], hard: boolean): DispatchVerdict {
  if (violations.length === 0) return 'ok'
  return hard ? 'denied' : 'advisory'
}

/** The tool-call pairing key of an exec, when the seam exposes one (structural read). */
function callIdOf(exec: unknown): string | undefined {
  const rec = asRecord(exec)
  const callId = rec?.callId
  return typeof callId === 'string' && callId !== '' ? callId : undefined
}

/** The tool NAME of an exec, when the seam exposes one (structural read). */
function execToolName(exec: unknown): string | undefined {
  const name = asRecord(exec)?.name
  return typeof name === 'string' && name !== '' ? name : undefined
}

/**
 * The AGENT- AND TOOL-NAMESPACED pairing key of one exec:
 * `${sessionIdOf(exec) ?? ''}\u0000${toolName}\u0000${callId}`. A raw
 * `callId` alone is NOT
 * globally unique in one process — dsh runs many sessions concurrently and
 * upstream mints per-message ids (`call-${index}`; model-supplied
 * `toolCallId`s are commonly `call_0`-style per message too) — so the key
 * must carry the dispatching session id, or session B's same-id call could
 * overwrite session A's pairing and A's settle would pair into B's dispatchRef
 * (wrong harnessDir + wrong identity — exactly the defect class this plan
 * prevents). Both `recordDispatch` (registration) and `registerSettleListener`
 * (lookup + consumption) derive the key identically from the SAME exec, so an
 * agent-less exec (`sessionIdOf` → '') still pairs to its own registration.
 * The tool NAME is part of the key on top of the session: upstream reuses
 * `call-${index}` per MESSAGE, so the same raw call id recurs across messages
 * and across channels. Without the name, a later non-gated `subagent` call
 * whose per-message id collides with an in-flight/leaked TEAM call's id could
 * pair into that team dispatchRef and record a false settle; with it, a
 * pairing is only ever consumed by the SAME tool name that registered it.
 * @param exec - the tool-execution record (structural read).
 * @returns the namespaced key, or undefined when the exec carries no callId.
 */
function callPairingKey(exec: unknown): string | undefined {
  const callId = callIdOf(exec)
  if (callId === undefined) return undefined
  return `${sessionIdOf(exec as ToolExecution) ?? ''}\u0000${execToolName(exec) ?? ''}\u0000${callId}`
}


/* ---------------------------------- record identity ---------------------------------- */

/**
 * The durable source position of one workflow event: the carrying native
 * session, the native log INCARNATION that produced the envelope, and the
 * envelope's position in that log. `streamId` deliberately is NOT the store
 * epoch — an epoch change is not a new stream and must not duplicate
 * history; a rebuilt/reused log, by contrast, is a different incarnation the
 * caller names explicitly.
 */
export interface AgentFlowEventSource {
  /** The carrying native session's stable id. */
  sessionId: string
  /** The native log incarnation (a session id when the surface carries no explicit incarnation). */
  streamId: string
  /** The envelope's position in that log (integer in `[0, 2^31)`). */
  seq: number
}

/**
 * The identity transport of one NEW ledger line. `eventId` is the stable
 * record id; `source` is present on durable workflow events (the identity and
 * transactional scan bound are keyed to its stream position) and absent on
 * live tool-call rows (their identity is the call, not a log position). Older
 * rows carry neither — their identity is their native row contents.
 */
export interface AgentFlowRecordIdentity {
  /** The stable record id ({@link workflowEventId} / {@link callIdentity}). */
  eventId: string
  /** The durable source position (durable workflow events only). */
  source?: AgentFlowEventSource
}

/**
 * The deterministic event id of one durable workflow event:
 * `wfe1:<kind>:<sessionId>:<streamId>:<seq>` — the COMPLETE verified identity
 * tuple. BOTH the carrying native session id and the verified log incarnation
 * are part of the id, so two records can never collide across sessions or
 * across log incarnations of one session. Deterministic by construction: a
 * replay after a crash rebuilds the SAME id, so the ledger recognizes its own
 * already-appended row and never appends it twice.
 */
export function workflowEventId(event: AgentFlowWorkflowEvent, source: AgentFlowEventSource): string {
  return `${WORKFLOW_EVENT_ID_PREFIX}:${event.kind}:${source.sessionId}:${source.streamId}:${source.seq}`
}

/**
 * The identity transport of one live tool-call row, formed ONLY from a
 * verified carrying native session id AND the call id. Either one missing
 * (an exec without an agent, a call without a callId) yields NO identity —
 * the row is still recorded with its documented advisory semantics, but no id
 * is fabricated from an empty string or an unrelated handle, and the row can
 * never collide with another session's call. The carrying session namespaces
 * the call id because a raw `callId` is not globally unique in one process.
 */
export function callIdentity(kind: AgentFlowLedgerEvent['kind'], sessionId: string | undefined, callId: string | undefined): AgentFlowRecordIdentity | undefined {
  if (sessionId === undefined || sessionId === '' || callId === undefined || callId === '') return undefined
  return { eventId: `${CALL_EVENT_ID_PREFIX}:${sessionId}:${callId}:${kind}` }
}

/** Validate one source position: non-empty ids and an integer seq in `[0, 2^31)`. */
function validEventSource(source: AgentFlowEventSource): boolean {
  return (
    typeof source.sessionId === 'string' &&
    source.sessionId !== '' &&
    typeof source.streamId === 'string' &&
    source.streamId !== '' &&
    Number.isInteger(source.seq) &&
    source.seq >= 0 &&
    source.seq < WORKFLOW_LEDGER_MAX_SEQ
  )
}

/** JSON representation of one event and its optional native identity metadata. */
function ledgerLineOf(event: AgentFlowLedgerEvent, identity?: AgentFlowRecordIdentity): string {
  const row = identity === undefined ? event : { ...event, eventId: identity.eventId, ...(identity.source !== undefined ? { source: identity.source } : {}) }
  return JSON.stringify(row)
}

/** SHA-256 digest of one serialized row, used for durable event identity conflict checks. */
export function digestOfLedgerLine(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 32)
}

/** The `eventId` carried by one raw ledger line, when it parses and carries one. */


/**
 * Append one live Dsh record under the originally selected authority generation.
 */
function appendEvent(
  workflowId: string,
  event: AgentFlowLedgerEvent,
  identity: AgentFlowRecordIdentity | undefined,
  harnessDir: string,
  selectedGeneration: DshSelectedGeneration,
): boolean {
  const result = appendDshLedgerRow(
    { harnessDir },
    workflowId,
    ledgerLineOf(event, identity),
    identity?.eventId,
    selectedGeneration,
  )
  if (result.kind === 'degraded') {
    log('warn', `agent-flow live row unavailable (${result.reason}); recover with mstar store init or mstar store upgrade`)
    return false
  }
  return true
}

/**
 * Record one dispatch event (spec §2.1.3). Fully try/catch-contained — NEVER
 * throws into the gate; a failing record logs only (`mstar/agent-flow`).
 * Verdict derivation (ok/advisory/denied, incl. hard denies) and the header
 * identity derivation (role / planId / taskId / taskCategory) reuse the gate's
 * own parsers — one grammar.
 *
 * Pairing: when the input
 * carries an `exec` AND the apply-scoped `pairing` store, the successful
 * record registers the session- and tool-namespaced key
 * `${sessionId}\u0000${toolName}\u0000${callId}` → dispatchRef (the full
 * dispatch identity), so a later `tools/post-execute` for the same call can
 * settle with the SAME identity (the session id namespaces the key — a raw
 * callId is not globally unique across sessions in one process — and the tool
 * name keeps two channels' per-message ids from colliding). The pairing registers
 * only after the ledger append SUCCEEDED — a failed record never pairs to a
 * phantom dispatch. An exec-less record (host-hook path) has no callId → no
 * pairing. The pairing sub-path has its OWN catch scope: a `Map.set` throw must not log "record
 * failed" after the dispatch was already appended. On that same successful
 * pairing the dispatch's call-window catalog candidate is RESERVED (the
 * first RAW-label slot under the live parent Session, when the exec carries
 * one) — the child-identity join's step 1; admission is all-or-nothing and
 * never affects the dispatch, the pairing, or a later settle. TEAM carriers
 * ({@link TEAM_DISPATCH_TOOLS}) are the ONE exception to both the
 * unconditional record and the catalog reservation: with the team service
 * absent they record nothing at all, and when present they never reserve a
 * call-window slot — a board write or an inbox acceptance starts no child, so
 * a reservation could only sit inert and permanently consume one of the 500
 * slots.
 * @param input - the harness dir; the dispatching exec's agent id; the
 * Assignment text; the gate's violations; the hard-enforcement resolution;
 * the apply-scoped pairing store (the adapter passes its own; direct callers
 * may omit it); the carrying session's `hint` (the adapter derives it — this
 * module never reads the picker store); whether the optional team service is
 * mounted; the tool names the settle seam can pair (the adapter passes its
 * Config-resolved set; omitted → the documented defaults, so an unknown
 * exec-bound name still records its dispatch but leaves NO pairing entry).
 */
export function recordDispatch(input: {
  harnessDir: string
  exec?: unknown
  prompt: string
  violations: readonly unknown[]
  hard: boolean
  pairing?: AgentFlowPairing
  workflowId: string
  /** ACTIVE execution graph directory target resolved by the asynchronous host gate. */
  resolvedWorkflowDir: string
  selectedGeneration: DshSelectedGeneration
  /**
   * Whether the experimental Agent Teams service is mounted. Team carriers
   * record NOTHING while this is not `true` (the plugin keeps working on a
   * composition that mounts no team bundle); non-team carriers ignore it.
   */
  teamPresent?: boolean
  /**
   * The tool names the settle listener can pair (Config `dispatchTools` plus
   * the fixed team carriers). An exec-bound record whose name is not in this
   * set still writes its dispatch row but registers NO pairing entry and NO
   * catalog candidate — a name the settle seam declines can never leak
   * in-memory state.
   */
  pairingTools?: readonly string[]
}): void {
  try {
    // v3 write path: the ACTIVE workflow dir BOUND to this session (root v2
    // `workflows[]`). No bound lifecycle → the record is SKIPPED with a
    // one-time warn — never a root v1 write, never a terminal snapshot
    // write, never a sibling session's lifecycle (compass v3.0.0 § Catalog
    // selection rule).
    const workflowDir = input.resolvedWorkflowDir
    if (workflowDir === undefined || workflowDir === null) {
      log('warn', 'agent-flow dispatch record refused — the ACTIVE workflow target was omitted; resolve it from the ACTIVE execution workflow source before recording')
      return
    }
    const toolName = input.exec !== undefined ? execToolName(input.exec) : undefined
    const teamTool = toolName !== undefined && isTeamDispatchToolName(toolName)
    // Team channel absent → the team tools record nothing: the board and the
    // inbox are that service's surface, so a composition without it has no
    // team call to attribute.
    if (teamTool && input.teamPresent !== true) return
    const header = assignmentHeaderRegion(input.prompt)
    const fields = parseAssignmentFields(header)
    const planId = planIdOf(header)
    const taskId = taskIdOf(input.prompt)
    const taskCategory = fields.taskCategory
    // ONE canonical role for every row this dispatch produces: the row itself
    // and its pairing ref (which the settle / link boundaries then agree
    // with). `@explore` and `explore` are one actor, not two roles.
    const role = normalizeRoleId(fields.executeAs ?? '')
    const agent = input.exec !== undefined ? agentOfExec(input.exec) : undefined
    // Live tool-call identity: the carrying session namespaces the call id, so
    // two sessions running the SAME call id stay distinct records. A call
    // without an id has no stable identity — none is fabricated.
    const callId = input.exec !== undefined ? callIdOf(input.exec) : undefined
    const event: AgentFlowEvent = {
      v: 1,
      ts: Date.now(),
      kind: 'dispatch',
      ...(agent !== undefined ? { agent } : {}),
      role,
      ...(planId !== undefined && !isNaValue(planId) ? { planId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(taskCategory !== undefined && taskCategory.trim() !== '' ? { taskCategory } : {}),
      verdict: verdictOf(input.violations, input.hard),
      hard: input.hard,
      // The call-scoped pairing identity rides the DURABLE row: a reader can
      // pair a settle/continuation onto THIS dispatch (not merely the most
      // recent same-identity one) even across concurrent same-identity calls.
      ...(callId !== undefined && callId.trim() !== '' ? { callId } : {}),
    }
    if (!appendEvent(input.workflowId, event, callIdentity('dispatch', agent, callId), input.harnessDir, input.selectedGeneration)) return
    try {
      invalidator?.(input.harnessDir)
    } catch (error) {
      log('error', `catalog invalidation failed (contained): ${errorMessage(error)}`)
    }
    // callId pairing — only for exec-bound records after a successful database append,
    // and only for a tool name the settle seam can actually resolve. A name the
    // seam declines (an unknown/custom name) records its dispatch row but
    // registers NO pairing entry — holding a ref nothing will ever consume would
    // leak the map for the apply lifetime (and a later same-id call could
    // mis-settle it).
    try {
      const pairingTools = input.pairingTools ?? [...DEFAULT_DISPATCH_TOOLS, ...Object.keys(TEAM_DISPATCH_TOOLS)]
      const pairEligible = toolName !== undefined && pairingTools.includes(toolName)
      if (input.pairing !== undefined && input.exec !== undefined && pairEligible) {
        const key = callPairingKey(input.exec)
        if (key !== undefined) {
          const ref: AgentFlowDispatchRef = {
            harnessDir: input.harnessDir,
            workflowId: input.workflowId,
            workflowDir,
            selectedGeneration: input.selectedGeneration,
            ...(agent !== undefined ? { agent } : {}),
            role,
            ...(planId !== undefined && !isNaValue(planId) ? { planId } : {}),
            ...(taskId !== undefined ? { taskId } : {}),
            ...(callId !== undefined ? { callId } : {}),
          }
          input.pairing.dispatchByCallId.set(key, ref)
          // Call-window catalog candidate (step 1): the dispatch is recorded
          // and paired, so the ref exists to own the slot. Own catch scope —
          // a candidate-admission throw must not claim the (already
          // successful) pairing registration failed, and a missing live
          // Session / label simply admits no candidate. TEAM carriers are
          // excluded: their post-execute branch never marks a call-window
          // candidate (they start no child), so a reservation would sit inert
          // and permanently consume a slot.
          if (!teamTool) {
            try {
              reserveCatalogCandidate(input.pairing, ref, input.exec)
            } catch (error) {
              log('error', `catalog candidate reservation failed (contained — the dispatch record and pairing stand): ${errorMessage(error)}`)
            }
          }
        }
      }
    } catch (error) {
      // Own catch scope : a
      // pairing-registration throw must not claim the DISPATCH record failed
      // — the event was already appended successfully above.
      log('error', `pairing registration failed (contained — the dispatch record succeeded): ${errorMessage(error)}`)
    }
  } catch (error) {
    log('error', `dispatch record failed (contained — dispatch proceeds): ${errorMessage(error)}`)
  }
}

/**
 * Record one settle event. A paired settle writes through the same native
 * store generation retained by its dispatch, even if active workflow selection
 * changes. A direct unpaired call without a selected authority does not write.
 * Optional child/task identities are omitted when missing or invalid; the real
 * completion still records. Pairing identity fields are canonicalized and
 * retained so clients can match the settle to its dispatch.
 */
export function recordSettle(input: {
  harnessDir: string
  workflowId: string
  workflowDir: string
  agent?: string
  outcome: SettleOutcome
  durationMs?: number
  role?: string
  planId?: string
  taskId?: string
  childId?: string
  taskRef?: string
  /** The paired dispatch's tool-call id — the settle row's live-call identity (omitted when unknown). */
  callId?: string
  selectedGeneration: DshSelectedGeneration
}): void {
  try {
    const workflowDir = input.workflowDir
    if (workflowDir === undefined || workflowDir === '') {
      log('warn', 'settle record refused — cause: no gate-resolved ACTIVE workflow directory; recovery: retry through the gate after ACTIVE workflow authority is available')
      return
    }
    const childId = optionalLedgerId(input.childId)
    const taskRef = optionalLedgerId(input.taskRef)
    const callId = optionalLedgerId(input.callId)
    const event: AgentFlowEvent = {
      v: 1,
      ts: Date.now(),
      kind: 'settle',
      ...(input.agent !== undefined && input.agent.trim() !== '' ? { agent: input.agent } : {}),
      outcome: input.outcome,
      ...(input.durationMs !== undefined && Number.isFinite(input.durationMs) ? { durationMs: input.durationMs } : {}),
      ...(input.role !== undefined ? { role: normalizeRoleId(input.role) } : {}),
      ...(input.planId !== undefined && input.planId !== '' ? { planId: input.planId } : {}),
      ...(input.taskId !== undefined && input.taskId !== '' ? { taskId: input.taskId } : {}),
      ...(childId !== undefined ? { childId } : {}),
      ...(taskRef !== undefined ? { taskRef } : {}),
      // The call-scoped pairing identity rides the DURABLE row (the same id
      // the paired dispatch row carries) — exact pairing, not most-recent.
      ...(callId !== undefined ? { callId } : {}),
    }
    if (appendEvent(input.workflowId, event, callIdentity('settle', input.agent, input.callId), input.harnessDir, input.selectedGeneration)) {
      try {
        invalidator?.(input.harnessDir)
      } catch (error) {
        log('error', `catalog invalidation failed (contained): ${errorMessage(error)}`)
      }
    }
  } catch (error) {
    log('error', `settle record failed (contained): ${errorMessage(error)}`)
  }
}

/**
 * Atomically accept one verified native event, append its display row, and
 * advance the matching per-session scan bound.
 */
export function recordWorkflowEvent(input: {
  harnessDir: string
  workflowId: string
  workflowDir: string
  event: AgentFlowWorkflowEvent
  source: AgentFlowEventSource
  selectedGeneration: DshSelectedGeneration
}): boolean {
  if (input.workflowDir === '') return false
  if (!validEventSource(input.source)) {
    log('warn', 'workflow record refused — invalid verified session stream position; the row remains eligible')
    return false
  }
  const eventId = workflowEventId(input.event, input.source)
  const lineJson = ledgerLineOf(input.event, { eventId, source: input.source })
  const result = appendDshWorkflowEvent({ harnessDir: input.harnessDir }, {
    workflowId: input.workflowId,
    eventId,
    digest: digestOfLedgerLine(lineJson),
    lineJson,
    source: input.source,
    selectedGeneration: input.selectedGeneration,
  })
  if (result.kind === 'refused') {
    log('warn', `workflow record refused (${result.reason}); the row remains eligible`)
    return false
  }
  try {
    invalidator?.(input.harnessDir)
  } catch (error) {
    log('error', `catalog invalidation failed (contained): ${errorMessage(error)}`)
  }
  return true
}

/**
 * Input for {@link recordWorkflowVerdict} — one gated workflow/ralph call's
 * decision identity (verdict +
 * metaName/objective + mode).
 */
export interface WorkflowVerdictInput {
  /** The resolved `{HARNESS_DIR}` the row records into. */
  harnessDir: string
  /** The in-flight tool call (structural read for the carrying session id). */
  exec?: unknown
  /** The matched tool name (`'workflow'` | `'ralph'`). */
  tool: 'workflow' | 'ralph'
  /** `meta.name` for workflow calls (the P-a/P-c allowlist identity). */
  workflow?: string
  /** `objective` for ralph calls (the ralph identity). */
  objective?: string
  /** The effective `workflowGate` mode at decision time. */
  mode: WorkflowGateMode
  /** The gate verdict. */
  verdict: WorkflowVerdict
  /** The policy violation code (advisory/ask/denied rows only). */
  code?: string
  /** The authorized directory and original generation selected by the gate. */
  workflowId: string
  resolvedWorkflowDir: string
  selectedGeneration: DshSelectedGeneration
}

/**
 * Record one workflow/ralph gate verdict row . Fully
 * try/catch-contained — NEVER throws into the gate (`gateWorkflow` calls
 * this on EVERY policy decision); a failing record logs only
 * (`mstar/agent-flow`), so a ledger write never crashes or alters a
 * workflow call. The event is serialized lossless — optional fields
 * (`agent` / `workflow` / `objective` / `code`) omit when absent; the
 * display identity fields (`workflow` / `objective`) are capped at the
 * ledger boundary (same discipline as the W-B2 name cap) and the ralph
 * `objective` is routed through the SHARED `normalizeWorkflowName` strip at
 * this write boundary (— control-char discipline parity with the
 * name/label/phase fields; the gate already normalizes `workflow`). The
 * Persisted rows are JSON-serialized, so control characters cannot corrupt
 * the native ledger boundary; the panel view still normalizes hostile display
 * text. Malformed input is a caller bug — strict narrowing applies on READ,
 * never here.
 * @param input - the gate's decision identity (see {@link WorkflowVerdictInput}).
 */
export function recordWorkflowVerdict(input: WorkflowVerdictInput): void {
  try {
    // The async gate's selected workflow target and generation are required.
    const workflowDir = input.resolvedWorkflowDir
    if (workflowDir === '') {
      log('warn', 'workflow verdict record refused — empty gate-resolved workflow directory')
      return
    }
    const agent = input.exec !== undefined ? agentOfExec(input.exec) : undefined
    const callId = input.exec !== undefined ? callIdOf(input.exec) : undefined
    const event: AgentFlowEvent = {
      v: 1,
      ts: Date.now(),
      kind: 'workflow-verdict',
      ...(agent !== undefined ? { agent } : {}),
      tool: input.tool,
      ...(input.workflow !== undefined && input.workflow !== ''
        ? { workflow: truncateLedgerField(input.workflow, WORKFLOW_LEDGER_MAX_NAME_LENGTH) }
        : {}),
      ...(input.objective !== undefined && input.objective !== ''
        ? { objective: truncateLedgerField(normalizeWorkflowName(input.objective), WORKFLOW_LEDGER_MAX_NAME_LENGTH) }
        : {}),
      mode: input.mode,
      verdict: input.verdict,
      ...(input.code !== undefined && input.code !== '' ? { code: input.code } : {}),
    }
    if (appendEvent(input.workflowId, event, callIdentity('workflow-verdict', agent, callId), input.harnessDir, input.selectedGeneration)) {
      try {
        invalidator?.(input.harnessDir)
      } catch (error) {
        log('error', `catalog invalidation failed (contained): ${errorMessage(error)}`)
      }
    }
  } catch (error) {
    log('error', `workflow verdict record failed (contained — the gate proceeds): ${errorMessage(error)}`)
  }
}

/** Narrow one native JSON row to a valid v1 projected event (malformed rows → undefined). */
function eventFromUnknown(value: unknown): AgentFlowLedgerEvent | undefined {
  const rec = asRecord(value)
  if (rec === undefined || rec.v !== 1 || typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) return undefined
  const kind = rec.kind
  if (
    kind !== 'dispatch' &&
    kind !== 'settle' &&
    kind !== 'subagent-link' &&
    kind !== 'workflow-verdict' &&
    kind !== 'workflow-run' &&
    kind !== 'workflow-agent' &&
    kind !== 'workflow-run-end' &&
    // The projected unresolved-continuation marker (previously a
    // durable-only row the reader dropped, which left its dispatch as a
    // phantom running entity).
    kind !== 'continuation'
  ) {
    return undefined
  }
  const agent = typeof rec.agent === 'string' && rec.agent !== '' ? rec.agent : undefined
  if (kind === 'dispatch') {
    if (typeof rec.role !== 'string' || typeof rec.hard !== 'boolean') return undefined
    const verdict = rec.verdict
    if (verdict !== 'ok' && verdict !== 'advisory' && verdict !== 'denied') return undefined
    const callId = optionalLedgerId(rec.callId)
    return {
      v: 1,
      ts: rec.ts,
      kind: 'dispatch',
      ...(agent !== undefined ? { agent } : {}),
      role: rec.role,
      ...(typeof rec.planId === 'string' && rec.planId !== '' ? { planId: rec.planId } : {}),
      ...(typeof rec.taskId === 'string' && rec.taskId !== '' ? { taskId: rec.taskId } : {}),
      ...(typeof rec.taskCategory === 'string' && rec.taskCategory !== '' ? { taskCategory: rec.taskCategory } : {}),
      verdict,
      hard: rec.hard,
      // The call-scoped pairing identity follows the OMIT discipline (a
      // malformed/empty value drops, the row stays readable).
      ...(callId !== undefined ? { callId } : {}),
    }
  }
  if (kind === 'settle') {
    const outcome = rec.outcome
    if (outcome !== 'ok' && outcome !== 'error' && outcome !== 'denied') return undefined
    // Paired-dispatch identity:
    // `role` presence marks a PAIRED settle (kept even when '' — an
    // empty-role identity is still an identity); planId/taskId omit when empty.
    // The optional child identity (`childId` / `taskRef`) follows the OMIT
    // discipline — a malformed, empty, or oversized value is dropped while the
    // settle row itself stays readable (the row is defined by its outcome).
    const childId = optionalLedgerId(rec.childId)
    const taskRef = optionalLedgerId(rec.taskRef)
    const callId = optionalLedgerId(rec.callId)
    return {
      v: 1,
      ts: rec.ts,
      kind: 'settle',
      ...(agent !== undefined ? { agent } : {}),
      outcome,
      ...(typeof rec.durationMs === 'number' && Number.isFinite(rec.durationMs) ? { durationMs: rec.durationMs } : {}),
      ...(typeof rec.role === 'string' ? { role: rec.role } : {}),
      ...(typeof rec.planId === 'string' && rec.planId !== '' ? { planId: rec.planId } : {}),
      ...(typeof rec.taskId === 'string' && rec.taskId !== '' ? { taskId: rec.taskId } : {}),
      ...(childId !== undefined ? { childId } : {}),
      ...(taskRef !== undefined ? { taskRef } : {}),
      ...(callId !== undefined ? { callId } : {}),
    }
  }
  if (kind === 'subagent-link') {
    // The link row's REQUIRED identity: a valid bounded `childId`, plus the
    // required `role` / `label` the writer always emits. A missing, empty, or
    // oversized identity SKIPS this row (never a truncated or fabricated id);
    // the optional identity fields (`agent` / `planId` / `taskId` /
    // `taskRef`) omit when absent. Evaluated BEFORE the workflow-required
    // `runId` narrowing below — a link carries no `runId`.
    const childId = optionalLedgerId(rec.childId)
    if (childId === undefined) return undefined
    if (typeof rec.role !== 'string') return undefined
    if (typeof rec.label !== 'string' || rec.label === '') return undefined
    const taskRef = optionalLedgerId(rec.taskRef)
    return {
      v: 1,
      ts: rec.ts,
      kind: 'subagent-link',
      ...(agent !== undefined ? { agent } : {}),
      childId,
      label: truncateLedgerField(normalizeWorkflowName(rec.label), WORKFLOW_LEDGER_MAX_LABEL_LENGTH),
      role: rec.role,
      ...(typeof rec.planId === 'string' && rec.planId !== '' ? { planId: rec.planId } : {}),
      ...(typeof rec.taskId === 'string' && rec.taskId !== '' ? { taskId: rec.taskId } : {}),
      ...(taskRef !== undefined ? { taskRef } : {}),
    }
  }
  if (kind === 'continuation') {
    // The projected unresolved-continuation marker: the required
    // identity grammar is `role` ('' allowed — the dispatch row's grammar),
    // the SINGLE state value `unresolved`, and a non-empty display `reason`
    // (the writer always emits one — a hostile row lacking them is SKIPPED,
    // never guessed). Optional identity fields (`agent` / `planId` /
    // `taskId`) omit when absent; `reason` is re-capped at this read
    // boundary (same discipline as the link label). Evaluated BEFORE the
    // workflow narrowing below — a continuation carries no `runId`.
    if (rec.state !== 'unresolved') return undefined
    if (typeof rec.role !== 'string') return undefined
    if (typeof rec.reason !== 'string' || rec.reason === '') return undefined
    const callId = optionalLedgerId(rec.callId)
    return {
      v: 1,
      ts: rec.ts,
      kind: 'continuation',
      ...(agent !== undefined ? { agent } : {}),
      role: rec.role,
      ...(typeof rec.planId === 'string' && rec.planId !== '' ? { planId: rec.planId } : {}),
      ...(typeof rec.taskId === 'string' && rec.taskId !== '' ? { taskId: rec.taskId } : {}),
      state: 'unresolved',
      reason: truncateLedgerField(normalizeWorkflowName(rec.reason), WORKFLOW_LEDGER_MAX_LABEL_LENGTH),
      // The paired dispatch's call-scoped identity follows the OMIT discipline.
      ...(callId !== undefined ? { callId } : {}),
    }
  }
  if (kind === 'workflow-verdict') {
    // Gate verdict rows: the
    // tool / mode / verdict are vocabulary-validated; the per-tool identity
    // (`workflow` for workflow calls, `objective` for ralph) must be a
    // non-empty string (the producer's invariant — the gate records a row
    // only for shape-valid inputs); `agent` / `code` omit when absent.
    // Display identity fields (`workflow` / `objective`) are capped
    // deterministically (same W-B2 discipline — a hostile multi-MB
    // `objective` must not defeat the line-count truncation or reach the
    // panel unbounded).
    if (rec.tool !== 'workflow' && rec.tool !== 'ralph') return undefined
    const mode = rec.mode
    if (mode !== 'off' && mode !== 'warn' && mode !== 'ask' && mode !== 'hard') return undefined
    const verdict = rec.verdict
    if (verdict !== 'ok' && verdict !== 'advisory' && verdict !== 'denied' && verdict !== 'ask') return undefined
    if (rec.tool === 'workflow') {
      if (typeof rec.workflow !== 'string' || rec.workflow === '') return undefined
    } else if (typeof rec.objective !== 'string' || rec.objective === '') {
      return undefined
    }
    return {
      v: 1,
      ts: rec.ts,
      kind: 'workflow-verdict',
      ...(agent !== undefined ? { agent } : {}),
      tool: rec.tool,
      ...(typeof rec.workflow === 'string' && rec.workflow !== ''
        ? { workflow: truncateLedgerField(rec.workflow, WORKFLOW_LEDGER_MAX_NAME_LENGTH) }
        : {}),
      ...(typeof rec.objective === 'string' && rec.objective !== ''
        ? { objective: truncateLedgerField(rec.objective, WORKFLOW_LEDGER_MAX_NAME_LENGTH) }
        : {}),
      mode,
      verdict,
      ...(typeof rec.code === 'string' && rec.code !== '' ? { code: rec.code } : {}),
    }
  }
  // Workflow kinds. `runId` is
  // REQUIRED non-empty on all three (upstream stringId — `tool-workflow`'s
  // invariant contract); `agent` (workflow-run only) and `phase`
  // (workflow-agent only) omit when absent — lossless at the read boundary
  // too. Positional invariants (post-end updates, duplicate member seq) are
  // the CONSUMER's job — the ledger persists what it sees.
  //
  // Length caps : id-sized fields (`runId`, `childId`)
  // SKIP the row when oversized (never truncated into collisions); display
  // fields (`name`, `label`, `phase`) are capped deterministically — a
  // multi-MB line written by an older producer must not defeat the
  // line-count truncation or reach the panel unbounded. Member `seq` must
  // be an integer in [1, 2^31) (— upstream `memberSeq` positive
  // safe integer; fractional values corrupt consumer cursor math).
  if (typeof rec.runId !== 'string' || rec.runId === '' || rec.runId.length > WORKFLOW_LEDGER_MAX_ID_LENGTH) return undefined
  if (kind === 'workflow-run') {
    if (typeof rec.name !== 'string' || rec.name === '') return undefined
    return {
      v: 1,
      ts: rec.ts,
      kind: 'workflow-run',
      ...(agent !== undefined ? { agent } : {}),
      runId: rec.runId,
      name: truncateLedgerField(rec.name, WORKFLOW_LEDGER_MAX_NAME_LENGTH),
    }
  }
  if (kind === 'workflow-agent') {
    if (
      typeof rec.seq !== 'number' ||
      !Number.isInteger(rec.seq) ||
      rec.seq < 1 ||
      rec.seq >= WORKFLOW_LEDGER_MAX_SEQ
    ) {
      return undefined
    }
    if (typeof rec.label !== 'string' || rec.label === '') return undefined
    if (typeof rec.childId !== 'string' || rec.childId === '' || rec.childId.length > WORKFLOW_LEDGER_MAX_ID_LENGTH) return undefined
    return {
      v: 1,
      ts: rec.ts,
      kind: 'workflow-agent',
      runId: rec.runId,
      seq: rec.seq,
      label: truncateLedgerField(rec.label, WORKFLOW_LEDGER_MAX_LABEL_LENGTH),
      ...(typeof rec.phase === 'string' ? { phase: truncateLedgerField(rec.phase, WORKFLOW_LEDGER_MAX_LABEL_LENGTH) } : {}),
      childId: rec.childId,
    }
  }
  const stopReason = rec.stopReason
  if (stopReason !== 'completed' && stopReason !== 'cancelled' && stopReason !== 'error') return undefined
  return {
    v: 1,
    ts: rec.ts,
    kind: 'workflow-run-end',
    runId: rec.runId,
    stopReason,
  }
}

/** Map one ledger event to its catalog view (settle rows carry the paired identity when present). */
function eventView(event: AgentFlowLedgerEvent): AgentFlowEventView | AgentFlowContinuationEventView {
  if (event.kind === 'dispatch') {
    return {
      ts: event.ts,
      kind: 'dispatch',
      agent: event.agent ?? null,
      role: event.role,
      planId: event.planId ?? null,
      taskId: event.taskId ?? null,
      taskCategory: event.taskCategory ?? null,
      ...(event.verdict !== undefined ? { verdict: event.verdict } : {}),
      ...(event.hard !== undefined ? { hard: event.hard } : {}),
      ...(event.callId !== undefined ? { callId: event.callId } : {}),
    }
  }
  if (event.kind === 'workflow-run') {
    return {
      ts: event.ts,
      kind: 'workflow-run',
      agent: event.agent ?? null,
      role: '',
      planId: null,
      taskId: null,
      taskCategory: null,
      runId: event.runId,
      name: event.name,
    }
  }
  if (event.kind === 'workflow-agent') {
    return {
      ts: event.ts,
      kind: 'workflow-agent',
      agent: null,
      role: '',
      planId: null,
      taskId: null,
      taskCategory: null,
      runId: event.runId,
      seq: event.seq,
      label: event.label,
      ...(event.phase !== undefined ? { phase: event.phase } : {}),
      childId: event.childId,
    }
  }
  if (event.kind === 'workflow-run-end') {
    return {
      ts: event.ts,
      kind: 'workflow-run-end',
      agent: null,
      role: '',
      planId: null,
      taskId: null,
      taskCategory: null,
      runId: event.runId,
      stopReason: event.stopReason,
    }
  }
  if (event.kind === 'workflow-verdict') {
    return {
      ts: event.ts,
      kind: 'workflow-verdict',
      agent: event.agent ?? null,
      role: '',
      planId: null,
      taskId: null,
      taskCategory: null,
      tool: event.tool,
      ...(event.workflow !== undefined ? { workflow: event.workflow } : {}),
      ...(event.objective !== undefined ? { objective: event.objective } : {}),
      mode: event.mode,
      verdict: event.verdict,
      ...(event.code !== undefined ? { code: event.code } : {}),
    }
  }
  if (event.kind === 'subagent-link') {
    // Explicit branch BEFORE the settle fallback: a link is NOT a completion,
    // so it keeps its own identity fields and carries none of the settle
    // markers (`outcome` / `durationMs` / the `paired` presence flag). Its
    // `taskCategory` is null — the link's identity is the DISPATCH's
    // (role/planId/taskId), and no new pairing algorithm is introduced.
    return {
      ts: event.ts,
      kind: 'subagent-link',
      agent: event.agent ?? null,
      role: event.role,
      planId: event.planId ?? null,
      taskId: event.taskId ?? null,
      taskCategory: null,
      label: event.label,
      childId: event.childId,
      ...(event.taskRef !== undefined ? { taskRef: event.taskRef } : {}),
    }
  }
  if (event.kind === 'continuation') {
    // Explicit branch BEFORE the settle fallback (the unresolved-continuation
    // projection): a continuation
    // is NOT a completion — it keeps the paired dispatch identity (the same
    // fields a dispatch row rides) and carries its own facts (`state` +
    // `reason`); no outcome, no verdict, no settle markers.
    return {
      ts: event.ts,
      kind: 'continuation',
      agent: event.agent ?? null,
      role: event.role,
      planId: event.planId ?? null,
      taskId: event.taskId ?? null,
      taskCategory: null,
      callId: event.callId ?? null,
      state: event.state,
      reason: event.reason,
    }
  }
  return {
    ts: event.ts,
    kind: 'settle',
    agent: event.agent ?? null,
    role: event.role ?? '',
    planId: event.planId ?? null,
    taskId: event.taskId ?? null,
    taskCategory: null,
    // Presence marker: a PAIRED settle (carries the dispatch identity) — the
    // client pairs on it (legacy unpaired settles stay unpaired, honest).
    ...(event.role !== undefined ? { paired: true } : {}),
    ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    // Optional child identity — omitted (never undefined-valued) when the
    // completion carried none.
    ...(event.childId !== undefined ? { childId: event.childId } : {}),
    ...(event.taskRef !== undefined ? { taskRef: event.taskRef } : {}),
    ...(event.callId !== undefined ? { callId: event.callId } : {}),
  }
}

/** Role × outcome counts of a bounded latest-first event window (count desc). */
function summaryOf(events: readonly AgentFlowLedgerEvent[]): AgentFlowSummaryRow[] {
  const counts = new Map<string, number>()
  for (const event of events) {
    // Workflow kinds count as a DISTINCT bucket — a
    // dedicated `workflow` pseudo-role, never folded into the
    // dispatch-role counts (replaces the Task-2 stopgap role=''
    // kind-bucket). The outcome is the STABLE kind name for run / member /
    // run-end rows (so they stay distinguishable in the summary) and the
    // VERDICT for the gate's `workflow-verdict` rows (`ok`/`advisory`/
    // `denied`/`ask` — the model-visible gate surface); every event lands
    // in exactly one bucket (the role×outcome sum = the window's event
    // count).
    // `subagent-link` rows keep the DISPATCH's role and bucket under the
    // literal `subagent-link` outcome — an identity signal that is neither a
    // dispatch nor a settle (no overlap with the dispatch-verdict or
    // settle-outcome buckets).
    // A `continuation` row is neither a dispatch nor a settlement activity:
    // it lands in its own literal outcome bucket under the EMPTY role — the
    // model line folds the role×outcome summary only over dispatch/settle
    // ACTIVITY (the `role === ''` rows are excluded there), while the
    // structured summary keeps the row count honest (the role×outcome sum =
    // the window's event count invariant holds).
    const role =
      event.kind === 'dispatch' || event.kind === 'subagent-link' ? event.role
      : event.kind === 'workflow-run' || event.kind === 'workflow-agent' || event.kind === 'workflow-run-end' || event.kind === 'workflow-verdict'
        ? 'workflow'
        : ''
    const outcome =
      event.kind === 'dispatch' ? event.verdict
      : event.kind === 'workflow-verdict' ? event.verdict
      : event.kind === 'settle' ? event.outcome
      : event.kind
    const key = `${role}\u0000${outcome}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [role, outcome] = key.split('\u0000')
      return { role: role!, outcome: outcome!, count }
    })
    // count desc; ties break deterministically (role, then outcome) so the
    // summary is stable for consumers (the model line / panel).
    .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role) || a.outcome.localeCompare(b.outcome))
}

/** Read the latest native event window; workflowId is the selected machine identity. */
export function readAgentFlow(workflowDir: string, workflowId: string, limit?: number, harnessDir = dirname(dirname(workflowDir))): AgentFlowView | null {
  const n = limit === undefined ? AGENT_FLOW_DEFAULT_LIMIT : Math.max(0, Math.floor(limit))
  const lines = readDshLedgerWindow({ harnessDir }, workflowId, n)
  if (lines === null) return null
  const events: AgentFlowLedgerEvent[] = []
  for (const line of lines) {
    try {
      const event = eventFromUnknown(JSON.parse(line) as unknown)
      if (event !== undefined) events.push(event)
    } catch {
      continue
    }
  }
  // The continuation view (the unresolved-continuation projection) is a member
  // of the exported union: `AgentFlowView.events` carries the full projected
  // element union (dispatch/settle/workflow/link AND `continuation`), so this
  // return type-checks WITHOUT a cast — the compiler itself pins the contract
  // that the runtime emission never outruns the exported shape.
  return { events: events.map(eventView), summary: summaryOf(events) }
}

/* ---------------------------------- settle (real completion pairing) ---------------------------------- */

/**
 * Record a settle carrying a PAIRED dispatch's identity (plan
 * the settle-pairing upgrade): the harness dir + agent + identity
 * come from the dispatchRef (the apply-scoped pairing store) — never probed
 * from a payload. `role` is always written (the dispatchRef always carries
 * it, possibly ''); planId/taskId omit when absent — the same field
 * names + semantics as the dispatch event. The optional child identity is
 * the OBSERVED `childId` argument when the completion supplied one (the
 * child `subagent/end` settlement's id), else the ref's own `childId` (a
 * background catalog join copied it there); the ref's `taskRef` (a background settle's registry
 * job id) rides along. `recordSettle` applies the optional-id length gate, so
 * an invalid or oversized identity is omitted rather than truncated.
 * @param childId - the child session id the completion itself returned, when it carried one.
 */
function recordSettleWithRef(ref: AgentFlowDispatchRef, outcome: SettleOutcome, durationMs: number | undefined, childId?: string): void {
  const settleChildId = childId ?? ref.childId
  recordSettle({
    harnessDir: ref.harnessDir,
    workflowId: ref.workflowId,
    workflowDir: ref.workflowDir,
    ...(ref.callId !== undefined ? { callId: ref.callId } : {}),
    ...(ref.agent !== undefined && ref.agent.trim() !== '' ? { agent: ref.agent } : {}),
    outcome,
    ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
    role: ref.role,
    ...(ref.planId !== undefined ? { planId: ref.planId } : {}),
    ...(ref.taskId !== undefined ? { taskId: ref.taskId } : {}),
    ...(settleChildId !== undefined ? { childId: settleChildId } : {}),
    ...(ref.taskRef !== undefined ? { taskRef: ref.taskRef } : {}),
    selectedGeneration: ref.selectedGeneration,
  })
}

/**
 * The child pairing map (subagent activation), created LAZILY on
 * the apply-scoped pairing store (existing pairing constructors keep working
 * unchanged). It is consumed by the child's `subagent/end` settlement and
 * bounded by {@link AGENT_FLOW_TEAM_CHILD_CAPACITY}.
 */
function teamChildPairs(pairing: AgentFlowPairing): Map<string, AgentFlowDispatchRef> {
  return (pairing.teamDispatchByChildId ??= new Map())
}

/**
 * Record one EXPLICIT unresolved-continuation row for a team dispatch whose
 * completion cannot be paired. This is a NONTERMINAL ledger row (kind
 * `continuation`, state `unresolved`): it carries the paired dispatch identity
 * so a reader can attribute it, and it is NEVER a settle — no outcome, no
 * verdict, no fabricated completion. `reason` is display text and therefore
 * normalized (ASCII control chars stripped) and capped at the ledger label
 * bound. Contained: a failing append logs and never escapes the tool seam.
 */
function recordContinuationUnresolved(ref: AgentFlowDispatchRef, reason: string): void {
  try {
    const normalized = truncateLedgerField(normalizeWorkflowName(reason), WORKFLOW_LEDGER_MAX_LABEL_LENGTH)
    const displayReason = normalized === '' ? 'unresolved continuation' : normalized
    const event: AgentFlowContinuationEvent = {
      v: 1,
      ts: Date.now(),
      kind: 'continuation',
      ...(ref.agent !== undefined && ref.agent.trim() !== '' ? { agent: ref.agent } : {}),
      role: ref.role,
      ...(ref.planId !== undefined && ref.planId !== '' ? { planId: ref.planId } : {}),
      ...(ref.taskId !== undefined && ref.taskId !== '' ? { taskId: ref.taskId } : {}),
      state: 'unresolved',
      reason: displayReason,
      // The paired dispatch's call id rides the durable row — the call-scoped
      // pairing identity a reader attributes this row with (a continuation of
      // an EARLIER same-identity dispatch is never attributed to the later one).
      ...(ref.callId !== undefined && ref.callId.trim() !== '' ? { callId: ref.callId } : {}),
    }
    if (appendEvent(ref.workflowId, event, callIdentity('continuation', ref.agent, ref.callId), ref.harnessDir, ref.selectedGeneration)) {
      try {
        invalidator?.(ref.harnessDir)
      } catch (error) {
        log('error', `catalog invalidation failed (contained): ${errorMessage(error)}`)
      }
      log('warn', `team dispatch continuation unresolved (${ref.agent ?? 'no session'}): ${displayReason} — no settle is fabricated`)
    }
  } catch (error) {
    log('error', `continuation record failed (contained): ${errorMessage(error)}`)
  }
}

/**
 * The explicit unresolved continuation for a child end whose stop reason is
 * outside the settled vocabulary. Shared by the live path
 * ({@link handleActivationChildSettled}) and the reconcile path
 * ({@link pairActivationChildRef}) so the two can never drift.
 */
function recordChildStopUnresolved(ref: AgentFlowDispatchRef, childId: string, stopReason: unknown): void {
  recordContinuationUnresolved(
    ref,
    `subagent/end for child ${childId} carried an unrecognized stop reason (${String(stopReason)}) — no settle is fabricated`,
  )
}

/**
 * How many recorded dispatches of one direct parent Session are still in
 * flight and may yet claim a child end: the calls not yet post-executed (the
 * child is published INSIDE the tool call, so its end can precede
 * `tools/post-execute`), plus the activation dispatches whose name→child
 * resolution has not landed. This is the WINDOW test, not a bound on the store:
 * a record is admitted and kept while a ref of its scope may still arrive, and
 * dropped once the count reaches `0` ({@link sweepUnclaimableChildEnds}).
 * It is NOT an upper bound on the records held: only an ACTIVATION ref can pair
 * (a child id must match), and a call that starts no activation child leaves a
 * record no ref can ever claim, so counting that leftover against a waiting
 * ref's chance would drop a genuine early end (its capacity bound is
 * {@link AGENT_FLOW_ACTIVATION_END_CAPACITY}). `undefined` counts EVERY
 * in-flight ref of the pairing — the lifetime test for a record whose payload
 * carried no parent (an unparented record has no narrower scope).
 */
function claimableDispatchesOf(pairing: AgentFlowPairing, parentSessionId: string | undefined): number {
  let claimable = 0
  for (const ref of pairing.dispatchByCallId.values()) {
    if (parentSessionId === undefined || ref.agent === parentSessionId) claimable += 1
  }
  for (const ref of pairing.activationResolutions ?? []) {
    if (parentSessionId === undefined || ref.agent === parentSessionId) claimable += 1
  }
  return claimable
}

/**
 * Drop the buffered child ends whose pairing can no longer arrive: once a
 * parent has no in-flight dispatch left, nothing can consume its records, so
 * keeping them would only spend the budget of a LATER window. Called at every
 * point where a window closes (a call's post-execute or team return, a name
 * resolution landing or failing, and an end arriving for an already-closed
 * window) — this is the eviction that closes the interleaving where a
 * permanently unclaimable record refused the next genuine early end and lost
 * its settle. Safe to call anywhere: it only removes records that are already
 * dead. Contained.
 */
function sweepUnclaimableChildEnds(pairing: AgentFlowPairing): void {
  const ends = pairing.endsAwaitingActivation
  if (ends === undefined || ends.size === 0) return
  try {
    for (const [childId, record] of ends) {
      if (claimableDispatchesOf(pairing, record.parentSessionId) === 0) ends.delete(childId)
    }
  } catch (error) {
    log('error', `activation child end sweep failed (contained): ${errorMessage(error)}`)
  }
}

/**
 * Keep one child `subagent/end` that arrived before its activation pairing was
 * keyed. Admission is PER DIRECT PARENT and deliberately narrow: a record is
 * kept only while its own parent still has a dispatch in flight — never past
 * that window — but the count is NOT bounded by the parent's in-flight refs. A
 * record no ref can ever claim (a re-woken child's end, a non-Assignment
 * `subagent` child, a `workflow agent()` child) is a legitimate leftover, and
 * bounding the store by the ref count would make it spend the chance of a
 * genuine early end whose ref is still waiting. The one bound is the per-scope
 * capacity {@link AGENT_FLOW_ACTIVATION_END_CAPACITY}: at capacity the OLDEST
 * record of the scope is replaced by an eviction marker, so the dispatch that
 * would have claimed it records the explicit unresolved continuation (the warn
 * names that consequence) instead of a silent loss. Nothing is settled here: an
 * unkeyed end carries no dispatch identity, so no outcome can be fabricated for
 * it. Contained — never throws into the `subagent/end` event.
 */
function bufferActivationChildEnd(pairing: AgentFlowPairing, parentSessionId: string | undefined, childId: string, stopReason: unknown): void {
  try {
    const ends = (pairing.endsAwaitingActivation ??= new Map<string, ActivationChildEndRecord>())
    // The FIRST end belongs to this activation: it is the turn the creating
    // dispatch started. A later end comes from a `send_message` that woke the
    // same child, and settling the creating dispatch from that later turn would
    // report another turn's outcome (e.g. `error` for an `ok` first turn). An
    // eviction marker is the one record a real end may replace — it carries no
    // outcome of its own.
    // The FIRST end belongs to this activation: it is the turn the creating
    // dispatch started. A later end comes from a `send_message` that woke the
    // same child, and settling the creating dispatch from that later turn would
    // report another turn's outcome (e.g. `error` for an `ok` first turn). An
    // eviction marker is the one record a real end may replace — it carries no
    // outcome of its own.
    const existing = ends.get(childId)
    if (existing !== undefined && existing.evicted !== true) return
    if (existing !== undefined) ends.delete(childId)
    sweepUnclaimableChildEnds(pairing)
    // No dispatch of this scope in flight → no ref can ever claim the record.
    if (claimableDispatchesOf(pairing, parentSessionId) === 0) return
    // Capacity is per scope and counts only live records (an eviction marker
    // holds no slot); the OLDEST live record is the one evicted.
    let owned = 0
    let oldest: string | undefined
    for (const [id, record] of ends) {
      if (record.parentSessionId !== parentSessionId || record.evicted === true) continue
      owned += 1
      oldest ??= id
    }
    if (owned >= AGENT_FLOW_ACTIVATION_END_CAPACITY && oldest !== undefined) {
      const evicted = ends.get(oldest)
      ends.set(oldest, {
        ...(evicted?.parentSessionId !== undefined ? { parentSessionId: evicted.parentSessionId } : {}),
        stopReason: evicted?.stopReason,
        evicted: true,
      })
      log(
        'warn',
        `child end for ${oldest} was evicted at the early-end capacity (${String(AGENT_FLOW_ACTIVATION_END_CAPACITY)} records per parent) before its activation pairing was keyed — the dispatch that created it records an explicit unresolved continuation instead of a settle`,
      )
    }
    ends.set(childId, { ...(parentSessionId !== undefined ? { parentSessionId } : {}), stopReason })
  } catch (error) {
    log('error', `activation child end buffer insert failed (contained): ${errorMessage(error)}`)
  }
}

/**
 * Pair one activation dispatch with the child `SessionId` its returned name
 * resolved to. RECONCILE FIRST: the child's end may have arrived while that
 * resolution was in flight and been kept by
 * {@link bufferActivationChildEnd} — on a hit the dispatch settles from that
 * record through the SAME outcome mapping as the live path
 * (`completed→ok`, `aborted/refusal→denied`, `error/max-tokens→error`,
 * unrecognized → explicit unresolved continuation) and NO live pairing entry
 * is written (the record is consumed, so the dispatch can never settle
 * twice). An EVICTION marker is a hit with no outcome to map: the ref records
 * the explicit unresolved continuation naming the capacity, never a pairing
 * whose settle can no longer arrive. Otherwise the ref is keyed by child id and
 * the child's own `subagent/end` settles it; at capacity the OLDEST pairing is
 * evicted with an explicit unresolved-continuation row for its dispatch — a
 * bounded map never drops a pairing silently. The ref also carries the
 * resolved child id
 * so the eventual settle names the child.
 */
function pairActivationChildRef(pairing: AgentFlowPairing, childId: string, ref: AgentFlowDispatchRef): void {
  const ends = pairing.endsAwaitingActivation
  const buffered = ends?.get(childId)
  if (buffered !== undefined) ends?.delete(childId)
  ref.childId = childId
  if (buffered?.evicted === true) {
    recordContinuationUnresolved(
      ref,
      `the child end for ${childId} was evicted at the early-end capacity (${String(AGENT_FLOW_ACTIVATION_END_CAPACITY)} records per parent) before this dispatch was paired — its continuation cannot be reconciled, no settle is fabricated`,
    )
    return
  }
  if (buffered !== undefined) {
    const outcome = settleOutcomeOfStopReason(buffered.stopReason)
    if (outcome === undefined) {
      recordChildStopUnresolved(ref, childId, buffered.stopReason)
      return
    }
    recordSettleWithRef(ref, outcome, undefined, childId)
    return
  }
  const map = teamChildPairs(pairing)
  if (map.has(childId)) {
    // First pairing wins; the second dispatch gets the explicit marker instead
    // of a silence no later event can repair (the child's end already fired).
    recordContinuationUnresolved(
      ref,
      `the activation child ${childId} is already paired with another dispatch — this dispatch's continuation cannot be paired (first pairing wins)`,
    )
    return
  }
  if (map.size >= AGENT_FLOW_TEAM_CHILD_CAPACITY) {
    const oldestKey = map.keys().next().value
    if (oldestKey !== undefined) {
      const evicted = map.get(oldestKey)
      map.delete(oldestKey)
      if (evicted !== undefined) {
        recordContinuationUnresolved(
          evicted,
          `activation child pairing capacity reached (${String(AGENT_FLOW_TEAM_CHILD_CAPACITY)} slots) — the oldest pairing was evicted before its child turn completed`,
        )
      }
    }
  }
  map.set(childId, ref)
}

/**
 * Confirm that a resolved activation id is a DIRECT child of the dispatching
 * session before it is keyed as a pairing. The installed surface's
 * `resolveName` ECHOES a bare token it could not match (a Session id-shaped
 * string, `lead` → the tree root, or an id from another tree), so a returned
 * id is not by itself a child that can ever emit `subagent/end`: keying one
 * would leave its dispatch with neither a settle nor a marker. POSITIVE
 * evidence only — a read that fails or is unavailable confirms nothing and the
 * pairing proceeds exactly as before, so a degraded catalog read never becomes
 * a lost settle by itself.
 * shortcut: one call walks the whole subtree (listDescendants is the only
 * catalog read on the structural surface); switch to a direct-children surface
 * when upstream exposes one.
 */
async function isDirectChildOf(
  surface: SubagentSurface | undefined,
  parentSessionId: string | undefined,
  childId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (surface === undefined || parentSessionId === undefined) return true
  try {
    const rows = await surface.listDescendants(parentSessionId, signal)
    if (!Array.isArray(rows)) return true
    for (const row of rows) {
      const rec = asRecord(row)
      if (rec?.id !== childId) continue
      return rec?.parentId === parentSessionId
    }
    return false
  } catch {
    return true
  }
}

/**
 * Pair one activation dispatch with the child session its returned name
 * resolves to. The subagent surface reads are ASYNC, so the window is entered
 * BEFORE they start and left only after the resolved id is CONFIRMED to be a
 * direct child of this session ({@link isDirectChildOf}): until then, an end
 * for that child is kept by {@link bufferActivationChildEnd} and reconciled by
 * {@link pairActivationChildRef} — the tool return itself settles nothing. The
 * window is left exactly once (confirmed, name unresolvable, unconfirmed id, or
 * read failed), so one dispatch can never pair twice and the reconcile store
 * never outlives the resolutions that can consume it. A missing, unresolvable
 * or unconfirmed name records the explicit unresolved continuation instead, and
 * every close point sweeps the records whose window just shut
 * ({@link sweepUnclaimableChildEnds}). Fully contained: the floating
 * resolution never rejects into the tool seam.
 */
function pairActivationChild(input: {
  ctx: TeamServiceContext
  pairing: AgentFlowPairing
  exec: unknown
  ref: AgentFlowDispatchRef
  name: string | undefined
}): void {
  const { ctx, pairing, ref, name } = input
  const parentSessionId = ref.agent !== undefined && ref.agent !== '' ? ref.agent : undefined
  if (name === undefined) {
    recordContinuationUnresolved(ref, 'the activation result carried no child name — its child session cannot be resolved')
    sweepUnclaimableChildEnds(pairing)
    return
  }
  const execRec = asRecord(input.exec)
  const signal = execRec?.signal instanceof AbortSignal ? execRec.signal : undefined
  const surface = subagentSurfaceOf(ctx)
  // Enter the window BEFORE the async reads: a child end that lands while the
  // name resolves and the resolved id is confirmed is admitted against this ref
  // and reconciled below.
  const resolutions = (pairing.activationResolutions ??= new Set<AgentFlowDispatchRef>())
  resolutions.add(ref)
  void resolveMemberId(surface, execRec?.agent, name, signal)
    .then(async (resolved) => {
      const childId = resolved !== undefined && (await isDirectChildOf(surface, parentSessionId, resolved, signal)) ? resolved : undefined
      resolutions.delete(ref)
      if (childId === undefined) {
        recordContinuationUnresolved(
          ref,
          resolved === undefined
            ? `the activation child "${name}" is not resolvable to a child session — its turn completion is unknown`
            : `the activation name "${name}" resolved to ${resolved}, which is not a child of this session — no child turn can settle this dispatch`,
        )
      } else {
        pairActivationChildRef(pairing, childId, ref)
      }
      sweepUnclaimableChildEnds(pairing)
    })
    .catch((error: unknown) => {
      resolutions.delete(ref)
      sweepUnclaimableChildEnds(pairing)
      log('error', `activation child pairing failed (contained): ${errorMessage(error)}`)
    })
}

/**
 * The Agent Teams half of the `tools/post-execute` seam. After rc.3 the Team
 * channel is the shared task board plus the inbox: `team_task_create`,
 * `team_task_update` and `send_message` are the only carriers, and none of
 * them is a delegation completion (a board write records coordination, an
 * inbox acceptance only means the target accepted the message). A team carrier
 * that produced a dispatch record is therefore NEVER settled at tool return;
 * the branch:
 *
 * - consumes the agent-namespaced call key in EVERY path (the map holds only
 *   in-flight calls), so team calls cannot grow it without bound and a later
 *   same-id call from another channel can never settle this ref (the key also
 *   carries the tool name);
 * - a failed call settles `error` — the call provably did not land;
 * - every other shape records the explicit unresolved continuation stating
 *   that the carrier is not a delegation completion.
 *
 * Fully contained — the post-execute waterfall must always reach `next()`.
 */
function handleTeamPostExecute(input: {
  pairing: AgentFlowPairing
  exec: unknown
  name: string
  result: unknown
}): void {
  const { pairing, name } = input
  const key = callPairingKey(input.exec)
  if (key === undefined) return
  const dispatchRef = pairing.dispatchByCallId.get(key)
  try {
    if (dispatchRef === undefined) return
    const resultRec = asRecord(input.result)
    if (resultRec === undefined) {
      recordContinuationUnresolved(dispatchRef, `the ${name} call returned no result payload — its continuation cannot be paired`)
      return
    }
    if (resultRec.isError === true || resultRec.error !== undefined) {
      // The call itself failed: a REAL terminal, not a fabricated `ok`.
      recordSettleWithRef(dispatchRef, 'error', undefined)
      return
    }
    recordContinuationUnresolved(
      dispatchRef,
      `the ${name} carrier returned without a delegation completion — a task-board write and an inbox acceptance are not delegation completions`,
    )
  } finally {
    // The call is CONSUMED on every team path — never leave a team ref in the
    // call map (unbounded growth / false cross-call settle). Closing the window
    // also retires any child end that was only waiting for THIS ref.
    pairing.dispatchByCallId.delete(key)
    sweepUnclaimableChildEnds(pairing)
  }
}

/**
 * The child-turn settlement half: `subagent/end` for a paired child completes
 * the dispatch that created it. A teammate is an ordinary continuable subagent
 * child whose initial turn settlement carries the child id and the terminal
 * stop reason, so this row is a REAL completion (mapped outcome) rather than a
 * tool-return guess. A pairing-map hit consumes the entry and settles; a miss
 * means the end beat its activation pairing write (the child is published
 * inside the tool call, so its end can precede `tools/post-execute` or the
 * async name resolution), and the record is kept for that reconcile
 * ({@link bufferActivationChildEnd}) — never dropped silently, and stored only
 * while a dispatch of the child's direct parent (for a payload that carried
 * none, of the whole pairing) is still in flight: a closed window admits
 * nothing.
 * An unrecognized stop reason records the explicit unresolved continuation —
 * never a guessed outcome. Contained: a throwing handler never escapes the
 * session/tool event.
 */
function handleActivationChildSettled(pairing: AgentFlowPairing, info: unknown): void {
  const rec = asRecord(info)
  const childId = rec?.id
  if (typeof childId !== 'string' || childId === '') return
  const map = pairing.teamDispatchByChildId
  const ref = map?.get(childId)
  if (map === undefined || ref === undefined) {
    // A payload without a parent id is NOT a reason to drop the end: it is
    // admitted unscoped and lifetime-tested against the whole pairing.
    const parentSessionId = rec?.parentSessionId
    bufferActivationChildEnd(
      pairing,
      typeof parentSessionId === 'string' && parentSessionId !== '' ? parentSessionId : undefined,
      childId,
      rec?.stopReason,
    )
    return
  }
  // Consumed once: the child's initial turn is the dispatch's continuation; a
  // later re-woken turn of the same child is a new (unrecorded) message.
  map.delete(childId)
  const outcome = settleOutcomeOfStopReason(rec?.stopReason)
  if (outcome === undefined) {
    recordChildStopUnresolved(ref, childId, rec?.stopReason)
  } else {
    recordSettleWithRef(ref, outcome, undefined, childId)
  }
  // The pairing this window could claim is consumed: retire any end still
  // waiting on a dispatch that will never arrive.
  sweepUnclaimableChildEnds(pairing)
}

/**
 * The `tools/post-execute` settle pairing : the VERIFIED
 * dsh-tools registry dispatches this seam for every tool call
 * (`runPostExecute` → `postExecute`, upstream source), so the listener only
 * decides whether a completion signal exists for the PAIRED dispatch:
 *
 * - non-dispatch tool (`exec.name` ∉ Config `dispatchTools` and ∉ the fixed
 *   {@link TEAM_DISPATCH_TOOLS} carriers) → nothing;
 * - dispatch tool whose agent-namespaced call key
 *   (the exact call identity) is not in the pairing
 *   store (HMR reset, host-hook dispatch, non-gate path) → nothing (warned
 *   once per registration — honest degrade, never fabricated settlement);
 * - `result.isError === true` OR an `error` payload present → settle `error`
 *   immediately (fabrication guard — the dispatch
 *   call failed; a result carrying `error` without `isError` never settles ok);
 * - `{ kind: 'activation', name }` (the installed dsh `subagent` /
 *   `subagent_fork` return — STARTED, not settled) → no settle at tool
 *   return; the activation pairing window opens, the returned name is resolved
 *   to the child `SessionId` through the subagent surface, and the child's
 *   `subagent/end` settles the dispatch through the keyed-by-child channel
 *   and outcome mapping; a missing or unresolvable name records the explicit
 *   unresolved continuation instead;
 * - the retired `{ kind: 'background', jobId }` / `{ kind: 'continuable',
 *   subagentId }` shapes → no rc.3 delegation tool produces them (both return
 *   `activation`), so they reach the seam only from a custom
 *   `Config.dispatchTools` entry; their pairing machinery stays wired and
 *   their own comments say so;
 * - any other successful value → the explicit unresolved continuation (the
 *   seam cannot attribute it to a child turn, so it never settles `ok`).
 * The consumed `dispatchByCallId` entry is DELETED after the branch resolves
 * the call (map pruning — each callId
 * pairs exactly once; the map holds only in-flight calls).
 *
 * Catalog candidate: the SAME branch retires the dispatch's reserved
 * call-window catalog candidate to its tombstone on every shape this seam
 * observes — activation (whose resolved child id arrives after this seam),
 * other success, tool error, missing result payload. Eligibility (the retired
 * background / continuable branches) is unreachable from rc.3's delegation
 * tools, so no candidate turns matchable and no `subagent-link` row is
 * emitted for an rc.3 delegation call. The retire helper is self-contained:
 * a throwing join degrades to a log line and NEVER costs the settle its row.
 *
 * The waterfall MUST be delegated via `next()` on every path — returning
 * without calling `next` bails the chain and breaks every tool call. A
 * throwing record never propagates.
 *
 * - a TEAM carrier ({@link TEAM_DISPATCH_TOOLS}) → the team branch
 *   ({@link handleTeamPostExecute}): the board/inbox carriers start no child,
 *   so they are never settled at tool return; every shape except a failed call
 *   records an explicit unresolved continuation, and the call key is always
 *   consumed.
 *
 * The SAME registration also observes `subagent/end` (the verified
 * continuable-child settlement edge) for the activation pairing: an
 * activation-created dispatch completes when its child's initial turn settles,
 * not when the creation call returns. An untagged registration at the plugin
 * apply observes every child edge upstream.
 *
 * Cordis typing note: `ctx.on` only accepts declared event keys and
 * `tools/post-execute` / `subagent/end` are not declared by this package's
 * imports — the registrations cast through the runtime-accepted event-name
 * string (the event bus dispatches any name).
 * @param ctx - registrant context (fiber disposal unwinds the listeners).
 * @param config - the plugin Config (dispatch-tool matching).
 * @param pairing - the apply-scoped pairing store (dispatchByCallId read and
 * consumed here, catalogBySession retired here, activationResolutions /
 * endsAwaitingActivation / teamDispatchByChildId maintained by the activation
 * pairing; no rc.3 delegation tool writes dispatchByJobId).
 */
export function registerSettleListener(ctx: Context, config: Config, pairing: AgentFlowPairing): void {
  const dispatchTools = config.dispatchTools ?? [...DEFAULT_DISPATCH_TOOLS]
  let unpairedWarned = false
  const listener = (exec: unknown, result: unknown, next?: () => unknown): unknown => {
    try {
      const execRec = asRecord(exec)
      const name = execRec === undefined ? undefined : execRec.name
      if (typeof name === 'string' && isTeamDispatchToolName(name)) {
        // Team carrier: its tool return is NOT a completion (an inbox
        // acceptance / a task-board write). The branch consumes the call key on
        // every path and records the explicit unresolved continuation.
        handleTeamPostExecute({ pairing, exec, name, result })
      } else if (typeof name !== 'string' || !dispatchTools.includes(name)) {
        // Non-dispatch tool call → no record (the waterfall still delegates below).
      } else {
        // Agent-namespaced call key : a raw callId is not
        // globally unique across sessions in one process — the session id in
        // the key keeps this settle from pairing into ANOTHER session's
        // dispatchRef. Same derivation as `recordDispatch` registration.
        const key = callPairingKey(exec)
        const dispatchRef = key !== undefined ? pairing.dispatchByCallId.get(key) : undefined
        if (dispatchRef === undefined) {
          // Dispatch tool with no paired call key (HMR reset / host-hook /
          // non-gate path) → honest no-settle; warned once per registration.
          if (!unpairedWarned) {
            unpairedWarned = true
            log('warn', `${SETTLE_SEAM} for dispatch tool "${name}" had no paired call key (${key ?? 'none'}) — no settle recorded (pairing window missed / HMR reset; honest degrade)`)
          }
        } else {
          const resultRec = asRecord(result)
          if (resultRec !== undefined) {
            const value = asRecord(resultRec.value)
            // Fabrication guard : a failed
            // result detected by EITHER the canonical `isError` flag OR an
            // `error` payload settles `error` — a result carrying `error`
            // without `isError: true` must NEVER settle a fabricated `ok`.
            if (resultRec.isError === true || resultRec.error !== undefined) {
              // The dispatch call itself failed → settle error, and the
              // call-window candidate is retired (a failed call authorizes
              // no child identity).
              retireCatalogCandidate(pairing, dispatchRef)
              recordSettleWithRef(dispatchRef, 'error', undefined)
            } else if (value !== undefined && value.kind === 'background') {
              if (typeof value.jobId === 'string' && value.jobId !== '') {
                // Background job started — the settled jobs event records completion.
                pairing.dispatchByJobId.set(value.jobId, dispatchRef)
                // Carry the registry job id onto the eventual settle. Bounded:
                // an oversized id omits the FIELD only — the pairing still keys
                // on the ORIGINAL id, so the real terminal still settles.
                const taskRef = optionalLedgerId(value.jobId)
                if (taskRef !== undefined) dispatchRef.taskRef = taskRef
                // The catalog candidate is now eligible, expecting the job's
                // ONE-SHOT catalog (this is the one-shot tool producer).
                advanceCatalogCandidate(pairing, dispatchRef, { kind: 'background', jobId: value.jobId })
              } else {
                // Background WITHOUT a valid jobId → nothing mappable
                // background result) — never a fabricated ok settle, and no
                // child identity to authorize.
                retireCatalogCandidate(pairing, dispatchRef)
              }
            } else if (value !== undefined && value.kind === 'continuable') {
              // Continuable child — no terminal signal this round → honest
              // no-settle; its `subagentId` is never copied onto a settle.
              // It DOES authorize the identity join, and only for the exact
              // child the tool returned.
              const subagentId = optionalLedgerId(value.subagentId)
              if (subagentId !== undefined) {
                advanceCatalogCandidate(pairing, dispatchRef, { kind: 'continuable', subagentId })
              } else {
                retireCatalogCandidate(pairing, dispatchRef)
              }
            } else if (value !== undefined && value.kind === 'activation') {
              // Activation child (the installed dsh `subagent` shape
              // `{ kind: 'activation', name }`): the tool return means
              // STARTED, not settled — the child is still running. NO settle
              // at tool return: the returned member name is resolved to the
              // child `SessionId` through the subagent surface and paired, so
              // the child's `subagent/end` settles the dispatch through the
              // SAME keyed-by-child channel and outcome mapping. The catalog
              // candidate is retired: the resolved id arrives after this seam.
              retireCatalogCandidate(pairing, dispatchRef)
              pairActivationChild({
                ctx,
                pairing,
                exec,
                ref: dispatchRef,
                name: typeof value.name === 'string' && value.name !== '' ? value.name : undefined,
              })
            } else {
              // Any other successful shape is not attributable to a child
              // turn → the explicit unresolved continuation, never a
              // fabricated settle.
              retireCatalogCandidate(pairing, dispatchRef)
              recordContinuationUnresolved(
                dispatchRef,
                `the ${name} call completed with an unrecognized success shape — its continuation cannot be paired`,
              )
            }
          } else {
            // No result payload at all → nothing mappable and no completion
            // signal: the explicit unresolved continuation, never a silent drop.
            retireCatalogCandidate(pairing, dispatchRef)
            recordContinuationUnresolved(
              dispatchRef,
              `the ${name} call returned no result payload — its continuation cannot be paired`,
            )
          }
        }
        // The call is CONSUMED — each callId pairs exactly once (map pruning,
        // map pruning): the dispatchByCallId
        // entry is deleted after the post-execute branch resolves the call, so
        // the map holds only in-flight calls (a no-op when the key was never
        // registered or already consumed).
        if (key !== undefined) {
          pairing.dispatchByCallId.delete(key)
          // The call window is CLOSED here: a child end buffered against this
          // ref can no longer pair, so it stops occupying its parent's budget.
          sweepUnclaimableChildEnds(pairing)
        }
      }
    } catch (error) {
      log('error', `settle record failed (contained): ${errorMessage(error)}`)
    }
    // Waterfall dispatch (real registry) hands a `next` — delegate on EVERY
    // path (returning without calling next bails the waterfall and breaks
    // every tool call); a direct host emission (plain `emit`) has no `next`
    // and stays silent.
    return next === undefined ? undefined : next()
  }
  ctx.on(SETTLE_SEAM as never, listener as never)
  // The child-turn settlement edge (verified `@deepseek-ai/dsh-subagent`
  // event): an activation child is a continuable subagent, so its initial
  // turn's terminal settlement carries the child id, its direct parent's
  // session id and the stop reason — everything the pairing needs, read from
  // the payload alone. A paired child is consumed here; an end that beat its
  // activation pairing write is kept for that reconcile; every other child end
  // is ignored.
  ctx.on('subagent/end' as never, ((info: unknown): void => {
    try {
      handleActivationChildSettled(pairing, info)
    } catch (error) {
      log('error', `activation child settle failed (contained): ${errorMessage(error)}`)
    }
  }) as never)
  // The pairing trace is emitted at most ONCE per logger binding (≈ once per
  // apply): repeated registrations (tests, HMR) must not re-spam.
  if (!settleNoteLogged) {
    settleNoteLogged = true
    log('info', SETTLE_SEAM_PAIRING_NOTE)
  }
}

/**
 * Structural read of the settled dsh-jobs projection used by pairing. The
 * pinned peer exposes it as `event.job` on `jobs.events.subscribe` lifecycle
 * events. `status` is one of `completed | killed | failed`; `startedAt` and
 * `finishedAt` are epoch ms. `id` is the registry JOB id (`<kind>-N`), never a
 * child session id. The optional service remains structurally typed.
 */
export interface JobDoneSnapshot {
  /** The registry-issued job id (`<kind>-N`, e.g. `subagent-1`) — never a child session id. */
  id: string
  /** Terminal lifecycle status: `completed | killed | failed`. */
  status: string
  /** Epoch ms when the task was registered. */
  startedAt?: number
  /** Epoch ms when the task settled. */
  finishedAt?: number
}

/**
 * Record a background-job settle from a terminal jobs lifecycle event. The
 * projection's registry job id must hit `dispatchByJobId`; a miss records
 * NOTHING (honest degrade, never fabricated). No rc.3 delegation tool writes
 * that map (both return `activation`), so this settles only a call whose
 * tool result carried `{ kind: 'background', jobId }` — reachable from a
 * custom `Config.dispatchTools` entry, not from rc.3's own tools. Outcome
 * mapping: `completed → ok` / `killed → denied` / `failed → error`;
 * `durationMs = finishedAt − startedAt` when both are present. After a
 * successful settle the consumed entry is deleted; a non-terminal projection
 * records nothing and keeps the entry so a later terminal event can settle.
 * Fully contained — never throws into the jobs event notification.
 * @param snapshot - the terminal job projection.
 * @param pairing - the apply-scoped pairing store.
 */
export function recordJobSettle(snapshot: JobDoneSnapshot, pairing: AgentFlowPairing): void {
  try {
    const dispatchRef = pairing.dispatchByJobId.get(snapshot.id)
    if (dispatchRef === undefined) return // unpaired job → no settle
    // Terminal mapping (spec R1): completed → ok / killed → denied / failed →
    // error. Anything ELSE (a contract-violating non-terminal snapshot) maps
    // to NOTHING — never a guessed outcome.
    let outcome: SettleOutcome
    if (snapshot.status === 'completed') outcome = 'ok'
    else if (snapshot.status === 'killed') outcome = 'denied'
    else if (snapshot.status === 'failed') outcome = 'error'
    else return
    const durationMs = typeof snapshot.startedAt === 'number' && typeof snapshot.finishedAt === 'number'
      ? snapshot.finishedAt - snapshot.startedAt
      : undefined
    recordSettleWithRef(dispatchRef, outcome, durationMs)
    // Consumed — the map holds only in-flight jobs.
    pairing.dispatchByJobId.delete(snapshot.id)
  } catch (error) {
    log('error', `settle record failed (contained): ${errorMessage(error)}`)
  }
}

/* ---------------------------------- subagent catalog join (child session identity) ---------------------------------- */
/*
 * NO rc.3 delegation tool feeds this join. Eligibility is set only by a
 * `{ kind: 'background' }` / `{ kind: 'continuable' }` tool result; both
 * rc.3 delegation tools return `activation`, whose resolved child id arrives
 * after the post-execute seam and is paired by the activation branch instead
 * (that seam retires the reserved candidate). The reservation and the live
 * `session/event` observer stay wired from the plugin entry for a deployment
 * that lists another `Config.dispatchTools` name, but no rc.3 delegation
 * call emits a `subagent-link` row.
 */

/**
 * Reserve the FIRST raw-label call-window slot for one recorded dispatch
 * (join step 1). The parent Session object is the WeakMap key (the exact
 * object — session-incarnation safe, delimiter-free) and the RAW delegation
 * `description` is the slot key, so two dispatches that share a label are
 * NOT silently merged: the first reservation owns the label and every later
 * one is admitted no candidate at all. The slot is reserved INERT — no
 * catalog can match it until the post-execute branch marks it eligible, so a
 * catalog that arrives before the tool's result is known can never be
 * attributed by itself. An rc.3 delegation call's slot stays inert forever:
 * its `activation` result retires the candidate.
 *
 * Admission is all-or-nothing and never affects the dispatch or its settle:
 * a missing/malformed live Session (`id` / non-negative safe `seq` below the
 * ledger sequence bound / callable `eventAt`), a missing/empty raw label, a
 * label that sanitizes to nothing, an oversized label (never truncated into
 * a different key), an already-owned label, or a Session at
 * `AGENT_FLOW_CATALOG_SLOT_CAPACITY` slots (existing pending entries and
 * tombstones retained) admits no candidate. Capacity refusal is permanent for
 * that apply/session; it is logged once, not once per refused dispatch.
 * @param pairing - the apply-scoped pairing store (the slots live here).
 * @param ref - the dispatch ref the candidate will own until it is consumed
 *   or retired (the SAME object the job pairing carries into a settle).
 * @param exec - the dispatch exec (structural read of `agent.session` and
 *   `arguments.description`).
 */
function reserveCatalogCandidate(pairing: AgentFlowPairing, ref: AgentFlowDispatchRef, exec: unknown): void {
  const session = asRecord(asRecord(exec)?.agent)?.session
  if (typeof session !== 'object' || session === null) return
  const view = asRecord(session)
  if (view === undefined) return
  if (typeof view.id !== 'string' || view.id === '') return
  const seq = view.seq
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq >= WORKFLOW_LEDGER_MAX_SEQ) return
  if (typeof view.eventAt !== 'function') return
  const label = asRecord(asRecord(exec)?.arguments)?.description
  if (typeof label !== 'string' || label === '') return
  if (normalizeWorkflowName(label) === '') return
  if (label.length > WORKFLOW_LEDGER_MAX_NAME_LENGTH) return
  let map = pairing.catalogBySession.get(session)
  if (map === undefined) {
    map = new Map<string, AgentFlowCatalogJoin | null>()
    pairing.catalogBySession.set(session, map)
  }
  if (map.has(label)) return
  if (map.size >= AGENT_FLOW_CATALOG_SLOT_CAPACITY) {
    // Saturation is a permanent per-Session degradation (slots are never
    // deleted — tombstones are retained so a delayed duplicate cannot acquire
    // a new owner), so it must announce itself. One bounded warn per apply,
    // carrying the session identity and the cap: the refusal silently stops
    // child-identity linking for that session.
    if (!catalogCapacityWarned) {
      catalogCapacityWarned = true
      log('warn', `catalog slot capacity reached on parent session ${view.id} (${String(AGENT_FLOW_CATALOG_SLOT_CAPACITY)} slots) — new delegation labels admit no call-window candidate, so no child identity is linked for the rest of this session (existing entries retained; honest degrade)`)
    }
    return
  }
  map.set(label, { ref, fromSeq: seq })
  ref.catalog = { session: session as unknown as AgentFlowSessionView, label }
}

/**
 * Match one session-log envelope against one ELIGIBLE call-window candidate
 * (join steps 3–4 share this ONE matcher, so the catch-up and live halves can
 * never disagree). Every field of the verified v0 payload is validated: the
 * event type, the payload `version`, a finite envelope time, an integer
 * envelope `seq` inside `[fromSeq, session.seq)` and below
 * {@link WORKFLOW_LEDGER_MAX_SEQ}, a non-negative integer `childCreatedAt`, a
 * non-empty bounded `childId`, the RAW label equality, and the mode implied
 * by the eligible result kind (`one-shot` for background, `continuable`
 * otherwise) — plus the returned-child agreement a continuable result
 * carries. An inert candidate (`result` unset) never matches.
 * @returns the catalog child id, or undefined when this envelope is not this
 *   candidate's catalog.
 */
function matchCatalogEvent(
  session: AgentFlowSessionView,
  label: string,
  join: AgentFlowCatalogJoin,
  envelope: unknown,
): string | undefined {
  const result = join.result
  if (result === undefined) return undefined
  const rec = asRecord(envelope)
  if (rec === undefined || rec.type !== 'subagent/catalog') return undefined
  const data = asRecord(rec.data)
  if (data === undefined || data.version !== 0) return undefined
  if (typeof rec.time !== 'number' || !Number.isFinite(rec.time)) return undefined
  const seq = rec.seq
  if (typeof seq !== 'number' || !Number.isInteger(seq)) return undefined
  // The call window — the load-bearing bound: a catalog below this dispatch's
  // window start can never own it (a constructor-seeded or pre-apply catalog
  // is unreachable, so replay never labels a new dispatch), and the LIVE
  // `session.seq` is the exclusive upper bound (the catch-up walk reads it at
  // eligibility, the live observer at delivery).
  if (seq < join.fromSeq || seq >= session.seq || seq >= WORKFLOW_LEDGER_MAX_SEQ) return undefined
  const childCreatedAt = data.childCreatedAt
  if (typeof childCreatedAt !== 'number' || !Number.isInteger(childCreatedAt) || childCreatedAt < 0) return undefined
  const childId = data.childId
  if (typeof childId !== 'string' || childId === '' || childId.length > WORKFLOW_LEDGER_MAX_ID_LENGTH) return undefined
  if (data.label !== label) return undefined
  if (data.mode !== (result.kind === 'background' ? 'one-shot' : 'continuable')) return undefined
  if (result.kind === 'continuable' && result.subagentId !== childId) return undefined
  return childId
}

/**
 * Consume one matched candidate exactly once (join step 5). The slot becomes
 * a tombstone BEFORE the append attempt — a failed link write is contained
 * and logged, never retried and never re-owned (no second row). The observed
 * child id is copied onto the RETAINED dispatch ref first: the same object
 * sits in `dispatchByJobId` while a background job is in flight, so the
 * later terminal settle carries the identity, and a candidate whose terminal
 * already consumed the job entry still owns the ref long enough to write the
 * identity independently.
 */
function consumeCatalogCandidate(
  map: Map<string, AgentFlowCatalogJoin | null>,
  label: string,
  join: AgentFlowCatalogJoin,
  childId: string,
): void {
  map.set(label, null)
  const ref = join.ref
  ref.childId = childId
  delete ref.catalog
  recordSubagentLink({ ref, childId, label })
}

/**
 * Make one dispatch's reserved candidate ELIGIBLE and run its catch-up window
 * (join steps 2–3), invoked from the post-execute result branch with the
 * result shape it authorized. No rc.3 delegation tool reaches it: both return
 * `activation`, whose branch retires the candidate instead. The catch-up
 * walks `eventAt(seq)` over
 * `[fromSeq, session.seq)` in sequence order — no whole-log copy — and stops
 * at the first match; this is what recovers the catalog the continuable path
 * necessarily appends BEFORE the tool returns, hence before this seam.
 * Contained: a throwing join degrades to a log line and never costs the
 * settle (or the awarded identity) its row. An unreadable `eventAt`
 * position is skipped (the walk continues) and the pass emits at most
 * one warn with the skip count — never one warn per position.
 */
function advanceCatalogCandidate(
  pairing: AgentFlowPairing,
  ref: AgentFlowDispatchRef,
  result: NonNullable<AgentFlowCatalogJoin['result']>,
): void {
  try {
    const catalog = ref.catalog
    if (catalog === undefined) return
    const map = pairing.catalogBySession.get(catalog.session)
    const join = map?.get(catalog.label)
    if (map === undefined || join === undefined || join === null || join.ref !== ref) return
    join.result = result
    const end = catalog.session.seq
    let skippedReads = 0
    let firstSkippedSeq: number | undefined
    let firstSkippedError: string | undefined
    try {
      for (let seq = join.fromSeq; seq < end; seq += 1) {
        let envelope: unknown
        try {
          envelope = catalog.session.eventAt(seq)
        } catch (error) {
          skippedReads += 1
          if (firstSkippedSeq === undefined) {
            firstSkippedSeq = seq
            firstSkippedError = errorMessage(error)
          }
          continue // an unreadable position never aborts the window walk
        }
        const childId = matchCatalogEvent(catalog.session, catalog.label, join, envelope)
        if (childId === undefined) continue
        consumeCatalogCandidate(map, catalog.label, join, childId)
        return
      }
    } finally {
      if (skippedReads > 0) {
        log('warn', `catalog catch-up skipped ${String(skippedReads)} unreadable position(s) in parent session ${catalog.session.id} starting at seq ${String(firstSkippedSeq)} (contained — the window walk continues): ${firstSkippedError ?? 'unknown'}`)
      }
    }
  } catch (error) {
    log('warn', `catalog candidate advance failed (contained — the result branch proceeds): ${errorMessage(error)}`)
  }
}

/**
 * Retire one dispatch's reserved candidate to its tombstone (join step 2's
 * non-linkable outcomes: activation, other success, tool error, absent or
 * malformed result, invalid background job id). The tombstone is RETAINED
 * (not deleted) so a delayed duplicate of the same raw label can never
 * acquire a new owner, and the ref releases its catalog view. Contained like
 * {@link advanceCatalogCandidate}.
 */
function retireCatalogCandidate(pairing: AgentFlowPairing, ref: AgentFlowDispatchRef): void {
  try {
    const catalog = ref.catalog
    if (catalog === undefined) return
    delete ref.catalog
    const map = pairing.catalogBySession.get(catalog.session)
    const slot = map?.get(catalog.label)
    if (map !== undefined && slot !== undefined && slot !== null && slot.ref === ref) map.set(catalog.label, null)
  } catch (error) {
    log('warn', `catalog candidate retire failed (contained — the result branch proceeds): ${errorMessage(error)}`)
  }
}

/**
 * Record one NONTERMINAL `subagent-link` row — the call-window join's output:
 * the child session a dispatch actually started, correlated back to the
 * dispatch identity mstar recorded. This is an IDENTITY record, not a
 * completion: the row carries NO `outcome`, NO `verdict` and NO `paired`
 * marker (the child is still running this round), and `ts` is the link
 * OBSERVATION time — never a fabricated child-creation time
 * (`childCreatedAt` is validated upstream, it is not another ledger clock).
 * The row is written ONLY from a candidate that actually matched, and only
 * from the ref of a dispatch that was really recorded: a link is never a
 * guess or a synthesis. No rc.3 delegation call produces one (see the join's
 * section note): the projection keeps rendering legacy rows.
 *
 * Attribution follows the dispatch, not the clock: the row lands in
 * the native directory recorded when its dispatch was appended, never in today's
 * active workflow dir, and the ref's `harnessDir` is the invalidation key.
 * Fully try/catch-contained — a failing link write logs only and never
 * escapes into the session append (or the job notification) that triggered
 * it.
 * @param input - the retained dispatch ref, the observed catalog `childId`,
 *   and the RAW delegation label the join matched on.
 */
export function recordSubagentLink(input: { ref: AgentFlowDispatchRef; childId: string; label: string }): void {
  try {
    // The child id is REQUIRED identity: a missing, empty, or oversized value
    // skips the ROW (unlike the settle's OPTIONAL identity, which omits only
    // the field) — an id is never truncated and never re-keyed.
    const childId = optionalLedgerId(input.childId)
    if (childId === undefined) {
      log('warn', 'subagent-link row skipped — the observed catalog child id is missing, empty, or oversized (never truncated, never fabricated)')
      return
    }
    const label = truncateLedgerField(normalizeWorkflowName(input.label), WORKFLOW_LEDGER_MAX_LABEL_LENGTH)
    if (label === '') {
      log('warn', 'subagent-link row skipped — the matched delegation label carries no displayable text')
      return
    }
    const ref = input.ref
    // `role` is a REQUIRED row field (present even when ''): a ref without
    // one would write a row this module's own reader skips, so refuse it.
    // The ref normally already carries the canonical role (its dispatch
    // normalized it); normalizing here keeps an independently constructed
    // ref — a direct caller with a raw Assignment value — in the same
    // grammar as the dispatch and settle rows.
    if (typeof ref.role !== 'string') {
      log('warn', 'subagent-link row skipped — the dispatch ref carries no role identity')
      return
    }
    const role = normalizeRoleId(ref.role)
    const taskRef = optionalLedgerId(ref.taskRef)
    const event: AgentFlowEvent = {
      v: 1,
      ts: Date.now(),
      kind: 'subagent-link',
      ...(ref.agent !== undefined && ref.agent.trim() !== '' ? { agent: ref.agent } : {}),
      childId,
      label,
      role,
      ...(ref.planId !== undefined && ref.planId !== '' ? { planId: ref.planId } : {}),
      ...(ref.taskId !== undefined && ref.taskId !== '' ? { taskId: ref.taskId } : {}),
      ...(taskRef !== undefined ? { taskRef } : {}),
    }
    if (appendEvent(ref.workflowId, event, callIdentity('subagent-link', ref.agent, ref.callId), ref.harnessDir, ref.selectedGeneration)) {
      try {
        invalidator?.(ref.harnessDir)
      } catch (error) {
        log('error', `catalog invalidation failed (contained): ${errorMessage(error)}`)
      }
    }
  } catch (error) {
    log('error', `subagent-link record failed (contained): ${errorMessage(error)}`)
  }
}

/**
 * The LIVE half of the call-window join (step 4): ONE root-context
 * `session/event` observer, registered by the entry at apply — before
 * execution can start — that reads only an ELIGIBLE slot of the EXACT
 * carrying Session. The root (untagged) registration is admitted globally by
 * the session store's scope carrier, so a catalog appended by any session
 * reaches it; slots for every other session are simply absent from the
 * WeakMap, and an inert (pending) or tombstoned slot is skipped. Its window
 * bound is the live `session.seq`, not the catch-up endpoint, so a catalog
 * appended after eligibility is still joined.
 *
 * No cold scan and no `session/created` backfill: a catalog written before
 * apply has no surviving dispatch ref, so it can never label a future
 * same-label dispatch. No rc.3 delegation tool makes a slot eligible, so this
 * observer joins nothing for rc.3 calls; it stays registered (the entry wires
 * it) for a deployment that lists another `Config.dispatchTools` name.
 * Contained — a throwing observation never escapes the session append.
 * @param ctx - registrant context (fiber disposal unwinds the observer).
 * @param pairing - the apply-scoped pairing store (the slots).
 */
export function registerSubagentCatalogListener(ctx: Context, pairing: AgentFlowPairing): void {
  ctx.events.on('session/event', (session: unknown, envelope: unknown) => {
    try {
      if (typeof session !== 'object' || session === null) return
      const map = pairing.catalogBySession.get(session)
      if (map === undefined) return
      for (const [label, join] of map) {
        if (join === null || join.result === undefined) continue
        const childId = matchCatalogEvent(session as AgentFlowSessionView, label, join, envelope)
        if (childId === undefined) continue
        consumeCatalogCandidate(map, label, join, childId)
      }
    } catch (error) {
      log('warn', `subagent catalog observation failed (contained — the session append proceeds): ${errorMessage(error)}`)
    }
  })
}
