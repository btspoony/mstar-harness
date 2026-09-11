/**
 * Goal bridge: the observe-only blocked-goal advisory.
 *
 * mstar NEVER writes dsh goal state — no `create`, no `edit`, no `complete`,
 * no `pause`, no `resume` — so the plugin can never re-arm a goal an operator
 * paused. The bridge is ONE `session/event` firehose listener
 * (workflow-ledger consumer precedent) that structurally filters the durable
 * `goal/change` events (upstream `GoalChangeMeta`), gates on
 * `version === 1` (unknown versions → silent skip, forward-compat
 * defensive), and when the goal is blocked (`operation: 'block'` OR
 * `goal.phase === 'blocked'`) logs ONE `mstar/goal-bridge` warn — the
 * `blockedReason.code`, a bounded objective summary, and the
 * project-register residual pointer (`projects/<id>/residuals.json` — the v3
 * residual home) — so the operator acts without reverse-engineering the
 * host. A LATER mutation while the goal is still blocked (e.g. an `edit`)
 * re-surfaces the same blocked state and warns again: one warn per
 * qualifying envelope, not one per goal lifetime.
 *
 * Observe-only: the listener reads the envelope and the goal-owning
 * session's workspace attribution and writes nothing at all — no goal state,
 * no harness state (`{HARNESS_DIR}` / status.json stay SSOT). Every listener
 * body is try/catch-contained: a throwing seam degrades to ONE log line and
 * never breaks a session.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveProjectDir, _DEFAULT_PROJECT, PROJECT_REGISTER_FILE } from '@mstar-harness/engine'
import { asRecord } from './_shared.ts'
import type { HarnessResolver } from './_shared.ts'
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

/** The session-event type of one durable goal mutation (upstream `GoalChangeMeta`; `domain.ts:61-68`). */
const GOAL_CHANGE_EVENT_TYPE = 'goal/change'
/** The one supported durable goal-change wire version (upstream `GOAL_CHANGE_VERSION = 1` — `runtime.ts:8`). */
const GOAL_CHANGE_VERSION = 1
/** Cap for the goal-objective summary inside the blocked advisory (bounded display field). */
const GOAL_ADVISORY_OBJECTIVE_CAP = 512
/** Cap for the block-reason message inside the blocked advisory (bounded display field). */
const GOAL_ADVISORY_MESSAGE_CAP = 512
/**
 * Cap for the `blockedReason.code` inside the blocked advisory: upstream validates lower-kebab only, NEVER length — a
 * model-driven or hostile code must not produce an unbounded log line.
 */
const GOAL_ADVISORY_CODE_CAP = 128

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

/**
 * The concrete project-register pointer for the blocked-goal advisory (v3
 * relocation —): residuals live in
 * `projects/<id>/residuals.json` (entries keyed by plan id), NOT the root
 * `status.json` `residual_findings` home (gone after migrate). Resolves the
 * FIRST project register present (the operator's named project when one
 * exists), else the default project register (`projects/_default/
 * residuals.json` — compass AC-3's documented fallback). Never throws: an
 * unreadable/missing projects dir falls back to the default path.
 */
function projectRegisterPointer(harnessDir: string): string {
  const projectsDir = resolveProjectDir(harnessDir, { harnessDir })
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const registerPath = join(projectsDir, entry.name, PROJECT_REGISTER_FILE)
      if (existsSync(registerPath)) return registerPath
    }
  } catch {
    // missing/unreadable projects dir — fall through to the default path
  }
  return join(projectsDir, _DEFAULT_PROJECT, PROJECT_REGISTER_FILE)
}

/* ---------------------------------- structural views ---------------------------------- */

/** Structural view of the session the `session/event` firehose carries (`header.cwd` — the workspace attribution read). */
interface SessionView {
  header?: { cwd?: unknown }
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
 * bounded objective summary, and the project register pointer
 * (`projects/<id>/residuals.json` — mstar-artifacts SSOT; entries keyed by
 * plan id) — the operator acts without reverse-engineering the host.
 * Advisory-only: ZERO harness writes (status.json stays SSOT) and ZERO goal
 * writes. Never throws (the sink is a no-op before bind; `log` itself is a
 * plain call).
 */
function warnBlockedGoal(harnessDir: string, advisory: BlockedGoalAdvisory): void {
  const code = truncateLedgerField(advisory.code, GOAL_ADVISORY_CODE_CAP)
  const reason = truncateLedgerField(normalizeWorkflowName(advisory.message), GOAL_ADVISORY_MESSAGE_CAP)
  const objective = truncateLedgerField(normalizeWorkflowName(advisory.objective), GOAL_ADVISORY_OBJECTIVE_CAP)
  log('warn', `goal blocked [${code}] — ${reason}; objective: ${objective}; residuals: see ${projectRegisterPointer(harnessDir)} — advisory only, zero harness writes`)
}

/* ---------------------------------- apply wiring ---------------------------------- */

/**
 * Register the goal bridge: ONE `session/event` firehose listener
 * (workflow-ledger consumer precedent) that structurally filters the durable
 * `goal/change` envelopes and logs the blocked advisory (see
 * {@link warnBlockedGoal}). It resolves no service — the envelope carries
 * the facts, and the workspace attribution comes from the goal-owning
 * session's `header.cwd`; an unresolvable harness → silent skip. Observe-only:
 * no goal mutation of any kind (`create` / `edit` / `complete` / `pause` /
 * `resume`), and the goal-owning agent is never read.
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param resolver - the shared per-workspace `{HARNESS_DIR}` resolver.
 */
export function registerGoalBridge(ctx: Context, resolver: HarnessResolver): void {
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
