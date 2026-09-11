/**
 * PlanMode bridge : the
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
 * Policy: plan mode is ON iff the SELECTED lifecycle's own
 * iteration compass still steers (the snapshot's `compass_ref`, whose
 * frontmatter `iteration_id` must equal the snapshot id and whose `status`
 * must be `active|locked` — D4: the FIRST-active-compass scan is gone, so a
 * session never borrows another lifecycle's iteration gate) AND the selected
 * snapshot carries ≥1 plan row in the `Todo` state (the Prepare window — a
 * plan registered, not yet started; the engine plan-status vocabulary,
 * `status.ts:117` — v3 relocation: the root v1 `plans[]` home is gone, the
 * probe reads `workflows/<id>/snapshot.json` rows). Otherwise the target
 * is OFF. A session with NO selected lifecycle (unbound multi-active) has no
 * true target: the sync performs NO `set` rather than asserting `false` for
 * a lifecycle the session never selected.
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
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parseCompassFrontmatter, readJson, WORKFLOW_SNAPSHOT_FILE } from '@mstar-harness/engine'
import { asRecord, sessionHintOf, STATUS_FILE } from './_shared.ts'
import type { HarnessResolver } from './_shared.ts'
import { readWorkflowSessionBinding } from '../engine-status-store.ts'
// The shared root discriminator and the `subagent/start` root walk (explicit
// no-barrel imports — plan Task 4b; goal-bridge.ts does not import this
// module, so there is no cycle).
import { isRootLikeAgent, rootAgentOf } from './goal-bridge.ts'
// v3 relocation : the Todo probe
// reads the SELECTED workflow snapshot's plan rows — the root v1 `plans[]`
// home is gone. The bridge is a READ-only mirror, so the read resolver
// (active → terminal → error) applies.
import { resolveReadWorkflow } from './workflow-selection.ts'
// Type-only (erased at runtime): the carrying-session hint shape.
import type { SessionHint } from './workflow-selection.ts'

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

/** The SELECTED lifecycle's snapshot, or why there is none. */
type SelectedLifecycle =
  | {
      readonly kind: 'selected'
      /** The workflow id the snapshot belongs to (its registry/dir id — the compass attribution key). */
      readonly workflowId: string
      /** The parsed snapshot document (the Todo probe AND the `compass_ref` source). */
      readonly doc: Record<string, unknown>
    }
  /** No lifecycle is selected for this session (unbound multi-active) — the caller must NOT write a target. */
  | { readonly kind: 'unbound' }
  /** No harness document / a selection failure / an unreadable snapshot — plan mode is simply OFF. */
  | { readonly kind: 'none' }

/**
 * The lifecycle THIS session's plan mode mirrors: the read resolver's
 * selection (active → terminal history → error), plus the selected snapshot.
 * Missing status.json / a selection failure / an unreadable snapshot degrade
 * to `none` (advisory — the status gate already refuses invalid writes, and a
 * broken read must never force the flag on). `unbound` is the ONE state that
 * is not "off": the session has no selected lifecycle, so mirroring `false`
 * would flip plan mode on the strength of a workflow this session never
 * selected.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param hint - the root session's carrying hint (lease / cwd / durable pick).
 */
function selectedLifecycle(harnessDir: string, hint?: SessionHint): SelectedLifecycle {
  if (!existsSync(join(harnessDir, STATUS_FILE))) return { kind: 'none' }
  const selection = resolveReadWorkflow(harnessDir, hint)
  if (selection.kind === 'error') {
    return selection.code === 'workflow.selection.unbound-multi-active' ? { kind: 'unbound' } : { kind: 'none' }
  }
  let doc: Record<string, unknown>
  try {
    doc = readJson(join(harnessDir, selection.dir, WORKFLOW_SNAPSHOT_FILE)) as Record<string, unknown>
  } catch {
    return { kind: 'none' }
  }
  if (asRecord(doc) === undefined) return { kind: 'none' }
  return { kind: 'selected', workflowId: selection.workflowId, doc }
}

/**
 * Whether the SELECTED snapshot's own compass still steers: its `compass_ref`
 * (harness-relative) names a `delivery-compass.md` whose frontmatter
 * `iteration_id` equals the snapshot id and whose `status` is `active` or
 * `locked`. No directory enumeration — a session never borrows another
 * lifecycle's iteration gate, and a lifecycle whose compass has completed
 * stops steering.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param lifecycle - the selected lifecycle (its `compass_ref` is the only compass read).
 */
function selectedCompassSteers(
  harnessDir: string,
  lifecycle: { readonly workflowId: string; readonly doc: Record<string, unknown> },
): boolean {
  const ref = lifecycle.doc.compass_ref
  if (typeof ref !== 'string' || ref.trim() === '' || isAbsolute(ref)) return false
  const compassPath = join(harnessDir, ref)
  const inside = relative(harnessDir, compassPath)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return false
  if (!existsSync(compassPath)) return false
  let fields: Record<string, unknown>
  try {
    fields = parseCompassFrontmatter(compassPath)
  } catch {
    return false
  }
  if (fields.status !== 'active' && fields.status !== 'locked') return false
  return fields.iteration_id === lifecycle.workflowId
}

/**
 * Whether one already-parsed snapshot carries a Prepare window: ≥1 plan row
 * with `status: 'Todo'` (a plan registered, not yet started) — the engine
 * plan-status vocabulary. A missing `plans` array → `false`.
 * @param doc - the SELECTED lifecycle's snapshot document.
 */
function hasPrepareWindow(doc: Record<string, unknown>): boolean {
  const plans = doc.plans
  if (!Array.isArray(plans)) return false
  return plans.some((row) => asRecord(row)?.status === PLAN_STATUS_TODO)
}

/**
 * The planMode target for one harness + carrying session: `true` iff the
 * SELECTED lifecycle's own compass still steers (compass `status:
 * active|locked`, `iteration_id` matching the snapshot) AND the selected
 * snapshot carries a Prepare window (≥1 plan row `Todo`). Otherwise the
 * target is OFF.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param hint - the root session's carrying hint (lease / cwd / durable pick).
 * @returns `true`/`false` for a resolved selection, or `undefined` when this
 *   session has NO selected lifecycle (unbound multi-active / unreadable
 *   binding record) — the caller must leave plan mode alone rather than
 *   fabricate `false`, which would assert a state for a workflow the session
 *   never selected.
 */
export function planModeTarget(harnessDir: string, hint?: SessionHint): boolean | undefined {
  const lifecycle = selectedLifecycle(harnessDir, hint)
  if (lifecycle.kind === 'unbound') return undefined
  if (lifecycle.kind === 'none') return false
  if (!selectedCompassSteers(harnessDir, lifecycle)) return false
  return hasPrepareWindow(lifecycle.doc)
}

/* ---------------------------------- the sync ---------------------------------- */

/** Inputs of the sync: the structural planMode view and the per-workspace resolver. */
export interface PlanModeSyncInput {
  resolver: HarnessResolver
  /** The structural planMode view (`ctx.get('planMode')`); absent → the sync is inert. */
  planMode?: PlanModeServiceView
}

/**
 * The root session's carrying hint: the structural identity off the agent
 * (cwd + `header.id` + its opaque agent id as the lease holder) folded with
 * the session's DURABLE pick when the binding record is readable. An
 * unreadable record keeps the structural hint only — the pick is unknown,
 * never invented, so the resolver falls back to lease/cwd/unique evidence (or
 * reports unbound) instead of this bridge guessing.
 * @param agent - the root agent.
 * @param harnessDir - the resolved `{HARNESS_DIR}` for its workspace.
 */
function rootSessionHint(agent: unknown, harnessDir: string): SessionHint | undefined {
  const identity = sessionHintOf(agent)
  if (identity === undefined) return undefined
  const { cwd, sessionId } = identity
  if (cwd === undefined || sessionId === undefined) return identity
  const binding = readWorkflowSessionBinding(harnessDir, sessionId, cwd)
  if (binding.kind === 'unavailable') {
    log('warn', `planMode sync: session ${sessionId} binding store ${binding.reason} — selection falls back to lease/worktree evidence`)
    return identity
  }
  const selected = binding.binding?.selectedWorkflowId
  return selected === undefined ? identity : { ...identity, selectedWorkflowId: selected }
}

/**
 * Mirror the harness Prepare state into the planMode selection of ONE agent:
 * root-like agent (`header.parentSession === undefined`) → resolve the
 * workspace → compute {@link planModeTarget} from THAT root session's selected
 * lifecycle → `planMode.set(agent, target)`. The service's `'noop'` return
 * makes repeated evaluation at multiple decision points churn-free (no new
 * `plan/mode` event when already in target). Non-root agent / unresolvable
 * harness / missing planMode service / an UNBOUND session (no selected
 * lifecycle) → no set.
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
    const target = planModeTarget(harnessDir, rootSessionHint(agent, harnessDir))
    // Unbound: this session has no selected lifecycle, so there is no true
    // target to mirror — set neither `false` (which would assert an OFF state
    // for a lifecycle the session never selected) nor `true`.
    if (target === undefined) return false
    planMode.set(agent, target)
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
