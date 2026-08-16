/**
 * Goal bridge (plan `20260816-dsh-nb2-goal-bridge` Task 2): one-way mirror
 * of the active iteration objective into the dsh goal service, with a finite
 * `maxGoalRounds` cap — an operator driving autonomous Phase 2 sees ONE
 * session goal that means "run the complete iteration flow to merge-ready",
 * and the autonomous loop is bounded.
 *
 * The goals service is consumed STRUCTURALLY over `ctx.get('goals')` (no new
 * peer dependency — the decoration's structural-cast precedent; the service
 * is agent-scoped: every method takes `(agent, …)`). The bridge resolves the
 * per-workspace `{HARNESS_DIR}` via the shared resolver, scans for the
 * steering iteration compass (`status: active|locked` — resolveCompassEnforcement
 * parity), and mirrors: `get`-first (create throws `GOAL_ALREADY_EXISTS` on
 * a live non-complete goal) → `create` when absent → CAS `edit` by
 * `{ id, revision }` on objective drift, with a single stale re-read retry
 * (a second stale failure is warned and abandoned — goal-service-side
 * concurrency is rare). The goal text is the COMPLETE iteration flow
 * (mstar-host `/goal` rule): iteration id + the full
 * `iteration-start → per-plan cycles → iteration-close → PR delivery →
 * merge-ready` sequence + the exit definition — never a sub-stage.
 *
 * One-way mirror: the bridge only reads harness state and writes the goal;
 * `{HARNESS_DIR}` / `status.json` stay SSOT. The goals service absent →
 * boot unaffected + ONE debug log (optional-unit degrade); every listener
 * and interaction is try/catch-contained.
 *
 * Task 3 — blocked sync advisory: a `session/event` firehose listener
 * (workflow-ledger consumer precedent) structurally filters the durable
 * `goal/change` events (upstream `GoalChangeMeta`), gates on
 * `version === 1` (unknown versions → silent skip), and when the goal is
 * blocked (`operation: 'block'` OR `goal.phase === 'blocked'`) logs ONE
 * `mstar/goal-bridge` warn — the `blockedReason.code`, a bounded objective
 * summary, and the `{HARNESS_DIR}/status.json` residual pointer — so the
 * operator acts without reverse-engineering the host. Advisory-only: ZERO
 * harness writes (the mirror stays one-way; status.json remains SSOT).
 *
 * Task 4b (planMode bridge) — the module also SHARES three structural
 * helpers with `gates/plan-mode-bridge.ts` via explicit no-barrel imports:
 * {@link isRootLikeAgent}, {@link steeringCompass} and {@link rootAgentOf}
 * (the planMode bridge reuses the same root discriminator, the same
 * active-iteration compass scan, and the same `subagent/start` root walk).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveIterationDir } from '@mstar-harness/engine'
import { asRecord, STATUS_FILE } from './_shared.ts'
import type { Config, HarnessResolver } from './_shared.ts'
// The shared display-field bounds (`truncateLedgerField`) and control-char
// strip (`normalizeWorkflowName`) — the same sanitization the workflow-ledger
// consumer applies to its warn/ledger display fields (the goal objective and
// block-reason message are model-controlled text; a newline/tab/CR must never
// reach the advisory line). Pure imports — neither module imports goal-bridge
// (no cycle).
import { truncateLedgerField } from './agent-flow.ts'
import { normalizeWorkflowName } from './workflow-policy.ts'

/** Logger label for the goal bridge (dsh logger naming: `<scope>/<subject>`). */
export const GOAL_BRIDGE_LOGGER = 'mstar/goal-bridge'

/**
 * Flat `maxGoalRounds` config fallback (architect decision — plan
 * `20260816-dsh-nb2-goal-bridge`): 256, aligned with the GoalService default
 * (`goal/src/index.ts:187`) and ralph `maxRounds` (`tool-ralph/src/index.ts:37`).
 */
export const DEFAULT_MAX_GOAL_ROUNDS = 256

/**
 * The complete-flow keyword sequence the goal objective MUST carry verbatim
 * (mstar-host `/goal` rule — advancing an iteration means the ENTIRE flow,
 * never a sub-stage).
 */
const FLOW_SEQUENCE = 'iteration-start → per-plan cycles → iteration-close → PR delivery → merge-ready'

/** The session-event type of one durable goal mutation (upstream `GoalChangeMeta`; `domain.ts:61-68`). */
const GOAL_CHANGE_EVENT_TYPE = 'goal/change'
/** The one supported durable goal-change wire version (upstream `GOAL_CHANGE_VERSION = 1` — `runtime.ts:8`). */
const GOAL_CHANGE_VERSION = 1
/** Cap for the goal-objective summary inside the blocked advisory (bounded display field). */
const GOAL_ADVISORY_OBJECTIVE_CAP = 512
/** Cap for the block-reason message inside the blocked advisory (bounded display field). */
const GOAL_ADVISORY_MESSAGE_CAP = 512

/** Consumer log levels the module sink understands. */
export type GoalBridgeLogLevel = 'debug' | 'warn'

/** Module-level consumer log sink — bound by `apply` to `ctx.logger(GOAL_BRIDGE_LOGGER)` (agent-flow ledger precedent). */
export type GoalBridgeLogSink = (level: GoalBridgeLogLevel, message: string) => void

let goalBridgeLogSink: GoalBridgeLogSink = () => {}

/**
 * Bind the goal-bridge log sink (the entry `apply` binds it to
 * `ctx.logger(GOAL_BRIDGE_LOGGER)`). Returns the PRIOR sink so a caller can
 * restore it (test pattern: agent-flow `setAgentFlowLogger`).
 */
export function setGoalBridgeLogger(sink: GoalBridgeLogSink): GoalBridgeLogSink {
  const prior = goalBridgeLogSink
  goalBridgeLogSink = sink
  return prior
}

/** Log one consumer message through the bound sink (no-op before bind). */
function log(level: GoalBridgeLogLevel, message: string): void {
  goalBridgeLogSink(level, message)
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ---------------------------------- structural views ---------------------------------- */

/** The agent surface the bridge reads structurally (`session.header` — never trusts the runtime shape). */
interface AgentView {
  session?: {
    header?: {
      /** In-process subagent children stamp the parent session id at creation (`child-agent.ts:112`); forks carry it too (conservatively excluded). */
      parentSession?: unknown
    }
  }
}

/**
 * Root-agent discriminator (T1-verified; shared with the planMode bridge via
 * explicit no-barrel import): `header.parentSession === undefined` ⇒
 * root-like. Conversation forks also carry `parentSession` (seed lineage) →
 * conservatively excluded from the goal mirror (accepted boundary).
 */
export function isRootLikeAgent(agent: unknown): boolean {
  const header = (agent as AgentView | null | undefined)?.session?.header
  return header?.parentSession === undefined
}

/** CAS identity for one exact goal revision (upstream `GoalRef`). */
export interface GoalRefView {
  readonly id: string
  readonly revision: number
}

/** The one goal surface the bridge reads (`GoalSnapshot` fields used by the mirror). */
export interface GoalView extends GoalRefView {
  readonly objective: string
  readonly phase: string
  readonly maxGoalRounds: number
}

/**
 * Minimal structural view of the goals service the bridge consumes
 * (`@deepseek-ai/dsh-goal` `GoalService` — every method is agent-scoped;
 * the runtime read is `ctx.get('goals')` without the inject requirement,
 * same pattern as the probe's service view). `create` throws
 * `GOAL_ALREADY_EXISTS` on a live non-complete goal (get-先行); `edit` is a
 * CAS by `{ id, revision }` (`GOAL_STALE_REVISION` on stale).
 */
export interface GoalsServiceView {
  get(agent: unknown): GoalView | undefined
  create(agent: unknown, request: { objective: string; maxGoalRounds?: number }): unknown
  edit(agent: unknown, ref: GoalRefView, request: { objective?: string; maxGoalRounds?: number }): unknown
}

/** The `agents` service surface the `subagent/start` root walk reads. */
interface AgentsView {
  get(id: string): unknown
}

/** Structural view of the session the `session/event` firehose carries (`header.cwd` — the workspace attribution read). */
interface SessionView {
  header?: { cwd?: unknown }
}

/** Structural view of one durable goal-change payload (upstream `GoalSnapshotChangeMeta`; `domain.ts:24-32`). */
interface GoalChangeDataView {
  version?: unknown
  operation?: unknown
  goal?: GoalSnapshotDataView
}

/** Structural view of one goal snapshot (upstream `GoalSnapshot`; `types.ts:59-68`). */
interface GoalSnapshotDataView {
  phase?: unknown
  objective?: unknown
  blockedReason?: BlockedReasonDataView
}

/** Structural view of the block reason (upstream `GoalBlockReason`; `types.ts:51-56` — code lower-kebab, non-empty message). */
interface BlockedReasonDataView {
  code?: unknown
  message?: unknown
}

/* ---------------------------------- objective text ---------------------------------- */

/**
 * The mirrored goal objective: the COMPLETE iteration flow with the exit
 * definition (mstar-host `/goal` rule — advancing an iteration means the
 * entire flow, never a sub-stage). Session-level text only — `status.json`
 * stays the harness SSOT.
 */
export function iterationGoalObjective(iterationId: string): string {
  return (
    `Run iteration ${iterationId} through the complete flow to its exit: ${FLOW_SEQUENCE}. ` +
    "Exit: the iteration's delivery PR is merged to the target branch and the merge-ready loop closes; the harness status.json stays the source of truth."
  )
}

/* ---------------------------------- steering compass ---------------------------------- */

/**
 * Locate the steering iteration compass (mirror of the engine's
 * `resolveCompassEnforcement` scan + the catalog's `steeringCompassPath`):
 * the FIRST `{ITERATION_DIR}/<id>/delivery-compass.md` whose frontmatter
 * `status` is `active` or `locked` — the directory name IS the iteration id
 * (plan-conventions `{ITERATION_DIR}/<id>/`). Completed/status-less/archived
 * compasses do not steer. Silent on any read failure (advisory degrade).
 * Shared with the planMode bridge via explicit no-barrel import (Task 4b —
 * the same "is an active iteration steering" read).
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 */
export function steeringCompass(harnessDir: string): { iterationId: string } | undefined {
  const iterationsDir = resolveIterationDir(harnessDir)
  if (!existsSync(iterationsDir)) return undefined
  let entries
  try {
    entries = readdirSync(iterationsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const compassPath = join(iterationsDir, entry.name, 'delivery-compass.md')
    if (!existsSync(compassPath)) continue
    let content: string
    try {
      content = readFileSync(compassPath, 'utf8')
    } catch {
      continue
    }
    // Frontmatter only: leading `---` fence through the closing fence; only
    // steering compasses count (resolveCompassEnforcement parity).
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (frontmatter === null || !/^status[ \t]*:[ \t]*(?:active|locked)[ \t]*$/m.test(frontmatter[1]!)) continue
    return { iterationId: entry.name }
  }
  return undefined
}

/* ---------------------------------- the mirror ---------------------------------- */

/** The stable machine-routable code a stale CAS edit throws (`GoalError.code`). */
const GOAL_STALE_REVISION = 'GOAL_STALE_REVISION'

/** Narrow an arbitrary thrown value to its stable `code` field, when it has one. */
function goalErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if (!('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

/** Inputs of the mirror: the structural goals view, the per-workspace resolver, and the resolved round cap. */
export interface MirrorIterationGoalInput {
  resolver: HarnessResolver
  /** The structural goals view (`ctx.get('goals')`); absent → the mirror is inert. */
  goals?: GoalsServiceView
  /** The resolved `maxGoalRounds` (flat config key, absent → {@link DEFAULT_MAX_GOAL_ROUNDS}). */
  maxGoalRounds: number
}

/**
 * Mirror the steering iteration objective into the goal of ONE agent.
 * Root-like agent (`header.parentSession === undefined`) + active iteration
 * (compass `status: active|locked`): `get` → absent → `create` (get-先行 —
 * no `GOAL_ALREADY_EXISTS`); present with drifted objective → CAS `edit` by
 * `{ id, revision }` (one stale re-read retry; a second stale failure is
 * warned and abandoned — goal-service-side concurrency is rare); present
 * with the matching objective → no-op (idempotent decision-point
 * re-evaluation). No active iteration / non-root agent / unresolvable
 * harness / missing goals service → no goal set.
 *
 * @returns `true` when the mirror is ensured for this agent (created,
 * edited, or already in place); `false` when not applicable or a contained
 * failure occurred. Never throws — the caller's listener stays contained.
 */
export function mirrorIterationGoal(agent: unknown, input: MirrorIterationGoalInput): boolean {
  const { resolver, goals, maxGoalRounds } = input
  if (goals === undefined) return false
  if (!isRootLikeAgent(agent)) return false
  const harnessDir = resolver.forAgent(agent)
  if (harnessDir === null) return false
  const compass = steeringCompass(harnessDir)
  if (compass === undefined) return false
  const objective = iterationGoalObjective(compass.iterationId)
  try {
    const current = goals.get(agent)
    if (current === undefined) {
      goals.create(agent, { objective, maxGoalRounds })
      return true
    }
    if (current.objective === objective) return true
    try {
      goals.edit(agent, { id: current.id, revision: current.revision }, { objective })
      return true
    } catch (error) {
      if (goalErrorCode(error) !== GOAL_STALE_REVISION) throw error
      // Concurrent mutation between get and edit (rare): re-read ONCE and
      // retry the CAS edit with the fresh ref. A goal that another writer
      // already synced is left alone; a second stale failure is warned and
      // abandoned — the mirror never forces the goal.
      const fresh = goals.get(agent)
      if (fresh === undefined) {
        goals.create(agent, { objective, maxGoalRounds })
        return true
      }
      if (fresh.objective === objective) return true
      goals.edit(agent, { id: fresh.id, revision: fresh.revision }, { objective })
      return true
    }
  } catch (error) {
    const code = goalErrorCode(error)
    log('warn', `goal mirror failed (contained — the session/decision point proceeds)${code !== undefined ? ` [${code}]` : ''}: ${errorMessage(error)}`)
    return false
  }
}

/* ---------------------------------- blocked sync advisory ---------------------------------- */

/** The blocked-advisory facts extracted from ONE goal-change envelope. */
interface BlockedGoalAdvisory {
  /** The stable lower-kebab block code (upstream-validated non-empty — safe to surface verbatim). */
  code: string
  /** The block-reason message (upstream-validated non-empty). */
  message: string
  /** The goal objective the advisory summarizes. */
  objective: string
}

/**
 * Extract the blocked-advisory facts from ONE `session/event` envelope when
 * it is a `goal/change` (upstream `GoalChangeMeta` — structural read, never
 * trusts the runtime shape): `operation === 'block'` OR `goal.phase ===
 * 'blocked'` (defensive dual check — a block commits phase 'blocked' with
 * `operation: 'block'`, and a LATER mutation while blocked (e.g. an `edit`)
 * re-surfaces the same blocked state; each matching event warns once).
 * Unknown `version` → silently skipped (forward-compat defensive: a v2 wire
 * must not be half-read as v1). Returns undefined for non-goal events,
 * malformed envelopes, unknown versions, and non-blocked goals. Pure —
 * NEVER throws.
 */
function blockedAdvisoryOf(envelope: unknown): BlockedGoalAdvisory | undefined {
  const record = asRecord(envelope)
  if (record === undefined || record.type !== GOAL_CHANGE_EVENT_TYPE) return undefined
  const data = asRecord(record.data)
  if (data === undefined) return undefined
  if (data.version !== GOAL_CHANGE_VERSION) return undefined // unknown version — silent skip
  const goal = asRecord(data.goal)
  if (goal === undefined) return undefined
  if (data.operation !== 'block' && goal.phase !== 'blocked') return undefined
  const blockedReason = asRecord(goal.blockedReason)
  if (blockedReason === undefined) return undefined
  const code = blockedReason.code
  const message = blockedReason.message
  const objective = goal.objective
  if (typeof code !== 'string' || code === '' || typeof message !== 'string' || message === '' || typeof objective !== 'string' || objective === '') {
    return undefined
  }
  return { code, message, objective }
}

/**
 * Log ONE blocked-advisory warn: the stable `blockedReason.code`, the
 * sanitized (ASCII control chars stripped) + bounded reason message, a
 * bounded objective summary, and the `{HARNESS_DIR}/status.json` residual
 * pointer (`residual_findings` — mstar-plan-artifacts SSOT) — the operator
 * acts without reverse-engineering the host. Advisory-only: ZERO harness
 * writes (the one-way mirror; status.json stays SSOT). Never throws (the
 * sink is a no-op before bind; `log` itself is a plain call).
 */
function warnBlockedGoal(harnessDir: string, advisory: BlockedGoalAdvisory): void {
  const reason = truncateLedgerField(normalizeWorkflowName(advisory.message), GOAL_ADVISORY_MESSAGE_CAP)
  const objective = truncateLedgerField(normalizeWorkflowName(advisory.objective), GOAL_ADVISORY_OBJECTIVE_CAP)
  log('warn', `goal blocked [${advisory.code}] — ${reason}; objective: ${objective}; residuals: see ${harnessDir}/${STATUS_FILE} (residual_findings) — advisory only, zero harness writes`)
}

/* ---------------------------------- apply wiring ---------------------------------- */

/**
 * Resolve the ROOT agent of a published child via the `parentSession` walk
 * (upstream `subagent/src/continuation.ts:822-828` precedent): in-process
 * subagent children stamp `header.parentSession` = the parent SESSION id,
 * which IS the parent agent id (a session per agent); the walk stops at the
 * first root-like ancestor. `undefined` when unresolvable (fork lineage,
 * non-in-process provider, registry gap, or a cycle guard) — the decision
 * point then silently skips. Shared with the planMode bridge via explicit
 * no-barrel import (Task 4b — the same `subagent/start` decision-point
 * root walk).
 */
export function rootAgentOf(agent: unknown, agents: AgentsView): unknown | undefined {
  let current: unknown = agent
  for (;;) {
    const header = (current as AgentView | null | undefined)?.session?.header
    if (header === undefined) return undefined
    if (header.parentSession === undefined) return current
    if (typeof header.parentSession !== 'string') return undefined
    const parent = agents.get(header.parentSession)
    if (parent === undefined || parent === current) return undefined // registry gap or cycle — abandon
    current = parent
  }
}

/**
 * Register the goal bridge: an `agent/session-start` listener (root filter
 * inside the mirror — root and children alike fire, `runtime-types.ts:217`)
 * plus a decision-point re-evaluation on `subagent/start` (the existing
 * decision point — index.ts decoration slot), resolving the delegating ROOT
 * via the `parentSession` walk — the two mirror edges are idempotent (get +
 * compare when the mirror is in place — no churn) — plus a THIRD, advisory
 * listener on the `session/event` firehose (Task 3): a `goal/change`
 * envelope whose goal is blocked logs ONE warn (code + objective summary +
 * `{HARNESS_DIR}/status.json` residual pointer) with ZERO harness writes
 * (the one-way mirror; see {@link warnBlockedGoal}). The goals service is an
 * OPTIONAL seam (`ctx.get('goals')` structural read): absent → ONE debug log
 * + the mirror stays inert, never a boot failure — the blocked advisory is
 * independent of it (it only needs the firehose + resolver). Every listener
 * body is try/catch-contained.
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param resolver - the shared per-workspace `{HARNESS_DIR}` resolver.
 * @param config - validated plugin configuration (flat `maxGoalRounds`,
 *   absent → {@link DEFAULT_MAX_GOAL_ROUNDS}).
 */
export function registerGoalBridge(ctx: Context, resolver: HarnessResolver, config: Config): void {
  const goals = ctx.get('goals') as GoalsServiceView | undefined
  if (goals === undefined) {
    log('debug', 'goals service absent — goal bridge disabled (composition without @deepseek-ai/dsh-goal)')
  }
  const maxGoalRounds = config.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS
  const mirror = (agent: unknown): void => {
    try {
      mirrorIterationGoal(agent, { resolver, goals, maxGoalRounds })
    } catch (error) {
      log('warn', `goal bridge mirror failed (contained — the session/decision point proceeds): ${errorMessage(error)}`)
    }
  }
  // Primary edge: `agent/session-start` fires per agent, root and children
  // alike — the root filter lives inside the mirror. Registered on the
  // untyped `ctx.events.on` (same registration path as the mixined
  // `ctx.on`, the `subagent/start` precedent): the event is declared by
  // `@deepseek-ai/dsh-agent`, which this plugin does not type-depend on —
  // the payload is consumed structurally.
  ctx.events.on('agent/session-start', (payload: { agent?: unknown }) => {
    if (payload.agent !== undefined) mirror(payload.agent)
  })
  // Decision-point re-evaluation (idempotent — no churn when the mirror is
  // in place): autonomous Phase 2 drives by dispatching subagents, so each
  // `subagent/start` re-checks the root's goal against the CURRENT steering
  // compass (a mid-session iteration flip CAS-edits the objective).
  ctx.events.on('subagent/start', (info: { id?: unknown }) => {
    const agents = ctx.get('agents') as AgentsView | undefined
    if (agents === undefined || typeof info.id !== 'string') return
    const child = agents.get(info.id)
    if (child === undefined) return
    const root = rootAgentOf(child, agents)
    if (root !== undefined) mirror(root)
  })
  // Task 3 — blocked sync advisory (plan Global Constraints: one-way mirror;
  // `blocked.code` → warn with the status.json residual pointer, zero writes):
  // a `session/event` firehose listener (workflow-ledger consumer precedent)
  // structurally filters the durable `goal/change` envelopes (upstream
  // `GoalChangeMeta`), gates on `version === 1` (unknown versions → silent
  // skip, forward-compat defensive), and when the goal is blocked
  // (`operation: 'block'` OR `goal.phase === 'blocked'`) logs ONE warn —
  // `blockedReason.code` + a bounded objective summary + the
  // `{HARNESS_DIR}/status.json` residual pointer — and writes NOTHING.
  // Workspace attribution from the goal-owning session's `header.cwd`
  // (workflow-ledger precedent); unresolvable harness → silent skip. Every
  // envelope is try/catch-contained.
  ctx.events.on('session/event', (session: unknown, envelope: unknown) => {
    try {
      const advisory = blockedAdvisoryOf(envelope)
      if (advisory === undefined) return
      const cwd = (session as SessionView | null | undefined)?.header?.cwd
      const harnessDir = resolver.forWorkspace(typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined)
      if (harnessDir === null) return
      warnBlockedGoal(harnessDir, advisory)
    } catch (error) {
      log('warn', `goal blocked advisory degraded (contained — the session proceeds): ${errorMessage(error)}`)
    }
  })
}
