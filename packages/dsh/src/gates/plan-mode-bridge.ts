/**
 * PlanMode bridge (plan `20260816-dsh-nb2-goal-bridge` Task 4b — N-B3): the
 * Prepare-phase flag flip — a one-way mirror of the harness Prepare state
 * into the host plan-mode session state (`ctx.get('planMode')`, STRUCTURAL
 * view — no new peer dependency; upstream `packages/plan/plan-mode/src/
 * index.ts:403-445`).
 *
 * The planMode service is agent-scoped and idempotent: `get(agent)` folds
 * the session `plan/mode` log into `{ active, pending? }`; `set(agent,
 * active)` returns `'committed' | 'queued' | 'cancelled' | 'noop'` —
 * `'noop'` when the target already matches (pending selections included),
 * so repeated evaluation at multiple decision points never churns session
 * events.
 *
 * Policy (Task 1 definition, T1-verified): plan mode is ON iff an active
 * iteration steers (compass `status: active|locked` — {@link
 * steeringCompass}, goal-bridge parity) AND the SELECTED workflow snapshot
 * carries ≥1 plan row in the `Todo` state (the Prepare window — a plan
 * registered, not yet started; the engine plan-status vocabulary,
 * `status.ts:117` — v3 relocation: the root v1 `plans[]` home is gone, the
 * probe reads `workflows/<id>/snapshot.json` rows). Otherwise the target
 * is OFF.
 *
 * The bridge mirrors the ROOT session only ({@link isRootLikeAgent} —
 * `session.header.parentSession === undefined`; conversation forks
 * conservatively excluded — plan mode is a session-level selection and the
 * root agent drives the harness workflow). Evaluation points: the
 * `agent/session-start` listener (root filter inside) plus the EXISTING
 * `subagent/start` decision point (the parentSession root walk — {@link
 * rootAgentOf}, the goal-bridge precedent): a mid-session Prepare flip
 * (plan row appears/advances past `Todo`) re-evaluates the root's flag
 * without extra seams.
 *
 * One-way mirror: the bridge only READS harness state (`{HARNESS_DIR}` /
 * status.json stay SSOT — the same boundary as the goal bridge) and writes
 * host session state (the `plan/mode` event). The planMode service absent →
 * boot unaffected + ONE debug log (optional-unit degrade); every listener
 * and interaction is try/catch-contained.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { readJson, WORKFLOW_SNAPSHOT_FILE } from '@mstar-harness/engine'
import { asRecord, STATUS_FILE } from './_shared.ts'
import type { HarnessResolver } from './_shared.ts'
// The shared root discriminator, the active-iteration compass scan and the
// `subagent/start` root walk (explicit no-barrel imports — plan Task 4b;
// goal-bridge.ts does not import this module, so there is no cycle).
import { isRootLikeAgent, rootAgentOf, steeringCompass } from './goal-bridge.ts'
// v3 relocation (plan `20260819-workflow-dsh-viz` Task 3): the Todo probe
// reads the SELECTED workflow snapshot's plan rows — the root v1 `plans[]`
// home is gone. The bridge is a READ-only mirror, so the read resolver
// (active → terminal → error) applies.
import { resolveReadWorkflow } from './workflow-selection.ts'

/** Logger label for the planMode bridge (dsh logger naming: `<scope>/<subject>`). */
export const PLAN_MODE_BRIDGE_LOGGER = 'mstar/plan-mode-bridge'

/**
 * The Prepare-window plan status: `PLAN_STATUSES[0]` (engine
 * `packages/engine/src/status.ts:117` — the status.json plan-row
 * vocabulary; the engine validates rows against the full list).
 */
const PLAN_STATUS_TODO = 'Todo'

/** Consumer log levels the module sink understands. */
export type PlanModeBridgeLogLevel = 'debug' | 'warn'

/** Module-level consumer log sink — bound by `apply` to `ctx.logger(PLAN_MODE_BRIDGE_LOGGER)` (goal-bridge precedent). */
export type PlanModeBridgeLogSink = (level: PlanModeBridgeLogLevel, message: string) => void

let planModeBridgeLogSink: PlanModeBridgeLogSink = () => {}

/**
 * Bind the planMode-bridge log sink (the entry `apply` binds it to
 * `ctx.logger(PLAN_MODE_BRIDGE_LOGGER)`). Returns the PRIOR sink so a caller
 * can restore it (test pattern: goal-bridge `setGoalBridgeLogger`).
 */
export function setPlanModeBridgeLogger(sink: PlanModeBridgeLogSink): PlanModeBridgeLogSink {
  const prior = planModeBridgeLogSink
  planModeBridgeLogSink = sink
  return prior
}

/** Log one consumer message through the bound sink (no-op before bind). */
function log(level: PlanModeBridgeLogLevel, message: string): void {
  planModeBridgeLogSink(level, message)
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ---------------------------------- structural views ---------------------------------- */

/**
 * Minimal structural view of the planMode service the bridge consumes
 * (`@deepseek-ai/dsh-plan-mode` `PlanModeController` — every method is
 * agent-scoped; the runtime read is `ctx.get('planMode')` without the
 * inject requirement, same pattern as the goal bridge). `set` is idempotent:
 * `'noop'` when the target already matches (`plan-mode/src/index.ts:425-445`).
 */
export interface PlanModeServiceView {
  get(agent: unknown): { active?: unknown; pending?: unknown } | undefined
  set(agent: unknown, active: boolean): unknown
}

/** The `agents` service surface the `subagent/start` root walk reads. */
interface AgentsView {
  get(id: string): unknown
}

/* ---------------------------------- the policy ---------------------------------- */

/**
 * Whether the SELECTED workflow snapshot carries a Prepare window: ≥1 plan
 * row with `status: 'Todo'` (a plan registered, not yet started). The root
 * v1 `plans[]` home is gone — the probe reads the selected workflow's
 * snapshot (`workflows/<id>/snapshot.json`, compass Catalog selection rule
 * via `resolveReadWorkflow`). Missing status.json / selection error /
 * unreadable snapshot / a missing `plans` array → `false` (advisory degrade
 * — the status gate already refuses invalid writes, and a broken read must
 * never force the flag on).
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 */
function hasPrepareWindow(harnessDir: string): boolean {
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) return false
  const selection = resolveReadWorkflow(harnessDir)
  if (selection.kind === 'error') return false
  const snapshotPath = join(harnessDir, selection.dir, WORKFLOW_SNAPSHOT_FILE)
  let doc: Record<string, unknown>
  try {
    doc = readJson(snapshotPath)
  } catch {
    return false
  }
  const plans = doc.plans
  if (!Array.isArray(plans)) return false
  return plans.some((row) => asRecord(row)?.status === PLAN_STATUS_TODO)
}

/**
 * The planMode target for one harness: `true` iff an active iteration steers
 * (compass `status: active|locked`) AND a Prepare window exists (≥1 plan
 * row `Todo`). No active iteration / no Prepare window → `false` (plan mode
 * OFF — the host default).
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 */
export function planModeTarget(harnessDir: string): boolean {
  if (steeringCompass(harnessDir) === undefined) return false
  return hasPrepareWindow(harnessDir)
}

/* ---------------------------------- the sync ---------------------------------- */

/** Inputs of the sync: the structural planMode view and the per-workspace resolver. */
export interface PlanModeSyncInput {
  resolver: HarnessResolver
  /** The structural planMode view (`ctx.get('planMode')`); absent → the sync is inert. */
  planMode?: PlanModeServiceView
}

/**
 * Mirror the harness Prepare state into the planMode selection of ONE agent:
 * root-like agent (`header.parentSession === undefined`) → resolve the
 * workspace → compute {@link planModeTarget} → `planMode.set(agent, target)`.
 * The service's `'noop'` return makes repeated evaluation at multiple
 * decision points churn-free (no new `plan/mode` event when already in
 * target). Non-root agent / unresolvable harness / missing planMode service
 * → no set.
 *
 * @returns `true` when the sync ran for this agent (set called); `false`
 * when not applicable or a contained failure occurred. Never throws — the
 * caller's listener stays contained.
 */
export function syncPlanMode(agent: unknown, input: PlanModeSyncInput): boolean {
  const { resolver, planMode } = input
  if (planMode === undefined) return false
  if (!isRootLikeAgent(agent)) return false
  const harnessDir = resolver.forAgent(agent)
  if (harnessDir === null) return false
  try {
    planMode.set(agent, planModeTarget(harnessDir))
    return true
  } catch (error) {
    log('warn', `planMode sync failed (contained — the session/decision point proceeds): ${errorMessage(error)}`)
    return false
  }
}

/* ---------------------------------- apply wiring ---------------------------------- */

/**
 * Register the planMode bridge: an `agent/session-start` listener (root
 * filter inside — root and children alike fire, `runtime-types.ts:217`) plus
 * the EXISTING `subagent/start` decision point (the goal-bridge precedent),
 * resolving the delegating ROOT via the shared `parentSession` walk — the
 * two edges are idempotent (`'noop'` when already in target — no churn). The
 * planMode service is an OPTIONAL seam (`ctx.get('planMode')` structural
 * read): absent → ONE debug log + the bridge stays inert, never a boot
 * failure. Every listener body is try/catch-contained.
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param resolver - the shared per-workspace `{HARNESS_DIR}` resolver.
 */
export function registerPlanModeBridge(ctx: Context, resolver: HarnessResolver): void {
  const planMode = ctx.get('planMode') as PlanModeServiceView | undefined
  if (planMode === undefined) {
    log('debug', 'planMode service absent — plan-mode bridge disabled (composition without @deepseek-ai/dsh-plan-mode)')
  }
  const sync = (agent: unknown): void => {
    try {
      syncPlanMode(agent, { resolver, planMode })
    } catch (error) {
      log('warn', `planMode bridge sync failed (contained — the session/decision point proceeds): ${errorMessage(error)}`)
    }
  }
  // Primary edge: `agent/session-start` fires per agent, root and children
  // alike — the root filter lives inside the sync. Registered on the
  // untyped `ctx.events.on` (same registration path as the mixined
  // `ctx.on` and the goal bridge): the event is declared by
  // `@deepseek-ai/dsh-agent`, which this plugin does not type-depend on —
  // the payload is consumed structurally.
  ctx.events.on('agent/session-start', (payload: { agent?: unknown }) => {
    if (payload.agent !== undefined) sync(payload.agent)
  })
  // Decision-point re-evaluation (idempotent — no churn when already in
  // target): autonomous Phase 2 drives by dispatching subagents, so each
  // `subagent/start` re-checks the delegating ROOT's flag against the
  // CURRENT harness state (a mid-session Prepare flip — a plan row entering
  // or leaving `Todo` — flips the root's planMode).
  ctx.events.on('subagent/start', (info: { id?: unknown }) => {
    const agents = ctx.get('agents') as AgentsView | undefined
    if (agents === undefined || typeof info.id !== 'string') return
    const child = agents.get(info.id)
    if (child === undefined) return
    const root = rootAgentOf(child, agents)
    if (root !== undefined) sync(root)
  })
}
